// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
if (!process.versions.electron) {
  const run = require("child_process").spawnSync(require("electron"), [__filename], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
  process.exit(run.status || (run.error ? 1 : 0));
}
const { app, BrowserWindow } = require("electron");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-document-viewer-")); app.setPath("userData", path.join(tmp, "profile"));
const root = path.join(__dirname, "..");
app.whenReady().then(async () => {
  let server, win;
  try {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Header, Footer, AlignmentType, PageBreak } = require("docx");
    const doc = new Document({ sections: [{
      headers: { default: new Header({ children: [new Paragraph("测试页眉")] }) },
      footers: { default: new Footer({ children: [new Paragraph("测试页脚")] }) },
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "文档版式测试", bold: true, size: 36 })] }),
        new Paragraph("封面和表格应保留版式。"), new Paragraph({ children: [new PageBreak()] }),
        new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph("左侧单元格")] }), new TableCell({ children: [new Paragraph("右侧单元格")] })] })] })],
    }] });
    fs.writeFileSync(path.join(tmp, "fixture.docx"), await Packer.toBuffer(doc));
    const zip = new (require("jszip"))();
    zip.file("OFD.xml", '<ofd:OFD xmlns:ofd="http://www.ofdspec.org/2016"><ofd:DocBody><ofd:DocInfo><ofd:DocID>fixture</ofd:DocID></ofd:DocInfo><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>');
    zip.file("Doc_0/Document.xml", '<ofd:Document xmlns:ofd="http://www.ofdspec.org/2016"><ofd:CommonData><ofd:MaxUnitID>10</ofd:MaxUnitID><ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea></ofd:CommonData><ofd:Pages><ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/></ofd:Pages></ofd:Document>');
    zip.file("Doc_0/Pages/Page_0/Content.xml", '<ofd:Page xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area><ofd:Content><ofd:Layer ID="2"><ofd:TextObject ID="3" Boundary="20 20 160 20" Font="0" Size="6"><ofd:TextCode X="0" Y="10">OFD Preview</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page>');
    fs.writeFileSync(path.join(tmp, "fixture.ofd"), await zip.generateAsync({ type: "nodebuffer" }));
    fs.writeFileSync(path.join(tmp, "fixture.doc"), '<html><head><meta charset="utf-8"></head><body><h1>旧版文档正文</h1><table><tr><td>兼容表格</td></tr></table><script>parent.__escaped=true</script><img src="https://example.invalid/tracker" onerror="parent.__escaped=true"><a href="javascript:alert(1)">外链</a></body></html>');
    const express = require("express"), web = express();
    web.use(["/vendor/ofd", "/vendor/msdoc"], (_q, r, next) => { r.set("Access-Control-Allow-Origin", "*"); next(); });
    web.get("/vendor/document/jszip.min.js", (_q, r) => r.sendFile(path.join(root, "node_modules/jszip/dist/jszip.min.js")));
    web.get("/vendor/document/docx-preview.min.js", (_q, r) => r.sendFile(path.join(root, "node_modules/docx-preview/dist/docx-preview.min.js")));
    web.get("/harness", (_q, r) => r.send('<html><body style="margin:0"><div id="host" style="height:760px;width:630px"></div><script src="/js/document-viewer.js"></script></body></html>'));
    web.use("/fixtures", express.static(tmp)); web.use(express.static(path.join(root, "public")));
    server = await new Promise(resolve => { const s = web.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = "http://127.0.0.1:" + server.address().port;
    win = new BrowserWindow({ show: false, width: 650, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    win.webContents.on("console-message", (_e, level, message) => { if (Number(level) >= 2) console.log("renderer:", message); });
    await win.loadURL(base + "/harness");
    const mount = kind => win.webContents.executeJavaScript(`OWBDocumentViewer.mount(document.getElementById("host"), "/fixtures/fixture.${kind}", ${JSON.stringify(kind === "docx" ? "doc" : kind)}).then(() => true)`);
    assert(await mount("docx"));
    let frame = win.webContents.mainFrame.frames[0];
    const word = await frame.executeJavaScript(`({ pages:document.querySelectorAll("section.docx").length, table:!!document.querySelector("table"), text:document.body.textContent, zoom:Number(document.getElementById("pages").style.zoom), viewport:innerWidth, paper:document.querySelector("section.docx").getBoundingClientRect().width, header:!!document.querySelector("header"), cookie:(()=>{try{return document.cookie}catch{return "blocked"}})() })`);
    assert(word.pages >= 2, "Word page breaks preserved"); assert(word.table); assert(word.text.includes("左侧单元格"));
    assert(word.text.includes("测试页眉") && word.text.includes("测试页脚")); assert(word.zoom > 0 && word.zoom < 1); assert(word.paper < word.viewport);
    assert.strictEqual(word.cookie, "blocked", "opaque frame cannot read application cookies");
    (await win.webContents.capturePage()).toPNG && fs.writeFileSync("/tmp/owb-document-word.png", (await win.webContents.capturePage()).toPNG());
    const zoomed = await frame.executeJavaScript('(()=>{const p=document.getElementById("pages"), before=Number(p.style.zoom); document.getElementById("more").click(); const after=Number(p.style.zoom); document.getElementById("fit").click(); return {before,after,fit:Number(p.style.zoom)}})()');
    assert(zoomed.after > zoomed.before && Math.abs(zoomed.fit - zoomed.before) < .02, "zoom and fit both work");
    await win.webContents.executeJavaScript('OWBDocumentViewer.mount(document.getElementById("host"), "/fixtures/fixture.doc", "html-doc").then(()=>true)');
    frame = win.webContents.mainFrame.frames[0];
    const old = await frame.executeJavaScript('(()=>{const s=document.querySelector(".legacy-paper").shadowRoot;return {text:s.textContent,scripts:s.querySelectorAll("script,[onerror],[href],img[src]").length}})()');
    assert(old.text.includes("旧版文档正文") && old.text.includes("兼容表格")); assert.strictEqual(old.scripts, 0);
    assert.strictEqual(await win.webContents.executeJavaScript('!!window.__escaped'), false, "legacy HTML cannot execute in parent");
    assert(await mount("ofd")); frame = win.webContents.mainFrame.frames[0];
    const ofd = await frame.executeJavaScript(`({canvas:document.querySelectorAll("canvas").length,status:document.getElementById("status").textContent})`);
    assert.strictEqual(ofd.canvas, 1); assert(ofd.status.includes("OFD"));
    let rejected = false;
    try { await win.webContents.executeJavaScript('OWBDocumentViewer.mount(document.getElementById("host"), "/fixtures/missing.docx", "doc")'); } catch { rejected = true; }
    assert(rejected, "missing document reports failure");
    console.log("PASS Word paper/page breaks/table/header/footer/fit, OFD canvas, opaque sandbox, missing-file error");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (win) win.destroy(); if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); app.exit(process.exitCode || 0); }
});
