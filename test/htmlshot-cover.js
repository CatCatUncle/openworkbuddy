// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 网页封面（htmlshot.js 的封面道）：资料库给工作区里的 html 出封面，一个老账号 285 个 html。
 *
 * 跑法：node test/htmlshot-cover.js（先在纯 node 里验「没窗口就不出」，再自己换成 Electron 验其余的）
 *
 * 要守住的几件事，每条都配了★反向对照★：
 *   - 连截两张只开 1 个窗口（任务道同样两张开 2 个）；截完落回空白页、静音、分区不落盘；
 *   - 全程没有一个窗口可见、没有一个抢到焦点、全是离屏窗口；macOS 上前台应用一次都没变成测试进程；
 *   - 页面调朗读：换成了什么都不念、但会报「念完了」的替身（普通窗口里是原生的，测试页见了原生的就不调）；
 *   - alert / confirm / prompt 不卡、window.close() 关不掉这个复用的窗口（普通窗口里真会被关掉）；
 *   - 死循环页面 5 秒报 SHOT_TIMEOUT、渲染进程被掐掉，下一单照常出图；
 *   - 页面要外网脚本 / 图片 / fetch / WebSocket / 信标：假服务器一个请求都收不到（任务道同一页收得到）；
 *   - 读 html 所在目录以外的本地文件、链接指出去的文件：拦（同目录的照读）；页面自己跳转：不跳；
 *   - 永远加载不完的页面到点报超时，下一单照常；
 *   - 截完带无限 CSS 动画的页面，之后 5 秒 0 次重画（普通离屏窗口 1 秒就画几十次）；
 *   - 任务道插到排着的封面前面（都排封面道时按先来后到）；
 *   - 空闲到点关窗：窗口数回到基线，那个渲染进程从进程表里消失；
 *   - 服务进程里（utilityProcess 过桥）照样只开 1 个窗口，超时的错误码原样过桥；主进程开不了窗口时不发一趟桥。
 *
 * 朗读、弹框的反向对照从不真调原生的：测试页先看函数是不是 [native code]，是就只报告、不调用——
 * 无头窗口调原生朗读会真从扬声器里念出来。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 400))); }
};
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m, { 实际: a, 期望: b });
const errOf = (p) => p.then(() => null, (e) => e || new Error("空错误"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.versions.electron) {
  nodePhase().then(() => {
    // 离屏窗口只有 Electron 里才有：纯 node 那一段验完，自己换一身皮再跑一遍；没装 electron 就只算纯 node 那段
    let bin = null;
    try { bin = require("electron"); } catch {}
    if (typeof bin !== "string" || !fs.existsSync(bin)) {
      console.log("\n跳过 Electron 那段：没装 electron（纯服务端部署本来就不出网页封面）");
      console.log(`\n${pass} 通过，${fail} 失败`);
      process.exit(fail ? 1 : 0);
    }
    console.log(`\n纯 node 段：${pass} 通过，${fail} 失败。换成 Electron 接着跑……`);
    const r = require("child_process").spawnSync(bin, [__filename], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      timeout: 300000, killSignal: "SIGKILL",
    });
    process.exit(fail ? 1 : (r.status == null ? 1 : r.status));
  }).catch((e) => { console.error(e); process.exit(1); });
} else {
  electronPhase();
}

// ── 纯 node：没有可复用的窗口，封面道直接拒，绝不为一张封面拉一个 Chrome ─────────────────

