// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * HTML → PNG：用 Electron 离屏窗口把本地 HTML 渲染成图片。
 *
 * 为什么要有：自媒体图文（小红书卡片、公众号头图、视频分镜卡）最顺手的生产方式是
 * 「模型写 HTML 排版 → 截成图」——HTML 是模型最擅长的排版语言，比让图像模型画带字
 * 的图靠谱得多（文字不糊、可精确控制）。server 本来就跑在 Electron 主进程里
 * （npm run app），白捡一个真浏览器渲染器，不用拖 puppeteer。
 *
 * 边界：纯 node 起服务（npm start）时没有 Electron，直接报人话错误让用户换桌面版跑。
 * 窗口是离屏的，不会闪出来打扰用户。
 *
 * 两条道（2026-09-29 资料库出网页封面时加的）：
 * - 任务道（缺省）：agent 的 html_to_image、成片的片头片尾卡。每张开一个窗口、截完就关，老样子。
 * - 封面道（lane:"cover"）：资料库给工作区里的 html 出封面。一个老账号就有 285 个 html，每张开关
 *   一个窗口就是 285 次渲染进程冷启动，所以复用同一个藏着的窗口，截完停画、落空白页，空闲 30 秒才关。
 *   页面是 AI 随手写的：外网脚本、跟踪像素、朗读、弹框、跳转、WebRTC 都可能有，一律就地拦掉。
 * 两条道共用一个工位（同一时刻只截一张），排着的任务道一律先于封面道：封面是锦上添花，
 * 不能让 agent 的出图等它。
 *
 * 每一步都有超时。原来 loadFile 没有超时、所有截图共用一条串行队列，一张页面卡在加载上，
 * 后面的截图连带 agent 的 html_to_image 全部挂死。现在到点就掐掉渲染进程、销毁窗口、放下一单。
 * 超时的错误码是 SHOT_TIMEOUT、话里带「超时」：资料库据此只记在内存里，不落 .fail。
 */
const fs = require("fs");
const path = require("path");

const COVER_PARTITION = "owb-cover"; // 不带 persist:：退出即没，页面写的 localStorage / 缓存一概不落盘
const COVER_TIMEOUT_MS = 5000;       // 封面每一步（开窗、加载、截图）最多等这么久
const TASK_LOAD_TIMEOUT_MS = 30000;  // 任务道的页面可能在等 webfont、大图，给得宽：跟 Chrome 那条一样 30 秒
const TASK_STEP_TIMEOUT_MS = 15000;
const COVER_IDLE_MS = 30000;
const COVER_MAX_WAIT_MS = 45000;     // 封面排了这么久还没轮到：前端早翻过去了，不截了
const SHOT_TIMEOUT = "SHOT_TIMEOUT";
const NO_RENDERER = "NO_RENDERER";

/** 离屏窗口同时开一堆会吃爆内存：一个工位，两条道，任务道先走 */
const lanes = { task: [], cover: [] };
let running = null;
const stats = { task: 0, cover: 0, coverWindows: 0, timeouts: 0, pngOff: 0, pngSync: 0 };

/**
 * @param {string} htmlPath
 * @param {{width?:number, height?:number, fullPage?:boolean, waitMs?:number,
 *   lane?:"task"|"cover", timeoutMs?:number, fileRoot?:string, signal?:AbortSignal}} [opts]
 *   timeoutMs：封面道是每一步的上限（缺省 5 秒），任务道是加载的上限（缺省 30 秒）。
 *   fileRoot：封面页面能读的本地文件范围，缺省是 html 所在的目录。
 * @returns {Promise<Buffer>}
 */
function renderHtmlToPng(htmlPath, opts = {}) {
  const lane = opts.lane === "cover" ? "cover" : "task";
  // 服务端在独立服务进程里（2026-09-29 起桌面版默认）：窗口归主进程开，这边只收 PNG
  if (require("../../../electron-bridge").isRemote()) return remoteShot(htmlPath, lane, opts);
  const electron = readyElectron();
  if (!electron) return Promise.reject(shotError(NO_RENDERER, "HTML 截图需要桌面版环境：请用 npm run app 启动（纯 node 起的服务没有渲染器）"));
  const o = normalize(opts, lane);
  return enqueue(lane, (ctl) => (lane === "cover" ? coverShot(electron, htmlPath, o, ctl) : taskShot(electron, htmlPath, o, ctl)), {
    signal: opts.signal, deadlineMs: deadlineOf(o, lane), maxWaitMs: lane === "cover" ? COVER_MAX_WAIT_MS : 0,
  });
}

/** 本进程里能开窗口的 electron，开不了就 null（纯 node 里 require 到的是个路径字符串） */
function readyElectron() {
  let electron = null;
  try { electron = require("electron"); } catch {}
  const { BrowserWindow, app } = electron || {};
  if (!BrowserWindow || !app || typeof app.isReady !== "function" || !app.isReady()) return null;
  return electron;
}

