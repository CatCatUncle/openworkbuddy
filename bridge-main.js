// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 服务进程 ↔ 桌面主进程 的桥（主进程这一半）。另一半在 electron-bridge.js。
 *
 * 2026-09-29：服务端挪进 utilityProcess 以后，dialog / shell / clipboard / nativeImage /
 * BrowserWindow / powerSaveBlocker 这些只有主进程才有的东西，服务进程一律发消息过来要。
 * 这里只做「收到什么就调什么」，不做任何业务判断——业务留在 server.js / tools.js 里，
 * 两种跑法（inproc / utility）的行为才不会分叉。
 *
 * 消息形状：
 *   {t:"call", id, op, args}  → 回 {t:"ret", id, ok, value | error}
 *   {t:"note", op, args}      → 不回（宠物动作、快捷键、全屏、审批提醒、按住不睡）
 *
 * impl 可以整张换掉：test/electron-bridge.js 拿假 electron 跑每一个 op 的来回。
 */

/**
 * @param {{
 *   electron: any,
 *   getWin?: () => any,
 *   pet?: any,                 // 宠物对象，或者现取它的函数
 *   registerShortcuts?: (s: any) => void,
 *   relaunch?: () => void,
 *   onApproval?: (m: any) => void,
 *   bootLog?: (...a: any[]) => void,
 *   hidden?: boolean,
 *   impl?: Record<string, (args: any) => any>,
 *   ops?: ReturnType<typeof createOpTracker>,
 *   pixels?: ReturnType<typeof import("./src/platform/render/thumb-sips").createSipsPixels> | ReturnType<typeof import("./src/platform/render/browser-render").createRenderPixels> | null,
 * }} o
 *   pixels：缩图的活交给界面线程以外的地方（macOS 上是 thumb-sips.js 的子进程，Windows 上是
 *   browser-render.js 的隐藏网页窗口，electron-main.js 按平台注入）。
 *   没给、或者它说这张做不了（回 null），就走下面 nativeImage 的老路——结果一样，只是在主线程上做
 */
