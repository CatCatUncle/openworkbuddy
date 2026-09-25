// @ts-check
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
 *
 * 终端认按键时（TTY），选项摆成一张 ↑↓ 挑的单子，跟审批那张（cli-approve）一个样子，
 * 最后多一条「都不是，我自己打一句」退回敲一行。不认按键的地方（管道、--json）还是敲序号那套。
 */

const { cols } = require("./text-width"); // 中文占两列，量宽一律走它
const { clip } = require("./cli-toolview"); // 按显示宽度截断；那边也是纯的，不会绕回来引这边

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
  const lines = head(ask, opt);
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

/** 问题那几行，前面空一行。两种摆法（敲序号 / ↑↓ 挑）共用 */
function head(ask, o) {
  const opt = o || {};
  const paint = opt.paint || ((s) => s);
  const width = Math.max(30, Number(opt.width) || 80);
  const lines = [""];
  for (const ln of wrap(String((ask && ask.question) || "").trim(), width - 2)) lines.push(paint("？ " + ln, "q"));
  return lines;
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

/**
 * 刚摆出来这么久之内按的键，除了挪光标和 Ctrl+C 一律不认（跟审批那张同一个数）。
 * 那是单子出来之前就敲进缓冲区的，不是看着光标按的——而这道题问的偏偏是花钱、
 * 覆盖、对外发布这类岔路。另写一份是因为 cli-approve 要引这边的 wrap，反过来引就成环了
 */
const ENTER_GUARD_MS = 400;

/** 单子最后那一条。选项是模型列的，列漏了很正常，人得能直接说别的 */
const OWN = "都不是，我自己打一句";

/**
 * ↑↓ 挑的那张单子。光标所在那条亮着，最后一条是「自己打一句」。
 *
 * 跟审批那张不一样：detail 每条都摆着。审批三档的说明是写死的短句，这边的 detail
 * 是人唯一的判断依据，得能一眼比着看，不能逼人把光标挨个挪过去才看得见。
 * 屏幕放不下时才退成只有光标那条带说明。
 *
 * @param {number} sel 光标在第几条（0 起）
 * @param {Array} options
 * @param {{width?: number, rows?: number, wait?: string, paint?: (s: string, kind: string) => string}} [o]
 * @returns {string[]} 不带换行的行
 */
function menu(sel, options, o) {
  const opt = o || {};
  const paint = opt.paint || ((s) => s);
  // 一行都不许折：重画是按行数往回擦的，折一行就擦少一行，旧单子的尾巴留在屏幕上。
  // 名字放不下就截；说明按宽度自己折好，每一行都放得下
  const room = Math.max(20, Number(opt.width) || 80) - 3;
  const items = normalize(options).concat([{ label: OWN, detail: "" }]);
  const nw = String(items.length).length;
  const pad = " ".repeat(2 + nw + 2); // 说明缩进到跟名字对齐
  const block = (all) => {
    const out = [];
    items.forEach((it, i) => {
      const on = i === sel;
      const name = clip(`${String(i + 1).padStart(nw)}. ${it.label}`, room - 2);
      out.push((on ? paint("❯", "n") : " ") + " " + (on ? paint(name, "label") : name));
      if (it.detail && (all || on)) for (const ln of wrap(it.detail, room - pad.length)) out.push(pad + paint(ln, "detail"));
    });
    return out;
  };
  // 连同空行和提示行得比屏幕矮一行：高过屏幕，往回擦就够不着顶了
  const fit = Math.max(8, Number(opt.rows) || 24) - 1;
  let lines = block(true);
  if (lines.length + 2 > fit) lines = block(false);
  lines.push("");
  const hints = [
    `↑↓ 选 · 回车确定 · 数字直接选 · Esc${opt.wait ? ` 或 ${opt.wait}没人答就` : " "}让它自己定`,
    "↑↓ 选 · 回车确定 · 数字直接选 · Esc 让它自己定",
    "↑↓ 回车 · 数字 · Esc 跳过",
  ];
  lines.push(paint(hints.find((h) => cols(h) <= room) || hints[hints.length - 1], "hint"));
  return lines.map((l) => (l ? "  " + l : ""));
}

/**
 * 一个键进来，单子怎么变。n 是选项条数（不算「自己打一句」那条）——termPick 调它时
 * 只给 (光标, 键, 字, 摆出来多久)，所以做成先拿 n 的样子。
 * @param {number} n
 * @returns {(sel: number, key: any, ch: string, sinceMs: number) => {sel: number}|{pick: number}|{skip: true}|{cancel: true}|null}
 *   pick 是第几条（0 起，n 就是「自己打一句」）；skip = Esc，这题交给它自己定；null = 这个键不管
 */
function menuKey(n) {
  const total = Math.max(0, Number(n) || 0) + 1;
  return (sel, key, ch, sinceMs) => {
    const k = key || {};
    if (k.ctrl && (k.name === "c" || k.name === "d")) return { cancel: true };
    if (k.name === "up" || (!k.ctrl && k.name === "k")) return { sel: (sel + total - 1) % total };
    if (k.name === "down" || (!k.ctrl && k.name === "j") || k.name === "tab") return { sel: (sel + 1) % total };
    if (sinceMs < ENTER_GUARD_MS) return null; // 回车、数字、Esc 都算拍板，刚摆出来的不认
    // Esc 不是 cancel：cancel 会把这趟活儿整个停掉，Esc 只是「这题你定」
    if (k.name === "escape") return { skip: true };
    if (k.name === "return" || k.name === "enter") return { pick: sel };
    const c = String(ch || "");
    if (/^[1-9]$/.test(c) && Number(c) <= total) return { pick: Number(c) - 1 };
    return null;
  };
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
 *   pick?: (p: {menu: (sel: number) => string[], key: Function}, timeoutMs: number) => Promise<{key?: string, text?: string}|null>,
 *   width?: number,
 *   rows?: number,
 *   paint?: (s: string, kind: string) => string,
 * }} io
 * @returns {Promise<string|null>} null = 没人回答，agent 会按自己的判断继续
 */
