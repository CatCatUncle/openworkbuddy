"use strict";
/**
 * IM 远程指挥 — 在飞书/企业微信等 IM 里给 OpenWorkBuddy 下任务。
 *
 * 1) 飞书机器人（推荐：长连接模式，无需公网地址）：
 *    - 飞书开放平台创建自建应用 → 添加「机器人」能力
 *    - 权限：开通 im:message（接收）与 im:message:send_as_bot（发送）
 *    - 事件订阅：订阅方式选「使用长连接接收事件」，添加事件 im.message.receive_v1
 *    - 发布一个版本使权限生效
 *    - config.json 填 im.feishu.app_id / app_secret，应用启动即自动建立长连接
 *    - 兼容旧的事件回调模式：POST /im/feishu/events 仍然保留（有公网地址时可用）
 *
 * 2) 微信 iLink 机器人（扫码登录，同样无需公网地址）：设置里点「获取二维码」→ 微信扫码确认，
 *    之后走长轮询收发消息。实现在 im-ilink.js。
 *
 * 3) 企业微信自建应用 / 公众号（腾讯回调制，必须有公网 HTTPS）：见 im-wechat.js，
 *    回调地址分别是 /im/wecom/events 与 /im/mp/events。
 *
 * 4) 企业微信群机器人（推送模式）：config.json 填 im.wecom_bot_webhook（群机器人 webhook 地址），
 *    任务完成结果会推送到该群。
 *
 * 5) 通用 Webhook：POST /im/task  { "message": "任务", "secret": "配置的密钥" }
 *    同步等待执行完成，返回 { reply, files }。任何能发 HTTP 的 IM/自动化工具（微信框架、
 *    钉钉 outgoing、iOS 快捷指令等）都可以借此桥接。
 *
 * 状态/日志接口：GET /im/status（各通道连接状态）、GET /im/log（最近消息进出记录）、
 * POST /im/feishu/test（校验凭证 + 取机器人信息 + 重建长连接）。
 *
 * 飞书对话长这样（三段式，参考 catclaw 的做法）：
 *   1) 收到消息立刻在用户那条上贴一个「稍等」表情 —— 不新发消息，不刷屏；
 *   2) 随即发一张卡片，卡片里能看见执行过程（当前在跑第几步、动了哪个工具、给了什么文件）；
 *   3) 任务跑完，同一张卡片原地变成最终回答（正文打字机式流出）并撤掉表情。
 *   卡片发不出去 / 平台不支持时逐级降级：CardKit 流式 → CardKit 静态卡 → 普通交互卡 → 纯文本。
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { dataPath } = require("./paths");
const notify = require("./notify");
const callout = require("./callout"); // IM 里没有图标，正文提示条换成文字标签
const security = require("./security");
const mailer = require("./mailer"); // 发信：配没配、地址合不合法、报错里有没有夹带密码，判据只有这一份
const { getWorkspaceDir } = require("./tools");
const { createQQConnection } = require("./im-qq");
const { createWecomApp, createWechatMp } = require("./im-wechat");
const ilinkApi = require("./im-ilink");
const imMedia = require("./im-media");
const admin = require("./admin"); // 谁是平台管理员：服务器级通道（飞书/QQ/webhook）的日志只归他
const prefs = require("./prefs"); // 会话键复用同一套「可读前缀 + 哈希」命名，不会撞车也逃不出目录

// gen_diagram 一次落 <名字>.svg + <名字>.png，是同一张图的两种格式。两个都发过去，
// 用户在聊天里收到两张一模一样的图，还白占掉 5 个附件名额里的 2 个。
// 同主名的只发 PNG——聊天窗口能直接渲染它，SVG 发过去多半只是个点不开的附件
function dropVectorTwins(list) {
  const pngs = new Set(list.filter((f) => /\.png$/i.test(f.name)).map((f) => f.name.replace(/\.png$/i, "")));
  return list.filter((f) => !(/\.svg$/i.test(f.name) && pngs.has(f.name.replace(/\.svg$/i, ""))));
}

/**
 * 飞书事件既可能直接给 message，也可能包在 event.message / data.message 里。
 * 统一在这里拆，后面的去重永远拿真实 message_id，不会因为 SDK 或回调模式换了
 * 载荷形状而退化成内容指纹。
 */
function unwrapFeishuInbound(envelope) {
  const root = envelope && typeof envelope === "object" ? envelope : {};
  const options = [root.message, root.event?.message, root.data?.message, root.data?.event?.message, root];
  const message = options.find((item) => item && typeof item === "object" && item.message_type) || null;
  const eventId = String(root.header?.event_id || root.event_id || root.data?.header?.event_id || root.data?.event_id || "").trim();
  return { message, eventId };
}

function feishuDedupeKeys(message, eventId = "") {
  const msg = message || {};
  const messageId = String(msg.message_id || "").trim();
  const chatId = String(msg.chat_id || "").trim();
  const keys = [];
  // 同一次事件的 event_id 与消息 message_id 双键落盘：长连接补投、HTTP 回调重试、
  // 甚至两条通道同时开启，都只能占到同一把锁。
  if (eventId) keys.push(`e:${eventId}`);
  if (messageId) keys.push(`m:${chatId}:${messageId}`, messageId); // 裸 id 是旧版兼容键
  if (keys.length) return keys;
  // 极少数异常投递没有 message_id 时才走指纹；摘要不可逆，且只保留 32 位。
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
    chatId, msg.message_type || "", msg.create_time || "", msg.content || "",
  ])).digest("hex").slice(0, 32);
  return [`f:${fingerprint}`];
}

