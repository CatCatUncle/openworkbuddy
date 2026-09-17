"use strict";
/**
 * 预算闸门：三级（令牌 → 用户 → 组织），先预扣，再按真实用量结算。
 *
 * 这是「额度做扎实」里最难的一块，因为它的两种失效方式都**不会报错**，
 * 只会在月底的账单上表现为一个大于预算的数字。翻过 LiteLLM 的 issue 之后，
 * 这两种失效方式各自对应下面一条设计：
 *
 * ── 失效方式一：并发穿透（stale spend）──────────────────────────────
 *   闸门写成「查一下这个月花了多少 → 没超就放行 → 调用 → 记账」的话，
 *   同时进来的 50 条请求会**全部**读到调用前那个数，于是全部放行。
 *   预算 100 块，一个 for 循环能花到 300 块，而每一次判断单看都是对的。
 *   Agent 这种场景尤其致命：它本来就是并发调工具、并发跑子任务的。
 *
 *   所以这儿是**预扣**：放行的那一刻就把「预计要花多少」记进 reserved，
 *   下一条请求看到的余额已经扣过了。真实花销回来之后再把预扣换成实扣（settle）。
 *   预估一律往多了算（按 max_tokens 全出满），宁可拦早一点，也不要放过去。
 *
 * ── 失效方式二：配了但没人执行（silently unenforced）────────────────
 *   后台有个输入框、库里存着一个数、代码里没有一处读它。管理员以为设了上限，
 *   实际没设——这比没有这个功能糟得多。org.js 里那段注释说的是同一件事。
 *
 *   所以：① 花钱的路**只有一条**（reserve → 调 → settle），别的地方不许自己判；
 *   ② 测试里有一条专门盯着「预算设了就真的拦得住」，并且带反向对照
 *      （没设的时候不能拦）；③ 后台那一页把「这条预算今天真的拦下过几次」显示出来——
 *      一条从来没拦过任何东西的预算，要么是设得太松，要么就是根本没接上。
 *
 * ── 花了多少，从哪儿算 ───────────────────────────────────────────
 *   唯一真相是流水账（usage-store 的月分片 JSONL），不是另存一个计数器：
 *   另存一个计数器就有第二份真相，两份迟早对不上，而对不上的那次一定是放行的那次。
 *   但每条请求都去读一遍整月流水又太慢，所以内存里放一份**缓存**：
 *   首次用到时从流水账里累出来，之后随 settle 递增，进程重启就重新累一遍。
 *   缓存坏了最坏的结果是重启一次自愈，而不是账错了没人知道。
 */

const pricing = require("./pricing");
const usageStore = require("./usage-store");

/** 预扣多久不结算就自动放掉。比任何一次正常调用都长得多——超过这个数说明调用方崩在半路了 */
const RESERVE_TTL_MS = 15 * 60 * 1000;

/** 三级的名字。顺序就是检查顺序：从最贴身的往最外面查，报错报**最先拦住**的那一级 */
const LEVELS = ["key", "user", "org"];

// scope → { spent, at }。scope 形如 "org:acme:2026-09" / "user:zhang:2026-09" / "key:vk_x:2026-09"
const spentCache = new Map();
// 活着的预扣：id → { at, est, scopes: [scope…] }
const live = new Map();

function monthKey(d) {
  const t = d ? new Date(d) : new Date();
  const p = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString();
  return p.slice(0, 7);
}

/**
 * 这一档这个月已经花掉多少（元）。第一次问的时候把当月流水累一遍，之后走缓存。
 *
 * 注意只累 cost 这一格，不累 cost_unknown 的那些——它们的 cost 是 0，
 * 但那个 0 的意思是「不知道」。把「不知道」当成「不花钱」累进已用额度里，
 * 结果是没登记价目的模型可以无限用，而这恰恰是最需要盯住的那种模型（刚上的新型号）。
 * 所以它们单独计数，闸门放行但后台会催着去补价目。
 */
function spentOf(scope, kind, id, mk) {
  const hit = spentCache.get(scope);
  if (hit) return hit;
  let spent = 0, unknown = 0;
  try {
    for (const r of usageStore.read({ from: mk + "-01", to: mk + "-31" })) {
      if (r.kind === "topup") continue;
      const mine = kind === "org" ? (r.org || "default") === id
        : kind === "user" ? r.user === id
        : r.vkey === id;
      if (!mine) continue;
      if (r.cost_unknown) unknown++;
      else spent += +r.cost || 0;
    }
  } catch {}
  const rec = { spent: round6(spent), unknown, reserved: 0 };
  spentCache.set(scope, rec);
  return rec;
}

