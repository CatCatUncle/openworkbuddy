// @ts-check
"use strict";
/**
 * HTML 动画 → mp4：render_motion 的执行层。画幅、帧时间表、虚拟时钟这些纯逻辑都在 motion-clock.js，
 * 这里只管「开浏览器 → 一帧帧推时钟、截图 → 灌给 ffmpeg」。
 *
 * 两个后端，谁在就用谁：
 * - electron：桌面版里开一个离屏窗口，截图拿 BGRA 原始像素直接灌给 ffmpeg，最快；
 * - chrome：纯命令行 / 服务端没有 Electron，就拉一个用完就扔的无头 Chrome（cdp.spawnIsolated），
 *   每帧 Page.captureScreenshot 出 PNG。慢一截，但时钟和帧时间表是同一套，出来的画面一样。
 *
 * 为什么绝不发 Emulation.setVirtualTimePolicy：它只管定时器和 rAF，管不到 CSS 动画、视频、
 * Web Animations，headless=new 下还时灵时不灵；页面里注入的虚拟时钟（pageRuntime）已经把这些全接管了，
 * 两套时钟叠在一起只会互相打架。
 *
 * 成片先写 x.part.mp4，成功才改名；停止、出错、超时都杀掉 ffmpeg、删掉半截文件，
 * 不给用户留一个播不了的 mp4。同一时间只渲一条：离屏窗口 / Chrome 和 ffmpeg 都很吃内存和 CPU。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const childProcess = require("child_process");
const M = require("./motion-clock");
const cdp = require("./cdp");
const mediaProbe = require("./lib/media-probe");

// 翻页（导航到 load 事件）最多等多久：本地文件正常一两秒，再慢多半是页面引了连不上的外网资源
const LOAD_TIMEOUT_MS = 30000;
// 单帧 step 之外的其余调用（注脚本、读 meta、截图）的上限
const CALL_TIMEOUT_MS = 15000;
// 最后一帧写完之后 ffmpeg 收尾（编掉缓冲里的帧、挪 moov 到文件头）最多等多久
const FINISH_TIMEOUT_MS = 120000;
const NO_BROWSER = "出视频要内置浏览器或本机 Chrome，这台机器两样都没有：用桌面版跑，或者装个 Chrome（装在别处就把路径写进 OWB_CHROME_PATH）";

/**
 * 测试注入口：test/motion.js 拿假 DevTools 和假 ffmpeg 顶掉这几样，不用真开浏览器也能钉住命令顺序。
 * 调用处一律经 _internals 取，别在模块顶上解构，不然换不掉。
 */
