// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 指标聚合 + 阈值告警。
 *
 * 这个项目里**事件**已经很全了：trace 有调用树、audit 有放行/拦截、用量账本有每笔花销、
 * model_health 有每条渠道最近 20 次成败。缺的是把它们滚成**数值**——
 * 「今天任务失败率多少」「这周比上周涨了多少」「P95 花了几秒」这类问题，
 * 事件流回答不了，每次都得现算，于是实际上没人算，出了事才回头翻。
 *
 * 所以这里只做两件很小的事：
 *   1. 每分钟把「这一分钟发生了什么」写成一行 JSON，落 `data/metrics/<年-月>.jsonl`；
 *   2. 拿这一行去套几条阈值规则，命中就走 notify.js 推企业微信 / 钉钉。
 *
 * 明确**不做**的事，以及为什么：
 *
 *   · 不引 Prometheus / Grafana。这套东西是打成 Electron 发给普通用户的，
 *     用户电脑上不会装 Prometheus，也不该装。等真有服务端多租户部署、客户点名要看板，
 *     再加一个 /metrics 端点让外面来抓就行——那时候这份快照正好是现成的数据源。
 *   · 不自己开一套存储。一行 JSON 追加到按月分片的文件里，跟用量账本同一个套路。
 *   · 计数器**不持久化**。重启就归零，而每行快照记的是「这一分钟的增量」——
 *     时序要的本来就是增量，累计值反而会被重启弄出一个假的断崖。
 *
 * 告警最容易翻的车是「把人淹掉」。所以这里有两条硬规矩：
 *   · 同一条规则在冷却期内只报一次（默认 30 分钟）；
 *   · **恢复了要说一声**。只报警不报恢复的系统，用不了两周大家就开始无视它。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const perfHooks = require("perf_hooks");
const { dataPath } = require("../../platform/paths");
const log = require("../../platform/log");

const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data");
const DIR = path.join(DATA_DIR, "metrics");
const STATE_FILE = path.join(DATA_DIR, "metrics-alerts.json");
// 三个月而不是半年：2026-09 那片 11569 行 6.1MB，一个月 23MB 上下，留半年就是 137MB 的折线图。
// 看板只画最近那一段，告警只看当下这一行，三个月前的一分钟粒度没人会回头翻
const KEEP_MONTHS = 3;
const INTERVAL_MS = 60 * 1000;
// 闲着（这一分钟什么都没发生、也没有任务在跑）的行最多十分钟落一行。
// 实测一个月里绝大多数行是全 0：人不在电脑前，这台后台观察者照样每分钟记一行「没事」
const IDLE_EVERY_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;

// ---------- 这一分钟发生了什么（进程内计数，每写一次快照清零） ----------
let counters = Object.create(null);
let timings = Object.create(null);

/** 记一次。任务跑完、模型调用失败、命令被拦……哪儿知道哪儿喊一声，一行的事 */
function bump(name, n = 1) {
  counters[name] = (counters[name] || 0) + (Number(n) || 0);
}
/**
 * 记一次耗时，用来算分位数。
 * 为什么留样本而不是只留平均：平均数会把「大部分很快、少数卡到 80 秒」这件事抹平，
 * 而用户抱怨的正是那少数。**每桶最多留 500 个样本**，再多就丢新的——
 * 一分钟内跑满 500 趟任务的场景不存在，这个上限只是防失控。
 */
function observe(name, ms) {
  const v = Number(ms);
  if (!isFinite(v)) return;
  const arr = (timings[name] = timings[name] || []);
  if (arr.length < 500) arr.push(v);
}
/**
 * 分位数，取**最近秩**（nearest-rank）：第 ceil(p·n) 个样本。
 *
 * 原来写的是 floor((n-1)·p)，样本一少就永远够不到尾巴：三趟任务跑了 100ms / 200ms / 9 秒，
 * 它算出来的 P95 是 200ms。而这个函数存在的唯一理由就是**别把那 9 秒抹平**——
 * 平均数已经会抹平了，分位数再抹一次就等于没有。一分钟内只跑三趟任务在这个产品里是常态，
 * 所以「样本少」不是边角情况，是主要情况。
 */
