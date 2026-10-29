// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs"), path = require("path"), { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
function legacySheetsCore(file) {
  const XLSX = require(path.resolve(__dirname, "../../../public/vendor/sheetjs/xlsx.full.min.js"));
  if (fs.statSync(file).size > 50 * 1024 * 1024) throw Error("旧版表格预览支持 50 MB 以内的文件");
  const book = XLSX.read(fs.readFileSync(file), { type: "buffer", cellStyles: true, cellNF: true, bookVBA: false, sheets: undefined });
  const sheets = []; let chars = 0;
  for (const name of book.SheetNames.slice(0, 20)) {
    const sh = book.Sheets[name], range = sh["!ref"] ? XLSX.utils.decode_range(sh["!ref"]) : { e: { r: 0, c: 0 } };
    const totalRows = range.e.r + 1, totalCols = range.e.c + 1, nr = Math.min(totalRows, 2000), nc = Math.min(totalCols, 60), rows = [];
    for (let r = 0; r < nr; r++) {
      if (chars > 2 * 1024 * 1024) break;
      const row = [];
      for (let c = 0; c < nc; c++) {
        const cell = sh[XLSX.utils.encode_cell({ r, c })];
        const value = cell ? String(cell.w ?? (cell.f && cell.v == null ? "=" + cell.f : XLSX.utils.format_cell(cell))).slice(0, 20000) : "";
        row.push(value); chars += value.length;
      }
      rows.push(row);
    }
    const heights = {};
    (sh["!rows"] || []).forEach((row, i) => { if (row) heights[i + 1] = { height: row.hpt || (row.hpx ? row.hpx * .75 : 15), hidden: !!row.hidden }; });
    sheets.push({ name, rows, totalRows, totalCols, truncated: totalRows > rows.length || totalCols > nc,
      layout: { styles: {}, heights, columns: Array.from({ length: nc }, (_, i) => ({ width: sh["!cols"]?.[i]?.wch || 10, hidden: !!sh["!cols"]?.[i]?.hidden })),
        merges: (sh["!merges"] || []).filter(m => m.s.r < rows.length && m.s.c < nc).map(m => ({ top: m.s.r + 1, left: m.s.c + 1, bottom: Math.min(rows.length, m.e.r + 1), right: Math.min(nc, m.e.c + 1) })) } });
  }
  return { kind: "sheet", sheets, total: book.SheetNames.length, truncated: book.SheetNames.length > sheets.length };
}
let active = 0;
async function legacySheets(file) {
  if (active >= 2) throw Error("正在读取其他表格，请稍后再试"); active++;
  try { return await new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { job: "legacy-sheets", file }, resourceLimits: { maxOldGenerationSizeMb: 384 } }); let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(Error("表格读取超时")), 45000);
    worker.once("message", data => data.error ? finish(Error(data.error)) : finish(null, data));
    worker.once("error", () => finish(Error("表格过大、已损坏或暂不支持")));
    worker.once("exit", () => { if (!done) finish(Error("表格读取进程提前退出")); });
  }); } finally { active--; }
}
if (!isMainThread && workerData?.job === "legacy-sheets") { try { parentPort.postMessage(legacySheetsCore(workerData.file)); } catch (error) { parentPort.postMessage({ error: error.message }); } }
module.exports = { legacySheets, legacySheetsCore };
