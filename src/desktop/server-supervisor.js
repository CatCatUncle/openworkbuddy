// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 独立服务进程的看护（electron-main.js 用）。
 *
 * 2026-09-29 审计：几个对话一起跑时主进程事件循环 p99 68ms、最长 330ms，用户原话「开几个对话
 * 整个应用连带电脑都卡」。服务端连同 agent 挪进 utilityProcess 以后，主进程只剩窗口——可服务端
 * 从此是另一个进程，它会起不来、会崩。这里管三件事，哪件出岔子都不许让用户对着一个死窗口：
 *
 *   1. 起：READY_MS（默认 20 秒）内没报端口，就当这条路走不通，退回在主进程里跑（老路子）；
 *   2. 崩：退避重启（0.5 / 2 / 5 秒），钉在原来的端口上，窗口不用换地址；
 *      5 分钟内退出满 3 次就不再折腾，同样退回主进程；
 *   3. 退：先请它自己收尾（ctl shutdown），等不到再杀。
 *
 * 每次退回都在日志里留一行「为什么」，只写看到的事实（没监听 / 退出码几 / 它自己报的错），不猜原因。
 * 服务进程的优先级只往低调（nice 5）：跟窗口抢 CPU 的时候让窗口先走。调高要 root，永远不做。
 */

const os = require("os");

const READY_MS = 20000;
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const CRASH_LIMIT = 3;
const BACKOFF_MS = [500, 2000, 5000];
const TAG = "[服务进程]";

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/**
 * @param {{
 *   fork: (env: Record<string, string>) => any,   // utilityProcess.fork 包一层，测试可以换
 *   env: () => Record<string, string>,             // 每次起的时候现算（带上主进程这会儿的窗口状态）
 *   shell: { handle: (m: any, post: (r: any) => void) => boolean, reset: () => void },
 *   log: (line: string) => void,
 *   readyMs?: number,
 *   nice?: number,
 *   onPort?: (port: number, reused: boolean) => void, // 崩了重启好了（端口可能换了；reused = 口上是另一台 OWB）
 *   onFallback?: (why: string) => void,           // 跑起来之后才退回主进程
 * }} o
 */
