// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), { execFile } = require("child_process");
const { pathToFileURL } = require("url");
const TYPES = {
  doc: "docx", dot: "docx", wps: "docx", wpt: "docx", rtf: "docx", odt: "docx",
  xls: "xlsx", et: "xlsx", ett: "xlsx", ods: "xlsx", xlsm: "xlsx", xltx: "xlsx",
  ppt: "pptx", dps: "pptx", dpt: "pptx", odp: "pptx", pptm: "pptx", ppsx: "pptx",
  ceb: "pdf", cebx: "pdf",
};
const KINDS = { docx: "doc", xlsx: "sheet", pptx: "slides", pdf: "pdf" };
const jobs = new Map(), cache = new Map(); let tail = Promise.resolve();
function officeBinary() {
  const candidates = [process.env.OPENWORKBUDDY_OFFICE_BIN,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    path.join(process.env.ProgramFiles || "C:\\Program Files", "LibreOffice/program/soffice.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "LibreOffice/program/soffice.exe"),
    ...(process.env.PATH || "").split(path.delimiter).map(p => path.join(p, process.platform === "win32" ? "soffice.exe" : "soffice"))];
  return candidates.find(p => p && fs.existsSync(p) && fs.statSync(p).isFile()) || "";
}
async function officeFile(file, name, { textOnly = false } = {}) {
  const ext = path.extname(name).slice(1).toLowerCase(), target = TYPES[ext];
  if (!target) throw Error("这个格式没有兼容预览入口");
  const st = await fs.promises.stat(file);
  if (st.size > 50 * 1024 * 1024) throw Error("兼容预览支持 50 MB 以内的文件");
  const fd = await fs.promises.open(file, "r"), magic = Buffer.alloc(512);
  try { await fd.read(magic, 0, magic.length, 0); } finally { await fd.close(); }
  if (target === "docx") {
    if (magic.readUInt32LE(0) === 0xe011cfd0) return { file, kind: "msdoc", ext: "doc", converted: false };
    if (/<(?:!doctype\s+html|html|head|meta|body)\b/i.test(magic.toString("utf8"))) return { file, kind: "html-doc", ext: "doc", converted: false };
  }
  if (target === "xlsx" && magic.readUInt32LE(0) === 0xe011cfd0) return { file, kind: "biff", ext: "xls", converted: false };
  if (target === "pptx" && magic.readUInt32LE(0) === 0xe011cfd0 && (textOnly || !officeBinary())) return { file, kind: "legacy-ppt", ext: "ppt", converted: false };
  // WPS can store standard OOXML with its own suffix. Route by contents rather
  // than pretending that renaming an old binary document converts it.
  if (magic.readUInt32LE(0) === 0x04034b50 && target !== "pdf") {
    const zip = require("./zip-reader").readZip(file);
    const part = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[target];
    if (zip.has(part)) return { file, kind: KINDS[target], ext: target, converted: false };
  }
  const binary = target === "pdf" ? process.env.OPENWORKBUDDY_CEB_CONVERTER || "" : officeBinary();
  if (!binary) throw Error(target === "pdf"
    ? "CEB/CEBX 需要已授权的本机兼容引擎。当前未配置，可先在原阅读器中导出 PDF 后打开；受保护文件不会绕过权限。"
    : "此格式需要本机兼容引擎。安装 LibreOffice 后重试，或在原软件中另存为 DOCX、XLSX、PPTX。原文件不会被修改。");
  const key = crypto.createHash("sha256").update([file, st.size, st.mtimeMs, binary, target].join("\0")).digest("hex");
  if (cache.has(key) && fs.existsSync(cache.get(key).file)) return cache.get(key);
  if (jobs.has(key)) return jobs.get(key);
  if (jobs.size >= 8) throw Error("正在处理其他兼容预览，请稍后重试");
  const run = tail.catch(() => {}).then(async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "owb-office-"));
    try {
      const input = path.join(dir, "input." + ext), output = path.join(dir, "input." + target);
      await fs.promises.copyFile(file, input);
      const profile = path.join(dir, "profile"), user = path.join(profile, "user");
      await fs.promises.mkdir(user, { recursive: true });
      await fs.promises.writeFile(path.join(user, "registrymodifications.xcu"), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLinksMode" oor:op="fuse"><value>0</value></prop></item></oor:items>');
      const args = target === "pdf" ? [input, output] : ["-env:UserInstallation=" + pathToFileURL(profile).href, "--headless", "--norestore", "--nodefault", "--nolockcheck", "--convert-to", target, "--outdir", dir, input];
      await new Promise((resolve, reject) => execFile(binary, args, { cwd: dir, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true }, error => error ? reject(Error("兼容转换未完成，文件可能受保护、已损坏或格式暂不支持")) : resolve()));
      const result = await fs.promises.stat(output).catch(() => null);
      if (!result?.size || result.size > 50 * 1024 * 1024) throw Error("兼容引擎未生成可预览文件，请在原软件中导出新版 Office 文件或 PDF");
      if (target === "pdf") {
        const header = Buffer.alloc(5), handle = await fs.promises.open(output, "r");
        try { await handle.read(header, 0, 5, 0); } finally { await handle.close(); }
        if (header.toString() !== "%PDF-") throw Error("兼容引擎没有返回有效的 PDF 文件");
      }
      const value = { file: output, kind: KINDS[target], ext: target, converted: true, temp: dir };
      cache.set(key, value);
      while (cache.size > 16) { const oldest = cache.keys().next().value; const old = cache.get(oldest); cache.delete(oldest); fs.promises.rm(old.temp, { recursive: true, force: true }).catch(() => {}); }
      return value;
    } catch (error) { await fs.promises.rm(dir, { recursive: true, force: true }); throw error; }
  });
  tail = run.then(() => {}, () => {}); jobs.set(key, run);
  try { return await run; } finally { jobs.delete(key); }
}
process.once("exit", () => { for (const value of cache.values()) { try { fs.rmSync(value.temp, { recursive: true, force: true }); } catch {} } });
module.exports = { officeFile, officeBinary, TYPES };
