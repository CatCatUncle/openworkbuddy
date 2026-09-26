// @ts-check
"use strict";
/**
 * 时间轴成片：把一份 timeline.json（画面 + 配音 + 配乐 + 品牌）排成一串 ffmpeg 命令。
 *
 * 两件事住在这一个文件里：
 *   ① 从 drama-compose.js 搬出来的通用零件：编码参数、起名、配乐混音图、缩放补边……
 *      短剧合成和时间轴成片共用同一套，改一处两边一起变。搬家是逐字节搬的：
 *      test/fixtures/drama-compose-golden.json 钉着搬家前短剧那边的全部输出，差一个字就红。
 *   ② timelinePlan：多尺寸（竖屏/横屏/方形/3:4）、转场、推镜、模糊背景、logo、字幕、封面。
 *
 * 这一层是纯函数：不碰盘、不起进程、不联网。文件在不在、多长、多大、ffmpeg 带了哪些滤镜、
 * 有没有渲染器，全部由调用方探好了当 facts 传进来。这样它能被单测钉死——
 * 而「拼出来的命令对不对」正是最该钉死、最难靠肉眼看出来的东西：
 * 少一帧、差 0.3 秒、音量小一半，ffmpeg 全都退出码 0。
 *
 * 能力按探到的来，不假设：本机 Homebrew 的 ffmpeg 就没带 libass，烧不了字幕。
 * 那就在**开跑前**说清楚，字幕文件照出，成片清单里记 burned:false——不是悄悄少做一步。
 */
const path = require("path");
const subs = require("./timeline-subs");
const cards = require("./timeline-cards");
const { defaultCjkFamily } = require("./font-family");
const { turned } = require("./media-probe");

// ════════════════════════════════════════════════════════════════════════
// ① 从 drama-compose.js 搬过来的（逐字节，改之前先看 golden）
// ════════════════════════════════════════════════════════════════════════

/** 这些后缀才算视频 / 音频。字段里写着 video 但指的是一张 png，是真会发生的事 */
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

const AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"];
const X264_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const FALLBACK_FPS = 30;
/** 配音和画面差这么点以内就不折腾了。25 帧的片子一帧 40ms，0.2 秒是五帧，肉眼看不出接缝 */
const SLACK = 0.2;

/**
 * 配乐音量 0.25（约 −12dB）：再大压台词，再小等于没放。
 * 注意 amix 默认会把每一路都除以 2（normalize=1），所以喂进去之前得先乘回来——
 * 不乘的话人声会**整条片子小一半**，而这种错听起来只是「有点闷」，没人会想到是混音写错了。
 */
const MUSIC_GAIN = 0.25;
/** 淡入淡出。片尾硬切一下音乐最难听，而片子多长我们是知道的（每一段都探到了时长才敢算） */
const MUSIC_FADE_IN = 1.5, MUSIC_FADE_OUT = 2.5;

/** @param {unknown} p @returns {string} */
function baseOf(p) { return String(p || "").split(/[\\/]/).pop() || ""; }
/** @param {unknown} n @param {number} [d] @returns {number} */
function round(n, d = 2) { const k = Math.pow(10, d); return Math.round(Number(n) * k) / k; }
/**
 * 文件名里不能出现的东西换成下划线。镜头 ID、片名都是用户自己敲的，什么都可能有
 * @param {unknown} s
 * @param {string} [fallback] 洗完什么都不剩时用的名字
 * @returns {string}
 */
function safeName(s, fallback = "镜头") { return String(s || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || fallback; }

/**
 * 已经有 成片.mp4 了就写成 成片_2.mp4。绝不覆盖上一条片子——那是用户可能已经发出去的东西
 * @param {string} stem
 * @param {string} ext 带点，如 ".mp4"
 * @param {Set<string>|null|undefined} onDisk
 * @returns {string}
 */
function freeName(stem, ext, onDisk) {
  const has = (n) => onDisk && typeof onDisk.has === "function" && onDisk.has(n);
  if (!has(stem + ext)) return stem + ext;
  for (let i = 2; i < 500; i++) if (!has(`${stem}_${i}${ext}`)) return `${stem}_${i}${ext}`;
  return `${stem}_${Date.now()}${ext}`;
}

const srtTime = subs.srtTime;

/** x264 要求偶数边长 @param {number} n @returns {number} */
function evenUp(n) { return n + (n % 2); }
/** 帧率取最高的那个，但不超过 60；一个都探不到就按 30 @param {number[]} list @returns {number} */
function pickFps(list) { return Math.min(60, Math.max(...list, FALLBACK_FPS)); }

/**
 * 配乐短于片子多少就循环：成品曲 60 秒、片子 3 分钟是常态；探不到时长也按要循环算
 * （多循环一遍会被 amix 的 duration=first 收住，少循环一遍就是后半截没音乐）
 * @param {number} dur 配乐时长，探不到是 0
 * @param {number} T 片长，探不到是 0
 */
function musicLoops(dur, T) { return !dur || !T || dur < T - 0.5; }

/**
 * 配乐混音图（-filter_complex 的各段，最后一段输出 [a]）。
 *
 * 三件容易写错、写错了又**听不出是哪一步错的**的事，都在这儿定死：
 *   ① amix 默认 normalize=1，会把每一路都除以 2 —— 不先把人声乘回 2，
 *      整条片子的台词会平白小一半，听起来只是「有点闷」；
 *   ② 两路的采样率/声道/采样格式对不上，sidechaincompress 会直接不干活（甚至报错），
 *      所以两路都先过一遍 aformat 归一化；
 *   ③ 淡入淡出按片长缩：一条 4 秒的片子上来个 1.5 秒淡入 + 2.5 秒淡出，
 *      音乐从头到尾没到过正常音量，听着像忘了放。
 * 有 sidechaincompress 就做「一说话音乐自动压下去」，没有就按固定音量垫着。
 * @param {{T: number, duck: boolean, limiter: boolean, gain?: number, voiceLabel?: string, musicLabel?: string}} o
 * @returns {string[]}
 */
function musicMixParts({ T, duck, limiter, gain = MUSIC_GAIN, voiceLabel = "0:a", musicLabel = "1:a" }) {
  const fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
  const fin = T ? Math.min(MUSIC_FADE_IN, round(T * 0.25, 2)) : MUSIC_FADE_IN;
  const fout = T ? Math.min(MUSIC_FADE_OUT, round(T * 0.35, 2)) : 0;
  const fade = `afade=t=in:st=0:d=${fin}`
    + (fout > 0.2 ? `,afade=t=out:st=${round(T - fout, 2)}:d=${fout}` : "");
  const g = round(gain * 2, 3);
  const parts = [];
  if (duck) {
    parts.push(`[${voiceLabel}]${fmt},asplit=2[v0][key]`);
    parts.push(`[${musicLabel}]${fmt},volume=${g},${fade}[bg]`);
    // sidechaincompress 压的是**主输入**（这里是音乐），按第二路（人声）的大小去压
    parts.push("[bg][key]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[bgd]");
    parts.push("[v0]volume=2[v2]");
    parts.push("[v2][bgd]amix=inputs=2:duration=first:dropout_transition=0[mx]");
  } else {
    parts.push(`[${voiceLabel}]${fmt},volume=2[v2]`);
    parts.push(`[${musicLabel}]${fmt},volume=${g},${fade}[bg]`);
    parts.push("[v2][bg]amix=inputs=2:duration=first:dropout_transition=0[mx]");
  }
  // 人声乘了 2，峰值顶到头的素材会削顶。有限幅器就挂一个（level=0 = 别自动把整条拉到 0dB，
  // 那会连没配乐的部分一起改音量）；没有就算了，宁可少一层保险也不要多一条会报错的滤镜
  parts.push(limiter ? "[mx]alimiter=limit=0.95:level=0[a]" : "[mx]anull[a]");
  return parts;
}

/**
 * 缩放到目标画幅、不够的地方补黑边；配音比画面长就把最后一帧接住（tpad），不是把话切掉
 * @param {number} W @param {number} H @param {number} padSec @param {number} fps
 * @returns {string}
 */
function fitPadVf(W, H, padSec, fps) {
  return `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`
    + (padSec > 0 ? `,tpad=stop_mode=clone:stop_duration=${padSec}` : "")
    + `,fps=${fps},format=yuv420p`;
}

/**
 * concat 分离器的清单。文件名里的单引号要写成 '\''，不然一个「It's」就能让整条拼接失败
 * @param {string[]} bases
 * @returns {string}
 */
function concatListText(bases) { return bases.map((b) => `file '${String(b).replace(/'/g, "'\\''")}'`).join("\n") + "\n"; }

// ════════════════════════════════════════════════════════════════════════
// ② 时间轴成片
// ════════════════════════════════════════════════════════════════════════

/** @typedef {{what: string, why: string, fix: string}} TimelineBlocker */
/** @typedef {{dur?: number, w?: number, h?: number, fps?: number, vcodec?: string, pix?: string, rot?: number}} Probe */
/**
 * @typedef {{
 *   ffmpeg?: string, ffprobe?: string, install?: string,
 *   burn?: boolean, duck?: boolean, limiter?: boolean,
 *   xfade?: boolean, zoompan?: boolean, ass?: boolean, overlay?: boolean, boxblur?: boolean,
 * }} Bins
 */
/**
 * @typedef {{
 *   slug?: string, name?: string, logo?: string, font?: {file: string, family?: string} | null,
 *   colors?: {bg?: string, fg?: string, accent?: string}, cta?: {text?: string, sub?: string}, banned?: string[],
 * }} BrandFacts
 */
/**
 * 排片要知道的一切「外部事实」。全部由调用方探好了传进来
 * @typedef {{
 *   probes?: Record<string, Probe>,
 *   exists?: Set<string> | ((rel: string) => boolean),
 *   bins?: Bins,
 *   font?: {file: string, family?: string} | null,
 *   canRender?: {ok: boolean, why?: string},
 *   brand?: BrandFacts | null,
 *   brandKit?: boolean,
 *   onDisk?: Set<string>,
 *   platform?: string,
 *   cjkFonts?: boolean,
 * }} TimelineFacts
 */
/**
 * @typedef {{
 *   key: string, label: string, argv: string[], out: string,
 *   stage: "clips"|"cards"|"audio"|"film"|"covers", kind: "ffmpeg"|"render",
 *   writes?: Array<{rel: string, text: string}>,
 *   expectSeconds: number, mediaSeconds: number, aspect?: string, burned?: boolean,
 *   fallback?: string[], fallbackWhy?: string, optional?: boolean, optionalWhy?: string,
 *   render?: {what: "motion"|"card", file: string, width: number, height: number, fps?: number, duration?: number, out: string},
 * }} TimelineStep
 */

/** 常用画幅的出片尺寸：短边 1080，各平台的推荐上传尺寸 */
const ASPECTS = { "9:16": { w: 1080, h: 1920 }, "16:9": { w: 1920, h: 1080 }, "1:1": { w: 1080, h: 1080 }, "3:4": { w: 1080, h: 1440 } };
/** @type {Record<string, string>} */
const ASPECT_LABEL = { "9:16": "竖屏", "16:9": "横屏", "1:1": "方形", "3:4": "3:4" };
/**
 * 进度的 stage（contracts A 那组固定的词）。画面片段是「编码」，卡片是「渲染」，
 * 混音和合成都是「合成」，封面是「截图」
 */
const PROGRESS_STAGE = { clips: "encode", cards: "render", audio: "compose", film: "compose", covers: "shot" };

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;
const HTML_EXT = /\.html?$/i;
const FPS_OK = [24, 25, 30, 60];
const KIND_ZH = { image: "图片", video: "视频", html: "HTML" };
/** 转场类型 → xfade 的 transition 名；cut 是硬切，走 concat */
const XFADE_NAME = { fade: "fade", slide: "slideleft" };
const DEFAULT_TRANSITION = { type: "fade", duration: 0.3 };
/**
 * 配音说完多留 0.3 秒再切。不留的话转场会吃掉最后半个字——
 * 转场是叠在两段中间的，下一段淡入的那 0.3 秒里上一段的声音还没说完
 */
const VOICE_TAIL = 0.3;
const DEFAULT_MIN = 2.0;
const DEFAULT_INTRO = 1.5, DEFAULT_OUTRO = 2.5;
const DEFAULT_KENBURNS = { from: 1.0, to: 1.12 };
const DEFAULT_LOGO = { corner: "tr", width_pct: 0.12, margin_pct: 0.04, opacity: 0.9 };
/** 用户钦定的两句不许上屏的话：对外说「一个人做的」会吓跑要付费的甲方 */
const DEFAULT_BANNED = ["一个人做的", "独立开发者一人"];
const AFMT = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";

const NO_LIBASS = "这台机器的 ffmpeg 没带 libass，字幕烧不进画面。.srt 和 .ass 已单独出好，导进剪映就能用；要直接烧进画面，换一个带 libass 的 ffmpeg（Linux 装发行版自带的 ffmpeg，macOS 用 homebrew-ffmpeg/ffmpeg 这个 tap 或官方静态版）";
const BURN_FALLBACK_WHY = "字幕没烧进去：ffmpeg 缺 libass，字幕文件另附";

/** @param {unknown} v */
function str(v) { return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""; }
/** @param {unknown} v */
function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
/** @param {unknown} v */
function num(v) { const n = Number(v); return v !== null && v !== "" && v !== undefined && Number.isFinite(n) ? n : NaN; }

/**
 * 工作区相对路径统一成正斜杠、去掉开头的 ./。探针结果和「在不在盘上」都按这个键查
 * @param {unknown} p
 * @returns {string}
 */
function normRel(p) {
  return String(p == null ? "" : p).trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "");
}

