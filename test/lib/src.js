"use strict";
/**
 * 测试读源码的统一入口：src("server") / src("tools") / src("canvas")。
 *
 *   const { src } = require("./lib/src");
 *   const SERVER = src("server");   // 原来是 fs.readFileSync(path.join(ROOT, "server.js"), "utf8")
 *
 * 为什么要有它：几十个测试拿正则去切 server.js / tools.js / app-07-canvas.js 的源码，
 * 钉「某个函数里有没有那句话」。第 7 批要把这三个大文件拆开——
 *   server.js           → server.js + routes/ + lib/
 *   tools.js            → tools.js + src/tools/
 *   app-07-canvas.js    → app-07-canvas.js + app-07-canvas-*.js
 * 每个测试都写死一个文件名的话，拆一个文件就得回头改几十处，漏一处那条断言就切到空串：
 * 有的当场红（好），有的「找不到就跳过」静悄悄变绿（坏）。所以先把读法收到这儿，
 * 拆的时候只改这一个文件；目录还没建的时候就只读主文件，跟原来逐字一样。
 *
 * 拼接用 "\n" 连，不加分隔标记：加了标记，按「下一个 function」切片的正则会把标记切进去。
 * 这个文件不进 test/all.js 的 SUITES——它不是套件，是被 require 的库；
 * test/repo-hygiene.js【5】会把它当「CI 跑不到的文件」做一遍 node --check，正该如此。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

/** 一个目录下所有 .js（递归），按相对路径排序。目录不存在就是空的——还没拆的时候就是这样 */
function jsUnder(root, dir) {
  const out = [];
  const walk = (rel) => {
    let ents;
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel + "/" + e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && e.name.endsWith(".js")) out.push(r);
    }
  };
  walk(dir);
  return out;
}

// ---------- public/ 下的脚本是怎么被页面拉进来的 ----------
// 两条路：html 里的 <script src>（开页就加载），和代码里的 loadScriptOnce("…")（用到才拿，
// 比如画布）。画布拆成几片之后「按加载顺序拼」就靠这张表；repo-hygiene【10】也拿它判
// 「public/js 下有没有谁都不加载的死文件」——app-07-drama.js 就这么躺过一阵。

// 按行剥注释，跟 repo-hygiene 的 stripComments 同一个口径：不用整块匹配 /* */，
// 前端代码里到处是正则字面量，整块匹配会跟里头的 /* 乱配对、一口吃掉半个文件。
function stripJsComments(text) {
  return text.split("\n").map((l) => {
    const t = l.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
    return l.replace(/(^|[^:])\/\/.*$/, "$1");
  }).join("\n");
}
const stripHtmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

/** 页面里写的地址 → 仓库里的相对路径（posix）。站外地址、data: 之类返回 null */
function resolvePublic(ref, baseDir) {
  const clean = String(ref).split(/[?#]/)[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) return null;
  // 以 / 开头的是站点根，也就是 public/ 本身；不带 / 的相对那张页面所在的目录
  const rel = clean.startsWith("/") ? path.posix.join("public", clean) : path.posix.join(baseDir, clean);
  return rel.startsWith("public/") ? rel : null;
}

/**
 * 按加载顺序列出页面会拉进来的每一个脚本：[{ file: "public/js/app-03.js", via: "public/index.html" }]。
 * 顺序：index.html 在前、其余页面按名字；同一页按 <script> 出现的先后；
 * 然后按这个顺序把每个脚本里的 loadScriptOnce("…") 依次接在后面（被拉进来的脚本里再调的也算）。
 * loadScriptOnce 的相对地址按 public/ 根解析：它是往 document 里插 <script>，相对的是页面地址，
 * 而用它的页面都在 public/ 根上。
 */
function publicScriptRefs(root = ROOT) {
  const pub = path.join(root, "public");
  let pages = [];
  try { pages = fs.readdirSync(pub).filter((f) => f.endsWith(".html")); } catch { return []; }
  pages.sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const refs = [];
  const seen = new Set();
  const add = (file, via) => { if (file && !seen.has(file)) { seen.add(file); refs.push({ file, via }); } };
  const loadCalls = (text) => [...stripJsComments(text).matchAll(/loadScriptOnce\(\s*(["'`])([^"'`$]+)\1\s*\)/g)].map((m) => m[2]);
  for (const page of pages) {
    const via = "public/" + page;
    const html = stripHtmlComments(fs.readFileSync(path.join(pub, page), "utf8"));
    for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["']?)([^"'\s>]+)\1[^>]*>/gi)) add(resolvePublic(m[2], "public"), via);
    // 页面里内联的 <script> 也可能直接调 loadScriptOnce
    for (const s of loadCalls(html)) add(resolvePublic(s, "public"), via);
  }
  for (let i = 0; i < refs.length; i++) {
    const f = refs[i].file;
    if (!f.endsWith(".js")) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; }
    for (const s of loadCalls(text)) add(resolvePublic(s, "public"), f);
  }
  return refs;
}

// ---------- 三组源码 ----------
const CANVAS_MAIN = "public/js/app-07-canvas.js";
const CANVAS_PART = /^public\/js\/app-07-canvas(?:-[^/]+)?\.js$/;

/** 一组源码由哪些文件组成（仓库相对路径，按拼接顺序）。只列盘上真有的 */
function files(name, root = ROOT) {
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  if (name === "server") return ["server.js", ...jsUnder(root, "routes"), ...jsUnder(root, "lib")].filter(exists);
  if (name === "tools") return ["tools.js", ...jsUnder(root, "src/tools")].filter(exists);
  if (name === "canvas") {
    const onDisk = jsUnder(root, "public/js").filter((f) => CANVAS_PART.test(f));
    const loaded = publicScriptRefs(root).map((r) => r.file).filter((f) => onDisk.includes(f));
    // 没人加载的片也拼上（排在最后）：测试照样看得见它，至于「没人加载」这件事由 repo-hygiene【10】去红
    const rest = onDisk.filter((f) => !loaded.includes(f));
    const out = [...loaded, ...rest];
    // 主文件没被任何地方引用（不该发生）时也得在最前面，不然拼出来的顺序跟拆之前对不上
    if (out.includes(CANVAS_MAIN) && !loaded.includes(CANVAS_MAIN)) return [CANVAS_MAIN, ...out.filter((f) => f !== CANVAS_MAIN)];
    return out;
  }
  throw new Error(`src() 不认识「${name}」：只有 server / tools / canvas 三组`);
}

/** 一组源码拼成一整段文本。主文件读不到就当场抛——那不是「没拆」，是路径错了 */
function src(name, root = ROOT) {
  const list = files(name, root);
  const main = { server: "server.js", tools: "tools.js", canvas: CANVAS_MAIN }[name];
  if (!list.includes(main)) throw new Error(`src("${name}") 连主文件 ${main} 都没找到（${root}）`);
  return list.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
}
src.src = src;
src.files = files;

module.exports = { src, files, publicScriptRefs, resolvePublic, stripJsComments, ROOT };
