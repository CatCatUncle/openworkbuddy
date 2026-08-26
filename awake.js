"use strict";
/**
 * 本机睡眠治理（借鉴自 CatClaw 的 sleep-watch / keep-awake 设计）。两件事：
 *
 * 1. sleep-watch —— 「睡着了不该算进任务时间」。
 *    setTimeout 计的是墙上时间：Mac 合盖 / 深度睡眠期间整个进程被冻住，一行代码都
 *    不执行；醒来那一刻所有过期的计时器一起开枪。于是一个跑到一半跟着机器睡过去的
 *    任务，醒来立刻被判「已达最大运行时间」或「模型挂起」——它压根没得到过那些时间
 *    的 CPU。修法：起一个 10 秒心跳，醒着时每跳间隔就是 10 秒；睡过去再醒，这一跳
 *    会迟到几十秒到几十分钟——迟到的部分就是睡眠时长，通知所有在跑的任务把 deadline
 *    整体往后推同样的时长，等于「睡觉不算数」。
 *
 * 2. keep-awake —— 「跑任务的时候尽量别让机器睡回去」。
 *    上面解决的是记账问题（不再冤枉判死），但电池供电时 macOS 可能每 15 分钟只醒
 *    2 秒（暗唤醒），任务会变成「每 15 分钟推进 2 秒」。所以任务运行期间向系统要一个
 *    「别进空闲睡眠」的断言：Electron 里用原生 powerSaveBlocker；纯 node 起服务时
 *    darwin 用 `caffeinate -i -m -w <自己的 pid>`（-w 盯住进程，进程一退断言自动
 *    释放，主进程被 kill -9 也不会留下按住不放的断言把电池熬干）。引用计数：多个
 *    任务并行时只按一次，全部结束才松手。
 *
 * 边界：断言挡的是**空闲**睡眠；合盖且无外接显示器时系统仍会睡，挡不住——所以两层
 * 都要有：挡不住的那部分，由 sleep-watch 顺延兜底。全程尽力而为，任何一步失败都
 * 绝不抛错——睡眠治理是锦上添花，不该让任务因此起不来。
 */

const TICK_MS = 10000;
// 事件循环被占满、GC、系统调度抖动都会让心跳迟到几百毫秒甚至偶尔几秒——那不是睡眠，
// 误判会白白延长超时。5 秒足够把抖动和真睡眠分开（真睡眠最短也是几十秒起）。
const SLACK_MS = 5000;

const watchers = new Set();
let ticker = null;
let lastTickAt = 0;
let cumulativeMs = 0; // 进程启动以来累计检测到的睡眠毫秒数

/** 从一次心跳的实际间隔里算出睡了多少毫秒（纯函数，测试用不着真把机器睡着）。 */
function suspendedFromTick(actualGapMs, tickMs = TICK_MS, slackMs = SLACK_MS) {
  const drift = actualGapMs - tickMs;
  return drift > slackMs ? drift : 0;
}

function startTicker() {
  if (ticker) return;
  lastTickAt = Date.now();
  ticker = setInterval(() => {
    const now = Date.now();
    const slept = suspendedFromTick(now - lastTickAt);
    lastTickAt = now;
    if (slept <= 0) return;
    cumulativeMs += slept;
    console.warn(`[睡眠治理] 检测到本机睡眠 ${Math.round(slept / 1000)} 秒，任务时限整体顺延（睡眠不算任务时间）`);
    for (const fn of watchers) {
      try { fn(slept); } catch (e) { console.warn("[睡眠治理] 顺延回调出错:", e.message); }
    }
  }, TICK_MS);
  if (ticker.unref) ticker.unref(); // 别拖住进程退出
}

/**
 * 注册一个睡眠回调：检测到睡眠时以睡眠毫秒数调用。返回注销函数。
 * 没有任何任务在跑时心跳自动停，不白耗电。
 */
function watch(fn) {
  watchers.add(fn);
  startTicker();
  return () => {
    watchers.delete(fn);
    if (watchers.size === 0 && ticker) { clearInterval(ticker); ticker = null; }
  };
}

function totalSuspendedMs() { return cumulativeMs; }

// ---------- keep-awake：任务运行期间阻止空闲睡眠（引用计数） ----------

let holdCount = 0;
let blockerId = null; // Electron powerSaveBlocker 的 id
let caffProc = null;  // 纯 node 模式下的 caffeinate 子进程
let warnedOnce = false;

function acquireAssertion() {
  try {
    const electron = require("electron");
    if (electron && electron.powerSaveBlocker) {
      blockerId = electron.powerSaveBlocker.start("prevent-app-suspension");
      return;
    }
  } catch {} // 不在 Electron 里，走 caffeinate
  if (process.platform !== "darwin") return;
  try {
    const { spawn } = require("child_process");
    // -i 阻止空闲睡眠；-m 阻止磁盘转入空闲；-w 盯住自己的 pid，进程退了断言自动释放
    caffProc = spawn("caffeinate", ["-i", "-m", "-w", String(process.pid)], { stdio: "ignore", detached: true });
    caffProc.on("error", () => {
      caffProc = null;
      if (!warnedOnce) { warnedOnce = true; console.warn("[睡眠治理] 找不到 caffeinate，任务运行期间无法阻止空闲睡眠"); }
    });
    caffProc.unref();
  } catch { caffProc = null; }
}

function releaseAssertion() {
  if (blockerId !== null) {
    try {
      const electron = require("electron");
      if (electron.powerSaveBlocker.isStarted(blockerId)) electron.powerSaveBlocker.stop(blockerId);
    } catch {}
    blockerId = null;
  }
  if (caffProc) {
    try { caffProc.kill("SIGTERM"); } catch {}
    caffProc = null;
  }
}

/** 任务开跑时调用；返回释放函数（幂等，重复调用无害）。 */
function hold() {
  holdCount++;
  if (holdCount === 1) { try { acquireAssertion(); } catch {} }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holdCount = Math.max(0, holdCount - 1);
    if (holdCount === 0) { try { releaseAssertion(); } catch {} }
  };
}

module.exports = { watch, hold, totalSuspendedMs, suspendedFromTick, TICK_MS, SLACK_MS };
