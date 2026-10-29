// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-document-workflow-"));
process.env.OPENWORKBUDDY_HOME = home;
const { documentMarkdown } = require("../src/domains/library/document-markdown");
const { officeFile } = require("../src/domains/library/office-compat");
const { previewData } = require("../src/domains/library/preview");
function pdfFixture(chinese = false) {
  const stream = chinese ? "BT /F1 18 Tf 72 720 Td <56FD4F01516C6587> Tj ET" : "BT /F1 18 Tf 72 720 Td (Quarterly report) Tj ET", chunks = ["%PDF-1.4\n"], offsets = [0];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Length " + Buffer.byteLength(stream) + " >>\nstream\n" + stream + "\nendstream"];
  if (chinese) {
    objects[3] = "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>";
    objects.push("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>");
  }
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(chunks.join(""))); chunks.push(`${i + 1} 0 obj\n${object}\nendobj\n`); }
  const xref = Buffer.byteLength(chunks.join("")); chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => String(n).padStart(10, "0") + " 00000 n \n").join(""));
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`); return Buffer.from(chunks.join(""));
}
(async () => {
  try {
    const { Document, Packer, Paragraph, HeadingLevel } = require("docx");
    const word = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: "第一章", heading: HeadingLevel.HEADING_1 }), new Paragraph("文档正文内容")] }] }));
    const docx = path.join(home, "报告.docx"); fs.writeFileSync(docx, word);
    const md = await documentMarkdown(docx, "报告.docx"); assert(md.markdown.includes("# 第一章") && md.markdown.includes("文档正文内容"));
    const doc = path.join(home, "源程序.doc"); fs.writeFileSync(doc, '<html><head><meta charset="utf-8"><style>body{color:red}</style></head><body><h1>源程序</h1><p>这是正文</p><script>evil()</script><table><tr><th>姓名</th><th>部门</th></tr><tr><td>张三</td><td>办公室</td></tr></table></body></html>');
    assert.strictEqual((await officeFile(doc, "源程序.doc")).kind, "html-doc");
    const html = await documentMarkdown(doc, "源程序.doc"); assert(html.markdown.includes("源程序") && html.markdown.includes("| 姓名 | 部门 |") && !html.markdown.includes("evil()"));
    const wps = path.join(home, "材料.wps"); fs.writeFileSync(wps, word); assert.strictEqual((await officeFile(wps, "材料.wps")).kind, "doc");
    assert((await documentMarkdown(wps, "材料.wps")).markdown.includes("文档正文内容"));
    const Excel = require("exceljs"), book = new Excel.Workbook(), sheet = book.addWorksheet("明细");
    sheet.columns = [{ width: 28 }, { width: 18 }]; sheet.addRow(["名称", "金额"]); sheet.addRow(["材料", 120]); sheet.getCell("A1").font = { bold: true, color: { argb: "FF2244AA" } }; sheet.mergeCells("A3:B3"); sheet.getCell("A3").value = "合并标题";
    const xlsx = path.join(home, "报表.xlsx"); await book.xlsx.writeFile(xlsx);
    const layout = await previewData(xlsx, "报表.xlsx"); assert.strictEqual(layout.sheets[0].layout.columns[0].width, 28); assert(layout.sheets[0].layout.styles["1,1"].bold); assert.strictEqual(layout.sheets[0].layout.merges[0].right, 2);
    assert((await documentMarkdown(xlsx, "报表.xlsx")).markdown.includes("| 名称 | 金额 |"));
    const XLSX = require("../public/vendor/sheetjs/xlsx.full.min.js"), legacy = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(legacy, XLSX.utils.aoa_to_sheet([["单位", "数额"], ["国企材料", 88]]), "预算");
    for (const suffix of ["xls", "et"]) {
      const file = path.join(home, "预算." + suffix); fs.writeFileSync(file, XLSX.write(legacy, { bookType: "biff8", type: "buffer" }));
      assert.strictEqual((await officeFile(file, path.basename(file))).kind, "biff");
      assert((await previewData(file, path.basename(file))).sheets[0].rows[1][0] === "国企材料");
      assert((await documentMarkdown(file, path.basename(file))).markdown.includes("国企材料"));
    }
    const Pptx = require("pptxgenjs"), slides = new Pptx(); slides.addSlide().addText("年度汇报", { x: 1, y: 1, w: 5, h: 1 });
    const pptx = path.join(home, "汇报.pptx"); await slides.writeFile({ fileName: pptx }); assert((await documentMarkdown(pptx, "汇报.pptx")).markdown.includes("年度汇报"));
    const record = (type, body, version = 0) => { const head = Buffer.alloc(8); head.writeUInt16LE(version, 0); head.writeUInt16LE(type, 2); head.writeUInt32LE(body.length, 4); return Buffer.concat([head, body]); };
    const persist = Buffer.alloc(20); persist.writeUInt32LE(2);
    const list = record(4080, Buffer.concat([record(1011, persist), record(4000, Buffer.from("报告标题", "utf16le"))]), 15);
    const docRecord = record(1000, list, 15), slideRecord = record(1006, record(4000, Buffer.from("当前页正文", "utf16le")), 15), deleted = record(4000, Buffer.from("已删除旧文本", "utf16le"));
    const directory = Buffer.alloc(12); directory.writeUInt32LE((2 << 20) | 1); directory.writeUInt32LE(0, 4); directory.writeUInt32LE(docRecord.length, 8);
    const directoryRecord = record(6002, directory), dirAt = docRecord.length + slideRecord.length + deleted.length;
    const editBody = Buffer.alloc(28); editBody.writeUInt32LE(dirAt, 12); editBody.writeUInt32LE(1, 16); const editRecord = record(4085, editBody);
    const userBody = Buffer.alloc(24); userBody.writeUInt32LE(0xe391c05f, 4); userBody.writeUInt32LE(dirAt + directoryRecord.length, 8);
    const cfb = XLSX.CFB.utils.cfb_new(); XLSX.CFB.utils.cfb_add(cfb, "PowerPoint Document", Buffer.concat([docRecord, slideRecord, deleted, directoryRecord, editRecord])); XLSX.CFB.utils.cfb_add(cfb, "Current User", record(4086, userBody));
    const ppt = path.join(home, "旧汇报.ppt"); fs.writeFileSync(ppt, XLSX.CFB.write(cfb, { type: "buffer" }));
    const oldSlide = await previewData(ppt, "旧汇报.ppt"); assert.strictEqual(oldSlide.slides[0].title, "报告标题"); assert(oldSlide.slides[0].lines.some(l => l.s.includes("当前页正文")));
    const pptMD = await documentMarkdown(ppt, "旧汇报.ppt"); assert(pptMD.markdown.includes("当前页正文") && !pptMD.markdown.includes("已删除旧文本") && pptMD.warnings.length);
    const pdf = path.join(home, "报告.pdf"); fs.writeFileSync(pdf, pdfFixture()); const pdfMD = await documentMarkdown(pdf, "报告.pdf"); assert(pdfMD.markdown.includes("Quarterly report"));
    const JSZip = require("jszip"), ofd = new JSZip();
    ofd.file("OFD.xml", '<o:OFD><o:DocBody><o:DocRoot>Doc/Document.xml</o:DocRoot></o:DocBody></o:OFD>');
    ofd.file("Doc/Document.xml", '<o:Document><o:Pages><o:Page BaseLoc="Pages/1.xml"/></o:Pages></o:Document>');
    ofd.file("Doc/Pages/1.xml", '<o:Page><o:Content><o:TextObject><o:TextCode>国企公文正文</o:TextCode></o:TextObject></o:Content></o:Page>');
    const ofdFile = path.join(home, "公文.ofd"); fs.writeFileSync(ofdFile, await ofd.generateAsync({ type: "nodebuffer" }));
    const ofdMD = await documentMarkdown(ofdFile, "公文.ofd"); assert(ofdMD.markdown.includes("国企公文正文") && ofdMD.warnings.some(w => w.includes("签章")));
    ofd.file("OFD.xml", '<o:OFD><o:DocBody><o:DocRoot>/Doc/Document.xml</o:DocRoot></o:DocBody></o:OFD>');
    ofd.file("Doc/Document.xml", '<o:Document><o:Pages><o:Page BaseLoc="/Doc/Pages/1.xml"/></o:Pages></o:Document>');
    fs.writeFileSync(ofdFile, await ofd.generateAsync({ type: "nodebuffer" }));
    assert((await documentMarkdown(ofdFile, "根路径.ofd")).markdown.includes("国企公文正文"), "archive-root references are valid OFD paths");
    ofd.file("Doc/Document.xml", '<o:Document><o:Pages><o:Page BaseLoc="../../outside.xml"/></o:Pages></o:Document>');
    fs.writeFileSync(ofdFile, await ofd.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(documentMarkdown(ofdFile, "越界.ofd"), /越界/);
    ofd.file("Doc/Document.xml", '<o:Document><o:Pages><o:Page BaseLoc="Pages/missing.xml"/></o:Pages></o:Document>');
    fs.writeFileSync(ofdFile, await ofd.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(documentMarkdown(ofdFile, "缺页.ofd"), /页面数据缺失/);
    const { structuredMarkdown } = require("../src/domains/library/document-markdown");
    assert(structuredMarkdown({ kind: "doc", blocks: [{ t: "table", rows: [[{ runs: [{ s: "A&B<C>" }] }]] }] }, []).includes("A&amp;B&lt;C&gt;"));
    const { cliProject } = require("../src/cli/project-owner");
    const projects = [{ name: "父项目", dir: home }, { name: "子项目", dir: path.join(home, "nested") }]; fs.mkdirSync(projects[1].dir);
    assert.strictEqual(cliProject({ projects, cwd: path.join(home, "nested", "sub") }).project, "子项目");
    assert.strictEqual(cliProject({ projects, cwd: os.tmpdir() }).project_unassigned, true);
    assert.strictEqual(cliProject({ projects, cwd: os.tmpdir(), explicit: "父项目" }).project, "父项目");
    assert.throws(() => cliProject({ projects, cwd: home, explicit: "不存在" }), /找不到项目/);
    assert.strictEqual(cliProject({ projects, cwd: projects[1].dir, existing: { history: [{}], project: "父项目" } }).project, "父项目");
    assert.throws(() => cliProject({ projects, cwd: home, explicit: "子项目", existing: { transcript: [{}], project: "父项目" } }), /保留原项目/);
    const { launcher } = require("../src/desktop/cli-install");
    assert(launcher({ platform: "darwin", executable: "/app/node", cli: "/app/cli.js", dataHome: "/custom/user data" }).includes("OPENWORKBUDDY_HOME='/custom/user data'"));
    assert(launcher({ platform: "win32", executable: "C:\\app.exe", cli: "C:\\cli.js", dataHome: "C:\\custom data" }).includes('OPENWORKBUDDY_HOME=C:\\custom data"'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(previewData(xlsx, "报表.xlsx", { signal: controller.signal }), /取消/);
    const rapid = Array.from({ length: 12 }, () => { const c = new AbortController(); const p = previewData(pptx, "汇报.pptx", { signal: c.signal }); c.abort(); return p; });
    assert((await Promise.allSettled(rapid)).every(result => result.status === "rejected"));
    assert((await previewData(xlsx, "报表.xlsx")).sheets.length === 1, "cancellation does not block later previews");
    assert(fs.readFileSync(docx).equals(word), "conversion preserves the original file");
    const chinesePDF = path.join(home, "中文.pdf"); fs.writeFileSync(chinesePDF, pdfFixture(true));
    assert((await documentMarkdown(chinesePDF, "中文.pdf")).markdown.includes("国企公文"), "bundled CMaps preserve Chinese text");
    const ceb = path.join(home, "公文.ceb"); fs.writeFileSync(ceb, "CEB1test"); await assert.rejects(documentMarkdown(ceb, "公文.ceb"), /兼容引擎/);
    const priorConverter = process.env.OPENWORKBUDDY_CEB_CONVERTER;
    try {
      process.env.OPENWORKBUDDY_CEB_CONVERTER = process.execPath;
      const adapterFixture = 'require("fs").writeFileSync(process.argv[2], Buffer.from("' + pdfFixture().toString("base64") + '", "base64"));';
      fs.writeFileSync(ceb, adapterFixture);
      const adapted = await documentMarkdown(ceb, "适配器.ceb"); assert(adapted.markdown.includes("Quarterly report"));
      assert.strictEqual(fs.readFileSync(ceb, "utf8"), adapterFixture);
      fs.writeFileSync(ceb, 'require("fs").writeFileSync(process.argv[2], "not a PDF");');
      await assert.rejects(documentMarkdown(ceb, "无效输出.ceb"), /有效的 PDF/);
    } finally { if (priorConverter === undefined) delete process.env.OPENWORKBUDDY_CEB_CONVERTER; else process.env.OPENWORKBUDDY_CEB_CONVERTER = priorConverter; }
    const grants = require("../src/desktop/open-files"); const token = grants.offer([doc, "../secret.doc", path.join(home, "bad.exe")], 1000);
    assert.deepStrictEqual(grants.take(token, 1001), [doc]); assert.deepStrictEqual(grants.take(token, 1002), []);
    assert.deepStrictEqual(grants.take(grants.offer([doc], 1000), 1000 + 16 * 60 * 1000), []);
    const sec = require("../src/core/safety/security"); sec.clearSessionAllow();
    await sec.withApprovalScope({ owner: "a", sessionId: "task-a" }, async () => { sec.addSessionAllow("git status"); await Promise.resolve(); assert(sec.listedCommand({}, "git status")); });
    assert(!sec.withApprovalScope({ owner: "a", sessionId: "task-b" }, () => sec.listedCommand({}, "git status")));
    assert(!sec.withApprovalScope({ owner: "b", sessionId: "task-a" }, () => sec.listedCommand({}, "git status")));
    const dirs = require("../src/util/task-dirs"); const folder = path.join(home, "task"); fs.mkdirSync(folder); const file = path.join(folder, "old.pptx"); fs.writeFileSync(file, "original"); const st = fs.statSync(file);
    const session = { dir: "task", transcript: [{ events: [{ type: "files", root: "oldhash", files: [{ name: "task/old.pptx", size: st.size, mtime: st.mtime.toISOString() }] }] }] };
    assert(dirs.recordedFileMatches(session, "task/old.pptx", "oldhash", home)); fs.writeFileSync(file, "replacement"); assert(!dirs.recordedFileMatches(session, "task/old.pptx", "oldhash", home));
    console.log("PASS DOCX/HTML-DOC/WPS/XLSX/XLS/ET/PPTX/PDF -> Markdown; spreadsheet layout; CEB capability boundary; one-use grants; task-scoped approvals; strict legacy root recovery");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
