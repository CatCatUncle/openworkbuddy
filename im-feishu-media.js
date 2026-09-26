// @ts-check
"use strict";
/**
 * 把工作目录里的一个文件作为附件发进飞书会话：图片、视频、语音、普通文件各走各的接口。
 *
 * 以前一律「按扩展名选 file_type 上传 → msg_type 固定发 file」。飞书规定上传类型和消息类型
 * 必须配对（230055：MP4 必须按 media 发），所以 mp4 / opus 其实是整条发不出去，不是「不能内联播」。
 * 现在：
 *   - mp4 ≤28MB：抽一帧当封面，按 media 发，聊天里点开就能播；
 *   - mp4 >28MB：在临时目录压一份短边 720、≤20MB 的预览发过去，再补一句原片在工作台哪个位置；
 *   - opus 按 audio 发；10MB 以上的图片 images 接口必拒，改按普通文件发；
 *   - 本机没 ffmpeg：≤28MB 的视频老实按普通文件发并说一句为什么，超限的直接说压不了。
 *
 * 飞书接口约定（2026-09 核对过文档，改之前先回去看原文）：
 *   上传文件  POST /open-apis/im/v1/files   multipart：file_type(opus|mp4|pdf|doc|xls|ppt|stream)、
 *            file_name、duration(毫秒，可选，仅音视频)、file；≤30MB，不收空文件（234006 太大 / 234010 空）
 *            https://open.feishu.cn/document/server-docs/im-v1/file/create
 *   上传图片  POST /open-apis/im/v1/images  multipart：image_type=message、image；≤10MB，≤12000×12000
 *            https://open.feishu.cn/document/server-docs/im-v1/image/create
 *   发消息    POST /open-apis/im/v1/messages?receive_id_type=chat_id，content 是 JSON 字符串
 *            https://open.feishu.cn/document/server-docs/im-v1/message/create
 *   消息体    media {file_key, image_key?}（image_key 是封面，不配置则无封面）/ audio {file_key}（opus）
 *            / file {file_key} / image {image_key}
 *            https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
 *   要紧的错误码：230055 上传类型与消息类型不配；230017 只能发机器人自己传的文件；230025 内容过长
 *
 * 至多发一次：消息发送不是幂等请求，超时不等于飞书没收到（同 im.js 的 sendOnce）。上传和发送
 * 超时/断网一律不重试，原样往上抛；只有发送明确返回 code≠0（飞书说了「没发」）才改按文件再发一次，
 * 跟类型无关的拒绝（NOT_TYPE_REJECT：不在群里、频控、token 失效……）不兜。传图被明确拒同理：
 * 什么都还没发出去，按文件发一次（分辨率超限 234039 文档自己也让改走文件接口）。
 *
 * 本模块不在顶层 require tools.js / which.js：im.js 已经 require 了 tools.js，顶层互相引用会成环。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
// media-probe 顶层只引 Node 自带的模块，不会成环
const { ROTATION_ENTRIES, displaySize } = require("./lib/media-probe");
// 报错进聊天前抹绝对路径：各渠道共用一份（im-media 顶层只引 Node 自带的模块，不会成环）
const { fsFail, scrubPaths } = require("./im-media");

const API = "https://open.feishu.cn/open-apis";

/**
 * 上限。FILE_MAX 比飞书的 30MB 留 2MB 余量（multipart 头、MiB/MB 口径差），跟老代码一致。
 * IMAGE_MAX 按十进制的 10MB 算：文档只写「不能超过 10 MB」，没说是哪种 MB，贴着边的图直接按文件发
 */
const LIMITS = Object.freeze({
  FILE_MAX: 28 * 2 ** 20,
  IMAGE_MAX: 10_000_000,
  PREVIEW_TARGET: 19.5 * 2 ** 20,
  SHORT_SIDE: 720,
  // 720p 低于这个码率就糊得看不清了：宁可只发一句「原片在工作台」，也不发一段马赛克
  MIN_VKBPS: 350,
});

