"use strict";
/**
 * QQ 官方机器人 — WebSocket 长连接（主动拨出，无需公网地址）。
 *
 * 前置准备（QQ 开放平台 q.qq.com）：
 *   1. 创建「机器人」应用 → 开发设置里拿 AppID / AppSecret
 *   2. 功能配置 → 开启「消息列表」：私聊消息、群聊 @机器人 消息
 *   3. 沙箱环境只对白名单群/好友生效；正式环境需通过审核发布
 *
 * 协议要点：token 走 bots.qq.com 换取（有效期 2h，提前 5min 刷新），
 * WS 网关地址走 /gateway/bot，鉴权头是 `QQBot <token>`（不是 Bearer）。
 */

const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_API = "https://api.sgroup.qq.com";
const INTENTS = 1 << 25; // PUBLIC_MESSAGES：C2C 私聊 + 群内 @机器人
const MSG_LIMIT = 4500; // 官方上限 5000 字，留余量
const RECONNECT_DELAYS = [2000, 5000, 10000, 20000, 30000, 60000];

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;

function getWS() {
  if (typeof WebSocket === "function") return WebSocket; // Node 22+/Electron 内置
  try {
    return require("ws");
  } catch {
    throw new Error("运行时缺少 WebSocket（需 Node 22+ 或安装 ws 依赖）");
  }
}

