"use strict";
/**
 * 时间轴成片（compose_video）——纯函数那一半。
 *
 *   node test/timeline-compose.js                 跑一遍
 *   node test/timeline-compose.js --write-golden  只在「drama-compose.js 还没被搬过」的那一刻用过一次：
 *                                                 把当时的输出钉进 test/fixtures/drama-compose-golden.json
 *
 * 这套东西坏掉的样子，全都是「能播」：
 *   - 拼出来的命令错了半个参数，ffmpeg 照样退出码 0，片子少一截或者声音小一半；
 *   - 字幕时间轴差 0.3 秒，每条都晚半拍，只有人看得出来对不上嘴；
 *   - 一行字幕塞了二十个字，竖屏上两头出画。
 * 本机的 ffmpeg 没有 libass，两台 CI 都可能没有 ffmpeg，所以真正拦得住的只有这里的纯函数断言：
 * 命令行、时间轴、ASS/SRT 文本、每种画幅的安全边距。
 *
 * 分节写，后面的人（真 ffmpeg / 工具接线那一半）接着往下加【5】【6】……，前面几节不动：
 *   【1】drama-compose 搬家前后逐字节一样（golden）
 *   【2】timeline.json 校验：每个卡点都配一个反向对照
 *   【3】排片（timelinePlan）：时长、偏移、帧数、转场、画幅、logo、字幕烧不烧
 *   【4】字幕：断行、时间轴、ASS 样式、禁用词
 *   【4b】字体名读取、片头片尾卡
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 600) : "")); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}
function section(title) { console.log("\n" + title); }

// 家目录和工作区都放临时盘：后面接真 ffmpeg 的那几节要往里写文件，前缀 owb- 让 e2e 的收尸器认得
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tlc-"));
process.env.OPENWORKBUDDY_HOME = TMP;

// 这一整套不许碰网络：compose_video 只拼盘上已有的文件，从不调模型、不调配音。
// 谁要是在排片里偷偷发了请求，这里直接炸，而不是悄悄花一笔钱
const realFetch = globalThis.fetch;
globalThis.fetch = /** @type {any} */ (async (url) => { throw new Error("timeline-compose 测试里不许联网：" + String(url)); });
for (const mod of ["http", "https"]) {
  const m = require(mod);
  m.request = /** @type {any} */ (() => { throw new Error("timeline-compose 测试里不许联网（" + mod + ".request）"); });
  m.get = /** @type {any} */ (() => { throw new Error("timeline-compose 测试里不许联网（" + mod + ".get）"); });
}

const GOLDEN = path.join(ROOT, "test", "fixtures", "drama-compose-golden.json");
const WRITE_GOLDEN = process.argv.includes("--write-golden");

// ════════════════════════════════════════════════════════════════════════
// 【1】drama-compose 搬家：逐字节一样
// ════════════════════════════════════════════════════════════════════════
// 通用的那几样（编码参数、字幕时间、起名、配乐混音图、缩放补边）要搬去 lib/timeline-compose.js
// 给新的时间轴成片共用。搬的时候最怕的不是报错，是「差一个字」：配乐图里少一个 volume=2，
// 片子照样出、照样能播，只是整条台词小了一半——e2e 那条真跑 ffmpeg 的测试量得出来，
// 但它只覆盖一种画布。所以这里在**搬之前**把十几种画布的整份计划钉成 golden，搬完逐字节比。

/** 一个镜头节点 */
const shot = (id, p, pos) => ({ id: "n_" + id, kind: "shot", payload: { id, prompt: "p", ...p }, position: pos || { x: 0, y: 0 } });
/** 一段声音节点 */
const audioNode = (id, p) => ({ id: "a_" + id, kind: "audio", payload: p, position: { x: 0, y: 900 } });
const V = (dur, w, h, more) => ({ dur, w, h, fps: 30, vcodec: "h264", pix: "yuv420p", ...(more || {}) });
const A = (dur) => ({ dur });

/**
 * 盘上文件：basename → 相对路径；probes 按相对路径记
 * @param {Record<string, any>} disk basename → probe（null = 在盘上但探不到）
 */
function world(disk, extra = {}) {
  const files = new Map(), onDisk = new Set(), probes = {};
  for (const [base, p] of Object.entries(disk)) {
    const rel = "素材/" + base;
    files.set(base, rel); onDisk.add(base);
    if (p) probes[rel] = p;
  }
  for (const n of extra.onDisk || []) onDisk.add(n);
  return { files, onDisk, probes };
}
const BINS = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", install: "brew install ffmpeg", burn: true, duck: true, limiter: true };

/** golden 的全部输入。改这里 = golden 作废，必须在「没搬过」的代码上重录，不能在搬完的代码上录 */
function goldenCases() {
  const uni = { "s1.mp4": V(2, 1080, 1920), "s2.mp4": V(3, 1080, 1920), "s3.mp4": V(2.5, 1080, 1920) };
  const voiced = { ...uni, "v1.m4a": A(1.5), "v2.m4a": A(2.2), "v3.m4a": A(1.1), "bgm.mp3": A(60) };
  const talk = [
    shot("S1-01", { video: "s1.mp4", audio: "v1.m4a", line: "你终于来了。" }),
    shot("S1-02", { video: "s2.mp4", audio: "v2.m4a", line: "我等了你三年，整整三年" }),
    shot("S1-03", { video: "s3.mp4", audio: "v3.m4a", line: "走吧" }),
  ];
  const bgmNode = audioNode("bgm", { role: "配乐", title: "雨夜", url: "bgm.mp3" });
  /** @type {Array<{name: string, state: any, opts: any}>} */
  const cases = [];
  const add = (name, nodes, disk, opts = {}, extra = {}) => {
    const w = world(disk, extra);
    cases.push({ name, state: { nodes, edges: [] }, opts: { files: w.files, onDisk: w.onDisk, probes: w.probes, ...BINS, ...opts } });
  };

  add("copy-uniform", [
    shot("S1-02", { video: "s2.mp4", line: "对白或旁白…" }),
    shot("S1-01", { video: "s1.mp4" }),
    shot("S1-03", { video: "s3.mp4", line: "  " }),
  ], uni);
  add("reencode-pad-mixed", [
    shot("S1-01", { video: "s1.mp4", audio: "v1.m4a", line: "第一句" }),
    shot("S1-02", { video: "s2.mp4", audio: "v2.m4a", line: "它的配音比画面长" }),
    shot("S1-03", { video: "s3.mp4" }),
  ], {
    "s1.mp4": V(2, 1080, 1920), "s2.mp4": V(1, 719, 1279, { fps: 25 }), "s3.mp4": V(2.5, 1080, 1920, { pix: "yuvj420p" }),
    "v1.m4a": A(1.5), "v2.m4a": A(2.2),
  });
  add("music-duck-limiter", [...talk, bgmNode], voiced);
  add("music-noduck-limiter", [...talk, bgmNode], voiced, { duck: false });
  add("music-noduck-nolimiter", [...talk, bgmNode], voiced, { duck: false, limiter: false });
  add("music-duck-nolimiter", [...talk, bgmNode], voiced, { limiter: false });
  add("burn-false", talk, voiced, { burn: false });
  add("subtitles-false", talk, voiced, { subtitles: false });
  add("music-off-by-user", [...talk, bgmNode], voiced, { music: false });
  add("music-short-loops", [...talk, bgmNode], { ...voiced, "bgm.mp3": A(3) });
  add("music-dur-unknown", [...talk, bgmNode], { ...voiced, "bgm.mp3": null });
  add("musicfile-override-and-many", [
    ...talk, bgmNode,
    audioNode("theme", { role: "主题曲", title: "片尾曲", url: "theme.mp3" }),
    // 「对白/音乐」两边都占：不许当配乐
    audioNode("both", { role: "对白/音乐", title: "第三镜台词", url: "v3.m4a" }),
    { id: "tl", kind: "timeline", payload: { bgm: "tl-bgm.mp3", bgm_title: "剪辑节点写死的" }, position: { x: 0, y: 0 } },
  ], { ...voiced, "theme.mp3": A(20), "tl-bgm.mp3": A(15), "pick.mp3": A(40) }, { musicFile: "pick.mp3" });
  add("music-problems", [
    ...talk,
    audioNode("empty", { role: "配乐", title: "还没生成的配乐" }),
    audioNode("png", { role: "bgm", title: "封面", url: "cover.png" }),
  ], voiced);
  add("music-lost-file", [...talk, audioNode("lost", { role: "背景音", title: "丢了", url: "gone.mp3" })], voiced);
  add("ambiguous-locate", talk, voiced, {
    locate: (ref) => (/s2\.mp4$/.test(ref) ? { rel: "", ambiguous: ["第1集/s2.mp4", "第2集/s2.mp4"] } : /v3\.m4a$/.test(ref) ? { rel: "", ambiguous: ["a/v3.m4a", "b/v3.m4a"] } : { rel: "素材/" + ref }),
  });
  add("locate-happy", talk, voiced, { locate: (ref) => ({ rel: "素材/" + ref }) });
  add("missing-and-wrongkind", [
    shot("S1-01", { video: "gone.mp4", line: "丢了" }),
    shot("S1-02", { video: "frame.png" }),
    shot("S1-03", { line: "还没生成视频" }),
    shot("S1-04", { video: "s1.mp4", audio: "gone.m4a", line: "配音丢了" }),
  ], uni);
  add("no-ffmpeg", talk, voiced, { ffmpeg: "", install: "" });
  add("empty-canvas", [bgmNode], voiced);
  add("no-probe", [
    shot("S1-01", { video: "s1.mp4", line: "有台词" }),
    shot("S1-02", { video: "s4.mp4", line: "探不到" }),
    shot("S1-03", { video: "s5.mp4" }), shot("S1-04", { video: "s6.mp4" }), shot("S1-05", { video: "s7.mp4" }),
  ], { ...uni, "s4.mp4": null, "s5.mp4": null, "s6.mp4": null, "s7.mp4": null });
  add("no-ffprobe-no-sizes", [shot("S1-01", { video: "s4.mp4" })], { "s4.mp4": null }, { ffprobe: "" });
  add("name-collisions", talk, voiced, { dir: "输出/中间//" }, { onDisk: ["成片.mp4", "成片_2.mp4", "字幕.srt"] });
  add("order-rules", [
    shot("场2-01", { video: "s1.mp4" }, { x: 0, y: 0 }),
    shot("S1-02", { video: "s2.mp4" }, { x: 0, y: 0 }),
    shot("随便起的名", { video: "s3.mp4" }, { x: 50, y: 610 }),
    shot("没编号", { video: "s1.mp4", order: 0 }, { x: 900, y: 0 }),
    shot("第三个", { video: "s2.mp4" }, { x: 10, y: 590 }),
    shot("我's 镜头/:*?", { video: "s3.mp4" }, { x: 10, y: 590 }),
  ], uni);
  add("fps-over-60", [shot("S1-01", { video: "s1.mp4" }), shot("S1-02", { video: "s2.mp4" })],
    { "s1.mp4": V(2, 1080, 1920, { fps: 120 }), "s2.mp4": V(2, 1080, 1920, { fps: 30 }) });
  return cases;
}

/** musicArgv 的 2×2×2（duck × limiter × 循环与否），T 取 0 / 3 / 40：淡入淡出的三条缩放分支都要走到 */
function musicCombos() {
  const out = [];
  for (const T of [0, 3, 40]) for (const duck of [true, false]) for (const limiter of [true, false]) for (const dur of [0, 2, 100]) {
    out.push({ T, duck, limiter, dur });
  }
  return out;
}

/** 当前 drama-compose.js 在这些输入上的全部输出。函数（locate）不进 JSON */
function goldenSnapshot() {
  const C = require(path.join(ROOT, "drama-compose.js"));
  const I = C._internals;
  const plans = {};
  for (const c of goldenCases()) plans[c.name] = C.composePlan(c.state, c.opts);
  const music = musicCombos().map((m) => ({ ...m, argv: I.musicArgv("成片素材/拼接.mp4", { rel: "素材/bgm.mp3", dur: m.dur }, "成片.mp4", { duck: m.duck, limiter: m.limiter }, m.T) }));
  const srt = [0, -1, 0.0004, 0.0005, 1.5, 59.9995, 61.25, 3599.9996, 3600, 86400.5, NaN, "2.25", null, undefined].map((x) => [String(x), I.srtTime(x)]);
  const safe = ["", null, undefined, "S1-01", "  S1-01 ", "a/b:c", "___", "镜头 1*?<>|\"", "\\x/", 0, 12].map((x) => [String(x), I.safeName(x)]);
  const free = [
    ["成片", ".mp4", null], ["成片", ".mp4", []], ["成片", ".mp4", ["成片.mp4"]], ["成片", ".mp4", ["成片.mp4", "成片_2.mp4", "成片_3.mp4"]],
    ["字幕", ".srt", ["成片.mp4"]],
  ].map(([s, e, on]) => [s, e, on, I.freeName(s, e, on ? new Set(on) : on)]);
  const srtText = I.buildSrt([{ seconds: 1.5, line: "第一句" }, { seconds: 2, line: "对白或旁白…" }, { seconds: 0.75, line: "  第三句  " }, { seconds: 1, line: "" }]);
  const exts = { VIDEO_EXT: String(I.VIDEO_EXT), AUDIO_EXT: String(I.AUDIO_EXT), MUSIC_HINT: String(I.MUSIC_HINT), VOICE_HINT: String(I.VOICE_HINT), MUSIC_GAIN: I.MUSIC_GAIN };
  return { keys: Object.keys(C).sort(), internals: Object.keys(I).sort(), plans, music, srt, safe, free, srtText, exts };
}

