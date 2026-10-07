// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 借出去的工具交回主进程跑（src/engines/tool-relay.js；属主在引擎卡上勾的 engine_options[引擎].relay，默认关）。
 *
 *   ① 收发本身：一趟一张凭据；凭据不对、另一趟的凭据、名单外、allow 之前、只读那一趟读以外的，一律拒、不执行；
 *      收工之后凭据吊销；桥那头连不上、没回话、回的不是 JSON 各说各的
 *   ② 叫停 / 超时 / 断开：这一趟叫停了手上的停、新来的拒；桥那头断开这一单跟着停；收工时手上的叫停、等它回完；
 *      时限按函数现取（睡醒顺延的那份）
 *   ③ 上下文：在开跑时的那份里执行（谁在跑、工作区），调用从哪个上下文进来都一样
 *   ④ 权限与边界：目录 0700、凭据 0600、套接字 0600；临时目录太长退回 /tmp；一行太大的拒
 *   ⑤ 工具卡对号：按名字排队、先来先取，结果先到的划掉
 *   ⑥ 桥那头：有凭据文件就只管收发——设置文件坏了也照样交回去跑；交不回去明说没做成
 *      （MCP 回 isError，命令行退出码 2），不退回自己跑；CLI 叫停（notifications/cancelled、SIGTERM）主进程那一单跟着停
 *   ⑦ attach：claude 的 MCP 和 owb 都交回去；codex 只有 MCP 交回去（它的命令沙箱连不了本机套接字）；没开就都不带
 *   ⑧ 主进程真跑一趟（桩引擎）：环境变量里只有文件路径；工具在这一趟的上下文里跑（谁在跑、租户根、资料库、回执路径、
 *      任务名、权限档位）；进度挂上 CLI 那张工具卡；视频上游收了单记台账、等片子时占住、交到手放开；跑完吊销；
 *      口子开不了照老样子；没开就不带
 *   ⑨ 视频台账：交回主进程跑的那一单占着时，后台收单那一路先等
 *   ⑩ 开关：设置页读得到（只认 true）、成员改不了；起一台真的 server.js，属主勾上、去掉，config.json 跟着变
 *
 * 不起真 CLI、不出网：交回来的那一单由探针接住（赶在 require agent 之前换掉 tools.executeTool），不碰真工具。
 *   node test/engine-tool-relay.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { mod, ROOT: REPO } = require("./lib/mod");
// 赶在 require 生产模块之前：设置、审计、台账都落进临时家（见 test/lib/own-home.js）
const HOME = require("./lib/own-home")("engine-tool-relay");

const relay = require(mod("tool-relay"));
const bridge = require(mod("bridge"));
const tools = require(mod("tools"));
const quota = require(mod("quota"));
const harvest = require(mod("harvest"));
const security = require(mod("security"));
const { READ_ONLY, LENDABLE } = require(mod("lendable"));
const MEDIA = require(path.join(REPO, "src", "tools", "media"));

let pass = 0, fail = 0, finished = false;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);
const SH = process.platform !== "win32"; // 套接字权限、owb 脚本都是 unix 那一套
process.on("exit", (code) => {
  // 起子进程、开口子的用例卡在半路时，事件循环一空就退、退出码还是 0：没走到最后一行就算红
  if (!finished) { fail++; console.log(`\n  ❌ 这套测试没跑完就退了（跑到第 ${pass + fail - 1} 条）`); }
  console.log(`\n${pass} 通过，${fail} 失败`);
  if (fail && !code) process.exitCode = 1;
});

