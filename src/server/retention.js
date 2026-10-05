// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 派生数据的保留规则：只清应用自己生成的东西，而且只清丢了能重建、或者本来就是冗余的那部分。
 *
 * 2026-09-28 量的一台用了一个月的机器：
 *
 *     data/sessions/*.bak        262 个 38M（正本才 41M），其中 5 个的正本早被删了
 *     data/compact-archive       482 个 30M，缩进排版，文件名里没有会话 id，只进不出
 *     data/thumbs                594 个 24M，一天多六十来张，改过、挪走的原图留下的缩略图没人认领
 *     data/runtime/codex         sessions 12M + cache 28M + shell_snapshots 800K，没人清
 *     data/im-sessions           每个会话一份孪生 .bak，还有一个正本早没了的
 *
 * 单看哪个都不大，可它们有个共同点：只进不出。用得越久越大，用户看不见，也没有按钮能清。
 *
 * 几条硬规矩，每条都有测试钉着（test/retention.js，每条规则都配一个长得像、却必须活下来的反向对照）：
 *   · 只认自己的文件名。每条规则都是一条精确的正则（sha1.png、<13 位毫秒>.json、rollout-…-<uuid>.jsonl），
 *     同一个目录里用户自己放进去的东西名字对不上，一个都碰不到。
 *   · 只删普通文件。lstat 看到软链接、目录一律跳过——codex 那边的 auth.json 就是一根指向 ~/.codex 的软链。
 *   · 拿不准就留。会话正本读不出来，它的 .bak 就是最后的退路，不删；旁边有 .corrupt 隔离件的，
 *     说明出过事，留给人看。
 *   · 不卡主线程。server.js 跑在 Electron 主进程里，整份会话 JSON 加起来 40M，一口气 parse 完
 *     界面要冻住几百毫秒。所以这里全是异步 IO，一个文件让一次事件循环。
 *   · dryRun 先数不删。测试先拿 dryRun 数一遍，对上了再真删。
 *
 * 明确不碰的：会话正本、记忆、资料库、工作区成果、工作区 .trash（「整理副本」挪进去的，
 * 界面上答应过「可随时恢复」，而里头的副本已经记不起原件在哪，没法证明它真是多余的）。
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DAY = 24 * 3600 * 1000;
const MB = 1024 * 1024;

/** 各条规则的默认尺子。改之前先看 test/retention.js 里对应那组对照 */
const RULES = {
  // 会话 .bak：只防「正本写到一半断电」。正本七天没再存过、而且此刻读得出来，这份 .bak 就没用了
  SESS_BAK_STALE_MS: 7 * DAY,
  // 正本没了的 .bak：删会话的老版本只删正本，留下的全是这种。给十分钟余量，别跟正在进行的删除 / 改名撞上
  ORPHAN_BAK_GRACE_MS: 10 * 60 * 1000,
  // data/ 顶层那几本账的孤儿 .bak（usage.json 拆成分片后留下的那种）：一个月没人要就是真没人要
  DATA_ORPHAN_BAK_MS: 30 * DAY,
  // 压缩归档是被压掉那段原文的唯一全文副本，所以放得宽：三个月、200MB
  ARCHIVE_MAX_AGE_MS: 90 * DAY,
  ARCHIVE_MAX_BYTES: 200 * MB,
  // 缩略图随时能重缩。命中时会把 mtime 摸新（一天最多一次，见 thumb.js），所以 mtime 就是「最后一次用到」
  THUMB_MAX_AGE_MS: 30 * DAY,
  THUMB_MAX_BYTES: 100 * MB,
  THUMB_PART_MS: DAY,
  // 资料库封面（lib-cover.js 出的 cover-*.png，以及渲染器明确报错留下的 cover-*.fail）单独一本账：
  // 一张 PDF / 视频封面要起一趟 qlmanage / ffmpeg，比普通缩略图贵得多，别让几千张图片缩略图把它挤掉；
  // 反过来封面也别吃掉缩略图的 100MB。同样命中就摸，一个月没用到的走人
  COVER_MAX_AGE_MS: 30 * DAY,
  COVER_MAX_BYTES: 100 * MB,
  // Codex 引擎：线程记录一个月没动、而且没有任何一条会话还记着它的 id，才清
  CODEX_ROLLOUT_MS: 30 * DAY,
  CODEX_SNAPSHOT_MS: 7 * DAY,
  CODEX_CACHE_MS: 30 * DAY,
};

