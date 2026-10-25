// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/** 结果推送 — 飞书机器人、企业微信、钉钉（支持加签）及注册的通道，任务完成通知共用。 */

const crypto = require("crypto");
const delivery = require("../automation/schedule-delivery");

/** 通知只发给明确保存的目标，不从历史会话猜收件人，也不依赖命令沙箱访问钥匙串。 */
async function pushFeishu(imCfg, text) {
  const f = imCfg.feishu || {};
  const target = String(f.notify_target || "").trim();
  if (!target) return false;
  if (!/^(?:ou|oc)_[A-Za-z0-9]{8,128}$/.test(target)) throw new Error("飞书通知接收 ID 无效，请填写当前应用的 ou_ 用户 ID 或 oc_ 会话 ID");
  if (!f.app_id || !f.app_secret) throw new Error("飞书通知缺少机器人 App ID 或 App Secret");
  const state = delivery.current();
  if (state && state.feishu === "sent") return true;
  if (state && state.feishu && state.feishu !== "idle") throw new Error("飞书发送结果尚未确认，未重复发送；请先核对原消息");
  // 获取凭据失败还没有发消息，可以修正后重试；发送超时则不能盲目补发。
  const auth = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: f.app_id, app_secret: f.app_secret }), signal: AbortSignal.timeout(15000),
  });
  const token = await auth.json();
  if (!auth.ok || token.code !== 0 || !token.tenant_access_token) throw new Error(`飞书机器人认证失败（code ${Number(token.code) || auth.status}），请核对应用凭证`);
  if (state && state.feishu === "sent") return true;
  if (state && state.feishu && state.feishu !== "idle") throw new Error("飞书发送在途，未重复发送");
  if (state) state.feishu = "pending";
  try {
    const type = target.startsWith("oc_") ? "chat_id" : "open_id";
    const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${type}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.tenant_access_token}` },
      body: JSON.stringify({ receive_id: target, msg_type: "text", content: JSON.stringify({ text: String(text).slice(0, 2000) }) }),
      signal: AbortSignal.timeout(15000),
    });
    const out = await resp.json();
    if (out.code !== 0) {
      if (state) state.feishu = Number(out.code) > 0 ? "idle" : "unknown";
      throw new Error(`飞书拒绝通知（code ${Number(out.code) || resp.status}），请核对机器人发送权限、应用可用范围及接收 ID`);
    }
    if (!resp.ok || !out.data || !out.data.message_id) throw new Error("飞书没有返回消息回执，请核对原消息，勿重复发送");
    if (state) state.feishu = "sent";
    return true;
  } catch (e) {
    if (state && state.feishu === "pending") state.feishu = "unknown";
    throw e;
  }
}

async function pushWecom(imCfg, text) {
  const url = imCfg.wecom_bot_webhook;
  if (!url) return false;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 2000) } }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}

async function pushDingtalk(imCfg, text) {
  let url = imCfg.dingtalk_webhook;
  if (!url) return false;
  if (imCfg.dingtalk_secret) {
    const ts = Date.now();
    const sign = encodeURIComponent(
      crypto.createHmac("sha256", imCfg.dingtalk_secret).update(`${ts}\n${imCfg.dingtalk_secret}`).digest("base64")
    );
    url += `${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${sign}`;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 2000) } }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}

/**
 * 能主动推送的长连接通道（扫码连的个人微信）。它们活在 IM 路由里，这里只留个插口：
 * 定时任务、notify_user、自进化都只认 pushBots，插上以后一处不用改就都推得到。
 * 以前只认企业微信和钉钉两个群机器人——助理模式连好了微信，定时任务照样一句都推不到。
 */
const extra = new Map(); // name -> { ready: () => boolean, push: async (text) => void }

/**
 * 成员自己绑的通道（见 im/im-accounts.js）：每人一套群机器人地址 + 一套插口。
 * 谁的任务推给谁——成员的定时任务、notify_user 不再落进管理员的群和微信里。
 */
const owners = new Map(); // username -> { im: () => imCfg, pushers: Map<name, pusher> }
let isMember = null; // server.js 给：这个账号算不算「成员」（平台管理员 / 单机版用的是服务器级那套）
const { AsyncLocalStorage } = require("async_hooks");
const userStore = new AsyncLocalStorage(); // 当前这趟是谁在跑（租户中间件绑上，见 admin.tenantScope）

function withPushUser(name, fn) {
  return name ? userStore.run(String(name), fn) : fn();
}
function setMemberCheck(fn) { isMember = typeof fn === "function" ? fn : null; }
function registerOwner(owner, im) {
  if (!owner) return;
  const had = owners.get(owner);
  owners.set(owner, { im, pushers: had ? had.pushers : new Map() });
}
function unregisterOwner(owner) { owners.delete(owner); }

function registerPusher(name, pusher, owner) {
  if (owner) {
    if (!owners.has(owner)) owners.set(owner, { im: () => ({}), pushers: new Map() });
    const m = owners.get(owner).pushers;
    if (pusher) m.set(name, pusher); else m.delete(name);
    return;
  }
  if (pusher) extra.set(name, pusher);
  else extra.delete(name);
}

function readyIn(im, pushers) {
  if (im.wecom_bot_webhook || im.dingtalk_webhook) return true;
  const f = im.feishu || {};
  if (f.notify_target && f.app_id && f.app_secret) return true;
  for (const p of pushers.values()) { try { if (p.ready()) return true; } catch {} }
  return false;
}

/**
 * 这一趟该推哪一套。成员绑了能推的通道 → 只推他自己的；
 * 他一条都没绑 → 照旧推服务器级那套（老行为，公司群收日报的用法不能一升级就断）
 */
function targetOf(config, { user, owner } = {}) {
  if (owner) {
    const o = owners.get(owner);
    return { im: o ? (o.im() || {}) : {}, pushers: o ? o.pushers : new Map(), own: true };
  }
  const who = user !== undefined ? user : userStore.getStore();
  if (who && isMember && isMember(who)) {
    const o = owners.get(who);
    if (o && readyIn(o.im() || {}, o.pushers)) return { im: o.im() || {}, pushers: o.pushers, own: true };
  }
  return { im: (config || {}).im || {}, pushers: extra, own: false };
}

/** 有没有哪条通道推得出去：群机器人地址填了，或者插上的通道说自己好了 */
function anyPushReady(config, opt) {
  const t = targetOf(config, opt);
  return readyIn(t.im, t.pushers);
}

/**
 * 推送到所有已配置的通道；单通道失败不影响其他通道，返回成功的通道名列表。
 * skip：不推的通道名。从微信里发来的任务，回复已经在微信里了，别再推一遍
 * owner：只推这个成员自己绑的（他通道里进来的任务用）；user：按这个人挑（不给就看当前租户）
 */
async function pushBots(config, text, { skip = [], user, owner, report } = {}) {
  const t = targetOf(config, { user, owner });
  const imCfg = t.im;
  const sent = [];
  if (report) { report.sent = sent; report.failed = []; }
  for (const [name, fn] of [["wecom", pushWecom], ["dingtalk", pushDingtalk], ["feishu", pushFeishu]]) {
    if (skip.includes(name)) continue;
    try {
      if (await fn(imCfg, text)) sent.push(name);
    } catch (e) {
      if (report) report.failed.push({ channel: name, error: name === "feishu" && /^飞书/.test(e.message) ? e.message : "通知发送失败，请检查通道配置与网络" });
      console.warn(`[${name}] 推送失败:`, e.message);
    }
  }
  for (const [name, p] of t.pushers) {
    if (skip.includes(name)) continue;
    try {
      if (!p.ready()) continue;
      await p.push(text);
      sent.push(name);
    } catch (e) {
      if (report) report.failed.push({ channel: name, error: "通知发送失败，请检查通道连接与接收目标" });
      console.warn(`[${name}] 推送失败:`, e.message);
    }
  }
  return sent;
}

module.exports = { pushBots, pushFeishu, pushWecom, pushDingtalk, registerPusher, anyPushReady, registerOwner, unregisterOwner, setMemberCheck, withPushUser };
