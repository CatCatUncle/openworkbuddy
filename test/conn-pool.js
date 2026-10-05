// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 同时跑 8 个对话：这一页只占一两条连接，点开别的对话、停止、预览照样秒回。
 *
 * 跑法：npx electron test/conn-pool.js（node 跑会自己换成 electron 再拉起一遍）
 *
 * 2026-09-28 实测：同时跑 6 个对话以后，点开另一条对话半分钟出不来、点停止没反应、预览一片白。
 * 服务端一点不慢——Chromium 对同一主机最多开 6 条 HTTP/1.1 连接，每个在跑的对话各攥一条长连接
 * （发任务那条 POST 的 SSE、断线后的续流），6 条攥满以后这一页别的请求全在浏览器里排队，连服务端都没到。
 * 现在整页只留一条 /api/chat/live，按对话分流（见 app-02.js 的 liveCh、server.js 的 lastRuns）。
 *
 * 起真 server.js + 假模型（带「长跑」的那几轮攥着不回），一页接上 8 趟在跑的，判据：
 *   - 这一页为跑着的任务攥着的请求 ≤ 2 条（整页那条直播，外加重开那一下新旧交接）；
 *   - 点开一条跑完的对话、停止、开预览服务，各自 1 秒内回来；预览里的网页 1 秒内 load；
 *   - 断线重连一次，已经画过的事件一条都不重发（中间夹着写文件的 files 事件也一样）。
 * ★反向对照★ 另开一个窗口（独立的连接池），把 liveCh.off 打开退回每趟一条流的老路，
 *   同样 8 趟在跑：攥着的 ≥ 6 条，上面那四样一样都没在 1 秒内回来。
 *
 * 后半截在一个干净窗口里换掉 fetch，逐片判前端的几处修复，每片都拿「去掉修复」的那份对照：
 *   点开的对话回来晚了不许画进后点的那条 / 取记录卡住给「重试」/ 刷新接回叠两遍只接一份、只收尾一次 /
 *   接回时换掉的是死的那轮不是活的 / 后台对话的字不排版、切回来一次画齐 / 打不开本机文件夹时产出清单照画 /
 *   后台那条开跑不撤眼前这条的「重新生成」。
 */

const { entry } = require("./lib/entry");
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron，连接池占满这件事只在真页面上犯");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 300000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

let pass = 0, fail = 0;
let child = null, llm = null, home = "", finished = false;
const wins = [];
const held = []; // 假模型攥着没回的请求
let released = false;

function finish(code) {
  if (finished) return;
  finished = true;
  for (const w of wins) { try { if (!w.isDestroyed()) w.destroy(); } catch {} }
  try { if (child) child.kill(); } catch {}
  try { for (const h of held.splice(0)) h.res.destroy(); } catch {}
  try { if (llm) { if (llm.closeAllConnections) llm.closeAllConnections(); llm.close(); } } catch {}
  try { if (home) fs.rmSync(home, { recursive: true, force: true }); } catch {}
  console.log(`\n连接池：${pass} 过 / ${fail} 挂`);
  require("electron").app.exit(code);
}
process.on("uncaughtException", (e) => { console.error("❌ 连接池测试自己炸了：", (e && e.stack) || e); finish(1); });
process.on("unhandledRejection", (e) => { console.error("❌ 连接池测试自己炸了：", (e && e.stack) || e); finish(1); });

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { spawn } = require("child_process");
const { app, BrowserWindow, session } = require("electron");
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-conn-pool-"));
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

