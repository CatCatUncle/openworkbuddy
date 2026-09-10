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
const agentMod = require(path.join(ROOT, "agent"));

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
// 探针：这条请求里 tools.orgPolicy() 看到的是什么。用来验「设置真的进了执行层」，
// 而不是只躺在 org.json 里没人读——那种开关比没有这个开关更糟
app.get("/api/policy-probe", (_req, res) => res.json({ policy: tools.orgPolicy(), ws: tools.getWorkspaceDir() }));

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
  r = await call("POST", "/api/engines/test", { cookie: fen, body: {} });
  eq(r.status, 403, "分公司管理员测引擎被拒");
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
