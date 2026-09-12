"use strict";
/**
 * 终端里的 Markdown 渲染 —— 边流边渲染。
 *
 * 用户原话：「怎么cli里面还有**这种啊」。模型的回答本来就是 Markdown，网页那边有
 * escInline 翻成 HTML，终端这边一直是原样打印：`**查资料**` 就这么四个星号糊在脸上。
 *
 * 三条约束决定了它长这样：
 *
 *   1. **不是 TTY 就一个字节都不许改。** `wb "…" > 答案.md`、`wb … | pbcopy`、`--json`
 *      都要拿到原始 Markdown——那才是能再加工的东西。所以开关在 cli.js，这儿只管渲染。
 *   2. **流式。** 正文是一小片一小片吐出来的，不能等整段收完再渲染（那就成了「模型想了
 *      二十秒什么都没有，然后唰地全出来」）。所以按行缓冲：够一行就渲染一行；还没收完的
 *      那半行，只在「后面不可能再冒出配对记号」的前提下先吐出去。
 *   3. **宁可晚一点，不许吐错。** 半行里只要还有一个没闭合的 ** / 反引号 / [，就把它留在
 *      缓冲区里等下一片——错着吐出去就再也收不回来了（终端不能重绘已经滚过去的字）。
 *
 * 不做的事：不重排、不折行、不重绘。终端里的字一旦滚过去就动不了，任何「先画再改」的
 * 花活儿在 `wb … | tee` 之类的场景下都会变成一堆转义序列。
 */

const { cols } = require("./text-width");

// 关的时候用精确的「关」码，不用 0m 全清：0m 会把外层（比如引用块的灰）一起抹掉
const A = {
  bold: "\u001b[1m", boldOff: "\u001b[22m",
  dim: "\u001b[2m", dimOff: "\u001b[22m",
  italic: "\u001b[3m", italicOff: "\u001b[23m",
  under: "\u001b[4m", underOff: "\u001b[24m",
  strike: "\u001b[9m", strikeOff: "\u001b[29m",
  cyan: "\u001b[36m", colorOff: "\u001b[39m",
};

/**
 * 半行里从哪儿开始不能吐。
 * 返回可以安全吐出去的长度：这一段里所有记号都是成对闭合的，渲染出来不会再变。
 */
function safeCut(s) {
  const cuts = [];
  // 反引号：奇数个就说明最后那个还开着
  const bt = [];
  for (let i = 0; i < s.length; i++) if (s[i] === "`") bt.push(i);
  if (bt.length % 2 === 1) cuts.push(bt[bt.length - 1]);
  // ** 和 ~~：成对出现，落单的那个开始往后都不能吐
  for (const mk of ["*", "~"]) {
    const at = [];
    for (let i = 0; i + 1 < s.length; i++) if (s[i] === mk && s[i + 1] === mk) { at.push(i); i++; }
    if (at.length % 2 === 1) cuts.push(at[at.length - 1]);
  }
  // 单个 * / _：把成对的 ** __ 先摘掉再数，落单同理
  for (const ch of ["*", "_"]) {
    const at = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== ch) continue;
      if (s[i + 1] === ch) { i++; continue; } // 这是 ** / __，上面数过了
      at.push(i);
    }
    if (at.length % 2 === 1) cuts.push(at[at.length - 1]);
  }
  // 链接：有 [ 却还没等到它的 ](…)
  let from = 0;
  for (;;) {
    const i = s.indexOf("[", from);
    if (i < 0) break;
    if (!/\[[^\]\n]*\]\([^)\s]*\)/.test(s.slice(i))) { cuts.push(i); break; }
    from = i + 1;
  }
  // 行尾一个单独的反斜杠：下一片可能是被它转义的那个字符
  if (s.endsWith("\\")) cuts.push(s.length - 1);
  return cuts.length ? Math.max(0, Math.min(...cuts)) : s.length;
}

