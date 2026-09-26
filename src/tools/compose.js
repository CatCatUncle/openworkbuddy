// @ts-check
"use strict";
/**
 * compose_video：按时间轴把画面、配音、配乐拼成多尺寸成片，附字幕、封面和一份清单。
 *
 * 这一步从来不花钱：不调模型、不调配音，只用本机 ffmpeg 拼盘上已有的文件（片头片尾卡、HTML 段
 * 再借一下本机浏览器）。所以这里没有额度闸门，也没有「上游收了单」这回事——挂了放心再跑一次。
 *
 * 分工：排片（时长、命令、字幕文本）在 lib/timeline-compose.js，纯函数；真跑在 lib/compose-jobs.js，
 * 跟画布一键合成共用一把锁。这里只做工具这一层：读时间轴、按安全策略把每个路径认一遍、探时长、
 * 开跑、等一会儿、把结果说成人话。
 *
 * 为什么是「开跑 + 任务号」而不是死等：四个画幅各三十秒，慢机器上要好几分钟，工具调用不能一直挂着。
 * 等得到就当场交结果；等不到交任务号，模型拿 {"job": …} 再来查。
 */

const fs = require("fs");
const path = require("path");
const TC = require("../../lib/timeline-compose");
const jobs = require("../../lib/compose-jobs");
const M = require("../../motion-clock");

/** @typedef {import("../../types/timeline").ComposeVideoInput} ComposeVideoInput */
/** @typedef {import("../../types/timeline").ComposeJobView} ComposeJobView */
/** @typedef {import("../../types/timeline").TimelineStep} TimelineStep */
/** @typedef {import("../../types/timeline").TimelinePlanOk} TimelinePlanOk */
/** @typedef {import("../../types/timeline").TimelineBlocker} TimelineBlocker */
/** @typedef {{content: string, isError: boolean, stopped?: boolean}} ToolResult */
/**
 * @typedef {{
 *   resolveFile: (rel: string) => string,
 *   fileBase: string,
 *   opts?: any,
 *   security?: any,
 *   sec?: any,
 *   passGate?: (verdict: any, label: string, text: string, o?: {force?: boolean, detail?: string}) => Promise<any>,
 *   root?: string,
 *   deps?: {
 *     bins?: () => Promise<any>,
 *     canRender?: () => {ok: boolean, why?: string},
 *     render?: (step: TimelineStep, signal: AbortSignal, onFrac: (f: number) => void, env: {cwd: string, bins: any}) => Promise<void>,
 *     brandKit?: any,
 *   },
 * }} ComposeCtx
 */

const NOT_FOUND = "没找到这条合成（不是这个对话起的，或者服务重启过）";
/** 叫停之后等它收拾半截文件的上限：ffmpeg 收到 TERM 一般一两秒就退，渲染那条要等浏览器关掉 */
const CANCEL_SETTLE_MS = 8000;
/** 离对话截止还剩这么多就不等了，交任务号：留给模型把话说完 */
const DEADLINE_SLACK_MS = 15000;

/**
 * 任务 id → 这会儿谁在听进度。
 * 进度回调是开跑那一刻交给任务的，可工具调用可能先返回（交了任务号），之后模型用 job 再来查——
 * 那时要把进度接到「这一次」调用上，不能还往已经结束的那次调用里报
 * @type {Map<string, {fn: ((ev: any) => void) | null}>}
 */
const taps = new Map();

/** @param {string} content @param {boolean} [isError] @returns {ToolResult} */
function out(content, isError = false) { return { content, isError }; }

/** @param {unknown} v */
function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

/** @param {string} abs */
function isFile(abs) { try { return fs.statSync(abs).isFile(); } catch { return false; } }

/**
 * 两个停止信号（用户点停、整轮超时）并成一个，给 timelineWait 用
 * @param {any} opts
 */
function stopSignal(opts) {
  const ac = new AbortController();
  const sigs = [opts && opts.signal, opts && opts.stopSignal].filter((s) => s && typeof s.addEventListener === "function");
  const h = () => { try { ac.abort(); } catch {} };
  for (const s of sigs) { if (s.aborted) h(); else s.addEventListener("abort", h, { once: true }); }
  return { signal: ac.signal, release: () => { for (const s of sigs) { try { s.removeEventListener("abort", h); } catch {} } } };
}

/**
 * 这次调用最多能等多久：想等 want 毫秒，但不越过对话的截止时间
 * @param {any} opts @param {number} want
 */
