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

function docxRuns(p, ctx) {
  const runs = [];
  for (const c of kids(p)) {
    if (c.name === "w:hyperlink") {
      // 以前这儿只把链接文字并进正文，地址整个丢掉：一份满是链接的文档读回来
      // 只剩「公司官网」「详见这里」，模型再想回答「文档里都引了哪些网址」就无从答起。
      const href = ctx && ctx.rels ? ctx.rels.get(c.attrs["r:id"]) || "" : "";
      for (const r of docxRuns(c, ctx)) { if (href) r.href = clip(href); runs.push(r); }
      continue;
    }
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

function docxParagraph(p, ctx) {
  const pr = child(p, "w:pPr");
  const runs = docxRuns(p, ctx);
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
    const nid = child(numPr, "w:numId");
    const lvl = Math.min(5, Number(il ? il.attrs["w:val"] : 0) || 0);
    const b = { t: "li", lvl, runs };
    // 有序还是无序，得去 numbering.xml 里查这一级的 w:numFmt。不查的话「1. 2. 3.」
    // 和「• • •」读回来是同一个样子，模型没法答「第 3 条写的是什么」——
    // 合同、制度、条款几乎全是有序列表，这是最常被问到的那种文档。
    const fmt = ctx && ctx.numFmt ? ctx.numFmt.get((nid ? nid.attrs["w:val"] : "") + ":" + lvl) : "";
    if (fmt && fmt !== "bullet" && fmt !== "none") b.ord = 1;
    return b;
  }
  const b = { t: "p", runs };
  const align = jc ? jc.attrs["w:val"] : "";
  if (align === "center" || align === "right") b.align = align;
  return b;
}

/** numId:ilvl → 这一级的记号格式（decimal / bullet / chineseCounting …）。查不到就当无序，跟以前一样 */
function docxNumbering(zip) {
  const fmt = new Map();
  const xml = zip.text("word/numbering.xml");
  if (!xml) return fmt;
  const root = parseXml(xml);
  const abs = new Map();
  for (const a of findAll(root, "w:abstractNum")) {
    const lv = new Map();
    for (const l of findAll(a, "w:lvl")) {
      const f = child(l, "w:numFmt");
      lv.set(String(l.attrs["w:ilvl"] || "0"), f ? String(f.attrs["w:val"] || "") : "");
    }
    abs.set(String(a.attrs["w:abstractNumId"]), lv);
  }
  for (const nEl of findAll(root, "w:num")) {
    const a = child(nEl, "w:abstractNumId");
    const lv = abs.get(String(a ? a.attrs["w:val"] : ""));
    if (!lv) continue;
    for (const [ilvl, f] of lv) fmt.set(String(nEl.attrs["w:numId"] || "") + ":" + ilvl, f);
  }
  return fmt;
}

/**
 * 页眉页脚里的字。以前一个字都不读——而「内部资料 请勿外传」「本报告仅供 XX 使用」
 * 这类话就只写在页眉里，正文里一个字没有。让模型看不见它，它就会照着往外发。
 * 只取 w:t 里的字（走 docxRuns），所以 PAGE 这种域代码不会混进来；多节重复的去个重。
 */
function docxChrome(zip, kind, ctx) {
  const seen = new Set();
  for (const e of zip.entries) {
    if (!new RegExp("^word/" + kind + "\\d*\\.xml$").test(e.name)) continue;
    const root = parseXml(zip.text(e.name) || "");
    const txt = findAll(root, "w:p").map((p) => docxRuns(p, ctx).map((r) => r.s).join("")).join(" ").replace(/\s+/g, " ").trim();
    if (txt) seen.add(txt);
  }
  return clip([...seen].join(" / "));
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
  const ctx = { rels, numFmt: docxNumbering(zip) };
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
        const b = docxParagraph(el, ctx);
        if (src) blocks.push({ t: "img", src });
        if (b.runs.length) blocks.push(b);
      } else if (el.name === "w:tbl") {
        const rows = [];
        for (const tr of kids(el).filter((c) => c.name === "w:tr")) {
          rows.push(kids(tr).filter((c) => c.name === "w:tc").map((tc) => ({
            runs: kids(tc).filter((c) => c.name === "w:p").flatMap((p, i) => (i ? [{ s: "\n" }] : []).concat(docxRuns(p, ctx))),
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
  return { kind: "doc", blocks, truncated, header: docxChrome(zip, "header", ctx), footer: docxChrome(zip, "footer", ctx) };
}

// ---------------- pptx ----------------
// 页码/日期/页脚：这三个占位符里的字是版式装饰，不是这一页的内容
const CHROME_PH = /^(sldNum|dt|ftr)$/i;

// 原生图表不在 p:sp 里，而是 p:graphicFrame → c:chart，数据在另一个部件 ppt/charts/chartN.xml。
// 不去读它，一整页图表读回来就是「(无标题)」加一片空白——而 skills/ppt-design 恰恰鼓励用
// addChart 画原生图表。实测：一页 addChart(bar, 营收 Q1=12 Q2=18) 读回来 title/lines/notes 全空。
// 好在 OOXML 把渲染用的数值缓存在 c:numCache / c:strCache 里，不用去碰包里那份嵌入的 xlsx。
const CHART_KIND = {
  barChart: "柱状图", bar3DChart: "柱状图", lineChart: "折线图", line3DChart: "折线图",
  pieChart: "饼图", pie3DChart: "饼图", doughnutChart: "环形图", ofPieChart: "复合饼图",
  areaChart: "面积图", area3DChart: "面积图", scatterChart: "散点图", radarChart: "雷达图",
  bubbleChart: "气泡图", stockChart: "股价图", surfaceChart: "曲面图", surface3DChart: "曲面图",
};
const CHART_SERIES = 12;  // 一页图表最多念几条系列
const CHART_POINTS = 24;  // 每条系列最多念几个点（月度两年 = 24，再多人也看不过来）

/** rels 里的 Target 解析成包内条目名。可能是 /ppt/charts/x.xml，也可能是 ../charts/x.xml */
function resolvePart(from, target) {
  if (!target) return "";
  if (target.startsWith("/")) return target.slice(1);
  const base = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") base.pop();
    else base.push(seg);
  }
  return base.join("/");
}

/** c:cat / c:val 底下缓存的那一列点，按 idx 归位（idx 会跳号，直接 push 会错位） */
function cachePoints(holder) {
  const pts = [];
  for (const pt of findAll(holder, "c:pt")) {
    const v = child(pt, "c:v");
    pts[Number(pt.attrs.idx) || 0] = v ? textOf(v).trim() : "";
  }
  return pts;
}

/** 把一份 chartN.xml 念成一两行人话 */
function chartToLines(root) {
  const plot = findAll(root, "c:plotArea")[0];
  if (!plot) return [];
  const kindEl = kids(plot).find((c) => CHART_KIND[c.name.replace(/^c:/, "")]);
  const kind = kindEl ? CHART_KIND[kindEl.name.replace(/^c:/, "")] : "图表";
  const titleEl = findAll(root, "c:title")[0];
  const title = titleEl ? findAll(titleEl, "a:t").map((t) => textOf(t)).join("").trim() : "";
  const out = [{ lvl: 0, s: clip("【" + kind + "】" + (title || "")) }];
  const sers = findAll(plot, "c:ser").slice(0, CHART_SERIES);
  for (const ser of sers) {
    const tx = child(ser, "c:tx");
    const name = tx ? cachePoints(tx).filter(Boolean)[0] || "" : "";
    const cats = cachePoints(child(ser, "c:cat") || { children: [] });
    const vals = cachePoints(child(ser, "c:val") || { children: [] });
    const n = Math.min(Math.max(cats.length, vals.length), CHART_POINTS);
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const c = cats[i] == null ? "" : cats[i];
      const v = vals[i] == null ? "" : vals[i];
      if (!c && !v) continue;
      pairs.push(c && v ? c + "=" + v : c || v);
    }
    const more = Math.max(cats.length, vals.length) > n ? "…" : "";
    if (name || pairs.length) out.push({ lvl: 1, s: clip((name ? name + "：" : "") + pairs.join("、") + more) });
  }
  return out;
}

/** 这一页上挂着的图表，按出现顺序念出来 */
function slideCharts(zip, slideName, root) {
  const refs = findAll(root, "c:chart").map((c) => c.attrs["r:id"]).filter(Boolean);
  if (!refs.length) return [];
  const relName = slideName.replace(/\/([^/]+)$/, "/_rels/$1.rels");
  if (!zip.has(relName)) return [];
  const rels = {};
  for (const r of findAll(parseXml(zip.text(relName) || ""), "Relationship")) rels[r.attrs.Id] = r.attrs.Target || "";
  const out = [];
  for (const id of refs) {
    const part = resolvePart(slideName, rels[id]);
    if (!part || !zip.has(part)) continue;
    // 图表部件坏了不该让整页读不出来——这一页别的字还是有用的
    try { for (const l of chartToLines(parseXml(zip.text(part) || ""))) out.push(l); } catch {}
  }
  return out;
}

/** 这一页上的图片。只说「有张图、图说是什么」——正文在别处，别让一页配图读回来是空白 */
function slidePictures(root) {
  const out = [];
  for (const pic of findAll(root, "p:pic")) {
    const nv = findAll(pic, "p:cNvPr")[0];
    const desc = nv ? String(nv.attrs.descr || "").trim() : "";
    out.push({ lvl: 0, s: clip("［图片］" + (desc ? "　" + desc : "")) });
  }
  return out;
}
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
    for (const l of slideCharts(zip, name, root)) lines.push(l);
    for (const l of slidePictures(root)) lines.push(l);
    // 整页只有一张图/一个图表时，上面那句"没标题就拿第一行当标题"没得可拿，
    // 这里也不补——标题是空的就让它空着，别把「［图片］」当成标题念出去。
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
/**
 * 一个单元格在界面上该显示成什么。有两处跟 exceljs 的默认行为不一样：
 *
 * 公式格：exceljs 不算公式。它写文件时只写公式、不写缓存值，于是同一个格子读回来
 *   cell.text 是空串。而 skills/excel-report 明确要求「合计必须是真公式」——
 *   也就是说我们自己生成的每一份报表，读回来合计那一片全是空的，模型会当成「没算」，
 *   要么报给用户说表是坏的，要么好心把公式改成硬编码数字。给 =SUM(B4:C4) 至少是真话。
 *   （文件本身没问题：Excel/WPS/Numbers 打开时会自己算。空的只有我们这条读取线。）
 *
 * 合并格：exceljs 把主格的值复制进每一个被盖住的格子，A1:D1 的标题会横着重复四遍，
 *   模型看见「销售汇总 销售汇总 销售汇总 销售汇总」会以为那是四列数据。只有主格留字。
 */
function cellText(cell) {
  if (cell.isMerged && cell.master && cell.master.address !== cell.address) return "";
  let v = cell.text;
  if (v == null) v = "";
  else if (typeof v !== "string") v = String(v);
  if (v === "") {
    const f = cell.formula || (cell.value && cell.value.sharedFormula);
    if (f) return "=" + f;
  }
  return v;
}

async function xlsxToSheets(file) {
  const ExcelJS = require("exceljs"); // 项目本来就有（生成 Excel 用的），读也用它：数字格式/日期它都算好了
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  const sheets = [];
  for (const ws of book.worksheets.slice(0, LIMITS.sheets)) {
    // 用过的区域看 dimensions（xlsx 里那句 <dimension ref="A1:F6"/>），拿不到再退回
    // rowCount/columnCount —— 它们是「最后一行/列的号」。
    //
    // 绝不能用 actualRowCount/actualColumnCount：那两个是「非空行/列的个数」，不是行号。
    // 中间夹一个空行，它就比真实行号小 1；拿它当上界，末尾整整一行读不到——
    // 而报表的末尾那行正好是合计。实测：标题行+空行分隔的六行表读回来只有五行，合计没了，
    // 还报 truncated=false（"我全读到了"）。稀疏列同理：A-D 有数、E 空、F 有备注，
    // actualColumnCount=5，于是读 A-E，F 列的备注凭空消失。
    const dim = (ws.dimensions && ws.dimensions.model) || null;
    const lastRow = Math.max(0, (dim ? dim.bottom : ws.rowCount) || 0);
    const lastCol = Math.max(0, (dim ? dim.right : ws.columnCount) || 0);
    const nRows = Math.min(lastRow, LIMITS.rows);
    const nCols = Math.min(lastCol, LIMITS.cols);
    const rows = [];
    for (let r = 1; r <= nRows; r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = 1; c <= nCols; c++) cells.push(clip(cellText(row.getCell(c))));
      rows.push(cells);
    }
    sheets.push({
      name: ws.name,
      rows,
      // 只有上限真咬着了才算截断。以前这里拿 actualRowCount 跟自己比，永远是 false
      truncated: lastRow > nRows || lastCol > nCols,
      totalRows: lastRow,
      totalCols: lastCol,
    });
  }
  if (!sheets.length) throw new Error("这个 .xlsx 里没有工作表");
  return { kind: "sheet", sheets, total: book.worksheets.length, truncated: book.worksheets.length > sheets.length };
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

module.exports = { previewData, readZip, parseXml, findAll, textOf, OOXML, LIMITS, _internals: { docxToDoc, pptxToSlides, xlsxToSheets, zipListing, decodeEntities, cellText, docxNumbering, chartToLines, resolvePart } };
