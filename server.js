"use strict";
/**
 * OpenWorkBuddy — 服务器主入口。
 * 功能：Web 工作台（SSE 流式）、技能系统、MCP 连接器、专家团多智能体、IM 远程指挥（飞书/企业微信/通用 Webhook）。
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { createLLM } = require("./llm");
const { outputFiles, safePath, getWorkspaceDir, setWorkspaceDir, SEARCH_PROVIDERS, searchProviderKey, shellPath } = require("./tools");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const { createImRouter } = require("./im");
const { createScheduler } = require("./scheduler");
const account = require("./account");
const security = require("./security");
const notify = require("./notify");
const store = require("./store");
const { createImSessionStore } = require("./im-store");

// config.json 不入 git（可能含 API Key）；首次运行自动从模板复制
const CONFIG_PATH = path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(path.join(__dirname, "config.example.json"), CONFIG_PATH);
  console.log("已从 config.example.json 生成 config.json，请填入你的模型 API Key");
}
// 配置读坏了不能就这么空着起来：那样界面上所有 Key 都变成空的，用户随手一保存就把
// 真 Key 覆盖没了。store 会先拿 .bak 顶（Key 原样还在），实在顶不住才把坏文件改名隔离、
// 退回模板——原文还在 .corrupt-时间戳 里，Key 捞得回来。
const config = store.readJson(CONFIG_PATH, JSON.parse(fs.readFileSync(path.join(__dirname, "config.example.json"), "utf8")));

// 旧配置迁移：生成 models 列表（内置国产模型预设 + 自定义），active_model 指定当前使用
if (!Array.isArray(config.models) || !config.models.length) {
  const old = config.openai || {};
  config.models = [
    { name: "DeepSeek", provider: "openai", base_url: "https://api.deepseek.com/v1", api_key: old.base_url?.includes("deepseek") ? old.api_key || "" : "", model: "deepseek-chat" },
    { name: "通义Qwen", provider: "openai", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", api_key: "", model: "qwen-max" },
    { name: "智谱GLM", provider: "openai", base_url: "https://open.bigmodel.cn/api/paas/v4", api_key: "", model: "glm-4-plus" },
    { name: "Kimi", provider: "openai", base_url: "https://api.moonshot.cn/v1", api_key: "", model: "moonshot-v1-32k" },
    { name: "Ollama本地", provider: "openai", base_url: "http://localhost:11434/v1", api_key: "", model: "qwen3:14b" },
  ];
  config.active_model = "DeepSeek";
  saveConfig();
}

security.getSecurity(config); // 补齐安全中心默认策略
config.shortcuts = config.shortcuts || {}; // 快捷键自定义绑定（只存改过的项，默认值在前端定义）
// 助理的名字和头像：想叫它「小秘」就叫「小秘」。界面（气泡头像/侧栏/品牌位）和系统提示词都跟着这里走
const ASSISTANT_DEFAULT = { name: "OpenWorkBuddy", avatar: "🤖" };
config.assistant = { ...ASSISTANT_DEFAULT, ...(config.assistant || {}) };

if (config.workspace_dir) {
  try {
    setWorkspaceDir(config.workspace_dir);
  } catch (e) {
    console.warn("workspace_dir 无效，使用默认工作空间:", e.message);
  }
}
let llmInner = createLLM(config);
// 可热替换的 LLM 包装：设置修改后 runtime 无需重建
const llm = {
  get provider() { return llmInner.provider; },
  get model() { return llmInner.model; },
  chat: (args) => llmInner.chat(args),
};
// 专家团：数组引用被 runtime 闭包持有，增删改都就地改这个数组（热生效，无需重启）
const EXPERTS_FILE = path.join(__dirname, "experts.json");
const experts = [];
const expertTeams = []; // 专家团 = 智能体团队，同样是被 runtime 闭包持有的活引用
let expertsMeta = store.readJson(EXPERTS_FILE, {}) || {};
experts.push(...(expertsMeta.experts || []));
expertTeams.push(...(expertsMeta.teams || []));
function saveExperts() {
  store.writeJsonAtomic(EXPERTS_FILE, { ...expertsMeta, experts, teams: expertTeams }, { pretty: true });
}
const mcpManager = new McpManager();
let imBridge = null; // IM 桥（含飞书长连接控制），init() 里创建

// ---------- 会话持久化：内存 + 磁盘（data/sessions/<id>.json） ----------
// 结构：{ history: 统一格式历史(供LLM), transcript: 界面回放记录, title, updated_at }
const SESS_DIR = path.join(__dirname, "data", "sessions");
const sessions = new Map();
const activeRuns = new Map(); // sessionId -> { ctrl: AbortController, interject: [] }（「停止」与「插队」用）

function sessFile(id) {
  return path.join(SESS_DIR, id.replace(/[^\w-]/g, "_") + ".json");
}
function getSession(id) {
  if (!sessions.has(id)) {
    // 会话文件坏了不抛错（不能因为一条对话打不开就让整个工作台起不来），
    // 但也绝不装作没有过这条对话：store 会先拿 .bak 顶上，实在不行把坏文件改名隔离
    const data = store.readJson(sessFile(id), { history: [], transcript: [], title: "", updated_at: null });
    sessions.set(id, data);
  }
  return sessions.get(id);
}
function saveSession(id) {
  const s = sessions.get(id);
  if (!s || !s.history) return;
  s.updated_at = new Date().toISOString();
  store.writeJsonAtomic(sessFile(id), s);
}

// 任务跑一半崩了 / 用户直接退出 App，这一轮的过程就全没了——中途也存，最多每 5 秒一次。
// 存的是同一份对象，落盘又是原子改名，跟收尾时那次 saveSession 不会打架。
const sessSaveAt = new Map();
function autosaveSession(id, minGapMs = 5000) {
  const now = Date.now();
  if (now - (sessSaveAt.get(id) || 0) < minGapMs) return;
  sessSaveAt.set(id, now);
  try {
    saveSession(id);
  } catch (e) {
    console.warn(`[会话] 中途存盘失败（${id}）：${e.message}`);
  }
}

// IM 会话跟网页会话分开存（data/im-sessions/<键>.json），重启不丢上下文
const imSessions = createImSessionStore({ dir: path.join(__dirname, "data", "im-sessions") });

/** 包装 emit：把事件同时记录到 transcript（文本增量合并，跳过噪音事件），顺便中途存盘 */
function recordingEmit(send, events, sessionId) {
  return (ev) => {
    send(ev);
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      const last = events[events.length - 1];
      if (last && last.type === "text") last.delta += ev.delta;
      else events.push({ type: "text", delta: ev.delta });
    } else if (["tool_use", "tool_result", "parallel", "expert_start", "expert_done", "error", "limit", "trim", "usage", "interject", "credits", "sources"].includes(ev.type)) {
      events.push(ev);
      // 一步走完就是个存盘点：跑了半小时的任务不该因为一次崩溃从头再来
      if (sessionId && ev.type === "tool_result") autosaveSession(sessionId);
    }
  };
}

const app = express();
app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(__dirname, "public")));
// /api/auth/* /api/usage /api/credits/*
app.use(
  account.createRouter({
    // 账号改了登录名，历史会话的归属得跟着走，不然那些任务就成了没主的（列表里直接消失）。
    // 内存和磁盘两头都要改：只改盘上的，下一次 saveSession 会拿内存里的旧名字盖回去。
    onRename: (from, to) => {
      for (const s of sessions.values()) if (s && s.user === from) s.user = to;
      let files = 0;
      for (const f of fs.existsSync(SESS_DIR) ? fs.readdirSync(SESS_DIR) : []) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(SESS_DIR, f);
        const s = store.readJson(p, null);
        if (s && s.user === from) {
          s.user = to;
          store.writeJsonAtomic(p, s);
          files++;
        }
      }
      console.log(`[账号] 登录名 ${from} → ${to}，${files} 条会话的归属已迁移`);
    },
  })
);
app.use(account.authGuard); // 其余 /api/* 与 /im/*（除外部回调）需要登录

let runtime; // MCP 启动后创建

app.get("/api/info", (_req, res) => {
  res.json({
    provider: llm.provider,
    model: llm.model,
    skills: runtime ? runtime.getSkills().map((s) => s.name) : [],
    experts: experts.map((e) => e.name),
    mcp_tools: mcpManager.toolDefs().length,
    agent_plugins_spec: require("./plugins").SPEC_VERSION,
  });
});

app.get("/api/files", (_req, res) => res.json(outputFiles()));

// 助理身份：界面一进来就要拿它画头像，所以单开一个轻接口，不用为了个名字去拉整份设置
app.get("/api/assistant", (_req, res) => res.json(config.assistant));

