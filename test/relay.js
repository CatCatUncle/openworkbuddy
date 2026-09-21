"use strict";
/**
 * API 中转站：虚拟 Key、计价、额度闸门、后台那一页的接口、对外的 /v1。
 * 公司买的 API 不只是对话，所以这里把搜索 / 生图 / 生视频 / 语音合成 / 转写 / 向量化
 * 每一路都真的跑一遍（上游是本地起的假服务，不花钱、不联网），
 * 而且连员工在界面上自己跑的那一份一起管——花的是同一笔预算。
 *
 *   node test/relay.js
 *
 * 这套东西跟别的功能有一处根本不同：**它坏掉的时候不报错**。
 * 界面正常、日志干净、每一次调用都成功返回，只有月底那张账单上多一个零。
 * 所以下面每一条正向断言后面都跟一个反向对照——不是为了对称好看，是因为
 * 「额度生效了」这句话，只有在「没设上限时不拦」同时成立的前提下才有意义。
 *
 * 盯死七种坏法，每一种都真出现过（自己踩的，或者 new-api / one-api / LiteLLM 的 issue 里躺着的）：
 *
 *   ① **并发穿透。** 「查余额 → 放行 → 调 → 记账」这个顺序下，同时进来的几十条请求
 *      读到的是同一个调用前的数，于是全部放行。预算 10 块能花到 30，
 *      而每一次判断单看都对。agent 场景尤其致命——它本来就是并发调工具的。
 *   ② **0 被当成「一分钱都不剩」。** 上限填 0 的语义是「不限」。判空判错，
 *      整个组织的调用当场全挂，报错还写着「额度用完了」。
 *   ③ **认不出的型号按 0 元入账。** 账面永远对、跟真实账单永远对不上，而且一个字都不报。
 *   ④ **配了但没人执行。** 后台有输入框、库里存着数、代码里没有一处读它。
 *      `dept_templates.budget_yuan` 就是这么丢过的：limitsOf 读它，normalize 把它删了。
 *   ⑤ **折扣被取整。** 0.8 走了 Math.floor 变成 0，而 0 在 discountOf 里等于「填错了」，
 *      于是八折悄悄变回原价——没有任何一条日志会提这件事。
 *   ⑥ **凭一个 id 动别人组织的 Key。** Key 上写着 org，路径里只有 id。
 *   ⑦ **只管住了对外那条路。** 中转站发出去的 Key 开头就在闸子下面过，
 *      员工在界面上点的、定时任务跑的以前不过——同一笔预算漏了一半，
 *      而漏的那一半恰好是能一直点「重试」的那一半。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

// 必须先于任何 require：这几个模块在加载的那一刻就把 DATA_DIR 定死了。
// 不隔离的话，这套测试会往用户真正的 vkeys.json、账号表和流水账里写东西。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-relay-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const express = require(path.join(ROOT, "node_modules/express"));
const pricing = require(path.join(ROOT, "pricing"));
const budget = require(path.join(ROOT, "budget"));
const vkeys = require(path.join(ROOT, "vkeys"));
const org = require(path.join(ROOT, "org"));
const account = require(path.join(ROOT, "account"));
const admin = require(path.join(ROOT, "admin"));
const lifecycle = require(path.join(ROOT, "lifecycle"));
const usageStore = require(path.join(ROOT, "usage-store"));
const relay = require(path.join(ROOT, "relay"));
const tools = require(path.join(ROOT, "tools"));

admin.setDeployment({ shell: false, host: "0.0.0.0" }); // 服务器形态：平台/租户那道闸开着

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else {
    fail++;
    const tail = extra === undefined ? "" : "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400);
    console.log("  ✗ " + name + tail);
  }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}
/** 只关心「抛了没有、抛的是哪一句」，不关心异常对象本身 */
function threw(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

const MK = budget._internals.monthKey();
/** 往账本里塞一笔中转站流水。真实路径（relay.js 里那个 done）写的就是这个形状 */
function bill(row) {
  usageStore.append({
    ts: new Date().toISOString(), day: MK + "-15",   // 日子落在本月那一片里，跟 budget 查的区间对齐
    kind: "relay", source: "api", calls: 1, prompt: 0, cached: 0, completion: 0,
    org: org.DEFAULT_ORG, user: "", vkey: "", model: "gpt-4o", cost: 0, ...row,
  });
  budget.invalidate();   // 账本改了缓存就不能再信（budget.js 开头那段说的「第二份真相」）
}

/* ============================================================
   【1】价目：认不出 ≠ 0 元
   ============================================================ */
console.log("\n【1】价目表：四层覆盖、认不出的不算 0 元、缓存单独一格价");
{
  const c = pricing.costOf({ model: "gpt-4o", prompt: 1e6, cached: 0, completion: 0 });
  ok(!c.unknown && c.yuan > 0, "内置表认得出 gpt-4o，算得出钱", c);
  // 单位是元/百万 token：一百万个输入 token 应该正好等于表里那个 in。
  // 这一条不是形式主义——后台那个价格输入框上写的是哪个单位，差一千倍。
  eq(c.yuan, pricing.BUILTIN["gpt-4o"].in, "单位真的是「元 / 百万 token」（1e6 个输入 token = 表里的 in）");

  const u = pricing.costOf({ model: "某个刚上线的型号-v9", prompt: 1e6, completion: 1e6 });
  ok(u.unknown === true && u.yuan === 0, "没登记价目的型号标成 unknown", u);
  ok(pricing.costOf({ model: "gpt-4o", prompt: 0, completion: 0 }).unknown === false,
     "反向对照：认得出的型号哪怕一个 token 没用，unknown 也是 false（0 元 ≠ 不知道）");

  // 前缀族：官网发一个带日期的版本号，不该让整条价目失效
  const dated = pricing.priceOf("gpt-4o-2026-05-13");
  ok(dated && dated.key === "gpt-4o", "带日期后缀的型号回落到同族价目", dated && dated.key);
  ok(pricing.priceOf("zzz-4o-2026-05-13") === null, "反向对照：前缀对不上的不会硬凑一个价出来");

  // 缓存命中那一格
  const noCache = pricing.costOf({ model: "doubao-seed-1-6", prompt: 1e6, cached: 1e6, completion: 0 });
  eq(noCache.yuan, pricing.BUILTIN["doubao-seed-1-6"].in,
     "这家没给缓存价，命中就按原价收——不替供应商猜一个折扣（猜低了账永远对不上，而且是往「我们以为便宜」的方向错）");
  const withCache = pricing.costOf({ model: "deepseek-chat", prompt: 1e6, cached: 1e6, completion: 0 });
  eq(withCache.yuan, pricing.BUILTIN["deepseek-chat"].cached_in, "这家给了缓存价，命中就按缓存价收");
  ok(withCache.yuan < pricing.BUILTIN["deepseek-chat"].in, "反向对照：缓存价确实比原价便宜，不是同一个数");

  // 四层覆盖：内置 → 管理员手填 → 渠道自带
  const merged = pricing.tableFor({
    config: { prices: { "gpt-4o": { in: 1, out: 2 } } },
    provider: { prices: { "deepseek-chat": { in: 0.5, out: 1 } } },
  });
  eq(merged.table["gpt-4o"].in, 1, "管理员手填的盖住内置的");
  eq(merged.from["gpt-4o"], "admin", "而且记得住这个价是哪一层给的（后台那张表要显示来源）");
  eq(merged.from["deepseek-chat"], "channel", "渠道上的覆盖盖在最上面");
  eq(merged.from["claude-opus-5"], "builtin", "反向对照：没人覆盖的还是内置");

  // 折扣
  const full = pricing.costOf({ model: "gpt-4o", prompt: 1e6 });
  const off = pricing.costOf({ model: "gpt-4o", prompt: 1e6 }, { discount: 0.8 });
  ok(Math.abs(off.yuan - full.yuan * 0.8) < 1e-6, "八折就是八折", { full: full.yuan, off: off.yuan });
  eq(pricing.costOf({ model: "gpt-4o", prompt: 1e6 }, { discount: 0 }).yuan, full.yuan,
     "折扣填 0 不是「全免」，是填错了——按不打折算，宁可多收");
  eq(pricing.costOf({ model: "gpt-4o", prompt: 1e6 }, { discount: 1.5 }).yuan, full.yuan,
     "反向对照：填个大于 1 的数也不会变成加价");
}

/* ============================================================
   【2】三档上限：读得出来，顺序对
   ============================================================ */
console.log("\n【2】上限的三档：Key → 人 → 组织，个人设置压得住部门模板");
{
  const settings = {
    budget: { org_yuan: 1000, default_user_yuan: 50 },
    dept_templates: { 销售: { role: "member", monthly_quota: 0, budget_yuan: 300 } },
  };
  eq(budget.limitsOf({ org: settings, user: { username: "a", dept: "销售" } }).user, 300,
     "没单独设过的人，按他部门模板那个数");
  eq(budget.limitsOf({ org: settings, user: { username: "a", dept: "销售", budget_yuan: 20 } }).user, 20,
     "单独设过就压住部门模板（反过来的话，下次改部门模板会把它悄悄盖掉，而且没有任何提示）");
  eq(budget.limitsOf({ org: settings, user: { username: "a", dept: "行政" } }).user, 50,
     "部门模板里没填的，落到组织默认");
  eq(budget.limitsOf({ org: settings, vkey: { id: "k", budget_yuan: 8 } }).key, 8, "Key 自己那一档");
  eq(budget.limitsOf({ org: settings }).org, 1000, "组织那一档");
  eq(budget.limitsOf({}).org, 0, "反向对照：什么都没设时三档全是 0（= 不限），不是继承了上一次的");

  // ④ 的钉子：部门模板走一遍 org 的 normalize，budget_yuan 必须还在。
  // 这一格被删掉的时候，界面上填得进去、存得下来、执行时永远是 0 = 不限。
  const back = org.normalizeDeptTemplates({ 销售: { role: "member", monthly_quota: 0, budget_yuan: 300 } });
  eq(back.销售.budget_yuan, 300, "部门模板过一遍 normalize，budget_yuan 还在");
  eq(org.normalizeDeptTemplates({ 销售: { role: "member" } }).销售.budget_yuan, 0,
     "反向对照：本来就没填的还是 0，不是凭空补一个数");
  eq(org.normalizeDeptTemplates({ 销售: { role: "superadmin" } }).销售.role, "member",
     "模板里塞个没有的角色会被拍回 member（办入职时是照着它建号的）");
}

/* ============================================================
   【3】额度闸门：拦得住、拦对档、不拦不该拦的
   ============================================================ */
console.log("\n【3】额度闸门：预扣、并发、0 = 不限、算不出钱的不进已用额度");
{
  budget.invalidate();
  const st = { budget: { org_yuan: 1, default_user_yuan: 0 } };
  // 预估一律往多了算：输出按 max_tokens 全出满。一百万个 gpt-4o 输出 token 远超 1 元
  const big = { org: st, orgId: "default", usage: { model: "gpt-4o", prompt: 0, max_tokens: 1e6 } };
  const e = threw(() => budget.reserve(big));
  ok(e && e.status === 402, "超了就拦，而且是 402（不是 500，也不是静悄悄放过去）", e && e.message);
  ok(e && e.budget && e.budget.level === "org", "报得出拦在哪一档——该找谁完全不同", e && e.budget);
  ok(e && /整个组织/.test(e.message), "错误里直说是整个组织的额度，不是「你的」", e && e.message);

  budget.invalidate();
  let freeHold = null;
  const noLimit = threw(() => { freeHold = budget.reserve({ org: { budget: { org_yuan: 0 } }, orgId: "default", usage: { model: "gpt-4o", prompt: 0, max_tokens: 1e6 } }); });
  ok(noLimit === null, "反向对照：上限 0 = 不限，同一趟调用一点不拦（② 那个坑）", noLimit && noLimit.message);
  budget.release(freeHold);

  // ① 并发穿透：预扣必须在转发**之前**就生效，
  //    否则下一条请求读到的还是这一条调用前的余额。
  budget.invalidate();
  const st2 = { budget: { org_yuan: 10 } };   // 每趟估 4.26 元，所以第三趟必须被拦
  const one = () => budget.reserve({ org: st2, orgId: "default", usage: { model: "gpt-5-nano", prompt: 0, max_tokens: 1.5e6 } });
  const holds = [];
  let blockedAt = 0;
  for (let i = 1; i <= 10; i++) {
    try { holds.push(one()); } catch { blockedAt = i; break; }
  }
  eq(blockedAt, 3, "连着预扣到第 3 趟就被拦住——余额是「已经扣过前两趟」的那个数，不是调用前的数");
  const st0 = budget.status({ org: st2, orgId: "default" })[0];
  ok(st0.reserved > 0, "占住的额度记在 reserved 上（还没结算，但已经不能再花了）", st0);
  ok(st0.blocked >= 1, "拦下来这件事留了痕——后台靠它回答「这条预算到底有没有在干活」", st0);

  budget.settle(holds[0], 0.01);
  const st1 = budget.status({ org: st2, orgId: "default" })[0];
  ok(st1.spent >= 0.01 && st1.reserved < st0.reserved,
     "结算把预扣换成实扣（估着要花 4 块，实际一分钱，占的那 4 块退回去）", { before: st0, after: st1 });

  const before = budget.status({ org: st2, orgId: "default" })[0].reserved;
  budget.release(holds[1]);
  const after = budget.status({ org: st2, orgId: "default" })[0].reserved;
  ok(after < before, "压根没发出去的那趟走 release，占的额度原样还回去（扣掉的话月底才发现，而且永远说不清）", { before, after });

  // 崩在半路的那种：预扣挂着没人结算。不扫的话这份额度**永久**占着，只有重启能清
  budget.invalidate();
  const stuckOrg = { budget: { org_yuan: 100 } };
  budget.reserve({ org: stuckOrg, orgId: "sweep-org", usage: { model: "gpt-4o", prompt: 100, max_tokens: 100 } });
  ok(budget.status({ org: stuckOrg, orgId: "sweep-org" })[0].reserved > 0, "预扣先占着");
  eq(budget.sweep(Date.now()), 0, "反向对照：还在 TTL 之内的不会被扫掉");
  eq(budget.sweep(Date.now() + budget.RESERVE_TTL_MS + 1), 1, "超时还没结算的预扣被扫掉了");
  eq(budget.status({ org: stuckOrg, orgId: "sweep-org" })[0].reserved, 0, "占的额度还回来了");

  // ③ 的另一半：算不出钱的那几笔不能进已用额度
  budget.invalidate();
  bill({ org: "unk-org", model: "某个刚上线的型号-v9", cost: 0, cost_unknown: true });
  const unkSt = budget.status({ org: { budget: { org_yuan: 1 } }, orgId: "unk-org" })[0];
  eq(unkSt.spent, 0, "算不出钱的那笔没被当成「0 元」累进已用额度");
  eq(unkSt.unknown, 1, "但单独记了一笔，后台会拿它催着去补价目");
  bill({ org: "unk-org2", model: "gpt-4o", cost: 0.25 });
  eq(budget.status({ org: { budget: { org_yuan: 1 } }, orgId: "unk-org2" })[0].spent, 0.25,
     "反向对照：算得出钱的那笔照常累进去（不是「一律不算」）");
}

/* ============================================================
   【4】虚拟 Key
   ============================================================ */
console.log("\n【4】虚拟 Key：明文只出现一次，四种拒法各有各的理由");
{
  const made = vkeys.create({ name: "小程序后台", org: "acme", user: "xiaoyuan", budget_yuan: 50, by: "laoban" });
  ok(made.secret.startsWith(vkeys.PREFIX), "发出来的明文带 owb-sk- 前缀（误贴到哪儿也一眼知道该去哪儿吊销）", made.secret.slice(0, 12));
  ok(made.key.hash === undefined, "返回给界面的那一份**没有** hash 这一格", Object.keys(made.key));
  ok(!JSON.stringify(vkeys.list({ org: "acme" })).includes(made.secret.slice(8)),
     "列表里找不到明文的任何一段——能再看一次的东西，就不是「只有对方知道」");
  ok(/…/.test(made.key.mask), "列表里给的是打点的掩码：够认出是哪一把，又拼不回原文", made.key.mask);

  const hit = vkeys.verify(made.secret, { ip: "1.2.3.4", model: "gpt-4o" });
  ok(hit && hit.key && !hit.reason, "拿明文验得过");
  // 末位换成一个**保证不同**的字符：直接拼 "x" 的话，碰上原本就以 x 结尾的那一把，
  // 这条反向对照就变成了拿原文再验一次，会随机地假过
  const tampered = made.secret.slice(0, -1) + (made.secret.slice(-1) === "x" ? "y" : "x");
  ok(vkeys.verify(tampered) === null, "反向对照：改一个字符就验不过");
  ok(vkeys.verify("sk-别人家的格式") === null, "前缀不对的直接认不出来（连查都不用查）");

  const only = vkeys.create({ name: "只给便宜的", org: "acme", models: ["gpt-5-nano"] });
  ok(vkeys.verify(only.secret, { model: "gpt-5-nano" }).reason === undefined, "白名单内的型号放行");
  ok(!!vkeys.verify(only.secret, { model: "claude-opus-5" }).reason,
     "白名单外的型号当场挡下（不然「只给他便宜的型号」就只是句口头承诺）");
  const star = vkeys.create({ name: "整个 4o 族", org: "acme", models: ["gpt-4*"] });
  ok(vkeys.verify(star.secret, { model: "gpt-4.1" }).reason === undefined, "尾部 * 认整族");
  ok(!!vkeys.verify(star.secret, { model: "gpt-5.2" }).reason, "反向对照：* 只到族为止，不是「全放」");

  const ipOnly = vkeys.create({ name: "只给内网", org: "acme", ips: ["10.0.0.0/8"] });
  ok(vkeys.verify(ipOnly.secret, { ip: "10.1.2.3" }).reason === undefined, "网段内放行");
  ok(!!vkeys.verify(ipOnly.secret, { ip: "8.8.8.8" }).reason, "网段外挡下——Key 泄漏之后这是最后一道门");

  const old = vkeys.create({ name: "外包三个月", org: "acme", expires_at: "2020-01-01" });
  ok(!!vkeys.verify(old.secret, {}).reason, "过了期的用不了（给外包发的那把，不用记得回来收）");

  const r = vkeys.revoke(made.key.id, "laoban");
  ok(r.enabled === false && r.revoked_at, "吊销之后停用、留档");
  ok(!!vkeys.verify(made.secret, {}).reason, "吊销之后立刻验不过");
  ok(vkeys.list({ org: "acme" }).some((k) => k.id === made.key.id),
     "反向对照：那一行还留在表里——「上个月这 300 块是哪把 Key 花的」得查得到");

  vkeys.touch(made.key.id);
  eq(vkeys.list({ org: "acme" }).find((k) => k.id === made.key.id).calls, 1, "用过一次记一次");
  ok(threw(() => vkeys.remove(made.key.id)) !== null, "用过的删不掉（删了它花过的钱就成了无主账）");
  const fresh = vkeys.create({ name: "发错了", org: "acme" });
  ok(threw(() => vkeys.remove(fresh.key.id)) === null, "反向对照：一次没用过的可以直接删掉");

  vkeys.create({ name: "别人家的", org: "other-co" });
  ok(vkeys.list({ org: "acme" }).every((k) => k.org === "acme"), "按组织过滤，看不到别人家的");
  eq(vkeys.list({ org: "other-co" }).length, 1, "反向对照：别人家那一把确实存在，只是不在这张表里");
}

/* ============================================================
   【5】组织设置：折扣不许被取整
   ============================================================ */
console.log("\n【5】组织设置：0.8 折不会被 Math.floor 拍回原价");
{
  const co = org.createOrg({ name: "取整测试", actor: "sys" });
  const s = org.settingsOf(org.updateOrg(co.id, { settings: { price_discount: 0.8, budget: { org_yuan: "500.5", default_user_yuan: -3 } } }, "sys"));
  eq(s.price_discount, 0.8,
     "⑤ 折扣是小数，不走整数那条 Math.floor（0.8 取整成 0，而 0 在 discountOf 里 = 填错了 = 原价，一条日志都不会提）");
  eq(s.budget.org_yuan, 500.5, "钱按元存、保留两位小数、不取整（把 500.5 改成 500 就是替管理员改了他填的数）");
  eq(s.budget.default_user_yuan, 0, "负数当没填——一个负的上限会让「够不够」永远为假，整个组织一个请求都发不出去");
  eq(org.settingsOf(org.updateOrg(co.id, { settings: { price_discount: 0 } }, "sys")).price_discount, 1, "填 0 不是全免，回落到 1");
  eq(org.settingsOf(org.updateOrg(co.id, { settings: { price_discount: 3 } }, "sys")).price_discount, 1,
     "反向对照：填个大于 1 的数也不会变成加价");
  eq(org.normalizeBudget("乱填的").org_yuan, 0, "budget 整个填成别的类型也不炸，按没填算");
  eq(org.normalizeBudget({ org_yuan: 10, 偷塞的: 1 }).偷塞的, undefined,
     "只认认识的那两格——企业设置那条路由是把 settings 整个交进来的");
}

/* ============================================================
   【6】离职：他名下那几把 Key 得跟着收
   ============================================================ */
console.log("\n【6】离职：停用账号关的是他本人的路，中转站那把 Key 得单独收");
{
  account._internals.register("hr-boss", "pw-hr-boss-x7");    // 第一个账号 = 组织所有者
  account._internals.register("yaozou", "pw-yaozou-x7");
  const actor = account._internals.loadUsers().users.find((u) => u.username === "hr-boss");
  const orgId = org.orgIdOf(actor);
  const mine = vkeys.create({ name: "他接的那个小程序", org: orgId, user: "yaozou" });
  const others = vkeys.create({ name: "别人的", org: orgId, user: "hr-boss" });

  const receipt = lifecycle.offboard(actor, "yaozou");
  eq(receipt.revoked.vkeys, 1, "他名下那一把被收了");
  eq(receipt.revoked.vkey_names, ["他接的那个小程序"], "单子上写着是哪一把——交接的人得知道去改哪个环境变量");
  ok(!!vkeys.verify(mine.secret, {}).reason, "这把 Key 立刻失效（下一次调用就是 401）");
  ok(receipt.warnings.some((w) => /通知/.test(w)), "而且提醒去通知对接的人——程序不会自己知道", receipt.warnings);
  ok(/中转站 Key/.test(lifecycle.receiptText(receipt)),
     "回执上印出来了。前面几步关的都是**他本人**登进来的路；那把 owb-sk- 躺在某个业务系统的环境变量里，" +
     "跟他在不在职一点关系都没有——单子上不写，就没人会去改",
     lifecycle.receiptText(receipt).slice(0, 300));
  ok(vkeys.verify(others.secret, {}).reason === undefined,
     "反向对照：别人名下的那把一点没动（不是「把这个组织的 Key 全停了」）");
}

/* ============================================================
   【7】后台那一页的接口  +  【8】对外的 /v1
   ============================================================ */
(async () => {
  console.log("\n【7】后台接口：一趟请求回全部、跨组织动不了、__proto__ 塞不进价目表");

  const WS = path.join(HOME, "workspace");
  fs.mkdirSync(WS, { recursive: true });
  tools.setWorkspaceDir(WS);

  const config = {
    providers: [{ id: "ark", name: "火山方舟", kind: "ark", base_url: "https://example.invalid/api/v3", api_key: "sk-假的" }],
    models: [{ name: "主力", model: "doubao-seed-1-6", channel: "ark" }, { name: "没挂渠道的", model: "孤儿型号" }],
  };
  let saved = 0;

  // 中间件顺序照抄 server.js，一步不省——这一页的权限全靠这个顺序
  const srv = express();
  srv.use(express.json());
  srv.use(account.createRouter({}));
  srv.use(account.authGuard);
  srv.use(admin.tenantScope({ withWorkspace: tools.withWorkspace, withPolicy: tools.withPolicy, getWorkspaceDir: tools.getWorkspaceDir }));
  srv.use(admin.platformGuard);
  srv.use(admin.redactGuard);
  srv.use(admin.createAdminRouter({
    readConfig: () => config,
    saveConfig: () => { saved++; },
    orgUsage: () => ({ files: 0, bytes: 0 }),
  }));
  const server = srv.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const PORT = server.address().port;

  function call(method, url, { body, cookie } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port: PORT, method, path: url,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          ...(cookie ? { cookie } : {}),
        },
      }, (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          const sc = res.headers["set-cookie"];
          resolve({ status: res.statusCode, json, cookie: sc ? String(sc[0]).split(";")[0] : null });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  let r = await call("POST", "/api/auth/login", { body: { username: "hr-boss", password: "pw-hr-boss-x7" } });
  const boss = r.cookie;
  ok(!!boss, "平台管理员登得进来", r.status);
  const mem = await call("POST", "/api/admin/members", { cookie: boss, body: { username: "xiaoyuan", role: "member" } });
  const memPwd = (mem.json || {}).password;

  // ---- 发一把 ----
  r = await call("POST", "/api/admin/relay/keys", { cookie: boss, body: { name: "小程序后台", user: "xiaoyuan", budget_yuan: 50 } });
  ok(r.status === 200 && r.json.secret && r.json.secret.startsWith(vkeys.PREFIX),
     "发 Key 的接口当场把明文返回一次（之后再也拿不到，界面上那个弹窗是唯一的机会）", { status: r.status, has: !!(r.json || {}).secret });
  const newKey = r.json.key;

  // 归属写错了必须当场拦住：查不到人 → 个人那一档整个跳过 → 他的月预算成了摆设，
  // 而这件事不报错、不留日志，只在月底的账上体现
  r = await call("POST", "/api/admin/relay/keys", { cookie: boss, body: { name: "写错名字的", user: "xiaoyaun" } });
  ok(r.status >= 400 && /没有/.test((r.json || {}).error || ""), "归属写错一个字母就报错", r.json);
  r = await call("POST", "/api/admin/relay/keys", { cookie: boss, body: { name: "不挂人的", user: "" } });
  ok(r.status === 200, "反向对照：明说不挂人是允许的（不是「必须填」）", r.json);

  // ---- 一趟请求回全部 ----
  bill({ org: org.DEFAULT_ORG, user: "xiaoyuan", vkey: newKey.id, vkey_name: newKey.name, model: "doubao-seed-1-6", cost: 1.25, prompt: 1000, completion: 500 });
  r = await call("GET", "/api/admin/relay", { cookie: boss });
  const d = r.json;
  ok(r.status === 200, "后台那一页拉得出来", r.status);
  // members 不在这一趟里：那张「每个人单独的上限」表是按人头长的，3000 人的组织捎带一次 620 KB，
  // 而这一页上它一屏只看得见十几行。它走 /api/admin/relay/members，一页 50 个
  ok(d.members === undefined, "★这一页不捎带花名册★ 捎带的话，回包会跟着公司人数长");
  for (const k of ["keys", "channels", "orphans", "budget", "levels", "spend", "prices"]) {
    ok(d[k] !== undefined, `一趟就带回了 ${k}`);
  }
  const row = d.keys.find((k) => k.id === newKey.id);
  eq(row.spent_month, 1.25, "这把 Key 本月花了多少，跟账本对得上");
  eq(row.left, 48.75,
     "剩余 = 上限 − 已花，而且是同一个时刻算出来的——拆成几个接口取，这三格必然来自三个时刻，" +
     "而这个关系正是管理员唯一会去核的东西");
  ok(d.keys.every((k) => k.hash === undefined), "这一页上没有任何一把 Key 的哈希");
  eq(d.spend.by_user.find((x) => x.key === "xiaoyuan").yuan, 1.25, "按人那张表也对得上");
  eq(d.orphans, ["孤儿型号"], "登记了却没挂渠道的型号被直说出来——业务方调它只会收到一句「没有可用渠道」");
  ok(d.channels[0].models.includes("doubao-seed-1-6"), "挂对渠道的那个型号归在渠道名下", d.channels[0]);
  ok(d.prefix === vkeys.PREFIX, "前缀也带回去：那一页要照着它拼出「怎么接」的示例");

  // ---- ⑥ 跨组织 ----
  const alien = vkeys.create({ name: "乙公司的", org: "other-co" });
  r = await call("POST", `/api/admin/relay/keys/${alien.key.id}`, { cookie: boss, body: { revoke: true } });
  ok(r.status >= 400, "凭一个 id 动不了别的组织的 Key", r.json);
  ok(vkeys.verify(alien.secret, {}).reason === undefined, "而且那把 Key 真的没被动过", vkeys.verify(alien.secret, {}));
  r = await call("DELETE", `/api/admin/relay/keys/${alien.key.id}`, { cookie: boss });
  ok(r.status >= 400, "删也删不掉", r.json);
  r = await call("POST", `/api/admin/relay/keys/${newKey.id}`, { cookie: boss, body: { revoke: true } });
  ok(r.status === 200, "反向对照：自己组织里的那把吊销得掉", r.json);

  // ---- 价目 ----
  r = await call("POST", "/api/admin/relay/prices", { cookie: boss, body: { model: "__proto__", in: 1, out: 2 } });
  ok(r.status >= 400, "__proto__ 当不了型号名——这张表会被合并到内置价目上面去", r.json);
  ok(({}).in === undefined && Object.prototype.in === undefined, "反向对照：Object 的原型没被污染");
  r = await call("POST", "/api/admin/relay/prices", { cookie: boss, body: { model: "gpt-4o", in: "不是数", out: "也不是" } });
  ok(r.status >= 400, "输入价和输出价至少得填一个真数", r.json);
  r = await call("POST", "/api/admin/relay/prices", { cookie: boss, body: { model: " GPT-4o ", in: 1, out: 2 } });
  ok(r.status === 200 && config.prices && config.prices["gpt-4o"], "反向对照：正常填得进去，而且型号名去了空格、转成小写", Object.keys(config.prices || {}));
  ok(saved > 0, "改完价目真的落盘了（saveConfig 这条线是接上的）", saved);
  eq(r.json.prices.find((p) => p.model === "gpt-4o").src, "admin", "这一行标着「手填」，跟内置的分得开");
  r = await call("POST", "/api/admin/relay/prices", { cookie: boss, body: { model: "gpt-4o", remove: true } });
  ok(r.status === 200 && !config.prices["gpt-4o"], "删得掉，删完回落到内置价", Object.keys(config.prices || {}));

  // ---- 按量那五路的单价：跟 token 价目是**两张表** ----
  // 合成一张的话，一个写错字段名的请求会把「0.14 元/张」当成「0.14 元/百万 token」
  // 写进另一张表，两边都不报错——这种错到月底对账才会被发现。
  r = await call("POST", "/api/admin/relay/unit-prices", { cookie: boss, body: { cap: "vedio", model: "x", price: 1 } });
  ok(r.status >= 400 && /没有/.test((r.json || {}).error || ""), "拼错一路能力的名字当场报错（vedio ≠ video）", r.json);
  r = await call("POST", "/api/admin/relay/unit-prices", { cookie: boss, body: { cap: "image", model: "__proto__", price: 1 } });
  ok(r.status >= 400, "__proto__ 在这张表里同样当不了型号名", r.json);
  ok(({}).price === undefined && Object.prototype.price === undefined, "反向对照：Object 的原型没被污染");
  r = await call("POST", "/api/admin/relay/unit-prices", { cookie: boss, body: { cap: "image", model: "wanx2.1-t2i-turbo", price: "白送" } });
  ok(r.status >= 400 && /非负数/.test((r.json || {}).error || ""), "单价得是个数，而且报错里写着单位是「元 / 张」", r.json);
  const savedBefore = saved;
  r = await call("POST", "/api/admin/relay/unit-prices", { cookie: boss, body: { cap: "image", model: " WanX2.1-T2I-Turbo ", price: 0.1, note: "谈下来的价" } });
  ok(r.status === 200 && ((config.unit_prices || {}).image || {})["wanx2.1-t2i-turbo"],
     "反向对照：正常填得进去，型号名去空格转小写（跟 token 那张表一个规矩）", Object.keys((config.unit_prices || {}).image || {}));
  eq(config.unit_prices.image["wanx2.1-t2i-turbo"], { price: 0.1, note: "谈下来的价" }, "存的是那个数本身（元/张），备注跟着存");
  ok(!(config.prices || {})["wanx2.1-t2i-turbo"], "而且**没有**串进按 token 那张表——两张表单位不一样，串了要到月底才看得出来");
  ok(saved > savedBefore, "改完落盘了", { savedBefore, saved });
  eq(pricing.unitTableFor("image", { config }).table["wanx2.1-t2i-turbo"].price, 0.1,
     "计价那一侧立刻读得到新价——后台改完价，下一趟调用就得按新的算，不能等重启");
  const uimg = (r.json.unit_prices || []).find((g) => g.cap === "image");
  ok(uimg && uimg.unit === "张" && uimg.cn === "生成图片", "回给前端的每一组都带着单位和中文名（前端自己推的话，以后改了计量口径页面会静静地多显示十倍）", uimg && { unit: uimg.unit, cn: uimg.cn });
  eq((uimg.rows.find((x) => x.model === "wanx2.1-t2i-turbo") || {}).src, "admin", "这一行标着「手填」，跟内置价分得开");
  ok(uimg.rows.some((x) => x.model === "dall-e-3" && x.src === "builtin"), "没手填过的还在，标着「内置」", uimg.rows.slice(0, 3));
  r = await call("POST", "/api/admin/relay/unit-prices", { cookie: boss, body: { cap: "image", model: "wanx2.1-t2i-turbo", remove: true } });
  ok(r.status === 200 && !config.unit_prices.image["wanx2.1-t2i-turbo"], "删得掉", config.unit_prices);
  eq(pricing.unitTableFor("image", { config }).table["wanx2.1-t2i-turbo"].price, 0.14, "删完回落到内置的 0.14 元/张");

  // ---- 上限 ----
  r = await call("POST", "/api/admin/relay/budget", { cookie: boss, body: { budget: { org_yuan: 800, default_user_yuan: 60 }, price_discount: 0.85 } });
  eq(r.json.budget.org_yuan, 800, "组织总预算改得了");
  eq(r.json.price_discount, 0.85, "折扣是小数，存进去还是小数（走的是同一条 updateOrg）");
  r = await call("POST", "/api/admin/relay/members/xiaoyuan", { cookie: boss, body: { budget_yuan: 20 } });
  eq(r.json.member.budget_yuan, 20, "单个人的 API 月预算改得了");
  r = await call("GET", "/api/admin/relay/members", { cookie: boss });
  eq(r.json.rows.find((m) => m.username === "xiaoyuan").budget_yuan, 20,
     "改完这一页立刻读得到新数——缓存不扔的话，管理员会以为没生效然后再改一次");
  ok(r.json.capped >= 1, "「几个人设过单独上限」这个数也跟着变了", r.json.capped);

  // ---- 审计员：看得见，改不动 ----
  r = await call("POST", "/api/admin/members", { cookie: boss, body: { username: "kuaiji", role: "auditor" } });
  const auditPwd = r.json.password;
  r = await call("POST", "/api/auth/login", { body: { username: "kuaiji", password: auditPwd } });
  const auditor = r.cookie;
  ok((await call("GET", "/api/admin/relay", { cookie: auditor })).status === 200, "审计员查得了账");
  ok((await call("POST", "/api/admin/relay/keys", { cookie: auditor, body: { name: "偷发一把" } })).status === 403,
     "审计员发不了 Key（那一页也得跟着把按钮整个去掉——审计员看到的按钮不能是点下去必然 403 的按钮）");
  ok((await call("POST", "/api/admin/relay/budget", { cookie: auditor, body: { budget: { org_yuan: 0 } } })).status === 403,
     "审计员也改不了上限");
  ok((await call("POST", "/api/admin/relay/unit-prices", { cookie: auditor, body: { cap: "image", model: "dall-e-3", price: 0 } })).status === 403,
     "按量那张单价表审计员同样改不了——把生图改成 0 元/张，这一页上所有的账当场全变成 0");
  ok(((await call("GET", "/api/admin/relay", { cookie: auditor })).json || {}).prices === undefined,
     "审计员看不到价目表——价目是整台服务器一份的，归平台管理员");

  // ---- 普通成员 / 没登录 ----
  r = await call("POST", "/api/auth/login", { body: { username: "xiaoyuan", password: memPwd } });
  ok((await call("GET", "/api/admin/relay", { cookie: r.cookie })).status === 403, "普通成员看不到中转站这一页");
  ok((await call("GET", "/api/admin/relay", {})).status === 401, "没登录直接 401");

  server.close();

  /* ============================================================
     【8】对外那两条路
     ============================================================ */
  console.log("\n【8】/v1/*：身份是 Authorization 头里的虚拟 Key，不是 cookie");
  const srv2 = express();
  srv2.use(express.json());
  srv2.use(relay.createRouter({
    config: () => config,
    orgSettings: () => ({ budget: { org_yuan: 0 } }),
    user: () => null,
    clientIp: () => "127.0.0.1",
  }));
  const s2 = srv2.listen(0, "127.0.0.1");
  await new Promise((r2) => s2.once("listening", r2));
  const P2 = s2.address().port;
  const hit = (p, headers) => new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: P2, path: p, headers: headers || {} }, (res) => {
      let b = "";
      res.on("data", (x) => (b += x));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    }).on("error", () => resolve({ status: 0, json: null }));
  });

  const svcKey = vkeys.create({ name: "给业务方的", org: org.DEFAULT_ORG });
  let g = await hit("/v1/models", { authorization: "Bearer " + svcKey.secret });
  ok(g.status === 200 && g.json.object === "list", "拿虚拟 Key 列得出型号（OpenAI SDK 开机第一件事就是它）", g.json);
  ok(g.json.data.some((m) => m.id === "doubao-seed-1-6"), "列的是真挂了渠道的那些", g.json.data);
  ok(!g.json.data.some((m) => m.id === "孤儿型号"), "没挂渠道的不列出来——列出来就是一句转得出去的承诺");

  g = await hit("/v1/models", {});
  ok(g.status === 401 && g.json.error && g.json.error.type === "authentication_error",
     "不带 Key 是 401，而且错误是 OpenAI 那个形状（对面是官方 SDK，它按这个形状解）", g.json);
  // 头里不能放非 ASCII，随手编一串合法字符的假 Key
  g = await hit("/v1/models", { authorization: "Bearer " + vkeys.PREFIX + "x".repeat(40) });
  ok(g.status === 401 && /不对/.test(g.json.error.message),
     "瞎编一把也是 401，而且只回一句「这把 Key 不对」——不说「不存在」，免得拿错误信息试出哪把 Key 是真的", g.json);

  const dead = vkeys.create({ name: "已经停用的", org: org.DEFAULT_ORG });
  vkeys.revoke(dead.key.id, "sys");
  g = await hit("/v1/models", { authorization: "Bearer " + dead.secret });
  ok(g.status === 401 && /停用/.test(g.json.error.message),
     "但**真有这把 Key**、只是不让用的时候要说清楚是哪一种：对面已经握着这把 Key 了，这时候含糊其辞只是让他多查两个钟头", g.json);

  const narrow = vkeys.create({ name: "只给便宜的", org: org.DEFAULT_ORG, models: ["doubao-seed-1-6"] });
  g = await hit("/v1/models", { authorization: "Bearer " + narrow.secret });
  eq(g.json.data.map((m) => m.id), ["doubao-seed-1-6"], "限了型号的 Key，列表里也只剩那几个");

  g = await hit("/v1/chat/completions", { authorization: "Bearer " + svcKey.secret });
  ok(g.status === 404 || g.status === 405 || g.status === 400, "聊天那条只收 POST", g.status);

  s2.close();

  /* ============================================================
     【9】不只是对话：生图 / 生视频 / 语音合成 / 转写 / 搜索 / 向量化
     ============================================================

     公司买的 API 不止一种，账也不止一种算法。这一段把每一路都真的跑一遍
     （上游是本地起的假服务，不花钱、不联网），盯的是三件事：

       · **能力白名单**跟型号白名单是两回事。发给外包做文案的那把，该限的不是
         「哪个型号」而是**不准生视频**——视频是最贵的一路，而型号名一个月一变，
         拿型号白名单去拦能力，下个月上游改一个 id 就漏了。
       · **产出要落到我们这边**。上游给的是几分钟后就失效的临时地址，原样转给
         业务方，他明天来取是一个 404，而那一趟已经计过费了。
       · **失败的那一趟一分钱都不能记**，认不出的型号也不能按 0 元记。
     ============================================================ */
  console.log("\n【9】按量那几路：能力白名单、产出落盘、单价、失败不记账");

  const relayFiles = require(path.join(ROOT, "relay-files"));
  const ORG9 = "relay-co";          // 单独一个组织，预算那几格不跟前面几段互相干扰
  // 1×1 的合法 PNG。假上游回它，取回来的字节要跟它一个字节不差
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");

  const up = http.createServer((req2, res2) => {
    const chunks = [];
    req2.on("data", (c) => chunks.push(c));
    req2.on("end", () => {
      if (req2.url === "/v1/images/generations") {
        res2.writeHead(200, { "content-type": "application/json" });
        return res2.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
      }
      if (req2.url === "/v1/audio/speech") {
        res2.writeHead(200, { "content-type": "audio/mpeg" });
        return res2.end(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(900, 0x42)]));
      }
      if (req2.url === "/v1/audio/transcriptions") {
        res2.writeHead(200, { "content-type": "application/json" });
        return res2.end(JSON.stringify({ text: "这是一段转写出来的话。" }));
      }
      if (req2.url === "/v1/embeddings") {
        res2.writeHead(200, { "content-type": "application/json" });
        return res2.end(JSON.stringify({
          object: "list", data: [{ embedding: [0.1, 0.2] }], model: "text-embedding-3-small",
          usage: { prompt_tokens: 12, total_tokens: 12 },
        }));
      }
      res2.writeHead(404, { "content-type": "application/json" });
      res2.end("{}");
    });
  });
  up.listen(0, "127.0.0.1");
  await new Promise((r3) => up.once("listening", r3));
  const UP = `http://127.0.0.1:${up.address().port}/v1`;

  const cfg9 = {
    providers: [{ id: "up", name: "本地假渠道", kind: "openai", base_url: UP, api_key: "sk-relay-test" }],
    models: [{ name: "向量", model: "text-embedding-3-small", channel: "up" }],
    media: {
      // 「不写 model 时用哪个」——后台设置页上那三个默认框
      image: { base_url: UP, api_key: "sk-relay-test", model: "dall-e-3", kind: "openai" },
      tts: { base_url: UP, api_key: "sk-relay-test", model: "tts-1", kind: "openai" },
      asr: { base_url: UP, api_key: "sk-relay-test", model: "whisper-1", kind: "openai" },
      list: [
        { cap: "image", name: "画图", model: "dall-e-3", base_url: UP, api_key: "sk-relay-test", kind: "openai" },
        { cap: "tts", name: "念稿", model: "tts-1", base_url: UP, api_key: "sk-relay-test", kind: "openai" },
        { cap: "asr", name: "转写", model: "whisper-1", base_url: UP, api_key: "sk-relay-test", kind: "openai" },
      ],
    },
    search: { provider: "tavily", tavily_key: "" },   // 配了引擎但**没填 Key**
  };
  let orgSet9 = { budget: { org_yuan: 0 } };          // 0 = 不限

  const srv3 = express();
  srv3.use(express.json({ limit: "20mb" }));
  srv3.use(relay.createRouter({
    config: () => cfg9,
    orgSettings: () => orgSet9,
    user: () => null,
    clientIp: () => "127.0.0.1",
  }));
  const s3 = srv3.listen(0, "127.0.0.1");
  await new Promise((r3) => s3.once("listening", r3));
  const P3 = s3.address().port;

  function api(method, urlPath, { key, body, raw, headers } = {}) {
    const payload = raw !== undefined ? raw : body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve) => {
      const rq = http.request({
        host: "127.0.0.1", port: P3, method, path: urlPath,
        headers: {
          ...(key ? { authorization: "Bearer " + key } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          ...(headers || {}),
        },
      }, (rs) => {
        const chunks = [];
        rs.on("data", (c) => chunks.push(c));
        rs.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString("utf8")); } catch {}
          resolve({ status: rs.statusCode, json, buf, type: rs.headers["content-type"] });
        });
      });
      rq.on("error", (e) => resolve({ status: 0, json: null, buf: Buffer.alloc(0), err: e.message }));
      if (payload) rq.write(payload);
      rq.end();
    });
  }
  const errOf = (x) => String(((x.json || {}).error || {}).message || "");
  /** 上一次问过之后新记了哪几笔账（按时间先后）。空数组 = 这几趟一分钱都没记 */
  let seen9 = usageStore.read({}).filter((x) => x.kind === "relay").length;
  function fresh() {
    const all = usageStore.read({}).filter((x) => x.kind === "relay");   // 读出来是**新的在前**
    const out = all.slice(0, all.length - seen9).reverse();              // 新记的这几笔，翻成按时间先后
    seen9 = all.length;
    return out;
  }

  // ---- ① 能力白名单存进 Key 之前先拍干净 ----
  const kAll = vkeys.create({ name: "全开的", org: ORG9 });
  const kImg = vkeys.create({ name: "只给生图的", org: ORG9, caps: ["image"] });
  const kOther = vkeys.create({ name: "乙公司的", org: "other-co-9" });
  eq(kAll.key.caps, [], "一路都不勾 = 空数组 = 全开");
  eq(vkeys.create({ name: "全勾一遍", org: ORG9, caps: vkeys.CAPS }).key.caps, [],
     "七路全勾也存成空——存成七个名字的话，以后新增一路能力，今天这批「全选」的 Key 会莫名其妙用不了新那一路");
  eq(vkeys.create({ name: "拼错的", org: ORG9, caps: ["image", "vedio"] }).key.caps, ["image"],
     "拼错的那个字直接丢掉，不让它住进 Key 里装成一条限制（vedio 会让这把 Key 看着限住了、实际一路都没限住）");
  eq(vkeys.update(kImg.key.id, { caps: ["image", "tts"] }).caps, ["image", "tts"], "改得了");
  vkeys.update(kImg.key.id, { caps: ["image"] });

  // ---- ② /v1/models：媒体型号也列，而且按能力过滤 ----
  let r9 = await api("GET", "/v1/models", { key: kAll.secret });
  const idsAll = ((r9.json || {}).data || []).map((m) => m.id);
  ok(r9.status === 200 && idsAll.includes("画图") && idsAll.includes("念稿") && idsAll.includes("转写"),
     "生图 / 语音那几个型号也列在 /v1/models 里——不列的话业务方根本无从知道这把 Key 能叫哪些，只能来问人，而这正是中转站要省掉的那一步", idsAll);
  eq((r9.json.data.find((m) => m.id === "画图") || {}).cap, "image", "每一行标着它是哪一路的（多出来的字段官方 SDK 会忽略）");
  ok(idsAll.includes("text-embedding-3-small"), "挂了渠道的文本型号照列", idsAll);
  r9 = await api("GET", "/v1/models", { key: kImg.secret });
  const idsImg = ((r9.json || {}).data || []).map((m) => m.id);
  eq(idsImg, ["画图"],
     "反向对照：只开生图的那把，列表里只剩生图——列出来的每一个 id 都是一句「你可以叫它」的承诺，叫过去却是 401 的话，对面会去查自己的代码");

  // ---- ③ 生图：默认回 base64 ----
  r9 = await api("POST", "/v1/images/generations", { key: kAll.secret, body: { model: "画图", prompt: "一只在打字的猫", n: 2 } });
  ok(r9.status === 200 && ((r9.json || {}).data || []).length === 2, "要两张就出两张", { s: r9.status, j: r9.json });
  ok(r9.json.data.every((d) => d.b64_json && !d.url),
     "默认回 base64 不回 url——我们的 url 要带 Key 才取得到，默认给 url 等于递给人一条在浏览器里打不开的链接");
  let row9 = fresh().pop();
  eq([row9.cap, row9.units, row9.unit], ["image", 2, "张"], "账上按张记，单位跟着一起写下来", row9);
  eq([row9.prompt, row9.completion], [0, 0], "token 那几格照样写 0 而不是缺字段——后台那张表是按列汇总的，缺字段会让排序在某些行上拿到 undefined");
  ok(!row9.cost_unknown && row9.cost > 0, "dall-e-3 有内置单价，这一笔算得出钱", row9);
  eq(row9.org, ORG9, "账挂在这把 Key 的组织名下");

  // ---- ④ 明写要 url：产出落到我们这边，凭 Key 取 ----
  r9 = await api("POST", "/v1/images/generations", { key: kAll.secret, body: { model: "画图", prompt: "一只猫", response_format: "url" } });
  const f9 = ((r9.json || {}).data || [])[0] || {};
  ok(f9.id && f9.url === `/v1/files/${f9.id}/content` && f9.expires_at,
     "给的是**相对**地址：中转站常常挂在 nginx / 内网域名后面，在这儿拼一个绝对地址十有八九是错的", f9);
  fresh();
  let g9 = await api("GET", f9.url, { key: kAll.secret });
  ok(g9.status === 200 && g9.buf.equals(PNG), "取回来的字节跟上游给的一模一样", { s: g9.status, n: g9.buf.length });
  eq(g9.type, "image/png", "content-type 按扩展名给对（给错的话浏览器把 PNG 当文本渲染）");
  g9 = await api("GET", "/v1/files/" + f9.id, { key: kAll.secret });
  ok(g9.status === 200 && g9.json.bytes === PNG.length && g9.json.cap === "image", "文件信息那条也在", g9.json);
  g9 = await api("GET", f9.url, { key: kOther.secret });
  ok(g9.status === 404 && !/不给你|无权/.test(errOf(g9)),
     "别家公司的 Key 拿着这个 id 取不到，而且回的是 404 不是 403——说「这个文件存在，只是不给你」等于替人确认了一个 id 是真的", g9.json);
  g9 = await api("GET", f9.url, {});
  ok(g9.status === 401, "不带 Key 更取不到。这不是「链接猜不到就算安全」：一条不设防的链接只要出现在一次日志、一个截图里，就永久地公开了", g9.json);
  g9 = await api("GET", "/v1/files/" + "0".repeat(32) + "/content", { key: kAll.secret });
  ok(g9.status === 404, "编一个 id 也只是 404", g9.json);
  g9 = await api("GET", "/v1/files/..%2F..%2Fetc%2Fpasswd", { key: kAll.secret });
  ok(g9.status === 404, "id 只认 32 位十六进制，`..` 这种东西根本进不到路径拼接那一步", g9.status);
  eq(fresh().length, 0, "取文件不是一次 API 调用，不记账也不扣钱");

  // ---- ⑤ 过期就删，删了就是删了 ----
  const old9 = relayFiles.save(Buffer.from("昨天的东西"), { name: "old.txt", org: ORG9, now: Date.now() - relayFiles.TTL_MS - 60000 });
  const gotOld = relayFiles.get(old9.id, { org: ORG9 });
  ok(gotOld.err && gotOld.status === 404 && /过期/.test(gotOld.err), "过了 24 小时就取不到了，而且明说是过期不是不存在", gotOld.err);
  ok(!fs.existsSync(path.join(relayFiles.DIR, old9.id + ".bin")) && !fs.existsSync(path.join(relayFiles.DIR, old9.id + ".json")),
     "而且当场从盘上删干净——中转站不是网盘，留着不删的结局是磁盘满了之后连账都写不进去，那时候丢的是**账**");
  ok(relayFiles.list({ org: ORG9 }).every((m) => m.id !== old9.id), "后台那张表里也不列它");
  ok(relayFiles.list({ org: ORG9 }).some((m) => m.id === f9.id), "反向对照：没过期的那份还在", relayFiles.list({ org: ORG9 }).length);
  eq(relayFiles.list({ org: "other-co-9" }).length, 0, "而且别家公司的那张表里一份都看不见");

  // ---- ⑥ 语音合成：回裸音频，不是 JSON ----
  r9 = await api("POST", "/v1/audio/speech", { key: kAll.secret, body: { model: "念稿", input: "念一句话给我听" } });
  ok(r9.status === 200 && /^audio\//.test(String(r9.type || "")),
     "回的是裸音频字节，不是 JSON——官方 SDK 的 audio.speech.create() 按这个来解，回一个 JSON 会让它当场炸", { s: r9.status, t: r9.type, body: r9.buf.slice(0, 80).toString("utf8") });
  ok(r9.buf.length > 200, "而且是真的音频体积", r9.buf.length);
  row9 = fresh().pop();
  eq([row9.cap, row9.unit], ["tts", "千字符"], "账上是语音合成这一路，按千字符计量", row9);
  ok(row9.units > 0 && row9.units < 0.01, "7 个字算 0.007 千字符，不是 7——单位错一个数量级，月底那张账单就是三位数的误差", row9.units);

  // ---- ⑦ 语音转写：整个仓库唯一一条 multipart ----
  const B9 = "----owbrelaytest";
  const mp9 = Buffer.concat([
    Buffer.from(`--${B9}\r\nContent-Disposition: form-data; name="model"\r\n\r\n转写\r\n`),
    Buffer.from(`--${B9}\r\nContent-Disposition: form-data; name="file"; filename="会议录音.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
    Buffer.alloc(32000, 0x41),
    Buffer.from(`\r\n--${B9}--\r\n`),
  ]);
  r9 = await api("POST", "/v1/audio/transcriptions", {
    key: kAll.secret, raw: mp9,
    headers: { "content-type": `multipart/form-data; boundary=${B9}`, "content-length": mp9.length },
  });
  ok(r9.status === 200 && /转写出来的话/.test(String((r9.json || {}).text || "")),
     "multipart 那一包解得开（用的是 Node 自带的那个解析器，没为这一条接口装一个库）", r9.json);
  row9 = fresh().pop();
  eq([row9.cap, row9.unit], ["asr", "分钟"], "账上是转写这一路，按分钟计量", row9);
  eq(row9.units, 0.1, "不足 6 秒的按 6 秒算（有个下限）——一堆一秒钟的片段全按 0 分钟计费的话，这一路的账会慢慢地漏成零");
  const mpBig = Buffer.concat([
    Buffer.from(`--${B9}\r\nContent-Disposition: form-data; name="model"\r\n\r\n转写\r\n`),
    Buffer.from(`--${B9}\r\nContent-Disposition: form-data; name="file"; filename="长一点的.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
    Buffer.alloc(192000, 0x41),
    Buffer.from(`\r\n--${B9}--\r\n`),
  ]);
  r9 = await api("POST", "/v1/audio/transcriptions", {
    key: kAll.secret, raw: mpBig,
    headers: { "content-type": `multipart/form-data; boundary=${B9}`, "content-length": mpBig.length },
  });
  row9 = fresh().pop();
  eq(row9.units, 0.2,
     "反向对照：换一个 6 倍大的文件，分钟数跟着变（192KB ÷ 16KB/s ÷ 60 = 0.2 分钟）——不是一个写死的常数");
  r9 = await api("POST", "/v1/audio/transcriptions", {
    key: kAll.secret, raw: Buffer.from("这根本不是一包 multipart"),
    headers: { "content-type": `multipart/form-data; boundary=${B9}` },
  });
  ok(r9.status === 400 && /multipart/.test(errOf(r9)), "包坏了直说是包坏了，不是一个 500", r9.json);
  eq(fresh().length, 0, "反向对照：这一趟没记账——请求根本没出门");

  // ---- ⑧ 向量化：这一路按 token 记，不按次 ----
  r9 = await api("POST", "/v1/embeddings", { key: kAll.secret, body: { model: "text-embedding-3-small", input: "你好" } });
  ok(r9.status === 200 && ((r9.json || {}).data || []).length === 1, "向量化转得出去", r9.json);
  row9 = fresh().pop();
  eq([row9.cap, row9.prompt, row9.units], ["embedding", 12, undefined],
     "它跟生图不是一回事：记的是 token 数，没有「几次」这个量", row9);
  ok(!row9.cost_unknown && row9.cost > 0,
     "而且认得出价——三条 OpenAI 向量价是补进内置表的，不补的话这一路每一笔都记成「不知道多少钱」", row9);

  // ---- ⑨ 联网搜索：不偷偷退回免费引擎 ----
  r9 = await api("POST", "/v1/search", { key: kAll.secret, body: { query: "今天天气" } });
  ok(r9.status === 503 && /还没配 Key/.test(errOf(r9)),
     "没配 Key 就明说，不退回 DuckDuckGo——业务方按次付了钱，拿到的必须是他买的那家的结果；悄悄换一家他的程序不会报错，只会在某一天发现质量莫名其妙变差了", r9.json);
  r9 = await api("POST", "/v1/search", { key: kAll.secret, body: { query: "今天天气", provider: "谷歌" } });
  ok(r9.status === 400 && /能用的是/.test(errOf(r9)), "引擎名写错了，把能用的几家列出来", r9.json);
  r9 = await api("POST", "/v1/search", { key: kAll.secret, body: {} });
  ok(r9.status === 400 && /query/.test(errOf(r9)), "没写 query 也是当场 400", r9.json);
  eq(fresh().length, 0, "三趟都没记账");

  // ---- ⑩ 能力白名单真的拦得住，而且跟型号白名单不是一回事 ----
  r9 = await api("POST", "/v1/audio/speech", { key: kImg.secret, body: { model: "念稿", input: "念一句" } });
  ok(r9.status === 401 && /没开「语音合成」/.test(errOf(r9)),
     "只开生图的 Key 调语音，当场拦住，而且说清楚它开了哪几路——对面已经握着这把 Key 了，含糊其辞只是让他多查两个钟头", r9.json);
  r9 = await api("POST", "/v1/videos/generations", { key: kImg.secret, body: { prompt: "一段片子" } });
  ok(r9.status === 401 && /没开「生视频」/.test(errOf(r9)),
     "生视频同样拦住。视频是最贵的一路，发给外包那把该限的正是它，而型号名一个月一变，拿型号白名单去拦能力，下个月上游改一个 id 就漏了", r9.json);
  r9 = await api("POST", "/v1/images/generations", { key: kImg.secret, body: { model: "画图", prompt: "猫" } });
  ok(r9.status === 200, "反向对照：它自己那一路照走不误", { s: r9.status, e: errOf(r9) });
  fresh();
  const kNarrow9 = vkeys.create({ name: "只开了一个文本型号", org: ORG9, models: ["text-embedding-3-small"] });
  r9 = await api("POST", "/v1/images/generations", { key: kNarrow9.secret, body: { prompt: "猫" } });
  ok(r9.status === 401 && /不能用/.test(errOf(r9)),
     "不写 model 就想用上后台配的默认生图模型——白名单要核的是**实际会用的那个**，不核这一句的话白名单看着限住了、实际没限住", r9.json);
  eq(fresh().length, 0, "拦下来的没记账");

  // ---- ⑪ 没配的那一路：明说，而且一分钱不记 ----
  r9 = await api("POST", "/v1/videos/generations", { key: kAll.secret, body: { model: "不存在的型号", prompt: "一段片子" } });
  ok(r9.status === 503 && /没有叫/.test(errOf(r9)), "叫一个没配的生视频型号，明说没有并把能用的列出来", r9.json);
  eq(fresh().length, 0, "反向对照：失败的那一趟一分钱都不记，预扣也退回去了");

  // ---- ⑫ 单价：认不出 ≠ 0 元；后台填上之后下一趟就按新价算 ----
  cfg9.media.list.push({ cap: "image", name: "自研画图", model: "our-diffusion-v1", base_url: UP, api_key: "sk-relay-test", kind: "openai" });
  r9 = await api("POST", "/v1/images/generations", { key: kAll.secret, body: { model: "自研画图", prompt: "猫" } });
  row9 = fresh().pop();
  ok(r9.status === 200 && row9.cost_unknown === true && row9.cost === 0,
     "内置表里没有的型号记成「不知道多少钱」，不是记成 0 元——记 0 的账面永远对、跟真实账单永远对不上，而且一个字都不报", row9);
  cfg9.unit_prices = { image: { "our-diffusion-v1": { price: 0.3 } } };
  r9 = await api("POST", "/v1/images/generations", { key: kAll.secret, body: { model: "自研画图", prompt: "猫" } });
  row9 = fresh().pop();
  ok(!row9.cost_unknown && row9.cost === 0.3,
     "后台把这一路的单价填上之后，下一趟当场按新价算（0.3 元/张，不经过按 token 那张表）", row9);

  // ---- ⑬ 钱闸：按量那几路也在同一道闸子下面 ----
  orgSet9 = { budget: { org_yuan: 0.001 } };
  r9 = await api("POST", "/v1/images/generations", { key: kAll.secret, body: { model: "自研画图", prompt: "猫" } });
  ok(r9.status === 402 && ((r9.json || {}).error || {}).code === "insufficient_quota",
     "预算到顶了，生图这一路一样拦得住——不是只有对话那条路在过闸", r9.json);
  eq(fresh().length, 0, "拦下来的这趟没记账，也没往上游发一个字节");
  orgSet9 = { budget: { org_yuan: 0 } };
  r9 = await api("POST", "/v1/images/generations", { key: kAll.secret, body: { model: "自研画图", prompt: "猫" } });
  ok(r9.status === 200, "反向对照：0 = 不限，不是「一分钱都不剩」", { s: r9.status, e: errOf(r9) });
  fresh();
  const st9 = budget.status({ orgId: ORG9, org: orgSet9 }).find((x) => x.level === "org");
  eq(st9.reserved, 0, "跑完这一整串，没有一笔预扣挂在那儿——每一趟不是结算了就是退回了");
  ok(st9.spent > 0.3, "而且已用额度是真累加的", st9);

  s3.close();
  up.close();

  /* ============================================================
     【10】公司内部自己用的那一份，走的是同一笔预算
     ============================================================

     中转站发出去的 Key 开头就在 budget 下面过；员工在界面上点的、定时任务跑的
     以前**不过**——同一笔预算漏了一半，而漏的那一半恰好是能一直点「重试」的那一半。
     ============================================================ */
  console.log("\n【10】公司内部的调用：同一笔预算、同一个上限，防的是自己人无意的滥用");

  // ---- ① record 补进内存账之后，闸子当场看得见 ----
  const ctxA = { orgId: "gate-co", user: { username: "someone" }, org: { budget: { org_yuan: 2 } } };
  ok(budget.exhausted(ctxA) === null, "一开始没到顶，不拦");
  budget.record({ orgId: "gate-co", user: "someone", yuan: 1.5 });
  ok(budget.exhausted(ctxA) === null, "花了 1.5，离 2 还有距离，照样不拦");
  budget.record({ orgId: "gate-co", user: "someone", yuan: 0.6 });
  const hitA = budget.exhausted(ctxA);
  ok(hitA && hitA.level === "org" && /上限 2\.00 元/.test(hitA.message) && /已用 2\.10 元/.test(hitA.message),
     "超过 2 就拦住，而且一句话说清是哪一档、上限多少、已用多少——管理员看到「额度用完了」第一个问题就是这三个", hitA && hitA.message);
  ok(budget.exhausted({ ...ctxA, org: { budget: { org_yuan: 0 } } }) === null,
     "反向对照：同样花了 2.1，上限写 0 就一点不拦（0 的语义是「不限」，判空判错的话整个组织的调用当场全挂）");
  ok(budget.exhausted({ orgId: "gate-co", user: { username: "别人" }, org: { budget: { default_user_yuan: 1 } } }) === null,
     "反向对照：换个人来问，他自己那一档还是空的——已用额度是按人分开算的，不是一锅粥");

  // ---- ② 只落盘不补内存账的话，闸子看不见——这就是 record 存在的理由 ----
  const ctxB = { orgId: "blind-co", user: { username: "someone" }, org: { budget: { org_yuan: 2 } } };
  ok(budget.exhausted(ctxB) === null, "先问一次，把这个组织这个月的账扫进缓存");
  usageStore.append({
    ts: new Date().toISOString(), day: MK + "-15", kind: "run", source: "web",
    calls: 1, prompt: 0, cached: 0, completion: 0, org: "blind-co", user: "someone",
    model: "gpt-4o", cost: 5,
  });
  ok(budget.exhausted(ctxB) === null,
     "只往盘上写、不补内存账，闸子还是看不见这 5 块钱——spentOf 每个月每个范围只扫一遍流水，之后就吃缓存。" +
     "这就是 budget.record 存在的理由，不是多此一举");
  budget.record({ orgId: "blind-co", user: "someone", yuan: 5 });
  ok(budget.exhausted(ctxB) !== null, "补上那一句之后当场拦得住");
  budget.invalidate();
  ok(budget.exhausted(ctxB) !== null, "扔掉缓存重扫流水，答案还是拦——两条路算出来的是同一个数，不会互相打架", budget.exhausted(ctxB));

  // ---- ③ 员工在界面上跑完一次任务，这笔钱真的进了闸子的账 ----
  const ctxC = { orgId: org.DEFAULT_ORG, user: { username: "xiaoyuan" }, org: { budget: { org_yuan: 10 } } };
  budget.invalidate();
  const beforeC = budget.exhausted(ctxC);
  account.chargeRun({ username: "xiaoyuan" }, { model: "gpt-4o", prompt: 200000, cached: 0, completion: 200000 });
  const afterC = budget.exhausted(ctxC);
  ok(!beforeC && afterC, "chargeRun → budget.record 这条线是接上的：界面上跑完一次贵任务，下一次点发送就被拦住了", { beforeC, afterC: afterC && afterC.message });

  // ---- ④ server.js 里那两处闸门：切真源码出来跑，不抄一份 ----
  // 抄一份的坏处：源码改了、抄的这份没改，测试照样绿。
  const SRC9 = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  function blockAround(src, anchor, head) {
    const at = src.indexOf(anchor);
    if (at < 0) return null;
    const start = src.lastIndexOf(head, at);
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
    }
    return null;
  }
  const orgStub = { getOrg: () => ({ id: "default" }), orgIdOf: () => "default", settingsOf: () => ({}) };

  const chatGate = blockAround(SRC9, "const hit = budget.exhausted({ org: org.settingsOf(o), orgId: o.id, user });", "if (user) {");
  ok(chatGate && /402/.test(chatGate), "server.js 的 /api/chat 里真有这道闸", chatGate && chatGate.slice(0, 60));
  function runChatGate(ex) {
    let out = null;
    const res = { status: (s) => ({ json: (j) => { out = { status: s, ...j }; return out; } }) };
    new Function("user", "org", "budget", "res", chatGate)(
      { username: "a" }, orgStub, { exhausted: typeof ex === "function" ? ex : () => ex }, res);
    return out;
  }
  let gotG = runChatGate({ message: "组织总预算：上限 100 元，已用 100 元。" });
  ok(gotG && gotG.status === 402 && /已用 100 元/.test(gotG.error) && /API 中转站/.test(gotG.error),
     "钱到顶了，界面上的对话当场 402，而且原话带上「去哪儿加」——只说「额度用完了」的话，用户下一步只能来问人", gotG);
  ok(runChatGate(null) === null, "反向对照：没到顶的时候这段一个字都不做");
  ok(runChatGate(() => { throw new Error("价目表读坏了"); }) === null,
     "反向对照：预算模块自己坏了不拦正事——放行，但在日志里喊一声。一道判不出来的闸子不该把整个产品堵死");

  const runGate = blockAround(SRC9, "const hit = budget.exhausted({ org: org.settingsOf(o), orgId: o.id, user: owner });", "if (owner) {");
  ok(runGate && /throw/.test(runGate), "定时任务 / IM 那条路上也有一道", runGate && runGate.slice(0, 60));
  function runTaskGate(ex) {
    try {
      new Function("owner", "org", "budget", runGate)(
        { username: "a" }, orgStub, { exhausted: typeof ex === "function" ? ex : () => ex });
      return null;
    } catch (e) { return e; }
  }
  const e1 = runTaskGate({ message: "这个人本月的 API 预算：上限 60 元，已用 60 元。" });
  ok(e1 && e1.budget && /已用 60 元/.test(e1.message),
     "定时任务那条路比界面更需要它：界面上是人在点，花得快了自己能看见；一个写错的 cron 是每分钟跑一轮，没人看着，直到月底出账单", e1 && e1.message);
  ok(runTaskGate(null) === null, "反向对照：没到顶就不抛");
  ok(runTaskGate(() => { throw new Error("组织设置里塞了个怪值"); }) === null,
     "反向对照：判不出来的时候放行，而且**只**放行判不出来那一种——真拦下来的那一句得原样往上抛，不能被同一个 catch 吞掉");

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n❌ 跑挂了：", (e && e.stack) || e);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
