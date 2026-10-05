// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 商业授权在这台机器上的全部：授权码验签、「像是团队在用」的迹象、管理员的使用声明。
 *
 * 先把不做的事写死，这几条对外承诺过（COMMERCIAL-LICENSE.md 第一节）：
 *   - **不锁功能、不倒计时、不挡路。** 填没填授权码，软件跑起来一模一样。
 *   - **不联网。** 授权码离线验签（Ed25519，公钥就写在下面）；迹象只在本机算；
 *     声明只存在这台机器的 data/license.json 和操作审计里。没有一个字节往外发——
 *     拿用户的隐私去换维权，付费的和不付费的一起得罪。
 *
 * 那它防什么？防的是「不知道」。公司内部部署，外网看不见，能留下痕迹的只有这台机器自己：
 *   - 看起来像团队在用，管理后台首页就挂一条待办，直到有管理员选一项声明或者填上授权码；
 *   - 选了哪一项、谁选的、什么时候、当时看到了哪些迹象，一起进操作审计；
 *   - 登录页底下一行写着授权状态，每个登录的人都看得见。
 * 这些记录不拦任何人。它们只让「没人告诉过我们」这句话说不出口。
 *
 * 改掉这个文件让它永远显示「已授权」当然做得到——那是改了代码、又拿去商用，
 * 两件事叠在一起，比不声不响地用更说不清。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./src/platform/store");
const { dataPath } = require("./src/platform/paths");

/**
 * 验签用的公钥（Ed25519，SPKI DER 的 base64）。私钥在作者机器上，签发走 scripts/issue-license.js。
 * 换钥匙的时候往这里**追加**，别删旧的：删了，拿旧钥匙签过的码一夜之间全变成「验不过」，
 * 而那些是付过钱的人。
 */
const PUBLIC_KEYS = ["MCowBQYDK2VwAyEA7BbxYnAuenOC+ijx+/PgVdSO/613xm4Bq7JscyE5jk0="];
const PREFIX = "OWB1";

const SCOPE_LABEL = {
  internal: "内部使用",
  service: "对外提供服务",
  delivery: "给客户交付",
  oem: "打包分发",
  all: "不限商业用途",
};

/**
 * 管理员能选的声明。没有「商业使用」这一项：商业使用的正确做法是填授权码，
 * 给它留一个选项，等于给「先选上、回头再说」开一扇门。
 * 评估试用有期限：COMMERCIAL-LICENSE.md 允许公司免费试 30 天，长期用要买授权。
 * 满 30 天待办重新挂出来——不是倒计时，到了也不锁任何东西。
 */
const KINDS = {
  personal: { label: "个人自用", hint: "学习、研究、业余项目，没有商业用途" },
  nonprofit: { label: "非营利机构", hint: "学校、科研、公益或政府机构" },
  evaluation: { label: "公司评估试用", hint: "还没用在实际业务上，最长 30 天", ttl_days: 30 },
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);
// 127.0.0.0/8 整段都是回环，::ffff:127.x 是它的 IPv6 写法；主机名不分大小写。
// 写成这几种的人仍然只让本机连，别当成「对外开放」
const isLoopback = (h) => {
  const x = String(h || "").toLowerCase();
  return LOOPBACK.has(x) || /^127\./.test(x) || /^::ffff:127\./.test(x);
};

