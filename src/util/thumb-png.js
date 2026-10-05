// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/** 纯 Node 的 PNG 缩图 —— 不用任何原生依赖。
 *
 *  为什么要有这个文件：
 *  桌面版的 server.js 跑在 Electron 主进程里，缩图有 nativeImage 可用（thumb.js）。
 *  可 `npm start` 是**纯 node**，internal 部署、私有化那台服务器上更是连 electron 都没装
 *  （它只在 devDependencies 里）。用户那句「这个网页版感觉很卡」说的正是这一边：
 *  没有缩略图，产出卡上八张图就是 293 MB 的位图直接丢给浏览器解。
 *
 *  为什么不引 sharp / jimp：这个项目没有构建步骤，而且要装进国央企内网和私有化环境——
 *  那里既下不动 npm，也编不了原生模块。zlib 是 node 自带的，inflate/deflate 本身是 C++，
 *  真正用 JS 干的只有「解滤波 + 取平均」这两层循环：实测一张 2360×3720 的 6.8 MB 图
 *  260ms（inflate 42ms / 解滤+缩 209ms / 编码 6ms），缩出来 203×320、91 KB。
 *  这 260ms 只在缓存没命中时花一次，而且跑在 worker 线程上（见 thumb-worker.js），
 *  不占住那条正在推 SSE 的主线程。
 *
 *  只认 8/16 位、非隔行的 PNG。工作空间里 2939 张图有 2745 张正好是 bd8/ct2/il0，
 *  剩下的（jpg / webp / 隔行 / 调色板低位深）一律返回 null，调用方原样发原图——
 *  缩略图是锦上添花，绝不许因为它让一张图显示不出来。
 */

const zlib = require("zlib");

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_PIXELS = 80 * 1000 * 1000; // 再大的不接：一张 80MP 的图光裸数据就 320 MB

let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 拆块。PNG 就是「8 字节魔数 + 一串 长度/类型/数据/CRC」 */
function readChunks(buf) {
  const out = { idat: [], plte: null, trns: null };
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const end = off + 8 + len;
    if (len < 0 || end + 4 > buf.length) return null; // 截断的文件：宁可不缩
    const data = buf.subarray(off + 8, end);
    if (type === "IDAT") out.idat.push(data);
    else if (type === "PLTE") out.plte = data;
    else if (type === "tRNS") out.trns = data;
    else if (type === "IEND") break;
    off = end + 4;
  }
  return out.idat.length ? out : null;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** 读一张 PNG 的头。读不动就 null——调用方据此决定「原样发原图」 */
function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const depth = buf[24], color = buf[25], interlace = buf[28];
  if (!width || !height || width * height > MAX_PIXELS) return null;
  if (interlace !== 0) return null;                 // 隔行（Adam7）要另写一套，工作空间里一张都没有
  if (depth !== 8 && depth !== 16) return null;     // 低位深要按 bit 拆包，同上
  if (!CHANNELS[color]) return null;
  return { width, height, depth, color, channels: CHANNELS[color] };
}

/**
 * 缩成长边 w 的 PNG。缩不动一律 null。
 *
 * 一边解滤波一边往目标格子里累加：整张裸数据（33 MB 那种）从来不完整留在内存里，
 * 手上只有一行输入和一张目标大小的累加表。
 */
