// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * IM 那一块配置怎么合并、怎么给界面看。管理员那份（config.json 的 im）和成员自己那份
 * （data/im-accounts/ 下一人一个文件）走同一套规矩，不各写一遍。
 */

const MASK = "********";

// 凭证专用的合并：空字符串不覆盖已经存好的值，除非「取消连接」在 im.clear 里点了名。
// 起因是一个能把人坑惨的组合——设置页里任何一次保存（点某张卡的「连接」也算）都会把所有卡的输入框
// 原样回写；输入框只要因为任何原因是空的（只填了一半就点连接、渲染时值没进去、浏览器清了密码框），
// 已经存好的 App Secret 就被一行空串抹掉，通道第二天就连不上，界面还只写「未连接」。
// 现在的规矩：想清空必须显式说要清哪个字段（"feishu.app_secret" / 顶层直接写字段名）。
// 掩码原样存回来（成员那份读接口不回明文）也按「没改」处理。
function imAssign(target, incoming, keys, clear, prefix) {
  for (const k of keys) {
    if (incoming[k] === undefined) continue;
    const v = typeof incoming[k] === "string" ? incoming[k].trim() : incoming[k];
    if (v === MASK) continue;
    if (v === "" && String(target[k] || "") !== "" && !clear.has(prefix + k)) continue; // 留着旧的
    target[k] = v;
  }
}

/**
 * 把界面发来的 im 补丁合进 im。返回改到了哪几块（server 据此重启飞书/QQ 长连接）。
 * own：成员自己那份——飞书云文档那组凭证不收（云文档工具认的是服务器那份）
 */
function mergeImPatch(im, b, { own = false } = {}) {
  const touched = new Set();
  if (!b || typeof b !== "object") return touched;
  const clear = new Set(Array.isArray(b.clear) ? b.clear.map(String) : []);
  if (b.feishu && b.feishu.notify_target !== undefined) {
    const target = String(b.feishu.notify_target || "").trim();
    if (target && !/^(?:ou|oc)_[A-Za-z0-9]{8,128}$/.test(target)) throw new Error("飞书通知接收 ID 须为 ou_ 用户 ID 或 oc_ 会话 ID");
  }
  if (b.feishu) {
    const feishu = im.feishu = im.feishu || {};
    imAssign(feishu, b.feishu, own ? ["app_id", "app_secret", "verification_token"] : ["app_id", "app_secret", "verification_token", "doc_app_id", "doc_app_secret"], clear, "feishu.");
    // 接收目标不是凭证，清空即停止主动推送，不能套用「空值保留旧凭证」。
    if (b.feishu.notify_target !== undefined) feishu.notify_target = String(b.feishu.notify_target || "").trim();
    if (b.feishu.group_reply_mode !== undefined) {
      feishu.group_reply_mode = b.feishu.group_reply_mode === "all" ? "all" : "mention";
    }
    touched.add("feishu");
  }
  if (b.qq) { imAssign(im.qq = im.qq || {}, b.qq, ["app_id", "app_secret"], clear, "qq."); touched.add("qq"); }
  if (b.wecom_app) imAssign(im.wecom_app = im.wecom_app || {}, b.wecom_app, ["corp_id", "agent_id", "secret", "token", "aes_key"], clear, "wecom_app.");
  if (b.wechat_mp) imAssign(im.wechat_mp = im.wechat_mp || {}, b.wechat_mp, ["app_id", "app_secret", "token", "aes_key"], clear, "wechat_mp.");
  if (b.smtp) {
    const sm = (im.smtp = im.smtp || {});
    // 凭证走「空不覆盖」那条老规矩：半张表单点一下保存，不该把已经存好的密码抹掉
    imAssign(sm, b.smtp, ["host", "user", "pass"], clear, "smtp.");
    // 端口 / 发件人 / 收件人白名单不是凭证，是用户随时会改的设置，清空就得真清空。
    // 白名单尤其不能沿用老规矩——填了是硬闸，用户在界面上删干净了却删不掉，闸门就卡死在旧名单上了
    for (const k of ["port", "from", "allow_to"]) {
      if (b.smtp[k] !== undefined) sm[k] = String(b.smtp[k]).trim();
    }
  }
  imAssign(im, b, ["wecom_bot_webhook", "dingtalk_webhook", "dingtalk_secret", "webhook_secret"], clear, "");
  if (b.session_idle_hours !== undefined) im.session_idle_hours = Math.max(0, Math.min(720, +b.session_idle_hours || 0));
  return touched;
}

// 回给界面时盖掉的字段：密钥、令牌、加解密 key。微信那份登录态整段不回
const SECRET = {
  feishu: ["app_secret", "verification_token"],
  qq: ["app_secret"],
  wecom_app: ["secret", "token", "aes_key"],
  wechat_mp: ["app_secret", "token", "aes_key"],
  smtp: ["pass"],
  "": ["dingtalk_secret", "webhook_secret"],
};
function maskIm(im) {
  const src = im || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "wechat_ilink") continue;
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...v } : v;
  }
  for (const [grp, keys] of Object.entries(SECRET)) {
    const o = grp ? out[grp] : out;
    if (!o) continue;
    for (const k of keys) if (o[k]) o[k] = MASK;
  }
  return out;
}

module.exports = { imAssign, mergeImPatch, maskIm, MASK };
