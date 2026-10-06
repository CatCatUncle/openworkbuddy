// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 服务端挪进独立进程（utilityProcess）：真起 electron-main.js，两种跑法各走一遍。
 *
 * 跑法：node test/server-process.js（它自己拉 Electron；没装 electron 就跳过）
 *
 * 2026-09-29 审计：几个对话一起跑时主进程事件循环 p99 68ms、最长 330ms——server.js 连同 agent
 * 全在 Electron 主进程里，SSE 推流、工具调用、大 JSON 跟窗口抢同一条线程。用户原话「开几个对话
 * 整个应用连带电脑都卡」。现在默认把服务端放进 server-host.js（utilityProcess），主进程只管窗口；
 * OWB_SERVER_PROCESS=inproc 走老路子。
 *
 * 每一趟都是：临时家 + 随机端口（PORT=0，config 里也写一个不是 3800 的口）+ OWB_SHELL_HIDDEN=1
 * （窗口在屏幕外、show:false、不进 Dock、不弹框、不建托盘），靠 stdin 的 status / lag-reset / quit 遥控。
 * 假模型在本进程里，不联网、不花钱。
 *
 *   A 独立进程（默认）   B 老路子（inproc）   C 起步就崩三次   D 20 秒不监听（这里压成 3 秒）   E 跑起来以后崩三次
 *
 * 判据（每组带 ★反向对照★）：
 *   - 谁在听端口：A 是服务进程的 pid、不是主进程；★B 是主进程自己
 *   - 页面加载、「个人桌面版」、系统权限接口 desktop:true、数据目录对得上、选文件夹不弹框
 *   - 一趟对话跑完：写网页 → check_page（page.check 过桥）→ gen_diagram 出 PNG（svg.png 过桥）→ run_node；
 *     A 主进程的桥接到了这几个 call；★B 没有桥，结果一样
 *   - 预览：带令牌 200；★不带令牌 401
 *   - 隔离：6 趟重活（每趟几千条流式事件 + 一个几 MB 的 write_file）同时跑，量主进程事件循环迟到；
 *     A 的最大值必须远低于 ★B
 *   - 杀掉服务进程：★刚杀那一下端口没人应答；随后同一个口换了新 pid 回来
 *     杀之前挂着的后台命令：★当场挂到 1 号底下成孤儿；重启出来的那个开机按账本把它收掉
 *   - 退出：进程树一个不剩；★直接 SIGKILL 主进程（不走退出收尾）会留下孤儿
 *   - 退回：C/D/E 各留一行写明原因的日志、照样能用；★A 的日志里没有这一行
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const cp = require("child_process");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
// 这个套件是 node 驱动、自己再拉 Electron。拿 electron 直接跑它时 require("electron") 回的是对象不是路径，
// 以前会落进下面那句「没装 electron」按跳过退 0——2026-09-29 联调时照 conn-pool 的跑法敲了两遍，两遍都是假绿
if (process.versions.electron) {
  console.error("这个套件得用 node 跑：node test/server-process.js（它自己再拉 Electron）");
  process.exit(1);
}
let electronBin = null;
try { electronBin = require("electron"); } catch {}
if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
  console.log("跳过：没装 electron，独立服务进程只在桌面版里有");
  process.exit(0);
}
if (process.platform === "win32") {
  console.log("跳过：进程树、谁在听端口靠 ps / lsof，Windows 上另有一套（electron-main.js killChildren 的 taskkill 分支）");
  process.exit(0);
}
const HOME = require("./lib/own-home")("server-process");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 900))); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return !!(await fn());
}

/** 起过的每个 Electron、每个标记过的后台 sleep：不管怎么收场都要收掉 */
const launched = [];
const markers = new Set();
let llm = null;
let finished = false;
function reapAll() {
  for (const L of launched) {
    if (L.exited) continue;
    for (const p of [...tree(psRows(), L.child.pid), L.child.pid]) { try { process.kill(p, "SIGKILL"); } catch {} }
  }
  for (const r of psRows()) if (markers.has(sleepMarker(r.args))) { try { process.kill(r.pid, "SIGKILL"); } catch {} }
}
function finish(code) {
  if (finished) return;
  finished = true;
  try { reapAll(); } catch {}
  try { if (llm) { if (llm.closeAllConnections) llm.closeAllConnections(); llm.close(); } } catch {}
  console.log(`\n独立服务进程：${pass} 过 / ${fail} 挂`);
  process.exitCode = code;
  setTimeout(() => process.exit(code), 50);
}
process.on("uncaughtException", (e) => { console.error("❌ 测试自己炸了：", (e && e.stack) || e); fail++; finish(1); });
process.on("unhandledRejection", (e) => { console.error("❌ 测试自己炸了：", (e && e.stack) || e); fail++; finish(1); });
process.on("SIGINT", () => { fail++; finish(130); });
const hardStop = setTimeout(() => { console.log("❌ 整套跑了 9 分钟还没完，按卡死处理"); fail++; finish(1); }, 9 * 60 * 1000);

