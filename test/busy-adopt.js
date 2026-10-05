// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 这一页不知道、服务端却还在跑的那一趟：发「继续」要接上它，不许甩一句 409。
 *
 * 跑法：npx electron test/busy-adopt.js（node 跑会自己换成 electron 再拉起一遍）
 *
 * 用户截图：发了一句「继续」，回来一行红字「出错了：该会话已有任务在运行，可用「插队」把补充说明注入当前任务。」
 * 服务端没说错——那条对话确实有一趟在跑；错在这一页不知道：那趟是别的标签页 / 手机上发起的，
 * 或者断线后重连几次没接回来。页面以为闲着，就把「继续」当新一轮 POST /api/chat，撞 409，
 * 话没送到，人也不知道该去点哪。
 *
 * 这里起的是真 server.js + 一个故意慢 7 秒的假模型，先让「别处」聊完一轮，页面打开这条对话，
 * 然后「别处」再发一趟慢的，页面这时候发「继续」。判据：
 *   - 屏幕上没有那句红字；
 *   - 页面认出这条在跑（能停、能插），第一轮已经答完的对话还在屏幕上，没被当成活的那轮换掉；
 *   - 「继续」真进了模型：最后一次请求的最后一条用户消息就是它（不是只在系统提示词里碰巧有这两个字）；
 *   - 页面点开时那趟已经在跑的，接上后跑着的那轮只有一份（回放出来的那份「中断了」要换掉）。
 * 去掉修复跑一遍，前两条当场红——那句红字就是用户截图里的原文。
 */

const { entry } = require("./lib/entry");
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron，这个毛病只在真页面上犯");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 240000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

process.on("uncaughtException", (e) => { console.error("❌ 插队接管测试自己炸了：", (e && e.stack) || e); process.exit(1); });
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { app, BrowserWindow, session } = require("electron");
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-busy-adopt-"));
const dataDir = path.join(home, "data");
fs.mkdirSync(dataDir, { recursive: true });
const tok = "tk" + Date.now();
fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({
  users: [{ username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
  tokens: { [tok]: { user: "boss", at: Date.now() } },
}));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假模型：最后一句用户话里带「慢」就拖 7 秒再答，给「页面发继续」留出窗口
const lastUsers = [];
const llm = http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let b = {}; try { b = JSON.parse(raw); } catch {}
    const last = [...(b.messages || [])].reverse().find((m) => m.role === "user");
    const text = last ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : "";
    lastUsers.push(text);
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "收到：" + text.slice(0, 20) }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
    }, /慢/.test(text) ? 7000 : 30);
  });
});

let child = null;
const finish = (code) => {
  try { if (child) child.kill(); } catch {}
  try { llm.close(); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
  console.log(`\n插队接管：${pass} 过 / ${fail} 挂`);
  app.exit(code);
};

llm.listen(0, "127.0.0.1", () => {
  const p = llm.address().port;
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  cfg.provider = "openai";
  cfg.openai = { base_url: `http://127.0.0.1:${p}/v1`, api_key: "k", model: "mock", stream: false };
  cfg.models = [{ name: "假模型", provider: "openai", base_url: `http://127.0.0.1:${p}/v1`, api_key: "k", model: "mock", stream: false }];
  cfg.active_model = "假模型";
  cfg.mcp_servers = [];
  cfg.agent = { ...(cfg.agent || {}), max_steps: 4, llm_timeout_ms: 20000 };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
  child = spawn(process.env.OWB_NODE || "node", [entry("server")], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: "0" },
  });
});