/** 按长度切片，尽量在换行处断开 */
function splitText(text, limit = MSG_LIMIT) {
  const out = [];
  let rest = String(text || "");
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig  返回 { app_id, app_secret }
 * @param {(msg) => Promise<void>} deps.onMessage  收到消息回调
 *        msg = { chatType:"c2c"|"group", openid, msgId, text, senderName, chatName }
 * @param {(level, text) => void} deps.log
 */
function createQQConnection({ getConfig, onMessage, log = () => {} }) {
  let ws = null;
  let token = { value: "", expireAt: 0, forApp: "" };
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let attempts = 0;
  let lastSeq = null;
  let sessionId = "";
  let state = "off"; // off | connecting | connected | failed
  let lastError = "";
  let closedByUs = false;
  const msgSeq = new Map(); // msg_id -> 递增序号（同一条被动回复的多条消息不能重复）
  const seen = new Set(); // 消息去重

  async function getToken(fresh = false) {
    const { app_id, app_secret } = getConfig();
    if (!app_id || !app_secret) throw new Error("未配置 QQ AppID / AppSecret");
    if (!fresh && token.value && token.forApp === app_id && Date.now() < token.expireAt) return token.value;
    const r = await fetch(QQ_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: String(app_id), clientSecret: String(app_secret) }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!d.access_token) throw new Error(`获取 QQ token 失败：${d.message || d.msg || JSON.stringify(d).slice(0, 200)}`);
    token = {
      value: d.access_token,
      expireAt: Date.now() + (Math.max(60, +d.expires_in || 7200) - 300) * 1000,
      forApp: app_id,
    };
    return token.value;
  }

  async function api(method, path, body) {
    const t = await getToken();
    const r = await fetch(`${QQ_API}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${t}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { _raw: text };
    }
    if (!r.ok || (data.code && data.code !== 0)) {
      const err = new Error(`QQ 接口 ${path} 失败 ${r.status}：${data.message || text.slice(0, 200)}`);
      err.qqCode = data.code;
      throw err;
    }
    return data;
  }

  /**
   * 回消息。优先带 msg_id 走「被动回复」（不消耗主动推送额度），
   * 但被动回复窗口只有 5 分钟 / 5 条——agent 跑久了就会过期，
   * 这时自动降级成主动消息（消耗额度）而不是把结果吞掉。
   */
  async function send(chatType, openid, text, msgId) {
    const endpoint = chatType === "c2c" ? `/v2/users/${openid}/messages` : `/v2/groups/${openid}/messages`;
    for (const part of splitText(text)) {
      const body = { content: part, msg_type: 0 };
      if (msgId) {
        const n = (msgSeq.get(msgId) || 0) + 1;
        msgSeq.set(msgId, n);
        body.msg_id = msgId;
        body.msg_seq = n;
      }
      try {
        await api("POST", endpoint, body);
      } catch (e) {
        if (!msgId) throw e;
        log("warn", `被动回复失败（${e.message.slice(0, 120)}），改用主动消息`);
        await api("POST", endpoint, { content: part, msg_type: 0 });
      }
    }
  }

  function stripMention(s) {
    return String(s || "")
      .replace(/<@!?\d+>/g, "")
      .trim();
  }

  async function onDispatch(payload) {
    const t = payload.t;
    const d = payload.d || {};
    if (t !== "C2C_MESSAGE_CREATE" && t !== "GROUP_AT_MESSAGE_CREATE") return;
    const msgId = d.id;
    if (!msgId || seen.has(msgId)) return;
    seen.add(msgId);
    if (seen.size > 2000) seen.clear();

    const text = stripMention(d.content);
    if (!text) return;
    const isC2C = t === "C2C_MESSAGE_CREATE";
    const openid = isC2C ? d.author?.user_openid || d.author?.id : d.group_openid;
    if (!openid) return;
    const senderName = (d.author?.username || "").trim() || "QQ 用户";

    await onMessage({
      chatType: isC2C ? "c2c" : "group",
      openid,
      msgId,
      text,
      senderName,
      chatName: isC2C ? senderName : "QQ 群",
      reply: (out) => send(isC2C ? "c2c" : "group", openid, out, msgId),
    });
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function scheduleReconnect() {
    if (closedByUs || reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(attempts, RECONNECT_DELAYS.length - 1)];
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((e) => {
        lastError = e.message;
        log("warn", `重连失败：${e.message}`);
        scheduleReconnect();
      });
    }, delay);
  }

  async function connect() {
    closedByUs = false;
    state = "connecting";
    const t = await getToken(true);
    const gw = await api("GET", "/gateway/bot");
    const url = gw.url;
    if (!url) throw new Error("未取到 QQ 网关地址");

    const WSImpl = getWS();
    const sock = new WSImpl(url);
    ws = sock;

    sock.onopen = () => log("info", "WebSocket 已连接，等待鉴权");
    sock.onerror = (e) => {
      lastError = (e && (e.message || e.error?.message)) || "WebSocket 错误";
    };
    sock.onclose = () => {
      stopHeartbeat();
      if (ws === sock) {
        ws = null;
        state = closedByUs ? "off" : "connecting";
        if (!closedByUs) scheduleReconnect();
      }
    };
    sock.onmessage = async (ev) => {
      let payload;
      try {
        payload = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (payload.s != null) lastSeq = payload.s;

      if (payload.op === OP_HELLO) {
        const interval = payload.d?.heartbeat_interval || 41250;
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          try {
            sock.send(JSON.stringify({ op: OP_HEARTBEAT, d: lastSeq }));
          } catch {}
        }, interval);
        const auth = `QQBot ${t}`;
        sock.send(
          JSON.stringify(
            sessionId
              ? { op: OP_RESUME, d: { token: auth, session_id: sessionId, seq: lastSeq } }
              : { op: OP_IDENTIFY, d: { token: auth, intents: INTENTS, shard: [0, 1] } }
          )
        );
      } else if (payload.op === OP_DISPATCH) {
        if (payload.t === "READY") {
          sessionId = payload.d?.session_id || "";
          state = "connected";
          attempts = 0;
          lastError = "";
          log("info", `已就绪：${payload.d?.user?.username || "机器人"}`);
        } else if (payload.t === "RESUMED") {
          state = "connected";
          attempts = 0;
        } else {
          onDispatch(payload).catch((e) => log("error", `处理消息出错：${e.message}`));
        }
      } else if (payload.op === OP_RECONNECT) {
        try {
          sock.close();
        } catch {}
      } else if (payload.op === OP_INVALID_SESSION) {
        sessionId = ""; // 会话失效，下次重新 IDENTIFY
        try {
          sock.close();
        } catch {}
      }
    };
  }

  async function start(force = false) {
    const { app_id, app_secret } = getConfig();
    if (!app_id || !app_secret) {
      state = "off";
      lastError = "未配置 AppID / AppSecret";
      return status();
    }
    if (!force && ws && state !== "failed") return status();
    stop();
    attempts = 0;
    sessionId = "";
    try {
      await connect();
    } catch (e) {
      state = "failed";
      lastError = e.message;
      throw e;
    }
    return status();
  }

  function stop() {
    closedByUs = true;
    stopHeartbeat();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    state = "off";
  }

  function status() {
    const { app_id, app_secret } = getConfig();
    return { configured: !!(app_id && app_secret), state, error: lastError, reconnectAttempts: attempts };
  }

  return { start, stop, status, send, getToken };
}

module.exports = { createQQConnection, splitText };
