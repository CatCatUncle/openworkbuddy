"use strict";
/**
 * 入职 / 离职 + 排期归属。
 *
 * 跑法：node test/lifecycle.js
 * 用临时 OPENWORKBUDDY_DATA_DIR 和临时排期表，绝不碰真账号、真任务。
 *
 * 这两件事放一个套件里，因为它们是同一个洞的两半：
 *
 *   排期表以前**一条归属都不记**。任何一个登录进来的人都能列出全公司的定时任务
 *   （任务描述本身就是商业内容：「把本月华东区回款拉出来发给张总」），能改能删，
 *   还能按「立即运行」——烧的是公司的额度，结果推到的是原主人的通知渠道。
 *   而「停用账号」这个动作从来只删登录令牌，定时任务走的是调度器、不过登录闸，
 *   人走了照跑。两件事合起来才是完整的：**先让排期认人，离职才有东西可关**。
 *
 * 所以这个套件盯的不是「函数返回了对象」，是那几条一破就出事的线：
 *   1. 别人的排期：看不见、取不到、改不动、删不掉、开不了关——五个动作逐个反着验
 *   2. 管理员也只到本组织为止；外组织管理员跟陌生人一样
 *   3. 升级上来的老任务（没有 user 字段）不能凭空判给谁，否则一升级全员任务消失
 *   4. 办离职必须把六道口子一次关完（令牌 / 扫码设备 / 排期 / 邀请码 / 二次验证 / 在跑的任务）
 *   5. 该留的一样不能删：用量、会话、文件、审计——人走了账还得能对
 *   6. 三道安全联锁：办不了自己、办不掉超管（先转让）、办不掉唯一还在职的管理员
 * 每条后面都跟一个反向对照：把该拒的换成该放的，必须放行——不然测的就不是它。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-lifecycle-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const express = require("express");
const account = require(path.join(ROOT, "account"));
const org = require(path.join(ROOT, "org"));
const admin = require(path.join(ROOT, "admin"));
const scheduler = require(path.join(ROOT, "scheduler"));
const lifecycle = require(path.join(ROOT, "lifecycle"));
const totp = require(path.join(ROOT, "totp"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });
/** 断这一句必须抛错，并且抛的是我们想要的那个错——不指明错因的话，任何一个拼写错误都能让它「通过」 */
const throws = (fn, needle, msg) => {
  try { fn(); ok(false, msg, "没抛错"); }
  catch (e) { ok(String(e.message).includes(needle), msg, { got: e.message, want: needle }); }
};

let seq = 0;
/** 起一张临时排期表。seed 可以预置 { tasks, runs }，省得为了造运行记录真跑一次模型 */
function newSched(seed) {
  const file = path.join(TMP, `schedules-${++seq}.json`);
  if (seed) fs.writeFileSync(file, JSON.stringify(seed));
  return scheduler.createScheduler({ storePath: file, runtime: {}, onResult: () => {} });
}
const V = (username, isAdmin = false, orgId = "") => ({ username, admin: isAdmin, org: orgId });