function normalize(opts, lane) {
  const num = (v, d) => (v == null ? d : Number(v));
  const cover = lane === "cover";
  const t = Number(opts.timeoutMs);
  return {
    width: Math.min(Math.max(Math.round(num(opts.width, 1242)) || 1242, 100), 4000),
    height: Math.min(Math.max(Math.round(num(opts.height, 1656)) || 1656, 100), 8000),
    fullPage: !!opts.fullPage,
    waitMs: Math.min(Math.max(num(opts.waitMs, 500) || 0, 0), 10000),
    timeoutMs: t > 0 ? Math.min(Math.max(t, 200), 120000) : (cover ? COVER_TIMEOUT_MS : TASK_LOAD_TIMEOUT_MS),
    fileRoot: cover && opts.fileRoot ? path.resolve(String(opts.fileRoot)) : "",
  };
}

/** 整单的兜底上限：每一步各自有超时，这条只防「哪一步没包到」——到点照样掐窗口、放下一单 */
function deadlineOf(o, lane) {
  const step = lane === "cover" ? o.timeoutMs : TASK_STEP_TIMEOUT_MS;
  return (lane === "cover" ? o.timeoutMs : 0) + o.timeoutMs + o.waitMs + 2 * step + 5000;
}

// ── 调度 ───────────────────────────────────────────────────────────────────────

function enqueue(lane, run, { signal = null, deadlineMs = 0, maxWaitMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(stoppedError()); return; }
    lanes[lane].push({ lane, run, resolve, reject, signal, deadlineMs, maxWaitMs, at: Date.now() });
    pump();
  });
}

function pump() {
  if (running) return;
  let job = null;
  while ((job = lanes.task.shift() || lanes.cover.shift())) {
    if (job.signal && job.signal.aborted) { job.reject(stoppedError()); continue; }
    if (job.maxWaitMs && Date.now() - job.at > job.maxWaitMs) {
      job.reject(shotError(SHOT_TIMEOUT, `排队超时：${sec(job.maxWaitMs)} 秒还没轮到`));
      continue;
    }
    break;
  }
  if (!job) return;
  const j = job;
  running = j;
  /** 叫停 / 到点：先把这一单手里的窗口掐掉，再放下一单。ctl.dead 之后它每一步回来都会自己停 */
  const ctl = {
    dead: /** @type {any} */ (null),
    kills: /** @type {Array<() => void>} */ ([]),
    onKill(fn) { if (ctl.dead) { try { fn(); } catch {} } else ctl.kills.push(fn); },
    check() { if (ctl.dead) throw ctl.dead; },
  };
  let settled = false;
  let timer = null;
  const finish = (fn, v) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (j.signal) j.signal.removeEventListener("abort", onAbort);
    running = null;
    fn(v);
    setImmediate(pump);
  };
  const cut = (err) => {
    if (settled) return;
    ctl.dead = err;
    for (const k of ctl.kills.splice(0)) { try { k(); } catch {} }
    finish(j.reject, err);
  };
  const onAbort = () => cut(stoppedError());
  if (j.signal) j.signal.addEventListener("abort", onAbort, { once: true });
  if (j.deadlineMs) {
    timer = setTimeout(() => { stats.timeouts++; cut(shotError(SHOT_TIMEOUT, `截图超时：${sec(j.deadlineMs)} 秒还没做完`)); }, j.deadlineMs);
  }
  Promise.resolve().then(() => j.run(ctl)).then((v) => finish(j.resolve, v), (e) => finish(j.reject, e));
}

/**
 * 等 p，最多 ms。到点抛 SHOT_TIMEOUT；窗口的渲染进程中途没了立刻抛；这一单被叫停了也立刻停。
 * @param {Promise<any>} p @param {number} ms @param {string} msg @param {any} [ctl] @param {any} [win]
 */
function within(p, ms, msg, ctl, win) {
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => { stats.timeouts++; reject(shotError(SHOT_TIMEOUT, msg)); }, ms);
  });
  const racers = [p, late];
  const gone = win && goneOf.get(win);
  if (gone) racers.push(gone);
  return Promise.race(racers).finally(() => clearTimeout(timer)).then((v) => { if (ctl) ctl.check(); return v; });
}

/** 每个窗口一个「渲染进程没了」的出口：手里正等着的调用可能永远不会回来 */
const goneOf = new WeakMap();
function watchGone(win) {
  const p = new Promise((_, reject) => {
    win.webContents.on("render-process-gone", (_e, d) => {
      reject(new Error(`页面的渲染进程退出了（${(d && d.reason) || "没给原因"}）`));
    });
  });
  p.catch(() => {});
  goneOf.set(win, p);
}