// ---------- 进程表 ----------
function psRows() {
  const r = cp.spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,args="], { encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
  const rows = [];
  for (const line of String(r.stdout || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && +m[1] !== r.pid) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], args: m[4] });
  }
  return rows;
}
/** root 底下的子子孙孙（不含 root） */
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
const sleepMarker = (args) => { const m = /^(?:\/bin\/)?sleep (3\d{3})$/.exec(String(args || "").trim()); return m ? m[1] : ""; };
/** 谁在听这个口（lsof 只按端口问，不碰别的口） */
function listenerPid(port) {
  const r = cp.spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", timeout: 15000 });
  const m = /^p(\d+)/m.exec(String(r.stdout || ""));
  return m ? +m[1] : 0;
}

// ---------- 假模型 ----------
const HEAVY_DELTAS = 3000;
const HEAVY_LINES = 60000;
let bigSrc = "";
function bigJs(tag) {
  if (!bigSrc) {
    const out = [];
    for (let i = 0; i < HEAVY_LINES; i++) out.push(`const v${i} = { id: ${i}, name: "item_${i}", tags: ["a${i % 7}", "b${i % 11}"], on: ${i % 2 === 0} };`);
    bigSrc = out.join("\n");
  }
  return `// ${tag}\n` + bigSrc + "\n";
}
const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>探针页</title></head><body>
<h1>服务进程探针</h1><p id="mark">探针正文：检查网页、预览、出图这几条路在独立服务进程里照样走得通，多写几个字免得被当成白屏。</p></body></html>`;
const PROBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#e02020"/></svg>`;
let callSeq = 0;
const llmClientErrors = []; // 假模型那头 http 解析出错的记录（见 startLlm 的 clientError）
const textOf = (c) => (typeof c === "string" ? c : JSON.stringify(c));

async function answer(res, stream, { text = "", deltas = 0, tool = null }) {
  if (res.writableEnded || res.destroyed) return;
  if (!stream) {
    const message = { role: "assistant", content: text || (deltas ? "重活完成" : "") };
    if (tool) message.tool_calls = [{ id: "call_" + ++callSeq, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }];
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const ch = (delta, fin) => "data: " + JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: fin || null }] }) + "\n\n";
  let buf = "";
  const flush = async () => {
    if (!buf || res.destroyed) return;
    res.write(buf);
    buf = "";
    await sleep(4);
  };
  for (let i = 0; i < deltas; i++) {
    buf += ch({ content: `第${i}段流式正文，` });
    if (i % 100 === 99) await flush();
  }
  if (text) buf += ch({ content: text });
  if (tool) {
    buf += ch({ tool_calls: [{ index: 0, id: "call_" + ++callSeq, type: "function", function: { name: tool.name, arguments: "" } }] });
    const args = JSON.stringify(tool.args);
    for (let i = 0; i < args.length; i += 65536) {
      buf += ch({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 65536) } }] });
      await flush();
    }
  }
  buf += ch({}, tool ? "tool_calls" : "stop");
  buf += "data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }) + "\n\ndata: [DONE]\n\n";
  await flush();
  if (!res.destroyed) res.end();
}

function startLlm() {
  llm = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let b = {};
      try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      const msgs = b.messages || [];
      const all = msgs.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
      const nTool = msgs.filter((m) => m.role === "tool").length;
      const stream = !!b.stream;
      if (!Array.isArray(b.tools) || !b.tools.length) return answer(res, stream, { text: "好的" });
      if (/探针/.test(all)) {
        const steps = [
          { name: "write_file", args: { path: "probe.html", content: PROBE_HTML } },
          { name: "check_page", args: { path: "probe.html" } },
          { name: "gen_diagram", args: { kind: "svg", source: PROBE_SVG, filename: "d" } },
          { name: "run_node", args: { code: `console.log("RUN_NODE_OK " + process.versions.node)` } },
        ];
        if (nTool < steps.length) return answer(res, stream, { text: `第 ${nTool + 1} 步。`, tool: steps[nTool] });
        return answer(res, stream, { text: "探针完成" });
      }
      const bg = /后台 (3\d{3})/.exec(all);
      if (bg) {
        if (!nTool) return answer(res, stream, { text: "起一条后台命令。", tool: { name: "run_shell", args: { command: `sleep ${bg[1]}`, background: true, keep: true } } });
        return answer(res, stream, { text: "后台已起" });
      }
      const heavy = /重活 (\d+)/.exec(all);
      if (heavy) {
        if (!nTool) return answer(res, stream, { deltas: HEAVY_DELTAS, tool: { name: "write_file", args: { path: `heavy_${heavy[1]}.js`, content: bigJs("重活 " + heavy[1]) } } });
        return answer(res, stream, { deltas: HEAVY_DELTAS, text: "重活完成" });
      }
      return answer(res, stream, { text: "收到" });
    });
  });
  // 2026-09-29 全量跑 B 老路子有一趟第 2 步拿到「LLM 接口错误 400: 」（空正文）——假模型自己从不回 400，
  // 那是 node 的 http 解析请求出错时替它回的。挂个耳朵把解析错记下来，红的时候跟着报出来；
  // 回应照 node 默认的来（能写就回 400/431 再关，写不了或响应头已发就直接断），行为不变
  llm.on("clientError", (err, socket) => {
    llmClientErrors.push({ code: err.code, why: err.reason || err.message, at: err.bytesParsed, raw: err.rawPacket ? err.rawPacket.subarray(0, 60).toString("latin1") : "" });
    if (err.code === "ECONNRESET" || !socket.writable || (socket._httpMessage && socket._httpMessage.headersSent)) return socket.destroy(err);
    socket.end(err.code === "HPE_HEADER_OVERFLOW" ? "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n" : "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return new Promise((r) => llm.listen(0, "127.0.0.1", () => r(llm.address().port)));
}

// ---------- 起一台 ----------
const TOKEN = "tk" + Date.now();
let LLM_PORT = 0;

function makeHome(tag) {
  const home = path.join(HOME, tag);
  const data = path.join(home, "data");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "users.json"), JSON.stringify({
    users: [{ username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [TOKEN]: { user: "boss", at: Date.now() } },
  }));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  const base = `http://127.0.0.1:${LLM_PORT}/v1`;
  cfg.provider = "openai";
  cfg.openai = { base_url: base, api_key: "k", model: "mock", stream: true };
  cfg.models = [{ name: "假模型", provider: "openai", base_url: base, api_key: "k", model: "mock", stream: true }];
  cfg.active_model = "假模型";
  cfg.mcp_servers = [];
  cfg.pet = { enabled: false };
  cfg.agent = { ...(cfg.agent || {}), max_steps: 8, llm_timeout_ms: 180000 };
  // PORT=0 已经在环境变量里了；config 里再钉一个不是 3800 的口，万一哪条路没吃到环境变量也撞不上用户那台
  cfg.server = { ...(cfg.server || {}), port: 41000 + Math.floor(Math.random() * 20000) };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg));
  return home;
}