section("【1】drama-compose 搬到 lib/timeline-compose.js 前后逐字节一样");
{
  const snap = goldenSnapshot();
  const text = JSON.stringify(snap, null, 1) + "\n";
  if (WRITE_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, text);
    console.log("  已写 golden：" + path.relative(ROOT, GOLDEN) + "（" + text.length + " 字节）");
  }
  const want = fs.existsSync(GOLDEN) ? fs.readFileSync(GOLDEN, "utf8") : "";
  ok(!!want, "golden 文件在（test/fixtures/drama-compose-golden.json）");
  if (want) {
    // 逐字节比：键顺序变了也算变。deepStrictEqual 只用来在不一样的时候指出是哪一格
    const same = text === want;
    let where = "";
    if (!same) {
      const g = JSON.parse(want);
      for (const k of Object.keys(g)) {
        try { assert.deepStrictEqual(JSON.parse(JSON.stringify(snap[k])), g[k]); } catch (e) { where += `[${k}] ` + String(e.message).slice(0, 400) + "\n"; }
      }
      if (!where) where = "内容一样但键顺序或格式变了";
    }
    ok(same, "composePlan × " + Object.keys(snap.plans).length + " 张画布、musicArgv × " + snap.music.length + " 种组合、srtTime/safeName/freeName/buildSrt 与搬家前逐字节一样", where || undefined);
    // 反向对照：golden 比较本身不能是常绿的——改一个字就得红
    const tampered = JSON.parse(JSON.stringify(snap));
    tampered.music[0].argv = tampered.music[0].argv.map((a) => a.replace("volume=2", "volume=1"));
    ok(JSON.stringify(tampered, null, 1) + "\n" !== want, "反向对照：配乐图里 volume=2 改成 volume=1，golden 比较必须变红");
    ok(Object.keys(snap.plans).length >= 9 && snap.music.length === 36, "golden 覆盖面够：≥9 张画布、36 种配乐组合", { plans: Object.keys(snap.plans).length, music: snap.music.length });
    // 覆盖面：这几条分支必须真被走到过，不然 golden 钉的是一片空白
    const all = JSON.stringify(snap.plans);
    for (const [re, what] of [
      [/-stream_loop/, "配乐循环"], [/sidechaincompress/, "说话时压低配乐"], [/alimiter/, "限幅"], [/\[mx\]anull\[a\]/, "没限幅器"],
      [/tpad=stop_mode=clone/, "补最后一帧"], [/"mode":"copy"/, "直拼"], [/"mode":"reencode"/, "重新编码"],
      [/subtitles=/, "烧字幕"], [/没带 libass/, "烧不了字幕的提醒"], [/同名的有/, "同名卡点"], [/不在盘上了/, "丢文件卡点"],
      [/成片_3\.mp4/, "不覆盖旧片"], [/"level":"stop"/, "stop 卡点"],
    ]) ok(re.test(all), "golden 走到了：" + what);
  }
  // golden 里最大的画幅都是偶数边，补偶数这一步它量不到。这组数是在搬家前的 drama-compose.js（git HEAD）上跑出来的
  const C = require(path.join(ROOT, "drama-compose.js"));
  const w = world({ "o1.mp4": V(2, 719, 1279), "o2.mp4": V(2, 701, 1001) });
  const odd = C.composePlan({ nodes: [shot("S1-01", { video: "o1.mp4" }), shot("S1-02", { video: "o2.mp4" })], edges: [] }, { files: w.files, onDisk: w.onDisk, probes: w.probes, ...BINS });
  ok(odd.target.w === 720 && odd.target.h === 1280 && odd.steps.some((s) => (s.argv || []).join(" ").includes("pad=720:1280:")), "最大画幅 719×1279：补成 720×1280 再拼（x264 只收偶数边）", odd.target);
}

// 后面几节（【2】起）要用到的模块。golden 那一节必须在它们之前跑完：
// 录 golden 的那一刻 lib/timeline-compose.js 还不存在
if (WRITE_GOLDEN) {
  console.log(`\n${pass} 过 / ${fail} 挂（只录 golden，后面几节没跑）`);
  globalThis.fetch = realFetch;
  process.exit(fail ? 1 : 0);
}

const tc = require("../lib/timeline-compose");
const subs = require("../lib/timeline-subs");
const cards = require("../lib/timeline-cards");
const fontFamily = require("../lib/font-family");

