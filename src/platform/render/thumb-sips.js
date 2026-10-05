// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 桌面主进程里那三件缩图的活（缩略图、给模型看的图压小、宠物头像）交给 macOS 自带的 sips 子进程做。
 *
 * 为什么：2026-09-29 在本机量的，这三件原来都是 nativeImage 在 Electron 主进程里**同步**解码、缩放、编码，
 * 而主进程就是界面线程。一张 6016×6016 的照片：缩略图 145–153ms、压图 144ms、宠物头像 181ms；
 * 4032 的手机照片 40–61ms；2048 的 PNG 50–66ms。资料库一屏封面、对话里连着贴几张图，
 * 就是一串连着的几十上百毫秒卡顿——多开几个对话一起跑的时候，用户看到的「卡」就有这一份。
 * createThumbnailFromPath 解码是在别的线程，但拿回来还得 toPNG，那一下同步 54–64ms，躲不掉。
 *
 * sips 同一张图 80–150ms，但那是另一个进程的时间；界面线程上只剩起进程那一下。
 * 同时最多跑两个、走 nice -n 10：缩图是背景活，不许抢用户正在干的事。
 *
 * 读不出图的尺寸、sips 跑挂了、超时了，一律回 null——调用方退回原来的 nativeImage 那条路，
 * 结果跟以前一模一样，只是那一张还是在主线程上做。不会因为换了路子让一张图出不来。
 * 只在 macOS 上用（bridge-main.js 由 electron-main.js 注入）；别的系统还是 nativeImage。
 */
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { runQuiet } = require("./ql-thumb");

const SIPS = "/usr/bin/sips";
const NICE = "/usr/bin/nice";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 从文件头读宽高，不解码。认 PNG / GIF / BMP / WebP / JPEG，别的回 null。
 * 要它是因为 sips 的 -Z 会把小图**放大**，缩之前得先知道原图多大；宠物头像的说明里也要写原图尺寸。
 * @param {Buffer} buf 文件开头一段 @returns {{width:number,height:number,orientation?:number}|null|{jpegAt:number,orientation?:number}}
 *   JPEG 的尺寸在 SOF 段里，前面可能隔着几十 KB 的 EXIF；这一段里没走到就回 {jpegAt}：从那个偏移接着读。
 *   JPEG 带 EXIF 方向的再给 orientation（1–8，宽高是存储的、没转过的）
 */
function parseSize(buf, base = 0, orientation = 0) {
  if (!buf || buf.length < 10) return null;
  const ok = (w, h) => (w > 0 && h > 0 ? { width: w, height: h } : null);
  if (base === 0) {
    if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
    if (buf.toString("latin1", 0, 4) === "GIF8") return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
    if (buf.toString("latin1", 0, 2) === "BM" && buf.length >= 26) {
      if (buf.readUInt32LE(14) === 12) return ok(buf.readUInt16LE(18), buf.readUInt16LE(20));
      return ok(Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)));
    }
    if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
      const kind = buf.toString("latin1", 12, 16);
      if (kind === "VP8 ") return ok(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
      if (kind === "VP8L") {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return ok(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
      }
      if (kind === "VP8X") return ok(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
      return null;
    }
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    return walkJpeg(buf, 2, 0);
  }
  return walkJpeg(buf, 0, base, orientation);
}

/** 顺着 JPEG 的段往下走，找到 SOF 就是宽高，路过 EXIF 顺手记下方向。buf 是从文件偏移 base 开始的一段 */
function walkJpeg(buf, i, base, orientation = 0) {
  const done = (r) => (r && orientation ? { ...r, orientation } : r);
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;              // 段没对齐：文件坏了
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }             // 填充字节
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;     // 走到图像数据了还没见 SOF
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7);
      return w > 0 && h > 0 ? done({ width: w, height: h }) : null;
    }
    const len = buf.readUInt16BE(i + 2);
    if (m === 0xe1 && !orientation) orientation = exifOrientation(buf.subarray(i + 4, i + 2 + len));
    i += 2 + len;
  }
  return done({ jpegAt: base + i });
}

/** APP1 段内容（"Exif\0\0" + TIFF）里 IFD0 的方向（0x0112），读不到回 0。段被切在半截也不越界 */
function exifOrientation(seg) {
  if (seg.length < 14 || seg.toString("latin1", 0, 6) !== "Exif\0\0") return 0;
  const t = seg.subarray(6);
  const bo = t.toString("latin1", 0, 2);
  if (bo !== "II" && bo !== "MM") return 0;
  const le = bo === "II";
  const u16 = (o) => (o >= 0 && o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : -1);
  const u32 = (o) => (o >= 0 && o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : -1);
  const ifd = u32(4);
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + 12 * k;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 0; }
  }
  return 0;
}