function createShellBridge({ electron, getWin, pet, registerShortcuts, relaunch, onApproval, bootLog, hidden = false, impl, ops, pixels = null } = /** @type {any} */ ({})) {
  const log = typeof bootLog === "function" ? bootLog : () => {};
  const counts = { calls: 0, notes: 0, errors: 0 };
  // 每件活在主线程上同步占了多久、跑在哪段时间里：卡顿记录（createStallWatch）靠它说出「卡的时候在干什么」
  const track = ops || createOpTracker();
  /** @type {Map<number, any>} 动效渲染的离屏窗口（motion.*），按 sid 管 */
  const motions = new Map();
  let motionSeq = 0;
  let powerId = null;

  // 宠物在服务进程起来之后才建（它一出生就要拿主窗口），所以可以传一个现取的函数
  const petOf = () => { try { return typeof pet === "function" ? pet() : pet; } catch { return null; } };
  const win = () => {
    try { const w = getWin && getWin(); return w && !w.isDestroyed() ? w : null; } catch { return null; }
  };
  const toBuf = (v) => require("./src/platform/electron-bridge").toBuf(v);
  // 测试宿主（OWB_SHELL_HIDDEN=1）不弹系统框：弹出来就挡在用户桌面上，而且没人去点
  const noDialog = (op) => {
    if (!hidden) return;
    const e = /** @type {any} */ (new Error(`隐藏运行（OWB_SHELL_HIDDEN=1）时不弹系统对话框（${op}）`));
    e.code = "NO_DIALOG";
    throw e;
  };
  const motion = (sid) => {
    const d = motions.get(sid);
    if (!d) throw new Error(`动效渲染窗口 ${sid} 已经关了`);
    return d;
  };

  /** @type {Record<string, (args: any) => any>} */
  const calls = {
    "dialog.openDirectory": async (a) => {
      noDialog("dialog.openDirectory");
      const opts = { properties: ["openDirectory"], title: (a && a.title) || undefined };
      const w = win();
      return w ? electron.dialog.showOpenDialog(w, opts) : electron.dialog.showOpenDialog(opts);
    },
    "dialog.saveAs": async (opts) => {
      noDialog("dialog.saveAs");
      const w = win();
      const r = w ? await electron.dialog.showSaveDialog(w, opts || {}) : await electron.dialog.showSaveDialog(opts || {});
      return { canceled: !!r.canceled, filePath: r.filePath || "" };
    },
    "shell.showItemInFolder": async (a) => { electron.shell.showItemInFolder(String(a && a.path)); return true; },
    // 用系统默认程序打开。原样交回 shell.openPath 的结果：成功是空串，失败是系统给的错误文字（不抛），
    // 服务端按这个约定判断成没成、把那句话转给用户
    "shell.openPath": async (a) => electron.shell.openPath(String(a && a.path)),
    "clipboard.writeBuffer": async (a) => {
      const buf = toBuf(a && a.data);
      if (!buf) throw new Error("剪贴板数据是空的（clipboard.writeBuffer）");
      electron.clipboard.writeBuffer(String(a.format), buf);
      return true;
    },
    // 口径跟 server.js /api/cache/clear 在主进程里那三步一样：Cookie、localStorage 不动
    "session.clearCaches": async () => {
      const ses = electron.session.defaultSession;
      await ses.clearCache();
      try { await ses.clearCodeCaches({}); } catch {}
      try { await ses.clearStorageData({ storages: ["shadercache", "cachestorage"] }); } catch {}
      return true;
    },
    // 口径跟 server.js 宠物工具在主进程里那段一样：中心裁方、320、GIF 只取第一帧
    // 这三件图像活 2026-09-29 量过：6016² 的照片在主线程上同步 145–181ms，4032 的 40–61ms。
    // 有 pixels 就先交给它（另一个进程里做），它做不了才落到下面的 nativeImage
    "image.petPhoto": async (a) => {
      const abs = String(a && a.abs);
      const off = pixels && await pixels.petPhoto(abs);
      if (off) return off.value;
      let img = electron.nativeImage.createFromPath(abs);
      if (img.isEmpty()) return { empty: true };
      let note = "";
      const sz = img.getSize();
      const side = Math.min(sz.width, sz.height);
      if (sz.width !== sz.height) {
        img = img.crop({ x: Math.round((sz.width - side) / 2), y: Math.round((sz.height - side) / 2), width: side, height: side });
        note += `原图 ${sz.width}×${sz.height} 不是正方形，已按中心裁成方图；`;
      }
      img = img.resize({ width: 320, height: 320, quality: "best" });
      if (/\.gif$/i.test(abs)) note += "GIF 只取了第一帧（宠物自己带呼吸/跳跃动效）；";
      return { png: img.toPNG(), note };
    },
    "image.thumb": async (a) => {
      const off = pixels && await pixels.thumb(String(a && a.abs), Number(a && a.w));
      if (off) return off.value;
      return require("./src/platform/render/thumb").makeThumb(String(a && a.abs), Number(a && a.w)) || null;
    },
    "image.shrinkForVision": async (a) => {
      const maxEdge = Number(a && a.maxEdge) || 1568;
      const off = pixels && await pixels.shrinkForVision(String(a && a.abs), maxEdge, Number(a && a.quality) || 82);
      if (off) return off.value;
      let img = electron.nativeImage.createFromPath(String(a && a.abs));
      if (img.isEmpty()) return { empty: true };
      const sz = img.getSize();
      if (Math.max(sz.width, sz.height) > maxEdge) {
        img = img.resize(sz.width >= sz.height ? { width: maxEdge, quality: "good" } : { height: maxEdge, quality: "good" });
      }
      return { jpg: img.toJPEG(Number(a && a.quality) || 82), width: sz.width, height: sz.height };
    },
    "page.check": async (a) => require("./src/platform/render/web-window").probePage(electron, String(a && a.file)),
    "page.render": async (a) => require("./src/platform/render/web-window").readRendered(electron, String(a && a.url), {
      waitMs: a && a.waitMs, maxWaitMs: a && a.maxWaitMs, ua: (a && a.ua) || "",
    }),
    "shot.html": async (a) => {
      const o = (a && a.opts) || {};
      // 过桥只认这几项：道、超时、封面能读的目录。缺省的任务道原样只有四项（test/electron-bridge.js 钉着）
      /** @type {Record<string, any>} */
      const opts = { width: o.width, height: o.height, fullPage: o.fullPage, waitMs: o.waitMs };
      if (o.lane === "cover") opts.lane = "cover";
      if (Number(o.timeoutMs) > 0) opts.timeoutMs = Number(o.timeoutMs);
      if (o.lane === "cover" && o.fileRoot) opts.fileRoot = String(o.fileRoot);
      return require("./src/platform/render/htmlshot").renderHtmlToPng(String(a && a.htmlPath), opts);
    },
    "svg.png": async (a) => require("./src/platform/render/browser-render").svgToPng(String(a && a.svg), Number(a && a.scale) || 2),
    "mermaid.render": async (a) => require("./src/platform/render/browser-render").renderMermaid(String(a && a.source), (a && a.theme) || undefined),
    "motion.open": async (a) => {
      const d = await require("./src/platform/render/htmlvideo").electronDriver({ width: a.width, height: a.height, runtime: a.runtime });
      const sid = ++motionSeq;
      motions.set(sid, d);
      return sid;
    },
    "motion.load": async (a) => { await motion(a.sid).load(String(a.url)); return true; },
    "motion.eval": async (a) => motion(a.sid).evaluate(String(a.expr)),
    // BGRA 裸像素原样回去：nativeImage 过不了进程，要 PNG 那边自己编（electron-bridge.bgraToPng）
    "motion.capture": async (a) => (await motion(a.sid).capture()).buf,
    "motion.close": async (a) => {
      const d = motions.get(a && a.sid);
      motions.delete(a && a.sid);
      if (d) await d.close();
      return true;
    },
  };

  /** @type {Record<string, (args: any) => void>} */
  const notes = {
    "app.relaunch": () => { if (relaunch) relaunch(); },
    "pet.setState": (a) => { const p = petOf(); if (p) p.setState(a && a.state, a && a.text); },
    "pet.alertAsk": (a) => { const p = petOf(); if (p) p.alertAsk(a && a.question); },
    "pet.clearAsk": (a) => { const p = petOf(); if (p) p.clearAsk(a && a.stillWorking); },
    "pet.applyConfig": (a) => { const p = petOf(); if (p) p.applyConfig(a || {}); },
    "pet.show": () => { const p = petOf(); if (p) p.show(); },
    "pet.hide": () => { const p = petOf(); if (p) p.hide(); },
    "shortcuts.register": (a) => { if (registerShortcuts) registerShortcuts(a || {}); },
    "win.setFullScreen": (a) => { const w = win(); if (w) w.setFullScreen(!!(a && a.on)); },
    "approval.open": (a) => { if (onApproval) onApproval(a); },
    // 按住不睡（awake.js）：服务进程里没有 powerSaveBlocker，引用计数在那边，这边只按一个
    "power.hold": () => {
      if (powerId !== null) return;
      try { powerId = electron.powerSaveBlocker.start("prevent-app-suspension"); } catch { powerId = null; }
    },
    "power.release": () => releasePower(),
    "motion.hang": (a) => { const d = motions.get(a && a.sid); if (d) d.hang(); },
  };

  function releasePower() {
    if (powerId === null) return;
    try { if (electron.powerSaveBlocker.isStarted(powerId)) electron.powerSaveBlocker.stop(powerId); } catch {}
    powerId = null;
  }

  const table = impl ? { ...calls, ...impl } : calls;

  /**
   * @param {any} msg
   * @param {(m: any) => void} post 回信的出口（utilityProcess.postMessage）
   * @returns {boolean} 认不认得这条消息
   */
  function handle(msg, post) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.t === "note") {
      counts.notes++;
      const fn = (impl && impl[msg.op]) || notes[msg.op];
      if (!fn) { log(`▲ 服务进程发来一个不认识的通知：${msg.op}`); return true; }
      const tk = track.begin(msg.op);
      try { fn(msg.args); } catch (e) { log(`▲ 通知 ${msg.op} 出错：${String((e && /** @type {any} */ (e).message) || e)}`); }
      finally { track.end(tk, true); }
      return true;
    }
    if (msg.t !== "call") return false;
    counts.calls++;
    const reply = (m) => { try { post(m); } catch {} }; // 服务进程已经没了：回信扔掉就是
    const fn = table[msg.op];
    if (!fn) {
      counts.errors++;
      reply({ t: "ret", id: msg.id, ok: false, error: { message: `桌面主进程不认识这个操作（${msg.op}）`, code: "NO_OP" } });
      return true;
    }
    let tk = null;
    Promise.resolve()
      .then(() => {
        // 同步那一截单独记：async 函数第一个 await 之前的活全压在界面线程上，这个数就是它挡住界面的时长
        tk = track.begin(msg.op);
        try { return fn(msg.args); } finally { track.sync(tk); }
      })
      .then(
        (value) => { track.end(tk); reply({ t: "ret", id: msg.id, ok: true, value: value === undefined ? null : value }); },
        (e) => {
          track.end(tk);
          counts.errors++;
          reply({ t: "ret", id: msg.id, ok: false, error: require("./src/platform/electron-bridge").serializeError(e) });
        }
      );
    return true;
  }

  /** 服务进程没了（崩了 / 重启 / 退回主进程）：它按着的东西都得松开，别留一个不让睡的断言、一堆离屏窗口 */
  function reset() {
    releasePower();
    for (const [sid, d] of motions) {
      motions.delete(sid);
      try { Promise.resolve(d.close()).catch(() => {}); } catch {}
    }
  }

  return { handle, reset, counts, ops: track, pixels, _motions: motions, get powerHeld() { return powerId !== null; } };
}

