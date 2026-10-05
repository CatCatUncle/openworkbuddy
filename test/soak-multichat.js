// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 五个对话一起连着跑：跑久了页面里的东西不许越攒越多。
 *
 * 跑法：
 *   node test/soak-multichat.js           CI 档，三段共 90 秒（外加漏 15 秒、起停），还没登记进 test/all.js
 *   node test/soak-multichat.js --local   本机档，默认 10 分钟
 *   OWB_SOAK_SECS=120 node test/soak-multichat.js --local   本机档压短，只验这套东西自己转得起来
 *
 * 为什么要有它：别的套件都是跑几十秒就收，慢慢涨的东西（DOM 节点、没清掉的 setTimeout / setInterval、
 * 按对话 id 记账的 Map、藏起来没关的窗口）一趟看不出来。2026-09-29 审计里用户原话「开几个对话整个应用
 * 连带电脑都卡」——服务端已经挪进独立进程（见 server-process.js），剩下的就是这几样有没有在慢慢涨。
 *
 * 真起 electron-main.js（OWB_SHELL_HIDDEN=1：窗口在屏幕外、show:false、不进 Dock、不弹框、不建托盘），
 * 服务端在它自己的独立进程里，假模型在本进程里（不联网、不花钱），临时家 + 随机端口。
 *   - 五个对话同时跑，每个 token 固定隔 16ms 推一次；每轮 3 次工具（写一页 HTML → 读回来 → 列目录）+ 收尾一段话，
 *     每 3 轮多一步 html_to_image 把这页截成 1242×1656 的图（桌面版截图走主进程）。
 *     每个对话的网页、截图路径固定（soak_<k>.html / soak_<k>_shot.png 每轮覆盖）：文件数不随轮数涨，
 *     资料库、列目录的结果才是稳的，涨了就是真涨。
 *   - 工作区「照片」里放 12 张 6000×4000 的 JPEG（只在有 sips 的 macOS 上）：资料库一屏缩略图就是一屏「问主进程缩一张」。
 *   - 每 2.5 秒切到下一个对话看一眼（等 openSession 画完），再过 1.2 秒取一次数。
 *   - 跑到 40% 时进一趟资料库（openPageView("lib")）、把能滚的都滚到底、等缩略图都出来；回来开关一次侧栏、
 *     输入框打「/」弹出技能菜单再关掉、开关一次账号菜单。资料库页正在重写，这里只认 openPageView 和通用滚动。
 *   - 主进程卡顿记录门槛压到 100ms（OWB_MAIN_STALL_MS），每一次都记下那会儿桥上的活名；RSS 每秒读一次。
 *   - 机器睡过（合盖）的那几拍不进迟到：墙钟比单调钟多走一秒以上就是停过，照实说出来，那一趟的数不作数。
 *
 * 界面线程判据（数「走了哪条路」，不数毫秒；毫秒照实打出来，验收看三趟中位数）：
 *   大 JPEG 缩图真问了主进程、全交给 sips、没有一张退回界面线程；截图 PNG 全在线程里编、界面线程上 0 张。
 *   ★反向对照★ OWB_MAIN_PIXELS=native 走回老路（主进程 nativeImage 缩图 + toPNG），这两条必须判红。
 *
 * CI 档判据：按 30 秒一段切成三段，只比第 2、3 段（第 1 段是预热：历史还没攒满 10 轮窗口）。
 *   每段取上四分位（流式正文一会儿长一会儿短，不被一两次峰值带歪；为什么不用中位数见 upperQ），第 3 段不许比第 2 段多出：
 *     DOM 节点 max(40, 3%) · setInterval 3 个 · 挂着的 setTimeout max(10, 30%) · 每个够得着的 Map/Set 2 条 ·
 *     看得见的那类窗口 0 个；离屏窗口任何时刻 ≤ 1 个（资料库 HTML 封面那一扇复用窗）；任务截图窗任何时刻 ≤ 1 扇。
 *   ★反向对照★ 跑完三段后原地「漏」15 秒：每 0.5 秒往页面塞一把节点、一个 setInterval、五个 setTimeout、
 *     一条 Map 记录，主进程多开两扇离屏窗、一扇普通隐藏窗——同一把尺子必须样样判红（这一段至少取 3 次数）。
 *   服务端的 Map 够不着：它在独立服务进程里，这里只看得到它的内存。
 * 本机档判据（多出来的）：切四段，每段 150 秒，最后 5 分钟里
 *   main + renderer + server 三个进程 RSS 的最小二乘斜率合计 < 1MB/分钟；主进程、页面的事件循环迟到 p95 < 30ms。
 *   ★反向对照★ 页面每 10 秒攥住 6MB 攥 90 秒，斜率必须 > 1MB/分钟；主进程和页面每 60ms 忙等 45ms 持续 8 秒，p95 必须 ≥ 30ms。
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const cp = require("child_process");
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");

const ROOT = path.join(__dirname, "..");
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = process.argv.includes("--local") || process.env.OWB_SOAK_LOCAL === "1";
const CHATS = 5;
const TOKEN_MS = 16;

/** 两档的时长。环境变量只拿来压短本机档验这套东西自己转得起来，判据不跟着变 */
function makePlan() {
  const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  if (LOCAL) {
    const secs = num("OWB_SOAK_SECS", 600);
    return { local: true, wins: 4, winMs: Math.round((secs * 1000) / 4), leakMs: num("OWB_SOAK_LEAK_SECS", 15) * 1000,
      rssLeakMs: num("OWB_SOAK_RSS_LEAK_SECS", 90) * 1000, busyMs: 8000 };
  }
  const secs = num("OWB_SOAK_SECS", 90);
  return { local: false, wins: 3, winMs: Math.round((secs * 1000) / 3), leakMs: num("OWB_SOAK_LEAK_SECS", 15) * 1000, rssLeakMs: 0, busyMs: 0 };
}

// ======================================================================
// 页面里打的补丁：赶在页面自己的脚本之前（CDP addScriptToEvaluateOnNewDocument）
// ======================================================================
/**
 * setTimeout / setInterval 记账：挂着的 id 各进一个 Set，回调跑了、被 clear 了就出账。
 * 顺带一个 20ms 的迟到采样器（用原版 setInterval，不进账），按段落进 1ms 一格的直方图，
 * 跑 10 分钟内存也是那几个 Uint32Array，不会自己把自己量涨。
 * 页面上的等待一律走原版 oST，不算进页面自己的账。
 */
const TIMER_PATCH = `(() => {
  if (window.__soakT) return;
  const oST = window.setTimeout.bind(window), oCT = window.clearTimeout.bind(window);
  const oSI = window.setInterval.bind(window), oCI = window.clearInterval.bind(window);
  const to = new Set(), iv = new Set();
  window.setTimeout = function (fn, ms, ...a) {
    if (typeof fn !== "function") return oST(fn, ms, ...a);
    const id = oST(function () { to.delete(id); return fn.apply(this, arguments); }, ms, ...a);
    to.add(id);
    return id;
  };
  window.clearTimeout = function (id) { to.delete(id); iv.delete(id); return oCT(id); };
  window.setInterval = function (fn, ms, ...a) {
    const id = oSI(fn, ms, ...a);
    if (typeof fn === "function") iv.add(id);
    return id;
  };
  window.clearInterval = function (id) { iv.delete(id); to.delete(id); return oCI(id); };
  const hist = {};
  let key = "boot", last = performance.now(), lastWall = Date.now();
  const H = (k) => hist[k] || (hist[k] = new Uint32Array(2001));
  oSI(() => {
    const now = performance.now(), w = Date.now();
    const d = Math.max(0, Math.round(now - last - 20));
    const drift = (w - lastWall) - (now - last);
    last = now; lastWall = w;
    if (drift > 1000) return; // 机器睡过：这一拍不算页面卡
    H(key)[Math.min(2000, d)]++;
  }, 20);
  const stats = (keys) => {
    const m = new Uint32Array(2001);
    for (const k of [].concat(keys)) if (hist[k]) for (let i = 0; i < 2001; i++) m[i] += hist[k][i];
    let n = 0, max = 0;
    for (let i = 0; i < 2001; i++) if (m[i]) { n += m[i]; max = i; }
    const q = (p) => { if (!n) return null; const want = Math.ceil(p * n); let acc = 0; for (let i = 0; i < 2001; i++) { acc += m[i]; if (acc >= want) return i; } return 2000; };
    return { n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max };
  };
  window.__soakT = { to, iv, oST, oCT, oSI, oCI, setKey: (k) => { key = k; last = performance.now(); lastWall = Date.now(); }, stats };
})();`;