// ⑧ 要看交回来的那一单在主进程里拿到的是什么。agent.js 加载时就把 executeTool 解构走了，所以得赶在 require agent 之前换掉。
// 只接带 probe 的调用，别的照原样走
const realExec = tools.executeTool;
const probes = [];
tools.executeTool = async function probeExec(name, args, opts = {}) {
  if (!args || !args.probe) return realExec.apply(this, arguments);
  const seen = {
    name, probe: args.probe,
    actor: quota.currentActor(), root: tools.getWorkspaceDir(), lib: tools.libBase(), mount: tools.getLibraryDir(),
    reply: MEDIA.replyBaseDir(),
    knownTools: opts.knownTools, keep: opts.keepUpstreamOnStop,
    hasVision: Object.prototype.hasOwnProperty.call(opts, "visionFallback"), vision: opts.visionFallback,
    taskLabel: opts.taskLabel, actorOpt: opts.actor, baseDir: opts.baseDir, security: opts.security,
    callId: opts.callId, progress: typeof opts.onProgress === "function", signal: !!opts.signal,
  };
  probes.push(seen);
  if (seen.progress) opts.onProgress({ stage: "探", label: "探针" });
  // 生视频那种上游一收单就回报任务号的：主进程这边记台账，这一单还在这儿等片子时占住（后台那一路见 ⑨）
  if (args.probe === "mcp" && typeof opts.onSubmitted === "function") {
    opts.onSubmitted({ proto: "relaytest", taskId: "t-relay-1", fname: "b.mp4", saveDir: HOME, model: "m", chan: "x" });
    seen.held = [...harvest._internals.held];
  }
  return { content: `探到了：${name}`, isError: false };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等到 cond() 成立，最多 ms 毫秒；成立给 true */
async function until(cond, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(15); }
  return true;
}
/** 等 p，最多 ms 毫秒；超时给 {timeout: true}（变异里那一单可能永远不回，别把整套卡死） */
const within = (p, ms = 5000) => Promise.race([p, sleep(ms).then(() => ({ timeout: true }))]);
/** 成败都收成一个对象：{v} 或 {err, e} */
const settle = (p) => p.then((v) => ({ v }), (e) => ({ err: String((e && e.message) || e), e }));
const line = (t, name, args = {}, op = "call") => JSON.stringify({ t, op, name, args }) + "\n";
const ticketOf = (r) => JSON.parse(fs.readFileSync(r.ticketFile, "utf8")).ticket;
/** 不经 call()：照协议直接往套接字发（line 为 null 就只连不发），拿回第一行 */
function raw(sock, text, { ms = 5000 } = {}) {
  return new Promise((resolve) => {
    let buf = "", done = false;
    const c = net.createConnection(sock);
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); c.destroy(); resolve(v); };
    const t = setTimeout(() => fin({ timeout: true }), ms);
    c.setEncoding("utf8");
    c.on("connect", () => { if (text !== null) c.write(text); });
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try { fin(JSON.parse(buf.slice(0, i))); } catch { fin({ bad: buf }); }
    });
    c.on("error", (e) => fin({ down: e.code || e.message }));
    c.on("close", () => fin({ closed: true, buf }));
  });
}
/** 照 CLI 的样子拉起 MCP 服务器（异步：口子就在本进程里，同步起子进程会把自己卡死） */
function mcpLive(server, extraEnv = {}) {
  const env = { ...process.env, ...(server.env || {}), ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined || v === null) delete env[k];
  const p = spawn(server.command, server.args || [], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const waiting = new Map();
  let buf = "", err = "", id = 1;
  const exited = new Promise((r) => p.on("exit", (code, signal) => r({ code, signal })));
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d) => { err += d; });
  p.stdin.on("error", () => {});
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  p.stdin.write([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n");
  const start = (msg, ms = 30000) => {
    const my = ++id;
    const done = new Promise((resolve) => {
      const t = setTimeout(() => { waiting.delete(my); resolve(undefined); }, ms);
      waiting.set(my, (m) => { clearTimeout(t); resolve(m); });
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, ...msg }) + "\n");
    return { id: my, done };
  };
  return {
    exited, stderr: () => err,
    start, send: (msg, ms) => start(msg, ms).done,
    notify: (msg) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"),
    kill: (sig) => { try { p.kill(sig); } catch {} },
    close: () => {
      try { p.stdin.end(); } catch {}
      const t = setTimeout(() => { try { p.kill(); } catch {} }, 3000);
      t.unref();
      return exited;
    },
  };
}
const callMsg = (name, args = {}) => ({ method: "tools/call", params: { name, arguments: args } });
const textOf = (res) => (res && res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || "";
/** 起一个命令跑完，收 stdout 和退出码（异步，理由同上） */
function runCmd(command, args, env = {}, ms = 30000) {
  return new Promise((resolve) => {
    const all = { ...process.env, ...env };
    for (const [k, v] of Object.entries(all)) if (v === undefined || v === null) delete all[k];
    const p = spawn(command, args, { env: all, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => { try { p.kill(); } catch {} }, ms);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
const mode = (p) => fs.statSync(p).mode & 0o777;

(async () => {
  const calls = [];
  const exec = async (name, args) => {
    calls.push({ name, args });
    if (args && args.fail) return { content: `${name} 跑挂了`, isError: true };
    return { content: `跑了 ${name}`, isError: false };
  };

  section("① 收发本身：一趟一张凭据，名单外的、收工之后的一律拒、不执行");
  {
    const r = await relay.open({ exec });
    const info = JSON.parse(fs.readFileSync(r.ticketFile, "utf8"));
    ok(/^[0-9a-f]{64}$/.test(info.ticket) && info.sock === r.sock, "凭据文件里是套接字地址和一串 64 位随机数", { sock: info.sock, len: String(info.ticket).length });
    ok(Object.keys(r.env).length === 1 && r.env[relay.ENV] === r.ticketFile && !JSON.stringify(r.env).includes(info.ticket),
      "★环境变量里只有凭据文件的路径，不带凭据本身（codex 把 MCP 的环境变量摊在命令行上）★", r.env);
    const pre = await settle(relay.call(r.ticketFile, "web_search", { q: "x" }));
    ok(/还没准备好/.test(pre.err || "") && calls.length === 0, "allow() 之前来的拒（名单还没定）", pre.err);
    r.allow(["web_search", "generate_image"]);
    const good = await relay.call(r.ticketFile, "web_search", { q: "猫" });
    ok(good.text === "跑了 web_search" && good.isError === false && calls.length === 1 && calls[0].args.q === "猫", "借出去的照跑，参数原样交到主进程", { good, calls });
    const bad = await relay.call(r.ticketFile, "generate_image", { fail: 1 });
    ok(bad.isError === true && bad.text === "generate_image 跑挂了", "工具自己报错：原样带回，标成出错", bad);
    const n0 = calls.length;
    const notLent = await settle(relay.call(r.ticketFile, "run_shell", { command: "ls" }));
    ok(/工具 run_shell 没有借给本机引擎/.test(notLent.err || "") && !(notLent.e && notLent.e.connect), "名单外的拒（不是连不上，是明着拒）", notLent.err);
    const noName = await raw(r.sock, line(info.ticket, undefined));
    ok(/没写名字/.test(noName.error || ""), "没写工具名的拒", noName);
    const wrong = await raw(r.sock, line("0".repeat(64), "web_search"));
    const none = await raw(r.sock, JSON.stringify({ op: "call", name: "web_search", args: {} }) + "\n");
    ok(/凭据对不上/.test(wrong.error || "") && /凭据对不上/.test(none.error || ""), "★凭据不对、没带凭据的拒★", { wrong, none });
    const r2 = await relay.open({ exec });
    r2.allow(["web_search"]);
    const t2 = ticketOf(r2);
    const cross = await raw(r.sock, line(t2, "web_search"));
    ok(t2 !== info.ticket && /凭据对不上/.test(cross.error || ""), "★另一趟的凭据在这一趟的口子上不认（一趟一张）★", cross);
    const op = await raw(r.sock, line(info.ticket, "web_search", {}, "list"));
    ok(/不认 list 这种请求/.test(op.error || ""), "只认 call 这一种请求", op);
    const nj = await raw(r.sock, "{不是 JSON\n");
    ok(/请求不是 JSON/.test(nj.error || ""), "一行不是 JSON 的拒", nj);
    ok(calls.length === n0, "以上拒掉的一单都没执行", calls.slice(n0));
    const arr = await raw(r.sock, line(info.ticket, "web_search", [1, 2]));
    const str = await raw(r.sock, line(info.ticket, "web_search", "q=1"));
    ok(arr.text === "跑了 web_search" && str.text === "跑了 web_search" && JSON.stringify(calls.slice(-2).map((c) => c.args)) === "[{},{}]",
      "参数不是对象的按空对象交（不把数组、字符串递进工具）", calls.slice(-2));
    const thrower = await relay.open({ exec: async () => { throw new Error("上游 502"); } });
    thrower.allow(["web_search"]);
    const thrS = await settle(relay.call(thrower.ticketFile, "web_search", {}));
    const thr = thrS.v || {};
    ok(thr.isError === true && thr.text === "上游 502", "主进程这边跑的时候抛了：原话带回、标成出错（不当成协议错误）", thrS.err || thr);
    await thrower.close();
    const n1 = calls.length;
    await r.close();
    ok(!fs.existsSync(r.ticketFile) && !fs.existsSync(r.dir), "收工：凭据文件和目录都删了", r.dir);
    const late = await settle(relay.call(r.ticketFile, "web_search", {}));
    ok(late.e && late.e.connect === true && /凭据文件读不出来/.test(late.err), "★收工之后桥照文件找凭据：读不出来，明说这一单没发出去（connect）★", late.err);
    const lateRaw = await raw(info.sock, line(info.ticket, "web_search"));
    ok(!!(lateRaw.down || lateRaw.closed) && !lateRaw.text, "拿着旧凭据直接连旧地址：连不上", lateRaw);
    ok(calls.length === n1, "收工之后一单也没执行");
    await r.close();
    ok(true, "收工两次不出错");
    await r2.close();

    const ro = await relay.open({ exec, readOnly: true });
    ro.allow(["web_search", "generate_image", "library_list"]);
    const roBad = await settle(relay.call(ro.ticketFile, "generate_image", {}));
    const roOk = await relay.call(ro.ticketFile, "library_list", {});
    ok(/只读/.test(roBad.err || "") && roOk.text === "跑了 library_list", "★只读那一趟：名单里有也只认读的那几样（桥那头之外再拦一道）★", roBad.err);
    ok(READ_ONLY.includes("library_list") && !READ_ONLY.includes("generate_image"), "前提：读的那份名单就是 lendable.js 的 READ_ONLY");
    await ro.close();

    // 桥那头的几种「没回成」：各说各的，连不上的才带 connect（桥据此说「交不回主进程」）
    // 建在 HOME 里、跟着它一起收：repo-hygiene【7】把嵌套的 mkdtemp 当成「建在 tmp 之外」
    const fakeDir = path.join(HOME, "fake");
    fs.mkdirSync(fakeDir);
    const fakeSock = SH ? path.join(fakeDir, "s") : `\\\\.\\pipe\\owb-relay-test-${process.pid}`;
    const fakeTicket = path.join(fakeDir, "ticket");
    fs.writeFileSync(fakeTicket, JSON.stringify({ sock: fakeSock, ticket: "x" }));
    const down = await settle(relay.call(fakeTicket, "web_search", {}));
    ok(down.e && down.e.connect === true && /连不上/.test(down.err), "凭据在、那头没人听：连不上（connect）", down.err);
    let reply = null;
    const srv = net.createServer((c) => { c.once("data", () => { if (reply === null) c.destroy(); else c.end(reply); }); });
    await new Promise((res) => srv.listen(fakeSock, res));
    const hang = await settle(relay.call(fakeTicket, "web_search", {}));
    ok(/没回话就断开了/.test(hang.err || "") && !(hang.e && hang.e.connect), "连上了、没回话就断：照实说，不算连不上（可能已经执行了）", hang.err);
    reply = "不是 JSON\n";
    const garbage = await settle(relay.call(fakeTicket, "web_search", {}));
    ok(/回的不是 JSON/.test(garbage.err || "") && !(garbage.e && garbage.e.connect), "回的不是 JSON：照实说", garbage.err);
    await new Promise((res) => srv.close(res));
  }

  section("② 叫停 / 超时 / 断开：手上的停、新来的拒");
  {
    let aborted = 0;
    const hangExec = async (name, args, { signal }) => {
      await new Promise((res) => { if (signal.aborted) return res(undefined); signal.addEventListener("abort", () => res(undefined), { once: true }); });
      aborted++;
      return { content: "停了", isError: true };
    };
    const stop = new AbortController();
    const r = await relay.open({ exec: hangExec, stopSignal: stop.signal });
    r.allow(["web_search"]);
    const p = settle(relay.call(r.ticketFile, "web_search", {}));
    ok(await until(() => r.inflight() === 1), "前提：那一单在跑");
    stop.abort();
    const got = await within(p);
    ok(aborted === 1 && got.v && got.v.text === "停了" && got.v.isError === true, "★这一趟叫停：手上那一单的执行收到停止信号，回话照样带回去★", got);
    const after = await within(settle(relay.call(r.ticketFile, "web_search", {})));
    ok(/已经叫停/.test(after.err || "") && aborted === 1, "叫停之后新来的拒", after.err);
    await r.close();

    const r2 = await relay.open({ exec: hangExec });
    r2.allow(["web_search"]);
    const ac = new AbortController();
    const p2 = settle(relay.call(r2.ticketFile, "web_search", {}, { signal: ac.signal }));
    ok(await until(() => r2.inflight() === 1), "前提：那一单在跑");
    ac.abort();
    const g2 = await within(p2);
    ok(/已叫停/.test(g2.err || ""), "桥那头叫停：call 当场回「已叫停」", g2.err);
    ok(await until(() => aborted === 2 && r2.inflight() === 0), "★桥那头断开：主进程这一单跟着停（不在后台接着跑完却没人收）★", { aborted, inflight: r2.inflight() });
    const pre = new AbortController();
    pre.abort();
    const g3 = await within(settle(relay.call(r2.ticketFile, "web_search", {}, { signal: pre.signal })), 3000);
    ok(/没有发出去/.test(g3.err || "") && r2.inflight() === 0, "已经叫停的不发出去", g3.err);
    const sock2 = r2.sock, t2 = ticketOf(r2);
    const rawHang = new Promise((resolve) => {
      const c = net.createConnection(sock2);
      c.on("connect", () => { c.write(line(t2, "web_search")); });
      c.on("error", () => {});
      resolve(c);
    });
    const conn = await rawHang;
    ok(await until(() => r2.inflight() === 1), "前提：直接连上去发了一单，在跑");
    conn.destroy();
    ok(await until(() => aborted === 3 && r2.inflight() === 0), "连接一断就停（不经 call() 也一样）", aborted);
    await r2.close();

    // 收工时手上还有一单：先叫停、等它回完（结果照样带回去）；这段时间里新来的拒
    const slowStop = async (name, args, { signal }) => {
      await new Promise((res) => { if (signal.aborted) return res(undefined); signal.addEventListener("abort", () => res(undefined), { once: true }); });
      await sleep(300);
      return { content: "收好尾了", isError: false };
    };
    const r3 = await relay.open({ exec: slowStop });
    r3.allow(["web_search"]);
    const t3 = ticketOf(r3);
    const p3 = settle(relay.call(r3.ticketFile, "web_search", {}));
    ok(await until(() => r3.inflight() === 1), "前提：那一单在跑");
    const closing = r3.close();
    const mid = await raw(r3.sock, line(t3, "web_search"));
    ok(/已经收工/.test(mid.error || ""), "★收工中（手上那单还在收尾）新来的拒★", mid);
    await within(closing, 8000);
    const g4 = await within(p3);
    ok(g4.v && g4.v.text === "收好尾了", "收工时手上那一单叫停后等它回完，结果照样带回去", g4);
    ok(!fs.existsSync(r3.dir), "然后才删目录");

    let dl = Date.now() - 1;
    const r4 = await relay.open({ exec, deadline: () => dl });
    r4.allow(["web_search"]);
    const n0 = calls.length;
    const over = await settle(relay.call(r4.ticketFile, "web_search", {}));
    ok(/已经超时/.test(over.err || "") && calls.length === n0, "过了时限的拒", over.err);
    dl = Date.now() + 60000;
    const ext = await settle(relay.call(r4.ticketFile, "web_search", {}));
    ok(ext.v && ext.v.text === "跑了 web_search", "★时限按函数现取：睡醒顺延之后照跑（不是开口子那一刻的死数）★", ext);
    await r4.close();
    const r5 = await relay.open({ exec, deadline: Date.now() - 1 });
    r5.allow(["web_search"]);
    const fixed = await settle(relay.call(r5.ticketFile, "web_search", {}));
    ok(/已经超时/.test(fixed.err || ""), "直接给数也认", fixed.err);
    await r5.close();
  }

  section("③ 上下文：在开跑时的那份里执行，调用从哪儿进来都一样");
  {
    const seen = [];
    const ctxExec = async () => { seen.push({ actor: quota.currentActor(), root: tools.getWorkspaceDir() }); return "好"; };
    const rootA = path.join(HOME, "租户A");
    const rootB = path.join(HOME, "租户B");
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    let r = null;
    await quota.withActor({ id: "u-relay", name: "小林" }, () => tools.withWorkspace(rootA, async () => { r = await relay.open({ exec: ctxExec }); }));
    r.allow(["web_search"]);
    ok(quota.currentActor() === null && tools.getWorkspaceDir() !== rootA, "前提：外面这层没有当前用户、根也不是租户 A 的");
    const out = await relay.call(r.ticketFile, "web_search", {});
    ok(out.text === "好" && seen[0] && seen[0].actor && seen[0].actor.id === "u-relay" && seen[0].root === rootA,
      "★调用从外面进来，执行仍在开口子时那份上下文里：谁在跑、工作区根都对★", seen[0]);
    await quota.withActor({ id: "别人" }, () => tools.withWorkspace(rootB, () => relay.call(r.ticketFile, "web_search", {})));
    ok(seen[1] && seen[1].actor && seen[1].actor.id === "u-relay" && seen[1].root === rootA, "从别人的上下文里打进来也一样（认口子，不认来路）", seen[1]);
    await r.close();
  }

  section("④ 权限与边界");
  {
    const r = await relay.open({ exec });
    if (SH) {
      ok(mode(r.dir) === 0o700 && mode(r.ticketFile) === 0o600 && mode(r.sock) === 0o600 && fs.statSync(r.sock).isSocket(),
        "★目录 0700、凭据 0600、套接字 0600：只有本人读得到、连得上★", { dir: mode(r.dir).toString(8), ticket: mode(r.ticketFile).toString(8), sock: mode(r.sock).toString(8) });
      ok(path.dirname(r.sock) === r.dir && path.dirname(r.ticketFile) === r.dir, "套接字和凭据放在同一个私有目录里");
    } else ok(r.sock.startsWith("\\\\.\\pipe\\owb-r-"), "Windows 走命名管道", r.sock);
    const big = await raw(r.sock, "x".repeat(relay._internals.MAX_REQ + 16), { ms: 15000 });
    ok(/请求太大/.test(big.error || ""), "★一行超过上限的不收（不在内存里一直攒）★", big.error || big);
    await r.close();
    if (SH) {
      const long = path.join(HOME, "t".repeat(120));
      fs.mkdirSync(long, { recursive: true });
      const old = process.env.TMPDIR;
      process.env.TMPDIR = long;
      try {
        ok(os.tmpdir() === long, "前提：临时目录换成了超长的那个");
        const o2 = await settle(relay.open({ exec }));
        const r2 = o2.v;
        ok(!!r2 && r2.dir.startsWith("/tmp/owb-r-") && Buffer.byteLength(r2.sock) <= relay._internals.sunMax() && mode(r2.dir) === 0o700,
          "★临时目录太长（套接字地址会超 sun_path）：退回 /tmp，照样 0700★", o2.err || (r2 && r2.dir));
        if (r2) {
          r2.allow(["web_search"]);
          const g = await settle(relay.call(r2.ticketFile, "web_search", {}));
          ok(g.v && g.v.text === "跑了 web_search", "退回之后照样连得上", g.err);
          await r2.close();
          ok(!fs.existsSync(r2.dir) && fs.readdirSync(long).length === 0, "收工照样删掉，长目录里也没留下半截", fs.readdirSync(long));
        }
      } finally {
        if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old;
      }
    }
  }

  section("⑤ 工具卡对号：按名字排队，结果先到的划掉");
  {
    const c = relay.cards();
    c.open("web_search", "a"); c.open("web_search", "b"); c.open("generate_image", "g");
    ok(c.take("web_search") === "a" && c.take("web_search") === "b" && c.take("web_search") === undefined, "同名按先来后到，取完就没有");
    c.open("web_search", "c"); c.open("web_search", "d"); c.close("web_search", "c");
    ok(c.take("web_search") === "d", "结果先到的那张划掉，交回来的对上下一张");
    ok(c.take("look_at_image") === undefined && c.take("generate_image") === "g", "没开过卡的名字给 undefined（不报进度）；不同名字不串");
    c.open("web_search", "");
    c.close("web_search", "没记过");
    ok(c.take("web_search") === undefined, "没有 id 的不记；划掉没记过的不出错");
  }

  section("⑥ 桥那头：有凭据文件就只管收发，交不回去明说没做成，不退回自己跑");
  {
    const H2 = path.join(HOME, "坏设置");
    const H3 = path.join(HOME, "好设置");
    fs.mkdirSync(H2, { recursive: true });
    fs.mkdirSync(H3, { recursive: true });
    fs.writeFileSync(path.join(H2, "config.json"), "{坏了");
    fs.writeFileSync(path.join(H3, "config.json"), "{}");
    const srvOf = (home) => bridge.buildServers({ home, root: path.join(HOME, "ws6"), baseDir: "任务_六", user: "", tools: ["web_search", "library_list"] })[bridge.SERVER_NAME];
    let aborted = 0;
    const r = await relay.open({
      exec: async (name, args, o) => {
        if (args && args.hang) {
          await new Promise((res) => { if (o.signal.aborted) return res(undefined); o.signal.addEventListener("abort", () => res(undefined), { once: true }); });
          aborted++;
          return { content: "停了", isError: true };
        }
        return exec(name, args);
      },
    });
    r.allow(["web_search", "library_list"]);
    try {
      const direct = mcpLive(srvOf(H2));
      const d = await direct.send(callMsg("library_list"));
      await direct.close();
      ok(d && d.result && d.result.isError === true && /设置文件/.test(textOf(d)), "前提（对照）：没开时设置文件坏了，桥一律不执行", textOf(d).slice(0, 120));
      const live = mcpLive(srvOf(H2), { [relay.ENV]: r.ticketFile });
      const n0 = calls.length;
      const v = await live.send(callMsg("library_list"));
      ok(v && v.result && v.result.isError === false && textOf(v) === "跑了 library_list" && calls.length === n0 + 1,
        "★开了：桥不读设置，交回主进程跑，结果原样带回★", { text: textOf(v), err: live.stderr().slice(-300) });
      const f = await live.send(callMsg("web_search", { fail: 1 }));
      ok(f && f.result && f.result.isError === true && textOf(f) === "web_search 跑挂了", "主进程那边报错：照样标成出错带回", textOf(f));
      const nl = await live.send(callMsg("run_shell", { command: "ls" }));
      ok(nl && nl.result && nl.result.isError === true && /没有借给本机引擎/.test(textOf(nl)) && calls.length === n0 + 2, "名单外的桥这头先拒（不往主进程送）", textOf(nl));
      // CLI 叫停
      const job = live.start(callMsg("web_search", { hang: 1 }));
      ok(await until(() => r.inflight() === 1), "前提：那一单在主进程里跑着");
      live.notify({ method: "notifications/cancelled", params: { requestId: job.id } });
      ok(await until(() => aborted === 1 && r.inflight() === 0), "★CLI 发 notifications/cancelled：主进程那一单跟着停★", aborted);
      await job.done;
      live.start(callMsg("web_search", { hang: 1 }), 5000);
      ok(await until(() => r.inflight() === 1), "前提：又一单在跑");
      live.kill("SIGTERM");
      ok(await until(() => aborted === 2 && r.inflight() === 0), "★桥挨 SIGTERM（CLI 收工、Bash 超时）：主进程那一单跟着停★", aborted);
      const ex = await Promise.race([live.exited, sleep(5000).then(() => null)]);
      ok(ex !== null, "桥随后自己退出", ex);

      const missing = path.join(HOME, "没有这个凭据");
      const m = mcpLive(srvOf(H3), { [relay.ENV]: missing });
      const n1 = calls.length;
      const mr = await m.send(callMsg("library_list"));
      await m.close();
      ok(mr && mr.result && mr.result.isError === true && /library_list 这次没有执行：交不回 OpenWorkBuddy 主进程/.test(textOf(mr)) && /如实告诉用户/.test(textOf(mr)),
        "★交不回去：MCP 回 isError，明说这一步没做成★", textOf(mr));
      ok(!/资料库|\.md|目录是空的/.test(textOf(mr)) && calls.length === n1, "不退回桥自己跑（设置是好的也不跑：绕开审批和记账）", textOf(mr));
      if (SH) {
        const s = srvOf(H3);
        const cli = await runCmd(s.command, [...s.args, "call", "library_list", "{}"], { ...s.env, [relay.ENV]: missing });
        ok(cli.code === 2 && /library_list 没有执行：交不回 OpenWorkBuddy 主进程/.test(cli.out) && /mcp__openworkbuddy__library_list/.test(cli.out),
          "★命令行那条路交不回去：退出码 2，话写在 stdout（模型看得见），指一条还走得通的路★", cli);
        const okCli = await runCmd(s.command, [...s.args, "library_list", "{}"], { ...s.env, [relay.ENV]: r.ticketFile });
        ok(okCli.code === 0 && okCli.out.trim() === "跑了 library_list", "命令行那条路交回去：结果照样打出来、退出码 0", okCli);
        const failCli = await runCmd(s.command, [...s.args, "library_list", "{\"fail\":1}"], { ...s.env, [relay.ENV]: r.ticketFile });
        ok(failCli.code === 1 && failCli.out.trim() === "library_list 跑挂了", "主进程那边报错：退出码 1", failCli);
        // 数据目录写不进去（命令沙箱里常见）：自己跑的、要记账存东西的那几样当场拦；交回主进程跑的不拦，写账本的是主进程
        const H4 = path.join(HOME, "只读数据");
        fs.mkdirSync(path.join(H4, "data"), { recursive: true });
        fs.writeFileSync(path.join(H4, "config.json"), "{}");
        fs.chmodSync(path.join(H4, "data"), 0o500);
        try {
          const s4 = srvOf(H4);
          const blocked = await runCmd(s4.command, [...s4.args, "web_search", "{}"], s4.env);
          const relayed = await runCmd(s4.command, [...s4.args, "web_search", "{}"], { ...s4.env, [relay.ENV]: r.ticketFile });
          ok(blocked.code === 2 && /没花钱/.test(blocked.out) && relayed.code === 0 && relayed.out.trim() === "跑了 web_search",
            "★数据目录写不进去：自己跑的当场拦，交回主进程跑的照跑（账记在主进程）★", { blocked, relayed });
        } finally { fs.chmodSync(path.join(H4, "data"), 0o700); }
      }
    } finally { await r.close(); }
  }

  section("⑦ attach：claude 的 MCP 和 owb 都交回去，codex 只有 MCP 交回去，没开就都不带");
  {
    const TF = path.join(HOME, "假凭据", "ticket");
    const base = { home: HOME, root: path.join(HOME, "ws7"), baseDir: "任务_七", user: "" };
    const envOf = (a) => JSON.parse(fs.readFileSync(a.runOpts.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME].env;
    const cl = bridge.attach("claude-code", { ...base, relayFile: TF });
    try {
      ok(envOf(cl)[relay.ENV] === TF && cl.relay === true, "claude：MCP 那台带上凭据文件的路径", envOf(cl));
      ok(fs.readFileSync(cl.shim, "utf8").includes(`${relay.ENV}='${TF}'`), "★claude：owb 脚本也烘进去（命令行那条路同样交回去）★");
    } finally { cl.cleanup(); }
    const ap = bridge.attach("claude-code", { ...base, relayFile: TF, approve: true });
    try {
      ok(envOf(ap)[relay.ENV] === TF && envOf(ap).OPENWORKBUDDY_BRIDGE_APPROVE === "1" && !fs.readFileSync(ap.shim, "utf8").includes("OPENWORKBUDDY_BRIDGE_APPROVE"),
        "跟审批一起开：两样都在 MCP 那台，审批开关照旧不进 owb 脚本");
    } finally { ap.cleanup(); }
    const cx = bridge.attach("codex", { ...base, relayFile: TF });
    try {
      const a = cx.runOpts.mcpArgs.join("\n");
      ok(a.includes(`${relay.ENV} = ${JSON.stringify(TF)}`) && cx.relay === true, "codex：MCP 那台带上（-c 内联表里）", a.split("\n").filter((x) => x.includes(".env=")));
      ok(!fs.readFileSync(cx.shim, "utf8").includes(relay.ENV), "★codex：owb 脚本不带（它的命令沙箱连不了本机套接字，照老样子自己跑）★");
    } finally { cx.cleanup(); }
    const ro = bridge.attach("claude-code", { ...base, relayFile: TF, readOnly: true });
    try {
      ok(envOf(ro)[relay.ENV] === TF && !ro.shim, "只读那一趟：MCP 照样交回去，命令行入口本来就不给");
    } finally { ro.cleanup(); }
    const off = bridge.attach("claude-code", base);
    const offCx = bridge.attach("codex", base);
    try {
      ok(!(relay.ENV in envOf(off)) && !fs.readFileSync(off.shim, "utf8").includes(relay.ENV) && off.relay === false
        && !offCx.runOpts.mcpArgs.join("\n").includes(relay.ENV) && offCx.relay === false, "没开：两个引擎、两条路都不带");
    } finally { off.cleanup(); offCx.cleanup(); }
  }

  section("⑧ 主进程真跑一趟（桩引擎）：工具在这一趟的上下文里跑，进度挂上 CLI 的工具卡，跑完吊销");
  {
    const engines = require(mod("engines"));
    const { createAgentRuntime } = require(mod("agent"));
    const { McpManager } = require(mod("mcp"));
    const id = "claude-code";
    let seen = null;
    const run = async (o) => {
      const srv = JSON.parse(fs.readFileSync(o.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME];
      // owb 脚本所在的那一格（搭桥时挂进 PATH 的 owb-shim-XXXX）
      const dir = String((o.env && o.env.PATH) || "").split(path.delimiter)
        .find((d) => path.basename(d).startsWith("owb-shim-") && fs.existsSync(path.join(d, "owb"))) || "";
      seen = { cwd: o.cwd, env: srv.env, shim: dir ? fs.readFileSync(path.join(dir, "owb"), "utf8") : "", tf: srv.env[relay.ENV] || "" };
      // 没开的那一趟不碰工具：探针只在主进程里，桥自己跑就是真工具
      if (!seen.tf) return { finalText: "好", usage: {}, stopped: null, sessionId: null };
      try { seen.info = JSON.parse(fs.readFileSync(seen.tf, "utf8")); } catch (e) { seen.info = { err: e.message }; }
      seen.dirMode = SH ? mode(path.dirname(seen.tf)) : 0o700;
      // 探的是 library_list：万一没交回来、桥自己跑了，也只是念一遍本地资料库，不出网
      const T = `mcp__${bridge.SERVER_NAME}__library_list`;
      // 先来一张结果先到的卡（CLI 那头当场就回了的那种）：交回来的那一单不该对上它
      o.emit({ type: "tool_use", id: "tu-0", name: T, purpose: "", depth: 0 });
      o.emit({ type: "tool_result", id: "tu-0", name: T, isError: true, preview: "当场回了", depth: 0 });
      o.emit({ type: "tool_use", id: "tu-1", name: T, purpose: "", depth: 0 });
      const live = mcpLive(srv);
      try { seen.mcp = await live.send(callMsg("library_list", { probe: "mcp" })); } finally { await live.close(); }
      o.emit({ type: "tool_result", id: "tu-1", name: T, isError: false, preview: textOf(seen.mcp), depth: 0 });
      if (SH && dir) {
        const cmd = `owb library_list '{"probe":"sh"}'`;
        o.emit({ type: "tool_use", id: "tu-2", name: "Bash", purpose: cmd, depth: 0 });
        seen.sh = await runCmd("/bin/sh", [path.join(dir, "owb"), "library_list", JSON.stringify({ probe: "sh" })]);
        o.emit({ type: "tool_result", id: "tu-2", name: "Bash", isError: false, preview: seen.sh.out, depth: 0 });
      }
      return { finalText: "好", usage: {}, stopped: null, sessionId: null };
    };
    const i = engines.BACKENDS.findIndex((b) => b.id === id);
    const real = i >= 0 ? engines.BACKENDS.splice(i, 1)[0] : null;
    const stub = { id, label: "桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: false, models: [],
      async detect() { return { id, installed: true, path: "", version: "0" }; }, run };
    engines.BACKENDS.push(stub);
    const rootT = path.join(HOME, "租户T");
    const libT = path.join(HOME, "资料库T");
    fs.mkdirSync(rootT, { recursive: true });
    fs.mkdirSync(path.join(libT, "客户C"), { recursive: true });
    // 定时 / IM 那种带着自己权限档位来的：交回来的那一单得用这一份，不是全局设置里那份（这里全局没写 security）
    const SEC = security.getSecurity({ security: {} });
    const ACTOR = { id: "u-T", name: "小周" };
    const go = async (eng, { relayOpen } = {}) => {
      const fakeLLM = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
      const config = { agent: { engine: id, max_steps: 3, engine_options: { [id]: { model: "m1", ...eng } } } };
      const rt = createAgentRuntime({ config, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
      const events = [];
      seen = null;
      probes.length = 0;
      const realOpen = relay.open;
      if (relayOpen) relay.open = relayOpen;
      let err = null;
      try {
        await quota.withActor(ACTOR, () => tools.withWorkspace(rootT, () => tools.withLibraryBase(libT, () => tools.withLibraryDir("客户C", () =>
          rt.runTask({ history: [{ role: "user", content: "干活" }], emit: (ev) => events.push(ev), baseDir: "任务_交回", user: "xiaozhou", sec: SEC, taskLabel: "定时：周报" })))));
      } catch (e) { err = String((e && e.message) || e); } finally { relay.open = realOpen; }
      return { seen: seen || {}, events, probes: probes.slice(), err };
    };
    try {
      const on = await go({ relay: true });
      const s = on.seen;
      ok(s.tf && path.isAbsolute(s.tf) && s.info && /^[0-9a-f]{64}$/.test(s.info.ticket || ""), "★开了：MCP 那台拿到凭据文件的路径，文件里有这一趟的凭据★", { tf: s.tf, info: s.info && Object.keys(s.info) });
      ok(s.info && !JSON.stringify(s.env).includes(s.info.ticket) && !s.shim.includes(s.info.ticket) && s.shim.includes(s.tf),
        "环境变量和 owb 脚本里只有路径，凭据本身不在里面");
      ok(s.dirMode === 0o700, "凭据所在目录 0700", (s.dirMode || 0).toString(8));
      ok(!on.err && s.mcp && s.mcp.result && s.mcp.result.isError === false && textOf(s.mcp) === "探到了：library_list", "MCP 那条路交回主进程跑，结果原样带回", on.err || s.mcp);
      const pm = on.probes.find((x) => x.probe === "mcp");
      ok(pm && pm.actor && pm.actor.id === "u-T" && pm.root === rootT && pm.lib === libT && pm.mount === "客户C",
        "★在这一趟的上下文里跑：谁在跑（记账记在他名下）、租户根、资料库根和挂载目录都对★", pm && { actor: pm.actor, root: pm.root, lib: pm.lib, mount: pm.mount });
      ok(pm && pm.reply === path.resolve(s.cwd) && pm.baseDir === "任务_交回" && s.cwd === path.join(rootT, "任务_交回"),
        "回执路径照引擎的当前目录说（跟桥那边一样），产物落这一趟的成果目录", pm && { reply: pm.reply, cwd: s.cwd, baseDir: pm.baseDir });
      ok(pm && pm.taskLabel === "定时：周报" && pm.actorOpt === "xiaozhou" && pm.security === SEC,
        "★任务名（审批卡上认人）、审批归谁、这一趟的权限档位（定时 / IM 的覆盖）都带到★", pm && { taskLabel: pm.taskLabel, actor: pm.actorOpt, sameSec: pm.security === SEC });
      ok(pm && Array.isArray(pm.knownTools) && pm.knownTools.includes("library_list") && pm.knownTools.every((n) => LENDABLE.includes(n)) && pm.keep === true && pm.hasVision && pm.vision === undefined && pm.signal,
        "跟桥那边对齐：拼错名字按借出去的那份提示、叫停时上游已收的单不撤、看图不拿内置的对话模型兜底", pm && { known: (pm.knownTools || []).length, keep: pm.keep, vision: pm.vision });
      const prog = on.events.find((e) => e.type === "tool_progress" && e.id === "tu-1");
      ok(pm && pm.callId === "tu-1" && prog && prog.name === "library_list" && prog.stage === "探" && prog.label === "探针" && !on.events.some((e) => e.type === "tool_progress" && e.id === "tu-0"),
        "★进度挂上 CLI 那张工具卡（按名字对上 tool_use 的 id；结果先到的那张已经划掉，不挂错）★", { callId: pm && pm.callId, prog });
      if (SH) {
        const ps = on.probes.find((x) => x.probe === "sh");
        ok(s.sh && s.sh.code === 0 && s.sh.out.trim() === "探到了：library_list" && ps && ps.actor && ps.actor.id === "u-T" && ps.root === rootT,
          "★owb 命令行那条路也交回主进程，同一份上下文★", { sh: s.sh, ps: ps && { actor: ps.actor, root: ps.root } });
        const prog2 = on.events.find((e) => e.type === "tool_progress" && e.id === "tu-2");
        ok(ps && ps.callId === "tu-2" && prog2 && prog2.name === "library_list", "命令行那张卡（Bash 里敲的 owb）也对得上", { callId: ps && ps.callId, prog2 });
      }
      ok(!on.events.some((e) => e.type === "status" && /没能改由主进程跑|没能挂给引擎/.test(e.text || "")), "一路没有退回的提示");
      ok(s.tf && !fs.existsSync(s.tf) && !fs.existsSync(path.dirname(s.tf)), "★跑完吊销：凭据文件和目录都删了★", s.tf);
      const key = (pm && pm.held && pm.held[0]) || "";
      ok(pm && pm.held && pm.held.length === 1 && !!key && harvest._internals.held.size === 0 && !fs.existsSync(path.join(harvest.pendingDir(), key)),
        "★视频上游收了单：记台账、等片子时占住（后台那一路别抢），交到手了放开、台账删掉★", pm && { held: pm.held, now: [...harvest._internals.held] });
      if (s.info && s.info.sock) {
        const late = await raw(s.info.sock, line(s.info.ticket, "library_list", { probe: "late" }));
        ok(!!(late.down || late.closed) && !late.text && !probes.some((x) => x.probe === "late"), "跑完之后拿着旧凭据来：连不上，也没执行", late);
      }

      const failed = await go({ relay: true }, { relayOpen: async () => { throw new Error("开不了"); } });
      const note = failed.events.find((e) => e.type === "status" && /没能改由主进程跑/.test(e.text || ""));
      ok(!failed.err && note && /开不了/.test(note.text) && /照老样子由桥自己跑/.test(note.text) && failed.seen.env && !(relay.ENV in failed.seen.env),
        "口子开不了：说一句、照老样子由桥自己跑（不把整个任务毙掉）", failed.err || note);

      const off = await go({});
      ok(off.seen.env && !(relay.ENV in off.seen.env) && !off.seen.shim.includes(relay.ENV) && !off.events.some((e) => e.type === "status" && /主进程跑/.test(e.text || "")),
        "★没开（默认）：两条路都不带，照老样子★", off.seen.env);
      const str = await go({ relay: "true" });
      ok(str.seen.env && !(relay.ENV in str.seen.env), "开关只认布尔 true（手写成字符串的不算）");
    } finally {
      engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
      if (real) engines.BACKENDS.splice(i, 0, real);
    }
  }

  section("⑨ 视频台账：交回主进程跑的那一单占着时，后台收单那一路先等");
  {
    const H = harvest._internals;
    H.cancelSweep();
    H.setPollMs(40);
    const dir = path.join(HOME, "pending");
    const saveDir = path.join(HOME, "out");
    fs.mkdirSync(saveDir, { recursive: true });
    const entry = { proto: "relaytest", taskId: "t-hold-1", fname: "a.mp4", saveDir, model: "m", chan: "x", tool: "generate_video", run: "r1", user: "", pid: process.pid, at: Date.now() };
    const file = harvest.writeEntry(dir, entry);
    const release = harvest.hold(file);
    let done = null;
    const job = H.take({ file, entry }, { media: {}, onDone: (x) => { done = x; } });
    await sleep(400);
    ok(done === null && fs.existsSync(file) && H.held.has(path.basename(file)), "★占着的时候后台那一路干等，不去抢（台账原样在）★", done);
    release();
    await job;
    ok(done && done.gaveUp === true && H.held.size === 0, "放开之后照常接着收（这里渠道认不回来，按「先放下」收场）", done);
    ok(fs.existsSync(file), "放下的台账改回原名，下次再收");
    let done2 = null;
    const t0 = Date.now();
    await H.take({ file, entry }, { media: {}, onDone: (x) => { done2 = x; } });
    ok(done2 && Date.now() - t0 < 1000, "反向对照：不占着时，台账写的是本进程 pid 的那一单当场就被收（hold 拦的就是这个）", Date.now() - t0);
    harvest.dropEntry(file);
  }

  section("⑩ 开关：属主在引擎卡上勾，成员改不了；服务端真存（引擎设置那段是一个键一个键收的，漏一个就存不进去）");
  {
    const engines = require(mod("engines"));
    const prefs = require(mod("prefs"));
    for (const id of ["claude-code", "codex"]) {
      const v = (o) => engines.gateView(id, { agent: { engine_options: { [id]: o } } });
      ok(v({ relay: true }).relay === true && v({}).relay === false && v({ relay: "true" }).relay === false, `${id}：设置页读得到这个开关（只认 true）`, [v({ relay: true }), v({})]);
      ok(!prefs.isPersonalPatch({ agent: { engine_options: { [id]: { relay: true } } } }), `${id}：成员改不了这个开关（不算个人设置）`);
    }
    const http = require("http");
    const H = path.join(HOME, "srv");
    fs.mkdirSync(H, { recursive: true });
    const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
      env: { ...process.env, OPENWORKBUDDY_HOME: H, OPENWORKBUDDY_DATA_DIR: path.join(H, "data"), HOST: "127.0.0.1", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let log = "";
    child.stdout.on("data", (c) => (log += c));
    child.stderr.on("data", (c) => (log += c));
    try {
      const port = await new Promise((resolve) => {
        const t0 = Date.now();
        const tick = setInterval(() => {
          const m = /已启动: http:\/\/localhost:(\d+)/.exec(log);
          if (m || child.exitCode !== null || Date.now() - t0 > 60000) { clearInterval(tick); resolve(m ? Number(m[1]) : 0); }
        }, 200);
      });
      ok(port > 0, "server.js 起来了", { exit: child.exitCode, log: log.slice(-400) });
      if (port) {
        // 不留长连接：跑完还挂着套接字，收尾那道「东西没收干净」会把它算红
        const agent = new http.Agent({ keepAlive: false });
        const req = (method, p, body, cookie) => new Promise((resolve) => {
          const data = body ? JSON.stringify(body) : null;
          const r = http.request({ host: "127.0.0.1", port, path: p, method, agent, headers: {
            ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
            ...(cookie ? { cookie } : {}),
          } }, (res) => {
            let b = ""; res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ status: res.statusCode, body: b, setCookie: res.headers["set-cookie"] }));
          });
          r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
          if (data) r.write(data);
          r.end();
        });
        const reg = await req("POST", "/api/auth/register", { username: "admin", password: "Str0ngPass!2345" });
        const cookie = (reg.setCookie || []).map((c) => c.split(";")[0]).join("; ");
        const save = (id, o) => req("POST", "/api/settings", { agent: { engine_options: { [id]: o } } }, cookie);
        const opt = (id) => {
          try { return ((JSON.parse(fs.readFileSync(path.join(H, "config.json"), "utf8")).agent || {}).engine_options || {})[id] || {}; }
          catch { return {}; }
        };
        const s1 = await save("codex", { relay: true, model: "gpt-5.4" });
        ok(s1.status === 200 && opt("codex").relay === true, "★属主勾上：config.json 里存成 true★", { status: s1.status, body: s1.body.slice(0, 200), saved: opt("codex") });
        const s2 = await save("codex", { relay: false });
        ok(s2.status === 200 && opt("codex").relay === false && opt("codex").model === "gpt-5.4", "去掉勾：存成 false，别的不动", opt("codex"));
        const s3 = await save("claude-code", { relay: true });
        ok(s3.status === 200 && opt("claude-code").relay === true && opt("codex").relay === false, "两张卡各存各的", [opt("claude-code"), opt("codex")]);
      }
    } finally { child.kill("SIGKILL"); }
  }
})().catch((e) => { fail++; console.log("  ❌ 套件自己崩了：" + ((e && e.stack) || e)); }).then(() => {
  finished = true;
  // 收工之后还有口子、子进程、套接字挂着，进程就退不了：过一会儿还没退，算红并点出来。
  // 崩了也走这一步——崩在半路的那一段多半留着没关的口子，不兜住就一直挂到外面的超时
  setTimeout(() => {
    fail++;
    console.log("  ❌ 跑完了还有东西挂着，进程退不了：" + JSON.stringify(process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : []));
    process.exit(1);
  }, 8000).unref();
});
