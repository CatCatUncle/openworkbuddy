// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 资料库封面与正文摘录（lib-cover.js + routes/library.js）：
 *
 *   ① 第二次问同一张：直接给地址，渲染器 0 次
 *   ② 文件改了（mtime 或体积）：重新出
 *   ③ 同时最多一件：十个文件、两个账号一起问，渲染器手上从没有过两件
 *   ④ 租约：5 秒没人续的活在开工前扔掉；续了的照干
 *   ⑤ 有任务在跑：两件之间空 ≥800ms，两次开工隔 ≥2 秒
 *   ⑥ 事件循环卡了（p95 > 50ms）整条队停 2 秒；监视器只在队里有活时开着
 *   ⑦ 渲染器明确报错落 .fail，同一版不再试；改了文件才重来；超时只记在内存里
 *   ⑧ 子进程带 nice 10、到点被杀（假 spawn）；队列这头到点叫停、下一件照常
 *   ⑨ 不是 macOS：Office / PDF 直接给图标，一个子进程都不起
 *   ⑩ ..、绝对路径、指到根外面的链接，一律拒
 *   ⑪ A 账号拿不到 B 账号的封面
 *   ⑫ 摘录只读前 16KB、二进制不给、一批最多 40 条
 *
 * 为什么这么较真：一个用了一个月的账号，工作区里 285 个 html、上百个 PDF。一屏滚过去要是每张都
 * 起一个 qlmanage / 开一个离屏窗口，后台就是几百个子进程跟 agent 抢 CPU——这套测试钉的就是「只出
 * 有人在看的、一次只出一张、机器忙就让」。
 *
 * 渲染器、时钟、「有没有任务在跑」、事件循环监视器全是注进去的假货；真起的 server.js 只用来查
 * 路径安全、账号隔离、接口形状。不联网、不花钱、不起 Electron。
 *   node test/library-cover.js
 */
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");
const HOME = require("./lib/own-home")("library-cover");

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const cp = require("child_process");
const { EventEmitter } = require("events");
const ROOT = path.join(__dirname, "..");
const libCover = require(mod("lib-cover"));
const retention = require(mod("retention"));

let pass = 0, fail = 0, finished = false;
// 队列自己的定时器全是 unref 的（常驻服务里不该因为它们拖着不退）。测试进程里没别的东西撑着事件循环，
// 渲染器一卡死、只剩这些定时器，进程就会半路自己退出——这里挂一个撑着，收尾时撤掉
const keepAlive = setInterval(() => {}, 1 << 30);
/** @type {import("child_process").ChildProcess | null} */
let serverChild = null;
process.on("exit", (code) => {
  try { if (serverChild && serverChild.exitCode === null) serverChild.kill("SIGKILL"); } catch {}
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 400) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 4).join(" | ")}`); }
}
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1×1 的 PNG：假渲染器交出去的「封面」
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// ---------------------------------------------------------------------------------------------
// 夹具：假时钟、假监视器、假渲染器
// ---------------------------------------------------------------------------------------------
const U = path.join(HOME, "unit");
const ROOT_A = path.join(U, "甲的资料库");
const ROOT_B = path.join(U, "乙的资料库");
let seq = 0;
const fresh = (tag) => { const d = path.join(U, `${tag}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
function put(root, rel, body = "x") {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return f;
}
/** 把 mtime 拨到一个固定时刻：两个账号的同名文件要「同 mtime、同体积」才证得了键里带着根 */
function pinTime(file, iso = "2026-09-01T08:00:00Z") { const t = new Date(iso); fs.utimesSync(file, t, t); return file; }

/** 假时钟：sleep 不真等，直接把时间拨过去——间隔量出来是精确的，整段测试零等待 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    sleep: async (ms) => { t += Math.max(0, ms); await null; },
  };
}
/** 假的事件循环监视器：p95 想要多少给多少；reset 跟真的一样把读数清零 */
function fakeLag(p95 = 0) {
  const m = { value: p95, on: false, enables: 0, disables: 0, resets: 0, seenOnDuringRender: [] };
  return Object.assign(m, {
    enable() { m.on = true; m.enables++; },
    disable() { m.on = false; m.disables++; },
    p95Ms() { return m.value; },
    reset() { m.resets++; m.value = 0; },
  });
}
/**
 * 假渲染器：记下每次调用、自己数手上同时有几件。impl 不给就「花 ms 毫秒（假时钟上）、交一张 PNG」。
 * 每件都真让出一次事件循环：真有并发的话，别的活就是在这一刻插进来的。
 */
function fakeRenderers(clock, { ms = 150, impl = null } = {}) {
  const calls = [];
  const st = { inflight: 0, maxInflight: 0 };
  const make = (lane) => async (abs, o) => {
    calls.push({ lane, abs, o });
    st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
    try {
      await new Promise((r) => setImmediate(r));
      if (impl) return await impl(abs, o, lane);
      if (clock) clock.advance(ms);
      return PNG;
    } finally { st.inflight--; }
  };
  return { renderers: { office: make("office"), video: make("video"), html: make("html"), shrink: async (b) => b }, calls, st };
}
function mkQueue({ clock = fakeClock(), lag = fakeLag(), fr = null, opt = {} } = {}) {
  const r = fr || fakeRenderers(clock);
  const cacheDir = fresh("thumbs");
  const logs = [];
  const q = libCover.createCoverQueue({
    cacheDir, renderers: r.renderers, platform: "darwin", htmlBackend: () => "electron", hasFfmpeg: async () => true,
    busy: () => false, now: clock.now, sleep: clock.sleep, lagMonitor: lag, log: (m) => logs.push(m), ...opt,
  });
  return { q, clock, lag, fr: r, cacheDir, logs };
}
/** ask 要的那一份：跟 routes/library.js 递进来的一样（abs 是 realpath 过的） */
function item(abs, { w = 320, userRoot = ROOT_A, src = "lib" } = {}) {
  const real = fs.realpathSync(abs);
  return { userRoot, src, rel: path.relative(userRoot, abs).split(path.sep).join("/"), abs: real, st: fs.statSync(real), w, root: userRoot };
}
const kindOf = (a) => ("ready" in a ? "ready" : "queued" in a ? "queued" : "icon");

// ---------------------------------------------------------------------------------------------
// 假 spawn：把 child_process 整个换掉，数子进程、记下怎么被杀的
// ---------------------------------------------------------------------------------------------
/**
 * 装上之后 child_process 的 spawn / execFile / exec / fork 和同步那几个都不真起进程：
 * spawn 出来的是一个永远不自己退的假孩子，只有被 kill（或者 spawn 选项里的 timeout / signal 到点）才退。
 * process.kill 只拦假孩子的 pid（含进程组的负数）；别的 pid 原样放行——这里绝不能对真进程组发信号。
 * @param {{ exitAfterMs?: number }} [o] exitAfterMs：假孩子这么久之后自己以 0 退出（反向对照用）
 */
