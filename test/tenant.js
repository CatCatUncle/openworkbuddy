"use strict";
/**
 * 多租户 + 企业管理后台的端到端测试。
 *
 * 跑法：node test/tenant.js
 * 用临时 OPENWORKBUDDY_DATA_DIR 和临时工作目录，绝不碰真账号、真成果文件。
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tenant-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

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
// 一颗明明能点的按钮，点了只回四个字。
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
// 一条什么都不做的接口。量「进门费」用：每一条请求在干正事之前，都要先走一遍
// 登录闸 + 租户作用域，跟它自己要干什么没有半点关系。见【20】。
app.get("/api/nothing", (_req, res) => res.json({ ok: true }));

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
  eq(r.json.user.role, "owner", "第一个账号是超级管理员（开服的人 = 这台机器的主人）");
  eq(r.json.user.owner, true, "owner 这一格跟着角色走，老代码和回退版本还认它");
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
  // 分公司的第一个管理员级别的人 = 这个组织的超管。以前 owner 只给全站第一个人，
  // 分公司一个超管都没有，于是那儿的管理员可以互相停用——「管理员权限太大」最狠的一处
  eq(r.json.user.role, "owner", "分公司第一个管理员就是分公司的超级管理员");

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

  console.log("\n【5.5】红线一的另一半：列表里看不见，照着名字取还是取得到");
  // 【5】拦的是「列文件」，这一节拦的是「按相对路径取文件」——成果卡片上记的本来就是相对路径
  // （任务_0905_xx/报告.html）。rootedPath 在当前根下找不到时，会去 knownRoots() 里挨个试，
  // 而那张表是**整台机器**的：config.projects、所有还开着的会话的 root、历史上见过的根，
  // 跟「谁在请求」没有半点关系。于是分公司的人只要知道总部那份文件叫什么（文件名会出现在
  // 转发的截图、聊天记录、日报标题里），照着请求一次，兜底扫描就替他把文件翻出来了：
  // 列表里一个字都看不见，下载却是 200。
  // 这一节把 server.js 里的 tenantRootOf + rootedPath 原样切出来跑。外部依赖里
  // safePath / safePathIn / withWorkspace 用 tools.js 的真货（跟线上同一套越界判定），
  // 只有 knownRoots 这张「整台机器的根」和两条线索（?root= 指纹、?sid= 会话）摆成最坏情况。
  const SRC5 = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const cutA = SRC5.indexOf("/**\n * 租户的成果根");
  const cutB = SRC5.indexOf('\napp.get("/api/files/download/*"');
  ok(cutA > 0 && cutB > cutA, "从 server.js 里切得出这两个函数（切不出来 = 改名了 = 这一节在空转，别让它悄悄变绿）", { cutA, cutB });
  const slice5 = SRC5.slice(cutA, cutB);
  eq((slice5.match(/safePathIn\(/g) || []).length, 1,
     "整段里只有一处 safePathIn：候选根全从 tryRoot 这一个口子过（多出一处就是一条绕开租户过滤的新路）");
  // 最坏情况的 knownRoots：总部的根、分公司的根、分公司自己的一个子项目根、外加一个换过的目录
  const SUB2 = path.join(root2, "子项目");
  fs.mkdirSync(SUB2, { recursive: true });
  fs.writeFileSync(path.join(SUB2, "上个月的稿子.md"), "old");
  const OTHER = path.join(TMP, "换过的目录");
  fs.mkdirSync(OTHER, { recursive: true });
  const allRoots = [BASE_WS, root2, SUB2, OTHER];
  const hqKey = tools.workspaceKeyOf(BASE_WS);
  const RP = new Function(
    "org", "path", "fs", "getDefaultWorkspaceDir", "safePath", "safePathIn",
    "rootFromKey", "getSession", "sessionAllowed", "knownRoots",
    slice5 + "\nreturn { tenantRootOf, rootedPath };")(
    org, path, fs, tools.getDefaultWorkspaceDir, tools.safePath, tools.safePathIn,
    // ?root= 指纹：照 server.js 的真算法反查，不是瞎给一个根
    (k) => allRoots.find((d) => tools.workspaceKeyOf(d) === String(k || "")) || "",
    // ?sid= 会话：归属检查故意放到最松（永远 allowed）。这是在验第二道闸——
    // 就算哪天 sessionAllowed 判漏了，租户过滤也得把这条线索挡在外面
    (sid) => (sid ? { id: sid, root: BASE_WS } : null),
    () => true,
    () => allRoots.slice(),
  );
  const uFen = { username: "fenboss", org: org2 };
  const uBoss = { username: "laoban", org: "default" };
  // 先看「租户根」本身算得对不对：只有真分了租户的才有值
  eq(RP.tenantRootOf({ user: uFen }), path.resolve(root2), "分公司的人算出来的租户根 = 分公司的根");
  eq(RP.tenantRootOf({ user: uBoss }), "", "默认组织没有租户根（个人版就是这一档，一字不差地走老路）");
  eq(RP.tenantRootOf({}), "", "没有登录态（飞书回调、定时任务）也没有租户根，不至于把自动任务全锁死");
  // 正戏。ask() 这一层照抄 admin.tenantScope 干的事：按请求人的组织把工作目录换过去
  const ask = (user, rel, q) =>
    tools.withWorkspace(org.rootDirOf(org.getOrg(org.orgIdOf(user)), BASE_WS), () =>
      RP.rootedPath({ user, query: q || {}, body: {} }, rel));
  const outside = (p) => !path.resolve(p).startsWith(path.resolve(BASE_WS) + path.sep);
  let got = ask(uFen, "总部机密.md");
  ok(outside(got) && !fs.existsSync(got), "光凭文件名要不到总部的文件（兜底扫描不认租户外的根）", got);
  got = ask(uFen, "总部机密.md", { root: hqKey });
  ok(outside(got) && !fs.existsSync(got), "把总部那个根的指纹抄进 ?root= 也要不到（线索是用户给的，根得服务端认）", got);
  got = ask(uFen, "总部机密.md", { sid: "s-hq-1" });
  ok(outside(got) && !fs.existsSync(got), "?sid= 也要不到（会话归属是第一道闸，这里故意只留第二道，它得自己扛得住）", got);
  // 反向对照一：租户**内部**的跨根反查一点没坏——这才是 rootedPath 活着的全部理由
  got = ask(uFen, "上个月的稿子.md");
  eq(got, path.join(SUB2, "上个月的稿子.md"), "反向对照：分公司自己子项目里的旧文件，照样按相对路径找得回来");
  ok(fs.existsSync(got), "而且是真找着了文件，不是拼了条路径就返回", got);
  // 反向对照二：个人版换过工作目录，旧对话里的相对路径还得指得回老根
  got = tools.withWorkspace(OTHER, () => RP.rootedPath({ user: null, query: {}, body: {} }, "总部机密.md"));
  eq(got, path.join(BASE_WS, "总部机密.md"), "反向对照：个人版（无登录态）切了工作目录，旧路径照样反查得到");

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
  eq(ownerName && ownerName.username, "fenboss", "分公司也有自己的超管，不再是一片无主之地");

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

  console.log("\n【15.5】账本查得到：时间范围 / 关键词 / 翻页，且不许越过组织墙");
  // 这三样以前一样都没有，界面只能给「最近 200 条」。财务问「上个月谁花了多少」答不上来。
  // 造够两页的量，才测得出 offset/limit 是真翻页还是每次都从头切。
  for (let i = 0; i < 120; i++) {
    account.chargeRun({ username: "xiaoyuan" },
      { prompt: 100, completion: 50, model: i % 2 ? "mA" : "mB", provider: "p", source: i % 3 ? "web" : "feishu", elapsed_ms: 100 });
  }
  r = await call("GET", "/api/admin/usage?limit=50&offset=0", { cookie: fen });
  const p1 = r.json;
  ok(p1.total > 100, "total 报的是**符合筛选的全部条数**，不是这一页的条数", p1.total);
  eq(p1.detail.length, 50, "一页就是 50 条");
  r = await call("GET", "/api/admin/usage?limit=50&offset=50", { cookie: fen });
  const p2 = r.json;
  eq(p2.detail.length, 50, "第二页也满 50 条");
  eq(p2.offset, 50, "offset 原样回给前端（翻页条要拿它算「第几条」）");
  ok(p1.detail[0].ts !== p2.detail[0].ts || JSON.stringify(p1.detail) !== JSON.stringify(p2.detail),
     "第二页不是第一页的复制品（offset 真的生效了，不是每次都从头 slice）");
  const ids = new Set([...p1.detail, ...p2.detail].map((e) => JSON.stringify([e.ts, e.model, e.prompt, e.user])));
  ok(ids.size >= 60, "两页之间没有大面积重叠", ids.size);

  // 关键词
  r = await call("GET", "/api/admin/usage?limit=500&q=mA", { cookie: fen });
  ok(r.json.total > 0 && r.json.detail.every((e) => /mA/i.test(e.model || "")), "搜关键词只回命中的", r.json.total);
  const onlyMA = r.json.total;
  r = await call("GET", "/api/admin/usage?limit=500&q=" + encodeURIComponent("绝对搜不到的词"), { cookie: fen });
  eq(r.json.total, 0, "反向对照：搜一个不存在的词，一条都不回");

  // 时间范围
  // 必须按**本地**日期算：账本里记的是 localDay()，而 toISOString() 给的是 UTC。
  // 东八区凌晨那几个小时两者差一天，照 UTC 去筛「今天」会一条都筛不出来。
  const d = (n) => { const t = new Date(Date.now() - n * 86400000);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
  r = await call("GET", `/api/admin/usage?limit=500&from=${d(0)}&to=${d(0)}`, { cookie: fen });
  ok(r.json.total > 0, "「今天」查得到（这批账都是刚记的）", r.json.total);
  r = await call("GET", `/api/admin/usage?limit=500&from=${d(90)}&to=${d(60)}`, { cookie: fen });
  eq(r.json.total, 0, "两三个月前那段是空的");
  // range 聚合要跟着筛选走，不然界面上「合计」跟列表对不上，比没有还坏
  r = await call("GET", "/api/admin/usage?limit=500&q=mA", { cookie: fen });
  ok(r.json.range && r.json.range.runs === onlyMA, "合计只统计筛选命中的那些（不是永远算全量）",
     { range: r.json.range && r.json.range.runs, total: onlyMA });
  ok(r.json.by_model.every((x) => /mA/i.test(x.key)), "按模型分组也跟着筛选走", r.json.by_model.map((x) => x.key));

  // 组织墙：筛选不是绕过隔离的后门
  r = await call("GET", "/api/admin/usage?limit=500&q=laoban", { cookie: fen });
  ok(r.json.detail.every((e) => e.user !== "laoban"), "分公司拿关键词搜总部的人，一条也搜不出来",
     r.json.detail.map((e) => e.user).slice(0, 5));

  // 审计同一套
  r = await call("GET", "/api/admin/audit?limit=5&offset=0", { cookie: fen });
  const a1 = r.json;
  ok(a1.total > 5, "审计的 total 也是全量条数", a1.total);
  eq(a1.audit.length, 5, "审计一页 5 条");
  ok(Array.isArray(a1.actors) && a1.actors.length > 0, "回了操作人清单（筛选下拉要用）", a1.actors);
  ok(Array.isArray(a1.actions) && a1.actions.includes("添加成员"), "回了动作清单", a1.actions);
  r = await call("GET", "/api/admin/audit?limit=500&action=" + encodeURIComponent("添加成员"), { cookie: fen });
  ok(r.json.total > 0 && r.json.audit.every((x) => x.action === "添加成员"), "按动作筛只回这个动作", r.json.total);
  ok(r.json.actions.length > 1, "筛过之后动作下拉的选项还是全的（不然选完就选不回去了）", r.json.actions);
  r = await call("GET", `/api/admin/audit?limit=500&from=${d(90)}&to=${d(60)}`, { cookie: fen });
  eq(r.json.total, 0, "审计按老日期筛也是空的");
  // 分公司确实搜得到 laoban——因为组织就是他开的，这三条（创建组织 / 生成邀请码 / 改席位）
  // 本来就属于这个组织的账。组织墙要盯的不是「别出现总部管理员的名字」，
  // 而是「别混进别的组织的记录」。
  r = await call("GET", "/api/admin/audit?limit=500&q=" + encodeURIComponent("laoban"), { cookie: fen });
  ok(r.json.audit.length > 0 && r.json.audit.every((x) => x.org === org2),
     "关键词搜出来的每一条都还在本组织里（筛选不是绕过隔离的后门）", r.json.audit.length);
  const hqAudit = (await call("GET", "/api/admin/audit?limit=500", { cookie: boss })).json.audit;
  const fenAudit = (await call("GET", "/api/admin/audit?limit=500", { cookie: fen })).json.audit;
  const fenTs = new Set(fenAudit.map((x) => x.ts));
  ok(hqAudit.some((x) => !fenTs.has(x.ts)), "反向对照：总部有分公司看不到的记录，两边不是同一本账",
     { hq: hqAudit.length, fen: fenAudit.length });

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
  let t = await tools.withPolicy(OFF, () => tools.executeTool("run_shell", { command: "echo owb-probe" }));
  ok(t.isError === true && /允许运行命令行/.test(t.content), "关掉命令行后 run_shell 被拦", t.content);
  t = await tools.withPolicy(OFF, () => tools.executeTool("run_node", { code: "console.log('owb-probe')" }));
  ok(t.isError === true && /允许运行命令行/.test(t.content), "关掉命令行后 run_node 也被拦（换个工具绕不过去）", t.content);
  // 反向对照：开着的时候必须真能跑，不然上面拦住的可能只是「这两个工具本来就坏了」
  t = await tools.withPolicy(ON, () => tools.executeTool("run_shell", { command: "echo owb-probe" }));
  ok(!t.isError && /owb-probe/.test(t.content), "开着的时候 run_shell 真的跑起来了", t.content);
  t = await tools.executeTool("run_node", { code: "console.log('owb-probe')" });
  ok(!t.isError && /owb-probe/.test(t.content), "压根没配组织策略时 run_node 照跑（单机版一字不差）", t.content);

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
  // （本机这个测试服务器可能被安全中心的私网规则拦，那是另一道闸，报错文案不一样）
  t = await tools.withPolicy(bl, () => tools.executeTool("fetch_url", { url: `http://127.0.0.1:${server.address().port}/api/files` }));
  ok(!/本组织的网络设置/.test(String(t.content)), "反向对照：没上黑名单的地址不会被组织这道闸拦", String(t.content).slice(0, 80));

  // ---- 17.4 登录有效期：读的时候算，不是发的时候算 ----
  // 这条的意义全在这里：人走了、电脑丢了，管理员把有效期改短，**已经发出去的** cookie 得当场作废
  const usersFile = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "users.json");
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
  // 前端不可能自己猜谁是平台管理员——
  // 得后端在每个能力位上回一个布尔。这三处（/api/settings 的 platform_owner、
  // /api/security/modes 的 can_switch）就是界面挑控件的唯一依据。
  const SRC20 = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  for (const [frag, why] of [
    ["const isPlatformOwner = (req) =>", "真源码里有这个能力位助手"],
    ["platform_owner: isPlatformOwner(req)", "/api/settings 回了 platform_owner"],
    ["can_switch: isPlatformOwner(req)", "/api/security/modes 回了 can_switch"],
  ]) ok(SRC20.includes(frag), "真源码对得上替身：" + why, frag);
  const FE = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
  ok(/PLATFORM_ONLY_CATS = new Set\(\["search", "evolve", "trace", "ops", "data", "im"\]\)/.test(FE),
    "界面真按这六页过滤（纯服务器级的标签页不画给成员；执行追踪那页装着私钥和一个能往外发请求的探针，运行状况那页的日志里是全公司的任务描述）");
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

  console.log("\n【22】大小写绕闸：Express 路由默认不认大小写，两道门禁却按原样 req.path 查表");
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

  console.log("\n【23】大小写绕闸（第二道）：登录了，但普通成员用大写绕平台写表");
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

  console.log("\n【24】大小写绕闸（第三道）：脱敏也得认小写");
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

  console.log("\n【25】在服务器桌面上起进程的两条，归平台管理员");
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

  console.log("\n【26】服务器那边的几处，钉住别退回去");
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
  ok(/openworkbuddy_preview=/.test(SRV) && /st\.token/.test(SRV),
     "预览站点带令牌（原来起在 0.0.0.0 上，同网段谁都能翻）");
  ok(!/\bwbpv\b/.test(SRV),
     "预览 cookie 又叫回 wbpv 了：对外露脸的名字里不留这两个字母（浏览器 devtools 里看得见）");

  console.log("\n【27】新手向导：他走不完的那一程，就别把他放进去");
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

  // 说清楚这一节在测什么，免得标题被当成现状读：
  // 桌面版是一台机器一个人，助理模式连的就是本机，上下文本来就该只有一份——这里不动它。
  // 会话键按**账号**算（local_<keyOf(username)>），跟设备无关，所以手机用同一个账号连回来，
  // 接着看到的就是桌面上那段对话。这一节盯的是另一头：VPS 上一个进程多人用，
  // 以前那行写死 local_assist，谁登录都接在同一个话头上，/im/log 还把整本日志倒给任何人。
  console.log("\n【28】助理页：多人共用一个实例时，一人一段上下文（以前是全服务器一段）");
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


  // ============================================================================
  // 审计流水的保管。2026-09-20 之前这一段是坏的，而且坏得很安静：
  // 全部组织的审计条目挤在 orgs.json 里同一个数组，存盘时 slice(0, 1000)。
  // 于是 A 个忙组织正常运营一阵，B 个安静组织的合规记录会被**整个挤掉**，
  // 界面上显示「0 条」——跟「这个组织从来没人动过」长得一模一样。
  // 下面每条都带反向对照：光验「我的还在」是不够的，还得验「别人的没被我挤掉」。
  // ============================================================================
  console.log("\n【18】审计流水：邻居挤不掉你的记录，存满了要说出来");
  {
    const quiet = org.createOrg({ name: "安静公司" }).id;
    const busy = org.createOrg({ name: "忙碌公司" }).id;
    for (let i = 0; i < 20; i++) org.audit({ org: quiet, actor: "安静管理员", action: "改额度", target: "员工" + i });
    // 建组织本身也记一条，所以是 20 + 1。别写死 20——写死的话这条断言测的是
    // 「createOrg 记不记账」，不是「记录留不留得住」
    const before = org.listAudit(quiet, { limit: 100 }).total;
    eq(before, 21, "安静公司先记下 20 条改动 + 建组织那一条");

    // 忙碌公司写到**超过**封顶。老实现在这里会把安静公司的 20 条全挤没
    const CAP = org._internals.AUDIT_CAP;
    for (let i = 0; i < CAP + 200; i++) org.audit({ org: busy, actor: "忙碌管理员", action: "放行命令", target: "任务" + i });

    eq(org.listAudit(quiet, { limit: 100 }).total, before,
       "★邻居写爆了，安静公司那些记录一条不少★ 这是多租户审计的底线");
    const b = org.listAudit(busy, { limit: 10 });
    ok(b.total >= CAP, "忙碌公司自己也留够了封顶那么多", { total: b.total, cap: CAP });
    ok(b.total <= CAP + 256, "但也没无限长：超了要真裁掉最老的", { total: b.total, cap: CAP });
    // 裁掉的必须是**最老的**那批。只验条数和「最新的在最前」是不够的：
    // 把「留最新 CAP 条」改成「留最老 CAP 条」，那两条断言照样全绿，
    // 而实际效果是新记录一条都留不住——审计表永远停在开服那几天
    // 这里不能用 listAudit 取全集：它的 limit 被夹在 1000（后端不该为一个请求把整本读进内存）。
    // 传 CAP+500 只会拿回最新 1000 条，看不见最老的那头——
    // 而「裁掉的是最老的还是最新的」这件事，恰恰只有最老的那头能证明
    const all = org._internals.readAudit(busy);
    eq(org.listAudit(busy, { limit: CAP + 500 }).audit.length, 1000,
       "反向对照：listAudit 的 limit 确实被夹在 1000，所以上面必须绕开它读文件");
    const nums = all.map((x) => Number(String(x.target).replace("任务", ""))).filter((n) => !isNaN(n));
    ok(nums.length > 0, "取到了忙碌公司的编号", nums.length);
    eq(Math.max(...nums), CAP + 199, "★留下的里头有最后写的那条★");
    ok(Math.min(...nums) > 0,
       "★被裁掉的是最老的那头，不是最新的★ 留最老那批的话这里会是 0", { 最小: Math.min(...nums), 最大: Math.max(...nums) });

    // 反向对照：两边真的是两本账，不是同一本被筛出来的
    const qActors = new Set(org.listAudit(quiet, { limit: 100 }).audit.map((x) => x.actor));
    ok(!qActors.has("忙碌管理员"), "反向对照：安静公司那本里没有邻居的操作人", [...qActors]);
    ok(org.listAudit(busy, { limit: 5 }).audit.every((x) => x.org === busy), "忙碌公司那本里每条都是自己的");

    // 最新的要在最前。文件是往后追加的，读回来必须反过来——顺序错了，
    // 界面第一屏给的是一年前的事，而看这张表的人正是靠第一屏下判断的
    const newest = org.listAudit(busy, { limit: 1 }).audit[0];
    eq(newest.target, "任务" + (CAP + 199), "★最新一条排在最前★ 不是最老那条");

    // 存满了得说出来。0 是「没记过」不是「没发生」——
    // 合规的人搜不到，看见的必须是「超出保留条数」，不能是一片空白
    const cap = org.listAudit(busy, { limit: 5 });
    eq(cap.capped, true, "★到顶了要把 capped 报上去★ 界面靠它提示「更早的已被挤掉」");
    eq(cap.cap, CAP, "封顶数也报上去，提示里要写清楚是多少条");
    ok(cap.since && /^\d{4}-\d{2}-\d{2}T/.test(cap.since), "现存最早一条的时间报上去了", cap.since);
    // 反向对照：没存满的组织不许瞎报
    const q2 = org.listAudit(quiet, { limit: 5 });
    eq(q2.capped, false, "反向对照：安静公司没存满，不许报 capped");
    eq(q2.kept, before, "kept 是真实留下的条数");

    // 组织 id 落成文件名。这个值一路从 user.org 带过来，
    // 万一哪天能被外面写进来，`../` 就能把审计写到数据目录外面去
    // 判据只能是「规范化之后还在不在 audit 目录里」。
    // 不能写成 !file.includes("..")——path.join 早把 `../` 算掉了，字符串里本来就不剩 `..`，
    // 那条断言永远是绿的，而文件已经写到 /tmp/etc 去了（这一条就是这么被变异测试抓出来的）
    for (const bad of ["../../../etc/passwd", "..", "a/b", "o_x\u0000", "/absolute"]) {
      const file = org._internals.auditFile(bad);
      const inside = path.resolve(file).startsWith(path.resolve(org._internals.AUDIT_DIR) + path.sep);
      ok(inside, "★怪 id 不许把审计写出 audit 目录：" + JSON.stringify(bad) + "★", file);
    }
    // 反向对照：正常 id 照常落在该落的地方，别把闸门修成谁都进不去
    ok(path.basename(org._internals.auditFile(quiet)) === quiet + ".jsonl",
       "反向对照：正常组织 id 原样当文件名", org._internals.auditFile(quiet));

    // 审计里是「谁放行了哪条命令」，跟 users.json 一个待遇
    const mode = fs.statSync(org._internals.auditFile(quiet)).mode & 0o777;
    eq(mode, 0o600, "审计文件 0600：同机器上别的账号读不到");

    // orgs.json 不该再背着审计——getOrg() 有 37 处调用，每次都要把它整个 parse 一遍。
    // 实测一次 getOrg()：审计 0 条 0.02ms，1000 条 0.91ms，50000 条 45.57ms。
    // 当年封顶只能定在 1000，就是被这条逼的；挤掉邻居记录和拖慢每个请求是同一个病
    const rawOrgs = JSON.parse(fs.readFileSync(org._internals.ORGS_FILE, "utf8"));
    ok(!("audit" in rawOrgs), "★orgs.json 里不许再有 audit 字段★ 它在热路径上，审计不该收这个税");
    ok(rawOrgs.orgs.length >= 2 && Array.isArray(rawOrgs.invites), "反向对照：组织和邀请码还在这本里，没被一起搬走");
  }

  console.log("\n【18.1】老装机搬家：orgs.json 里那本合用的要原样搬出来，一条不丢");
  {
    // 单独开一个数据目录，摆成升级前的样子，再用子进程去读——
    // 搬家是一次性的，在当前进程里已经跑过了，必须换个进程才试得到
    const OLD = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mig-"));
    const OLDD = path.join(OLD, "data");
    fs.mkdirSync(OLDD, { recursive: true });
    fs.writeFileSync(path.join(OLDD, "orgs.json"), JSON.stringify({
      orgs: [{ id: "default", name: "默认" }, { id: "o_laoke", name: "老客户" }],
      depts: [], invites: [{ code: "ABC", org: "default" }],
      audit: [ // 老格式：新的在前
        { ts: "2026-09-19T10:00:00.000Z", org: "o_laoke", actor: "老客户管理员", action: "改额度", target: "张三", detail: "" },
        { ts: "2026-09-18T10:00:00.000Z", org: "default", actor: "老王", action: "放行命令", target: "rm -rf build", detail: "" },
        { ts: "2026-09-17T10:00:00.000Z", org: "default", actor: "老王", action: "添加成员", target: "李四", detail: "" },
      ],
    }, null, 2));
    const probe = `
      process.env.OPENWORKBUDDY_DATA_DIR = ${JSON.stringify(OLDD)};
      const org = require(${JSON.stringify(path.join(ROOT, "org"))});
      const fs = require("fs");
      const a = org.listAudit("default", { limit: 50 });
      const b = org.listAudit("o_laoke", { limit: 50 });
      const raw = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(OLDD, "orgs.json"))}, "utf8"));
      // 同一个进程里再调一次是白调的——ensureMigrated 有进程内闸门。
      // 幂等性得换个进程重跑才试得到，所以在下面单独起第二个子进程
      const again = org.listAudit("default", { limit: 50 }).total;
      console.log(JSON.stringify({
        def: a.total, defNewest: a.audit[0] && a.audit[0].target,
        lao: b.total, laoNewest: b.audit[0] && b.audit[0].target,
        stillHasAudit: "audit" in raw, orgs: raw.orgs.length, invites: raw.invites.length,
        again,
      }));
    `;
    const out = require("child_process").spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    let m = null;
    try { m = JSON.parse(String(out.stdout).trim().split("\n").pop()); } catch {}
    ok(m, "搬家探针跑起来了", (out.stderr || "").slice(0, 300));
    if (m) {
      eq(m.def, 2, "★default 那两条搬过来了★");
      eq(m.lao, 1, "★老客户那一条也搬过来了，没跟 default 混在一起★");
      eq(m.defNewest, "rm -rf build", "顺序没搬反：最新的还是最新的（文件里是往后追加，读回来要反过来）");
      eq(m.laoNewest, "张三", "老客户那本的最新一条也对");
      eq(m.stillHasAudit, false, "搬完 orgs.json 里的 audit 字段清掉了，不会搬第二次");
      eq(m.orgs, 2, "反向对照：组织没被搬家弄丢");
      eq(m.invites, 1, "反向对照：邀请码也没丢");
      eq(m.again, 2, "★重复触发不会把同一批再写一遍★ 搬家是幂等的");
    }

    // 第二个进程，冲着同一份数据再跑一遍搬家。写重了这里就会翻倍
    const out2 = require("child_process").spawnSync(process.execPath, ["-e", probe], { encoding: "utf8" });
    let m2 = null;
    try { m2 = JSON.parse(String(out2.stdout).trim().split("\n").pop()); } catch {}
    ok(m2, "第二趟搬家探针也跑起来了", (out2.stderr || "").slice(0, 300));
    if (m2) {
      eq(m2.def, 2, "★换个进程重跑，default 还是 2 条★ 搬家是幂等的，不是每次都追加一遍");
      eq(m2.lao, 1, "老客户那本也没翻倍");
    }

    // 闸门的顺序：老装机上如果**先发生一次写**（管理员点了个按钮），
    // 新记录会先落到新文件；这时候才触发搬家的话，老记录会被追加到新记录**后面**，
    // 文件里是新的在后，于是界面把一年前的事显示成刚刚发生
    const OLD2 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mig2-"));
    const OLDD2 = path.join(OLD2, "data");
    fs.mkdirSync(OLDD2, { recursive: true });
    // 重新摆一份升级前的样子，别去捡上面那份的 .bak——那是搬家自己留的，
    // 拿它当输入等于让被测的东西自己准备考题
    fs.writeFileSync(path.join(OLDD2, "orgs.json"), JSON.stringify({
      orgs: [{ id: "default", name: "默认" }], depts: [], invites: [],
      audit: [
        { ts: "2026-09-18T10:00:00.000Z", org: "default", actor: "老王", action: "放行命令", target: "rm -rf build", detail: "" },
        { ts: "2026-09-17T10:00:00.000Z", org: "default", actor: "老王", action: "添加成员", target: "李四", detail: "" },
      ],
    }, null, 2));
    const probe2 = `
      process.env.OPENWORKBUDDY_DATA_DIR = ${JSON.stringify(OLDD2)};
      const org = require(${JSON.stringify(path.join(ROOT, "org"))});
      org.audit({ org: "default", actor: "刚升级的管理员", action: "改额度", target: "王五" });
      const a = org.listAudit("default", { limit: 50 });
      console.log(JSON.stringify({ total: a.total, newest: a.audit[0] && a.audit[0].target }));
    `;
    const out3 = require("child_process").spawnSync(process.execPath, ["-e", probe2], { encoding: "utf8" });
    let m3 = null;
    try { m3 = JSON.parse(String(out3.stdout).trim().split("\n").pop()); } catch {}
    ok(m3, "先写后搬的探针跑起来了", (out3.stderr || "").slice(0, 300));
    if (m3) {
      eq(m3.total, 3, "老的 2 条 + 刚写的 1 条，一条不多一条不少");
      eq(m3.newest, "王五", "★刚写的那条排在最前★ 搬家排在写之后的话，这里会是一年前那条");
    }
    // 搬一半崩了的样子：jsonl 已经写出去了，orgs.json 还没改。
    // 下次启动会照着 audit 字段再搬一遍——这一趟必须是覆盖，不是追加。
    // 上面那个「换个进程重跑」试不出这条：那时 audit 字段已经删干净，搬家直接掉头就走
    const OLD3 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mig3-"));
    const OLDD3 = path.join(OLD3, "data");
    fs.mkdirSync(path.join(OLDD3, "audit"), { recursive: true });
    const twoRows = [
      { ts: "2026-09-18T10:00:00.000Z", org: "default", actor: "老王", action: "放行命令", target: "rm -rf build", detail: "" },
      { ts: "2026-09-17T10:00:00.000Z", org: "default", actor: "老王", action: "添加成员", target: "李四", detail: "" },
    ];
    fs.writeFileSync(path.join(OLDD3, "orgs.json"), JSON.stringify({
      orgs: [{ id: "default", name: "默认" }], depts: [], invites: [], audit: twoRows,
    }, null, 2));
    // 上一趟的产物：文件里是新的在后，所以倒过来写
    fs.writeFileSync(path.join(OLDD3, "audit", "default.jsonl"),
      twoRows.slice().reverse().map((r) => JSON.stringify(r)).join("\n") + "\n");
    const probe3 = `
      process.env.OPENWORKBUDDY_DATA_DIR = ${JSON.stringify(OLDD3)};
      const org = require(${JSON.stringify(path.join(ROOT, "org"))});
      const a = org.listAudit("default", { limit: 50 });
      console.log(JSON.stringify({ total: a.total }));
    `;
    const out4 = require("child_process").spawnSync(process.execPath, ["-e", probe3], { encoding: "utf8" });
    let m4 = null;
    try { m4 = JSON.parse(String(out4.stdout).trim().split("\n").pop()); } catch {}
    ok(m4, "搬一半崩了的探针跑起来了", (out4.stderr || "").slice(0, 300));
    if (m4) eq(m4.total, 2, "★搬一半崩过，重来一趟还是 2 条★ 追加式的话这里会是 4，审计表里每件事凭空变两遍");
    fs.rmSync(OLD3, { recursive: true, force: true });
    fs.rmSync(OLD2, { recursive: true, force: true });
    fs.rmSync(OLD, { recursive: true, force: true });
  }

  // ============================================================================
  // 成员列表的开销不许跟「平台上开了几家公司」挂钩。
  // publicUser 每个人身上要算三格（月额度 / 本月剩余 / 余额），2026-09-20 之前
  // 这三格各自去 org.getOrg() 读一遍 orgs.json——一个人三遍，而 orgs.json 里装的是
  // 平台上**所有**公司的数据。实测 50 个人的成员页：平台上 2 家公司 5.6ms，
  // 501 家 365.6ms。慢的不是你自己的数据，是隔壁又来了几家。
  // 判据用「读了几遍」不用「花了几毫秒」：毫秒在慢机器上会飘，次数不会。
  // ============================================================================
  console.log("\n【19】成员列表：隔壁开几家公司，不该拖慢你的后台");
  {
    const N19 = 120;
    const nb19 = org.createOrg({ name: "隔壁十九号" }).id;
    org.updateOrg(nb19, { settings: { member_monthly_credits: 777 } }, "平台");
    const my19 = org.createOrg({ name: "本家十九号" }).id;
    org.updateOrg(my19, { settings: { member_monthly_credits: 42 } }, "平台");

    const st19 = account._internals.loadUsers();
    const mk19 = (name, o) => ({ username: name, org: o, role: "member", status: "active",
      created_at: new Date(Date.now() - 1000).toISOString(), pass: "x".repeat(60), salt: "y".repeat(32), credits: 0 });
    for (let i = 0; i < N19; i++) st19.users.push(mk19("m19_" + i, my19));
    st19.users.push(mk19("nb19_0", nb19));
    account._internals.saveUsers(st19);

    // 数 orgs.json 被读了几遍。这条 bug 真正的形状是「次数跟人数成正比」
    const ORGS19 = org._internals.ORGS_FILE;
    let reads19 = 0;
    const rawRead19 = fs.readFileSync;
    fs.readFileSync = function (f, ...rest) { if (String(f) === ORGS19) reads19++; return rawRead19.call(fs, f, ...rest); };
    let list19;
    try { list19 = account.listMembers(my19); } finally { fs.readFileSync = rawRead19; }

    eq(list19.length, N19, "这家的人都列出来了");
    ok(reads19 <= 2, "★列 " + N19 + " 个人，orgs.json 最多读两遍★ 每人各读各的话，这里会是 " + N19 * 3 + " 遍",
       { 读了: reads19, 人数: N19 });

    // 反向对照一：省下来的是读取，不是判断——设置必须还是**这个人自己组织**的那份
    eq(list19[0].monthly_quota, 42, "本家的人按本家的月额度算");
    eq(account.listMembers(nb19)[0].monthly_quota, 777, "★隔壁的人按隔壁的月额度算★ 把一份设置套到所有人头上的话，这里会是 42");

    // 反向对照二：单独给某个人设过的额度，仍然盖得过组织默认值
    const st19b = account._internals.loadUsers();
    st19b.users.find((u) => u.username === "m19_0").monthly_quota = 999;
    account._internals.saveUsers(st19b);
    const again19 = account.listMembers(my19);
    eq(again19.find((m) => m.username === "m19_0").monthly_quota, 999, "反向对照：单独设过额度的人，还是按他自己那份算");
    eq(again19.find((m) => m.username === "m19_1").monthly_quota, 42, "反向对照：同一趟里没单独设过的人照旧按组织默认值");

    // 反向对照三：单个用户的场合没有现成设置可传，publicUser 得自己去读，不能读出个空
    eq(account.publicUser({ username: "m19_1", org: my19, role: "member" }).monthly_quota, 42,
       "反向对照：不传设置时 publicUser 自己去读，读出来还是这家的 42");

    // 把这一段造的人清掉，免得影响后面按人数算的断言
    const st19c = account._internals.loadUsers();
    st19c.users = st19c.users.filter((u) => !/^(m19_|nb19_)/.test(u.username));
    account._internals.saveUsers(st19c);
  }

  console.log("\n【20】进门费：每条请求在干正事之前，先把整个平台的账本翻几遍");
  {
    // 这一段量的不是某一页，是**每一条**请求都要先走的那段路：
    // 认人 → 判登录有效期 → 强制二次验证 → 远程设备开关 → 租户作用域。
    // 它翻的两本账装的是整个平台的账号、所有还活着的登录令牌和全部公司表——
    // 跟「这条请求要干什么」一点关系都没有。所以平台上多开几家公司、多几百人在线，
    // 不该让任何一条请求变慢；而聊天页是几秒一次轮询的，慢下来是整个产品一起慢。
    // 判据用「翻了几遍」不用「花了几毫秒」：毫秒在慢机器上会飘，次数不会。
    const USERS20 = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "users.json");
    const ORGS20 = org._internals.ORGS_FILE;
    const countReads = async (fn) => {
      const c = { users: 0, orgs: 0 };
      const raw = fs.readFileSync;
      fs.readFileSync = function (f, ...rest) {
        const s = String(f);
        if (s === USERS20) c.users++;
        else if (s === ORGS20) c.orgs++;
        return raw.call(fs, f, ...rest);
      };
      try { c.res = await fn(); } finally { fs.readFileSync = raw; }
      return c;
    };

    const c20 = await countReads(() => call("GET", "/api/nothing", { cookie: yuan }));
    eq(c20.res.status, 200, "测试自检：这条什么都不做的接口本身是通的");
    ok(c20.users >= 1 && c20.orgs >= 1, "测试自检：这两本账确实在认人这段被翻过（数得着，不是数了个 0）", c20);
    ok(c20.users <= 1, "★一条请求，users.json 只翻一遍★ 以前是三遍：认人、判令牌类型、记活跃",
       { 读了: c20.users });
    ok(c20.orgs <= 1, "★一条请求，orgs.json 只翻一遍★ 以前是四遍：判有效期、强制二次验证、远程开关、租户作用域",
       { 读了: c20.orgs });

    // ---- 20.1 记活跃的 5 分钟节流：省的不能只是写，读也得省下 ----
    const tk20 = String(yuan).split("=").slice(1).join("=");
    const readUsers20 = () => JSON.parse(fs.readFileSync(USERS20, "utf8"));
    const poke20 = (mut) => { const db = readUsers20(); mut(db); fs.writeFileSync(USERS20, JSON.stringify(db)); };
    const seenOf20 = () => (readUsers20().tokens[tk20] || {}).seen || 0;

    // 一分钟前露过面：还在 5 分钟窗口里。不写成「就是现在」是因为——万一没被节流住，
    // 它会重写成 Date.now()，两个值可能落在同一毫秒上，这条断言就变成了空断言
    poke20((db) => { db.tokens[tk20].seen = Date.now() - 60 * 1000; });
    const seen20 = seenOf20();
    await call("GET", "/api/nothing", { cookie: yuan });
    eq(seenOf20(), seen20, "5 分钟内再来一条，不重写「最后活跃」（一次任务几十条轮询，写一次就够）");

    poke20((db) => { db.tokens[tk20].seen = Date.now() - 6 * 60 * 1000; });
    await call("GET", "/api/nothing", { cookie: yuan });
    ok(seenOf20() > Date.now() - 60000, "反向对照：超过 5 分钟没露面的，这一趟就得把「最后活跃」补上",
       { seen: seenOf20() });

    // ---- 20.2 真要写的时候得重新读一遍：别拿请求开头那份盖回去 ----
    // 故意在「请求开头读账本」之后插一笔别处的改动。省掉这次重读的话，
    // 记一下最后活跃时间这件小事，会顺手把中间别人写的东西抹掉。
    poke20((db) => {
      db.tokens[tk20].seen = Date.now() - 6 * 60 * 1000;
      db.users.find((u) => u.username === "xiaoyuan").credits = 1;
    });
    let poked20 = false;
    const raw20 = fs.readFileSync;
    fs.readFileSync = function (f, ...rest) {
      const out = raw20.call(fs, f, ...rest);
      if (!poked20 && String(f) === USERS20) {
        poked20 = true;
        const db = JSON.parse(raw20.call(fs, USERS20, "utf8"));
        db.users.find((u) => u.username === "xiaoyuan").credits = 4242;
        fs.writeFileSync(USERS20, JSON.stringify(db));
      }
      return out;
    };
    try { await call("GET", "/api/nothing", { cookie: yuan }); } finally { fs.readFileSync = raw20; }
    ok(poked20, "测试自检：那一笔确实插在了「请求开头读账本」之后");
    eq((readUsers20().users.find((u) => u.username === "xiaoyuan") || {}).credits, 4242,
       "★记活跃要写之前重新读一遍★ 拿请求开头那份盖回去的话，别处刚写的这一笔就没了");
    ok(seenOf20() > Date.now() - 60000,
       "反向对照：该记的「最后活跃」也照样记上了（不是靠干脆不写来保住上面那一笔）", { seen: seenOf20() });

    // ---- 20.3 挂不上的时候，租户作用域得自己去读 ----
    // 登录闸把解析好的组织挂在请求上，tenantScope 优先用它。但这条路上不一定有人登录
    // （单机桌面版就没有），少了那一挂不能把租户作用域一起丢了。
    const mw20 = admin.tenantScope({ withWorkspace: tools.withWorkspace, withPolicy: tools.withPolicy, getWorkspaceDir: tools.getWorkspaceDir });
    const uYuan20 = account._internals.loadUsers().users.find((u) => u.username === "xiaoyuan");
    await new Promise((done) => {
      mw20({ user: uYuan20, headers: {}, path: "/x" }, {}, () => {
        eq(tools.getWorkspaceDir(), root2, "★请求上没挂组织时，tenantScope 自己去读，照样落在分公司的目录★");
        ok((tools.orgPolicy() || {}).allow_shell === false,
           "这时候那份组织设置也照样生效（不是只把目录找对了）", tools.orgPolicy());
        done();
      });
    });
  }

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