/**
 * sips 出图会把原图的 EXIF / XMP / IPTC 原样抄过去——拍照地点（GPS）、相机型号、拍摄时间都在里面。
 * 压给模型的图要发到外面，缩略图、宠物头像也用不着这些；nativeImage 那条老路出来的图本来就是干净的。
 * JPEG 只留 JFIF（APP0）和色彩配置（APP2 ICC_PROFILE），PNG 去掉 eXIf 和文字块（XMP 在 iTXt 里）。
 * 认不出的结构回 null，调用方当这趟没做成、退回老路子，不把没洗干净的图交出去。
 */
function stripJpegMeta(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const keep = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xda) { keep.push(buf.subarray(i)); return Buffer.concat(keep); } // 往后是图像数据，原样留
    if (m === 0xd9) return null;
    const end = i + 2 + buf.readUInt16BE(i + 2);
    if (end > buf.length) return null;
    const icc = m === 0xe2 && buf.toString("latin1", i + 4, i + 16) === "ICC_PROFILE\0";
    const meta = (m >= 0xe1 && m <= 0xef && !icc) || m === 0xfe;
    if (!meta) keep.push(buf.subarray(i, end));
    i = end;
  }
  return null;
}

const PNG_META = new Set(["eXIf", "iTXt", "tEXt", "zTXt", "tIME"]);
function stripPngMeta(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const keep = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const end = i + 12 + buf.readUInt32BE(i);
    if (end > buf.length) return null;
    const type = buf.toString("latin1", i + 4, i + 8);
    if (!PNG_META.has(type)) keep.push(buf.subarray(i, end));
    if (type === "IEND") return Buffer.concat(keep);
    i = end;
  }
  return null;
}

/** EXIF 方向 → sips 顺时针转几度（转完再把方向标记去掉，像素就是正的）。镜像的四种不认，回 null */
const TURN = { 1: 0, 3: 180, 6: 90, 8: 270 };

const HEAD_BYTES = 64 * 1024;
const JPEG_SCAN_MAX = 4 * 1024 * 1024;   // EXIF 再大也没见过超过这个的；走到这儿还没 SOF 就当读不出