function waitBudget(opts, want) {
  const dl = Number(opts && opts.deadline) || 0;
  const cap = dl > 0 ? dl - Date.now() - DEADLINE_SLACK_MS : want;
  return Math.max(0, Math.min(want, cap));
}

/**
 * 时间轴从哪来：直接给的对象、一段 JSON 文本，或者工作区里一个文件的路径
 * @param {unknown} raw @param {(rel: string) => string} resolveFile
 * @returns {{tl?: any, from?: string, error?: string}}
 */
function readTimeline(raw, resolveFile) {
  if (isObj(raw)) return { tl: raw, from: "" };
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { error: "没给时间轴：timeline 写 timeline.json 的路径，或者直接写 JSON（{\"segments\": [...]}）" };
  if (s.startsWith("{")) {
    try { return { tl: JSON.parse(s), from: "" }; } catch (e) { return { error: `timeline 不是合法的 JSON：${e.message}` }; }
  }
  let abs = "";
  try { abs = resolveFile(s); } catch (e) { return { error: e.message }; }
  let text = "";
  try { text = fs.readFileSync(abs, "utf8"); } catch (e) {
    return { error: e && e.code === "ENOENT" ? `找不到时间轴文件 ${s}` : `读不了时间轴文件 ${s}：${e.message}` };
  }
  try { return { tl: JSON.parse(text.replace(/^﻿/, "")), from: s }; } catch (e) { return { error: `${s} 不是合法的 JSON：${e.message}` }; }
}

/**
 * 时间轴里每一个文件路径过一遍 fn（深拷贝，不改原件）。
 * 字符串写法的画面顺手摊成 {file}：collectFiles 只认对象写法，不摊的话 "a.mp4" 这种视频段探不到时长
 * @param {any} raw @param {(ref: string) => string} fn
 */
function mapRefs(raw, fn) {
  /** @type {any} */
  const tl = JSON.parse(JSON.stringify(raw));
  if (!isObj(tl)) return tl;
  /** @param {any} o @param {string} k */
  const set = (o, k) => { if (typeof o[k] === "string" && o[k].trim()) o[k] = fn(o[k]); };
  for (const s of Array.isArray(tl.segments) ? tl.segments : []) {
    if (!isObj(s)) continue;
    if (typeof s.visual === "string") s.visual = s.visual.trim() ? { file: fn(s.visual) } : s.visual;
    else if (isObj(s.visual)) {
      set(s.visual, "file");
      if (isObj(s.visual.by_aspect)) for (const k of Object.keys(s.visual.by_aspect)) set(s.visual.by_aspect, k);
    }
    if (typeof s.voice === "string") set(s, "voice");
    else if (isObj(s.voice)) {
      set(s.voice, "file");
      if (Array.isArray(s.voice.sentences)) for (const x of s.voice.sentences) if (isObj(x)) set(x, "file");
    }
  }
  if (typeof tl.music === "string") set(tl, "music");
  else if (isObj(tl.music)) set(tl.music, "file");
  if (isObj(tl.brand)) { set(tl.brand, "logo"); set(tl.brand, "font"); }
  return tl;
}

/**
 * 把模型写的路径按安全策略认一遍（跟 read_file 同一个 resolveFile：黑名单硬拦、成果子目录里没有就找工作区根），
 * 再换成相对成片目录的写法。ffmpeg 就在那个目录里跑，相对路径也不会把本机的绝对路径写进清单
 * @param {(rel: string) => string} resolveFile @param {string} cwd
 */
function makeResolver(resolveFile, cwd) {
  /** @type {Map<string, string>} */
  const cache = new Map();
  /** @type {TimelineBlocker[]} */
  const blockers = [];
  /** @param {string} ref */
  const fn = (ref) => {
    const rel0 = TC.normRel(ref);
    if (cache.has(rel0)) return /** @type {string} */ (cache.get(rel0));
    let rel = rel0;
    try {
      const abs = resolveFile(rel0);
      const r = path.relative(cwd, abs);
      // 另一个盘（Windows）上的文件 relative 给不出来，就交绝对路径
      rel = (path.isAbsolute(r) ? abs : r).split(path.sep).join("/");
    } catch (e) {
      blockers.push({ what: `文件 ${rel0}`, why: String((e && e.message) || e), fix: "换一个工作区里的文件" });
    }
    cache.set(rel0, rel);
    return rel;
  };
  return { fn, blockers };
}