async function nodePhase() {
  console.log("【0】纯 node（npm start / 命令行）：封面道直接拒，一个 Chrome 都不拉");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-htmlshot-cover-node-"));
  process.env.OPENWORKBUDDY_HOME = tmp;
  delete process.env.OWB_MOTION_BACKEND;
  delete process.env.OWB_BRIDGE;
  try {
    const cdp = require(mod("cdp"));
    let spawns = 0;
    cdp.findChrome = () => "/fake/chrome";
    cdp.spawnIsolated = async () => { spawns++; throw new Error("假 Chrome：只记一笔，不真起"); };
    const H = require(mod("htmlshot"));
    const html = path.join(tmp, "a.html");
    fs.writeFileSync(html, "<body>x</body>");
    eq(H.shotAvailable().backend, "chrome", "本机有 Chrome 时 shotAvailable 选 chrome（任务道还能出片头卡）");
    ok(H.coverAvailable() === false, "coverAvailable()：false（只认 Electron）");
    const e1 = await errOf(H.renderHtmlToPngAny(html, { width: 1280, height: 800, lane: "cover", timeoutMs: 5000 }));
    ok(e1 && e1.code === H.NO_RENDERER && /桌面版/.test(e1.message) && spawns === 0, "封面道：NO_RENDERER，一次 Chrome 都没拉", { code: e1 && e1.code, msg: e1 && e1.message, spawns });
    const e2 = await errOf(H.renderHtmlToPngAny(html, { width: 300, height: 200 }));
    ok(spawns === 1 && e2 && /假 Chrome/.test(e2.message), "★反向对照★ 同一张走任务道：真去拉了一次 Chrome", { spawns, msg: e2 && e2.message });
    const e3 = await errOf(H.renderHtmlToPng(html, { lane: "cover" }));
    ok(e3 && e3.code === H.NO_RENDERER && /npm run app/.test(e3.message) && spawns === 1, "老入口 renderHtmlToPng：纯 node 照旧报「需要桌面版」", e3 && e3.message);
    cdp.findChrome = () => "";
    const e4 = await errOf(H.renderHtmlToPngAny(html, { lane: "cover" }));
    ok(e4 && e4.code === H.NO_RENDERER && spawns === 1, "连 Chrome 都没有：封面道一样是 NO_RENDERER（不是别的错）", e4 && e4.code);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Electron ─────────────────────────────────────────────────────────────────

function electronPhase() {
  const { app } = require("electron");
  // 离屏窗口人眼看不见，但 macOS 照样往程序坞塞一个跳动的图标，跑一次测试抢一次注意力
  if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();
  app.on("window-all-closed", () => {});
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-htmlshot-cover-"));
  process.env.OPENWORKBUDDY_HOME = TMP;
  delete process.env.OWB_MOTION_BACKEND;
  delete process.env.OWB_BRIDGE;
  // 测试用的 Electron 不往用户的 ~/Library/Application Support/Electron 里写东西
  app.setPath("userData", path.join(TMP, "userData"));
  const cleanups = [];
  const finish = (code) => {
    for (const fn of cleanups.splice(0)) { try { fn(); } catch {} }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    app.exit(code);
  };
  // 整套最多 4 分钟：离屏窗口卡死时别让 CI 干等到外层超时
  const guard = setTimeout(() => { console.error("测试超时：4 分钟还没跑完"); finish(1); }, 240000);
  app.whenReady().then(() => run(TMP, cleanups)).then(() => {
    clearTimeout(guard);
    console.log(`\n${pass} 通过，${fail} 失败`);
    finish(fail ? 1 : 0);
  }).catch((e) => { console.error(e); finish(1); });
}

async function run(TMP, cleanups) {
  const electron = require("electron");
  const { app, BrowserWindow, session, nativeImage, utilityProcess } = electron;
  const http = require("http");
  const H = require(mod("htmlshot"));
  const I = H._internals;
  const coverSes = session.fromPartition(H.COVER_PARTITION);
  const plainSes = "owb-test-plain"; // 反向对照用的普通窗口：内存分区、不加任何防护

  let created = 0;
  app.on("browser-window-created", () => { created++; });
  const coverWinNow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.session === coverSes) || null;

  // 全程盯着：每 15ms 看一眼所有窗口
  const vis = { samples: 0, winSamples: 0, visible: 0, focused: 0, notOffscreen: 0 };
  const sampler = setInterval(() => {
    vis.samples++;
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      vis.winSamples++;
      if (w.isVisible()) vis.visible++;
      try { if (!w.webContents.isOffscreen()) vis.notOffscreen++; } catch {}
    }
    if (BrowserWindow.getFocusedWindow()) vis.focused++;
  }, 15);
  cleanups.push(() => clearInterval(sampler));
  // macOS：前台应用有没有哪一刻变成了这个测试进程（用户自己切应用不影响这一条）
  const front = { samples: 0, us: 0 };
  if (process.platform === "darwin") {
    const { execFile } = require("child_process");
    const t = setInterval(() => {
      execFile("lsappinfo", ["front"], { timeout: 2000 }, (_e, out) => {
        const asn = String(out || "").trim();
        if (!asn) return;
        execFile("lsappinfo", ["info", "-only", "pid", asn], { timeout: 2000 }, (_e2, o2) => {
          const m = /"pid"=(\d+)/.exec(String(o2 || ""));
          if (m) { front.samples++; if (Number(m[1]) === process.pid) front.us++; }
        });
      });
    }, 400);
    cleanups.push(() => clearInterval(t));
  }

  // 夹具
  const SITE = path.join(TMP, "site");
  fs.mkdirSync(path.join(SITE, "outside"), { recursive: true });
  fs.mkdirSync(path.join(SITE, "root"), { recursive: true });
  const page = (rel, bg, body = "", head = "") => {
    const f = path.join(SITE, rel);
    fs.writeFileSync(f, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}</style>${head}</head>`
      + `<body style="background:${bg}">${body}</body></html>`);
    return f;
  };
  const RED = page("red.html", "#f00");
  const BLUE = page("blue.html", "#00f");
  const SPEAK = page("speak.html", "#888", `<script>
var s = window.speechSynthesis;
var native = !!s && /\\[native code\\]/.test(String(s.speak));
var bg = "#ff0";
if (native) bg = "#f00"; // 原生的：只报告，绝不调用
else if (s) {
  var u = new SpeechSynthesisUtterance("封面测试不许出声");
  u.onend = function () { document.body.style.background = s.speaking ? "#ff0" : "#0f0"; };
  s.speak(u);
}
document.body.style.background = bg;
window.__native = native;
</script>`);
  const ALERT = page("alert.html", "#888", `<script>
var native = /\\[native code\\]/.test(String(window.alert));
if (!native) { alert("a"); confirm("b"); prompt("c"); window.close(); }
document.body.style.background = native ? "#f00" : "#0f0";
window.__native = native;
</script>`);
  const CLOSE = page("close.html", "#0f0", `<script>setTimeout(function () { window.close(); }, 30);</script>`);
  const LOOP = page("loop.html", "#f00", `<script>while (true) {}</script>`);
  const ANIM = page("anim.html", "#fff", `<div id="b"></div>`,
    `<style>@keyframes s{from{transform:rotate(0)}to{transform:rotate(360deg)}}#b{width:80px;height:80px;background:#00f;animation:s 1s linear infinite}</style>`);
  const NAV = page("nav.html", "#0f0", `<script>window.onload = function () { setTimeout(function () { location.href = "blue.html"; }, 30); };</script>`);
  const bgra = (w, h, [r, g, b]) => { const buf = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i++) buf.set([b, g, r, 255], i * 4); return buf; };
  const RED_PNG = nativeImage.createFromBitmap(bgra(4, 4, [255, 0, 0]), { width: 4, height: 4 }).toPNG();
  fs.writeFileSync(path.join(SITE, "root", "in.png"), RED_PNG);
  fs.writeFileSync(path.join(SITE, "outside", "out.png"), RED_PNG);
  let linked = true;
  try { fs.symlinkSync(path.join(SITE, "outside", "out.png"), path.join(SITE, "root", "link.png")); } catch { linked = false; }
  const imgPage = (rel, src) => page(rel, "#ff0",
    `<img src="${src}" onload="document.body.style.background='#f00'" onerror="document.body.style.background='#0f0'">`);
  const IMG_IN = imgPage("root/in.html", "in.png");
  const IMG_OUT = imgPage("root/out.html", "../outside/out.png");
  const IMG_LINK = imgPage("root/link.html", "link.png");

  const px = (buf) => {
    const img = nativeImage.createFromBuffer(buf);
    const { width, height } = img.getSize();
    const b = img.toBitmap(); // BGRA
    const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    return [b[i + 2], b[i + 1], b[i]];
  };
  const is = {
    red: ([r, g, b]) => r > 200 && g < 60 && b < 60,
    green: ([r, g, b]) => g > 200 && r < 60 && b < 60,
    blue: ([r, g, b]) => b > 200 && r < 60 && g < 60,
  };
  const Wd = 240, Ht = 160;
  const cover = (f, o = {}) => H.renderHtmlToPngAny(f, { width: Wd, height: Ht, waitMs: 150, lane: "cover", ...o });
  const task = (f, o = {}) => H.renderHtmlToPng(f, { width: Wd, height: Ht, waitMs: 150, ...o });
  /** 反向对照用的普通离屏窗口：不加任何防护（show:false + offscreen，照样不上桌面） */
  const plainWin = async (file) => {
    const w = new BrowserWindow({ show: false, width: Wd, height: Ht, frame: false,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false, partition: plainSes } });
    w.webContents.setAudioMuted(true);
    await w.webContents.loadFile(file);
    return w;
  };
  const alive = (pid) => { try { return app.getAppMetrics().some((m) => m.pid === pid); } catch { return false; } };

  console.log("【1】一个窗口反复用：连截两张只开 1 个");
  eq(H.shotAvailable().backend, "electron", "Electron 主进程里 shotAvailable 选 electron");
  ok(H.coverAvailable() === true, "coverAvailable()：true");
  I.closeCover();
  let c0 = created;
  let t0 = Date.now();
  const a = await cover(RED);
  const msCold = Date.now() - t0;
  t0 = Date.now();
  const b = await cover(BLUE);
  const msWarm = Date.now() - t0;
  ok(created - c0 === 1, `连截两张封面：只开了 1 个窗口（第一张 ${msCold}ms 含开窗，第二张 ${msWarm}ms）`, created - c0);
  ok(is.red(px(a)) && is.blue(px(b)), "两张各是各的颜色（第二张不是第一张的残影）", [px(a), px(b)]);
  let cw = coverWinNow();
  ok(cw && cw.webContents.getURL() === "about:blank", "截完落回空白页（页面里的动画、定时器、声音一起没了）", cw && cw.webContents.getURL());
  ok(cw && cw.webContents.isAudioMuted(), "封面窗口静音");
  ok(!coverSes.isPersistent() && session.defaultSession.isPersistent(), "封面分区不落盘（★反向对照★ 默认会话是落盘的）");
  ok(I.state().coverOpen && I.state().idleArmed, "截完窗口留着、空闲计时开着", I.state());
  c0 = created;
  await task(RED);
  await task(BLUE);
  ok(created - c0 === 2, "★反向对照★ 任务道同样两张：开了 2 个窗口（每张一个，截完就关）", created - c0);
  ok(BrowserWindow.getAllWindows().length === 1 && coverWinNow(), "任务道的窗口截完都关了，只剩封面那一个", BrowserWindow.getAllWindows().length);

  console.log("\n【2】朗读：换成不出声的替身，页面等 onend 的照样往下走");
  {
    const buf = await cover(SPEAK, { waitMs: 300 });
    ok(is.green(px(buf)), "封面里 speechSynthesis 不是原生的，speak 之后 speaking=false、onend 照样来了（涂绿）", px(buf));
    const w = await plainWin(SPEAK);
    const native = await w.webContents.executeJavaScript("window.__native");
    w.destroy();
    ok(native === true, "★反向对照★ 普通窗口里同一页看到的是原生朗读（测试页见了原生的就不调，不会出声）", native);
  }

  console.log("\n【3】alert / confirm / prompt 不卡，window.close() 关不掉复用的窗口");
  {
    cw = coverWinNow();
    c0 = created;
    t0 = Date.now();
    const buf = await cover(ALERT);
    const ms = Date.now() - t0;
    ok(is.green(px(buf)) && ms < 3000, `弹框三件套都调过了、脚本走到了最后（涂绿），${ms}ms`, { px: px(buf), ms });
    ok(cw && !cw.isDestroyed() && coverWinNow() === cw, "页面调了 window.close()：窗口还是原来那个");
    const buf2 = await cover(CLOSE, { waitMs: 300 });
    ok(is.green(px(buf2)) && coverWinNow() === cw && created === c0, "延时 close 的页面也关不掉；没多开窗口", created - c0);
    const w = await plainWin(ALERT);
    const native = await w.webContents.executeJavaScript("window.__native");
    w.destroy();
    ok(native === true, "★反向对照★ 普通窗口里 alert 是原生的（测试页见了原生的就不调）", native);
    const w2 = await plainWin(CLOSE);
    for (let i = 0; i < 50 && !w2.isDestroyed(); i++) await sleep(20);
    ok(w2.isDestroyed(), "★反向对照★ 普通窗口里同一句 window.close() 真把窗口关了");
    if (!w2.isDestroyed()) w2.destroy();
  }

  console.log("\n【4】死循环页面：5 秒报超时、掐掉渲染进程，下一单照常");
  {
    let pid = 0;
    const poll = setInterval(() => { const w = coverWinNow(); if (w) { try { pid = w.webContents.getOSProcessId() || pid; } catch {} } }, 50);
    t0 = Date.now();
    const e = await errOf(cover(LOOP));
    const ms = Date.now() - t0;
    clearInterval(poll);
    ok(e && e.code === H.SHOT_TIMEOUT && /超时/.test(e.message) && ms >= 4500 && ms < 9000, `死循环页面：${ms}ms 报 SHOT_TIMEOUT「${e && e.message}」`, { code: e && e.code, ms });
    for (let i = 0; i < 40 && pid && alive(pid); i++) await sleep(50);
    ok(pid > 0 && !alive(pid), "卡死的那个渲染进程从进程表里没了（到点掐死，不等它自己回话）", pid);
    ok(!coverWinNow(), "卡死的窗口扔了，不拿来接下一单");
    t0 = Date.now();
    const next = await cover(BLUE);
    ok(is.blue(px(next)), `下一单照常出图（重新开窗，${Date.now() - t0}ms）`, px(next));
  }

  console.log("\n【5】网络：封面页面一个请求都发不出去");
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": /\.js$/.test(req.url) ? "text/javascript" : "text/plain" });
    res.end(/\.js$/.test(req.url) ? "window.__x = 1;" : "");
  });
  srv.on("upgrade", (req, sock) => { hits.push("upgrade " + req.url); sock.destroy(); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  cleanups.push(() => srv.close());
  const P = srv.address().port;
  const NET = page("net.html", "#0f0", `
<img src="http://127.0.0.1:${P}/pixel.png">
<script src="http://127.0.0.1:${P}/x.js"></script>
<iframe src="http://127.0.0.1:${P}/frame" style="display:none"></iframe>
<script>
try { fetch("http://127.0.0.1:${P}/fetch").catch(function () {}); } catch (e) {}
try { new WebSocket("ws://127.0.0.1:${P}/ws"); } catch (e) {}
try { navigator.sendBeacon("http://127.0.0.1:${P}/beacon", "x"); } catch (e) {}
</script>`, `<link rel="stylesheet" href="http://127.0.0.1:${P}/s.css">`);
  {
    const buf = await cover(NET, { waitMs: 300 });
    await sleep(500);
    ok(is.green(px(buf)) && hits.length === 0, "外网脚本 / 样式 / 图片 / iframe / fetch / WebSocket / 信标：假服务器 0 个请求，图照出", hits);
    await task(NET, { waitMs: 300 });
    await sleep(300);
    ok(hits.length >= 3 && hits.includes("/x.js"), `★反向对照★ 同一页走任务道：假服务器收到 ${hits.length} 个请求`, hits);
  }

  console.log("\n【6】本地文件只许读 html 所在目录；页面自己跳转不跳");
  {
    ok(is.red(px(await cover(IMG_IN))), "★反向对照★ 同目录的图片照读（onload 涂红）");
    ok(is.green(px(await cover(IMG_OUT))), "../ 出去的图片：拦（onerror 涂绿）");
    if (linked) ok(is.green(px(await cover(IMG_LINK))), "目录里的链接指到外面：按真实路径算，同样拦");
    ok(is.red(px(await cover(IMG_OUT, { fileRoot: SITE }))), "★反向对照★ 调用方把可读范围放到上一层：同一张就读得到了");
    ok(is.green(px(await cover(NAV, { waitMs: 400 }))), "页面加载完自己跳到 blue.html：不跳，截的还是原页（绿）");
    ok(is.blue(px(await task(NAV, { waitMs: 400 }))), "★反向对照★ 任务道同一页真跳过去了（蓝）");
  }

  console.log("\n【7】永远加载不完的页面：到点报超时，下一单照常");
  {
    const socks = new Set();
    const hang = http.createServer(() => {}); // 收下请求，永远不回
    hang.on("connection", (s) => { socks.add(s); s.on("close", () => socks.delete(s)); });
    await new Promise((r) => hang.listen(0, "127.0.0.1", r));
    cleanups.push(() => { for (const s of socks) s.destroy(); hang.close(); });
    const NEVER = page("never.html", "#0f0", `<script src="http://127.0.0.1:${hang.address().port}/never.js"></script>`);
    t0 = Date.now();
    const e = await errOf(task(NEVER, { timeoutMs: 1500 }));
    const ms = Date.now() - t0;
    ok(e && e.code === H.SHOT_TIMEOUT && ms >= 1400 && ms < 5000, `任务道 timeoutMs=1500：${ms}ms 报 SHOT_TIMEOUT`, { code: e && e.code, msg: e && e.message, ms });
    ok(is.red(px(await task(RED))), "下一单任务照常出图");
    t0 = Date.now();
    const buf = await cover(NEVER);
    ok(is.green(px(buf)) && Date.now() - t0 < 3000, `★反向对照★ 同一页走封面道：那个请求发之前就拦了，页面立刻加载完（${Date.now() - t0}ms）`);
  }

  console.log("\n【8】截完就停画：无限 CSS 动画的页面，之后 5 秒 0 次重画");
  {
    await cover(ANIM);
    const w = coverWinNow();
    let paints = 0;
    const onPaint = () => { paints++; };
    w.webContents.on("paint", onPaint);
    await sleep(5000);
    if (!w.isDestroyed()) w.webContents.removeListener("paint", onPaint);
    ok(w && paints === 0, "截完 5 秒：0 次重画", paints);
    const p = await plainWin(ANIM);
    let n = 0;
    p.webContents.on("paint", () => { n++; });
    await sleep(1000);
    p.destroy();
    ok(n > 10, `★反向对照★ 普通离屏窗口开着同一页：1 秒重画 ${n} 次`, n);
  }

  console.log("\n【9】任务道插队：排着的封面让任务先走");
  {
    const order = [];
    const tag = (p, name) => p.then(() => order.push(name), () => order.push(name + "!"));
    const jobs = [tag(cover(RED, { waitMs: 400 }), "封面1"), tag(cover(BLUE), "封面2"), tag(cover(RED), "封面3"), tag(task(BLUE), "任务")];
    const st = I.state();
    await Promise.all(jobs);
    eq(st.running + ` 在跑，排着 任务${st.queued.task} 封面${st.queued.cover}`, "cover 在跑，排着 任务1 封面2", "封面1 在跑时：任务 1 单、封面 2 单排着");
    eq(order, ["封面1", "任务", "封面2", "封面3"], "任务道最后才来，却在封面2、封面3 前面出图");
    order.length = 0;
    await Promise.all([tag(cover(RED, { waitMs: 400 }), "封面1"), tag(cover(BLUE), "封面2"), tag(cover(RED), "封面3"), tag(cover(BLUE), "最后一单")]);
    eq(order, ["封面1", "封面2", "封面3", "最后一单"], "★反向对照★ 同一单排在封面道：按先来后到排最后");
  }

  console.log("\n【10】服务进程里（utilityProcess 过桥）：窗口还是主进程那一个");
  {
    const { createShellBridge } = require(mod("bridge-main"));
    const shell = createShellBridge({ electron, hidden: true });
    const childFile = path.join(TMP, "bridge-child.js");
    fs.writeFileSync(childFile, `"use strict";
const H = require(${JSON.stringify(mod("htmlshot"))});
const bridge = require(${JSON.stringify(mod("electron-bridge"))});
const post = (m) => process.parentPort.postMessage(m);
process.parentPort.on("message", async (e) => {
  const m = e && e.data;
  if (!m || m.t !== "go") return;
  if (m.what === "avail") { post({ t: "test", id: m.id, mode: bridge.mode(), backend: H.shotAvailable().backend, cover: H.coverAvailable() }); return; }
  const t0 = Date.now();
  try { const buf = await H.renderHtmlToPngAny(m.html, m.opts || {}); post({ t: "test", id: m.id, ok: true, buf, ms: Date.now() - t0 }); }
  catch (err) { post({ t: "test", id: m.id, ok: false, code: err && err.code, message: String(err && err.message), ms: Date.now() - t0 }); }
});
`);
    const fork = async (caps) => {
      const c = utilityProcess.fork(childFile, [], {
        env: { ...process.env, OWB_BRIDGE: "1", OWB_BRIDGE_STATE: JSON.stringify({ caps }) },
        stdio: "inherit", serviceName: "owb-test-htmlshot-cover",
      });
      cleanups.push(() => { try { c.kill(); } catch {} });
      const waiters = new Map();
      let seq = 0;
      c.on("message", (m) => {
        if (shell.handle(m, (r) => c.postMessage(r))) return;
        if (m && m.t === "test" && waiters.has(m.id)) { const w = waiters.get(m.id); waiters.delete(m.id); w(m); }
      });
      await new Promise((r) => c.once("spawn", r));
      const ask = (msg) => new Promise((resolve) => { const id = ++seq; waiters.set(id, resolve); c.postMessage({ ...msg, t: "go", id }); });
      return { c, ask };
    };
    const kid = await fork({ windows: true });
    const av = await kid.ask({ what: "avail" });
    ok(av.mode === "remote" && av.backend === "electron" && av.cover === true, "服务进程里：过桥模式，封面可出", av);
    I.closeCover();
    c0 = created;
    const calls0 = shell.counts.calls;
    const shot = (html, opts) => kid.ask({ html, opts: { width: Wd, height: Ht, waitMs: 150, ...opts } });
    const r1 = await shot(RED, { lane: "cover", timeoutMs: 5000 });
    const r2 = await shot(BLUE, { lane: "cover", timeoutMs: 5000 });
    ok(r1.ok && r2.ok && is.red(px(Buffer.from(r1.buf))) && is.blue(px(Buffer.from(r2.buf))), `过桥连截两张封面：颜色都对（${r1.ms}ms、${r2.ms}ms）`, { r1: r1.message, r2: r2.message });
    ok(created - c0 === 1 && shell.counts.calls - calls0 === 2, "主进程只开了 1 个窗口，桥上走了 2 趟", { windows: created - c0, calls: shell.counts.calls - calls0 });
    const r3 = await shot(LOOP, { lane: "cover", timeoutMs: 1500 });
    ok(!r3.ok && r3.code === H.SHOT_TIMEOUT && /超时/.test(r3.message) && r3.ms < 6000, `过桥的死循环页面：${r3.ms}ms 报 SHOT_TIMEOUT，错误码原样过桥`, r3);
    const r4 = await shot(BLUE, { lane: "cover" });
    ok(r4.ok && is.blue(px(Buffer.from(r4.buf))), "下一单照常出图", r4.message);
    c0 = created;
    const r5 = await shot(RED, {});
    ok(r5.ok && is.red(px(Buffer.from(r5.buf))) && created - c0 === 1, "★反向对照★ 缺省的任务道过桥：每张另开一个窗口（老样子）", { ok: r5.ok, windows: created - c0 });
    const kid2 = await fork({ windows: false });
    const av2 = await kid2.ask({ what: "avail" });
    const calls1 = shell.counts.calls;
    const r6 = await kid2.ask({ html: RED, opts: { lane: "cover", width: 1280, height: 800 } });
    ok(av2.cover === false && !r6.ok && r6.code === H.NO_RENDERER && shell.counts.calls === calls1,
      "主进程说开不了窗口（隐藏运行的测试宿主之类）：封面道直接 NO_RENDERER，桥上一趟都没走", { av2, code: r6.code, calls: shell.counts.calls - calls1 });
    kid.c.kill();
    kid2.c.kill();
  }

  console.log("\n【11】空闲关窗：到点窗口和渲染进程一起走");
  {
    I.closeCover();
    await sleep(100);
    const baseline = BrowserWindow.getAllWindows().length;
    I.setCoverIdleMs(800);
    await cover(RED);
    const w = coverWinNow();
    const pid = w ? w.webContents.getOSProcessId() : 0;
    ok(BrowserWindow.getAllWindows().length === baseline + 1 && pid > 0 && alive(pid), "★反向对照★ 刚截完：窗口和它的渲染进程都在", { n: BrowserWindow.getAllWindows().length, baseline, pid });
    await sleep(400);
    ok(I.state().coverOpen, "400ms（没到 800ms）：还开着");
    await sleep(900);
    ok(BrowserWindow.getAllWindows().length === baseline && !I.state().coverOpen, "空闲 800ms 以后：窗口数回到基线", { n: BrowserWindow.getAllWindows().length, baseline });
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
    ok(!alive(pid), "那个离屏渲染进程从 app.getAppMetrics() 里消失了", pid);
    I.setCoverIdleMs(30000);
  }

  console.log("\n【12】全程没有一个窗口上桌面");
  clearInterval(sampler);
  ok(vis.visible === 0 && vis.focused === 0, `抽了 ${vis.samples} 次、看了 ${vis.winSamples} 个窗口次：isVisible() 一次都没 true，也没有窗口抢到焦点`, vis);
  ok(vis.notOffscreen === 0, "看到的窗口全是离屏窗口", vis.notOffscreen);
  ok(vis.winSamples > 50, "★反向对照★ 抽查真看到了窗口（不是一直空跑）", vis.winSamples);
  if (process.platform === "darwin") {
    ok(front.samples >= 5 && front.us === 0, `前台应用抽了 ${front.samples} 次：一次都不是这个测试进程`, front);
  }
  I.closeCover();
  for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch {} }
}