/**
 * 发送被拒、但跟消息类型无关的码：机器人不在群里、没开机器人能力、用户不在可用范围、群设置不允许、
 * 频控、没权限、被用户屏蔽、token 失效、缺 scope。换 stream 重传一遍照样被拒，只白传最多 28MB。
 * 码和含义对照飞书文档（2026-09 核对）：
 *   https://open.feishu.cn/document/server-docs/im-v1/message/create 的错误码表
 *   https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
 * 不在这里的明确拒绝（230055、230017、不认识的编码……）照旧改按文件发一次。
 */
const NOT_TYPE_REJECT = new Set([
  230002, 230006, 230013, 230018, 230020, 230027, 230035, 230053,
  99991400, 99991401, 99991661, 99991663, 99991664, 99991668, 99991671, 99991672,
]);

const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const DOC_TYPE = /** @type {Record<string, string>} */ ({ pdf: "pdf", doc: "doc", docx: "doc", xls: "xls", xlsx: "xls", ppt: "ppt", pptx: "ppt" });

/**
 * @typedef {{ dur: number, w: number, h: number, vcodec: string, hasAudio: boolean, vindex?: number }} Probe
 * @typedef {{ route: "image"|"media"|"media-preview"|"audio"|"file", fileType?: string, msgType: "image"|"media"|"audio"|"file" }} Plan
 * @typedef {{ FILE_MAX: number, IMAGE_MAX: number, PREVIEW_TARGET: number, SHORT_SIDE: number, MIN_VKBPS: number }} Limits
 * @typedef {{
 *   resolve: (name: "ffmpeg"|"ffprobe") => Promise<string>,
 *   run: (bin: string, argv: string[], o: { timeoutMs: number, signal?: AbortSignal }) => Promise<{ stdout?: string, stderr?: string } | void>,
 *   install?: () => Promise<string>,
 * }} Bins
 * @typedef {{ code: number, msg?: string, data?: any }} FeishuResp
 */

// ───────────────────────── 纯计算（测试直接比） ─────────────────────────

const extOf = (/** @type {string} */ name) => (String(name).split("/").pop() || "").split(".").pop()?.toLowerCase() || "";

/**
 * 这个文件该走哪条路。发不了的（非 mp4 且超 28MB）直接抛一句中文，不白传一趟。
 * @param {{ name: string, size: number, probe?: Probe | null }} o
 * @param {Limits} [limits]
 * @returns {Plan}
 */
function planSend({ name, size, probe }, limits = LIMITS) {
  const ext = extOf(name);
  const tooBig = size > limits.FILE_MAX;
  if (ext === "mp4") {
    if (!tooBig) return { route: "media", fileType: "mp4", msgType: "media" };
    // 量出来里面根本没有画面（纯音轨 mp4）：没有「720p 预览」可言
    if (probe && !probe.w) throw new Error("超过飞书 30MB 上限，这个 mp4 里没有画面，压不了预览，原文件在工作台");
    return { route: "media-preview", fileType: "mp4", msgType: "media" };
  }
  if (tooBig) throw new Error("超过飞书 30MB 上限，发不了，原文件在工作台");
  if (IMG_EXT.has(ext)) {
    // images 接口上限 10MB：10–28MB 的图以前照样往 images 传，必然被拒；按普通文件发还能到
    return size <= limits.IMAGE_MAX ? { route: "image", msgType: "image" } : { route: "file", fileType: "stream", msgType: "file" };
  }
  if (ext === "opus") return { route: "audio", fileType: "opus", msgType: "audio" };
  // mov/webm/mp3 等飞书不认的格式按 stream 走普通文件：转码成 mp4/opus 再内联是另一件事
  return { route: "file", fileType: DOC_TYPE[ext] || "stream", msgType: "file" };
}

const even = (/** @type {number} */ x) => Math.max(2, Math.round(x / 2) * 2);
const evenDown = (/** @type {number} */ x) => Math.max(2, Math.floor(x / 2) * 2);

/**
 * 预览尺寸：短边压到 720，两边都是偶数（libx264 + yuv420p 奇数边直接报错），绝不放大。
 * 竖屏 1080×1920 → 720×1280。
 * @param {number} w @param {number} h @param {number} [short]
 */