// 跟 org.js / account.js 同一个口子：测试把 OPENWORKBUDDY_DATA_DIR 指到临时目录。
// 每次现算，不在 require 时定死——有的测试先 require、后改环境变量
const file = () => path.join(process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data"), "license.json");
// 手改或写坏成 null、[]、一个数字：都按空的算。null 会让后面每一处取属性都抛错，
// [] 更隐蔽——声明挂在数组上，存盘时 JSON 把它丢掉，点几次「声明」只多出几条审计
const load = () => {
  const v = store.readJson(file(), {});
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
};
const save = (st) => store.writeJsonAtomic(file(), st, { pretty: true });

function localDay(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 查表只认自己的键：KINDS["constructor"]、KINDS["__proto__"] 是对象自带的东西，一样是真值。
// 请求体里塞一个 constructor 就能「声明」成功、把待办压下去，声明那一行还是空的
const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const dayOf = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v.map(String) : []);

/**
 * 评估试用开始到现在几天；时间读不出来给 NaN。
 * 往前留一天的余量：对时把本机时钟往回拨了几分钟，不该一声明就说「开始时间比现在还晚」
 */
const DAY_MS = 86400000;
const ageDays = (at, now) => (now.getTime() - Date.parse(at || "")) / DAY_MS;
const sane = (at, now) => ageDays(at, now) >= -1;

const keyCache = new Map();
function keyObj(b64) {
  if (!keyCache.has(b64)) keyCache.set(b64, crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" }));
  return keyCache.get(b64);
}

/**
 * 验一张授权码。返回 { ok: true, license } 或 { ok: false, error }。
 * 过期的码照样 ok——它是真的，只是到期了；到期怎么办由 status 决定，不在这儿把它说成假的。
 * keys 留给测试注入现造的钥匙。
 */
function verify(code, { keys = PUBLIC_KEYS, now = new Date() } = {}) {
  // 邮件里转过一手的码常被折成几行，空白一律去掉
  const raw = String(code || "").replace(/\s+/g, "");
  if (!raw) return { ok: false, error: "授权码是空的" };
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: "这不是 OpenWorkBuddy 的授权码" };
  let payload, sig;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    sig = Buffer.from(parts[2], "base64url");
  } catch {
    return { ok: false, error: "授权码读不出内容，对一下是不是完整复制的" };
  }
  const signed = Buffer.from(parts[0] + "." + parts[1]);
  const good = keys.some((k) => {
    try { return crypto.verify(null, signed, keyObj(k), sig); } catch { return false; }
  });
  if (!good) return { ok: false, error: "签名对不上：这串码和作者签发的不一致" };
  if (!payload || typeof payload !== "object") return { ok: false, error: "授权码读不出内容，对一下是不是完整复制的" };
  const license = {
    id: str(payload.id, 60),
    licensee: str(payload.to, 120),
    scope: str(payload.scope, 20) || "internal",
    scope_label: (own(SCOPE_LABEL, payload.scope) && SCOPE_LABEL[payload.scope]) || str(payload.scope, 20) || SCOPE_LABEL.internal,
    seats: Math.max(0, Math.floor(+payload.seats || 0)),
    issued_at: dayOf(payload.iat),
    expires_at: dayOf(payload.exp),
    note: str(payload.note, 200),
  };
  if (!license.licensee) return { ok: false, error: "授权码里没写授权给谁" };
  license.expired = !!license.expires_at && license.expires_at < localDay(now);
  return { ok: true, license };
}

/**
 * 这台机器上看得见的事实。单独一步是为了让 signalsOf 是纯函数：测试直接喂数字，
 * 不用真去造 12 个账号、配一套企业微信。
 */
function gather({ config, host } = {}) {
  // 用到才 require：account.js 在 /api/auth/state 里也会回头 require 本文件
  const account = require("./account");
  const org = require("./org");
  const vkeys = require("./vkeys");
  const im = (config && config.im) || {};
  const f = im.feishu || {};
  const w = im.wecom_app || {};
  // 数不出来退回默认值，页面照样出得来；但得留一句：退回去的 0 会让强迹象和席位检查一起哑掉，
  // 日志里再没有字，就没人知道这一页说的「没迹象」是真没有还是没数成
  const safe = (name, fn, dflt) => {
    try { return fn(); } catch (e) { console.warn(`[授权] 数迹象失败（${name}）：${e.message}`); return dflt; }
  };
  return {
    // 占席位的账号：停用（离职）的不算，等审核的算。跟成员页的席位同一个口径，
    // 不然买了 10 席、走了 2 个人，首页就对着付过钱的人说「超了」
    users: safe("账号", () => account.seatCount(), 0),
    orgs: safe("组织", () => org.listOrgs().length, 1),
    // 不带 org：整台机器上所有组织发的 Key 都算，分公司发的也是这台机器在对外发
    relay_keys: safe("中转 Key", () => vkeys.list().filter((k) => k.enabled !== false).length, 0),
    wecom: !!((w.corp_id && w.secret) || im.wecom_bot_webhook),
    feishu: !!(f.app_id && f.app_secret),
    dingtalk: !!im.dingtalk_webhook,
    host: String(host || "").trim().replace(/^\[|\]$/g, ""),
  };
}

/**
 * 「像是团队在用」的迹象。强的一条就算；弱的要凑两条。
 *
 * 为什么接了飞书/企业微信只算弱：手机上远程指挥自己的电脑，走的正是这两家，
 * 一个人用得最多的就是它们。同理，放在自己的 VPS 上也不稀奇。
 * 账号数按 3 / 10 / 50 分档，档位进了 key：声明「个人自用」时是 3 个账号，
 * 后来涨到 12 个，那是另一回事了，得再问一次。
 */
