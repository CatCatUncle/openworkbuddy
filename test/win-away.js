// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 桌面窗口收起来就降频、停动画，拿回来就恢复（win-away.js）。
 *
 * 跑法：./node_modules/.bin/electron test/win-away.js（被 node 拉起时自己换成 electron 再跑一遍）
 *
 * 2026-09-28 实测：以前 backgroundThrottling 写死 false，窗口藏起来界面照样按 120Hz 在画，
 * document.hidden 永远是 false，「你不在时跑完了」的通知一次都没弹过。
 *
 * 窗口一律不亮：show:false、摆在屏幕外、不 show / focus。收起、最小化、拿回来这几下用 emit 模拟，
 * isVisible / isMinimized 在实例上换成假的——要验的是「接线对不对、页面上真停没停」，不是 macOS 的窗口管理。
 * 每条正向断言都配一条反向对照：没挂 throttleWhenAway 的窗口收起来什么都不变。
 */
const { mod } = require("./lib/mod");
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron（纯服务端部署没有桌面窗口）");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 120000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const path = require("path");
const http = require("http");
const { app, BrowserWindow } = require("electron");
const { throttleWhenAway } = require(mod("win-away"));

// 离屏窗口看不见，但 macOS 照样往程序坞塞一个跳动的图标
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
let pass = 0, fail = 0;
const ok = (v, m, extra) => { if (v) pass++; else { fail++; console.error("  ❌", m, extra === undefined ? "" : "\n     " + extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面上的停动画规则直接从 index.html 里抠：有人把那条删了，下面「动画停住」那几条当场红。
// 路径分两段写：e2e 的 3.5 把「有 loadURL、又出现斜杠加页面名」的测试当成开了真页面、要求钉语言，
// 这里只是把 index.html 当源码读一条 CSS，窗口里开的是下面那张自己拼的页，没有一个字要翻译
// （2026-09-29 整套跑时就被它当成「开了真页面没钉语言」拦下过）
const AWAY_RULE = (src(path.join("public", "index.html")).match(/body\.owb-away \*[^{]*\{[^}]*animation-play-state:\s*paused[^}]*\}/) || [""])[0];

const PAGE = `<!doctype html><meta charset="utf-8"><style>
@keyframes spin { to { transform: rotate(360deg); } }
.spinner { width: 20px; height: 20px; animation: spin 1s linear infinite; }
${AWAY_RULE}
</style><body><div class="spinner" id="sp"></div><script>
  window.chunks = 0;
  (async () => {
    const r = await fetch("/stream");
    const rd = r.body.getReader();
    for (;;) { const { done } = await rd.read(); if (done) break; window.chunks++; }
  })();
</script></body>`;

const srv = http.createServer((req, res) => {
  if (req.url === "/stream") {
    // 假的流式回报：每 40ms 一段，一直发到连接断
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    const t = setInterval(() => res.write("x\n"), 40);
    req.on("close", () => clearInterval(t));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

/** 屏幕外、不亮、不抢焦点的窗口，isVisible / isMinimized 换成可控的假值 */
function hiddenWin(port) {
  const w = new BrowserWindow({ x: -20000, y: -20000, width: 320, height: 240, show: false, webPreferences: { backgroundThrottling: false } });
  const st = { visible: true, minimized: false };
  w.isVisible = () => st.visible;
  w.isMinimized = () => st.minimized;
  return { w, st, load: () => w.loadURL(`http://127.0.0.1:${port}/`) };
}
const q = (w, js) => w.webContents.executeJavaScript(js);
const away = (w) => q(w, `document.body.classList.contains("owb-away")`);
const play = (w) => q(w, `(document.getElementById("sp").getAnimations()[0] || {}).playState || ""`);
/** executeJavaScript 挂类名是异步的：等一小会儿 */
async function until(fn, want, ms = 1500) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v === want) return v; await sleep(30); }
  return v;
}

app.whenReady().then(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const wins = [];
  try {
    console.log("【1】停动画的规则还在 index.html 里");
    ok(!!AWAY_RULE, "index.html 要有 body.owb-away 停动画那条规则（animation-play-state: paused）");

    const A = hiddenWin(port); wins.push(A.w);
    const ctl = throttleWhenAway(A.w);
    await A.load();
    const B = hiddenWin(port); wins.push(B.w); // 反向对照：不挂 throttleWhenAway
    await B.load();
    await sleep(200);

    console.log("【2】刚打开：不降频、不挂类名、动画在转");
    ok(A.w.webContents.getBackgroundThrottling() === false, "看得见的窗口不降频");
    ok((await away(A.w)) === false && (await play(A.w)) === "running", "  └ 没挂 owb-away，动画在转");

    console.log("【3】收起来（hide）：降频、挂类名、动画停住，流式回报照样到");
    A.st.visible = false; A.w.emit("hide");
    B.st.visible = false; B.w.emit("hide");
    ok(A.w.webContents.getBackgroundThrottling() === true, "收起来就打开降频");
    ok(ctl.isAway() === true, "  └ isAway() 跟着变");
    ok((await until(() => away(A.w), true)) === true, "  └ 页面 body 上挂上 owb-away");
    ok((await until(() => play(A.w), "paused")) === "paused", "  └ 无限循环的动画停住", await play(A.w));
    const c0 = await q(A.w, "chunks");
    await sleep(600);
    const c1 = await q(A.w, "chunks");
    ok(c1 - c0 >= 5, "  └ 收起来以后流式回报照样一段段到（fetch 读流不靠计时器）", `${c0} → ${c1}`);
    ok(B.w.webContents.getBackgroundThrottling() === false, "没挂的窗口收起来：还是不降频（反向对照）");
    ok((await away(B.w)) === false && (await play(B.w)) === "running", "  └ 也没类名、动画照转（反向对照）");

    console.log("【4】藏着的时候页面重载：新页面上补挂类名");
    await A.load();
    ok((await until(() => away(A.w), true)) === true, "重载完补上 owb-away");

    console.log("【5】拿回来（show）：关掉降频、摘类名、动画接着转");
    A.st.visible = true; A.w.emit("show");
    ok(A.w.webContents.getBackgroundThrottling() === false, "拿回来就关掉降频");
    ok((await until(() => away(A.w), false)) === false, "  └ 摘掉 owb-away");
    ok((await until(() => play(A.w), "running")) === "running", "  └ 动画接着转");
    await A.load();
    await sleep(300);
    ok((await away(A.w)) === false, "看得见时重载：不挂类名（反向对照）");

    console.log("【6】最小化 / 还原");
    A.st.minimized = true; A.w.emit("minimize");
    ok(A.w.webContents.getBackgroundThrottling() === true && ctl.isAway(), "最小化也算收起来");
    A.w.emit("show");
    ok(A.w.webContents.getBackgroundThrottling() === true && ctl.isAway(), "  └ 还最小化着的时候来一下 show：不算回来（反向对照）");
    A.st.minimized = false; A.st.visible = false; A.w.emit("restore");
    ok(ctl.isAway(), "  └ 还原了但窗口还藏着：不算回来（反向对照）");
    A.st.visible = true; A.w.emit("restore");
    ok(A.w.webContents.getBackgroundThrottling() === false && !ctl.isAway(), "  └ 还原且看得见：回来了");
    ok((await until(() => away(A.w), false)) === false, "  └ 类名也摘了");

    console.log("【7】主进程真接上了");
    const main = src("electron-main.js");
    const hook = /throttleWhenAway\(win\b/;
    const child = /throttleWhenAway\(child\)/;
    ok(new RegExp(`require\\(${JSON.stringify(mod.spec("electron-main", "win-away")).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\)`).test(main) && hook.test(main), "主窗口挂上 throttleWhenAway");
    ok(child.test(main), "站内链接开的子窗口也挂上");
    ok(!hook.test(main.replace(/throttleWhenAway\(win\b/g, "x(")), "  └ 这条检查自己会红（反向对照）");
    const sw = main.indexOf('appendSwitch("disable-features", "IntensiveWakeUpThrottling")');
    const ready = main.indexOf("app.whenReady()");
    ok(sw > 0 && sw < ready, "关掉「藏满 5 分钟后一分钟才醒一次」：开关写在 ready 之前", `${sw} / ${ready}`);
    ok(!/webPreferences:\s*\{\s*backgroundThrottling:\s*false\s*\}\s*,?\s*\}\);\s*child\.webContents/.test(main), "子窗口建完紧跟着就挂 throttleWhenAway，不是光写一个 false 就完事");
  } catch (e) {
    fail++;
    console.error("  ❌ 套件自己抛了：", (e && e.stack) || e);
  } finally {
    for (const w of wins) { try { w.destroy(); } catch {} }
    srv.close();
  }
  console.log(`\n${fail === 0 ? "√" : "×"} win-away：${pass} 条通过，${fail} 条失败`);
  app.exit(fail === 0 ? 0 : 1);
  process.exitCode = fail === 0 ? 0 : 1;
});