function previewDims(w, h, short = LIMITS.SHORT_SIDE) {
  const s = Math.min(w, h);
  if (!(s > short)) return { w: evenDown(w), h: evenDown(h) };
  const f = short / s;
  return w <= h ? { w: even(short), h: even(h * f) } : { w: even(w * f), h: even(short) };
}

/**
 * 预览的视频码率：总预算 × 0.93（容器开销）减掉音轨。低于 MIN_VKBPS 判「太长」，不发预览。
 * @param {number} durSec @param {number} [targetBytes] @param {number} [audioKbps]
 * @param {number} [minVkbps]
 */
function previewBitrate(durSec, targetBytes = LIMITS.PREVIEW_TARGET, audioKbps = 96, minVkbps = LIMITS.MIN_VKBPS) {
  const d = Number(durSec);
  if (!(d > 0)) return { vKbps: 0, ok: false };
  const vKbps = Math.floor((targetBytes * 8 / 1000 / d) * 0.93 - audioKbps);
  return { vKbps: Math.max(0, vKbps), ok: vKbps >= minVkbps };
}

/** 封面尺寸：长边不超过 1280、偶数、不放大 */
function coverDims(/** @type {number} */ w, /** @type {number} */ h) {
  const f = Math.min(1, 1280 / Math.max(w, h));
  return f < 1 ? { w: even(w * f), h: even(h * f) } : { w: evenDown(w), h: evenDown(h) };
}

/**
 * 抽封面：取 10% 处（最多第 3 秒）——第 0 帧常是黑场。-ss 放在 -i 前是按关键帧快速定位。
 * @param {{ src: string, out: string, dur?: number, w?: number, h?: number }} o
 */
function coverArgv({ src, out, dur, w, h }) {
  const ss = dur > 0 ? Math.min(dur * 0.1, 3) : 0;
  const d = w > 0 && h > 0 ? coverDims(w, h) : null;
  return [
    "-nostdin", "-v", "error", "-y", "-ss", String(Math.round(ss * 1000) / 1000), "-i", src,
    "-frames:v", "1", ...(d ? ["-vf", `scale=${d.w}:${d.h}`] : []), "-q:v", "3", out,
  ];
}

/**
 * 压 720p 预览。编码参数照 drama-compose.js 的 X264 约定，但用 -b:v/-maxrate 代替 -crf：
 * crf 管画质不管体积，这里要的是「一定塞得进 30MB」。+faststart 让飞书边下边播。
 * 画面按 parseProbe 挑中的那一路取（vindex）；没量到就用 0:V:0——大写 V 跳过附图封面，
 * 小写 v 会拿到排在前面的封面，带着附图标记编码直接失败。
 * @param {{ src: string, out: string, dims: { w: number, h: number }, vKbps: number, hasAudio: boolean, vindex?: number }} o
 */