function shrinkPng(buf, w) {
  const info = pngInfo(buf);
  if (!info || !(w > 0)) return null;
  const { width, height, depth, color, channels } = info;
  if (Math.max(width, height) <= w) return null;    // 本来就比要的小，缩了只会更糊

  const chunks = readChunks(buf);
  if (!chunks) return null;
  if (color === 3 && (!chunks.plte || chunks.plte.length < 3)) return null;

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(chunks.idat)); } catch { return null; }

  const step = depth === 16 ? 2 : 1;               // 16 位只取高字节：缩略图看不出那一位的差别
  const bpp = channels * step;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null; // 数据不够一整张，别硬解

  const scale = Math.max(width, height) / w;
  const ow = Math.max(1, Math.round(width / scale));
  const oh = Math.max(1, Math.round(height / scale));
  const acc = new Float64Array(ow * oh * 4);
  const cnt = new Uint32Array(ow * oh);

  let cur = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  const plte = chunks.plte, trns = chunks.trns;
  let p = 0, hasAlpha = false;

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    raw.copy(cur, 0, p, p + stride);
    p += stride;
    // 五种滤波器，照 PNG 规范逐字节还原（规范里 Paeth 那条最绕，但也就这么几行）
    if (filter === 1) { for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; }
    else if (filter === 2) { for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 255; }
    else if (filter === 3) { for (let i = 0; i < stride; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255; }
    else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const est = a + b - c;
        const pa = est > a ? est - a : a - est, pb = est > b ? est - b : b - est, pc = est > c ? est - c : c - est;
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else if (filter !== 0) return null; // 没这个滤波器号，文件是坏的

    const oy = Math.min(oh - 1, (y / scale) | 0);
    const rowBase = oy * ow;
    for (let x = 0; x < width; x++) {
      const ox = Math.min(ow - 1, (x / scale) | 0);
      const cell = rowBase + ox, o = cell * 4, s = x * bpp;
      let r, g, b, a = 255;
      if (color === 2) { r = cur[s]; g = cur[s + step]; b = cur[s + step * 2]; }
      else if (color === 6) { r = cur[s]; g = cur[s + step]; b = cur[s + step * 2]; a = cur[s + step * 3]; }
      else if (color === 0) { r = g = b = cur[s]; }
      else if (color === 4) { r = g = b = cur[s]; a = cur[s + step]; }
      else {
        const idx = cur[s], i3 = idx * 3;
        if (i3 + 2 >= plte.length) return null;
        r = plte[i3]; g = plte[i3 + 1]; b = plte[i3 + 2];
        a = trns && idx < trns.length ? trns[idx] : 255;
      }
      if (a !== 255) hasAlpha = true;
      acc[o] += r; acc[o + 1] += g; acc[o + 2] += b; acc[o + 3] += a;
      cnt[cell]++;
    }
    // 两行对调就行，不用拷贝：下一轮 raw.copy 会把整行覆盖掉
    const tmp = prev; prev = cur; cur = tmp;
  }

  // 没有半透明就写成 RGB：同样一张图小掉四分之一，浏览器也少一条通道要合成
  const outCh = hasAlpha ? 4 : 3;
  const lines = Buffer.alloc(oh * (ow * outCh + 1));
  let q = 0;
  for (let y = 0; y < oh; y++) {
    lines[q++] = 0; // 缩略图本来就小，不值得再为每行挑滤波器
    for (let x = 0; x < ow; x++) {
      const cell = y * ow + x, n = cnt[cell] || 1, o = cell * 4;
      lines[q++] = acc[o] / n; lines[q++] = acc[o + 1] / n; lines[q++] = acc[o + 2] / n;
      if (outCh === 4) lines[q++] = acc[o + 3] / n;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ow, 0);
  ihdr.writeUInt32BE(oh, 4);
  ihdr[8] = 8;                       // 位深
  ihdr[9] = hasAlpha ? 6 : 2;        // 色彩类型
  let idat;
  try { idat = zlib.deflateSync(lines, { level: 6 }); } catch { return null; }
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * 截图的原始像素（NativeImage.toBitmap() 那份）编成 PNG。htmlshot.js 截完交给缩图线程做，不在界面线程上。
 *
 * 2026-09-29 量过：1242×1656 的截图（2 倍屏就是 2484×3312）在界面线程上 toPNG 同步 285–291ms，
 * 整页拉到 6000 高的 611ms——这期间窗口拖不动，五个对话的字一起停住。toBitmap 只是拷一份，同一张 3–4ms。
 *
 * 无损：像素一个不改。全不透明就写 RGB（截图几乎都是），每行按 libpng 的老办法挑滤波器（五种里绝对值和最小的）。
 * @param {Uint8Array} px 每像素 4 字节
 * @param {number} w @param {number} h
 * @param {{order?: string, premul?: boolean, level?: number, filter?: number}} [o]
 *   order：四个字节依次是哪个通道，缺省 "bgra"（跟 motion-clock 喂 ffmpeg 的那份一样）；
 *   premul：颜色已经乘过透明度（Skia 的位图是这样），半透明处要除回来；filter：测试用，钉死一种滤波器
 * @returns {Buffer|null}
 */
function encodeRaw(px, w, h, o = {}) {
  const order = String(o.order || "bgra");
  const R = order.indexOf("r"), G = order.indexOf("g"), B = order.indexOf("b"), A = order.indexOf("a");
  if (order.length !== 4 || R < 0 || G < 0 || B < 0 || A < 0) return null;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) || w * h > MAX_PIXELS) return null;
  if (!px || px.length !== w * h * 4) return null;
  let opaque = true;
  for (let i = A; i < px.length; i += 4) if (px[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4, stride = w * ch, premul = !!o.premul;
  const out = Buffer.allocUnsafe(h * (stride + 1));
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  const fixed = o.filter == null ? -1 : Number(o.filter);
  for (let y = 0, s = 0, q = 0; y < h; y++) {
    let k = 0;
    if (opaque) {
      for (let x = 0; x < w; x++, s += 4) { cur[k++] = px[s + R]; cur[k++] = px[s + G]; cur[k++] = px[s + B]; }
    } else {
      for (let x = 0; x < w; x++, s += 4) {
        const a = px[s + A];
        let r = px[s + R], g = px[s + G], b = px[s + B];
        if (premul && a < 255) {
          if (a === 0) r = g = b = 0;
          else { r = Math.min(255, Math.round(r * 255 / a)); g = Math.min(255, Math.round(g * 255 / a)); b = Math.min(255, Math.round(b * 255 / a)); }
        }
        cur[k++] = r; cur[k++] = g; cur[k++] = b; cur[k++] = a;
      }
    }
    // 跟上一行一模一样（截图里大片的底色）：「减上一行」整行是 0，不用挑
    const f = fixed >= 0 ? fixed : y > 0 && cur.equals(prev) ? 2 : pickFilter(cur, prev, ch);
    out[q++] = f;
    q = filterRow(f, cur, prev, ch, out, q);
    const t = prev; prev = cur; cur = t;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  let idat;
  try { idat = zlib.deflateSync(out, { level: o.level == null ? 6 : o.level }); } catch { return null; }
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 按滤波器 f 把一行写进 out（每种一个循环：一个循环里判五次分支，8MP 的图要慢一倍） */
function filterRow(f, cur, prev, ch, out, q) {
  const n = cur.length;
  if (f === 0) { cur.copy(out, q); return q + n; }
  if (f === 2) { for (let i = 0; i < n; i++) out[q++] = cur[i] - prev[i]; return q; }
  for (let i = 0; i < ch; i++) out[q++] = f === 1 ? cur[i] : f === 3 ? cur[i] - (prev[i] >> 1) : cur[i] - prev[i];
  if (f === 1) for (let i = ch; i < n; i++) out[q++] = cur[i] - cur[i - ch];
  else if (f === 3) for (let i = ch; i < n; i++) out[q++] = cur[i] - ((cur[i - ch] + prev[i]) >> 1);
  else for (let i = ch; i < n; i++) out[q++] = cur[i] - paeth(cur[i - ch], prev[i], prev[i - ch]);
  return q;
}

/** 五种滤波各算一遍「按有符号看的绝对值和」，取最小的 */
function pickFilter(cur, prev, ch) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  for (let i = 0; i < cur.length; i++) {
    const v = cur[i], l = i >= ch ? cur[i - ch] : 0, u = prev[i], ul = i >= ch ? prev[i - ch] : 0;
    let d = v; s0 += d < 128 ? d : 256 - d;
    d = (v - l) & 255; s1 += d < 128 ? d : 256 - d;
    d = (v - u) & 255; s2 += d < 128 ? d : 256 - d;
    d = (v - ((l + u) >> 1)) & 255; s3 += d < 128 ? d : 256 - d;
    d = (v - paeth(l, u, ul)) & 255; s4 += d < 128 ? d : 256 - d;
  }
  let f = 0, m = s0;
  if (s1 < m) { f = 1; m = s1; }
  if (s2 < m) { f = 2; m = s2; }
  if (s3 < m) { f = 3; m = s3; }
  if (s4 < m) { f = 4; }
  return f;
}

module.exports = { shrinkPng, pngInfo, crc32, encodeRaw, MAX_PIXELS };