// ==========================================================================
console.log("\n【1】排期归属：别人的任务，五个动作逐个反着验");
// ==========================================================================
{
  const s = newSched();
  const mine = s.add({ name: "回款周报", cron: "0 8 * * 1", task: "拉上月回款发给张总", user: "xiaozhang", org: "default" });
  const his  = s.add({ name: "库存盘点", cron: "0 9 * * *", task: "盘一下仓库", user: "xiaoli", org: "default" });
  const old  = s.add({ name: "老任务", cron: "0 7 * * *", task: "升级前就有的" }); // 没 user

  eq(mine.user, "xiaozhang", "add 把归属落进了任务本体");
  eq(mine.org, "default", "组织也一起记下了");
  eq(old.user, "", "没传归属就是空——单机个人版一切照旧");

  const zhang = V("xiaozhang"), li = V("xiaoli");

  // —— 看得见什么
  const zList = s.list(zhang).map((t) => t.id);
  ok(zList.includes(mine.id), "本人看得见自己的排期");
  ok(!zList.includes(his.id), "看不见同事的排期（任务描述本身就是商业内容）", zList);
  ok(zList.includes(old.id), "升级上来的老任务照旧人人可见——不然一升级全员任务消失");
  eq(s.list().length, 3, "不传 viewer = 全量（tick 循环 / 离职清理靠它看全表）");

  // —— 取
  ok(!s.get(his.id, zhang), "取不到别人的排期");
  ok(!!s.get(mine.id, zhang), "反向对照：自己的取得到");
  ok(!!s.get(his.id), "反向对照：不传 viewer 取得到");

  // —— 改
  eq(s.update(his.id, { task: "偷偷改成发给我" }, zhang), null, "改不动别人的排期");
  eq(s.get(his.id).task, "盘一下仓库", "而且他那条原文一个字没变");
  ok(!!s.update(mine.id, { name: "回款周报 v2" }, zhang), "反向对照：自己的改得动");

  // —— 开关 / 补跑开关
  eq(s.toggle(his.id, false, zhang), false, "开不了别人的关");
  eq(s.get(his.id).enabled, true, "而且他那条还开着");
  eq(s.setCatchUp(his.id, false, zhang), false, "也动不了别人的补跑开关");
  eq(s.toggle(mine.id, false, zhang), true, "反向对照：自己的开得了关");
  s.toggle(mine.id, true, zhang);

  // —— 删
  eq(s.remove(his.id, zhang), false, "删不掉别人的排期");
  eq(s.list().length, 3, "表里还是三条");
  eq(s.remove(mine.id, zhang), true, "反向对照：自己的删得掉");
  eq(s.list().length, 2, "删完剩两条");
  ok(!!s.get(his.id, li), "小李自己的那条还在");

  s.stop();
}

// ==========================================================================
console.log("\n【2】排期归属：管理员也只到本组织为止");
// ==========================================================================
{
  const s = newSched();
  const t1 = s.add({ name: "总部的", cron: "0 8 * * *", task: "总部任务", user: "a", org: "default" });
  const t2 = s.add({ name: "分公司的", cron: "0 8 * * *", task: "分公司任务", user: "b", org: "org_hd" });

  const bossHere = V("boss", true, "default");
  const bossThere = V("boss2", true, "org_hd");
  const memberHere = V("c", false, "default");

  const h = s.list(bossHere).map((t) => t.id);
  ok(h.includes(t1.id), "本组织管理员看得见本组织成员的排期");
  ok(!h.includes(t2.id), "但看不见别的组织的", h);
  const th = s.list(bossThere).map((t) => t.id);
  ok(th.includes(t2.id) && !th.includes(t1.id), "反过来也一样：分公司管理员只看得见分公司的");
  eq(s.list(memberHere).length, 0, "同组织的普通成员一条都看不见（同事 ≠ 管理员）");
  eq(s.remove(t2.id, bossHere), false, "外组织管理员删不掉");
  eq(s.remove(t2.id, bossThere), true, "反向对照：本组织管理员删得掉");

  s.stop();
}

// ==========================================================================
console.log("\n【3】运行记录跟任务本体同一条判据（记录里带着产出原文）");
// ==========================================================================
{
  // 直接预置一张表：真跑一次要拉模型，这里要验的只是过滤
  const s = newSched({
    tasks: [
      { id: "t_mine", name: "我的", cron: "0 8 * * *", task: "我的任务", enabled: true, user: "xiaozhang", org: "default" },
      { id: "t_his", name: "他的", cron: "0 8 * * *", task: "他的任务", enabled: true, user: "xiaoli", org: "default" },
      { id: "t_old", name: "老的", cron: "0 8 * * *", task: "老任务", enabled: true },
    ],
    runs: [
      { task_id: "t_his", at: "2026-09-01T00:00:00.000Z", ok: true, text: "华东区回款 812 万" },
      { task_id: "t_mine", at: "2026-09-02T00:00:00.000Z", ok: true, text: "我的产出" },
      { task_id: "t_old", at: "2026-09-03T00:00:00.000Z", ok: true, text: "老任务的产出" },
    ],
  });
  const zhang = V("xiaozhang");
  const got = s.runs(100, zhang).map((r) => r.task_id);
  ok(!got.includes("t_his"), "看不到同事任务的运行记录（产出原文就在里面）", got);
  ok(got.includes("t_mine"), "自己的看得到");
  ok(got.includes("t_old"), "老任务的照旧看得到");
  eq(s.runs(100).length, 3, "不传 viewer 还是全量");
  eq(s.runs(100, zhang)[0].task_id, "t_old", "最近的排在最前面（顺序没被过滤打乱）");
  s.stop();
}