/** 本机什么滤镜都有的那台机器 */
const BINS_ALL = Object.freeze({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", install: "brew install ffmpeg", burn: true, duck: true, limiter: true, xfade: true, zoompan: true, ass: true, overlay: true, boxblur: true });
/** 最小的一份合法时间轴 */
const baseTl = (more = {}) => ({ version: 1, title: "t", segments: [{ id: "a", visual: { kind: "image", file: "素材/a.png" } }], ...more });
/** @param {any} r @param {RegExp} re */
const hasBlock = (r, re) => r.blockers.some((b) => re.test(b.what + " " + b.why + " " + b.fix));

// ════════════════════════════════════════════════════════════════════════
// 【2】timeline.json 校验：每个卡点配一个反向对照（不然「总是报错」也能全绿）
// ════════════════════════════════════════════════════════════════════════
section("【2】timeline.json 校验");
{
  const v0 = tc.validateTimeline(baseTl());
  ok(v0.ok && v0.blockers.length === 0, "最小的一份合法时间轴能过", v0.blockers);
  eq([v0.timeline.fps, v0.timeline.aspects], [30, [{ aspect: "9:16", w: 1080, h: 1920 }]], "默认 30fps、只出竖屏 1080×1920");
  eq(tc.validateTimeline(v0.timeline).timeline, v0.timeline, "洗过的再洗一遍不变（调用方可以先洗、再探文件、再排片）");
  ok(v0.timeline.segments[0].visual.kind === "image" && tc.validateTimeline(baseTl({ segments: [{ visual: { file: "素材/x.mp4" } }] })).timeline.segments[0].visual.kind === "video", "kind 不写就按后缀认");

  /** 每一条：[说明, 改坏的时间轴, facts, 卡点里该出现的字, 对照组（改好的）, 对照组的 facts] */
  const cases = [
    ["不是对象", null, {}, /不是一个 JSON 对象/, baseTl(), {}],
    ["version 2", baseTl({ version: 2 }), {}, /只认 version 1/, baseTl({ version: 1 }), {}],
    ["帧率 29", baseTl({ fps: 29 }), {}, /24 \/ 25 \/ 30 \/ 60/, baseTl({ fps: 25 }), {}],
    ["画幅写成 9x16", baseTl({ aspects: ["9x16"] }), {}, /看不懂/, baseTl({ aspects: ["9:16"] }), {}],
    ["画幅列表是空的", baseTl({ aspects: [] }), {}, /至少一种画幅/, baseTl({ aspects: ["1:1"] }), {}],
    ["画幅尺寸 8×8", baseTl({ aspects: [{ aspect: "1:1", w: 8, h: 8 }] }), {}, /尺寸/, baseTl({ aspects: [{ aspect: "1:1", w: 360, h: 360 }] }), {}],
    ["一个片段都没有", baseTl({ segments: [] }), {}, /一个片段都没有/, baseTl(), {}],
    ["片段 id 重复", baseTl({ segments: [{ id: "a", visual: { file: "a.png" } }, { id: "a", visual: { file: "b.png" } }] }), {}, /重复/, baseTl({ segments: [{ id: "a", visual: { file: "a.png" } }, { id: "b", visual: { file: "b.png" } }] }), {}],
    ["画面类型不认识", baseTl({ segments: [{ visual: { kind: "gif", file: "a.gif" } }] }), {}, /不认识/, baseTl({ segments: [{ visual: { kind: "image", file: "a.png" } }] }), {}],
    ["写的是图片、文件是视频", baseTl({ segments: [{ visual: { kind: "image", file: "a.mp4" } }] }), {}, /写的是图片/, baseTl({ segments: [{ visual: { kind: "video", file: "a.mp4" } }] }), {}],
    ["trim 倒着写", baseTl({ segments: [{ visual: { kind: "video", file: "a.mp4", trim: [3, 1] } }] }), {}, /trim/, baseTl({ segments: [{ visual: { kind: "video", file: "a.mp4", trim: [1, 3] } }] }), {}],
    ["fit 不认识", baseTl({ segments: [{ visual: { kind: "video", file: "a.mp4", fit: "stretch" } }] }), {}, /fit/, baseTl({ segments: [{ visual: { kind: "video", file: "a.mp4", fit: "blur" } }] }), {}],
    ["min_seconds 是负的", baseTl({ segments: [{ visual: { file: "a.png" }, min_seconds: -1 }] }), {}, /min_seconds/, baseTl({ segments: [{ visual: { file: "a.png" }, min_seconds: 3 }] }), {}],
    ["配音是张图", baseTl({ segments: [{ visual: { file: "a.png" }, voice: { file: "v.png" } }] }), {}, /配音不是音频/, baseTl({ segments: [{ visual: { file: "a.png" }, voice: { file: "v.mp3" } }] }), {}],
    ["转场不认识", baseTl({ transition: "wipe" }), {}, /转场/, baseTl({ transition: "slide" }), {}],
    ["logo 角落不认识", baseTl({ logo: { corner: "middle" } }), {}, /logo 位置/, baseTl({ logo: { corner: "bl" } }), {}],
    ["配乐不是音频", baseTl({ music: "素材/bgm.png" }), {}, /配乐不是音频/, baseTl({ music: "素材/bgm.mp3" }), {}],
    ["一行字数 100", baseTl({ subtitles: { max_chars: 100 } }), {}, /一行字数/, baseTl({ subtitles: { max_chars: 16 } }), {}],
    ["品牌包模块不在", baseTl({ brand: "猫叔小店" }), {}, /品牌包还没建：先用 brand_kit 建一个，或者直接写 logo\/font 路径/, baseTl({ brand: "猫叔小店" }), { brandKit: true, brand: { slug: "x" } }],
    ["品牌包没找到", baseTl({ brand: "猫叔小店" }), { brandKit: true, brand: null }, /没找到品牌包/, baseTl({ brand: "猫叔小店" }), { brandKit: true, brand: { slug: "x" } }],
    ["HTML 画面但渲染不了", baseTl({ segments: [{ visual: { kind: "html", file: "p.html" } }] }), { canRender: { ok: false, why: "没有 Electron" } }, /渲染不了：没有 Electron/, baseTl({ segments: [{ visual: { kind: "html", file: "p.html" } }] }), { canRender: { ok: true } }],
    ["文件不在盘上", baseTl({ segments: [{ visual: { file: "素材/a.png" }, voice: { file: "素材/v.mp3" } }] }), { exists: new Set(["素材/a.png"]) }, /素材\/v\.mp3.*配音文件不在盘上/, baseTl({ segments: [{ visual: { file: "素材/a.png" }, voice: { file: "素材/v.mp3" } }] }), { exists: new Set(["素材/a.png", "素材/v.mp3"]) }],
    ["字幕里有「一个人做的」", baseTl({ segments: [{ visual: { file: "a.png" }, text: "这是我一个人做的小店" }] }), {}, /不许上屏.*一个人做的[\s\S]*把这句改掉再合成/, baseTl({ segments: [{ visual: { file: "a.png" }, text: "这是我们做的小店" }] }), {}],
    ["禁用词换了写法（全角、夹空格）", baseTl({ segments: [{ visual: { file: "a.png" }, voice: { file: "v.mp3", sentences: [{ file: "v1.mp3", text: "独立 开发者 一人" }] } }] }), {}, /独立开发者一人/, baseTl({ segments: [{ visual: { file: "a.png" }, voice: { sentences: [{ file: "v1.mp3", text: "开发者团队" }] } }] }), {}],
    ["品牌自己的禁用词在片尾卡上", baseTl({ brand: { banned: ["最便宜"] }, outro: { text: "全网最便宜" } }), {}, /最便宜/, baseTl({ brand: { banned: ["最便宜"] }, outro: { text: "全网好价" } }), {}],
    ["禁用词写成全角字母", baseTl({ brand: { banned: ["AI生成"] }, segments: [{ visual: { file: "a.png" }, text: "全部ＡＩ 生成" }] }), {}, /AI生成/, baseTl({ brand: { banned: ["AI生成"] }, segments: [{ visual: { file: "a.png" }, text: "全部实拍" }] }), {}],
    ["禁用词在品牌包的行动号召里",baseTl({ brand: { cta: "ＡＢＣ 一个人做的" } }), {}, /品牌行动号召/, baseTl({ brand: { cta: "搜索店名领券" } }), {}],
  ];
  for (const [what, bad, facts, re, good, goodFacts] of cases) {
    const r = tc.validateTimeline(bad, facts);
    ok(!r.ok && hasBlock(r, re), `卡住：${what}`, r.blockers);
    const g = tc.validateTimeline(good, goodFacts);
    ok(g.ok, `  对照组放行：${what}（改好了就过）`, g.blockers);
  }
  // 卡点都要三件套：什么、为什么、怎么办。只写「出错了」的卡点等于没写
  const allBlockers = cases.flatMap(([, bad, facts]) => tc.validateTimeline(bad, facts).blockers);
  ok(allBlockers.length >= cases.length && allBlockers.every((b) => b.what && b.why && b.fix && typeof b.fix === "string"), "每个卡点都写清了 what / why / fix", allBlockers.filter((b) => !(b.what && b.why && b.fix)));
  ok(allBlockers.every((b) => !/[a-z]+Error|undefined|null|NaN|\[object/.test(b.why + b.fix)), "卡点里没有英文报错、undefined、NaN 这类漏出来的东西", allBlockers.filter((b) => /Error|undefined|NaN/.test(b.why + b.fix)));

  // 只提醒不卡住的几种
  const odd = tc.validateTimeline(baseTl({ aspects: [{ aspect: "9:16", w: 271, h: 481 }, "9:16"] }));
  ok(odd.ok && odd.timeline.aspects.length === 1 && odd.timeline.aspects[0].w === 272 && odd.timeline.aspects[0].h === 482, "奇数边自动补成偶数，重复的画幅只出一份", odd.timeline && odd.timeline.aspects);
  ok(odd.warnings.some((w) => /奇数边.*272×482/.test(w)) && odd.warnings.some((w) => /写了两遍/.test(w)), "  这两件事都说出来", odd.warnings);
  const trimImg = tc.validateTimeline(baseTl({ segments: [{ visual: { file: "a.png", trim: [0, 1] } }] }));
  ok(trimImg.ok && trimImg.warnings.some((w) => /只有视频能 trim/.test(w)), "图片上写 trim：提醒一句、不卡", trimImg.warnings);
  const badColor = tc.validateTimeline(baseTl({ brand: { colors: ["#12345", "red;}body{", "#1a2b3c"] } }));
  ok(badColor.ok && badColor.timeline.brand.colors.join() === "#1a2b3c" && badColor.warnings.some((w) => /#12345/.test(w)), "品牌色写错的丢掉并说出来（颜色会直接拼进 CSS）", badColor);
  eq(tc.validateTimeline(baseTl({ aspects: ["4:5", "21:9"] })).timeline.aspects, [{ aspect: "4:5", w: 1080, h: 1350 }, { aspect: "21:9", w: 2520, h: 1080 }], "表外的画幅按短边 1080 算");
  const norm = tc.validateTimeline(baseTl({ intro: true, outro: true, music: "./素材\\bgm.mp3", logo: false })).timeline;
  eq([norm.intro, norm.outro, norm.music, norm.logo], [{ seconds: 1.5 }, { seconds: 2.5, cta: true }, { file: "素材/bgm.mp3", gain: 0.25, duck: true }, false], "intro/outro 写 true 用默认秒数；配乐路径统一成正斜杠；logo:false 就是不要");
  const cost = tc.validateTimeline(baseTl({ cost: [{ what: "配音", amount: 0.12, currency: "CNY" }, { what: "生图" }, "垃圾"] })).timeline.cost;
  eq(cost, [{ what: "配音", amount: 0.12, currency: "CNY" }, { what: "生图", amount: null }], "花费只转交：不知道的记 null，不记 0");

  // collectFiles / brandFacts
  const files = tc.collectFiles({ segments: [{ id: "s", visual: { file: "./素材\\a.png", by_aspect: { "16:9": "素材/a_wide.png" } }, voice: { sentences: [{ file: "v1.mp3" }, { file: "v1.mp3" }] } }], music: { file: "bgm.mp3" }, brand: { logo: "logo.png", font: "f.otf" } });
  eq(files, [
    { rel: "素材/a.png", role: "visual", seg: "s" }, { rel: "素材/a_wide.png", role: "visual", seg: "s" },
    { rel: "v1.mp3", role: "voice", seg: "s" }, { rel: "bgm.mp3", role: "music" }, { rel: "logo.png", role: "logo" }, { rel: "f.otf", role: "font" },
  ], "collectFiles：列出所有要探的文件，路径统一、同一个只列一次");
  const bf = tc.brandFacts({ slug: "maoshu", kit: { name: "猫叔", colors: [{ name: "主", hex: "#FF6600", role: "primary" }, { name: "强调", hex: "#00AA88", role: "accent" }], cta: "搜索猫叔小店", banned_words: ["最便宜"] } }, { logo: { light: "/k/logo.png" }, fonts: { zh: "/k/f.otf" } });
  eq(bf, { slug: "maoshu", name: "猫叔", logo: "/k/logo.png", font: { file: "/k/f.otf", family: "" }, colors: { bg: "#FF6600", fg: "", accent: "#00AA88" }, cta: { text: "搜索猫叔小店" }, banned: ["最便宜"] }, "brandFacts：品牌包 → 底色 / 强调色 / 行动号召 / 禁用词 / logo / 字体");
  const withKit = tc.validateTimeline(baseTl({ brand: "maoshu", segments: [{ visual: { file: "a.png" }, text: "全网最便宜" }] }), { brandKit: true, brand: bf });
  ok(!withKit.ok && hasBlock(withKit, /最便宜/), "品牌包里的禁用词对字幕同样生效", withKit.blockers);
}

// ════════════════════════════════════════════════════════════════════════
// 【3】排片：时长、偏移、帧数、转场、画幅、logo、字幕烧不烧
// ════════════════════════════════════════════════════════════════════════
section("【3】排片（timelinePlan）");
/** 一份有片头片尾、三段、两种画幅的时间轴。第二段进场是硬切 */
const P1_TL = () => ({
  version: 1, title: "春季新品", fps: 30, aspects: ["9:16", "16:9"],
  transition: { type: "fade", duration: 0.3 },
  brand: { logo: "素材/logo.png", colors: ["#1a2b3c"], cta: "搜索店名领券" },
  intro: true, outro: true, music: { file: "素材/bgm.mp3" },
  segments: [
    { id: "a", visual: { kind: "image", file: "素材/a.png" }, voice: { file: "素材/a.mp3", text: "春天来了，新品上架，iPhone15 也能用，价格 3,500 元。" } },
    { id: "b", visual: { kind: "video", file: "素材/b.mp4", trim: [0, 3] }, voice: { sentences: [{ text: "第一句。", file: "素材/b1.mp3" }, { text: "第二句话稍微长一点点，看看怎么拆开。", file: "素材/b2.mp3" }] }, transition: "cut" },
    { id: "c", visual: { kind: "video", file: "素材/c.mp4" }, text: "只有字幕", cover: true },
  ],
});
const P1_PROBES = { "素材/a.mp3": { dur: 3.1 }, "素材/b.mp4": { dur: 5, w: 1920, h: 1080 }, "素材/b1.mp3": { dur: 1.2 }, "素材/b2.mp3": { dur: 2.4 }, "素材/c.mp4": { dur: 2.5, w: 1080, h: 1920 }, "素材/bgm.mp3": { dur: 8 } };
const P1_FACTS = (more = {}) => ({ probes: P1_PROBES, bins: { ...BINS_ALL }, canRender: { ok: true }, platform: "darwin", ...more });
/** @param {any} p @param {string} key */
const stepOf = (p, key) => p.steps.find((s) => s.key === key);
/** @param {any} s */
const fcOf = (s) => s.argv[s.argv.indexOf("-filter_complex") + 1];
{
  const tl = P1_TL();
  const before = JSON.stringify(tl);
  const p = tc.timelinePlan(tl, P1_FACTS());
  ok(p.ok && p.blockers.length === 0, "P1 能排", p.blockers);
  ok(JSON.stringify(tl) === before, "排片不改调用方传进来的时间轴");
  eq(JSON.stringify(tc.timelinePlan(P1_TL(), P1_FACTS())), JSON.stringify(p), "同样的输入排两次，结果一字不差（纯函数）");

  // 槽长：片头 1.5；a 配音 3.1+0.3=3.4；b 两句 3.6+0.3=3.9（比剪出来的 3 秒长，接住最后一帧）；c 视频本身 2.5；片尾 2.5
  eq(p.segments.map((s) => s.frames), [45, 102, 117, 75, 75], "每段的槽长（帧）：配音 + 0.3 秒尾巴，和最短时长取大");
  eq(p.segments.map((s) => s.start), [0, 1.5, 4.9, 8.8, 11.3], "每段的起点 = 前面槽长之和");
  eq([p.T, p.frames], [13.8, 414], "片长 = 所有槽之和（转场叠在接缝上，不额外加长）");
  // 片段长 = 槽 + 下一个接缝的转场（硬切是 0）
  eq(p.segments.map((s) => s.clipFrames), [54, 102, 126, 84, 75], "每段画面的帧数 = 槽 + 下一刀的转场帧数");
  eq(p.segments.map((s) => s.transition && s.transition.type), [null, "fade", "cut", "fade", "fade"], "段自己的 transition 压过全局的");
  for (const a of ["9x16", "16x9"]) {
    const frames = [1, 2, 3, 4, 5].map((k) => { const s = stepOf(p, `clip:${a}:0${k}`); return Number(s.argv[s.argv.indexOf("-frames:v") + 1]); });
    eq(frames, [54, 102, 126, 84, 75], `${a}：每段 -frames:v 就是算出来的帧数（不靠 -t 猜）`);
  }
  const film = stepOf(p, "film:9x16");
  const g = fcOf(film);
  ok(g.includes("[c0][c1]xfade=transition=fade:duration=0.3:offset=1.5[x1]"), "第一刀：淡入淡出，偏移 = 片头的槽长", g);
  ok(g.includes("[x1][c2]concat=n=2:v=1:a=0,settb=1/30[x2]"), "硬切走 concat，并且拨回 1/帧率 的时基（不然下一刀 xfade 会报错退出）", g);
  ok(g.includes("xfade=transition=fade:duration=0.3:offset=8.8[x3]") && g.includes("offset=11.3[x4]"), "后两刀的偏移 8.8 / 11.3 = 槽长累加", g);
  // 用算出来的片段长反推：每一刀之后的总长都得等于下一段的起点 + 它自己的长度
  {
    let len = p.segments[0].clipFrames;
    let good = true;
    for (let j = 1; j < p.segments.length; j++) {
      const d = Math.round(p.segments[j].transition.d * 30);
      good = good && (len - d === Math.round(p.segments[j].start * 30));
      len = len - d + p.segments[j].clipFrames;
    }
    ok(good && len === p.frames, "逐刀反推：每段正好在它的起点露面，最后正好 414 帧", { len, frames: p.frames });
  }
  ok(film.argv.includes("-t") && film.argv[film.argv.indexOf("-t") + 1] === "13.8" && film.argv.includes("copy"), "成片 -t 片长、声音直接拷混好的那条");

  // 横竖对不上：模糊背景；对得上：铺满裁切
  ok(/boxblur/.test(fcOf(stepOf(p, "clip:9x16:03"))) && !/boxblur/.test(fcOf(stepOf(p, "clip:16x9:03"))), "横屏视频进竖屏：模糊背景垫底；进横屏：直接铺满");
  ok(!/boxblur/.test(fcOf(stepOf(p, "clip:9x16:04"))) && /boxblur/.test(fcOf(stepOf(p, "clip:16x9:04"))), "竖屏视频反过来");
  ok(stepOf(p, "clip:9x16:03").argv.slice(1, 5).join(" ") === "-ss 0 -t 3", "trim 用 -ss/-t 放在 -i 前面", stepOf(p, "clip:9x16:03").argv.slice(0, 6));
  ok(/tpad=stop_mode=clone:stop_duration=2\.2,/.test(fcOf(stepOf(p, "clip:9x16:03"))), "b 剪出来 3 秒、要 4.2 秒：最后一帧接住（多给 1 秒，靠 -frames:v 收住）");
  {
    const coverFit = tc.timelinePlan({ ...P1_TL(), segments: [{ id: "b", visual: { kind: "video", file: "素材/b.mp4", fit: "cover" } }] }, P1_FACTS());
    ok(!/boxblur/.test(fcOf(stepOf(coverFit, "clip:9x16:04") || stepOf(coverFit, "clip:9x16:02"))), "fit:cover 写死了就裁切，不垫模糊背景");
    const nearly = tc.timelinePlan({ ...P1_TL(), intro: false, outro: false, segments: [{ id: "n", visual: { kind: "video", file: "素材/n.mp4" } }] }, P1_FACTS({ probes: { "素材/n.mp4": { dur: 2, w: 1080, h: 1880 } } }));
    ok(!/boxblur/.test(fcOf(stepOf(nearly, "clip:9x16:01"))), "差不到 10% 的画幅直接裁切（垫一条细细的模糊边更难看）");
    // 手机竖拍：存成 1920×1080 + 转 90°（rot）。ffmpeg 解码时先转正，横竖要按转过之后的算
    const rotTl = { ...P1_TL(), intro: false, outro: false, segments: [{ id: "r", visual: { kind: "video", file: "素材/r.mp4" } }] };
    const rotOf = (rot) => tc.timelinePlan(rotTl, P1_FACTS({ probes: { "素材/r.mp4": { dur: 2, w: 1920, h: 1080, ...(rot == null ? {} : { rot }) } } }));
    const blurIn = (p) => ["16x9", "9x16"].map((a) => /boxblur/.test(fcOf(stepOf(p, `clip:${a}:01`)))).join(",");
    eq([blurIn(rotOf(90)), blurIn(rotOf(270))], ["true,false", "true,false"], "转 90°/270° 的竖拍：进横屏垫模糊背景、进竖屏直接铺满（不按存储的横宽高裁掉大半）");
    eq([blurIn(rotOf(null)), blurIn(rotOf(180))], ["false,true", "false,true"], "反向对照：没转的、转 180° 的还是横的");
  }

  // 推镜：一张推近一张拉远；d = 帧数
  const zp = fcOf(stepOf(p, "clip:9x16:02"));
  ok(/zoompan=z='1\+0\.12\*on\/101'.*d=102:s=1080x1920:fps=30/.test(zp), "图片推镜：从 1 推到 1.12，d = 这段的帧数", zp);
  {
    const two = tc.timelinePlan(baseTl({ segments: [{ visual: { file: "a.png" } }, { visual: { file: "b.png" } }, { visual: { file: "c.png", kenburns: false } }] }), P1_FACTS());
    ok(/z='1\+0\.12/.test(fcOf(stepOf(two, "clip:9x16:01"))) && /z='1\.12-0\.12/.test(fcOf(stepOf(two, "clip:9x16:02"))), "相邻两张图一推一拉，不是一路推到底");
    ok(!/zoompan/.test(fcOf(stepOf(two, "clip:9x16:03"))) && stepOf(two, "clip:9x16:03").argv.includes("-loop"), "kenburns:false 就是一张定住的图");
  }

  // logo 只在正片里出现：片头片尾卡上本来就有 logo
  ok(/overlay=x=W-w-43:y=43:enable='between\(t,1\.8,11\.3\)'/.test(g), "logo 在右上，只在片头淡出完到片尾开始之间出现", g.slice(g.indexOf("[lg]") - 80));
  ok(film.argv.includes("素材/logo.png") && film.argv.indexOf("素材/logo.png") < film.argv.indexOf("成片/春季新品/.work/mix.m4a"), "logo 是一路输入，混好的声音在它后面");

  // 字幕：有 libass 就烧；烧失败的退路是不带字幕的同一条
  ok(/ass=filename=成片\/春季新品\/春季新品_9x16\.ass,format=yuv420p\[vout\]/.test(g) && film.burned === true, "有 libass：烧进画面", g.slice(-160));
  ok(Array.isArray(film.fallback) && !/ass=/.test(film.fallback.join(" ")) && film.fallbackWhy === tc.BURN_FALLBACK_WHY, "烧字幕的退路：不带字幕的同一条，并说明为什么");
  const noAss = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { ...BINS_ALL, ass: false, burn: false } }));
  ok(noAss.ok && !noAss.steps.some((s) => s.argv.join(" ").includes("ass=")) && noAss.aspects.every((a) => a.burned === false), "没有 libass：一条命令里都不许出现 ass=");
  ok(noAss.warnings.includes(tc.NO_LIBASS) && /\.srt 和 \.ass 已单独出好/.test(tc.NO_LIBASS), "  开跑前就说清楚，字幕文件照出", noAss.warnings);
  ok(noAss.steps[0].writes.some((w) => w.rel.endsWith(".srt")) && noAss.manifestDraft.aspects.every((a) => a.burned === false), "  .srt 照写，成片清单里记 burned:false");
  const legacy = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { ...BINS_ALL, ass: undefined, burn: true } }));
  ok(legacy.aspects.every((a) => a.burned), "只探了 subtitles（老版本 composeBins）也算有 libass：两个滤镜同出一个库");
  const noSubs = tc.timelinePlan({ ...P1_TL(), subtitles: false }, P1_FACTS());
  ok(!noSubs.steps.some((s) => s.argv.join(" ").includes("ass=")) && !noSubs.srt && noSubs.cues.length === 0, "subtitles:false：不出字幕");
  const noBurn = tc.timelinePlan({ ...P1_TL(), subtitles: { burn: false } }, P1_FACTS());
  ok(!noBurn.steps.some((s) => s.argv.join(" ").includes("ass=")) && noBurn.srt && !noBurn.warnings.includes(tc.NO_LIBASS), "burn:false：只出字幕文件，也不提 libass");

  // 出片的名字：画幅写成 9x16（冒号在 Windows 文件名里不合法，在滤镜参数里还得转义）
  const outs = p.steps.map((s) => s.out).concat(p.aspects.map((a) => a.file), p.srt, p.manifest);
  ok(outs.every((o) => !/[:]/.test(o)), "所有产物的路径里都没有冒号", outs.filter((o) => /:/.test(o)));
  eq(p.aspects.map((a) => a.file), ["成片/春季新品/春季新品_9x16.mp4", "成片/春季新品/春季新品_16x9.mp4"], "成片按画幅各出一条");
  const again = tc.timelinePlan(P1_TL(), P1_FACTS({ onDisk: new Set(["春季新品_16x9.mp4"]) }));
  ok(again.aspects[0].file === "成片/春季新品/春季新品_2_9x16.mp4" && again.manifest.endsWith("manifest_2.json") && again.workDir.endsWith(".work_2"), "撞名了整组换成 _2，绝不覆盖上一条", again.aspects.map((a) => a.file));
  // 成片、字幕、清单都挪走了，只剩手改过的封面 / .ass / 用户自己的 .work：这些也会被写（.work 跑完整个删），照样换名
  for (const left of ["春季新品_9x16_cover1.jpg", "春季新品_16x9_cover3.jpg", "春季新品_16x9.ass", ".work"]) {
    const q = tc.timelinePlan(P1_TL(), P1_FACTS({ onDisk: new Set([left]) }));
    const writes = [...q.steps.map((s) => s.out), ...q.steps.flatMap((s) => (s.writes || []).map((w) => w.rel)), q.workDir].filter(Boolean);
    ok(q.stem === "春季新品_2" && q.workDir === "成片/春季新品/.work_2" && !writes.some((w) => w === `成片/春季新品/${left}` || w.startsWith(`成片/春季新品/${left}/`)),
      `盘上只剩 ${left}：整组换成 _2，不写它、不删它`, { stem: q.stem, workDir: q.workDir });
  }
  ok(tc.timelinePlan(P1_TL(), P1_FACTS({ onDisk: new Set(["春季新品_9x16_cover4.jpg", ".work_3", "别的.ass"]) })).stem === "春季新品", "反向对照：不是这一趟会写的名字，不换名");

  // 步骤顺序：先混音（最快失败）→ 每个画幅：卡片 → 画面 → 成片 → 封面
  eq(p.steps[0].key, "audio", "第一步是混音：配音文件坏了第一步就知道");
  const order = p.steps.slice(1).map((s) => s.aspect + ":" + s.stage);
  const want = ["9:16", "16:9"].flatMap((a) => [...Array(2).fill(a + ":cards"), ...Array(5).fill(a + ":clips"), a + ":film", ...Array(3).fill(a + ":covers")]);
  eq(order, want, "每个画幅依次：卡片 → 画面 → 成片 → 封面");
  const STAGES = ["load", "render", "encode", "tts", "shot", "step", "compose", "upload", "transcode"];
  ok(p.steps.every((s) => tc.PROGRESS_STAGE[s.stage] && STAGES.includes(tc.PROGRESS_STAGE[s.stage])), "每一步的 stage 都能映射到进度条认的那组词", p.steps.map((s) => s.stage));
  ok(p.steps.every((s) => subs.displayUnits(s.label) <= 24), "每一步的说明都不超过 24 个字宽", p.steps.map((s) => s.label).filter((l) => subs.displayUnits(l) > 24));
  ok(p.etaMs > 0 && p.steps.every((s) => s.expectSeconds > 0), "每一步都给了预估耗时", p.etaMs);

  // 卡片
  const introCard = stepOf(p, "card:9x16:intro");
  ok(introCard.kind === "render" && introCard.render.what === "card" && introCard.render.width === 1080 && introCard.writes[0].rel === introCard.render.file, "片头卡：先写 HTML，再渲染成 PNG", introCard);
  ok(introCard.writes[0].text.includes("春季新品") && stepOf(p, "card:9x16:outro").writes[0].text.includes("搜索店名领券"), "片头写片名、片尾写品牌的行动号召");
  const noRender = tc.timelinePlan(P1_TL(), P1_FACTS({ canRender: { ok: false, why: "命令行版" } }));
  ok(noRender.ok && !noRender.steps.some((s) => s.kind === "render") && noRender.segments.length === 3, "渲染不了：片头片尾卡这次不加，正片照出");
  ok(noRender.warnings.includes("片头卡要桌面版才能画，这次先不加") && noRender.warnings.includes("片尾卡要桌面版才能画，这次先不加"), "  并说出来", noRender.warnings);

  // 封面
  const covers = p.steps.filter((s) => s.stage === "covers" && s.aspect === "9:16");
  ok(covers.length === 3 && covers.every((s) => s.optional && s.out.endsWith(".jpg")), "每个画幅三张封面，截不出来不算整条失败");
  ok(covers[1].argv.includes("成片/春季新品/.work/9x16/c04.mp4"), "第二张封面从 cover:true 的那段截", covers[1].argv);
  ok(covers.every((s) => { const t = Number(s.argv[s.argv.indexOf("-ss") + 1]); return t >= 0.3 - 1e-9; }), "封面不在转场那几帧里截（淡入还没完的画面是半透明的）", covers.map((s) => s.argv[2]));

  // 混音
  const au = p.steps[0];
  const ag = fcOf(au);
  ok(/anullsrc=r=44100:cl=stereo,atrim=duration=1\.5\[vs0\]/.test(ag), "片头那一槽是静音", ag);
  ok(/\[0:a\]aformat=[^;]*,apad,atrim=duration=3\.4,asetpts=N\/SR\/TB\[vs1\]/.test(ag), "每段配音补齐到槽长（配音从槽的起点开始，和画面同时进）", ag);
  ok(/\[vs2s0\]\[vs2s1\]concat=n=2:v=0:a=1,apad,atrim=duration=3\.9/.test(ag), "一段好几句：先首尾相接，再补齐");
  ok(/concat=n=5:v=0:a=1\[voice\]/.test(ag) && /\[voice\]aformat=[^;]*,asplit=2\[v0\]\[key\]/.test(ag) && /\[3:a\]aformat=[^;]*,volume=0\.5,afade/.test(ag), "人声总线 → 配乐图（说话时压低配乐），音乐是第 4 路输入", ag);
  ok(au.argv.includes("-stream_loop") && au.argv.indexOf("-stream_loop") < au.argv.indexOf("素材/bgm.mp3"), "配乐 8 秒、片子 13.8 秒：循环");
  ok(au.argv[au.argv.indexOf("-t") + 1] === "13.8", "混出来的声音正好是片长");
  const noVoice = tc.timelinePlan(baseTl(), P1_FACTS());
  ok(noVoice.ok && noVoice.warnings.includes("这条片子没有声音：没有配音也没有配乐"), "没配音也没配乐：说出来（不是悄悄出一条哑片）", noVoice.warnings);
  const noDuck = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { ...BINS_ALL, duck: false } }));
  ok(!/sidechaincompress/.test(fcOf(noDuck.steps[0])) && noDuck.warnings.some((w) => /sidechaincompress/.test(w)) && noDuck.manifestDraft.music.ducked === false, "没有 sidechaincompress：固定音量垫着，说出来，清单里记 ducked:false");

  // 时长：配音 + 0.3 和最短时长取大
  const slotOf = (seg, probes) => tc.timelinePlan(baseTl({ segments: [seg] }), P1_FACTS({ probes })).segments[0].frames;
  eq(slotOf({ visual: { file: "a.png" }, voice: { file: "v.mp3" }, min_seconds: 5 }, { "v.mp3": { dur: 1 } }), 150, "配音 1 秒、最短 5 秒：5 秒");
  eq(slotOf({ visual: { file: "a.png" }, voice: { file: "v.mp3" } }, { "v.mp3": { dur: 4.9 } }), 156, "配音 4.9 秒：4.9 + 0.3 = 5.2 秒（156 帧）");
  eq(slotOf({ visual: { file: "a.png" } }, {}), 60, "没配音的图片：默认 2 秒");
  eq(slotOf({ visual: { file: "a.png" }, voice: { file: "v.mp3" } }, { "v.mp3": { dur: 1.001 } }), 60, "配音 1.3 秒的图片：也停够默认的 2 秒");
  eq(slotOf({ visual: { file: "a.png" }, voice: { file: "v.mp3" }, min_seconds: 1 }, { "v.mp3": { dur: 1.001 } }), 40, "1.301 秒向上取整到帧：40 帧（宁可多一帧，不切最后半个字）");

  // 全部硬切 / 没有 xfade
  const cut = tc.timelinePlan({ ...P1_TL(), transition: "cut", segments: P1_TL().segments.map((s) => ({ ...s, transition: undefined })) }, P1_FACTS());
  ok(!/xfade/.test(fcOf(stepOf(cut, "film:9x16"))) && cut.segments.every((s) => s.clipFrames === s.frames) && cut.frames === 414, "全局 cut：全走 concat，片段长 = 槽长，片长不变");
  const noX = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { ...BINS_ALL, xfade: false } }));
  ok(!/xfade/.test(fcOf(stepOf(noX, "film:9x16"))) && noX.warnings.includes("这台机器的 ffmpeg 没有 xfade，转场都改成了硬切") && noX.frames === 414, "没有 xfade：改硬切、说出来、片长不变");
  const noZ = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { ...BINS_ALL, zoompan: false } }));
  ok(!/zoompan/.test(noZ.steps.map((s) => s.argv.join(" ")).join()) && noZ.warnings.some((w) => /zoompan/.test(w)), "没有 zoompan：图片定住，说出来");
  const noBlur = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { ...BINS_ALL, boxblur: false } }));
  ok(/pad=1080:1920/.test(fcOf(stepOf(noBlur, "clip:9x16:03"))) && noBlur.warnings.some((w) => /加黑边/.test(w)), "没有 boxblur：改加黑边，说出来");
  const noOv = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { ...BINS_ALL, overlay: false } }));
  ok(!/overlay/.test(fcOf(stepOf(noOv, "film:9x16"))) && noOv.warnings.some((w) => /不加 logo/.test(w)), "没有 overlay：不加 logo，说出来");
  const limitOff = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { ...BINS_ALL, limiter: undefined } }));
  ok(/\[mx\]anull\[a\]/.test(fcOf(limitOff.steps[0])), "没探过的滤镜一律当没有（limiter 没探 → 不挂 alimiter）");

  // 卡点：ffmpeg / 探不到时长
  const noFf = tc.timelinePlan(P1_TL(), P1_FACTS({ bins: { install: "sudo apt install ffmpeg" } }));
  ok(!noFf.ok && noFf.steps.length === 0 && hasBlock(noFf, /没装 ffmpeg[\s\S]*sudo apt install ffmpeg/), "没有 ffmpeg：卡住，给装法，一条命令都不交出去", noFf.blockers);
  const noProbe = tc.timelinePlan(P1_TL(), P1_FACTS({ probes: { ...P1_PROBES, "素材/b1.mp3": undefined }, bins: { ...BINS_ALL, ffprobe: "" } }));
  ok(!noProbe.ok && noProbe.steps.length === 0 && hasBlock(noProbe, /b1\.mp3[\s\S]*没有 ffprobe/), "探不到配音时长：卡住（字幕和画面都没法对上），没 ffprobe 就给装法", noProbe.blockers);
  const noVid = tc.timelinePlan(P1_TL(), P1_FACTS({ probes: { ...P1_PROBES, "素材/c.mp4": {} } }));
  ok(!noVid.ok && hasBlock(noVid, /探不到这段视频有多长/), "探不到视频时长：卡住", noVid.blockers);
  const banned = tc.timelinePlan({ ...P1_TL(), outro: { text: "一个人做的良心小店" } }, P1_FACTS());
  ok(!banned.ok && banned.steps.length === 0 && hasBlock(banned, /一个人做的/), "禁用词：排片同样卡住");

  // HTML 画面：先渲染成视频再统一
  const html = tc.timelinePlan(baseTl({ segments: [{ id: "h", visual: { kind: "html", file: "页面/p.html", html_seconds: 3 } }] }), P1_FACTS());
  const r1 = stepOf(html, "render:9x16:01");
  ok(r1 && r1.render.what === "motion" && r1.render.duration === 3 && r1.render.fps === 30 && r1.render.width === 1080, "HTML 画面：按片段长、帧率、画幅渲染", r1);
  ok(stepOf(html, "clip:9x16:01").argv.includes(r1.out), "  渲染出来的那条再按视频的路子统一一遍");

  // 清单草稿
  const m = p.manifestDraft;
  ok(m.duration === 13.8 && m.segments.length === 5 && m.aspects.length === 2 && m.subtitles.ass.length === 2 && m.covers["9x16"].length === 3, "成片清单：时长、每段起止、每个画幅、字幕、封面都在");
  ok(m.brand.font_family === "PingFang SC" && m.music.looped === true && m.music.ducked === true, "  字体、配乐循环没有、压没压都记下", m);
  eq(tc.timelinePlan({ ...baseTl(), cost: [{ what: "配音", amount: 0.1 }, { what: "生图", amount: 0.2 }] }, P1_FACTS()).manifestDraft.cost.total, 0.3, "花费合计");
  const unk = tc.timelinePlan({ ...baseTl(), cost: [{ what: "配音", amount: 0.1 }, { what: "生图" }] }, P1_FACTS()).manifestDraft.cost;
  ok(unk.total === null && unk.note === "单价未知", "有一项不知道单价：合计写不知道，不写 0.1", unk);
  ok(!JSON.stringify(p).includes("undefined") && !JSON.stringify(p).includes("NaN"), "整份计划里没有 undefined / NaN");
}

