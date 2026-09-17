"use strict";
/**
 * 终端里跑的活儿，怎么让网页和手机看见。
 *
 * `openworkbuddy` 命令行是自己在进程里跑任务的（不经过服务端），所以以前终端一开，网页那边完全不知情：
 * 任务在跑看不见，想补一句话也插不进去，人走开了更不知道跑完没有。而「在手机上接管电脑里
 * 那个正在干活的 agent」恰恰是这个功能的全部意义。
 *
 * 这里用**一个目录**把两个进程接起来，不开端口、不加依赖、服务端没起也照样能写：
 *
 *   data/cli-live/<会话id>.json     这趟活儿是谁、在哪、什么时候开始的，外加一个心跳时间
 *   data/cli-live/<会话id>.ndjson   事件流，一行一个事件（跟网页那条 SSE 是同一种事件）
 *   data/cli-live/<会话id>.in       网页插进来的话，一行一条；命令行在两步之间读走
 *   data/cli-live/<会话id>.ask.json 此刻正卡在等回答的问题/审批（通常 0 或 1 条）
 *   data/cli-live/<会话id>.ans      网页那边给的回答，一行一条；命令行等着的时候在读
 *
 * 为什么不开个端口让网页直连命令行：命令行是随手起随手关的，端口要选、要防冲突、要鉴权，
 * 而这三件事在一台机器上本来就有现成答案——文件系统的权限就是答案。也因此这套只在
 * **同一台机器**上成立：手机连的是部署在那台机器上的网页端，网页端读的是同一个目录。
 *
 * 三条红线：
 *   1. **这层坏了不许影响任务本身。** 所有写盘都吞异常：磁盘满了、目录只读、被杀进程，
 *      顶多是网页上看不见这趟活儿，不能让终端里正在跑的任务因此挂掉。
 *   2. **死活看心跳，不只看 pid。** pid 会被系统回收给别的进程，只认 pid 会把陌生进程
 *      当成自己的任务显示在列表里。心跳 + pid 两个都得成立。
 *   3. **等人回答的那一刻，人可能不在电脑前。** agent 问一句话、或者一条危险命令要批准，
 *      这两件事在终端里都是「卡住不动直到超时」。超时对审批来说等于**拒绝**——
 *      人回来只看到「用户没批准」，而他从来没被问到过。所以问题和审批都得摆到这个目录里，
 *      手机上点一下就能答；终端和手机谁先答算谁的。
 *   4. **插话不许丢。** 读插话用游标往后读，不截断文件——截断和追加之间有缝，
 *      用户刚敲进去那句正好掉在缝里，而他看到的是「已发送」。
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");

const BEAT_MS = 10000; // 心跳间隔：命令行每隔这么久盖一次时间戳
const STALE_MS = 45000; // 超过这么久没心跳就算这趟活儿已经没了（留 4 倍余量给卡顿的机器）
const KEEP_MS = 10 * 60 * 1000; // 结束之后还留多久：人从手机上点进来还能看见「刚跑完」
const MAX_LOG = 16 * 1024 * 1024; // 单个事件流的上限，超了就停笔并留一行说明
const MAX_LINE = 8 * 1024; // 单个事件的上限，超了截断——一次贴进来 2MB 的日志不该把这个文件撑爆

const SAFE = /[^\w-]/g;
const enabled = () => String(process.env.OPENWORKBUDDY_CLI_LIVE || "1") !== "0";

function dir() {
  return dataPath("data", "cli-live");
}
function ensureDir() {
  try { fs.mkdirSync(dir(), { recursive: true }); return true; } catch { return false; }
}
function fileOf(sid, ext) {
  return path.join(dir(), String(sid).replace(SAFE, "_") + ext);
}

/**
 * 这个 pid 还在不在。
 * EPERM 是「在，但不是你的」——多用户机器上照样算活着；只有 ESRCH 才是真没了。
 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

function readMeta(sid) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(sid, ".json"), "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}

/** 一行元数据在「现在」这个时刻算不算还活着 */
function isLive(meta, now) {
  if (!meta || meta.endedAt) return false;
  const beat = Number(meta.beatAt || meta.startedAt || 0);
  return pidAlive(meta.pid) && now - beat < STALE_MS;
}

/**
 * 当前这台机器上，终端里正在跑（或刚跑完）的活儿。
 *
 * 顺手把过期的清掉：命令行被 kill -9 掉时没人替它收尾，不清的话这个目录会越攒越多，
 * 网页上也会一直挂着一条永远转圈的假任务。
 */
