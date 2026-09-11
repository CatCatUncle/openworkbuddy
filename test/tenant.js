"use strict";
/**
 * 多租户 + 企业管理后台的端到端测试。
 *
 * 跑法：node test/tenant.js
 * 用临时 WB_DATA_DIR 和临时工作目录，绝不碰真账号、真成果文件。
 *
 * 这个测试的重点不是「接口能返回 200」，而是那几条一破就出事的线：
 *   1. 跨租户读不到对方的成果文件（工作目录是不是真的按组织分开了）
 *   2. 分公司管理员改不动服务器级设置（引擎/密钥/定时任务/全局工作目录）
 *   3. 普通成员读不到 API Key
 *   4. 席位、抵扣顺序、成员管理的越权
 * 每条后面都跟一个「反向对照」：把该拒的换成该放的，必须放行——不然测的就不是它。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wb-tenant-"));
process.env.WB_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.WB_DATA_DIR, { recursive: true });

const express = require("express");
const ROOT = path.join(__dirname, "..");
const account = require(path.join(ROOT, "account"));
const org = require(path.join(ROOT, "org"));
const admin = require(path.join(ROOT, "admin"));
const tools = require(path.join(ROOT, "tools"));
const security = require(path.join(ROOT, "security"));
const agentMod = require(path.join(ROOT, "agent"));
const memory = require(path.join(ROOT, "memory"));
const { createImRouter } = require(path.join(ROOT, "im"));
const { createImSessionStore } = require(path.join(ROOT, "im-store"));

// 默认组织的根：单机版原来是什么样，这里就是什么样
const BASE_WS = path.join(TMP, "workspace");
tools.setWorkspaceDir(BASE_WS);

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

// ---------- 一个跟 server.js 中间件顺序一模一样的最小应用 ----------
const app = express();
app.use(express.json());
app.use(account.createRouter({}));
app.use(account.authGuard);
app.use(admin.tenantScope({ withWorkspace: tools.withWorkspace, withPolicy: tools.withPolicy, getWorkspaceDir: tools.getWorkspaceDir }));
app.use(admin.platformGuard);
app.use(admin.redactGuard);
app.use(admin.createAdminRouter({ orgUsage: () => ({ files: tools.outputFiles().length }) }));
// 下面这几个是 server.js 上真实存在的接口的替身，形状照抄，用来验中间件
app.get("/api/files", (_req, res) => res.json(tools.outputFiles()));
app.get("/api/settings", (_req, res) =>
  res.json({ workspace_dir: tools.getWorkspaceDir(), search: { provider: "jina", jina_key: "REAL-JINA-KEY" },
             im: { feishu: { app_id: "cli_x", app_secret: "REAL-APP-SECRET" } },
             models: [{ name: "m1", api_key: "REAL-MODEL-KEY" }] }));
app.post("/api/settings", (req, res) => res.json({ ok: true, got: req.body }));
app.get("/api/schedules", (_req, res) => res.json([{ id: "s1", task: "平台的定时任务" }]));
app.post("/api/engines/test", (_req, res) => res.json({ ok: true }));
// 命令审批的两条。判定用的是 security 里的真函数（listApprovals / effectiveScope / resolveApproval），
// 这儿只照 server.js 摆出同样的形状，用来验中间件那道闸和归属
const approvalScope = (req) =>
  admin.isSoloDesktop() || admin.platformAdmin(req.user) ? undefined : (req.user && req.user.username) || "";
app.get("/api/security/approvals", (req, res) => {
  const scopeTo = approvalScope(req);
  res.json({ items: security.listApprovals(scopeTo), can_always: scopeTo === undefined });
});
app.post("/api/security/approvals/:id", (req, res) => {
  const scopeTo = approvalScope(req);
  const { scope, downgraded } = security.effectiveScope((req.body || {}).scope, scopeTo !== undefined);
  const r = security.resolveApproval(req.params.id, !!(req.body || {}).allow, scope, scopeTo);
  if (!r.ok) return res.status(r.forbidden ? 403 : 409).json({ ...r, error: r.error || "这条审批已经结束了" });
  res.json({ ...r, scope, downgraded });
});
// 长期记忆的四条。判定用的是 memory 里的真函数（list / add / remove），这儿照 server.js 摆同样的形状。
// 守的坑：条目是**按登录名**存的（agent 用 remember 工具替他记），可路径撞上 /api/memory 这个平台前缀，
// 结果记的是他的事、他自己既看不见也删不掉；而按 id 删那条路以前压根不认归属，谁的都删得掉。
const memScope = (req) =>
  admin.isSoloDesktop() || admin.platformAdmin(req.user) ? undefined : (req.user && req.user.username) || "";
app.get("/api/memory", (req, res) => {
  const scopeTo = memScope(req);
  res.json({ items: memory.list(req.user ? req.user.username : undefined), shared_tag: memory.SHARED,
             content: memory.manual(), can_share: scopeTo === undefined, can_edit_manual: scopeTo === undefined });
});
app.post("/api/memory", (req, res) => { memory.saveManual((req.body || {}).content || ""); res.json({ ok: true }); });
app.post("/api/memory/item", (req, res) => {
  const wantShared = !!(req.body || {}).shared;
  const downgraded = wantShared && memScope(req) !== undefined;
  const r = memory.add({ text: (req.body || {}).text, user: req.user ? req.user.username : undefined,
                         shared: wantShared && !downgraded, source: "user" });
  if (r.ok && downgraded) r.note = (r.note || "记住了") + "。共享给这台机器上所有账号要平台管理员来做，这条先记成你自己的";
  res.status(r.ok ? 200 : 400).json({ ...r, downgraded });
});
app.delete("/api/memory/item/:id", (req, res) => {
  const r = memory.remove(req.params.id, memScope(req));
  if (r.forbidden) return res.status(403).json({ ok: false, removed: 0, error: "这条不是你记的，删不了" });
  res.json({ ok: true, removed: r.removed });
});
app.get("/api/memory/export", (_req, res) => res.json({ dump: "整库" }));
// 界面靠它决定「服务器级的那些控件画不画」。画了却一点就 403，就是用户那句
// 「切换失败怎么还切换失败了啊」——一颗明明能点的按钮，点了只回四个字。
const isPlatformOwner = (req) => admin.isSoloDesktop() || admin.platformAdmin(req && req.user);
app.get("/api/settings-probe", (req, res) => res.json({ platform_owner: isPlatformOwner(req) }));
app.get("/api/security/modes", (req, res) =>
  res.json({ modes: { ask: { label: "每次问我" } }, current: "ask", can_switch: isPlatformOwner(req) }));
// 资料库：读放行、写照拦。到不了这几个 handler 就说明 platformGuard 在前面拦下了。
app.get("/api/library", (_req, res) => res.json({ files: [{ name: "手册.md" }], notes: [{ id: "n1", text: "老板喜欢短句" }] }));
app.post("/api/library/upload", (_req, res) => res.json({ ok: true }));
app.post("/api/library/note", (_req, res) => res.json({ ok: true }));
app.delete("/api/library/file/:name", (_req, res) => res.json({ ok: true }));
app.delete("/api/library/note/:id", (_req, res) => res.json({ ok: true }));
app.get("/api/schedules", (_req, res) => res.json([]));
app.get("/api/eval", (_req, res) => res.json([]));
// 探针：这条请求里 tools.orgPolicy() 看到的是什么。用来验「设置真的进了执行层」，
// 而不是只躺在 org.json 里没人读——那种开关比没有这个开关更糟
app.get("/api/policy-probe", (_req, res) => res.json({ policy: tools.orgPolicy(), ws: tools.getWorkspaceDir() }));

// 「用系统程序打开」「在访达里显示」：按下去是在**服务器那台机器**上起一个进程。
// 成员在自己浏览器里点，窗口弹在管理员的显示器上——所以这是配机器，不是租户内动作。
app.post("/api/files/open/*", (_req, res) => res.json({ ok: true }));
app.post("/api/files/reveal", (_req, res) => res.json({ ok: true }));

// 新手向导。最后一步写的是服务器级的东西（全局工作目录 + 「走完了」这个标记），
// 闸门按 /api/onboarding 前缀拦住了写，读却是放行的——所以 GET 必须顺手把「你能不能走完」说清楚，
// 不然成员会被一块没有 ✕ 的全屏遮罩堵在门口，一步步认真填完，最后一颗按钮回他四个字。
app.get("/api/onboarding", (req, res) => res.json({ needs_setup: false, seen: false, can_finish: isPlatformOwner(req) }));
app.post("/api/onboarding/done", (_req, res) => res.json({ ok: true }));

const server = app.listen(0, "127.0.0.1");
const listening = new Promise((r) => server.once("listening", r));

// ---------- 极小的 HTTP 客户端：带 cookie ----------
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

(async () => {
  await listening;
  console.log("\n【1】开局：第一个账号自动成为平台管理员");
  let r = await call("POST", "/api/auth/register", { body: { username: "laoban", password: "pw-laoban-123" } });
  eq(r.status, 200, "注册第一个账号返回 200");
  const boss = r.cookie;
  eq(r.json.user.role, "admin", "第一个账号是 admin");
  eq(r.json.user.owner, true, "第一个账号是组织所有者");
  eq(r.json.user.org, "default", "第一个账号在默认组织");

  console.log("\n【2】平台管理员建第二个组织，给它自己的工作目录");
  r = await call("POST", "/api/admin/orgs", { cookie: boss, body: { name: "华东分公司", plan: "team", seats: 3 } });
  eq(r.status, 200, "建组织返回 200");
  const org2 = r.json.id;
  ok(!!org2, "拿到组织 id");
  const root2 = org.rootDirOf(org.getOrg(org2), BASE_WS);
  ok(root2 !== BASE_WS, "分公司的根跟默认组织的根不是同一个", { root2, BASE_WS });
  ok(!path.resolve(root2).startsWith(path.resolve(BASE_WS) + path.sep),
     "分公司的根不在默认组织的目录里（否则默认组织的人一列文件就看见了）", { root2 });

  console.log("\n【3】各自往自己的工作目录里放一个文件");
  fs.mkdirSync(BASE_WS, { recursive: true });
  fs.mkdirSync(root2, { recursive: true });
  fs.writeFileSync(path.join(BASE_WS, "总部机密.md"), "hq");
  fs.writeFileSync(path.join(root2, "分公司的活.md"), "branch");

  console.log("\n【4】邀请码进人");
  // 邀请码永远发给「发码人所属的组织」——总部发的码只能把人拉进总部，拉不进分公司。
  // 这条要钉住：要是哪天改成能指定组织，一张泄露的码就能把人塞进任意租户
  r = await call("POST", "/api/admin/invites", { cookie: boss, body: { role: "member", max_uses: 5 } });
  eq(r.status, 200, "总部发码成功");
  eq(r.json.org, "default", "总部发的码属于默认组织，指定不了别家");
  const hqInv = r.json.code;
  r = await call("POST", "/api/auth/register", { body: { username: "hqguy", password: "pw-hq-12345", invite: hqInv } });
  eq(r.json.user.org, "default", "用总部的码注册，人落在总部");

  // 分公司的码由分公司自己发。这里先用 org 层直接发一张，把分公司的第一个管理员放进去
  const inv = org.createInvite(org2, { role: "admin", max_uses: 5, days: 7, actor: "laoban" });
  r = await call("POST", "/api/auth/register", { body: { username: "fenboss", password: "pw-fen-1234", invite: inv.code } });
  eq(r.status, 200, "拿分公司邀请码注册成功");
  const fen = r.cookie;
  eq(r.json.user.org, org2, "新人落在分公司");
  eq(r.json.user.role, "admin", "邀请码指定的角色生效（分公司管理员）");

  const memInv = org.createInvite(org2, { role: "member", max_uses: 5, days: 7, actor: "fenboss" });
  r = await call("POST", "/api/auth/register", { body: { username: "xiaoyuan", password: "pw-yuan-1234", invite: memInv.code } });
  const yuan = r.cookie;
  eq(r.json.user.org, org2, "第二个新人也在分公司");
  eq(r.json.user.role, "member", "这张码指定的是普通成员");

  console.log("\n【5】红线一：跨租户看不到对方的成果文件");
  r = await call("GET", "/api/files", { cookie: boss });
  const bossFiles = (r.json || []).map((f) => f.name);
  ok(bossFiles.includes("总部机密.md"), "总部能看到自己的文件", bossFiles);
  ok(!bossFiles.includes("分公司的活.md"), "总部看不到分公司的文件", bossFiles);
  r = await call("GET", "/api/files", { cookie: fen });
  const fenFiles = (r.json || []).map((f) => f.name);
  ok(fenFiles.includes("分公司的活.md"), "分公司能看到自己的文件（反向对照：不是全都看不到）", fenFiles);
  ok(!fenFiles.includes("总部机密.md"), "分公司看不到总部的文件", fenFiles);

  console.log("\n【6】红线二：分公司管理员碰不到服务器级设置");
  r = await call("POST", "/api/settings", { cookie: fen, body: { workspace_dir: "/tmp/hijack" } });
  eq(r.status, 403, "分公司管理员改设置被拒");
  eq(r.json.platform_only, true, "拒绝理由说明是平台级");
  r = await call("POST", "/api/engines", { cookie: fen, body: { engine: "codex" } });
  eq(r.status, 403, "分公司管理员改不了这台服务器默认用哪个引擎");
  // 「一键连接」是例外，而且是故意的：它真跑一句话过去，走的是**他本机那份 CLI 的订阅**，
  // 一个字节都不落盘。拦下来只有一个效果——他切完引擎没法验，界面上只剩「切换失败」四个字。
  // 路由那边会把非平台管理员传来的 bin 丢掉（起哪个可执行文件不是个人偏好），那条钉在 test/prefs.js。
  r = await call("POST", "/api/engines/test", { cookie: fen, body: { id: "codex" } });
  eq(r.status, 200, "但「一键连接」放行：花的是他自己的订阅，不落盘，也不影响别人");
  r = await call("GET", "/api/schedules", { cookie: fen });
  eq(r.status, 403, "分公司管理员连平台的定时任务都读不到");
  // 反向对照：同样这三个请求，平台管理员必须全过
  eq((await call("POST", "/api/settings", { cookie: boss, body: { a: 1 } })).status, 200, "反向对照：平台管理员改设置放行");
  eq((await call("POST", "/api/engines/test", { cookie: boss, body: {} })).status, 200, "反向对照：平台管理员测引擎放行");
  eq((await call("GET", "/api/schedules", { cookie: boss })).status, 200, "反向对照：平台管理员读定时任务放行");
  // 平台管理员自己发的请求，workspace_dir 不能被摘掉
  r = await call("POST", "/api/settings", { cookie: boss, body: { workspace_dir: "/tmp/ok" } });
  eq(r.json.got.workspace_dir, "/tmp/ok", "反向对照：平台管理员的 workspace_dir 原样送到");

  console.log("\n【7】红线三：非平台管理员读不到 API Key");
  r = await call("GET", "/api/settings", { cookie: boss });
  eq(r.json.search.jina_key, "REAL-JINA-KEY", "反向对照：平台管理员拿到真 key（不然就是全抹了）");
  r = await call("GET", "/api/settings", { cookie: fen });
  eq(r.json.search.jina_key, "", "分公司管理员拿不到搜索 key");
  eq(r.json.im.feishu.app_secret, "", "分公司管理员拿不到飞书 App Secret");
  eq(r.json.im.feishu.app_id, "cli_x", "非凭证字段照常返回（app_id 不该被抹）");
  eq(r.json.models[0].api_key, "", "模型 api_key 被抹");
  eq(r.json.models[0].name, "m1", "模型名照常返回");
  r = await call("GET", "/api/settings", { cookie: yuan });
  eq(r.json.search.jina_key, "", "同组织的普通成员一样拿不到 key");

  console.log("\n【8】席位闸：分公司套餐 3 席，已用 2");
  r = await call("GET", "/api/admin/overview", { cookie: fen });
  eq(r.status, 200, "分公司管理员能进后台");
  eq(r.json.seats.total, 3, "席位总数 3");
  eq(r.json.seats.used, 2, "已用 2");
  eq(r.json.plan.label, "团队版", "套餐名对");
  r = await call("POST", "/api/admin/members", { cookie: fen, body: { username: "third", role: "member" } });
  eq(r.status, 200, "第 3 个人能进（反向对照：不是一律拒）");
  r = await call("POST", "/api/admin/members", { cookie: fen, body: { username: "fourth", role: "member" } });
  eq(r.status, 400, "第 4 个人被席位闸拦下");
  ok(/席位已用满/.test(r.json.error || ""), "报错说的是席位满了", r.json);

  console.log("\n【9】越权：分公司管理员改不动别的组织的人");
  r = await call("POST", "/api/admin/members/laoban", { cookie: fen, body: { role: "member" } });
  eq(r.status, 400, "改不了总部的账号");
  ok(/不在你的组织/.test(r.json.error || ""), "报错说的是不在同一组织", r.json);
  r = await call("DELETE", "/api/admin/members/laoban", { cookie: fen });
  eq(r.status, 400, "删不了总部的账号");
  // 反向对照：改本组织的人必须成
  r = await call("POST", "/api/admin/members/xiaoyuan", { cookie: fen, body: { dept: "销售一部" } });
  eq(r.status, 200, "反向对照：改本组织的人成功");
  eq(r.json.member.dept, "销售一部", "部门改上了");

  console.log("\n【10】组织所有者动不得，也不能自己改自己");
  r = await call("POST", "/api/admin/members/fenboss", { cookie: fen, body: { role: "member" } });
  eq(r.status, 400, "不能给自己降级");
  const ownerName = account.listMembers(org2).find((m) => m.owner);
  ok(!ownerName, "分公司是邀请码进来的，没有 owner（owner 只有开服第一个人有）");

  console.log("\n【11】只有平台管理员能建组织 / 看全部组织");
  eq((await call("GET", "/api/admin/orgs", { cookie: fen })).status, 403, "分公司管理员看不到组织列表");
  eq((await call("POST", "/api/admin/orgs", { cookie: fen, body: { name: "偷建的" } })).status, 403, "分公司管理员建不了组织");
  r = await call("GET", "/api/admin/orgs", { cookie: boss });
  eq(r.status, 200, "反向对照：平台管理员看得到");
  eq(r.json.orgs.length, 2, "一共两个组织");

  console.log("\n【12】审计员：能查账，改不动");
  // 席位刚被占满，先由平台管理员加席位（分公司自己加不了，第 11 节已经验过）
  r = await call("POST", `/api/admin/orgs/${org2}`, { cookie: boss, body: { seats: 5 } });
  eq(r.status, 200, "平台管理员给分公司加到 5 席");
  const auditInv = org.createInvite(org2, { role: "auditor", max_uses: 1, days: 7, actor: "fenboss" });
  r = await call("POST", "/api/auth/register", { body: { username: "kuaiji", password: "pw-kuai-1234", invite: auditInv.code } });
  eq(r.json.user.role, "auditor", "审计员角色生效");
  const kuai = r.cookie;
  eq((await call("GET", "/api/admin/usage", { cookie: kuai })).status, 200, "审计员能看用量");
  eq((await call("POST", "/api/admin/members/xiaoyuan", { cookie: kuai, body: { dept: "x" } })).status, 403, "审计员改不了成员");
  eq((await call("POST", "/api/admin/topup", { cookie: kuai, body: { username: "xiaoyuan", amount: 100 } })).status, 403, "审计员充不了值");
  // 普通成员连后台门都进不去
  eq((await call("GET", "/api/admin/overview", { cookie: yuan })).status, 403, "普通成员进不了后台");

  console.log("\n【13】用量：先扣月固定额度，再扣加油包");
  org.updateOrg(org2, { settings: { credits_enabled: true, member_monthly_credits: 50 } }, "fenboss");
  const st = account._internals.loadUsers();
  const u = st.users.find((x) => x.username === "xiaoyuan");
  u.credits = 1000;
  account._internals.saveUsers(st);
  account.chargeRun({ username: "xiaoyuan" }, { prompt: 30000, completion: 0, model: "m1", source: "web", elapsed_ms: 1000 });
  let me = account.listMembers(org2).find((m) => m.username === "xiaoyuan");
  eq(me.monthly_left, 20, "第一次扣 30：月额度剩 20");
  eq(me.credits, 1000, "加油包没动");
  account.chargeRun({ username: "xiaoyuan" }, { prompt: 40000, completion: 0, model: "m1", source: "web", elapsed_ms: 1000 });
  me = account.listMembers(org2).find((m) => m.username === "xiaoyuan");
  eq(me.monthly_left, 0, "第二次扣 40：月额度扣光");
  eq(me.credits, 980, "剩下的 20 才走加油包");
  eq(me.balance, 980, "余额 = 月剩余 + 加油包");

  console.log("\n【14】用量只看得到本组织的账");
  r = await call("GET", "/api/admin/usage", { cookie: fen });
  const users = r.json.by_user.map((x) => x.key);
  ok(users.includes("xiaoyuan"), "分公司看得到自己人的账", users);
  ok(!users.includes("laoban"), "分公司看不到总部的账", users);

  console.log("\n【15】审计流水留痕");
  r = await call("GET", "/api/admin/audit", { cookie: fen });
  const actions = r.json.audit.map((a) => a.action);
  ok(actions.includes("添加成员"), "加人有留痕", actions);
  ok(actions.includes("使用邀请码"), "用邀请码有留痕", actions);
  ok(actions.includes("改企业设置"), "改设置有留痕", actions);

  console.log("\n【16】单组织部署：一行行为都不该变");
  eq(org.multiTenant(), true, "本测试里确实是多组织");
  eq(admin.ownsGlobalWorkspace({ org: "default", role: "admin" }), true, "默认组织管理员 = 平台管理员");
  eq(admin.ownsGlobalWorkspace({ org: org2, role: "admin" }), false, "分公司管理员不是");
  eq(admin.ownsGlobalWorkspace({ org: "default", role: "member" }), false, "默认组织的普通成员也不是");
  // 默认组织的根必须原样是 config.workspace_dir，不能被挪进 tenants/ 里
  eq(org.rootDirOf(org.getOrg("default"), BASE_WS), BASE_WS, "默认组织的根 = 原来的工作目录（老用户的历史不能消失）");


  // ============================================================================
  // 企业设置不是「填个表存下来」，它得真的落到执行层。下面每一条都验两遍：
  // 该拦的拦住（正向），把条件换成该放的必须放行（反向对照）——只验前一半的话，
  // 一个 `return {isError:true}` 的空实现也能全绿。
  // ============================================================================
  console.log("\n【17】企业设置真的落到执行层");

  // ---- 17.1 关掉「允许运行命令行」：两个入口一起关 ----
  const OFF = { allow_shell: false, net_allow: [], net_deny: [] };
  const ON = { allow_shell: true, net_allow: [], net_deny: [] };
  let t = await tools.withPolicy(OFF, () => tools.executeTool("run_shell", { command: "echo wb-probe" }));
  ok(t.isError === true && /允许运行命令行/.test(t.content), "关掉命令行后 run_shell 被拦", t.content);
  t = await tools.withPolicy(OFF, () => tools.executeTool("run_node", { code: "console.log('wb-probe')" }));
  ok(t.isError === true && /允许运行命令行/.test(t.content), "关掉命令行后 run_node 也被拦（换个工具绕不过去）", t.content);
  // 反向对照：开着的时候必须真能跑，不然上面拦住的可能只是「这两个工具本来就坏了」
  t = await tools.withPolicy(ON, () => tools.executeTool("run_shell", { command: "echo wb-probe" }));
  ok(!t.isError && /wb-probe/.test(t.content), "开着的时候 run_shell 真的跑起来了", t.content);
  t = await tools.executeTool("run_node", { code: "console.log('wb-probe')" });
  ok(!t.isError && /wb-probe/.test(t.content), "压根没配组织策略时 run_node 照跑（单机版一字不差）", t.content);

  // ---- 17.2 拦在工具定义层，不只是执行层 ----
  // 留着定义只在执行时拒，等于让模型先想一个用 shell 的方案、调一次、吃一条拒绝、再重想
  const rt = agentMod.createAgentRuntime({
    config: {}, llm: null, mcpManager: { toolDefs: () => [] }, experts: [], expertTeams: [],
  });
  const namesOf = (p) => (p ? tools.withPolicy(p, () => rt.toolList(0, "craft")) : rt.toolList(0, "craft")).map((x) => x.name);
  const openNames = namesOf(null);
  const shutNames = namesOf(OFF);
  ok(openNames.includes("run_shell") && openNames.includes("run_node"), "反向对照：不配策略时两个工具都在", openNames.length);
  ok(!shutNames.includes("run_shell"), "关掉命令行后工具定义里没有 run_shell");
  ok(!shutNames.includes("run_node"), "关掉命令行后工具定义里没有 run_node");
  eq(openNames.length - shutNames.length, 2, "只摘掉这两个，别的工具一个没少");

  // ---- 17.3 网络名单：点边界不能错 ----
  const H = (p, u) => tools.hostAllowed(p, u).ok;
  const wl = { net_allow: ["example.com"], net_deny: [] };
  ok(H(wl, "https://example.com/a"), "白名单：域名本身放行");
  ok(H(wl, "https://a.example.com/a"), "白名单：子域名放行");
  ok(!H(wl, "https://evilexample.com/a"), "白名单：evilexample.com 必须拦（少一个点就是个假白名单）");
  ok(!H(wl, "https://other.com/a"), "白名单：名单外的域名拦住");
  const bl = { net_allow: [], net_deny: ["evil.com"] };
  ok(!H(bl, "https://evil.com/a"), "黑名单：命中拦住");
  ok(!H(bl, "https://sub.evil.com/a"), "黑名单：子域名一起拦");
  ok(H(bl, "https://notevil.com/a"), "黑名单：notevil.com 不该被误伤");
  const both = { net_allow: ["example.com"], net_deny: ["bad.example.com"] };
  ok(!H(both, "https://bad.example.com/x"), "黑名单压过白名单");
  ok(H(both, "https://good.example.com/x"), "反向对照：同一个白名单里没被拉黑的照样放行");
  ok(H({ net_allow: [], net_deny: [] }, "https://anything.com"), "两个名单都空 = 不限（默认组织的默认值）");
  ok(H(wl, "不是个网址"), "不是 URL 就不归这道闸管");

  // 闸真的接在 fetch_url 上（上面验的是纯函数，这里验的是接线）
  t = await tools.withPolicy(bl, () => tools.executeTool("fetch_url", { url: "https://evil.com/x" }));
  ok(t.isError === true && /黑名单/.test(t.content), "fetch_url 被组织黑名单拦下", t.content);
  t = await tools.withPolicy(bl, () => tools.executeTool("render_page", { url: "https://evil.com/x" }));
  ok(t.isError === true && /黑名单/.test(t.content), "render_page 也拦（两个抓网页的入口都得管）", t.content);
  // 反向对照：不在黑名单里的地址，至少不该是「组织网络设置」把它拦的
  //（本机这个测试服务器可能被安全中心的私网规则拦，那是另一道闸，报错文案不一样）
  t = await tools.withPolicy(bl, () => tools.executeTool("fetch_url", { url: `http://127.0.0.1:${server.address().port}/api/files` }));
  ok(!/本组织的网络设置/.test(String(t.content)), "反向对照：没上黑名单的地址不会被组织这道闸拦", String(t.content).slice(0, 80));

  // ---- 17.4 登录有效期：读的时候算，不是发的时候算 ----
  // 这条的意义全在这里：人走了、电脑丢了，管理员把有效期改短，**已经发出去的** cookie 得当场作废
  const usersFile = path.join(process.env.WB_DATA_DIR, "users.json");
  const ageToken = (cookieStr, days) => {
    const tk = String(cookieStr).split("=").slice(1).join("=");
    const db = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    ok(!!db.tokens[tk], "测试自检：找得到这张令牌");
    db.tokens[tk].at = Date.now() - days * 86400 * 1000;
    fs.writeFileSync(usersFile, JSON.stringify(db));
  };
  ageToken(yuan, 3);          // 分公司成员的令牌做旧成 3 天前
  ageToken(boss, 3);          // 总部老板的也做旧，当反向对照
  r = await call("GET", "/api/policy-probe", { cookie: yuan });
  eq(r.status, 200, "默认 90 天：3 天前的令牌还能用");
  r = await call("POST", "/api/admin/org", { cookie: fen, body: { settings: { session_days: 1 } } });
  eq(r.status, 200, "分公司把登录有效期改成 1 天");
  r = await call("GET", "/api/policy-probe", { cookie: yuan });
  eq(r.status, 401, "改短之后，**已经发出去的**令牌当场失效");
  r = await call("GET", "/api/policy-probe", { cookie: boss });
  eq(r.status, 200, "反向对照：总部没改，同样做旧 3 天的令牌照样有效（只影响本组织）");
  r = await call("POST", "/api/admin/org", { cookie: fen, body: { settings: { session_days: 30 } } });
  r = await call("GET", "/api/policy-probe", { cookie: yuan });
  eq(r.status, 200, "再改回 30 天，同一张令牌又活了（说明是读的时候算，不是发的时候烙死的）");

  // ---- 17.5 tenantScope 真的把策略装进了 ALS ----
  // 没有这一步，上面 17.1~17.3 全是「函数会用，但线没接上」
  r = await call("POST", "/api/admin/org", { cookie: fen, body: { settings: { allow_shell: false, net_deny: ["evil.com"] } } });
  eq(r.status, 200, "分公司在后台关掉命令行、拉黑一个域名");
  r = await call("GET", "/api/policy-probe", { cookie: fen });
  ok(r.json.policy && r.json.policy.allow_shell === false, "分公司的请求里，执行层看到的 allow_shell 是 false", r.json.policy);
  ok((((r.json || {}).policy || {}).net_deny || []).includes("evil.com"), "黑名单也一起传到了执行层", r.json.policy);
  r = await call("GET", "/api/policy-probe", { cookie: boss });
  eq(r.json.policy, null, "反向对照：默认组织没配限制，就**不设** store —— 单机版的行为一字不差");
  // 分公司的成员也受同一套策略管（不是只管管理员自己）
  r = await call("POST", "/api/admin/org", { cookie: fen, body: { settings: { session_days: 90 } } });
  r = await call("GET", "/api/policy-probe", { cookie: yuan });
  ok(r.json.policy && r.json.policy.allow_shell === false, "分公司普通成员的请求同样带着策略", r.json.policy);

  console.log("\n【18】命令审批：看得见自己那条、批得动自己那条，「一直允许」轮不到他");
  // 这一段守的是一个会让任务干挂的坑：普通成员点「允许」被 /api/security 那道闸 403 掉，
  // 而他的任务正挂在 requestApproval 上等回答，界面又把错吞了——只能等 120 秒超时按拒绝收场。
  const apMine = security.requestApproval("命令", "rm -rf /tmp/yuan-x", { timeoutMs: 4000, ruleKey: "rm", owner: "xiaoyuan" });
  const apBg = security.requestApproval("命令", "curl http://内部接口/密钥", { timeoutMs: 4000, ruleKey: "curl", owner: "" });
  r = await call("GET", "/api/security/approvals", { cookie: yuan });
  eq(r.status, 200, "普通成员读得到审批列表");
  eq(r.json.items.length, 1, "只看得见自己那条（后台跑的那条不归任何登录用户）");
  eq(r.json.items[0].text, "rm -rf /tmp/yuan-x", "看见的正是自己那条");
  eq(r.json.can_always, false, "界面拿到 can_always=false：「一直允许」那颗按钮不该画出来");
  r = await call("GET", "/api/security/approvals", { cookie: fen });
  eq(r.json.items.length, 0, "同组织的管理员也看不见别人任务里的整条命令");
  r = await call("GET", "/api/security/approvals", { cookie: boss });
  eq(r.json.items.length, 2, "反向对照：平台管理员两条都看得见（含后台跑的那条）");
  eq(r.json.can_always, true, "平台管理员才有「一直允许」");

  const mineId = (await call("GET", "/api/security/approvals", { cookie: yuan })).json.items[0].id;
  const bgId = (await call("GET", "/api/security/approvals", { cookie: boss })).json.items.find((a) => a.ruleKey === "curl").id;
  r = await call("POST", "/api/security/approvals/" + bgId, { cookie: yuan, body: { allow: true, scope: "once" } });
  eq(r.status, 403, "批别人的那条：403，而且是「这条不是你的」，不是「服务器级设置」");
  ok(/别人的任务/.test((r.json || {}).error || ""), "错误里说清楚了原因", r.json);
  r = await call("POST", "/api/security/mode", { cookie: yuan, body: { mode: "full" } });
  eq(r.status, 403, "负控制：/api/security 底下别的写操作照样拦（放行的只有 approvals/<id> 这一条）");

  r = await call("POST", "/api/security/approvals/" + mineId, { cookie: yuan, body: { allow: true, scope: "always" } });
  eq(r.status, 200, "批自己那条：真放行了（这就是原来会 403 把任务挂死的那一下）");
  eq(r.json.downgraded, true, "他点的是「一直允许」，降成了「本次运行期间」");
  eq(r.json.scope, "session", "落地的档位是 session，不是 always");
  eq(await apMine, true, "挂在那儿的任务真的拿到了「允许」，不是等超时");
  eq(security.listSessionAllow().includes("rm"), true, "session 档确实写进了本次运行期间的记忆");
  eq(security.listApprovals().length, 1, "批完就从待办里消失了");

  // 反向对照：同一颗「一直允许」，平台管理员点就是真的 always
  const apBoss = security.requestApproval("命令", "rm -rf /tmp/boss-x", { timeoutMs: 4000, ruleKey: "rmboss", owner: "laoban" });
  const bossId = security.listApprovals().find((a) => a.ruleKey === "rmboss").id;
  r = await call("POST", "/api/security/approvals/" + bossId, { cookie: boss, body: { allow: true, scope: "always" } });
  eq(r.json.downgraded, false, "反向对照：平台管理员点「一直允许」不降档");
  eq(r.json.scope, "always", "反向对照：落地的就是 always");
  await apBoss;
  await call("POST", "/api/security/approvals/" + bgId, { cookie: boss, body: { allow: false, scope: "once" } });
  await apBg;
  security.clearSessionAllow();

  console.log("\n【19】长期记忆：记的是他的事，他就得看得见、加得了、删得掉自己那几条");
  // 上面那四条是替身（server.js 起不了独立进程，这套测试从第一天起就是照抄形状）。
  // 替身跟真源码走散了，这一整段就变成「测我自己写的假路由」——所以先钉住真源码里那几句。
  const SERVER_SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  for (const [frag, why] of [
    ["memory.remove(req.params.id, memScope(req))", "删的时候真把作用域传下去了"],
    ["shared: wantShared && !downgraded", "勾了共享但没这权限时，真的没往共享区写"],
    ["can_share: scopeTo === undefined", "GET 真的把能力位回给了界面"],
  ]) ok(SERVER_SRC.includes(frag), "真源码对得上替身：" + why, frag);
  // agent 的 remember 工具替普通成员记了一条，作用域是他的登录名
  memory.add({ text: "小袁的周报只要三段", user: "xiaoyuan", source: "auto" });
  memory.add({ text: "老板记的私事", user: "laoban", source: "auto" });
  memory.add({ text: "全公司统一用飞书日历", user: "laoban", shared: true, source: "user" });
  r = await call("GET", "/api/memory", { cookie: yuan });
  eq(r.status, 200, "普通成员打得开记忆页（以前撞 /api/memory 平台前缀，403 一片空白）");
  let texts = (r.json.items || []).map((x) => x.text);
  ok(texts.includes("小袁的周报只要三段"), "看得见 agent 替他记的那条", texts);
  ok(texts.includes("全公司统一用飞书日历"), "看得见共享区那条（本来就进他的提示词）", texts);
  ok(!texts.includes("老板记的私事"), "看不见别人那条", texts);
  eq(r.json.can_share, false, "拿到 can_share=false：「给所有账号共用」那个勾选框不该画出来");
  eq(r.json.can_edit_manual, false, "拿到 can_edit_manual=false：背景说明那颗保存按钮不该画出来");
  r = await call("GET", "/api/memory", { cookie: boss });
  eq(r.json.can_share, true, "反向对照：平台管理员两个都是 true");
  ok((r.json.items || []).map((x) => x.text).includes("老板记的私事"), "反向对照：平台管理员看得见自己那条");

  // 写：只往自己那格写；勾了「共享」照实降档，不许悄悄换作用域还报「已记住」
  r = await call("POST", "/api/memory/item", { cookie: yuan, body: { text: "小袁手动加的一条" } });
  eq(r.status, 200, "普通成员加得了自己的一条（以前 403）");
  eq(memory.list("xiaoyuan").find((x) => x.text === "小袁手动加的一条").scope, "xiaoyuan", "落在他自己的作用域，不是共享区");
  r = await call("POST", "/api/memory/item", { cookie: yuan, body: { text: "小袁想广播的一条", shared: true } });
  eq(r.status, 200, "他勾了「所有账号共用」：不 403（403 会让他一头雾水）");
  eq(r.json.downgraded, true, "而是照实告诉他降成了自己的");
  ok(/平台管理员/.test(r.json.note || ""), "话说清楚了：共享要平台管理员来加", r.json.note);
  eq(memory.list("xiaoyuan").find((x) => x.text === "小袁想广播的一条").scope, "xiaoyuan", "真的没进共享区");
  r = await call("POST", "/api/memory/item", { cookie: boss, body: { text: "老板广播的一条", shared: true } });
  eq(r.json.downgraded, false, "反向对照：平台管理员勾共享就是真共享");
  eq(memory.list("laoban").find((x) => x.text === "老板广播的一条").scope, memory.SHARED, "反向对照：真进了共享区");

  // 删：只删得掉自己那格的
  const yuanItem = memory.list("xiaoyuan").find((x) => x.text === "小袁手动加的一条");
  const bossItem = memory.list("laoban").find((x) => x.text === "老板记的私事");
  const sharedItem = memory.list("laoban").find((x) => x.text === "全公司统一用飞书日历");
  r = await call("DELETE", "/api/memory/item/" + bossItem.id, { cookie: yuan });
  eq(r.status, 403, "删别人那条：403（以前一个 id 递进来就删，谁的都删）");
  ok(memory.list("laoban").some((x) => x.id === bossItem.id), "别人那条还在");
  r = await call("DELETE", "/api/memory/item/" + sharedItem.id, { cookie: yuan });
  eq(r.status, 403, "删共享区那条：403（那条进的是所有人的提示词）");
  ok(memory.list("laoban").some((x) => x.id === sharedItem.id), "共享那条还在");
  r = await call("DELETE", "/api/memory/item/" + yuanItem.id, { cookie: yuan });
  eq(r.status, 200, "删自己那条：删得掉");
  eq(r.json.removed, 1, "removed 是个数字 1（不是把 {removed:1} 整个塞进 removed 字段）");
  ok(!memory.list("xiaoyuan").some((x) => x.id === yuanItem.id), "真的没了");
  r = await call("DELETE", "/api/memory/item/" + yuanItem.id, { cookie: yuan });
  eq(r.status, 200, "再删一次：不是 403（本来就没有 ≠ 越权，那是别处已经删过的正常竞态）");
  eq(r.json.removed, 0, "removed=0");
  r = await call("DELETE", "/api/memory/item/" + sharedItem.id, { cookie: boss });
  eq(r.status, 200, "反向对照：平台管理员删得掉共享区那条");

  // 负控制：放行的只有这几条精确路径，/api/memory 底下别的照样归平台管理员
  eq((await call("POST", "/api/memory", { cookie: yuan, body: { content: "改全局背景说明" } })).status, 403,
     "负控制：同一个路径 POST（改全局背景说明）照样 403 —— 闸是按方法认的，开 GET 没把 POST 一起放出去");
  eq(memory.manual(), "", "全局背景说明纹丝不动");
  eq((await call("GET", "/api/memory/export", { cookie: yuan })).status, 403,
     "负控制：导出整库（含别人的记忆）照样 403");
  eq((await call("POST", "/api/memory", { cookie: boss, body: { content: "老板写的背景" } })).status, 200,
     "反向对照：平台管理员改得动背景说明");
  eq(memory.manual(), "老板写的背景", "反向对照：真写进去了");

  console.log("\n【20】设置页：会 403 的控件，后端得先说清楚「这颗别画」");
  // 用户原话：「切换失败怎么还切换失败了啊」。前端不可能自己猜谁是平台管理员——
  // 得后端在每个能力位上回一个布尔。这三处（/api/settings 的 platform_owner、
  // /api/security/modes 的 can_switch）就是界面挑控件的唯一依据。
  const SRC20 = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  for (const [frag, why] of [
    ["const isPlatformOwner = (req) =>", "真源码里有这个能力位助手"],
    ["platform_owner: isPlatformOwner(req)", "/api/settings 回了 platform_owner"],
    ["can_switch: isPlatformOwner(req)", "/api/security/modes 回了 can_switch"],
  ]) ok(SRC20.includes(frag), "真源码对得上替身：" + why, frag);
  const FE = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
  ok(/PLATFORM_ONLY_CATS = new Set\(\["search", "evolve", "data", "im"\]\)/.test(FE),
    "界面真按这四页过滤（纯服务器级的标签页不画给成员）");
  // 「保存失败」四个字把服务端说的原因（如「这块归平台管理员管」）整个盖掉，是同一个病的另一半：
  // 控件画出来了、点了、后端也把原因说了，界面偏偏不转述。
  for (const [file, why] of [["public/js/app-03.js", "开箱向导"], ["public/js/app-05.js", "设置页"]]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    ok(!/textContent = "保存失败"/.test(src), why + "：存不下时把服务端说的原因转述出来，不用四个字盖掉", file);
  }
  r = await call("GET", "/api/settings-probe", { cookie: yuan });
  eq(r.json.platform_owner, false, "普通成员拿到 platform_owner=false");
  r = await call("GET", "/api/settings-probe", { cookie: fen });
  eq(r.json.platform_owner, false, "分公司的管理员也不是平台管理员（他管的是自己那个组织）");
  r = await call("GET", "/api/settings-probe", { cookie: boss });
  eq(r.json.platform_owner, true, "反向对照：平台管理员拿到 true");
  r = await call("GET", "/api/security/modes", { cookie: yuan });
  eq(r.status, 200, "档位列表成员读得到（他得知道 agent 动手前问不问他）");
  eq(r.json.can_switch, false, "但拿到 can_switch=false：那个 🛡️ 菜单不该画成能点的");
  r = await call("GET", "/api/security/modes", { cookie: boss });
  eq(r.json.can_switch, true, "反向对照：平台管理员 can_switch=true");
  r = await call("POST", "/api/security/mode", { cookie: yuan, body: { mode: "full" } });
  eq(r.status, 403, "闸没松：can_switch 只是给界面看的，后端照样拦得住直接打过来的请求");

  console.log("\n【21】资料库：拦读拦了个寂寞——同样的字节走 agent 拿得到，走界面反而 403");
  // 原来 /api/library 整个前缀（含 GET）都在平台管理员的表里。可资料库是**一份全局目录**
  // （tools.js 的 LIB_DIR / NOTES_FILE），每个人的 agent 都带着 library_list / library_read，
  // 一句「翻一下资料库」就把文件清单、灵感笔记、乃至正文原样念出来。拦住 HTTP GET 什么都没保住，
  // 只保住了一句瞎话：页面对普通成员写「还没有参考资料」。所以读放行、写照拦。
  r = await call("GET", "/api/library", { cookie: yuan });
  eq(r.status, 200, "普通成员读得到资料库（他的 agent 本来就读得到，界面没有理由更严）");
  ok(Array.isArray(r.json.files) && r.json.files.length > 0, "而且真拿到了内容，不是一个空壳", JSON.stringify(r.json).slice(0, 80));
  r = await call("POST", "/api/library/upload", { cookie: yuan, body: { name: "x.md", data_b64: "eA==" } });
  eq(r.status, 403, "但往这份全局目录里放东西，还是平台管理员的事");
  r = await call("POST", "/api/library/note", { cookie: yuan, body: { text: "灵感" } });
  eq(r.status, 403, "灵感笔记也是全局共用的一份，成员写不了");
  r = await call("DELETE", "/api/library/file/x.md", { cookie: yuan });
  eq(r.status, 403, "删别人传的资料更不行");
  r = await call("DELETE", "/api/library/note/n1", { cookie: yuan });
  eq(r.status, 403, "删笔记同理");
  r = await call("GET", "/api/library", { cookie: fen });
  eq(r.status, 200, "分公司的管理员一样读得到（他不是平台管理员，但读本来就不该拦）");
  r = await call("POST", "/api/library/upload", { cookie: fen, body: {} });
  eq(r.status, 403, "分公司的管理员照样写不了这份全局目录");
  r = await call("GET", "/api/library", { cookie: boss });
  eq(r.status, 200, "反向对照：平台管理员读得到");
  r = await call("POST", "/api/library/upload", { cookie: boss, body: {} });
  eq(r.status, 200, "反向对照：平台管理员写得进");
  r = await call("GET", "/api/schedules", { cookie: yuan });
  eq(r.status, 403, "负向对照：定时任务照旧拦着（花的是这台服务器的额度，没有「读无害」这一说）");
  r = await call("GET", "/api/eval", { cookie: yuan });
  eq(r.status, 403, "负向对照：评测也照旧拦着（一跑就是真金白银调模型）");
  // 别让这条判断退回去：读表里不许再出现 /api/library，写表里必须还在
  const ADM = fs.readFileSync(path.join(ROOT, "admin.js"), "utf8");
  const readTbl = (ADM.match(/const PLATFORM_READ = \[([\s\S]*?)\];/) || [])[1] || "";
  const writeTbl = (ADM.match(/const PLATFORM_WRITE = \[([\s\S]*?)\];/) || [])[1] || "";
  ok(readTbl.length > 0 && writeTbl.length > 0, "admin.js 里的两张平台表都读得出来（改名了就该在这儿挂）");
  ok(!readTbl.includes("/api/library"), "读表里没有 /api/library（拦它拦了个寂寞）");
  ok(writeTbl.includes("/api/library"), "写表里还有 /api/library（上传/删除/记笔记照拦）");
  ok(readTbl.includes("/api/schedules") && readTbl.includes("/api/eval"), "读表里还留着真该拦的那两个");
  // 为什么拦读没意义：资料库压根不是按人分的
  const TL = fs.readFileSync(path.join(ROOT, "tools.js"), "utf8");
  ok(/LIB_DIR = dataPath\("data", "library"\)/.test(TL), "资料库确实是一份全局目录，不按用户分（这就是拦读没意义的原因）");
  ok(/name: "library_read"/.test(TL) && /name: "library_list"/.test(TL), "而每个人的 agent 都带着 library_list / library_read 这两个工具");

  console.log("\n【13】大小写绕闸：Express 路由默认不认大小写，两道门禁却按原样 req.path 查表");
  // 这一段是照着真复现写的：改掉一个字母，/API/settings 命中处理器、不命中门禁表。
  // 这里故意不给这个小测试应用开 case sensitive routing，为的就是把「门禁自己认不认大小写」
  // 单独拎出来测——服务器那边还压着一道 app.set("case sensitive routing", true)，在下面单独钉。
  r = await call("POST", "/API/settings", { body: { search: { provider: "bing" } } });
  ok(r.status !== 200, "没登录发 POST /API/settings，不许放行（大写前缀曾经判成「不用登录」）", r.status);
  eq(r.status, 401, "而且回的是 401，跟小写那条一个待遇");
  r = await call("POST", "/api/settings", { body: { search: { provider: "bing" } } });
  eq(r.status, 401, "反向对照：小写那条本来就该 401");
  r = await call("GET", "/API/files", {});
  eq(r.status, 401, "换个接口也一样：大写的 /API/files 没登录进不去");
  r = await call("GET", "/IM/log", {});
  eq(r.status, 401, "/im/ 那条线同理：大写也得判成要登录（不然直接落到路由，压根没进这道闸）");

  console.log("\n【14】大小写绕闸（第二道）：登录了，但普通成员用大写绕平台写表");
  const platformPatch = { search: { provider: "bing" } }; // 不是个人项，改的是整台服务器
  r = await call("POST", "/api/settings", { cookie: yuan, body: platformPatch });
  eq(r.status, 403, "基线：小写发全局设置，成员是 403");
  r = await call("POST", "/api/Settings", { cookie: yuan, body: platformPatch });
  eq(r.status, 403, "改一个字母也得是 403（曾经这条是 200，整张写表绕过去了）");
  r = await call("POST", "/API/SETTINGS", { cookie: yuan, body: platformPatch });
  eq(r.status, 403, "全大写同理");
  r = await call("GET", "/API/schedules", { cookie: yuan });
  eq(r.status, 403, "读表也一样：大写的定时任务照拦");
  r = await call("POST", "/api/Settings", { cookie: boss, body: platformPatch });
  eq(r.status, 200, "反向对照：平台管理员发大写的照样过（拦的是权限，不是大小写本身）");
  // 个人项的那条放行不能因为小写化而失灵
  r = await call("POST", "/api/Settings", { cookie: yuan, body: { agent: { engine: "claude" } } });
  eq(r.status, 200, "反向对照：成员改自己那几项（底层引擎），大写路径也得放行");

  console.log("\n【15】大小写绕闸（第三道）：脱敏也得认小写");
  r = await call("GET", "/API/settings", { cookie: yuan });
  eq(r.status, 200, "成员读得到设置");
  eq(r.json.search.jina_key, "", "大写路径下 Jina Key 照样抹掉（redactGuard 曾经只认小写 /api/admin 前缀）");
  eq(r.json.im.feishu.app_secret, "", "飞书 App Secret 同理");
  r = await call("GET", "/api/settings", { cookie: yuan });
  eq(r.json.models[0].api_key, "", "反向对照：小写那条本来就抹");
  r = await call("GET", "/API/settings", { cookie: boss });
  eq(r.json.search.jina_key, "REAL-JINA-KEY", "反向对照：平台管理员读得到真值，没被误伤");
  // 脱敏那条靠 /api/admin 前缀给后台自己的接口放行。认原样路径的话，后台一走大写路径，
  // 返回里的 Key 字段会被当成「给普通成员看的」抹成空——页面上一片空白，配置里其实有值，
  // 比报个错还难查。直接叫函数来验，不经过路由，改一个 toLowerCase 就得挂。
  const fenUser = { username: "fenboss", org: org2, role: "admin" };
  ok(!admin.ownsGlobalWorkspace(fenUser), "先确认这个身份不是平台管理员（不然下面两条都自动过）");
  const throughRedact = (reqPath) => {
    let out;
    const req = { method: "GET", path: reqPath, user: fenUser };
    const res = { json: (b) => { out = b; } };
    admin.redactGuard(req, res, () => {});
    res.json({ api_key: "REAL" });
    return out;
  };
  eq(throughRedact("/API/admin/orgs").api_key, "REAL", "后台走大写路径，返回里的 Key 不许被抹空");
  eq(throughRedact("/api/admin/orgs").api_key, "REAL", "反向对照：小写的后台路径本来就不抹");
  eq(throughRedact("/API/settings").api_key, "", "反向对照：非后台的接口，大写小写都照抹");

  console.log("\n【16】在服务器桌面上起进程的两条，归平台管理员");
  r = await call("POST", "/api/files/open/report.pdf", { cookie: yuan });
  eq(r.status, 403, "成员点「用系统默认程序打开」，拉不起服务端的进程");
  r = await call("POST", "/api/files/reveal", { cookie: yuan, body: { name: "report.pdf" } });
  eq(r.status, 403, "「在访达里显示」同理");
  r = await call("POST", "/API/files/OPEN/report.pdf", { cookie: yuan });
  eq(r.status, 403, "换大小写也绕不过去");
  r = await call("POST", "/api/files/open/report.pdf", { cookie: fen });
  eq(r.status, 403, "分公司的管理员也不行（进程起在总部那台机器上）");
  r = await call("POST", "/api/files/open/report.pdf", { cookie: boss });
  eq(r.status, 200, "反向对照：平台管理员能打开");
  r = await call("GET", "/api/files", { cookie: yuan });
  eq(r.status, 200, "反向对照：列自己的成果文件没被顺带拦住（拦的是 open/reveal，不是整条 /api/files）");
  ok(writeTbl.includes("/api/files/open"), "写表里有 /api/files/open");
  ok(writeTbl.includes("/api/files/reveal"), "写表里有 /api/files/reveal");
  ok(!readTbl.includes("/api/files"), "读表里没有 /api/files（看自己的文件不该拦）");

  console.log("\n【17】服务器那边的几处，钉住别退回去");
  const SRV = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  ok(/app\.set\("case sensitive routing", true\)/.test(SRV),
     "server.js 开了 case sensitive routing（门禁小写化之外的第二道，两道都得在）");
  const owFn = (SRV.match(/function openWithSystem\([\s\S]*?\n\}/) || [""])[0];
  ok(owFn.includes("execFile"), "openWithSystem 用 execFile");
  ok(!/\bexec\(/.test(owFn),
     "openWithSystem 里没有 exec(：exec 会把整串丢给 /bin/sh，文件名里一个引号就能执行任意命令", owFn.slice(0, 120));
  const upFn = (SRV.match(/app\.post\("\/api\/upload"[\s\S]*?\n\}\);/) || [""])[0];
  ok(upFn.includes("sessionAllowed"),
     "/api/upload 查会话归属（不查就是「知道一个会话 id 就能往别人文件夹里写」）");
  ok(upFn.includes("path.basename"), "/api/upload 对文件名做了 basename");
  const modeFn = (SRV.match(/app\.post\("\/api\/security\/mode"[\s\S]*?\n\}\);/) || [""])[0];
  ok(/if \(!isPlatformOwner\(req\)\)/.test(modeFn),
     "/api/security/mode 自己也守一道（全站审批开关，不能只靠一张前缀表）");
  ok(/const previewServers = new Map\(\)/.test(SRV),
     "预览服务器按目录分开存（原来是一个全局变量，第二个租户一开就把第一个的端口顶掉）");
  ok(/wbpv=/.test(SRV) && /st\.token/.test(SRV),
     "预览站点带令牌（原来起在 0.0.0.0 上，同网段谁都能翻）");

  console.log("\n【20】新手向导：他走不完的那一程，就别把他放进去");
  r = await call("GET", "/api/onboarding", { cookie: yuan });
  eq(r.status, 200, "成员读得到体检表（读没被拦）");
  eq(r.json.can_finish, false, "但界面被明确告知：这一程他走不完");
  r = await call("POST", "/api/onboarding/done", { cookie: yuan });
  eq(r.status, 403, "反证：真放他走到最后一步，「开始使用」就是 403");
  r = await call("GET", "/api/onboarding", { cookie: fen });
  eq(r.json.can_finish, false, "分公司管理员也走不完（写的是整台服务器那一份）");
  r = await call("GET", "/api/onboarding", { cookie: boss });
  eq(r.json.can_finish, true, "反向对照：平台管理员 can_finish = true");
  r = await call("POST", "/api/onboarding/done", { cookie: boss });
  eq(r.status, 200, "反向对照：他点得动「开始使用」");
  ok(writeTbl.includes("/api/onboarding"), "写表里有 /api/onboarding（能力位不是凭空加的，闸门确实在拦）");
  const onbFn = (SRV.match(/app\.get\("\/api\/onboarding"[\s\S]*?\n\}\);/) || [""])[0];
  ok(/can_finish: isPlatformOwner\(req\)/.test(onbFn),
     "server.js 的 GET /api/onboarding 真把 can_finish 回出去了（替身对了真源没对，等于没测）");

  console.log("\n【23】助理页：一台服务器一份上下文 = 所有人共用一个脑子");
  // 助理页是有登录的，可登录之后的每一步都当没登录过：会话键写死 "local_assist"（全服务器一段上下文，
  // A 问完 B 接着问，接的是 A 的话头），/im/log 是 (_req, res) 把整本日志倒出去（谁都读得到别人说的话），
  // 跑任务不带 user（成员的任务顶着管理员的身份跑，记忆串到别人那儿、审批卡弹在别人屏幕上）。
  // 这一节挂的是**真的 im.js 路由 + 真的 im-store**，只把 runtime 换成能拦住的替身。
  const imSessions = createImSessionStore({ dir: path.join(TMP, "im-sessions") });
  const seen = [];
  const hooks = { onStart: null, hold: null };
  const fakeRuntime = {
    runTask: async (args) => {
      seen.push(args);
      if (args.emit) args.emit({ type: "tool_use", name: "read_file", purpose: "翻资料" });
      if (hooks.onStart) hooks.onStart();
      if (hooks.hold) await hooks.hold;
      return { finalText: "跑完了" };
    },
  };
  app.use(createImRouter({ config: { im: {} }, runtime: fakeRuntime, sessions: imSessions, outputFiles: () => [], saveConfig: () => {} }).router);

  r = await call("POST", "/im/local", { cookie: yuan, body: { message: "成员说的话" } });
  eq(r.status, 200, "成员在助理页发得出消息（这页本来就该人人能用）");
  r = await call("POST", "/im/local", { cookie: boss, body: { message: "老板的悄悄话" } });
  eq(r.status, 200, "老板也发得出");
  let imKeys = imSessions.keys();
  eq(imKeys.length, 2, "两个人两段上下文（以前是一段，谁来都接在同一个话头上）", imKeys);
  ok(!imKeys.includes("local_assist"), "全服务器共用的那个 local_assist 不在了", imKeys);

  r = await call("GET", "/im/log", { cookie: yuan });
  let feed = JSON.stringify(r.json);
  ok(/成员说的话/.test(feed), "成员看得到自己说过的话");
  ok(!/老板的悄悄话/.test(feed), "但看不到别人的——以前这里是整本日志原样倒出去", feed.slice(0, 120));
  r = await call("GET", "/im/log", { cookie: boss });
  feed = JSON.stringify(r.json);
  ok(/老板的悄悄话/.test(feed), "老板看得到自己的");
  ok(!/成员说的话/.test(feed), "平台管理员也不去读成员的私人对话（管得着服务器，管不着人家说什么）", feed.slice(0, 120));
  r = await call("GET", "/im/log", { cookie: fen });
  feed = JSON.stringify(r.json);
  ok(!/成员说的话|老板的悄悄话/.test(feed), "分公司管理员两边都读不到", feed.slice(0, 120));

  // 跑任务用谁的身份：这半边在 im.js（真路由已经把 user 递进来了），另半边在 server.js 的
  // accountedRuntime（它得把这个 user 透传下去而不是一律改写成管理员），两边各钉一处
  const byMsg = (m) => seen.find((a) => (a.history || []).some((h) => h.content === m)) || {};
  eq(byMsg("成员说的话").user, "xiaoyuan", "成员发的任务顶着成员自己的身份跑（记忆是他的、审批弹给他）");
  eq(byMsg("老板的悄悄话").user, "laoban", "反向对照：老板发的顶着老板");

  let release;
  hooks.hold = new Promise((res2) => (release = res2));
  const startedP = new Promise((res2) => (hooks.onStart = res2));
  const running = call("POST", "/im/local", { cookie: yuan, body: { message: "慢慢查" } });
  await startedP;
  r = await call("GET", "/im/progress", { cookie: yuan });
  ok(r.json && r.json.local_assist && /翻资料/.test(r.json.local_assist.text),
     "本人看得到自己的进度（回出去的键固定叫 local_assist，前端不用认哈希）", JSON.stringify(r.json));
  r = await call("GET", "/im/progress", { cookie: fen });
  ok(r.json && !r.json.local_assist, "旁人看不到他在跑什么", JSON.stringify(r.json));
  r = await call("GET", "/im/progress", { cookie: boss });
  ok(r.json && !r.json.local_assist, "平台管理员也看不到（他该看的是飞书/QQ 那些服务器级通道）", JSON.stringify(r.json));
  release();
  await running;
  hooks.hold = null;
  hooks.onStart = null;

  r = await call("GET", "/im/sessions", { cookie: yuan });
  eq(r.json.count, 1, "成员数得着的只有自己那一段");
  r = await call("GET", "/im/sessions", { cookie: boss });
  eq(r.json.count, 2, "反向对照：平台管理员数得着全部");
  r = await call("POST", "/im/sessions/clear", { cookie: yuan });
  eq(r.json.cleared, 1, "成员点「清空上下文」只清掉自己那一段");
  imKeys = imSessions.keys();
  eq(imKeys.length, 1, "老板那段还在——以前这一下把整个目录端了", imKeys);
  r = await call("POST", "/im/sessions/clear", { cookie: boss });
  eq(r.json.cleared, 1, "反向对照：平台管理员清的是全部");
  eq(imSessions.keys().length, 0, "清完一段不剩");

  const IMSRC = fs.readFileSync(path.join(ROOT, "im.js"), "utf8");
  ok(/const sessionKey = localKeyOf\(req\.user\);/.test(IMSRC), "im.js 的 /im/local 真按人算会话键");
  ok(!/const sessionKey = "local_assist"/.test(IMSRC), "那行写死的 local_assist 已经不在了");
  ok(/router\.get\("\/im\/log", \(req, res\)/.test(IMSRC), "/im/log 真收下了 req（那个 _req 下划线就是病根）");
  ok(/const \{ modelName, user: caller, \.\.\.rest \} = args \|\| \{\};/.test(SRV),
     "server.js 把 user 从 rest 里摘出来单独判了（留在 rest 里的话，一个 undefined 就把兜底覆盖掉）");
  ok(/user: caller \|\| \(owner \? owner\.username : undefined\)/.test(SRV),
     "accountedRuntime 透传调用方身份，没登录态（飞书/定时任务）才退回管理员");
  ok(/account\.chargeRun\(owner,/.test(SRV),
     "钱还是记在管理员头上：「记谁的账」和「用谁的记忆」是两件事，别一起改");

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
