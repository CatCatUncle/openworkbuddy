// @ts-check
"use strict";
/**
 * 交付页：把一次内容配方的成品（各画幅成片、图组、封面、标题、各平台文案）收成一个本地静态页 交付.html。
 *
 * 为什么要一页：成品散在任务目录里，用户得一个个点开，再回对话里翻文案复制，发三个平台就翻三遍。
 * 一页摆齐——视频就地播、文案一键复制，手机同 Wi-Fi 打开也能直接用。
 *
 * 几条规矩：
 *   - 页面自包含：样式和脚本全内联，不引外链、字体、CDN。成片和图片走相对路径，和页面在同一个任务目录，
 *     桌面右栏预览（/pv/<tok>/）和「在浏览器打开」都能原样播。
 *   - 文件缺了就直说缺哪几个，整页不出，不拿占位图、占位视频充数。没做出来的由清单的 missing 写明，页面照实列出。
 *   - 画幅用 ffprobe 量真的：声明 9:16 实际是横的算错，不出页；没 ffprobe 就说没核对，不装作核对过。
 *   - 成品不加任何水印。页脚那句「记得勾选 AI 声明」只是页面上的字。
 */
const fs = require("fs");
const path = require("path");

const MANIFEST_NAME = "交付清单.json";
const PAGE_NAME = "交付.html";
// 和 recipes.js 的 FORM_FILE 同名：开头表单填完落在任务目录里，这里拿它核对「表单要的都交了没有」
const FORM_FILE = "配方表单.json";

/** 画幅：名字、给哪些平台用。只收这四种——tab 上的字和 CSS aspect-ratio 都从这里来 */
const ASPECTS = {
  "9:16": { w: 9, h: 16, name: "竖版 9:16", hint: "抖音/视频号" },
  "16:9": { w: 16, h: 9, name: "横版 16:9", hint: "B站/视频号" },
  "1:1": { w: 1, h: 1, name: "方版 1:1", hint: "朋友圈/微博" },
  "4:5": { w: 4, h: 5, name: "竖版 4:5", hint: "小红书" },
};
// 宽高比差 3% 以内算同一个画幅：1080×1920 和 1088×1920（编码器按 16 对齐）不该报错
const ASPECT_TOL = 0.03;
// 浏览器能直接播/显示的格式。别的（psd、mkv、avi）页面上只会是一个破图标，不如当场报错让它转
const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
// 字数上限按码点算。正文给到 2 万：公众号长文五六千字很常见，截了再让人一键复制等于交出半篇
const CAP = {
  title: 80, summary: 400, label: 40, note: 200, titleItem: 100, platName: 20, platTitle: 100,
  body: 20000, tags: 20, tag: 30, line: 200, cost: 200, list: 60,
};

/**
 * 每个配方该交哪些东西（和 recipes.js 各配方的 deliver 对齐）。
 * 少了只记成「还差」写进页面、提醒模型，不拦着出页：用户中途改主意（表单 notes 优先）是常事。
 * coversOptional：一稿多投选了「只要文字」就没有封面，没封面不算缺，给了但不够 3 张才算。
 */
const EXPECT = {
  "promo-video": { videos: true, images: false, covers: 3, coversOptional: false, titles: 3, platforms: true },
  "xhs-carousel": { videos: false, images: true, covers: 3, coversOptional: false, titles: 3, platforms: true },
  "multi-post": { videos: false, images: false, covers: 3, coversOptional: true, titles: 3, platforms: true },
};
// 表单里的平台值只认这些中文名，拿不准的值（比如英文代号）不核，免得在用户页面上写一条假的「还差」
const KNOWN_PLATFORMS = ["抖音", "抖音口播", "视频号", "小红书", "B站", "公众号", "知乎", "微博", "朋友圈", "快手"];

/** @typedef {{ file: string, aspect: string, label: string, w?: number, h?: number, dur?: number }} Video */
/** @typedef {{ file: string, note: string }} Pic */
/** @typedef {{ name: string, title: string, body: string, tags: string[] }} Platform */
/**
 * @typedef {{
 *   title: string, summary: string, recipe: string, kicker: string,
 *   videos: Video[], images: Pic[], covers: Pic[], titles: string[], platforms: Platform[],
 *   assumptions: string[], missing: string[], gaps: string[], cost: string, checks: string[],
 * }} Manifest
 */
/** @typedef {{ w: number, h: number, dur?: number } | { bad: string } | { skip: string } | null} ProbeResult */
/** @typedef {(abs: string, o?: { signal?: AbortSignal }) => Promise<ProbeResult>} Probe */

/** @returns {Manifest} */
function emptyManifest() {
  return {
    title: "", summary: "", recipe: "", kicker: "", videos: [], images: [], covers: [], titles: [], platforms: [],
    assumptions: [], missing: [], gaps: [], cost: "", checks: [],
  };
}

// ───────────────────────── 纯函数：路径、文字、画幅 ─────────────────────────

/**
 * 清单里的一个路径 → 相对任务目录的 a/b/c 形式。链接、..、目录外的绝对路径一律不收：
 * 页面要能整目录拷走、手机上照样打开，引用出了这个目录就断了。
 * @param {any} v
 * @param {string} dir
 * @returns {{ rel: string, err?: undefined } | { err: string, rel?: undefined }}
 */
function relPath(v, dir) {
  let s = typeof v === "string" ? v.trim() : "";
  if (!s) return { err: "没写 file" };
  // C:\ 这种盘符不是链接
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s)) {
    return { err: `${s.slice(0, 80)} 是链接；交付页只引任务目录里的文件，不引外链` };
  }
  s = s.replace(/\\/g, "/");
  if (path.isAbsolute(s)) {
    const root = path.resolve(dir), abs = path.resolve(s);
    if (!abs.startsWith(root + path.sep)) return { err: `${path.basename(s)} 在任务目录外面；先复制进任务目录，再写相对路径` };
    s = path.relative(root, abs).split(path.sep).join("/");
  }
  const segs = s.split("/").filter((x) => x !== "" && x !== ".");
  if (segs.includes("..")) return { err: `${s.slice(0, 80)} 带 ..；只能写任务目录里的相对路径` };
  if (!segs.length) return { err: "没写 file" };
  return { rel: segs.join("/") };
}

