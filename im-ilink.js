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
 *   4. 附件走腾讯 CDN，不在这条协议里：消息体给 encrypt_query_param + aes_key，
 *      下下来是 AES-128-ECB 密文；发附件则反过来 getuploadurl → 加密上传 → 发媒体消息。
 *      加解密在 im-media.js。
 *
 * 鉴权头是 `AuthorizationType: ilink_bot_token` + `Authorization: Bearer <botToken>`，
 * 两个都要，少一个就 401。
 *
 * 协议细节参考自 CatClaw 的 src/wechat.ts（同一套接口，已在真实微信上跑通）。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const imMedia = require("./im-media");

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

// 发附件：先问微信要一个上传地址，加密上传到 CDN，再把 CDN 凭证塞进消息体
const MEDIA_IMAGE = 1;
const MEDIA_FILE = 3;
// getuploadurl 校验这两个身份头，缺了直接回 {"ret":-1}（图片不校验，一起带上无害）
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = "131329"; // "2.1.1" → (2<<16)|(1<<8)|1
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

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

const KIND_CN = { image: "图片", file: "文件", voice: "语音", video: "视频", sticker: "表情" };

/** 这一项带没带 CDN 下载信息（两样都齐才下得动） */
function hasCdn(item) {
  const m = item && item.media;
  return !!(m && m.encrypt_query_param && m.aes_key);
}

/**
 * 把一条消息的 item_list 拆成三摊：文字、要下载的附件、下不了的附件。
 *
 * 以前这里只吐文字，图片/文件一律换成「本版暂不下载」的占位——用户在微信里发了份 PDF，
 * agent 只看见一行字，用户以为发到了。现在附件交给调用方真下下来，占位只留给
 * 微信确实没给下载信息的那种。
 */
