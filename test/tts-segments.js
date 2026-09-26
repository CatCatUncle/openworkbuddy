"use strict";
/**
 * 按句配音（text_to_speech 的 segments 模式）。
 *
 *   node test/tts-segments.js
 *
 * 这一路是按字数扣费的，坏法分两类，而且都不报错：
 *   · 白花钱：改一句重配整批、插一句全批失效、上游收了单又自动重试、没装 ffmpeg 先买了一堆句子；
 *   · 对不上嘴：时长拿 mp3 容器里写的数，字幕一句句往后漂。
 * 所以这里数的是**上游被打了几次**（假 fetch 计数），不是回执里写了什么——回执是被测代码自己写的，
 * 拿它当证据等于自证。每条「该省」的断言后面都跟一条「不该省」的对照：该重配的时候必须真去重配。
 *
 * 前半段不碰真 ffmpeg（量时长用读 WAV 头顶替，拼整轨用 media-probe 的纯 JS 拼接），CI 上也跑；
 * 最后一段用本机真 ffmpeg 生成、解码、拼接，再拿 ffmpeg 自己的 silencedetect 听静音落在哪。
 * 没有 ffmpeg 就明说跳过；设了 OWB_REQUIRE_FFMPEG=1 的机器上没有 ffmpeg 算失败。
 * 全程不联网：没登记的地址一律当场抛错并计数。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400) : "")); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}

// 家目录和工作空间都指到临时盘：生成缓存的索引、额度账、审计日志都落在家目录下，不隔离就写进开发者自己那份
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ttsseg-home-"));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ttsseg-ws-"));
process.env.OPENWORKBUDDY_HOME = HOME;

const tools = require(path.join(ROOT, "tools")); // 先加载它：配音落盘要靠它绑定的工作空间
const TTSB = require(path.join(ROOT, "src/tools/tts-batch"));
const MEDIA = require(path.join(ROOT, "src/tools/media"));
const MP = require(path.join(ROOT, "lib/media-probe"));
const mm = require(path.join(ROOT, "media-models"));
const genCache = require(path.join(ROOT, "gen-cache"));
const quota = require(path.join(ROOT, "quota"));
const pricing = require(path.join(ROOT, "pricing"));
const mediaHealth = require(path.join(ROOT, "media-health"));

const GW = "https://gw.example.test/v1";
const DASH = "https://dashscope.example.test/api/v1";
const DL = "https://dashscope-result.example.test/audio/";

function mediaOf(tts) {
  const c = { media: tts ? { tts } : {} };
  mm.normalize(c);
  return mm.resolve(c);
}
// Key 只要一眼看得出是假的；这几条路一个字节都不会真发出去
const MEDIA_OA = mediaOf({ base_url: GW, api_key: "sk-fake", model: "tts-1", voice: "alloy" });
const MEDIA_DS = mediaOf({ base_url: DASH, api_key: "sk-fake", model: "qwen3-tts-flash", voice: "" });
const MEDIA_NONE = mediaOf(null);

// ── 假上游：按文字回一段已知时长的 PCM WAV，每句的采样值是一个认得出的记号 ──
const T1 = "第一句台词。", T2 = "第二句。", T3 = "第三句要长一点。";
const DUR = new Map([[T1, 1234], [T2, 800], [T3, 2000]]);
const durOf = (t) => DUR.get(t) || 400 + 50 * Array.from(t).length;
const markers = new Map();
const markerOf = (t) => { if (!markers.has(t)) markers.set(t, 1001 + markers.size * 7); return markers.get(t); };
let clipRate = 24000;
/** @type {Map<string, string> | null} 真 ffmpeg 那段：文字 → 真音频文件 */
let realClips = null;

function wavBytes(ms, marker, rate) {
  const n = MP.msToSamples(ms, rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(marker, i * 2);
  return Buffer.concat([MP.wavHeader({ rate, dataBytes: n * 2 }), data]);
}
function clipBytes(text) {
  if (realClips) {
    const f = realClips.get(text);
    if (!f) throw new Error("真音频表里没有这句：" + text);
    return fs.readFileSync(f);
  }
  return wavBytes(durOf(text), markerOf(text), clipRate);
}
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const R = {
  bin: (b) => ({ ok: true, status: 200, json: async () => ({}), text: async () => "", arrayBuffer: async () => ab(b) }),
  json: (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), arrayBuffer: async () => new ArrayBuffer(0) }),
  err: (status, t) => ({
    ok: false, status, text: async () => t, arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => { try { return JSON.parse(t); } catch { return {}; } },
  }),
};

const hits = { post: 0, get: 0, unknown: 0 };
/** @type {any[]} */
const bodies = [];
const dl = new Map();
/** @type {{ text: string, status?: number, body?: string, throw?: string } | null} */
let failRule = null;
const said = (b) => (typeof b.input === "string" ? b.input : (b.input || {}).text);

const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = String(init.method || "GET").toUpperCase();
  const isOA = u === GW + "/audio/speech";
  const isDS = u === DASH + "/services/aigc/multimodal-generation/generation";
  if (method === "POST" && (isOA || isDS)) {
    hits.post++;
    const body = JSON.parse(String(init.body || "{}"));
    bodies.push(body);
    const text = said(body);
    if (failRule && failRule.text === text) {
      if (failRule.throw) throw new TypeError(failRule.throw);
      return R.err(failRule.status || 500, failRule.body || "");
    }
    if (isOA) return R.bin(clipBytes(text));
    const u2 = DL + (dl.size + 1) + ".wav";
    dl.set(u2, text);
    return R.json({ output: { audio: { url: u2 } } });
  }
  if (method === "GET" && dl.has(u)) { hits.get++; return R.bin(clipBytes(dl.get(u))); }
  hits.unknown++;
  throw new Error(`测试路由里没有这个地址：${method} ${u}`);
};

// ── 额度三件套换成记录器：只记谁被叫了、带了什么，不去碰真账本 ──
const realQuota = { gate: quota.gate, record: quota.record, undo: quota.undo };
/** @type {any[]} */ const recs = [];
/** @type {any[]} */ const undos = [];
/** @type {any[]} */ const qgates = [];
let qgateRet = { ok: true, hold: null };
quota.record = (cap, a) => { recs.push({ cap, ...a }); };
quota.undo = (h) => { undos.push(h); };
quota.gate = (cap, call) => { qgates.push({ cap, call }); return qgateRet; };

// ── 调用方递进来的额度闸（tools.js 那边是 quotaGate("tts", c)），这里换成记录器 ──
let holdSeq = 0;
/** @type {any[]} */ const gates = [];
/** @type {any} */ let gateBad = null;
const gateSpy = (call) => {
  gates.push(call);
  if (gateBad) return { bad: gateBad, hold: null };
  return { bad: null, hold: { id: "h" + ++holdSeq } };
};

// ── 不碰真 ffmpeg 的量时长：读 WAV 头顶替 ffprobe，原样拷贝顶替解码；拼整轨用真的（写 .wav 是纯 JS） ──
const FAKE_BINS = async () => ({
  ffmpeg: { bin: "/fake/ffmpeg", how: "test", why: "" },
  ffprobe: { bin: "/fake/ffprobe", how: "test", why: "" },
  install: "brew install ffmpeg",
});
async function fakeProbe(_fp, abs) {
  const w = MP.readWavInfo(abs);
  return w ? { samples: w.samples, sampleRate: w.sampleRate, ms: MP.samplesToMs(w.samples, w.sampleRate), codec: "pcm_s16le", channels: w.channels, exact: true } : null;
}
async function fakeToPcm(_ff, inAbs, outAbs, o) {
  fs.copyFileSync(inAbs, outAbs);
  const w = MP.readWavInfo(outAbs);
  if (!w || w.sampleRate !== o.rate) throw new Error(`假解码只会原样拷贝：${path.basename(inAbs)} 不是 ${o.rate}Hz`);
  return w;
}
const fakeDeps = (extra) => ({ bins: FAKE_BINS, probe: fakeProbe, toPcm: fakeToPcm, ...(extra || {}) });

const SAVE = path.join(WS, "任务_配音");
const resolveFile = (rel) => path.join(WS, String(rel || ""));

