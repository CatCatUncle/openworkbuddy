// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 直播请求还没轮到处理函数就被页面掐了：25 秒心跳和挂到任务上的订阅不许留下。
 *
 * 跑法：node test/live-abort.js
 *
 * 2026-09-29 复审实测：/api/chat/live 前面有异步中间件（express.static 先去 stat 一下），
 * 页面发出请求 1-2ms 内就掐掉的话（刷新、订阅变了整条重开、关标签页），close 在处理函数跑之前就发完了，
 * 处理函数里后挂的 close 监听永远等不到：心跳定时器一直走，挂到各趟任务上的订阅一直留着，任务跑完也还在。
 * 页面每重开一次都可能漏一个，开久了越攒越多。/api/chat/stream 同一个写法，订阅也会留到那趟跑完；
 * /api/cli/stream 也是，漏的是 400ms 一次读终端记录尾巴的定时器，转到那趟活儿跑完为止。
 *
 * 【1】从 server.js 切出这两个处理函数，挂到一个「中间件先等 40ms」的 express 上，裸 socket 发完请求就掐：
 *     心跳定时器、订阅都得是 0。★反向对照★ 同一份源码去掉入口那句判断：掐几次漏几个。
 *     正常连着的照样挂上、断开照样摘——那句判断没把活连接也挡在外面。
 * 【2】起真 server.js（临时家，不配模型），预加载一个数 25 秒定时器的探针，各种时机掐 30 次：一个不剩。
 *     ★反向对照★ 一条正常连着的直播，探针数得到 1——探针真看得见心跳，0 不是没数到。
 */
const { entry } = require("./lib/entry");
const HOME = require("./lib/own-home")("live-abort");

const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");
const express = require("express");
const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src");
const SERVER = src("server");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按路由头切出整个处理函数：从 app.get(...) 到顶格的那个 }); */
function cut(head) {
  const i = SERVER.indexOf(head);
  if (i < 0) return "";
  const j = SERVER.indexOf("\n});\n", i);
  return j < 0 ? "" : SERVER.slice(i, j + 4);
}
const GUARD = /\n[ \t]*if \(res\.destroyed \|\| req\.socket\.destroyed\) return;/;