function list({ now = Date.now(), prune = true } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir()); } catch { return []; }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sid = name.slice(0, -5);
    const meta = readMeta(sid);
    if (!meta) { if (prune) drop(sid); continue; }
    const live = isLive(meta, now);
    // 已经结束、或者心跳断了：过了保留期就连文件一起收走
    if (!live) {
      const last = Number(meta.endedAt || meta.beatAt || meta.startedAt || 0);
      if (prune && now - last > KEEP_MS) { drop(sid); continue; }
    }
    rows.push(rowOf(sid, meta, now));
  }
  rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return rows;
}

/**
 * meta → 侧栏/接口要的那一行。list 和 get 共用这一份。
 * 抽出来纯粹是因为下面 get 要拼一模一样的行：两处各写一遍，
 * 早晚会有一边漏掉 died 或者 live 的判法，而那种偏差只会在「命令行被强杀」
 * 这种少见的路上露出来——最难查的那类。
 */
function rowOf(sid, meta, now) {
  const live = isLive(meta, now);
  return {
      id: sid,
      pid: Number(meta.pid) || 0,
      title: String(meta.title || ""),
      cwd: String(meta.cwd || ""),
      mode: String(meta.mode || ""),
      user: String(meta.user || ""),
      startedAt: Number(meta.startedAt || 0),
      beatAt: Number(meta.beatAt || 0),
      endedAt: Number(meta.endedAt || 0) || null,
      error: meta.error ? String(meta.error) : null,
      live,
      // 心跳早停了但没有收尾记录 = 命令行被强杀了。如实说，别显示成「跑完了」
      died: !live && !meta.endedAt,
  };
}

/**
 * 按 id 取一行。
 *
 * 原来全是 `list({ prune: false }).find(r => r.id === sid)`：为了拿一行，
 * 先 readdir 整个目录、再把**每一趟**终端任务的 meta 整个 parse 一遍。
 * 手机上看终端镜像那条流是 400ms 一拍、一拍还调两次——开着两个终端任务、
 * 两个人各看一眼，就是每秒十几次全目录扫描，纯粹烧在「找一个已知的 id」上。
 * 这里直接读那一个文件：O(1)，而且结果跟 list 出来的那一行逐字段一致（同一个 rowOf）。
 *
 * 不做清理（prune）：这是只读查询，替调用方删文件是另一回事，得由 list 那条路统一管。
 */
function get(sid, { now = Date.now() } = {}) {
  const id = String(sid || "");
  if (!id || /[\\/]/.test(id)) return null; // 别让 id 里的路径分隔符跑出目录
  const meta = readMeta(id);
  return meta ? rowOf(id, meta, now) : null;
}

function drop(sid) {
  for (const ext of [".json", ".ndjson", ".in", ".ask.json", ".ans"]) {
    try { fs.rmSync(fileOf(sid, ext), { force: true }); } catch {}
  }
}

/**
 * 读事件流。
 *
 * 两种问法：按行号问（页面第一次打开，「从第 N 个事件开始给我」，跟网页那条续流一个口径），
 * 按字节问（已经在跟了，「上次读到这儿，后面还有吗」）。回的都带上新的字节位置，
 * 跟的人拿着它接着问下一次就行。
 */
function read(sid, { fromLine = 0, fromByte = -1 } = {}) {
  let buf = "";
  const file = fileOf(sid, ".ndjson");
  try {
    if (fromByte >= 0) {
      const fd = fs.openSync(file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size < fromByte) return { events: [], pos: 0, reset: true }; // 文件被换掉了（新的一轮），让上层从头再来
        if (size === fromByte) return { events: [], pos: fromByte, reset: false };
        const b = Buffer.alloc(size - fromByte);
        fs.readSync(fd, b, 0, b.length, fromByte);
        buf = b.toString("utf8");
      } finally { try { fs.closeSync(fd); } catch {} }
    } else {
      buf = fs.readFileSync(file, "utf8");
    }
  } catch { return { events: [], pos: Math.max(0, fromByte), reset: false }; }

  // 最后一行可能只写了一半（命令行正在追加），留到下次再读
  const lastNL = buf.lastIndexOf("\n");
  const whole = lastNL < 0 ? "" : buf.slice(0, lastNL + 1);
  const base = fromByte >= 0 ? fromByte : 0;
  const pos = base + Buffer.byteLength(whole, "utf8");
  const events = [];
  for (const line of whole.split("\n")) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return { events: fromByte >= 0 ? events : events.slice(fromLine), pos, reset: false };
}