// ==========================================================================
console.log("\n【4】离职清理挂钩：一键停 + 交接换人");
// ==========================================================================
{
  const s = newSched();
  const a1 = s.add({ name: "回款周报", cron: "0 8 * * 1", task: "回款", user: "xiaozhang", org: "default" });
  const a2 = s.add({ name: "日报", cron: "0 18 * * *", task: "日报", user: "xiaozhang", org: "default" });
  const a3 = s.add({ name: "已经关着的", cron: "0 8 * * *", task: "早就停了", user: "xiaozhang", org: "default" });
  const b1 = s.add({ name: "别人的", cron: "0 8 * * *", task: "别人的", user: "xiaoli", org: "default" });
  s.toggle(a3.id, false);

  const stopped = s.disableOwnedBy("xiaozhang");
  eq(stopped.length, 2, "只停还开着的那两条（已经关着的不重复计数，回执上的数字才实）");
  eq(s.get(a1.id).enabled, false, "回款周报停了");
  eq(s.get(a1.id).disabled_reason, "原负责人已离职", "而且写明了为什么停——半年后翻到这条能看懂");
  eq(s.get(b1.id).enabled, true, "同事的一条都没误伤");
  eq(s.disableOwnedBy("").length, 0, "名字传空不做任何事（别把没归属的老任务全关了）");

  s.reassign(a1.id, "xiaoli");
  eq(s.get(a1.id).user, "xiaoli", "交接之后归属换人了");
  ok(!("disabled_reason" in s.get(a1.id)), "交接时把「原负责人已离职」抹掉——新负责人不该背着这句");
  eq(s.get(a1.id).enabled, false, "但仍然是关着的：交接是换人，不是替他确认内容");
  ok(!!s.get(a1.id, V("xiaoli")), "小李现在看得见这条了");
  ok(!s.get(a1.id, V("xiaozhang")), "小张看不见了");
  eq(s.reassign("sch_nope", "xiaoli"), null, "换一个不存在的任务返回 null，不是静默造一条出来");

  s.stop();
}

// ==========================================================================
console.log("\n【5】办离职：六道口子一次关完");
// ==========================================================================
// 建一个像样的组织：老板（所有者）+ 小张（要走的）+ 小李（接手的）+ 老王（另一个管理员）
const boss = account._internals.register("laoban", "pw-laoban-123");
org.updateOrg("default", { seats: 20 });
account.createMember(boss, { username: "xiaozhang", dept: "销售部" });
account.createMember(boss, { username: "xiaoli", dept: "销售部" });
account.createMember(boss, { username: "laowang", role: "admin", dept: "行政部" });
const U = (name) => account._internals.loadUsers().users.find((u) => u.username === name);

