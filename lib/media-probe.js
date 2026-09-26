// @ts-check
"use strict";
/**
 * 找 ffmpeg / ffprobe、量音频时长、把一句句配音拼成整条音轨，外加视频播放时的朝向（转 90° 的竖拍按转过之后的宽高算）。
 * 按句配音、录屏配音、演示视频、飞书封面都要用 ffmpeg，这里是它们共用的那一份。
 *
 * 时长一律按 PCM 采样数算，不读 mp3 容器里写的时长：mp3 有编码延迟和尾部补齐，
 * 每段差 25–50ms，一句句累加到第 4–6 句就超过字幕能容忍的 150ms 了。所以先把每段
 * 解成同一采样率的 16 位单声道 WAV，数采样；整条音轨也用这同一份 PCM 按采样拼，
 * 字幕时间轴和声音用的是同一套数，就不可能对不上。
 *
 * 找二进制照 engines/which.js 的规矩：PATH → 常见安装位置 → 登录 shell。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

/** @typedef {{ bin: string, how: string, why: string }} BinHit */
/** @typedef {{ ffmpeg: BinHit, ffprobe: BinHit, install: string }} MediaBins */
/**
 * @typedef {{
 *   formatTag: number, pcm: boolean, channels: number, sampleRate: number, bitsPerSample: number,
 *   blockAlign: number, dataOffset: number, dataBytes: number, samples: number, ms: number,
 * }} WavInfo
 */
/** @typedef {{ samples: number, sampleRate: number, ms: number, codec: string, channels: number, exact: boolean }} AudioProbe */

/** @type {Promise<MediaBins> | null} */
let binsP = null;

/**
 * ffmpeg / ffprobe 各在哪，外加一句当前系统的装法（给报错用）。
 * 找到了就记住，整个进程只找一次；并发来的几个调用共用同一趟。
 * 没找全的结果不记：用户照报错装好 ffmpeg、在设置页点「重新检测」（会清 which.js 的缓存）之后，
 * 下一次就该找得到，不必重启整个应用。
 * @returns {Promise<MediaBins>}
 */
function resolveMediaBins() {
  if (binsP) return binsP;
  const p = findBins();
  binsP = p;
  p.then((b) => { if ((!b.ffmpeg.bin || !b.ffprobe.bin) && binsP === p) binsP = null; }, () => { if (binsP === p) binsP = null; });
  return p;
}

/** @returns {Promise<MediaBins>} */
async function findBins() {
  const which = require("../engines/which");
  /** @param {string} name @returns {Promise<BinHit>} */
  const one = async (name) => {
    try {
      const r = await which.resolveBin(name, "");
      return { bin: r.bin || "", how: r.how || "", why: r.why || "" };
    } catch (e) {
      return { bin: "", how: "", why: `找 ${name} 时出错：${e && e.message || e}` };
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([one("ffmpeg"), one("ffprobe")]);
  let install = "";
  // ffprobe 和 ffmpeg 是同一个包，装法只查 ffmpeg 那一条
  try { install = (require("../doctor").knownTool("ffmpeg") || {}).install || ""; } catch {}
  return { ffmpeg, ffprobe, install };
}

/** 测试用：把本模块和 which.js 记住的位置都清掉，下一次重新找。 */
function reset() {
  binsP = null;
  try { require("../engines/which").forget(); } catch {}
}

// ───────────────────────── 纯计算：采样、间隔、WAV 头 ─────────────────────────

/** @param {number} ms @param {number} rate */
const msToSamples = (ms, rate) => Math.round((Number(ms) || 0) * rate / 1000);
/** @param {number} samples @param {number} rate */
const samplesToMs = (samples, rate) => (rate > 0 ? Math.round(samples * 1000 / rate) : 0);

/**
 * 每句从第几个采样开始、到第几个结束。句间留 gap 个采样的静音，最后一句后面不留。
 * @param {number[]} lens 每句的采样数
 * @param {number} gap
 * @returns {{ starts: number[], ends: number[], total: number }}
 */
function gapLayout(lens, gap) {
  const g = Math.max(0, Math.round(Number(gap) || 0));
  /** @type {number[]} */
  const starts = [], ends = [];
  let at = 0;
  lens.forEach((n, i) => {
    if (i > 0) at += g;
    starts.push(at);
    at += Math.max(0, Math.round(Number(n) || 0));
    ends.push(at);
  });
  return { starts, ends, total: at };
}

/**
 * 解一个 WAV 头。按块一个个走，不假设 data 就在第 36 字节：ffmpeg 写出来的 WAV 中间夹着 LIST 块，
 * 按固定 44 字节去读，会把元数据当成声音。认不出来就返回 null，不猜。
 * @param {Buffer} buf 文件开头那一段（够装下所有头块就行）
 * @param {number} [fileSize] 文件实际大小。流式写出的 WAV 头里的长度是 0 或 0xFFFFFFFF，这时以它为准
 * @returns {WavInfo | null}
 */
function parseWav(buf, fileSize) {
  if (!buf || buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  const total = Number(fileSize) > 0 ? Number(fileSize) : buf.length;
  /** @type {{ formatTag: number, channels: number, sampleRate: number, bitsPerSample: number, blockAlign: number } | null} */
  let fmt = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) return null;
      let tag = buf.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE：真正的格式写在子格式 GUID 的头两个字节里
      if (tag === 0xfffe && size >= 40 && body + 26 <= buf.length) tag = buf.readUInt16LE(body + 24);
      fmt = {
        formatTag: tag, channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4),
        blockAlign: buf.readUInt16LE(body + 12), bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt || !fmt.sampleRate || !fmt.channels) return null;
      const room = Math.max(0, total - body);
      const bytes = size === 0 || size === 0xffffffff || size > room ? room : size;
      const ba = fmt.blockAlign || Math.ceil(fmt.bitsPerSample / 8) * fmt.channels;
      if (!ba) return null;
      const samples = Math.floor(bytes / ba);
      return { ...fmt, blockAlign: ba, pcm: fmt.formatTag === 1, dataOffset: body, dataBytes: samples * ba, samples, ms: samplesToMs(samples, fmt.sampleRate) };
    }
    off = body + size + (size & 1); // 奇数长度的块后面补一个字节
  }
  return null;
}

