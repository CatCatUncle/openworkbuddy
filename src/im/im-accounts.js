// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 每个成员自己绑的消息渠道。
 *
 * 以前 IM 通道是整台服务器一套：管理员扫的那个微信、填的那个飞书应用，所有人共用，
 * 成员想有自己的助理只能借管理员那条线。现在每个账号都能在「助理设置」里
 * 扫自己的微信、填自己的飞书/QQ/企微/公众号/群机器人/邮箱：
 *   - 配置一人一个文件（data/im-accounts/<账号键>.json，0600），不进 config.json
 *   - 每人一个 createImRouter 实例：自己的长连接、自己的会话、自己的推送插口
 *   - 进来的消息在他自己的租户里跑（工作目录、规矩、额度、记忆都是他的），日志只有他看得见
 *   - 需要公网回调的（企微应用 / 公众号 / 飞书回调 / 通用 Webhook）地址带一串随机号，
 *     /im/u/<随机号>/...，不暴露账号名
 *
 * 管理员那套服务器级通道原样留着，跟这里互不相干。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { dataPath } = require("../platform/paths");
const prefs = require("../core/config/prefs");
const notify = require("../core/obs/notify");
const { mergeImPatch, maskIm } = require("./im-config");

// 成员页面能调的那几条（其余的——日志、进度、会话、助理页对话——走管理员那份的公共接口，按人过滤）
const MY_ROUTES = new Set([
  "GET /status", "POST /wechat/qrcode", "GET /wechat/qrcode-status", "POST /wechat/disconnect",
  "POST /wechat/test", "POST /qq/test", "POST /feishu/test", "POST /smtp/test",
]);
// 外面打进来的回调：只放这四个
const HOOK_ROUTES = new Set(["/task", "/feishu/events", "/wecom/events", "/mp/events"]);

/** 这份配置里有没有哪条通道值得开机就起 */
function hasAnyChannel(im) {
  const i = im || {};
  return !!((i.feishu && i.feishu.app_id) || (i.qq && i.qq.app_id) || (i.wechat_ilink && i.wechat_ilink.bot_token)
    || (i.wecom_app && i.wecom_app.corp_id) || (i.wechat_mp && i.wechat_mp.app_id)
    || i.wecom_bot_webhook || i.dingtalk_webhook || i.webhook_secret || (i.smtp && i.smtp.host));
}

/**
 * @param {object} o
 * @param {Function} o.makeInstance  ({ owner, config, saveConfig }) => createImRouter 的返回值
 * @param {Function} o.problemOf     (username) => "" | 不能用的原因（停用/删除/待审核）
 * @param {Function} o.canOwn        (user) => 这个登录的人能不能有自己的一套（平台管理员/单机版不走这里）
 * @param {object}   o.config        服务器配置：除 im 以外的字段（安全档、模型）照它的读
 * @param {string}   [o.dir]
 */