const sched = newSched();
scheduler.setActiveScheduler(sched);
{
  // —— 把小张手上的口子一个个开出来
  account._internals.issueToken("xiaozhang", { kind: "session", name: "公司电脑" });
  account._internals.issueToken("xiaozhang", { kind: "session", name: "家里电脑" });
  account._internals.issueToken("xiaozhang", { kind: "paired", name: "小张的 iPhone" });
  account._internals.issueToken("xiaoli", { kind: "session", name: "小李的电脑" });

  const sz1 = sched.add({ name: "回款周报", cron: "0 8 * * 1", task: "拉上月回款发给张总", user: "xiaozhang", org: "default" });
  const sz2 = sched.add({ name: "日报", cron: "0 18 * * *", task: "日报", user: "xiaozhang", org: "default" });
  const sl1 = sched.add({ name: "小李的巡检", cron: "0 9 * * *", task: "巡检", user: "xiaoli", org: "default" });

  const inv = org.createInvite("default", { role: "member", days: 7, max_uses: 5, actor: "xiaozhang" });
  const invOther = org.createInvite("default", { role: "member", days: 7, max_uses: 5, actor: "laoban" });

  const enroll = account._internals.startEnroll("xiaozhang");
  account._internals.enableTOTP("xiaozhang", totp.code(enroll.secret));
  ok(account.twoFactorOn(U("xiaozhang")), "前置：小张的二次验证是开着的");

  let stoppedRuns = 0;
  const r = lifecycle.offboard(boss, "xiaozhang", {
    handover: "xiaoli",
    stopRuns: (name) => { stoppedRuns = name === "xiaozhang" ? 2 : 0; return stoppedRuns; },
  });

  // 1 账号
  eq(U("xiaozhang").status, "disabled", "账号停用了");
  eq(r.revoked.account, "已停用", "回执写明了账号这一项");
  // 2 令牌 + 扫码设备
  eq(r.revoked.tokens, 3, "回执数对了：三条登录令牌");
  eq(r.revoked.devices, 1, "其中一台是扫码连进来的手机——这条以前没人算过");
  const left = Object.values(account._internals.loadUsers().tokens);
  eq(left.filter((t) => t.user === "xiaozhang").length, 0, "盘上他的令牌真的清零了");
  eq(left.filter((t) => t.user === "xiaoli").length, 1, "反向对照：小李的令牌没被误伤");
  // 3 排期
  eq(r.revoked.schedules, 2, "名下两条定时任务停了");
  eq(sched.get(sz1.id).enabled, false, "回款周报停了（这条最要命：走的是调度器，不过登录闸）");
  eq(sched.get(sz2.id).enabled, false, "日报也停了");
  eq(sched.get(sl1.id).enabled, true, "小李的巡检没被误伤");
  eq(sched.get(sz1.id).user, "xiaoli", "而且交接给了小李");
  eq(r.handed_to, "xiaoli", "回执上写了交接给谁");
  ok(r.warnings.some((w) => w.includes("关着")), "并且提醒：交接过去的还是关着的，要新负责人自己确认后再打开", r.warnings);
  // 4 邀请码
  eq(r.revoked.invites, 1, "他发出去、还活着的邀请码作废了一个");
  const codes = org.listInvites("default").map((i) => i.code);
  ok(!codes.includes(inv.code), "那个码在表里没了——不然人走三个月，谁捡到谁还能注册进来");
  ok(codes.includes(invOther.code), "反向对照：老板发的那个还在");
  // 5 二次验证
  eq(r.revoked.two_factor, true, "二次验证解绑了");
  ok(!account.twoFactorOn(U("xiaozhang")), "盘上真的没了（账号万一被重新启用，那把钥匙不在他兜里）");
  // 6 正在跑的任务
  eq(r.revoked.running, 2, "正在跑的两个任务当场掐断");

  // —— 该留的一样没少
  ok(r.kept.usage && r.kept.sessions && r.kept.files && r.kept.audit,
     "回执把「保留了什么」也写清楚了：用量 / 会话 / 文件 / 审计——人走了账还得能对");
  const auditRows = org.listAudit("default", { limit: 500 }).audit;
  ok(auditRows.some((a) => a.action === "办理离职" && a.target === "xiaozhang"), "审计里留了一条「办理离职」");
  ok(auditRows.some((a) => a.action === "添加成员" && a.target === "xiaozhang"), "他入职那条历史审计原样还在");

  // —— 不交接的那种：提醒得换一句话
  account.createMember(boss, { username: "xiaosun", dept: "销售部" });
  sched.add({ name: "孙的周报", cron: "0 8 * * 1", task: "周报", user: "xiaosun", org: "default" });
  const r2 = lifecycle.offboard(boss, "xiaosun", {});
  eq(r2.handed_to, "", "没传交接人就不交接");
  ok(r2.warnings.some((w) => w.includes("没人接手")), "改成提醒「停了但没人接手，别忘了找人认领」", r2.warnings);

  // —— keep2fa：法务要保留原状取证时才用
  account.createMember(boss, { username: "xiaozhao", dept: "法务部" });
  const e2 = account._internals.startEnroll("xiaozhao");
  account._internals.enableTOTP("xiaozhao", totp.code(e2.secret));
  const r3 = lifecycle.offboard(boss, "xiaozhao", { keep2fa: true });
  ok(!r3.revoked.two_factor, "传了 keep2fa 就不解绑");
  ok(account.twoFactorOn(U("xiaozhao")), "盘上还开着");
  ok(!!r3.kept.two_factor, "而且回执上写明了是「按要求保留」，不是漏掉了");
}

