// @ts-check
"use strict";
/**
 * 短剧合成：把画布上的镜头，真的拼成一条能播的成片。
 *
 * 画布上前六档（剧本 → 定妆 → 分镜 → 首帧 → 镜头视频 → 配音）都已经是「按一下就出文件」了，
 * 只有最后一档不是：「最终剪辑」节点点下去，只是把一句「请……给出可执行方案」塞进对话框。
 * 也就是说，钱全花完、三十个镜头全生成完之后，这部戏差的是**一步确定性的拼装**，
 * 而它被交给了模型去临场发挥——模型跳一步、少一个 -shortest、把镜头顺序排错，
 * 全都不会报错，只会出一条播起来不对的片子，或者干脆什么都没有。
 *
 * 所以这里把 skills/short-drama/skill.md 里那套 ffmpeg 配方**写成代码**：
 *   ① 定顺序：镜头 ID（S1-01）优先，其次画布上的阅读顺序，最后按原始次序兜底——
 *      而且算出来的顺序要摆到界面上给人看过再跑，不是背着人排。
 *   ② 先体检：ffmpeg 在不在、每一镜的视频**是不是真在盘上**、配音多长、画幅一不一致。
 *      缺什么就明说缺什么（连装法一起给），绝不先跑三十分钟再在最后一条命令上撞墙。
 *   ③ 再拼装：逐镜头把画面和配音合成片段 → concat 成成片 → 需要的话烧字幕。
 *      配音比画面长就把画面的最后一帧接住（tpad），不是把话切掉——短剧里被切掉的是台词。
 *   ④ 不知道就说不知道：探不到时长就不生成字幕（时间轴会对不上，宁可不给）；
 *      估不出耗时就写「估不出来」；本机的 ffmpeg 没带 libass 就**开跑前**说烧不了字幕，
 *      而不是等成片都拼完了、在最后一条命令上才蹦出一句英文报错。
 *
 * 这一层是纯函数：不碰 fs、不起进程。文件在不在、多长、什么画幅，都由调用方探好了传进来，
 * 这样它能被单测钉死——而「拼出来的命令对不对」正是最该钉死、最难靠肉眼看出来的东西。
 */

/** @typedef {import("./types/drama").CanvasNode} CanvasNode */
/** @typedef {import("./types/drama").CanvasPayload} CanvasPayload */
/** @typedef {import("./types/drama").CanvasStateLike} CanvasStateLike */
/** @typedef {import("./types/drama").AssetHit} AssetHit */
/** @typedef {import("./types/drama").Locate} Locate */
/** @typedef {import("./types/drama").MediaProbe} MediaProbe */
/** @typedef {import("./types/drama").ComposeOptions} ComposeOptions */
/** @typedef {import("./types/drama").PickedFile} PickedFile */
/** @typedef {import("./types/drama").MusicCandidate} MusicCandidate */
/** @typedef {import("./types/drama").ComposeRow} ComposeRow */
/** @typedef {import("./types/drama").ComposeStep} ComposeStep */
/** @typedef {import("./types/drama").ComposePlan} ComposePlan */
/** @typedef {import("./types/drama").Blocker} Blocker */

/** 这些后缀才算视频 / 音频。字段里写着 video 但指的是一张 png，是真会发生的事 */
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
/** 起手模板里的占位文字，原样没改 = 这一镜没有台词，不是「台词是这几个字」 */
const PLACEHOLDERS = ["对白或旁白…", "镜头内容与运动…", "无人声", ""];

const AUDIO_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"];
const X264_ARGS = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
/** 画幅探不出来时的兜底：短剧是竖屏，1080x1920 是各家生视频接口的默认出片尺寸 */
const FALLBACK_SIZE = { w: 1080, h: 1920 };
const FALLBACK_FPS = 30;
/** 配音和画面差这么点以内就不折腾了。25 帧的片子一帧 40ms，0.2 秒是五帧，肉眼看不出接缝 */
const SLACK = 0.2;

/**
 * 配乐。短剧没有配乐就只是一串会说话的画面——它是这条产线上最后一件「人一听就知道差在哪、
 * 但没人知道该敲哪条命令」的事，所以也得写成代码，不能留给模型临场发挥。
 *
 * 音量 0.25（约 −12dB）：再大压台词，再小等于没放。
 * 注意 amix 默认会把每一路都除以 2（normalize=1），所以喂进去之前得先乘回来——
 * 不乘的话人声会**整条片子小一半**，而这种错听起来只是「有点闷」，没人会想到是混音写错了。
 */
