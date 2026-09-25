"use strict";
/**
 * 终端里批准一次危险操作 —— 纯的：不碰 process、不碰 fs、不打印、不读键盘。
 *
 * 跟 cli-ask.js 是一对，但问的是两码事：那边是「你想要哪一种」，这边是
 * 「它要动手了，准不准」。后者答错的代价不对称——手滑按了「允许」，`rm -rf` 就真跑了。
 * 所以这一层跟提问那层有三处故意不一样：
 *
 *   1. **没有默认答案。** 提问那边空行＝第 1 条，问到那步的人多半就想按默认走。
 *      审批这边空行什么都不算，得再问一遍：一个回车不该等于放行一条删库命令。
 *   2. **命令原文必须整条印出来，不截断。** 截断正好把 `| sh`、`--force`、
 *      末尾那个真正危险的路径吃掉——人看着前半截以为没事，点了允许。
 *   3. **拒绝比允许好打。** n、no、不、回车之外随便打点什么，都不会变成放行。
 *      认不出来只当没答，绝不往「允许」上靠。
 *
 * 终端认按键时（TTY），三档摆成一张 ↑↓ 挑的单子，跟 Claude Code / Codex 一样：光标停在
 * 第 1 条，回车就是选它。这跟第 1 条不冲突——单子摆在眼前、看着光标按下的回车是个选择；
 * 要防的是**单子出来之前**就敲进缓冲区的那个键，所以刚摆出来那一小会儿的回车、数字、字母
 * 一律不认（ENTER_GUARD_MS）。过了这一小会儿，数字键和 y / n 直接选；Esc 就是不允许。
 * 单键只认提示行里写着的那几个——a、「好」这种留给敲一行那条路，单键下它们多半是人在打字。
 * 不认按键的地方（管道、--json）还是敲一行，空行照旧不算。
 *
 * 「怎么读键盘、超时怎么算、谁来调 security.resolveApproval」都在 cli.js 那边。
 */

const { cols } = require("./text-width");
const { wrap } = require("./cli-ask"); // 折行规则两边必须一样，中文占两列

/** 三档的含义。scope 直接喂给 security.resolveApproval */
const CHOICES = [
  { keys: ["1", "y", "yes", "允许", "准", "好", "可以"], allow: true, scope: "once", label: "这一次允许", sub: "只放这一条，下次同样的还会再问" },
  { keys: ["2", "a", "all", "always", "都允许", "别问了"], allow: true, scope: "session", label: "这类都允许", sub: "本次运行期间同类不再问；关掉这个终端就失效" },
  { keys: ["3", "n", "no", "不", "拒", "拒绝", "别"], allow: false, scope: "once", label: "不允许", sub: "这一步不做，它会换别的办法或者告诉你卡在哪" },
];

/**
 * 把一次审批画成终端里的样子。
 *
 * @param {{kind?: string, text?: string, rule?: string, source?: string, detail?: string}} entry
 * @param {{width?: number, paint?: (s: string, kind: string) => string}} [o]
 * @returns {string} 以换行结尾
 */
function render(entry, o) {
  const opt = o || {};
  const lines = head(entry, opt);
  const paint = opt.paint || ((s) => s);
  const nw = String(CHOICES.length).length;
  CHOICES.forEach((c, i) => {
    lines.push("  " + paint(String(i + 1).padStart(nw) + ".", "n") + " " + paint(c.label, "label"));
    lines.push(" ".repeat(2 + nw + 2) + paint(c.sub, "detail"));
  });
  lines.push("");
  lines.push(paint(hint(), "hint"));
  return lines.join("\n") + "\n";
}

