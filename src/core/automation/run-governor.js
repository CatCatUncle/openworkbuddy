// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 同时跑几个任务、几件重活。
 *
 * 用户原话：「多个任务执行的时候，不要占用太多整个电脑的内存，还要保证任务的执行效果」。
 * 以前这里什么都没有：开十个对话就同时拉起十套子进程、十个渲染窗口、十个本机引擎，整台电脑一起卡，
 * 卡到最后任务自己也超时。服务进程本身不大（空闲约 60MB），吃内存的是它拉起来的东西。
 *
 * 两层，分开算是因为这两种活的账完全不一样：
 *   · 任务 —— 大部分时间在等模型回话，几乎不占内存，上限给得宽；
 *   · 重活 —— 截图、渲染、合成、本机引擎，一件就是几百 MB 到几 GB，上限给得紧。
 *
 * 三条规矩：
 *   1. **只排队，不杀。** 任务效果靠的是跑完，不是跑得多。排队的等，跑着的不动。
 *   2. **排队不算任务时间。** 拿到名额才进 runTask，时间预算从那一刻算起，等得再久也不会一开跑就超时。
 *   3. **永远不卡死。** 一个都没在跑就一定放行；内存紧也只拖 HOLD_MAX_MS，过了就放行——
 *      判错内存的代价是慢一点，判错成「永远不放」的代价是任务再也不跑。
 *
 * 子智能体（depth > 0）不占名额：父任务已经占着，再排队就是自己等自己。
 */
const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");

const HOLD_MAX_MS = 120000;  // 内存紧的时候最多替它拖这么久
const RECHECK_MS = 2000;     // 有人排队时多久看一眼内存
const MEM_CACHE_MS = 2000;   // 查内存本身也要钱：macOS 上是起一次 sysctl
const GB = 1024 ** 3;

/** 任务总数上限：多数时间在等网络，给得宽。按物理内存分档，不按 CPU：卡的是内存 */
function autoTasks(totalBytes) {
  const g = totalBytes / GB;
  return g <= 8 ? 3 : g <= 16 ? 5 : g <= 32 ? 8 : 12;
}
/** 重活上限：一件就是几百 MB 起步 */
function autoHeavy(totalBytes) {
  const g = totalBytes / GB;
  return g <= 8 ? 1 : g <= 16 ? 2 : g <= 32 ? 3 : 4;
}

let memoProbe = probeMemory;
let cached = { at: 0, low: false };

/**
 * 这台机器内存紧不紧。三个系统三种问法，都是因为同一个坑：os.freemem() 在 macOS 上只数彻底空闲的页，
 * 文件缓存不算，一台闲着的 16G Mac 经常只报几百 MB——拿它判的话永远「内存紧」。
 * @returns {Promise<boolean>}
 */
function probeMemory() {
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 1500, windowsHide: true }, (err, out) => {
        resolve(!err && Number(String(out).trim()) >= 2); // 1 正常 / 2 警告 / 4 危险
      });
    });
  }
  if (process.platform === "linux") {
    try {
      const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
      if (m) return Promise.resolve(+m[1] * 1024 < Math.min(1.5 * GB, os.totalmem() * 0.1));
    } catch {}
  }
  return Promise.resolve(os.freemem() < Math.min(1.5 * GB, os.totalmem() * 0.1));
}
async function memoryLow() {
  const now = Date.now();
  if (now - cached.at < MEM_CACHE_MS) return cached.low;
  cached = { at: now, low: await memoProbe().catch(() => false) };
  return cached.low;
}

/**
 * 一个名额池。FIFO，同一个人占满自己那份时先让后面的人走。
 * @param {{ limit: () => number, perOwner?: () => number, watchMemory?: boolean }} o
 */