async function run(ask, io) {
  const paint = io.paint || ((s) => s);
  const options = normalize(ask && ask.options);
  const timeoutMs = Math.max(30000, Number(ask && ask.timeoutMs) || 300000);
  if (io.pick && options.length) {
    // 终端认按键：问题照印，选项交给 cli.js 摆成 ↑↓ 单子。开放问题没得挑，还是敲一行。
    // 还回来的分两种装：{key} 是终端上选的第几条（"1" 起），{text} 是手机上答的那句——
    // 不分开的话，手机上打了个「3」跟终端上选第 3 条就长得一模一样
    io.write(head(ask, { width: io.width, paint }).join("\n") + "\n");
    const got = await io.pick({ menu: (sel) => menu(sel, options, { paint, width: io.width, rows: io.rows, wait: waitText(timeoutMs) }), key: menuKey(options.length) }, timeoutMs);
    if (got == null) return null; // 超时 / Esc / Ctrl+C
    if (typeof got.text === "string") {
      // 跟敲一行同一套认法；认不准就原样交出去——手机那头没法再问一遍
      const v = parse(got.text, options);
      return v.kind === "pick" ? v.label : String(got.text).trim() || null;
    }
    const i = Number(got.key) - 1;
    if (i >= 0 && i < options.length) { io.write(paint(`  选了：${options[i].label}\n`, "hint")); return options[i].label; }
    // 选的是「自己打一句」。这儿空行不是第 1 条：人刚说了「都不是」
    io.write(paint("  打你的想法，回车发出；空着回车就让它自己定\n", "hint"));
    const line = await io.readLine("答> ", timeoutMs);
    return String(line == null ? "" : line).trim() || null;
  }
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

module.exports = { render, parse, normalize, wrap, hint, retryText, run, waitText, menu, menuKey, OWN, MAX_TRIES, ENTER_GUARD_MS };