/**
 * 默认的「盘上有没有」：真是文件、真在任务目录里（软链指到外面也不算，页面带不走它）。
 * @param {string} dir
 * @param {string} rel
 * @returns {boolean | string} true 在；false 找不到；字符串 = 找得到但不能用的原因
 */
function fileInside(dir, rel) {
  let real;
  try { real = fs.realpathSync(path.join(dir, ...rel.split("/"))); } catch { return false; }
  let root;
  try { root = fs.realpathSync(dir); } catch { return false; }
  if (!real.startsWith(root + path.sep)) return `${rel} 是个链接，指到了任务目录外面；把文件本身复制进来`;
  try { return fs.statSync(real).isFile() ? true : `${rel} 是个目录，不是文件`; } catch { return false; }
}

/** 一行字：去控制字符、换行并成空格、按码点截断；截了要说 */
/**
 * @param {any} v @param {number} max @param {string} what @param {string[]} warnings
 * @returns {string}
 */
function line(v, max, what, warnings) {
  return clip(v, max, what, warnings, true);
}

/**
 * @param {any} v @param {number} max @param {string} what @param {string[]} warnings @param {boolean} [oneLine]
 * @returns {string}
 */
function clip(v, max, what, warnings, oneLine) {
  if (v == null) return "";
  let s = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  s = s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  s = oneLine ? s.replace(/\s+/g, " ").trim() : s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const cps = Array.from(s);
  if (cps.length > max) {
    warnings.push(`${what}超过 ${max} 字，后面截掉了`);
    s = cps.slice(0, max).join("").trim();
  }
  return s;
}

/** "9x16" / "9：16" / " 9 : 16 " 都认成 9:16；不认识的给空串 */
/** @param {any} v @returns {string} */
function normAspect(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, "").replace(/[：xX×*/]/g, ":");
  return Object.prototype.hasOwnProperty.call(ASPECTS, s) ? s : "";
}

/** 量出来的宽高最接近哪个画幅（差 3% 以内），都不像就空串 */
/** @param {number} w @param {number} h @returns {string} */
function nearestAspect(w, h) {
  let best = "", diff = Infinity;
  for (const [k, a] of Object.entries(ASPECTS)) {
    const d = Math.abs((w / h) / (a.w / a.h) - 1);
    if (d < diff) { diff = d; best = k; }
  }
  return diff <= ASPECT_TOL ? best : "";
}

/** @param {any} f @returns {string} */
const extOf = (f) => (/\.([a-z0-9]+)$/i.exec(String(f)) || ["", ""])[1].toLowerCase();

/**
 * ffprobe 的 JSON → 显示出来的宽高和时长。
 * 手机拍的竖屏常是「存成 1920×1080 + 旋转 90°」，播放器按旋转后的样子放，所以按旋转后的算；
 * 非方像素（SAR≠1）按显示宽度算。只有封面图（attached_pic）没有画面的，算读不出。
 * @param {any} j
 * @returns {ProbeResult}
 */
function parseProbe(j) {
  const streams = (j && Array.isArray(j.streams)) ? j.streams : [];
  const s = streams.find((x) => x && x.codec_type === "video" && !(x.disposition && x.disposition.attached_pic === 1));
  const bad = { bad: "读不出视频画面（可能只有声音，或文件坏了）" };
  if (!s) return bad;
  let w = Number(s.width) || 0, h = Number(s.height) || 0;
  if (!(w > 0 && h > 0)) return bad;
  const sar = /^(\d+):(\d+)$/.exec(String(s.sample_aspect_ratio || ""));
  if (sar && Number(sar[1]) > 0 && Number(sar[2]) > 0 && sar[1] !== sar[2]) w = Math.round(w * Number(sar[1]) / Number(sar[2]));
  let rot = 0;
  for (const d of Array.isArray(s.side_data_list) ? s.side_data_list : []) {
    if (d && d.rotation != null && Number.isFinite(Number(d.rotation))) rot = Number(d.rotation);
  }
  if (!rot && s.tags && s.tags.rotate != null) rot = Number(s.tags.rotate) || 0;
  if (Math.abs(Math.round(rot)) % 180 === 90) [w, h] = [h, w];
  const dur = Number(s.duration) || Number((j.format || {}).duration) || 0;
  return { w, h, dur };
}

/**
 * 默认的量法：lib/media-probe 找 ffprobe，量第一路视频流。
 * 没 ffprobe / 跑不起来 → skip（说没核对）；跑了但读不懂 → bad（文件多半坏了，页面上也播不了）。
 * @type {Probe}
 */