function installFakeSpawn(o = {}) {
  const calls = [], kills = [], prios = [];
  const kids = new Map();
  let nextPid = 5_000_000; // 比 Linux 的 pid 上限（2^22）还大：假孩子的号绝不会撞上真进程
  const saved = {};
  const names = ["spawn", "execFile", "exec", "fork", "spawnSync", "execFileSync", "execSync"];
  for (const n of names) saved[n] = cp[n];
  const savedKill = process.kill;
  const os = require("os");
  const savedPrio = os.setPriority;

  function makeKid(cmd, args, opts, cb) {
    const kid = new EventEmitter();
    const pid = ++nextPid;
    Object.assign(kid, {
      pid, exitCode: null, signalCode: null, killed: false,
      stdout: Object.assign(new EventEmitter(), { setEncoding() {}, pipe() {}, resume() {}, destroy() {} }),
      stderr: Object.assign(new EventEmitter(), { setEncoding() {}, pipe() {}, resume() {}, destroy() {} }),
      stdin: Object.assign(new EventEmitter(), { write() { return true; }, end() {}, destroy() {} }),
      unref() {}, ref() {},
    });
    const die = (code, sig) => {
      if (kid.exitCode !== null || kid.signalCode) return;
      kid.exitCode = code; kid.signalCode = sig; kid.killed = !!sig;
      setImmediate(() => {
        kid.emit("exit", code, sig); kid.emit("close", code, sig);
        if (cb) cb(sig ? Object.assign(new Error("killed"), { killed: true, signal: sig, code: null }) : null, "", "");
      });
    };
    kid.kill = (sig = "SIGTERM") => { kills.push({ pid, sig, via: "child.kill" }); die(null, sig); return true; };
    kids.set(pid, { kid, die });
    const opt = opts || {};
    if (opt.timeout > 0) setTimeout(() => { if (kid.exitCode === null && !kid.signalCode) { kills.push({ pid, sig: opt.killSignal || "SIGTERM", via: "timeout" }); die(null, opt.killSignal || "SIGTERM"); } }, opt.timeout).unref();
    if (opt.signal) opt.signal.addEventListener("abort", () => { kills.push({ pid, sig: opt.killSignal || "SIGTERM", via: "signal" }); die(null, opt.killSignal || "SIGTERM"); }, { once: true });
    if (o.exitAfterMs != null) setTimeout(() => die(0, null), o.exitAfterMs).unref();
    return kid;
  }
  const argsOf = (a, b) => (Array.isArray(a) ? { args: a, opts: b } : { args: [], opts: a });
  cp.spawn = (cmd, a, b) => { const { args, opts } = argsOf(a, b); calls.push({ fn: "spawn", cmd, args, opts }); return makeKid(cmd, args, opts); };
  cp.execFile = (cmd, a, b, c) => {
    const cb = [a, b, c].find((x) => typeof x === "function");
    const { args, opts } = argsOf(typeof a === "function" ? undefined : a, typeof b === "function" ? undefined : b);
    calls.push({ fn: "execFile", cmd, args, opts });
    return makeKid(cmd, args, opts, cb);
  };
  cp.exec = (cmd, a, b) => { const cb = [a, b].find((x) => typeof x === "function"); calls.push({ fn: "exec", cmd, args: [], opts: typeof a === "object" ? a : {} }); return makeKid(cmd, [], typeof a === "object" ? a : {}, cb); };
  cp.fork = (mod, a, b) => { calls.push({ fn: "fork", cmd: mod, args: Array.isArray(a) ? a : [], opts: b }); return makeKid(mod, [], b); };
  for (const n of ["spawnSync", "execFileSync", "execSync"]) {
    cp[n] = (cmd, a) => { calls.push({ fn: n, cmd, args: Array.isArray(a) ? a : [] }); const e = new Error("测试里不许同步起子进程"); throw e; };
  }
  process.kill = /** @type {any} */ ((pid, sig) => {
    const hit = kids.get(Math.abs(Number(pid)));
    if (hit) { kills.push({ pid: Math.abs(Number(pid)), sig: sig || "SIGTERM", via: Number(pid) < 0 ? "process.kill(-pgid)" : "process.kill" }); hit.die(null, sig || "SIGTERM"); return true; }
    return savedKill.call(process, pid, sig);
  });
  os.setPriority = (pid, prio) => {
    if (kids.has(Number(pid))) { prios.push({ pid, prio }); return; }
    return savedPrio.call(os, pid, prio);
  };
  return {
    calls, kills, prios,
    restore() {
      for (const n of names) cp[n] = saved[n];
      process.kill = savedKill;
      os.setPriority = savedPrio;
    },
  };
}
/** 这一趟子进程是不是降到了 nice 10：包一层 nice -n 10，或者起来之后 setPriority(pid, 10) */
function niced(call, prios) {
  const base = path.basename(String(call.cmd || ""));
  const a = (call.args || []).map(String);
  if (base === "nice") return (a[0] === "-n" && a[1] === "10") || a[0] === "-n10" || a[0] === "-10";
  if (call.fn === "exec" && /^nice\s+(-n\s*10|-10)\s/.test(String(call.cmd))) return true;
  return prios.some((p) => p.prio === 10);
}

