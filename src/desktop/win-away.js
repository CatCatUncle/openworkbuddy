// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 窗口收起来（快捷键隐藏、最小化）就让 Chromium 给这一页降频，拿回来再恢复。
 *
 * 2026-09-28 实测：以前建窗口时写死 backgroundThrottling:false，窗口藏起来以后界面照样按 120Hz 在画——
 * 侧栏每个在跑的对话一盏呼吸灯、转圈一刻不停，没人看得见。更糟的是 document.hidden 永远是 false，
 * 「你不在时跑完了」的系统通知、审批通知一次都没弹出来过。
 *
 * 看得见的时候（包括被别的窗口挡住）照旧不降频：被挡住时 macOS 会把页面判成 hidden，
 * 你切回来那一下计时器、动画都要追帧，看着像卡。
 * 流式回报是 fetch 读流，不靠计时器，降频后照样一条条到，只有 setTimeout / setInterval 被压到一秒一次。
 * 藏太久之后那档「一分钟才醒一次」在 electron-main.js 开头用启动开关关掉了。
 *
 * 另外往页面 body 上挂一个 owb-away 类名，理由有两条：
 *   · 运行时把 backgroundThrottling 打开，Chromium 不会回头把已经藏起来的页面补判成 hidden
 *     （2026-09-28 实测：没亮过的窗口里开了它，visibilityState 还是 visible），document.hidden 靠不住；
 *   · index.html 按这个类名把无限循环的动画停住，不指望 Chromium 替我们停。
 * 前端 isAway() 三样一起看：document.hidden、有没有焦点、这个类名。
 */

/**
 * @param {import("electron").BrowserWindow} win
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {{ isAway: () => boolean }}
 */
function throttleWhenAway(win, opts = {}) {
  const log = opts.log || (() => {});
  const wc = win.webContents;
  let away = false;
  const paint = () => {
    // 页面在加载、在重载、或者根本没有 body：失败就算了，did-finish-load 那一下会补
    wc.executeJavaScript(`document.body && document.body.classList.toggle("owb-away", ${away ? "true" : "false"})`, false).catch(() => {});
  };
  /** @param {boolean} v */
  const set = (v) => {
    if (win.isDestroyed() || wc.isDestroyed()) return;
    if (away === v) return;
    away = v;
    try { wc.setBackgroundThrottling(v); } catch (e) { log(`降频开关没切过去：${(e && e.message) || e}`); }
    paint();
  };
  win.on("hide", () => set(true));
  win.on("minimize", () => set(true));
  // 最小化状态下被 show 一下（Windows 上任务栏预览会这样）不算回来；restore 时窗口还藏着也不算
  win.on("show", () => { if (!win.isMinimized()) set(false); });
  win.on("restore", () => { if (win.isVisible()) set(false); });
  // 藏着的时候页面重载了（界面崩了自动重载、开发时刷新）：新页面上没有这个类名，补上
  wc.on("did-finish-load", () => { if (away) paint(); });
  return { isAway: () => away };
}

module.exports = { throttleWhenAway };
