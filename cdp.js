"use strict";
/**
 * 极小的 Chrome DevTools Protocol 客户端。
 * 不引入 puppeteer/playwright：本机 Chrome 已经有 CDP，Agent 只需要一条受限的
 * localhost WebSocket。所有调用都必须显式给 tab_id，避免误操作当前窗口。
 */
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function endpointHost(raw) {
  const u = new URL(raw || "http://127.0.0.1:9222");
  if (!/^https?:$/.test(u.protocol) || !LOCAL_HOSTS.has(u.hostname)) {
    throw new Error("Chrome CDP 只允许连接本机地址（127.0.0.1 / localhost / ::1）");
  }
  return u;
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = endpointHost(url), lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { timeout: 4000, headers: { Accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", (x) => { body += x; });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error(`CDP 返回的不是 JSON（HTTP ${res.statusCode}）`)); } });
    });
    req.on("timeout", () => req.destroy(new Error("连接 Chrome CDP 超时")));
    req.on("error", reject);
  });
}
function frame(data, mask = true) {
  const body = Buffer.from(data), head = [0x81];
  const n = body.length, key = mask ? crypto.randomBytes(4) : null;
  if (n < 126) head.push((mask ? 0x80 : 0) | n);
  else if (n < 65536) head.push((mask ? 0x80 : 0) | 126, n >> 8, n & 255);
  else head.push((mask ? 0x80 : 0) | 127, 0, 0, 0, 0, (n / 2 ** 32) >> 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  if (!mask) return Buffer.concat([Buffer.from(head), body]);
  const out = Buffer.alloc(body.length); for (let i = 0; i < body.length; i++) out[i] = body[i] ^ key[i % 4];
  return Buffer.concat([Buffer.from(head), key, out]);
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl), secure = u.protocol === "wss:", port = Number(u.port) || (secure ? 443 : 80);
    if (!/^(ws|wss):$/.test(u.protocol) || !LOCAL_HOSTS.has(u.hostname)) {
      throw new Error("Chrome CDP WebSocket 只允许连接本机地址");
    }
    // 分开建连而不是 (secure ? tls : net).connect：运行时没区别，但 TypeScript 能精确
    // 推断这两个重载，后续给 socket 的事件和 write 增加类型检查时不退化成 any。
    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname })
      : net.connect({ host: u.hostname, port });
    const key = crypto.randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0), opened = false;
    const pending = new Map(); let seq = 0;
    const fail = (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); if (!opened) reject(e); };
    socket.setTimeout(10000, () => socket.destroy(new Error("Chrome CDP 操作超时")));
    socket.on("error", fail); socket.on("close", () => fail(new Error("Chrome CDP 连接已关闭")));
    socket.on("connect", () => socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost\r\n\r\n`));
    const consume = () => {
      if (!opened) { const i = buf.indexOf("\r\n\r\n"); if (i < 0) return; const h = buf.slice(0, i).toString(); if (!/101 Switching Protocols/i.test(h)) return fail(new Error("Chrome 没有接受 CDP WebSocket，请确认用 --remote-debugging-port 启动")); buf = buf.slice(i + 4); opened = true; resolve({ call, close }); }
      while (buf.length >= 2) {
        const b1 = buf[0], b2 = buf[1]; let len = b2 & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (b2 & 128) { if (buf.length < off + 4) return; off += 4; }
        if (buf.length < off + len) return; let payload = buf.slice(off, off + len); buf = buf.slice(off + len);
        if ((b1 & 15) === 8) { socket.end(); return; }
        // Chrome 可以在长任务里发 ping；不回 pong 连接会被它主动清掉，表现成偶发的
        // 「Chrome CDP 连接已关闭」。客户端发出的帧必须 mask，沿用同一个编码器即可。
        if ((b1 & 15) === 9) { socket.write(frame(payload)); continue; }
        if ((b1 & 15) !== 1) continue;
        try { const msg = JSON.parse(payload.toString()); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message || "CDP 调用失败")) : p.resolve(msg.result || {}); } } catch {}
      }
    };
    socket.on("data", (d) => { buf = Buffer.concat([buf, d]); consume(); });
    const close = () => { if (!socket.destroyed) socket.end(); };
    function call(method, params = {}) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); socket.write(frame(JSON.stringify({ id, method, params }))); }); }
  });
}
async function withTab(tabId, fn, port = 9222) {
  const tabs = await getJson(`http://127.0.0.1:${port}/json/list`);
  const tab = (tabs || []).find((x) => x.id === tabId) || (tabId ? null : (tabs || []).find((x) => x.type === "page"));
  if (!tab || !tab.webSocketDebuggerUrl) throw new Error(tabId ? `找不到 Chrome 标签页：${tabId}` : "没有可操作的 Chrome 页面标签页");
  const c = await connect(tab.webSocketDebuggerUrl); try { return await fn(c.call, tab); } finally { c.close(); }
}
async function run(input = {}) {
  const port = Number(input.port) || 9222, action = String(input.action || "list_tabs");
  if (action === "list_tabs") return { tabs: (await getJson(`http://127.0.0.1:${port}/json/list`)).filter((x) => x.type === "page").map((x) => ({ id: x.id, title: x.title, url: x.url, type: x.type })) };
  return withTab(String(input.tab_id || ""), async (call, tab) => {
    if (action === "navigate") return { tab_id: tab.id, result: await call("Page.navigate", { url: String(input.url || "") }) };
    if (action === "evaluate") return { tab_id: tab.id, result: (await call("Runtime.evaluate", { expression: String(input.expression || ""), returnByValue: true, awaitPromise: true })).result?.result?.value };
    if (action === "inspect") {
      const selector = String(input.selector || "body");
      const maxChars = Math.min(100000, Math.max(1000, Number(input.max_chars) || 20000));
      const expr = `(() => { const root=document.querySelector(${JSON.stringify(selector)}); return {found:!!root,title:document.title,url:location.href,text:root?(root.innerText||root.textContent||"").slice(0,${maxChars}):""}; })()`;
      return { tab_id: tab.id, ...(await call("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.value };
    }
    if (action === "click") { const s = JSON.stringify(String(input.selector || "")); const r = await call("Runtime.evaluate", { expression: `(() => { const e=document.querySelector(${s}); if(!e) return {ok:false}; e.click(); return {ok:true,tag:e.tagName,text:(e.innerText||"").slice(0,120)}; })()`, returnByValue: true }); return { tab_id: tab.id, ...(r.result?.value || {}) }; }
    if (action === "type") { const s = JSON.stringify(String(input.selector || "")), v = JSON.stringify(String(input.text || "")); const r = await call("Runtime.evaluate", { expression: `(() => { const e=document.querySelector(${s}); if(!e) return {ok:false}; e.focus(); e.value=${v}; e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${v}})); e.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true}; })()`, returnByValue: true }); return { tab_id: tab.id, ...(r.result?.value || {}) }; }
    if (action === "screenshot") return { tab_id: tab.id, mime: "image/png", data: (await call("Page.captureScreenshot", { format: "png", fromSurface: true })).data };
    throw new Error(`不支持的 Chrome CDP 操作：${action}`);
  }, port);
}
module.exports = { run };
