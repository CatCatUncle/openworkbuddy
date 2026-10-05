// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 资料库封面：PDF / Office / 网页 / 视频这些「浏览器自己画不出第一页」的文件，在后台一张张出封面。
 *
 * 接口一侧（routes/library.js）只负责认人、解析路径；这里管三件事：
 *   ① 这个文件该走哪条路（图片 / 网页 / Quick Look / 视频帧 / 只给图标）；
 *   ② 出过的封面落盘在 data/thumbs/cover-<sha1>.png，下次直接给地址；
 *   ③ 没出过的排进一条**只有一个车道**的队，按「租约」干活。
 *
 * 为什么要租约：前端每 1.5 秒把还在排队的那几张再报一遍（最多 20 次），报一次续 5 秒。
 * 用户翻过去了、关掉资料库了，就不再续，5 秒后这件活在开工前被扔掉——
 * 不然一屏滚过两百个 PDF，qlmanage 会在后台把两百张都出完，没有一张有人看。
 *
 * 为什么只有一个车道、还要让着 agent：封面是锦上添花。qlmanage / ffmpeg 一趟就是一个子进程，
 * 网页封面还要开离屏窗口，跟正在跑的任务抢的是同一颗 CPU。所以：
 *   · 全局同时最多一件（不管几个账号在翻资料库）；
 *   · 有任务在跑的时候，两件之间至少空 800ms，而且两次开工至少隔 2 秒；
 *   · 事件循环卡了（p95 超 50ms，perf_hooks.monitorEventLoopDelay 量的）就整条队停 2 秒。
 *     这个监视器只在队里有活的时候开着，平时一个定时器都不多挂。
 *
 * 失败分两种记：渲染器**明确报错**的（文件坏了、格式认不出），落一个 cover-<sha1>.fail，
 * 同一版文件不再试；**超时**的只记在内存里——超时多半是那一刻机器忙，不是文件的错，
 * 落盘的话这份文件就永远没封面了。文件一改（mtime / 体积变了），键跟着变，两种都自动作废。
 *
 * 渲染器全从外面注进来（真的那几个在 ql-thumb.js / video-frame.js / htmlshot.js），
 * 测试拿假的换掉，Linux CI 上一个子进程都不起。
 */
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const MB = 1024 * 1024;
const COVER_WIDTHS = new Set([160, 320, 640]);
const COVER_MAX_ITEMS = 60;
const LEASE_MS = 5000;
const BUSY_GAP_MS = 800;        // 有任务在跑：上一件收尾到下一件开工至少空这么久
const BUSY_START_GAP_MS = 2000; // 有任务在跑：两次开工至少隔这么久（一件 150ms 的活也不许连着来）
const LAG_P95_MS = 50;
const LAG_PAUSE_MS = 2000;
const QUEUE_MAX = 240;          // 四屏的量。再多就是用户滚得比出封面快，最老的那头扔掉
const HTML_MAX_BYTES = 5 * MB;  // 比这还大的网页多半内嵌了一堆 base64 图，离屏窗口加载一趟就是几百 MB 内存
const TIMEOUTS = { office: 8000, video: 8000, html: 5000 };
const GUARD_GRACE_MS = 2000;    // 渲染器自己到点会杀子进程；它要是没杀干净，这边再多等 2 秒就不等了
const TIMED_OUT_MAX = 2000;
// 缓存键的版本：出图的规矩一改（比如换了缩放算法），抬一下这个数，老封面就自然没人认领，一个月后被 retention.js 清掉
const COVER_KEY_VER = "v1";

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg|avif|ico)$/i;
const HTML_RE = /\.html?$/i;
// heic / tiff 浏览器画不出来，Quick Look 画得出来：iPhone 拍的照片多半是 heic
const OFFICE_RE = /\.(pdf|docx?|xlsx?|pptx?|key|pages|numbers|rtf|heic|heif|tiff?)$/i;
const VIDEO_RE = /\.(mp4|mov|webm|mkv|m4v)$/i;

