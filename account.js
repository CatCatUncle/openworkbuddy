"use strict";
/**
 * 账号体系 + 积分体系 + 用量流水 — Web / CLI / IM / 定时任务 共用一套账本。
 *
 * 数据文件（均不入 git）：
 *   data/users.json  { users: [{ username, salt, hash, role, credits, created_at }], tokens: { token: { user, at } } }
 *   data/usage/<年-月>.jsonl  一行一笔流水，只追加：{ ts, day, kind: "run"|"topup", user, source, model,
 *                             prompt, cached, completion, calls, elapsed_ms, credits, ... }
 *                             （老版本的 data/usage.json 会在第一次读到时自动拆成分片，见 usage-store.js）
 *
 * 计费规则：每消耗 1000 tokens（输入+输出）扣 1 积分，每次任务至少扣 1 积分。
 * 首个注册用户 = 管理员（10000 积分，可充值）；后续注册 = 成员（1000 积分）。
 *
 * 所有读写都直接落盘（读-改-写），CLI 与常驻服务两个进程共享同一账本不打架。
 * 唯一的例外是用量流水：它只追加不重写（见 usage-store.js），不然每记一笔的耗时
 * 会跟着历史一起涨，而且为了压住这个耗时就得给账本封顶——封掉的正是计费和审计数据。
 */

const path = require("path");
const icons = require("./icons.js");
const { dataPath } = require("./paths");
const crypto = require("crypto");
const store = require("./store");
const org = require("./org");
const rbac = require("./rbac"); // 谁能做什么：角色分档和能力表只有那一个文件说了算
const usageStore = require("./usage-store");
const pricing = require("./pricing");
const budget = require("./budget"); // 钱闸的内存账：这一笔也得算进这个月的预算里

// OPENWORKBUDDY_DATA_DIR 只为测试留的口子：跑测试时指到临时目录，免得动到真账本
const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
// 价目表跟 Key 住在一起（config.json），因为「这条渠道多少钱」天然是渠道的属性
const CONFIG_FILE = dataPath("config.json");
const TOKEN_COOKIE = "openworkbuddy_token";
const TOKEN_TTL_MS = 90 * 86400 * 1000;
/**
 * 登录有效期按**这个人所属组织**的设置算（企业管理后台 → 客户端安全）。
 * 判过期这件事必须按 org 走，不能只在发令牌时算一次：管理员把有效期从 90 天调到 7 天，
 * 是为了让**已经发出去的**那些 cookie 立刻作废（人离职了、电脑丢了），
 * 只影响新令牌等于这个开关根本没用。取不到组织就退回 90 天。
 */
function ttlMsFor(user, s) {
  try {
    // s 可以是这个人所属组织的设置，也可以是「要用的时候再去解析」的函数——
    // 解析那一下必须留在这个 try 里面：组织表读不出来时照旧退回默认有效期，
    // 别把一次读盘失败变成整条请求 500
    const st = (typeof s === "function" ? s(user) : s) || org.settingsOf(org.getOrg(org.orgIdOf(user)));
    const d = st.session_days;
    const n = Math.max(1, Math.min(365, Math.floor(+d) || 0));
    return n * 86400 * 1000;
  } catch { return TOKEN_TTL_MS; }
}

// ---------- 存储 ----------
/**
 * 读账本走 store.js 的 strict 模式：文件不在 → 空账本（第一次跑）；文件在、却读不出来 → **抛错**。
 * 这里绝不能把「读不出来」当成「没有用户」：那样接下来任何一次写盘都会拿这个
 * 空壳把整本账（所有账号、密码、积分）覆盖掉，而且用户第一次注册还会当上管理员。
 * 也不自动回退 .bak——账本回退一版可能正好吞掉一笔充值，这种事得让人自己拍板。
 */
function readStore(file, empty) {
  return store.readJson(file, empty, { strict: true });
}
/**
 * 写账本一律 0600。users.json 里躺着的东西，按危险程度排：**所有活着的会话令牌**
 * （拿到就是别人的登录态，不需要密码，也绕过二次验证）、密码哈希和盐、TOTP 密钥
 * 和一次性找回码。默认 umask 给的是 0644——同一台 VPS、同一台办公电脑上任何一个
 * 别的账号一句 `cat` 就全拿走了，而且这事在日志里什么痕迹都不留。
 * 写盘前后各收一次权限（见 store.tighten），装了半年的老机器第一次写就顺手修好。
 */
function writeStoreAtomic(file, data, pretty) {
  store.writeJsonAtomic(file, data, { pretty: !!pretty, mode: store.SECRET_MODE });
}

function loadUsers() {
  const d = readStore(USERS_FILE, { users: [], tokens: {} });
  // settings 要原样带着走：这里丢一个字段，下一次 saveUsers 就把它从盘上抹掉了
  return { users: d.users || [], tokens: d.tokens || {}, settings: d.settings || {} };
}
/**
 * 已经有账号之后还让不让别人自己注册。默认不让——这东西挂到公网上就是给陌生人发积分。
 * 开关搬到了组织设置里（企业版一个组织一套），这里按用户所属组织读；不传用户就看默认组织。
 * 更推荐的做法是发邀请码：能限次数、能设过期、能预置角色，撤销也只影响还没用的那批人。
 */
function openRegister(user) {
  return !!org.settingsOf(org.getOrg(org.orgIdOf(user))).open_register;
}
/**
 * 积分闸门开不开。**默认不开**——本地个人部署时它只会在你干到一半的时候把任务拦下来，
 * 余额掉到 0 还得自己给自己充值，纯添堵：key 是你自己的，账单在服务商那边，
 * 这本账拦不住任何真实开销。只有多人共用一个 key、要给成员定额度时才需要打开。
 * 用量流水跟这个开关无关，永远照记——那是给你看花了多少 tokens 的账，不是闸。
 */
function creditsEnabled(user) {
  return !!org.settingsOf(org.getOrg(org.orgIdOf(user))).credits_enabled;
}
function saveUsers(state) {
  writeStoreAtomic(USERS_FILE, state, true);
}
/**
 * 整本流水，新的在前。
 *
 * 账本从 2026-09 起是 `data/usage/<年-月>.jsonl` 按月分片（见 usage-store.js）。
 * 老的 `data/usage.json` 第一次被读到时自动拆成分片、原文件改名留底，用户不用管。
 *
 * 这个函数保留下来只为「我就是要全部」的少数地方（改用户名、导出）。
 * **凡是知道自己要哪段时间的，直接用 usageStore.read({from,to})** ——
 * 那样只会打开重叠的那几个分片，账本攒了三年也不影响查本月。
 */
function loadUsage() {
  return usageStore.read();
}
/** 整本换掉。只有改用户名和测试会用；正常记一笔走 usageStore.append，不读不改不重写 */
function saveUsage(list) {
  usageStore.replaceAll(Array.isArray(list) ? list : []);
}
function localDay(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

// ---------- 密码与令牌 ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}

/**
 * 密码强度。**注册、自己改密码、管理员重置**三个入口都必须走这里——
 * 少接一个入口，这条策略就等于没有：管理员重置成 "123456" 照样能登。
 *
 * 弱密码表只收「几秒就能撞开」的那几十个，不做成几万条的字典：
 * 字典越长，用户被拒的理由越像玄学，最后的结果是他改成 "Passw0rd!1"——
 * 一样在真实攻击字典里，只是通过了我们的检查。真正的防线是登录限速
 * （FAILS_PER_USER / FAILS_PER_IP）和二次验证，不是这张表。
 */
const WEAK_PASSWORDS = new Set([
  "123456", "1234567", "12345678", "123456789", "1234567890", "12345",
  "111111", "1111111", "11111111", "000000", "0000000", "00000000",
  "123123", "123321", "112233", "121212", "654321", "666666", "888888",
  "password", "passw0rd", "password1", "password123", "pass1234",
  "qwerty", "qwerty123", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm",
  "1q2w3e", "1q2w3e4r", "1qaz2wsx", "qazwsx", "q1w2e3r4", "147258369", "159357",
  "abc123", "abcd1234", "a123456", "a1234567", "123456a", "123456abc", "abc123456",
  "admin", "admin123", "administrator", "root123", "manager", "test123", "user123",
  "iloveyou", "letmein", "welcome", "monkey", "dragon", "sunshine", "princess",
  "football", "baseball", "superman", "trustno1", "whatever", "freedom", "master",
  // 中文用户高频：拼音 + 谐音数字
  "woaini", "woaini1314", "woaini520", "5201314", "520520", "1314520",
  "wangyi", "zhangwei", "wodemima", "mima123", "qq123456", "aa123456", "aa112233",
  "woshishui", "shabi", "caonima", "nihao123", "zhongguo", "aiwoni",
]);

/**
 * @param {string} pw   明文密码
 * @param {object} ctx  { username, org }
 * @returns {string} 出错原因；空字符串表示通过
 */
function passwordProblem(pw, ctx = {}) {
  const p = String(pw == null ? "" : pw);
  const s = org.settingsOf(org.getOrg(ctx.org || org.DEFAULT_ORG));
  const min = Math.min(64, Math.max(6, Math.floor(Number(s.password_min) || 6)));
  if (p.length < min) return `密码至少 ${min} 位`;
  if (p.length > 128) return "密码最多 128 位";
  // 前后空格是复制粘贴带进来的，用户看不见它，下次手敲就登不上了
  if (p !== p.trim()) return "密码前后不能有空格";
  const u = String(ctx.username || "").trim();
  if (u && p.toLowerCase() === u.toLowerCase()) return "密码不能和用户名一样";
  if (WEAK_PASSWORDS.has(p.toLowerCase())) return "这个密码在常见弱密码表里，换一个";
  // 纯重复（aaaaaa）和纯连号（123456 / abcdef，含倒着来的）：
  // 长度够了也挡，不然把 password_min 调到 12 之后，用户会用 "aaaaaaaaaaaa" 过关
  if (/^(.)\1+$/.test(p)) return "密码不能是同一个字符重复";
  if (isRun(p)) return "密码不能是连续的一串（像 123456、abcdef）";
  if (s.password_strong) {
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
    if (kinds < 3) return "组织要求密码里至少包含大写字母、小写字母、数字、符号中的三类";
  }
  return "";
}
function isRun(p) {
  if (p.length < 4) return false;
  let up = true, down = true;
  for (let i = 1; i < p.length; i++) {
    const d = p.charCodeAt(i) - p.charCodeAt(i - 1);
    if (d !== 1) up = false;
    if (d !== -1) down = false;
    if (!up && !down) return false;
  }
  return true;
}
/** 过不了就 throw，给三个入口直接用 */
function assertPassword(pw, ctx) {
  const bad = passwordProblem(pw, ctx);
  if (bad) throw new Error(bad);
}

/**
 * 生成一串随机密码（管理员建号、管理员重置密码时发给本人的那串）。
 * 必须自己也过得了策略——否则管理员把 password_min 调到 12，
 * 「添加成员」当场报「密码至少 12 位」，而那串密码还是系统自己发的。
 */
function genPassword(orgId) {
  const s = org.settingsOf(org.getOrg(orgId || org.DEFAULT_ORG));
  const min = Math.min(64, Math.max(6, Math.floor(Number(s.password_min) || 6)));
  // 去掉 0/O/1/l/I：这串要靠人从屏幕上抄到另一台设备
  const sets = ["abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKMNPQRSTUVWXYZ", "23456789", "!@#$%^&*-_=+"];
  const len = Math.max(min, 12);
  for (let attempt = 0; attempt < 50; attempt++) {
    const need = s.password_strong ? sets : sets.slice(0, 3);
    const chars = [];
    for (const set of need) chars.push(set[crypto.randomInt(set.length)]);
    const pool = need.join("");
    while (chars.length < len) chars.push(pool[crypto.randomInt(pool.length)]);
    // Fisher-Yates：不洗的话前几位永远按 小写-大写-数字-符号 排，规律一眼可见
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const pw = chars.join("");
    if (!passwordProblem(pw, { org: orgId })) return pw;
  }
  throw new Error("生成密码失败：当前的密码策略太严，管理员先去企业设置里放宽一点");
}
/**
 * @param s 这个人所属组织的设置。不传就自己去读一次（单个用户的场合本来就只读一次）。
 *   成员列表那种一次画几百个人的地方必须传：底下三格（月额度 / 本月剩余 / 余额）
 *   各自都会去 org.getOrg() 拿一次设置，一个人三遍、五百个人一千五百遍，
 *   读的还是同一份不会变的东西。实测 50 个人的成员页，平台上多 500 家公司之后
 *   从 5.6ms 变成 365.6ms——慢的不是你自己的数据，是别人家的。
 *   传进来的必须是**这个人自己组织**的设置，别拿调用方的设置套到别人头上。
 */
function publicUser(u, s) {
  if (!u) return null;
  const st = s || org.settingsOf(org.getOrg(org.orgIdOf(u)));
  return {
    username: u.username,          // 登录名，不可改：改了就是换了个账号
    nickname: u.nickname || "",     // 昵称，界面上显示的名字
    avatar: u.avatar || "",         // 一两个 emoji，或者 data:image/... 的小图
    role: rbac.roleOf(u),
    role_label: rbac.ROLE_LABEL[rbac.roleOf(u)],
    // 这一格保留是为了老代码和老界面还认它；真相在 role 上（owner 现在是一档角色，不是一个布尔）
    owner: rbac.roleOf(u) === "owner",
    // 界面照着这两格画，别在前端再数一遍角色名：每加一档角色，写死 role === "admin"
    // 的地方就漏掉一个人，而漏掉的方式是「那一项根本不显示」——没人会来报这种 bug
    can_admin: rbac.can(u, "admin.read"),   // 进得去后台（审计员起）
    is_admin: rbac.can(u, "admin.write"),   // 进去之后改得动（管理员起）
    org: u.org || org.DEFAULT_ORG,
    dept: u.dept || "",
    status: u.status || "active",   // active | pending（等审核）| disabled（已停用）
    credits: u.credits,             // 加油包余额
    monthly_quota: monthlyQuotaOf(u, st),   // 每月固定用量
    // 中转站上这个人每月封顶多少钱（元）。0 = 没单独设过，按部门模板、再按组织默认走（budget.js 的 limitsOf）。
    // 跟上面 credits / monthly_quota 那一套不是一回事：那套算的是**界面上用了几次**，
    // 这一格算的是**业务方拿虚拟 Key 调 API 花了多少钱**，两本账互不相干。
    budget_yuan: u.budget_yuan || 0,
    monthly_left: monthlyLeft(u, st),   // 本月还剩多少固定用量
    balance: balanceOf(u, st),          // 固定用量剩余 + 加油包，界面和闸门都看这个数
    created_at: u.created_at,
    two_factor: twoFactorOn(u),     // 只给布尔，密钥和恢复码一个字都不出去
  };
}

// ---------- 月固定用量 ----------
/**
 * 用量抵扣顺序：**先扣本月固定用量，扣完再动加油包余额**。
 * 顺序不是随便定的——月固定用量到月底就作废，加油包不会；先扣不作废的那份，
 * 等于每个月都在替用户浪费掉一笔已经发下去的额度。
 */
function monthKey(d) {
  return localDay(d).slice(0, 7);
}
function monthlyQuotaOf(user, s) {
  const st = s || org.settingsOf(org.getOrg(org.orgIdOf(user)));
  // 个人额度优先于团队统一额度：后台可以单独给某个人加，加完不该被团队的默认值盖回去
  const q = user && user.monthly_quota != null ? +user.monthly_quota : st.member_monthly_credits;
  return Math.max(0, Math.floor(q || 0));
}
function monthlyLeft(user, s) {
  const quota = monthlyQuotaOf(user, s);
  if (!quota || !user) return 0;
  // 跨月自动清零：不写定时任务去重置，读的时候按 month_key 判就够了，
  // 定时任务在桌面版里根本不保证跑得到（合上盖子就没了）
  const used = user.month_key === monthKey() ? user.month_used || 0 : 0;
  return Math.max(0, quota - used);
}
function balanceOf(user, s) {
  if (!user) return 0;
  const st = s || org.settingsOf(org.getOrg(org.orgIdOf(user)));
  return monthlyLeft(user, st) + Math.max(0, user.credits || 0);
}

// 头像允许两种：emoji（存字符）和用户自己上传的小图（存 data URI）。
// 只收 data:image/*，且限 256KB——账本是个 JSON 文件，塞张大图进去会把整个读写拖垮。
const AVATAR_MAX = 256 * 1024;
function normalizeAvatar(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  // 内置猫标的哨兵值。它不是 emoji，会被下面「最多两个字符」那关挡掉，所以得先放行
  if (s === "@cat") return s;
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    if (s.length > AVATAR_MAX) throw new Error("头像图片太大了（超过 256KB），换张小的或者用 emoji");
    return s;
  }
  // data: 开头但没过上面那关的，是伪装成图片的别的东西（data:text/html 之类），直接挡
  if (/^data:/i.test(s) || /^(https?:)?\/\//.test(s) || s.includes("<")) throw new Error("头像只支持图标、emoji 或上传图片");
  // 图标名（"rocket"、"chart-column"）：前端头像格子里挑的就是这些，不是能打出来的字，
  // 会被下面「最多两个字符」那关误伤，所以在字数关之前先放行
  if (icons.isIconName(s)) return s;
  // emoji 按「字素簇」算长度：一个 👨‍👩‍👧 是好几个码位拼的，用 .length 会误判成超长
  const chars = [...new Intl.Segmenter().segment(s)].length;
  if (chars > 2) throw new Error("头像最多两个字符");
  return s;
}
function hasUsers(st) {
  return (st || loadUsers()).users.length > 0;
}
/** 这台机器上一共几个账号。admin.js 用它判「这还算不算一个人的桌面」 */
function userCount(st) {
  return (st || loadUsers()).users.length;
}
// ---------- 二次验证（TOTP） ----------
// 算术在 totp.js（对着 RFC 4226 / 6238 的标准向量测过），这儿只管「存在哪、怎么算数」。
// 用户记录上多一个 totp 字段：
//   { secret, enabled_at, last_step, recovery: [hash…], recovery_salt }
// **没开通的人身上没有这个字段**，不是 enabled:false——老账号不用迁移，判断也只有一处。
const totp = require("./totp");

/** 开没开。secret 存着但还没 enabled_at = 扫了码没验证成功，不算开通 */
function twoFactorOn(u) {
  return !!(u && u.totp && u.totp.secret && u.totp.enabled_at);
}

/** 恢复码的哈希。用 sha256 不用 scrypt：这串是我们自己发的 20 个 base32 字符
 *  （约 94 bit 熵），没有字典可撞，慢哈希在这儿只会让一次登录多等 100ms */
function hashRecovery(code, salt) {
  return crypto.createHash("sha256").update(salt + "|" + String(code).toUpperCase().replace(/-/g, "")).digest("hex");
}
function makeRecoveryCodes() {
  // 分成 4-4-4-4-4 是给人抄的：一串 20 个字符抄错的概率高得多
  const out = [];
  for (let i = 0; i < 10; i++) {
    const raw = totp.base32Encode(crypto.randomBytes(13)).replace(/=/g, "").slice(0, 20);
    out.push(raw.match(/.{1,4}/g).join("-"));
  }
  return out;
}

/** 扫码前：生成一个还没启用的密钥，返回 otpauth:// 地址给前端出二维码 */
function startEnroll(username, issuer) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!u) throw new Error("账号不存在");
  if (twoFactorOn(u)) throw new Error("已经开通过二次验证了，要换一台设备先关掉再重开");
  const secret = totp.generateSecret();
  u.totp = { secret, enabled_at: null };
  saveUsers(st);
  return { secret, otpauth: totp.otpauthURL(username, secret, issuer || "OpenWorkBuddy") };
}