const MUSIC_GAIN = 0.25;
/** 淡入淡出。片尾硬切一下音乐最难听，而片子多长我们是知道的（每一镜都探到了时长才敢算） */
const MUSIC_FADE_IN = 1.5, MUSIC_FADE_OUT = 2.5;
/**
 * 哪些字眼算「这段音频是配乐」。
 * ⚠️ 声音节点「素材用途」的默认值就是**「对白/音乐」**——它两边都占。
 * 只看「音乐」两个字的话，画布上每一段配音都会被当成配乐混进整条片子，
 * 而症状是「片子从头到尾有人在念第三镜的台词」，没人会往「它把配音当配乐了」上想。
 * 所以规矩是：有配乐字眼、**且没有人声字眼**，才算配乐。
 */
const MUSIC_HINT = /(配乐|背景音|主题曲|片头曲|片尾曲|音乐|bgm|soundtrack|score|music)/i;
const VOICE_HINT = /(对白|台词|旁白|配音|人声|voice|dialog|narrat)/i;

/** @param {Partial<CanvasNode>|null|undefined} node @returns {CanvasPayload} */
function payloadOf(node) { return (node && node.payload) || {}; }
/** @param {unknown} p @returns {string} */
function baseOf(p) { return String(p || "").split(/[\\/]/).pop() || ""; }
/** @param {unknown} s @returns {boolean} */
function isBlank(s) { const t = String(s == null ? "" : s).trim(); return !t || PLACEHOLDERS.includes(t); }
/** @param {unknown} n @param {number} [d] @returns {number} */
function round(n, d = 2) { const k = Math.pow(10, d); return Math.round(Number(n) * k) / k; }
/**
 * 文件名里不能出现的东西换成下划线。镜头 ID 是用户自己敲的，什么都可能有
 * @param {unknown} s
 * @returns {string}
 */
function safeName(s) { return String(s || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "镜头"; }

/**
 * 镜头顺序。
 *
 * 排错顺序是这条链路上最贵的错：片子拼出来了、能播、时长也对，只有情节是乱的——
 * 没有任何一条断言会红，只有人看到第三分钟才发现。所以规矩写死成一条，并且摆到界面上：
 *   ① payload.order 是数字就先认它（用户/Agent 显式排过）；
 *   ② 认镜头 ID 里的「第几场-第几镜」（S1-02、场1-02、1_2 都认）；
 *   ③ 都认不出来就按画布上的阅读顺序（先上下后左右，200px 算同一排）；
 *   ④ 最后按原数组次序兜底，保证同一张画布每次排出来都一样。
 * @param {Partial<CanvasNode>} node
 * @param {number} index
 * @returns {number[]}
 */
function orderKeyOf(node, index) {
  const p = payloadOf(node);
  const m = /(\d+)\s*[-_–—.]\s*(\d+)/.exec(String(p.id || p.title || ""));
  const ord = Number(p.order);
  return [
    Number.isFinite(ord) ? ord : Infinity,
    m ? Number(m[1]) : Infinity,
    m ? Number(m[2]) : Infinity,
    Math.round((Number(node && node.position && node.position.y) || 0) / 200),
    Number(node && node.position && node.position.x) || 0,
    index,
  ];
}
/**
 * @template {Partial<CanvasNode>} T
 * @param {T[]} nodes
 * @returns {T[]}
 */
function sortShots(nodes) {
  return nodes
    .map((node, index) => ({ node, key: orderKeyOf(node, index) }))
    .sort((a, b) => { for (let i = 0; i < a.key.length; i++) { if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1; } return 0; })
    .map((x) => x.node);
}

/**
 * 把字段里的路径换成**盘上真有的那个文件**。
 * 只认这一类该有的后缀：video 字段指着一张 png，那就是这一镜根本没有视频，
 * 不是「有视频只是格式怪」——后者会一路带到 ffmpeg 那儿去报一句没人看得懂的话。
 *
 * locate（drama-pipeline 的 assetLocator）给了就按它认：先按相对路径，再按文件名全区搜，
 * 同名好几份时 rel 留空、带上 ambiguous——拼进片子的是哪一集的画面，不能靠目录遍历的先后。
 * 不给就还是老办法：files 按文件名查。
 * @param {Record<string, any>} payload
 * @param {string[]} keys 按顺序认，第一个有值的字段说了算
 * @param {RegExp} re 这一类该有的后缀
 * @param {Map<string, string>|null|undefined} files basename → 工作区相对路径
 * @param {Locate} [locate]
 * @returns {PickedFile|null}
 */
function pickFile(payload, keys, re, files, locate) {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v !== "string" || !v.trim()) continue;
    const base = baseOf(v);
    if (!re.test(base)) return { ref: v.trim(), base, rel: "", wrongKind: true };
    if (typeof locate === "function") {
      const hit = /** @type {Partial<AssetHit>} */ (locate(v.trim()) || {});
      const amb = Array.isArray(hit.ambiguous) && hit.ambiguous.length > 1 ? hit.ambiguous : null;
      return { ref: v.trim(), base, rel: amb ? "" : String(hit.rel || ""), wrongKind: false, ...(amb ? { ambiguous: amb } : {}) };
    }
    const rel = files && typeof files.get === "function" ? files.get(base) : null;
    return { ref: v.trim(), base, rel: rel || "", wrongKind: false };
  }
  return null;
}

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

