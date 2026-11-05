// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 各账号占了多少磁盘，以及超没超配额。
 *
 * 量一个工作目录要走完全部文件，上万文件时是秒级，不能挡在上传和发任务的路上。
 * 所以量的结果缓存起来，判配额只看缓存，过期就在后台重量，下一次才用新数。
 * 配额是提醒性质的闸门：任务跑到一半写爆了不会被截断，只是下一次上传和发任务被拦。
 */
const fs = require("fs");
const path = require("path");

const FRESH_MS = 10 * 60 * 1000;
const MAX_FILES = 500000;

const memo = new Map();

/** 走完一个目录。不跟软链，读不了的跳过。每批让出事件循环，别把请求卡住 */
async function dirSize(root) {
  const stack = [root];
  let bytes = 0, files = 0, truncated = false;
  while (stack.length) {
    if (files >= MAX_FILES) { truncated = true; break; }
    const dir = stack.pop();
    let items;
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) {
        try { bytes += (await fs.promises.stat(full)).size; files += 1; } catch {}
      }
    }
  }
  return { bytes, files, truncated };
}

/** 缓存的量；没量过或过期了就起一趟后台，这次先回手上有的 */
function cached(dir, { now = Date.now() } = {}) {
  const row = memo.get(dir);
  if ((!row || now - row.at > FRESH_MS) && !(row && row.pending)) {
    const next = { ...(row || { bytes: 0, files: 0, at: 0 }), pending: true };
    memo.set(dir, next);
    dirSize(dir).then((size) => memo.set(dir, { ...size, at: Date.now(), pending: false }), () => memo.set(dir, { ...next, pending: false }));
  }
  return memo.get(dir);
}

/** 现量，给后台页面用 */
async function measure(dir) {
  const size = await dirSize(dir);
  memo.set(dir, { ...size, at: Date.now(), pending: false });
  return size;
}

/** 超了配额返回一句话，没超返回空串。mb 为 0 或没设就是不限 */
function quotaProblem(dir, mb) {
  const limit = Number(mb) || 0;
  if (limit <= 0 || !dir) return "";
  const row = cached(dir);
  return row.bytes > limit * 1048576 ? `你的工作目录已用 ${Math.round(row.bytes / 1048576)} MB，超过 ${limit} MB 的配额。清理文件后再试，或联系管理员。` : "";
}

function forget() { memo.clear(); }

module.exports = { dirSize, cached, measure, quotaProblem, forget };
