"use strict";
/**
 * WorkBuddy 复刻版 — 服务器主入口。
 * 功能：Web 工作台（SSE 流式）、技能系统、MCP 连接器、专家团多智能体、IM 远程指挥（飞书/企业微信/通用 Webhook）。
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { createLLM } = require("./llm");
const { outputFiles, safePath, getWorkspaceDir, setWorkspaceDir, SEARCH_PROVIDERS, searchProviderKey } = require("./tools");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const { createImRouter } = require("./im");
const { createScheduler } = require("./scheduler");
const account = require("./account");
const security = require("./security");
const notify = require("./notify");

// config.json 不入 git（可能含 API Key）；首次运行自动从模板复制
const CONFIG_PATH = path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(path.join(__dirname, "config.example.json"), CONFIG_PATH);
  console.log("已从 config.example.json 生成 config.json，请填入你的模型 API Key");
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

security.getSecurity(config); // 补齐安全中心默认策略
config.shortcuts = config.shortcuts || {}; // 快捷键自定义绑定（只存改过的项，默认值在前端定义）

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
let expertsMeta = {};
try {
  const d = JSON.parse(fs.readFileSync(EXPERTS_FILE, "utf8"));
  expertsMeta = d;
  experts.push(...(d.experts || []));
} catch {}
function saveExperts() {
  fs.writeFileSync(EXPERTS_FILE, JSON.stringify({ ...expertsMeta, experts }, null, 2), "utf8");
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
    let data = { history: [], transcript: [], title: "", updated_at: null };
    try {
      data = JSON.parse(fs.readFileSync(sessFile(id), "utf8"));
    } catch {}
    sessions.set(id, data);
  }
  return sessions.get(id);
}
function saveSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.updated_at = new Date().toISOString();
  fs.mkdirSync(SESS_DIR, { recursive: true });
  fs.writeFileSync(sessFile(id), JSON.stringify(s), "utf8");
}

/** 包装 emit：把事件同时记录到 transcript（文本增量合并，跳过噪音事件） */
function recordingEmit(send, events) {
  return (ev) => {
    send(ev);
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      const last = events[events.length - 1];
      if (last && last.type === "text") last.delta += ev.delta;
      else events.push({ type: "text", delta: ev.delta });
    } else if (["tool_use", "tool_result", "expert_start", "expert_done", "error", "limit", "usage", "interject", "credits"].includes(ev.type)) {
      events.push(ev);
    }
  };
}

const app = express();
app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(account.createRouter()); // /api/auth/* /api/usage /api/credits/*
app.use(account.authGuard); // 其余 /api/* 与 /im/*（除外部回调）需要登录

let runtime; // MCP 启动后创建

app.get("/api/info", (_req, res) => {
  res.json({
    provider: llm.provider,
    model: llm.model,
    skills: runtime ? runtime.getSkills().map((s) => s.name) : [],
    experts: experts.map((e) => e.name),
    mcp_tools: mcpManager.toolDefs().length,
  });
});

app.get("/api/files", (_req, res) => res.json(outputFiles()));

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
    },
    persona: config.persona || "",
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
    }
    if (b.persona !== undefined) config.persona = String(b.persona).slice(0, 4000);
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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
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
  res.setHeader("Content-Disposition", `attachment; filename="workbuddy-audit-${new Date().toISOString().slice(0, 10)}.log"`);
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
  const servers = (config.mcp_servers || []).map((s) => {
    const client = mcpManager.clients.get(s.name);
    return {
      name: s.name,
      command: s.command,
      args: s.args || [],
      env: s.env || {},
      connected: !!client,
      tools: client ? client.tools.map((t) => ({ name: t.name, description: (t.description || "").slice(0, 200) })) : [],
    };
  });
  res.json({ servers, total_tools: mcpManager.toolDefs().length });
});

