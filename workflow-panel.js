// @ts-check
"use strict";
/**
 * `openworkbuddy workflow` 跑着的时候那块面板 —— 纯的：给状态、给宽度，吐几行字。怎么擦、怎么重画是 cli.js 的事。
 *
 * 照 Claude Code 跑 workflow 时的样子做，关键是**什么不显示**：
 *   - 每一步的工具调用、流式正文、diff、token 明细一概不往屏幕上印。几步连着跑，
 *     那些东西一屏一屏往上冲，人真正想知道的「跑到第几步了、哪步挂了、花了多少」反倒被冲没了。
 *     过程全在会话里，/resume 或者网页上随时翻得到。
 *   - 每一步只留一行：状态图标、名字、「模型 · token · 在干什么 / 安静多久」、右对齐的耗时。
 *   - 最底下一行进度条：▰▰▱▱ 2/8 · 38m29s · ↓ 996.9k tokens。
 *   - 安静超过 IDLE_SHOW_MS 才说「安静 36s」——一两秒没动静是常态，说出来就是噪音；
 *     太久没动静却必须说，不然人分不清是在想还是卡死了。
 *
 * 写了 phase 的分阶段：左边一栏列阶段和「做完几步/共几步」，右边只列当前阶段的步骤（跟 Claude Code 一样），
 * 窄终端放不下两栏就退成一栏，阶段当小标题。
 */
const { cols, padCols } = require("./text-width");

const IDLE_SHOW_MS = 20000;
const BAR_CELLS = 20;
const ICON = { wait: "◯", run: "⏺", ok: "✔", fail: "✗", skip: "⊘" };

