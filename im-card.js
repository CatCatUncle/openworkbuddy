// @ts-check
"use strict";
/**
 * 飞书里那张「活的」任务卡片长什么样 —— 纯的：给状态、给时刻，吐一份卡片 JSON（schema 2.0）。
 * 建卡、推送、节流、重试全是 im.js 的事，这里不碰网络。
 *
 * 照 Claude Code 的克制来定什么上卡、什么不上：
 *   - 卡头：标题就是你交代的那件事（不是「飞书 · 正在处理」这种谁都一样的话），
 *     副标题一行「第 3 步 · 1m12s · 18.2k tokens」，右边一个状态标签：排队中 / 进行中 / 完成 / 没做成 / 已停止。
 *     手机上瞄一眼卡头就知道到哪了，不用点开。
 *   - 有进度清单（todo_write）就画清单：✔ 做完的、⏺ 正在做的、◯ 还没做的，外加「2/5」。
 *   - 执行过程只留最近几行，每行「图标 动词+对象 · 结果量」，正在跑的那行是蓝的；
 *     一个工具安静超过 IDLE_SHOW_MS 才在那行后面说「安静 36s」——几秒没动静是常态，说出来是噪音，
 *     太久不说又分不清是在想还是卡死了。长工具自己报的进度（「渲染帧 432/900」）挂在那行后面，结果一到就换成结果量。
 *   - 工具的原始输出、diff、token 明细一律不上卡。那些在会话里，网页工作台随时翻得到。
 *   - 模型正在写的回答直接往正文那格流（碰到下一次工具调用就清掉——那是过场白，不是回答）。
 *   - 跑着的时候底下一行小字告诉人怎么叫停：回复「停」。能做的事要说出来，不然等于没有。
 *   - 收尾：执行过程收进一个默认折叠的面板（「执行过程 · 7 步 · 1 步出错」），卡上只剩回答。
 *     跑的时候不用折叠面板：整卡重推会把人手动展开的面板又合上，手指底下的东西在乱跳。
 */

const IDLE_SHOW_MS = 20000;
const STEPS_KEEP = 5; // 跑着的时候卡上留几行执行过程
const STEPS_KEEP_DONE = 20; // 收尾折叠面板里留几行
const TODOS_KEEP = 8;
const DRAFT_MAX = 2500; // 跑着的时候正文那格最多放多少字，太长只留开头（整卡重推，别每次推一大坨）

const PHASE = {
  queued: { tag: "排队中", color: "neutral", template: "grey" },
  run: { tag: "进行中", color: "blue", template: "blue" },
  done: { tag: "完成", color: "green", template: "green" },
  fail: { tag: "没做成", color: "red", template: "red" },
  stopped: { tag: "已停止", color: "neutral", template: "grey" },
};

