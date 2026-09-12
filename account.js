"use strict";
/**
 * 账号体系 + 积分体系 + 用量流水 — Web / CLI / IM / 定时任务 共用一套账本。
 *
 * 数据文件（均不入 git）：
 *   data/users.json  { users: [{ username, salt, hash, role, credits, created_at }], tokens: { token: { user, at } } }
 *   data/usage.json  [ { ts, day, kind: "run"|"topup", user, source, model, prompt, cached, completion, calls, elapsed_ms, credits, ... } ]
 *
 * 计费规则：每消耗 1000 tokens（输入+输出）扣 1 积分，每次任务至少扣 1 积分。
 * 首个注册用户 = 管理员（10000 积分，可充值）；后续注册 = 成员（1000 积分）。
 *
 * 所有读写都直接落盘（读-改-写），CLI 与常驻服务两个进程共享同一账本不打架。
 */

const path = require("path");
const icons = require("./icons.js");
const { dataPath } = require("./paths");
const crypto = require("crypto");
const express = require("express");
const store = require("./store");
const org = require("./org");

// WB_DATA_DIR 只为测试留的口子：跑测试时指到临时目录，免得动到真账本
const DATA_DIR = process.env.WB_DATA_DIR || dataPath("data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const TOKEN_COOKIE = "wb_token";
const TOKEN_TTL_MS = 90 * 86400 * 1000;
/**
 * 登录有效期按**这个人所属组织**的设置算（企业管理后台 → 客户端安全）。
 * 判过期这件事必须按 org 走，不能只在发令牌时算一次：管理员把有效期从 90 天调到 7 天，
 * 是为了让**已经发出去的**那些 cookie 立刻作废（人离职了、电脑丢了），
 * 只影响新令牌等于这个开关根本没用。取不到组织就退回 90 天。
 */
function ttlMsFor(user) {
  try {
    const d = org.settingsOf(org.getOrg(org.orgIdOf(user))).session_days;
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
function writeStoreAtomic(file, data, pretty) {
  store.writeJsonAtomic(file, data, { pretty: !!pretty });
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
function loadUsage() {
  const d = readStore(USAGE_FILE, []);
  return Array.isArray(d) ? d : [];
}
function saveUsage(list) {
  writeStoreAtomic(USAGE_FILE, list.slice(0, 2000));
}
function localDay(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

// ---------- 密码与令牌 ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString("hex");
}
function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username,          // 登录名，不可改：改了就是换了个账号
    nickname: u.nickname || "",     // 昵称，界面上显示的名字
    avatar: u.avatar || "",         // 一两个 emoji，或者 data:image/... 的小图
    role: u.role,
    owner: !!u.owner,               // 组织所有者：不能被别的管理员降级/停用/删除
    org: u.org || org.DEFAULT_ORG,
    dept: u.dept || "",
    status: u.status || "active",   // active | pending（等审核）| disabled（已停用）
    credits: u.credits,             // 加油包余额
    monthly_quota: monthlyQuotaOf(u),   // 每月固定用量
    monthly_left: monthlyLeft(u),       // 本月还剩多少固定用量
    balance: balanceOf(u),              // 固定用量剩余 + 加油包，界面和闸门都看这个数
    created_at: u.created_at,
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
function balanceOf(user) {
  if (!user) return 0;
  const s = org.settingsOf(org.getOrg(org.orgIdOf(user)));
  return monthlyLeft(user, s) + Math.max(0, user.credits || 0);
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
function hasUsers() {
  return loadUsers().users.length > 0;
}
/** 首个用户（管理员）：CLI / IM / 定时任务 的消耗都记在他名下 */
function defaultUser() {
  const st = loadUsers();
  return st.users.find((u) => u.role === "admin") || st.users[0] || null;
}

function register(username, password, opts = {}) {
  username = String(username || "").trim();
  if (!/^[\w一-龥.-]{2,24}$/.test(username)) throw new Error("用户名需 2-24 位（中英文、数字、_.-）");
  if (String(password || "").length < 6) throw new Error("密码至少 6 位");
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
  const user = {
    username,
    salt,
    hash: hashPassword(password, salt),
    // 第一个账号是组织所有者：owner 这个标记只此一份，别的管理员动不了他
    role: first ? "admin" : opts.role === "admin" || opts.role === "auditor" ? opts.role : "member",
    org: orgId,
    dept: String(opts.dept || ""),
    status: first ? "active" : opts.status === "pending" ? "pending" : "active",
    credits: first ? 10000 : Math.max(0, Math.floor(s.default_member_credits || 0)),
    created_at: new Date().toISOString(),
  };
  if (first) user.owner = true;
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
  const usage = loadUsage();
  let hit = 0;
  for (const e of usage) {
    if (e.user === oldName) { e.user = newName; hit++; }
    if (e.by === oldName) { e.by = newName; hit++; }
  }
  if (hit) saveUsage(usage);
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

function issueToken(username) {
  const st = loadUsers();
  const token = crypto.randomBytes(24).toString("hex");
  st.tokens[token] = { user: username, at: Date.now() };
  // 清过期 + 同一用户最多保留 10 个会话令牌
  const mine = [];
  const byUser = new Map(st.users.map((u) => [u.username, u]));
  for (const [t, info] of Object.entries(st.tokens)) {
    if (Date.now() - info.at > ttlMsFor(byUser.get(info.user))) delete st.tokens[t];
    else if (info.user === username) mine.push([t, info.at]);
  }
  mine.sort((a, b) => b[1] - a[1]).slice(10).forEach(([t]) => delete st.tokens[t]);
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

function tokenFromReq(req) {
  const m = /(?:^|;\s*)wb_token=([\w]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : null;
}
function userFromReq(req) {
  const token = tokenFromReq(req);
  if (!token) return null;
  const st = loadUsers();
  const info = st.tokens[token];
  if (!info) return null;
  const u = st.users.find((x) => x.username === info.user) || null;
  if (!u) return null;
  if (Date.now() - info.at > ttlMsFor(u)) return null;
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
 * 所以给一个显式开关 WB_TRUST_PROXY=<信任几层代理>，默认 0（不信）。开了之后：
 *   1) 直连进来的（peer 不是私网/环回）一律不信——说好前面有代理却直连，多半是配错了，
 *      这时候信头等于把闸拆给外网；
 *   2) 从**右往左**数第 N 跳才是我们自己那层代理写进去的。左边的都可能是客户端自己
 *      伪造后带上来的（他发一个 X-Forwarded-For，代理只会往后追加，不会替他删）。
 *      naive 实现取最左边那个，正好取到唯一能伪造的那一个。
 *   3) 链子比声明的短 → 说明中间少了一跳，退回 peer，宁可粗一点也不放行伪造的。
 */
function trustedHops() {
  return Math.max(0, Math.min(5, Math.floor(+process.env.WB_TRUST_PROXY || 0)));
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
  const usage = loadUsage();
  usage.unshift({
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
    // 这一笔里有多少是月固定用量出的。不记的话，后台的「月固定用量还剩多少」只能猜
    from_monthly: fromMonthly,
    org: org.orgIdOf(u || user),
    dept: (u && u.dept) || "",
  });
  saveUsage(usage);
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
  const usage = loadUsage();
  usage.unshift({ ts: new Date().toISOString(), day: localDay(), kind: "topup", user: target.username, by: byUser.username, credits: amount });
  saveUsage(usage);
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

/** 用量详情：今日/本月汇总 + 近 7 天曲线 + 最近流水（管理员看全员，成员只看自己） */
function usageSummary(user, opts = {}) {
  const all = loadUsage().map(fixLegacyCache);
  // 管理员看的是**本组织**全员，不是全库全员：多租户下后者等于把别家的账摊开给他看。
  // org 字段是后加的，老流水没有——按「这个用户名属不属于本组织」兜底判，别把历史记录判丢了
  const orgId = org.orgIdOf(user);
  const inOrg = new Set(loadUsers().users.filter((u) => org.orgIdOf(u) === orgId).map((u) => u.username));
  const admin = user.role === "admin" || user.role === "auditor";
  const scope = opts.user ? (e) => e.user === opts.user : admin ? (e) => inOrg.has(e.user) : (e) => e.user === user.username;
  const mine = all.filter(scope);
  const runs = mine.filter((e) => e.kind === "run");
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
    recent: mine.slice(0, opts.limit || 50),
    // 按人 / 按模型的分组，管理后台的「成员用量」「应用用量」两块直接用
    by_user: groupUsage(runs, (e) => e.user || "?"),
    by_model: groupUsage(runs, (e) => e.model || "（未记录）"),
    by_source: groupUsage(runs, (e) => e.source || "web"),
    // 按部门：流水里的 dept 是**记账当时**的部门。人换了部门老账不跟着搬，
    // 因为账本记的是「当时谁在哪个部门花的钱」，跟着搬会把上个月的部门账改掉
    by_dept: groupUsage(runs, (e) => e.dept || "未分组"),
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
/** 有没有管理权限。auditor（审计员）只读，不算 */
function isAdmin(u) {
  return !!u && u.role === "admin";
}
/** 能不能进管理后台（审计员进得去，但所有写操作都会被 adminOnly 挡下） */
function canAdmin(u) {
  return !!u && (u.role === "admin" || u.role === "auditor");
}

/**
 * 谁能动谁。规则只有三条，但每一条都是踩过的：
 *   1. 只能动同组织的人 —— 跨组织改角色就是越权
 *   2. 所有者（owner）谁都动不了，包括别的管理员 —— 否则两个管理员能互相把对方停用
 *   3. 不能动自己 —— 管理员把自己降成成员之后，这个组织就再也没有管理员了
 */
function assertCanManage(actor, target, what) {
  if (!isAdmin(actor)) throw new Error("只有管理员能" + what);
  if (org.orgIdOf(actor) !== org.orgIdOf(target)) throw new Error("这个成员不在你的组织里");
  if (target.owner) throw new Error("组织所有者不能被" + what);
  if (target.username === actor.username) throw new Error("不能对自己" + what);
}

/** 本组织成员清单（不含密码字段）。管理后台的「成员与部门」直接渲染这个 */
function listMembers(orgId) {
  const want = orgId || org.DEFAULT_ORG;
  const usage = loadUsage();
  const lastAt = new Map();
  for (const e of usage) if (e.user && !lastAt.has(e.user)) lastAt.set(e.user, e.ts);
  return loadUsers()
    .users.filter((u) => org.orgIdOf(u) === want)
    .map((u) => ({ ...publicUser(u), last_active: lastAt.get(u.username) || "" }))
    .sort((a, b) => (b.owner ? 1 : 0) - (a.owner ? 1 : 0) || String(a.created_at).localeCompare(String(b.created_at)));
}

const MEMBER_ROLES = new Set(["admin", "auditor", "member"]);
const MEMBER_STATUS = new Set(["active", "pending", "disabled"]);
/** 改成员的角色 / 部门 / 状态 / 月额度。只改传进来的字段，没传的一律不动 */
function setMember(actor, username, patch) {
  const st = loadUsers();
  const u = st.users.find((x) => x.username === username);
  if (!u) throw new Error("成员不存在");
  assertCanManage(actor, u, "修改");
  const changed = [];
  if (patch.role !== undefined) {
    if (!MEMBER_ROLES.has(patch.role)) throw new Error("没有这个角色");
    if (u.role !== patch.role) { u.role = patch.role; changed.push("角色→" + patch.role); }
  }
  if (patch.dept !== undefined) {
    const d = String(patch.dept || "");
    if (u.dept !== d) { u.dept = d; changed.push("部门→" + (d || "（无）")); }
  }
  if (patch.status !== undefined) {
    if (!MEMBER_STATUS.has(patch.status)) throw new Error("没有这个状态");
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
  const pwd = crypto.randomBytes(6).toString("base64url");
  u.salt = crypto.randomBytes(16).toString("hex");
  u.hash = hashPassword(pwd, u.salt);
  for (const [t, i] of Object.entries(st.tokens)) if (i.user === username) delete st.tokens[t];
  saveUsers(st);
  org.audit({ org: org.orgIdOf(u), actor: actor.username, action: "重置密码", target: username });
  return pwd;
}

/** 删成员。用量流水**不删**——账已经记下了，删人不该把历史花销也一起抹掉 */
function removeMember(actor, username) {
  const st = loadUsers();
  const i = st.users.findIndex((x) => x.username === username);
  if (i < 0) throw new Error("成员不存在");
  assertCanManage(actor, st.users[i], "删除");
  const [u] = st.users.splice(i, 1);
  for (const [t, info] of Object.entries(st.tokens)) if (info.user === username) delete st.tokens[t];
  saveUsers(st);
  org.audit({ org: org.orgIdOf(u), actor: actor.username, action: "删除成员", target: username });
  return publicUser(u);
}

/** 管理员直接建号（不走注册闸）。返回一次性明文密码 */
function createMember(actor, { username, role, dept, monthly_quota }) {
  if (!isAdmin(actor)) throw new Error("只有管理员能添加成员");
  const pwd = crypto.randomBytes(6).toString("base64url");
  const u = register(username, pwd, { org: org.orgIdOf(actor), role, dept, status: "active" });
  if (monthly_quota !== undefined && monthly_quota !== null && monthly_quota !== "") {
    const st = loadUsers();
    const x = st.users.find((y) => y.username === u.username);
    x.monthly_quota = Math.max(0, Math.floor(+monthly_quota) || 0);
    saveUsers(st);
  }
  org.audit({ org: org.orgIdOf(u), actor: actor.username, action: "添加成员", target: u.username, detail: u.role });
  return { user: publicUser(u), password: pwd };
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
function authGuard(req, res, next) {
  // 小写化再判：Express 路由默认大小写不敏感，/API/settings 照样命中 /api/settings 的处理器。
  // 用原样 req.path 做 startsWith 的话，大写前缀会判成「不需要登录」，整个 /api 就敞开了。
  const p = req.path.toLowerCase();
  const needsAuth =
    (p.startsWith("/api/") && !p.startsWith("/api/auth/") && !PUBLIC_API.has(p)) ||
    (p.startsWith("/im/") && !PUBLIC_IM.has(p));
  if (!needsAuth) return next();
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: "未登录", setup: !hasUsers() });
  // 待审核 / 已停用的账号：cookie 还在，但一步也走不了。
  // 这道闸必须在这里（而不是只在登录时判）——不然停用一个人之后，他手上开着的那个页面还能接着跑任务
  const status = user.status || "active";
  if (status === "pending") return res.status(403).json({ error: "账号还在等管理员审核通过", pending: true });
  if (status === "disabled") return res.status(403).json({ error: "账号已被停用，找管理员" , disabled: true });
  req.user = user;
  next();
}

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
  const router = express.Router();
  const onRename = (opts || {}).onRename;
  try { migrateLegacySettings(); } catch (e) { console.warn("[账号] 老开关搬家失败：" + e.message); }

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
    loginLimiter.pass(userKey);
    loginLimiter.pass(ipKey);
    if ((user.status || "active") === "disabled") return res.status(403).json({ error: "这个账号已被管理员停用" });
    setTokenCookie(res, issueToken(user.username), req, user);
    res.json({ ok: true, user: publicUser(user), pending: user.status === "pending" });
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
    if (String(new_password || "").length < 6) return res.status(400).json({ error: "新密码至少 6 位" });
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
  defaultUser,
  userFromReq,
  creditsFor,
  creditsEnabled,
  chargeRun,
  usageSummary,
  authGuard,
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
  pendingMembers,
  setMember,
  createMember,
  removeMember,
  resetPassword,
  topup,
  migrateLegacySettings,
  // 下面这些只给测试用：账本读写和登录闸得能在临时目录里单独验，不然一跑测试就动到真账号
  _internals: { readStore, writeStoreAtomic, createLimiter, isHttps, clientIp, isPrivateAddr, normalizeAvatar, register, renameUser, loadUsers, saveUsers, loadUsage, saveUsage, verify, issueToken },
};
