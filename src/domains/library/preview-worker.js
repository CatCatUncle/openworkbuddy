// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const queue = []; let active = 0;
function previewWorker(file, name, opts = {}) {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(Error("预览已取消"));
    if (queue.length >= 16) return reject(Error("正在读取其他文件，请稍后重试"));
    const item = { file, name, layout: !!opts.layout, signal: opts.signal, resolve, reject, started: false, canceled: false };
    const abort = () => { if (!item.started) { item.canceled = true; const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); item.unlisten(); reject(Error("预览已取消")); } };
    item.unlisten = () => item.signal?.removeEventListener("abort", abort);
    item.signal?.addEventListener("abort", abort, { once: true }); queue.push(item); dispatch();
  });
}
function dispatch() {
  while (active < 2 && queue.length) {
    const item = queue.shift(); item.unlisten(); if (item.canceled || item.signal?.aborted) continue;
    item.started = true; active++;
    let worker;
    try { worker = new Worker(__filename, { workerData: { job: "preview", file: item.file, name: item.name, layout: item.layout }, resourceLimits: { maxOldGenerationSizeMb: 384 } }); }
    catch { active--; item.reject(Error("文档读取进程无法启动")); continue; }
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); item.signal?.removeEventListener("abort", abort); worker.terminate(); active--; error ? item.reject(error) : item.resolve(value); dispatch(); };
    const abort = () => finish(Error("预览已取消"));
    const timer = setTimeout(() => finish(Error("文档读取超时，请用原应用检查文件")), 60000);
    item.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", data => data.error ? finish(Error(data.error)) : finish(null, data));
    worker.once("error", () => finish(Error("文档过大、已损坏或超出读取预算")));
    worker.once("exit", () => { if (!done) finish(Error("文档读取进程提前退出")); });
  }
}
if (!isMainThread && workerData?.job === "preview") require("./preview-core").previewData(workerData.file, workerData.name, { layout: workerData.layout }).then(data => parentPort.postMessage(data), error => parentPort.postMessage({ error: error.message }));
module.exports = { previewWorker };