/**
 * 读文件开头解 WAV 头。不是 WAV、读不了都返回 null。
 * @param {string} abs
 * @returns {WavInfo | null}
 */
function readWavInfo(abs) {
  let fd = -1;
  try {
    fd = fs.openSync(abs, "r");
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 65536));
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return parseWav(head.subarray(0, n), size);
  } catch {
    return null;
  } finally {
    if (fd >= 0) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * 最朴素的 44 字节 PCM WAV 头。
 * @param {{ rate: number, channels?: number, bits?: number, dataBytes: number }} o
 */
function wavHeader(o) {
  const ch = o.channels || 1, bits = o.bits || 16, ba = ch * bits / 8;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + o.dataBytes, 4); h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(o.rate, 24); h.writeUInt32LE(o.rate * ba, 28); h.writeUInt16LE(ba, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii"); h.writeUInt32LE(o.dataBytes, 40);
  return h;
}

/**
 * 取最后 n 个字节，切在 UTF-8 字符边界上：ffmpeg 报错里带中文文件名时，从半个字中间切会出乱码。
 * @param {string} s
 * @param {number} [n]
 */
function tailBytes(s, n = 300) {
  const b = Buffer.from(String(s || ""), "utf8");
  if (b.length <= n) return b.toString("utf8").trim();
  let i = b.length - n;
  while (i < b.length && (b[i] & 0xc0) === 0x80) i++;
  return b.subarray(i).toString("utf8").trim();
}

/** @param {any} rate */
function checkRate(rate) {
  const r = Number(rate);
  if (!Number.isInteger(r) || r < 8000 || r > 192000) throw new Error(`采样率不对：${rate}（要 8000–192000 之间的整数）`);
  return r;
}

// ───────────────────────── 命令行参数（纯函数，测试直接比） ─────────────────────────

/** 只看第一条音轨。time_base 必须一起要：duration_ts 是按它记的，不知道单位就换算不成采样数 */
const probeArgs = (/** @type {string} */ abs) => [
  "-v", "error", "-select_streams", "a:0",
  "-show_entries", "stream=codec_name,sample_rate,channels,duration_ts,time_base,duration:format=duration",
  "-of", "json", abs,
];
/**
 * 解成 16 位单声道 PCM。-f wav 是因为写的是 .part 临时名，ffmpeg 靠扩展名猜不出格式；
 * 去掉元数据 + bitexact：同样的输入每次产出逐字节一样，头也是干净的 44 字节。
 */
const pcmArgs = (/** @type {string} */ inAbs, /** @type {string} */ outAbs, /** @type {number} */ rate) => [
  "-nostdin", "-v", "error", "-y", "-i", inAbs, "-vn", "-ac", "1", "-ar", String(rate), "-c:a", "pcm_s16le",
  "-map_metadata", "-1", "-fflags", "+bitexact", "-f", "wav", outAbs,
];
const mp3Args = (/** @type {string} */ inWav, /** @type {string} */ outAbs) => [
  "-nostdin", "-v", "error", "-y", "-i", inWav, "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3", outAbs,
];

// ───────────────────────── 视频画面的朝向 ─────────────────────────

/**
 * 问 ffprobe 视频宽高时一起要的旋转信息：显示矩阵里的角度，外加老版本 ffmpeg 写的 rotate 标签。
 * 接在 -show_entries 的「stream=…」后面，用冒号隔开。
 */
const ROTATION_ENTRIES = "stream_side_data=rotation:stream_tags=rotate";

/**
 * 一路视频流（ffprobe JSON 里 streams 的一项）播放时要转多少度，归到 0 / 90 / 180 / 270。
 * 显示矩阵优先，没有才看 rotate 标签。不是 90 的整数倍的斜角，ffmpeg 转正时不改宽高，这里算 0。
 * @param {any} s
 * @returns {number}
 */
function streamRotation(s) {
  let rot = 0;
  for (const d of Array.isArray(s && s.side_data_list) ? s.side_data_list : []) {
    if (d && d.rotation != null && Number.isFinite(Number(d.rotation))) rot = Number(d.rotation);
  }
  if (!rot && s && s.tags && s.tags.rotate != null) rot = Number(s.tags.rotate) || 0;
  const t = ((rot % 360) + 360) % 360;
  for (const k of [90, 180, 270]) if (Math.abs(t - k) < 1) return k;
  return 0;
}

/**
 * 转过之后的宽高：转 90° / 270° 就宽高对调。
 * @param {number} w @param {number} h @param {any} [rot]
 */
function turned(w, h, rot) {
  const r = Math.round(Number(rot) || 0);
  return Math.abs(r) % 180 === 90 ? { w: h, h: w } : { w, h };
}

/**
 * 一路视频流播放时看到的宽高。手机竖拍常存成 1920×1080 + 旋转 90°：ffmpeg 解码时默认先转正，
 * 滤镜拿到的已经是 1080×1920，所以按尺寸算缩放、裁切、横竖，都得用这个，不能用存的那个。
 * 只管旋转，不管像素宽高比（SAR）。
 * @param {any} s
 * @returns {{ w: number, h: number, rot: number }}
 */
function displaySize(s) {
  const rot = streamRotation(s);
  return { ...turned(Number(s && s.width) || 0, Number(s && s.height) || 0, rot), rot };
}

// ───────────────────────── 跑 ffmpeg / ffprobe ─────────────────────────

function abortError() {
  const e = /** @type {Error & { code?: string }} */ (new Error("已停止"));
  e.name = "AbortError"; e.code = "ABORT_ERR";
  return e;
}

/**
 * 跑一次二进制。PATH 用补全过的那份（ffmpeg 自己不再调别的，但 Homebrew 装的动态库要靠它找）；
 * signal 一停就杀掉子进程——用户点了停止，ffmpeg 不能还在后台转两分钟。
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeout: number, signal?: AbortSignal, what: string }} o
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runBin(bin, args, o) {
  return new Promise((resolve, reject) => {
    if (o.signal && o.signal.aborted) return reject(abortError());
    if (!bin) {
      const e = /** @type {Error & { code?: string }} */ (new Error(`没有 ${o.what} 可用`));
      e.code = "ENOENT";
      return reject(e);
    }
    let PATH = process.env.PATH || "";
    try { PATH = require("../engines/which").augmentedPath(); } catch {}
    execFile(bin, args, {
      timeout: o.timeout, maxBuffer: 16 << 20, windowsHide: true, signal: o.signal, encoding: "utf8",
      env: { ...process.env, PATH },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout: String(stdout), stderr: String(stderr) });
      /** @type {any} */
      const x = err;
      if (x.name === "AbortError" || (o.signal && o.signal.aborted)) return reject(abortError());
      /** @type {Error & { code?: string, exitCode?: number, timedOut?: boolean }} */
      let e;
      if (x.code === "ENOENT" || x.code === "EACCES") {
        e = new Error(`${o.what} 跑不起来：${bin}（${x.code === "ENOENT" ? "文件不存在" : "没有执行权限"}）`);
        e.code = x.code;
      } else if (x.killed && x.signal === "SIGTERM") {
        e = new Error(`${o.what} 跑了 ${Math.round(o.timeout / 1000)} 秒还没完，已经停掉`);
        e.timedOut = true;
      } else {
        const tail = tailBytes(String(stderr || ""), 300);
        e = new Error(`${o.what} 出错了（退出码 ${x.code}）${tail ? "：" + tail : ""}`);
        e.exitCode = typeof x.code === "number" ? x.code : undefined;
      }
      reject(e);
    });
  });
}

