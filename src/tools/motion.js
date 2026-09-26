// @ts-check
"use strict";
/**
 * 两个「HTML 当素材」的工具：
 * - render_motion：一个或几个 HTML 动画页 → 一条无声 mp4（执行层是 htmlvideo.js，纯逻辑在 motion-clock.js）；
 * - html_to_image 的批量模式：html_files[] 一次截一组卡片（单张那一路原样交给 media.js 的 htmlToImage）。
 *
 * 这里只做「工具该做的」：参数校验、落盘文件名、回执措辞。凡是能在开浏览器之前查出来的错
 * （路径越界、时长超范围、没有 ffmpeg / libx264、没有浏览器）都在这一层当场回，一帧都不渲——
 * 否则模型要白等几分钟才知道白干了。
 *
 * 不 require tools.js（那边 require 这里，绕成环就拿到半截的 exports）；工作目录经参数传进来。
 * render_motion 不调任何收费接口：浏览器和 ffmpeg 都在本机。
 */
const fs = require("fs");
const path = require("path");
const M = require("../../motion-clock");
const media = require("./media");
const security = require("../../security");

// 一次最多 30 个 HTML：小红书一组卡最多 18 张，分镜片头一般十来段，再多就该拆开
const MAX_FILES = 30;
const STOPPED = "用户已停止任务：视频没渲完，半截文件已删";

/** @param {string} content */
const fail = (content) => ({ content, isError: true });

/** 回执里的落点：说准它在哪个子目录，模型才不会去工作空间根目录找、找不到再 cp 一份 */
function where(saveDir, fname) {
  try { return media.savedAt(saveDir, fname); } catch { return fname; }
}

/** 秒数去掉多余的小数：1.2000000000000002 → 1.2 */
const secs = (n) => String(Math.round(Number(n) * 100) / 100);

/**
 * 把 html_files / html_file 收成 [{ rel, abs }]。路径一律经 resolveFile：越出工作空间的当场拒。
 * @param {any} input
 * @param {(rel: string) => string} resolveFile
 * @returns {{ list: Array<{ rel: string, abs: string }>, error?: undefined } | { error: string, list?: undefined }}
 */
function pickHtml(input, resolveFile) {
  const raw = Array.isArray(input.html_files) && input.html_files.length ? input.html_files
    : input.html_file ? [input.html_file] : [];
  if (!raw.length) return { error: "缺少 html_file / html_files（工作空间里的 HTML 文件路径）" };
  if (raw.length > MAX_FILES) return { error: `一次最多 ${MAX_FILES} 个 HTML，这次给了 ${raw.length} 个：拆成几次` };
  const list = [];
  for (const r of raw) {
    const rel = String(r == null ? "" : r).trim();
    if (!rel) return { error: "html_files 里有空路径" };
    if (!/\.html?$/i.test(rel)) return { error: `只能渲 .html 文件：${rel}` };
    let abs;
    try { abs = resolveFile(rel); } catch (e) { return { error: e && e.message ? e.message : String(e) }; }
    if (!fs.existsSync(abs)) return { error: `文件不存在：${rel}（先用 write_file 把 HTML 写进工作空间）` };
    list.push({ rel, abs });
  }
  return { list };
}

/**
 * render_motion。ctx：
 * - signal：停止；onProgress：contracts A 的进度事件（节流在执行层做）；deadline：这次调用的截止时间戳；
 * - deps：测试注入 { available, prepareFfmpeg, render }，默认就是 htmlvideo.js 的那三个。
 * @param {any} input
 * @param {(rel: string) => string} resolveFile
 * @param {string} saveDir
 * @param {{ signal?: AbortSignal|null, onProgress?: (p: any) => void, deadline?: number, deps?: any }} [ctx]
 */
