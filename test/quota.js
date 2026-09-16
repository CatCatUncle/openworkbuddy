"use strict";
/**
 * 付费 API 额度闸门 —— 「搜一次、生一张图、转一段音频」这几路按次收费的接口。
 *
 *   node test/quota.js
 *
 * 这套东西坏掉的时候，坏法有两种，方向正好相反，但都是钱的事：
 *
 *   A. **该拦的没拦**。额度写了 50 次/天，实际不生效，月底账单出来才发现某个人
 *      一天搜了八千次。这种错在开发环境永远复现不出来——本机跑两下都在额度内。
 *   B. **不该拦的拦了**。上限填 0 本来表示「这一档不限」，判空判错就变成「一次都不剩」，
 *      于是整个组织的搜索当场全挂，而且报错信息还写着「额度用完了」，
 *      管理员去后台一看额度是 0，以为自己填错了，改成 1000 —— 问题依旧。
 *      这条是真踩过的坑（`q.org_monthly && q.org_monthly - u.month` 求出数字 0）。
 *
 * 所以下面每条正向断言后面都跟一个反向对照。盯六件事：
 *
 *   1. 三道闸（每人每天 / 全组织每天 / 全组织每月）各自独立，撞上任何一道就拦。
 *   2. 0 = 不限，不是 = 一次都不剩。left 也得跟着是 Infinity 而不是 0。
 *   3. 没有请求上下文（命令行、桌面端、定时任务）时一律放行——
 *      单机用户不该因为这套多租户的东西被拦住。
 *   4. 组织之间互不干扰：A 组织把额度用光，B 组织照常跑。
 *   5. 闸门关着的时候**照样记流水**。管理员得先看见花了多少，才谈得上设多少。
 *   6. 归档口径按**本地日期**，跟 account.js 的计费对得上；跨月时不把上个月的算进来。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// 账本必须另起一份：不隔离的话这套测试会往用户真正的 data/api-usage.json 里灌假流水
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-quota-"));
process.env.WB_DATA_DIR = HOME;

const quota = require("../quota");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}
function reset() {
  try { fs.rmSync(quota._internals.USAGE_FILE, { force: true }); } catch {}
}
/** 造一张只开了 cap 这一路的额度表 */
function table(cap, limits) {
  return quota.quotaTable({ api_quota: { [cap]: { enabled: true, ...limits } } });
}
function actor(org, user, quotaTable) {
  return { org, user, quota: quotaTable };
}
/** 在某个身份下连着调 n 次并记账，返回最后一次的 check 结果 */
function burn(a, cap, n) {
  let last = null;
  quota.withActor(a, () => {
    for (let i = 0; i < n; i++) {
      last = quota.check(cap);
      if (last.ok) quota.record(cap, { provider: "t" });
    }
  });
  return last;
}

console.log("\n【1】三道闸各自独立");
{
  reset();
  const t = table("search", { user_daily: 3 });
  const a = actor("o1", "小明", t);
  burn(a, "search", 3);
  const g = quota.withActor(a, () => quota.check("search"));
  ok(!g.ok, "每人每天 3 次，第 4 次被拦下");
  ok(/额度用完/.test(g.why), "拦下来时给的是一句人话，不是错误码", g.why);
  ok(/管理员/.test(g.why), "并且告诉用户去找谁调额度", g.why);
  // 反向对照：换个人，同一个组织，额度是各人各算的
  const g2 = quota.withActor(actor("o1", "小红", t), () => quota.check("search"));
  ok(g2.ok, "反向对照：同组织换个人，每人每天那道闸重新算");
}
{
  reset();
  const t = table("search", { org_daily: 4 });
  burn(actor("o1", "小明", t), "search", 3);
  const g = quota.withActor(actor("o1", "小红", t), () => quota.check("search"));
  ok(g.ok && g.left === 1, "全组织每天那道闸是所有人合着算的（用了 3，还剩 1）", g);
  burn(actor("o1", "小红", t), "search", 1);
  ok(!quota.withActor(actor("o1", "小刚", t), () => quota.check("search")).ok,
    "撞满之后第三个人也进不来");
}

console.log("\n【2】上限 0 = 不限，不是一次都不剩");
{
  reset();
  const t = table("search", { user_daily: 0, org_daily: 0, org_monthly: 0 });
  const g = quota.withActor(actor("o1", "小明", t), () => quota.check("search"));
  ok(g.ok, "三档全填 0，照样放行");
  ok(g.left === Infinity, "还剩多少 = Infinity，而不是 0（这条曾经真的返回 0）", g.left);
  // 反向对照：只要有一档是正数，left 就该是那一档算出来的数
  const t2 = table("search", { user_daily: 0, org_daily: 10, org_monthly: 0 });
  const g2 = quota.withActor(actor("o1", "小明", t2), () => quota.check("search"));
  ok(g2.left === 10, "反向对照：有一档填了 10，left 就是 10", g2.left);
}
{
  reset();
  // 三档都设了的时候，取最紧的那一道
  const t = table("search", { user_daily: 5, org_daily: 100, org_monthly: 1000 });
  const g = quota.withActor(actor("o1", "小明", t), () => quota.check("search"));
  ok(g.left === 5, "三档都设了，还剩多少取最紧的那一道", g.left);
}