function describeItems(items) {
  const text = [];
  const media = [];
  const notes = [];
  let unknown = 0;
  for (const it of items || []) {
    if (!it) continue;
    if (it.type === ITEM_TEXT) {
      if (it.text_item && it.text_item.text) text.push(it.text_item.text);
    } else if (it.type === ITEM_IMAGE) {
      if (hasCdn(it.image_item)) media.push({ kind: "image", name: "", media: it.image_item.media });
      else notes.push({ kind: "image", name: "", why: "微信这条消息没带下载信息" });
    } else if (it.type === ITEM_VOICE) {
      // 语音优先用微信自己的转写文字；没转写才去下原始音频
      if (it.voice_item && it.voice_item.text) text.push(it.voice_item.text);
      else if (hasCdn(it.voice_item)) media.push({ kind: "voice", name: "", media: it.voice_item.media });
      else notes.push({ kind: "voice", name: "", why: "微信没给转写文字，也没带下载信息" });
    } else if (it.type === ITEM_FILE) {
      const name = (it.file_item && it.file_item.file_name) || "";
      if (hasCdn(it.file_item)) media.push({ kind: "file", name, media: it.file_item.media });
      else notes.push({ kind: "file", name, why: "微信这条消息没带下载信息" });
    } else if (it.type === ITEM_VIDEO) {
      if (hasCdn(it.video_item)) media.push({ kind: "video", name: "", media: it.video_item.media });
      else notes.push({ kind: "video", name: "", why: "微信这条消息没带下载信息" });
    } else {
      unknown++;
    }
  }
  // 表情包/位置/名片这些解析不了的类型：以前整条消息被丢掉，机器人一声不吭，用户以为它死了。
  // 宁可回一句「这个我看不了」，也不能装作没收到
  if (unknown && !text.length && !media.length && !notes.length) {
    notes.push({ kind: "sticker", name: "", why: "这类消息（表情包／位置／名片等）我这边解析不了" });
  }
  return { text: text.join("\n").trim(), media, notes };
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
 * @param onMessage  async ({ userId, text, saved, failed }) => void  收到用户消息
 *                   saved/failed 是本条消息里的附件：已落盘的 / 没收下来的
 * @param onCursor   (buf) => void  游标变化（调用方负责持久化，重启不重放）
 * @param downloadMedia async ({ kind, name, media }) => 落盘后的文件名。由调用方实现——
 *                   只有它知道工作目录在哪；不传就退化成「收到但下不了」，但仍然会告诉用户
 */
function createIlinkConnection({ getConfig, onMessage, onCursor = () => {}, log = console, downloadMedia = null }) {
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

  async function apiPost(endpoint, body, timeoutMs, extraHeaders) {
    const base = cfg().base_url || DEFAULT_BASE_URL;
    const resp = await fetch(`${base.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: extraHeaders ? { ...headers(), ...extraHeaders } : headers(),
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

  /**
   * 把工作目录里的成果文件发进微信聊天。
   * 三步：getuploadurl 拿预签名地址 → AES-128-ECB 加密上传到 CDN → 用 CDN 凭证发一条媒体消息。
   * 图片按图片发（聊天里能直接看），其他一律按文件发。
   */
  async function sendFile(userId, absPath, fileName) {
    const ct = contextTokens.get(userId);
    if (!ct) throw new Error("没有该用户的 context_token（需对方先发一条消息）");
    const name = String(fileName || path.basename(absPath));
    const buf = fs.readFileSync(absPath);
    if (!buf.length) throw new Error("文件是空的");
    if (buf.length > imMedia.MAX_INBOUND_BYTES) {
      throw new Error(`文件 ${(buf.length / 1048576).toFixed(1)}MB，超过微信 ${imMedia.MAX_INBOUND_BYTES / 1048576}MB 上限`);
    }
    const isImage = IMAGE_EXT_RE.test(name);
    const aesKey = crypto.randomBytes(16);
    const aesKeyHex = aesKey.toString("hex");
    // filekey 必须是纯 ASCII：拿中文文件名当 key，服务端回 {"ret":-1}
    const filekey = crypto.randomBytes(16).toString("hex");
    const cipherSize = imMedia.aesEcbPaddedSize(buf.length);
    const up = await apiPost("ilink/bot/getuploadurl", {
      filekey,
      media_type: isImage ? MEDIA_IMAGE : MEDIA_FILE,
      to_user_id: userId,
      rawsize: buf.length,
      rawfilemd5: crypto.createHash("md5").update(buf).digest("hex"),
      filesize: cipherSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
      base_info: baseInfo(),
    }, 20000, { "iLink-App-Id": ILINK_APP_ID, "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION });
    if (!up.upload_param) throw new Error(`微信没给上传地址（ret=${up.ret} ${up.errmsg || ""}）`);

    const downloadParam = await imMedia.uploadCdnCiphertext({
      buf,
      uploadParam: up.upload_param,
      filekey,
      cdnBaseUrl: cfg().cdn_base_url,
      aesKey,
    });
    // 回传的 aes_key 用跟收消息一致的编码：base64(十六进制字符串的 ASCII 字节)
    const aesKeyField = Buffer.from(aesKeyHex, "utf8").toString("base64");
    const media = { encrypt_query_param: downloadParam, aes_key: aesKeyField, encrypt_type: 1 };
    const item = isImage
      ? { type: ITEM_IMAGE, image_item: { media, mid_size: cipherSize } }
      : { type: ITEM_FILE, file_item: { media, file_name: name, len: String(buf.length) } };
    const r = await apiPost("ilink/bot/sendmessage", {
      msg: {
        to_user_id: userId,
        context_token: ct,
        item_list: [item],
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        client_id: String(crypto.randomBytes(4).readUInt32BE(0)),
      },
      base_info: baseInfo(),
    }, 60000);
    if (r.ret !== undefined && r.ret !== 0) {
      throw new Error(`发送失败 ret=${r.ret} errcode=${r.errcode || ""} ${r.errmsg || ""}`);
    }
    return name;
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
    const { text, media, notes } = describeItems(msg.item_list);
    const saved = [];
    const failed = notes.slice();
    for (const m of media) {
      if (!downloadMedia) { failed.push({ kind: m.kind, name: m.name, why: "这个版本没接附件下载" }); continue; }
      try {
        saved.push({ kind: m.kind, name: await downloadMedia(m) });
      } catch (e) {
        failed.push({ kind: m.kind, name: m.name, why: String(e.message || e).slice(0, 120) });
        log.error(`[微信iLink] ${KIND_CN[m.kind] || "附件"}没收下来: ${e.message}`);
      }
    }
    // 一条消息里三样都空才算「没内容」——附件没下成也要报给用户，不能静默吞掉
    if (!text && !saved.length && !failed.length) return;
    await onMessage({ userId, text, saved, failed });
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

  return { start, stop, send, sendFile, status, hasContext: (uid) => contextTokens.has(uid) };
}

module.exports = {
  createIlinkConnection,
  fetchQrcode,
  pollQrStatus,
  splitText,
  describeItems,
  dedupKey,
  DEFAULT_BASE_URL,
};