function createPool(o) {
  /** @type {{ owner: string, since: number, grant: (s: any) => void, signal: any, onAbort: any, onWait?: Function, told: number }[]} */
  const queue = [];
  /** @type {Map<string, number>} */
  const running = new Map();
  let total = 0;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  const ownerUsed = (/** @type {string} */ k) => running.get(k) || 0;

  function take(/** @type {string} */ owner) {
    total++;
    running.set(owner, ownerUsed(owner) + 1);
    let done = false;
    return {
      release() {
        if (done) return;
        done = true;
        total--;
        const left = ownerUsed(owner) - 1;
        if (left > 0) running.set(owner, left); else running.delete(owner);
        pump();
      },
    };
  }

  async function pump() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    const low = o.watchMemory ? await memoryLow() : false;
    for (let i = 0; i < queue.length;) {
      const w = queue[i];
      const roomy = total < o.limit();
      const ownerOk = !o.perOwner || ownerUsed(w.owner) < o.perOwner() || total === 0;
      const held = low && total > 0 && Date.now() - w.since < HOLD_MAX_MS;
      if (roomy && ownerOk && !held) {
        queue.splice(i, 1);
        if (w.signal) w.signal.removeEventListener("abort", w.onAbort);
        w.grant(take(w.owner));
        continue;
      }
      if (!roomy) break;
      i++;
    }
    queue.forEach((w, i) => {
      if (w.onWait && w.told !== i + 1) { w.told = i + 1; try { w.onWait({ position: i + 1, running: total, low }); } catch {} }
    });
    if (queue.length) { timer = setTimeout(pump, RECHECK_MS); timer.unref(); }
  }

  /**
   * @param {{ owner?: string, signal?: any, onWait?: (i: { position: number, running: number, low: boolean }) => void }} [a]
   * @returns {Promise<{ release: () => void }>}
   */
  function acquire(a) {
    const { owner = "", signal = null, onWait } = a || {};
    return new Promise((resolve) => {
      // 停了的不占名额也不排队：让 runTask 按它自己的规矩收尾
      if (signal && signal.aborted) { resolve({ release() {} }); return; }
      const w = {
        owner, since: Date.now(), grant: resolve, signal, onWait, told: 0,
        onAbort() {
          const i = queue.indexOf(w);
          if (i >= 0) queue.splice(i, 1);
          resolve({ release() {} });
          pump();
        },
      };
      if (signal) signal.addEventListener("abort", w.onAbort, { once: true });
      queue.push(w);
      pump();
    });
  }

  return { acquire, stats: () => ({ running: total, waiting: queue.length }), _clear() { queue.length = 0; running.clear(); total = 0; if (timer) clearTimeout(timer); timer = null; } };
}

/** @type {any} */
let cfg = {};
const multiUser = { fn: () => false };

function taskLimit() {
  const n = Math.round(+((cfg.agent || {}).max_parallel_tasks) || 0);
  return n > 0 ? Math.min(32, n) : autoTasks(os.totalmem());
}
const heavyLimit = () => autoHeavy(os.totalmem());
// 多人共用时一个人最多占一半，别让谁批量开任务把别人都堵在后面
const perUser = () => (multiUser.fn() ? Math.max(1, Math.ceil(taskLimit() / 2)) : Infinity);

const tasks = createPool({ limit: taskLimit, perOwner: perUser, watchMemory: true });
const pools = {
  render: createPool({ limit: heavyLimit, watchMemory: true }),
  engine: createPool({ limit: heavyLimit, watchMemory: true }),
};

/** 截图、渲染、合成这几样：一件就是一个隐藏浏览器或一个 ffmpeg */
const HEAVY_TOOLS = new Set(["html_to_image", "check_page", "render_motion", "compose_video", "record_web_demo"]);

/** server / cli 起来时接一次。config 是活对象，改了设置下一次取名额就按新的算 */
function configure(c, opts) {
  cfg = c || {};
  if (opts && opts.multiUser) multiUser.fn = opts.multiUser;
}

const say = (emit, text) => { if (emit) try { emit({ type: "status", notice: true, text, depth: 0 }); } catch {} };

/**
 * 顶层任务过这一道。args 就是 runTask 的参数，run 就是 runTask 本身。
 * @template T
 * @param {any} args @param {(a: any) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function admit(args, run) {
  if (args && args.depth) return run(args);
  let waited = false;
  const slot = await tasks.acquire({
    owner: args.user ? String(args.user.id || args.user.username || args.user) : "",
    signal: args.stopSignal,
    onWait: ({ position, running, low }) => {
      waited = true;
      say(args.emit, low
        ? `这台电脑内存有点紧，先等一下再开始（排在第 ${position} 位，正在跑 ${running} 个）。任务时间从开始执行算起`
        : `同时在跑的任务满了，排在第 ${position} 位（正在跑 ${running} 个）。轮到了自动开始，任务时间从那时算起`);
    },
  });
  if (waited && !(args.stopSignal && args.stopSignal.aborted)) say(args.emit, "轮到了，开始执行");
  try { return await run(args); }
  finally { slot.release(); }
}

/**
 * 一件重活。
 * @template T
 * @param {"render"|"engine"} kind
 * @param {{ signal?: any, emit?: Function, label?: string }} a
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function heavy(kind, a, fn) {
  const slot = await pools[kind].acquire({
    signal: a.signal,
    onWait: ({ position }) => say(a.emit, `${a.label || "这一步"}比较吃内存，等前面的做完（第 ${position} 位）`),
  });
  try { return await fn(); }
  finally { slot.release(); }
}

function stats() {
  return { tasks: { ...tasks.stats(), limit: taskLimit() }, render: { ...pools.render.stats(), limit: heavyLimit() }, engine: { ...pools.engine.stats(), limit: heavyLimit() } };
}

module.exports = {
  configure, admit, heavy, stats, HEAVY_TOOLS, autoTasks, autoHeavy, createPool, taskLimit, HOLD_MAX_MS,
  _setMemoryProbe(/** @type {any} */ fn) { memoProbe = fn || probeMemory; cached = { at: 0, low: false }; },
  _reset() { tasks._clear(); pools.render._clear(); pools.engine._clear(); cached = { at: 0, low: false }; },
};