function launch(tag, extraEnv = {}) {
  const home = makeHome(tag);
  const env = {
    ...process.env,
    OPENWORKBUDDY_HOME: home,
    OPENWORKBUDDY_DATA_DIR: path.join(home, "data"),
    OWB_SHELL_HIDDEN: "1",
    OWB_USER_DATA_DIR: path.join(home, "userdata"),
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    PORT: "0",
    HOST: "127.0.0.1",
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = cp.spawn(electronBin, [ROOT], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  const L = { tag, home, child, log: "", ctl: [], exited: null, t0: Date.now() };
  launched.push(L);
  let lineBuf = "";
  child.stdout.on("data", (d) => {
    const s = String(d);
    L.log += s;
    lineBuf += s;
    for (let i = lineBuf.indexOf("\n"); i >= 0; i = lineBuf.indexOf("\n")) {
      const line = lineBuf.slice(0, i);
      lineBuf = lineBuf.slice(i + 1);
      const k = line.indexOf("OWB_CTL ");
      if (k >= 0) { try { L.ctl.push(JSON.parse(line.slice(k + 8))); } catch {} }
    }
  });
  child.stderr.on("data", (d) => { L.log += String(d); });
  child.stdin.on("error", () => {});
  child.on("exit", (code, sig) => { L.exited = { code, sig }; });
  L.cmd = (s) => { try { child.stdin.write(s + "\n"); } catch {} };
  L.status = async () => {
    const n = L.ctl.length;
    L.cmd("status");
    await waitFor(() => L.ctl.length > n || L.exited, 15000, 50);
    return L.ctl[n] || null;
  };
  L.up = async (ms = 60000) => {
    let st = null;
    await waitFor(async () => { if (L.exited) return true; st = await L.status(); return !!(st && st.pageUp); }, ms, 400);
    return st;
  };
  L.quit = async (ms = 30000) => {
    L.cmd("quit");
    await waitFor(() => L.exited, ms, 100);
    return L.exited;
  };
  L.tail = (n = 1500) => L.log.slice(-n);
  return L;
}

// ---------- HTTP ----------
function req(port, method, p, body, { cookie = true, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (cookie) headers.Cookie = "openworkbuddy_token=" + TOKEN;
    if (data !== null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
    const rq = http.request({ host: "127.0.0.1", port, path: p, method, headers, timeout: timeoutMs }, (r) => {
      const bufs = [];
      r.on("data", (c) => bufs.push(c));
      r.on("end", () => {
        const raw = Buffer.concat(bufs);
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch {}
        resolve({ status: r.statusCode, raw, text: raw.toString("utf8"), json });
      });
      r.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
    });
    rq.on("timeout", () => rq.destroy(new Error("timeout")));
    rq.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
    rq.end(data === null ? undefined : data);
  });
}
/** 发一轮对话，读完整条 SSE（服务端跑完这一轮才收流） */
function chat(port, sid, message, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ sessionId: sid, message, mode: "craft" });
    const t0 = Date.now();
    let raw = "";
    const rq = http.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST", timeout: timeoutMs, headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(data), Cookie: "openworkbuddy_token=" + TOKEN,
    } }, (r) => {
      r.setEncoding("utf8");
      r.on("data", (c) => (raw += c));
      r.on("end", () => {
        const events = [];
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
        }
        resolve({ status: r.statusCode, events, ms: Date.now() - t0, bytes: raw.length });
      });
    });
    rq.on("timeout", () => rq.destroy(new Error("timeout")));
    rq.on("error", (e) => resolve({ status: 0, error: e.message, events: [], ms: Date.now() - t0 }));
    rq.end(data);
  });
}
const toolOut = (evs, name) => evs.filter((e) => e.type === "tool_result" && e.name === name).map((e) => String(e.preview || e.output || e.content || "")).join("\n");
const textOfRun = (evs) => evs.filter((e) => e.type === "text").map((e) => e.delta || "").join("");