/**
 * 输一次码确认扫对了，这才算真开通。**必须验证过才开通**——
 * 直接信「前端说扫好了」的话，二维码没扫上的人会当场把自己锁在门外。
 */
function enableTOTP(username, code) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!u || !u.totp || !u.totp.secret) throw new Error("还没开始绑定，先扫码");
  if (twoFactorOn(u)) throw new Error("已经开通过了");
  const step = totp.verify(u.totp.secret, code);
  if (step == null) throw new Error("验证码不对。手机上的时间跟服务器差太多也会这样，对一下时间再试");
  const codes = makeRecoveryCodes();
  const salt = crypto.randomBytes(16).toString("hex");
  u.totp = {
    secret: u.totp.secret,
    enabled_at: new Date().toISOString(),
    last_step: step,
    recovery_salt: salt,
    recovery: codes.map((c) => hashRecovery(c, salt)),
  };
  saveUsers(st);
  org.audit({ org: org.orgIdOf(u), actor: username, action: "开通二次验证", target: username });
  // 明文恢复码只在这一次响应里出现，之后盘上只剩哈希
  return codes;
}

/**
 * 校验一次登录码。返回 "totp" / "recovery" / null。
 *
 * 两件事容易被漏掉，漏了这个二次验证就是装饰：
 *  1）**同一个 30 秒窗口的码不能用第二次**。验证码会在肩后被看到、会留在剪贴板里、
 *     会被中间人转发——存下上次通过的 step，小于等于它的一律拒。
 *  2）**恢复码用一次就作废**，从盘上删掉，不是标记一下。
 */
function consumeTwoFactor(username, code) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!twoFactorOn(u)) return null;
  const step = totp.verify(u.totp.secret, code);
  if (step != null) {
    if (u.totp.last_step != null && step <= u.totp.last_step) return null; // 重放
    u.totp.last_step = step;
    saveUsers(st);
    return "totp";
  }
  const want = hashRecovery(code, u.totp.recovery_salt || "");
  const i = (u.totp.recovery || []).indexOf(want);
  if (i >= 0) {
    u.totp.recovery.splice(i, 1);
    saveUsers(st);
    org.audit({ org: org.orgIdOf(u), actor: username, action: "用恢复码登录", target: username,
      detail: `还剩 ${u.totp.recovery.length} 个` });
    return "recovery";
  }
  return null;
}

/** 关掉。本人关要验一次码（防的是「电脑没锁，路过的人顺手关掉」），管理员重置不用 */
function disableTOTP(username, { code, byAdmin, actor } = {}) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!u) throw new Error("账号不存在");
  if (!byAdmin) {
    if (!twoFactorOn(u)) throw new Error("本来就没开");
    if (consumeTwoFactor(username, code) == null) throw new Error("验证码不对");
  }
  // consumeTwoFactor 自己写过一次盘（last_step / 用掉的恢复码），手上这份已经是旧的，
  // 直接存回去会把它刚写的盖掉。重新读一遍再删。
  const fresh = loadUsers();
  const x = fresh.users.find((y) => y.username === username);
  // 整个字段删掉，不留 enabled:false 的空壳：下次重开是一套全新的密钥和恢复码
  const had = !!(x && x.totp);
  if (x) delete x.totp;
  saveUsers(fresh);
  if (had) org.audit({ org: org.orgIdOf(u), actor: actor || username, action: byAdmin ? "重置成员二次验证" : "关闭二次验证", target: username });
  return had;
}

/** 重新发一批恢复码（旧的当场全废）。要先验一次码 */
function regenRecovery(username, code) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!twoFactorOn(u)) throw new Error("还没开通二次验证");
  if (consumeTwoFactor(username, code) == null) throw new Error("验证码不对");
  const fresh = loadUsers();
  const x = fresh.users.find((y) => y.username === username);
  const codes = makeRecoveryCodes();
  const salt = crypto.randomBytes(16).toString("hex");
  x.totp.recovery_salt = salt;
  x.totp.recovery = codes.map((c) => hashRecovery(c, salt));
  saveUsers(fresh);
  org.audit({ org: org.orgIdOf(x), actor: username, action: "重新生成恢复码", target: username });
  return codes;
}

/** 二次验证的状态，给界面看。**绝不能带 secret 和恢复码哈希出去** */
function twoFactorStatus(u) {
  const on = twoFactorOn(u);
  return {
    on,
    since: on ? u.totp.enabled_at : null,
    recovery_left: on ? (u.totp.recovery || []).length : 0,
    required: !!org.settingsOf(org.getOrg(org.orgIdOf(u))).require_2fa,
  };
}

/** 没有登录态时（CLI / IM / 定时任务）消耗记在谁名下：档次最高的那个人，同档取最早建的 */
function defaultUser() {
  const us = loadUsers().users;
  return [...us].sort((a, b) => rbac.rankOf(b) - rbac.rankOf(a) || String(a.created_at).localeCompare(String(b.created_at)))[0] || null;
}

function register(username, password, opts = {}) {
  username = String(username || "").trim();
  if (!/^[\w一-龥.-]{2,24}$/.test(username)) throw new Error("用户名需 2-24 位（中英文、数字、_.-）");
  assertPassword(password, { username, org: opts.org || org.DEFAULT_ORG });
  const st = loadUsers();
  if (st.users.some((u) => u.username === username)) throw new Error("用户名已存在");
  const salt = crypto.randomBytes(16).toString("hex");
  const first = st.users.length === 0;
  const orgId = first ? org.DEFAULT_ORG : opts.org || org.DEFAULT_ORG;
  const o = org.getOrg(orgId);
  const s = org.settingsOf(o);
  // 席位闸要放在建号**之前**：先建后查的话，报错弹出来的时候人已经躺在账本里了
  if (!first) {
    const seats = org.planInfo(o).seats;
    const used = st.users.filter((u) => (u.org || org.DEFAULT_ORG) === orgId && u.status !== "disabled").length;
    if (used >= seats) throw new Error(`「${o.name}」的席位已用满（${used}/${seats}），让管理员在企业设置里加席位`);
  }
  // 这个组织有超管了没有。以前 owner 只给**全站**第一个人，于是分公司里一个超管都没有，
  // 两个管理员可以互相停用、互相降级——「管理员权限太大」这件事最狠的一处就在这儿。
  // 现在：开服第一个人是平台超管；一个新组织里第一个管理员级别的人，就是那个组织的超管。
  // 普通成员先进来的话先空着，等有人被提成管理员时由 migrateOwners 补上。
  const wanted = rbac.ASSIGNABLE.includes(opts.role) ? opts.role : "member";
  const role = first ? "owner" : firstAdminIsOwner(st, orgId, wanted);
  const user = {
    username,
    salt,
    hash: hashPassword(password, salt),
    role,
    org: orgId,
    dept: String(opts.dept || ""),
    status: first ? "active" : opts.status === "pending" ? "pending" : "active",
    credits: first ? 10000 : Math.max(0, Math.floor(s.default_member_credits || 0)),
    created_at: new Date().toISOString(),
  };
  syncOwner(user);
  st.users.push(user);
  saveUsers(st);
  return user;
}

/**
 * 改登录名。原来这儿是写死不给改的，理由写的是"历史用量都挂在它名下"——
 * 那不是规矩，是把偷懒说成了规矩：真该做的是把挂在它名下的东西一起搬走。
 * 这里搬账本里的用户、还在有效期内的登录令牌（不搬的话改完当场被踢下线）、
 * 用量流水（含充值记录的 by）。会话文件的归属由 server 那边接着搬，那是它的地盘。
 */
function renameUser(oldName, newName) {
  newName = String(newName || "").trim();
  if (!/^[\w一-龥.-]{2,24}$/.test(newName)) throw new Error("用户名需 2-24 位（中英文、数字、_.-）");
  const st = loadUsers();
  const u = st.users.find((x) => x.username === oldName);
  if (!u) throw new Error("账号不存在");
  if (newName === oldName) return oldName;
  if (st.users.some((x) => x.username === newName)) throw new Error("这个登录名已经有人用了");
  u.username = newName;
  for (const t of Object.keys(st.tokens)) if (st.tokens[t] && st.tokens[t].user === oldName) st.tokens[t].user = newName;
  saveUsers(st);
  // 历史流水里的名字也得跟着换，不然「这个人一共花了多少」从改名那天起断成两截。
  // 这是账本上唯一一处原地改写，罕见到一年碰不上几回——为它多读写一遍全部分片是值得的，
  // 换来的是每记一笔都只是往文件尾巴上追加一行
  usageStore.rewriteAll((e) => {
    let hit = false;
    if (e.user === oldName) { e.user = newName; hit = true; }
    if (e.by === oldName) { e.by = newName; hit = true; }
    return hit;
  });
  return newName;
}

function verify(username, password) {
  const st = loadUsers();
  const user = st.users.find((u) => u.username === String(username || "").trim());
  if (!user) return null;
  const h = Buffer.from(hashPassword(password, user.salt), "hex");
  const h0 = Buffer.from(user.hash, "hex");
  return h.length === h0.length && crypto.timingSafeEqual(h, h0) ? user : null;
}

/**
 * @param meta  这条令牌背后是哪台设备：{ kind:"session"|"paired", name, ua, ip }。
 *   不传就是老样子（浏览器里刚登录的一条会话）。记下来是为了「已授权设备」那张表——
 *   没有名字和最后活跃时间，那张表只能列出一排一模一样的「一条令牌」，等于没法管。
 */
function issueToken(username, meta = {}) {
  const st = loadUsers();
  const token = crypto.randomBytes(24).toString("hex");
  const kind = meta.kind === "paired" ? "paired" : "session";
  const now = Date.now();
  st.tokens[token] = {
    user: username, at: now, seen: now, kind,
    name: String(meta.name || "").trim().slice(0, 40) || deviceLabel(meta.ua),
    ua: String(meta.ua || "").slice(0, 200),
    ip: String(meta.ip || ""),
  };
  // 清过期 + 同一用户每一类最多保留 MAX_DEVICES 条
  const mine = { session: [], paired: [] };
  const byUser = new Map(st.users.map((u) => [u.username, u]));
  for (const [t, info] of Object.entries(st.tokens)) {
    if (Date.now() - info.at > ttlMsFor(byUser.get(info.user))) delete st.tokens[t];
    else if (info.user === username) mine[info.kind === "paired" ? "paired" : "session"].push([t, info.at]);
  }
  // 两类**各算各的**。混在一起算的话，在电脑上多开几次浏览器就能把你配对好的手机
  // 悄悄顶下去——人在外面点开页面发现要重新配对，却完全不知道是自己在家开浏览器开掉的
  for (const arr of Object.values(mine)) {
    arr.sort((a, b) => b[1] - a[1]).slice(MAX_DEVICES).forEach(([t]) => delete st.tokens[t]);
  }
  saveUsers(st);
  return token;
}

/** 换密码后把这个人别的会话全踢掉 —— 密码泄露了才改的密码，旧 cookie 还能用就等于没改 */
function revokeTokens(username, keepToken) {
  const st = loadUsers();
  for (const [t, info] of Object.entries(st.tokens)) {
    if (info.user === username && t !== keepToken) delete st.tokens[t];
  }
  saveUsers(st);
}

