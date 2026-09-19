"use strict";
/**
 * 权限模型的测试（rbac.js + account.js 里那几个闸）。
 *
 * 跑法：node test/rbac.js
 * 用临时 OPENWORKBUDDY_DATA_DIR，绝不碰真账号。
 *
 * 起因是用户的一句话：「怎么一个管理员能取消其他管理员或者增加管理员的权限了」。
 * 所以这份测试盯的不是「接口返回 200」，是那几条一破就出事的线：
 *   1. 管理员动不了另一个管理员——改角色、停用、删号、重置密码、办离职，一条都不行
 *   2. 管理员造不出管理员——改角色、直接建号、发邀请码、部门模板，四条路全堵
 *   3. 超管每个组织只有一个，只能转让；转完自己降成管理员
 *   4. 最后一个超管删不得、停不得、办不了离职——不然这个组织当场变成无主之地
 *   5. 锁死了得有出口：平台超管跨组织救场、命令行 `openworkbuddy owner`
 * 每条后面都跟一个反向对照：把该拒的换成该放的，必须放行——不然测的就不是它。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-rbac-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const express = require("express");
const ROOT = path.join(__dirname, "..");
const rbac = require(path.join(ROOT, "rbac"));
const account = require(path.join(ROOT, "account"));
const org = require(path.join(ROOT, "org"));
const admin = require(path.join(ROOT, "admin"));
const lifecycle = require(path.join(ROOT, "lifecycle"));
const tools = require(path.join(ROOT, "tools"));

tools.setWorkspaceDir(path.join(TMP, "workspace"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });
/** 跑一下，把抛出来的话拿回来；没抛就是空字符串 */
const why = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
/** 该拒：不但要拒，理由里还得有这个词——不然拒对了也可能是拒错了原因 */
const denied = (fn, word, msg) => { const m = why(fn); ok(m !== "" && m.includes(word), msg, { got: m || "（放行了）", want: word }); };
const allowed = (fn, msg) => { const m = why(fn); ok(m === "", msg, { got: m }); };

// ---------- 最小应用：中间件顺序照抄 server.js ----------
const app = express();
app.use(express.json());
app.use(account.createRouter({}));
app.use(account.authGuard);
app.use(admin.tenantScope({ withWorkspace: tools.withWorkspace, withPolicy: tools.withPolicy, getWorkspaceDir: tools.getWorkspaceDir }));
app.use(admin.platformGuard);
app.use(admin.createAdminRouter({}));
const server = app.listen(0);
const listening = new Promise((r) => server.on("listening", r));

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
async function login(username, password) {
  const r = await call("POST", "/api/auth/login", { body: { username, password } });
  if (!r.cookie) throw new Error(`登录失败 ${username}: ${JSON.stringify(r.json)}`);
  return r.cookie;
}
/** 从账本里取出真身（路由外的那些函数收的是这个，不是 publicUser） */
const raw = (name) => account._internals.loadUsers().users.find((u) => u.username === name);

