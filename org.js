"use strict";
/**
 * 组织（租户）层 —— 企业版的地基。
 *
 * 数据文件：data/orgs.json
 *   { orgs: [...], depts: [...], invites: [...], audit: [...] }
 *
 * 三条设计红线，改这个文件之前先看一眼：
 *
 * 1）**默认组织的工作目录必须还是原来那个 workspace 根**。老用户升级上来，账号里没有 org 字段，
 *    一律当成 default 组织；default 的根就是 config.workspace_dir 本身。任何「统一放到
 *    tenants/<id>/ 下面」的整齐做法，代价都是老用户的历史成果一夜之间从界面上消失。
 *
 * 2）**新组织的根放在 data/tenants/<id> 下，不放在 workspace 里**。放在 workspace 里的话，
 *    default 组织的人列文件时会把别的租户的目录名、文件名、大小全看见——隔离做了一半等于没做。
 *
 * 3）**没有第二个组织时，这一层要完全隐身**。单机个人版不该因为加了企业能力就多出一堆概念，
 *    所以 multiTenant() 为假时管理后台只显示成员/用量，不显示组织切换。
 */

const path = require("path");
const crypto = require("crypto");
const { dataPath } = require("./paths");
const store = require("./store");
const rbac = require("./rbac"); // 能授出去的角色只有那一张表说了算

// OPENWORKBUDDY_DATA_DIR 与 account.js 同一个口子：跑测试时指到临时目录
const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data");
const ORGS_FILE = path.join(DATA_DIR, "orgs.json");

const DEFAULT_ORG = "default";
const AUDIT_CAP = 1000;

/**
 * 套餐档位。seats / monthly_credits 只是**默认值**，每个组织可以在企业设置里单独改；
 * 这里给的是「选了这一档，默认给多少」，不是硬上限。
 * 到期时间为 null = 永久（自建部署的常态：你自己的服务器，不该被一个日期锁死）。
 */
const PLANS = {
  free: { label: "免费版", seats: 3, monthly_credits: 0 },
  team: { label: "团队版", seats: 20, monthly_credits: 20000 },
  pro: { label: "专业版", seats: 100, monthly_credits: 100000 },
  flagship: { label: "旗舰版", seats: 500, monthly_credits: 500000 },
};
const PLAN_ORDER = ["free", "team", "pro", "flagship"];

