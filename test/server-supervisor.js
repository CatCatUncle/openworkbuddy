// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 独立服务进程的看护（server-supervisor.js）：退回主进程之前，不要的那个得先真退掉。
 *
 * 跑法：node test/server-supervisor.js（假的子进程，不起 Electron；只在 127.0.0.1 上占一个随机口）
 *
 * 2026-09-29 复审：READY_MS 内没报端口 ≠ 永远不监听。慢机器上服务进程可能正好在超时那一刻 listen 上、
 * 「我在听了」那句晚到一步。以前 retire() 发完 shutdown 就走，主进程紧接着在同一个 PORT 上起自己那份，
 * 两边抢一个口：主进程撞上 EADDRINUSE，按「口上是另一台」连过去，连的正是 1.5 秒后就被杀掉的那一个。
 *
 * 每组带 ★反向对照★：把 bring() 里的 `await retireAndWait()` 换回改之前的 `retire()`，同一个场景下
 * 主进程那一 listen 就撞上 EADDRINUSE——证明「等它退」这一步真在起作用，不是场景本身就撞不上。
 */
const fs = require("fs");
const net = require("net");
const path = require("path");
const Module = require("module");
const { EventEmitter } = require("events");
const { mod } = require("./lib/mod");

const SUP = mod("server-supervisor");

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 同一份源码换几处再装进来（反向对照用）；要换的那句不在就当场报错，免得对照变成空跑 */
function loadVariant(pairs) {
  let src = fs.readFileSync(SUP, "utf8");
  for (const [from, to] of pairs) {
    if (!src.includes(from)) throw new Error("反向对照要换的那句不在源码里了：" + from);
    src = src.split(from).join(to);
  }
  const m = new Module(SUP, module);
  m.filename = SUP;
  m.paths = /** @type {any} */ (Module)._nodeModulePaths(path.dirname(SUP));
  /** @type {any} */ (m)._compile(src, SUP);
  return m.exports;
}
const REAL = require(SUP);
const OLD = loadVariant([["await retireAndWait();", "retire();"]]);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => resolve(p)); });
  });
}
/** 主进程退回后那一下 listen：成了返回 "ok"，撞上返回错误码 */
function tryListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(/** @type {any} */ (e).code || String(e)));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve("ok")));
  });
}

/**
 * 假的服务进程。
 *   listenAt：起来多少毫秒后占住 port（「我在听了」那句不发——模拟晚到）
 *   shutdownMs：收到 ctl shutdown 以后多久收完、放口、退出；null = 不理 shutdown（卡死）
 *   killMs：kill() 以后多久退出；null = kill 也不管用
 *   bootFail：起来就报 boot 失败（m.t === "boot", ok:false），然后等着被收
 */
let nextPid = 900000;
function fakeFork(o, made) {
  return () => {
    const c = /** @type {any} */ (new EventEmitter());
    c.pid = ++nextPid;
    c.stdout = null; c.stderr = null;
    c.exited = false;
    c.srv = null;
    const timers = [];
    const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); };
    const die = (code) => {
      if (c.exited) return;
      c.exited = true;
      timers.forEach(clearTimeout);
      const done = () => { c.exitAt = Date.now(); c.emit("exit", code); };
      if (c.srv) { const s = c.srv; c.srv = null; s.close(done); } else done();
    };
    c.postMessage = (m) => {
      if (c.exited) throw new Error("进程已经退了");
      if (m && m.t === "ctl" && m.op === "shutdown") { c.gotShutdown = true; if (o.shutdownMs != null) later(o.shutdownMs, () => die(0)); }
    };
    c.kill = () => { c.killed = (c.killed || 0) + 1; if (o.killMs != null) later(o.killMs, () => die(null)); };
    made.push(c);
    setImmediate(() => {
      c.emit("spawn");
      if (o.bootFail) c.emit("message", { t: "boot", ok: false, error: { message: "假的：配置读不出来" } });
      if (o.listenAt != null) later(o.listenAt, () => { const s = net.createServer(); s.listen(o.port, "127.0.0.1"); c.srv = s; });
    });
    return c;
  };
}

function supervise(mod, o) {
  const made = [];
  const logs = [];
  const sup = mod.createServerSupervisor({
    fork: fakeFork(o, made),
    env: () => ({}),
    shell: { handle: () => false, reset: () => {} },
    log: (l) => logs.push(l),
    readyMs: o.readyMs,
    nice: 0,
  });
  return { sup, made, logs };
}

