// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 服务进程多开不卡：把主线程整个停住的三件事拆掉之后，别让它们长回来。
 *
 * 2026-09-29 拿 5 条对话并发（假引擎、真实形状的大会话）跑 10 分钟量了三遍，中位数：
 *   事件循环 p99 277ms、最长一下 692ms，/api/info p95 530ms，流式输出两段之间 p99 205ms。
 * CPU 采样 + 堆对比找出来三个根因，这里每个都有一道闸：
 *   A. 会话存盘：跑任务途中每存一次都是主线程序列化 + 写临时文件 + fsync
 *      （540 秒里 fsync 11426 次、合计 51.6 秒）→ 后台写、每条一秒最多一次、收尾 / 退出必落盘、
 *      旧的不许晚到盖掉新的、删掉的不许被写回来
 *   B. store.coalesce：上面那套排班本身
 *   C. 每一步模型调用的中止信号：AbortSignal.any + 半小时的 AbortSignal.timeout，
 *      合成出来的信号收不回来（6 分钟攒约 3000 个）
 *   D. 翻工作目录：主线程 42.6% 的 CPU（readdir 335 万次、stat 3260 万次）→ 挪进后台线程、
 *      几条对话共用一趟，结果跟 outputFiles() / turnSnapshot() 逐条对得上
 *   E. 接线：server.js / agent.js 真走的是新路
 *
 * 每一组都带 ★反向对照★：换回老写法（或把那一行改回去），同一条断言当场变红——
 * 证明这条断言量得出区别，不是怎么写都绿。全按次数判，不按毫秒判。
 *
 * 不联网、不花钱、不起 Electron。
 *   node test/server-stall.js
 */

// C 组要 global.gc 看合成信号回收了几个。npm test 拿 node 直接拉起来的，自己换身皮再跑一遍
const { mod } = require("./lib/mod");
if (!global.gc) {
  const r = require("child_process").spawnSync(process.execPath, ["--expose-gc", __filename], {
    stdio: ["ignore", "inherit", "inherit"], timeout: 300000,
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawnSync } = require("child_process");
const { getEventListeners } = require("events");

// 工作区、数据目录全跟着 OPENWORKBUDDY_HOME 走：require 任何项目模块之前先把家搬到临时目录
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-stall-"));
// 临时根下再分小目录：跟着 HOME 一起收，不另起 mkdtemp
let subSeq = 0;
const subdir = (tag) => { const d = path.join(HOME, `${tag}-${++subSeq}`); fs.mkdirSync(d, { recursive: true }); return d; };
process.env.OPENWORKBUDDY_HOME = HOME;

const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src");
const store = require(mod("store"));

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(msg, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (detail === undefined ? "" : "  ← " + JSON.stringify(detail).slice(0, 400))); }
}
const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const tick = () => new Promise((r) => setTimeout(r, 5));
/** 等到条件成立（判的是结果，不是时间：上限只防挂死） */
async function until(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) return false; await tick(); }
  return true;
}
const byName = (files) => files.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const tmpsIn = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));

// ---------------- 数主线程上的同步文件调用 ----------------
// store / tools / ws-browse 都是调用那一刻按 fs.xxx 取的，包一层就数得到。
// 后台线程有自己的一份 fs，这里数不到——要数的正是「主线程上还剩几次」
const FS_TAP = { into: /** @type {null | { n: Record<string, number>, pred?: Function }} */ (null) };
for (const k of ["readdirSync", "statSync", "fsyncSync", "renameSync"]) {
  const orig = fs[k];
  fs[k] = function (...a) {
    const b = FS_TAP.into;
    if (b && (!b.pred || b.pred(k, a))) b.n[k] = (b.n[k] || 0) + 1;
    return orig.apply(fs, a);
  };
}
const tap = (pred) => ({ n: /** @type {Record<string, number>} */ ({}), pred });
async function during(b, fn) {
  const prev = FS_TAP.into;
  FS_TAP.into = b;
  try { return await fn(); } finally { FS_TAP.into = prev; }
}

// ---------------- A 组：把 server.js 里会话读写那一段真源码切出来单跑 ----------------
// 跟 test/memory.js 同一个切法：注入 fs/path/SESS_DIR/store/sessions/activeRuns/console 就能真读真写磁盘
const SRC = src("server");
const SA = SRC.indexOf("function sessFile(id) {");
const SB = SRC.indexOf("const sessMetaCache = new Map();", SA);
if (SA < 0 || SB <= SA) throw new Error("server.js 里的会话读写找不到了（改名/挪走？），测试没法定位真源码");
const SLICE = SRC.slice(SA, SB);
const RET = "\nreturn { getSession, saveSession, autosaveSession, queueSessionSave, flushSessionSave,"
  + " flushSessionSavesSync, forgetSession, sessFile, sessWriters, sessStamp };";
// 老路 ①：跑任务途中直接同步存（改之前 autosaveSession 就是这么写的）
const OLD_AUTOSAVE = /** @type {[RegExp, string]} */ ([/(sessSaveAt\.set\(id, now\);\s*)queueSessionSave\(id\);/, "$1saveSession(id);"]);
// 老路 ②：路上那份不管同步那条路后来写没写过、会话删没删，照样改名落地
const OLD_COMMIT = /** @type {[RegExp, string]} */ ([/shouldCommit: \(\) => me\.gen === gen && sessWriters\.get\(id\) === me,/, "shouldCommit: () => true,"]);

