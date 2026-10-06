// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 真浏览器那条线 —— cdp.js
 *
 * 当时同时踩了四个坑，每个单看都不致命，凑一块就是「怎么都连不上，还查不出为什么」：
 *   ① 9222 上确实有人 listen（Chrome 主进程自己占的），但 /json/version 是空的。
 *      只判断端口通不通，就会得出「调试口开着」这种正好相反的结论。
 *   ② 握手固定带 Origin。Chrome 111 起这会被 403，list_tabs 能用、其它全废。
 *   ③ 只认「101 Switching Protocols」这句原因短语。新版 Chrome 回的是
 *      「101 WebSocket Protocol Handshake」，一次成功的握手被判成失败。
 *   ④ evaluate 多剥了一层 .result，页面脚本跑了，拿回来永远是 undefined。
 *
 * 这套测试用一个假 DevTools 端点把四条全钉住，不需要机器上真有 Chrome。
 */
const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const { mod } = require("./lib/mod");
const cdp = require(mod("cdp"));

let pass = 0, fail = 0;
const ok = (v, m, extra) => { if (v) pass++; else { fail++; console.error("  ❌", m, extra === undefined ? "" : "\n     " + extra); } };
const eq = (a, b, m) => { try { assert.deepStrictEqual(a, b, m); pass++; } catch { fail++; console.error("  ❌", m, "\n     实际:", JSON.stringify(a), "期望:", JSON.stringify(b)); } };