// ════════════════════════════════════════════════════════════════════════
// 【4】字幕：断行、时间轴、ASS 样式、禁用词
// ════════════════════════════════════════════════════════════════════════
section("【4】字幕");
{
  const cases = [
    ["春天来了，新品上架，iPhone15 也能用，价格 3,500 元。", ["春天来了，新品上架", "iPhone15 也能用", "价格 3,500 元"]],
    ["早上 10:30 开门，全场 3.5 折起。", ["早上 10:30 开门", "全场 3.5 折起"]],
    ["早上 10:30 开门，全场 3.5 折起，满 3,500 再减。", ["早上 10:30 开门", "全场 3.5 折起，满 3,500 再减"]],
    ["Hi. OK.", ["Hi", "OK"]],
    ["这是一句完全没有任何标点符号的很长很长很长的中文句子用来测试平衡切分效果如何", ["这是一句完全没有任何标点符", "号的很长很长很长的中文句子", "用来测试平衡切分效果如何"]],
    ["“你好！”他说。（括号里的话）", ["“你好！”", "他说", "（括号里的话）"]],
    ["Hello world, this is a fairly long English sentence for testing.", ["Hello world", "this is a fairly long", "English sentence for testing"]],
    ["第一行\n第二行", ["第一行", "第二行"]],
    ["等一下...好吗？", ["等一下...", "好吗？"]],
  ];
  for (const [text, want] of cases) eq(subs.splitCues(text, 14), want, "断行：" + text.replace(/\n/g, "⏎").slice(0, 20));
  const long = "今天给大家介绍一款新品，它有三个特点：第一是便宜，第二是好用，第三是售后有保障，全国联保三年。欢迎到店体验 iPhone15 同款配色，满 3,500 元再减 200，活动到 10:30 截止！";
  const lines = subs.splitCues(long, 14);
  ok(lines.every((l) => subs.displayUnits(l) <= 14), "一行不超过 14 个汉字宽", lines.map((l) => [l, subs.displayUnits(l)]));
  ok(["iPhone15", "3,500", "10:30"].every((w) => lines.some((l) => l.includes(w))), "iPhone15 / 3,500 / 10:30 不被拆开", lines);
  ok(lines.every((l) => !/[，。；、：,;:]$/.test(l)), "行尾的逗号句号都去掉了（问号叹号是语气，留着）", lines);
  ok(lines.join("").replace(/[，。；、：,;:！\s]/g, "") === long.replace(/[，。；、：,;:！\s]/g, ""), "除了标点和空格，一个字都没丢");
  ok(lines.every((l) => !/^[，。、；：,.;:!?！？”’）)》」』]/.test(l)), "没有一行以标点打头", lines);
  eq(subs.splitCues("一二三四五六七八九十一二三四五六七八", 6).map((l) => subs.displayUnits(l)), [6, 6, 6], "max_chars 可调：6 个字一行，均分");
  ok(subs.splitCues("", 14).length === 0 && subs.splitCues("。，", 14).length === 0, "空的、只有标点的：不出字幕");

  // 时间轴：对齐到帧、首尾贴着这句、中间不留缝
  const sents = [{ text: long, start: 1.5, dur: 9.37 }, { text: "第二句。", start: 10.87, dur: 1.2 }];
  for (const fps of [24, 25, 30, 60]) {
    const cues = subs.timeCues(sents, fps, 14);
    const onFrame = cues.every((c) => Math.abs(c.start * fps - Math.round(c.start * fps)) < 1e-4 && Math.abs(c.end * fps - Math.round(c.end * fps)) < 1e-4);
    const mono = cues.every((c, i) => c.end > c.start && (i === 0 || c.start >= cues[i - 1].end - 1e-9));
    const inner = cues.slice(0, lines.length);
    const tight = inner.every((c, i) => i === 0 || Math.abs(c.start - inner[i - 1].end) < 1e-9);
    ok(onFrame && mono && tight, `${fps}fps：每条字幕都落在整帧上、依次排开、同一句的几行之间不留缝`, cues);
    // 时间保留 6 位小数，所以和整帧比差在 1e-6 以内就算对上
    ok(Math.abs(inner[0].start - Math.round(1.5 * fps) / fps) < 1e-5 && Math.abs(inner[inner.length - 1].end - Math.round(10.87 * fps) / fps) < 1e-5,`${fps}fps：这句的第一行从配音开始、最后一行在配音结束时收`, [inner[0], inner[inner.length - 1]]);
  }
  const two = subs.timeCues([{ text: "一二三四五六七八九十一二三四，一二", start: 0, dur: 3.2 }], 30, 14);
  ok(two.length === 2 && two[0].end - two[0].start > two[1].end - two[1].start, "同一句拆成两行：字多的那行停得久", two);
  const tiny = subs.timeCues([{ text: "一。二。三。", start: 0, dur: 1 / 30 }], 30, 14);
  ok(tiny.every((c) => c.end > c.start), "配音短到只有一帧：不出零长字幕", tiny);

  // SRT
  eq(subs.buildSrt([{ text: "你好", start: 1.5, end: 2 }, { text: "  ", start: 2, end: 3 }, { text: "再见", start: 3723.004, end: 3724 }]),
    "1\n00:00:01,500 --> 00:00:02,000\n你好\n\n2\n01:02:03,004 --> 01:02:04,000\n再见\n\n", "SRT：序号、逗号毫秒、空行分隔，空字幕跳过");
  eq(subs.buildSrt([]), "", "没有字幕就是空串（不写一个空文件充数）");

  // ASS：每个画幅的安全区
  const p = tc.timelinePlan({ ...P1_TL(), aspects: ["9:16", "16:9", "1:1", "3:4"] }, P1_FACTS());
  const assOf = (key) => p.steps[0].writes.find((w) => w.rel.endsWith(`_${key}.ass`)).text;
  const styleOf = (text) => text.split("\n").find((l) => l.startsWith("Style: ")).slice(7).split(",");
  const want = { "9x16": [1080, 1920, 56, 384, 130], "16x9": [1920, 1080, 56, 86, 60], "1x1": [1080, 1080, 56, 130, 60], "3x4": [1080, 1440, 60, 216, 60] };
  for (const [key, [w, h, fs, mv, ml]] of Object.entries(want)) {
    const text = assOf(key), st = styleOf(text);
    ok(text.includes(`PlayResX: ${w}\nPlayResY: ${h}`) && st[2] === String(fs) && st[21] === String(mv) && st[19] === String(ml) && st[20] === String(ml), `${key}：PlayRes ${w}×${h}、字号 ${fs}、底边距 ${mv}、左右 ${ml}`, st);
  }
  const st = styleOf(assOf("9x16"));
  ok(st[1] === "PingFang SC" && st[13] === "0" && st[18] === "2" && !/\\fsp/.test(assOf("9x16")), "字体名进 Style；Spacing 0、不写 \\fsp（中文不加字距）；底部居中", st);
  ok(assOf("9x16").includes("WrapStyle: 2"), "WrapStyle 2：行已经按宽度切好了，别让 libass 再折一次");
  ok(tc.timelinePlan({ ...P1_TL(), aspects: ["9:16"] }, P1_FACTS({ platform: "linux" })).steps[0].writes.find((w) => w.rel.endsWith(".ass")).text.includes("Style: Default,Noto Sans CJK SC,"), "Linux 上默认写 Noto Sans CJK SC");
  const small = subs.safeAreaFor("9:16", 270, 480);
  eq(small, { fontsize: 14, marginV: 96, marginLR: 33 }, "小尺寸按高度等比缩");
  eq(subs.safeAreaFor("9:16", 1080, 1920, { fontsize: 70 }).fontsize, 70, "用户写死的字号照用");
  eq(subs.safeAreaFor("4:5", 1080, 1350).marginV, Math.round(0.15 * 1350), "表外的画幅（4:5）按比例最近的那档（3:4）");
  const esc = subs.buildAss({ w: 1080, h: 1920, family: "A,B", fontsize: 56, marginV: 384, marginLR: 130, cues: [{ text: "{\\b1}粗体\\N换行", start: 0, end: 1 }] });
  const dl = esc.split("\n").find((l) => l.startsWith("Dialogue:"));
  ok(!/[{}\\]/.test(dl.slice(dl.indexOf(",,") + 2)) && dl.includes("｛＼b1｝粗体"), "台词里的 { } \\ 换成全角：不会被当成样式代码吞掉", dl);
  ok(styleOf(esc)[1] === "A B", "字体名里的逗号换掉（会把 Style 行的字段错开）");
  ok(subs.assTime(3723.456) === "1:02:03.46" && subs.srtTime(3723.456) === "01:02:03,456", "ASS 时间百分之一秒、SRT 毫秒");

  // 计划里的字幕和配音对得上：a 的配音从 1.5 秒开始，b 的第二句从 1.2 秒后开始
  const pc = tc.timelinePlan(P1_TL(), P1_FACTS()).cues;
  ok(pc[0].start === 1.5 && pc.find((c) => c.text === "第二句话稍微长一点点").start === 6.1 && pc[pc.length - 1].text === "只有字幕" && pc[pc.length - 1].end === 11.3, "字幕跟着每一句配音的真实起点走", pc);
  const bannedSub = tc.timelinePlan({ ...P1_TL(), segments: [{ id: "x", visual: { file: "a.png" }, voice: { sentences: [{ file: "v.mp3", text: "本店由独立开发者一人打理" }] } }] }, P1_FACTS({ probes: { "v.mp3": { dur: 2 } } }));
  ok(!bannedSub.ok && hasBlock(bannedSub, /独立开发者一人[\s\S]*把这句改掉再合成/), "配音文本里的禁用词：卡住，告诉人改哪句", bannedSub.blockers);
}