// ---------- 假模型 ----------
// 不带工具的（起标题这类旁路调用）秒回；带「写文件」的第一步先写一个文件（要让记录里夹一条 files 事件）；
// 带「长跑」的攥着不回，等 releaseAll()；其余秒回「收到：…」
const say = (text) => ({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
const reply = (res, body) => {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
function releaseAll() {
  released = true;
  for (const h of held.splice(0)) reply(h.res, say("收到：" + h.text.slice(0, 20)));
}
let callSeq = 0;
llm = http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let b = {}; try { b = JSON.parse(raw); } catch {}
    const msgs = b.messages || [];
    const users = msgs.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    const last = users[users.length - 1] || "";
    const all = users.join("\n");
    if (!Array.isArray(b.tools) || !b.tools.length) return reply(res, say("好的"));
    if (/写文件/.test(all) && !msgs.some((m) => m.role === "tool")) {
      const tag = (/写文件 长跑 (\d+)/.exec(all) || [])[1] || "x";
      return reply(res, { choices: [{ message: { role: "assistant", content: "先写个文件。", tool_calls: [{
        id: "call_" + ++callSeq, type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: `out_${tag}.html`, content: `<h1>第 ${tag} 份</h1>` }) },
      }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    }
    if (/长跑/.test(all) && !released) { held.push({ res, text: last }); return; }
    reply(res, say("收到：" + last.slice(0, 20)));
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
  cfg.agent = { ...(cfg.agent || {}), max_steps: 4, llm_timeout_ms: 180000 };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
  child = spawn(process.env.OWB_NODE || "node", [entry("server")], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: "0" },
  });
});

// ---------- 记账口径对齐（不开窗口，直接把两边的代码切出来放 vm 里对） ----------
// 服务端 recordingEmit 记什么、前端 makeRecCounter 数什么，必须一条不差：重连时前端报的位置就是拿后者算的。
// 2026-09-28 查四份正在跑的记录，接回来时分别重放了 14、14、5 条——前端没数 files 事件，还把它后面当成「文字没完」
function recParity() {
  console.log("\n记账口径：服务端记的 vs 前端数的");
  const serverSrc = fs.readFileSync(entry("server"), "utf8");
  const a = serverSrc.indexOf("function recordingEmit(");
  const recSrc = serverSrc.slice(a, serverSrc.indexOf("\nconst app = express();", a));
  const appSrc = fs.readFileSync(path.join(ROOT, "public", "js", "app-02.js"), "utf8");
  const c = appSrc.indexOf("function makeRecCounter()");
  const rcSrc = appSrc.slice(c, appSrc.indexOf("\n/** 读一条 SSE 流", c));
  if (a < 0 || c < 0 || !/return st;\s*\}\s*$/.test(rcSrc.trim() + "\n")) { ok(false, "recordingEmit / makeRecCounter 没切到", { a, c }); return; }
  const load = (counterSrc) => {
    const ctx = vm.createContext({ petSay() {}, autosaveSession() {} });
    vm.runInContext(recSrc + "\n" + counterSrc, ctx);
    return ctx;
  };
  const seq = [
    { type: "text", delta: "先看看" }, { type: "text", delta: "目录。" },
    { type: "tool_use", name: "list_dir", input: {} }, { type: "tool_result", name: "list_dir", output: "a" },
    { type: "files", changed: ["a.html"], files: [{ name: "a.html" }] },
    { type: "text", delta: "写好了" },
    { type: "files", changed: [], files: [] },
    { type: "usage", prompt: 1, completion: 1 },
    { type: "text", delta: "子任务的话", depth: 1 },
    { type: "text", delta: "，接着说。" },
    { type: "files", changed: ["b.html"], files: [] },
    { type: "dir", dir: "/x" },
    { type: "text", delta: "完。" },
  ];
  // 跟 /api/chat/live 补发那一段同一个口径：from 起全补，第一条是文本就只补 textOffset 之后的，一个字都没多就不发
  const replay = (evs, from, off) => {
    const out = [];
    for (let k = from; k < evs.length; k++) {
      if (k === from && off && evs[k].type === "text") { const rest = String(evs[k].delta).slice(off); if (rest) out.push(rest); }
      else out.push(evs[k]);
    }
    return out;
  };
  const resent = (ctx) => {
    let n = 0;
    for (let cut = 0; cut <= seq.length; cut++) {
      const events = [];
      const emit = ctx.recordingEmit(() => {}, events, "S", { pet: false });
      const rc = ctx.makeRecCounter();
      for (let i = 0; i < cut; i++) { emit(JSON.parse(J(seq[i]))); rc.feed(JSON.parse(J(seq[i]))); }
      const from = rc.lastIsText ? rc.n - 1 : rc.n, off = rc.lastIsText ? rc.textLen : 0;
      n += replay(events, from, off).length; // 前端这一刻已经看过发出来的每一条：补发的每一帧都是重的
    }
    return n;
  };
  ok(resent(load(rcSrc)) === 0, "在任何一处断开重连：补发 0 条（中间夹着 files、空 files、子任务文字、dir）");
  const noFiles = rcSrc.replace(/\n\s*else if \(ev\.type === "files"[^\n]*\n/, "\n");
  const n0 = noFiles !== rcSrc ? resent(load(noFiles)) : -1;
  ok(n0 > 0, "反向对照：前端不数 files 那一行，同样的断点补发了重的", n0);
}

// ---------- 页面这边的几样工具 ----------
/** 用调试协议数这一页「为跑着的任务」攥着的请求：整页直播、老的续流、发任务那条 POST */
function trackRunStreams(wc) {
  const inflight = new Map();
  let peak = 0;
  const isRun = (url, method) => {
    let p = "";
    try { p = new URL(url).pathname; } catch { return false; }
    return p === "/api/chat/live" || p.startsWith("/api/chat/stream/") || (p === "/api/chat" && method === "POST");
  };
  wc.debugger.attach("1.3");
  wc.debugger.on("message", (_e, method, params) => {
    if (method === "Network.requestWillBeSent") {
      if (isRun(params.request.url, params.request.method)) { inflight.set(params.requestId, params.request.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 60)); peak = Math.max(peak, inflight.size); }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") inflight.delete(params.requestId);
  });
  return { ready: wc.debugger.sendCommand("Network.enable"), get n() { return inflight.size; }, get peak() { return peak; }, list: () => [...inflight.values()] };
}

// 四样量时间的动作。3 秒封顶：老路下它们会一直排队，不封顶测试就跟着卡死
const MEASURE = `(() => {
  const cap = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 3000))]);
  const LATE = 99999;
  window.__m = {
    async open(sid, want) {
      const t0 = performance.now();
      const r = await cap(openSession(sid).then(() => true));
      const dt = r ? performance.now() - t0 : LATE;
      return { dt, shown: [...chatCol.querySelectorAll(".turn .bubble")].some((b) => b.textContent.includes(want)) };
    },
    async preview() {
      const t0 = performance.now();
      const st = await cap(startPreview(false));
      return { dt: st ? performance.now() - t0 : LATE, running: !!(st && st.running) };
    },
    async stop(sid) {
      const t0 = performance.now();
      const d = await cap(fetch("/api/chat/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sid }) }).then((r) => r.json()));
      return { dt: d ? performance.now() - t0 : LATE, answered: !!d, ok: !!(d && d.ok) };
    },
    async frame(name) {
      const t0 = performance.now();
      previewFile(name);
      const fr = document.querySelector("#pv-body .pv-fit iframe");
      const note = (document.querySelector("#pv-body .pv-loading") || {}).textContent || "";
      if (!fr) return { dt: LATE, fr: false, note };
      const r = await cap(new Promise((res) => fr.addEventListener("load", () => res(true), { once: true })));
      return { dt: r ? performance.now() - t0 : LATE, fr: true, note, gone: !document.querySelector("#pv-body .pv-loading") };
    },
  };
  return true;
})()`;

// 换掉页面的 fetch：按路径挂假回应，别的照走真的。假回应都认 signal——真 fetch 被掐会抛 AbortError，这里也得一样
const STUB = `(() => {
  if (window.__stubs) return true;
  window.__realFetch = window.fetch;
  window.__stubs = {};
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const h = window.__stubs[new URL(url, location.href).pathname];
    return h ? h(url, init || {}) : window.__realFetch.apply(this, arguments);
  };
  const abortErr = () => new DOMException("The operation was aborted.", "AbortError");
  window.__json = (obj, ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortErr());
    const t = ms >= 0 ? setTimeout(() => resolve(new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } })), ms) : 0;
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(abortErr()); }, { once: true });
  });
  window.__sse = (frames, signal) => {
    const enc = new TextEncoder();
    const timers = [];
    const body = new ReadableStream({ start(c) {
      c.enqueue(enc.encode(": ok\\n\\n"));
      for (const [ms, obj] of frames) timers.push(setTimeout(() => { try { c.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\\n\\n")); } catch {} }, ms));
      if (signal) signal.addEventListener("abort", () => { timers.forEach(clearTimeout); try { c.error(abortErr()); } catch {} }, { once: true });
    } });
    return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  };
  // 假直播：订上来的每一趟 300ms 后说一声跑完了
  window.__liveEnd = (u, i) => {
    const raw = new URL(u, location.href).searchParams.get("subs") || "";
    const sids = raw.split(",").filter(Boolean).map((x) => decodeURIComponent(x.split(":")[0]));
    return window.__sse(sids.map((sid) => [300, { sid, end: true }]), i.signal);
  };
  window.__T = (...pairs) => pairs.flatMap(([q, a]) => [{ type: "user", text: q, mode: "craft" }, { type: "assistant", events: a == null ? [] : [{ type: "text", delta: a }] }]);
  window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__bubbles = () => [...chatCol.querySelectorAll(".turn")].map((t) => ((t.querySelector(".bubble") || {}).textContent || "").trim());
  return true;
})()`;

// 修之前的 reattachRunning 原样一份（只改了名字），反向对照用：两次接回叠在一起时它会接两份
const OLD_REATTACH = `async function reattachRunningOld() {
  let ids = [];
  try { const r = await fetch("/api/chat/running"); if (r.ok) ids = await r.json(); } catch {}
  for (const sid of ids) {
    if (runningSessions.has(sid)) continue;
    let data = null;
    try { data = await fetch("/api/session/" + encodeURIComponent(sid)).then((r) => r.json()); } catch {}
    if (data && data.dir) sessionDirs.set(sid, data.dir);
    if (data && data.model) sessionModels.set(sid, data.model);
    if (data && data.goal) sessionGoals.set(sid, data.goal);
    const t = (data && data.transcript) || [];
    const lastUser = t.map((e) => e.type).lastIndexOf("user");
    if (lastUser < 0) continue;
    const evs = (t[lastUser + 1] && t[lastUser + 1].events) || [];
    const ui = createTurnUI(t[lastUser].text, t[lastUser].mode, sid, t[lastUser].shown);
    const rc = makeRecCounter();
    isReplaying = true;
    try { for (const ev of evs) { rc.feed(ev); ui.handleEvent(ev); } } finally { isReplaying = false; }
    runningSessions.set(sid, { ui });
    if (sid === sessionId) {
      const turns = chatCol.querySelectorAll(".turn");
      if (turns.length) turns[turns.length - 1].remove();
      document.getElementById("empty")?.remove();
      chatCol.appendChild(ui.turn);
      scrollBottom(true);
    }
    updateSendUI();
    keepAttached(sid, ui, rc, false, null).then(() => endRun(sid, ui));
  }
}`;

// 服务端记录里会有的那几种（跟 recordingEmit 同一张表）；不进记录的 dir/goal/title/sweep/空 files/done 不比
const KEEP = new Set(["tool_use", "tool_result", "parallel", "expert_start", "expert_done", "error", "limit", "auto_continue", "failover", "sleep", "trim", "compact", "usage", "interject", "worktree", "credits", "sources", "ask_user", "ask_answer", "milestones", "todos", "context", "trace"]);
function tally(evs) {
  const types = {};
  let text = 0;
  for (const ev of evs || []) {
    if (ev.type === "text") { if (!(ev.depth > 0)) text += String(ev.delta || "").length; continue; }
    if (KEEP.has(ev.type) || (ev.type === "files" && (ev.changed || []).length)) types[ev.type] = (types[ev.type] || 0) + 1;
  }
  const n = Object.values(types).reduce((x, y) => x + y, 0);
  return { n, text, types: Object.keys(types).sort().map((k) => k + ":" + types[k]).join(",") };
}

let log = "";
app.whenReady().then(async () => {
  setTimeout(() => { console.log("❌ 整套跑了 4 分钟还没完，按挂处理"); finish(1); }, 240000);
  recParity();

  for (let i = 0; i < 100 && !child; i++) await sleep(50);
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  let port = 0;
  for (let i = 0; i < 300 && !port; i++) { const m = /已启动: http:\/\/localhost:(\d+)/.exec(log); if (m) port = +m[1]; else await sleep(200); }
  if (!port) { console.log("❌ server 没起来：" + log.slice(-800)); return finish(1); }
  const base = "http://127.0.0.1:" + port;
  const api = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const rq = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      Cookie: "openworkbuddy_token=" + tok, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
    } }, (r) => {
      let s = ""; r.setEncoding("utf8");
      r.on("data", (c) => (s += c));
      r.on("end", () => resolve({ status: r.statusCode, type: String(r.headers["content-type"] || ""), text: s }));
    });
    rq.on("error", reject);
    rq.end(data || undefined);
  });
  const lastAsst = async (sid) => {
    let d = {};
    try { d = JSON.parse((await api("GET", "/api/session/" + encodeURIComponent(sid))).text); } catch {}
    const t = d.transcript || [];
    const a = [...t].reverse().find((e) => e.type === "assistant");
    return (a && a.events) || [];
  };

  const stamp = Date.now();
  const R = Array.from({ length: 8 }, (_, i) => `cp_${stamp}_r${i + 1}`);
  const DONE = `cp_${stamp}_done`;
  // 一条早就跑完的对话（点开它量时间），一份网页（预览里 load 它）
  await api("POST", "/api/chat", { sessionId: DONE, message: "你好第一轮", mode: "craft" });
  const saved = await api("POST", "/api/files/save", { name: "demo.html", content: "<!doctype html><meta charset=utf-8><title>demo</title><h1>预览页</h1>" });
  ok(saved.status === 200, "准备：跑完一轮的对话、一份 demo.html", saved.text.slice(0, 200));

  const openWin = async (part) => {
    await session.fromPartition(part).cookies.set({ url: base, name: "openworkbuddy_token", value: tok });
    // 不同 partition = 不同的连接池：老路那个窗口占满了也挤不到这边
    const win = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false, partition: part } });
    wins.push(win);
    await win.loadURL("about:blank"); // 还没导航过的页面，Network.enable 会一直等不回来
    const net = trackRunStreams(win.webContents);
    await net.ready;
    await win.loadURL(base + "/");
    const js = (s) => win.webContents.executeJavaScript(s);
    await waitFor(() => js(`document.readyState === "complete" && typeof liveCh === "object" && typeof reattachRunning === "function"`).catch(() => false), 15000, 100);
    // 钉中文：下面比的「等了 N 秒没等到」「正在载入页面…」都是中文原文，CI 那台是英文系统，不钉就是在比另一份界面
    await js('I18N.setLang("zh")');
    await sleep(1200); // 开机那几下请求（侧栏、设置、预览状态）先落地
    await js(MEASURE);
    return { win, js, net };
  };
  // 两个窗口都在任务开跑之前打开：开机那次接回什么都接不到，接不接、走哪条路由下面说了算
  const M = await openWin("cp-main");
  const O = await openWin("cp-old");

  console.log("\n8 趟同时在跑：这一页（整页一条直播）");
  for (let i = 0; i < 6; i++) {
    const r = await api("POST", "/api/chat", { sessionId: R[i], message: "长跑 " + (i + 1), mode: "craft", detach: true });
    if (!/"accepted":true/.test(r.text)) { ok(false, "detach 发任务没回「收到了」", r.text.slice(0, 200)); return finish(1); }
  }
  const got6 = await M.js(`reattachRunning().then(() => {
    window.__cap = {};
    for (const s of ${J(R.slice(0, 6))}) __cap[s] = (runningSessions.get(s) || {}).ui || null;
    return Object.values(__cap).filter(Boolean).length;
  })`);
  await M.js(`(() => {
    window.__applied = {};
    for (const [sid, text] of ${J([[R[6], "写文件 长跑 7"], [R[7], "写文件 长跑 8"]])}) {
      runTurn(sid, text, "craft");
      const ui = runningSessions.get(sid).ui;
      __cap[sid] = ui;
      const arr = __applied[sid] = [];
      const h = ui.handleEvent;
      ui.handleEvent = (ev) => { arr.push(JSON.parse(JSON.stringify(ev))); return h(ev); };
    }
    return true;
  })()`);
  const up = await waitFor(async () => {
    const run = JSON.parse((await api("GET", "/api/chat/running")).text || "[]");
    if (run.length !== 8) return false;
    for (const sid of R.slice(6)) if (!(await lastAsst(sid)).some((e) => e.type === "files")) return false;
    return (await M.js(`liveCh.subs.size`)) === 8;
  }, 30000, 300);
  ok(got6 === 6 && up, "8 趟都在跑、都挂到了这一页（后两趟中途写了文件，记录里有 files）", { got6, up, held: held.length });
  if (!up) { console.log(log.slice(-1500)); return finish(1); }

  let most = 0;
  for (let i = 0; i < 15; i++) { most = Math.max(most, M.net.n); await sleep(100); }
  ok(most <= 2, "这一页为 8 趟任务攥着的请求 ≤ 2 条", { most, list: M.net.list(), peak: M.net.peak });

  const m1 = await M.js(`__m.open(${J(DONE)}, "你好第一轮")`);
  ok(m1.shown && m1.dt < 1000, "点开一条跑完的对话：1 秒内画出来", m1);
  const m2 = await M.js(`__m.preview()`);
  ok(m2.running && m2.dt < 1000, "开预览服务：1 秒内回话", m2);
  const m3 = await M.js(`__m.stop("cp_nope")`);
  ok(m3.answered && m3.dt < 1000, "点停止：1 秒内回话", m3);
  const m4 = await M.js(`__m.frame("demo.html")`);
  ok(m4.fr && m4.dt < 1000 && m4.note === "正在载入页面…" && m4.gone, "预览里的网页 1 秒内 load；之前挂一句「正在载入页面…」，load 了就撤", m4);

  // 断线重连：R8 原样重连；R7 的计数故意打回 0 当对照，服务端就会把它已经画过的从头再补一遍
  const cut = await M.js(`(() => {
    const s = liveCh.subs.get(${J(R[6])});
    if (!s || !liveCh.ctrl) return false;
    s.rc.n = 0; s.rc.lastIsText = false; s.rc.textLen = 0;
    window.__gen0 = liveCh.gen;
    liveCh.ctrl.abort();
    return true;
  })()`);
  const back = cut && await waitFor(() => M.js(`liveCh.gen > __gen0 && liveCh.subs.size === 8 && !!liveCh.ctrl`), 10000);
  await sleep(1500);
  ok(back, "掐断整页那条直播：自己重连上，8 趟一趟不少", { cut, back });

  console.log("\n★反向对照★ 同样 8 趟，另一个窗口退回每趟一条流的老路");
  await O.js(`liveCh.off = true; reattachRunning(); true`);
  await waitFor(() => O.net.n >= 6, 10000, 100);
  const oldN = O.net.n;
  ok(oldN >= 6, "老路：这一页为跑着的任务攥着 ≥ 6 条请求", { oldN, list: O.net.list() });
  const [o1, o2, o3, o4] = await O.js(`Promise.all([__m.open(${J(DONE)}, "你好第一轮"), __m.preview(), __m.stop("cp_nope"), __m.frame("demo.html")])`);
  ok(!(o1.dt < 1000), "老路：点开跑完的对话 1 秒内出不来", o1);
  ok(!(o2.dt < 1000), "老路：开预览服务 1 秒内没回话", o2);
  ok(!(o3.dt < 1000), "老路：点停止 1 秒内没回话", o3);
  ok(!(o4.dt < 1000), "老路：预览里的网页 1 秒内没 load", o4);
  O.win.destroy();

  console.log("\n收尾");
  const s1 = await M.js(`__m.stop(${J(R[0])})`);
  ok(s1.ok && s1.dt < 1000, "停掉第 1 趟：1 秒内回 ok", s1);
  releaseAll();
  const allDone = await waitFor(() => M.js(`runningSessions.size === 0`), 40000, 300);
  const fin = await M.js(`(() => ({
    subs: liveCh.subs.size,
    got: Object.fromEntries(Object.entries(__cap).map(([k, ui]) => [k, !!ui && /收到/.test(ui.turn.textContent)])),
  }))()`);
  await sleep(300);
  ok(allDone && R.slice(1).every((s) => fin.got[s]), "第 2～8 趟最后那句回答都到了这一页（全走那一条直播）", fin.got);
  ok(allDone && fin.subs === 0 && M.net.n === 0, "都收尾以后，这一页一条跟任务有关的请求都不攥着", { subs: fin.subs, n: M.net.n, list: M.net.list() });

  const applied = await M.js(`__applied`);
  const r8 = { rec: tally(await lastAsst(R[7])), app: tally(applied[R[7]]) };
  const r7 = { rec: tally(await lastAsst(R[6])), app: tally(applied[R[6]]) };
  ok(r8.rec.n > 0 && r8.rec.types.includes("files") && J(r8.rec) === J(r8.app), "重连前后：页面画的跟服务端记的一条不多一条不少（中途写过文件）", r8);
  ok(r7.app.n > r7.rec.n, "反向对照：同一次重连把计数打回 0，已经画过的又画了一遍", r7);

  // ---------- 前端几片：干净窗口，换掉 fetch ----------
  console.log("\n前端几片（换掉 fetch 判）");
  const S = await openWin("cp-slice");
  await S.js(STUB);

  // 点开的对话回来晚了：先点 A（记录要 500ms），60ms 后点 B（30ms）
  const a = await S.js(`(async () => {
    __stubs["/api/session/SA"] = (u, i) => __json({ transcript: __T(["A的问题", "A的回答"]), dir: "/tmp/cp-A", model: "模型A" }, 500, i.signal);
    __stubs["/api/session/SB"] = (u, i) => __json({ transcript: __T(["B的问题", "B的回答"]), dir: "/tmp/cp-B", model: "模型B" }, 30, i.signal);
    const run = async (fn) => {
      for (const m of [sessionDirs, sessionModels]) { m.delete("SA"); m.delete("SB"); }
      const pa = fn("SA"); await __sleep(60); const pb = fn("SB");
      await Promise.all([pa, pb]); await __sleep(700);
      return { sid: sessionId, bub: __bubbles().join("|"), dirB: sessionDirs.get("SB") || "", modelB: sessionModels.get("SB") || "", dirA: sessionDirs.get("SA") || "" };
    };
    const fixed = await run(openSession);
    let src = openSession.toString();
    const had = [src.includes("if (openCtl) openCtl.abort();"), src.includes("if (tok !== openSeq || sessionId !== sid) return;")];
    src = src.replace("if (openCtl) openCtl.abort();", "").replace("if (tok !== openSeq || sessionId !== sid) return;", "");
    let maps = 0;
    src = src.replace(/(session(?:Dirs|Models|Goals)\\.(?:get|set|delete))\\(sid\\b/g, (m, f) => { maps++; return f + "(sessionId"; });
    (0, eval)(src.replace("async function openSession(", "async function openSessionNoGuard("));
    const old = await run(openSessionNoGuard);
    return { fixed, old, had, maps };
  })()`);
  const af = a.fixed;
  ok(af.sid === "SB" && af.bub.includes("B的问题") && !af.bub.includes("A的问题") && af.dirB === "/tmp/cp-B" && af.modelB === "模型B" && !af.dirA,
    "先点 A（慢）再点 B（快）：屏幕上只有 B，B 的文件夹和模型还是 B 的", af);
  ok(a.had.every(Boolean) && a.maps >= 3 && (a.old.bub.includes("A的问题") || a.old.dirB === "/tmp/cp-A"),
    "反向对照：去掉领号和掐请求、表按全局 sessionId 写：晚回来的 A 画进了 B", a);

  // 取记录卡住
  const b = await S.js(`(async () => {
    const keep = OPEN_SESSION_TIMEOUT_MS;
    OPEN_SESSION_TIMEOUT_MS = 600;
    __stubs["/api/session/SH"] = (u, i) => __json({ transcript: __T(["H的问题", "H的回答"]) }, 1500, i.signal);
    openSession("SH");
    await __sleep(900);
    const note = chatCol.querySelector(".open-note");
    const btn = note && note.querySelector("button");
    const mid = { note: note ? note.textContent : "", btn: !!btn, turns: chatCol.querySelectorAll(".turn").length };
    await __sleep(1000);
    const late = chatCol.querySelectorAll(".turn").length;
    __stubs["/api/session/SH"] = (u, i) => __json({ transcript: __T(["H的问题", "H的回答"]) }, 20, i.signal);
    if (btn) btn.click();
    await __sleep(400);
    const after = __bubbles().join("|");
    // 反向对照：不掐（超时拉到很长），同样卡住的请求到 0.9 秒屏幕上没有能点的
    OPEN_SESSION_TIMEOUT_MS = 1e9;
    __stubs["/api/session/SH2"] = (u, i) => __json({}, -1, i.signal);
    openSession("SH2");
    await __sleep(900);
    const rev = { btn: !!chatCol.querySelector(".open-note button"), note: (chatCol.querySelector(".open-note") || {}).textContent || "" };
    OPEN_SESSION_TIMEOUT_MS = keep;
    return { mid, late, after, rev };
  })()`);
  ok(b.mid.btn && /等了 1 秒没等到/.test(b.mid.note) && b.mid.turns === 0 && b.late === 0,
    "取记录卡住：到点给一句「等了 N 秒没等到」加「重试」，晚到的记录不再画上来", b);
  ok(b.after.includes("H的问题"), "点「重试」重新取，这次回来了就正常画出来", b.after);
  ok(!b.rev.btn, "反向对照：不掐请求，同样卡住 0.9 秒时屏幕上没有能点的「重试」", b.rev);

  // 后台对话出字不排版，切回来一次画齐
  const c = await S.js(`(async () => {
    const orig = window.paintStream;
    let target = null, paints = 0;
    window.paintStream = function (el) { if (target && target.contains(el)) paints++; return orig.apply(this, arguments); };
    const feed = async (ui) => { ui.handleEvent({ type: "text", delta: "## 小标题\\n\\n第一段" }); await __sleep(150); ui.handleEvent({ type: "text", delta: "，第二段接上。" }); await __sleep(400); };
    try {
      const bg = createTurnUI("后台问题", "craft", "BG1");
      target = bg.turn;
      await feed(bg);
      const el = bg.turn.querySelector(".a-text");
      const hidden = { paints, raw: el ? el._raw : null, h2: !!(el && el.querySelector("h2")) };
      chatCol.appendChild(bg.turn);
      bg.flush();
      const shown = { paints, h2: !!(el && el.querySelector("h2")), text: el ? el.textContent : "" };
      bg.finish(); bg.turn.remove();
      // 反向对照：同一个 createTurnUI 去掉「不在页面上就只记一笔」那一行
      let src = createTurnUI.toString();
      const gate = "if (!el.isConnected) { el._dirty = true; return; }";
      const had = src.includes(gate);
      (0, eval)(src.replace(gate, "").replace("function createTurnUI(", "function createTurnUINoGate("));
      paints = 0;
      const old = createTurnUINoGate("后台问题", "craft", "BG2");
      target = old.turn;
      await feed(old);
      const oldPaints = paints;
      old.finish();
      return { hidden, shown, had, oldPaints };
    } finally { window.paintStream = orig; }
  })()`);
  ok(c.hidden.paints === 0 && c.hidden.raw === "## 小标题\n\n第一段，第二段接上。" && !c.hidden.h2, "后台对话出字：字攒着，一帧都不排版", c.hidden);
  ok(c.shown.paints >= 1 && c.shown.h2 && c.shown.text.includes("第二段接上"), "切回来一次画齐：标题排出来了，两段字都在", c.shown);
  ok(c.had && c.oldPaints > 0, "反向对照：去掉那道门，看不见的回合照样一帧帧排版", { had: c.had, oldPaints: c.oldPaints });

  // 刷新接回叠两遍（开机那次 + 撞 409 那次）：只接一份、只挂一条订阅、只收尾一次
  // 叠不叠得上不能靠时间差：以前第二次晚 20ms 发、记录 150ms 才回，CI 机器一卡第二次就晚到，
  // 看见第一次已经接上了，修之前那份也只接一份，反向对照平白红。现在第一次取记录先卡着，
  // 等第二次拿到「在跑的有哪些」、走过「有没有人在接」那一步才放行——快机器慢机器都是同一个次序
  const d = await S.js(`(async () => {
    (0, eval)(${J(OLD_REATTACH)});
    let release = () => {}, gate = null, asks = 0;
    __stubs["/api/chat/running"] = () => {
      const second = ++asks === 2;
      // json() 回来以后，接回那一圈是同步走到下一个 await 的；排一个 0ms 定时器放行，一定排在它后面
      return Promise.resolve({ ok: true, json: async () => { if (second) setTimeout(release, 0); return ["RZ"]; } });
    };
    __stubs["/api/session/RZ"] = async (u, i) => {
      await gate;
      return __json({ transcript: [{ type: "user", text: "接回测试", mode: "craft" }, { type: "assistant", events: [{ type: "text", delta: "进行中" }] }] }, 0, i.signal);
    };
    __stubs["/api/chat/live"] = __liveEnd;
    const oCT = window.createTurnUI, oER = window.endRun, oLF = window.liveFollow;
    const cnt = { turns: 0, ends: 0, follows: 0 };
    window.createTurnUI = function (u, m, sid) { if (sid === "RZ") cnt.turns++; return oCT.apply(this, arguments); };
    window.endRun = function (sid) { if (sid === "RZ") cnt.ends++; return oER.apply(this, arguments); };
    window.liveFollow = function (sid) { if (sid === "RZ") cnt.follows++; return oLF.apply(this, arguments); };
    const twice = async (fn) => {
      cnt.turns = cnt.ends = cnt.follows = 0;
      asks = 0;
      gate = new Promise((r) => { release = r; setTimeout(r, 5000); }); // 5 秒兜底：脚本写坏了也不至于挂死
      await Promise.all([fn(), fn()]);
      // 等收尾：接了几份就该收尾几遍。最多等 5 秒，再多留 200ms 看有没有晚到的第二遍
      for (let k = 0; k < 100 && (runningSessions.has("RZ") || cnt.ends < cnt.turns); k++) await __sleep(50);
      await __sleep(200);
      return { ...cnt, left: runningSessions.has("RZ") };
    };
    try {
      const fixed = await twice(reattachRunning);
      const old = await twice(reattachRunningOld);
      return { fixed, old };
    } finally {
      window.createTurnUI = oCT; window.endRun = oER; window.liveFollow = oLF;
      delete __stubs["/api/chat/running"]; delete __stubs["/api/session/RZ"];
    }
  })()`);
  ok(d.fixed.turns === 1 && d.fixed.follows === 1 && d.fixed.ends === 1 && !d.fixed.left, "两次接回叠在一起：只接一份、只挂一条订阅、只收尾一次", d.fixed);
  ok(d.old.turns === 2 && d.old.ends === 2, "反向对照：修之前那份，同样叠两次就接了两份、收尾两遍", d.old);

  // 人已经点进这条、静态回放画了一轮「跑了一半」：接回时换掉的得是这一轮，不是刚接上的活的那轮
  const e = await S.js(`(async () => {
    __stubs["/api/session/RY"] = (u, i) => __json({ transcript: __T(["第一问", "第一答"], ["第二问 在跑", "跑了一半"]) }, 10, i.signal);
    __stubs["/api/chat/live"] = __liveEnd;
    const look = () => {
      const turns = [...chatCol.querySelectorAll(".turn")], live = runningSessions.get("RY"), b = __bubbles();
      return { turns: turns.length, dup: b.filter((x) => x === "第二问 在跑").length, first: b.includes("第一问"), lastIsLive: !!live && turns[turns.length - 1] === live.ui.turn };
    };
    const once = async (fn) => {
      __stubs["/api/chat/running"] = (u, i) => __json([], 0, i.signal);
      await openSession("RY");
      __stubs["/api/chat/running"] = (u, i) => __json(["RY"], 0, i.signal);
      await fn();
      const r = look();
      await __sleep(800); // 等假直播说跑完
      return r;
    };
    try {
      const fixed = await once(reattachRunning);
      const old = await once(reattachRunningOld);
      return { fixed, old };
    } finally { delete __stubs["/api/chat/running"]; }
  })()`);
  ok(e.fixed.turns === 2 && e.fixed.dup === 1 && e.fixed.first && e.fixed.lastIsLive, "接回眼前这条：死的那轮换成活的，第一轮留着，跑着的只有一份", e.fixed);
  ok(e.old.dup === 2, "反向对照：修之前删的是刚挂上的活的那轮，死的留着，同一轮两份", e.old);

  // 打不开本机文件夹（多人服务器的成员、设置还没拉回来）：产出清单照画，回放不许在这儿断
  const f = await S.js(`(() => {
    const oC = window.canOpenOnHost;
    window.canOpenOnHost = () => false;
    const files = [{ name: "说明.txt", size: 3, mtime: Date.now() }];
    const run = (fn) => {
      const box = document.createElement("div");
      try { fn(box, files, null, { root: "" }); } catch (e) { return { threw: String((e && e.message) || e) }; }
      const row = box.querySelector(".out-row");
      return { threw: "", row: !!row, rv: !!(row && row.querySelector("[data-rv]")) };
    };
    try {
      const fixed = run(renderTurnOutputs);
      let src = renderTurnOutputs.toString();
      const re = /const rv = row\\.querySelector\\("\\[data-rv\\]"\\);\\s*if \\(rv\\) rv\\.onclick/;
      const had = re.test(src);
      (0, eval)(src.replace(re, 'row.querySelector("[data-rv]").onclick').replace("function renderTurnOutputs(", "function renderTurnOutputsOld("));
      return { fixed, old: run(renderTurnOutputsOld), had };
    } finally { window.canOpenOnHost = oC; }
  })()`);
  ok(!f.fixed.threw && f.fixed.row && !f.fixed.rv, "没有「打开所在位置」按钮时：产出那一行照画，不抛错", f.fixed);
  ok(f.had && !!f.old.threw, "反向对照：修之前直接 .onclick，当场抛错（回放就断在这儿）", f.old);

  // 后台那条开跑：眼前这条最后一轮的「重新生成」不许被撤
  const g = await S.js(`(async () => {
    __stubs["/api/session/SG"] = (u, i) => __json({ transcript: __T(["G的问题", "G的回答"]) }, 10, i.signal);
    await openSession("SG");
    const count = () => chatCol.querySelectorAll(".turn-actions [data-a=regen]").length;
    const before = count();
    const bg = createTurnUI("别处开跑的一轮", "craft", "OTHER");
    const afterBg = count();
    bg.finish();
    let src = createTurnUI.toString();
    const gate = 'if (turnSid === sessionId) chatCol.querySelectorAll(".turn-actions [data-a=regen]")';
    const had = src.includes(gate);
    (0, eval)(src.replace(gate, 'chatCol.querySelectorAll(".turn-actions [data-a=regen]")').replace("function createTurnUI(", "function createTurnUIOldRegen("));
    const old = createTurnUIOldRegen("别处开跑的一轮", "craft", "OTHER2");
    const afterOld = count();
    old.finish();
    return { before, afterBg, had, afterOld };
  })()`);
  ok(g.before >= 1 && g.afterBg === g.before, "后台那条开跑：眼前这条最后一轮的「重新生成」还在", g);
  ok(g.had && g.afterOld === 0, "反向对照：不看是哪条对话就撤，眼前这条的「重新生成」没了", g);

  finish(fail ? 1 : 0);
}).catch((e) => { console.error("❌ 连接池测试自己炸了：", (e && e.stack) || e); finish(1); });
