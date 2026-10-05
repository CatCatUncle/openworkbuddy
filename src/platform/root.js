// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 仓库根的唯一锚点。要找仓库根（装机态是 Resources/app）的地方一律 require 这里，不再各写各的 __dirname。
 *
 * 为什么：代码文件全在根目录时，哪个文件的 __dirname 都是根；文件一挪进子目录，__dirname 跟着走。
 * 最要命的是 paths.js 的 APP_DIR——开发态 DATA_DIR 就等于它，它一漂，数据根就悄悄分叉到子目录底下，
 * 账号、会话、工作区全对不上。所以整个仓库只留这一处按自己的位置往上数，别的文件随便搬。
 *
 * 规矩：
 *   - 零依赖，只用 path。boot-check.js 是 server.js / cli.js 的第一句 require，它也靠这里找根，
 *     所以照它的写法：var、不用 ?. 和 ??、不用剩余参数。这里抛一下，闸门就没机会说人话了。
 *   - 这个文件自己不许挪。真要挪，改下面那两处 "..", ".."；test/layout-invariants.js 会当场对一遍。
 */
var path = require("path");

/** 仓库根的绝对路径。跟原来根目录那些文件的 __dirname 逐字相等 */
var ROOT = path.join(__dirname, "..", "..");

/**
 * 仓库根下的路径（只读的那一半：代码、public/、随包出厂的 skills/；可写的数据走 paths.dataPath）
 * @param {...string} seg
 * @returns {string}
 */
function rootPath() {
  return path.join.apply(path, [ROOT].concat(Array.prototype.slice.call(arguments)));
}

/** 仓库根的 package.json。走 require 缓存；读不到照样抛，要不要兜底由调用方自己定 */
function pkg() {
  return require("../../package.json");
}

module.exports = { ROOT: ROOT, rootPath: rootPath, pkg: pkg };
