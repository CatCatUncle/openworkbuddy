"use strict";
/**
 * 发邮件 —— 一条 SMTP 通道，给 agent 的 send_email 工具和设置里的「测试」按钮共用。
 *
 * 为什么单独一个文件：发信这件事有三样东西谁都不该重复写——
 *   1. **收件人白名单**。agent 手里有 shell、有联网、还有你的邮箱密码，一旦提示词被网页里的
 *      内容带偏，第一个受害的就是通讯录。白名单填了就是硬闸：不在名单里的地址一个都发不出去，
 *      而且是发信**之前**就挡住，不是发完再说。
 *   2. **地址解析**。模型给的 to 可能是 "a@b.com, c@d.com"、可能是数组、可能带尖括号，
 *      解析规则只能有一份，否则「预览里给你看的」和「真发出去的」会对不上——那比不发更糟。
 *   3. **凭证不外泄**。这里只有 send/verify 两个出口，都只回「成了/没成 + 原因」，
 *      任何一处都不把 host/user/pass 拼进返回值。上层照抄就不会漏。
 *
 * 端口决定加密方式，不再单给一个「要不要 SSL」的勾：465 = 一上来就 TLS，其余（587/25）
 * 走 STARTTLS。这是所有邮件服务商的通用约定，少一个填错了就连不上、还看不出哪错的选项。
 */

const fs = require("fs");
const path = require("path");

/** 一封信最多带多大附件。超了 SMTP 那头也会拒，不如在本机就说清楚 */
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
/** 一次最多几个收件人。群发不是办公助理该干的事，这条挡的是「把通讯录一次性发完」 */
const MAX_RECIPIENTS = 20;
/** 连不上别吊着整条任务：连接 / 打招呼 / 读写各给 20 秒 */
const TIMEOUT_MS = 20000;

const ADDR_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** 配齐了没。三样缺一样都发不出去——工具摆不摆出来就看这一个函数 */
function configured(cfg) {
  cfg = cfg || {};
  return ["host", "user", "pass"].every((k) => String(cfg[k] || "").trim() !== "");
}

/** 发件人：没单独填就用登录名（绝大多数服务商本来也只准用登录的那个地址发） */
function fromAddr(cfg) {
  cfg = cfg || {};
  return String(cfg.from || "").trim() || String(cfg.user || "").trim();
}

/**
 * 把模型给的收件人拆成一个个地址。
 * 逗号、分号、换行先分段；「张三 <a@b.com>」这种只取尖括号里那段；没尖括号的段落按空格再拆，
 * 只留带 @ 的词（"John Smith a@b.com" 只剩地址）。整段一个 @ 都没有才原样留下——
 * 那是个写坏的地址，得让它走到「地址不对」那条报错里，不能在这儿悄悄消失。
 */
function parseAddrs(v) {
  const raw = Array.isArray(v) ? v.join(",") : String(v == null ? "" : v);
  const out = [];
  const push = (a) => {
    a = String(a || "").trim();
    if (a && !out.includes(a)) out.push(a);
  };
  for (const seg of raw.split(/[,;\n]+/)) {
    const piece = seg.trim();
    if (!piece) continue;
    const m = piece.match(/<([^>]+)>/);
    if (m) {
      push(m[1]);
      continue;
    }
    const words = piece.split(/\s+/).filter(Boolean);
    const withAt = words.filter((w) => w.includes("@"));
    if (withAt.length) withAt.forEach(push);
    else push(words[words.length - 1]);
  }
  return out;
}