/** 12s / 3m05s / 1h02m */
function dur(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** 812 / 48.5k / 1.6m */
function tok(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "m";
}

/** 一行过程压成单行：换行、连续空白都并成一个空格 */
function flat(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

/**
 * 一行纯文本（不走 markdown）：文件名里的 _ 和 * 不会把整行变成斜体粗体，也不用猜飞书认哪种转义。
 * lines:1 让飞书自己在手机宽度上截断加省略号。
 */
function textRow(content, color, size = "notation") {
  return { tag: "div", text: { tag: "plain_text", content, text_size: size, text_color: color, lines: 1 } };
}

function cut(s, n) {
  const a = Array.from(String(s == null ? "" : s));
  return a.length <= n ? a.join("") : a.slice(0, n - 1).join("") + "…";
}

/** 卡头标题：你交代的那件事的头一句 */
function titleOf(text) {
  // 只剥行首的 markdown 记号和粗体/代码标记；标题是纯文本，文件名里的 _ 得留着
  const line = String(text || "").split("\n").map((l) => l.replace(/^[\s#>*-]+/, "").replace(/\*\*|`/g, "").trim()).find(Boolean) || "";
  return cut(line, 40) || "新任务";
}

/**
 * @param {{ title?: string, queued?: boolean, now?: number }} [o]
 */
function init(o = {}) {
  const now = o.now || Date.now();
  return {
    title: titleOf(o.title),
    queued: !!o.queued,
    t0: now,
    lastAt: now,
    step: 0,
    /** @type {Array<{ id: string, text: string, status: "run"|"ok"|"fail", outcome: string, at: number, progress?: string }>} */
    lines: [],
    /** @type {Array<{ content: string, status: string }>} */
    todos: [],
    tokens: 0,
    model: "",
    /** 这一趟花了多少。null = 不知道全貌（没算完 / 跑在 CLI 引擎上），这时卡上一个字也不说 @type {{ yuan: number, unknownN: number } | null} */
    spend: null,
    draft: "",
    /** @type {string[]} */
    files: [],
  };
}

/**
 * 排队的那张开始真跑了：时间从这会儿算，排队干等的那段不算它头上
 * @param {ReturnType<typeof init>} st
 * @param {number} [now]
 */
function begin(st, now) {
  st.queued = false;
  st.t0 = st.lastAt = now || Date.now();
}

/**
 * agent 事件 → 卡片状态。只取卡上要的那一点，别的一概不要。
 * @param {ReturnType<typeof init>} st
 * @param {any} ev
 * @param {{ now?: number, label?: (name: string) => string }} [o] label：工具名 → 人话（事件里没带 title 时用）
 * @returns {boolean} 卡上看得见的东西变没变（没变就不用推）
 */
function feed(st, ev, o = {}) {
  if (!st || !ev) return false;
  const now = o.now || Date.now();
  st.lastAt = now;
  const top = !ev.depth;
  switch (ev.type) {
    case "step_start":
      if (top) st.step = Number(ev.step) || st.step + 1;
      return top;
    case "text":
      if (!top || !ev.delta) return false;
      st.draft += String(ev.delta);
      return true;
    case "tool_use": {
      if (!top) return false;
      st.draft = ""; // 工具前面那几句是过场白，不是回答
      if (ev.name === "todo_write") return false; // 清单自己会画，不占一行过程
      const text = ev.title || [o.label ? o.label(ev.name) : ev.name, ev.purpose].filter(Boolean).join(" ");
      st.lines.push({ id: String(ev.id || `t${st.lines.length}`), text: String(text || ev.name || "工具"), status: "run", outcome: "", at: now });
      return true;
    }
    case "tool_result": {
      if (!top) return false;
      const line = st.lines.find((l) => l.id === String(ev.id)) || st.lines.slice().reverse().find((l) => l.status === "run");
      if (!line) return false;
      line.status = ev.isError ? "fail" : "ok";
      line.outcome = String(ev.outcome || "");
      line.progress = ""; // 结果量接替进度：做完那行不能还挂着「渲染 899/900」
      return true;
    }
    case "tool_progress": {
      // 渲染、配音这类一跑几分钟的工具，卡上只有一行「⏺ 渲染」跟卡死了分不出来：把工具自己报的那句挂在行尾。
      // 推送节流在 im.js（最快 1.2s 一次、卡片没变不推），这里只改状态；只认顶层、只认还在跑的那一行，
      // 迟到的进度拉不回已经收了尾的行
      if (!top || !ev.id) return false;
      const line = st.lines.find((l) => l.id === String(ev.id) && l.status === "run");
      if (!line) return false;
      const n = (v) => typeof v === "number" && Number.isFinite(v);
      const text = flat(ev.label) || (n(ev.done) && n(ev.total) ? `${ev.done}/${ev.total}` : n(ev.pct) ? `${Math.round(ev.pct)}%` : "");
      // 报进度就是有动静，不该再说「安静 36s」；卡上正挂着「安静」的，就算字没变也得推一次把它摘掉
      const wasQuiet = now - line.at >= IDLE_SHOW_MS;
      line.at = now;
      if (!text || text === line.progress) return wasQuiet;
      line.progress = text;
      return true;
    }
    case "expert_start":
      st.lines.push({ id: `expert:${ev.expert}`, text: `委派「${ev.expert || "专家"}」`, status: "run", outcome: "", at: now });
      return true;
    case "expert_done": {
      const line = st.lines.slice().reverse().find((l) => l.id === `expert:${ev.expert}` && l.status === "run");
      if (!line) return false;
      line.status = "ok";
      line.outcome = "交回结果";
      return true;
    }
    case "compact":
      st.lines.push({ id: `compact${st.lines.length}`, text: "整理长会话上下文", status: "ok", outcome: "", at: now });
      return true;
    case "todos":
      if (!top || !Array.isArray(ev.items)) return false;
      st.todos = ev.items.filter((x) => x && x.content).map((x) => ({ content: String(x.content), status: String(x.status || "pending") }));
      return true;
    case "step_usage":
    case "usage": {
      const n = (Number(ev.prompt) || 0) + (Number(ev.completion) || 0);
      const was = st.tokens, wasModel = st.model;
      if (n > st.tokens) st.tokens = n;
      if (ev.model) st.model = String(ev.model);
      return st.tokens !== was || st.model !== wasModel;
    }
    case "spend": {
      // im.js 只在整趟的钱都算得出来时才发这个事件；这里照单全收，不再自己猜
      const yuan = Math.max(0, Number(ev.yuan) || 0), unknownN = Math.max(0, Math.floor(Number(ev.unknownN) || 0));
      const was = st.spend;
      st.spend = { yuan, unknownN };
      return !was || was.yuan !== yuan || was.unknownN !== unknownN;
    }
    case "files":
      if (!Array.isArray(ev.changed)) return false;
      for (const f of ev.changed) if (f && !st.files.includes(String(f))) st.files.push(String(f));
      return false; // 文件名收尾时一起上卡，跑着的时候不抢位置
    default:
      return false;
  }
}

/** 一行执行过程的字：「✔ 读 报告.md · 120 行」，跑着的那行太久没动静就补「安静 36s」 */
function lineText(l, now, running) {
  const icon = l.status === "ok" ? "✔" : l.status === "fail" ? "✗" : "⏺";
  let s = `${icon} ${cut(flat(l.text), 60)}`;
  if (l.outcome) s += ` · ${cut(flat(l.outcome), 30)}`;
  if (l.status === "run" && running && l.progress) s += ` · ${cut(l.progress, 24)}`;
  if (l.status === "run" && running) {
    const quiet = now - l.at;
    if (quiet >= IDLE_SHOW_MS) s += ` · 安静 ${dur(quiet)}`;
  }
  return s;
}

function procRows(st, keep, now, running) {
  const lines = st.lines.slice(-keep);
  const extra = st.lines.length - lines.length;
  const rows = extra > 0 ? [textRow(`… 前面还有 ${extra} 步`, "grey")] : [];
  for (const l of lines) {
    rows.push(textRow(lineText(l, now, running), l.status === "fail" ? "red" : l.status === "run" && running ? "blue" : "grey"));
  }
  return rows;
}

function todoRows(st) {
  const t = st.todos;
  const done = t.filter((x) => x.status === "done").length;
  /** @type {object[]} */
  const rows = [{ tag: "markdown", content: `**进度 ${done}/${t.length}**`, text_size: "normal" }];
  let shown = t;
  if (t.length > TODOS_KEEP) {
    // 太长：做完的收成一行，留正在做的和还没做的
    shown = t.filter((x) => x.status !== "done").slice(0, TODOS_KEEP);
    rows.push(textRow(`✔ 已做完 ${done} 条`, "grey", "normal"));
  }
  for (const x of shown) {
    const c = cut(flat(x.content), 50);
    rows.push(x.status === "done" ? textRow(`✔ ${c}`, "grey", "normal")
      : x.status === "in_progress" ? textRow(`⏺ ${c}`, "blue", "normal")
      : textRow(`◯ ${c}`, "default", "normal"));
  }
  return rows;
}

/** ¥0.84；不到一分钱的多留几位（¥0.0023），别四舍五入成 ¥0.00 @param {number} v */
function yuan(v) {
  if (v >= 0.01) return `¥${v.toFixed(2)}`;
  const dp = Math.min(6, Math.ceil(-Math.log10(v)) + 1);
  return `¥${v.toFixed(dp)}`;
}

/**
 * 卡头那句「花了多少」。价钱只认 pricing.js 那张表：
 *   都有价 → 「已花 ¥0.84」；有几项没价 → 「已花 ¥0.84 · 1 项单价未知」；一项价都没有 → 「单价未知」。
 * 有一项不知道就绝不写 ¥0；确实一分钱没花（本地模型、没调付费接口）就这一格空着。
 * @param {{ yuan: number, unknownN: number } | null | undefined} s
 */
function spendText(s) {
  if (!s) return "";
  const v = Math.max(0, Number(s.yuan) || 0), u = Math.max(0, Math.floor(Number(s.unknownN) || 0));
  if (v > 0) return u ? `已花 ${yuan(v)} · ${u} 项单价未知` : `已花 ${yuan(v)}`;
  return u ? "单价未知" : "";
}

/** 「步」全卡一个口径：执行过程里的一行 = 一步（跟折叠面板上「执行过程 · 7 步」对得上） */
function subtitleOf(st, phase, now) {
  const bits = [];
  const took = dur(now - st.t0);
  const n = st.lines.length;
  if (phase === "queued") return "前面还有任务在跑，轮到它就开工";
  if (phase === "run") {
    if (n) bits.push(`第 ${n} 步`);
    bits.push(took);
  } else if (phase === "done") {
    bits.push(`用时 ${took}`);
    if (n) bits.push(`${n} 步`);
  } else if (phase === "fail") {
    bits.push(`跑了 ${took}${n ? `，做到第 ${n} 步` : ""}`);
  } else if (phase === "stopped") {
    bits.push(`跑了 ${took}，按你说的停了`);
  }
  const spent = spendText(st.spend);
  if (spent) bits.push(spent);
  if (st.tokens) bits.push(`${tok(st.tokens)} tokens`);
  return bits.join(" · ");
}

/**
 * 画整张卡。
 * @param {ReturnType<typeof init>} st
 * @param {{ phase?: "queued"|"run"|"done"|"fail"|"stopped", now?: number, body?: string, files?: string[], clean?: (s: string) => string }} [o]
 *   body：收尾时的正文（回答 / 出错原因）；跑着的时候不传，用 st.draft。
 *   files：收尾时真发出去的附件名，列在正文底下。
 */
function render(st, o = {}) {
  const phase = o.phase || (st.queued ? "queued" : "run");
  const now = o.now || Date.now();
  const P = PHASE[phase] || PHASE.run;
  const running = phase === "run" || phase === "queued";
  const clean = o.clean || ((s) => s);
  const els = [];
  const fails = st.lines.filter((l) => l.status === "fail").length;

  if (st.todos.length && (running || st.todos.some((x) => x.status !== "done"))) {
    els.push(...todoRows(st));
  }

  if (running) {
    if (phase === "queued") {
      els.push(textRow("排队中：同一个会话的任务一件一件来", "grey"));
    } else if (st.lines.length) {
      els.push(...procRows(st, STEPS_KEEP, now, true));
    } else {
      const quiet = now - st.lastAt;
      const what = quiet >= IDLE_SHOW_MS ? `在想 · 安静 ${dur(quiet)}` : st.draft ? "在写回答" : "在想";
      els.push(textRow(`⏺ ${what}`, "blue"));
    }
    const draft = clean(st.draft).trim();
    if (draft) {
      els.push({ tag: "hr", element_id: "owb_hr" });
      els.push({ tag: "markdown", element_id: "owb_body", content: draft.length > DRAFT_MAX ? draft.slice(0, DRAFT_MAX) + "\n\n…" : draft });
    }
    els.push(textRow("回复「停」可以叫停", "grey"));
  } else {
    if (st.lines.length) {
      const head = `执行过程 · ${st.lines.length} 步${fails ? ` · <font color='red'>${fails} 步出错</font>` : ""}`;
      els.push({
        tag: "collapsible_panel",
        element_id: "owb_proc_panel",
        expanded: phase === "fail", // 没做成的时候过程就是答案，摊开给人看
        header: {
          title: { tag: "markdown", content: head },
          background_color: "grey-50",
          padding: "4px 8px 4px 8px",
          icon: { tag: "standard_icon", token: "down-small-ccm_outlined" },
        },
        elements: procRows(st, STEPS_KEEP_DONE, now, false),
      });
    }
    els.push({ tag: "markdown", element_id: "owb_body", content: String(o.body || "").trim() || "（没有文字回复）" });
    const files = (o.files || []).filter(Boolean);
    if (files.length) {
      els.push(textRow(`📎 ${files.map((f) => String(f).split("/").pop()).join(" · ")}（附件随后发到这里）`, "grey"));
    }
  }

  const summary = running
    ? `${P.tag}：${st.title}`
    : phase === "done"
      ? cut(titleOf(o.body) || st.title, 40)
      : `${P.tag}：${st.title}`;

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: running,
      enable_forward: true,
      width_mode: "fill",
      ...(running ? { streaming_config: { print_frequency_ms: { default: 30 }, print_step: { default: 2 }, print_strategy: "fast" } } : {}),
      summary: { content: cut(summary, 40) },
    },
    header: {
      title: { tag: "plain_text", content: st.title },
      subtitle: { tag: "plain_text", content: subtitleOf(st, phase, now) },
      text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: P.tag }, color: P.color }],
      template: P.template,
    },
    body: { direction: "vertical", vertical_spacing: "small", elements: els },
  };
}

/** 「停」「停下」「/stop」…… 一整句就这一个意思才算，句子里顺带提到「停」不算 */
function isStopWord(text) {
  return /^\s*(?:[\/／]stop|[\/／]停|停|停下|停止|停一下|别做了|先停|取消|cancel|stop)\s*[。.!！]?\s*$/i.test(String(text || ""));
}

module.exports = { init, begin, feed, render, isStopWord, titleOf, dur, tok, spendText, IDLE_SHOW_MS, PHASE };
