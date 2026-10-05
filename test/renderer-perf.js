// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 多开几条对话一起跑、同时在输入框里打字：界面线程上那几处「每个字 / 每一下都白干一遍」的活。
 *
 * 跑法：npx electron test/renderer-perf.js（node 跑会自己换成 electron 再拉起一遍）
 *
 * 2026-09-29 实测（真 electron-main.js、5 路并跑、眼前这条每秒 60 个 token、侧栏 551 条历史）：
 *   - 每个 token 都排一次 rAF 去滚到底：rAF 每秒 38~42 次，主线程每秒 72~78 帧（不出字时 10 帧），
 *     每一帧再把侧栏那几颗一直在闪的点、转圈重算样式、重提合成层，光这两项每秒 80ms；
 *   - 侧栏动一下（改一行、换一颗点）就把几百行从头标一遍键盘语义：静置 10 秒 data-activate 被重写 5510 次；
 *   - 侧栏渐隐在内容变更的微任务里读 scrollHeight：切会话时被逼排版，10 次切换里 14 次超过 1ms、最长 21.7ms；
 *   - 输入框每敲一个字，发送键整颗 svg 拆了重建、title 重写；
 *   - 每个 token 在整轮子树上跑两遍 querySelector（找重试条、找思考提示）。
 *
 * 不量毫秒（CI 机器忙起来什么数都有），只数机制：排了几次 rAF、调了几次、写了几次属性、读了几次 scrollHeight。
 * 每条都配 ★反向对照★：同一个量法，套在把修复原样撤回去的那份真源码上，必须红。
 * 撤回用的是从真源码上做字符串替换（找不到替换点也判红——说明代码改了，这条测试得跟着看一眼）。
 */

const { entry } = require("./lib/entry");
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron，这几处只在真页面上才量得到");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 180000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

let pass = 0, fail = 0;
let child = null, llm = null, home = "", finished = false;
const wins = [];

