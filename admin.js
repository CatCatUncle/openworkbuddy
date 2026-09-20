"use strict";
/**
 * 企业管理后台的接口层（/api/admin/*）。
 *
 * 权限分档在 rbac.js（成员 < 审计员 < 管理员 < 超级管理员），这儿只是把它接到路由上：
 *   - adminGuard：能进后台（管理员 + 审计员）。所有 GET 走这一档。
 *   - adminOnly ：能改东西（管理员以上）。所有写操作走这一档。
 *   审计员这个角色存在的意义就是「能查账但改不动」——合规、外包、财务对账都需要这么一个人。
 *   **管人**比这更严：走 account.assertCanManage，只能管比自己低的那一档，
 *   所以管理员对管理员一步也走不动（以前能互相停用，谁先点谁赢）。
 *
 * 上面还有两档跟「这台机器」有关的：
 *   - **平台管理员** = 默认组织的管理员。改引擎、密钥、MCP、技能这些服务器级设置（platformGuard）。
 *   - **平台超级管理员** = 默认组织的超管 = 机主。新建组织、改别的组织的套餐席位只有他能动——
 *     开一个组织等于开一份账单，还等于放出一个新的超管，这不该是随便哪个管理员能干的事。
 */

const express = require("express");
const account = require("./account");
const org = require("./org");
const rbac = require("./rbac"); // 角色分档和能力表
const lifecycle = require("./lifecycle");
const prefs = require("./prefs"); // 哪些设置算「个人的」，那张表在这儿
const quota = require("./quota"); // 按次计费的第三方 API：清单、额度、流水
// API 中转站那四件：Key、预算、价目、账本。后台这一页是它们唯一的人类入口
const vkeys = require("./vkeys");
const budget = require("./budget");
const pricing = require("./pricing");
const usageStore = require("./usage-store");