// ==========================================================================
console.log("\n【6】三道安全联锁");
// ==========================================================================
{
  throws(() => lifecycle.offboard(boss, "laoban"), "不能给自己办离职", "办不了自己（手一抖就把自己锁在门外）");
  throws(() => lifecycle.offboard(boss, ""), "没说要给谁", "名字传空当场报错");
  throws(() => lifecycle.offboard(boss, "根本没这个人"), "成员不存在", "人不存在当场报错");
  // 超管：谁都办不掉他，包括平台超管——他一走这个位子就空在那儿，谁也发不出新的管理员。
  // 要换人只有一条路：先在「管理员角色」里转让，再回来办他
  throws(() => lifecycle.offboard(U("laowang"), "laoban"), "超级管理员", "另一个管理员办不掉超级管理员");
  throws(() => lifecycle.offboard(boss, "laoban"), "自己", "他本人也办不掉自己");
  eq(U("laoban").status || "active", "active", "而且老板好好的，没被做一半");

  // 唯一管理员这条，得在一个**没有超管**的组织里才撞得到：正常建起来的组织，第一个管理员
  // 级别的人就是它的超管，先撞上的会是上面那条。没有超管的组织真的存在——老账本升上来的
  // 「一个管理员都没有」的组织，migrateOwners 补不了人，先空着（见 test/rbac.js 第七节）。
  // 所以这儿直接照那个样子摆一个出来
  const o2 = org.createOrg({ name: "华东分公司", plan: "team", seats: 5, actor: "laoban" });
  {
    const st = account._internals.loadUsers();
    const mk = (username, role, at) => ({ username, role, org: o2.id, salt: "x", hash: "x", status: "active", created_at: at });
    st.users.push(mk("hd_admin", "admin", "2026-03-01T00:00:00.000Z"));
    st.users.push(mk("hd_member", "member", "2026-03-02T00:00:00.000Z"));
    account._internals.saveUsers(st);
  }
  throws(() => lifecycle.offboard(boss, "hd_admin"), "唯一", "办不掉一个组织里唯一还在职的管理员（办完谁都进不了后台）");
  eq(U("hd_admin").status || "active", "active", "而且没做一半就停在那儿——他还是好好的");

  // 反向对照：把那个成员提上来。这个组织本来没有超管，于是他直接就是超管——
  // 跟注册那条路同一条规矩：一个组织里第一个管理员级别的人就是它的主人
  account.setMember(boss, "hd_member", { role: "admin" });
  eq(U("hd_member").role, "owner", "★没有超管的组织，提上来的第一个管理员直接就是超管★");
  const r = lifecycle.offboard(U("hd_member"), "hd_admin", {});
  eq(r.user, "hd_admin", "反向对照：这个组织有人镇着了，就办得了");
  eq(U("hd_admin").status, "disabled", "他真的停用了");
}