function signalsOf(facts = {}) {
  const out = [];
  const n = facts.users || 0;
  if (n >= 3) out.push({ key: "accounts_" + (n >= 50 ? 50 : n >= 10 ? 10 : 3), label: `${n} 个账号`, strong: true });
  if ((facts.orgs || 0) > 1) out.push({ key: "orgs", label: `开了 ${facts.orgs} 个组织`, strong: true });
  if ((facts.relay_keys || 0) > 0) out.push({ key: "relay", label: `发了 ${facts.relay_keys} 把中转 Key`, strong: true });
  if (facts.wecom) out.push({ key: "wecom", label: "接了企业微信", strong: false });
  if (facts.feishu) out.push({ key: "feishu", label: "接了飞书", strong: false });
  if (facts.dingtalk) out.push({ key: "dingtalk", label: "接了钉钉", strong: false });
  if (facts.host && !isLoopback(facts.host)) out.push({ key: "server", label: "对局域网或公网开放", strong: false });
  return out;
}
const teamLike = (sig) => sig.some((s) => s.strong) || sig.filter((s) => !s.strong).length >= 2;

/** 现在填着的授权码。按原文缓存验签结果：登录页每次加载都要问一遍 */
let verified = { code: null, day: "", v: null };
function currentLicense(st, now = new Date()) {
  const code = st.code || "";
  if (!code) return null;
  const today = localDay(now);
  if (verified.code !== code || verified.day !== today) verified = { code, day: today, v: verify(code, { now }) };
  return verified.v;
}

/**
 * 管理后台要的整份状态。why 非空 = 首页该挂待办，内容就是那条待办的原因。
 * 顺序有讲究：授权码的问题排在最前（付过钱的人最该先知道到期了），
 * 然后才轮到「没声明」「声明过期」「多了新迹象」。
 */
function status(facts = {}, now = new Date()) {
  const st = load();
  const sig = signalsOf(facts);
  const team = teamLike(sig);
  const v = currentLicense(st, now);
  const license = v && v.ok ? v.license : null;
  const d = st.declaration && typeof st.declaration === "object" && own(KINDS, st.declaration.kind) ? st.declaration : null;
  // 逐个字段挑出来、套上类型：文件是能手改的，signals 写成一个数字，后面 new Set(5) 就整页 400
  const declaration = d
    ? { kind: d.kind, label: KINDS[d.kind].label, by: str(d.by, 60), at: str(d.at, 40), signals: list(d.signals), seen: list(d.seen) }
    : null;

  const ttl = declaration ? KINDS[declaration.kind].ttl_days || 0 : 0;
  // 从第一次声明评估那天算，不从最近一次（见 declare）。老文件没有 eval_since，退回声明时间
  const since = ttl ? str(st.eval_since, 40) || declaration.at : "";
  const age = ttl ? ageDays(since, now) : 0;
  // why 是给人看的原话，why_kind 是给页面判断用的类别：页面要按它决定摆不摆「重新选」，
  // 从原话里猜类别，改一个字就猜错；从别的字段倒推，满期和新迹象同时占着时推不出来
  let why = "", whyKind = "";
  if (license && license.expired) { why = `商业授权 ${license.expires_at} 已到期`; whyKind = "expired"; }
  else if (license && license.seats && (facts.users || 0) > license.seats) { why = `授权 ${license.seats} 席，现在有 ${facts.users} 个账号`; whyKind = "seats"; }
  else if (!license && v && !v.ok) { why = "填着的授权码验不过了"; whyKind = "bad_code"; }
  else if (!license && team && !declaration) { why = "看起来是团队在用，还没人做过使用声明"; whyKind = "undeclared"; }
  // 评估超期不看迹象：选「公司评估试用」这件事本身就是在说「公司在用」，比哪条迹象都硬。
  // 以前这一句挂在「像团队」底下，删一个号掉回 2 个，30 天的期限就再也不提了。
  // 开始时间读不出来、或者比现在还晚（手改过文件、声明时时钟快了一年），也挂出来，
  // 不然它就成了永不到期的试用。各说各的实情，不一律说成「超过 30 天」
  else if (!license && ttl && !(sane(since, now) && age <= ttl)) {
    why = Number.isNaN(age) ? "评估试用的开始时间读不出来"
      : age < 0 ? "评估试用的开始时间比现在还晚"
      : `公司评估试用从 ${localDay(new Date(since))} 起已超过 ${ttl} 天`;
    whyKind = Number.isNaN(age) || age < 0 ? "eval_bad_start" : "eval_expired";
  }
  else if (!license && team) {
    const known = new Set(declaration.signals);
    const fresh = sig.filter((s) => !known.has(s.key));
    if (fresh.length) { why = `声明之后多了：${fresh.map((s) => s.label).join("、")}`; whyKind = "fresh_signals"; }
  }

  return {
    state: license ? (license.expired ? "expired" : "licensed") : declaration ? "declared" : "unlicensed",
    license,
    code_error: !license && v && !v.ok ? v.error : "",
    declaration,
    signals: sig,
    team_like: team,
    attention: !!why,
    why,
    why_kind: whyKind,
    users: facts.users || 0,
    kinds: Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, hint: k.hint })),
  };
}