function createImRouter({ config, runtime, sessions, outputFiles, saveConfig = () => {} }) {
  const router = express.Router();
  const imCfg = () => config.im || {};
  const fsCfg = () => (config.im || {}).feishu || {};
  const qqCfg = () => (config.im || {}).qq || {};
  const wecomCfg = () => (config.im || {}).wecom_app || {};
  const mpCfg = () => (config.im || {}).wechat_mp || {};
  const ilinkCfg = () => (config.im || {}).wechat_ilink || {};
  const smtpCfg = () => (config.im || {}).smtp || {};

  // ---------- 会话管理：超过 N 小时未对话自动开新会话（节省 token，官方同款） ----------

  // 会话存盘。server.js 传进来的是个会落盘的仓库，测试里传普通 Map 就是纯内存，两边都能跑
  const saveSession = (key) => {
    if (typeof sessions.save === "function") sessions.save(key);
  };

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

  // ---------- IM 消息日志（助理模式面板展示，环形缓冲最多 200 条，落盘防重启丢历史） ----------

  const IM_LOG_FILE = dataPath("data", "im-log.json");
  const imLog = (() => {
    try { return JSON.parse(fs.readFileSync(IM_LOG_FILE, "utf-8")).slice(-200); } catch { return []; }
  })();
  let imLogTimer = null;
  function logIm(channel, dir, text, extra = {}) {
    imLog.push({ ts: new Date().toISOString(), channel, dir, text: String(text || "").slice(0, 500), ...extra });
    if (imLog.length > 200) imLog.splice(0, imLog.length - 200);
    // 攒 500ms 再写，一轮任务的进出两条只落一次盘
    if (!imLogTimer) imLogTimer = setTimeout(() => {
      imLogTimer = null;
      fs.writeFile(IM_LOG_FILE, JSON.stringify(imLog), () => {});
    }, 500);
  }

  // ---------- 谁看得见哪一条 ----------
  // 助理页以前是「一台服务器一份」：A 打开助理页，看到的是 B 刚才跟机器人说的话；接着发一句，
  // 还接在 B 的上下文上。规矩改成两条——有主的（某个人在助理页里的对话）只有主人看得见；
  // 没主的（飞书/QQ/企微/webhook 这些服务器级通道）只有平台管理员看得见。
  const localKeyOf = (user) => "local_" + (prefs.keyOf(user) || "assist");
  const seesAll = (user) => admin.isSoloDesktop() || admin.platformAdmin(user);
  const visibleTo = (user) => {
    const me = (user && user.username) || "";
    const boss = seesAll(user);
    return (e) => (e && e.owner ? e.owner === me : boss);
  };
  const sessionCount = (user) => {
    if (typeof sessions.keys !== "function") return 0;
    const keys = sessions.keys();
    if (seesAll(user)) return keys.length;
    const mine = localKeyOf(user);
    return keys.filter((k) => k === mine).length;
  };

  // ---------- 飞书 token / 发消息 ----------

  let feishuToken = { value: "", expireAt: 0, forApp: "" };
  let feishuBot = { openId: "", name: "", expireAt: 0 };
  async function getFeishuToken(fresh = false) {
    const { app_id, app_secret } = fsCfg();
    const miss = feishuMissing();
    if (miss.length) throw new Error(`飞书凭证还差 ${miss.join(" 和 ")}（开放平台 → 你的应用 → 凭证与基础信息里复制）`);
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
    if (data.code !== 0) {
      // 10003/10014 = 两串凭证之一填错了，直接说清楚该去改哪一个，别让人对着 code 查文档
      const hint = data.code === 10003 ? "：App ID 不对" : data.code === 10014 ? "：App Secret 不对" : "";
      throw new Error(`飞书不认这套凭证${hint}（${data.msg}，code ${data.code}）`);
    }
    feishuToken = { value: data.tenant_access_token, expireAt: Date.now() + (data.expire - 300) * 1000, forApp: app_id };
    return feishuToken.value;
  }

  // 群聊里必须分清「有人 @ 了任意同事」和「有人 @ 机器人」。不猜机器人名字，
  // 直接用飞书给应用机器人的 open_id 比对，改名也不会失效。
  async function getFeishuBotInfo(fresh = false) {
    if (!fresh && feishuBot.openId && Date.now() < feishuBot.expireAt) return feishuBot;
    const token = await getFeishuToken();
    const r = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    if (!r.ok || d.code !== 0 || !d.bot?.open_id) throw new Error(d.msg || "拿不到机器人身份");
    feishuBot = {
      openId: String(d.bot.open_id),
      name: String(d.bot.app_name || d.bot.bot_name || ""),
      expireAt: Date.now() + 60 * 60 * 1000,
    };
    return feishuBot;
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

  // ---------- 飞书卡片：一段执行过程 + 一个最终回答 ----------
  // 为什么不用自己发文本再编辑：飞书文本消息能改，但改不出结构（标题、分栏、分隔线都不行），
  // 而且编辑接口对 text 有频控。CardKit（cardkit.v1）是飞书给「流式卡片」的正路：
  // 先建一张卡 → 发出去 → 之后按 element_id 局部推内容，正文那格还自带打字机效果。
  // 参考实现：catclaw 的 feishu-streaming-card.ts。

  const FEISHU_STEPS_KEEP = 6; // 卡片上最多列几行执行过程，多了留最近几条 + 「另有 n 步」
  const FEISHU_FLUSH_MS = 1200; // 卡片最快多久推一次（打字机由飞书渲染，推太勤只是白花配额）
  const FEISHU_STREAM_MAX = 4000; // 一条飞书消息的正文上限，正文超过就只把摘要放卡上

  /** 卡片放不下（正文超 4000 / 表格超 5 个）时，正文走文本消息，卡片里说一句「见下条」 */
  function feishuCardBody(text, budget) {
    const lines = String(text || "").split("\n");
    let tables = 0;
    // 飞书卡片最多 5 个 markdown 表格。按连续的 | 行算一个表格块，
    // 不要把一张表的每一行都算成一个表格。
    let inTable = false;
    for (const l of lines) {
      const row = /^\s*\|.*\|\s*$/.test(l);
      if (row && !inTable) tables++;
      inTable = row;
    }
    if (String(text).length <= budget && tables <= 5) return { body: text, split: false };
    const cut = lines.slice(0, 12).join("\n").slice(0, Math.min(budget, 500));
    return { body: cut + "\n\n> 内容较长（" + String(text).length + " 字），正文见下一条消息。", split: true };
  }

  /** 卡片上的执行过程：从 agent 事件里挑「用户看得懂在干什么」的那些 */
  function feishuCardLine(ev, st) {
    if (ev.type === "step_start" && !ev.depth) { st.step = ev.step; return null; }
    if (ev.type === "tool_use") {
      const label = TOOL_LABELS[ev.name] || ev.name;
      const det = String(ev.purpose || "").replace(/\s+/g, " ").trim().slice(0, 60);
      return `**第 ${st.step || 1} 步** · ${label}${det ? "： " + det : ""}`;
    }
    if (ev.type === "expert_start") return `已委派专家「${ev.expert}」`;
    if (ev.type === "expert_done") return `专家「${ev.expert}」已交回结果`;
    if (ev.type === "compact") return "整理长会话上下文（自动压缩早前内容）";
    if (ev.type === "parallel") return "并行跑几个子任务";
    if (ev.type === "auto_continue") return "继续往下做（上一轮还没做完）";
    return null;
  }

  /** 秒 → 人话时长 */
  function feishuDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    return Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
  }

  // CardKit 的 element_id 是建卡时我们自己定的，后面按这个名字推内容
  const CARD_IDS = { HEAD: "owb_head", PROC: "owb_proc", NOTE: "owb_note", BODY: "owb_body" };

  /** 卡片 JSON：schema 2.0，正文 markdown 单列，执行过程放一个灰底折叠面板里 */
  function feishuProgressCard({ title, procLines, note, body, summary, expanded = true, streaming = true }) {
    const els = [];
    if (procLines && procLines.length) {
      els.push({
        tag: "collapsible_panel",
        element_id: "owb_proc_panel",
        expanded,
        header: {
          title: { tag: "markdown", content: "**执行过程**" },
          background_color: "grey-50",
          padding: "6px 10px 6px 10px",
          icon: { tag: "standard_icon", token: "down-small-ccm_outlined" },
        },
        elements: [{ tag: "markdown", element_id: CARD_IDS.PROC, content: procLines.join("\n") }],
      });
    }
    if (note) els.push({ tag: "markdown", element_id: CARD_IDS.NOTE, content: note, text_size: "notation" });
    els.push({ tag: "markdown", element_id: CARD_IDS.BODY, content: body || "…" });
    const cleanTitle = String(title || "生成中").replace(/[\*_`#]/g, "").trim().slice(0, 80) || "生成中";
    const template = streaming ? "blue" : (cleanTitle.includes("没做成") ? "orange" : "green");
    return {
      schema: "2.0",
      config: {
        update_multi: true,
        streaming_mode: streaming,
        enable_forward: true,
        width_mode: "fill",
        streaming_config: { print_frequency_ms: { default: 30 }, print_step: { default: 2 }, print_strategy: "fast" },
        ...(summary ? { summary: { content: summary.slice(0, 40) } } : {}),
      },
      header: { title: { tag: "plain_text", content: cleanTitle }, template },
      body: { direction: "vertical", vertical_spacing: "medium", elements: els },
    };
  }

  /**
   * 一张「活的」飞书卡片：建卡 → 发送 → 按元素推内容 → 收尾。
   * 全程吞掉自己的异常：卡片只是锦上添花，坏掉也绝不能把任务本身带崩。
   */
  function createFeishuCard({ chatId, replyTo, summary, onDegrade }) {
    let cardId = null, messageId = null, seq = 1, broken = false;
    const hashes = new Map();
    let chain = Promise.resolve(); // 同一张卡的所有请求串行，否则 sequence 会乱序被飞书拒掉
    const st = { step: 0, lines: [], extra: 0 };
    let lastFlush = 0, timer = null, pending = null;
    let startedAt = Date.now(), done = false;

    const enqueue = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => undefined, () => undefined); return run; };

    async function api(pathname, init) {
      const transient = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network|timeout|fetch failed|aborted/i;
      const delays = [600, 1500];
      for (let attempt = 0; ; attempt++) {
        try {
          const token = await getFeishuToken();
          const r = await fetch("https://open.feishu.cn" + pathname, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8", ...(init && init.headers) },
            signal: AbortSignal.timeout(15000),
          });
          const j = await r.json().catch(() => ({ code: -1, msg: "响应不是 JSON" }));
          if (j.code !== 0) { const e = new Error(`code ${j.code}: ${j.msg}`); e.code = j.code; throw e; }
          return j.data || {};
        } catch (e) {
          if (attempt >= delays.length || !transient.test(String(e && e.message || e))) throw e;
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        }
      }
    }

    const push = (pathname, init) => enqueue(() => (broken ? null : api(pathname, init).catch((e) => { broken = true; failNote = e.message; return null; })));
    let failNote = "";

    function header(name) {
      return { step: st.step, startedAt, elapsed: feishuDur(Date.now() - startedAt), done, name };
    }

    // ---- 内部：把当前状态推给飞书 ----
    async function flush() {
      if (broken || done) return; // 收尾定格之后，迟到的进度刷新不许再覆盖卡片
      const lines = st.lines.slice(-FEISHU_STEPS_KEEP);
      const extra = st.lines.length - lines.length;
      const proc = (extra > 0 ? `（更早还有 ${extra} 步）\n` : "") + (lines.join("\n") || "接到任务了，准备开工…");
      const card = feishuProgressCard({ procLines: [proc], body: st.bodyText || "…", summary: st.title });
      const key = quickCardHash(card);
      if (hashes.get("__full") === key) return;
      hashes.set("__full", key);
      await push(`/open-apis/cardkit/v1/cards/${cardId}`, { method: "PUT", body: JSON.stringify({ card: { type: "card_json", data: JSON.stringify(card) }, sequence: ++seq }) });
    }
    function quickCardHash(o) { return crypto.createHash("md5").update(JSON.stringify(o)).digest("hex"); }

    async function flushNow() {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
      lastFlush = Date.now();
      await flush();
    }
    function schedule() {
      if (broken) return;
      const wait = FEISHU_FLUSH_MS - (Date.now() - lastFlush);
      if (wait <= 0) return void flushNow();
      if (!timer) timer = setTimeout(() => { timer = null; flush(); lastFlush = Date.now(); }, wait);
    }

    return {
      /** 建卡 + 发出；返回 false 表示这条路走不通（调用方自动降级） */
      async start(title) {
        try {
          const card = feishuProgressCard({ title, procLines: ["接到任务了，准备开工…"], body: "…", summary });
          const created = await api("/open-apis/cardkit/v1/cards", {
            method: "POST",
            body: JSON.stringify({ type: "card_json", data: JSON.stringify(card) }),
          });
          cardId = created.card_id;
          if (!cardId) throw new Error("建卡接口没返回 card_id");
          const token = await getFeishuToken();
          const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
          const resp = replyTo
            ? await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${replyTo}/reply`, {
                method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ content, msg_type: "interactive" }), signal: AbortSignal.timeout(15000),
              })
            : await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
                method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content }), signal: AbortSignal.timeout(15000),
              });
          const rj = await resp.json();
          if (rj.code !== 0 || !(rj.data || {}).message_id) throw new Error(`code ${rj.code}: ${rj.msg}`);
          messageId = rj.data.message_id;
          hashes.set("__sent", quickCardHash(card));
          return true;
        } catch (e) {
          broken = true;
          onDegrade && onDegrade(e);
          return false;
        }
      },
      get ok() { return !!cardId && !broken; },
      get messageId() { return messageId; },
      get sent() { return !!messageId; },

      /** agent 事件 → 卡片上的执行过程 */
      onEvent(ev) {
        if (broken) return;
        const isFiles = ev.type === "files" && Array.isArray(ev.changed) && ev.changed.length;
        const line = feishuCardLine(ev, st);
        const changed = !!(line || isFiles);
        if (line) st.lines.push(line);
        if (isFiles) st.lines.push(`产出文件：${ev.changed.slice(0, 3).join("、")}${ev.changed.length > 3 ? ` 等 ${ev.changed.length} 个` : ""}`);
        if (!changed) return;
        schedule();
      },

      /** 收尾：正文流出去，卡片定格成最终回答 */
      async finish(fullText) {
        done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        // 卡片已经作为回复发出后，不能因为最后一次 PUT 超时再补发普通文本；
        // 那会把同一个任务变成两条用户可见回复。调用方会记录「卡片待同步」，
        // 但不会重新发送答案。
        if (broken || !cardId) return messageId ? "sent" : false;
        try {
          const info = feishuCardBody(fullText, 3000);
          st.title = info.split ? "做完啦 · 正文见下一条" : "做完啦";
          st.bodyText = info.body;
          st.doneText = fullText;
          const lines = st.lines.slice(-FEISHU_STEPS_KEEP);
          const extra = st.lines.length - lines.length;
          const procText = (extra > 0 ? `（更早还有 ${extra} 步）\n` : "") + lines.join("\n");
          // 整卡一次推到位：别先推正文元素再推整卡——两次都往同一格里流正文，卡上会重复两遍。
          // 执行过程收起定格；没有实际步骤（纯聊天）就整块不出现，别留「准备开工…」占位
          const finalCard = feishuProgressCard({
            title: "做完啦" + (info.split ? " · 正文见下一条" : ""),
            procLines: procText ? [procText] : [],
            expanded: false,
            body: info.split ? "见下条消息" : info.body,
            summary: st.title,
            streaming: false, // 收尾直接在整卡 config 里关流式，卡片定格
          });
          // 整卡一次推到位。别再调 /cards/:id/settings 关流式——飞书这个端点返回 404，
          // push 会把 broken 置真，调用方误判卡片没改成、又用纯文本补发一遍，回答就出现两遍。
          const putOk = await push("/open-apis/cardkit/v1/cards/" + cardId, {
            method: "PUT",
            body: JSON.stringify({ card: { type: "card_json", data: JSON.stringify(finalCard) }, sequence: ++seq }),
          });
          if (!putOk) return messageId ? "sent" : false;
          return info.split ? "split" : true;
        } catch (e) {
          onDegrade && onDegrade(e);
          broken = true;
          return messageId ? "sent" : false;
        }
      },

      /** 任务失败时把卡片也标成失败，别让用户盯着一张「准备开工…」发呆 */
      async fail(why) {
        if (broken || !cardId) return;
        try {
          const finalCard = feishuProgressCard({
            title: "没做成",
            procLines: st.lines.slice(-FEISHU_STEPS_KEEP),
            body: `出错了：${String(why).slice(0, 300)}`,
            summary: "任务出错",
            streaming: false,
          });
          await push("/open-apis/cardkit/v1/cards/" + cardId, {
            method: "PUT",
            body: JSON.stringify({ card: { type: "card_json", data: JSON.stringify(finalCard) }, sequence: ++seq }),
          });
        } catch { /* 卡片状态改不动就算了，错误消息本来就还要用文本发一遍 */ }
      },
    };
  }

  /**
   * 飞书原生的「收到了」：在用户那条消息上贴一个表情，答完再撤掉。
   * 不新发消息，所以不会刷屏；表情撤不掉也不影响任何事（飞书对 reaction 有配额）。
   */
  const FEISHU_ACK_EMOJI = "OnIt"; // 飞书表情 key，「收到」含义
  async function feishuAck(msgId) {
    if (!msgId) return null;
    try {
      const token = await getFeishuToken();
      const r = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${msgId}/reactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reaction_type: { emoji_type: FEISHU_ACK_EMOJI } }),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json();
      if (j.code !== 0) {
        // 4009/234001 之类：应用没开 im:message.reaction 权限，或对这条消息不适用——静默放弃
        console.warn(`[飞书] 贴表情失败(code ${j.code}: ${j.msg})，跳过 ack`);
        return null;
      }
      return j.data?.reaction_id || null;
    } catch (e) {
      console.warn("[飞书] 贴表情出错:", e.message);
      return null;
    }
  }
  async function feishuAckClear(msgId, reactionId) {
    if (!msgId || !reactionId) return;
    try {
      const token = await getFeishuToken();
      await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${msgId}/reactions/${reactionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch { /* 撤不掉就留着，用户看到「收到」表情并不困扰 */ }
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

  const CH_NAME = { feishu: "飞书", qq: "QQ", wecom_app: "企业微信", wechat_mp: "公众号", wechat_ilink: "微信", webhook: "Webhook" };

  /**
   * 各 IM 通道共用的入站处理：同会话串行排队 → 跑任务 → 回结果 → 转推其他机器人。
   * @param {object} p
   * @param {string} p.channel     通道标识（用于日志）
   * @param {string} p.sessionKey  会话键（同一 key 共享上下文并串行）
   * @param {string} p.text        用户消息
   * @param {(out:string)=>Promise<void>} p.reply  回复函数
   * @param {object} [p.logExtra]  日志附加字段
   */
  // IM 里没人守着屏幕点审批：auto 档下每个待批命令都要干等 120 秒超时，用户看到的就是
  // 「一直没动静」。所以 IM 任务默认放到「全自动」档（文件黑名单照样拦），可在
  // config.im.permission_mode 改回 auto/ask。
  function imSec() {
    return { ...security.DEFAULTS, ...(config.security || {}), permission_mode: (config.im || {}).permission_mode || "full" };
  }

  const TOOL_LABELS = {
    run_shell: "执行命令", run_node: "运行代码", write_file: "写文件", read_file: "读文件",
    edit_file: "改文件", list_files: "看目录", web_search: "联网搜索", fetch_url: "抓取网页",
    use_skill: "加载技能", delegate_to_expert: "委派专家", delegate_to_team: "召集团队", explore: "派子智能体探索",
    create_feishu_doc: "写飞书文档", remember: "记笔记",
  };

  // 正在执行的任务进度：sessionKey -> { text, channel, at }。网页助理页轮询 /im/progress 拿
  const liveProgress = new Map();
  // 把 agent 执行事件翻译成一行人话进度：飞书状态消息、网页助理页共用一份文案
  function progressLine(ev, st) {
    if (ev.type === "step_start" && !ev.depth) { st.step = ev.step; return null; }
    if (ev.type === "tool_use") {
      const det = String(ev.purpose || "").slice(0, 50);
      return `第 ${st.step || 1} 步 · ${TOOL_LABELS[ev.name] || ev.name}${det ? "：" + det : ""}`;
    }
    if (ev.type === "expert_start") return `已委派专家「${ev.expert}」`;
    if (ev.type === "compact") return "整理长会话上下文（自动压缩早前内容）";
    return null;
  }

  async function runInbound({ channel, sessionKey, text, reply, status, sendFile, card, cardPromise, projectContext = "", logExtra = {} }) {
    logIm(channel, "in", text, logExtra);
    maybeResetIdleSession(sessionKey, channel);
    // 「正在做」状态消息：收到即发（只在支持撤回的通道传 status），跑的过程中原地改成
    // 当前进度，出结果前撤回——聊天里最终只留结果，跟用户「别刷确认消息」的要求不冲突。
    // 飞书走 card 那条路（贴表情 + 执行过程卡片），不再需要 state 消息，传了 card 就自动不挂 status。
    const queued = taskQueues.has(sessionKey);
    let statusHandle = card ? null : (status ? status.send(queued).catch(() => null) : null);

    const recallStatus = async () => {
      if (!statusHandle) return;
      const h = statusHandle;
      statusHandle = null;
      try { await status.recall(await h); } catch {}
    };
    // 飞书卡片：贴表情 ack 之后立刻建一张，跑的过程中往里推执行过程，最后定格成回答。
    // 建卡失败不算任务失败——直接不带卡片继续跑，最终回答走原来那条 reply 路。
    // 卡片建卡和任务可以并行。不能用 Promise.race 把 1.5 秒后才建好的卡片句柄丢掉，
    // 否则卡片会停在「正在处理」，而最终结果只能另发一条消息。
    let cardHandle = null;
    const cardEvents = [];
    const cardReady = card && cardPromise
      ? Promise.resolve(cardPromise).then((h) => {
          if (h && h.ok) {
            cardHandle = h;
            statusHandle = null;
            for (const ev of cardEvents.splice(0)) h.onEvent(ev);
          }
          return cardHandle;
        }).catch(() => null)
      : Promise.resolve(null);
    // 进度节流：最快 4 秒改一次状态消息，别撞飞书编辑接口的频控
    let lastUpd = 0, updTimer = null, progText = "";
    const progState = { step: 0 };
    const pushProgress = () => {
      if (!status || !status.update || !statusHandle) return;
      const fire = async () => {
        lastUpd = Date.now();
        const h = await statusHandle;
        if (h && statusHandle) await status.update(h, progText).catch(() => {});
      };
      const wait = 4000 - (Date.now() - lastUpd);
      if (wait <= 0) fire();
      else if (!updTimer) updTimer = setTimeout(() => { updTimer = null; if (statusHandle) fire(); }, wait);
    };
    const emitProgress = (ev) => {
      const line = progressLine(ev, progState);
      if (!line) return;
      liveProgress.set(sessionKey, { text: line, channel, at: Date.now() }); // 网页助理页的「执行中…」气泡靠这个变活
      progText = `正在做 · ${line}\n（完成后这条会自动撤回）`;
      pushProgress();
    };
    // 出错时到底是哪一步炸的。以前整段共用一个 try，用户看到的永远是「任务执行出错」——
    // 实际上有一类是任务早跑完了、只是回消息那一下超时，说成「执行出错」等于骗人。
    let phase = "任务执行";
    // 消息发送不是幂等请求：网络超时不等于飞书没有收到。过去在这里自动补发一次，
    // 就会出现「服务端已发出、客户端没收到响应 → 同一段答案又发一遍」。
    // 所有 IM 的用户可见消息一律至多发送一次；卡片 API 自己有安全的更新重试。
    const sendOnce = async (fn) => fn();
    return enqueueTask(sessionKey, async () => {
      try {
        if (!sessions.has(sessionKey)) sessions.set(sessionKey, []);
        const history = sessions.get(sessionKey);
        history.push({ role: "user", content: text });
        saveSession(sessionKey); // 先把用户这句话落盘，跑一半崩了至少问题还在

        // 本次产出以 agent files 事件里的 changed 为准（认领台账已把并行任务的文件归对主人）；
        // 以前在这儿对整个工作区做 mtime 差分，别的对话同时写的文件会被当成这次的产出发到用户手机上
        const changedNames = new Set();
        // 告诉 agent 文件是怎么送达的，别再跟用户说「我发不了文件」
        const imNote = channel === "feishu_doc"
          ? "这条消息来自飞书云文档里 @ 机器人的评论。完成后系统会把答复发回同一条评论线程；不要让用户去网页聊天窗口查看，也不要假装已经改动文档。需要修改文档时，先说明将修改的范围并按权限实际执行。"
          : sendFile
          ? "这条消息来自 IM 远程会话（用户不在电脑前，看不到工作台，也看不到你在电脑上弹的任何窗口——别用 open 之类命令给用户「展示」东西，没人看得见）。文件送达机制：任务完成后，系统会自动把本次新建/修改的文件、以及你最终回复里点到名字的文件，作为附件直接发进这个聊天，用户在手机上就能收到。所以用户要某个文件时，只需确保它在工作目录里、并在最终回复里写出文件名（含扩展名），然后告诉用户「文件马上作为附件发给你」。但注意分清用户要的是「文件」还是「内容」：如果用户说「发我内容/直接贴出来/别发文件」，就把全文原样写进回复正文（别摘要、别截断），并在回复最后单独一行写 [[不发文件]] —— 系统认到这个标记就不附任何文件，标记本身用户看不到。反过来，只要回复里出现了文件名，系统默认会把那个文件附上，所以「只要内容」时必须带 [[不发文件]]。用户的口语指令按最直白的意思执行，别反复追问、别解释机制。注意：如果本会话早前的历史里你说过「发不了文件/只能放进文件夹/需要扫码授权才能发」，那些是系统升级前的旧信息，已全部作废，禁止再重复。"
          : "这条消息来自 IM 远程会话（用户不在电脑前，看不到工作台）。产出的文件请报清楚文件名，用户回头在 OpenWorkBuddy 工作台下载。";
        // 只取 finalText 是够的：撞上限 / 超时 / 手动停止那半句，runTask 两条引擎路径都已经
        // 写进正文了（agent.js 的 runViaEngine 和内置循环各补一次）。别在这儿再按 stopped 补一遍，
        // 那样用户手机上会收到两遍同样的告警。
        const { finalText } = await runtime.runTask({
          history,
          sessionId: sessionKey, // 改文件留的检查点记在这个 IM 会话名下
          emit: (ev) => {
            if (ev.type === "files" && Array.isArray(ev.changed)) for (const n of ev.changed) changedNames.add(n);
            if (cardHandle) cardHandle.onEvent(ev);
            else if (card && cardPromise && cardEvents.length < 60) cardEvents.push(ev);
            emitProgress(ev);
          },
          sec: imSec(),
          projectContext: projectContext ? `${imNote}\n\n${projectContext}` : imNote,
        });
        saveSession(sessionKey); // runTask 是就地往 history 里追加的，得自己招呼一声存盘
        const fresh = outputFiles().filter((f) => changedNames.has(f.name)); // 只算本次任务真产出/真改过的
        // 提示条的记号是给网页画图标用的，聊天窗里得换成人话
        let out = callout.strip(finalText || "任务已执行完成。");
        // agent 明确说「本次别发文件」（用户只要内容贴在聊天里）：吃掉标记，附件全免
        const noAttach = out.includes("[[不发文件]]");
        if (noAttach) out = out.replace(/\s*\[\[不发文件\]\]\s*/g, "\n").trim();
        // 能把文件直接发进聊天的通道（飞书）：本次新产出 + 回复里点名的文件都作为附件发过去；
        // 发不了的通道保持老样子，提示去工作台拿
        let toSend = [];
        if (sendFile && !noAttach) {
          const seen = new Set();
          const mentioned = outputFiles().filter((f) => out.includes(f.name.split("/").pop()));
          const all = [...fresh, ...mentioned].filter((f) => !seen.has(f.name) && seen.add(f.name));
          toSend = dropVectorTwins(all).slice(0, 5);
        }
        if (fresh.length && !toSend.length && !noAttach) {
          out += `\n\n成果文件（在 OpenWorkBuddy 工作台可下载）：\n` + fresh.slice(0, 8).map((f) => `· ${f.name}`).join("\n");
          if (fresh.length > 8) out += `\n… 另有 ${fresh.length - 8} 个`;
        }
        if (updTimer) { clearTimeout(updTimer); updTimer = null; }
        await recallStatus();
        phase = "回复发送";
        // 飞书：卡片原地变成最终回答，正文打字机式流出；回复里点名的文件列表也贴在卡上，
        // 方便回看。真正发出去的附件仍然走下面的 sendFile。
        if (!cardHandle && cardPromise) {
          // 短任务可能在卡片建好前就结束；给 CardKit 一点时间接住最终结果，
          // 仍设上限，避免飞书网络异常拖住真正的文本降级回复。
          await Promise.race([
            cardReady,
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]);
        }
        if (cardHandle) {
          const withFiles = toSend && toSend.length
            ? out + "\n\n---\n" + toSend.map((f) => f.name.split("/").pop()).join(" · ")
            : out;
          const r = await cardHandle.finish(withFiles).catch(() => null);
          if (r === true) { logIm(channel, "out", out, logExtra); phase = "附件发送"; }
          else if (r === "split") {
            // 卡片放不下全文（超长/表格超 5 个）：卡片停在上半段 + 提示，正文改用文本发一条
            await sendOnce(() => reply(out));
            logIm(channel, "out", out, logExtra);
            phase = "附件发送";
          } else if (r === "sent") {
            // 初始卡已作为对这条消息的唯一回复发出；末次更新异常时宁可留一条可诊断日志，
            // 也绝不能再补一条文本把用户刷两遍。下次事件/任务会重新走正常卡片。
            logIm(channel, "sys", "结果卡片已发出，末次同步失败；未补发重复回复", logExtra);
            phase = "附件发送";
          } else {
            // 卡片这条路整个废了（建卡失败/推内容被拒）：退回老的交互卡或纯文本，保证回答必达
            await sendOnce(() => reply(out));
            logIm(channel, "out", out, logExtra);
            phase = "附件发送";
          }
        } else {
          await sendOnce(() => reply(out));
          logIm(channel, "out", out, logExtra);
          phase = "附件发送";
        }
        for (const f of toSend) {
          try {
            await sendOnce(() => sendFile(f.name));
            logIm(channel, "out", `已发送文件：${f.name}`, logExtra);
          } catch (e) {
            logIm(channel, "error", `发送文件 ${f.name} 失败: ${e.message}`, logExtra);
            try { await reply(`「${f.name}」没发出去（${String(e.message).slice(0, 100)}），可在 OpenWorkBuddy 工作台下载。`); } catch {}
          }
        }
        await pushBots(`【OpenWorkBuddy·${CH_NAME[channel] || channel}任务完成】\n任务：${text.slice(0, 80)}\n${out.slice(0, 500)}`);
      } catch (e) {
        const why = String(e.message || e).slice(0, 300);
        // 「任务跑完了但没发出去」跟「任务本身失败」是两回事，用户下一步该做什么也不一样
        const label = phase === "任务执行" ? "任务执行出错" : `任务跑完了，${phase}失败`;
        console.error(`[${CH_NAME[channel] || channel}] ${label}:`, e.message);
        logIm(channel, "error", `${label}: ${why}`, logExtra);
        if (updTimer) { clearTimeout(updTimer); updTimer = null; }
        try {
          await recallStatus();
          if (cardHandle) await cardHandle.fail(why).catch(() => {});
          await reply(phase === "任务执行"
            ? `任务执行出错：${why}`
            : `任务已经跑完了，但${phase}失败：${why}。结果和文件都在 OpenWorkBuddy 工作台里，去那儿拿。`);
        } catch {}
      } finally {
        liveProgress.delete(sessionKey); // 任务收尾，进度条目摘掉，别让网页一直显示「执行中」
        if (card && card.ackMsgId) feishuAckClear(card.ackMsgId, card.ackId).catch(() => {}); // 表情收尾：任务完了就把「稍等」摘掉
      }
    });
  }

  // 「正在做」状态消息：发一条轻量文本，跑的过程中原地编辑成当前进度，做完撤回。
  async function feishuStatusSend(chatId, queued) {
    const token = await getFeishuToken();
    const text = queued
      ? "收到，前面还有任务在跑，排队中…（完成后这条会自动撤回）"
      : "收到，正在做了…（完成后这条会自动撤回）";
    const r = await feishuSend(token, chatId, "text", { text });
    return r.code === 0 ? (r.data || {}).message_id : null;
  }
  async function feishuStatusUpdate(messageId, text) {
    if (!messageId) return;
    const token = await getFeishuToken();
    await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) }),
      signal: AbortSignal.timeout(10000),
    });
  }
  const FEISHU_IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
  const FEISHU_FILE_TYPE = { pdf: "pdf", doc: "doc", docx: "doc", xls: "xls", xlsx: "xls", ppt: "ppt", pptx: "ppt", mp4: "mp4", opus: "opus" };
  /** 把工作目录里的文件作为附件发进飞书会话：图片走 images 接口，其余走 files 接口 */
  async function feishuSendFileMsg(chatId, relName) {
    const abs = path.join(getWorkspaceDir(), relName);
    const buf = fs.readFileSync(abs);
    if (buf.length > 28 * 1024 * 1024) throw new Error("超过飞书 30MB 上传上限");
    const name = relName.split("/").pop();
    const ext = (name.split(".").pop() || "").toLowerCase();
    const token = await getFeishuToken();
    let msgType, content;
    if (FEISHU_IMG_EXT.has(ext)) {
      const fd = new FormData();
      fd.append("image_type", "message");
      fd.append("image", new Blob([buf]), name);
      const r = await (await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd, signal: AbortSignal.timeout(60000),
      })).json();
      if (r.code !== 0) throw new Error(`传图失败 code ${r.code}: ${r.msg}`);
      msgType = "image"; content = { image_key: r.data.image_key };
    } else {
      const fd = new FormData();
      fd.append("file_type", FEISHU_FILE_TYPE[ext] || "stream");
      fd.append("file_name", name);
      fd.append("file", new Blob([buf]), name);
      const r = await (await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd, signal: AbortSignal.timeout(120000),
      })).json();
      if (r.code !== 0) throw new Error(`传文件失败 code ${r.code}: ${r.msg}`);
      msgType = "file"; content = { file_key: r.data.file_key };
    }
    const r2 = await feishuSend(token, chatId, msgType, content);
    if (r2.code !== 0) throw new Error(`发送失败 code ${r2.code}: ${r2.msg}`);
  }
  /** 用户在飞书里发来的图片/文件：下载进工作目录，返回落盘文件名 */
  // 飞书那边一条消息一个 message_type，附件的 key 藏在 content 里，类型名还各不相同。
  // 表里没有的类型（名片、位置、投票…）不硬猜，交给上面写一句「这类我解析不了」，也好过整条丢掉。
  const FEISHU_MEDIA = {
    image: { key: "image_key", res: "image", kind: "image" },
    sticker: { key: "file_key", res: "image", kind: "sticker" },
    file: { key: "file_key", res: "file", kind: "file" },
    audio: { key: "file_key", res: "file", kind: "voice" },
    media: { key: "file_key", res: "file", kind: "video" },
  };

  async function feishuSaveResource(msg) {
    const c = JSON.parse(msg.content || "{}");
    const spec = FEISHU_MEDIA[msg.message_type] || FEISHU_MEDIA.file;
    const key = c[spec.key] || c.image_key || c.file_key;
    if (!key) throw new Error("消息里没有资源 key");
    const token = await getFeishuToken();
    const { buf, fileName } = await imMedia.fetchBuffer(
      `https://open.feishu.cn/open-apis/im/v1/messages/${msg.message_id}/resources/${key}?type=${spec.res}`,
      { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 60000 },
    );
    return imMedia.saveInbound(getWorkspaceDir(), c.file_name || fileName || "", buf, {
      fallback: imMedia.defaultName("飞书", spec.kind, "", Date.now()),
    });
  }

  // 富文本（post）以前整条被丢掉——用户在飞书里排个版发过来，机器人就一声不吭。
  // 这里把纯文本、超链接文字、@ 的人名按行拼回去，图片另外走附件那条路。
  function feishuPostText(c) {
    const lines = [];
    if (c.title) lines.push(String(c.title));
    const walk = (rows) => {
      for (const row of rows || []) {
        const seg = [];
        for (const el of row || []) {
          if (!el) continue;
          if (el.tag === "text" || el.tag === "a") seg.push(el.text || "");
          else if (el.tag === "at") seg.push(el.user_name ? `@${el.user_name}` : "");
          else if (el.tag === "emotion") seg.push(el.emoji_type ? `[${el.emoji_type}]` : "");
        }
        const line = seg.join("").trim();
        if (line) lines.push(line);
      }
    };
    // 老结构是 { zh_cn: { title, content } }，新结构直接 { title, content }
    if (Array.isArray(c.content)) walk(c.content);
    else for (const v of Object.values(c)) if (v && Array.isArray(v.content)) { if (v.title) lines.push(String(v.title)); walk(v.content); }
    return lines.join("\n").trim();
  }

  async function feishuRecall(messageId) {
    if (!messageId) return;
    try {
      const token = await getFeishuToken();
      await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.warn("[飞书] 撤回状态消息失败:", e.message);
    }
  }

  // 飞书长连接在应用重启后会补推最近事件；公网回调与长连接误同时开启时，也可能同时投递同一条。
  // 不能只靠内存，更不能等 120ms 再落盘：刚回复完就重启时，那个定时器可能还没来得及写。
  // 最近 2000 个键同步、原子落盘；只存 message_id 或内容指纹，不存正文和联系人。
  const FEISHU_DEDUPE_FILE = dataPath("data", "feishu-handled-messages.json");
  const handledMsgs = (() => {
    try {
      const rows = JSON.parse(fs.readFileSync(FEISHU_DEDUPE_FILE, "utf8"));
      return new Set(Array.isArray(rows) ? rows.slice(-2000).map(String) : []);
    } catch { return new Set(); }
  })();
  function persistHandledFeishuMessages() {
    try {
      fs.mkdirSync(path.dirname(FEISHU_DEDUPE_FILE), { recursive: true });
      const tmp = FEISHU_DEDUPE_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify([...handledMsgs]), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, FEISHU_DEDUPE_FILE);
    } catch (e) { console.warn("[飞书] 消息去重记录写入失败:", e.message); }
  }
  function rememberFeishuMessage(msg, eventId) {
    const keys = feishuDedupeKeys(msg, eventId);
    for (const id of keys) { handledMsgs.delete(id); handledMsgs.add(id); }
    while (handledMsgs.size > 2000) handledMsgs.delete(handledMsgs.values().next().value);
    persistHandledFeishuMessages(); // 必须在下载附件、调用模型、发送卡片之前完成
  }
  function feishuMentionIds(mentions) {
    const ids = new Set();
    for (const item of Array.isArray(mentions) ? mentions : []) {
      for (const value of [item?.open_id, item?.user_id, item?.id, item?.id?.open_id, item?.id?.user_id]) {
        if (typeof value === "string" && value.trim()) ids.add(value.trim());
      }
    }
    return ids;
  }
  async function feishuAcceptsGroupMessage(msg) {
    if (String(msg.chat_type || "").toLowerCase() !== "group") return true;
    // 群里默认只接 @ 机器人，避免机器人把成员之间的闲聊也当成任务。明确选「群内所有消息」
    // 才会放开——这是便利与刷屏/误执行之间应由管理员决定的一道闸。
    if (String(fsCfg().group_reply_mode || "mention") === "all") return true;
    const ids = feishuMentionIds(msg.mentions);
    try {
      const bot = await getFeishuBotInfo();
      return ids.has(bot.openId);
    } catch (e) {
      logIm("feishu", "error", `无法确认群聊 @ 对象，已安全忽略：${String(e.message || e).slice(0, 120)}`, { chat: msg.chat_id });
      return false;
    }
  }
  async function handleFeishuMessage(envelope) {
    const { message: msg, eventId } = unwrapFeishuInbound(envelope);
    if (!msg || !msg.message_type) return;
    const dedupeKeys = feishuDedupeKeys(msg, eventId);
    if (dedupeKeys.some((id) => handledMsgs.has(id))) {
      logIm("feishu", "sys", "忽略重复投递的消息", { chat: msg.chat_id });
      return;
    }
    // 这一步必须在任何 await 之前：同一进程里同时到达的重投也会看见已占位；
    // 同步原子落盘则覆盖「刚收到就重启」这条路径。
    rememberFeishuMessage(msg, eventId);
    if (!(await feishuAcceptsGroupMessage(msg))) {
      logIm("feishu", "sys", "忽略未 @ 机器人的群聊消息", { chat: msg.chat_id });
      return;
    }
    const type = msg.message_type;
    let content = {};
    try { content = JSON.parse(msg.content || "{}"); } catch {}
    let text = "";
    const saved = [];
    const failed = [];

    try {
      if (type === "text") {
        text = String(content.text || "").replace(/@_user_\d+/g, "").trim(); // 去掉 @机器人 占位
      } else if (type === "post") {
        text = feishuPostText(content);
      } else if (FEISHU_MEDIA[type]) {
        const kind = FEISHU_MEDIA[type].kind;
        try {
          saved.push({ kind, name: await feishuSaveResource(msg) });
        } catch (e) {
          logIm("feishu", "error", `接收${imMedia.KIND_CN[kind] || "附件"}失败: ${e.message}`, { chat: msg.chat_id });
          failed.push({ kind, name: String(content.file_name || ""), why: String(e.message || e).slice(0, 120) });
        }
      } else {
        // 名片/位置/日程/投票…解析不了就明说一句，别整条丢掉——机器人不吭声比说不会更吓人
        failed.push({ kind: "sticker", name: "", why: `这类消息（${type}）我这边解析不了` });
      }

    if (saved.length || failed.length) text = imMedia.inboundNote({ channel: "飞书", saved, failed, text });
    if (!text) return;

    const chatId = msg.chat_id;
    // 三段式的第一段：先在用户那条消息上贴个表情，表示「收到了」。
    // 贴表情是个网络请求，超时就当没贴上，绝不拦住任务起步。
    const ackId = await feishuAck(msg.message_id);
    // 第二段：一张卡片，跑的过程中能看见执行过程；第三段（最终回答）会落回这张卡片上。
    // 命令类的短消息(/help 之类)开卡不值当。卡片请求和任务并行启动，
    // 由 runInbound 缓存早到的事件，避免「卡片慢一点就永远收不到最终结果」。
    const isCmd = /^[\/／]/.test(text);
    const cardP = isCmd
      ? null
      : (() => {
          const h = createFeishuCard({
            chatId,
            replyTo: msg.message_id, // 作为对用户那条消息的回复发出，上下文不会乱
            summary: text.slice(0, 40),
            onDegrade: (e) => console.warn("[飞书] 卡片降级为普通回复:", e.message),
          });
          return h.start(`**${CH_NAME.feishu} · 正在处理**`).then((ok) => (ok ? h : null));
        })().catch(() => null);
    await runInbound({
      channel: "feishu",
      sessionKey: `feishu_${chatId}`,
      text,
      logExtra: { chat: chatId },
      card: cardP ? { ackMsgId: msg.message_id, ackId } : null,
      cardPromise: cardP,
      sendFile: (rel) => feishuSendFileMsg(chatId, rel),
      reply: (out) => feishuReply(chatId, out.slice(0, 3500)),
    });
    // 收尾：表情是「收到了」的意思，活干完了就该摘掉（runInbound 内部已按任务真正收尾时摘）
  } catch (e) {
    console.error("[飞书] 处理消息出错:", e.message);
  }
  }

  // ---------- 飞书云文档评论 @ 机器人 ----------
  // 文档里的 @ 不是 im.message 事件。飞书会以 drive.notice.comment_add_v1 通知被提及者，
  // 再由我们读取那条评论、把 Agent 的答案回写到同一评论线程。
  function feishuCommentPlainText(comment, replyId) {
    const replies = comment?.reply_list?.replies || comment?.replies || [];
    const reply = replies.find((item) => String(item.reply_id) === String(replyId)) || replies[replies.length - 1];
    return (reply?.content?.elements || []).map((item) => {
      if (item?.type === "text_run") return item.text_run?.text || "";
      if (item?.type === "person") return item.person?.name ? `@${item.person.name}` : "@成员";
      if (item?.type === "docs_link") return item.docs_link?.url || "";
      return "";
    }).join("").trim();
  }
  function feishuCommentFileTypes(fileType) {
    const type = String(fileType || "docx").trim().toLowerCase();
    // 飞书事件里的 file_type 和 Drive 评论接口在历史文档/新版文档上偶尔不一致。
    // CatClaw 的实现会沿用事件类型；这里再对 doc/docx 做一次安全别名兜底，避免直接报 not exist。
    if (type === "doc") return ["doc", "docx"];
    if (type === "docx") return ["docx", "doc"];
    return [type];
  }
  async function feishuGetDocComment(fileToken, commentId, fileType) {
    const token = await getFeishuToken();
    let last = null;
    for (const type of feishuCommentFileTypes(fileType)) {
      const qs = new URLSearchParams({ file_type: type, user_id_type: "open_id" });
      const r = await fetch(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments/${encodeURIComponent(commentId)}?${qs}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.code === 0) return { data: d.data || {}, fileType: type };
      last = new Error(d.msg || `读取文档评论失败（${r.status}）`);
      last.fileType = type;
      // 只有类型/资源不存在时才尝试别名；权限、鉴权等错误应原样暴露，便于配置修复。
      if (!/not exist|不存在|not_found/i.test(String(d.msg || ""))) throw last;
    }
    throw last || new Error("读取文档评论失败");
  }
  async function feishuListDocComments(fileToken, fileType) {
    const token = await getFeishuToken();
    let last = null;
    for (const type of feishuCommentFileTypes(fileType)) {
      const qs = new URLSearchParams({ file_type: type, user_id_type: "open_id", page_size: "50" });
      const r = await fetch(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments?${qs}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.code === 0) return { items: d.data?.items || [], fileType: type };
      last = new Error(d.msg || `列出文档评论失败（${r.status}）`);
      last.fileType = type;
      if (!/not exist|不存在|not_found/i.test(String(d.msg || ""))) throw last;
    }
    throw last || new Error("列出文档评论失败");
  }
  async function feishuGetDocText(fileToken, fileType) {
    if (!["doc", "docx"].includes(String(fileType || "").toLowerCase())) return "";
    const token = await getFeishuToken();
    const qs = new URLSearchParams({ lang: "0" });
    const r = await fetch(`https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(fileToken)}/raw_content?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.code !== 0) return "";
    const content = String(d.data?.content || "").trim();
    return content.length > 12000 ? `${content.slice(0, 12000)}\n…（文档正文过长，已截断）` : content;
  }
  function feishuDocumentTitle(meta, docText, fileToken) {
    const fromMeta = [meta?.file_name, meta?.document_title, meta?.title, meta?.name]
      .map((value) => String(value || "").trim())
      .find(Boolean);
    if (fromMeta) return fromMeta.slice(0, 160);
    const firstLine = String(docText || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (firstLine) return firstLine.replace(/^#{1,6}\s*/, "").slice(0, 160);
    return `飞书文档（${String(fileToken || "").slice(0, 12)}）`;
  }
  async function feishuReplyDocComment(fileToken, commentId, fileType, text) {
    const token = await getFeishuToken();
    const qs = new URLSearchParams({
      file_type: fileType || "docx",
      user_id_type: "open_id",
    });
    const r = await fetch(`https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/comments/${encodeURIComponent(commentId)}/replies?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        content: { elements: [{ type: "text_run", text_run: { text: String(text || "").slice(0, 3000) } }] },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    if (!r.ok || d.code !== 0) {
      throw new Error(d.msg || `回复文档评论失败（HTTP ${r.status}，code ${d.code ?? "unknown"}）`);
    }
  }
  async function handleFeishuDocMention(envelope) {
    const root = envelope && typeof envelope === "object" ? envelope : {};
    // SDK 分发器传来的是 event 本体；HTTP 回调则包在 body.event 里，两种都接。
    const event = root.event || root.data?.event || root;
    if (!event.is_mentioned) return;
    const meta = event.notice_meta || {};
    const fileToken = String(meta.file_token || "").trim();
    const commentId = String(event.comment_id || "").trim();
    const replyId = String(event.reply_id || commentId).trim();
    const fileType = String(meta.file_type || "docx").trim();
    const eventId = String(root.header?.event_id || root.event_id || root.data?.header?.event_id || "").trim();
    const key = eventId ? `doc:e:${eventId}` : `doc:f:${crypto.createHash("sha256").update([fileToken, commentId, replyId].join("\u0000")).digest("hex").slice(0, 32)}`;
    if (!fileToken || !commentId || handledMsgs.has(key)) return;
    handledMsgs.add(key);
    while (handledMsgs.size > 2000) handledMsgs.delete(handledMsgs.values().next().value);
    persistHandledFeishuMessages();
    try {
      let commentResult;
      try {
        commentResult = await feishuGetDocComment(fileToken, commentId, fileType);
      } catch (firstError) {
        // 某些文档事件的详情接口会返回 not exist，但评论列表接口能正常返回同一线程。
        // 与 CatClaw 一样，详情失败后列出评论再按 comment_id 定位，不让事件静默丢失。
        if (!/not exist|不存在|not_found/i.test(String(firstError.message || ""))) throw firstError;
        const listed = await feishuListDocComments(fileToken, fileType);
        const item = listed.items.find((entry) => String(entry.comment_id || entry.id) === commentId);
        if (!item) throw firstError;
        commentResult = { data: item, fileType: listed.fileType };
      }
      const comment = commentResult.data;
      const effectiveFileType = commentResult.fileType || fileType;
      const text = feishuCommentPlainText(comment, replyId);
      if (!text) {
        logIm("feishu_doc", "sys", "文档评论没有可执行文本，已忽略", { doc: fileToken });
        return;
      }
      const docText = await feishuGetDocText(fileToken, effectiveFileType);
      const docTitle = feishuDocumentTitle(meta, docText, fileToken);
      // 评论是用户的任务指令；正文属于引用上下文，不能和指令拼成一条普通用户消息。
      // 否则模型很容易把整篇文档当成需要复述的聊天内容，尤其是长文档会直接污染最终回复。
      const docContext = [
        "你正在处理一条飞书云文档评论 @ 任务。",
        `目标文档：${docTitle}`,
        `文档标识：${fileToken}`,
        "处理要求：先判断用户评论要求；文档正文只用于核对事实和决定是否需要更新。不要原样复述、复制或截断回显文档正文。",
        "如果用户要求更新文档，必须实际调用已有文档工具完成修改；如果当前权限或工具不足，要明确说明原因和建议的下一步，不要声称已经更新。",
        docText ? `【文档正文，仅供阅读】\n<feishu_document>\n${docText}\n</feishu_document>` : "【文档正文】读取失败，仅根据评论内容处理。",
      ].join("\n");
      await runInbound({
        channel: "feishu_doc",
        sessionKey: `feishu_doc_${fileToken}`,
        text,
        projectContext: docContext,
        logExtra: { doc: fileToken, docTitle, fileType: effectiveFileType, hasDocText: !!docText },
        reply: (out) => feishuReplyDocComment(fileToken, commentId, effectiveFileType, out),
      });
    } catch (e) {
      logIm("feishu_doc", "error", `处理文档 @ 失败: ${String(e.message || e).slice(0, 200)}`, { doc: fileToken });
      console.error("[飞书文档] 处理 @ 失败:", e.message);
    }
  }

  // ---------- 飞书长连接（WSClient 主动拨出，无需公网地址） ----------

  const ws = { client: null, startedWith: "", error: "" };
  // 缺哪一半就明说哪一半——「未配置」三个字让人只能一个个试
  function feishuMissing() {
    const { app_id, app_secret } = fsCfg();
    const miss = [];
    if (!String(app_id || "").trim()) miss.push("App ID");
    if (!String(app_secret || "").trim()) miss.push("App Secret");
    return miss;
  }
  async function startFeishuWs(force = false) {
    const { app_id, app_secret } = fsCfg();
    const miss = feishuMissing();
    if (miss.length) {
      ws.error = miss.length === 2 ? "还没填 App ID 和 App Secret" : `只填了${miss[0] === "App ID" ? " App Secret" : " App ID"}，还差 ${miss[0]}`;
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
            await handleFeishuMessage(data);
          } catch (e) {
            console.error("[飞书] 处理长连接消息出错:", e.message);
            logIm("feishu", "error", `处理消息出错: ${e.message}`);
          }
        },
        "drive.notice.comment_add_v1": async (data) => {
          try {
            await handleFeishuDocMention(data);
          } catch (e) {
            console.error("[飞书文档] 处理长连接事件出错:", e.message);
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
    onMessage: async ({ chatType, openid, text, attachments, senderName, chatName, reply }) => {
      const saved = [], failed = [];
      for (const a of attachments || []) {
        const kind = /^image\//i.test(a.contentType) ? "image" : /^audio\//i.test(a.contentType) ? "voice" : /^video\//i.test(a.contentType) ? "video" : "file";
        try {
          const { buf, fileName } = await imMedia.fetchBuffer(a.url);
          saved.push({ kind, name: imMedia.saveInbound(getWorkspaceDir(), a.fileName || fileName || imMedia.defaultName("QQ", kind, ""), buf) });
        } catch (e) {
          failed.push({ kind, name: a.fileName || "", why: String(e.message || e).slice(0, 120) });
          logIm("qq", "error", `接收${imMedia.KIND_CN[kind]}失败: ${e.message}`, { chat: chatName || senderName });
        }
      }
      const t = imMedia.inboundNote({ channel: "QQ", saved, failed, text: String(text || "").trim() });
      if (!t) return;
      await runInbound({
        channel: "qq",
        sessionKey: `qq_${chatType}_${openid}`,
        text: t,
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

  // 企微/公众号的非文本消息：以前一句 `msgType !== "text"` 就 return 掉，用户发图发语音
  // 机器人一声不吭。现在按 MediaId 把文件取回来落进工作目录，语音优先用微信自己的识别结果
  const WX_KIND = { image: "image", voice: "voice", video: "video", shortvideo: "video", file: "file" };
  async function wxInboundText(api, msg, channel) {
    const t = String(msg.text || "").trim();
    if (msg.msgType === "text") return t;
    if (msg.msgType === "voice" && String(msg.recognition || "").trim()) return String(msg.recognition).trim();
    const kind = WX_KIND[msg.msgType];
    if (!kind) {
      // 表情包/位置/名片/链接：解析不了也要出声，别让用户对着没反应的机器人干等
      return imMedia.inboundNote({ channel, text: t, failed: [{ kind: "sticker", name: msg.title || "", why: `这类消息（${msg.msgType || "未知"}）我这边解析不了` }] });
    }
    if (!msg.mediaId) return imMedia.inboundNote({ channel, text: t, failed: [{ kind, name: "", why: "这条消息没带 MediaId，取不到文件" }] });
    try {
      const { buf, fileName } = await api.fetchMedia(msg.mediaId);
      const ext = msg.format ? `.${String(msg.format).toLowerCase()}` : "";
      const name = imMedia.saveInbound(getWorkspaceDir(), msg.fileName || fileName || imMedia.defaultName(channel, kind, ext), buf);
      return imMedia.inboundNote({ channel, text: t, saved: [{ kind, name }] });
    } catch (e) {
      logIm(channel === "企业微信" ? "wecom_app" : "wechat_mp", "error", `接收${imMedia.KIND_CN[kind]}失败: ${e.message}`, { chat: msg.fromUser });
      return imMedia.inboundNote({ channel, text: t, failed: [{ kind, name: msg.fileName || "", why: String(e.message || e).slice(0, 120) }] });
    }
  }

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
    if (msg.msgType === "event" || wxDedupe(msg.msgId)) return; // 关注/菜单点击这类事件不是任务
    (async () => {
      const text = await wxInboundText(wecom, msg, "企业微信");
      if (!text) return;
      await runInbound({
        channel: "wecom_app",
        sessionKey: `wecom_${msg.fromUser}`,
        text,
        logExtra: { chat: msg.fromUser },
        reply: (out) => wecom.push(msg.fromUser, out),
        sendFile: (rel) => wecom.sendFile(msg.fromUser, path.join(getWorkspaceDir(), rel), rel.split("/").pop()),
      });
    })().catch((e) => console.error("[企业微信] 任务出错:", e.message));
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
    if (msg.msgType === "event" || wxDedupe(msg.msgId)) return;
    (async () => {
      const text = await wxInboundText(mp, msg, "公众号");
      if (!text) return;
      await runInbound({
        channel: "wechat_mp",
        sessionKey: `mp_${msg.fromUser}`,
        text,
        logExtra: { chat: msg.fromUser },
        reply: (out) => mp.push(msg.fromUser, out),
        sendFile: (rel) => mp.sendFile(msg.fromUser, path.join(getWorkspaceDir(), rel), rel.split("/").pop()),
      });
    })().catch((e) => console.error("[公众号] 任务出错:", e.message));
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

  // ---------- 微信 iLink 机器人（扫码登录 + 长轮询，不需要公网地址） ----------

  const ilink = ilinkApi.createIlinkConnection({
    getConfig: ilinkCfg,
    log: console, // 模块自己已经带 [微信iLink] 前缀了
    // 收消息游标：不落盘的话重启会把已处理的消息再收一遍
    onCursor: (buf) => {
      config.im = config.im || {};
      config.im.wechat_ilink = config.im.wechat_ilink || {};
      config.im.wechat_ilink.get_updates_buf = buf;
      saveConfig();
    },
    // 用户发来的图片/文件/语音：下载解密后落进工作目录，agent 就能直接读它
    downloadMedia: async ({ kind, name, media }) => {
      const buf = await imMedia.downloadWechatCdn(media, { cdnBaseUrl: ilinkCfg().cdn_base_url });
      return imMedia.saveInbound(getWorkspaceDir(), name || imMedia.defaultName("微信", kind, ""), buf);
    },
    onMessage: ({ userId, text, saved, failed }) => {
      const t = imMedia.inboundNote({ channel: "微信", saved, failed, text: String(text || "").trim() });
      if (!t) return;
      return runInbound({
        channel: "wechat_ilink",
        sessionKey: `ilink_${userId}`,
        text: t,
        logExtra: { chat: userId },
        reply: (out) => ilink.send(userId, out),
        // 微信也能收成果文件了（走 CDN 上传），不用再打发用户去工作台下载
        sendFile: (rel) => ilink.sendFile(userId, path.join(getWorkspaceDir(), rel), rel.split("/").pop()),
      });
    },
  });

  async function startIlink(force = false) {
    return ilink.start(force);
  }

  // 扫码登录第一步：取二维码。qrcode_img_content 是条微信深链，必须编成二维码图片才能扫
  router.post("/im/wechat/qrcode", async (_req, res) => {
    try {
      const { qrcode, deepLink } = await ilinkApi.fetchQrcode(ilinkCfg().base_url);
      let dataUrl = "";
      try {
        dataUrl = await require("qrcode").toDataURL(deepLink, { width: 512, margin: 2 });
      } catch (e) {
        console.warn(`[微信iLink] 二维码渲染失败: ${e.message}`);
      }
      res.json({ ok: true, qrcode, image: dataUrl, deep_link: deepLink });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // 第二步：轮询扫码状态。服务端本身是长轮询（最长约 35 秒才回），前端拿到 wait 直接再问一次即可
  router.get("/im/wechat/qrcode-status", async (req, res) => {
    const qrcode = String(req.query.qrcode || "");
    if (!qrcode) return res.status(400).json({ ok: false, error: "缺少 qrcode" });
    try {
      const r = await ilinkApi.pollQrStatus(qrcode, ilinkCfg().base_url);
      if (r.status === "confirmed") {
        config.im = config.im || {};
        // 换了新号就是新会话，旧游标必须清掉，否则拿别人的游标去取更新会直接失效
        config.im.wechat_ilink = {
          bot_token: r.botToken,
          ilink_bot_id: r.ilinkBotId,
          // 服务端可能下发专属 baseurl；没下发就沿用当前这条（扫码就是在它上面完成的）
          base_url: r.baseUrl || ilinkCfg().base_url || ilinkApi.DEFAULT_BASE_URL,
          get_updates_buf: "",
          enabled: true,
        };
        saveConfig();
        await ilink.start(true);
      }
      res.json({ ok: true, status: r.status, ilink: ilink.status() });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  router.post("/im/wechat/disconnect", async (_req, res) => {
    try {
      await ilink.stop();
      config.im = config.im || {};
      config.im.wechat_ilink = { bot_token: "", ilink_bot_id: "", base_url: "", get_updates_buf: "", enabled: false };
      saveConfig();
      res.json({ ok: true, ilink: ilink.status() });
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
      if (body.header?.event_type === "im.message.receive_v1") await handleFeishuMessage(body);
      else if (body.header?.event_type === "drive.notice.comment_add_v1") await handleFeishuDocMention(body);
    } catch (e) {
      console.error("[飞书] 处理事件出错:", e.message);
    }
  });

  // ---------- 状态 / 日志 / 测试 ----------

  router.get("/im/status", (req, res) => {
    const f = fsCfg();
    res.json({
      feishu: { configured: !!(f.app_id && f.app_secret), missing: feishuMissing(), ws: wsStatus() },
      qq: qq.status(),
      wecom_app: wecom.status(),
      wechat_mp: mp.status(),
      wechat_ilink: ilink.status(),
      wecom: { configured: !!imCfg().wecom_bot_webhook },
      dingtalk: { configured: !!imCfg().dingtalk_webhook },
      webhook: { configured: true, secret_set: !!imCfg().webhook_secret },
      smtp: { configured: mailer.configured(smtpCfg()) },
      sessions: { count: sessionCount(req.user) },
    });
  });

  // 上下文管理：IM 那几段会话记了多少、一键全清。只动 IM 通道的上下文，网页会话和长期记忆不碰。
  // 普通成员只数得着、也只清得掉自己那一段——一个人点一下就把全公司的上下文清了，那不叫功能
  router.get("/im/sessions", (req, res) => {
    res.json({ count: sessionCount(req.user) });
  });
  router.post("/im/sessions/clear", (req, res) => {
    if (typeof sessions.clear !== "function") return res.status(400).json({ ok: false, error: "这个会话仓库不支持清空" });
    const boss = seesAll(req.user);
    const mine = localKeyOf(req.user);
    const cleared = boss ? sessions.clear() : sessions.clear((k) => k === mine);
    logIm("system", "in", `已清空 ${cleared} 段 IM 会话上下文`, boss ? {} : { owner: req.user && req.user.username });
    res.json({ ok: true, cleared });
  });

  // 助理页的消息流。以前是 (_req, res) —— 那个下划线就是病根：谁登录进来都能把整本日志读走，
  // 包括别人跟机器人说过的每句话
  router.get("/im/log", (req, res) => res.json(imLog.filter(visibleTo(req.user)).slice(-100).reverse()));
  // 正在执行的任务进度（网页助理页轮询用）。15 分钟没动的当异常残留过滤掉，别吓用户。
  // 「我自己那条」一律回成 local_assist 这个固定键：前端不用知道自己的会话键长什么样，
  // 也就不会因为换了个人而看不到自己的进度
  router.get("/im/progress", (req, res) => {
    const mine = localKeyOf(req.user);
    const boss = seesAll(req.user);
    const out = {};
    for (const [k, v] of liveProgress) {
      if (Date.now() - v.at >= 900000) continue;
      if (k === mine) out.local_assist = v;
      else if (boss && !k.startsWith("local_")) out[k] = v; // 飞书/QQ/webhook 这些服务器级通道
    }
    res.json(out);
  });

  router.post("/im/feishu/test", async (_req, res) => {
    try {
      await getFeishuToken(true);
      let botName = "";
      try {
        botName = (await getFeishuBotInfo(true)).name;
      } catch {}
      const status = await startFeishuWs(true);
      res.json({ ok: true, bot_name: botName, ws: status });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // 只握手、只登录，不发任何一封信。密码错 / 端口错 / 被服务商挡了，都在这一步暴露，
  // 而不是等到半夜 agent 发日报时才炸——那时候没人在电脑前看得到报错
  router.post("/im/smtp/test", async (_req, res) => {
    const cfg = smtpCfg();
    try {
      res.json({ ok: true, ...(await mailer.verify(cfg)) });
    } catch (e) {
      // 报错里可能原样回显了握手内容，抹掉密码再往外递
      res.status(400).json({ ok: false, error: mailer.scrub(cfg, e.message) });
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
    saveSession(sessionKey);

    try {
      const changedNames = new Set();
      const { finalText } = await runtime.runTask({
        history,
        sessionId: sessionKey,
        emit: (ev) => { if (ev.type === "files" && Array.isArray(ev.changed)) for (const n of ev.changed) changedNames.add(n); },
        sec: imSec(),
      });
      saveSession(sessionKey);
      const files = outputFiles().filter((f) => changedNames.has(f.name)); // 本次任务的产出（以前是把根目录整个抖出去）
      const reply = callout.strip(finalText || ""); // webhook 那头不渲染 markdown，记号得先换成文字
      logIm("webhook", "out", reply || "(空回复)", { session: session || "default" });
      res.json({ reply, files });
      // 群机器人推送排在回复之后，而且自己兜住。以前这儿调的是一个根本不存在的 pushWecom：
      // 任务明明跑成了，每次都抛 ReferenceError 掉进下面的 catch 回 500，回复本身也跟着丢了。
      // 推送只是顺带的通知——挂了记一笔就行，不许把做成的任务说成失败，也不让调用方干等它（单通道最长 15 秒）。
      // 回复已经发出去了，这里再抛就会掉进下面那个 catch 二次写响应头，所以必须就地接住
      try {
        await pushBots(`【OpenWorkBuddy·任务完成】\n任务：${String(message).slice(0, 80)}\n${reply.slice(0, 500)}`);
      } catch (pe) {
        const why = String((pe && pe.message) || pe).slice(0, 300);
        console.warn("[webhook] 任务完成推送失败:", why);
        logIm("webhook", "error", `任务完成推送失败: ${why}`, { session: session || "default" });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 助理页里直接对话：走「local」通道，与 IM 消息同一份日志、同一套会话闲置重置逻辑。
  // 不在 PUBLIC_IM 名单里，天然要求已登录，不存在被公网白嫖执行任务的口子。
  router.post("/im/local", async (req, res) => {
    const message = String((req.body || {}).message || "").trim();
    if (!message) return res.status(400).json({ error: "缺少 message" });
    const modelName = String((req.body || {}).model || "").trim() || undefined; // 助理页模型选择器选的那个
    const me = (req.user && req.user.username) || "";
    logIm("local", "in", message, { owner: me });
    // 以前这里写死 "local_assist"：一台服务器上所有人共用一段上下文，A 问完 B 接着问，
    // 接的是 A 的话头；而且它落盘成同一个文件，重启也甩不掉。一人一段
    const sessionKey = localKeyOf(req.user);
    maybeResetIdleSession(sessionKey, "local");
    if (!sessions.has(sessionKey)) sessions.set(sessionKey, []);
    const history = sessions.get(sessionKey);
    history.push({ role: "user", content: message });
    saveSession(sessionKey);
    try {
      const progState = { step: 0 };
      const { finalText } = await runtime.runTask({
        history,
        sessionId: sessionKey,
        modelName,
        // 谁在助理页里说话，就用谁的长期记忆、把 remember 写回谁名下、审批卡也弹在谁的屏幕上。
        // 不带这个参数的话，成员跑出来的任务顶着管理员的身份，记忆串到别人那儿去
        user: me || undefined,
        emit: (ev) => { const line = progressLine(ev, progState); if (line) liveProgress.set(sessionKey, { text: line, channel: "local", at: Date.now() }); },
      });
      saveSession(sessionKey);
      logIm("local", "out", finalText || "(空回复)", { owner: me });
      res.json({ reply: finalText });
    } catch (e) {
      logIm("local", "error", e.message, { owner: me });
      res.status(500).json({ error: e.message });
    } finally {
      liveProgress.delete(sessionKey);
    }
  });

  return { router, startFeishuWs, startQQ, startIlink };
}

module.exports = { createImRouter, unwrapFeishuInbound, feishuDedupeKeys };