function findFile(dir, name) {
  let hit = null;
  const walk = (d, depth) => {
    if (hit || depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === name) { hit = p; return; }
      if (e.isDirectory() && !e.name.startsWith(".")) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return hit;
}
/** PNG 宽高 + 正中那个像素（过滤类型 0..4 全认） */
function pngProbe(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), bitDepth = buf[24], ct = buf[25];
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString("ascii", o + 4, o + 8);
    if (type === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (bitDepth !== 8 || !bpp) return { w, h, px: null };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  const midY = Math.floor(h / 2);
  for (let y = 0; y <= midY; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    [prev, cur] = [cur, prev];
  }
  const o = Math.floor(w / 2) * bpp;
  return { w, h, px: [prev[o], prev[o + 1], prev[o + 2]] };
}

/** 进程树快照 → 退出 → 快照里的一个都不许还活着 */
async function quitClean(L, label) {
  const rows = psRows();
  const snap = [L.child.pid, ...tree(rows, L.child.pid)];
  const ex = await L.quit();
  ok(!!ex, `${label}：quit 之后应用自己退了`, ex || L.tail(600));
  let left = [];
  await waitFor(() => { left = snap.filter(alive); return left.length === 0; }, 10000, 200);
  const leftRows = psRows().filter((r) => left.includes(r.pid)).map((r) => `${r.pid} ${r.args.slice(0, 120)}`);
  ok(left.length === 0, `${label}：退出前进程树 ${snap.length} 个（含服务进程和它起的后台命令），退出后剩 0 个`, leftRows);
  return snap;
}

// ---------- 一整台的检查（A、B 共用） ----------
let pngSeen = null;
async function fullRun(L, label, remoteExpected) {
  console.log(`\n【${label}】`);
  const st = await L.up();
  ok(!!(st && st.pageUp), `${label}：页面加载完成（${Date.now() - L.t0}ms）`, st || L.tail());
  if (!st || !st.pageUp) return null;
  const port = st.port;
  ok(port > 0 && port !== 3800, `${label}：监听随机口 ${port}，不是 3800`, st);
  ok(st.remote === remoteExpected, `${label}：服务端${remoteExpected ? "在独立进程里" : "在主进程里"}（status.remote=${st.remote}）`, st);
  const lp = listenerPid(port);
  if (remoteExpected) {
    ok(st.serverPid > 0 && lp === st.serverPid && lp !== L.child.pid, `${label}：听 ${port} 的是服务进程 pid ${lp}，不是主进程 ${L.child.pid}`, { lp, st });
    const row = psRows().find((r) => r.pid === st.serverPid);
    ok(!!row && row.ppid === L.child.pid && /--type=utility/.test(row.args), `${label}：服务进程是主进程的 utility 子进程`, row);
    const nice = cp.spawnSync("ps", ["-o", "nice=", "-p", String(st.serverPid)], { encoding: "utf8" }).stdout.trim();
    ok(Number(nice) >= 5, `${label}：服务进程优先级不高于 nice 5（实际 ${nice}）`, nice);
    ok(new RegExp(`\\[服务进程\\] 数据目录 ${L.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(L.log), `${label}：服务进程报上来的数据目录就是临时家`, L.tail());
  } else {
    ok(lp === L.child.pid && !st.serverPid, `★反向对照★ ${label}：听 ${port} 的就是主进程自己（pid ${lp}），没有服务进程`, { lp, main: L.child.pid, st });
  }
  ok(/个人桌面版：设置归你自己管/.test(L.log), `${label}：服务端认得自己是个人桌面版（shell 判定在这一边也对）`, L.tail());

  const info = await req(port, "GET", "/api/info");
  ok(info.status === 200, `${label}：/api/info 200`, info.status);
  const sys = await req(port, "GET", "/api/security/system");
  ok(sys.status === 200 && sys.json && sys.json.desktop === true, `${label}：系统权限接口 desktop:true`, sys.json || sys.status);
  // systemPreferences 在 utility 里也有（Electron 43 实测）：查不到会是 "unknown"
  if (process.platform === "darwin") ok(sys.json && ["granted", "denied"].includes(sys.json.accessibility), `${label}：辅助功能权限查得到（${sys.json && sys.json.accessibility}），不是 unknown`, sys.json);

  // 选文件夹：两条路都不许在用户桌面上弹框
  const pick = await req(port, "POST", "/api/pick-folder", {});
  if (remoteExpected) ok(pick.status === 502 && /隐藏运行.*dialog\.openDirectory/.test(pick.text), `${label}：选文件夹过桥，隐藏运行时报「不弹框」而不是弹出来`, pick.text);
  else ok(pick.status === 200 && pick.json && pick.json.canceled === true, `${label}：选文件夹走主进程的 dialog，隐藏运行按取消答`, pick.text);

  const b0 = (await L.status()).bridge;
  const cc = await req(port, "POST", "/api/cache/clear", {});
  ok(cc.status === 200, `${label}：清缓存 200`, cc.text && cc.text.slice(0, 200));
  const b1 = (await L.status()).bridge;
  if (remoteExpected) ok(b0 && b1 && b1.calls === b0.calls + 1 && b1.errors === b0.errors, `${label}：清缓存那一下过桥（session.clearCaches）`, { b0, b1 });

  // ---- 一趟对话：写网页 → 体检 → 出图 → run_node ----
  const pr = await chat(port, "s_" + Date.now() + "_probe", "探针：写个网页、体检、出图、跑段代码");
  const b2 = (await L.status()).bridge;
  const evs = pr.events;
  ok(pr.status === 200 && /探针完成/.test(textOfRun(evs)), `${label}：对话跑完（${pr.ms}ms，${evs.length} 条事件）`, { status: pr.status, err: pr.error, tail: evs.slice(-4) });
  const cpOut = toolOut(evs, "check_page");
  ok(/【浏览器实测】标题「探针页」/.test(cpOut), `${label}：check_page 真开了浏览器窗口（标题「探针页」）`, cpOut.slice(0, 400));
  const gd = toolOut(evs, "gen_diagram");
  ok(/d\.png/.test(gd), `${label}：gen_diagram 出了 PNG`, gd.slice(0, 300));
  const pngPath = findFile(path.join(L.home, "workspace"), "d.png");
  const png = pngProbe(pngPath ? fs.readFileSync(pngPath) : null);
  const k = png ? png.w / 120 : 0;
  ok(!!png && k >= 2 && Number.isInteger(k) && png.h === 80 * k && png.px && png.px[0] > 200 && png.px[1] < 60 && png.px[2] < 60,
    `${label}：PNG 是 ${k} 倍图 ${png && png.w}×${png && png.h}、正中是那块红（${png && png.px}）`, png);
  if (pngSeen) ok(!!png && png.w === pngSeen.w && png.h === pngSeen.h, `${label}：出图尺寸和另一种跑法一模一样（${pngSeen.w}×${pngSeen.h}）`, { png, pngSeen });
  else pngSeen = png;
  const rn = toolOut(evs, "run_node");
  ok(/RUN_NODE_OK \d+/.test(rn), `${label}：run_node 跑得起来（${remoteExpected ? "服务进程里拿主程序当 node" : "主进程当 node"}）`, rn.slice(0, 300));
  if (remoteExpected) {
    ok(b1 && b2 && b2.calls - b1.calls >= 2 && b2.errors === b1.errors, `${label}：主进程的桥接到了 ${b2 && b1 ? b2.calls - b1.calls : "?"} 个 call（page.check、svg.png），没有一个报错`, { b1, b2 });
  } else {
    ok(b2 === null, `★反向对照★ ${label}：没有桥（status.bridge=null），同样的体检、出图在主进程里直接做`, b2);
  }

  // ---- 预览 ----
  const probe = findFile(path.join(L.home, "workspace"), "probe.html");
  const rel = probe ? path.relative(path.join(L.home, "workspace"), probe) : "";
  const relUrl = rel.split(path.sep).map(encodeURIComponent).join("/");
  const view = await req(port, "GET", "/api/files/view/" + relUrl);
  ok(view.status === 200 && /探针正文/.test(view.text), `${label}：/api/files/view 打得开刚写的网页`, { status: view.status, rel });
  const ps = await req(port, "POST", "/api/preview/start", {});
  const pv = ps.json || {};
  const pvPort = pv.url ? Number(new URL(pv.url).port) : 0;
  const withTok = pvPort ? await req(pvPort, "GET", "/" + relUrl + "?t=" + pv.token, undefined, { cookie: false }) : {};
  const noTok = pvPort ? await req(pvPort, "GET", "/" + relUrl, undefined, { cookie: false }) : {};
  ok(withTok.status === 200 && /探针正文/.test(withTok.text || ""), `${label}：本地预览服务带令牌打得开（端口 ${pvPort}）`, { ps: ps.text && ps.text.slice(0, 200), status: withTok.status });
  ok(noTok.status === 401, `★反向对照★ ${label}：同一个地址不带令牌 401`, noTok.status);
  await req(port, "POST", "/api/preview/stop", {});
  return { port, st };
}

/** 6 趟重活同时跑，量主进程事件循环迟到 */
async function isolation(L, port, label) {
  L.cmd("lag-reset");
  await sleep(300);
  const t0 = Date.now();
  const runs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => chat(port, `s_${Date.now()}_heavy${i}`, `重活 ${i}`)));
  const st = await L.status();
  const done = runs.filter((r) => r.status === 200 && /重活完成/.test(textOfRun(r.events))).length;
  const evCount = runs.reduce((n, r) => n + r.events.length, 0);
  const mb = runs.reduce((n, r) => n + (r.bytes || 0), 0) / 1048576;
  // 2026-09-29 全量跑时 B 老路子有一趟只回了 3014 条（别的 6016），状态 200、没报错，光看条数看不出是怎么收的尾：
  // 红的时候把没跑完那几趟最后几条事件带出来，下回红了直接看得到是 error / limit / done 还是流被掐了
  const tailOf = (r) => r.events.slice(-5).map((e) => e.type + (e.message || e.error || e.note || e.text ? "：" + String(e.message || e.error || e.note || e.text).slice(0, 120) : ""));
  ok(done === 6, `${label}：6 趟重活全跑完（${Date.now() - t0}ms，${evCount} 条事件、${mb.toFixed(1)}MB 推流）`, runs.map((r) => ({ s: r.status, e: r.error, n: r.events.length, ...(r.status === 200 && /重活完成/.test(textOfRun(r.events)) ? {} : { tail: tailOf(r) }) })).concat(llmClientErrors.length ? [{ llmClientErrors }] : []));
  const heavyFile = findFile(path.join(L.home, "workspace"), "heavy_1.js");
  ok(!!heavyFile && fs.statSync(heavyFile).size > 3 * 1048576, `${label}：几 MB 的 write_file 真落了盘`, heavyFile);
  const lag = st && st.lag;
  console.log(`     主进程事件循环迟到（${label}）：max ${lag && lag.max}ms · p99 ${lag && lag.p99}ms · p50 ${lag && lag.p50}ms · 采样 ${lag && lag.n}`);
  return { lag, ms: Date.now() - t0, events: evCount, mb };
}

(async () => {
  LLM_PORT = await startLlm();
  const results = {};

  // ================= A 独立进程（默认） =================
  const A = launch("utility");
  const a = await fullRun(A, "A 独立进程", true);
  if (a) {
    results.utility = await isolation(A, a.port, "A 独立进程");
    // ---- 杀服务进程 → 同一个口换个 pid 回来 ----
    console.log("\n【A 独立进程 · 杀掉服务进程】");
    const before = await A.status();
    const oldPid = before.serverPid;
    // 杀之前先挂一条后台命令（keep:true）。2026-09-29 复审：服务进程被直接杀掉时 exit 收尾一道都不跑，
    // detached 起的那一组挂到 1 号底下；重启出来的那个认不得它、退出应用时扫的树里也没有它——得靠账本认回来
    const mkK = String(3000 + Math.floor(Math.random() * 999));
    markers.add(mkK);
    const bgK = await chat(a.port, "s_" + Date.now() + "_bgk", `后台 ${mkK}`);
    const kRow = () => psRows().find((r) => sleepMarker(r.args) === mkK);
    const ledger = path.join(A.home, "data", "run-strays", `${oldPid}.json`);
    const booked = await waitFor(() => { const k = kRow(); try { return !!k && JSON.parse(fs.readFileSync(ledger, "utf8")).strays.some((s) => s.pgid === k.pgid); } catch { return false; } }, 10000);
    ok(bgK.status === 200 && booked, `杀之前挂着一条后台命令 sleep ${mkK}，服务进程的账本 run-strays/${oldPid}.json 记下了它那一组`, { s: bgK.status, out: toolOut(bgK.events, "run_shell").slice(0, 200) });
    try { process.kill(oldPid, "SIGKILL"); } catch {}
    await sleep(150);
    const down = await req(a.port, "GET", "/api/info", undefined, { timeoutMs: 1500 });
    ok(down.status === 0, `★反向对照★ 刚杀掉那一下 ${a.port} 上没人应答（${down.error}）：后面能用是重启出来的，不是没杀死`, down.status);
    const kNow = kRow();
    const lead = kNow && psRows().find((r) => r.pid === kNow.pgid);
    ok(!!lead && lead.ppid === 1, `★反向对照★ 服务进程被 SIGKILL 那一刻 exit 收尾没跑：sleep ${mkK} 那一组挂到了 1 号底下（不靠账本就没人收）`, { kNow, lead });
    let st = null;
    await waitFor(async () => { st = await A.status(); return st && st.serverPid && st.serverPid !== oldPid && st.remote; }, 30000, 300);
    ok(!!st && st.serverPid !== oldPid && st.starts === before.starts + 1 && st.port === a.port, `重启了：新 pid ${st && st.serverPid}（旧 ${oldPid}），第 ${st && st.starts} 次起，还是 ${a.port}`, st);
    const reaped = await waitFor(() => !kRow(), 15000, 300);
    ok(reaped, `重启出来的服务进程开机收账：孤儿 sleep ${mkK} 按账本认回来收掉了`, kRow());
    // 那行字在杀完、删完账本之后才打，还要从服务进程经管道转到这边：进程没了不等于字到了，得等一下
    const said = await waitFor(() => /\[收尾\] 上次没收干净的后台进程组 \d+ 个已收掉：sleep \d+/.test(A.log), 5000, 100);
    ok(said, "日志留了一行「上次没收干净的后台进程组 … 已收掉」", A.tail(900));
    const back = await req(a.port, "GET", "/api/info");
    ok(back.status === 200, "重启后同一个口照样应答", back.status);
    // 退出那行会带上服务进程 stderr 的最后一行，原文照抄、里面自己就可能有「）」：别用 [^）]* 卡它，按行尾认
    ok(/\[服务进程\] 独立服务进程退出了（退出码 \S+?(，最后一行 stderr：.*)?），\d+ms 后重启/.test(A.log) && new RegExp(`\\[服务进程\\] 重启好了，监听 ${a.port}`).test(A.log), "日志写明：退出码、几毫秒后重启、重启好了监听哪个口",
      { exited: (A.log.match(/\[服务进程\] 独立服务进程退出了.*/g) || []).slice(-2), tail: A.tail(300) });
    const rl = await req(a.port, "GET", "/api/security/system");
    ok(rl.status === 200, "重启以后登录态还在（令牌在盘上，不在进程里）", rl.status);
    ok(!/已改回在主进程里运行|改在主进程里接着跑/.test(A.log), "★反向对照★ 正常这一台的日志里没有「改回主进程」那一行", A.tail(600));

    // ---- 后台命令 + 退出 ----
    console.log("\n【A 独立进程 · 退出】");
    const mk = String(3000 + Math.floor(Math.random() * 999));
    markers.add(mk);
    const bg = await chat(a.port, "s_" + Date.now() + "_bg", `后台 ${mk}`);
    const hasSleep = await waitFor(() => {
      const rows = psRows();
      const kids = new Set(tree(rows, A.child.pid));
      return rows.some((r) => sleepMarker(r.args) === mk && kids.has(r.pid));
    }, 10000);
    ok(bg.status === 200 && hasSleep, `后台命令 sleep ${mk} 挂在服务进程底下`, { s: bg.status, out: toolOut(bg.events, "run_shell").slice(0, 200) });
    await quitClean(A, "A 独立进程");
    ok(!psRows().some((r) => sleepMarker(r.args) === mk), `A 独立进程：sleep ${mk} 跟着走了`, mk);
  }

  // ================= B 老路子（inproc，反向对照） =================
  const B = launch("inproc", { OWB_SERVER_PROCESS: "inproc" });
  const b = await fullRun(B, "B 老路子", false);
  if (b) {
    results.inproc = await isolation(B, b.port, "B 老路子");
    console.log("\n【B 老路子 · 退出】");
    const mk = String(3000 + Math.floor(Math.random() * 999));
    markers.add(mk);
    const bg = await chat(b.port, "s_" + Date.now() + "_bg", `后台 ${mk}`);
    const hasSleep = await waitFor(() => psRows().some((r) => sleepMarker(r.args) === mk), 10000);
    ok(bg.status === 200 && hasSleep, `后台命令 sleep ${mk} 起来了`, { s: bg.status });
    await quitClean(B, "B 老路子");
    ok(!psRows().some((r) => sleepMarker(r.args) === mk), `B 老路子：sleep ${mk} 跟着走了`, mk);
  }

  // ================= 隔离：两个数摆一起 =================
  console.log("\n【隔离：6 趟重活同时跑，主进程事件循环迟到】");
  const u = results.utility && results.utility.lag, i = results.inproc && results.inproc.lag;
  if (u && i) {
    console.log(`     独立进程 max ${u.max}ms / p99 ${u.p99}ms   vs   老路子 max ${i.max}ms / p99 ${i.p99}ms`);
    ok(i.max >= 150, `★反向对照★ 老路子（服务端在主进程里）同样的负载把主进程卡到 ${i.max}ms：负载确实压得动`, i);
    ok(u.max * 4 <= i.max, `独立进程的主进程最长只卡 ${u.max}ms，不到老路子 ${i.max}ms 的四分之一`, { u, i });
    ok(u.p99 <= 40, `独立进程的主进程 p99 ${u.p99}ms（≤ 40ms）`, u);
  } else ok(false, "两种跑法都得量出数来", results);

  // ================= C 起步就崩 =================
  console.log("\n【C 服务进程一起就崩（OWB_SERVER_FAULT=crash-on-boot）】");
  const C = launch("crash-on-boot", { OWB_SERVER_FAULT: "crash-on-boot" });
  const cst = await C.up();
  ok(!!(cst && cst.pageUp), `C：照样打开了（${Date.now() - C.t0}ms）`, cst || C.tail());
  ok(/\[服务进程\] 独立服务进程5 分钟内退出了 3 次（最后一次退出码 3），已改回在主进程里运行/.test(C.log), "C：日志一行写明「5 分钟内退出了 3 次（最后一次退出码 3），已改回在主进程里运行」", C.tail(1200));
  ok((C.log.match(/\[服务进程\] 已起：pid \d+/g) || []).length === 3, "C：起了正好 3 次，没有无限重试", (C.log.match(/已起：pid \d+/g) || []));
  if (cst && cst.pageUp) {
    ok(cst.remote === false && listenerPid(cst.port) === C.child.pid, `C：退回以后是主进程自己在听 ${cst.port}`, cst);
    const r = await req(cst.port, "GET", "/api/security/system");
    ok(r.status === 200 && r.json && r.json.desktop === true, "C：退回以后接口照常", r.status);
  }
  await quitClean(C, "C 起步就崩");

  // ================= D 起了不监听 =================
  console.log("\n【D 服务进程起了不监听（OWB_SERVER_FAULT=no-listen，等待压到 3 秒）】");
  const D = launch("no-listen", { OWB_SERVER_FAULT: "no-listen", OWB_SERVER_READY_MS: "3000" });
  const dst = await D.up();
  ok(!!(dst && dst.pageUp), `D：照样打开了（${Date.now() - D.t0}ms）`, dst || D.tail());
  ok(/\[服务进程\] 独立服务进程3 秒内没开始监听端口，已改回在主进程里运行/.test(D.log), "D：日志一行写明「3 秒内没开始监听端口，已改回在主进程里运行」", D.tail(1200));
  const stuck = +((/\[服务进程\] 已起：pid (\d+)/.exec(D.log) || [])[1] || 0);
  let stuckGone = false;
  if (stuck) stuckGone = await waitFor(() => !alive(stuck), 5000);
  ok(stuck > 0 && stuckGone, `D：那个不监听的服务进程（pid ${stuck}）被收掉了，不在后台挂着`, stuck);
  if (dst && dst.pageUp) ok(dst.remote === false && listenerPid(dst.port) === D.child.pid, `D：退回以后是主进程自己在听 ${dst.port}`, dst);
  await quitClean(D, "D 起了不监听");

  // ================= E 跑起来以后连崩三次 =================
  console.log("\n【E 跑起来以后 5 分钟内崩满 3 次】");
  const E = launch("crash3");
  const est = await E.up();
  ok(!!(est && est.pageUp && est.remote), "E：先正常起在独立进程里", est || E.tail());
  if (est && est.pageUp && est.remote) {
    const port = est.port;
    let pid = est.serverPid;
    for (let k = 1; k <= 3; k++) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      if (k < 3) {
        let s2 = null;
        await waitFor(async () => { s2 = await E.status(); return s2 && s2.serverPid && s2.serverPid !== pid; }, 30000, 300);
        ok(!!s2 && s2.serverPid !== pid && s2.port === port, `E：第 ${k} 次崩了又起来（pid ${s2 && s2.serverPid}，口还是 ${port}）`, s2);
        pid = s2 && s2.serverPid;
      }
    }
    const fell = await waitFor(() => /\[服务进程\] 改在主进程里接着跑（5 分钟内退出了 3 次（最后一次退出码 [^）]*））/.test(E.log), 20000);
    ok(fell, "E：第 3 次崩完不再重启，日志一行写明「改在主进程里接着跑（5 分钟内退出了 3 次…）」", E.tail(1200));
    let up = null;
    await waitFor(async () => { up = await req(port, "GET", "/api/info", undefined, { timeoutMs: 2000 }); return up.status === 200; }, 20000, 300);
    const es = await E.status();
    ok(up && up.status === 200 && es.remote === false && listenerPid(port) === E.child.pid, `E：钉在原来的口 ${port} 上、换成主进程自己接着服务`, { up: up && up.status, es });

    // ★反向对照★ 不走退出收尾、直接 SIGKILL 主进程：后台命令成了孤儿——证明上面「剩 0 个」那几条不是空查
    console.log("\n【E · 反向对照：SIGKILL 主进程，不走退出收尾】");
    const mk = String(3000 + Math.floor(Math.random() * 999));
    markers.add(mk);
    await chat(port, "s_" + Date.now() + "_bg", `后台 ${mk}`);
    const hasSleep = await waitFor(() => psRows().some((r) => sleepMarker(r.args) === mk), 10000);
    ok(hasSleep, `E：后台命令 sleep ${mk} 起来了`, mk);
    const snap = [E.child.pid, ...tree(psRows(), E.child.pid)];
    try { process.kill(E.child.pid, "SIGKILL"); } catch {}
    await waitFor(() => E.exited, 10000);
    await sleep(1500);
    const orphan = psRows().find((r) => sleepMarker(r.args) === mk);
    ok(!!orphan, `★反向对照★ 直接 SIGKILL 主进程：sleep ${mk} 留成了孤儿（pid ${orphan && orphan.pid}，父进程 ${orphan && orphan.ppid}）`, snap.length);
    if (orphan) { try { process.kill(orphan.pid, "SIGKILL"); } catch {} }
    for (const p of snap) { try { process.kill(p, "SIGKILL"); } catch {} }
  } else {
    await E.quit();
  }

  clearTimeout(hardStop);
  if (results.utility && results.inproc) {
    console.log(`\nOWB_LAG ${JSON.stringify({ utility: results.utility.lag, inproc: results.inproc.lag, utilityMs: results.utility.ms, inprocMs: results.inproc.ms, events: results.utility.events, mb: +results.utility.mb.toFixed(1) })}`);
  }
  finish(fail ? 1 : 0);
})().catch((e) => { console.error("❌", (e && e.stack) || e); fail++; finish(1); });
