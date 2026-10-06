// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * agent 打开网页用的隐藏窗口（check_page 验收本地网页 / web_fetch 渲染动态页）。
 *
 * 原来长在 tools.js 里。2026-09-29 服务端挪进独立的服务进程后，那边开不了 BrowserWindow，
 * 窗口只能由桌面主进程开——主进程又不能 require 整个 tools.js（会把 agent 那一大坨都拉进
 * UI 线程，挪出去就白挪了）。所以把「开窗口、读控制台、取正文」这几件纯窗口的事单拎出来：
 * 服务端在主进程里跑（inproc）时 tools.js 直接用；在服务进程里跑时，主进程的 bridge-main
 * 收到 page.check / page.render 再调这里。两条路用的是同一份代码，结果不会两样。
 */

/**
 * 隐藏窗口用完的收尾。要不要顺手退掉整个应用，只看主窗口还在不在。
 *
 * 老写法是「当前一个窗口都不剩就 app.quit()」。可我们刚刚亲手销毁了自己那个隐藏窗口，
 * 这个条件在「主窗口没开着」的任何时刻都成立——于是一个验收网页的工具会顺手把整个进程
 * 结束掉。桌面版正常开着主窗口时碰不到，但服务端跑在 Electron 里而没有主窗口的形态
 * （评测、脚本、自动化宿主）一验页面就自杀，而且是静默的：调用方只看到任务没了。
 * 真正要防的是「渲染期间用户把主窗口关了，window-all-closed 触发那会儿这个隐藏窗口还
 * 活着，于是没退成」，所以判据改成**主窗口曾经存在且已经没了**；从来就没有过主窗口 =
 * 有意的无头宿主，不许动它。
 */
// ---- agent 打开网页用的隐藏窗口：独立的内存分区、静音、低帧率 ----
// 2026-09-28 实测：renderPage/checkPage 原来用默认会话，跟应用界面是同一个 profile。agent 读过的
// youtube、小红书、抖音、头条、百度文库各自装了 Service Worker、预缓存了一堆脚本，
// Application Support/openworkbuddy/Service Worker 涨到 46M，界面自己一个都没用过，也没人会去清。
// 改成固定名字的内存分区（不带 persist: 前缀，退出就没，不碰界面那份）。不用每次一个新名字：
// Electron 按名字把会话留到退出，每抓一次网页就漏一个会话。最后一个窗口关掉时把 SW 和 CacheStorage
// 清一下，内存分区在一次开好几天的应用里也不能越攒越多。
// 静音：视频站打开就自动播，隐藏窗口里的声音会从用户音箱里冒出来。帧率压到 8：离屏窗口没人看，
// 默认 60 帧白白烧一个核（带动画的首页尤其明显）。
const WEB_PARTITION = "owb-web";
const hiddenWeb = { open: 0 };
function openHiddenWeb(electron) {
  const win = new electron.BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true, partition: WEB_PARTITION },
  });
  hiddenWeb.open++;
  try { win.webContents.setAudioMuted(true); } catch {}
  try { win.webContents.setFrameRate(8); } catch {}
  win.once("closed", () => {
    hiddenWeb.open--;
    if (hiddenWeb.open > 0) return;
    try {
      const p = electron.session.fromPartition(WEB_PARTITION).clearStorageData({ storages: ["serviceworkers", "cachestorage"] });
      if (p && p.catch) p.catch(() => {});
    } catch {}
  });
  return win;
}

function closeHiddenWindow(win, electron) {
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {}
  const main = global.__wbWin;
  if (main && main.isDestroyed() && !electron.BrowserWindow.getAllWindows().length) electron.app.quit();
}

/**
 * 页面自己打的日志才算数。Electron 会往每一个 file:// 页面注入它自己的
 * 「Insecure Content-Security-Policy」安全警告（sourceId = node:electron/…），
 * 真实数据里 check_page 的 8 次「控制台报错」有 7 次就是它——一张完全干净的
 * 页面也照报，模型于是掉头去改一张本来没病的页面。它是开发期提示，跟交付出去
 * 的 HTML 无关，必须在这一层滤掉。
 */
function isRuntimeNoise(sourceId, message) {
  return (
    /^(node:electron|devtools:|chrome-extension:)/.test(String(sourceId || "")) ||
    /Electron Security Warning/.test(String(message || ""))
  );
}

/**
 * console-message 有两套签名：Electron 36 起是单个事件对象（level 是
 * 'error'/'warning' 字符串），老的位置参数（level 0-3）虽然还在但已标 deprecated。
 * 两套都认——哪天上游把老参数删了，这里静默瞎掉比报错更糟：check_page 的
 * 主要价值就是抓控制台报错，抓不到却回「控制台没有报错」是假绿。
 */
function readConsoleEvent(args) {
  const ev = args[0] || {};
  const level = typeof ev.level === "string" ? ev.level
    : ["debug", "info", "warning", "error"][Number(args[1])] || "info";
  const message = typeof ev.message === "string" ? ev.message
    : typeof args[2] === "string" ? args[2] : "";
  const sourceId = ev.sourceId || (typeof args[4] === "string" ? args[4] : "");
  return { level, message, sourceId };
}