// ---------- 设备配对（远程访问授权） ----------
/**
 * 想在手机上用这台电脑里的 agent，以前只有两条路：把账号密码敲进手机，
 * 或者在前面再挡一道 nginx 基本认证（于是你要记两套口令，还老记混）。两条都不对——
 * 密码一旦上了手机就多了一个泄露面；基本认证挡的是整个站点，跟「是谁在用」根本没关系。
 *
 * 这里走的是 Codex / Claude Code 那条路子：**在已经登录的那台机器上生成一次性配对码**，
 * 到新设备上把码敲进去，换回一条**只属于这台设备**的令牌。
 *   · 密码从头到尾没离开过原来那台机器
 *   · 一台设备一条令牌，列表里看得见（名字 / 系统 / IP / 最后活跃），能单独踢掉
 *   · 配对码一次性、3 分钟过期、只活在内存里（重启即失效），撞错还要限速
 *
 * 为什么 8 位就够：31 个字符 × 8 位 ≈ 40 位熵。就算不限速，3 分钟里也要打 10^12 次
 * 才有一半把握撞上；再压上每 IP 6 次的闸，这条路等于不存在。
 */
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 抠掉 I L O 0 1：这串是要人照着念、照着敲的
const PAIR_LEN = 8;
const PAIR_TTL_MS = 3 * 60 * 1000;
const PAIR_FAILS_PER_IP = 6;
const MAX_DEVICES = 10;
const pairs = new Map(); // code → { user, at }。只在内存里：重启就该失效，本来也只活 3 分钟

/**
 * 刚配上的那台，记 2 分钟。
 *
 * 码本身是用完即焚的，焚了之后生成码那台机器就再也问不出「到底连上没有」——
 * 只能看着倒计时走完，猜。这张表就是拿来回答这一句的：手机连上的同一秒，
 * 电脑上那张二维码变成「✓ iPhone 已连接」。
 */
const claimed = new Map(); // username → { at, name, id }
const CLAIM_NOTICE_MS = 2 * 60 * 1000;

function prunePairs(now = Date.now()) {
  for (const [c, p] of pairs) if (now - p.at > PAIR_TTL_MS) pairs.delete(c);
  for (const [u, c] of claimed) if (now - c.at > CLAIM_NOTICE_MS) claimed.delete(u);
}
/** 生成配对码。同一个人同时只留一个——手上攥着两个有效码，自己都说不清该念哪个 */
function newPairCode(username) {
  // 时间只取一次：以前存码和回给前端的倒计时各取一次 Date.now()，跨了一毫秒两边就差一截，
  // pairStatus 按存的那个算出来的 expires_at 跟出码时回的对不上
  const now = Date.now();
  prunePairs(now);
  dropPairCode(username);
  // 上一轮配成功的记录要清掉。留着的话，两分钟内再出一张新码，生成的那一刻就
  // 显示「✓ 已连接」——连的是上一台，人却以为这张码已经被扫了
  claimed.delete(username);
  let code = "";
  for (let i = 0; i < PAIR_LEN; i++) code += PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)];
  pairs.set(code, { user: username, at: now });
  return { code, expires_in: Math.floor(PAIR_TTL_MS / 1000), expires_at: now + PAIR_TTL_MS };
}
function dropPairCode(username) {
  for (const [c, p] of pairs) if (p.user === username) pairs.delete(c);
}
/** 人念出来的码带空格和横杠，大小写也随缘。只认字母数字，别让一个横杠把人挡在门外 */
function normalizePairCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/** 用配对码换一条设备令牌。用完即焚——同一个码不给第二台机器用 */
function claimPair(code, meta = {}) {
  prunePairs();
  const key = normalizePairCode(code);
  if (key.length !== PAIR_LEN) return null;
  const p = pairs.get(key);
  if (!p) return null;
  pairs.delete(key); // 先删再发：中间抛错也不会留下一个还能再换一次的码
  const st = loadUsers();
  const u = st.users.find((x) => x.username === p.user);
  if (!u) return null;
  // 生成码之后才被停用的：码还在手里，人已经不该进来了
  if ((u.status || "active") === "disabled") return null;
  const token = issueToken(u.username, { ...meta, kind: "paired" });
  claimed.set(p.user, { at: Date.now(), name: meta.name || deviceLabel(meta.ua), id: deviceId(token) });
  return { user: u, token };
}
/** 生成码那台机器轮询这个：还在等？还是已经有人连上来了？ */
function pairStatus(username) {
  prunePairs();
  let pending = null;
  for (const [c, p] of pairs) if (p.user === username) pending = { expires_at: p.at + PAIR_TTL_MS, code: c };
  const c = claimed.get(username);
  return { pairing: !!pending, expires_at: pending ? pending.expires_at : 0, claimed: c ? { name: c.name, id: c.id, at: c.at } : null };
}
/**
 * 这台机器在局域网里能被手机够着的地址，好的排前面。
 *
 * 老写法是「翻到第一个私网 IPv4 就用」，而 os.networkInterfaces() 的顺序没有任何保证。
 * 2026-09-21 在这台机器上量过：en0 是 192.168.1.84（真网卡），utun4 是 198.18.0.1（代理隧道），
 * 默认路由还指着 utun4 —— 也就是说「按默认路由挑」同样是错的。真正的判据只有一条：
 * 手机和这台电脑连同一个 Wi-Fi 时，能 ping 通的是物理网卡上的那个地址。
 * 所以隧道口（utun/wg/zt）、Docker 网桥（docker0/br-/bridge*）、虚拟机口（vmnet/vboxnet）
 * 一律排到最后 —— 它们上面的地址长得跟内网地址一模一样，扫出来却永远打不开。
 */
function lanCandidates() {
  const 虚口 = /^(utun|ipsec|ppp\d|tun\d|tap\d|wg\d|zt|docker|br-|veth|vboxnet|vmnet|virbr|bridge|awdl|llw|anpi|ap\d)/i;
  const out = [];
  for (const [iface, list] of Object.entries(require("os").networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      // 只认私网段：公网 IP 编进二维码，等于把入口贴墙上了
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ni.address)) continue;
      out.push({ iface, address: ni.address, virtual: 虚口.test(iface) });
    }
  }
  // 物理口在前、虚拟口在后；同一档按名字排死，免得同一台机器每次刷新给的地址都不一样
  const rank = (c) => (c.virtual ? 9 : /^en\d/i.test(c.iface) ? 0 : /^(eth|wlan|wl)\d/i.test(c.iface) ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.iface.localeCompare(b.iface));
}

/**
 * 扫码要用的地址（取最靠谱的那一个）。手机跟这台电脑不在同一个 localhost 上，所以
 * localhost 编进二维码等于编了个死链——扫出来手机只会去找它自己。
 * 翻不到就不猜，宁可让他手敲那 8 个字符，也别给一个扫了打不开的码。
 */
function pairOrigin(req) {
  const list = pairOrigins(req);
  return list.length ? list[0].url : "";
}

/** 所有能落地的地址，好的排前面。界面上多给一个「换一个地址」的出口，猜错了人能自己纠 */
function pairOrigins(req) {
  const proto = isHttps(req) ? "https" : "http";
  const host = String((req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "");
  // 通过正经域名/反代进来的，那个域名本来就是能落地的地址，不用猜
  if (host && !/^(localhost|127\.|\[::1\]|::1)/i.test(host)) return [{ host, url: `${proto}://${host}`, iface: "" }];
  const port = (host.split(":")[1] || "").replace(/[^0-9]/g, "");
  const out = lanCandidates().map((c) => ({
    host: c.address + (port ? ":" + port : ""),
    url: `${proto}://${c.address}${port ? ":" + port : ""}`,
    iface: c.iface,
  }));
  if (out.length) return out;
  return host ? [{ host, url: `${proto}://${host}`, iface: "" }] : [];
}

/** 从 UA 里猜一个人看得懂的设备名。猜不出就叫「未知设备」，不编 */
function deviceLabel(ua) {
  const s = String(ua || "");
  if (!s) return "未知设备";
  const osName = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android"
    : /Mac OS X|Macintosh/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : "";
  // Edge 的 UA 里有 Chrome，Chrome 的 UA 里有 Safari——顺序反了就全判成 Safari
  const br = /Edg\//.test(s) ? "Edge" : /Chrome\/|CriOS\//.test(s) ? "Chrome" : /Firefox\/|FxiOS\//.test(s) ? "Firefox"
    : /Safari\//.test(s) ? "Safari" : "";
  return [osName, br].filter(Boolean).join(" · ") || "未知设备";
}

/**
 * 设备在列表里的 id = 令牌的 sha256 前 16 位，**不是令牌本身**。
 * 直接把令牌发给前端的话，「查看我的设备」这个只读动作会顺手把其他每一台设备的
 * 有效凭证抄一份到这个页面上——列表是给人看的，不该是一串能直接用的钥匙。
 */
function deviceId(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
}
function listDevices(username, currentToken) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  const ttl = ttlMsFor(u);
  const now = Date.now();
  return Object.entries(st.tokens)
    .filter(([, i]) => i.user === username && now - i.at <= ttl)
    .map(([t, i]) => ({
      id: deviceId(t),
      name: i.name || deviceLabel(i.ua),
      kind: i.kind === "paired" ? "paired" : "session",
      ip: i.ip || "",
      at: i.at,
      seen: i.seen || i.at,
      current: t === currentToken,
      expires_at: i.at + ttl,
    }))
    .sort((a, b) => b.seen - a.seen);
}
/** 踢掉一台设备。只在自己名下找——拿别人的 id 过来也翻不出那条令牌 */
function revokeDevice(username, id) {
  const st = loadUsers();
  const hit = Object.keys(st.tokens).find((t) => st.tokens[t].user === username && deviceId(t) === String(id || ""));
  if (!hit) return false;
  delete st.tokens[hit];
  saveUsers(st);
  return true;
}
/**
 * 记一下这条令牌最近一次露面。**节流到 5 分钟**：每个请求都写一次的话，
 * 一次任务几十条轮询就是几十次全量重写 users.json——而「最后活跃」精确到分钟根本没人看。
 */
const TOUCH_MS = 5 * 60 * 1000;
function touchDevice(req, st0) {
  try {
    const token = tokenFromReq(req);
    if (!token) return;
    // 先拿手上这份判节流。以前是无条件先把整本 users.json 读出来再判——
    // 节流省下的只有写，没省读，而在这条路上读本身才是最贵的那一步
    const seen = ((st0 || loadUsers()).tokens[token] || {}).seen || 0;
    if (Date.now() - seen < TOUCH_MS) return;
    // 真要写了才重新读一遍：上游那份是这趟请求开头读的，拿它盖回去等于把
    // 这中间别人写的东西抹掉
    const st = loadUsers();
    const info = st.tokens[token];
    if (!info) return;
    info.seen = Date.now();
    info.ip = clientIp(req);
    if (!info.kind) info.kind = "session"; // 升级上来的老令牌补个类型，列表里才摆得下
    if (!info.name) info.name = deviceLabel(req.headers && req.headers["user-agent"]);
    saveUsers(st);
  } catch { /* 记个活跃时间而已，出错不该把这个请求带下水 */ }
}

