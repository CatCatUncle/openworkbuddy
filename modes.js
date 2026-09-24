// @ts-check
"use strict";
/**
 * 所有「模式」的唯一真源。
 *
 * 起因是用户在终端和界面之间来回切时发现的一件事：**网页上有四个模式，命令行只有三个**。
 * 不是谁漏做了，是 Goal 从来就只活在 server.js 的 `/api/chat` 里——它不是 agent 认识的模式，
 * 而是套在 craft 外面的一层「拆验收标准 → 跑 → 验收 → 没达标再跑」。命令行没有那层壳，
 * 于是同一个产品在两个入口长着不同的样子。
 *
 * 更糟的是那三个字符串被手抄在八个地方：cli.js 两处、cli-args.js、repl-commands.js、
 * server.js、public/index.html、app-02.js、app-07-canvas.js（当时还没拆）。抄八份的后果不是"可能会漂"，
 * 是**已经漂了**——`/mode goal` 在终端里能敲进去，校验一个字都没有，然后
 * `["ask","plan","craft"].includes("goal")` 判 false，悄悄按 craft 跑，
 * 而状态行还理直气壮地印着「模式 goal」。用户看到的是一个不存在的模式在替他干活。
 *
 * 所以这个文件只做一件事：**把模式写一遍**。谁要用谁来读，别再抄。
 * 前端那两份（index.html 的菜单、app-02.js 的图标表）没法 require 它，
 * 那就让 test/modes.js 去比对——抄可以，漂不行，漂了测试红。
 *
 * 两族模式是不同的东西，别混：
 *   · 执行模式 EXEC_MODES —— 「这趟活儿怎么干」：只答 / 只规划 / 干完 / 干到达标。用户自己选。
 *   · 权限档位 PERMISSION_MODES —— 「允许它动多少东西」：只看 / 每步问 / 自动改文件 / 全自动。
 *     这层是闸门，越权的操作要走审批（见 security.js）。
 */

/**
 * 界面和命令行里那四个执行模式。
 *
 * agent：这个模式最终喂给 agent.js 的是哪个。agent 只认识 ask/plan/craft 三个——
 *   Goal 是外面那层循环，对 agent 来说它就是 craft。这一列存在的意义是让
 *   「界面四个、内核三个」变成一句可读的映射，而不是散在各处的 includes 判断。
 * goal：要不要套目标验收那层壳。
 */
const EXEC_MODES = [
  { id: "craft", label: "Craft · 执行", sub: "完整执行并交付成果", icon: "circle-check", agent: "craft", goal: false },
  { id: "goal", label: "Goal · 目标", sub: "拆解验收标准，没达成自动再跑", icon: "target", agent: "craft", goal: true },
  { id: "plan", label: "Plan · 规划", sub: "只出执行计划不动手", icon: "map", agent: "plan", goal: false },
  { id: "ask", label: "Ask · 问答", sub: "只读问答不改文件", icon: "message-circle", agent: "ask", goal: false },
];

/** agent.js 真正认识的三个。别拿它当用户可选项——用户看见的是 EXEC_MODES */
const AGENT_MODES = ["ask", "plan", "craft"];

const MODE_IDS = EXEC_MODES.map((m) => m.id);
/** 参数提示和补全里那串 `craft|goal|plan|ask`，别再手写 */
const MODE_ARG = MODE_IDS.join("|");
const DEFAULT_MODE = "craft";

const BY_ID = new Map(EXEC_MODES.map((m) => [m.id, m]));

function modeOf(mode) { return BY_ID.get(String(mode || "")) || null; }
/** 认不出来的一律当默认档。校验该在入口做（见 isMode），这儿只负责别炸 */
function normalizeMode(mode) { return BY_ID.has(String(mode || "")) ? String(mode) : DEFAULT_MODE; }
function isMode(mode) { return BY_ID.has(String(mode || "")); }
/** 喂给 agent.runTask 的那个值。goal → craft，其余原样 */
function agentMode(mode) { return (modeOf(mode) || BY_ID.get(DEFAULT_MODE)).agent; }
/** 要不要跑目标验收循环 */
function isGoalMode(mode) { return !!(modeOf(mode) || {}).goal; }
function modeLabel(mode) { return (modeOf(mode) || {}).label || String(mode || ""); }
/** 敲错模式时说给人听的那句：告诉他有哪些，别只说「不认识」 */
function modeHint(bad) {
  return `没有「${String(bad)}」这个模式。有的是：` + EXEC_MODES.map((m) => `${m.id}（${m.sub}）`).join("、");
}

/**
 * 权限档位（只看不动 / 每步都问 / 自动改文件 / 全自动）不在这个文件里，它在 `security.js`。
 *
 * 那一族本来就没有漂：界面是从 `/api/security/modes` 把 `security.PERMISSION_MODES` 原样取回去渲染的，
 * 没有人手抄第二份。执行模式该学的就是它——所以下面 EXEC_MODES 也走同一条路，
 * 由 `/api/modes` 发给前端，而不是让前端再抄一遍。
 */

module.exports = {
  EXEC_MODES, AGENT_MODES, MODE_IDS, MODE_ARG, DEFAULT_MODE,
  modeOf, normalizeMode, isMode, agentMode, isGoalMode, modeLabel, modeHint,
};