const SESS_BAK_RE = /\.json\.bak$/;
// 压缩归档：老的叫 <毫秒>.json，新的叫 <会话 id>-<毫秒>.json（会话 id 走过 sessFile 同一道替换，只剩 \w 和 -）
const ARCHIVE_RE = /^(?:[\w-]+-)?\d{13}\.json$/;
// data/thumbs 里所有归我们管的名字：普通缩略图 <sha1>.png，资料库封面 cover-<sha1>.png / .fail
const THUMB_RE = /^(cover-)?[0-9a-f]{40}\.(png|fail)$/;
// 两本账各数各的：普通缩略图只认不带前缀的，封面只认 cover- 开头的
const PLAIN_THUMB_RE = /^[0-9a-f]{40}\.(png|fail)$/;
const COVER_RE = /^cover-[0-9a-f]{40}\.(png|fail)$/;
const THUMB_PART_RE = /^(cover-)?[0-9a-f]{40}\.png\.\d+\.\d+\.part$/;
const ROLLOUT_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** 让出一次事件循环：一次只干一个文件的活，界面的点击、SSE 照常插得进来 */
const yieldLoop = () => new Promise((r) => setImmediate(r));

/** @param {string} dir @returns {Promise<string[]>} */
async function ls(dir) {
  try { return (await fsp.readdir(dir)).sort(); } catch { return []; }
}
/** @param {string} p @returns {Promise<fs.Stats|null>} */
async function lst(p) {
  try { return await fsp.lstat(p); } catch { return null; }
}

/**
 * @typedef {{ removed: string[], bytes: number }} Tally
 * @returns {Tally}
 */
function tally() { return { removed: [], bytes: 0 }; }

/**
 * 删一个文件，dryRun 只记账。只删普通文件：软链接、目录、拿不到 stat 的一律不动。
 * 删之前再 lstat 一次比 inode + mtime：中间要是被人换过（比如刚好存了一次盘，.bak 换成了新的），就不删
 * @param {string} p @param {fs.Stats} st @param {Tally} out @param {boolean} dryRun
 */
async function drop(p, st, out, dryRun) {
  if (!st || !st.isFile()) return;
  if (!dryRun) {
    const again = await lst(p);
    if (!again || !again.isFile() || again.ino !== st.ino || again.mtimeMs !== st.mtimeMs) return;
    try { await fsp.unlink(p); } catch { return; }
  }
  out.removed.push(p);
  out.bytes += st.size;
}

/**
 * <x>.json.bak 的去留。两种情况删，其余一律留：
 *   ① 孤儿：<x>.json 已经不在了。readJson 在正本不存在时根本不看 .bak，所以它永远不会被用上——
 *      除了一种最糟的情况：同名的新正本第一次写盘就断电成了 0 字节，readJson 会拿这份旧 .bak 顶上，
 *      已经删掉的内容就这么「复活」了。旁边有 .corrupt 隔离件的不算，那是出过事的现场，留给人看。
 *   ② 过期：正本 staleMs 没再存过、比 .bak 新、而且此刻读得出来。.bak 只防正本写坏，
 *      正本好好的、又好几天没再写过，这份 .bak 就没有要防的东西了。下次存盘会自动再留一份。
 * @param {string} dir
 * @param {{ now?: number, staleMs?: number, orphanMs?: number, dryRun?: boolean }} [opt]
 *   staleMs 传 Infinity 就只清孤儿（data/ 顶层那几本账用这个）
 */
async function sweepBaks(dir, { now = Date.now(), staleMs = RULES.SESS_BAK_STALE_MS, orphanMs = RULES.ORPHAN_BAK_GRACE_MS, dryRun = false } = {}) {
  const out = tally();
  const names = await ls(dir);
  const has = new Set(names);
  for (const n of names) {
    if (!SESS_BAK_RE.test(n)) continue;
    await yieldLoop();
    const bak = path.join(dir, n);
    const bst = await lst(bak);
    if (!bst || !bst.isFile()) continue;
    const main = n.slice(0, -".bak".length);
    const age = now - bst.mtimeMs;
    if (!has.has(main)) {
      if (age < orphanMs) continue;
      if (names.some((x) => x.startsWith(main + ".corrupt"))) continue;
      const mst = await lst(path.join(dir, main));
      if (mst) continue; // 列目录之后才冒出来的正本：不是孤儿
      await drop(bak, bst, out, dryRun);
      continue;
    }
    if (!(age >= staleMs)) continue;
    const mst = await lst(path.join(dir, main));
    // 按正本的年龄算，不按 .bak 的：硬链接轮换出来的 .bak 带的是上一版的 mtime，
    // 看它会把「昨天刚存过、上一次存在八天前」的会话误判成闲置
    if (!mst || !mst.isFile() || !(mst.mtimeMs > bst.mtimeMs) || !(now - mst.mtimeMs >= staleMs)) continue;
    try {
      JSON.parse(await fsp.readFile(path.join(dir, main), "utf8"));
    } catch { continue; } // 正本读不出来：.bak 是最后的退路
    await drop(bak, bst, out, dryRun);
  }
  return out;
}

