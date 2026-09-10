"use strict";
/**
 * 企业管理后台的接口层（/api/admin/*）。
 *
 * 权限分两档，别混：
 *   - adminGuard：能进后台（管理员 + 审计员）。所有 GET 走这一档。
 *   - adminOnly ：能改东西（只有管理员）。所有写操作走这一档。
 *   审计员这个角色存在的意义就是「能查账但改不动」——合规、外包、财务对账都需要这么一个人。
 *
 * 还有一档更高的：**平台管理员** = 默认组织的管理员。全站级的东西（新建组织、改别的组织的
 * 套餐席位）只有他能动。分公司的管理员在自己组织里权力再大，也不该能给自己加席位。
 */

const express = require("express");
const account = require("./account");
const org = require("./org");
const prefs = require("./prefs"); // 哪些设置算「个人的」，那张表在这儿

function platformAdmin(user) {
  return account.isAdmin(user) && org.orgIdOf(user) === org.DEFAULT_ORG;
}
function platformOnly(req, res, next) {
  if (!platformAdmin(req.user)) return res.status(403).json({ error: "只有平台管理员（默认组织的管理员）能做这个操作" });
  next();
}
/** 统一的 try/catch：管理后台的每个写接口都长一样，错了就 400 + 原话 */
function guarded(fn) {
  return (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: e.message });
    }
  };
}

/**
 * 租户边界划在**工作目录**上，不划在整台机器上。这句话得先说清楚，不然「支持多租户」就是句空话：
 *
 *   真隔离的：成果文件、会话、账号、席位、用量账本、权限、审计。
 *   不隔离的：引擎与密钥、MCP、技能、专家、记忆库、素材库、定时任务、备份、安全审批、桌面窗口——
 *             这些配的是**这台服务器**，归平台管理员（默认组织的管理员）。
 *
 * 下面两张表就是照着这条线画的：配服务器的接口，写操作一律拦；内容本身就属于别人的那几个连读都不给。
 * 单组织部署（绝大多数人）走的还是原来那条路——所有人都在默认组织里，一行行为都没变。
 */
const PLATFORM_WRITE = [
  "/api/settings", "/api/onboarding", "/api/engines", "/api/mcp", "/api/security",
  "/api/app/", "/api/projects", "/api/workspace/", "/api/schedules", "/api/backup",
  "/api/plugins", "/api/experts", "/api/expert-teams", "/api/evolve", "/api/eval",
  "/api/feishu", "/api/pick-folder", "/api/open-workspace", "/api/cache/",
  "/api/skills", "/api/memory", "/api/library",
];
const PLATFORM_READ = [
  "/api/schedules", "/api/backup", "/api/security/audit", "/api/memory",
  "/api/library", "/api/evolve", "/api/eval", "/api/feishu",
];
/**
 * 上面那张写表按前缀拦，这几条是被顺带拦住的例外——它们只花调用者自己的钱、只改他自己那份：
 *   /api/engines/test  真跑一句话，走的是他本机那份 CLI 订阅，一个字节都不落盘
 *                      （路由那边会把非平台管理员传来的 bin 丢掉：「起哪个可执行文件」不是个人偏好）
 *   /api/assist/model  助理页用哪个模型，写进他自己的偏好文件
 * 放进白名单而不是把 /api/engines 整条从写表里拿掉：切换引擎的默认值、改可执行文件路径
 * 那些仍然该归平台管理员。
 */
const PERSONAL_WRITE = new Set([
  "/api/engines/test",
  "/api/assist/model",
  // 长期记忆的条目区是**按账号存的**（memory.js 里 scope=登录名，注入提示词时只给「共享 + 他自己的」）。
  // agent 用 remember 工具替他记，他自己却因为撞上 /api/memory 这个前缀而加不了、删不了——
  // 记的是他的事，他既看不见也改不动。这一条只往他自己那个作用域里写：
  // 想写进所有人都读得到的共享区，路由那边会挡下来降成个人的（跟审批里 always 降 session 一个道理）。
  "/api/memory/item",
]);
/**
 * 同上，但要按前缀认（路径里带 id）：
 *   /api/security/approvals/<id>  批自己那个任务弹出来的审批。
 *     这条不放行的话，普通成员点「允许」拿到的是 403，而他那个任务正挂在那儿等回答——
 *     等到超时才按拒绝收场，界面上什么都不说。归属和「一直允许」的限制在路由里做：
 *     只能批自己的，写进永久放行名单仍然只有平台管理员能干。
 */
