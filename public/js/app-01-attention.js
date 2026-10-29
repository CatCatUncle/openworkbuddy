// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
// ================= 注意力：哪条会话在等你 =================
/*
 * 几条任务并行跑的时候，人只盯得住眼前这一条。别的会话卡在一道题上等人、出了错、
 * 或者早就跑完了，侧栏上却都长一个样——只有一个一模一样的「在跑」小圆点，
 * 或者什么都没有。人得一条条点开才知道哪条在等他，而等人的那条每多等一秒都是白等
 * （岔路超时＝AI 替你选了，审批超时＝这一步没做）。
 *
 * 这一页只管三件事，都从同一份账（sessionAttn）里读：
 *   1. 侧栏每行那颗点：等你回答/批准 > 出错了 > 在跑 > 跑完了没看；
 *   2. 标题前的「(n) 」：n = 在等你的题数（+ 你不在时跑完的，那个数在 app-02 的标题段）。
 *      桌面版主进程拿这个前缀挂 Dock 角标，所以网页这边只维护这一个数；
 *   3. 后台会话来了题：喊一声，点一下就过去。
 *
 * 上半截是纯函数（test/desktop-ux.js 把整个文件丢进空的 vm 里跑、直接验），下半截才碰页面。
 * 不写 module.exports：写了 tsc 就把这个文件当成 CommonJS 模块，顶层名字不再算全局，
 * app-02 里每一处调用都报「找不到名字」。
 * 这个文件在 app-01 和 app-02 之间加载，顶层不做任何事：用到的全局（renderHistory、
 * openSession、toast…）都是调用时才去找，那时候整页早就加载完了。
 */

/** 同一条会话一分钟内只喊一次：一个任务连着问三道题，不该弹三次通知 */
const ATTN_DEDUPE_MS = 60000;

/**
 * 一行该亮哪颗点。st = { asks: Map, error, unseen }，running = 这条此刻在跑。
 * 「在跑」排在「跑完没看」前面是故意的：排队的下一条消息紧接着就开跑，
 * 这时候亮「跑完了」是在说一件已经不成立的事。
 */
function attnPick(st, running) {
  if (st && st.asks && st.asks.size) return "ask";
  if (st && st.error) return "error";
  if (running) return "running";
  if (st && st.unseen) return "unseen";
  return "";
}

/** 这一声该不该喊：窗口期内喊过就不喊。喊了就把时间记上（调用方不用再记一遍） */
function attnShouldCall(lastAt, key, now, windowMs) {
  const w = windowMs == null ? ATTN_DEDUPE_MS : windowMs;
  const prev = lastAt.get(key);
  if (prev != null && now - prev < w) return false;
  lastAt.set(key, now);
  return true;
}

/**
 * 「跳到下一条等你的」跳去哪。先找等你回答的，没有再找出错的，再没有才是跑完没看的。
 * 从当前这条的下一条开始数、到底了绕回去，当前这条排最后——
 * 连按几下就能把等你的几条挨个过一遍，而不是永远跳回第一条。
 * 返回 null = 没有等你的。
 */
function attnNextSid(order, current, pick) {
  const i = order.indexOf(current);
  const rot = i < 0 ? order.slice() : order.slice(i + 1).concat(order.slice(0, i + 1));
  for (const want of ["ask", "error", "unseen"]) {
    const hit = rot.find((id) => id && pick(id) === want);
    if (hit) return hit;
  }
  return null;
}

/** 标题里那个数：在等你的题一共几道（不是几条会话——一条会话卡着两道审批就是两件事） */
function attnCount(map) {
  let n = 0;
  for (const st of map.values()) n += st && st.asks ? st.asks.size : 0;
  return n;
}

// ---------- 下面碰页面 ----------

// sid -> { asks: Map(题号 -> { src, approval, text }), error, unseen, manual }（manual = 这笔未读是人在行菜单里亲手标的）
// src 是这道题从哪条路报上来的：agent = 本机任务的事件流，cli = 终端那几趟，approval = 安全中心的审批。
// 各路只对账自己那一份，一路的轮询回来不许把另一路报的题冲掉。
// 不属于任何会话的审批（IM、定时任务那边起的）记在 "" 底下：不亮哪一行，但算进标题的数。
const sessionAttn = new Map();
const attnLastCall = new Map();
// 删掉了的会话：还在跑的那一轮收尾时会再记一笔「跑完没看」，快捷键就跳进一条删了的会话。记下来，往后不再给它记账
const attnGone = new Set();

