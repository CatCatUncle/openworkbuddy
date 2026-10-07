// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 本机引擎借本项目的 generate_video 出片：上游收了单、片子还没收回来，这一趟就结束了的那几条，后台接着收。
 *
 * 为什么要有：上游收单之后要渲染好几分钟。这期间用户点了停止、CLI 自己的工具超时到了、
 * 或者整趟跑完 CLI 退出，桥（tool-bridge.js）就跟着走了——片子照样出、钱照样扣，却没人去取，
 * 只剩上游控制台知道这一单。
 *
 * 台账：桥在上游收单那一刻（media.js generateVideo 的 onSubmitted）落一个文件，
 *   <数据目录>/data/engine-pending/<任务号的哈希>.json；片子交到手里了，或者上游明说失败了，就删掉。
 *   里面只有任务号、协议、型号、渠道地址的哈希、文件名、对话目录、计价量——不写 Key，也不写地址本身。
 * 收货：主进程在 runViaEngine 收尾时（afterRun）接手这一趟留下的；服务启动时（sweep）接手上次没收完的。
 *   只按任务号去查，绝不重新下单。查法跟出片那一趟是同一份（media.videoTaskCheck）。
 *   同一单只收一次：先把台账文件改名占住（.claim-<进程号>），占不到就是别人在收。
 *   桥还活着就先等它：它可能自己还在等这一单（CLI 的工具超时到了，桥那头并没停）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { dataPath } = require("../platform/paths");
const appLog = require("../platform/log");

const DIR_NAME = "engine-pending";
/** 能去上游撤单的那两家（media.js cancelVideoTask）：停下时先撤，撤不掉的照样收 */
const CAN_CANCEL = new Set(["dashscope", "ark"]);
/** 从收单算起，等这么久还没出片就先放下（台账留着，下次启动再接着查） */
const WAIT_MS = 60 * 60 * 1000;
/** 从收单算起超过一天还没收回来：不再查，台账删掉，系统日志里留一笔 */
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** 桥进程还活着就不去抢；进程号被别人复用了也只等这么久 */
const BRIDGE_WAIT_MS = 20 * 60 * 1000;

let POLL_MS = 5000;
const busy = new Set();        // 这个进程里正在收的（按台账文件名）
const held = new Set();        // 这个进程里还有一单在等片子（交回主进程跑的，engines/tool-relay.js）：后台那一路先别占
const all = new AbortController(); // 测试收尾、服务关停时一把停掉

// 跟 org.js、brand-kit.js 一样认 OPENWORKBUDDY_DATA_DIR：数据目录挪了位置，台账跟着走
function pendingDir() { return path.join(process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data"), DIR_NAME); }

/** 渠道地址只记哈希：用来认回是哪条渠道，文件里不留地址本身（中转地址里常带着 Key）。跟出片那边收单回执里的是同一个算法 */
function chanKey(baseUrl) { return require("../tools/media").videoChanKey(baseUrl); }
function entryName(proto, taskId) {
  return crypto.createHash("sha1").update(`${proto}:${taskId}`).digest("hex").slice(0, 16) + ".json";
}

/**
 * 上游收单那一刻记一笔。先写临时文件再改名：写到一半进程没了，不会留下半个 JSON。
 * @returns {string} 台账文件的完整路径
 */
function writeEntry(dir, e) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, entryName(e.proto, e.taskId));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function dropEntry(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (e) { if (!e || e.code !== "ENOENT") appLog.warn("engine-harvest", "台账删不掉", { file, err: e }); }
}

/** 读一条台账。字段不齐的不认：缺任务号、协议、文件名、目录的，收回来也不知道放哪 */
function readEntry(file) {
  try {
    const e = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!e || typeof e !== "object" || !e.taskId || !e.proto || !e.fname || !e.saveDir) return null;
    return e;
  } catch { return null; }
}