/** 加载 → 等 → （整页就量高度拉长）→ 截。两条道共用，差别只在每一步给多久 */
async function shoot(win, htmlPath, o, ctl, stepMs) {
  const wc = win.webContents;
  await within(wc.loadFile(path.resolve(htmlPath)), o.timeoutMs, `页面加载超时：${sec(o.timeoutMs)} 秒还没加载完`, ctl, win);
  // 等字体 / 图片落定。webfont 或大图多给点时间由调用方通过 waitMs 控制
  await sleep(o.waitMs);
  ctl.check();
  if (o.fullPage) {
    // 整页截图：量出实际内容高度，把窗口拉到那么高再截。量不出来就按原高度截；页面卡死了照样算超时
    const h = await within(wc.executeJavaScript("Math.min(document.documentElement.scrollHeight, 8000)", true),
      stepMs, `页面超时：${sec(stepMs)} 秒没回话（量整页高度时）`, ctl, win)
      .catch((e) => { if (e && (e.code === SHOT_TIMEOUT || e.stopped || ctl.dead)) throw e; return o.height; });
    if (h && h > o.height) {
      win.setContentSize(o.width, Math.round(h));
      await sleep(300); // 重排后再等一拍
      ctl.check();
    }
  }
  const image = await within(wc.capturePage(), stepMs, `截图超时：${sec(stepMs)} 秒没截回来`, ctl, win);
  const buf = await pngOf(image, stepMs, ctl);
  if (!buf || buf.length < 100) throw new Error("截图结果为空，页面可能没有渲染出来");
  return buf;
}

// ── 编码：界面线程上只拷一份像素，PNG 交给缩图线程编 ──────────────────────────────
// 2026-09-29 量过：capturePage 回来直接 toPNG 是同步的，1242×1656（2 倍屏 2484×3312）一张卡界面线程
// 255–271ms，整页 2484×16000 卡 1.28s，封面 2560×1600 也要 100–108ms，这期间窗口拖不动、几个对话的字一起停住。
// 改成这里只 toBitmap 拷一份（同一张 3ms 左右）交出去编，界面线程最长一口降到 12ms / 整页 30–46ms / 封面 2–6ms。
// 线程起不来、像素排布认不出来才退回 toPNG（stats.pngSync 记着）：图照样出，只是又占一下界面线程。

const enc = {
  worker: /** @type {any} */ (null), seq: 0, idle: /** @type {any} */ (null), idleMs: 30000,
  pending: /** @type {Map<number, {resolve: (b: Buffer) => void, reject: (e: any) => void}>} */ (new Map()),
  layout: /** @type {{order: string, premul: boolean} | null | undefined} */ (undefined),
  file: path.join(__dirname, "thumb-worker.js"),
};

/** @param {any} image capturePage 的结果 @param {number} ms @param {any} ctl */
async function pngOf(image, ms, ctl) {
  const raw = rawOf(image);
  if (raw) {
    try {
      const buf = await within(encodeOff(raw), ms, `截图超时：${sec(ms)} 秒没编完`, ctl);
      stats.pngOff++;
      return buf;
    } catch (e) {
      if (e && e.code === SHOT_TIMEOUT) dropEncoder();
      if (e && (e.stopped || ctl.dead)) throw e;
      // 线程出错、或者这一步编超了时：落到下面按老路编。图还在手上，照样出，不能因为换了编法反倒截不出来
    }
  }
  stats.pngSync++;
  return image.toPNG();
}

/** 拷出原始像素和真实像素尺寸（2 倍屏时 getSize 可能按点给），对不上就 null */
function rawOf(image) {
  const layout = pixelLayout();
  if (!layout) return null;
  // 线程那边超过这个像素数不接（光裸数据就 320 MB）：先看尺寸，别白拷一份几百 MB 的位图再退回来
  const { MAX_PIXELS } = require("../../util/thumb-png");
  const sz = image.getSize();
  if (!(sz.width * sz.height <= MAX_PIXELS)) return null;
  let px;
  try { px = image.toBitmap(); } catch { return null; }
  let w = sz.width, h = sz.height;
  if (w > 0 && h > 0 && px.length !== w * h * 4) {
    const f = Math.sqrt(px.length / (w * h * 4));
    w = Math.round(w * f); h = Math.round(h * f);
  }
  if (!(w > 0 && h > 0) || px.length !== w * h * 4 || w * h > MAX_PIXELS) return null;
  return { px, w, h, o: layout };
}

/**
 * toBitmap 的字节顺序、颜色乘没乘过透明度，文档说是平台定的：拿一张已知颜色的 2×1 图问一次。
 * 左边不透明 (200,100,50)，右边红色半透明：认不出来就 null，一律走 toPNG
 */
