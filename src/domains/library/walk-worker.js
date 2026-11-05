// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 后台线程里走工作区（ws-index.js 按路径起它，别 require）。
 * 走树是几万次同步 stat，放主线程上那段时间所有对话的流式输出和接口一起停。
 */
const { parentPort } = require("worker_threads");
const wsBrowse = require("./ws-browse");

if (parentPort) {
  parentPort.on("message", (m) => {
    try {
      const r = wsBrowse.walkAll(m.root, m.opts);
      parentPort.postMessage({ id: m.id, files: r.files, capped: r.capped });
    } catch (e) {
      parentPort.postMessage({ id: m.id, error: String((e && e.message) || e) });
    }
  });
}
