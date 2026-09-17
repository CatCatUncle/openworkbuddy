"use strict";
/**
 * 产出卡上的缩略图。
 *
 * 2026-09-17 量出来的账，本机工作空间里真实存在的图：
 *
 *     魔术师_塔罗牌.png        2360×3720   6998 KB   解码后 33 MB
 *     card_cover_final.png     3552×4736   6406 KB   解码后 64 MB
 *     xinjiang_5day_map.png    2800×7032   3168 KB   解码后 75 MB
 *
 * 而它们在对话里是一张 **120 px 宽的卡片**。一个回合最多摆 8 张卡（OUT_CARD_MAX），
 * 全撞上大图就是 **293 MB 位图**要浏览器解码、上传纹理、一直占着内存——用户那句
 * 「这个网页版感觉很卡」就是这么来的。原图当缩略图，等于让浏览器把一张海报
 * 完整画出来再缩到指甲盖那么大，画的那一下是实打实的卡顿。
 *
 * **不引任何图像库**——理由和 tools.js shrinkForVision、server.js 的宠物头像那两处一样：
 * 这个项目没有构建步骤，为了缩张图拖一个要编译的原生依赖（sharp / jimp）进来不划算，
 * 而且不少客户是国央企内网、私有化部署，下不动 npm 也编不了原生模块。
 *
 * 于是分两条路，按有没有 nativeImage 走：
 *
 *   桌面版   electron-main.js 那句 require("./server.js") 让 server 跑在 Electron 主进程里，
 *            nativeImage 拿得到。它是 C++，几毫秒，就地缩完，不动线程。
 *   网页版   `npm start` 是纯 node，私有化那台服务器上更是连 electron 都没装
 *            （它只在 devDependencies 里）。走 thumb-png.js 那套只用 zlib 的 PNG 缩图，
 *            扔进 thumb-worker.js 的线程里做。用户那句「这个网页版感觉很卡」说的正是这一边：
 *            之前这边**一张缩略图都没有**，上面那 293 MB 位图是原样丢给浏览器解的。
 *
 * 两条路都走不通（不是 PNG、隔行、文件坏了、线程起不来）就返回 null，调用方原样发原图——
 * 退回没有缩略图那天的行为，不会更差。缩略图是锦上添花，绝不许因为它让一张图显示不出来。
 *
 * 为什么单独一个文件：server.js 是 require 即 listen，写在里头的函数一个都测不到。
 * 而「缩不动要原样发原图」正是最需要有测试钉住的一条。摆在这儿，两条路都能拿真文件跑一遍。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Worker } = require("worker_threads");

const THUMB_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;   // svg 不进来：它是矢量，本来就小，栅格化反而变大
const THUMB_SIZES = new Set([160, 320, 640]);        // 只认这几档，挡住「?thumb=任意数」把缓存目录撑爆
const THUMB_MIN_BYTES = 100 * 1024;                  // 比这还小的，缩一趟省下的还不够那次往返

/** 缓存文件名。键带上 mtime + 体积：文件一改键就变，发不出过期的图 */
function cacheName(abs, st, w) {
  return crypto.createHash("sha1")
    .update(abs + ":" + st.mtimeMs + ":" + st.size + ":" + w).digest("hex") + ".png";
}

/**
 * 缩一张出来，缩不动就返回 null（调用方原样发原图）。
 * 统一出 PNG：源图多半是带透明通道的 PNG，转 JPEG 会把透明底压成黑块，
 * 而卡片底下还垫着一层同图的模糊放大版，黑块会很显眼。320px 的 PNG 撑死一两百 KB，
 * 跟 7 MB 比这点体积不值得为它冒变黑的险。
 */
function makeThumb(abs, w) {
  try {
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromPath(abs);
    if (img.isEmpty()) return null;
    const sz = img.getSize();
    if (!sz.width || !sz.height) return null;
    // 本来就比要的还小：缩了只会更糊，直接让调用方发原图
    if (Math.max(sz.width, sz.height) <= w) return null;
    const out = sz.width >= sz.height ? { width: w, quality: "good" } : { height: w, quality: "good" };
    const buf = img.resize(out).toPNG();
    return buf && buf.length ? buf : null;
  } catch {
    return null; // 纯 node（npm start / 测试 / CLI）里没有 nativeImage
  }
}