app.post("/api/mcp", async (req, res) => {
  try {
    const list = (req.body || {}).servers;
    if (!Array.isArray(list)) throw new Error("需要 servers 数组");
    for (const s of list) {
      if (!s.name || !s.command) throw new Error("每个服务器需要 name 和 command 字段");
    }
    config.mcp_servers = list.map((s) => ({
      name: String(s.name),
      command: String(s.command),
      args: Array.isArray(s.args) ? s.args.map(String) : [],
      env: s.env && typeof s.env === "object" ? s.env : {},
    }));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
    mcpManager.stopAll();
    mcpManager.clients.clear();
    await mcpManager.startAll(config.mcp_servers); // 失败的单独在日志告警，不阻塞其他
    res.json({ ok: true, total_tools: mcpManager.toolDefs().length, connected: [...mcpManager.clients.keys()] });
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
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
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
  try {
    return JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writeNotes(notes) {
  fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2), "utf8");
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

// ---- 缓存清理：界面缓存(Electron chromium) + 各项目 .tmp 临时脚本；不动会话记录/工作区文件/登录态 ----
const CHROMIUM_CACHE_DIRS = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "blob_storage", "Shared Dictionary"];
function wbUserDataDir() {
  if (process.versions.electron) {
    try { return require("electron").app.getPath("userData"); } catch {}
  }
  const home = require("os").homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "workbuddy-clone");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "workbuddy-clone");
  return path.join(home, ".config", "workbuddy-clone");
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
  res.json((runtime ? runtime.getSkills() : []).map((s) => ({ name: s.name, description: s.description })))
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
  res.json({ ok: skillsMgr.deleteSkill(req.params.name) });
});
app.post("/api/skills/install", async (req, res) => {
  try {
    const installed = await skillsMgr.installFromGitHub((req.body || {}).url);
    res.json({ ok: true, installed });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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
// 专家团管理：增删改就地改 experts 数组（runtime 闭包同一引用，热生效）+ 持久化 experts.json
app.get("/api/experts", (_req, res) =>
  res.json(experts.map((e) => ({ name: e.name, description: e.description, system: e.system })))
);
app.post("/api/experts", (req, res) => {
  const { name, description, system, original_name } = req.body || {};
  const n = String(name || "").trim();
  if (!n || !String(system || "").trim()) return res.status(400).json({ error: "专家名称与角色设定（system）不能为空" });
  if (n === "delegate_to_expert" || n.length > 20) return res.status(400).json({ error: "专家名称不合法（≤20 字）" });
  const idx = experts.findIndex((e) => e.name === (original_name || n));
  const entry = { name: n, description: String(description || "").trim(), system: String(system).trim() };
  if (idx >= 0) experts.splice(idx, 1, entry);
  else {
    if (experts.some((e) => e.name === n)) return res.status(400).json({ error: "同名专家已存在" });
    experts.push(entry);
  }
  saveExperts();
  res.json({ ok: true, experts: experts.map((e) => e.name) });
});
app.delete("/api/experts/:name", (req, res) => {
  const idx = experts.findIndex((e) => e.name === req.params.name);
  if (idx < 0) return res.status(404).json({ error: "专家不存在" });
  experts.splice(idx, 1);
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
  if (user && user.credits <= 0) {
    return res.status(402).json({ error: "积分不足，无法执行任务。请在左下角「账号 · 用量」里充值（管理员）后再试。" });
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

  const runState = { ctrl: new AbortController(), interject: [] };
  activeRuns.set(sessionId, runState);
  const emitFn = recordingEmit(send, asstEvents);
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
    emitFn({ type: "credits", spent, balance: user.credits });
  }

  saveSession(sessionId);
  send({ type: "files", files: outputFiles() });
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
app.post("/api/schedules/:id/run", async (req, res) => {
  const item = scheduler.list().find((t) => t.id === req.params.id);
  if (!item) return res.status(404).json({ error: "任务不存在" });
  try {
    const reply = await scheduler.runOne(item, "手动");
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 给 IM / 定时任务的 runtime 包一层记账：消耗记到管理员（首个用户）名下，0 积分时拒跑 */
function accountedRuntime(baseRuntime, source) {
  return {
    ...baseRuntime,
    runTask: async (args) => {
      const owner = account.defaultUser();
      if (owner && owner.credits <= 0) throw new Error("积分不足：请在 Web 端「账号 · 用量」里充值后再用");
      const r = await baseRuntime.runTask(args);
      if (owner && r && r.usage && r.usage.calls > 0) {
        account.chargeRun(owner, { ...r.usage, model: llm.model, provider: llm.provider, source });
      }
      return r;
    },
  };
}

async function main() {
  await mcpManager.startAll(config.mcp_servers || []);
  runtime = createAgentRuntime({ config, llm, mcpManager, experts });

  scheduler = createScheduler({
    runtime: accountedRuntime(runtime, "schedule"),
    onResult: (item, text) =>
      notify.pushBots(config, `【WorkBuddy·定时任务】${item.name}\n${(text || "").slice(0, 800)}`),
  });

  // IM 远程指挥路由（飞书/QQ 长连接 · 企业微信与公众号回调 · 通用 webhook）
  imBridge = createImRouter({ config, runtime: accountedRuntime(runtime, "im"), sessions, outputFiles });
  app.use(imBridge.router);
  imBridge
    .startFeishuWs()
    .then((s) => { if (s.state !== "off") console.log(`飞书长连接: ${s.state}`); })
    .catch((e) => console.warn("[飞书] 长连接启动失败:", e.message));
  imBridge
    .startQQ()
    .then((s) => { if (s.configured) console.log(`QQ 长连接: ${s.state}`); })
    .catch((e) => console.warn("[QQ] 长连接启动失败:", e.message));

  const port = config.server.port || 3800;
  const server = app.listen(port, () => {
    console.log(`WorkBuddy 复刻版已启动: http://localhost:${port}`);
    console.log(`模型: ${llm.provider} / ${llm.model}`);
    console.log(`技能: ${runtime.getSkills().map((s) => s.name).join(", ") || "无"}`);
    console.log(`专家团: ${experts.map((e) => e.name).join(", ") || "无"}`);
    console.log(`MCP 工具: ${mcpManager.toolDefs().length} 个`);
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
