"use strict";
/**
 * 终端里回答 agent 的提问 —— 纯的：不碰 process、不碰 fs、不打印、不读键盘。
 *
 * 起因是一处说不过去的事：agent.js 的 ask_user 工具要一个 askUser 回调才认为「有人在线」，
 * 而 cli.js 从来没传过。于是最近在场的那个人——正坐在终端前、手还搁在键盘上的那个——
 * 恰恰是唯一一个 agent 永远问不到的人。模型收到的是
 * 「当前是无人值守运行，没人在线回答。按你判断的最合理默认继续做」，
 * 然后它就真的去猜了：报告该交 Word 还是 PDF、封面走生图还是排版，全靠猜。
 * 网页端点一下就过的岔路，在终端里变成一次赌博。
 *
 * 这一层只负责两件能被测试钉死的事：**问题长什么样**、**人敲的那半截算选了哪条**。
 * 怎么读键盘、超时怎么算、readline 归谁管，都在 cli.js 那边。
 */

const { cols } = require("./text-width"); // 中文占两列，量宽一律走它

/**
 * 按显示宽度折行，中文不会被切成半个字。
 * 不按空格断词：中文没有空格，按词断等于整段不折。
 * @param {string} s
 * @param {number} width 可用列数
 * @returns {string[]}
 */
function wrap(s, width) {
  const w = Math.max(8, Number(width) || 60);
  const out = [];
  for (const para of String(s == null ? "" : s).split("\n")) {
    let line = "";
    let n = 0;
    for (const ch of para) {
      const c = cols(ch);
      if (n + c > w) { out.push(line); line = ""; n = 0; }
      line += ch;
      n += c;
    }
    out.push(line);
  }
  return out;
}

/**
 * 把一次提问画成终端里的样子。
 *
 * detail 是必须印出来的：agent.js 的提示词里写死了「detail 是用户唯一的判断依据，不许省」——
 * 只印 label 的话，「AI 生图 / HTML 排版截图」这种选项对不写代码的人就是两个没有差别的词。
 *
 * @param {{question: string, options?: Array<{label: string, detail?: string}|string>}} ask
 * @param {{width?: number, paint?: (s: string, kind: "q"|"n"|"label"|"detail"|"hint") => string}} [o]
 * @returns {string} 以换行结尾，可以直接 write 出去
 */
function render(ask, o) {
  const opt = o || {};
  const paint = opt.paint || ((s) => s);
  const width = Math.max(30, Number(opt.width) || 80);
  const items = normalize(ask && ask.options);
  const lines = [];
  lines.push("");
  for (const ln of wrap(String((ask && ask.question) || "").trim(), width - 2)) lines.push(paint("？ " + ln, "q"));
  // 序号右对齐到两位：超过 9 条时左边那列才不会参差（agent.js 最多给 6 条，但别靠这个）
  const nw = String(items.length).length;
  items.forEach((it, i) => {
    const n = String(i + 1).padStart(nw);
    lines.push("  " + paint(n + ".", "n") + " " + paint(it.label, "label"));
    if (!it.detail) return;
    // detail 缩进到跟 label 对齐：视线一竖下来就知道这段是在解释上面那条
    const pad = " ".repeat(2 + nw + 2);
    for (const ln of wrap(it.detail, width - pad.length)) lines.push(pad + paint(ln, "detail"));
  });
  lines.push("");
  lines.push(paint(hint(items.length), "hint"));
  return lines.join("\n") + "\n";
}

/** 提示行。没有选项时问的是开放问题，别提「敲序号」——那会让人去找根本不存在的编号 */
function hint(count) {
  return count
    ? `  敲序号选一条，或者直接打你的想法；回车＝第 1 条；Ctrl+C 让它自己定`
    : `  直接打你的回答；Ctrl+C 让它自己定`;
}

/** 选项统一成 {label, detail}：老会话回放和模型偷懒直接给字符串的情况都得认 */
function normalize(options) {
  return (Array.isArray(options) ? options : [])
    .map((x) => (x && typeof x === "object"
      ? { label: String(x.label || "").trim(), detail: String(x.detail || "").trim() }
      : { label: String(x == null ? "" : x).trim(), detail: "" }))
    .filter((x) => x.label);
}