// ── 主线程卡顿：卡了多久、那会儿手上有什么活 ────────────────────────────────────────

const monoNow = () => require("perf_hooks").performance.now();

/**
 * 桥上每件活的账：什么时候开始、什么时候结束、同步那一截占了界面线程多久。
 * 只记活的名字（image.thumb、shot.html……），参数一个字都不留——卡顿日志是要让用户整段贴出来的。
 * @param {{ now?: () => number, keepMs?: number, keep?: number }} [o]
 */
function createOpTracker({ now = monoNow, keepMs = 5000, keep = 256 } = {}) {
  let seq = 0;
  /** @type {Map<number, {op: string, t0: number, t1: number, syncMs: number}>} 还没回话的 */
  const live = new Map();
  /** @type {Array<{op: string, t0: number, t1: number, syncMs: number}>} 刚做完的，按结束时间排 */
  const done = [];
  /** @type {Record<string, {n: number, syncMax: number, syncTotal: number, over50: number, over100: number}>} */
  const byOp = {};
  const statOf = (op) => byOp[op] || (byOp[op] = { n: 0, syncMax: 0, syncTotal: 0, over50: 0, over100: 0 });
  const trim = (t) => {
    while (done.length > keep || (done.length && t - done[0].t1 > keepMs)) done.shift();
  };
  return {
    /** @param {string} op */
    begin(op) {
      const id = ++seq;
      live.set(id, { op: String(op || "?"), t0: now(), t1: 0, syncMs: -1 });
      return id;
    },
    /** 同步那一截到头了（async 函数返回了 Promise 的那一刻） @param {number|null} id */
    sync(id) {
      const e = id == null ? null : live.get(id);
      if (!e || e.syncMs >= 0) return;
      const ms = now() - e.t0;
      e.syncMs = ms;
      const s = statOf(e.op);
      s.n++;
      s.syncTotal += ms;
      if (ms > s.syncMax) s.syncMax = ms;
      if (ms > 50) s.over50++;
      if (ms > 100) s.over100++;
    },
    /** @param {number|null} id @param {boolean} [wholeIsSync] 通知是整段同步的，结束就是同步段结束 */
    end(id, wholeIsSync) {
      const e = id == null ? null : live.get(id);
      if (!e) return;
      if (wholeIsSync) this.sync(id);
      live.delete(id);
      e.t1 = now();
      done.push(e);
      trim(e.t1);
    },
    /**
     * [t0, t1] 这段时间里在场过的活（开始得比 t1 早、结束得比 t0 晚），按名字数个数。
     * 卡住的那一截是同步的：在那一截里开始又做完的活，正是元凶的头号嫌疑。
     * @param {number} t0 @param {number} t1 @returns {Record<string, number>}
     */
    during(t0, t1) {
      /** @type {Record<string, number>} */
      const out = {};
      const add = (e) => { out[e.op] = (out[e.op] || 0) + 1; };
      for (const e of live.values()) if (e.t0 <= t1) add(e);
      for (const e of done) if (e.t0 <= t1 && e.t1 >= t0) add(e);
      return out;
    },
    /** 同步段最长的那几件，按名字 */
    stats() { return JSON.parse(JSON.stringify(byOp)); },
    get live() { return live.size; },
  };
}