async function run(input, o = {}) {
  const p0 = hits.post, g0 = hits.get, b0 = bodies.length, gt0 = gates.length, r0 = recs.length, u0 = undos.length, q0 = qgates.length;
  const res = await TTSB.ttsSegments({
    media: o.media || MEDIA_OA, input, timeoutMs: 1000, saveDir: o.saveDir || SAVE, wsRoot: WS, resolveFile,
    stop: o.stop, gate: "gate" in o ? o.gate : gateSpy, onProgress: o.onProgress,
  }, "deps" in o ? o.deps : fakeDeps());
  return {
    res, posts: hits.post - p0, gets: hits.get - g0, bodies: bodies.slice(b0), gates: gates.slice(gt0),
    recs: recs.slice(r0), undos: undos.slice(u0), qgates: qgates.slice(q0),
  };
}
const manifestOf = (stem, dir = SAVE) => JSON.parse(fs.readFileSync(path.join(dir, stem + ".json"), "utf8"));
const lastRec = () => recs[recs.length - 1];
const owbTtsTmp = () => { try { return fs.readdirSync(os.tmpdir()).filter((n) => /^owb-tts-/.test(n)); } catch { return []; } };
function walk(dir) {
  /** @type {string[]} */ const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
const PROGRESS_STAGES = new Set(["load", "render", "encode", "tts", "shot", "step", "compose", "upload", "transcode"]);

(async () => {
  const tmpBefore = new Set(owbTtsTmp());
  await tools.withWorkspace(WS, async () => {
    // ───────────────────────────────────────────────────────────────
    console.log("【1】纯计算：参数检查、分句文件名、时间轴、字幕");
    {
      const v = TTSB.validate({ segments: ["  第一行\n  第二行 ", { text: "带音色", voice: " Cherry " }] });
      eq(v.ok && [v.segs, v.gapMs, v.stem, v.fullExt], [[{ text: "第一行 第二行", voice: "" }, { text: "带音色", voice: "Cherry" }], 300, "旁白", ".wav"],
        "换行压成空格、音色去空白；默认停顿 300ms、默认整轨叫「旁白.wav」（拼片按「旁白」认人声）");
      eq(TTSB.validate({ segments: ["a"], text: "" }).ok, true, "text 给了空串不算「两个都给」");
      eq([-5, 99999, "250", 12.6].map((g) => { const r = TTSB.validate({ segments: ["a"], gap_ms: g }); return r.ok && r.gapMs; }), [0, 3000, 250, 13],
        "gap_ms 夹在 0–3000 之间，数字串也认，四舍五入到整毫秒");
      const names = [["a/b:c.mp3", "a_b_c", ".mp3"], ["片头", "片头", ".wav"], [".mp3", "旁白", ".mp3"], ["结尾.WAV", "结尾", ".wav"], ["长".repeat(70) + ".wav", "长".repeat(60), ".wav"]];
      eq(names.map(([f]) => { const r = TTSB.validate({ segments: ["a"], filename: f }); return r.ok ? [r.stem, r.fullExt] : r.content; }), names.map(([, s, e]) => [s, e]),
        "整轨名：路径符号换成 _、没后缀补 .wav、只给后缀就用默认名、主名封顶 60 字（分句文件还要接哈希）");
      eq(TTSB.isBatch({ segments: [] }) && !TTSB.isBatch({ text: "x" }) && !TTSB.isBatch(null), true, "isBatch 只看有没有 segments");

      const f1 = TTSB.segFileName("旁白", ".mp3", { model: "tts-1", voice: "alloy", text: T1 });
      ok(/^旁白_[0-9a-f]{8}\.mp3$/.test(f1), "分句文件名 = 整轨名 + 8 位内容哈希", f1);
      eq(TTSB.segFileName("旁白", ".mp3", { model: "tts-1", voice: "alloy", text: T1 }), f1, "同样的参数算出同一个名字");
      const variants = [
        { model: "tts-1", voice: "alloy", text: T2 }, { model: "tts-1", voice: "nova", text: T1 },
        { model: "tts-1-hd", voice: "alloy", text: T1 }, { model: "tts-1", voice: "alloy", speed: 1.2, text: T1 },
      ];
      ok(variants.every((p) => TTSB.segFileName("旁白", ".mp3", p) !== f1), "改字、换音色、换模型、改语速，名字都得变（不然缓存拿旧声音冒充）");

      const tl = TTSB.planTimeline([29616, 19200, 48000], 24000, 300);
      eq([tl.rows.map((r) => [r.start_ms, r.end_ms, r.ms, r.slot_ms]), tl.total_ms],
        [[[0, 1234, 1234, 1534], [1534, 2334, 800, 1100], [2634, 4634, 2000, 2300]], 4634],
        "1234 / 800 / 2000ms、停顿 300：起点 0 / 1534 / 2634，总长 4634，最后一句后面不留停顿");
      const srt = TTSB.buildSegSrt([{ text: T1, start_ms: 0, end_ms: 1234 }, { text: T2, start_ms: 1534, end_ms: 2334 }]);
      eq(srt, `1\n00:00:00,000 --> 00:00:01,234\n${T1}\n\n2\n00:00:01,534 --> 00:00:02,334\n${T2}\n`, "句级字幕：一句一条，结束在念完那一刻，不拖到停顿里");

      eq(MEDIA.unitsFor("tts", { segments: ["一二三", { text: "四五" }, "  六  "] }), 0.006, "计费量 = 每句字数加起来 / 1000（额度闸和预估都走它）");
      eq([MEDIA.unitsFor("tts", { segments: [] }), MEDIA.unitsFor("tts", { text: "abcd" })], [0.001, 0.004], "空批给个最小量；整段模式照旧按 text 算");

      const src = fs.readFileSync(path.join(ROOT, "src/tools/tts-batch.js"), "utf8");
      ok(!/child_process|spawn\(|execFile|exec\(/.test(src), "按句配音自己不起任何子进程：没有系统 say 兜底，ffmpeg 全走 media-probe");
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【2】花钱之前拦下：参数不对、没配语音、缺音色、没装 ffmpeg，上游一次都不打");
    {
      const bad = [
        [{ text: "整段", segments: ["一句"] }, /二选一.*没花钱/],
        [{ segments: "一句" }, /要是数组/],
        [{ segments: [] }, /是空的/],
        [{ segments: Array.from({ length: 61 }, (_, i) => `第${i}句`) }, /最多 60 句，这次 61 句/],
        [{ segments: ["好", 3] }, /第 2 句格式不对/],
        [{ segments: ["好", { text: "  " }] }, /第 2 句是空的/],
        [{ segments: ["好", "长".repeat(601)] }, /第 2 句有 601 字，单句上限 600/],
        [{ segments: ["好"], gap_ms: "半秒" }, /gap_ms 要是毫秒数/],
        [{ segments: ["好"], filename: "旁白.m4a" }, /整轨只能是 \.wav 或 \.mp3，给的是「\.m4a」/],
      ];
      for (const [input, re] of bad) {
        const r = await run(input);
        ok(r.res.isError && re.test(r.res.content) && r.posts === 0 && r.gates.length === 0,
          `拦下：${String(re).slice(1, 24)}（上游 0 次、额度没问）`, { content: r.res.content, posts: r.posts });
      }

      const unset = await run({ segments: ["一句"] }, { media: MEDIA_NONE });
      ok(unset.res.isError && unset.res.content === MEDIA.TTS_UNSET && unset.posts === 0, "没配语音：跟整段模式说同一句话，去哪儿配写清楚", unset.res.content);
      const nope = await run({ segments: ["一句"], model: "nope-model" });
      ok(nope.res.isError && /nope-model/.test(nope.res.content) && nope.posts === 0, "点名的模型不存在：原话报回去，不换一个顶上", nope.res.content);

      const dsNo = await run({ segments: ["你好。"] }, { media: MEDIA_DS });
      ok(dsNo.res.isError && /第 1 句没有/.test(dsNo.res.content) && /Cherry \/ Serena \/ Ethan \/ Chelsie/.test(dsNo.res.content) && /没花钱/.test(dsNo.res.content) && dsNo.posts === 0,
        "通义没音色：列出能选的，让人挑，不替他挑", dsNo.res.content);
      const dsHalf = await run({ segments: [{ text: "你好。", voice: "Cherry" }, "再见。"] }, { media: MEDIA_DS });
      ok(dsHalf.res.isError && /第 2 句没有/.test(dsHalf.res.content) && dsHalf.posts === 0, "只有第 1 句带音色：第 2 句跑到才撞 400，所以开跑前就拦", dsHalf.res.content);

      const noBin = { bin: "", how: "", why: "没找到" };
      const both = await run({ segments: ["一句"] }, { deps: fakeDeps({ bins: async () => ({ ffmpeg: noBin, ffprobe: noBin, install: "brew install ffmpeg" }) }) });
      ok(both.res.isError && /没找到 ffmpeg 和 ffprobe/.test(both.res.content) && /brew install ffmpeg/.test(both.res.content) && /没花钱/.test(both.res.content) && both.posts === 0 && both.gates.length === 0,
        "没装 ffmpeg：先说装法，一句都不买（买了也量不了时长）", both.res.content);
      const noProbe = await run({ segments: ["一句"] }, { deps: fakeDeps({ bins: async () => ({ ffmpeg: { bin: "/fake/ffmpeg" }, ffprobe: noBin, install: "brew install ffmpeg" }) }) });
      ok(/没找到 ffprobe。/.test(noProbe.res.content) && !/ffmpeg 和/.test(noProbe.res.content) && noProbe.posts === 0, "只缺 ffprobe 就只说 ffprobe", noProbe.res.content);
      const threw = await run({ segments: ["一句"] }, { deps: fakeDeps({ bins: async () => { throw new Error("找不动"); } }) });
      ok(/没找到 ffmpeg 和 ffprobe/.test(threw.res.content) && /装 ffmpeg/.test(threw.res.content) && threw.posts === 0, "找 ffmpeg 本身出错：当没找到，照样不花钱", threw.res.content);

      const good = await run({ segments: ["对照这一句。"], filename: "对照.wav" });
      ok(!good.res.isError && good.posts === 1 && good.gates.length === 1, "反向对照：参数齐了真的会去调上游（上面那些 0 次不是因为根本没接线）", good.res.content);
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【3】时间轴、整轨、字幕、时长清单：用的是同一份采样数");
    {
      const r = await run({ segments: [T1, T2, T3], filename: "旁白.wav" });
      ok(!r.res.isError && r.res.file === "旁白.wav", "成功，报出整轨文件名", r.res.content);
      eq([r.posts, r.gates.length, r.gates[0] && r.gates[0].n, r.gates[0] && r.gates[0].units], [3, 1, 3, 0.018], "三句都新买：额度问一次，按 3 句、18 字问");
      eq(r.bodies.map((b) => [b.model, b.input, b.voice]), [["tts-1", T1, "alloy"], ["tts-1", T2, "alloy"], ["tts-1", T3, "alloy"]], "一句一次请求，用的是设置里的模型和音色");

      const m = manifestOf("旁白");
      const segDirRel = "任务_配音/旁白_分句/";
      const clip = (t) => segDirRel + TTSB.segFileName("旁白", ".mp3", { model: "tts-1", voice: "alloy", text: t });
      eq([m.v, m.kind, m.model, m.voice, m.sample_rate, m.gap_ms, m.total_ms, m.full, m.srt], [1, "tts_segments", "tts-1", "alloy", 24000, 300, 4634, "任务_配音/旁白.wav", "任务_配音/旁白.srt"],
        "时长清单：采样率、停顿、总长、整轨和字幕的相对路径");
      eq(m.segments.map((s) => [s.i, s.text, s.voice, s.file, s.ms, s.start_ms, s.end_ms, s.slot_ms, s.cached]), [
        [1, T1, "alloy", clip(T1), 1234, 0, 1234, 1534, false],
        [2, T2, "alloy", clip(T2), 800, 1534, 2334, 1100, false],
        [3, T3, "alloy", clip(T3), 2000, 2634, 4634, 2300, false],
      ], "每句：文件、实测时长、起止、排镜头用的 slot_ms");
      ok(m.segments.every((s) => fs.existsSync(path.join(WS, s.file))), "清单里的分句文件都真在");
      eq(fs.readFileSync(path.join(SAVE, "旁白.srt"), "utf8"),
        `1\n00:00:00,000 --> 00:00:01,234\n${T1}\n\n2\n00:00:01,534 --> 00:00:02,334\n${T2}\n\n3\n00:00:02,634 --> 00:00:04,634\n${T3}\n`, "字幕文件逐字对");

      const full = path.join(SAVE, "旁白.wav");
      const w = MP.readWavInfo(full);
      eq(w && [w.samples, w.sampleRate, w.channels], [111216, 24000, 1], "整轨 = 4634ms × 24 = 111216 个采样，一个不多一个不少");
      const buf = fs.readFileSync(full);
      const at = (i) => buf.readInt16LE(w.dataOffset + i * 2);
      const [m1, m2, m3] = [T1, T2, T3].map(markerOf);
      eq([at(0), at(29615), at(29616), at(36815), at(36816), at(56015), at(56016), at(63215), at(63216), at(111215)],
        [m1, m1, 0, 0, m2, m2, 0, 0, m3, m3], "每句的声音正好落在清单说的采样位置上，停顿处是静音");
      let quiet = true;
      for (const [a, b] of [[29616, 36816], [56016, 63216]]) for (let i = a; i < b; i++) if (at(i) !== 0) { quiet = false; break; }
      ok(quiet, "两段停顿里每个采样都是 0");

      const lines = r.res.content.split("\n");
      eq(lines, [
        "按句配音完成：3 句，整轨 4.63 秒（句间停顿 300ms）",
        "整轨：任务_配音/旁白.wav",
        "字幕：任务_配音/旁白.srt",
        "时长清单：任务_配音/旁白.json",
        `#1  1.23s  0.00→1.23  「${T1}」`,
        `#2  0.80s  1.53→2.33  「${T2}」`,
        `#3  2.00s  2.63→4.63  「${T3}」`,
        "新合成 3 句（约 18 字）；要整批重配加 no_cache: true",
        "排镜头：每镜 ≥ 该句 ms + gap_ms（清单里的 slot_ms）",
      ], "回执逐行对：路径、每句时长、花了多少、怎么排镜头");
      const rec = lastRec();
      eq(rec && [rec.cap, rec.n, rec.units, rec.model, rec.meta, rec.hold && rec.hold.id], ["tts", 3, 0.018, "tts-1", "按句配音 3 句", r.gates.length && "h" + holdSeq],
        "记账：3 句 18 字，带着问额度时拿到的那笔预扣");

      const g0 = await run({ segments: [T1, T2, T3], filename: "旁白.wav", gap_ms: 0 });
      const m0 = manifestOf("旁白");
      eq([g0.posts, g0.gates.length, m0.gap_ms, m0.segments.map((s) => s.start_ms), m0.total_ms, MP.readWavInfo(full).samples],
        [0, 0, 0, [0, 1234, 2034], 4034, 96816], "只改停顿：一句都不重买，时间轴和整轨按新停顿重排");
      ok(m0.segments.every((s) => s.cached) && /3 句参数都没变，全部直接复用、没再花钱/.test(g0.res.content), "清单标明都是复用的，回执说没再花钱", g0.res.content);

      const long = "长句" + "测".repeat(28);
      const lr = await run({ segments: [long], filename: "长句.wav" });
      ok(lr.res.content.includes(`「${Array.from(long).slice(0, 24).join("")}…」`), "回执里长句只露前 24 个字，整句在字幕和清单里", lr.res.content);
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【4】进度：400ms 最多一次，最后一下必到，报错不拖垮配音");
    {
      const same = [];
      await run({ segments: [T1, T2, T3], filename: "旁白.wav" }, { onProgress: (p) => same.push(p), deps: fakeDeps({ now: () => 1000 }) });
      eq(same.map((p) => p.label), ["配音 0/3 段", "配音 3/3 段", "拼整轨 100%"], "时钟不走：只有开头、配音最后一段、拼完这三下（中间的都被节流掉）");
      let t = 0;
      const all = [];
      await run({ segments: [T1, T2, T3], filename: "旁白.wav" }, { onProgress: (p) => all.push(p), deps: fakeDeps({ now: () => (t += 500) }) });
      eq(all.map((p) => p.label), ["配音 0/3 段", "配音 1/3 段", "配音 2/3 段", "配音 3/3 段", "拼整轨 0%", "拼整轨 30%", "拼整轨 60%", "拼整轨 90%", "拼整轨 100%"],
        "时钟每次走 500ms：每一步都报，配音按段、拼整轨按百分比");
      const shapeOk = [...same, ...all].every((p) => PROGRESS_STAGES.has(p.stage) && typeof p.label === "string" && Array.from(p.label).length <= 24 &&
        (p.stage === "tts" ? Number.isInteger(p.done) && Number.isInteger(p.total) && p.done >= 0 && p.done <= p.total : Number.isInteger(p.pct) && p.pct >= 0 && p.pct <= 100));
      ok(shapeOk, "每一下都是约定的形状：stage 在清单里、标签 ≤24 字、配音带 done/total、拼整轨带 pct");
      const lastP = all[all.length - 1];
      ok(lastP.stage === "compose" && lastP.pct === 100, "最后一下是拼整轨 100%");
      const boom = await run({ segments: [T1, T2, T3], filename: "旁白.wav" }, { onProgress: () => { throw new Error("界面那头炸了"); } });
      ok(!boom.res.isError, "进度回调抛错：配音照样做完", boom.res.content);
      const none = await run({ segments: [T1], filename: "无进度.wav" }, { onProgress: undefined });
      ok(!none.res.isError, "不传进度回调也照常跑");
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【5】缓存：改一句只重配一句，插一句只多买一句");
    {
      const A = "甲说了一句。", B = "乙回了一句。", C = "丙最后说。", B2 = "乙改了一句。", Z = "新插的开场。";
      const r1 = await run({ segments: [A, B, C], filename: "缓存.wav" });
      eq(r1.posts, 3, "第一次：三句都买");
      const r2 = await run({ segments: [A, B, C], filename: "缓存.wav" });
      eq([r2.posts, r2.gates.length, r2.recs.length, r2.undos.length], [0, 0, 0, 1], "原样再调：上游 0 次、不问额度、不记账（预扣为空也照样退一次）");
      const r3 = await run({ segments: [A, B2, C], filename: "缓存.wav" });
      eq([r3.posts, r3.bodies.map(said), r3.gates.map((g) => [g.n, g.units])], [1, [B2], [[1, 0.006]]], "改第 2 句：只重配这一句，额度也只按这一句问");
      eq(manifestOf("缓存").segments.map((s) => s.cached), [true, false, true], "清单标出哪句是新配的");
      const r4 = await run({ segments: [Z, A, B2, C], filename: "缓存.wav" });
      eq([r4.posts, r4.bodies.map(said)], [1, [Z]], "前面插一句：后面三句不挪窝（文件名按内容算，不按序号）");
      const r5 = await run({ segments: [Z, A, B2, C], filename: "缓存.wav", no_cache: true });
      eq([r5.posts, r5.gates.map((g) => g.n)], [4, [4]], "反向对照：no_cache 就是整批重配，一句不少");
      const r6 = await run({ segments: [Z, A, B2, C], filename: "缓存.wav" });
      eq(r6.posts, 0, "no_cache 重配出来的照样记进缓存：下次不带它就复用");
      const r7 = await run({ segments: [Z, A, B2, C], filename: "缓存.wav", voice: "nova" });
      eq([r7.posts, [...new Set(r7.bodies.map((b) => b.voice))]], [4, ["nova"]], "反向对照：整批换音色，四句都得重配");
      const r8 = await run({ segments: [Z, { text: A, voice: "echo" }, B2, C], filename: "缓存.wav" });
      eq([r8.posts, r8.bodies.map((b) => [said(b), b.voice])], [1, [[A, "echo"]]], "单句换音色（对白换人）：只重配那一句");
      eq(manifestOf("缓存").segments.map((s) => s.voice), ["alloy", "echo", "alloy", "alloy"], "清单里每句记着自己的音色");
      const cFile = path.join(WS, manifestOf("缓存").segments[3].file);
      fs.rmSync(cFile);
      const r9 = await run({ segments: [Z, { text: A, voice: "echo" }, B2, C], filename: "缓存.wav" });
      ok(r9.posts === 1 && said(r9.bodies[0]) === C && fs.existsSync(cFile), "用户删了一句的文件：只补那一句，不拿指向空气的指针凑数", { posts: r9.posts });
      const r10 = await run({ segments: [Z, A, B2, C], filename: "缓存.wav", speed: 1.25 });
      eq([r10.posts, [...new Set(r10.bodies.map((b) => b.speed))]], [4, [1.25]], "反向对照：改语速，整批重配，语速真带上去");

      const d = await run({ segments: ["嗯。", "好的。", "嗯。"], filename: "对白.wav" });
      eq([d.posts, d.bodies.map(said), d.gates.map((g) => [g.n, g.units]), d.recs.map((x) => x.n)], [2, ["嗯。", "好的。"], [[2, 0.005]], [2]],
        "同一批里一模一样的两句只买一次，额度和记账也按 2 句");
      const dm = manifestOf("对白");
      ok(dm.segments[2].file === dm.segments[0].file && dm.segments[2].cached && !dm.segments[0].cached && dm.segments[2].start_ms > dm.segments[1].end_ms,
        "第 3 句用第 1 句的文件，但在时间轴上照样排在自己的位置", dm.segments);
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【6】额度：只按要新买的句子问，问不下来一分不花");
    {
      const A = "甲说了一句。", B = "乙回了一句。", N = "新的一句。";
      const q1 = await run({ segments: [A, B], filename: "额度.wav" });
      const rec = q1.recs[0] || {};
      eq([q1.recs.length, rec.cap, rec.n, rec.units, rec.provider, rec.model, rec.meta, rec.hold && rec.hold.id, q1.undos.length],
        [1, "tts", 2, 0.012, MEDIA.mediaProviderOf(MEDIA_OA, "tts"), "tts-1", "按句配音 2 句", "h" + holdSeq, 0], "记账字段：句数、字数、渠道、模型、预扣，记一次");

      const hitsBefore = genCache.stats().hits;
      gateBad = { content: "本月配音额度用完了（测试）", isError: true };
      const q2 = await run({ segments: [A, N], filename: "额度.wav" });
      gateBad = null;
      ok(q2.res.content ==="本月配音额度用完了（测试）" && q2.res.isError, "额度闸说不行：原话交回去", q2.res.content);
      eq([q2.posts, q2.gates.map((g) => g.n), q2.recs.length, q2.undos.length], [0, [1], 0, 0], "被拦下：上游 0 次；问的是 1 句（A 已有缓存不算）；不记账");
      eq(genCache.stats().hits, hitsBefore, "被拦下的那批不在缓存上记「命中」（数新句子用的是只看不碰的 peek）");

      qgateRet = { ok: false, why: "今天配音次数到上限了（测试）", hold: null };
      const q3 = await run({ segments: [A, N], filename: "额度.wav" }, { gate: undefined });
      ok(q3.res.isError && q3.res.content === "今天配音次数到上限了（测试）" && q3.posts === 0, "没递额度闸进来：自己去问 quota.gate，照样拦", q3.res.content);
      eq(q3.qgates.map((g) => [g.cap, g.call.n, g.call.units]), [["tts", 1, 0.005]], "问的是 tts 这一路、1 句、5 字");
      const H2 = { id: "quota-hold" };
      qgateRet = { ok: true, hold: H2 };
      const q4 = await run({ segments: [A, N], filename: "额度.wav" }, { gate: undefined });
      ok(!q4.res.isError && q4.posts === 1 && q4.recs[0] && q4.recs[0].hold === H2 && q4.recs[0].n === 1, "放行后照常买，记账带着 quota.gate 给的那笔预扣", q4.res.content);
      qgateRet = { ok: true, hold: null };

      // 命中是花钱前 peek 出来的，额度只问了没命中的几句：这一批自己记缓存挤掉的、问额度那会儿没了的，都不能变成没问额度就买
      const L1 = "淘汰前一句。", L2 = "淘汰后一句。", LN = "挤掉别人的新句。", LX = "问额度时丢缓存。";
      await run({ segments: [L1, L2], filename: "淘汰.wav" });
      const db = JSON.parse(fs.readFileSync(genCache.FILE, "utf8"));
      const mine = Object.keys(db.items).filter((id) => String(db.items[id].file).includes("淘汰_分句/"));
      mine.forEach((id, j) => { db.items[id].last = j + 1; }); // 这两句最久没用过：索引一满，先淘汰它们
      const pad = genCache.MAX_ENTRIES - Object.keys(db.items).length;
      for (let j = 0; j < pad; j++) db.items["pad" + j] = { file: `占位/${j}.mp3`, content: "", model: "", at: 1, last: Date.now() - 60000, hits: 0 };
      fs.writeFileSync(genCache.FILE, JSON.stringify(db));
      ok(mine.length === 2 && pad >= 0, "索引垫满到上限，这一批的两句命中排在最老", { mine: mine.length, pad });
      const ev = await run({ segments: [LN, L1, L2], filename: "淘汰.wav" });
      eq([ev.res.isError, ev.posts, ev.bodies.map(said), ev.gates.map((g) => g.n), ev.recs.map((x) => x.n)], [false, 1, [LN], [1], [1]],
        "买第 1 句记缓存时挤满了索引：后面两句命中不被挤掉，上游只打 1 次，跟问过的额度对得上");
      const db2 = JSON.parse(fs.readFileSync(genCache.FILE, "utf8"));
      for (const id of Object.keys(db2.items)) if (id.startsWith("pad")) delete db2.items[id];
      fs.writeFileSync(genCache.FILE, JSON.stringify(db2));

      const l1Clip = path.join(SAVE, "淘汰_分句", TTSB.segFileName("淘汰", ".mp3", { model: "tts-1", voice: "alloy", text: L1 }));
      const lost = await run({ segments: [LX, L1], filename: "淘汰.wav" }, { gate: (c) => { const g = gateSpy(c); fs.rmSync(l1Clip, { force: true }); return g; } });
      ok(lost.res.isError && !lost.res.stopped && /第 2 句的缓存刚刚没了/.test(lost.res.content) && /一句都没花钱/.test(lost.res.content), "问额度那会儿命中没了：照实说，一句不买", lost.res.content);
      eq([lost.posts, lost.gates.map((g) => g.n), lost.recs.length, lost.undos.map((h) => h && h.id)], [0, [1], 0, ["h" + holdSeq]], "上游 0 次、不记账、预扣退回去");
      const back = await run({ segments: [LX, L1], filename: "淘汰.wav" });
      eq([back.posts, back.gates.map((g) => g.n), back.recs.map((x) => x.n)], [2, [2], [2]], "原样再调：按要新买的 2 句重新问额度");
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【7】上游失败：停在那一句、不自动重试、原话报回去");
    {
      const P1 = "第一句没问题。", P2 = "第二句会失败。", P3 = "第三句等着。";
      failRule = { text: P2, status: 500, body: '{"error":"upstream boom"}' };
      const f = await run({ segments: [P1, P2, P3], filename: "重试.wav" });
      failRule = null;
      eq([f.posts, f.bodies.map(said)], [2, [P1, P2]], "500 那句只打了一次，第 3 句没去碰");
      ok(f.res.isError && !f.res.stopped && /第 2 句没配成（共 3 句）/.test(f.res.content) && f.res.content.includes('语音接口错误 500: {"error":"upstream boom"}') &&
        /前 1 句已经配好/.test(f.res.content) && /没有自动重试/.test(f.res.content), "报哪一句、上游原话、前面几句存着、没重试", f.res.content);
      eq(mediaHealth.statusOf(f.res.content), 500, "媒体健康表从这句话里认得出 500（渠道坏没坏靠它）");
      eq([f.recs.map((x) => [x.n, x.units]), f.undos.length], [[[1, 0.007]], 0], "已经买到的第 1 句照样入账");
      ok(!fs.existsSync(path.join(SAVE, "重试.wav")) && !fs.existsSync(path.join(SAVE, "重试.json")), "没配齐就不出整轨和清单");
      const again = await run({ segments: [P1, P2, P3], filename: "重试.wav" });
      eq([again.posts, again.bodies.map(said), again.res.isError], [2, [P2, P3], false], "原样再调：第 1 句复用，只从第 2 句开始花钱");

      const N1 = "断网这一句。", N2 = "断网后一句。";
      failRule = { text: N1, throw: "fetch failed" };
      const n = await run({ segments: [N1, N2], filename: "断网.wav" });
      failRule = null;
      ok(n.res.isError && /第 1 句没配成/.test(n.res.content) && /fetch failed/.test(n.res.content) && !/前 0 句/.test(n.res.content), "请求直接抛错：同样停住，原话带出去", n.res.content);
      eq([n.posts, n.recs.length, n.undos.length, n.undos[0] && n.undos[0].id], [1, 0, 1, "h" + holdSeq], "一句没买到：不记账，预扣退回去");
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【8】中途停止：已经配好的存着，不说成超时");
    {
      const S1 = "停止前一句。", S2 = "停止第二句。", S3 = "停止第三句。";
      const ac = new AbortController();
      let calls = 0;
      const synth = async (...a) => { const out = await MEDIA.textToSpeech(...a); if (++calls === 1) ac.abort(); return out; };
      const s = await run({ segments: [S1, S2, S3], filename: "停止.wav" }, { stop: ac.signal, deps: fakeDeps({ synth }) });
      ok(s.res.stopped === true && s.res.isError && /停在第 2 句（共 3 句）/.test(s.res.content) && /前 1 句已经配好/.test(s.res.content), "停在第 2 句，前 1 句存着", s.res.content);
      ok(!/超时|timeout|请求失败|错误\s*[（(]?\s*\d{3}/i.test(s.res.content), "停止的措辞里没有超时 / 错误码（不然渠道健康表会记它一笔）", s.res.content);
      eq([s.posts, s.recs.map((x) => x.n)], [1, [1]], "上游只打了 1 次，这 1 句入账");
      const cont = await run({ segments: [S1, S2, S3], filename: "停止.wav" });
      eq([cont.posts, cont.res.isError], [2, false], "接着做：只买剩下两句");

      const ac2 = new AbortController();
      ac2.abort();
      const s2 = await run({ segments: ["还没开始就停了。"], filename: "停止2.wav" }, { stop: ac2.signal });
      ok(s2.res.stopped && /一句都还没配好/.test(s2.res.content) && s2.posts === 0 && s2.recs.length === 0 && s2.undos.length === 1, "开跑前就停了：0 次、不记账、预扣退回", s2.res.content);
      const s3 = await run({ segments: ["落盘前被停。"], filename: "停止3.wav" }, { deps: fakeDeps({ synth: async () => { throw MEDIA.stoppedError("音频没有落盘。"); } }) });
      ok(s3.res.stopped && /停在第 1 句/.test(s3.res.content), "配音那一步自己报「已停止」：按停止处理，不当失败", s3.res.content);
      // media.js 只在上游已经回了音频 / 地址之后才抛 stopped：这句的钱花了，得入账、得跟用户说
      eq([s3.recs.map((x) => x.n), s3.undos.length], [[1], 0], "上游回了音频才停的那句照样入账，预扣不退");
      ok(/第 1 句上游已经回了音频.*按已花钱记账/.test(s3.res.content) && !/超时|timeout|请求失败|错误\s*[（(]?\s*\d{3}/i.test(s3.res.content), "跟用户说这句已经花了钱、没落盘", s3.res.content);
      const ac5 = new AbortController();
      const s5 = await run({ segments: ["半路被掐。", "后面一句。"], filename: "停止5.wav" }, {
        stop: ac5.signal,
        deps: fakeDeps({ synth: async () => { ac5.abort(); throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" }); } }),
      });
      ok(s5.res.stopped && /第 1 句的请求已经发出，上游可能已扣费/.test(s5.res.content) && !/超时|timeout|请求失败|错误\s*[（(]?\s*\d{3}/i.test(s5.res.content),
        "请求飞在半路被掐：扣没扣说不准，照实说可能扣了", s5.res.content);
      eq([s5.recs.length, s5.undos.length], [0, 1], "说不准的不记账，预扣退回");
      const s4 = await run({ segments: [S1, S2, S3], filename: "停止.wav" }, {
        deps: fakeDeps({ toPcm: async () => { throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); } }),
      });
      ok(s4.res.stopped && /整轨还没拼/.test(s4.res.content) && /不会再花钱/.test(s4.res.content) && s4.posts === 0, "拼整轨时停：说清楚句子都在、再调不花钱", s4.res.content);
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【9】通义那条路：音色必填、结果要再下载一次、分句是 .wav");
    {
      const d = await run({ segments: ["你好。", { text: "再见。", voice: "Serena" }], voice: "Cherry", filename: "通义.wav" }, { media: MEDIA_DS });
      ok(!d.res.isError, "通义按句配音成功", d.res.content);
      eq([d.posts, d.gets], [2, 2], "两句：两次合成 + 两次下载");
      eq(d.bodies, [{ model: "qwen3-tts-flash", input: { text: "你好。", voice: "Cherry" } }, { model: "qwen3-tts-flash", input: { text: "再见。", voice: "Serena" } }],
        "请求体：整批音色 Cherry，第 2 句用自己的 Serena");
      const m = manifestOf("通义");
      eq([m.model, m.voice, m.segments.map((s) => [s.voice, path.extname(s.file)])], ["qwen3-tts-flash", "Cherry", [["Cherry", ".wav"], ["Serena", ".wav"]]], "清单：分句是 .wav，各记各的音色");
      const dsDefault = mediaOf({ base_url: DASH, api_key: "sk-fake", model: "qwen3-tts-flash", voice: "Chelsie" });
      const dd = await run({ segments: ["用默认音色。"], filename: "通义默认.wav" }, { media: dsDefault });
      eq([dd.res.isError, dd.bodies.map((b) => b.input.voice)], [false, ["Chelsie"]], "没给音色就用设置里填的那个");
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【10】单价：没核实过的型号是「单价未知」，不当 0 元");
    {
      const tts = pricing.costOfUnits({ cap: "tts", model: "qwen3-tts-flash", units: 1 });
      const img = pricing.costOfUnits({ cap: "image", model: "doubao-seedream-5-0-pro-260628", units: 1 });
      ok(tts.unknown === true && img.unknown === true, "qwen3-tts-flash、doubao-seedream-5-0-pro 都标未知（没查到官方价之前不许编一个数）", { tts, img });
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【11】量时长 / 拼整轨出错：钱已经花了，说清楚再调不会再花");
    {
      const M = ["量一句。", "量二句。", "量三句。"];
      let n = 0;
      const bad = await run({ segments: M, filename: "量失败.wav" }, {
        // 跟 runBin 一样：ffmpeg 跑完了、按退出码拒了这个输入
        deps: fakeDeps({ toPcm: async (ff, i, o, x) => { if (++n === 2) throw Object.assign(new Error("Invalid data found when processing input"), { exitCode: 1 }); return fakeToPcm(ff, i, o, x); } }),
      });
      const clip2 = TTSB.segFileName("量失败", ".mp3", { model: "tts-1", voice: "alloy", text: M[1] });
      ok(bad.res.isError && !bad.res.stopped && bad.res.content.includes(`3 句都配好了，但第 2 句的音频解不开（${clip2}）：Invalid data found`) && /不会再花钱/.test(bad.res.content),
        "解不开：点出是哪一句、哪个文件、ffmpeg 原话", bad.res.content);
      ok(fs.existsSync(path.join(SAVE, "量失败_分句", clip2)), "坏文件不替用户删（删了就得再买，让他看过再定）");
      ok(!/上游/.test(bad.res.content) && /其余 2 句已存进缓存/.test(bad.res.content) && /要不要重买（约 4 字，会再扣一次钱）先问用户/.test(bad.res.content),
        "ffmpeg 拒了输入：不替人猜是上游的锅，重不重买留给用户", bad.res.content);
      // 本机这头的错：文件没毛病，删了重买还是同一个错，每调一次多花一句的钱
      const LOCAL = [
        ["超时", Object.assign(new Error("ffmpeg 跑了 60 秒还没完，已经停掉"), { timedOut: true })],
        ["没执行权限", Object.assign(new Error("ffmpeg 跑不起来：/fake/ffmpeg（没有执行权限）"), { code: "EACCES" })],
        ["被信号杀掉", Object.assign(new Error("ffmpeg 出错了（退出码 null）"), { exitCode: undefined })],
        ["临时目录写满", Object.assign(new Error("ffmpeg 出错了（退出码 1）：Error opening output file: No space left on device"), { exitCode: 1 })],
        ["转完读不出头", new Error("ffmpeg 说转好了，但 1.wav 读不出 WAV 头")],
      ];
      for (const [label, err] of LOCAL) {
        const r = await run({ segments: M, filename: "量失败.wav" }, { deps: fakeDeps({ toPcm: async () => { throw err; } }) });
        ok(r.res.isError && r.posts === 0 && r.res.content.includes(err.message) && /本机转码/.test(r.res.content) && /不会再花钱/.test(r.res.content) &&
          !/上游|删掉|重买/.test(r.res.content), `${label}：原话照给，不怪上游、不叫人删文件重买`, r.res.content);
      }
      eq(bad.recs.map((x) => x.n), [3], "三句都买到了，照样入账");
      const fixed = await run({ segments: M, filename: "量失败.wav" });
      eq([fixed.posts, fixed.res.isError], [0, false], "修好后再调：0 次上游");
      const cc = await run({ segments: M, filename: "量失败.wav" }, { deps: fakeDeps({ concat: async () => { throw new Error("磁盘满了"); } }) });
      ok(cc.res.isError && /3 句都配好了，但拼整轨没成：磁盘满了/.test(cc.res.content) && /不会再花钱/.test(cc.res.content) && cc.posts === 0, "拼不成：照实说，不会再花钱", cc.res.content);
      const empty = await run({ segments: M, filename: "量失败.wav" }, { deps: fakeDeps({ toPcm: async () => ({ samples: 0 }) }) });
      ok(empty.res.isError && /第 1 句的音频解不开.*解出来是空的/.test(empty.res.content), "解出来 0 个采样：当解不开处理，不拼一条空轨", empty.res.content);
      ok(/先问用户/.test(empty.res.content) && !/本机转码/.test(empty.res.content), "解出来是空的不算本机的错：重不重买问用户", empty.res.content);
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【12】采样率跟第一句走；整轨要 mp3 时差得多了照实说");
    {
      clipRate = 16000;
      const lo = await run({ segments: [T1, T2], filename: "低采样.wav" });
      clipRate = 24000;
      const lm = manifestOf("低采样");
      const lw = MP.readWavInfo(path.join(SAVE, "低采样.wav"));
      eq([lo.res.isError, lm.sample_rate, lm.segments.map((s) => s.ms), lm.total_ms, lw && lw.sampleRate, lw && lw.samples],
        [false, 16000, [1234, 800], 2334, 16000, 37344], "上游回 16kHz：不重采样，时长照样按采样算对");
      const weird = await run({ segments: [T1, T2, T3], filename: "旁白.wav" }, { deps: fakeDeps({ probe: async () => ({ sampleRate: 5 }) }) });
      eq([weird.res.isError, manifestOf("旁白").sample_rate], [false, 24000], "量出来的采样率不像话：回到 24000，不拿它去解码");

      const driftDeps = (delta) => fakeDeps({
        probe: async (fp, abs) => (abs.endsWith("漂移.mp3") ? { samples: 0, sampleRate: 24000, ms: 4634 + delta, codec: "mp3", channels: 1, exact: false } : fakeProbe(fp, abs)),
        concat: async (_ff, wavs, o) => {
          const lay = MP.gapLayout(wavs.map((f) => MP.readWavInfo(f).samples), o.gapSamples);
          fs.writeFileSync(o.outAbs, "假 mp3");
          return { samples: lay.total, rate: o.rate, ms: MP.samplesToMs(lay.total, o.rate), starts: lay.starts, ends: lay.ends };
        },
      });
      const up = await run({ segments: [T1, T2, T3], filename: "漂移.mp3" }, { deps: driftDeps(45) });
      ok(!up.res.isError && up.res.file === "漂移.mp3" && up.res.content.includes("ffprobe 量出来 4679ms，比按采样算的 4634ms 长 45ms") && /用 \.wav/.test(up.res.content),
        "mp3 整轨长了 45ms：照实说，并指一条路（要逐毫秒对齐用 .wav）", up.res.content);
      const down = await run({ segments: [T1, T2, T3], filename: "漂移.mp3" }, { deps: driftDeps(-45) });
      ok(down.res.content.includes("短 45ms") && down.posts === 0, "短了也说", down.res.content);
      const tiny = await run({ segments: [T1, T2, T3], filename: "漂移.mp3" }, { deps: driftDeps(10) });
      ok(!/注意：整轨是 mp3/.test(tiny.res.content), "只差 10ms：不提（听不出来的差说了只是噪音）", tiny.res.content);
      eq(manifestOf("漂移").full, "任务_配音/漂移.mp3", "清单指向 mp3 整轨");
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【13】派发：tools.executeTool 真走到按句配音，额度走 quotaGate、进度一路报回来");
    {
      // 上面各段都是直接调 ttsSegments；这段证明 tools.js 那条 case 真把它接上了——参数、额度闸、进度回调一样不少。
      // 派发层递的是空 deps，量时长那三样只能换模块上的导出（ttsSegments 是调用时才去取的），跑完原样放回
      const realMP = { resolveMediaBins: MP.resolveMediaBins, probeAudio: MP.probeAudio, toPcmWav: MP.toPcmWav };
      Object.assign(MP, { resolveMediaBins: FAKE_BINS, probeAudio: fakeProbe, toPcmWav: fakeToPcm });
      const OUT = "任务_派发";
      const exec = (input, extra) => tools.executeTool("text_to_speech", input, { media: MEDIA_OA, security: { gateway: false }, baseDir: OUT, ...(extra || {}) });
      try {
        const p0 = hits.post, q0 = qgates.length, r0 = recs.length;
        /** @type {any[]} */ const prog = [];
        const r = await exec({ segments: ["派发第一句。", "派发第二句。"], filename: "派发.wav" }, { onProgress: (p) => prog.push(p) });
        ok(!r.isError && /按句配音完成：2 句/.test(r.content), "segments 走进按句配音那条路（不是整段 text 那条）", r.content);
        eq(hits.post - p0, 2, "上游正好打了 2 次：一句一次");
        ok(["派发.wav", "派发.srt", "派发.json"].every((f) => fs.existsSync(path.join(WS, OUT, f))), "整轨、字幕、清单落在本对话的成果目录（baseDir）");
        const qg = qgates.slice(q0);
        ok(qg.length === 1 && qg[0].cap === "tts" && qg[0].call.n === 2, "额度只问一次，走的是 tools.js 的 quotaGate（cap=tts、n=要新买的 2 句）", qg);
        ok(recs.slice(r0).some((x) => x.cap === "tts" && x.n === 2), "花掉的 2 句记了账", recs.slice(r0));
        ok(prog.some((p) => p.stage === "tts") && prog.some((p) => p.stage === "compose"), "onProgress 从派发层一路递进去：配音和拼整轨都报了", prog.map((p) => p.label));
        const lp = prog[prog.length - 1];
        ok(!!lp && lp.stage === "compose" && lp.pct === 100, "最后一下必到：拼整轨 100%", lp);
        // 反向对照：只给 text 的老调用照旧走整段那条，不会被这层截走
        const p1 = hits.post;
        const single = await exec({ text: "整段一句。", filename: "整段.mp3" });
        ok(!single.isError && !/按句配音/.test(single.content) && hits.post - p1 === 1, "反向对照：只给 text 还是整段合成那条路", single.content);
        const p2 = hits.post, q2 = qgates.length;
        const bad = await exec({ segments: [] });
        ok(bad.isError && hits.post === p2 && qgates.length === q2, "派发后 segments 给了空数组：照样在花钱前拦下，额度都没问", bad.content);
      } finally {
        Object.assign(MP, realMP);
      }
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【14】收尾：不留 .bak / .part / 临时目录，没打过没登记的地址");
    {
      const junk = walk(SAVE).filter((f) => /\.(bak|part|tmp)$/.test(f));
      eq(junk.map((f) => path.relative(WS, f)), [], "成果目录里没有 .bak / .part / .tmp（它们会混进对话的成果列表）");
      const leaked = owbTtsTmp().filter((n) => !tmpBefore.has(n));
      eq(leaked, [], "量时长用的临时目录都删了（成功、失败、停止三条路都算上）");
      eq(hits.unknown, 0, "没打过测试路由之外的任何地址");
      const def = (tools.TOOL_DEFS || []).find((d) => d && d.name === "text_to_speech");
      const props = def && (def.input_schema || def.parameters || {}).properties;
      // 已经接线：工具描述里没了 segments 就是模型再也不知道有这条路，算失败，不能静默跳过
      const sch = def ? def.input_schema || def.parameters : null;
      ok(!!(props && props.segments && sch) && props.segments.type === "array" && props.segments.maxItems === TTSB.SEG_MAX &&
        !(sch.required || []).includes("text") && !!props.gap_ms && ((props.segments.items || {}).required || []).includes("text"),
      "工具描述：segments 上限跟代码一致、每项必带 text、整段 text 不再必填、有 gap_ms", { segments: props && props.segments, required: sch && sch.required });
      ok(!!props && props.voice && props.voice.type === "string" && props.no_cache && props.no_cache.type === "boolean",
        "老参数一个没少：voice 还是字符串、no_cache 还是布尔", props && { voice: props.voice, no_cache: props.no_cache });
    }

    // ───────────────────────────────────────────────────────────────
    console.log("【15】真 ffmpeg：时长按解码后的采样算，拿 silencedetect 听静音落在哪");
    const bins = await MP.resolveMediaBins();
    const ff = bins.ffmpeg.bin, fp = bins.ffprobe.bin;
    if (!ff || !fp) {
      if (process.env.OWB_REQUIRE_FFMPEG === "1") ok(false, "OWB_REQUIRE_FFMPEG=1：这台机器要求跑真 ffmpeg 这段，但没找到 ffmpeg / ffprobe", JSON.stringify(bins));
      else console.log("    跳过：本机没有 ffmpeg");
    } else {
      let ran = 0;
      const rok = (c, name, x) => { ok(c, name, x); ran++; };
      const SRC = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ttsseg-src-"));
      const SAVE_B = path.join(WS, "任务_真机");
      try {
        const hasLame = /libmp3lame/.test(spawnSync(ff, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout || "");
        const DURS = [1.234, 0.8, 2.0];
        const TEXTS = ["真机第一句。", "真机第二句。", "真机第三句。"];
        const gen = (tag, codec, ext) => new Map(TEXTS.map((t, i) => {
          const out = path.join(SRC, `${tag}_${i + 1}${ext}`);
          const r = spawnSync(ff, ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${440 + 220 * i}:sample_rate=24000:duration=${DURS[i]}`, "-ac", "1", ...codec, out], { encoding: "utf8" });
          if (r.status !== 0) throw new Error("生成测试音频失败：" + (r.stderr || "").slice(-300));
          return [t, out];
        }));
        const silences = (file) => {
          const sd = spawnSync(ff, ["-nostdin", "-hide_banner", "-i", file, "-af", "silencedetect=noise=-50dB:d=0.2", "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
          return {
            starts: [...sd.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((x) => Math.round(Number(x[1]) * 1000)),
            ends: [...sd.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((x) => Math.round(Number(x[1]) * 1000)),
          };
        };
        // 句间每段停顿：静音开始 ≈ 上一句 end_ms，静音结束 ≈ 下一句 start_ms。s / e 是允许的偏差区间（ms）
        const fits = (segs, sil, s, e) => sil.starts.length === segs.length - 1 && sil.ends.length === segs.length - 1 &&
          segs.slice(0, -1).every((g, i) => {
            const ds = sil.starts[i] - g.end_ms, de = sil.ends[i] - segs[i + 1].start_ms;
            return ds >= s[0] && ds <= s[1] && de >= e[0] && de <= e[1];
          });
        const runReal = (input, media) => run(input, { media, saveDir: SAVE_B, deps: {} });

        // B1：通义那条路，上游回 WAV
        realClips = gen("wav", ["-c:a", "pcm_s16le"], ".wav");
        const w = await runReal({ segments: TEXTS, voice: "Cherry", filename: "真机.wav" }, MEDIA_DS);
        rok(!w.res.isError, "真 ffprobe / ffmpeg 走一遍：成功", w.res.content);
        const wm = manifestOf("真机", SAVE_B);
        eq(wm.segments.map((s) => s.ms), [1234, 800, 2000], "WAV 分句实测 1234 / 800 / 2000ms，一毫秒不差"); ran++;
        const wf = await MP.probeAudio(fp, path.join(SAVE_B, "真机.wav"));
        rok(wf && wf.exact && Math.abs(wf.ms - wm.total_ms) <= 5, `ffprobe 量整轨 ${wf && wf.ms}ms，清单说 ${wm.total_ms}ms`, JSON.stringify(wf));
        const ws = silences(path.join(SAVE_B, "真机.wav"));
        rok(fits(wm.segments, ws, [-15, 15], [-15, 15]), "silencedetect 听到的两段停顿，就在清单写的起止上（±15ms）", JSON.stringify({ ws, segs: wm.segments.map((s) => [s.start_ms, s.end_ms]) }));
        const shifted = wm.segments.map((s) => ({ ...s, start_ms: s.start_ms + 100, end_ms: s.end_ms + 100 }));
        rok(!fits(shifted, ws, [-15, 15], [-15, 15]), "反向对照：同一把尺子量一条故意错 100ms 的时间轴，判不合格");
        const srtEnds = [...fs.readFileSync(path.join(SAVE_B, "真机.srt"), "utf8").matchAll(/--> (\d\d):(\d\d):(\d\d),(\d{3})/g)].map((x) => ((+x[1] * 60 + +x[2]) * 60 + +x[3]) * 1000 + +x[4]);
        eq(srtEnds, wm.segments.map((s) => s.end_ms), "落盘的字幕：每条结束时间 = 清单 end_ms"); ran++;

        if (!hasLame) console.log("    （这台 ffmpeg 没带 libmp3lame，mp3 那几条跳过）");
        else {
          // B2：OpenAI 那条路，上游回带 Xing / LAME 头的 mp3：解码器按头里的补齐信息剪掉首尾，时长是准的
          realClips = gen("xing", ["-c:a", "libmp3lame", "-b:a", "64k"], ".mp3");
          const x = await runReal({ segments: TEXTS, filename: "真机_mp3.wav" }, MEDIA_OA);
          const xm = manifestOf("真机_mp3", SAVE_B);
          rok(!x.res.isError && xm.segments.every((s, i) => Math.abs(s.ms - DURS[i] * 1000) <= 5), "带 Xing 头的 mp3：每句 ±5ms", x.res.isError ? x.res.content : xm.segments.map((s) => s.ms));
          const xf = await MP.probeAudio(fp, path.join(SAVE_B, "真机_mp3.wav"));
          rok(xf && Math.abs(xf.ms - xm.total_ms) <= 5, "整轨长度 = 清单总长（±5ms）", JSON.stringify(xf));
          rok(fits(xm.segments, silences(path.join(SAVE_B, "真机_mp3.wav")), [-30, 30], [-30, 30]), "silencedetect：停顿在清单写的位置（±30ms）");

          // B3：流式 TTS 那种不带 Xing 头的 VBR mp3：解码出来首尾多了编码补齐，容器里写的时长只是按码率估的
          realClips = gen("vbr", ["-c:a", "libmp3lame", "-q:a", "6", "-write_xing", "0"], ".mp3");
          const v = await runReal({ segments: TEXTS, filename: "真机_流式.wav" }, MEDIA_OA);
          const vm = manifestOf("真机_流式", SAVE_B);
          const decoded = [], container = [];
          for (const [i, t] of TEXTS.entries()) {
            const src = /** @type {string} */ (realClips.get(t));
            decoded.push(MP.samplesToMs((await MP.toPcmWav(ff, src, path.join(SRC, `dec_${i}.wav`), { rate: 24000 })).samples, 24000));
            const pc = await MP.probeAudio(fp, src);
            container.push(pc ? pc.ms : 0);
          }
          rok(!v.res.isError && JSON.stringify(vm.segments.map((s) => s.ms)) === JSON.stringify(decoded), `无 Xing 头的 mp3：清单时长 = 解码后的采样数（${decoded.join(" / ")}ms）`,
            v.res.isError ? v.res.content : { manifest: vm.segments.map((s) => s.ms), decoded });
          const vf = await MP.probeAudio(fp, path.join(SAVE_B, "真机_流式.wav"));
          rok(vf && Math.abs(vf.ms - vm.total_ms) <= 5, "整轨长度 = 清单总长（±5ms）", JSON.stringify(vf));
          // 编码补齐：声音晚 ~50ms 才起、早 ~20ms 就停，所以静音开始可以比 end_ms 早一点、结束可以比 start_ms 晚一点
          rok(fits(vm.segments, silences(path.join(SAVE_B, "真机_流式.wav")), [-80, 20], [-20, 80]), "silencedetect：停顿落在清单写的位置（只差编码补齐那点）");
          const off = Math.max(...container.map((c, i) => Math.abs(c - decoded[i])));
          if (off > 20) {
            const cTotal = container.reduce((a, b) => a + b, 0) + 300 * (TEXTS.length - 1);
            ok(Math.abs(cTotal - vf.ms) > 20 && Math.abs(vm.total_ms - vf.ms) <= 5,
              `反向对照：按容器时长排，总长差 ${Math.abs(cTotal - vf.ms)}ms；按解码采样排，差 ${Math.abs(vm.total_ms - vf.ms)}ms`, { container, decoded, full: vf.ms });
          } else {
            console.log(`    （这台 ffprobe 把无 Xing 头的 mp3 量准了：容器 ${container.join("/")} vs 解码 ${decoded.join("/")}，反向对照跳过）`);
          }

          // B4：整轨要 mp3，用真 libmp3lame 编一次
          realClips = gen("wav2", ["-c:a", "pcm_s16le"], ".wav");
          const m3 = await runReal({ segments: TEXTS, voice: "Cherry", filename: "真机整轨.mp3" }, MEDIA_DS);
          const m3f = path.join(SAVE_B, "真机整轨.mp3");
          rok(!m3.res.isError && fs.existsSync(m3f), "整轨要 .mp3：编出来了", m3.res.content);
          const pm = await MP.probeAudio(fp, m3f);
          const d = pm ? pm.ms - manifestOf("真机整轨", SAVE_B).total_ms : 9999;
          rok(Math.abs(d) <= 80, `mp3 整轨和按采样算的只差编码补齐（${d}ms）`);
          rok((Math.abs(d) > 20) === /注意：整轨是 mp3/.test(m3.res.content), "回执里提不提 mp3 偏差，跟实测差多少对得上", m3.res.content);
          rok(!walk(SAVE_B).some((f) => /\.(part|bak|tmp)$/.test(f)), "编完不留 .part");
        }
        ok(ran === (hasLame ? 16 : 6), `真 ffmpeg 这段该跑的都跑了（${ran} 条）`);
      } finally {
        realClips = null;
        try { fs.rmSync(SRC, { recursive: true, force: true }); } catch {}
      }
    }
  });
})()
  .catch((e) => { fail++; console.error("套件自己挂了：", e); })
  .finally(() => {
    global.fetch = realFetch;
    Object.assign(quota, realQuota);
    for (const d of [HOME, WS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    console.log(`\n${fail === 0 ? "√" : "×"} tts-segments：${pass} 条通过，${fail} 条失败`);
    process.exit(fail === 0 ? 0 : 1);
  });