/** 网页那边插一句话进来。写不进去就如实返回 false，别让界面显示「已发送」 */
/**
 * 一行一个 JSON 的追加式文件，从 pos 读到末尾，只吃**整行**。
 *
 * 为什么不截断读过的部分：写的一方是 append，读的一方如果截断，两个动作之间有缝，
 * 用户刚敲进去那句正好掉在缝里——而他那边显示的是「已发送」。所以只往后挪游标。
 * 半行（最后一个 \n 之后的部分）原样留着，等下次连上后面的字节再读，
 * 否则并发写到一半的那条会被当成坏 JSON 丢掉。
 */
function readLines(file, pos, onPos) {
  const out = [];
  try {
    const size = fs.statSync(file).size;
    if (size <= pos) return out;
    const fd = fs.openSync(file, "r");
    let buf = "";
    try {
      const b = Buffer.alloc(size - pos);
      fs.readSync(fd, b, 0, b.length, pos);
      buf = b.toString("utf8");
    } finally { try { fs.closeSync(fd); } catch {} }
    const lastNL = buf.lastIndexOf("\n");
    if (lastNL < 0) return out; // 只写了一半，等下一次
    const whole = buf.slice(0, lastNL + 1);
    onPos(pos + Buffer.byteLength(whole, "utf8"));
    for (const line of whole.split("\n")) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  return out;
}

function interject(sid, text) {
  const s = String(text == null ? "" : text).trim();
  if (!s || !enabled()) return false;
  if (!ensureDir()) return false;
  try {
    fs.appendFileSync(fileOf(sid, ".in"), JSON.stringify({ at: Date.now(), text: s }) + "\n");
    return true;
  } catch { return false; }
}

/**
 * 命令行这边开一趟活儿。
 * 返回的把手上带心跳、写事件、读插话、收尾四件事；这层整个不可用时返回一个什么都不做的空把手，
 * 调用方不用到处写 if。
 */
/**
 * 这趟活儿此刻卡在等什么。手机上那一屏就是读它画出来的。
 *
 * 进程不活着就一律当没有：终端那边 Ctrl-C 了、或者机器睡过去了，.ask.json 还躺在盘上，
 * 照着画就是给用户一道点了不会有任何反应的题——比不显示更糟。
 */
function pending(sid) {
  if (!enabled()) return [];
  const meta = readMeta(sid);
  if (!meta || !isLive(meta, Date.now())) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(fileOf(sid, ".ask.json"), "utf8"));
    return Array.isArray(arr) ? arr.filter((x) => x && x.id) : [];
  } catch { return []; }
}

/**
 * 网页/手机那边答了一句。写进去就完事，不等终端确认——
 * 终端可能正忙在别的步骤上，几百毫秒后才轮到读这个文件。
 *
 * 不在这儿把 .ask.json 里那条撤掉：撤是终端读到之后自己做的事。
 * 这边抢着撤，万一终端那次没读到（超时先到了），手机上题没了、人也没答成。
 *
 * value 两种形态：选择题给一句话，审批给 {allow, scope}。都摊平成同一个对象存，
 * 等着的那头按字段取。**不能一律 String(value)**——审批那条会变成 "[object Object]"，
 * 于是「点了允许」在终端里读出来是一句认不出的话，按没答处理，最后按超时拒绝收场。
 */
function answer(sid, id, value) {
  if (!id || !enabled()) return false;
  if (!ensureDir()) return false;
  const body = value && typeof value === "object"
    ? { value: value.text == null ? "" : String(value.text), allow: !!value.allow, scope: String(value.scope || "once") }
    : { value: value == null ? "" : String(value) };
  try {
    fs.appendFileSync(fileOf(sid, ".ans"), JSON.stringify({ at: Date.now(), id: String(id), ...body }) + "\n");
    return true;
  } catch { return false; }
}

const NOOP = {
  live: false,
  id: "",
  beat() {},
  event() {},
  interjections() { return []; },
  pend() {},
  unpend() {},
  answers() { return []; },
  finish() {},
};

