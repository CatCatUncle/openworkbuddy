"use strict";
/**
 * IM 远程指挥 — 在飞书/企业微信等 IM 里给 WorkBuddy 下任务。
 *
 * 1) 飞书机器人（推荐：长连接模式，无需公网地址）：
 *    - 飞书开放平台创建自建应用 → 添加「机器人」能力
 *    - 权限：开通 im:message（接收）与 im:message:send_as_bot（发送）
 *    - 事件订阅：订阅方式选「使用长连接接收事件」，添加事件 im.message.receive_v1
 *    - 发布一个版本使权限生效
 *    - config.json 填 im.feishu.app_id / app_secret，应用启动即自动建立长连接
 *    - 兼容旧的事件回调模式：POST /im/feishu/events 仍然保留（有公网地址时可用）
 *
 * 2) 企业微信群机器人（推送模式）：config.json 填 im.wecom_bot_webhook（群机器人 webhook 地址），
 *    任务完成结果会推送到该群。
 *
 * 3) 通用 Webhook：POST /im/task  { "message": "任务", "secret": "配置的密钥" }
 *    同步等待执行完成，返回 { reply, files }。任何能发 HTTP 的 IM/自动化工具（微信框架、
 *    钉钉 outgoing、iOS 快捷指令等）都可以借此桥接。
 *
 * 状态/日志接口：GET /im/status（各通道连接状态）、GET /im/log（最近消息进出记录）、
 * POST /im/feishu/test（校验凭证 + 取机器人信息 + 重建长连接）。
 */

const express = require("express");
const notify = require("./notify");
const { createQQConnection } = require("./im-qq");
const { createWecomApp, createWechatMp } = require("./im-wechat");