function build(muts = [], st = store) {
  const home = subdir("sess");
  const SESS_DIR = path.join(home, "sessions");
  fs.mkdirSync(SESS_DIR, { recursive: true });
  let body = SLICE;
  for (const [re, to] of muts) {
    // 要改的那一行找不到了就当场报：不然反向对照跑的其实还是新代码，永远「红不了」也看不出来
    if (!re.test(body)) throw new Error("反向对照要改回去的那一行找不到了：" + re);
    body = body.replace(re, to);
  }
  const sessions = new Map(), activeRuns = new Map(), warns = [];
  const M = new Function("fs", "path", "SESS_DIR", "store", "sessions", "activeRuns", "console", body + RET)(
    fs, path, SESS_DIR, st, sessions, activeRuns, { log() {}, warn: (...a) => warns.push(a.join(" ")) });
  return { ...M, sessions, SESS_DIR, warns };
}
/** 包一层 store：知道后台那趟什么时候开的笔（writeJsonAtomicAsync 被调的那一刻就序列化了） */
function watchedStore() {
  const w = { started: 0, store: /** @type {any} */ (null) };
  w.store = { ...store, writeJsonAtomicAsync(f, d, o) { w.started++; return store.writeJsonAtomicAsync(f, d, o); } };
  return w;
}
/** 等到后台那趟已经开笔：它在 Promise 微任务里开，不用等任何 I/O */
async function untilStarted(w) { for (let i = 0; i < 50 && !w.started; i++) await null; return w.started > 0; }
const sessOf = (mark) => ({ history: [{ role: "user", content: mark }], transcript: [], title: mark, updated_at: null });
const diskOf = (g, id) => JSON.parse(fs.readFileSync(g.sessFile(id), "utf8"));

async function partA() {
  console.log("\n— A. 会话存盘：跑任务途中不在主线程上 fsync，丢不了、旧的盖不掉新的 —");
  {
    const ID = "s_1759100000000_a1";
    const run = async (muts) => {
      const g = build(muts);
      store.writeJsonAtomic(g.sessFile(ID), sessOf("起点"));
      const s = g.getSession(ID);
      const target = g.sessFile(ID);
      const t = tap((k, a) => k === "fsyncSync" || (k === "renameSync" && String(a[1]) === target));
      await during(t, async () => {
        for (let i = 0; i < 50; i++) { s.history.push({ role: "assistant", content: `第${i}段` }); g.autosaveSession(ID, 0); }
        await g.flushSessionSave(ID);
      });
      return { fsync: t.n.fsyncSync || 0, writes: t.n.renameSync || 0, n: diskOf(g, ID).history.length, want: s.history.length };
    };
    const now = await run([]);
    ok(`连着存 50 次：主线程上 fsync ${now.fsync} 次（写临时文件和落盘交给线程池）`, now.fsync === 0, now);
    ok(`50 次并成 ${now.writes} 趟真写（路上一趟 + 收尾补一趟）`, now.writes >= 1 && now.writes <= 2, now);
    ok(`收尾 flushSessionSave 之后盘上就是最新那份（${now.n}/${now.want} 条）`, now.n === now.want, now);
    const old = await run([OLD_AUTOSAVE]);
    ok(`★反向对照★ 换回「途中直接 saveSession」：同样 50 次，主线程 fsync ${old.fsync} 次`, old.fsync >= 50, old);
  }
  {
    // 后台那趟拿着 v1 在路上，同步那条路（改标题、删消息这类接口）写了 v2：v1 不许晚到把 v2 盖掉
    const ID = "s_1759100000000_a3";
    const run = async (muts) => {
      const w = watchedStore();
      const g = build(muts, w.store);
      store.writeJsonAtomic(g.sessFile(ID), sessOf("v0"));
      const s = g.getSession(ID);
      s.title = "v1";
      g.queueSessionSave(ID);
      const began = await untilStarted(w);
      s.title = "v2";
      g.saveSession(ID);
      const rec = g.sessWriters.get(ID);
      await until(() => !rec.w.busy());
      return { began, title: diskOf(g, ID).title, tmps: tmpsIn(g.SESS_DIR).length };
    };
    const now = await run([]);
    ok(`路上那趟（v1）落地前同步写了 v2：盘上是 ${now.title}，没留 .tmp`, now.began && now.title === "v2" && now.tmps === 0, now);
    const old = await run([OLD_COMMIT]);
    ok(`★反向对照★ 去掉改名前那道 shouldCommit：旧的晚到，盘上变回 ${old.title}`, old.began && old.title === "v1", old);
  }
  {
    // 删会话时后台那趟正在路上：删完它不许把整份写回来（用户点了删除，一秒后文件又出现）
    const ID = "s_1759100000000_a4";
    const run = async (muts) => {
      const w = watchedStore();
      const g = build(muts, w.store);
      store.writeJsonAtomic(g.sessFile(ID), sessOf("v0"));
      const s = g.getSession(ID);
      s.title = "v1";
      g.queueSessionSave(ID);
      const began = await untilStarted(w);
      const rec = g.sessWriters.get(ID);
      g.forgetSession(ID);
      fs.rmSync(g.sessFile(ID), { force: true });
      fs.rmSync(g.sessFile(ID) + ".bak", { force: true });
      await until(() => !rec.w.busy());
      return { began, back: fs.existsSync(g.sessFile(ID)), writers: g.sessWriters.size };
    };
    const now = await run([]);
    ok("删会话时后台那趟正在路上：删完就是删完，文件没被写回来、排班也一起清了", now.began && !now.back && now.writers === 0, now);
    const old = await run([OLD_COMMIT]);
    ok("★反向对照★ 去掉改名前那道 shouldCommit：删掉的会话被整份写回盘上", old.began && old.back, old);
  }
  {
    // 进程说走就走（关窗口、退出）：排着的、路上的都得在 exit 钩子里同步补写
    const SLICE_FILE = path.join(HOME, "slice.js");
    fs.writeFileSync(SLICE_FILE, SLICE + RET);
    const CHILD = path.join(HOME, "child-sess.js");
    fs.writeFileSync(CHILD, [
      '"use strict";',
      'const fs = require("fs"), path = require("path");',
      "const [, , mode, ROOT, SLICE_FILE, SESS_DIR] = process.argv;",
      "const store = require(" + JSON.stringify(mod("store")) + ");",
      'const body = fs.readFileSync(SLICE_FILE, "utf8");',
      'const g = new Function("fs", "path", "SESS_DIR", "store", "sessions", "activeRuns", "console", body)(fs, path, SESS_DIR, store, new Map(), new Map(), { log() {}, warn() {} });',
      'const ID = "s_1759100000000_a5";',
      'store.writeJsonAtomic(g.sessFile(ID), { history: [{ role: "user", content: "v0" }], transcript: [], title: "v0", updated_at: null });',
      "const s = g.getSession(ID);",
      // server.js 里是 process.on("exit", flushPendingWritesSync)，里面第一件就是 flushSessionSavesSync（E 组钉着）
      'if (mode === "hook") process.on("exit", () => { g.flushSessionSavesSync(); });',
      's.title = "v1";',
      "g.queueSessionSave(ID);",
      "Promise.resolve().then(() => {}).then(() => {",
      '  s.title = "v2";',
      "  g.queueSessionSave(ID);",
      '  s.title = "v3";',
      "  process.exit(0);",
      "});",
    ].join("\n"));
    const run = (mode) => {
      const dir = subdir("exit");
      const r = spawnSync(process.execPath, [CHILD, mode, ROOT, SLICE_FILE, dir], { encoding: "utf8", timeout: 30000 });
      const f = path.join(dir, "s_1759100000000_a5.json");
      let title = null;
      try { title = JSON.parse(fs.readFileSync(f, "utf8")).title; } catch {}
      return { status: r.status, title, tmps: tmpsIn(dir).length, err: (r.stderr || "").slice(0, 300) };
    };
    const now = run("hook");
    ok(`路上一趟、排着一趟、还有一笔没排：进程这时退出，exit 钩子同步补写，盘上是最后那份（${now.title}）`, now.status === 0 && now.title === "v3" && now.tmps === 0, now);
    const old = run("none");
    ok(`★反向对照★ 不挂 exit 钩子：盘上还是开跑前那份（${old.title}），这一轮全丢`, old.status === 0 && old.title === "v0", old);
  }
  {
    // store 层：临时文件已经写好、还没改名时进程退出，那个 .tmp（一条大会话一份）不许留在盘上
    const CHILD = path.join(HOME, "child-tmp.js");
    fs.writeFileSync(CHILD, [
      '"use strict";',
      'const fs = require("fs"), path = require("path"), Module = require("module");',
      "const [, , mode, ROOT, FILE] = process.argv;",
      "const file = " + JSON.stringify(mod("store")) + ";",
      "let store;",
      'if (mode === "nodrop") {',
      '  let code = fs.readFileSync(file, "utf8");',
      '  const re = /process\\.once\\("exit", dropAsyncTmps\\);/;',
      '  if (!re.test(code)) { console.error("store.js 里退出删临时文件那一行找不到了"); process.exit(3); }',
      '  code = code.replace(re, "");',
      "  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));",
      "  m._compile(code, file); store = m.exports;",
      "} else store = require(file);",
      'store.writeTextAtomic(FILE, "旧的");',
      'store.writeTextAtomicAsync(FILE, "新的", { shouldCommit: () => { process.exit(0); } });',
    ].join("\n"));
    const run = (mode) => {
      const dir = subdir("tmp");
      const f = path.join(dir, "x.json");
      const r = spawnSync(process.execPath, [CHILD, mode, ROOT, f], { encoding: "utf8", timeout: 30000 });
      let body = null;
      try { body = fs.readFileSync(f, "utf8"); } catch {}
      return { status: r.status, body, tmps: tmpsIn(dir).length, err: (r.stderr || "").slice(0, 300) };
    };
    const now = run("keep");
    ok("临时文件写好、改名之前进程退出：.tmp 顺手删掉，正本还是完整的上一版", now.status === 0 && now.tmps === 0 && now.body === "旧的", now);
    const old = run("nodrop");
    ok(`★反向对照★ 去掉退出时删临时文件那一行：盘上留下 ${old.tmps} 个没人认领的 .tmp`, old.status === 0 && old.tmps >= 1, old);
  }
}