/**
 * 探时长。四个一批并发：几十个配音文件挨个探是好几秒，一次全开又会一下子起几十个 ffprobe
 * @param {string} bin @param {string} cwd @param {string[]} rels
 */
async function probeAll(bin, cwd, rels) {
  /** @type {Record<string, any>} */
  const probes = {};
  const list = [...new Set(rels)].filter((r) => isFile(path.resolve(cwd, r)));
  for (let i = 0; i < list.length; i += 4) {
    const chunk = list.slice(i, i + 4);
    const got = await Promise.all(chunk.map((rel) => jobs.composeProbe(bin, cwd, TC.ffPath(rel))));
    chunk.forEach((rel, k) => { if (got[k]) probes[rel] = got[k]; });
  }
  return probes;
}

/** Linux 上有没有中文字体（没有的话烧进去的字幕是方块）。别的平台都自带，不查；fc-list 不在就说不知道 */
function hasCjkFonts() {
  if (process.platform !== "linux") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    require("child_process").execFile("fc-list", [":lang=zh", "family"], { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? undefined : String(stdout || "").trim().length > 0);
    });
  });
}

/** 这里能不能把 HTML 画成画面。片头片尾卡（截图）和 HTML 段（录成视频）用的是同一个浏览器 */
function renderAvailable() {
  try {
    const a = require("../../htmlvideo").available();
    return { ok: !!a.ok, why: a.why || "" };
  } catch (e) {
    return { ok: false, why: "渲染模块没加载起来：" + String((e && e.message) || e) };
  }
}

/**
 * 品牌包（brand_kit 建的）→ 排片要的那几样。档案认项目根，跟 brand_kit 工具同一个口径
 * @param {string} slug @param {string} root @param {any} bk
 * @returns {{brandKit: boolean, brand?: any, missing: string[]}}
 */
function brandFromKit(slug, root, bk) {
  let list = [];
  try { list = bk.loadAll({ cwd: root }).list || []; } catch {}
  if (!list.length) return { brandKit: false, missing: [] };
  let entry = null;
  try { entry = bk.get(slug, { cwd: root }); } catch {}
  if (!entry) return { brandKit: true, brand: null, missing: [] };
  const paths = bk.assetPaths(entry) || {};
  return { brandKit: true, brand: TC.brandFacts(entry, paths), missing: paths.missing || [] };
}

/** @param {number} b */
function fmtBytes(b) { return b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }

/** @param {TimelineBlocker[]} blockers @param {string[]} warnings */
function blockedText(blockers, warnings) {
  // 界面上那行红字只取第一行（agent.js 的 resultOutcome）：头一条卡点得直接写在第一行，
  // 只写「还不能合成：」的话，用户得点开卡片才知道卡在哪
  const one = (/** @type {{what: string, why: string, fix: string}} */ b) => `${b.what}：${b.why} → ${b.fix}`;
  const [b0, ...rest] = blockers;
  const lines = [b0 ? `还不能合成：${one(b0)}${rest.length ? `（还有 ${rest.length} 处，见下）` : ""}` : "还不能合成"];
  lines.push(...rest.map((b) => `- ${one(b)}`));
  if (warnings.length) lines.push("另外：", ...warnings.map((w) => `- ${w}`));
  return lines.join("\n");
}

/** @param {any} plan */
function planSummary(plan) {
  return {
    ok: true, dry_run: true, title: plan.title, duration: TC.round(plan.T, 3), fps: plan.fps, frames: plan.frames,
    out_dir: plan.outDir,
    films: plan.aspects.map((/** @type {any} */ a) => ({ aspect: a.aspect, label: a.label, w: a.w, h: a.h, file: a.file, subtitles_burned: !!a.burned, covers: (a.covers || []).length })),
    segments: (plan.segments || []).length,
    subtitles: plan.srt || null,
    manifest: plan.manifest,
    steps: plan.steps.length,
    eta_seconds: Math.max(1, Math.round((plan.etaMs || 0) / 1000)),
    costs_money: false,
    warnings: plan.warnings,
  };
}

/**
 * 一条任务说成给模型看的话
 * @param {ComposeJobView | null} view @param {string} [prefix]
 * @returns {ToolResult}
 */
