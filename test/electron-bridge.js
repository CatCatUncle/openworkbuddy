// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 服务进程 ↔ 桌面主进程的桥：每个 op 都走得通一个来回，每个都有超时，主进程不在时报的是实话。
 *
 * 跑法：node test/electron-bridge.js（纯 node，不开窗口、不弹框、不碰剪贴板）
 *
 * 2026-09-29 审计：几个对话一起跑时桌面版主进程事件循环 p99 68ms、最长 330ms，用户原话「开几个对话
 * 整个应用连带电脑都卡」。服务端挪进 utilityProcess 以后，dialog / shell / clipboard / nativeImage /
 * 离屏窗口 / powerSaveBlocker 在那边全没了，调用点改成发消息问主进程（electron-bridge.js ↔ bridge-main.js）。
 * 真的 utilityProcess 在 test/server-process.js 里起；这里把每个 op 在纯 node 里过一遍，快、能上 CI：
 *
 *   父进程 = 主进程：真的 bridge-main.js + 假 electron（dialog、shell、clipboard、nativeImage、
 *            powerSaveBlocker 全记账）；开窗口那几个模块（web-window / htmlshot / browser-render /
 *            htmlvideo / thumb）在父进程里换成桩，桩只记「谁用什么参数叫了我」。
 *   子进程 = 服务进程：OWB_BRIDGE=1 + IPC 冒充 utilityProcess 的 parentPort，协议一个字不差。
 *            走的是真调用点（browser-render.svgToPng、tools.checkPage、thumb.thumbFileAsync……），
 *            不是直接 bridge.call——调用点漏接一处，这里就红。
 *
 * ★反向对照★
 *   - 同一批调用点，子进程冒充 utilityProcess 但不开桥（= 挪进去之前的代码）：每一个都失败或退化；
 *   - paths.js 删掉 utility 那一行：OWB_PACKAGED=1 也答「不是装机包」（装机版会拿应用包当数据根）；
 *   - 挂住不回的 op 不给超时：1.5 秒后还挂着（给了超时的那一次 0.3 秒就报错回来）；
 *   - 通道断了但没接 disconnect：挂着的调用一直挂着（接了的那一次立刻报「连接断了」）；
 *   - 源码里的 op 清单塞一个 bridge-main 没有的名字：一致性检查当场认出来。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const zlib = require("zlib");
const { fork } = require("child_process");
const { mod } = require("./lib/mod");

const ROOT = path.join(__dirname, "..");
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === "--child") childMain();
else parentMain();

