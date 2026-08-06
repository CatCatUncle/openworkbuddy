"use strict";
/**
 * 微信 iLink 机器人（扫码登录，长轮询收发，**不需要公网地址**）
 *
 * 这是微信自己的机器人通道 https://ilinkai.weixin.qq.com ——
 * 跟企业微信自建应用/公众号那两条完全不同：那两条只能腾讯回调你（必须有公网 HTTPS），
 * 这条是你主动去长轮询取消息，所以一台笔记本就能跑。
 *
 * 接入三步：
 *   1. POST /ilink/bot/get_bot_qrcode?bot_type=3
 *      → { qrcode, qrcode_img_content }；qrcode_img_content 是一条微信深链，
 *        要把这条**字符串编码成二维码图片**给用户扫（它本身不是图片地址，踩过）
 *   2. GET  /ilink/bot/get_qrcode_status?qrcode=xxx  （长轮询，最长约 35 秒）
 *      → status: wait | scaned | confirmed | expired
 *        confirmed 时带回 bot_token / ilink_bot_id / baseurl，存下来就是长期凭证
 *   3. POST /ilink/bot/getupdates   长轮询收消息（游标 get_updates_buf 要持久化）
 *      POST /ilink/bot/sendmessage  回消息（必须带该用户最近一条消息的 context_token）
 *
 * 鉴权头是 `AuthorizationType: ilink_bot_token` + `Authorization: Bearer <botToken>`，
 * 两个都要，少一个就 401。
 *
 * 协议细节参考自 CatClaw 的 src/wechat.ts（同一套接口，已在真实微信上跑通）。
 */

const crypto = require("crypto");

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const QR_BOT_TYPE = "3";

const MESSAGE_TYPE_BOT = 2; // 机器人自己发的，收到要跳过否则自问自答
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const MESSAGE_STATE_FINISH = 2;

const ERRCODE_SESSION_EXPIRED = -14; // 登录态失效，只能重新扫码

const DEFAULT_LONGPOLL_MS = 35000;
const LONGPOLL_EXTRA_MS = 5000;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const SEND_LIMIT = 2000; // 微信文本比其他渠道严，按字符切

