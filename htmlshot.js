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
 */
const path = require("path");

/** 串行队列：离屏窗口同时开一堆会吃爆内存，批量出卡片时排队一张张来 */
let queue = Promise.resolve();

function renderHtmlToPng(htmlPath, opts = {}) {
  const job = queue.then(() => doRender(htmlPath, opts));
  // 排队失败也不能卡死后面的任务
  queue = job.catch(() => {});
  return job;
}

async function doRender(htmlPath, { width = 1242, height = 1656, fullPage = false, waitMs = 500 } = {}) {
  let electron = null;
  try { electron = require("electron"); } catch {}
  const { BrowserWindow, app } = electron || {};
  if (!BrowserWindow || !app || typeof app.isReady !== "function" || !app.isReady()) {
    throw new Error("HTML 截图需要桌面版环境：请用 npm run app 启动（纯 node 起的服务没有渲染器）");
  }
  width = Math.min(Math.max(Math.round(width) || 1242, 100), 4000);
  height = Math.min(Math.max(Math.round(height) || 1656, 100), 8000);
  const win = new BrowserWindow({
    show: false,
    width, height,
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
  try {
    await win.loadFile(path.resolve(htmlPath));
    // 等字体 / 图片落定。webfont 或大图多给点时间由调用方通过 waitMs 控制
    await new Promise((r) => setTimeout(r, Math.min(Math.max(waitMs, 0), 10000)));
    if (fullPage) {
      // 整页截图：量出实际内容高度，把窗口拉到那么高再截
      const h = await win.webContents.executeJavaScript(
        "Math.min(document.documentElement.scrollHeight, 8000)", true
      ).catch(() => height);
      if (h && h > height) {
        win.setContentSize(width, Math.round(h));
        await new Promise((r) => setTimeout(r, 300)); // 重排后再等一拍
      }
    }
    const image = await win.webContents.capturePage();
    const buf = image.toPNG();
    if (!buf || buf.length < 100) throw new Error("截图结果为空，页面可能没有渲染出来");
    return buf;
  } finally {
    try { win.destroy(); } catch {}
  }
}

// ── 没有 Electron 的时候：一次性无头 Chrome ─────────────────────────────────────
// 命令行和服务端也要出片头片尾卡（compose_video），不能一句「请用桌面版」就把整条成片卡死。
// 跟 htmlvideo.js 的 chrome 后端同一套：cdp.spawnIsolated 拉一个用完就扔的，截完连进程一起收走

/** 纯 node 里 require("electron") 拿到的是可执行文件路径（一个字符串），解构出来全是 undefined */
function electronReady() {
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

/** 桌面版走离屏窗口（老路子，一个字没动），别的地方走无头 Chrome。signal 只有 Chrome 那条认 */
function renderHtmlToPngAny(htmlPath, opts = {}) {
  const how = shotAvailable();
  if (how.backend === "electron") return renderHtmlToPng(htmlPath, opts);
  if (!how.ok) return Promise.reject(new Error(how.why));
  const job = queue.then(() => chromeShot(htmlPath, opts));
  queue = job.catch(() => {});
  return job;
}

function stoppedError() { const e = new Error("已停止"); e.stopped = true; return e; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const { CHROME_EXTRA_ARGS } = require("./motion-clock");
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

module.exports = { renderHtmlToPng, renderHtmlToPngAny, shotAvailable };