/** 目录里没人占着的那几条。坏掉的、超过一天的顺手清掉，清之前系统日志里留一笔 */
function listEntries(dir = pendingDir()) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^[0-9a-f]{16}\.json$/.test(n)) continue;
    const file = path.join(dir, n);
    const entry = readEntry(file);
    if (!entry) {
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
      if (age > GIVE_UP_MS) { appLog.warn("engine-harvest", "台账读不出来，超过一天了，删掉", { file }); dropEntry(file); }
      continue;
    }
    out.push({ file, entry });
  }
  return out;
}

function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); }
}

/** 睡一会儿。定时器不拖住进程退出；停了当场醒 */
function nap(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve(undefined);
    const t = setTimeout(done, ms);
    if (t.unref) t.unref();
    function done() { clearTimeout(t); if (signal) signal.removeEventListener("abort", done); resolve(undefined); }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

/** 认回是哪条渠道：协议、型号、地址哈希三样都对上才算。设置里删了、改了地址，就认不回来 */
function findChannel(media, e) {
  const m = typeof media === "function" ? media() : media;
  const mediaModels = require("../core/model/media-models");
  const cands = [(m || {}).video, ...(((m || {}).list) || []).filter((c) => c && c.cap === "video")];
  return cands.find((c) => c && c.base_url && c.model === e.model && chanKey(c.base_url) === e.chan
    && mediaModels.videoProtoOf(c) === e.proto) || null;
}

/** 放进对话目录用的名字：同名文件是别人的就加 _2、_3；是这一单自己落了一半的（收单之后才有的）就覆盖 */
function freeName(dir, fname, since) {
  const ext = path.extname(fname);
  const stem = fname.slice(0, fname.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? fname : `${stem}_${i}${ext}`;
    let st = null;
    try { st = fs.statSync(path.join(dir, n)); } catch {}
    if (!st || (i === 1 && st.mtimeMs >= since)) return n;
  }
  return `${stem}_${Date.now()}${ext}`;
}

/**
 * 按任务号收一单：查到出好了就下载进对话目录。不重新下单。
 * @param {any} e 台账里那一条
 * @param {{media?: any, signal?: AbortSignal, now?: () => number}} [o] media：配好的媒体渠道，或者现取一份的函数
 * @returns {Promise<{ok?:boolean, file?:string, failed?:boolean, gaveUp?:boolean, why?:string}>}
 */
async function collect(e, { media, signal, now = Date.now } = {}) {
  const media0 = require("../tools/media");
  const cfg = findChannel(media, e);
  if (!cfg) return { gaveUp: true, why: "这条视频渠道在设置里找不到了（删了或改了地址）" };
  const saveDir = String(e.saveDir || "");
  let isDir = false;
  try { isDir = path.isAbsolute(saveDir) && fs.statSync(saveDir).isDirectory(); } catch {}
  if (!isDir) return { gaveUp: true, why: "对话目录不在了" };
  const fname0 = media0.safeOutName(path.basename(String(e.fname)), ".mp4", "video");
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${media0.mediaKey(cfg)}` };
  const askJson = (url, init, ms) => media0.within(signal, ms, (sig) => fetch(url, { ...init, signal: sig }).then((x) => x.json()));
  let got = null, lastErr = "";
  for (;;) {
    if (signal && signal.aborted) return { gaveUp: true, why: "停了" };
    try { got = await media0.videoTaskCheck(e.proto, base, auth, e.taskId, askJson); }
    catch (err) {
      if (err && err.taskFailed) return { failed: true, why: String(err.message || err).slice(0, 300) };
      lastErr = String((err && err.message) || err).slice(0, 200); // 查询断网、超时：下一轮再查
    }
    if (got) break;
    if (now() - (+e.at || 0) >= WAIT_MS) return { gaveUp: true, why: `等了一个小时还没出片${lastErr ? `（最后一次查询：${lastErr}）` : ""}` };
    await nap(POLL_MS, signal);
  }
  let url = got;
  if (e.proto === "minimax") {
    const mf = await media0.minimaxFileUrl(base, auth, got, askJson);
    url = mf.url;
    if (!url) return { gaveUp: true, why: `出好了，但取不到下载地址（file_id ${got}）` };
  }
  const fname = freeName(saveDir, fname0, +e.at || 0);
  await media0.downloadToWorkspace(url, fname, saveDir, signal);
  return { ok: true, file: path.join(saveDir, fname) };
}

/** 交到手里了，记一笔账：出片那一趟停下时预扣已经退了（withGenCache 的 undo），不记就成了白出 */
function bill(e, cfg, actor) {
  try {
    require("../core/billing/quota").record("video", {
      provider: String((cfg && cfg.provider) || "").slice(0, 40), model: e.model,
      units: +e.units > 0 ? +e.units : 1, meta: `后台收回 ${e.fname}`.slice(0, 80), ...(actor ? { actor } : {}),
    });
  } catch (err) { appLog.warn("engine-harvest", "收回的视频没记上账", { taskId: e.taskId, err }); }
}

/**
 * 交回主进程跑的那一单自己还在等片子：台账写的是本进程的 pid，take 里「桥还活着就先等」那道认不出它。
 * 占住到 release，后台 sweep、收尾那一路先等着，不重复收
 * @param {string} file @returns {() => void}
 */
function hold(file) { const k = path.basename(file); held.add(k); return () => { held.delete(k); }; }

/**
 * 占住一条接着收。桥还活着就先等它（它可能自己还在等这一单）；交回主进程跑的那一单还占着（hold）也等；占不到就是别人在收。
 * 结果一律进系统日志：后台吞掉的事，事后得查得到
 * @param {{file: string, entry: any}} x
 * @param {{media?: any, actor?: any, onDone?: (r: any, entry: any) => void}} [o]
 */
async function take({ file, entry }, { media, actor = null, onDone } = {}) {
  const key = path.basename(file);
  if (busy.has(key)) return;
  busy.add(key);
  const signal = all.signal;
  try {
    while (((entry.pid && entry.pid !== process.pid && alive(entry.pid)) || held.has(key)) && Date.now() - (+entry.at || 0) < BRIDGE_WAIT_MS) {
      await nap(POLL_MS, signal);
      if (signal.aborted) return;
    }
    const claim = `${file}.claim-${process.pid}`;
    try { fs.renameSync(file, claim); } catch { return; } // 桥自己收完删了，或者别人先占了
    const ctx = { taskId: entry.taskId, proto: entry.proto, model: entry.model, file: entry.fname };
    let r;
    try { r = await collect(entry, { media, signal }); }
    catch (err) { r = { gaveUp: true, why: String((err && err.message) || err).slice(0, 300) }; }
    if (r.ok) {
      dropEntry(claim);
      bill(entry, findChannel(media, entry), actor);
      appLog.info("engine-harvest", "上游收单的视频后台收回来了，放进了对话目录", { ...ctx, saved: r.file });
    } else if (r.failed) {
      dropEntry(claim);
      appLog.warn("engine-harvest", "上游说这单视频失败了，不再收", { ...ctx, why: r.why });
    } else if (Date.now() - (+entry.at || 0) >= GIVE_UP_MS) {
      dropEntry(claim);
      appLog.warn("engine-harvest", "收单超过一天还没收回来，不再查", { ...ctx, why: r.why });
    } else {
      // 先放下：台账改回原名，下次启动再接着查
      try { fs.renameSync(claim, file); } catch {}
      if (!signal.aborted) appLog.warn("engine-harvest", "这单视频这次没收回来，台账留着，下次启动再查", { ...ctx, why: r.why });
    }
    if (onDone) { try { onDone(r, entry); } catch {} }
  } finally {
    busy.delete(key);
  }
}

/**
 * runViaEngine 收尾时调：这一趟留下的台账，说一句、接着收。
 * 用户点了停止的：能撤单的那两家先去撤（排队中的撤得掉，已经在渲染的照样出片计费），撤不掉的照样收。
 * @param {{run?: string, media?: any, userStopped?: boolean, emit?: (ev: any) => void, actor?: any, dir?: string,
 *   onDone?: (r: any, entry: any) => void}} [o]
 * @returns {{count:number, ids:string[], jobs:Promise<any>[]}}
 */
function afterRun({ run, media, userStopped = false, emit, actor = null, dir = pendingDir(), onDone } = {}) {
  if (!run) return { count: 0, ids: [], jobs: [] };
  const mine = listEntries(dir).filter((x) => x.entry.run === run);
  if (!mine.length) return { count: 0, ids: [], jobs: [] };
  const ids = mine.map((x) => String(x.entry.taskId));
  const idText = ids.slice(0, 3).join("、") + (ids.length > 3 ? ` 等 ${ids.length} 个` : "");
  let cancelled = 0;
  // 撤单发出去（成没成都算）再开始收：头一次查单就能看到「已取消」，不白等一轮
  const sent = new Map();
  if (userStopped) {
    const { cancelVideoTask, mediaKey } = require("../tools/media");
    for (const x of mine) {
      const { entry } = x;
      if (!CAN_CANCEL.has(entry.proto)) continue;
      const cfg = findChannel(media, entry);
      if (!cfg) continue;
      sent.set(x, cancelVideoTask(entry.proto, String(cfg.base_url).trim().replace(/\/+$/, ""), { Authorization: `Bearer ${mediaKey(cfg)}` }, entry.taskId));
      cancelled++;
    }
  }
  const n = mine.length;
  const text = !userStopped
    ? `有 ${n} 条视频上游已经收单还没收回（任务号 ${idText}），后台接着等，出好了放进对话目录`
    : cancelled
      ? `停下时有 ${n} 条视频上游已经收单（任务号 ${idText}）：能撤的已去上游撤单，撤不掉的出好了放进对话目录`
      : `停下时有 ${n} 条视频上游已经收单（任务号 ${idText}），这家停不掉、照样扣费；出好了放进对话目录`;
  if (emit) { try { emit({ type: "status", notice: true, text, depth: 0 }); } catch {} }
  appLog.info("engine-harvest", "本机引擎这一趟留下了没收回的视频，后台接着收", { run, ids, userStopped, cancelled });
  const jobs = mine.map((x) => Promise.resolve(sent.get(x)).then(() => take(x, { media, actor, onDone })));
  return { count: n, ids, jobs };
}

/**
 * 服务启动时调：上次没收完的接着收。占着却没人收的（占的那个进程已经没了）先放回来
 * @param {{media?: any, dir?: string, onDone?: (r: any, entry: any) => void}} [o]
 */
function sweep({ media, dir = pendingDir(), onDone } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { count: 0, jobs: [] }; }
  for (const n of names) {
    const m = /^([0-9a-f]{16}\.json)\.claim-(\d+)$/.exec(n);
    if (!m || alive(+m[2])) continue;
    try { fs.renameSync(path.join(dir, n), path.join(dir, m[1])); } catch {}
  }
  const list = listEntries(dir);
  return { count: list.length, jobs: list.map((x) => take(x, { media, onDone })) };
}

let sweepArmed = false;
let sweepTimer = null;
/**
 * 开张后过一会儿再 sweep，不跟启动抢。只排一次：server 重载设置会再造一个运行时。定时器不拖住进程退出
 * @param {{media?: any, ms?: number}} [o]
 */
function sweepSoon({ media, ms = 30000 } = {}) {
  if (sweepArmed) return;
  sweepArmed = true;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    try { sweep({ media }); } catch (err) { appLog.warn("engine-harvest", "接着收上次没收完的视频时出错", { err }); }
  }, ms);
  if (sweepTimer.unref) sweepTimer.unref();
}

module.exports = {
  DIR_NAME, CAN_CANCEL, pendingDir, chanKey, entryName, writeEntry, dropEntry, readEntry, listEntries,
  findChannel, freeName, collect, afterRun, sweep, sweepSoon, hold,
  _internals: {
    setPollMs: (ms) => { POLL_MS = ms; }, stopAll: () => all.abort(), busy, held, take, WAIT_MS, GIVE_UP_MS, BRIDGE_WAIT_MS,
    // 测试用：排上了没有；还没到点的那次撤掉（免得半路插进来抢台账）
    sweepArmed: () => sweepArmed, cancelSweep: () => { if (sweepTimer) clearTimeout(sweepTimer); sweepTimer = null; },
  },
};
