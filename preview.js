"use strict";
/**
 * 成果文件的应用内预览 —— 把 Office 三件套和压缩包拆成结构化数据，交给前端渲染。
 *
 * 为什么要在服务端拆：docx/xlsx/pptx 本质是一包 XML 塞进 zip，浏览器打不开；
 * 而这三样恰恰是这个产品的主交付物（package.json 的第一句话就是"交付 PPT/Word/Excel 等成果文件"）。
 * 在这之前，点开一个 .docx 是直接甩给本机 Word——装了 Office 才看得见，看完还得手动切回来。
 *
 * 为什么返回数据而不是 HTML：这些文件的内容是模型写的、或者从网上下的，直接把转换出来的
 * HTML 塞进渲染进程等于给自己开了个 XSS 口子。所以这一层只吐纯数据（文字、层级、行列），
 * 拼 HTML 的活留在前端一处做，每个字段都过 esc()——转义漏没漏，只需要审那一个地方。
 *
 * 依赖：只用 Node 自带的 zlib（自己读 zip）+ 项目里本来就有的 exceljs。不为预览新装包。
 */

const fs = require("fs");
const zlib = require("zlib");

const LIMITS = {
  zipBytes: 200 * 1024 * 1024, // 再大就别在内存里整包读了
  entries: 5000,
  blocks: 3000,   // docx 段落
  images: 20,     // docx 内嵌图，每张 3MB 封顶
  imageBytes: 3 * 1024 * 1024,
  sheets: 20,
  rows: 2000,
  cols: 60,
  slides: 300,
  chars: 20000,   // 单个文本节点
};

// ---------------- 最小 zip 读取器 ----------------
// OOXML 就是 zip：读中央目录拿到条目表，按需 inflate 单个条目。只支持 stored(0) 和 deflate(8)，
// 这两种覆盖了 Word/Excel/PowerPoint/我们自己用 docx 与 pptxgenjs 生成的全部文件。
function readZip(file) {
  const st = fs.statSync(file);
  if (st.size > LIMITS.zipBytes) throw new Error(`文件太大（${(st.size / 1048576).toFixed(0)} MB），没法在应用内展开`);
  const buf = fs.readFileSync(file);
  // 尾部 22 字节是 EOCD，但后面可能挂着注释，所以从尾巴往前扫（注释最长 65535）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip / Office 文件（找不到中央目录）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) throw new Error("这是 zip64 格式，应用内暂时展不开");

  const entries = [];
  for (let k = 0; k < count && k < LIMITS.entries; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const nlen = buf.readUInt16LE(off + 28);
    const e = {
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
      size: buf.readUInt32LE(off + 24),
      lho: buf.readUInt32LE(off + 42),
      name: buf.toString("utf8", off + 46, off + 46 + nlen),
    };
    e.dir = e.name.endsWith("/");
    entries.push(e);
    off += 46 + nlen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }

  const read = (e) => {
    if (!e || e.dir) return null;
    if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error("zip 局部头损坏：" + e.name);
    // 局部头里的名字/扩展字段长度可能和中央目录不一样，必须以局部头为准
    const start = e.lho + 30 + buf.readUInt16LE(e.lho + 26) + buf.readUInt16LE(e.lho + 28);
    const raw = buf.subarray(start, start + e.csize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`条目 ${e.name} 用了不支持的压缩方式 ${e.method}`);
  };
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    entries,
    read,
    get: (n) => read(byName.get(n)),
    text: (n) => { const b = read(byName.get(n)); return b ? b.toString("utf8") : null; },
    has: (n) => byName.has(n),
  };
}

// ---------------- 最小 XML 解析器 ----------------
// 用正则抓 OOXML 迟早翻车（同名标签嵌套、属性里带尖括号、自闭合混排），所以老老实实扫一遍。
// 只做预览要用的那些：元素、属性、文本、CDATA；注释/声明/DOCTYPE 直接跳过。
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[e] != null ? ENT[e] : m;
  });
}