let log = "";
app.whenReady().then(async () => {
  for (let i = 0; i < 100 && !child; i++) await sleep(50);
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  let port = 0;
  for (let i = 0; i < 300 && !port; i++) { const m = /已启动: http:\/\/localhost:(\d+)/.exec(log); if (m) port = +m[1]; else await sleep(200); }
  if (!port) { console.log("❌ server 没起来：" + log.slice(-800)); return finish(1); }

  const SID = "s_" + Date.now() + "_1";
  // 「别处」发的一轮：直接打接口，这一页完全不知道
  const chatElsewhere = (message) => new Promise((resolve) => {
    const data = JSON.stringify({ sessionId: SID, message, mode: "craft" });
    const rq = http.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(data), Cookie: "openworkbuddy_token=" + tok,
    } }, (r) => { r.on("data", () => {}); r.on("end", resolve); });
    rq.end(data);
  });

  await chatElsewhere("第一句");
  const base = "http://127.0.0.1:" + port;
  await session.defaultSession.cookies.set({ url: base, name: "openworkbuddy_token", value: tok });
  const win = new BrowserWindow({ show: false, width: 1300, height: 900 });
  await win.loadURL(base + "/");
  await sleep(2500);
  const js = (s) => win.webContents.executeJavaScript(s);
  await js(`openSession(${JSON.stringify(SID)})`);
  await sleep(800);

  const slow = chatElsewhere("第二句 慢"); // 这页打开之后才发起的一趟
  await sleep(1200);
  await js(`inputEl.value = "继续"; send();`);
  await sleep(2500);
  const snap = () => js(`(() => ({
    busy: runningSessions.has(${JSON.stringify(SID)}),
    red: /已有任务在运行/.test(chatCol.innerText),
    text: chatCol.innerText.replace(/\\s+/g, " "),
  }))()`);
  const mid = await snap();
  ok(!mid.red, "发「继续」不再甩「该会话已有任务在运行」那句红字", mid.text.slice(0, 300));
  ok(mid.busy, "页面认出这条在跑：停止、插一句都够得着", mid.text.slice(0, 300));
  ok(/第一句/.test(mid.text) && /收到：第一句/.test(mid.text), "第一轮答完的对话还在屏幕上，没被当成活的那轮换掉", mid.text.slice(0, 300));
  ok(/第二句 慢/.test(mid.text), "接上的是别处发起的那一趟", mid.text.slice(0, 300));

  await slow;
  await sleep(2500);
  const end = await snap();
  ok(lastUsers.includes("继续"), "「继续」真进了模型：有一次请求的最后一条用户消息就是它", lastUsers);
  ok(/收到：继续/.test(end.text) && !end.red, "跑完屏幕上看得到对「继续」的回答，全程没有红字", end.text.slice(0, 400));
  ok(!end.busy, "那趟跑完页面也跟着收尾，不会一直挂着「在跑」", end.text.slice(0, 200));

  // 场景二：页面是在那趟已经跑起来之后才点开这条对话的。回放会把跑到一半的那轮画成一轮「中断了」，
  // 接上之后要是不整页重画，同一轮就会在屏幕上出现两份——一份死的、一份活的
  const SID2 = SID.replace(/_1$/, "_2");
  const chat2 = (message) => new Promise((resolve) => {
    const data = JSON.stringify({ sessionId: SID2, message, mode: "craft" });
    const rq = http.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(data), Cookie: "openworkbuddy_token=" + tok,
    } }, (r) => { r.on("data", () => {}); r.on("end", resolve); });
    rq.end(data);
  });
  await chat2("第一句");
  const slow2 = chat2("第三句 慢");
  await sleep(1200);
  await js(`openSession(${JSON.stringify(SID2)})`);
  await sleep(800);
  await js(`inputEl.value = "继续"; send();`);
  await sleep(2500);
  const b2 = await js(`(() => ({ busy: runningSessions.has(${JSON.stringify(SID2)}), text: chatCol.innerText.replace(/\s+/g, " ") }))()`);
  const copies = (b2.text.match(/第三句 慢/g) || []).length;
  ok(b2.busy && copies === 1 && !/中断了/.test(b2.text), "点开时那趟已经在跑：接上之后跑着的那轮只有一份，不留一轮「中断了」的死副本", b2.text.slice(0, 400));
  await slow2;
  await sleep(1500);

  finish(fail ? 1 : 0);
});