function createImAccounts({ makeInstance, problemOf = () => "", canOwn = () => true, config, dir = dataPath("data", "im-accounts") }) {
  const live = new Map(); // username -> { rec, inst }

  const fileOf = (username) => path.join(dir, `${prefs.keyOf(username)}.json`);
  function load(username) {
    try {
      const rec = JSON.parse(fs.readFileSync(fileOf(username), "utf8"));
      if (rec && rec.owner === username) return { owner: username, hook: String(rec.hook || ""), im: rec.im || {} };
    } catch {}
    return { owner: username, hook: "", im: {} };
  }
  function save(rec) {
    if (!rec.hook) rec.hook = crypto.randomBytes(12).toString("hex");
    fs.mkdirSync(dir, { recursive: true });
    const f = fileOf(rec.owner);
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ owner: rec.owner, hook: rec.hook, im: rec.im }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  function ensure(username) {
    const had = live.get(username);
    if (had) return had;
    const rec = load(username);
    if (!rec.hook) save(rec); // 先把随机号落下来：回调地址一给出去就不能变
    // 实例眼里的 config：im 是他自己那份，别的字段（安全档、权限模式）照服务器的读
    const view = new Proxy(config, {
      get: (t, k) => (k === "im" ? rec.im : t[k]),
      set: (t, k, v) => { if (k === "im") rec.im = v || {}; return true; },
    });
    const inst = makeInstance({ owner: username, config: view, saveConfig: () => save(rec) });
    notify.registerOwner(username, () => rec.im || {});
    const ent = { rec, inst };
    live.set(username, ent);
    return ent;
  }

  async function startAll(ent) {
    const { inst } = ent;
    await Promise.allSettled([inst.startFeishuWs(), inst.startQQ(), inst.startIlink()]);
  }

  async function drop(username) {
    const ent = live.get(username);
    if (!ent) return;
    live.delete(username);
    try { await ent.inst.stopAll(); } catch {}
    notify.unregisterOwner(username);
  }

  /** 开机：盘上有配置、账号还能用的，各自起长连接 */
  async function boot() {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.includes(".feishu-")); } catch { return; }
    for (const f of names) {
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      const who = rec && rec.owner;
      if (!who || fileOf(who) !== path.join(dir, f) || problemOf(who) || !hasAnyChannel(rec.im)) continue;
      startAll(ensure(who)).catch((e) => console.warn(`[我的通道] ${prefs.keyOf(who)} 启动失败:`, e.message));
    }
  }

  // 停用 / 删掉的账号：一分钟内把他的长连接全断掉，别让一个已经走了的人的微信还在替公司干活
  const sweep = setInterval(() => {
    for (const who of [...live.keys()]) if (problemOf(who)) drop(who).catch(() => {});
  }, 60 * 1000);
  if (sweep.unref) sweep.unref();

  const hookUrls = (rec) => {
    const b = `/im/u/${rec.hook}`;
    return { task: `${b}/task`, feishu: `${b}/feishu/events`, wecom: `${b}/wecom/events`, mp: `${b}/mp/events` };
  };

  const router = express.Router();
  const json = express.json({ limit: "256kb" });

  // 自己那套：只有登录的本人，平台管理员和单机版用的是服务器级那套
  router.use("/im/my", (req, res, next) => {
    const me = req.user && req.user.username;
    if (!me) return res.status(401).json({ ok: false, error: "未登录" });
    if (!canOwn(req.user)) return res.status(400).json({ ok: false, error: "你用的是服务器那套通道，在「助理设置」里改" });
    const why = problemOf(me);
    if (why) return res.status(403).json({ ok: false, error: why });
    next();
  });

  router.get("/im/my/config", (req, res) => {
    const me = req.user.username;
    const rec = live.has(me) ? live.get(me).rec : load(me);
    if (!rec.hook) save(rec);
    res.json({ ok: true, im: maskIm(rec.im), hooks: hookUrls(rec) });
  });

  router.post("/im/my/config", json, async (req, res) => {
    const me = req.user.username;
    const ent = ensure(me);
    let touched;
    try { touched = mergeImPatch(ent.rec.im, (req.body || {}).im, { own: true }); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    try { save(ent.rec); } catch (e) { return res.status(500).json({ ok: false, error: `没存上：${e.message}` }); }
    // 飞书/QQ 改了凭证就重建长连接；没填全的会自己停在「还差哪一项」
    if (touched.has("feishu")) ent.inst.startFeishuWs(true).catch((e) => console.warn("[我的通道] 飞书长连接重启失败:", e.message));
    if (touched.has("qq")) ent.inst.startQQ(true).catch((e) => console.warn("[我的通道] QQ 长连接重启失败:", e.message));
    res.json({ ok: true, im: maskIm(ent.rec.im), hooks: hookUrls(ent.rec) });
  });

  router.use("/im/my", (req, res, next) => {
    const sub = req.path;
    if (!MY_ROUTES.has(`${req.method} ${sub}`)) return next();
    const ent = ensure(req.user.username);
    // 扫码成功那一下会写配置、起长连接，跟着把别的通道也拉起来
    ent.inst.router(req, res, next);
  });

  router.use("/im/u/:hook", (req, res, next) => {
    if (!HOOK_ROUTES.has(req.path)) return next();
    const hook = String(req.params.hook || "");
    let ent = null;
    for (const e of live.values()) if (e.rec.hook && e.rec.hook === hook) { ent = e; break; }
    if (!ent) return res.status(404).json({ error: "这个地址没有对应的通道" });
    const why = problemOf(ent.rec.owner);
    if (why) return res.status(403).json({ error: "这个账号现在用不了" });
    ent.inst.router(req, res, next);
  });

  return { router, boot, ensure, drop, has: (u) => live.has(u), _internals: { live, load, save, fileOf, hasAnyChannel, stop: () => clearInterval(sweep) } };
}

module.exports = { createImAccounts, hasAnyChannel };