function describe(view, prefix = "") {
  if (!view) return out(NOT_FOUND, true);
  const pre = prefix ? prefix + "\n" : "";
  if (!view.done) {
    const step = view.steps[view.at - 1];
    return out(`${pre}还在跑（任务 ${view.id}）：第 ${view.at}/${view.total} 步「${step ? step.label : "准备"}」，大约 ${view.pct || 0}%。`
      + `过一会儿用 {"job": "${view.id}"} 再查；要停就 {"job": "${view.id}", "cancel": true}。`);
  }
  const films = view.films || [];
  const log = (view.log || []).slice(-3).map((l) => `- ${l}`);
  if (view.error) {
    // 叫停是模型或用户自己要的，不算出错；别的失败把 ffmpeg 原话的尾巴带上
    if (view.canceled) return out([`${pre}这条合成叫停了：${view.error}`, ...log].join("\n"));
    return out([`${pre}合成没成：${view.error}`, ...log].join("\n"), true);
  }
  const lines = [`${pre}成片出来了，${films.length} 条：`];
  for (const f of films) lines.push(`- ${f.label} ${f.w}×${f.h}，${TC.round(f.duration, 2)} 秒，${fmtBytes(f.bytes)}：${f.file}`);
  if (view.subtitleFile) {
    const how = films.length && films.every((f) => f.burned) ? "已烧进画面，文件另附一份"
      : films.some((f) => f.burned) ? "部分画幅烧进了画面，文件另附" : "没烧进画面，文件另附，导进剪映就能用";
    lines.push(`字幕：${view.subtitleFile}（${how}）`);
  }
  const covers = view.covers || [];
  if (covers.length) lines.push(`封面：${covers.length} 张，${covers.slice(0, 3).join("、")}${covers.length > 3 ? " 等" : ""}`);
  if (view.manifest) lines.push(`清单：${view.manifest}`);
  const warnings = view.warnings || [];
  if (warnings.length) lines.push("注意：", ...warnings.map((w) => `- ${w}`));
  if (log.length && films.length) lines.push(...log.filter((l) => !warnings.some((w) => l.includes(w))));
  lines.push("没花钱：只用本机 ffmpeg 拼了盘上已有的文件。");
  return out(lines.join("\n"));
}

/**
 * 等一条跑完（最多 ms），期间把进度接到这一次调用上。用户点了停就叫停它
 * @param {string} id @param {string} owner @param {number} ms @param {any} opts
 * @returns {Promise<ToolResult | null>} null = 等到了（或者到点了），由调用方 describe
 */
async function waitFor(id, owner, ms, opts) {
  const tap = taps.get(id);
  const emit = M.progressThrottle(opts && opts.onProgress);
  if (tap) tap.fn = emit;
  const stop = stopSignal(opts);
  try {
    const finished = await jobs.timelineWait(id, ms, { signal: stop.signal });
    if (!finished && stop.signal.aborted) {
      jobs.timelineCancel(id, owner);
      await jobs.timelineWait(id, CANCEL_SETTLE_MS);
      return { content: "用户已停止任务，这一步没做完。合成已叫停，没出完的半截删掉了。", isError: true, stopped: true };
    }
    return null;
  } finally {
    stop.release();
    if (tap && tap.fn === emit) tap.fn = null;
  }
}

/**
 * compose_video 的入口
 * @param {ComposeVideoInput} input
 * @param {ComposeCtx} ctx
 * @returns {Promise<ToolResult>}
 */