function pct(arr, p) {
  if (!arr || !arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return Math.round(s[i]);
}

// ---------- 从现有数据文件里读出来的那些「当下是多少」 ----------
function diskFreePct() {
  try {
    const st = fs.statfsSync(DATA_DIR);
    const total = st.blocks * st.bsize;
    return total > 0 ? +(st.bavail * st.bsize / total).toFixed(4) : 1;
  } catch { return 1; }   // 读不出来就当没事，不能因为读不到磁盘信息就发一条假告警
}
/** 每条模型渠道当前连挂了几次，以及最近一次挂的原话。data/model_health.json 是 server.js 在维护的。
 *  只算最近 24 小时里挂过的：2026-09-29 日志里「~typesafe/jev-latest 已连续失败 5 次」隔一阵就报一遍，
 *  可那 5 次全是 9 月 22 日的，之后这条渠道再没被调过——recent 里的 0 一直留着，告警就一直回响，
 *  看着像还在花钱调它。没人再用的渠道不算「正在挂」。没记时间的老记录照旧算（0 是「没记过」，不是「很久以前」） */
const STREAK_FRESH_MS = 24 * 3600e3;
function channelHealth(now = Date.now()) {
  let h = {};
  try { h = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "model_health.json"), "utf8")) || {}; } catch { return { streak: {}, last: {} }; }
  const streak = {}, last = {};
  for (const [name, v] of Object.entries(h)) {
    const recent = Array.isArray(v && v.recent) ? v.recent : [];
    let n = 0;
    for (let i = recent.length - 1; i >= 0 && !recent[i]; i--) n++;
    if (!n) continue;
    const at = Number(v.last_fail_t) || 0;
    if (at && now - at > STREAK_FRESH_MS) continue;
    streak[name] = n;
    // 告警里带上原话的头一句，不替人猜是欠费还是限流——原话里写了什么就是什么
    const said = String(v.last_fail || "").split(/\n|——/)[0].trim();
    if (said) last[name] = said.length > 80 ? said.slice(0, 80) + "…" : said;
  }
  return { streak, last };
}
function channelStreaks(now) { return channelHealth(now).streak; }
/** 审计里最近这段时间拦下了几条。拦截突然变多，通常意味着有人（或某个技能）在撞墙 */
function auditBlocked(sinceMs) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "audit.json"), "utf8"));
    if (!Array.isArray(rows)) return 0;
    let n = 0;
    // 环形账本是新的在后；从尾巴往回数，走出窗口就停，不用扫全表
    for (let i = rows.length - 1; i >= 0; i--) {
      const t = Date.parse(rows[i] && rows[i].ts);
      if (!(t >= sinceMs)) break;
      if (String(rows[i].action || "").includes("拦")) n++;
    }
    return n;
  } catch { return 0; }
}

/**
 * 主线程卡了多久。
 *
 * 2026-09-28 实测：六条对话同时跑、整个应用一顿一顿的那天，指标里 load1 到了 14-23，
 * 服务进程 rss 却平平的——看不出是服务端这条线程被同步活儿堵住了，还是它起的子进程在烧核，
 * 每次都得现场 ps/top 翻。这里补上「这一分钟里主线程最多被堵了多久」：
 *   · loop_p99_ms / loop_max_ms：定时器按 50ms 一拍打点，晚到多少就是被堵了多少（去掉了那 50ms 本身）。
 *     50ms 而不是 20ms：实测空转时 20ms 一拍每秒吃 1.4ms CPU、50ms 一拍 0.6ms，而要抓的是
 *     几百毫秒那种卡顿，更细的刻度用不上。
 *   · loop_util：事件循环忙的比例。**只在纯 node 跑的服务端才有**——Electron 主进程里
 *     eventLoopUtilization 实测恒为 0（它的循环不是 node 自己在转），记个 0 会被读成「一点都不忙」，不如不记。
 * 只在 start() 之后才开，测试里单调 snapshot() 的不受影响。
 *
 * 闲着就关表（2026-10-07 实测）：空转的服务端每秒被叫醒 40 次，38 次是这张表——50ms 一拍，
 * 一拍醒两回。闲的时候没有东西会卡，量出来一排 0，却一直挡着 CPU 进深睡（耗电、发热）。
 * 所以表只在有事时开：来一条请求、起一趟任务就开（wake）；分钟快照那一拍看到这一分钟闲着、
 * 离上次 wake 也满一分钟，就关掉。关着的那些行里没有 loop_p99_ms / loop_max_ms（没量 ≠ 0）。
 * loop_util 不靠定时器，start 之后一直记。
 */