// ---------- 应用内设置（模型 + IM），保存到 config.json 并热生效 ----------
app.get("/api/settings", (_req, res) => {
  res.json({
    workspace_dir: getWorkspaceDir(),
    models: config.models,
    active_model: config.active_model,
    agent: {
      max_steps: config.agent.max_steps,
      tool_timeout_ms: config.agent.tool_timeout_ms,
      max_runtime_ms: config.agent.max_runtime_ms || 1800000,
      llm_timeout_ms: config.agent.llm_timeout_ms || 300000,
      max_context_chars: config.agent.max_context_chars || 120000,
    },
    persona: config.persona || "",
    assistant: config.assistant,
    search: {
      provider: (config.search || {}).provider || "jina",
      jina_key: (config.search || {}).jina_key || (config.search || {}).api_key || "",
      tavily_key: (config.search || {}).tavily_key || "",
      brave_key: (config.search || {}).brave_key || "",
    },
    im: {
      feishu: (config.im || {}).feishu || { app_id: "", app_secret: "", verification_token: "" },
      qq: (config.im || {}).qq || { app_id: "", app_secret: "" },
      wecom_app: (config.im || {}).wecom_app || { corp_id: "", agent_id: "", secret: "", token: "", aes_key: "" },
      wechat_mp: (config.im || {}).wechat_mp || { app_id: "", app_secret: "", token: "", aes_key: "" },
      // iLink 的 bot_token 是扫码换来的长期凭证，不回给前端（前端只需要知道连没连上，状态走 /im/status）
      wechat_ilink: { bot_id: ((config.im || {}).wechat_ilink || {}).ilink_bot_id || "" },
      wecom_bot_webhook: (config.im || {}).wecom_bot_webhook || "",
      dingtalk_webhook: (config.im || {}).dingtalk_webhook || "",
      dingtalk_secret: (config.im || {}).dingtalk_secret || "",
      webhook_secret: (config.im || {}).webhook_secret || "",
      session_idle_hours: +(config.im || {}).session_idle_hours || 0,
    },
    media: {
      image: { base_url: "", api_key: "", model: "", ...((config.media || {}).image || {}) },
      video: { base_url: "", api_key: "", model: "", ...((config.media || {}).video || {}) },
    },
    security: config.security,
    shortcuts: config.shortcuts,
  });
});

app.post("/api/settings", (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.models)) {
      for (const m of b.models) {
        if (!m.name || !m.model) throw new Error("每个模型需要 name 和 model 字段");
        m.provider = m.provider === "anthropic" ? "anthropic" : "openai";
      }
      config.models = b.models;
    }
    if (b.active_model !== undefined) {
      if (!config.models.some((m) => m.name === b.active_model)) throw new Error("active_model 不在模型列表中");
      config.active_model = b.active_model;
    }
    if (b.agent) {
      if (b.agent.max_steps) config.agent.max_steps = Math.max(1, Math.min(100, +b.agent.max_steps));
      if (b.agent.tool_timeout_ms) config.agent.tool_timeout_ms = Math.max(5000, +b.agent.tool_timeout_ms);
      if (b.agent.max_runtime_ms) config.agent.max_runtime_ms = Math.max(60000, +b.agent.max_runtime_ms);
      if (b.agent.llm_timeout_ms) config.agent.llm_timeout_ms = Math.max(30000, +b.agent.llm_timeout_ms);
      // 下限 2 万字符：再小连最近几步的工具原文都留不住，agent 会失忆式反复重做
      if (b.agent.max_context_chars) config.agent.max_context_chars = Math.max(20000, Math.min(2000000, +b.agent.max_context_chars));
    }
    if (b.persona !== undefined) config.persona = String(b.persona).slice(0, 4000);
    if (b.assistant) {
      if (b.assistant.name !== undefined) {
        const n = String(b.assistant.name).replace(/\s+/g, " ").trim();
        if (n.length > 24) throw new Error("助理名字最多 24 个字");
        config.assistant.name = n || ASSISTANT_DEFAULT.name; // 清空就退回默认，别让它变成没名字的空气
      }
      // 头像的校验规则和用户头像完全一样（emoji 或 ≤256KB 的 data URI），共用一处免得两边规则跑偏
      if (b.assistant.avatar !== undefined) config.assistant.avatar = account._internals.normalizeAvatar(b.assistant.avatar) || ASSISTANT_DEFAULT.avatar;
    }
    if (b.search) {
      config.search = config.search || {};
      if (b.search.provider !== undefined) {
        if (!["jina", "tavily", "brave"].includes(b.search.provider)) throw new Error("搜索 provider 仅支持 jina / tavily / brave");
        config.search.provider = b.search.provider;
      }
      for (const k of ["jina_key", "tavily_key", "brave_key"]) {
        if (b.search[k] !== undefined) config.search[k] = String(b.search[k]).trim();
      }
    }
    if (b.workspace_dir !== undefined && b.workspace_dir !== getWorkspaceDir()) {
      config.workspace_dir = setWorkspaceDir(b.workspace_dir);
      // 工作空间即当前项目的目录：手动改路径时同步到当前项目，保持两处一致
      ensureProjects();
      const ap = config.projects.find((p) => p.name === config.active_project);
      if (ap) ap.dir = config.workspace_dir;
    }
    config.im = config.im || {};
    if (b.im) {
      if (b.im.feishu) Object.assign((config.im.feishu = config.im.feishu || {}), pick(b.im.feishu, ["app_id", "app_secret", "verification_token", "doc_app_id", "doc_app_secret"]));
      if (b.im.qq) Object.assign((config.im.qq = config.im.qq || {}), pick(b.im.qq, ["app_id", "app_secret"]));
      if (b.im.wecom_app) Object.assign((config.im.wecom_app = config.im.wecom_app || {}), pick(b.im.wecom_app, ["corp_id", "agent_id", "secret", "token", "aes_key"]));
      if (b.im.wechat_mp) Object.assign((config.im.wechat_mp = config.im.wechat_mp || {}), pick(b.im.wechat_mp, ["app_id", "app_secret", "token", "aes_key"]));
      if (b.im.wecom_bot_webhook !== undefined) config.im.wecom_bot_webhook = b.im.wecom_bot_webhook;
      if (b.im.dingtalk_webhook !== undefined) config.im.dingtalk_webhook = String(b.im.dingtalk_webhook).trim();
      if (b.im.dingtalk_secret !== undefined) config.im.dingtalk_secret = String(b.im.dingtalk_secret).trim();
      if (b.im.webhook_secret !== undefined) config.im.webhook_secret = b.im.webhook_secret;
      if (b.im.session_idle_hours !== undefined) config.im.session_idle_hours = Math.max(0, Math.min(720, +b.im.session_idle_hours || 0));
    }
    if (b.media) {
      config.media = config.media || {};
      for (const kind of ["image", "video"]) {
        if (b.media[kind]) {
          const c = (config.media[kind] = config.media[kind] || {});
          for (const k of ["base_url", "api_key", "model"]) {
            if (b.media[kind][k] !== undefined) c[k] = String(b.media[kind][k]).trim();
          }
        }
      }
    }
    if (b.security) {
      const sec = security.getSecurity(config);
      for (const k of ["gateway", "delete_protect", "runtime_node", "runtime_python"]) {
        if (typeof b.security[k] === "boolean") sec[k] = b.security[k];
      }
      for (const k of ["batch_delete_threshold", "approval_timeout_s"]) {
        if (b.security[k] !== undefined) sec[k] = Math.max(1, +b.security[k] || security.DEFAULTS[k]);
      }
      for (const k of ["file_whitelist", "file_blacklist", "cmd_allow", "cmd_ask", "url_whitelist", "url_blacklist"]) {
        if (Array.isArray(b.security[k])) sec[k] = b.security[k].map((s) => String(s)).filter((s) => s.trim()).slice(0, 100);
      }
    }
    if (b.shortcuts && typeof b.shortcuts === "object") {
      config.shortcuts = {};
      for (const [k, v] of Object.entries(b.shortcuts)) {
        if (typeof v === "string" && v.length < 60) config.shortcuts[k] = v;
      }
      if (global.__wbRegisterShortcuts) global.__wbRegisterShortcuts(config.shortcuts); // 桌面版重注册全局快捷键
    }
    llmInner = createLLM(config); // 模型热切换
    saveConfig();
    if (b.im && b.im.feishu && imBridge) {
      imBridge.startFeishuWs(true).catch((e) => console.warn("[飞书] 长连接重启失败:", e.message)); // 飞书配置变更后重建长连接
    }
    if (b.im && b.im.qq && imBridge) {
      imBridge.startQQ(true).catch((e) => console.warn("[QQ] 长连接重启失败:", e.message));
    }
    res.json({ ok: true, provider: llm.provider, model: llm.model });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 首次开箱引导：没有 API Key 时，什么都干不了，得先把这一步走完 ----------
// 只回布尔值，绝不把 key 原文吐给前端（设置页要改 key 走 /api/settings）
function isLocalModel(m) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(m.base_url || "");
}
function hasKey(m) {
  return isLocalModel(m) || !!String(m.api_key || "").trim();
}