async function partB() {
  console.log("\n— B. store.coalesce：同一个文件的后台写盘排班 —");
  {
    let runs = 0, live = 0, maxLive = 0;
    const job = async () => { runs++; live++; maxLive = Math.max(maxLive, live); await new Promise((r) => setTimeout(r, 10)); live--; };
    const c = store.coalesce(job, { minGapMs: 50 });
    for (let i = 0; i < 100; i++) c.request();
    await until(() => !c.busy());
    ok(`一口气要写 100 次：真跑 ${runs} 趟（第一趟 + 间隔到了并成的一趟），路上最多 ${maxLive} 趟`, runs === 2 && maxLive === 1, { runs, maxLive });
    // 不排班（改之前 persistRunning / recordModelHealth 就是要一次写一次）
    runs = 0; live = 0; maxLive = 0;
    const naive = { request() { job(); } };
    for (let i = 0; i < 100; i++) naive.request();
    await until(() => live === 0);
    ok(`★反向对照★ 不排班：同样 100 次就是 ${runs} 趟、路上同时 ${maxLive} 趟（先开的可能后落地）`, runs === 100 && maxLive > 1, { runs, maxLive });
  }
  {
    // flush 等的是「调用这一刻的内容」落地，不是路上那趟
    let value = "v1", started = 0;
    const landed = [];
    const c = store.coalesce(async () => {
      started++;
      const snap = value;
      await new Promise((r) => setTimeout(r, 30));
      landed.push(snap);
    }, { minGapMs: 60000 });
    c.request();
    await null; await null; // 第一趟在微任务里开笔，拿的是 v1
    value = "v2";
    const t = await Promise.race([c.flush().then(() => "done"), new Promise((r) => setTimeout(() => r("hung"), 10000))]);
    ok(`flush：间隔 60 秒也不等；回来时盘上是调用那一刻的内容（落地顺序 ${landed.join("→")}）`, t === "done" && same(landed, ["v1", "v2"]) && started === 2, { t, landed, started });
    ok("★反向对照★ 路上那趟拿的是旧内容：flush 要是只等它，回来时盘上是 v1", landed[0] === "v1", landed);
  }
  {
    let runs = 0;
    const c = store.coalesce(async () => { runs++; }, { minGapMs: 60000 });
    c.request();
    await until(() => !c.busy());
    c.request(); // 排在 60 秒间隔后面
    const queued = c.busy();
    c.cancel();
    ok("排在间隔后面的那趟 cancel 掉：不再 busy、也不会再跑", queued && !c.busy() && runs === 1, { queued, runs });
    await c.flush();
    ok("cancel 之后再 flush：照样立刻写一趟新的", runs === 2, runs);
  }
  {
    const errs = [];
    const c = store.coalesce(async () => { throw new Error("写不进去"); }, { onError: (e) => errs.push(e.message) });
    const t = await Promise.race([c.flush().then(() => "done"), new Promise((r) => setTimeout(() => r("hung"), 10000))]);
    ok("job 抛了：flush 照样回来（不把收尾挂住），错误交给 onError 留痕", t === "done" && same(errs, ["写不进去"]), { t, errs });
  }
}