/** 白名单原文 → 一条条小写规则。空数组 = 用户没设白名单 */
function allowRules(cfg) {
  return String((cfg || {}).allow_to || "")
    .split(/[,;\s\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 这个地址在不在白名单里。
 * 规则两种写法：`a@b.com` 精确匹配一个人；`@b.com` 或 `b.com` 放行整个域（含子域）。
 * 白名单为空 = 不限收件人——但发信这一步照样要用户当场点头，不是没人管。
 */
function addrAllowed(cfg, addr) {
  const rules = allowRules(cfg);
  if (!rules.length) return true;
  const a = String(addr || "").toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 0) return false;
  const dom = a.slice(at + 1);
  return rules.some((r) => {
    if (r.includes("@") && !r.startsWith("@")) return a === r;
    const d = r.replace(/^@/, "");
    return dom === d || dom.endsWith("." + d);
  });
}

/**
 * 收件人体检：格式、数量、白名单一起看，把问题一次说完。
 * 返回 { list, bad, blocked, tooMany }——前三样空、tooMany 为假才算过，
 * 让调用方自己挑先报哪一条。
 */
function checkRecipients(cfg, to) {
  const list = parseAddrs(to);
  const bad = list.filter((a) => !ADDR_RE.test(a));
  const blocked = list.filter((a) => ADDR_RE.test(a) && !addrAllowed(cfg, a));
  return { list, bad, blocked, tooMany: list.length > MAX_RECIPIENTS };
}

/**
 * 附件体检：逐个确认是真文件、算总大小。
 * paths 传进来的必须是已经过安全中心解析的绝对路径——这里只管存不存在、多大，不管越不越界。
 */
function checkAttachments(paths) {
  const items = [];
  const missing = [];
  let bytes = 0;
  for (const p of paths || []) {
    let st = null;
    try {
      st = fs.statSync(p);
    } catch {}
    if (!st || !st.isFile()) {
      missing.push(p);
      continue;
    }
    bytes += st.size;
    items.push({ filename: path.basename(p), path: p, size: st.size });
  }
  return { items, missing, bytes, tooBig: bytes > MAX_ATTACH_BYTES };
}

/** 字节数说人话。附件大小要弹给用户看，"19922944" 这种数字帮不上任何忙 */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

/**
 * 把一段报错里可能夹带的密码抹掉，再往外递。
 * SMTP 报错经常原样回显握手内容，而这段字符串下一步就进模型上下文、或者写进审计日志——
 * 抹这一下的成本是零，漏一次的成本是一把长期有效的邮箱密码。
 */
function scrub(cfg, msg) {
  let s = String(msg == null ? "" : msg);
  const pass = String((cfg || {}).pass || "");
  if (pass.length >= 4) s = s.split(pass).join("******");
  return s;
}

function transportOf(cfg) {
  const nodemailer = require("nodemailer");
  const port = Number(cfg.port) || 465;
  return nodemailer.createTransport({
    host: String(cfg.host || "").trim(),
    port,
    secure: port === 465, // 465 一上来就 TLS，587/25 走 STARTTLS
    auth: { user: String(cfg.user || "").trim(), pass: String(cfg.pass || "") },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
}

/**
 * 只连一下、登一下，不发信。设置里那颗「连接」按钮用它——
 * 密码错、端口错、被服务商拦了，都在这一步暴露，而不是等到 agent 半夜发日报时才炸。
 */
async function verify(cfg) {
  if (!configured(cfg)) throw new Error("SMTP 还没配全：服务器地址、账号、密码三样都要填");
  const t = transportOf(cfg);
  try {
    await t.verify();
  } finally {
    try {
      t.close();
    } catch {}
  }
  return { from: fromAddr(cfg), host: String(cfg.host || "").trim(), port: Number(cfg.port) || 465 };
}

/**
 * 真发。返回 { accepted, rejected, messageId }。
 * 出错一律往外抛原始报错，但**绝不**把 cfg 里的任何一项拼进消息——
 * 这条返回值会一路走到模型的上下文里，凭证进去了就等于泄了。
 */
async function send(cfg, { to, subject, text, html, attachments } = {}) {
  if (!configured(cfg)) throw new Error("SMTP 还没配全：服务器地址、账号、密码三样都要填");
  const chk = checkRecipients(cfg, to);
  if (!chk.list.length) throw new Error("没有收件人");
  if (chk.bad.length) throw new Error("收件人地址不对：" + chk.bad.join("、"));
  if (chk.tooMany) throw new Error(`一封信最多 ${MAX_RECIPIENTS} 个收件人，这次是 ${chk.list.length} 个`);
  // 白名单这道闸放最后：前面几条是「写错了」，这条是「不许发」，分开报才看得出区别
  if (chk.blocked.length) throw new Error("收件人不在白名单里：" + chk.blocked.join("、"));
  const t = transportOf(cfg);
  try {
    const info = await t.sendMail({
      from: fromAddr(cfg),
      to: chk.list.join(", "),
      subject: String(subject || "").slice(0, 200),
      text: String(text || ""),
      ...(html ? { html: String(html) } : {}),
      ...(attachments && attachments.length ? { attachments } : {}),
    });
    return {
      accepted: info.accepted || chk.list,
      rejected: info.rejected || [],
      messageId: info.messageId || "",
    };
  } finally {
    try {
      t.close();
    } catch {}
  }
}

module.exports = {
  configured,
  fromAddr,
  parseAddrs,
  allowRules,
  addrAllowed,
  checkRecipients,
  checkAttachments,
  scrub,
  fmtBytes,
  verify,
  send,
  MAX_ATTACH_BYTES,
  MAX_RECIPIENTS,
};