/**
 * 行内记号 → 转义序列。顺序有讲究：
 * 先把行内代码整段抠出来占位，免得代码里写的 ** 被当成粗体翻掉——
 * 人在代码里打的星号就是星号，这是最容易出的那个错。
 */
function inline(s, color) {
  const on = (k) => (color ? A[k] : "");
  const spans = [];
  const esc = [];
  let t = String(s == null ? "" : s);
  // 反斜杠转义的记号：先换成占位，最后还原成裸字符，中间不参与任何匹配
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, (_m, c) => { esc.push(c); return "\u0000E" + (esc.length - 1) + "\u0000"; });
  t = t.replace(/`([^`\n]+)`/g, (_m, code) => { spans.push(code); return "\u0000C" + (spans.length - 1) + "\u0000"; });
  t = t.replace(/\*\*([^\n]+?)\*\*/g, (_m, x) => on("bold") + x + on("boldOff"));
  t = t.replace(/__([^\n]+?)__/g, (_m, x) => on("bold") + x + on("boldOff"));
  t = t.replace(/~~([^\n]+?)~~/g, (_m, x) => on("strike") + x + on("strikeOff"));
  // 斜体要挑食：2 * 3、snake_case 都不是斜体。记号两侧不能贴空白
  // （*x* 是斜体，* x * 是乘法和错别字），也不能贴字母数字下划线
  t = t.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, (_m, p, x) => p + on("italic") + x + on("italicOff"));
  t = t.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, (_m, p, x) => p + on("italic") + x + on("italicOff"));
  // 链接：文字加下划线，地址留在后面（终端里地址本身才是能点、能复制的那个）
  t = t.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, txt, url) =>
    (txt ? on("under") + txt + on("underOff") + " " : "") + on("dim") + url + on("dimOff"));
  t = t.replace(/\u0000C(\d+)\u0000/g, (_m, i) => on("cyan") + spans[Number(i)] + on("colorOff"));
  t = t.replace(/\u0000E(\d+)\u0000/g, (_m, i) => esc[Number(i)]);
  return t;
}

/** 这半行还看不出是什么块：再等等，别急着按正文吐 */
function undecided(s) {
  if (!s) return true;
  const t = s.replace(/^[ \t]+/, "");
  if (!t) return true;
  // 打到一半的块记号：单独一个 #、一个 -、一个数字，下一个字符就能决定它是标题、列表还是正文
  if (/^(#{1,6}|>|\||`{1,3}|~{1,3}|[-*+=_]{1,3}|\d{1,9}[.)]?)$/.test(t)) return true;
  // 竖线开头：是不是表格得等这一行收完才知道（表格行以竖线收尾）。
  // 不等的话，「| 项 | 状态 」这半行会被当成正文先吐出去，等收完了再想画成表格已经晚了——
  // 于是同一份回答，一次性喂进来是表格，流式喂进来是一堆裸竖线。
  if (/^\|/.test(t)) return true;
  return false;
}