/** 这几种是「工具本身没法用」或「被叫停」，不是「这个文件读不懂」，要往上抛 */
const fatal = (/** @type {any} */ e) => !!e && (e.name === "AbortError" || e.code === "ENOENT" || e.code === "EACCES" || e.timedOut === true);

/**
 * 量一个音频文件：采样率、采样数、时长。
 * PCM 的 WAV 直接以文件头为准；别的格式用 ffprobe 的 duration_ts 按 time_base 换算。
 * exact=true 只给 PCM：mp3 这类有补齐的，量出来的数就算整齐也不代表真实可听长度。
 * ffprobe 跑了但读不懂（不存在、坏了、不是音频）返回 null，不编一个时长；ffprobe 本身跑不起来或被叫停则抛出。
 * @param {string} ffprobe
 * @param {string} abs
 * @param {{ signal?: AbortSignal }} [o]
 * @returns {Promise<AudioProbe | null>}
 */
async function probeAudio(ffprobe, abs, o = {}) {
  let out;
  try {
    out = await runBin(ffprobe, probeArgs(abs), { timeout: 20000, signal: o.signal, what: "ffprobe" });
  } catch (e) {
    if (fatal(e)) throw e;
    return null;
  }
  /** @type {any} */
  let j;
  try { j = JSON.parse(out.stdout || "{}"); } catch { return null; }
  const s = (j.streams || [])[0];
  if (!s) return null;
  const rate = Number(s.sample_rate) || 0;
  if (!rate) return null;
  const codec = String(s.codec_name || "");
  const channels = Number(s.channels) || 0;
  let samples = 0, exact = false;
  if (/^pcm_/.test(codec)) {
    const w = readWavInfo(abs);
    if (w && w.pcm && w.sampleRate === rate) { samples = w.samples; exact = true; }
  }
  if (!samples) {
    const tb = /^(\d+)\/(\d+)$/.exec(String(s.time_base || ""));
    const dts = Number(s.duration_ts);
    if (tb && Number(tb[1]) > 0 && Number(tb[2]) > 0 && Number.isFinite(dts) && dts > 0) {
      const num = Number(tb[1]), den = Number(tb[2]);
      samples = Math.round(dts * num * rate / den);
      exact = /^pcm_/.test(codec) && (dts * num * rate) % den === 0;
    }
  }
  if (!samples) {
    const d = Number(s.duration) || Number((j.format || {}).duration) || 0;
    if (d > 0) samples = Math.round(d * rate);
  }
  if (!samples) return null;
  return { samples, sampleRate: rate, ms: samplesToMs(samples, rate), codec, channels, exact };
}

