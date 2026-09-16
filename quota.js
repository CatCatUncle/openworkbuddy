"use strict";
/**
 * 按次计费的第三方 API：统一配置 + 额度闸门。
 *
 * 为什么要单独一个模块，而不是接着往 account.js 的积分里塞：
 *
 *   account.js 记的是**模型 token**——按输入/输出字数折算，模型换了折算率就变。
 *   这里记的是**按次计费的外部接口**：搜一次、生一张图、转一段音频。它们跟 token
 *   没有换算关系，一次就是一次，价目表在服务商那边，不在我们这儿。硬要合成一本账，
 *   结果是两边都算不准——管理员想知道"这个月搜索花了多少次"，只能看到一个被 token
 *   稀释过的积分数。
 *
 * 为什么必须有闸门：
 *
 *   钥匙只有一把（企业后台填的那把），全组织共用。没有闸门的时候，一个人写句
 *   "把这 500 个客户逐个搜一遍"，当天的搜索额度就见底了，而账单要到月底才看得见，
 *   到那时已经无法追溯是谁、哪一趟任务花的。所以这里做三件事：
 *     ① 调用之前先问一句还有没有额度（check）；
 *     ② 调完记一笔，带上是谁、哪个组织、走的哪家服务商（record）；
 *     ③ 后台能按天/按月/按人看出账（summary）。
 *
 * 默认值的取法：**默认全部不限**。这是个自建软件，绝大多数人是一个人用自己的 Key，
 * 给他设个上限纯属添堵。只有管理员在企业后台明确打开某一项，闸门才对那一项生效——
 * 跟 org.js 里 credits_enabled 默认关着是同一个道理。
 * 但「不限」不等于「不记」：流水一直在记，管理员先看得见花在哪，再决定要不要设限。
 */

const path = require("path");
const { dataPath } = require("./paths");
const store = require("./store");
const { AsyncLocalStorage } = require("async_hooks");

// WB_DATA_DIR 与 account.js / org.js 同一个口子：跑测试时指到临时目录
const DATA_DIR = process.env.WB_DATA_DIR || dataPath("data");
const USAGE_FILE = path.join(DATA_DIR, "api-usage.json");
/** 流水上限。一条约 130 字节，两万条 ≈ 2.6MB，够看三个月；超了从最旧的开始丢 */
const USAGE_CAP = 20000;

/**
 * 能力清单 —— 这一张表就是「企业后台能统一配哪些 API」的唯一出处。
 * 前端那一页、额度闸门、用量统计全读它，加一路新能力只改这里。
 *
 *   key        内部标识，也是流水里的 cap 字段
 *   label      后台上显示的名字
 *   unit       计量单位（管理员要知道"100"是 100 次还是 100 分钟）
 *   paid       真金白银 or 只是占带宽。false 的那几项默认不设限，只是让管理员能限速
 *   why        为什么这一项值得单独限——写给管理员看的，不是写给我们自己的
 *   configured 这一路的 Key 配在 config 的哪儿（后台一键跳过去）
 *   suggest    「设个合理额度」按钮填进去的值。按「一个十人小团队正常用一个月」估
 */
const CAPS = {
  search: {
    key: "search", label: "联网搜索", unit: "次", paid: true, order: 1,
    why: "Jina / Tavily / Brave 都是按次计费。一句「把这批客户逐个搜一遍」能在几分钟里跑掉几百次。",
    config: "search", icon: "search",
    suggest: { org_daily: 500, org_monthly: 8000, user_daily: 80 },
  },
  image: {
    key: "image", label: "生成图片", unit: "张", paid: true, order: 2,
    why: "单张几分到几毛不等，高分辨率更贵。批量出图是最容易失控的一路。",
    config: "media.image", icon: "image",
    suggest: { org_daily: 200, org_monthly: 3000, user_daily: 40 },
  },
  video: {
    key: "video", label: "生成视频", unit: "条", paid: true, order: 3,
    why: "最贵的一路，一条几块到几十块。默认就该给个上限。",
    config: "media.video", icon: "film",
    suggest: { org_daily: 20, org_monthly: 200, user_daily: 5 },
  },
  tts: {
    key: "tts", label: "语音合成", unit: "段", paid: true, order: 4,
    why: "按字符计费。整篇文章念一遍的开销远大于一句提示音。",
    config: "media.tts", icon: "volume-2",
    suggest: { org_daily: 300, org_monthly: 5000, user_daily: 60 },
  },
  asr: {
    key: "asr", label: "语音转写", unit: "段", paid: true, order: 5,
    why: "按音频时长计费。一场两小时的会议纪要是一次调用，但价钱不是。",
    config: "media.asr", icon: "mic",
    suggest: { org_daily: 100, org_monthly: 1500, user_daily: 20 },
  },
  fetch: {
    key: "fetch", label: "抓取网页", unit: "次", paid: false, order: 6,
    why: "自己不花钱，但浏览器渲染很吃这台服务器的内存，而且抓太狠会让对方站点把整台机器的 IP 封掉。",
    config: "", icon: "globe",
    suggest: { org_daily: 2000, org_monthly: 40000, user_daily: 300 },
  },
};
const CAP_KEYS = Object.keys(CAPS).sort((a, b) => CAPS[a].order - CAPS[b].order);