/** 组织默认设置。读的时候一律用 settingsOf() 兜一遍，老数据缺字段不该让页面白屏 */
const ORG_DEFAULTS = {
  open_register: false,      // 开不开放自助注册
  need_approval: true,       // 自助注册进来的人要不要管理员点头（开放注册时才有意义）
  credits_enabled: false,    // 用量闸门：默认关，见 account.js 里那段说明
  member_monthly_credits: 0, // 每人每月固定用量（0 = 不发月额度，只用加油包余额）
  default_member_credits: 1000, // 新成员的加油包初始余额
  // 下面四条是**真的会拦人**的，不是摆设：
  //   allow_shell → tools.js 的 run_shell / run_node（连工具定义一起摘掉）
  //   net_allow / net_deny → tools.js 的 fetch_url / render_page 按域名放行
  //   session_days → account.js 判令牌过期（改小了，已经发出去的 cookie 立刻作废）
  // 加新开关之前先想清楚谁来执行它。「配了但没人读」的开关比没有这个开关更糟：
  // 管理员以为已经关掉了，实际一直开着。
  allow_shell: true,            // 允不允许 run_shell / run_node
  net_allow: [],                // 网络设置：抓网页的域名白名单（空 = 不限）
  net_deny: [],                 // 域名黑名单（优先于白名单）
  session_days: 90,             // 登录令牌有效期（天），1 - 365
  // 密码与二次验证。三条都由 account.js 执行：
  //   password_min / password_strong → 注册、改密码、管理员重置 三个入口一起管
  //   require_2fa → 开了之后，没绑二次验证的人登进来只能先去绑，别的什么都干不了
  password_min: 6,              // 密码最短位数，6 - 64
  password_strong: false,       // 要不要求大小写字母 / 数字 / 符号里至少凑够三类
  require_2fa: false,           // 全组织强制二次验证
  // 远程那两件事。**默认都关**：装上就能从外面连进来，这种默认不该由我们替用户做决定——
  //   他不一定知道自己刚把什么暴露到了局域网上。要用的人去后台自己打开，一次点两下的事。
  //   两条都由真正的路由执行，不是摆设：
  //   remote_devices → account.js 的 /api/devices/pair|claim 三条口子；**关掉的同时，
  //     已经配过的设备下一次请求就被踢下线**（不然这个开关是假的：你以为手机断了，其实没断）
  //   remote_control → server.js 的 /api/cli/* 五条口子（看终端里在跑什么、插话、替它批准）
  remote_devices: false,        // 允不允许扫码把手机 / 另一台电脑加进来
  remote_control: false,        // 允不允许从网页 / 手机操控终端里正在跑的任务
  // 按次计费的第三方 API（搜索 / 生图 / 生视频 / 配音 / 转写 / 抓网页）各自的额度闸门。
  // 一路一个 { enabled, org_daily, org_monthly, user_daily }，默认空表 = 全部不限。
  // 清单和默认值在 quota.js，执行在 tools.js 每个付费调用点上。
  api_quota: {},
  // 部门权限模板：{ "销售部": { role, monthly_quota, budget_yuan } }。办入职时按部门套用（见 lifecycle.js）。
  // 跟上面那些开关不一样，它是张表不是一个值——下面 updateOrg 里得走 normalizeDeptTemplates，
  // 不能走 String(v) 那条（会存成 "[object Object]"）。
  dept_templates: {},
  // ---- API 中转站：钱那一路 ----
  // 这两格由 budget.js / pricing.js 执行，执行点在 relay.js 每一次转发之前和之后。
  //   budget.org_yuan          整个组织每月封顶多少钱（0 = 不限）
  //   budget.default_user_yuan 没单独设过的人，每人每月封顶多少（0 = 不限）
  // 为什么是「元」不是「次」：一次 gpt-4o 的调用和一次 gpt-4o-mini 的调用差三十倍，
  // 按次数封顶的话，同样一个数对两个人的意义完全不同。
  budget: { org_yuan: 0, default_user_yuan: 0 },
  // 跟上游谈下来的折扣，夹在 (0,1] 里。0.8 = 八折。**只影响记账，不影响转发**——
  // 它改的是我们记在自己账本上的那个数，上游照旧按原价扣我们的。
  price_discount: 1,
};

/**
 * 部门模板拍干净。**必须有这一道**：企业设置那条路由是把请求体里的 settings 整个交进来的，
 * 认了这个键就等于认了请求体能往组织设置里写一张任意结构的表——
 * 里头塞个 role:"superadmin" 之类的字段，办入职时就照着建号了。
 */
function normalizeDeptTemplates(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [k, t] of Object.entries(v).slice(0, 200)) {
    const dept = String(k || "").trim().slice(0, 40);
    if (!dept || !t || typeof t !== "object") continue;
    const q = t.monthly_quota === undefined || t.monthly_quota === null || t.monthly_quota === ""
      ? null : Math.max(0, Math.floor(+t.monthly_quota) || 0);
    // budget_yuan：这个部门的人每月在中转站上封顶多少钱。budget.js 的 limitsOf 会读它
    // （个人设置 > 部门模板 > 组织默认）。以前这一格在这里被悄悄丢掉：模板上填了、
    // 存下来没有，于是「按部门给预算」这件事在界面上能填、在执行时永远是 0 = 不限。
    out[dept] = {
      role: rbac.ASSIGNABLE.includes(t.role) ? t.role : "member",
      monthly_quota: q,
      budget_yuan: money(t.budget_yuan),
    };
  }
  return out;
}

/**
 * 钱一律按元存成非负有限小数，最多两位。
 *
 * 不用 Math.floor：预算和折扣都是钱，「50.5 元」取整成 50 是把管理员填的数改了。
 * 也不接受负数和 NaN —— 一个负的上限会让 budget.js 里的「够不够」永远为假，
 * 表现是整个组织突然一个请求都发不出去，而设置页上看着一切正常。
 */
