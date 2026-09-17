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

module.exports = { shrinkPng, pngInfo, crc32 };