function platformAdmin(user) {
  return account.isAdmin(user) && org.orgIdOf(user) === org.DEFAULT_ORG;
}
function platformOnly(req, res, next) {
  if (!platformAdmin(req.user)) return res.status(403).json({ error: "只有平台管理员（默认组织的管理员）能做这个操作" });
  next();
}
/** 开组织 / 改别人的套餐席位：只有机主。见文件头 */
function platformOwnerOnly(req, res, next) {
  if (!account.platformOwner(req.user)) return res.status(403).json({ error: "只有平台超级管理员（默认组织的超级管理员）能做这个操作" });
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
  // 技能为什么在写表里：skills/ 是**整台机器一份**的目录，不分组织。任何人装进去的技能，
  // 会出现在所有人（包括平台管理员自己）的每一条任务里——而技能正文就是写给 agent 看的指令，
  // agent 手里有 shell。放开写等于让任何一个刚注册的同事给全公司的 agent 递指令。
  // 读（GET）不拦：装了什么谁都该看得见。
  "/api/skills", "/api/memory", "/api/library",
  // 「用系统程序打开」「在访达里显示」= 在**服务器那台机器**上起一个进程。
  // 按上面那条线，这是「配这台机器」，不是租户内动作：成员开在别人机器上的窗口他也看不见，
  // 而这条路径以前连表都不在，任何登录用户都能拿它拉起服务端进程。
  // 单机桌面版走的是 platformGuard 第一行的 soloDesktop 直通，一行行为都没变。
  // 复制到剪贴板同理：写的是**服务器那台机器**的剪贴板，而且得先读到文件本身。
  "/api/files/open", "/api/files/reveal", "/api/files/copy",
];
const PLATFORM_READ = [
  "/api/schedules", "/api/backup", "/api/security/audit", "/api/memory",
  "/api/evolve", "/api/eval", "/api/feishu",
];
// 读表里为什么没有 /api/library：拦它拦了个寂寞。资料库是**一份全局目录**（tools.js 的 LIB_DIR），
// 每个人的 agent 都带着 library_list / library_read 这两个工具，一句「翻一下资料库」就能把文件清单、
// 灵感笔记、乃至文件正文原样念出来——同样的字节，走 agent 拿得到，走界面反而 403。
// 结果只有一个：资料库页面对普通成员写着「还没有参考资料」，一句瞎话。
// 所以读放行、写照拦（上传/删除/记笔记全在 PLATFORM_WRITE 的 /api/library 前缀里）。
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
  // 小写化再查表：表里全是小写前缀，而 Express 路由大小写不敏感，
  // 普通成员发 POST /api/Settings 能命中处理器却不命中这张表——整张写表就绕过去了
  const p = req.path.toLowerCase();
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
  if (req.method !== "GET" || req.path.toLowerCase().startsWith("/api/admin") || ownsGlobalWorkspace(req.user)) return next();
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
function tenantScope({ withWorkspace, withPolicy, getWorkspaceDir, readConfig }) {
  return (req, res, next) => {
    let root = "";
    let policy = null;
    let actor = null;
    try {
      // 登录闸刚刚解析过同一个组织，挂在请求上了；没有的话（比如单机桌面版
      // 这条路上没人登录）才自己去读
      const o = req.org || org.getOrg(org.orgIdOf(req.user));
      root = o.id === org.DEFAULT_ORG ? "" : org.rootDirOf(o, getWorkspaceDir());
      const s = req.orgSettings || org.settingsOf(o);
      // 只在真配了限制时才进 ALS：默认组织默认值 = 不限 = 不设 store = 老行为一字不差
      if (s.allow_shell === false || (s.net_allow || []).length || (s.net_deny || []).length)
        policy = { allow_shell: s.allow_shell !== false, net_allow: s.net_allow || [], net_deny: s.net_deny || [] };
      // 付费 API 的额度上下文。同样只在**真配了限制**时才建：
      // 没配的时候连流水都不必带着 org/user 走一遍 ALS，跟以前一模一样。
      // 两道闸分开判，不能合成一个条件：
      //   次数闸（quota）管「一天最多生多少张图」，钱闸（budget）管「这个月最多花多少元」。
      //   很多公司一路次数都没限，却给每个人设了月预算——只看 quota 的话，
      //   那笔预算一分钱也拦不住，而后台上那个输入框看着很像在干活。
      const qt = quota.quotaTable(s);
      const anyCap = Object.values(qt).some((c) => c.enabled);
      const bctx = { orgId: o.id, org: s, user: req.user || null };
      const anyBudget = Object.values(budget.limitsOf(bctx)).some((x) => x > 0);
      if (anyCap || anyBudget)
        actor = {
          org: o.id, user: (req.user && req.user.username) || "",
          dept: (req.user && req.user.dept) || "", source: "web",
          quota: anyCap ? qt : null,
          budget: anyBudget ? bctx : null,
          // 价目要跟着走：管理员改过的价、这个组织谈下来的折扣，都影响这一趟扣多少。
          // 不带的话闸门按原价算、账本按原价记，谈下来的折扣等于没谈。
          price: { config: safeCall(readConfig, null) || {}, discount: s.price_discount },
        };
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
    withWorkspace(root, () => withPolicy(policy, () => quota.withActor(actor, () => prefs.withPrefs(mine, next))));
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
    // 这一页上一个人名都不显示，只显示「几个人 / 几个等审核 / 这个月发下去多少」。
    // 以前是把整份花名册算一遍换这几个数字：每人算角色、额度、余额，还要为「最后活跃」
    // 翻一遍用量账本。而这是打开后台第一眼的那一页，每次都要拉
    const ms = account.memberStats(orgId);
    const usage = account.usageSummary(req.user);
    const s = org.settingsOf(o);
    return {
      org: { id: o.id, name: o.name, created_at: o.created_at, root_hint: o.id === org.DEFAULT_ORG ? "默认工作目录" : "独立工作目录" },
      plan,
      seats: { total: plan.seats, used: ms.used, pending: ms.pending },
      settings: s,
      // 月固定用量：整个组织这个月发下去多少、用掉多少
      monthly: {
        per_member: s.member_monthly_credits,
        granted: ms.granted,
        used: usage.month.from_monthly || 0,
        credits_used: usage.month.credits || 0,
        // 额度见底的人：首页那条待办要的就是这个。以前是前端把整份花名册拉过来自己数——
        // 3000 人的组织为了一行待办搬 1041 KB。dry_names 至多三个，界面上也只点得下三个
        dry: ms.dry,
        dry_names: ms.dry_names,
      },
      today: usage.today,
      month: usage.month,
      last7: usage.last7,
      multi_tenant: org.multiTenant(),
      platform_admin: platformAdmin(req.user),
      platform_owner: account.platformOwner(req.user),
      me: account.publicUser(req.user),
    };
  }));

  // ---------- 成员与部门 ----------
  // 部门模板跟着这一趟一起回去：成员页要拿它画「这个部门进来的人默认什么权限」，
  // 单开一趟请求等于让页面多等一个来回，还多一处能 403 的地方（审计员读得到模板，改不动）
  router.get("/api/admin/members", guarded((req) => {
    const q = req.query || {};
    const orgId = org.orgIdOf(req.user);
    // 筛和翻页都在服务端做。以前是整份回去、前端自己筛：3000 人的组织一次 1041 KB、
    // 浏览器里 78098 个 DOM 节点、点进来到表格出来 878ms，而一屏看得见十几行。
    // fields=lite 只回名字那几格，给下拉框用（交接给谁、归到谁名下……）
    return {
      ...account.queryMembers(orgId, {
        q: q.q, role: q.role, status: q.status, offset: q.offset, limit: q.limit,
        lite: q.fields === "lite",
      }),
      depts: org.listDepts(orgId),
      templates: lifecycle.listDeptTemplates(orgId),
      // 建号和部门模板的角色下拉得照着**这个人**能发的角色画。少了这行，管理员那边
      // 下拉里还挂着「管理员」，点下去后端一句「你没有授予…的权限」——看得见但会 403 的按钮
      can_assign: rbac.assignableBy(req.user, { role: "member" }),
    };
  }));

  router.post("/api/admin/members", account.adminOnly, guarded((req) => account.createMember(req.user, req.body || {})));

  router.post("/api/admin/members/:name", account.adminOnly, guarded((req) =>
    ({ ok: true, member: account.setMember(req.user, req.params.name, req.body || {}) })));

  router.post("/api/admin/members/:name/reset-password", account.adminOnly, guarded((req) =>
    // 明文只在这一次响应里出现：不落盘、不进审计详情、不记日志
    ({ ok: true, password: account.resetPassword(req.user, req.params.name) })));

  // 手机丢了 / 换了手机没迁验证器 —— 管理员把这个人的二次验证清掉，让他重新绑一次。
  // **不是「帮他关掉」**：组织要是开了强制，他下次登录还是得先绑，只是绑一套新的。
  router.post("/api/admin/members/:name/reset-2fa", account.adminOnly, guarded((req) => {
    const name = req.params.name;
    // 走跟改密码同一道闸：清掉二次验证 + 重置密码就是一次完整的接管，
    // 只判「在不在同一个组织」的话，管理员照样能接管另一个管理员的号
    account.assertManageable(req.user, name, "重置二次验证");
    return { ok: true, was_on: account.disableTOTP(name, { byAdmin: true, actor: req.user.username }) };
  }));

  router.delete("/api/admin/members/:name", account.adminOnly, guarded((req) =>
    ({ ok: true, member: account.removeMember(req.user, req.params.name) })));

  /**
   * 这个组织的权限长什么样：角色表、能力表、**我**能授出去哪几个角色、超管是谁。
   * 前端拿它渲染「管理员角色」那一页——下拉里出现的选项和后端拦的是同一张表，
   * 而不是界面上藏一藏、后端照旧放行。
   */
  router.get("/api/admin/roles", guarded((req) => {
    const orgId = org.orgIdOf(req.user);
    // 这一页要两样东西，都不是「全体成员」：
    //   · 管理层名单（审计员起）——这张表本来就短，一家公司有三千个管理员的情况不存在
    //   · 提拔 / 转让的候选人——只要名字，而且下拉框里塞三千个人本来就没法用
    // 以前这里回的是整份花名册，3000 人时 1042 KB，为了画一张十来行的表
    const staff = account.queryMembers(orgId, { all: true, minRank: "auditor" }).members;
    const candidates = account.queryMembers(orgId, { status: "active", lite: true, limit: account.MEMBER_PAGE_MAX });
    return {
      ranks: rbac.ROLE_RANK,
      roles: rbac.ROLES.map((r) => ({ role: r, label: rbac.ROLE_LABEL[r], caps: rbac.CAPS[r] })),
      caps: rbac.CAP_LABEL,
      me: { role: rbac.roleOf(req.user), can_assign: rbac.assignableBy(req.user, { role: "member" }),
            can_transfer: rbac.can(req.user, "owner.transfer"), platform_owner: account.platformOwner(req.user) },
      owner: (staff.find((m) => m.role === "owner") || {}).username || "",
      staff,
      // 候选人可能被截断（超过 MEMBER_PAGE_MAX 就只回前 500 个）。截断了得说，
      // 不然界面上「找不到那个人」会被当成他不存在
      candidates: candidates.members,
      candidates_total: candidates.matched,
      candidates_capped: candidates.matched > candidates.members.length,
    };
  }));

  // 转让超级管理员。每个组织只有一个，所以这不是「再发一个」，是把位子交出去——
  // 交完自己降成管理员。理由写在 rbac.js 文件头上。
  router.post("/api/admin/owner", account.adminOnly, guarded((req) =>
    ({ ok: true, ...account.transferOwner(req.user, (req.body || {}).username) })));

  // ---------- 入职 / 离职 ----------
  // 办离职：一次调用关掉他手上所有还能用的口子，出一张能贴进交接单的回执。
  // 为什么不是「点一下停用」就算办完：停用只删登录令牌，他名下的定时任务照跑、
  // 他发出去的邀请码照样能注册进来。整段缘由写在 lifecycle.js 头上。
  router.post("/api/admin/members/:name/offboard", account.adminOnly, guarded((req) => {
    const b = req.body || {};
    const receipt = lifecycle.offboard(req.user, req.params.name, {
      handover: b.handover,
      keep2fa: !!b.keep_2fa,
      stopRuns: deps.stopRunsOf,   // server.js 注入：纯命令行环境里没有正在跑的任务这回事
    });
    return { ok: true, receipt, text: lifecycle.receiptText(receipt) };
  }));

  // 办入职：建号时套用部门模板，同一个部门进来的人权限长得一模一样
  router.post("/api/admin/onboard", account.adminOnly, guarded((req) => lifecycle.onboard(req.user, req.body || {})));

  // 部门权限模板
  router.get("/api/admin/dept-templates", guarded((req) => ({ templates: lifecycle.listDeptTemplates(org.orgIdOf(req.user)) })));
  router.post("/api/admin/dept-templates", account.adminOnly, guarded((req) => {
    const b = req.body || {};
    return { ok: true, templates: lifecycle.setDeptTemplate(req.user, b.dept, b.remove ? null : b.template || {}) };
  }));

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
  router.post("/api/admin/invites", account.adminOnly, guarded((req) => {
    const b = req.body || {};
    // 邀请码是「预先指定角色」的建号。不在这儿判的话，「管理员发不了管理员」绕一步就没了：
    // 发一张 role=admin 的码，自己扫进来一个新号
    const bad = rbac.assignProblem(req.user, { role: "member" }, b.role || "member");
    if (bad) throw new Error("发不了这样的邀请码：" + bad);
    return org.createInvite(org.orgIdOf(req.user), { ...b, actor: req.user.username });
  }));
  router.delete("/api/admin/invites/:code", account.adminOnly, guarded((req) =>
    ({ ok: true, invite: org.revokeInvite(org.orgIdOf(req.user), req.params.code, req.user.username) })));

  // ---------- 用量 ----------
  /**
   * scope=member 按人、model 按模型、source 按入口（网页/飞书/定时…）、detail 明细流水。
   * 四张表用的是同一份 usageSummary，不重复扫盘。
   */
  router.get("/api/admin/usage", guarded((req) => {
    const q = req.query || {};
    const sum = account.usageSummary(req.user, {
      user: q.user || "",
      from: q.from || "", to: q.to || "", q: q.q || "",
      offset: q.offset || 0,
      limit: Math.min(500, +q.limit || 200),
    });
    return {
      today: sum.today, month: sum.month, last7: sum.last7, range: sum.range,
      // 分组只回前 20（花得最多的那些），跟 /api/admin/stats 一个口径。不截的话这三行
      // 是按人头长的：3000 人的组织里，205 KB 的回包有 195 KB 是这张按人分组的表，
      // 而这一页画的是流水，一行都没用到它。groups 把真实组数带上，免得二十当成全部
      by_user: sum.by_user.slice(0, 20), by_model: sum.by_model.slice(0, 20), by_source: sum.by_source,
      groups: { users: sum.by_user.length, models: sum.by_model.length, sources: sum.by_source.length },
      detail: sum.recent, total: sum.total, offset: sum.offset, limit: sum.limit,
    };
    // 这里**不捎带花名册**。以前捎带过，于是 ?limit= 根本缩不小回包：3000 人的组织，
    // limit=20 是 682 KB、limit=1 还是 678 KB——那几百 KB 是名单，不是流水。
    // 两个要名单的地方各自有了去处：
    //   · 「成员用量」那张按人头的表 → /api/admin/usage/members，一页 50 个
    //   · 明细页那个「看谁的」→ /api/admin/members?fields=lite&q=，打字的时候才去问
  }));

  /**
   * 成员用量：一页 50 个人，筛、排、切都在服务端。
   *
   * 为什么单开一条而不是挂在上面那个接口上：上面回的是**这个组织**的汇总和流水，
   * 那份数据跟公司多少人没关系；这一页是按人头长的，得一页一页地要。挤在一起的结果
   * 就是上面那条注释里写的事——明明只要一条流水，回包还是大半兆。
   */
  router.get("/api/admin/usage/members", guarded((req) => {
    const q = req.query || {};
    return account.memberUsage(org.orgIdOf(req.user), {
      q: q.q, dry: q.dry, sort: q.sort, offset: q.offset, limit: q.limit,
    });
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

  // ---------- 付费 API 与额度（平台管理员）----------
  /**
   * 这一页要回答管理员的三个问题，所以三样东西必须一次给齐：
   *   ① 有哪些要花钱的 API、现在配没配（configured）——不配就是根本没开，谈额度没意义；
   *   ② 这个月已经花了多少、谁花的（summary）；
   *   ③ 额度设成多少（quota）。
   * 分三个接口的话，前端要串三次请求才能画出一行，而这三样天然是一行里的三格。
   */
  router.get("/api/admin/api-quota", platformOnly, guarded((req) => {
    const o = org.getOrg(org.orgIdOf(req.user));
    const s = org.settingsOf(o);
    const table = quota.quotaTable(s);
    const sum = quota.summary(o.id, table);
    const cfg = safeCall(deps.readConfig, null) || {};
    // 每一路「配没配」由服务端认：前端不该拿到 Key，也就没法自己判断
    const at = (obj, dotted) => dotted.split(".").reduce((x, k) => (x == null ? x : x[k]), obj);
    const configured = {
      search: !!(cfg.search && (cfg.search.jina_key || cfg.search.api_key || cfg.search.tavily_key || cfg.search.brave_key)),
      image: !!at(cfg, "media.image.model") || !!at(cfg, "media.image.provider"),
      video: !!at(cfg, "media.video.model") || !!at(cfg, "media.video.provider"),
      tts: !!at(cfg, "media.tts.model") || !!at(cfg, "media.tts.provider"),
      asr: !!at(cfg, "media.asr.model") || !!at(cfg, "media.asr.provider"),
      fetch: true, // 抓网页不需要钥匙，永远是「已就绪」
    };
    return {
      ...sum,
      caps: sum.caps.map((c) => ({ ...c, configured: !!configured[c.key] })),
      suggest: quota.suggested(),
      org: { id: o.id, name: o.name },
    };
  }));
  router.post("/api/admin/api-quota", platformOnly, guarded((req) => {
    const body = req.body || {};
    // 「一键设个合理额度」：前端只发一个 preset=suggest，值由服务端出——
    // 建议值跟能力清单绑在一起（quota.js），不该在前端再抄一份，抄了就会两边对不上
    const table = body.preset === "suggest" ? quota.suggested() : quota.normalizeTable(body.quota);
    const o = org.updateOrg(org.orgIdOf(req.user), { settings: { api_quota: table } }, req.user.username);
    const saved = quota.quotaTable(org.settingsOf(o));
    return { ok: true, quota: saved, caps: quota.summary(o.id, saved).caps };
  }));

  // ---------- API 中转站：Key / 预算 / 价目 / 账单 ----------
  /**
   * 一页一次请求。这一页要同时回答四个问题，而它们天然是一张表上的几列：
   *   ① 发出去了哪些 Key、还能不能用、上次什么时候被调的（keys）
   *   ② 这个月花了多少、谁花的、花在哪个型号上（spend）
   *   ③ 上限设在哪、离封顶还差多远、这个月拦过几次（levels）
   *   ④ 价目是从哪一层来的（prices，平台管理员才看得见）
   *
   * 拆成四个接口的话，前端要串四次才画得出一行；而一把 Key 的「已花 / 上限 / 剩余」
   * 本来就是并排的三格——分开取，必然出现三格来自三个时刻的情况，
   * 而这三个数之间的关系（剩余 = 上限 − 已花）正是管理员唯一会去核的东西。
   */
  /**
   * 本月这个组织每个人花掉的钱（元）。usageStore 按月分片，查「本月」只开本月那一个文件，
   * 历史攒了多少年都不会让这一页变慢。
   *
   * 口径跟下面那一页、跟 budget.spentOf 三处一致：充值不算花销，中转出去的和公司内部
   * 自己用的都算——它们花的是同一笔预算。三处对不上的话，同一屏上的两个数会互相矛盾。
   */
  function spentByUser(orgId) {
    const mk = budget._internals.monthKey();
    const m = new Map();
    try {
      for (const r of usageStore.read({ from: mk + "-01", to: mk + "-31" })) {
        if ((r.org || org.DEFAULT_ORG) !== orgId || r.kind === "topup" || !r.user) continue;
        m.set(r.user, (m.get(r.user) || 0) + (+r.cost || 0));
      }
    } catch {}
    for (const [k, v] of m) m.set(k, Math.round(v * 1e4) / 1e4);
    return m;
  }

  /**
   * 「每个人单独的上限」那张表：一页 50 个，设过上限的和本月花过钱的排在最前面。
   *
   * 单开一条而不是挂在 /api/admin/relay 上，是因为那一页回的是**这个组织**的 Key、渠道、
   * 价目和本月账单，那份数据跟公司多少人没关系；只有这张表是按人头长的。挤在一起的结果是
   * 3000 人的组织一次回包 631 KB，其中 620 KB 是一张「跟随团队 · 本月 0 元」重复三千遍的表。
   */
  router.get("/api/admin/relay/members", guarded((req) => {
    const q = req.query || {};
    const orgId = org.orgIdOf(req.user);
    return account.memberBudgets(orgId, { q: q.q, offset: q.offset, limit: q.limit, spent: spentByUser(orgId) });
  }));

  router.get("/api/admin/relay", guarded((req) => {
    const orgId = org.orgIdOf(req.user);
    const o = org.getOrg(orgId);
    const st = org.settingsOf(o);
    const cfg = safeCall(deps.readConfig, null) || {};
    const keys = vkeys.list({ org: orgId });
    const mk = budget._internals.monthKey();

    // 本月这个组织的全部花销，只扫一遍，几张表都从它上面出。
    // 直接用 usageStore.read 的 from/to：它按月分片，查「本月」就只开本月那一个文件，
    // 历史攒了多少年都不会让这一页变慢。
    // 为什么不再只看 kind==="relay"：预算那三档（budget.spentOf）数的是这个组织
    // 本月花的**全部**钱——中转出去的和公司内部自己用的花的是同一笔预算。
    // 这一页上方写着「本月已花 X」、旁边站着「组织上限 Y」，如果 X 只算中转那一半，
    // 管理员看到的就是「还剩很多」，而闸子已经快要拦人了——两个数在同一屏上互相矛盾，
    // 比少一个数更坏。所以这里整个口径跟闸子对齐，再在里面拆出「中转 / 内部」两档。
    const rows = [], relayRows = [];
    try {
      for (const r of usageStore.read({ from: mk + "-01", to: mk + "-31" })) {
        if ((r.org || org.DEFAULT_ORG) !== orgId) continue;
        if (r.kind === "topup") continue;                 // 充值不是花销，跟 budget.spentOf 一个口径
        rows.push(r);
        if (r.kind === "relay") relayRows.push(r);
      }
    } catch {}
    const bump = (m, k, r) => {
      if (!k) return;
      const c = m.get(k) || { key: k, calls: 0, yuan: 0, prompt: 0, completion: 0, units: 0, unknown: 0, estimated: 0 };
      c.calls += r.calls || 1;
      c.yuan += +r.cost || 0;
      c.prompt += +r.prompt || 0;
      c.completion += +r.completion || 0;
      c.units += +r.units || 0;
      // 这两格不是装饰：unknown = 这个型号没登记价目，那笔账记的是 0 但真花了钱；
      // estimated = 流式那一路上游没报 usage，数是按字数估的。后台得把「不知道」和
      // 「知道是 0」分开显示，否则一张全是数字的账单里看不出哪几行不能信。
      if (r.cost_unknown) c.unknown++;
      if (r.cost_estimated) c.estimated++;
      m.set(k, c);
    };
    const byKey = new Map(), byUser = new Map(), byModel = new Map(), byCap = new Map();
    for (const r of rows) {
      bump(byKey, r.vkey, r);
      bump(byUser, r.user || "（没挂人）", r);
      bump(byModel, r.model, r);
      // 没写 cap 的都是 token 那一路（对话 / 向量化），归到 chat。
      // 这一格回答的是「钱花在哪一路上」——一个月四万块里有三万是生视频，
      // 跟全花在对话上，该做的事完全不同，而按型号那张表看不出这件事。
      bump(byCap, String(r.cap || "chat"), r);
    }
    const y4 = (n) => Math.round(n * 1e4) / 1e4;
    const done = (m) => [...m.values()].map((c) => ({ ...c, yuan: y4(c.yuan), units: Math.round(c.units * 1e3) / 1e3 })).sort((a, b) => b.yuan - a.yuan);

    const keyRows = keys.map((k) => {
      const spent = y4((byKey.get(k.id) || {}).yuan || 0);
      return { ...k, caps: k.caps || [], spent_month: spent, left: k.budget_yuan ? Math.max(0, y4(k.budget_yuan - spent)) : null };
    });

    // 有哪些渠道转得出去。relay.js 认的是 config.models[i].channel，
    // 所以「登记了型号但没挂渠道」的那些在中转站上根本转不出去——这一页要直说，
    // 不然业务方拿着 Key 调一个界面上明明看得见的型号，收到的是一句「没有可用渠道」。
    const channels = (cfg.providers || []).map((pv) => ({
      id: pv.id, name: pv.name || pv.id, kind: pv.kind || "",
      models: (cfg.models || []).filter((m) => m && m.channel === pv.id).map((m) => String(m.model || m.name)).filter(Boolean),
      has_key: !!String(pv.api_key || "").trim(),
    }));
    const orphans = (cfg.models || []).filter((m) => m && !m.channel).map((m) => String(m.model || m.name)).filter(Boolean);

    const out = {
      org: { id: o.id, name: o.name },
      keys: keyRows,
      // 这里**不捎带花名册**：「每个人单独的上限」那张表走 /api/admin/relay/members，一页 50 个。
      // 捎带的时候 3000 人的组织一次 631 KB，而那张表一屏看得见十几行
      channels, orphans,
      month: mk,
      budget: { org_yuan: (st.budget || {}).org_yuan || 0, default_user_yuan: (st.budget || {}).default_user_yuan || 0, price_discount: pricing._internals.discountOf(st.price_discount) },
      levels: budget.status({ org: st, orgId }),
      spend: {
        total: y4(rows.reduce((a, r) => a + (+r.cost || 0), 0)),
        calls: rows.length,
        // 拆出两档：发出去的 Key 花的，和公司自己人在界面上花的。
        // 同一笔预算，但超支的时候该去拧哪一边完全不同。
        relay: y4(relayRows.reduce((a, r) => a + (+r.cost || 0), 0)),
        relay_calls: relayRows.length,
        // 三张表都只回前 50——界面上画的就是 50 行（多出来的在服务端就切掉，不占回包）。
        // 不切的话「按人」这张是跟着公司人数长的：三千人全跑过任务，它就是三千行。
        // groups 把真实组数带上，免得五十被当成全部
        by_key: done(byKey).slice(0, 50), by_user: done(byUser).slice(0, 50), by_model: done(byModel).slice(0, 50),
        groups: { keys: byKey.size, users: byUser.size, models: byModel.size },
        // 单位跟着数一起发。前端自己推的话，以后改了哪一路的计量口径
        // （比如语音合成从千字符改成万字符），页面会静静地多显示十倍。
        by_cap: done(byCap).map((c) => ({ ...c, unit: (pricing.UNITS[c.key] || {}).unit || "" })),
      },
      caps: vkeys.CAPS.map((c) => ({ key: c, label: vkeys.CAP_CN[c] || c })),
      prefix: vkeys.PREFIX,
    };
    out.spend.internal = y4(out.spend.total - out.spend.relay);
    out.spend.internal_calls = rows.length - relayRows.length;
    // 价目是**整台服务器**一份的（config.prices），按本文件开头那条线归平台管理员。
    // 组织管理员看得到自己花了多少，看不到也改不了单价。
    if (platformAdmin(req.user)) {
      // seen / seen_units 是本月真调过的那些，交给 catalog 去比对价目表。
      // 拿不到价的那几行会单列成一张催填的单子——这是「认不出的型号 ≠ 0 元」
      // 这条规矩唯一的出口：不催的话，那几笔就永远记成 0，而钱是真花了的。
      const cat = pricing.catalog({
        config: cfg,
        seen: rows.filter((r) => !r.cap || r.cap === "chat" || r.cap === "embedding").map((r) => r.model),
        seen_units: rows.filter((r) => r.cap && pricing.UNITS[r.cap]).map((r) => ({ cap: r.cap, model: r.price_key || r.model })),
      });
      out.prices = cat.rows;
      out.prices_missing = cat.missing;
      out.unit_prices = cat.units;
      out.unit_missing = cat.unit_missing;
      out.prices_as_of = cat.as_of;
      out.usd_cny = cat.usd_cny;
    }
    return out;
  }));

  /**
   * 发一把新 Key。明文**只在这一次返回**，之后库里只有 sha256。
   * 不给「再看一次」的入口：能再看一次的东西就不是只有对方知道，
   * 而这把 Key 的全部意义就是「拿着它的程序就是他」。丢了重发一把，这是便宜操作。
   */
  router.post("/api/admin/relay/keys", account.adminOnly, guarded((req) => {
    const b = { ...(req.body || {}) };
    const orgId = org.orgIdOf(req.user);
    // 归属必须是本组织真有的人。写错一个字母的后果不是报错，是**静默**：
    // billingUser 查不到人 → 个人预算那一档整个跳过 → 这把 Key 只受组织总额限制。
    // 「设了但没生效」的预算比没设更糟，所以在能拦住的地方拦住。
    if (b.user) {
      const who = account.findMember(orgId, b.user);
      if (!who) throw new Error(`这个组织里没有「${String(b.user).trim()}」这个人——归属写错了的话，他那一档月预算就成了摆设`);
      b.user = who.username;
    }
    // 一个组织两百把够用了。不设上限的话，一个循环调用能把 vkeys.json 撑到读不动，
    // 而这个文件在**每一次** API 转发的验 Key 那一步都要整本读一遍。
    if (vkeys.list({ org: orgId }).length >= 200) throw new Error("这个组织已经有 200 把 Key 了，先把不用的删掉或停用");
    const created = vkeys.create({ ...b, org: orgId, by: req.user.username });
    org.audit({ org: orgId, actor: req.user.username, action: "发放中转 Key", target: created.key.name || created.key.id, detail: b.user ? "归属 " + b.user : "没挂到人" });
    return { ok: true, ...created };
  }));

  router.post("/api/admin/relay/keys/:id", account.adminOnly, guarded((req) => {
    const orgId = org.orgIdOf(req.user);
    // 跨组织改不了。Key 上写着 org，但路径里只有 id——不核这一遍的话，
    // 甲公司的管理员凭一个 id 就能把乙公司的 Key 停掉。
    const mine = vkeys.list({ org: orgId }).find((k) => k.id === req.params.id);
    if (!mine) throw new Error("这把 Key 不在你的组织里");
    const b = req.body || {};
    const k = b.revoke ? vkeys.revoke(req.params.id, req.user.username) : vkeys.update(req.params.id, b);
    org.audit({ org: orgId, actor: req.user.username, action: b.revoke ? "吊销中转 Key" : "改中转 Key", target: k.name || k.id });
    return { ok: true, key: k };
  }));

  router.delete("/api/admin/relay/keys/:id", account.adminOnly, guarded((req) => {
    const orgId = org.orgIdOf(req.user);
    const mine = vkeys.list({ org: orgId }).find((k) => k.id === req.params.id);
    if (!mine) throw new Error("这把 Key 不在你的组织里");
    vkeys.remove(req.params.id);   // 用过的删不掉，vkeys.js 里拦着：删了它花过的钱就成了无主账
    org.audit({ org: orgId, actor: req.user.username, action: "删除中转 Key", target: mine.name || mine.id });
    return { ok: true };
  }));

  /** 组织总预算、人均默认预算、折扣。走 org.updateOrg，normalizeBudget 那一道拍干净绕不过去 */
  router.post("/api/admin/relay/budget", account.adminOnly, guarded((req) => {
    const b = req.body || {};
    const patch = {};
    if (b.budget !== undefined) patch.budget = b.budget;
    if (b.price_discount !== undefined) patch.price_discount = b.price_discount;
    if (!Object.keys(patch).length) throw new Error("没说要改什么");
    const o = org.updateOrg(org.orgIdOf(req.user), { settings: patch }, req.user.username);
    const st = org.settingsOf(o);
    // 上限改了，「已用多少」的进程内缓存得扔掉。不扔的话，刚把上限从 100 提到 1000，
    // 下一个请求仍按旧数算「还差多远」——管理员会以为没生效，然后再改一次。
    budget.invalidate();
    return { ok: true, budget: st.budget, price_discount: st.price_discount };
  }));

  /** 一个人的 API 月预算。跟月额度分开走一条，因为它管的是另一本账（见 account.publicUser 里那段） */
  router.post("/api/admin/relay/members/:name", account.adminOnly, guarded((req) => {
    const m = account.setMember(req.user, req.params.name, { budget_yuan: (req.body || {}).budget_yuan });
    budget.invalidate();
    return { ok: true, member: m };
  }));

  /**
   * 改价目。**平台管理员**才行：价目是整台服务器一份的（config.prices），
   * 一个组织的管理员把单价改成 0，受影响的是所有组织的账。
   *
   * 只认三格（in / out / cached_in，元/百万 token），别的一律丢掉——
   * 这张表会被 pricing.tableFor 覆盖到内置价目上面去，塞进一个 __proto__ 之类的键
   * 等于往合并结果里注入东西。值那一层由 normalizeRow 挡，键这一层在这儿挡。
   */
  router.post("/api/admin/relay/prices", platformOnly, guarded((req) => {
    const b = req.body || {};
    const cfg = safeCall(deps.readConfig, null) || {};
    const table = cfg.prices && typeof cfg.prices === "object" && !Array.isArray(cfg.prices) ? { ...cfg.prices } : {};
    const model = String(b.model || "").trim().toLowerCase();
    if (!model || model.length > 120) throw new Error("没写型号名");
    if (["__proto__", "constructor", "prototype"].includes(model)) throw new Error("这个名字不能当型号名");
    if (b.remove) delete table[model];
    else {
      const row = pricing._internals.normalizeRow(b);
      if (!row) throw new Error("输入价和输出价至少得填一个，而且都得是非负数");
      table[model] = row;
    }
    cfg.prices = table;
    safeCall(deps.saveConfig, undefined);
    org.audit({ org: org.orgIdOf(req.user), actor: req.user.username, action: b.remove ? "删价目" : "改价目", target: model });
    const merged = pricing.tableFor({ config: cfg });
    return { ok: true, prices: Object.entries(merged.table).map(([m, r]) => ({ model: m, ...r, src: merged.from[m] })).sort((x, y) => x.model.localeCompare(y.model)) };
  }));

  /**
   * 改按量计价的那五路（搜索 / 生图 / 生视频 / 语音合成 / 语音转写）的单价。
   *
   * 跟上面改 token 价目分成两条路，而不是合成一条：两边的**单位不一样**。
   * 合成一条的话，一个写错字段名的请求会把「0.14 元/张」当成「0.14 元/百万 token」
   * 写进另一张表，而两边都不会报错——这种错到月底对账才会被发现。
   */
  router.post("/api/admin/relay/unit-prices", platformOnly, guarded((req) => {
    const b = req.body || {};
    const cfg = safeCall(deps.readConfig, null) || {};
    const cap = String(b.cap || "").trim();
    if (!pricing.UNITS[cap]) throw new Error(`没有「${cap}」这一路，只有：${pricing.UNIT_CAPS.join(" / ")}`);
    const all = cfg.unit_prices && typeof cfg.unit_prices === "object" && !Array.isArray(cfg.unit_prices) ? { ...cfg.unit_prices } : {};
    const table = all[cap] && typeof all[cap] === "object" && !Array.isArray(all[cap]) ? { ...all[cap] } : {};
    const model = String(b.model || "").trim().toLowerCase();
    if (!model || model.length > 120) throw new Error("没写型号名");
    if (["__proto__", "constructor", "prototype"].includes(model)) throw new Error("这个名字不能当型号名");
    if (b.remove) delete table[model];
    else {
      const row = pricing._internals.normalizeUnitRow(b.price === undefined ? b : { price: b.price, note: b.note });
      if (!row) throw new Error(`单价得是个非负数（元 / ${pricing.UNITS[cap].unit}）`);
      table[model] = row;
    }
    all[cap] = table;
    cfg.unit_prices = all;
    safeCall(deps.saveConfig, undefined);
    org.audit({ org: org.orgIdOf(req.user), actor: req.user.username, action: b.remove ? "删单价" : "改单价", target: `${pricing.UNITS[cap].cn} ${model}` });
    const cat = pricing.catalog({ config: cfg });
    return { ok: true, unit_prices: cat.units };
  }));

  // ---------- 组织管理（平台管理员）----------
  router.get("/api/admin/orgs", platformOwnerOnly, guarded(() => {
    // 这一页每家公司只显示两个数字：几个人、几个在用。以前是一家一家去查成员列表，
    // 那个函数要算每个人的额度余额、还要为「最后活跃」翻一遍用量账本——
    // 61 家公司换一张 38 KB 的表，要读 62 遍 users.json、61 遍用量账本，
    // 合计 35.6 MB 的盘、159ms；121 家时 98.3 MB、388ms。
    // 这一页是平台管理员开后台第一眼看的东西，卖成多租户之后「组织数量是个位数」
    // 这个前提就不成立了。现在整本账数一遍，剩下的都是内存里的加法。
    const counts = account.memberCounts();
    return {
      orgs: org.listOrgs().map((o) => {
        const c = counts.get(o.id) || { members: 0, active: 0 };
        return { ...o, settings: org.settingsOf(o), ...org.planInfo(o), members: c.members, active: c.active };
      }),
      plans: org.PLANS, plan_order: org.PLAN_ORDER,
    };
  }));
  router.post("/api/admin/orgs", platformOwnerOnly, guarded((req) =>
    org.createOrg({ ...(req.body || {}), actor: req.user.username })));
  router.post("/api/admin/orgs/:id", platformOwnerOnly, guarded((req) =>
    ({ ok: true, org: org.updateOrg(req.params.id, req.body || {}, req.user.username) })));

  // ---------- 审计 ----------
  router.get("/api/admin/audit", guarded((req) =>
    org.listAudit(org.orgIdOf(req.user), {
      from: req.query.from, to: req.query.to, q: req.query.q,
      actor: req.query.actor, action: req.query.action,
      offset: req.query.offset, limit: req.query.limit,
    })));

  // ---------- 数据统计 ----------
  router.get("/api/admin/stats", guarded((req) => {
    const sum = account.usageSummary(req.user, { limit: 500 });
    // 这一页要的是「几个人」这一个数。以前是把全员算一遍再取 .length——每人算角色、
    // 额度、本月剩余、余额，还要为「最后活跃」翻一遍用量账本，换一个整数。
    // memberStats 只数不算，口径一样（停用的人照样算人头，他账号还在）
    const memberCount = account.memberStats(org.orgIdOf(req.user)).total;
    const runs = sum.recent.filter((e) => e.kind === "run");
    const active = new Set(runs.filter((e) => e.day === sum.last7[6].day).map((e) => e.user));
    return {
      totals: {
        members: memberCount,
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