function round6(n) { return Math.round((n + Number.EPSILON) * 1e6) / 1e6; }

/**
 * 把三级的上限读出来。0 / 空 / 没填 = 这一级不限。
 *
 * 为什么用户那一级要「个人设置优先于部门模板优先于组织默认」这个顺序：
 * 给某个人单独开口子是常事（新来的实习生先给 50，销售总监不限），
 * 而部门模板是**批量**给的默认值。反过来的话，一个人单独设过的数会被
 * 下一次改部门模板悄悄盖掉——盖掉的那天没有任何提示。
 */
function limitsOf({ org: orgSettings, user, vkey } = {}) {
  const b = (orgSettings && orgSettings.budget) || {};
  const num = (x) => {
    const n = typeof x === "string" ? parseFloat(x) : x;
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const deptLimit = () => {
    const t = ((orgSettings && orgSettings.dept_templates) || {})[(user && user.dept) || ""];
    return num(t && t.budget_yuan);
  };
  return {
    key: num(vkey && vkey.budget_yuan),
    user: num(user && user.budget_yuan) || deptLimit() || num(b.default_user_yuan),
    org: num(b.org_yuan),
  };
}

/**
 * 预估这一趟要花多少钱。**一律往多了估**：
 *   输入按真的算，输出按 max_tokens 全出满算，缓存按一点没命中算。
 * 估多了的后果是偶尔早拦一次（再调一次就过了）；估少了的后果是预算形同虚设。
 *
 * 两种写法，看有没有 cap：
 *   estimate({ model, prompt, max_tokens })        → 按 token 算（聊天 / 向量化）
 *   estimate({ cap, model, units })                → 按量算（搜索/生图/视频/语音）
 * 合成一个函数而不是两个，是为了 reserve 里不再分叉：预扣、拦截、结算那一整套
 * 逻辑跟钱怎么算出来的无关，分两条路只会让其中一条少修一次 bug。
 *
 * 按量那路的「往多了估」在调用方：视频要多少秒、语音要念多少字，只有调用方知道；
 * 它们传进来的就是请求里写的那个上限（duration / 文本长度），本来就是上限。
 */
function estimate(call = {}, opts = {}) {
  if (call && call.cap) {
    const c = pricing.costOfUnits({ cap: call.cap, model: call.model, units: call.units }, opts);
    return { yuan: c.yuan, unknown: c.unknown };
  }
  const { model, prompt = 0, max_tokens = 0 } = call || {};
  const out = Math.max(0, +max_tokens || 0) || 1024;
  const c = pricing.costOf({ model, prompt, cached: 0, completion: out }, opts);
  return { yuan: c.yuan, unknown: c.unknown };
}

/**
 * 占额度。够就返回一张收条（settle / release 都要它），不够就抛错。
 *
 * 抛出的错带 budget 字段：哪一级拦的、上限多少、已用多少、这一趟估了多少。
 * 只说「额度不足」是没用的——用的人得知道是自己的月额度用完了，还是整个公司的，
 * 这两件事该找的人完全不同。
 */
function reserve(ctx = {}) {
  const mk = monthKey();
  const est = estimate(ctx.usage || {}, ctx.price || {});
  const limits = limitsOf(ctx);
  const ids = { key: ctx.vkey && ctx.vkey.id, user: ctx.user && ctx.user.username, org: ctx.orgId || "default" };
  // 两份名单，别合成一份：
  //   held  = 真的占了额度的那几级（只有设了上限的才占）——拦人靠它
  //   all   = 这次调用牵涉到的**所有**层级——记账靠它
  // 分开的理由：一个没设上限的用户也得知道自己这个月花了多少（后台那张表要显示），
  // 而且管理员月中给他补设一个上限时，得马上按已经花掉的数来判，不能从零开始重新花一遍。
  // 只给「设了上限的」记账的话，那一格永远是 0，补设上限等于凭空多给一个月的预算。
  const held = [], all = [];
  for (const lv of LEVELS) {
    if (!ids[lv]) continue;
    const scope = `${lv}:${ids[lv]}:${mk}`;
    const rec = spentOf(scope, lv, ids[lv], mk);
    all.push(scope);
    if (!limits[lv]) continue;
    if (rec.spent + rec.reserved + est.yuan > limits[lv]) {
      // 拿这一组里**最小的非零值**当尺子定小数位数，见 pricing.yuanText 那段注释：
      // 按最大的定，「这一趟还要 0.00 元」会把整句话的重点四舍五入掉。
      const ref = Math.min(...[limits[lv], rec.spent, rec.reserved, est.yuan].filter((x) => x > 0));
      const e = new Error(
        `${LEVEL_TEXT[lv]}：上限 ${pricing.yuanText(limits[lv], ref)}，` +
        `已用 ${pricing.yuanText(rec.spent, ref)}${rec.reserved ? `（另有 ${pricing.yuanText(rec.reserved, ref)} 正在跑）` : ""}，` +
        `这一趟还要 ${pricing.yuanText(est.yuan, ref)}。`);
      e.status = 402;
      e.budget = { level: lv, id: ids[lv], limit: limits[lv], spent: rec.spent, reserved: rec.reserved, need: est.yuan };
      // 拦下来这件事要留痕：后台靠它回答「这条预算到底有没有在干活」
      rec.blocked = (rec.blocked || 0) + 1;
      rec.blocked_at = Date.now();
      throw e;
    }
    held.push(scope);
  }
  sweep();
  const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  for (const s of held) { const r = spentCache.get(s); r.reserved = round6(r.reserved + est.yuan); }
  const handle = { id, at: Date.now(), est: est.yuan, unknown: est.unknown, scopes: held, all };
  live.set(id, handle);
  return handle;
}

// 拦下来的时候这句话是**唯一**的线索，所以三级各写各的：是自己的月额度用完了，
// 还是这把 Key 的，还是整个公司的——该找谁完全不同，混成一句「额度不足」等于没说。
const LEVEL_TEXT = {
  key: "这把 API Key 这个月的预算用完了",
  user: "你这个月的预算用完了",
  org: "整个组织这个月的预算用完了，不是你一个人的",
};

/** 调完了，把预扣换成真实花销。actualYuan 省略 = 按预估算（异常路径的兜底） */
function settle(handle, actualYuan) {
  if (!handle || !live.has(handle.id)) return;
  live.delete(handle.id);
  const real = Number.isFinite(+actualYuan) ? Math.max(0, +actualYuan) : handle.est;
  for (const s of handle.scopes) {          // 占过额度的：把预扣退掉
    const r = spentCache.get(s);
    if (r) r.reserved = round6(Math.max(0, r.reserved - handle.est));
  }
  for (const s of handle.all || handle.scopes) {   // 所有层级：都记上这一笔真实花销
    const r = spentCache.get(s);
    if (r) r.spent = round6(r.spent + real);
  }
}

/** 这一趟压根没发出去（渠道挂了、参数错了），把占的额度还回去 */
function release(handle) {
  if (!handle || !live.has(handle.id)) return;
  live.delete(handle.id);
  for (const s of handle.scopes) {
    const r = spentCache.get(s);
    if (r) r.reserved = round6(Math.max(0, r.reserved - handle.est));
  }
}

/**
 * 把超时没结算的预扣放掉。
 *
 * 不扫的话，任何一次「调用方崩在半路、settle 没被调到」都会让那份额度**永久**占着，
 * 而且只有重启才能清掉。一个月下来预算会莫名其妙地越来越少，
 * 没有任何一条日志解释为什么——这是那种查三天查不出来的毛病，所以宁可多这十行。
 */
function sweep(now = Date.now()) {
  let n = 0;
  for (const [id, h] of live) {
    if (now - h.at < RESERVE_TTL_MS) continue;
    live.delete(id); n++;
    for (const s of h.scopes) {
      const r = spentCache.get(s);
      if (r) r.reserved = round6(Math.max(0, r.reserved - h.est));
    }
  }
  return n;
}

/** 后台那一页：三级各自的上限 / 已用 / 正在跑 / 拦下过几次 */
function status(ctx = {}) {
  const mk = monthKey();
  const limits = limitsOf(ctx);
  const ids = { key: ctx.vkey && ctx.vkey.id, user: ctx.user && ctx.user.username, org: ctx.orgId || "default" };
  return LEVELS.map((lv) => {
    if (!ids[lv]) return null;
    const rec = spentOf(`${lv}:${ids[lv]}:${mk}`, lv, ids[lv], mk);
    return {
      level: lv, id: ids[lv], limit: limits[lv],
      spent: rec.spent, reserved: rec.reserved, unknown: rec.unknown,
      blocked: rec.blocked || 0,
      left: limits[lv] ? round6(Math.max(0, limits[lv] - rec.spent - rec.reserved)) : null,
      // 一条设了上限、整个月一次都没拦过、而且用掉的还不到一成的预算，多半是设得太松
      // （或者根本没接上）。这个判断不自动改任何东西，只是在后台上标一句话。
      idle: !!limits[lv] && !(rec.blocked || 0) && rec.spent < limits[lv] * 0.1,
    };
  }).filter(Boolean);
}

/**
 * 出门前问一句：这个人 / 这个组织的钱是不是已经花完了。
 * 花完了返回那一级的 { level, id, limit, spent, reserved, message }，没花完返回 null。
 *
 * 为什么需要它，而不是一律用 reserve：
 * reserve 是「预扣 → 跑 → 结算」那一套，它要求调用方能在**出发前**
 * 估出这一趟要花多少钱。按量那几路估得准（几张图、几秒视频）；
 * 但一次 agent 任务要跑几分钟、几十轮对话、中途还会换型号，
 * 出发前那个估值既不准，又会把一笔预扣挂在 live 里十几分钟——
 * 超过 TTL 还会被 sweep 掉，反而让预算忽高忽低。
 *
 * 所以长任务这边改成「入口处问一句，跑完如实记一笔」：
 * 它拦不住「最后一趟超支」（跑到一半才超的那笔照旧跑完），
 * 但拦得住「超支之后的第二、第三、第一百趟」——防滥用要的就是这个。
 * 想要一分钱都不超，该用的是 reserve，不是把这个函数改严。
 */
function exhausted(ctx = {}) {
  for (const lv of status(ctx)) {
    if (!lv.limit) continue;                       // 没设上限的那几级不参与判断
    if (lv.spent + lv.reserved < lv.limit) continue;
    const ref = Math.min(...[lv.limit, lv.spent, lv.reserved].filter((x) => x > 0));
    // 拦下来这件事要留痕，跟 reserve 那边一个口径：
    // 后台靠它回答「这条预算到底有没有在干活」
    const rec = spentCache.get(`${lv.level}:${lv.id}:${monthKey()}`);
    if (rec) { rec.blocked = (rec.blocked || 0) + 1; rec.blocked_at = Date.now(); }
    return {
      ...lv,
      message: `${LEVEL_TEXT[lv.level]}：上限 ${pricing.yuanText(lv.limit, ref)}，`
        + `已用 ${pricing.yuanText(lv.spent, ref)}${lv.reserved ? `（另有 ${pricing.yuanText(lv.reserved, ref)} 正在跑）` : ""}。`,
    };
  }
  return null;
}

/**
 * 一笔没走过 reserve/settle 的花销，补进这个进程的账里。
 *
 * 为什么非得有这一条：spentOf 只在**第一次**问到某个月的时候扫一遍流水，
 * 之后就吿缓存了。走 reserve/settle 那条路的调用会把新花的钱加回缓存；
 * 而 account.chargeRun（内部聊天）只往磁盘追一行流水。不补的话，
 * 进程跑着的这整个月里，内部聊天花的钱在闸子眼里永远是 0——
 * 后台那一页能看到（它直接扫流水），而闸子看不到，两个数当场打架。
 *
 * 只动内存那份缓存，不写盘：持久化那一半是调用方自己的事
 * （usageStore.append），这儿再写一遍就重复计了。
 */
function record({ orgId = "default", user = "", vkey = "", yuan = 0 } = {}) {
  const v = +yuan;
  if (!Number.isFinite(v) || v <= 0) return;
  const mk = monthKey();
  const ids = { key: vkey, user, org: orgId };
  for (const lv of LEVELS) {
    if (!ids[lv]) continue;
    // 先 spentOf 一下：缓存里还没这个 scope 的话，得先把本月已有的累出来，
    // 否则下一句 +v 会把一个只有这一笔的数当成「本月全部」。
    // 而且流水里那一行可能已经被 append 过了，那就会双计——所以
    // 调用方要么在 append **之前**调这一句，要么就别调。
    const rec = spentOf(`${lv}:${ids[lv]}:${mk}`, lv, ids[lv], mk);
    rec.spent = round6(rec.spent + v);
  }
}

/** 流水改过了（补记、迁移、测试）就把缓存扔掉，下次重新从账本累 */
function invalidate() { spentCache.clear(); }

module.exports = {
  reserve, settle, release, status, exhausted, record, limitsOf, estimate, invalidate, sweep,
  RESERVE_TTL_MS, LEVELS, LEVEL_TEXT,
  _internals: { spentCache, live, monthKey, spentOf, round6 },
};