/** 登录页和「关于」要的那一点：授权给了谁。别的（声明、迹象）不出管理后台 */
function publicStatus(now = new Date()) {
  const v = currentLicense(load(), now);
  if (!v || !v.ok) return { licensed: false, licensee: "" };
  return { licensed: !v.license.expired, expired: v.license.expired, licensee: v.license.licensee, scope_label: v.license.scope_label, expires_at: v.license.expires_at };
}

function auditLog(user, action, target, detail) {
  try {
    const org = require("./org");
    org.audit({ org: org.DEFAULT_ORG, actor: (user && user.username) || "", action, target, detail });
  } catch (e) {
    // 审计写不进去不该让声明本身失败，但也不能悄悄吞掉：这条记录是整件事的意义所在
    console.warn("[授权] 写操作审计失败：" + e.message);
  }
}

/**
 * 管理员选一项声明。连同当时看到的迹象一起记下：以后多了新迹象，靠这份清单判断要不要再问。
 *
 * 评估试用的起点另存一份 eval_since，只在第一次选评估时写：满 30 天之后再点一次「公司评估试用」，
 * 或者先换成别的再换回来，都不从头算——不然「最长 30 天」点一下就续一个月。
 * 起点读不出来、或比现在还晚的，这次重选时换成现在：那种文件本来就是手改过的，
 * 能改坏它的人也能直接改掉它，这里没什么可守的。
 * 填了授权码也不清：一台机器只评估一次。码到期删掉之后该续的是授权，不是再试 30 天
 */
function declare(kind, user, facts = {}, now = new Date()) {
  if (!own(KINDS, kind)) throw new Error("没有这一项声明");
  const sig = signalsOf(facts);
  const st = load();
  if (KINDS[kind].ttl_days && !sane(st.eval_since, now)) {
    // 升级前就选过评估的老文件没有 eval_since：接着用那次声明的时间，别趁升级白送 30 天
    const prev = st.declaration && st.declaration.kind === kind ? st.declaration.at : "";
    st.eval_since = sane(prev, now) ? String(prev) : now.toISOString();
  }
  st.declaration = {
    kind,
    by: (user && user.username) || "",
    at: now.toISOString(),
    signals: sig.map((s) => s.key),
    seen: sig.map((s) => s.label),
  };
  save(st);
  auditLog(user, "使用声明", KINDS[kind].label, sig.length ? "当时看到：" + sig.map((s) => s.label).join("、") : "当时没看到团队迹象");
  return status(facts, now);
}

function setCode(code, user, facts = {}, now = new Date()) {
  const v = verify(code, { now });
  if (!v.ok) throw new Error(v.error);
  const st = load();
  st.code = String(code).replace(/\s+/g, "");
  st.code_at = now.toISOString();
  st.code_by = (user && user.username) || "";
  save(st);
  auditLog(user, "填授权码", v.license.licensee, `${v.license.id} · ${v.license.scope_label}${v.license.expires_at ? " · 至 " + v.license.expires_at : ""}`);
  return status(facts, now);
}

function clearCode(user, facts = {}, now = new Date()) {
  const st = load();
  if (!st.code) return status(facts, now);
  const v = currentLicense(st, now);
  delete st.code; delete st.code_at; delete st.code_by;
  save(st);
  auditLog(user, "删授权码", v && v.ok ? v.license.licensee : "（验不过的码）", "");
  return status(facts, now);
}

module.exports = { verify, gather, signalsOf, status, publicStatus, declare, setCode, clearCode, PUBLIC_KEYS, KINDS, SCOPE_LABEL };
