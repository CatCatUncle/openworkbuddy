// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs"), path = require("path"), { pathToFileURL } = require("url");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const ROOT = path.resolve(__dirname, "../../..");
const FORMATS = /\.(doc|dot|docx|docm|dotx|dotm|wps|wpt|rtf|odt|ppt|pptx|pptm|ppsx|dps|dpt|odp|xls|xlsx|xlsm|xltx|et|ett|ods|pdf|ofd|ceb|cebx|html?|md|markdown|txt|csv|tsv)$/i;
const safe = text => String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const table = rows => {
  if (!rows.length) return "";
  const n = Math.max(...rows.map(r => r.length)), line = r => "| " + Array.from({ length: n }, (_, i) => safe(r[i]).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")).join(" | ") + " |";
  return [line(rows[0]), "| " + Array(n).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
};
function structuredMarkdown(data, warnings) {
  if (data.compatibility) warnings.push(data.compatibility);
  if (data.truncated) warnings.push("文档超过预览解析上限，本次结果已截断。");
  const runs = values => (values || []).map(r => safe(r.s)).join("");
  if (data.kind === "doc") return (data.blocks || []).map(b => {
    if (b.t === "table") return table((b.rows || []).map(row => row.map(c => (c.runs || []).map(r => r.s || "").join(""))));
    if (b.t === "img") { warnings.push("内嵌图片未导出，请结合原文件阅读。"); return "[原文档内嵌图片]"; }
    return (b.t === "h" ? "#".repeat(Math.min(6, Math.max(1, b.lvl || 1))) + " " : b.t === "li" ? "  ".repeat(b.lvl || 0) + (b.ord ? "1. " : "- ") : "") + runs(b.runs);
  }).join("\n\n");
  if (data.kind === "sheet") return data.sheets.map(sh => {
    if (sh.truncated) warnings.push("工作表「" + sh.name + "」已截断（最多 2000 行、60 列）。");
    return "## 工作表：" + safe(sh.name) + "\n\n" + table(sh.rows);
  }).join("\n\n");
  if (data.kind === "slides") return data.slides.map(s => "## 第 " + s.n + " 页" + (s.title ? "：" + safe(s.title) : "") + "\n\n" + (s.lines || []).map(l => "  ".repeat(l.lvl || 0) + "- " + safe(l.s)).join("\n") + (s.notes ? "\n\n备注：" + safe(s.notes) : "")).join("\n\n");
  throw Error("这个文件暂时无法转换为 Markdown");
}
function htmlMarkdown(text) {
  const { parseXml, textOf } = require("./preview");
  const root = parseXml(text), children = n => (n.children || []).filter(x => typeof x !== "string");
  const walk = n => {
    if (typeof n === "string") return safe(n);
    const tag = n.name.toLowerCase();
    if (["style", "script", "head", "iframe", "object", "noscript"].includes(tag)) return "";
    if (tag === "table") {
      const rows = [];
      const collect = node => { for (const c of children(node)) if (c.name.toLowerCase() === "tr") rows.push(children(c).filter(x => /^(td|th)$/i.test(x.name)).map(x => textOf(x))); else collect(c); };
      collect(n); return "\n\n" + table(rows) + "\n\n";
    }
    if (tag === "pre") return "\n\n~~~~\n" + textOf(n) + "\n~~~~\n\n";
    if (tag === "br") return "\n";
    const body = (n.children || []).map(walk).join("");
    if (/^h[1-6]$/.test(tag)) return "\n\n" + "#".repeat(Number(tag[1])) + " " + body.trim() + "\n\n";
    if (tag === "li") return "\n- " + body.trim();
    if (["p", "div", "section", "article", "body"].includes(tag)) return "\n\n" + body.trim() + "\n\n";
    return body;
  };
  return walk(root).replace(/\n{3,}/g, "\n\n").trim();
}
async function pdfMarkdown(file, warnings) {
  // Rendering/canvas is never enabled; the same bundled PDF.js text engine runs
  // inside this bounded worker, with scripting and eval disabled.
  if (Number(process.versions.node.split(".")[0]) < 22) throw Error("PDF 内置文字提取需要 Node.js 22 及以上；桌面安装版已自带对应运行时。");
  const pdf = await import(pathToFileURL(path.join(ROOT, "public/vendor/pdf/pdf.mjs")).href);
  const task = pdf.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useWasm: false,
    disableFontFace: true, verbosity: 0, cMapPacked: true, cMapUrl: path.join(ROOT, "public/vendor/pdf/cmaps") + path.sep });
  let doc;
  try {
    doc = await task.promise; const out = [], count = Math.min(doc.numPages, 300);
    if (count < doc.numPages) warnings.push("PDF 超过 300 页，本次结果已截断。");
    for (let i = 1; i <= count; i++) {
      const page = await doc.getPage(i), data = await page.getTextContent(); let line = "", y = null; const lines = [];
      for (const item of data.items) {
        if (typeof item.str !== "string") continue;
        if (y !== null && Math.abs(item.transform[5] - y) > Math.max(3, (item.height || 10) * .6)) { lines.push(line); line = ""; }
        line += item.str; y = item.transform[5];
        if (item.hasEOL) { lines.push(line); line = ""; y = null; }
      }
      if (line) lines.push(line); const text = lines.join("\n").trim();
      if (!text) warnings.push("第 " + i + " 页没有可提取文字，可能为扫描页，需要 OCR。");
      out.push("## 第 " + i + " 页\n\n" + (safe(text) || "[本页无可提取文字，需要 OCR]")); page.cleanup();
    }
    return out.join("\n\n");
  } catch (error) { throw Error(/password/i.test(error.name || "") ? "PDF 已加密，请先用有权限的阅读器解锁" : "PDF 文字提取失败，文件可能损坏或受保护"); }
  finally { await task.destroy(); }
}
async function convertCore(file, name) {
  const st = fs.statSync(file); if (!st.isFile() || st.size > 50 * 1024 * 1024) throw Error("转 Markdown 支持 50 MB 以内的文件");
  const { previewData, readZip, parseXml, findAll, textOf } = require("./preview");
  const ext = path.extname(name).slice(1).toLowerCase(), warnings = []; let markdown = "";
  if (!FORMATS.test(name)) throw Error("这个格式暂不支持转 Markdown");
  if (ext === "pdf") markdown = await pdfMarkdown(file, warnings);
  else if (ext === "ofd") {
    const zip = readZip(file), entry = parseXml(zip.text("OFD.xml") || "");
    const all = (n, tag) => { const out = []; const walk = x => { for (const c of x.children || []) if (typeof c !== "string") { if (c.name.split(":").pop() === tag) out.push(c); walk(c); } }; walk(n); return out; };
    const docRoot = textOf(all(entry, "DocRoot")[0]).trim(), doc = parseXml(zip.text(docRoot) || "");
    const pages = all(doc, "Page"); if (!pages.length) throw Error("OFD 中没有可读取的页面");
    const out = [];
    for (const [i, page] of pages.slice(0, 300).entries()) {
      const part = path.posix.normalize(path.posix.join(path.posix.dirname(docRoot), page.attrs.BaseLoc || ""));
      if (part.startsWith("../") || part.startsWith("/")) throw Error("OFD 页路径无效");
      const data = parseXml(zip.text(part) || ""), text = all(data, "TextCode").map(node => textOf(node)).join("\n").trim();
      if (!text) warnings.push("OFD 第 " + (i + 1) + " 页没有文字，需要 OCR 或原阅读器核对。");
      out.push("## 第 " + (i + 1) + " 页\n\n" + (safe(text) || "[本页无可提取文字]"));
    }
    if (pages.length > 300) warnings.push("OFD 超过 300 页，本次结果已截断。");
    warnings.push("OFD 签章、验签信息及复杂图形未转换为 Markdown。"); markdown = out.join("\n\n");
  } else if (/^(html?|md|markdown|txt|csv|tsv)$/.test(ext)) {
    const text = fs.readFileSync(file, "utf8"); markdown = /^html?$/.test(ext) ? htmlMarkdown(text) : text;
  } else {
    const compat = require("./office-compat");
    const source = compat.TYPES[ext] ? await compat.officeFile(file, name, { textOnly: true }) : { file, ext, kind: "standard" };
    if (source.kind === "legacy-ppt") markdown = structuredMarkdown(await require("./legacy-slides").legacySlidesCore(source.file), warnings);
    else if (source.kind === "biff") markdown = structuredMarkdown(require("./legacy-sheets").legacySheetsCore(source.file), warnings);
    else if (source.kind === "pdf") markdown = await pdfMarkdown(source.file, warnings);
    else if (source.kind === "html-doc") {
      const bytes = fs.readFileSync(file), head = bytes.subarray(0, 1024).toString("utf8"), encoding = /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] || "utf-8";
      markdown = htmlMarkdown(new TextDecoder(encoding).decode(bytes));
    } else if (source.kind === "msdoc") {
      const { parseMsDoc } = await import(pathToFileURL(path.join(ROOT, "public/vendor/msdoc/msdoc/parser.js")).href);
      const parsed = parseMsDoc(fs.readFileSync(file));
      const block = b => b.type === "table" ? table((b.rows || []).map(row => row.cells.map(cell => cell.paragraphs.map(p => p.text).join(" ")))) : safe(b.text);
      markdown = parsed.blocks.map(block).filter(Boolean).join("\n\n");
      if (parsed.warnings?.length) warnings.push("旧版 DOC 解析有 " + parsed.warnings.length + " 项兼容提示，请结合原文核对。");
    } else markdown = structuredMarkdown(await previewData(source.file, "document." + source.ext), warnings);
  }
  if (markdown.length > 2 * 1024 * 1024) { markdown = markdown.slice(0, 2 * 1024 * 1024); warnings.push("文字超过 2 MB，导出已截断。"); }
  const unique = [...new Set(warnings)];
  const content = "# " + safe(path.basename(name, path.extname(name))) + "\n\n" + markdown.trim() + (unique.length ? "\n\n---\n\n转换说明：\n\n" + unique.map(w => "- " + w).join("\n") : "") + "\n";
  return { name: path.basename(name, path.extname(name)) + ".md", markdown: content, warnings: unique };
}
let active = 0;
async function documentMarkdown(file, name, { signal } = {}) {
  if (active >= 2) throw Error("正在转换其他文档，请稍后再试");
  if (signal?.aborted) throw Error("转换已取消");
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { file, name }, resourceLimits: { maxOldGenerationSizeMb: 384 } });
      let finished = false;
      const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.terminate(); error ? reject(error) : resolve(value); };
      const abort = () => finish(Error("转换已取消"));
      const timer = setTimeout(() => finish(Error("转换超时，请缩小文件或在原软件中另存后重试")), 90000);
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", value => value.error ? finish(Error(value.error)) : finish(null, value));
      worker.once("error", error => finish(Error("文档转换未完成：" + error.message)));
      worker.once("exit", code => { if (!finished) finish(Error("文档转换进程提前退出（" + code + "）")); });
    });
  } finally { active--; }
}
if (!isMainThread) convertCore(workerData.file, workerData.name).then(value => parentPort.postMessage(value), error => parentPort.postMessage({ error: error.message }));
module.exports = { documentMarkdown, convertCore, structuredMarkdown, htmlMarkdown, FORMATS };