// ---------------------------------------------------------------------------------------------
(async () => {
  const pdfA = put(ROOT_A, "合同/一号.pdf", "%PDF-1.4 假的");
  const pdfA2 = put(ROOT_A, "合同/二号.pdf", "%PDF-1.4 假的二号");

  await section("① 第二次问同一张：直接给地址，渲染器 0 次", async () => {
    const { q, fr, cacheDir } = mkQueue();
    const it = item(pdfA);
    eq(kindOf(await q.ask(it)), "queued", "头一次：排队");
    await q.idle();
    eq(fr.calls.length, 1, "出了一张");
    const a2 = await q.ask(it);
    eq(kindOf(a2), "ready", "第二次：直接给地址");
    eq(fr.calls.length, 1, "渲染器没再被叫（还是 1 次）");
    ok(/^\/api\/library\/cover\?src=lib&path=[^&]+&w=320&v=[^&]+$/.test(a2.ready || ""), "地址是 /api/library/cover?src&path&w&v，v 是这一版的 mtime-体积", a2.ready);
    ok(String(a2.ready).endsWith("&v=" + encodeURIComponent(libCover.coverVersion(it.st))), "v 对得上 coverVersion(stat)", a2.ready);
    const onDisk = fs.readdirSync(cacheDir).filter((n) => !n.endsWith(".part"));
    ok(onDisk.length === 1 && /^cover-[0-9a-f]{40}\.png$/.test(onDisk[0]) && retention.COVER_RE.test(onDisk[0]),
      "盘上一张 cover-<sha1>.png，retention.js 的封面规则认得它", onDisk);
    ok(fs.readFileSync(path.join(cacheDir, onDisk[0])).equals(PNG), "落盘的就是渲染器交出来的那张");
    ok(!fs.readdirSync(cacheDir).some((n) => n.endsWith(".part")), "没留临时文件");
    // ★反向对照★ 换个宽度就是另一张：证明上面的「ready」不是不管问什么都回
    eq(kindOf(await q.ask(item(pdfA, { w: 160 }))), "queued", "★反向对照★ 同一个文件要 160 宽：排队（缓存按宽度分）");
    await q.idle();
    eq(fr.calls.length, 2, "★反向对照★ 渲染器被叫了第 2 次");
    eq(fr.calls[1].o.target, 320, "160 的框按两倍出 320（高分屏）");
    eq(fr.calls[0].o.target, 640, "320 的框出 640（封顶 640）");
  });

  await section("② 文件改了（mtime 或体积）：重新出", async () => {
    const { q, fr } = mkQueue();
    const f = put(ROOT_A, "改过/报价.pdf", "%PDF 第一版");
    pinTime(f, "2026-09-01T08:00:00Z");
    await q.ask(item(f)); await q.idle();
    eq(kindOf(await q.ask(item(f))), "ready", "没改：命中");
    eq(fr.calls.length, 1, "没改：渲染器 1 次");
    pinTime(f, "2026-09-02T08:00:00Z");
    eq(kindOf(await q.ask(item(f))), "queued", "只改 mtime：重新排队");
    await q.idle();
    eq(fr.calls.length, 2, "只改 mtime：渲染器第 2 次");
    fs.appendFileSync(f, "多一行"); pinTime(f, "2026-09-02T08:00:00Z"); // mtime 拨回原样，只有体积变了
    eq(kindOf(await q.ask(item(f))), "queued", "只改体积（mtime 一样）：重新排队");
    await q.idle();
    eq(fr.calls.length, 3, "只改体积：渲染器第 3 次");
    // ★反向对照★ 什么都没动：命中，不再出
    eq(kindOf(await q.ask(item(f))), "ready", "★反向对照★ 什么都没动：命中");
    eq(fr.calls.length, 3, "★反向对照★ 渲染器还是 3 次");

    // 排着队的时候文件被改了：开工前复核一眼，按老版本出的那张不落盘
    let release; const gate = new Promise((r) => (release = r));
    const slow = fakeRenderers(null, { impl: async () => { await gate; return PNG; } });
    const { q: q3, fr: fr3 } = mkQueue({ fr: slow });
    const g1 = put(ROOT_A, "改过/占位.pdf", "%PDF 占位");
    const g2 = put(ROOT_A, "改过/排队时被改.pdf", "%PDF 旧");
    await q3.ask(item(g1));
    await q3.ask(item(g2));
    fs.writeFileSync(g2, "%PDF 新的一版，长了"); // 还在队里，文件变了
    release(); await q3.idle();
    eq(fr3.calls.length, 1, "排队时被改的那件：开工前发现不是那一版，不出（等前端按新版本再问）");
  });

  await section("③ 同时最多一件：十个文件、两个账号一起问", async () => {
    const clock = fakeClock();
    const fr = fakeRenderers(clock, { impl: async () => { await realSleep(2 + Math.random() * 6); return PNG; } });
    const { q } = mkQueue({ clock, fr });
    const asks = [];
    for (let i = 0; i < 5; i++) {
      asks.push(q.ask(item(put(ROOT_A, `并发/甲${i}.pdf`, "%PDF " + i))));
      asks.push(q.ask(item(put(ROOT_B, `并发/乙${i}.docx`, "PK " + i), { userRoot: ROOT_B })));
    }
    const got = await Promise.all(asks);
    ok(got.every((a) => kindOf(a) === "queued"), "十件都排上了", got.map(kindOf));
    await q.idle();
    eq(fr.calls.length, 10, "十件都出了");
    eq(fr.st.maxInflight, 1, "渲染器这头数的：同时最多 1 件");
    eq(q.stats.maxInflight, 1, "队列自己数的：同时最多 1 件");
    // ★反向对照★ 同一个计数器，两件真并发地叫：数得出 2——证明上面的 1 不是计数器瞎了
    const probe = fakeRenderers(null, { impl: async () => { await realSleep(5); return PNG; } });
    await Promise.all([probe.renderers.office("x", {}), probe.renderers.office("y", {})]);
    eq(probe.st.maxInflight, 2, "★反向对照★ 绕开队列直接并发叫：计数器数出 2");
  });

  await section("④ 租约：5 秒没人续，开工前扔掉；续了的照干", async () => {
    // 甲在渲染时，乙在队里等。甲花了 6 秒（假时钟），乙的租约（5 秒）在它开工前就过了
    {
      const clock = fakeClock();
      let release; const hold = new Promise((r) => (release = r));
      const fr = fakeRenderers(clock, { impl: async (abs) => { if (abs.endsWith("一号.pdf")) { await hold; clock.advance(6000); } return PNG; } });
      const { q } = mkQueue({ clock, fr });
      await q.ask(item(pdfA));
      eq(kindOf(await q.ask(item(pdfA2))), "queued", "乙排上了");
      release(); await q.idle();
      eq(fr.calls.length, 1, "只出了甲；乙没开工");
      eq(q.stats.dropped, 1, "乙是因为租约过了被扔的（dropped=1）");
      eq(q.queue.size, 0, "队里不留尸体");
      eq(kindOf(await q.ask(item(pdfA2))), "queued", "前端要是还看着它、再问一次：重新排上");
    }
    // ★反向对照★ 同样 6 秒，但第 4 秒前端又报了一遍乙（续租到第 9 秒）：乙照干
    {
      const clock = fakeClock();
      let release; const hold = new Promise((r) => (release = r));
      let q;
      const fr = fakeRenderers(clock, {
        impl: async (abs) => {
          if (abs.endsWith("一号.pdf")) { await hold; clock.advance(4000); await q.ask(item(pdfA2)); clock.advance(2000); }
          return PNG;
        },
      });
      ({ q } = mkQueue({ clock, fr }));
      await q.ask(item(pdfA));
      await q.ask(item(pdfA2));
      release(); await q.idle();
      eq(fr.calls.length, 2, "★反向对照★ 第 4 秒续过租：乙也出了");
      eq(q.stats.dropped, 0, "★反向对照★ 一件都没扔");
      eq(libCover.LEASE_MS, 5000, "租约就是 5 秒");
    }
  });

  await section("⑤ 有任务在跑：两件之间空 ≥800ms，两次开工隔 ≥2 秒", async () => {
    const run = async (busy) => {
      const clock = fakeClock();
      const fr = fakeRenderers(clock, { ms: 150 });
      const items = [];
      let q;
      // 让路的这几秒里前端还看着这几张：每等一回就把它们再报一遍（真前端是每 1.5 秒一趟），租约才续得上
      const sleep = async (ms) => { clock.advance(ms); for (const it of items) await q.ask(it); };
      ({ q } = mkQueue({ clock, fr, opt: { busy: () => busy, sleep } }));
      for (let i = 0; i < 4; i++) items.push(item(put(ROOT_A, `让路/${busy ? "忙" : "闲"}${i}.pdf`, "%PDF " + i)));
      for (const it of items) await q.ask(it);
      await q.idle();
      const s = q.stats.starts, e = q.stats.ends;
      const idleGaps = s.slice(1).map((t, i) => t - e[i]);
      const startGaps = s.slice(1).map((t, i) => t - s[i]);
      return { n: fr.calls.length, idleGaps, startGaps, busyWaits: q.stats.busyWaits };
    };
    const busy = await run(true);
    eq(busy.n, 4, "四件都出了");
    ok(busy.idleGaps.length === 3 && busy.idleGaps.every((g) => g >= libCover.BUSY_GAP_MS), `收尾到下一件开工：每段 ≥${libCover.BUSY_GAP_MS}ms`, busy.idleGaps);
    ok(busy.startGaps.every((g) => g >= libCover.BUSY_START_GAP_MS), `两次开工：每段 ≥${libCover.BUSY_START_GAP_MS}ms（一件 150ms 的活也不许连着来）`, busy.startGaps);
    ok(busy.busyWaits >= 3, "等过 3 回以上", busy.busyWaits);
    // ★反向对照★ 没任务在跑：一件接一件，中间不空
    const calm = await run(false);
    eq(calm.n, 4, "★反向对照★ 四件都出了");
    ok(calm.idleGaps.every((g) => g === 0), "★反向对照★ 没任务在跑：收尾就开下一件（间隔 0）", calm.idleGaps);
    eq(calm.busyWaits, 0, "★反向对照★ 一回都没等");
  });

  await section("⑥ 事件循环卡了：整条队停 2 秒；监视器只在队里有活时开着", async () => {
    {
      const clock = fakeClock();
      const lag = fakeLag(0);
      const fr = fakeRenderers(clock, { impl: async () => { lag.seenOnDuringRender.push(lag.on); clock.advance(100); return PNG; } });
      const { q } = mkQueue({ clock, lag, fr });
      eq(lag.enables, 0, "建好队、还没人问：监视器没开");
      lag.value = 80; // 开工前就卡着
      const t0 = clock.now();
      await q.ask(item(pdfA));
      await q.idle();
      eq(q.stats.pauses, 1, "p95=80ms > 50：停了一次");
      ok(q.stats.starts[0] - t0 >= libCover.LAG_PAUSE_MS, `停满 ${libCover.LAG_PAUSE_MS}ms 才开工`, { waited: q.stats.starts[0] - t0 });
      ok(lag.seenOnDuringRender.length === 1 && lag.seenOnDuringRender[0] === true, "干活的时候监视器开着");
      eq(lag.on, false, "队空了：监视器关了");
      eq(lag.enables, lag.disables, "开几次关几次");
      // ★反向对照★ p95=30ms 不到线：不停
      lag.value = 30;
      const t1 = clock.now();
      await q.ask(item(pdfA2));
      await q.idle();
      eq(q.stats.pauses, 1, "★反向对照★ p95=30ms：没再停（还是 1 次）");
      eq(q.stats.starts[1] - t1, 0, "★反向对照★ 当场开工");
    }
    // 真的 perf_hooks 监视器、真的时钟：第一件活把主线程连着卡 8 回、每回 70ms，第二件就得等满 2 秒。
    // 只卡一回是不够的——一件活几秒钟有几百个 10ms 的采样点，偶尔一顿压不过 p95；要的就是「持续地卡」才让路
    const block = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* 硬卡主线程 */ } };
    const realRun = async (stall) => {
      const fr = fakeRenderers(null, {
        impl: async (abs) => {
          if (stall && abs.endsWith("一号.pdf")) for (let i = 0; i < 8; i++) { await realSleep(1); block(70); }
          await realSleep(15);
          return PNG;
        },
      });
      const q = libCover.createCoverQueue({ cacheDir: fresh("thumbs"), renderers: fr.renderers, platform: "darwin", lagMonitor: libCover.defaultLagMonitor(), log: () => {} });
      await q.ask(item(pdfA));
      await q.ask(item(pdfA2));
      await q.idle();
      return { pauses: q.stats.pauses, gap: q.stats.starts[1] - q.stats.ends[0], n: fr.calls.length };
    };
    const stalled = await realRun(true);
    eq(stalled.pauses, 1, "真监视器：第一件持续卡主线程，第二件开工前停了一次");
    ok(stalled.gap >= libCover.LAG_PAUSE_MS - 20 && stalled.n === 2, `真监视器：两件之间空了 ${stalled.gap}ms（≥${libCover.LAG_PAUSE_MS}），第二件照样出了`, stalled);
    const calm = await realRun(false);
    eq(calm.pauses, 0, "★反向对照★ 真监视器：不卡就不停");
    ok(calm.gap < 500 && calm.n === 2, `★反向对照★ 两件几乎挨着（${calm.gap}ms）`, calm);
  });

  await section("⑦ 明确报错落 .fail、不再试；改了文件才重来；超时只记在内存里", async () => {
    const f = put(ROOT_A, "坏的/烂文件.pdf", "%PDF 坏的");
    pinTime(f, "2026-09-03T08:00:00Z");
    const broken = fakeRenderers(null, { impl: async () => { throw new Error("文件结构坏了"); } });
    const { q, cacheDir, fr } = mkQueue({ fr: broken });
    await q.ask(item(f)); await q.idle();
    const fails = fs.readdirSync(cacheDir).filter((n) => n.endsWith(".fail"));
    ok(fails.length === 1 && retention.COVER_RE.test(fails[0]), "落了一个 cover-<sha1>.fail（retention.js 认得、30 天后清）", fails);
    eq(kindOf(await q.ask(item(f))), "icon", "再问：直接给图标");
    eq(fr.calls.length, 1, "没再试（渲染器还是 1 次）");
    const q2 = libCover.createCoverQueue({ cacheDir, renderers: broken.renderers, platform: "darwin", now: fakeClock().now, sleep: fakeClock().sleep, lagMonitor: fakeLag(), log: () => {} });
    eq(kindOf(await q2.ask(item(f))), "icon", "重启之后（新的队、同一个缓存目录）：.fail 还认，照样图标");
    pinTime(f, "2026-09-04T08:00:00Z");
    eq(kindOf(await q.ask(item(f))), "queued", "文件改了（mtime）：重来");
    await q.idle();
    eq(fr.calls.length, 2, "重来了一次");

    // ★反向对照★ 超时：不落 .fail，只记在内存；重启就再试
    for (const [label, err] of [
      ["截图超时（SHOT_TIMEOUT）", Object.assign(new Error("截图超时：5 秒还没做完"), { code: "SHOT_TIMEOUT" })],
      ["ETIMEDOUT", Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" })],
    ]) {
      const g = put(ROOT_A, `坏的/慢${label.length}.pdf`, "%PDF 慢");
      const slow = fakeRenderers(null, { impl: async () => { throw err; } });
      const { q: qs, cacheDir: cd, fr: frs } = mkQueue({ fr: slow });
      await qs.ask(item(g)); await qs.idle();
      ok(!fs.readdirSync(cd).some((n) => n.endsWith(".fail")), `★反向对照★ ${label}：盘上没有 .fail`);
      eq(kindOf(await qs.ask(item(g))), "icon", `★反向对照★ ${label}：这一趟进程里记着，先给图标`);
      eq(frs.calls.length, 1, `★反向对照★ ${label}：没在这一趟里死磕`);
      const again = libCover.createCoverQueue({ cacheDir: cd, renderers: slow.renderers, platform: "darwin", lagMonitor: fakeLag(), log: () => {} });
      eq(kindOf(await again.ask(item(g))), "queued", `★反向对照★ ${label}：重启后再试（排队）`);
      await again.idle();
    }

    // 空结果：用满了时间的按超时算，没用满的按「出不来」
    {
      const g = put(ROOT_A, "坏的/空一.pdf", "%PDF");
      const nul = fakeRenderers(null, { impl: async () => null });
      const { q: qn, cacheDir: cd } = mkQueue({ fr: nul, opt: { timeouts: { office: 400 } } });
      await qn.ask(item(g)); await qn.idle();
      ok(fs.readdirSync(cd).some((n) => n.endsWith(".fail")), "渲染器马上交了个空：落 .fail（出不来）");
      const g2 = put(ROOT_A, "坏的/空二.pdf", "%PDF 2");
      const late = fakeRenderers(null, { impl: async () => { await realSleep(90); return null; } });
      const { q: ql, cacheDir: cd2 } = mkQueue({ fr: late, opt: { timeouts: { office: 80 } } });
      await ql.ask(item(g2)); await ql.idle();
      ok(!fs.readdirSync(cd2).some((n) => n.endsWith(".fail")) && ql.stats.timedOut === 1, "★反向对照★ 用满了时间才交空（渲染器到点自己收手）：按超时算，不落 .fail", ql.stats);
    }

    // 渲染器此刻不在（NO_RENDERER）：既不落 .fail，也不记超时；30 秒内网页直接给图标，过后再问
    {
      const clock = fakeClock();
      const h = put(ROOT_A, "网页/首页.html", "<h1>hi</h1>");
      const gone = fakeRenderers(null, { impl: async () => { throw Object.assign(new Error("网页封面只在桌面版里出"), { code: "NO_RENDERER" }); } });
      let backendAsks = 0;
      const { q: qh, cacheDir: cd } = mkQueue({ clock, fr: gone, opt: { htmlBackend: () => { backendAsks++; return "electron"; } } });
      await qh.ask(item(h)); await qh.idle();
      ok(!fs.readdirSync(cd).some((n) => n.endsWith(".fail")) && qh.stats.timedOut === 0, "NO_RENDERER：不落 .fail、不记超时", qh.stats);
      eq(kindOf(await qh.ask(item(h))), "icon", "NO_RENDERER 之后 30 秒内：网页给图标，不再去撞");
      clock.advance(31000);
      eq(kindOf(await qh.ask(item(h))), "queued", "★反向对照★ 过了 30 秒重新问后端：又排上了");
      ok(backendAsks >= 2, "★反向对照★ 后端确实被重新问过", backendAsks);
      await qh.idle();
    }
  });

  await section("⑧ 子进程带 nice 10、到点被杀；队列这头到点叫停、下一件照常", async () => {
    // 队列这头：渲染器卡死不回（也没自己收手），到 timeoutMs + 宽限 就叫停它、记超时、放下一件
    {
      const killed = [];
      const hang = fakeRenderers(null, {
        impl: (abs, o) => new Promise((resolve) => {
          if (abs.endsWith("一号.pdf")) {
            // 装作起了一个子进程：信号一到就「杀掉」它。故意不 resolve：证明队列不靠渲染器自觉
            o.signal.addEventListener("abort", () => killed.push(abs), { once: true });
            return;
          }
          resolve(PNG);
        }),
      });
      const { q, cacheDir, fr } = mkQueue({ fr: hang, opt: { timeouts: { office: 60 }, guardGraceMs: 40 } });
      const t0 = Date.now();
      await q.ask(item(pdfA));
      await q.ask(item(pdfA2));
      await q.idle();
      const took = Date.now() - t0;
      eq(killed.length, 1, "卡死的那件：到点 signal 被 abort（渲染器据此杀子进程）");
      ok(took >= 100 && took < 3000, `到 60+40ms 左右就放手了（实测 ${took}ms）`);
      eq(q.stats.timedOut, 1, "记成超时");
      ok(!fs.readdirSync(cacheDir).some((n) => n.endsWith(".fail")), "超时不落 .fail");
      eq(fr.calls.length, 2, "下一件照常出了");
      ok(fs.readdirSync(cacheDir).filter((n) => n.endsWith(".png")).length === 1, "下一件的封面落盘了");
      eq(fr.calls[0].o.timeoutMs, 60, "渲染器拿到了自己的时限（它自己先到点收手，队列的宽限只是兜底）");
    }
    // ★反向对照★ 快的渲染器：signal 从没被 abort
    {
      let aborted = 0;
      const quick = fakeRenderers(null, { impl: async (abs, o) => { o.signal.addEventListener("abort", () => aborted++); return PNG; } });
      const { q } = mkQueue({ fr: quick, opt: { timeouts: { office: 60 }, guardGraceMs: 40 } });
      await q.ask(item(pdfA)); await q.idle();
      await realSleep(150);
      eq(aborted, 0, "★反向对照★ 按时交图的：signal 从没 abort（到点那个定时器交完就撤了）");
      eq(q.stats.timedOut, 0, "★反向对照★ 不记超时");
    }
    // 真的子进程封装（ql-thumb.js / video-frame.js）：从它们留的 spawn 口子注一个假的进去，
    // 看子进程是不是 nice -n 10、一直不退的是不是到点连进程组一起被杀
    const ql = require(mod("ql-thumb"));
    const vf = require(mod("video-frame"));
    const direct = [
      ["qlThumb", "a.pdf", (f, spawn) => ql.qlThumb(f, { size: 320, timeoutMs: 200, spawn, platform: "darwin" })],
      ["videoFrame", "a.mp4", (f, spawn) => vf.videoFrame(f, { width: 320, timeoutMs: 400, spawn, platform: "darwin", ffmpeg: "ffmpeg" })],
    ];
    for (const [fn, sample, call] of direct) {
      const target = put(fresh("spawn"), sample, "假的");
      const run = async (o) => {
        const fake = installFakeSpawn(o);
        try {
          const t0 = Date.now();
          let out, err = null;
          try { out = await Promise.race([call(target, cp.spawn), realSleep(5000).then(() => "挂住了")]); } catch (e) { err = e; }
          return { out, err, took: Date.now() - t0, fake };
        } finally { fake.restore(); }
      };
      const hung = await run({});
      const c = hung.fake.calls;
      ok(c.length >= 1, `${fn}：起了子进程`, c.map((x) => x.cmd));
      ok(c.length >= 1 && niced(c[0], hung.fake.prios), `${fn}：子进程降到 nice 10`, c.slice(0, 2).map((x) => [x.cmd, ...(x.args || []).slice(0, 4)]));
      ok(hung.fake.kills.some((k) => k.sig === "SIGKILL"), `${fn}：一直不退的子进程到点被 SIGKILL`, hung.fake.kills);
      ok(hung.out !== "挂住了" && hung.took < 2000, `${fn}：到点就回来（实测 ${hung.took}ms，时限 200 / 400ms）`, { out: String(hung.out).slice(0, 40) });
      ok(!hung.err && hung.out === null, `${fn}：超时回 null，不抛`, hung.err && hung.err.message);
      // ★反向对照★ 子进程马上正常退：一次都没杀
      const quick = await run({ exitAfterMs: 5 });
      eq(quick.fake.kills.length, 0, `★反向对照★ ${fn}：子进程自己按时退了，一次都没杀`);
    }

    // 整条链：队列不注入渲染器，走 lib-cover 自己接的 qlThumb → 子进程一直不退 → 到点被杀 →
    // 这一张记成超时（内存里），不落 .fail；子进程按时退了但没出图的，才落 .fail
    const chain = async (o) => {
      const fake = installFakeSpawn(o);
      const savedPlat = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "darwin" }); // qlThumb 自己也认平台；Linux CI 上装成 macOS 才走得到 spawn
      try {
        const f = put(fresh("chain"), "报告.pdf", "%PDF 假的");
        const cacheDir = fresh("thumbs");
        const q = libCover.createCoverQueue({ cacheDir, platform: "darwin", lagMonitor: fakeLag(), timeouts: { office: 200 }, guardGraceMs: 1500, log: () => {} });
        const t0 = Date.now();
        const a = await q.ask({ userRoot: path.dirname(f), src: "lib", rel: "报告.pdf", abs: fs.realpathSync(f), st: fs.statSync(f), w: 320 });
        await q.idle();
        return { a: kindOf(a), took: Date.now() - t0, fake, stats: { ...q.stats }, fails: fs.readdirSync(cacheDir).filter((n) => n.endsWith(".fail")).length };
      } finally {
        Object.defineProperty(process, "platform", savedPlat);
        fake.restore();
      }
    };
    const hung = await chain({});
    eq(hung.a, "queued", "整条链：PDF 排上了");
    const qc = hung.fake.calls[0] || {};
    ok(path.basename(String(qc.cmd)) === "nice" && (qc.args || [])[0] === "-n" && (qc.args || [])[1] === "10" && /qlmanage$/.test(String((qc.args || [])[2])),
      "整条链：真起的是 nice -n 10 qlmanage", [qc.cmd, ...(qc.args || []).slice(0, 4)]);
    ok(hung.fake.kills.some((k) => k.sig === "SIGKILL"), "整条链：挂住的 qlmanage 到点被 SIGKILL", hung.fake.kills);
    ok(hung.stats.timedOut === 1 && hung.stats.failed === 0 && hung.fails === 0, "整条链：记成超时，不落 .fail", { stats: hung.stats, fails: hung.fails });
    ok(hung.took < 1500, `整条链：渲染器自己到点收手（${hung.took}ms），没等到队列的兜底`, hung.took);
    const quickChain = await chain({ exitAfterMs: 5 });
    eq(quickChain.fake.kills.length, 0, "★反向对照★ 整条链：qlmanage 按时退了，一次都没杀");
    ok(quickChain.stats.timedOut === 0 && quickChain.stats.failed === 1 && quickChain.fails === 1, "★反向对照★ 按时退了却没出图：这才落 .fail（同一版不再试）", { stats: quickChain.stats, fails: quickChain.fails });
  });

  await section("⑧b 服务进程退出：手上那个子进程一起带走，不留孤儿", async () => {
    // 2026-09-29 本机逮到的：测试一关服务，正在跑的 qlmanage 就成了孤儿（detached 起的），一次攒了 4 个。
    // 这里起一个小进程当「服务」：用真的 runQuiet 起一个永远不退的孙进程，孙进程一报上 pid 就 process.exit，
    // 看孙进程还在不在。不靠 qlmanage，Linux CI 上一样跑
    const dir = fresh("orphan");
    const script = path.join(dir, "服务.js");
    fs.writeFileSync(script, `
      const path = require("path"), fs = require("fs");
      const [ROOT, pidFile, file, mode] = process.argv.slice(2);
      const libCover = require(${JSON.stringify(mod("lib-cover"))});
      const ql = require(${JSON.stringify(mod("ql-thumb"))});
      const hang = "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(process.pid)); setInterval(() => {}, 1000)";
      const q = libCover.createCoverQueue({
        cacheDir: path.join(path.dirname(file), "thumbs"), platform: "darwin", timeouts: { office: 60000 }, log: () => {},
        lagMonitor: { enable() {}, disable() {}, reset() {}, p95Ms: () => 0 },
        renderers: { office: (abs, o) => ql.runQuiet(undefined, process.execPath, ["-e", hang], { timeoutMs: 60000, signal: o.signal }).then(() => null) },
      });
      q.ask({ userRoot: path.dirname(file), src: "lib", rel: path.basename(file), abs: file, st: fs.statSync(file), w: 320 });
      const t = setInterval(() => {
        let pid = ""; try { pid = fs.readFileSync(pidFile, "utf8"); } catch {}
        if (!pid) return;
        clearInterval(t);
        if (mode === "拆掉钩子") process.removeAllListeners("exit");
        process.exit(0);
      }, 20);
      setTimeout(() => process.exit(3), 15000);
    `);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === "EPERM"); } };
    const once = async (mode) => {
      const pidFile = path.join(dir, `孙进程-${mode}.pid`);
      const f = put(dir, `文档-${mode}.pdf`, "%PDF 假的");
      const child = cp.spawn(process.execPath, [script, ROOT, pidFile, fs.realpathSync(f), mode], { stdio: "ignore" });
      const code = await new Promise((r) => child.on("exit", (c) => r(c)));
      const pid = Number(fs.readFileSync(pidFile, "utf8")) || 0;
      let gone = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) { if (!alive(pid)) { gone = true; break; } await realSleep(50); }
      return { code, pid, gone, waited: Date.now() - t0 };
    };
    const hooked = await once("正常");
    eq(hooked.code, 0, "「服务」按时拿到孙进程的 pid 退出了");
    ok(hooked.pid > 0 && hooked.gone, `服务一退，手上的子进程跟着没了（${hooked.waited}ms 内）`, hooked);
    // ★反向对照★ 把 exit 钩子拆掉：孙进程还活着——证明上面那条是钩子杀的，不是它自己碰巧退的
    const bare = await once("拆掉钩子");
    ok(bare.pid > 0 && !bare.gone, "★反向对照★ 没有 exit 钩子：孙进程成了孤儿，3 秒后还在", bare);
    if (bare.pid > 0 && alive(bare.pid)) { try { process.kill(-bare.pid, "SIGKILL"); } catch {} try { process.kill(bare.pid, "SIGKILL"); } catch {} }
  });

  await section("⑨ 不是 macOS：Office / PDF 直接给图标，一个子进程都不起", async () => {
    const office = ["a.pdf", "b.docx", "c.doc", "d.xlsx", "e.xls", "f.pptx", "g.ppt", "h.key", "i.pages", "j.numbers", "k.rtf"];
    const dir = path.join(ROOT_A, "非苹果");
    const files = office.map((n) => put(dir, n, "假的 " + n));
    for (const plat of ["linux", "win32"]) {
      const fake = installFakeSpawn();
      try {
        const { q, fr } = mkQueue({ opt: { platform: plat } });
        const got = [];
        for (const f of files) got.push(kindOf(await q.ask(item(f))));
        await q.idle();
        ok(got.every((k) => k === "icon"), `${plat}：${office.length} 种全给图标`, got);
        eq(fr.calls.length, 0, `${plat}：渲染器 0 次`);
        eq(fake.calls.length, 0, `${plat}：spawn 0 次`);
        eq(q.queue.size, 0, `${plat}：队里什么都没进`);
        // 真渲染器（不注入）走同一条路：也是 0 次
        const qReal = libCover.createCoverQueue({ cacheDir: fresh("thumbs"), platform: plat, lagMonitor: fakeLag(), log: () => {} });
        const got2 = [];
        for (const f of files) got2.push(kindOf(await qReal.ask(item(f))));
        ok(got2.every((k) => k === "icon"), `${plat}（真渲染器）：全给图标`, got2);
        eq(fake.calls.length, 0, `${plat}（真渲染器）：spawn 还是 0 次`);
      } finally { fake.restore(); }
    }
    // ★反向对照★ macOS：同样这些文件排队、真去出
    const { q, fr } = mkQueue({ opt: { platform: "darwin" } });
    const got = [];
    for (const f of files) got.push(kindOf(await q.ask(item(f))));
    await q.idle();
    ok(got.every((k) => k === "queued"), "★反向对照★ darwin：全排上了", got);
    eq(fr.calls.length, office.length, "★反向对照★ darwin：渲染器每种一次");

    // 其余几条车道的开关：网页只认 Electron、视频只认有 ffmpeg、别的只给图标
    const html = put(ROOT_A, "车道/页.html", "<p>x</p>");
    const mp4 = put(ROOT_A, "车道/片.mp4", "假视频");
    const txt = put(ROOT_A, "车道/说明.txt", "文本");
    const png = put(ROOT_A, "车道/图.png", "假图");
    const lane = async (opt, f) => kindOf(await mkQueue({ opt }).q.ask(item(f)));
    eq(await lane({ htmlBackend: () => "chrome" }, html), "icon", "网页 + 后端是无头 Chrome：图标（不为一张封面拉一个 Chrome）");
    eq(await lane({ htmlBackend: () => "" }, html), "icon", "网页 + 没有后端：图标");
    eq(await lane({ htmlBackend: () => "electron" }, html), "queued", "★反向对照★ 网页 + Electron：排队");
    const big = put(ROOT_A, "车道/大页.html", "x".repeat(libCover.HTML_MAX_BYTES + 1));
    eq(await lane({ htmlBackend: () => "electron" }, big), "icon", `网页超过 ${libCover.HTML_MAX_BYTES / 1024 / 1024}MB：图标（离屏窗口加载一趟几百 MB 内存）`);
    let probes = 0;
    eq(await lane({ hasFfmpeg: async () => { probes++; return false; } }, mp4), "icon", "视频 + 没 ffmpeg：头一次问就给图标（不让前端白轮询一轮）");
    eq(probes, 1, "ffmpeg 找了一次");
    eq(await lane({ hasFfmpeg: async () => true }, mp4), "queued", "★反向对照★ 视频 + 有 ffmpeg：排队");
    eq(await lane({}, txt), "icon", "文本：图标（卡片上给摘录，不出封面）");
    eq(await lane({}, png), "icon", "图片不进这条队（接口那头直接给缩略图地址）");
    const prev = process.env.OPENWORKBUDDY_LIB_HTML_COVER;
    process.env.OPENWORKBUDDY_LIB_HTML_COVER = "off";
    try { eq(await lane({ htmlBackend: () => "electron" }, html), "icon", "OPENWORKBUDDY_LIB_HTML_COVER=off：网页封面整条关掉"); }
    finally { if (prev === undefined) delete process.env.OPENWORKBUDDY_LIB_HTML_COVER; else process.env.OPENWORKBUDDY_LIB_HTML_COVER = prev; }
  });

  await section("键带着这个人的根：两个账号的同名同版文件，键不一样", async () => {
    const a = pinTime(put(ROOT_A, "同名/方案.pdf", "%PDF 一模一样"));
    const b = pinTime(put(ROOT_B, "同名/方案.pdf", "%PDF 一模一样"));
    const ia = item(a), ib = item(b, { userRoot: ROOT_B });
    eq(ia.st.size, ib.st.size, "体积一样"); eq(ia.st.mtimeMs, ib.st.mtimeMs, "mtime 一样");
    const ka = libCover.coverKey({ userRoot: ROOT_A, src: "lib", abs: ia.abs, mtimeMs: ia.st.mtimeMs, size: ia.st.size, w: 320 });
    const kb = libCover.coverKey({ userRoot: ROOT_B, src: "lib", abs: ib.abs, mtimeMs: ib.st.mtimeMs, size: ib.st.size, w: 320 });
    ok(ka !== kb && /^[0-9a-f]{40}$/.test(ka), "键不一样");
    // ★反向对照★ 同一个人、同一份：键稳定
    eq(libCover.coverKey({ userRoot: ROOT_A, src: "lib", abs: ia.abs, mtimeMs: ia.st.mtimeMs, size: ia.st.size, w: 320 }), ka, "★反向对照★ 同一个人再算一遍：一样");
    const { q, fr } = mkQueue();
    await q.ask(ia); await q.idle();
    eq(kindOf(await q.ask(ia)), "ready", "甲出过了：甲命中");
    eq(kindOf(await q.ask(ib)), "queued", "乙问同名同版的：不拿甲那张，自己排队");
    await q.idle();
    eq(fr.calls.length, 2, "各出各的");
  });

  // ---------------------------------------------------------------------------------------------
  // 真起 server.js：⑩ 路径、⑪ 账号、⑫ 摘录、接口形状
  // ---------------------------------------------------------------------------------------------
  const prefs = require(mod("prefs"));
  const LIB = path.join(HOME, "data", "library");                          // 管理员（lib）的资料库
  const LIB_BOB = path.join(HOME, "data", "library-users", prefs.keyOf("bob")); // 普通成员 bob 的资料库
  const WS = path.join(HOME, "workspace");
  const OUTSIDE = path.join(HOME, "外面");
  const THUMBS = path.join(HOME, "data", "thumbs");
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(OUTSIDE, "秘密.md"), "外面的秘密\n");
  fs.writeFileSync(path.join(OUTSIDE, "秘密.pdf"), "%PDF 外面的");
  put(LIB, "报告/周报.md", "# 周报\n  缩进的一行\r\n第三行\n");
  put(LIB, "报告/方案.pdf", "%PDF 甲的方案");
  put(LIB, "图/封面.png", PNG);
  put(LIB, "说明.txt", "说明");
  put(LIB, "同名.pdf", "%PDF 同一份");
  put(LIB_BOB, "同名.pdf", "%PDF 同一份");
  pinTime(path.join(LIB, "同名.pdf")); pinTime(path.join(LIB_BOB, "同名.pdf"));
  put(LIB_BOB, "乙的私房.md", "乙自己的笔记\n");
  fs.symlinkSync(path.join(OUTSIDE, "秘密.md"), path.join(LIB, "外链.md"));
  fs.symlinkSync(OUTSIDE, path.join(LIB, "外链目录"));
  fs.symlinkSync(path.join(LIB, "报告", "周报.md"), path.join(LIB, "里链.md")); // 指回根里面的：该放行
  put(WS, "产出/日报.md", "# 日报\n今天做了三件事\n");
  put(WS, "产出/海报.png", PNG);
  fs.symlinkSync(path.join(OUTSIDE, "秘密.md"), path.join(WS, "产出", "外链.md"));
  // 摘录夹具
  const HEAD = 16 * 1024;
  const textHead = Buffer.alloc(HEAD, 0x61); for (let i = 99; i < HEAD; i += 100) textHead[i] = 0x0a; // 前 16KB 是一行行的 a
  put(WS, "摘录/前面是字后面有零.log", Buffer.concat([textHead, Buffer.alloc(4096, 0)]));
  put(WS, "摘录/开头就有零.dat", Buffer.concat([Buffer.from("abc"), Buffer.alloc(10, 0), Buffer.from("def")]));
  put(WS, "摘录/乱码.txt", crypto.randomBytes(3000));
  put(WS, "摘录/长行.txt", "字".repeat(5000));
  put(WS, "摘录/三十行.txt", Array.from({ length: 30 }, (_, i) => `第${i + 1}行`).join("\n") + "\n");
  put(WS, "摘录/bom.md", "\ufeff# 带 BOM\n正文\n");
  put(WS, "摘录/图.png", "其实是文本但后缀是图");
  const hugeFile = path.join(WS, "摘录", "超大.log");
  { const fd = fs.openSync(hugeFile, "w"); fs.ftruncateSync(fd, 65 * 1024 * 1024); fs.closeSync(fd); } // 稀疏文件，不真占盘

  const tokA = "lib" + crypto.randomBytes(12).toString("hex");
  const tokB = "bob" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(HOME, "data"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "data", "users.json"), JSON.stringify({
    users: [
      { username: "lib", org: "default", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() },
      { username: "bob", org: "default", salt: "x", hash: "x", role: "member", credits: 0, created_at: Date.now() },
    ],
    tokens: { [tokA]: { user: "lib", at: Date.now() }, [tokB]: { user: "bob", at: Date.now() } },
  }));

  // 服务的临时目录也放进这个 HOME：qlmanage 被叫停时 ql-thumb 来不及删它的 owb-ql-*，跟着 HOME 一起清
  const SERVER_TMP = path.join(HOME, "tmp");
  fs.mkdirSync(SERVER_TMP, { recursive: true });
  const booted = bootRealServer({ OPENWORKBUDDY_HOME: HOME, TMPDIR: SERVER_TMP, TMP: SERVER_TMP, TEMP: SERVER_TMP }, { timeoutMs: 120000 });
  serverChild = booted.child;
  const { up, port, why } = await booted.wait();
  ok(up, "真 server.js 起来了", up ? undefined : why);
  /** @returns {Promise<{ code: number, body: string, json: any, headers: any, buf: Buffer }>} */
  const call = (method, p, tok, body) => new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: { Cookie: "openworkbuddy_token=" + tok, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ code: res.statusCode || 0, body: text, json, headers: res.headers, buf });
      });
    });
    rq.on("error", (e) => resolve({ code: 0, body: e.message, json: null, headers: {}, buf: Buffer.alloc(0) }));
    if (data) rq.write(data);
    rq.end();
  });
  const covers = (tok, items, w = 320) => call("POST", "/api/library/covers", tok, { items, w });
  const excerpts = (tok, items) => call("POST", "/api/library/excerpts", tok, { items });

  if (up) {
    await section("接口形状：covers 的上限、宽度、图片直接给地址", async () => {
      const r = await covers(tokA, [
        { id: "png", src: "lib", path: "图/封面.png" },
        { id: "txt", src: "lib", path: "说明.txt" },
        { id: "wspng", src: "ws", path: "产出/海报.png" },
      ]);
      eq(r.code, 200, "POST /api/library/covers → 200");
      const j = r.json || {};
      ok(j.ready && Array.isArray(j.queued) && Array.isArray(j.icon), "回 {ready, queued, icon}", j);
      ok(/^\/api\/library\/file\/%E5%9B%BE\/%E5%B0%81%E9%9D%A2\.png\?thumb=640&v=/.test((j.ready || {}).png || ""), "资料库里的图片：直接给 /api/library/file/…?thumb=640&v=", j.ready);
      ok(/^\/api\/files\/view\/.+\?thumb=640&v=/.test((j.ready || {}).wspng || ""), "工作区里的图片：直接给 /api/files/view/…?thumb=640&v=", j.ready);
      ok((j.icon || []).includes("txt"), "文本：图标", j);
      const img = await call("GET", (j.ready || {}).png || "/", tokA);
      ok(img.code === 200 && img.buf.length > 0, "那个地址拿得到图", { code: img.code });
      const img2 = await call("GET", (j.ready || {}).wspng || "/", tokA);
      ok(img2.code === 200 && img2.buf.length > 0, "工作区那个地址也拿得到", { code: img2.code });

      const sixty = Array.from({ length: 60 }, (_, i) => ({ id: "t" + i, src: "lib", path: "说明.txt" }));
      eq((await covers(tokA, sixty)).code, 200, "60 条：收");
      const sixty1 = [...sixty, { id: "t60", src: "lib", path: "说明.txt" }];
      const over = await covers(tokA, sixty1);
      ok(over.code === 400 && typeof (over.json || {}).error === "string", "★反向对照★ 61 条：400，带一句话", { code: over.code, body: over.body.slice(0, 80) });
      for (const w of [160, 320, 640]) eq((await covers(tokA, [], w)).code, 200, `w=${w}：收`);
      for (const w of [0, 200, 1280, "abc"]) eq((await covers(tokA, [], /** @type {any} */ (w))).code, 400, `★反向对照★ w=${w}：400`);
      eq((await call("POST", "/api/library/covers", tokA, { items: "x" })).code, 400, "items 不是列表：400");
      eq((await call("POST", "/api/library/covers", "nobody", { items: [] })).code, 401, "没登录：401");
    });

    await section("⑩ ..、绝对路径、指到根外面的链接：一律拒", async () => {
      const bad = [
        ["lib", "../外面/秘密.md", "..（上一层）"],
        ["lib", "报告/../../外面/秘密.md", "绕一圈再出去"],
        ["lib", path.join(OUTSIDE, "秘密.md"), "绝对路径"],
        ["lib", "/etc/hosts", "绝对路径 /etc"],
        ["lib", "C:\\Windows\\win.ini", "盘符路径"],
        ["lib", "外链.md", "根里的链接指到外面"],
        ["lib", "外链目录/秘密.md", "根里的目录链接指到外面"],
        ["lib", "外链目录/秘密.pdf", "目录链接指到外面的 PDF"],
        ["lib", ".favorites.json", "点开头的（收藏清单自己）"],
        ["lib", "报告/周报.md\u0000.png", "带控制字符"],
        ["ws", "../外面/秘密.md", "工作区 .."],
        ["ws", path.join(OUTSIDE, "秘密.md"), "工作区绝对路径"],
        ["ws", "产出/外链.md", "工作区里的链接指到外面"],
        ["nope", "报告/周报.md", "不认识的 src"],
      ];
      const ex = await excerpts(tokA, bad.map(([src, p], i) => ({ id: "b" + i, src, path: p })));
      eq(ex.code, 200, "excerpts → 200");
      const exItems = (ex.json || {}).items || {};
      bad.forEach(([, , why2], i) => {
        const v = exItems["b" + i];
        ok(v && v.skip === "denied" && !v.lines, `摘录：${why2} → denied`, v);
      });
      ok(!ex.body.includes("外面的秘密"), "摘录的回包里没有一个字来自根外面");
      const cv = await covers(tokA, bad.map(([src, p], i) => ({ id: "b" + i, src, path: p })));
      ok(cv.code === 200 && bad.every((_, i) => (cv.json.icon || []).includes("b" + i)) && !Object.keys(cv.json.ready || {}).length && !(cv.json.queued || []).length,
        "封面：全给图标，一个地址都不给", cv.json);
      for (const [src, p, why2] of bad.slice(0, 8)) {
        const g = await call("GET", `/api/library/cover?src=${encodeURIComponent(src)}&path=${encodeURIComponent(p)}&w=320`, tokA);
        ok(g.code === 400 || g.code === 404, `GET 封面：${why2} → ${g.code}`, { code: g.code, body: g.body.slice(0, 60) });
        ok(!g.body.includes("外面"), `GET 封面：${why2}，回包里没带出外面的内容`);
      }
      // ★反向对照★ 同一批里正常的路径照给；指回根里面的链接也放行（证明拒的是「出界」不是「是链接」）
      const good = await excerpts(tokA, [
        { id: "g1", src: "lib", path: "报告/周报.md" },
        { id: "g2", src: "lib", path: "里链.md" },
        { id: "g3", src: "ws", path: "产出/日报.md" },
        { id: "g4", src: "lib", path: "./报告//周报.md" },
      ]);
      const gi = (good.json || {}).items || {};
      ok(gi.g1 && Array.isArray(gi.g1.lines) && gi.g1.lines[0] === "# 周报", "★反向对照★ 资料库里正常的文件：给摘录", gi.g1);
      ok(gi.g2 && Array.isArray(gi.g2.lines) && gi.g2.lines[0] === "# 周报", "★反向对照★ 指回根里面的链接：放行", gi.g2);
      ok(gi.g3 && Array.isArray(gi.g3.lines) && gi.g3.lines[1] === "今天做了三件事", "★反向对照★ 工作区里正常的文件：给摘录", gi.g3);
      ok(gi.g4 && Array.isArray(gi.g4.lines), "★反向对照★ 多余的 ./ 和 //：规整后照给", gi.g4);
    });

    await section("⑪ A 账号拿不到 B 账号的封面", async () => {
      // 给 bob 的「同名.pdf」在缓存里放一张封面（照服务端的算法算键：bob 的根 + realpath 过的文件）
      const bobFile = fs.realpathSync(path.join(LIB_BOB, "同名.pdf"));
      const st = fs.statSync(bobFile);
      const key = libCover.coverKey({ userRoot: LIB_BOB, src: "lib", abs: bobFile, mtimeMs: st.mtimeMs, size: st.size, w: 320 });
      fs.mkdirSync(THUMBS, { recursive: true });
      fs.writeFileSync(path.join(THUMBS, `cover-${key}.png`), PNG);
      const url = `/api/library/cover?src=lib&path=${encodeURIComponent("同名.pdf")}&w=320&v=${encodeURIComponent(libCover.coverVersion(st))}`;

      const mine = await covers(tokB, [{ id: "x", src: "lib", path: "同名.pdf" }]);
      // PDF 走 Quick Look，只有 macOS 有这条车道；别的系统上 covers 直接回图标，不去翻缓存（⑨）。
      // 那边隔离靠下面 GET 那几条证：GET 不看车道，只按请求人的根算键
      if (process.platform === "darwin") eq((mine.json.ready || {}).x, url, "bob 问自己的：ready，地址就是这个");
      else ok((mine.json.icon || []).includes("x"), "bob 问自己的：非 macOS 没有 Quick Look，给图标", mine.json);
      const bobGet = await call("GET", url, tokB);
      ok(bobGet.code === 200 && bobGet.buf.equals(PNG), "bob 拿自己的封面：200，就是那张", { code: bobGet.code });
      eq(bobGet.headers["content-type"], "image/png", "Content-Type 照文件头给");
      ok(/private/.test(String(bobGet.headers["cache-control"])) && /max-age=604800/.test(String(bobGet.headers["cache-control"])), "v 对得上：private、留七天", bobGet.headers["cache-control"]);
      const stale = await call("GET", url.replace(/&v=[^&]+/, "&v=" + encodeURIComponent("老版本")), tokB);
      ok(stale.code === 200 && /no-cache/.test(String(stale.headers["cache-control"])), "v 对不上：照给，但不让浏览器留", stale.headers["cache-control"]);

      // 管理员 lib 的资料库里也有一份「同名.pdf」，同内容同 mtime：拿同一个地址去要
      const adminGet = await call("GET", url, tokA);
      eq(adminGet.code, 404, "管理员拿 bob 的封面地址：404（按管理员自己的根算，键对不上）");
      ok(!adminGet.buf.equals(PNG), "回包不是那张图");
      const adminAsk = await covers(tokA, [{ id: "x", src: "lib", path: "同名.pdf" }]);
      ok(!(adminAsk.json.ready || {}).x, "管理员问自己的同名文件：不是 ready（不拿 bob 那张）", adminAsk.json);
      // bob 自己独有的文件，管理员连「在不在」都问不出来
      const peek = await call("GET", `/api/library/cover?src=lib&path=${encodeURIComponent("乙的私房.md")}&w=320`, tokA);
      eq(peek.code, 404, "管理员要 bob 独有的文件：404（管理员的根里没有）");
      const peekEx = await excerpts(tokA, [{ id: "p", src: "lib", path: "乙的私房.md" }]);
      eq(((peekEx.json || {}).items || {}).p && peekEx.json.items.p.skip, "missing", "管理员要 bob 的笔记摘录：missing");
      // ★反向对照★ bob 自己要：给
      const ownEx = await excerpts(tokB, [{ id: "p", src: "lib", path: "乙的私房.md" }]);
      eq((((ownEx.json || {}).items || {}).p || {}).lines && ownEx.json.items.p.lines[0], "乙自己的笔记", "★反向对照★ bob 要自己的笔记：给");
    });

    await section("⑫ 摘录：只读前 16KB、二进制不给、一批最多 40 条", async () => {
      const ids = ["前面是字后面有零.log", "开头就有零.dat", "乱码.txt", "长行.txt", "三十行.txt", "bom.md", "图.png", "超大.log", "没有这个.md"];
      const r = await excerpts(tokA, ids.map((n) => ({ id: n, src: "ws", path: "摘录/" + n })));
      eq(r.code, 200, "→ 200");
      const it = (r.json || {}).items || {};
      const tail = it["前面是字后面有零.log"];
      ok(tail && Array.isArray(tail.lines) && tail.truncated === true, "前 16KB 全是字、16KB 之后才有 NUL：照给摘录（证明 16KB 往后根本没读）", tail);
      eq((it["开头就有零.dat"] || {}).skip, "binary", "★反向对照★ NUL 在前 16KB 里：binary");
      eq((it["乱码.txt"] || {}).skip, "binary", "随机字节（解出来一堆乱码）：binary");
      eq((it["图.png"] || {}).skip, "binary", "图片后缀：连开都不开，binary");
      eq((it["超大.log"] || {}).skip, "too_big", "64MB 往上：too_big（不为几行字去云盘拉整份）");
      eq((it["没有这个.md"] || {}).skip, "missing", "不在的：missing");
      const long = it["长行.txt"] || {};
      ok(Array.isArray(long.lines) && long.lines.join("").length === 1200 && long.truncated === true, "一行 5000 字：截到 1200 字，truncated", { n: long.lines && long.lines.join("").length });
      const thirty = it["三十行.txt"] || {};
      ok(Array.isArray(thirty.lines) && thirty.lines.length === 20 && thirty.lines[19] === "第20行" && thirty.truncated === true, "三十行：给前 20 行，truncated", thirty);
      const bom = it["bom.md"] || {};
      ok(bom.lines && bom.lines[0] === "# 带 BOM" && bom.truncated === false, "BOM 去掉；整份读完了 truncated=false", bom);
      const md = await excerpts(tokA, [{ id: "m", src: "lib", path: "报告/周报.md" }]);
      const m = ((md.json || {}).items || {}).m || {};
      ok(m.lines && m.lines[1] === "  缩进的一行" && m.lines[2] === "第三行" && m.lines.length === 3, "行原样给：缩进不 trim，\\r\\n 算一行，末尾换行不多出一行", m);

      const forty = Array.from({ length: 40 }, (_, i) => ({ id: "e" + i, src: "lib", path: "报告/周报.md" }));
      const r40 = await excerpts(tokA, forty);
      ok(r40.code === 200 && Object.keys((r40.json || {}).items || {}).length === 40, "40 条：收，40 条都有答复");
      const r41 = await excerpts(tokA, [...forty, { id: "e40", src: "lib", path: "报告/周报.md" }]);
      ok(r41.code === 400 && typeof (r41.json || {}).error === "string", "★反向对照★ 41 条：400", { code: r41.code, body: r41.body.slice(0, 80) });
    });
  }

  await section("⑫b 摘录只读前 16KB：盯着 read 看", async () => {
    // 进程内直接调 excerptRead，把 fs.promises.open 换成数字节的：读到的字节数就是证据
    const lib = require(mod("routes/library"));
    const fsp = fs.promises;
    const origOpen = fsp.open;
    let readBytes = 0, readPos = [];
    fsp.open = /** @type {any} */ (async (...a) => {
      const fh = await origOpen.apply(fsp, a);
      const origRead = fh.read.bind(fh);
      fh.read = /** @type {any} */ (async (buf, off, len, pos) => { const r = await origRead(buf, off, len, pos); readBytes += r.bytesRead; readPos.push([pos, len]); return r; });
      return fh;
    });
    try {
      const big = put(fresh("ex"), "大.log", "一行字\n".repeat(200000)); // 约 2MB
      const out = await lib.excerptRead(big, fs.statSync(big));
      ok(readBytes <= lib.EXCERPT_HEAD_BYTES, `2MB 的文本：一共只读了 ${readBytes} 字节（≤ ${lib.EXCERPT_HEAD_BYTES}）`, readPos);
      ok(readPos.every(([p]) => p === 0), "只从头读", readPos);
      ok(out.lines && out.lines.length === lib.EXCERPT_MAX_LINES && out.truncated === true, "给了 20 行、truncated");
      // ★反向对照★ 小文件：读多少是多少（数字节的那一刀是真的在数）
      readBytes = 0; readPos = [];
      const small = put(fresh("ex"), "小.md", "一行\n两行\n");
      const o2 = await lib.excerptRead(small, fs.statSync(small));
      eq(readBytes, Buffer.byteLength("一行\n两行\n"), "★反向对照★ 小文件：读到的正好是整份的字节数");
      ok(o2.truncated === false && o2.lines.length === 2, "★反向对照★ 小文件读完了：truncated=false");
    } finally { fsp.open = origOpen; }
  });

  if (serverChild) {
    await section("收尾：关掉服务，它起的 qlmanage 一个不留", async () => {
      // 前面几段往真服务里塞过假 PDF，macOS 上它真会起 qlmanage 去出图（认不出的文件一挂就是几分钟）。
      // 用 SIGINT 关：服务自己 process.exit，lib-cover 的 exit 钩子同步叫停手上那个
      const tag = path.basename(HOME);
      const mine = () => {
        const r = cp.spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8" });
        return String(r.stdout || "").split("\n").filter((l) => l.includes(tag) && !l.includes(" ps ")).map((l) => l.trim());
      };
      const child = /** @type {import("child_process").ChildProcess} */ (serverChild);
      const before = cp.spawnSync("ps", ["-A", "-o", "pid="], { encoding: "utf8" }).stdout.split("\n").map((x) => Number(x.trim()));
      ok(before.includes(Number(child.pid)), "★反向对照★ ps 看得见服务进程（这把尺子是好的）");
      const code = await stopServer(child);
      ok(code !== null, "服务 SIGINT 后自己退了", code);
      let left = mine();
      for (let i = 0; i < 20 && left.length; i++) { await realSleep(100); left = mine(); }
      eq(left.length, 0, "关掉服务以后，没有带着这个 HOME 路径的进程还活着");
      for (const l of left) { const pid = Number(l.split(/\s+/)[0]); try { process.kill(pid, "SIGKILL"); } catch {} }
    });
  }

  finished = true;
  clearInterval(keepAlive);
  console.log(`\n${fail ? "✗" : "✓"} 资料库封面与摘录：${pass} 过 / ${fail} 挂`);
  try { if (serverChild && serverChild.exitCode === null) serverChild.kill("SIGKILL"); } catch {}
  process.exit(fail ? 1 : 0);
})();

