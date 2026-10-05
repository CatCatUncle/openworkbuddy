// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Windows 不认的文件名。
 *
 * NTFS 上 `a:b.txt` 不报错——冒号后面那半截被当成「备用数据流」，文件夹里只看得见一个 0 字节的 a，
 * 内容藏在流里，资源管理器打不开，模型却以为写成功了。`< > " | ? *` 直接报错；
 * CON、NUL、COM1 这些保留名不管带什么扩展名都打不开；末尾的点和空格会被系统悄悄去掉，
 * 写进去的和读回来的不是一个名字。别的系统不受影响，照原样放行。
 *
 * 两种用法：
 *   · 名字是外面来的（IM 附件、下载）→ safeSegment 换成能用的，用户不在乎差一个字符；
 *   · 名字是模型起的（write_file）→ badPath 拦下来报给模型，让它自己换名字。
 *     不能悄悄改：改了以后模型汇报的路径根本不存在。
 */

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[<>:"|?*\x00-\x1f]/;
// eslint-disable-next-line no-control-regex
const BAD_CHARS_G = /[<>:"|?*\x00-\x1f]/g;
// 扩展名前面带空格的（`CON .txt`）也算：Windows 先截掉扩展名、再去掉末尾空格，剩下的还是 CON
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\..*)?$/i;

/**
 * 一段文件名（不含 / 和 \）在 Windows 上为什么不能用。能用返回空串。
 * @param {string} name
 */
function badSegment(name) {
  const s = String(name || "");
  if (!s || s === "." || s === "..") return "";
  if (BAD_CHARS.test(s)) return `文件名「${s}」里有 Windows 不认的字符（: ? * < > | "），换个名字`;
  if (RESERVED.test(s)) return `「${s}」是 Windows 的保留名，换个名字`;
  if (/[. ]$/.test(s)) return `文件名「${s}」末尾是点或空格，Windows 会把它去掉，换个名字`;
  return "";
}

/**
 * 整条路径里第一处不能用的段。开头的盘符（C:）和 \\?\、\\server\share 这种前缀不算。
 * @param {string} p
 * @param {string} [platform]
 */
function badPath(p, platform = process.platform) {
  if (platform !== "win32") return "";
  let s = String(p || "");
  s = s.replace(/^\\\\[?.]\\/, "").replace(/^[a-zA-Z]:/, "");
  for (const seg of s.split(/[\\/]+/)) {
    const why = badSegment(seg);
    if (why) return why;
  }
  return "";
}

/**
 * 外面来的一段名字 → Windows 上能用的。别的系统原样返回。
 * @param {string} name
 * @param {string} [platform]
 */
function safeSegment(name, platform = process.platform) {
  let s = String(name || "");
  if (platform !== "win32") return s;
  s = s.replace(BAD_CHARS_G, "_").replace(/[. ]+$/, "");
  if (RESERVED.test(s)) s = "_" + s;
  return s;
}

module.exports = { badSegment, badPath, safeSegment };