function money(x) {
  const n = typeof x === "string" ? parseFloat(x) : x;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

/**
 * 预算那张表拍干净。**必须有这一道**，理由跟 normalizeDeptTemplates 一模一样：
 * 企业设置那条路由把请求体里的 settings 整个交进来，认了 budget 这个键就等于认了
 * 请求体能往组织设置里写一张任意结构的表。这里只认两格，别的一律丢掉。
 */
function normalizeBudget(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { org_yuan: 0, default_user_yuan: 0 };
  return { org_yuan: money(v.org_yuan), default_user_yuan: money(v.default_user_yuan) };
}

/** 有范围的数字开关：存之前夹住，界面上显示的就是真正执行的那个值 */
const SETTING_RANGE = {
  session_days: [1, 365],
  password_min: [6, 64],
};

function emptyDb() {
  return { orgs: [], depts: [], invites: [], audit: [] };
}
function load() {
  // strict：读不出来就抛，绝不能拿空壳把整个组织表覆盖掉（理由同 account.js 的 readStore）
  const d = store.readJson(ORGS_FILE, emptyDb(), { strict: true });
  return {
    orgs: Array.isArray(d.orgs) ? d.orgs : [],
    depts: Array.isArray(d.depts) ? d.depts : [],
    invites: Array.isArray(d.invites) ? d.invites : [],
    audit: Array.isArray(d.audit) ? d.audit : [],
  };
}
function save(db) {
  db.audit = (db.audit || []).slice(0, AUDIT_CAP);
  // 跟 users.json 一个待遇（0600）：这本里有**还没用完的邀请码**（拿到就能自己开号进来，
  // 角色还是发码的人预置好的）和整本审计流水（谁什么时候放行了哪条命令）。默认 0644 等于摊开给同机器上别的账号看
  store.writeJsonAtomic(ORGS_FILE, db, { pretty: true, mode: store.SECRET_MODE });
}

function newId(prefix) {
  return prefix + crypto.randomBytes(5).toString("hex");
}

/** 默认组织：文件里没有就当场补一条（第一次跑、或者从老版本升上来） */
function ensureDefault(db) {
  let o = db.orgs.find((x) => x.id === DEFAULT_ORG);
  if (!o) {
    o = {
      id: DEFAULT_ORG,
      name: "我的团队",
      plan: "free",
      seats: PLANS.free.seats,
      expires_at: null,
      root_dir: "",           // 空 = 用 config.workspace_dir 本身，见文件头第 1 条
      created_at: new Date().toISOString(),
      settings: { ...ORG_DEFAULTS },
    };
    db.orgs.unshift(o);
  }
  return o;
}

function settingsOf(org) {
  return { ...ORG_DEFAULTS, ...((org && org.settings) || {}) };
}

function listOrgs() {
  const db = load();
  const before = db.orgs.length;
  ensureDefault(db);
  if (db.orgs.length !== before) save(db);
  return db.orgs;
}
function getOrg(id) {
  const want = id || DEFAULT_ORG;
  return listOrgs().find((o) => o.id === want) || listOrgs().find((o) => o.id === DEFAULT_ORG);
}
/** 有没有开第二个组织。为假时整套「组织」概念对界面隐身 */
function multiTenant() {
  return listOrgs().length > 1;
}

/** 用户属于哪个组织。老账号没有 org 字段 → 默认组织 */
function orgIdOf(user) {
  return (user && user.org) || DEFAULT_ORG;
}

/**
 * 组织的工作目录根（绝对路径）。
 * @param baseWorkspace 当前 config.workspace_dir（由调用方传进来，org.js 不去 require tools.js，
 *   否则 tools ↔ org 循环依赖）
 */
function rootDirOf(org, baseWorkspace) {
  if (!org || org.id === DEFAULT_ORG) return baseWorkspace;
  if (org.root_dir) return path.resolve(org.root_dir);
  return path.join(DATA_DIR, "tenants", org.id);
}

function createOrg({ name, plan, seats, expires_at, actor }) {
  const db = load();
  ensureDefault(db);
  const nm = String(name || "").trim();
  if (!nm) throw new Error("组织名不能为空");
  if (nm.length > 40) throw new Error("组织名最多 40 个字");
  if (db.orgs.some((o) => o.name === nm)) throw new Error("同名组织已存在");
  const p = PLANS[plan] ? plan : "free";
  const org = {
    id: newId("o_"),
    name: nm,
    plan: p,
    seats: Number.isFinite(+seats) && +seats > 0 ? Math.floor(+seats) : PLANS[p].seats,
    expires_at: expires_at || null,
    root_dir: "",
    created_at: new Date().toISOString(),
    settings: { ...ORG_DEFAULTS, member_monthly_credits: PLANS[p].monthly_credits },
  };
  db.orgs.push(org);
  pushAudit(db, { org: org.id, actor, action: "创建组织", target: org.name, detail: `套餐 ${PLANS[p].label}` });
  save(db);
  return org;
}

const ORG_PATCHABLE = ["name", "plan", "seats", "expires_at", "root_dir"];
function updateOrg(id, patch, actor) {
  const db = load();
  ensureDefault(db);
  const org = db.orgs.find((o) => o.id === (id || DEFAULT_ORG));
  if (!org) throw new Error("组织不存在");
  const changed = [];
  for (const k of ORG_PATCHABLE) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === "name") {
      v = String(v || "").trim();
      if (!v) throw new Error("组织名不能为空");
      if (v.length > 40) throw new Error("组织名最多 40 个字");
    }
    if (k === "plan") {
      if (!PLANS[v]) throw new Error("没有这个套餐档位");
    }
    if (k === "seats") {
      v = Math.floor(+v);
      if (!(v >= 1 && v <= 100000)) throw new Error("席位数需在 1 - 100000 之间");
    }
    if (k === "expires_at" && v) {
      if (Number.isNaN(Date.parse(v))) throw new Error("到期时间不是个有效日期");
    }
    if (String(org[k] == null ? "" : org[k]) === String(v == null ? "" : v)) continue;
    org[k] = v;
    changed.push(k);
  }
  if (patch.settings && typeof patch.settings === "object") {
    const s = settingsOf(org);
    for (const [k, v] of Object.entries(patch.settings)) {
      if (!(k in ORG_DEFAULTS)) continue; // 只认已知开关，别让请求体往设置里塞任意字段
      const cast =
        typeof ORG_DEFAULTS[k] === "boolean" ? !!v
          // 折扣是**小数**，不能走下面那条 Math.floor：0.8 会被取整成 0，
          // 而 0 在 pricing.discountOf 里等于「填错了」，于是八折悄悄变回原价。
          // 上下都夹住：填 0 或者负数不是「全免」，是填错了，按不打折算，宁可多收。
          : k === "price_discount" ? Math.min(1, money(v) || 1)
          : typeof ORG_DEFAULTS[k] === "number" ? Math.max(0, Math.floor(+v) || 0)
          : Array.isArray(ORG_DEFAULTS[k]) ? (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 200) : [])
          // api_quota 是张表，不是一个值：交给 quota.js 拍干净（只认清单里的能力，数字一律非负整数）。
          // 不能走 String(v) 那条 —— 那会把整张表存成 "[object Object]"。
          : k === "api_quota" ? require("./quota").normalizeTable(v)
          : k === "dept_templates" ? normalizeDeptTemplates(v)
          : k === "budget" ? normalizeBudget(v)
          : String(v);
      // 有范围的数字必须在**存进去的时候**就夹住。只在读的那头夹，界面会显示 3、
      // 实际按 6 执行——管理员看到的和系统执行的不是一件事，这种设置比没有还难查。
      const R = SETTING_RANGE[k];
      const val = R ? Math.min(R[1], Math.max(R[0], cast)) : cast;
      if (JSON.stringify(s[k]) === JSON.stringify(val)) continue;
      s[k] = val;
      changed.push("设置." + k);
    }
    org.settings = s;
  }
  if (changed.length) {
    pushAudit(db, { org: org.id, actor, action: "改企业设置", target: org.name, detail: changed.join("、") });
    save(db);
  }
  return org;
}