/** 页面里的那套：五个对话、取数、资料库一趟、菜单一趟、三种「漏」 */
function pageSetup(sids, mapNames, leakTarget) {
  const mapExpr = mapNames.map((n) => `m[${J(n)}] = (() => { try { const v = ${n}; return v && typeof v.size === "number" ? v.size : null; } catch (e) { return null; } })();`).join("\n");
  const leakPut = leakTarget
    ? `(${leakTarget}.set ? ${leakTarget}.set(key, Promise.resolve()) : ${leakTarget}.add(key));`
    : "";
  const leakDel = leakTarget ? `${leakTarget}.delete(key);` : "";
  return `(() => {
  const T = window.__soakT;
  const wait = (ms) => new Promise((r) => T.oST(r, ms));
  const sids = ${J(sids)};
  const S = window.__soak = { sids, stop: false, turns: sids.map(() => 0), done: sids.map(() => 0), fast: 0, errs: [], loops: [], cur: 0, diag: {} };
  // 每一轮在页面这一侧留几笔：/api/chat 回了几号、有没有撞 409 改走插话、界面上报了什么错、这一轮花了多久。
  // 驱动那边发现哪一轮假模型一次都没被叫到（2026-09-29 本机档 3:75 就是这样），拿这几笔对：
  // 请求到底发没发、回了什么、是不是被当成插话送进了上一轮
  const TURN = /浸泡 (\\d) 第 (\\d+) 轮/;
  const note = (text, what) => {
    const m = TURN.exec(String(text || ""));
    if (!m) return;
    const a = S.diag[m[1] + ":" + m[2]] || (S.diag[m[1] + ":" + m[2]] = []);
    if (a.length < 12) a.push(what);
  };
  const oFetch = window.fetch;
  window.fetch = function (url, init) {
    const u = String((url && url.url) || url || "");
    const p = oFetch.apply(this, arguments);
    if ((u === "/api/chat" || u === "/api/chat/interject") && init && typeof init.body === "string") {
      let msg = "";
      try { msg = JSON.parse(init.body).message; } catch (e) {}
      const tag = u === "/api/chat" ? "chat" : "interject";
      p.then((r) => note(msg, tag + ":" + r.status), (e) => note(msg, tag + ":断了 " + String((e && e.message) || e).slice(0, 80)));
    }
    return p;
  };
  const oTurnUI = window.createTurnUI;
  if (typeof oTurnUI === "function") window.createTurnUI = function (text) {
    const ui = oTurnUI.apply(this, arguments);
    if (ui && typeof ui.handleEvent === "function") {
      const oH = ui.handleEvent;
      ui.handleEvent = function (ev) { if (ev && ev.type === "error") note(text, "报错:" + String(ev.message || "").slice(0, 120)); return oH.apply(this, arguments); };
    }
    return ui;
  };
  const now = Date.now();
  for (let k = sids.length - 1; k >= 0; k--) sessions.unshift({ id: sids[k], title: "浸泡 " + k, at: now, project: activeProject, lane: activeLane });
  saveSessions();
  renderHistory();
  S.open = (k) => { S.cur = k; return openSession(sids[k]); };
  S.sample = () => {
    const m = {};
    ${mapExpr}
    // 节点落在哪儿：body 底下每一块各多少（判红时跟着打出来，一眼看出是对话区、侧栏还是挂在 body 上的弹层在涨）
    const parts = {};
    for (const el of document.body.children) {
      const name = el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.classList[0] ? "." + el.classList[0] : "");
      parts[name] = (parts[name] || 0) + 1 + el.getElementsByTagName("*").length;
    }
    return { dom: document.getElementsByTagName("*").length, to: T.to.size, iv: T.iv.size, maps: m, parts,
      chat: chatCol.getElementsByTagName("*").length, turnsShown: chatCol.children.length,
      running: runningSessions.size, sess: sessions.length, vis: document.visibilityState };
  };
  S.start = () => {
    S.loops = sids.map((sid, k) => (async () => {
      while (!S.stop) {
        const n = ++S.turns[k];
        const text = "浸泡 " + k + " 第 " + n + " 轮：写一页、读回来、列一下目录";
        // 上一轮在页面上还没收尾：runTurn 会把这句塞进排队、马上返回
        if (runningSessions.has(sid)) note(text, "还在跑，进了排队");
        const t0 = Date.now();
        try { await runTurn(sid, text, "craft"); }
        catch (e) { note(text, "抛了"); S.errs.push(k + ":" + n + " " + String((e && e.message) || e).slice(0, 200)); await wait(500); }
        note(text, "ms:" + (Date.now() - t0));
        S.done[k]++;
        // 一轮不到 300ms 就回来 = 没真跑（被塞进了排队或请求直接被拒），记一笔，别原地空转
        if (Date.now() - t0 < 300) { S.fast++; await wait(500); }
        await wait(50);
      }
    })());
    return true;
  };
  S.stopAll = () => { S.stop = true; return Promise.all(S.loops).then(() => ({ turns: S.turns, done: S.done, errs: S.errs, fast: S.fast, diag: S.diag })); };
  S.lib = async () => {
    openPageView("lib");
    await wait(2500);
    const shown = pageKind === "lib" && !!document.getElementById("assist-page");
    const box = document.getElementById("assist-page");
    const texts = box ? (box.innerText || "").length : 0;
    const pool = [document.scrollingElement, chatCol, ...chatCol.querySelectorAll("*")];
    const scrollers = pool.filter((el) => {
      if (!el || el.scrollHeight <= el.clientHeight + 4) return false;
      const oy = getComputedStyle(el).overflowY;
      return el === document.scrollingElement || oy === "auto" || oy === "scroll" || oy === "overlay";
    });
    for (let i = 0; i < 6; i++) { for (const el of scrollers) el.scrollTop += Math.max(200, el.clientHeight); await wait(250); }
    for (const el of scrollers) el.scrollTop = el.scrollHeight;
    await wait(2000);
    const bottom = scrollers.filter((el) => el.isConnected && el.scrollTop + el.clientHeight >= el.scrollHeight - 4).length;
    // 大图的缩略图等它回来（最多再等 8 秒）：主进程缩图那一截要落在这一趟里，迟到的数才量得到它
    for (let i = 0; i < 40; i++) { const g = S.imgs(); if (g.loaded + g.broken >= g.n) break; await wait(200); }
    const imgs = S.imgs();
    await S.open(S.cur);
    return { shown, texts, scrollers: scrollers.length, bottom, back: sessionId === sids[S.cur], imgs };
  };
  S.menus = async () => {
    const did = [];
    const side0 = document.body.className;
    toggleSidebar(); await wait(300);
    const sideMoved = document.body.className !== side0;
    toggleSidebar(); await wait(300);
    const sideBack = document.body.className === side0;
    did.push("侧栏");
    if (typeof openChatSearch === "function" && typeof closeChatSearch === "function") { openChatSearch(); await wait(400); closeChatSearch(); await wait(200); did.push("对话内搜索"); }
    inputEl.focus();
    inputEl.value = "/";
    inputEl.setSelectionRange(1, 1);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(800);
    const slashShown = mentionMenu.classList.contains("show");
    inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    inputEl.value = "";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(300);
    const slashGone = !mentionMenu.classList.contains("show");
    did.push("技能菜单");
    if (typeof openUserMenu === "function" && typeof closeUserMenu === "function") { openUserMenu(); await wait(300); closeUserMenu(); await wait(200); did.push("账号菜单"); }
    for (const n of ["openCommandPalette", "openCmdPalette", "openPalette"]) {
      const f = window[n];
      if (typeof f === "function") { f(); await wait(300); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })); await wait(300); did.push(n); }
    }
    return { did, sideMoved, sideBack, slashShown, slashGone };
  };
  S.leakStart = () => {
    const box = document.createElement("div");
    box.id = "__soak_leak";
    box.style.display = "none";
    document.body.appendChild(box);
    const L = S.leak = { box, iv: [], to: [], keys: [], n: 0 };
    const drip = () => {
      L.n++;
      const per = Math.max(40, Math.ceil(document.getElementsByTagName("*").length * 0.01));
      for (let i = 0; i < per; i++) box.appendChild(document.createElement("span"));
      L.iv.push(setInterval(() => {}, 3600000));
      for (let i = 0; i < 5; i++) L.to.push(setTimeout(() => {}, 3600000));
      const key = "__soak_leak_" + L.n;
      ${leakPut}
      L.keys.push(key);
    };
    drip(); // 从 0 秒就开始漏：这一段的头一次取数就该看得见，别白等半秒
    L.timer = T.oSI(drip, 500);
    return ${J(leakTarget || "")};
  };
  S.leakStop = () => { if (S.leak) T.oCI(S.leak.timer); };
  S.leakClean = () => {
    const L = S.leak;
    if (!L) return;
    T.oCI(L.timer);
    L.box.remove();
    L.iv.forEach((id) => clearInterval(id));
    L.to.forEach((id) => clearTimeout(id));
    for (const key of L.keys) { ${leakDel} }
    S.leak = null;
  };
  S.hogStart = () => {
    S.hog = [new Uint8Array(6 << 20).fill(1)];
    S.hogTimer = T.oSI(() => S.hog.push(new Uint8Array(6 << 20).fill(1)), 10000);
  };
  S.hogStop = () => { T.oCI(S.hogTimer); S.hog = null; };
  S.busyStart = () => { S.busyTimer = T.oSI(() => { const e = performance.now() + 45; while (performance.now() < e); }, 60); };
  S.busyStop = () => T.oCI(S.busyTimer);
  // 资料库页上的缩略图（?thumb=）有几张、回来了几张、几张坏的
  S.imgs = () => {
    const all = [...document.querySelectorAll("#assist-page img")].filter((im) => /[?&]thumb=/.test(im.getAttribute("src") || ""));
    return { n: all.length, loaded: all.filter((im) => im.complete && im.naturalWidth > 0).length, broken: all.filter((im) => im.complete && !im.naturalWidth).length };
  };
  S.open(0);
  return true;
})()`;
}

