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

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

// WB_DATA_DIR 只为测试留的口子：跑测试时指到临时目录，免得动到真账本
const DATA_DIR = process.env.WB_DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const TOKEN_COOKIE = "wb_token";
const TOKEN_TTL_MS = 90 * 86400 * 1000;

// ---------- 存储 ----------
/**
 * 读账本。文件不在 → 空账本（第一次跑）；文件在、却读不出来 → **抛错**。
 * 这里绝不能把「读不出来」当成「没有用户」：那样接下来任何一次写盘都会拿这个
 * 空壳把整本账（所有账号、密码、积分）覆盖掉，而且用户第一次注册还会当上管理员。
 */
function readStore(file, empty) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return empty;
    throw new Error(`${path.basename(file)} 打不开（${e.message}）`);
  }
  if (!text.trim()) return empty; // 空文件按新账本算，写坏成 0 字节也能自愈
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${path.basename(file)} 内容坏了（${e.message}）。旁边有 .bak 可以恢复；在修好之前程序不会碰它，免得把账本覆盖成空的`);
  }
}

/** 写盘：先落临时文件再改名。改名在同一分区上是原子的，别人读到的要么是旧的要么是新的，不会是半个 */
function writeStoreAtomic(file, data, pretty) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0), "utf8");
  try { fs.copyFileSync(file, file + ".bak"); } catch {} // 上一版留个底，第一次没有就算了
  fs.renameSync(tmp, file);
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
  return u ? { username: u.username, role: u.role, credits: u.credits, created_at: u.created_at } : null;
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
 * @param user  users.json 里的用户对象（会同步更新其 credits 字段）
 * @param info  { prompt, completion, calls, elapsed_ms, model, provider, source, sessionId }
 * @returns 本次扣掉的积分数
 */
function chargeRun(user, info) {
  const spent = creditsFor(info);
  const st = loadUsers();
  const u = st.users.find((x) => x.username === user.username);
  if (u) {
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

function createRouter() {
  const router = express.Router();

  router.get("/api/auth/state", (req, res) => {
    const st = loadUsers();
    const user = userFromReq(req);
    res.json({ users: st.users.length, authed: !!user, user: publicUser(user), open_register: openRegister(st) });
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
  chargeRun,
  usageSummary,
  authGuard,
  createRouter,
  // 下面这些只给测试用：账本读写和登录闸得能在临时目录里单独验，不然一跑测试就动到真账号
  _internals: { readStore, writeStoreAtomic, createLimiter, isHttps },
};
