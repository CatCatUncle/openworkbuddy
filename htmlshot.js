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

module.exports = { renderHtmlToPng };