const PERSONAL_WRITE_PREFIX = [
  "/api/security/approvals/",
  // DELETE /api/memory/item/<id>  删自己记的那条。归属在 memory.remove 里认（只能删 scope 是自己的），
  // 共享区那些照样删不动。
  "/api/memory/item/",
];
/**
 * 读表的例外：这几条 GET 只回调用者自己那份，拦下来纯属让他对着一个空面板发呆。
 *   /api/memory  条目区已经按登录名过滤了（memory.list(user)），回给他的本来就只有
 *                「共享 + 他自己的」。整条拦掉的话，普通成员打开记忆页看到的是一片空白：
 *                他自己的记忆一条不显示，也没有任何一句话解释为什么。
 * 只放这一条精确路径，/api/memory/export（导出全库）和 /api/memory/import/scan（扫本机
 * 别的 agent 的记忆文件）仍然归平台管理员。
 */
const PERSONAL_READ = new Set(["/api/memory"]);
/**
 * 部署形态：这是「一个人的桌面应用」还是「一台给多个人用的服务器」。
 *
 * 上面那两张表画的是服务器上的线。同一份代码装成 .dmg / .exe 双击打开时，那条线是纯添乱：
 * 屏幕前只有一个人，他自己的机器、自己的 API Key、自己的桌面，却被自己的软件告知
 * 「这块是服务器级设置，归平台管理员管」——桌面宠物开不了，底层引擎切不动。
 *
 * 判据是两个都得成立，缺一不可：
 *   ① 跑在 Electron 壳里（不是 node server.js，也不是 run_node 派生的子进程）；
 *   ② 服务端只监听回环地址（127.0.0.1 / ::1 / localhost）。
 * ② 是关键的那半边：只要绑到 0.0.0.0 或某个网卡地址，别人就能连进来，闸必须留着。
 * Docker 部署走的正是 HOST=0.0.0.0，天然落在墙这一侧。
 *
 * 同时也把凭证脱敏一起关掉。听起来吓人，其实相反：能连上回环地址的人，本来就能直接
 * 打开 config.json 看那些 Key。留着脱敏在这儿只有一个效果——界面把 Key 显示成空，
 * 用户随手一存就把真 Key 抹了。这是本次改动里唯一真会丢数据的坑，所以两个开关必须同生共死。
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);
let soloDesktop = false;
function setDeployment({ host, shell } = {}) {
  soloDesktop = !!shell && LOOPBACK.has(String(host || "").trim().replace(/^\[|\]$/g, ""));
  return soloDesktop;
}
function isSoloDesktop() {
  return soloDesktop;
}

/** 平台管理员 = 默认组织的管理员。全局工作目录、密钥、引擎这些只有他能动 */
function ownsGlobalWorkspace(user) {
  return !!user && org.orgIdOf(user) === org.DEFAULT_ORG && account.isAdmin(user);
}
function platformGuard(req, res, next) {
  if (soloDesktop) return next(); // 个人桌面版：没有「平台」这回事，别拿服务器的规矩管一个人的机器
  if (ownsGlobalWorkspace(req.user)) return next();
  const p = req.path;
  const table = req.method === "GET" ? PLATFORM_READ : PLATFORM_WRITE;
  if (table.some((x) => p.startsWith(x))) {
    // 只动了自己那几项（底层引擎、思考档、上次选的模型、宠物、快捷键）就放行——
    // 这几样改了只影响他一个人，拦下来纯属把「切换失败」四个字甩给用户。
    // 真源是 prefs.js 里那张表，闸和处理器共用同一张，不会出现「放行了却没人接」。
    if (req.method === "POST" && p === "/api/settings" && prefs.isPersonalPatch(req.body)) return next();
    // 按方法分开认：GET 走读表的例外，其余走写表的。合在一起认的话，
    // 放行「看自己的记忆」会连「改全局背景说明」（POST 同一个路径）一起放出去。
    if (req.method === "GET"
      ? PERSONAL_READ.has(p)
      : PERSONAL_WRITE.has(p) || PERSONAL_WRITE_PREFIX.some((x) => p.startsWith(x))) return next();
    return res.status(403).json({ error: "这块是服务器级设置，归平台管理员管", platform_only: true });
  }
  // 剩下的照常放行，只把这一个字段摘掉：别让它捎带着把全局工作目录改了
  if (req.body && typeof req.body === "object" && req.body.workspace_dir !== undefined) delete req.body.workspace_dir;
  next();
}