/** 卡片上半截：谁要干什么、原文、diff。两种摆法（敲序号 / ↑↓ 挑）共用 */
function head(entry, o) {
  const opt = o || {};
  const paint = opt.paint || ((s) => s);
  const width = Math.max(30, Number(opt.width) || 80);
  const e = entry || {};
  const lines = [""];
  lines.push(paint(`⚠ 要你点头：${String(e.kind || "危险操作").trim()}`, "warn"));
  if (e.rule) lines.push(paint(`  拦它的规则：${e.rule}`, "detail"));
  // 长命令里具体是哪一段被拦：几百字的原文里，危险的那句往往藏在尾巴上
  const seg = String(e.seg || "").trim();
  if (seg && seg !== String(e.text || "").trim()) {
    for (const ln of wrap(`触发的片段：${seg}`, width - 4)) lines.push(paint("  " + ln, "detail"));
  }
  // 谁在求批准。多个任务并行时（网页上还开着一趟），不写清楚等于让人替陌生任务签字
  if (e.source) lines.push(paint(`  来自任务：${String(e.source).slice(0, 60)}`, "detail"));
  lines.push("");
  // 原文整条印，缩进两格当引文。危险就危险在那半截被截掉的地方
  for (const ln of wrap(String(e.text || "").trim(), width - 4)) lines.push("  " + paint(ln, "code"));
  // 改文件的 diff：批的是这几行，不是文件名。超过 40 行截掉，真要全看去开文件
  const detail = String(e.detail || "").trim().split("\n").filter(Boolean);
  if (detail.length) {
    lines.push("");
    for (const ln of detail.slice(0, 40)) lines.push("  " + paint(ln, ln.startsWith("+") ? "add" : ln.startsWith("-") ? "del" : "detail"));
    if (detail.length > 40) lines.push("  " + paint(`… 还有 ${detail.length - 40} 行`, "detail"));
  }
  lines.push("");
  return lines;
}

/** 刚摆出来这么久之内的回车、数字、字母都不认：那是单子出来之前就敲进缓冲区的，不是看着光标按的 */
const ENTER_GUARD_MS = 400;

/**
 * ↑↓ 挑的那张单子。光标所在那条亮着、带说明；别的只留一行名字。
 * @param {number} sel 光标在第几条（0 起）
 * @returns {string[]} 不带换行的行
 */
function menu(sel, o) {
  const opt = o || {};
  const paint = opt.paint || ((s) => s);
  // 一行都不许折：重画是按行数往回擦的，折一行就擦少一行，旧单子的尾巴留在屏幕上。
  // 放不下就先丢说明、再换短的提示——三档本身的名字永远在
  const room = Math.max(20, Number(opt.width) || 80) - 3;
  const lines = [];
  CHOICES.forEach((c, i) => {
    const on = i === sel;
    const name = `${i + 1}. ${c.label}`;
    const sub = on && cols(`❯ ${name}  ${c.sub}`) <= room ? "  " + paint(c.sub, "detail") : "";
    lines.push((on ? paint("❯", "n") : " ") + " " + paint(name, on ? "label" : "detail") + sub);
  });
  lines.push("");
  const hints = [
    `↑↓ 选 · 回车确定 · 1/2/3 或 y/n · Esc 不允许${opt.wait ? ` · ${opt.wait}没人点算不允许` : ""}`,
    `↑↓ 选 · 回车确定 · 1/2/3 · Esc 不允许${opt.wait ? ` · ${opt.wait}没人点算不允许` : ""}`,
    "↑↓ 选 · 回车确定 · 1/2/3 · Esc 不允许",
    "↑↓ 回车 · 1/2/3 · Esc 不允许",
  ];
  lines.push(paint(hints.find((h) => cols(h) <= room) || hints[hints.length - 1], "hint"));
  return lines.map((l) => (l ? "  " + l : ""));
}

/**
 * 一个键进来，单子怎么变。纯的：光标、选中、放弃都由返回值说。
 * @param {number} sel 现在光标在哪
 * @param {{name?: string, ctrl?: boolean, meta?: boolean}} key readline 的 keypress
 * @param {string} ch 那个键吐的字
 * @param {number} sinceMs 单子摆出来多久了
 * @returns {{sel: number}|{pick: number}|{cancel: true}|null} null = 这个键不管
 */
function menuKey(sel, key, ch, sinceMs) {
  const k = key || {};
  const n = CHOICES.length;
  if (k.ctrl && (k.name === "c" || k.name === "d")) return { cancel: true };
  if (k.name === "escape") return { pick: n - 1 }; // Esc＝不允许，明说出来，模型好换路
  if (k.name === "up" || (!k.ctrl && k.name === "k")) return { sel: (sel + n - 1) % n };
  if (k.name === "down" || (!k.ctrl && k.name === "j") || k.name === "tab") return { sel: (sel + 1) % n };
  // 刚摆出来那一小会儿到的键一律不认：回车、数字、字母都可能是单子出来之前敲进缓冲区的
  if (sinceMs < ENTER_GUARD_MS) return null;
  if (k.name === "return" || k.name === "enter") return { pick: sel };
  const c = String(ch || "").toLowerCase();
  if (/^[1-9]$/.test(c) && Number(c) <= n) return { pick: Number(c) - 1 };
  // 单键只认提示行里写着的 y / n。a 没写出来、还是放得最宽的那档；中文词在单键下
  // 只会是输入法整词上屏的头一个字——人在打一句话，不是在点头。这些留给敲一行那条路（parse）
  if (c === "y") return { pick: 0 };
  if (c === "n") return { pick: n - 1 };
  return null;
}