function createImRouter({ config, runtime, sessions, outputFiles }) {
  const router = express.Router();
  const imCfg = () => config.im || {};
  const fsCfg = () => (config.im || {}).feishu || {};
  const qqCfg = () => (config.im || {}).qq || {};
  const wecomCfg = () => (config.im || {}).wecom_app || {};
  const mpCfg = () => (config.im || {}).wechat_mp || {};

  // ---------- 会话管理：超过 N 小时未对话自动开新会话（节省 token，官方同款） ----------

  const lastActive = new Map(); // sessionKey -> 上次消息时间戳
  function maybeResetIdleSession(sessionKey, channel) {
    const hours = +imCfg().session_idle_hours || 0;
    const last = lastActive.get(sessionKey);
    if (hours > 0 && last && Date.now() - last > hours * 3600 * 1000 && sessions.has(sessionKey)) {
      sessions.set(sessionKey, []);
      logIm(channel, "sys", `距上次对话已超过 ${hours} 小时，已自动开启新会话`);
    }
    lastActive.set(sessionKey, Date.now());
  }

  // ---------- IM 消息日志（助理模式面板展示，环形缓冲最多 200 条） ----------

  const imLog = [];
  function logIm(channel, dir, text, extra = {}) {
    imLog.push({ ts: new Date().toISOString(), channel, dir, text: String(text || "").slice(0, 500), ...extra });
    if (imLog.length > 200) imLog.splice(0, imLog.length - 200);
  }

  // ---------- 飞书 token / 发消息 ----------

  let feishuToken = { value: "", expireAt: 0, forApp: "" };
  async function getFeishuToken(fresh = false) {
    const { app_id, app_secret } = fsCfg();
    if (!app_id || !app_secret) throw new Error("未配置飞书 App ID / App Secret");
    if (!fresh && feishuToken.value && feishuToken.forApp === app_id && Date.now() < feishuToken.expireAt) {
      return feishuToken.value;
    }
    const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id, app_secret }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`获取飞书 token 失败: ${data.msg}（code ${data.code}）`);
    feishuToken = { value: data.tenant_access_token, expireAt: Date.now() + (data.expire - 300) * 1000, forApp: app_id };
    return feishuToken.value;
  }

  async function feishuSend(token, chatId, msgType, content) {
    const resp = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) }),
      signal: AbortSignal.timeout(15000),
    });
    return resp.json();
  }

  async function feishuReply(chatId, text) {
    const token = await getFeishuToken();
    // 纯文本消息（msg_type=text）不渲染 Markdown，# 和表格会裸奔；
    // 交互卡片的 markdown 组件（schema 2.0）支持标题/表格/代码块/列表
    const summary = text
      .split("\n")
      .map((l) => l.replace(/[#*`|>\-]/g, "").trim())
      .find(Boolean);
    const card = {
      schema: "2.0",
      config: {
        update_multi: true,
        enable_forward: true,
        width_mode: "fill",
        ...(summary ? { summary: { content: summary.slice(0, 40) } } : {}),
      },
      body: {
        direction: "vertical",
        vertical_spacing: "medium",
        elements: [{ tag: "markdown", content: text }],
      },
    };
    const r = await feishuSend(token, chatId, "interactive", card);
    if (r.code !== 0) {
      // 卡片被拒（个别 Markdown 语法不兼容等）→ 降级纯文本，保证消息必达
      console.warn(`[飞书] 卡片发送失败(code ${r.code}: ${r.msg})，降级纯文本`);
      await feishuSend(token, chatId, "text", { text });
    }
  }

  // ---------- 飞书消息处理（长连接与事件回调共用） ----------

  // 同一会话的任务必须串行：并发跑 runTask 会同时写一份历史，把 tool_calls 序列写坏（LLM 400）
  const taskQueues = new Map(); // sessionKey -> 队尾 Promise
  function enqueueTask(key, fn) {
    const tail = (taskQueues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    taskQueues.set(key, tail);
    tail.finally(() => {
      if (taskQueues.get(key) === tail) taskQueues.delete(key);
    });
    return tail;
  }

  const CH_NAME = { feishu: "飞书", qq: "QQ", wecom_app: "企业微信", wechat_mp: "公众号", webhook: "Webhook" };

  /**
   * 各 IM 通道共用的入站处理：同会话串行排队 → 跑任务 → 回结果 → 转推其他机器人。
   * @param {object} p
   * @param {string} p.channel     通道标识（用于日志）
   * @param {string} p.sessionKey  会话键（同一 key 共享上下文并串行）
   * @param {string} p.text        用户消息
   * @param {(out:string)=>Promise<void>} p.reply  回复函数
   * @param {object} [p.logExtra]  日志附加字段
   */
  function runInbound({ channel, sessionKey, text, reply, logExtra = {} }) {
    logIm(channel, "in", text, logExtra);
    maybeResetIdleSession(sessionKey, channel);
    return enqueueTask(sessionKey, async () => {
      try {
        if (!sessions.has(sessionKey)) sessions.set(sessionKey, []);
        const history = sessions.get(sessionKey);
        history.push({ role: "user", content: text });

        const { finalText } = await runtime.runTask({ history });
        const rootFiles = outputFiles().filter((f) => !f.name.includes("/")); // 只报根目录的成果，不刷用户素材
        let out = finalText || "任务已执行完成。";
        if (rootFiles.length) {
          out += `\n\n📁 成果文件（在 WorkBuddy 工作台可下载）：\n` + rootFiles.slice(0, 8).map((f) => `· ${f.name}`).join("\n");
        }
        await reply(out);
        logIm(channel, "out", out, logExtra);
        await pushBots(`【WorkBuddy·${CH_NAME[channel] || channel}任务完成】\n任务：${text.slice(0, 80)}\n${out.slice(0, 500)}`);
      } catch (e) {
        console.error(`[${CH_NAME[channel] || channel}] 任务执行出错:`, e.message);
        logIm(channel, "error", `任务执行出错: ${e.message}`, logExtra);
        try {
          await reply(`❌ 任务执行出错：${String(e.message).slice(0, 300)}`);
        } catch {}
      }
    });
  }

  const handledMsgs = new Set(); // message_id 去重（飞书会重试推送）
  async function handleFeishuMessage(msg) {
    if (!msg || msg.message_type !== "text") return;
    if (msg.message_id) {
      if (handledMsgs.has(msg.message_id)) return;
      handledMsgs.add(msg.message_id);
      if (handledMsgs.size > 2000) handledMsgs.clear();
    }
    let text = "";
    try {
      text = JSON.parse(msg.content).text || "";
    } catch {}
    text = text.replace(/@_user_\d+/g, "").trim(); // 去掉 @机器人 占位
    if (!text) return;

    const chatId = msg.chat_id;
    // 不发「收到任务/已排队」之类的确认（用户明确要求直接回结果）；排队靠 enqueueTask 自然串行
    await runInbound({
      channel: "feishu",
      sessionKey: `feishu_${chatId}`,
      text,
      logExtra: { chat: chatId },
      reply: (out) => feishuReply(chatId, out.slice(0, 3500)),
    });
  }

  // ---------- 飞书长连接（WSClient 主动拨出，无需公网地址） ----------

  const ws = { client: null, startedWith: "", error: "" };
  async function startFeishuWs(force = false) {
    const { app_id, app_secret } = fsCfg();
    if (!app_id || !app_secret) {
      ws.error = "未配置 App ID / App Secret";
      return wsStatus();
    }
    const ident = `${app_id}:${app_secret}`;
    if (!force && ws.client && ws.startedWith === ident) return wsStatus(); // 已在跑
    await getFeishuToken(true); // 先校验凭证，错的直接抛出去，不进重连循环
    if (ws.client) {
      try {
        ws.client.close();
      } catch {}
      ws.client = null;
    }
    const lark = require("@larksuiteoapi/node-sdk");
    const client = new lark.WSClient({ appId: app_id, appSecret: app_secret, loggerLevel: lark.LoggerLevel.error });
    client.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          try {
            await handleFeishuMessage(data.message);
          } catch (e) {
            console.error("[飞书] 处理长连接消息出错:", e.message);
            logIm("feishu", "error", `处理消息出错: ${e.message}`);
          }
        },
      }),
    });
    ws.client = client;
    ws.startedWith = ident;
    ws.error = "";
    console.log("[飞书] 长连接已启动");
    return wsStatus();
  }
  function wsStatus() {
    if (!ws.client) return { state: "off", error: ws.error };
    try {
      const s = ws.client.getConnectionStatus(); // state: connected/connecting/reconnecting/failed/idle
      return { state: s.state, reconnectAttempts: s.reconnectAttempts, error: ws.error };
    } catch {
      return { state: "unknown", error: ws.error };
    }
  }

  // ---------- QQ 官方机器人（长连接，无需公网地址） ----------

  const qq = createQQConnection({
    getConfig: qqCfg,
    log: (level, text) => {
      if (level === "error") logIm("qq", "error", text);
      console[level === "error" ? "error" : "log"](`[QQ] ${text}`);
    },
    onMessage: async ({ chatType, openid, text, senderName, chatName, reply }) => {
      await runInbound({
        channel: "qq",
        sessionKey: `qq_${chatType}_${openid}`,
        text,
        logExtra: { chat: chatName || senderName },
        reply,
      });
    },
  });

  async function startQQ(force = false) {
    return qq.start(force);
  }

  router.post("/im/qq/test", async (_req, res) => {
    try {
      await qq.getToken(true); // 先验凭证，错的直接报出来而不是进重连循环
      const st = await qq.start(true);
      res.json({ ok: true, qq: st });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ---------- 微信：企业微信自建应用 + 公众号（腾讯回调制，需公网地址） ----------

  const wecom = createWecomApp({ getConfig: wecomCfg, log: (l, t) => console.log(`[企业微信] ${t}`) });
  const mp = createWechatMp({ getConfig: mpCfg, log: (l, t) => console.log(`[公众号] ${t}`) });
  const wxSeen = new Set(); // MsgId 去重（腾讯回调会重试 3 次）
  const rawXml = express.text({ type: "*/*", limit: "1mb" });

  function wxDedupe(msgId) {
    if (!msgId) return false;
    if (wxSeen.has(msgId)) return true;
    wxSeen.add(msgId);
    if (wxSeen.size > 2000) wxSeen.clear();
    return false;
  }

  // 企业微信：GET 用于后台保存回调地址时的 URL 验证，POST 收消息
  router.get("/im/wecom/events", (req, res) => {
    try {
      res.type("text/plain").send(wecom.verifyUrl(req.query));
    } catch (e) {
      console.warn("[企业微信] URL 验证失败:", e.message);
      res.status(400).send(e.message);
    }
  });

  router.post("/im/wecom/events", rawXml, (req, res) => {
    let msg;
    try {
      msg = wecom.parseCallback(req.query, req.body);
    } catch (e) {
      console.warn("[企业微信] 回调解析失败:", e.message);
      return res.status(400).send("");
    }
    res.send(""); // 腾讯要求 5 秒内应答，先回空串再异步跑，避免被判超时重推
    if (msg.msgType !== "text" || !msg.text.trim() || wxDedupe(msg.msgId)) return;
    runInbound({
      channel: "wecom_app",
      sessionKey: `wecom_${msg.fromUser}`,
      text: msg.text.trim(),
      logExtra: { chat: msg.fromUser },
      reply: (out) => wecom.push(msg.fromUser, out),
    }).catch((e) => console.error("[企业微信] 任务出错:", e.message));
  });

  // 公众号：GET 验证服务器配置，POST 收消息
  router.get("/im/mp/events", (req, res) => {
    try {
      res.type("text/plain").send(mp.verifyUrl(req.query));
    } catch (e) {
      console.warn("[公众号] URL 验证失败:", e.message);
      res.status(400).send(e.message);
    }
  });

  router.post("/im/mp/events", rawXml, (req, res) => {
    let msg;
    try {
      msg = mp.parseCallback(req.query, req.body);
    } catch (e) {
      console.warn("[公众号] 回调解析失败:", e.message);
      return res.status(400).send("");
    }
    res.send("success"); // 必须立刻应答，否则微信重推 3 次并给用户显示「该公众号暂时无法提供服务」
    if (msg.msgType !== "text" || !msg.text.trim() || wxDedupe(msg.msgId)) return;
    runInbound({
      channel: "wechat_mp",
      sessionKey: `mp_${msg.fromUser}`,
      text: msg.text.trim(),
      logExtra: { chat: msg.fromUser },
      reply: (out) => mp.push(msg.fromUser, out),
    }).catch((e) => console.error("[公众号] 任务出错:", e.message));
  });

  // 凭证连通性自测：只换 access_token，不发任何消息
  router.post("/im/wechat/test", async (req, res) => {
    const which = (req.body && req.body.which) === "mp" ? "mp" : "wecom";
    const url =
      which === "mp"
        ? `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(mpCfg().app_id || "")}&secret=${encodeURIComponent(mpCfg().app_secret || "")}`
        : `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(wecomCfg().corp_id || "")}&corpsecret=${encodeURIComponent(wecomCfg().secret || "")}`;
    try {
      const d = await fetch(url, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
      if (d.errcode) throw new Error(`${d.errmsg}（${d.errcode}）`);
      res.json({ ok: true, expires_in: d.expires_in });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ---------- 飞书事件回调（旧模式，有公网地址时可用） ----------

  router.post("/im/feishu/events", async (req, res) => {
    const body = req.body || {};
    if (body.type === "url_verification") {
      return res.json({ challenge: body.challenge });
    }
    const token = body.header?.token || body.token;
    if (fsCfg().verification_token && token !== fsCfg().verification_token) {
      return res.status(403).json({ error: "verification_token 不匹配" });
    }
    res.json({ code: 0 }); // 先应答，飞书要求 3 秒内返回
    try {
      if (body.header?.event_type !== "im.message.receive_v1") return;
      await handleFeishuMessage(body.event?.message);
    } catch (e) {
      console.error("[飞书] 处理事件出错:", e.message);
    }
  });

  // ---------- 状态 / 日志 / 测试 ----------

  router.get("/im/status", (_req, res) => {
    const f = fsCfg();
    res.json({
      feishu: { configured: !!(f.app_id && f.app_secret), ws: wsStatus() },
      qq: qq.status(),
      wecom_app: wecom.status(),
      wechat_mp: mp.status(),
      wecom: { configured: !!imCfg().wecom_bot_webhook },
      dingtalk: { configured: !!imCfg().dingtalk_webhook },
      webhook: { configured: true, secret_set: !!imCfg().webhook_secret },
    });
  });

  router.get("/im/log", (_req, res) => res.json(imLog.slice(-100).reverse()));

  router.post("/im/feishu/test", async (_req, res) => {
    try {
      const token = await getFeishuToken(true);
      let botName = "";
      try {
        const r = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15000),
        });
        const d = await r.json();
        botName = d.bot?.app_name || "";
      } catch {}
      const status = await startFeishuWs(true);
      res.json({ ok: true, bot_name: botName, ws: status });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // ---------- 机器人推送（企业微信 + 钉钉，配了哪个推哪个） ----------

  async function pushBots(text) {
    const sent = await notify.pushBots(config, text);
    for (const ch of sent) logIm(ch, "out", text);
  }

  // ---------- 通用 Webhook（任意 IM / 自动化工具桥接） ----------

  router.post("/im/task", async (req, res) => {
    const { message, secret, session } = req.body || {};
    if (imCfg().webhook_secret && secret !== imCfg().webhook_secret) {
      return res.status(403).json({ error: "secret 不正确" });
    }
    if (!message) return res.status(400).json({ error: "缺少 message" });

    logIm("webhook", "in", message, { session: session || "default" });
    const sessionKey = `webhook_${session || "default"}`;
    maybeResetIdleSession(sessionKey, "webhook");
    if (!sessions.has(sessionKey)) sessions.set(sessionKey, []);
    const history = sessions.get(sessionKey);
    history.push({ role: "user", content: message });

    try {
      const { finalText } = await runtime.runTask({ history });
      const files = outputFiles().filter((f) => !f.name.includes("/"));
      logIm("webhook", "out", finalText || "(空回复)", { session: session || "default" });
      await pushWecom(`【WorkBuddy·任务完成】\n任务：${message.slice(0, 80)}\n${(finalText || "").slice(0, 500)}`);
      res.json({ reply: finalText, files });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return { router, startFeishuWs, startQQ };
}

module.exports = { createImRouter };