/** X-WECHAT-UIN：随机 uint32 转字符串再 base64 */
function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function splitText(text, limit = SEND_LIMIT) {
  const out = [];
  let buf = "";
  for (const line of String(text || "").split("\n")) {
    if (line.length > limit) {
      if (buf) { out.push(buf); buf = ""; }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    if (buf && buf.length + line.length + 1 > limit) { out.push(buf); buf = line; }
    else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

/** 从 item_list 里抽出文本；语音有转写就用转写，图片/文件/视频只留占位标签 */
function extractText(items) {
  const parts = [];
  for (const item of items || []) {
    if (item.type === ITEM_TEXT && item.text_item && item.text_item.text) parts.push(item.text_item.text);
    else if (item.type === ITEM_VOICE) parts.push(item.voice_item && item.voice_item.text ? item.voice_item.text : "（语音，未转写）");
    else if (item.type === ITEM_IMAGE) parts.push("（图片，本版暂不下载）");
    else if (item.type === ITEM_FILE) parts.push(`（文件：${(item.file_item && item.file_item.file_name) || "未命名"}，本版暂不下载）`);
    else if (item.type === ITEM_VIDEO) parts.push("（视频，本版暂不下载）");
  }
  return parts.join("\n").trim();
}

function dedupKey(msg) {
  if (msg.message_id !== undefined) return `mid:${msg.message_id}`;
  if (msg.seq !== undefined) return `seq:${msg.seq}`;
  return `fb:${msg.from_user_id}:${msg.create_time_ms}:${msg.client_id}`;
}

// ---------- 扫码登录（无需已有凭证，所以是模块级函数） ----------

/** 取二维码：返回 { qrcode, deepLink }，deepLink 需前端/后端编码成二维码图片 */
async function fetchQrcode(baseUrl) {
  const url = `${baseUrl || DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${QR_BOT_TYPE}`;
  const resp = await fetch(url, { method: "POST", signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`取二维码失败：HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.qrcode) throw new Error(`取二维码失败：${JSON.stringify(data).slice(0, 200)}`);
  return { qrcode: data.qrcode, deepLink: data.qrcode_img_content || "" };
}

/**
 * 轮询扫码状态（服务端长轮询，最长约 35 秒才回；超时当作 wait 让前端再问一次）。
 * confirmed 时返回 { status:"confirmed", botToken, ilinkBotId, baseUrl }
 */
async function pollQrStatus(qrcode, baseUrl) {
  const url = `${baseUrl || DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  let data;
  try {
    const resp = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: AbortSignal.timeout(35000),
    });
    if (!resp.ok) throw new Error(`轮询失败：HTTP ${resp.status}`);
    data = await resp.json();
  } catch (e) {
    // 长轮询到点没人扫 → 不是错误，让前端接着问
    if (e.name === "TimeoutError" || e.name === "AbortError") return { status: "wait" };
    throw e;
  }
  if (data.status === "confirmed" && data.bot_token && data.ilink_bot_id) {
    return {
      status: "confirmed",
      botToken: data.bot_token,
      ilinkBotId: String(data.ilink_bot_id).replace(/[^a-zA-Z0-9@._-]/g, ""),
      baseUrl: data.baseurl || "",
    };
  }
  return { status: data.status || "wait" };
}

// ---------- 长轮询连接 ----------

/**
 * @param getConfig  () => { bot_token, ilink_bot_id, base_url, get_updates_buf }
 * @param onMessage  async ({ userId, text }) => void  收到用户消息
 * @param onCursor   (buf) => void  游标变化（调用方负责持久化，重启不重放）
 */
function createIlinkConnection({ getConfig, onMessage, onCursor = () => {}, log = console }) {
  const cfg = () => getConfig() || {};
  const uin = randomUin();

  let stopping = false;
  let state = "off"; // off | connecting | connected | failed
  let lastError = "";
  let cursor = "";
  let longpollMs = DEFAULT_LONGPOLL_MS;
  let cancelSleep = null;
  let loopRunning = false;

  const contextTokens = new Map(); // userId -> 最近一条消息的 context_token（回消息必须带）
  const seen = new Map(); // 去重：key -> ts

  function markSeen(key) {
    const now = Date.now();
    if (seen.size > 1000) for (const [k, ts] of seen) if (now - ts > 30 * 60 * 1000) seen.delete(k);
    seen.set(key, now);
  }
  const isDuplicate = (key) => seen.has(key);

  function headers() {
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${cfg().bot_token}`,
      "X-WECHAT-UIN": uin,
    };
  }

  async function apiPost(endpoint, body, timeoutMs) {
    const base = cfg().base_url || DEFAULT_BASE_URL;
    const resp = await fetch(`${base.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${endpoint} 返回的不是 JSON：${text.slice(0, 200)}`);
    }
  }

  const baseInfo = () => ({ channel_version: "0.1.0" });

  async function sendOnce(userId, contextToken, text) {
    const r = await apiPost("ilink/bot/sendmessage", {
      msg: {
        to_user_id: userId,
        context_token: contextToken,
        item_list: [{ type: ITEM_TEXT, text_item: { text } }],
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        client_id: String(crypto.randomBytes(4).readUInt32BE(0)),
      },
      base_info: baseInfo(),
    }, 20000);
    if (r.ret !== undefined && r.ret !== 0) {
      throw new Error(`发送失败 ret=${r.ret} errcode=${r.errcode || ""} ${r.errmsg || ""}`);
    }
  }

  /** 回消息：必须有该用户的 context_token（来自他最近一条消息），否则微信不收 */
  async function send(userId, text) {
    const ct = contextTokens.get(userId);
    if (!ct) throw new Error("没有该用户的 context_token（需对方先发一条消息）");
    for (const chunk of splitText(text)) await sendOnce(userId, ct, chunk);
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      cancelSleep = () => { clearTimeout(t); resolve(); };
    });
  }

  async function handleMessage(msg) {
    if (msg.message_type === MESSAGE_TYPE_BOT) return; // 自己发的
    const userId = msg.from_user_id;
    if (!userId) return;
    const key = dedupKey(msg);
    if (isDuplicate(key)) return;
    markSeen(key);
    if (msg.context_token) contextTokens.set(userId, msg.context_token);
    const text = extractText(msg.item_list);
    if (!text) return;
    await onMessage({ userId, text });
  }

  async function pollLoop() {
    let backoff = RECONNECT_MIN_MS;
    while (!stopping) {
      const startedAt = Date.now();
      try {
        const r = await apiPost("ilink/bot/getupdates", {
          get_updates_buf: cursor,
          base_info: baseInfo(),
        }, longpollMs + LONGPOLL_EXTRA_MS);

        if (r.longpolling_timeout_ms) longpollMs = r.longpolling_timeout_ms;

        if (r.ret === ERRCODE_SESSION_EXPIRED) {
          state = "failed";
          lastError = "微信登录态已失效（-14），需要重新扫码";
          log.warn(`[微信iLink] ${lastError}`);
          break;
        }
        if (r.ret !== undefined && r.ret !== 0) {
          lastError = `getupdates ret=${r.ret}`;
          log.warn(`[微信iLink] ${lastError}`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
          continue;
        }

        state = "connected";
        lastError = "";
        backoff = RECONNECT_MIN_MS;

        if (r.get_updates_buf && r.get_updates_buf !== cursor) {
          cursor = r.get_updates_buf;
          try { onCursor(cursor); } catch { /* 持久化失败不该拖垮收消息 */ }
        }
        for (const msg of r.msgs || []) {
          try { await handleMessage(msg); }
          catch (e) { log.error(`[微信iLink] 处理消息出错: ${e.message}`); }
        }
      } catch (e) {
        if (stopping) break;
        // 长轮询到期有两种形态：我们这边 abort（TimeoutError），或服务端直接关连接
        // （fetch failed，真凶埋在 cause 里）。靠错误串永远分不清，所以看**这次请求活了多久**：
        // 在窗口里熬了大半程才断=正常到期，立刻重来；几百毫秒就断的才是真故障，走退避。
        // 兜底 3 秒：longpolling_timeout_ms 是服务端下发的，万一给个极小值，
        // 判据会退化成"什么错都算到期"，那就成了空转打接口。
        const elapsed = Date.now() - startedAt;
        const floor = Math.max(longpollMs * 0.5, 3000);
        if (e.name === "TimeoutError" || e.name === "AbortError" || elapsed >= floor) continue;
        state = "failed";
        lastError = e.message;
        log.error(`[微信iLink] 轮询出错（${elapsed}ms）: ${e.message}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    }
    loopRunning = false;
    if (state !== "failed") state = "off";
  }

  async function start(force = false) {
    const c = cfg();
    if (!c.bot_token || !c.ilink_bot_id) {
      state = "off";
      return status();
    }
    if (loopRunning && !force) return status();
    if (loopRunning) await stop();

    stopping = false;
    seen.clear();
    contextTokens.clear();
    cursor = c.get_updates_buf || "";
    state = "connecting";
    lastError = "";
    loopRunning = true;
    log.log(`[微信iLink] 开始长轮询（bot ${c.ilink_bot_id}）`);
    pollLoop().catch((e) => {
      loopRunning = false;
      state = "failed";
      lastError = e.message;
      log.error(`[微信iLink] 轮询循环退出: ${e.message}`);
    });
    return status();
  }

  async function stop() {
    stopping = true;
    if (cancelSleep) { cancelSleep(); cancelSleep = null; }
    loopRunning = false;
    state = "off";
    contextTokens.clear();
    seen.clear();
  }

  function status() {
    const c = cfg();
    return {
      configured: !!(c.bot_token && c.ilink_bot_id),
      state,
      error: lastError,
      bot_id: c.ilink_bot_id || "",
      // 对方发过消息才有 context_token，没有就回不了话
      repliable: contextTokens.size,
    };
  }

  return { start, stop, send, status, hasContext: (uid) => contextTokens.has(uid) };
}

module.exports = {
  createIlinkConnection,
  fetchQrcode,
  pollQrStatus,
  splitText,
  extractText,
  dedupKey,
  DEFAULT_BASE_URL,
};