/**
 * 一个目录里名字对得上 match 的文件：先按年龄删，剩下的超了总量再从最久没动的那头删。
 * 名字对不上的一个都不看——不算进总量，更不会被删。
 * @param {string} dir
 * @param {{ match: RegExp, maxAgeMs?: number, maxBytes?: number, now?: number, dryRun?: boolean }} opt
 */
async function pruneDir(dir, { match, maxAgeMs = Infinity, maxBytes = Infinity, now = Date.now(), dryRun = false }) {
  const out = tally();
  /** @type {{ p: string, st: fs.Stats }[]} */
  const keep = [];
  let i = 0;
  for (const n of await ls(dir)) {
    if (!match.test(n)) continue;
    if (++i % 32 === 0) await yieldLoop(); // stat 本身在线程池里，这里只是别让回调一口气排满
    const p = path.join(dir, n);
    const st = await lst(p);
    if (!st || !st.isFile()) continue;
    if (now - st.mtimeMs > maxAgeMs) await drop(p, st, out, dryRun);
    else keep.push({ p, st });
  }
  let total = keep.reduce((s, k) => s + k.st.size, 0);
  if (total > maxBytes) {
    keep.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
    for (const k of keep) {
      if (total <= maxBytes) break;
      const before = out.bytes;
      await drop(k.p, k.st, out, dryRun);
      total -= out.bytes - before;
    }
  }
  return out;
}

/** @param {string} dir @param {object} [opt] */
function pruneArchive(dir, opt = {}) {
  return pruneDir(dir, { match: ARCHIVE_RE, maxAgeMs: RULES.ARCHIVE_MAX_AGE_MS, maxBytes: RULES.ARCHIVE_MAX_BYTES, ...opt });
}

/**
 * 缩略图：名字是 sha1(路径:mtime:体积:宽).png，原图一改、一挪，老的那张就再也没人认领。
 * 没人认领的不会再被「摸」，一个月后按年龄走掉；总量超 100MB 再从最久没用的那头删。
 * 写到一半崩掉的 .part（thumb-worker.js、lib-cover.js 都先写临时名再改名）放一天就清。
 * 资料库封面 cover-*.png / .fail 同一个目录、另一本账（COVER_MAX_BYTES），两边互不挤占。
 * @param {string} dir
 * @param {{ now?: number, dryRun?: boolean, maxAgeMs?: number, maxBytes?: number, coverMaxAgeMs?: number, coverMaxBytes?: number }} [opt]
 */
async function pruneThumbs(dir, opt = {}) {
  const { coverMaxAgeMs = RULES.COVER_MAX_AGE_MS, coverMaxBytes = RULES.COVER_MAX_BYTES, ...rest } = opt;
  const a = await pruneDir(dir, { match: PLAIN_THUMB_RE, maxAgeMs: RULES.THUMB_MAX_AGE_MS, maxBytes: RULES.THUMB_MAX_BYTES, ...rest });
  const c = await pruneDir(dir, { match: COVER_RE, maxAgeMs: coverMaxAgeMs, maxBytes: coverMaxBytes, now: opt.now, dryRun: opt.dryRun });
  const b = await pruneDir(dir, { match: THUMB_PART_RE, maxAgeMs: RULES.THUMB_PART_MS, now: opt.now, dryRun: opt.dryRun });
  return { removed: [...a.removed, ...c.removed, ...b.removed], bytes: a.bytes + c.bytes + b.bytes };
}

/**
 * 递归列出 dir 下的普通文件。软链接不跟、不列（codex 目录里有指向用户家目录的链）
 * @param {string} dir @param {number} depth
 * @returns {Promise<{ p: string, st: fs.Stats }[]>}
 */
async function walkFiles(dir, depth = 4) {
  /** @type {{ p: string, st: fs.Stats }[]} */
  const out = [];
  for (const n of await ls(dir)) {
    const p = path.join(dir, n);
    const st = await lst(p);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (depth > 0) out.push(...(await walkFiles(p, depth - 1))); }
    else if (st.isFile()) out.push({ p, st });
  }
  return out;
}

/**
 * 会话（网页 + IM）里提到过的所有 uuid。Codex 的线程 id 就是 rollout 文件名尾巴上那个 uuid，
 * OWB 把它记在 sess.engine_sessions 里，下一轮拿它 resume。按文本找而不是解析 JSON 找字段：
 * 多认几个（比如聊天正文里恰好贴过这个 id）只会让它多留一阵，少认一个就是把一条还要接着聊的线程删了。
 * @param {string[]} dirs
 */