const _internals = {
  spawnIsolated: cdp.spawnIsolated,
  newPage: cdp.newPage,
  connect: cdp.connect,
  closePage: cdp.closePage,
  findChrome: cdp.findChrome,
  spawn: childProcess.spawn,
  electronAvailable: () => require("./browser-render").available(),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 「用户点了停止」：带 stopped 标记，工具层据此回「已停止」而不是「出错了」 */
function stoppedError() {
  const e = /** @type {Error & { stopped?: boolean }} */ (new Error("用户已停止任务：视频没渲完，半截文件已删"));
  e.stopped = true;
  return e;
}

/**
 * 现在能不能出片、用哪个后端。同步：agent 拼工具清单时要当场判。
 * OWB_MOTION_BACKEND=chrome 强制走无头 Chrome（桌面版里也一样），测试和排查用。
 * @returns {{ ok: boolean, backend: "electron"|"chrome"|"", why: string }}
 */
function available() {
  const want = String(process.env.OWB_MOTION_BACKEND || "").trim().toLowerCase();
  let electron = false;
  if (want !== "chrome") { try { electron = !!_internals.electronAvailable(); } catch { electron = false; } }
  if (electron) return { ok: true, backend: "electron", why: "" };
  if (want === "electron") return { ok: false, backend: "", why: "OWB_MOTION_BACKEND=electron，但这里不是桌面版，没有内置浏览器" };
  let chrome = "";
  try { chrome = _internals.findChrome(); } catch { chrome = ""; }
  if (chrome) return { ok: true, backend: "chrome", why: "" };
  return { ok: false, backend: "", why: NO_BROWSER };
}

/** 同一个 ffmpeg 带没带 libx264，一个进程里只问一次 */
const x264Cache = new Map();

/**
 * 找 ffmpeg 并确认它能出 H.264。在开浏览器之前做：缺东西就一帧都不渲，别白跑几分钟最后才说没法编码。
 * 没有 libx264 时不偷偷换编码器（画质、兼容性都会变），如实说。
 * @param {string} [ffmpegBin] 调用方指定的 ffmpeg；不给就按 resolveMediaBins 找
 * @param {{ signal?: AbortSignal|null }} [o]
 * @returns {Promise<{ ok: boolean, bin: string, why: string }>}
 */
async function prepareFfmpeg(ffmpegBin, { signal = null } = {}) {
  let bin = String(ffmpegBin || "").trim(), install = "";
  if (!bin) {
    const r = await mediaProbe.resolveMediaBins();
    bin = (r && r.ffmpeg && r.ffmpeg.bin) || "";
    install = (r && r.install) || "";
  }
  if (!bin) return { ok: false, bin: "", why: M.noFfmpegMessage(install) };
  if (!x264Cache.has(bin)) {
    let text = "";
    try {
      const r = await mediaProbe.runBin(bin, M.encoderProbeArgs(), { timeout: 15000, signal: signal || undefined, what: "ffmpeg" });
      text = `${r.stdout}\n${r.stderr}`;
    } catch (e) {
      if (signal && signal.aborted) throw stoppedError();
      // 跑不起来不进缓存：可能是刚装到一半，下次再问
      return { ok: false, bin, why: `${e && e.message ? e.message : e}` };
    }
    x264Cache.set(bin, M.parseEncoders(text).has("libx264"));
  }
  if (!x264Cache.get(bin)) return { ok: false, bin, why: M.noX264Message(install) };
  return { ok: true, bin, why: "" };
}

/**
 * 等 p，同时盯着「停止」和超时，谁先到听谁的。超时只负责报错，卡住的页面由调用方整个关掉。
 * p 后来才失败也不会变成未处理的 rejection：then 的第二个参数一直挂着。
 * @template T
 * @param {Promise<T>|T} p
 * @param {{ signal?: AbortSignal|null, ms?: number, onTimeout?: () => Error }} o
 * @returns {Promise<T>}
 */
function guard(p, { signal = null, ms = 0, onTimeout = () => new Error("超时") }) {
  return new Promise((resolve, reject) => {
    /** @type {any} */
    let timer = null;
    const done = () => { if (timer) clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };
    const onAbort = () => { done(); reject(stoppedError()); };
    if (signal) {
      if (signal.aborted) { reject(stoppedError()); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (ms > 0) timer = setTimeout(() => { done(); reject(onTimeout()); }, ms);
    Promise.resolve(p).then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
  });
}

/** Runtime.evaluate 的回包：页面里抛了就把第一行话抛出来（去掉「Error: 」前缀），否则取值 */
function unwrapEval(r) {
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    const raw = (d.exception && (d.exception.description || d.exception.value)) || d.text || "页面脚本出错";
    throw new Error(String(raw).split("\n")[0].replace(/^(Uncaught )?(Error: )?/, ""));
  }
  return r && r.result ? r.result.value : undefined;
}

/**
 * 截到的一帧：buf 是灌给 ffmpeg 的字节（electron 是 BGRA，chrome 是 PNG），png() 只在要落静帧时才调。
 * @typedef {{ buf: Buffer, png: () => Buffer }} Shot
 * @typedef {{
 *   backend: "electron"|"chrome", format: "bgra"|"png",
 *   load: (url: string, ms: number) => Promise<void>,
 *   evaluate: (expr: string) => Promise<any>,
 *   capture: () => Promise<Shot>,
 *   hang: () => void,
 *   close: () => Promise<void>,
 * }} Driver
 */

/**
 * 桌面版：离屏窗口 + webContents.debugger。
 * - 设备像素比钉 1（offscreen.deviceScaleFactor），Retina 上也不出 2 倍图；万一还是不对，截完缩回 W×H；
 * - 分区不带 persist: 前缀 = 内存里的一次性会话：页面写的 localStorage 不会带到下一次渲染，两次才一样；
 * - 离屏帧率拉到 120：每帧要等两次真 rAF，帧率翻倍等待减半。
 * @param {{ width: number, height: number, runtime: string }} o
 * @returns {Promise<Driver>}
 */
async function electronDriver({ width, height, runtime }) {
  /** @type {any} */
  const electron = require("electron");
  const win = new electron.BrowserWindow({
    show: false, width, height, useContentSize: true, frame: false, enableLargerThanScreen: true,
    webPreferences: {
      offscreen: { deviceScaleFactor: 1 },
      sandbox: true, nodeIntegration: false, contextIsolation: true,
      backgroundThrottling: false,
      partition: `owb-motion-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  const wc = win.webContents;
  let gone = "";
  /** @type {Set<() => void>} */
  const goneWaiters = new Set();
  wc.on("render-process-gone", (_e, d) => {
    gone = `页面渲染进程崩了（${(d && d.reason) || "原因不明"}）：页面可能太吃内存，或者脚本把浏览器搞挂了`;
    for (const f of [...goneWaiters]) f();
  });
  /** 渲染进程崩了的话，手里正等着的调用永远不会回来：挂一个「崩了就拒」的出口 */
  const watch = (p) => new Promise((resolve, reject) => {
    if (gone) { reject(new Error(gone)); return; }
    const f = () => reject(new Error(gone));
    goneWaiters.add(f);
    Promise.resolve(p).then((v) => { goneWaiters.delete(f); resolve(v); }, (e) => { goneWaiters.delete(f); reject(gone ? new Error(gone) : e); });
  });
  const shut = () => {
    try { if (!win.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* 已经断了 */ }
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* 已经关了 */ }
  };
  try {
    wc.setAudioMuted(true);
    wc.setFrameRate(120);
    // 新窗口还没有渲染进程，这时发 debugger 命令会一直挂着不回（实测 Page.enable 永远等不到），先落一个空白页
    await watch(wc.loadURL("about:blank"));
    wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: runtime });
  } catch (e) {
    shut();
    throw e;
  }
  return {
    backend: "electron",
    format: "bgra",
    async load(url) { await watch(wc.loadURL(url)); },
    async evaluate(expr) {
      return unwrapEval(await watch(wc.debugger.sendCommand("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })));
    },
    async capture() {
      let img = await watch(wc.capturePage());
      const sz = img.getSize();
      if (sz.width !== width || sz.height !== height) img = img.resize({ width, height, quality: "best" });
      const buf = img.toBitmap();
      if (buf.length !== width * height * 4) {
        throw new Error(`截到的画面是 ${sz.width}×${sz.height}，要的是 ${width}×${height}，没法编码`);
      }
      return { buf, png: () => img.toPNG() };
    },
    // 页面死循环时渲染进程不回话，destroy 也要等它；先把它掐死
    hang() { try { if (!win.isDestroyed()) wc.forcefullyCrashRenderer(); } catch { /* 已经没了 */ } },
    async close() { shut(); },
  };
}

/**
 * 命令行 / 服务端：拉一个一次性的无头 Chrome，开一个标签页。
 * 顺序是钉死的：先注时钟脚本、再定视口，最后才导航——反过来的话页面脚本先跑，拿到的是真时间。
 * @param {{ width: number, height: number, runtime: string }} o
 * @returns {Promise<Driver>}
 */
async function chromeDriver({ width, height, runtime }) {
  const chrome = await _internals.spawnIsolated({
    prefix: "owb-motion-", extraArgs: [...M.CHROME_EXTRA_ARGS], windowSize: { w: width, h: height },
  });
  /** @type {any} */
  let client = null;
  let tabId = "";
  let lost = "";
  const shut = async () => {
    try { if (client) client.close(); } catch { /* 已经断了 */ }
    if (tabId) { try { await _internals.closePage(chrome.port, tabId); } catch { /* 浏览器已经没了 */ } }
    try { await chrome.kill(); } catch { /* 已经收走了 */ }
  };
  try {
    const tab = await _internals.newPage(chrome.port);
    tabId = tab.id;
    client = await _internals.connect(tab.webSocketDebuggerUrl, { idleMs: 0 });
    client.on("close", (p) => { lost = `无头 Chrome 中途断开了${p && p.reason ? `（${p.reason}）` : ""}`; });
    await client.call("Page.enable", {}, CALL_TIMEOUT_MS);
    await client.call("Page.addScriptToEvaluateOnNewDocument", { source: runtime }, CALL_TIMEOUT_MS);
    await client.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, CALL_TIMEOUT_MS);
  } catch (e) {
    await shut();
    throw e;
  }
  /** 连接断了的话，把 cdp 那句笼统的「连接已关闭」换成更具体的 */
  const call = async (method, params, ms = 0) => {
    try { return await client.call(method, params, ms); } catch (e) { throw lost ? new Error(lost) : e; }
  };
  return {
    backend: "chrome",
    format: "png",
    async load(url, ms) {
      // 旧文档上打个记号：新文档里没有它才算真翻过去了。Page.navigate 回来时新页面可能还没提交，
      // 这时读到的 readyState 还是上一页的 complete
      await call("Runtime.evaluate", { expression: "window.__owb_prev = 1", returnByValue: true }, CALL_TIMEOUT_MS);
      const nav = await call("Page.navigate", { url }, CALL_TIMEOUT_MS);
      if (nav && nav.errorText) throw new Error(`打不开页面：${nav.errorText}`);
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const r = await call("Runtime.evaluate", { expression: "window.__owb_prev ? 'old' : document.readyState", returnByValue: true }, CALL_TIMEOUT_MS);
        if (unwrapEval(r) === "complete") return;
        await sleep(40);
      }
      throw new Error(`页面 ${Math.round(ms / 1000)} 秒还没加载完`);
    },
    async evaluate(expr) {
      return unwrapEval(await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }));
    },
    async capture() {
      const r = await call("Page.captureScreenshot", { format: "png", fromSurface: true }, CALL_TIMEOUT_MS);
      const buf = Buffer.from(String((r && r.data) || ""), "base64");
      if (!buf.length) throw new Error("无头 Chrome 截回来的图是空的");
      return { buf, png: () => buf };
    },
    hang() { /* 关的时候整个 Chrome 连进程组一起杀，不用单独掐 */ },
    close: shut,
  };
}

/**
 * ffmpeg 编码进程：帧从 stdin 灌进去，stderr 只留最后 20 行当报错。
 * - 写满了就等 drain（背压），不然几千帧 8MB 的 BGRA 全堆在 Node 内存里；
 * - ffmpeg 中途死了（参数不对、磁盘满）写 stdin 会 EPIPE：一律换成「ffmpeg 中途退出：它最后说的话」。
 * @param {string} bin
 * @param {string[]} args
 */
function startEncoder(bin, args) {
  const child = _internals.spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  /** @type {string[]} */
  const tail = [];
  let partial = "";
  const keep = (line) => { if (line.trim()) { tail.push(line); if (tail.length > 20) tail.shift(); } };
  /** @type {{ code: number|null, signal: string|null }|null} */
  let exited = null;
  /** @type {Error|null} */
  let spawnErr = null;
  let stdinBroken = false;
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop() || "";
      lines.forEach(keep);
    });
  }
  /** @type {Promise<{ code: number|null, signal: string|null }>} */
  const exitP = new Promise((resolve) => {
    child.on("error", (e) => { spawnErr = e; if (!exited) exited = { code: null, signal: null }; resolve(exited); });
    child.on("close", (code, sig) => {
      if (partial) { keep(partial); partial = ""; }
      if (!exited || spawnErr) exited = { code, signal: sig };
      resolve(exited);
    });
  });
  // 不挂这个监听，EPIPE 会直接把整个进程带走
  child.stdin.on("error", () => { stdinBroken = true; });
  const tailText = () => mediaProbe.tailBytes(tail.join("\n"), 600) || (spawnErr ? spawnErr.message : "") || "它什么也没说";
  /** 死因要等 close 之后 stderr 才齐，最多等 2 秒 */
  const died = async () => {
    await Promise.race([exitP, sleep(2000)]);
    if (spawnErr) return new Error(`ffmpeg 跑不起来：${/** @type {Error} */ (spawnErr).message}`);
    return new Error(`ffmpeg 中途退出：${tailText()}`);
  };
  return {
    /** @param {Buffer} buf */
    async write(buf) {
      if (exited || stdinBroken) throw await died();
      const flowing = child.stdin.write(buf);
      if (!flowing) {
        await new Promise((resolve) => {
          const f = () => { child.stdin.off("drain", f); child.stdin.off("error", f); resolve(undefined); };
          child.stdin.on("drain", f);
          child.stdin.on("error", f);
          exitP.then(f);
        });
      }
      if (exited || stdinBroken) throw await died();
    },
    async finish() {
      if (!exited && !stdinBroken) child.stdin.end();
      const r = await exitP;
      if (spawnErr) throw new Error(`ffmpeg 跑不起来：${/** @type {Error} */ (spawnErr).message}`);
      if (r.code !== 0) throw new Error(`ffmpeg 出错了（${r.signal ? `被信号 ${r.signal} 结束` : `退出码 ${r.code}`}）：${tailText()}`);
    },
    /** 失败 / 停止时用：先杀，等它真退了再让调用方删 .part，免得删完它又写出一个来 */
    async kill() {
      if (!exited) { try { child.kill("SIGKILL"); } catch { /* 已经退了 */ } }
      await Promise.race([exitP, sleep(3000)]);
    },
  };
}

/** 给内联 HTML 补一个 <base>：写到临时目录后，里面的相对路径（图片、字体）照样指回原来那个目录 */
function withBase(html, dir) {
  if (!dir || /<base\s/i.test(html)) return html;
  const tag = `<base href="${pathToFileURL(dir).href.replace(/\/?$/, "/")}">`;
  const m = /<head[^>]*>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html;
}

/**
 * 统一成 [{ path, html, name, explicit }]。files 里每项可以是路径字符串，或 {path, html, duration, name}：
 * 给了 html 就渲这段内联 HTML（path 只当相对资源的基准目录），否则渲 path 指的文件。
 * @param {any} files
 */
function normShots(files) {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  if (!list.length) throw new Error("没给要渲的 HTML");
  return list.map((f, i) => {
    const o = typeof f === "string" ? { path: f } : f || {};
    const p = o.path ? path.resolve(String(o.path)) : "";
    const html = typeof o.html === "string" ? o.html : null;
    if (!p && html == null) throw new Error(`第 ${i + 1} 段既没给 path 也没给 html`);
    if (html == null && !fs.existsSync(p)) throw new Error(`找不到文件：${p}`);
    const d = o.duration == null || o.duration === "" ? null : Number(o.duration);
    return { path: p, html, name: String(o.name || (p ? path.basename(p) : `第 ${i + 1} 段`)), explicit: d, url: "" };
  });
}

/** 串行队列：上一条没渲完，下一条排着；排队的那条失败了也不能卡死后面的 */
let queue = Promise.resolve();

/**
 * 把一个或几个 HTML 渲成一条无声 mp4（多个就按顺序接起来，每段的时钟各自从 0 开始）。
 * @param {any} files [{ path, html?, duration?, name? }]
 * @param {{
 *   width?: number, height?: number, aspect?: string, fps?: number, seed?: number, epochMs?: number,
 *   out: string, ffmpegBin?: string, signal?: AbortSignal|null, deadline?: number,
 *   stills?: number, onProgress?: (p: any) => void,
 *   onFrame?: (f: { index: number, shot: number, time: number, hash: string, isNew: boolean, format: string, buf: Buffer, width: number, height: number }) => any,
 * }} opts
 *   deadline：绝对时间戳，到点前 10 秒收手（和 tools.js 的截止时间同一个算法）；
 *   stills：要落几张静帧（0..3，封面在前），PNG 字节放在结果的 stills 里，由调用方决定存哪。
 * @returns {Promise<{ file: string, frames: number, duration: number, segments: any[], warnings: string[],
 *   distinctFrames: number, width: number, height: number, fps: number, backend: string,
 *   stills: Array<{ frame: number, png: Buffer }>, metas: any[] }>}
 */
function renderMotion(files, opts) {
  const job = queue.then(() => doRender(files, opts || /** @type {any} */ ({})));
  queue = job.then(() => undefined, () => undefined);
  return job;
}

/** @param {any} files @param {any} opts */
async function doRender(files, opts) {
  const signal = opts.signal || null;
  if (signal && signal.aborted) throw stoppedError();
  if (!opts.out) throw new Error("renderMotion 要给 out（成片的完整路径）");
  const out = path.resolve(String(opts.out));
  const part = M.partPath(out);
  const shots = normShots(files);
  const { width, height } = M.resolveSize({ width: opts.width, height: opts.height, aspect: opts.aspect });
  const fps = M.clampFps(opts.fps);
  const stillsN = Math.max(0, Math.min(3, Math.floor(Number(opts.stills) || 0)));
  // 显式给了时长的先校验：超范围、总帧数超上限，一个浏览器都不用开就能报
  for (const s of shots) if (s.explicit != null) M.checkDuration(s.explicit, s.name);
  if (shots.every((s) => s.explicit != null)) M.planShots(shots.map((s) => Number(s.explicit)), fps);

  const av = available();
  if (!av.ok) throw new Error(av.why);
  const ff = await prepareFfmpeg(opts.ffmpegBin, { signal });
  if (!ff.ok) throw new Error(ff.why);

  const t0 = Date.now();
  const budget = M.budgetMs(opts.deadline, t0);
  const emit = M.progressThrottle(opts.onProgress);
  /** @type {string[]} */
  const tmpDirs = [];
  /** @type {Driver|null} */
  let driver = null;
  /** @type {ReturnType<typeof startEncoder>|null} */
  let enc = null;
  let ok = false;
  try {
    for (const s of shots) {
      if (s.html != null) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-motion-html-"));
        tmpDirs.push(dir);
        const f = path.join(dir, "index.html");
        fs.writeFileSync(f, withBase(s.html, s.path ? path.dirname(s.path) : ""));
        s.url = pathToFileURL(f).href;
      } else {
        s.url = pathToFileURL(s.path).href;
      }
    }
    const runtime = M.runtimeSource({ seed: opts.seed, epoch: opts.epochMs });
    const make = av.backend === "electron" ? electronDriver : chromeDriver;
    // 开浏览器这一下不接「停止」：半路撒手的话它开出来的窗口 / Chrome 就没人关了，等它开完再判
    driver = await make({ width, height, runtime });
    const drv = driver;
    if (signal && signal.aborted) throw stoppedError();

    /** @type {any[]} */
    const metas = shots.map(() => null);
    let readyAt = -1;
    /** 翻到第 i 段；withReady 时再等字体、图片落定（真时间，最多 8 秒）。返回页面的 meta */
    const load = async (i, withReady) => {
      const s = shots[i];
      emit(M.progressEvent({ stage: "load", shot: i + 1, shots: shots.length }));
      readyAt = -1;
      await guard(drv.load(s.url, LOAD_TIMEOUT_MS), {
        signal, ms: LOAD_TIMEOUT_MS + 5000,
        onTimeout: () => new Error(`${s.name} ${Math.round(LOAD_TIMEOUT_MS / 1000)} 秒还没加载完：页面里可能引了连不上的外网资源`),
      });
      if (withReady) {
        await guard(drv.evaluate(`__owb_ready(${M.READY_CAP_MS})`), {
          signal, ms: M.READY_CAP_MS + CALL_TIMEOUT_MS, onTimeout: () => new Error(`${s.name} 等字体和图片等到超时`),
        });
        readyAt = i;
      }
      return await guard(drv.evaluate("__owb_meta()"), {
        signal, ms: CALL_TIMEOUT_MS, onTimeout: () => new Error(`${s.name} 读不到页面信息：页面脚本可能卡住了`),
      });
    };

    // 时长或封面要看页面才知道时，先把各段过一遍（只等 load，不等字体）：总帧数、封面帧号都要在开编之前定下来
    const needProbe = shots.some((s) => s.explicit == null) || (stillsN > 0 && shots.length > 1);
    if (shots.length === 1) metas[0] = await load(0, true);
    else if (needProbe) for (let i = 0; i < shots.length; i++) metas[i] = await load(i, false);
    const durations = shots.map((s, i) => M.checkDuration(M.durationFrom({ explicit: s.explicit, meta: metas[i] }), s.name));
    const plan = M.planShots(durations, fps);
    const stillIdx = M.stillFrames({ stills: stillsN, totalFrames: plan.totalFrames, poster: M.posterFrame({ segments: plan.segments, metas, fps }) });

    fs.mkdirSync(path.dirname(out), { recursive: true });
    try { fs.rmSync(part, { force: true }); } catch { /* 上次残留的删不掉就让 ffmpeg -y 盖 */ }
    enc = startEncoder(ff.bin, M.ffmpegArgs({ input: drv.format, width, height, fps, out: part }));
    const encoder = enc;
    const stats = M.createFrameStats();
    const shotInfo = shots.map((s) => ({ name: s.name, meta: /** @type {any} */ (null), errors: /** @type {string[]} */ ([]), warnings: /** @type {string[]} */ ([]) }));
    /** @type {Map<number, Buffer>} */
    const stillPng = new Map();
    const budgetErr = () => new Error(`渲了 ${Math.round((Date.now() - t0) / 1000)} 秒还没完，超过这次调用的时限，先停了：把时长或帧率调低，或者拆成几次渲`);
    const tRender = Date.now();
    let done = 0;
    for (const seg of plan.segments) {
      const i = seg.index;
      if (readyAt !== i) metas[i] = await load(i, true);
      shotInfo[i].meta = metas[i];
      for (let k = 0; k < seg.frames; k++) {
        if (signal && signal.aborted) throw stoppedError();
        if (Date.now() - t0 > budget) throw budgetErr();
        const idx = seg.firstFrame + k;
        const t = (k * 1000) / fps;
        const r = await guard(drv.evaluate(M.stepExpr(t)), {
          signal, ms: M.STEP_TIMEOUT_MS, onTimeout: () => { drv.hang(); return new Error(M.stallMessage(idx)); },
        });
        if (r && Array.isArray(r.errors)) shotInfo[i].errors.push(...r.errors.map(String));
        if (r && Array.isArray(r.warnings)) shotInfo[i].warnings.push(...r.warnings.map(String));
        const shot = await guard(drv.capture(), { signal, ms: CALL_TIMEOUT_MS, onTimeout: () => new Error(`第 ${idx + 1} 帧截图卡住了`) });
        const { hash, isNew } = stats.add(shot.buf);
        await guard(encoder.write(shot.buf), { signal, ms: 0 });
        if (stillIdx.includes(idx)) stillPng.set(idx, shot.png());
        if (typeof opts.onFrame === "function") {
          await opts.onFrame({ index: idx, shot: i, time: t, hash, isNew, format: drv.format, buf: shot.buf, width, height });
        }
        done++;
        const speed = done / Math.max(0.001, (Date.now() - tRender) / 1000);
        emit(M.progressEvent({ stage: "render", done, total: plan.totalFrames, shot: i + 1, shots: shots.length, speed }));
      }
    }
    // 页面用完就关：ffmpeg 收尾的这几秒不必再攥着浏览器
    await drv.close().catch(() => undefined);
    driver = null;
    emit(M.progressEvent({ stage: "encode" }));
    await guard(encoder.finish(), { signal, ms: FINISH_TIMEOUT_MS, onTimeout: () => new Error("ffmpeg 收尾超过 2 分钟没完") });
    fs.renameSync(part, out);
    ok = true;
    emit(M.progressEvent({ stage: "encode", pct: 100 }), { final: true });
    const warnings = M.motionWarnings({ frames: stats.frames(), distinct: stats.count(), width, height, shots: shotInfo });
    return {
      file: out, frames: plan.totalFrames, duration: plan.duration, segments: plan.segments, warnings,
      distinctFrames: stats.count(), width, height, fps, backend: drv.backend,
      stills: stillIdx.filter((f) => stillPng.has(f)).map((f) => ({ frame: f, png: /** @type {Buffer} */ (stillPng.get(f)) })),
      metas,
    };
  } finally {
    if (!ok && enc) await enc.kill();
    if (driver) await driver.close().catch(() => undefined);
    if (!ok) { try { fs.rmSync(part, { force: true }); } catch { /* 删不掉也不遮住真正的错 */ } }
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录，系统会收 */ } }
  }
}

module.exports = { available, renderMotion, prepareFfmpeg, NO_BROWSER, _internals };