function tokenFromReq(req) {
  const m = /(?:^|;\s*)openworkbuddy_token=([\w]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
/** 这一次请求用的是哪种令牌：扫码配对来的（paired）还是正常登录的（session）。认不出来当 session */
function tokenKind(req, st) {
  const token = tokenFromReq(req);
  if (!token) return "";
  const info = (st || loadUsers()).tokens[token];
  return info && info.kind === "paired" ? "paired" : info ? "session" : "";
}
/**
 * @param st0       已经读出来的账本。一趟请求里这本不会变，读第二遍是白读。
 * @param settings  这个人所属组织的设置（或解析它的函数），只为了判令牌过期。
 */
function userFromReq(req, st0, settings) {
  const token = tokenFromReq(req);
  if (!token) return null;
  const st = st0 || loadUsers();
  const info = st.tokens[token];
  if (!info) return null;
  const u = st.users.find((x) => x.username === info.user) || null;
  if (!u) return null;
  if (Date.now() - info.at > ttlMsFor(u, settings)) return null;
  return u;
}
/** 是不是 https 进来的（部署时前面一般挂 nginx，真正的 TLS 在它那一层） */
function isHttps(req) {
  return !!(req && (req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"));
}
function setTokenCookie(res, token, req, user) {
  // https 下补上 Secure：否则同一个域名只要有一次 http 请求，令牌就明文躺在路上了
  const secure = isHttps(req) ? "; Secure" : "";
  // cookie 的 Max-Age 跟服务端那把尺子对齐（组织自己配的登录有效期）。
  // 服务端才是真闸门，这里对齐只是别让浏览器留着一个早就作废的 cookie 反复吃 401
  const maxAge = Math.floor(ttlMsFor(user) / 1000);
  res.setHeader("Set-Cookie", `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`);
}
function clearTokenCookie(res, req) {
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
}

// ---------- 登录闸 ----------
/**
 * 密码是 scrypt 算的，一次几十毫秒，而 server 就跑在 Electron 主进程里——
 * 不拦着的话，一个字典跑上来界面先卡死，密码也早晚被撞开。
 * 只在内存里记，重启就清空：这是防连打，不是封号。
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function createLimiter({ windowMs = LOGIN_WINDOW_MS, now = () => Date.now() } = {}) {
  const hits = new Map(); // key → { fails, first }
  function prune(t) {
    for (const [k, v] of hits) if (t - v.first > windowMs) hits.delete(k);
  }
  return {
    /** 还要等多少秒才能再试；能试就返回 0 */
    retryAfter(key, max) {
      const t = now();
      prune(t);
      const v = hits.get(key);
      if (!v || v.fails < max) return 0;
      return Math.max(1, Math.ceil((v.first + windowMs - t) / 1000));
    },
    fail(key) {
      const t = now();
      prune(t);
      const v = hits.get(key) || { fails: 0, first: t };
      v.fails++;
      hits.set(key, v);
    },
    pass(key) {
      hits.delete(key);
    },
  };
}
const loginLimiter = createLimiter();
const FAILS_PER_USER = 8; // 盯着一个账号打
const FAILS_PER_IP = 30; // 换着账号打
const REGS_PER_IP = 5; // 注册也得拦，不然一个脚本能把账本刷满

/** 私网/环回地址：判断「这一跳是不是我们自己那层反代」用的 */
function isPrivateAddr(ip) {
  const s = String(ip || "").replace(/^::ffff:/i, "");
  return /^127\./.test(s) || s === "::1" ||
    /^10\./.test(s) || /^192\.168\./.test(s) || /^172\.(1[6-9]|2\d|3[01])\./.test(s) ||
    /^f[cd][0-9a-f]{2}:/i.test(s) || /^fe80:/i.test(s);
}

/**
 * 谁在敲门。默认只认 socket 上的地址，**不认** X-Forwarded-For——那个头谁都能伪造，
 * 认了就等于把 IP 闸拆了（换一行头就是一个新 IP）。
 *
 * 但一挂反代（Docker 里的 Caddy、宿主机上的 nginx），所有人就共用代理那一个地址了，
 * 于是两道闸从「防连打」变成「团队互相锁死」：
 *   注册闸 5 次/15 分钟 —— 一个 10 人团队开号，第 6 个人开始注册不了；
 *   登录闸 30 次/15 分钟 —— 全公司加起来输错 30 次密码，所有人一起被关在门外。
 * 这不是理论风险：deploy.sh --domain 起来的就是「前面有 Caddy」这个形状。
 *
 * 所以给一个显式开关 OPENWORKBUDDY_TRUST_PROXY=<信任几层代理>，默认 0（不信）。开了之后：
 *   1) 直连进来的（peer 不是私网/环回）一律不信——说好前面有代理却直连，多半是配错了，
 *      这时候信头等于把闸拆给外网；
 *   2) 从**右往左**数第 N 跳才是我们自己那层代理写进去的。左边的都可能是客户端自己
 *      伪造后带上来的（他发一个 X-Forwarded-For，代理只会往后追加，不会替他删）。
 *      naive 实现取最左边那个，正好取到唯一能伪造的那一个。
 *   3) 链子比声明的短 → 说明中间少了一跳，退回 peer，宁可粗一点也不放行伪造的。
 */
function trustedHops() {
  return Math.max(0, Math.min(5, Math.floor(+process.env.OPENWORKBUDDY_TRUST_PROXY || 0)));
}
function clientIp(req) {
  const peer = (req.socket && req.socket.remoteAddress) || (req && req.ip) || "?";
  const n = trustedHops();
  if (!n || !isPrivateAddr(peer)) return peer;
  const hops = String((req.headers || {})["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return hops[hops.length - n] || peer;
}

// ---------- 积分与用量 ----------
/**
 * 命中缓存的那部分 prompt 上游按约 1/10 计费（DeepSeek 缓存命中 ¥0.5/M vs 未命中 ¥4/M，
 * Anthropic cache read 0.1x，OpenAI cached input 也打折），这里按同样的比例折算。
 *
 * 为什么非折不可：真实账本里 prompt 和 completion 是 64:1，agent 每走一步都要把整段上下文
 * 重发一遍，能不能命中缓存决定了这一大坨到底花多少钱。全价照收等于把「省下来了」和「没省」
 * 记成同一个数——用户看到的积分曲线跟真实账单脱节，也就没法据此去调 max_steps / 压缩阈值。
 */
function creditsFor(usage) {
  const cached = Math.min(usage.cached || 0, usage.prompt || 0);
  const billable = (usage.prompt || 0) - cached * 0.9 + (usage.completion || 0);
  return Math.max(1, Math.ceil(billable / 1000));
}

/**
 * 一次任务结束后记账：按 tokens 扣积分 + 写用量流水。
 * 积分闸门关着（默认）时只写流水不扣数，返回 0——用量该看还得看，额度不该拦人。
 * @param user  users.json 里的用户对象（会同步更新其 credits 字段）
 * @param info  { prompt, cached, completion, calls, elapsed_ms, model, provider, source, sessionId }
 * @returns 本次扣掉的积分数（不限额时为 0）
 */
function chargeRun(user, info) {
  info = fixLegacyCache(info);
  const st = loadUsers();
  const u = st.users.find((x) => x.username === user.username);
  // 「这个组织开没开用量限额」要按**账本里**的那条记录判，不能按调用方手上那个对象判：
  // 定时任务、IM 入站传进来的 user 可能是几小时前取的，缺 org 字段就会被当成默认组织，
  // 于是整条任务一分不扣——账对不上还查不出来。以库里的为准，传进来的只当兜底。
  const spent = creditsEnabled(u || user) ? creditsFor(info) : 0;
  // 真金白银那一笔，跟积分各算各的、一起记。
  // 为什么不用积分代替钱：积分是「所有模型一个价」的字数折算（creditsFor 那一行），
  // 拿它排「这个月谁花得多」，排出来的是「谁的字数多」——而 Opus 的输出价是
  // gpt-5-nano 的一百多倍，两件事经常是反的。为什么也不拿钱代替积分：积分是**发给人**
  // 的配额，一人一个月多少、用完加油包，跟上游调不调价没关系；价钱一变，
  // 所有人的配额会跟着莫名其妙地变多变少。所以两本账并排记，各回答各的问题。
  // 算钱这一步绝不能把一次成功的调用搅黄——价目表读坏了、组织设置里塞了个怪值，
  // 都只应该让这一格空着，不应该让用户看见「任务失败」。所以整段吞异常。
  let cost = null;
  try {
    const o = org.getOrg(org.orgIdOf(u || user));
    cost = pricing.costOf(info, { config: store.readJson(CONFIG_FILE, {}), discount: org.settingsOf(o).price_discount });
  } catch {}
  let fromMonthly = 0;
  if (u && spent) {
    // 抵扣顺序：先月固定用量（月底作废，不先花掉就是白扔），再加油包余额
    const s = org.settingsOf(org.getOrg(org.orgIdOf(u)));
    if (u.month_key !== monthKey()) {
      u.month_key = monthKey();
      u.month_used = 0;
    }
    fromMonthly = Math.min(spent, monthlyLeft(u, s));
    u.month_used = (u.month_used || 0) + fromMonthly;
    u.credits = Math.max(0, (u.credits || 0) - (spent - fromMonthly));
    saveUsers(st);
    user.credits = u.credits; // 让调用方拿到最新余额
    user.month_key = u.month_key;
    user.month_used = u.month_used;
  }
  // 把这一笔补进钱闸的内存账（必须在 append 之前，budget.record 那段注释说了为什么）。
  // 不补的话：员工在界面上跑的任务在闸子眼里永远不花钱，
  // 而后台那一页（直接扫流水）说它花了——同一屏上两个数互相矛盾。
  // 算不出价的那些（cost_unknown）不补，跟 spentOf 一个口径：
  // 把「不知道」当成「不花钱」累进已用额度，不如让它单独计数、后台催着去补价目。
  if (cost && !cost.unknown && cost.yuan > 0) {
    try { budget.record({ orgId: org.orgIdOf(u || user), user: user.username, yuan: cost.yuan }); } catch {}
  }
  usageStore.append({
    ts: new Date().toISOString(),
    day: localDay(),
    kind: "run",
    user: user.username,
    source: info.source || "web",
    sessionId: info.sessionId || "",
    model: info.model || "",
    provider: info.provider || "",
    prompt: info.prompt || 0,
    // 其中命中缓存的部分。llm.js 已经把三家不同的字段名统一读了出来，可这一格以前没记，
    // 于是「有没有在反复全价重买同一段上下文」这个问题一出任务就再也查不到了。
    cached: info.cached || 0,
    completion: info.completion || 0,
    calls: info.calls || 0,
    elapsed_ms: info.elapsed_ms || 0,
    credits: spent,
    // 这一笔折合多少钱（元），以及价目是查着了还是没查着。
    // cost_unknown 必须单独记一格：没查着价的时候 cost 是 0，而「0 元」和「不知道多少钱」
    // 在账上是完全不同的两件事——把它们混成同一个 0，后台那张月度汇总就会安静地少算，
    // 少多少还没人知道。有了这一格，汇总能说「另有 37 笔没有价目」，而不是假装账是全的。
    cost: cost ? cost.yuan : 0,
    cost_unknown: cost ? !!cost.unknown : true,
    // 这一笔记的时候用了哪条价目、打了几折。上游调价之后翻旧账，凭的就是这两格——
    // 不记的话，历史账目只能拿**今天**的价重算，于是「上个月为什么这么贵」永远查不清。
    price_key: cost && !cost.unknown ? cost.key : "",
    discount: cost ? cost.discount : 1,
    // 这一笔里有多少是月固定用量出的。不记的话，后台的「月固定用量还剩多少」只能猜
    from_monthly: fromMonthly,
    org: org.orgIdOf(u || user),
    dept: (u && u.dept) || "",
  });
  return spent;
}

function topup(byUser, targetUsername, amount) {
  amount = Math.floor(+amount);
  if (!(amount >= 1 && amount <= 1000000)) throw new Error("充值数量需在 1 - 1000000 之间");
  const st = loadUsers();
  const target = st.users.find((u) => u.username === (targetUsername || byUser.username));
  if (!target) throw new Error("用户不存在");
  // 跨组织充值 = 一个组织的管理员往别人家账本里写数，直接不给
  if (org.orgIdOf(target) !== org.orgIdOf(byUser)) throw new Error("只能给本组织的成员充值");
  target.credits = (target.credits || 0) + amount;
  saveUsers(st);
  usageStore.append({ ts: new Date().toISOString(), day: localDay(), kind: "topup", user: target.username, by: byUser.username, credits: amount });
  return target.credits;
}

/**
 * 缓存读比输入还大，只有一种可能：这笔是按 Anthropic 口径报的（input_tokens 不含缓存读），
 * 得把缓存读补回输入里才是「这次真的喂进去多少」。以前没补：本机 Claude Code 跑的 4 笔账，
 * 界面算出「缓存命中 3209% / 1749%」。源头（engines/claude-code.js）已改口径，这里管老账。
 */
function fixLegacyCache(e) {
  if (!e || !((e.cached || 0) > (e.prompt || 0))) return e;
  return { ...e, prompt: (e.prompt || 0) + (e.cached || 0) };
}

/**
 * 用量详情：今日/本月汇总 + 近 7 天曲线 + 流水（管理员看全员，成员只看自己）。
 *
 * opts.from / opts.to  —— `YYYY-MM-DD`，闭区间，按记账当天算。
 * opts.q               —— 在成员/模型/入口里做不分大小写的子串搜。
 * opts.offset/limit    —— 翻页。返回里的 total 是「符合筛选的总条数」，不是这一页的条数。
 *
 * 为什么非得有这三样：以前这里只会 `slice(0, limit)`，界面上就只能写「最近 25 条，
 * 再往前的看不了，要全量请导出」。财务问「上个月小圆花了多少」——这个后台答不上来，
 * 只能导出一个 CSV 再拿 Excel 去算。一个管钱的后台连这都做不到，说不过去。
 *
 * from/to 给了的时候，by_user / by_model / by_source 也跟着这个区间算
 * （「上个月谁花得最多」问的就是这个），而 today / month / last7 永远按各自的窗口算——
 * 它们的定义里就带着时间，再被区间截一刀只会算出一个没人看得懂的数。
 */
function usageSummary(user, opts = {}) {
  // 只打开真正用得上的分片。today / month / last7 三块永远要最近这一周的流水，
  // 所以下界取「筛选区间的起点」和「七天前」里更早的那个。没给起点（= 要全部时间的
  // 合计）就只能整本读——那个数字要准就得把话说全；后台每打开一次读一次，不在热路径上。
  const fromMonth = String(opts.from || "").slice(0, 7);
  const weekMonth = localDay(new Date(Date.now() - 6 * 86400 * 1000)).slice(0, 7);
  const all = usageStore.read({ from: fromMonth ? (fromMonth < weekMonth ? fromMonth : weekMonth) : "" }).map(fixLegacyCache);
  // 管理员看的是**本组织**全员，不是全库全员：多租户下后者等于把别家的账摊开给他看。
  // org 字段是后加的，老流水没有——按「这个用户名属不属于本组织」兜底判，别把历史记录判丢了
  const orgId = org.orgIdOf(user);
  const inOrg = new Set(loadUsers().users.filter((u) => org.orgIdOf(u) === orgId).map((u) => u.username));
  const admin = rbac.can(user, "usage.read_org");
  const scope = opts.user ? (e) => e.user === opts.user : admin ? (e) => inOrg.has(e.user) : (e) => e.user === user.username;
  const mine = all.filter(scope);
  const runs = mine.filter((e) => e.kind === "run");

  // ---- 筛选：时间区间 + 关键词 ----
  const from = String(opts.from || "").slice(0, 10);
  const to = String(opts.to || "").slice(0, 10);
  // 老流水没有 day 字段的，从 ts 现推一个，别把它们判成「不在任何区间里」而整段消失
  const dayOf = (e) => e.day || String(e.ts || "").slice(0, 10);
  const inRange = (e) => {
    if (!from && !to) return true;
    const d = dayOf(e);
    if (!d) return false;
    return (!from || d >= from) && (!to || d <= to);
  };
  const needle = String(opts.q || "").trim().toLowerCase();
  const hit = (e) =>
    !needle ||
    [e.user, e.model, e.provider, e.source, e.kind].some((x) => String(x || "").toLowerCase().includes(needle));
  const picked = mine.filter((e) => inRange(e) && hit(e));
  const rangeRuns = (from || to || needle) ? runs.filter((e) => inRange(e) && hit(e)) : runs;
  const offset = Math.max(0, Math.floor(+opts.offset || 0));
  const limit = Math.max(1, Math.min(1000, Math.floor(+opts.limit || 50)));
  const today = localDay();
  const month = today.slice(0, 7);
  // cached 是后加的字段，老流水没有它。算命中率时只拿「记过这个字段的那些条」当分母，
  // 否则历史记录会把分母撑大、把命中率稀释成一个假的低值，看着像缓存压根没生效。
  const agg = (list) => {
    const known = list.filter((e) => e.cached != null);
    return {
      runs: list.length,
      tokens: list.reduce((s, e) => s + (e.prompt || 0) + (e.completion || 0), 0),
      cached: known.reduce((s, e) => s + (e.cached || 0), 0),
      cachedOf: known.reduce((s, e) => s + (e.prompt || 0), 0), // 命中率的分母：这些条的 prompt 总量
      credits: list.reduce((s, e) => s + (e.credits || 0), 0),
      from_monthly: list.reduce((s, e) => s + (e.from_monthly || 0), 0),
      elapsed_ms: list.reduce((s, e) => s + (e.elapsed_ms || 0), 0),
    };
  };
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000);
    const day = localDay(d);
    last7.push({ day, ...agg(runs.filter((e) => e.day === day)) });
  }
  return {
    user: publicUser(user),
    today: agg(runs.filter((e) => e.day === today)),
    month: agg(runs.filter((e) => e.day && e.day.slice(0, 7) === month)),
    last7,
    recent: picked.slice(offset, offset + limit),
    // 这三个是给翻页条用的：total 是符合筛选的**全部**条数
    total: picked.length,
    offset,
    limit,
    // 筛选区间内的合计。没给区间时等于「全部流水」的合计，界面照样能显示
    range: agg(rangeRuns),
    // 按人 / 按模型的分组，管理后台的「成员用量」「应用用量」两块直接用
    by_user: groupUsage(rangeRuns, (e) => e.user || "?"),
    by_model: groupUsage(rangeRuns, (e) => e.model || "（未记录）"),
    by_source: groupUsage(rangeRuns, (e) => e.source || "web"),
    // 按部门：流水里的 dept 是**记账当时**的部门。人换了部门老账不跟着搬，
    // 因为账本记的是「当时谁在哪个部门花的钱」，跟着搬会把上个月的部门账改掉
    by_dept: groupUsage(rangeRuns, (e) => e.dept || "未分组"),
  };
}

/** 按某个维度分组汇总，倒序（花得多的排前面） */
function groupUsage(runs, keyOf) {
  const m = new Map();
  for (const e of runs) {
    const k = keyOf(e);
    const v = m.get(k) || { key: k, runs: 0, tokens: 0, credits: 0, elapsed_ms: 0 };
    v.runs++;
    v.tokens += (e.prompt || 0) + (e.completion || 0);
    v.credits += e.credits || 0;
    v.elapsed_ms += e.elapsed_ms || 0;
    m.set(k, v);
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens);
}


// ---------- 成员管理（企业管理后台用） ----------
// 角色分档、能力表、「只能管比自己低的那一档」这三件事全在 rbac.js 里，这儿只负责落到账本上。

/**
 * 一个组织里**第一个管理员级别的人，就是这个组织的超管**。注册和提拔走同一条规矩——
 * 只写在注册那条路上的话，「全是成员的老组织」里提两个管理员出来又是一片无主之地：
 * 两人同档互相动不了，而这个组织谁也发不出超管。
 */
function firstAdminIsOwner(st, orgId, role) {
  if (role !== "admin") return role;
  return st.users.some((u) => org.orgIdOf(u) === orgId && rbac.roleOf(u) === "owner") ? "admin" : "owner";
}

/** owner 这一格是给老代码和回退版本留的镜像，真相在 role 上。两边必须一起改 */
function syncOwner(u) {
  if (rbac.roleOf(u) === "owner") u.owner = true;
  else delete u.owner;
  return u;
}

/** 有没有写权限（管理员、超级管理员）。auditor（审计员）只读，不算 */
function isAdmin(u) {
  return rbac.can(u, "admin.write");
}
/** 能不能进管理后台（审计员进得去，但所有写操作都会被 adminOnly 挡下） */
function canAdmin(u) {
  return rbac.can(u, "admin.read");
}
/** 平台超级管理员 = 默认组织那一个超管 = 这台机器的主人 */
function platformOwner(u) {
  return rbac.roleOf(u) === "owner" && org.orgIdOf(u) === org.DEFAULT_ORG;
}

/**
 * 平台超管对**别的组织**高半档。
 *
 * 为什么要这半档：分公司的超管跑路了，那个组织就再也没人改得动——同档动不了同档。
 * 而这台机器本来就是他的，users.json 他直接拿编辑器就能改。这半档不降低任何安全性，
 * 它只是把「已经是机主」换成一个不用改文件的入口。**在自己组织里不加**：
 * 默认组织的超管对着默认组织的超管（也就是他自己）仍然是同档，转让才是那条路。
 */
function rankFor(actor, target) {
  const base = rbac.rankOf(actor);
  const cross = org.orgIdOf(actor) !== org.orgIdOf(target);
  return cross && platformOwner(actor) ? base + 10 : base;
}

/**
 * 谁能动谁。四条，每一条都是踩过的：
 *   1. 得有管人的权（管理员以上）
 *   2. 不能动自己 —— 管理员把自己降成成员之后，这个组织就再也没有管理员了
 *   3. 只能动同组织的人；平台超管例外，他跨组织有效（分公司超管跑路了得有人救场）
 *   4. **只能动比自己低的那一档**。这一条是新的，也是整件事的重点：
 *      以前只挡住 owner 一个人，于是两个管理员能互相停用、互相降级、互相删号，
 *      谁先点谁赢。现在管理员对管理员一步也走不动，要动另一个管理员只能找超管。
 */
function assertCanManage(actor, target, what) {
  if (!rbac.can(actor, "member.manage")) throw new Error("只有管理员能" + what);
  if (target.username === actor.username) throw new Error("不能对自己" + what);
  if (org.orgIdOf(actor) !== org.orgIdOf(target) && !platformOwner(actor)) throw new Error("这个成员不在你的组织里");
  if (rankFor(actor, target) <= rbac.rankOf(target)) {
    const t = rbac.ROLE_LABEL[rbac.roleOf(target)];
    const a = rbac.ROLE_LABEL[rbac.roleOf(actor)];
    throw new Error(rbac.rankOf(actor) === rbac.rankOf(target)
      ? `同级动不了同级：${a}${what}不了另一个${a}。要动他，得由更高一档的人来`
      : `${t}不能被${a}${what}`);
  }
}

/**
 * 最后一个超管删不得、停不得、降不得——不然这个组织当场变成无主之地：
 * 谁都进不去后台，也没人再能把超管发出来。要换人只有一条路：先转让，再动他。
 */
function assertNotLastOwner(u, what) {
  if (rbac.roleOf(u) !== "owner") return;
  throw new Error(`「${u.username}」是「${org.getOrg(org.orgIdOf(u)).name}」的超级管理员，不能被${what}。` +
    "要换人：先在「管理员角色」里把超级管理员转让给他，再回来" + what + "这个号");
}

/** 按登录名取人再过 assertCanManage。路由层要判「我管不管得到他」时用这个，别自己去翻账本 */
function assertManageable(actor, username, what) {
  const u = loadUsers().users.find((x) => x.username === username);
  if (!u) throw new Error("成员不存在");
  assertCanManage(actor, u, what);
  return u;
}

/** 翻页最多一次给多少人。后台自己要 50 一页，别的调用方最多要到这儿为止 */
const MEMBER_PAGE_MAX = 500;

/**
 * 从**已经排好序的**那一份里切出这一页。
 *
 * 必须排完再进来：先切后排的话，「第 1 页是谁」取决于这些人在账本里的物理顺序——
 * 谁昨天改过资料谁就可能跑到前面来，而人只会以为名单乱了。
 *
 * 两个边界都是拿地址栏改出来的，各夹一次：
 *   · limit=0 / limit=-5 当没传，回默认的一页。夹成 1 的话界面上是「一页一个人、六百页」
 *   · offset 翻过了头退回最后一页，不给一张空表——空表跟「这里根本没有人」长得一模一样
 *
 * @param opts.all 要整份。只给**确实要每一个人**的内部调用方用，别从 HTTP 上直接接过来
 */
function pageOf(sorted, opts = {}, fallback = 50) {
  const all = opts.all === true;
  const asked = Math.floor(+opts.limit);
  const limit = all ? Math.max(1, sorted.length) : Math.min(MEMBER_PAGE_MAX, asked > 0 ? asked : fallback);
  const last = sorted.length ? Math.floor((sorted.length - 1) / limit) * limit : 0;
  const offset = all ? 0 : Math.max(0, Math.min(Math.floor(+opts.offset || 0), last));
  return { page: all ? sorted : sorted.slice(offset, offset + limit), offset, limit };
}

/**
 * 本组织的成员：筛完、排完，只把**这一页**的人算出来。
 *
 * 为什么不是整份回去：实测 3000 人的组织，一次回包 1041 KB，浏览器里堆出 78098 个
 * DOM 节点，从点进这一页到表格出来 878ms；1000 人时 346 KB / 26098 个节点 / 259ms。
 * 而一屏看得见的是十几行。更别扭的是搜人——想找一个人，前提是先把三千人搬到浏览器里。
 *
 * 四步的顺序不能换：**先筛、再排、再切，最后才算**。
 *   · 排在切前面：不然「第 1 页是谁」取决于这些人在账本里的物理顺序，来个新人就全乱
 *   · 算在切后面：每个人要算角色、额度、本月剩余、余额，只有这一页的人值得算
 *   · 「最后活跃」也只查这一页这几十个名字：usageStore.lastActive 是人齐了就停的，
 *     查 50 个名字通常翻一个分片就够，查 3000 个要一路翻到底
 *
 * @param opts.q       搜昵称 / 登录名 / 部门，不分大小写
 * @param opts.role    只看某一档角色
 * @param opts.minRank 只看这一档**及以上**（给「管理员角色」那页用：它要的是管理层，不是全员）
 * @param opts.status  active（在用）| pending（等审核）| disabled（已停用）
 * @param opts.offset  从第几个开始；超出末尾会退回最后一页，不会给一张空表
 * @param opts.limit   这一页要几个，最多 MEMBER_PAGE_MAX
 * @param opts.all     要整份。只给**确实要每一个人**的内部调用方用，别从 HTTP 上直接接过来
 * @param opts.lite    只要 username / nickname / dept / role / status —— 下拉框用得着的那几格。
 *                     一个下拉框不需要知道每个人的余额，更不该为此翻一遍用量账本
 * @returns { members, total, matched, offset, limit }
 *          total = 这个组织一共多少人，matched = 筛完还剩多少（界面靠这两个数说「筛出 X / 共 Y」）
 */
function queryMembers(orgId, opts = {}) {
  const want = orgId || org.DEFAULT_ORG;
  const mine = loadUsers().users.filter((u) => org.orgIdOf(u) === want);

  const kw = String(opts.q || "").trim().toLowerCase();
  const role = String(opts.role || "").trim();
  const status = String(opts.status || "").trim();
  // 档位下限得在这儿判，不能等算完再筛：算一个人要过 publicUser（角色、额度、
  // 本月剩余、余额），三千个人算完只留下十来个管理员，那前面那些就是白算的
  const minRank = opts.minRank ? rbac.ROLE_RANK[opts.minRank] : null;
  const hit = mine.filter((u) => {
    if (role && rbac.roleOf(u) !== role) return false;
    if (minRank != null && !(rbac.ROLE_RANK[rbac.roleOf(u)] >= minRank)) return false;
    // 老账号没有 status 这一格，当在用算——跟 publicUser 里那一格的默认值必须是同一个
    if (status && (u.status || "active") !== status) return false;
    if (!kw) return true;
    return [u.username, u.nickname, u.dept].some((v) => String(v || "").toLowerCase().includes(kw));
  });
  // 超管排最前，其余按进来的先后。排序看的是原始账号，不是 publicUser 算出来的那份——
  // 算是切完页之后的事，这里还没算
  hit.sort((a, b) => (rbac.roleOf(b) === "owner" ? 1 : 0) - (rbac.roleOf(a) === "owner" ? 1 : 0)
    || String(a.created_at).localeCompare(String(b.created_at)));

  const { page, offset, limit } = pageOf(hit, opts);
  const meta = { total: mine.length, matched: hit.length, offset, limit };

  if (opts.lite)
    return { members: page.map((u) => ({ username: u.username, nickname: u.nickname || "", dept: u.dept || "",
      role: rbac.roleOf(u), status: u.status || "active" })), ...meta };

  // 组织设置在这一趟里不会变，读一次就够。这里省掉的不是零头：
  // publicUser 每个人要用三次，500 个人就是把 orgs.json 读 1500 遍、
  // 搬 1302 KB 进内存——而 orgs.json 里装着平台上**所有**公司的数据，
  // 于是你成员页的快慢取决于隔壁又来了几家（实测 50 人的页：2 家 5.6ms → 501 家 365.6ms）。
  // 能这么传是因为 mine 已经按 want 筛过了，这份设置对这里每一个人都是他自己的那份
  const s = org.settingsOf(org.getOrg(want));
  // 「最后活跃」只要每人最近的那一条。从新分片往老里翻、人齐了就停
  const lastAt = usageStore.lastActive(page.map((u) => u.username));
  return { members: page.map((u) => ({ ...publicUser(u, s), last_active: lastAt.get(u.username) || "" })), ...meta };
}

/** 本组织成员清单（整份，不含密码字段）。界面上的列表请走 queryMembers 翻页 */
function listMembers(orgId) {
  return queryMembers(orgId, { all: true }).members;
}

/**
 * 成员用量：每个人的额度、余额，和他从有记录以来一共花了多少。只算**这一页**的人。
 *
 * 规矩跟 queryMembers 一样——先筛、再排、再切，最后才算——中间只多一步：这一页要按
 * 「一共花了多少」排，所以得先把账本数一遍，把数贴到人身上，再排、再切。账本只翻这
 * 一遍，它的代价跟流水条数有关、跟公司多少人无关；真正按人头往上涨的是 publicUser
 * （角色、额度、本月剩余、余额），所以该省的是后者。实测 3000 人的组织，这一页原来
 * 一趟回包 678 KB、读盘 5.0 MB，而屏幕上看得见的是十几行。
 *
 * 为什么默认按花销倒序，而不是跟成员页一样按进公司的先后：这一页回答的是「钱花在谁
 * 身上了」。按花名册顺序排的话，花得最多的那几个散在六十页中间，等于没答。
 *
 * @param opts.q     搜昵称 / 登录名 / 部门，不分大小写
 * @param opts.dry   只看本月固定额度已经见底的人（首页那条待办点「去充值」过来就是这个）
 * @param opts.sort  tokens（默认，花得多的在前）| name（按花名册顺序，跟成员页对得上）
 * @returns { rows, total, matched, offset, limit, dry }
 *          dry = 这个组织**一共**几个人额度见底，不跟着筛选变——界面上那颗筛选钮要显示这个数，
 *          筛完再数的话，钮上写的永远是「筛出来的那些」，等于一进去就归零
 */
function memberUsage(orgId, opts = {}) {
  const want = orgId || org.DEFAULT_ORG;
  const s = org.settingsOf(org.getOrg(want));
  const mine = loadUsers().users.filter((u) => org.orgIdOf(u) === want);

  // 「额度见底」的口径跟首页那条待办、跟 memberStats 必须是同一个：
  // 在用的人、确实发过额度、这个月用完了。三处对不上的话，首页说三个人、
  // 点进来只剩一个，谁也说不清哪个是真的
  const isDry = (u) => (u.status || "active") === "active" && monthlyQuotaOf(u, s) > 0 && monthlyLeft(u, s) <= 0;
  const dryAll = mine.reduce((n, u) => n + (isDry(u) ? 1 : 0), 0);

  const kw = String(opts.q || "").trim().toLowerCase();
  const onlyDry = opts.dry === true || String(opts.dry) === "1";
  const hit = mine.filter((u) => {
    if (onlyDry && !isDry(u)) return false;
    if (!kw) return true;
    return [u.username, u.nickname, u.dept].some((v) => String(v || "").toLowerCase().includes(kw));
  });

  // 整本账数一遍就够。按人分组是在这儿一次算完的，不是一个人查一次
  const tally = new Map();
  for (const raw of usageStore.read({})) {
    if (!raw || raw.kind !== "run" || !raw.user) continue;
    const e = fixLegacyCache(raw);
    let t = tally.get(e.user);
    if (!t) tally.set(e.user, (t = { runs: 0, tokens: 0, credits: 0 }));
    t.runs++;
    t.tokens += (e.prompt || 0) + (e.completion || 0);
    t.credits += e.credits || 0;
  }
  const NONE = { runs: 0, tokens: 0, credits: 0 };
  const tallyOf = (u) => tally.get(u.username) || NONE;
  // 并列时按花名册顺序兜底。不兜的话，一屋子 0 的新人每刷新一次换一个次序，
  // 而人会以为名单在自己动
  const byRoster = (a, b) => (rbac.roleOf(b) === "owner" ? 1 : 0) - (rbac.roleOf(a) === "owner" ? 1 : 0)
    || String(a.created_at).localeCompare(String(b.created_at));
  hit.sort(String(opts.sort || "") === "name"
    ? byRoster
    : (a, b) => tallyOf(b).tokens - tallyOf(a).tokens || byRoster(a, b));

  const { page, offset, limit } = pageOf(hit, opts);
  const rows = page.map((u) => {
    const p = publicUser(u, s);
    const t = tallyOf(u);
    return {
      username: p.username, nickname: p.nickname, dept: p.dept, role: p.role, status: p.status,
      monthly_quota: p.monthly_quota, monthly_left: p.monthly_left, credits: p.credits, balance: p.balance,
      runs: t.runs, tokens: t.tokens, used_credits: t.credits, dry: isDry(u),
    };
  });
  return { rows, total: mine.length, matched: hit.length, offset, limit, dry: dryAll };
}

/**
 * 「每个人单独的 API 月上限」那张表：一页 50 个人，该动闸子的排在最前面。
 *
 * 为什么不按花名册顺序翻：这张表回答的是「谁的闸子要动」。三千人的公司里两千九百个是
 * 「跟随团队 · 本月 0 元」，按名册排的话头一页全是这种行，而真正设过单独上限、真正在
 * 花钱的那几十个人散在六十页中间——翻六十页才找得到的信息，等于没有。
 *
 * 停用的人不在这张表里：他已经调不出去了，摆在这儿只会让「这页有多少人」对不上席位数。
 *
 * @param opts.spent Map<登录名, 本月花了多少元>。由调用方扫账本得出——这一页本来就要扫一遍，
 *                   不传就当这个月谁都没花过，那样排序会退化成「设过上限的在前」，还是能用
 * @returns { rows, total, matched, offset, limit, capped }
 *          capped = 这个组织**一共**几个人设过单独上限，不跟着筛选变
 */
function memberBudgets(orgId, opts = {}) {
  const want = orgId || org.DEFAULT_ORG;
  const spent = opts.spent instanceof Map ? opts.spent : new Map();
  const mine = loadUsers().users.filter((u) => org.orgIdOf(u) === want && (u.status || "active") !== "disabled");
  const capped = mine.reduce((n, u) => n + (+u.budget_yuan > 0 ? 1 : 0), 0);

  const kw = String(opts.q || "").trim().toLowerCase();
  const hit = kw
    ? mine.filter((u) => [u.username, u.nickname, u.dept].some((v) => String(v || "").toLowerCase().includes(kw)))
    : mine;

  const yuanOf = (u) => spent.get(u.username) || 0;
  // 「要不要管他」优先于「花了多少」：设过单独上限的人哪怕这个月一分没花也得看得见，
  // 那条上限是会拦人的，而拦人的东西不该藏在第六十页
  const notable = (u) => (+u.budget_yuan > 0 || yuanOf(u) > 0 ? 1 : 0);
  hit.sort((a, b) => notable(b) - notable(a) || yuanOf(b) - yuanOf(a)
    || String(a.created_at).localeCompare(String(b.created_at)));

  const { page, offset, limit } = pageOf(hit, opts);
  return {
    rows: page.map((u) => ({
      username: u.username, nickname: u.nickname || "", dept: u.dept || "",
      status: u.status || "active", budget_yuan: +u.budget_yuan || 0, spent_month: yuanOf(u),
    })),
    total: mine.length, matched: hit.length, offset, limit, capped,
  };
}

/**
 * 这个组织里有没有这个人。只读一遍 users.json——不算额度、不算余额、不翻用量账本。
 *
 * 为什么不是 listMembers().find()：那个函数是给成员页用的，会把全公司每个人的角色、
 * 额度、本月剩余、余额全算出来，还要为「最后活跃」翻一遍账本——只为回答一个是非题。
 */
function findMember(orgId, username) {
  const want = orgId || org.DEFAULT_ORG;
  const name = String(username || "").trim();
  if (!name) return null;
  const u = loadUsers().users.find((x) => x.username === name && org.orgIdOf(x) === want);
  return u
    ? { username: u.username, nickname: u.nickname || "", dept: u.dept || "",
        role: rbac.roleOf(u), status: u.status || "active" }
    : null;
}

/**
 * 概览页要的那几个数：几个人、几个占席位、几个等审核、这个月一共发下去多少额度、
 * 几个人额度见底。一个人名都不用算。
 *
 * 为什么不拿 listMembers 数：概览是打开后台第一眼那一页，每次都要拉一次，
 * 而那个函数会把每个人的角色、额度、本月剩余、余额全算出来，还要为「最后活跃」
 * 翻一遍用量账本——3000 个人算一遍，换四个数字。这里只数数，加法都在内存里。
 *
 * 口径跟别处必须一致，两处各钉了断言：
 *   · 停用的人**不占席位**，但**仍然在 total 里**（他账号还在，文件也还在）
 *   · 等审核的人**占席位**——随时会被点头放进来，那时候席位不够就尴尬了
 *   · 没有 status 那一格的老账号当在用算（跟 publicUser / memberCounts 同一个默认值）
 */
function memberStats(orgId) {
  const want = orgId || org.DEFAULT_ORG;
  const s = org.settingsOf(org.getOrg(want));
  const out = { total: 0, used: 0, pending: 0, disabled: 0, granted: 0, dry: 0, dry_names: [] };
  for (const u of loadUsers().users) {
    if (org.orgIdOf(u) !== want) continue;
    out.total++;
    const status = u.status || "active";
    if (status === "pending") out.pending++;
    if (status === "disabled") out.disabled++;
    else out.used++;
    out.granted += monthlyQuotaOf(u, s);
    // 额度见底：跟首页那条待办一个口径——在用的人、确实发过额度、这个月用完了。
    // 停用的人不算（他本来就发不出请求），没发过额度的也不算（额度 0 = 不限，不是见底）
    if (status === "active" && monthlyQuotaOf(u, s) > 0 && monthlyLeft(u, s) <= 0) {
      out.dry++;
      // 界面上只点得下三个名字，多带的一律不带。这一格是**至多三个**，不是全部——
      // 谁要真名单，去成员页按「额度见底」筛
      if (out.dry_names.length < 3) out.dry_names.push(u.nickname || u.username);
    }
  }
  return out;
}

/**
 * 每个组织有多少人、其中多少个还在用。平台那张组织列表要的就这两个数。
 *
 * 为什么不拿 listMembers 一家一家查：那个函数是给**一个**组织的成员页用的，
 * 它会把这家公司每个人的角色、额度、本月剩余、余额全算出来，还要为「最后活跃」
 * 翻一遍用量账本。平台上 61 家公司的时候，一张 38 KB 的表要读 62 遍 users.json、
 * 61 遍用量账本，合计 **35.6 MB** 的盘，159ms；121 家时 98.3 MB、388ms——
 * 而这一页上一个人名都不显示，只显示两个数字。整本账数一遍就够了。
 *
 * @returns Map<组织 id, { members, active }>
 */
function memberCounts() {
  const out = new Map();
  for (const u of loadUsers().users) {
    const id = org.orgIdOf(u);
    let c = out.get(id);
    if (!c) out.set(id, (c = { members: 0, active: 0 }));
    c.members++;
    // 老账号没有 status 这一格，当 active 算——跟 publicUser 里那一格的默认值保持一致，
    // 两处对不上的话，同一家公司在成员页和组织列表上会显示两个不同的在用人数
    if ((u.status || "active") === "active") c.active++;
  }
  return out;
}

/**
 * 查一个人的记账要素，就这几格。
 *
 * 为什么不复用 listMembers：那个函数会把整本用量账翻一遍算「最后活跃」（lastActive），
 * 进一次后台查一次没问题，但中转站是**每个请求**都要查一次归属的——
 * 拿它当查询函数，等于给每一次 API 调用都附赠一次全账本扫描。
 * 这里只读 users.json，而且只抄出记账真正要用的四格。
 */
function billingUser(username) {
  if (!username) return null;
  const u = loadUsers().users.find((x) => x.username === username);
  if (!u) return null;
  return { username: u.username, org: org.orgIdOf(u), dept: u.dept || "", budget_yuan: u.budget_yuan || 0, status: u.status || "active" };
}

const MEMBER_STATUS = new Set(["active", "pending", "disabled"]);
/** 改成员的角色 / 部门 / 状态 / 月额度 / API 月预算。只改传进来的字段，没传的一律不动 */
function setMember(actor, username, patch) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!u) throw new Error("成员不存在");
  assertCanManage(actor, u, "修改");
  const changed = [];
  if (patch.role !== undefined && rbac.roleOf(u) !== patch.role) {
    // 授角色不是「改一个字段」：管理员能把成员提成审计员，但造不出第二个管理员——
    // 不然他绕一步就给自己发了第二把钥匙，「管理员之间动不了」那条规矩当场作废
    const bad = rbac.assignProblem(actor, u, patch.role);
    if (bad) throw new Error(bad);
    u.role = firstAdminIsOwner(st, org.orgIdOf(u), patch.role);
    syncOwner(u);
    changed.push("角色→" + rbac.ROLE_LABEL[u.role]);
  }
  if (patch.dept !== undefined) {
    const d = String(patch.dept || "");
    if (u.dept !== d) { u.dept = d; changed.push("部门→" + (d || "（无）")); }
  }
  if (patch.status !== undefined) {
    if (!MEMBER_STATUS.has(patch.status)) throw new Error("没有这个状态");
    if (patch.status !== "active") assertNotLastOwner(u, "停用");
    if ((u.status || "active") !== patch.status) {
      u.status = patch.status;
      changed.push("状态→" + patch.status);
      // 停用要当场把他的登录令牌全踢掉，不然这个人手上的浏览器还能接着用
      if (patch.status !== "active") for (const [t, i] of Object.entries(st.tokens)) if (i.user === username) delete st.tokens[t];
    }
  }
  if (patch.monthly_quota !== undefined) {
    const q = patch.monthly_quota === null || patch.monthly_quota === "" ? null : Math.max(0, Math.floor(+patch.monthly_quota) || 0);
    u.monthly_quota = q;
    changed.push("月额度→" + (q === null ? "跟随团队" : q));
  }
  if (patch.budget_yuan !== undefined) {
    // 钱按元存，最多两位小数，不取整（50.5 元取整成 50 就是把管理员填的数改了）。
    // 0 / 空 = 不单独设，回落到部门模板和组织默认——不是「一分钱都不给」。
    const n = parseFloat(patch.budget_yuan);
    const b = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
    if ((u.budget_yuan || 0) !== b) { u.budget_yuan = b; changed.push("API 月预算→" + (b ? b + " 元" : "跟随团队")); }
  }
  if (!changed.length) return publicUser(u);
  saveUsers(st);
  org.audit({ org: org.orgIdOf(u), actor: actor.username, action: "修改成员", target: username, detail: changed.join("、") });
  return publicUser(u);
}