// ==========================================================================
console.log("\n【7】办入职：同一个部门进来的人，权限长得一模一样");
// ==========================================================================
{
  // 没有模板的时候：不填角色就是普通成员，额度跟随团队
  const a = lifecycle.onboard(boss, { username: "newbie1", dept: "市场部" });
  eq(a.user.role, "member", "没模板时默认普通成员");
  eq(a.applied.from_template, false, "回执说清了这次没命中模板");
  eq(a.applied.monthly_quota, "跟随团队", "额度默认跟随团队");
  ok(!!a.password && a.password.length >= 6, "返回了一次性密码");

  // 存一份部门模板
  const all = lifecycle.setDeptTemplate(boss, "销售部", { role: "member", monthly_quota: 3000 });
  ok(!!all["销售部"], "模板存进组织设置了");
  eq(lifecycle.deptTemplate("default", "销售部").monthly_quota, 3000, "读得回来");
  eq(lifecycle.deptTemplate("default", "没这个部门").hit, false, "没命中的部门退回默认值，不报错");

  const b = lifecycle.onboard(boss, { username: "newbie2", dept: "销售部" });
  eq(b.applied.from_template, true, "第二个销售部的人命中模板");
  eq(b.applied.monthly_quota, 3000, "额度按模板配好了——不用管理员回想前两个人是怎么填的");
  eq(U("newbie2").monthly_quota, 3000, "而且真的落到了账号上");

  // 显式传的优先于模板：模板是默认值，不是强制
  const c = lifecycle.onboard(boss, { username: "newbie3", dept: "销售部", monthly_quota: 9999, role: "auditor" });
  eq(c.applied.monthly_quota, 9999, "显式填了额度就听显式的");
  eq(U("newbie3").role, "auditor", "角色也一样");

  // 改模板 / 删模板
  lifecycle.setDeptTemplate(boss, "销售部", { role: "auditor", monthly_quota: 100 });
  eq(lifecycle.deptTemplate("default", "销售部").role, "auditor", "改得动");
  lifecycle.setDeptTemplate(boss, "销售部", null);
  eq(lifecycle.listDeptTemplates("default")["销售部"], undefined, "传 null 就是删掉");
  eq(lifecycle.deptTemplate("default", "销售部").hit, false, "删完就不命中了");

  // 闸门
  throws(() => lifecycle.onboard(boss, {}), "没填用户名", "不填用户名当场报错");
  throws(() => lifecycle.setDeptTemplate(U("newbie1"), "市场部", {}), "只有管理员", "普通成员改不了部门模板");
  throws(() => lifecycle.setDeptTemplate(boss, "  ", {}), "没说是哪个部门", "部门名传空当场报错");
  // 模板里的角色 = 以后办入职时直接授出去的角色，所以它过的是跟改角色同一道闸。
  // 不在这儿判的话，管理员填一张 role=admin 的模板、再办一次入职，就绕开了「管理员发不了管理员」
  throws(() => lifecycle.setDeptTemplate(boss, "临时部", { role: "超级管理员" }), "没有这个角色",
         "写歪的角色当场报错——悄悄退回 member 等于把管理员填的东西改了，他还以为存上了");
  throws(() => lifecycle.setDeptTemplate(U("laowang"), "临时部", { role: "admin" }), "授予",
         "★管理员填不了 role=admin 的模板（这是绕开「管理员发不了管理员」最省事的一条路）★");
  eq(lifecycle.listDeptTemplates("default")["临时部"], undefined, "两次都没存进去");
  lifecycle.setDeptTemplate(boss, "临时部", { role: "auditor" });
  eq(lifecycle.deptTemplate("default", "临时部").role, "auditor", "反向对照：够得着的角色存得进去");
  lifecycle.setDeptTemplate(boss, "临时部", {});
  eq(lifecycle.deptTemplate("default", "临时部").role, "member", "反向对照：不填角色还是回落到成员");
  lifecycle.setDeptTemplate(boss, "临时部", null);
}

