// @ts-check
"use strict";
/**
 * 终端里的 Markdown 渲染 —— 边流边渲染。
 *
 * 模型的回答本来就是 Markdown，网页那边有
 * escInline 翻成 HTML，终端这边一直是原样打印：`**查资料**` 就这么四个星号糊在脸上。
 *
 * 三条约束决定了它长这样：
 *
 *   1. **不是 TTY 就一个字节都不许改。** `openworkbuddy "…" > 答案.md`、`openworkbuddy … | pbcopy`、`--json`
 *      都要拿到原始 Markdown——那才是能再加工的东西。所以开关在 cli.js，这儿只管渲染。
 *   2. **流式。** 正文是一小片一小片吐出来的，不能等整段收完再渲染（那就成了「模型想了
 *      二十秒什么都没有，然后唰地全出来」）。所以按行缓冲：够一行就渲染一行；还没收完的
 *      那半行，只在「后面不可能再冒出配对记号」的前提下先吐出去。
 *   3. **宁可晚一点，不许吐错。** 半行里只要还有一个没闭合的 ** / 反引号 / [，就把它留在
 *      缓冲区里等下一片——错着吐出去就再也收不回来了（终端不能重绘已经滚过去的字）。
 *
 * 不做的事：不重排、不折行、不重绘。终端里的字一旦滚过去就动不了，任何「先画再改」的
 * 花活儿在 `openworkbuddy … | tee` 之类的场景下都会变成一堆转义序列。
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
 * prev 是这半行前面已经吐掉的最后一个字（行首给空串）：单个 * _ 能不能当斜体开头，得看它左边贴着什么。
 *
 * 规矩跟 inline() 一条条对齐：inline 根本不会动的（2 * 3、user_name、[1]、a[0]），这儿也不许压着——
 * 压着就是整行卡到换行才出来，而且每来一片都要把压着的那一截从头再扫一遍，行越长越慢。
 */