/**
 * 交给 ffmpeg 当文件参数的路径。以 - 开头会被当成选项，「xx:」开头会被当成协议（concat:、http:），
 * 前面补一个 ./ 就都是普通文件了
 * @param {string} p
 */
function ffPath(p) {
  const s = String(p || "");
  if (s.startsWith("-") || /^[A-Za-z][A-Za-z0-9+.-]+:/.test(s)) return "./" + s;
  return s;
}

/**
 * 滤镜参数里的文件名要转两层义：先是滤镜自己的参数（: 分隔），再是整张滤镜图（, ; [ ] 分隔）。
 * 少转一层，路径里一个冒号（Windows 盘符、10:30 这种文件名）就能让整条命令解析失败
 * @param {string} s
 */
function escFilterArg(s) {
  const l1 = String(s).replace(/[\\':]/g, (c) => "\\" + c);
  return l1.replace(/[\\'[\],;]/g, (c) => "\\" + c);
}

/** 秒数写进命令行：保留到微秒，不带科学计数法 @param {number} x */
function fmtNum(x) { const r = Math.round(x * 1e6) / 1e6; return Object.is(r, -0) ? "0" : String(r); }
/** @param {number} n */
function evenOf(n) { return Math.max(2, 2 * Math.round(n / 2)); }
/** @param {number} n @param {number} a @param {number} b */
function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

/**
 * 时间轴里提到的所有文件（调用方拿去探时长、查在不在盘上、限定在工作区里）。
 * 原始 JSON 和 validateTimeline 洗过的都能传
 * @param {any} tl
 * @returns {Array<{rel: string, role: "visual"|"voice"|"music"|"logo"|"font", seg?: string}>}
 */
function collectFiles(tl) {
  /** @type {Array<{rel: string, role: "visual"|"voice"|"music"|"logo"|"font", seg?: string}>} */
  const out = [];
  const seen = new Set();
  /** @param {unknown} f @param {"visual"|"voice"|"music"|"logo"|"font"} role @param {string} [seg] */
  const add = (f, role, seg) => {
    const rel = normRel(f);
    if (!rel || seen.has(role + "\0" + rel)) return;
    seen.add(role + "\0" + rel);
    out.push(seg ? { rel, role, seg } : { rel, role });
  };
  if (!isObj(tl)) return out;
  const segs = Array.isArray(tl.segments) ? tl.segments : [];
  segs.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    if (!isObj(s)) return;
    const id = str(s.id) || `s${i + 1}`;
    const vis = isObj(s.visual) ? s.visual : null;
    if (vis) {
      add(vis.file, "visual", id);
      if (isObj(vis.by_aspect)) for (const f of Object.values(vis.by_aspect)) add(f, "visual", id);
    }
    const voice = typeof s.voice === "string" ? { file: s.voice } : isObj(s.voice) ? s.voice : null;
    if (voice) {
      add(voice.file, "voice", id);
      if (Array.isArray(voice.sentences)) for (const x of voice.sentences) if (isObj(x)) add(x.file, "voice", id);
    }
  });
  const music = typeof tl.music === "string" ? { file: tl.music } : isObj(tl.music) ? tl.music : null;
  if (music) add(music.file, "music");
  if (isObj(tl.brand)) {
    add(tl.brand.logo, "logo");
    add(tl.brand.font, "font");
  }
  return out;
}

/**
 * 品牌包（brand-kit.js 的一份档案 + assetPaths 给的绝对路径）→ 排片要的那几样。
 * 纯函数：字体名要读文件，由调用方读好了放进 facts.font
 * @param {any} entry brand-kit get() 的返回
 * @param {{logo?: {light?: string, dark?: string}, fonts?: {zh?: string, en?: string}}} [paths] brand-kit assetPaths(entry)
 * @returns {BrandFacts | null}
 */
function brandFacts(entry, paths = {}) {
  const kit = entry && isObj(entry.kit) ? entry.kit : isObj(entry) ? entry : null;
  if (!kit) return null;
  const cols = Array.isArray(kit.colors) ? kit.colors.filter((/** @type {any} */ c) => c && typeof c.hex === "string") : [];
  const byRole = (/** @type {string} */ r) => { const c = cols.find((/** @type {any} */ x) => x.role === r); return c ? c.hex : ""; };
  const logo = (paths.logo && (paths.logo.light || paths.logo.dark)) || "";
  const fontFile = (paths.fonts && (paths.fonts.zh || paths.fonts.en)) || "";
  const cta = typeof kit.cta === "string" ? { text: kit.cta } : isObj(kit.cta) ? { text: str(kit.cta.text), sub: str(kit.cta.sub) } : {};
  return {
    slug: str((entry && entry.slug) || kit.slug),
    name: str(kit.name),
    logo,
    font: fontFile ? { file: fontFile, family: "" } : null,
    colors: { bg: byRole("primary") || (cols[0] && cols[0].hex) || "", fg: "", accent: byRole("accent") },
    cta,
    banned: Array.isArray(kit.banned_words) ? kit.banned_words.map(str).filter(Boolean) : [],
  };
}

/** @param {unknown} s */
function normBan(s) { return String(s == null ? "" : s).normalize("NFKC").toLowerCase().replace(/\s+/g, ""); }

/**
 * 校验并洗干净一份 timeline.json。
 * 洗过的结果还是同一套字段名（再洗一遍结果不变），所以调用方可以先洗、拿去探文件、再交给 timelinePlan。
 * facts 可以只给一部分：不给 exists 就不查文件在不在；不给 brandKit 就当没有品牌包模块
 * @param {any} obj
 * @param {TimelineFacts} [facts]
 * @returns {{ok: boolean, timeline: any, blockers: TimelineBlocker[], warnings: string[]}}
 */
function validateTimeline(obj, facts = {}) {
  /** @type {TimelineBlocker[]} */
  const blockers = [];
  /** @type {string[]} */
  const warnings = [];
  /** @param {string} what @param {string} why @param {string} fix */
  const B = (what, why, fix) => { blockers.push({ what, why, fix }); };
  if (!isObj(obj)) {
    B("timeline", "时间轴不是一个 JSON 对象", "按 {\"segments\": [...]} 的格式写");
    return { ok: false, timeline: null, blockers, warnings };
  }
  const version = obj.version == null ? 1 : num(obj.version);
  if (version !== 1) B("version", `只认 version 1，这份写的是 ${str(obj.version) || "空"}`, "把 version 改成 1");
  const title = str(obj.title) || "成片";
  const out_dir = obj.out_dir == null || obj.out_dir === "" ? "" : normRel(obj.out_dir).replace(/\/+$/, "");
  const fps = obj.fps == null ? FALLBACK_FPS : num(obj.fps);
  if (!FPS_OK.includes(fps)) B("fps", `帧率只支持 24 / 25 / 30 / 60，这份写的是 ${str(obj.fps) || "空"}`, "改成 30");

  // ── 画幅
  const rawAspects = obj.aspects == null ? ["9:16"] : obj.aspects;
  /** @type {Array<{aspect: string, w: number, h: number}>} */
  const aspects = [];
  if (!Array.isArray(rawAspects) || !rawAspects.length) B("aspects", "aspects 要写成一个列表，至少一种画幅", "比如 [\"9:16\", \"16:9\"]");
  else {
    const keys = new Set();
    for (const a of rawAspects) {
      const aspect = typeof a === "string" ? a.trim() : isObj(a) ? str(a.aspect) : "";
      if (!/^\d+:\d+$/.test(aspect) || aspect.split(":").some((x) => Number(x) === 0)) {
        B("aspects", `画幅「${typeof a === "string" ? a : JSON.stringify(a)}」看不懂`, "写成 9:16 / 16:9 / 1:1 / 3:4 这种");
        continue;
      }
      const [x, y] = aspect.split(":").map(Number);
      let w, h;
      if (isObj(a) && (a.w != null || a.h != null)) {
        w = num(a.w); h = num(a.h);
        if (!Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > 7680 || h > 7680) {
          B("aspects", `${aspect} 的尺寸 ${str(a.w) || "?"}×${str(a.h) || "?"} 不对`, "w、h 写 16–7680 之间的整数，或者不写（按标准尺寸出）");
          continue;
        }
        if (w % 2 || h % 2) {
          const W = evenUp(w), H = evenUp(h);
          warnings.push(`${aspect} 的尺寸 ${w}×${h} 有奇数边，已改成 ${W}×${H}（编码器要求偶数）`);
          w = W; h = H;
        }
      } else if (ASPECTS[aspect]) {
        ({ w, h } = ASPECTS[aspect]);
      } else {
        // 表外的画幅（4:5、21:9）：短边 1080
        if (x >= y) { h = 1080; w = evenUp(Math.round(1080 * x / y)); } else { w = 1080; h = evenUp(Math.round(1080 * y / x)); }
      }
      const key = aspect.replace(":", "x");
      if (keys.has(key)) { warnings.push(`画幅 ${aspect} 写了两遍，只出一份`); continue; }
      keys.add(key);
      aspects.push({ aspect, w, h });
    }
  }

  /**
   * @param {any} t @param {{type: string, duration: number} | null} dflt @param {string} where
   * @returns {{type: string, duration: number} | null}
   */
  const normTransition = (t, dflt, where) => {
    if (t == null) return dflt;
    const tt = typeof t === "string" ? { type: t } : isObj(t) ? t : null;
    const type = tt ? str(tt.type) || "fade" : "";
    if (!tt || !["fade", "slide", "cut"].includes(type)) {
      B(where, `转场「${tt ? str(tt.type) : JSON.stringify(t)}」不认识`, "transition.type 写 fade / slide / cut");
      return dflt;
    }
    const d = tt.duration == null ? DEFAULT_TRANSITION.duration : num(tt.duration);
    if (!(d > 0 && d <= 2)) { B(where, `转场时长 ${str(tt.duration)} 不对`, "写 0.1–2 秒，一般 0.3"); return dflt; }
    return { type, duration: type === "cut" ? 0 : d };
  };
  const transition = normTransition(obj.transition, { ...DEFAULT_TRANSITION }, "transition");

  // ── 品牌
  /** @type {any} */
  let brand = null;
  if (typeof obj.brand === "string" && obj.brand.trim()) {
    brand = obj.brand.trim();
    if (!facts.brandKit) B("brand", "品牌包还没建：先用 brand_kit 建一个，或者直接写 logo/font 路径", "先用 brand_kit 建一个品牌包，或者把 brand 写成 {\"logo\": \"…\", \"font\": \"…\"}");
    else if (facts.brand === null) B("brand", `没找到品牌包「${brand}」`, "用 brand_kit 看看有哪些，或者直接写 logo/font 路径");
  } else if (isObj(obj.brand)) {
    const b = obj.brand;
    const colors = Array.isArray(b.colors) ? b.colors.map(str) : [];
    const badColors = colors.filter((c) => !cards._internals.HEX_RE.test(c));
    if (badColors.length) warnings.push(`品牌色 ${badColors.join("、")} 不是 #RRGGBB 的写法，没用上`);
    const cta = typeof b.cta === "string" ? { text: b.cta.trim() } : isObj(b.cta) ? { text: str(b.cta.text), sub: str(b.cta.sub) } : null;
    brand = {
      ...(b.logo ? { logo: normRel(b.logo) } : {}),
      ...(b.font ? { font: normRel(b.font) } : {}),
      ...(str(b.font_family) ? { font_family: str(b.font_family) } : {}),
      colors: colors.filter((c) => cards._internals.HEX_RE.test(c)),
      ...(cta ? { cta } : {}),
      banned: Array.isArray(b.banned) ? b.banned.map(str).filter(Boolean) : [],
    };
  } else if (obj.brand != null && obj.brand !== false && obj.brand !== "") {
    B("brand", "brand 要么写品牌包的名字，要么写 {logo, font, colors, cta}", "改成其中一种");
  }

  // ── logo / 片头片尾 / 配乐 / 字幕
  /** @type {any} */
  let logo = { ...DEFAULT_LOGO };
  if (obj.logo === false) logo = false;
  else if (isObj(obj.logo)) {
    const L = obj.logo;
    const corner = L.corner == null ? DEFAULT_LOGO.corner : str(L.corner);
    if (!["tl", "tr", "bl", "br"].includes(corner)) B("logo", `logo 位置「${corner}」不认识`, "corner 写 tl / tr / bl / br（左上 / 右上 / 左下 / 右下）");
    const wp = L.width_pct == null ? DEFAULT_LOGO.width_pct : num(L.width_pct);
    const mp = L.margin_pct == null ? DEFAULT_LOGO.margin_pct : num(L.margin_pct);
    const op = L.opacity == null ? DEFAULT_LOGO.opacity : num(L.opacity);
    if (!(wp >= 0.03 && wp <= 0.5)) B("logo", `logo 宽度比例 ${str(L.width_pct)} 不对`, "width_pct 写 0.03–0.5，一般 0.12");
    if (!(mp >= 0 && mp <= 0.2)) B("logo", `logo 边距比例 ${str(L.margin_pct)} 不对`, "margin_pct 写 0–0.2，一般 0.04");
    if (!(op > 0 && op <= 1)) B("logo", `logo 不透明度 ${str(L.opacity)} 不对`, "opacity 写 0–1，一般 0.9");
    logo = { corner, width_pct: wp, margin_pct: mp, opacity: op };
  }
  /** @param {any} v @param {number} dflt @param {string} where @param {boolean} [outro] */
  const normCard = (v, dflt, where, outro) => {
    if (v == null || v === false) return false;
    const c = v === true ? {} : isObj(v) ? v : null;
    if (!c) { B(where, `${where} 要么写 false，要么写 {seconds}`, `比如 {"seconds": ${dflt}}`); return false; }
    const seconds = c.seconds == null ? dflt : num(c.seconds);
    if (!(seconds >= 0.5 && seconds <= 10)) { B(where, `${where}.seconds ${str(c.seconds)} 不对`, "写 0.5–10 秒"); return false; }
    /** @type {any} */
    const out = { seconds };
    if (str(c.text)) out.text = str(c.text);
    if (str(c.sub)) out.sub = str(c.sub);
    if (outro) out.cta = c.cta !== false;
    return out;
  };
  const intro = normCard(obj.intro, DEFAULT_INTRO, "intro");
  const outro = normCard(obj.outro, DEFAULT_OUTRO, "outro", true);

  /** @type {any} */
  let music = null;
  if (obj.music != null && obj.music !== false && obj.music !== "") {
    const m = typeof obj.music === "string" ? { file: obj.music } : isObj(obj.music) ? obj.music : null;
    const file = m ? normRel(m.file) : "";
    if (!file) B("music", "music 要写 {\"file\": \"配乐路径\"}", "写上配乐文件的路径，或者删掉 music");
    else if (!AUDIO_EXT.test(file)) B("music", `配乐不是音频文件（${baseOf(file)}）`, "换成 mp3 / m4a / wav 这类文件");
    else {
      const gain = m.gain == null ? MUSIC_GAIN : num(m.gain);
      if (!(gain > 0 && gain <= 1)) B("music", `配乐音量 ${str(m.gain)} 不对`, "gain 写 0–1，一般 0.25");
      music = { file, gain, duck: m.duck !== false };
    }
  }

  /** @type {any} */
  let subtitles = { burn: "auto", max_chars: 14, style: {} };
  if (obj.subtitles === false) subtitles = false;
  else if (isObj(obj.subtitles)) {
    const s = obj.subtitles;
    const burn = s.burn == null ? "auto" : s.burn;
    if (!(burn === "auto" || burn === true || burn === false)) B("subtitles", `subtitles.burn「${String(burn)}」不认识`, "写 \"auto\"、true 或 false");
    const max = s.max_chars == null ? 14 : num(s.max_chars);
    if (!(max >= 6 && max <= 40)) B("subtitles", `一行字数 ${str(s.max_chars)} 不对`, "max_chars 写 6–40，竖屏一般 14");
    const fs = isObj(s.style) && s.style.fontsize != null ? num(s.style.fontsize) : null;
    if (fs != null && !(fs >= 12 && fs <= 200)) B("subtitles", `字号 ${str(s.style.fontsize)} 不对`, "style.fontsize 写 12–200（按 1080 宽的竖屏算）");
    subtitles = { burn, max_chars: max, style: fs != null ? { fontsize: fs } : {} };
  }

  // ── 片段
  /** @type {any[]} */
  const segments = [];
  if (!Array.isArray(obj.segments) || !obj.segments.length) {
    B("segments", "时间轴里一个片段都没有", "至少写一段 {\"visual\": {\"kind\": \"image\", \"file\": \"…\"}}");
  } else {
    const ids = new Set();
    obj.segments.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      const id = isObj(s) && str(s.id) ? str(s.id) : `s${i + 1}`;
      const where = `片段 ${id}`;
      if (!isObj(s)) { B(where, "这一段不是一个对象", "写成 {\"visual\": {…}, \"voice\": {…}}"); return; }
      if (ids.has(id)) B(where, `片段 id「${id}」重复了`, "每段的 id 不一样");
      ids.add(id);
      const v = isObj(s.visual) ? s.visual : typeof s.visual === "string" ? { file: s.visual } : null;
      const file = v ? normRel(v.file) : "";
      if (!v || !file) { B(where, "这一段没有画面", "写上 visual.file（图片、视频或 HTML）"); return; }
      const kind = str(v.kind) || (IMAGE_EXT.test(file) ? "image" : VIDEO_EXT.test(file) ? "video" : HTML_EXT.test(file) ? "html" : "");
      if (!["image", "video", "html"].includes(kind)) {
        B(where, `画面类型「${str(v.kind) || baseOf(file)}」不认识`, "kind 写 image / video / html");
        return;
      }
      const extOk = (/** @type {string} */ f) => (kind === "image" ? IMAGE_EXT : kind === "video" ? VIDEO_EXT : HTML_EXT).test(f);
      if (!extOk(file)) B(where, `写的是${KIND_ZH[kind]}，文件却是 ${baseOf(file)}`, "把 kind 改对，或者换成对应的文件");
      /** @type {any} */
      const visual = { kind, file };
      if (v.trim != null) {
        const t = Array.isArray(v.trim) ? v.trim.map(num) : [];
        if (kind !== "video") warnings.push(`${where}：只有视频能 trim，这里忽略了`);
        else if (t.length !== 2 || !(t[0] >= 0) || !(t[1] > t[0])) B(where, `trim ${JSON.stringify(v.trim)} 不对`, "写成 [开始秒, 结束秒]，比如 [0, 4.2]");
        else visual.trim = [t[0], t[1]];
      }
      const fit = v.fit == null ? "auto" : str(v.fit);
      if (!["auto", "cover", "blur"].includes(fit)) B(where, `fit「${fit}」不认识`, "写 auto / cover / blur");
      if (kind === "video" || kind === "html") visual.fit = fit;
      if (kind === "image") {
        if (v.kenburns === false) visual.kenburns = false;
        else if (isObj(v.kenburns)) {
          const from = v.kenburns.from == null ? DEFAULT_KENBURNS.from : num(v.kenburns.from);
          const to = v.kenburns.to == null ? DEFAULT_KENBURNS.to : num(v.kenburns.to);
          if (!(from >= 1 && from <= 3 && to >= 1 && to <= 3)) B(where, "推镜的缩放倍数不对", "kenburns 写 {\"from\": 1.0, \"to\": 1.12}，都在 1–3 之间");
          else visual.kenburns = { from, to };
        }
      }
      if (kind === "html") {
        const hs = v.html_seconds == null ? null : num(v.html_seconds);
        if (hs != null && !(hs > 0 && hs <= 60)) B(where, `html_seconds ${str(v.html_seconds)} 不对`, "写 0–60 秒");
        if (hs != null) visual.html_seconds = hs;
        if (facts.canRender && facts.canRender.ok === false) {
          B(where, `这段画面是 HTML，要先渲染成视频，但现在渲染不了：${str(facts.canRender.why) || "没有渲染器"}`, "用桌面版跑，或者先把这段 HTML 渲染成视频/图片再放进来");
        }
      }
      if (isObj(v.by_aspect)) {
        /** @type {Record<string, string>} */
        const by = {};
        for (const [k, f] of Object.entries(v.by_aspect)) {
          const rel = normRel(f);
          if (!aspects.some((a) => a.aspect === k)) { warnings.push(`${where}：by_aspect 里的 ${k} 不在要出的画幅里，忽略了`); continue; }
          if (!rel || !extOk(rel)) { B(where, `by_aspect ${k} 的文件（${baseOf(rel) || "空"}）不是${KIND_ZH[kind]}`, "换成和 kind 同类的文件"); continue; }
          by[k] = rel;
        }
        if (Object.keys(by).length) visual.by_aspect = by;
      }

      /** @type {any} */
      let voice = null;
      let text = str(s.text);
      const rv = typeof s.voice === "string" ? { file: s.voice } : isObj(s.voice) ? s.voice : null;
      if (s.voice != null && s.voice !== false && !rv) B(where, "voice 要写 {\"file\": …} 或 {\"sentences\": […]}", "改成对象");
      if (rv) {
        const vfile = normRel(rv.file);
        const sentences = Array.isArray(rv.sentences) ? rv.sentences : [];
        /** @type {Array<{text: string, file: string}>} */
        const sn = [];
        sentences.forEach((/** @type {any} */ x, /** @type {number} */ j) => {
          const f = isObj(x) ? normRel(x.file) : "";
          if (!f) { B(where, `第 ${j + 1} 句配音没有文件`, "每一句写上 file，或者整段只写一个 voice.file"); return; }
          if (!AUDIO_EXT.test(f)) { B(where, `第 ${j + 1} 句配音不是音频（${baseOf(f)}）`, "换成 mp3 / m4a / wav"); return; }
          sn.push({ text: str(x.text), file: f });
        });
        if (vfile && !AUDIO_EXT.test(vfile)) B(where, `配音不是音频文件（${baseOf(vfile)}）`, "换成 mp3 / m4a / wav");
        if (vfile || sn.length) voice = { ...(vfile && !sn.length ? { file: vfile } : {}), ...(str(rv.text) ? { text: str(rv.text) } : {}), ...(sn.length ? { sentences: sn } : {}) };
        else if (str(rv.text) && !text) text = str(rv.text);
      }
      const min = s.min_seconds == null ? null : num(s.min_seconds);
      if (min != null && !(min > 0 && min <= 600)) B(where, `min_seconds ${str(s.min_seconds)} 不对`, "写 0–600 秒");
      const tr = normTransition(s.transition, null, where);
      segments.push({
        id, visual,
        ...(voice ? { voice } : {}),
        ...(text ? { text } : {}),
        ...(min != null ? { min_seconds: min } : {}),
        ...(s.cover === true ? { cover: true } : {}),
        ...(tr ? { transition: tr } : {}),
      });
    });
  }

  // ── 花费：只转交，这一步本身不花钱
  /** @type {Array<{what: string, amount: number|null, currency?: string}>} */
  const cost = [];
  if (Array.isArray(obj.cost)) {
    for (const c of obj.cost) {
      if (!isObj(c) || !str(c.what)) continue;
      const amount = c.amount == null ? null : num(c.amount);
      cost.push({ what: str(c.what), amount: Number.isFinite(amount) ? amount : null, ...(str(c.currency) ? { currency: str(c.currency) } : {}) });
    }
  }

  const timeline = {
    version: 1, title, ...(out_dir ? { out_dir } : {}), fps, aspects, transition, ...(brand ? { brand } : {}),
    logo, intro, outro, music, subtitles, segments, cost,
  };

  // ── 文件在不在盘上
  const ex = facts.exists;
  const has = typeof ex === "function" ? ex : ex instanceof Set ? (/** @type {string} */ r) => ex.has(r) : null;
  if (has) {
    const ROLE_ZH = { visual: "画面文件", voice: "配音文件", music: "配乐文件", logo: "logo 文件", font: "字体文件" };
    for (const f of collectFiles(timeline)) {
      if (!has(f.rel)) B(`文件 ${f.rel}`, `${f.seg ? `片段 ${f.seg} 的` : ""}${ROLE_ZH[f.role]}不在盘上`, "检查路径（相对工作区写），或者先把这个文件生成出来");
    }
  }

  // ── 禁用词：字幕、片头片尾上的字都查
  const banned = [...DEFAULT_BANNED, ...(isObj(brand) ? brand.banned : []), ...((facts.brand && facts.brand.banned) || [])]
    .map((w) => ({ w, n: normBan(w) })).filter((x) => x.n);
  if (banned.length) {
    /** @type {Array<{where: string, text: string}>} */
    const texts = [];
    for (const s of segments) {
      for (const t of [s.text, s.voice && s.voice.text, ...((s.voice && s.voice.sentences) || []).map((/** @type {any} */ x) => x.text)]) if (t) texts.push({ where: `片段 ${s.id}`, text: t });
    }
    for (const [name, c] of /** @type {Array<[string, any]>} */ ([["片头", intro], ["片尾", outro]])) if (c) for (const t of [c.text, c.sub]) if (t) texts.push({ where: name, text: t });
    if (isObj(brand) && brand.cta) for (const t of [brand.cta.text, brand.cta.sub]) if (t) texts.push({ where: "品牌行动号召", text: t });
    texts.push({ where: "片名", text: title });
    for (const t of texts) {
      const n = normBan(t.text);
      for (const b of banned) if (n.includes(b.n)) B(t.where, `字幕里有不许上屏的话「${b.w}」`, "把这句改掉再合成");
    }
  }

  return { ok: !blockers.length, timeline: blockers.length ? null : timeline, blockers, warnings, ...(blockers.length ? { draft: timeline } : {}) };
}