console.log("\n【3】没有请求上下文时一律放行");
{
  reset();
  const g = quota.check("search"); // 完全不进 withActor：命令行 / 桌面端 / 定时任务就是这样
  ok(g.ok, "没有 actor 时不拦（单机用户不该被多租户的闸门挡住）");
  ok(g.left === Infinity, "并且不报一个假的剩余量", g.left);
  quota.record("search", { provider: "t" });
  const db = quota._internals.load();
  ok(db.usage.length === 1, "但流水照记——管理员总得看得见花了多少", db.usage.length);
  // 记在默认组织名下、用户留空，是对的：单机装的时候「默认组织」就是真实归属，
  // 留空反而会让这笔钱从管理员的汇总里消失。用户名才是真不知道，那就别瞎安一个
  ok(db.usage[0].org === "default", "无上下文的流水记在默认组织名下（单机装的真实归属）", db.usage[0]);
  ok(db.usage[0].user === "", "但不瞎安一个用户名", db.usage[0]);
  const sum = quota.summary("default", quota.quotaTable({}));
  ok(sum.caps.find((c) => c.key === "search").today === 1,
    "反向对照：管理员在默认组织的汇总里看得见这一笔（留空的话这笔钱就凭空消失了）");
}

console.log("\n【4】组织之间互不干扰");
{
  reset();
  const t = table("search", { org_daily: 2 });
  burn(actor("A", "甲", t), "search", 2);
  ok(!quota.withActor(actor("A", "乙", t), () => quota.check("search")).ok, "A 组织用光了");
  ok(quota.withActor(actor("B", "甲", t), () => quota.check("search")).ok,
    "反向对照：B 组织照常跑（同名用户也不串）");
}

console.log("\n【5】闸门关着照样记流水");
{
  reset();
  const off = quota.quotaTable({}); // 什么都没配 = 全部不限
  ok(off.search.enabled === false, "默认这一路是关着的", off.search);
  const a = actor("o1", "小明", off);
  quota.withActor(a, () => {
    for (let i = 0; i < 50; i++) { ok_silent(quota.check("search").ok); quota.record("search", { provider: "jina" }); }
  });
  const db = quota._internals.load();
  ok(db.usage.length === 50, "关着的时候 50 次全放行，50 笔全记下", db.usage.length);
  const sum = quota.summary("o1", off);
  const s = sum.caps.find((c) => c.key === "search");
  ok(s.today === 50, "汇总看得见今天 50 次", s.today);
  eq(s.providers, [{ name: "jina", n: 50 }], "并且分得清走的是哪家服务商");
  eq(s.top, [{ user: "小明", n: 50 }], "也分得清是谁用的");
}

console.log("\n【6】归档口径：跨月不把上个月算进来");
{
  reset();
  const t = table("search", { org_monthly: 5 });
  const db = quota._internals.emptyDb();
  const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lm = quota._internals.localMonth(lastMonth);
  // 上个月刷满 5 次
  for (let i = 0; i < 5; i++) db.usage.push({ ts: lastMonth.getTime(), day: lm + "-15", month: lm, cap: "search", n: 1, org: "o1", user: "小明" });
  quota._internals.save(db);
  const g = quota.withActor(actor("o1", "小明", t), () => quota.check("search"));
  ok(g.ok, "上个月用满了，这个月照样能跑");
  ok(g.left === 5, "这个月的余额是满的", g.left);
  // 反向对照：把那 5 笔挪到本月，就该拦住
  const db2 = quota._internals.load();
  const thisMonth = quota._internals.localMonth(new Date());
  db2.usage = db2.usage.map((r) => ({ ...r, ts: Date.now(), day: quota._internals.localDay(new Date()), month: thisMonth }));
  quota._internals.save(db2);
  ok(!quota.withActor(actor("o1", "小明", t), () => quota.check("search")).ok,
    "反向对照：同样 5 笔挪到本月，当场拦住");
}

console.log("\n【7】配置清洗：脏值进不来");
{
  const t = quota.normalizeTable({ search: { enabled: "yes", user_daily: -5, org_daily: 3.7, org_monthly: "100" }, 不存在的一路: { enabled: true } });
  ok(t.search.enabled === true, "字符串 'yes' 当真", t.search);
  ok(t.search.user_daily === 0, "负数按 0（= 不限）处理，不许出现负额度", t.search);
  ok(t.search.org_daily === 3, "小数向下取整", t.search);
  ok(t.search.org_monthly === 100, "数字字符串转成数字", t.search);
  ok(!("不存在的一路" in t), "清单里没有的那一路直接丢掉，不落盘");
  const sug = quota.suggested();
  ok(quota.CAP_KEYS.every((k) => sug[k] && sug[k].enabled && sug[k].org_monthly > 0),
    "「一键设个合理额度」每一路都给了正数且是打开的");
}

console.log("\n【8】流水有上限，不会把磁盘吃光");
{
  reset();
  const db = quota._internals.emptyDb();
  for (let i = 0; i < quota._internals.USAGE_CAP + 500; i++) db.usage.push({ ts: Date.now(), day: "2026-01-01", month: "2026-01", cap: "search", n: 1, org: "o1", user: "x" });
  quota._internals.save(db);
  const back = quota._internals.load();
  ok(back.usage.length <= quota._internals.USAGE_CAP, `落盘时截到 ${quota._internals.USAGE_CAP} 条以内`, back.usage.length);
}

function ok_silent(cond) { if (!cond) { fail++; console.log("  ✗ 关着闸门的时候居然拦了一次"); } }

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