/**
 * 管理员重置成员密码。返回一次性明文，**只返回这一次**，不落盘、不进日志。
 * 为什么不是「让管理员自己填一个」：填的那个多半就是他自己在用的密码，
 * 而且会经手聊天记录；随机生成 + 只显示一次，泄露面小得多。
 */
function resetPassword(actor, username) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!u) throw new Error("成员不存在");
  assertCanManage(actor, u, "重置密码");
  const pwd = genPassword(org.orgIdOf(u));
  u.salt = crypto.randomBytes(16).toString("hex");
  u.hash = hashPassword(pwd, u.salt);
  for (const [t, i] of Object.entries(st.tokens)) if (i.user === username) delete st.tokens[t];
  saveUsers(st);
  org.audit({ org: org.orgIdOf(u), actor: actor.username, action: "重置密码", target: username });
  return pwd;
}

/**
 * 忘记密码，自己救回来：在**服务器本机**跑一句 `openworkbuddy passwd <用户名>`。
 *
 * 为什么不是发邮件：发邮件要一台 SMTP 服务器、一个发信域名、一条反垃圾记录，
 * 还要把用户的邮箱存起来。本项目默认是装在自己电脑或自己 VPS 上的——为了一个
 * 一年用两次的功能去接一整套邮件基础设施，代价和攻击面都不划算（那条重置链接
 * 本身就是一把能登进来的钥匙，它会躺在邮箱里）。
 *
 * 那凭什么信调用方：**他能读到 users.json**。这份文件（0600）跟所有会话、所有
 * 记忆、config.json 里的 Key 在同一个目录下——能读它的人本来就已经拿到了这台机器上
 * 的一切，再拦一道密码没有任何意义。所以这条口子不降低安全性，它只是把「已经
 * 是机主」这件事换成一个不用改文件的入口。反过来说：**绝不能接到 HTTP 上**，
 * 一接就变成人人可用的改密接口了。
 *
 * 密码照样要过组织策略；改完把这个人所有地方的登录状态全踢掉——忘了密码往往
 * 是因为很久没登，那些还挂着的旧令牌是谁在用，说不好。
 */
