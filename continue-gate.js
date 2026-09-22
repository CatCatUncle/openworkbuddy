"use strict";
/**
 * 自动续跑之前的那道闸。
 *
 * 自动续跑的判据只有一条：这一轮是怎么停的。撞了步数或时间上限 → 认为「活儿还在」→
 * 重置预算再来一轮，每轮都是一整份新的时间和步数预算。可「撞上限」并不等于「没干完」：
 * 活儿其实做完了、最后几步在收尾对账，照样能把步数用光。这种时候续一轮，是拿三十分钟的
 * 预算去买一句「我又确认了一遍，都做完了」——而且它还会接着续，直到轮数用光。
 *
 * 结构上本来就有一把免费的尺子：进度档里还有没打勾的条目 = 确定没干完，闭着眼续，一分不花。
 * 尺子够不着的只有两种局面——工作目录里压根没有进度档，或者条目全打勾了却还在跑。
 * 那一段才轮到判断模型问一道是非题，而且：
 *
 *   - **只停，不改判别的**。它只决定「这一轮之后还续不续」，不动这一轮已经产出的东西。
 *   - **只在它说「没剩了」并且自己也有把握时才停**。拿不准、答不上、没配、问不成、超时，
 *     一律照老样子续跑——闸坏了要退回老行为，不能把一趟还没干完的活儿停在这儿。
 *   - **停了要说清怎么接着做**。误停的代价必须是一句「接着上次进度做」，不能是活儿不见了。
 *
 * 这儿一个字的网络都不发（连 require jev 都没有），发请求那一下在 agent.js。
 * 分开是为了这一整套判据能在测试里当纯函数摆弄。
 */

const so = require("./systemone");

/** 问出去的那道题的名字。答案是按名字取回来的，两边必须是同一个常量。 */
const DONE_KEY = "还有没做完的事吗";

/** 停这一轮的门槛。比通用的 0.7 严：这一问的结论是「别再往下干了」，比普通判断更该闭嘴。 */
const CONTINUE_MIN = 0.75;

/** 这道闸停下来时，stopNote 的开头。收尾那句话按它分叉（agent.js 的 stopNotice），所以只留这一份。 */
const GATE_STOP_PREFIX = "看着活儿已经干完了";

/** 只有「被上限掐停」这两种才轮得到这道闸。「任务还有 N 项没做完」是结构尺子已经量出来的结论，不必再问。 */
const LIMIT_PREFIXES = ["已达最大步数", "已达最大运行时间"];

const TASK_CHARS = 800;
const PROGRESS_CHARS = 2000;
const TAIL_CHARS = 1500;

/**
 * 这一轮该不该花那道题的钱。
 * @param {{stopNote?:string, milestones?:{open?:string[], total?:number}}} x
 *        milestones 是 agent.js 的 unfinishedMilestones(工作目录) 的原样结果
 */
function needsGate({ stopNote, milestones } = {}) {
  const note = String(stopNote == null ? "" : stopNote).trim();
  if (!LIMIT_PREFIXES.some((p) => note.startsWith(p))) return false;
  const open = milestones && Array.isArray(milestones.open) ? milestones.open.length : 0;
  if (open > 0) return false; // 进度档里明摆着还有没打勾的：确定没干完，这道题白花钱
  return true;
}

/** 问出去的那一道题。只有一道：它是来拦一次花销的，自己不能变成一笔花销。 */
function doneQuestions() {
  return {
    [DONE_KEY]: so.noul(
      "下面是一趟任务被上限掐停时的现场：用户交代的事、工作目录里的进度档（可能没有）、以及它停下前最后说的话。\n" +
      "判断：用户交代的事，还有没有没做完的？\n" +
      "算还有没做完：进度清单里有没打勾的、话说到一半被掐断、正说着下一步要干什么、交代的几件事只做了其中一部分。\n" +
      "算没有了：交代的事都做出来了并给了结果，或者剩下的那些已经明确说清做不了、为什么做不了。\n" +
      "看不出来就别硬挑一边——判错了要么白烧一轮钱，要么把还没干完的活儿停在这儿。"
    ),
  };
}

/**
 * 摆给它看的现场。三段各自标好是什么，别糊成一坨：
 * 「最后说的话」是撞上限那一刻的半句话，跟「进度档」是两种性质的证据，混在一起它分不清谁是谁。
 */
function gateState({ task, progress, tail } = {}) {
  const cut = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  return [
    "【用户交代的事】\n" + (cut(task, TASK_CHARS) || "（没记下来）"),
    "【工作目录的进度档 PROGRESS.md】\n" + (cut(progress, PROGRESS_CHARS) || "（工作目录里没有进度档）"),
    "【它停下前最后说的话】\n" + (cut(tail, TAIL_CHARS) || "（一个字都没说）"),
  ].join("\n\n");
}

/**
 * 读那道题的答案。只有一种情况回非空：它说「没剩了」，而且自己也拿得准。
 * 其余全回 null = 当没问过 = 照老样子续跑。
 */
function readDone(out, min) {
  const bar = Number.isFinite(Number(min)) ? Number(min) : CONTINUE_MIN;
  const a = ((out && out.answers) || []).find((x) => x && x.key === DONE_KEY);
  if (!a || a.value == null) return null;        // 没答上来
  if (a.value >= 0.5) return null;               // 它说还有没做完的
  if (!so.gate(a, bar).act) return null;         // 它说没剩了，但自己也拿不准。确定度这条尺子只有 systemone 那一把
  return { sure: Number(a.sure) || 0, p: Number(a.value), bar };
}

/** 写进 stopNote 的那句话。确定度要露出来——凭什么少跑一轮，得让人看得见。 */
function skipNote(d) {
  return `${GATE_STOP_PREFIX}（判断模型确定度 ${so.pct(d && d.sure)}），没有再自动续跑`;
}

module.exports = {
  needsGate, doneQuestions, gateState, readDone, skipNote,
  DONE_KEY, CONTINUE_MIN, GATE_STOP_PREFIX, LIMIT_PREFIXES,
};