/** 套餐信息 + 有没有过期。过期不锁死功能，只在后台亮红——自建部署里锁死等于自己砸自己的服务 */
function planInfo(org) {
  const o = org || getOrg(DEFAULT_ORG);
  const plan = PLANS[o.plan] ? o.plan : "free";
  const exp = o.expires_at ? Date.parse(o.expires_at) : null;
  return {
    plan,
    label: PLANS[plan].label,
    seats: o.seats || PLANS[plan].seats,
    expires_at: o.expires_at || null,
    expired: !!(exp && exp < Date.now()),
    days_left: exp ? Math.ceil((exp - Date.now()) / 86400000) : null,
  };
}

// ---------- 部门 ----------
function listDepts(orgId) {
  return load().depts.filter((d) => d.org === (orgId || DEFAULT_ORG));
}
function addDept(orgId, name, actor) {
  const db = load();
  const nm = String(name || "").trim();
  if (!nm) throw new Error("部门名不能为空");
  if (nm.length > 24) throw new Error("部门名最多 24 个字");
  const org = orgId || DEFAULT_ORG;
  if (db.depts.some((d) => d.org === org && d.name === nm)) throw new Error("同名部门已存在");
  const d = { id: newId("d_"), org, name: nm, created_at: new Date().toISOString() };
  db.depts.push(d);
  pushAudit(db, { org, actor, action: "新建部门", target: nm });
  save(db);
  return d;
}
function removeDept(orgId, id, actor) {
  const db = load();
  const i = db.depts.findIndex((d) => d.id === id && d.org === (orgId || DEFAULT_ORG));
  if (i < 0) throw new Error("部门不存在");
  const [d] = db.depts.splice(i, 1);
  pushAudit(db, { org: d.org, actor, action: "删除部门", target: d.name });
  save(db);
  return d;
}

