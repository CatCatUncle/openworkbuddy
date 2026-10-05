// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 几条对话并排跑：成果、文件、预览、截图、收尾清理、后台进程、浏览器标签页，各归各的。
 *
 * 跑法：npx electron test/chat-isolation.js（node 跑会自己换成 electron 再拉起一遍）
 *
 * 2026-09-29 用户原话「成果文件对话混乱」。查下来一处真漏：工作空间根下留着一张更早的
 * chrome-screenshot.png、一个 index.html，几条对话 chrome_cdp 截图不给 path、write_file 写 index.html，
 * 全被 resolveFile「子目录没有就用根下那个」的读规矩兜到了根下——几条对话轮流盖同一个文件，
 * 谁的成果卡点开都是最后写的那家。现在写只在「这条对话自己读过根下那份」时才写回根（tools.js resolveWrite）。
 *
 * 真 server.js（随机端口、临时数据根）+ 真 public/ 前端（隐藏窗口）+ 假模型 + 假无头 Chrome。
 * A/B/C 三条网页对话、D 一条画布对话同时跑，各自：写 index.html、写调试草稿（_shot.js、check_1.txt、.tmp/）、
 * 后台起一个预览服务、`nohup … &` 甩出一个散户进程、chrome_cdp 打开自己的预览页并截图；
 * C 还读了根下的 共享.md 再改它（这是「接着改旧文件」，该写回根）。判据：
 *   ① 跑到一半来回切对话：成果面板、文件清单、对话里的产出卡、预览面板、截图，只有这条对话自己的；
 *   ② 刷新页面接回来，照样只有自己的；
 *   ③ A 收尾：.tmp 里的旧文件只清 A 的，收尾那张「清掉草稿」卡只列 A 的、点了只删 A 的；
 *   ④ A 跑完、B 被停下：只收它俩自己的预览服务、散户进程和标签页，C/D 的照跑；keep:true 的留着；
 *   ⑤ IM、定时任务、命令行三个入口跑完同样收：后台命令、散户进程、标签页一个不剩（画布走的是 D）。
 * 另有一段不开窗口的单元（子进程里跑）：写文件的落点、cdp 按对话分标签页，各带去掉修复的对照。
 * 每组都有★反向对照★：同一份数据换成「不分对话」的看法，就看得见别家的东西。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { mod } = require("./lib/mod");
const { entry: entryPath } = require("./lib/entry");