function pixelLayout() {
  if (enc.layout !== undefined) return enc.layout;
  enc.layout = null;
  try {
    const probe = require("../../util/thumb-png").encodeRaw(Uint8Array.from([200, 100, 50, 255, 255, 0, 0, 128]), 2, 1, { order: "rgba" });
    const b = require("electron").nativeImage.createFromBuffer(probe).toBitmap();
    const at = (v) => [0, 1, 2, 3].filter((i) => b[i] === v);
    const idx = [at(200), at(100), at(50), at(255)];
    if (b.length === 8 && idx.every((x) => x.length === 1)) {
      const order = ["", "", "", ""];
      "rgba".split("").forEach((c, k) => { order[idx[k][0]] = c; });
      const red = b[4 + idx[0][0]], alpha = b[4 + idx[3][0]];
      if (alpha === 128 && (red === 255 || Math.abs(red - 128) <= 1)) enc.layout = { order: order.join(""), premul: red !== 255 };
    }
  } catch {}
  return enc.layout;
}

/** @param {{px: Buffer, w: number, h: number, o: {order: string, premul: boolean}}} raw @returns {Promise<Buffer>} */
function encodeOff({ px, w, h, o }) {
  return new Promise((resolve, reject) => {
    let wk;
    try { wk = encoder(); } catch (e) { reject(e); return; }
    const id = ++enc.seq;
    enc.pending.set(id, { resolve, reject });
    clearTimeout(enc.idle);
    enc.idle = null;
    const msg = { kind: "raw", id, px, w, h, o };
    // 转交不复制：一张 2 倍屏整页的位图上百 MB，复制那一下又回到界面线程上
    const whole = px.byteOffset === 0 && px.buffer.byteLength === px.length;
    try { wk.postMessage(msg, whole ? [px.buffer] : []); } catch {
      try { wk.postMessage(msg); } catch (e) { enc.pending.delete(id); reject(e); }
    }
  });
}

function encoder() {
  if (enc.worker) return enc.worker;
  const { Worker } = require("worker_threads");
  const wk = new Worker(enc.file);
  wk.unref();
  const fail = (/** @type {any} */ err) => {
    if (enc.worker !== wk) return;
    enc.worker = null;
    for (const p of enc.pending.values()) p.reject(err);
    enc.pending.clear();
  };
  wk.on("message", (m) => {
    const p = m && enc.pending.get(m.id);
    if (!p) return;
    enc.pending.delete(m.id);
    if (m.ok && m.png) p.resolve(Buffer.from(m.png.buffer, m.png.byteOffset, m.png.byteLength));
    else p.reject(new Error("PNG 编码没出结果"));
    if (!enc.pending.size && enc.worker === wk) {
      enc.idle = setTimeout(dropEncoder, enc.idleMs);
      if (enc.idle.unref) enc.idle.unref();
    }
  });
  wk.on("error", fail);
  wk.on("exit", (code) => fail(new Error(`编码线程退出了（退出码 ${code}）`)));
  enc.worker = wk;
  return wk;
}

/** 空闲 30 秒、或者编码超时：线程收掉，手上还等着的一律按失败回去 */
function dropEncoder() {
  clearTimeout(enc.idle);
  enc.idle = null;
  const wk = enc.worker;
  if (!wk) return;
  enc.worker = null;
  for (const p of enc.pending.values()) p.reject(shotError(SHOT_TIMEOUT, "编码线程收掉了"));
  enc.pending.clear();
  wk.terminate().catch(() => {});
}

/** 任务道：每张一个新窗口，截完就关（老样子），只是每一步都有了超时 */
async function taskShot(electron, htmlPath, o, ctl) {
  const win = new electron.BrowserWindow({
    show: false,
    width: o.width, height: o.height,
    frame: false,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false, // 离屏窗口不能被节流，否则截图前页面根本没画完
    },
  });
  watchGone(win);
  let hung = false;
  ctl.onKill(() => { hung = true; dispose(electron, win, true); });
  try {
    win.webContents.setAudioMuted(true); // 页面自带 autoplay 的背景音乐：别从用户音箱里放出来
    const buf = await shoot(win, htmlPath, o, ctl, TASK_STEP_TIMEOUT_MS);
    stats.task++;
    return buf;
  } catch (e) {
    if (e && e.code === SHOT_TIMEOUT) hung = true;
    throw e;
  } finally {
    dispose(electron, win, hung);
  }
}

/**
 * 页面死循环时渲染进程不回话，destroy 也要等它：先掐死。
 * 只在这个渲染进程没跟别的页面合住时掐——默认会话里的 file:// 页面（桌面宠物就是）可能跟它共用一个进程。
 */
function dispose(electron, win, hung) {
  try {
    if (win.isDestroyed()) return;
    if (hung && soleTenant(electron, win.webContents)) win.webContents.forcefullyCrashRenderer();
  } catch {}
  try { if (!win.isDestroyed()) win.destroy(); } catch {}
}

