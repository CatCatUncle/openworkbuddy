"use strict";
/**
 * 入职与离职 —— 一个人进公司要开哪些口子，走了要关哪些口子。
 *
 * 为什么单独一个文件、而不是在管理后台里点几下就完事：
 *
 * 「停用」这个动作以前只做了一件事——把登录令牌删掉。但一个用了半年的账号，
 * 手上攥着的远不止一个 cookie：
 *
 *   · 扫码连上来的手机 / 平板（kind:"paired" 的令牌，跟浏览器那条不是一码事）
 *   · 名下的定时任务。**这条最要命**：人走了，他排的「每周一早八拉上月回款发给张总」
 *     照跑不误，花的是公司的额度，结果推到的是他自己的企业微信/钉钉。
 *     停用账号一个字都拦不住它——定时任务走的是调度器，不过登录闸。
 *   · 他以管理员身份发出去的邀请码。还没到期、还没用完，谁捡到谁就能注册进来，
 *     角色还是他当初设的那个。人走了三个月，码还活着。
 *   · 绑在他手机上的二次验证。账号万一被谁重新启用，那把钥匙还在他兜里。
 *   · 正在跑的任务。掐不掉的话，他走出公司大门的那一刻，屏幕上那个任务还在读文件。
 *
 * 这五件事分散在 account / scheduler / org / server 四个地方，靠人记得一件件去点，
 * 就等于靠人记得。所以收成一个函数：**一次调用，关完，出回执**。
 * 回执要能贴进离职交接单里——写明关了什么、留了什么、为什么留。
 *
 * 一条设计原则贯穿全文件：**关权限，不删数据**。
 * 他跑过的任务、花过的额度、写出来的文件、留下的审计，一律原样留着。
 * 人走了账还得能对，去年的报告还得能翻出来。真要删是另一件事（数据出境/GDPR），
 * 走的是另一个口子，不该跟「办离职」混在一起——那是个按下去收不回来的按钮。
 */

const account = require("./account");
const org = require("./org");
const vkeys = require("./vkeys");
const scheduler = require("./scheduler");

/** 停用之后还想留着他名下排期的话，交接给谁。空 = 只停用不交接 */
function reassignTo(handover, list) {
  if (!handover || !list.length) return [];
  const sch = scheduler.activeScheduler();
  if (!sch || typeof sch.reassign !== "function") return [];
  const done = [];
  for (const t of list) {
    try { if (sch.reassign(t.id, handover)) done.push(t); } catch {}
  }
  return done;
}

/**
 * 办离职。返回一张回执，逐项写明关了什么。
 *
 * @param actor     操作人（必须是管理员，且只能管本组织的人——沿用 account 那边的 assertCanManage）
 * @param username  要办离职的人
 * @param opts.handover 把他名下的定时任务交接给谁（留空就只停用，不交接）
 * @param opts.keep2fa  别解绑二次验证（默认解绑）。极少用：法务要求保留原状取证时才传
 * @param opts.stopRuns 掐正在跑的任务用的回调，由 server.js 注入（纯命令行环境里没有）
 */
