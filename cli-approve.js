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
 * @param {{kind?: string, text?: string, rule?: string, source?: string}} entry
 * @param {{width?: number, paint?: (s: string, kind: string) => string}} [o]
 * @returns {string} 以换行结尾
 */
function render(entry, o) {
  const opt = o || {};
  const paint = opt.paint || ((s) => s);
  const width = Math.max(30, Number(opt.width) || 80);
  const e = entry || {};
  const lines = [""];
  lines.push(paint(`⚠ 要你点头：${String(e.kind || "危险操作").trim()}`, "warn"));
  if (e.rule) lines.push(paint(`  拦它的规则：${e.rule}`, "detail"));
  // 谁在求批准。多个任务并行时（网页上还开着一趟），不写清楚等于让人替陌生任务签字
  if (e.source) lines.push(paint(`  来自任务：${String(e.source).slice(0, 60)}`, "detail"));
  lines.push("");
  // 原文整条印，缩进两格当引文。危险就危险在那半截被截掉的地方
  for (const ln of wrap(String(e.text || "").trim(), width - 4)) lines.push("  " + paint(ln, "code"));
  lines.push("");
  const nw = String(CHOICES.length).length;
  CHOICES.forEach((c, i) => {
    lines.push("  " + paint(String(i + 1).padStart(nw) + ".", "n") + " " + paint(c.label, "label"));
    lines.push(" ".repeat(2 + nw + 2) + paint(c.sub, "detail"));
  });
  lines.push("");
  lines.push(paint(hint(), "hint"));
  return lines.join("\n") + "\n";
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
    choices: CHOICES.map((c) => ({ allow: c.allow, scope: c.scope, label: c.label, sub: c.sub })),
    deadline: Number(deadline) || 0,
  };
}

module.exports = { render, parse, run, hint, card, waitText, CHOICES, MAX_TRIES };
