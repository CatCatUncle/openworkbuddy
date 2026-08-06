"use strict";
/**
 * 微信侧接入 — 企业微信自建应用 + 微信公众号，两者共用腾讯的 WXBizMsgCrypt 加解密方案。
 *
 * ⚠️ 和飞书/QQ 不同：微信没有长连接模式，只能由腾讯服务器回调你的地址，
 *    所以这两个通道必须有一个公网可访问的 HTTPS 地址指向本机（内网穿透/反向代理均可）。
 *
 * 【企业微信自建应用】（推荐，能主动推送，适合 agent 跑几分钟后再回结果）
 *   企业微信管理后台 → 应用管理 → 自建应用 → 拿 AgentId / Secret，「我的企业」拿 CorpID
 *   → 接收消息 → 设置 API 接收 → URL 填 https://你的域名/im/wecom/events，
 *      Token 与 EncodingAESKey 随机生成后回填到这里 → 保存时腾讯会来验证 URL
 *
 * 【微信公众号】（消息直接落在微信 App 里，但主动回复要认证号）
 *   公众平台 → 开发 → 基本配置：AppID/AppSecret，服务器配置 URL 填 https://你的域名/im/mp/events，
 *   消息加解密方式建议选「安全模式」→ Token / EncodingAESKey 回填到这里
 *   注意：agent 执行往往超过 5 秒，被动回复窗口来不及，结果通过「客服消息」异步推送，
 *   该接口需要已认证的服务号/订阅号，未认证会返回 48001（本模块会如实报错，不假装成功）
 */

const crypto = require("crypto");

// ---------- WXBizMsgCrypt：AES-256-CBC + PKCS7，签名为 sha1(排序拼接) ----------

function aesKeyOf(encodingAESKey) {
  const key = Buffer.from(String(encodingAESKey || "") + "=", "base64");
  if (key.length !== 32) throw new Error("EncodingAESKey 不合法（应为 43 位字符）");
  return key;
}

function pkcs7Strip(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.slice(0, buf.length - pad);
}

function pkcs7Pad(buf, blockSize = 32) {
  const pad = blockSize - (buf.length % blockSize) || blockSize;
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

/** 签名：token/timestamp/nonce/密文 四者字典序排序后拼接取 sha1 */
function msgSignature(token, timestamp, nonce, encrypt) {
  const s = [String(token), String(timestamp), String(nonce), String(encrypt)].sort().join("");
  return crypto.createHash("sha1").update(s).digest("hex");
}

/** 解密 → { msg, receiveId } */
function decryptMsg(encodingAESKey, encrypted) {
  const key = aesKeyOf(encodingAESKey);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.slice(0, 16));
  decipher.setAutoPadding(false);
  const raw = pkcs7Strip(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]));
  const len = raw.readUInt32BE(16); // 前 16 字节随机数，接着 4 字节大端消息长度
  return { msg: raw.slice(20, 20 + len).toString("utf8"), receiveId: raw.slice(20 + len).toString("utf8") };
}

/** 加密（回调被动回复用；本模块主要走主动推送，保留以备用） */
function encryptMsg(encodingAESKey, msg, receiveId) {
  const key = aesKeyOf(encodingAESKey);
  const body = Buffer.from(msg, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(body.length, 0);
  const full = pkcs7Pad(
    Buffer.concat([crypto.randomBytes(16), lenBuf, body, Buffer.from(String(receiveId || ""), "utf8")])
  );
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.slice(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(full), cipher.final()]).toString("base64");
}

// ---------- XML ----------