function offboard(actor, username, opts = {}) {
  const name = String(username || "").trim();
  if (!name) throw new Error("没说要给谁办离职");
  if (actor && actor.username === name) throw new Error("不能给自己办离职：手一抖就把自己锁在门外了，让另一个管理员来");

  const before = account._internals.loadUsers().users.find((u) => u.username === name);
  if (!before) throw new Error("成员不存在");
  const orgId = org.orgIdOf(before);

  // 只剩这一个管理员的时候不许办：办完就没人进得了后台了，
  // 连「把他重新启用」这一步都做不到——整个组织当场锁死
  if ((before.role === "admin") && (before.status || "active") !== "disabled") {
    const others = account._internals.loadUsers().users
      .filter((u) => u.username !== name && u.role === "admin" && (u.status || "active") === "active" && org.orgIdOf(u) === orgId);
    if (!others.length) throw new Error("他是这个组织**唯一**还在职的管理员。先把另一个人提成管理员，再来办他的离职——不然办完谁都进不了后台了");
  }

  const receipt = {
    user: name,
    display: before.display || before.username,
    dept: before.dept || "",
    role: before.role || "member",
    actor: (actor && actor.username) || "",
    at: new Date().toISOString(),
    revoked: {},   // 关掉了什么
    kept: {},      // 留着什么、为什么
    handed_to: "",
    warnings: [],
  };

  // ---- 1. 令牌。先数一遍再停用，不然停完就数不出来了（setMember 会当场删干净）
  const st = account._internals.loadUsers();
  const tokens = Object.values(st.tokens).filter((i) => i.user === name);
  receipt.revoked.tokens = tokens.length;
  receipt.revoked.devices = tokens.filter((i) => i.kind === "paired").length; // 扫码连上来的手机/平板

  // ---- 2. 账号停用。这一步顺带把上面那些令牌全删了（account.setMember 里做的）
  try {
    account.setMember(actor, name, { status: "disabled" });
    receipt.revoked.account = "已停用";
  } catch (e) {
    // 权限不够就整件事都别做了：半开半关的状态比没动过更难收拾
    throw e;
  }

  // ---- 3. 名下的定时任务
  const sch = scheduler.activeScheduler();
  if (sch && typeof sch.disableOwnedBy === "function") {
    const stopped = sch.disableOwnedBy(name);
    receipt.revoked.schedules = stopped.length;
    receipt.revoked.schedule_names = stopped.map((t) => t.name);
    if (opts.handover) {
      const moved = reassignTo(String(opts.handover), stopped);
      if (moved.length) {
        receipt.handed_to = String(opts.handover);
        receipt.kept.schedules_handed = moved.map((t) => t.name);
        receipt.warnings.push(`交接过去的 ${moved.length} 条排期仍然是**关着**的，${opts.handover} 确认内容之后自己打开`);
      }
    } else if (stopped.length) {
      receipt.warnings.push(`有 ${stopped.length} 条定时任务停了但没人接手，别忘了找人认领`);
    }
  } else {
    receipt.revoked.schedules = 0;
    receipt.warnings.push("这台机器上没有排期表（纯命令行模式），定时任务这一项跳过了");
  }

  // ---- 4. 他发出去、还活着的邀请码
  let codes = [];
  try {
    codes = org.listInvites(orgId).filter((i) => i.created_by === name && !i.expired && !i.used_up);
    for (const c of codes) { try { org.revokeInvite(orgId, c.code, (actor && actor.username) || ""); } catch {} }
  } catch {}
  receipt.revoked.invites = codes.length;

  // ---- 5. 中转站上他名下的虚拟 Key
  //
  // 这一条不接的话，前面四步全是白做的：停用账号关掉的是**他本人**登进来的路，
  // 而虚拟 Key 是发给程序的——那把 owb-sk-… 躺在某个业务系统的环境变量里，
  // 跟他还在不在职一点关系都没有，人走了它照样能调、照样按他的名字记账、
  // 照样花公司的钱。离职清单上最容易漏的就是这种「不需要他本人在场」的凭据。
  //
  // 用 revoke 不用 remove：吊销之后这把 Key 立刻失效（relay.js 验 Key 那一步直接 401），
  // 但那一行还留在表里——账要能对上，「上个月这 300 块是哪把 Key 花的」得查得到。
  let keys = [];
  try {
    keys = vkeys.ofUser(name);   // 只返回还启用着的那几把
    for (const k of keys) { try { vkeys.revoke(k.id, (actor && actor.username) || ""); } catch {} }
  } catch (e) { receipt.warnings.push("中转站的虚拟 Key 没吊销干净：" + e.message); }
  receipt.revoked.vkeys = keys.length;
  receipt.revoked.vkey_names = keys.map((k) => k.name || k.id);
  if (keys.length) {
    // 说清楚接下来会发生什么，不然最先发现的是业务方那边突然 401 了。
    receipt.warnings.push(`吊销了 ${keys.length} 把中转站 Key（${keys.map((k) => k.name || k.id).join("、")}）——正在用它们的程序下一次调用就会收到 401，先通知一下对接的人`);
  }

  // ---- 6. 二次验证解绑
  if (!opts.keep2fa) {
    try {
      if (account.twoFactorOn(before)) {
        account.disableTOTP(name, { byAdmin: true, actor: (actor && actor.username) || "" });
        receipt.revoked.two_factor = true;
      }
    } catch (e) { receipt.warnings.push("二次验证没解绑成功：" + e.message); }
  } else {
    receipt.kept.two_factor = "按要求保留原状";
  }

  // ---- 7. 正在跑的任务
  if (typeof opts.stopRuns === "function") {
    try { receipt.revoked.running = opts.stopRuns(name) || 0; } catch { receipt.revoked.running = 0; }
  }

  // ---- 留着的东西。写进回执是为了让交接的人知道去哪儿找，不是为了好看
  receipt.kept.usage = "用量流水原样保留（人走了账还得能对）";
  receipt.kept.sessions = "他的对话记录保留，本组织管理员仍可查阅";
  receipt.kept.files = "他产出的文件留在工作目录里，没动";
  receipt.kept.audit = "历史审计原样保留";

  const detail = [
    `令牌 ${receipt.revoked.tokens}`,
    receipt.revoked.devices ? `其中扫码设备 ${receipt.revoked.devices}` : "",
    `排期 ${receipt.revoked.schedules || 0}`,
    `邀请码 ${receipt.revoked.invites || 0}`,
    receipt.revoked.vkeys ? `中转站 Key ${receipt.revoked.vkeys}` : "",
    receipt.revoked.two_factor ? "已解绑二次验证" : "",
    receipt.handed_to ? `排期交接给 ${receipt.handed_to}` : "",
  ].filter(Boolean).join("、");
  org.audit({ org: orgId, actor: (actor && actor.username) || "", action: "办理离职", target: name, detail });

  return receipt;
}