/** 把切出来的处理函数挂到一个中间件先慢 40ms 的 express 上，依赖全用最小的替身 */
function mount(handlerSrc) {
  const timers = new Set();
  const fakeSet = (fn, ms) => { const t = setInterval(fn, ms); if (ms === 25000) timers.add(t); return t; };
  const fakeClear = (t) => { timers.delete(t); clearInterval(t); };
  const run = { rid: "R1", events: [{ type: "text", delta: "你好" }], subscribers: new Set(), finished: false };
  const app = express();
  app.use((_req, _res, next) => setTimeout(next, 40)); // 替 express.static 的那次 stat：处理函数晚一拍才轮到
  new Function("app", "activeRuns", "lastRuns", "livePos", "sessionAllowed", "getSession", "guardRun", "setInterval", "clearInterval", handlerSrc)(
    app, new Map([["S1", run]]), new Map(), (_evs, k) => ({ n: k, t: 0 }), () => true, () => ({}), () => true, fakeSet, fakeClear);
  return { app, timers, run };
}
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
/** 页面刚发出请求就掐：请求整条写出去，紧跟着把 socket 关了 */
const abortEarly = (port, p, headers = "", delay = 0) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1", () => {
    s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\n${headers}\r\n`);
    if (!delay) { s.destroy(); resolve(); } else setTimeout(() => { s.destroy(); resolve(); }, delay);
  });
  s.on("error", () => resolve());
});
/** 正常连上，收到第一个字节为止 */
const hold = (port, p, headers = {}) => new Promise((resolve) => {
  const rq = http.get({ host: "127.0.0.1", port, path: p, headers }, (r) => r.once("data", () => resolve(rq)));
  rq.on("error", () => resolve(null));
});

(async () => {
  console.log("【1】请求在中间件那段就被掐：心跳、订阅不留（切 server.js 的处理函数，时机钉死）");
  const N = 12;
  for (const [route, p, hasHb] of [["/api/chat/live", "/api/chat/live?subs=S1:0:0", true], ["/api/chat/stream/:id", "/api/chat/stream/S1", false]]) {
    const handler = cut(`app.get("${route}", (req, res) => {`);
    ok(GUARD.test(handler), `${route}：处理函数入口先看连接还在不在`, handler.slice(0, 200));

    const fixed = mount(handler);
    let srv = await listen(fixed.app);
    let port = srv.address().port;
    // 先证判断没把活连接挡掉：正常连着的挂得上、断开摘得掉
    const rq = await hold(port, p);
    ok(rq && fixed.run.subscribers.size === 1 && fixed.timers.size === (hasHb ? 1 : 0), `${route}：正常连着的照样挂上订阅${hasHb ? "、起心跳" : ""}`,
      { subs: fixed.run.subscribers.size, hb: fixed.timers.size });
    if (rq) rq.destroy();
    await sleep(150);
    ok(fixed.run.subscribers.size === 0 && fixed.timers.size === 0, `${route}：  └ 断开照样摘干净`, { subs: fixed.run.subscribers.size, hb: fixed.timers.size });
    for (let i = 0; i < N; i++) await abortEarly(port, p);
    await sleep(300);
    ok(fixed.run.subscribers.size === 0 && fixed.timers.size === 0, `${route}：发完就掐 ${N} 次，订阅${hasHb ? "、心跳定时器" : ""}一个不留`,
      { subs: fixed.run.subscribers.size, hb: fixed.timers.size });
    srv.close();

    // ★反向对照★ 同一份源码去掉入口那句判断：close 早发完了，后挂的监听等不到，掐几次漏几个
    const old = mount(handler.replace(GUARD, ""));
    srv = await listen(old.app);
    port = srv.address().port;
    for (let i = 0; i < N; i++) await abortEarly(port, p);
    await sleep(300);
    ok(old.run.subscribers.size === N && old.timers.size === (hasHb ? N : 0),
      `${route}：★反向对照★ 去掉那句判断，掐 ${N} 次漏 ${N} 个订阅${hasHb ? "、" + N + " 个心跳" : ""}`, { subs: old.run.subscribers.size, hb: old.timers.size });
    for (const t of old.timers) clearInterval(t);
    srv.close();
  }

  // 2026-09-29 复审：/api/cli/stream 同一个写法，漏的是 400ms 一次读终端记录尾巴的定时器，一直转到那趟活儿跑完
  {
    const route = "/api/cli/stream/:id", p = "/api/cli/stream/C1";
    const handler = cut(`app.get("${route}", (req, res) => {`);
    ok(GUARD.test(handler), `${route}：处理函数入口先看连接还在不在`, handler.slice(0, 200));
    const mountCli = (code) => {
      const timers = new Set();
      const fakeSet = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
      const fakeClear = (t) => { timers.delete(t); clearInterval(t); };
      const cliLive = {
        get: (sid) => (sid === "C1" ? { live: true } : null),
        read: (_sid, o) => (o && "fromLine" in o ? { events: [{ type: "text", delta: "在跑" }], pos: 10 } : { events: [], pos: o.fromByte }),
      };
      const app = express();
      app.use((_req, _res, next) => setTimeout(next, 40));
      new Function("app", "canRemoteControl", "cliOffReason", "cliLive", "setInterval", "clearInterval", code)(
        app, () => true, () => "", cliLive, fakeSet, fakeClear);
      return { app, timers };
    };
    const fixed = mountCli(handler);
    let srv = await listen(fixed.app);
    let port = srv.address().port;
    const rq = await hold(port, p);
    ok(rq && fixed.timers.size === 1, `${route}：正常连着的照样补发、起读尾部的定时器`, { timers: fixed.timers.size });
    if (rq) rq.destroy();
    await sleep(150);
    ok(fixed.timers.size === 0, `${route}：  └ 断开照样停掉`, { timers: fixed.timers.size });
    for (let i = 0; i < N; i++) await abortEarly(port, p);
    await sleep(300);
    ok(fixed.timers.size === 0, `${route}：发完就掐 ${N} 次，定时器一个不留`, { timers: fixed.timers.size });
    srv.close();
    const old = mountCli(handler.replace(GUARD, ""));
    srv = await listen(old.app);
    port = srv.address().port;
    for (let i = 0; i < N; i++) await abortEarly(port, p);
    await sleep(300);
    ok(old.timers.size === N, `${route}：★反向对照★ 去掉那句判断，掐 ${N} 次漏 ${N} 个定时器`, { timers: old.timers.size });
    for (const t of old.timers) clearInterval(t);
    srv.close();
  }

  console.log("\n【2】真 server.js：各种时机掐 30 次，25 秒心跳一个不剩");
  const dataDir = path.join(HOME, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const tok = "tk" + Date.now();
  fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify({
    users: [{ username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [tok]: { user: "boss", at: Date.now() } },
  }));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
  cfg.mcp_servers = [];
  fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify(cfg));
  // 探针：数还活着的 25 秒定时器（整个 server.js 里只有直播心跳是这个周期），每 100ms 报一次
  const probe = path.join(HOME, "hb-probe.js");
  fs.writeFileSync(probe, `"use strict";
const set0 = global.setInterval, clear0 = global.clearInterval, live = new Set();
global.setInterval = function (fn, ms, ...a) { const t = set0(fn, ms, ...a); if (ms === 25000) live.add(t); return t; };
global.clearInterval = function (t) { live.delete(t); return clear0(t); };
set0(() => process.stdout.write("PROBE hb=" + live.size + "\\n"), 100).unref();
`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "", OPENWORKBUDDY_HOME: HOME, OPENWORKBUDDY_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: "0" };
  // electron 当 node 跑这个套件时别拿它的 execPath 起 server（ELECTRON_RUN_AS_NODE 清空了会起一个 Electron 应用）
  const nodeBin = process.env.OWB_NODE || (process.versions.electron ? "node" : process.execPath);
  const child = spawn(nodeBin, ["-r", probe, entry("server")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });
  let log = "", hb = -1;
  const eat = (c) => {
    log = (log + c).slice(-20000);
    const m = String(c).match(/PROBE hb=(\d+)/g);
    if (m) hb = Number(m[m.length - 1].split("=")[1]);
  };
  child.stdout.on("data", eat);
  child.stderr.on("data", eat);
  let port = 0;
  for (let i = 0; i < 300 && !port; i++) { const m = /已启动: http:\/\/localhost:(\d+)/.exec(log); if (m) port = +m[1]; else await sleep(200); }
  if (!port) { ok(false, "server.js 起来了", log.slice(-1500)); } else {
    const until = async (want, ms = 3000) => { const t0 = Date.now(); while (hb !== want && Date.now() - t0 < ms) await sleep(50); return hb; };
    const cookie = "openworkbuddy_token=" + tok;
    const LIVE = "/api/chat/live?subs=";
    ok(await until(0) === 0, "起来之后一条直播都没有：探针数到 0", hb);
    const rq = await hold(port, LIVE, { Cookie: cookie });
    ok(rq && await until(1) === 1, "★反向对照★ 一条正常连着的直播：探针数到 1（看得见心跳，0 不是没数到）", hb);
    if (rq) rq.destroy();
    ok(await until(0) === 0, "  └ 断开后回到 0", hb);
    // 掐的时机从「写完就掐」到「过 5ms 再掐」都来一遍：早的在中间件那段就断了，晚的已经进了处理函数，两头都得收干净
    for (let r = 0; r < 3; r++) for (const d of [0, 0, 1, 1, 2, 2, 3, 3, 4, 5]) await abortEarly(port, LIVE, `Cookie: ${cookie}\r\n`, d);
    await sleep(1200);
    ok(await until(0, 2000) === 0, "各种时机掐 30 次之后：一个心跳定时器都不剩", hb);
  }
  // 等它真退了再走：临时家是在退出时删的，server 还活着就可能边删边往里写
  if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await gone;
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