/** 提示行。不写「回车＝允许」，因为回车什么都不是——这是这层最要紧的一句 */
function hint() {
  return "  敲序号，或者 y / n；Ctrl+C 和干等都算不允许";
}

/**
 * 人敲的那半截是什么意思。
 *
 * 认不出来一律 null（再问一遍），绝不猜成允许。这跟 cli-ask 的「自由回答」相反：
 * 那边猜错只是模型少一条 detail，这边猜错是一条命令真的跑了。
 *
 * @param {string} input
 * @returns {{allow: boolean, scope: "once"|"session"}|null}
 */
function parse(input) {
  const raw = String(input == null ? "" : input).trim().toLowerCase();
  if (!raw) return null; // 空行不是答案：一个回车不该放行一条删库命令
  for (const c of CHOICES) if (c.keys.includes(raw)) return { allow: c.allow, scope: c.scope };
  return null;
}

/** 认不出来最多再问几遍。够两次手滑，不够把人磨到乱按 */
const MAX_TRIES = 3;

/**
 * 摆出审批、等一个答复 —— 整个来回都在这儿，所以能在没有终端的地方被完整测出来。
 *
 * @param {object} entry security.watchApprovals 给的那条
 * @param {{
 *   write: (s: string) => void,
 *   readLine: (prompt: string, timeoutMs: number) => Promise<string|null>,
 *   timeoutMs?: number,
 *   width?: number,
 *   paint?: (s: string, kind: string) => string,
 * }} io
 * @returns {Promise<{allow: boolean, scope: string}|null>} null = 没人答，交给上游按超时处理
 */
async function run(entry, io) {
  const paint = io.paint || ((s) => s);
  const timeoutMs = Math.max(5000, Number(io.timeoutMs) || 120000);
  if (io.pick) {
    // 终端认按键：上半截照印，三档交给 cli.js 摆成 ↑↓ 单子。它还回 "1"/"2"/"3" 或 null
    io.write(head(entry, { width: io.width, paint }).join("\n") + "\n");
    const got = await io.pick({ menu: (sel) => menu(sel, { paint, width: io.width, wait: waitText(timeoutMs) }), key: menuKey }, timeoutMs);
    return got == null ? null : parse(String(got));
  }
  io.write(render(entry, { width: io.width, paint }));
  io.write(paint(`  （${waitText(timeoutMs)}内没人点，按不允许算）\n`, "hint"));
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const line = await io.readLine("准不准> ", timeoutMs);
    if (line == null) return null; // 超时 / Ctrl+C / 手机上已经有人答了
    const v = parse(line);
    if (v) return v;
    io.write(paint("  没听懂。敲 1 / 2 / 3，或者 y / n。\n", "warn"));
  }
  return null;
}

/** 「2 分钟」比「120 秒」好读 */
function waitText(ms) {
  const secs = Math.round(Math.max(0, Number(ms) || 0) / 1000);
  return secs >= 60 ? `${Math.round(secs / 60)} 分钟` : `${secs} 秒`;
}

/** 摆到手机上的那张卡片。字段名跟网页端的审批卡对齐，那边不用另写一套渲染 */
function card(entry, deadline) {
  const e = entry || {};
  return {
    id: String(e.id || ""),
    type: "approval",
    kind: String(e.kind || "危险操作"),
    text: String(e.text || ""),
    rule: String(e.rule || ""),
    source: String(e.source || ""),
    detail: String(e.detail || ""), // 改文件的 diff，手机上的卡也给看
    seg: String(e.seg || ""), // 触发审批的那一段，跟网页审批条一样摆出来
    choices: CHOICES.map((c) => ({ allow: c.allow, scope: c.scope, label: c.label, sub: c.sub })),
    deadline: Number(deadline) || 0,
  };
}

module.exports = { render, parse, run, hint, card, waitText, menu, menuKey, CHOICES, MAX_TRIES, ENTER_GUARD_MS };
