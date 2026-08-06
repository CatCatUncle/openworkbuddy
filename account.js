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

const USERS_FILE = path.join(__dirname, "data", "users.json");
const USAGE_FILE = path.join(__dirname, "data", "usage.json");
const TOKEN_COOKIE = "wb_token";
const TOKEN_TTL_MS = 90 * 86400 * 1000;

// ---------- 存储 ----------
function loadUsers() {
  try {
    const d = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return { users: d.users || [], tokens: d.tokens || {} };
  } catch {
    return { users: [], tokens: {} };
  }
}
function saveUsers(state) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(state, null, 2), "utf8");
}
function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) || [];
  } catch {
    return [];
  }
}
function saveUsage(list) {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(list.slice(0, 2000)), "utf8");
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
function setTokenCookie(res, token) {
  res.setHeader("Set-Cookie", `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`);
}
function clearTokenCookie(res) {
  res.setHeader("Set-Cookie", `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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
    const user = userFromReq(req);
    res.json({ users: loadUsers().users.length, authed: !!user, user: publicUser(user) });
  });

  router.post("/api/auth/register", (req, res) => {
    try {
      const { username, password } = req.body || {};
      const user = register(username, password);
      setTokenCookie(res, issueToken(user.username));
      res.json({ ok: true, user: publicUser(user) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body || {};
    const user = verify(username, password);
    if (!user) return res.status(401).json({ error: "用户名或密码不对" });
    setTokenCookie(res, issueToken(user.username));
    res.json({ ok: true, user: publicUser(user) });
  });

  router.post("/api/auth/logout", (req, res) => {
    const token = tokenFromReq(req);
    if (token) {
      const st = loadUsers();
      delete st.tokens[token];
      saveUsers(st);
    }
    clearTokenCookie(res);
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
};