const HOLD_MAX = 1000; // 没闭合的记号最多压住这么多字：再长多半不是记号，放行，免得卡到换行
const WORD = /\w/, SPACE = /\s/;
const ESCAPABLE = "\\`*_{}[]()#+-.!~>|"; // 跟 inline() 第一条正则是同一张表，改一处要改两处
function safeCut(s, prev) {
  const n = s.length;
  let cut = n;
  const hold = (i) => { if (i < cut) cut = i; };
  const spans = []; // [起, 止)：已经配上对的记号，切口不能落在里头
  const ends = new Uint8Array(n + 1);
  const pair = (b, e) => { spans.push([b, e]); ends[e] = 1; };
  const tok = new Uint8Array(n); // 配上对的 ** __ ~~：inline() 会把它们换成转义码（关颜色时直接删掉）
  // 先把转义和行内代码涂成不参与任何匹配的字，下面只在涂过的这份上找记号——
  // inline() 也是先把它俩抠走再干别的：`read_file` 里的 _ 不是斜体，\* 也不是
  const a = s.split("");
  for (let i = 0; i < n; i++) {
    if (a[i] !== "\\") continue;
    if (i + 1 === n) { hold(i); break; } // 行尾一个反斜杠：下一片可能是被它转义的那个字
    if (ESCAPABLE.includes(a[i + 1])) { a[i] = a[i + 1] = "\u0001"; i++; }
  }
  for (let i = 0; i < n; i++) {
    if (a[i] !== "`") continue;
    let j = i + 1;
    while (j < n && a[j] !== "`") j++;
    if (j === n) { hold(i); a.fill("\u0001", i); break; } // 反引号还开着：它后面的都可能是代码
    if (j === i + 1) continue; // `` 空的不算代码，第二个反引号还能跟后面的配
    a.fill("\u0001", i, j + 1);
    i = j;
  }
  const m = a.join("");
  const mark = (x) => m[x] === "*" || m[x] === "_" || m[x] === "~";
  // ** __ ~~：跟 inline() 那几条正则一样从左往右找，隔至少一个字的下一个同样记号就是收尾；
  // 找不到收尾的，从它开始往后都不能吐
  for (const mk of ["**", "__", "~~"]) {
    for (let o = m.indexOf(mk); o >= 0; ) {
      const c = m.indexOf(mk, o + 3);
      if (c < 0) { hold(o); break; }
      pair(o, c + 2);
      tok[o] = tok[o + 1] = tok[c] = tok[c + 1] = 1;
      o = m.indexOf(mk, c + 2);
    }
  }
  // 单个 * _：照 inline() 那条斜体正则判。开头的左边不能贴字母数字（也不能是同一个记号）、右边不能贴空白；
  // 收尾的就是下一个同样的记号，它左边不能贴空白、右边不能贴字母数字。判不出来的（右边还没来）才压着
  for (const ch of ["*", "_"]) {
    const at = [];
    for (let i = 0; i < n; i++) if (m[i] === ch && !tok[i]) at.push(i); // 配上对的 ** __ 上面算过了
    for (let k = 0; k < at.length; k++) {
      const i = at[k];
      const p = i > 0 ? m[i - 1] : prev;
      const j = at[k + 1];
      // 跟别的记号贴在一起的（**重点***斜体*、*斜体*__粗__）：旁边那对记号开颜色时换成转义码、关颜色时直接删掉，
      // 它的邻居跟着变，判法也跟着变。这种写法少见，压到换行整行一起渲染，不去猜
      if (mark(i - 1) || (!WORD.test(p || " ") && (mark(i + 1) || (j !== undefined && (mark(j - 1) || mark(j + 1)))))) {
        let b = i;
        while (mark(b - 1)) b--;
        hold(b); break;
      }
      if (p && (WORD.test(p) || p === ch)) continue; // user_name、a*b：当不了开头
      if (i + 1 === n) { hold(i); break; }
      if (SPACE.test(m[i + 1])) continue;            // 2 * 3
      if (j === undefined || j + 1 === n) { hold(i); break; } // 收尾的还没来，或者来了但还不知道右边贴什么
      if (!SPACE.test(m[j - 1]) && !WORD.test(m[j + 1]) && m[j + 1] !== ch) { pair(i, j + 1); k++; }
    }
  }
  // 链接 [文字](地址)。[1]、a[0] 这种 ] 后面跟的不是 ( 的，已经不可能是链接了，不用等
  for (let i = m.indexOf("["); i >= 0 && i < cut; i = m.indexOf("[", i + 1)) {
    const j = m.indexOf("]", i + 1);
    if (j < 0 || j + 1 === n) { hold(i); break; } // ] 还没来；或者刚到，下一片可能就是 (
    if (m[j + 1] !== "(") { i = j; continue; }    // 中间别的 [ 也只能配这个 ]，一起跳过
    const url = /\([^)\s]+\)/y; url.lastIndex = j + 1;
    if (url.test(m)) { pair(i, url.lastIndex); i = url.lastIndex - 1; continue; }
    const tail = /\([^)\s]*$/y; tail.lastIndex = j + 1;
    if (tail.test(m)) { hold(i); break; } // 地址还在路上
    i = j;
  }
  // 刚收尾的 ** __ ~~ 正好在结尾：下一片要是紧贴一个 * _，就是上面说的那种，等一片再说
  if (cut === n && tok[n - 1]) hold(spans.find((x) => x[1] === n)[0]);
  // 切口落在一对记号中间，就退到这对的开头。按开头从后往前退一遍就够：退过去以后只可能落进更靠前的那对
  spans.sort((x, y) => y[0] - x[0]);
  for (const [b, e] of spans) if (b < cut && cut < e) cut = b;
  if (n - cut > HOLD_MAX) cut = n;
  // 结尾一个没配上对的 * _ ~：跟下一片的第一个字可能凑成 ** __ ~~，留到下一片
  if (cut === n && mark(n - 1) && !tok[n - 1]) cut--;
  if (cut === n && m[n - 1] === "\\") cut--; // 放行以后也不能把反斜杠跟它转义的字拆开
  // 切口左边是个没配上对的 * _：单独渲染时它右边是行尾，可能被当成斜体收尾，整行里它右边贴着字就不是
  while (cut > 0 && (m[cut - 1] === "*" || m[cut - 1] === "_") && !ends[cut]) cut--;
  return cut;
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
  // 前面粗体、斜体插进来的转义码也是 ESC [ 开头，那个 [ 不是链接：从它开始配，整段就乱码了
  t = t.replace(/(?<!\u001b)\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, txt, url) =>
    (txt ? on("under") + txt + on("underOff") + " " : "") + on("dim") + url + on("dimOff"));
  t = t.replace(/\u0000C(\d+)\u0000/g, (_m, i) => on("cyan") + spans[Number(i)] + on("colorOff"));
  t = t.replace(/\u0000E(\d+)\u0000/g, (_m, i) => esc[Number(i)]);
  return t;
}