/**
 * 办入职。建号 + 按部门模板配好权限，返回一次性密码。
 *
 * 为什么不直接用 createMember：那个只管建号，角色和额度得管理员一个个手填。
 * 一个部门招第三个人的时候，前两个人的配置早忘了——填出来三套不一样的权限，
 * 而且没人会发现。模板的意义就是**同一个部门进来的人，权限长得一模一样**。
 */
function onboard(actor, spec = {}) {
  const username = String(spec.username || "").trim();
  if (!username) throw new Error("没填用户名");
  const orgId = org.orgIdOf(actor);
  const tpl = deptTemplate(orgId, spec.dept);
  // 显式传了就听显式的；没传才用模板。模板是默认值，不是强制
  const role = spec.role !== undefined && spec.role !== "" ? spec.role : tpl.role;
  const quota = spec.monthly_quota !== undefined && spec.monthly_quota !== "" ? spec.monthly_quota : tpl.monthly_quota;
  const out = account.createMember(actor, { username, role, dept: spec.dept, monthly_quota: quota });
  return {
    ...out,
    applied: { dept: String(spec.dept || ""), role, monthly_quota: quota === null || quota === undefined || quota === "" ? "跟随团队" : quota, from_template: !!tpl.hit },
  };
}

/** 部门权限模板。存在组织设置的 dept_templates 里：{ "销售部": { role, monthly_quota } } */
function deptTemplate(orgId, dept) {
  const key = String(dept || "");
  try {
    const t = (org.settingsOf(org.getOrg(orgId)) || {}).dept_templates || {};
    const hit = t[key];
    if (hit && typeof hit === "object") {
      return { hit: true, role: hit.role || "member", monthly_quota: hit.monthly_quota === undefined ? null : hit.monthly_quota };
    }
  } catch {}
  return { hit: false, role: "member", monthly_quota: null };
}