function parseXml(src) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const push = (n) => stack[stack.length - 1].children.push(n);
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { const t = decodeEntities(src.slice(i)); if (t) push(t); break; }
    if (lt > i) { const t = decodeEntities(src.slice(i, lt)); if (t) push(t); }
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt); push(src.slice(lt + 9, e < 0 ? src.length : e)); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) { const e = src.indexOf(">", lt); i = e < 0 ? src.length : e + 1; continue; }
    if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt);
      const nm = src.slice(lt + 2, e < 0 ? src.length : e).trim();
      // 容错：文件里少写了一个闭合标签时，退到最近的同名那一层，而不是整棵树错位
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === nm) { stack.length = k; break; }
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    // 开标签：属性值里可能有 '>'，所以要跳过引号再找结尾
    let j = lt + 1, q = 0;
    while (j < src.length) {
      const c = src[j];
      if (q) { if (c === q) q = 0; }
      else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
      j++;
    }
    const inner = src.slice(lt + 1, j);
    const selfClose = inner.endsWith("/");
    const body = selfClose ? inner.slice(0, -1) : inner;
    const mName = /^([^\s/>]+)/.exec(body);
    if (!mName) { i = j + 1; continue; }
    const node = { name: mName[1], attrs: {}, children: [] };
    const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let ma;
    while ((ma = attrRe.exec(body))) node.attrs[ma[1]] = decodeEntities(ma[3] != null ? ma[3] : ma[4] || "");
    push(node);
    if (!selfClose) stack.push(node);
    i = j + 1;
  }
  return root;
}

const kids = (n) => (n && n.children ? n.children.filter((c) => typeof c !== "string") : []);
/** 直接子元素里第一个叫 name 的 */
const child = (n, name) => kids(n).find((c) => c.name === name) || null;
/** 整棵子树里所有叫 name 的（按文档顺序） */
function findAll(n, name, out = []) {
  for (const c of kids(n)) { if (c.name === name) out.push(c); findAll(c, name, out); }
  return out;
}
/** 整棵子树的纯文本 */
function textOf(n, buf = []) {
  if (!n) return "";
  for (const c of n.children || []) typeof c === "string" ? buf.push(c) : textOf(c, buf);
  return buf.join("");
}
const clip = (s) => (s.length > LIMITS.chars ? s.slice(0, LIMITS.chars) + "…" : s);

// ---------------- docx ----------------
const HEADING_RE = /^(?:heading|标题)\s*([1-6])$/i;

function docxRuns(p) {
  const runs = [];
  for (const c of kids(p)) {
    if (c.name === "w:hyperlink") { for (const r of docxRuns(c)) runs.push(r); continue; }
    if (c.name !== "w:r") continue;
    const pr = child(c, "w:rPr") || { children: [] };
    const on = (t) => { const e = child(pr, t); return e ? child(pr, t).attrs["w:val"] !== "0" && child(pr, t).attrs["w:val"] !== "false" : false; };
    let s = "";
    for (const t of kids(c)) {
      if (t.name === "w:t") s += textOf(t);
      else if (t.name === "w:tab") s += "\t";
      else if (t.name === "w:br" || t.name === "w:cr") s += "\n";
    }
    if (!s) continue;
    const run = { s: clip(s) };
    if (on("w:b")) run.b = 1;
    if (on("w:i")) run.i = 1;
    if (on("w:u")) run.u = 1;
    runs.push(run);
  }
  return runs;
}

function docxParagraph(p) {
  const pr = child(p, "w:pPr");
  const runs = docxRuns(p);
  const styleEl = pr && child(pr, "w:pStyle");
  const style = styleEl ? styleEl.attrs["w:val"] || "" : "";
  const mh = HEADING_RE.exec(style);
  const outline = pr && child(pr, "w:outlineLvl");
  const jc = pr && child(pr, "w:jc");
  const numPr = pr && child(pr, "w:numPr");
  if (mh) return { t: "h", lvl: Number(mh[1]), runs };
  if (outline) return { t: "h", lvl: Math.min(6, Number(outline.attrs["w:val"] || 0) + 1), runs };
  if (numPr) {
    const il = child(numPr, "w:ilvl");
    return { t: "li", lvl: Math.min(5, Number(il ? il.attrs["w:val"] : 0) || 0), runs };
  }
  const b = { t: "p", runs };
  const align = jc ? jc.attrs["w:val"] : "";
  if (align === "center" || align === "right") b.align = align;
  return b;
}

