"use strict";
/**
 * 账号体系 + 积分体系 + 用量流水 — Web / CLI / IM / 定时任务 共用一套账本。
 *
 * 数据文件（均不入 git）：
 *   data/users.json  { users: [{ username, salt, hash, role, credits, created_at }], tokens: { token: { user, at } } }
 *   data/usage.json  [ { ts, day, kind: "run"|"topup", user, source, model, prompt, completion, calls, elapsed_ms, credits, ... } ]
 *
 * 计费规则：每消耗 1000 tokens（输入+输出）扣 1 积分，每次任务至少扣 1 积分。
 * 首个注册用户 = 管理员（10000 积分，可充值）；后续注册 = 成员（1000 积分）。
 *
 * 所有读写都直接落盘（读-改-写），CLI 与常驻服务两个进程共享同一账本不打架。
 */

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const store = require("./store");

// WB_DATA_DIR 只为测试留的口子：跑测试时指到临时目录，免得动到真账本
const DATA_DIR = process.env.WB_DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const TOKEN_COOKIE = "wb_token";
const TOKEN_TTL_MS = 90 * 86400 * 1000;

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
/** 已经有账号之后还让不让别人自己注册。默认不让——这东西挂到公网上就是给陌生人发积分 */
function openRegister(st) {
  return !!(st || loadUsers()).settings.open_register;
}
/**
 * 积分闸门开不开。**默认不开**——本地个人部署时它只会在你干到一半的时候把任务拦下来，
 * 余额掉到 0 还得自己给自己充值，纯添堵：key 是你自己的，账单在服务商那边，
 * 这本账拦不住任何真实开销。只有多人共用一个 key、要给成员定额度时才需要打开。
 * 用量流水跟这个开关无关，永远照记——那是给你看花了多少 tokens 的账，不是闸。
 */
function creditsEnabled(st) {
  return !!(st || loadUsers()).settings.credits_enabled;
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
    credits: u.credits,
    created_at: u.created_at,
  };
}

