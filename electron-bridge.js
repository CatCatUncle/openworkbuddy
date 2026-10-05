// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 服务进程 ↔ 桌面主进程 的桥（服务进程这一半）。
 *
 * 为什么要有：2026-09-29 审计实测，桌面版几个对话一起跑时主进程事件循环 p99 卡 68ms、
 * 最长 330ms——server.js 连同 agent 全跑在 Electron 主进程里，SSE 推流、工具调用、
 * JSON 大包解析跟窗口重绘、菜单、托盘抢同一条线程。用户原话「开几个对话整个应用连带
 * 电脑都卡」。修法是把服务端挪进 utilityProcess（独立子进程），主进程只管窗口。
 *
 * 挪过去之后 require("electron") 在子进程里只剩 net / systemPreferences（Electron 43
 * 实测），dialog、shell、clipboard、nativeImage、BrowserWindow、powerSaveBlocker 全没了。
 * 这些调用点一律改成「问主进程要」：call 等回信、notify 只管发。
 *
 * 三种模式（调用点只加 remote 那一支，另外两支保持原样）：
 * - inproc：就在 Electron 主进程里（老路子 / OWB_SERVER_PROCESS=inproc / 退回）
 * - remote：在主进程拉起的服务子进程里，能问主进程
 * - none  ：纯 node（npm start、容器、测试），没有桌面可问
 *
 * 每个 call 都带超时：主进程卡死或正在退出时，工具拿到的是一句写明「哪个操作、等了多久」
 * 的报错，而不是永远挂着。
 */

const DEFAULT_TIMEOUT_MS = 5000;

/** @returns {"inproc"|"remote"|"none"} */
function mode() {
  const p = /** @type {any} */ (process);
  if (p.type === "browser") return "inproc";
  if (process.env.OWB_BRIDGE === "1") {
    if (p.type === "utility") return "remote";
    // 测试用：纯 node 里 fork 出来的子进程借 IPC 通道冒充，协议一模一样
    if (process.env.OWB_BRIDGE_IPC === "1" && typeof process.send === "function") return "remote";
  }
  return "none";
}
const isRemote = () => mode() === "remote";

/** @type {{post:(m:any)=>void}|null} */
let transport = null;
let seq = 0;
/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:any)=>void, timer:any, op:string}>} */
const pending = new Map();
/** @type {Record<string, any>} */
let shared = parseState(process.env.OWB_BRIDGE_STATE);
/** @type {Set<(s:any)=>void>} */
const stateListeners = new Set();
/** @type {Set<(op:string, msg:any)=>void>} */
const ctlListeners = new Set();
let gone = false;

/** @param {string|undefined} s */
function parseState(s) {
  try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

function ensureTransport() {
  if (transport || gone) return transport;
  if (!isRemote()) return null;
  const p = /** @type {any} */ (process).parentPort;
  if (p) {
    transport = { post: (m) => p.postMessage(m) };
    p.on("message", (/** @type {any} */ e) => receive(e && e.data));
  } else if (typeof process.send === "function") {
    const send = process.send.bind(process);
    // 带回调：通道断了以后 process.send 不抛，而是往 process 上 emit 'error'——没人接就是整个进程崩掉
    transport = { post: (m) => { send(m, (/** @type {any} */ err) => { if (err) shellGone(); }); } };
    process.on("message", receive);
    process.on("disconnect", () => shellGone());
    // 测试里的 IPC 通道别把子进程吊着不退
    try { /** @type {any} */ (process).channel && /** @type {any} */ (process).channel.unref(); } catch {}
  }
  return transport;
}

/** @param {string} code @param {string} message */
function bridgeError(code, message) {
  const e = /** @type {Error & {code?:string}} */ (new Error(message));
  e.code = code;
  return e;
}

function shellGone() {
  gone = true;
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(bridgeError("SHELL_GONE", `和桌面主进程的连接断了（${p.op}）`));
  }
}

/** @param {any} msg */
function receive(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "ret") {
    const p = pending.get(msg.id);
    if (!p) return; // 超时之后才回来的，已经报过错了
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(deserializeError(msg.error, p.op));
  } else if (msg.t === "state" && msg.patch && typeof msg.patch === "object") {
    shared = { ...shared, ...msg.patch };
    for (const fn of stateListeners) { try { fn(shared); } catch {} }
  } else if (msg.t === "ctl" && typeof msg.op === "string") {
    for (const fn of ctlListeners) { try { fn(msg.op, msg); } catch {} }
  }
}

/**
 * 问主进程要一个结果。
 * @param {string} op
 * @param {any} [args]
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<any>}
 */