/**
 * 解成指定采样率的 16 位单声道 WAV。先写 .part 再改名：中途被停，不会留下一个看着完整、其实只有半截的文件。
 * @param {string} ffmpeg
 * @param {string} inAbs
 * @param {string} outAbs
 * @param {{ rate: number, signal?: AbortSignal }} o
 * @returns {Promise<WavInfo>}
 */
async function toPcmWav(ffmpeg, inAbs, outAbs, o) {
  const rate = checkRate(o && o.rate);
  const part = outAbs + ".part";
  try {
    await runBin(ffmpeg, pcmArgs(inAbs, part, rate), { timeout: 60000, signal: o.signal, what: "ffmpeg" });
    fs.renameSync(part, outAbs);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch {}
    throw e;
  }
  const info = readWavInfo(outAbs);
  if (!info || !info.pcm) throw new Error(`ffmpeg 说转好了，但 ${path.basename(outAbs)} 读不出 WAV 头`);
  return info;
}

/**
 * 把几段 WAV 按采样首尾相接，句间塞 gapSamples 个采样的静音，最后一句后面不塞。
 * 拼接本身在 JS 里做：只是抄字节加补零，每个采样落在哪一格都是算出来的，不经过任何重采样。
 * 只有要 .mp3 时才叫 ffmpeg 把拼好的 WAV 编一次。
 * 每段都必须已经是 rate 采样率的 16 位单声道 PCM（先过一遍 toPcmWav）——不一样就直接报错，不偷偷转。
 * @param {string} ffmpeg 只有 outAbs 是 .mp3 时才用得上
 * @param {string[]} wavs
 * @param {{ gapSamples: number, rate: number, outAbs: string, signal?: AbortSignal }} o
 * @returns {Promise<{ samples: number, rate: number, ms: number, starts: number[], ends: number[] }>}
 */
