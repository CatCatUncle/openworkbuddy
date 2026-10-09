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
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const MAX_TRY = 999;

/**
 * data 是 Buffer：照写。是 { from }：那是 receiveUploadToTemp 收好的临时文件，改名过去，不再读进内存。
 * exclusive 时先用独占写占住这个名字（空文件），再拿临时文件 rename 盖上去——rename 本身不认 wx，
 * 不先占住的话两份同名的同时到，后到的照样把先到的盖掉
 */
function placeUpload(fsx, file, data, exclusive) {
  if (!data || Buffer.isBuffer(data) || typeof data.from !== "string") {
    fsx.writeFileSync(file, data, exclusive ? { flag: "wx" } : undefined);
    return;
  }
  if (exclusive) fsx.writeFileSync(file, "", { flag: "wx" });
  try {
    fsx.renameSync(data.from, file);
  } catch (e) {
    if (exclusive) { try { fsx.unlinkSync(file); } catch {} } // 占位的空文件别留下
    throw e;
  }
}

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
 * @param {Buffer | { from: string }} buf 内容，或者 receiveUploadToTemp 收好的临时文件
 * @param {{ fs?: typeof fs }} [o]
 * @returns {string}
 */
function writeUploadFresh(dir, base, buf, o = {}) {
  const fsx = o.fs || fs;
  fsx.mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= MAX_TRY; n += 1) {
    const name = uploadCandidate(base, n);
    try {
      placeUpload(fsx, path.join(dir, name), buf, true);
      return name;
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
  }
  // 九百多个同名还都在：加个时间戳，照样不覆盖
  const name = uploadCandidate(base, Date.now());
  placeUpload(fsx, path.join(dir, name), buf, true);
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
 * @param {Buffer | { from: string }} buf 内容，或者 receiveUploadToTemp 收好的临时文件（那就直接改名过去）
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
  if (buf && !Buffer.isBuffer(buf) && typeof buf.from === "string") {
    placeUpload(fsx, file, buf, false);
    return name;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fsx.writeFileSync(tmp, buf);
  fsx.renameSync(tmp, file);
  return name;
}

/**
 * 请求体原样流进 dir 里一个点开头的临时文件，收齐了返回它的路径，交给 writeUploadFresh / writeUploadReplace 改名。
 *
 * 以前输入框先把文件转成 base64 塞进 JSON：体积胖三分之一、整份进内存，express.json 又卡在 60MB，
 * 于是前端只敢收 30MB。录一段屏就两三百兆，拖进来直接被拒（2026-10-08，一段 241MB 的录屏）。
 *
 * - 临时文件放在目标目录里，不放系统临时目录：工作目录可能在外置盘上，跨盘 rename 会 EXDEV
 * - 点开头的名字，列目录、「本回合产出」对账都跳过，收到一半不会被当成文件露脸
 * - 先看磁盘还剩多少：放不下就不开始写。写到一半才 ENOSPC 的话，整块盘已经被填满了，别的程序跟着出错
 * - 收到的字节数跟 Content-Length 对不上（传到一半断了）就删掉临时文件、报错，不留半截
 * @param {import("stream").Readable & { headers?: Record<string, string | string[] | undefined> }} req
 * @param {string} dir
 * @param {{ fs?: typeof fs }} [o]
 * @returns {Promise<string>}
 */
async function receiveUploadToTemp(req, dir, o = {}) {
  const fsx = o.fs || fs;
  fsx.mkdirSync(dir, { recursive: true });
  const want = Number((req.headers || {})["content-length"]);
  const known = Number.isFinite(want) && want >= 0;
  if (known && typeof fsx.statfsSync === "function") {
    let free = Infinity;
    try { const st = fsx.statfsSync(dir); free = st.bavail * st.bsize; } catch {} // 查不了就不拦，照写
    if (want > free) throw new Error(`磁盘只剩 ${mb(free)}，放不下这个 ${mb(want)} 的文件`);
  }
  const tmp = path.join(dir, `.upload-${process.pid}-${crypto.randomBytes(6).toString("hex")}.part`);
  try {
    await pipeline(req, fsx.createWriteStream(tmp, { flags: "wx" }));
    const got = fsx.statSync(tmp).size;
    if (known && got !== want) throw new Error(`只收到 ${mb(got)}，文件有 ${mb(want)}，没传完`);
    return tmp;
  } catch (e) {
    try { fsx.unlinkSync(tmp); } catch {}
    throw e;
  }
}
/** 人看的体积：报错里要说清是差了多少 */
function mb(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} 字节`;
}

module.exports = { uploadCandidate, writeUploadFresh, uploadIsCandidate, writeUploadReplace, receiveUploadToTemp };
