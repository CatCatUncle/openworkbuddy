// @ts-check
"use strict";
/**
 * 读字体文件里写的「字体名」。
 *
 * 烧字幕时 libass 是按**名字**找字体的：.ass 里写 Fontname=思源黑体，fontsdir 里放着
 * SourceHanSansSC-Regular.otf——名字对不上，libass 不报错，悄悄换一个它找得到的字体，
 * Linux 上常常换成一个没有中文的，于是整条字幕变成方块。文件名不是字体名，只能读文件里的 name 表。
 *
 * libass 认的是 Windows 平台（platform 3）的 nameID 1（家族名）、4（全名）、6（PostScript 名），
 * 所以这里先拿 nameID 1，其次 16（排版家族名，新字体常把粗细放在 1 里、把真正的家族名放在 16），
 * 最后 4；同一个 nameID 有英文和中文两份时优先英文——写进 .ass 那一行的名字越朴素越不容易出岔子。
 * 支持 .ttf / .otf / .ttc（字体集合只读第一个字体）。只读文件头和 name 表，不把十几 MB 的中文字体整个读进来。
 */
const fs = require("fs");

/** @typedef {{platform: number, encoding: number, language: number, nameId: number, value: string}} NameRecord */

/**
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} len
 * @param {number} platform
 * @returns {string}
 */
function decodeName(buf, start, len, platform) {
  const bytes = buf.subarray(start, start + len);
  if (platform === 0 || platform === 3) {
    // UTF-16BE。Node 只有 LE，逐对换一下
    const le = Buffer.alloc(bytes.length - (bytes.length % 2));
    for (let i = 0; i + 1 < bytes.length; i += 2) { le[i] = bytes[i + 1]; le[i + 1] = bytes[i]; }
    return le.toString("utf16le");
  }
  // Mac 平台老字体：MacRoman，ASCII 那一半和 latin1 一样，够认名字了
  return bytes.toString("latin1");
}

/**
 * 解析一张 name 表
 * @param {Buffer} buf 至少包含整张 name 表
 * @param {number} at name 表在 buf 里的起点
 * @returns {NameRecord[]}
 */
function parseNameTable(buf, at) {
  if (at + 6 > buf.length) return [];
  const count = buf.readUInt16BE(at + 2), strOff = at + buf.readUInt16BE(at + 4);
  /** @type {NameRecord[]} */
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = at + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platform = buf.readUInt16BE(r), encoding = buf.readUInt16BE(r + 2), language = buf.readUInt16BE(r + 4);
    const nameId = buf.readUInt16BE(r + 6), len = buf.readUInt16BE(r + 8), off = buf.readUInt16BE(r + 10);
    if (strOff + off + len > buf.length) continue;
    const value = decodeName(buf, strOff + off, len, platform).replace(/\0/g, "").trim();
    if (value) out.push({ platform, encoding, language, nameId, value });
  }
  return out;
}

/**
 * 从一组 name 记录里挑名字：Windows 英文 > Windows 其他语言 > Unicode 平台 > Mac
 * @param {NameRecord[]} recs
 * @param {number} nameId
 * @returns {string}
 */
function pickName(recs, nameId) {
  const hits = recs.filter((r) => r.nameId === nameId);
  const rank = (/** @type {NameRecord} */ r) => (r.platform === 3 ? (r.language === 0x409 ? 0 : 1) : r.platform === 0 ? 2 : 3);
  hits.sort((a, b) => rank(a) - rank(b));
  return hits.length ? hits[0].value : "";
}

/**
 * 字体文件（整份 buffer）→ 各种名字。给测试和小文件用；大文件走 readFontFamily，只读需要的那几段
 * @param {Buffer} buf
 * @returns {{family: string, typoFamily: string, full: string, postscript: string} | null}
 */
function parseFontNames(buf) {
  const loc = locateNameTable(buf.length, (pos, len) => buf.subarray(pos, pos + len));
  if (!loc) return null;
  return namesFrom(parseNameTable(buf, loc.offset));
}

/** @param {NameRecord[]} recs */
function namesFrom(recs) {
  if (!recs.length) return null;
  return { family: pickName(recs, 1), typoFamily: pickName(recs, 16), full: pickName(recs, 4), postscript: pickName(recs, 6) };
}

/**
 * 找 name 表在文件里的位置
 * @param {number} size 文件总长
 * @param {(pos: number, len: number) => Buffer} read
 * @returns {{offset: number, length: number} | null}
 */
function locateNameTable(size, read) {
  if (size < 12) return null;
  let base = 0;
  const head = read(0, 12);
  if (head.length < 12) return null;
  const tag = head.toString("latin1", 0, 4);
  if (tag === "ttcf") {
    // 字体集合：头 12 字节之后是每个字体的偏移表，只读第一个
    const first = read(12, 4);
    if (first.length < 4) return null;
    base = first.readUInt32BE(0);
  } else if (!(head.readUInt32BE(0) === 0x00010000 || tag === "OTTO" || tag === "true")) {
    return null;
  }
  const dir = base === 0 ? head : read(base, 12);
  if (dir.length < 12) return null;
  const n = dir.readUInt16BE(4);
  if (!n || n > 512) return null;
  const recs = read(base + 12, n * 16);
  for (let i = 0; i + 16 <= recs.length; i += 16) {
    if (recs.toString("latin1", i, i + 4) === "name") {
      const offset = recs.readUInt32BE(i + 8), length = recs.readUInt32BE(i + 12);
      if (offset + length > size || length > (4 << 20)) return null;
      return { offset, length };
    }
  }
  return null;
}

/**
 * 字体文件 → 写进 .ass 的字体名；读不出来返回空串（调用方要说出来，不能假装用上了品牌字体）
 * @param {string} file
 * @returns {string}
 */
function readFontFamily(file) {
  let fd = -1;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const read = (/** @type {number} */ pos, /** @type {number} */ len) => {
      const b = Buffer.alloc(Math.max(0, Math.min(len, size - pos)));
      if (b.length) fs.readSync(fd, b, 0, b.length, pos);
      return b;
    };
    const loc = locateNameTable(size, read);
    if (!loc) return "";
    const names = namesFrom(parseNameTable(read(loc.offset, loc.length), 0));
    return names ? names.family || names.typoFamily || names.full || "" : "";
  } catch {
    return "";
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch {}
  }
}

/**
 * 没给品牌字体时写进 .ass 的名字：各平台自带、一定有中文的那一款
 * @param {string} [platform]
 * @returns {string}
 */
function defaultCjkFamily(platform = process.platform) {
  if (platform === "darwin") return "PingFang SC";
  if (platform === "win32") return "Microsoft YaHei";
  return "Noto Sans CJK SC";
}

module.exports = { readFontFamily, parseFontNames, defaultCjkFamily, _internals: { parseNameTable, locateNameTable, pickName } };