/** @param {unknown} sec @returns {string} 00:00:01,500 这种 */
function srtTime(sec) {
  const ms = Math.max(0, Math.round(Number(sec) * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/**
 * 字幕。时间轴按**每段片子的真实时长**累加，不是按 payload 里写的「时长 4 秒」——
 * 那个 4 是下单时的期望值，生出来的视频是 4.2 还是 3.8 谁也说不准，
 * 拿它排字幕，到第十镜就能错出一秒多，整条字幕从此对不上嘴。
 * 所以探不到真实时长时这里返回空串，上层就不做字幕了，并且说明为什么。
 * @param {Array<Pick<ComposeRow, "seconds" | "line">>} rows
 * @returns {string}
 */
function buildSrt(rows) {
  const lines = [];
  let at = 0, n = 0;
  for (const r of rows) {
    const start = at;
    at += r.seconds;
    if (isBlank(r.line)) continue;
    n++;
    lines.push(String(n), `${srtTime(start)} --> ${srtTime(at)}`, String(r.line).trim(), "");
  }
  return n ? lines.join("\n") : "";
}

/**
 * 配乐从哪来。三条路，显式的压过猜的：
 *   ① 调用方直接给了路径（opts.musicFile）；
 *   ② 剪辑节点上写了 bgm / music 字段（Agent 排片的时候可以直接写）；
 *   ③ 画布上的「声音」节点里，用途/标签/名字带配乐字眼、又不带人声字眼的那一段。
 *
 * ⚠️ 已经被某一镜当配音用上的文件，一律不算配乐。
 * 那是台词：垫到整条片子底下，就是从头到尾有个人在念第三镜的那句话，
 * 而片子照样能播、时长也对、每一条断言都是绿的——只有人听得出来不对。
 *
 * 返回的是**全部**候选（包括有毛病的），让上层能说清楚「为什么这次没配乐」，
 * 而不是安静地少做一步。
 * @param {Array<Partial<CanvasNode>>} nodes
 * @param {ComposeOptions} opts
 * @param {Map<string, string>} files
 * @param {Set<string>} voiceBases 已经被某一镜当配音用上的文件名
 * @returns {MusicCandidate[]}
 */
function musicPick(nodes, opts, files, voiceBases) {
  /** @type {MusicCandidate[]} */
  const out = [];
  const locate = typeof opts.locate === "function" ? opts.locate : undefined;
  /** @param {PickedFile|null} f @param {unknown} title @param {string} from */
  const add = (f, title, from) => {
    if (!f) return;
    if (voiceBases.has(f.base)) return;                     // 这是某一镜的配音，不是配乐
    if (out.some((x) => x.base && x.base === f.base)) return;
    out.push({ ref: f.ref, base: f.base, rel: f.rel, wrongKind: !!f.wrongKind, title: String(title || f.base), from, ...(f.ambiguous ? { ambiguous: f.ambiguous } : {}) });
  };
  if (typeof opts.musicFile === "string" && opts.musicFile.trim()) {
    add(pickFile({ m: opts.musicFile }, ["m"], AUDIO_EXT, files, locate), "", "指定的");
  }
  for (const node of nodes.filter((n) => String((n && n.kind) || "") === "timeline")) {
    const p = payloadOf(node);
    add(pickFile(p, ["bgm", "music", "bgm_file"], AUDIO_EXT, files, locate), p.bgm_title, "剪辑节点");
  }
  for (const node of sortShots(nodes.filter((n) => String((n && n.kind) || "") === "audio"))) {
    const p = payloadOf(node);
    const text = [p.role, p.tags, p.title, p.text].map((x) => String(x || "")).join(" ");
    if (!MUSIC_HINT.test(text) || VOICE_HINT.test(text)) continue;
    const f = pickFile(p, ["url", "path", "file", "audio"], AUDIO_EXT, files, locate);
    if (f) add(f, p.title, "声音节点");
    else out.push({ ref: "", base: "", rel: "", wrongKind: false, empty: true, title: String(p.title || "配乐"), from: "声音节点" });
  }
  return out;
}

/**
 * 把配乐垫到整条片子底下。
 *
 * 三件容易写错、写错了又**听不出是哪一步错的**的事，都在这儿定死：
 *   ① amix 默认 normalize=1，会把每一路都除以 2 —— 不先把人声乘回 2，
 *      整条片子的台词会平白小一半，听起来只是「有点闷」；
 *   ② 两路的采样率/声道/采样格式对不上，sidechaincompress 会直接不干活（甚至报错），
 *      所以两路都先过一遍 aformat 归一化；
 *   ③ 音乐比片子短是常态（成品曲 60 秒，片子 3 分钟），所以短了就循环，
 *      再靠 amix 的 duration=first 在画面结束的地方收住。
 * 有 sidechaincompress 就做「一说话音乐自动压下去」，没有就按固定音量垫着——
 * 这台机器有没有，调用方开跑前就探好了传进来（跟 libass 是同一套规矩）。
 * @param {string} input 拼好、还没配乐的那一条
 * @param {{rel: string, dur: number}} music
 * @param {string} film 成片
 * @param {ComposeOptions} opts 只看 duck / limiter
 * @param {number} totalSeconds 成片总时长，探不到是 0
 * @returns {string[]}
 */
function musicArgv(input, music, film, opts, totalSeconds) {
  const loop = !music.dur || !totalSeconds || music.dur < totalSeconds - 0.5 ? ["-stream_loop", "-1"] : [];
  const fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
  // 淡入淡出要按片长缩：一条 4 秒的片子上来个 1.5 秒淡入 + 2.5 秒淡出，
  // 音乐从头到尾没到过正常音量，听着像忘了放
  const fin = totalSeconds ? Math.min(MUSIC_FADE_IN, round(totalSeconds * 0.25, 2)) : MUSIC_FADE_IN;
  const fout = totalSeconds ? Math.min(MUSIC_FADE_OUT, round(totalSeconds * 0.35, 2)) : 0;
  const fade = `afade=t=in:st=0:d=${fin}`
    + (fout > 0.2 ? `,afade=t=out:st=${round(totalSeconds - fout, 2)}:d=${fout}` : "");
  const gain = round(MUSIC_GAIN * 2, 3);
  const parts = [];
  if (opts.duck) {
    parts.push(`[0:a]${fmt},asplit=2[v0][key]`);
    parts.push(`[1:a]${fmt},volume=${gain},${fade}[bg]`);
    // sidechaincompress 压的是**主输入**（这里是音乐），按第二路（人声）的大小去压
    parts.push("[bg][key]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[bgd]");
    parts.push("[v0]volume=2[v2]");
    parts.push("[v2][bgd]amix=inputs=2:duration=first:dropout_transition=0[mx]");
  } else {
    parts.push(`[0:a]${fmt},volume=2[v2]`);
    parts.push(`[1:a]${fmt},volume=${gain},${fade}[bg]`);
    parts.push("[v2][bg]amix=inputs=2:duration=first:dropout_transition=0[mx]");
  }
  // 人声乘了 2，峰值顶到头的素材会削顶。有限幅器就挂一个（level=0 = 别自动把整条拉到 0dB，
  // 那会连没配乐的部分一起改音量）；没有就算了，宁可少一层保险也不要多一条会报错的滤镜
  parts.push(opts.limiter ? "[mx]alimiter=limit=0.95:level=0[a]" : "[mx]anull[a]");
  return ["-y", "-i", input, ...loop, "-i", music.rel, "-filter_complex", parts.join(";"),
    "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", ...AUDIO_ARGS, "-shortest", "-movflags", "+faststart", film];
}

/**
 * @param {CanvasStateLike} state 画布状态
 * @param {ComposeOptions} [opts]
 *   files    Map<basename, 工作区相对路径>  真在盘上的文件（缺这个就等于「盘上什么都没有」）
 *   locate   (ref)=>{rel, ambiguous?}      给了就不看 files：先按相对路径认，再按文件名全区搜，
 *                                          同名好几份的那一镜当卡点（drama-pipeline 的 assetLocator）
 *   onDisk   Set<basename>                 用来给成片挑一个不撞名的名字
 *   probes   {[相对路径 或 basename]: {dur,w,h,fps,vcodec,acodec}}  探到的规格；没探到就没这一项。
 *            先按相对路径查、再按文件名查：两集同名的镜头，时长不能串
 *   ffmpeg   string  ffmpeg 可执行路径，空 = 本机没有
 *   ffprobe  string
 *   install  string  没装时的装法（doctor.js 给）
 *   subtitles bool   要不要烧字幕（默认有台词就烧）
 *   burn     bool   本机 ffmpeg 有没有 subtitles 滤镜（libass）。false = 烧不了，
 *                   字幕文件照出，只是不进画面——这是「先探明白再开跑」，不是悄悄少做一步
 *   music    bool   要不要配乐（默认画布上找得到就配）
 *   musicFile string 直接指定配乐文件，压过画布上猜出来的那段
 *   duck     bool   本机 ffmpeg 有没有 sidechaincompress（说话时把音乐自动压低）
 *   limiter  bool   有没有 alimiter（混完之后限个幅，防削顶）
 *   dir      string  中间产物放哪个子目录，默认「成片素材」
 * @returns {ComposePlan}
 */
function composePlan(state, opts = {}) {
  const nodes = Array.isArray(state && state.nodes) ? state.nodes : [];
  const files = opts.files instanceof Map ? opts.files : new Map();
  const onDisk = opts.onDisk instanceof Set ? opts.onDisk : new Set(files.keys());
  const probes = opts.probes || {};
  const locate = typeof opts.locate === "function" ? opts.locate : undefined;
  /** @param {{rel?: string, base: string}|null} f @returns {MediaProbe|null} */
  const probeOf = (f) => (f ? (f.rel && probes[f.rel]) || probes[f.base] || null : null);
  const dir = String(opts.dir || "成片素材").replace(/[\\/]+$/, "");
  /** @type {Blocker[]} */
  const blockers = [];
  /** @param {Blocker["level"]} level @param {string} text @param {string[]} [ids] */
  const push = (level, text, ids) => blockers.push({ level, text, ids: ids || [] });

  const shots = sortShots(nodes.filter((n) => String((n && n.kind) || "") === "shot"));
  const timelines = nodes.filter((n) => String((n && n.kind) || "") === "timeline");

  if (!opts.ffmpeg) {
    push("stop", `本机没装 ffmpeg，拼不了片。装法：${opts.install || "brew install ffmpeg"}。装完回来点一下就行，前面生成好的镜头都还在。`, []);
  }
  if (!shots.length) {
    push("stop", "这张画布上一个镜头节点都没有，先把分镜展开成镜头再来合成。", []);
  }

  // ── 逐镜头体检：画面必须真在盘上；配音有就用，没有就补一段静音（不然 concat 会对不齐声轨）
  /** @type {ComposeRow[]} */
  const rows = [];
  const noVideo = [], lostVideo = [], wrongKind = [], noProbe = [], noVoice = [], twins = [];
  for (const node of shots) {
    const p = payloadOf(node);
    const id = String(p.id || p.title || node.id);
    const v = pickFile(p, ["video"], VIDEO_EXT, files, locate);
    const a = pickFile(p, ["audio", "voice_file"], AUDIO_EXT, files, locate);
    /** @type {ComposeRow} */
    const row = {
      id, nodeId: String(node.id), title: String(p.title || p.id || "镜头"),
      line: isBlank(p.line) ? "" : String(p.line).trim(),
      video: v ? v.rel : "", videoRef: v ? v.ref : "", audio: a ? a.rel : "", audioRef: a ? a.ref : "",
      seconds: 0, vdur: 0, adur: 0, pad: 0, why: "",
    };
    // 同名好几份：画面拼哪一集的、台词配谁的嗓子都是猜，这一镜整个当卡点，不替人挑
    const amb = [...((v && v.ambiguous) || []), ...((a && a.ambiguous) || [])];
    if (amb.length) { row.ambiguous = amb; twins.push(node.id); }
    if (!v) { row.why = "还没有视频"; noVideo.push(node.id); }
    else if (v.wrongKind) { row.why = `video 字段指的不是视频文件（${v.base}）`; wrongKind.push(node.id); }
    else if (v.ambiguous) row.why = `视频同名的有 ${v.ambiguous.length} 份（${v.base}），分不清用哪份`;
    else if (!v.rel) { row.why = `视频文件不在盘上了（${v.base}）`; lostVideo.push(node.id); }
    if (a && a.ambiguous) row.why = row.why || `配音同名的有 ${a.ambiguous.length} 份（${a.base}），分不清用哪份`;
    else if (a && !a.wrongKind && !a.rel) row.why = row.why || `配音文件不在盘上了（${a.base}）`;
    if (row.line && !row.audio && !(a && a.ambiguous)) noVoice.push(node.id);

    const pv = probeOf(v), pa = probeOf(a);
    row.vdur = pv && Number(pv.dur) > 0 ? round(pv.dur, 3) : 0;
    row.adur = pa && Number(pa.dur) > 0 ? round(pa.dur, 3) : 0;
    if (row.video && !row.vdur) noProbe.push(id);
    // 配音比画面长多少。以配音时长为准是 short-drama 的规矩：
    // 少的那截用最后一帧接住，而不是把话切掉
    row.pad = row.adur && row.vdur && row.adur > row.vdur + SLACK ? round(row.adur - row.vdur, 3) : 0;
    row.seconds = Math.max(row.vdur, row.pad ? row.adur : 0) || row.vdur;
    row.w = pv ? Number(pv.w) || 0 : 0; row.h = pv ? Number(pv.h) || 0 : 0;
    row.fps = pv ? Number(pv.fps) || 0 : 0; row.vcodec = pv ? String(pv.vcodec || "") : "";
    row.pix = pv ? String(pv.pix || "") : "";
    rows.push(row);
  }
  if (noVideo.length) push("stop", `${noVideo.length} 个镜头还没有视频，这几镜先生成出来再合成`, noVideo);
  if (lostVideo.length) push("stop", `${lostVideo.length} 个镜头的视频文件已经不在盘上了，拼不进去`, lostVideo);
  if (wrongKind.length) push("stop", `${wrongKind.length} 个镜头的 video 字段指的不是视频文件`, wrongKind);
  if (twins.length) push("stop", `${twins.length} 个镜头的素材有同名的好几份，分不清用哪份；把路径改成带目录的`, twins);
  if (noVoice.length) push("warn", `${noVoice.length} 个镜头有台词但没有配音，这几镜会是静音的`, noVoice);

  // ── 画幅一不一致：不一致就只能重新编码统一到一个尺寸，直拼出来的会是一条花屏
  const sized = rows.filter((r) => r.w && r.h);
  const sizes = [...new Set(sized.map((r) => `${r.w}x${r.h}`))];
  const codecs = [...new Set(rows.filter((r) => r.vcodec).map((r) => r.vcodec))];
  const rates = [...new Set(rows.filter((r) => r.fps).map((r) => r.fps))];
  const pixes = [...new Set(rows.filter((r) => r.pix).map((r) => r.pix))];
  const needPad = rows.some((r) => r.pad > 0);
  // 帧率不一致也必须重新编码。这条是实测出来的，不是防御性写法：
  // 30fps 和 25fps 各 2 秒的两段直拼，ffmpeg 退出码 0、文件也在、一路 Non-monotonic DTS 警告，
  // 出来的片子只有 3.33 秒——后面那段被时间戳吃掉了大半。
  // 也就是说这种错法能过我们所有的「文件在不在、有没有字节」的检查，只有用户能发现
  const mixed = sizes.length > 1 || codecs.length > 1 || rates.length > 1 || pixes.length > 1;
  const mode = mixed || needPad ? "reencode" : "copy";
  const target = sized.length
    ? { w: Math.max(...sized.map((r) => r.w)), h: Math.max(...sized.map((r) => r.h)) }
    : { ...FALLBACK_SIZE };
  // x264 要求偶数边长
  target.w += target.w % 2; target.h += target.h % 2;
  const fps = Math.min(60, Math.max(...rows.map((r) => r.fps || 0), FALLBACK_FPS));
  if (sizes.length > 1) push("warn", `这些镜头的画幅不一样（${sizes.join("、")}），会统一缩放到 ${target.w}×${target.h} 再拼，比直拼慢，画质也会掉一点`, []);
  if (rates.length > 1) push("warn", `这些镜头的帧率不一样（${rates.join("、")}fps），会统一到 ${fps}fps 重新编码——直接拼会把后面几段的时间戳拼坏，出来的片子会短一大截`, []);
  if (pixes.length > 1) push("warn", `这些镜头的像素格式不一样（${pixes.join("、")}），会统一重新编码，不然拼出来颜色会在中途跳一下`, []);
  if (needPad) push("warn", `${rows.filter((r) => r.pad > 0).length} 个镜头的配音比画面长，会把最后一帧接住补齐，而不是把台词切掉`, []);
  if (!sized.length && !opts.ffprobe) push("warn", "本机没有 ffprobe，探不到画幅和时长：先按直拼来，拼不上会自动改成重新编码", []);
  if (noProbe.length) push("warn", `${noProbe.length} 个镜头探不到时长（${noProbe.slice(0, 3).join("、")}${noProbe.length > 3 ? "…" : ""}），字幕的时间轴会对不上，所以这次不做字幕`, []);

  // 总时长在这儿算，不在最后算：配乐的淡出要按它来排
  const totalSeconds = rows.length && rows.every((r) => r.seconds > 0) ? round(rows.reduce((n, r) => n + r.seconds, 0), 1) : 0;

  // ── 配乐：整条片子底下垫一层音乐。没有它的短剧只是一串会说话的画面
  const voiceBases = new Set(rows.filter((r) => r.audio).map((r) => baseOf(r.audio)));
  const musicAll = musicPick(nodes, opts, files, voiceBases);
  const musicOk = musicAll.filter((m) => m.rel && !m.wrongKind);
  const musicBad = musicAll.filter((m) => !m.rel || m.wrongKind);
  const music = musicOk[0] ? { ...musicOk[0], dur: 0 } : null;
  if (music) { const pm = probeOf(music); music.dur = pm && Number(pm.dur) > 0 ? round(pm.dur, 3) : 0; }
  const musicOn = !!music && (opts.music == null ? true : !!opts.music);
  if (musicBad.length) {
    // 「标成了配乐但这次没用上」必须说出来。不说的话，用户看到的是一条没有音乐的片子，
    // 而画布上那个音乐节点好端端地摆着——他只会以为配乐这功能坏了
    const one = musicBad[0];
    push("warn", one.empty
      ? `画布上那段配乐（${one.title}）还没有文件，这次先不配乐`
      : one.wrongKind
        ? `标成配乐的那个文件不是音频（${one.base}），这次先不配乐`
        : one.ambiguous
          ? `配乐同名的有 ${one.ambiguous.length} 份（${one.base}），分不清用哪份，这次先不配乐`
          : `配乐文件不在盘上了（${one.base}），这次先不配乐`, []);
  }
  if (musicOn && musicOk.length > 1) {
    push("warn", `画布上有 ${musicOk.length} 段音乐，这次用的是「${music.title}」。想换就把别的那几段的用途改掉，或者在剪辑节点上写死 bgm`, []);
  }
  if (musicOn && music.dur && totalSeconds && music.dur < totalSeconds - 0.5) {
    push("warn", `配乐只有 ${music.dur} 秒、片子 ${totalSeconds} 秒，会循环垫到片尾`, []);
  }
  if (musicOn && !totalSeconds) {
    push("warn", "探不到成片总时长，配乐结尾就不做淡出了——音乐会跟着画面一起收，稍微有点硬", []);
  }
  if (musicOn && !opts.duck && rows.some((r) => r.audio)) {
    push("warn", "本机 ffmpeg 没有 sidechaincompress，配乐不会在说话的时候自动压低，只按固定音量垫在台词底下", []);
  }

  // ── 拼装步骤
  const hasLine = rows.some((r) => r.line);
  // 字幕文件和「把字幕烧进画面」是两件事，得分开。烧不了的机器上，
  // 一份对得上时间轴的 .srt 照样有用（导进剪映/达芬奇就是一行菜单），
  // 以前那种「烧不了就整条字幕都没了」等于把能给的也扣下了
  const canSrt = hasLine && rows.every((r) => r.seconds > 0);
  const wantSub = canSrt && (opts.subtitles == null ? true : !!opts.subtitles);
  const canBurn = wantSub && opts.burn !== false;
  if (wantSub && !canBurn) push("warn", "本机的 ffmpeg 没带 libass，烧不了字幕。字幕文件照样生成，可以直接导进剪辑软件；想烧进画面就换一个带 libass 的 ffmpeg", []);
  const film = freeName("成片", ".mp4", onDisk);
  const stem = film.replace(/\.mp4$/i, "");
  // 有配乐的时候，concat 先落到中间文件，**成片这个名字留给配好乐的那一版**。
  // 反过来做（先出成片、再出「成片_配乐.mp4」）就会给用户两条片子让他自己挑，
  // 而写回画布、进度带、「打开看看」认的都是成片那一条——等于配乐白做了
  const merged = musicOn ? `${dir}/拼接.mp4` : film;
  const outputs = {
    dir, list: `${dir}/list.txt`, clips: [], film, merged,
    music: musicOn ? music.rel : "",
    srt: wantSub ? freeName("字幕", ".srt", onDisk) : "",
    subtitled: canBurn ? `${stem}_带字幕.mp4` : "",
  };
  /** @type {ComposeStep[]} */
  const steps = [];
  rows.forEach((r, i) => {
    const clip = `${dir}/片段_${String(i + 1).padStart(2, "0")}_${safeName(r.id)}.mp4`;
    outputs.clips.push(clip);
    r.clip = clip;
    if (!r.video) return;
    const silent = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
    let argv;
    if (mode === "copy") {
      argv = r.audio
        ? ["-y", "-i", r.video, "-i", r.audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...AUDIO_ARGS, "-movflags", "+faststart", clip]
        : ["-y", "-i", r.video, ...silent, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...AUDIO_ARGS, "-shortest", "-movflags", "+faststart", clip];
    } else {
      const vf = `scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2:color=black`
        + (r.pad > 0 ? `,tpad=stop_mode=clone:stop_duration=${r.pad}` : "")
        + `,fps=${fps},format=yuv420p`;
      argv = r.audio
        ? ["-y", "-i", r.video, "-i", r.audio, "-filter_complex", `[0:v]${vf}[v]`, "-map", "[v]", "-map", "1:a:0", ...X264_ARGS, ...AUDIO_ARGS, "-movflags", "+faststart", clip]
        : ["-y", "-i", r.video, ...silent, "-filter_complex", `[0:v]${vf}[v]`, "-map", "[v]", "-map", "1:a:0", ...X264_ARGS, ...AUDIO_ARGS, "-shortest", "-movflags", "+faststart", clip];
    }
    steps.push({ key: `clip:${r.id}`, label: `第 ${i + 1} 镜 ${r.id}：画面接配音`, argv, out: clip });
  });
  if (rows.length && rows.every((r) => r.video)) {
    steps.push({
      key: "concat", label: `把 ${rows.length} 段接成一条`, out: merged,
      argv: ["-y", "-f", "concat", "-safe", "0", "-i", outputs.list, "-c", "copy", "-movflags", "+faststart", merged],
      // 直拼是「一帧都不重压」，最快也最保真。但源片规格只要有一点对不上就会拼不成，
      // 与其让用户对着一句 ffmpeg 的英文报错发愣，不如自动改成重新编码再拼一次，并说清楚换过路子
      fallback: ["-y", "-f", "concat", "-safe", "0", "-i", outputs.list, ...X264_ARGS, "-r", String(fps), ...AUDIO_ARGS, "-movflags", "+faststart", merged],
      fallbackWhy: "直接拼接没成（多半是各镜头的编码参数对不上），改成重新编码再拼一次",
    });
    if (musicOn) {
      steps.push({
        key: "music", label: `把配乐垫到整条片子底下（${music.title}）`, out: film,
        argv: musicArgv(merged, music, film, opts, totalSeconds),
        // 混音失败了也得把片子交出去：退路就是把拼好的那条原样搬成成片（只换壳，不重压）。
        // 没有这条退路的话，一个滤镜不认识就等于三十个镜头全白拼
        fallback: ["-y", "-i", merged, "-c", "copy", "-movflags", "+faststart", film],
        fallbackWhy: "配乐没混上（多半是本机 ffmpeg 少个滤镜），先把没配乐的成片交出来——片子本身一帧都不受影响",
      });
    }
    if (canBurn) {
      steps.push({
        key: "subtitle", label: "把字幕烧进画面", out: outputs.subtitled,
        argv: ["-y", "-i", film, "-vf", `subtitles=${outputs.srt}:force_style='FontSize=18,Alignment=2,MarginV=60'`, ...X264_ARGS, "-c:a", "copy", outputs.subtitled],
        optional: true,
        optionalWhy: "字幕没烧上（多半是本机 ffmpeg 没带 libass，或者找不到中文字体）。成片本身已经出来了，字幕文件也在，可以自己烧或者导进剪辑软件",
      });
    }
  }

  const srt = wantSub ? buildSrt(rows) : "";
  if (wantSub && !srt) outputs.srt = "";   // 台词全是占位文字：不写一个空字幕文件出来充数
  const stop = blockers.filter((b) => b.level === "stop");
  const ready = !stop.length && steps.length > 0;
  return {
    ready,
    // 有 stop 就一条命令都不交出去。交出去的那份里少了丢文件的那几镜，
    // 谁要是照着跑，出来的是一条「能播、时长也对、就是缺了两场戏」的片子——
    // 这种片子比拼不出来更坑：拼不出来至少有人会去看为什么
    mode, target, fps, blockers, shots: rows, steps: ready ? steps : [], outputs, srt,
    // music 是「找到了这段音乐」，musicOn 是「这次真的要用」。分成两个是为了界面上那个勾——
    // 用户手动关掉配乐之后，勾还得在，不然他没地方再打开
    music: music ? { base: music.base, rel: music.rel, title: music.title, dur: music.dur, from: music.from, duck: !!opts.duck } : null,
    musicOn,
    listText: rows.filter((r) => r.video).map((r) => `file '${baseOf(r.clip).replace(/'/g, "'\\''")}'`).join("\n") + "\n",
    totalSeconds,
    timelineIds: timelines.map((n) => String(n.id)),
    // 「大概多久」只在能算的时候给：重新编码按 1 秒片子 0.6 秒算（veryfast 的粗略经验值），
    // 直拼几乎不花时间。算不出总时长就什么都不说
    // 混音只动声音、画面是 copy，按 1 秒片子 0.05 秒算
    etaMs: totalSeconds ? Math.round(totalSeconds * (mode === "copy" ? 0.08 : 0.6) * 1000 + (canBurn ? totalSeconds * 600 : 0) + (musicOn ? totalSeconds * 50 : 0)) : 0,
  };
}

module.exports = { composePlan, _internals: { sortShots, orderKeyOf, buildSrt, srtTime, freeName, safeName, pickFile, musicPick, musicArgv, VIDEO_EXT, AUDIO_EXT, MUSIC_HINT, VOICE_HINT, MUSIC_GAIN } };