async function partC(agent) {
  console.log("\n— C. 每一步的中止信号：用完就摘，收得回来 —");
  const { stepSignal } = agent;
  const N = 2000;
  async function freed(make) {
    let n = 0;
    const reg = new FinalizationRegistry(() => { n++; });
    const stall = new AbortController(), stop = new AbortController(); // 一整趟任务都活着的源头
    for (let i = 0; i < N; i++) reg.register(make(stall.signal, stop.signal), i);
    for (let i = 0; i < 20 && n < N; i++) { global.gc(); await new Promise((r) => setTimeout(r, 10)); }
    return { n, alive: !stall.signal.aborted && !stop.signal.aborted };
  }
  const HALF_HOUR = 30 * 60 * 1000;
  const mine = await freed((a, b) => { const x = stepSignal([a, b], HALF_HOUR); x.release(); return x.signal; });
  ok(`stepSignal 跑 ${N} 步：回收了 ${mine.n} 个`, mine.alive && mine.n >= N * 0.95, mine);
  const old = await freed((a, b) => AbortSignal.any([a, b, AbortSignal.timeout(HALF_HOUR)]));
  ok(`★反向对照★ 换回 AbortSignal.any + 半小时 timeout：${N} 个只回收了 ${old.n} 个`, old.alive && old.n <= N * 0.05, old);

  const a = new AbortController(), b = new AbortController();
  const x = stepSignal([a.signal, null, b.signal], 60000);
  const hooked = getEventListeners(a.signal, "abort").length + getEventListeners(b.signal, "abort").length;
  b.abort(new Error("用户点了停止"));
  ok("停止先到：这一步跟着掐，原因原样带过来", x.signal.aborted && x.signal.reason && x.signal.reason.message === "用户点了停止");
  x.release();
  const left = getEventListeners(a.signal, "abort").length + getEventListeners(b.signal, "abort").length;
  ok(`release 之后源头上的监听 ${hooked} → ${left}`, hooked === 2 && left === 0, { hooked, left });
  const a2 = new AbortController();
  const y = stepSignal([a2.signal], 60000);
  ok("★反向对照★ 不 release：源头上那个监听一直挂着（攒下来的就是这一份）", getEventListeners(a2.signal, "abort").length === 1);
  y.release();
  const a3 = new AbortController();
  const z = stepSignal([a3.signal], 60000);
  z.release();
  a3.abort(new Error("下一步才停"));
  ok("release 之后源头再掐，已经跑完的这一步不受牵连", !z.signal.aborted);
  const t = stepSignal([new AbortController().signal], 20);
  await until(() => t.signal.aborted, 5000);
  ok("总时长到点：按超时掐，原因叫 TimeoutError（跟 AbortSignal.timeout 同一个名字）", t.signal.aborted && t.signal.reason && t.signal.reason.name === "TimeoutError", t.signal.reason && t.signal.reason.name);
  t.release();
  const d = new AbortController();
  d.abort(new Error("早就停了"));
  const u = stepSignal([d.signal], 60000);
  ok("源头早就掐了：一出生就是掐掉的", u.signal.aborted && u.signal.reason && u.signal.reason.message === "早就停了");
  u.release();
}

// ---------------- D 组：翻工作目录挪进后台线程 ----------------
let mt = Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000);
/** 铺一个文件。mtime 一个比一个早 7 秒：同一毫秒的并列怎么排，广度 / 深度优先两种走法本来就不保证一样 */
function put(root, rel, body) {
  const f = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  mt -= 7;
  fs.utimesSync(f, mt, mt);
  return rel;
}