function xmlField(xml, name) {
  const m = String(xml || "").match(new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${name}>`));
  return m ? (m[1] !== undefined ? m[1] : m[2] || "").trim() : "";
}

/** 按 UTF-8 字节数切片（微信接口限制的是字节不是字符，中文一个字 3 字节） */
function splitBytes(text, maxBytes) {
  const out = [];
  let cur = "";
  let size = 0;
  for (const ch of String(text || "")) {
    const n = Buffer.byteLength(ch, "utf8");
    if (size + n > maxBytes) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

// ---------- 通用 access_token 缓存 ----------

function makeTokenCache(fetchToken) {
  let cache = { value: "", expireAt: 0, key: "" };
  return async function getToken(key, fresh = false) {
    if (!fresh && cache.value && cache.key === key && Date.now() < cache.expireAt) return cache.value;
    const { token, expiresIn } = await fetchToken();
    cache = { value: token, expireAt: Date.now() + (Math.max(60, expiresIn || 7200) - 300) * 1000, key };
    return token;
  };
}

// ---------- 企业微信自建应用 ----------

function createWecomApp({ getConfig, log = () => {} }) {
  const cfg = () => getConfig() || {};
  const getToken = makeTokenCache(async () => {
    const { corp_id, secret } = cfg();
    if (!corp_id || !secret) throw new Error("未配置企业微信 CorpID / 应用 Secret");
    const r = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corp_id)}&corpsecret=${encodeURIComponent(secret)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const d = await r.json();
    if (d.errcode) throw new Error(`企业微信 token 失败：${d.errmsg}（${d.errcode}）`);
    return { token: d.access_token, expiresIn: d.expires_in };
  });

  async function push(touser, text) {
    const { corp_id, secret, agent_id } = cfg();
    const token = await getToken(`${corp_id}:${secret}`);
    // markdown 在企业微信客户端能渲染标题/加粗/引用/链接；被拒时降级纯文本保证必达
    for (const part of splitBytes(text, 3800)) {
      const send = async (payload) => {
        const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        return r.json();
      };
      let d = await send({ touser, msgtype: "markdown", agentid: +agent_id || 0, markdown: { content: part } });
      if (d.errcode) {
        log("warn", `markdown 消息被拒（${d.errmsg}），降级纯文本`);
        for (const p2 of splitBytes(part, 1800)) {
          d = await send({ touser, msgtype: "text", agentid: +agent_id || 0, text: { content: p2 } });
          if (d.errcode) throw new Error(`企业微信发送失败：${d.errmsg}（${d.errcode}）`);
        }
      }
    }
  }

  /** URL 验证（腾讯保存回调地址时来一次 GET） */
  function verifyUrl(query) {
    const { token, aes_key } = cfg();
    const { msg_signature, timestamp, nonce, echostr } = query;
    if (msgSignature(token, timestamp, nonce, echostr) !== msg_signature) throw new Error("签名校验失败");
    return decryptMsg(aes_key, echostr).msg;
  }

  /** 解析回调消息 → { fromUser, text, msgId } */
  function parseCallback(query, rawBody) {
    const { token, aes_key } = cfg();
    const encrypt = xmlField(rawBody, "Encrypt");
    if (!encrypt) throw new Error("回调体缺少 Encrypt（请在企业微信后台把加密方式设为安全模式）");
    if (msgSignature(token, query.timestamp, query.nonce, encrypt) !== query.msg_signature) {
      throw new Error("签名校验失败");
    }
    const xml = decryptMsg(aes_key, encrypt).msg;
    return {
      fromUser: xmlField(xml, "FromUserName"),
      msgType: xmlField(xml, "MsgType"),
      text: xmlField(xml, "Content"),
      msgId: xmlField(xml, "MsgId"),
    };
  }

  function status() {
    const { corp_id, secret, agent_id, token, aes_key } = cfg();
    // 凭证（推送用）与回调（收消息用）分开报，缺哪半边一眼能看出来
    return {
      configured: !!(corp_id && secret && agent_id),
      callback_ready: !!(token && aes_key),
      path: "/im/wecom/events",
    };
  }

  return { push, verifyUrl, parseCallback, status };
}

// ---------- 微信公众号 ----------

function createWechatMp({ getConfig, log = () => {} }) {
  const cfg = () => getConfig() || {};
  const getToken = makeTokenCache(async () => {
    const { app_id, app_secret } = cfg();
    if (!app_id || !app_secret) throw new Error("未配置公众号 AppID / AppSecret");
    const r = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(app_id)}&secret=${encodeURIComponent(app_secret)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const d = await r.json();
    if (d.errcode) throw new Error(`公众号 token 失败：${d.errmsg}（${d.errcode}）`);
    return { token: d.access_token, expiresIn: d.expires_in };
  });

  /** 客服消息主动推送（48 小时内可推，需已认证的服务号/订阅号） */
  async function push(openid, text) {
    const { app_id, app_secret } = cfg();
    const token = await getToken(`${app_id}:${app_secret}`);
    for (const part of splitBytes(text, 1800)) {
      const r = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touser: openid, msgtype: "text", text: { content: part } }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json();
      if (d.errcode) {
        if (d.errcode === 48001) {
          throw new Error("公众号未获得「客服消息」接口权限（48001）：未认证的订阅号无法主动推送，需认证服务号");
        }
        throw new Error(`公众号发送失败：${d.errmsg}（${d.errcode}）`);
      }
    }
  }

  /** URL 验证：sha1(token/timestamp/nonce 排序拼接) 与 signature 比对 */
  function verifyUrl(query) {
    const { token } = cfg();
    const { signature, timestamp, nonce, echostr } = query;
    const calc = crypto
      .createHash("sha1")
      .update([String(token), String(timestamp), String(nonce)].sort().join(""))
      .digest("hex");
    if (calc !== signature) throw new Error("签名校验失败");
    return echostr;
  }

  /** 解析回调（兼容明文模式与安全模式） */
  function parseCallback(query, rawBody) {
    const { token, aes_key } = cfg();
    let xml = String(rawBody || "");
    const encrypt = xmlField(xml, "Encrypt");
    if (encrypt) {
      if (!aes_key) throw new Error("收到密文但未配置 EncodingAESKey");
      if (msgSignature(token, query.timestamp, query.nonce, encrypt) !== query.msg_signature) {
        throw new Error("签名校验失败");
      }
      xml = decryptMsg(aes_key, encrypt).msg;
    }
    return {
      fromUser: xmlField(xml, "FromUserName"),
      msgType: xmlField(xml, "MsgType"),
      text: xmlField(xml, "Content"),
      msgId: xmlField(xml, "MsgId"),
    };
  }

  function status() {
    const { app_id, app_secret, token, aes_key } = cfg();
    // aes_key 只有「安全模式」才需要，明文模式留空也能收，所以不算进回调就绪
    return {
      configured: !!(app_id && app_secret),
      callback_ready: !!token,
      secure_mode: !!aes_key,
      path: "/im/mp/events",
    };
  }

  return { push, verifyUrl, parseCallback, status };
}

module.exports = {
  createWecomApp,
  createWechatMp,
  msgSignature,
  decryptMsg,
  encryptMsg,
  xmlField,
  splitBytes,
};