/**
 * 人敲的那半截是什么意思。
 *
 * 认四种：序号、整条 label、label 的一部分（唯一命中才算）、以及**随便打的一句话**。
 * 最后一种是故意留的：选项是模型列的，模型列漏了很正常，这时候人该能直接说
 * 「都不要，用飞书文档」而不是被逼着在两个错答案里挑一个。agent.js 那边收到
 * 对不上任何 label 的回答也不会出错——它只是拿不到 detail 而已。
 *
 * 空行＝第 1 条：问到这一步的人多半就想按默认走，让他多敲一个字符没有道理。
 * 没有选项时空行不算数——开放问题没有默认答案可选。
 *
 * @param {string} input
 * @param {Array} options
 * @returns {{kind:"pick",label:string,index:number}
 *          |{kind:"free",text:string}
 *          |{kind:"many",labels:string[]}
 *          |{kind:"outofrange",n:number,count:number}
 *          |{kind:"empty"}}
 */
function parse(input, options) {
  const items = normalize(options);
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return items.length ? { kind: "pick", label: items[0].label, index: 0 } : { kind: "empty" };

  // 纯数字先当序号。越界不能悄悄按「随口说了句话」放过去——人是真的想选第 7 条，
  // 把「7」当自由回答发给模型，模型只会看见一个孤零零的 7
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (items.length && n >= 1 && n <= items.length) return { kind: "pick", label: items[n - 1].label, index: n - 1 };
    if (items.length) return { kind: "outofrange", n, count: items.length };
  }

  const low = raw.toLowerCase();
  const exact = items.findIndex((x) => x.label.toLowerCase() === low);
  if (exact >= 0) return { kind: "pick", label: items[exact].label, index: exact };

  // 一部分也认，但只认唯一命中。两条都沾边时不替人做主——挑错了整件事白做，
  // 那正是 agent.js 规定「只在这种岔路上才问」的原因
  const hits = [];
  items.forEach((x, i) => { if (x.label.toLowerCase().includes(low)) hits.push(i); });
  if (hits.length === 1) return { kind: "pick", label: items[hits[0]].label, index: hits[0] };
  if (hits.length > 1) return { kind: "many", labels: hits.map((i) => items[i].label) };

  return { kind: "free", text: raw };
}

/** 没选中时说给人听的那句。怎么上色由 cli.js 决定 */
function retryText(v) {
  if (v.kind === "outofrange") return `只有 ${v.count} 条，没有第 ${v.n} 条。`;
  if (v.kind === "many") return `「${v.labels.join("、")}」都对得上，写序号或者说全一点。`;
  return "";
}

/** 认不出来最多再问几遍。问到第四遍，人要重读的不是题目是自己的耐心 */
const MAX_TRIES = 3;

/**
 * 摆出问题、等一个答案 —— 整个来回都在这儿，所以它能在没有终端的地方被完整测出来。
 *
 * cli.js 只负责把 io 递进来：往哪儿写（stderr）、怎么读一行（交互模式走常驻 readline，
 * 单发模式现开一个）、超时和 Ctrl+C 怎么变成一个 null。这一层不认识它们中的任何一个。
 *
 * @param {{question: string, options?: any[], timeoutMs?: number}} ask
 * @param {{
 *   write: (s: string) => void,
 *   readLine: (prompt: string, timeoutMs: number) => Promise<string|null>,
 *   width?: number,
 *   paint?: (s: string, kind: string) => string,
 * }} io
 * @returns {Promise<string|null>} null = 没人回答，agent 会按自己的判断继续
 */
async function run(ask, io) {
  const paint = io.paint || ((s) => s);
  const options = normalize(ask && ask.options);
  const timeoutMs = Math.max(30000, Number(ask && ask.timeoutMs) || 300000);
  io.write(render({ question: (ask && ask.question) || "", options }, { width: io.width, paint }));
  io.write(paint(`  （${waitText(timeoutMs)}内没回，它就按自己的判断接着做）\n`, "hint"));
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const line = await io.readLine("答> ", timeoutMs);
    if (line == null) return null; // 超时 / Ctrl+C / Ctrl+D
    const v = parse(line, options);
    if (v.kind === "pick") { io.write(paint(`  选了：${v.label}\n`, "hint")); return v.label; }
    if (v.kind === "free") return v.text; // 选项列漏了是常事，人该能直接说别的
    if (v.kind === "empty") return null;  // 开放问题上敲空行 = 不想答
    io.write(paint("  " + retryText(v) + "\n", "warn"));
  }
  return null;
}

/** 「5 分钟」比「300 秒」好读；不到一分钟的就按秒说 */
function waitText(ms) {
  const secs = Math.round(Math.max(0, Number(ms) || 0) / 1000);
  return secs >= 60 ? `${Math.round(secs / 60)} 分钟` : `${secs} 秒`;
}

module.exports = { render, parse, normalize, wrap, hint, retryText, run, waitText, MAX_TRIES };
