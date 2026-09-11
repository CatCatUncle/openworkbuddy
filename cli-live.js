"use strict";
/**
 * 终端里跑的活儿，怎么让网页和手机看见。
 *
 * `wb` 命令行是自己在进程里跑任务的（不经过服务端），所以以前终端一开，网页那边完全不知情：
 * 任务在跑看不见，想补一句话也插不进去，人走开了更不知道跑完没有。而「在手机上接管电脑里
 * 那个正在干活的 agent」恰恰是这个功能的全部意义。
 *
 * 这里用**一个目录**把两个进程接起来，不开端口、不加依赖、服务端没起也照样能写：
 *
 *   data/cli-live/<会话id>.json     这趟活儿是谁、在哪、什么时候开始的，外加一个心跳时间
 *   data/cli-live/<会话id>.ndjson   事件流，一行一个事件（跟网页那条 SSE 是同一种事件）
 *   data/cli-live/<会话id>.in       网页插进来的话，一行一条；命令行在两步之间读走
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
 *   3. **插话不许丢。** 读插话用游标往后读，不截断文件——截断和追加之间有缝，
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
    rows.push({
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
    });
  }
  rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return rows;
}

function drop(sid) {
  for (const ext of [".json", ".ndjson", ".in"]) {
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
const NOOP = {
  live: false,
  id: "",
  beat() {},
  event() {},
  interjections() { return []; },
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
  let lastBeat = Date.now();

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
    /** 网页插进来的话。读过的不再读，读到哪儿记在游标里 */
    interjections() {
      const file = fileOf(sid, ".in");
      let out = [];
      try {
        const size = fs.statSync(file).size;
        if (size <= inPos) return out;
        const fd = fs.openSync(file, "r");
        let buf = "";
        try {
          const b = Buffer.alloc(size - inPos);
          fs.readSync(fd, b, 0, b.length, inPos);
          buf = b.toString("utf8");
        } finally { try { fs.closeSync(fd); } catch {} }
        const lastNL = buf.lastIndexOf("\n");
        if (lastNL < 0) return out; // 只写了一半，等下一次
        const whole = buf.slice(0, lastNL + 1);
        inPos += Buffer.byteLength(whole, "utf8");
        for (const line of whole.split("\n")) {
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (j && j.text) out.push(String(j.text));
          } catch {}
        }
      } catch {}
      return out;
    },
    finish({ error = null, title = "" } = {}) {
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
  announce, list, read, interject, drop,
};