function attnOf(sid, create) {
  let st = sessionAttn.get(sid);
  if (!st && create) { st = { asks: new Map(), error: false, unseen: false, manual: false }; sessionAttn.set(sid, st); }
  return st || null;
}
function attnTidy(sid) {
  const st = sessionAttn.get(sid);
  if (st && !st.asks.size && !st.error && !st.unseen) sessionAttn.delete(sid);
}
function attnChanged() {
  renderHistory();
  syncTitleCount();
}
/** 界面文案之外的字（系统通知）不经过 DOM 自动翻译，得自己翻 */
function attnT(zh) {
  return typeof I18N !== "undefined" && I18N.t ? I18N.t(zh) : zh;
}
function attnName(sid) {
  const s = sessions.find((x) => x.id === sid);
  const row = !s && cliLiveRows.find((r) => r.id === sid);
  return stripSceneTag((s && s.title) || (row && row.title)) || (row ? "终端里的任务" : "任务");
}
/** 这条是不是点得开的会话：网页会话、正在跑的、终端那几趟。删掉了的不算 */
function attnKnownSid(sid) {
  if (attnGone.has(sid)) return false;
  return sessions.some((s) => s.id === sid) || runningSessions.has(sid) || cliLiveRows.some((r) => r.id === sid);
}

/** 本机任务的事件流里来了一道题（handleEvent 的 ask_user 分支调，回放时不调） */
function attnAsk(sid, askId, info) {
  if (!sid || !askId || attnGone.has(sid)) return;
  // 正在跟的终端那趟：流里的题和 /api/cli/pending 报的是同一道（题号不同），
  // 两路都记的话标题上一道题数成两道。终端那边以 pending 为准
  if (typeof cliWatch !== "undefined" && cliWatch && cliWatch.id === sid) return;
  const st = attnOf(sid, true);
  if (st.asks.has(askId)) return;
  const e = { src: "agent", approval: false, text: String((info && info.text) || ""), depth: (info && info.depth) || 0 };
  st.asks.set(askId, e);
  attnChanged();
  notifyAttention(sid, e);
}
function attnAnswered(sid, askId) {
  const st = sessionAttn.get(sid);
  if (!st || !st.asks.delete(askId)) return;
  attnTidy(sid);
  attnChanged();
}
/** 一轮跑完：这一轮流里问过、却没等到 ask_answer 的题（被停了、断了）都作废 */
function attnRunEnded(sid) {
  const st = sessionAttn.get(sid);
  if (!st) return;
  let n = 0;
  for (const [id, a] of st.asks) if (a.src === "agent") { st.asks.delete(id); n++; }
  if (!n) return;
  attnTidy(sid);
  attnChanged();
}
/**
 * 人此刻不在看这个页面：标签页切走了、窗口失焦（切到别的应用），或者桌面版窗口收起来了。
 * 光看 document.hidden 不够——2026-09-28 实测桌面版窗口收起、最小化以后它一直是 false
 * （主进程关着 backgroundThrottling），「你不在时跑完了」和审批的系统通知一次都没弹过。
 * 桌面版主进程收起窗口时往 body 上挂 owb-away（win-away.js）；老版本主进程不挂，就只看前两样。
 */
function isAway() {
  if (typeof document === "undefined") return false;
  if (document.hidden) return true;
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return true;
  return !!(document.body && document.body.classList && document.body.classList.contains("owb-away"));
}

/** 记一笔「出错了 / 跑完了没看」。人正看着这条就不记：他已经看见了 */
function attnFlag(sid, flag) {
  if (!sid || attnGone.has(sid) || (flag !== "error" && flag !== "unseen")) return;
  if (sid === sessionId && !isAway()) return;
  const st = attnOf(sid, true);
  if (st[flag]) return;
  st[flag] = true;
  rememberInboxTask(sid, false);
  attnChanged();
}
/** 人点开了这条（或者切回了窗口）：出错、跑完这两笔就算看过了。题不算——题得答了才算。
 *  auto = 只是切回了窗口：人在行菜单里亲手标的「未读」（manual）不算看过，得真点开这一条 */