function resetPasswordLocally(username, newPassword, { actor = "命令行" } = {}) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!u) throw new Error("没有这个账号：" + username);
  const pwd = newPassword == null || newPassword === "" ? genPassword(org.orgIdOf(u)) : String(newPassword);
  assertPassword(pwd, { username: u.username, org: org.orgIdOf(u) });
  u.salt = crypto.randomBytes(16).toString("hex");
  u.hash = hashPassword(pwd, u.salt);
  // 停用的账号改了密码也登不上，说清楚，别让人改完了还在门口试
  const disabled = u.status === "disabled";
  for (const [t, i] of Object.entries(st.tokens)) if (i.user === username) delete st.tokens[t];
  saveUsers(st);
  org.audit({ org: org.orgIdOf(u), actor, action: "本机重置密码", target: username, detail: "在服务器上用命令行改的" });
  return { password: pwd, generated: newPassword == null || newPassword === "", disabled, two_factor: twoFactorOn(u) };
}

/** 删成员。用量流水**不删**——账已经记下了，删人不该把历史花销也一起抹掉 */
function removeMember(actor, username) {
  const st = loadUsers();
  const i = st.users.findIndex((x) => x.username === username);
  if (i < 0) throw new Error("成员不存在");
  assertCanManage(actor, st.users[i], "删除");
  assertNotLastOwner(st.users[i], "删除");
  const [u] = st.users.splice(i, 1);
  for (const [t, info] of Object.entries(st.tokens)) if (info.user === username) delete st.tokens[t];
  saveUsers(st);
  org.audit({ org: org.orgIdOf(u), actor: actor.username, action: "删除成员", target: username });
  return publicUser(u);
}

/** 管理员直接建号（不走注册闸）。返回一次性明文密码 */
function createMember(actor, { username, role, dept, monthly_quota }) {
  if (!rbac.can(actor, "member.manage")) throw new Error("只有管理员能添加成员");
  // 建号跟改角色是同一件事，得过同一道闸：不然「管理员不能发管理员」绕一步就没了——
  // 直接新建一个管理员出来
  const want = role === undefined || role === null || role === "" ? "member" : String(role);
  const bad = rbac.assignProblem(actor, { role: "member" }, want);
  if (bad) throw new Error(bad);
  const pwd = genPassword(org.orgIdOf(actor));
  const u = register(username, pwd, { org: org.orgIdOf(actor), role: want, dept, status: "active" });
  if (monthly_quota !== undefined && monthly_quota !== null && monthly_quota !== "") {
    const st = loadUsers();
    const x = st.users.find((y) => y.username === u.username);
    x.monthly_quota = Math.max(0, Math.floor(+monthly_quota) || 0);
    saveUsers(st);
  }
  org.audit({ org: org.orgIdOf(u), actor: actor.username, action: "添加成员", target: u.username, detail: u.role });
  return { user: publicUser(u), password: pwd };
}

/**
 * 转让超级管理员。**每个组织只有一个**，所以这不是「再发一个」，是把位子交出去：
 * 新人成为超管，自己当场降成管理员。
 *
 * 为什么做成转让而不是「超管可以任命别的超管」：两个超管等于把「同级动不了同级」
 * 这条规矩在最高那一档上重新打开——要么允许互相罢免（先手优势原样回来），
 * 要么谁也罢免不了谁（点错一次就永远拿不下来）。这两种都比现在糟。
 *
 * 谁能转：这个组织现任的超管**本人**；或者平台超管（默认组织那一个）替别的组织指派——
 * 分公司超管跑路了，总得有人能救场。
 */