const listen = (srv) => new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
const wsFrame = (s) => { const b = Buffer.from(s), h = [0x81];
  if (b.length < 126) h.push(b.length); else if (b.length < 65536) h.push(126, b.length >> 8, b.length & 255);
  else h.push(127, 0, 0, 0, 0, (b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255);
  return Buffer.concat([Buffer.from(h), b]); };

/**
 * 一个假 DevTools：行为对齐新版 Chrome——带 Origin 就 403，101 那行写「WebSocket Protocol Handshake」。
 * /json/new 默认只收 PUT（Chrome 111 起的规矩），opts.getOnly 模拟只认 GET 的老版本，opts.noNew 模拟开不出新页；
 * /json/close 回纯文本（真 Chrome 就是这样，不是 JSON）。
 * 另有几个 Test.* 方法专给 connect() 用：回显解出来的帧长、推事件、回大包、不回、挂断。
 */
function fakeChrome(opts = {}) {
  const tabs = [{ id: "TAB1", type: "page", title: "假页面", url: "http://example.test/" }];
  let nextTab = 1;
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    const withWs = (t) => ({ ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}` });
    if (req.url.startsWith("/json/version")) {
      if (opts.emptyBody) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(""); }
      return res.end(JSON.stringify({ Browser: opts.headless ? "HeadlessChrome/153.0.0.0" : "Chrome/153.0.0.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
    }
    if (req.url.startsWith("/json/list")) return res.end(JSON.stringify(tabs.map(withWs)));
    if (req.url.startsWith("/json/new")) {
      (srv.newCalls = srv.newCalls || []).push(req.method);
      const wantPut = !opts.getOnly;
      if (opts.noNew || (wantPut ? req.method !== "PUT" : req.method !== "GET")) {
        res.writeHead(405); return res.end(`Using unsafe HTTP verb ${req.method} to invoke /json/new.`);
      }
      const q = req.url.indexOf("?");
      const t = { id: "NEW" + nextTab++, type: "page", title: "", url: q < 0 ? "about:blank" : decodeURIComponent(req.url.slice(q + 1)) };
      tabs.push(t);
      return res.end(JSON.stringify(withWs(t)));
    }
    if (req.url.startsWith("/json/close/")) {
      const id = decodeURIComponent(req.url.slice("/json/close/".length));
      if (id === "BOOM" || srv.closeFails) { res.writeHead(500); return res.end("internal"); }
      const i = tabs.findIndex((t) => t.id === id);
      if (i < 0) { res.writeHead(404); return res.end("No such target id: " + id); }
      tabs.splice(i, 1);
      return res.end("Target is closing");
    }
    res.writeHead(404); res.end("[]");
  });
  srv.tabs = tabs;
  srv.on("upgrade", (req, socket) => {
    if (req.headers.origin) { srv.sawOrigin = req.headers.origin; socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // 记下每条 CDP 调用落在哪个标签页上：停放那几条要看「冻 / 解冻 / 拉前台」和动作本身的先后
    const tabOfWs = decodeURIComponent(String(req.url || "").split("/").pop() || "");
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = !!(buf[1] & 128), key = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
        if (buf.length < off + len) return;
        const raw = buf.slice(off, off + len); buf = buf.slice(off + len);
        const body = Buffer.from(raw); if (key) for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
        let msg; try { msg = JSON.parse(body.toString()); } catch { continue; }
        const p = msg.params || {};
        (srv.calls = srv.calls || []).push({ tab: tabOfWs, method: msg.method, state: p.state || "" });
        // 回显：服务端按 RFC 6455 真解出来的载荷有多长。客户端长度字段写错，这里就对不上（或者干脆解不出 JSON）
        if (msg.method === "Test.echoLength") { socket.write(wsFrame(JSON.stringify({ id: msg.id, result: { len: body.length, exprLen: String(p.expr || "").length } }))); continue; }
        // 先推 n 个事件再回包：回包到的时候，事件必须已经分到 on() 上了
        if (msg.method === "Test.push") {
          for (let i = 0; i < (p.n || 0); i++) socket.write(wsFrame(JSON.stringify({ method: p.method, params: { i, sessionId: i + 1 } })));
          socket.write(wsFrame(JSON.stringify({ id: msg.id, result: { pushed: p.n || 0 } }))); continue;
        }
        if (msg.method === "Test.big") { socket.write(wsFrame(JSON.stringify({ id: msg.id, result: { value: "0123456789".repeat(Math.ceil(p.n / 10)).slice(0, p.n) } }))); continue; }
        // 回包整条载荷正好 p.total 字节：拿来卡 125 / 126 / 65535 / 65536 这几个长度写法的分界
        if (msg.method === "Test.exact") {
          const base = JSON.stringify({ id: msg.id, result: { t: p.total, v: "" } }).length;
          socket.write(wsFrame(JSON.stringify({ id: msg.id, result: { t: p.total, v: "x".repeat(Math.max(0, p.total - base)) } }))); continue;
        }
        if (msg.method === "Test.silent") continue;
        if (msg.method === "Test.hangup") { socket.destroy(); return; }
        const reply = msg.method === "Runtime.evaluate"
          ? { result: { result: { type: "string", value: "从页面里拿回来的值" } } }
          : msg.method === "Page.captureScreenshot" ? { result: { data: Buffer.from("PNG").toString("base64") } }
          : { result: {} };
        socket.write(wsFrame(JSON.stringify({ id: msg.id, ...reply })));
      }
    });
  });
  return srv;
}

(async () => {
  console.log("【1】只连本机");
  for (const bad of ["http://10.0.0.5:9222/json/list", "http://evil.example.com:9222/json/list", "https://1.2.3.4:9222/json/version"]) {
    let msg = ""; try { cdp.endpointHost(bad); } catch (e) { msg = e.message; }
    ok(/只允许连接本机地址/.test(msg), `外网地址必须当场拒绝：${bad}`, msg);
  }
  for (const good of ["http://127.0.0.1:9222/json/list", "http://localhost:9222/json/list", "http://[::1]:9222/json/list"]) {
    let threw = ""; try { cdp.endpointHost(good); } catch (e) { threw = e.message; }
    ok(!threw, `本机地址要放行：${good}`, threw);
  }
  ok(["run", "ensure", "probe", "findChrome", "launch"].every((k) => typeof cdp[k] === "function"), "run / ensure / probe / findChrome / launch 都得导出");

  console.log("【2】端口上有人 listen ≠ 调试口开着");
  {
    const srv = fakeChrome({ emptyBody: true });
    const port = await listen(srv);
    const v = await cdp.probe(port, 1500);
    eq(v, null, "返回空 body 的那种「假调试口」必须判为不可用（用户机器上 9222 就是这样）");
    let msg = "";
    try { await cdp.run({ action: "list_tabs", port, launch: false }); } catch (e) { msg = e.message; }
    ok(/没有 Chrome DevTools/.test(msg), "报错要直说这个端口上没有 DevTools", msg);
    ok(/有东西 listen 不代表它是调试口/.test(msg), "还要点破「端口通」这个假象，否则人会一直去查启动参数", msg);
    ok(/--remote-debugging-port/.test(msg), "顺手给出能直接抄的启动命令", msg);
    srv.close();
  }

  console.log("【3】接管一个活着的调试口：不新开浏览器");
  {
    const srv = fakeChrome();
    const port = await listen(srv);
    const r = await cdp.ensure({ port });
    eq(r, { port, launched: false }, "端口活着就直接用，绝不能再拉一个 Chrome 起来");
    const st = await cdp.run({ action: "status", port });
    ok(st.alive === true && st.port === port && st.tabs === 1, "status 要如实报出连上了谁、有几个标签页", JSON.stringify(st));
    const tabs = await cdp.run({ action: "list_tabs", port });
    eq(tabs.tabs.map((t) => t.id), ["TAB1"], "list_tabs 只列 page 类型的标签页");
    srv.close();
  }

  console.log("【4】status 只看不碰");
  {
    const st = await cdp.run({ action: "status", port: 1 });
    ok(st.alive === false && /会自己拉起/.test(st.hint || ""), "没连上时 status 不许顺手拉起浏览器，只给一句下一步", JSON.stringify(st));
  }

  console.log("【5】握手：不带 Origin，且只认状态码 101");
  {
    const srv = fakeChrome();
    const port = await listen(srv);
    const r = await cdp.run({ action: "evaluate", port, expression: "1+1" });
    ok(srv.sawOrigin === undefined, `握手里不许带 Origin（Chrome 111 起一律 403），实际带了：${srv.sawOrigin}`);
    eq(r.result, "从页面里拿回来的值", "新版 Chrome 回的是「101 WebSocket Protocol Handshake」，也必须认；evaluate 也不能多剥一层 .result");
    const shot = await cdp.run({ action: "screenshot", port });
    eq(Buffer.from(shot.data, "base64").toString(), "PNG", "screenshot 要把 base64 原样带出来给上层落盘");
    srv.close();
  }

  console.log("【6】找浏览器");
  {
    const old = process.env.OWB_CHROME_PATH;
    process.env.OWB_CHROME_PATH = "/绝对不存在/chrome";
    eq(cdp.findChrome(), "", "OWB_CHROME_PATH 指到不存在的文件时要返回空，而不是硬拿这个路径去 spawn");
    process.env.OWB_CHROME_PATH = process.execPath; // 随便找个真实存在的可执行文件
    eq(cdp.findChrome(), process.execPath, "设了 OWB_CHROME_PATH 就以它为准，不再去猜默认安装位置");
    if (old === undefined) delete process.env.OWB_CHROME_PATH; else process.env.OWB_CHROME_PATH = old;
  }

  console.log("【7】自己拉起来的浏览器，收得回来");
  if (process.platform === "win32") {
    console.log("    （Windows 上没有进程组这套杀法，跳过）");
  } else {
    const fs = require("fs"), os = require("os"), path = require("path");
    // 假 Chrome：写出 DevToolsActivePort、应答 /json/version，再多开一个子进程当「GPU / 渲染器」。
    // 真 Chrome 就是这个形状——上次漏收的正是这些子进程，主进程 0.1% CPU，子进程 160%。
    // 本文件里的假进程都最多活两分钟：被测代码没收干净时，测试自己也不能在机器上留一个不退的进程。
    const FAKE = `#!/usr/bin/env node
const http=require("http"),fs=require("fs"),path=require("path"),cp=require("child_process");
const ud=(process.argv.find(a=>a.startsWith("--user-data-dir="))||"").split("=").slice(1).join("=");
const kid=cp.spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),12e4)"],{stdio:"ignore"});
const srv=http.createServer((req,res)=>{const p=srv.address().port;
  if(req.url.startsWith("/json/version"))return res.end(JSON.stringify({Browser:"FakeChrome/1",webSocketDebuggerUrl:"ws://127.0.0.1:"+p+"/devtools/browser/x"}));
  res.end("[]");});
srv.listen(0,"127.0.0.1",()=>{fs.writeFileSync(path.join(ud,"kid.pid"),String(kid.pid));
  fs.writeFileSync(path.join(ud,"DevToolsActivePort"),srv.address().port+"\\n/devtools/browser/x\\n");});
setTimeout(()=>process.exit(0),12e4);
`;
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const made = [], pids = [];
    const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cdp-close-")); made.push(d);
      const bin = path.join(d, "fake-chrome"); fs.writeFileSync(bin, FAKE, { mode: 0o755 }); return { d, bin }; };
    const oldPath = process.env.OWB_CHROME_PATH, oldIdle = process.env.OWB_CDP_IDLE_MS;

    // ① 显式关：主进程和子进程一起没
    {
      const { d, bin } = mk();
      process.env.OWB_CHROME_PATH = bin; process.env.OWB_CDP_IDLE_MS = "0";
      const r = await cdp.launch({ user_data_dir: d });
      ok(r.launched === true && r.pid > 0, "拉起来之后要把 pid 交出来，不然根本没法收", JSON.stringify(r));
      const kid = Number(fs.readFileSync(path.join(d, "kid.pid"), "utf8"));
      pids.push(r.pid, kid);
      ok(alive(r.pid) && alive(kid), "刚起来的时候父子都活着");
      ok(cdp.run && (await cdp.run({ action: "close" })).closed === true, "close 这个 action 要真的关掉，并如实回报");
      await new Promise((res) => setTimeout(res, 2500));
      ok(!alive(r.pid), "主进程要没");
      ok(!alive(kid), "子进程也得跟着走——只杀主进程，就是这次 GPU 进程 160% CPU 挂十小时的那个样子");
      eq((await cdp.run({ action: "close" })).closed, false, "手里没有自己拉起来的浏览器时，close 不许去动别人的窗口（反向对照）");
    }

    // ② 忘了关也不会一直挂着：闲置到点自己收
    {
      const { d, bin } = mk();
      process.env.OWB_CHROME_PATH = bin; process.env.OWB_CDP_IDLE_MS = "600";
      const r = await cdp.launch({ user_data_dir: d });
      const kid = Number(fs.readFileSync(path.join(d, "kid.pid"), "utf8"));
      pids.push(r.pid, kid);
      await new Promise((res) => setTimeout(res, 3200));
      ok(!alive(r.pid) && !alive(kid), "闲置超过 OWB_CDP_IDLE_MS 之后要自己关掉，整棵树一起");
    }

    if (oldPath === undefined) delete process.env.OWB_CHROME_PATH; else process.env.OWB_CHROME_PATH = oldPath;
    if (oldIdle === undefined) delete process.env.OWB_CDP_IDLE_MS; else process.env.OWB_CDP_IDLE_MS = oldIdle;
    // 上面哪条断言挂了，被测进程也不许留下来（这几个 pid 都是本段刚拉起的）
    for (const pid of pids) if (pid > 1 && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }

  const sleep =(ms) => new Promise((res) => setTimeout(res, ms));
  /** 等一个 Promise，但最多等 ms：超时给 fallback。测的就是「会不会一直挂着」，测试自己不能跟着挂。 */
  const within = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)]);
  const errOf = async (p) => { try { await p; return ""; } catch (e) { return e.message || String(e); } };

  console.log("【8】connect：事件分给 on()，off 之后就不再收");
  {
    const srv = fakeChrome();
    const port = await listen(srv);
    const c = await cdp.connect(`ws://127.0.0.1:${port}/devtools/page/TAB1`);
    ok(c.send === c.call, "send 就是 call 的另一个名字（录屏、演示那几处按 send 写的）");
    /** @type {number[]} */
    const got = [], other = [];
    const fn = (p) => got.push(p.i);
    c.on("Page.screencastFrame", fn);
    c.on("Page.loadEventFired", (p) => other.push(p.i));
    const r = await c.call("Test.push", { n: 3, method: "Page.screencastFrame" });
    eq(r.pushed, 3, "推事件的那条调用本身要照常回包");
    eq(got, [0, 1, 2], "没有 id 的消息是事件，要按顺序交给挂在这个 method 上的回调");
    eq(other, [], "事件只发给同名的回调，别的 method 上挂的收不到（反向对照）");
    c.off("Page.screencastFrame", fn);
    await c.call("Test.push", { n: 2, method: "Page.screencastFrame" });
    eq(got, [0, 1, 2], "off 之后同一个回调不许再收到——录屏停了还在往文件里写帧就是这个样子");
    const late = [];
    const un = c.on("Page.screencastFrame", (p) => late.push(p.i));
    un();
    await c.call("Test.push", { n: 2, method: "Page.screencastFrame" });
    eq(late, [], "on() 返回的那个函数等价于 off");
    const good = [];
    c.on("X.evt", () => { throw new Error("回调自己炸了"); });
    c.on("X.evt", (p) => good.push(p.i));
    await c.call("Test.push", { n: 2, method: "X.evt" });
    eq(good, [0, 1], "一个回调抛异常，不能连累同一事件上的其它回调，也不能把连接弄断");
    eq((await c.call("Runtime.evaluate", {})).result.value, "从页面里拿回来的值", "回调炸过之后，普通调用照常能用");

    // 对面挂了：手里没未决调用、只在等事件的一方（录屏）要靠 "close" 这个伪事件知道别再等
    const closes = [];
    c.on("close", (p) => closes.push(p));
    const hang = await errOf(c.call("Test.hangup"));
    ok(/连接已关闭/.test(hang), "连接断了，正在等的调用要立刻被拒掉，不能一直挂着", hang);
    await sleep(50);
    eq(closes.length, 1, "断开时 close 伪事件恰好通知一次");
    const after = await errOf(within(c.call("Runtime.evaluate", {}), 1500, "一直没回"));
    ok(/连接已关闭/.test(after), "断开之后再发调用要当场拒绝，而不是写进一个死 socket 干等", after);
    srv.close();
  }

  console.log("【9】大帧：64 KiB 以上两个方向都不能错位");
  {
    const srv = fakeChrome();
    const port = await listen(srv);
    const c = await cdp.connect(`ws://127.0.0.1:${port}/devtools/page/TAB1`);
    // 125 / 126 / 65535 / 65536 附近是三种长度写法的分界；70000 是当初被读成 273 字节的那个大小
    for (const n of [100, 5000, 65400, 65536, 70000, 300000]) {
      const expr = "x".repeat(n);
      const sent = JSON.stringify({ id: 0, method: "Test.echoLength", params: { expr } }).length; // id 位数差一两个字节，下面按区间判
      const r = await within(c.call("Test.echoLength", { expr }, 4000), 5000, null).catch((e) => ({ err: e.message }));
      ok(r && r.exprLen === n && Math.abs(r.len - sent) < 8,
        `发出去 ${n} 字节的脚本，对面按 RFC 6455 解出来要一字不差（长度字段写错时对面读成别的长度，JSON 都解不出来）`, JSON.stringify(r));
    }
    // 上面那组加上 JSON 外壳后落不到分界上：另开一条连接，先量外壳多长，再把载荷凑成分界上的整数。
    // 编号 1~9 都是一位数，外壳长度不变
    {
      const e = await cdp.connect(`ws://127.0.0.1:${port}/devtools/page/TAB1`);
      const shell = (await e.call("Test.echoLength", { expr: "" }, 4000)).len;
      const EDGES = [125, 126, 127, 65535, 65536, 65537];
      const out = [];
      for (const n of EDGES) {
        const r = await within(e.call("Test.echoLength", { expr: "x".repeat(n - shell) }, 4000), 5000, null).catch((err) => ({ err: err.message }));
        out.push(r && r.len);
      }
      eq(out, EDGES, "★发出去的整条载荷正好落在分界上★ 125 走 7 位、126 / 65535 走 16 位、65536 起走 64 位，对面解出来一字不差");
      const back = [];
      for (const n of EDGES) {
        const r = await within(e.call("Test.exact", { total: n }, 4000), 5000, null).catch((err) => ({ err: err.message }));
        back.push(r && r.t === n && /^x+$/.test(r.v) ? n : JSON.stringify(r).slice(0, 80));
      }
      eq(back, EDGES, "★收进来的载荷正好落在分界上★ 三种长度写法都解得开");
      eq((await e.call("Runtime.evaluate", {})).result.value, "从页面里拿回来的值", "  └ 分界上那几条收完，下一条没被带歪");
      e.close();
    }
    const big = await c.call("Test.big", { n: 200000 }, 4000);
    ok(big.value && big.value.length === 200000 && big.value.endsWith("9"), "收进来的 200KB 回包要拼完整（分好几块到的也一样）", String(big.value && big.value.length));
    eq((await c.call("Runtime.evaluate", {})).result.value, "从页面里拿回来的值", "一大一小连着来，后面那条不能被前面的大帧带歪");
    c.close();
    srv.close();
  }

  console.log("【10】idleMs：0 = 安静多久都不断；给了正数就到点断");
  {
    const srv = fakeChrome();
    const port = await listen(srv);
    const ws = `ws://127.0.0.1:${port}/devtools/page/TAB1`;
    const short = await cdp.connect(ws, { idleMs: 300 });
    const closedShort = await within(new Promise((res) => short.on("close", () => res(true))), 2000, false);
    ok(closedShort === true, "idleMs 300：一个字节都没有的话 300ms 后要自己断开（对照组，证明下面那个没断不是因为测得太短）");
    const zero = await cdp.connect(ws, { idleMs: 0 });
    let zeroClosed = false;
    zero.on("close", () => { zeroClosed = true; });
    await sleep(900);
    ok(!zeroClosed, "idleMs 0：录一个静止页面时 Chrome 一帧都不推，连接不能因为安静被自己掐掉");
    eq((await within(zero.call("Runtime.evaluate", {}, 2000), 3000, { result: {} })).result.value, "从页面里拿回来的值", "安静了一阵之后照样能调用");
    const slow = await errOf(zero.call("Test.silent", {}, 250));
    ok(/没在 0\.3 秒内回 Test\.silent|没在 0\.2 秒内回 Test\.silent/.test(slow), "单条调用可以自己限时，超时的报错要点名是哪个方法", slow);
    eq((await zero.call("Runtime.evaluate", {}, 2000)).result.value, "从页面里拿回来的值", "一条超时不影响这条连接上的后续调用");
    zero.close();
    srv.close();
  }

  console.log("【11】newPage / closePage");
  {
    const srv = fakeChrome();
    const port = await listen(srv);
    const t = await cdp.newPage(port, "http://example.test/a?b=1&c=中文");
    ok(/^NEW/.test(t.id) && /\/devtools\/page\/NEW/.test(t.webSocketDebuggerUrl), "newPage 要把新标签页的 id 和 WebSocket 地址交出来", JSON.stringify(t));
    eq(t.url, "http://example.test/a?b=1&c=中文", "地址整个编码后放进查询串，带 & 和中文的也不能被截断");
    eq(srv.newCalls, ["PUT"], "新版 Chrome 的 /json/new 只收 PUT，要先用 PUT");
    eq(srv.tabs.length, 2, "开完之后浏览器里真多了一个标签页");
    await cdp.closePage(port, t.id);
    eq(srv.tabs.map((x) => x.id), ["TAB1"], "closePage 要真的关掉那一个，别的不动");
    ok(!(await errOf(cdp.closePage(port, t.id))), "已经不在的标签页再关一次不算错（清理代码里常见的重复收尾）");
    ok(/HTTP 500/.test(await errOf(cdp.closePage(port, "BOOM"))), "Chrome 回的是 404 以外的错误，要如实报出来");
    srv.close();

    const old = fakeChrome({ getOnly: true });
    const oport = await listen(old);
    const t2 = await cdp.newPage(oport);
    ok(/^NEW/.test(t2.id), "老版本 Chrome 只认 GET：PUT 被拒后要退回 GET 再试一次");
    eq(old.newCalls, ["PUT", "GET"], "先 PUT 后 GET，顺序不能反（反过来的话新版 Chrome 会先吃一个 405）");
    old.close();

    const none = fakeChrome({ noNew: true });
    const nport = await listen(none);
    ok(/没开出新标签页/.test(await errOf(cdp.newPage(nport))), "两种方法都开不出来时要直说，而不是交出一个没有 WebSocket 地址的空壳");
    none.close();
    ok(!!(await errOf(cdp.closePage(nport, "X"))), "浏览器本身都没了（端口连不上）时 closePage 要抛出来，让调用方知道");
  }

  console.log("【12】spawnIsolated：一次性的干净 Chrome，不碰专用的那个，也不碰登录过的 profile");
  if (process.platform === "win32") {
    console.log("    （Windows 上没有进程组这套杀法，跳过）");
  } else {
    const fs = require("fs"), os = require("os"), path = require("path");
    // 假 Chrome：把自己收到的参数写进 profile 目录，另开一个子进程当渲染器，应答 /json/version、/json/new、/json/close。
    // FAKE_MODE=exit 模拟一启动就崩；FAKE_MODE=mute 模拟起来了却一直不给调试端口。
    const FAKE = `#!/usr/bin/env node
const http=require("http"),fs=require("fs"),path=require("path"),cp=require("child_process");
const ud=(process.argv.find(a=>a.startsWith("--user-data-dir="))||"").split("=").slice(1).join("=");
if(process.env.FAKE_PID_OUT)fs.writeFileSync(process.env.FAKE_PID_OUT,String(process.pid));
if(process.env.FAKE_MODE==="exit"){process.stderr.write("boom: 假浏览器起不来\\n");process.exit(3);}
fs.writeFileSync(path.join(ud,"argv.json"),JSON.stringify(process.argv.slice(2)));
const kid=cp.spawn(process.execPath,["-e","setTimeout(()=>process.exit(0),12e4)"],{stdio:"ignore"});
fs.writeFileSync(path.join(ud,"kid.pid"),String(kid.pid));
if(process.env.FAKE_MODE==="mute"){setTimeout(()=>process.exit(0),12e4);}else{
let n=0;const srv=http.createServer((req,res)=>{const p=srv.address().port;
  if(req.url.startsWith("/json/version"))return res.end(JSON.stringify({Browser:"FakeChrome/1",webSocketDebuggerUrl:"ws://127.0.0.1:"+p+"/devtools/browser/iso"}));
  if(req.url.startsWith("/json/list"))return res.end("[]");
  if(req.url.startsWith("/json/new")){if(req.method!=="PUT"){res.writeHead(405);return res.end("PUT only");}
    const id="ISO"+(++n);return res.end(JSON.stringify({id,type:"page",url:"about:blank",webSocketDebuggerUrl:"ws://127.0.0.1:"+p+"/devtools/page/"+id}));}
  if(req.url.startsWith("/json/close/"))return res.end("Target is closing");
  res.writeHead(404);res.end("[]");});
srv.listen(0,"127.0.0.1",()=>fs.writeFileSync(path.join(ud,"DevToolsActivePort"),srv.address().port+"\\n/devtools/browser/iso\\n"));
setTimeout(()=>process.exit(0),12e4);}
`;
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cdp-isobin-"));
    const bin = path.join(binDir, "fake-chrome");
    fs.writeFileSync(bin, FAKE, { mode: 0o755 });
    const oldPath = process.env.OWB_CHROME_PATH;
    process.env.OWB_CHROME_PATH = bin;
    try {
      const iso = await cdp.spawnIsolated({ prefix: "owb-cdp-iso-", windowSize: { w: 1280, h: 720 }, extraArgs: ["--force-device-scale-factor=1", "--disable-features=OwbTestFeature"] });
      const argv = JSON.parse(fs.readFileSync(path.join(iso.dir, "argv.json"), "utf8"));
      const kid = Number(fs.readFileSync(path.join(iso.dir, "kid.pid"), "utf8"));
      ok(iso.port > 0 && iso.pid > 0 && typeof iso.kill === "function", "要交出端口、pid 和 kill()", JSON.stringify({ port: iso.port, pid: iso.pid }));
      eq(path.dirname(iso.dir), os.tmpdir(), "profile 放在系统临时目录下");
      ok(path.basename(iso.dir).startsWith("owb-cdp-iso-"), "目录名用调用方给的 owb- 前缀（测试收尾的扫帚只认这一族）", iso.dir);
      eq(argv.filter((a) => a.startsWith("--user-data-dir=")), [`--user-data-dir=${iso.dir}`], "Chrome 真拿到的就是这个新目录，只有一个 --user-data-dir");
      eq(argv.includes("--remote-debugging-port=0"), true, "端口让 Chrome 自己挑，别和 9222 或专用的那个撞");
      ok(["--mute-audio", "--hide-scrollbars", "--headless=new", "--window-size=1280,720", "--force-device-scale-factor=1"].every((a) => argv.includes(a)), "录制要用的参数一个不少，调用方追加的也在", argv.join(" "));
      ok(!argv.includes("--disable-gpu") && !argv.includes("--no-sandbox"), "不许加 --disable-gpu（WebGL 会废）和 --no-sandbox", argv.join(" "));
      const feats = argv.filter((a) => a.startsWith("--disable-features="));
      ok(feats.length === 1 && /Translate/.test(feats[0]) && /OwbTestFeature/.test(feats[0]), "--disable-features 只能出现一次（Chrome 只认最后一个），调用方给的要合进去", feats.join(" "));
      eq(argv[argv.length - 1], "about:blank", "起来就是一张空白页");

      const st = await cdp.run({ action: "status", port: iso.port });
      ok(st.alive === true && st.launched_by_us === false, "一次性的不记进专用浏览器那本账：status 看它不是「本工具拉起的那个」", JSON.stringify(st));
      eq((await cdp.run({ action: "close" })).closed, false, "close 只管专用的那个，一次性的由调用方自己 kill（反向对照）");
      ok(alive(iso.pid), "run close 之后一次性的那个还活着");

      const iso2 = await cdp.spawnIsolated({ prefix: "../逃出去" });
      ok(iso2.dir !== iso.dir && path.dirname(iso2.dir) === os.tmpdir() && path.basename(iso2.dir).startsWith("owb-webdemo-prof-"),
        "每次都是全新目录；前缀不是 owb- 开头的规矩写法就退回默认，别被拼出临时目录之外", iso2.dir);
      ok(iso2.port !== iso.port, "两个一次性的各有各的端口");

      const tab = await cdp.newPage(iso.port);
      ok(/^ISO/.test(tab.id), "newPage 在一次性浏览器上也能用", JSON.stringify(tab));
      ok(!(await errOf(cdp.closePage(iso.port, tab.id))), "closePage 也能用（它回的是纯文本，不是 JSON）");

      await Promise.all([iso.kill(), iso2.kill()]);
      await sleep(200);
      ok(!alive(iso.pid) && !alive(kid), "kill() 要把主进程和子进程一起收掉");
      ok(!fs.existsSync(iso.dir) && !fs.existsSync(iso2.dir), "kill() 之后 profile 目录要删干净");
      ok(!(await errOf(iso.kill())), "kill() 可以重复调用（finally 里再收一次不许报错）");

      // 起不来：报错要带上它自己说的话，临时目录也要收掉
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cdp-isoroot-"));
      const pidOut = path.join(binDir, "pid");
      process.env.FAKE_PID_OUT = pidOut;
      process.env.FAKE_MODE = "exit";
      const crash = await errOf(cdp.spawnIsolated({ tmpRoot: root, timeoutMs: 5000 }));
      ok(/一启动就退出了（退出码 3）/.test(crash) && /boom: 假浏览器起不来/.test(crash), "一启动就崩：要说退出码，还要把它 stderr 最后几行带出来", crash);
      eq(fs.readdirSync(root), [], "崩了也不许把 profile 目录留在临时目录里");
      process.env.FAKE_MODE = "mute";
      const t0 = Date.now();
      const mute = await errOf(cdp.spawnIsolated({ tmpRoot: root, timeoutMs: 800 }));
      ok(/秒内没等到它的调试端口/.test(mute) && Date.now() - t0 < 6000, "起来了却一直不给端口：到点要放弃并说清楚，不能一直等", mute);
      await sleep(200);
      ok(!alive(Number(fs.readFileSync(pidOut, "utf8"))), "等超时放弃的那个也要杀掉，不许留一个没人管的浏览器");
      eq(fs.readdirSync(root), [], "等超时放弃时 profile 目录同样要删");
      // 路径指到一个没有执行权限的文件：spawn 只报 error 不报 exit，要当场说，不能干等满超时
      const noExec = path.join(binDir, "not-executable");
      fs.writeFileSync(noExec, "#!/bin/sh\n", { mode: 0o644 });
      process.env.OWB_CHROME_PATH = noExec;
      const t1 = Date.now();
      const eacces = await errOf(cdp.spawnIsolated({ tmpRoot: root, timeoutMs: 10000 }));
      ok(/没能启动/.test(eacces) && /EACCES/.test(eacces) && Date.now() - t1 < 3000, "起都没起来：马上报，并带上系统给的原因", eacces);
      eq(fs.readdirSync(root), [], "  └ profile 目录同样要删");
      process.env.OWB_CHROME_PATH = bin;
      delete process.env.FAKE_MODE; delete process.env.FAKE_PID_OUT;
      fs.rmSync(root, { recursive: true, force: true });

      process.env.OWB_CHROME_PATH = "/绝对不存在/chrome";
      ok(/没找到 Chrome/.test(await errOf(cdp.spawnIsolated({}))), "机器上没浏览器时要直说，并指出 OWB_CHROME_PATH 这条路");
    } finally {
      delete process.env.FAKE_MODE; delete process.env.FAKE_PID_OUT;
      if (oldPath === undefined) delete process.env.OWB_CHROME_PATH; else process.env.OWB_CHROME_PATH = oldPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }

  console.log("【13】几个对话同时用浏览器：各用各的标签页");
  {
    // 出过的事：飞车任务截的「游戏画面」其实是另一个任务导航过去的博物馆首页，模型还照着分析了半天
    const srv = fakeChrome();
    const port = await listen(srv);
    const a = await cdp.run({ action: "navigate", port, url: "http://a.test/", wait_ms: 0, owner: "S1" });
    const b = await cdp.run({ action: "navigate", port, url: "http://b.test/", wait_ms: 0, owner: "S2" });
    ok(/^NEW/.test(a.tab_id) && /^NEW/.test(b.tab_id) && a.tab_id !== b.tab_id, "两个对话头一回用浏览器，各自单开一个标签页", JSON.stringify([a.tab_id, b.tab_id]));
    eq((await cdp.run({ action: "screenshot", port, owner: "S1" })).tab_id, a.tab_id, "不点名时落在自己那个标签页上，不是「第一个页面」");
    eq((await cdp.run({ action: "screenshot", port, owner: "S2" })).tab_id, b.tab_id, "  └ 另一个对话也一样");
    const l1 = await cdp.run({ action: "list_tabs", port, owner: "S1" });
    eq(l1.tabs.map((t) => t.id).sort(), ["TAB1", a.tab_id].sort(), "list_tabs 不把别的任务的标签页列出来");
    ok(l1.tabs.find((t) => t.id === a.tab_id)?.mine === true, "自己那个标上 mine", JSON.stringify(l1.tabs));
    ok(/别的任务在用/.test(await errOf(cdp.run({ action: "evaluate", port, tab_id: b.tab_id, owner: "S1" }))), "点名去动别人的标签页要拦下");
    ok(/别的任务在用/.test(await errOf(cdp.run({ action: "close_tab", port, tab_id: b.tab_id, owner: "S1" }))), "  └ 关也不行");
    ok(srv.tabs.some((t) => t.id === b.tab_id), "  └ 拦下之后别人的标签页还在");
    eq((await cdp.run({ action: "evaluate", port, expression: "1" })).tab_id, "TAB1", "不带 owner 的调用照旧用第一个页面标签页（反向对照）");

    const c1 = await cdp.run({ action: "close", owner: "S1" });
    ok(c1.closed === false && /只关了你自己的标签页/.test(c1.why), "别的任务还在用时，close 只收自己的标签页，不关整个浏览器", JSON.stringify(c1));
    ok(!srv.tabs.some((t) => t.id === a.tab_id) && srv.tabs.some((t) => t.id === b.tab_id), "  └ 自己的关了，别人的还在");

    const gone = await cdp.run({ action: "navigate", port, url: "http://c.test/", wait_ms: 0, owner: "S3" });
    srv.tabs.splice(srv.tabs.findIndex((t) => t.id === gone.tab_id), 1);
    const again = await cdp.run({ action: "screenshot", port, owner: "S3" });
    ok(/^NEW/.test(again.tab_id) && again.tab_id !== gone.tab_id, "自己的标签页被人手动关了：再用时重开一个，不去借别人的", JSON.stringify([gone.tab_id, again.tab_id]));
    await cdp.run({ action: "close_tab", port, tab_id: again.tab_id, owner: "S3" });
    const third = await cdp.run({ action: "screenshot", port, owner: "S3" });
    ok(third.tab_id !== again.tab_id && srv.tabs.some((t) => t.id === third.tab_id), "close_tab 关掉自己那个之后，下回同样重开", JSON.stringify(third));

    eq(await cdp.releaseOwner("S2"), true, "任务收尾：releaseOwner 交代有收到");
    ok(!srv.tabs.some((t) => t.id === b.tab_id), "  └ 它开的标签页真关了（不关的话后台 Chrome 一天挂几十个页面）");
    eq(await cdp.releaseOwner("S2"), false, "  └ 再收一次不报错，老实说没东西可收");
    await cdp.releaseOwner("S3");
    eq(srv.tabs.map((t) => t.id), ["TAB1"], "全部收完只剩原来那个");
    srv.close();

    // 开不出新标签页的浏览器：用一个没人占的；全被占了就直说，不去跟别人抢同一个页面
    const none = fakeChrome({ noNew: true });
    const nport = await listen(none);
    eq((await cdp.run({ action: "screenshot", port: nport, owner: "N1" })).tab_id, "TAB1", "开不出新标签页时，退一步用没人占着的那个");
    ok(/没能给这个任务单开一个标签页/.test(await errOf(cdp.run({ action: "screenshot", port: nport, owner: "N2" }))), "  └ 那个也被占了：报错，不共用");
    await cdp.releaseOwner("N1");
    none.close();

    const fs = require("fs"), path = require("path");
    const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    ok(/cdp\.run\(\{ \.\.\.input, owner: opts\.sessionId/.test(src(mod.rel("tools"))), "chrome_cdp 工具要把会话 id 当 owner 传下去");
    ok(/releaseOwner\(sessionId\)/.test(src("server.js")), "一趟对话跑完要收掉它开的标签页");
  }

  console.log("【14】无头浏览器：动完冻住，再动先解冻拉前台；按标签页各计各的；数量封顶；闲久了关");
  {
    // 2026-09-28 实测：无头 Chrome 里一个 WebGL 游戏页，没人动它的那几分钟整棵进程树 134-189% CPU，冻住后 7-18%
    const keep = { park: process.env.OWB_CDP_PARK_MS, idle: process.env.OWB_CDP_TAB_IDLE_MS, max: process.env.OWB_CDP_MAX_TABS };
    process.env.OWB_CDP_PARK_MS = "150"; process.env.OWB_CDP_TAB_IDLE_MS = "0"; delete process.env.OWB_CDP_MAX_TABS;
    const on = (srv, tab) => (srv.calls || []).filter((c) => c.tab === tab).map((c) => c.method === "Page.setWebLifecycleState" ? "state:" + c.state : c.method);
    const srv = fakeChrome({ headless: true });
    const port = await listen(srv);
    // P1/P2 这一段冻结线放宽到 600ms：P2 每 50ms 动一下，要证明的是「一直在动就不冻」，
    // 冻结线只有 150ms 时，CI 机器上计时器晚个一两百毫秒，P2 两下之间就够着了（2026-10-06 真红过一次）
    process.env.OWB_CDP_PARK_MS = "600";
    const a = await cdp.run({ action: "navigate", port, url: "http://a.test/", wait_ms: 0, owner: "P1" });
    const seqA = on(srv, a.tab_id);
    ok(seqA.indexOf("state:active") >= 0 && seqA.indexOf("Page.bringToFront") > seqA.indexOf("state:active") && seqA.indexOf("Page.navigate") > seqA.indexOf("Page.bringToFront"),
      "动之前先解冻、再拉到前台，然后才做动作本身", JSON.stringify(seqA));
    // P2 一直在动（每 50ms 一下）：P1 的冻结不能被它往后推
    const b = await cdp.run({ action: "navigate", port, url: "http://b.test/", wait_ms: 0, owner: "P2" });
    // 动到 P1 冻住为止（最多 10 秒），不按固定时长猜；顺手量 P2 两下之间最长隔了多久，挂了好对数
    let gap = 0;
    for (let t0 = Date.now(), last = t0; !on(srv, a.tab_id).includes("state:frozen") && Date.now() - t0 < 10000;) {
      await sleep(50); await cdp.run({ action: "evaluate", port, expression: "1", owner: "P2" });
      const now = Date.now(); gap = Math.max(gap, now - last); last = now;
    }
    ok(on(srv, a.tab_id).includes("state:frozen"), "P1 闲过 OWB_CDP_PARK_MS 就冻住，P2 在旁边一直动也挡不住", JSON.stringify(on(srv, a.tab_id)));
    ok(!on(srv, b.tab_id).includes("state:frozen"), "  └ P2 自己一直在动：它那页不冻（反向对照）", JSON.stringify({ maxGapMs: gap, calls: on(srv, b.tab_id) }));
    process.env.OWB_CDP_PARK_MS = "150";
    for (let t0 = Date.now(); !on(srv, b.tab_id).includes("state:frozen") && Date.now() - t0 < 3000;) await sleep(50);
    ok(on(srv, b.tab_id).includes("state:frozen"), "  └ P2 停手之后它那页也冻住");
    // status / list_tabs 只看不碰：不能顺手把冻住的页解冻
    const before = on(srv, a.tab_id).length;
    await cdp.run({ action: "status", port });
    await cdp.run({ action: "list_tabs", port, owner: "P1" });
    eq(on(srv, a.tab_id).length, before, "status 和 list_tabs 不许去解冻标签页");
    const shot = await cdp.run({ action: "screenshot", port, owner: "P1" });
    const tail = on(srv, a.tab_id).slice(before);
    eq(tail, ["state:active", "Page.bringToFront", "Page.captureScreenshot"], "冻住之后再截图：先解冻、拉前台，再截");
    eq(shot.tab_id, a.tab_id, "  └ 还是原来那个标签页，冻住不等于关掉");
    // 2026-09-29 复审：冻着那段页面里的计时器、动画全停着，解开后头一下拿到的可能是冻住那一刻的样子——得告诉模型
    eq(shot.note, cdp._internals.THAW_NOTE, "  └ 从冻住解开的这一下：结果里说一声");
    const shot2 = await cdp.run({ action: "screenshot", port, owner: "P1" });
    ok(!shot2.note, "  └ 紧接着再来一下（中间没冻过）：不说（反向对照）", JSON.stringify(shot2));
    await sleep(300);
    ok(on(srv, a.tab_id).slice(-1)[0] === "state:frozen", "  └ 又闲过 OWB_CDP_PARK_MS：又冻住了", JSON.stringify(on(srv, a.tab_id).slice(-3)));
    const nav = await cdp.run({ action: "navigate", port, url: "http://a2.test/", wait_ms: 0, owner: "P1" });
    ok(nav.tab_id === a.tab_id && !nav.note, "  └ 冻住后直接换网址：换的是新页面，不用说（反向对照）", JSON.stringify(nav));

    // 不设 OWB_CDP_PARK_MS：以前 8 秒就冻，模型想一想的工夫页面就停了。现在一分钟
    delete process.env.OWB_CDP_PARK_MS;
    eq(cdp._internals.parkMs(), 60000, "默认动完一分钟才冻");
    const dflt = await cdp.run({ action: "navigate", port, url: "http://dflt.test/", wait_ms: 0, owner: "D9" });
    await sleep(400);
    const dslot = cdp._internals.PARK.get(`${port}:${dflt.tab_id}`);
    ok(!on(srv, dflt.tab_id).includes("state:frozen") && !!(dslot && dslot.timer), "  └ 默认值下动完 400ms：没冻，冻结计时还挂着", JSON.stringify(on(srv, dflt.tab_id)));
    process.env.OWB_CDP_PARK_MS = "0";
    eq(cdp._internals.parkMs(), 0, "  └ 给 0 就关掉（反向对照：env 还认）");
    process.env.OWB_CDP_PARK_MS = "150";
    await cdp.releaseOwner("D9");
    ok(!cdp._internals.PARK.has(`${port}:${dflt.tab_id}`), "  └ 收尾时连同那个一分钟的计时一起撤");

    // 有头的浏览器：一条停放相关的调用都不许发——bringToFront 会把 Chrome 窗口提到最前、抢走焦点
    const head = fakeChrome();
    const hport = await listen(head);
    const h = await cdp.run({ action: "navigate", port: hport, url: "http://h.test/", wait_ms: 0, owner: "H1" });
    await sleep(300);
    eq(on(head, h.tab_id).filter((m) => /state:|bringToFront/.test(m)), [], "有头浏览器不冻、不拉前台（反向对照）");
    await cdp.releaseOwner("H1");
    head.close();

    // 数量封顶：到顶了收掉闲得最久的那个，它下回再来时新开一个并说一声
    process.env.OWB_CDP_MAX_TABS = "2";
    const c = await cdp.run({ action: "navigate", port, url: "http://c.test/", wait_ms: 0, owner: "P3" });
    ok(!srv.tabs.some((t) => t.id === b.tab_id) && srv.tabs.some((t) => t.id === a.tab_id) && srv.tabs.some((t) => t.id === c.tab_id),
      "开到第三个：收掉闲得最久的 P2，刚用过的 P1 留着", JSON.stringify(srv.tabs.map((t) => t.id)));
    const b2 = await cdp.run({ action: "screenshot", port, owner: "P2" });
    ok(b2.tab_id !== b.tab_id && /收掉/.test(b2.note || ""), "被收掉的任务再来：新开一页，结果里告诉它这是新开的", JSON.stringify(b2));
    ok(!srv.tabs.some((t) => t.id === a.tab_id) && srv.tabs.some((t) => t.id === c.tab_id), "  └ 它回来又顶到上限：这回轮到闲得最久的 P1", JSON.stringify(srv.tabs.map((t) => t.id)));
    const b3 = await cdp.run({ action: "screenshot", port, owner: "P2" });
    ok(!b3.note, "  └ 只说一次");
    process.env.OWB_CDP_MAX_TABS = "6";
    const d = await cdp.run({ action: "navigate", port, url: "http://d.test/", wait_ms: 0, owner: "P4" });
    ok([c.tab_id, b2.tab_id, d.tab_id].every((id) => srv.tabs.some((t) => t.id === id)), "没到顶就一个都不收（反向对照）", JSON.stringify(srv.tabs.map((t) => t.id)));

    // 不带 owner 的调用：没空闲页时新开一个，绝不落到别的任务的标签页上
    const t1 = srv.tabs.findIndex((t) => t.id === "TAB1");
    if (t1 >= 0) srv.tabs.splice(t1, 1);
    const anon = await cdp.run({ action: "evaluate", port, expression: "1" });
    const owned = [a.tab_id, b2.tab_id, c.tab_id, d.tab_id].filter((id) => srv.tabs.some((t) => t.id === id));
    ok(!owned.includes(anon.tab_id) && srv.tabs.some((t) => t.id === anon.tab_id), "没人占着的页面一个都没有：新开一个，不去借别的任务的", JSON.stringify([anon.tab_id, owned]));

    // 任务收尾关不掉标签页（浏览器回了错）：至少冻住，别让它在后台接着转
    srv.closeFails = true;
    await cdp.releaseOwner("P4");
    ok(srv.tabs.some((t) => t.id === d.tab_id) && on(srv, d.tab_id).slice(-1)[0] === "state:frozen", "关不掉就冻住", JSON.stringify(on(srv, d.tab_id)));
    srv.closeFails = false;
    const cBefore = on(srv, c.tab_id).length;
    await cdp.releaseOwner("P3");
    ok(!srv.tabs.some((t) => t.id === c.tab_id) && on(srv, c.tab_id).length === cBefore, "关得掉就直接关，不用多冻一下（反向对照）");

    // 闲太久：按标签页单独关，不等整个浏览器的闲置计时（别的任务一直在用，那个永远到不了点）
    process.env.OWB_CDP_TAB_IDLE_MS = "200";
    const q = await cdp.run({ action: "navigate", port, url: "http://q.test/", wait_ms: 0, owner: "Q1" });
    await sleep(450);
    ok(!srv.tabs.some((t) => t.id === q.tab_id), "一个任务的标签页闲过 OWB_CDP_TAB_IDLE_MS 就关掉");
    const q2 = await cdp.run({ action: "screenshot", port, owner: "Q1" });
    ok(q2.tab_id !== q.tab_id && /闲置太久/.test(q2.note || ""), "  └ 它再来：新开一页并说明", JSON.stringify(q2));
    process.env.OWB_CDP_TAB_IDLE_MS = "0";
    const r = await cdp.run({ action: "navigate", port, url: "http://r.test/", wait_ms: 0, owner: "R1" });
    await sleep(450);
    ok(srv.tabs.some((t) => t.id === r.tab_id), "OWB_CDP_TAB_IDLE_MS=0 就不按标签页关（反向对照）");

    // 2026-09-29 复审：任务还没跑完（等用户回话、等审批超过 10 分钟），闲置关页、到顶腾位都不许收它的页——
    // 回来一看填了一半的表单、登好的账号连页一起没了。server.js 用 setActivePredicate 接上 activeRuns / holdRun
    const running = new Set(["A1"]);
    cdp.setActivePredicate((o) => running.has(o));
    process.env.OWB_CDP_TAB_IDLE_MS = "200";
    const a1 = await cdp.run({ action: "navigate", port, url: "http://a1.test/", wait_ms: 0, owner: "A1" });
    const z1 = await cdp.run({ action: "navigate", port, url: "http://z1.test/", wait_ms: 0, owner: "Z1" });
    await sleep(450);
    ok(srv.tabs.some((t) => t.id === a1.tab_id) && cdp._internals.OWNED.has("A1"), "任务还在跑：标签页闲过 OWB_CDP_TAB_IDLE_MS 也不关");
    ok(!srv.tabs.some((t) => t.id === z1.tab_id), "  └ 同一时间不在跑的 Z1 照样关（反向对照）");
    running.delete("A1");
    await sleep(450);
    ok(!srv.tabs.some((t) => t.id === a1.tab_id), "  └ A1 不在跑了：下一轮计时到点就关");
    process.env.OWB_CDP_TAB_IDLE_MS = "0";

    process.env.OWB_CDP_MAX_TABS = "2";
    const srv2 = fakeChrome();
    const port2 = await listen(srv2);
    const m = {};
    for (const o of ["M1", "M2", "M3"]) { running.add(o); m[o] = await cdp.run({ action: "navigate", port: port2, url: `http://${o}.test/`, wait_ms: 0, owner: o }); await sleep(5); }
    ok(["M1", "M2", "M3"].every((o) => srv2.tabs.some((t) => t.id === m[o].tab_id)), "上限 2、第三个进来时前两个都还在跑：先超出上限，一个都不收",
      JSON.stringify(srv2.tabs.map((t) => t.id)));
    running.delete("M2");
    running.add("M4");
    const m4 = await cdp.run({ action: "navigate", port: port2, url: "http://M4.test/", wait_ms: 0, owner: "M4" });
    ok(!srv2.tabs.some((t) => t.id === m.M2.tab_id) && ["M1", "M3"].every((o) => srv2.tabs.some((t) => t.id === m[o].tab_id)) && srv2.tabs.some((t) => t.id === m4.tab_id),
      "  └ M2 跑完了：再来一个就收 M2，比它更早开的 M1 还在跑所以留着（反向对照）", JSON.stringify(srv2.tabs.map((t) => t.id)));
    for (const o of ["A1", "Z1", "M1", "M2", "M3", "M4"]) await cdp.releaseOwner(o);
    cdp.setActivePredicate(null);
    srv2.close();
    process.env.OWB_CDP_MAX_TABS = "6";

    for (const o of ["P1", "P2", "Q1", "R1", "P4"]) await cdp.releaseOwner(o);
    await sleep(250);
    // 不带 owner 借来的那页（上面 anon）没人收，它的停放记录只剩一个「已冻住」的标记，定时器不许还挂着
    const live = [...cdp._internals.PARK.entries()].filter(([, s]) => s.timer || s.busy).map(([k]) => k);
    ok(!live.length && !cdp._internals.OWNED.size, "全部收完：标签页账本清空，不留还在走的定时器", JSON.stringify([live, ...cdp._internals.OWNED.keys()]));
    ok([...cdp._internals.PARK.values()].every((s) => s.parked), "  └ 剩下的停放记录都是已经冻住的页");
    srv.close();
    for (const [k, v] of Object.entries({ OWB_CDP_PARK_MS: keep.park, OWB_CDP_TAB_IDLE_MS: keep.idle, OWB_CDP_MAX_TABS: keep.max })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  console.log("【15】专用浏览器的 profile：缓存封顶、不下组件；只清能重建的；认领回来的也记 pid");
  if (process.platform === "win32") {
    console.log("    （Windows 上没有 SingletonLock 符号链接和进程组，跳过）");
  } else {
    const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const made = [];
    const mkdir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
    // 假 Chrome：把收到的参数写进 profile，写出 DevToolsActivePort，应答 /json/version
    const FAKE = `#!/usr/bin/env node
const http=require("http"),fs=require("fs"),path=require("path");
const ud=(process.argv.find(a=>a.startsWith("--user-data-dir="))||"").split("=").slice(1).join("=");
fs.writeFileSync(path.join(ud,"args.json"),JSON.stringify(process.argv.slice(2)));
const srv=http.createServer((req,res)=>{const p=srv.address().port;
  if(req.url.startsWith("/json/version"))return res.end(JSON.stringify({Browser:"FakeChrome/1",webSocketDebuggerUrl:"ws://127.0.0.1:"+p+"/devtools/browser/x"}));
  res.end("[]");});
srv.listen(0,"127.0.0.1",()=>fs.writeFileSync(path.join(ud,"DevToolsActivePort"),srv.address().port+"\\n/devtools/browser/x\\n"));
setTimeout(()=>process.exit(0),12e4);
`;
    const binDir = mkdir("owb-cdp-fake-");
    const bin = path.join(binDir, "fake-chrome");
    fs.writeFileSync(bin, FAKE, { mode: 0o755 });
    const oldPath = process.env.OWB_CHROME_PATH, oldIdle = process.env.OWB_CDP_IDLE_MS;
    process.env.OWB_CHROME_PATH = bin; process.env.OWB_CDP_IDLE_MS = "0";

    // 能重建的清掉，登录态一样不碰
    const prof = mkdir("owb-cdp-prof-");
    const KEEP = ["Default/Cookies", "Default/Login Data", "Default/Local Storage/leveldb/000003.log", "Default/IndexedDB/x.db", "Default/Cache/Cache_Data/f_000001"];
    for (const f of [...KEEP, ...cdp._internals.TRIM_DIRS.map((d) => d + "/blob")]) { fs.mkdirSync(path.dirname(path.join(prof, f)), { recursive: true }); fs.writeFileSync(path.join(prof, f), "x"); }
    const r = await cdp.launch({ user_data_dir: prof });
    const args = JSON.parse(fs.readFileSync(path.join(prof, "args.json"), "utf8"));
    ok(args.includes("--disk-cache-size=67108864") && args.includes("--disable-component-update"), "启动参数：缓存封顶 64MB、不下组件", JSON.stringify(args));
    const feats = (args.find((x) => x.startsWith("--disable-features=")) || "").split("=")[1] || "";
    ok(["Translate", "AcceptCHFrame", "OptimizationGuideModelDownloading", "OptimizationHints", "OptimizationHintsFetching", "MediaRouter"].every((f) => feats.split(",").includes(f)),
      "  └ 优化模型、MediaRouter 一起关掉，原来那两个也还在", feats);
    ok(!args.includes("--disable-gpu"), "  └ 不许顺手加 --disable-gpu（无头 WebGL 会直接没了）");
    ok(cdp._internals.TRIM_DIRS.every((d) => !fs.existsSync(path.join(prof, d))), "拉起前清掉优化模型、组件包、指标");
    ok(KEEP.every((f) => fs.existsSync(path.join(prof, f))), "  └ Cookies / Login Data / Local Storage / IndexedDB / 缓存一样不碰", KEEP.filter((f) => !fs.existsSync(path.join(prof, f))).join(","));
    eq((await cdp.run({ action: "close" })).closed, true, "  └ 收掉这个假浏览器");
    await sleep(300);
    ok(!alive(r.pid), "  └ 真收掉了");

    // profile 正被别的 Chrome 开着：一个字节都不动
    const locked = mkdir("owb-cdp-lock-");
    for (const d of cdp._internals.TRIM_DIRS) { fs.mkdirSync(path.join(locked, d)); fs.writeFileSync(path.join(locked, d, "blob"), "x"); }
    fs.symlinkSync("somehost-999999", path.join(locked, "SingletonLock"));
    eq(await cdp._internals.trimProfile(locked), [], "profile 上有 SingletonLock：什么都不删（反向对照）");
    ok(cdp._internals.TRIM_DIRS.every((d) => fs.existsSync(path.join(locked, d, "blob"))), "  └ 文件都还在");

    // 认领回来的：SingletonLock 指着的进程命令行里真带着这个 profile，才记 pid、闲置到点能收、退出时能带走
    const adopt = mkdir("owb-cdp-adopt-");
    const kid = cp.spawn(process.execPath, [bin, `--user-data-dir=${adopt}`], { detached: true, stdio: "ignore" });
    kid.unref();
    for (let i = 0; i < 100 && !fs.existsSync(path.join(adopt, "DevToolsActivePort")); i++) await sleep(50);
    fs.symlinkSync(`${os.hostname()}-${kid.pid}`, path.join(adopt, "SingletonLock"));
    const ad = await cdp.launch({ user_data_dir: adopt });
    ok(ad.adopted === true && ad.pid === kid.pid, "认领一个活着的专用浏览器：pid 也要记下", JSON.stringify(ad));
    eq((await cdp.run({ action: "close" })).closed, true, "  └ 认领来的也关得掉（以前没 pid，close 直接说「不是本工具拉起来的」）");
    await sleep(500);
    ok(!alive(kid.pid), "  └ 进程真没了");

    // 锁指着一个不相干的进程（pid 被复用了）：不认领这个 pid，更不能去杀它
    const stray = cp.spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),12e4)"], { detached: true, stdio: "ignore" });
    stray.unref();
    const adopt2 = mkdir("owb-cdp-adopt2-");
    const kid2 = cp.spawn(process.execPath, [bin, `--user-data-dir=${adopt2}`], { detached: true, stdio: "ignore" });
    kid2.unref();
    for (let i = 0; i < 100 && !fs.existsSync(path.join(adopt2, "DevToolsActivePort")); i++) await sleep(50);
    fs.symlinkSync(`${os.hostname()}-${stray.pid}`, path.join(adopt2, "SingletonLock"));
    const ad2 = await cdp.launch({ user_data_dir: adopt2 });
    ok(ad2.adopted === true && !ad2.pid, "锁指着的进程命令行里没有这个 profile：不记 pid（反向对照）", JSON.stringify(ad2));
    eq((await cdp.run({ action: "close" })).closed, false, "  └ close 也不去动它");
    await sleep(300);
    ok(alive(stray.pid), "  └ 那个不相干的进程还活着");
    // 上面哪条断言挂了，被测进程也不许留下来（只收还活着的；这几个 pid 都是本套件刚拉起的）
    for (const p of [stray.pid, kid2.pid, kid.pid, r.pid].filter((x) => x > 1 && alive(x))) { try { process.kill(-p, "SIGKILL"); } catch {} try { process.kill(p, "SIGKILL"); } catch {} }

    if (oldPath === undefined) delete process.env.OWB_CHROME_PATH; else process.env.OWB_CHROME_PATH = oldPath;
    if (oldIdle === undefined) delete process.env.OWB_CDP_IDLE_MS; else process.env.OWB_CDP_IDLE_MS = oldIdle;
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }

  console.log(`\n${fail === 0 ? "√" : "×"} cdp：${pass} 条通过，${fail} 条失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("套件自己挂了：", e); process.exit(1); });