/**
 * 排片。
 *
 * 时间怎么算（全部按整帧算，不然十几段以后转场会差出一帧，两次出片的长度对不上）：
 *   每段占一个「槽」：slot = 向上取整到帧( max(最短时长, 配音时长 + 0.3) )。
 *     最短时长：图片/HTML 默认 2 秒，视频默认是剪完之后的原长（槽比视频长就接住最后一帧）。
 *   转场叠在两个槽的接缝上：第 i 段片子长 slot_i + d（d = 下一个接缝的转场时长，硬切是 0），
 *   xfade 的 offset = 前面所有槽的和，整条片子 T = 所有槽的和。片头片尾卡就是首尾两个普通的槽。
 *   配音从自己那个槽的起点开始，所以转场时声音已经在下一段了——画面跟着声音走，不是反过来。
 *
 * 步骤顺序：先混音（最快失败：配音文件坏了在第一步就知道，不用等四个画幅的画面都编完），
 * 再每个画幅依次：画卡片 → 编每一段画面 → 合成成片 → 截三张封面。
 * @param {any} timeline
 * @param {TimelineFacts} [facts]
 */
function timelinePlan(timeline, facts = {}) {
  const v = validateTimeline(timeline, facts);
  /** @type {TimelineBlocker[]} */
  const blockers = [...v.blockers];
  /** @type {string[]} */
  const warnings = [...v.warnings];
  const warn = (/** @type {string} */ w) => { if (!warnings.includes(w)) warnings.push(w); };
  const bins = facts.bins || {};
  const fail = () => ({ ok: false, blockers, warnings, steps: /** @type {TimelineStep[]} */ ([]), etaMs: 0 });
  if (!bins.ffmpeg) blockers.push({ what: "ffmpeg", why: "本机没装 ffmpeg，拼不了片", fix: `装上 ffmpeg：${bins.install || "brew install ffmpeg"}。装完回来再跑一次` });
  if (!v.timeline) return fail();
  const tl = v.timeline;
  const F = tl.fps;
  const probes = facts.probes || {};
  const probeOf = (/** @type {string} */ rel) => probes[rel] || probes[normRel(rel)] || null;
  const noProbeFix = bins.ffprobe ? "文件可能坏了，换一个或重新生成" : `本机没有 ffprobe，量不出时长：${bins.install || "brew install ffmpeg"}`;
  const ceilF = (/** @type {number} */ sec) => Math.max(1, Math.ceil(sec * F - 1e-6));
  const platform = facts.platform || process.platform;
  const canRender = !!(facts.canRender && facts.canRender.ok);

  // ── 品牌
  /** @type {BrandFacts | null} */
  let brand = null;
  if (typeof tl.brand === "string") brand = facts.brand || null;
  else if (isObj(tl.brand)) {
    const b = tl.brand;
    brand = {
      logo: b.logo || "",
      font: b.font ? { file: b.font, family: b.font_family || "" } : null,
      colors: { bg: b.colors[0] || "", fg: b.colors[1] || "", accent: b.colors[2] || "" },
      cta: b.cta || {},
      banned: b.banned,
    };
  }
  const fontFile = (facts.font && facts.font.file) || (brand && brand.font && brand.font.file) || "";
  const explicitFamily = isObj(tl.brand) ? str(tl.brand.font_family) : "";
  const fileFamily = str((facts.font && facts.font.family) || (brand && brand.font && brand.font.family));
  const family = explicitFamily || fileFamily || defaultCjkFamily(platform);
  const fontsdir = fontFile && (explicitFamily || fileFamily) ? path.dirname(fontFile) : "";
  if (fontFile && !explicitFamily && !fileFamily) warn("读不出品牌字体文件里的字体名，字幕先用系统中文字体");

  // ── 槽：片头卡 + 各段 + 片尾卡
  /**
   * @typedef {{
   *   id: string, kind: "card"|"image"|"video"|"html", card?: "intro"|"outro", seg?: any, content: boolean,
   *   slotF: number, srcDur: number, voiceFiles: string[], voiceDurs: number[], transitionIn: {type: string, duration: number}|null,
   * }} Slot
   */
  /** @type {Slot[]} */
  const slots = [];
  if (tl.intro) {
    if (canRender) slots.push({ id: "intro", kind: "card", card: "intro", content: false, slotF: ceilF(tl.intro.seconds), srcDur: 0, voiceFiles: [], voiceDurs: [], transitionIn: null });
    else warn("片头卡要桌面版才能画，这次先不加");
  }
  for (const seg of tl.segments) {
    const vis = seg.visual;
    const where = `片段 ${seg.id}`;
    let srcDur = 0;
    if (vis.kind === "video") {
      const p = probeOf(vis.file);
      const dur = p && Number(p.dur) > 0 ? Number(p.dur) : 0;
      if (!dur) blockers.push({ what: where, why: `探不到这段视频有多长（${baseOf(vis.file)}）`, fix: noProbeFix });
      else {
        const [a, b] = vis.trim || [0, dur];
        srcDur = Math.min(b, dur) - a;
        if (!(srcDur > 0)) blockers.push({ what: where, why: `trim 的开始 ${a} 秒已经超过视频长度 ${round(dur, 2)} 秒`, fix: "把 trim 改到视频长度以内" });
      }
    }
    const voiceFiles = seg.voice ? (seg.voice.sentences ? seg.voice.sentences.map((/** @type {any} */ x) => x.file) : [seg.voice.file]) : [];
    const voiceDurs = voiceFiles.map((/** @type {string} */ f) => {
      const p = probeOf(f);
      const d = p && Number(p.dur) > 0 ? Number(p.dur) : 0;
      if (!d) blockers.push({ what: where, why: `探不到配音有多长（${baseOf(f)}），字幕和画面都没法对上`, fix: noProbeFix });
      return d;
    });
    const voiceDur = voiceDurs.reduce((n, d) => n + d, 0);
    const min = seg.min_seconds != null ? seg.min_seconds
      : vis.kind === "video" ? srcDur || DEFAULT_MIN
        : vis.kind === "html" && vis.html_seconds != null ? vis.html_seconds : DEFAULT_MIN;
    if (!voiceFiles.length && seg.text) warn(`${where}：这段没有配音，只出字幕`);
    slots.push({
      id: seg.id, kind: vis.kind, seg, content: true,
      slotF: ceilF(Math.max(min, voiceDur ? voiceDur + VOICE_TAIL : 0)),
      srcDur, voiceFiles, voiceDurs, transitionIn: seg.transition || null,
    });
  }
  if (tl.outro) {
    if (canRender) slots.push({ id: "outro", kind: "card", card: "outro", content: false, slotF: ceilF(tl.outro.seconds), srcDur: 0, voiceFiles: [], voiceDurs: [], transitionIn: null });
    else warn("片尾卡要桌面版才能画，这次先不加");
  }
  if (!bins.ffmpeg || blockers.length) return fail();

  // ── 接缝：第 j 段的 transition 管的是「进入第 j 段」的那一刀
  const n = slots.length;
  /** @type {number[]} */ const dF = new Array(n).fill(0);
  /** @type {string[]} */ const dName = new Array(n).fill("");
  let noXfade = false;
  for (let j = 1; j < n; j++) {
    const tr = slots[j].transitionIn || tl.transition;
    if (tr.type === "cut") continue;
    if (!bins.xfade) { noXfade = true; continue; }
    // 转场不能比相邻两段的一半还长：不然一段还没完整露面就又要淡出了
    dF[j] = Math.min(Math.round(tr.duration * F), Math.floor(Math.min(slots[j - 1].slotF, slots[j].slotF) / 2));
    dName[j] = XFADE_NAME[tr.type];
  }
  if (noXfade) warn("这台机器的 ffmpeg 没有 xfade，转场都改成了硬切");
  /** @type {number[]} */ const startF = [];
  let acc = 0;
  for (const s of slots) { startF.push(acc); acc += s.slotF; }
  const TF = acc, T = TF / F;
  const clipF = slots.map((s, j) => s.slotF + (j < n - 1 ? dF[j + 1] : 0));

  // ── 字幕：每句从自己探到的起点排到终点
  const subsOn = tl.subtitles !== false;
  const maxChars = subsOn ? tl.subtitles.max_chars : 14;
  /** @type {Array<Array<{text: string, start: number, end: number}>>} */
  const cuesBySlot = slots.map((s, j) => {
    if (!subsOn || !s.content) return [];
    const seg = s.seg;
    const t0 = startF[j] / F;
    /** @type {Array<{text: string, start: number, dur: number}>} */
    let sentences = [];
    if (seg.voice && seg.voice.sentences && seg.voice.sentences.some((/** @type {any} */ x) => x.text)) {
      let at = t0;
      seg.voice.sentences.forEach((/** @type {any} */ x, /** @type {number} */ k) => { sentences.push({ text: x.text, start: at, dur: s.voiceDurs[k] }); at += s.voiceDurs[k]; });
    } else if (s.voiceFiles.length) {
      const text = (seg.voice && seg.voice.text) || seg.text || "";
      if (text) sentences = [{ text, start: t0, dur: s.voiceDurs.reduce((a, b) => a + b, 0) }];
    } else if (seg.text) {
      sentences = [{ text: seg.text, start: t0, dur: s.slotF / F }];
    }
    return subs.timeCues(sentences, F, maxChars);
  });
  const cues = cuesBySlot.flat();
  const wantSubs = subsOn && cues.length > 0;
  const burnMode = subsOn ? tl.subtitles.burn : false;
  // ass 和 subtitles 两个滤镜都来自 libass：老版本的 composeBins 只探了 subtitles（burn），也算数
  const hasAss = bins.ass != null ? !!bins.ass : !!bins.burn;
  const burned = wantSubs && burnMode !== false && hasAss;
  if (wantSubs && burnMode !== false && !hasAss) warn(NO_LIBASS);
  if (burned && !fontsdir && platform === "linux" && facts.cjkFonts === false) warn("这台机器没装中文字体，烧进去的字幕会是方块：装一个 fonts-noto-cjk 再跑");

  // ── 出片的名字：一个都不覆盖
  const stem0 = safeName(tl.title, "成片");
  const outDir = tl.out_dir || `成片/${stem0}`;
  const onDisk = facts.onDisk instanceof Set ? facts.onDisk : new Set();
  let sfx = "";
  for (let i = 2; i < 500; i++) {
    // 这一趟往 outDir 里写的每个名字都算：成片、每个画幅的 .ass 和三张封面、字幕、清单，
    // 还有中间件目录 .work（跑完整个删掉，撞上用户自己的同名目录就连人家的东西一起删了）
    const names = [
      ...tl.aspects.flatMap((/** @type {any} */ a) => {
        const b = `${stem0}${sfx}_${a.aspect.replace(":", "x")}`;
        return [`${b}.mp4`, `${b}.ass`, `${b}_cover1.jpg`, `${b}_cover2.jpg`, `${b}_cover3.jpg`];
      }),
      `${stem0}${sfx}.srt`, `manifest${sfx}.json`, `.work${sfx}`,
    ];
    if (!names.some((x) => onDisk.has(x))) break;
    sfx = `_${i}`;
  }
  const stem = stem0 + sfx;
  const workDir = `${outDir}/.work${sfx}`;
  const srtRel = wantSubs ? `${outDir}/${stem}.srt` : "";
  const mixRel = `${workDir}/mix.m4a`;
  const manifestRel = `${outDir}/manifest${sfx}.json`;

  // ── 声音：整条片子一份，所有画幅共用
  /** @type {TimelineStep[]} */
  const steps = [];
  const hasVoice = slots.some((s) => s.voiceFiles.length);
  const music = tl.music;
  /** @type {string[]} */
  const ain = [];
  let inputs = 0;
  /** @type {string[]} */
  const aparts = [];
  slots.forEach((s, j) => {
    const S = fmtNum(s.slotF / F);
    if (!s.voiceFiles.length) { aparts.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${S}[vs${j}]`); return; }
    if (s.voiceFiles.length === 1) {
      ain.push("-i", ffPath(s.voiceFiles[0]));
      aparts.push(`[${inputs++}:a]${AFMT},apad,atrim=duration=${S},asetpts=N/SR/TB[vs${j}]`);
      return;
    }
    // 一段好几句：先首尾相接拼成一条，再补齐到槽长
    const labels = s.voiceFiles.map((f, k) => {
      ain.push("-i", ffPath(f));
      aparts.push(`[${inputs++}:a]${AFMT}[vs${j}s${k}]`);
      return `[vs${j}s${k}]`;
    });
    aparts.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1,apad,atrim=duration=${S},asetpts=N/SR/TB[vs${j}]`);
  });
  aparts.push(`${slots.map((_, j) => `[vs${j}]`).join("")}concat=n=${n}:v=0:a=1[voice]`);
  let amap = "[voice]";
  /** @type {{file: string, ducked: boolean, looped: boolean} | null} */
  let musicInfo = null;
  if (music) {
    const mp = probeOf(music.file);
    const mdur = mp && Number(mp.dur) > 0 ? Number(mp.dur) : 0;
    const loop = musicLoops(mdur, T);
    const duck = !!music.duck && !!bins.duck;
    if (music.duck && !bins.duck && hasVoice) warn("本机 ffmpeg 没有 sidechaincompress，配乐不会在说话时自动压低，只按固定音量垫在底下");
    if (loop && mdur) warn(`配乐只有 ${round(mdur, 1)} 秒、片子 ${round(T, 1)} 秒，会循环垫到片尾`);
    ain.push(...(loop ? ["-stream_loop", "-1"] : []), "-i", ffPath(music.file));
    aparts.push(...musicMixParts({ T: round(T, 3), duck, limiter: !!bins.limiter, gain: music.gain, voiceLabel: "voice", musicLabel: `${inputs++}:a` }));
    amap = "[a]";
    musicInfo = { file: music.file, ducked: duck && hasVoice, looped: loop };
  } else if (!hasVoice) {
    warn("这条片子没有声音：没有配音也没有配乐");
  }

  // 字幕文件跟着第一步一起写：烧不烧得进去，.srt/.ass 都要给
  const assRel = (/** @type {string} */ key) => `${outDir}/${stem}_${key}.ass`;
  /** @type {Array<{rel: string, text: string}>} */
  const writes = [];
  if (wantSubs) {
    writes.push({ rel: srtRel, text: subs.buildSrt(cues) });
    for (const a of tl.aspects) {
      const sa = subs.safeAreaFor(a.aspect, a.w, a.h, tl.subtitles.style);
      writes.push({ rel: assRel(a.aspect.replace(":", "x")), text: subs.buildAss({ w: a.w, h: a.h, family, fontsize: sa.fontsize, marginV: sa.marginV, marginLR: sa.marginLR, cues }) });
    }
  }
  steps.push({
    key: "audio", label: music ? "混配音和配乐" : "接配音", stage: "audio", kind: "ffmpeg", out: mixRel,
    argv: ["-y", ...ain, "-filter_complex", aparts.join(";"), "-map", amap, ...AUDIO_ARGS, "-t", fmtNum(T), mixRel],
    ...(writes.length ? { writes } : {}),
    expectSeconds: Math.max(0.5, T * 0.05), mediaSeconds: T,
  });

  // ── logo
  const logoFile = brand && brand.logo ? brand.logo : "";
  let logoOn = !!(logoFile && tl.logo);
  if (logoOn && !bins.overlay) { logoOn = false; warn("ffmpeg 没有 overlay，这次不加 logo"); }
  const introEndF = slots[0] && slots[0].card === "intro" ? (n > 1 ? startF[1] + dF[1] : TF) : 0;
  const outroStartF = slots[n - 1] && slots[n - 1].card === "outro" ? startF[n - 1] : TF;

  // ── 每个画幅
  const cardColors = brand && brand.colors ? brand.colors : {};
  const ctaText = tl.outro ? (tl.outro.text || (tl.outro.cta && brand && brand.cta && brand.cta.text) || "") : "";
  const ctaSub = tl.outro ? (tl.outro.sub || (tl.outro.cta && brand && brand.cta && brand.cta.sub) || "") : "";
  let zoomWarned = false, blurWarned = false;
  const contentIdx = slots.map((s, j) => (s.content ? j : -1)).filter((j) => j >= 0);
  /** @type {any[]} */
  const aspectsOut = [];
  /** @type {Record<string, string[]>} */
  const coversOut = {};
  /** @type {string[]} */
  const dirs = [outDir, workDir];
  for (const a of tl.aspects) {
    const W = a.w, H = a.h, key = a.aspect.replace(":", "x");
    const label = ASPECT_LABEL[a.aspect] || a.aspect;
    const dir = `${workDir}/${key}`;
    dirs.push(dir);
    const pf = (W * H) / (1080 * 1920);
    /** @type {Record<string, string>} */
    const cardPng = {};
    // 卡片
    for (const s of slots) {
      if (s.kind !== "card") continue;
      const htmlRel = `${dir}/${s.card}.html`, png = `${dir}/${s.card}.png`;
      const common = { w: W, h: H, htmlRel, colors: cardColors, logo: logoFile, font: fontFile ? { file: fontFile } : null };
      const html = s.card === "intro"
        ? cards.introCardHtml({ ...common, title: tl.intro.text || (tl.title !== "成片" ? tl.title : ""), sub: tl.intro.sub || "" })
        : cards.outroCardHtml({ ...common, title: ctaText, sub: ctaSub });
      cardPng[s.card] = png;
      steps.push({
        key: `card:${key}:${s.card}`, label: `${label} 画${s.card === "intro" ? "片头" : "片尾"}卡`, stage: "cards", kind: "render",
        argv: [], out: png, writes: [{ rel: htmlRel, text: html }],
        render: { what: "card", file: htmlRel, width: W, height: H, out: png },
        expectSeconds: 2, mediaSeconds: 0, aspect: a.aspect,
      });
    }
    // 每一段画面
    /** @type {string[]} */
    const clips = [];
    let contentNo = 0;
    slots.forEach((s, j) => {
      const N = clipF[j], L = N / F;
      const out = `${dir}/c${String(j + 1).padStart(2, "0")}.mp4`;
      clips.push(out);
      const lab = s.card ? `${label} ${s.card === "intro" ? "片头" : "片尾"}` : `${label} 第 ${j + 1} 段画面`;
      const base = { key: `clip:${key}:${String(j + 1).padStart(2, "0")}`, label: lab, stage: /** @type {"clips"} */ ("clips"), kind: /** @type {"ffmpeg"} */ ("ffmpeg"), out, mediaSeconds: L, aspect: a.aspect };
      if (s.kind === "card" || s.kind === "image") {
        const file = s.kind === "card" ? cardPng[s.card] : ((s.seg.visual.by_aspect || {})[a.aspect] || s.seg.visual.file);
        const kb = s.kind === "card" ? false : s.seg.visual.kenburns === false ? false
          : s.seg.visual.kenburns || (contentNo % 2 ? { from: DEFAULT_KENBURNS.to, to: DEFAULT_KENBURNS.from } : DEFAULT_KENBURNS);
        if (s.kind === "image") contentNo++;
        if (kb && !bins.zoompan && !zoomWarned) { zoomWarned = true; warn("ffmpeg 没有 zoompan，图片这次不做推镜"); }
        if (kb && bins.zoompan) {
          const delta = round(kb.to - kb.from, 4);
          const z = `${kb.from}${delta < 0 ? "-" : "+"}${Math.abs(delta)}*on/${Math.max(N - 1, 1)}`;
          const vf = `scale=${2 * W}:${2 * H}:force_original_aspect_ratio=increase,crop=${2 * W}:${2 * H},zoompan=z='${z}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${N}:s=${W}x${H}:fps=${F},setsar=1,format=yuv420p`;
          steps.push({ ...base, argv: ["-y", "-i", ffPath(file), "-filter_complex", `[0:v]${vf}[v]`, "-map", "[v]", "-frames:v", String(N), ...X264_ARGS, "-an", out], expectSeconds: L * 0.8 * pf });
        } else {
          const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${F},format=yuv420p`;
          steps.push({ ...base, argv: ["-y", "-loop", "1", "-framerate", String(F), "-i", ffPath(file), "-filter_complex", `[0:v]${vf}[v]`, "-map", "[v]", "-frames:v", String(N), ...X264_ARGS, "-an", out], expectSeconds: L * 0.3 * pf });
        }
        return;
      }
      // 视频和 HTML（HTML 先渲染成一段视频，再按视频的路子统一尺寸、帧率、长度）
      const vis = s.seg.visual;
      let src = (vis.by_aspect || {})[a.aspect] || vis.file;
      let srcDur = s.srcDur, trim = vis.kind === "video" ? vis.trim : null;
      /** @type {Probe | null} */
      let p = null;
      if (vis.kind === "html") {
        const raw = `${dir}/c${String(j + 1).padStart(2, "0")}.html.mp4`;
        steps.push({
          ...base, key: `render:${key}:${String(j + 1).padStart(2, "0")}`, label: `${label} 渲染第 ${j + 1} 段`, kind: "render", argv: [], out: raw,
          render: { what: "motion", file: src, width: W, height: H, fps: F, duration: L, out: raw }, expectSeconds: L * 1.5,
        });
        src = raw; srcDur = L; trim = null;
        p = { w: W, h: H };
      } else {
        p = probeOf(src) || probeOf(vis.file);
        if (src !== vis.file) {
          const pd = p && Number(p.dur) > 0 ? Number(p.dur) : 0;
          if (pd) srcDur = trim ? Math.min(trim[1], pd) - trim[0] : pd;
        }
      }
      // 手机竖拍常存成横的 + 转 90°（p.rot）：ffmpeg 解码时先转正，横竖要按转过之后的算
      const { w: sw, h: sh } = turned(p && Number(p.w) > 0 ? Number(p.w) : 0, p && Number(p.h) > 0 ? Number(p.h) : 0, p && p.rot);
      const near = sw && sh ? Math.abs((sw / sh) / (W / H) - 1) <= 0.10 : false;
      let fit = vis.fit === "cover" || (vis.fit !== "blur" && near) ? "cover" : "blur";
      if (fit === "blur" && !(bins.boxblur && bins.overlay)) {
        fit = "pad";
        if (!blurWarned) { blurWarned = true; warn("ffmpeg 缺 boxblur 或 overlay，横竖对不上的画面改成加黑边"); }
      }
      const padSec = round(Math.max(0, L - srcDur) + 1, 3);
      const tail = `,fps=${F},tpad=stop_mode=clone:stop_duration=${padSec},format=yuv420p`;
      let graph;
      if (fit === "cover") {
        graph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1${tail}[v]`;
      } else if (fit === "blur") {
        // 背景：同一段画面缩到 1/8 再糊、再放大铺满；前景整段放进去。缩小再糊比在原尺寸上糊快几十倍，
        // 半径不能超过小图短边的 1/4（色度平面只有一半大），不然 boxblur 直接报错
        const bw = evenOf(W / 8), bh = evenOf(H / 8);
        const r = clamp(Math.floor(Math.min(bw, bh) / 4), 1, 8);
        graph = `[0:v]split[b][f];[b]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=${r}:2,scale=${W}:${H},setsar=1[bg];`
          + `[f]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2${tail}[v]`;
      } else {
        graph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1${tail}[v]`;
      }
      const input = trim ? ["-ss", fmtNum(trim[0]), "-t", fmtNum(trim[1] - trim[0]), "-i", ffPath(src)] : ["-i", ffPath(src)];
      steps.push({ ...base, argv: ["-y", ...input, "-filter_complex", graph, "-map", "[v]", "-frames:v", String(N), ...X264_ARGS, "-an", out], expectSeconds: L * 0.5 * pf });
    });

    // 合成：各段接起来（转场或硬切）→ logo → 字幕 → 配上混好的声音
    const film = `${outDir}/${stem}_${key}.mp4`;
    const vin = clips.flatMap((c) => ["-i", c]);
    let idx = clips.length;
    /** @type {string[]} */
    const parts = clips.map((_, k) => `[${k}:v]settb=AVTB,fps=${F}[c${k}]`);
    let cur = "c0";
    for (let j = 1; j < n; j++) {
      const outL = `x${j}`;
      // concat 的输出时基固定是 1/1000000，而 xfade 要求两路时基一样——硬切后面紧跟一个转场，
      // 整条命令就在 ffmpeg 里报错退出（实测）。所以硬切完立刻拨回 1/帧率
      parts.push(dF[j] > 0
        ? `[${cur}][c${j}]xfade=transition=${dName[j]}:duration=${fmtNum(dF[j] / F)}:offset=${fmtNum(startF[j] / F)}[${outL}]`
        : `[${cur}][c${j}]concat=n=2:v=1:a=0,settb=1/${F}[${outL}]`);
      cur = outL;
    }
    if (logoOn) {
      vin.push("-i", ffPath(logoFile));
      const lw = evenOf(tl.logo.width_pct * W), m = Math.round(tl.logo.margin_pct * Math.min(W, H));
      const pos = { tl: `x=${m}:y=${m}`, tr: `x=W-w-${m}:y=${m}`, bl: `x=${m}:y=H-h-${m}`, br: `x=W-w-${m}:y=H-h-${m}` }[tl.logo.corner];
      // 片头片尾卡上本来就有 logo，角标只在正片里出现，不然会同时出现两个
      const enable = introEndF > 0 || outroStartF < TF ? `:enable='between(t,${fmtNum(introEndF / F)},${fmtNum(outroStartF / F)})'` : "";
      parts.push(`[${idx++}:v]scale=${lw}:-1,format=rgba,colorchannelmixer=aa=${tl.logo.opacity}[lg]`);
      parts.push(`[${cur}][lg]overlay=${pos}${enable}[vl]`);
      cur = "vl";
    }
    const mixIdx = idx;
    vin.push("-i", mixRel);
    const tailArgs = ["-map", "[vout]", "-map", `${mixIdx}:a`, ...X264_ARGS, "-c:a", "copy", "-t", fmtNum(T), "-movflags", "+faststart", film];
    const plain = [...parts, `[${cur}]format=yuv420p[vout]`];
    const assFile = assRel(key);
    const withAss = burned
      ? [...parts, `[${cur}]ass=filename=${escFilterArg(assFile)}${fontsdir ? `:fontsdir=${escFilterArg(fontsdir)}` : ""},format=yuv420p[vout]`]
      : plain;
    steps.push({
      key: `film:${key}`, label: `${label} 合成成片`, stage: "film", kind: "ffmpeg", out: film, aspect: a.aspect, burned,
      argv: ["-y", ...vin, "-filter_complex", withAss.join(";"), ...tailArgs],
      ...(burned ? { fallback: ["-y", ...vin, "-filter_complex", plain.join(";"), ...tailArgs], fallbackWhy: BURN_FALLBACK_WHY } : {}),
      expectSeconds: T * (burned ? 0.9 : 0.6) * pf, mediaSeconds: T,
    });

    // 封面：从干净的片段上截（没有字幕和角标），避开转场那几帧
    /** @type {string[]} */
    const covers = [];
    if (contentIdx.length) {
      const coverSeg = contentIdx.find((j) => slots[j].seg.cover) ?? contentIdx[Math.floor(contentIdx.length / 2)];
      const picks = [[contentIdx[0], 0.4], [coverSeg, 0.5], [contentIdx[contentIdx.length - 1], 0.6]];
      picks.forEach(([j, frac], i) => {
        const lo = dF[j], hi = Math.max(lo, slots[j].slotF - 1);
        const t = clamp(Math.round(frac * slots[j].slotF), lo, hi) / F;
        const out = `${outDir}/${stem}_${key}_cover${i + 1}.jpg`;
        covers.push(out);
        steps.push({
          key: `cover:${key}:${i + 1}`, label: `${label} 截封面 ${i + 1}/3`, stage: "covers", kind: "ffmpeg", out, aspect: a.aspect,
          argv: ["-y", "-ss", fmtNum(t), "-i", clips[j], "-frames:v", "1", "-q:v", "2", "-update", "1", out],
          optional: true, optionalWhy: "封面没截出来，成片本身不受影响",
          expectSeconds: 0.3, mediaSeconds: 0,
        });
      });
    }
    coversOut[key] = covers;
    aspectsOut.push({ aspect: a.aspect, key, label, w: W, h: H, file: film, ass: wantSubs ? assFile : "", burned, covers });
  }

  const segmentsOut = slots.map((s, j) => ({
    id: s.id, kind: s.kind, start: round(startF[j] / F, 6), end: round((startF[j] + s.slotF) / F, 6),
    slot: round(s.slotF / F, 6), L: round(clipF[j] / F, 6), offset: round(startF[j] / F, 6),
    frames: s.slotF, clipFrames: clipF[j], transition: j ? { type: dF[j] ? dName[j] : "cut", d: round(dF[j] / F, 6) } : null,
  }));
  const costItems = tl.cost;
  const costKnown = costItems.every((/** @type {any} */ c) => c.amount != null);
  const manifestDraft = {
    version: 1, title: tl.title, fps: F, duration: round(T, 6),
    segments: slots.map((s, j) => ({
      id: s.id, start: segmentsOut[j].start, end: segmentsOut[j].end,
      visual: s.kind === "card" ? { kind: "card", card: s.card } : { kind: s.kind, file: s.seg.visual.file },
      voice: s.voiceFiles.length ? { files: s.voiceFiles, duration: round(s.voiceDurs.reduce((x, y) => x + y, 0), 3) } : null,
      cues: cuesBySlot[j],
    })),
    aspects: aspectsOut.map((a) => ({ aspect: a.aspect, file: a.file, w: a.w, h: a.h, duration: round(T, 6), burned: a.burned })),
    subtitles: { srt: srtRel, ass: aspectsOut.map((a) => a.ass).filter(Boolean) },
    covers: coversOut,
    music: musicInfo,
    brand: { ...(brand && brand.slug ? { slug: brand.slug } : {}), font_family: family },
    warnings,
    // 花费只转交上游（配音、生图）记下的账；有一项不知道单价，总数就写不知道，不写 0
    cost: { items: costItems, total: costKnown ? round(costItems.reduce((x, c) => x + Number(c.amount), 0), 4) : null, ...(costKnown ? {} : { note: "单价未知" }) },
  };

  const etaMs = Math.round(steps.reduce((x, s) => x + (s.expectSeconds || 0), 0) * 1000);
  return {
    ok: true, blockers, warnings, fps: F, T: round(T, 6), frames: TF, title: tl.title, stem, outDir, workDir,
    aspects: aspectsOut, segments: segmentsOut, cues, srt: srtRel, manifest: manifestRel,
    steps, etaMs, dirs, cleanup: [workDir], manifestDraft,
  };
}

module.exports = {
  // 从 drama-compose.js 搬过来的
  VIDEO_EXT, AUDIO_EXT, AUDIO_ARGS, X264_ARGS, FALLBACK_FPS, SLACK, MUSIC_GAIN, MUSIC_FADE_IN, MUSIC_FADE_OUT,
  round, baseOf, safeName, freeName, srtTime, evenUp, pickFps, musicLoops, musicMixParts, fitPadVf, concatListText,
  // 时间轴成片
  ASPECTS, ASPECT_LABEL, PROGRESS_STAGE, VOICE_TAIL, DEFAULT_BANNED, NO_LIBASS, BURN_FALLBACK_WHY,
  normRel, ffPath, escFilterArg, collectFiles, brandFacts, validateTimeline, timelinePlan,
};