(async () => {
  console.log("\n① 超时退回：不要的那个正好在超时那一刻占住了口");
  {
    const port = await freePort();
    // 250ms 时它 listen 上了（「我在听了」没来得及发），300ms 超时；收到 shutdown 要 400ms 才收完放口
    const o = { port, readyMs: 300, listenAt: 250, shutdownMs: 400, killMs: 10 };
    const { sup, made, logs } = supervise(REAL, o);
    const t0 = Date.now();
    const r = await sup.start();
    const ms = Date.now() - t0;
    const c = made[0];
    ok(r === null && /秒内没开始监听端口/.test(sup.fellBack), `超时照常退回主进程（${ms}ms）`, { r, fellBack: sup.fellBack });
    ok(c && c.gotShutdown && c.exited && c.exitAt <= Date.now(), "start() 交回来的时候，不要的那个已经收到 shutdown、真退了", { gotShutdown: c && c.gotShutdown, exited: c && c.exited });
    const got = await tryListen(port);
    ok(got === "ok", `★紧接着主进程在同一个口 ${port} 上 listen：成了★ 没跟退下去的那个抢`, got);
    ok(ms >= 650 && ms < 2500, `等的是它真退的那一刻（300ms 超时 + 约 400ms 收尾），不是死等满 2 秒`, ms);
    ok(logs.some((l) => /已改回在主进程里运行/.test(l)) && !logs.some((l) => /还没退，照样改回主进程/.test(l)), "日志照旧一行「已改回在主进程里运行」，没有多出「还没退」", logs);

    const port2 = await freePort();
    const { sup: sup2, made: made2 } = supervise(OLD, { ...o, port: port2 });
    const r2 = await sup2.start();
    const got2 = await tryListen(port2);
    ok(r2 === null && got2 === "EADDRINUSE", `★反向对照★ 改之前（retire() 发完就走）：同一个场景主进程 listen 撞上 ${got2}`, { got2, exited: made2[0] && made2[0].exited });
    await sleep(600);
    ok(made2[0] && made2[0].exited, "（反向对照那个过一会儿自己退了：撞口就撞在这段空档里）");
  }

  console.log("\n② 不理 shutdown 的（卡死）：retire 1.5 秒硬杀，等到它退再退回");
  {
    const port = await freePort();
    const o = { port, readyMs: 200, listenAt: 150, shutdownMs: null, killMs: 30 };
    const { sup, made } = supervise(REAL, o);
    const t0 = Date.now();
    await sup.start();
    const ms = Date.now() - t0;
    const c = made[0];
    ok(c && c.killed >= 1 && c.exited, `被硬杀了、真退了（${ms}ms）`, { killed: c && c.killed, exited: c && c.exited });
    ok(ms >= 1600 && ms < 2600, "等的是 retire 那一下硬杀（约 1.5 秒），没多等", ms);
    ok((await tryListen(port)) === "ok", "主进程接着 listen 同一个口：成了");
  }

  console.log("\n③ 连 kill 都不管用的：不许一直等，2.5 秒后照样退回，日志如实写");
  {
    const port = await freePort();
    const o = { port, readyMs: 100, listenAt: null, shutdownMs: null, killMs: null };
    const { sup, made, logs } = supervise(REAL, o);
    const t0 = Date.now();
    const r = await Promise.race([sup.start(), sleep(6000).then(() => "hang")]);
    const ms = Date.now() - t0;
    ok(r === null && ms < 3500, `没卡住：${ms}ms 后照样退回主进程`, { r, ms });
    ok(made[0] && made[0].killed >= 2, "retire 那一下之后按 pid 又杀了一次", made[0] && made[0].killed);
    ok(logs.some((l) => new RegExp(`pid ${made[0].pid}）2500ms 还没退，照样改回主进程`).test(l)), "日志一行写明哪个 pid、等了多久还没退（只写看到的，不猜原因）", logs);
  }

  console.log("\n④ 起来就报错（boot ok:false）：同样等它退");
  {
    const port = await freePort();
    const o = { port, readyMs: 5000, listenAt: null, bootFail: true, shutdownMs: 200, killMs: 10 };
    const { sup, made } = supervise(REAL, o);
    const t0 = Date.now();
    const r = await sup.start();
    const ms = Date.now() - t0;
    ok(r === null && /启动报错：假的：配置读不出来/.test(sup.fellBack), "退回的原因写的是它自己报的那句", sup.fellBack);
    ok(made[0] && made[0].exited && ms >= 180 && ms < 1500, `交回来时它已经退了（${ms}ms，没等满 READY_MS）`, { ms, exited: made[0] && made[0].exited });
  }

  console.log("\n⑤ 正常起来的不受影响");
  {
    const made = [];
    const sup = REAL.createServerSupervisor({
      fork: () => {
        const c = /** @type {any} */ (new EventEmitter());
        c.pid = ++nextPid; c.postMessage = () => {}; c.kill = () => {};
        made.push(c);
        setImmediate(() => { c.emit("spawn"); c.emit("message", { t: "listening", port: 45678, reused: false }); });
        return c;
      },
      env: () => ({}), shell: { handle: () => false, reset: () => {} }, log: () => {}, readyMs: 3000, nice: 0,
    });
    const t0 = Date.now();
    const r = await sup.start();
    ok(r && r.port === 45678 && Date.now() - t0 < 200 && sup.fellBack === "", "报了端口就用它，不多等一毫秒", { r, ms: Date.now() - t0 });
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