const LOOP_RES_MS = 50;
const LOOP_QUIET_MS = 60000;
let loopHist = null;
let eluPrev = null;
let loopOn = false; // start() 之后才是 true：没 start 的进程（测试、命令行）wake() 什么都不开
let lastWake = 0;
function histArm() {
  if (loopHist) return;
  try { loopHist = perfHooks.monitorEventLoopDelay({ resolution: LOOP_RES_MS }); loopHist.enable(); } catch { loopHist = null; }
}
function histDisarm() {
  try { if (loopHist) loopHist.disable(); } catch {}
  loopHist = null;
}
function loopArm() {
  loopOn = true;
  lastWake = Date.now();
  histArm();
  if (eluPrev || process.versions.electron) return;
  try { eluPrev = perfHooks.performance.eventLoopUtilization(); } catch { eluPrev = null; }
}
function loopDisarm() {
  histDisarm();
  loopOn = false; eluPrev = null;
}
/** 有事了（来了请求、起了任务）：表关着就打开。每条请求都会叫，所以只做两次比较 */
function wake() {
  lastWake = Date.now();
  if (loopOn && !loopHist) histArm();
}
/** 分钟快照那一拍：这一分钟闲、离上次 wake 也满一分钟，表就先关了，等下一次 wake */
function loopNap(row, now) {
  if (loopHist && isIdle(row) && now - lastWake >= LOOP_QUIET_MS) histDisarm();
}
/** 读完就清零：每一行记的是「这一分钟」，跟上面的计数器一个口径 */
function loopRead() {
  const out = {};
  if (loopHist) {
    const n = Number(loopHist.count) || 0;
    // 直方图里是纳秒；一拍都没打上（刚开）就不写，0 会被读成「一点没卡」
    if (n > 0) {
      out.loop_p99_ms = +(loopHist.percentile(99) / 1e6).toFixed(1);
      out.loop_max_ms = +(loopHist.max / 1e6).toFixed(1);
    }
    loopHist.reset();
  }
  if (eluPrev) {
    try {
      const now = perfHooks.performance.eventLoopUtilization();
      out.loop_util = +perfHooks.performance.eventLoopUtilization(now, eluPrev).utilization.toFixed(3);
      eluPrev = now;
    } catch {}
  }
  return out;
}

// ---------- 快照 ----------
let lastAt = Date.now();
/** 额外的「当下是多少」由调用方提供（正在跑几趟任务之类，只有 server.js 知道） */
let gaugeFn = () => ({});

function snapshot() {
  const now = Date.now();
  const c = counters, t = timings;
  counters = Object.create(null);
  timings = Object.create(null);
  const tasks = c.tasks || 0;
  const failed = c.tasks_failed || 0;
  let extra = {};
  try { extra = gaugeFn() || {}; } catch {}
  const row = {
    ts: new Date(now).toISOString(),
    span_ms: now - lastAt,
    tasks,
    tasks_failed: failed,
    // 没跑过任务时失败率是 0，不是 NaN —— NaN 会让下面所有比较都变成 false，
    // 看着像「一切正常」，其实是这一格根本没算出来
    task_fail_rate: tasks ? +(failed / tasks).toFixed(4) : 0,
    task_p50_ms: pct(t.task, 0.5),
    task_p95_ms: pct(t.task, 0.95),
    model_calls: c.model_calls || 0,
    model_fail: c.model_fail || 0,
    tokens: c.tokens || 0,
    credits: +(c.credits || 0).toFixed(2),
    http_5xx: c.http_5xx || 0,
    audit_blocked: auditBlocked(lastAt),
    ...(() => { const ch = channelHealth(now); return { channel_fail_streak: ch.streak, channel_fail_last: ch.last }; })(),
    disk_free_pct: diskFreePct(),
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    load1: +(os.loadavg()[0] || 0).toFixed(2),
    uptime_s: Math.round(process.uptime()),
    ...loopRead(),
    ...extra,
  };
  lastAt = now;
  return row;
}

