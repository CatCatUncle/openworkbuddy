// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 回复正文发进聊天软件之前的两道整形，纯函数，不碰网络：
 *
 * 1. 正文里的 SVG 信息图摘出来。网页把 ```svg 围栏画成图；飞书、微信、QQ 只会原样贴出一大坨尖括号。
 *    能发图片的通道转成 PNG 另发一条，发不了的在原位置换成一句实话。
 *    认图的规矩跟网页那份（public/svgfig.js 的 extractSvgFigures）一致：网页画成图的，这里也当图。
 * 2. 长回复切成几条。以前飞书那条是 out.slice(0, 3500) 直接砍，4000 多字的回答后半截就没了。
 */

const SKIP = "```[\\s\\S]*?```|```[\\s\\S]*$|``[^\\n]*?``|`[^`\\n]*`";
const MARK = /\n?\x00SVG(\d+)\x00\n?/g;

/** 光有个 <svg> 壳、里面一个子元素都没有的，是正文在讲这个标签本身，不是图 */
function hasFigureBody(code) {
  return /<[A-Za-z]/.test(String(code || "").replace(/^\s*<svg[^>]*>/i, ""));
}

/**
 * 把正文里的图换成占位 \x00SVG<n>\x00，返回 { text, figs }。partial=true 是没闭合的那张（话说一半断了）。
 * @param {string} src
 * @returns {{ text: string, figs: { svg: string, partial: boolean }[] }}
 */
function pullFigures(src) {
  /** @type {{ svg: string, partial: boolean }[]} */
  const figs = [];
  const push = (/** @type {string} */ code, /** @type {boolean} */ partial) => {
    if (!hasFigureBody(code)) return null;
    figs.push({ svg: code, partial });
    return `\n\x00SVG${figs.length - 1}\x00\n`;
  };
  const keep = (/** @type {string} */ m, /** @type {string | undefined} */ skip, /** @type {boolean} */ partial) => skip ?? (push(m, partial) ?? m);
  let s = String(src || "");
  s = s.replace(/```svg[^\S\n]*\n([\s\S]*?)```/gi, (m, body) => push(body.trim(), false) ?? m);
  s = s.replace(/```svg[^\S\n]*\n([\s\S]*)$/i, (m, body) => push(body.trim(), true) ?? m);
  s = s.replace(new RegExp("(" + SKIP + ")|<svg[\\s>][\\s\\S]*?<\\/\\s*svg\\s*>", "gi"), (m, skip) => keep(m, skip, false));
  s = s.replace(new RegExp("(" + SKIP + ")|<svg[\\s>][\\s\\S]*$", "gi"), (m, skip) => keep(m, skip, true));
  return { text: s, figs };
}