// ════════════════════════════════════════════════════════════════════════
// 【4b】字体名读取、片头片尾卡
// ════════════════════════════════════════════════════════════════════════
section("【4b】字体名、片头片尾卡");
{
  /** UTF-16BE */
  const u16 = (s) => { const le = Buffer.from(s, "utf16le"); const be = Buffer.alloc(le.length); for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; } return be; };
  /**
   * 拼一个最小的字体文件：只有一张 name 表
   * @param {Array<[number, number, number, string]>} recs [platform, language, nameId, value]
   */
  const sfnt = (recs, ttc = false) => {
    const strs = recs.map(([pl, , , v]) => (pl === 1 ? Buffer.from(v, "latin1") : u16(v)));
    const strOff = 6 + 12 * recs.length;
    const name = Buffer.alloc(strOff + strs.reduce((n, b) => n + b.length, 0));
    name.writeUInt16BE(0, 0); name.writeUInt16BE(recs.length, 2); name.writeUInt16BE(strOff, 4);
    let off = 0;
    recs.forEach(([pl, lang, id], i) => {
      const r = 6 + i * 12;
      name.writeUInt16BE(pl, r); name.writeUInt16BE(pl === 3 ? 1 : 0, r + 2); name.writeUInt16BE(lang, r + 4);
      name.writeUInt16BE(id, r + 6); name.writeUInt16BE(strs[i].length, r + 8); name.writeUInt16BE(off, r + 10);
      strs[i].copy(name, strOff + off); off += strs[i].length;
    });
    const base = ttc ? 16 : 0;
    const head = Buffer.alloc(base + 28);
    if (ttc) { head.write("ttcf", 0, "latin1"); head.writeUInt32BE(0x00010000, 4); head.writeUInt32BE(1, 8); head.writeUInt32BE(16, 12); }
    head.writeUInt32BE(0x00010000, base); head.writeUInt16BE(1, base + 4);
    head.write("name", base + 12, "latin1"); head.writeUInt32BE(base + 28, base + 20); head.writeUInt32BE(name.length, base + 24);
    return Buffer.concat([head, name]);
  };
  const recs = [[3, 0x804, 1, "品牌黑体"], [3, 0x409, 1, "Brand Sans"], [3, 0x409, 4, "Brand Sans Regular"], [3, 0x409, 6, "BrandSans-Regular"], [3, 0x409, 16, "Brand"]];
  eq(fontFamily.parseFontNames(sfnt(recs)), { family: "Brand Sans", typoFamily: "Brand", full: "Brand Sans Regular", postscript: "BrandSans-Regular" }, "读 name 表：Windows 英文名优先");
  eq(fontFamily.parseFontNames(sfnt([[3, 0x804, 1, "品牌黑体"]])).family, "品牌黑体", "只有中文名就用中文名");
  eq(fontFamily.parseFontNames(sfnt([[1, 0, 1, "Old Mac"]])).family, "Old Mac", "老 Mac 平台的名字也认");
  const ttf = path.join(TMP, "Brand-Regular.ttf"), ttcf = path.join(TMP, "Brand.ttc"), junk = path.join(TMP, "junk.otf");
  fs.writeFileSync(ttf, sfnt(recs)); fs.writeFileSync(ttcf, sfnt(recs, true)); fs.writeFileSync(junk, "not a font at all, just text");
  ok(fontFamily.readFontFamily(ttf) === "Brand Sans" && fontFamily.readFontFamily(ttcf) === "Brand Sans", "读文件：.ttf 和 .ttc（字体集合读第一个）都认");
  ok(fontFamily.readFontFamily(junk) === "" && fontFamily.readFontFamily(path.join(TMP, "没有这个.ttf")) === "", "不是字体、文件不在：返回空串，不抛错");
  eq(["darwin", "win32", "linux"].map((x) => fontFamily.defaultCjkFamily(x)), ["PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"], "各平台默认的中文字体");
  // 品牌字体读得出名字：fontsdir 指过去、Style 里写它的名字；读不出来：说出来，退回系统字体
  const withFont = tc.timelinePlan(P1_TL(), P1_FACTS({ font: { file: ttf, family: "Brand Sans" } }));
  ok(fcOf(stepOf(withFont, "film:9x16")).includes(`:fontsdir=${tc.escFilterArg(path.dirname(ttf))}`) && withFont.steps[0].writes.find((w) => w.rel.endsWith(".ass")).text.includes("Style: Default,Brand Sans,"), "品牌字体：fontsdir 指到它的目录，Style 写它的名字");
  const unnamed = tc.timelinePlan(P1_TL(), P1_FACTS({ font: { file: junk, family: "" } }));
  ok(!fcOf(stepOf(unnamed, "film:9x16")).includes("fontsdir") && unnamed.warnings.some((w) => /读不出品牌字体/.test(w)), "字体名读不出来：不假装用上了，说出来", unnamed.warnings);
  // 第一层（滤镜参数）: → \:  ' → \'；第二层（滤镜图）再把 \ ' [ ] , ; 各转一次。
  // 真 ffmpeg 的 movie=filename= 读「怪 名:目录/it's [a],b;c\d.png」验过这套
  eq(tc.escFilterArg("C:/a b/it's [1],x;y"), "C\\\\:/a b/it\\\\\\'s \\[1\\]\\,x\\;y", "滤镜参数里的路径转两层义（冒号、引号、方括号、逗号、分号）");
  eq([tc.ffPath("-x.mp4"), tc.ffPath("concat:a.mp4"), tc.ffPath("素材/a.mp4")], ["./-x.mp4", "./concat:a.mp4", "素材/a.mp4"], "以 - 开头、像协议的文件名前面补 ./");

  // 卡片
  const html = cards.introCardHtml({ w: 1080, h: 1920, htmlRel: "成片/x/.work/9x16/intro.html", colors: { bg: "red;}body{display:none", fg: "#zzz" }, title: "<img src=x onerror=alert(1)>新品", logo: "素材/it's (1).png" });
  ok(html.includes("&lt;img src=x") && !html.includes("<img src=x"), "片名转义：里面有个 < 不会把卡片弄没");
  ok(html.includes("background:#111111") && !html.includes("display:none"), "颜色不是 #RRGGBB 就用默认色（颜色是直接拼进 CSS 的）");
  ok(html.includes(`src="../../../../%E7%B4%A0%E6%9D%90/it%27s%20%281%29.png"`), "logo 用相对 .work 的路径，引号括号编码掉", html.match(/src="[^"]*"/));
  const spacings = [...html.matchAll(/letter-spacing:\s*([^;}]+)/g)].map((x) => x[1].trim());
  ok(spacings.length > 0 && spacings.every((x) => x === "0"), "中文不加字距：所有 letter-spacing 都是 0", spacings);
  ok(!/AI ?生成|水印|watermark/i.test(html + cards.outroCardHtml({ w: 1080, h: 1920, htmlRel: "a.html", title: "扫码" })), "卡片上没有「AI 生成」字样或水印");
  const outro = cards.outroCardHtml({ w: 1920, h: 1080, htmlRel: "a/b.html", colors: { bg: "#FFFFFF" }, title: "搜索店名", sub: "到店出示", font: { file: "/k/Brand's.otf" } });
  ok(outro.includes("color:#111111") && outro.includes("搜索店名") && outro.includes("到店出示"), "浅底配深字，行动号召和补充都在");
  ok(/@font-face\{font-family:"card-brand";src:url\('file:\/\/\/k\/Brand%27s\.otf'\)/.test(outro), "品牌字体用 file:// 引进来，引号编码掉", outro.match(/@font-face[^}]*\}/));
  ok(cards.contrastFg("#1a2b3c") === "#FFFFFF" && cards.contrastFg("#FFEE00") === "#111111", "深底白字、浅底黑字");
}