/**
 * 切口左边那个字。被反斜杠转义过的（\*）整行渲染时是个占位符，不算记号也不算字母。
 * floor 是上一刀的位置：切口从不落在反斜杠和它转义的字中间，往回数反斜杠数到那儿就够了——
 * 不然一长串反斜杠，每来一块都得从行首数一遍
 */
function prevAt(line, from, floor) {
  if (from <= 0) return "";
  const c = line[from - 1];
  let k = 0;
  while (from - 2 - k >= (floor || 0) && line[from - 2 - k] === "\\") k++;
  return k % 2 === 1 && ESCAPABLE.includes(c) ? "\u0001" : c;
}

/**
 * 渲染一行从 from 起的后半截。开头要是个 * _，而它在整行里左边贴着字（user_name 的 _），
 * inline() 整行渲染时不会拿它当斜体开头；单独渲染这半截它却成了行首。
 * 前面垫一个字母再渲染、渲染完去掉，它的左邻居就跟整行里一样了（不能用反斜杠转义：
 * 转义完它自己成了占位符，右边那个字的左邻居又变了）
 */
function inlineFrom(line, from, color, p) {
  const piece = line.slice(from);
  const c = piece[0];
  if ((c === "*" || c === "_") && p && (WORD.test(p) || p === c)) return inline("a" + piece, color).slice(1);
  return inline(piece, color);
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
  let prev = "";  // done 左边那个字（prevAt 的结果），done 挪一次算一次

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
      case "head": {
        // 标题里的 **、`代码`、链接照样渲染（原来原样打出 ** 和 [x](u)）。
        // 它们收尾的关码会把标题自己的粗体、青色一起关掉，关完立刻补回来
        const hi = b.level <= 2;
        let t = inline(b.text, color);
        if (color) t = t.replace(/\u001b\[22m/g, A.boldOff + A.bold).replace(/\u001b\[39m/g, hi ? A.colorOff + A.cyan : A.colorOff);
        return b.ind + (hi
          ? on("bold") + on("cyan") + t + on("colorOff") + on("boldOff")
          : on("bold") + t + on("boldOff")) + "\n";
      }
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
        out += done > 0 ? inlineFrom(line, done, color, prev) + "\n" : renderLine(line);
        done = 0; prev = "";
      }
      // 剩下的半行：在代码块里就等着（代码按行走，抢那一点不值当）；还看不出是什么块也等着；
      // 已经定性成正文了，就把「后面不会再变」的那一段先吐出去
      if (!fence && !undecided(buf) && (done > 0 || blockOf(buf).kind === "p")) {
        const cut = safeCut(buf.slice(done), prev);
        if (cut > 0) {
          out += inlineFrom(buf.slice(0, done + cut), done, color, prev);
          prev = prevAt(buf, done + cut, done);
          done += cut;
        }
      }
      return out;
    },
    end() {
      let out = "";
      if (buf) out += done > 0 ? inlineFrom(buf, done, color, prev) + "\n" : renderLine(buf);
      else if (done > 0) out += "\n";
      buf = ""; done = 0; fence = ""; prev = "";
      return out;
    },
  };
}

module.exports = { createRenderer, inline, blockOf, safeCut, undecided };