/** 占位换成每张图对应的那句话，多出来的空行收一收 */
function putNotes(/** @type {string} */ text, /** @type {string[]} */ notes) {
  return String(text || "")
    .replace(MARK, (_, i) => `\n\n${notes[+i] || ""}\n\n`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 网页给图定义的那套变量（public/index.html 浅色那份）。脱离页面转图片没人兜底，
// 不换成实值，fill 整条作废回落黑色，字也会掉成默认字体
const LIGHT = {
  "--color-text-primary": "#2c2c2a",
  "--color-text-secondary": "#5f5e5a",
  "--color-text-tertiary": "#888780",
  "--color-border-primary": "#b4b2a9",
  "--color-border-secondary": "#d3d1c7",
  "--color-border-tertiary": "#e4e2da",
  "--color-bg-subtle": "#f7f8fa",
  // 单引号：这串要塞进 font-family="…" 双引号属性里
  "--font-sans": "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Segoe UI', 'Microsoft YaHei', sans-serif",
};

/** 半截的图补成能画的样子：切回最后一个完整标签，把还开着的 style/svg 闭上 */
function repairPartial(/** @type {string} */ code) {
  let s = String(code || "");
  const lastGt = s.lastIndexOf(">"), lastLt = s.lastIndexOf("<");
  if (lastLt > lastGt) s = s.slice(0, lastLt);
  const opens = (s.match(/<style[\s>]/gi) || []).length, closes = (s.match(/<\/style>/gi) || []).length;
  if (opens > closes) s += "</style>";
  return /<\/\s*svg\s*>\s*$/i.test(s) ? s : s + "</svg>";
}

/**
 * 交给浏览器截图之前的一份：砍掉会跑代码、会往外发请求的东西（截图窗口也是个浏览器），
 * 变量换成实值。
 * @param {string} svg @param {boolean} [partial]
 */
function forRaster(svg, partial) {
  let s = partial ? repairPartial(svg) : String(svg || "");
  const m = s.match(/<svg[\s>][\s\S]*<\/\s*svg\s*>/i);
  if (m) s = m[0];
  s = s.replace(/<(script|foreignObject|iframe|object|embed|audio|video)\b[\s\S]*?<\/\s*\1\s*>/gi, "");
  s = s.replace(/<(script|foreignObject|iframe|object|embed|link|meta|audio|video|image)\b[^>]*>/gi, "");
  s = s.replace(/\s+on[\w-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\s+(?:xlink:)?(?:href|src)\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "");
  s = s.replace(/@import[^;]*;?/gi, "");
  s = s.replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, "none");
  // var(--x) / var(--x, 兜底)：认得的换网页那份值，不认得的用它自己写的兜底，都没有就当正文色
  for (let i = 0; i < 3 && /var\(/.test(s); i++) {
    s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, name, dflt) =>
      Object.prototype.hasOwnProperty.call(LIGHT, name) ? LIGHT[/** @type {keyof typeof LIGHT} */ (name)]
        : (dflt || "").trim() || LIGHT["--color-text-primary"]);
  }
  return s;
}

const NOTE_BELOW = (/** @type {number} */ n, /** @type {number} */ total) => total > 1 ? `（图 ${n} 见下方图片）` : "（图见下方图片）";
const NOTE_NO_IMAGE = "（这里原本有一张图，这个聊天里发不了图片）";
const NOTE_FAILED = "（这里原本有一张图，转成图片没成功）";
const NOTE_TOO_MANY = "（这里原本还有一张图，一次最多发 4 张）";
const MAX_FIGS = 4;

/**
 * 摘图、转图，一步到位。render 注入（真跑是 diagram.svgToPngAnyhow，测试给假的）。
 * 返回的 text 里已经没有 SVG 源码了；pngs 按图号排好，调用方发完正文再挨张发。
 * @param {string} text
 * @param {{ canSend: boolean, render?: (svg: string) => Promise<{ png: Buffer | null } | null> }} o
 * @returns {Promise<{ text: string, pngs: { png: Buffer, name: string }[], failed: number }>}
 */
async function prepareFigures(text, o) {
  const { text: held, figs } = pullFigures(text);
  if (!figs.length) return { text: String(text || ""), pngs: [], failed: 0 };
  /** @type {{ png: Buffer, name: string }[]} */
  const pngs = [];
  /** @type {(Buffer | null)[]} */
  const got = [];
  let failed = 0;
  for (let i = 0; i < figs.length; i++) {
    if (!o.canSend || !o.render || i >= MAX_FIGS) { got.push(null); continue; }
    let png = null;
    try {
      const r = await o.render(forRaster(figs[i].svg, figs[i].partial));
      png = r && r.png && r.png.length ? r.png : null;
    } catch {}
    if (!png) failed++;
    got.push(png);
  }
  const total = got.filter(Boolean).length;
  let n = 0;
  const notes = got.map((png, i) => {
    if (png) { n++; pngs.push({ png, name: `图${total > 1 ? n : ""}.png` }); return NOTE_BELOW(n, total); }
    if (!o.canSend) return NOTE_NO_IMAGE;
    return i >= MAX_FIGS ? NOTE_TOO_MANY : NOTE_FAILED;
  });
  return { text: putNotes(held, notes), pngs, failed };
}

/** 发不了图的地方（群机器人摘要之类）：图换成一句话就行 */
function dropFigures(/** @type {string} */ text) {
  const { text: held, figs } = pullFigures(text);
  return figs.length ? putNotes(held, figs.map(() => NOTE_NO_IMAGE)) : String(text || "");
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;

/** 一段里有几张表（连着的 | 行算一张） */
function tablesIn(/** @type {string} */ block) {
  let n = 0, inTable = false;
  for (const l of block.split("\n")) {
    const row = TABLE_ROW.test(l);
    if (row && !inTable) n++;
    inTable = row;
  }
  return n;
}

/** 按空行切成段；围栏里的空行不算 */
function blocksOf(/** @type {string} */ text) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let cur = [];
  let fence = "";
  for (const line of String(text || "").split("\n")) {
    const f = line.match(FENCE);
    if (f) fence = !fence ? f[1] : (line.trim().startsWith(fence) && !line.trim().slice(fence.length).trim() ? "" : fence);
    if (!fence && !f && !line.trim()) { if (cur.length) out.push(cur.join("\n")); cur = []; continue; }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/**
 * 一段本身就超长：按行硬切。切在围栏里，前一截补上收尾、后一截重开同一种围栏；
 * 切在表格中间，后一截把表头那两行再抄一遍——两半各自都能正常渲染。
 * 一行本身就放不下的（压缩过的 JSON、不换行的长段落）先按字数切成几截。
 * @param {string} block @param {number} max
 */
function hardSplit(block, max) {
  /** @type {string[]} */
  const out = [];
  let buf = "", fence = "", open = "", head = "", rows = 0;
  const tail = () => (fence ? "\n" + fence : "");
  const closes = (/** @type {string} */ line) => !!fence && line.trim().startsWith(fence) && !line.trim().slice(fence.length).trim();
  const flush = (/** @type {string} */ next) => {
    if (buf) out.push(buf + tail());
    const carry = fence ? open : (rows > 2 && head ? head : "");
    buf = carry && carry.length + 1 + next.length + tail().length <= max ? carry : "";
  };
  const piece = Math.max(100, max - 64);
  for (const raw of block.split("\n")) {
    const cps = Array.from(raw);
    const lines = [];
    for (let i = 0; i < cps.length; i += piece) lines.push(cps.slice(i, i + piece).join(""));
    if (!lines.length) lines.push("");
    for (const line of lines) {
      const f = line.match(FENCE);
      if (!fence && TABLE_ROW.test(line)) {
        rows++;
        if (rows === 1) head = line;
        else if (rows === 2) head = TABLE_SEP.test(line) ? head + "\n" + line : "";
      } else if (!fence) { rows = 0; head = ""; }
      const end = closes(line);
      if (buf && buf.length + 1 + line.length + (end ? 0 : tail().length) > max) flush(line);
      buf = buf ? buf + "\n" + line : line;
      if (end) { fence = ""; open = ""; }
      else if (f && !fence) { fence = f[1]; open = line; }
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 长回复切成几条：按段落装，段落不从中间劈开；一条最多 max 字、最多 tables 张表（飞书卡片上限 5 张）。
 * @param {string} text
 * @param {{ max?: number, tables?: number }} [o]
 * @returns {string[]}
 */
function chunks(text, o = {}) {
  const max = Math.max(200, o.max || 3000), maxTables = Math.max(1, o.tables || 5);
  const src = String(text || "");
  if (src.length <= max && tablesIn(src) <= maxTables) return [src];
  /** @type {string[]} */
  const out = [];
  let buf = "", nt = 0;
  for (const block of blocksOf(src)) {
    const parts = block.length > max ? hardSplit(block, max) : [block];
    for (const p of parts) {
      const t = tablesIn(p);
      if (buf && (buf.length + 2 + p.length > max || nt + t > maxTables)) { out.push(buf); buf = ""; nt = 0; }
      buf = buf ? buf + "\n\n" + p : p;
      nt += t;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [src];
}

module.exports = { pullFigures, putNotes, forRaster, prepareFigures, dropFigures, chunks, hasFigureBody, MAX_FIGS };