function createServerSupervisor({ fork, env, shell, log, readyMs = READY_MS, nice = 5, onPort, onFallback }) {
  /** @type {any} */
  let child = null;
  let port = 0;
  let stopping = false;
  let fellBack = "";
  /** @type {number[]} */
  const crashes = [];
  let starts = 0;
  let errTail = "";

  /** 记一次退出；5 分钟窗口里满 CRASH_LIMIT 次返回 true */
  function noteCrash() {
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
    return crashes.length >= CRASH_LIMIT;
  }
  const backoff = () => BACKOFF_MS[Math.min(crashes.length, BACKOFF_MS.length) - 1] || BACKOFF_MS[0];

  function fallBack(why) {
    fellBack = why;
    log(`${TAG} 独立服务进程${why}，已改回在主进程里运行`);
    return null;
  }

  function lowerPriority(pid) {
    try {
      const cur = os.getPriority(pid);
      if (cur >= nice) return; // 外面已经整体 nice 过、比这还低：不动（往高调要 root）
      os.setPriority(pid, nice);
    } catch (e) {
      log(`${TAG} ▲ 优先级没调成（pid ${pid}）：${String((e && /** @type {any} */ (e).message) || e)}`);
    }
  }

  /** 服务进程的输出原样写进主进程的 stdout / stderr：装机的启动器把这两路接到了同一个日志文件 */
  function pipe(stream, err) {
    if (!stream) return;
    stream.on("data", (d) => {
      try { (err ? process.stderr : process.stdout).write(d); } catch {}
      if (err) errTail = (errTail + d).slice(-2000);
    });
  }

  /**
   * 起一个，等它报端口 / 报错 / 退出 / 超时，谁先来算谁。
   * @returns {Promise<{kind:"up", port:number, reused:boolean}|{kind:"fail", why:string}|{kind:"exit", code:number}|{kind:"timeout"}>}
   */
  function launch(extraEnv) {
    return new Promise((resolve) => {
      let settled = false;
      /** @type {any} */
      let timer = null;
      const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      let c;
      try { c = fork({ ...env(), ...(extraEnv || {}) }); } catch (e) {
        done({ kind: "fail", why: String((e && /** @type {any} */ (e).message) || e) });
        return;
      }
      child = c;
      starts++;
      timer = setTimeout(() => done({ kind: "timeout" }), readyMs);
      c.on("spawn", () => {
        lowerPriority(c.pid);
        log(`${TAG} 已起：pid ${c.pid}`);
      });
      pipe(c.stdout, false);
      pipe(c.stderr, true);
      c.on("message", (m) => {
        if (!m || typeof m !== "object") return;
        if (m.t === "listening") return done({ kind: "up", port: Number(m.port), reused: !!m.reused });
        if (m.t === "boot" && m.ok === false) return done({ kind: "fail", why: String((m.error && m.error.message) || m.error || "没带原因").split("\n")[0] });
        if (m.t === "hello") return log(`${TAG} 数据目录 ${m.dataDir}`);
        shell.handle(m, (r) => { try { if (child === c) c.postMessage(r); } catch {} });
      });
      c.on("exit", (code) => {
        if (child === c) child = null;
        shell.reset(); // 它按着的「别睡」、开着的离屏窗口，一并松开
        if (!settled) return done({ kind: "exit", code });
        if (c.__retired || stopping) return;
        recover(code);
      });
    });
  }

  /** 起到能用为止；走不通就退回（返回 null） */
  async function bring(extraEnv) {
    for (;;) {
      const r = await launch(extraEnv);
      if (stopping) { if (r.kind === "up") retire(); return null; }
      if (r.kind === "up") return r;
      // 退回之前先等它真没了：见 retireAndWait
      if (r.kind === "timeout") { await retireAndWait(); return fallBack(`${Math.round(readyMs / 1000)} 秒内没开始监听端口`); }
      if (r.kind === "fail") { await retireAndWait(); return fallBack(`启动报错：${r.why}`); }
      if (noteCrash()) return fallBack(`5 分钟内退出了 ${CRASH_LIMIT} 次（最后一次退出码 ${r.code}）`);
      const wait = backoff();
      log(`${TAG} 还没开始监听就退出了（退出码 ${r.code}），${wait}ms 后再起一次`);
      await sleep(wait);
      if (stopping) return null;
    }
  }

  /** 这一个不要了：不算崩溃、不重启 */
  function retire() {
    const c = child;
    if (!c) return;
    c.__retired = true;
    try { c.postMessage({ t: "ctl", op: "shutdown" }); } catch {}
    const t = setTimeout(() => { try { c.kill(); } catch {} }, 1500);
    if (t.unref) t.unref();
  }

  /**
   * 不要了，而且等它真退了再往下走：退回主进程那一步紧跟在后面。
   *
   * 2026-09-29 复审：READY_MS 内没报端口 ≠ 永远不监听——慢机器上它可能第 20.1 秒才 listen 上。
   * 以前 retire() 发完就走，主进程紧接着在同一个 PORT 上起自己那份，两边抢一个口：主进程这边撞上
   * EADDRINUSE，按「口上是另一台 OpenWorkBuddy」连过去，连的正是 1.5 秒后就被杀掉的这一个，窗口对着死地址。
   * 最多等 waitMs（retire 自己 1.5 秒硬杀，这里再多给半秒）；还在就按 pid 再杀一次、再等一小会儿，
   * 都没等到也照样退回，日志里如实写一行。
   */
  async function retireAndWait(waitMs = 2000) {
    const c = child;
    if (!c) return;
    const gone = new Promise((r) => c.once("exit", r));
    retire();
    const how = await Promise.race([gone.then(() => "exit"), sleep(waitMs).then(() => "late")]);
    if (how === "exit") return;
    try { c.kill(); } catch {}
    const how2 = await Promise.race([gone.then(() => "exit"), sleep(500).then(() => "late")]);
    if (how2 === "late") log(`${TAG} ▲ 不要的那个服务进程（pid ${c.pid}）${waitMs + 500}ms 还没退，照样改回主进程`);
  }

  async function recover(code) {
    const tail = errTail.trim().split("\n").slice(-1)[0] || "";
    if (noteCrash()) {
      fallBack(`5 分钟内退出了 ${CRASH_LIMIT} 次（最后一次退出码 ${code}）`);
      if (onFallback) onFallback(fellBack);
      return;
    }
    const wait = backoff();
    log(`${TAG} 独立服务进程退出了（退出码 ${code}${tail ? `，最后一行 stderr：${tail.slice(0, 200)}` : ""}），${wait}ms 后重启`);
    await sleep(wait);
    if (stopping) return;
    // 钉在原来那个口上：窗口、手机扫的码、终端里连着的 cli 都还认这个地址
    const r = await bring(port ? { PORT: String(port) } : {});
    if (!r) { if (fellBack && !stopping && onFallback) onFallback(fellBack); return; }
    if (r.reused) {
      // 原来的口上坐着另一台 OpenWorkBuddy（重启这几百毫秒里被抢了）：这一个不留，窗口连过去
      retire();
    }
    port = r.port;
    log(`${TAG} 重启好了，监听 ${port}`);
    if (onPort) onPort(port, !!r.reused);
  }

  return {
    /** 头一次起。能用返回 {port, reused}，走不通返回 null（调用方退回主进程里跑） */
    async start() {
      const r = await bring({});
      if (!r) return null;
      port = r.port;
      if (r.reused) retire(); // 窗口连已经在跑的那一台，这边起的这个没事可干
      return { port: r.port, reused: r.reused };
    },
    /** 退出时：请它自己收尾（停 MCP、收子进程），等不到就杀 */
    async stop(waitMs = 1500) {
      stopping = true;
      const c = child;
      if (!c) return;
      const gone = new Promise((r) => c.once("exit", r));
      try { c.postMessage({ t: "ctl", op: "shutdown" }); } catch {}
      const how = await Promise.race([gone.then(() => "exit"), sleep(waitMs).then(() => "late")]);
      if (how === "late") {
        log(`${TAG} ▲ 请它退出 ${waitMs}ms 还没退，直接结束`);
        try { c.kill(); } catch {}
        await Promise.race([gone, sleep(500)]);
      }
    },
    /** 不等、直接结束（系统关机那条路 / 退回主进程前） */
    kill() {
      stopping = true;
      const c = child;
      if (c) { try { c.kill(); } catch {} }
    },
    /** 状态推给服务进程（窗口在不在、是不是全屏） */
    post(msg) { const c = child; if (!c) return false; try { c.postMessage(msg); return true; } catch { return false; } },
    pid() { return child && child.pid ? child.pid : 0; },
    /** killChildren 要多扫的根：服务进程底下的子孙（它自己带 --type=utility，扫主进程那棵树时会被刨掉） */
    roots() { return child && child.pid ? [child.pid] : []; },
    get port() { return port; },
    get fellBack() { return fellBack; },
    get starts() { return starts; },
  };
}

module.exports = { createServerSupervisor, READY_MS, CRASH_WINDOW_MS, CRASH_LIMIT, BACKOFF_MS };
