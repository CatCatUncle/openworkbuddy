"use strict";
/**
 * 终端里一次工具调用长什么样 —— 纯的：不碰 process，宽度和颜色由调用方给。
 *
 * 跟 Claude Code / Codex 的读法对齐：上一行「● 动作(对象)」，下面「└ 结果」缩进挂着，
 * 命令的输出露头几行、剩下的只说还有多少。以前是「▸ run_shell（用浏览器打开游戏） ✓」——
 * 看得见它调了哪个工具，看不见它**跑了哪条命令、输出了什么**，想核对只能翻会话文件。
 *
 *   ● Shell(npm test)
 *     └ 38 passing
 *       … 还有 12 行
 *
 * 并发跑的工具结果回来的顺序不一定：结果那行前面要是别人的调用，就把自己那行「● …」再印一遍，
 * 免得 └ 挂错爹（cli.js 那边按 id 记着调用）。
 */

const { cols } = require("./text-width");

/** 常用工具的短名。没列的照原名——那也是模型和网页上看到的名字 */
const LABEL = {
  run_shell: "Shell", run_node: "Node", read_file: "Read", write_file: "Write", edit_file: "Edit",
  multi_edit: "Edit", search_files: "Search", find_files: "Find", list_files: "List",
  fetch_url: "Fetch", render_page: "Fetch", web_search: "WebSearch", use_skill: "Skill",
  todo_write: "Todo", shell_output: "ShellOutput", shell_kill: "ShellKill", explore: "Explore",
  ask_user: "Ask", Bash: "Shell", // Bash 是本机 Claude Code 引擎报上来的名字，跟自带的 run_shell 一个样子
};
/** 参数里挑哪个当「对象」，按顺序找第一个有值的 */
const ARG_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "name", "skill", "expert", "team", "prompt", "title", "question"];
/** 输出最多露几行 */
const MAX_LINES = 4;

/** 按显示宽度截断（中文占两列），截掉的换成 … */
function clip(s, width) {
  const t = String(s || "");
  if (cols(t) <= width) return t;
  let out = "";
  for (const ch of t) {
    if (cols(out + ch) > width - 1) break;
    out += ch;
  }
  return out + "…";
}

/** 这次调用的「对象」：命令原文、文件路径、搜的词……拿不到就退回 purpose */
function callArg(ev) {
  const e = ev || {};
  const pv = String(e.input_preview || "");
  if (e.name === "run_shell" || e.name === "run_node") {
    const first = pv.split("\n").map((l) => l.trim()).filter(Boolean);
    if (first.length) return first[0] + (first.length > 1 ? " …" : "");
  } else if (pv) {
    try {
      const j = JSON.parse(pv);
      for (const k of ARG_KEYS) if (j && typeof j[k] === "string" && j[k].trim()) return j[k].trim().replace(/\s+/g, " ");
    } catch {} // input_preview 截到 500 字，长参数的 JSON 是半截，解析不了就退回 purpose
  }
  return String(e.purpose || e.title || "").replace(/\s+/g, " ").trim();
}

/**
 * 「● Shell(npm test)」那一行。
 * @param {object} ev tool_use 事件
 * @param {{width?: number, paint?: (s: string, kind: string) => string}} [o]
 */
function callLine(ev, o) {
  const opt = o || {};
  const paint = opt.paint || ((s) => s);
  const width = Math.max(30, Number(opt.width) || 80);
  const e = ev || {};
  const who = e.expert ? `${e.expert} · ` : "";
  const label = who + (LABEL[e.name] || e.name || "tool");
  const arg = callArg(e);
  const room = width - cols(label) - 4; // 「● 」+ 两个括号
  return paint("●", "bullet") + " " + paint(label, "name") + (arg ? paint(`(${clip(arg, Math.max(8, room))})`, "arg") : "");
}