/**
 * 凭证脱敏。GET /api/settings 原来把 config 里的 API Key、飞书 App Secret 一股脑回给前端——
 * 只要登录了就能读，普通成员也能。这在单组织下就已经是个洞了，不是多租户才有的事。
 *
 * 只认「像凭证」的字段名，别把 groupUsage 返回的 { key: "张三" } 这种分组标签也抹了：
 * api_key / jina_key / app_secret / verification_token / dingtalk_webhook 都命中，光秃秃的 key 不命中。
 */
const SECRET_FIELD = /(_(key|secret|token|webhook|password)|^(secret|token|password|apikey))$/i;
function redactSecrets(v) {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_FIELD.test(k) ? (val ? "" : val) : redactSecrets(val);
    return out;
  }
  return v;
}
function redactGuard(req, res, next) {
  if (soloDesktop) return next(); // 见 setDeployment：桌面版关了闸就必须一起关脱敏，否则会把真 Key 存成空
  if (req.method !== "GET" || req.path.startsWith("/api/admin") || ownsGlobalWorkspace(req.user)) return next();
  const json = res.json.bind(res);
  res.json = (body) => json(redactSecrets(body));
  next();
}

/**
 * 租户工作目录：把这条请求整条异步链绑到调用者所属组织的成果根目录上。
 *
 * 绑在这一层而不是每个接口里各自判：文件相关的入口有十几个（列表/下载/预览/删除/整理/保存/
 * 打开/上传，还有任务本身写出去的每一个文件），漏判一个就是一个跨租户读文件的洞。
 * 默认组织返回空串 → withWorkspace 原样放行，单机个人版一行行为都没变。
 *
 * 个人偏好（底层引擎 / 思考档 / 上次选的模型）也在这儿一并入栈，理由一模一样：
 * 「这一趟任务该用哪个引擎」的读取点散在 goalThink、/api/engines、/api/thinking、agent.js 里，
 * 每处各自去翻当前是谁，漏一处就是「设置页显示 Codex、实际还在烧 API」。
 * 没登录 / 没偏好文件 → 传 null → 不设 store → 全部回落到 config.json，老行为一字不差。
 */
function tenantScope({ withWorkspace, withPolicy, getWorkspaceDir }) {
  return (req, res, next) => {
    let root = "";
    let policy = null;
    try {
      const o = org.getOrg(org.orgIdOf(req.user));
      root = o.id === org.DEFAULT_ORG ? "" : org.rootDirOf(o, getWorkspaceDir());
      const s = org.settingsOf(o);
      // 只在真配了限制时才进 ALS：默认组织默认值 = 不限 = 不设 store = 老行为一字不差
      if (s.allow_shell === false || (s.net_allow || []).length || (s.net_deny || []).length)
        policy = { allow_shell: s.allow_shell !== false, net_allow: s.net_allow || [], net_deny: s.net_deny || [] };
    } catch (e) {
      console.warn("[租户] 取组织工作目录失败：" + e.message);
    }
    let mine = null;
    try {
      // 个人桌面版从来不写偏好文件（那边一切照旧落 config.json），别为它每个请求白 stat 一次盘
      const p = soloDesktop ? null : prefs.read(req.user);
      if (p && Object.keys(p).length) mine = p;
    } catch (e) {
      console.warn("[个人偏好] 读取失败，本次按全局设置走：" + e.message);
    }
    withWorkspace(root, () => withPolicy(policy, () => prefs.withPrefs(mine, next)));
  };
}