function shardOf(ts) { return String(ts).slice(0, 7); }
function fileOf(shard) { return path.join(DIR, shard + ".jsonl"); }
function shards() {
  try {
    return fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, 7)).sort().reverse();
  } catch { return []; }
}
function write(row) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileOf(shardOf(row.ts)), JSON.stringify(row) + "\n", "utf8");
    for (const s of shards().slice(KEEP_MONTHS)) { try { fs.rmSync(fileOf(s), { force: true }); } catch {} }
  } catch (e) { log.warn("metrics", "快照写不进去", { err: e }); }
}
/** 读快照，**老的在前**（画折线图要的就是这个顺序）。默认只读最近这个月 */
function read({ from = "", to = "", limit = 2000 } = {}) {
  const lo = String(from).slice(0, 7), hi = String(to).slice(0, 7);
  const out = [];
  for (const s of shards().reverse()) {
    if (lo && s < lo) continue;
    if (hi && s > hi) continue;
    let raw = "";
    try { raw = fs.readFileSync(fileOf(s), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (o && (!from || o.ts >= from) && (!to || o.ts <= to)) out.push(o); } catch {}
    }
  }
  return limit ? out.slice(-limit) : out;
}

// ---------- 告警规则 ----------
/**
 * 每条规则三样东西：怎么算命中（test）、命中了说什么（msg）、以及一个稳定的 id。
 * id 是去重的钥匙，所以它必须稳定——渠道挂了这一条按渠道名分开算，
 * 不然 A 渠道正在报的冷却期会把 B 渠道刚挂掉这件事压下去。
 */
const RULES = [
  {
    id: (m) => "task_fail_rate",
    // 少于 5 趟不判：1 趟里挂 1 趟是 100%，可那多半是用户自己按了停止
    test: (m) => m.tasks >= 5 && m.task_fail_rate > 0.3,
    msg: (m) => `任务失败率 ${(m.task_fail_rate * 100).toFixed(0)}%（近一分钟 ${m.tasks} 趟里挂了 ${m.tasks_failed} 趟）`,
  },
  {
    id: (m, k) => "channel:" + k,
    each: (m) => Object.entries(m.channel_fail_streak || {}).filter(([, n]) => n >= 5).map(([k]) => k),
    msg: (m, k) => {
      const said = m.channel_fail_last && m.channel_fail_last[k];
      return `模型渠道「${k}」已连续失败 ${m.channel_fail_streak[k]} 次${said ? `，最近一次：${said}` : ""}。去 设置 → 模型 换一条，或给它配个备用渠道`;
    },
  },
  {
    id: () => "disk",
    test: (m) => m.disk_free_pct < 0.08,
    msg: (m) => `磁盘只剩 ${(m.disk_free_pct * 100).toFixed(1)}%。日志、会话、trace 都还在往里写，写满之后任务会直接失败`,
  },
  {
    id: () => "rss",
    // 只在「一直很高」时报：单次尖峰是正常的，长在高位才是漏
    test: (m) => m.rss_mb > 3000,
    msg: (m) => `进程占用内存 ${m.rss_mb} MB，明显偏高。如果它不再回落，重启一次能救急，同时值得看一眼是不是有超大会话没被回收`,
  },
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {}; } catch { return {}; }
}
function saveState(st) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(st), "utf8"); } catch {}
}

/**
 * 拿一行快照去套规则，返回这一轮该发出去的话（数组，可能为空）。
 *
 * 状态存盘而不是只放内存：崩溃重启循环里，内存状态每次都是空的，
 * 于是每重启一次就重报一次——告警系统自己变成了刷屏的那个。
 */
function evaluate(row, now = Date.now()) {
  const st = loadState();
  const out = [];
  const firingNow = new Set();
  for (const rule of RULES) {
    const keys = rule.each ? rule.each(row) : (rule.test(row) ? [""] : []);
    for (const k of keys) {
      const id = rule.id(row, k);
      firingNow.add(id);
      const prev = st[id];
      if (prev && prev.firing && now - prev.at < COOLDOWN_MS) continue;  // 冷却期内，闭嘴
      st[id] = { firing: true, at: now, since: (prev && prev.since) || now };
      out.push({ id, level: "alert", text: "⚠️ " + rule.msg(row, k) });
    }
  }
  // 不再命中的：报一次恢复，然后把状态清掉
  for (const [id, v] of Object.entries(st)) {
    if (firingNow.has(id) || !v || !v.firing) continue;
    const mins = Math.max(1, Math.round((now - (v.since || now)) / 60000));
    out.push({ id, level: "resolved", text: `✅ 已恢复：${id}（持续约 ${mins} 分钟）` });
    delete st[id];
  }
  saveState(st);
  return out;
}