/** run_shell / run_node 的结果是「stdout:… stderr:… exit code: N」拼起来的，拆回来 */
function splitShell(text) {
  const t = String(text || "");
  const m = /(?:^|\n)exit code: (\S+)\s*$/.exec(t);
  if (!m) return null;
  // 「(用户已停止…)」「(执行超时…)」是 tools.js 贴在 stderr 后面的，先摘出来，不然它会混进最后一段输出里再印一遍
  const NOTE = /(?:^|\n)(\((?:用户已停止|执行超时)[^\n]*\))\n?$/;
  const nm = NOTE.exec(t.slice(0, m.index));
  const note = nm ? nm[1] : "";
  const body = nm ? t.slice(0, nm.index) : t.slice(0, m.index);
  const pick = (tag) => {
    const r = new RegExp(`(?:^|\\n)${tag}:\\n([\\s\\S]*?)(?=\\n(?:stdout|stderr):\\n|$)`).exec(body);
    return r ? r[1].replace(/\n+$/, "") : "";
  };
  return { out: pick("stdout"), err: pick("stderr"), code: m[1], note };
}

/**
 * 「└ …」那几行（不带换行）。
 * @param {object} ev tool_result 事件
 * @param {{width?: number, paint?: (s: string, kind: string) => string, max?: number}} [o]
 * @returns {string[]}
 */
function resultLines(ev, o) {
  const opt = o || {};
  const paint = opt.paint || ((s) => s);
  const width = Math.max(30, Number(opt.width) || 80);
  const max = Math.max(1, Number(opt.max) || MAX_LINES);
  const e = ev || {};
  const text = String(e.preview || "");
  // agent 那边 preview 只给前 800 字，再往后还有多少不知道；本机引擎截得更短，截没截它自己说（cut），
  // 顺带报总行数（lines）的，「还有 N 行」就能说准数
  const cut = !!e.cut || text.length >= 800;
  let body = [];
  const kind = e.isError ? "err" : "out";
  const shellish = e.name === "run_shell" || e.name === "run_node" || e.name === "Bash";
  const sh = shellish ? splitShell(text) : null;
  if (sh) {
    body = [...(sh.out ? sh.out.split("\n") : []), ...(sh.err ? sh.err.split("\n") : [])];
    if (sh.note) body.unshift(sh.note);
    if (sh.code !== "0") body.unshift(`exit code ${sh.code}`);
    if (!body.length) body = ["（没有输出）"];
  } else if (shellish && !String(e.outcome || "").trim()) {
    // 本机引擎（Claude Code 的 Bash、Codex 的命令）给的是命令输出原文，没有 exit code 那行：原样露头几行，
    // 不能跟读文件一样只留第一行——38 passing / 2 failing 恰恰在后面
    body = text.split("\n");
    if (!body.some((l) => l.trim())) body = ["（没有输出）"];
  } else if (e.isError) {
    body = text.replace(/^工具执行出错:\s*/, "").split("\n");
  } else {
    // 读文件、写文件这种：结果全文没必要上屏，一句 outcome 就够；搜索/列目录再露几条命中
    const outcome = String(e.outcome || "").trim();
    body = outcome ? [outcome] : [];
    if (e.name === "search_files" || e.name === "find_files" || e.name === "list_files" || e.name === "web_search") {
      body = body.concat(text.split("\n").filter((l) => l.trim()).slice(0, max));
    }
    if (!body.length) body = [(text.split("\n").find((l) => l.trim()) || "完成").trim()];
  }
  body = body.map((l) => l.replace(/\s+$/, "")).filter((l, i, a) => l || (i > 0 && i < a.length - 1));
  while (body.length && !body[body.length - 1]) body.pop();
  const shown = body.slice(0, max);
  const total = Number(e.lines) > body.length ? Number(e.lines) : 0; // 引擎报了原文一共几行：按它说
  const rest = (total || body.length) - shown.length;
  const out = shown.map((l, i) => (i === 0 ? "  └ " : "    ") + paint(clip(l, width - 4), kind));
  if (rest > 0 || (cut && !e.isError)) out.push("    " + paint(rest > 0 ? `… 还有 ${rest}${cut && !total ? "+" : ""} 行` : "… 后面还有", "more"));
  return out;
}

module.exports = { callLine, resultLines, callArg, splitShell, clip, LABEL, MAX_LINES };