// 头像允许两种：emoji（存字符）和用户自己上传的小图（存 data URI）。
// 只收 data:image/*，且限 256KB——账本是个 JSON 文件，塞张大图进去会把整个读写拖垮。
const AVATAR_MAX = 256 * 1024;
function normalizeAvatar(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    if (s.length > AVATAR_MAX) throw new Error("头像图片太大了（超过 256KB），换张小的或者用 emoji");
    return s;
  }
  // data: 开头但没过上面那关的，是伪装成图片的别的东西（data:text/html 之类），直接挡
  if (/^data:/i.test(s) || /^(https?:)?\/\//.test(s) || s.includes("<")) throw new Error("头像只支持 emoji 或上传图片");
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

function register(username, password) {
  username = String(username || "").trim();
  if (!/^[\w一-龥.-]{2,24}$/.test(username)) throw new Error("用户名需 2-24 位（中英文、数字、_.-）");
  if (String(password || "").length < 6) throw new Error("密码至少 6 位");
  const st = loadUsers();
  if (st.users.some((u) => u.username === username)) throw new Error("用户名已存在");
  const salt = crypto.randomBytes(16).toString("hex");
  const first = st.users.length === 0;
  const user = {
    username,
    salt,
    hash: hashPassword(password, salt),
    role: first ? "admin" : "member",
    credits: first ? 10000 : 1000,
    created_at: new Date().toISOString(),
  };
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
  for (const [t, info] of Object.entries(st.tokens)) {
    if (Date.now() - info.at > TOKEN_TTL_MS) delete st.tokens[t];
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
  if (!info || Date.now() - info.at > TOKEN_TTL_MS) return null;
  return st.users.find((u) => u.username === info.user) || null;
}
/** 是不是 https 进来的（部署时前面一般挂 nginx，真正的 TLS 在它那一层） */
function isHttps(req) {
  return !!(req && (req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"));
}
function setTokenCookie(res, token, req) {
  // https 下补上 Secure：否则同一个域名只要有一次 http 请求，令牌就明文躺在路上了
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`);
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

/**
 * 只认 socket 上的地址，不认 X-Forwarded-For：那个头谁都能伪造，
 * 认了就等于把 IP 闸拆了（换一行头就是一个新 IP）。
 * 代价是前面挂 nginx 时所有人共用一个 IP 桶——所以真正兜底的是按账号的那道闸。
 */
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || req.ip || "?";
}

// ---------- 积分与用量 ----------
function creditsFor(usage) {
  const total = (usage.prompt || 0) + (usage.completion || 0);
  return Math.max(1, Math.ceil(total / 1000));
}

/**
 * 一次任务结束后记账：按 tokens 扣积分 + 写用量流水。
 * 积分闸门关着（默认）时只写流水不扣数，返回 0——用量该看还得看，额度不该拦人。
 * @param user  users.json 里的用户对象（会同步更新其 credits 字段）
 * @param info  { prompt, completion, calls, elapsed_ms, model, provider, source, sessionId }
 * @returns 本次扣掉的积分数（不限额时为 0）
 */
function chargeRun(user, info) {
  const st = loadUsers();
  const spent = creditsEnabled(st) ? creditsFor(info) : 0;
  const u = st.users.find((x) => x.username === user.username);
  if (u && spent) {
    u.credits = Math.max(0, (u.credits || 0) - spent);
    saveUsers(st);
    user.credits = u.credits; // 让调用方拿到最新余额
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
    completion: info.completion || 0,
    calls: info.calls || 0,
    elapsed_ms: info.elapsed_ms || 0,
    credits: spent,
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
  target.credits = (target.credits || 0) + amount;
  saveUsers(st);
  const usage = loadUsage();
  usage.unshift({ ts: new Date().toISOString(), day: localDay(), kind: "topup", user: target.username, by: byUser.username, credits: amount });
  saveUsage(usage);
  return target.credits;
}

/** 用量详情：今日/本月汇总 + 近 7 天曲线 + 最近流水（管理员看全员，成员只看自己） */
function usageSummary(user) {
  const all = loadUsage();
  const mine = user.role === "admin" ? all : all.filter((e) => e.user === user.username);
  const runs = mine.filter((e) => e.kind === "run");
  const today = localDay();
  const month = today.slice(0, 7);
  const agg = (list) => ({
    runs: list.length,
    tokens: list.reduce((s, e) => s + (e.prompt || 0) + (e.completion || 0), 0),
    credits: list.reduce((s, e) => s + (e.credits || 0), 0),
  });
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
    recent: mine.slice(0, 50),
  };
}

// ---------- Express 路由与守卫 ----------
// 外部回调有自己的签名/密钥校验，不走登录（微信侧还有 AES 解密这道闸）
const PUBLIC_IM = new Set(["/im/task", "/im/feishu/events", "/im/wecom/events", "/im/mp/events"]);

/** 登录守卫：/api/*（除 /api/auth/*）与 UI 用的 /im/status 等需要已登录，其余放行 */
function authGuard(req, res, next) {
  const p = req.path;
  const needsAuth =
    (p.startsWith("/api/") && !p.startsWith("/api/auth/")) ||
    (p.startsWith("/im/") && !PUBLIC_IM.has(p));
  if (!needsAuth) return next();
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: "未登录", setup: !hasUsers() });
  req.user = user;
  next();
}

/**
 * @param opts.onRename  改登录名之后的回调 (from, to)：会话文件归 server 管，
 *   它得把那边的归属一起搬走，不然历史任务就成了没主的。
 */
function createRouter(opts) {
  const router = express.Router();
  const onRename = (opts || {}).onRename;

  router.get("/api/auth/state", (req, res) => {
    const st = loadUsers();
    const user = userFromReq(req);
    res.json({
      users: st.users.length,
      authed: !!user,
      user: publicUser(user),
      open_register: openRegister(st),
      credits_enabled: creditsEnabled(st),
    });
  });

  router.post("/api/auth/register", (req, res) => {
    const ip = clientIp(req);
    const wait = loginLimiter.retryAfter("reg|" + ip, REGS_PER_IP);
    if (wait) return res.status(429).json({ error: `注册太频繁了，${wait} 秒后再试` });
    try {
      const { username, password } = req.body || {};
      const st = loadUsers();
      // 第一个账号永远放行（就是拿它开管理员），之后要不要开放注册由管理员说了算
      if (st.users.length && !openRegister(st)) throw new Error("管理员没有开放注册，找他给你开一个");
      loginLimiter.fail("reg|" + ip);
      const user = register(username, password);
      setTokenCookie(res, issueToken(user.username), req);
      res.json({ ok: true, user: publicUser(user) });
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
    setTokenCookie(res, issueToken(user.username), req);
    res.json({ ok: true, user: publicUser(user) });
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
    if (user.role !== "admin") return res.status(403).json({ error: "只有管理员能改" });
    const st = loadUsers();
    st.settings = { ...(st.settings || {}), open_register: !!(req.body || {}).open_register };
    saveUsers(st);
    res.json({ ok: true, open_register: st.settings.open_register });
  });

  /** 开不开积分闸门：默认关（不限额），只有管理员能改 */
  router.post("/api/auth/credits-enabled", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    if (user.role !== "admin") return res.status(403).json({ error: "只有管理员能改" });
    const st = loadUsers();
    st.settings = { ...(st.settings || {}), credits_enabled: !!(req.body || {}).credits_enabled };
    saveUsers(st);
    res.json({ ok: true, credits_enabled: st.settings.credits_enabled });
  });

  router.get("/api/usage", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    res.json(usageSummary(user));
  });

  router.post("/api/credits/topup", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "未登录" });
    if (user.role !== "admin") return res.status(403).json({ error: "只有管理员可以充值" });
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
  hasUsers,
  defaultUser,
  userFromReq,
  creditsFor,
  creditsEnabled,
  chargeRun,
  usageSummary,
  authGuard,
  createRouter,
  // 下面这些只给测试用：账本读写和登录闸得能在临时目录里单独验，不然一跑测试就动到真账号
  _internals: { readStore, writeStoreAtomic, createLimiter, isHttps, normalizeAvatar, register, renameUser, loadUsers, saveUsers, loadUsage, verify, issueToken },
};