/**
 * 主线程卡顿记录，桌面版常开。
 *
 * 为什么要常开：2026-09-29 用户说「多开任务对话就卡」。桌面主进程就是界面线程——它一卡，窗口拖不动、
 * 菜单点不开、页面收不到输入。可只有测试宿主量得到它迟到多少，用户机器上卡了一下什么都没留下，
 * 事后只能猜。这里挂一个 100ms 的节拍，迟到超过阈值（缺省 250ms）就记一行：卡了多久、那段时间
 * 桥上有哪几件活。一行最多十秒写一次，中间的只计数，下一行带上「前面还有几次」，日志不会被刷屏。
 *
 * 系统睡眠不算卡：macOS 的单调钟睡着时不走、墙钟照走。两者差出一秒以上 = 这一拍跨过了一次睡眠，
 * 丢掉不记（本机 2026-09-29 浸泡测试里那个 2000ms 就是合盖睡了 181 秒，不是主线程卡住）。
 * 醒来后几十秒 CPU 还被系统压着（DarkWake），调用方收到 resume 时叫一声 pause()，那几秒一起不记。
 *
 * @param {{
 *   thresholdMs?: number, tickMs?: number, minGapMs?: number, keep?: number,
 *   now?: () => number, wall?: () => number,
 *   write?: (line: string) => void,
 *   ops?: { during: (t0: number, t1: number) => Record<string, number> },
 *   timers?: { setInterval: Function, clearInterval: Function },
 * }} [o]
 */