async function referencedIds(dirs) {
  const ids = new Set();
  for (const d of dirs) {
    for (const n of await ls(d)) {
      if (!n.endsWith(".json")) continue;
      await yieldLoop();
      let text = "";
      try { text = await fsp.readFile(path.join(d, n), "utf8"); } catch { continue; }
      for (const m of text.match(UUID_RE) || []) ids.add(m.toLowerCase());
    }
  }
  return ids;
}

/**
 * Codex 引擎自己的家（data/runtime/codex）。只动三处，别的一概不碰：
 *   sessions/ archived_sessions/ 下的 rollout-*.jsonl —— 一个月没动、而且没有任何会话还记着它的 id；
 *   shell_snapshots/ —— 每一趟起 shell 前拍的环境快照，一周前的不会再有人用；
 *   cache/ —— 插件目录、应用清单这类，Codex 下次用到会自己重新拉。
 * 不碰：auth.json（软链到 ~/.codex，删了等于把用户在命令行里的登录一起登出）、plugins/、
 * 各个 .sqlite、config.toml。sqlite 里仍然记着被删的线程，Codex 会列出来但接不上——
 * 所以才只删「OWB 这边已经没人记得」的那些。
 * @param {string} home
 * @param {{ refDirs?: string[], now?: number, dryRun?: boolean }} [opt]
 */
async function pruneCodexHome(home, { refDirs = [], now = Date.now(), dryRun = false } = {}) {
  const out = tally();
  const hst = await lst(home);
  if (!hst || !hst.isDirectory()) return out;
  const old = [];
  for (const sub of ["sessions", "archived_sessions"]) {
    for (const f of await walkFiles(path.join(home, sub))) {
      const m = ROLLOUT_RE.exec(path.basename(f.p));
      if (m && now - f.st.mtimeMs > RULES.CODEX_ROLLOUT_MS) old.push({ ...f, id: m[1].toLowerCase() });
    }
  }
  if (old.length) {
    const refs = await referencedIds(refDirs);
    for (const f of old) if (!refs.has(f.id)) await drop(f.p, f.st, out, dryRun);
  }
  for (const f of await walkFiles(path.join(home, "shell_snapshots"), 0)) {
    if (now - f.st.mtimeMs > RULES.CODEX_SNAPSHOT_MS) await drop(f.p, f.st, out, dryRun);
  }
  for (const f of await walkFiles(path.join(home, "cache"))) {
    if (now - f.st.mtimeMs > RULES.CODEX_CACHE_MS) await drop(f.p, f.st, out, dryRun);
  }
  return out;
}

/**
 * 开机后在后台跑一遍全部规则。一条规则出错不拦下一条；有删东西才打一行日志。
 * @param {{ dataDir: string, dryRun?: boolean, now?: number, log?: (msg: string) => void }} opt
 */
async function sweepAll({ dataDir, dryRun = false, now = Date.now(), log = (m) => console.log(m) }) {
  const d = (...p) => path.join(dataDir, ...p);
  const jobs = [
    ["会话 .bak", () => sweepBaks(d("sessions"), { now, dryRun })],
    ["IM 会话 .bak", () => sweepBaks(d("im-sessions"), { now, dryRun })],
    ["账本孤儿 .bak", () => sweepBaks(dataDir, { now, dryRun, staleMs: Infinity, orphanMs: RULES.DATA_ORPHAN_BAK_MS })],
    ["压缩归档", () => pruneArchive(d("compact-archive"), { now, dryRun })],
    ["缩略图", () => pruneThumbs(d("thumbs"), { now, dryRun })],
    ["Codex 引擎", () => pruneCodexHome(d("runtime", "codex"), { refDirs: [d("sessions"), d("im-sessions")], now, dryRun })],
  ];
  /** @type {Record<string, Tally>} */
  const report = {};
  for (const [name, run] of /** @type {[string, () => Promise<Tally>][]} */ (jobs)) {
    try { report[name] = await run(); } catch (e) {
      log(`[清理] ${name} 这一项没跑完：${e && e.message}`);
    }
  }
  const hit = Object.entries(report).filter(([, r]) => r.removed.length);
  if (hit.length) {
    const mb = (b) => (b / MB).toFixed(1) + "MB";
    log(`[清理] ${dryRun ? "（只数不删）" : ""}` + hit.map(([k, r]) => `${k} ${r.removed.length} 个 ${mb(r.bytes)}`).join("，"));
  }
  return report;
}

module.exports = {
  sweepBaks, pruneDir, pruneArchive, pruneThumbs, pruneCodexHome, referencedIds, sweepAll,
  RULES, ARCHIVE_RE, THUMB_RE, COVER_RE, ROLLOUT_RE,
};