function soleTenant(electron, wc) {
  try {
    const pid = wc.getOSProcessId();
    if (!pid) return false;
    return !electron.webContents.getAllWebContents().some((x) => x !== wc && !x.isDestroyed() && x.getOSProcessId() === pid);
  } catch { return false; }
}

// ── 封面道：一个复用的藏着的窗口 ─────────────────────────────────────────────────

const cover = { win: /** @type {any} */ (null), idleTimer: /** @type {any} */ (null), idleMs: COVER_IDLE_MS, root: "" };
const guardedSessions = new WeakSet();

/**
 * 页面脚本之前先跑的一段（Page.addScriptToEvaluateOnNewDocument 注进主世界）。
 * 朗读已经用 disableBlinkFeatures 从窗口里整个拿掉了（iframe 里也没有：系统朗读不走页面的音频，
 * 静音拦不住，会直接从用户音箱里念出来）；这里补一个什么都不念、但会报「念完了」的替身，
 * 页面若在等 onend 才往下走，不至于卡住。弹框三件套、打印、开新窗、关窗换成空操作：
 * disableDialogs 已经让原生弹框不出来，window.close() 却真会把这个复用的窗口关掉。
 */
const PAGE_GUARD = `(() => {
  const put = (o, k, v) => { try { Object.defineProperty(o, k, { value: v, configurable: true, writable: true }); } catch (e) {} };
  const noop = () => {};
  put(window, "alert", noop);
  put(window, "confirm", () => false);
  put(window, "prompt", () => null);
  put(window, "print", noop);
  put(window, "open", () => null);
  put(window, "close", noop);
  const done = (u) => { setTimeout(() => { try { u && u.dispatchEvent && u.dispatchEvent(new Event("end")); } catch (e) {} }, 0); };
  if (window.speechSynthesis) {
    for (const k of ["cancel", "pause", "resume"]) put(window.speechSynthesis, k, noop);
    put(window.speechSynthesis, "speak", done);
    return;
  }
  class Utterance extends EventTarget {
    constructor(text) {
      super();
      Object.assign(this, { text: text == null ? "" : String(text), lang: "", voice: null, volume: 1, rate: 1, pitch: 1,
        onstart: null, onend: null, onerror: null, onpause: null, onresume: null, onmark: null, onboundary: null });
    }
    dispatchEvent(e) {
      const r = super.dispatchEvent(e);
      const h = this["on" + e.type];
      if (typeof h === "function") { try { h.call(this, e); } catch (x) {} }
      return r;
    }
  }
  const synth = Object.assign(new EventTarget(), { speaking: false, pending: false, paused: false, onvoiceschanged: null,
    speak: done, cancel: noop, pause: noop, resume: noop, getVoices: () => [] });
  put(window, "SpeechSynthesisUtterance", Utterance);
  put(window, "speechSynthesis", synth);
})();`;

/**
 * 封面分区只认本地：file:（限定在 root 里，按真实路径算，链接指出去的不算）、data:、blob:、about:。
 * 外网脚本、字体、跟踪像素、跳转、WebSocket 全拦在发出去之前。
 */
function coverUrlAllowed(url) {
  const u = String(url || "");
  if (/^(data|blob|about):/i.test(u)) return true;
  if (!/^file:/i.test(u) || !cover.root) return false;
  let p = "";
  try { p = require("url").fileURLToPath(u); } catch { return false; }
  return insideRoot(p, cover.root);
}

function realOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function insideRoot(p, root) {
  const rel = path.relative(root, realOr(p));
  return rel === "" || (rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel));
}

function guardSession(ses) {
  if (guardedSessions.has(ses)) return;
  guardedSessions.add(ses);
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !coverUrlAllowed(d.url) }));
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (e) => e.preventDefault());
}