async function renderMotionTool(input, resolveFile, saveDir, ctx = {}) {
  input = input || {};
  const deps = ctx.deps || {};
  const hv = () => require("../../htmlvideo");
  const available = deps.available || (() => hv().available());
  const prepareFfmpeg = deps.prepareFfmpeg || ((bin, o) => hv().prepareFfmpeg(bin, o));
  const render = deps.render || ((files, o) => hv().renderMotion(files, o));

  const got = pickHtml(input, resolveFile);
  if (got.error) return fail(got.error);
  const list = got.list || [];
  const n = list.length;

  // 时长：durations 和文件一一对应；只给一个 duration 就每段都用它；都不给由页面自己说（<body data-duration>）
  /** @type {Array<number|null>} */
  let durs = list.map(() => null);
  if (Array.isArray(input.durations) && input.durations.length) {
    if (input.durations.length !== n) {
      return fail(`durations 给了 ${input.durations.length} 个，HTML 有 ${n} 个：要一一对应（不给就读各页的 <body data-duration>）`);
    }
    durs = input.durations.map((d) => (d == null || d === "" ? null : Number(d)));
  } else if (input.duration != null && input.duration !== "") {
    durs = list.map(() => Number(input.duration));
  }
  try {
    durs.forEach((d, i) => { if (d != null) M.checkDuration(d, list[i].rel); });
  } catch (e) { return fail(e.message); }

  let size;
  try { size = M.resolveSize({ aspect: input.aspect, width: input.width, height: input.height }); } catch (e) { return fail(e.message); }
  const fps = M.clampFps(input.fps);
  if (durs.every((d) => d != null)) {
    try { M.planShots(/** @type {number[]} */ (durs), fps); } catch (e) { return fail(e.message); }
  }

  const av = available();
  if (!av || !av.ok) return fail((av && av.why) || "出视频要内置浏览器或本机 Chrome，这台机器两样都没有");
  let ff;
  try { ff = await prepareFfmpeg(undefined, { signal: ctx.signal || null }); } catch (e) {
    if ((e && e.stopped) || (ctx.signal && ctx.signal.aborted)) return { content: STOPPED, isError: true, stopped: true };
    return fail(e && e.message ? e.message : String(e));
  }
  if (!ff || !ff.ok) return fail((ff && ff.why) || M.noFfmpegMessage(""));

  // 只出 H.264：.webm/.m4v 这类名字改成 .mp4，.mov 保留（同一套编码，容器换个壳）
  let fname = media.safeOutName(input.filename, ".mp4", "motion");
  let renamed = "";
  if (!/\.(mp4|mov)$/i.test(fname)) {
    const fixed = fname.replace(/\.[^.]*$/, "") + ".mp4";
    renamed = `文件名改成了 ${fixed}：这里只出 H.264 的 mp4`;
    fname = fixed;
  }
  const dir = saveDir || path.dirname(list[0].abs);
  const out = path.join(dir, fname);
  const stem = fname.replace(/\.[^.]*$/, "");
  const stillsN = input.stills == null || input.stills === "" ? 1 : Math.max(0, Math.min(3, Math.floor(Number(input.stills) || 0)));

  let r;
  try {
    r = await render(list.map((f, i) => ({ path: f.abs, duration: durs[i] == null ? undefined : durs[i], name: f.rel })), {
      width: size.width, height: size.height, fps,
      seed: input.seed == null || input.seed === "" ? undefined : Number(input.seed),
      out, signal: ctx.signal || null, deadline: ctx.deadline, stills: stillsN, onProgress: ctx.onProgress,
    });
  } catch (e) {
    if ((e && e.stopped) || (ctx.signal && ctx.signal.aborted)) return { content: STOPPED, isError: true, stopped: true };
    return fail(`HTML 动画出片失败：${e && e.message ? e.message : e}`);
  }

  // 静帧：第一张是封面（data-poster，没写就取 40% 处），给模型 look_at_image 自查用
  /** @type {Array<{ name: string, frame: number }>} */
  const stills = [];
  for (const [k, s] of (r.stills || []).entries()) {
    const name = k === 0 ? `${stem}_poster.png` : `${stem}_still${k + 1}.png`;
    try { fs.writeFileSync(path.join(dir, name), s.png); stills.push({ name, frame: s.frame }); } catch { /* 静帧落不了盘不影响成片 */ }
  }
  security.audit("HTML动画", `${list.map((f) => f.rel).join("、")} → ${fname}`, "放行");

  const lines = [`已把 ${n} 个 HTML 渲成视频：${where(saveDir, fname)}（${r.width}x${r.height}，${r.fps} 帧/秒，${secs(r.duration)} 秒，${r.frames} 帧）`];
  if (n > 1) lines.push(`各段起点：${(r.segments || []).map((s, i) => `${list[i].rel} ${secs(s.start)}s`).join("，")}`);
  if (stills.length) {
    const more = stills.slice(1).map((s) => where(saveDir, s.name));
    lines.push(`封面：${where(saveDir, stills[0].name)}（第 ${stills[0].frame + 1} 帧）${more.length ? `，另有 ${more.join("、")}` : ""}。交付前用 look_at_image 看一眼`);
  }
  for (const w of [renamed, ...(r.warnings || [])]) if (w) lines.push(`注意：${w}`);
  return {
    content: lines.join("\n"),
    isError: false,
    file: fname,
    files: [fname, ...stills.map((s) => s.name)],
    meta: {
      width: r.width, height: r.height, fps: r.fps, frames: r.frames, duration: r.duration,
      segments: r.segments, distinctFrames: r.distinctFrames, backend: r.backend,
      stills: stills.map((s) => ({ file: s.name, frame: s.frame })),
    },
  };
}

/**
 * 批量出的每张 PNG 是哪个 HTML 截的（落盘目录 + 小写文件名 → HTML 绝对路径）。没给 filename 时名字是替模型起的：
 * 同一个 HTML 重截照旧覆盖（改完卡片重出一张是常事），别的文件夹里同名的 HTML 就往后接 _2，不把前一批的图悄悄盖掉。
 * 只记在内存里：重启后不知道来历，退回照名字写，回执里说清盖了哪几张
 * @type {Map<string, string>}
 */
const shotFrom = new Map();
const SHOT_FROM_MAX = 5000;