/**
 * 给 abs 这张图要一份宽 w 的缩略图，返回一个可以直接 sendFile 的绝对路径。
 * 任何一步不顺——尺寸不在档位里、不是位图、图本来就小、纯 node 没有 nativeImage、
 * 解码失败、缓存目录写不进去——一律返回 null，调用方原样发原图。
 * 缩完落盘，同一张图同一个尺寸只缩一次。
 *
 * 这是**同步**版，只走 nativeImage 那条路：纯 JS 缩一张要几十上百毫秒，
 * 不能在主线程上同步做。服务端走下面的 thumbFileAsync。
 */
function thumbFile(abs, w, cacheDir) {
  try {
    if (!THUMB_SIZES.has(w) || !THUMB_EXT.test(abs)) return null;
    const st = fs.statSync(abs);
    if (st.size <= THUMB_MIN_BYTES) return null;
    const out = path.join(cacheDir, cacheName(abs, st, w));
    if (fs.existsSync(out)) return out;
    const buf = makeThumb(abs, w);
    if (!buf) return null;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(out, buf);
    return out;
  } catch {
    return null;
  }
}

/* ───────────────────── 纯 node 那条路：一小撮缩图线程 ───────────────────── */

const POOL_MAX = 2;      // 缩图是背景活。用户等的是对话，不许它把核抢光
const QUEUE_MAX = 64;    // 排到这么长说明一屏图太多了，后面的直接发原图，别让队伍无限长
const WORKER_FILE = path.join(__dirname, "thumb-worker.js");

let NATIVE = null;       // null=还没问过，true/false=问过了
const workers = [];      // 活着的线程
const idle = [];         // 其中闲着的
const queue = [];        // 排队的活
const jobs = new Map();  // id → 回调
const inflight = new Map(); // 缓存文件名 → Promise，同一张图被点两下只缩一次
let seq = 0;
let spawned = 0;   // 一共起过几个线程（只增不减）。认栽之后不许再涨
let shrinks = 0;   // 真正派给线程的活有多少件。测试靠它分辨「缓存命中」和「又缩了一遍」
let brokenStreak = 0;    // 连着几次线程一起来就挂
const BROKEN_MAX = 3;    // 连挂这么多次就认栽，整条路关掉，全部退回原图

/** 纯 node 里 require("electron") 返回的是一个**字符串**（二进制路径），取 .nativeImage 是 undefined，不抛 */
function hasNativeImage() {
  if (NATIVE === null) {
    try { NATIVE = !!(require("electron") || {}).nativeImage; } catch { NATIVE = false; }
  }
  return NATIVE;
}

function retire(w) {
  if (w.retired) return;               // error 和 exit 会连着来两次
  w.retired = true;
  for (const list of [workers, idle]) {
    const i = list.indexOf(w);
    if (i >= 0) list.splice(i, 1);
  }
  const done = w.job && jobs.get(w.job);
  if (done) { jobs.delete(w.job); done(false); } // 它手上那件活跟着它一起没了，让调用方发原图
  w.job = null;

  // 一件活都没干成就挂，多半不是这张图的问题，是这条路本身坏了——
  // 最典型的是打包时把 thumb-worker.js 漏了（electron-builder 的 files 一改就可能漏）。
  // 这种时候再 pump 就是：起线程→挂→补位→再起→再挂，一直烧着 CPU 转圈。
  // 连挂三次就整条关掉，全部退回原图：没有缩略图只是慢一点，转圈是把机器占死
  if (++brokenStreak >= BROKEN_MAX) {
    for (const job of queue.splice(0)) job.done(false);
    for (const d of jobs.values()) d(false);
    jobs.clear();
    return;
  }
  pump();
}