/** 按后缀认类型：image / html / office / video，其余空串（只给图标） */
function coverKindOf(name) {
  const n = String(name || "");
  if (IMAGE_RE.test(n)) return "image";
  if (HTML_RE.test(n)) return "html";
  if (OFFICE_RE.test(n)) return "office";
  if (VIDEO_RE.test(n)) return "video";
  return "";
}

/** 这一版文件的版本号：mtimeMs-体积。封面地址上的 ?v= 就是它，对得上才让浏览器长期缓存 */
function coverVersion(st) {
  return `${st.mtimeMs}-${st.size}`;
}

/**
 * 缓存键。带上**这个人的**资料库根：两个账号各放一份同名、同 mtime、同体积的文件，
 * 键也不一样，谁都拿不到对方那张（test/library-cover.js ⑪）
 */
function coverKey({ userRoot, src, abs, mtimeMs, size, w }) {
  return crypto.createHash("sha1")
    .update([COVER_KEY_VER, userRoot, src, abs, mtimeMs, size, w].join("|")).digest("hex");
}

/** 前端拿去当 <img src> 的地址。只是一把钥匙：服务端按请求人的根重新解析、重算键，对不上就 404 */
function coverUrl({ src, rel, w, st }) {
  return `/api/library/cover?src=${encodeURIComponent(src)}&path=${encodeURIComponent(rel)}&w=${w}&v=${encodeURIComponent(coverVersion(st))}`;
}

/** 封面要出多大：页面上的框是 w，高分屏要两倍，封顶 640 */
function coverTarget(w) {
  return Math.min(2 * w, 640);
}

// ───────────── 真渲染器：用到才 require，模块不在（或纯 node 没有窗口）就只给图标 ─────────────

/** 模块不在就当这条车道没有；在但加载就炸（语法错之类）也一样，只多打一行日志——封面出不来不许拖垮开机 */
function tryRequire(name) {
  try { return require(name); } catch (e) {
    if (!(e && e.code === "MODULE_NOT_FOUND")) console.warn(`[封面] ${name} 加载失败，这条车道先关着：${(e && e.message) || e}`);
    return null;
  }
}

/** @returns {{ office?: Function, video?: Function, html?: Function, shrink?: Function }} */
function defaultRenderers() {
  const out = {};
  const ql = tryRequire("./src/platform/render/ql-thumb");
  if (ql && typeof ql.qlThumb === "function") out.office = (abs, o) => ql.qlThumb(abs, { size: o.target, timeoutMs: o.timeoutMs, signal: o.signal });
  const vf = tryRequire("./src/platform/render/video-frame");
  if (vf && typeof vf.videoFrame === "function") out.video = (abs, o) => vf.videoFrame(abs, { width: o.target, timeoutMs: o.timeoutMs, signal: o.signal });
  // fileRoot 给到这个人的根：AI 写的页面常引 ../assets/ 下的图，缺省只放行 html 所在那一层会缺图
  out.html = (abs, o) => require("./src/platform/render/htmlshot").renderHtmlToPngAny(abs, {
    width: 1280, height: 800, lane: "cover", timeoutMs: o.timeoutMs, signal: o.signal, ...(o.root ? { fileRoot: o.root } : {}),
  });
  out.shrink = shrinkPng;
  return out;
}

/**
 * 网页截出来是 1280×800 的整张，缩到封面大小再落盘。借 thumb.js 那一条（桌面版 nativeImage，
 * 服务进程走 bridge，纯 node 走缩图线程），缓存目录给一个用完就删的临时目录，不往 data/thumbs 里留普通缩略图。
 * 缩不动就原样存整张（最多一两百 KB）。
 */