// ---------- 邀请码 ----------
/**
 * 邀请码比「开放注册」安全得多：开放注册是把大门拆了，邀请码是发钥匙——能限次数、能设过期、
 * 能预先指定角色和部门，撤销也只影响还没用的那批人。所以后台默认引导用邀请码。
 */
function createInvite(orgId, { role, dept, max_uses, days, actor }) {
  const db = load();
  const org = orgId || DEFAULT_ORG;
  const code = crypto.randomBytes(6).toString("hex").toUpperCase();
  const inv = {
    code,
    org,
    // 邀请码永远造不出超级管理员：那一档只能由现任转让（rbac.js 文件头）。
    // 「发得了管理员的码吗」在 admin.js 那条路由上按发码人的档次判，这里是最后一道兜底
    role: rbac.ASSIGNABLE.includes(role) ? role : "member",
    dept: String(dept || ""),
    max_uses: Math.max(1, Math.min(1000, Math.floor(+max_uses) || 1)),
    uses: 0,
    expires_at: new Date(Date.now() + Math.max(1, Math.min(365, Math.floor(+days) || 7)) * 86400000).toISOString(),
    created_by: actor || "",
    created_at: new Date().toISOString(),
  };
  db.invites.unshift(inv);
  db.invites = db.invites.slice(0, 200);
  pushAudit(db, { org, actor, action: "生成邀请码", target: code, detail: `${inv.role} · ${inv.max_uses} 次 · ${new Date(inv.expires_at).toLocaleDateString("zh-CN")} 到期` });
  save(db);
  return inv;
}
function listInvites(orgId) {
  const now = Date.now();
  return load().invites
    .filter((i) => i.org === (orgId || DEFAULT_ORG))
    .map((i) => ({ ...i, expired: Date.parse(i.expires_at) < now, used_up: i.uses >= i.max_uses }));
}
/** 查邀请码但**不**记数——注册流程里先查后建号，建号可能失败，不能先把次数扣了 */
function peekInvite(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  const inv = load().invites.find((i) => i.code === c);
  if (!inv) return null;
  if (Date.parse(inv.expires_at) < Date.now()) return { ...inv, error: "邀请码已过期" };
  if (inv.uses >= inv.max_uses) return { ...inv, error: "邀请码用完了" };
  return inv;
}
/** 真正记一次使用。建号成功之后才调 */
function consumeInvite(code, who) {
  const db = load();
  const inv = db.invites.find((i) => i.code === String(code || "").trim().toUpperCase());
  if (!inv) return null;
  inv.uses++;
  pushAudit(db, { org: inv.org, actor: who, action: "使用邀请码", target: inv.code });
  save(db);
  return inv;
}
function revokeInvite(orgId, code, actor) {
  const db = load();
  const i = db.invites.findIndex((x) => x.code === code && x.org === (orgId || DEFAULT_ORG));
  if (i < 0) throw new Error("邀请码不存在");
  const [inv] = db.invites.splice(i, 1);
  pushAudit(db, { org: inv.org, actor, action: "撤销邀请码", target: inv.code });
  save(db);
  return inv;
}

