// @ts-check
"use strict";
/**
 * 时间轴成片的字幕：断行、排时间、出 .srt / .ass。纯函数，不碰盘。
 *
 * 字幕坏掉的样子全都是「能播」：
 *   - 一行塞二十个字，竖屏上两头出画，或者被播放器自己折成三行盖住半张脸；
 *   - 在「iPhone15」「3.5」中间断开，上一行 iPhone、下一行 15，读起来像两句话；
 *   - 按「整段配音时长」平均分每一行，第一句短第二句长的时候，字幕会一直抢在嘴前面。
 * 所以断行按显示宽度（汉字 1、字母数字 0.5）来，先在句号问号处断、不够再在逗号处断，
 * 拉丁词和数字永远是一个整体；时间按字数比例分在**每一句自己探到的时长**里，并对齐到帧。
 *
 * .ass 里不写字距（Spacing 0、不用 \fsp）：中文加字距是排版事故，不是风格。
 */

/** @typedef {{text: string, start: number, end: number}} Cue */
/** @typedef {{text: string, start: number, dur: number}} TimedSentence */
/** @typedef {{fontsize: number, marginVRatio: number, marginLR: number|null, refH: number}} SafeArea */

/**
 * 每种画幅的字幕位置。竖屏的底部要让开抖音/视频号自己的标题和按钮（大约底下两成），
 * 左右也要让开右侧那一列点赞评论，所以竖屏的边距最大。refH 是这组数字量出来时的画面高度，
 * 别的尺寸按 H/refH 等比缩——同一套数字在 360×640 的小样上和 1080×1920 上看起来一样。
 * @type {Record<string, SafeArea>}
 */
const SAFE_AREA = {
  "9:16": { fontsize: 56, marginVRatio: 0.2, marginLR: 130, refH: 1920 },
  "16:9": { fontsize: 56, marginVRatio: 0.08, marginLR: null, refH: 1080 },
  "1:1": { fontsize: 56, marginVRatio: 0.12, marginLR: null, refH: 1080 },
  "3:4": { fontsize: 60, marginVRatio: 0.15, marginLR: null, refH: 1440 },
};
/** 表里写 null 的左右边距：ASS 的常见默认值，按 refH 缩 */
const DEFAULT_MARGIN_LR = 60;

