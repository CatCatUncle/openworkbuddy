// @ts-check
"use strict";
/**
 * 按句配音：text_to_speech 的 segments 模式。
 *
 * 为什么要有它：短视频要「镜头跟着声音走」，得先知道每句念了多久。以前 agent 的做法是
 * 每句调一次配音、再调一次 ffprobe 量时长——一集二十句就是四十步，撞步数上限是常事；
 * 而且 ffprobe 读的是 mp3 容器里写的时长，每段差 25–50ms，累加到第四五句字幕就对不上嘴了。
 * 这里一次调用做完：逐句合成 → 解成同一采样率的 PCM 数采样 → 按采样拼整轨 →
 * 用同一套采样数出句级字幕和时长清单。字幕和声音用的是同一份数，不可能各说各的。
 *
 * 这是按字数扣费的上游，所以花钱的规矩写死在这里：
 *   ① 每句单独进生成缓存，文件名按内容取哈希、不按序号——插一句、改一句，只重配那一句；
 *   ② 额度只按「这次真要新买的句子」去问，全都命中就不问；
 *   ③ 上游收了单就不自动重试：哪句失败整批停在那句，原话报回去，重跑同一个调用只从那句开始花钱；
 *   ④ 没配语音、缺音色、没装 ffmpeg，都在花第一分钱之前说清楚。不换音色、不换模型、不拿系统 say 顶。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const mediaModels = require("../../media-models");
const genCache = require("../../gen-cache");
const quota = require("../../quota");
const security = require("../../security");
const store = require("../../store");
const MEDIA = require("./media");
const MP = require("../../lib/media-probe");

/** 一批最多几句。再多就该分集了，一次调用跑十几分钟，中途停下也不好接 */
const SEG_MAX = 60;
/** 单句上限：qwen3-tts-flash 官方文档写的一次 600 字，超了上游直接拒 */
const SEG_MAX_CHARS = 600;
/** 句间停顿默认 300ms，跟「镜头 = 人声 + 0.3 秒」那条排片规矩对上 */
const GAP_DEFAULT_MS = 300;
const GAP_MAX_MS = 3000;
/** 进度最多 400ms 报一次，最后一下必报（工具进度统一的口径） */
const PROGRESS_MS = 400;
/** 整轨要 mp3 时，编码补齐差出这么多才提一句；再小的差听不出来，说了只是噪音 */
const MP3_DRIFT_NOTE_MS = 20;
const FULL_EXT = [".wav", ".mp3"];

/**
 * @typedef {{ text: string, voice: string }} Seg
 * @typedef {{ ok: true, segs: Seg[], gapMs: number, stem: string, fullExt: string }} Checked
 * @typedef {{ ok: false, content: string }} Rejected
 * @typedef {{ content: string, isError: boolean, file?: string, stopped?: boolean }} ToolResult
 * @typedef {{ start_ms: number, end_ms: number, ms: number, slot_ms: number }} TimeRow
 */

/** @param {any} input */
function isBatch(input) {
  return !!input && typeof input === "object" && input.segments !== undefined;
}

/**
 * 花钱之前把参数全部查一遍。这里拦下来的一分钱都没花，报错里也这么说，省得模型以为要去查账。
 * @param {any} input
 * @returns {Checked | Rejected}
 */