/**
 * 先 SIGINT（服务自己 process.exit，exit 钩子会跑），5 秒不退再 SIGKILL。回退出码，被硬杀的回 null
 * @param {import("child_process").ChildProcess} child
 */
async function stopServer(child) {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise((r) => child.once("exit", (c) => r(c)));
  try { child.kill("SIGINT"); } catch {}
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("超时"), 5000))]);
  if (code !== "超时") return /** @type {number|null} */ (code);
  try { child.kill("SIGKILL"); } catch {}
  await exited;
  return null;
}

/**
 * 起一份真的 server.js。照抄 test/e2e.js 里的 bootRealServer：那边 require 不得（e2e.js 一 require
 * 就开跑整套），抄过来的这份只认「已启动: http://localhost:端口」那一行。
 * @param {Record<string,string>} env
 * @param {{ timeoutMs?: number, port?: string }} [opts]
 */
function bootRealServer(env, { timeoutMs = 60000, port = "0" } = {}) {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [entry("server")], {
    env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const ready = new Promise((resolve) => {
    const done = (/** @type {boolean} */ v) => { clearInterval(tick); clearTimeout(t); resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    const tick = setInterval(() => {
      if (/已启动: http:\/\/localhost:\d+/.test(log)) done(true);
      else if (child.exitCode !== null) done(false);
    }, 200);
  });
  return {
    child,
    get log() { return log; },
    async wait() {
      const up = await ready;
      const m = /已启动: http:\/\/localhost:(\d+)/.exec(log);
      return { up: !!up && !!m, port: m ? Number(m[1]) : 0, why: `退出码=${child.exitCode} 存活=${child.exitCode === null} 日志尾巴=${JSON.stringify(log.slice(-400)) || "(空)"}` };
    },
  };
}