function transferOwner(actor, username) {
  const st = loadUsers();
  const to = st.users.find((x) => x.username === username);
  if (!to) throw new Error("成员不存在");
  const orgId = org.orgIdOf(to);
  const from = st.users.find((x) => rbac.roleOf(x) === "owner" && org.orgIdOf(x) === orgId);
  const mine = org.orgIdOf(actor) === orgId;
  const NOT_YOURS = "只有现任超级管理员本人能转让这个位子；他联系不上了，就找平台超级管理员（默认组织那一个）代为指派";
  // 别的组织的人：这个位子交出去等于那个组织换了个主子。平台超管例外，那是救场用的
  if (!mine && !platformOwner(actor))
    throw new Error(rbac.can(actor, "owner.transfer") ? "只能转给本组织的人：把位子交给别的组织的人，等于这个组织换了个主子" : NOT_YOURS);
  const isIncumbent = mine && rbac.can(actor, "owner.transfer") && (!from || from.username === actor.username);
  if (!isIncumbent && !platformOwner(actor)) throw new Error(NOT_YOURS);
  if (from && from.username === to.username) throw new Error("「" + username + "」已经是超级管理员了");
  if ((to.status || "active") !== "active") throw new Error("只能转给在职的人，「" + username + "」现在是" + ((to.status === "pending") ? "待审核" : "已停用"));
  to.role = "owner";
  syncOwner(to);
  // 老超管降成管理员，不是降成成员：他刚交出去的是钥匙，不是这份工作
  if (from) { from.role = "admin"; syncOwner(from); }
  saveUsers(st);
  org.audit({ org: orgId, actor: (actor && actor.username) || "", action: "转让超级管理员", target: to.username,
    detail: from ? "由 " + from.username + " 交出，他改任管理员" : "这个组织原来没有超级管理员" });
  return { from: from ? publicUser(from) : null, to: publicUser(to) };
}

/**
 * 在**服务器本机**指派超管：`openworkbuddy owner <用户名>`。
 *
 * 唯一的超管把自己锁在门外时（离职、号被停、手机和密码一起丢），界面上就没有出口了——
 * 同级动不了同级，而他自己登不进来。凭什么信调用方：**他能读到 users.json**。
 * 整段理由跟 resetPasswordLocally 一模一样，连结论都一样：**绝不能接到 HTTP 上**。
 */
function setOwnerLocally(username, { actor = "命令行" } = {}) {
  const st = loadUsers();
  const to = st.users.find((x) => x.username === username);
  if (!to) throw new Error("没有这个账号：" + username);
  const orgId = org.orgIdOf(to);
  const from = st.users.find((x) => rbac.roleOf(x) === "owner" && org.orgIdOf(x) === orgId);
  if (from && from.username === to.username) throw new Error("「" + username + "」已经是超级管理员了");
  to.role = "owner";
  syncOwner(to);
  if (from) { from.role = "admin"; syncOwner(from); }
  // 停用状态下改了也登不上，照 passwd 的规矩把这件事说出来，别让人改完了还在门口试
  const disabled = (to.status || "active") !== "active";
  saveUsers(st);
  org.audit({ org: orgId, actor, action: "指派超级管理员", target: to.username, detail: "在服务器上用命令行改的" + (from ? "；原超管 " + from.username + " 改任管理员" : "") });
  return { org: orgId, org_name: org.getOrg(orgId).name, from: from ? from.username : "", disabled, two_factor: twoFactorOn(to) };
}

/**
 * 升级搬家：把老账本抬到新的角色模型上。两件事，都只做一次（做完就不满足条件了）：
 *   1. 老账本里 owner 是**一个布尔**，抬成 role:"owner" 这一档；
 *   2. 以前 owner 只给全站第一个人，**分公司里一个超管都没有**——那些组织的管理员
 *      互相之间谁都能停用谁。给每个还没超管的组织补一个：在职管理员里建号最早的那个。
 * 一个管理员都没有的组织先空着，等谁被提成管理员再说（没人可补，硬补只会补错人）。
 */
function migrateOwners() {
  const st = loadUsers();
  if (!st.users.length) return 0;
  let n = 0;
  for (const u of st.users) if (u.owner && rbac.roleOf(u) !== "owner") { u.role = "owner"; n++; }
  const byOrg = new Map();
  for (const u of st.users) {
    const o = org.orgIdOf(u);
    if (!byOrg.has(o)) byOrg.set(o, []);
    byOrg.get(o).push(u);
  }
  for (const [orgId, list] of byOrg) {
    if (list.some((u) => rbac.roleOf(u) === "owner")) continue;
    const pick = list
      .filter((u) => rbac.rankOf(u) >= rbac.ROLE_RANK.admin && (u.status || "active") === "active")
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    if (!pick) continue;
    pick.role = "owner";
    n++;
    try {
      org.audit({ org: orgId, actor: "升级迁移", action: "设为超级管理员", target: pick.username,
        detail: "这个组织原来没有超级管理员，按建号顺序补上最早的那个管理员" });
    } catch {}
  }
  if (!n) return 0;
  for (const u of st.users) syncOwner(u);
  saveUsers(st);
  return n;
}

/** 待审核的人（自助注册进来、组织开了「需要审核」的） */
function pendingMembers(orgId) {
  return listMembers(orgId).filter((m) => m.status === "pending");
}

// ---------- Express 路由与守卫 ----------
// 外部回调有自己的签名/密钥校验，不走登录（微信侧还有 AES 解密这道闸）
const PUBLIC_IM = new Set(["/im/task", "/im/feishu/events", "/im/wecom/events", "/im/mp/events"]);
// 握手接口不需要登录。它只回「我是 OpenWorkBuddy、哪一版」，不带任何配置和数据——
// 桌面壳在端口被占时靠它区分「另一台自己人」和「别的程序」（见 server.js 的 portHeldByUs）。
// 摆在登录闸后面的话，一台还没登录的实例会回 401，壳就把自己人当成陌生人，转头换个口又起一台。
const PUBLIC_API = new Set(["/api/ping"]);

/** 登录守卫：/api/*（除 /api/auth/*）与 UI 用的 /im/status 等需要已登录，其余放行 */
/**
 * 远程那两个开关的统一读法。默认关（见 org.js 的 ORG_DEFAULTS）。
 *
 * 为什么按「这个用户属于哪个组织」读而不是全局读：多租户装机里，A 公司愿意让人扫码把手机连上来，
 * B 公司不愿意——一个全局开关只能一刀切。取不到用户就退回默认组织，也就是默认关。
 */
function remoteAllowed(which, user) {
  try {
    return org.settingsOf(org.getOrg(user ? org.orgIdOf(user) : org.DEFAULT_ORG))[which] === true;
  } catch {
    // 组织表读不出来不是打开远程口子的理由——出错一律按关处理
    return false;
  }
}

function authGuard(req, res, next) {
  // 小写化再判：Express 路由默认大小写不敏感，/API/settings 照样命中 /api/settings 的处理器。
  // 用原样 req.path 做 startsWith 的话，大写前缀会判成「不需要登录」，整个 /api 就敞开了。
  const p = req.path.toLowerCase();
  const needsAuth =
    (p.startsWith("/api/") && !p.startsWith("/api/auth/") && !PUBLIC_API.has(p)) ||
    (p.startsWith("/im/") && !PUBLIC_IM.has(p));
  if (!needsAuth) return next();
  // 这一趟请求里，users.json 和 orgs.json 各读一次就够。
  // 改之前是 users 读 3 遍（认人 / 判令牌类型 / 记活跃）、orgs 读 4 遍
  // （判令牌有效期 / 强制二次验证 / 远程开关 / 租户作用域），
  // 而这两本装的是**整个平台**的账号、所有活着的登录令牌和全部公司表——
  // 跟这个请求要干什么一点关系都没有。实测 1000 人 / 3000 个登录令牌的装机，
  // 一个什么都不做的接口光进门就是 13.18ms、读盘 2.36 MB；3000 人时 39.12ms、7.1 MB。
  // 聊天页几秒一次轮询，于是「公司人多了之后整个产品变慢」跟谁在用没关系。
  const st = loadUsers();
  let orgHit;
  const orgOf = (u) => (orgHit !== undefined ? orgHit : (orgHit = org.getOrg(org.orgIdOf(u))));
  const user = userFromReq(req, st, (u) => org.settingsOf(orgOf(u)));
  if (!user) return res.status(401).json({ error: "未登录", setup: !hasUsers(st) });
  // 待审核 / 已停用的账号：cookie 还在，但一步也走不了。
  // 这道闸必须在这里（而不是只在登录时判）——不然停用一个人之后，他手上开着的那个页面还能接着跑任务
  const status = user.status || "active";
  if (status === "pending") return res.status(403).json({ error: "账号还在等管理员审核通过", pending: true });
  if (status === "disabled") return res.status(403).json({ error: "账号已被停用，找管理员" , disabled: true });
  // 组织开了「强制二次验证」而这个人还没绑：除了绑定本身，别的一步也走不了。
  // 这道闸也必须在这儿——只在登录时判的话，管理员今天打开开关，昨天已经登录的人
  // 手上那个页面还能照常用到 cookie 过期，强制就成了「对新登录的人强制」。
  const orgSettings = org.settingsOf(orgOf(user));
  if (!twoFactorOn(user) && orgSettings.require_2fa && !TWOFA_SETUP_PATHS.has(p)) {
    return res.status(403).json({ error: "这个组织要求开启二次验证，先绑定验证器", need_2fa_setup: true });
  }
  // 「允许扫码连设备」关掉之后，**已经连上的那些也得断**。只拦新配对的话这个开关是假的：
  // 管理员在后台把它关了，以为丢在公司的那台手机已经进不来了，其实它手上的令牌还能用到过期。
  // 只踢 kind:"paired" 的令牌——正常在电脑上登录进来的（kind:"session"）跟这个开关无关。
  if (orgSettings.remote_devices !== true && tokenKind(req, st) === "paired") {
    return res.status(401).json({ error: "这台设备是扫码连上来的，而管理员已经关掉了「允许远程设备接入」", remote_off: true });
  }
  req.user = user;
  // 组织和它的设置顺手挂在请求上：后面的 tenantScope 要的就是这两样，
  // 不挂的话它会把 orgs.json 再读一遍，读出来的还是同一份
  req.org = orgOf(user);
  req.orgSettings = orgSettings;
  // 记一笔「这台设备刚才还在」。放在这儿而不是 userFromReq 里：那个函数一个请求里
  // 会被调好几次，而这件事一个请求记一次就够（里面还有 5 分钟的节流）
  touchDevice(req, st);
  next();
}
// 强制二次验证时唯一还放行的几条：绑定要用的三条，加上「我是谁」和登出。
// 少放 /api/auth/me 的话，前端连当前用户是谁都取不到，绑定页会白屏；
// 少放 logout 的话，绑不上的人连退出去换个号都做不到。
// 注意这几条本来就在 /api/auth/ 下面、走不到这道闸——写全是为了**防以后有人改 needsAuth**：
// 哪天把 /api/auth/ 挪进要登录的范围，这张表就是唯一还站着的那道保险。
const TWOFA_SETUP_PATHS = new Set([
  "/api/auth/2fa", "/api/auth/2fa/setup", "/api/auth/2fa/enable",
  "/api/auth/me", "/api/auth/logout",
]);

/** 写操作的管理员闸：审计员能进后台看，但不能改 */
function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: "只有管理员能做这个操作" });
  next();
}
/** 进管理后台的闸（管理员 + 审计员） */
function adminGuard(req, res, next) {
  if (!canAdmin(req.user)) return res.status(403).json({ error: "没有管理后台权限" });
  next();
}

/**
 * @param opts.onRename  改登录名之后的回调 (from, to)：会话文件归 server 管，
 *   它得把那边的归属一起搬走，不然历史任务就成了没主的。
 */
/**
 * 两个老开关（open_register / credits_enabled）以前存在 users.json 的 settings 里，
 * 现在归组织设置管。升级上来的装机得把它们搬过去——不搬的话，
 * 用户之前打开的「开放注册」会在升级后悄悄变回关闭，而他完全不知道发生了什么。
 * 搬完打个标记，只搬一次（之后组织设置才是唯一真相，再搬会把后来的修改盖回去）。
 */
function migrateLegacySettings() {
  const st = loadUsers();
  if (!st.users.length || st.settings.migrated_to_org) return false;
  const patch = {};
  if (st.settings.open_register !== undefined) patch.open_register = !!st.settings.open_register;
  if (st.settings.credits_enabled !== undefined) patch.credits_enabled = !!st.settings.credits_enabled;
  if (Object.keys(patch).length) org.updateOrg(org.DEFAULT_ORG, { settings: patch }, "升级迁移");
  st.settings.migrated_to_org = true;
  saveUsers(st);
  return true;
}

