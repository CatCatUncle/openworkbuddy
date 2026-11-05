// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 工作区文件清单：后台线程走树 + 先给旧的、后台换新的。
 *
 * 2026-11 实测（两万文件的工作区）：资料库点一下页签要等 200~750ms，返回的数据才几十 KB。
 * 时间全花在主线程同步走树上——单独只要 7ms 的 /api/library 被它拖到 170ms，
 * 任务在跑、工作区一直在变的时候，三秒记忆次次过期，每点一下都重走一遍。
 *
 * 这里三件事：
 *   1. 走树挪到后台线程。主线程只等结果，等的时候照样收发别的请求和流式输出；
 *   2. 记忆过期了不让人等：先在 SETTLE_MS 里等一下新结果，小工作区走得完，拿到的就是新的；
 *      大工作区走不完，先回上一份，走完换上——下一次看到的就是新的。一份清单晚几百毫秒不要紧，
 *      点了没反应才要紧；
 *   3. 增删文件的接口调 clear()：下一次一定等新结果，不会把刚删的东西再画回来。
 *
 * 线程闲 IDLE_MS 就收掉，起不来就退回主线程走，不会因此读不出清单。
 */
const path = require("path");
const { Worker } = require("worker_threads");
const wsBrowse = require("./ws-browse");

const FRESH_MS = 3000;      // 这么久之内直接用记忆（跟 walkMemo 一个数）
const SETTLE_MS = 150;      // 过期了先等这么久；比「点一下有反应」的门槛短
const KEEP_MS = 10 * 60 * 1000; // 再旧的不拿出来糊弄人，老老实实等新的
const IDLE_MS = 30000;
const WORKER_FILE = path.join(__dirname, "walk-worker.js");
const BROKEN_MAX = 3;       // 线程连挂这么多次就认栽，之后全在主线程走

/** @typedef {{ files: ReadonlyArray<{ name: string, size: number, mtime: string }>, capped: boolean }} WalkResult */
/** @type {Map<string, { at: number, v: WalkResult | null, pending: Promise<WalkResult> | null }>} */
const entries = new Map();
let gen = 0; // clear() 之前发出去的那趟不许把结果写回来：它可能正好没看见刚删的文件

/** @type {Worker | null} */
let worker = null;
let seq = 0;
let broken = 0;
/** @type {NodeJS.Timeout | null} */
let idle = null;
/** @type {Map<number, { resolve: (v: WalkResult) => void, reject: (e: Error) => void }>} */
const waiting = new Map();

function dropWorker() {
  const w = worker;
  worker = null;
  if (w) w.terminate().catch(() => {});
}
function failAll(/** @type {Error} */ e) {
  for (const [, x] of waiting) x.reject(e);
  waiting.clear();
}
function workerOf() {
  if (worker) return worker;
  const w = new Worker(WORKER_FILE);
  w.unref(); // 别让它拖着进程不退
  w.on("message", (m) => {
    const job = waiting.get(m.id);
    if (!job) return;
    waiting.delete(m.id);
    broken = 0;
    if (m.error) job.reject(new Error(m.error));
    else job.resolve(Object.freeze({ files: Object.freeze(m.files), capped: !!m.capped }));
    armIdle();
  });
  const dead = (/** @type {Error} */ e) => { broken++; if (worker === w) worker = null; failAll(e); };
  w.on("error", dead);
  w.on("exit", () => { if (worker === w) { worker = null; failAll(new Error("走树线程退出了")); } });
  worker = w;
  return w;
}
function armIdle() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => { if (!waiting.size) dropWorker(); }, IDLE_MS);
  idle.unref();
}

/**
 * @param {string} root @param {any} opts
 * @returns {Promise<WalkResult>}
 */
function walkOffThread(root, opts) {
  if (broken >= BROKEN_MAX) return Promise.resolve(wsBrowse.walkAll(root, opts));
  return new Promise((resolve, reject) => {
    let w;
    try { w = workerOf(); } catch (e) { reject(e); return; }
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, root, opts });
  }).catch(() => wsBrowse.walkAll(root, opts)); // 线程这条路没走通：主线程照走，清单不能因此读不出来
}

function keyOf(/** @type {string} */ root, /** @type {any} */ o) {
  return [path.resolve(root), o.appDataDir || "", o.maxDepth || wsBrowse.WALK_DEPTH, o.cap || wsBrowse.WALK_CAP].join("\n");
}

/** @param {string} key @param {string} root @param {any} o */
function refresh(key, root, o) {
  let e = entries.get(key);
  if (!e) { e = { at: 0, v: null, pending: null }; entries.set(key, e); }
  if (e.pending) return e.pending;
  const mine = gen;
  const ent = e;
  const p = walkOffThread(root, o).then((v) => {
    if (mine === gen) { ent.v = v; ent.at = Date.now(); }
    ent.pending = null;
    return v;
  }, (err) => { ent.pending = null; throw err; });
  e.pending = p;
  return p;
}

/**
 * 工作区清单。回来的东西是冻住的，几条请求共用同一份，别原地改。
 * @param {string} root
 * @param {{ appDataDir?: string, maxDepth?: number, cap?: number }} [opts]
 * @returns {Promise<WalkResult>}
 */
async function walk(root, opts) {
  const o = opts || {};
  const key = keyOf(root, o);
  const e = entries.get(key);
  const age = e && e.v ? Date.now() - e.at : Infinity;
  if (e && e.v && age < FRESH_MS) return e.v;
  const next = refresh(key, root, o);
  if (!e || !e.v || age >= KEEP_MS) return next;
  const stale = e.v;
  /** @type {NodeJS.Timeout | undefined} */
  let t;
  const timeout = new Promise((resolve) => { t = setTimeout(() => resolve(stale), SETTLE_MS); });
  next.catch(() => {}); // 比输了的那条别成没人接的拒绝
  try { return /** @type {WalkResult} */ (await Promise.race([next, timeout])); }
  finally { clearTimeout(t); }
}

/** 文件增删改了：下一次一定等新结果 */
function clear() { gen++; entries.clear(); wsBrowse.walkMemo.clear(); }
/** 任务收尾：清单该换了，但不必让下一次干等，走 SETTLE_MS 那条路 */
function touch() { for (const e of entries.values()) e.at = 0; }

// 一份清单算一次就够的东西。几条请求共用同一份冻住的结果，查找表也跟着共用
/** @type {WeakMap<object, { byName: Map<string, any>, deckDirs: Set<string> }>} */
const derived = new WeakMap();
/** @param {WalkResult} w */
function derive(w) {
  let d = derived.get(w);
  if (d) return d;
  const byName = new Map();
  const deckDirs = new Set();
  for (const f of w.files) {
    byName.set(f.name, f);
    if (/(^|\/)deck\.json$/.test(f.name)) deckDirs.add(path.posix.dirname(f.name));
  }
  d = { byName, deckDirs };
  derived.set(w, d);
  return d;
}

function _reset() { clear(); failAll(new Error("reset")); dropWorker(); broken = 0; }

module.exports = { walk, clear, touch, derive, FRESH_MS, SETTLE_MS, KEEP_MS, _reset, _state: () => ({ entries: entries.size, worker: !!worker, broken }) };