// ======================================================================
// 子进程：Electron 主进程（包一层 electron-main.js）
// ======================================================================
function childMain() {
  const { app, BrowserWindow, session } = require("electron");
  const { performance } = require("perf_hooks");
  if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();
  const P = JSON.parse(process.env.OWB_SOAK_PLAN || "{}");
  const out = (tag, obj) => { try { process.stdout.write(tag + " " + J(obj) + "\n"); } catch {} };
  const fail = (why) => { out("SOAK_FAIL", { why: String(why).slice(0, 1500) }); };

  // 主进程的迟到采样：10ms 一次，按段落进直方图（和页面那份一样，跑多久内存都不涨）。
  // 合盖睡过一觉的那一拍不进：2026-09-29 本机档中途睡了 181 秒，醒来那一拍记成了 2000ms 的「卡顿」。
  // 墙钟比单调钟多走一大截就是机器停过，不是界面线程卡过（跟 bridge-main.js 的卡顿记录同一个判法）
  const MH = {};
  let mkey = "boot", mlast = performance.now(), mwall = Date.now(), mextra = "";
  const mslept = { n: 0, ms: 0 };
  const MHk = (k) => MH[k] || (MH[k] = new Uint32Array(2001));
  setInterval(() => {
    const now = performance.now(), w = Date.now();
    const d = Math.max(0, Math.round(now - mlast - 10));
    const drift = (w - mwall) - (now - mlast);
    mlast = now; mwall = w;
    if (drift > 1000) { mslept.n++; mslept.ms += Math.round(drift); return; }
    MHk(mkey)[Math.min(2000, d)]++;
    if (mextra) MHk(mextra)[Math.min(2000, d)]++;
  }, 10);
  const mstats = (keys) => {
    const m = new Uint32Array(2001);
    for (const k of [].concat(keys)) if (MH[k]) for (let i = 0; i < 2001; i++) m[i] += MH[k][i];
    let n = 0, max = 0;
    for (let i = 0; i < 2001; i++) if (m[i]) { n += m[i]; max = i; }
    const q = (p) => { if (!n) return null; const want = Math.ceil(p * n); let acc = 0; for (let i = 0; i < 2001; i++) { acc += m[i]; if (acc >= want) return i; } return 2000; };
    return { n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max };
  };

  let mainWin = null;
  // 任务截图（html_to_image）那扇窗：截一张开一扇、截完就关，跟资料库封面那一扇复用窗分开数。
  // 认法：它是在 htmlshot 正跑任务道时建出来的（道是串行的，同一时刻只有一单）；浸泡自己开的漏窗不算
  const taskWins = new WeakSet();
  let ownWin = false;
  const shotLane = () => { try { return require(mod("htmlshot"))._internals.state().running; } catch { return ""; } };
  app.on("browser-window-created", (_e, w) => {
    if (!mainWin) { mainWin = w; return; }
    if (!ownWin && shotLane() === "task") taskWins.add(w);
  });
  let gone = null;
  app.on("render-process-gone", (_e, wc, d) => { if (mainWin && !mainWin.isDestroyed() && wc === mainWin.webContents) { gone = d; fail("页面进程没了：" + J(d)); } });

  require(entry("electron-main"));

  const until = async (fn, ms, step = 200) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(step); }
    return false;
  };

  app.whenReady().then(async () => {
    try {
      // 1. 等 electron-main 把页面指到服务端
      const up = await until(() => mainWin && !mainWin.isDestroyed() && /^http:\/\/127\.0\.0\.1:\d+/.test(mainWin.webContents.getURL()) && !mainWin.webContents.isLoading(), 90000);
      if (!up) return fail("90 秒内主窗口没加载到服务端地址：" + (mainWin ? mainWin.webContents.getURL() : "没有窗口"));
      const wc = mainWin.webContents;
      const base = /^http:\/\/127\.0\.0\.1:\d+/.exec(wc.getURL())[0];
      const port = Number(base.split(":").pop());
      const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " " + ms + "ms 没回来")), ms))]);
      const js = (s, ms = 30000) => withTimeout(wc.executeJavaScript(s), ms, "页面脚本");

      // 2. 计时器记账补丁要赶在页面脚本之前：CDP 注册，再带上登录 cookie 重载
      const dbg = wc.debugger;
      dbg.attach("1.3");
      await dbg.sendCommand("Page.enable");
      await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: TIMER_PATCH });
      await dbg.sendCommand("Performance.enable");
      await session.defaultSession.cookies.set({ url: base, name: "openworkbuddy_token", value: P.token });
      const loaded = new Promise((r) => wc.once("did-finish-load", r));
      wc.reload();
      await withTimeout(loaded, 60000, "带 cookie 重载");
      const ready = await until(() => js(`document.readyState === "complete" && typeof runTurn === "function" && typeof currentUser !== "undefined" && !!currentUser`, 5000), 60000, 300);
      if (!ready) return fail("60 秒内页面没登录上 / 没加载完：" + (await js(`document.body ? document.body.innerText.slice(0, 300) : ""`).catch((e) => e.message)));
      if (!(await js(`!!window.__soakT`))) return fail("计时器记账补丁没进页面（addScriptToEvaluateOnNewDocument 没生效）");
      await js(`typeof I18N !== "undefined" && I18N.setLang && I18N.setLang("zh"); true`);
      await sleep(1500); // 开机那几下请求（侧栏、设置、预览状态）先落地

      // 3. 三个进程的 pid
      const metrics = app.getAppMetrics();
      const util = metrics.find((m) => m.type === "Utility" && /OpenWorkBuddy/i.test(String(m.serviceName || m.name || "")));
      const pids = { main: process.pid, renderer: wc.getOSProcessId(), server: util ? util.pid : 0 };

      // 4. 页面顶层的 Map / Set：按源码现找，不在这儿抄名单（抄了就会和源码分叉）
      const names = [];
      for (const f of fs.readdirSync(path.join(ROOT, "public", "js")).filter((x) => /\.js$/.test(x)).sort()) {
        const src = fs.readFileSync(path.join(ROOT, "public", "js", f), "utf8");
        for (const m of src.matchAll(/^(?:const|let) (\w+) = new (?:Map|Set)\(/gm)) if (!names.includes(m[1])) names.push(m[1]);
      }
      names.push("liveCh.subs");
      const probe = await js(`(() => { const r = {}; for (const n of ${J(names)}) { try { const v = (0, eval)(n); r[n] = v && typeof v.size === "number" ? v.size : null; } catch (e) { r[n] = null; } } return r; })()`);
      const maps = names.filter((n) => probe[n] !== null && probe[n] !== undefined);
      const leakTarget = maps.includes("scriptCache") ? "scriptCache" : maps.find((n) => !n.includes(".")) || "";
      const stamp = Date.now();
      const sids = Array.from({ length: CHATS }, (_, k) => `s_${stamp}_${100001 + k}`);
      await js(pageSetup(sids, maps, leakTarget));
      const rafOk = await js(`new Promise((r) => { let hit = false; requestAnimationFrame(() => { hit = true; }); __soakT.oST(() => r(hit), 500); })`);
      out("SOAK_T0", { at: Date.now(), port, pids, maps, unreachable: names.filter((n) => !maps.includes(n)), leakTarget, sids, rafOk });

      // 5. 开跑
      const phases = [];
      for (let i = 1; i <= P.wins; i++) phases.push({ ph: "w" + i, ms: P.winMs });
      phases.push({ ph: "leak", ms: P.leakMs });
      if (P.local) { phases.push({ ph: "rss", ms: P.rssLeakMs }); phases.push({ ph: "busy", ms: P.busyMs }); }
      let ph = "w1";
      const setPh = async (p) => { ph = p; mkey = p; mlast = performance.now(); mwall = Date.now(); await js(`__soakT.setKey(${J(p)}); true`); };
      await setPh("w1");
      await js(`__soak.start()`);
      const t0 = Date.now();
      let paused = false, stopTicks = false;
      const winAgg = {};
      const winTimer = setInterval(() => {
        const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
        let off = 0, task = 0;
        for (const w of all) {
          try { if (!w.webContents.isOffscreen()) continue; } catch { continue; }
          if (taskWins.has(w)) task++; else off++;
        }
        const a = winAgg[ph] || (winAgg[ph] = { n: 0, onMax: 0, onMin: Infinity, offMax: 0, taskMax: 0 });
        a.n++;
        a.onMax = Math.max(a.onMax, all.length - off - task);
        a.onMin = Math.min(a.onMin, all.length - off - task);
        a.offMax = Math.max(a.offMax, off);
        a.taskMax = Math.max(a.taskMax, task);
      }, 1000);
      // 每 30 秒让页面收一次垃圾：斜率、中位数量的是「还攥着的」，不是「还没来得及收的」
      const gcTimer = setInterval(() => { dbg.sendCommand("HeapProfiler.collectGarbage").catch(() => {}); }, 30000);
      const ticks = (async () => {
        let i = 0;
        while (!stopTicks) {
          if (!paused && !gone) {
            try {
              // 等 openSession 画完再数：2026-09-29 本机档醒来后那几次没等，数到的是只画了 2 轮、11 个节点的半截对话，
              // 一段 4 次里两次是半截，上四分位被拽回原样，★反向对照★ 的 DOM 那一行就没判红
              const o0 = Date.now();
              await js(`Promise.resolve(__soak.open(${++i % CHATS})).then(() => true)`);
              const openMs = Date.now() - o0;
              await sleep(1200);
              if (!paused && !stopTicks) out("SOAK_S", { t: Date.now() - t0, ph, openMs, ...(await js(`__soak.sample()`)) });
            } catch (e) { out("SOAK_LOG", { why: "取数失败：" + e.message }); }
          }
          await sleep(1300);
        }
      })();

      const midAt = 0.4 * P.wins * P.winMs;
      let midDone = false;
      const midway = async () => {
        paused = true;
        await sleep(300);
        // 资料库这一趟单记一份主进程迟到（照样也进所在那一段）：大图缩略图就是这会儿问主进程要的
        mextra = "lib";
        const lib = await js(`__soak.lib()`, 60000).catch((e) => ({ err: e.message }));
        mextra = "";
        const menus = await js(`__soak.menus()`, 60000).catch((e) => ({ err: e.message }));
        out("SOAK_MID", { t: Date.now() - t0, lib, menus, libEld: mstats("lib") });
        paused = false;
      };
      const extraWins = [];
      for (const p of phases) {
        await setPh(p.ph);
        const pStart = Date.now();
        out("SOAK_PHASE", { ph: p.ph, at: pStart });
        if (p.ph === "leak") {
          await js(`__soak.leakStart()`);
          // 两扇离屏 + 一扇普通隐藏窗：一律 show:false、挪到屏幕外，从头到尾不 show 不 focus
          for (const offscreen of [true, true, false]) {
            ownWin = true;
            const w = new BrowserWindow({ show: false, x: -20000, y: -20000, width: 400, height: 300, webPreferences: { offscreen, backgroundThrottling: false } });
            ownWin = false;
            extraWins.push(w);
            w.loadURL("about:blank").catch(() => {});
          }
        }
        let mainBusy = null;
        if (p.ph === "rss") await js(`__soak.hogStart(); true`);
        if (p.ph === "busy") {
          await js(`__soak.busyStart(); true`);
          mainBusy = setInterval(() => { const e = performance.now() + 45; while (performance.now() < e); }, 60);
        }
        while (Date.now() - pStart < p.ms && !gone) {
          if (!midDone && Date.now() - t0 >= midAt) { midDone = true; await midway(); }
          await sleep(200);
        }
        if (mainBusy) clearInterval(mainBusy);
        if (p.ph === "busy") await js(`__soak.busyStop(); true`);
        if (p.ph === "leak") await js(`__soak.leakStop(); true`);
        let cdp = {};
        try {
          await dbg.sendCommand("HeapProfiler.collectGarbage");
          const r = await dbg.sendCommand("Performance.getMetrics");
          for (const m of r.metrics || []) if (["Nodes", "JSEventListeners", "JSHeapUsedSize", "Documents", "Frames", "LayoutObjects"].includes(m.name)) cdp[m.name] = m.value;
        } catch (e) { cdp = { err: e.message }; }
        const rend = await js(`__soakT.stats(${J(p.ph)})`).catch(() => null);
        out("SOAK_W", { ph: p.ph, mainEld: mstats(p.ph), rendEld: rend, win: winAgg[p.ph] || null, cdp });
        if (p.ph === "leak") {
          // 先换掉段名再收拾：收拾完以后才回来的那次取数不能记在「漏」这一段头上
          ph = "leak-done";
          await js(`__soak.leakClean(); true`);
          for (const w of extraWins) { try { if (!w.isDestroyed()) w.destroy(); } catch {} }
        }
        if (p.ph === "rss") await js(`__soak.hogStop(); true`);
        if (gone) break;
      }
      stopTicks = true;
      paused = true;
      await ticks;
      clearInterval(winTimer);
      clearInterval(gcTimer);
      const tail = P.local ? ["w" + (P.wins - 1), "w" + P.wins] : ["w" + (P.wins - 1), "w" + P.wins];
      // electron-main 自带的卡顿记录（OWB_MAIN_STALL_MS=100）：每一次超过 100ms 的卡顿、那会儿桥上有哪几件活
      const stall = global.__owbMainStall, ops = global.__owbMainOps;
      out("SOAK_ELD", {
        tail: { keys: tail, main: mstats(tail), rend: await js(`__soakT.stats(${J(tail)})`).catch(() => null) },
        busy: P.local ? { main: mstats("busy"), rend: await js(`__soakT.stats("busy")`).catch(() => null) } : null,
        all: { main: mstats(phases.map((p) => p.ph).filter((p) => /^w\d+$/.test(p))), slept: mslept },
        stall: stall ? { counts: { ...stall.counts }, max: stall.maxMs, list: stall.stalls.slice() } : null,
        ops: ops ? ops.stats() : null,
        shot: (() => { try { return require(mod("htmlshot"))._internals.state().stats; } catch { return null; } })(),
      });
      const end = await js(`__soak.stopAll()`, 90000).catch((e) => ({ err: e.message }));
      try { dbg.detach(); } catch {}
      out("SOAK_END", end);
    } catch (e) {
      fail("浸泡主流程炸了：" + ((e && e.stack) || e));
    }
  });
}