// =====================================================================================
// 子进程：扮服务进程。父进程发 {t:"run", step} 过来，跑完回 {t:"done"}（测试自己的消息，不走桥）
// =====================================================================================
function childMain() {
  const tag = process.argv[3] || "remote";
  // 冒充 utilityProcess：process.type 是 "utility"、带 Electron 版本号，require("electron") 却什么 API 都没有
  // （纯 node 里它返回的是一个路径字符串）——跟真的服务进程里「dialog、nativeImage 全没了」是一回事
  if (tag === "utility" || tag === "old-utility") {
    /** @type {any} */ (process).type = "utility";
    Object.assign(process.versions, { electron: "43.0.0" });
  }
  const bridge = require(mod("electron-bridge"));
  const seen = { states: 0, ctl: /** @type {any[]} */ ([]) };
  // 桥走 IPC 时会 unref 通道（纯 node 里别吊着不退），测试子进程得自己撑着，等父进程说退再退
  const alive = setInterval(() => {}, 1 << 30);
  void alive;
  // gone-old：开局不碰桥的传输，好让下面换上一条「不接 disconnect」的
  if (bridge.isRemote() && tag !== "gone-old") {
    bridge.onState(() => { seen.states++; });
    bridge.onCtl((op, msg) => { seen.ctl.push({ op, x: msg && msg.x }); });
  }
  const dir = path.join(process.env.OWB_BRIDGE_TEST_DIR || os.tmpdir(), "files");
  const at = (n) => path.join(dir, n);
  const b64 = (v) => { const b = bridge.toBuf(v); return b ? b.toString("base64") : null; };
  const errOf = (e) => ({ message: String((e && e.message) || e), code: e && e.code, noRetry: e && e.noRetry });
  const keep = {}; // 跨 step 留着的东西（awake 的 release、断线那一段挂着的调用）

  /** @type {Record<string, (a:any)=>any>} */
  const S = {
    mode: () => ({ mode: bridge.mode(), remote: bridge.isRemote(), nodeExec: bridge.nodeExec(), execPath: process.execPath }),
    state: () => ({ state: bridge.state(), caps: bridge.caps(), seen }),
    raw: async (a) => {
      const t0 = Date.now();
      try { return { ok: true, value: await bridge.call(a.op, a.args, a.timeoutMs ? { timeoutMs: a.timeoutMs } : undefined), ms: Date.now() - t0 }; }
      catch (e) { return { ok: false, error: errOf(e), ms: Date.now() - t0 }; }
    },
    note: (a) => bridge.notify(a.op, a.args),
    // 一批 op 同时发出去，看每一个是不是都在超时后报错回来（父进程这时一概不回）
    allTimeout: async (a) => {
      const t0 = Date.now();
      const r = await Promise.allSettled(a.ops.map((op) => bridge.call(op, {}, { timeoutMs: a.timeoutMs })));
      return { ms: Date.now() - t0, out: r.map((x, i) => ({ op: a.ops[i], ok: x.status === "fulfilled", error: x.status === "rejected" ? errOf(x.reason) : null })) };
    },
    // 超时之后才到的回信不许搅局：下一个调用照常
    late: async () => {
      let first = null;
      try { await bridge.call("test.slow", { ms: 500 }, { timeoutMs: 150 }); } catch (e) { first = errOf(e); }
      await sleep(700);
      const second = await bridge.call("test.echo", { v: 42 });
      return { first, second };
    },
    // ★反向对照★ 不给超时（给一个很长的）：主进程不回，1.5 秒后还挂着
    noTimeout: async () => {
      let settled = false;
      bridge.call("test.hang", null, { timeoutMs: 60000 }).then(() => { settled = true; }, () => { settled = true; });
      await sleep(1500);
      return { settled };
    },
    available: () => require(mod("browser-render")).available(),
    svg: async () => b64(await require(mod("browser-render")).svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"></svg>', 3)),
    mermaid: async (a) => require(mod("browser-render")).renderMermaid("graph TD; A-->B", a.theme),
    shot: async (a) => b64(await require(mod("htmlshot")).renderHtmlToPng(at(a.name), { width: 300, height: 200 })),
    motion: async () => {
      const d = await require(mod("htmlvideo")).remoteElectronDriver({ width: 4, height: 3, runtime: "rt-main" });
      await d.load("file:///owb-bridge-test/page.html");
      const ev = await d.evaluate("window.__frame(3)");
      const f = await d.capture();
      const png = f.png();
      d.hang();
      await d.close();
      let after = "";
      try { await d.load("file:///owb-bridge-test/again.html"); } catch (e) { after = String(e.message); }
      return { backend: d.backend, format: d.format, ev, rawLen: f.buf.length, raw0: [...f.buf.subarray(0, 4)], png: png.toString("base64"), after };
    },
    motionShort: async () => {
      const d = await require(mod("htmlvideo")).remoteElectronDriver({ width: 5, height: 3, runtime: "short" });
      try { await d.capture(); return { threw: "" }; } catch (e) { return { threw: String(e.message) }; } finally { await d.close(); }
    },
    motionLeft: async () => { await require(mod("htmlvideo")).remoteElectronDriver({ width: 2, height: 2, runtime: "left" }); return true; },
    thumb: async (a) => {
      const out = await require(mod("thumb")).thumbFileAsync(at("photo-800x600.jpg"), 160, path.join(dir, a.cache || "thumbs"));
      return { out, body: out && fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null };
    },
    vision: async (a) => {
      const got = await require("../src/tools/media").readImageInput(a.name, (s) => at(s), "图片");
      return { err: got.err || "", mime: got.mime, note: got.note, head: got.b64 ? Buffer.from(got.b64, "base64").subarray(0, 24).toString("latin1") : "" };
    },
    checkPage: async (a) => require(mod("tools"))._internals.checkPage(at(a.name), a.name),
    renderPage: async () => {
      try { return { ok: true, v: await require(mod("tools")).renderPage("https://owb-bridge-test.invalid/a", { waitMs: 5, maxWaitMs: 10 }) }; }
      catch (e) { return { ok: false, error: errOf(e) }; }
    },
    awakeHold: () => { (keep.rel = keep.rel || []).push(require(mod("awake")).hold()); return keep.rel.length; },
    awakeRelease: () => { for (const r of (keep.rel || []).splice(0)) r(); return true; },
    // 断线：先挂两个调用（一个走真调用点），父进程随后断开通道。结果只能打到 stdout 上（IPC 已经没了）
    goneArm: () => {
      const report = (k, p) => p.then((v) => console.log(`GONE ${JSON.stringify({ k, ok: true, v: String(v).slice(0, 40) })}`),
        (e) => console.log(`GONE ${JSON.stringify({ k, ok: false, error: errOf(e) })}`));
      report("svg", require(mod("browser-render")).svgToPng("<svg/>", 1));
      report("raw", bridge.call("test.anything", null, { timeoutMs: 60000 }));
      process.once("disconnect", () => setTimeout(() => {
        report("after", bridge.call("svg.png", {}, { timeoutMs: 60000 }));
        console.log(`GONE ${JSON.stringify({ k: "notify", v: bridge.notify("pet.show") })}`);
        setTimeout(() => process.exit(0), 300);
      }, 100));
      return true;
    },
    // ★反向对照★ 换一条不接 disconnect 的传输（桥里那条 disconnect 挂钩不存在时的样子）
    goneOld: () => {
      bridge._setTransport({ post: (m) => { process.send(m, () => {}); } });
      let settled = false;
      bridge.call("test.anything", null, { timeoutMs: 60000 }).then(() => { settled = true; }, () => { settled = true; });
      process.once("disconnect", () => setTimeout(() => {
        console.log(`GONE_OLD ${JSON.stringify({ settled })}`);
        process.exit(0);
      }, 1500));
      return true;
    },
    // 服务进程里要当 node 用的子进程：用主进程递过来的应用本体，不用 Helper（process.execPath）
    exec: () => {
      const paths = require(mod("paths"));
      const r = {
        nodeExec: bridge.nodeExec(),
        launcher: require(mod("bridge")).nodeLauncher(),
        pickNode: require(mod("win")).pickNode(path.join(dir, "no-such-shim"), { findIn: () => "", searchDirs: () => [] }).bin,
        packaged1: paths.isPackaged(),
        dataDir: paths.DATA_DIR,
      };
      const was = process.env.OWB_PACKAGED;
      process.env.OWB_PACKAGED = "0";
      r.packaged0 = paths.isPackaged();
      process.env.OWB_PACKAGED = was;
      // ★反向对照★ 同一份 paths.js 删掉 utility 那一行，重新编一个模块
      const src = fs.readFileSync(mod("paths"), "utf8");
      const cut = src.replace(/^[ \t]*if \([^\n]*process\)\.type === "utility"\)[^\n]*$/m, "");
      // 虚拟模块挨着真 paths.js 放：它源码里的相对 require（./root）按那个目录解析
      const file = path.join(path.dirname(mod("paths")), "paths.old-for-test.js");
      const m = new Module(file, module);
      m.filename = file;
      m.paths = /** @type {any} */ (Module)._nodeModulePaths(path.dirname(file));
      /** @type {any} */ (m)._compile(cut, file);
      r.cutChanged = cut !== src;
      r.oldPackaged1 = m.exports.isPackaged();
      return r;
    },
    runNode: async () => (await require(mod("tools"))._internals.runNode("console.log('owb-bridge-node-ok')", 20000)).content,
    selfCheckMjs: async () => {
      fs.writeFileSync(at("probe.mjs"), "export const a = 1;\n");
      return require(mod("tools"))._internals.selfCheck(at("probe.mjs"), "probe.mjs");
    },
    exit: () => { setTimeout(() => process.exit(0), 20); return true; },
  };

  process.on("message", async (m) => {
    if (!m || m.t !== "run") return;
    let out;
    try { out = { ok: true, value: await S[m.step](m.args || {}) }; } catch (e) { out = { ok: false, error: errOf(e) }; }
    try { if (process.connected) process.send({ t: "done", id: m.id, ...out }, () => {}); } catch {}
  });
  // 父进程没了：跟着走（断线那两段自己决定什么时候退）
  process.on("disconnect", () => { if (!keep.gone) setTimeout(() => process.exit(0), 2000); });
  S.goneArm = ((f) => (a) => { keep.gone = true; return f(a); })(S.goneArm);
  S.goneOld = ((f) => (a) => { keep.gone = true; return f(a); })(S.goneOld);
  process.send({ t: "ready", tag, mode: bridge.mode() });
}