async function defaultProbe(abs, o = {}) {
  const MP = require("./lib/media-probe");
  const bins = await MP.resolveMediaBins();
  if (!bins.ffprobe.bin) return { skip: `没装 ffprobe，没核对画幅${bins.install ? "（装法：" + bins.install + "）" : ""}` };
  let out;
  try {
    out = await MP.runBin(bins.ffprobe.bin, ["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", abs], {
      timeout: 20000, signal: o.signal, what: "ffprobe",
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    if (e && (e.code === "ENOENT" || e.code === "EACCES" || e.timedOut)) return { skip: `ffprobe 没跑成，没核对画幅：${e.message}` };
    return { bad: "ffprobe 读不懂，文件可能坏了或不是视频" };
  }
  let j;
  try { j = JSON.parse(out.stdout || "{}"); } catch { return { bad: "ffprobe 读不懂，文件可能坏了或不是视频" }; }
  return parseProbe(j);
}

// ───────────────────────── 清单 → 规整的数据 ─────────────────────────

/**
 * 校验并规整清单。只做纯判断（盘上有没有由 exists 回答，测试可以注入），不量视频。
 * 缺文件、路径不对、格式不对是 errors（整页不出）；截断、数量不够是 warnings（照出，但要说）。
 * @param {any} raw
 * @param {{ dir: string, exists?: (rel: string) => boolean | string, form?: any }} opts
 * @returns {{ m: Manifest, errors: string[], warnings: string[] }}
 */
function normalize(raw, opts) {
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const warnings = [];
  const m = emptyManifest();
  const dir = opts.dir;
  const exists = opts.exists || ((/** @type {string} */ rel) => fileInside(dir, rel));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push('清单顶层要是一个对象，比如 {"title":"…","videos":[…]}');
    return { m, errors, warnings };
  }
  /** @type {string[]} */ const missingFiles = [];
  const base = path.basename(dir);

  /** @param {any} v @param {string} where @param {"video"|"image"} kind @returns {string} */
  const file = (v, where, kind) => {
    const r = relPath(v, dir);
    if (r.err !== undefined) { errors.push(`${where}：${r.err}`); return ""; }
    let rel = r.rel;
    const ext = extOf(rel);
    if (kind === "video" && !VIDEO_EXT.has(ext)) { errors.push(`${where}：${rel} 浏览器播不了，转成 mp4 再交`); return ""; }
    if (kind === "image" && !IMAGE_EXT.has(ext)) { errors.push(`${where}：${rel} 浏览器显示不了，转成 png / jpg / webp 再交`); return ""; }
    let hit = exists(rel);
    // 模型常把成果目录名再拼一遍（任务_X/成片.mp4），跟 tools.js resolveFile 一样剥掉这一层
    if (hit === false && rel.startsWith(base + "/")) {
      const inner = rel.slice(base.length + 1);
      const h2 = exists(inner);
      if (h2 !== false) { rel = inner; hit = h2; }
    }
    if (typeof hit === "string") { errors.push(`${where}：${hit}`); return ""; }
    if (!hit) { missingFiles.push(rel); return ""; }
    return rel;
  };
  /** @param {any} v @param {string} name @returns {any[]} */
  const list = (v, name) => {
    if (v == null) return [];
    if (!Array.isArray(v)) { errors.push(`${name} 要写成数组 […]`); return []; }
    if (v.length > CAP.list) { warnings.push(`${name} 超过 ${CAP.list} 项，后面的没放进页面`); return v.slice(0, CAP.list); }
    return v;
  };

  m.title = line(raw.title, CAP.title, "title ", warnings);
  if (!m.title) errors.push("清单缺 title（交付页的大标题）");
  m.summary = clip(raw.summary, CAP.summary, "summary ", warnings);
  const rid = typeof raw.recipe === "string" ? raw.recipe.trim() : "";
  if (rid && /^[a-z0-9-]{1,40}$/.test(rid)) m.recipe = rid;
  else if (rid) warnings.push(`recipe「${rid.slice(0, 20)}」不是配方名，没按配方核对`);
  const form = opts.form && typeof opts.form === "object" ? opts.form : null;
  if (!m.recipe && form && typeof form.id === "string" && /^[a-z0-9-]{1,40}$/.test(form.id)) m.recipe = form.id;
  if (form && form.id === m.recipe) m.kicker = line(form.title, CAP.label, "表单标题", []);

  list(raw.videos, "videos").forEach((v, i) => {
    const where = `videos 第 ${i + 1} 条`;
    const o = typeof v === "string" ? { file: v } : v && typeof v === "object" ? v : null;
    if (!o) { errors.push(`${where} 要写成 {"aspect":"9:16","file":"成片_9x16.mp4"}`); return; }
    const f = file(o.file, where, "video");
    let aspect = "";
    if (o.aspect != null && String(o.aspect).trim()) {
      aspect = normAspect(o.aspect);
      if (!aspect) { errors.push(`${where} 的 aspect「${String(o.aspect).slice(0, 20)}」不认识，只收 9:16 / 16:9 / 1:1 / 4:5`); return; }
    }
    if (f) m.videos.push({ file: f, aspect, label: line(o.label, CAP.label, `${where}的 label `, warnings) });
  });
  /** @param {any} v @param {string} name @returns {Pic[]} */
  const pics = (v, name) => {
    /** @type {Pic[]} */ const out = [];
    list(v, name).forEach((p, i) => {
      const where = `${name} 第 ${i + 1} 张`;
      const o = typeof p === "string" ? { file: p } : p && typeof p === "object" ? p : null;
      if (!o) { errors.push(`${where} 要写成 {"file":"…","note":"…"}`); return; }
      const f = file(o.file, where, "image");
      if (f) out.push({ file: f, note: line(o.note, CAP.note, `${where}的 note `, warnings) });
    });
    return out;
  };
  m.images = pics(raw.images, "images");
  m.covers = pics(raw.covers, "covers");
  list(raw.titles, "titles").forEach((t, i) => {
    const s = line(typeof t === "object" && t ? t.text : t, CAP.titleItem, `titles 第 ${i + 1} 个`, warnings);
    if (s) m.titles.push(s);
  });
  list(raw.platforms, "platforms").forEach((p, i) => {
    const where = `platforms 第 ${i + 1} 个`;
    if (!p || typeof p !== "object") { errors.push(`${where} 要写成 {"name":"小红书","title":"…","body":"…","tags":[…]}`); return; }
    const name = line(p.name, CAP.platName, `${where}的 name `, warnings);
    if (!name) { errors.push(`${where} 没写 name（发到哪个平台）`); return; }
    const body = clip(p.body, CAP.body, `${name} 的正文`, warnings);
    if (!body) { errors.push(`${where}（${name}）没写 body`); return; }
    const rawTags = Array.isArray(p.tags) ? p.tags : typeof p.tags === "string" ? p.tags.split(/[\s,，、]+/) : [];
    /** @type {string[]} */ const tags = [];
    for (const t of rawTags) {
      const s = line(t, CAP.tag, `${name} 的话题`, warnings).replace(/^#+/, "").trim();
      if (s && !tags.includes(s)) tags.push(s);
    }
    if (tags.length > CAP.tags) warnings.push(`${name} 的话题超过 ${CAP.tags} 个，只留前 ${CAP.tags} 个`);
    m.platforms.push({ name, title: line(p.title, CAP.platTitle, `${name} 的标题`, warnings), body, tags: tags.slice(0, CAP.tags) });
  });
  list(raw.assumptions, "assumptions").forEach((a) => { const s = line(a, CAP.line, "一条假设", warnings); if (s) m.assumptions.push(s); });
  list(raw.missing, "missing").forEach((x) => {
    const o = x && typeof x === "object" ? x : { what: x };
    const what = line(o.what, CAP.line, "missing 的一项", warnings), why = line(o.why, CAP.line, "missing 的原因", warnings);
    if (what || why) m.missing.push(what && why ? `${what}：${why}` : what || why);
  });
  const cost = raw.cost && typeof raw.cost === "object" ? raw.cost.text : raw.cost;
  m.cost = line(cost, CAP.cost, "cost ", warnings);

  if (missingFiles.length) {
    errors.unshift(`清单里写了、目录里找不到（${missingFiles.length} 个）：${missingFiles.join("、")}。` +
      "在别的目录就改成相对任务目录的路径；没做出来就从清单里删掉，写进 missing 说明为什么，页面会照实列出来");
  }
  const got = m.videos.length + m.images.length + m.covers.length + m.titles.length + m.platforms.length;
  if (!got && !errors.length) errors.push("清单里一样成品都没有（videos / images / covers / titles / platforms 全空）");
  countGaps(m, form, warnings);
  return { m, errors, warnings };
}

/**
 * 按配方核数量：少了记进 m.gaps（页面「还差这些」照实列）并提醒；多了只提醒。
 * @param {Manifest} m @param {any} form @param {string[]} warnings
 */
function countGaps(m, form, warnings) {
  const e = Object.prototype.hasOwnProperty.call(EXPECT, m.recipe) ? EXPECT[/** @type {keyof typeof EXPECT} */ (m.recipe)] : null;
  if (!e) return;
  /** @param {string} s */
  const gap = (s) => { m.gaps.push(s); warnings.push(s); };
  if (e.videos && !m.videos.length) gap("没有成片，这个配方要出片");
  if (e.images && !m.images.length) gap("没有图组，这个配方要出图");
  const nc = m.covers.length;
  if (!nc && !e.coversOptional) gap(`没有封面候选，配方要 ${e.covers} 张`);
  else if (nc && nc < e.covers) gap(`封面只有 ${nc} 张，配方要 ${e.covers} 张`);
  else if (nc > e.covers) warnings.push(`封面有 ${nc} 张，配方要 ${e.covers} 张`);
  const nt = m.titles.length;
  if (!nt) gap(`没有标题候选，配方要 ${e.titles} 个`);
  else if (nt < e.titles) gap(`标题候选只有 ${nt} 个，配方要 ${e.titles} 个`);
  else if (nt > e.titles) warnings.push(`标题候选有 ${nt} 个，配方要 ${e.titles} 个`);
  if (e.platforms && !m.platforms.length) gap("没有各平台文案");
  const vals = form && form.id === m.recipe && form.values && typeof form.values === "object" ? form.values : null;
  if (!vals) return;
  const want = Number(vals.count);
  if (e.images && /^\d+$/.test(String(vals.count)) && want > 0 && want <= 30 && m.images.length) {
    if (m.images.length < want) gap(`图组只有 ${m.images.length} 张，表单要 ${want} 张`);
    else if (m.images.length > want) warnings.push(`图组有 ${m.images.length} 张，表单要 ${want} 张`);
  }
  if (Array.isArray(vals.platforms) && m.platforms.length) {
    for (const p of vals.platforms) {
      if (!KNOWN_PLATFORMS.includes(p)) continue;
      if (!m.platforms.some((x) => x.name.includes(p) || p.includes(x.name))) gap(`表单要了${p}的文案，清单里没有`);
    }
  }
}

/**
 * 量完视频之后再核画幅：表单要了的画幅每种至少一条。量之前核不了——没写 aspect 的要靠量出来。
 * @param {Manifest} m @param {any} form @param {string[]} warnings
 */
function aspectGaps(m, form, warnings) {
  const vals = form && form.id === m.recipe && form.values && typeof form.values === "object" ? form.values : null;
  if (!vals || !Array.isArray(vals.aspects) || !m.videos.length) return;
  for (const a of vals.aspects) {
    const k = normAspect(a);
    if (k && !m.videos.some((v) => v.aspect === k)) {
      const s = `表单要了${ASPECTS[/** @type {keyof typeof ASPECTS} */ (k)].name}，成片里没有`;
      m.gaps.push(s);
      warnings.push(s);
    }
  }
}

// ───────────────────────── 渲染 ─────────────────────────

/** @param {any} s @returns {string} */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
/** 相对路径逐段编码：文件名里的空格、#、?、中文都不会把链接截断 */
/** @param {string} rel @returns {string} */
const href = (rel) => rel.split("/").map(encodeURIComponent).join("/");

// 4 个颜色（底、面、字、品牌），次要字和分隔线是「字」的透明度，不另起一色；间距全是 4 的倍数。
// 全页 letter-spacing:0——中文加字距会散。
const CSS = `
:root{--bg:#f6f6f4;--surface:#ffffff;--text:#1d1d1f;--brand:#5155e8;--muted:rgba(29,29,31,.64);--line:rgba(29,29,31,.12);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--surface:#1f1f23;--text:#f2f2f0;--brand:#8e91f5;--muted:rgba(242,242,240,.64);--line:rgba(242,242,240,.14)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif;letter-spacing:0}
.wrap{max-width:960px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:28px;line-height:36px;margin:0 0 8px;overflow-wrap:anywhere}
h2{font-size:20px;line-height:28px;margin:0 0 16px}
h3{font-size:16px;line-height:24px;margin:0}
p{margin:0}
section{margin-top:40px}
a{color:var(--brand)}
a[download]{white-space:nowrap}
.muted{color:var(--muted)}
.small{font-size:14px;line-height:20px}
.kicker{font-size:14px;line-height:20px;color:var(--muted);margin-bottom:8px}
.sum{margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.meta{margin-top:12px;font-size:14px;line-height:20px;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px}
.gaps{margin-top:24px;border-left:4px solid var(--brand)}
.gaps h2{font-size:16px;line-height:24px;margin-bottom:8px}
.list{margin:0;padding-left:20px}
.list li+li{margin-top:4px}
.list li{overflow-wrap:anywhere}
.btn{font:inherit;font-size:14px;line-height:20px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--text);cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--brand);color:var(--brand)}
.btn:focus-visible,.thumb:focus-visible,.track:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.tab[aria-selected=true]{background:var(--brand);border-color:var(--brand);color:var(--bg)}
.frame{margin:0 auto;border-radius:12px;overflow:hidden;background:var(--line)}
.frame video{display:block;width:100%;height:100%;object-fit:contain}
.vmeta{margin-top:12px;text-align:center;font-size:14px;line-height:20px;color:var(--muted);overflow-wrap:anywhere}
.phone{width:min(100%,360px);aspect-ratio:3/4;margin:0 auto;border:1px solid var(--line);border-radius:16px;overflow:hidden;background:var(--surface)}
.track{display:flex;height:100%;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;overscroll-behavior-x:contain}
.track::-webkit-scrollbar{display:none}
.slide{flex:0 0 100%;height:100%;margin:0;scroll-snap-align:start}
.slide a{display:block;height:100%}
.slide img{display:block;width:100%;height:100%;object-fit:contain}
.pager{display:flex;align-items:center;justify-content:center;gap:12px;max-width:360px;margin:12px auto 0;font-size:14px;line-height:20px}
.pager #pos{min-width:48px;text-align:center}
.capnote{max-width:360px;margin:8px auto 0;text-align:center;font-size:14px;line-height:20px;color:var(--muted);overflow-wrap:anywhere}
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:8px;max-width:360px;margin:12px auto 0}
.thumb{position:relative;padding:0;aspect-ratio:3/4;border:2px solid transparent;border-radius:8px;overflow:hidden;background:var(--surface);cursor:pointer}
.thumb[aria-current=true]{border-color:var(--brand)}
.thumb img{display:block;width:100%;height:100%;object-fit:cover}
.thumb span{position:absolute;left:4px;top:4px;padding:0 4px;border-radius:4px;font-size:12px;line-height:16px;background:var(--bg);color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(max(96px,calc((100% - 24px) / 3)),1fr));gap:12px}
.cover{margin:0;padding:8px}
.cover img{display:block;width:100%;height:auto;max-height:60vh;object-fit:contain;border-radius:8px}
.cover figcaption{margin-top:8px;font-size:14px;line-height:20px;overflow-wrap:anywhere}
.cover figcaption b{margin-right:4px}
.rows{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.row{display:flex;align-items:center;gap:12px}
.row .idx{flex:none;width:24px;color:var(--muted);font-size:14px}
.row .t{flex:1;min-width:0;overflow-wrap:anywhere}
.plats{display:grid;gap:16px}
.plat-hd{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.acts{display:flex;flex-wrap:wrap;gap:8px}
.pt{font-weight:600;margin-bottom:8px;overflow-wrap:anywhere}
.pb{white-space:pre-wrap;overflow-wrap:anywhere}
.tags{margin-top:8px;color:var(--brand);overflow-wrap:anywhere}
.ft{margin-top:48px;padding-top:16px;border-top:1px solid var(--line);font-size:14px;line-height:20px;color:var(--muted)}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:calc(100% - 32px);padding:8px 16px;border-radius:8px;background:var(--text);color:var(--bg);font-size:14px;line-height:20px}
[hidden]{display:none!important}
`.trim();

// 页面脚本：成片 tab、图组翻页、复制。写成 ES5，微信里打开的老内核也能跑。
// 复制三级退路：clipboard API（只有安全上下文有；桌面右栏的沙盒 iframe 会拒）→ 隐藏 textarea + execCommand
// → 都不行就把那段字选中，让人自己按复制键。绝不假装复制成功。
const SCRIPT = `
(function () {
  "use strict";
  var COPY = [];
  try { COPY = JSON.parse(document.getElementById("owb-copy").textContent || "[]"); } catch (e) {}
  var toastEl = document.getElementById("toast"), toastT = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.hidden = true; }, 3000);
  }
  var tabs = document.querySelectorAll("[role=tab]");
  function pick(tab) {
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i] === tab, p = document.getElementById(tabs[i].getAttribute("aria-controls"));
      tabs[i].setAttribute("aria-selected", on ? "true" : "false");
      tabs[i].tabIndex = on ? 0 : -1;
      if (!p) continue;
      p.hidden = !on;
      if (!on) { var vs = p.getElementsByTagName("video"); for (var j = 0; j < vs.length; j++) vs[j].pause(); }
    }
  }
  for (var t = 0; t < tabs.length; t++) tabs[t].addEventListener("click", function () { pick(this); });
  var track = document.getElementById("track");
  if (track) {
    var slides = track.children, thumbs = document.querySelectorAll("[data-slide]");
    var pos = document.getElementById("pos"), capnote = document.getElementById("capnote"), cur = -1, raf = 0;
    var mark = function () {
      var w = track.clientWidth || 1, k = Math.max(0, Math.min(slides.length - 1, Math.round(track.scrollLeft / w)));
      if (k === cur) return;
      cur = k;
      if (pos) pos.textContent = (k + 1) + " / " + slides.length;
      if (capnote) capnote.textContent = slides[k].getAttribute("data-note") || "";
      for (var i = 0; i < thumbs.length; i++) thumbs[i].setAttribute("aria-current", i === k ? "true" : "false");
    };
    var go = function (k) {
      k = Math.max(0, Math.min(slides.length - 1, k));
      if (track.scrollTo) track.scrollTo({ left: k * track.clientWidth, behavior: "smooth" }); else track.scrollLeft = k * track.clientWidth;
    };
    track.addEventListener("scroll", function () {
      if (!raf) raf = (window.requestAnimationFrame || setTimeout)(function () { raf = 0; mark(); });
    });
    for (var s = 0; s < thumbs.length; s++) thumbs[s].addEventListener("click", function () { go(+this.getAttribute("data-slide")); });
    var steps = document.querySelectorAll("[data-step]");
    for (var q = 0; q < steps.length; q++) steps[q].addEventListener("click", function () { go(cur + (+this.getAttribute("data-step"))); });
    mark();
  }
  function legacy(text) {
    var ta = document.createElement("textarea"), ok = false;
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-9999px"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function selectEl(el) {
    var r = document.createRange(), sel = window.getSelection();
    r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r);
  }
  function flash(b) {
    if (!b.getAttribute("data-label")) b.setAttribute("data-label", b.textContent);
    b.textContent = "已复制";
    clearTimeout(b._owbT);
    b._owbT = setTimeout(function () { b.textContent = b.getAttribute("data-label"); }, 1500);
  }
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-copy]") : null;
    if (!b) return;
    var n = +b.getAttribute("data-copy"), text = COPY[n];
    if (typeof text !== "string") return;
    var fail = function () {
      if (legacy(text)) { flash(b); return; }
      var el = document.getElementById("c" + n);
      if (el) selectEl(el);
      toast("已选中，按 ⌘C / Ctrl+C");
    };
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash(b); }, fail);
    } else fail();
  });
})();
`.trim();

/** @param {Date} d @returns {string} */
function stamp(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** @param {Video} v @returns {string} */
function aspectStyle(v) {
  const a = ASPECTS[/** @type {keyof typeof ASPECTS} */ (v.aspect)];
  const w = a ? a.w : v.w || 16, h = a ? a.h : v.h || 9;
  // 竖版别撑满 960 宽：按视口高度的 72% 反推宽度，一屏看得全
  return `aspect-ratio:${w}/${h};width:min(100%,calc(72vh * ${w} / ${h}))`;
}

/**
 * 出一整页 HTML。所有字都转义，所有路径逐段编码；复制用的原文放在 JSON 块里（< 全转成 \u003c，
 * 正文里写了 </script> 也跑不出去）。
 * @param {Manifest} m
 * @param {{ now?: Date }} [opts]
 * @returns {string}
 */
function render(m, opts = {}) {
  /** @type {string[]} */ const copies = [];
  /** @param {string} text */
  const addCopy = (text) => copies.push(text) - 1;
  const now = opts.now instanceof Date ? opts.now : new Date();
  /** @type {string[]} */ const out = [];
  const counts = countLine(m);

  out.push(`<header><p class="kicker">交付${m.kicker ? " · " + esc(m.kicker) : ""} · ${esc(stamp(now))}</p>`);
  out.push(`<h1>${esc(m.title)}</h1>`);
  if (m.summary) out.push(`<p class="sum">${esc(m.summary)}</p>`);
  const meta = [counts, m.cost ? `费用：${m.cost}` : ""].filter(Boolean).map(esc).join(" · ");
  if (meta) out.push(`<p class="meta">${meta}</p>`);
  out.push("</header>");

  const gaps = [...m.missing, ...m.gaps];
  if (gaps.length) {
    out.push(`<section class="card gaps" id="gaps"><h2>还差这些</h2><ul class="list">${gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></section>`);
  }

  if (m.videos.length) {
    out.push(`<section id="videos"><h2>成片 <span class="muted small">${m.videos.length} 条</span></h2>`);
    /** @type {Record<string, number>} */ const seen = {};
    const labels = m.videos.map((v) => {
      const a = ASPECTS[/** @type {keyof typeof ASPECTS} */ (v.aspect)];
      let l = v.label || (a ? `${a.name} · ${a.hint}` : `${v.w}×${v.h}`);
      seen[l] = (seen[l] || 0) + 1;
      if (seen[l] > 1) l += `（${seen[l]}）`;
      return l;
    });
    const many = m.videos.length > 1;
    if (many) {
      out.push(`<div class="tabs" role="tablist" aria-label="画幅">` + m.videos.map((_, i) =>
        `<button type="button" class="btn tab" role="tab" id="tab-${i}" aria-controls="v-${i}" aria-selected="${i ? "false" : "true"}" tabindex="${i ? -1 : 0}">${esc(labels[i])}</button>`).join("") + "</div>");
    }
    m.videos.forEach((v, i) => {
      const facts = [v.w && v.h ? `${v.w}×${v.h}` : "", v.dur ? `${v.dur.toFixed(1)} 秒` : "", v.file].filter(Boolean).map(esc).join(" · ");
      out.push(`<div${many ? ` role="tabpanel" id="v-${i}" aria-labelledby="tab-${i}"` : ""}${i ? " hidden" : ""}>` +
        `<div class="frame" style="${aspectStyle(v)}"><video src="${href(v.file)}" controls playsinline preload="metadata"></video></div>` +
        `<p class="vmeta">${many ? "" : esc(labels[i]) + " · "}${facts} · <a href="${href(v.file)}" download>下载</a></p></div>`);
    });
    out.push("</section>");
  }

  if (m.images.length) {
    const n = m.images.length;
    out.push(`<section id="images"><h2>图组 <span class="muted small">${n} 张</span></h2>`);
    out.push(`<div class="phone"><div class="track" id="track" tabindex="0" aria-label="图组，左右滑动">` + m.images.map((p, i) =>
      `<figure class="slide" data-note="${esc(p.note)}"><a href="${href(p.file)}" target="_blank" rel="noopener"><img src="${href(p.file)}" alt="第 ${i + 1} 张${p.note ? "：" + esc(p.note) : ""}"${i ? ' loading="lazy"' : ""}></a></figure>`).join("") + "</div></div>");
    if (n > 1) out.push(`<div class="pager"><button type="button" class="btn" data-step="-1">上一张</button><span id="pos">1 / ${n}</span><button type="button" class="btn" data-step="1">下一张</button></div>`);
    out.push(`<p class="capnote" id="capnote">${esc(m.images[0].note)}</p>`);
    if (n > 1) {
      out.push(`<div class="thumbs">` + m.images.map((p, i) =>
        `<button type="button" class="thumb" data-slide="${i}" aria-label="第 ${i + 1} 张" aria-current="${i ? "false" : "true"}"><img src="${href(p.file)}" alt="" loading="lazy"><span>${i + 1}</span></button>`).join("") + "</div>");
    }
    out.push("</section>");
  }

  if (m.covers.length) {
    out.push(`<section id="covers"><h2>封面候选 <span class="muted small">${m.covers.length} 张</span></h2><div class="grid">`);
    m.covers.forEach((c, i) => {
      const tag = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
      out.push(`<figure class="card cover"><a href="${href(c.file)}" target="_blank" rel="noopener"><img src="${href(c.file)}" alt="封面 ${tag}" loading="lazy"></a>` +
        `<figcaption><b>${tag}</b>${esc(c.note)} <a href="${href(c.file)}" download>下载</a></figcaption></figure>`);
    });
    out.push("</div></section>");
  }

  if (m.titles.length) {
    out.push(`<section id="titles"><h2>标题候选</h2><ol class="rows">`);
    m.titles.forEach((t, i) => {
      const n = addCopy(t);
      out.push(`<li class="card row"><span class="idx">${i + 1}</span><p class="t" id="c${n}">${esc(t)}</p><button type="button" class="btn" data-copy="${n}">复制</button></li>`);
    });
    out.push("</ol></section>");
  }

  if (m.platforms.length) {
    out.push(`<section id="platforms"><h2>各平台文案</h2><div class="plats">`);
    for (const p of m.platforms) {
      const tagLine = p.tags.map((t) => "#" + t).join(" ");
      // 复制正文连话题一起：小红书、抖音都是正文末尾带 #话题，分两次粘容易漏
      const nb = addCopy(tagLine ? `${p.body}\n\n${tagLine}` : p.body);
      const nt = p.title ? addCopy(p.title) : -1;
      out.push(`<article class="card plat"><div class="plat-hd"><h3>${esc(p.name)}</h3><div class="acts">` +
        (nt >= 0 ? `<button type="button" class="btn" data-copy="${nt}">复制标题</button>` : "") +
        `<button type="button" class="btn" data-copy="${nb}"${tagLine ? ' title="连话题一起复制"' : ""}>复制正文</button></div></div>` +
        (nt >= 0 ? `<p class="pt" id="c${nt}">${esc(p.title)}</p>` : "") +
        `<div id="c${nb}"><p class="pb">${esc(p.body)}</p>${tagLine ? `<p class="tags">${esc(tagLine)}</p>` : ""}</div></article>`);
    }
    out.push("</div></section>");
  }

  if (m.assumptions.length) {
    out.push(`<section id="assumptions"><h2>替你做的假设</h2><ul class="list">${m.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></section>`);
  }

  out.push(`<footer class="ft"><p>平台要求声明 AI 生成内容的，发布时记得勾选。</p>${m.checks.map((c) => `<p>${esc(c)}</p>`).join("")}</footer>`);

  const copyJson = JSON.stringify(copies).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return "<!doctype html>\n" +
    `<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="owb-delivery" content="1"><title>${esc(m.title)} · 交付</title><style>${CSS}</style></head>\n` +
    `<body><main class="wrap">\n${out.join("\n")}\n</main>\n<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>\n` +
    `<script type="application/json" id="owb-copy">${copyJson}</script>\n<script>${SCRIPT}</script>\n</body></html>\n`;
}

/** @param {Manifest} m @returns {string} */
function countLine(m) {
  return [
    m.videos.length ? `${m.videos.length} 条成片` : "",
    m.images.length ? `${m.images.length} 张图` : "",
    m.covers.length ? `${m.covers.length} 张封面` : "",
    m.titles.length ? `${m.titles.length} 个标题` : "",
    m.platforms.length ? `${m.platforms.length} 个平台` : "",
  ].filter(Boolean).join(" / ");
}

// ───────────────────────── 工具入口 ─────────────────────────

const SCHEMA_HINT =
  '{"title":"…","summary":"…","recipe":"promo-video","videos":[{"aspect":"9:16","file":"成片_9x16.mp4"}],' +
  '"images":[{"file":"卡片_01.png","note":"…"}],"covers":[{"file":"封面_A.png","note":"…"}],"titles":["…","…","…"],' +
  '"platforms":[{"name":"小红书","title":"…","body":"…","tags":["…"]}],"assumptions":["…"],"missing":["…：没做的原因"],"cost":{"text":"…"}}';

/** @param {string} dir @returns {any} */
function readForm(dir) {
  // 只读不修：坏了就当没有。别走 store.readJson——它会把坏文件改名隔离，那是 recipes 自己的文件
  try { return JSON.parse(fs.readFileSync(path.join(dir, FORM_FILE), "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

/**
 * delivery_page 工具：读清单 → 校验 → 量视频 → 出页。有错就一页都不写。
 * @param {{ manifest?: string, out?: string }} input
 * @param {{ dir: string, probe?: Probe, signal?: AbortSignal, now?: Date }} ctx
 * @returns {Promise<{ content: string, isError: boolean }>}
 */
async function runTool(input, ctx) {
  const fail = (/** @type {string} */ s) => ({ content: s, isError: true });
  const dir = ctx && ctx.dir;
  if (!dir) return fail("交付页没有任务目录可写（调用方没给 dir）");
  input = input && typeof input === "object" ? input : {};
  const outName = String(input.out || PAGE_NAME).trim();
  if (!/^[^/\\]+\.html?$/i.test(outName) || outName.startsWith(".")) {
    return fail(`out 只写文件名、以 .html 结尾，比如 ${PAGE_NAME}：页面得和成品在同一个目录，相对路径才对得上`);
  }
  const mr = relPath(input.manifest || MANIFEST_NAME, dir);
  if (mr.err !== undefined) return fail(`manifest ${mr.err}`);
  const mHit = fileInside(dir, mr.rel);
  if (mHit !== true) {
    return fail(typeof mHit === "string" ? mHit : `找不到 ${mr.rel}。先用 write_file 在任务目录里写好清单，再调本工具。格式：\n${SCHEMA_HINT}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, ...mr.rel.split("/")), "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    return fail(`${mr.rel} 不是合法 JSON（${String(e && e.message || e).slice(0, 120)}）。格式：\n${SCHEMA_HINT}`);
  }
  const form = readForm(dir);
  const { m, errors, warnings } = normalize(raw, { dir, form });

  if (!errors.length && m.videos.length) {
    const probe = ctx.probe || defaultProbe;
    /** @type {Set<string>} */ const skips = new Set();
    let checked = 0;
    for (const v of m.videos) {
      if (ctx.signal && ctx.signal.aborted) return fail("已停止，交付页没生成");
      /** @type {ProbeResult} */ let r;
      try {
        r = await probe(path.join(dir, ...v.file.split("/")), { signal: ctx.signal });
      } catch (e) {
        if (e && e.name === "AbortError") return fail("已停止，交付页没生成");
        r = { skip: `量 ${v.file} 出错，没核对画幅：${String(e && e.message || e).slice(0, 120)}` };
      }
      if (r == null) { skips.add("没装 ffprobe，没核对画幅"); continue; }
      if ("bad" in r) { errors.push(`${v.file} ${r.bad}`); continue; }
      if ("skip" in r) { skips.add(r.skip); continue; }
      const w = Math.round(Number(r.w)), h = Math.round(Number(r.h));
      if (!(w > 0 && h > 0)) { errors.push(`${v.file} 读不出画面尺寸（可能只有声音，或文件坏了）`); continue; }
      v.w = w; v.h = h;
      if (Number(r.dur) > 0) v.dur = Number(r.dur);
      checked++;
      if (v.aspect) {
        const a = ASPECTS[/** @type {keyof typeof ASPECTS} */ (v.aspect)];
        if (Math.abs((w / h) / (a.w / a.h) - 1) > ASPECT_TOL) errors.push(`${v.file} 实际是 ${w}×${h}，不是 ${v.aspect}`);
      } else {
        v.aspect = nearestAspect(w, h);
      }
    }
    for (const v of m.videos) {
      if (!v.aspect && !(v.w && v.h)) errors.push(`${v.file} 没写 aspect，也量不了：写上 9:16 / 16:9 / 1:1 / 4:5`);
    }
    for (const s of skips) warnings.push(s);
    if (skips.size) m.checks.push("成片画幅没用 ffprobe 核对过。");
    else if (checked) m.checks.push("成片画幅已用 ffprobe 核对。");
  }
  if (errors.length) {
    return fail(`交付页没生成，清单有 ${errors.length} 处要改（改完再调一次 delivery_page）：\n- ${errors.join("\n- ")}`);
  }
  aspectGaps(m, form, warnings);

  const html = render(m, { now: ctx.now });
  try {
    // 交付物不留 .bak：它会在成果卡里多出一个看不懂的文件
    require("./store").writeTextAtomic(path.join(dir, outName), html, { backup: false });
  } catch (e) {
    return fail(`${outName} 写不进去：${String(e && e.message || e).slice(0, 160)}`);
  }
  const warn = [...new Set(warnings)];
  return {
    content: `已生成 ${outName}（${countLine(m)}）。告诉用户：点成果卡上的「在浏览器打开」看，手机同 Wi-Fi 也能开。` +
      (warn.length ? `\n注意：\n- ${warn.join("\n- ")}` : ""),
    isError: false,
  };
}

const TOOL_DEFS = [
  {
    name: "delivery_page",
    description:
      "把任务目录里的成品收成一页本地交付页（默认 交付.html）：各画幅成片就地播、图组轮播、封面 A/B/C、标题和各平台文案一键复制。" +
      "先 write_file 写好 交付清单.json 再调本工具，格式：" + SCHEMA_HINT + "。" +
      "路径都相对任务目录；只有 title 必填，没有的块整块省掉。成片画幅用 ffprobe 核对，对不上直接报错。" +
      "文件缺了会直说缺哪个，不出页，不拿占位充数；没做出来的写进 missing，页面照实列出来。",
    input_schema: {
      type: "object",
      properties: {
        manifest: { type: "string", description: "清单路径（相对任务目录，默认 交付清单.json）" },
        out: { type: "string", description: "输出文件名（默认 交付.html，只写文件名，和成品放同一目录）" },
      },
      // 两个都可省，但 required 这个键得在：tools.js 把各家 TOOL_DEFS 摊进一张表，
      // 借工具那边（engines/tool-bridge.js）按这张表的类型读 .required，缺了这个键类型检查就红
      required: [],
    },
  },
];

module.exports = {
  MANIFEST_NAME, PAGE_NAME, TOOL_DEFS,
  normalize, render, runTool, defaultProbe,
  _internals: {
    relPath, fileInside, normAspect, nearestAspect, parseProbe, esc, href, countGaps, aspectGaps, readForm,
    ASPECTS, EXPECT, CAP, FORM_FILE, CSS, SCRIPT, SCHEMA_HINT,
  },
};