function attnSeen(sid, auto, defer = false) {
  const st = sessionAttn.get(sid);
  if (!st) {
    const row = inboxHistory().get(sid);
    if (!row || row.read) return;
    inboxHistory().set(sid, { ...row, read: true });
    if (!defer) { saveInboxHistory(); attnChanged(); }
    return true;
  }
  const keep = !!(auto && st.manual);
  if (!st.error && (!st.unseen || keep)) return;
  if (!keep) rememberInboxTask(sid, true, defer);
  st.error = false;
  if (!keep) {
    st.unseen = false;
    if (st.manual) attnUnreadClear(sid, defer);
    st.manual = false;
  }
  attnTidy(sid);
  if (!defer) attnChanged();
  return true;
}
/** 亲手标的未读记在侧栏那份本地列表上（app-02 toggleUnread），看过了一起擦掉 */
function attnUnreadClear(sid, defer = false) {
  const s = sessions.find((x) => x.id === sid);
  if (!s || !s.unread) return;
  delete s.unread;
  if (!defer) saveSessions();
}
/** 刷新页面以后，亲手标过未读的那几条接着亮：账本只在内存里，那一笔从本地列表上认回来 */
function attnRestoreUnread() {
  let n = 0;
  for (const s of sessions) {
    if (!s.unread || attnGone.has(s.id)) continue;
    const st = attnOf(s.id, true);
    if (st.unseen && st.manual) continue;
    st.unseen = true;
    st.manual = true;
    n++;
  }
  if (n) attnChanged();
}
/** 会话删掉了：它名下的账一起清，不然标题上的数永远下不去 */
function attnForget(sid) {
  if (sid) attnGone.add(sid);
  const archived = inboxHistory().delete(sid);
  if (archived) saveInboxHistory();
  if (!sessionAttn.delete(sid) && !archived) return;
  attnChanged();
}

/**
 * 轮询回来的一整张「此刻在等的题」，跟账上 src 这一路对一遍：没了的删，新来的记上并喊一声。
 * onlySid 给了就只对这一条会话的账（pollCliAsk 只问正在跟的那趟）。
 */
function attnSyncAsks(src, rows, onlySid) {
  const want = new Map();
  for (const r of rows || []) {
    if (!r || !r.id) continue;
    const approval = src === "approval" || r.type === "approval";
    let sid = String(r.sessionId || (src === "approval" ? "" : onlySid || ""));
    // 审批带的 sessionId 不一定是网页会话：IM 起的任务带的是 IM 的会话键（feishu_…、webhook_…）。
    // 侧栏和终端那几趟里都没有这条，就照「不属于任何会话」记在 "" 底下——不然快捷键跳进一条空会话
    if (src === "approval" && sid && !attnKnownSid(sid)) sid = "";
    if (src !== "approval" && !sid) continue;
    if (!want.has(sid)) want.set(sid, new Map());
    want.get(sid).set(String(r.id), { src, approval, text: String((approval ? r.kind : r.question) || "") });
  }
  let changed = false;
  const fresh = [];
  for (const [sid, st] of sessionAttn) {
    if (onlySid != null && sid !== onlySid) continue;
    const w = want.get(sid);
    for (const [id, a] of st.asks) if (a.src === src && !(w && w.has(id))) { st.asks.delete(id); changed = true; }
    attnTidy(sid);
  }
  for (const [sid, m] of want) {
    if (onlySid != null && sid !== onlySid) continue;
    const st = attnOf(sid, true);
    for (const [id, e] of m) {
      if (st.asks.has(id)) continue;
      st.asks.set(id, e);
      changed = true;
      fresh.push([sid, e]);
    }
  }
  if (changed) attnChanged();
  for (const [sid, e] of fresh) notifyAttention(sid, e);
}

/**
 * 侧栏一行的那颗点。「在跑」那颗必须跟改之前一个字节都不差（.hrun + 原来那句 title），
 * 前端测试和别处的样式都认它。cliLive = 终端那几趟的行，它不在 runningSessions 里、话也不一样。
 */
function attnDotHtml(sid, cliLive) {
  const st = sessionAttn.get(sid);
  const k = attnPick(st, cliLive || runningSessions.has(sid));
  if (k === "running") return cliLive ? '<span class="hrun" title="正在跑"></span>' : '<span class="hrun" title="任务运行中"></span>';
  if (!k) return "";
  let tip = k === "error" ? "出错了，点开看看" : (st.manual ? "标成了未读，回头再看" : "跑完了，还没看");
  if (k === "ask") {
    const a = st.asks.values().next().value;
    tip = (a.approval ? "在等你批准：" : "在等你回答：") + (String(a.text || "").slice(0, 60) || (a.approval ? "危险操作" : "一个岔路"));
  }
  return `<span class="hdot ${k}" title="${esc(tip)}"></span>`;
}