async function coverWindow(electron, ctl) {
  clearIdle();
  if (cover.win && !cover.win.isDestroyed()) return cover.win;
  cover.win = null;
  guardSession(electron.session.fromPartition(COVER_PARTITION));
  const win = new electron.BrowserWindow({
    show: false, skipTaskbar: true, focusable: false, frame: false, useContentSize: true,
    width: 1280, height: 800,
    webPreferences: {
      offscreen: { deviceScaleFactor: 1 }, // 封面最后缩到 640 宽：按 2 倍屏截就是白白 4 倍像素
      sandbox: true, nodeIntegration: false, contextIsolation: true,
      backgroundThrottling: false, // 截图前要画完；截完靠 stopPainting 停，不靠节流
      partition: COVER_PARTITION,
      disableDialogs: true,
      disableBlinkFeatures: "ScriptedSpeechSynthesis",
      spellcheck: false,
      webviewTag: false,
    },
  });
  stats.coverWindows++;
  cover.win = win;
  watchGone(win);
  ctl.onKill(() => dropCover(electron, win, true));
  const wc = win.webContents;
  wc.setAudioMuted(true);
  // WebRTC 走 UDP，webRequest 看不见：UDP 只许走代理，而这个分区没有代理 = 一个包都出不去
  wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("will-prevent-unload", (e) => e.preventDefault()); // beforeunload 拦着不让走：照走
  wc.on("render-process-gone", () => dropCover(electron, win, false));
  // 替身是靠调试通道注进去的：通道断了，这个窗口就不能再拿来截陌生页面
  wc.debugger.on("detach", () => dropCover(electron, win, false));
  win.on("closed", () => { if (cover.win === win) cover.win = null; });
  // 新窗口还没有渲染进程，这时发 debugger 命令会一直挂着不回（htmlvideo 实测 Page.enable 永远等不到），先落一个空白页
  await within(wc.loadURL("about:blank"), COVER_TIMEOUT_MS, `封面窗口超时：空白页 ${sec(COVER_TIMEOUT_MS)} 秒没打开`, ctl, win);
  wc.debugger.attach("1.3");
  await within(wc.debugger.sendCommand("Page.enable"), COVER_TIMEOUT_MS, "封面窗口超时：调试通道没回话", ctl, win);
  await within(wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_GUARD }),
    COVER_TIMEOUT_MS, "封面窗口超时：调试通道没回话", ctl, win);
  return win;
}

async function coverShot(electron, htmlPath, o, ctl) {
  const win = await coverWindow(electron, ctl);
  let hung = false;
  ctl.onKill(() => dropCover(electron, win, true));
  try {
    cover.root = o.fileRoot ? realOr(o.fileRoot) : path.dirname(realOr(path.resolve(htmlPath)));
    win.setContentSize(o.width, o.height);
    win.webContents.startPainting();
    const buf = await shoot(win, htmlPath, o, ctl, o.timeoutMs);
    stats.cover++;
    await park(electron, win);
    return buf;
  } catch (e) {
    if (e && e.code === SHOT_TIMEOUT) hung = true;
    if (hung || ctl.dead || win.isDestroyed()) dropCover(electron, win, hung);
    else await park(electron, win); // 页面自己报错（文件不在之类）：窗口还是好的，照样收起来接着用
    throw e;
  } finally {
    cover.root = "";
  }
}

/**
 * 截完：先停画，再落空白页（页面里的动画、定时器、视频一起没了），然后才开始计空闲。
 * 截完的页面要是带 CSS 动画，开着 backgroundThrottling:false 的离屏窗口会一直 60 帧重画，多开对话时白吃 CPU。
 */
async function park(electron, win) {
  if (win.isDestroyed()) return;
  const wc = win.webContents;
  try { wc.stopPainting(); } catch {}
  try {
    await within(wc.loadURL("about:blank"), COVER_TIMEOUT_MS, `封面窗口超时：空白页 ${sec(COVER_TIMEOUT_MS)} 秒没打开`, null, win);
  } catch {
    dropCover(electron, win, true); // 页面 unload 里死循环之类：这个窗口不要了，下一单开新的
    return;
  }
  if (win.isDestroyed()) return;
  try { wc.stopPainting(); } catch {}
  clearIdle();
  cover.idleTimer = setTimeout(() => {
    cover.idleTimer = null;
    if (cover.win === win && !(running && running.lane === "cover")) closeCover(electron);
  }, cover.idleMs);
  if (cover.idleTimer.unref) cover.idleTimer.unref();
}

function clearIdle() {
  if (cover.idleTimer) { clearTimeout(cover.idleTimer); cover.idleTimer = null; }
}

function dropCover(electron, win, hung) {
  if (cover.win === win) { cover.win = null; clearIdle(); }
  dispose(electron, win, hung);
}

/** 空闲关窗：渲染进程一起走；分区在内存里，页面留下的 localStorage、缓存顺手清掉 */
function closeCover(electron = readyElectron()) {
  const win = cover.win;
  if (!win || !electron) return false;
  dropCover(electron, win, false);
  try {
    const p = electron.session.fromPartition(COVER_PARTITION).clearStorageData();
    if (p && p.catch) p.catch(() => {});
  } catch {}
  return true;
}

// ── 服务进程这一半：问主进程要 ────────────────────────────────────────────────────

/** 每条道各自串行地往外发：主进程那边按道排优先级，这边不能一口气把一堆单子全压过去等超时 */
const remoteTail = { task: Promise.resolve(), cover: Promise.resolve() };

