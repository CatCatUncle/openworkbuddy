// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 缩图线程。thumb.js 起一小撮，专门跑 thumb-png.js 那段纯 JS 的解码+缩放。
 *
 * 为什么非要另起线程：inflate 和 deflate 是 zlib 的 C++，可**解滤波和取平均那一段是 JS**，
 * 实测一张 2360×3720 的图要跑掉 209 ms。这台服务器同时在推 SSE——对话是一个字一个字
 * 送下去的，主线程被占住 209 ms，用户看到的就是字卡住不动。一屏产出卡能有八张图，
 * 排着队做就是一秒多的停顿，比不做缩略图还难受。
 *
 * 图直接由线程写盘，回主线程的只有一个 ok：85 KB 的 Buffer 跨 postMessage 要复制一遍，
 * 写盘那一下也是阻塞 I/O，两样都留在这边做，主线程只管发文件。
 */
const fs = require("fs");
const path = require("path");
const { parentPort } = require("worker_threads");
const { shrinkPng, encodeRaw } = require("../../util/thumb-png");

parentPort.on("message", (job) => {
  // 主进程截完图送来的原始像素（htmlshot.js）：编成 PNG 原路送回，不落盘。
  // 送回用转交（transfer）不复制：一张 2 倍屏整页的 PNG 能有几 MB，复制那一下又落回界面线程
  if (job && job.kind === "raw") {
    let png = null;
    try { png = encodeRaw(job.px, job.w, job.h, job.o || {}); } catch { png = null; }
    const whole = png && png.byteOffset === 0 && png.buffer.byteLength === png.length;
    parentPort.postMessage({ id: job.id, ok: !!png, png }, whole ? [/** @type {ArrayBuffer} */ (png.buffer)] : []);
    return;
  }
  let ok = false;
  try {
    const png = shrinkPng(fs.readFileSync(job.file), job.w);
    if (png && png.length) {
      fs.mkdirSync(path.dirname(job.out), { recursive: true });
      // 先写临时名再改名：同一张图被两个请求同时点到时，sendFile 不会读到只写了一半的文件
      const tmp = job.out + "." + process.pid + "." + job.id + ".part";
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, job.out);
      ok = true;
    }
  } catch {
    ok = false; // 缩不出来不是错——调用方原样发原图，跟没有缩略图那天一样
  }
  parentPort.postMessage({ id: job.id, ok });
});