async function partD(agent) {
  console.log("\n— D. 翻工作目录：后台线程走、几条对话共用一趟、结果逐条对得上 —");
  const tools = require(mod("tools"));
  const wsb = require(mod("ws-browse"));
  const sweep = require(mod("sweep"));
  const { dataPath } = require(mod("paths"));
  const { makeFilesEmitter, makeOwnership, scanOutputs, sweepPlanOffThread, _scan } = agent;
  const S = _scan.stats;
  // 把 agent.js 某一行换回老写法、另载一份（线程、hub、账本都是它自己的）：反向对照用
  const Module = require("module");
  const patchedAgent = (re, to, what) => {
    const file = mod("agent");
    let code = fs.readFileSync(file, "utf8");
    if (!re.test(code)) throw new Error(`agent.js 里「${what}」那一行找不到了，反向对照没法做`);
    code = code.replace(re, to);
    const m = new Module(file, module);
    m.filename = file;
    m.paths = Module._nodeModulePaths(ROOT);
    m._compile(code, file);
    return m.exports;
  };
  const RUN_LINE = /AsyncResource\.bind\(\(raw, w\) => \{ if \(!dead\) withWorkspace\(hub\.root, \(\) => apply\(filesOf\(raw\), snapOf\(raw, base\), w\)\); \}\)/;
  const UNBOUND_RUN = "((raw, w) => { if (!dead) apply(filesOf(raw), snapOf(raw, base), w); })";
  const BOUND_ONLY_RUN = "AsyncResource.bind((raw, w) => { if (!dead) apply(filesOf(raw), snapOf(raw, base), w); })";
  const CEDE_LINE = /const cede = w && w\.batch && w\.batch\.length > 1 \? \(f\) => cedeTo\(w\.batch, f, runToken\) : null;/;

  const WS = path.resolve(HOME, "ws1");
  const DUP = "同一份内容".repeat(40);
  put(WS, "说明.txt", "hello world");
  put(WS, "dup.bin", DUP);
  put(WS, "任务_1/copy.bin", DUP);
  put(WS, "任务_1/报告.md", "# 报告\n" + "x".repeat(123));
  put(WS, "任务_1/site/index.html", "<p>" + "y".repeat(77));
  put(WS, "任务_1/site/assets/img/deep.png", "z".repeat(501)); // 第 5 层：面板那份没有，整树快照里有
  put(WS, "任务_2/a/b/c/d/e/深.txt", "w".repeat(33));
  put(WS, "data/用户自己的.csv", "a,b\n1,2");                     // 用户自己叫 data 的文件夹：照列
  put(WS, ".git/HEAD", "ref");                                   // 下面这几个都该跳过
  put(WS, "node_modules/x/index.js", "1");
  put(WS, ".tmp/t.txt", "tmp");
  put(WS, ".hidden", "h");
  for (let i = 0; i < 30; i++) put(WS, `任务_3/批量/${String(i).padStart(2, "0")}.txt`, "q".repeat(200 + i));
  tools.setWorkspaceDir(WS);
  const scanMsg = (bases) => ({ op: "scan", root: WS, appDataDir: dataPath("data"), bases, filesCap: 500 });

  {
    const w0 = S.worker, l0 = S.local;
    const got = await scanOutputs(WS);
    const want = tools.withWorkspace(WS, () => tools.outputFiles());
    ok(`面板清单（后台线程走）跟 outputFiles() 逐条一样：${got.length} 条，重复标记也一样`, same(got, want) && want.some((f) => f.dup_of), { got: got.length, want: want.length });
    ok(`走的是后台线程（线程 +${S.worker - w0}、主线程 +${S.local - l0}）`, S.worker > w0 && S.local === l0);
    const raw = await _scan.runScan(scanMsg(["任务_1"]));
    const snap = _scan.snapOf(raw, "任务_1");
    const ref = tools.withWorkspace(WS, () => tools.turnSnapshot("任务_1"));
    ok(`整树快照跟 turnSnapshot() 一样：${snap.files.length} 个，第 5 层、第 7 层的都在`,
      same(byName(snap.files), byName(ref.files)) && snap.capped === ref.capped && snap.files.some((f) => f.name.endsWith("deep.png")) && snap.files.some((f) => f.name.endsWith("深.txt")));
  }
  {
    // 整树撞了条数上限。线程里是另一份 ws-browse，替换不到：这一段让同一段 scanTree 在主线程跑
    const realWalk = wsb.walkAll;
    wsb.walkAll = (root, o) => realWalk(root, path.resolve(root) === WS && o && o.maxDepth === Infinity ? { ...o, cap: 12 } : o);
    _scan.setBroken(_scan.BROKEN_MAX);
    try {
      const raw = await _scan.runScan(scanMsg(["任务_1"]));
      const snap = _scan.snapOf(raw, "任务_1");
      const ref = tools.withWorkspace(WS, () => tools.turnSnapshot("任务_1"));
      ok("整树撞了上限：照实报 capped，这条对话自己的文件夹补走一遍并进来，跟 turnSnapshot() 一样",
        raw.capped && ref.capped && same(byName(snap.files), byName(ref.files)) && snap.files.some((f) => f.name.endsWith("deep.png")));
      const got = tools.withWorkspace(WS, () => _scan.filesOf(raw));
      ok("撞了上限时面板那份照样跟 outputFiles() 一样（改走一趟最深 3 层的）", same(got, tools.withWorkspace(WS, () => tools.outputFiles())));
    } finally { wsb.walkAll = realWalk; _scan.setBroken(0); }
  }
  {
    // 一条对话的发射器：主线程上翻了几次目录；跟同步那条路发出来的事件一字不差
    const B = "任务_1";
    const evA = [], evS = [];
    const ownA = makeOwnership(), ownS = makeOwnership();
    ownA.claimBaseDir(B, "r-async");
    ownS.claimBaseDir(B, "r-sync");
    const tA = tap(), tS = tap();
    const emA = await during(tA, async () => {
      const em = makeFilesEmitter({ emit: (e) => evA.push(e), ownership: ownA, baseDir: B, runToken: "r-async", scan: true });
      await em.ready;
      return em;
    });
    const emS = await during(tS, async () => makeFilesEmitter({ emit: (e) => evS.push(e), ownership: ownS, baseDir: B, runToken: "r-sync" }));
    fs.writeFileSync(path.join(WS, "任务_1", "新写的.md"), "这一轮写的");
    await during(tA, () => emA.push(true));
    await during(tS, async () => emS.push(true));
    emA.stop(); emS.stop();
    const rA = tA.n.readdirSync || 0, sA = tA.n.statSync || 0, rS = tS.n.readdirSync || 0, sS = tS.n.statSync || 0;
    ok(`后台那条路：开跑基线 + 收尾比对，主线程 readdir ${rA} 次、stat ${sA} 次`, rA === 0 && sA === 0, { rA, sA });
    ok(`★反向对照★ 同步那条路：同样两下，主线程 readdir ${rS} 次、stat ${sS} 次`, rS > 0 && sS > 0, { rS, sS });
    const last = (evs) => { const e = evs[evs.length - 1]; return e ? { ...e } : null; };
    ok("两条路发出来的 files 事件一字不差（面板清单、本回合改动、作用域）",
      same(last(evA), last(evS)) && same(last(evA).changed, ["任务_1/新写的.md"]), { a: last(evA) && last(evA).changed, s: last(evS) && last(evS).changed });
  }
  {
    // 5 条对话同一个工作目录：开跑、收尾都是同一刻，合成一趟走
    const K = 5;
    const own = makeOwnership();
    const evs = [], ems = [];
    for (let k = 0; k < K; k++) { own.claimBaseDir(`并发_${k}`, `r${k}`); fs.mkdirSync(path.join(WS, `并发_${k}`), { recursive: true }); evs.push([]); }
    const s0 = S.scans;
    for (let k = 0; k < K; k++) ems.push(makeFilesEmitter({ emit: (e) => evs[k].push(e), ownership: own, baseDir: `并发_${k}`, runToken: `r${k}`, scan: true }));
    await Promise.all(ems.map((e) => e.ready));
    const s1 = S.scans;
    for (let k = 0; k < K; k++) fs.writeFileSync(path.join(WS, `并发_${k}`, `产出_${k}.md`), `第${k}份`);
    const tp = tap((k, a) => k === "readdirSync" && path.resolve(String(a[0])) === WS);
    await during(tp, () => Promise.all(ems.map((e) => e.push(true))));
    const s2 = S.scans;
    ok(`${K} 条对话同一刻开跑：基线合成 ${s1 - s0} 趟`, s1 - s0 === 1, s1 - s0);
    ok(`${K} 条同一刻收尾：合成 ${s2 - s1} 趟，主线程翻根目录 ${tp.n.readdirSync || 0} 次`, s2 - s1 === 1 && !tp.n.readdirSync, { scans: s2 - s1, readdir: tp.n.readdirSync });
    ok("每条只认自己那份产出（共用一趟也没串到别的对话）",
      evs.every((e, k) => e.length > 0 && same(e[e.length - 1].changed, [`并发_${k}/产出_${k}.md`])), evs.map((e) => e.length && e[e.length - 1].changed));
    for (const e of ems) e.stop();
    ok("都停了：这个工作目录的 hub 登记清空、收掉", await until(() => ![..._scan.hubs.values()].some((h) => h.root === WS), 5000));

    const sync = [], sevs = [];
    const own2 = makeOwnership();
    for (let k = 0; k < K; k++) { own2.claimBaseDir(`同步_${k}`, `s${k}`); fs.mkdirSync(path.join(WS, `同步_${k}`), { recursive: true }); sevs.push([]); }
    for (let k = 0; k < K; k++) sync.push(makeFilesEmitter({ emit: (e) => sevs[k].push(e), ownership: own2, baseDir: `同步_${k}`, runToken: `s${k}` }));
    for (let k = 0; k < K; k++) fs.writeFileSync(path.join(WS, `同步_${k}`, `产出_${k}.md`), `第${k}份`);
    const tq = tap((k, a) => k === "readdirSync" && path.resolve(String(a[0])) === WS);
    await during(tq, async () => { for (const e of sync) e.push(true); });
    for (const e of sync) e.stop();
    ok(`★反向对照★ 同步那条路：${K} 条同一刻收尾，主线程把根目录翻了 ${tq.n.readdirSync || 0} 遍（每条两遍）`, (tq.n.readdirSync || 0) >= 2 * K, tq.n.readdirSync);
  }
  {
    // 节流那条路：走树途中又写了一个，不靠收尾那一下也得补一趟看见它
    const own = makeOwnership();
    own.claimBaseDir("续写", "rr");
    fs.mkdirSync(path.join(WS, "续写"), { recursive: true });
    const ev = [];
    const em = makeFilesEmitter({ emit: (e) => ev.push(e), ownership: own, baseDir: "续写", runToken: "rr", scan: true });
    await em.ready;
    fs.writeFileSync(path.join(WS, "续写", "一.md"), "1");
    const s0 = S.scans;
    em.push(); em.push(); em.push();
    await until(() => S.scans > s0);
    fs.writeFileSync(path.join(WS, "续写", "二.md"), "2");
    em.push();
    const seen = await until(() => ev.some((e) => e.changed.includes("续写/二.md")));
    const first = ev.some((e) => e.changed.includes("续写/一.md"));
    ok(`节流那条路：连着要三次、途中又写一个，${S.scans - s0} 趟走完两个都报了（不靠收尾那一下）`, first && seen, { first, seen, scans: S.scans - s0 });
    em.stop();
  }
  {
    // 线程认栽 / 线程半路没了：产出一条不少
    _scan.setBroken(_scan.BROKEN_MAX);
    const l0 = S.local, w0 = S.worker;
    let got;
    try { got = await scanOutputs(WS); } finally { _scan.setBroken(0); }
    ok("后台线程认栽之后退回主线程走：清单照样跟 outputFiles() 一样",
      same(got, tools.withWorkspace(WS, () => tools.outputFiles())) && S.local > l0 && S.worker === w0, { local: S.local - l0, worker: S.worker - w0 });
    await _scan.runScan(scanMsg([]));
    const rec = _scan.worker();
    const c0 = S.crashed;
    const p = _scan.runScan(scanMsg([]));
    const inHand = rec ? rec.jobs.size : 0;
    if (rec) rec.w.terminate();
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res(null), 15000))]);
    ok(`线程手上有 ${inHand} 件活时被掐：那件活在主线程补走完，调用方照样拿到结果`, !!rec && inHand === 1 && !!r && Array.isArray(r.top) && r.top.length > 0);
    ok("记了一次崩溃", S.crashed === c0 + 1, S.crashed - c0);
    _scan.setBroken(0);
    const r2 = await _scan.runScan(scanMsg([]));
    ok("下一件活另起一个线程接着干", !!_scan.worker() && _scan.worker() !== rec && Array.isArray(r2.top));
  }
  {
    // 回合收尾那张清理卡（sweep.plan）也在后台算，结果一样
    const WS2 = path.resolve(HOME, "ws2");
    put(WS2, "任务_a/成片.mp4", "v".repeat(5000));
    for (let i = 0; i < 25; i++) put(WS2, `任务_a/frames/frame_${String(i).padStart(3, "0")}.png`, "p".repeat(100 + i));
    put(WS2, "任务_a/build/app.js", "console.log(1)");
    put(WS2, "任务_a/src/main.js", "console.log(2)");
    const want = sweep.plan(WS2, {}), got = await sweepPlanOffThread(WS2, {});
    const wantT = sweep.plan(WS2, { task: "任务_a", since: 0 }), gotT = await sweepPlanOffThread(WS2, { task: "任务_a", since: 0 });
    ok("清理卡在后台算：跟 sweep.plan() 一样（整区 / 按任务两种）", same(got, want) && same(gotT, wantT) && JSON.stringify(want).includes("frames"), { want: JSON.stringify(want).slice(0, 200) });
  }
  {
    // 结果是从线程消息里回来的：比对、作用域得落在建发射器时那个工作目录上，不是调 push 那一刻的默认根
    const WSA = path.resolve(HOME, "wsA");
    const alsCase = async (mod, tag) => {
      const dir = `任务_${tag}`;
      fs.mkdirSync(path.join(WSA, dir), { recursive: true });
      const own = mod.makeOwnership();
      own.claimBaseDir(dir, tag);
      const ev = [];
      const em = tools.withWorkspace(WSA, () => mod.makeFilesEmitter({ emit: (e) => ev.push(e), ownership: own, baseDir: dir, runToken: tag, scan: true }));
      await em.ready;
      fs.writeFileSync(path.join(WSA, dir, "只在A.md"), "a");
      const here = tools.getWorkspaceDir();
      await em.push(true); // 故意在默认根（WS）下调
      em.stop();
      const last = ev[ev.length - 1];
      return { here, root: last && last.root, changed: last && last.changed };
    };
    const keyA = tools.workspaceKeyOf(WSA);
    const now = await alsCase(agent, "als");
    ok("在默认根下调 push：这一趟照样比对 A、作用域报 A（绑回了建发射器时那条链）",
      now.here === WS && now.root === keyA && same(now.changed, ["任务_als/只在A.md"]), now);
    const old = await alsCase(patchedAgent(RUN_LINE, UNBOUND_RUN, "绑回工作目录"), "unbound");
    ok("★反向对照★ 摘掉 AsyncResource.bind 和钉根：同样在默认根下调，作用域报成了默认根", old.root === tools.workspaceKeyOf(WS) && old.root !== keyA, { ...old, keyA });
  }
  {
    // 跑到一半切了项目（默认根换了）：这一趟的清单是原来那个目录的，比对、作用域也得落在原来那个目录上
    const WSP = path.resolve(HOME, "wsP");
    const switchCase = async (mod, tag) => {
      const dir = `任务_${tag}`;
      fs.mkdirSync(path.join(WSP, dir), { recursive: true });
      const own = mod.makeOwnership();
      own.claimBaseDir(dir, tag);
      const ev = [];
      let em;
      tools.setWorkspaceDir(WSP);
      try {
        em = mod.makeFilesEmitter({ emit: (e) => ev.push(e), ownership: own, baseDir: dir, runToken: tag, scan: true });
        await em.ready;
        fs.writeFileSync(path.join(WSP, dir, "切之前写的.md"), "p");
      } finally { tools.setWorkspaceDir(WS); } // 用户在设置里换了项目
      await em.push(true);
      em.stop();
      const last = ev[ev.length - 1];
      return { root: last && last.root, changed: last && last.changed };
    };
    const keyP = tools.workspaceKeyOf(WSP);
    const now = await switchCase(agent, "sw");
    ok("跑到一半切了项目：这一趟照样比对原目录、作用域报原目录", now.root === keyP && same(now.changed, ["任务_sw/切之前写的.md"]), { ...now, keyP });
    const old = await switchCase(patchedAgent(RUN_LINE, BOUND_ONLY_RUN, "钉根"), "swold");
    ok("★反向对照★ 只绑链不钉根：同样切了项目，作用域报成了新项目", old.root === tools.workspaceKeyOf(WS) && old.root !== keyP, { ...old, keyP });
  }
  {
    // 两条对话同一个工作目录、同一趟扫描都看见一个根目录新文件（脚本顺手生成的，没有工具点名写它）：
    // 归写好之后头一个报工具跑完的那条（A），不归回调先跑的那条（B 先排的队）
    const WSC = path.resolve(HOME, "wsC");
    const cedeCase = async (mod, tag) => {
      const own = mod.makeOwnership();
      const ev = { A: [], B: [] }, em = {};
      for (const k of ["B", "A"]) {
        const dir = `任务_${tag}${k}`;
        fs.mkdirSync(path.join(WSC, dir), { recursive: true });
        own.claimBaseDir(dir, tag + k);
        em[k] = tools.withWorkspace(WSC, () => mod.makeFilesEmitter({ emit: (e) => ev[k].push(e), ownership: own, baseDir: dir, runToken: tag + k, scan: true }));
      }
      await Promise.all([em.A.ready, em.B.ready]); // 基线刚走完：下一趟要等间隔，B、A 两次 push 拼进同一趟
      const scans = mod._scan.stats.scans;
      const pB = em.B.push();                      // B 的工具先跑完（那会儿文件还没写）
      await new Promise((r) => setTimeout(r, 30));
      const name = `${tag}_汇总.csv`;
      fs.writeFileSync(path.join(WSC, name), "a,b");
      await new Promise((r) => setTimeout(r, 30));
      const pA = em.A.push();                      // 写它的 A 这会儿才报工具跑完
      await Promise.all([pA, pB]);
      em.A.stop(); em.B.stop();
      const got = (k) => ev[k].flatMap((e) => e.changed || []);
      return { A: got("A"), B: got("B"), name, scans: mod._scan.stats.scans - scans };
    };
    const now = await cedeCase(agent, "ce");
    ok("同一趟里两条对话都看见一个根目录新文件：归写好之后先报到的 A，B 先排队也不抢",
      now.scans === 1 && same(now.A, [now.name]) && same(now.B, []), now);
    const old = await cedeCase(patchedAgent(CEDE_LINE, "const cede = null;", "让给先报到的"), "ceold");
    ok("★反向对照★ 不让：同一趟里回调先跑的 B 把它抢走了", old.scans === 1 && same(old.B, [old.name]) && same(old.A, []), old);
  }
  {
    // 点名写的（write_file / edit_file、CLI 的 Write / Edit）：谁写的归谁，谁先比对、谁先报到都不算数
    const { cedeTo, wroteName } = agent;
    const own = makeOwnership();
    own.claimBaseDir("任务_a", "A");
    own.claimBaseDir("任务_b", "B");
    const f = { name: "汇总.csv", mtime: new Date().toISOString() };
    own.wrote("汇总.csv", "A");
    ok("A 点名写的根目录文件：B 先比对也不归 B", own.mine(f, "任务_b", "B") === false);
    ok("A 自己比对到：归 A，点名那条销掉", own.mine(f, "任务_a", "A") === true && !own._writes.has("汇总.csv"));
    const g = { name: "任务_b/草稿.md", mtime: new Date().toISOString() };
    own.wrote("任务_b/草稿.md", "A");
    ok("A 点名改了 B 文件夹里的一份：归 A（用户让它改的，改完就是它这一轮的产出）",
      own.mine(g, "任务_b", "B") === false && own.mine(g, "任务_a", "A") === true);
    const own2 = makeOwnership();
    own2.claimBaseDir("任务_a", "A");
    own2.claimBaseDir("任务_b", "B");
    ok("★反向对照★ 没人点名：谁先比对归谁（B 先到就给了 B）", own2.mine(f, "任务_b", "B") === true && own2.mine(f, "任务_a", "A") === false);
    const own3 = makeOwnership();
    own3.wrote("旧.md", "A", Date.now() - 3 * 60_000);
    ok("点名记了太久（扫描早走过了）：不作数", own3.writerOf("旧.md") === undefined && !own3._writes.has("旧.md"));
    const root = path.resolve(HOME, "wsC");
    ok("工具报的绝对路径换成清单里的名字：工作目录里的按斜杠拼，外面的、根目录本身都不算",
      wroteName(path.join(root, "任务_a", "x.md"), root) === "任务_a/x.md" && wroteName(path.join(root, "..", "外面.md"), root) === "" && wroteName(root, root) === "" && wroteName(null, root) === "");
    const t = Date.parse(f.mtime);
    const batch = [{ who: "B", ats: [t - 50] }, { who: "A", ats: [t + 10] }];
    ok("判归属：写好之后头一个报到的是 A → B 让、A 不让", cedeTo(batch, f, "B") === true && cedeTo(batch, f, "A") === false);
    ok("两条都是写好之后才报到：让给先到的那条", cedeTo([{ who: "B", ats: [t + 90] }, { who: "A", ats: [t + 10] }], f, "B") === true);
    ok("谁都在它写好之前报的（还在跑的脚本写的）：判不出，谁也不让", cedeTo([{ who: "B", ats: [t - 90] }, { who: "A", ats: [t - 10] }], f, "B") === false && cedeTo([{ who: "B", ats: [t - 90] }, { who: "A", ats: [t - 10] }], f, "A") === false);
    ok("时间戳读不出来：不让", cedeTo(batch, { name: "x", mtime: "?" }, "B") === false);
  }
}