function docxToDoc(zip) {
  const xml = zip.text("word/document.xml");
  if (!xml) throw new Error("这个 .docx 里没有 word/document.xml，可能不是 Word 文件");
  const body = child(parseXml(xml), "w:document") && child(child(parseXml(xml), "w:document"), "w:body");
  const doc = parseXml(xml);
  const root = child(doc, "w:document");
  const bodyEl = root ? child(root, "w:body") : body;
  if (!bodyEl) throw new Error("这个 .docx 的正文是空的");

  // rId → word/media/xxx.png，用来把内嵌图变成 data URI
  const rels = new Map();
  const relXml = zip.text("word/_rels/document.xml.rels");
  if (relXml) for (const r of findAll(parseXml(relXml), "Relationship")) rels.set(r.attrs.Id, r.attrs.Target || "");
  let imgLeft = LIMITS.images;
  const imageOf = (node) => {
    const blip = findAll(node, "a:blip")[0];
    if (!blip || imgLeft <= 0) return null;
    const target = rels.get(blip.attrs["r:embed"] || blip.attrs["r:link"]);
    if (!target) return null;
    const name = "word/" + target.replace(/^\.?\//, "");
    let buf;
    try { buf = zip.get(name); } catch { return null; }
    if (!buf || buf.length > LIMITS.imageBytes) return null;
    const ext = (name.split(".").pop() || "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : "image/png";
    imgLeft--;
    return `data:${mime};base64,${buf.toString("base64")}`;
  };

  const blocks = [];
  let truncated = false;
  const walk = (nodes) => {
    for (const el of nodes) {
      if (blocks.length >= LIMITS.blocks) { truncated = true; return; }
      if (el.name === "w:p") {
        const src = imageOf(el);
        const b = docxParagraph(el);
        if (src) blocks.push({ t: "img", src });
        if (b.runs.length) blocks.push(b);
      } else if (el.name === "w:tbl") {
        const rows = [];
        for (const tr of kids(el).filter((c) => c.name === "w:tr")) {
          rows.push(kids(tr).filter((c) => c.name === "w:tc").map((tc) => ({
            runs: kids(tc).filter((c) => c.name === "w:p").flatMap((p, i) => (i ? [{ s: "\n" }] : []).concat(docxRuns(p))),
          })));
        }
        if (rows.length) blocks.push({ t: "table", rows });
      } else if (el.name === "w:sdt") {
        const c = child(el, "w:sdtContent");
        if (c) walk(kids(c)); // 目录/控件外壳，里面才是真段落
      }
    }
  };
  walk(kids(bodyEl));
  return { kind: "doc", blocks, truncated };
}

// ---------------- pptx ----------------
// 页码/日期/页脚：这三个占位符里的字是版式装饰，不是这一页的内容
const CHROME_PH = /^(sldNum|dt|ftr)$/i;
function pptxToSlides(zip) {
  const slideNames = zip.entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  if (!slideNames.length) throw new Error("这个 .pptx 里一张幻灯片都没有，可能不是 PowerPoint 文件");
  const slides = [];
  for (const name of slideNames.slice(0, LIMITS.slides)) {
    const root = parseXml(zip.text(name) || "");
    const lines = [];
    let title = "";
    for (const sp of findAll(root, "p:sp")) {
      const ph = findAll(sp, "p:ph")[0];
      const phType = ph ? String(ph.attrs.type || "") : "";
      if (CHROME_PH.test(phType)) continue; // 页码/日期/页脚这三个占位符里装的不是内容
      // 占位符类型 title / ctrTitle 的那个形状是标题，其余都是正文
      const isTitle = /title/i.test(phType);
      for (const p of findAll(sp, "a:p")) {
        const s = findAll(p, "a:t").map((t) => textOf(t)).join("").trim();
        if (!s) continue;
        if (isTitle && !title) title = clip(s);
        else lines.push({ lvl: Math.min(4, Number((child(p, "a:pPr") || { attrs: {} }).attrs.lvl || 0) || 0), s: clip(s) });
      }
    }
    // 没有 title 占位符的幻灯片很常见——pptxgenjs 的 placeholder:"title" 不落 p:ph，
    // 模型手摆文本框的更不会有。这时候把第一行当标题：人眼看到的本来就是它。
    if (!title && lines.length) title = lines.shift().s;
    // 表格里的字也算内容，模型经常把数据摆成表
    for (const tbl of findAll(root, "a:tbl")) {
      for (const tr of findAll(tbl, "a:tr")) {
        const cells = findAll(tr, "a:tc").map((tc) => findAll(tc, "a:t").map((t) => textOf(t)).join("").trim());
        if (cells.some(Boolean)) lines.push({ lvl: 0, s: clip(cells.join("  |  ")) });
      }
    }
    const n = Number(/(\d+)\.xml$/.exec(name)[1]);
    const notesName = `ppt/notesSlides/notesSlide${n}.xml`;
    let notes = "";
    if (zip.has(notesName)) {
      // 备注页里除了备注正文，还塞着一个页码占位符——不滤掉的话每一页的"备注"都是那一页的页码
      const nroot = parseXml(zip.text(notesName) || "");
      const parts = [];
      for (const sp of findAll(nroot, "p:sp")) {
        const ph = findAll(sp, "p:ph")[0];
        if (ph && CHROME_PH.test(String(ph.attrs.type || ""))) continue;
        if (ph && /^sldImg$/i.test(String(ph.attrs.type || ""))) continue;
        parts.push(findAll(sp, "a:t").map((t) => textOf(t)).join(""));
      }
      notes = clip(parts.join("\n").trim());
      if (notes === title) notes = ""; // 备注页会把标题也复述一遍
    }
    slides.push({ n, title, lines, notes });
  }
  return { kind: "slides", slides, total: slideNames.length, truncated: slideNames.length > slides.length };
}

// ---------------- xlsx ----------------
async function xlsxToSheets(file) {
  const ExcelJS = require("exceljs"); // 项目本来就有（生成 Excel 用的），读也用它：数字格式/日期/合并单元格它都算好了
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = [];
  for (const ws of wb.worksheets.slice(0, LIMITS.sheets)) {
    const nRows = Math.min(ws.actualRowCount || ws.rowCount || 0, LIMITS.rows);
    const nCols = Math.min(ws.actualColumnCount || ws.columnCount || 0, LIMITS.cols);
    const rows = [];
    for (let r = 1; r <= nRows; r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = 1; c <= nCols; c++) {
        const cell = row.getCell(c);
        let v = cell.text;
        if (v == null) v = "";
        else if (typeof v !== "string") v = String(v);
        cells.push(clip(v));
      }
      rows.push(cells);
    }
    sheets.push({
      name: ws.name,
      rows,
      truncated: (ws.actualRowCount || 0) > nRows || (ws.actualColumnCount || 0) > nCols,
      totalRows: ws.actualRowCount || nRows,
      totalCols: ws.actualColumnCount || nCols,
    });
  }
  if (!sheets.length) throw new Error("这个 .xlsx 里没有工作表");
  return { kind: "sheet", sheets, total: wb.worksheets.length, truncated: wb.worksheets.length > sheets.length };
}

// ---------------- 压缩包 ----------------
function zipListing(zip) {
  const entries = zip.entries
    .filter((e) => !e.dir)
    .map((e) => ({ name: e.name, size: e.size, packed: e.csize }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return {
    kind: "archive",
    entries: entries.slice(0, 500),
    total: entries.length,
    bytes: entries.reduce((s, e) => s + e.size, 0),
    truncated: entries.length > 500,
  };
}

// ---------------- 入口 ----------------
const OOXML = { docx: "doc", xlsx: "sheet", pptx: "slides" };
/** 前端 previewKind() 认出来的这几种，才会来调这个接口；这里再判一次，别信路由 */
async function previewData(file, name) {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  if (ext === "xlsx") return await xlsxToSheets(file);
  if (ext === "docx") return docxToDoc(readZip(file));
  if (ext === "pptx") return pptxToSlides(readZip(file));
  if (ext === "zip") return zipListing(readZip(file));
  throw new Error(`不认识的预览类型 .${ext}`);
}

module.exports = { previewData, readZip, parseXml, findAll, textOf, OOXML, LIMITS, _internals: { docxToDoc, pptxToSlides, xlsxToSheets, zipListing, decodeEntities } };
