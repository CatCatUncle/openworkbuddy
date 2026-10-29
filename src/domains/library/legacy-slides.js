// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
// MS-PPT 2.1.2: follow the current edit's persist directory, then the live slide
// list. Scanning every text atom would resurrect text deleted in earlier edits.
const fs = require("fs"), path = require("path"), { pathToFileURL } = require("url");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
async function legacySlidesCore(file) {
  if (fs.statSync(file).size > 50 * 1024 * 1024) throw Error("旧版 PPT 文字预览支持 50 MB 以内的文件");
  const { parseCFB } = await import(pathToFileURL(path.resolve(__dirname, "../../../public/vendor/msdoc/core/cfb.js")).href);
  const cfb = parseCFB(fs.readFileSync(file));
  const main = cfb.findByName("PowerPoint Document"), current = cfb.findByName("Current User");
  if (!main || !current) throw Error("不是可识别的旧版 PowerPoint 文件，请在原软件中另存为 PPTX");
  const bytes = Buffer.from(cfb.getStream(main)), user = Buffer.from(cfb.getStream(current));
  if (user.length < 20 || user.readUInt32LE(12) === 0xf3d1c4df) throw Error("PPT 索引无效或文件已加密，请先在有权限的原软件中解锁");
  let edit = user.readUInt32LE(16), docId = 0; const offsets = new Map(), edits = new Set();
  const record = pos => {
    if (pos < 0 || pos + 8 > bytes.length) throw Error("PPT 记录边界无效");
    const length = bytes.readUInt32LE(pos + 4), flags = bytes.readUInt16LE(pos);
    if (length > bytes.length - pos - 8) throw Error("PPT 记录已损坏");
    return { type: bytes.readUInt16LE(pos + 2), version: flags & 15, instance: flags >>> 4, start: pos + 8, end: pos + 8 + length };
  };
  while (edit) {
    if (edits.has(edit) || edits.size > 128) throw Error("PPT 编辑索引异常"); edits.add(edit);
    const e = record(edit); if (e.type !== 4085 || e.end - e.start < 24) throw Error("PPT 当前编辑索引不支持");
    if (!docId) docId = bytes.readUInt32LE(e.start + 16);
    const dir = record(bytes.readUInt32LE(e.start + 12)); if (![6001, 6002].includes(dir.type)) throw Error("PPT 对象索引不支持");
    for (let pos = dir.start; pos + 4 <= dir.end;) {
      const packed = bytes.readUInt32LE(pos); pos += 4; const id = packed & 0xfffff, count = packed >>> 20;
      if (!count || count * 4 > dir.end - pos) throw Error("PPT 对象索引已损坏");
      for (let i = 0; i < count; i++, pos += 4) if (!offsets.has(id + i)) offsets.set(id + i, bytes.readUInt32LE(pos));
    }
    edit = bytes.readUInt32LE(e.start + 8);
  }
  if (!offsets.has(docId)) throw Error("找不到 PPT 当前文档对象");
  const doc = record(offsets.get(docId)); if (doc.type !== 1000) throw Error("PPT 文档对象无效");
  let list;
  for (let pos = doc.start; pos < doc.end;) { const r = record(pos); if (r.end > doc.end) throw Error("PPT 子记录边界无效"); if (r.type === 4080 && r.instance === 0) list = r; pos = r.end; }
  if (!list) throw Error("PPT 中没有可提取的幻灯片列表");
  let budget = 0;
  const textOf = r => r.type === 4000 ? bytes.subarray(r.start, r.end).toString("utf16le") : new TextDecoder("windows-1252").decode(bytes.subarray(r.start, r.end));
  const collect = (r, out, depth = 0) => {
    if (depth > 24 || ++budget > 100000) throw Error("PPT 内容超出解析预算");
    if ([4000, 4008].includes(r.type)) { const text = textOf(r).replace(/[\u0000-\u0008\u000b\u000c]/g, "").trim(); if (text) out.push(text.slice(0, 20000)); return; }
    if (r.version !== 15 && r.type !== 0xf00d) return;
    for (let pos = r.start; pos < r.end;) { const child = record(pos); if (child.end > r.end) throw Error("PPT 文本边界无效"); collect(child, out, depth + 1); pos = child.end; }
  };
  const items = []; let item;
  for (let pos = list.start; pos < list.end;) {
    const r = record(pos); if (r.end > list.end) throw Error("PPT 幻灯片列表无效");
    if (r.type === 1011 && r.end - r.start >= 4) { item = { ref: bytes.readUInt32LE(r.start), text: [] }; items.push(item); }
    else if (item) collect(r, item.text); pos = r.end;
  }
  const slides = items.slice(0, 300).map((item, i) => {
    if (offsets.has(item.ref)) { const more = []; collect(record(offsets.get(item.ref)), more); for (const text of more) if (!item.text.includes(text)) item.text.push(text); }
    const lines = item.text.flatMap(t => t.split(/\r\n?|\n/)).filter(Boolean), title = lines.shift() || "";
    return { n: i + 1, title, lines: lines.map(s => ({ lvl: 0, s })), notes: "" };
  });
  if (!slides.length) throw Error("PPT 中没有可读取的幻灯片");
  return { kind: "slides", slides, total: items.length, truncated: items.length > slides.length,
    compatibility: "旧版 PPT 文字预览：图片、图表和原版式未还原。需要原版式时，可使用本机兼容引擎或另存为 PPTX。" };
}
async function legacySlides(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { job: "legacy-ppt", file }, resourceLimits: { maxOldGenerationSizeMb: 256 } }); let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(Error("旧版 PPT 读取超时")), 45000);
    worker.once("message", data => data.error ? finish(Error(data.error)) : finish(null, data)); worker.once("error", e => finish(e));
    worker.once("exit", () => { if (!done) finish(Error("旧版 PPT 读取进程提前退出")); });
  });
}
if (!isMainThread && workerData?.job === "legacy-ppt") legacySlidesCore(workerData.file).then(data => parentPort.postMessage(data), error => parentPort.postMessage({ error: error.message }));
module.exports = { legacySlides, legacySlidesCore };