/**
 * html_to_image：单张（html_file）原样走 media.htmlToImage，只补 file / files 两个字段；
 * 批量（html_files[]）一张张串行截：离屏窗口同时开一堆会吃爆内存，htmlshot 本来也是串行队列。
 * 批量时一张失败不拖累别的，全部失败才算这次调用出错。文件名跟 HTML 走（01.html → 01.png），
 * 给了 filename 就当前缀（xhs → xhs_01.png、xhs_02.png），同名的往后接 _2。
 * @param {any} input
 * @param {(rel: string) => string} resolveFile
 * @param {string} saveDir
 * @param {{ signal?: AbortSignal|null, onProgress?: (p: any) => void }} [ctx]
 */
async function htmlToImageBatch(input, resolveFile, saveDir, ctx = {}) {
  input = input || {};
  const many = Array.isArray(input.html_files) && input.html_files.length ? input.html_files : null;
  if (!many) {
    const fname = media.safeOutName(input.filename, ".png", "card");
    const r = await media.htmlToImage({ ...input, filename: fname }, resolveFile, saveDir);
    return r && !r.isError ? { ...r, file: fname, files: [fname] } : r;
  }
  if (many.length > MAX_FILES) return fail(`一次最多 ${MAX_FILES} 个 HTML，这次给了 ${many.length} 个：拆成几次`);
  const rels = many.map((x) => String(x == null ? "" : x).trim());
  if (rels.some((x) => !x)) return fail("html_files 里有空路径");

  const stem = input.filename ? String(input.filename).trim().replace(/\.[^./\\]*$/, "").replace(/[\/\\:*?"<>|]/g, "_") : "";
  const outKey = (/** @type {string} */ n) => path.resolve(saveDir) + "\0" + n.toLowerCase();
  const srcOf = rels.map((rel) => { try { return path.resolve(resolveFile(rel)); } catch { return rel; } });
  const onDisk = (/** @type {string} */ n) => fs.existsSync(path.join(saveDir, n));
  const used = new Set();
  const names = rels.map((rel, i) => {
    const base = stem ? `${stem}_${String(i + 1).padStart(2, "0")}` : path.basename(rel).replace(/\.[^.]*$/, "").replace(/[\/\\:*?"<>|]/g, "_") || `card_${i + 1}`;
    let name = `${base}.png`;
    const from = (/** @type {string} */ n) => shotFrom.get(outKey(n));
    const taken = (/** @type {string} */ n) => used.has(n.toLowerCase()) || (!stem && from(n) !== undefined && from(n) !== srcOf[i] && onDisk(n));
    for (let k = 2; taken(name); k++) name = `${base}_${k}.png`;
    used.add(name.toLowerCase());
    return name;
  });
  // 盘上已有、又不知道是这个 HTML 截的（来历不明或别的 HTML），截成了就是盖掉了别人的图：回执里得说
  const clobbers = names.map((n, i) => onDisk(n) && shotFrom.get(outKey(n)) !== srcOf[i]);
  /** @type {string[]} */
  const overwrote = [];

  const total = rels.length;
  const emit = M.progressThrottle(ctx.onProgress);
  const say = (done) => emit({ stage: "shot", done, total, pct: Math.floor((done * 100) / total), label: `截图 ${done}/${total} 张` });
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const failed = [];
  let stopped = false;
  for (let i = 0; i < total; i++) {
    if (ctx.signal && ctx.signal.aborted) { stopped = true; break; }
    say(i);
    const one = { ...input, html_file: rels[i], filename: names[i] };
    delete one.html_files;
    let r;
    try { r = await media.htmlToImage(one, resolveFile, saveDir); } catch (e) { r = fail(e && e.message ? e.message : String(e)); }
    if (r && !r.isError) {
      files.push(names[i]);
      if (clobbers[i]) overwrote.push(names[i]);
      shotFrom.delete(outKey(names[i]));
      shotFrom.set(outKey(names[i]), srcOf[i]);
      if (shotFrom.size > SHOT_FROM_MAX) shotFrom.delete(/** @type {string} */ (shotFrom.keys().next().value));
    } else failed.push(`${rels[i]}（${String((r && r.content) || "没出图").slice(0, 120)}）`);
  }
  if (!stopped) say(total);

  const size = `${input.width || 1242}x${input.full_page ? "整页" : input.height || 1656}`;
  const lines = [];
  if (files.length) lines.push(`${files.length} 张出好了（${size}）：${files.map((f) => where(saveDir, f)).join("、")}`);
  if (overwrote.length) lines.push(`覆盖了已有的：${overwrote.join("、")}（要留旧图就给 filename 当前缀）`);
  if (failed.length) lines.push(`${failed.length} 张没成：${failed.join("；")}`);
  if (stopped) {
    lines.push(`用户已停止任务：还有 ${total - files.length - failed.length} 张没截`);
    return { content: lines.join("\n"), isError: true, stopped: true, file: files[0], files, failed };
  }
  // 审计不用再记：media.htmlToImage 每出一张已经记过一条
  return { content: lines.join("\n"), isError: files.length === 0, file: files[0], files, failed };
}

module.exports = { renderMotionTool, htmlToImageBatch, pickHtml, MAX_FILES };