/** 存一份部门模板。传 null 就是把这个部门的模板删掉 */
function setDeptTemplate(actor, dept, tpl) {
  if (!account.isAdmin(actor)) throw new Error("只有管理员能改部门模板");
  const key = String(dept || "").trim();
  if (!key) throw new Error("没说是哪个部门");
  const orgId = org.orgIdOf(actor);
  const o = org.getOrg(orgId);
  const all = { ...((org.settingsOf(o) || {}).dept_templates || {}) };
  if (tpl === null) delete all[key];
  else {
    const role = ["admin", "auditor", "member"].includes(tpl && tpl.role) ? tpl.role : "member";
    const q = tpl && tpl.monthly_quota !== undefined && tpl.monthly_quota !== null && tpl.monthly_quota !== ""
      ? Math.max(0, Math.floor(+tpl.monthly_quota) || 0) : null;
    all[key] = { role, monthly_quota: q };
  }
  // 只把这一个键递进去。把整份 settingsOf() 交回去的话，默认值会被实体化进 org.settings，
  // 以后改默认值就再也影响不到这个组织了——它手上存着一份一年前的快照
  org.updateOrg(orgId, { settings: { dept_templates: all } }, actor && actor.username);
  org.audit({ org: orgId, actor: actor.username, action: tpl === null ? "删除部门模板" : "设置部门模板", target: key,
    detail: tpl === null ? "" : `${all[key].role} · 月额度 ${all[key].monthly_quota === null ? "跟随团队" : all[key].monthly_quota}` });
  return all;
}

function listDeptTemplates(orgId) {
  try { return (org.settingsOf(org.getOrg(orgId)) || {}).dept_templates || {}; } catch { return {}; }
}

/**
 * 离职回执转成能贴进交接单的一段人话。
 * 回执本身是给机器看的，交接单是给人签字的——两件事，别混用一个格式。
 */
function receiptText(r) {
  const L = [];
  L.push(`离职权限回收单｜${r.display}（${r.user}）${r.dept ? "｜" + r.dept : ""}`);
  L.push(`经办：${r.actor || "（未记名）"}　时间：${new Date(r.at).toLocaleString("zh-CN")}`);
  L.push("");
  L.push("已关闭：");
  L.push(`  · 账号　　　${r.revoked.account || "已停用"}`);
  L.push(`  · 登录令牌　${r.revoked.tokens || 0} 个${r.revoked.devices ? `（含扫码连入的设备 ${r.revoked.devices} 台）` : ""}`);
  L.push(`  · 定时任务　${r.revoked.schedules || 0} 条${(r.revoked.schedule_names || []).length ? "：" + r.revoked.schedule_names.join("、") : ""}`);
  L.push(`  · 邀请码　　${r.revoked.invites || 0} 个`);
  // 这一行必须印在单子上。上面四行关的都是**他本人**登进来的路；中转站那把 owb-sk-…
  // 躺在某个业务系统的环境变量里，跟他在不在职一点关系都没有——
  // 而交接的时候，需要有人去改那个环境变量。单子上不写，就没人会去改。
  if (r.revoked.vkeys) L.push(`  · 中转站 Key　${r.revoked.vkeys} 把：${(r.revoked.vkey_names || []).join("、")}`);
  if (r.revoked.two_factor) L.push("  · 二次验证　已解绑");
  if (r.revoked.running) L.push(`  · 正在跑的任务　已掐断 ${r.revoked.running} 个`);
  if (r.handed_to) L.push(`\n已交接给 ${r.handed_to}：${(r.kept.schedules_handed || []).join("、") || "（无）"}`);
  L.push("");
  L.push("按规定保留（没有删除）：");
  for (const k of ["usage", "sessions", "files", "audit"]) if (r.kept[k]) L.push("  · " + r.kept[k]);
  if ((r.warnings || []).length) {
    L.push("");
    L.push("还要人做的：");
    for (const w of r.warnings) L.push("  ! " + w);
  }
  return L.join("\n");
}

module.exports = { offboard, onboard, deptTemplate, setDeptTemplate, listDeptTemplates, receiptText };
