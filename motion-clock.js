// @ts-check
"use strict";
/**
 * HTML 动画出片（render_motion）的纯逻辑：画幅、帧率、帧时间表、时长推断、ffmpeg 参数、
 * 进度节流、帧去重，以及注进页面的「虚拟时钟」脚本。
 *
 * 为什么要虚拟时钟：逐帧截图比实时慢得多（一帧几十毫秒到几百毫秒），页面若按真实时间跑，
 * 截出来的片子会忽快忽慢、每次都不一样。所以页面里的 performance.now / Date / setTimeout /
 * requestAnimationFrame / Math.random 全换成我们掌控的一份：驱动方每截一帧前调一次
 * __owb_step(t)，页面就「恰好」走到 t 毫秒；同一个 HTML、同一个 seed 渲两次，逐帧一样。
 *
 * 这个文件模块层不碰 Electron、不碰 DOM：pageRuntime 只在页面里（或测试的 vm 沙盒里）执行，
 * 靠 Function.prototype.toString 序列化成源码注进去，所以它不能引用本文件别的变量——
 * 唯一的例外 mulberry32 由 runtimeSource 一起拼进去。要改 pageRuntime，先跑 test/motion.js，
 * 那边是在一个没有这些模块变量的沙盒里跑的，漏引用会当场报错。
 */
const crypto = require("crypto");

/** @typedef {{ width: number, height: number }} Size */
/** @typedef {{ start: number, duration: number }} Clip */
/** @typedef {{ bodyDuration: number|null, clips: Clip[], poster: number|null, scrollW: number, scrollH: number, hasAudio: boolean }} PageMeta */
/** @typedef {{ index: number, start: number, duration: number, frames: number, firstFrame: number }} Segment */
/** @typedef {{ stage: string, done?: number, total?: number, pct?: number, label: string }} ProgressEvent */

// 四种常用画幅；别的比例直接给 width/height。和 drama-pipeline.js 的分镜画幅表是两张表，互不牵动。
const ASPECTS = Object.freeze({
  "9:16": Object.freeze([1080, 1920]),
  "16:9": Object.freeze([1920, 1080]),
  "1:1": Object.freeze([1080, 1080]),
  "3:4": Object.freeze([1080, 1440]),
});
const ASPECT_ERR = "画幅只能是 9:16 / 16:9 / 1:1 / 3:4，或者直接给 width/height";
const SIZE_MIN = 160;
const SIZE_MAX = 3840;
// 下限 12：一帧的时间步不超过 84ms，远低于 GSAP lagSmoothing 的 500ms 门槛，否则 GSAP 会把大步长当卡顿「吞掉」
const FPS_MIN = 12;
const FPS_MAX = 60;
const FPS_DEFAULT = 30;
const DURATION_MIN = 0.5;
const DURATION_MAX = 120;
// 一次调用最多 7200 帧（60fps 两分钟 / 30fps 四分钟）：再长就该拆开渲，免得一个工具调用跑几十分钟
const MAX_FRAMES = 7200;
const STEP_TIMEOUT_MS = 10000;
const READY_CAP_MS = 8000;
const VIDEO_SEEK_CAP_MS = 2000;
const TIMER_FLOOD = 10000;
const FLOOD_MESSAGE = "一帧里排了一万个定时器，页面可能在死循环";
const PROGRESS_MS = 400;
// HyperFrames 的约定：带 data-start/data-duration（秒）的元素只在自己的时间窗里显示
const CLIP_SELECTOR = "[data-start][data-duration]";
// 2026-01-01 00:00:00 UTC。页面里 new Date() 从这一刻起算：固定下来，片子里显示的日期每次一样
const DEFAULT_EPOCH = 1767225600000;
const DEFAULT_BUDGET_MS = 20 * 60 * 1000;
// 无头 Chrome 兜底时追加的参数（cdp.spawnIsolated 已带 --mute-audio/--hide-scrollbars/--headless=new 等）：
// 设备像素比钉成 1，不然 Retina 上截出 2 倍图；后台节流全关，不然隐藏标签页的 rAF 会被降到 1fps
const CHROME_EXTRA_ARGS = Object.freeze([
  "--force-device-scale-factor=1",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
]);