// ======================================================================
// 驱动：node 进程。假模型、临时家、拉 Electron、判
// ======================================================================
function driverMain() {
  let electronBin = null;
  try { electronBin = require("electron"); } catch {}
  if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
    console.log("跳过：没装 electron，浸泡测的是桌面版的窗口和页面");
    process.exit(0);
  }
  if (process.platform === "win32") {
    console.log("跳过：三个进程的 RSS、进程树靠 ps，Windows 上另有一套");
    process.exit(0);
  }
  const HOME = require("./lib/own-home")("soak-multichat");
  const P = makePlan();
  const TOKEN = "tk" + Date.now();

  let pass = 0, fail = 0;
  const ok = (cond, msg, detail) => {
    if (cond) { pass++; console.log("  ✅ " + msg); }
    else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + J(detail).slice(0, 900))); }
  };
  const info = (msg) => console.log("  · " + msg);

  // ---------- 进程表（和 server-process.js 同一套） ----------
  function psRows() {
    const r = cp.spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,args="], { encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
    const rows = [];
    for (const line of String(r.stdout || "").split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m && +m[1] !== r.pid) rows.push({ pid: +m[1], ppid: +m[2], args: m[3] });
    }
    return rows;
  }
  function tree(rows, root) {
    const mine = new Set([root]);
    for (let grew = true; grew;) {
      grew = false;
      for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; }
    }
    mine.delete(root);
    return [...mine];
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  /**
   * 三个进程的 RSS（MB）。异步、不阻塞驱动自己的计时器：2026-09-29 本机档醒来后同步的 ps 两次超时，
   * 「攥内存」那一段只剩 2 个点，斜率算不出来，★反向对照★ 回了个 null
   */
  function rssOf(pids, cb) {
    const list = pids.filter((p) => p > 0);
    if (!list.length) return cb({});
    cp.execFile("ps", ["-o", "pid=,rss=", "-p", list.join(",")], { encoding: "utf8", timeout: 5000 }, (_err, stdout) => {
      const got = {};
      for (const line of String(stdout || "").split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)/.exec(line);
        if (m) got[+m[1]] = +m[2] / 1024;
      }
      cb(got);
    });
  }
  /**
   * 资料库里的大照片：6000×4000 的 JPEG 若干张。用户工作区里躺着的就是这种手机/相机原图，
   * 资料库一屏缩略图就是一屏的「问主进程缩一张」——以前那是 nativeImage 在界面线程上同步解码，
   * 同尺寸量过一张卡 100ms 以上。先写一张 BMP（不压缩，写起来快），sips 转成 JPEG，再复制成几份；
   * 缩略图缓存按路径记，复制出来的每一份都要各缩一次。没有 sips（非 macOS）就不放，返回 0
   */
  function writeBigJpegs(dir, scratch, n = 12) {
    const sips = "/usr/bin/sips";
    if (process.platform !== "darwin" || !fs.existsSync(sips)) return 0;
    const W = 6000, H = 4000, row = W * 3;
    const bmp = Buffer.alloc(54 + row * H);
    bmp.write("BM", 0);
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(W, 18);
    bmp.writeInt32LE(H, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(row * H, 34);
    // 渐变打底 + 一点固定种子的噪点：纯渐变压出来太小（缩略图那条路 100KB 以下不缩），也不像照片
    let s = 0x2545f491;
    for (let y = 0; y < H; y++) {
      let o = 54 + y * row;
      for (let x = 0; x < W; x++) {
        s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
        const r = (s >>> 24) & 31;
        bmp[o++] = ((x * 255) / W + r) & 255;
        bmp[o++] = ((y * 255) / H + r) & 255;
        bmp[o++] = (((x + y) * 128) / (W + H) + r) & 255;
      }
    }
    const src = path.join(scratch, "big.bmp");
    fs.writeFileSync(src, bmp);
    fs.mkdirSync(dir, { recursive: true });
    const first = path.join(dir, "照片_00.jpg");
    const r = cp.spawnSync(sips, ["-s", "format", "jpeg", "-s", "formatOptions", "85", src, "--out", first], { encoding: "utf8", timeout: 60000 });
    try { fs.unlinkSync(src); } catch {}
    if (r.status !== 0 || !fs.existsSync(first)) { info("sips 没转出 JPEG：" + String(r.stderr || r.error || "").slice(0, 200)); return 0; }
    for (let i = 1; i < n; i++) fs.copyFileSync(first, path.join(dir, `照片_${String(i).padStart(2, "0")}.jpg`));
    return n;
  }
  function listenerPid(port) {
    const r = cp.spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", timeout: 15000 });
    const m = /^p(\d+)/m.exec(String(r.stdout || ""));
    return m ? +m[1] : 0;
  }

  // ---------- 假模型 ----------
  const TURN_RE = /浸泡 (\d) 第 (\d+) 轮/;
  const textOf = (c) => (typeof c === "string" ? c : J(c));
  const chunk2 = (s) => s.match(/[\s\S]{1,2}/gu) || [];
  const fill = (s, chars) => { let t = s; while (t.length < chars) t += s; return t.slice(0, chars); };
  const turns = new Map(); // "k:n" → { steps:Set, calls, readBack }
  const llmStat = { calls: 0, other: 0, extra: 0, otherKeys: [] };
  let callSeq = 0;
  const htmlOf = (k, n) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>浸泡 ${k}</title></head><body><h1>浸泡 ${k} 第 ${n} 轮</h1><p>这一页每轮都会被重写，路径固定，文件数不随轮数涨。</p></body></html>`;
  async function answer(res, stream, text, tool) {
    if (res.writableEnded || res.destroyed) return;
    if (!stream) {
      const message = { role: "assistant", content: text };
      if (tool) message.tool_calls = [{ id: "call_" + ++callSeq, type: "function", function: { name: tool.name, arguments: J(tool.args) } }];
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(J({ choices: [{ message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const ch = (delta, fin) => "data: " + J({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: fin || null }] }) + "\n\n";
    for (const t of chunk2(text)) {
      if (res.destroyed) return;
      res.write(ch({ content: t }));
      await sleep(TOKEN_MS);
    }
    if (res.destroyed) return;
    if (tool) res.write(ch({ tool_calls: [{ index: 0, id: "call_" + ++callSeq, type: "function", function: { name: tool.name, arguments: J(tool.args) } }] }));
    res.write(ch({}, tool ? "tool_calls" : "stop"));
    res.end("data: " + J({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }) + "\n\ndata: [DONE]\n\n");
  }
  const llm = http.createServer((req, res) => {
    const bufs = [];
    req.on("data", (c) => bufs.push(c));
    req.on("end", () => {
      let b = {};
      try { b = JSON.parse(Buffer.concat(bufs).toString("utf8")); } catch {}
      llmStat.calls++;
      const msgs = Array.isArray(b.messages) ? b.messages : [];
      const tools = Array.isArray(b.tools) ? b.tools : [];
      const stream = !!b.stream;
      const toolName = (t) => ((t && t.function) || t || {}).name;
      const hasWrite = tools.some((t) => toolName(t) === "write_file");
      let ui = -1, m = null;
      for (let i = msgs.length - 1; i >= 0 && !m; i--) if (msgs[i].role === "user") { const mm = TURN_RE.exec(textOf(msgs[i].content)); if (mm) { ui = i; m = mm; } }
      if (!hasWrite || !m) {
        llmStat.other++;
        // 认得出是哪一轮、却没带工具的那几次：没走完的那一轮要拿它来对
        if (m && llmStat.otherKeys.length < 20) llmStat.otherKeys.push({ key: m[1] + ":" + m[2], tools: tools.length, stream });
        return answer(res, stream, "好的");
      }
      const k = +m[1], n = +m[2];
      // 每 3 轮截一张图（html_to_image）：多个任务一起跑时截图是常事，截图那一截 PNG 编码以前就在主进程上
      const shotTurn = n % 3 === 0 && tools.some((t) => toolName(t) === "html_to_image");
      const toolMsgs = msgs.slice(ui + 1).filter((x) => x.role === "tool");
      const step = Math.min(toolMsgs.length, shotTurn ? 4 : 3);
      const key = k + ":" + n;
      const rec = turns.get(key) || { k, n, steps: new Set(), calls: 0, readBack: null, shot: shotTurn, shotOk: null };
      turns.set(key, rec);
      rec.calls++;
      if (rec.steps.has(step)) llmStat.extra++;
      rec.steps.add(step);
      if (step === 0) return answer(res, stream, fill("先写一页网页，把这一轮的编号写进标题；写完读回来核对，再列一下目录。", 48),
        { name: "write_file", args: { path: `soak_${k}.html`, content: htmlOf(k, n), overwrite: true } });
      if (step === 1) return answer(res, stream, fill("写好了，读回来核对。", 16), { name: "read_file", args: { path: `soak_${k}.html` } });
      if (step === 2) {
        rec.readBack = textOf(toolMsgs[1] && toolMsgs[1].content).includes(`浸泡 ${k} 第 ${n} 轮`);
        return answer(res, stream, fill("内容对得上，列一下目录。", 16), { name: "list_files", args: {} });
      }
      if (step === 3 && shotTurn) {
        return answer(res, stream, fill("再把这一页截成图。", 12),
          { name: "html_to_image", args: { html_file: `soak_${k}.html`, filename: `soak_${k}_shot.png`, width: 1242, height: 1656, wait_ms: 100 } });
      }
      if (shotTurn) {
        const said = textOf(toolMsgs[3] && toolMsgs[3].content);
        rec.shotOk = said.includes("渲染成图片");
        // 没截出来时工具回了什么（这一页是浸泡自己写的，没有用户内容）：不留这一句就只知道「没截出来」
        if (!rec.shotOk) rec.shotSaid = said.slice(0, 240);
      }
      return answer(res, stream, fill(`浸泡 ${k} 第 ${n} 轮完成：页面写好了，读回来核对过，目录也列了，文件都在原处。`, 60));
    });
  });

  // ---------- 状态 ----------
  let child = null, exited = null, log = "", finished = false;
  const samples = [];   // SOAK_S
  const phaseAt = [];   // SOAK_PHASE
  const winLines = {};  // SOAK_W by ph
  const rss = [];       // { at, main, renderer, server }
  const pings = [];     // { at, ms }
  const sleeps = [];    // { at, ms } 整台机器停过的时段
  const ctl = [];
  let T0 = null, MID = null, ELD = null, END = null;
  const fails = [];
  let lineBuf = "";
  const timers = [];

  function reap() {
    if (!child || exited) return;
    for (const p of [...tree(psRows(), child.pid), child.pid]) { try { process.kill(p, "SIGKILL"); } catch {} }
  }
  function finish(code) {
    if (finished) return;
    finished = true;
    for (const t of timers) clearInterval(t);
    try { reap(); } catch {}
    try { if (llm.closeAllConnections) llm.closeAllConnections(); llm.close(); } catch {}
    console.log(`\n浸泡：${pass} 过 / ${fail} 挂`);
    process.exitCode = code;
    setTimeout(() => process.exit(code), 50);
  }
  process.on("uncaughtException", (e) => { console.error("❌ 测试自己炸了：", (e && e.stack) || e); fail++; finish(1); });
  process.on("unhandledRejection", (e) => { console.error("❌ 测试自己炸了：", (e && e.stack) || e); fail++; finish(1); });
  process.on("SIGINT", () => { fail++; finish(130); });
  const planMs = P.wins * P.winMs + P.leakMs + P.rssLeakMs + P.busyMs;
  const hardMs = Math.round((planMs + 180000) * 1.5);
  const hardStop = setTimeout(() => {
    console.log(`❌ 跑了 ${Math.round(hardMs / 1000)} 秒还没完，按卡死处理`);
    console.log(log.slice(-2500));
    fail++;
    finish(1);
  }, hardMs);

  const waitFor = async (fn, ms, step = 200) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
    return !!(await fn());
  };
  const cmd = (s) => { try { child.stdin.write(s + "\n"); } catch {} };
  const status = async () => {
    const n = ctl.length;
    cmd("status");
    await waitFor(() => ctl.length > n || exited, 15000, 50);
    return ctl[n] || null;
  };

  function onLine(line) {
    const sp = line.indexOf(" ");
    const tag = sp > 0 ? line.slice(0, sp) : line;
    const body = sp > 0 ? line.slice(sp + 1) : "";
    const k = line.indexOf("OWB_CTL ");
    if (k >= 0) { try { ctl.push(JSON.parse(line.slice(k + 8))); } catch {} return; }
    if (!/^SOAK_/.test(tag)) return;
    let o = null;
    try { o = JSON.parse(body); } catch { return; }
    if (tag === "SOAK_S") samples.push(o);
    else if (tag === "SOAK_PHASE") phaseAt.push(o);
    else if (tag === "SOAK_W") winLines[o.ph] = o;
    else if (tag === "SOAK_T0") T0 = o;
    else if (tag === "SOAK_MID") MID = o;
    else if (tag === "SOAK_ELD") ELD = o;
    else if (tag === "SOAK_END") END = o;
    else if (tag === "SOAK_FAIL") fails.push(o.why);
    else if (tag === "SOAK_LOG") log += "[soak] " + o.why + "\n";
  }

  /**
   * 一段的代表值取上四分位，不取中位数：setInterval 这类数是两档的（正看着的那条在跑时 7 个、刚跑完时 2 个），
   * 2026-09-29 头一版用中位数，一段 12 次里 2 和 7 差不多各半，中位数落哪一档全凭运气，差 5 个就能误判红。
   * 上四分位跟的是「高的那一档」，只要四分之一的时刻在跑就稳；真漏的话高低两档一起抬，照样看得见
   */
  const upperQ = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(0.75 * (s.length - 1))] : null; };
  const pct = (xs, p) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
  const phaseOf = (at) => { let cur = null; for (const p of phaseAt) if (at >= p.at) cur = p.ph; return cur; };
  /** 最小二乘斜率，MB/分钟 */
  function slope(pts) {
    if (pts.length < 3) return null;
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    let sxy = 0, sxx = 0;
    for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); }
    return sxx ? sxy / sxx : null;
  }
  /** 一段的上四分位：DOM、两种计时器、每个 Map；窗口取这一段里的最大值 */
  function summarize(ph) {
    const ss = samples.filter((s) => s.ph === ph);
    const out = { n: ss.length, dom: upperQ(ss.map((s) => s.dom)), to: upperQ(ss.map((s) => s.to)), iv: upperQ(ss.map((s) => s.iv)), maps: {} };
    for (const name of (T0 && T0.maps) || []) out.maps[name] = upperQ(ss.map((s) => (s.maps || {})[name]));
    out.chat = upperQ(ss.map((s) => s.chat));
    out.parts = {};
    for (const name of new Set(ss.flatMap((s) => Object.keys(s.parts || {})))) out.parts[name] = upperQ(ss.map((s) => (s.parts || {})[name] || 0));
    const w = winLines[ph] && winLines[ph].win;
    out.on = w ? w.onMax : null;
    out.off = w ? w.offMax : null;
    out.task = w ? w.taskMax : null;
    return out;
  }
  /** 同一把尺子：b 段比 a 段多出了多少、允许多少 */
  function judge(a, b) {
    const rows = [];
    const row = (key, label, va, vb, tol) => rows.push({ key, label, a: va, b: vb, tol, grew: va !== null && vb !== null && vb - va > tol });
    row("dom", "DOM 节点", a.dom, b.dom, Math.max(40, Math.ceil(a.dom * 0.03)));
    row("iv", "setInterval", a.iv, b.iv, 3);
    row("to", "挂着的 setTimeout", a.to, b.to, Math.max(10, Math.ceil(a.to * 0.3)));
    for (const name of Object.keys(a.maps)) if (a.maps[name] !== null && b.maps[name] !== null) row("map:" + name, name, a.maps[name], b.maps[name], 2);
    row("on", "看得见那类窗口", a.on, b.on, 0);
    rows.push({ key: "off", label: "离屏窗口（任何时刻 ≤ 1）", a: a.off, b: b.off, tol: 1, grew: b.off !== null && b.off > 1 });
    // 任务截图道是串行的，截完 destroy()：同一时刻最多一扇，多出来就是有窗没关
    rows.push({ key: "task", label: "任务截图窗（任何时刻 ≤ 1）", a: a.task, b: b.task, tol: 1, grew: b.task !== null && b.task > 1 });
    return rows;
  }
  const fmtW = (ph, s) => {
    const w = winLines[ph] || {};
    const e = w.mainEld || {}, r = w.rendEld || {};
    const mapSum = Object.values(s.maps).reduce((x, v) => x + (v || 0), 0);
    return `${ph.padEnd(5)} 取数 ${s.n} 次 · DOM ${s.dom} · setTimeout ${s.to} · setInterval ${s.iv} · Map 合计 ${mapSum}（${Object.keys(s.maps).length} 个）· 窗口 ${s.on}+离屏 ${s.off}+截图 ${s.task}`
      + ` · 主进程迟到 p95 ${e.p95}ms/max ${e.max} · 页面迟到 p95 ${r.p95}ms/max ${r.max}（采 ${r.n}）`
      + (w.cdp && w.cdp.JSHeapUsedSize ? ` · 页面堆 ${(w.cdp.JSHeapUsedSize / 1048576).toFixed(1)}MB · 监听 ${w.cdp.JSEventListeners}` : "");
  };

  async function run() {
    const llmPort = await new Promise((r) => llm.listen(0, "127.0.0.1", () => r(llm.address().port)));
    // ---------- 临时家 ----------
    const home = path.join(HOME, "app");
    const data = path.join(home, "data");
    const ws = path.join(home, "workspace");
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(ws, "资料"), { recursive: true });
    fs.writeFileSync(path.join(data, "users.json"), J({
      users: [{ username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
      tokens: { [TOKEN]: { user: "boss", at: Date.now() } },
    }));
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
    const baseUrl = `http://127.0.0.1:${llmPort}/v1`;
    cfg.provider = "openai";
    cfg.openai = { base_url: baseUrl, api_key: "k", model: "mock", stream: true };
    cfg.models = [{ name: "假模型", provider: "openai", base_url: baseUrl, api_key: "k", model: "mock", stream: true }];
    cfg.active_model = "假模型";
    cfg.mcp_servers = [];
    cfg.pet = { enabled: false };
    cfg.agent = { ...(cfg.agent || {}), max_steps: 10, llm_timeout_ms: 180000, llm_retries: 0 };
    cfg.security = { ...(cfg.security || {}), permission_mode: "full" };
    // PORT=0 在环境变量里；config 里再钉一个不是 3800 的口，万一哪条路没吃到环境变量也撞不上用户那台
    cfg.server = { ...(cfg.server || {}), port: 41000 + Math.floor(Math.random() * 20000) };
    fs.writeFileSync(path.join(home, "config.json"), J(cfg));
    // 资料库里放几份现成的：进资料库那一趟有东西可画、可滚
    for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(ws, "资料", `笔记_${String(i).padStart(2, "0")}.md`), `# 笔记 ${i}\n\n浸泡用的现成资料，第 ${i} 份。\n`);
    fs.writeFileSync(path.join(ws, "说明.html"), `<!doctype html><html><head><meta charset="utf-8"><title>说明</title></head><body><h1>现成网页</h1><p>资料库封面拿它出图。</p></body></html>`);
    const bigJpegs = writeBigJpegs(path.join(ws, "照片"), home);
    info(bigJpegs ? `资料库里放了 ${bigJpegs} 张 6000×4000 的 JPEG：缩略图要问主进程缩` : "这台机器没有 sips，不放大图（JPEG 缩略图那条路只在 macOS 上量）");

    const env = {
      ...process.env,
      OPENWORKBUDDY_HOME: home,
      OPENWORKBUDDY_DATA_DIR: data,
      OWB_SHELL_HIDDEN: "1",
      OWB_USER_DATA_DIR: path.join(home, "userdata"),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      OWB_CDP_NO_LAUNCH: "1",
      PORT: "0",
      HOST: "127.0.0.1",
      OWB_SOAK_CHILD: "1",
      OWB_SOAK_PLAN: J({ ...P, token: TOKEN }),
      // 卡顿记录的门槛压到 100ms：验收线就是「界面线程最长一口 < 100ms」，超过的每一次都要留下当时桥上的活名
      OWB_MAIN_STALL_MS: "100",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    // 要点名到函数时：OWB_SOAK_PROFILE=要写的 .cpuprofile 路径，交给 electron-main 的主进程 CPU 采样
    if (process.env.OWB_SOAK_PROFILE) env.OWB_MAIN_PROFILE = process.env.OWB_SOAK_PROFILE;
    // 让出 CPU：跑 90 秒到 10 分钟的重活，别和人手上正在用的东西抢
    const nice = ["/usr/bin/nice", "/bin/nice"].find((p) => fs.existsSync(p));
    const argv = [electronBin, __filename];
    child = nice ? cp.spawn(nice, ["-n", "10", ...argv], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] })
      : cp.spawn(argv[0], argv.slice(1), { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (d) => {
      const s = String(d);
      lineBuf += s;
      for (let i = lineBuf.indexOf("\n"); i >= 0; i = lineBuf.indexOf("\n")) {
        const line = lineBuf.slice(0, i);
        lineBuf = lineBuf.slice(i + 1);
        if (!/^SOAK_S /.test(line)) log += line + "\n";
        onLine(line);
      }
      if (log.length > 400000) log = log.slice(-200000);
    });
    child.stderr.on("data", (d) => { log += String(d); if (log.length > 400000) log = log.slice(-200000); });
    child.stdin.on("error", () => {});
    child.on("exit", (code, sig) => { exited = { code, sig }; });

    console.log(`浸泡（${P.local ? "本机档" : "CI 档"}）：${CHATS} 个对话同时跑，${P.wins} 段 × ${Math.round(P.winMs / 1000)} 秒，`
      + `之后原地漏 ${Math.round(P.leakMs / 1000)} 秒${P.local ? `、攥内存 ${Math.round(P.rssLeakMs / 1000)} 秒、忙等 ${Math.round(P.busyMs / 1000)} 秒` : ""}`);
    const booted = await waitFor(() => T0 || fails.length || exited, 180000, 200);
    if (!booted || !T0) {
      ok(false, "起来了：页面登录上、计时器记账补丁进了页面", { fails, exited, tail: log.slice(-1500) });
      return finish(1);
    }
    const st = await status();
    const serverPid = (st && st.serverPid) || T0.pids.server;
    const lp = listenerPid(T0.port);
    ok(serverPid > 0 && lp === serverPid && serverPid !== T0.pids.main && T0.pids.renderer > 0,
      `起来了：服务端在独立进程 ${serverPid}（端口 ${T0.port} 由它在听），页面进程 ${T0.pids.renderer}，主进程 ${T0.pids.main}`, { st, lp, pids: T0.pids });
    info(`够得着的页面 Map/Set ${T0.maps.length} 个；够不着的 ${T0.unreachable.length} 个（没加载的脚本里的）：${T0.unreachable.join(", ") || "无"}`);
    info(`页面 requestAnimationFrame ${T0.rafOk ? "在跑" : "没跑（隐藏窗口不出帧）"}`);
    const pids = { main: T0.pids.main, renderer: T0.pids.renderer, server: serverPid };

    // RSS 每秒一次（上一次还没回来就跳过这一拍）；服务端 /api/info 每秒一次（只报数）；
    // 每 30 秒清一次 electron-main 自带的迟到采样，免得它自己把主进程量涨
    let rssBusy = false;
    timers.push(setInterval(() => {
      if (rssBusy) return;
      rssBusy = true;
      const at = Date.now();
      rssOf(Object.values(pids), (r) => {
        rssBusy = false;
        rss.push({ at, main: r[pids.main] ?? null, renderer: r[pids.renderer] ?? null, server: r[pids.server] ?? null });
      });
    }, 1000));
    // 机器睡过没有：驱动自己这一秒一拍的计时器隔了 5 秒以上才回来，就是整台机器停过（合盖、休眠）。
    // 停过的那一趟，迟到和内存的数都不作数，照实说出来
    let beat = Date.now();
    timers.push(setInterval(() => {
      const t = Date.now();
      if (t - beat > 5000) sleeps.push({ at: beat, ms: t - beat });
      beat = t;
    }, 1000));
    timers.push(setInterval(() => {
      const t = Date.now();
      const rq = http.get({ host: "127.0.0.1", port: T0.port, path: "/api/info", timeout: 5000, headers: { Cookie: "openworkbuddy_token=" + TOKEN } }, (r) => {
        r.resume();
        r.on("end", () => pings.push({ at: t, ms: Date.now() - t }));
      });
      rq.on("timeout", () => rq.destroy(new Error("timeout")));
      rq.on("error", () => pings.push({ at: t, ms: 5000 }));
    }, 1000));
    timers.push(setInterval(() => cmd("lag-reset"), 30000));

    await waitFor(() => END || fails.length || exited, planMs + 240000, 500);
    for (const t of timers) clearInterval(t);
    // 查问题用：把每一次取数原样落盘（不设就不写）
    // 主进程那边的账：缩图三件活走了哪条路（pixels）、网页截图 PNG 在哪儿编的（shot）
    const stEnd = END && !exited ? await status() : null;
    if (process.env.OWB_SOAK_DUMP) {
      try { fs.writeFileSync(process.env.OWB_SOAK_DUMP, J({ plan: P, T0, MID, ELD, END, stEnd, llmStat, sleeps, phaseAt, winLines, samples, rss, pings })); } catch (e) { info("落盘失败：" + e.message); }
    }
    if (fails.length || !END || END.err) {
      ok(false, "浸泡跑完", { fails, end: END, exited, tail: log.slice(-2000) });
      return finish(1);
    }

    // ---------- 负载本身 ----------
    console.log("\n负载");
    const secs = (P.wins * P.winMs + P.leakMs + P.rssLeakMs + P.busyMs) / 1000;
    const MIN = Math.max(3, Math.floor(secs / 15));
    const bad = [];
    const maxWrite = new Array(CHATS).fill(0);
    for (let k = 0; k < CHATS; k++) {
      for (let n = 1; n <= END.done[k]; n++) {
        const rec = turns.get(k + ":" + n);
        const need = rec && rec.shot ? [0, 1, 2, 3, 4] : [0, 1, 2, 3];
        if (!rec || need.some((s) => !rec.steps.has(s)) || rec.readBack !== true || (rec.shot && rec.shotOk !== true)) {
          bad.push({ k, n, steps: rec ? [...rec.steps] : [], readBack: rec && rec.readBack, ...(rec && rec.shot ? { shotOk: rec.shotOk, shotSaid: rec.shotSaid } : {}), page: (END.diag || {})[k + ":" + n] || null });
        }
        if (rec && rec.steps.has(0)) maxWrite[k] = n;
      }
    }
    const shots = [...turns.values()].filter((r) => r.shot);
    ok(END.done.every((d) => d >= MIN), `五个对话各跑满 ≥ ${MIN} 轮：${END.done.join(" / ")}`, END.done);
    ok(!bad.length && !END.errs.length && !END.fast, `每一轮都走完 写网页 → 读回来（内容对得上）→ 列目录 →（每 3 轮截一张图，${shots.length} 张）→ 收尾，页面上没有报错`,
      { bad: bad.slice(0, 8), errs: END.errs.slice(0, 5), fast: END.fast });
    // 没走完的那几轮，页面那一侧和假模型那一侧各看到了什么，逐条打出来（只有轮次和状态，没有内容）
    for (const b of bad.slice(0, 5)) info(`没走完的 ${b.k}:${b.n}：假模型见到的步 [${b.steps.join(",")}]，页面这一侧 ${J(b.page)}${b.shotSaid ? `，截图工具回的是「${b.shotSaid}」` : ""}`);
    if (bad.length && llmStat.otherKeys.length) info(`认得出轮次、却没带工具的调用：${J(llmStat.otherKeys.slice(0, 10))}`);
    const diag = END.diag || {};
    const odd = Object.entries(diag).filter(([, a]) => a.some((x) => x !== "chat:200" && !/^ms:/.test(x)));
    info(`页面那一侧：${Object.keys(diag).length} 轮有记录，其中 ${odd.length} 轮不是一次 200 就完事（撞 409、插话、报错、排队）`
      + (odd.length ? "：" + odd.slice(0, 6).map(([key, a]) => key + " " + a.filter((x) => !/^ms:/.test(x)).join("/")).join("；") : ""));
    info(`假模型被叫 ${llmStat.calls} 次（其中不带工具的 ${llmStat.other} 次，同一步重叫 ${llmStat.extra} 次）`);
    const found = [];
    const walk = (dir, depth) => {
      if (depth > 5) return;
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, depth + 1); }
        else if (/^soak_\d\.html$/.test(e.name)) found.push(p);
      }
    };
    walk(ws, 0);
    const fileOk = [];
    for (let k = 0; k < CHATS; k++) {
      const hits = found.filter((p) => path.basename(p) === `soak_${k}.html`);
      fileOk.push(hits.length === 1 && fs.readFileSync(hits[0], "utf8").includes(`浸泡 ${k} 第 ${maxWrite[k]} 轮`));
    }
    ok(fileOk.every(Boolean), "每个对话的网页只有一份，写的是它最后一轮", { found: found.map((p) => path.relative(ws, p)), maxWrite });

    // ---------- 半路：资料库 + 菜单 ----------
    console.log("\n半路：进一趟资料库、开关侧栏和菜单");
    const lib = (MID && MID.lib) || {};
    const menus = (MID && MID.menus) || {};
    ok(lib.shown && lib.back, `进了资料库（${lib.texts} 字）、滚了 ${lib.scrollers} 个能滚的（${lib.bottom} 个到底）、回到对话`, MID);
    ok(lib.scrollers >= 1 && lib.bottom >= 1, "资料库里至少有一处真滚到了底", lib);
    ok(menus.sideMoved && menus.sideBack && menus.slashShown && menus.slashGone,
      `菜单：${(menus.did || []).join("、")}——侧栏开关回原样、打「/」弹出技能菜单、Esc 后收起`, menus);

    // ---------- 稳态 ----------
    const phs = Array.from({ length: P.wins }, (_, i) => "w" + (i + 1));
    const S = {};
    for (const ph of [...phs, "leak"]) S[ph] = summarize(ph);
    console.log("\n每段的数（上四分位；窗口取段内最大）");
    for (const ph of [...phs, "leak"]) console.log("  " + fmtW(ph, S[ph]));
    const A = phs[phs.length - 2], B = phs[phs.length - 1];
    console.log(`\n稳态：第 ${A.slice(1)} 段 → 第 ${B.slice(1)} 段不许涨`);
    ok(S[A].n >= 5 && S[B].n >= 5, `两段各取到 ≥ 5 次数（${S[A].n} / ${S[B].n}）`);
    const steady = judge(S[A], S[B]);
    // 离屏窗口「任何时刻 ≤ 1」管的是整场，不只最后一段：资料库那一趟就在前面几段里
    const offRow = steady.find((r) => r.key === "off");
    const offAll = Math.max(...phs.map((ph) => (S[ph].off === null ? 0 : S[ph].off)));
    offRow.label = "离屏窗口（整场任何时刻 ≤ 1）";
    offRow.b = offAll;
    offRow.grew = offAll > 1;
    const taskRow = steady.find((r) => r.key === "task");
    const taskAll = Math.max(...phs.map((ph) => (S[ph].task === null ? 0 : S[ph].task)));
    taskRow.label = "任务截图窗（整场任何时刻 ≤ 1）";
    taskRow.b = taskAll;
    taskRow.grew = taskAll > 1;
    const groups = [["dom", "DOM 节点数"], ["iv", "setInterval 个数"], ["to", "挂着的 setTimeout 个数"], ["map", "页面顶层 Map/Set 条数"], ["on", "看得见那类窗口数"], ["off", "离屏窗口数"], ["task", "任务截图窗数"]];
    for (const [g, label] of groups) {
      const rows = steady.filter((r) => r.key === g || r.key.startsWith(g + ":"));
      const grew = rows.filter((r) => r.grew);
      const shown = g === "map" ? `${rows.length} 个，涨了的 ${grew.length} 个`
        : g === "off" ? `最多 ${offAll} 扇`
        : g === "task" ? `最多 ${taskAll} 扇`
        : rows.map((r) => `${r.a} → ${r.b}（允许 +${r.tol}）`).join("");
      const where = g === "dom" && grew.length
        ? { chat: [S[A].chat, S[B].chat], parts: Object.keys(S[B].parts).filter((k) => (S[B].parts[k] || 0) - (S[A].parts[k] || 0) > 10).map((k) => `${k} ${S[A].parts[k] || 0}→${S[B].parts[k]}`) }
        : null;
      ok(rows.length > 0 && !grew.length, `${label}：${shown}`, where ? { grew, where } : grew);
    }

    // ---------- ★反向对照★ ----------
    console.log(`\n★反向对照★ 原地漏 ${Math.round(P.leakMs / 1000)} 秒（每 0.5 秒塞一把节点、1 个 setInterval、5 个 setTimeout、一条 ${T0.leakTarget || "(没有 Map)"}；主进程多开 2 扇离屏 + 1 扇隐藏窗）`);
    // 「漏」那一段只剩一两次取数，上四分位就是那一两次里挑一个，判红判不红全凭哪一次落在半截对话上
    ok(S.leak.n >= 3, `「漏」这一段取到 ≥ 3 次数（${S.leak.n}）`, S.leak.n);
    const leak = judge(S[B], S.leak);
    // 截图窗那一行不进反向对照：漏的那 15 秒不截图，浸泡自己多开的窗也不走截图道
    for (const [g, label] of groups.filter(([g]) => g !== "task")) {
      const rows = leak.filter((r) => r.key === g || (g === "map" && r.key === "map:" + T0.leakTarget));
      const shown = rows.map((r) => `${r.a} → ${r.b}`).join("");
      ok(rows.length > 0 && rows.every((r) => r.grew), `★反向对照★ 同一把尺子判红——${label}：${shown}`, rows);
    }

    // ---------- 数 ----------
    const inPh = (list, keys) => list.filter((x) => keys.includes(phaseOf(x.at)));
    const tailKeys = [A, B];
    const rssTail = inPh(rss, tailKeys);
    const slopes = {};
    for (const k of ["main", "renderer", "server"]) slopes[k] = slope(rssTail.filter((r) => r[k] !== null).map((r) => [r.at / 60000, r[k]]));
    const sumTail = slope(rssTail.filter((r) => r.main !== null && r.renderer !== null && r.server !== null).map((r) => [r.at / 60000, r.main + r.renderer + r.server]));
    const last = rss[rss.length - 1] || {};
    const f1 = (v) => (v === null || v === undefined ? "?" : v.toFixed(2));
    console.log(`\n内存（最后 ${tailKeys.length} 段，${rssTail.length} 个点）：RSS 斜率 主进程 ${f1(slopes.main)} · 页面 ${f1(slopes.renderer)} · 服务端 ${f1(slopes.server)} · 合计 ${f1(sumTail)} MB/分钟`
      + `；收尾时 RSS 主进程 ${f1(last.main)} · 页面 ${f1(last.renderer)} · 服务端 ${f1(last.server)} MB`);
    const tailPing = inPh(pings, tailKeys).map((p) => p.ms);
    const te = (ELD && ELD.tail) || {};
    console.log(`事件循环迟到（最后 ${tailKeys.length} 段）：主进程 p95 ${te.main && te.main.p95}ms / p99 ${te.main && te.main.p99} / max ${te.main && te.main.max}`
      + ` · 页面 p95 ${te.rend && te.rend.p95}ms / p99 ${te.rend && te.rend.p99} / max ${te.rend && te.rend.max}（采 ${te.rend && te.rend.n} 次）`
      + ` · 服务端 /api/info 往返 p50 ${pct(tailPing, 0.5)}ms / p95 ${pct(tailPing, 0.95)}ms（只报数）`);
    const slept = (ELD && ELD.all && ELD.all.slept) || { n: 0, ms: 0 };
    if (sleeps.length || slept.n) {
      info(`这一趟机器停过（合盖/休眠）：驱动这边 ${sleeps.length} 次共 ${Math.round(sleeps.reduce((x, s) => x + s.ms, 0) / 1000)} 秒，`
        + `主进程那边 ${slept.n} 拍共 ${Math.round(slept.ms / 1000)} 秒没进迟到。醒来后几十秒 CPU 还被系统压着，这一趟的迟到和内存数不作数`);
    }

    // ---------- 界面线程：多开对话 + 资料库一起跑时，主进程上都干了什么 ----------
    // 2026-09-29 量过：资料库里一张 6000×4000 的 JPEG 在主进程 nativeImage 缩图卡界面线程 145–181ms，
    // 一张 1242×1656 的截图在主进程 toPNG 卡 255–271ms。这两件现在都挪出去了，这里数的是「走了哪条路」，
    // 不数毫秒（毫秒随机器负载走，判不稳）；毫秒照实打出来，验收看三趟的中位数
    console.log("\n界面线程（主进程）");
    const ea = (ELD && ELD.all && ELD.all.main) || {};
    const le = (MID && MID.libEld) || {};
    const imgs = lib.imgs || {};
    const px = stEnd ? stEnd.pixels : null;
    const sh = (stEnd && stEnd.shot) || (ELD && ELD.shot) || {};
    const stl = (ELD && ELD.stall) || null;
    const opsAll = (stEnd && stEnd.ops) || (ELD && ELD.ops) || {};
    const opLine = (name) => { const o = opsAll[name]; return o ? `${name} ${o.n} 次，同步段最长 ${Math.round(o.syncMax)}ms（>50ms ${o.over50} 次、>100ms ${o.over100} 次）` : `${name} 没来过`; };
    console.log(`  ${phs.length} 段迟到 p50 ${ea.p50}ms / p95 ${ea.p95} / p99 ${ea.p99} / max ${ea.max}（采 ${ea.n} 次）· 资料库那一趟 p95 ${le.p95}ms / max ${le.max}（采 ${le.n} 次）`);
    if (stl) {
      const inW = stl.list.filter((s) => /^w\d+$/.test(phaseOf(s.at) || ""));
      console.log(`  卡顿记录（迟到 ≥ 100ms）：整场 ${stl.counts.stalls} 次、最长 ${stl.max}ms；落在 ${phs.length} 段里的 ${inW.length} 次（只留最近 ${stl.list.length} 条）`);
      for (const s of stl.list.slice().sort((x, y) => y.ms - x.ms).slice(0, 8)) {
        console.log(`    ${phaseOf(s.at) || "开机"} ${s.ms}ms · 那会儿桥上：${Object.entries(s.ops).map(([k, n]) => (n > 1 ? k + "×" + n : k)).join("、") || "没有活"}`);
      }
    } else console.log("  卡顿记录：没拿到（electron-main 没挂 __owbMainStall）");
    console.log(`  桥上的活：${opLine("image.thumb")} · ${opLine("shot.html")}`);
    console.log(`  缩图：${px ? `sips ${px.ok}/${px.runs} 次成功、退回主进程 ${px.fallbacks} 次、最多同时 ${px.peak} 个` : "在主进程 nativeImage 上缩"}`
      + `；资料库页上的缩略图 ${imgs.n} 张（出来 ${imgs.loaded}、坏 ${imgs.broken}）`);
    console.log(`  截图：任务 ${sh.task} 张 · PNG 交给线程编 ${sh.pngOff} 张 · 在界面线程上编 ${sh.pngSync} 张`);
    if (bigJpegs) {
      const th = opsAll["image.thumb"];
      ok(!!th && th.n >= 1, `资料库那一趟真问主进程缩了大 JPEG：image.thumb ${th ? th.n : 0} 次`, { ops: th, imgs });
      ok(!!px && px.ok >= 1 && px.fallbacks === 0, `大 JPEG 缩图全交给 sips，没有一张落回界面线程：${px ? `sips 成功 ${px.ok} 次、退回 ${px.fallbacks} 次` : "没走 sips"}`, px);
    }
    const shotsOk = shots.filter((r) => r.shotOk === true).length;
    ok(shotsOk >= 1 && sh.task >= shotsOk, `html_to_image 截出 ${shotsOk} 张（假模型点了 ${shots.length} 次；htmlshot 任务道记 ${sh.task} 张）`, { shots: shots.length, shotsOk, sh });
    ok(sh.pngOff >= 1 && sh.pngSync === 0, `截图的 PNG 全在线程里编，界面线程上一张没编：线程 ${sh.pngOff} 张 · 界面线程 ${sh.pngSync} 张`, sh);

    if (P.local) {
      console.log("\n本机档");
      ok(sumTail !== null && sumTail < 1, `最后 ${Math.round((tailKeys.length * P.winMs) / 60000)} 分钟 main + renderer + server 的 RSS 斜率合计 < 1MB/分钟：${f1(sumTail)}`, { slopes, sumTail, n: rssTail.length });
      const rssLeak = inPh(rss, ["rss"]).filter((r) => r.main !== null && r.renderer !== null && r.server !== null).map((r) => [r.at / 60000, r.main + r.renderer + r.server]);
      const leakSlope = slope(rssLeak);
      ok(leakSlope !== null && leakSlope > 1, `★反向对照★ 页面每 10 秒攥住 6MB：同一个斜率判红：${f1(leakSlope)} MB/分钟（${rssLeak.length} 个点`
        + `${rssLeak.length < 3 ? "，三个进程都读到数的不到 3 次，算不出斜率" : ""}）`, { leakSlope, n: rssLeak.length });
      ok(te.main && te.main.p95 !== null && te.main.p95 < 30, `主进程事件循环迟到 p95 < 30ms：${te.main && te.main.p95}ms`, te.main);
      ok(te.rend && te.rend.p95 !== null && te.rend.p95 < 30, `页面事件循环迟到 p95 < 30ms：${te.rend && te.rend.p95}ms`, te.rend);
      const be = (ELD && ELD.busy) || {};
      ok(be.main && be.main.p95 >= 30, `★反向对照★ 主进程每 60ms 忙等 45ms：p95 ${be.main && be.main.p95}ms，判红`, be.main);
      ok(be.rend && be.rend.p95 >= 30, `★反向对照★ 页面每 60ms 忙等 45ms：p95 ${be.rend && be.rend.p95}ms，判红`, be.rend);
    }

    // ---------- 退出 ----------
    console.log("\n退出");
    const before = tree(psRows(), child.pid);
    cmd("quit");
    const quitOk = await waitFor(() => exited, 30000, 100);
    ok(quitOk, `发 quit 以后 30 秒内退干净（退出码 ${exited && exited.code}）`, { exited, tail: log.slice(-800) });
    const left = await waitFor(() => before.every((p) => !alive(p)), 10000, 200);
    ok(left, `进程树一个不剩（退出前 ${before.length} 个子进程）`, before.filter(alive));
    clearTimeout(hardStop);
    return finish(fail ? 1 : 0);
  }
  run().catch((e) => { console.error("❌ 测试自己炸了：", (e && e.stack) || e); fail++; finish(1); });
}

if (process.versions.electron) {
  if (process.env.OWB_SOAK_CHILD === "1") childMain();
  else {
    console.error("这个套件得用 node 跑：node test/soak-multichat.js（它自己再拉 Electron）");
    process.exit(1);
  }
} else driverMain();