(async () => {
  await listening;

  // ================= 【1】两条规矩本身 =================
  // 这一节不碰盘、不碰账号，只验 rbac.js 这张表。它是全套权限的唯一依据，
  // 一个字错了下面所有闸都跟着错，所以单独压一遍。
  console.log("\n【1】两条规矩：只能管比自己低的那一档 / 授角色要同时够得着人和角色");
  ok(rbac.ROLE_RANK.owner > rbac.ROLE_RANK.admin, "超管比管理员高");
  ok(rbac.ROLE_RANK.admin > rbac.ROLE_RANK.auditor, "管理员比审计员高");
  ok(rbac.ROLE_RANK.auditor > rbac.ROLE_RANK.member, "审计员比成员高");
  eq(rbac.roleOf({ role: "root" }), "member", "认不出来的角色当成员——字段是从盘上读的，写坏了不该变成什么都能干");
  eq(rbac.roleOf(null), "member", "没有这个人也当成员，不要抛");

  ok(!rbac.outranks({ role: "admin" }, { role: "admin" }), "★管理员管不了管理员：同档返回 false，这一行就是整件事的答案★");
  ok(rbac.outranks({ role: "admin" }, { role: "member" }), "反向对照：管理员管得了成员");
  ok(!rbac.outranks({ role: "owner" }, { role: "owner" }), "超管之间也一样动不了——先手优势这回事不存在");
  ok(rbac.outranks({ role: "owner" }, { role: "admin" }), "反向对照：超管管得了管理员");

  ok(rbac.can({ role: "auditor" }, "admin.read"), "审计员进得去后台");
  ok(!rbac.can({ role: "auditor" }, "admin.write"), "审计员改不了东西——「只读」要是能写就白设这一档了");
  ok(!rbac.can({ role: "admin" }, "role.grant_admin"), "★管理员没有「发管理员」这项能力★");
  ok(rbac.can({ role: "owner" }, "role.grant_admin"), "反向对照：超管有");
  ok(!rbac.can({ role: "admin" }, "owner.transfer"), "管理员转让不了超管这个位子");
  ok(!rbac.can({ role: "member" }, "admin.read"), "成员连后台门都进不去");
  ok(!rbac.can(null, "admin.read"), "没登录的人什么都不能");

  const A = { role: "admin" }, O = { role: "owner" }, M = { role: "member" }, U = { role: "auditor" };
  ok(/授予/.test(rbac.assignProblem(A, M, "admin")), "★管理员把成员提成管理员：拒★");
  eq(rbac.assignProblem(A, M, "auditor"), "", "反向对照：提成审计员可以——低一档的角色他发得出去");
  eq(rbac.assignProblem(O, M, "admin"), "", "反向对照：超管发管理员可以");
  ok(/同级/.test(rbac.assignProblem(A, A, "member")), "★管理员把另一个管理员降成成员：拒★");
  eq(rbac.assignProblem(O, A, "member"), "", "反向对照：超管降得动管理员");
  ok(/比自己权限高/.test(rbac.assignProblem(A, O, "member")), "管理员动不了超管");
  ok(/转让/.test(rbac.assignProblem(O, M, "owner")), "★超管这一档谁都授不出去，只能转让★");
  ok(/没有这个角色/.test(rbac.assignProblem(O, M, "god")), "不存在的角色：拒");
  ok(/没有管理成员的权限/.test(rbac.assignProblem(U, M, "member")), "审计员没有管人的权");

  eq(rbac.assignableBy(A, M).join(","), "auditor,member", "管理员的下拉里只有审计员和成员");
  eq(rbac.assignableBy(O, M).join(","), "admin,auditor,member", "超管的下拉里才有管理员");
  eq(rbac.assignableBy(U, M).length, 0, "审计员的下拉是空的");
  ok(!rbac.ASSIGNABLE.includes("owner"), "「能授出去的角色」里没有超管——邀请码、部门模板都读这张表");

  // ================= 【2】谁自动成为超管 =================
  console.log("\n【2】开局：每个组织都得有主");
  let r = await call("POST", "/api/auth/register", { body: { username: "laoban", password: "pw-laoban-123" } });
  eq(r.status, 200, "第一个账号注册成功");
  eq(r.json.user.role, "owner", "★开服第一个人 = 平台超级管理员★");
  eq(r.json.user.role_label, "超级管理员", "角色名给的是人话，界面直接显示这一格");
  const boss = r.cookie;
  org.updateOrg("default", { seats: 30 }, "laoban"); // 免费版 3 席不够这份测试用

  const fen = org.createOrg({ name: "深圳分公司", plan: "team", seats: 20, actor: "laoban" });
  r = await call("POST", "/api/auth/register", { body: { username: "fenboss", password: "pw-fen-1234", invite: org.createInvite(fen.id, { role: "admin", max_uses: 5, days: 7, actor: "laoban" }).code } });
  eq(r.json.user.role, "owner", "★分公司第一个管理员级别的人 = 分公司的超管★");
  ok(account.platformOwner(raw("laoban")), "laoban 是平台超管（默认组织那一个）");
  ok(!account.platformOwner(raw("fenboss")), "分公司的超管不是平台超管——他只管自己那摊");

  // 第二个管理员进同一个组织：这回只是管理员，不会再冒出一个超管
  const inv2 = org.createInvite(fen.id, { role: "admin", max_uses: 5, days: 7, actor: "fenboss" });
  r = await call("POST", "/api/auth/register", { body: { username: "fen2", password: "pw-fen2-456", invite: inv2.code } });
  eq(r.json.user.role, "admin", "★同一个组织的第二个管理员就是管理员——超管永远只有一个★");
  r = await call("POST", "/api/auth/register", { body: { username: "fen3", password: "pw-fen3-789", invite: inv2.code } });
  eq(r.json.user.role, "admin", "第三个也是管理员（这一节要两个同档的人，才测得出「同级动不了同级」）");

  // ================= 【3】管理员动不了管理员 =================
  // 这一节是用户那句话的正面回答。五个动作全压一遍，漏一个就等于没改。
  console.log("\n【3】管理员之间：一步也走不动");
  const a1 = raw("fenboss"), a2 = raw("fen2");
  account.createMember(a2, { username: "xiaoli", role: "member" });

  // 用户那句话的正面回答：fen2 和 fen3 都是管理员，谁也别想动谁
  denied(() => account.setMember(a2, "fen3", { role: "member" }), "同级", "★管理员降不了另一个管理员的角色★");
  denied(() => account.setMember(a2, "fen3", { status: "disabled" }), "同级", "★也停用不了他★");
  denied(() => account.removeMember(a2, "fen3"), "同级", "★也删不掉他★");
  denied(() => account.resetPassword(a2, "fen3"), "同级", "★也重置不了他的密码（重置完就是拿到了他的号）★");
  denied(() => lifecycle.offboard(a2, "fen3"), "同级", "★也办不了他的离职★");
  denied(() => account.assertManageable(a2, "fen3", "重置二次验证"), "同级", "★也解不了他的二次验证★");
  // 往上一档更不用说
  denied(() => account.setMember(a2, "fenboss", { role: "member" }), "超级管理员不能被管理员", "管理员动不了超管");
  denied(() => lifecycle.offboard(a2, "fenboss"), "超级管理员", "也办不了超管的离职");

  // 反向对照：同一个人对成员，上面每一条都得走得通
  allowed(() => account.setMember(a2, "xiaoli", { dept: "销售" }), "反向对照：他改得动成员的部门");
  allowed(() => account.setMember(a2, "xiaoli", { role: "auditor" }), "反向对照：也提得动成员当审计员");
  allowed(() => account.resetPassword(a2, "xiaoli"), "反向对照：也重置得了成员的密码");
  allowed(() => account.assertManageable(a2, "xiaoli", "重置二次验证"), "反向对照：也解得了成员的二次验证");
  account.setMember(a2, "xiaoli", { role: "member" });

  denied(() => account.setMember(a2, "fen2", { role: "member" }), "不能对自己", "管理员不能把自己降级——降完这个组织可能一个管理员都没有了");
  denied(() => lifecycle.offboard(a2, "fen2"), "不能给自己", "也不能给自己办离职");
  denied(() => account.setMember(raw("xiaoli"), "fen2", { role: "member" }), "只有管理员", "成员当然什么也动不了");
  denied(() => account.setMember(a2, "laoban", { role: "member" }), "不在你的组织", "分公司管理员动不了别的组织的人");

  // ================= 【4】管理员造不出管理员：四条路全堵 =================
  console.log("\n【4】发管理员这件事：四条路全堵");
  denied(() => account.setMember(a2, "xiaoli", { role: "admin" }), "授予", "①改角色：拒");
  denied(() => account.createMember(a2, { username: "xinren", role: "admin" }), "授予", "②直接建号：拒");
  // ③邀请码那条走 HTTP（判在路由层），压在最后一节
  denied(() => lifecycle.setDeptTemplate(a2, "技术部", { role: "admin" }), "授予", "④部门模板：拒——填一张 role=admin 的模板再办入职，就绕开了前三道");
  allowed(() => lifecycle.setDeptTemplate(a2, "技术部", { role: "auditor" }), "反向对照：模板里填审计员可以");
  allowed(() => account.createMember(a2, { username: "xinren", role: "auditor" }), "反向对照：建一个审计员可以");
  allowed(() => account.setMember(a1, "xiaoli", { role: "admin" }), "反向对照：超管发管理员，四条路都走得通");
  account.setMember(a1, "xiaoli", { role: "member" });
  // 兜底：就算路由层漏判，org.createInvite 自己也不认 owner
  eq(org.createInvite(fen.id, { role: "owner", actor: "fenboss" }).role, "member", "邀请码里写 owner：落盘时被打回成员（最后一道兜底）");

  // ================= 【5】超管只能转让 =================
  console.log("\n【5】超管这个位子：只能交出去，不能增发");
  denied(() => account.transferOwner(a2, "fen2"), "现任超级管理员本人", "管理员自己转不了这个位子给自己");
  denied(() => account.transferOwner(a1, "laoban"), "本组织", "转不给别的组织的人——那是这个组织换了个主子");
  denied(() => account.transferOwner(a1, "fenboss"), "已经是超级管理员", "转给现任自己：拒");
  account.setMember(a1, "xiaoli", { status: "pending" });
  denied(() => account.transferOwner(a1, "xiaoli"), "在职", "转不给待审核/已停用的人");
  account.setMember(a1, "xiaoli", { status: "active" });

  const t = account.transferOwner(a1, "fen2");
  eq(t.to.role, "owner", "★转让成功：fen2 成了分公司的超管★");
  eq(t.from.role, "admin", "★老超管当场降成管理员——他交出去的是钥匙，不是这份工作★");
  eq(account.listMembers(fen.id).filter((m) => m.role === "owner").length, 1, "★转完还是只有一个超管★");
  ok(raw("fen2").owner === true && raw("fenboss").owner === undefined, "owner 这一格跟着角色一起搬了（老代码和回退版本还认它）");
  // 交接完成，现在 fen2 是超管、fenboss 是普通管理员。刚才「动不了」的方向整个反过来
  allowed(() => account.setMember(raw("fen2"), "fenboss", { role: "auditor" }), "★换人之后方向反过来：新超管降得动老超管★");
  account.setMember(raw("fen2"), "fenboss", { role: "admin" });

  // ================= 【6】最后一个超管：删不得、停不得、走不得 =================
  console.log("\n【6】最后一个超管：这个组织不能变成无主之地");
  const pboss = raw("laoban"), fboss = raw("fen2");
  denied(() => account.removeMember(pboss, "fen2"), "不能被删除", "★平台超管也删不掉分公司的超管——先转让，再动他★");
  denied(() => account.setMember(pboss, "fen2", { status: "disabled" }), "不能被停用", "★也停用不了★");
  denied(() => lifecycle.offboard(pboss, "fen2"), "超级管理员", "★也办不了离职★");
  // 但平台超管**跨组织**的那半档是真的：分公司超管跑路了得有人救场
  allowed(() => account.transferOwner(pboss, "fenboss"), "★反向对照：平台超管能跨组织把分公司的超管指给别人（跑路救场那条路）★");
  eq(raw("fenboss").role, "owner", "指派生效");
  eq(raw("fen2").role, "admin", "原来那个降成管理员");
  allowed(() => account.removeMember(pboss, "fen2"), "★交接之后就删得动了：规矩拦的是「最后一个」，不是这个人★");
  // 自己组织里不加那半档：平台超管对着自己仍然是同档
  denied(() => account.setMember(pboss, "laoban", { role: "admin" }), "不能对自己", "平台超管也降不了自己——那半档只对别的组织有效");

  // ================= 【7】老账本搬家 =================
  // 0.6.1 之前 owner 是个布尔，而且只给全站第一个人：分公司一个超管都没有，
  // 那儿的管理员互相之间谁都能停用谁。migrateOwners 就是来补这个的。
  console.log("\n【7】升级搬家：老账本抬到新模型上");
  {
    const st = account._internals.loadUsers();
    const mk = (username, role, extra = {}) => ({ username, role, org: "default", salt: "x", hash: "x",
      status: "active", created_at: "2026-01-0" + (st.users.length % 9 + 1) + "T00:00:00.000Z", ...extra });
    const lao = st.users.find((u) => u.username === "laoban");
    lao.role = "admin";           // 老账本里这一格写的是 admin，主人身份靠 owner 这个布尔
    lao.owner = true;
    const old = org.createOrg({ name: "老账本分公司", plan: "team", actor: "setup" });
    st.users.push(mk("old_a", "admin", { org: old.id, created_at: "2026-02-02T00:00:00.000Z" }));
    st.users.push(mk("old_b", "admin", { org: old.id, created_at: "2026-02-01T00:00:00.000Z" }));
    st.users.push(mk("old_c", "admin", { org: old.id, created_at: "2026-01-01T00:00:00.000Z", status: "disabled" }));
    st.users.push(mk("old_d", "admin", { org: old.id, created_at: "2026-02-03T00:00:00.000Z" }));
    const bare = org.createOrg({ name: "只有成员的分公司", plan: "team", actor: "setup" });
    st.users.push(mk("only_m", "member", { org: bare.id }));
    account._internals.saveUsers(st);

    const n = account.migrateOwners();
    ok(n >= 2, `搬了 ${n} 个人`);
    eq(raw("laoban").role, "owner", "★owner 这个布尔抬成了 role:owner★");
    eq(raw("old_b").role, "owner", "★原来没有超管的组织，补上在职管理员里建号最早的那个★");
    eq(raw("old_c").role, "admin", "停用的那个不算——建号更早也不补给他，补了等于把组织交给一个登不进来的号");
    eq(raw("old_a").role, "admin", "另外两个照旧是管理员");
    eq(raw("only_m").role, "member", "★一个管理员都没有的组织先空着：没人可补，硬补只会补错人★");
    eq(account.migrateOwners(), 0, "再搬一次是 0——这件事只做一次");
    denied(() => account.setMember(raw("old_a"), "old_d", { status: "disabled" }), "同级", "★搬完之后，老账本里那两个管理员之间也互相动不了了★");
    denied(() => account.setMember(raw("old_a"), "old_b", { role: "member" }), "超级管理员不能被管理员", "刚补上的那个超管，他们也动不了");
  }

  // ================= 【8】两条新接口 =================
  console.log("\n【8】接口这一层");
  const bossC = boss;
  r = await call("GET", "/api/admin/roles", { cookie: bossC });
  eq(r.status, 200, "GET /api/admin/roles 通");
  eq(r.json.me.role, "owner", "认出我是超管");
  eq(r.json.me.can_assign.join(","), "admin,auditor,member", "下拉选项由服务端给，前端不自己编");
  ok(r.json.caps["role.grant_admin"], "能力表带人话说明，界面直接照着列");
  eq(r.json.owner, "laoban", "默认组织的超管是 laoban");

  const liC = await login("xiaoli", account.resetPasswordLocally("xiaoli").password).catch(() => null);
  r = await call("GET", "/api/admin/roles", { cookie: liC });
  eq(r.status, 403, "成员打不开这个接口");
  r = await call("POST", "/api/admin/owner", { cookie: liC, body: { username: "xiaoli" } });
  eq(r.status, 403, "★成员更不可能把超管转给自己★");

  // 平台级的组织管理：管理员进不去，只有平台超管进得去
  const fen3C = await login("fen3", account.resetPasswordLocally("fen3").password);
  r = await call("GET", "/api/admin/orgs", { cookie: fen3C });
  ok(r.status === 403, "★分公司管理员开不了「组织管理」——新建组织、改别人的席位是平台超管的事★", { got: r.status });
  r = await call("GET", "/api/admin/orgs", { cookie: bossC });
  eq(r.status, 200, "反向对照：平台超管开得了");
  r = await call("POST", "/api/admin/invites", { cookie: fen3C, body: { role: "admin" } });
  eq(r.status, 400, "③邀请码：管理员发不出 role=admin 的码（这是绕开前面所有闸最省事的一条路）");
  ok(/授予/.test((r.json || {}).error || ""), "拒的理由说的是「发不了这个角色」");
  r = await call("POST", "/api/admin/invites", { cookie: fen3C, body: { role: "auditor" } });
  eq(r.status, 200, "反向对照：审计员的码他发得出来");

  // 建号 / 部门模板 / 邀请码这三个下拉都从 /api/admin/members 的 can_assign 画出来。
  // 服务端不给这一条，前端就只能自己编一份，编的那份迟早跟 rbac.js 那张表走散——
  // 走散的样子是：管理员的下拉里挂着「管理员」，点下去后端一句「你没有授予…的权限」
  r = await call("GET", "/api/admin/members", { cookie: fen3C });
  eq(r.status, 200, "GET /api/admin/members 通");
  eq((r.json.can_assign || []).join(","), "auditor,member", "★管理员那边的下拉里没有「管理员」这一档——看得见的按钮不能是会 403 的按钮★");
  r = await call("GET", "/api/admin/members", { cookie: bossC });
  eq((r.json.can_assign || []).join(","), "admin,auditor,member", "反向对照：超管那边三档都在");
  // 主界面那张头像菜单按 can_admin / is_admin 画，不按角色名。角色名那条路每加一档就漏一个人，
  // 而漏掉的样子是「权限最大的那个反而看不见入口」——看不见的东西没人会来报
  { const me = (n) => account.publicUser(raw(n));
    eq([me("laoban").can_admin, me("laoban").is_admin].join(","), "true,true", "超管：进得去、改得动");
    eq([me("fen3").can_admin, me("fen3").is_admin].join(","), "true,true", "管理员：进得去、改得动");
    eq([me("xiaoli").can_admin, me("xiaoli").is_admin].join(","), "false,false", "★成员：两格都是 false★");
    eq(me("laoban").role_label, "超级管理员", "人话名字一起发下来，界面不自己翻");
    const src2 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
    ok(/currentUser\.can_admin/.test(src2), "★头像菜单读的是 can_admin★");
    ok(!/currentUser\.role === "admin" \|\| currentUser\.role === "auditor"/.test(src2), "按角色名写死的那份已经删干净了"); }
  { const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "admin.js"), "utf8");
    ok(/const roleOpts = \(m\.can_assign/.test(src), "★前端确实照着服务端那份画，没有自己写死一份★");
    ok(!/\{ value: "admin", label: "管理员 —— 能改所有东西" \}/.test(src), "写死的那份已经删干净了"); }

  server.close();
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