async function composeVideo(input, ctx) {
  const inp = /** @type {any} */ (input || {});
  const { resolveFile, fileBase, security, passGate } = ctx;
  const opts = ctx.opts || {};
  const deps = ctx.deps || {};
  const owner = String(opts.sessionId || "");
  const jobId = typeof inp.job === "string" ? inp.job.trim() : "";

  // ── 查 / 停一条已经开跑的
  if (jobId || inp.cancel === true) {
    let id = jobId;
    if (!id) {
      const running = jobs.timelineRunning(owner);
      if (!running) return out("这个对话眼下没有在跑的合成，不用停");
      id = running.id;
    }
    const before = jobs.timelineGet(id, owner);
    if (!before) return out(NOT_FOUND, true);
    if (inp.cancel === true) {
      if (before.done) return describe(before, "这条已经跑完了，没什么可停的：");
      jobs.timelineCancel(id, owner);
      await jobs.timelineWait(id, CANCEL_SETTLE_MS);
      return describe(jobs.timelineGet(id, owner));
    }
    if (!before.done) {
      const stopped = await waitFor(id, owner, waitBudget(opts, 60000), opts);
      if (stopped) return stopped;
    }
    return describe(jobs.timelineGet(id, owner));
  }

  // ── 读时间轴、认路径
  const got = readTimeline(inp.timeline, resolveFile);
  if (got.error) return out(got.error, true);
  const raw = got.tl;
  const cwd = path.resolve(fileBase);
  const res = makeResolver(resolveFile, cwd);
  const mapped = mapRefs(raw, res.fn);
  if (res.blockers.length) return out(blockedText(res.blockers, []), true);

  // 成片目录：只许写在成果目录里面。路径也过一遍安全策略（黑名单里的目录不往里写）
  const title = isObj(raw) && (typeof raw.title === "string" || typeof raw.title === "number") ? String(raw.title).trim() : "";
  const rawOut = isObj(raw) && typeof raw.out_dir === "string" ? TC.normRel(raw.out_dir).replace(/\/+$/, "") : "";
  if (rawOut && (path.isAbsolute(rawOut) || /^[A-Za-z]:/.test(rawOut) || rawOut.split("/").includes(".."))) {
    return out(`out_dir 要写成果目录里的相对路径，不许绝对路径，也不许 ..：${rawOut}`, true);
  }
  const outDir0 = rawOut || `成片/${TC.safeName(title || "成片", "成片")}`;
  let outAbs = "";
  try { outAbs = resolveFile(outDir0); } catch (e) { return out(String((e && e.message) || e), true); }
  const outRel = path.relative(cwd, outAbs).split(path.sep).join("/");
  if (!outRel || outRel.startsWith("..") || path.isAbsolute(outRel)) return out(`out_dir 要写成果目录下面的一个子目录：${outDir0}`, true);
  if (rawOut && outRel !== rawOut) mapped.out_dir = outRel;

  // ── 探外部事实
  const bins = await (deps.bins || jobs.composeBins)();
  /** @type {string[]} */
  const warnings = [];
  /** @type {any} */
  const facts = { bins, platform: process.platform };
  facts.exists = (/** @type {string} */ rel) => isFile(path.resolve(cwd, rel));
  facts.canRender = deps.canRender ? deps.canRender() : renderAvailable();
  const files = TC.collectFiles(mapped);
  facts.probes = await probeAll(bins.ffprobe, cwd, files.filter((f) => f.role === "voice" || f.role === "music" || (f.role === "visual" && TC.VIDEO_EXT.test(f.rel))).map((f) => f.rel));
  facts.cjkFonts = await hasCjkFonts();

  // 品牌：名字 → 品牌包；对象 → 直接写的 logo / 字体
  let logoFile = "", fontFile = "";
  if (typeof mapped.brand === "string" && mapped.brand.trim()) {
    const kit = brandFromKit(mapped.brand.trim(), ctx.root || cwd, deps.brandKit || require("../../brand-kit"));
    facts.brandKit = kit.brandKit;
    if (kit.brand !== undefined) facts.brand = kit.brand;
    if (kit.missing.length) warnings.push(`品牌包里这几个文件不在了，没用上：${kit.missing.join("、")}`);
    if (kit.brand) { logoFile = kit.brand.logo || ""; fontFile = (kit.brand.font && kit.brand.font.file) || ""; }
  } else if (isObj(mapped.brand)) {
    logoFile = typeof mapped.brand.logo === "string" ? mapped.brand.logo : "";
    fontFile = typeof mapped.brand.font === "string" ? mapped.brand.font : "";
  }
  if (fontFile) {
    let family = "";
    try { family = require("../../lib/font-family").readFontFamily(path.resolve(cwd, fontFile)); } catch {}
    facts.font = { file: fontFile, family };
  }
  // SVG 角标 ffmpeg 多半解不了（要 librsvg），硬贴就是最后一步才挂。只关角标：卡片是浏览器画的，SVG 照样上
  if (/\.svg$/i.test(logoFile) && mapped.logo !== false) {
    mapped.logo = false;
    warnings.push("logo 是 SVG，画面角上贴不了，这次不加角标");
  }

  // 已经在盘上的名字：排片挑一个不撞的，一个都不覆盖
  /** @param {string} dirRel */
  const namesIn = (dirRel) => { try { return new Set(fs.readdirSync(path.resolve(cwd, dirRel))); } catch { return new Set(); } };
  facts.onDisk = namesIn(outRel);
  /** @type {any} */
  let plan = TC.timelinePlan(mapped, facts);
  if (plan.ok && plan.outDir !== outRel) { facts.onDisk = namesIn(plan.outDir); plan = TC.timelinePlan(mapped, facts); }
  const allWarnings = [...warnings, ...(plan.warnings || []).filter((/** @type {string} */ w) => !warnings.includes(w))];
  if (!plan.ok) return out(blockedText(plan.blockers, allWarnings), true);
  plan.warnings = allWarnings;

  if (inp.dry_run === true) return out("排好了，没开跑（dry_run）：\n" + JSON.stringify(planSummary(plan), null, 2));

  // ── 写盘前过一道权限档位（只看不动 / 每步都问），跟 write_file 同一扇门
  if (security && typeof security.checkWrite === "function" && typeof passGate === "function") {
    const sec = ctx.sec || opts.security || { ...(security.DEFAULTS || {}) };
    const detail = `会写：${plan.aspects.map((/** @type {any} */ a) => a.file).join("、")}${plan.srt ? `、${plan.srt}` : ""}、${plan.manifest}`;
    const blocked = await passGate(security.checkWrite(sec, plan.outDir), "写成片", plan.outDir, { force: true, detail });
    if (blocked) return blocked;
  }

  // ── 开跑
  const emit = M.progressThrottle(opts.onProgress);
  const tap = { fn: /** @type {((ev: any) => void) | null} */ (emit) };
  /** @param {TimelineStep} step @param {AbortSignal} signal @param {(f: number) => void} onFrac */
  const render = async (step, signal, onFrac) => {
    if (deps.render) return deps.render(step, signal, onFrac, { cwd, bins });
    const r = /** @type {NonNullable<TimelineStep["render"]>} */ (step.render);
    const inside = (/** @type {string} */ rel) => {
      const abs = path.resolve(cwd, rel), x = path.relative(cwd, abs);
      if (!x || x.startsWith("..") || path.isAbsolute(x)) throw new Error(`${rel} 在成果目录外面，不往那儿写`);
      return abs;
    };
    if (r.what === "card") {
      const buf = await require("../../htmlshot").renderHtmlToPngAny(inside(r.file), { width: r.width, height: r.height, waitMs: 300, signal });
      fs.writeFileSync(inside(r.out), buf);
      onFrac(1);
      return;
    }
    // 不传 deadline：任务可能比这次工具调用活得久，超时由 compose-jobs 按预估时长管
    await require("../../htmlvideo").renderMotion([{ path: path.resolve(cwd, r.file), duration: r.duration, name: path.basename(r.file) }], {
      width: r.width, height: r.height, fps: r.fps, out: inside(r.out), ffmpegBin: bins.ffmpeg, signal,
      onProgress: (/** @type {any} */ p) => onFrac(p && p.total > 0 ? p.done / p.total : ((p && p.pct) || 0) / 100),
    });
  };
  const hooks = {
    render,
    // 封面那一步 compose-jobs 记成 shot（截图）；对外只报 compose / encode / render 三种
    onProgress: (/** @type {any} */ ev) => {
      if (!tap.fn) return;
      tap.fn({ stage: ev.stage === "shot" ? "compose" : ev.stage, done: ev.done, total: ev.total, pct: ev.pct, label: M.fitLabel(ev.label, 48) });
    },
  };
  const started = /** @type {any} */ (jobs.startTimeline({ plan, bin: bins.ffmpeg, probeBin: bins.ffprobe, cwd, owner, hooks }));
  if (started.error) return out(`没开跑：${started.error}`, true);
  if (started.busy) {
    const b = started.busy;
    if (b.id) return out(`这个对话已经有一条合成在跑（任务 ${b.id}，第 ${b.at}/${b.total} 步）。等它跑完再开新的，或者用 {"job": "${b.id}", "cancel": true} 先叫停`, true);
    return out(b.error || "另一条合成正在跑，ffmpeg 同时只跑一条，等它跑完再来", true);
  }
  const id = started.job.id;
  taps.set(id, tap);
  for (const k of [...taps.keys()].slice(0, -8)) taps.delete(k);
  // 等多久：预估的三倍，至少一分钟、至多十分钟；等不到就交任务号
  const want = Math.min(Math.max(3 * (plan.etaMs || 0), 60000), 600000);
  const stopped = await waitFor(id, owner, waitBudget(opts, want), opts);
  if (stopped) return stopped;
  const view = jobs.timelineGet(id, owner);
  if (view && !view.done) return describe(view, `开跑了（任务 ${view.id}），预计 ${Math.max(1, Math.round((plan.etaMs || 0) / 1000))} 秒。`);
  return describe(view);
}

module.exports = { composeVideo, _internals: { mapRefs, readTimeline, describe, makeResolver, waitBudget } };