async function concatWithGaps(ffmpeg, wavs, o) {
  const rate = checkRate(o.rate);
  const gap = Number(o.gapSamples || 0);
  if (!Number.isInteger(gap) || gap < 0 || gap > rate * 600) throw new Error(`句间留白不对：${o.gapSamples}（要 0 到 ${rate * 600} 之间的整数个采样）`);
  const outAbs = String(o.outAbs || "");
  const ext = path.extname(outAbs).toLowerCase();
  if (ext !== ".wav" && ext !== ".mp3") throw new Error(`整条音轨只能写成 .wav 或 .mp3，给的是「${ext || "没有扩展名"}」`);
  if (!Array.isArray(wavs) || !wavs.length) throw new Error("没有要拼的音频");
  // 先把每段的头都读一遍再动笔：拼到第 7 句才发现采样率不对，前面写的全白费
  const infos = wavs.map((f) => {
    const w = readWavInfo(f);
    if (!w || !w.pcm || w.bitsPerSample !== 16 || w.channels !== 1 || w.sampleRate !== rate) {
      const got = w ? `${w.pcm ? "PCM" : "格式 " + w.formatTag} ${w.bitsPerSample} 位 ${w.channels} 声道 ${w.sampleRate}Hz` : "不是能读的 WAV";
      throw new Error(`${path.basename(f)} 是 ${got}，要的是 16 位单声道 ${rate}Hz。先用 toPcmWav 转一遍再拼。`);
    }
    return w;
  });
  const lay = gapLayout(infos.map((w) => w.samples), gap);
  if (lay.total * 2 + 36 > 0xffffffff) throw new Error("拼出来超过 WAV 的 4GB 上限了，分成几段再拼");

  const tmp = ext === ".mp3" ? fs.mkdtempSync(path.join(os.tmpdir(), "owb-mprobe-")) : "";
  const wavOut = tmp ? path.join(tmp, "full.wav") : outAbs + ".part";
  try {
    await writeJoined(wavOut, wavs, infos, gap, rate, lay.total, o.signal);
    if (o.signal && o.signal.aborted) throw abortError();
    if (!tmp) fs.renameSync(wavOut, outAbs);
    else {
      const part = outAbs + ".part";
      try {
        await runBin(ffmpeg, mp3Args(wavOut, part), { timeout: 120000, signal: o.signal, what: "ffmpeg" });
        fs.renameSync(part, outAbs);
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch {}
        throw e;
      }
    }
  } catch (e) {
    if (!tmp) { try { fs.rmSync(wavOut, { force: true }); } catch {} }
    throw e;
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  }
  return { samples: lay.total, rate, ms: samplesToMs(lay.total, rate), starts: lay.starts, ends: lay.ends };
}

/**
 * @param {string} dest
 * @param {string[]} wavs
 * @param {WavInfo[]} infos
 * @param {number} gap
 * @param {number} rate
 * @param {number} total
 * @param {AbortSignal} [signal]
 */
async function writeJoined(dest, wavs, infos, gap, rate, total, signal) {
  const out = await fs.promises.open(dest, "w");
  try {
    await out.write(wavHeader({ rate, dataBytes: total * 2 }));
    const silence = gap ? Buffer.alloc(gap * 2) : null;
    const chunk = Buffer.alloc(1 << 20);
    for (let i = 0; i < wavs.length; i++) {
      // 每段之间都是一个 await 点，停止信号在这里能插进来；长音轨不必等全拼完才停
      if (signal && signal.aborted) throw abortError();
      if (i > 0 && silence) await out.write(silence);
      const src = await fs.promises.open(wavs[i], "r");
      try {
        let left = infos[i].dataBytes, pos = infos[i].dataOffset;
        while (left > 0) {
          const { bytesRead } = await src.read(chunk, 0, Math.min(chunk.length, left), pos);
          if (!bytesRead) throw new Error(`${path.basename(wavs[i])} 比它头里写的短，读到一半就没了`);
          await out.write(chunk.subarray(0, bytesRead));
          left -= bytesRead; pos += bytesRead;
        }
      } finally {
        await src.close();
      }
    }
  } finally {
    await out.close();
  }
}

module.exports = {
  resolveMediaBins, reset,
  probeAudio, toPcmWav, concatWithGaps,
  parseWav, readWavInfo, wavHeader, gapLayout, msToSamples, samplesToMs,
  probeArgs, pcmArgs, mp3Args, tailBytes, runBin,
  ROTATION_ENTRIES, streamRotation, turned, displaySize,
};