/** 这一行是什么块 */
function blockOf(line) {
  const ind = (line.match(/^[ \t]*/) || [""])[0];
  const t = line.slice(ind.length);
  let m;
  if ((m = t.match(/^(`{3,}|~{3,})\s*(\S*)/))) return { kind: "fence", mark: m[1][0], lang: m[2], ind };
  if ((m = t.match(/^(#{1,6})\s+(.*)$/))) return { kind: "head", level: m[1].length, text: m[2], ind };
  if (/^([-*_])\s*(\1\s*){2,}$/.test(t)) return { kind: "hr", ind };
  if ((m = t.match(/^>\s?(.*)$/))) return { kind: "quote", text: m[1], ind };
  if ((m = t.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/))) return { kind: "task", done: m[1] !== " ", text: m[2], ind };
  if ((m = t.match(/^[-*+]\s+(.*)$/))) return { kind: "bullet", text: m[1], ind };
  if ((m = t.match(/^(\d{1,9})[.)]\s+(.*)$/))) return { kind: "ol", n: m[1], text: m[2], ind };
  if (/^\|.*\|\s*$/.test(t)) return { kind: "table", text: t, ind };
  return { kind: "p", text: line, ind: "" };
}

/**
 * 建一个渲染器。
 *   write(chunk) → 现在就能打出去的那一段（可能是空串：还在等这行收完）
 *   end()        → 收尾，把缓冲区里剩下的半行吐干净
 */
function createRenderer(opts) {
  const o = opts || {};
  const color = o.color !== false;
  const width = Math.max(20, Number(o.width) || 80);
  const on = (k) => (color ? A[k] : "");
  let buf = "";   // 还没收到换行的那半行
  let done = 0;   // 这半行里已经按正文吐出去的原文长度
  let fence = ""; // 代码块围栏的记号（空串 = 不在代码块里）

  const renderLine = (line) => {
    if (fence) {
      const b = blockOf(line);
      if (b.kind === "fence" && b.mark === fence) { fence = ""; return ""; }
      return on("dim") + "│ " + on("dimOff") + on("cyan") + line + on("colorOff") + "\n";
    }
    const b = blockOf(line);
    switch (b.kind) {
      case "fence":
        fence = b.mark;
        return b.lang ? on("dim") + "│ " + b.lang + on("dimOff") + "\n" : "";
      case "head":
        return b.ind + (b.level <= 2
          ? on("bold") + on("cyan") + b.text + on("colorOff") + on("boldOff")
          : on("bold") + b.text + on("boldOff")) + "\n";
      case "hr":
        return on("dim") + "─".repeat(Math.min(width, 48)) + on("dimOff") + "\n";
      case "quote":
        return b.ind + on("dim") + "│ " + on("dimOff") + inline(b.text, color) + "\n";
      case "task":
        return b.ind + on("dim") + (b.done ? "■" : "□") + on("dimOff") + " " + inline(b.text, color) + "\n";
      case "bullet":
        return b.ind + on("dim") + (b.ind.length >= 2 ? "◦" : "•") + on("dimOff") + " " + inline(b.text, color) + "\n";
      case "ol":
        return b.ind + on("dim") + b.n + "." + on("dimOff") + " " + inline(b.text, color) + "\n";
      case "table": {
        // 分隔行（|---|:--:|）在终端里没有意义，换成一道等宽的细线
        if (/^\|[\s:|-]+\|$/.test(b.text) && /-/.test(b.text)) {
          return b.ind + on("dim") + "─".repeat(Math.min(width, Math.max(4, cols(b.text)))) + on("dimOff") + "\n";
        }
        const bar = on("dim") + "│" + on("dimOff");
        const cells = b.text.split("|").slice(1, -1).map((c) => inline(c, color));
        return b.ind + bar + cells.join(bar) + bar + "\n";
      }
      default:
        return inline(b.text, color) + "\n";
    }
  };

  return {
    write(chunk) {
      buf += String(chunk == null ? "" : chunk);
      let out = "";
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        // 这行的前半截已经按正文吐过了：后半截只渲染行内记号，不能再加一次块前缀
        out += done > 0 ? inline(line.slice(done), color) + "\n" : renderLine(line);
        done = 0;
      }
      // 剩下的半行：在代码块里就等着（代码按行走，抢那一点不值当）；还看不出是什么块也等着；
      // 已经定性成正文了，就把「后面不会再变」的那一段先吐出去
      if (!fence && !undecided(buf) && (done > 0 || blockOf(buf).kind === "p")) {
        const cut = safeCut(buf.slice(done));
        if (cut > 0) {
          out += inline(buf.slice(done, done + cut), color);
          done += cut;
        }
      }
      return out;
    },
    end() {
      let out = "";
      if (buf) out += done > 0 ? inline(buf.slice(done), color) + "\n" : renderLine(buf);
      else if (done > 0) out += "\n";
      buf = ""; done = 0; fence = "";
      return out;
    },
  };
}

module.exports = { createRenderer, inline, blockOf, safeCut, undecided };