// ---------- 闲行合并 ----------
// 这几格有一个不是 0，这一分钟就算「有事」。磁盘、内存、负载这类读数不算：它们每分钟都有值，
// 拿它们判的话永远不闲。十分钟一行照样看得见它们的走势
const ACTIVITY = ["tasks", "tasks_failed", "model_calls", "model_fail", "tokens", "credits", "http_5xx", "audit_blocked", "active_runs"];
/** @param {Record<string, any>} row */
function isIdle(row) {
  return ACTIVITY.every((k) => !Number(row && row[k]));
}
/**
 * 这一行要不要落盘。有事的行一行不落；闲行离上一次落盘满十分钟才落；
 * 忙转闲的头一行照落——少了它，折线图上看到的是最后一格忙着的数一直拖到下一次有事，看不见「降回 0」。
 * @param {Record<string, any>} row
 * @param {{ at: number, idle: boolean }} last  上一次真落盘的时间、那一行闲不闲
 * @param {number} now
 */
function shouldWrite(row, last, now) {
  if (!isIdle(row)) return true;
  if (!last.idle) return true;
  return now - last.at >= IDLE_EVERY_MS;
}

// ---------- 定时跑 ----------
let timer = null;
/**
 * 开始每分钟滚一次。
 * @param getConfig  拿当前配置的函数（推送要用里面的 im 机器人地址）
 * @param gauges     额外的「当下是多少」，比如正在跑几趟任务
 * @param notifyFn   推送函数，默认 notify.pushBots。测试里换成假的
 */
function start({ getConfig = () => ({}), gauges = () => ({}), notifyFn = null, intervalMs = INTERVAL_MS } = {}) {
  if (timer) return timer;
  gaugeFn = gauges;
  lastAt = Date.now();
  loopArm();
  const push = notifyFn || ((cfg, text) => require("./notify").pushBots(cfg, text));
  // idle:false 起步：开机头一行总要落，看板上才知道进程起来过
  let last = { at: 0, idle: false };
  timer = setInterval(async () => {
    let row;
    try {
      row = snapshot();
      const now = Date.now();
      // 闲行不落盘，但告警照样每分钟判：磁盘快满这种事不等十分钟
      if (shouldWrite(row, last, now)) { write(row); last = { at: now, idle: isIdle(row) }; }
      loopNap(row, now);
    } catch (e) { log.warn("metrics", "滚快照出错", { err: e }); return; }
    let alerts = [];
    try { alerts = evaluate(row); } catch (e) { log.warn("metrics", "规则判断出错", { err: e }); return; }
    if (!alerts.length) return;
    for (const a of alerts) {
      log[a.level === "alert" ? "warn" : "info"]("metrics", a.text, { rule: a.id });
      // 推送失败不能反过来把定时器搞挂；notify 自己已经吞了单通道的错，这里再兜一层
      try { await push(getConfig() || {}, a.text); } catch (e) { log.warn("metrics", "告警推不出去", { err: e, rule: a.id }); }
    }
  }, Math.max(1000, intervalMs));
  // 不让这个定时器拖着进程不退出——它是个后台观察者，不是正事
  if (timer.unref) timer.unref();
  return timer;
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  loopDisarm();
}

module.exports = {
  bump, observe, wake, snapshot, write, read, evaluate, start, stop,
  _internals: { RULES, DIR, STATE_FILE, COOLDOWN_MS, KEEP_MONTHS, IDLE_EVERY_MS, isIdle, shouldWrite, loadState, saveState, shards, fileOf, diskFreePct, channelStreaks, channelHealth, STREAK_FRESH_MS, auditBlocked, pct, loopArm, loopDisarm, loopRead, loopNap, LOOP_RES_MS, LOOP_QUIET_MS, get loopArmed() { return !!loopHist; } },
};