function createAdminRouter(deps = {}) {
  const router = express.Router();
  const { orgUsage } = deps; // 让 server 把「这个组织当前占了多少磁盘」之类的信息喂进来

  router.use("/api/admin", account.adminGuard);

  // ---------- 概览（订阅信息 + 今日/本月用量 + 席位）----------
  router.get("/api/admin/overview", guarded((req) => {
    const orgId = org.orgIdOf(req.user);
    const o = org.getOrg(orgId);
    const plan = org.planInfo(o);
    const members = account.listMembers(orgId);
    const usage = account.usageSummary(req.user);
    const s = org.settingsOf(o);
    return {
      org: { id: o.id, name: o.name, created_at: o.created_at, root_hint: o.id === org.DEFAULT_ORG ? "默认工作目录" : "独立工作目录" },
      plan,
      seats: { total: plan.seats, used: members.filter((m) => m.status !== "disabled").length, pending: members.filter((m) => m.status === "pending").length },
      settings: s,
      // 月固定用量：整个组织这个月发下去多少、用掉多少
      monthly: {
        per_member: s.member_monthly_credits,
        granted: members.reduce((n, m) => n + (m.monthly_quota || 0), 0),
        used: usage.month.from_monthly || 0,
        credits_used: usage.month.credits || 0,
      },
      today: usage.today,
      month: usage.month,
      last7: usage.last7,
      multi_tenant: org.multiTenant(),
      platform_admin: platformAdmin(req.user),
      me: account.publicUser(req.user),
    };
  }));

  // ---------- 成员与部门 ----------
  router.get("/api/admin/members", guarded((req) => ({
    members: account.listMembers(org.orgIdOf(req.user)),
    depts: org.listDepts(org.orgIdOf(req.user)),
  })));

  router.post("/api/admin/members", account.adminOnly, guarded((req) => account.createMember(req.user, req.body || {})));

  router.post("/api/admin/members/:name", account.adminOnly, guarded((req) =>
    ({ ok: true, member: account.setMember(req.user, req.params.name, req.body || {}) })));

  router.post("/api/admin/members/:name/reset-password", account.adminOnly, guarded((req) =>
    // 明文只在这一次响应里出现：不落盘、不进审计详情、不记日志
    ({ ok: true, password: account.resetPassword(req.user, req.params.name) })));

  router.delete("/api/admin/members/:name", account.adminOnly, guarded((req) =>
    ({ ok: true, member: account.removeMember(req.user, req.params.name) })));

  // 成员审核：通过 = 转成 active；拒绝 = 直接删号（人还没进来过，留着只会占席位）
  router.get("/api/admin/pending", guarded((req) => ({ members: account.pendingMembers(org.orgIdOf(req.user)) })));
  router.post("/api/admin/pending/:name", account.adminOnly, guarded((req) => {
    const pass = (req.body || {}).action !== "reject";
    if (pass) return { ok: true, member: account.setMember(req.user, req.params.name, { status: "active" }) };
    return { ok: true, member: account.removeMember(req.user, req.params.name) };
  }));

  router.post("/api/admin/depts", account.adminOnly, guarded((req) =>
    org.addDept(org.orgIdOf(req.user), (req.body || {}).name, req.user.username)));
  router.delete("/api/admin/depts/:id", account.adminOnly, guarded((req) =>
    ({ ok: true, dept: org.removeDept(org.orgIdOf(req.user), req.params.id, req.user.username) })));

  // ---------- 邀请码 ----------
  router.get("/api/admin/invites", guarded((req) => ({ invites: org.listInvites(org.orgIdOf(req.user)) })));
  router.post("/api/admin/invites", account.adminOnly, guarded((req) =>
    org.createInvite(org.orgIdOf(req.user), { ...(req.body || {}), actor: req.user.username })));
  router.delete("/api/admin/invites/:code", account.adminOnly, guarded((req) =>
    ({ ok: true, invite: org.revokeInvite(org.orgIdOf(req.user), req.params.code, req.user.username) })));

  // ---------- 用量 ----------
  /**
   * scope=member 按人、model 按模型、source 按入口（网页/飞书/定时…）、detail 明细流水。
   * 四张表用的是同一份 usageSummary，不重复扫盘。
   */
  router.get("/api/admin/usage", guarded((req) => {
    const q = req.query || {};
    const sum = account.usageSummary(req.user, { user: q.user || "", limit: Math.min(500, +q.limit || 200) });
    return {
      today: sum.today, month: sum.month, last7: sum.last7,
      by_user: sum.by_user, by_model: sum.by_model, by_source: sum.by_source,
      detail: sum.recent,
      members: account.listMembers(org.orgIdOf(req.user)).map((m) => ({
        username: m.username, nickname: m.nickname, dept: m.dept, role: m.role, status: m.status,
        monthly_quota: m.monthly_quota, monthly_left: m.monthly_left, credits: m.credits, balance: m.balance,
      })),
    };
  }));

  router.post("/api/admin/topup", account.adminOnly, guarded((req) => {
    const { username, amount } = req.body || {};
    const balance = account.topup(req.user, username, amount);
    org.audit({ org: org.orgIdOf(req.user), actor: req.user.username, action: "充值", target: username || req.user.username, detail: `+${Math.floor(+amount)}` });
    return { ok: true, username, balance };
  }));

  // ---------- 企业设置 ----------
  router.get("/api/admin/org", guarded((req) => {
    const o = org.getOrg(org.orgIdOf(req.user));
    return { org: { ...o, settings: org.settingsOf(o) }, plans: org.PLANS, plan_order: org.PLAN_ORDER, platform_admin: platformAdmin(req.user) };
  }));
  router.post("/api/admin/org", account.adminOnly, guarded((req) => {
    const body = { ...(req.body || {}) };
    // 套餐 / 席位 / 到期时间是「卖出去的东西」，本组织管理员不能自己改大
    if (!platformAdmin(req.user)) { delete body.plan; delete body.seats; delete body.expires_at; delete body.root_dir; }
    const o = org.updateOrg(org.orgIdOf(req.user), body, req.user.username);
    return { ok: true, org: { ...o, settings: org.settingsOf(o) } };
  }));

  // ---------- 组织管理（平台管理员）----------
  router.get("/api/admin/orgs", platformOnly, guarded(() => {
    const members = account.listMembers; // 每个组织各查一次，组织数量是个位数，不值得为它做索引
    return {
      orgs: org.listOrgs().map((o) => {
        const ms = members(o.id);
        return {
          ...o, settings: org.settingsOf(o), ...org.planInfo(o),
          members: ms.length,
          active: ms.filter((m) => m.status === "active").length,
        };
      }),
      plans: org.PLANS, plan_order: org.PLAN_ORDER,
    };
  }));
  router.post("/api/admin/orgs", platformOnly, guarded((req) =>
    org.createOrg({ ...(req.body || {}), actor: req.user.username })));
  router.post("/api/admin/orgs/:id", platformOnly, guarded((req) =>
    ({ ok: true, org: org.updateOrg(req.params.id, req.body || {}, req.user.username) })));

  // ---------- 审计 ----------
  router.get("/api/admin/audit", guarded((req) =>
    ({ audit: org.listAudit(org.orgIdOf(req.user), req.query.limit) })));

  // ---------- 数据统计 ----------
  router.get("/api/admin/stats", guarded((req) => {
    const sum = account.usageSummary(req.user, { limit: 500 });
    const members = account.listMembers(org.orgIdOf(req.user));
    const runs = sum.recent.filter((e) => e.kind === "run");
    const active = new Set(runs.filter((e) => e.day === sum.last7[6].day).map((e) => e.user));
    return {
      totals: {
        members: members.length,
        active_today: active.size,
        runs_month: sum.month.runs,
        tokens_month: sum.month.tokens,
        credits_month: sum.month.credits,
        // 缓存命中率：分母只算记过 cached 字段的那些条（老流水没有这个字段）
        cache_hit: sum.month.cachedOf ? +(sum.month.cached / sum.month.cachedOf * 100).toFixed(1) : null,
        avg_ms: sum.month.runs ? Math.round(sum.month.elapsed_ms / sum.month.runs) : 0,
      },
      last7: sum.last7,
      by_user: sum.by_user.slice(0, 20),
      by_model: sum.by_model.slice(0, 20),
      by_source: sum.by_source,
      by_dept: sum.by_dept,
      storage: typeof orgUsage === "function" ? safeCall(orgUsage, org.orgIdOf(req.user)) : null,
    };
  }));

  return router;
}

function safeCall(fn, arg) {
  try { return fn(arg); } catch { return null; }
}

module.exports = { createAdminRouter, platformAdmin, ownsGlobalWorkspace, platformGuard, redactGuard, tenantScope, redactSecrets, setDeployment, isSoloDesktop, PLATFORM_WRITE, PLATFORM_READ, PERSONAL_WRITE, PERSONAL_WRITE_PREFIX, PERSONAL_READ };
