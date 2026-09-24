// @ts-check
"use strict";
/**
 * 谁能做什么：整套权限只有这一个文件说了算。
 *
 * 起因是一句大实话：以前**任何一个管理员都能把另一个管理员降成成员**，也能随手再造
 * 一个管理员出来。两个人吵一架，谁先点谁赢——那不是权限模型，是先手优势。
 *
 * 现在按 RBAC 来。只有两条规矩，剩下的全是这两条推出来的：
 *
 *   1) 角色分档（rank），**只能管比自己低的那一档**。同档互相动不了，于是管理员之间
 *      谁也踢不掉谁，超管之间也一样——先手优势这回事直接不存在了。
 *   2) 授角色 = 既要**管得到这个人**，也要**够得着你要给的那个角色**。于是管理员能把
 *      成员提成审计员，却永远造不出第二个管理员——发管理员是超管的事。
 *
 * 超级管理员（owner）每个组织**只有一个**，只能「转让」，不能增发、也不能罢免。
 * 为什么不许有两个：两个超管等于把第 1 条规矩在最高那一档上重新打开——要么允许互相
 * 罢免（先手优势原样回来），要么谁也罢免不了谁（点错一次就永远拿不下来）。一个 + 转让，
 * 两种毛病都没有。日常分权用「管理员」，要几个有几个。
 *
 * 人跑了怎么办：分公司超管不干了，**平台超管**（默认组织那一个）能跨组织把超管转给别人；
 * 平台超管自己不干了，在服务器上跑 `openworkbuddy owner <用户名>`——理由跟
 * `openworkbuddy passwd` 一模一样（见 account.js 那段）：能读到 users.json 的人本来
 * 就已经是机主了，再拦一道只剩「唯一的钥匙掉了就永远进不去」这一个后果。
 *
 * 这个文件不 require 任何东西，也不碰盘。它只是一张表加四个判断——
 * 权限要能让人一屏读完才敢信，藏在两千行账号逻辑里的规矩没人读得动。
 */

/** 档次。比的是这个数不是名字：以后要加一档，改这张表就够了 */
const ROLE_RANK = { member: 10, auditor: 20, admin: 30, owner: 40 };
/** 从高到低。界面按这个顺序列 */
const ROLES = ["owner", "admin", "auditor", "member"];
const ROLE_LABEL = { owner: "超级管理员", admin: "管理员", auditor: "审计员", member: "成员" };
/** 能在界面上「授」出去的角色。超管不在里面——它只能转让，见文件头 */
const ASSIGNABLE = ["admin", "auditor", "member"];

/**
 * 能力表。每一条底下都有真实的调用点，没有为了好看而列的：
 *
 *   admin.read       进管理后台（所有 GET）           account.adminGuard
 *   admin.write      在后台改东西（所有写接口）        account.adminOnly
 *   member.manage    管人：改角色/部门/状态、重置密码、删号、办离职   account.assertCanManage
 *   role.grant_admin 把人提成管理员                   account.setMember / createMember / 邀请码
 *   owner.transfer   把超管这个位子转给别人            account.transferOwner
 *   org.manage       平台级：新建组织、改别的组织的套餐席位   admin.platformOwnerOnly
 *   usage.read_org   看得到**全组织**的账，而不是只有自己的  account.usageSummary
 */
const CAPS = {
  member: [],
  auditor: ["admin.read", "usage.read_org"],
  admin: ["admin.read", "usage.read_org", "admin.write", "member.manage"],
  owner: ["admin.read", "usage.read_org", "admin.write", "member.manage", "role.grant_admin", "owner.transfer", "org.manage"],
};

/** 能力的人话名字。「三种角色」那张卡片直接照着列，不再各写各的 */
const CAP_LABEL = {
  "admin.read": "进管理后台（只能看）",
  "usage.read_org": "看得到全组织的用量和账单",
  "admin.write": "改后台里的东西：额度、部门、邀请码、企业设置",
  "member.manage": "管人：加人、改角色、停用、删号、重置密码（只能管比自己低的那一档）",
  "role.grant_admin": "把人提成管理员",
  "owner.transfer": "把超级管理员这个位子转让给别人",
  "org.manage": "新建组织、改别的组织的套餐席位（仅默认组织的超管）",
};

/** 认不出来的角色一律当成员。字段是从盘上读的，写坏了不该变成「什么都能干」 */
function roleOf(u) {
  const r = typeof u === "string" ? u : u && u.role;
  return ROLE_RANK[r] ? r : "member";
}
function rankOf(u) {
  return ROLE_RANK[roleOf(u)];
}
function can(u, cap) {
  return !!u && CAPS[roleOf(u)].includes(cap);
}
/** 只能管比自己低的那一档。同档返回 false——这一行就是整件事的答案 */
function outranks(actor, target) {
  return rankOf(actor) > rankOf(target);
}

/**
 * 能不能把 target 改成 role。三道，缺一不可：
 *   - 得有管人的权
 *   - 得管得到**这个人**（比他高一档）
 *   - 得够得着**这个角色**（比它高一档）——不然管理员能把成员一路提到管理员，
 *     等于自己给自己发了第二把钥匙
 * 超管这一档不走这条路，它只能转让（transferOwner）。
 */
function assignProblem(actor, target, role) {
  if (!ROLE_RANK[role]) return "没有这个角色";
  if (role === "owner") return "超级管理员不能直接授予，只能由现任超管「转让」";
  if (!can(actor, "member.manage")) return "没有管理成员的权限";
  if (!outranks(actor, target)) return same(actor, target)
    ? "同级之间不能互相改角色（" + ROLE_LABEL[roleOf(target)] + "改不了" + ROLE_LABEL[roleOf(target)] + "）"
    : "改不了比自己权限高的人";
  if (rankOf(actor) <= ROLE_RANK[role]) return "你没有授予「" + ROLE_LABEL[role] + "」的权限，这一档得由" + ROLE_LABEL[upper(role)] + "来发";
  return "";
}
const same = (a, b) => rankOf(a) === rankOf(b);
/** 发这个角色的人至少得是哪一档 */
function upper(role) {
  const i = ROLES.indexOf(roleOf(role));
  return i > 0 ? ROLES[i - 1] : "owner";
}

/** 界面上这个人能授出去的角色都有哪些。前端据此渲染下拉，后端照样再判一次 */
function assignableBy(actor, target) {
  return ASSIGNABLE.filter((r) => !assignProblem(actor, target || { role: "member" }, r));
}

module.exports = { ROLE_RANK, ROLES, ROLE_LABEL, ASSIGNABLE, CAPS, CAP_LABEL, roleOf, rankOf, can, outranks, assignProblem, assignableBy };
