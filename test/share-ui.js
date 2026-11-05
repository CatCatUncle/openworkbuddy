// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
process.on("uncaughtException", (e) => { console.error(e.stack || e); process.exit(1); });
const { spawnSync } = require("child_process");
if (!process.versions.electron) {
  const result = spawnSync(require("electron"), [__filename], { stdio: "inherit", env: process.env, timeout: 60000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 ? 0 : 1);
}
const HOME = require("./lib/own-home")("share-ui");
const { app, BrowserWindow } = require("electron");
const fs = require("fs"), path = require("path"), http = require("http"), assert = require("assert/strict");
app.setPath("userData", path.join(HOME, "browser")); if (process.platform === "darwin" && app.dock) app.dock.hide();
const root = path.join(__dirname, ".."), read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const token = "x".repeat(43); let mode = 200, server, win;
const fixture = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/css/ui.css"><body><div id="chat-scroll"></div></body>';
app.whenReady().then(async () => {
 try {
  server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const pathname = req.url.split("?")[0];
    if (["/shared.html", "/css/ui.css", "/css/shared.css", "/js/i18n.js", "/js/shared.js"].includes(pathname)) { res.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html"); res.end(read("public" + pathname)); }
    else if (pathname.startsWith("/api/session-shares/")) { res.writeHead(mode, { "Content-Type": "application/json" }); res.end(JSON.stringify({ title: "保存", turns: [{ role: "user", text: '<img src=x onerror="window.fixtureExecuted=true">' }, { role: "assistant", text: "A complete result" }], files: [{ path: "folder/a b.md", size: 100 }] })); }
    else res.end(fixture);
  }); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  await win.loadURL(base);
  assert.ok(!read("public/index.html").includes("app-10-share.js"));
  // 入口只在平台管理员打开后才出现
  assert.ok(/settingsCache\?\.session_shares \? \["share"/.test(read("public/js/app-02.js")));
  const results = await win.webContents.executeJavaScript(`(() => {
    if (typeof openSessionShare !== "undefined" || document.getElementById("session-share-panel")) throw Error("分享入口未关闭");
    return ["主界面不加载分享脚本", "默认不显示分享入口", "没有分享面板或弹窗"];
  })()`);
  for (const name of results) console.log("✓ " + name);
  let more = 0;
  await win.loadURL(base + "/shared.html#" + token); await new Promise((r) => setTimeout(r, 100));
  const state = await win.webContents.executeJavaScript('({title:document.getElementById("shared-title").textContent,turns:document.querySelectorAll(".shared-turn").length,img:!!document.querySelector(".shared-text img"),text:document.querySelector(".shared-text").textContent,file:document.querySelector("#shared-files a").getAttribute("href"),editable:document.querySelectorAll("input,textarea,[contenteditable=true],button").length})');
  assert.equal(state.title, "保存"); assert.equal(state.turns, 2); assert.equal(state.img, false); assert.ok(state.text.includes("<img")); assert.equal(state.editable, 0); assert.equal(state.file, "/api/session-shares/" + token + "/file?path=folder%2Fa%20b.md"); console.log("✓ 只读页面展示完整文本与下载链接；用户内容无法执行 HTML");more++;
  await win.webContents.executeJavaScript('I18N.setLang("en")');
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("shared-status").textContent'), "This page is read-only. You cannot edit or resume the task."); console.log("✓ 英文界面的只读说明已翻译");more++;
  mode = 401; await win.loadURL(base + "/shared.html?case=unauthorized#" + token); await new Promise((r) => setTimeout(r, 100));
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("shared-login").getAttribute("href")'), "/?shared=" + token); console.log("✓ 未登录时提供回到分享任务的登录链接");more++;
  mode = 404; await win.loadURL(base + "/shared.html?case=revoked#" + token); await new Promise((r) => setTimeout(r, 100));
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".shared-turn").length'), 0); console.log("✓ 撤回或无权查看时不残留正文");more++;
  console.log(`Share UI: ${results.length + more} checks passed`);
  win.destroy(); await new Promise((r) => server.close(r)); app.exit(0);
 } catch (e) { console.error(e.stack || e); if (win && !win.isDestroyed()) win.destroy(); if (server) server.close(); app.exit(1); }
});