// ---------- 审计 ----------
function pushAudit(db, e) {
  db.audit.unshift({
    ts: new Date().toISOString(),
    org: e.org || DEFAULT_ORG,
    actor: e.actor || "系统",
    action: e.action,
    target: e.target || "",
    detail: e.detail || "",
  });
}
/** 给外部调用的单条写入（管理成员那些操作在 account.js 里发生，走这个口子记账） */
function audit(e) {
  const db = load();
  ensureDefault(db);
  pushAudit(db, e);
  save(db);
}
/**
 * 审计流水。opts：from/to（`YYYY-MM-DD` 闭区间）、q（操作人/动作/对象/详情里搜）、
 * actor、action、offset/limit。返回 { audit, total, offset, limit }——
 * total 是符合筛选的总条数，界面靠它决定还能不能往下翻。
 *
 * 第二个参数以前是个裸 limit（`listAudit(org, 300)`），这里兼容着：传数字还是当 limit。
 * 合规的人来看这张表，第一句问的就是「9 月 3 号谁动了额度」——没有时间范围就只能干瞪眼。
 */
function listAudit(orgId, opts) {
  if (typeof opts === "number" || typeof opts === "string") opts = { limit: opts };
  opts = opts || {};
  const all = load().audit.filter((a) => a.org === (orgId || DEFAULT_ORG));
  const from = String(opts.from || "").slice(0, 10);
  const to = String(opts.to || "").slice(0, 10);
  const needle = String(opts.q || "").trim().toLowerCase();
  const actor = String(opts.actor || "").trim();
  const action = String(opts.action || "").trim();
  const picked = all.filter((a) => {
    const d = String(a.ts || "").slice(0, 10);
    if (from && (!d || d < from)) return false;
    if (to && (!d || d > to)) return false;
    if (actor && a.actor !== actor) return false;
    if (action && a.action !== action) return false;
    if (needle && ![a.actor, a.action, a.target, a.detail].some((x) => String(x || "").toLowerCase().includes(needle))) return false;
    return true;
  });
  const offset = Math.max(0, Math.floor(+opts.offset || 0));
  const limit = Math.max(1, Math.min(1000, Math.floor(+opts.limit || 200)));
  return {
    audit: picked.slice(offset, offset + limit),
    total: picked.length,
    offset,
    limit,
    // 筛选栏的下拉项要列全，所以从**未筛选**的全集里取，不然选了一个动作之后
    // 下拉里就只剩这一个，人再也选不回去
    actors: [...new Set(all.map((a) => a.actor).filter(Boolean))].sort(),
    actions: [...new Set(all.map((a) => a.action).filter(Boolean))].sort(),
  };
}

module.exports = {
  DEFAULT_ORG, PLANS, PLAN_ORDER, ORG_DEFAULTS,
  listOrgs, getOrg, createOrg, updateOrg, multiTenant, orgIdOf, rootDirOf, settingsOf, planInfo,
  normalizeBudget, normalizeDeptTemplates,
  listDepts, addDept, removeDept,
  createInvite, listInvites, peekInvite, consumeInvite, revokeInvite,
  audit, listAudit,
  _internals: { load, save, ensureDefault, ORGS_FILE, newId },
};
