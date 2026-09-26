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

// sid -> { asks: Map(题号 -> { src, approval, text }), error, unseen }
// src 是这道题从哪条路报上来的：agent = 本机任务的事件流，cli = 终端那几趟，approval = 安全中心的审批。
// 各路只对账自己那一份，一路的轮询回来不许把另一路报的题冲掉。
// 不属于任何会话的审批（IM、定时任务那边起的）记在 "" 底下：不亮哪一行，但算进标题的数。
const sessionAttn = new Map();
const attnLastCall = new Map();
// 删掉了的会话：还在跑的那一轮收尾时会再记一笔「跑完没看」，快捷键就跳进一条删了的会话。记下来，往后不再给它记账
const attnGone = new Set();

function attnOf(sid, create) {
  let st = sessionAttn.get(sid);
  if (!st && create) { st = { asks: new Map(), error: false, unseen: false }; sessionAttn.set(sid, st); }
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
/** 记一笔「出错了 / 跑完了没看」。人正看着这条就不记：他已经看见了 */
function attnFlag(sid, flag) {
  if (!sid || attnGone.has(sid) || (flag !== "error" && flag !== "unseen")) return;
  if (sid === sessionId && !document.hidden) return;
  const st = attnOf(sid, true);
  if (st[flag]) return;
  st[flag] = true;
  attnChanged();
}
/** 人点开了这条（或者切回了窗口）：出错、跑完这两笔就算看过了。题不算——题得答了才算 */
function attnSeen(sid) {
  const st = sessionAttn.get(sid);
  if (!st || (!st.error && !st.unseen)) return;
  st.error = false;
  st.unseen = false;
  attnTidy(sid);
  attnChanged();
}
/** 会话删掉了：它名下的账一起清，不然标题上的数永远下不去 */
function attnForget(sid) {
  if (sid) attnGone.add(sid);
  if (!sessionAttn.delete(sid)) return;
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
  let tip = k === "error" ? "出错了，点开看看" : "跑完了，还没看";
  if (k === "ask") {
    const a = st.asks.values().next().value;
    tip = (a.approval ? "在等你批准：" : "在等你回答：") + (String(a.text || "").slice(0, 60) || (a.approval ? "危险操作" : "一个岔路"));
  }
  return `<span class="hdot ${k}" title="${esc(tip)}"></span>`;
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
  const away = document.hidden || !document.hasFocus();
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