function createStallWatch({
  thresholdMs = 250, tickMs = 100, minGapMs = 10000, keep = 64,
  now = monoNow, wall = Date.now, write = () => {}, ops, timers = { setInterval, clearInterval },
} = {}) {
  const counts = { ticks: 0, stalls: 0, logged: 0, suppressed: 0, slept: 0, paused: 0 };
  /** @type {Array<{ms: number, at: number, ops: Record<string, number>}>} */
  const stalls = [];
  let last = now(), lastWall = wall(), timer = null, lastLogAt = -Infinity, held = 0, maxMs = 0, pauseUntil = 0;

  function line(ms, onOps) {
    const names = Object.entries(onOps).sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k}×${n}` : k));
    const tail = held ? ` · 上一行之后还卡过 ${held} 次没单独记` : "";
    return `[主线程卡顿] 界面线程卡了 ${Math.round(ms)}ms · 那段时间桥上的活：${names.length ? names.join("、") : "没有"}${tail}`;
  }

  /** 走一拍。测试直接调它，喂假的钟 */
  function tick() {
    const t = now(), w = wall();
    const mono = t - last, wallGap = w - lastWall;
    const t0 = last;
    last = t; lastWall = w;
    counts.ticks++;
    if (wallGap - mono > 1000) { counts.slept++; return null; }   // 睡过一觉：墙钟比单调钟多走了一大截
    if (t < pauseUntil) { counts.paused++; return null; }
    const late = mono - tickMs;
    if (late < thresholdMs) return null;
    const onOps = ops ? ops.during(t0, t) : {};
    const rec = { ms: Math.round(late), at: w, ops: onOps };
    counts.stalls++;
    if (late > maxMs) maxMs = late;
    stalls.push(rec);
    if (stalls.length > keep) stalls.shift();
    if (w - lastLogAt >= minGapMs) {
      lastLogAt = w;
      counts.logged++;
      try { write(line(late, onOps)); } catch {}
      held = 0;
    } else {
      held++;
      counts.suppressed++;
    }
    return rec;
  }

  return {
    tick,
    start() {
      if (timer) return;
      last = now(); lastWall = wall();
      timer = timers.setInterval(tick, tickMs);
      if (timer && timer.unref) timer.unref();
    },
    stop() { if (timer) { timers.clearInterval(timer); timer = null; } },
    /** 刚醒来（powerMonitor resume）：接下来 ms 毫秒的迟到不算 @param {number} [ms] */
    pause(ms = 5000) { pauseUntil = now() + ms; },
    reset() { stalls.length = 0; maxMs = 0; for (const k of Object.keys(counts)) /** @type {any} */ (counts)[k] = 0; last = now(); lastWall = wall(); },
    counts, stalls,
    get maxMs() { return Math.round(maxMs); },
    thresholdMs,
  };
}

module.exports = { createShellBridge, createOpTracker, createStallWatch };