function validate(input) {
  const inp = input || {};
  /** @param {string} content @returns {Rejected} */
  const fail = (content) => ({ ok: false, content });
  // text 和 segments 同时给，谁说了算都是猜：整段念一遍和按句念出来的时长不一样
  if (String(inp.text == null ? "" : inp.text).trim()) {
    return fail("text 和 segments 二选一：整段念一遍用 text，要按句出时长和字幕用 segments。这次两个都给了，没合成、没花钱。");
  }
  const list = inp.segments;
  if (!Array.isArray(list)) return fail("segments 要是数组，每项一句话：字符串，或 {text, voice}。");
  if (!list.length) return fail("segments 是空的，至少给一句。");
  if (list.length > SEG_MAX) return fail(`一次最多 ${SEG_MAX} 句，这次 ${list.length} 句。分几批调，每批用不同的 filename。`);
  /** @type {Seg[]} */
  const segs = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const obj = !!s && typeof s === "object" && !Array.isArray(s);
    if (!obj && typeof s !== "string") return fail(`第 ${i + 1} 句格式不对：要字符串，或 {text, voice}。`);
    // 换行压成空格：句子里夹着换行，字幕那一条会被拆成两行，跟「一句一条」对不上
    const text = String(obj ? (s.text == null ? "" : s.text) : s).replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!text) return fail(`第 ${i + 1} 句是空的。删掉它，或者补上要念的字。`);
    if (text.length > SEG_MAX_CHARS) return fail(`第 ${i + 1} 句有 ${text.length} 字，单句上限 ${SEG_MAX_CHARS}（上游一次只收这么多）。在句号处拆成两句。`);
    segs.push({ text, voice: obj && s.voice != null ? String(s.voice).trim() : "" });
  }
  let gapMs = GAP_DEFAULT_MS;
  if (inp.gap_ms != null && inp.gap_ms !== "") {
    const g = Number(inp.gap_ms);
    if (!Number.isFinite(g)) return fail(`gap_ms 要是毫秒数（0–${GAP_MAX_MS}），给的是「${String(inp.gap_ms).slice(0, 20)}」。`);
    gapMs = Math.min(GAP_MAX_MS, Math.max(0, Math.round(g)));
  }
  // 默认叫「旁白」：拼片那边按文件名认人声，带「旁白」的永远不会被当成背景音乐
  let name = String(inp.filename == null ? "" : inp.filename).trim().replace(/[\/\\:*?"<>|]/g, "_") || "旁白.wav";
  let ext = path.extname(name).toLowerCase();
  if (!ext && /^\.[a-z0-9]+$/i.test(name)) { ext = name.toLowerCase(); name = ""; }
  if (!ext) ext = ".wav";
  else name = name.slice(0, name.length - ext.length);
  // 不认的后缀直接说，不悄悄改名：模型以为写出来的是 .m4a，拼片时去找就找不到了
  if (!FULL_EXT.includes(ext)) return fail(`整轨只能是 .wav 或 .mp3，给的是「${ext}」。换个后缀再调，字幕和时长清单会跟整轨同名。`);
  // 60 字封顶：分句文件名还要再接「_8位哈希.wav」，落盘那边的文件名上限是 80
  const stem = name.trim().slice(0, 60).trim() || "旁白";
  return { ok: true, segs, gapMs, stem, fullExt: ext };
}

/**
 * 分句文件名 = 整轨名 + 内容哈希。按序号起名的话，在前面插一句，后面每句的名字都挪一格——
 * 缓存全部失效要重买，更糟的是缓存会把「第 3 句」的旧文件当成新的第 3 句还回来。
 * @param {string} stem
 * @param {string} ext
 * @param {{ model: string, voice?: string, speed?: any, text: string }} p
 */
function segFileName(stem, ext, p) {
  const h = crypto.createHash("sha1").update(JSON.stringify([p.model, p.voice || "", p.speed || "", p.text])).digest("hex").slice(0, 8);
  return `${stem}_${h}${ext}`;
}

/**
 * 按采样位置换成毫秒。起止都从整条音轨的绝对采样位置算，每一条的舍入误差不超过 0.5ms，
 * 不会一句句往后累积。slot_ms 是给排镜头用的：这一句 + 句后停顿。
 * @param {number[]} samples
 * @param {number[]} starts
 * @param {number[]} ends
 * @param {number} rate
 * @param {number} gapMs
 * @returns {TimeRow[]}
 */
function rowsFromLayout(samples, starts, ends, rate, gapMs) {
  return samples.map((n, i) => {
    const ms = MP.samplesToMs(n, rate);
    return { start_ms: MP.samplesToMs(starts[i], rate), end_ms: MP.samplesToMs(ends[i], rate), ms, slot_ms: ms + gapMs };
  });
}

/**
 * 纯计算版的时间轴，跟拼整轨时用的是同一个 gapLayout。
 * @param {number[]} samples
 * @param {number} rate
 * @param {number} gapMs
 * @returns {{ rows: TimeRow[], total_ms: number }}
 */
function planTimeline(samples, rate, gapMs) {
  const lay = MP.gapLayout(samples, MP.msToSamples(gapMs, rate));
  return { rows: rowsFromLayout(samples, lay.starts, lay.ends, rate, gapMs), total_ms: MP.samplesToMs(lay.total, rate) };
}

/**
 * 句级字幕。一条字幕结束在这句念完的那一刻，不拖到停顿结束：停顿里挂着上一句的字，看着像卡住了。
 * @param {{ text: string, start_ms: number, end_ms: number }[]} rows
 */
function buildSegSrt(rows) {
  return rows.map((r, i) => `${i + 1}\n${MEDIA.srtTime(r.start_ms / 1000)} --> ${MEDIA.srtTime(r.end_ms / 1000)}\n${r.text}\n`).join("\n");
}

/** 通义这几个型号认哪些音色。报「缺音色」时列出来，让用户挑，不替他挑 */
function dashVoices(model) {
  const list = (mediaModels.CATALOG.tts || []).filter((m) => m.kind === "dashscope");
  const hit = list.find((m) => m.id === model) || list.find((m) => String(model || "").startsWith(m.id));
  return (hit && hit.voices) || [];
}

/** 没从 tools.js 递额度闸进来时（直接调用、脚本）也照样问一遍额度，不因为少传一个参数就不设防 */
function defaultGate(call) {
  const g = quota.gate("tts", call);
  return g.ok ? { bad: null, hold: g.hold } : { bad: { content: g.why, isError: true }, hold: null };
}

/** 回执里每句只露个头，整句在字幕和清单里 */
function head(text, n = 24) {
  const a = Array.from(text);
  return a.length > n ? a.slice(0, n).join("") + "…" : text;
}

const sec = (ms) => (ms / 1000).toFixed(2);

/**
 * @param {{
 *   media: any, input: any, timeoutMs?: number, saveDir: string, wsRoot: string,
 *   resolveFile?: (rel: string) => string, stop?: AbortSignal,
 *   gate?: (call: { n: number, units: number, model?: string }) => { bad: any, hold: any },
 *   onProgress?: (p: { stage: string, done?: number, total?: number, pct?: number, label: string }) => void,
 * }} ctx
 * @param {{ bins?: () => Promise<any>, probe?: Function, toPcm?: Function, concat?: Function, synth?: Function, now?: () => number }} [deps]
 * @returns {Promise<ToolResult>}
 */
async function ttsSegments(ctx, deps = {}) {
  const input = ctx.input || {};
  const v = validate(input);
  if (v.ok === false) return { content: v.content, isError: true };

  let cfg;
  try { cfg = mediaModels.pick(ctx.media, "tts", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg || !cfg.base_url || !cfg.model) return { content: MEDIA.TTS_UNSET, isError: true };

  // 音色：这一句自己的 > 整批的 > 设置里的默认。一个都没有就照实说，不挑一个顶上
  const baseVoice = String(input.voice || cfg.voice || "").trim();
  const segs = v.segs.map((s) => ({ text: s.text, voice: s.voice || baseVoice }));
  if (/dashscope/i.test(String(cfg.base_url))) {
    // 通义的接口音色是必填，不填回 400。一批六十句跑到那句才撞上，前面的钱就白花在一条注定拼不齐的音轨上
    const at = segs.findIndex((s) => !s.voice);
    if (at >= 0) {
      const vs = dashVoices(cfg.model);
      return {
        content: `通义语音要指定音色，第 ${at + 1} 句没有（这一句、整批的 voice 和设置里的默认音色都是空的）。` +
          (vs.length ? `${cfg.model} 可选：${vs.join(" / ")}。` : "") +
          "给整批加 voice，或者在 设置 → 模型 → 语音合成 填默认音色。还没调语音模型，没花钱。",
        isError: true,
      };
    }
  }

  // 量时长离不开 ffmpeg / ffprobe。没有就在花钱之前停：先买了一堆句子再发现量不了，钱花了东西用不上
  let bins = null;
  try { bins = await (deps.bins || MP.resolveMediaBins)(); } catch { bins = null; }
  const ff = (bins && bins.ffmpeg && bins.ffmpeg.bin) || "";
  const fp = (bins && bins.ffprobe && bins.ffprobe.bin) || "";
  if (!ff || !fp) {
    const lack = [ff ? "" : "ffmpeg", fp ? "" : "ffprobe"].filter(Boolean).join(" 和 ");
    return {
      content: `按句配音要先量每句时长，本机没找到 ${lack}。装法：${(bins && bins.install) || "装 ffmpeg（自带 ffprobe）"}。装好后原样再调一次。这一步还没调语音模型，没花钱。`,
      isError: true,
    };
  }

  const wsRoot = ctx.wsRoot;
  const saveDir = ctx.saveDir || wsRoot;
  const resolveFile = ctx.resolveFile || ((/** @type {string} */ r) => path.resolve(saveDir, r));
  const segDir = path.join(saveDir, `${v.stem}_分句`);
  const clipExt = MEDIA.ttsExtOf(cfg);
  const speed = input.speed ? input.speed : undefined;
  /** @type {Map<string, number>} */
  const firstByFile = new Map();
  const plan = segs.map((s, i) => {
    const file = segFileName(v.stem, clipExt, { model: cfg.model, voice: s.voice, speed, text: s.text });
    // no_cache 不进这份参数：它只决定这次查不查缓存，新买到的照样记进缓存，下次不带它就能复用
    const segInput = {
      text: s.text, filename: file,
      ...(s.voice ? { voice: s.voice } : {}), ...(speed ? { speed } : {}), ...(input.model ? { model: input.model } : {}),
    };
    // 同一批里一模一样的两句（对白里的「嗯。」）只买一次，后面那句用前面那句的文件
    const dupOf = firstByFile.has(file) ? /** @type {number} */ (firstByFile.get(file)) : -1;
    if (dupOf < 0) firstByFile.set(file, i);
    const k = genCache.key("text_to_speech", segInput, cfg, segDir, resolveFile, wsRoot);
    const hit = dupOf < 0 && !input.no_cache && genCache.peek(k, wsRoot);
    return { text: s.text, voice: s.voice, file, segInput, k, hit, dupOf };
  });
  const N = plan.length;

  // 额度只按要新买的句子问；全命中就一分不花，也就不问
  const toBuy = plan.filter((p) => !p.hit && p.dupOf < 0);
  let hold = null;
  if (toBuy.length) {
    const chars = toBuy.reduce((n, p) => n + p.text.length, 0);
    const g = (ctx.gate || defaultGate)({ n: toBuy.length, units: Math.max(0.001, chars / 1000), model: input.model });
    if (g && g.bad) return g.bad;
    hold = g ? g.hold : null;
  }
  // 额度只问了没命中的那几句，所以命中的必须现在就拿到手：等前面几句买完再去取，
  // 这一批自己记缓存时的淘汰、用户删文件，都可能让它变成没命中——那句就成了没问额度就买的钱。
  // peek、问额度、取，三步中间没有 await，这一批自己的写入插不进来
  /** @type {Map<number, string>} */
  const cachedAt = new Map();
  for (const [i, p] of plan.entries()) {
    if (!p.hit) continue;
    const h = genCache.get(p.k, wsRoot);
    if (h && h.file) { cachedAt.set(i, h.file); continue; }
    quota.undo(hold);
    return {
      content: `第 ${i + 1} 句的缓存刚刚没了，这次额度没算它，就不买了，一句都没花钱。原样再调一次，会按要新买的句数重新问额度。`,
      isError: true,
    };
  }

  const now = deps.now || Date.now;
  let lastAt = -Infinity;
  /** @param {{ stage: string, done?: number, total?: number, pct?: number, label: string }} p @param {boolean} force */
  const report = (p, force) => {
    if (!ctx.onProgress) return;
    const t = now();
    if (!force && t - lastAt < PROGRESS_MS) return;
    lastAt = t;
    // 进度只是给人看的，界面那头出什么错都不能把一批已经在花钱的配音拖断
    try { ctx.onProgress(p); } catch {}
  };

  const stop = ctx.stop;
  const synth = deps.synth || MEDIA.textToSpeech;
  /** @type {string[]} */
  const clipAbs = [];
  /** @type {boolean[]} */
  const reusedAt = [];
  let paid = 0, paidChars = 0;
  /** @type {ToolResult | null} */
  let fail = null;
  /**
   * @param {number} done
   * @param {"" | "sure" | "maybe"} [inFlight] 停下时第 done+1 句的请求到了哪一步：sure = 上游已经回了音频（钱花了、按一句记账），
   *   maybe = 请求发出去了、还没回（扣没扣说不准，不记账）
   */
  const stoppedAt = (done, inFlight = "") => ({
    content: `用户已停止任务：按句配音停在第 ${done + 1} 句（共 ${N} 句）。` +
      (done ? `前 ${done} 句已经配好、存进缓存，接着做就原样再调一次，这几句不会再花钱。` : "一句都还没配好。") +
      (inFlight === "sure" ? `第 ${done + 1} 句上游已经回了音频，这句按已花钱记账，但没落盘，再调会重配这一句。` : "") +
      (inFlight === "maybe" ? `第 ${done + 1} 句的请求已经发出，上游可能已扣费（没记账），再调会重配这一句。` : ""),
    isError: true, stopped: true,
  });

  try { fs.mkdirSync(segDir, { recursive: true }); } catch {}
  report({ stage: "tts", done: 0, total: N, label: `配音 0/${N} 段` }, false);
  try {
    for (let i = 0; i < N; i++) {
      const p = plan[i];
      if (stop && stop.aborted) { fail = stoppedAt(i); break; }
      let file = "";
      if (p.dupOf >= 0) {
        file = path.basename(clipAbs[p.dupOf]);
        reusedAt[i] = true;
      } else if (p.hit) {
        file = cachedAt.get(i) || "";
        reusedAt[i] = true;
      }
      if (!file) {
        let out;
        try {
          out = await synth(ctx.media, p.segInput, ctx.timeoutMs, segDir, stop);
        } catch (e) {
          if ((e && e.stopped) || (stop && stop.aborted)) {
            // e.stopped 只在上游已经回了音频 / 音频地址之后才抛（media.js 的约定）：这一单收了，照实入账。
            // 别的（请求飞在半路被掐）扣没扣说不准，不记账，但得告诉用户
            const billed = !!(e && e.stopped);
            if (billed) { paid++; paidChars += p.text.length; }
            fail = stoppedAt(i, billed ? "sure" : "maybe");
            break;
          }
          out = { content: String((e && e.message) || e), isError: true };
        }
        if (!out || out.isError) {
          // 不自动重试：这一单上游收没收、扣没扣，这里说不准，重试可能就是同一句买两次。
          // 上游的原话一字不改地带出去，媒体健康表靠里面的状态码判这条渠道还通不通
          fail = {
            content: `第 ${i + 1} 句没配成（共 ${N} 句）：${(out && out.content) || "没有返回音频"}\n` +
              (i ? `前 ${i} 句已经配好、存进缓存了。` : "") +
              `这一句没有自动重试，免得同一句被扣两次钱。按上面的原因改好后原样再调一次：配好的句子直接复用，只从第 ${i + 1} 句开始花钱。`,
            isError: true,
          };
          break;
        }
        paid++;
        paidChars += p.text.length;
        // 买到手立刻记进缓存：后面哪一句出事、哪一步停下，这一句都不用再买
        genCache.put(p.k, out, segDir, wsRoot, cfg.model);
        file = out.file || p.file;
        reusedAt[i] = false;
      }
      clipAbs.push(path.join(segDir, file));
      report({ stage: "tts", done: i + 1, total: N, label: `配音 ${i + 1}/${N} 段` }, i + 1 === N);
    }
  } finally {
    // 记账放在 finally：后面哪句失败、用户中途停下，已经买到的那几句照样入账；一句没买就把预扣退回去
    if (paid > 0) {
      // record 的参数类型是 tsc 从默认值 {} 推出来的，推不出 hold / actor（媒体那几路都这么传），这里断言一下
      quota.record("tts", /** @type {any} */ ({
        n: paid, units: Math.max(0.001, paidChars / 1000), provider: MEDIA.mediaProviderOf(ctx.media, "tts"),
        model: cfg.model, meta: `按句配音 ${N} 句`, hold,
      }));
    } else {
      quota.undo(hold);
    }
  }
  if (fail) return fail;

  // ── 量时长、拼整轨。从这里往后一分钱都不花了，出了问题也只说「修好再调，不会再花钱」──
  const probe = deps.probe || MP.probeAudio;
  const toPcm = deps.toPcm || MP.toPcmWav;
  const concat = deps.concat || MP.concatWithGaps;
  const fullAbs = path.join(saveDir, v.stem + v.fullExt);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tts-"));
  let rate = 24000;
  /** @type {number[]} */
  const samples = [];
  /** @type {{ starts?: number[], ends?: number[] } | null} */
  let joined = null;
  let at = -1;
  try {
    report({ stage: "compose", pct: 0, label: "拼整轨 0%" }, false);
    // 采样率跟第一句走：上游回的是什么就用什么，不重采样到别的数上，少一道失真
    const first = await probe(fp, clipAbs[0], { signal: stop });
    if (first && Number.isInteger(first.sampleRate) && first.sampleRate >= 8000 && first.sampleRate <= 192000) rate = first.sampleRate;
    const wavs = [];
    for (at = 0; at < N; at++) {
      const out = path.join(tmp, `${at + 1}.wav`);
      const w = await toPcm(ff, clipAbs[at], out, { rate, signal: stop });
      if (!w || !(w.samples > 0)) throw Object.assign(new Error("解出来是空的"), { decodedEmpty: true });
      samples.push(w.samples);
      wavs.push(out);
      report({ stage: "compose", pct: Math.round(((at + 1) / N) * 90), label: `拼整轨 ${Math.round(((at + 1) / N) * 90)}%` }, false);
    }
    at = -1;
    joined = await concat(ff, wavs, { gapSamples: MP.msToSamples(v.gapMs, rate), rate, outAbs: fullAbs, signal: stop });
  } catch (e) {
    if ((stop && stop.aborted) || (e && e.name === "AbortError")) {
      return { content: `用户已停止任务：${N} 句都配好了、存进缓存，整轨还没拼。原样再调一次就接着拼，不会再花钱。`, isError: true, stopped: true };
    }
    const msg = String((e && e.message) || e);
    // 本机这头的错（超时、ffmpeg 跑不起来 / 被杀、临时目录写不进、转完读不出 WAV 头）跟那句音频无关：
    // 修好原样再调就行。只有 ffmpeg 真跑完、按退出码拒了输入，或者解出来是空的，才轮到问要不要重买这一句——
    // 也不替用户猜是上游的锅、不叫人删：删了就是再花一次钱
    const x = /** @type {any} */ (e) || {};
    const local = !x.decodedEmpty && (
      x.timedOut === true || ["ENOENT", "EACCES", "EPERM", "ENOSPC"].includes(x.code) || typeof x.exitCode !== "number" ||
      /No space|Permission denied|Error opening output|output file/i.test(msg)
    );
    return {
      content: at >= 0
        ? `${N} 句都配好了，但第 ${at + 1} 句的音频解不开（${path.basename(clipAbs[at])}）：${msg}\n` + (local
          ? `这一步是本机转码。按上面的原因修好后原样再调一次：${N} 句都在缓存里，不会再花钱，不用删文件。`
          : (N > 1 ? `其余 ${N - 1} 句已存进缓存，不会再花钱。` : "") +
            `这一句要不要重买（约 ${plan[at].text.length} 字，会再扣一次钱）先问用户；同意了再删掉这个文件、原样调用，只会重配这一句。`)
        : `${N} 句都配好了，但拼整轨没成：${msg}\n这 ${N} 句已经付过钱、存进缓存了；修好后原样再调一次，不会再花钱。`,
      isError: true,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  const lay = joined && Array.isArray(joined.starts) && Array.isArray(joined.ends) && joined.starts.length === N
    ? { starts: joined.starts, ends: joined.ends }
    : MP.gapLayout(samples, MP.msToSamples(v.gapMs, rate));
  const times = rowsFromLayout(samples, lay.starts, lay.ends, rate, v.gapMs);
  const totalMs = MP.samplesToMs(lay.ends[N - 1], rate);
  report({ stage: "compose", pct: 100, label: "拼整轨 100%" }, true);

  // mp3 整轨是拿同一份 PCM 编的，差的只是编码补齐。差得多了照实说，不藏
  let drift = "";
  if (v.fullExt === ".mp3") {
    try {
      const pf = await probe(fp, fullAbs, { signal: stop });
      const d = pf ? pf.ms - totalMs : 0;
      if (pf && Math.abs(d) > MP3_DRIFT_NOTE_MS) {
        drift = `注意：整轨是 mp3，ffprobe 量出来 ${pf.ms}ms，比按采样算的 ${totalMs}ms ${d > 0 ? "长" : "短"} ${Math.abs(d)}ms（mp3 编码补齐）。字幕要逐毫秒对齐就用 .wav。`;
      }
    } catch {}
  }

  /** @param {string} abs */
  const rel = (abs) => {
    const r = path.relative(wsRoot, abs);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : path.basename(abs);
  };
  const rows = plan.map((p, i) => ({ i: i + 1, text: p.text, voice: p.voice, file: rel(clipAbs[i]), ...times[i], cached: !!reusedAt[i] }));
  const srtAbs = path.join(saveDir, v.stem + ".srt");
  const jsonAbs = path.join(saveDir, v.stem + ".json");
  const manifest = {
    v: 1, kind: "tts_segments", model: cfg.model, voice: baseVoice, sample_rate: rate, gap_ms: v.gapMs, total_ms: totalMs,
    full: rel(fullAbs), srt: rel(srtAbs),
    segments: rows.map((r) => ({ i: r.i, text: r.text, voice: r.voice, file: r.file, ms: r.ms, start_ms: r.start_ms, end_ms: r.end_ms, slot_ms: r.slot_ms, cached: r.cached })),
  };
  try {
    // 不留 .bak：这两份是成果，重跑就该是新的那一份；.bak 会混进对话的成果列表里
    store.writeTextAtomic(srtAbs, buildSegSrt(rows), { backup: false });
    store.writeJsonAtomic(jsonAbs, manifest, { pretty: true, backup: false });
  } catch (e) {
    return { content: `整轨已经拼好（${rel(fullAbs)}），但字幕和时长清单写不进去：${e.message}。原样再调一次，不会再花钱。`, isError: true };
  }

  const reused = N - paid;
  security.audit("语音合成", `按句 ${N} 句：新合成 ${paid} 句，复用 ${reused} 句 → ${v.stem}${v.fullExt}`, "放行");
  const cost = paid
    ? `新合成 ${paid} 句（约 ${paidChars} 字）` + (reused ? `，${reused} 句参数没变直接复用、没再花钱` : "") + "；要整批重配加 no_cache: true"
    : `${N} 句参数都没变，全部直接复用、没再花钱；要整批重配加 no_cache: true`;
  const lines = [
    `按句配音完成：${N} 句，整轨 ${sec(totalMs)} 秒（句间停顿 ${v.gapMs}ms）`,
    `整轨：${rel(fullAbs)}`,
    `字幕：${rel(srtAbs)}`,
    `时长清单：${rel(jsonAbs)}`,
    ...rows.map((r) => `#${r.i}  ${sec(r.ms)}s  ${sec(r.start_ms)}→${sec(r.end_ms)}  「${head(r.text)}」`),
    cost,
    "排镜头：每镜 ≥ 该句 ms + gap_ms（清单里的 slot_ms）",
  ];
  if (drift) lines.push(drift);
  return { content: lines.join("\n"), isError: false, file: v.stem + v.fullExt };
}

module.exports = {
  isBatch, validate, segFileName, planTimeline, buildSegSrt, ttsSegments,
  SEG_MAX, SEG_MAX_CHARS, GAP_DEFAULT_MS, GAP_MAX_MS,
};
