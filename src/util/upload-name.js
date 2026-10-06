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

module.exports = { uploadCandidate, writeUploadFresh };