function previewArgv({ src, out, dims, vKbps, hasAudio, vindex }) {
  const k = Math.max(1, Math.floor(vKbps));
  const vmap = Number.isInteger(vindex) && vindex >= 0 ? `0:${vindex}` : "0:V:0";
  return [
    "-nostdin", "-v", "error", "-y", "-i", src,
    "-map", vmap, ...(hasAudio ? ["-map", "0:a:0?"] : []),
    "-vf", `scale=${dims.w}:${dims.h}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-b:v", `${k}k`, "-maxrate", `${Math.floor(k * 1.2)}k`, "-bufsize", `${k * 2}k`,
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "96k", "-ac", "2"] : ["-an"]),
    "-movflags", "+faststart", out,
  ];
}

/** 量视频：compose-jobs 里那个不报音轨也没导出，这里自己问一次 ffprobe。连朝向一起问，竖拍才不会压扁 */
const probeArgv = (/** @type {string} */ src) => [
  "-v", "error", "-show_entries", `stream=index,codec_type,codec_name,width,height:${ROTATION_ENTRIES}:format=duration`, "-of", "json", src,
];

/**
 * @param {string} text
 * @returns {Probe | null}
 */
function parseProbe(text) {
  let j;
  try { j = JSON.parse(String(text || "")); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const streams = Array.isArray(j.streams) ? j.streams : [];
  // mp4 里偶尔夹一张 mjpeg/png 的「附图」，别把它当成画面
  const vids = streams.filter((/** @type {any} */ s) => s && s.codec_type === "video");
  const v = vids.find((/** @type {any} */ s) => !/^(mjpeg|png)$/.test(String(s.codec_name))) || vids[0];
  const dur = Number(j.format && j.format.duration) || 0;
  if (!v && !dur) return null;
  // 手机竖拍常存成 1920×1080 + 转 90°，ffmpeg 解码时先转正：宽高要报转过之后的
  const d = v ? displaySize(v) : { w: 0, h: 0 };
  const vindex = v ? Number(v.index) : NaN;
  return {
    dur,
    w: d.w,
    h: d.h,
    vcodec: (v && String(v.codec_name || "")) || "",
    hasAudio: streams.some((/** @type {any} */ s) => s && s.codec_type === "audio"),
    ...(Number.isInteger(vindex) && vindex >= 0 ? { vindex } : {}),
  };
}

// 发进聊天的说明只写工作区里的相对路径：绝对路径会把 /Users/<名字> 发到群里
/** @param {string} rel @param {number} origMB */
const notePreview = (rel, origMB) => `原片 ${origMB}MB 超过飞书 30MB 上限，先发了 720p 预览。原片在工作台：${rel}`;
/** @param {string} rel */
const noteTooLong = (rel) => `视频太长，压到 20MB 会糊得看不清，就没发预览。原片在工作台：${rel}`;
/** @param {string} [install] */
const noteNoFfmpeg = (install) => `超过飞书 30MB 上限，本机没装 ffmpeg 压不出预览版${install ? `（${install}）` : ""}`;
/** @param {string} [install] */
const noteNoFfmpegFile = (install) => `本机没装 ffmpeg，视频按普通文件发了，下载后才能看；装上就能在聊天里直接播${install ? `（${install}）` : ""}`;

// ───────────────────────── 跑二进制 ─────────────────────────

/**
 * 生产用的 ffmpeg / ffprobe：位置取 lib/media-probe 的 resolveMediaBins()，跑用它的 runBin
 * （补全过的 PATH，超时即杀子进程）。都在函数里才 require，理由见文件头。
 * @returns {Bins}
 */
function defaultFeishuBins() {
  const mp = () => require("./lib/media-probe");
  return {
    resolve: async (name) => ((await mp().resolveMediaBins())[name] || { bin: "" }).bin || "",
    install: async () => (await mp().resolveMediaBins()).install || "",
    // signal：用户回了「停」，runBin 会把正在压的 ffmpeg 杀掉
    run: (bin, argv, { timeoutMs, signal }) => mp().runBin(bin, argv, { timeout: timeoutMs, what: path.basename(bin) || "ffmpeg", signal }),
  };
}

/** 用户回了「停」：还没发出去的就别发了（已经在路上的消息不拦，飞书可能已经收到） */
function halt(/** @type {AbortSignal | undefined} */ signal) {
  if (!signal || !signal.aborted) return;
  const e = new Error("已叫停，没发");
  e.name = "AbortError";
  throw e;
}

/**
 * 上传超时和用户的「停」合成一路。engines 写的 node >=18，AbortSignal.any 要 20.3（18.17）才有：
 * 没有就手接，done() 在上传收尾时摘掉监听
 * @param {number} ms @param {AbortSignal} [stop]
 * @returns {{ signal: AbortSignal, done: () => void }}
 */
function uploadSignal(ms, stop) {
  const timeout = AbortSignal.timeout(ms);
  if (!stop) return { signal: timeout, done: () => {} };
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any([timeout, stop]), done: () => {} };
  const ctl = new AbortController();
  /** @type {Array<() => void>} */
  const offs = [];
  const done = () => { while (offs.length) /** @type {() => void} */ (offs.pop())(); };
  const hit = [stop, timeout].find((s) => s.aborted);
  if (hit) ctl.abort(hit.reason);
  else for (const s of [timeout, stop]) {
    const on = () => { done(); ctl.abort(s.reason); };
    s.addEventListener("abort", on, { once: true });
    offs.push(() => s.removeEventListener("abort", on));
  }
  return { signal: ctl.signal, done };
}

// fs 报错换成不带路径的话（fsFail）搬去了 im-media.js：企微 / 公众号 / 微信发附件也要同一份
// 同一台机器同时只压一个视频：几个 IM 会话一起收尾时，别让 ffmpeg 把所有核都占满
let encodeChain = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialized(fn) {
  const p = encodeChain.then(fn, fn);
  encodeChain = p.then(() => undefined, () => undefined);
  return p;
}

// ───────────────────────── 发送 ─────────────────────────

/**
 * @param {{
 *   getToken: () => Promise<string>,
 *   fetchImpl?: (url: string, init?: any) => Promise<any>,
 *   postMessage: (token: string, chatId: string, msgType: string, content: any) => Promise<FeishuResp>,
 *   notify: (chatId: string, text: string) => Promise<any>,
 *   log?: (level: string, msg: string) => void,
 *   workspaceDir: () => string,
 *   tmpRoot?: string,
 *   bins: Bins,
 *   serialize?: boolean,
 *   limits?: Partial<Limits>,
 * }} deps
 */
function createFeishuMediaSender(deps) {
  const {
    getToken, postMessage, notify, workspaceDir, bins,
    tmpRoot = os.tmpdir(), serialize = true,
  } = deps;
  // 默认在调用那一刻再取全局 fetch：测试换掉 global.fetch 也能接住
  const fetchImpl = deps.fetchImpl || ((/** @type {string} */ u, /** @type {any} */ i) => fetch(u, i));
  const log = deps.log || (() => {});
  /** @type {Limits} */
  const limits = { ...LIMITS, ...(deps.limits || {}) };
  /** 同一个会话十分钟内只提醒一次「没装 ffmpeg」，一次发三段视频别刷三遍 */
  const noFfNoted = new Map();

  const binOf = async (/** @type {"ffmpeg"|"ffprobe"} */ name) => {
    try { return (await bins.resolve(name)) || ""; } catch { return ""; }
  };
  const installHint = async () => {
    try { return bins.install ? (await bins.install()) || "" : ""; } catch { return ""; }
  };

  /** 报错里可能带 ffmpeg 的 stderr：把绝对路径抹掉再往聊天里送 */
  const scrub = (/** @type {string} */ s, /** @type {string[]} */ dirs) => scrubPaths(s || "", dirs).slice(0, 200);

  /**
   * 上传只是把文件交给飞书、聊天里什么都不出现：叫停时在途的上传也可以直接掐掉
   * @param {string} url @param {FormData} fd @param {number} ms @param {AbortSignal} [stop]
   */
  async function upload(url, token, fd, ms, stop) {
    halt(stop);
    const sig = uploadSignal(ms, stop);
    try {
      const resp = await fetchImpl(url, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd, signal: sig.signal,
      });
      return /** @type {FeishuResp} */ (await resp.json());
    } finally { sig.done(); }
  }

  /** @param {string} token @param {string} abs @param {string} name @param {AbortSignal} [stop] */
  async function uploadImage(token, abs, name, stop) {
    const fd = new FormData();
    fd.append("image_type", "message");
    fd.append("image", new Blob([/** @type {any} */ (fs.readFileSync(abs))]), name);
    const r = await upload(`${API}/im/v1/images`, token, fd, 60000, stop);
    if (r.code !== 0) {
      const e = /** @type {Error & { feishuCode?: number }} */ (new Error(`传图失败 code ${r.code}: ${r.msg}`));
      e.feishuCode = r.code;
      throw e;
    }
    return String(r.data.image_key);
  }

  /** @param {string} token @param {{ abs: string, name: string, fileType: string, durationMs?: number, stop?: AbortSignal }} o */
  async function uploadFile(token, { abs, name, fileType, durationMs, stop }) {
    const fd = new FormData();
    fd.append("file_type", fileType);
    fd.append("file_name", name);
    if (durationMs > 0) fd.append("duration", String(Math.round(durationMs)));
    fd.append("file", new Blob([/** @type {any} */ (fs.readFileSync(abs))]), name);
    const r = await upload(`${API}/im/v1/files`, token, fd, 120000, stop);
    if (r.code !== 0) throw new Error(`传文件失败 code ${r.code}: ${r.msg}`);
    return String(r.data.file_key);
  }

  /**
   * 发消息前最后看一眼「停」；发出去之后就不拦了（在途的不掐：超时不等于飞书没收到）
   * @param {string} token @param {string} chatId @param {string} msgType @param {any} content @param {AbortSignal} [stop]
   */
  async function send(token, chatId, msgType, content, stop) {
    halt(stop);
    const r = await postMessage(token, chatId, msgType, content);
    if (!r || r.code !== 0) {
      const e = /** @type {Error & { feishuCode?: number }} */ (new Error(`发送失败 code ${r && r.code}: ${r && r.msg}`));
      e.feishuCode = r ? r.code : -1;
      throw e;
    }
    return r;
  }

  /**
   * 发 media / audio：飞书明确回了 code≠0（没发出去）才改按文件发一次；超时、断网原样抛，
   * 因为那时飞书可能已经发了，再补一条用户就收到两份。
   * @param {string} token @param {string} chatId
   * @param {{ abs: string, name: string, fileType: string, msgType: string, durationMs?: number, imageKey?: string, stop?: AbortSignal }} o
   */
  async function sendTyped(token, chatId, o) {
    const fileKey = await uploadFile(token, { abs: o.abs, name: o.name, fileType: o.fileType, durationMs: o.durationMs, stop: o.stop });
    const content = o.imageKey ? { file_key: fileKey, image_key: o.imageKey } : { file_key: fileKey };
    try {
      await send(token, chatId, o.msgType, content, o.stop);
      return false;
    } catch (e) {
      const code = /** @type {any} */ (e).feishuCode;
      // 跟类型无关的拒绝（不在群里、没权限、频控、token 失效……）换 stream 也一样被拒，不白传一遍
      if (!(typeof code === "number" && code > 0) || NOT_TYPE_REJECT.has(code)) throw e;
      log("sys", `${o.msgType} 被拒 code ${code}，改按文件发：${o.name}`);
      // 230017 只能发机器人自己传的文件：这里换 stream 重新传一份，拿新的 file_key
      const k2 = await uploadFile(token, { abs: o.abs, name: o.name, fileType: "stream", stop: o.stop });
      await send(token, chatId, "file", { file_key: k2 }, o.stop);
      return true;
    }
  }

  /** @param {string} bin @param {string} abs @param {AbortSignal} [stop] @returns {Promise<Probe | null>} */
  async function probe(bin, abs, stop) {
    if (!bin) return null;
    try {
      const r = await bins.run(bin, probeArgv(abs), { timeoutMs: 30000, signal: stop });
      return parseProbe((r && r.stdout) || "");
    } catch (e) {
      if (!(stop && stop.aborted)) log("error", `量视频失败（照常发送）：${scrub(e && e.message, [workspaceDir()])}`);
      return null;
    }
  }

  /** 抽封面并传图；失败只丢封面，不挡视频本身（叫停除外） */
  async function coverKey(/** @type {string} */ ffmpeg, token, /** @type {string} */ src, /** @type {Probe | null} */ p, /** @type {string} */ tmp, /** @type {AbortSignal | undefined} */ stop) {
    const out = path.join(tmp, "cover.jpg");
    try {
      await bins.run(ffmpeg, coverArgv({ src, out, dur: p ? p.dur : 0, w: p ? p.w : 0, h: p ? p.h : 0 }), { timeoutMs: 60000, signal: stop });
      const st = fs.statSync(out);
      if (!st.size || st.size > limits.IMAGE_MAX) throw new Error(`封面大小不对（${st.size} 字节）`);
      return await uploadImage(token, out, "cover.jpg", stop);
    } catch (e) {
      halt(stop);
      log("error", `视频封面没做成，照常发送（没有封面）：${scrub(e && e.message, [tmp, workspaceDir()])}`);
      return "";
    }
  }

  /**
   * @param {string} chatId
   * @param {string} rel 工作目录里的相对路径
   * @param {{ signal?: AbortSignal }} [o] signal：用户回了「停」，还没发的就不发了
   * @returns {Promise<{ route: string, sent: boolean, note?: string, fellBack?: boolean }>}
   */
  async function sendFile(chatId, rel, o = {}) {
    const abs = path.resolve(workspaceDir(), rel);
    try {
      return await sendFileInner(chatId, rel, o.signal);
    } catch (e) {
      throw fsFail(e, abs);
    }
  }

  /** @param {string} chatId @param {string} rel @param {AbortSignal} [stop] */
  async function sendFileInner(chatId, rel, stop) {
    const root = path.resolve(workspaceDir());
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw new Error("这个文件不在工作目录里，不发");
    halt(stop);
    // 先 stat 再决定：几个 G 的视频不能先整个读进内存再发现发不了
    const size = fs.statSync(abs).size;
    if (!size) throw new Error("空文件，飞书不收");
    const name = rel.split("/").pop() || rel;
    const ext = extOf(name);

    let p = null;
    if (ext === "mp4" || ext === "opus") p = await probe(await binOf("ffprobe"), abs, stop);
    halt(stop);
    const plan = planSend({ name, size, probe: p }, limits);
    const durationMs = p && p.dur > 0 ? Math.round(p.dur * 1000) : 0;

    if (plan.route === "image") {
      const token = await getToken();
      let key;
      try {
        key = await uploadImage(token, abs, name, stop);
      } catch (e) {
        // 传图被明确拒了（超 10MB、分辨率超限 234039……）= 什么都没发出去，按普通文件发一次；
        // 超时、断网、跟类型无关的拒绝原样抛
        const code = /** @type {any} */ (e).feishuCode;
        if (!(typeof code === "number" && code > 0) || NOT_TYPE_REJECT.has(code)) throw e;
        log("sys", `图片被拒 code ${code}，改按文件发：${name}`);
        const k2 = await uploadFile(token, { abs, name, fileType: "stream", stop });
        await send(token, chatId, "file", { file_key: k2 }, stop);
        return { route: "file", sent: true, fellBack: true };
      }
      await send(token, chatId, "image", { image_key: key }, stop);
      return { route: "image", sent: true };
    }
    if (plan.route === "file") {
      const token = await getToken();
      const key = await uploadFile(token, { abs, name, fileType: plan.fileType || "stream", stop });
      await send(token, chatId, "file", { file_key: key }, stop);
      return { route: "file", sent: true };
    }
    if (plan.route === "audio") {
      const token = await getToken();
      const fellBack = await sendTyped(token, chatId, { abs, name, fileType: "opus", msgType: "audio", durationMs, stop });
      return { route: "audio", sent: true, fellBack };
    }

    // ── 视频 ──
    const ffmpeg = await binOf("ffmpeg");
    if (!ffmpeg) {
      const install = await installHint();
      if (plan.route === "media-preview") throw new Error(noteNoFfmpeg(install));
      // 没 ffmpeg 就没有封面，多半也量不出时长：聊天里只剩一块没画面、不知多长的黑框。
      // 老实按普通文件发（stream + file 配对，不撞 230055），再说一句怎么补上
      const token = await getToken();
      const key = await uploadFile(token, { abs, name, fileType: "stream", stop });
      await send(token, chatId, "file", { file_key: key }, stop);
      const note = noteNoFfmpegFile(install);
      const last = noFfNoted.get(chatId) || 0;
      if (Date.now() - last > 10 * 60 * 1000) {
        noFfNoted.set(chatId, Date.now());
        // 文件已经发出去了：提醒没发成只记日志，不能往上抛（那样 im.js 会跟用户说「没发出去」）
        try { await notify(chatId, note); } catch (e) { log("error", `「没装 ffmpeg」提醒没发出去：${e && e.message}`); }
      }
      return { route: "file", sent: true, note };
    }

    // 临时目录放系统 tmp，绝不放工作区：工作区里的新文件会被当成成果再发一遍
    const tmp = fs.mkdtempSync(path.join(tmpRoot, "owb-feishu-"));
    try {
      if (plan.route === "media") {
        const token = await getToken();
        const imageKey = await coverKey(ffmpeg, token, abs, p, tmp, stop);
        const fellBack = await sendTyped(token, chatId, { abs, name, fileType: "mp4", msgType: "media", durationMs, imageKey, stop });
        return { route: "media", sent: true, fellBack };
      }

      // media-preview：超 28MB，压一份 720p 预览
      if (!p || !(p.dur > 0) || !p.w || !p.h) throw new Error("超过飞书 30MB 上限，量不出这个视频的时长和尺寸，压不了预览，原文件在工作台");
      const dims = previewDims(p.w, p.h, limits.SHORT_SIDE);
      const audioK = p.hasAudio ? 96 : 0;
      let br = previewBitrate(p.dur, limits.PREVIEW_TARGET, audioK, limits.MIN_VKBPS);
      const tooLong = async () => {
        halt(stop);
        const note = noteTooLong(rel);
        // 说明没发出去照样往上抛（文件确实没发），但抛的是「为什么没发」这句，不是网络报错：
        // im.js 会把它放进「没发出去（…）」里告诉用户
        try { await notify(chatId, note); } catch (e) {
          log("error", `「太长没发」的说明没发出去：${scrub(e && e.message, [tmp, root])}`);
          throw new Error(note);
        }
        return { route: "media-preview", sent: false, note };
      };
      // 太长：不发糊成一片的预览，也不悄悄只截前几分钟（截哪段是用户该拍板的事）
      if (!br.ok) return await tooLong();
      const out = path.join(tmp, "preview.mp4");
      const timeoutMs = Math.max(120000, Math.round(p.dur * 3000));
      const encode = (/** @type {number} */ vKbps) => {
        // 排在别的会话后面等的时候被叫停：轮到了也不开压
        const job = async () => {
          halt(stop);
          return bins.run(ffmpeg, previewArgv({ src: abs, out, dims, vKbps, hasAudio: p.hasAudio, vindex: p.vindex }), { timeoutMs, signal: stop });
        };
        return (serialize ? serialized(job) : job()).catch((e) => {
          halt(stop);
          throw new Error(`压 720p 预览失败：${scrub(e && e.message, [tmp, root])}`);
        });
      };
      await encode(br.vKbps);
      // 码率控制不是硬上限：超了就本地再压一遍（0.75 倍码率）。这是本机编码，不是上游付费调用
      if (fs.statSync(out).size > limits.FILE_MAX) {
        br = { vKbps: Math.floor(br.vKbps * 0.75), ok: true };
        log("sys", `预览压出来还是超 28MB，降到 ${br.vKbps}k 再压一次：${name}`);
        await encode(br.vKbps);
        if (fs.statSync(out).size > limits.FILE_MAX) return await tooLong();
      }
      const token = await getToken();
      const imageKey = await coverKey(ffmpeg, token, out, { ...p, w: dims.w, h: dims.h }, tmp, stop);
      // 文件名沿用原片：聊天里看到的还是用户认得的那个名字，下面那句说明讲清楚这是预览
      const fellBack = await sendTyped(token, chatId, { abs: out, name, fileType: "mp4", msgType: "media", durationMs, imageKey, stop });
      const note = notePreview(rel, Math.round(size / 2 ** 20));
      // 预览已经发出去了才补这句；补失败只记日志，不能让上层以为视频没发成
      try { await notify(chatId, note); } catch (e) { log("error", `预览说明没发出去：${e && e.message}`); }
      return { route: "media-preview", sent: true, note, fellBack };
    } finally {
      // 删不掉（Windows 上杀软/没退干净的 ffmpeg 还占着）只记日志：finally 里抛出来会顶掉上面的返回值，
      // 视频明明发出去了，im.js 却跟用户说「没发出去」
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {
        log("error", `临时目录没删掉（不影响发送）：${scrub(e && e.message, [tmp, tmpRoot])}`);
      }
    }
  }

  return { sendFile };
}

module.exports = {
  LIMITS,
  planSend, previewDims, previewBitrate, coverArgv, previewArgv, probeArgv, parseProbe,
  notePreview, noteTooLong, noteNoFfmpeg, noteNoFfmpegFile,
  defaultFeishuBins, createFeishuMediaSender,
};
