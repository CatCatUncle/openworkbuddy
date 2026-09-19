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
const cdp = require("../cdp");

let pass = 0, fail = 0;
const ok = (v, m, extra) => { if (v) pass++; else { fail++; console.error("  ❌", m, extra === undefined ? "" : "\n     " + extra); } };
const eq = (a, b, m) => { try { assert.deepStrictEqual(a, b, m); pass++; } catch { fail++; console.error("  ❌", m, "\n     实际:", JSON.stringify(a), "期望:", JSON.stringify(b)); } };

const listen = (srv) => new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
const wsFrame = (s) => { const b = Buffer.from(s), h = [0x81];
  if (b.length < 126) h.push(b.length); else if (b.length < 65536) h.push(126, b.length >> 8, b.length & 255);
  else h.push(127, 0, 0, 0, 0, (b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255);
  return Buffer.concat([Buffer.from(h), b]); };

/** 一个假 DevTools：行为对齐新版 Chrome——带 Origin 就 403，101 那行写「WebSocket Protocol Handshake」。 */
function fakeChrome(opts = {}) {
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    if (req.url.startsWith("/json/version")) {
      if (opts.emptyBody) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(""); }
      return res.end(JSON.stringify({ Browser: "Chrome/153.0.0.0", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
    }
    if (req.url.startsWith("/json/list")) {
      return res.end(JSON.stringify([{ id: "TAB1", type: "page", title: "假页面", url: "http://example.test/",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/TAB1` }]));
    }
    res.writeHead(404); res.end("[]");
  });
  srv.on("upgrade", (req, socket) => {
    if (req.headers.origin) { srv.sawOrigin = req.headers.origin; socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
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

  console.log(`\n${fail === 0 ? "√" : "×"} cdp：${pass} 条通过，${fail} 条失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("套件自己挂了：", e); process.exit(1); });
