// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * agent 打开网页用的隐藏窗口（renderPage / checkPage）：独立内存分区、静音、低帧率。
 *
 * 跑法：./node_modules/.bin/electron test/web-partition.js（被 node 拉起时自己换成 electron 再跑一遍）
 *
 * 2026-09-28 实测：这两个原来用默认会话，agent 读过的视频站、社区站各自往应用 profile 里装
 * Service Worker、预缓存脚本，Service Worker 目录涨到 46M，界面自己一个都没用过。
 * 这里钉住：外部网页的 SW 只进 owb-web 内存分区、默认会话一个都没有；窗口静音、8 帧；
 * 最后一个窗口关掉才清一次。每组配反向对照：不走 openHiddenWeb 的窗口，SW 真会落进默认 profile。
 *
 * 窗口一律 show:false + offscreen，不 show / focus；userData 换到临时目录，不碰任何真 profile。
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
  // 临时目录由这一层建、这一层删：Chromium 退出那一下还会往 profile 里回写 Local State / Preferences，
  // 在 electron 里面先删再 app.exit，删完又被写回来——2026-09-29 整套跑完每次剩一个 owb-webpart-*
  const tmp = fs0.mkdtempSync(require("path").join(require("os").tmpdir(), "owb-webpart-"));
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1", OWB_WEBPART_TMP: tmp },
    timeout: 120000, killSignal: "SIGKILL",
  });
  try { fs0.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { app, BrowserWindow, session } = require("electron");

if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const TMP = process.env.OWB_WEBPART_TMP || fs.mkdtempSync(path.join(os.tmpdir(), "owb-webpart-"));
app.setPath("userData", path.join(TMP, "profile"));
process.env.OPENWORKBUDDY_HOME = TMP;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (v, m, extra) => { if (v) { pass++; console.log("  ✓ " + m); } else { fail++; console.error("  ❌", m, extra === undefined ? "" : "\n     " + (typeof extra === "string" ? extra : JSON.stringify(extra))); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; }

/** 抠出 src 里每一个 new electron.BrowserWindow({...}) 的整段（按括号配对） */
function windowBlocks(src) {
  const out = [];
  const re = /new (?:electron\.)?BrowserWindow\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1;
    for (; i < src.length && depth; i++) { if (src[i] === "(") depth++; else if (src[i] === ")") depth--; }
    out.push(src.slice(m.index, i));
  }
  return out;
}
const leaky = (blocks) => blocks.filter((b) => /offscreen:\s*true/.test(b) && (!/partition:/.test(b) || /persist:/.test(b)));

const PAGE = `<!doctype html><meta charset="utf-8"><title>sw page</title><body>
<p>${"正文".repeat(40)}</p>
<script>navigator.serviceWorker && navigator.serviceWorker.register("/sw.js").then(() => { document.title = "sw ok"; }, (e) => { document.title = "sw fail " + e; });</script>
</body>`;
const srv = http.createServer((req, res) => {
  if (req.url === "/sw.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end("self.addEventListener('install', (e) => e.waitUntil(caches.open('c1').then((c) => c.put('/x', new Response('x'))))); self.addEventListener('fetch', () => {});");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

app.on("window-all-closed", () => {}); // 别让测试窗口全关时把应用带走

app.whenReady().then(async () => {
  const tools = require(mod("tools"));
  const { openHiddenWeb, hiddenWeb, WEB_PARTITION, checkPage } = tools._internals;
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const swDir = path.join(app.getPath("userData"), "Service Worker");

  console.log("\n【1】源码守卫：隐藏的离屏窗口都带内存分区");
  {
    // 2026-09-29 服务端挪进独立进程：开窗那一半从 tools.js 搬进 web-window.js（主进程过桥开窗时不用加载整个 tools.js），两份一起守
    const src = fs.readFileSync(mod("tools"), "utf8");
    const wsrc = fs.readFileSync(mod("web-window"), "utf8");
    const blocks = windowBlocks(src + "\n" + wsrc);
    ok(blocks.length >= 1 && leaky(blocks).length === 0, `tools.js + web-window.js 里 ${blocks.length} 处离屏窗口都带 partition、都不带 persist:`, leaky(blocks).map((b) => b.slice(0, 120)));
    ok(/async function probePage[\s\S]{0,120}const win = openHiddenWeb\(electron\);[\s\S]{0,40}const errs/.test(wsrc) && /async function readRendered[\s\S]{0,200}const win = openHiddenWeb\(electron\)/.test(wsrc)
      && /async function checkPage[\s\S]{0,1600}await probePage\(electron, file\)/.test(src) && /async function renderPage[\s\S]{0,900}return readRendered\(electron, url/.test(src),
    "checkPage 和 renderPage 都走 openHiddenWeb（经 web-window.js 的 probePage / readRendered）");
    const bad1 = "new electron.BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } })";
    const bad2 = "new electron.BrowserWindow({ show: false, webPreferences: { offscreen: true, partition: \"persist:web\" } })";
    ok(leaky(windowBlocks(bad1)).length === 1 && leaky(windowBlocks(bad2)).length === 1, "没带分区、或者带的是 persist: 分区，守卫都会报（反向对照）");
    ok(WEB_PARTITION === "owb-web" && !/^persist:/.test(WEB_PARTITION), "分区名不带 persist:（退出即没）", WEB_PARTITION);
  }

  console.log("\n【2】窗口本身：内存分区、静音、8 帧");
  {
    const w = openHiddenWeb(require("electron"));
    const ses = w.webContents.session;
    ok(ses !== session.defaultSession && ses === session.fromPartition(WEB_PARTITION), "用的是 owb-web 分区，不是默认会话");
    ok(ses.isPersistent() === false, "分区不落盘（isPersistent=false）");
    ok(w.webContents.isAudioMuted() === true, "静音");
    ok(w.webContents.getFrameRate() === 8, "帧率 8", w.webContents.getFrameRate());
    ok(w.isVisible() === false, "窗口没亮");
    w.destroy();
    const plain = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { offscreen: true } });
    ok(plain.webContents.session === session.defaultSession && plain.webContents.isAudioMuted() === false && plain.webContents.getFrameRate() !== 8,
      "不走 openHiddenWeb 的离屏窗口：默认会话、不静音、默认帧率（反向对照）", { fr: plain.webContents.getFrameRate() });
    plain.destroy();
    await sleep(50);
  }

  console.log("\n【3】renderPage 打开会装 SW 的网页：SW 只进内存分区，默认 profile 一个没有");
  {
    const web = session.fromPartition(WEB_PARTITION);
    let regWeb = 0;
    web.serviceWorkers.on("registration-completed", () => { regWeb++; });
    let clears = 0;
    const realClear = web.clearStorageData.bind(web);
    web.clearStorageData = (o) => { clears++; return realClear(o); };
    const r = await tools.renderPage(base, { waitMs: 300, maxWaitMs: 1500 });
    ok(/正文/.test(r.text), "正文照常读到", r.text.slice(0, 40));
    await until(() => regWeb > 0, 2000);
    ok(regWeb > 0, "页面确实在 owb-web 分区里装上了 SW（探针是活的）", regWeb);
    ok(!fs.existsSync(swDir), "默认 profile 下没有 Service Worker 目录", swDir);
    await until(() => clears > 0, 2000);
    ok(clears === 1 && hiddenWeb.open === 0, "最后一个窗口关掉：清了一次 SW / CacheStorage", { clears, open: hiddenWeb.open });

    console.log("\n【4】两个窗口同时开：先关的那个不清，最后一个关了才清");
    clears = 0;
    const html = path.join(TMP, "p.html");
    fs.writeFileSync(html, `<!doctype html><html><head><title>t</title></head><body><p>${"内容".repeat(30)}</p></body></html>`);
    const a = openHiddenWeb(require("electron"));
    const pc = checkPage(html, "p.html");
    await until(() => hiddenWeb.open === 2, 2000);
    ok(hiddenWeb.open === 2, "两个都开着", hiddenWeb.open);
    const rep = await pc;
    await sleep(100);
    ok(/浏览器实测/.test(rep) && /控制台没有报错/.test(rep), "checkPage 在内存分区里照常打开本地文件", rep.slice(-120));
    ok(clears === 0 && hiddenWeb.open === 1, "还有一个开着：不清（反向对照）", { clears, open: hiddenWeb.open });
    a.destroy();
    await until(() => clears > 0, 2000);
    ok(clears === 1 && hiddenWeb.open === 0, "最后一个也关了：清一次", { clears, open: hiddenWeb.open });

    console.log("\n【5】反向对照：同一个网页用默认会话打开，SW 真会落进 profile");
    const plain = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { offscreen: true } });
    let regDef = 0;
    session.defaultSession.serviceWorkers.on("registration-completed", () => { regDef++; });
    await plain.loadURL(base);
    await until(() => regDef > 0, 3000);
    await until(() => fs.existsSync(swDir), 3000);
    ok(regDef > 0 && fs.existsSync(swDir), "默认会话打开同一页：SW 注册进默认 profile，Service Worker 目录出现了", { regDef, dir: fs.existsSync(swDir) });
    plain.destroy();
  }

  srv.close();
  for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch {} }
  await sleep(100);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} 通过，${fail} 失败`);
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