/** 12s / 3m05s / 1h02m */
function dur(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** 812 / 48.5k / 1.6m —— 跟 Claude Code 面板上一个写法 */
function tok(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "m";
}

/** 按显示宽度截断，截了补个 … */
function clip(s, w) {
  const str = String(s == null ? "" : s);
  if (w <= 0) return "";
  if (cols(str) <= w) return str;
  let out = "";
  for (const ch of Array.from(str)) {
    if (cols(out + ch) > w - 1) break;
    out += ch;
  }
  return out + "…";
}

/** ▰▰▰▱▱ */
function bar(done, total, cells = BAR_CELLS) {
  const n = total > 0 ? Math.round((Math.min(done, total) / total) * cells) : 0;
  return "▰".repeat(n) + "▱".repeat(cells - n);
}

/**
 * 从流程文件建初始状态。steps 是 workflow.parse 出来的那份
 * @param {{ name?: string, description?: string, steps: Array<{name: string, title?: string, phase?: string|null}> }} flow
 */
function init(flow, now) {
  const steps = (flow.steps || []).map((s) => ({
    name: s.title || s.name, phase: s.phase || "", status: "wait",
    t0: 0, t1: 0, tokens: 0, model: "", activity: "", lastAt: 0, error: "",
  }));
  // model 只在最底下那行说一次：几步用的是同一个模型，每行都写一遍就是噪音
  return { title: String(flow.name || "workflow"), desc: String(flow.description || ""), model: "", t0: now == null ? Date.now() : now, steps };
}

/** 阶段表：按首次出现的顺序；没写 phase 的整体算一个无名阶段 */
function phasesOf(state) {
  const list = [];
  for (let i = 0; i < state.steps.length; i++) {
    const p = state.steps[i].phase || "";
    let hit = list.find((x) => x.title === p);
    if (!hit) { hit = { title: p, idx: [] }; list.push(hit); }
    hit.idx.push(i);
  }
  return list;
}

function totals(state) {
  // 没跑的（前面挂了）不算进「做完几步」：进度条走满却有一半没跑，是在骗人
  const done = state.steps.filter((s) => s.status === "ok" || s.status === "fail").length;
  const tokens = state.steps.reduce((n, s) => n + (Number(s.tokens) || 0), 0);
  return { done, total: state.steps.length, tokens };
}

/** 一步那一行的中段：模型 · token · 在干什么 / 安静多久 / 挂在哪 */
function midOf(s, now) {
  const bits = [];
  if (s.model) bits.push(s.model);
  if (s.tokens) bits.push(`${tok(s.tokens)} tok`);
  if (s.status === "run") {
    const quiet = s.lastAt ? now - s.lastAt : 0;
    if (quiet >= IDLE_SHOW_MS) bits.push(`安静 ${dur(quiet)}`);
    else if (s.activity) bits.push(s.activity);
  }
  if (s.status === "fail" && s.error) bits.push(s.error);
  if (s.status === "skip") bits.push("前面没成，没跑");
  return bits.join(" · ");
}

function timeOf(s, now) {
  if (s.status === "run") return dur(now - s.t0);
  if (s.t1) return dur(s.t1 - s.t0);
  return "";
}

/**
 * 画一整块。
 * @param {ReturnType<typeof init>} state
 * @param {{ width?: number, now?: number, paint?: (s: string, kind: string) => string, blink?: boolean, flat?: boolean }} [o]
 *   paint 的 kind：dim / ok / fail / run / title / sel。blink=true 时跑着的那个 ⏺ 画成空心，每秒交替一次就是在闪。
 *   flat=true 一律一栏平铺全部步骤：收尾定格那一张用——跑完了要看的是整趟每步怎样，不是「当前阶段」
 * @returns {string[]}
 */
function render(state, o = {}) {
  const now = o.now == null ? Date.now() : o.now;
  // 不给下限：cli.js 给的是终端宽 − 2，往上抬就超出终端、每行都折，重画就错位
  const W = Math.max(1, Math.min(Number(o.width) || 80, 140));
  const paint = o.paint || ((s) => s);
  const t = totals(state);
  const phases = phasesOf(state);
  const out = [];

  // 头只有名字：第几步、用了多久最底下那行进度条已经说了，上下各说一遍就是噪音
  out.push(paint(" " + clip(state.title, W - 2), "title"));
  if (state.desc) out.push(paint(" " + clip(state.desc, W - 2), "dim"));

  const curPhase = (() => {
    const run = state.steps.findIndex((s) => s.status === "run");
    const at = run >= 0 ? run : state.steps.findIndex((s) => s.status === "wait");
    const i = at >= 0 ? at : state.steps.length - 1;
    return phases.findIndex((p) => p.idx.includes(i));
  })();

  const stepRow = (i, w) => {
    const s = state.steps[i];
    const icon = s.status === "run" && o.blink ? "○" : ICON[s.status] || "◯";
    const kind = s.status === "ok" ? "ok" : s.status === "fail" ? "fail" : s.status === "run" ? "run" : "dim";
    const time = timeOf(s, now);
    // 名字栏跟着宽度缩：图标、名字、耗时加起来得塞进 w
    const nameW = Math.max(1, Math.min(24, Math.max(8, ...state.steps.map((x) => cols(x.name))), w - 13));
    const head = ` ${icon} ${padCols(clip(s.name, nameW), nameW)}  `;
    // 实在塞不下（极窄）：只截，不对齐
    if (nameW < 5 || cols(head) + cols(time) + 2 > w) return paint(clip(` ${icon} ${s.name} ${time}`, w), kind);
    // 右边留一格：耗时贴着框线不好认
    const room = w - cols(head) - cols(time) - 2;
    const mid = clip(midOf(s, now), Math.max(0, room));
    const gap = " ".repeat(Math.max(1, w - cols(head) - cols(mid) - cols(time) - 1));
    return paint(head, kind) + paint(mid, s.status === "fail" ? "fail" : "dim") + gap + paint(time, "dim") + " ";
  };

  const twoCols = phases.length > 1 && W >= 72 && !o.flat;
  if (twoCols) {
    const LW = Math.min(22, Math.max(12, ...phases.map((p, k) => cols(`❯ ${k + 1} ${p.title || "其他"} 0/0`) + 2)));
    const RW = W - LW - 3;
    const cur = phases[curPhase] || phases[0];
    const phaseDone = (p) => p.idx.filter((i) => ["ok", "fail", "skip"].includes(state.steps[i].status)).length;
    const rTail = ` · ${cur.idx.length} 步 `;
    const rTitle = ` ${clip(cur.title || "其他", Math.max(1, RW - cols(rTail) - 1))}${rTail}`;
    out.push(paint("╭ 阶段 " + "─".repeat(Math.max(0, LW - 6)) + "┬" + rTitle + "─".repeat(Math.max(0, RW - cols(rTitle))) + "╮", "dim"));
    const n = Math.max(phases.length, cur.idx.length);
    for (let r = 0; r < n; r++) {
      let left = "";
      if (r < phases.length) {
        const p = phases[r];
        const on = r === curPhase;
        const cnt = on || phaseDone(p) ? ` ${phaseDone(p)}/${p.idx.length}` : "";
        left = clip(` ${on ? "❯" : " "} ${r + 1} ${p.title || "其他"}${cnt}`, LW);
        left = paint(padCols(left, LW), on ? "sel" : "dim");
      } else left = " ".repeat(LW);
      const right = r < cur.idx.length ? stepRow(cur.idx[r], RW) : " ".repeat(RW);
      out.push(paint("│", "dim") + left + paint("│", "dim") + right + paint("│", "dim"));
    }
    out.push(paint("╰" + "─".repeat(LW) + "┴" + "─".repeat(RW) + "╯", "dim"));
  } else {
    for (let k = 0; k < phases.length; k++) {
      const p = phases[k];
      const on = k === curPhase && !o.flat; // 定格那张没有「当前」
      if (phases.length > 1) out.push(paint(clip(` ${on ? "❯" : " "} ${k + 1} ${p.title || "其他"}`, W), on ? "sel" : "dim"));
      for (const i of p.idx) out.push(stepRow(i, W));
    }
  }

  // 窄了先缩进度条、再丢模型名，数字最后才截
  const rest = `${t.done}/${t.total} · ${dur(now - state.t0)}${t.tokens ? ` · ↓ ${tok(t.tokens)} tokens` : ""}`;
  const foot = `  ${bar(t.done, t.total, Math.max(6, Math.min(BAR_CELLS, W - cols(rest) - 5)))}  ${rest}`;
  out.push(paint(clip(state.model && cols(foot) + cols(state.model) + 3 <= W ? `${foot} · ${state.model}` : foot, W), "dim"));
  return out;
}

/**
 * 从 agent 的事件里取面板要的那一点：token、在干什么、最后一次有动静是什么时候。
 * 别的（正文、工具结果、diff）一概不要——那些进会话，不进面板。
 * @param {ReturnType<typeof init>["steps"][number]} s
 * @param {any} ev
 * @param {{ now?: number, toolLine?: (ev: any) => string }} [o]
 */
function feed(s, ev, o = {}) {
  if (!s || !ev) return;
  s.lastAt = o.now == null ? Date.now() : o.now;
  const top = !ev.depth;
  if (ev.type === "step_usage") s.tokens = (Number(ev.prompt) || 0) + (Number(ev.completion) || 0);
  else if (ev.type === "usage") s.tokens = (Number(ev.prompt) || 0) + (Number(ev.completion) || 0);
  else if (ev.type === "step_start" && top) s.activity = "思考中";
  else if (ev.type === "text" && top) s.activity = "在写回答";
  else if (ev.type === "tool_use" && top) s.activity = o.toolLine ? o.toolLine(ev) : String(ev.name || "");
  // 长工具的进度：「渲染帧 432/900」比一直挂着「渲染 a.html」更说明没卡。没带 label 就留着工具那行
  else if (ev.type === "tool_progress" && top && ev.label) s.activity = String(ev.label);
  else if (ev.type === "expert_start") s.activity = `委派 ${ev.expert || "专家"}`;
  else if (ev.type === "ask_user") s.activity = "等你回答";
}

module.exports = { init, render, feed, totals, phasesOf, dur, tok, bar, clip, IDLE_SHOW_MS, ICON };