function remoteShot(htmlPath, lane, opts) {
  const bridge = require("../../../electron-bridge");
  const { width = 1242, height = 1656, fullPage = false, waitMs = 500 } = opts;
  // 缺省的任务道原样只带这四个（test/electron-bridge.js 钉着）；封面道、自定超时才多带
  /** @type {Record<string, any>} */
  const sent = { width, height, fullPage, waitMs };
  if (lane === "cover") sent.lane = "cover";
  if (opts.timeoutMs) sent.timeoutMs = opts.timeoutMs;
  if (lane === "cover" && opts.fileRoot) sent.fileRoot = path.resolve(String(opts.fileRoot));
  const o = normalize(opts, lane);
  const signal = opts.signal || null;
  const job = remoteTail[lane].then(async () => {
    if (signal && signal.aborted) throw stoppedError();
    const call = bridge.call("shot.html", { htmlPath: path.resolve(htmlPath), opts: sent }, { timeoutMs: Math.max(60000, deadlineOf(o, lane) + 30000) });
    // 叫停只能停这边：主进程那一单有自己的超时，到点自己收
    const buf = bridge.toBuf(await (signal ? raceAbort(call, signal) : call));
    if (!buf || buf.length < 100) throw new Error("截图结果为空，页面可能没有渲染出来");
    return buf;
  });
  remoteTail[lane] = job.catch(() => {});
  return job;
}

function raceAbort(p, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(stoppedError());
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

// ── 没有 Electron 的时候：一次性无头 Chrome ─────────────────────────────────────
// 命令行和服务端也要出片头片尾卡（compose_video），不能一句「请用桌面版」就把整条成片卡死。
// 跟 htmlvideo.js 的 chrome 后端同一套：cdp.spawnIsolated 拉一个用完就扔的，截完连进程一起收走

/** 纯 node 里 require("electron") 拿到的是可执行文件路径（一个字符串），解构出来全是 undefined */
function electronReady() {
  const bridge = require("../../../electron-bridge");
  if (bridge.isRemote()) return !!bridge.caps().windows; // 服务进程里：主进程能开窗口就算
  try {
    const { BrowserWindow, app } = require("electron");
    return !!(BrowserWindow && app && typeof app.isReady === "function" && app.isReady());
  } catch { return false; }
}

/**
 * 这里能不能截 HTML、用哪个。OWB_MOTION_BACKEND=chrome 跟 htmlvideo 一样强制走 Chrome（测试和排查用）
 * @returns {{ok: boolean, backend: "electron"|"chrome"|"", why: string}}
 */
function shotAvailable() {
  if (process.env.OWB_MOTION_BACKEND !== "chrome" && electronReady()) return { ok: true, backend: "electron", why: "" };
  let chrome = "";
  try { chrome = require("./cdp").findChrome() || ""; } catch {}
  if (chrome) return { ok: true, backend: "chrome", why: "" };
  return { ok: false, backend: "", why: "HTML 截图要桌面版，或者本机装一个 Chrome（Chromium / Edge 也行）" };
}

/**
 * 网页封面只认 Electron（本进程或过桥）。Chrome 后端每截一张就起一个完整的 Chrome，
 * 285 个 html 就是 285 次冷启动——那种环境下资料库一律出图标卡。
 */
function coverAvailable() {
  return shotAvailable().backend === "electron";
}

/**
 * 桌面版走离屏窗口，别的地方走无头 Chrome。封面道（lane:"cover"）只在桌面版有，
 * 别处直接拒（NO_RENDERER），绝不为一张封面拉一个 Chrome。
 * @param {string} htmlPath @param {Parameters<typeof renderHtmlToPng>[1]} [opts]
 */
function renderHtmlToPngAny(htmlPath, opts = {}) {
  const how = shotAvailable();
  if (how.backend === "electron") return renderHtmlToPng(htmlPath, opts);
  if (opts.lane === "cover") return Promise.reject(shotError(NO_RENDERER, "网页封面只在桌面版里出：这里没有可复用的离屏窗口"));
  if (!how.ok) return Promise.reject(new Error(how.why));
  const o = normalize(opts, "task");
  return enqueue("task", (ctl) => {
    // 到点 / 叫停时连 Chrome 一起收：chromeShot 认 signal，卡在哪一条 CDP 调用上都会立刻回来
    const ac = new AbortController();
    ctl.onKill(() => ac.abort());
    return chromeShot(htmlPath, { ...opts, signal: ac.signal });
  }, { signal: opts.signal, deadlineMs: deadlineOf(o, "task") + 30000 }); // Chrome 冷启动另算 30 秒
}

function stoppedError() { const e = new Error("已停止"); e.stopped = true; return e; }
function shotError(code, message) { const e = new Error(message); e.code = code; return e; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sec = (ms) => Math.round(ms / 100) / 10;

/** Runtime.evaluate 的回包：页面里抛了就把那句话抛出来，否则取值（htmlvideo 里那个没导出，照抄一份） */
function unwrapEval(r) {
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(String((d.exception && (d.exception.description || d.exception.value)) || d.text || "页面脚本出错").split("\n")[0]);
  }
  return r && r.result ? r.result.value : undefined;
}

async function chromeShot(htmlPath, { width = 1242, height = 1656, fullPage = false, waitMs = 500, signal = null } = {}) {
  if (signal && signal.aborted) throw stoppedError();
  const cdp = require("./cdp");
  const { CHROME_EXTRA_ARGS } = require("../../util/motion-clock");
  width = Math.min(Math.max(Math.round(width) || 1242, 100), 4000);
  height = Math.min(Math.max(Math.round(height) || 1656, 100), 8000);
  const chrome = await cdp.spawnIsolated({ prefix: "owb-shot-", extraArgs: [...CHROME_EXTRA_ARGS], windowSize: { w: width, h: height } });
  let client = null, tabId = "";
  // 叫停就连 Chrome 一起杀：卡在哪一条 CDP 调用上都会因为连接断了立刻回来
  const onAbort = () => { Promise.resolve().then(() => chrome.kill()).catch(() => {}); };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const tab = await cdp.newPage(chrome.port);
    tabId = tab.id;
    client = await cdp.connect(tab.webSocketDebuggerUrl, { idleMs: 0 });
    const call = (method, params = {}) => client.call(method, params, 15000);
    const evalv = async (expression, awaitPromise = false) => unwrapEval(await call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }));
    await call("Page.enable");
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    // 旧文档上打个记号：新文档里没有它才算真翻过去了（Page.navigate 回来时读到的 readyState 可能还是 about:blank 的）
    await evalv("window.__owb_prev = 1");
    const nav = await call("Page.navigate", { url: require("url").pathToFileURL(path.resolve(htmlPath)).href });
    if (nav && nav.errorText) throw new Error(`打不开页面：${nav.errorText}`);
    for (const until = Date.now() + 30000; ;) {
      if ((await evalv("window.__owb_prev ? 'old' : document.readyState")) === "complete") break;
      if (Date.now() > until) throw new Error("页面 30 秒还没加载完");
      await sleep(40);
    }
    // 字体没落定就截，中文会是一闪而过的系统默认字体
    await evalv("document.fonts ? document.fonts.ready.then(() => 1) : 1", true).catch(() => {});
    await sleep(Math.min(Math.max(waitMs, 0), 10000));
    if (fullPage) {
      const h = Number(await evalv("Math.min(document.documentElement.scrollHeight, 8000)").catch(() => height)) || height;
      if (h > height) {
        await call("Emulation.setDeviceMetricsOverride", { width, height: Math.round(h), deviceScaleFactor: 1, mobile: false });
        await sleep(300);
      }
    }
    const r = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
    const buf = Buffer.from(String((r && r.data) || ""), "base64");
    if (buf.length < 100) throw new Error("截图结果为空，页面可能没有渲染出来");
    return buf;
  } catch (e) {
    if (signal && signal.aborted) throw stoppedError();
    throw e;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try { if (client) client.close(); } catch {}
    if (tabId && !(signal && signal.aborted)) { try { await cdp.closePage(chrome.port, tabId); } catch {} }
    try { await chrome.kill(); } catch {}
  }
}