/** 控制台里 %c 是给样式用的，取出来只会让报错更难读 */
function cleanConsoleText(msg) {
  return String(msg).replace(/%c/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * check_page 的浏览器那一半：打开本地文件，收控制台报错/警告，量一下标题、正文字数、页面高。
 * 打不开就抛（调用方写「打开失败：…」）。
 * @returns {Promise<{info:{t:string,n:number,h:number}, errs:string[], warns:string[]}>}
 */
async function probePage(electron, file, { settleMs = 1200 } = {}) {
  const win = openHiddenWeb(electron);
  const errs = [], warns = [];
  try {
    // 控制台报错是白屏的头号原因，光看源码看不出来
    win.webContents.on("console-message", (...args) => {
      const { level, message, sourceId } = readConsoleEvent(args);
      if (level !== "error" && level !== "warning") return;
      if (isRuntimeNoise(sourceId, message)) return;
      (level === "error" ? errs : warns).push(cleanConsoleText(message));
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => errs.push(`资源加载失败 ${desc}（${String(url).slice(0, 80)}）`));
    await win.loadURL("file://" + file);
    await new Promise((r) => setTimeout(r, settleMs));
    const info = await win.webContents.executeJavaScript(
      "({ t: document.title || '', n: (document.body ? document.body.innerText : '').trim().length, h: document.body ? document.body.scrollHeight : 0 })"
    );
    return { info, errs: errs.slice(), warns: warns.slice() };
  } finally {
    closeHiddenWindow(win, electron);
  }
}

// ---- 渲染时拦本机/内网 ----
// 页面自己跳转（JS 改 location、302）、加载图片脚本 XHR，都会先过 webRequest。fetch_url 进门时判过的只是第一个地址，
// 页面后面要去哪儿它管不着；不在这儿拦，一张公网页面就能把隐藏窗口带去读本机服务、云元数据，再把正文交回给 AI。
// 一个分区只能挂一个 onBeforeRequest：几个窗口同时开着时按 webContents 的 id 各查各的规则，没登记的照常放。
// 只认字面地址和 localhost（这一层没有 DNS 结果）：域名解析到内网的拦不到，那一截在 net-guard 顶上写着。
const os = require("os");
const netAddr = require("../../util/net-addr");
/** @type {Map<number, any>} webContents.id → 规则（core/safety/net-guard.js renderRule 算的那份） */
const renderBlocks = new Map();
const hookedSessions = new WeakSet();
function hookBlocks(ses) {
  if (!ses || !ses.webRequest || hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  ses.webRequest.onBeforeRequest((d, cb) => {
    const rule = renderBlocks.get(d.webContentsId);
    cb(rule && blockedInRender(d.url, rule) ? { cancel: true } : {});
  });
}
/** 这个请求按规则该不该拦 @param {string} url @param {{allow?: string[], own?: number[], local?: boolean, bg?: number[]}} rule */
function blockedInRender(url, rule) {
  const selfIps = [];
  try { for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) selfIps.push(String(a.address).replace(/%.*$/, "")); } catch { /* 读不到就只认回环 */ }
  return !!netAddr.judgeLiteralUrl(url, { ...rule, selfIps });
}

/**
 * web_fetch 的渲染那一半：真打开一遍，等正文不再变长（或超时）再取。
 * block：本机/内网拦截规则（AI 工具这条路必带）；不带 = 内部调用，不拦。
 * @returns {Promise<{text:string, title:string}>}
 */
async function readRendered(electron, url, { waitMs = 2500, maxWaitMs = 12000, ua = "", block = null } = {}) {
  const win = openHiddenWeb(electron);
  const wcId = win.webContents.id;
  try {
    if (block) {
      hookBlocks(win.webContents.session);
      renderBlocks.set(wcId, block);
      if (blockedInRender(url, block)) throw new Error("这个地址是本机或内网，安全中心没放行");
    }
    if (ua) win.webContents.setUserAgent(ua);
    await win.loadURL(url);
    let text = "";
    const deadline = Date.now() + maxWaitMs;
    // 首屏挂上以后正文还在异步请求，等到内容不再变长（或超时）为止
    for (let last = -1; Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, waitMs));
      text = await win.webContents.executeJavaScript("document.body ? document.body.innerText : ''");
      if (text.length > 400 && text.length === last) break;
      last = text.length;
    }
    const title = await win.webContents.executeJavaScript("document.title || ''").catch(() => "");
    return { text: (text || "").replace(/\n{3,}/g, "\n\n").trim(), title: String(title || "").trim().slice(0, 80) };
  } finally {
    renderBlocks.delete(wcId);
    closeHiddenWindow(win, electron);
  }
}

module.exports = {
  WEB_PARTITION, hiddenWeb, openHiddenWeb, closeHiddenWindow, isRuntimeNoise, readConsoleEvent, cleanConsoleText,
  probePage, readRendered, blockedInRender,
};