// ==========================================================================
console.log("\n【8】离职回执：能整段贴进交接单");
// ==========================================================================
{
  account.createMember(boss, { username: "xiaoqian", dept: "财务部" });
  account._internals.issueToken("xiaoqian", { kind: "paired", name: "钱的 iPad" });
  sched.add({ name: "月结对账", cron: "0 8 1 * *", task: "月结", user: "xiaoqian", org: "default" });
  const r = lifecycle.offboard(boss, "xiaoqian", { handover: "xiaoli", stopRuns: () => 1 });
  const txt = lifecycle.receiptText(r);

  ok(txt.includes("离职权限回收单"), "有标题");
  ok(txt.includes("xiaoqian"), "写了是谁");
  ok(txt.includes("财务部"), "写了哪个部门");
  ok(txt.includes("laoban"), "写了谁经办的");
  ok(txt.includes("已关闭："), "分了「已关闭」一段");
  ok(txt.includes("月结对账"), "把停掉的排期逐条列了名字——交接的人才知道要认领什么");
  ok(txt.includes("扫码连入的设备"), "扫码设备单独说明（跟浏览器那条不是一码事）");
  ok(txt.includes("已交接给 xiaoli"), "写了交接给谁");
  ok(txt.includes("按规定保留（没有删除）"), "分了「保留」一段——这段是给合规看的");
  ok(txt.includes("还要人做的"), "没做完的事单列一段，不混在已完成里");
  ok(!/undefined|NaN|\[object/.test(txt), "没有 undefined / NaN / [object Object] 漏出来", txt);
}

// ==========================================================================
console.log("\n【9】HTTP 层：这几个口子普通成员打不开");
// ==========================================================================
const app = express();
app.use(express.json());
app.use(account.createRouter({}));
app.use(account.authGuard);
app.use(admin.platformGuard);
app.use(admin.redactGuard);
app.use(admin.createAdminRouter({ stopRunsOf: () => 0 }));
const server = app.listen(0, "127.0.0.1");

function call(method, url, { body, cookie } = {}) {
  const port = server.address().port;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = require("http").request(
      { host: "127.0.0.1", port, method, path: url,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
                   ...(cookie ? { cookie } : {}) } },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch {}
          const sc = res.headers["set-cookie"];
          resolve({ status: res.statusCode, json, cookie: sc ? String(sc[0]).split(";")[0] : null });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  await new Promise((r) => server.once("listening", r));

  // 老板登录。注册那会儿用的是 _internals.register，密码是明文传进去的那个
  let r = await call("POST", "/api/auth/login", { body: { username: "laoban", password: "pw-laoban-123" } });
  const bossCookie = r.cookie;
  ok(!!bossCookie, "老板登录拿到 cookie", r.json);

  // 建一个成员，让他自己也登录一次
  const made = await call("POST", "/api/admin/onboard", { cookie: bossCookie, body: { username: "http_member", dept: "市场部" } });
  eq(made.status, 200, "管理员走 /api/admin/onboard 建号返回 200", made.json);
  ok(!!made.json.password, "接口返回了一次性密码");
  r = await call("POST", "/api/auth/login", { body: { username: "http_member", password: made.json.password } });
  const memberCookie = r.cookie;
  ok(!!memberCookie, "新建的号能用这个密码登录进来——不然这个密码就是个摆设", r.json);

  // 建一个专门给他办离职的靶子
  await call("POST", "/api/admin/onboard", { cookie: bossCookie, body: { username: "http_leaver", dept: "市场部" } });

  // 未登录
  r = await call("POST", "/api/admin/members/http_leaver/offboard", { body: {} });
  eq(r.status, 401, "没登录：401");
  // 普通成员
  r = await call("POST", "/api/admin/members/http_leaver/offboard", { cookie: memberCookie, body: {} });
  eq(r.status, 403, "普通成员办不了别人的离职：403");
  r = await call("POST", "/api/admin/onboard", { cookie: memberCookie, body: { username: "sneaky" } });
  eq(r.status, 403, "普通成员也建不了号：403");
  ok(!U("sneaky"), "而且真的没建出来");
  r = await call("POST", "/api/admin/dept-templates", { cookie: memberCookie, body: { dept: "市场部", template: { role: "admin" } } });
  eq(r.status, 403, "普通成员改不了部门模板：403");

  // 管理员
  r = await call("POST", "/api/admin/dept-templates", { cookie: bossCookie, body: { dept: "市场部", template: { role: "member", monthly_quota: 500 } } });
  eq(r.status, 200, "管理员存得了模板");
  r = await call("GET", "/api/admin/dept-templates", { cookie: bossCookie });
  eq(r.json.templates["市场部"].monthly_quota, 500, "读回来是刚存的那份");

  r = await call("POST", "/api/admin/members/http_leaver/offboard", { cookie: bossCookie, body: {} });
  eq(r.status, 200, "管理员办得了离职：200", r.json);
  ok(!!r.json.receipt, "返回了回执对象（给机器看的）");
  ok(typeof r.json.text === "string" && r.json.text.includes("离职权限回收单"), "也返回了人话版（给人签字的）");
  eq(U("http_leaver").status, "disabled", "账号真的停用了");

  // 办自己：接口层也得拦住，不能只靠界面不画那颗按钮
  r = await call("POST", "/api/admin/members/laoban/offboard", { cookie: bossCookie, body: {} });
  eq(r.status, 400, "办自己：接口层也拦（界面不画按钮不算数）");
  ok(String(r.json.error || "").includes("不能给自己"), "而且说清了为什么", r.json);

  server.close();
  sched.stop();
  scheduler.setActiveScheduler(null);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