// 【5】【6】（真 ffmpeg / 工具接线）。要真跑子进程、要等，所以是 async 的；再往后加的节接在 runtimeSections 里

const { execFileSync, spawnSync } = require("child_process");
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function runtimeSections() {
  const jobs = require("../lib/compose-jobs");
  const mediaProbe = require("../lib/media-probe");
  const R = await mediaProbe.resolveMediaBins();
  const FF = R.ffmpeg.bin, FP = R.ffprobe.bin;
  // contracts G：CI 装了 ffmpeg 就设 OWB_REQUIRE_FFMPEG=1，那时候「没找到」是红，不是跳过——
  // 不然装 ffmpeg 那一步悄悄坏了，这两节就永远是绿的空跑
  const hasFf = !!(FF && FP);

  // ════════════════════════════════════════════════════════════════════════
  // 【4c】收拾中间件：只整个删这一趟自己建的 .work。排片时绕开了盘上的 .work，这里是它之后的第二道：
  // 盘上情况在排片和开跑之间变了（排片时还没有），也不能把用户的目录连锅端。ffmpeg 用 node 顶替，第一条就退出，哪台机器都跑
  // ════════════════════════════════════════════════════════════════════════
  section("【4c】失败收拾：用户自己的 .work 一个字节不碰");
  {
    const cwd = path.join(TMP, "own-work");
    const plan = tc.timelinePlan(P1_TL(), P1_FACTS());
    const mine = path.join(cwd, plan.workDir, "笔记.txt");
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, "用户自己的东西");
    const v = await jobs.startTimeline({ plan, bin: process.execPath, probeBin: "", cwd, owner: "own-work", hooks: { render: async () => {} } }).done;
    ok(!!v.error && !v.films.length, "假 ffmpeg 第一步就退出：任务失败", v.error);
    ok(fs.existsSync(mine) && fs.readFileSync(mine, "utf8") === "用户自己的东西", "排片之后才冒出来的同名 .work：没被当中间件整个删掉", fs.existsSync(path.join(cwd, plan.workDir)) && fs.readdirSync(path.join(cwd, plan.workDir)));
    ok(!fs.readdirSync(path.join(cwd, plan.outDir)).some((n) => /\.(srt|ass|mp4)$/.test(n)), "这一趟自己写的字幕文件照样收掉", fs.readdirSync(path.join(cwd, plan.outDir)));
  }

  // ════════════════════════════════════════════════════════════════════════
  // 【5】真 ffmpeg：出片、尺寸、时长、声音、封面、清单、失败收拾、叫停、锁
  // ════════════════════════════════════════════════════════════════════════
  section("【5】真 ffmpeg 跑时间轴成片");
  if (!hasFf) {
    if (process.env.OWB_REQUIRE_FFMPEG === "1") ok(false, "OWB_REQUIRE_FFMPEG=1，可本机没找到 ffmpeg / ffprobe", R.install);
    else console.log("  跳过：本机没有 ffmpeg");
  } else {
    await realFfmpeg(jobs, FF, FP);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 【5r】手机竖拍（存成横的 + 转 90°）：composeProbe 另报 rot，排片按转过之后的横竖挑裁切还是垫模糊。
  // 没 ffmpeg 时【5】已经按 OWB_REQUIRE_FFMPEG 判过红绿，这里只说跳过
  // ════════════════════════════════════════════════════════════════════════
  section("【5r】转 90° 的竖拍：按转过之后的横竖挑裁切 / 模糊背景");
  if (!hasFf) console.log("  跳过：本机没有 ffmpeg");
  else {
    const dir = path.join(TMP, "rot");
    fs.mkdirSync(path.join(dir, "素材"), { recursive: true });
    const ff = (...args) => spawnSync(FF, ["-nostdin", "-v", "error", "-y", ...args], { encoding: "utf8" });
    const flat = path.join(dir, "素材/flat.mp4"), rot = path.join(dir, "素材/rot.mp4");
    ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", flat);
    // -display_rotation 是输入端选项（ffmpeg 7+），老版本没有就退到 rotate 标签
    if (ff("-display_rotation", "90", "-i", flat, "-c", "copy", rot).status !== 0) ff("-i", flat, "-c", "copy", "-metadata:s:v:0", "rotate=90", rot);
    const pr = await jobs.composeProbe(FP, dir, "素材/rot.mp4"), pf = await jobs.composeProbe(FP, dir, "素材/flat.mp4");
    ok(!!pr && pr.w === 640 && pr.h === 360 && (pr.rot === 90 || pr.rot === 270), "composeProbe：宽高照旧报存储的（短剧直拼要比这个），另报 rot", JSON.stringify(pr));
    ok(!!pf && pf.w === 640 && pf.h === 360 && !("rot" in pf), "反向对照：没转的不带 rot 字段", JSON.stringify(pf));
    const si = spawnSync(FF, ["-nostdin", "-hide_banner", "-i", rot, "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
    ok(/s:360x640\b/.test(si), "真 ffmpeg 解码时确实先转正成 360×640（排片得按这个算）", si.split("\n").filter((l) => /s:\d+x\d+/.test(l)).slice(0, 1).join(""));
    const tl = { version: 1, title: "竖拍", fps: 25, aspects: ["16:9", "9:16"], intro: false, outro: false,
      segments: [{ id: "r", visual: { kind: "video", file: "素材/rot.mp4" } }, { id: "f", visual: { kind: "video", file: "素材/flat.mp4" } }] };
    const plan = tc.timelinePlan(tl, P1_FACTS({ probes: { "素材/rot.mp4": pr, "素材/flat.mp4": pf } }));
    const blurIn = (k) => ["16x9", "9x16"].map((a) => /boxblur/.test(fcOf(stepOf(plan, `clip:${a}:${k}`)))).join(",");
    eq([blurIn("01"), blurIn("02")], ["true,false", "false,true"], "真量出来的竖拍：进横屏垫模糊、进竖屏铺满；没转的横片反过来");
  }

  // ════════════════════════════════════════════════════════════════════════
  // 【6】compose_video 工具：dry_run、卡点、开跑 + 任务号、查、停、别的对话看不见
  // ════════════════════════════════════════════════════════════════════════
  section("【6】compose_video 工具接线");
  await toolWiring(jobs, hasFf ? FF : "");

  // ════════════════════════════════════════════════════════════════════════
  // 【7】从 tools.executeTool 进去：switch 分派、权限档位、onProgress 一路递到 compose.js，界面那一行
  // ════════════════════════════════════════════════════════════════════════
  section("【7】从 executeTool 进去（真分派、真权限门、进度到得了）");
  await dispatchSmoke(hasFf ? FF : "");
}

/** 盘上造素材：全用 lavfi 现生成，不带任何二进制 fixture */
function makeMedia(FF, dir) {
  const ff = (...args) => execFileSync(FF, ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  for (const d of ["素材", "配音", "配乐"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  ff("-f", "lavfi", "-i", "testsrc=size=320x240:rate=1", "-frames:v", "1", path.join(dir, "素材/a.png"));
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-t", "3", "-pix_fmt", "yuv420p", "-c:v", "libx264", path.join(dir, "素材/b.mp4"));
  ff("-f", "lavfi", "-i", "color=c=red@0.5:size=64x32,format=rgba", "-frames:v", "1", path.join(dir, "素材/logo.png"));
  ff("-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-c:a", "aac", path.join(dir, "配音/v1.m4a"));
  ff("-f", "lavfi", "-i", "sine=frequency=660:duration=0.8", "-c:a", "aac", path.join(dir, "配音/v2.m4a"));
  ff("-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "aac", path.join(dir, "配乐/m.m4a"));
  fs.writeFileSync(path.join(dir, "配音/bad.m4a"), "这不是音频，只是一段文字");
}

/** 两种画幅、片头卡、图片段 + 视频段、按句配音、短配乐（会循环）、logo */
const RT_TL = (more) => ({
  title: "测试片", fps: 30,
  aspects: [{ aspect: "9:16", w: 180, h: 320 }, { aspect: "16:9", w: 320, h: 180 }],
  brand: { logo: "素材/logo.png", colors: ["#123456"] },
  intro: { seconds: 1, text: "开场" },
  outro: false,
  music: { file: "配乐/m.m4a", gain: 0.25 },
  segments: [
    { visual: { kind: "image", file: "素材/a.png" }, voice: { file: "配音/v1.m4a", text: "第一句话" }, cover: true },
    { visual: "素材/b.mp4", voice: { sentences: [{ text: "第二句", file: "配音/v2.m4a" }] }, transition: "cut" },
  ],
  ...(more || {}),
});

/** 画片头片尾卡的替身：真 Chrome 要走 http 连 DevTools，这个文件把 http 堵死了。用 ffmpeg 出一张纯色 PNG */
const fakeCard = (FF, cwd) => async (step, _signal, onFrac) => {
  const r = step.render;
  if (!r || r.what !== "card") throw new Error("测试里只画卡片");
  execFileSync(FF, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x224466:size=${r.width}x${r.height}`, "-frames:v", "1", path.join(cwd, r.out)]);
  onFrac(1);
};

function probeFilm(FP, abs) {
  const j = JSON.parse(execFileSync(FP, ["-v", "error", "-count_packets", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,nb_read_packets:format=duration", "-of", "json", abs], { encoding: "utf8" }));
  const s = (j.streams || [])[0] || {};
  return { w: Number(s.width), h: Number(s.height), frames: Number(s.nb_read_packets), dur: Number((j.format || {}).duration) };
}

/** 一段时间窗里的平均音量（dB）：只比相对大小，绝对值跟编码器、机器都有关 */
function meanDb(FF, abs, from, len) {
  const r = spawnSync(FF, ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", abs, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = String(r.stderr || "").match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  return m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : NaN;
}

/** 目录里（递归）有没有 mp4：失败、叫停之后一个半截都不许剩 */
function mp4sUnder(dir) {
  const outList = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.mp4$/i.test(e.name)) outList.push(p); } };
  walk(dir);
  return outList;
}

async function realFfmpeg(jobs, FF, FP) {
  const cwd = path.join(TMP, "rt5");
  makeMedia(FF, cwd);
  const bins = await jobs.composeBins();
  ok(bins.ffmpeg && bins.ffprobe && typeof bins.xfade === "boolean" && typeof bins.ass === "boolean", "composeBins 交回 ffmpeg / ffprobe 路径和滤镜表（xfade / zoompan / ass / overlay / boxblur）", bins);
  const probe = async (rels) => { const o = {}; for (const r of rels) { const p = await jobs.composeProbe(bins.ffprobe, cwd, r); if (p) o[r] = p; } return o; };
  const probes = await probe(["素材/b.mp4", "配音/v1.m4a", "配音/v2.m4a", "配乐/m.m4a"]);
  const factsFor = (onDisk) => ({ bins, probes, exists: (r) => fs.existsSync(path.join(cwd, r)), canRender: { ok: true }, onDisk, platform: process.platform });
  const namesIn = (rel) => { try { return new Set(fs.readdirSync(path.join(cwd, rel))); } catch { return new Set(); } };

  const plan1 = tc.timelinePlan(RT_TL(), factsFor(new Set()));
  ok(plan1.ok, "排片成功", plan1.blockers);
  if (!plan1.ok) return;
  const events = [];
  const s1 = jobs.startTimeline({ plan: plan1, bin: bins.ffmpeg, probeBin: bins.ffprobe, cwd, owner: "o1", hooks: { render: fakeCard(FF, cwd), onProgress: (e) => events.push(e) } });
  ok(s1.job && /^tlc/.test(s1.job.id) && s1.job.kind === "timeline" && s1.job.running, "开跑：交回任务号，kind 是 timeline", s1);

  // 锁：同一把锁，另一条（不管是时间轴还是画布）都进不来
  const again = jobs.startTimeline({ plan: plan1, bin: bins.ffmpeg, cwd, owner: "o1" });
  ok(again.busy && again.busy.id === s1.job.id, "同一个对话再开一条：交回正在跑的那条（能接着查）", again);
  const other = jobs.startTimeline({ plan: plan1, bin: bins.ffmpeg, cwd, owner: "o2" });
  ok(other.busy && other.busy.id === "" && /另一条时间轴成片正在跑/.test(other.busy.error) && !("log" in other.busy && other.busy.log.length), "别的对话来开：只说被占着，不给 id、不给路径和日志", other);
  const canvas = jobs.createComposeJobs({});
  const cb = canvas.start("画布", { steps: [], outputs: [] }, bins.ffmpeg);
  ok(cb.busy && cb.busy.id === "" && cb.busy.kind === "timeline", "画布一键合成撞上时间轴成片：也是 busy，id 留空（画布不会去轮询别人的任务）", cb);
  ok(canvas.running() === null && canvas.get(s1.job.id) === null && canvas.cancel(s1.job.id) === null, "画布那几个口子看不见、也停不了时间轴成片");
  ok(jobs.timelineGet(s1.job.id, "o2") === null && jobs.timelineCancel(s1.job.id, "o2") === null, "别的对话按 id 查、停：当没有这条");

  const v1 = await s1.done;
  ok(v1.done && !v1.error, "跑完了，没报错", { error: v1.error, log: v1.log });
  ok(v1.films.length === 2, "两个画幅各一条成片", v1.films);
  const T = plan1.T, F = plan1.fps;
  const got1 = {};
  for (const a of plan1.aspects) {
    const abs = path.join(cwd, a.file);
    const p = probeFilm(FP, abs);
    got1[a.aspect] = p;
    ok(p.w === a.w && p.h === a.h, `${a.aspect}：尺寸是 ${a.w}×${a.h}`, p);
    ok(p.frames === plan1.frames, `${a.aspect}：帧数正好是计划的 ${plan1.frames} 帧`, p);
    ok(Math.abs(p.dur - T) <= 1 / F + 0.03, `${a.aspect}：时长 ${T} 秒，差不过一帧`, p);
  }
  // 清单写的是量出来的数，不是计划值
  const man = JSON.parse(fs.readFileSync(path.join(cwd, plan1.manifest), "utf8"));
  ok(man.aspects.length === 2 && man.aspects.every((m) => { const p = got1[m.aspect]; return p && m.w === p.w && m.h === p.h && Math.abs(m.duration - p.dur) < 0.002; }), "清单里的尺寸、时长跟 ffprobe 量的一样", man.aspects);
  const coverList = plan1.aspects.flatMap((a) => a.covers);
  ok(coverList.length > 0 && coverList.every((c) => fs.statSync(path.join(cwd, c)).size > 0) && v1.covers.length === coverList.length, "封面都截出来了", { coverList, got: v1.covers });
  ok(Object.values(man.covers).flat().length === coverList.length, "清单里的封面跟盘上的对得上", man.covers);
  // 字幕：这台 ffmpeg 有没有 libass 决定烧不烧；不烧就说出来、文件另附
  const burnedWant = !!bins.ass;
  ok(v1.films.every((f) => f.burned === burnedWant), `字幕${burnedWant ? "烧进了画面" : "没烧进画面"}（这台 ffmpeg ${burnedWant ? "有" : "没有"} libass）`, v1.films);
  if (!burnedWant) ok(plan1.warnings.includes(tc.NO_LIBASS), "没有 libass：开跑前的警告里就说了，不是最后一步才撞上", plan1.warnings);
  ok(v1.subtitleFile === plan1.srt && fs.existsSync(path.join(cwd, plan1.srt)) && plan1.aspects.every((a) => fs.existsSync(path.join(cwd, a.ass))), ".srt 和每个画幅的 .ass 都另附了");
  ok(!fs.existsSync(path.join(cwd, plan1.workDir)), "中间件目录 .work 删掉了");
  // 进度：只增不减，最后一条 100
  const pcts = events.map((e) => e.pct);
  ok(events.length > 3 && pcts.every((x, i) => i === 0 || x >= pcts[i - 1]) && pcts[pcts.length - 1] === 100, "进度只增不减，最后一条是 100", pcts);
  ok(events.every((e) => typeof e.label === "string" && e.label && e.total === plan1.steps.length), "每条进度都带中文标签和总步数", events.slice(0, 3));

  // 声音：片头卡那一秒只有配乐，第一段有人声。只比相对大小
  const film916 = path.join(cwd, plan1.aspects[0].file);
  const dbMusic = meanDb(FF, film916, 0.25, 0.6);
  const dbVoice = meanDb(FF, film916, 1.2, 0.8);
  ok(Number.isFinite(dbMusic) && Number.isFinite(dbVoice) && dbVoice - dbMusic > 3, "有人声的那段比只有配乐的那段响（配乐垫在底下，没盖过人声）", { dbMusic, dbVoice });
  // 只量到收尾前 0.6 秒：最后是线性淡出，测试用的正弦波本来就轻、amix 还按两路除了一半，
  // 最后三四百毫秒本该落到 -50dB 以下。没循环的话 3.8 秒以后整整两秒都没声，这个窗口照样抓得到
  const sil = spawnSync(FF, ["-hide_banner", "-t", (T - 0.6).toFixed(2), "-i", film916, "-map", "0:a", "-af", "silencedetect=n=-50dB:d=0.3", "-f", "null", "-"], { encoding: "utf8" });
  ok(!/silence_start/.test(String(sil.stderr)), "配乐只有 2 秒、片子更长：循环垫满了，中间没有一截没声", String(sil.stderr).match(/silence_\w+: [\d.]+/g));

  // 第二次：名字不撞、一个字节都不覆盖，长度和第一次一帧不差
  const plan2 = tc.timelinePlan(RT_TL(), factsFor(namesIn(plan1.outDir)));
  ok(plan2.ok && plan2.aspects.every((a, i) => a.file !== plan1.aspects[i].file) && plan2.manifest !== plan1.manifest, "再跑一次：换个名字，不覆盖上一次", plan2.ok && plan2.aspects.map((a) => a.file));
  const firstBytes = fs.statSync(film916).size;
  const s2 = jobs.startTimeline({ plan: plan2, bin: bins.ffmpeg, probeBin: bins.ffprobe, cwd, owner: "o1", hooks: { render: fakeCard(FF, cwd) } });
  const v2 = await s2.done;
  ok(!v2.error && fs.statSync(film916).size === firstBytes, "第二次跑完了，第一次那条原样还在", v2.error);
  for (const a of plan2.aspects) {
    const p = probeFilm(FP, path.join(cwd, a.file));
    ok(Math.abs(p.frames - got1[a.aspect].frames) <= 1, `${a.aspect}：两次出片的帧数一样`, { first: got1[a.aspect], second: p });
  }

  // 坏的配音：计划过得去（探针结果是造的），ffmpeg 真跑挂——报错里带 ffmpeg 自己的原话，盘上不留半截
  const badCwd = path.join(TMP, "rt5-bad");
  makeMedia(FF, badCwd);
  const badTl = RT_TL({ intro: false, title: "坏片", segments: [{ visual: { kind: "image", file: "素材/a.png" }, voice: { file: "配音/bad.m4a" } }] });
  const badPlan = tc.timelinePlan(badTl, { ...factsFor(new Set()), exists: (r) => fs.existsSync(path.join(badCwd, r)), probes: { ...probes, "配音/bad.m4a": { dur: 1 } } });
  ok(badPlan.ok, "坏配音的计划排得出来（探针是造的）", badPlan.blockers);
  if (badPlan.ok) {
    const vb = await jobs.startTimeline({ plan: badPlan, bin: bins.ffmpeg, probeBin: bins.ffprobe, cwd: badCwd, owner: "o1" }).done;
    ok(/没成——/.test(vb.error) && /bad\.m4a|Invalid data|退出码/.test(vb.error), "挂了：说哪一步没成，带上 ffmpeg 的原话", vb.error);
    ok(mp4sUnder(path.join(badCwd, "成片")).length === 0, "一条成片都没出来：盘上一个 mp4 都不剩", mp4sUnder(path.join(badCwd, "成片")));
    ok(!fs.existsSync(path.join(badCwd, badPlan.outDir)), "连这一趟新建的成片目录（里面只剩字幕文件）一起收掉", fs.existsSync(path.join(badCwd, badPlan.outDir)) && fs.readdirSync(path.join(badCwd, badPlan.outDir)));
    ok(vb.films.length === 0 && vb.output === "", "失败的任务不报成片");
  }

  // 叫停：开跑就停，半截删掉、.work 删掉，说的是「叫停了」
  const cCwd = path.join(TMP, "rt5-cancel");
  makeMedia(FF, cCwd);
  const cPlan = tc.timelinePlan(RT_TL({ intro: false, title: "停片", segments: [{ visual: { kind: "image", file: "素材/a.png" }, min_seconds: 40 }] }), { ...factsFor(new Set()), exists: (r) => fs.existsSync(path.join(cCwd, r)) });
  ok(cPlan.ok, "要叫停的那条排得出来", cPlan.blockers);
  if (cPlan.ok) {
    const sc = jobs.startTimeline({ plan: cPlan, bin: bins.ffmpeg, probeBin: bins.ffprobe, cwd: cCwd, owner: "o1" });
    const cv = jobs.timelineCancel(sc.job.id, "o1");
    ok(cv && cv.canceled, "叫停：交回的那份已经标了 canceled", cv);
    const vc = await sc.done;
    ok(vc.canceled && /叫停/.test(vc.error), "叫停之后说的是「叫停了」，不是「出错了」", vc.error);
    ok(mp4sUnder(cCwd).filter((f) => !/素材/.test(f)).length === 0 && !fs.existsSync(path.join(cCwd, cPlan.workDir)), "叫停：半截 mp4 和 .work 都删了");
    ok(await jobs.timelineWait(sc.job.id, 10), "跑完（叫停）的任务 timelineWait 立刻说完了");
  }
  ok(jobs.timelineRunning("o1") === null, "都跑完了：这个对话没有在跑的");
}

async function toolWiring(jobs, FF) {
  const compose = require("../src/tools/compose");
  const M = require("../motion-clock");
  const WS = path.join(TMP, "ws6");
  const W = path.join(WS, "任务_1");
  fs.mkdirSync(W, { recursive: true });
  if (FF) makeMedia(FF, W);
  fs.mkdirSync(path.join(WS, "共享"), { recursive: true });
  // tools.js resolveFile 的替身：成果子目录起算，子目录里没有就找工作区根；带 secret 的当黑名单拦
  const resolveFile = (rel) => {
    const s = String(rel == null ? "" : rel).trim();
    if (!s) throw new Error("这次调用没给 path");
    if (/secret/.test(s)) throw new Error("文件访问被安全中心拦截：测试黑名单");
    const abs = path.isAbsolute(s) ? s : path.resolve(W, s);
    if (!fs.existsSync(abs)) { const r2 = path.resolve(WS, s); try { if (fs.statSync(r2).isFile()) return r2; } catch {} }
    return abs;
  };
  const gates = [];
  const security = { DEFAULTS: {}, checkWrite: (_sec, rel) => ({ action: "allow", rel }) };
  const passGate = async (verdict, label, text) => { gates.push({ verdict, label, text }); return null; };
  const bins = FF ? await jobs.composeBins() : { ffmpeg: "", ffprobe: "", install: "brew install ffmpeg" };
  const ctx = (opts = {}, deps = {}) => ({
    resolveFile, fileBase: W, root: WS, security, passGate,
    opts: { sessionId: "sess-a", ...opts },
    deps: { bins: async () => bins, canRender: () => ({ ok: true }), render: FF ? fakeCard(FF, W) : undefined, ...deps },
  });
  const run = (input, opts, deps) => compose.composeVideo(input, ctx(opts, deps));

  // 不需要 ffmpeg 的那几条卡点
  let r = await run({});
  ok(r.isError && /没给时间轴/.test(r.content), "没给 timeline：说要给路径或 JSON", r);
  r = await run({ timeline: "{不是 json" });
  ok(r.isError && /不是合法的 JSON/.test(r.content), "timeline 写坏了的 JSON：说出来", r);
  r = await run({ timeline: "没有这个.json" });
  ok(r.isError && /找不到时间轴文件 没有这个\.json/.test(r.content), "时间轴文件不在：说哪个文件", r);
  r = await run({ timeline: { segments: [{ visual: "素材/secret.png" }] } });
  ok(r.isError && /拦截/.test(r.content) && /素材\/secret\.png/.test(r.content), "被安全策略拦的路径：不去探、直接说被拦了", r);
  r = await run({ timeline: { out_dir: "../外面", segments: [{ visual: "素材/a.png" }] } });
  ok(r.isError && /out_dir/.test(r.content) && !fs.existsSync(path.join(WS, "外面")), "out_dir 带 .. ：不开跑，外面一个目录都不建", r);
  r = await run({ timeline: { brand: "没建过的牌子", segments: [{ visual: "素材/a.png" }] } });
  ok(r.isError && /品牌包还没建/.test(r.content), "brand 写了名字、可一个品牌包都没有：让先建或者直接写 logo/font", r);
  r = await run({ timeline: { segments: [{ visual: "素材/没有.png" }] } });
  ok(r.isError && /素材\/没有\.png/.test(r.content) && /不在盘上/.test(r.content), "画面文件不在：点名是哪个文件", r);
  // 界面那行红字只取第一行：卡在哪得写在头一行，不能只有一句「还不能合成：」
  ok(r.isError && /^还不能合成：.*不在盘上/.test(r.content.split("\n")[0]), "卡点的头一条就写在第一行", r.content.split("\n")[0]);
  if (!FF) ok(r.isError && /ffmpeg/.test(r.content), "没有 ffmpeg：卡点里带装法", r);
  r = await run({ job: "tlc-没有这条" });
  ok(r.isError && /没找到这条合成/.test(r.content), "查一个不存在的任务：说没找到", r);
  r = await run({ cancel: true });
  ok(!r.isError && /没有在跑的合成/.test(r.content), "没东西在跑时叫停：说不用停", r);
  ok(gates.length === 0, "上面这些一条都没走到写盘那扇门", gates);
  eq(compose._internals.mapRefs({ segments: [{ visual: "a.png", voice: "v.m4a" }], music: { file: "m.mp3" }, brand: { logo: "l.png", font: "f.ttf" } }, (s) => "X/" + s),
    { segments: [{ visual: { file: "X/a.png" }, voice: "X/v.m4a" }], music: { file: "X/m.mp3" }, brand: { logo: "X/l.png", font: "X/f.ttf" } }, "mapRefs：每个文件路径都过一遍，字符串画面摊成 {file}");

  if (!FF) { console.log("  跳过：本机没有 ffmpeg（下面几条要真出片）"); return; }

  // 放在工作区根（「共享」）的配乐也认：跟 read_file 一样，子目录里没有就找根
  fs.copyFileSync(path.join(W, "配乐/m.m4a"), path.join(WS, "共享", "bgm.m4a"));
  const TL6 = { ...RT_TL(), aspects: [{ aspect: "9:16", w: 180, h: 320 }], music: { file: "共享/bgm.m4a" } };

  // dry_run：只排，不写盘，不过写盘那扇门
  r = await run({ timeline: JSON.stringify(TL6), dry_run: true });
  const dry = !r.isError && JSON.parse(r.content.slice(r.content.indexOf("{")));
  ok(dry && dry.dry_run && dry.films.length === 1 && dry.costs_money === false && dry.steps > 0, "dry_run：交回计划（几条、多长、几步、不花钱）", r);
  ok(!fs.existsSync(path.join(W, "成片")) && gates.length === 0, "dry_run：盘上一个文件都没写，也没问写盘权限");

  // 真跑：从文件读时间轴，进度走 onProgress，结果说成人话
  fs.writeFileSync(path.join(W, "timeline.json"), JSON.stringify(TL6));
  const events = [];
  r = await run({ timeline: "timeline.json" }, { onProgress: (e) => events.push(e) });
  ok(!r.isError && /成片出来了，1 条/.test(r.content) && /成片\/测试片\/测试片_9x16\.mp4/.test(r.content), "真跑：等到了，报出成片路径（相对成果目录）", r.content);
  ok(/没花钱/.test(r.content), "说了这一步没花钱", r.content);
  ok(fs.statSync(path.join(W, "成片/测试片/测试片_9x16.mp4")).size > 0, "成片真在盘上");
  ok(gates.length === 1 && gates[0].label === "写成片" && gates[0].text === "成片/测试片", "写盘之前过了一次权限档位（写成片、成片目录）", gates);
  ok(events.length > 0 && events.every((e) => ["compose", "encode", "render"].includes(e.stage)), "进度的 stage 只有 compose / encode / render 三种", [...new Set(events.map((e) => e.stage))]);
  ok(events.every((e) => M.displayWidth(e.label) <= 48), "进度标签不超过 24 个汉字宽", events.map((e) => e.label));
  ok(events.length && events[events.length - 1].pct === 100, "最后一条进度是 100", events.slice(-2));
  if (!bins.ass) ok(/没烧进画面/.test(r.content) && /libass/.test(r.content), "没有 libass：结果里如实说字幕没烧进去", r.content);

  // 截止时间快到了：不等，交任务号；再用 job 来查
  r = await run({ timeline: TL6 }, { deadline: Date.now() + 10000 });
  const id = (r.content.match(/任务 (tlc\w+)/) || [])[1] || "";
  ok(!r.isError && id && /开跑了/.test(r.content) && /"job"/.test(r.content), "等不到就先交任务号，告诉模型怎么查", r.content);
  const peek = await run({ job: id }, { sessionId: "sess-b" });
  ok(peek.isError && /没找到这条合成/.test(peek.content), "别的对话拿这个任务号查：当没有", peek);
  r = await run({ job: id });
  ok(!r.isError && /成片出来了/.test(r.content) && /测试片_2_9x16\.mp4/.test(r.content), "用 job 查：等到跑完、报出第二份（换了名字）", r.content);
  r = await run({ job: id, cancel: true });
  ok(!r.isError && /已经跑完了，没什么可停的/.test(r.content), "跑完了再叫停：说没什么可停的", r.content);

  // 叫停：交了任务号之后用 cancel 停掉
  const longTl = { ...TL6, intro: false, title: "长片", segments: [{ visual: "素材/a.png", min_seconds: 40 }] };
  r = await run({ timeline: longTl }, { deadline: Date.now() + 10000 });
  const id2 = (r.content.match(/任务 (tlc\w+)/) || [])[1] || "";
  r = await run({ job: id2, cancel: true });
  ok(!r.isError && /叫停了/.test(r.content), "cancel：叫停了，不算出错", r.content);
  ok(mp4sUnder(path.join(W, "成片/长片")).length === 0, "叫停：没出完的半截没留在盘上", mp4sUnder(path.join(W, "成片")));

  // 用户点停：正在等的那次工具调用当场收手，任务也一起停
  const ac = new AbortController();
  r = await run({ timeline: { ...longTl, title: "停片" } }, { signal: ac.signal, onProgress: () => ac.abort() });
  ok(r.isError && r.stopped === true && /停止/.test(r.content), "用户点停：交回 stopped，合成一起叫停", r);
  await sleepMs(50);
  ok(jobs.timelineRunning("sess-a") === null && mp4sUnder(path.join(W, "成片/停片")).length === 0, "点停之后没有还在跑的，也没留半截");
}

/*
 * 【6】是直接调 compose.composeVideo、ctx 全是替身：tools.js 里 case 名写错、resolveFile / passGate / sec
 * 没递对、onProgress 被 switch 吞了，【6】照样全绿，模型手上却用不了。这里走真的 executeTool：
 * 真 resolveFile（成果子目录起算）、真 passGate（权限档位）、真 security，渲染器用不上（不开片头片尾卡、没有品牌包）
 */
async function dispatchSmoke(FF) {
  const tools = require("../tools");
  const ag = require("../agent");
  const M = require("../motion-clock");

  // 工具定义：参数只增不改；只查任务时没有时间轴，所以必填必须是空的
  const def = tools.TOOL_DEFS.find((t) => t.name === "compose_video");
  const props = (def && def.input_schema && def.input_schema.properties) || {};
  ok(!!def && Array.isArray(def.input_schema.required) && def.input_schema.required.length === 0, "compose_video 在工具定义里，必填为空（只给 job 查任务时没有 timeline）", def && def.input_schema.required);
  ok(["timeline", "dry_run", "job", "cancel"].every((k) => props[k]), "四个参数都在：timeline / dry_run / job / cancel", Object.keys(props));
  ok(!!def && !/[\u{1F300}-\u{1FAFF}]/u.test(def.description) && /不花钱/.test(def.description), "工具说明写了不花钱，没有 emoji", def && def.description);

  // 界面那一行：动词、对象、短标、图标、英文
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
  ok(/^\s*compose_video: "合成视频",$/m.test(agentSrc), "TOOL_VERB 有 compose_video：合成视频");
  eq(ag.toolHeadline("compose_video", { timeline: JSON.stringify({ title: "测试片", segments: [{ visual: "a.png" }] }) }), "合成视频 测试片", "时间轴直接写 JSON：那一行报片名，不把一串括号引号截上去");
  eq(ag.toolHeadline("compose_video", { timeline: "timeline.json", dry_run: true }), "合成视频 timeline.json", "时间轴是文件：报文件名");
  eq(ag.toolHeadline("compose_video", { job: "tlc9", cancel: true }), "合成视频 tlc9", "查 / 停：报任务号");
  ok(M.displayWidth(ag.toolHeadline("compose_video", { timeline: "很长的目录名/".repeat(12) + "timeline.json" })) <= 4 * 2 + 1 + 46 * 2, "路径再长也只留尾巴");
  const app01 = fs.readFileSync(path.join(ROOT, "public", "js", "app-01.js"), "utf8");
  const indexHtml = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const i18nSrc = fs.readFileSync(path.join(ROOT, "public", "js", "i18n.js"), "utf8");
  ok(/^const TOOL_SHORT = \{.*\bcompose_video: "成片"/m.test(app01), "轨迹条短标有 compose_video：成片（TOOL_SHORT 仍是单行）");
  const icon = (app01.match(/^const TOOL_ICON = \{.*\bcompose_video: "([\w-]+)"/m) || [])[1];
  ok(!!icon && indexHtml.includes(`<symbol id="i-${icon}"`), "图标是雪碧图里现成的那个", icon);
  ok(/"合成视频": "Compose video"/.test(i18nSrc) && /"成片": "Final cut"/.test(i18nSrc), "英文界面：动词和短标都有译文");

  // 真分派。TMP 本身是 owb- 开头的 mkdtemp，OPENWORKBUDDY_HOME 在文件头就指进去了
  const WS = path.join(TMP, "ws7");
  const SUB = "任务_7";
  const W = path.join(WS, SUB);
  fs.mkdirSync(W, { recursive: true });
  const SEC = { gateway: false, permission_mode: "auto" };
  const exec = (input, opts) => tools.withWorkspace(WS, () => tools.executeTool("compose_video", input, { security: SEC, baseDir: SUB, sessionId: "sess-7", ...(opts || {}) }));

  let r = await exec({});
  ok(r.isError && /没给时间轴/.test(r.content) && !/未知工具/.test(r.content), "executeTool 分到了 compose_video：回的是工具自己的原话，不是「未知工具」", r);
  r = await exec({ job: "tlc-没有这条" });
  ok(r.isError && /没找到这条合成/.test(r.content), "只给 job 也过得了参数校验（必填为空），查不到照实说", r);

  if (!FF) {
    r = await exec({ timeline: JSON.stringify({ segments: [{ visual: "素材/没有.png" }] }) });
    ok(r.isError && /ffmpeg/.test(r.content), "没有 ffmpeg：卡点里带装法，不开跑", r);
    console.log("  跳过：本机没有 ffmpeg（下面几条要真出片）");
    return;
  }

  makeMedia(FF, W);
  // 素材路径相对成果子目录写；片头片尾卡要浏览器，这里关掉，只验分派和进度
  const TL7 = {
    title: "接线片", fps: 30, intro: false, outro: false,
    aspects: [{ aspect: "9:16", w: 180, h: 320 }],
    segments: [{ visual: "素材/a.png", voice: { sentences: [{ text: "第一句话", file: "配音/v1.m4a" }] }, cover: true }],
  };
  const FILM = path.join(W, "成片", "接线片", "接线片_9x16.mp4");

  // dry_run：只排不写，也不该动进度条（没东西在跑）
  const dryEvents = [];
  r = await exec({ timeline: JSON.stringify(TL7), dry_run: true }, { onProgress: (e) => dryEvents.push(e) });
  ok(!r.isError && /^排好了，没开跑（dry_run）/.test(r.content), "dry_run 从 executeTool 进来也只排片", r.content);
  ok(!fs.existsSync(path.join(W, "成片")), "dry_run：盘上一个文件都没写");

  // 权限档位「只看不动」：真 passGate 拦下写盘，一个文件都不出。证明 sec / passGate 是 tools.js 递进来的真货
  r = await exec({ timeline: JSON.stringify(TL7) }, { security: { gateway: false, permission_mode: "plan" } });
  ok(r.isError && /^写成片被安全中心拦截：.*只看不动/.test(r.content), "只看不动档：写成片被 tools.js 的 passGate 拦下，说清楚是权限档位", r.content);
  ok(mp4sUnder(path.join(W, "成片")).length === 0, "被拦之后盘上没有成片");

  // 真出片：进度从 executeTool 的 onProgress 收到
  const events = [];
  r = await exec({ timeline: JSON.stringify(TL7) }, { onProgress: (e) => events.push(e) });
  ok(!r.isError && /成片出来了/.test(r.content) && /成片\/接线片\/接线片_9x16\.mp4/.test(r.content), "executeTool 真出片：报出成片路径（相对成果子目录）", r.content);
  ok(fs.existsSync(FILM) && fs.statSync(FILM).size > 0, "成片落在这个对话的成果子目录里", FILM);
  ok(events.length > 0, "进度事件到了 executeTool 的 onProgress（没被 switch 吞掉）", events.length);
  ok(events.every((e) => ["compose", "encode", "render"].includes(e.stage) && typeof e.pct === "number" && typeof e.label === "string" && e.label), "每条进度都带 stage / pct / 标签", events.slice(0, 3));
  ok(events.every((e) => M.displayWidth(e.label) <= 48), "进度标签不超过 24 个汉字宽", events.map((e) => e.label));
  ok(events.length && events[events.length - 1].pct === 100, "最后一条进度是 100", events.slice(-2));
  ok(dryEvents.length === 0, "dry_run 那次一条进度都没发", dryEvents);
}

runtimeSections()
  .catch((e) => { fail++; console.log("  ✗ 【5】【6】半路抛了：" + ((e && e.stack) || e)); })
  .then(() => {
    console.log(`\n${pass} 过 / ${fail} 挂`);
    globalThis.fetch = realFetch;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(fail ? 1 : 0);
  });