function finish(code) {
  if (finished) return;
  finished = true;
  for (const w of wins) { try { if (!w.isDestroyed()) w.destroy(); } catch {} }
  try { if (child) child.kill(); } catch {}
  try { if (llm) { if (llm.closeAllConnections) llm.closeAllConnections(); llm.close(); } } catch {}
  try { if (home) fs.rmSync(home, { recursive: true, force: true }); } catch {}
  console.log(`\n界面线程热路径：${pass} 过 / ${fail} 挂`);
  require("electron").app.exit(code);
}
process.on("uncaughtException", (e) => { console.error("❌ 界面线程热路径测试自己炸了：", (e && e.stack) || e); finish(1); });
process.on("unhandledRejection", (e) => { console.error("❌ 界面线程热路径测试自己炸了：", (e && e.stack) || e); finish(1); });

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { app, BrowserWindow, session } = require("electron");
// 窗口一律不亮：show:false、摆在屏幕外、离屏渲染；程序坞也不塞图标
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-renderer-perf-"));
const dataDir = path.join(home, "data");
fs.mkdirSync(dataDir, { recursive: true });
const tok = "tk" + Date.now();
fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({
  users: [{ username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
  tokens: { [tok]: { user: "boss", at: Date.now() } },
}));

const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 900))); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
async function waitFor(fn, ms, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

// 假模型：这套测试不发任务，配上只是让 server 按正常配置起来；真有请求来也只回一句
llm = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(J({ choices: [{ message: { role: "assistant", content: "好的" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
llm.listen(0, "127.0.0.1", () => {
  const p = llm.address().port;
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  cfg.provider = "openai";
  cfg.openai = { base_url: `http://127.0.0.1:${p}/v1`, api_key: "k", model: "mock", stream: false };
  cfg.models = [{ name: "假模型", provider: "openai", base_url: `http://127.0.0.1:${p}/v1`, api_key: "k", model: "mock", stream: false }];
  cfg.active_model = "假模型";
  cfg.mcp_servers = [];
  fs.writeFileSync(path.join(home, "config.json"), J(cfg));
  child = spawn(process.env.OWB_NODE || "node", [entry("server")], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: "0" },
  });
});

// ---------- 真源码切片（键盘语义那段是个 IIFE，页面上摸不到，只能从文件里切） ----------
const UI00 = fs.readFileSync(path.join(ROOT, "public", "js", "app-00-ui.js"), "utf8");
const cut = (src, head, tail) => {
  const a = src.indexOf(head);
  if (a < 0) return "";
  const b = src.indexOf(tail, a);
  return b < 0 ? "" : src.slice(a, b + tail.length);
};
const MA_SRC = cut(UI00, "function markActivatable(el) {", "\n}\n");
const KBD_SRC = cut(UI00, "(function () {\n  const SEL = \".hist-item, .proj-item, .side-nav .item\";", "\n})();\n");
const MA_GUARD = 'if (el.dataset.activate !== "1") el.dataset.activate = "1";';
const MO_NEW = "new MutationObserver(armAdded)";

// ---------- 页面里的几段量法 ----------

// ① 出字：每个 token 排不排 rAF。token 一个一个来，中间各过一帧（rAF 换成手动的，一帧 = 把攒下的回调跑一遍），
//    100ms 那一下落屏之前全在同一段同步代码里，定时器插不进来——数出来的就是「字进来」这一步自己排了几帧
const TOKEN_FRAMES = `(async (variant) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const keepSid = sessionId, keepStick = chatStick;
  const oRaf = window.requestAnimationFrame, oSB = window.scrollBottom;
  let q = [], req = 0, sb = 0;
  window.requestAnimationFrame = (cb) => { req++; q.push(cb); return q.length; };
  const frame = () => { const cbs = q; q = []; for (const cb of cbs) cb(performance.now()); };
  window.scrollBottom = function () { sb++; return oSB.apply(this, arguments); };
  let make = createTurnUI, had = true;
  if (variant === "old") {
    // 撤回：出字那一支不再提前返回，照旧走到 handleEvent 末尾那句 scrollBottom
    const src = createTurnUI.toString();
    const anchor = "      if (!hint) return;\\n    } else if (ev.type === \\"expert_start\\") {";
    had = src.includes(anchor);
    (0, eval)(src.replace(anchor, "    } else if (ev.type === \\"expert_start\\") {").replace("function createTurnUI(", "function createTurnUIOldScroll("));
    make = window.createTurnUIOldScroll;
  }
  const sid = "rp_tok_" + variant;
  const toBottom = document.getElementById("to-bottom");
  try {
    sessionId = sid; chatStick = true;
    chatCol.innerHTML = "";
    const ui = make("量一下每个字排几帧", "craft", sid);
    ui.handleEvent({ type: "step_start", step: 1 });
    frame(); req = 0; sb = 0;
    ui.handleEvent({ type: "text", delta: "第 0 行\\n\\n" });
    const first = { sb, hint: !!ui.body.querySelector(".thinking-hint") };
    frame(); req = 0; sb = 0;
    for (let i = 1; i <= 60; i++) { ui.handleEvent({ type: "text", delta: "第 " + i + " 行\\n\\n" }); frame(); }
    const burst = { req, sb };
    await sleep(180);
    const painted = { sb };
    frame();
    await sleep(30); // 滚动事件落地（syncScrollGuides 按位置重算 chatStick）
    const el = ui.body.querySelector(".a-text");
    const text = el ? el.textContent : "";
    const stick = { gap: chatScroll.scrollHeight - chatScroll.clientHeight - chatScroll.scrollTop, tall: chatScroll.scrollHeight > chatScroll.clientHeight + 200, has60: text.includes("第 60 行") };
    // 人往上翻着看历史：新字到了不拽他，落屏那一下照样亮「有新内容」
    chatScroll.scrollTop = 0;
    await sleep(60);
    frame();
    toBottom.classList.remove("new");
    const top0 = chatScroll.scrollTop, stuck0 = chatStick;
    for (let i = 61; i <= 70; i++) { ui.handleEvent({ type: "text", delta: "第 " + i + " 行\\n\\n" }); frame(); }
    await sleep(180);
    frame();
    const away = { stuck0, flagged: toBottom.classList.contains("new"), top: chatScroll.scrollTop, top0, has70: (ui.body.querySelector(".a-text") || {}).textContent.includes("第 70 行") };
    ui.finish();
    frame();
    return { had, first, burst, painted, stick, away };
  } finally {
    window.requestAnimationFrame = oRaf; window.scrollBottom = oSB;
    chatCol.innerHTML = ""; sessionId = keepSid; chatStick = keepStick;
    toBottom.classList.remove("new");
  }
})`;

// ② 出字：每个 token 在这一轮的子树上跑几次 querySelector（找重试条、找思考提示）
const TOKEN_QUERIES = `((variant) => {
  let make = createTurnUI, had = true;
  if (variant === "old") {
    const src = createTurnUI.toString();
    const a1 = "for (const c of body.children) if (c.classList.contains(\\"retry-bar\\")) { c.remove(); break; }";
    const a2 = "const hint = thinkHints[0];";
    had = src.includes(a1) && src.includes(a2);
    (0, eval)(src.replace(a1, "body.querySelector(\\":scope > .retry-bar\\")?.remove();")
      .replace(a2, "const hint = body.querySelector(\\".thinking-hint\\");")
      .replace("function createTurnUI(", "function createTurnUIOldQuery("));
    make = window.createTurnUIOldQuery;
  }
  const oQS = Element.prototype.querySelector;
  let target = null, qs = 0;
  Element.prototype.querySelector = function () { if (this === target) qs++; return oQS.apply(this, arguments); };
  const keepSid = sessionId;
  try {
    sessionId = "rp_q_" + variant;
    chatCol.innerHTML = "";
    const ui = make("量一下每个字查几遍子树", "craft", sessionId);
    target = ui.body;
    // 一轮做了一阵子：几张工具卡、过程区里挂着第 2 步的思考提示、顶上一条重试倒计时
    ui.handleEvent({ type: "step_start", step: 1 });
    for (let i = 0; i < 12; i++) {
      ui.handleEvent({ type: "tool_use", id: "t" + i, name: "read_file", input: { path: "a" + i + ".md" } });
      ui.handleEvent({ type: "tool_result", id: "t" + i, name: "read_file", output: "第 " + i + " 份的内容\\n".repeat(20) });
    }
    ui.handleEvent({ type: "step_start", step: 2 });
    ui.handleEvent({ type: "status", text: "上游 429，5 秒后重试", retry: { attempt: 1, total: 3, delayMs: 5000 } });
    const before = { hint: !!ui.body.querySelector(".thinking-hint"), bar: !!ui.body.querySelector(".retry-bar") };
    ui.handleEvent({ type: "text", delta: "开口了。" });
    const after = { hint: !!ui.body.querySelector(".thinking-hint"), bar: !!ui.body.querySelector(".retry-bar") };
    qs = 0;
    for (let i = 0; i < 60; i++) ui.handleEvent({ type: "text", delta: "字" });
    const per = qs / 60;
    ui.finish();
    return { had, before, after, per, nodes: ui.body.getElementsByTagName("*").length };
  } finally {
    Element.prototype.querySelector = oQS;
    chatCol.innerHTML = ""; sessionId = keepSid;
  }
})`;

// ③ 侧栏渐隐：内容一变，是当场（微任务里、版还脏着）读 scrollHeight，还是攒到下一帧开头读一次
const FADE = `(async (variant) => {
  const frames = (n) => new Promise((r) => { const step = () => (n-- > 0 ? requestAnimationFrame(step) : r()); step(); setTimeout(r, 2000); });
  let fn = fadeOnOverflow, had = true;
  if (variant === "old") {
    const src = fadeOnOverflow.toString();
    had = src.includes("new MutationObserver(syncSoon)");
    (0, eval)(src.replace("new MutationObserver(syncSoon)", "new MutationObserver(sync)").replace("function fadeOnOverflow(", "function fadeOnOverflowOld("));
    fn = window.fadeOnOverflowOld;
  }
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;left:-4000px;top:0;width:200px;height:60px;overflow:auto";
  document.body.appendChild(el);
  try {
    fn(el);
    await frames(2);
    let reads = 0;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get() { reads++; return desc.get.call(this); } });
    for (let i = 0; i < 20; i++) {
      const row = document.createElement("div");
      row.style.height = "20px";
      row.textContent = "第 " + i + " 行";
      el.appendChild(row);
      await null; await null; // 观察器的回调在这两拍之间跑完：跟一趟任务里改一下 DOM、接着干别的一样
    }
    const inTask = reads;
    await frames(2);
    return { had, inTask, inFrame: reads - inTask, more: el.classList.contains("sc-more") };
  } finally { el.remove(); }
})`;

// ④ 发送键：状态没变时敲字 / 反复同步，按钮上一次写都不许有
const SEND = `(async (variant) => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let fn = syncSendBtn, had = true;
  if (variant === "old") {
    const src = syncSendBtn.toString();
    const i = src.indexOf("const icon = stopMode");
    had = i > 0;
    const tail = 'sendBtn.innerHTML = ic(stopMode ? "square" : queueMode ? "hourglass" : "arrow-up");\\n'
      + '  sendBtn.title = stopMode ? "让我停下（Esc）" : cli ? "插一句给终端里的它（Enter）" : queueMode ? "排到队尾：不打断现在这件事，做完了自己开始（Enter）" : busy ? "插一句进去，我做完这一步就看（Enter）" : "发送（Enter）";\\n}';
    (0, eval)((i > 0 ? src.slice(0, i) + tail : src).replace("function syncSendBtn(", "function syncSendBtnOld("));
    fn = window.syncSendBtnOld;
  }
  const count = async (step, n) => {
    const recs = [];
    const mo = new MutationObserver((rs) => { for (const r of rs) recs.push(r); });
    mo.observe(sendBtn, { childList: true, attributes: true, characterData: true, subtree: true });
    for (let k = 0; k < n; k++) { step(k); await tick(); }
    await tick();
    mo.disconnect();
    return { all: recs.length, child: recs.filter((r) => r.type === "childList").length, attr: recs.filter((r) => r.type === "attributes").length };
  };
  const keepVal = inputEl.value, keepSid = sessionId;
  try {
    sessionId = "rp_send_" + variant;
    inputEl.value = "";
    fn(); await tick();
    const res = { had };
    // 真打字：走输入框上挂着的那条 input 监听（改动版才挂在上面，老版只能直接调）
    if (variant !== "old") res.typing = await count(() => { inputEl.value += "字"; inputEl.dispatchEvent(new Event("input")); }, 30);
    res.same = await count(() => fn(), 30);
    // 英文界面：词典把 title 原地换成英文，拿 sendBtn.title 比就永远对不上。
    // 挑词典里有的那句（跟着终端那趟时的「插一句给终端里的它」）来量，词典那一下写才真会发生
    const keepCli = cliWatch;
    cliWatch = { id: sessionId, live: true };
    I18N.setLang("en"); await tick();
    fn(); await tick();
    res.enTitle = sendBtn.title;
    res.en = await count(() => fn(), 30);
    I18N.setLang("zh"); await tick();
    cliWatch = keepCli;
    fn(); await tick();
    // 行为不变：停到一半（stopTask 把按钮换成「…」）之后要重画回来；忙/闲、有没有字，图标和说法照旧跟着变
    sendBtn.textContent = "…"; sendBtn.title = "正在停…";
    inputEl.value = "";
    fn();
    res.restored = { svg: !!sendBtn.querySelector("svg"), title: sendBtn.title };
    runningSessions.set(sessionId, { ui: null });
    fn();
    res.stop = { cls: sendBtn.classList.contains("stop"), icon: sendBtn.innerHTML.includes("square"), title: sendBtn.title };
    inputEl.value = "插一句";
    fn();
    res.interject = { cls: sendBtn.classList.contains("interject"), icon: sendBtn.innerHTML.includes("arrow-up"), title: sendBtn.title };
    runningSessions.delete(sessionId);
    inputEl.value = "";
    fn();
    res.idle = { icon: sendBtn.innerHTML.includes("arrow-up"), title: sendBtn.title, stop: sendBtn.classList.contains("stop") };
    return res;
  } finally {
    runningSessions.delete(sessionId);
    inputEl.value = keepVal; sessionId = keepSid;
    syncSendBtn();
  }
})`;

// ⑤ 侧栏键盘语义：一行被换掉、另一行改了标题，观察器是只补新挂上来的那行，还是把几百行从头标一遍
const ARM_PROBE = `(async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const h = document.getElementById("history");
  h.innerHTML = Array.from({ length: 300 }, (_, i) => '<div class="hist-item" data-id="s' + i + '"><span class="ht">任务 ' + i + '</span><button type="button" class="hx">x</button></div>').join("");
  await tick(); await tick();
  const oMA = window.markActivatable;
  let calls = 0;
  window.markActivatable = function () { calls++; return oMA.apply(this, arguments); };
  const recs = [];
  const mo = new MutationObserver((rs) => { for (const r of rs) recs.push(r); });
  mo.observe(h, { attributes: true, subtree: true, attributeFilter: ["data-activate", "tabindex", "role"] });
  h.children[5].querySelector(".ht").textContent = "任务 5 改名了"; // 行内局部更新（标题、在跑的点）
  const fresh = document.createElement("div");                     // 整行换掉（patchHistRows 换的就是整行）
  fresh.className = "hist-item"; fresh.dataset.id = "s7";
  fresh.innerHTML = '<span class="ht">任务 7 新的</span><button type="button" class="hx">x</button>';
  h.children[7].replaceWith(fresh);
  await tick(); await tick();
  mo.disconnect();
  window.markActivatable = oMA;
  const rows = [...h.children];
  return {
    calls,
    writesOnOld: recs.filter((r) => r.target !== fresh).length,
    fresh: { tab: fresh.tabIndex, act: fresh.dataset.activate || "", role: fresh.getAttribute("role") || "" },
    allMarked: rows.every((r) => r.tabIndex === 0 && r.dataset.activate === "1"),
    nav: (() => { const n = document.querySelector(".side-nav .item"); return n.tabIndex === 0 && n.dataset.activate === "1" && n.getAttribute("role") === "button"; })(),
  };
})()`;

// 一扇干净的小窗反复用：每一版都重新导航一次，前一版挂的观察器跟着页面一起没了
let sandbox = null, sandboxN = 0;
async function armSandbox(maSrc, kbdSrc) {
  if (!sandbox) {
    sandbox = new BrowserWindow({ show: false, x: -20000, y: -20000, width: 400, height: 300, webPreferences: { offscreen: true, backgroundThrottling: false } });
    wins.push(sandbox);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>arm ${++sandboxN}</title><div class="side-nav"><div class="item">导航</div></div><div id="proj-list"></div><div id="history"></div>`;
  await sandbox.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const js = (s) => sandbox.webContents.executeJavaScript(s);
  await js(maSrc + "\n" + kbdSrc + "\ntrue");
  return js(ARM_PROBE);
}

let log = "";
app.whenReady().then(async () => {
  setTimeout(() => { console.log("❌ 整套跑了 150 秒还没完，按挂处理"); finish(1); }, 150000);

  console.log("\n侧栏键盘语义：只补新挂上来的行");
  ok(!!MA_SRC && MA_SRC.includes(MA_GUARD) && !!KBD_SRC && KBD_SRC.includes(MO_NEW), "app-00-ui.js 里切得到 markActivatable 和键盘那段（带着这次的两处改动）", { ma: MA_SRC.length, kbd: KBD_SRC.length });
  const armNew = await armSandbox(MA_SRC, KBD_SRC);
  ok(armNew.calls === 1 && armNew.writesOnOld === 0, "300 行里换掉一行、改了一行标题：只给新挂上来的那一行补一次，别的行一个属性都不写", armNew);
  // 行里带着删除键：只给焦点不加 role（按钮套按钮，读屏会把里面那颗吞掉）；导航项没有子按钮，念成按钮
  ok(armNew.fresh.tab === 0 && armNew.fresh.act === "1" && armNew.fresh.role === "" && armNew.allMarked && armNew.nav,
    "行为不变：新行 Tab 停得到、Enter 认得出；老行和导航项的标记都还在", armNew);
  const armOldObs = await armSandbox(MA_SRC, KBD_SRC.replace(MO_NEW, "new MutationObserver(arm)"));
  ok(armOldObs.calls >= 300, "★反向对照★ 观察器退回「动一下就全页重标」：同样两处改动，300 行挨个再标一遍", { calls: armOldObs.calls });
  const armOld = await armSandbox(MA_SRC.replace(MA_GUARD, 'el.dataset.activate = "1";'), KBD_SRC.replace(MO_NEW, "new MutationObserver(arm)"));
  ok(armOld.writesOnOld >= 299, "★反向对照★ 再把「已经是 1 就不写」也撤掉（原来的样子）：没换掉的 299 行照样被写一遍属性", { writesOnOld: armOld.writesOnOld });

  for (let i = 0; i < 100 && !child; i++) await sleep(50);
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  let port = 0;
  for (let i = 0; i < 300 && !port; i++) { const m = /已启动: http:\/\/localhost:(\d+)/.exec(log); if (m) port = +m[1]; else await sleep(200); }
  if (!port) { console.log("❌ server 没起来：" + log.slice(-800)); return finish(1); }
  const base = "http://127.0.0.1:" + port;
  const part = "rp-" + Date.now();
  await session.fromPartition(part).cookies.set({ url: base, name: "openworkbuddy_token", value: tok });
  const win = new BrowserWindow({ show: false, x: -20000, y: -20000, width: 1300, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false, partition: part } });
  wins.push(win);
  await win.loadURL(base + "/");
  const js = (s) => win.webContents.executeJavaScript(s);
  const up = await waitFor(() => js(`document.readyState === "complete" && typeof createTurnUI === "function" && typeof syncSendBtn === "function" && typeof fadeOnOverflow === "function" && typeof I18N === "object"`).catch(() => false), 20000, 100);
  if (!up) { console.log("❌ 页面没起来：" + log.slice(-800)); return finish(1); }
  // 钉中文：下面比的 title 是中文原文，CI 那台是英文系统
  await js('I18N.setLang("zh")');
  await sleep(1000); // 开机那几下请求（侧栏、设置）先落地

  console.log("\n出字：token 进来不排帧，落屏那一下才滚");
  const t = await js(`${TOKEN_FRAMES}("new")`);
  ok(t.first.sb === 1 && !t.first.hint, "第一个字摘掉思考提示（内容变矮）：这一下照滚", t.first);
  ok(t.burst.req === 0 && t.burst.sb === 0, "接下来 60 个 token 各隔一帧进来：一次 rAF 都不排、一次 scrollBottom 都不叫", t.burst);
  ok(t.painted.sb >= 1, "100ms 那一帧落屏：滚到底由它叫", t.painted);
  ok(t.stick.has60 && t.stick.tall && t.stick.gap <= 2, "行为不变：字全落到 DOM，人在底下时停在最底", t.stick);
  ok(t.away.stuck0 === false && t.away.flagged && Math.abs(t.away.top - t.away.top0) <= 1 && t.away.has70,
    "行为不变：人往上翻着看历史，新字到了不拽滚动条，「有新内容」照样亮", t.away);
  const tOld = await js(`${TOKEN_FRAMES}("old")`);
  ok(tOld.had && tOld.burst.req >= 60, "★反向对照★ 出字那一支照旧走到末尾那句 scrollBottom：60 个 token 排 60 次 rAF", { had: tOld.had, burst: tOld.burst });

  console.log("\n出字：每个 token 不再把整轮子树查两遍");
  const q = await js(`${TOKEN_QUERIES}("new")`);
  ok(q.per === 0, `一轮 ${q.nodes} 个节点（12 张工具卡）里连出 60 个 token：这一轮上的 querySelector 每个 token 0 次`, q);
  ok(q.before.hint && q.before.bar && !q.after.hint && !q.after.bar, "行为不变：开口第一个字就把过程区里的思考提示和顶上的重试条都撤掉", q);
  const qOld = await js(`${TOKEN_QUERIES}("old")`);
  ok(qOld.had && qOld.per >= 2, "★反向对照★ 退回 body.querySelector 找重试条和思考提示：每个 token 2 次整轮查找", { had: qOld.had, per: qOld.per });

  console.log("\n侧栏渐隐：内容变了攒到下一帧再量");
  const f = await js(`${FADE}("new")`);
  ok(f.inTask === 0, "连改 20 次内容：改的那一路上一次 scrollHeight 都不读（不逼排版）", f);
  ok(f.inFrame >= 1 && f.inFrame <= 2 && f.more, "下一帧开头量一次，渐隐照样挂上（内容比框高）", f);
  const fOld = await js(`${FADE}("old")`);
  ok(fOld.had && fOld.inTask >= 20, "★反向对照★ 观察器直接调 sync：改一次读一次，20 次改动 20 次当场排版", { had: fOld.had, inTask: fOld.inTask });

  console.log("\n发送键：状态没变不重写");
  const s = await js(`${SEND}("new")`);
  ok(s.typing.all === 0, "闲着时打 30 个字：发送键上 0 次写入", s.typing);
  ok(s.same.all === 0, "同一状态反复同步 30 次：0 次写入", s.same);
  ok(s.enTitle === "Chime in to the terminal run (Enter)" && s.en.all === 0, "英文界面（词典把 title 换成了英文）：同样 0 次写入，英文说法留着", { title: s.enTitle, en: s.en });
  ok(s.restored.svg && s.restored.title === "发送（Enter）", "行为不变：「正在停…」之后同步一次，图标和说法画回来", s.restored);
  ok(s.stop.cls && s.stop.icon && s.stop.title === "让我停下（Esc）" && s.interject.cls && s.interject.icon && /^插一句进去/.test(s.interject.title) && s.idle.icon && !s.idle.stop && s.idle.title === "发送（Enter）",
    "行为不变：跑着+空框是停止、跑着+有字是插一句、闲下来回到发送", { stop: s.stop, interject: s.interject, idle: s.idle });
  const sOld = await js(`${SEND}("old")`);
  ok(sOld.had && sOld.same.child >= 30 && sOld.same.attr >= 30, "★反向对照★ 原来的写法：同一状态同步 30 次，svg 拆了重建 30 次、title 重写 30 次", { had: sOld.had, same: sOld.same });
  ok(sOld.en.attr >= 60 && sOld.en.child >= 30, "★反向对照★ 英文界面下原来的写法：每次写中文、词典再换回英文，一次同步两次属性写", sOld.en);

  finish(fail ? 1 : 0);
}).catch((e) => { console.error("❌ 界面线程热路径测试自己炸了：", (e && e.stack) || e); finish(1); });