/** 发一条最小的真实请求验活。返回 null = 通过，返回字符串 = 人话版失败原因。
 *  刻意不走 createLLM：它会把工具 schema 一起发过去，这里只想知道"这个 key 认不认"。 */
async function probeModel(m) {
  const anthropic = m.provider === "anthropic";
  const base = (m.base_url || (anthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1")).replace(/\/$/, "");
  const url = anthropic ? `${base}/messages` : `${base}/chat/completions`;
  const headers = anthropic
    ? { "Content-Type": "application/json", "x-api-key": m.api_key || "", "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${m.api_key || "ollama"}` };
  const body = anthropic
    ? { model: m.model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }
    : { model: m.model, max_tokens: 8, stream: false, messages: [{ role: "user", content: "ping" }] };
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (r.ok) return null;
    const txt = (await r.text()).slice(0, 300);
    if (r.status === 401 || r.status === 403) return "这个 Key 上游不认（HTTP " + r.status + "），检查有没有复制全、是不是这家服务商的 Key";
    if (r.status === 402) return "Key 有效但余额不足 / 未开通付费，去服务商控制台充值后再试";
    if (r.status === 404) return `模型名「${m.model}」在这家服务商不存在（HTTP 404），去 设置 → 模型 改成它支持的名字`;
    if (r.status === 429) return "被限流了（429），等一会儿再试，或换个渠道";
    return `上游返回 HTTP ${r.status}：${txt}`;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/timeout|abort/i.test(msg)) return "连不上（30 秒超时）。国外服务商在国内直连经常打不通，挂代理或换国产渠道";
    return "连不上：" + msg.slice(0, 200);
  }
}

app.get("/api/onboarding", (_req, res) => {
  const models = (config.models || []).map((m) => ({
    name: m.name,
    model: m.model,
    base_url: m.base_url || "",
    local: isLocalModel(m),
    has_key: hasKey(m),
  }));
  const active = (config.models || []).find((m) => m.name === config.active_model) || (config.models || [])[0];
  res.json({
    // 当前选中的模型没 key = 一句话都发不出去，必须弹引导
    needs_setup: !active || !hasKey(active),
    active_model: config.active_model,
    workspace_dir: getWorkspaceDir(),
    models,
    any_key: models.some((m) => m.has_key && !m.local),
    search: { provider: (config.search || {}).provider || "jina", has_key: !!searchProviderKey(config.search || {}, (config.search || {}).provider || "jina") },
  });
});

// 填 key → 真发一条最小请求验活 → 通过才落盘。不验就存等于把坑留到用户第一次提问时才炸
app.post("/api/onboarding", async (req, res) => {
  try {
    const b = req.body || {};
    const entry = (config.models || []).find((m) => m.name === b.model);
    if (!entry) throw new Error("没有这个模型：" + b.model);
    const key = String(b.api_key || "").trim();
    if (!key && !isLocalModel(entry)) throw new Error("API Key 不能为空");

    if (b.skip_test !== true) {
      const bad = await probeModel({ ...entry, api_key: key || entry.api_key });
      if (bad) return res.json({ ok: false, error: bad });
    }

    if (key) entry.api_key = key;
    config.active_model = entry.name;
    if (b.workspace_dir) {
      config.workspace_dir = setWorkspaceDir(b.workspace_dir);
      ensureProjects();
      const ap = config.projects.find((p) => p.name === config.active_project);
      if (ap) ap.dir = config.workspace_dir;
    }
    llmInner = createLLM(config);
    saveConfig();
    res.json({ ok: true, active_model: config.active_model, model: llm.model, workspace_dir: getWorkspaceDir() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 直连所配搜索服务商测活（不走 DDG 回退，测的就是这家 key 能不能用）
app.get("/api/search/test", async (_req, res) => {
  try {
    const cfg = config.search || {};
    const provider = (cfg.provider || "jina").toLowerCase();
    const fn = SEARCH_PROVIDERS[provider];
    if (!fn) return res.json({ ok: false, error: `未知 provider: ${provider}` });
    const key = searchProviderKey(cfg, provider);
    if (!key) return res.json({ ok: false, error: `${provider} 未填 API Key` });
    const items = await fn(key, "OpenAI", 3);
    if (!items.length) return res.json({ ok: false, error: `${provider} 返回 0 条结果` });
    res.json({ ok: true, provider, sample: (items[0].title || items[0].url || "").slice(0, 60) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------- 安全中心：审计 / 审批 / 系统授权 ----------
app.get("/api/security/audit", (req, res) => res.json(security.auditList(Math.min(1000, +req.query.limit || 100))));
app.post("/api/security/audit/clear", (_req, res) => {
  security.auditClear();
  res.json({ ok: true });
});
app.get("/api/security/audit/export", (_req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="openworkbuddy-audit-${new Date().toISOString().slice(0, 10)}.log"`);
  res.send(security.auditExport());
});
app.get("/api/security/approvals", (_req, res) => res.json(security.listApprovals()));
app.post("/api/security/approvals/:id", (req, res) => {
  res.json({ ok: security.resolveApproval(req.params.id, !!(req.body || {}).allow) });
});
app.get("/api/security/system", (_req, res) => {
  res.json({
    platform: process.platform,
    desktop: !!process.versions.electron,
    fulldisk: security.checkFullDisk(),
    accessibility: security.checkAccessibility(),
    automation: "unchecked", // 主动探测会触发系统弹窗，改为用户点「检测/授权」时才查
  });
});
app.post("/api/security/system/check-automation", async (_req, res) => {
  res.json({ automation: await security.checkAutomation() });
});
app.post("/api/security/system/open", (req, res) => {
  res.json({ ok: security.openPrefPane((req.body || {}).pane) });
});
// 桌面版窗口全屏切换（Web 版由前端 requestFullscreen 兜底）
app.post("/api/app/fullscreen", (_req, res) => {
  if (global.__wbWin) {
    try {
      global.__wbWin.setFullScreen(!global.__wbWin.isFullScreen());
      return res.json({ ok: true });
    } catch {}
  }
  res.json({ ok: false });
});

// 检查更新：项目是 git 仓库且配了远程时真实比对，否则如实说明（不装样子）
app.post("/api/app/update-check", (_req, res) => {
  const version = (() => { try { return require("./package.json").version; } catch { return "?"; } })();
  const { spawnSync } = require("child_process");
  const git = (...args) => spawnSync("git", args, { cwd: __dirname, encoding: "utf8", timeout: 30000 });
  if (git("rev-parse", "--is-inside-work-tree").status !== 0) {
    return res.json({ ok: false, version, reason: "本地部署版未配置更新源（项目还不是 git 仓库）" });
  }
  if (!String(git("remote").stdout || "").trim()) {
    return res.json({ ok: false, version, reason: "未配置远程仓库（git remote），无法在线检查更新" });
  }
  const f = git("fetch", "--quiet");
  if (f.status !== 0) return res.json({ ok: false, version, reason: "拉取远程失败：" + String(f.stderr || "").trim().slice(0, 120) });
  const behind = git("rev-list", "--count", "HEAD..@{upstream}");
  if (behind.status !== 0) return res.json({ ok: false, version, reason: "当前分支未设置上游分支（git branch -u）" });
  res.json({ ok: true, version, behind: parseInt(behind.stdout, 10) || 0 });
});

// ---------- MCP 连接器管理 ----------
app.get("/api/mcp", (_req, res) => {
  const view = (s, plugin) => {
    const client = mcpManager.clients.get(s.name);
    const failure = mcpManager.failures.find((f) => f.name === s.name);
    return {
      name: s.name,
      command: s.command || "",
      args: s.args || [],
      env: s.env || {},
      url: s.url || "",
      // 请求头里常有 token，界面上只说有几个，不回传值
      header_keys: Object.keys(s.headers || {}),
      transport: s.transport || (s.command ? "stdio" : "streamable-http"),
      plugin, // 插件带来的：界面上只读，不许当成 config 里的条目存回去
      error: failure ? failure.error : "",
      connected: !!client,
      tools: client ? client.tools.map((t) => ({ name: t.name, description: (t.description || "").slice(0, 200) })) : [],
    };
  };
  // config.json 里配的 + 插件 mcp.json 里声明的，一起列出来，
  // 否则「已注入 N 个工具」的 N 里有一半找不到对应的卡片，用户以为是幻觉。
  let fromPlugins = [];
  try { fromPlugins = pluginsMgr.pluginMcpServers(); } catch { /* 插件坏了不该让连接器页打不开 */ }
  const servers = (config.mcp_servers || []).map((s) => view(s, ""))
    .concat(fromPlugins.map((s) => view(s, s.plugin)));
  res.json({ servers, total_tools: mcpManager.toolDefs().length });
});

/** 一条连接器配置规整成后端认的形状；stdio 看 command，远程看 url */
function normalizeMcpServer(s, i, prevByName = new Map()) {
  const at = `第 ${i + 1} 个连接器`;
  const name = String(s.name || "").trim();
  if (!name) throw new Error(`${at}缺少 name`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`${at}的 name「${name}」只能用字母、数字、- 和 _（工具名要按 mcp__服务器__工具 拼）`);
  const url = String(s.url || "").trim();
  const command = String(s.command || "").trim();
  if (!command && !url) throw new Error(`${at}要么填 command（本地进程），要么填 url（远程 Streamable HTTP）`);
  if (url) {
    let u;
    try { u = new URL(url); } catch { throw new Error(`${at}的 url 不是合法地址：${url}`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${at}的 url 只支持 http/https`);
    // 请求头里多半是 Authorization，GET 只回 header_keys 不回值；
    // 前端原样存回来时没带 headers，就沿用原来那份，别把令牌洗没了。
    const prev = prevByName.get(name);
    const headers = s.headers && typeof s.headers === "object"
      ? Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [String(k), String(v)]))
      : (prev && prev.headers) || {};
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
    if (Object.keys(headers).length && u.protocol === "http:" && !local) {
      throw new Error(`${at}带了请求头（多半是令牌）却走明文 http，令牌会在路上被看光——请改成 https`);
    }
    return { name, transport: "streamable-http", url, headers };
  }
  return {
    name,
    transport: "stdio",
    command,
    args: Array.isArray(s.args) ? s.args.map(String) : [],
    env: s.env && typeof s.env === "object" ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [String(k), String(v)])) : {},
  };
}

app.post("/api/mcp", async (req, res) => {
  try {
    const list = (req.body || {}).servers;
    if (!Array.isArray(list)) throw new Error("需要 servers 数组");
    const prevByName = new Map((config.mcp_servers || []).map((s) => [s.name, s]));
    const next = list.map((s, i) => normalizeMcpServer(s, i, prevByName));
    const dup = next.map((s) => s.name).find((n, i, a) => a.indexOf(n) !== i);
    if (dup) throw new Error(`连接器名字重复：${dup}`);

    config.mcp_servers = next;
    saveConfig();

    // 插件带来的服务器也要一起重启：只重启 config 里的会把插件连接器整批打没，
    // 而它们不在 config 里，重启前根本救不回来（旧版就是这个 bug）。
    let fromPlugins = [];
    try { fromPlugins = pluginsMgr.pluginMcpServers(); } catch { /* 插件坏了不该拖累连接器保存 */ }
    const servers = [...config.mcp_servers, ...fromPlugins];
    mcpManager.stop([...mcpManager.clients.keys(), ...mcpManager.failures.map((f) => f.name), ...servers.map((s) => s.name)]);
    await mcpManager.startAll(servers); // 失败的单独在日志告警，不阻塞其他
    res.json({
      ok: true,
      total_tools: mcpManager.toolDefs().length,
      connected: [...mcpManager.clients.keys()],
      failures: mcpManager.failures,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 项目（多工作空间，仿官方「项目」：每个项目一个独立工作目录，成果互不混淆） ----------
function ensureProjects() {
  if (!Array.isArray(config.projects) || !config.projects.length) {
    config.projects = [{ name: "默认项目", dir: getWorkspaceDir() }];
    config.active_project = "默认项目";
  }
  if (!config.projects.some((p) => p.name === config.active_project)) config.active_project = config.projects[0].name;
}
/**
 * config.json 是唯一一份存着所有 API Key 的文件，还不入 git——写坏了就是全丢。
 * 所以全应用只留这一个写入口，走原子改名 + .bak。
 */
function saveConfig() {
  store.writeJsonAtomic(CONFIG_PATH, config, { pretty: true });
}

app.get("/api/projects", (_req, res) => {
  ensureProjects();
  res.json({ projects: config.projects, active: config.active_project });
});

app.post("/api/projects", (req, res) => {
  try {
    ensureProjects();
    const name = String((req.body || {}).name || "").trim();
    if (!name) throw new Error("缺少项目名");
    if (name.length > 30) throw new Error("项目名太长（最多 30 字）");
    if (config.projects.some((p) => p.name === name)) throw new Error("同名项目已存在");
    let dir = String((req.body || {}).dir || "").trim();
    if (!dir) dir = path.join(__dirname, "projects", name.replace(/[/\\:*?"<>|]/g, "_"));
    const real = setWorkspaceDir(dir); // 建目录并切换过去
    config.projects.push({ name, dir: real });
    config.active_project = name;
    config.workspace_dir = real;
    saveConfig();
    res.json({ ok: true, projects: config.projects, active: name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/projects/switch", (req, res) => {
  try {
    ensureProjects();
    const p = config.projects.find((x) => x.name === (req.body || {}).name);
    if (!p) return res.status(404).json({ error: "项目不存在" });
    config.workspace_dir = setWorkspaceDir(p.dir);
    config.active_project = p.name;
    saveConfig();
    res.json({ ok: true, active: p.name, dir: p.dir });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 只从列表移除，不删磁盘文件
app.delete("/api/projects/:name", (req, res) => {
  ensureProjects();
  if (config.projects.length <= 1) return res.status(400).json({ error: "至少保留一个项目" });
  const i = config.projects.findIndex((p) => p.name === req.params.name);
  if (i < 0) return res.status(404).json({ error: "项目不存在" });
  config.projects.splice(i, 1);
  if (config.active_project === req.params.name) {
    const p0 = config.projects[0];
    config.active_project = p0.name;
    try {
      config.workspace_dir = setWorkspaceDir(p0.dir);
    } catch {}
  }
  saveConfig();
  res.json({ ok: true, projects: config.projects, active: config.active_project });
});

// ---------- 资料库·灵感（跨项目共享：参考文件 + 灵感笔记，agent 可用 library_* 工具读取） ----------
const LIB_DIR = path.join(__dirname, "data", "library");
const NOTES_FILE = path.join(__dirname, "data", "inspirations.json");
function readNotes() {
  const list = store.readJson(NOTES_FILE, []);
  return Array.isArray(list) ? list : [];
}
function writeNotes(notes) {
  store.writeJsonAtomic(NOTES_FILE, notes, { pretty: true });
}
function libSafe(name) {
  const base = path.basename(String(name || ""));
  if (!base || base.startsWith(".")) throw new Error("文件名不合法");
  return path.join(LIB_DIR, base);
}

app.get("/api/library", (_req, res) => {
  let files = [];
  try {
    files = fs
      .readdirSync(LIB_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => {
        const st = fs.statSync(path.join(LIB_DIR, e.name));
        return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {}
  res.json({ files, notes: readNotes() });
});

app.post("/api/library/upload", (req, res) => {
  try {
    const { name, data_b64 } = req.body || {};
    if (!name || !data_b64) return res.status(400).json({ error: "缺少 name 或 data_b64" });
    fs.mkdirSync(LIB_DIR, { recursive: true });
    fs.writeFileSync(libSafe(name), Buffer.from(data_b64, "base64"));
    res.json({ ok: true, name: path.basename(name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/library/file/:name", (req, res) => {
  try {
    const p = libSafe(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).send("文件不存在");
    res.download(p);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

app.delete("/api/library/file/:name", (req, res) => {
  try {
    fs.rmSync(libSafe(req.params.name), { force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/library/note", (req, res) => {
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "内容为空" });
  const notes = readNotes();
  notes.unshift({ id: "n_" + Date.now() + "_" + Math.floor(Math.random() * 1e4), text: text.slice(0, 2000), at: new Date().toISOString() });
  writeNotes(notes.slice(0, 200));
  res.json({ ok: true });
});

app.delete("/api/library/note/:id", (req, res) => {
  writeNotes(readNotes().filter((n) => n.id !== req.params.id));
  res.json({ ok: true });
});

// ---------- 长期记忆 ----------
const MEMORY_FILE = path.join(__dirname, "data", "memory.md");
app.get("/api/memory", (_req, res) => {
  let content = "";
  try { content = fs.readFileSync(MEMORY_FILE, "utf8"); } catch {}
  res.json({ content });
});
app.post("/api/memory", (req, res) => {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, String((req.body || {}).content || ""), "utf8");
  res.json({ ok: true });
});

// ---------- 工作空间：原生文件夹选择（桌面版）与打开文件夹 ----------
app.post("/api/pick-folder", async (_req, res) => {
  try {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "选择工作空间文件夹" });
    if (result.canceled || !result.filePaths.length) return res.json({ canceled: true });
    res.json({ path: result.filePaths[0] });
  } catch {
    res.status(501).json({ error: "仅桌面版支持系统文件夹选择，Web 版请直接输入路径" });
  }
});
/** 用系统程序打开文件/文件夹（跨平台：macOS open / Windows explorer / Linux xdg-open） */
function openWithSystem(target) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  require("child_process").exec(`${opener} "${target}"`);
}
app.post("/api/open-workspace", (_req, res) => {
  openWithSystem(getWorkspaceDir());
  res.json({ ok: true });
});

// ================= 飞书：扫码授权（借本机 lark-cli 的设备码流程，larksuite/cli，MIT） =================
// 说明一句免得误解：机器人「收消息」必须有应用的 app_id + app_secret，这是飞书的设计，扫码替代不了。
// 扫码解决的是另一半——把「你本人」的身份授权出来，之后读日历/文档/邮件是以你的身份调的。
const LARK_TMP = path.join(require("os").tmpdir(), "openworkbuddy-lark");
function larkRun(args, { timeout = 60000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = require("child_process").execFile(
      "lark-cli", args,
      { timeout, cwd: cwd || LARK_TMP, env: { ...process.env, PATH: shellPath() }, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || "", stderr: stderr || "" }),
    );
    child.on("error", () => {});
  });
}
function larkJson(s) { try { return JSON.parse(String(s).trim()); } catch { return null; } }

app.get("/api/feishu/lark-cli", async (_req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  const v = await larkRun(["--version"], { timeout: 15000 });
  if (!v.ok) return res.json({ installed: false, install_cmd: "npx @larksuite/cli@latest install" });
  const version = (v.stdout.match(/[\d.]+/) || [""])[0];
  const cfg = larkJson((await larkRun(["config", "show"], { timeout: 15000 })).stdout.split("\n\nConfig file path")[0]);
  // 只回布尔和非敏感字段，app_secret 一个字节都不出后端
  res.json({
    installed: true, version,
    configured: !!(cfg && cfg.appId),
    app_id: (cfg && cfg.appId) || "",
    brand: (cfg && cfg.brand) || "",
    has_secret: !!(cfg && cfg.appSecret),
    users: (cfg && cfg.users) || "",
  });
});

// 把 lark-cli 里已经配好的应用凭证搬进 OpenWorkBuddy 的飞书通道，省掉手动复制两串东西
app.post("/api/feishu/lark-cli/import", async (_req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  const r = await larkRun(["config", "show"], { timeout: 15000 });
  const cfg = larkJson(r.stdout.split("\n\nConfig file path")[0]);
  if (!cfg || !cfg.appId || !cfg.appSecret) {
    return res.status(400).json({ error: "lark-cli 还没配置应用凭证，先跑 lark-cli config init" });
  }
  config.im = config.im || {};
  config.im.feishu = Object.assign(config.im.feishu || {}, { app_id: cfg.appId, app_secret: cfg.appSecret });
  saveConfig();
  if (imBridge) imBridge.startFeishuWs(true).catch((e) => console.warn("[飞书] 长连接重启失败:", e.message));
  res.json({ ok: true, app_id: cfg.appId }); // secret 不回前端
});

// 反向：把 OpenWorkBuddy 里填好的凭证写进 lark-cli，这样才能开始扫码（设备码流程需要一个已绑定的应用）
app.post("/api/feishu/lark-cli/bind", (_req, res) => {
  const f = (config.im || {}).feishu || {};
  if (!f.app_id || !f.app_secret) return res.status(400).json({ error: "先在上面填好 App ID / App Secret 并保存" });
  fs.mkdirSync(LARK_TMP, { recursive: true });
  // secret 走 stdin，不进进程参数表（ps 能看到 argv）
  const child = require("child_process").execFile(
    "lark-cli", ["config", "init", "--app-id", f.app_id, "--app-secret-stdin", "--brand", "feishu", "--lang", "zh"],
    { timeout: 60000, cwd: LARK_TMP, env: { ...process.env, PATH: shellPath() } },
    (err, stdout, stderr) => {
      if (res.headersSent) return;
      if (err) return res.status(400).json({ error: ((stderr || stdout || err.message) + "").slice(0, 300) });
      res.json({ ok: true });
    },
  );
  child.on("error", (e) => { if (!res.headersSent) res.status(400).json({ error: "lark-cli 没装或调不起来：" + e.message }); });
  try { child.stdin.end(f.app_secret + "\n"); } catch {}
});

// 设备码流程：start 拿二维码 → 用户在飞书里扫 → 后台那条 --device-code 自己会跑完 → status 变 ok
let larkQr = null; // { device_code, url, expires_at, state, error, child }
app.post("/api/feishu/qr/start", async (req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  if (larkQr && larkQr.child) { try { larkQr.child.kill(); } catch {} }
  const domains = String((req.body && req.body.domains) || "im,docs,drive,calendar,task");
  const r = await larkRun(["auth", "login", "--no-wait", "--json", "--domain", domains], { timeout: 60000 });
  const j = larkJson(r.stdout);
  if (!j || !j.verification_url || !j.device_code) {
    const msg = (r.stderr || r.stdout || "").slice(0, 300);
    return res.status(400).json({ error: /config init|app.?id/i.test(msg)
      ? "lark-cli 还没绑定应用：先在上面填好 App ID / App Secret 并「写入 lark-cli」，或自己跑 lark-cli config init"
      : "拿不到授权链接：" + (msg || "lark-cli 没有返回内容") });
  }
  // 出二维码：写进临时目录再读成 data URI，前端直接 <img>，不落工作区
  const png = "qr-" + Date.now() + ".png";
  await larkRun(["auth", "qrcode", j.verification_url, "-o", png, "--size", "256"], { timeout: 20000 });
  let dataUri = null;
  try {
    dataUri = "data:image/png;base64," + fs.readFileSync(path.join(LARK_TMP, png)).toString("base64");
    fs.unlinkSync(path.join(LARK_TMP, png));
  } catch {}

  // 阻塞式轮询交给后台子进程，前端只问我们自己的 status
  const child = require("child_process").execFile(
    "lark-cli", ["auth", "login", "--device-code", j.device_code, "--json"],
    { timeout: (j.expires_in || 600) * 1000 + 15000, cwd: LARK_TMP, env: { ...process.env, PATH: shellPath() } },
    (err, stdout, stderr) => {
      if (!larkQr || larkQr.device_code !== j.device_code) return; // 已被新的一轮顶掉
      if (err) { larkQr.state = "error"; larkQr.error = ((stderr || stdout || err.message) + "").slice(0, 300); }
      else { larkQr.state = "ok"; larkQr.result = larkJson(stdout) || {}; }
    },
  );
  child.on("error", (e) => { if (larkQr) { larkQr.state = "error"; larkQr.error = e.message; } });
  larkQr = { device_code: j.device_code, url: j.verification_url, expires_at: Date.now() + (j.expires_in || 600) * 1000, state: "pending", child };
  res.json({ ok: true, url: j.verification_url, qr: dataUri, expires_in: j.expires_in || 600 });
});

app.get("/api/feishu/qr/status", async (_req, res) => {
  if (!larkQr) return res.json({ state: "idle" });
  if (larkQr.state === "pending" && Date.now() > larkQr.expires_at) {
    larkQr.state = "error"; larkQr.error = "二维码超时失效，重新点一次生成";
  }
  if (larkQr.state !== "ok") return res.json({ state: larkQr.state, error: larkQr.error || null });
  const who = larkJson((await larkRun(["whoami"], { timeout: 15000 })).stdout) || {};
  res.json({ state: "ok", identity: who.identity || "", app_id: who.appId || "", user: larkQr.result && larkQr.result.user_name || "" });
});

app.post("/api/feishu/qr/cancel", (_req, res) => {
  if (larkQr && larkQr.child) { try { larkQr.child.kill(); } catch {} }
  larkQr = null;
  res.json({ ok: true });
});

// ---- 缓存清理：界面缓存(Electron chromium) + 各项目 .tmp 临时脚本；不动会话记录/工作区文件/登录态 ----
const CHROMIUM_CACHE_DIRS = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "blob_storage", "Shared Dictionary"];
function wbUserDataDir() {
  if (process.versions.electron) {
    try { return require("electron").app.getPath("userData"); } catch {}
  }
  const home = require("os").homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "openworkbuddy");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "openworkbuddy");
  return path.join(home, ".config", "openworkbuddy");
}
function dirSize(p) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(p)) {
      const fp = path.join(p, e);
      try {
        const st = fs.lstatSync(fp); // lstat：.tmp/node_modules 软链绝不能跟进去统计/删除
        if (st.isSymbolicLink()) continue;
        n += st.isDirectory() ? dirSize(fp) : st.size;
      } catch {}
    }
  } catch {}
  return n;
}
function cacheTmpDirs() {
  const set = new Set([path.join(getWorkspaceDir(), ".tmp")]);
  for (const p of config.projects || []) if (p && p.dir) set.add(path.join(p.dir, ".tmp"));
  return [...set];
}
function cacheStats() {
  const ud = wbUserDataDir();
  const ui = CHROMIUM_CACHE_DIRS.reduce((n, d) => n + dirSize(path.join(ud, d)), 0);
  const tmp = cacheTmpDirs().reduce((n, d) => n + dirSize(d), 0);
  return { ui, tmp, total: ui + tmp };
}
app.get("/api/cache", (_req, res) => res.json(cacheStats()));
app.post("/api/cache/clear", async (_req, res) => {
  const before = cacheStats();
  if (process.versions.electron) {
    // 桌面版走官方 API：HTTP 缓存/代码缓存/着色器缓存；Cookie 与 localStorage（登录态、主题）不动
    try {
      const ses = require("electron").session.defaultSession;
      await ses.clearCache();
      try { await ses.clearCodeCaches({}); } catch {}
      try { await ses.clearStorageData({ storages: ["shadercache", "cachestorage"] }); } catch {}
    } catch (e) { console.warn("[缓存] Electron 清理失败:", e.message); }
  }
  const ud = wbUserDataDir();
  for (const d of CHROMIUM_CACHE_DIRS) {
    const dir = path.join(ud, d);
    try {
      for (const e of fs.readdirSync(dir)) {
        try { fs.rmSync(path.join(dir, e), { recursive: true, force: true }); } catch {} // 被占用就跳过
      }
    } catch {}
  }
  for (const dir of cacheTmpDirs()) {
    try {
      for (const e of fs.readdirSync(dir)) {
        const fp = path.join(dir, e);
        try {
          if (fs.lstatSync(fp).isSymbolicLink()) fs.unlinkSync(fp); // node_modules 软链只解链，下次 runNode 自动重建
          else fs.rmSync(fp, { recursive: true, force: true });
        } catch {}
      }
    } catch {}
  }
  const after = cacheStats();
  res.json({ ok: true, freed: Math.max(0, before.total - after.total), before: before.total, after: after.total });
});

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

app.get("/api/skills", (_req, res) =>
  // plugin 字段标出技能来自哪个 Agent Plugins 插件（本地技能没有这个字段），界面据此禁用编辑/删除
  res.json((runtime ? runtime.getSkills() : []).map((s) => ({ name: s.name, description: s.description, plugin: s.plugin || "" })))
);
// 技能管理：getSkills 每次现读磁盘，增删改/安装即热生效，无需重启
const skillsMgr = require("./skills");
app.get("/api/skills/:name", (req, res) => {
  const s = skillsMgr.getSkillFull(req.params.name);
  if (!s) return res.status(404).json({ error: "技能不存在" });
  res.json(s);
});
app.post("/api/skills", (req, res) => {
  try {
    const { name, description, content, original_name } = req.body || {};
    if (!String(name || "").trim()) throw new Error("技能名不能为空");
    if (!String(content || "").trim()) throw new Error("技能内容不能为空");
    res.json(skillsMgr.saveSkill({ name, description, content, original_name }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/skills/:name", (req, res) => {
  try {
    res.json({ ok: skillsMgr.deleteSkill(req.params.name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/skills/install", async (req, res) => {
  try {
    const installed = await skillsMgr.installFromGitHub((req.body || {}).url);
    res.json({ ok: true, installed });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- 默认技能：不随仓库打包，点一下从上游装 ----
app.get("/api/skills/defaults/list", (_req, res) => res.json(skillsMgr.listDefaultSkills()));
app.post("/api/skills/defaults/install", async (req, res) => {
  try {
    const { names, force } = req.body || {};
    const results = await skillsMgr.ensureDefaultSkills({
      only: Array.isArray(names) && names.length ? names : null,
      force: !!force, // 「重新下载」要真的重下，不然点了没反应
    });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Agent Plugins 1.0.0 插件 ----
const pluginsMgr = require("./plugins");
app.get("/api/plugins", (_req, res) => {
  const list = pluginsMgr.loadPlugins().map((p) => ({
    ok: p.ok,
    name: p.name,
    error: p.error || "",
    warnings: p.warnings || [],
    version: p.manifest?.version || "",
    description: p.manifest?.description || "",
    license: p.manifest?.license || "",
    author: p.manifest?.author?.name || "",
    homepage: p.manifest?.homepage || "",
    repository: p.manifest?.repository || "",
    skills: (p.skills || []).map((s) => ({ name: s.name, description: s.description })),
    mcp_servers: (p.mcpServers || []).map((s) => ({ name: s.name, transport: s.transport })),
    bytes: p.ok ? skillsMgr.dirSize(p.dir) : 0,
    source: pluginsMgr.pluginSource(p.name), // 有来源才给「更新」按钮
  }));
  res.json({ spec: pluginsMgr.SPEC_VERSION, plugins: list, mcp: mcpManager.status() });
});
app.post("/api/plugins/install", async (req, res) => {
  try {
    const info = await pluginsMgr.installPluginFromGitHub((req.body || {}).url);
    // 插件带的 MCP 服务器要现起才能用；技能是每次任务现读磁盘的，不用管
    const started = await startPluginMcp(info.name);
    res.json({ ok: true, installed: info, mcp_started: started });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/plugins/:name/update", async (req, res) => {
  try {
    const name = req.params.name;
    // 旧的先停干净：重装会把目录整个换掉，老进程留着还指着已经删掉的文件
    mcpManager.stopPlugin(name);
    const info = await pluginsMgr.updatePlugin(name);
    const started = await startPluginMcp(info.name);
    res.json({ ok: true, updated: info, mcp_started: started });
  } catch (e) {
    // 更新失败也得把停掉的服务器捞回来，不然用户点一下「更新」反而把能用的搞没了
    try { await startPluginMcp(req.params.name); } catch { /* 插件目录可能已经没了 */ }
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/plugins/:name", (req, res) => {
  try {
    // 先停进程再删目录：目录一删就查不出它带过哪些服务器，子进程会一直挂到重启应用
    const stopped = mcpManager.stopPlugin(req.params.name);
    const ok = pluginsMgr.removePlugin(req.params.name);
    if (!ok) return res.json({ ok: false, note: "没有这个插件" });
    res.json({
      ok: true,
      mcp_stopped: stopped,
      note: stopped.length ? `插件已卸载，同时停掉了它带的 ${stopped.length} 个 MCP 服务器` : "插件已卸载",
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** 只起某个插件里还没连上的 MCP 服务器（装完立刻可用，不用重启） */
async function startPluginMcp(pluginName) {
  const want = pluginsMgr.pluginMcpServers().filter((s) => s.plugin === pluginName && !mcpManager.clients.has(s.name));
  if (!want.length) return [];
  await mcpManager.startAll(want);
  return want.filter((s) => mcpManager.clients.has(s.name)).map((s) => s.name);
}

// 文件上传到工作空间（输入框 ＋ 按钮）
app.post("/api/upload", (req, res) => {
  try {
    const { name, data_b64 } = req.body || {};
    if (!name || !data_b64) return res.status(400).json({ error: "缺少 name 或 data_b64" });
    const p = safePath(path.basename(name));
    fs.writeFileSync(p, Buffer.from(data_b64, "base64"));
    res.json({ ok: true, name: path.basename(name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 专家管理：增删改就地改 experts 数组（runtime 闭包同一引用，热生效）+ 持久化 experts.json
// 一个专家 = 头像 + 名字 + 花名 + 说明 + 绑定技能 + 默认提示词 的智能体，用户可自建。
const EXPERT_FIELDS = ["name", "alias", "avatar", "category", "tags", "description", "skills", "system"];
function publicExpert(e) {
  return {
    name: e.name,
    alias: e.alias || "",
    avatar: e.avatar || "🧑‍💼",
    category: e.category || "未分类",
    tags: Array.isArray(e.tags) ? e.tags : [],
    description: e.description || "",
    skills: Array.isArray(e.skills) ? e.skills : [],
    system: e.system || "",
    builtin: !!e.builtin,
  };
}
app.get("/api/experts", (_req, res) => res.json(experts.map(publicExpert)));
app.post("/api/experts", (req, res) => {
  const b = req.body || {};
  const n = String(b.name || "").trim();
  if (!n || !String(b.system || "").trim()) return res.status(400).json({ error: "专家名称与角色设定（提示词）不能为空" });
  if (n === "delegate_to_expert" || n.length > 20) return res.status(400).json({ error: "专家名称不合法（≤20 字）" });
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : []);
  const idx = experts.findIndex((e) => e.name === (b.original_name || n));
  // 改名时要保证新名字没被别人占着
  if (experts.some((e, i) => e.name === n && i !== idx)) return res.status(400).json({ error: "同名专家已存在" });
  const entry = {
    name: n,
    alias: String(b.alias || "").trim().slice(0, 12),
    avatar: String(b.avatar || "🧑‍💼").trim().slice(0, 8) || "🧑‍💼",
    category: String(b.category || "未分类").trim().slice(0, 12) || "未分类",
    tags: arr(b.tags),
    description: String(b.description || "").trim(),
    skills: arr(b.skills),
    system: String(b.system).trim(),
  };
  if (idx >= 0) {
    entry.builtin = !!experts[idx].builtin; // 内置标记只由 experts.json 决定，接口改不动
    experts.splice(idx, 1, entry);
    // 改了名字的话，团队成员名单要跟着改，否则团里挂着一个不存在的人
    if (b.original_name && b.original_name !== n) {
      for (const t of expertTeams) t.members = t.members.map((m) => (m === b.original_name ? n : m));
    }
  } else experts.push(entry);
  saveExperts();
  res.json({ ok: true, expert: publicExpert(entry) });
});
app.delete("/api/experts/:name", (req, res) => {
  const idx = experts.findIndex((e) => e.name === req.params.name);
  if (idx < 0) return res.status(404).json({ error: "专家不存在" });
  const [gone] = experts.splice(idx, 1);
  for (const t of expertTeams) t.members = t.members.filter((m) => m !== gone.name); // 顺手把团里的他摘掉
  saveExperts();
  res.json({ ok: true });
});

// 专家团 = 智能体团队：把若干专家编成一队，一次委派整队按顺序接力完成
app.get("/api/expert-teams", (_req, res) =>
  res.json(
    expertTeams.map((t) => ({
      name: t.name,
      avatar: t.avatar || "👥",
      description: t.description || "",
      members: (t.members || []).filter((m) => experts.some((e) => e.name === m)),
    }))
  )
);
app.post("/api/expert-teams", (req, res) => {
  const b = req.body || {};
  const n = String(b.name || "").trim();
  if (!n || n.length > 20) return res.status(400).json({ error: "团队名称不合法（1~20 字）" });
  const members = (Array.isArray(b.members) ? b.members : [])
    .map((m) => String(m).trim())
    .filter((m) => experts.some((e) => e.name === m));
  if (members.length < 2) return res.status(400).json({ error: "一个团至少要有 2 位专家（成员必须是已存在的专家）" });
  const idx = expertTeams.findIndex((t) => t.name === (b.original_name || n));
  if (expertTeams.some((t, i) => t.name === n && i !== idx)) return res.status(400).json({ error: "同名专家团已存在" });
  const entry = {
    name: n,
    avatar: String(b.avatar || "👥").trim().slice(0, 8) || "👥",
    description: String(b.description || "").trim(),
    members: [...new Set(members)].slice(0, 8), // 接力式执行，人多了会把时间预算耗光
  };
  if (idx >= 0) expertTeams.splice(idx, 1, entry);
  else expertTeams.push(entry);
  saveExperts();
  res.json({ ok: true, team: entry });
});
app.delete("/api/expert-teams/:name", (req, res) => {
  const idx = expertTeams.findIndex((t) => t.name === req.params.name);
  if (idx < 0) return res.status(404).json({ error: "专家团不存在" });
  expertTeams.splice(idx, 1);
  saveExperts();
  res.json({ ok: true });
});

app.get("/api/files/download/:name", (req, res) => {
  try {
    const p = safePath(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).send("文件不存在");
    res.download(p);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// 应用内预览：按正确 Content-Type 内联返回（HTML/图片/PDF 可直接在 iframe/img 中显示）
app.get("/api/files/view/:name", (req, res) => {
  try {
    const p = safePath(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).send("文件不存在");
    res.sendFile(p);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// 对话里的内联图表「存为文件」：内容是前端已经渲染过的东西，落盘到工作目录就能进成果面板、
// 能下载、能被后续回合当素材继续用。扩展名白名单挡住"顺手写个 .sh/.command 再让我打开"的路子。
const SAVE_EXT_OK = /\.(svg|png|jpe?g|html?|md|markdown|txt|csv|json)$/i;
app.post("/api/files/save", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const content = req.body?.content;
    if (!name || typeof content !== "string") return res.status(400).json({ error: "缺少 name 或 content" });
    if (!SAVE_EXT_OK.test(name)) return res.status(400).json({ error: "不支持保存这种类型的文件" });
    const p = safePath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const b64 = content.match(/^data:[^;]+;base64,(.*)$/s);
    fs.writeFileSync(p, b64 ? Buffer.from(b64[1], "base64") : content);
    res.json({ ok: true, name, files: outputFiles() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- 本地部署预览：把工作目录当静态站点跑在一个独立端口上 ----
// 应用内 iframe 预览走 /api/files/view，够看长相；但真正的网页要有自己的 origin 才对
// （相对路径引资源、fetch、localStorage、手机上开来看）。这里起一个只监听本机的静态服务器。
let previewServer = null; // { srv, port, dir }
function lanAddress() {
  const nets = require("os").networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}
function previewState() {
  if (!previewServer) return { running: false };
  const lan = previewServer.lanOpen ? lanAddress() : null;
  return {
    running: true,
    port: previewServer.port,
    dir: previewServer.dir,
    lan_open: !!previewServer.lanOpen,
    url: `http://127.0.0.1:${previewServer.port}/`,
    lan_url: lan ? `http://${lan}:${previewServer.port}/` : null,
  };
}
app.get("/api/preview/status", (_req, res) => res.json(previewState()));
app.post("/api/preview/start", (req, res) => {
  const dir = getWorkspaceDir();
  // lan=true 才对局域网开放：开了手机能扫，但同一个 Wi-Fi 下的人也能翻整个工作目录，所以默认关
  const lanOpen = !!(req.body && req.body.lan);
  // open=文件名：服务就绪后用系统默认浏览器打开它
  const openName = req.body && req.body.open ? String(req.body.open).replace(/^\/+/, "") : null;
  const done = (st) => {
    if (openName) openWithSystem(st.url + encodeURIComponent(openName));
    res.json(st);
  };
  // 已经在跑且参数一致：不用重起，但该开的浏览器还是得开。
  // （这里以前是直接 return，把 open 一起吞了——而「在浏览器打开」按钮只在服务已启动时才出现，
  //   必然走这条分支，所以那个按钮点了从来没反应过。）
  if (previewServer && previewServer.dir === dir && previewServer.lanOpen === lanOpen) return done(previewState());
  if (previewServer) { try { previewServer.srv.close(); } catch {} previewServer = null; }
  const site = express();
  site.use(express.static(dir, { extensions: ["html"] }));
  // 端口 0 = 让系统分配空闲端口，避免和用户本机其它服务撞车
  const srv = site.listen(0, lanOpen ? "0.0.0.0" : "127.0.0.1", () => {
    previewServer = { srv, port: srv.address().port, dir, lanOpen };
    done(previewState());
  });
  srv.on("error", (e) => {
    if (!res.headersSent) res.status(500).json({ error: "本地预览服务起不来：" + e.message });
  });
});
app.post("/api/preview/stop", (_req, res) => {
  if (previewServer) { try { previewServer.srv.close(); } catch {} previewServer = null; }
  res.json({ running: false });
});

// 用系统默认程序打开（Word/PPT/Excel 等交给本机 Office/WPS）
app.post("/api/files/open/:name", (req, res) => {
  try {
    const p = safePath(req.params.name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: "文件不存在" });
    openWithSystem(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message, mode, regen } = req.body || {};
  if (!sessionId || !message) return res.status(400).json({ error: "缺少 sessionId 或 message" });
  const user = req.user; // authGuard 已挂上
  // 积分闸门默认是关的（本地个人用不该被自己的账本拦），开了才查余额
  if (user && account.creditsEnabled() && user.credits <= 0) {
    return res.status(402).json({ error: "积分不足，无法执行任务。管理员可以在左下角「账号 · 用量」里充值，或者干脆把「积分限额」关掉。" });
  }
  if (activeRuns.has(sessionId)) {
    return res.status(409).json({ error: "该会话已有任务在运行，可用「插队」把补充说明注入当前任务。" });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const sess = getSession(sessionId);
  if (user && !sess.user) sess.user = user.username;
  if (regen) {
    // 重新生成：回滚掉最后一轮（用户消息及其后的所有内容），下面会把同一条消息重新入队
    const lastUser = sess.history.map((h) => h.role).lastIndexOf("user");
    if (lastUser >= 0) sess.history.splice(lastUser);
    if (sess.transcript.length && sess.transcript[sess.transcript.length - 1].type === "assistant") sess.transcript.pop();
    if (sess.transcript.length && sess.transcript[sess.transcript.length - 1].type === "user") sess.transcript.pop();
  }
  if (!sess.title) sess.title = message.slice(0, 24);
  sess.history.push({ role: "user", content: message });
  sess.transcript.push({ type: "user", text: message, mode });
  const asstEvents = [];
  sess.transcript.push({ type: "assistant", events: asstEvents });
  autosaveSession(sessionId, 0); // 先把用户这句话落盘，后面再崩至少问题还在

  const runState = { ctrl: new AbortController(), interject: [] };
  activeRuns.set(sessionId, runState);
  const emitFn = recordingEmit(send, asstEvents, sessionId);
  const total = { prompt: 0, completion: 0, calls: 0, elapsed_ms: 0 };
  try {
    // 任务收尾瞬间可能还有没被 agent 循环消化的插队消息 → 追加为新一轮，直到清空
    for (;;) {
      const r = await runtime.runTask({
        history: sess.history,
        emit: emitFn,
        mode: ["ask", "plan", "craft"].includes(mode) ? mode : "craft",
        stopSignal: runState.ctrl.signal,
        getInterject: () => runState.interject.splice(0),
      });
      if (r && r.usage) {
        total.prompt += r.usage.prompt;
        total.completion += r.usage.completion;
        total.calls += r.usage.calls;
        total.elapsed_ms += r.usage.elapsed_ms;
      }
      const leftover = runState.interject.splice(0);
      if (!leftover.length || runState.ctrl.signal.aborted) break;
      for (const m of leftover) {
        sess.history.push({ role: "user", content: m });
        emitFn({ type: "interject", text: m });
      }
    }
  } catch (e) {
    send({ type: "error", message: e.message });
    asstEvents.push({ type: "error", message: e.message });
  } finally {
    activeRuns.delete(sessionId);
  }

  // 记账：按整个任务（含插队追加轮）的总 tokens 扣积分
  if (user && total.calls > 0) {
    const spent = account.chargeRun(user, { ...total, model: llm.model, provider: llm.provider, source: "web", sessionId });
    // 不限额时 spent 是 0，就别在结果下面挂一行「扣 0 积分」了，那只是噪声
    if (spent > 0) emitFn({ type: "credits", spent, balance: user.credits });
  }

  saveSession(sessionId);
  // 收尾只是刷一遍完整文件列表，不是"本回合有产出"的通报：changed 明确给空，
  // 免得前端拿本地 mtime 猜一把，把工作目录里的旧文件当成新成果又把面板弹出来
  send({ type: "files", files: outputFiles(), changed: [] });
  send({ type: "done" });
  res.end();
});

// 插队：往正在运行的任务里注入一条补充消息（agent 在下一个安全间隙读到并继续）
app.post("/api/chat/interject", (req, res) => {
  const { sessionId, message } = req.body || {};
  const text = String(message || "").trim();
  const run = activeRuns.get(sessionId);
  if (!run) return res.status(409).json({ ok: false, error: "该会话没有正在运行的任务" });
  if (!text) return res.status(400).json({ ok: false, error: "消息为空" });
  run.interject.push(text);
  res.json({ ok: true, queued: run.interject.length });
});

// 历史会话回放
app.get("/api/session/:id", (req, res) => {
  res.json({ transcript: getSession(req.params.id).transcript });
});

// 删除会话（内存 + 磁盘一起删）
app.delete("/api/session/:id", (req, res) => {
  sessions.delete(req.params.id);
  try { fs.unlinkSync(sessFile(req.params.id)); } catch {}
  res.json({ ok: true });
});

// 停止正在运行的任务：中断当前模型调用，agent 循环在下一个检查点收尾
app.post("/api/chat/stop", (req, res) => {
  const run = activeRuns.get((req.body || {}).sessionId);
  if (!run) return res.json({ ok: false, error: "该会话没有正在运行的任务" });
  run.ctrl.abort();
  res.json({ ok: true });
});

let scheduler;

// ---------- 定时任务管理 API ----------
app.get("/api/schedules", (_req, res) => res.json(scheduler.list()));
app.post("/api/schedules", (req, res) => {
  try {
    res.json(scheduler.add(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/schedules/:id", (req, res) => res.json({ ok: scheduler.remove(req.params.id) }));
app.post("/api/schedules/:id/toggle", (req, res) =>
  res.json({ ok: scheduler.toggle(req.params.id, !!(req.body || {}).enabled) })
);
app.post("/api/schedules/:id/catchup", (req, res) =>
  res.json({ ok: scheduler.setCatchUp(req.params.id, !!(req.body || {}).catch_up) })
);
app.post("/api/schedules/:id/run", async (req, res) => {
  const item = scheduler.list().find((t) => t.id === req.params.id);
  if (!item) return res.status(404).json({ error: "任务不存在" });
  if (item.running) return res.status(409).json({ error: "这个任务正在跑，等它跑完再点" });
  try {
    // 传 id 不传对象：list() 给出去的是副本，拿副本去跑的话执行结果写在副本上，存不下来
    const reply = await scheduler.runOne(item.id, "手动");
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 给 IM / 定时任务的 runtime 包一层记账：消耗记到管理员（首个用户）名下，开了积分闸门才在 0 分时拒跑 */
function accountedRuntime(baseRuntime, source) {
  return {
    ...baseRuntime,
    runTask: async (args) => {
      const owner = account.defaultUser();
      if (owner && account.creditsEnabled() && owner.credits <= 0) {
        throw new Error("积分不足：管理员可以在 Web 端「账号 · 用量」里充值，或者把「积分限额」关掉");
      }
      const r = await baseRuntime.runTask(args);
      if (owner && r && r.usage && r.usage.calls > 0) {
        account.chargeRun(owner, { ...r.usage, model: llm.model, provider: llm.provider, source });
      }
      return r;
    },
  };
}

async function main() {
  // config.json 里配的 + Agent Plugins 插件 mcp.json 里声明的，一起起。
  // 插件那边坏一条只跳过一条（规范要求的失败隔离），不影响 config 里的服务器。
  let pluginServers = [];
  try {
    pluginServers = pluginsMgr.pluginMcpServers();
  } catch (e) {
    console.warn("[插件] MCP 配置读取失败:", e.message);
  }
  await mcpManager.startAll([...(config.mcp_servers || []), ...pluginServers]);
  const badPlugins = pluginsMgr.loadPlugins().filter((p) => !p.ok);
  for (const p of badPlugins) console.warn(`[插件] ${p.name} 装不上: ${p.error}`);
  runtime = createAgentRuntime({ config, llm, mcpManager, experts, expertTeams });

  scheduler = createScheduler({
    runtime: accountedRuntime(runtime, "schedule"),
    onResult: (item, text) =>
      notify.pushBots(config, `【OpenWorkBuddy·定时任务】${item.name}\n${(text || "").slice(0, 800)}`),
  });

  // IM 远程指挥路由（飞书/QQ 长连接 · 企业微信与公众号回调 · 通用 webhook）
  imBridge = createImRouter({ config, runtime: accountedRuntime(runtime, "im"), sessions: imSessions, outputFiles, saveConfig });
  app.use(imBridge.router);
  imBridge
    .startFeishuWs()
    .then((s) => { if (s.state !== "off") console.log(`飞书长连接: ${s.state}`); })
    .catch((e) => console.warn("[飞书] 长连接启动失败:", e.message));
  imBridge
    .startQQ()
    .then((s) => { if (s.configured) console.log(`QQ 长连接: ${s.state}`); })
    .catch((e) => console.warn("[QQ] 长连接启动失败:", e.message));
  imBridge
    .startIlink()
    .then((s) => { if (s.configured) console.log(`微信 iLink 长轮询: ${s.state}`); })
    .catch((e) => console.warn("[微信iLink] 长轮询启动失败:", e.message));

  // 兜底：任何路由里没接住的异常都变成 JSON，别甩一整页 HTML 堆栈给前端
  // （前端一律 r.json()，甩 HTML 的话界面只会显示「加载失败」，真正的原因谁也看不见）
  app.use((err, req, res, next) => {
    console.error(`[${req.method} ${req.path}]`, err.message);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || "服务器内部错误" });
  });

  const port = +process.env.PORT || config.server.port || 3800;
  // 默认只听本机：这个进程手里有 run_shell 和整个文件系统，绑 0.0.0.0 等于把 shell 挂到公网。
  // 要放出去（Docker / 服务器）必须显式 HOST=0.0.0.0，并且自己在前面套 HTTPS + 反代。
  const host = process.env.HOST || config.server.host || "127.0.0.1";
  const server = app.listen(port, host, () => {
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.warn(`⚠️  正在监听 ${host}:${port}（非本机）。请确认前面有反向代理 + HTTPS，且已经注册了管理员账号——否则任何人都能拿到这台机器的 shell。`);
    }
    console.log(`OpenWorkBuddy 已启动: http://localhost:${port}`);
    console.log(`模型: ${llm.provider} / ${llm.model}`);
    console.log(`技能: ${runtime.getSkills().map((s) => s.name).join(", ") || "无"}`);
    console.log(`专家团: ${experts.map((e) => e.name).join(", ") || "无"}`);
    console.log(`MCP 工具: ${mcpManager.toolDefs().length} 个`);
    const okPlugins = pluginsMgr.loadPlugins().filter((p) => p.ok);
    if (okPlugins.length) console.log(`Agent Plugins: ${okPlugins.map((p) => p.name).join(", ")}`);
    console.log(`工作目录: ${getWorkspaceDir()}`);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用（可能 Web 版已在运行），本进程不再重复启动服务，窗口将连接已运行的实例。`);
    } else {
      throw e;
    }
  });
}

process.on("SIGINT", () => {
  mcpManager.stopAll();
  process.exit(0);
});

main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