/** 异步读文件头拿尺寸（fs 全走 promises，不在主线程上同步碰盘）。读不出回 null */
async function imageSize(abs) {
  let fh = null;
  try {
    fh = await fsp.open(abs, "r");
    let pos = 0;
    let r = null;
    for (let hop = 0; hop < 64; hop++) {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, pos);
      if (!bytesRead) return null;
      r = parseSize(buf.subarray(0, bytesRead), pos, r && r.orientation);
      if (!r || !("jpegAt" in r)) return r;
      if (r.jpegAt <= pos || r.jpegAt > JPEG_SCAN_MAX) return null;
      pos = r.jpegAt;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * @param {{spawn?: Function, sips?: string, max?: number, timeoutMs?: number, staleMs?: number,
 *   tmpRoot?: string, sizeOf?: (abs: string) => Promise<{width:number,height:number}|null>,
 *   now?: () => number}} [o]
 *   spawn / sizeOf / now 给测试换假的。staleMs：排队排了这么久才轮到的缩略图不做了——
 *   服务进程那头 10 秒就不等了（thumb.js 的 timeoutMs），做出来也没人收
 */
function createSipsPixels(o = {}) {
  const max = Math.max(1, Number(o.max) || 2);
  // 一张图正常 80–150ms；卡住的那趟别占着名额比服务进程等缩略图的 10 秒还久
  const timeoutMs = Number(o.timeoutMs) || 8000;
  const staleMs = Number(o.staleMs) || 9000;
  const sizeOf = o.sizeOf || imageSize;
  const now = o.now || Date.now;
  const sips = o.sips || SIPS;
  const counts = { runs: 0, ok: 0, fails: 0, fallbacks: 0, stale: 0, peak: 0, queuedPeak: 0 };
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  let dirP = null;
  let dir = "";
  let seq = 0;
  let closed = false;

  const tmpDir = () => (dirP = dirP || fsp.mkdtemp(path.join(o.tmpRoot || os.tmpdir(), "owb-px-")).then((d) => (dir = d)));

  function acquire() {
    if (active < max) { active++; counts.peak = Math.max(counts.peak, active); return Promise.resolve(); }
    return new Promise((res) => {
      waiting.push(() => { active++; counts.peak = Math.max(counts.peak, active); res(); });
      counts.queuedPeak = Math.max(counts.queuedPeak, waiting.length);
    });
  }
  function release() {
    active--;
    const next = waiting.shift();
    if (next) next();
  }

  /** 跑一趟 sips，产物读回来、洗掉元数据。跑不成、洗不了回 null */
  async function run(args, ext) {
    if (closed) return null;
    const out = path.join(await tmpDir(), `${process.pid}-${++seq}${ext}`);
    counts.runs++;
    try {
      const r = await runQuiet(o.spawn, NICE, ["-n", "10", sips, ...args, "--out", out], { timeoutMs });
      if (r.code !== 0) { counts.fails++; return null; }
      const raw = await fsp.readFile(out).catch(() => null);
      const buf = raw && raw.length ? (ext === ".jpg" ? stripJpegMeta(raw) : stripPngMeta(raw)) : null;
      if (!buf) { counts.fails++; return null; }
      counts.ok++;
      return buf;
    } finally {
      fsp.unlink(out).catch(() => {});
    }
  }

  /** 排队拿一个名额再干；fn 回 null 记一次「退回老路」 */
  async function job(fn, { stale = false } = {}) {
    const t0 = now();
    await acquire();
    try {
      if (stale && now() - t0 > staleMs) { counts.stale++; return { value: null }; }
      const r = await fn();
      if (!r) counts.fallbacks++;
      return r;
    } catch {
      counts.fallbacks++;
      return null;
    } finally {
      release();
    }
  }

  return {
    counts,
    get active() { return active; },
    get queued() { return waiting.length; },
    /**
     * 缩略图，口径跟 thumb.js makeThumb 一样：长边缩到 w、出 PNG；本来就不比 w 大回 {value:null}（发原图）。
     * @returns {Promise<{value: Buffer|null}|null>} null = sips 这条路走不通，调用方走老路
     */
    thumb: (abs, w) => job(async () => {
      const sz = await sizeOf(abs);
      if (!sz) return null;
      if (Math.max(sz.width, sz.height) <= w) return { value: null };
      const buf = await run(["-s", "format", "png", "-Z", String(w), abs], ".png");
      return buf ? { value: buf } : null;
    }, { stale: true }),
    /**
     * 给模型看的图压小，口径跟 bridge-main.js 那段 nativeImage 一样：长边超过 maxEdge 才缩，出 JPEG，带原图宽高。
     * sips 出 JPEG 不转像素、只抄方向标记，标记又跟着元数据一起洗掉了——手机竖着拍的照片得先按标记转正，
     * 宽高也报转正以后的
     * @returns {Promise<{value: {jpg: Buffer, width: number, height: number}}|null>}
     */
    shrinkForVision: (abs, maxEdge, quality) => job(async () => {
      const sz = await sizeOf(abs);
      if (!sz) return null;
      const turn = TURN[sz.orientation || 1];
      if (turn == null) return null;
      const args = ["-s", "format", "jpeg", "-s", "formatOptions", String(quality)];
      if (turn) args.push("-r", String(turn));
      if (Math.max(sz.width, sz.height) > maxEdge) args.push("-Z", String(maxEdge));
      const jpg = await run([...args, abs], ".jpg");
      const side = turn === 90 || turn === 270;
      return jpg ? { value: { jpg, width: side ? sz.height : sz.width, height: side ? sz.width : sz.height } } : null;
    }),
    /**
     * 宠物头像：中心裁方、320、GIF 只取第一帧，说明文字跟原来一字不差。
     * sips 同一趟里先缩后裁才对得上中心（先 -c 再 -z 出来是歪的，本机试过），所以先把短边缩到 320 再裁
     * @returns {Promise<{value: {png: Buffer, note: string}}|null>}
     */
    petPhoto: (abs) => job(async () => {
      const raw = await sizeOf(abs);
      if (!raw) return null;
      // 出 PNG 时 sips 自己按方向标记转正了；说明里的尺寸、先缩哪条边都按转正以后的算
      const side = raw.orientation >= 5;
      const sz = side ? { width: raw.height, height: raw.width } : raw;
      let note = "";
      if (sz.width !== sz.height) note += `原图 ${sz.width}×${sz.height} 不是正方形，已按中心裁成方图；`;
      const fit = sz.width >= sz.height ? "--resampleHeight" : "--resampleWidth";
      const png = await run(["-s", "format", "png", fit, "320", "-c", "320", "320", abs], ".png");
      if (!png) return null;
      if (/\.gif$/i.test(abs)) note += "GIF 只取了第一帧（宠物自己带呼吸/跳跃动效）；";
      return { value: { png, note } };
    }),
    /**
     * 退出时收掉临时目录。退出那一刻异步的删不一定来得及跑，目录已经建好就当场同步删；
     * 还在建的等它建好再删。还在跑的那几趟由 runQuiet 自己的超时兜底
     */
    close() {
      closed = true;
      const p = dirP;
      dirP = null;
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} dir = ""; }
      else if (p) p.then((d) => fsp.rm(d, { recursive: true, force: true })).catch(() => {});
    },
  };
}

module.exports = { createSipsPixels, parseSize, imageSize, stripJpegMeta, stripPngMeta, exifOrientation, SIPS };