async function shrinkPng(buf, w) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "owb-cover-"));
  try {
    const src = path.join(dir, "shot.png");
    await fsp.writeFile(src, buf);
    const out = await require("./src/platform/render/thumb").thumbFileAsync(src, w, dir);
    return out ? await fsp.readFile(out) : null;
  } catch { return null; } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 网页封面只认 Electron（本进程或过桥）：无头 Chrome 那条每张都冷启动一个浏览器，一律给图标 */
function defaultHtmlBackend() {
  try {
    const h = require("./src/platform/render/htmlshot");
    if (typeof h.coverAvailable === "function") return h.coverAvailable() ? "electron" : "";
    return h.shotAvailable().backend || "";
  } catch { return ""; }
}

async function defaultHasFfmpeg() {
  try { return !!(await require("./lib/media-probe").resolveMediaBins()).ffmpeg.bin; } catch { return false; }
}

/** 事件循环卡没卡：只在队里有活时开着 */
function defaultLagMonitor() {
  const { monitorEventLoopDelay } = require("perf_hooks");
  let h = null;
  return {
    enable() { if (!h) h = monitorEventLoopDelay({ resolution: 10 }); h.reset(); h.enable(); },
    disable() { if (h) { h.disable(); h.reset(); } },
    p95Ms() { return h && h.count ? h.percentile(95) / 1e6 : 0; },
    reset() { if (h) h.reset(); },
    get enabled() { return !!h; },
  };
}

/** 只留最近 64 个时刻（测试拿它量间隔；常驻进程里不许越攒越多） */
function keepLast(list, v) {
  list.push(v);
  if (list.length > 64) list.shift();
}

function isTimeoutError(e) {
  if (!e) return false;
  if (e.timedOut || e.code === "SHOT_TIMEOUT" || e.code === "ETIMEDOUT" || e.name === "TimeoutError" || e.name === "AbortError") return true;
  return /timed?\s*out|超时/i.test(String(e.message || ""));
}

/**
 * 不是这份文件的错、也不是超时：渲染器此刻不在（NO_RENDERER，桌面窗口还没起来 / 已经关了）、
 * 这一单被叫停（stopped，退出时收摊）。这两种既不落 .fail 也不记超时，下一趟照常再问
 */
function isTransientError(e) {
  return !!e && (e.code === "NO_RENDERER" || e.stopped === true);
}

/**
 * @param {object} opt
 * @param {string} opt.cacheDir data/thumbs
 * @param {object} [opt.renderers] { office, video, html, shrink }；不传就用真的
 * @param {string} [opt.platform]
 * @param {() => string} [opt.htmlBackend] "electron" 才出网页封面
 * @param {() => Promise<boolean>} [opt.hasFfmpeg]
 * @param {() => boolean} [opt.busy] 有没有任务在跑
 * @param {() => number} [opt.now]
 * @param {(ms: number) => Promise<void>} [opt.sleep]
 * @param {object} [opt.lagMonitor]
 * @param {Partial<typeof TIMEOUTS>} [opt.timeouts]
 * @param {number} [opt.guardGraceMs]
 * @param {(m: string) => void} [opt.log]
 */
/**
 * 手上正在出的封面：进程退出那一刻一把叫停。
 * 2026-09-29 跑测试时逮到的：服务进程一退，正在跑的 qlmanage 就成了孤儿（它是 detached 起的，为的是到点
 * 能连进程组一起杀），碰上认不出的文件一挂两分钟以上，本机一次攒了 4 个。exit 钩子里只能干同步的事，
 * abort 正好是同步派发的——渲染器的 onAbort 当场 SIGKILL 整组。kill -9 掉服务进程的话谁也拦不住，那种只能靠它自己超时。
 */
const liveAborts = new Set();
let exitHooked = false;
function abortAllOnExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const ac of liveAborts) { try { ac.abort(); } catch {} }
  });
}

