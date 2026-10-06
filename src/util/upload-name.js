// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 上传落盘不覆盖：同名的已经在了，就叫 名字_2.扩展名、名字_3.扩展名……
 *
 * 以前 /api/upload 拿原名直接写：手机导出来的图十张有八张叫 image.png，画布上拖第二张进来，
 * 第一张就被盖掉了——挂着它的那几张卡、引用它的那几镜，从此显示的都是第二张，没有任何提示。
 * 被盖掉的那份可能是上一轮的产出、可能是别人的参考图，找不回来。
 *
 * 用独占写（wx）挑名字，不是先 exists 再写：两张同名图同时传上来，先查后写的两趟会查到同一个空位，
 * 后写的照样把先写的盖掉。独占写撞上了就往后挪一个号。
 */
const fs = require("fs");
const path = require("path");

const MAX_TRY = 999;

/** 第 n 个候选名：1 就是原名，往后是 名字_n.扩展名。点开头的（.env）整个当名字，不拆扩展名 */
function uploadCandidate(base, n) {
  if (n <= 1) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || base;
  return `${stem}_${n}${ext}`;
}

/**
 * 把 buf 写进 dir，名字从 base 起挑一个盘上没有的。返回真正落盘的那个名字（不含目录）。
 * 目录不在就建。写不进去（权限、磁盘满）照原样抛，不吞
 * @param {string} dir
 * @param {string} base 已经洗过的文件名（不含路径分隔符）
 * @param {Buffer} buf
 * @param {{ fs?: typeof fs }} [o]
 * @returns {string}
 */
function writeUploadFresh(dir, base, buf, o = {}) {
  const fsx = o.fs || fs;
  fsx.mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= MAX_TRY; n += 1) {
    const name = uploadCandidate(base, n);
    try {
      fsx.writeFileSync(path.join(dir, name), buf, { flag: "wx" });
      return name;
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
  }
  // 九百多个同名还都在：加个时间戳，照样不覆盖
  const name = uploadCandidate(base, Date.now());
  fsx.writeFileSync(path.join(dir, name), buf, { flag: "wx" });
  return name;
}

/** name 是不是从 base 挑名字时挑得到的那几个之一：原名本身，或者 名字_N.扩展名（N 从 2 起） */
function uploadIsCandidate(base, name) {
  base = String(base || ""); name = String(name || "");
  if (!base || !name) return false;
  if (name === base) return true;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || base;
  if (!name.startsWith(`${stem}_`) || !name.endsWith(ext)) return false;
  const n = name.slice(stem.length + 1, name.length - ext.length);
  return /^[1-9]\d*$/.test(n) && Number(n) >= 2;
}

/**
 * 同一枚附件重拖了一遍（文件刚改过）：原地换掉它上一趟落的那份，不再另起 名字_2。
 * 以前一律另起：chip 改叫 名字_2，上一趟那份没人认了，还躺在目录里，模型列目录时看见两份不知道用哪份。
 *
 * 只换「确实是这一枚自己那份」的：prevName 不带目录、是 base 的候选名，而且 owns(prevName, 绝对路径) 点头
 * （服务端拿上传那一刻记下的 mtime 去对，Agent 改写过就对不上）。换不了返回 ""，调用方照常走 writeUploadFresh。
 * 先写临时文件再改名：写到一半断了，原来那份还在
 * @param {string} dir
 * @param {string} base 这次请求洗过的文件名
 * @param {string} prevName 上一趟落盘的名字（不含目录）
 * @param {Buffer} buf
 * @param {(name: string, file: string) => boolean} owns
 * @param {{ fs?: typeof fs }} [o]
 * @returns {string}
 */
function writeUploadReplace(dir, base, prevName, buf, owns, o = {}) {
  const fsx = o.fs || fs;
  const name = String(prevName || "");
  if (!name || path.basename(name) !== name || !uploadIsCandidate(base, name)) return "";
  const file = path.join(dir, name);
  if (typeof owns !== "function" || !owns(name, file)) return "";
  const tmp = `${file}.${process.pid}.tmp`;
  fsx.writeFileSync(tmp, buf);
  fsx.renameSync(tmp, file);
  return name;
}

module.exports = { uploadCandidate, writeUploadFresh, uploadIsCandidate, writeUploadReplace };