/** 正的有限数，否则 null（0、负数、NaN、空串都当「没给」） */
function positive(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 「16x9」「16：9」「16/9」都认成 16:9 */
function normAspect(a) {
  return String(a == null ? "" : a).trim().replace(/\s+/g, "").replace(/[xX×：/]/g, ":");
}

/** 先夹到 160..3840，再向下取偶数：libx264 的 yuv420p 要求宽高都是偶数 */
function evenClamp(v) {
  const c = Math.min(SIZE_MAX, Math.max(SIZE_MIN, v));
  return Math.floor(c / 2) * 2;
}

/**
 * 出片尺寸。宽高都给了就用宽高（画幅被忽略）；只给一边就按画幅（默认 9:16）推另一边。
 * @param {{ aspect?: string, width?: number|string, height?: number|string }} [o]
 * @returns {Size}
 */
function resolveSize({ aspect, width, height } = {}) {
  const w = positive(width), h = positive(height);
  if (w && h) return { width: evenClamp(w), height: evenClamp(h) };
  const key = normAspect(aspect == null || aspect === "" ? "9:16" : aspect);
  const base = Object.prototype.hasOwnProperty.call(ASPECTS, key) ? ASPECTS[key] : null;
  if (!base) throw new Error(ASPECT_ERR);
  if (w) return { width: evenClamp(w), height: evenClamp((w * base[1]) / base[0]) };
  if (h) return { width: evenClamp((h * base[0]) / base[1]), height: evenClamp(h) };
  return { width: base[0], height: base[1] };
}

/** 帧率取整后夹到 12..60；没给或给了乱七八糟的东西就是 30 */
function clampFps(v) {
  const n = positive(v);
  if (n == null) return FPS_DEFAULT;
  return Math.min(FPS_MAX, Math.max(FPS_MIN, Math.round(n)));
}

/** 一段 duration 秒在 fps 下是几帧 */
function framesFor(duration, fps) {
  const d = Number(duration), f = Number(fps);
  if (!(d > 0) || !(f > 0)) return 0;
  return Math.round(d * f);
}

/**
 * 每帧的时间点（毫秒）。用乘法 i*1000/fps 算，不用累加：累加 7200 次后末尾差到 1e-8 毫秒量级，
 * 碰上「恰好在某帧开始」的定时器/片段边界就会晚一帧。
 * @param {{ fps: number, duration: number }} o
 * @returns {number[]}
 */
function frameTimes({ fps, duration }) {
  const n = framesFor(duration, fps);
  return Array.from({ length: n }, (_, i) => (i * 1000) / fps);
}

/**
 * 一段 HTML 该渲多长（秒）：显式给的 > <body data-duration> > 各片段 start+duration 的最大值 > null。
 * 这里只推断不校验范围，范围交给 checkDuration，报错时才能带上是哪个文件。
 * @param {{ explicit?: number|null, meta?: Partial<PageMeta>|null }} o
 * @returns {number|null}
 */
function durationFrom({ explicit, meta } = {}) {
  const e = positive(explicit);
  if (e != null) return e;
  const b = positive(meta && meta.bodyDuration);
  if (b != null) return b;
  let end = 0;
  for (const c of (meta && Array.isArray(meta.clips) ? meta.clips : [])) {
    const s = Number(c && c.start), d = positive(c && c.duration);
    if (Number.isFinite(s) && s >= 0 && d != null) end = Math.max(end, s + d);
  }
  return end > 0 ? end : null;
}

/**
 * 时长在 0.5..120 秒里就原样返回，否则抛一句人话。name 是给用户看的「哪一段」，比如文件名。
 * @param {number|null|undefined} sec
 * @param {string} [name]
 */
function checkDuration(sec, name) {
  const who = name ? `${name} ` : "";
  if (sec == null || !Number.isFinite(Number(sec)) || Number(sec) <= 0) {
    throw new Error(`${who}不知道要渲多长：传 duration/durations，或者在 <body data-duration="秒数"> 里写上`);
  }
  const n = Number(sec);
  if (n < DURATION_MIN || n > DURATION_MAX) {
    throw new Error(`${who}时长 ${n} 秒超出范围：每段只能 ${DURATION_MIN}–${DURATION_MAX} 秒`);
  }
  return n;
}

/**
 * 多段拼成一条片子的帧预算。每段的时钟各自从 0 开始，segments 给出每段在成片里的起点，
 * start/duration 按实际帧数折回秒（不是按请求的秒数），下游对时间轴时和画面严丝合缝。
 * @param {number[]} durations 每段秒数（已校验过）
 * @param {number} fps
 * @returns {{ segments: Segment[], totalFrames: number, duration: number }}
 */
function planShots(durations, fps) {
  let first = 0;
  const segments = (durations || []).map((d, index) => {
    const frames = framesFor(d, fps);
    const seg = { index, start: first / fps, duration: frames / fps, frames, firstFrame: first };
    first += frames;
    return seg;
  });
  if (first > MAX_FRAMES) {
    throw new Error(`一共 ${first} 帧，超过单次上限 ${MAX_FRAMES} 帧：拆成几次渲，或者把 fps 调低`);
  }
  return { segments, totalFrames: first, duration: first / fps };
}

/**
 * 确定性伪随机（mulberry32）。页面里的 Math.random 换成它，同一个 seed 每次同一串数。
 * 注意：这个函数会被 toString 拼进页面脚本，函数体里不许引用任何外部变量。
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * ffmpeg 编码参数，帧从 stdin 灌进去。
 * - bgra：Electron capturePage().toBitmap() 的原始像素，最快；
 * - png：无头 Chrome 的 Page.captureScreenshot。
 * 两种都先 scale 到 W×H：PNG 万一是 2 倍图（Retina）也会被缩回来，不会出一条 2 倍尺寸的片子。
 * bt709 四件套一起标上，不然播放器按 bt601 解，颜色整体偏。标签要在滤镜链里用 setparams 打一遍：
 * ffmpeg 8 起编码器以帧上带的色彩属性为准，只写 -color_primaries/-color_trc 输出选项会被帧上的「unknown」盖掉
 * （实测 ffprobe 读出 color_transfer=unknown）；输出选项也留着，老版本 ffmpeg 认它。
 * -an：成片本来就没声音，配乐在合成那步加。
 * @param {{ input?: "bgra"|"png", width: number, height: number, fps: number, out: string, crf?: number }} o
 * @returns {string[]}
 */
function ffmpegArgs({ input = "bgra", width, height, fps, out, crf = 18 }) {
  const W = Math.round(Number(width)), H = Math.round(Number(height)), r = String(fps);
  const head = ["-y", "-hide_banner", "-loglevel", "error"];
  const src = input === "png"
    ? ["-f", "image2pipe", "-framerate", r, "-c:v", "png", "-i", "pipe:0"]
    : ["-f", "rawvideo", "-pixel_format", "bgra", "-video_size", `${W}x${H}`, "-framerate", r, "-i", "pipe:0"];
  return [
    ...head, ...src,
    "-an",
    "-vf", `scale=${W}:${H}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-movflags", "+faststart",
    out,
  ];
}

/** 列编码器的参数：用它的输出判断这份 ffmpeg 带没带 libx264 */
function encoderProbeArgs() {
  return ["-hide_banner", "-encoders"];
}

/**
 * 从 `ffmpeg -encoders` 的输出里挑出编码器名字。
 * @param {string} text
 * @returns {Set<string>}
 */
function parseEncoders(text) {
  const set = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    // 形如「 V....D libx264   libx264 H.264 ...」；表头那几行第二列是「=」，天然被跳过
    const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
    if (m && m[1] !== "=") set.add(m[1]);
  }
  return set;
}

/** 缺 ffmpeg 时的话：说清楚装什么、装好之后 HTML 不用改 */
function noFfmpegMessage(install) {
  return `没装 ffmpeg，出不了视频。装一下：${install || "brew install ffmpeg"}，装好再叫我重渲，HTML 不用改`;
}

/** 有 ffmpeg 但没编进 libx264：不偷偷换别的编码器（画质和兼容性都会变），如实说 */
function noX264Message(install) {
  return `这份 ffmpeg 没带 libx264，出不了 mp4：换成完整版 ffmpeg（${install || "brew install ffmpeg"}）再重渲`;
}

/** 渲染中途写的临时文件：x.mp4 → x.part.mp4，成功后再改名，失败/停止就删，不留半截片子 */
function partPath(out) {
  const s = String(out);
  const m = /^(.*?)(\.[^./\\]+)$/.exec(s);
  return m ? `${m[1]}.part${m[2]}` : `${s}.part`;
}

/**
 * 这次渲染最多能花多久（毫秒），和 tools.js 审批等待同一个算法：留 10 秒收尾，最少 5 秒。
 * 没有截止时间（直接调用）给 20 分钟。
 * @param {number|null|undefined} deadline 绝对时间戳（ms）
 * @param {number} [now]
 */
function budgetMs(deadline, now = Date.now()) {
  const d = Number(deadline);
  return d > 0 ? Math.max(5000, d - now - 10000) : DEFAULT_BUDGET_MS;
}

/**
 * 封面帧落在第几帧：第一个写了 <body data-poster="秒"> 的段，换算到成片里的帧号；都没写就 null。
 * @param {{ segments: Segment[], metas: Array<Partial<PageMeta>|null|undefined>, fps: number }} o
 * @returns {number|null}
 */
function posterFrame({ segments, metas, fps }) {
  for (let i = 0; i < (segments || []).length; i++) {
    const seg = segments[i], m = metas && metas[i];
    const p = m && m.poster;
    if (p == null || !Number.isFinite(Number(p)) || Number(p) < 0 || !(seg.frames > 0)) continue;
    const local = Math.min(seg.frames - 1, Math.max(0, Math.round(Number(p) * fps)));
    return seg.firstFrame + local;
  }
  return null;
}

/**
 * 要落成静帧（给模型 look_at_image 自查）的帧号，第一个是封面。
 * 封面用 data-poster，没有就取 40% 处；多要的依次取 80%、15%，重复的去掉。
 * @param {{ stills?: number, totalFrames: number, poster?: number|null }} o
 * @returns {number[]}
 */
function stillFrames({ stills = 1, totalFrames, poster = null }) {
  const n = Math.max(0, Math.min(3, Math.floor(Number(stills) || 0)));
  const total = Math.floor(Number(totalFrames) || 0);
  if (!n || total <= 0) return [];
  const at = (f) => Math.min(total - 1, Math.max(0, Math.round(f * (total - 1))));
  const cands = [poster != null && Number.isFinite(Number(poster)) ? Math.min(total - 1, Math.max(0, Math.round(Number(poster)))) : at(0.4), at(0.8), at(0.15), at(0.4), at(0.6)];
  const out = [];
  for (const c of cands) {
    if (out.length >= n) break;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * 一帧画面的指纹，用来数「一共有几种不同的帧」。小于 1MB 整块算；大图（1080×1920 的 BGRA 有 8MB）
 * 在整幅画面上均匀抽 samples 个像素再算：按比例取下标而不是固定步长，末尾那一截也抽得到。
 * 长度也算进去，尺寸不同的帧不会撞成同一个指纹。
 * @param {Uint8Array} buf
 * @param {{ samples?: number }} [o]
 */
function frameHash(buf, { samples = 1 << 18 } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const h = crypto.createHash("sha1");
  h.update(`${b.length}:`);
  const s = Math.max(1, Math.floor(samples));
  if (b.length <= s * 4) return h.update(b).digest("hex");
  const px = Math.floor(b.length / 4);
  const out = Buffer.allocUnsafe(s * 4);
  for (let j = 0; j < s; j++) {
    const o = Math.floor((j * px) / s) * 4, w = j * 4;
    out[w] = b[o]; out[w + 1] = b[o + 1]; out[w + 2] = b[o + 2]; out[w + 3] = b[o + 3];
  }
  return h.update(out).digest("hex");
}

/**
 * 逐帧喂进来，数不同的帧有几种。只有 1 种说明页面根本没动（时钟没接上、动画写错了）。
 * @param {{ samples?: number }} [opts]
 */
function createFrameStats(opts) {
  const seen = new Set();
  let frames = 0;
  return {
    /** @param {Uint8Array} buf */
    add(buf) {
      const hash = frameHash(buf, opts);
      frames++;
      const isNew = !seen.has(hash);
      if (isNew) seen.add(hash);
      return { hash, isNew };
    },
    count: () => seen.size,
    frames: () => frames,
  };
}

/**
 * 渲完后的自查提醒（不算错，放进结果的 warnings 让模型如实转告）：
 * 画面没动、页面比画幅大被裁、页面里有声音但成片无声、页面脚本报错（前 3 条）、运行时的其他提醒。
 * @param {{ frames: number, distinct: number, width: number, height: number,
 *   shots?: Array<{ name?: string, meta?: Partial<PageMeta>|null, errors?: string[], warnings?: string[] }> }} o
 * @returns {string[]}
 */
function motionWarnings({ frames, distinct, width, height, shots = [] }) {
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  if (distinct === 1 && frames > 1) push("所有帧一模一样：页面没动起来");
  const multi = shots.length > 1;
  const nameOf = (s, i) => (s && s.name) || `第 ${i + 1} 段`;
  // 留 1px：亚像素排版偶尔让 scrollWidth 比视口多 1，那不是真溢出
  const over = shots.map((s, i) => ({ s, i })).filter(({ s }) => {
    const m = s && s.meta;
    return m && (Number(m.scrollW) > width + 1 || Number(m.scrollH) > height + 1);
  }).map(({ s, i }) => nameOf(s, i));
  if (over.length) {
    const who = over.length > 3 ? `${over.slice(0, 3).join("、")} 等 ${over.length} 段` : over.join("、");
    push(`页面比画幅大会被裁：body 改成 100vw×100vh 才能换画幅重渲${multi ? `（${who}）` : ""}`);
  }
  if (shots.some((s) => s && s.meta && s.meta.hasAudio)) push("成片没有声音，配乐/配音在合成那步加");
  let errs = 0;
  shots.forEach((s, i) => {
    for (const e of (s && s.errors) || []) {
      if (errs >= 3) return;
      const line = `页面报错：${String(e).slice(0, 120)}${multi ? `（${nameOf(s, i)}）` : ""}`;
      if (!out.includes(line)) { out.push(line); errs++; }
    }
  });
  shots.forEach((s) => { for (const w of (s && s.warnings) || []) push(String(w).slice(0, 160)); });
  return out;
}

/** 终端/IM 显示宽度：中日韩和全角字符算 2 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0) || 0;
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 超过 max 显示宽度就截断加「…」：进度标签约定不超过 24 个汉字宽 */
function fitLabel(s, max = 48) {
  const str = String(s);
  if (displayWidth(str) <= max) return str;
  let out = "";
  for (const ch of str) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + "…";
}

/** 剩余秒数说成人话；不到 1 秒就不说 */
function etaText(sec) {
  if (!(sec >= 1) || !Number.isFinite(sec)) return "";
  return sec < 60 ? `约剩 ${Math.ceil(sec)} 秒` : `约剩 ${Math.ceil(sec / 60)} 分钟`;
}

/**
 * 进度标签（contracts A：中文、≤24 个汉字宽）。
 * - load：「载入第 2/3 段」；只有一段时「载入页面」
 * - render：「渲染帧 432/900」，多段时加「· 第 2/3 段」，知道速度时加「· 约剩 N 秒」
 * - encode：「编码 42%」，没有百分比时「编码收尾」
 * @param {{ stage: string, done?: number, total?: number, pct?: number, shot?: number, shots?: number, speed?: number }} p
 */
function progressLabel({ stage, done, total, pct, shot, shots, speed }) {
  let s;
  if (stage === "load") {
    s = shots > 1 ? `载入第 ${shot}/${shots} 段` : "载入页面";
  } else if (stage === "render") {
    s = `渲染帧 ${done}/${total}`;
    if (shots > 1) s += ` · 第 ${shot}/${shots} 段`;
    const eta = speed > 0 && total > done ? etaText((total - done) / speed) : "";
    if (eta) s += ` · ${eta}`;
  } else if (stage === "encode") {
    s = pct != null && Number.isFinite(Number(pct)) ? `编码 ${Math.round(Number(pct))}%` : "编码收尾";
  } else {
    s = total > 0 ? `${stage} ${done}/${total}` : String(stage);
  }
  return fitLabel(s);
}

/**
 * 拼一条 contracts A 形状的进度事件：{stage, done, total, pct, label}。
 * @param {{ stage: string, done?: number, total?: number, pct?: number, shot?: number, shots?: number, speed?: number }} p
 * @returns {ProgressEvent}
 */
function progressEvent(p) {
  /** @type {ProgressEvent} */
  const ev = { stage: p.stage, label: progressLabel(p) };
  if (p.total > 0) {
    ev.done = Math.max(0, Math.min(p.total, Math.floor(Number(p.done) || 0)));
    ev.total = Math.floor(p.total);
    ev.pct = Math.floor((ev.done * 100) / ev.total);
  } else if (p.pct != null && Number.isFinite(Number(p.pct))) {
    ev.pct = Math.max(0, Math.min(100, Math.round(Number(p.pct))));
  }
  return ev;
}

/**
 * 进度节流：400ms 内最多报一次，但「最后一条」（done===total、pct===100，或 final:true）一定报。
 * 回调抛错一律吞掉：进度显示坏了不能把渲染拖垮。返回这次有没有真的发出去。
 * @param {((p: ProgressEvent) => void)|null|undefined} onProgress
 * @param {{ intervalMs?: number, now?: () => number }} [o]
 */
function progressThrottle(onProgress, { intervalMs = PROGRESS_MS, now = Date.now } = {}) {
  let last = -Infinity;
  /**
   * @param {ProgressEvent} p
   * @param {{ final?: boolean }} [f]
   */
  return function emit(p, { final = false } = {}) {
    if (typeof onProgress !== "function" || !p) return false;
    const isFinal = final || (p.total > 0 && p.done >= p.total) || p.pct === 100;
    const t = now();
    if (!isFinal && t - last < intervalMs) return false;
    last = t;
    try { onProgress(p); } catch { /* 进度回调出错不影响出片 */ }
    return true;
  };
}

/** 驱动方每帧执行的那句表达式；JSON 数字能原样还原 33.333333333333336 这类小数 */
function stepExpr(t) {
  return `__owb_step(${JSON.stringify(Number(t))})`;
}

/** 单帧看门狗的报错：第几帧（从 1 数）卡了多久 */
function stallMessage(i, ms = STEP_TIMEOUT_MS) {
  return `第 ${i + 1} 帧卡了 ${Math.round(ms / 1000)} 秒没画完：页面脚本可能在死循环`;
}

/**
 * 页面里的虚拟时钟。只在页面里执行（Page.addScriptToEvaluateOnNewDocument，文档里任何脚本之前），
 * 装好后页面上多出三个函数：
 * - __owb_ready(capMs?) → Promise<{ok, pending}>：用真实时间等字体、图片、视频加载完，最多 capMs
 * - __owb_meta() → PageMeta
 * - __owb_step(tMs) → Promise<{errors, warnings}>：把页面推进到 t 毫秒，等真实画面画出来再返回
 * 页面可以自己提供 __owb_seek(秒)，每帧会调一次（可选的逃生口，GSAP/Lottie/Three.js 用不着）。
 * 浏览器全局只经 globalThis 取：后端 tsconfig 没有 DOM 库，直接写 document 过不了类型检查。
 * @param {{ seed?: number, epoch?: number, flood?: number, seekCapMs?: number, readyCapMs?: number, clip?: string }} cfg
 */
function pageRuntime(cfg) {
  const G = /** @type {any} */ (globalThis);
  // 只接管顶层页面：iframe 里另起一个时钟对不齐，干脆让它走真实时间
  try { if (G.top && G.top !== G) return; } catch { return; }
  if (typeof G.__owb_step === "function") return;

  const epoch = Number(cfg.epoch) || 0;
  const FLOOD = cfg.flood > 0 ? cfg.flood : 10000;
  const SEEK_CAP = cfg.seekCapMs > 0 ? cfg.seekCapMs : 2000;
  const READY_CAP = cfg.readyCapMs > 0 ? cfg.readyCapMs : 8000;
  const CLIP = cfg.clip || "[data-start][data-duration]";
  // 浮点容差：1000/30 累加三次是 100.00000000000001，没有它那一下会晚一帧
  const EPS = 1e-4;

  const RealDate = G.Date;
  const realST = G.setTimeout.bind(G);
  const realCT = G.clearTimeout.bind(G);
  const realRaf = typeof G.requestAnimationFrame === "function"
    ? G.requestAnimationFrame.bind(G)
    : (fn) => realST(() => fn(0), 16);
  const MC = G.MessageChannel;

  let vt = 0;
  let busy = false;
  let audioUsed = false;
  const errors = [], warnings = [], seenNotes = new Set();
  let noteCount = 0;
  function note(list, msg) {
    const m = String(msg == null ? "" : msg).slice(0, 200);
    if (!m || seenNotes.has(m) || noteCount >= 50) return;
    seenNotes.add(m);
    noteCount++;
    list.push(m);
  }
  function noteErr(e) {
    note(errors, e && e.message ? e.message : String(e));
  }
  function put(obj, key, val) {
    try { obj[key] = val; } catch { /* 只读就走 defineProperty */ }
    if (obj[key] !== val) {
      try { Object.defineProperty(obj, key, { value: val, configurable: true, writable: true }); } catch { /* 实在改不了就算了 */ }
    }
  }
  function short(src) {
    const s = String(src || "");
    if (s.startsWith("data:")) return "内嵌数据";
    return s.split(/[?#]/)[0].split("/").pop().slice(-60) || s.slice(-60);
  }
  function qsa(sel) {
    const d = G.document;
    try { return d && d.querySelectorAll ? Array.from(d.querySelectorAll(sel)) : []; } catch { return []; }
  }
  // 让回调里触发的 Promise 后续（await sleep(500) 之后那几行）在同一个虚拟时刻跑完：
  // 真实的一个宏任务能把微任务队列清空，MessageChannel 没有 setTimeout 的 4ms 嵌套钳制
  let drainPort = null, drainWaiters = [];
  function drain() {
    if (typeof MC !== "function") return Promise.resolve().then(() => undefined).then(() => undefined);
    if (!drainPort) {
      const ch = new MC();
      ch.port1.onmessage = () => { const w = drainWaiters; drainWaiters = []; w.forEach((r) => r()); };
      drainPort = ch.port2;
    }
    return new Promise((r) => { drainWaiters.push(r); drainPort.postMessage(0); });
  }
  const realSleep = (ms) => new Promise((r) => realST(r, Math.max(0, ms)));

  // ---- 时间：performance.now / Date ----
  if (G.performance) put(G.performance, "now", () => vt);
  function FakeDate(...args) {
    if (!new.target) return new RealDate(epoch + vt).toString();
    return Reflect.construct(RealDate, args.length ? args : [epoch + vt], new.target);
  }
  /** @type {any} */ (FakeDate).prototype = RealDate.prototype;
  /** @type {any} */ (FakeDate).now = () => epoch + vt;
  /** @type {any} */ (FakeDate).UTC = RealDate.UTC;
  /** @type {any} */ (FakeDate).parse = RealDate.parse;
  try { Object.defineProperty(RealDate.prototype, "constructor", { value: FakeDate, configurable: true, writable: true }); } catch { /* 无所谓 */ }
  put(G, "Date", FakeDate);

  // ---- 随机数 ----
  if (G.Math) put(G.Math, "random", mulberry32(cfg.seed >>> 0));

  // ---- 定时器：按 (到期时间, 登记顺序) 排的小顶堆 ----
  const heap = [];
  const live = new Map();
  let seq = 0, nextId = 0, nest = 0;
  const less = (a, b) => a.due < b.due || (a.due === b.due && a.seq < b.seq);
  function hpush(rec) {
    heap.push(rec);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  }
  function hpop() {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  }
  // HTML 规范：嵌套超过 5 层、延时不足 4ms 的按 4ms 算。照做才能让 setTimeout(f,0) 自己调自己的页面往前走，而不是原地死循环
  const clampDelay = (d, level) => (level > 5 && d < 4 ? 4 : d);
  function schedule(fn, delay, args, repeat) {
    const id = ++nextId;
    if (typeof fn !== "function") {
      note(warnings, "setTimeout/setInterval 传的是字符串代码，没执行：改成传函数");
      return id;
    }
    let d = Number(delay);
    if (!(d >= 0)) d = 0;
    // 浏览器里超过 2^31-1 的延时会溢出成立刻执行，照搬
    if (d > 2147483647) d = 0;
    // 规范是拿「当前任务」的嵌套层数判断要不要夹到 4ms，新定时器的层数再 +1
    const rec = { id, fn, args, every: repeat ? d : -1, due: vt + clampDelay(d, nest), seq: ++seq, nest: nest + 1, dead: false };
    live.set(id, rec);
    hpush(rec);
    return id;
  }
  function clearTimer(id) {
    const rec = live.get(id);
    if (rec) { rec.dead = true; live.delete(id); }
  }
  put(G, "setTimeout", (fn, delay, ...args) => schedule(fn, delay, args, false));
  put(G, "setInterval", (fn, delay, ...args) => schedule(fn, delay, args, true));
  put(G, "clearTimeout", clearTimer);
  put(G, "clearInterval", clearTimer);
  put(G, "requestIdleCallback", (fn) => schedule(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 1, [], false));
  put(G, "cancelIdleCallback", clearTimer);

  // ---- requestAnimationFrame：每步统一回放一次 ----
  const rafQ = new Map();
  let rafSeq = 0;
  const raf = (fn) => { const id = ++rafSeq; if (typeof fn === "function") rafQ.set(id, fn); return id; };
  const caf = (id) => { rafQ.delete(id); };
  put(G, "requestAnimationFrame", raf);
  put(G, "cancelAnimationFrame", caf);
  if ("webkitRequestAnimationFrame" in G) { put(G, "webkitRequestAnimationFrame", raf); put(G, "webkitCancelAnimationFrame", caf); }

  // ---- 声音：出片是无声的，记下页面用过声音，好提醒；系统朗读直接拦掉，不然会从音箱里念出来 ----
  for (const k of ["Audio", "AudioContext", "webkitAudioContext"]) {
    const Real = G[k];
    if (typeof Real !== "function") continue;
    const Wrapped = function (...args) {
      audioUsed = true;
      try { return Reflect.construct(Real, args, new.target || Real); } catch { return new Real(...args); }
    };
    Wrapped.prototype = Real.prototype;
    put(G, k, Wrapped);
  }
  if (G.speechSynthesis && typeof G.speechSynthesis.speak === "function") {
    put(G.speechSynthesis, "speak", (u) => {
      audioUsed = true;
      // 假装念完了：页面若在等 onend 才往下走，不至于卡住
      schedule(() => { try { u && u.dispatchEvent && u.dispatchEvent(new G.Event("end")); } catch { /* 不支持就算了 */ } }, 0, [], false);
    });
  }

  // ---- 离屏窗口常被当成「后台标签页」：有的页面据此暂停动画，一律报前台 ----
  try {
    const d = G.document;
    if (d) {
      Object.defineProperty(d, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(d, "visibilityState", { configurable: true, get: () => "visible" });
    }
  } catch { /* 改不了就算了 */ }

  // ---- 动画：每个动画记住它是哪个虚拟时刻出生的，之后每帧按「t - 出生时刻」摆到位 ----
  // 3 秒时靠加 class 才开始的动画，出生时刻就是 3 秒；统一设成 t 的话它一出生就跳到结尾
  const born = new WeakMap();
  const finished = new WeakSet();
  const held = new WeakSet();
  const rates = new WeakMap();
  const AP = G.Animation && G.Animation.prototype;
  const origPause = AP && AP.pause, origPlay = AP && AP.play, origFinish = AP && AP.finish;
  const ctDesc = AP ? Object.getOwnPropertyDescriptor(AP, "currentTime") : null;
  const call = (orig, a, name) => (orig || a[name]).call(a);
  const setCT = (a, v) => { if (ctDesc && ctDesc.set) ctDesc.set.call(a, v); else a.currentTime = v; };
  const getCT = (a) => Number(ctDesc && ctDesc.get ? ctDesc.get.call(a) : a.currentTime) || 0;
  function endOf(a) {
    try {
      const e = Number(a.effect.getComputedTiming().endTime);
      return e >= 0 ? e : Infinity;
    } catch { return Infinity; }
  }
  const rateOf = (a) => (typeof a.playbackRate === "number" && Number.isFinite(a.playbackRate) ? a.playbackRate : 1);
  // 页面自己改了进度（play/currentTime/倒放）：按它现在的位置反推出生时刻，之后接着走
  function rebase(a) {
    const r = rateOf(a);
    if (!r) return;
    const ct = getCT(a);
    born.set(a, r > 0 ? vt - ct / r : vt - (ct - endOf(a)) / r);
  }
  function adopt(at) {
    for (const a of anims()) if (!born.has(a)) born.set(a, at);
  }
  // 「animation-play-state: paused，等加上某个 class 再动」这种写法：暂停期间位置不动，
  // 每次放回调之前把出生时刻挪到当下，回调里一解除暂停，就从这一刻接着走，不会一解除就跳到结尾
  const cssHeld = new Map();
  function cssPaused(a) {
    if (typeof a.animationName !== "string" || typeof G.getComputedStyle !== "function") return false;
    const tg = a.effect && a.effect.target;
    if (!tg) return false;
    try {
      const cs = G.getComputedStyle(tg, a.effect.pseudoElement || null);
      const names = String(cs.animationName || "").split(",").map((s) => s.trim());
      const states = String(cs.animationPlayState || "").split(",").map((s) => s.trim());
      const i = names.indexOf(a.animationName);
      // CSS 的列表长度不齐时循环复用，照规范取模
      return i >= 0 && states.length > 0 && states[i % states.length] === "paused";
    } catch { return false; }
  }
  function anchor(a, at, p) {
    const r = rateOf(a) || 1;
    born.set(a, r > 0 ? at - p / r : at - (p - endOf(a)) / r);
  }
  function anchorHolds(at) {
    for (const [a, p] of cssHeld) anchor(a, at, p);
  }
  function releaseHolds() {
    for (const a of Array.from(cssHeld.keys())) if (!cssPaused(a)) cssHeld.delete(a);
  }
  function anims() {
    const d = G.document;
    try { return d && typeof d.getAnimations === "function" ? d.getAnimations() : []; } catch { return []; }
  }
  if (AP) {
    if (origPause) {
      AP.pause = function (...args) {
        // 页面在某个虚拟时刻暂停：先摆到那一刻，再记成「页面自己按住的」，之后不再推它
        if (born.has(this) && !finished.has(this) && !held.has(this)) {
          const r = rateOf(this), local = vt - born.get(this);
          const pos = r > 0 ? local * r : endOf(this) + local * r;
          if (Number.isFinite(pos)) { try { setCT(this, Math.max(0, pos)); } catch { /* 摆不了就算了 */ } }
        }
        held.add(this);
        return origPause.apply(this, args);
      };
    }
    if (origPlay) {
      AP.play = function (...args) {
        const r = origPlay.apply(this, args);
        held.delete(this);
        finished.delete(this);
        if (born.has(this)) rebase(this);
        return r;
      };
    }
    if (origFinish) {
      AP.finish = function (...args) {
        finished.add(this);
        held.delete(this);
        return origFinish.apply(this, args);
      };
    }
    if (ctDesc && ctDesc.set && ctDesc.configurable) {
      Object.defineProperty(AP, "currentTime", {
        configurable: true, enumerable: ctDesc.enumerable,
        get: ctDesc.get,
        set(v) {
          ctDesc.set.call(this, v);
          if (born.has(this)) { finished.delete(this); rebase(this); }
        },
      });
    }
  }

  // ---- 片段显隐 + 页面级样式 ----
  let styleEl = null;
  function ensureStyle() {
    const d = G.document;
    if (!d || typeof d.createElement !== "function") return;
    if (styleEl && styleEl.isConnected !== false) return;
    const parent = d.head || d.documentElement;
    if (!parent) return;
    styleEl = d.createElement("style");
    styleEl.setAttribute("data-owb-clock", "");
    // 滚动条藏掉：溢出的页面照样会提醒，但不在画面边上多出一条灰杠
    styleEl.textContent = "[data-owb-off]{display:none!important}::-webkit-scrollbar{display:none!important}";
    parent.appendChild(styleEl);
  }
  if (G.document && typeof G.document.addEventListener === "function") {
    G.document.addEventListener("DOMContentLoaded", ensureStyle);
  }
  ensureStyle();

  function attrNum(el, k) {
    if (!el || typeof el.getAttribute !== "function") return null;
    const v = el.getAttribute(k);
    if (v == null || v === "") return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  function toggleClips(t) {
    const shown = [];
    for (const el of qsa(CLIP)) {
      const s = attrNum(el, "data-start"), du = attrNum(el, "data-duration");
      if (s == null || du == null) continue;
      const startMs = s * 1000, endMs = (s + du) * 1000;
      const on = t + EPS >= startMs && t < endMs - EPS;
      const off = el.hasAttribute("data-owb-off");
      if (on && off) { el.removeAttribute("data-owb-off"); shown.push({ el, startMs }); }
      else if (!on && !off) el.setAttribute("data-owb-off", "");
    }
    if (!shown.length) return;
    // 片段刚露面时才生成的 CSS 动画，出生时刻记成片段的起点而不是这一帧：起点不在帧上时也不会晚半帧
    for (const a of anims()) {
      if (born.has(a)) continue;
      const tg = a.effect && a.effect.target;
      if (!tg) continue;
      let at = null;
      for (const c of shown) if ((c.el === tg || (c.el.contains && c.el.contains(tg))) && (at == null || c.startMs > at)) at = c.startMs;
      if (at != null) born.set(a, at);
    }
  }

  function driveAnimations(t) {
    const list = anims();
    const present = new Set(list);
    for (const a of Array.from(cssHeld.keys())) if (!present.has(a)) cssHeld.delete(a);
    for (const a of list) {
      if (!born.has(a)) born.set(a, t);
      if (!a.effect || held.has(a)) continue;
      const r = rateOf(a);
      if (rates.has(a) && rates.get(a) !== r) rebase(a);
      rates.set(a, r);
      if (!r) continue;
      if (!cssHeld.has(a) && !finished.has(a) && cssPaused(a)) {
        const local = t - born.get(a);
        const p = r > 0 ? local * r : endOf(a) + local * r;
        cssHeld.set(a, Number.isFinite(p) ? Math.max(0, p) : 0);
      }
      if (cssHeld.has(a)) {
        anchor(a, t, cssHeld.get(a));
        try {
          if (a.playState !== "paused") call(origPause, a, "pause");
          setCT(a, cssHeld.get(a));
        } catch (e) { noteErr(e); }
        continue;
      }
      if (finished.has(a)) {
        if (a.playState === "finished") continue;
        // 放完又被重新播起来了（比如 animation-name 被换回来）：从它现在的位置接着算
        finished.delete(a);
        rebase(a);
      }
      const end = endOf(a);
      if (r < 0 && end === Infinity) continue; // 无限长还倒着放：找不到起点，交给它自己
      const local = t - born.get(a);
      const pos = r > 0 ? local * r : end + local * r;
      const done = r > 0 ? end !== Infinity && pos >= end - EPS : pos <= EPS;
      if (done) {
        // 放完的有限动画 finish() 一次：.finished 和 animationend 才会触发，靠它们串下一步的页面不会卡住
        finished.add(a);
        try { call(origFinish, a, "finish"); } catch (e) { noteErr(e); }
        continue;
      }
      try {
        if (a.playState !== "paused") call(origPause, a, "pause");
        setCT(a, Math.max(0, pos));
      } catch (e) { noteErr(e); }
    }
  }

  function seekVideo(v, want) {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        if (timer != null) { realCT(timer); timer = null; }
        v.removeEventListener("seeked", done);
        resolve(undefined);
      };
      v.addEventListener("seeked", done);
      timer = realST(() => {
        timer = null;
        v.removeEventListener("seeked", done);
        note(warnings, `视频 ${SEEK_CAP / 1000} 秒内没跳到位：${short(v.currentSrc || v.src)}，这几帧的画面可能不对`);
        resolve(undefined);
      }, SEEK_CAP);
      try { v.currentTime = want; } catch { done(); }
    });
  }
  async function seekVideos(t) {
    for (const v of qsa("video")) {
      try {
        if (v.closest && v.closest("[data-owb-off]")) continue;
        if (!v.paused && typeof v.pause === "function") v.pause();
        const clip = v.closest ? v.closest(CLIP) : null;
        const base = clip ? attrNum(clip, "data-start") || 0 : 0;
        let want = Math.max(0, t / 1000 - base);
        const dur = Number(v.duration);
        if (dur > 0 && Number.isFinite(dur)) want = v.loop ? want % dur : Math.min(want, dur);
        if (!(v.readyState >= 1)) { note(warnings, `视频还没加载出来：${short(v.currentSrc || v.src)}`); continue; }
        if (Math.abs((Number(v.currentTime) || 0) - want) < 1e-3) continue;
        await seekVideo(v, want);
      } catch (e) { noteErr(e); }
    }
  }

  if (typeof G.addEventListener === "function") {
    G.addEventListener("error", (e) => {
      const tg = e && e.target;
      // 捕获阶段也能收到图片/视频加载失败（它们不冒泡），和脚本报错分开说
      if (tg && tg !== G && tg.tagName) {
        note(warnings, `${String(tg.tagName).toLowerCase()} 没加载出来：${short(tg.currentSrc || tg.src || tg.href)}`);
        return;
      }
      noteErr(e && (e.error || e.message));
    }, true);
    G.addEventListener("unhandledrejection", (e) => noteErr(e && e.reason));
  }

  G.__owb_meta = function () {
    ensureStyle();
    const d = G.document || {}, b = d.body, de = d.documentElement;
    const pos = (n) => (n != null && n > 0 ? n : null);
    const clips = [];
    for (const el of qsa(CLIP)) {
      const s = attrNum(el, "data-start"), du = attrNum(el, "data-duration");
      if (s != null && s >= 0 && du != null && du > 0) clips.push({ start: s, duration: du });
    }
    const poster = attrNum(b, "data-poster");
    const hasAudio = audioUsed || qsa("audio").length > 0 || qsa("video").some((v) => !v.muted && !v.hasAttribute("muted"));
    return {
      bodyDuration: pos(attrNum(b, "data-duration")) ?? pos(attrNum(de, "data-duration")),
      clips,
      poster: poster != null && poster >= 0 ? poster : null,
      scrollW: Math.max(Number(de && de.scrollWidth) || 0, Number(b && b.scrollWidth) || 0),
      scrollH: Math.max(Number(de && de.scrollHeight) || 0, Number(b && b.scrollHeight) || 0),
      hasAudio: !!hasAudio,
    };
  };

  G.__owb_ready = async function (capMs) {
    ensureStyle();
    const cap = Number(capMs) > 0 ? Number(capMs) : READY_CAP;
    const t0 = RealDate.now();
    const left = () => Math.max(0, cap - (RealDate.now() - t0));
    const d = G.document;
    if (!d) return { ok: true, pending: 0 };
    // 懒加载的图不在视口里就永远不加载，白等 8 秒；preload=none 的视频同理
    for (const img of qsa("img")) { try { if (img.loading === "lazy") img.loading = "eager"; } catch { /* 忽略 */ } }
    for (const v of qsa("video")) {
      try { if (v.preload === "none") { v.preload = "auto"; if (typeof v.load === "function") v.load(); } } catch { /* 忽略 */ }
    }
    while (d.readyState && d.readyState !== "complete" && left() > 0) await realSleep(Math.min(20, left()));
    if (d.fonts && d.fonts.ready) await Promise.race([Promise.resolve(d.fonts.ready).catch(() => undefined), realSleep(left())]);
    const pending = () => qsa("img").filter((i) => !i.complete).length +
      qsa("video").filter((v) => !(v.readyState >= 2) && !v.error && (v.currentSrc || v.src)).length;
    while (pending() && left() > 0) await realSleep(Math.min(50, left()));
    const n = pending();
    if (n) note(warnings, `${n} 个图片/视频 ${Math.round(cap / 1000)} 秒内没加载完，画面里可能缺图`);
    return { ok: n === 0, pending: n };
  };

  G.__owb_step = async function (t) {
    t = Number(t);
    if (!Number.isFinite(t) || t < 0) throw new Error(`帧时间不对：${t}`);
    if (t < vt - EPS) throw new Error(`时间只能往前走：现在 ${vt}ms，要求回到 ${t}ms`);
    if (busy) throw new Error("上一帧还没画完就要下一帧了");
    busy = true;
    try {
      ensureStyle();
      // 1. 到期的定时器按 (到期时间, 登记顺序) 一个个放，放之前把时钟拨到它的到期时刻
      let fired = 0;
      while (heap.length && heap[0].due <= t + EPS) {
        const rec = hpop();
        if (rec.dead) continue;
        if (++fired > FLOOD) throw new Error("一帧里排了一万个定时器，页面可能在死循环");
        vt = Math.max(vt, Math.min(rec.due, t));
        if (rec.every < 0) live.delete(rec.id);
        nest = rec.nest;
        anchorHolds(vt);
        try { rec.fn.apply(G, rec.args); } catch (e) { noteErr(e); }
        // 规范里 setInterval 是回调跑完再排下一次；回调里 clearInterval 了就不再排
        if (rec.every >= 0 && !rec.dead) {
          rec.due += clampDelay(rec.every, rec.nest);
          rec.nest++;
          rec.seq = ++seq;
          hpush(rec);
        }
        await drain();
        nest = 0;
        releaseHolds();
        adopt(vt);
      }
      // 2. 时钟拨到 t，rAF 回调一批放完；回调里新登记的留到下一帧（和浏览器一样）
      vt = Math.max(vt, t);
      anchorHolds(t);
      const ids = Array.from(rafQ.keys());
      for (const id of ids) {
        const fn = rafQ.get(id);
        if (!fn) continue;
        rafQ.delete(id);
        try { fn.call(G, t); } catch (e) { noteErr(e); }
      }
      if (ids.length) await drain();
      releaseHolds();
      adopt(t);
      // 3. 片段显隐
      toggleClips(t);
      adopt(t);
      // 4. 页面自带的跳转钩子（可选）
      if (typeof G.__owb_seek === "function") {
        try { await G.__owb_seek(t / 1000); } catch (e) { note(errors, `__owb_seek 出错：${e && e.message ? e.message : e}`); }
        adopt(t);
      }
      // 5. 所有 CSS/WAAPI 动画摆到位
      driveAnimations(t);
      // 6. 视频跳到对应时刻
      await seekVideos(t);
      // 7. 等真实的两帧：保证截图拿到的是这一步画出来的画面，不是上一帧的残影
      await new Promise((r) => realRaf(() => realRaf(() => r(undefined))));
      return { errors: errors.splice(0), warnings: warnings.splice(0) };
    } finally {
      busy = false;
    }
  };
}

/**
 * 拼成注进页面的完整脚本。seed/epoch 归一化后和其余常量一起写进去；
 * seekCapMs/readyCapMs 只给测试缩短等待用，正常调用别传。
 * @param {{ seed?: number, epoch?: number, seekCapMs?: number, readyCapMs?: number }} [cfg]
 */
function runtimeSource(cfg = {}) {
  const s = Number(cfg.seed);
  const e = Number(cfg.epoch);
  const c = {
    seed: Number.isFinite(s) ? Math.floor(s) >>> 0 : 1,
    epoch: Number.isFinite(e) && e > 0 ? Math.floor(e) : DEFAULT_EPOCH,
    flood: TIMER_FLOOD,
    seekCapMs: positive(cfg.seekCapMs) || VIDEO_SEEK_CAP_MS,
    readyCapMs: positive(cfg.readyCapMs) || READY_CAP_MS,
    clip: CLIP_SELECTOR,
  };
  return `;(function () {\n"use strict";\nvar mulberry32 = ${mulberry32};\n(${pageRuntime})(${JSON.stringify(c)});\n})();\n`;
}

module.exports = {
  ASPECTS, ASPECT_ERR, SIZE_MIN, SIZE_MAX,
  FPS_MIN, FPS_MAX, FPS_DEFAULT,
  DURATION_MIN, DURATION_MAX, MAX_FRAMES,
  STEP_TIMEOUT_MS, READY_CAP_MS, VIDEO_SEEK_CAP_MS,
  TIMER_FLOOD, FLOOD_MESSAGE, PROGRESS_MS,
  CLIP_SELECTOR, DEFAULT_EPOCH, DEFAULT_BUDGET_MS, CHROME_EXTRA_ARGS,
  resolveSize, clampFps, framesFor, frameTimes, durationFrom, checkDuration, planShots,
  mulberry32, ffmpegArgs, encoderProbeArgs, parseEncoders, noFfmpegMessage, noX264Message,
  partPath, budgetMs, posterFrame, stillFrames,
  frameHash, createFrameStats, motionWarnings,
  displayWidth, fitLabel, progressLabel, progressEvent, progressThrottle,
  stepExpr, stallMessage,
  pageRuntime, runtimeSource,
};