function createRouter(opts) {
  // express 只有这儿用：命令行每次起一个任务都会 require 本文件，顶上加载 express 白花 25–35 ms
  const router = require("express").Router();
  const onRename = (opts || {}).onRename;
  try { migrateLegacySettings(); } catch (e) { console.warn("[账号] 老开关搬家失败：" + e.message); }
  try { migrateOwners(); } catch (e) { console.warn("[账号] 超级管理员搬家失败：" + e.message); }

  router.get("/api/auth/state", (req, res) => {
    const st = loadUsers();
    const user = userFromReq(req);
    const o = org.getOrg(org.orgIdOf(user));
    res.json({
      users: st.users.length,
      authed: !!user,
      user: publicUser(user),
      open_register: openRegister(user),
      credits_enabled: creditsEnabled(user),
      // 界面据此决定：待审核 → 显示等待页；已停用 → 显示停用页；能不能进管理后台
      status: user ? user.status || "active" : "",
      // 组织开了「强制二次验证」而这个人还没绑。界面得**在进工作台之前**就把绑定页摆出来：
      // 不报这一条的话，authGuard 对他每一个 /api/* 都回 403，而界面照常画出整个工作台——
      // 他点什么弹什么错，而唯一的出路（绑定）恰恰藏在一个他也打不开的设置页里
      need_2fa_setup: !!user && !twoFactorOn(user) && !!org.settingsOf(o).require_2fa,
      can_admin: canAdmin(user),
      multi_tenant: org.multiTenant(),
      org: user ? { id: o.id, name: o.name, ...org.planInfo(o) } : null,
    });
  });

  router.post("/api/auth/register", (req, res) => {
    const ip = clientIp(req);
    const wait = loginLimiter.retryAfter("reg|" + ip, REGS_PER_IP);
    if (wait) return res.status(429).json({ error: `注册太频繁了，${wait} 秒后再试` });
    try {
      const { username, password, invite } = req.body || {};
      const st = loadUsers();
      const first = !st.users.length;
      let spec = {};
      let inv = null;
      if (!first) {
        // 两条路进来：邀请码（推荐）或者管理员开了自助注册。两条都没有就不给进
        if (invite) {
          inv = org.peekInvite(invite);
          if (!inv) throw new Error("邀请码不对");
          if (inv.error) throw new Error(inv.error);
          spec = { org: inv.org, role: inv.role, dept: inv.dept, status: "active" };
        } else {
          if (!openRegister()) throw new Error("要邀请码才能注册，找管理员要一个");
          const s = org.settingsOf(org.getOrg(org.DEFAULT_ORG));
          spec = { org: org.DEFAULT_ORG, role: "member", status: s.need_approval ? "pending" : "active" };
        }
      }
      loginLimiter.fail("reg|" + ip);
      const user = register(username, password, spec);
      if (inv) org.consumeInvite(inv.code, user.username);
      else if (!first) org.audit({ org: org.orgIdOf(user), actor: user.username, action: "自助注册", target: user.username, detail: user.status === "pending" ? "等待审核" : "已直接通过" });
      // 待审核的人也发 cookie：不发的话他登录后只能看到「用户名或密码不对」，
      // 完全不知道自己其实注册成功了、只是在排队
      setTokenCookie(res, issueToken(user.username), req, user);
      res.json({ ok: true, user: publicUser(user), pending: user.status === "pending" });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body || {};
    const name = String(username || "").trim();
    const ipKey = "ip|" + clientIp(req);
    const userKey = "user|" + name.toLowerCase();
    const wait = loginLimiter.retryAfter(userKey, FAILS_PER_USER) || loginLimiter.retryAfter(ipKey, FAILS_PER_IP);
    // 先看闸再算密码：scrypt 是重活，让它连打就等于替对方把 CPU 也占了
    if (wait) return res.status(429).json({ error: `试太多次了，${wait} 秒后再试` });
    const user = verify(name, password);
    if (!user) {
      loginLimiter.fail(userKey);
      loginLimiter.fail(ipKey);
      return res.status(401).json({ error: "用户名或密码不对" });
    }
    if ((user.status || "active") === "disabled") {
      loginLimiter.pass(userKey);
      loginLimiter.pass(ipKey);
      return res.status(403).json({ error: "这个账号已被管理员停用" });
    }
    // —— 二次验证。密码对了**还不算登录成功**，这儿不发 cookie ——
    if (twoFactorOn(user)) {
      const code = String((req.body || {}).code || "").trim();
      if (!code) {
        // 密码闸不放：密码对了但没给码，这一次也算一次尝试。
        // 放的话，攻击者拿密码表来撞，撞中了会收到 need_2fa（而不是「密码不对」），
        // 等于我们免费帮他标出了哪些密码是真的，还不计次数。
        loginLimiter.fail(userKey);
        return res.status(401).json({ need_2fa: true, error: "请输入验证器上的 6 位数字" });
      }
      const how = consumeTwoFactor(user.username, code);
      if (!how) {
        loginLimiter.fail(userKey);
        loginLimiter.fail(ipKey);
        return res.status(401).json({ need_2fa: true, error: "验证码不对或已经用过了" });
      }
      if (how === "recovery") {
        const left = ((loadUsers().users.find((x) => x.username === user.username) || {}).totp || {}).recovery || [];
        res.set("X-Recovery-Left", String(left.length));
      }
    }
    loginLimiter.pass(userKey);
    loginLimiter.pass(ipKey);
    setTokenCookie(res, issueToken(user.username), req, user);
    res.json({ ok: true, user: publicUser(user), pending: user.status === "pending",
      two_factor_status: twoFactorStatus(user) });
  });

  // ---------- 二次验证：绑定 / 关闭 / 恢复码 ----------
  // 三个接口都在 authGuard 后面（要先登录），另外**改动性的操作一律要再验一次身份**：
  // 开通要验码、关闭要验码、重发恢复码要验码。少了这一道，「电脑没锁人走开」
  // 就等于把账号交出去了——路过的人点两下就能把二次验证关掉。
  router.post("/api/auth/2fa/setup", async (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    // 绑定前先对一次密码：这一步之后屏幕上会出现密钥，等于账号的第二把钥匙
    if (!verify(user.username, (req.body || {}).password)) return res.status(400).json({ error: "密码不对" });
    try {
      const { secret, otpauth } = startEnroll(user.username, org.getOrg(org.orgIdOf(user)).name);
      // 二维码在服务端画。放前端就得往页面里塞一个二维码库，而这一页平时根本用不到它；
      // 画不出来也不算失败——底下还摆着那串密钥，手打进验证器一样能绑上（配对码那条路同理）
      const qr = await require("qrcode").toDataURL(otpauth, { width: 320, margin: 1, errorCorrectionLevel: "M" }).catch(() => "");
      res.json({ ok: true, secret, otpauth, qr });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post("/api/auth/2fa/enable", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    try {
      res.json({ ok: true, recovery: enableTOTP(user.username, (req.body || {}).code) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post("/api/auth/2fa/disable", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    if (!verify(user.username, (req.body || {}).password)) return res.status(400).json({ error: "密码不对" });
    if (org.settingsOf(org.getOrg(org.orgIdOf(user))).require_2fa) {
      return res.status(403).json({ error: "这个组织要求所有人都开二次验证，关不掉。要关先让管理员在企业设置里取消强制" });
    }
    try {
      disableTOTP(user.username, { code: (req.body || {}).code });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post("/api/auth/2fa/recovery", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    try {
      res.json({ ok: true, recovery: regenRecovery(user.username, (req.body || {}).code) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get("/api/auth/2fa", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    res.json(twoFactorStatus(user));
  });

  router.post("/api/auth/logout", (req, res) => {
    const token = tokenFromReq(req);
    if (token) {
      const st = loadUsers();
      delete st.tokens[token];
      saveUsers(st);
    }
    clearTokenCookie(res, req);
    res.json({ ok: true });
  });

  router.get("/api/auth/me", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    res.json(publicUser(user));
  });

  // 改昵称 / 头像。登录名不动——它是账号本身，改了历史用量和积分就对不上人了。
  router.post("/api/auth/profile", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    const body = req.body || {};
    const st = loadUsers();
    const u = st.users.find((x) => x.username === user.username);
    if (!u) return res.status(404).json({ error: "账号不存在" });
    try {
      if ("nickname" in body) {
        const nick = String(body.nickname || "").replace(/\s+/g, " ").trim();
        if (nick.length > 24) throw new Error("昵称最多 24 个字");
        u.nickname = nick;
      }
      if ("avatar" in body) u.avatar = normalizeAvatar(body.avatar);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    saveUsers(st);
    res.json({ ok: true, user: publicUser(u) });
  });

  /** 改登录名。改的是身份本身，比改昵称重得多，所以要拿密码确认一次 */
  router.post("/api/auth/username", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    const { username, password } = req.body || {};
    if (!verify(user.username, password)) return res.status(400).json({ error: "密码不对" });
    try {
      const from = user.username;
      const to = renameUser(from, username);
      if (to !== from && onRename) {
        try {
          onRename(from, to);
        } catch (e) {
          // 名字已经改完了，会话归属没搬动不该让整个操作看起来失败——但必须留痕，不能装没事
          console.warn(`[账号] ${from} → ${to} 的会话归属没搬动：${e.message}`);
        }
      }
      res.json({ ok: true, user: publicUser(loadUsers().users.find((x) => x.username === to)) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/api/auth/password", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    const { old_password, new_password } = req.body || {};
    if (!verify(user.username, old_password)) return res.status(400).json({ error: "原密码不对" });
    const bad = passwordProblem(new_password, { username: user.username, org: org.orgIdOf(user) });
    if (bad) return res.status(400).json({ error: bad.replace(/^密码/, "新密码") });
    if (new_password === old_password) return res.status(400).json({ error: "新密码不能和原密码一样" });
    const st = loadUsers();
    const u = st.users.find((x) => x.username === user.username);
    u.salt = crypto.randomBytes(16).toString("hex");
    u.hash = hashPassword(new_password, u.salt);
    saveUsers(st);
    // 改完密码把别处的会话全踢下线，只留当前这一个
    revokeTokens(user.username, tokenFromReq(req));
    res.json({ ok: true });
  });

  /** 开不开放注册：只有管理员能改 */
  router.post("/api/auth/open-register", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    if (!isAdmin(user)) return res.status(403).json({ error: "只有管理员能改" });
    const o = org.updateOrg(org.orgIdOf(user), { settings: { open_register: !!(req.body || {}).open_register } }, user.username);
    res.json({ ok: true, open_register: org.settingsOf(o).open_register });
  });

  /** 开不开积分闸门：默认关（不限额），只有管理员能改 */
  router.post("/api/auth/credits-enabled", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    if (!isAdmin(user)) return res.status(403).json({ error: "只有管理员能改" });
    const o = org.updateOrg(org.orgIdOf(user), { settings: { credits_enabled: !!(req.body || {}).credits_enabled } }, user.username);
    res.json({ ok: true, credits_enabled: org.settingsOf(o).credits_enabled });
  });

  // ---------- 远程访问：设备配对 ----------
  /** 在已经登录的这台机器上要一个配对码。码只在这条响应里出现一次，不进日志也不落盘 */
  router.post("/api/devices/pair", async (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    if (!remoteAllowed("remote_devices", user)) return res.status(403).json({ error: "管理员没开「允许远程设备接入」，扫码连设备这件事现在是关着的", remote_off: true });
    const p = newPairCode(user.username);
    // 二维码里编的是「带码的登录地址」，手机扫完直接落在填好码的那一页，一个字都不用敲。
    // 码照样是一次性 + 3 分钟，所以它躺在地址栏里的那点时间是可接受的；
    // 真正兜底的是 Referrer-Policy: no-referrer，不然这一页上任何外链都会把码带出去
    //
    // 一台机器可能有好几个能落地的地址（有线 + 无线、公司网 + 家里网）。挑法再准也可能挑错，
    // 所以把候选一起发给前端，界面上留一个「换一个地址」——猜错了人自己就能纠，
    // 不用对着一个扫不开的码猜是哪儿不对。最多三个，再多二维码的体积就压过用处了。
    const cands = pairOrigins(req).slice(0, 3);
    const origins = [];
    for (const c of cands) {
      const url = `${c.url}/?pair=${p.code}`;
      const qr = await require("qrcode").toDataURL(url, { width: 320, margin: 1, errorCorrectionLevel: "M" }).catch(() => "");
      origins.push({ host: c.host, url, qr, iface: c.iface });
    }
    const first = origins[0] || { host: "", url: "", qr: "" };
    res.json({
      code: p.code, pretty: p.code.slice(0, 4) + "-" + p.code.slice(4),
      url: first.url, host: first.host, qr: first.qr, origins,
      expires_at: p.expires_at, expires_in: p.expires_in,
    });
  });
  /** 连上没有？生成码那台机器轮询它，好把二维码换成「✓ 已连接」 */
  router.get("/api/devices/pair/status", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    if (!remoteAllowed("remote_devices", user)) return res.json({ pairing: false, expires_at: 0, claimed: null, remote_off: true });
    res.json(pairStatus(user.username));
  });
  /** 不配了。生成完才发现旁边站着人，得有个地方能立刻作废它 */
  router.post("/api/devices/pair/cancel", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    dropPairCode(user.username);
    res.json({ ok: true });
  });
  /**
   * 新设备拿码换令牌。**这一条不需要登录**——它就是用来代替登录的。
   * 所以限速比登录还紧：码只有 8 位，没有闸的话一台机器慢慢撞总能撞上。
   */
  router.post("/api/devices/claim", (req, res) => {
    const ip = clientIp(req);
    const key = "pair|" + ip;
    const wait = loginLimiter.retryAfter(key, PAIR_FAILS_PER_IP);
    if (wait) return res.status(429).json({ error: `配对码试太多次了，${wait} 秒后再试` });
    const body = req.body || {};
    // 这条口子不需要登录，所以没法先拿到用户再判开关——只能先换出结果、再按「码的主人
    // 属于哪个组织」判。换出来发现不许，就**当场把这次换来的令牌撤掉**，不能留在表里
    const r = claimPair(body.code, { name: body.name, ua: req.headers["user-agent"], ip });
    if (r && !remoteAllowed("remote_devices", r.user)) {
      try { revokeDevice(r.user.username, deviceId(r.token)); } catch {}
      return res.status(403).json({ error: "这台机器关掉了「允许远程设备接入」，配对码不作数", remote_off: true });
    }
    if (!r) {
      loginLimiter.fail(key);
      return res.status(401).json({ error: "配对码不对或者已经过期了，去电脑上重新生成一个" });
    }
    loginLimiter.pass(key);
    setTokenCookie(res, r.token, req, r.user);
    res.json({ ok: true, user: publicUser(r.user), pending: (r.user.status || "active") === "pending" });
  });
  /** 我名下都有哪些设备。发的是 id（令牌的哈希），不是令牌本身 */
  router.get("/api/devices", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    res.json({ devices: listDevices(user.username, tokenFromReq(req)), max: MAX_DEVICES });
  });
  /** 踢掉一台。手机丢了要能当场断干净，不能等 90 天令牌自己过期 */
  router.delete("/api/devices/:id", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    const id = String(req.params.id || "");
    if (!revokeDevice(user.username, id)) return res.status(404).json({ error: "没有这台设备（可能已经被踢掉了）" });
    // 踢的是自己这一台（比如在手机上点「退出这台设备」）：cookie 也一并清掉，
    // 不然浏览器还揣着一条已经作废的令牌，每个请求都吃 401，界面看着像坏了
    if (id === deviceId(tokenFromReq(req) || "")) clearTokenCookie(res, req);
    res.json({ ok: true });
  });

  router.get("/api/usage", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    res.json(usageSummary(user));
  });

  router.post("/api/credits/topup", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    if (!isAdmin(user)) return res.status(403).json({ error: "只有管理员可以充值" });
    try {
      const { amount, username } = req.body || {};
      const balance = topup(user, username, amount);
      res.json({ ok: true, username: username || user.username, balance });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = {
  fixLegacyCache,
  hasUsers,
  userCount,
  defaultUser,
  userFromReq,
  creditsFor,
  creditsEnabled,
  chargeRun,
  usageSummary,
  authGuard,
  // 中转站那条路也要一个一模一样的防连打闸（relay.js），没道理再写一个
  createLimiter,
  clientIp,
  createRouter,
  // 企业管理后台用的那一套
  isAdmin,
  canAdmin,
  adminGuard,
  adminOnly,
  publicUser,
  balanceOf,
  monthlyQuotaOf,
  monthlyLeft,
  listMembers,
  queryMembers,
  memberUsage,
  memberBudgets,
  findMember,
  memberStats,
  MEMBER_PAGE_MAX,
  memberCounts,
  billingUser,
  pendingMembers,
  setMember,
  createMember,
  removeMember,
  assertManageable,
  transferOwner,
  setOwnerLocally,
  migrateOwners,
  platformOwner,
  // 权限模型本身（角色分档、能力表、能不能授这个角色）。admin.js / lifecycle.js / 前端都要问它
  rbac,
  resetPassword,
  resetPasswordLocally,
  topup,
  // 二次验证：管理后台要能看状态、能给忘了手机的人重置；CLI 的救急口子也用这几个
  twoFactorOn,
  remoteAllowed,
  tokenKind,
  twoFactorStatus,
  disableTOTP,
  // 密码策略：admin.js 和 cli.js 改密码前都要先过这一关
  passwordProblem,
  assertPassword,
  genPassword,
  migrateLegacySettings,
  // 下面这些只给测试用：账本读写和登录闸得能在临时目录里单独验，不然一跑测试就动到真账号
  _internals: { readStore, writeStoreAtomic, createLimiter, startEnroll, enableTOTP, consumeTwoFactor, regenRecovery, hashRecovery, makeRecoveryCodes, isHttps, clientIp, isPrivateAddr, normalizeAvatar, register, renameUser, loadUsers, saveUsers, loadUsage, saveUsage, verify, issueToken,
    // 设备配对：配对码的一次性、过期、限速这几条都得能单独验
    newPairCode, dropPairCode, claimPair, pairStatus, pairOrigin, pairOrigins, lanCandidates, claimed, listDevices, revokeDevice, deviceId, deviceLabel, normalizePairCode, touchDevice, prunePairs, pairs, PAIR_LEN, PAIR_TTL_MS, PAIR_ALPHABET, MAX_DEVICES },
};