/** 宽字符（占一个汉字宽）：中日韩、全角标点、常见的中文引号省略号破折号 */
const WIDE_RE = /[ᄀ-ᅟ—‘’“”…⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/**
 * 显示宽度：汉字算 1，字母数字空格算 0.5。「14 个字」说的是 14 个汉字的宽度
 * @param {unknown} s
 * @returns {number}
 */
function displayUnits(s) {
  let n = 0;
  for (const ch of String(s == null ? "" : s)) n += WIDE_RE.test(ch) ? 1 : 0.5;
  return n;
}

/** 句末：在这里断一定对 */
const STRONG = new Set(["。", "！", "？", "!", "?", "；", ";", ".", "\n"]);
/** 句中停顿：一句太长时才在这里断 */
const WEAK = new Set(["，", "、", ",", "：", ":"]);
/**
 * 行尾不该留的标点（问号叹号留着：那是语气，不是分隔）。
 * 英文句号只去单独的一个：「...」是省略号，也是语气
 */
const TRAIL_RE = /(?:[，。；、：,;:\s]|(?<!\.)\.)+$/u;
/**
 * 这些字不能打头，得粘在上一个字后面；反过来开引号不能落在行尾。
 * 句读标点也在里面：不粘住的话，一句英文刚好卡在行宽上，最后那个「.」会自己占一行
 */
const CLOSERS = new Set(["”", "’", "」", "』", "）", ")", "》", "〉", "】", "]", "…", "—", "%", "％",
  "，", "。", "、", "；", "：", "！", "？", ",", ".", ";", ":", "!", "?"]);
const OPENERS = new Set(["“", "‘", "「", "『", "（", "(", "《", "〈", "【", "["]);

/**
 * 切成「不能再拆」的小块：一个汉字、一个标点、一整个拉丁词或数字（iPhone15、3.5、3,500、10:30）。
 * 数字里的逗号冒号不算分隔——不然「3,500 元」会在逗号处断成两行
 * @param {string} text
 * @returns {string[]}
 */
function atomsOf(text) {
  const raw = text.match(/[A-Za-z0-9]+(?:[.,:'’_\-/+][A-Za-z0-9]+)*|[ \t]+|\n|./gsu) || [];
  /** @type {string[]} */
  const out = [];
  let open = "";
  for (const a of raw) {
    if (OPENERS.has(a)) { open += a; continue; }
    if (CLOSERS.has(a) && out.length && !open) { out[out.length - 1] += a; continue; }
    out.push(open + a);
    open = "";
  }
  if (open) out.push(open);
  return out;
}

/** @param {string} s */
function tidy(s) { return s.replace(/\s+/g, " ").trim().replace(TRAIL_RE, "").trim(); }

/**
 * 把一句按显示宽度拆成几行，尽量等长：14+2 不如 8+8，短的那行一闪而过，没人读得完
 * @param {string[]} atoms
 * @param {number} max
 * @returns {string[]}
 */
function packAtoms(atoms, max) {
  const total = displayUnits(tidy(atoms.join("")));
  if (total <= max) return [atoms.join("")];
  const lines = Math.ceil(total / max);
  const aim = total / lines;
  /** @type {string[]} */
  const out = [];
  let cur = "", w = 0;
  for (const a of atoms) {
    const u = displayUnits(a);
    const isSpace = /^[ \t]+$/.test(a);
    // 量宽度按「去掉行尾标点之后」量：那个标点上屏前就删了，不该把最后一个词挤到下一行去
    if (cur && !isSpace && (displayUnits(tidy(cur + a)) > max || (w >= aim - 0.25 && out.length < lines - 1))) {
      out.push(cur);
      cur = ""; w = 0;
    }
    if (!cur && isSpace) continue;
    cur += a; w += u;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * 一段话切成一行一行的字幕。
 * 先在句号问号叹号分号处断；一句还是太长，就在逗号顿号冒号处断再尽量拼回去；
 * 一个分句本身都超宽，才按字硬断（拉丁词和数字不拆）。行尾的逗号句号去掉——字幕上留着它们只是噪音
 * @param {unknown} text
 * @param {number} [maxUnits] 一行最多几个汉字宽，默认 14
 * @returns {string[]}
 */
function splitCues(text, maxUnits = 14) {
  const max = Number(maxUnits) > 1 ? Number(maxUnits) : 14;
  const atoms = atomsOf(String(text == null ? "" : text).replace(/\r\n?/g, "\n"));
  /** @type {string[][]} */
  const sentences = [[]];
  for (const a of atoms) {
    const last = sentences[sentences.length - 1];
    if (a === "\n") { if (last.length) sentences.push([]); continue; }
    last.push(a);
    if (STRONG.has(a.replace(/[”’」』）)》〉】\]]+$/u, "").slice(-1))) sentences.push([]);
  }
  /** @type {string[]} */
  const out = [];
  for (const s of sentences) {
    if (!s.length) continue;
    const whole = tidy(s.join(""));
    if (!whole) continue;
    if (displayUnits(whole) <= max) { out.push(whole); continue; }
    // 太长：先按逗号顿号切成分句，再把相邻的短分句拼回一行
    /** @type {string[][]} */
    const clauses = [[]];
    for (const a of s) {
      clauses[clauses.length - 1].push(a);
      if (WEAK.has(a.slice(-1))) clauses.push([]);
    }
    let line = "";
    const flush = () => { const t = tidy(line); if (t) out.push(t); line = ""; };
    for (const c of clauses) {
      if (!c.length) continue;
      const text = c.join("");
      if (displayUnits(tidy(line + text)) <= max) { line += text; continue; }
      flush();
      if (displayUnits(tidy(text)) <= max) { line = text; continue; }
      for (const piece of packAtoms(c, max)) { const t = tidy(piece); if (t) out.push(t); }
    }
    flush();
  }
  return out;
}

/** @param {number} t @param {number} fps */
function snap(t, fps) { return Math.round(t * fps) / fps; }
/** @param {number} n */
function r6(n) { return Math.round(n * 1e6) / 1e6; }

/**
 * 给每一句排字幕时间。
 * 每一句都有自己**探到的**起点和时长（配音是一句一个文件，或者整段一个文件）；
 * 句子里拆出来的几行按显示宽度分这段时长。所有时间对齐到帧：不对齐的话，
 * 同一条字幕在 30fps 的竖屏和 25fps 的横屏上会差出一帧，十几句以后就能看出来。
 * 每句的第一行从这句的起点开始、最后一行在这句的终点结束，中间不留缝也不重叠
 * @param {TimedSentence[]} sentences
 * @param {number} fps
 * @param {number} [maxUnits]
 * @returns {Cue[]}
 */
function timeCues(sentences, fps, maxUnits = 14) {
  const f = Number(fps) > 0 ? Number(fps) : 30;
  /** @type {Cue[]} */
  const out = [];
  for (const s of sentences || []) {
    const lines = splitCues(s.text, maxUnits);
    if (!lines.length || !(Number(s.dur) > 0)) continue;
    const a = Math.round(Number(s.start) * f), b = Math.round((Number(s.start) + Number(s.dur)) * f);
    if (b <= a) continue;
    const weights = lines.map((l) => Math.max(1, displayUnits(l)));
    const sum = weights.reduce((n, w) => n + w, 0);
    // 帧号上分：每一行至少一帧，分不下（行数比帧数还多）就把多出来的几行并进最后一行
    const room = b - a;
    const n = Math.min(lines.length, room);
    const texts = n < lines.length ? [...lines.slice(0, n - 1), lines.slice(n - 1).join(" ")] : lines;
    const ws = n < lines.length ? [...weights.slice(0, n - 1), weights.slice(n - 1).reduce((x, y) => x + y, 0)] : weights;
    let acc = 0, prev = a;
    for (let i = 0; i < texts.length; i++) {
      acc += ws[i];
      let end = i === texts.length - 1 ? b : a + Math.round(room * acc / sum);
      end = Math.max(end, prev + 1);
      end = Math.min(end, b - (texts.length - 1 - i));
      out.push({ text: texts[i], start: r6(prev / f), end: r6(end / f) });
      prev = end;
    }
  }
  return out;
}

/** 00:00:01,500。和 drama-compose 的字幕同一种写法（那边的实现搬到了这里） @param {unknown} sec @returns {string} */
function srtTime(sec) {
  const ms = Math.max(0, Math.round(Number(sec) * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** ASS 的时间是 0:00:01.50（百分之一秒） @param {unknown} sec @returns {string} */
function assTime(sec) {
  const cs = Math.max(0, Math.round(Number(sec) * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/**
 * 整条片子一份 .srt（所有画幅共用一条时间轴）
 * @param {Cue[]} cues
 * @returns {string}
 */
function buildSrt(cues) {
  /** @type {string[]} */
  const lines = [];
  let n = 0;
  for (const c of cues || []) {
    const t = String(c.text || "").replace(/\s*\n\s*/g, " ").trim();
    if (!t) continue;
    n++;
    lines.push(String(n), `${srtTime(c.start)} --> ${srtTime(c.end)}`, t, "");
  }
  return n ? lines.join("\n") + "\n" : "";
}

/**
 * ASS 里 { } \ 是控制符：台词里带一个 {，后面那段就会被当成样式代码吞掉。换成全角，看起来一样
 * @param {unknown} s
 */
function escAssText(s) {
  return String(s == null ? "" : s).replace(/\{/g, "｛").replace(/\}/g, "｝").replace(/\\/g, "＼").replace(/\s*\n\s*/g, " ");
}

/**
 * 按画幅和画面高度算字号和边距
 * @param {string} aspect 如 "9:16"
 * @param {number} w
 * @param {number} h
 * @param {{fontsize?: number}} [style] 用户写死的字号（按 1080 宽的竖屏写的，同样按比例缩）
 * @returns {{fontsize: number, marginV: number, marginLR: number}}
 */
function safeAreaFor(aspect, w, h, style = {}) {
  let sa = SAFE_AREA[aspect];
  if (!sa) {
    // 表里没有的画幅（4:5、21:9）：找宽高比最近的那一档
    const want = w / h;
    let best = "9:16", diff = Infinity;
    for (const k of Object.keys(SAFE_AREA)) {
      const [a, b] = k.split(":").map(Number);
      const d = Math.abs(Math.log((a / b) / want));
      if (d < diff) { diff = d; best = k; }
    }
    sa = SAFE_AREA[best];
  }
  const k = h / sa.refH;
  const base = Number(style && style.fontsize) > 0 ? Number(style.fontsize) : sa.fontsize;
  return {
    fontsize: Math.max(8, Math.round(base * k)),
    marginV: Math.round(sa.marginVRatio * h),
    marginLR: Math.round((sa.marginLR == null ? DEFAULT_MARGIN_LR : sa.marginLR) * k),
  };
}

/**
 * 一个画幅一份 .ass。
 * PlayRes 就是成片的像素尺寸，所以字号边距都按像素写；WrapStyle 2 = 不自动折行
 * （行已经按宽度切好了，再让 libass 折一次会在奇怪的地方断）。
 * Spacing 0、不写 \fsp：中文不加字距
 * @param {{w: number, h: number, family: string, fontsize: number, marginV: number, marginLR: number, cues: Cue[]}} o
 * @returns {string}
 */
function buildAss(o) {
  const family = String(o.family || "sans-serif").replace(/[,\r\n]/g, " ").trim() || "sans-serif";
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${o.w}`,
    `PlayResY: ${o.h}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // 白字黑边、底部居中。描边 3 在任何底色上都读得出来，比半透明底条更不挡画面
    `Style: Default,${family},${o.fontsize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,${o.marginLR},${o.marginLR},${o.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = (o.cues || [])
    .filter((c) => String(c.text || "").trim())
    .map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${escAssText(c.text).trim()}`);
  return head.concat(events).join("\n") + "\n";
}

module.exports = {
  SAFE_AREA, DEFAULT_MARGIN_LR,
  displayUnits, splitCues, timeCues, srtTime, assTime, buildSrt, buildAss, escAssText, safeAreaFor,
  _internals: { atomsOf, packAtoms, tidy },
};