/** 一路能力的额度设置。三个上限各管各的，0 / 空 = 这一档不限 */
const CAP_DEFAULT = { enabled: false, org_daily: 0, org_monthly: 0, user_daily: 0 };

function emptyDb() { return { usage: [] }; }
function load() {
  const db = store.readJson(USAGE_FILE, emptyDb(), { strict: true });
  if (!Array.isArray(db.usage)) db.usage = [];
  return db;
}
function save(db) {
  if (db.usage.length > USAGE_CAP) db.usage = db.usage.slice(0, USAGE_CAP);
  store.writeJsonAtomic(USAGE_FILE, db);
}

/** 本地日期，跟 account.js 的 localDay 对齐：按服务器时区切天，不按 UTC */
function localDay(d) {
  const t = d ? new Date(d) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}
function localMonth(d) { return localDay(d).slice(0, 7); }

/**
 * 归一化一路能力的额度设置。后台传上来什么都可能（空串、null、负数、"abc"），
 * 一律拍成非负整数；认不出来的键直接丢掉，别让一个拼错的字段悄悄住进配置文件里。
 */
function normalizeCap(patch) {
  const out = { ...CAP_DEFAULT };
  if (!patch || typeof patch !== "object") return out;
  out.enabled = !!patch.enabled;
  for (const k of ["org_daily", "org_monthly", "user_daily"]) {
    const n = Math.floor(+patch[k]);
    out[k] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  return out;
}

/** 把存在组织设置里的那份补齐成完整的一张表（老组织没有这个字段，全走默认 = 不限） */
function quotaTable(orgSettings) {
  const saved = (orgSettings && orgSettings.api_quota) || {};
  const out = {};
  for (const k of CAP_KEYS) out[k] = normalizeCap(saved[k]);
  return out;
}

// ---------- 当前调用者：谁在花这笔钱 ----------
/**
 * 工具层（tools.js）不认识组织，也不该认识。它只在动手之前问一句「我现在能不能调」，
 * 答案由这里给。上下文用 AsyncLocalStorage 传，跟 tools.js 里 withPolicy 同一个路子：
 * 没进过 withActor 的调用（命令行、单机桌面版、定时任务）拿到 null = 不限 = 老行为。
 */
const actorStore = new AsyncLocalStorage();
function withActor(actor, fn) {
  if (!actor) return fn();
  return actorStore.run(actor, fn);
}
function currentActor() { return actorStore.getStore() || null; }

/**
 * 算某一路今天/本月已经用掉多少。
 * 只扫流水里日期对得上的那一段——流水是按时间倒序插的，扫到比今天早的就能停。
 */
function used(db, { org: orgId, cap, user }) {
  const day = localDay(), month = localMonth();
  let today = 0, thisMonth = 0, mine = 0;
  for (const e of db.usage) {
    if (e.cap !== cap) continue;
    if (orgId && e.org !== orgId) continue;
    if (e.month !== month) {
      // 倒序流水：撞上上个月就说明后面都比这更早，本月和今天的数都已经齐了
      if (e.month < month) break;
      continue;
    }
    const n = +e.n || 1;
    thisMonth += n;
    if (e.day === day) {
      today += n;
      if (user && e.user === user) mine += n;
    }
  }
  return { today, month: thisMonth, mine };
}

/**
 * 调用之前问一句。返回 { ok, why, left }。
 *
 * why 是给**模型**看的：它会把这句话原样念给用户，所以必须说清楚三件事——
 * 撞的是哪一道闸、还剩多少、去哪儿改。只说「额度不足」的话，用户和模型都只能干瞪眼。
 */
function check(cap, n = 1, actor) {
  const who = actor || currentActor();
  if (!who || !who.quota) return { ok: true, left: Infinity };
  const q = who.quota[cap];
  if (!q || !q.enabled) return { ok: true, left: Infinity };
  const meta = CAPS[cap] || { label: cap, unit: "次" };
  let db;
  try { db = load(); } catch { return { ok: true, left: Infinity }; } // 账本读不出来不该拦住正事
  const u = used(db, { org: who.org, cap, user: who.user });
  const need = Math.max(1, Math.floor(+n) || 1);
  const hit = (limit, got, scope) => {
    if (!limit) return null;
    if (got + need <= limit) return null;
    return { limit, got, scope };
  };
  const bad = hit(q.user_daily, u.mine, "你今天") || hit(q.org_daily, u.today, "本组织今天") || hit(q.org_monthly, u.month, "本组织本月");
  if (!bad) {
    // 「还剩多少」取三道闸里最紧的那道。注意别写成 `q.org_monthly && q.org_monthly - u.month`：
    // 上限为 0 表示**这一档不限**，可 `0 && x` 求出来是数字 0，会被当成「一次都不剩」
    const lefts = [[q.user_daily, u.mine], [q.org_daily, u.today], [q.org_monthly, u.month]]
      .filter(([limit]) => limit > 0)
      .map(([limit, got]) => Math.max(0, limit - got));
    return { ok: true, left: lefts.length ? Math.min(...lefts) : Infinity };
  }
  return {
    ok: false,
    left: Math.max(0, bad.limit - bad.got),
    why: `「${meta.label}」额度用完了：${bad.scope}已经用了 ${bad.got}/${bad.limit} ${meta.unit}。`
      + `额度由平台管理员在「企业管理 → API 与额度」里设，明天 0 点重置。`,
  };
}

/** 调完记一笔。记账失败绝不能反过来把已经成功的调用判成失败，所以整段吞异常 */
function record(cap, { n = 1, provider = "", model = "", meta = "", actor } = {}) {
  const who = actor || currentActor();
  try {
    const db = load();
    db.usage.unshift({
      ts: new Date().toISOString(), day: localDay(), month: localMonth(),
      cap, n: Math.max(1, Math.floor(+n) || 1),
      org: (who && who.org) || "default",
      user: (who && who.user) || "",
      provider: String(provider || "").slice(0, 40),
      model: String(model || "").slice(0, 60),
      meta: String(meta || "").slice(0, 120),
    });
    save(db);
  } catch (e) {
    console.warn("[额度] 流水没记上（不影响本次调用）：" + e.message);
  }
}

/**
 * 后台那一页要的全部数字：每一路的设置 + 今天/本月用量 + 用得最多的几个人。
 * 一次扫完整本流水，不要每路各扫一遍。
 */
function summary(orgId, quota) {
  const day = localDay(), month = localMonth();
  const rows = {};
  for (const k of CAP_KEYS) {
    rows[k] = { ...CAPS[k], quota: (quota && quota[k]) || { ...CAP_DEFAULT }, today: 0, month: 0, providers: {}, top: [] };
  }
  let db;
  try { db = load(); } catch { db = emptyDb(); }
  const byUser = {};
  for (const e of db.usage) {
    if (orgId && e.org !== orgId) continue;
    const r = rows[e.cap];
    if (!r) continue;
    if (e.month !== month) { if (e.month < month) break; continue; }
    const n = +e.n || 1;
    r.month += n;
    if (e.provider) r.providers[e.provider] = (r.providers[e.provider] || 0) + n;
    if (e.day === day) r.today += n;
    const bu = (byUser[e.cap] = byUser[e.cap] || {});
    if (e.user) bu[e.user] = (bu[e.user] || 0) + n;
  }
  for (const k of CAP_KEYS) {
    rows[k].top = Object.entries(byUser[k] || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([user, n]) => ({ user, n }));
    rows[k].providers = Object.entries(rows[k].providers).sort((a, b) => b[1] - a[1])
      .map(([name, n]) => ({ name, n }));
  }
  return { day, month, caps: CAP_KEYS.map((k) => rows[k]) };
}

/** 「一键设个合理额度」：把清单里那组建议值填进去并打开闸门 */
function suggested() {
  const out = {};
  for (const k of CAP_KEYS) out[k] = { enabled: true, ...CAPS[k].suggest };
  return out;
}

/** 把后台提交的整张表拍成干净的一份（只认清单里有的能力） */
function normalizeTable(patch) {
  const out = {};
  for (const k of CAP_KEYS) out[k] = normalizeCap(patch && patch[k]);
  return out;
}

module.exports = {
  CAPS, CAP_KEYS, CAP_DEFAULT,
  quotaTable, normalizeCap, normalizeTable, suggested,
  withActor, currentActor, check, record, summary,
  _internals: { load, save, used, localDay, localMonth, USAGE_FILE, USAGE_CAP, emptyDb },
};
