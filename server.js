"use strict";
/**
 * OpenWorkBuddy — 服务器主入口。
 * 功能：Web 工作台（SSE 流式）、技能系统、MCP 连接器、专家团多智能体、IM 远程指挥（飞书/企业微信/通用 Webhook）。
 */

const BOOT_T0 = Date.now(); // server.js 从加载到 listen 的耗时，启动慢时先看这行日志
const express = require("express");
const fs = require("fs");
const path = require("path");
const { DATA_DIR, dataPath, appPath, seedDataDir } = require("./paths");
// 数据目录跟代码目录不是同一个地方时（装机版、以及 Docker 里设了 OPENWORKBUDDY_HOME），
// 得先把随包出厂的技能和专家铺过去，否则 skills.js 只认 dataPath("skills")，
// 容器起来是能起来，但技能列表空空如也。开发态两个目录本来就是一个，这行是空操作。
// 放在这儿是因为下面 require 的 tools/skills 一加载就按数据目录算路径了。
seedDataDir();
const { mergeBuiltinExperts } = require("./experts-lib");
const mcpCatalog = require("./mcp-catalog");
const { createLLM, createEmbedder, anthropicBase } = require("./llm");
const { outputFiles, filesScope, safePath, getWorkspaceDir, getDefaultWorkspaceDir, setWorkspaceDir, withWorkspace, withPolicy, SEARCH_PROVIDERS, searchProviderKey, shellPath } = require("./tools");
const prefs = require("./prefs"); // 按账号存的个人偏好：底层引擎 / 思考档 / 上次选的模型 / 宠物 / 快捷键
const { previewData } = require("./preview");
const evolve = require("./evolve");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const { createImRouter } = require("./im");
const { createScheduler } = require("./scheduler");
const account = require("./account");
const org = require("./org"); // 组织（租户）层：席位、部门、邀请码、审计
const admin = require("./admin"); // 企业管理后台的接口层 /api/admin/*
const engines = require("./engines"); // 底层引擎：内置循环 / 本机 Claude Code / 本机 Codex
const thinking = require("./thinking"); // 思考模式档位表（各家参数名都不一样，集中在那儿）
const security = require("./security");
const memory = require("./memory");
const notify = require("./notify");
const store = require("./store");
const petSprites = require("./pet-sprites"); // 桌面宠物的精灵图（吃 Codex / Petdex 的格式）
const pet = require("./pet"); // 只为拿默认值（没有 electron 时它自己降级成空壳，纯 node 也 require 得动）
const { createImSessionStore } = require("./im-store");

// config.json 不入 git（可能含 API Key）；首次运行自动从模板复制
const CONFIG_PATH = dataPath("config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.copyFileSync(appPath("config.example.json"), CONFIG_PATH);
  console.log("已从 config.example.json 生成 config.json，请填入你的模型 API Key");
}
// 配置读坏了不能就这么空着起来：那样界面上所有 Key 都变成空的，用户随手一保存就把
// 真 Key 覆盖没了。store 会先拿 .bak 顶（Key 原样还在），实在顶不住才把坏文件改名隔离、
// 退回模板——原文还在 .corrupt-时间戳 里，Key 捞得回来。
const CONFIG_DEFAULTS = JSON.parse(fs.readFileSync(appPath("config.example.json"), "utf8"));
const config = fillDefaults(store.readJson(CONFIG_PATH, CONFIG_DEFAULTS), CONFIG_DEFAULTS);

/**
 * 只补缺的，不改已有的（顶层键 + 顶层对象里的子键，两层就够）。
 *
 * config.json 是明确让用户手改的文件，删掉整个 server / agent 块很常见。以前那种情况下
 * 启动会抛 “Cannot read properties of undefined (reading 'host')” 或 “...(reading 'max_steps')”——
 * 一条完全看不出跟配置有关的报错，用户只会以为程序坏了。缺的用模板里的默认值填上就行。
 * 数组不合并：mcp_servers、models 这些用户清空是有意为之，不能又给他塞回来。
 */
function fillDefaults(cur, def) {
  for (const [k, v] of Object.entries(def)) {
    if (cur[k] === undefined) { cur[k] = v; continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && cur[k] && typeof cur[k] === "object" && !Array.isArray(cur[k])) {
      for (const [k2, v2] of Object.entries(v)) if (cur[k][k2] === undefined) cur[k][k2] = v2;
    }
  }
  return cur;
}

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
// "@cat" 是内置猫标的哨兵值，跟应用图标同一只猫；前端 avatarBits 认它，account.normalizeAvatar 放行
const ASSISTANT_DEFAULT = { name: "OpenWorkBuddy", avatar: "@cat" };
config.assistant = { ...ASSISTANT_DEFAULT, ...(config.assistant || {}) };

if (config.workspace_dir) {
  try {
    setWorkspaceDir(config.workspace_dir);
  } catch (e) {
    console.warn("workspace_dir 无效，使用默认工作空间:", e.message);
  }
}
let llmInner = createLLM(config);
// 记忆向量召回：有能算 embeddings 的渠道就接上，没有就退回关键词匹配（memory 自己兜底）
memory.setEmbedder(createEmbedder(config));
memory.ensureVectors().then((r) => { if (r.computed) console.log(`[记忆向量] 启动补算了 ${r.computed} 条`); }).catch((e) => console.warn("[记忆向量] 启动补算失败:", e.message));
// 可热替换的 LLM 包装：设置修改后 runtime 无需重建
const llm = {
  get provider() { return llmInner.provider; },
  get model() { return llmInner.model; },
  chat: (args) => llmInner.chat(args),
};
/** 按对话覆盖模型：会话里选过就用会话的，没选跟全局默认。
 *  选过的模型已被从列表删掉 → 明确报错，绝不悄悄换成别的模型跑 */
function llmForSession(sess) {
  const name = sess && sess.model;
  if (!name) return llm;
  if (Array.isArray(config.models) && config.models.some((m) => m.name === name)) {
    return createLLM({ ...config, active_model: name });
  }
  return {
    provider: name,
    model: name,
    chat: () => Promise.reject(new Error(`该对话指定的模型「${name}」已不在模型列表里。点输入框右下角的模型按钮重新选一个，或选「跟随全局默认」。`)),
  };
}
// 同一模型连续「整跑失败」计数（成功一次即清零）：连挂说明是模型/渠道本身的问题，光报错用户不知道该干嘛
const modelFailStreak = new Map();

// 模型健康账本：每次整跑记一笔成败（按模型条目名，滚动只留最近 20 次），选模型时能看到
// 「这个渠道最近靠不靠谱」，不用踩了才知道。落盘 data/model_health.json，重启不清零
const HEALTH_FILE = dataPath("data", "model_health.json");
const modelHealth = store.readJson(HEALTH_FILE, {}) || {};
function recordModelHealth(name, ok, failMsg) {
  if (!name) return;
  const h = (modelHealth[name] = modelHealth[name] || { recent: [] });
  h.recent.push(ok ? 1 : 0);
  if (h.recent.length > 20) h.recent = h.recent.slice(-20);
  if (ok) h.last_ok_t = Date.now();
  else { h.last_fail_t = Date.now(); h.last_fail = String(failMsg || "").slice(0, 200); }
  try { store.writeJsonAtomic(HEALTH_FILE, modelHealth); } catch {}
}
function healthSummary() {
  const out = {};
  for (const [name, h] of Object.entries(modelHealth)) {
    const recent = Array.isArray(h.recent) ? h.recent : [];
    let streak = 0;
    for (let i = recent.length - 1; i >= 0 && !recent[i]; i--) streak++;
    out[name] = { n: recent.length, ok: recent.filter(Boolean).length, fail_streak: streak, last_fail: h.last_fail || "", last_fail_t: h.last_fail_t || 0 };
  }
  return out;
}

// 专家团：数组引用被 runtime 闭包持有，增删改都就地改这个数组（热生效，无需重启）
const EXPERTS_FILE = dataPath("experts.json");
const experts = [];
const expertTeams = []; // 专家团 = 智能体团队，同样是被 runtime 闭包持有的活引用
let expertsMeta = store.readJson(EXPERTS_FILE, {}) || {};
// 打包版升级后，包里新出的内置专家/专家团要补进用户那份（用户改过、删过的不动）；
// 只靠首次安装时的 copyIfMissing，老用户永远见不到新专家。补了几个写日志留痕。
if (appPath("experts.json") !== EXPERTS_FILE) {
  try {
    const bundled = store.readJson(appPath("experts.json"), null);
    const hadSeen = Array.isArray(expertsMeta.seen_builtins);
    const r = bundled ? mergeBuiltinExperts(expertsMeta, bundled) : { added: [], addedTeams: [] };
    if (r.added.length || r.addedTeams.length || (bundled && !hadSeen)) {
      store.writeJsonAtomic(EXPERTS_FILE, expertsMeta, { pretty: true });
      if (r.added.length || r.addedTeams.length) console.log(`[专家] 升级补入内置专家 ${r.added.length} 位、专家团 ${r.addedTeams.length} 个：${[...r.added, ...r.addedTeams].join("、")}`);
    }
  } catch (e) { console.warn("[专家] 合并内置专家失败（不影响启动）:", e.message); }
}
experts.push(...(expertsMeta.experts || []));
expertTeams.push(...(expertsMeta.teams || []));
function saveExperts() {
  store.writeJsonAtomic(EXPERTS_FILE, { ...expertsMeta, experts, teams: expertTeams }, { pretty: true });
}
const mcpManager = new McpManager();
let imBridge = null; // IM 桥（含飞书长连接控制），init() 里创建

// ---------- 会话持久化：内存 + 磁盘（data/sessions/<id>.json） ----------
// 结构：{ history: 统一格式历史(供LLM), transcript: 界面回放记录, title, updated_at }
const SESS_DIR = dataPath("data", "sessions");
const sessions = new Map();
const activeRuns = new Map(); // sessionId -> { ctrl: AbortController, interject: [] }（「停止」与「插队」用）
// 正在跑的任务落一份名单到磁盘：应用中途被关/被重启时，内存里的 activeRuns 直接蒸发，
// 下次启动就靠这份名单知道哪些会话是被打断的，在回放里明说，而不是让那一轮无声地断在半空
const RUNNING_FILE = dataPath("data", "running.json");
function persistRunning() {
  try { store.writeJsonAtomic(RUNNING_FILE, [...activeRuns.keys()]); } catch {}
}
function sweepInterruptedRuns() {
  const ids = store.readJson(RUNNING_FILE, []);
  if (!Array.isArray(ids) || !ids.length) return;
  let marked = 0;
  for (const id of ids) {
    try {
      const sess = getSession(id);
      const last = sess.transcript[sess.transcript.length - 1];
      if (!last || last.type !== "assistant") continue;
      const evs = last.events || (last.events = []);
      const tail = evs[evs.length - 1];
      if (tail && tail.type === "error") continue; // 已有明确收场就别重复盖章
      evs.push({ type: "error", message: "应用在任务执行中被关闭或重启，这一轮已中断（已完成的进度和文件都还在）。可以对我说「接着上次进度继续」。" });
      saveSession(id);
      marked++;
    } catch {}
  }
  try { store.writeJsonAtomic(RUNNING_FILE, []); } catch {}
  if (marked) console.log(`[恢复] 检测到 ${marked} 个被重启打断的任务，已在会话回放里标注中断`);
}
const assignedDirs = new Set(); // 刚分配、还没写出文件的对话文件夹名：两个新对话同时起步不许撞同名

/** 给对话分配成果文件夹（任务_月日_标题），并把「消息发出前就传上来的」附件一起搬进去。
 *  搬运失败一概不抛：文件夹没建成事小，因为一个附件搬不动就让整条对话起不来事大。*/
function assignSessionDir(sess, message) {
  const d = new Date();
  const stamp = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  // 【任务类型：X】是给模型看的前缀，起标题时早就洗掉了，文件夹名这儿漏了——
  // 于是真实数据里躺着一个「任务_0826_任务类型数据分析及可视化_3」，
  // 用户看到的是分类词，真正做的那件事（篮球减肥训练计划）一个字都没进名字。
  const src = String(sess.title || message).replace(/^\s*【任务类型：[^】]*】\s*/, "");
  const slug = src.replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 12) || "对话";
  let dir = `任务_${stamp}_${slug}`;
  for (let i = 2; fs.existsSync(path.join(getWorkspaceDir(), dir)) || assignedDirs.has(dir); i++) dir = `任务_${stamp}_${slug}_${i}`;
  assignedDirs.add(dir);
  sess.dir = dir; // 存进会话，后续轮次/重启都落同一个文件夹
  const full = path.join(getWorkspaceDir(), dir);
  try { fs.mkdirSync(full, { recursive: true }); } catch {}
  for (const n of sess.pending_uploads || []) {
    try {
      const from = path.join(getWorkspaceDir(), n), to = path.join(full, n);
      // 根目录同名的可能是别人的旧文件，只搬确实存在、且目标位置还空着的
      if (fs.existsSync(from) && fs.statSync(from).isFile() && !fs.existsSync(to)) fs.renameSync(from, to);
    } catch {}
  }
  sess.pending_uploads = [];
  return dir;
}

function sessFile(id) {
  return path.join(SESS_DIR, id.replace(/[^\w-]/g, "_") + ".json");
}
// 每个会话文件「我们最后一次读/写它时」的样子。用来分辨盘上那份是不是被别的进程改过。
const sessStamp = new Map(); // id -> { mtime, size }
function sessStat(id) {
  try { const st = fs.statSync(sessFile(id)); return { mtime: st.mtimeMs, size: st.size }; } catch { return null; }
}
/**
 * 盘上那份比我们手里的新吗。
 *
 * 只比 mtime 会漏：原子改名两次可能落在同一毫秒里。加上体积，改了内容基本不可能两项都一样。
 */
function sessChangedOnDisk(id) {
  const now = sessStat(id);
  const mine = sessStamp.get(id);
  if (!now || !mine) return false; // 文件没了 / 我们压根没记过，都不算「别人改的」
  return now.mtime !== mine.mtime || now.size !== mine.size;
}
function getSession(id) {
  /**
   * 内存里有了也要回头看一眼盘：命令行的 wb 写的是同一批文件（data/sessions/<id>.json），
   * 而 wb resume 不给 id 时接的就是「最近动过的那个」，包括桌面上刚开的那条。
   * 以前这个 Map 一进来就再也不回头，于是「桌面开个头 → 终端 wb resume 接着做 → 回桌面再发一句」
   * 这条路上，桌面用的是几小时前那份内存副本，一存盘就把终端那几轮整段盖掉了——
   * 用户看到的是「我在终端做的那半截凭空消失了」。
   *
   * 正在跑任务的会话不重读：那份内存对象正被这一轮改着，从盘上盖回去等于把自己的进度丢了。
   */
  if (sessions.has(id) && !activeRuns.has(id) && sessChangedOnDisk(id)) {
    console.log(`[会话] ${id} 在别处改过（多半是命令行 wb），重新读一遍磁盘，免得把那边的记录覆盖掉`);
    sessions.delete(id);
  }
  if (!sessions.has(id)) {
    // 会话文件坏了不抛错（不能因为一条对话打不开就让整个工作台起不来），
    // 但也绝不装作没有过这条对话：store 会先拿 .bak 顶上，实在不行把坏文件改名隔离
    const data = store.readJson(sessFile(id), { history: [], transcript: [], title: "", updated_at: null });
    sessions.set(id, data);
    sessStamp.set(id, sessStat(id));
  }
  return sessions.get(id);
}
function saveSession(id) {
  const s = sessions.get(id);
  if (!s || !s.history) return;
  s.updated_at = new Date().toISOString();
  store.writeJsonAtomic(sessFile(id), s);
  sessStamp.set(id, sessStat(id)); // 记下自己写完之后的样子，别把自己这次写当成「别人改的」
}

/**
 * 磁盘上的会话清单（给侧栏的任务历史用）。
 *
 * 侧栏那份列表一直只活在浏览器 localStorage 里，而对话本体在 data/sessions/。
 * 于是「换台机器 / 清缓存 / 改用户名 / 换个账号先登进来」任意一件事，列表就空了，
 * 用户看到的是「我的历史任务全没了」，其实一条都没丢。这里按磁盘给一份权威清单。
 *
 * 按文件 mtime 做增量缓存：没变的文件不重读，跑着任务时也不会每次全量读一百个 JSON。
 * id 取的是文件名（sessFile 会把非 \w 字符换成 _，而 id 本来就是 s_<时间戳>_<随机数>，不会被改写）。
 */
const sessMetaCache = new Map(); // 文件名 -> { mtime, row }
function listSessionsOnDisk() {
  let names = [];
  try { names = fs.readdirSync(SESS_DIR).filter((n) => n.endsWith(".json")); } catch { return []; }
  const rows = [];
  const seen = new Set();
  for (const n of names) {
    const id = n.slice(0, -5);
    seen.add(n);
    const live = sessions.get(id); // 内存里有就用内存的：刚写过的盘没必要再读一遍
    if (!live) {
      let mtime = 0;
      try { mtime = fs.statSync(path.join(SESS_DIR, n)).mtimeMs; } catch { continue; }
      const hit = sessMetaCache.get(n);
      if (hit && hit.mtime === mtime) { if (hit.row) rows.push(hit.row); continue; }
      const data = store.readJson(path.join(SESS_DIR, n), null);
      const row = sessionRow(id, data);
      sessMetaCache.set(n, { mtime, row });
      if (row) rows.push(row);
      continue;
    }
    const row = sessionRow(id, live);
    if (row) rows.push(row);
  }
  for (const k of sessMetaCache.keys()) if (!seen.has(k)) sessMetaCache.delete(k); // 删掉的会话别赖在缓存里
  rows.sort((a, b) => b.at - a.at);
  return rows;
}
function sessionRow(id, s) {
  // 一句话都没说过的空壳不进侧栏：点进去还是空的，只会让人以为「历史又乱了」
  if (!s || !Array.isArray(s.transcript) || !s.transcript.length) return null;
  return {
    id,
    title: s.title || "未命名任务",
    user: s.user || "",
    project: s.project || "",
    at: Date.parse(s.updated_at || "") || 0,
    turns: s.transcript.length,
  };
}
/**
 * 侧栏只列「我自己的」，故意比 sessionAllowed 更窄：
 * 后者管的是「能不能打开」（管理员拿到同组织的链接可以打开），
 * 这里管的是「侧栏该不该出现」——把同事的任务铺进管理员的侧栏是另一种事故。
 * 没开账号体系（req.user 为空）本来就是一个人用；老会话没记归属的一律留着，别让升级上来的历史消失。
 */