function call(op, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // 断过一次就不再往外发：主进程已经没了，发出去只会等满超时
  if (gone) return Promise.reject(bridgeError("SHELL_GONE", `和桌面主进程的连接断了（${op}）`));
  const t = ensureTransport();
  if (!t) return Promise.reject(bridgeError("NO_SHELL", `当前没有桌面主进程可用（${op}）`));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(bridgeError("SHELL_TIMEOUT", `桌面主进程 ${Math.round(timeoutMs / 100) / 10} 秒内没回应（${op}）`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    pending.set(id, { resolve, reject, timer, op });
    try { t.post({ t: "call", id, op, args: args === undefined ? null : args }); }
    catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(bridgeError("SHELL_GONE", `和桌面主进程的连接断了（${op}）：${(e && /** @type {any} */ (e).message) || e}`));
    }
  });
}

/**
 * 只通知、不等回信（宠物动作、快捷键、全屏这类「做了就行」的）。没有主进程时静默返回 false。
 * @param {string} op @param {any} [args]
 */
function notify(op, args) {
  const t = gone ? null : ensureTransport();
  if (!t) return false;
  try { t.post({ t: "note", op, args: args === undefined ? null : args }); return true; } catch { return false; }
}

/** 服务进程 → 主进程的生命周期消息（boot / listening / hello），不走 call/note */
function send(/** @type {any} */ msg) {
  const t = gone ? null : ensureTransport();
  if (!t) return false;
  try { t.post(msg); return true; } catch { return false; }
}

/** 主进程推过来的共享状态（窗口在不在、是不是全屏、能不能开隐藏窗口） */
function state() { return shared; }
/** @returns {Record<string, any>} */
function caps() { return (shared && shared.caps) || {}; }
/** @param {(s:any)=>void} fn */
function onState(fn) { ensureTransport(); stateListeners.add(fn); return () => stateListeners.delete(fn); }
/** @param {(op:string, msg:any)=>void} fn */
function onCtl(fn) { ensureTransport(); ctlListeners.add(fn); return () => ctlListeners.delete(fn); }

/**
 * 要拉起「当 node 用」的子进程时用哪个可执行文件。
 * utilityProcess 里的 process.execPath 是 Electron Helper，不是主程序——主进程把自己的
 * execPath 放在 OWB_NODE_EXEC 里递过来，配合 ELECTRON_RUN_AS_NODE 行为和以前一致。
 */
function nodeExec() {
  if (/** @type {any} */ (process).type === "utility" && process.env.OWB_NODE_EXEC) return process.env.OWB_NODE_EXEC;
  return process.execPath;
}

/**
 * 过了一道 IPC 的二进制：utilityProcess 的 postMessage 走结构化克隆，Buffer 到对面是 Uint8Array；
 * process.send 走 JSON，是 {type:"Buffer",data:[...]}。统一还原成 Buffer。
 * @param {any} v @returns {Buffer|null}
 */
function toBuf(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  if (v.type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data);
  return null;
}

/**
 * 截屏回来的是 BGRA 裸像素（nativeImage 过不了进程）。要 PNG 时在这边自己编：
 * 过滤类型 0 + deflate，CRC 用 thumb-png 那份。
 * @param {Buffer} buf @param {number} w @param {number} h
 */
function bgraToPng(buf, w, h) {
  const zlib = require("zlib");
  const { crc32 } = require("./src/util/thumb-png");
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = o + 1 + x * 4;
      raw[d] = buf[s + 2]; raw[d + 1] = buf[s + 1]; raw[d + 2] = buf[s]; raw[d + 3] = buf[s + 3];
    }
  }
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0, 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 3 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 主进程那边抛的错过 IPC 只留 message / code / 几个业务字段 @param {any} e */
function serializeError(e) {
  if (!e) return { message: "未知错误" };
  const out = { message: String(e.message || e) };
  for (const k of ["code", "bootProblem", "noRetry"]) if (e[k] !== undefined) /** @type {any} */ (out)[k] = e[k];
  return out;
}
/** @param {any} o @param {string} [op] */
function deserializeError(o, op) {
  const e = /** @type {any} */ (new Error((o && o.message) || `主进程报错（${op || "?"}）`));
  if (o) for (const k of ["code", "bootProblem", "noRetry"]) if (o[k] !== undefined) e[k] = o[k];
  return e;
}

/** 测试用：换一条传输、或者把状态恢复成刚启动的样子 @param {{post:(m:any)=>void}|null} t */
function _setTransport(t) { transport = t; gone = false; }

module.exports = {
  mode, isRemote, call, notify, send, state, caps, onState, onCtl, nodeExec, toBuf, bgraToPng,
  serializeError, deserializeError, DEFAULT_TIMEOUT_MS, _setTransport, _receive: receive,
};