/** 测试和排查用：调小空闲关窗、看工位状态、立刻关掉封面窗口 */
const _internals = {
  setCoverIdleMs(ms) { cover.idleMs = Math.max(0, Number(ms) || 0); },
  closeCover,
  state: () => ({
    running: running ? running.lane : "",
    queued: { task: lanes.task.length, cover: lanes.cover.length },
    coverOpen: !!(cover.win && !cover.win.isDestroyed()),
    idleArmed: !!cover.idleTimer,
    stats: { ...stats },
  }),
  coverUrlAllowed, PAGE_GUARD,
  pngOf,
  /** 编码线程：换线程文件（测试线程起不来）、调空闲时长、清掉认过的像素排布；native：回到老路 toPNG（量对照用） */
  setEncoder({ file, idleMs, relayout, native } = /** @type {{file?: string, idleMs?: number, relayout?: boolean, native?: boolean}} */ ({})) {
    if (file) { dropEncoder(); enc.file = file; }
    if (idleMs != null) enc.idleMs = Math.max(0, Number(idleMs) || 0);
    if (relayout) enc.layout = undefined;
    if (native) enc.layout = null;
  },
  encodeState: () => ({ worker: !!enc.worker, pending: enc.pending.size, idleArmed: !!enc.idle, layout: enc.layout }),
  dropEncoder,
};

module.exports = {
  renderHtmlToPng, renderHtmlToPngAny, shotAvailable, coverAvailable,
  SHOT_TIMEOUT, NO_RENDERER, COVER_PARTITION, _internals,
};