function spawn() {
  spawned++;
  const w = new Worker(WORKER_FILE);
  w.job = null;
  // 闲着的缩图线程不许吊住进程退出——CLI 和测试都要能正常结束。
  // 这一下目前是防着将来的：spawn() 只有 pump() 里那一个调用点，起完立刻被同一轮同步派活 ref 回去，
  // 所以删掉它今天也测不出差别（变异测试里它是等价变异体）。真正管用的是下面 message 里那次 unref。
  // 留着是因为哪天加了「预热线程」这种起了不立刻派活的路子，少了它进程就退不出去了
  w.unref();
  w.on("message", (msg) => {
    const done = jobs.get(msg.id);
    jobs.delete(msg.id);
    brokenStreak = 0;   // 干成过一件，之前的零星崩溃不算数
    w.job = null;
    w.unref();
    idle.push(w);
    if (done) done(msg.ok);   // 线程只回一个成没成，图它自己写好了
    pump();
  });
  w.on("error", () => retire(w));
  w.on("exit", () => retire(w));
  workers.push(w);
  return w;
}

function pump() {
  while (queue.length && idle.length) {
    const w = idle.pop();
    const job = queue.shift();
    shrinks++;
    jobs.set(job.id, job.done);
    w.job = job.id;
    w.ref();   // 手上有活的时候才拦着进程退出
    w.postMessage(job.msg);
  }
  // 还有活没人接，且还没起满：再起一个。postMessage 会等线程起来，不用等 online
  if (queue.length && workers.length < POOL_MAX) { idle.push(spawn()); pump(); }
}

/** 排一件缩图的活。缩出来了给绝对路径，缩不动给 null */
function enqueueShrink(file, w, out) {
  if (brokenStreak >= BROKEN_MAX) return Promise.resolve(null);  // 这条路已经认栽了，别再试
  if (queue.length >= QUEUE_MAX) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    queue.push({ id, done: (ok) => resolve(ok ? out : null), msg: { id, file, w, out } });
    pump();
  });
}

/**
 * 服务端要缩略图走这里。跟 thumbFile 同样的口径（缩不动返回 null，调用方原样发原图），
 * 区别只在纯 node 下它**真的会缩**，而且缩的那几十毫秒在另一个线程上，不挡 SSE。
 *
 * 顺序有讲究：
 *   1. 缓存命中就走人——一次 statSync，绝大多数请求到这儿就结束了
 *   2. 有 nativeImage 就地缩（C++，几毫秒），桌面版的行为跟以前一模一样，一个线程都不起
 *   3. 否则只认 PNG（thumb-png.js 只会 PNG），扔线程
 */
async function thumbFileAsync(abs, w, cacheDir) {
  try {
    if (!THUMB_SIZES.has(w) || !THUMB_EXT.test(abs)) return null;
    const st = fs.statSync(abs);
    if (st.size <= THUMB_MIN_BYTES) return null;
    const out = path.join(cacheDir, cacheName(abs, st, w));
    if (fs.existsSync(out)) return out;

    if (hasNativeImage()) {
      const buf = makeThumb(abs, w);
      if (!buf) return null;
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(out, buf);
      return out;
    }

    if (!/\.png$/i.test(abs)) return null;
    const pending = inflight.get(out);
    if (pending) return await pending;                 // 同一张图同时被点了两下
    const task = enqueueShrink(abs, w, out).finally(() => inflight.delete(out));
    inflight.set(out, task);
    return await task;
  } catch {
    return null;
  }
}

/** 测试和退出时用：把线程都收掉，别让进程吊着 */
function closeThumbPool() {
  const all = workers.slice();
  workers.length = 0;
  idle.length = 0;
  queue.length = 0;
  for (const w of all) { w.retired = true; w.terminate(); }
  for (const done of jobs.values()) done(false);  // 排着的活别让调用方干等，返回 null 走原图
  jobs.clear();
  inflight.clear();
  brokenStreak = 0;
}

/** 只给测试看：派给线程的活件数 / 还排着的 / 起了几个线程。
 *  「同一张图只缩一次」「第二次走缓存」这两件事从外面是看不出来的——
 *  三个请求本来就写同一个缓存文件，光数目录里的文件数永远是 1，重复缩根本露不出来 */
function thumbPoolStats() {
  return { shrinks, spawned, queued: queue.length, workers: workers.length, broken: brokenStreak >= BROKEN_MAX };
}

module.exports = {
  thumbFile, thumbFileAsync, makeThumb, cacheName, closeThumbPool, thumbPoolStats,
  hasNativeImage, THUMB_EXT, THUMB_SIZES, THUMB_MIN_BYTES,
};