const ROOT = path.join(__dirname, "..");
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}
const listen = (srv, port = 0) => new Promise((res, rej) => { srv.once("error", rej); srv.listen(port, "127.0.0.1", () => res(srv.address().port)); });
const wsFrame = (s) => {
  const b = Buffer.from(s), h = [0x81];
  if (b.length < 126) h.push(b.length); else if (b.length < 65536) h.push(126, b.length >> 8, b.length & 255);
  else h.push(127, 0, 0, 0, 0, (b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255);
  return Buffer.concat([Buffer.from(h), b]);
};
const unPng = (b64) => Buffer.from(String(b64 || ""), "base64").toString();

/**
 * 假无头 Chrome（行为照 test/cdp.js 那份：带 Origin 就 403、/json/new 只收 PUT）。
 * 记下每次 Page.navigate 落在哪个标签页上；截图回的是「PNG:<这个标签页最后打开的地址>」，
 * 截到谁的页面一眼看得出来
 */
function fakeChrome() {
  const tabs = [{ id: "TAB1", type: "page", title: "空白页", url: "about:blank" }];
  const navs = [], lastUrl = {}, sockets = new Set();
  let nextTab = 1;
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    const withWs = (t) => ({ ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}` });
    if (req.url.startsWith("/json/version")) return res.end(J({ Browser: "HeadlessChrome/153.0.0.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
    if (req.url.startsWith("/json/list")) return res.end(J(tabs.map(withWs)));
    if (req.url.startsWith("/json/new")) {
      if (req.method !== "PUT") { res.writeHead(405); return res.end(`Using unsafe HTTP verb ${req.method} to invoke /json/new.`); }
      const q = req.url.indexOf("?");
      const t = { id: "NEW" + nextTab++, type: "page", title: "", url: q < 0 ? "about:blank" : decodeURIComponent(req.url.slice(q + 1)) };
      tabs.push(t);
      return res.end(J(withWs(t)));
    }
    if (req.url.startsWith("/json/close/")) {
      const id = decodeURIComponent(req.url.slice("/json/close/".length));
      const i = tabs.findIndex((t) => t.id === id);
      if (i < 0) { res.writeHead(404); return res.end("No such target id: " + id); }
      tabs.splice(i, 1);
      return res.end("Target is closing");
    }
    res.writeHead(404); res.end("[]");
  });
  srv.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (req.headers.origin) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const tab = decodeURIComponent(String(req.url || "").split("/").pop() || "");
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = !!(buf[1] & 128), key = masked ? buf.slice(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const body = Buffer.from(buf.slice(off, off + len));
        buf = buf.slice(off + len);
        if (key) for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
        let msg;
        try { msg = JSON.parse(body.toString()); } catch { continue; }
        const p = msg.params || {};
        if (msg.method === "Page.navigate") { navs.push({ tab, url: String(p.url || "") }); lastUrl[tab] = String(p.url || ""); }
        const reply = msg.method === "Runtime.evaluate" ? { result: { result: { type: "string", value: "complete" } } }
          : msg.method === "Page.captureScreenshot" ? { result: { data: Buffer.from("PNG:" + (lastUrl[tab] || "")).toString("base64") } }
          : msg.method === "Page.navigate" ? { result: { frameId: "F_" + tab } }
          : { result: {} };
        try { socket.write(wsFrame(J({ id: msg.id, ...reply }))); } catch {}
      }
    });
  });
  srv.tabs = tabs;
  srv.navs = navs;
  srv.kill = () => {
    for (const s of sockets) { try { s.destroy(); } catch {} }
    try { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close(); } catch {}
  };
  return srv;
}

// ============ 单元：子进程里跑（要在 require tools 之前定好数据根，不能跟主进程混用） ============
async function unitMain() {
  let pass = 0, fail = 0;
  const ok = (cond, msg, detail) => {
    if (cond) { pass++; console.log("  ✅ " + msg); }
    else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + J(detail).slice(0, 600))); }
  };
  const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
  let fc = null;
  try {
    const tools = require(mod("tools"));
    const security = require(mod("security"));
    const home = process.env.OPENWORKBUDDY_HOME;
    const ws = path.join(home, "workspace");
    fs.mkdirSync(ws, { recursive: true });
    tools.setWorkspaceDir(ws);
    const SEC = { ...security.DEFAULTS, permission_mode: "full" };
    const rootIdx = path.join(ws, "index.html");
    const OLD = "旧根目录页面";
    fs.writeFileSync(rootIdx, OLD);
    const run = (mod, name, input, sid) => mod.executeTool(name, input, { baseDir: "任务_" + sid, sessionId: sid, security: SEC });

    console.log("\n⓪ 单元：写文件落在哪、浏览器标签页归谁");
    const r1 = await run(tools, "write_file", { path: "index.html", content: "u1 的页面" }, "u1");
    ok(!r1.isError && read(path.join(ws, "任务_u1", "index.html")) === "u1 的页面" && read(rootIdx) === OLD,
      "根下已经有 index.html、这条对话没读过它：写 index.html 落在自己的任务文件夹，根下那份一字不动", { r1: r1.content, root: read(rootIdx) });

    const r2r = await run(tools, "read_file", { path: "index.html" }, "u2");
    const r2w = await run(tools, "write_file", { path: "index.html", content: "u2 接着改" }, "u2");
    ok(String(r2r.content).includes(OLD) && !r2w.isError && read(rootIdx) === "u2 接着改" && read(path.join(ws, "任务_u2", "index.html")) === null,
      "读过根下那份再写：照旧是「接着改那个旧文件」，写回根下（读的兜底规矩没变）", { read: String(r2r.content).slice(0, 80), root: read(rootIdx) });
    fs.writeFileSync(rootIdx, OLD);

    // ★反向对照★ 同一份 tools.js 只去掉「读过才写回根」这一条，另起一份模块：没读过也被兜到根下
    const file = mod("tools");
    const src = fs.readFileSync(file, "utf8");
    const mut = src.replace(' && (mode !== "write" || seenHere(r2.path))', "");
    let mutWrote = null, mutRoot = null;
    if (mut !== src) {
      const Module = require("module");
      const m = new Module(file, null);
      m.filename = file;
      m.paths = Module._nodeModulePaths(ROOT);
      m._compile(mut, file);
      m.exports.setWorkspaceDir(ws);
      await run(m.exports, "write_file", { path: "index.html", content: "u3 的页面" }, "u3");
      mutRoot = read(rootIdx);
      mutWrote = read(path.join(ws, "任务_u3", "index.html"));
      m.exports.setWorkspaceDir(ws);
    }
    ok(mut !== src && mutRoot === "u3 的页面" && mutWrote === null,
      "★反向对照★ 去掉「读过才写回根」：u3 没读过根下 index.html，写的却是根下那份（几条对话轮流盖它）", { changed: mut !== src, mutRoot, mutWrote });
    fs.writeFileSync(rootIdx, OLD);

    // 分文件夹以前的老对话：它自己当年摊在根上的 报告.md，现在「整篇重写」要写回那份，不在新格里另起第二份
    const oldRep = path.join(ws, "报告.md");
    fs.writeFileSync(oldRep, "老报告");
    tools.ownRootFiles("u4", [oldRep]);
    const r4 = await run(tools, "write_file", { path: "报告.md", content: "重写的报告" }, "u4");
    const r4n = await run(tools, "write_file", { path: "新图表.md", content: "新的" }, "u4");
    ok(!r4.isError && read(oldRep) === "重写的报告" && read(path.join(ws, "任务_u4", "报告.md")) === null,
      "老对话登记过的根上文件：没读也整篇重写，写回根上那份", { root: read(oldRep), cell: read(path.join(ws, "任务_u4", "报告.md")) });
    ok(!r4n.isError && read(path.join(ws, "任务_u4", "新图表.md")) === "新的" && read(path.join(ws, "新图表.md")) === null,
      "  └ 同一条对话的新产出：照旧落进自己的文件夹");
    fs.writeFileSync(oldRep, "老报告");
    const r5 = await run(tools, "write_file", { path: "报告.md", content: "u5 的报告" }, "u5");
    ok(!r5.isError && read(oldRep) === "老报告" && read(path.join(ws, "任务_u5", "报告.md")) === "u5 的报告",
      "★反向对照★ 别的对话没登记它：根上那份一字不动，写进自己的格", { root: read(oldRep) });
    tools.ownRootFiles("u6", [oldRep]);
    tools.ownRootFiles("u6", []);
    const r6 = await run(tools, "write_file", { path: "报告.md", content: "撤了以后" }, "u6");
    ok(!r6.isError && read(oldRep) === "老报告" && read(path.join(ws, "任务_u6", "报告.md")) === "撤了以后",
      "★反向对照★ 登记整份换掉（这回是空的）：不再认根上那份", { root: read(oldRep) });
    const mut2 = src.replace(" || (own && own.has(abs))", "");
    let mut2Root = null;
    if (mut2 !== src) {
      const Module = require("module");
      const m = new Module(file, null);
      m.filename = file;
      m.paths = Module._nodeModulePaths(ROOT);
      m._compile(mut2, file);
      m.exports.setWorkspaceDir(ws);
      m.exports.ownRootFiles("u7", [oldRep]);
      await run(m.exports, "write_file", { path: "报告.md", content: "u7 重写" }, "u7");
      mut2Root = read(oldRep);
      m.exports.setWorkspaceDir(ws);
    }
    ok(mut2 !== src && mut2Root === "老报告" && read(path.join(ws, "任务_u7", "报告.md")) === "u7 重写",
      "★反向对照★ 去掉「登记过的老产出算自己的」：重写落进新格，一条对话拆成两份报告", { changed: mut2 !== src, mut2Root });
    fs.rmSync(oldRep, { force: true });

    // cdp：两条对话各自 navigate + screenshot，截到的是各自的页面；收一条只关它自己的标签页
    const cdp = require(mod("cdp"));
    fc = fakeChrome();
    const q = await listen(fc);
    const nav = (owner, url) => cdp.run({ action: "navigate", url, port: q, wait_ms: 0, owner });
    const shot = (owner) => cdp.run({ action: "screenshot", port: q, owner });
    await nav("uA", "http://127.0.0.1:9/a");
    await nav("uB", "http://127.0.0.1:9/b");
    const sa = await shot("uA"), sb = await shot("uB");
    ok(unPng(sa.data) === "PNG:http://127.0.0.1:9/a" && unPng(sb.data) === "PNG:http://127.0.0.1:9/b" && sa.tab_id && sa.tab_id !== sb.tab_id,
      "两条对话交替开页面、截图：各在各的标签页上，截到的是自己的页面", { a: unPng(sa.data), b: unPng(sb.data), ta: sa.tab_id, tb: sb.tab_id });
    await nav("", "http://127.0.0.1:9/c");
    await nav("", "http://127.0.0.1:9/d");
    const s0 = await shot("");
    ok(unPng(s0.data) === "PNG:http://127.0.0.1:9/d",
      "★反向对照★ 不带 owner（共用第一个标签页）：c 开完 d 又开，c 这时截图拿到的是 d 的页面", unPng(s0.data));
    await cdp.releaseOwner("uA");
    const ids = fc.tabs.map((t) => t.id);
    ok(!ids.includes(sa.tab_id) && ids.includes(sb.tab_id), "收 uA 的标签页：只关 uA 那一个，uB 的还开着", ids);
    await cdp.releaseOwner("uB");
  } catch (e) {
    fail++;
    console.log("  ❌ 单元段自己炸了：" + ((e && e.stack) || e));
  }
  try { if (fc) fc.kill(); } catch {}
  console.log(`ISO_UNIT ${pass} ${fail}`);
  process.exit(0);
}

if (process.env.OWB_ISO_UNIT === "1") {
  unitMain();
} else if (!process.versions.electron) {
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs.existsSync(bin)) {
    console.log("跳过：没装 electron，这套要真页面");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 400000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
} else {
  electronMain();
}

// ============ 整套：真 server + 真页面 ============
function electronMain() {
  const { app, BrowserWindow, session } = require("electron");
  if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

  let pass = 0, fail = 0, finished = false;
  let server = null, cliKid = null, unitKid = null, llm = null, fake = null;
  const homes = [], wins = [], pids = new Set(), allPorts = [];
  const held = new Map(), heldOnce = new Set(), released = new Set();

  const ok = (cond, msg, detail) => {
    if (cond) { pass++; console.log("  ✅ " + msg); }
    else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + J(detail).slice(0, 900))); }
  };
  const probe = (port, ms = 800) => new Promise((res) => {
    const rq = http.get({ host: "127.0.0.1", port, path: "/", agent: false, timeout: ms }, (r) => {
      let s = ""; r.setEncoding("utf8");
      r.on("data", (c) => (s += c));
      r.on("end", () => { let o = null; try { o = JSON.parse(s); } catch { o = { raw: s }; } if (o && o.pid) pids.add(o.pid); res(o); });
    });
    rq.on("timeout", () => { rq.destroy(); res(null); });
    rq.on("error", () => res(null));
  });

  async function finish(code) {
    if (finished) return;
    finished = true;
    for (const w of wins) { try { if (!w.isDestroyed()) w.destroy(); } catch {} }
    // 测试里起过的每个端口再敲一遍：还有人应答就记下它的 pid，下面一起送走（keep:true 那个本来就该活着）
    try { await Promise.race([Promise.all(allPorts.map((p) => probe(p, 400))), sleep(3000)]); } catch {}
    for (const k of [server, cliKid, unitKid]) { try { if (k && k.exitCode == null) k.kill("SIGKILL"); } catch {} }
    try { for (const h of held.values()) h.res.destroy(); } catch {}
    try { if (llm) { if (llm.closeAllConnections) llm.closeAllConnections(); llm.close(); } } catch {}
    try { if (fake) fake.kill(); } catch {}
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }); } catch {} }
    console.log(`\n对话隔离：${pass} 过 / ${fail} 挂`);
    app.exit(code);
  }
  process.on("uncaughtException", (e) => { console.error("❌ 对话隔离测试自己炸了：", (e && e.stack) || e); finish(1); });
  process.on("unhandledRejection", (e) => { console.error("❌ 对话隔离测试自己炸了：", (e && e.stack) || e); finish(1); });

  // ---------- 数据根 ----------
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-chat-iso-"));
  homes.push(home);
  const dataDir = path.join(home, "data");
  const WS = path.join(home, "workspace");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(WS, { recursive: true });
  const tok = "tk" + Date.now();
  fs.writeFileSync(path.join(dataDir, "users.json"), J({
    users: [{ username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [tok]: { user: "boss", at: Date.now() } },
  }));
  // 根下几份「更早的」文件：跟事故现场一样，同名的 index.html、chrome-screenshot.png 已经躺在那儿
  const hourAgo = (Date.now() - 3600e3) / 1000;
  const ROOT_FILES = { "index.html": "旧根目录页面", "chrome-screenshot.png": "OLDPNG", "共享.md": "共享原文" };
  for (const [n, c] of Object.entries(ROOT_FILES)) { fs.writeFileSync(path.join(WS, n), c); fs.utimesSync(path.join(WS, n), hourAgo, hourAgo); }

  // ---------- 端口 ----------
  const LET = ["A", "B", "C", "D", "I", "S", "L"];
  const P = {};
  let Q = 0;
  const freePort = async () => {
    for (;;) {
      const s = http.createServer();
      const p = await listen(s);
      await new Promise((r) => s.close(r));
      if (!allPorts.includes(p)) { allPorts.push(p); return p; }
    }
  };

  // ---------- 假模型：按「隔离 X 号」认是哪条对话，按这条对话已经发过几次工具调用走剧本 ----------
  const say = (text) => ({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
  let callSeq = 0;
  const toolCall = (st) => ({ choices: [{ message: { role: "assistant", content: "好，下一步。", tool_calls: [{
    id: "call_" + ++callSeq, type: "function", function: { name: st.name, arguments: J(st.args) },
  }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
  const reply = (res, body) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(J(body));
  };
  const srvJs = (who, port) => `require("http").createServer((q,s)=>s.end(JSON.stringify({who:"${who}",pid:process.pid}))).listen(${port},"127.0.0.1")`;
  const PLAN = {};
  function buildPlans() {
    const page = (X) => `<!doctype html><meta charset="utf-8"><title>${X}</title><h1>${X} 的页面</h1>` +
      `<p>${X} 这一段是正文，撑过 600 字节，免得被当成抓取时的跳转页。</p>`.repeat(12);
    const drafts = (X) => `const fs=require("fs");fs.writeFileSync("_shot.js","// ${X} 截图脚本");fs.writeFileSync("_probe.js","// ${X} 探针");` +
      `fs.writeFileSync("check_1.txt","${X} 自检记录");fs.mkdirSync(".tmp",{recursive:true});fs.writeFileSync(".tmp/scratch.txt","${X} 临时")`;
    const common = (X) => [
      { name: "run_shell", args: { command: `node -e '${srvJs("page-" + X, P[X].p1)}'`, background: true, purpose: "起预览服务" } },
      { name: "run_shell", args: { command: `nohup node -e '${srvJs("stray-" + X, P[X].p2)}' >/dev/null 2>&1 &`, purpose: "甩出去的服务" } },
      { name: "chrome_cdp", args: { action: "navigate", url: `http://127.0.0.1:${P[X].p1}/`, port: Q, wait_ms: 0 } },
    ];
    for (const X of ["A", "B", "C", "D"]) {
      PLAN[X] = [
        { name: "write_file", args: { path: "index.html", content: page(X) } },
        { name: "run_shell", args: { command: `node -e '${drafts(X)}'`, purpose: "写调试草稿" } },
        ...common(X),
        { name: "chrome_cdp", args: { action: "screenshot", port: Q } },
        ...(X === "A" ? [{ name: "run_shell", args: { command: `node -e '${srvJs("keep-A", P.A.p3)}'`, background: true, keep: true, purpose: "留给用户的服务" } }] : []),
        ...(X === "C" ? [
          { gate: true, name: "read_file", args: { path: "共享.md" } },
          { name: "write_file", args: { path: "共享.md", content: "C 改过的共享说明" } },
        ] : []),
        { hold: true, name: "write_file", args: { path: "说明.md", content: `${X} 的说明` } },
        { say: `${X} 做完了` },
      ];
    }
    for (const X of ["I", "S", "L"]) PLAN[X] = [...common(X), { hold: true, say: `${X} 做完了` }];
  }
  const textOf = (m) => (typeof m.content === "string" ? m.content : J(m.content || ""));
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let b = {};
      try { b = JSON.parse(raw); } catch {}
      const msgs = b.messages || [];
      if (!Array.isArray(b.tools) || !b.tools.length) return reply(res, say("好的"));
      let X = "";
      for (const m of msgs) if (m.role === "user") { const all = [...textOf(m).matchAll(/隔离 ([A-Z]) 号/g)]; if (all.length) X = all[all.length - 1][1]; }
      if (!PLAN[X]) return reply(res, say("收到"));
      const n = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length).length;
      const st = PLAN[X][n] || { say: `${X} 做完了` };
      await sleep(300);
      // C 读改 共享.md 要等 A/B/D 都停在最后一步：它们这时都「在跑」，谁的收尾都还没来得及认领这份改动
      if (st.gate) await waitFor(() => ["A", "B", "D"].every((k) => heldOnce.has(k)), 60000, 200);
      const answer = () => reply(res, st.say ? say(st.say) : toolCall(st));
      if (st.hold && !released.has(X)) {
        held.set(X, { res, answer });
        heldOnce.add(X);
        res.on("close", () => { const h = held.get(X); if (h && h.res === res) held.delete(X); });
        return;
      }
      answer();
    });
  });
  function release(X) {
    released.add(X);
    const h = held.get(X);
    if (h) { held.delete(X); h.answer(); }
  }

  const PAGE = `(() => {
    if (window.__iso) return true;
    const cap = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("__late"), ms || 5000))]);
    const nm = (f) => (typeof f === "string" ? f : (f && f.name) || "");
    const iso = window.__iso = { ev: {} };
    iso.rec = (sid, ev) => {
      const box = iso.ev[sid] || (iso.ev[sid] = []);
      if (ev.type === "files") box.push({ type: "files", changed: (ev.changed || []).map(nm), files: (ev.files || []).map((f) => [nm(f), (f && f.mtime) || 0]) });
      else if (ev.type === "sweep") box.push({ type: "sweep", task: ev.task, since: ev.since, paths: (ev.groups || []).flatMap((g) => (g.items || []).flatMap((i) => i.paths || [i.path])) });
      else if (ev.type === "done") box.push({ type: "done" });
    };
    iso.wrap = (sid) => {
      const s = runningSessions.get(sid);
      if (!s || !s.ui) return false;
      if (s.ui.__isoW) return true;
      const h = s.ui.handleEvent;
      s.ui.handleEvent = function (ev) { try { iso.rec(sid, ev); } catch {} return h.apply(this, arguments); };
      s.ui.__isoW = true;
      return true;
    };
    iso.wrapAll = () => [...runningSessions.keys()].filter(iso.wrap);
    iso.pvState = () => ({ cur: pvCurrent, shown: pvPanel.classList.contains("show"), frames: document.querySelectorAll("#pv-body iframe").length });
    iso.snap = () => ({
      cur: sessionId, dir: sessionDirs.get(sessionId) || "",
      items: [...document.querySelectorAll("#file-list .file-item[data-name]")].map((e) => e.dataset.name),
      heads: [...document.querySelectorAll("#file-list .dir-head[data-dir]")].map((e) => e.dataset.dir),
      outs: [...chatCol.querySelectorAll(".out-card[data-name], .out-row[data-name]")].map((e) => e.dataset.name),
      scope: filesInScope(filesCache).list.map((f) => f.name),
      pool: filesCache.map((f) => f.name),
      sweepCards: chatCol.querySelectorAll(".sweep-card").length,
      pv: iso.pvState(),
    });
    iso.open = async (sid, dir) => {
      const r = await cap(openSession(sid));
      if (dir) openDirs.add(dir);
      iso.wrapAll();
      const a = iso.snap();
      try { const f = await cap(fetch("/api/files").then((x) => x.json())); if (Array.isArray(f)) renderFiles(f); } catch {}
      const b = iso.snap();
      return { late: r === "__late", a, b };
    };
    iso.allScope = () => {
      filesAllScope = true; renderFiles(filesCache);
      const heads = [...document.querySelectorAll("#file-list .dir-head[data-dir]")].map((e) => e.dataset.dir);
      filesAllScope = false; renderFiles(filesCache);
      return heads;
    };
    iso.preview = async (name) => {
      await cap(previewFile(name), 3000);
      const fr = document.querySelector("#pv-body .pv-fit iframe") || document.querySelector("#pv-body iframe");
      const src = fr ? fr.getAttribute("src") || "" : "";
      let body = "";
      if (src) { try { body = await cap(fetch(src).then((r) => r.text()), 3000); } catch {} }
      return { cur: pvCurrent, shown: pvPanel.classList.contains("show"), src, body: String(body) };
    };
    iso.pull = () => { const e = iso.ev; iso.ev = {}; return e; };
    return true;
  })()`;

  let log = "";
  app.whenReady().then(async () => {
    setTimeout(() => { console.log("❌ 整套跑了 6 分钟还没完，按挂处理"); finish(1); }, 360000);

    // ---------- ⓪ 单元段（子进程，自己的数据根） ----------
    const uhome = fs.mkdtempSync(path.join(os.tmpdir(), "owb-chat-iso-unit-"));
    homes.push(uhome);
    const unitOut = await new Promise((resolve) => {
      let s = "";
      unitKid = spawn(process.env.OWB_NODE || "node", [__filename], {
        cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OWB_ISO_UNIT: "1", OPENWORKBUDDY_HOME: uhome, OPENWORKBUDDY_DATA_DIR: path.join(uhome, "data"), OWB_CDP_NO_LAUNCH: "1" },
      });
      unitKid.stdout.on("data", (c) => (s += c));
      unitKid.stderr.on("data", (c) => (s += c));
      const t = setTimeout(() => { try { unitKid.kill("SIGKILL"); } catch {} }, 60000);
      unitKid.on("close", () => { clearTimeout(t); resolve(s); });
    });
    const um = /ISO_UNIT (\d+) (\d+)/.exec(unitOut);
    for (const line of unitOut.split("\n")) if (/^\s*(✅|❌|⓪)/.test(line) || /^\n?⓪/.test(line)) console.log(line);
    if (um) { pass += +um[1]; fail += +um[2]; } else { fail++; console.log("  ❌ 单元段没跑完：" + unitOut.slice(-800)); }

    // ---------- 起假 Chrome、假模型、真 server ----------
    fake = fakeChrome();
    Q = await listen(fake);
    for (const X of LET) P[X] = { p1: await freePort(), p2: await freePort() };
    P.A.p3 = await freePort();
    buildPlans();
    const lp = await listen(llm);
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
    cfg.provider = "openai";
    cfg.openai = { base_url: `http://127.0.0.1:${lp}/v1`, api_key: "k", model: "mock", stream: false };
    cfg.models = [{ name: "假模型", provider: "openai", base_url: `http://127.0.0.1:${lp}/v1`, api_key: "k", model: "mock", stream: false }];
    cfg.active_model = "假模型";
    cfg.mcp_servers = [];
    cfg.agent = { ...(cfg.agent || {}), max_steps: 20, llm_timeout_ms: 180000, llm_retries: 0 };
    cfg.security = { ...(cfg.security || {}), permission_mode: "full" };
    fs.writeFileSync(path.join(home, "config.json"), J(cfg));
    server = spawn(process.env.OWB_NODE || "node", [entryPath("server")], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: "0", OWB_CDP_NO_LAUNCH: "1" },
    });
    server.stdout.on("data", (c) => (log += c));
    server.stderr.on("data", (c) => (log += c));
    let port = 0;
    for (let i = 0; i < 300 && !port; i++) { const m = /已启动: http:\/\/localhost:(\d+)/.exec(log); if (m) port = +m[1]; else await sleep(200); }
    if (!port) { console.log("❌ server 没起来：" + log.slice(-800)); return finish(1); }
    const base = "http://127.0.0.1:" + port;
    const api = (method, p, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : J(body);
      const rq = http.request({ host: "127.0.0.1", port, path: p, method, agent: false, headers: {
        Cookie: "openworkbuddy_token=" + tok, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      } }, (r) => {
        let s = ""; r.setEncoding("utf8");
        r.on("data", (c) => (s += c));
        r.on("end", () => resolve({ status: r.statusCode, text: s }));
      });
      rq.on("error", reject);
      rq.end(data || undefined);
    });
    const jget = async (p) => { try { return JSON.parse((await api("GET", p)).text); } catch { return null; } };
    const running = async () => (await jget("/api/chat/running")) || [];
    const nm = (f) => (typeof f === "string" ? f : (f && f.name) || "");
    const changedOf = async (sid) => {
      const d = (await jget("/api/session/" + encodeURIComponent(sid))) || {};
      const out = new Set();
      for (const e of d.transcript || []) for (const ev of e.events || []) if (ev.type === "files") for (const c of ev.changed || []) out.add(nm(c));
      return [...out];
    };
    const exists = (rel) => fs.existsSync(path.join(WS, rel));
    const tabsOf = (X) => [...new Set(fake.navs.filter((n) => n.url === `http://127.0.0.1:${P[X].p1}/`).map((n) => n.tab))];
    const tabOpen = (t) => fake.tabs.some((x) => x.id === t);

    // ---------- 四条对话一起开跑：A/B/C 网页，D 画布 ----------
    const stamp = Date.now();
    const SID = { A: `s_iso_${stamp}_A`, B: `s_iso_${stamp}_B`, C: `s_iso_${stamp}_C`, D: `s_canvas_${stamp}_${Math.floor(Math.random() * 1e6)}` };
    const ask = (X) => `隔离 ${X} 号：写页面、起预览、截图`;
    const CANVAS = "你正在控制当前 OpenWorkBuddy 项目的 AI 短剧无限画布。只操作当前项目和当前画布，不连接其他本地项目。先用 canvas_manage 的 get 读取现有画布，再按用户要求 add/update/connect/delete 节点。";
    for (const X of ["A", "B", "C"]) {
      const r = await api("POST", "/api/chat", { sessionId: SID[X], message: ask(X), mode: "craft", detach: true });
      if (!/"accepted":true/.test(r.text)) { ok(false, `对话 ${X} 没被受理`, r.text.slice(0, 300)); return finish(1); }
    }
    {
      const r = await api("POST", "/api/chat", { sessionId: SID.D, message: CANVAS + "\n用户指令：" + ask("D"), shown: ask("D"), mode: "craft", lang: "zh", detach: true });
      if (!/"accepted":true/.test(r.text)) { ok(false, "画布那条（D）没被受理", r.text.slice(0, 300)); return finish(1); }
    }
    const DIR = {};
    await waitFor(async () => {
      for (const X of ["A", "B", "C", "D"]) if (!DIR[X]) { const d = await jget("/api/session/" + encodeURIComponent(SID[X])); if (d && d.dir) DIR[X] = d.dir; }
      return ["A", "B", "C", "D"].every((X) => DIR[X]);
    }, 20000, 200);
    const dirs = ["A", "B", "C", "D"].map((X) => DIR[X]);
    ok(dirs.every(Boolean) && new Set(dirs).size === 4, "四条对话（含画布）各分到一个任务文件夹", DIR);
    if (!dirs.every(Boolean)) { console.log(log.slice(-1500)); return finish(1); }
    const others = (X) => ["A", "B", "C", "D"].filter((Y) => Y !== X);
    const mineName = (X, n, shared) => n.startsWith(DIR[X] + "/") || (shared && X === "C" && n === "共享.md");
    const foreign = (X, names, shared) => (names || []).filter((n) => n && !mineName(X, n, shared));
    // C 读过又改的 共享.md 在根上：它算 C 的老产出，C 的成果面板里「本对话」会多一组根目录（"."）——只 C 有，A/B/D 有就是串了
    const foreignHeads = (X, heads, shared) => (heads || []).filter((h) => h !== DIR[X] && !h.startsWith(DIR[X] + "/") && !(shared && X === "C" && h === "."));

    // ---------- 窗口（隐藏、离屏） ----------
    const part = "iso-main";
    await session.fromPartition(part).cookies.set({ url: base, name: "openworkbuddy_token", value: tok });
    const win = new BrowserWindow({ show: false, x: -20000, y: -20000, width: 1300, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false, partition: part } });
    wins.push(win);
    const js = (s) => win.webContents.executeJavaScript(s);
    const boot = async () => {
      await waitFor(() => js(`!window.__preReload && document.readyState === "complete" && typeof liveCh === "object" && typeof reattachRunning === "function"`).catch(() => false), 20000, 100);
      await js('I18N.setLang("zh")');
      await sleep(1200);
      await js(PAGE);
      await js(`reattachRunning().then(() => __iso.wrapAll().length)`);
      const want = (await running()).filter((s) => Object.values(SID).includes(s)).length;
      await waitFor(() => js(`(${J(Object.values(SID))}).filter((s) => runningSessions.has(s)).length >= ${want}`).catch(() => false), 10000, 200);
      await js(`__iso.wrapAll().length`);
    };
    await win.loadURL(base + "/");
    await boot();
    const attached = await js(`(${J(Object.values(SID))}).filter((s) => runningSessions.has(s)).length`);
    ok(attached === 4, "这一页接上了 4 趟在跑的", attached);

    // ============ ① 跑到一半来回切 ============
    console.log("\n① 四条同时在跑，来回切着看：成果面板、文件清单、产出卡只有自己的");
    const bad = [];
    let cycles = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      for (const X of ["A", "B", "C", "D"]) {
        const o = await js(`__iso.open(${J(SID[X])}, ${J(DIR[X])})`);
        cycles++;
        for (const s of [o.a, o.b]) {
          const f = { items: foreign(X, s.items, true), heads: foreignHeads(X, s.heads, true), scope: foreign(X, s.scope, true), outs: foreign(X, s.outs, true) };
          if (s.cur !== SID[X] || f.items.length || f.heads.length || f.scope.length || f.outs.length) bad.push({ X, cur: s.cur === SID[X], ...f });
        }
      }
      if (heldOnce.size >= 4 && cycles >= 8) break;
    }
    ok(heldOnce.size === 4, "四条都走到了最后一步（都还在跑）", [...heldOnce]);
    ok(cycles >= 8 && !bad.length, `跑到一半切了 ${cycles} 次：每次屏幕上只有当前这条对话的文件和产出`, bad.slice(0, 4));

    const fp = {};
    let prevPv = null;
    for (const X of ["A", "B", "C", "D", "A"]) {
      const o = await js(`__iso.open(${J(SID[X])}, ${J(DIR[X])})`);
      if (prevPv) ok(!o.a.pv.cur && !o.a.pv.shown && o.a.pv.frames === 0, `切到 ${X}：上一条（${prevPv}）开着的预览当场收掉`, o.a.pv);
      if (prevPv && X === "A") break;
      const b = o.b;
      ok(b.items.includes(DIR[X] + "/index.html") && !foreign(X, b.items, true).length && !foreignHeads(X, b.heads, true).length && !foreign(X, b.scope, true).length && (X === "C") === b.scope.includes("共享.md"),
        `${X}：成果面板里有自己的 index.html，没有别家的文件夹和文件${X === "C" ? "，根上读过又改的 共享.md 也列在本对话里" : ""}`, { items: b.items, heads: b.heads, scope: b.scope });
      ok(b.outs.includes(DIR[X] + "/index.html") && !foreign(X, b.outs, true).length, `${X}：对话里的产出卡只指向自己的文件`, b.outs);
      const ch = await changedOf(SID[X]);
      const chBad = foreign(X, ch, true);
      ok(ch.includes(DIR[X] + "/index.html") && !chBad.length && (X === "C") === ch.includes("共享.md"),
        `${X}：服务端记下的「这一轮改了哪些」只有自己文件夹里的${X === "C" ? "，外加它读过又改的 共享.md" : ""}`, { ch, chBad });
      const idx = fs.readFileSync(path.join(WS, DIR[X], "index.html"), "utf8");
      const png = (() => { try { return fs.readFileSync(path.join(WS, DIR[X], "chrome-screenshot.png"), "utf8"); } catch { return ""; } })();
      ok(idx.includes(`${X} 的页面`) && png === `PNG:http://127.0.0.1:${P[X].p1}/` && ["_shot.js", "_probe.js", "check_1.txt", ".tmp/scratch.txt"].every((f) => exists(DIR[X] + "/" + f)),
        `${X}：index.html、截图、调试草稿都落在自己的文件夹，截图拍的是自己的预览页`, { png });
      const tabs = tabsOf(X);
      const tabNavs = fake.navs.filter((n) => tabs.includes(n.tab)).map((n) => n.url);
      ok(tabs.length === 1 && tabs[0] !== "TAB1" && tabOpen(tabs[0]) && tabNavs.every((u) => u === `http://127.0.0.1:${P[X].p1}/`),
        `${X}：浏览器里开的是自己那个标签页，这个标签页没被别的对话拿去开过别的页面`, { tabs, tabNavs });
      const pv = await js(`__iso.preview(${J(DIR[X] + "/index.html")})`);
      let src = pv.src;
      try { src = decodeURIComponent(pv.src); } catch {}
      ok(pv.cur === DIR[X] + "/index.html" && pv.shown && src.includes(DIR[X] + "/index.html") && pv.body.includes(`${X} 的页面`) && !others(X).some((Y) => pv.body.includes(`${Y} 的页面`)),
        `${X}：预览面板打开的是自己的 index.html（内容是 ${X} 的页面）`, { cur: pv.cur, shown: pv.shown, src: pv.src.slice(0, 120), body: pv.body.slice(0, 80) });
      prevPv = X;
      const [a1, a2] = await Promise.all([probe(P[X].p1), probe(P[X].p2)]);
      fp[X] = { a1, a2 };
      ok(a1 && a1.who === "page-" + X && a2 && a2.who === "stray-" + X, `${X}：自己的预览服务和甩出去的那个都在、端口上是自己的`, { a1, a2 });
    }
    ok(Object.keys(fp).length === 4 && Object.values(fp).every((v) => v.a2 && v.a2.who.startsWith("stray-")),
      "★反向对照★ `nohup … &` 那条命令早就返回了，它甩出去的服务还活着：不专门收，它会一直挂着", fp);
    {
      const allHeads = await js(`__iso.allScope()`);
      const saw = ["A", "B", "C", "D"].filter((X) => allHeads.includes(DIR[X]));
      ok(saw.length === 4, "★反向对照★ 同一份文件清单切到「全部」：四条对话的文件夹都在里面（分开看是面板在分，不是数据本来就分开）", allHeads);
      const ev = await js(`__iso.ev`);
      const mixed = ["A", "B", "C", "D"].filter((X) => (ev[SID[X]] || []).some((e) => e.type === "files" && e.files.some(([n]) => others(X).some((Y) => n.startsWith(DIR[Y] + "/")))));
      ok(mixed.length >= 2, "★反向对照★ 页面收到的 files 事件里，整份清单本来就混着别的对话的文件（只按「这一轮改了哪些」分）", mixed);
    }

    // ============ ② 刷新接回 ============
    console.log("\n② 刷新页面接回来：还是各看各的");
    await js(`window.__preReload = 1`);
    win.webContents.reload();
    await boot();
    for (const X of ["A", "B", "C", "D"]) {
      const o = await js(`__iso.open(${J(SID[X])}, ${J(DIR[X])})`);
      const b = o.b;
      ok(b.cur === SID[X] && b.items.includes(DIR[X] + "/index.html") && !foreign(X, b.items, true).length && !foreignHeads(X, b.heads, true).length && !foreign(X, b.scope, true).length && !foreign(X, b.outs, true).length && (X === "C") === b.scope.includes("共享.md"),
        `刷新后点开 ${X}：成果面板、产出卡只有自己的${X === "C" ? "（共享.md 照样算 C 的）" : ""}`, { items: b.items, heads: b.heads, scope: b.scope, outs: b.outs });
    }
    {
      const allHeads = await js(`__iso.allScope()`);
      ok(["A", "B", "C", "D"].every((X) => allHeads.includes(DIR[X])), "★反向对照★ 刷新后切到「全部」：四个文件夹都在", allHeads);
    }

    // ============ ③ A 收尾：清 .tmp、清草稿 ============
    console.log("\n③ A 跑完收尾：.tmp 旧文件、调试草稿只清 A 自己的");
    const fiveDaysAgo = (Date.now() - 5 * 86400e3) / 1000;
    for (const X of ["A", "B", "C", "D"]) {
      const f = path.join(WS, DIR[X], ".tmp", `old_${X}.txt`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `${X} 五天前的临时文件`);
      fs.utimesSync(f, fiveDaysAgo, fiveDaysAgo);
    }
    await js(`__iso.open(${J(SID.A)}, ${J(DIR.A)})`);
    await js(`__iso.pull()`);
    release("A");
    const aEnded = await waitFor(async () => !(await running()).includes(SID.A) && !(await js(`runningSessions.has(${J(SID.A)})`)), 30000, 200);
    ok(aEnded, "A 跑完了（服务端和页面都认）");
    await sleep(500);
    const evA = ((await js(`__iso.ev`))[SID.A]) || [];
    const chA = [...new Set(evA.filter((e) => e.type === "files").flatMap((e) => e.changed))];
    const swA = evA.find((e) => e.type === "sweep");
    ok(J(chA) === J([DIR.A + "/说明.md"]), "A 最后一步只算自己写的 说明.md（C 刚改的 共享.md 不算 A 的）", chA);
    const sharedInPool = evA.some((e) => e.type === "files" && e.files.some(([n, m]) => n === "共享.md" && swA && Date.parse(m) >= swA.since));
    ok(sharedInPool && !chA.includes("共享.md"),
      "★反向对照★ A 收到的整份清单里 共享.md 的修改时间就在 A 这一趟之内：按「这一趟里改过的都算我的」会把它认成 A 的", { sharedInPool, since: swA && swA.since });
    const prunedA = await waitFor(() => !exists(`${DIR.A}/.tmp/old_A.txt`), 8000, 150);
    ok(prunedA && ["B", "C", "D"].every((X) => exists(`${DIR[X]}/.tmp/old_${X}.txt`)) && exists(`${DIR.A}/.tmp/scratch.txt`),
      "A 收尾清 .tmp：只清 A 自己文件夹里过了期的，B/C/D 的旧文件、A 刚写的临时文件都还在");
    ok(!!swA && swA.task === DIR.A && swA.paths.length > 0 && swA.paths.every((p) => p.startsWith(DIR.A + "/")) && swA.paths.includes(DIR.A + "/_shot.js"),
      "收尾那张「清掉草稿」卡：只列 A 文件夹里的", swA);
    const clicked = await js(`(() => { const b = chatCol.querySelector(".sweep-card .sw-go"); if (!b) return false; b.click(); return true; })()`);
    const swDone = clicked && await waitFor(() => js(`!!chatCol.querySelector(".sweep-card.done")`), 8000, 150);
    const drafts = ["_shot.js", "_probe.js", "check_1.txt"];
    ok(swDone && drafts.every((f) => !exists(`${DIR.A}/${f}`)) && ["B", "C", "D"].every((X) => drafts.every((f) => exists(`${DIR[X]}/${f}`))),
      "点「清掉」：A 的草稿删了，B/C/D 同名的草稿一个没动", { clicked, swDone });
    const oB = await js(`__iso.open(${J(SID.B)}, ${J(DIR.B)})`);
    ok(oB.b.sweepCards === 0, "切到 B：A 那张清理卡不跟过来", oB.b.sweepCards);
    const forged = JSON.parse((await api("POST", "/api/files/sweep", { paths: [DIR.B + "/_shot.js"], since: swA ? swA.since : Date.now(), task: DIR.A })).text || "{}");
    ok(forged.skipped >= 1 && !(forged.removed || []).length && exists(DIR.B + "/_shot.js"), "拿 A 的卡去删 B 的草稿：服务端对不上清单，一个都不删", forged);
    const wide = (await jget(`/api/files/sweep?since=${swA ? swA.since : 0}`)) || {};
    const widePaths = (wide.groups || []).flatMap((g) => (g.items || []).flatMap((i) => i.paths || [i.path]));
    ok(widePaths.includes(DIR.B + "/_shot.js"), "★反向对照★ 同一个起点不限任务文件夹算：B 的草稿就在清单里（收尾卡按任务文件夹圈住才没端上来）", widePaths);

    // ============ ④ 跑完 / 停下：只收自己的 ============
    console.log("\n④ 一条跑完、一条被停：只收它自己的服务、散户进程、标签页");
    const deadA = await waitFor(async () => !(await probe(P.A.p1, 400)) && !(await probe(P.A.p2, 400)), 8000, 200);
    ok(deadA && !tabsOf("A").some(tabOpen), "A 跑完：A 的预览服务、甩出去的服务、标签页都收了", { deadA, tabs: tabsOf("A") });
    const liveBCD = await Promise.all(["B", "C", "D"].map(async (X) => ({ X, a1: await probe(P[X].p1), a2: await probe(P[X].p2), tab: tabsOf(X).some(tabOpen) })));
    ok(liveBCD.every((v) => v.a1 && v.a1.who === "page-" + v.X && v.a2 && v.a2.who === "stray-" + v.X && v.tab), "A 收尾没碰 B/C/D：它们的服务和标签页都还在", liveBCD);
    const keepA = await probe(P.A.p3);
    ok(keepA && keepA.who === "keep-A", "★反向对照★ A 起的时候说了 keep:true 的那个服务：跑完照样留着（收的是没说留的）", keepA);
    const st = JSON.parse((await api("POST", "/api/chat/stop", { sessionId: SID.B })).text || "{}");
    const bEnded = await waitFor(async () => !(await running()).includes(SID.B), 20000, 200);
    const deadB = bEnded && await waitFor(async () => !(await probe(P.B.p1, 400)) && !(await probe(P.B.p2, 400)), 8000, 200);
    ok(st.ok && deadB && !tabsOf("B").some(tabOpen), "停下 B：B 的服务、甩出去的服务、标签页都收了", { st, bEnded, deadB });
    const liveCD = await Promise.all(["C", "D"].map(async (X) => ({ X, a1: await probe(P[X].p1), a2: await probe(P[X].p2), tab: tabsOf(X).some(tabOpen) })));
    ok(liveCD.every((v) => v.a1 && v.a2 && v.tab), "停 B 没碰 C/D", liveCD);
    release("C");
    release("D");
    const cdEnded = await waitFor(async () => { const r = await running(); return !r.includes(SID.C) && !r.includes(SID.D); }, 30000, 200);
    const deadCD = cdEnded && await waitFor(async () => {
      for (const X of ["C", "D"]) if ((await probe(P[X].p1, 400)) || (await probe(P[X].p2, 400))) return false;
      return true;
    }, 8000, 200);
    const prunedCD = await waitFor(() => !exists(`${DIR.C}/.tmp/old_C.txt`) && !exists(`${DIR.D}/.tmp/old_D.txt`), 8000, 150);
    ok(cdEnded && deadCD && !tabsOf("C").some(tabOpen) && !tabsOf("D").some(tabOpen) && prunedCD, "C/D（含画布那条）跑完：各自的服务、标签页、.tmp 旧文件都收了", { cdEnded, deadCD, prunedCD });
    const fin = {};
    for (const X of ["A", "B", "C", "D"]) fin[X] = await changedOf(SID[X]);
    ok(["A", "B", "D"].every((X) => !fin[X].includes("共享.md") && !foreign(X, fin[X]).length) && fin.C.includes("共享.md") && !foreign("C", fin.C, true).length,
      "四条都收完：每条记下的改动只有自己的，共享.md 只算在读过又改了它的 C 头上", fin);
    ok(fs.readFileSync(path.join(WS, "index.html"), "utf8") === ROOT_FILES["index.html"] && fs.readFileSync(path.join(WS, "chrome-screenshot.png"), "utf8") === ROOT_FILES["chrome-screenshot.png"] && fs.readFileSync(path.join(WS, "共享.md"), "utf8") === "C 改过的共享说明",
      "根下那份旧 index.html、旧截图一字没动；共享.md 是 C 读过再改的，写回了根下");

    // ============ ⑤ 其余入口：IM、定时任务、命令行 ============
    console.log("\n⑤ IM、定时任务、命令行跑完：后台命令、甩出去的进程、标签页一样收");
    const entry = async (X, label, start) => {
      const done = start();
      const up = await waitFor(() => held.has(X), 40000, 200);
      const [a1, a2] = await Promise.all([probe(P[X].p1), probe(P[X].p2)]);
      const tabs = tabsOf(X);
      ok(up && a1 && a1.who === "page-" + X && a2 && a2.who === "stray-" + X && tabs.length === 1 && tabOpen(tabs[0]),
        `★反向对照★ ${label}跑到一半：预览服务、甩出去的服务、标签页都在`, { up, a1, a2, tabs });
      release(X);
      const r = await Promise.race([done, sleep(40000).then(() => ({ late: true }))]);
      const dead = await waitFor(async () => !(await probe(P[X].p1, 400)) && !(await probe(P[X].p2, 400)), 8000, 200);
      ok(!r.late && dead && !tabs.some(tabOpen), `${label}跑完：这一趟起的服务、甩出去的服务、标签页都收了`, { r: J(r).slice(0, 300), dead, tabs: tabs.filter(tabOpen) });
    };
    await entry("I", "IM（助理页 /im/local）", () => api("POST", "/im/local", { message: "隔离 I 号：起服务、开页面" }).then((r) => ({ status: r.status, text: r.text.slice(0, 120) })));
    await entry("S", "定时任务（手动跑一次）", async () => {
      const it = JSON.parse((await api("POST", "/api/schedules", { name: "隔离定时", cron: "0 3 1 1 *", task: "隔离 S 号：起服务、开页面", catch_up: false })).text || "{}");
      if (!it.id) return { error: "定时任务没建成" };
      const r = await api("POST", `/api/schedules/${encodeURIComponent(it.id)}/run`, {});
      return { status: r.status, text: r.text.slice(0, 120) };
    });
    const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), "owb-chat-iso-cli-"));
    homes.push(cliHome);
    const cliWs = path.join(cliHome, "ws");
    fs.mkdirSync(cliWs, { recursive: true });
    fs.mkdirSync(path.join(cliHome, "data", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(cliHome, "config.json"), J(cfg));
    await entry("L", "命令行（openworkbuddy 一次性跑）", () => new Promise((resolve) => {
      let out = "";
      cliKid = spawn(process.env.OWB_NODE || "node", [entryPath("cli"), "-C", cliWs, "隔离 L 号：起服务、开页面", "--no-mcp"], {
        cwd: cliWs, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENWORKBUDDY_HOME: cliHome, OPENWORKBUDDY_DATA_DIR: path.join(cliHome, "data"), NO_COLOR: "1", OWB_CDP_NO_LAUNCH: "1" },
      });
      cliKid.stdout.on("data", (c) => (out += c));
      cliKid.stderr.on("data", (c) => (out += c));
      cliKid.on("close", (code) => resolve({ code, tail: out.slice(-200) }));
    }));

    finish(fail ? 1 : 0);
  }).catch((e) => { console.error("❌ 对话隔离测试自己炸了：", (e && e.stack) || e); finish(1); });
}