function partE() {
  console.log("\n— E. 接线：服务端真走的是新路 —");
  const S = src("server");
  const AG = fs.readFileSync(mod("agent"), "utf8");
  // 注释里会提到老写法，钉代码只看不是注释的行
  const code = (t) => t.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  ok("回合收尾：面板清单走 scanOutputs、清理卡走 sweepPlanOffThread",
    /await scanOutputs\(getWorkspaceDir\(\)\)/.test(S) && /await sweepPlanOffThread\(getWorkspaceDir\(\)/.test(S));
  ok("回合收尾：await flushSessionSave(sessionId) 紧挨在 done 前面（界面说「完成」时记录已在盘上）",
    /await flushSessionSave\(sessionId\);\s*send\(\{ type: "done" \}\);/.test(S));
  ok("/api/files（输入框敲 @ 就拉）也走后台", /app\.get\("\/api\/files", [^\n]*scanOutputs\(/.test(S));
  ok("进程退出补写：exit 钩子挂着，第一件就是会话",
    /process\.on\("exit", flushPendingWritesSync\)/.test(S) && /function flushPendingWritesSync\(\) \{\s*flushSessionSavesSync\(\);/.test(S));
  ok("两处任务发射器都走后台（scan: true），开跑前都等基线落定",
    (AG.match(/scan: true/g) || []).length >= 2 && (AG.match(/await filesOut\.ready;/g) || []).length === 2);
  ok("每一步的中止信号是 stepSignal，finally 里 release；agent.js 代码里不再有 AbortSignal.any(",
    /stepSignal\(\[stallCtl\.signal, stopSignal\]/.test(AG) && /stepSig\.release\(\);/.test(AG) && !/AbortSignal\.any\(/.test(code(AG)));
  const CC = fs.readFileSync(mod("claude-code"), "utf8");
  const CX = fs.readFileSync(mod("codex"), "utf8");
  ok("点名写的文件记上是谁写的：自带工具看 editedFile，两个 CLI 引擎各自回调 onWrite",
    /if \(res && res\.editedFile\) noteWrote\(res\.editedFile, runToken\);/.test(AG) && /onWrite: \(abs\) => noteWrote\(abs, runToken\)/.test(AG)
      && /onWrite\(path\.resolve\(cwd, target\)\)/.test(CC) && /for \(const p of changedPaths\(item, cwd\)\)[^\n]*onWrite\(p\)/.test(CX));
  ok("比对钉在这个 hub 的根上跑（中途切项目不串）", /withWorkspace\(hub\.root, \(\) => apply\(/.test(AG));
}

(async () => {
  await partA();
  await partB();
  const agent = require(mod("agent"));
  await partC(agent);
  await partD(agent);
  partE();
  finished = true;
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  fail++;
  finished = true;
  console.log("  ✗ 测试自己抛了：" + ((e && e.stack) || e));
  process.exit(1);
});