// =====================================================================================
// 父进程：扮主进程
// =====================================================================================
function parentMain() {
  const HOME = require("./lib/own-home")("electron-bridge");
  const TEST_DIR = path.join(HOME, "bridge-test");
  const FILES = path.join(TEST_DIR, "files");
  fs.mkdirSync(FILES, { recursive: true });

  let pass = 0, fail = 0;
  const ok = (cond, msg, detail) => {
    if (cond) { pass++; console.log("  ✅ " + msg); }
    else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 900))); }
  };
  const section = (t) => console.log("\n" + t);

  // ---------- 记账 ----------
  const L = [];
  const rec = (k, v) => { L.push({ k, v }); };
  const mark = () => L.length;
  const since = (i, k) => L.slice(i).filter((x) => x.k === k).map((x) => x.v);

  // ---------- 开窗口那几个模块：父进程里换成桩（bridge-main 按相对路径 require，缓存里放好就行） ----------
  // 缓存键按 test/lib/mod.js 的名字取：搬了家键跟着走，不会放在一个没人来拿的旧路径上
  const stubbed = new Map();
  const stub = (name, exports) => {
    const file = mod(name);
    const m = new Module(file, module);
    m.filename = file;
    m.loaded = true;
    m.exports = exports;
    require.cache[file] = m;
    stubbed.set(name, exports);
  };
  stub("web-window", {
    probePage: async (electron, file) => {
      rec("probePage", { file, electronIsShell: electron === E.e });
      if (/boom/.test(file)) throw new Error("页面打不开（boom）");
      return { info: { t: "探针标题", n: 42, h: 900 }, errs: ["ReferenceError: x is not defined"], warns: [] };
    },
    readRendered: async (electron, url, o) => { rec("readRendered", { url, ...o, electronIsShell: electron === E.e }); return { text: "渲染后的正文", title: "页标题" }; },
  });
  stub("htmlshot", {
    renderHtmlToPng: async (p, opts) => { rec("shot", { p, opts }); return /empty/.test(p) ? Buffer.alloc(10) : Buffer.concat([PNG_SIG, Buffer.alloc(300, 7)]); },
  });
  stub("browser-render", {
    svgToPng: async (svg, scale) => { rec("svgToPng", { len: svg.length, scale }); return Buffer.concat([PNG_SIG, Buffer.from(`svg ${scale} ${svg.length}`)]); },
    renderMermaid: async (src, theme) => { rec("renderMermaid", { src, theme }); return `<svg data-theme="${theme}">${src}</svg>`; },
  });
  stub("htmlvideo", {
    electronDriver: async (o) => {
      rec("motion.open", o);
      const n = o.width * o.height * 4 - (o.runtime === "short" ? 4 : 0);
      return {
        load: async (url) => rec("motion.load", url),
        evaluate: async (expr) => { rec("motion.eval", expr); return { echo: expr, n: 7 }; },
        // BGRA：B=10 G=20 R=200 A=255。转 PNG 时要翻成 RGBA，不翻的话红蓝对调
        capture: async () => { const buf = Buffer.alloc(n); for (let i = 0; i + 3 < n; i += 4) { buf[i] = 10; buf[i + 1] = 20; buf[i + 2] = 200; buf[i + 3] = 255; } return { buf }; },
        hang: () => rec("motion.hang", o.runtime),
        close: async () => rec("motion.close", o.runtime),
      };
    },
  });
  stub("thumb", { makeThumb: (abs, w) => { rec("makeThumb", { abs, w }); return Buffer.from(`thumb ${w} ${path.basename(abs)}`); } });

  // ---------- 假 electron ----------
  function fakeElectron() {
    let pid = 0;
    const img = (w, h) => ({
      isEmpty: () => !(w > 0 && h > 0),
      getSize: () => ({ width: w, height: h }),
      crop: (r) => { rec("crop", r); return img(r.width, r.height); },
      resize: (o) => {
        rec("resize", o);
        const W = o.width || Math.round((w * o.height) / h), H = o.height || Math.round((h * o.width) / w);
        return img(W, H);
      },
      toPNG: () => Buffer.concat([PNG_SIG, Buffer.from(`png ${w}x${h}`)]),
      toJPEG: (q) => Buffer.from(`jpg ${w}x${h} q${q}`),
    });
    const on = new Set();
    const e = {
      dialog: {
        showOpenDialog: async (...a) => { rec("openDialog", { withWin: a.length === 2, opts: a[a.length - 1] }); return { canceled: false, filePaths: ["/picked/dir"] }; },
        showSaveDialog: async (...a) => { rec("saveDialog", { withWin: a.length === 2, opts: a[a.length - 1] }); return { canceled: false, filePath: "/picked/out.md", bookmark: "b" }; },
      },
      shell: {
        showItemInFolder: (p) => rec("reveal", p),
        // 照 Electron 的约定：成功回空串，失败回一句错误文字（不抛）。名字里带「坏」的当打不开
        openPath: async (p) => { rec("openPath", p); return /坏/.test(p) ? "Failed to open path" : ""; },
      },
      clipboard: { writeBuffer: (fmt, buf) => rec("clip", { fmt, isBuf: Buffer.isBuffer(buf), text: Buffer.isBuffer(buf) ? buf.toString("utf8") : null }) },
      session: {
        defaultSession: {
          clearCache: async () => rec("clearCache", true),
          clearCodeCaches: async (o) => rec("clearCodeCaches", o),
          clearStorageData: async (o) => rec("clearStorageData", o),
        },
      },
      nativeImage: {
        createFromPath: (p) => {
          rec("createFromPath", path.basename(p));
          if (/throws/.test(p)) throw new Error("nativeImage 读图出错（测试桩）");
          const m = /(\d+)x(\d+)/.exec(path.basename(p));
          return m ? img(+m[1], +m[2]) : img(0, 0);
        },
      },
      powerSaveBlocker: {
        start: (type) => { const id = ++pid; on.add(id); rec("power.start", type); return id; },
        stop: (id) => { on.delete(id); rec("power.stop", id); },
        isStarted: (id) => on.has(id),
      },
    };
    return { e };
  }
  const E = fakeElectron();
  const fakeWin = { isDestroyed: () => false, setFullScreen: (on) => rec("setFullScreen", on) };
  const fakePet = {
    setState: (s, t) => rec("pet.setState", { s, t }),
    alertAsk: (q) => rec("pet.alertAsk", q),
    clearAsk: (w) => rec("pet.clearAsk", w),
    applyConfig: (c) => rec("pet.applyConfig", c),
    show: () => rec("pet.show", true),
    hide: () => rec("pet.hide", true),
  };
  const bootLogs = [];
  const { createShellBridge } = require(mod("bridge-main"));
  // 正向对照：桩真的接得住 bridge-main 的 require——照它源码里的写法、从它所在的目录解析，拿到的得是桩。
  // 接不住的话下面跑的是真的 web-window / htmlshot（或者加载失败被吞），断言测的就不是这里以为的东西
  {
    const bridgeSrc = fs.readFileSync(mod("bridge-main"), "utf8");
    const fromBridge = Module.createRequire(mod("bridge-main"));
    const miss = [...stubbed].filter(([name, ex]) => {
      const spec = mod.spec("bridge-main", name);
      return !bridgeSrc.includes(`require(${JSON.stringify(spec)})`) || fromBridge(spec) !== ex;
    }).map(([name]) => name);
    ok(stubbed.size === 5 && miss.length === 0, `${stubbed.size} 个桩都接得住 bridge-main 的 require（写法按 mod 表算，从它的目录解析）`, miss);
  }
  const testOps = {
    "test.echo": async (a) => a,
    "test.slow": (a) => new Promise((r) => setTimeout(() => r("迟到的回信"), (a && a.ms) || 500)),
    "test.hang": () => new Promise(() => {}),
    "test.coded": async () => { const e = /** @type {any} */ (new Error("自带代码的错")); e.code = "E_TEST"; e.noRetry = true; throw e; },
  };
  const mkShell = (o = {}) => createShellBridge({
    electron: E.e, getWin: () => fakeWin, pet: () => fakePet,
    registerShortcuts: (s) => rec("shortcuts", s), relaunch: () => rec("relaunch", true), onApproval: (m) => rec("approval", m),
    bootLog: (l) => bootLogs.push(l), impl: testOps, ...o,
  });
  const shell = mkShell();
  const hiddenShell = mkShell({ hidden: true });
  let active = shell;
  let drop = false;

  // ---------- 拉一个子进程 ----------
  const kids = [];
  function launch(tag, env = {}) {
    const c = fork(__filename, ["--child", tag], {
      env: { ...process.env, OWB_BRIDGE_TEST_DIR: TEST_DIR, ...env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    kids.push(c);
    const out = { text: "" };
    c.stdout.on("data", (d) => { out.text += d; });
    c.stderr.on("data", (d) => { out.text += d; });
    const waiters = new Map();
    let seq = 0;
    let onReady;
    const ready = new Promise((r) => { onReady = r; });
    c.on("message", (m) => {
      if (!m || typeof m !== "object") return;
      if (m.t === "ready") return onReady(m);
      if (m.t === "done") { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); } return; }
      if (m.t === "call" || m.t === "note") {
        if (m.t === "call" && drop) return; // 扮一个卡死的主进程：收了不回
        active.handle(m, (r) => { if (c.connected) c.send(r, () => {}); });
      }
    });
    const exited = new Promise((r) => c.on("exit", (code, sig) => r({ code, sig })));
    const run = (step, args, ms = 20000) => {
      const id = ++seq;
      return new Promise((resolve) => {
        const t = setTimeout(() => { waiters.delete(id); resolve({ ok: false, error: { message: `子进程 ${ms}ms 没回（${step}）`, code: "HARNESS_TIMEOUT" } }); }, ms);
        waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
        c.send({ t: "run", id, step, args }, () => {});
      });
    };
    const v = async (step, args, ms) => {
      const r = await run(step, args, ms);
      if (!r.ok) console.log(`    （${tag} 子进程的 ${step} 自己抛了：${r.error && r.error.message}）`);
      return r.ok ? r.value : { __err: r.error };
    };
    const bye = async () => {
      if (c.connected) c.send({ t: "run", id: 0, step: "exit" }, () => {});
      await Promise.race([exited, sleep(3000)]);
      if (c.exitCode === null && c.signalCode === null) { try { c.kill("SIGKILL"); } catch {} }
    };
    return { c, out, ready, exited, run, v, bye };
  }

  const toBuf = require(mod("electron-bridge")).toBuf;
  const fromB64 = (s) => (typeof s === "string" ? Buffer.from(s, "base64") : Buffer.alloc(0));
  /** PNG → {w,h,rows}（只认 8 位 RGBA、过滤类型 0，bgraToPng 编的就是这种） */
  function decodePng(buf) {
    if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
    let o = 8, w = 0, h = 0;
    const idat = [];
    while (o < buf.length) {
      const len = buf.readUInt32BE(o), type = buf.toString("ascii", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
      if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
      if (type === "IDAT") idat.push(data);
      o += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    return { w, h, px: (x, y) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 4)], filter0: raw[0] };
  }

  // ---------- 测试用的文件 ----------
  const put = (n, bytes) => fs.writeFileSync(path.join(FILES, n), bytes);
  put("photo-800x600.jpg", Buffer.alloc(120 * 1024, 1));
  put("big-3000x2000.jpg", Buffer.alloc(950 * 1024, 2));
  put("throws-3000x2000.jpg", Buffer.alloc(950 * 1024, 3));
  put("small-100x100.png", Buffer.alloc(10 * 1024, 4));
  put("page.html", "<!doctype html><html><head><meta charset=utf-8><title>探针标题</title></head><body><h1>你好</h1></body></html>");
  put("boom.html", "<!doctype html><html><head><title>b</title></head><body>b</body></html>");
  put("card.html", "<!doctype html><html><body>卡片</body></html>");
  put("empty.html", "<!doctype html><html><body></body></html>");

  // 冒充「应用本体」的 node：记下每次被谁叫起来，再原样转给真 node
  const execLog = path.join(TEST_DIR, "exec.log");
  const wrapper = path.join(TEST_DIR, "app-binary.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${execLog}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });

  const STATE0 = JSON.stringify({ caps: { windows: true, pet: true }, winAlive: true, fullScreen: false });

  (async () => {
    // =================================================================================
    section("一、协议本身：来回、超时、迟到的回信、报错带码、不认识的 op");
    const K = launch("remote", { OWB_BRIDGE: "1", OWB_BRIDGE_IPC: "1", OWB_BRIDGE_STATE: STATE0 });
    const rd = await Promise.race([K.ready, sleep(15000).then(() => null)]);
    ok(rd && rd.mode === "remote", "子进程带 OWB_BRIDGE=1 + IPC：认自己是服务进程（remote）", rd);

    let r = await K.v("raw", { op: "test.echo", args: { a: [1, "二"], n: null } });
    ok(r.ok && JSON.stringify(r.value) === JSON.stringify({ a: [1, "二"], n: null }), "一个来回：参数原样到、结果原样回", r);

    r = await K.v("raw", { op: "test.hang", timeoutMs: 300 });
    ok(!r.ok && r.error.code === "SHELL_TIMEOUT" && r.error.message === "桌面主进程 0.3 秒内没回应（test.hang）" && r.ms >= 250 && r.ms < 3000,
      "主进程不回：0.3 秒报 SHELL_TIMEOUT，话里写着等了多久、哪个操作", r);
    r = await K.v("noTimeout");
    ok(r && r.settled === false, "★反向对照★ 同一个不回的 op 不给超时：1.5 秒后还挂着（工具会一直卡在那儿）", r);

    r = await K.v("late");
    ok(r && r.first && r.first.code === "SHELL_TIMEOUT" && r.second && r.second.v === 42,
      "超时之后才到的回信被丢掉，下一个调用照常拿到自己的结果", r);

    r = await K.v("raw", { op: "test.coded" });
    ok(!r.ok && r.error.code === "E_TEST" && r.error.noRetry === true && r.error.message === "自带代码的错",
      "主进程那边抛的错：message / code / noRetry 原样过来", r);
    r = await K.v("raw", { op: "nope.op" });
    ok(!r.ok && r.error.code === "NO_OP" && r.error.message === "桌面主进程不认识这个操作（nope.op）", "不认识的 op：NO_OP，话里带 op 名", r);

    // =================================================================================
    section("二、每个调用点走一个来回（子进程里走真调用点，父进程是真的 bridge-main + 假 electron）");
    let m0 = mark();
    ok((await K.v("available")) === true, "browser-render.available()：看主进程报上来的 caps.windows（true）");
    let s = await K.v("svg");
    let buf = fromB64(s);
    ok(buf.subarray(0, 8).equals(PNG_SIG) && /svg 3 \d+/.test(buf.subarray(8).toString()) && since(m0, "svgToPng").length === 1,
      "svg.png：svgToPng 在主进程里画、PNG 过 IPC 回来是 Buffer，倍率跟着过去", { tail: buf.subarray(8).toString(), calls: since(m0, "svgToPng") });
    m0 = mark();
    s = await K.v("mermaid", { theme: "dark" });
    const s2 = await K.v("mermaid", {});
    ok(s === '<svg data-theme="dark">graph TD; A-->B</svg>' && since(m0, "renderMermaid").length === 2 && since(m0, "renderMermaid")[1].theme === undefined,
      "mermaid.render：源码和主题过去、SVG 字符串回来；没给主题时主进程那边拿到 undefined（用默认配色）", { s, s2, calls: since(m0, "renderMermaid") });

    m0 = mark();
    s = await K.v("shot", { name: "card.html" });
    buf = fromB64(s);
    let shots = since(m0, "shot");
    ok(buf.length === 308 && shots.length === 1 && shots[0].p === path.join(FILES, "card.html")
      && JSON.stringify(shots[0].opts) === JSON.stringify({ width: 300, height: 200, fullPage: false, waitMs: 500 }),
    "shot.html：htmlshot 带绝对路径和尺寸问主进程，PNG 原样回来", { len: buf.length, shots });
    s = await K.v("shot", { name: "empty.html" });
    ok(s && s.__err && /截图结果为空/.test(s.__err.message), "shot.html 回来的图不到 100 字节：照旧报「截图结果为空」", s);

    m0 = mark();
    s = await K.v("motion");
    const png = decodePng(fromB64(s && s.png));
    const opened = since(m0, "motion.open");
    ok(s && s.backend === "electron" && s.format === "bgra" && opened.length === 1 && opened[0].width === 4 && opened[0].runtime === "rt-main",
      "motion.open：离屏窗口在主进程开，尺寸和时钟脚本跟过去", { opened, backend: s && s.backend });
    ok(since(m0, "motion.load")[0] === "file:///owb-bridge-test/page.html" && s.ev && s.ev.echo === "window.__frame(3)" && s.ev.n === 7,
      "motion.load / motion.eval：地址和表达式过去、求值结果回来", { load: since(m0, "motion.load"), ev: s && s.ev });
    ok(s.rawLen === 48 && JSON.stringify(s.raw0) === "[10,20,200,255]" && png && png.w === 4 && png.h === 3 && png.filter0 === 0,
      "motion.capture：BGRA 裸像素 4×3×4=48 字节原样回来，这边编成 4×3 的 PNG", { rawLen: s.rawLen, png: png && { w: png.w, h: png.h } });
    ok(png && JSON.stringify(png.px(3, 2)) === "[200,20,10,255]" && JSON.stringify(png.px(0, 0)) !== JSON.stringify(s.raw0),
      "bgraToPng 把 BGRA 翻成 RGBA（★反向对照★ 不翻的话像素是 [10,20,200,255]，红蓝对调）", png && png.px(3, 2));
    ok(since(m0, "motion.hang")[0] === "rt-main" && since(m0, "motion.close")[0] === "rt-main" && /动效渲染窗口 \d+ 已经关了/.test(s.after) && shell._motions.size === 0,
      "motion.hang / motion.close 到了主进程；关了之后再用这个窗口：如实报「已经关了」", { after: s.after, left: shell._motions.size });
    s = await K.v("motionShort");
    ok(s && /主进程截回来的画面大小不对（56 字节，要 60）/.test(s.threw), "截回来的画面字节数不对：当场报错，不拿错位的像素去编视频", s);
    m0 = mark();
    await K.v("motionLeft");
    const leftBefore = shell._motions.size;
    shell.reset();
    ok(leftBefore === 1 && shell._motions.size === 0 && since(m0, "motion.close").includes("left"),
      "服务进程崩了（reset）：它开着没关的离屏窗口由主进程收掉", { leftBefore, after: shell._motions.size });

    m0 = mark();
    s = await K.v("thumb");
    const s3 = await K.v("thumb");
    ok(s && s.out && s.body === "thumb 160 photo-800x600.jpg" && s3.out === s.out && since(m0, "makeThumb").length === 1,
      "image.thumb：jpg 缩略图交给主进程缩、落进缓存；第二次直接命中缓存，不再问", { s, n: since(m0, "makeThumb").length });

    m0 = mark();
    s = await K.v("vision", { name: "big-3000x2000.jpg" });
    ok(s && s.mime === "image/jpeg" && s.head === "jpg 1568x1045 q82" && /原图 3000×2000/.test(s.note) && JSON.stringify(since(m0, "resize")[0]) === JSON.stringify({ width: 1568, quality: "good" }),
      "image.shrinkForVision：大图交给主进程缩到长边 1568 再发", s);
    m0 = mark();
    s = await K.v("vision", { name: "small-100x100.png" });
    ok(s && s.mime === "image/png" && s.note === "" && since(m0, "createFromPath").length === 0, "900KB 以下的图原样发，一个来回都不跑", s);
    s = await K.v("vision", { name: "throws-3000x2000.jpg" });
    ok(s && !s.err && s.mime === "image/jpeg" && s.note === "" && s.head.length > 0 && s.head !== "jpg 1568x1045 q82",
      "主进程那边缩图出错：原图照发，看图不因为这个失败", s);

    m0 = mark();
    s = await K.v("checkPage", { name: "page.html" });
    ok(typeof s === "string" && s.includes("【浏览器实测】标题「探针标题」· 可见正文 42 字 · 页面高 900px") && s.includes("- [错] 控制台报错 1 条")
      && since(m0, "probePage")[0].file === path.join(FILES, "page.html") && since(m0, "probePage")[0].electronIsShell,
    "page.check：check_page 的浏览器那一半在主进程跑，标题、字数、控制台报错都带回来", { s, calls: since(m0, "probePage") });
    s = await K.v("checkPage", { name: "boom.html" });
    ok(typeof s === "string" && s.includes("【浏览器实测】打开失败：页面打不开（boom）"), "page.check 在主进程那边打不开：原话带回来", s);

    m0 = mark();
    s = await K.v("renderPage");
    const rp = since(m0, "readRendered")[0];
    ok(s && s.ok && s.v.text === "渲染后的正文" && s.v.title === "页标题" && rp && rp.url === "https://owb-bridge-test.invalid/a" && rp.waitMs === 5 && rp.maxWaitMs === 10 && /Mozilla/.test(rp.ua),
      "page.render：web_fetch 的渲染那一半在主进程跑，等待参数和 UA 一起过去", { s, rp });

    m0 = mark();
    await K.v("awakeHold");
    await K.v("awakeHold");
    await K.v("raw", { op: "test.echo", args: 1 }); // 通知不回信：跟一个 call 走同一条管道，它回来说明前面的都处理完了
    ok(since(m0, "power.start").length === 1 && since(m0, "power.start")[0] === "prevent-app-suspension" && shell.powerHeld,
      "power.hold：两个任务都在跑，主进程只按一个「别睡」", since(m0, "power.start"));
    await K.v("awakeRelease");
    await K.v("raw", { op: "test.echo", args: 1 });
    ok(since(m0, "power.stop").length === 1 && !shell.powerHeld, "power.release：都跑完了，主进程松手", since(m0, "power.stop"));
    m0 = mark();
    await K.v("awakeHold");
    await K.v("raw", { op: "test.echo", args: 1 });
    const heldBefore = shell.powerHeld;
    shell.reset();
    ok(heldBefore && !shell.powerHeld && since(m0, "power.stop").length === 1, "服务进程崩了（reset）：它按着的「别睡」主进程替它松开（★反向对照★ reset 之前还按着）", { heldBefore });
    await K.v("awakeRelease");

    section("三、不经调用点直接问的几个（server.js 里那几处，e2e 里碰不得：会弹框、会动剪贴板）");
    m0 = mark();
    r = await K.v("raw", { op: "dialog.openDirectory", args: { title: "选择工作空间文件夹" } });
    ok(r.ok && r.value.filePaths[0] === "/picked/dir" && since(m0, "openDialog")[0].withWin && since(m0, "openDialog")[0].opts.title === "选择工作空间文件夹"
      && JSON.stringify(since(m0, "openDialog")[0].opts.properties) === '["openDirectory"]',
    "dialog.openDirectory：挂在主窗口上开、标题过去、选中的路径回来", { r, d: since(m0, "openDialog") });
    r = await K.v("raw", { op: "dialog.saveAs", args: { defaultPath: "报告.md" } });
    ok(r.ok && JSON.stringify(r.value) === JSON.stringify({ canceled: false, filePath: "/picked/out.md" }) && since(m0, "saveDialog")[0].opts.defaultPath === "报告.md",
      "dialog.saveAs：只回 canceled / filePath 两样", r);
    active = hiddenShell;
    m0 = mark();
    r = await K.v("raw", { op: "dialog.openDirectory", args: {} });
    const r2 = await K.v("raw", { op: "dialog.saveAs", args: {} });
    active = shell;
    ok(!r.ok && r.error.code === "NO_DIALOG" && !r2.ok && r2.error.code === "NO_DIALOG" && since(m0, "openDialog").length + since(m0, "saveDialog").length === 0,
      "隐藏运行（测试宿主）：两种系统框一个都不弹，报 NO_DIALOG", { r, r2 });
    m0 = mark();
    r = await K.v("raw", { op: "shell.showItemInFolder", args: { path: "/x/报告.md" } });
    ok(r.ok && since(m0, "reveal")[0] === "/x/报告.md", "shell.showItemInFolder：路径原样到", r);
    r = await K.v("raw", { op: "shell.openPath", args: { path: "C:\\x\\报告 1.docx" } });
    ok(r.ok && r.value === "" && since(m0, "openPath")[0] === "C:\\x\\报告 1.docx", "shell.openPath：路径原样到，打开了回空串", r);
    r = await K.v("raw", { op: "shell.openPath", args: { path: "C:\\x\\坏.docx" } });
    ok(r.ok && r.value === "Failed to open path" && since(m0, "openPath").length === 2,
      "shell.openPath 打不开：原样回系统那句话（不抛、不吞），服务端拿它告诉用户", r);
    r = await K.v("raw", { op: "clipboard.writeBuffer", args: { format: "NSFilenamesPboardType", data: Buffer.from("<plist>文件</plist>") } });
    const clip = since(m0, "clip")[0];
    ok(r.ok && clip && clip.fmt === "NSFilenamesPboardType" && clip.isBuf && clip.text === "<plist>文件</plist>",
      "clipboard.writeBuffer：Buffer 过 JSON 通道变成 {type:'Buffer'}，主进程还原成 Buffer 再写", clip);
    r = await K.v("raw", { op: "clipboard.writeBuffer", args: { format: "x", data: null } });
    ok(!r.ok && /剪贴板数据是空的/.test(r.error.message) && since(m0, "clip").length === 1, "★反向对照★ 数据是空的：报错，不往剪贴板写一个空东西", r);
    m0 = mark();
    r = await K.v("raw", { op: "session.clearCaches" });
    ok(r.ok && since(m0, "clearCache").length === 1 && since(m0, "clearCodeCaches").length === 1
      && JSON.stringify(since(m0, "clearStorageData")[0]) === JSON.stringify({ storages: ["shadercache", "cachestorage"] }),
    "session.clearCaches：三样都清，Cookie、localStorage 不在清单里", L.slice(m0));
    m0 = mark();
    r = await K.v("raw", { op: "image.petPhoto", args: { abs: path.join(FILES, "cat-800x600.jpg") } });
    const pngBuf = r.ok ? toBuf(r.value.png) : null;
    ok(r.ok && pngBuf && pngBuf.subarray(8).toString() === "png 320x320" && JSON.stringify(since(m0, "crop")[0]) === JSON.stringify({ x: 100, y: 0, width: 600, height: 600 })
      && /800×600 不是正方形/.test(r.value.note),
    "image.petPhoto：中心裁方、缩 320、说明带回来", { r: r.ok ? r.value.note : r, crop: since(m0, "crop") });
    r = await K.v("raw", { op: "image.petPhoto", args: { abs: path.join(FILES, "anim-400x400.gif") } });
    ok(r.ok && /GIF 只取了第一帧/.test(r.value.note) && !/不是正方形/.test(r.value.note), "image.petPhoto：GIF 说明只取第一帧，方图不裁", r.ok ? r.value.note : r);
    r = await K.v("raw", { op: "image.petPhoto", args: { abs: path.join(FILES, "broken.png") } });
    ok(r.ok && r.value.empty === true, "image.petPhoto：解不出来回 {empty:true}，由服务进程那边说「解码失败」", r);

    m0 = mark();
    const notes = [
      ["pet.setState", { state: "working", text: "在跑" }], ["pet.alertAsk", { question: "要继续吗" }], ["pet.clearAsk", { stillWorking: true }],
      ["pet.applyConfig", { size: 2 }], ["pet.show", null], ["pet.hide", null], ["shortcuts.register", { toggle: "Alt+Space" }],
      ["win.setFullScreen", { on: true }], ["approval.open", { type: "open" }], ["app.relaunch", null],
    ];
    const sent = [];
    for (const [op, args] of notes) sent.push(await K.v("note", { op, args }));
    await K.v("raw", { op: "test.echo", args: 1 });
    ok(sent.every((x) => x === true), "通知（不等回信的那种）都发出去了", sent);
    ok(JSON.stringify(since(m0, "pet.setState")[0]) === JSON.stringify({ s: "working", t: "在跑" }) && since(m0, "pet.alertAsk")[0] === "要继续吗"
      && since(m0, "pet.clearAsk")[0] === true && since(m0, "pet.applyConfig")[0].size === 2 && since(m0, "pet.show").length === 1 && since(m0, "pet.hide").length === 1,
    "pet.*：宠物的六个动作都到了主进程那只宠物身上", L.slice(m0).filter((x) => /^pet/.test(x.k)));
    ok(since(m0, "shortcuts")[0].toggle === "Alt+Space" && since(m0, "setFullScreen")[0] === true && since(m0, "approval")[0].type === "open" && since(m0, "relaunch").length === 1,
      "shortcuts.register / win.setFullScreen / approval.open / app.relaunch 都到了", L.slice(m0).filter((x) => !/^pet/.test(x.k)));
    ok(!bootLogs.some((l) => /不认识的通知/.test(l)), "上面这些通知主进程一个都没说「不认识」", bootLogs);

    section("四、主进程推过来的状态、控制消息");
    s = await K.v("state");
    ok(s && s.caps.windows === true && s.state.winAlive === true && s.state.fullScreen === false, "起的时候带过来的状态（OWB_BRIDGE_STATE）读得到", s);
    K.c.send({ t: "state", patch: { fullScreen: true, caps: { windows: false, pet: true } } });
    K.c.send({ t: "ctl", op: "ping", x: 7 });
    await sleep(200);
    s = await K.v("state");
    ok(s && s.state.fullScreen === true && s.caps.windows === false && s.seen.states === 1 && s.seen.ctl.length === 1 && s.seen.ctl[0].op === "ping" && s.seen.ctl[0].x === 7,
      "状态补丁合进来、onState 响一次；ctl 消息递到 onCtl", s);
    ok((await K.v("available")) === false, "主进程说开不了窗口（caps.windows=false）：browser-render.available() 跟着变 false");
    s = await K.v("checkPage", { name: "page.html" });
    ok(typeof s === "string" && s.includes("【浏览器实测】跳过"), "开不了窗口时 check_page 如实说跳过，不去问一个开不了窗的主进程", s);
    K.c.send({ t: "state", patch: { caps: { windows: true, pet: true } } });

    section("五、每一个 op 都有超时：主进程卡死时，全部按时报错回来");
    // 源码里真的在用的 op 名，一个不漏（下面第六节也用这份）
    const used = scanOps();
    const callOps = [...new Set(used.filter((u) => u.kind === "call").map((u) => u.op))];
    drop = true;
    s = await K.v("allTimeout", { ops: callOps, timeoutMs: 250 }, 30000);
    drop = false;
    const bad = (s && s.out ? s.out : []).filter((x) => x.ok || !x.error || x.error.code !== "SHELL_TIMEOUT" || !x.error.message.includes(`（${x.op}）`));
    ok(s && s.out && s.out.length === callOps.length && callOps.length >= 18 && !bad.length && s.ms < 5000,
      `源码里用到的 ${callOps.length} 个 call 类 op，主进程不回时各自在 0.25 秒后报 SHELL_TIMEOUT、话里带 op 名`, { bad, ms: s && s.ms });

    section("六、源码里用到的 op 和 bridge-main 认的 op 对得上（两边都不许多、不许少）");
    const handled = scanHandled();
    const verdict = await checkOps(used.map((u) => u.op + ":" + u.kind));
    ok(verdict.missing.length === 0, `源码里 ${used.length} 处 bridge.call / bridge.notify，bridge-main 全认`, verdict.missing);
    const usedSet = new Set(used.map((u) => u.op));
    const dead = handled.filter((op) => !usedSet.has(op));
    ok(dead.length === 0 && handled.length >= 30, `bridge-main 的 ${handled.length} 个 op 在源码里都有人用（没有死 op）`, dead);
    const v2 = await checkOps(["dialog.openFile:call", "pet.dance:note"]);
    ok(v2.missing.length === 2, "★反向对照★ 塞两个 bridge-main 没有的名字（dialog.openFile / pet.dance）：一致性检查当场认出", v2.missing);
    await K.bye();

    // =================================================================================
    section("七、主进程不在：纯 node（npm start、容器）里调用，报的是实话");
    const N = launch("none", { OWB_NODE_EXEC: wrapper });
    await N.ready;
    s = await N.v("mode");
    ok(s && s.mode === "none" && s.remote === false && s.nodeExec === s.execPath, "纯 node：mode 是 none，nodeExec 就是自己的 execPath（OWB_NODE_EXEC 只在服务进程里认）", s);
    r = await N.v("raw", { op: "svg.png", args: {} });
    ok(!r.ok && r.error.code === "NO_SHELL" && r.error.message === "当前没有桌面主进程可用（svg.png）" && r.ms < 100, "问主进程：当场报 NO_SHELL，写明哪个操作，不等超时", r);
    ok((await N.v("note", { op: "pet.show" })) === false, "发通知：静默返回 false（没人可通知不是错）");
    ok((await N.v("available")) === false, "browser-render.available() 照旧是 false（跟挪之前一样）");
    await N.bye();

    section("八、通道断了：挂着的调用立刻报「连接断了」，不干等超时");
    const G = launch("remote", { OWB_BRIDGE: "1", OWB_BRIDGE_IPC: "1", OWB_BRIDGE_STATE: STATE0 });
    await G.ready;
    drop = true;
    await G.v("goneArm");
    await sleep(200);
    G.c.disconnect();
    const ge = await Promise.race([G.exited, sleep(8000).then(() => null)]);
    drop = false;
    const gone = {};
    for (const line of G.out.text.split("\n")) { const m = /^GONE (\{.*\})$/.exec(line); if (m) { const o = JSON.parse(m[1]); gone[o.k] = o; } }
    ok(ge && ge.code === 0, "断线之后子进程自己好好退出（没因为往断了的通道上写而崩）", { ge, out: G.out.text.slice(-400) });
    ok(gone.svg && !gone.svg.ok && gone.svg.error.code === "SHELL_GONE" && gone.svg.error.message === "和桌面主进程的连接断了（svg.png）",
      "真调用点（svgToPng）挂着的那一个：SHELL_GONE，话里带 op 名", gone.svg);
    ok(gone.raw && gone.raw.error && gone.raw.error.code === "SHELL_GONE", "直接问的那一个（超时给了 60 秒）：也是立刻 SHELL_GONE", gone.raw);
    ok(gone.after && gone.after.error && gone.after.error.code === "SHELL_GONE" && gone.notify && gone.notify.v === false,
      "断了以后再问：当场 SHELL_GONE；再通知：返回 false", { after: gone.after, notify: gone.notify });
    const GO = launch("gone-old", { OWB_BRIDGE: "1", OWB_BRIDGE_IPC: "1", OWB_BRIDGE_STATE: STATE0 });
    await GO.ready;
    drop = true;
    await GO.v("goneOld");
    await sleep(200);
    GO.c.disconnect();
    await Promise.race([GO.exited, sleep(8000)]);
    drop = false;
    const go = /GONE_OLD (\{.*\})/.exec(GO.out.text);
    ok(go && JSON.parse(go[1]).settled === false, "★反向对照★ 不接 disconnect 的传输：断线 1.5 秒后那个调用还挂着（得干等满 60 秒超时）", GO.out.text.slice(-300));

    // =================================================================================
    section("九、冒充 utilityProcess：拉子进程用应用本体，装机判断听主进程的");
    const U = launch("utility", { OWB_BRIDGE: "1", OWB_NODE_EXEC: wrapper, OWB_PACKAGED: "1", OWB_BRIDGE_STATE: STATE0 });
    const ur = await U.ready;
    ok(ur && ur.mode === "remote", "process.type=utility + OWB_BRIDGE=1（不带 IPC 开关）：认自己是服务进程", ur);
    s = await U.v("exec");
    ok(s && s.nodeExec === wrapper && s.launcher.command === wrapper && s.launcher.env.ELECTRON_RUN_AS_NODE === "1" && s.pickNode === wrapper,
      "nodeExec / engines 的 nodeLauncher / Windows 的 pickNode：都用主进程递过来的应用本体（不是 Helper）", s);
    ok(s && s.packaged1 === true && s.packaged0 === false && s.dataDir === path.resolve(HOME), "paths.isPackaged() 听 OWB_PACKAGED（1 → 是、0 → 不是），数据根仍是测试的临时家", s);
    ok(s && s.cutChanged && s.oldPackaged1 === false, "★反向对照★ 删掉 paths.js 里 utility 那一行：OWB_PACKAGED=1 也答「不是装机包」（装机版会拿应用包当数据根）", s);
    if (process.platform !== "win32") {
      try { fs.rmSync(execLog, { force: true }); } catch {}
      s = await U.v("runNode");
      const log1 = fs.existsSync(execLog) ? fs.readFileSync(execLog, "utf8") : "";
      ok(typeof s === "string" && s.includes("owb-bridge-node-ok") && /script_.*\.cjs/.test(log1), "run_node 在服务进程里：脚本由应用本体跑（冒充的那个记下了一次），输出照常", { s, log1 });
      s = await U.v("selfCheckMjs");
      const log2 = fs.existsSync(execLog) ? fs.readFileSync(execLog, "utf8") : "";
      ok(s && s.bad === false && /--check .*probe\.mjs/.test(log2), "写完 .mjs 的语法自检（node --check）也用应用本体", { s, log2 });
      const N2 = launch("none", { OWB_NODE_EXEC: wrapper });
      await N2.ready;
      try { fs.rmSync(execLog, { force: true }); } catch {}
      s = await N2.v("runNode");
      ok(typeof s === "string" && s.includes("owb-bridge-node-ok") && !fs.existsSync(execLog), "★反向对照★ 纯 node 里同一个 run_node：用自己的 execPath，冒充的那个一次都没被叫", { s });
      await N2.bye();
    }
    await U.bye();

    // =================================================================================
    section("十、★反向对照★ 挪进服务进程、却不开桥（= 挪之前的代码）：每个调用点都失败或退化");
    const O = launch("old-utility", { OWB_BRIDGE_STATE: STATE0 });
    const or = await O.ready;
    ok(or && or.mode === "none", "process.type=utility、没有 OWB_BRIDGE：不认桥（老代码的样子）", or);
    m0 = mark();
    ok((await O.v("available")) === false, "browser-render.available()：false（服务进程里 require('electron') 没有 app）");
    s = await O.v("svg");
    ok(s && s.__err && !/桌面主进程/.test(s.__err.message), "svgToPng：直接抛（没有 BrowserWindow）", s);
    s = await O.v("shot", { name: "card.html" });
    ok(s && s.__err && /HTML 截图需要桌面版环境/.test(s.__err.message), "renderHtmlToPng：报「需要桌面版环境」", s);
    s = await O.v("checkPage", { name: "page.html" });
    ok(typeof s === "string" && s.includes("【浏览器实测】跳过"), "check_page：浏览器那一半整个跳过", s);
    s = await O.v("renderPage");
    ok(s && !s.ok && /内置浏览器不可用/.test(s.error.message), "web_fetch 渲染：报「内置浏览器不可用」", s);
    s = await O.v("thumb", { cache: "thumbs-old" }); // 另一个缓存目录：别命中上面桥缩好的那张
    ok(s && s.out === null, "jpg 缩略图：缩不了（null），界面只能拿原图", s);
    s = await O.v("vision", { name: "big-3000x2000.jpg" });
    ok(s && s.note === "" && s.head !== "jpg 1568x1045 q82", "看图：950KB 的原图原样发（没缩）", s);
    ok(L.length === m0, "上面这一串主进程一次都没被问到", L.slice(m0));
    await O.bye();

    section("十一、toBuf：两种通道的二进制都还原成 Buffer");
    const u8 = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    ok(toBuf(u8).equals(Buffer.from([1, 2, 3])), "结构化克隆（utilityProcess）过来的 Uint8Array，带偏移的子视图也对");
    ok(toBuf({ type: "Buffer", data: [4, 5] }).equals(Buffer.from([4, 5])) && toBuf(new Uint8Array([6]).buffer).equals(Buffer.from([6])), "JSON 通道的 {type:'Buffer'}、裸 ArrayBuffer 都认");
    ok(toBuf(null) === null && toBuf({ x: 1 }) === null && toBuf("abc") === null, "不是二进制的：null（调用点据此报「没有返回图片数据」）");

    console.log(`\n${fail === 0 ? "√" : "×"} electron-bridge：${pass} 条通过，${fail} 条失败`);
    process.exitCode = fail === 0 ? 0 : 1;
  })()
    .catch((e) => { console.error("套件自己挂了：", (e && e.stack) || e); process.exitCode = 1; })
    .finally(() => {
      for (const c of kids) { try { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); } catch {} }
      setTimeout(() => process.exit(process.exitCode || 0), 50);
    });

  /** 扫源码里所有 bridge.call("x.y" / bridge.notify("x.y"：测试目录、node_modules、前端不算 */
  function scanOps() {
    const out = [];
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ["node_modules", "test", "public", "data", "workspace", "accounts", "dist", "build", "skills"].includes(ent.name)) continue;
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) { if (ent.name === "src" || d !== ROOT) walk(p); continue; }
        if (!/\.js$/.test(ent.name)) continue;
        const src = fs.readFileSync(p, "utf8");
        for (const m of src.matchAll(/\.(call|notify)\(\s*"([a-z]+\.[A-Za-z]+)"/g)) out.push({ kind: m[1] === "call" ? "call" : "note", op: m[2], file: path.relative(ROOT, p) });
      }
    };
    walk(ROOT);
    return out;
  }
  /** bridge-main.js 里 calls / notes 两张表的键 */
  function scanHandled() {
    const src = fs.readFileSync(mod("bridge-main"), "utf8");
    return [...new Set([...src.matchAll(/^\s+"([a-z]+\.[A-Za-z]+)":/gm)].map((m) => m[1]))];
  }
  /** 拿一个不带测试 op 的 bridge-main 实打实问一遍：call 回 NO_OP、note 记「不认识」就算没接住 */
  async function checkOps(list) {
    const logs = [];
    const sb = createShellBridge({ electron: fakeElectron().e, getWin: () => fakeWin, pet: () => fakePet, registerShortcuts: () => {}, relaunch: () => {}, onApproval: () => {}, bootLog: (l) => logs.push(l) });
    const missing = [];
    let id = 0;
    for (const item of [...new Set(list)]) {
      const [op, kind] = item.split(":");
      if (kind === "note") {
        const before = logs.length;
        sb.handle({ t: "note", op, args: {} }, () => {});
        if (logs.slice(before).some((l) => /不认识的通知/.test(l))) missing.push(item);
        continue;
      }
      const reply = await new Promise((res) => {
        const t = setTimeout(() => res({ timeout: true }), 3000);
        sb.handle({ t: "call", id: ++id, op, args: {} }, (m) => { clearTimeout(t); res(m); });
      });
      if (reply && reply.error && reply.error.code === "NO_OP") missing.push(item);
    }
    sb.reset();
    return { missing };
  }
}