function announce({ id, title = "", cwd = "", mode = "", user = "" } = {}) {
  if (!enabled() || !id || !ensureDir()) return NOOP;
  const sid = String(id);
  const meta = {
    pid: process.pid,
    title: String(title).slice(0, 120),
    cwd: String(cwd),
    mode: String(mode),
    user: String(user),
    startedAt: Date.now(),
    beatAt: Date.now(),
    endedAt: 0,
  };
  const write = () => { try { fs.writeFileSync(fileOf(sid, ".json"), JSON.stringify(meta)); return true; } catch { return false; } };
  if (!write()) return NOOP;
  // 每一轮都从头写事件流：上一轮的内容已经落进会话记录了，留在这儿只会让跟流的人分不清新旧
  try { fs.writeFileSync(fileOf(sid, ".ndjson"), ""); } catch {}
  try { fs.rmSync(fileOf(sid, ".in"), { force: true }); } catch {}

  let bytes = 0;
  let capped = false;
  let inPos = 0; // 插话读到哪儿了——往后读，不截断，中间不会掉话
  let ansPos = 0; // 回答读到哪儿了，同上
  let waiting = []; // 此刻挂着等回答的问题/审批
  let lastBeat = Date.now();
  const writeWaiting = () => { try { fs.writeFileSync(fileOf(sid, ".ask.json"), JSON.stringify(waiting)); } catch {} };
  try { fs.writeFileSync(fileOf(sid, ".ask.json"), "[]"); } catch {}
  try { fs.rmSync(fileOf(sid, ".ans"), { force: true }); } catch {}

  const handle = {
    live: true,
    id: sid,
    /** 心跳。事件多的时候顺路就盖了，静默期（比如模型正在想）靠定时器 */
    beat() {
      const now = Date.now();
      if (now - lastBeat < BEAT_MS / 2) return;
      lastBeat = now;
      meta.beatAt = now;
      write();
    },
    event(ev) {
      if (!ev || typeof ev !== "object") return;
      handle.beat();
      if (capped) return;
      let line;
      try { line = JSON.stringify(ev); } catch { return; }
      if (line.length > MAX_LINE) {
        // 超长的多半是 tool_result 或者一大段文本，砍掉尾巴但保住结构，别整条丢
        const kind = String(ev.type || "event");
        line = JSON.stringify({ type: kind, id: ev.id, truncated: true, text: line.slice(0, MAX_LINE) + "…（太长，后面省略了）" });
      }
      try {
        fs.appendFileSync(fileOf(sid, ".ndjson"), line + "\n");
        bytes += Buffer.byteLength(line, "utf8") + 1;
        if (bytes > MAX_LOG) {
          capped = true;
          fs.appendFileSync(fileOf(sid, ".ndjson"), JSON.stringify({ type: "status", text: "这趟的实时日志太大了，后面的不再往这儿写——终端里照常跑、照常打印" }) + "\n");
        }
      } catch {}
    },
    /**
     * 摆一条「正在等你回答」出去。手机上那一屏就是读这个文件画出来的。
     * 心跳顺手盖一下：等回答这段时间一个事件都不出，不盖的话界面会把它判成「这进程死了」。
     */
    pend(item) {
      if (!item || !item.id) return;
      waiting = waiting.filter((x) => x.id !== item.id).concat([item]);
      writeWaiting();
      handle.beat();
    },
    /** 答完了（或者超时了）就撤下来，别让手机上留着一个点了没反应的按钮 */
    unpend(id) {
      const before = waiting.length;
      waiting = waiting.filter((x) => x.id !== String(id));
      if (waiting.length !== before) writeWaiting();
    },
    /** 网页/手机上给的回答。跟插话一样用游标往后读，不截断 */
    answers() {
      return readLines(fileOf(sid, ".ans"), ansPos, (n) => { ansPos = n; })
        .map((j) => (j && j.id ? j : null)).filter(Boolean);
    },
    /** 网页插进来的话。读过的不再读，读到哪儿记在游标里 */
    interjections() {
      return readLines(fileOf(sid, ".in"), inPos, (n) => { inPos = n; })
        .filter((j) => j && j.text).map((j) => String(j.text));
    },
    finish({ error = null, title = "" } = {}) {
      // 跑完了还留着待答清单，手机上就会一直挂着一道没人接的题
      waiting = [];
      writeWaiting();
      meta.endedAt = Date.now();
      meta.beatAt = meta.endedAt;
      if (error) meta.error = String(error).slice(0, 300);
      if (title) meta.title = String(title).slice(0, 120);
      write();
    },
  };
  return handle;
}

module.exports = {
  BEAT_MS, STALE_MS, KEEP_MS, MAX_LINE, MAX_LOG,
  dir, fileOf, pidAlive, isLive,
  announce, list, get, read, interject, drop, pending, answer,
};