function createCoverQueue(opt) {
  const cacheDir = opt.cacheDir;
  // 真渲染器用到才 require：开机不为一个还没人点开的资料库多加载三个模块
  let renderersMemo = opt.renderers || null;
  const R = () => renderersMemo || (renderersMemo = defaultRenderers());
  const platform = opt.platform || process.platform;
  const htmlBackend = opt.htmlBackend || defaultHtmlBackend;
  const hasFfmpeg = opt.hasFfmpeg || defaultHasFfmpeg;
  const busy = opt.busy || (() => false);
  const now = opt.now || Date.now;
  const sleep = opt.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }));
  const lag = opt.lagMonitor || defaultLagMonitor();
  const timeouts = { ...TIMEOUTS, ...(opt.timeouts || {}) };
  const guardGraceMs = opt.guardGraceMs == null ? GUARD_GRACE_MS : opt.guardGraceMs;
  const log = opt.log || ((m) => console.warn(m));

  /** @type {Map<string, any>} 键 → 活。Map 按插入序，先来的先干 */
  const queue = new Map();
  const timedOut = new Set();
  // 工具在不在：网页后端每 30 秒问一次（桌面版的窗口可能晚于服务起来）；ffmpeg 找到就记住，没找到一分钟后再找
  let htmlMemo = { at: -Infinity, v: "" };
  let ffmpegMemo = { at: -Infinity, v: /** @type {boolean|null} */ (null) };
  let ffmpegProbe = null;
  let running = false;
  let idleWaiters = [];
  let pausedUntil = 0;
  let lastStart = -Infinity;
  let lastEnd = -Infinity;
  const stats = { renders: 0, inflight: 0, maxInflight: 0, dropped: 0, failed: 0, timedOut: 0, pauses: 0, busyWaits: 0, starts: /** @type {number[]} */ ([]), ends: /** @type {number[]} */ ([]) };

  const pngOf = (key) => path.join(cacheDir, `cover-${key}.png`);
  const failOf = (key) => path.join(cacheDir, `cover-${key}.fail`);

  function htmlReady() {
    if (String(process.env.OPENWORKBUDDY_LIB_HTML_COVER || "").toLowerCase() === "off") return false;
    if (now() - htmlMemo.at > 30000) htmlMemo = { at: now(), v: htmlBackend() };
    return htmlMemo.v === "electron";
  }
  function ffmpegState() {
    if (ffmpegMemo.v === false && now() - ffmpegMemo.at > 60000) ffmpegMemo = { at: now(), v: null };
    if (ffmpegMemo.v === null && !ffmpegProbe) {
      ffmpegProbe = Promise.resolve().then(hasFfmpeg).catch(() => false).then((v) => {
        ffmpegMemo = { at: now(), v: !!v };
        ffmpegProbe = null;
        return !!v;
      });
    }
    return ffmpegMemo.v;
  }

  /**
   * 这个文件走哪条车道。空串 = 永远只给图标。
   * @param {string} abs @param {number} size
   */
  function laneOf(abs, size) {
    const kind = coverKindOf(abs);
    const renderers = R();
    if (kind === "html") return renderers.html && size <= HTML_MAX_BYTES && htmlReady() ? "html" : "";
    // Quick Look 只有 macOS 有。别的系统上连 spawn 都不试（test/library-cover.js ⑨）
    if (kind === "office") return renderers.office && platform === "darwin" ? "office" : "";
    if (kind === "video") return renderers.video && ffmpegState() !== false ? "video" : "";
    return "";
  }

  /**
   * 问一张封面。
   * @param {{ userRoot: string, src: string, rel: string, abs: string, st: fs.Stats, w: number }} it
   * @returns {Promise<{ ready: string } | { queued: true } | { icon: true }>}
   */
  async function ask({ userRoot, src, rel, abs, st, w, root }) {
    // 头一次碰到视频：等 ffmpeg 找完再答。不等的话没装 ffmpeg 的机器头一趟全给「排队」，前端白轮询一轮
    if (coverKindOf(abs) === "video" && ffmpegState() === null && ffmpegProbe) await ffmpegProbe;
    const lane = laneOf(abs, st.size);
    if (!lane) return { icon: true };
    const key = coverKey({ userRoot, src, abs, mtimeMs: st.mtimeMs, size: st.size, w });
    if (await hit(pngOf(key))) return { ready: coverUrl({ src, rel, w, st }) };
    if (timedOut.has(key)) return { icon: true };
    if (await exists(failOf(key))) return { icon: true };
    const lease = now() + LEASE_MS;
    const cur = queue.get(key);
    if (cur) cur.leaseUntil = lease;
    else {
      queue.set(key, { key, lane, abs, root: root || "", mtimeMs: st.mtimeMs, size: st.size, w, leaseUntil: lease });
      trim();
    }
    kick();
    return { queued: true };
  }

  /** 队太长：先扔租约过了的，还长就扔最老的 */
  function trim() {
    if (queue.size <= QUEUE_MAX) return;
    const t = now();
    for (const [k, job] of queue) if (job.leaseUntil < t) { queue.delete(k); stats.dropped++; }
    for (const k of queue.keys()) {
      if (queue.size <= QUEUE_MAX) break;
      queue.delete(k); stats.dropped++;
    }
  }

  /** 命中就摸一下 mtime（一天一次），retention.js 按它挑最久没人看的删。跟 thumb.js 的 cacheHit 同一个规矩 */
  async function hit(file) {
    let st;
    try { st = await fsp.stat(file); } catch { return false; }
    if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) {
      const t = new Date();
      fsp.utimes(file, t, t).catch(() => {});
    }
    return true;
  }
  async function exists(file) {
    try { await fsp.stat(file); return true; } catch { return false; }
  }

  function kick() {
    if (running) return;
    running = true;
    lag.enable();
    pump().catch((e) => log(`[封面] 队列出错停下了：${(e && e.message) || e}`)).finally(() => {
      running = false;
      lag.disable();
      const ws = idleWaiters; idleWaiters = [];
      for (const r of ws) r();
      if (queue.size) kick(); // 停下的那一刻刚好又进来一件
    });
  }

  /** 下一件还有人要的活；路上碰到租约过了的顺手扔掉 */
  function nextLive() {
    const t = now();
    for (const [k, job] of queue) {
      if (job.leaseUntil >= t) return job;
      queue.delete(k); stats.dropped++;
    }
    return null;
  }

  /** 该不该先等等。等过了返回 true，外面重新挑活（等的这会儿租约可能过了） */
  async function gate() {
    if (lag.p95Ms() > LAG_P95_MS) {
      pausedUntil = now() + LAG_PAUSE_MS;
      stats.pauses++;
      lag.reset();
    }
    if (now() < pausedUntil) { await sleep(pausedUntil - now()); return true; }
    if (busy()) {
      const wait = Math.max(lastEnd + BUSY_GAP_MS, lastStart + BUSY_START_GAP_MS) - now();
      if (wait > 0) { stats.busyWaits++; await sleep(wait); return true; }
    }
    return false;
  }

  async function pump() {
    for (;;) {
      const job = nextLive();
      if (!job) return;
      if (await gate()) continue;
      // 开工前最后看一眼：租约还在不在、文件是不是还是那一版
      if (job.leaseUntil < now()) { queue.delete(job.key); stats.dropped++; continue; }
      queue.delete(job.key);
      let st = null;
      try { st = await fsp.stat(job.abs); } catch {}
      if (!st || st.mtimeMs !== job.mtimeMs || st.size !== job.size) continue; // 改过了：前端下一趟会按新版本再问
      lag.reset(); // 开工这一刻起重新量：只看最近这一段卡没卡
      lastStart = now();
      keepLast(stats.starts, lastStart);
      try { await render(job); } finally {
        lastEnd = now();
        keepLast(stats.ends, lastEnd);
      }
    }
  }

  async function render(job) {
    stats.inflight++;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    const timeoutMs = timeouts[job.lane];
    const ac = new AbortController();
    liveAborts.add(ac);
    abortAllOnExit();
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(Object.assign(new Error(`出封面超过 ${timeoutMs + guardGraceMs}ms 没回来`), { timedOut: true }));
      }, timeoutMs + guardGraceMs);
      if (timer.unref) timer.unref();
    });
    const t0 = Date.now();
    try {
      if (job.lane === "video" && ffmpegState() !== true) {
        const ok = ffmpegProbe ? await ffmpegProbe : ffmpegMemo.v;
        if (!ok) return; // 没有 ffmpeg：下一趟 ask 走 laneOf 直接回图标，不落 .fail（装上就该有）
      }
      const renderers = R();
      const target = coverTarget(job.w);
      stats.renders++;
      let buf = await Promise.race([renderers[job.lane](job.abs, { target, timeoutMs, signal: ac.signal, root: job.root }), guard]);
      if (buf && job.lane === "html" && renderers.shrink) {
        const small = await renderers.shrink(buf, target).catch(() => null);
        if (small && small.length) buf = small;
      }
      if (buf && buf.length) { await writeAtomic(pngOf(job.key), buf); return; }
      // 空结果：用满了时间的按超时算（渲染器到点自己收手时就是这样），没用满的按「出不来」落 .fail
      if (Date.now() - t0 >= 0.9 * timeoutMs) { rememberTimeout(job.key); return; }
      await markFail(job.key, "渲染器没有给出图");
    } catch (e) {
      if (isTimeoutError(e) || ac.signal.aborted) { rememberTimeout(job.key); return; }
      if (isTransientError(e)) {
        if (e.code === "NO_RENDERER") htmlMemo = { at: now(), v: "" }; // 30 秒内这类文件直接给图标，别每张都去撞一次
        log(`[封面] 这一张先不出：${(e && e.message) || e}`);
        return;
      }
      await markFail(job.key, (e && e.message) || String(e));
    } finally {
      clearTimeout(timer);
      liveAborts.delete(ac);
      stats.inflight--;
    }
  }

  function rememberTimeout(key) {
    stats.timedOut++;
    timedOut.add(key);
    if (timedOut.size > TIMED_OUT_MAX) timedOut.delete(timedOut.values().next().value);
  }
  async function markFail(key, why) {
    stats.failed++;
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(failOf(key), String(why || "").slice(0, 300));
    } catch {}
  }
  let seq = 0;
  async function writeAtomic(file, buf) {
    await fsp.mkdir(cacheDir, { recursive: true });
    // 临时名跟 thumb-worker.js 一个格式（<名>.<pid>.<序号>.part），retention.js 一天后清掉崩在半路的
    const tmp = `${file}.${process.pid}.${++seq}.part`;
    await fsp.writeFile(tmp, buf);
    try { await fsp.rename(tmp, file); } catch (e) { fsp.unlink(tmp).catch(() => {}); throw e; }
  }

  /** 队空、手上也没活时 resolve（测试用） */
  function idle() {
    if (!running) return Promise.resolve();
    return new Promise((r) => idleWaiters.push(r));
  }

  /**
   * 盘上这张封面（GET /api/library/cover 用）。没有就空串。
   * @param {{ userRoot: string, src: string, abs: string, st: fs.Stats, w: number }} it
   */
  function cachedFile({ userRoot, src, abs, st, w }) {
    return pngOf(coverKey({ userRoot, src, abs, mtimeMs: st.mtimeMs, size: st.size, w }));
  }

  return { ask, idle, cachedFile, laneOf, stats, queue, timedOut, pngOf, failOf };
}

module.exports = {
  createCoverQueue, coverKindOf, coverKey, coverUrl, coverVersion, coverTarget, isTimeoutError, isTransientError, defaultLagMonitor,
  COVER_WIDTHS, COVER_MAX_ITEMS, LEASE_MS, BUSY_GAP_MS, BUSY_START_GAP_MS, LAG_P95_MS, LAG_PAUSE_MS, HTML_MAX_BYTES, TIMEOUTS,
};