function ownSession(user, row) {
  if (!user) return true;
  if (!row.user) return true;
  return row.user === user.username;
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
const imSessions = createImSessionStore({ dir: dataPath("data", "im-sessions") });
// 助理页的上下文以前全服务器共用一个键（local_assist），现在一人一段。老库里那一段就这么晾着的话，
// 升级完第一句话它就「突然失忆」——那段话本来就是管理员跟它说的，认到管理员名下即可
try {
  const boss = account.defaultUser();
  const bossKey = boss ? "local_" + prefs.keyOf(boss) : "";
  if (bossKey && imSessions.has("local_assist") && !imSessions.has(bossKey)) {
    imSessions.set(bossKey, imSessions.get("local_assist"));
    imSessions.clear((k) => k === "local_assist");
    console.log("[IM会话] 助理页上下文已按账号拆开，原来那段归到管理员名下");
  }
} catch (e) {
  console.warn("[IM会话] 助理页上下文迁移失败（不影响启动）:", e.message);
}

/** 包装 emit：把事件同时记录到 transcript（文本增量合并，跳过噪音事件），顺便中途存盘 */
// ---------- Goal 目标模式 ----------
// 用户给一个目标，先拆成可验收的标准，跑完一轮就对着标准验收，没达标自动再跑（最多 GOAL_MAX_ROUNDS 轮）。
// 验收宁严勿宽：拿不准一律算未达成——目标卡上打了勾就必须是真的
const GOAL_MAX_ROUNDS = 3;

function goalFileInventory(sess) {
  try {
    if (!sess.dir) return "（本对话还没有成果文件夹）";
    const dir = path.join(getWorkspaceDir(), sess.dir);
    const names = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
    if (!names.length) return "（成果文件夹是空的）";
    return names.slice(0, 40).map((n) => {
      try { const st = fs.statSync(path.join(dir, n)); return `${n}（${st.isDirectory() ? "目录" : st.size + " 字节"}）`; }
      catch { return n; }
    }).join("\n");
  } catch { return "（读取成果文件夹失败）"; }
}

/** 摘录最近改动的成果文件开头给验收员：光看文件名判「能不能用」纯靠猜，
 *  看到内容开头至少能核对结构是不是真的（有没有画布/按键监听/两个角色…）。只读文本类文件，最多 5 个 */
function goalFileSnippets(sess) {
  try {
    return recentGoalFiles(sess).map((f) => {
      let head = "";
      try { head = fs.readFileSync(f.p, "utf8").slice(0, 600); } catch { head = "（读取失败）"; }
      return `--- ${f.n}（共 ${f.size} 字节，以下是开头）---\n${head}`;
    }).join("\n\n");
  } catch { return ""; }
}

/** 最近改动的成果文本文件（新→旧，最多 5 个），内容摘录和自动体检共用一份清单 */
function recentGoalFiles(sess) {
  try {
    if (!sess.dir) return [];
    const dir = path.join(getWorkspaceDir(), sess.dir);
    const TEXT_EXT = /\.(html?|js|mjs|css|md|txt|json|py|ts|jsx|tsx|csv|svg)$/i;
    return fs.readdirSync(dir)
      .filter((n) => !n.startsWith(".") && TEXT_EXT.test(n))
      .map((n) => {
        try { const st = fs.statSync(path.join(dir, n)); return st.isFile() ? { n, p: path.join(dir, n), mtime: st.mtimeMs, size: st.size } : null; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
  } catch { return []; }
}

/** 验收员的「动手」环节：对成果文件做机器实测——JS 语法（node --check）、JSON 能否解析、
 *  HTML 是否写完整（截断/标签不配对）。只做只读检查，绝不执行成果代码。
 *  桌面版里 process.execPath 是 Electron 二进制，必须 ELECTRON_RUN_AS_NODE 才是纯 node */
function goalFileChecks(sess) {
  const { execFile } = require("child_process");
  const checkOne = (f) => new Promise((resolve) => {
    if (/\.(js|mjs|cjs)$/i.test(f.n)) {
      execFile(process.execPath, ["--check", f.p], { timeout: 8000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (err, _o, stderr) => {
        resolve(err ? `✗ ${f.n} JS 语法检查未通过：${String(stderr || err.message).slice(0, 200)}` : `✓ ${f.n} JS 语法检查通过`);
      });
    } else if (/\.json$/i.test(f.n)) {
      try { JSON.parse(fs.readFileSync(f.p, "utf8")); resolve(`✓ ${f.n} JSON 格式合法`); }
      catch (e) { resolve(`✗ ${f.n} JSON 解析失败：${String(e.message).slice(0, 120)}`); }
    } else if (/\.html?$/i.test(f.n)) {
      try {
        const t = fs.readFileSync(f.p, "utf8");
        const probs = [];
        if (/<html[\s>]/i.test(t) && !/<\/html>/i.test(t)) probs.push("有 <html> 没有 </html>，疑似写到一半被截断");
        const so = (t.match(/<script[\s>]/gi) || []).length, sc = (t.match(/<\/script>/gi) || []).length;
        if (so !== sc) probs.push(`<script> 开闭不配对（${so} 开 ${sc} 闭）`);
        resolve(probs.length ? `✗ ${f.n} 结构异常：${probs.join("；")}` : `✓ ${f.n} HTML 结构完整（html/script 标签配对）`);
      } catch { resolve(null); }
    } else resolve(null);
  });
  return Promise.all(recentGoalFiles(sess).map(checkOne)).then((rs) => rs.filter(Boolean).join("\n")).catch(() => "");
}

function parseJsonLoose(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * 把一次调用（或 agent 返回的一整轮）的用量并进本次任务的总账。
 *
 * 以前这件事在五个地方各手写一遍 `total.prompt += …; total.completion += …`，于是
 * llm.js 好不容易统一读出来的 cached 在这一层被五处同时丢掉——账本记的 cached 恒为 0，
 * 「有没有在反复全价重买同一段上下文」这个问题看不见，扣积分也没法给缓存打折。
 * 收成一个函数，以后 usage 再多一个字段只改这一处，不会有第六处漏掉。
 *
 * calls：llm.chat() 一次就是一次；agent 返回的 usage 自带 calls（里面是好多次），照抄。
 */
function addUsage(total, u) {
  if (!u) return;
  total.prompt += u.prompt || 0;
  total.completion += u.completion || 0;
  total.cached = (total.cached || 0) + (u.cached || 0);
  total.calls += u.calls != null ? u.calls : 1;
  total.elapsed_ms = (total.elapsed_ms || 0) + (u.elapsed_ms || 0);
}

/**
 * Goal 模式的「动脑」通道：拆验收标准、对着标准判分，这两句该问谁。
 *
 * 本机引擎（Claude Code / Codex）在跑时，就借那个 CLI 问——用户切过去图的就是不花 API 的钱，
 * 这两步却偷偷走 API：没配 Key 的人于是永远拆不出标准也验不了收，目标卡卡在 0/N 不动，
 * 从用户那边看就是「Goal 模式没做」。同一份订阅已经付过钱了，问它就是了。
 */
async function goalThink(sessLLM, { system, prompt, timeoutMs, total }) {
  const my = prefs.agentCfg(config); // 引擎是按账号存的，得看这一趟任务是谁发起的
  const id = my.engine || "builtin";
  if (id !== "builtin" && engines.get(id)) {
    return await engines.ask({ id, opts: (my.engine_options || {})[id] || {}, system, prompt, timeoutMs });
  }
  const r = await sessLLM.chat({
    system,
    history: [{ role: "user", content: prompt }],
    tools: [],
    signal: AbortSignal.timeout(timeoutMs),
  });
  addUsage(total, r.usage);
  return r.text;
}

/** 把目标拆成 3~6 条可验收标准。失败就用目标原文当唯一标准，绝不让任务卡在拆解上 */
async function deriveGoalCriteria(sessLLM, goalText, total, warn = () => {}) {
  try {
    const text = await goalThink(sessLLM, {
      system: '你是验收标准拆解器。把用户的目标拆成 3~6 条具体、可客观核验的验收标准（每条都能对着成果文件/事实判真假，不写"尽量""良好"这种没法验收的词）。只输出 JSON：{"criteria":["标准1","标准2"]}，不要其它任何文字。',
      prompt: String(goalText).slice(0, 2000),
      timeoutMs: 60000,
      total,
    });
    const j = parseJsonLoose(text);
    const list = (j && Array.isArray(j.criteria) ? j.criteria : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 6);
    if (list.length) return list;
    warn("拆不出验收标准（它没按格式回 JSON），这轮先拿目标原文当唯一标准");
  } catch (e) {
    // 吞掉异常等于让用户对着一张「1 项、永远不打勾」的目标卡发呆——留痕，让他知道是哪一步没成
    warn("拆验收标准失败：" + String((e && e.message) || e).slice(0, 120) + "，先拿目标原文当唯一标准");
  }
  return [String(goalText).slice(0, 200)];
}

/** 对着验收标准验一轮。只认成果文件清单和收尾汇报，拿不准算 false；验收调用挂了就全部保持原状 */
async function verifyGoal(sess, sessLLM, finalText, total, warn = () => {}) {
  const goal = sess.goal;
  const undone = goal.criteria.map((c, i) => ({ i, c })).filter((x) => !x.c.done);
  if (!undone.length) return;
  const snippets = goalFileSnippets(sess);
  const checks = await goalFileChecks(sess);
  try {
    const text = await goalThink(sessLLM, {
      system: '你是验收员。根据成果文件清单和执行汇报，逐条判断验收标准是否已达成。证据不足一律 false，宁可漏判不可错判。【自动体检】是机器实测结果（不是模型自述）：标 ✗ 的文件说明有语法错误或没写完整，涉及它的标准一律 false。只输出 JSON：{"results":[{"i":0,"done":true},{"i":1,"done":false}]}，i 是标准编号。',
      prompt:
        `【目标】${goal.text}\n\n【待验收标准】\n${undone.map((x) => `${x.i}. ${x.c.text}`).join("\n")}\n\n【成果文件清单】\n${goalFileInventory(sess)}\n\n` +
        (snippets ? `【成果文件内容摘录】\n${snippets}\n\n` : "") +
        (checks ? `【自动体检（机器实测）】\n${checks}\n\n` : "") +
        `【执行汇报】\n${String(finalText || "（无）").slice(0, 3000)}`,
      timeoutMs: 90000,
      total,
    });
    const j = parseJsonLoose(text);
    const results = j && Array.isArray(j.results) ? j.results : [];
    if (!results.length) warn("验收员没按格式回话，这一轮的打勾全部保持原状（宁可漏判不可错判）");
    for (const it of results) {
      const c = goal.criteria[it.i];
      if (c && it.done === true) c.done = true;
    }
  } catch (e) {
    // 静默失败最坑：目标卡一直 0/N，用户以为是活没干好，其实是验收这一步根本没跑通
    warn("验收没跑通：" + String((e && e.message) || e).slice(0, 120) + "，这一轮的打勾保持原状");
  }
  if (goal.criteria.every((c) => c.done)) goal.status = "done";
}

/**
 * 把任务事件翻译成桌面宠物的表情。只认深度 0 的事件——专家子代理的动静太密，
 * 宠物跟着抽风反而看不出主线在干什么。纯 node 模式下 global.__wbPet 不存在，整个是空操作。
 */
function petSay(ev) {
  const P = global.__wbPet;
  if (!P) return;
  try {
    switch (ev.type) {
      case "ask_user": P.alertAsk(ev.question); break;             // 跳 + 通知 + Dock 弹，最高一档
      case "ask_answer": P.clearAsk(true); break;
      case "tool_use": P.setState("working", "正在用 " + (ev.name || "工具")); break;
      case "expert_start": P.setState("working", `${ev.expert || "专家"} 接手了：${String(ev.task || "").slice(0, 40)}`); break;
      case "sleep": P.setState("sleep", ev.note); break;
      case "failover": P.setState("working", ev.note); break;
      case "limit": P.setState("error", ev.note); break;
      case "error": P.setState("error", String(ev.message || "任务出错了").slice(0, 80)); break;
      default: break;
    }
  } catch {}
}

function recordingEmit(send, events, sessionId) {
  return (ev) => {
    send(ev);
    if (!(ev.depth > 0)) petSay(ev);
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      const last = events[events.length - 1];
      if (last && last.type === "text") last.delta += ev.delta;
      else events.push({ type: "text", delta: ev.delta });
    } else if (ev.type === "files") {
      // 产出卡片得能活过一次重开：历史回放全靠这条事件重建。以前它不在存盘清单里，
      // 于是任务当场看得见成果卡，退出再进来那片卡就凭空消失了。
      // 但整份清单最多 500 条、每批工具跑完就来一次，原样存会把会话文件撑爆——
      // 只留这一批真正变更的那几条（回放时 renderFiles 被 isReplaying 挡住，用不到全量）
      const chg = ev.changed || [];
      // partial 是给回放用的实话：存下来的这份 files 已经被裁成「这一批变更」了，不是全量清单。
      // 前端拿不到全量就不能判定谁没了——早先没这个标记，回放时每来一批就把上一批的产出
      // 全盖上「已删除」，用户看到的是四个文件全被划掉，其实一个都没删
      if (chg.length) events.push({ type: "files", changed: chg, files: (ev.files || []).filter((f) => chg.includes(f.name)), partial: true, root: ev.root });
    } else if (["tool_use", "tool_result", "parallel", "expert_start", "expert_done", "error", "limit", "auto_continue", "failover", "sleep", "trim", "compact", "usage", "interject", "credits", "sources", "ask_user", "ask_answer", "milestones"].includes(ev.type)) {
      // 工具事件盖个时间戳（send 已经发出去了，这里只影响存盘）：回放时轨迹条才算得出每步耗时
      if (ev.type === "tool_use" || ev.type === "tool_result") ev.at = ev.at || Date.now();
      events.push(ev);
      // 一步走完就是个存盘点：跑了半小时的任务不该因为一次崩溃从头再来
      if (sessionId && ev.type === "tool_result") autosaveSession(sessionId);
    }
  };
}

const app = express();
// 大小写敏感路由。Express 默认是 false，于是 POST /API/settings 会命中 /api/settings 的
// 处理器，而 account.js 的 authGuard 和 admin.js 的门禁表都是用 startsWith 按**原样**路径
// 判的——把首字母改成大写就既不用登录、也绕开整张写表。判据那两处也一并小写化了（两头都堵，
// 只堵一头都会留下半扇门）。全仓路由注册和前端请求本来就全小写，打开这个开关不改变任何现有行为。
app.set("case sensitive routing", true);
app.use(express.json({ limit: "60mb" }));
app.use(express.static(appPath("public")));
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
      const mems = memory.renameScope(from, to); // 记忆也认登录名，不搬就成了孤儿
      console.log(`[账号] 登录名 ${from} → ${to}，${files} 条会话、${mems} 条记忆的归属已迁移`);
    },
  })
);
app.use(account.authGuard); // 其余 /api/* 与 /im/*（除外部回调）需要登录

// 租户工作目录 → 服务器级接口的闸 → 凭证脱敏。三段的说明都在 admin.js 里
app.use(admin.tenantScope({ withWorkspace, withPolicy, getWorkspaceDir }));
app.use(admin.platformGuard);
app.use(admin.redactGuard);
const ownsGlobalWorkspace = admin.ownsGlobalWorkspace;
/**
 * 界面靠它决定「服务器级的那些控件画不画」。画了却一点就 403，比不画更气人——
 * 用户看到的是一颗明明能点的按钮点了没反应，只能自己去猜是不是坏了。
 */
const isPlatformOwner = (req) => admin.isSoloDesktop() || ownsGlobalWorkspace(req && req.user);

// 企业管理后台 /api/admin/*：自带 adminGuard（管理员+审计员可看，只有管理员能改）
app.use(
  admin.createAdminRouter({
    // 「这个组织的成果目录占了多大」——直接数当前请求这条链上的根，跨租户不会串
    orgUsage: () => {
      const fs2 = outputFiles();
      const list = Array.isArray(fs2) ? fs2 : fs2.files || [];
      return { files: list.length, bytes: list.reduce((n, f) => n + (f.size || 0), 0) };
    },
  })
);

/**
 * 会话归属。会话文件是按 id 存的，接口只要拿到 id 就给内容——同一台服务器上的另一个账号
 * 猜中/拿到一个 id 就能读走整段对话（含产出文件名、模型原文）。这里补上归属判定：
 * 本人一定能看；管理员只能看**本组织**的；老会话没记 user 的按公共处理（不然升级上来全打不开）。
 */
function sessionAllowed(user, s) {
  if (!user || !s || !s.user) return true;
  if (s.user === user.username) return true;
  if (!account.canAdmin(user)) return false;
  const owner = account._internals.loadUsers().users.find((u) => u.username === s.user);
  return !owner || org.orgIdOf(owner) === org.orgIdOf(user);
}
function guardSession(req, res) {
  const s = getSession(req.params.id);
  if (sessionAllowed(req.user, s)) return s;
  res.status(403).json({ error: "这条对话不属于你" });
  return null;
}
/**
 * 正在跑的那个任务，这次请求的人碰不碰得到。
 *
 * 插队 / 回答 / 停止 / 续流这四条走的是 body.sessionId 或自己的 :id，绕开了 guardSession，
 * 以前一个字都没查归属：知道一个会话 id，就能往别人正在跑的任务里塞一句话、替他回答
 * agent 弹出来的问题、把他的任务掐掉，或者把他的实时输出整段读走。会话 id 是
 * s_<时间戳>_<随机数>，但它会出现在链接、日志、截图里，不是秘密，更不该当权限用。
 * 判据跟 guardSession 同一条（sessionAllowed）：本人放行，管理员限同组织，没记归属的老会话照旧。
 */
function guardRun(req, res, id) {
  if (sessionAllowed(req.user, getSession(id))) return true;
  res.status(403).json({ ok: false, error: "这条对话不属于你" });
  return false;
}

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

// 版本 / 更新检查。查的是 GitHub Releases，最快 6 小时一次（force=1 强查）。
// 界面上「有没有新版」和「你这种装法怎么升」是一起给的——只报版本号等于没说。
const updater = require("./updater");
app.get("/api/update", async (req, res) => {
  res.json(await updater.checkUpdate({ force: req.query.force === "1" }));
});

app.get("/api/files", (_req, res) => res.json(outputFiles()));

// 助理身份：界面一进来就要拿它画头像，所以单开一个轻接口，不用为了个名字去拉整份设置
app.get("/api/assistant", (_req, res) => res.json(config.assistant));

// ---------- 应用内设置（模型 + IM），保存到 config.json 并热生效 ----------
app.get("/api/settings", (req, res) => {
  // 个人偏好压在全局配置上面。没有个人偏好文件时这几个 *Cfg 原样返回 config 的那一份
  const myAgent = prefs.agentCfg(config);
  const myPet = prefs.petCfg(config);
  const myModel = prefs.modelCfg(config);
  res.json({
    workspace_dir: getWorkspaceDir(),
    models: config.models,
    active_model: config.active_model,
    model_health: healthSummary(),
    // 界面靠它决定「服务器级的那些输入框画不画」：画了却一存就 403，比不画更气人
    platform_owner: isPlatformOwner(req),
    model_follow_last: myModel.model_follow_last,
    last_picked_model: myModel.last_picked_model,
    assist_model: myModel.assist_model,
    agent: {
      max_steps: config.agent.max_steps,
      tool_timeout_ms: config.agent.tool_timeout_ms,
      max_runtime_ms: config.agent.max_runtime_ms || 1800000,
      auto_continue_rounds: config.agent.auto_continue_rounds || 0,
      llm_timeout_ms: config.agent.llm_timeout_ms || 300000,
      max_context_chars: config.agent.max_context_chars || 120000,
      max_tokens_budget: config.agent.max_tokens_budget || 0,
      failover_model: config.agent.failover_model || "",
      thinking: thinking.norm(myAgent.thinking), // 思考模式档位，默认 auto=跟随模型自己的默认
      engine: myAgent.engine || "builtin",
      // 前端那个模型选择器要靠它说实话：走本机 CLI 的时候，API 模型列表整个不生效
      engine_label: (engines.list().find((e) => e.id === (myAgent.engine || "builtin")) || {}).label || "",
      engine_options: myAgent.engine_options || {},
    },
    pet: {
      enabled: myPet.enabled === true, // 默认没有宠物：得用户在对话里开口要，或来这儿手动打开
      character: myPet.character || "cat",
      scale: myPet.scale || pet.DEFAULT_SCALE,
      opacity: myPet.opacity || 1,
      notify: myPet.notify !== false,
      notify_done: myPet.notifyDone !== false,
      wander: myPet.wander === true,
      sprite: myPet.sprite || "",
      has_photo: !!petPhotoPath(),
      // 本机装了哪些精灵图宠物（~/.codex/pets、~/.petdex/pets、data/pets）。
      // 扫的是文件头不是整张图，几毫秒的事，跟设置一起返回省一次往返。
      sprites: petSprites.scanPets().map((x) => ({ id: x.id, name: x.displayName, source: x.source, ok: x.ok, why: x.why })),
      available: !!global.__wbPet, // 纯 node 模式没有桌面窗口，前端要如实说明
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
      tts: { base_url: "", api_key: "", model: "", voice: "", ...((config.media || {}).tts || {}) },
      vision: { base_url: "", api_key: "", model: "", ...((config.media || {}).vision || {}) },
    },
    security: config.security,
    shortcuts: prefs.shortcutsCfg(config),
  });
});

/**
 * 个人偏好落盘：底层引擎、思考档、上次选的模型、宠物开关、全局快捷键。
 *
 * 校验一条都不能省。这些值不是摆设——引擎名写错会让任务在启动那一刻就炸，思考档写错
 * 会让「我明明关了思考」和账单对不上。所以宁可当场 400，也绝不悄悄退回默认值。
 * 抛出去的错由 /api/settings 那层的 try/catch 变成 400，跟全局设置的错误路径同一条。
 */
/**
 * 这次的「个人偏好」该落哪儿。
 *
 * false（落 config.json）：个人桌面版——屏幕前就一个人，config 就是他的偏好；而且 Electron 壳
 *   在任何人登录之前就要靠 config.pet / config.shortcuts 把宠物和快捷键装起来，写别处等于重启后消失。
 *   平台管理员同理：他设的那份是这台机器的默认，定时任务和 IM 消息没有「当前登录的人」，只能读 config。
 * true（落 data/prefs/<账号>.json）：多人服务器上的其他人，谁也不覆盖谁。
 */
function ownPrefs(req) {
  return !(admin.isSoloDesktop() || ownsGlobalWorkspace(req && req.user));
}

function savePersonalPrefs(user, personal) {
  const out = {};
  if (personal.agent) {
    const a = {};
    if (personal.agent.engine !== undefined) {
      const id = String(personal.agent.engine || "builtin").trim() || "builtin";
      if (engines.get(id) === undefined) throw new Error("没有这个底层引擎：" + id);
      a.engine = id;
    }
    if (personal.agent.thinking !== undefined) {
      const lv = String(personal.agent.thinking || "").trim().toLowerCase();
      if (!thinking.LEVELS.includes(lv)) throw new Error("没有这个思考模式档位：" + lv);
      a.thinking = lv;
    }
    if (personal.agent.engine_options && typeof personal.agent.engine_options === "object") {
      const eo = {};
      for (const [id, v] of Object.entries(personal.agent.engine_options)) {
        if (engines.get(id) === undefined) continue; // 前端可能带上已经不存在的引擎，忽略即可，不值得整单失败
        const cur = {};
        if (v.model !== undefined) cur.model = String(v.model || "").trim();
        if (v.thinking !== undefined) {
          const lv = String(v.thinking || "").trim().toLowerCase();
          if (lv && !thinking.LEVELS.includes(lv)) throw new Error("没有这个思考模式档位：" + lv);
          cur.thinking = lv; // 空串 = 这个引擎跟随全局档位
        }
        if (Object.keys(cur).length) eo[id] = cur;
      }
      if (Object.keys(eo).length) a.engine_options = eo;
    }
    if (Object.keys(a).length) out.agent = a;
  }
  if (typeof personal.model_follow_last === "boolean") out.model_follow_last = personal.model_follow_last;
  if (personal.last_picked_model !== undefined) {
    const n = String(personal.last_picked_model || "").trim();
    if (n && !(config.models || []).some((m) => m.name === n)) throw new Error(`模型「${n}」不在模型列表里`);
    out.last_picked_model = n;
  }
  if (personal.pet && typeof personal.pet === "object") {
    const q = {};
    for (const k of ["enabled", "notify", "notifyDone", "wander"]) if (typeof personal.pet[k] === "boolean") q[k] = personal.pet[k];
    if (personal.pet.sprite !== undefined) {
      const sp = String(personal.pet.sprite || "").slice(0, 80);
      if (sp && !petSprites.findPet(sp)) throw new Error("没找到这只精灵图宠物（或它的图集不合规）：" + sp);
      q.sprite = sp;
    }
    if (personal.pet.character !== undefined) {
      const c = personal.pet.character === "photo" ? "photo" : personal.pet.character === "sprite" ? "sprite" : "cat";
      const sp = q.sprite !== undefined ? q.sprite : (prefs.read(user).pet || {}).sprite || "";
      if (c === "sprite" && !sp) throw new Error("先选一只精灵图宠物，再切到这个形象");
      q.character = c;
    }
    if (personal.pet.scale !== undefined) q.scale = Math.max(0.6, Math.min(2, Number(personal.pet.scale) || pet.DEFAULT_SCALE));
    if (personal.pet.opacity !== undefined) q.opacity = Math.max(0.25, Math.min(1, Number(personal.pet.opacity) || 1));
    if (Object.keys(q).length) out.pet = q;
  }
  if (personal.shortcuts && typeof personal.shortcuts === "object") {
    const sc = {};
    for (const [k, v] of Object.entries(personal.shortcuts)) if (typeof v === "string" && v.length < 60) sc[k] = v;
    out.shortcuts = sc;
  }
  if (!Object.keys(out).length) return null;
  return prefs.write(user, out);
}

app.post("/api/settings", (req, res) => {
  try {
    let b = req.body || {};
    /**
     * 个人偏好分流。
     *
     * 谁写 config.json：个人桌面版（屏幕前就一个人，config 就是他的偏好；而且 Electron 壳在
     * 任何人登录之前就要靠 config.pet / config.shortcuts 把宠物和快捷键装起来），
     * 以及多人服务器上的平台管理员（他设的那份是这台机器的默认——定时任务和 IM 消息没有
     * 「当前登录的人」，只能读 config）。
     * 其余人写各自的 data/prefs/<账号>.json，谁也不覆盖谁。
     */
    if (ownPrefs(req)) {
      const { personal, rest } = prefs.split(b);
      const saved = Object.keys(personal).length ? savePersonalPrefs(req.user, personal) : null;
      b = rest;
      // 整单都是个人项：config 一个字节都不用动，也别白跑一次 saveConfig
      if (!Object.keys(b).length) return res.json({ ok: true, personal: true, saved: !!saved });
    }
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
    if (typeof b.model_follow_last === "boolean") config.model_follow_last = b.model_follow_last;
    if (b.agent) {
      if (b.agent.max_steps) config.agent.max_steps = Math.max(1, Math.min(100, +b.agent.max_steps));
      if (b.agent.tool_timeout_ms) config.agent.tool_timeout_ms = Math.max(5000, +b.agent.tool_timeout_ms);
      if (b.agent.max_runtime_ms) config.agent.max_runtime_ms = Math.max(60000, +b.agent.max_runtime_ms);
      if (b.agent.auto_continue_rounds !== undefined) config.agent.auto_continue_rounds = Math.max(0, Math.min(20, Math.round(+b.agent.auto_continue_rounds) || 0));
      if (b.agent.llm_timeout_ms) config.agent.llm_timeout_ms = Math.max(30000, +b.agent.llm_timeout_ms);
      // 下限 2 万字符：再小连最近几步的工具原文都留不住，agent 会失忆式反复重做
      if (b.agent.max_context_chars) config.agent.max_context_chars = Math.max(20000, Math.min(2000000, +b.agent.max_context_chars));
      if (b.agent.max_tokens_budget !== undefined) config.agent.max_tokens_budget = Math.max(0, Math.round(+b.agent.max_tokens_budget) || 0);
      if (b.agent.thinking !== undefined) {
        const lv = String(b.agent.thinking || "").trim().toLowerCase();
        // 写错档位当场拒绝，不悄悄退回 auto：用户以为关掉了思考、账单却照着思考的量涨
        if (!thinking.LEVELS.includes(lv)) throw new Error("没有这个思考模式档位：" + lv);
        config.agent.thinking = lv;
      }
      if (b.agent.failover_model !== undefined) {
        const fm = String(b.agent.failover_model || "").trim();
        if (fm && !config.models.some((m) => m.name === fm)) throw new Error("备用渠道不在模型列表中");
        config.agent.failover_model = fm; // 空串 = 关闭自动换道（默认）
      }
      if (b.agent.engine !== undefined) {
        const id = String(b.agent.engine || "builtin").trim() || "builtin";
        // 写错名字当场拒绝。悄悄退回内置 = 用户以为在用免费的本机订阅，账单却在涨
        if (engines.get(id) === undefined) throw new Error("没有这个底层引擎：" + id);
        config.agent.engine = id;
      }
      if (b.agent.engine_options && typeof b.agent.engine_options === "object") {
        config.agent.engine_options = config.agent.engine_options || {};
        for (const [id, v] of Object.entries(b.agent.engine_options)) {
          if (engines.get(id) === undefined) continue;
          if (!v || typeof v !== "object") continue;
          const cur = (config.agent.engine_options[id] = config.agent.engine_options[id] || {});
          for (const k of ["model", "bin", "permissionMode", "sandbox"]) if (v[k] !== undefined) cur[k] = String(v[k] || "").trim();
          if (v.thinking !== undefined) {
            const lv = String(v.thinking || "").trim().toLowerCase();
            if (lv && !thinking.LEVELS.includes(lv)) throw new Error("没有这个思考模式档位：" + lv);
            cur.thinking = lv; // 空串 = 这个引擎跟随全局档位
          }
          if (v.network !== undefined) cur.network = !!v.network;
          if (Array.isArray(v.extraArgs)) cur.extraArgs = v.extraArgs.map((x) => String(x)).slice(0, 20);
        }
      }
    }
    if (b.pet) {
      const cur = config.pet || {};
      // 精灵图那两个字段先验后写：这个 handler 一路在往 config 上直接赋值，
      // 半路 return 400 会留下「内存里改了、盘上没存」的半拉状态。所以校验全部前置。
      const nextSprite = b.pet.sprite !== undefined ? String(b.pet.sprite || "").slice(0, 80) : cur.sprite || "";
      const nextChar = b.pet.character === undefined ? cur.character || "cat"
        : b.pet.character === "photo" ? "photo" : b.pet.character === "sprite" ? "sprite" : "cat";
      // 存一个扫不到的 id 进去，结果是宠物窗口悄悄回落成内置猫，
      // 用户体感是「换了但没生效」——不如当场拒了，把原因说清楚。
      if (nextSprite && !petSprites.findPet(nextSprite)) return res.status(400).json({ error: "没找到这只精灵图宠物（或它的图集不合规）：" + nextSprite });
      if (nextChar === "sprite" && !nextSprite) return res.status(400).json({ error: "先选一只精灵图宠物，再切到这个形象" });

      config.pet = cur;
      if (typeof b.pet.enabled === "boolean") config.pet.enabled = b.pet.enabled;
      if (typeof b.pet.notify === "boolean") config.pet.notify = b.pet.notify;
      if (typeof b.pet.notifyDone === "boolean") config.pet.notifyDone = b.pet.notifyDone;
      if (typeof b.pet.wander === "boolean") config.pet.wander = b.pet.wander;
      config.pet.sprite = nextSprite;
      config.pet.character = nextChar;
      if (b.pet.scale !== undefined) config.pet.scale = Math.max(0.6, Math.min(2, Number(b.pet.scale) || pet.DEFAULT_SCALE));
      if (b.pet.opacity !== undefined) config.pet.opacity = Math.max(0.25, Math.min(1, Number(b.pet.opacity) || 1));
      if (global.__wbPet) try { global.__wbPet.applyConfig({ ...config.pet, enabled: config.pet.enabled === true }); } catch {}
    }
    if (b.evolve) {
      config.evolve = config.evolve || {};
      // 默认关：每晚要调一次模型，是花钱的事，得你自己点开
      if (typeof b.evolve.auto === "boolean") config.evolve.auto = b.evolve.auto;
      if (b.evolve.hour !== undefined) config.evolve.hour = Math.max(0, Math.min(23, Math.round(+b.evolve.hour) || 0));
      if (b.evolve.days !== undefined) config.evolve.days = Math.max(1, Math.min(365, Math.round(+b.evolve.days) || 14));
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
    if (b.workspace_dir !== undefined && b.workspace_dir !== getDefaultWorkspaceDir()) {
      config.workspace_dir = setWorkspaceDir(b.workspace_dir);
      // 输入框旁的快速切换是临时的（新任务会切回项目目录）；设置中心改路径才算改默认，同步进当前项目
      if (b.workspace_permanent === true) {
        ensureProjects();
        const ap = config.projects.find((p) => p.name === config.active_project);
        if (ap) ap.dir = config.workspace_dir;
      }
    }
    config.im = config.im || {};
    if (b.im) {
      const clear = new Set(Array.isArray(b.im.clear) ? b.im.clear.map(String) : []);
      if (b.im.feishu) imAssign(config.im.feishu = config.im.feishu || {}, b.im.feishu, ["app_id", "app_secret", "verification_token", "doc_app_id", "doc_app_secret"], clear, "feishu.");
      if (b.im.qq) imAssign(config.im.qq = config.im.qq || {}, b.im.qq, ["app_id", "app_secret"], clear, "qq.");
      if (b.im.wecom_app) imAssign(config.im.wecom_app = config.im.wecom_app || {}, b.im.wecom_app, ["corp_id", "agent_id", "secret", "token", "aes_key"], clear, "wecom_app.");
      if (b.im.wechat_mp) imAssign(config.im.wechat_mp = config.im.wechat_mp || {}, b.im.wechat_mp, ["app_id", "app_secret", "token", "aes_key"], clear, "wechat_mp.");
      imAssign(config.im, b.im, ["wecom_bot_webhook", "dingtalk_webhook", "dingtalk_secret", "webhook_secret"], clear, "");
      if (b.im.session_idle_hours !== undefined) config.im.session_idle_hours = Math.max(0, Math.min(720, +b.im.session_idle_hours || 0));
    }
    if (b.media) {
      config.media = config.media || {};
      for (const kind of ["image", "video", "tts", "vision"]) {
        if (b.media[kind]) {
          const c = (config.media[kind] = config.media[kind] || {});
          for (const k of ["base_url", "api_key", "model", "voice"]) {
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
    memory.setEmbedder(createEmbedder(config));
    memory.ensureVectors().catch(() => {});
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
  // Claude 那条渠道的地址算法只有一份（llm.js 的 anthropicBase），验活和真跑必须打同一个地址：
  // 否则填了中转的人验活验的是中转、跑起来打的是官方，绿勾骗人
  const url = anthropic
    ? anthropicBase(m.base_url).messagesUrl
    : (m.base_url || "https://api.openai.com/v1").replace(/\/$/, "") + "/chat/completions";
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

/**
 * 首次开箱向导要的一张「体检表」：每项能力配没配、配的是什么，一次性给全。
 *
 * 为什么不让前端各拉各的接口再拼：向导弹在登录后第一屏，多拉五个接口就是多五次转圈；
 * 而且「大脑到底算不算接上了」只有服务端知道——走本机 Claude Code / Codex 时根本不需要 API Key，
 * 前端只看 has_key 会把已经能用的人拦在门口。
 *
 * seen = 用户走完（或明确跳过）过一次向导。没走完的每次打开都弹，走完的只在「设置 → 关于」里能再打开。
 */
app.get("/api/onboarding", async (req, res) => {
  const models = (config.models || []).map((m) => ({
    name: m.name,
    model: m.model,
    base_url: m.base_url || "",
    local: isLocalModel(m),
    has_key: hasKey(m),
  }));
  const active = (config.models || []).find((m) => m.name === config.active_model) || (config.models || [])[0];
  const myAgent = prefs.agentCfg(config);
  const engineId = myAgent.engine || "builtin";
  const brainViaEngine = engineId !== "builtin" && engines.get(engineId) !== undefined;
  const brainOk = brainViaEngine || !!(active && hasKey(active));
  const seen = !!((config.onboarding || {}).done_at);

  // 本机 CLI 探测要跑 which + --version，只在向导真会弹出来的时候做，老用户每次开机别白等
  let found = [];
  if (!brainOk || !seen) {
    try { found = await engines.detectAll(myAgent.engine_options || {}); } catch {}
  }
  const media = config.media || {};
  const mediaOk = (kind) => { const c = media[kind] || {}; return !!(c.base_url && c.api_key); };
  const im = config.im || {};
  const pair = (o, ...ks) => !!(o && ks.every((k) => String(o[k] || "").trim()));
  const imConfigured = [
    pair(im.feishu, "app_id", "app_secret"),
    pair(im.qq, "app_id", "app_secret"),
    pair(im.wecom_app, "corp_id", "secret", "agent_id"),
    pair(im.wechat_mp, "app_id", "app_secret"),
    pair(im.wechat_ilink, "bot_token", "ilink_bot_id"),
    !!String(im.wecom_bot_webhook || "").trim(),
    !!String(im.dingtalk_webhook || "").trim(),
  ].filter(Boolean).length;
  const sp = (config.search || {}).provider || "jina";
  res.json({
    // 大脑没接上 = 一句话都发不出去，必须弹引导；接上了但没走完向导也弹一次，让人知道还有哪些能力可以开
    needs_setup: !brainOk,
    seen,
    // 向导最后一步写的是服务器级设置（工作目录 + done_at），只有平台管理员落得了盘。
    // 成员那边压根不该弹：弹了他一步步认真填完，最后一颗「开始使用」必然 403，退都退不出去。
    can_finish: isPlatformOwner(req),
    brain: {
      ok: brainOk,
      via: brainViaEngine ? "engine" : "api",
      name: brainViaEngine ? engineId : (active ? active.name : ""),
      model: brainViaEngine ? ((config.agent.engine_options || {})[engineId] || {}).model || "" : (active ? active.model : ""),
    },
    active_model: config.active_model,
    workspace_dir: getWorkspaceDir(),
    models,
    any_key: models.some((m) => m.has_key && !m.local),
    engines: found.map((e) => ({ id: e.id, label: e.label, installed: e.installed, version: e.version, install: e.install || "", note: e.note || "" })),
    engine: engineId,
    search: { provider: sp, has_key: !!searchProviderKey(config.search || {}, sp) },
    media: { image: mediaOk("image"), video: mediaOk("video"), tts: mediaOk("tts"), vision: mediaOk("vision") },
    im: { configured: imConfigured },
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
    memory.setEmbedder(createEmbedder(config));
    memory.ensureVectors().catch(() => {});
    saveConfig();
    res.json({ ok: true, active_model: config.active_model, model: llm.model, workspace_dir: getWorkspaceDir() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 向导走完 / 明确跳过：记一笔，下次开机不再弹。大脑没接上时不许记——记了等于把一个什么都干不了的界面留给用户
app.post("/api/onboarding/done", (req, res) => {
  try {
    const b = req.body || {};
    const active = (config.models || []).find((m) => m.name === config.active_model) || (config.models || [])[0];
    const engineId = prefs.agentCfg(config).engine || "builtin";
    const brainOk = (engineId !== "builtin" && engines.get(engineId) !== undefined) || !!(active && hasKey(active));
    if (!brainOk) return res.status(400).json({ ok: false, error: "还没接上任何大模型，先把第一步走完" });
    if (b.workspace_dir) {
      config.workspace_dir = setWorkspaceDir(b.workspace_dir);
      ensureProjects();
      const ap = config.projects.find((p) => p.name === config.active_project);
      if (ap) ap.dir = config.workspace_dir;
    }
    const skipped = Array.isArray(b.skipped) ? b.skipped.map((x) => String(x).slice(0, 20)).slice(0, 10) : [];
    config.onboarding = { done_at: Date.now(), skipped };
    saveConfig();
    res.json({ ok: true, workspace_dir: getWorkspaceDir(), skipped });
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
/**
 * 审批看得见谁的、批得动谁的。
 *
 * 返回 undefined = 不限定（平台管理员，以及双击打开的桌面版——那儿屏幕前就一个人）。
 * 返回登录名 = 只限定他自己那条：审批卡片上写的是别人任务要跑的整条命令，路径、域名、
 * 脚本片段都在里面，多人共用一台服务器时那是别人的东西。
 */
const approvalScope = (req) =>
  admin.isSoloDesktop() || admin.platformAdmin(req.user) ? undefined : (req.user && req.user.username) || "";
app.get("/api/security/approvals", (req, res) => {
  const scopeTo = approvalScope(req);
  res.json({
    items: security.listApprovals(scopeTo),
    mode: security.permissionMode(config.security),
    session_allow: security.listSessionAllow(),
    // 界面照这个决定要不要画「一直允许」那颗按钮：会 403 的按钮不该摆在那儿
    can_always: scopeTo === undefined,
  });
});
/**
 * 批准/拒绝一条审批。scope：once 只这一次 / session 本次运行期间同类不再问 / always 永久写进放行名单。
 * always 要落盘——「一直允许」点完重启又来问，等于没这个按钮；落盘的规则在安全中心看得见、删得掉。
 *
 * 三档里只有 always 是「改这台服务器」：它把规则写进 config 的永久放行名单，对所有人生效。
 * 所以非平台管理员的 always 降一档按 session 处理，而不是回 403——他那个任务正挂着等这个回答，
 * 403 换来的是任务干等到超时。降了要在返回里说清楚，界面照实说，不许悄悄换个档还报「已永久放行」。
 */
app.post("/api/security/approvals/:id", (req, res) => {
  const body = req.body || {};
  const scopeTo = approvalScope(req);
  const { scope, downgraded } = security.effectiveScope(body.scope, scopeTo !== undefined);
  const r = security.resolveApproval(req.params.id, !!body.allow, scope, scopeTo);
  if (!r.ok) {
    return res
      .status(r.forbidden ? 403 : 409)
      .json({ ...r, error: r.error || "这条审批已经结束了（等超时了，或者别处已经点过）" });
  }
  if (r.ok && body.allow && scope === "always" && r.ruleKey) {
    const sec = security.getSecurity(config);
    const list = Array.isArray(sec.cmd_allow) ? sec.cmd_allow : [...(security.DEFAULTS.cmd_allow || [])];
    if (!list.includes(r.ruleKey)) {
      list.push(r.ruleKey);
      sec.cmd_allow = list;
      saveConfig();
    }
  }
  res.json({ ...r, scope, downgraded });
});
app.get("/api/security/modes", (req, res) =>
  // can_switch：档位是整台服务器一份（决定 agent 动手前问不问），普通成员改不了。
  // 界面拿它决定那个 🛡️ 菜单画成可点的还是只读的——不然点下去只有一句「切换失败」。
  res.json({ modes: security.PERMISSION_MODES, current: security.permissionMode(config.security), can_switch: isPlatformOwner(req) })
);
app.post("/api/security/mode", (req, res) => {
  // 自守一道，别只靠门禁表。这个开关一改，全站的 agent 动手前问不问就变了——
  // 「只有一层前缀表把门」的东西，表上出一点差错就是整台机器的审批被人关掉。
  // 上面那条 GET 已经回了 can_switch: isPlatformOwner(req)，判据用同一个，不会出现「界面说能改、后端不让」。
  if (!isPlatformOwner(req)) return res.status(403).json({ error: "权限档位是整台服务器一份的，归平台管理员管", platform_only: true });
  const mode = String((req.body || {}).mode || "");
  if (!security.PERMISSION_MODES[mode]) return res.status(400).json({ error: "未知的权限档位" });
  security.getSecurity(config).permission_mode = mode; // 走 getSecurity 补默认值，别把别的字段挤掉
  saveConfig();
  security.audit("权限档位", `切换到「${security.PERMISSION_MODES[mode].label}」`, "放行");
  res.json({ ok: true, mode });
});
app.post("/api/security/session-allow/clear", (_req, res) => {
  security.clearSessionAllow();
  res.json({ ok: true });
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
// 底层引擎：探测本机装没装 Claude Code / Codex。只跑 --version，不消耗任何额度
app.get("/api/engines", async (req, res) => {
  try {
    // ?force=1 = 用户点了「重新检测本机」（刚装完 CLI，必须当场看见）；平时吃缓存，别每开一次设置页就起一堆子进程
    const myAgent = prefs.agentCfg(config); // 「当前用的是哪个引擎」是按账号的，别把别人选的报给他
    const found = await engines.detectAll(myAgent.engine_options || {}, { force: req.query.force === "1" });
    res.json({ current: myAgent.engine || "builtin", builtin: engines.BUILTIN, engines: found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 思考模式：每一档到底会发什么，如实报给设置页。
 *
 * 为什么不让前端自己写死一张表：各家的参数名一年能改两回，而「这一档对你选的这个模型
 * 到底生不生效」只有服务端知道（要看 provider、base_url、模型名，走本机 CLI 时还要看
 * 那个 CLI 认不认这个选项）。写死在前端 = 界面上写着"已关闭"、实际一个参数都没发出去。
 *
 * 所以这里把 5 个档位逐个算一遍，supported=false 的连同原因一起给出去，界面照抄。
 */
app.get("/api/thinking", async (req, res) => {
  try {
    const myAgent = prefs.agentCfg(config);
    const engineId = myAgent.engine || "builtin";
    const entry = (config.models || []).find((m) => m.name === config.active_model) || (config.models || [])[0] || {};
    // 本机 CLI 的能力探测（claude 对不认识的选项是静默忽略的，非探不可），探不动就当没有
    let caps = {};
    if (engineId !== "builtin") {
      try {
        const found = await engines.detectAll(myAgent.engine_options || {});
        caps = (found.find((e) => e.id === engineId) || {}).caps || {};
      } catch {}
    }
    const levels = thinking.LEVELS.map((lv) => {
      const api = thinking.planFor(entry, lv);
      const eng = engineId === "builtin" ? null : thinking.planForEngine(engineId, lv, caps);
      const active = eng || api;
      return { level: lv, label: thinking.LEVEL_LABEL[lv], supported: active.supported, note: active.note };
    });
    res.json({
      current: thinking.norm(myAgent.thinking),
      via: engineId === "builtin" ? "api" : "engine",
      target: engineId === "builtin" ? (entry.name || "") : engineId,
      levels,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 一键连接：真的连一次，不是看看文件在不在。
 *
 * 设置页上「已装 ✓」和「装了但没登录」长得一模一样——用户点了切换，然后每个任务都在
 * 原地报错。这个接口花几十个 token 真跑一句话过去，把「能用 / 没登录 / 限流 / 装坏了」
 * 分开告诉用户，并且给出下一步该干什么。跑在系统临时目录里，不往工作区留东西。
 */
app.post("/api/engines/test", async (req, res) => {
  const id = String((req.body && req.body.id) || "").trim();
  if (!id || id === "builtin") return res.status(400).json({ error: "内置引擎不用测，它走的是你配的 API Key" });
  try {
    // 用户可能刚在输入框里改了路径/模型还没保存，先用他正在填的那份测
    const saved = (prefs.agentCfg(config).engine_options || {})[id] || {};
    const patch = (req.body && req.body.options) || {};
    const opts = { ...saved };
    // bin 是「起哪个可执行文件」——在多人服务器上等于任意命令执行。只有平台管理员能指定，
    // 其他人一律用已保存的那份（他们本来也改不了它）
    const fields = ownPrefs(req) ? ["model"] : ["bin", "model"];
    for (const k of fields) if (patch[k] !== undefined) opts[k] = String(patch[k] || "").trim();
    for (const k of Object.keys(opts)) if (!opts[k]) delete opts[k];
    res.json(await engines.testConnect(id, opts));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 预设目录：常用 MCP 服务器一键接入；顺带告诉前端本机找没找到 npx / uvx
app.get("/api/mcp/catalog", (_req, res) => {
  const configured = new Set((config.mcp_servers || []).map((s) => s.name));
  const cat = mcpCatalog.catalog();
  res.json({ ...cat, items: cat.items.map((it) => ({ ...it, configured: configured.has(it.name) })) });
});

app.get("/api/mcp", (_req, res) => {
  const view = (s, plugin) => {
    const client = mcpManager.clients.get(s.name);
    const failure = mcpManager.failures.find((f) => f.name === s.name);
    return {
      name: s.name,
      command: s.command || "",
      args: s.args || [],
      // 环境变量里基本都是 API Key，和请求头一样只回键名，不回值
      env_keys: Object.keys(s.env || {}),
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
  // env 里是 API Key，GET 只回键名；前端原样存回来时不带 env，就沿用原来那份
  const prev = prevByName.get(name);
  const env = s.env && typeof s.env === "object"
    ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [String(k), String(v)]))
    : (prev && prev.env) || {};
  for (const k of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`${at}的环境变量名「${k}」不合法（只能字母、数字、下划线，不能以数字开头）`);
  return { name, transport: "stdio", command, args: Array.isArray(s.args) ? s.args.map(String) : [], env };
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
/**
 * 项目自带的「指令」和挂载的专家/技能/连接器。
 * 指令不是装饰：切到这个项目之后，它会进系统提示词（见 accountedRuntime），
 * 否则用户在弹窗里写一大段项目背景，agent 一个字都看不见。
 */
function projectMeta(body) {
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 30) : []);
  return {
    instructions: String(body.instructions || "").slice(0, 4000),
    connectors: arr(body.connectors),
    experts: arr(body.experts),
    skills: arr(body.skills),
  };
}
function activeProject() {
  ensureProjects();
  return config.projects.find((p) => p.name === config.active_project) || null;
}

/**
 * 组装进系统提示词的项目上下文：指令 + 挂载清单。
 * 挂载在弹窗里勾了才有；勾过但后来被删掉的专家/技能/连接器要过滤掉，不然提示词里指着空气让 agent 用。
 */
function projectContextOf(p) {
  if (!p) return "";
  const parts = [];
  if (p.instructions) parts.push(p.instructions);
  const alive = (names, pool) => (names || []).filter((n) => pool.includes(n));
  const exps = alive(p.experts, experts.map((e) => e.name));
  if (exps.length) parts.push(`本项目挂载的专家：${exps.join("、")}。相应领域的子任务优先 delegate_to_expert 委派给他们。`);
  let skillNames = [];
  try { skillNames = skillsMgr.loadSkills().map((s) => s.name); } catch {}
  const sks = alive(p.skills, skillNames);
  if (sks.length) parts.push(`本项目挂载的技能：${sks.join("、")}。做对应任务前先 use_skill 加载，按技能里的规范执行。`);
  const conns = alive(p.connectors, (config.mcp_servers || []).map((s) => s.name));
  if (conns.length) parts.push(`本项目挂载的连接器：${conns.join("、")}。涉及外部系统时优先用这些连接器提供的工具。`);
  // 项目目录里的 AGENTS.md / CLAUDE.md 是写给 agent 看的项目规范（pi / Claude Code 的通行惯例），
  // 用户既然放了就自动带上，不用再往项目指令里手抄一遍
  try {
    for (const fname of ["AGENTS.md", "CLAUDE.md"]) {
      if (!p.dir) break;
      const fp = path.join(p.dir, fname);
      if (!fs.existsSync(fp)) continue;
      const txt = fs.readFileSync(fp, "utf8").trim().slice(0, 6000);
      if (txt) parts.push(`项目目录里的 ${fname}（项目既定规范，必须遵守）：\n${txt}`);
      break;
    }
  } catch {}
  return parts.join("\n\n");
}

function ensureProjects() {
  if (!Array.isArray(config.projects) || !config.projects.length) {
    config.projects = [{ name: "默认项目", dir: getDefaultWorkspaceDir() }];
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

app.get("/api/projects", (req, res) => {
  // 租户看到的是自己那一个根，不是总部的项目清单——后者连目录名都是信息。
  // 以前这里编了个叫「本组织工作目录」的假项目顶上，两头都出事：侧栏多一个点不动的 tab，
  // 而且这个名字跟老会话记的项目名对不上，前端按项目过滤后整排任务历史都没了。
  // 现在如实说「你这儿没有项目这回事」，前端见到 locked 就整块不画、也不按项目过滤。
  if (!ownsGlobalWorkspace(req.user)) return res.json({ projects: [], active: "", locked: true });
  ensureProjects();
  res.json({ projects: config.projects, active: config.active_project, locked: false });
});

app.post("/api/projects", (req, res) => {
  try {
    ensureProjects();
    const name = String((req.body || {}).name || "").trim();
    if (!name) throw new Error("缺少项目名");
    if (name.length > 30) throw new Error("项目名太长（最多 30 字）");
    if (config.projects.some((p) => p.name === name)) throw new Error("同名项目已存在");
    let dir = String((req.body || {}).dir || "").trim();
    if (!dir) dir = dataPath("projects", name.replace(/[/\\:*?"<>|]/g, "_"));
    const real = setWorkspaceDir(dir); // 建目录并切换过去
    config.projects.push({ name, dir: real, ...projectMeta(req.body || {}), created_at: new Date().toISOString() });
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

// 新任务回到当前项目自己的目录：输入框里临时切过的文件夹不带进下一个任务
app.post("/api/workspace/reset", (_req, res) => {
  try {
    // 工作目录是全局的：有任务在跑时重置会把它的写入目录半路拽走，产出散落两处。跳过，等空闲再说
    if (activeRuns.size) return res.json({ ok: false, busy: true, workspace_dir: getWorkspaceDir() });
    ensureProjects();
    const ap = config.projects.find((p) => p.name === config.active_project) || config.projects[0];
    if (ap && ap.dir && ap.dir !== getDefaultWorkspaceDir()) {
      config.workspace_dir = setWorkspaceDir(ap.dir);
      saveConfig();
    }
    res.json({ ok: true, workspace_dir: getWorkspaceDir() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 改项目：名字之外的东西（指令、挂载的专家/技能/连接器）都能改，改完立即对新任务生效
app.patch("/api/projects/:name", (req, res) => {
  ensureProjects();
  const p = config.projects.find((x) => x.name === req.params.name);
  if (!p) return res.status(404).json({ error: "项目不存在" });
  Object.assign(p, projectMeta({ ...p, ...(req.body || {}) }));
  const rename = String((req.body || {}).name || "").trim();
  if (rename && rename !== p.name) {
    if (config.projects.some((x) => x.name === rename)) return res.status(400).json({ error: "同名项目已存在" });
    if (config.active_project === p.name) config.active_project = rename;
    p.name = rename;
  }
  saveConfig();
  res.json({ ok: true, project: p, projects: config.projects, active: config.active_project });
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
const LIB_DIR = dataPath("data", "library");
const NOTES_FILE = dataPath("data", "inspirations.json");
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
// 手写区（memory.md，全局共享）+ 条目区（agent 用 remember 自己记的，按账号隔离）
/**
 * 记忆能管到哪一格，跟审批那套是同一个判法。
 *
 * 返回 undefined = 不限定（平台管理员，以及双击打开的桌面版——屏幕前就一个人）。
 * 返回登录名 = 只限定他自己那个作用域：共享区（memory.SHARED）会原样进**所有人**的系统提示词，
 * 谁都能往里塞、谁都能删，那就不是「我的记忆」而是一块公告板了。
 */
const memScope = (req) =>
  admin.isSoloDesktop() || admin.platformAdmin(req.user) ? undefined : (req.user && req.user.username) || "";
app.get("/api/memory", (req, res) => {
  const u = req.user ? req.user.username : undefined;
  const scopeTo = memScope(req);
  res.json({
    content: memory.manual(), items: memory.list(u), shared_tag: memory.SHARED,
    limits: { max_text: memory.MAX_TEXT, max_items: memory.MAX_PER_SCOPE }, vectors: memory.vectorStatus(),
    // 界面照这两个决定要不要画那颗按钮：会 403 的按钮不该摆在那儿
    can_share: scopeTo === undefined,   // 能不能往共享区写、能不能删共享区的
    can_edit_manual: scopeTo === undefined, // 背景说明是全局一份，仍旧归平台管理员
  });
});
app.post("/api/memory", (req, res) => {
  memory.saveManual((req.body || {}).content || "");
  res.json({ ok: true });
});
app.post("/api/memory/item", (req, res) => {
  const b = req.body || {};
  // 受限的人勾了「所有账号共用」：降成他自己的，并且照实说出来，不许悄悄换个作用域还报「已记住」
  const wantShared = !!b.shared;
  const downgraded = wantShared && memScope(req) !== undefined;
  const r = memory.add({
    text: b.text, user: req.user ? req.user.username : undefined,
    shared: wantShared && !downgraded, source: "user",
  });
  if (r.ok && downgraded) r.note = (r.note || "记住了") + "。共享给这台机器上所有账号要平台管理员来做，这条先记成你自己的";
  res.status(r.ok ? 200 : 400).json({ ...r, downgraded });
});
app.delete("/api/memory/item/:id", (req, res) => {
  const r = memory.remove(req.params.id, memScope(req));
  // 越权跟「本来就没有」不能返回同一种结果：前者要报出来，后者是正常竞态（别处已经删过）
  if (r.forbidden) return res.status(403).json({ ok: false, removed: 0, error: "这条不是你记的，删不了" });
  res.json({ ok: true, removed: r.removed });
});

// ---------- 自进化：反馈 → 信号 → 提案 → 人审 → 复盘 ----------
// 👍👎 以前点了只换个高亮色，一个字节都没往外送。反馈得在干活的地方零摩擦地收，
// 收不到就没有后面这一整条链——这是整套自进化的第一环。
app.post("/api/feedback", (req, res) => {
  try {
    const b = req.body || {};
    res.json({ ok: true, item: evolve.recordFeedback({ ...b, user: req.user ? req.user.username : "" }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 反馈汇总：👍👎 总数/好评率/按模型/按模式/最近的 👎 清单。管理员看全员，成员只看自己
app.get("/api/feedback/summary", (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  const user = req.user && req.user.role !== "admin" ? req.user.username : "";
  res.json(evolve.feedbackSummary({ days, user }));
});

// 体检：这段时间它都败在哪儿、各多少次。不调模型，纯数数，随时能看
app.get("/api/evolve/signals", (req, res) => {
  try {
    res.json(evolve.mineSignals({ days: Math.min(365, +req.query.days || evolve.CAPS.window) }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/evolve/state", (_req, res) => {
  res.json({
    caps: evolve.CAPS,
    rules: evolve.activeRules(),
    proposals: evolve.listProposals().slice(-50).reverse(),
    scored: evolve.scoreRules(),
    runs: evolve.listRuns(5),
    auto: config.evolve || {},
  });
});

// 跑一轮复盘：数信号 → 让模型提最小改动 → 过闸门 → 落盘等人审。**永远不自动生效**
app.post("/api/evolve/review", async (req, res) => {
  try {
    const r = await evolve.runReview({ llm, days: +((req.body || {}).days) || undefined, promptExcerpt: (req.body || {}).prompt_excerpt || "" });
    res.json({ ok: true, turns: r.mined.turns, signals: r.mined.signals.slice(0, 10), added: r.added, gated: r.gated, notes: r.notes, scored: r.scored });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/evolve/proposal/:id", (req, res) => {
  try {
    const b = req.body || {};
    const p = evolve.decideProposal(req.params.id, b.decision, { by: req.user ? req.user.username : "", reason: b.reason });
    res.json({ ok: true, proposal: p, rules: evolve.activeRules() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/evolve/rule/:id/retire", (req, res) => {
  try {
    res.json({ ok: true, ...evolve.retireRule(req.params.id, (req.body || {}).why || "人工下架"), rules: evolve.activeRules() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
/**
 * 用系统程序打开文件/文件夹/URL（跨平台：macOS open / Windows explorer / Linux xdg-open）。
 *
 * 必须是 execFile，不能是 exec。exec 把整条命令交给 /bin/sh，而 target 里有用户能控制的文件名：
 * 一个叫 `a";id>pwn.txt;"b.txt` 的文件（macOS/Linux 上完全合法，上传接口也没拦过这些字符）
 * 就能把老写法 exec(`${opener} "${target}"`) 里的引号闭合掉，分号后面那段以服务端权限执行。
 * execFile 不起 shell，参数原样递给程序，这类解析从根上就没有了。
 * 回调吞掉错误是有意的：explorer 打开成功也常回非 0 退出码，而这个函数的调用方都不看结果。
 */
function openWithSystem(target) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  require("child_process").execFile(opener, [String(target)], () => {});
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
const larkCli = require("./lark-cli");
/** 读 lark-cli 当前绑定的应用凭证；读不到返回 null */
async function larkConfig() {
  return larkCli.parseConfigShow((await larkRun(["config", "show"], { timeout: 15000 })).stdout);
}
/**
 * 把 lark-cli 里的凭证搬进飞书通道并重启长连接（新建和导入两条路都走这里）。
 * 守卫：macOS 上 lark-cli 把 secret 锁在钥匙串里，`config show` 只回 `****`。
 * 那串掩码要是写进去，用户原来能用的凭证就被顶掉了 —— 宁可不搬，也不搬一个假的。
 * app_id 也一并不动：单搬 app_id 会让它跟旧 secret 配成一对错的，连上去只会报 10014。
 */
function adoptLarkCreds(cfg) {
  const appId = (cfg && cfg.appId) || "";
  if (!appId || !larkCli.usableSecret(cfg && cfg.appSecret)) {
    return { ok: false, app_id: appId, error: larkCli.SECRET_LOCKED_HINT, console_url: larkCli.appConsoleUrl(appId, cfg && cfg.brand) };
  }
  config.im = config.im || {};
  config.im.feishu = Object.assign(config.im.feishu || {}, { app_id: cfg.appId, app_secret: cfg.appSecret });
  saveConfig();
  if (imBridge) imBridge.startFeishuWs(true).catch((e) => console.warn("[飞书] 长连接重启失败:", e.message));
  return { ok: true, app_id: cfg.appId };
}

app.get("/api/feishu/lark-cli", async (_req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  const v = await larkRun(["--version"], { timeout: 15000 });
  if (!v.ok) return res.json({ installed: false, install_cmd: "npx @larksuite/cli@latest install" });
  const version = (v.stdout.match(/[\d.]+/) || [""])[0];
  const cfg = await larkConfig();
  // 只回布尔和非敏感字段，app_secret 一个字节都不出后端
  res.json({
    installed: true, version,
    configured: !!(cfg && cfg.appId),
    app_id: (cfg && cfg.appId) || "",
    brand: (cfg && cfg.brand) || "",
    has_secret: larkCli.usableSecret(cfg && cfg.appSecret),
    // 读不出来跟没有是两回事：钥匙串锁着的时候得让前端说清楚，而不是装作「没配」
    secret_locked: !!(cfg && cfg.appId && !larkCli.usableSecret(cfg.appSecret)),
    users: (cfg && cfg.users) || "",
  });
});

// 把 lark-cli 里已经配好的应用凭证搬进 OpenWorkBuddy 的飞书通道，省掉手动复制两串东西
app.post("/api/feishu/lark-cli/import", async (_req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  const cfg = await larkConfig();
  if (!cfg || !cfg.appId) {
    return res.status(400).json({ error: "lark-cli 还没配置应用凭证，先「扫码新建应用」，或自己跑 lark-cli config init" });
  }
  const r = adoptLarkCreds(cfg);
  if (!r.ok) return res.status(400).json({ error: r.error, app_id: r.app_id, secret_locked: true, console_url: r.console_url });
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

// ---- 一键新建飞书应用：全程不用手打 app_id / app_secret ----
// 用户问过两次「不能扫码连机器人吗」。直答是：机器人在飞书这边就是一个「应用」，平台只认
// app_id/app_secret，扫码换不来这两串。但 lark-cli 的 `config init --new` 能**替你新建一个应用**——
// 它阻塞着打印一条验证链接，用户在浏览器里点完，凭证就落进 ~/.lark-cli/config.json。
// 我们把链接变成二维码给用户扫，建完直接导进飞书通道 → 一个字都不用手打。
let larkNew = null; // { url, state, error, app_id, child, startedAt }
app.post("/api/feishu/app/create", async (_req, res) => {
  fs.mkdirSync(LARK_TMP, { recursive: true });
  if (larkNew && larkNew.child) { try { larkNew.child.kill(); } catch {} }
  const before = await larkConfig();
  // lark-cli 在 Agent 环境里会拒绝新建，把那两个标记摘掉；同时避免继承本进程的杂环境
  const env = { ...process.env, PATH: shellPath() };
  delete env.OPENCLAW_HOME; delete env.HERMES_HOME;
  let out = "";
  const child = require("child_process").spawn(
    "lark-cli", ["config", "init", "--new", "--brand", "feishu", "--lang", "zh"],
    { cwd: LARK_TMP, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  child.on("error", (e) => { if (larkNew) { larkNew.state = "error"; larkNew.error = larkCli.explainLarkError(e.message); } });
  child.on("close", async () => {
    if (!larkNew || larkNew.child !== child) return; // 已被新的一轮顶掉
    const cfg = await larkConfig();
    const born = cfg && cfg.appId && (!before || cfg.appId !== before.appId);
    if (born) {
      const r = adoptLarkCreds(cfg);
      larkNew.app_id = cfg.appId;
      // 应用是真建出来了，只是 secret 被钥匙串锁着 —— 这不是失败，是「还差最后一步」
      larkNew.state = r.ok ? "ok" : "need_secret";
      larkNew.error = r.ok ? "" : r.error;
      larkNew.console_url = r.console_url || "";
    } else if (larkNew.state === "pending") {
      larkNew.state = "error"; larkNew.error = larkCli.explainLarkError(out) || "应用没建成，凭证没变化";
    }
  });
  larkNew = { url: "", state: "pending", error: "", app_id: "", console_url: "", child, startedAt: Date.now() };

  // 等它把验证链接打出来（一般 1~3 秒）；拿到就出二维码，拿不到就如实说
  const url = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const u = larkCli.verifyUrlOf(out);
      if (u || child.exitCode !== null || Date.now() - t0 > 30000) { clearInterval(tick); resolve(u); }
    }, 200);
  });
  if (!url) {
    try { child.kill(); } catch {}
    if (larkNew) larkNew.state = "error";
    return res.status(400).json({ error: larkCli.explainLarkError(out) });
  }
  larkNew.url = url;
  const png = "newapp-" + Date.now() + ".png";
  await larkRun(["auth", "qrcode", url, "-o", png, "--size", "256"], { timeout: 20000 });
  let qr = null;
  try {
    qr = "data:image/png;base64," + fs.readFileSync(path.join(LARK_TMP, png)).toString("base64");
    fs.unlinkSync(path.join(LARK_TMP, png));
  } catch {}
  res.json({ ok: true, url, qr });
});

app.get("/api/feishu/app/create/status", (_req, res) => {
  if (!larkNew) return res.json({ state: "idle" });
  if (larkNew.state === "pending" && Date.now() - larkNew.startedAt > 15 * 60 * 1000) {
    try { larkNew.child.kill(); } catch {}
    larkNew.state = "error"; larkNew.error = "等了 15 分钟没完成，重新点一次";
  }
  // app_id 不敏感（前端本来就要显示），app_secret 一个字节都不出后端
  res.json({ state: larkNew.state, error: larkNew.error || null, app_id: larkNew.app_id || "", url: larkNew.url || "", console_url: larkNew.console_url || "" });
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
// ---------- 数据备份与恢复 ----------
// 打包 data/（会话/记忆/账号/用量/审计）+ config.json + schedules.json + experts.json。
// 工作空间成果文件不进备份（可能巨大，且用户自己看得见摸得着）。备份放项目根 backups/，
// 用系统 tar（mac/linux 自带，win10+ 也有），不为这事拖第三方压缩依赖。
const BACKUP_DIR = dataPath("backups");
const BACKUP_ENTRIES = ["data", "config.json", "schedules.json", "experts.json"];

// 备份里有 config.json（含 API Key）和全部账号数据——只有管理员能碰。
// 本地单人用没登录态时视同管理员（和任务归属的口径一致）
function backupAllowed(req, res) {
  if (!req.user || req.user.role === "admin") return true;
  res.status(403).json({ error: "只有管理员能操作备份" });
  return false;
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^wb-backup-[\w.-]+\.tar\.gz$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}

function makeBackup(tag) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const name = `wb-backup-${stamp}${tag ? "-" + tag : ""}.tar.gz`;
    const entries = BACKUP_ENTRIES.filter((e) => fs.existsSync(dataPath(e)));
    if (!entries.length) return reject(new Error("没有可备份的数据"));
    require("child_process").execFile(
      "tar", ["-czf", path.join(BACKUP_DIR, name), "-C", DATA_DIR, ...entries],
      { timeout: 300000 },
      (err) => (err ? reject(new Error(err.code === "ENOENT" ? "系统里没有 tar 命令（macOS/Linux/Windows 10 1803+ 都自带；更老的 Windows 请先升级系统）" : "tar 打包失败：" + err.message)) : resolve(name))
    );
  });
}

/** 校验名字必须来自现有备份列表，杜绝路径注入 */
function backupFile(name) {
  const hit = listBackups().find((b) => b.name === name);
  return hit ? path.join(BACKUP_DIR, hit.name) : null;
}

app.get("/api/backup", (req, res) => {
  if (!backupAllowed(req, res)) return;
  res.json({ list: listBackups(), covers: BACKUP_ENTRIES });
});
app.post("/api/backup", async (req, res) => {
  if (!backupAllowed(req, res)) return;
  try {
    const name = await makeBackup("");
    security.audit("数据备份", `已创建备份 ${name}`, "放行");
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/backup/download/:name", (req, res) => {
  if (!backupAllowed(req, res)) return;
  const p = backupFile(req.params.name);
  if (!p) return res.status(404).json({ error: "备份不存在" });
  res.download(p);
});
app.delete("/api/backup/:name", (req, res) => {
  if (!backupAllowed(req, res)) return;
  const p = backupFile(req.params.name);
  if (!p) return res.status(404).json({ error: "备份不存在" });
  fs.unlinkSync(p);
  res.json({ ok: true });
});
app.post("/api/backup/restore", async (req, res) => {
  if (!backupAllowed(req, res)) return;
  const p = backupFile(String((req.body || {}).name || ""));
  if (!p) return res.status(404).json({ error: "备份不存在" });
  try {
    // 恢复前先把现状自动备一份——恢复错了还能回来，这一步绝不省
    const safety = await makeBackup("before-restore");
    await new Promise((resolve, reject) =>
      require("child_process").execFile("tar", ["-xzf", p, "-C", DATA_DIR], { timeout: 300000 },
        (err) => (err ? reject(new Error(err.code === "ENOENT" ? "系统里没有 tar 命令（macOS/Linux/Windows 10 1803+ 都自带）" : "tar 解包失败：" + err.message)) : resolve()))
    );
    security.audit("数据恢复", `已从 ${path.basename(p)} 恢复（恢复前现状已存为 ${safety}）`, "放行");
    res.json({ ok: true, safety, restart_required: true, note: "已恢复到磁盘。内存里还是旧数据，重启应用后完全生效。" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/backup/restart", (req, res) => {
  if (!backupAllowed(req, res)) return;
  if (!process.versions.electron) return res.status(400).json({ error: "非桌面版：请手动重启服务进程" });
  res.json({ ok: true });
  // 先把响应发出去再重启，不然前端只看到断线
  setTimeout(() => {
    try {
      const { app: eApp } = require("electron");
      eApp.relaunch();
      eApp.exit(0);
    } catch (e) { console.warn("[备份] 重启失败:", e.message); }
  }, 600);
});

// ---------- 记忆搬家：导出 / 从其它 agent 导入 ----------
// 导出成一份人能读的 Markdown（手写区 + 条目区），到哪都能用。
// 导入支持两路：① 扫描本机已知的其它 agent 记忆文件（Claude Code / Codex / Claude Cowork），
// 只读扫描白名单里的路径，绝不接受任意路径；② 粘贴任意文本（腾讯 WorkBuddy 等没有固定
// 路径的，从它界面里复制出来贴进来就行）。解析是确定性的，不烧 token。
app.get("/api/memory/export", (req, res) => {
  const u = req.user ? req.user.username : undefined;
  const items = memory.list(u);
  const lines = [
    "# OpenWorkBuddy 记忆导出",
    "",
    `导出时间：${new Date().toLocaleString("zh-CN")}${req.user ? ` · 账号：${req.user.username}` : ""}`,
    "",
    "## 背景说明（手写区，全局共享）",
    "",
    memory.manual() || "（空）",
    "",
    "## 记忆条目",
    "",
    ...(items.length
      ? items.map((it) => `- [${it.scope === memory.SHARED ? "共享" : it.scope}] ${it.text}`)
      : ["（还没有条目）"]),
    "",
  ];
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="openworkbuddy-memory-${new Date().toISOString().slice(0, 10)}.md"`);
  res.send(lines.join("\n"));
});

/** 本机其它 agent 的记忆文件白名单扫描（找得到才列出来，路径不存在就静默跳过） */
function memoryImportSources() {
  const home = require("os").homedir();
  const out = [];
  const push = (label, p, mode) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.size < 2 * 1024 * 1024) out.push({ label, path: p, size: st.size, mode });
    } catch {}
  };
  push("Claude Code 全局记忆（~/.claude/CLAUDE.md）", path.join(home, ".claude", "CLAUDE.md"), "manual");
  try {
    for (const d of fs.readdirSync(path.join(home, ".claude", "projects"))) {
      push(`Claude Code 项目记忆（${d.replace(/^-/, "").slice(0, 48)}）`, path.join(home, ".claude", "projects", d, "memory", "MEMORY.md"), "items");
    }
  } catch {}
  push("Codex 全局记忆（~/.codex/AGENTS.md）", path.join(home, ".codex", "AGENTS.md"), "manual");
  push("Claude Cowork 记忆（~/.cowork/CLAUDE.md）", path.join(home, ".cowork", "CLAUDE.md"), "manual");
  push("Claude Cowork 记忆（应用目录）", path.join(home, "Library", "Application Support", "Claude Cowork", "CLAUDE.md"), "manual");
  if (process.env.APPDATA) push("Claude Cowork 记忆（应用目录）", path.join(process.env.APPDATA, "Claude Cowork", "CLAUDE.md"), "manual");
  return out;
}

app.get("/api/memory/import/scan", (_req, res) => res.json({ sources: memoryImportSources() }));

app.post("/api/memory/import", (req, res) => {
  const b = req.body || {};
  let content = "", label = "粘贴的内容";
  if (b.path) {
    const hit = memoryImportSources().find((s) => s.path === String(b.path));
    if (!hit) return res.status(400).json({ error: "只能导入扫描列表里的文件（防任意路径读取）" });
    try { content = fs.readFileSync(hit.path, "utf8"); } catch (e) { return res.status(500).json({ error: "读取失败：" + e.message }); }
    label = hit.label;
  } else {
    content = String(b.text || "");
  }
  content = content.trim();
  if (!content) return res.status(400).json({ error: "没有可导入的内容" });
  const mode = b.mode === "manual" ? "manual" : "items";
  if (mode === "manual") {
    // 成段的背景/规范：整段并入手写区，加来源标头，去重靠人眼（手写区本来就是人编辑的）
    const cur = memory.manual();
    if (cur.includes(content.slice(0, 200))) return res.json({ ok: true, added: 0, skipped: 1, note: "内容已在背景说明里，跳过" });
    memory.saveManual((cur ? cur + "\n\n" : "") + `## 导入自 ${label}（${new Date().toISOString().slice(0, 10)}）\n\n` + content);
    return res.json({ ok: true, added: 1, mode });
  }
  // 条目模式：逐行解析 markdown 列表（- / * / 数字.），[标题](链接) 压成 标题，跳过标题行和短行
  const user = req.user ? req.user.username : undefined;
  let added = 0, skipped = 0;
  const lines = content.split(/\r?\n/).slice(0, 500);
  for (const raw of lines) {
    let t = raw.trim();
    if (!t || /^#{1,6}\s/.test(t) || /^[-*_]{3,}$/.test(t)) continue; // 标题、分隔线
    t = t.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // markdown 链接压成文字
    t = t.replace(/\*\*/g, "").trim();
    if (t.length < 4) continue;
    const r = memory.add({ text: t, user, shared: !!b.shared, source: "user" });
    if (r.ok) added++; else skipped++;
  }
  security.audit("记忆导入", `${label}：导入 ${added} 条，跳过 ${skipped} 条`, "放行");
  res.json({ ok: true, added, skipped, mode });
});

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

// IM 凭证专用的合并：空字符串不覆盖已经存好的值，除非「取消连接」在 im.clear 里点了名。
// 起因是一个能把人坑惨的组合——设置页里任何一次保存（点某张卡的「连接」也算）都会把所有卡的输入框
// 原样回写；输入框只要因为任何原因是空的（只填了一半就点连接、渲染时值没进去、浏览器清了密码框），
// 已经存好的 App Secret 就被一行空串抹掉，通道第二天就连不上，界面还只写「未连接」。
// 现在的规矩：想清空必须显式说要清哪个字段（"feishu.app_secret" / 顶层直接写字段名）。
function imAssign(target, incoming, keys, clear, prefix) {
  for (const k of keys) {
    if (incoming[k] === undefined) continue;
    const v = typeof incoming[k] === "string" ? incoming[k].trim() : incoming[k];
    if (v === "" && String(target[k] || "") !== "" && !clear.has(prefix + k)) continue; // 留着旧的
    target[k] = v;
  }
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
// 用户传进来的文件要和这轮的产出待在一起。以前一律落工作空间根目录，于是
// 「我传的素材」和「它做出来的成果」分了家，根目录越堆越乱（真实数据里躺了 22 个）。
// 时序坑：用户是**先传文件再发消息**，而成果文件夹要等第一条消息才建得出名字。
// 所以没文件夹时先落根目录并记账，等文件夹一建好，assignSessionDir 再把它们搬进去。
app.post("/api/upload", (req, res) => {
  try {
    const { name, data_b64, session } = req.body || {};
    if (!name || !data_b64) return res.status(400).json({ error: "缺少 name 或 data_b64" });
    // basename 之后再洗一遍：控制字符和路径分隔符在文件名里没有正当用途，
    // 而这些名字会被拼进链接、传给系统程序、写进日志
    const base = path.basename(String(name)).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!base || base === "." || base === "..") return res.status(400).json({ error: "文件名不合法" });
    const sess = session ? getSession(String(session)) : null;
    // 归属必须查：这个接口是拿请求体里的 sessionId 直接取会话的，不查就等于
    // 「知道一个会话 id 就能往别人的成果文件夹里写文件」。会话 id 会出现在链接和截图里，不是秘密。
    if (sess && !sessionAllowed(req.user, sess)) return res.status(403).json({ error: "这条对话不属于你" });
    const rel = sess && sess.dir ? path.join(sess.dir, base) : base;
    const p = safePath(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(data_b64, "base64"));
    if (sess && !sess.dir) {
      sess.pending_uploads = (sess.pending_uploads || []).filter((n) => n !== base).concat(base);
    }
    res.json({ ok: true, name: base });
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

// ===== 桌面宠物：自定义形象（自己或朋友的照片）=====
// 存进 data/ 而不是 public/：一来不污染仓库（data/ 已 gitignore），二来跟着备份一起走。
const PET_PHOTO_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
function petPhotoPath() {
  for (const ext of [".png", ".jpg", ".webp", ".gif"]) {
    const p = dataPath("data", "pet-avatar" + ext);
    if (fs.existsSync(p)) return p;
  }
  return "";
}
function clearPetPhoto() {
  for (const ext of [".png", ".jpg", ".webp", ".gif"]) {
    try { fs.unlinkSync(dataPath("data", "pet-avatar" + ext)); } catch {}
  }
}
/**
 * 换宠物形象。
 *
 * 照片是这台机器上的一张图（data/pet-avatar.*）——宠物窗口跑在 Electron 主进程里，那儿没有
 * 「当前登录的是谁」这个概念，所以照片本身不分账号。分账号的是**开关**：谁把宠物打开了、
 * 用的哪种形象。以前这里无条件写 config.pet，多人服务器上一个成员传张图，
 * 平台管理员桌面上那只就跟着换了形象——这才是真正会串台的那一半。
 */
app.post("/api/pet/avatar", (req, res) => {
  try {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(String((req.body || {}).data_url || ""));
    if (!m) return res.status(400).json({ error: "只收 png / jpg / webp / gif 图片" });
    const buf = Buffer.from(m[2], "base64");
    // 前端已经压到 320px 见方再传，这里只兜底：3MB 以上不像压过，多半是直接甩了张原图
    if (!buf.length || buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: "图片太大（压缩后应小于 3MB）" });
    fs.mkdirSync(dataPath("data"), { recursive: true });
    clearPetPhoto(); // 换形象先清旧的，免得两个扩展名同时躺着分不清用哪个
    fs.writeFileSync(dataPath("data", "pet-avatar" + PET_PHOTO_EXT[m[1]]), buf);
    // 特地传了张照片 = 想要它出现
    if (ownPrefs(req)) {
      prefs.write(req.user, { pet: { character: "photo", enabled: true } });
      return res.json({ ok: true, size: buf.length });
    }
    config.pet = { ...(config.pet || {}), character: "photo", enabled: true };
    saveConfig();
    if (global.__wbPet) try { global.__wbPet.applyConfig({ ...config.pet, enabled: config.pet.enabled === true }); } catch {}
    res.json({ ok: true, size: buf.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/pet/avatar", (req, res) => {
  clearPetPhoto();
  if (ownPrefs(req)) {
    prefs.write(req.user, { pet: { character: "cat" } });
    return res.json({ ok: true });
  }
  config.pet = { ...(config.pet || {}), character: "cat" };
  saveConfig();
  if (global.__wbPet) try { global.__wbPet.applyConfig({ ...config.pet, enabled: config.pet.enabled === true }); } catch {}
  res.json({ ok: true });
});

/**
 * 桌面宠物工具的落地实现（tools.js 的 desktop_pet 通过 global.__wbPetTool 调进来）。
 *
 * 为什么放在 server.js：改宠物要同时动三样东西——config.json（持久化）、data/pet-avatar.png（形象）、
 * 还有 Electron 主进程里那个活着的窗口。这三样的把手都在这个文件里，tools.js 只管把参数递过来。
 * 纯 node 模式没有桌面窗口，整个工具会如实报错而不是假装成功。
 */
global.__wbPetTool = {
  async run(input, baseDir) {
    const P = global.__wbPet;
    const action = String((input || {}).action || "create").toLowerCase();
    if (!P) {
      return {
        content: "桌面宠物只在桌面版里有（用 `npm run app` 启动的那种）。当前跑的是纯服务端模式（npm start），没有桌面窗口可以挂宠物。请如实告诉用户这一点，别假装做好了。",
        isError: true,
      };
    }
    const cur = config.pet || {};
    const nowInfo = () => {
      const has = !!petPhotoPath();
      const look = cur.character === "sprite" && cur.sprite ? `像素宠物「${cur.sprite}」`
        : has && cur.character === "photo" ? "用户上传的照片" : "内置小猫";
      return `当前状态：宠物${cur.enabled === true ? "已显示" : "未显示"}，形象=${look}，大小=${Math.round((cur.scale || pet.DEFAULT_SCALE) * 100)}%。`;
    };

    if (action === "status") return { content: nowInfo(), isError: false };

    if (action === "hide") {
      config.pet = { ...cur, enabled: false };
      saveConfig();
      try { P.applyConfig({ ...config.pet, enabled: false }); } catch {}
      return { content: "桌面宠物已收起。用户想让它回来的话，再叫一声就行（或者去 设置 → 人设 里打开）。", isError: false };
    }

    if (action === "show") {
      config.pet = { ...cur, enabled: true };
      saveConfig();
      try { P.applyConfig({ ...config.pet, enabled: true }); } catch {}
      return { content: "桌面宠物已经站到桌面右下角了。" + nowInfo(), isError: false };
    }

    if (action === "remove") {
      clearPetPhoto();
      config.pet = { ...cur, enabled: false, character: "cat" };
      saveConfig();
      try { P.applyConfig({ ...config.pet, enabled: false }); } catch {}
      return { content: "宠物已经撤掉，上传的照片也从本机删干净了。", isError: false };
    }

    // ---- sprite：列出 / 换上本机的 Codex / Petdex 像素宠物 ----
    // 只读目录、只改配置，不生成任何图——「自己孵一只」是要烧生图额度的事，不放在这条路上。
    if (action === "sprite") {
      const all = petSprites.scanPets();
      const good = all.filter((x) => x.ok);
      const want = String((input || {}).sprite_id || "").trim();
      const listing = all.length
        ? all.map((x) => `· ${x.id}（${x.displayName}，来自 ${x.source}）${x.ok ? "" : " —— 用不了：" + x.why}`).join("\n")
        : "";
      if (!want) {
        if (!good.length) {
          return {
            content: "本机一只像素宠物都没扫到。" + (listing ? "扫到但都用不了：\n" + listing + "\n" : "") +
              "告诉用户：在终端跑 `npx petdex install <名字>` 装一只（画廊 petdex.dev），或者把宠物文件夹（含 pet.json + spritesheet.webp）丢进 data/pets/，装完再叫你换。这一步得他自己去终端跑，你别替他执行。",
            isError: false,
          };
        }
        return { content: "本机的像素宠物：\n" + listing + "\n\n问用户想用哪只，拿到 id 后带 sprite_id 再调一次。", isError: false };
      }
      const pick = good.find((x) => x.id === want);
      if (!pick) return { content: `没有叫「${want}」的可用像素宠物。本机现有：\n${listing || "（一只都没有）"}`, isError: true };
      config.pet = { ...cur, enabled: true, character: "sprite", sprite: pick.id };
      saveConfig();
      try { P.applyConfig({ ...config.pet, enabled: true }); } catch {}
      return { content: `已经换成「${pick.displayName}」（${pick.cols}×${pick.rows} 帧图集，来自 ${pick.source}），宠物也一并显示出来了。它会跟着状态切动作：干活跑、要问问题跳、完成挥手、出错摊手。`, isError: false };
    }

    if (action !== "create") return { content: `不认识的 action「${action}」，只支持 create / show / hide / remove / status / sprite。`, isError: true };

    // ---- create：把一张图做成宠物形象 ----
    const raw = String((input || {}).image || "").trim();
    if (!raw) {
      return {
        content: "做宠物得先有张图。请让用户在输入框里上传一张照片（人像、宠物照、表情包都行），拿到文件名后把它作为 image 参数再调一次。",
        isError: true,
      };
    }
    // 用户上传的图落在工作空间根目录，agent 自己产出的图在本次对话的成果子目录里，两处都找
    const wsRoot = getWorkspaceDir();
    let abs = "";
    for (const cand of [baseDir ? path.resolve(baseDir, raw) : "", path.resolve(wsRoot, raw), path.resolve(wsRoot, path.basename(raw))]) {
      if (!cand) continue;
      const rel = path.relative(wsRoot, cand);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue; // 越出工作空间的一律不认
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) { abs = cand; break; }
    }
    if (!abs) return { content: `工作空间里找不到「${raw}」。先用 list_files 看看用户上传的图到底叫什么名字。`, isError: true };
    if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(abs)) return { content: `「${path.basename(abs)}」看着不是图片。支持 png / jpg / webp / gif / bmp。`, isError: true };

    let buf, note = "";
    try {
      // 用 Electron 自带的 nativeImage 裁切缩放，不引任何图像库。GIF 只取第一帧（宠物本来就自带动效，
      // 再叠一层 GIF 动画会打架），这点必须跟用户说清楚，不能让他以为动图没生效是 bug。
      const { nativeImage } = require("electron");
      let img = nativeImage.createFromPath(abs);
      if (img.isEmpty()) return { content: `「${path.basename(abs)}」解码失败，可能是文件损坏或者根本不是图片。`, isError: true };
      const sz = img.getSize();
      const side = Math.min(sz.width, sz.height);
      if (sz.width !== sz.height) {
        img = img.crop({ x: Math.round((sz.width - side) / 2), y: Math.round((sz.height - side) / 2), width: side, height: side });
        note += `原图 ${sz.width}×${sz.height} 不是正方形，已按中心裁成方图；`;
      }
      img = img.resize({ width: 320, height: 320, quality: "best" });
      if (/\.gif$/i.test(abs)) note += "GIF 只取了第一帧（宠物自己带呼吸/跳跃动效）；";
      buf = img.toPNG();
      if (!buf || !buf.length) throw new Error("编码 PNG 失败");
    } catch (e) {
      return { content: "处理图片失败：" + e.message, isError: true };
    }

    fs.mkdirSync(dataPath("data"), { recursive: true });
    clearPetPhoto();
    fs.writeFileSync(dataPath("data", "pet-avatar.png"), buf);
    const scale = Math.max(0.6, Math.min(2, Number((input || {}).scale) || Number(cur.scale) || pet.DEFAULT_SCALE));
    config.pet = { ...cur, enabled: true, character: "photo", scale };
    saveConfig();
    try { P.applyConfig({ ...config.pet, enabled: true }); } catch {}
    try { P.setState("done", "新形象上岗"); } catch {}
    return {
      content: `已经用「${path.basename(abs)}」做好桌面宠物，它现在站在桌面右下角。${note}\n` +
        "它会实时显示你在干什么：干活时头顶转圈、有问题要问时跳起来并弹系统通知、任务完成撒花。\n" +
        "点它一下开关主窗口，拖动换位置，右键有菜单（回到右下角 / 免打扰 / 收起）。\n" +
        "照片只存在用户本机的 data/ 目录，没有上传到任何服务器。",
      isError: false,
    };
  },
};
// 在访达/资源管理器里定位到这个文件（不是打开文件本身，是打开它所在的文件夹并选中它）
// 清掉根目录里那些「跟成果文件夹里某个文件逐字节相同」的副本。
// 敢做这个动作只因为两条：一、判定标准是**哈希相同**，不是名字像，原件确确实实还在；
// 二、**搬进 .trash 而不是删**，捞得回来。少一条都不该有这个按钮。
// 名字像但内容不同的、根目录独有的，一个都不碰——那些是用户自己的东西。
// 空的成果文件夹 = 名字是 任务_ 开头、除了 .DS_Store 一个条目都没有、且不是刚刚才建的。
// 最后那条是唯一的危险点：一个正在跑的回合可能刚建好目录、文件还没落盘，
// 这时候把它搬走就等于把这一轮的产出打断。10 分钟的静默期换掉这个风险，很值。
function listEmptyTaskDirs({ quietMs = 600000, now = Date.now() } = {}) {
  const ws = getWorkspaceDir();
  if (path.resolve(ws) !== dataPath("workspace")) return []; // 用户自选目录不分配成果文件夹，也就没这回事
  let names = [];
  try { names = fs.readdirSync(ws); } catch { return []; }
  return names.filter((n) => {
    if (!n.startsWith("任务_")) return false;
    try {
      const st = fs.statSync(path.join(ws, n));
      if (!st.isDirectory() || now - st.mtimeMs < quietMs) return false;
      return !fs.readdirSync(path.join(ws, n)).some((e) => e !== ".DS_Store");
    } catch { return false; }
  });
}

app.post("/api/files/tidy", (_req, res) => {
  try {
    const dupes = outputFiles().filter((f) => f.dup_of && !f.name.includes("/"));
    // 空的成果文件夹：纯聊天也会建目录，真实数据里 24 个文件夹有 6 个一个文件都没有。
    // 现在回合收尾会自己撤掉，但历史遗留的那些得有人收——顺手挂在这个按钮上，不再单独做一次性脚本。
    const emptyDirs = listEmptyTaskDirs();
    if (!dupes.length && !emptyDirs.length) return res.json({ ok: true, moved: 0, files: [] });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
    const trash = safePath(path.join(".trash", stamp));
    fs.mkdirSync(trash, { recursive: true });
    const moved = [];
    for (const f of dupes) {
      try {
        // 搬之前再验一次原件真的在：列表是几毫秒前拍的快照，这中间原件可能已经没了，
        // 那就不是"清掉多余副本"而是"把唯一一份扔掉"了
        const origin = safePath(f.dup_of);
        if (!fs.existsSync(origin) || !fs.statSync(origin).isFile()) continue;
        fs.renameSync(safePath(f.name), path.join(trash, f.name));
        moved.push(f.name);
      } catch {}
    }
    const movedDirs = [];
    for (const d of emptyDirs) {
      // 搬之前再确认一次还是空的：列表是几毫秒前拍的快照，这中间可能刚好有一轮往里写了东西
      try {
        const p = safePath(d);
        if (fs.readdirSync(p).some((n) => n !== ".DS_Store")) continue;
        fs.renameSync(p, path.join(trash, d));
        movedDirs.push(d);
      } catch {}
    }
    security.audit("清理重复副本", [...moved, ...movedDirs.map((d) => d + "/")].join("、") || "（没有可清理的）", "放行");
    res.json({ ok: true, moved: moved.length, files: moved, dirs: movedDirs, trash: path.join(".trash", stamp) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/files/reveal", (req, res) => {
  try {
    const p = safePath(String((req.body || {}).name || "")); // 越界一律抛错，跟下载走同一道门
    if (!fs.existsSync(p)) return res.status(404).json({ error: "文件不存在" });
    let revealed = false;
    try {
      const { shell } = require("electron");
      if (shell && shell.showItemInFolder) { shell.showItemInFolder(p); revealed = true; }
    } catch {}
    if (!revealed) openWithSystem(path.dirname(p)); // 纯 node 模式：退而求其次，打开所在文件夹
    res.json({ ok: true, revealed });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/** 通配路由里取出工作区相对路径。Express 已经解码过，%2F 老写法和真斜杠新写法都落这里 */
function relOf(req) { return String(req.params[0] || ""); }

app.get("/api/files/download/*", (req, res) => {
  try {
    const p = safePath(relOf(req));
    if (!fs.existsSync(p)) return res.status(404).send("文件不存在");
    res.download(p);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

/**
 * 应用内预览：按正确 Content-Type 内联返回（HTML/图片/PDF 可直接在 iframe/img 中显示）。
 *
 * 这里必须是通配路由，不能是 :name —— 这就是「预览的时候图片都不正常显示」的真身：
 * 成果按会话分了子文件夹（任务_0905_.../hunan_travel.html），前端要是把整条相对路径
 * 当成一个参数 encodeURIComponent 一下，斜杠变成 %2F，浏览器眼里这一整串只是**一段**路径。
 * 网页里 <img src="fig_hero.jpg"> 是相对当前地址算的，于是它去要
 *   /api/files/view/fig_hero.jpg          ← 工作区根目录，没有这张图
 * 而不是
 *   /api/files/view/任务_0905_.../fig_hero.jpg
 * 图当然全裂。改成通配之后每一段单独编码、斜杠还是斜杠，相对路径就算得对了。
 * 老的 %2F 写法也照样能用（Express 会把参数解码回来），不用怕别处还有旧链接。
 */
app.get("/api/files/view/*", (req, res) => {
  try {
    const p = safePath(relOf(req));
    if (!fs.existsSync(p)) return res.status(404).send("文件不存在");
    res.sendFile(p);
  } catch (e) {
    res.status(400).send(e.message);
  }
});

// Office 三件套和压缩包的应用内预览：浏览器打不开 zip 里的一包 XML，这一层把它拆成结构化数据。
// 只吐数据不吐 HTML——文件内容是模型写的或从网上下的，转出来的 HTML 直接进渲染进程等于自开 XSS，
// 拼 HTML 的活统一留在前端一处（每个字段都过 esc），转义漏没漏只需要审那一个地方。
app.get("/api/files/preview/*", async (req, res) => {
  try {
    const rel = relOf(req);
    const p = safePath(rel);
    if (!fs.existsSync(p)) return res.status(404).json({ error: "文件不存在" });
    res.json(await previewData(p, rel));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 对话里的内联图表「存为文件」：内容是前端已经渲染过的东西，落盘到工作目录就能进成果面板、
// 能下载、能被后续回合当素材继续用。扩展名白名单挡住"顺手写个 .sh/.command 再让我打开"的路子。
const SAVE_EXT_OK = /\.(svg|png|jpe?g|html?|md|markdown|txt|csv|json)$/i;
/**
 * 前端给的目标文件夹 —— 也就是「这次对话的成果文件夹」（任务_0911_xxx）。
 * 以前这个参数根本不存在：对话里画的图一律落在工作区**根目录**，跟这次对话的其它产出分家，
 * 用户下一次打开成果面板得从几十个任务文件夹旁边的一堆散图里认自己那张。
 * 只认工作区内的相对路径；绝对路径、盘符、`..` 一律当没给（退回根目录），越界交给 safePath 再兜一道。
 */
function saveDirOf(dir) {
  const d = String(dir || "").replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
  if (!d || /^[a-zA-Z]:/.test(d) || d.split("/").includes("..")) return "";
  return d;
}
/** 前端可能直接递一串 data:image/png;base64,... 过来（PNG 就是这么来的），落盘前还原成二进制 */
function decodeSaveBody(content) {
  const b64 = String(content).match(/^data:[^;]+;base64,(.*)$/s);
  return b64 ? Buffer.from(b64[1], "base64") : content;
}
/** 桌面端才有系统保存框。纯 node 起的网页端返回 null，由前端退回浏览器下载 */
function electronDialog() {
  if (!process.versions || !process.versions.electron) return null;
  try {
    const e = require("electron");
    if (!e || !e.dialog || !e.dialog.showSaveDialog) return null;
    const BW = e.BrowserWindow;
    const win = (BW && (BW.getFocusedWindow() || BW.getAllWindows()[0])) || null;
    return { dialog: e.dialog, win };
  } catch { return null; }
}
app.post("/api/files/save", (req, res) => {
  try {
    // 只收文件名：目录由 dir 决定，名字里夹路径一律拍平，省得绕过 dir 往别处写
    const name = path.basename(String(req.body?.name || "").trim());
    const content = req.body?.content;
    if (!name || typeof content !== "string") return res.status(400).json({ error: "缺少 name 或 content" });
    if (!SAVE_EXT_OK.test(name)) return res.status(400).json({ error: "不支持保存这种类型的文件" });
    const sub = saveDirOf(req.body?.dir);
    const rel = sub ? sub + "/" + name : name;
    const p = safePath(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, decodeSaveBody(content));
    res.json({ ok: true, name, rel, dir: sub, files: outputFiles() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
/**
 * 「另存为…」：桌面端弹系统保存框，用户自己挑地方（可以挑到工作区外——那是他自己的电脑、
 * 他自己点的路径，不是模型能构造的）。网页端没有这种能力，回 no_dialog，
 * 前端退回浏览器下载——在网页上，那就是「自己选位置」。
 */
app.post("/api/files/save-as", async (req, res) => {
  try {
    const name = path.basename(String(req.body?.name || "").trim());
    const content = req.body?.content;
    if (!name || typeof content !== "string") return res.status(400).json({ error: "缺少 name 或 content" });
    if (!SAVE_EXT_OK.test(name)) return res.status(400).json({ error: "不支持保存这种类型的文件" });
    const el = electronDialog();
    if (!el) return res.json({ ok: false, no_dialog: true });
    // 保存框开在这次对话的成果文件夹里：用户多半就想存它旁边，省得每次从头翻
    let base = getWorkspaceDir();
    try { const sub = saveDirOf(req.body?.dir); if (sub) base = safePath(sub); } catch {}
    const r = await el.dialog.showSaveDialog(el.win || undefined, {
      title: "另存为", defaultPath: path.join(base, name), buttonLabel: "保存",
    });
    if (r.canceled || !r.filePath) return res.json({ ok: false, canceled: true });
    fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
    fs.writeFileSync(r.filePath, decodeSaveBody(content));
    res.json({ ok: true, path: r.filePath, files: outputFiles() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- 本地部署预览：把工作目录当静态站点跑在一个独立端口上 ----
// 应用内 iframe 预览走 /api/files/view，够看长相；但真正的网页要有自己的 origin 才对
// （相对路径引资源、fetch、localStorage、手机上开来看）。这里起一个只监听本机的静态服务器。
/**
 * 每个租户一份，不是全局一份。以前这是个模块级单例，三个后果：
 *   ① B 组织一点「预览」就把 A 组织正在对外的服务掐了；
 *   ② GET /api/preview/status 把**别人**工作目录的绝对路径和局域网地址回给任何登录用户；
 *   ③ 两边抢同一个变量，谁停都停成对方那份。
 * 键用工作目录（tenantScope 已经把 getWorkspaceDir() 绑到调用者所属组织的根上）。
 */
const previewServers = new Map(); // dir -> { srv, port, dir, lanOpen, token }
function lanAddress() {
  const nets = require("os").networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}
function previewState(dir) {
  const ps = previewServers.get(dir);
  if (!ps) return { running: false };
  const lan = ps.lanOpen ? lanAddress() : null;
  // url / lan_url 是**不带令牌的根**，令牌单独给：调用方要在后面接文件名，
  // 拼在根上会变成 ".../?t=xxxindex.html"。静态站是独立的 express 实例，
  // 登录态 cookie 到不了那边，没有令牌的话「开了局域网」就等于同网段裸奔。
  return {
    running: true,
    port: ps.port,
    dir: ps.dir,
    lan_open: !!ps.lanOpen,
    token: ps.token,
    url: `http://127.0.0.1:${ps.port}/`,
    lan_url: lan ? `http://${lan}:${ps.port}/` : null,
  };
}
app.get("/api/preview/status", (_req, res) => res.json(previewState(getWorkspaceDir())));
app.post("/api/preview/start", (req, res) => {
  const dir = getWorkspaceDir();
  // lan=true 才对局域网开放：开了手机能扫，但同一个 Wi-Fi 下的人也能翻整个工作目录。
  // 「把这台机器上的一个目录挂到局域网上」是服务器级动作，普通成员开不了；
  // 不静默降级——降了要在返回体里说清楚，不然用户只会看到「怎么扫不出来」。
  const wantLan = !!(req.body && req.body.lan);
  const lanOpen = wantLan && isPlatformOwner(req);
  const lanDenied = wantLan && !lanOpen;
  // open=文件名：服务就绪后用系统默认浏览器打开它
  const openName = req.body && req.body.open ? String(req.body.open).replace(/^\/+/, "") : null;
  const done = (st) => {
    if (openName) openWithSystem(st.url + openName.split("/").map(encodeURIComponent).join("/") + `?t=${st.token}`);
    res.json(lanDenied ? { ...st, lan_denied: true, lan_hint: "对局域网开放要平台管理员来开" } : st);
  };
  // 已经在跑且参数一致：不用重起，但该开的浏览器还是得开。
  // （这里以前是直接 return，把 open 一起吞了——而「在浏览器打开」按钮只在服务已启动时才出现，
  //   必然走这条分支，所以那个按钮点了从来没反应过。）
  const cur = previewServers.get(dir);
  if (cur && cur.lanOpen === lanOpen) return done(previewState(dir));
  if (cur) { try { cur.srv.close(); } catch {} previewServers.delete(dir); }
  const token = require("crypto").randomBytes(16).toString("hex");
  const site = express();
  // 令牌闸必须挂在 static 前面，不然静态中间件先把文件送出去了。
  // 第一次带 ?t= 进来就种个 cookie，之后页面里的相对路径（图片、js、fetch）不用各自带令牌。
  site.use((rq, rs, nx) => {
    const cookie = String(rq.headers.cookie || "");
    if (cookie.includes("wbpv=" + token)) return nx();
    if (rq.query && rq.query.t === token) {
      rs.setHeader("Set-Cookie", `wbpv=${token}; Path=/; HttpOnly; SameSite=Lax`);
      return nx();
    }
    rs.status(401).type("text/plain; charset=utf-8").send("这个预览链接要带令牌才能看（回 OpenWorkBuddy 里重新复制一次）");
  });
  site.use(express.static(dir, { extensions: ["html"] }));
  // 端口 0 = 让系统分配空闲端口，避免和用户本机其它服务撞车
  const srv = site.listen(0, lanOpen ? "0.0.0.0" : "127.0.0.1", () => {
    previewServers.set(dir, { srv, port: srv.address().port, dir, lanOpen, token });
    done(previewState(dir));
  });
  srv.on("error", (e) => {
    if (!res.headersSent) res.status(500).json({ error: "本地预览服务起不来：" + e.message });
  });
});
app.post("/api/preview/stop", (_req, res) => {
  const dir = getWorkspaceDir();
  const ps = previewServers.get(dir);
  if (ps) { try { ps.srv.close(); } catch {} previewServers.delete(dir); } // 只停自己那份
  res.json({ running: false });
});

// 「用系统程序打开」= 在服务器上起一个进程，所以这里必须挡住可执行类型。
// 走白名单不走黑名单：黑名单漏一个后缀就是一次任意代码执行（macOS 的 .command/.app/.scpt、
// Windows 的 .bat/.cmd/.ps1/.lnk/.reg、Linux 上任何带 +x 的文件）。
// 目录不在白名单里但要放行——「打开所在文件夹」是这个接口最常用的用法。
const OPEN_EXT_OK = /\.(pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|markdown|json|ya?ml|log|rtf|html?|odt|ods|odp|pages|numbers|key|svg|png|jpe?g|gif|webp|bmp|tiff?|heic|mp4|mov|webm|m4v|mp3|wav|m4a|flac|aac|zip)$/i;
// 用系统默认程序打开（Word/PPT/Excel 等交给本机 Office/WPS）
app.post("/api/files/open/*", (req, res) => {
  try {
    const p = safePath(relOf(req));
    if (!fs.existsSync(p)) return res.status(404).json({ error: "文件不存在" });
    if (!fs.statSync(p).isDirectory() && !OPEN_EXT_OK.test(p))
      return res.status(400).json({ error: "这种类型不能交给系统程序打开，只放行文档、图片、音视频" });
    openWithSystem(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { sessionId, message, mode, regen, lang } = req.body || {};
  if (!sessionId || !message) return res.status(400).json({ error: "缺少 sessionId 或 message" });
  const user = req.user; // authGuard 已挂上
  // 积分闸门默认是关的（本地个人用不该被自己的账本拦），开了才查余额
  if (user && account.creditsEnabled(user) && account.balanceOf(user) <= 0) {
    return res.status(402).json({ error: "用量不足，无法执行任务。本月固定用量已用完、加油包也见底了——找管理员在企业后台充值，或者把「用量限额」关掉。" });
  }
  if (activeRuns.has(sessionId)) {
    return res.status(409).json({ error: "该会话已有任务在运行，可用「插队」把补充说明注入当前任务。" });
  }
  // 归属要赶在 SSE 头之前查：这条路由的 sessionId 来自请求体，以前一个字都没查——
  // 拿到别人的会话 id 就能接着他的上下文继续跑，跑出来的内容还会写进他的历史里。
  // 新会话（磁盘上还没有这个 id）没有归属字段，照常放行。
  if (!sessionAllowed(user, getSession(sessionId))) {
    return res.status(403).json({ error: "这条对话不属于你" });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.on("error", () => {});
  // 客户端可能中途断开（刷新页面/断网/电脑睡眠），任务照跑：
  // 主连接断了就不再写它，事件继续发给 /api/chat/stream 续流进来的订阅者
  const runState = { ctrl: new AbortController(), interject: [], asks: new Map(), subscribers: new Set(), events: null };
  const send = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    if (!res.destroyed && !res.writableEnded) { try { res.write(line); } catch {} }
    for (const sub of runState.subscribers) { try { sub.write(line); } catch {} }
  };

  const sess = getSession(sessionId);
  if (user && !sess.user) sess.user = user.username;
  // 任务属于哪个项目，以前只记在浏览器里。第一轮就在服务端定死，缓存清了也还分得清组。
  // 只有拥有全局工作目录的人才有「项目」这个概念，租户端记了反而是假信息。
  if (!sess.project && ownsGlobalWorkspace(user)) sess.project = config.active_project || "";
  const sessLLM = llmForSession(sess); // 本对话生效的模型（含专家子代理、标题、记账）
  if (regen) {
    // 重新生成：回滚掉最后一轮（用户消息及其后的所有内容），下面会把同一条消息重新入队
    const lastUser = sess.history.map((h) => h.role).lastIndexOf("user");
    if (lastUser >= 0) sess.history.splice(lastUser);
    if (sess.transcript.length && sess.transcript[sess.transcript.length - 1].type === "assistant") sess.transcript.pop();
    if (sess.transcript.length && sess.transcript[sess.transcript.length - 1].type === "user") sess.transcript.pop();
  }
  // 截断兜底标题要先去掉「【任务类型：X】」这个给模型看的前缀，不然起标题失败时历史列表全是它
  if (!sess.title) sess.title = message.replace(/^\s*【任务类型：[^】]*】\s*/, "").slice(0, 24);
  sess.history.push({ role: "user", content: message });
  // 每一轮自己盖时间戳。以前只有会话级的 updated_at，于是自进化的挖掘器只能拿它当近似——
  // 结果是**一个会话里几个月前的失败和今天的失败共用同一个时间**。这不是精度问题：
  // scoreRules 按"规则生效以来"开窗打分，只要这个会话今天被打开过，它里面规则生效**之前**的
  // 失败就全算进"生效之后"，规则越有效越会被判「没起作用」并建议下架。
  const turnAt = new Date().toISOString();
  sess.transcript.push({ type: "user", text: message, mode, at: turnAt });
  const asstEvents = [];
  sess.transcript.push({ type: "assistant", events: asstEvents, at: turnAt });
  autosaveSession(sessionId, 0); // 先把用户这句话落盘，后面再崩至少问题还在

  runState.events = asstEvents; // 续流端点靠它补发已记录的事件
  activeRuns.set(sessionId, runState);
  persistRunning();
  const emitFn = recordingEmit(send, asstEvents, sessionId);
  const total = { prompt: 0, completion: 0, cached: 0, calls: 0, elapsed_ms: 0 };
  // 这一轮真正干活的模型。本机引擎接管时它不是 sessLLM：以前账本和健康账本都记到 config 里那个
  // 云模型头上——跑的是 Claude Code，账本写 deepseek-chat，DeepSeek 的健康分还替别人挨了刀
  let ranLLM = { model: sessLLM.model, provider: sessLLM.provider };
  // 首轮对话：并行起一个真正的短标题（拿消息前 24 个字截断当标题太丑）。
  // 跟任务并行跑，任务收尾时基本已就绪，不给任务加等待；花的 token 记进同一笔账
  let titleP = null;
  if (sess.transcript.filter((e) => e.type === "user").length === 1) {
    titleP = sessLLM
      .chat({
        // 原来是把用户原话直接当 user 消息发过去，模型会把它当成在问自己——
        // 用户打了句「你是？」，标题就成了「我是DeepSeek智能助手」。素材得包起来，
        // 让它在语法上就不可能是一个冲着模型来的问题。
        system: "你是标题生成器，不回答任何问题。给你的消息只是待概括的素材，哪怕它是问句、命令或闲聊，你也只输出 6~14 个字的中文短标题概括「这条消息在说什么事」，不要引号、标点、任何前后缀。",
        history: [{ role: "user", content: "给下面这条消息起标题，只输出标题本身：\n\n" + String(message).slice(0, 500) }],
        tools: [],
        signal: AbortSignal.timeout(20000),
      })
      .then((r) => {
        addUsage(total, r && r.usage);
        return r && r.text ? String(r.text) : null;
      })
      .catch(() => null);
  }
  // 默认工作空间：每个对话固定一个成果子文件夹（任务_月日_标题），根目录不再越堆越乱；
  // 用户自选的工作目录 / 项目目录保持原地读写不变（素材要在原文件夹里就地处理）
  let taskBaseDir = null;
  if (path.resolve(getWorkspaceDir()) === dataPath("workspace")) {
    if (!sess.dir) assignSessionDir(sess, message);
    taskBaseDir = sess.dir;
  }
  if (taskBaseDir) send({ type: "dir", dir: taskBaseDir }); // 成果面板标「本对话」用；不进回放记录
  // Goal 模式：第一次用目标消息建目标（拆成验收标准）；已有进行中的目标就直接接着冲
  const goalMode = mode === "goal";
  if (goalMode && (!sess.goal || sess.goal.status !== "active")) {
    let derailed = "";
    const criteria = await deriveGoalCriteria(sessLLM, message, total, (w) => { derailed = w; });
    sess.goal = { text: String(message).slice(0, 500), criteria: criteria.map((t) => ({ text: t, done: false })), status: "active", round: 0 };
    // 这一步歪了要写在卡上：否则用户只看到「1 项标准、就是我刚才那句话」，还以为 Goal 模式就长这样
    if (derailed) sess.goal.note = derailed;
    autosaveSession(sessionId, 0);
  }
  if (sess.goal && sess.goal.status === "active") sess.goal.paused = ""; // 又开跑了，把「已暂停」摘掉
  if (sess.goal) send({ type: "goal", goal: sess.goal }); // 目标卡状态直播；不进回放记录（回放时从会话里取）
  let runFailed = null; // 整跑是否以异常收场（记进模型健康账本）
  if (global.__wbPet) try { global.__wbPet.setState("working", sess.title || String(message).slice(0, 40)); } catch {}
  try {
    // 外层：目标轮（普通消息只走一轮；goal 模式没达标自动再跑，最多 GOAL_MAX_ROUNDS 轮）
    let lastFinal = "";
    let roundStopped = null; // 本目标轮里任务被强制收尾的原因（超时/上限/手停）；有它就不再自动开新轮
    for (let goalRound = 0; ; goalRound++) {
      roundStopped = null;
      // 进行中的目标注入任务上下文：agent 每一轮都对着验收标准干活，不跑偏
      let goalCtx = "";
      if (sess.goal && sess.goal.status === "active") {
        goalCtx = `\n\n## 本对话的目标（Goal 模式）\n目标：${sess.goal.text}\n验收标准（打勾的已达成，别重做）：\n` +
          sess.goal.criteria.map((c, i) => `${i + 1}. [${c.done ? "✓" : " "}] ${c.text}`).join("\n") +
          `\n交付物必须能通过未达成的验收标准。`;
      }
      // 内层：任务收尾瞬间可能还有没被 agent 循环消化的插队消息 → 追加为新一轮，直到清空
      for (;;) {
        const r = await runtime.runTask({
          lang: lang === "en" ? "en" : "zh", // 界面语言：英文界面时让 AI 也用英文答，用户不用再在每句话里交代
          taskLabel: sess.title || String(message).slice(0, 24),
          baseDir: taskBaseDir,
          llmOverride: sessLLM,
          history: sess.history,
          emit: emitFn,
          mode: ["ask", "plan", "craft"].includes(mode) ? mode : "craft",
          user: user ? user.username : undefined,
          projectContext: (projectContextOf(activeProject()) || "") + goalCtx,
          stopSignal: runState.ctrl.signal,
          // 底层 CLI 引擎自己的会话 id：存在本项目的会话文件里，桌面端和 wb 命令行
          // 打开同一个会话时接着同一根线程跑，不用把历史再贴一遍
          engineSession: sess.engine_session || null,
          getInterject: () => runState.interject.splice(0),
          // ask_user 工具的等待端：回答从 /api/chat/answer 进来；超时或用户点停止都放行 null
          askUser: ({ askId, timeoutMs }) => new Promise((resolve) => {
            const done = (v) => {
              clearTimeout(timer);
              runState.asks.delete(askId);
              runState.ctrl.signal.removeEventListener("abort", onAbort);
              resolve(v);
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            const onAbort = () => done(null);
            runState.ctrl.signal.addEventListener("abort", onAbort);
            runState.asks.set(askId, done);
          }),
        });
        addUsage(total, r && r.usage);
        if (r && r.provider) ranLLM = { model: r.model || r.provider, provider: r.provider };
        if (r && r.sessionId) { sess.engine_session = r.sessionId; sess.engine = r.engine || ""; }
        if (r && r.finalText) lastFinal = r.finalText;
        if (r && r.stopped) roundStopped = r.stopped;
        const leftover = runState.interject.splice(0);
        if (!leftover.length || runState.ctrl.signal.aborted) break;
        for (const m of leftover) {
          sess.history.push({ role: "user", content: m });
          emitFn({ type: "interject", text: m });
        }
      }
      // 没有进行中的目标 / 用户已手动停止 → 不验收不加轮
      if (!sess.goal || sess.goal.status !== "active" || runState.ctrl.signal.aborted) break;
      sess.goal.note = "";
      sess.goal.paused = "";
      await verifyGoal(sess, sessLLM, lastFinal, total, (w) => { sess.goal.note = w; });
      sess.goal.round = (sess.goal.round || 0) + 1;
      send({ type: "goal", goal: sess.goal });
      autosaveSession(sessionId, 0);
      if (sess.goal.status === "done") break;
      if (!goalMode) break;
      // 自动补跑用完了。以前到这儿就悄悄不跑了，目标卡停在「2/4 · 第 3 轮」——用户分不清是"还在跑"
      // 还是"不跑了"。写清楚为什么停、还差几项，卡上给一颗「接着冲」，把要不要继续烧钱交回给用户
      if (goalRound + 1 >= GOAL_MAX_ROUNDS) {
        sess.goal.paused = `自动补跑已用满 ${GOAL_MAX_ROUNDS} 轮，还差 ${sess.goal.criteria.filter((c) => !c.done).length} 项没达成`;
        send({ type: "goal", goal: sess.goal });
        autosaveSession(sessionId, 0);
        break;
      }
      // 这轮是被超时/上限硬切断的：同样的条件再跑一轮大概率原样再撞，别把用户的时间和钱烧在死循环里
      if (roundStopped) {
        sess.goal.paused = `这轮任务被强制收尾（${roundStopped}），暂停自动补跑`;
        send({ type: "goal", goal: sess.goal });
        autosaveSession(sessionId, 0);
        emitFn({ type: "interject", text: `【目标验收】这轮任务被强制收尾（${roundStopped}），暂停自动补跑。解决后可以直接说「继续」接着冲目标。` });
        break;
      }
      // 没达标 → 把未达成项作为下一轮指令，接着冲（进回放记录，回放时能看懂为什么又跑了一轮）
      const unmet = sess.goal.criteria.filter((c) => !c.done).map((c) => "· " + c.text).join("\n");
      const fb = `【目标验收 · 第 ${sess.goal.round} 轮】以下验收标准还没达成：\n${unmet}\n只补这些未达成项，别重做已达成的部分。`;
      sess.history.push({ role: "user", content: fb });
      emitFn({ type: "interject", text: fb });
    }
  } catch (e) {
    runFailed = e.message;
    const streak = (modelFailStreak.get(ranLLM.provider) || 0) + 1;
    modelFailStreak.set(ranLLM.provider, streak);
    let emsg = e.message;
    if (streak >= 2) {
      emsg += `\n\n💡 模型「${ranLLM.provider}」已连续失败 ${streak} 次，多半是这个模型/渠道本身不可用：可以点输入框旁的模型按钮给本对话单独换一个，或到 设置 → 模型 换全局默认。`;
    }
    send({ type: "error", message: emsg });
    asstEvents.push({ type: "error", message: emsg });
  } finally {
    activeRuns.delete(sessionId);
    persistRunning();
    if (global.__wbPet) try { global.__wbPet.setState(runFailed ? "error" : "done", runFailed ? String(runFailed).slice(0, 80) : "任务完成"); } catch {}
  }
  if (total.calls > 0) modelFailStreak.delete(ranLLM.provider); // 有成功调用就算这个模型活着，清连挂计数
  // 健康账本：异常收场记一败；正常收场且真调过模型记一胜（秒停等一次没调的不记，记了是噪声）
  if (runFailed) recordModelHealth(ranLLM.provider, false, runFailed);
  else if (total.calls > 0) recordModelHealth(ranLLM.provider, true);

  // 记账：按整个任务（含插队追加轮）的总 tokens 扣积分
  if (user && total.calls > 0) {
    const spent = account.chargeRun(user, { ...total, model: ranLLM.model, provider: ranLLM.provider, source: "web", sessionId });
    // 不限额时 spent 是 0，就别在结果下面挂一行「扣 0 积分」了，那只是噪声
    if (spent > 0) emitFn({ type: "credits", spent, balance: user.credits });
  }

  // 标题生成失败/没赶上就保持截断标题，绝不为它多等
  if (titleP) {
    const t = await Promise.race([titleP, new Promise((r) => setTimeout(r, 3000, null))]);
    const clean = t && t.replace(/[\r\n"“”「」『』]/g, "").trim().slice(0, 20);
    if (clean) { sess.title = clean; send({ type: "title", title: clean }); }
  }
  // 这一轮什么都没产出的话，别留一个空文件夹在工作空间里。
  //
  // 空文件夹的来路不止一条：executeTool 拿到 baseDir 就 mkdir（连只读工具也会）、
  // 脚本的 cwd 也要目录先在。逐个堵必漏，所以在回合收尾处一处收口。
  // 用 rmdirSync 而不是 rm -r：**它删不掉非空目录**，这是天生的保险——
  // 万一判断有误，最坏结果是删不动报个错，绝不会连着成果一起没了。
  //
  // 顺带把名字修好：清掉之后 sess.dir 置空，下一轮重新分配时 sess.title 已经是
  // 模型生成的真短标题了，于是「任务_0822_你好」这种名字自己就没了。
  if (taskBaseDir && sess.dir && !(sess.pending_uploads || []).length) {
    const full = path.join(getWorkspaceDir(), sess.dir);
    try {
      if (fs.existsSync(full) ? !fs.readdirSync(full).length : true) {
        if (fs.existsSync(full)) fs.rmdirSync(full); // 非空会抛，抛了就什么都不动
        assignedDirs.delete(sess.dir);
        sess.dir = null;
      }
    } catch {} // 删不动就留着，一个空文件夹远好过一次误删
  }
  saveSession(sessionId);
  // 收尾只是刷一遍完整文件列表，不是"本回合有产出"的通报：changed 明确给空，
  // 免得前端拿本地 mtime 猜一把，把工作目录里的旧文件当成新成果又把面板弹出来
  const files0 = outputFiles();
  send({ type: "files", files: files0, changed: [], ...filesScope(files0) });
  send({ type: "done" });
  if (!res.destroyed && !res.writableEnded) { try { res.end(); } catch {} }
  for (const sub of runState.subscribers) { try { sub.end(); } catch {} }
  runState.subscribers.clear();
});

// 插队：往正在运行的任务里注入一条补充消息（agent 在下一个安全间隙读到并继续）
app.post("/api/chat/interject", (req, res) => {
  const { sessionId, message } = req.body || {};
  const text = String(message || "").trim();
  const run = activeRuns.get(sessionId);
  if (!run) return res.status(409).json({ ok: false, error: "该会话没有正在运行的任务" });
  if (!guardRun(req, res, sessionId)) return;
  if (!text) return res.status(400).json({ ok: false, error: "消息为空" });
  run.interject.push(text);
  res.json({ ok: true, queued: run.interject.length });
});

// ask_user 的回答通道：agent 弹的问题，用户点选/输入后从这里回填给正在等待的那次工具调用
app.post("/api/chat/answer", (req, res) => {
  const { sessionId, askId, answer } = req.body || {};
  const run = activeRuns.get(sessionId);
  if (!run) return res.status(409).json({ ok: false, error: "该会话没有正在运行的任务" });
  if (!guardRun(req, res, sessionId)) return;
  const resolve = run.asks && run.asks.get(String(askId || ""));
  if (!resolve) return res.status(404).json({ ok: false, error: "这个问题已过期或已回答过" });
  const text = String(answer || "").trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: "回答为空" });
  resolve(text);
  res.json({ ok: true });
});

// 正在运行任务的会话列表：前端刷新后靠它找回后台任务，断流后靠它判断任务是否还活着
app.get("/api/chat/running", (req, res) => {
  // 口径跟侧栏一样窄（ownSession）：这份列表不是「我能打开哪些」，是「页面刷新后该替我接回哪些」。
  // 以前管理员这里拿到的是全服务器所有人正在跑的任务 id，前端 reattachRunning 会挨个把它们
  // 回放进他自己的窗口——同事的任务画面直接铺到管理员屏幕上，还顺手订上了人家的实时流。
  const ids = [...activeRuns.keys()].filter((id) => ownSession(req.user, { user: (sessions.get(id) || {}).user || "" }));
  res.json(ids);
});

// 断点续流：把 transcript 里已记录的事件从 from 序号补发，然后接上直播（页面刷新/断网重连后无缝接回）。
// textOffset 处理最后一条还在增长的合并文本：客户端已看过前 textOffset 个字符，只补后半段。
// slice 到加入订阅是同步完成的，中间不会漏事件也不会重复。
app.get("/api/chat/stream/:id", (req, res) => {
  const run = activeRuns.get(req.params.id);
  if (!run || !run.events) return res.status(404).json({ error: "该会话没有正在运行的任务" });
  if (!guardRun(req, res, req.params.id)) return;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.on("error", () => {});
  const from = Math.max(0, parseInt(req.query.from, 10) || 0);
  const textOffset = Math.max(0, parseInt(req.query.textOffset, 10) || 0);
  run.events.slice(from).forEach((ev, i) => {
    const out = i === 0 && textOffset && ev.type === "text" ? { type: "text", delta: String(ev.delta).slice(textOffset) } : ev;
    try { res.write(`data: ${JSON.stringify(out)}\n\n`); } catch {}
  });
  run.subscribers.add(res);
  req.on("close", () => run.subscribers.delete(res));
});

// 任务历史列表。前端侧栏以前只信 localStorage，清个缓存 / 换台机器就「历史全没了」，
// 其实对话一直在 data/sessions/ 里躺着。这条接口是那份列表的权威来源，前端登录后跟本地缓存并一次。
app.get("/api/sessions", (req, res) => {
  const rows = listSessionsOnDisk().filter((r) => ownSession(req.user, r)).slice(0, 300);
  res.json({ sessions: rows.map(({ user, ...r }) => r) }); // 归属只用来过滤，不回给前端
});

// 历史会话回放
app.get("/api/session/:id", (req, res) => {
  const s = guardSession(req, res);
  if (!s) return;
  // 之前点过的 👍👎 一起带回：反馈早落库了，重开对话不该看着像没点过
  let feedback = [];
  try { feedback = evolve.readFeedback().filter((f) => f.session === req.params.id).map((f) => ({ turn: f.turn, verdict: f.verdict, note: f.note || "" })); } catch {}
  res.json({ transcript: s.transcript, dir: s.dir || null, model: s.model || null, goal: s.goal || null, feedback });
});

// 归档目标：目标卡上点 ✕。已达成/不想要了都走这里，不删记录只改状态
app.post("/api/session/:id/goal", (req, res) => {
  const s = guardSession(req, res);
  if (!s) return;
  if (!s.goal) return res.status(400).json({ error: "该对话没有目标" });
  if ((req.body || {}).action === "close") {
    s.goal.status = "closed";
    saveSession(req.params.id);
  }
  res.json({ ok: true, goal: s.goal });
});

// ---------- 内置评测（界面版）：spawn 子进程跑 eval/run.js ----------
// 子进程隔离是刚需：评测会 setWorkspaceDir 到自己的沙盒目录，进程内跑会把主应用的工作空间劫走
const evalState = { running: false, lines: [], startedAt: 0, model: "", exit: null };
function evalSummaryBrief(j) {
  if (!j) return null;
  // 兼容两代格式：v3 有 repeat/pass1_avg/attempts，旧格式按 k=1 折算，前端只走一条代码路径
  return {
    at: j.at, model: j.model, model_id: j.model_id, score_pct: j.score_pct,
    repeat: j.repeat || 1,
    pass1_avg: j.pass1_avg != null ? j.pass1_avg : (j.tasks ? Math.round((j.full_pass / j.tasks) * 100) : 0),
    flaky_tasks: j.flaky_tasks || [], fail_code_counts: j.fail_code_counts || {},
    baseline: j.baseline || null,
    tasks: j.tasks, full_pass: j.full_pass, checks_passed: j.checks_passed, checks_total: j.checks_total,
    tokens_total: j.tokens_total, avg_prompt_per_call: j.avg_prompt_per_call || 0,
    commit: j.commit || "", judge: j.judge || null, human: j.human || null,
    results: (j.results || []).map((r) => {
      const k = r.k || 1;
      const passes = r.passes != null ? r.passes : (r.passed === r.total ? 1 : 0);
      return {
        id: r.id, name: r.name, level: r.level || 1, kind: r.kind || "",
        passed: r.passed, total: r.total, elapsed_s: r.elapsed_s,
        k, passes, pass_rate: r.pass_rate != null ? r.pass_rate : +(passes / k).toFixed(3),
        flaky: !!r.flaky, fail_codes: r.fail_codes || [],
        attempts: (r.attempts || []).map((a) => ({ n: a.n, passed: a.passed, total: a.total, elapsed_s: a.elapsed_s, fail_code: a.fail_code || null })),
        tool_calls: r.tool_calls || 0, tool_errors: r.tool_errors || 0,
        judge: r.judge ? (r.judge.dims ? { passed: r.judge.passed, total: r.judge.total } : (r.judge.score ? { score: r.judge.score, verdict: r.judge.verdict || "" } : null)) : null,
        human: r.human || null,
        failed: (r.checks || []).filter((c) => !c.ok).map((c) => c.name),
      };
    }),
  };
}
function evalHistory(limit = 20) {
  const out = [];
  try {
    const root = dataPath("eval", "runs");
    for (const d of fs.readdirSync(root).sort().reverse()) {
      const j = store.readJson(path.join(root, d, "results.json"), null);
      if (j) out.push({ dir: d, ...evalSummaryBrief(j) });
      if (out.length >= limit) break;
    }
  } catch {}
  return out;
}
app.post("/api/eval/start", (req, res) => {
  if (evalState.running) return res.status(409).json({ error: "已有一轮评测在跑，等它结束" });
  const model = String((req.body || {}).model || config.active_model);
  if (!(config.models || []).some((m) => m.name === model)) return res.status(400).json({ error: `模型「${model}」不在列表里` });
  const args = [appPath("eval", "run.js"), "--model", model];
  const only = String((req.body || {}).task || "").trim();
  if (only) args.push("--task", only);
  const judge = String((req.body || {}).judge || "").trim();
  if (judge && !(config.models || []).some((m) => m.name === judge)) return res.status(400).json({ error: `评委模型「${judge}」不在列表里` });
  if (judge) args.push("--judge", judge);
  const repeat = Math.max(1, Math.min(5, Math.round(+(req.body || {}).repeat) || 1));
  if (repeat > 1) args.push("--repeat", String(repeat));
  evalState.running = true; evalState.lines = []; evalState.startedAt = Date.now(); evalState.model = model; evalState.exit = null;
  const child = require("child_process").spawn(process.execPath, args, {
    cwd: appPath(),
    env: { ...process.env, OPENWORKBUDDY_HOME: DATA_DIR, ELECTRON_RUN_AS_NODE: "1" }, // execPath 是 Electron，不加就弹新应用实例
  });
  let buf = "";
  const onData = (d) => {
    buf += String(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1);
      if (line) { evalState.lines.push(line); if (evalState.lines.length > 400) evalState.lines.shift(); }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => { evalState.running = false; evalState.exit = code; });
  child.on("error", (e) => { evalState.running = false; evalState.exit = -1; evalState.lines.push("评测进程启动失败: " + e.message); });
  res.json({ ok: true, model });
});
app.get("/api/eval/status", (_req, res) => {
  res.json({ running: evalState.running, model: evalState.model, startedAt: evalState.startedAt, exit: evalState.exit, lines: evalState.lines });
});
app.get("/api/eval/history", (_req, res) => {
  const bl = store.readJson(dataPath("eval", "baseline.json"), null);
  res.json({ runs: evalHistory(), baseline: bl ? { at: bl.at, commit: bl.commit || "", model: bl.model || "", source_dir: bl.source_dir || "" } : null });
});
// 钉基线：把某次跑批的各题通过率写进 eval/baseline.json，之后每次跑批自动逐题对比、退步点名
app.post("/api/eval/baseline", (req, res) => {
  const dir = String((req.body || {}).dir || "");
  if (!/^[\w.-]+$/.test(dir)) return res.status(400).json({ error: "目录名不合法" });
  const j = store.readJson(dataPath("eval", "runs", dir, "results.json"), null);
  if (!j) return res.status(404).json({ error: "没有这次评测的记录" });
  const bl = {
    at: j.at, commit: j.commit || "", model: j.model, repeat: j.repeat || 1,
    pass1_avg: j.pass1_avg != null ? j.pass1_avg : (j.tasks ? Math.round((j.full_pass / j.tasks) * 100) : 0),
    score_pct: j.score_pct, source_dir: dir,
    tasks: Object.fromEntries((j.results || []).map((r) => {
      const k = r.k || 1;
      const passes = r.passes != null ? r.passes : (r.passed === r.total ? 1 : 0);
      return [r.id, { pass_rate: r.pass_rate != null ? r.pass_rate : +(passes / k).toFixed(3) }];
    })),
  };
  fs.mkdirSync(dataPath("eval"), { recursive: true });
  fs.writeFileSync(dataPath("eval", "baseline.json"), JSON.stringify(bl, null, 2));
  res.json({ ok: true, baseline: { at: bl.at, commit: bl.commit, model: bl.model, source_dir: dir } });
});
// 单次评测完整明细：每题 checks、AI 评委理由、人工分、最终回复摘录、产物清单
app.get("/api/eval/run/:dir", (req, res) => {
  const dir = String(req.params.dir || "");
  if (!/^[\w.-]+$/.test(dir)) return res.status(400).json({ error: "目录名不合法" });
  const j = store.readJson(dataPath("eval", "runs", dir, "results.json"), null);
  if (!j) return res.status(404).json({ error: "没有这次评测的记录" });
  res.json({ dir, ...j });
});
// 人工打分：写回该次评测的 results.json，与机器分 / AI 评委分并列保存，互不覆盖
app.post("/api/eval/human", (req, res) => {
  const b = req.body || {};
  const dir = String(b.dir || "");
  if (!/^[\w.-]+$/.test(dir)) return res.status(400).json({ error: "目录名不合法" });
  const file = dataPath("eval", "runs", dir, "results.json");
  const j = store.readJson(file, null);
  if (!j) return res.status(404).json({ error: "没有这次评测的记录" });
  const r = (j.results || []).find((x) => x.id === String(b.task_id || ""));
  if (!r) return res.status(404).json({ error: "没有这道题" });
  const score = Math.round(+b.score);
  if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: "分数须是 1-5 的整数" });
  r.human = { score, comment: String(b.comment || "").slice(0, 500), by: req.user ? req.user.username : "", at: new Date().toISOString() };
  const scored = (j.results || []).filter((x) => x.human && x.human.score);
  j.human = { scored: scored.length, avg: +(scored.reduce((s, x) => s + x.human.score, 0) / scored.length).toFixed(2) };
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  res.json({ ok: true, task_id: r.id, human: j.human });
});

// 给单个对话指定模型（null = 跟随全局默认）。只影响这一个对话，不动全局 active_model
app.post("/api/session/:id/model", (req, res) => {
  const name = (req.body || {}).model;
  const s = getSession(req.params.id);
  if (name === null || name === undefined || name === "") {
    delete s.model;
  } else {
    if (!Array.isArray(config.models) || !config.models.some((m) => m.name === name)) {
      return res.status(400).json({ error: `模型「${name}」不在模型列表里` });
    }
    s.model = String(name);
    // 记住这次手动选择：开了「新对话沿用上次选的模型」时，下个新对话默认就用它。
    // 多人服务器上按人记——不然 A 换一次模型，B 开的下一个新对话就跟着变了
    if (ownPrefs(req)) prefs.write(req.user, { last_picked_model: s.model });
    else if (config.last_picked_model !== s.model) { config.last_picked_model = s.model; saveConfig(); }
  }
  saveSession(req.params.id);
  res.json({ ok: true, model: s.model || null });
});

// 助理模式没有会话 id（消息走 IM 的 local 通道），模型选择只能挂在配置上：选完就存，
// 刷新页面、离开助理页再回来都还是它。不存的话标签会自己弹回全局默认，
// 而下面真正跑任务用的又是标签上那个——那就成了另一种「标签说一套、实际跑一套」
app.post("/api/assist/model", (req, res) => {
  const name = (req.body || {}).model;
  const val = name === null || name === undefined || name === "" ? "" : String(name);
  if (val && !(Array.isArray(config.models) && config.models.some((m) => m.name === val))) {
    return res.status(400).json({ error: `模型「${val}」不在模型列表里` });
  }
  // 「我在助理页用哪个模型」是个人的事。以前一律写 config，结果是多人服务器上谁都能
  // 改掉所有人的助理模型——而且这条路径压根没被服务器级的闸盖住
  if (ownPrefs(req)) {
    prefs.write(req.user, { assist_model: val });
    return res.json({ ok: true, model: val || null });
  }
  if (val) config.assist_model = val;
  else delete config.assist_model;
  saveConfig();
  res.json({ ok: true, model: config.assist_model || null });
});

// 删除会话（内存 + 磁盘一起删）
app.delete("/api/session/:id", (req, res) => {
  if (!guardSession(req, res)) return;
  sessions.delete(req.params.id);
  sessStamp.delete(req.params.id);
  try { fs.unlinkSync(sessFile(req.params.id)); } catch {}
  res.json({ ok: true });
});

// 停止正在运行的任务：中断当前模型调用，agent 循环在下一个检查点收尾
app.post("/api/chat/stop", (req, res) => {
  const sessionId = (req.body || {}).sessionId;
  const run = activeRuns.get(sessionId);
  if (!run) return res.json({ ok: false, error: "该会话没有正在运行的任务" });
  if (!guardRun(req, res, sessionId)) return;
  run.ctrl.abort();
  res.json({ ok: true });
});

let scheduler;

// ---------- 定时任务管理 API ----------
app.get("/api/schedules", (_req, res) => res.json(scheduler.list()));
// 运行记录。只看 last_result 的话，昨天跑挂今天跑好就查无此事
app.get("/api/schedules/runs", (req, res) => res.json(scheduler.runs(Math.min(+req.query.limit || 100, 300))));
app.post("/api/schedules", (req, res) => {
  try {
    res.json(scheduler.add(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.patch("/api/schedules/:id", (req, res) => {
  try {
    const t = scheduler.update(req.params.id, req.body || {});
    if (!t) return res.status(404).json({ error: "任务不存在" });
    res.json(t);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/schedules/:id", (req, res) => res.json({ ok: scheduler.remove(req.params.id) }));
// 批量：一条条点太慢，但批量删是不可逆的，所以要求前端明确传 action
app.post("/api/schedules/bulk", (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "没选中任何任务" });
  if (!["enable", "disable", "delete"].includes(action)) return res.status(400).json({ error: "未知操作" });
  let n = 0;
  for (const id of ids) {
    if (action === "delete") n += scheduler.remove(id) ? 1 : 0;
    else n += scheduler.toggle(id, action === "enable") ? 1 : 0;
  }
  res.json({ ok: true, count: n });
});
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
      if (owner && account.creditsEnabled(owner) && account.balanceOf(owner) <= 0) {
        throw new Error("积分不足：管理员可以在 Web 端「账号 · 用量」里充值，或者把「积分限额」关掉");
      }
      // 调用方（助理页）指定了模型就解析成真正的 LLM 顶上去。模型名不在列表里时 llmForSession
      // 返回的是会报错的桩，宁可当场报错也不许悄悄退回全局默认
      const { modelName, user: caller, ...rest } = args || {};
      const runLLM = modelName ? llmForSession({ model: modelName }) : llm;
      // 「记谁的账」和「用谁的记忆、替谁审批」是两件事：钱一律记在管理员头上（他才是掏 API 费的人），
      // 身份则听调用方的。助理页那边是真有登录态的，成员发的消息不能顶着管理员的身份跑；
      // 飞书 / 定时任务确实没有登录态，那才退回管理员。
      // 注意 user 必须从 rest 里摘出来单独判：留在 rest 里的话，调用方传了个 undefined 也会把兜底覆盖掉
      const r = await baseRuntime.runTask({
        user: caller || (owner ? owner.username : undefined),
        taskLabel: source === "im" ? "IM 对话" : source === "schedule" ? "定时任务" : source,
        // IM / 定时任务的产物也各归各的文件夹（仅默认工作空间；调用方可在 args 里覆盖）
        baseDir:
          path.resolve(getWorkspaceDir()) === dataPath("workspace")
            ? source === "im" ? "IM_对话" : source === "schedule" ? "定时任务" : null
            : null,
        projectContext: projectContextOf(activeProject()),
        ...rest,
        ...(modelName ? { llmOverride: runLLM } : {}),
      });
      if (owner && r && r.usage && r.usage.calls > 0) {
        const ran = r.provider ? { model: r.model || r.provider, provider: r.provider } : runLLM;
        account.chargeRun(owner, { ...r.usage, model: ran.model, provider: ran.provider, source });
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
  // MCP 连接不挡启动：窗口秒开，连接器在后台就绪（agent 每次跑任务都是现取 toolDefs，
  // 晚几秒连上也不丢工具）。首个定时 tick 在 +20s，届时早已连完。
  mcpManager
    .startAll([...(config.mcp_servers || []), ...pluginServers])
    .then(() => console.log(`MCP 工具就绪: ${mcpManager.toolDefs().length} 个`))
    .catch((e) => console.warn("[MCP] 启动失败:", e.message));
  const badPlugins = pluginsMgr.loadPlugins().filter((p) => !p.ok);
  for (const p of badPlugins) console.warn(`[插件] ${p.name} 装不上: ${p.error}`);
  runtime = createAgentRuntime({ config, llm, mcpManager, experts, expertTeams });

  scheduler = createScheduler({
    runtime: accountedRuntime(runtime, "schedule"),
    onResult: (item, text) =>
      notify.pushBots(config, `【OpenWorkBuddy·定时任务】${item.name}\n${(text || "").slice(0, 800)}`),
  });

  // 夜间复盘：**默认关**。开了之后每 10 分钟看一次表，到点且今天还没跑过就跑一轮。
  // 它只生成提案，永远不会自己改提示词——第二天早上你在 设置→自进化 里决定要不要。
  let evolveLastDay = "";
  setInterval(async () => {
    const ev = config.evolve || {};
    if (!ev.auto) return;
    const d = new Date();
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (d.getHours() !== (ev.hour === undefined ? 3 : ev.hour) || evolveLastDay === day) return;
    evolveLastDay = day;
    try {
      const r = await evolve.runReview({ llm, days: ev.days || evolve.CAPS.window });
      evolve.recordRun({ ok: true, trigger: "夜间", turns: r.mined.turns, added: (r.added || []).length, gated: (r.gated || []).length, notes: r.notes || [] });
      if ((r.added || []).length) {
        notify.pushBots(config, `【OpenWorkBuddy·自进化】昨夜复盘：${r.mined.turns} 个回合，${r.added.length} 条改进提案等你审（设置→自进化）`);
      }
    } catch (e) {
      // 后台飞轮吞掉异常，等于这条链早就停了而你还以为它在转。成败都落一行，界面上看得见
      try { evolve.recordRun({ ok: false, trigger: "夜间", error: e.message }); } catch {}
      console.warn("[自进化] 夜间复盘失败:", e.message);
    }
  }, 10 * 60 * 1000);

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

  sweepInterruptedRuns(); // 上次没善终的任务先标注中断，再开门迎客

  // config.json 是用户手改的文件，少一个顶层块很正常。以前这里直接 config.server.port，
  // 结果是启动时抛 “Cannot read properties of undefined (reading 'host')”——
  // 一条完全看不出跟配置有关的报错。缺就用默认值，别拿栈回溯糊用户一脸。
  const srvCfg = config.server || {};
  const port = +process.env.PORT || srvCfg.port || 3800;
  // 默认只听本机：这个进程手里有 run_shell 和整个文件系统，绑 0.0.0.0 等于把 shell 挂到公网。
  // 要放出去（Docker / 服务器）必须显式 HOST=0.0.0.0，并且自己在前面套 HTTPS + 反代。
  const host = process.env.HOST || srvCfg.host || "127.0.0.1";
  /**
   * 告诉权限层这是「一个人的桌面应用」还是「一台给多个人用的服务器」。
   *
   * 必须赶在第一个请求之前定下来（listen 之前就调，最稳）。判据和理由都写在 admin.js 的
   * setDeployment 上面：Electron 壳 + 只听回环 = 屏幕前就一个人，服务器级的那道闸和凭证脱敏
   * 一起关掉；只要绑到别的地址（Docker 走的 HOST=0.0.0.0 就是），两道全部照旧。
   */
  const solo = admin.setDeployment({
    host,
    // ELECTRON_RUN_AS_NODE：run_node 派生的子进程也带 electron 版本号，但它不是应用本体
    shell: !!(process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE),
  });
  if (solo) console.log("个人桌面版：设置归你自己管，不分平台管理员");
  const server = app.listen(port, host, () => {
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.warn(`⚠️  正在监听 ${host}:${port}（非本机）。请确认前面有反向代理 + HTTPS，且已经注册了管理员账号——否则任何人都能拿到这台机器的 shell。`);
    }
    console.log(`OpenWorkBuddy 已启动: http://localhost:${port}（服务端初始化 ${Date.now() - BOOT_T0}ms）`);
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
      return;
    }
    // 以前这里 throw。listen 的 error 是异步事件，抛出去没人接，直接变成 uncaughtException——
    // 命令行下还能看见栈，装成桌面应用之后是主进程当场没了，用户看到的就是「双击没反应，
    // 任务管理器里有进程，屏幕上什么都没有」。EACCES 在 Windows 上尤其常见：
    // Hyper-V / WSL 会成片预留端口，3800 落在保留段里报的是 EACCES 而不是 EADDRINUSE。
    bootFailed(e);
  });
}

/**
 * 启动失败的唯一出口。
 *
 * 装成桌面应用时服务端是在 Electron 主进程里 require 起来的，在这儿 process.exit 等于
 * 把整个应用连窗口一起带走，而且带走得悄无声息——electron-main.js 里那个「3 秒兜底亮窗」
 * 的定时器都还没轮到就没进程了。所以有壳的时候把错误交回壳，让它把原因画在窗口里；
 * 纯命令行（node server.js）没有壳，维持原来的退出码 1，行为一个字节不变。
 */
function bootFailed(e) {
  console.error("启动失败:", e);
  const toShell = global.__wbBootFail;
  if (typeof toShell === "function") {
    try {
      toShell(e);
      return; // 交出去了就别再退进程，窗口还要留着显示原因
    } catch (e2) {
      console.error("[启动] 壳层没接住，退回命令行行为:", e2 && e2.message);
    }
  }
  process.exit(1);
}

process.on("SIGINT", () => {
  mcpManager.stopAll();
  process.exit(0);
});

main().catch(bootFailed);