/** 顶栏收件箱复用侧栏同一份状态账；只列当前账号能打开的任务，不拷贝结果正文或文件路径。 */
let scheduleInboxRows = [];
let scheduleInboxById = new Map();
const scheduleInboxMemory = new Map();
const inboxHistoryMemory = new Map();
let inboxFilter = "all";
let scheduleInboxError = false;
let scheduleInboxOwner = "";
let scheduleInboxRequest = 0;
function inboxHistoryKey() { return scheduleInboxKey().replace("owb-schedule-inbox-v2:", "owb-task-inbox-v1:"); }
function inboxHistory() {
  const key = inboxHistoryKey();
  if (!inboxHistoryMemory.has(key)) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(key) || "[]"); } catch { /* 内存继续工作 */ }
    inboxHistoryMemory.set(key, new Map((Array.isArray(saved) ? saved : [])
      .filter(r => r && typeof r.id === "string" && typeof r.title === "string" && ["error", "unseen"].includes(r.state))
      .slice(-300).map(r => [r.id, { id: r.id, title: r.title.slice(0, 240), state: r.state, status: r.state === "error" ? "出错了" : "本轮结束", read: !!r.read, at: Number(r.at) || 0, cli: !!r.cli }])));
  }
  return inboxHistoryMemory.get(key);
}
function saveInboxHistory() {
  const rows = inboxHistory();
  if (rows.size > 300) {
    const keep = [...rows.values()].sort((a, b) => b.at - a.at).slice(0, 300);
    rows.clear(); for (const row of keep) rows.set(row.id, row);
  }
  try { localStorage.setItem(inboxHistoryKey(), JSON.stringify([...rows.values()])); } catch { /* 已读仍保留在内存 */ }
}
function rememberInboxTask(sid, read, defer = false) {
  const st = sessionAttn.get(sid);
  if (!sid || attnGone.has(sid) || !st || (!st.error && !st.unseen)) return;
  const previous = inboxHistory().get(sid);
  inboxHistory().set(sid, { id: sid, title: attnName(sid), state: st.error ? "error" : "unseen", status: st.error ? "出错了" : "本轮结束", read: !!read, cli: cliLiveRows.some(r => r.id === sid), at: read && previous ? previous.at : Date.now() });
  if (!defer) saveInboxHistory();
}
function scheduleInboxKey() {
  const user = typeof currentUser !== "undefined" && currentUser;
  return "owb-schedule-inbox-v2:" + (user && (user.id || user.username) || "desktop");
}
function scheduleInboxState() {
  const key = scheduleInboxKey();
  let state = scheduleInboxMemory.get(key);
  if (!state) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved && Array.isArray(saved.seen)) state = { initialized: true, linkedInitialized: saved.linkedInitialized === true, seen: new Set(saved.seen.filter((id) => typeof id === "string")) };
    } catch { /* 本机存储不可用时，仍在内存中记录已读 */ }
    state = state || { initialized: false, linkedInitialized: false, seen: new Set() };
    scheduleInboxMemory.set(key, state);
  }
  return state;
}
function readScheduleInboxSeen() {
  return scheduleInboxState().seen;
}
function saveScheduleInboxSeen() {
  const state = scheduleInboxState();
  state.initialized = true;
  state.seen = new Set([...state.seen].slice(-600));
  try { localStorage.setItem(scheduleInboxKey(), JSON.stringify({ seen: [...state.seen], linkedInitialized: state.linkedInitialized })); } catch { /* 保留内存态，不让已读重新冒出来 */ }
}
async function loadScheduleInbox() {
  const request = ++scheduleInboxRequest, owner = scheduleInboxKey();
  if (scheduleInboxOwner !== owner) {
    scheduleInboxOwner = owner; scheduleInboxRows = []; scheduleInboxById = new Map(); scheduleInboxError = false;
  }
  try {
    const response = await fetch("/api/schedules/runs?limit=300&summary=1");
    if (!response.ok) throw new Error("schedule inbox unavailable");
    const runs = await response.json();
    if (request !== scheduleInboxRequest || owner !== scheduleInboxKey()) return;
    if (!Array.isArray(runs)) throw new Error("invalid schedule inbox response");
    const finished = runs
      .filter((run) => run && typeof run.id === "string" && run.ended_at);
    scheduleInboxError = false;
    // 首次启用收件箱只建立历史基线，避免把几十条旧运行记录全部当作新消息。
    const baseline = scheduleInboxState();
    if (!baseline.initialized || !baseline.linkedInitialized) {
      for (const run of finished) if (!baseline.initialized || run.source_linked || !run.session_id) readScheduleInboxSeen().add(run.id);
      baseline.linkedInitialized = true;
      saveScheduleInboxSeen();
    }
    const seen = readScheduleInboxSeen();
    scheduleInboxById = new Map();
    scheduleInboxRows = finished
      .map((run) => {
        scheduleInboxById.set(run.id, run);
        return { id: `__schedule__:${run.id}`, title: run.name || "定时任务", state: run.ok ? "unseen" : "error", status: run.ok ? "定时任务已完成" : "定时任务出错", read: seen.has(run.id), cli: false, at: Date.parse(run.ended_at) || 0 };
      });
    syncAttentionInbox();
  } catch {
    if (request !== scheduleInboxRequest || owner !== scheduleInboxKey()) return;
    scheduleInboxError = true;
    syncAttentionInbox();
  }
}
function attentionInboxRows() {
  const rows = new Map(), byId = new Map(sessions.map(s => [s.id, s]));
  const add = (id, title, cli) => {
    if (!id || attnGone.has(id)) return;
    const st = sessionAttn.get(id);
    const state = attnPick(st, cli || runningSessions.has(id));
    if (!state) return;
    const status = state === "ask" ? (st.asks.values().next().value.approval ? "待审批" : "待回答")
      : state === "error" ? "出错了" : state === "running" ? "运行中" : "未读";
    const row = { id, title: stripSceneTag(title || attnName(id)) || "任务", state, status, cli: !!cli, at: (byId.get(id) || {}).at || 0 };
    rows.set(id, row);
    if ((state === "error" || state === "unseen") && !inboxHistory().has(id)) rememberInboxTask(id, false);
  };
  for (const s of sessions) add(s.id, s.title, false);
  for (const r of cliLiveRows) add(r.id, r.title, true);
  // 有运行态但列表尚未刷新回来的会话仍放进来，点击后 openAttn 会尝试恢复它。
  for (const id of runningSessions) if (!rows.has(id)) add(id, "任务", false);
  const loose = sessionAttn.get("");
  if (loose && loose.asks.size) {
    const approval = [...loose.asks.values()].some((a) => a.approval);
    rows.set("__approval__", { id: "__approval__", title: "安全审批", state: "ask", status: approval ? "待审批" : "待回答", cli: false, at: Date.now() });
  }
  if (scheduleInboxOwner === scheduleInboxKey()) for (const row of scheduleInboxRows) rows.set(row.id, row);
  for (const [id, row] of inboxHistory()) if (!rows.has(id) && !attnGone.has(id)) rows.set(id, { ...row, title: stripSceneTag((byId.get(id) || {}).title || row.title) });
  // 收件箱是时间线：已读和执行成败只改变标记，不改变位置。
  // 旧失败一直排在最新成功前面，会让用户误以为今天的通知丢了。
  return [...rows.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}
/** 阅读通知不会批准操作、回答问题或停止任务；这些待办继续保留角标。 */
function markInboxRead(rows = attentionInboxRows()) {
  let changed = false, sessionChanged = false;
  for (const row of rows) {
    if (row.read || row.state === "ask" || row.state === "running") continue;
    if (row.id.startsWith("__schedule__:")) {
      readScheduleInboxSeen().add(row.id.slice("__schedule__:".length));
      const stored = scheduleInboxRows.find((r) => r.id === row.id);
      if (stored) stored.read = true;
      changed = true;
    } else {
      inboxHistory().set(row.id, { ...row, status: row.state === "error" ? "出错了" : "本轮结束", read: true });
      if (attnSeen(row.id, false, true)) sessionChanged = true;
    }
  }
  saveInboxHistory();
  if (changed) saveScheduleInboxSeen();
  if (sessionChanged) { saveSessions(); attnChanged(); }
  syncAttentionInbox();
}
function syncAttentionInbox() {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  const button = document.getElementById("inbox-toggle"), panel = document.getElementById("attention-inbox"), badge = document.getElementById("inbox-count");
  if (!button || !panel || !badge) return;
  const all = attentionInboxRows();
  const rows = all.filter(r => inboxFilter === "schedule" ? r.id.startsWith("__schedule__:") : inboxFilter !== "unread" || (!r.read && r.state !== "running"));
  const unread = all.filter((r) => !r.read && r.state !== "running").length;
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? "99+" : String(unread);
  button.setAttribute("aria-label", unread ? `${attnT("收件箱")} · ${unread} ${attnT("未读")}` : attnT("收件箱"));
  const focusedId = panel.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.inboxId : "";
  const time = at => {
    const date = new Date(at);
    return at && Number.isFinite(date.getTime()) ? ` · <time datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}">${esc(date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }))}</time>` : "";
  };
  const html = `<div class="inbox-head"><span>${esc(attnT("收件箱"))}</span><button type="button" class="inbox-read-all"${all.some((r) => !r.read && (r.state === "error" || r.state === "unseen")) ? "" : " disabled"}>${esc(attnT("全部标为已读"))}</button></div>`
    + `<div class="inbox-filters" role="group" aria-label="${esc(attnT("筛选通知"))}">${[["all", "全部"], ["unread", "未读"], ["schedule", "定时任务"]].map(([key, text]) => `<button type="button" data-inbox-filter="${key}" aria-pressed="${inboxFilter === key}">${esc(attnT(text))}</button>`).join("")}</div>`
    + (scheduleInboxError ? `<div class="inbox-error">${esc(attnT("定时任务通知加载失败"))} <button type="button" class="inbox-retry">${esc(attnT("重试"))}</button></div>` : "")
    + (rows.length ? rows.map((r) => `<button type="button" class="inbox-row${r.read ? " is-read" : ""}" data-inbox-id="${esc(r.id)}" data-state="${r.state}"><span class="i-dot" aria-hidden="true"></span><span class="i-copy"><span class="i-title" data-i18n-skip>${esc(r.title === "安全审批" ? attnT(r.title) : r.title)}</span><span class="i-status">${esc(attnT(r.status))}${r.read ? " · " + esc(attnT("已读")) : ""}${time(r.at)}</span></span></button>`).join("")
      : `<div class="inbox-empty">${esc(attnT(inboxFilter === "unread" ? "没有未读通知" : inboxFilter === "schedule" ? "暂无定时任务通知" : "暂无通知"))}</div>`)
    + `<button type="button" class="inbox-runs">${esc(attnT("查看定时任务运行记录"))}</button>`;
  if (panel._inboxHtml === html) return;
  panel._inboxHtml = html;
  panel.innerHTML = html;
  if (focusedId) panel.querySelector(`[data-inbox-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
}

const inboxToggle = typeof document !== "undefined" ? document.getElementById?.("inbox-toggle") : null;
const inboxPanel = typeof document !== "undefined" ? document.getElementById?.("attention-inbox") : null;
if (typeof document !== "undefined" && inboxToggle && inboxPanel) {
  inboxToggle.addEventListener("click", async () => {
    const open = inboxPanel.hidden;
    inboxPanel.hidden = !open;
    inboxToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      syncAttentionInbox();
      await loadScheduleInbox();
    }
  });
  inboxPanel.addEventListener("click", (event) => {
    const filter = event.target.closest("[data-inbox-filter]");
    if (filter) { inboxFilter = filter.dataset.inboxFilter; syncAttentionInbox(); return; }
    if (event.target.closest(".inbox-retry")) { loadScheduleInbox(); return; }
    if (event.target.closest(".inbox-runs")) {
      inboxPanel.hidden = true; inboxToggle.setAttribute("aria-expanded", "false");
      automState.tab = "runs"; automState.runTaskId = ""; openPageView("autom"); return;
    }
    if (event.target.closest(".inbox-read-all")) { markInboxRead(); return; }
    const row = event.target.closest("[data-inbox-id]");
    if (!row) return;
    inboxPanel.hidden = true;
    inboxToggle.setAttribute("aria-expanded", "false");
    if (row.dataset.inboxId.startsWith("__schedule__:")) {
      const runId = row.dataset.inboxId.slice("__schedule__:".length);
      const run = scheduleInboxById.get(runId);
      if (run) {
        markInboxRead(scheduleInboxRows.filter((r) => r.id === row.dataset.inboxId));
        if (run.session_id) openSession(run.session_id);
        else { automState.tab = "runs"; automState.runTaskId = ""; openPageView("autom"); }
      }
      return;
    }
    if (row.dataset.inboxId === "__approval__") {
      const bar = document.getElementById("approval-bar");
      if (bar) { bar.scrollIntoView({ block: "center", behavior: "smooth" }); bar.querySelector("button")?.focus({ preventScroll: true }); }
      return;
    }
    openAttn(row.dataset.inboxId);
  });
  loadScheduleInbox();
  if (typeof setInterval === "function") setInterval(() => { if (!document.hidden) loadScheduleInbox(); }, 30000);
  document.addEventListener("pointerdown", (event) => {
    if (!inboxPanel.hidden && !event.target.closest(".inbox-wrap")) {
      inboxPanel.hidden = true;
      inboxToggle.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || inboxPanel.hidden || imeKey(event)) return;
    inboxPanel.hidden = true;
    inboxToggle.setAttribute("aria-expanded", "false");
    inboxToggle.focus();
  });
}

/**
 * 后台会话来了题，喊人。
 * - 安全中心的审批不在这喊：审批条就摆在输入框上面，哪条会话都看得见；窗口在后台时
 *   pollApprovals 自己会发系统通知，桌面版主进程还会弹一下 Dock。再喊就是两遍。
 * - 人就看着这条会话：不喊。
 * - 人在 app 里看着别的会话：弹一条能点的提示，点了就过去。
 * - 窗口不在前台：系统通知。桌面版里主线的提问宠物那边已经弹过系统通知 + Dock 了；
 *   它那个「要提问时提醒我」关着，就是人不要，这里也不替他弹。
 */
function notifyAttention(sid, e) {
  if (!e || e.src === "approval") return;
  const away = isAway();
  if (sid === sessionId && !away) return;
  if (!attnShouldCall(attnLastCall, sid, Date.now())) return;
  const name = attnName(sid);
  if (sid !== sessionId && !document.hidden) {
    toast(e.approval ? `「${name}」在等你批准，点这里过去` : `「${name}」在等你回答，点这里过去`,
      e.approval ? "shield" : "circle-help", () => openAttn(sid));
  }
  if (!away) return;
  const pet = settingsCache && settingsCache.pet;
  if (pet && pet.available === true && (pet.notify === false || (e.src === "agent" && !(e.depth > 0)))) return;
  if (!("Notification" in window)) return;
  try {
    if (Notification.permission !== "granted") return;
    const n = new Notification(attnT(e.approval ? "有一步要你批准" : "有个问题要问你"), {
      body: name + (e.text ? " · " + e.text.slice(0, 120) : ""),
      tag: "owb-ask-" + sid, // 同一条会话的通知顶掉上一条，不在通知中心里堆一串
    });
    n.onclick = () => { try { window.focus(); } catch {} openAttn(sid); };
  } catch {}
}

/** 过去看那道题：点开那条会话（终端那趟就跟直播），再滚到还没答的那张卡上 */
async function openAttn(sid) {
  if (!sid) return; // 不属于任何会话的审批：审批条就在输入框上面，没地方可跳
  const row = !sessions.some((s) => s.id === sid) && cliLiveRows.find((r) => r.id === sid);
  if (row) {
    if (activeLane !== "cli") {
      activeLane = "cli";
      try { localStorage.setItem("owb_lane", activeLane); } catch {}
      renderLaneTabs();
    }
    if (!(cliWatch && cliWatch.id === sid)) await openCliLive(row);
  } else if (sid !== sessionId) {
    await openSession(sid);
  }
  attnSeen(sid);
  const cards = chatCol.querySelectorAll(".ask-card:not(.done)");
  const card = cards[cards.length - 1];
  if (card) {
    card.scrollIntoView({ block: "center", behavior: "smooth" });
    try { card.focus({ preventScroll: true }); } catch {}
  }
}

/** 快捷键「跳到下一条等你的」。顺序按侧栏里摆的来；侧栏没摆出来的（另一条线、别的项目）接在后面 */
function nextAttn() {
  const order = [...document.querySelectorAll("#history .hist-item")].map((el) => el.dataset.id || el.dataset.cli).filter(Boolean);
  for (const id of sessionAttn.keys()) if (id && !order.includes(id)) order.push(id);
  const sid = attnNextSid(order, sessionId, (id) => attnPick(sessionAttn.get(id), false));
  if (!sid) { toast("没有等你的会话"); return; }
  openAttn(sid);
}
