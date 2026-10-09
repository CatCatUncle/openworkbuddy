// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 安全中心 — 沙箱三闸（文件/命令/网络）+ 审计日志 + 命令审批 + macOS 系统授权检测。
 *
 * 设计原则：每一项都是真实闸门（在工具执行层硬拦截），不做仅展示的开关。
 * - 文件安全：workspace 内默认可用；黑名单永远拦；workspace 外仅白名单目录放行
 * - 命令安全：放行名单直接执行；询问名单挂起等用户在界面上批准（超时/停止即拒绝）
 * - 网络安全：域名黑名单拦截；白名单非空时只允许白名单域名
 * - 审计中心：网络访问/命令执行/拦截记录全部落 data/audit.json（环形 1000 条）；
 *   本机引擎借工具时那些工具跑在桥那个子进程里，记在 data/audit-bridge.jsonl，看列表、导出时并进来
 */

const fs = require("fs");
const path = require("path");
const { APP_DIR, DATA_DIR, dataPath } = require("../../platform/paths");
const os = require("os");
const { spawn } = require("child_process");

const jsonStore = require("../../platform/store");

const AUDIT_FILE = dataPath("data", "audit.json");
let auditLog = jsonStore.readJson(AUDIT_FILE, []);
if (!Array.isArray(auditLog)) auditLog = [];

/**
 * 权限模式：一档一档地决定"要不要问你"。
 *
 * 以前只有一套写死的规则（工作目录内随便写、命令按名单问），结果两头不讨好：
 * 想让它安心改代码的人嫌它烦，想全程盯着的人又觉得它太自由。
 * 现在把这件事变成一个明确的档位，改档立即生效，界面上一眼看得见自己在第几档。
 *
 * 注意：**文件黑名单在任何档位下都拦得住**（`~/.ssh`、config.json 这些）。
 * 那不是"权限档次"，那是不管你选哪档都不该让 agent 顺手摸到的东西。
 */
const PERMISSION_MODES = {
  plan: { label: "只看不动", desc: "只读：不写文件、不跑命令，适合先让它把现场看明白", write: "deny", cmd: "deny" },
  ask: { label: "每步都问", desc: "写文件和跑命令都要你点头，最谨慎也最费手", write: "ask", cmd: "ask" },
  auto: { label: "自动改文件", desc: "工作目录里的文件随便改；命令按名单来（删除、sudo 这些照样问）", write: "allow", cmd: "rules" },
  full: { label: "全自动", desc: "命令也不问了，只剩文件黑名单、高危命令确认（rm -rf 到 /dev、down -v、强推这类）和审计。确定它在干什么再开", write: "allow", cmd: "allow" },
};
const DEFAULT_MODE = "auto";

function permissionMode(sec) {
  const m = String((sec || {}).permission_mode || DEFAULT_MODE);
  return PERMISSION_MODES[m] ? m : DEFAULT_MODE;
}

/** 本项目的档位 → 外部 CLI 引擎自己那套开关 */
const ENGINE_MODES = {
  //            claude -p 的 --permission-mode   codex 的 sandbox_mode
  plan: { claude: "plan", codex: "read-only" },
  ask: { claude: "default", codex: "read-only" },
  auto: { claude: "acceptEdits", codex: "workspace-write" },
  full: { claude: "bypassPermissions", codex: "workspace-write" },
};

/**
 * 把安全档位翻译成外部引擎（本机 Claude Code / Codex）认的开关。
 *
 * 非做不可的理由：这两个 CLI 自带工具、自带循环，它们写文件、跑命令**不经过**本项目的
 * 安全中心——只有从 MCP 桥回流的那批工具才走那道闸。以前这里硬写死 `acceptEdits`，
 * 于是用户在设置里选了「只看不动」或「每步都问」，切到本机引擎照样随便改文件，
 * 界面上那颗开关等于摆设。档位是用户对「让它自己动到哪一步」的表态，必须一路传到底。
 *
 * 「每步都问」翻成 claude 的 default：-p 是非交互的，没人能点同意，于是需要审批的动作
 * 一律被拒。听起来很废，但那正是这一档的字面意思，而且它拒了会明说，比背着人写下去强。
 *
 * disallow 这一串是同一个道理的第二面：名单里写着「这类命令要问我一下」，可这条路上
 * 没有「问」这个动作，那就只剩「不给用」。全自动档不加——那一档的意思就是别再拦了。
 * 本机 Claude Code 勾了「删文件等操作先问我」就有「问」了（见下面的 askingGuard）。
 *
 * @param {any} sec
 * @param {{canAsk?: boolean}} [o] canAsk：这个引擎勾一下就能弹卡问（本机 Claude Code），只是属主没勾。
 *   提示里就别说「没有审批通道」，指到那颗勾上——说没有，人就不会去找
 * @returns {{mode:string, claudeMode:string, codexSandbox:string, allowShim:boolean, disallow:string[], note:string}}
 */
function engineGuard(sec, { canAsk = false } = {}) {
  const mode = permissionMode(sec);
  const m = ENGINE_MODES[mode] || ENGINE_MODES[DEFAULT_MODE];
  const heads = [];
  if (mode !== "full") {
    // 名单里写的是前缀（"sudo "、"diskutil erase"），CLI 那边的匹配单位是可执行文件名，
    // 所以取第一个词。"diskutil erase" 收紧成整个 diskutil：宁可多禁一点，也别放过
    for (const p of (sec || {}).cmd_ask || []) heads.push(String(p || "").trim().split(/\s+/)[0]);
    // 删除保护是另一颗独立开关（不在 cmd_ask 里），但道理一样：说了要问，这条路问不着。
    // rmdir 也得点名：「自动改文件」档里 claude 自己放行 rm 和 rmdir（2.1.295 实测），unlink、shred 这些它本来就会来问
    if ((sec || {}).delete_protect !== false) heads.push("rm", "rmdir");
  }
  const uniq = [...new Set(heads.filter(Boolean))];
  // 那颗勾只有属主看得见：多人共用时说一声找谁，不然成员翻遍设置也找不到（跟 engines/approve.js 的 wayOut 一个口径）
  const tip = `想让它先问你：设置 → 智能体 → 底层引擎，勾「删文件等操作先问我」${isMultiUser() ? "（多人共用时只有平台管理员能改）" : ""}。`;
  const notes = canAsk
    ? {
      plan: "安全档位是「只看不动」：本机 CLI 这一趟按只读跑，不写文件也不跑命令。",
      ask: "安全档位是「每步都问」，本机 Claude Code 这一趟没开审批，要写文件或跑命令会被直接拒。" + tip,
      auto: uniq.length ? `按你的安全设置，本机 Claude Code 这一趟不跑：${uniq.join("、")}。` + tip : "",
      full: "",
    }
    : {
      plan: "安全档位是「只看不动」：本机 CLI 这一趟按只读跑，不写文件也不跑命令。",
      ask: "安全档位是「每步都问」，而本机 CLI 这条路没有审批通道（非交互，没人能点同意）——它要写文件或跑命令会被直接拒。想让它动手，把档位调到「自动改文件」。",
      auto: uniq.length ? `按你的安全设置，本机 CLI 不许自己跑这些命令：${uniq.join("、")}（这条路没有审批通道，只能直接禁）。` : "",
      full: "",
    };
  return {
    mode,
    claudeMode: m.claude,
    codexSandbox: m.codex,
    // 只看不动：连本项目借出去的那条命令行入口也不放行，否则等于从后门绕开档位（两个引擎都认：搭桥时 noShim）。
    // 每步都问照放：同一批工具走 MCP 那条路本来就放行（claude-code.js 的 --allowed-tools mcp__…），
    // 只关命令行这一头什么也没收住；这批工具从桥回流时照样过本项目的安全中心
    allowShim: PERMISSION_MODES[mode].cmd !== "deny",
    disallow: uniq.map((h) => `Bash(${h}:*)`),
    note: notes[mode] || "",
  };
}

/**
 * 问答 / 计划模式那一趟：不管安全档位在哪档，本机 CLI 都按只读跑（claude plan、codex read-only），
 * 借出去的命令行入口也不放。档位是「让它自己动到哪一步」，问答 / 计划是「这一趟本来就不动手」，后者更紧就听后者。
 * 内置引擎这两档只摆读的工具、清单外的一律不执行；换了底层引擎能做的事不该变多。
 * 收紧的话已经由任务模式说过了，这里不再挂提示。
 * @param {ReturnType<typeof engineGuard>} base
 */
function readOnlyGuard(base) {
  return { ...base, claudeMode: ENGINE_MODES.plan.claude, codexSandbox: ENGINE_MODES.plan.codex, allowShim: false, readOnly: true, note: "" };
}

/**
 * 审批交回了主进程的那一趟（属主勾了「删文件等操作先问我」，只有 claude 有这条路，见 engines/approve.js）：
 * 名单里说「要问」的不再直接禁，改挂成 claude 的「先问」规则（claude-code.js 拼成 --settings）——
 * 它碰到这类命令就来问，主进程摆卡等人点。不挂的话「自动改文件」档里它自己就把 rm 跑了，根本不来问。
 * 档位那两句「这条路没有审批通道」也不说了：现在有了，碰到会弹卡
 * @param {ReturnType<typeof engineGuard>} base
 * @returns {ReturnType<typeof engineGuard> & {ask: string[]}}
 */
function askingGuard(base) {
  if (/** @type {any} */ (base).readOnly) return { ...base, ask: [] };
  // 「只看不动」那句照说：能问了也还是只读
  return { ...base, ask: base.disallow, disallow: [], note: base.mode === "plan" ? base.note : "" };
}

/**
 * 要人点头、这次又没批下来（或者问不了）的时候，用户去哪儿放行。照设置页上真有的字写：模型会原样转告，
 * 差一个字用户就找不到（10-09 有人照着「设置 → 安全中心 的名单」翻了半天——页签叫「安全」，名单叫「放行名单」）。
 * 内置引擎的审批闸（agent/tools.js passGate）和本机 Claude Code 的审批（engines/approve.js）共用这一份。
 * 设置里没地方能预先放行的返回空串：指过去用户翻遍了也找不到
 * @param {{rule?: string, ruleKey?: string, blacklist?: boolean}} verdict
 */
function wayOut(verdict) {
  const rule = String((verdict && verdict.rule) || "");
  const who = isMultiUser() ? "（多人共用时只有平台管理员能改）" : "";
  if (rule.startsWith("删除保护")) return `到 设置 → 安全 →「数据安全」关掉「删除保护」，或者在「沙箱安全 · 命令」的「放行名单」加一行 rm${who}`;
  if (rule.startsWith("命令询问名单")) return `到 设置 → 安全 →「沙箱安全 · 命令」，把它从「询问名单」删掉，或者加进「放行名单」${who}`;
  if (rule.startsWith("每步都问") || rule.startsWith("写文件")) return `到 设置 → 安全 →「权限档位」选「自动改文件」${who}`;
  // 高危命令、碰了文件黑名单、看不清内容的（编码过、太长没拆完）、代码里开子进程：要么排在放行名单前面判，
  // 要么本来就不让永久放开，加进名单也照样问
  if (!isPersistableRule(verdict && verdict.ruleKey) || (verdict && verdict.blacklist)) return "";
  return `到 设置 → 安全 →「沙箱安全 · 命令」的「放行名单」加上这类命令${who}`;
}

const DEFAULTS = {
  permission_mode: DEFAULT_MODE, // plan / ask / auto / full，见 PERMISSION_MODES
  gateway: true, // 安全网关总开关：关闭后黑名单/审批闸不再拦截（审计照记）
  delete_protect: true, // 删除保护：rm 类命令需要审批
  // 名单外先判一句：四张名单都没命中、本来要一声不吭直接跑的那条，先花一道题问问撤不撤得回来。
  // 只会把「直接跑」抬成「弹审批卡」，抬不动别的。默认关——它要把命令原文发给判断模型，这事得用户自己点头。
  cmd_risk_gate: false,
  batch_delete_threshold: 50,
  file_whitelist: ["<app>/skills"], // workspace 外允许访问的路径前缀（绝对路径或 ~ 开头）；技能自带资源默认放行
  file_blacklist: ["~/.ssh", "~/Library/Keychains", "<app>/config.json", "<app>/data/users.json"],
  cmd_allow: [], // 命令前缀放行名单：匹配即直接执行
  cmd_ask: ["sudo ", "shutdown", "reboot", "mkfs", "diskutil erase", "killall ", "format "],
  url_whitelist: [], // 非空 = 只允许这些域名（后缀匹配）
  url_blacklist: [],
  runtime_node: true,
  runtime_python: true,
  approval_timeout_s: 120, // 审批等待上限（秒），超时按拒绝处理
  // 技能/连接器安全检查的第二把尺子：外部 toolward（可选，没装就只用自带的 skill-guard）。
  // auto = 装了就用，它报 critical 就拦、high/medium 摊开给人看；
  // advisory = 照样用，但最多只提醒，不许拦人；off = 不叫它。
  // 为什么它不在 package.json 的依赖里：PolyForm Noncommercial 授权，公司用要单独授权。见 toolward.js 顶上那三条边界。
  toolward: "auto",
  toolward_bin: "", // 留空 = 在 PATH 和几个常见全局 bin 目录里找；填了就只认这一个，不回退
  // AI 跑的命令、脚本、外部引擎、钩子只拿最小环境变量（platform/child-env.js），这里是属主额外放行的变量名。
  // 像 Key 的名字（*_API_KEY、*_TOKEN……）只在这台机器只有一个账号时才给；只有平台属主能改
  env_passthrough: [],
  // AI 跑的命令和脚本在 macOS 上套系统沙箱（platform/sandbox.js）：default = 多人用的 Mac 按 required、其余按 auto；
  // auto = 立不起来照常跑、设置页标出来；required = 立不起来就不跑；off = 不套
  sandbox: "default",
  sandbox_level: "hardened", // hardened = 连沙箱外服务的 unix socket 只放 DNS 和下面这份；basic = 不管 socket
  sandbox_unix_allow: [], // 额外放行的 unix socket 绝对路径（docker、数据库之类）
};

/** 给 config.security 补默认值（保留用户已改项），返回引用 */
function getSecurity(config) {
  config.security = { ...DEFAULTS, ...(config.security || {}) };
  return config.security;
}

// ---------- 审计 ----------

/**
 * 本机引擎借工具时，工具跑在桥那个子进程里（engines/tool-bridge.js）。那边以前也走下面这份防抖整写，两头吃亏：
 * 命令行入口跑完一条就 process.exit，500ms 的定时器还没响，这条就没了；MCP 那条路整份覆盖写，
 * 写进去的是桥启动时读到的旧快照，主进程下一次写又把它盖回去。
 * 桥里改成每条立刻追加一行到另一份文件；写不进去（codex 的命令沙箱不让写数据目录）就把这条原样打到 stderr。
 * 主进程看列表、导出时并进来，清空时一起清。过 512KB 换一份，留一份旧的
 */
const BRIDGE_AUDIT_FILE = dataPath("data", "audit-bridge.jsonl");
const BRIDGE_AUDIT_MAX = 512 * 1024;
let auditSink = "memory";
/** 桥启动时调一次 setAuditSink("append")；主进程不用管 */
function setAuditSink(mode) {
  auditSink = mode === "append" ? "append" : "memory";
  if (auditSink !== "append") return;
  try { if (fs.statSync(BRIDGE_AUDIT_FILE).size > BRIDGE_AUDIT_MAX) fs.renameSync(BRIDGE_AUDIT_FILE, BRIDGE_AUDIT_FILE + ".1"); } catch {}
}
function appendBridgeAudit(entry) {
  try {
    fs.mkdirSync(path.dirname(BRIDGE_AUDIT_FILE), { recursive: true });
    fs.appendFileSync(BRIDGE_AUDIT_FILE, JSON.stringify(entry) + "\n");
  } catch (e) {
    try { process.stderr.write(`审计记录没写进 ${BRIDGE_AUDIT_FILE}（${(e && e.message) || e}），这一条是：${entry.ts} [${entry.type}] ${entry.action} ${entry.text}\n`); } catch {}
  }
}
function bridgeAudit() {
  const out = [];
  for (const f of [BRIDGE_AUDIT_FILE + ".1", BRIDGE_AUDIT_FILE]) {
    let raw;
    try { raw = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e && typeof e.ts === "string") out.push(e); } catch {} // 写到一半断电的那行不要
    }
  }
  return out;
}
/** 主进程这份和桥那份按时间并起来；桥那份是空的就原样 */
function allAudit() {
  const b = bridgeAudit();
  if (!b.length) return auditLog;
  return auditLog.concat(b).sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0));
}

let auditDirty = false;
function audit(type, text, action) {
  const entry = { ts: new Date().toISOString(), type, text: String(text || "").slice(0, 300), action: action || "放行" };
  if (auditSink === "append") return appendBridgeAudit(entry);
  auditLog.push(entry);
  if (auditLog.length > 1000) auditLog.splice(0, auditLog.length - 1000);
  if (!auditDirty) {
    auditDirty = true;
    setTimeout(() => {
      auditDirty = false;
      try {
        // 审计是出事之后唯一的凭证：宁可写慢一点，也不能让断电把它截成半个 JSON
        jsonStore.writeJsonAtomic(AUDIT_FILE, auditLog, { backup: false });
      } catch {}
    }, 500);
  }
}
function auditList(limit) {
  return allAudit().slice(-(limit || 100)).reverse();
}
function auditClear() {
  auditLog = [];
  try {
    fs.writeFileSync(AUDIT_FILE, "[]", "utf8");
  } catch {}
  for (const f of [BRIDGE_AUDIT_FILE, BRIDGE_AUDIT_FILE + ".1"]) { try { fs.rmSync(f, { force: true }); } catch {} }
}
function auditExport() {
  return allAudit().map((e) => `${e.ts}\t[${e.type}]\t${e.action}\t${e.text}`).join("\n");
}

// ---------- 多人部署 ----------

/**
 * 这台服务器是不是不止一个账号。账号库在业务层，这一层够不着，由 server.js / cli.js 注册进来。
 * 没注册（单测、只用到闸的工具）= 一个人，判定照旧。
 *
 * 为什么要分：审批卡是发起任务的那个人自己批的。单机桌面上那就是机器主人，弹卡问一声没毛病；
 * 多人共用时成员批自己任务的卡，碰了文件黑名单（config.json 里的 Key、账号库）也就是自己批给自己。
 */
let multiUserFn = null;
/** @param {(() => boolean) | null} fn */
function setMultiUser(fn) {
  multiUserFn = typeof fn === "function" ? fn : null;
}
function isMultiUser() {
  if (!multiUserFn) return false;
  try { return !!multiUserFn(); } catch { return true; } // 读坏按多人：判错了就是让成员自己批黑名单
}
/**
 * 这个账号是不是平台管理员（默认组织的管理员）。同样由 server.js 注册进来，没注册 = 谁都不是。
 * 本机引擎那道「多人共用时要管理员打开」的闸拦的是别人：管理员用的是自己的机器、自己的订阅，用不着先给自己开权限
 */
let platformAdminFn = null;
/** @param {((username: string) => boolean) | null} fn */
function setPlatformAdmin(fn) {
  platformAdminFn = typeof fn === "function" ? fn : null;
}
/** @param {string} [username] */
function isPlatformAdmin(username) {
  if (!platformAdminFn || !username) return false;
  try { return !!platformAdminFn(String(username)); } catch { return false; } // 读坏按成员：判错了只是照旧要管理员打开
}
/** 碰了文件黑名单：一个人时弹卡（不给「同类不再问」），多人时直接拦、不出卡 */
function blacklistVerdict(rule, seg) {
  if (isMultiUser()) return { action: "deny", rule: `${rule}，多人共用时这类一律拦下`, seg, blacklist: true };
  return { action: "ask", rule, seg, ruleKey: "", blacklist: true };
}

// ---------- 文件安全 ----------

function expandPath(s, platform = process.platform) {
  // Windows 上用户填的可能是 `~\.ssh`：反斜杠跟着的 ~ 也是家目录
  const home = platform === "win32" ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/;
  return path.resolve(String(s).replace(home, os.homedir()).replace(/^<app>/, DATA_DIR));
}
/**
 * Windows 上比路径用的样子：不分大小写，`\` 和 `/` 一个意思（连着几个也算一个）。
 * NTFS 默认不分大小写——用户在设置里填 `d:\work`、模型写 `D:\Work\a.md`，指的是同一个地方；
 * 原样比字符串，后者就成了「工作区外面」，要么白弹审批，要么直接报越界。黑名单同理：`~\.SSH` 就是 `~/.ssh`。
 */
function foldWin(s) {
  return String(s).toLowerCase().replace(/[\\/]+/g, "/");
}
function underPrefix(p, prefix, platform = process.platform) {
  if (platform === "win32") {
    const a = foldWin(p);
    const b = foldWin(prefix).replace(/\/$/, ""); // `C:\` 这种根目录自带结尾分隔符
    return a === b || a.startsWith(b + "/");
  }
  return p === prefix || p.startsWith(prefix + path.sep);
}

/**
 * 应用自己的账本：谁也去不掉的那几条黑名单，跟设置里那份名单取并集。
 * config.json 里是全部 Key，users.json 里是登录令牌，orgs.json / vkeys.json 里是限额，
 * usage / api-usage 是限额拿来比的账本，audit 是拦截记录，backups 里是整份 config.json 的打包，
 * secrets 留给以后落盘加密的 Key。改了哪一个，模型白名单和企业限额都形同虚设。
 * 以前它们只是 DEFAULTS 里的默认值：设置页存过一次名单，那份就落进 config.json，后来补的条目一条也进不去。
 */
const CORE_BLACKLIST = [
  "<app>/config.json",
  "<app>/data/users.json",
  "<app>/data/orgs.json",
  "<app>/data/vkeys.json",
  "<app>/data/usage",
  "<app>/data/usage.json",
  "<app>/data/api-usage",
  "<app>/data/api-usage.json",
  "<app>/data/audit*",
  "<app>/backups",
  "<app>/secrets*",
];
/** 实际生效的文件黑名单：应用自带的 + 用户填的 */
function blacklistOf(sec) {
  const all = [...CORE_BLACKLIST, ...(((sec || {}).file_blacklist) || [])].map((b) => String(b).trim()).filter(Boolean);
  return [...new Set(all)];
}
/** data 目录被 OPENWORKBUDDY_DATA_DIR 挪到了别处：账号、组织、账本都跟着去了那儿 */
const MOVED_DATA = (() => {
  const d = process.env.OPENWORKBUDDY_DATA_DIR;
  if (!d) return "";
  const p = path.resolve(d);
  return p === path.join(DATA_DIR, "data") ? "" : p;
})();
/**
 * 一条黑名单落到磁盘上管哪些东西：
 *   - 结尾带 *：按名字前缀（`<app>/data/audit*` 管 audit/ 目录，也管 audit.json）
 *   - 最后一截像文件名（带扩展名）：管整个文件族。写盘留的 .bak、坏文件隔离出的 .corrupt-时间戳、
 *     写到一半的 .<pid>.tmp、编辑器的 ~，内容跟正本一样，Key 一个不少
 *   - 其余当目录：它自己和底下的一切
 * `<app>/data/…` 在 data 目录被挪走时两处都算。
 */
function blacklistTargets(entry, platform = process.platform) {
  const raw = String(entry || "").trim();
  if (!raw) return [];
  const prefix = /[^\\/*]\*+$/.test(raw);
  const bare = raw.replace(/\*+$/, "").replace(/(.)[\\/]+$/, "$1");
  const leaf = bare.split(/[\\/]/).pop() || "";
  const kind = prefix ? "prefix" : /^[^.].*\.[A-Za-z0-9]{1,8}$/.test(leaf) ? "file" : "dir";
  const roots = [expandPath(bare, platform)];
  const m = /^<app>[\\/]data(?=$|[\\/])/.exec(bare);
  if (m && MOVED_DATA && platform === process.platform) roots.push(path.join(MOVED_DATA, bare.slice(m[0].length)));
  return roots.map((p) => ({ raw, kind, path: p, dir: path.dirname(p), leaf: path.basename(p) }));
}
/** 名字后面接的这截还算不算同一个文件族：正本自己，或者 .xxx / ~xxx 的留底 */
const familyRest = (rest) => rest === "" || /^[.~]/.test(rest);
/** p 落没落在这条黑名单管的范围里 */
function hitsTarget(p, t, platform = process.platform) {
  if (t.kind === "dir") return underPrefix(p, t.path, platform);
  const win = platform === "win32";
  const P = win ? foldWin(p) : p;
  const D = (win ? foldWin(t.dir) : t.dir).replace(/[\\/]$/, "");
  const sep = win ? "/" : path.sep;
  if (!P.startsWith(D + sep)) return false;
  const first = P.slice(D.length + 1).split(sep)[0];
  const leaf = win ? t.leaf.toLowerCase() : t.leaf;
  if (!first.startsWith(leaf)) return false;
  return t.kind === "prefix" || familyRest(first.slice(leaf.length));
}
/** 同一条黑名单按真实位置再算一份（目录本身是符号链接的，比如 /tmp → /private/tmp） */
function realTarget(t) {
  if (t.kind === "dir") {
    const r = realOf(t.path);
    return r && r !== t.path ? { ...t, path: r } : null;
  }
  const d = realOf(t.dir);
  return d && d !== t.dir ? { ...t, dir: d, path: path.join(d, t.leaf) } : null;
}

/**
 * 顺着符号链接走到底的真实位置。还不存在的那几截照原样接在后面（要新建的文件也得判）；
 * 悬空的链接也要追——`notes.txt -> ~/.ssh/authorized_keys2` 这种，write_file 一写就在链接那头新建了。
 * 追不下去（链接绕成圈、没权限）返回 null。
 */
function realOf(p) {
  let cur = p, hops = 0;
  const rest = [];
  try {
    for (;;) {
      let st = null;
      try { st = fs.lstatSync(cur); } catch {}
      if (st && st.isSymbolicLink()) {
        try { return path.join(fs.realpathSync.native(cur), ...rest); } catch {}
        if (++hops > 40) return null;
        // 悬空链接：照链接里写的目标往下追，相对目标按链接所在目录的真实位置算
        cur = path.resolve(fs.realpathSync.native(path.dirname(cur)), fs.readlinkSync(cur));
        continue;
      }
      if (st) return path.join(fs.realpathSync.native(cur), ...rest);
      const up = path.dirname(cur);
      if (up === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  } catch { return null; }
}

/**
 * 硬链接：跟黑名单里的文件共用同一份数据，路径上却看不出任何关系，符号链接那套追不到它。
 * 只有链接数大于 1 的普通文件才可能是这种情况，这时拿 设备号+inode 去跟黑名单比一遍。
 * 绝大多数文件链接数是 1，不多花一次比对。
 */
function linkedFile(real) {
  try {
    const st = fs.statSync(real, { bigint: true }); // Windows 的文件号可能超过 2^53，按 bigint 比才不会撞
    return st.isFile() && st.nlink > 1n ? st : null;
  } catch { return null; }
}
const INODE_TTL_MS = 5000;
const INODE_WALK_MAX = 5000;
const inodeCache = new Map(); // 黑名单目录 -> { at, keys: Set<"dev:ino"> }
function sameInodeAsBlacklisted(st, bp) {
  let bst;
  try { bst = fs.statSync(bp, { bigint: true }); } catch { return false; }
  if (bst.isFile()) return bst.dev === st.dev && bst.ino === st.ino;
  if (!bst.isDirectory()) return false;
  return inodesUnder(bp).has(`${st.dev}:${st.ino}`);
}
/** 硬链接比对按整条黑名单算：文件族里的 .bak 和前缀命中的那几个也算，不只认正本 */
function sameInodeAsTarget(st, t) {
  if (t.kind === "dir") return sameInodeAsBlacklisted(st, t.path);
  let names;
  try { names = fs.readdirSync(t.dir); } catch { return false; }
  return names.some((n) => n.startsWith(t.leaf) && (t.kind === "prefix" || familyRest(n.slice(t.leaf.length))) &&
    sameInodeAsBlacklisted(st, path.join(t.dir, n)));
}
/**
 * 黑名单目录里所有文件的 设备号+inode。只在碰到链接数大于 1 的文件时才走一遍，
 * 走过的缓存几秒（同一轮里连读几个文件不用反复扫）；目录大到走不完就按走到的算——
 * 黑名单本来就是 ~/.ssh 这种小目录，真填了个大目录，宁可漏判也不让每次读文件都卡住。
 */
function inodesUnder(dir) {
  const now = Date.now();
  const hit = inodeCache.get(dir);
  if (hit && now - hit.at < INODE_TTL_MS) return hit.keys;
  const keys = new Set();
  let left = INODE_WALK_MAX;
  const walk = (d, depth) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (--left < 0) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 6) walk(f, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const s = fs.statSync(f, { bigint: true }); keys.add(`${s.dev}:${s.ino}`); } catch {}
    }
  };
  walk(dir, 0);
  if (inodeCache.size > 64) inodeCache.clear();
  inodeCache.set(dir, { at: now, keys });
  return keys;
}

/**
 * 按文件安全策略解析路径。workspace 内默认放行（黑名单除外）；
 * workspace 外仅白名单前缀放行 —— 这也让文件工具获得受控的越界能力。
 *
 * 光看字面路径不够：工作区里一个 `lnk -> ~/.ssh` 就能让 lnk/id_rsa 字面上在工作区里、
 * 实际读写的却是黑名单里的东西（clone 来的仓库里就可能带着）。所以黑名单、工作区、白名单
 * 都按真实位置再判一遍；工作区自己也取真实位置，不然 /tmp、/var 这种本身是链接的目录全被误拦。
 */
function resolvePathWithPolicy(sec, rel, workspaceDir, base, platform = process.platform) {
  // base：本次任务的成果子目录（默认工作空间按对话分文件夹）；越界判定仍以整个 workspace 为界
  const p = path.resolve(base || workspaceDir, String(rel || ".").replace(/\\/g, "/"));
  const real = realOf(p);
  if (!real) return { path: p, allowed: false, reason: "路径里的符号链接追不到真实位置（绕成了圈，或者没权限读）" };
  // platform 只管「怎么比」（Windows 不分大小写），测试里传 win32 在别的系统上验这条
  const under = (a, b) => underPrefix(a, b, platform);
  if (sec.gateway) {
    const st = linkedFile(real);
    for (const b of blacklistOf(sec)) {
      for (const t of blacklistTargets(b, platform)) {
        const rt = realTarget(t);
        const fileReal = t.kind === "dir" ? null : realOf(t.path); // 正本自己是个符号链接：直接读它指过去的那个文件
        if (hitsTarget(p, t, platform) || hitsTarget(real, t, platform) || (rt && hitsTarget(real, rt, platform)) ||
          (fileReal && fileReal !== t.path && under(real, fileReal)) || (st && sameInodeAsTarget(st, t))) {
          return { path: p, allowed: false, reason: `路径在文件黑名单内（${b}）` };
        }
      }
    }
  }
  const inWs = under(p, workspaceDir);
  if (inWs && under(real, realOf(workspaceDir) || workspaceDir)) return { path: p, allowed: true };
  for (const w of sec.file_whitelist || []) {
    const wp = expandPath(w, platform);
    if (under(real, realOf(wp) || wp)) return { path: p, allowed: true, outside: true };
  }
  if (inWs) return { path: p, allowed: false, reason: "路径经符号链接指到了工作区外面：workspace 外仅文件白名单目录可访问（设置 → 安全 →「沙箱安全 · 文件」）" };
  return { path: p, allowed: false, reason: "路径越界：workspace 外仅文件白名单目录可访问（设置 → 安全 →「沙箱安全 · 文件」）" };
}

// ---------- 命令安全 ----------

/** 只是包在真命令外面的东西，判断「这段到底在跑什么」时要先剥掉 */
const WRAPPERS = new Set(["nohup", "command", "builtin", "exec", "env", "time", "nice", "ionice", "xargs", "timeout", "stdbuf", "then", "else", "do", "{", "("]);
/**
 * 包装词自己带的、要吃掉下一个词当值的开关。不认得它们，`nice -n 5 rm -rf x` 剥完是「5 rm -rf x」，
 * 删除保护看见的头是个 5。不带值的开关（xargs -0、env -i）不用列，以 - 开头的一律跳过。
 * sudo / doas 故意不算包装词：询问名单里的「sudo 」要靠它开头才认得出来。
 */
const WRAP_ARGOPTS = {
  env: /^(?:-[uC]|--(?:unset|chdir))$/,
  nice: /^(?:-n|--adjustment)$/,
  ionice: /^-[cnp]$/,
  timeout: /^(?:-[sk]|--(?:signal|kill-after))$/,
  stdbuf: /^-[ioe]$/,
  exec: /^-a$/,
  time: /^-[of]$/,
  xargs: /^(?:-[IdEnLPsa]|--(?:arg-file|delimiter|eof|max-args|max-lines|max-procs|max-chars|process-slot-var))$/,
};
/** 能用 -c 塞进一整串命令的 shell */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
/** 会真的把文件弄没的命令 */
const DELETE_CMDS = new Set(["rm", "rmdir", "srm", "unlink", "shred", "del", "erase", "rd"]);
/**
 * Windows 上另外几个删东西的：PowerShell 的 Remove-Item 和它的别名 ri（rm / del / rd / rmdir / erase
 * 也是它的别名，上面那张表已经有了），清空回收站撤不回来也算。只在 Windows 上认——
 * macOS 上 ri 是 Ruby 查文档的命令，算进来天天白弹审批。
 */
const WIN_DELETE_CMDS = new Set(["remove-item", "ri", "clear-recyclebin"]);
/**
 * PowerShell 里直接调 .NET / COM 删：[IO.File]::Delete(…)、[IO.Directory]::Delete(…)、$f.Delete()、
 * 文件系统对象的 $fso.DeleteFolder(…) / DeleteFile(…)、VB 那套 FileSystem]::DeleteDirectory(…)。
 * 不加引号时括号会被当成分段符拆掉，段尾只剩 `…::Delete`，所以段尾也算。`.deleted`、`--delete` 不算
 */
const NET_DELETE_RE = /(?:\]::|\.)delete(?:file|folder|directory)?\s*(?:\(|$)/i;
/** `gci *.tmp | % Delete`：ForEach-Object 后面跟个方法名，就是对每一项调它，跟 .Delete() 一回事 */
const PS_EACH_DELETE_RE = /^(?:%|foreach-object|foreach)\s+(?:-m[a-z]*\s+)?['"]?delete(?:file|folder|directory)?['"]?(?:\s|$)/i;
/** 会在用户桌面上弹出东西的命令（macOS open、Linux xdg-open、Windows start/explorer），见 checkCommand 里那段 */
const DESKTOP_OPEN_CMDS = new Set(["open", "xdg-open", "start", "explorer"]);

// P5 软护栏：不可逆、毁数据的命令形态。任何权限档位（含全自动）都要用户点头，
// 永久放行名单也盖不住——这不是沙箱，只是把「一条命令毁掉一晚上工作」换成一次审批。
// 批过一次的（「以后别再问这类」）按 danger:key 记在本会话里，不会反复骚扰。
const DANGER_PATTERNS = [
  // > 前面不要求空白：`cat img>/dev/disk4`、`1>/dev/disk2` 跟带空格的是一回事；2>/dev/null 靠后面那串排除
  { key: "dev-write", re: />{1,2}\|?\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|zero\b|fd\/)/i, rule: "重定向直写设备文件（> /dev/…）" },
  { key: "dd-dev", re: /\bdd\b[^\n]*\bof=\/dev\//i, rule: "dd 直写设备（of=/dev/…）" },
  { key: "compose-down-v", re: /\bdocker(?:-|\s+)compose\b[^\n]*\bdown\b[^\n]*(?:\s-\w*v|\s--volumes\b)/i, rule: "compose down 带 -v 会把数据卷一起删掉" },
  // 强推不止 -f 一种写法：-uf 这种并在一起的短开关、refspec 前面加个 +（origin +main）都是强推
  { key: "git-force-push", re: /\bgit\b[^\n]*\bpush\b[^\n]*(?:\s--force\b|\s-[a-z]*f[a-z]*\b|\s['"]?\+[^\s+])/i, rule: "git 强推会改写远端历史" },
  { key: "sql-drop", re: /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i, rule: "SQL 删库/删表/清表" },
  { key: "mkfs-disk", re: /\b(?:mkfs|diskutil\s+(?:erase\w*|partitiondisk)|fdisk)\b/i, rule: "磁盘格式化/分区" },
];
const SUB_DEPTH_MAX = 4;

/**
 * 把一条命令拆成一段段真正会被执行的东西。
 *
 * 除了 `;` `&&` `||` `|` `&`，还有两件事以前是漏的，而且都能一句话废掉整个命令闸：
 *   - **换行**：agent 写的是多行脚本，`echo hi\nrm -rf ~/x` 以前算一整段，开头是 echo，删除保护看都看不见；
 *   - **`$(...)` 和反引号**：`echo $(rm -rf ~/x)` 同理，得把括号里的东西挖出来单独算一段。
 * 引号里的分隔符不算分隔符（`grep "a|b"` 不该被拆开），但双引号里的 `$()` 照样会执行，所以照挖。
 *
 * Windows 上外面那层是 cmd：反斜杠是路径分隔符不是转义（`dir C:\& rd /s /q x` 是两条），
 * 单引号也不算引号（`echo it's & rd /s /q x` 里的 rd 照跑）。cmd 只在引号外认 `^` 一个转义：
 * `echo ^" & rd x` 里 ^ 吃掉的是那个引号，后面的 & 照样分段；双引号里 ^、反引号、$( 全是普通字。
 * PowerShell 的拆法不一样，套在里面的脚本交给 psSplit。拆多了顶多多问一句，拆少了 rd 就溜过去了。
 */
function splitSegments(command, out = [], depth = 0, platform = process.platform) {
  const win = platform === "win32";
  const src = String(command || "");
  let cur = "";
  let quote = null;
  const push = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = "";
  };
  /** 吃掉一段替换（$(...) 或 `...`），把里面的内容当独立命令继续拆，返回结束位置 */
  const grab = (i, open, close) => {
    let d = 1;
    let j = i;
    let inner = "";
    for (; j < src.length && d > 0; j++) {
      const ch = src[j];
      if (ch === "\\" && !win) { inner += ch + (src[j + 1] || ""); j++; continue; }
      if (ch === open && open !== close) d++;
      else if (ch === close) { d--; if (!d) break; }
      inner += ch;
    }
    if (depth < SUB_DEPTH_MAX) splitSegments(inner, out, depth + 1, platform);
    else if (inner.trim()) out.push(inner.trim());
    return j;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && quote !== "'" && !win) { cur += c + (src[i + 1] || ""); i++; continue; }
    if (quote) {
      if (c === quote) { quote = null; cur += c; continue; }
      // cmd 的双引号里没有转义也没有替换：以前把反引号当转义、把 $( 当替换去挖，
      // `echo "a`" & rd x`、`echo "$(" & rd x` 的引号就配不上对，后面的 rd 被当成引号里的字
      if (win) { cur += c; continue; }
      if (quote === '"' && c === "$" && src[i + 1] === "(") { i = grab(i + 2, "(", ")"); continue; }
      if (quote === '"' && c === "`") { i = grab(i + 1, "`", "`"); continue; }
      cur += c;
      continue;
    }
    if (c === '"' || (c === "'" && !win)) { quote = c; cur += c; continue; }
    if (win) {
      // ^ 连同它转义的那个字一起留着（readWord 认 `r^d` 还要用），被转义的 " & | 不开引号、不分段。
      // 反引号、$( 在 cmd 里就是个字，不转义也不替换
      if (c === "^") { cur += c + (src[i + 1] || ""); i++; continue; }
    } else {
      if (c === "$" && src[i + 1] === "(") { i = grab(i + 2, "(", ")"); continue; }
      if (c === "`") { i = grab(i + 1, "`", "`"); continue; }
    }
    // 子 shell 和进程替换：( rm -x )、diff <(rm -x)
    if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")") { push(); continue; }
    cur += c;
  }
  push();
  return out;
}

/** 去掉开头的环境变量赋值：`FOO=1 rm -rf x` 里那个 rm 也得算数 */
function stripEnvAssign(seg) {
  return seg.replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}
/**
 * 从开头读一个 shell 词，引号和反斜杠按 shell 的规矩去掉。
 * `\rm`、`'rm'`、`r''m` 在 shell 眼里都是 rm——拿原样去比名单，一对引号就把删除保护绕过去了。
 *
 * win 为真时按 Windows 的规矩读：反斜杠是路径分隔符，`C:\Windows\rd` 不能被吃成 `C:Windowsrd`；
 * 转义换成 cmd 的 `^`（双引号外）和 PowerShell 的反引号——`r^d`、`R`emove-Item` 跑起来就是 rd、Remove-Item。
 * @returns {[string, string]} [去完引号的词, 后面剩下的]
 */
function readWord(s, win = false) {
  const src = String(s || "").replace(/^\s+/, "");
  let out = "";
  let quote = null;
  let i = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") { if (c === "'") quote = null; else out += c; continue; }
    if (win) {
      if (c === "`" || (c === "^" && !quote)) { out += src[i + 1] || ""; i++; continue; }
    } else if (c === "\\" && (!quote || /["\\$`\n]/.test(src[i + 1] || ""))) {
      // 引号外反斜杠吃掉下一个字符；双引号里只有 " \ $ ` 换行这几个才算转义
      if (src[i + 1] !== "\n") out += src[i + 1] || "";
      i++;
      continue;
    }
    if (quote) { if (c === quote) quote = null; else out += c; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (/\s/.test(c)) break;
    out += c;
  }
  return [out, src.slice(i)];
}
/** 跳过包装词自己的参数：`nice -n 5`、`timeout 30`、`env -u X FOO=1`、`xargs -I {}`，剩下的才是它要跑的 */
function skipWrapperArgs(tok, rest, win = false) {
  const takesValue = WRAP_ARGOPTS[tok];
  let duration = tok === "timeout"; // timeout 在命令前头还有个时长
  let s = rest;
  while (s.trim()) {
    const [w, after] = readWord(s, win);
    if (w === "--") return after;
    if (w.startsWith("-")) s = takesValue && takesValue.test(w) ? readWord(after, win)[1] : after;
    else if (tok === "env" && /^[A-Za-z_]\w*=/.test(w)) s = after;
    else if (duration && /^\d/.test(w)) { s = after; duration = false; }
    else break;
  }
  return s;
}
/**
 * cmd 里命令名碰到 / , ; = + [ ] 就断了：`rd/s/q x`、`del,x`、`del=x`、`rd=/s=/q=x` 跟 `rd /s /q x` 是一回事。
 * 只认这几个和删除命令——`bin/rm` 这种得当路径看（PowerShell、Git Bash 里它就是个程序路径）。
 */
const CMD_SLASH_HEADS = new Set(["rd", "rmdir", "del", "erase", "start", "cmd", "call", "if", "powershell", "pwsh", ...DELETE_CMDS]);
/**
 * Windows 上一个命令名的「本名」：大小写不算（DEL、Remove-Item 都行），前面的 @（cmd 不回显）、
 * 完整路径、模块限定名（Microsoft.PowerShell.Management\Remove-Item）、.exe/.cmd/.bat 后缀都去掉。
 * @returns {[string, string]} [本名, 从名字里拆出来、要还给参数的那截（`rd/s/q` 的 ` /s/q`）]
 */
function winName(word) {
  const t = String(word || "").replace(/^@+/, "").replace(/^%comspec%/i, "cmd");
  // 内部命令名碰到 . : \ 也断：`del.x`、`del:x`、`rd\x` 都是 del / rd。
  // 带路径的从每个 \ / 后面再试一次，`C:\Windows\System32\cmd.exe/c …` 是 cmd /c；
  // 带路径时名字后面只认 / 开关，`tools\del\run.exe` 跑的是 run.exe，不是 del
  const starts = [0, ...[...t.matchAll(/[\\/]/g)].map((x) => x.index + 1)];
  for (const st of starts) {
    const m = /^([a-z][a-z0-9-]*)(?:\.(?:exe|com))?([/,=;+[\].:\\][\s\S]*)?$/i.exec(t.slice(st));
    if (!m || !CMD_SLASH_HEADS.has(m[1].toLowerCase())) continue;
    if (st > 0 && m[2] && m[2][0] !== "/") continue;
    return [m[1].toLowerCase(), m[2] ? " " + m[2] : ""];
  }
  return [t.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, ""), ""];
}
/**
 * 跳过 cmd 的 if 条件，剩下的是条件成立时要跑的命令：
 * `if exist x rd /s /q x`、`if /i not "%a%"=="b" del x`、`if %n% GEQ 3 del x`、`if errorlevel 1 del x`。
 * 认不出来就原样交回去，下一轮把条件里的词当命令看——宁可多认，不能把 rd 漏掉。
 */
function skipCmdIf(rest) {
  let s = rest;
  let [w, after] = readWord(s, true);
  if (w.toLowerCase() === "/i") { s = after; [w, after] = readWord(s, true); }
  if (w.toLowerCase() === "not") { s = after; [w, after] = readWord(s, true); }
  if (/^(?:exist|errorlevel|defined|cmdextversion)$/i.test(w)) return readWord(after, true)[1];
  if (w.includes("==")) return w.endsWith("==") ? readWord(after, true)[1] : after; // "a"=="b" 或 "a"== "b"
  const [op, after2] = readWord(after, true);
  if (op === "==" || /^(?:equ|neq|lss|leq|gtr|geq)$/i.test(op)) return readWord(after2, true)[1];
  if (op.startsWith("==")) return after2; // a ==b
  return s;
}
/**
 * cmd 在命令名前面不管的东西：@（不回显）、, ; = 和空白（当分隔符吞掉）、写在前头的重定向
 * （`>nul rd /s /q x`、`2>nul del x`、`1>&2 …`）。剥掉才看得见后面那个 rd
 */
const CMD_LEAD_RE = /^(?:[@,;=\s]+|\d?[<>]{1,2}(?:&\d|\s*(?:"[^"]*"|[^\s"<>&|]+)))+/;
/** PowerShell 赋值：`$null = Remove-Item x`、`${r} = rm x`——等号右边那条照样会跑 */
const PS_ASSIGN_RE = /^\$\{?[\w:]+\}?\s*[-+*/%]?=(?!=)\s*/;
/**
 * Windows 版的 bareCommand：多认 cmd 的 if / call / @，命令名按 winName 归一。
 * 不剥 `FOO=1` 开头：cmd 没有这种写法，`rd=x git status` 在 cmd 里是 rd 删 x、git、status 三个目录，
 * 剥了就成了 git status、还能被放行名单放过去。wsl、bash -c 里那种 Linux 命令在 winNested 里剥
 */
function winBareCommand(seg) {
  let s = String(seg || "").trim().replace(CMD_LEAD_RE, "");
  for (let i = 0; i < 8; i++) {
    // PowerShell 的点号调用、& 调用后面跟个空格，跑的就是后面那条：`. Remove-Item x`。`.\build.ps1` 不动
    s = s.replace(PS_ASSIGN_RE, "").replace(/^[.&]\s+/, "").replace(CMD_LEAD_RE, "");
    const [word, after] = readWord(s, true);
    const [tok, extra] = winName(word);
    const rest = extra + after;
    if (tok === "if") { s = skipCmdIf(rest).trim(); continue; }
    if (tok === "call") { s = rest.trim(); continue; }
    if (!WRAPPERS.has(tok)) break;
    if (tok === "command" && /^\s*-[a-zA-Z]*[vV]/.test(rest)) break;
    s = skipWrapperArgs(tok, rest, true).trim();
  }
  const [word, after] = readWord(s, true);
  const [tok, extra] = winName(word);
  return tok + extra + after;
}
/** 剥到真正在跑的那条命令：包装词连同它的参数去掉、引号去掉、`/bin/rm` 还原成 `rm` */
function bareCommand(seg, platform = process.platform) {
  if (platform === "win32") return winBareCommand(seg);
  let s = stripEnvAssign(seg).trim();
  for (let i = 0; i < 8; i++) {
    const [tok, rest] = readWord(s);
    if (!WRAPPERS.has(tok)) break;
    // `command -v rm` 是在问 rm 装没装，不是跑它
    if (tok === "command" && /^\s*-[a-zA-Z]*[vV]/.test(rest)) break;
    s = skipWrapperArgs(tok, rest).trim();
  }
  const [tok, rest] = readWord(s);
  return (tok.includes("/") ? path.basename(tok) : tok) + rest;
}

/**
 * 一段命令里面套着的、同样会被执行的那串：`bash -c '…'`、`eval '…'`、`find … -exec … \;`。
 * 删除保护和名单只认每段开头那个词，不挖出来单独算，`bash -c 'rm -rf x'` 的头就只是个 bash。
 * 没有就返回空串。Windows 上的几种（cmd /c、powershell -c、start …）见 winNested。
 */
function nestedCommand(bare) {
  const [tok, rest] = readWord(bare);
  if (tok === "eval") {
    // eval 把后面所有词拼成一串再跑
    const words = [];
    for (let s = rest; s.trim(); ) { const [w, after] = readWord(s); words.push(w); s = after; }
    return words.join(" ");
  }
  if (SHELLS.has(tok)) {
    for (let s = rest; s.trim(); ) {
      const [w, after] = readWord(s);
      if (!/^[-+]/.test(w)) return ""; // bash build.sh：跑的是个脚本文件，里头看不见
      if (/^-[a-zA-Z]*c/.test(w)) return readWord(after)[0];
      // -o pipefail、-euxo pipefail、-O extglob：o 结尾的这一簇后面跟着个选项名，一起跳过
      s = /^[-+][a-zA-Z]*[oO]$|^--(?:rcfile|init-file)$/.test(w) ? readWord(after)[1] : after;
    }
    return "";
  }
  if (tok === "find") {
    // -exec 后面到 \; 或 + 为止是另一条命令，find 每找到一个就替你跑一遍
    const re = /\s-(?:exec|execdir|ok|okdir)\s+([\s\S]*?)(?=\s+(?:\\;|';'|";"|\+)(?:\s|$)|$)/g;
    return [...rest.matchAll(re)].map((m) => m[1]).join("\n");
  }
  return "";
}

/**
 * `cmd /c …` 里 cmd 真正要跑的那串。/c 前面的 /d /s /q /e:on 这些开关跳过；
 * 第一个词不是开关就是没带 /c——那是开个交互式 cmd，后面没有要跑的。
 */
function cmdInner(rest) {
  let s = String(rest || "");
  for (let i = 0; i < 16; i++) {
    // 开关之间可以不空格、可以拿 , ; = 隔：`cmd /q/c …`、`cmd,/c …`
    const m = /^[\s,;=]*(\/[^\s/,;=]*)/.exec(s);
    if (!m) return "";
    if (/^\/[ck]/i.test(m[1])) {
      const inner = (m[1].slice(2) + s.slice(m[0].length)).trim(); // `/c"rd x"` 这种粘在一起的也算
      // cmd 会剥掉第一个引号和整行最后一个引号再跑（不一定在末尾），但剥不剥跟 /s 和引号个数有关，猜不准。
      // 几种都交回去：多看一种只是可能多问一句，少看一种 rd 就溜过去了。/c 后面再跟的开关也去掉看一遍
      const last = inner.lastIndexOf('"');
      const unq = inner.startsWith('"') && last > 0 ? inner.slice(1, last) + inner.slice(last + 1) : inner;
      const noSw = inner.replace(/^(?:\/\S*\s*)+/, "");
      return [...new Set([inner, unq, noSw].filter(Boolean))].join("\n");
    }
    s = s.slice(m[0].length);
  }
  return "";
}
/** 这些 PowerShell 开关要吃掉下一个词当值（-ExecutionPolicy Bypass、-WindowStyle Hidden …），按前缀认 */
const PS_VALUE_OPT_RE = /^(?:ex|ep|w|v|psc|inp|if|o|conf|se|cu)/;
/**
 * 读 powershell / pwsh 的命令行，找出它要跑的脚本。开关名不分大小写、能缩写（-c、-com、-nop），
 * - 和 / 打头都行。-EncodedCommand（-e、-ec、-enc…）后面是 base64，看不见要跑什么，单独标出来；
 * -File 跑的是脚本文件，里头看不见，跟 `bash build.sh` 一样不挖。
 * 脚本原样交回去，不先去引号：去完再拆，`echo '"'; Remove-Item x` 的单引号没了，分号就被当成了引号里的字。
 * @returns {{ script: string, encoded: boolean }}
 */
function psInvocation(rest) {
  for (let s = String(rest || ""); s.trim(); ) {
    const [w, after] = readWord(s, true);
    const m = /^(?:--?|\/)([a-z?][\w?-]*)(:[\s\S]*)?$/i.exec(w);
    if (!m) return { script: s.trim(), encoded: false }; // 第一个不是开关的词起，整串都是要跑的命令
    const name = m[1].toLowerCase();
    const glued = m[2] !== undefined; // -ExecutionPolicy:Bypass：值粘在后面，不再吃下一个词
    if (name === "c" || name === "cwa" || (name.length >= 3 && ("command".startsWith(name) || "commandwithargs".startsWith(name)))) {
      return { script: ((glued ? m[2].slice(1) + " " : "") + after).trim(), encoded: false };
    }
    if (/^e(?!x|p)/.test(name)) return { script: "", encoded: true };
    if (name === "f" || (name.length >= 2 && "file".startsWith(name))) return { script: "", encoded: false };
    s = !glued && PS_VALUE_OPT_RE.test(name) ? readWord(after, true)[1] : after;
  }
  return { script: "", encoded: false };
}
/**
 * powershell.exe 拿到的是一个个参数，按 Windows 的老规矩去引号（只认双引号，\" 是字面的引号），
 * 再用空格拼成一串当脚本。`-c "Remove-Item x"` 真跑的是去完引号的那串。
 */
function argvJoin(s) {
  const src = String(s || "");
  const words = [];
  let cur = "";
  let q = false;
  let has = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && src[i + 1] === '"') { cur += '"'; i++; continue; }
    if (c === '"') { q = !q; has = true; continue; }
    if (!q && /\s/.test(c)) { if (cur || has) words.push(cur); cur = ""; has = false; continue; }
    cur += c;
  }
  if (cur || has) words.push(cur);
  return words.join(" ");
}
/** 从 `$(` 后面找到配对的 `)`，找不到就到串尾 */
function psClose(src, i) {
  let d = 1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "`") { j++; continue; }
    if (src[j] === "(") d++;
    else if (src[j] === ")" && !--d) return j;
  }
  return src.length;
}
/**
 * 按 PowerShell 自己的规矩拆脚本：单引号里什么都是字（'' 是一个单引号），双引号里反引号转义、
 * `$(…)` 照样会执行，要挖出来；引号外反引号转义，`; | & 换行` 分段，脚本块的花括号也当分段（${变量名} 不动）。
 * 拆两遍：一遍连圆括号也当分段（`if (Test-Path x) { … }`、`(Remove-Item x)`），一遍不拆圆括号、
 * 留着整句给 Start-Process 读 `-ArgumentList @('/c','rd x')`。多出来的段顶多多看一眼。
 */
function psSplit(script, out = [], depth = 0) {
  const src = String(script || "");
  for (const parens of [false, true]) {
    let cur = "";
    let quote = null;
    const push = () => {
      const s = cur.trim();
      if (s && !out.includes(s)) out.push(s);
      cur = "";
    };
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quote === "'") { cur += c; if (c === "'") quote = null; continue; } // '' 是关了马上又开，效果一样
      if (c === "`") { cur += c + (src[i + 1] || ""); i++; continue; }
      if (quote === '"') {
        if (c === "$" && src[i + 1] === "(") {
          const j = psClose(src, i + 2);
          if (depth < SUB_DEPTH_MAX) psSplit(src.slice(i + 2, j), out, depth + 1);
          cur += src.slice(i, j + 1);
          i = j;
          continue;
        }
        cur += c;
        if (c === '"') quote = null;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; cur += c; continue; }
      if (c === "$" && src[i + 1] === "{") {
        const j = src.indexOf("}", i);
        if (j > 0) { cur += src.slice(i, j + 1); i = j; continue; }
      }
      if (";|&\n\r{}".includes(c) || (parens && (c === "(" || c === ")"))) { push(); continue; }
      cur += c;
    }
    push();
  }
  return out;
}
/** 交给 PowerShell 跑的一串：原样拆一遍，按参数去完引号再拆一遍，两份都算 */
function psScript(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const out = psSplit(t);
  const j = argvJoin(t);
  if (j !== t) psSplit(j, out);
  return out;
}
/** 读一个参数值，`'-c', 'x'` 这种逗号隔开的数组连着读完 */
function readPsList(s) {
  let [w, after] = readWord(s, true);
  for (let i = 0; i < 32 && w.endsWith(",") && after.trim(); i++) {
    const [w2, a2] = readWord(after, true);
    w += w2;
    after = a2;
  }
  return [w, after];
}
/**
 * Start-Process（别名 saps、start）要起的那条：-FilePath（或第一个不带名字的参数）+ -ArgumentList
 * （或第二个），参数名能缩写、值能是逗号数组和 @(…)。`Start-Process cmd -ArgumentList '/c rd /s /q x'`
 * 跑的是 `cmd /c rd /s /q x`。参数值是变量的看不见，那种只能靠外面那层。
 */
function startProcessInner(rest) {
  let file = "";
  const args = [];
  const pos = [];
  for (let s = String(rest || ""); s.trim(); ) {
    const [w, after] = readWord(s, true);
    const m = /^-([a-z]+)(?::([\s\S]*))?$/i.exec(w);
    if (!m) { const [v, a] = readPsList(s); pos.push(v); s = a; continue; }
    const n = m[1].toLowerCase();
    const isFile = /^(?:f|path|psp)/.test(n);
    const isArgs = /^a/.test(n);
    // 其余带值的：-Verb、-WorkingDirectory、-WindowStyle、-Credential、-RedirectStandard*、-Environment
    if (!isFile && !isArgs && !/^(?:verb|wo|wi|cr|re|env)/.test(n)) { s = after; continue; }
    let v = m[2];
    let a = after;
    if (v === undefined) [v, a] = readPsList(after);
    if (isFile) file = v;
    else if (isArgs) args.push(v);
    s = a;
  }
  if (!file) file = pos.shift() || "";
  if (!args.length && pos.length) args.push(pos.shift());
  if (!file) return "";
  const list = args.map((a) => a.replace(/^@\(|\)$/g, "").replace(/,/g, " ")).join(" ");
  return `${/\s/.test(file) ? `"${file}"` : file} ${list}`.trim();
}
/**
 * cmd 的 `start ["标题"] [开关] 命令`：第一个带引号的是窗口标题，/b /min /wait /high 这些开关跳过，
 * /d 目录、/node 编号、/affinity 掩码各吃一个值。`start "" cmd /c rd /s /q x` 跑的是 cmd /c 那条
 */
function cmdStartInner(rest) {
  let s = String(rest || "").trim();
  if (s.startsWith('"')) s = readWord(s, true)[1];
  for (let i = 0; i < 32; i++) {
    const [w, after] = readWord(s, true);
    if (!/^\/./.test(w)) break;
    s = /^\/(?:d|node|affinity)$/i.test(w) ? readWord(after, true)[1] : after;
  }
  return s.trim();
}
/** forfiles 的 /c "cmd /c del @path"：每找到一个文件跑一遍 */
function forfilesInner(rest) {
  for (let s = String(rest || ""); s.trim(); ) {
    const [w, after] = readWord(s, true);
    if (/^[/-]c$/i.test(w)) return readWord(after, true)[0];
    if (/^[/-]c./i.test(w)) return w.slice(2); // `/c"cmd /c del @path"`：引号贴着 /c
    s = after;
  }
  return "";
}
/** `wsl [-d 发行版] [-u 用户] [--cd 目录] [--exec|--] 命令`：后面那条在 Linux 里跑 */
function wslInner(rest) {
  for (let s = String(rest || ""); s.trim(); ) {
    const [w, after] = readWord(s, true);
    if (w === "--" || w === "-e" || w === "--exec") return after.trim();
    if (/^(?:-d|--distribution|-u|--user|--cd|--shell-type)$/.test(w)) { s = readWord(after, true)[1]; continue; }
    if (w.startsWith("-") || w === "~") { s = after; continue; }
    return s.trim();
  }
  return "";
}
/**
 * Windows 上一段里套着的命令，拆好了交回去：cmd /c、powershell -c、iex、start / Start-Process、
 * forfiles /c、wsl，还有 Git Bash 里的 bash -c、eval、find -exec。没有就是空数组。
 * Linux 那几种按 Linux 的规矩拆，开头的 `FOO=1` 也在这儿剥。
 */
function winNested(bare) {
  const [word, after] = readWord(bare, true);
  const [tok, extra] = winName(word);
  const rest = extra + after;
  const cmdSegs = (s) => (s ? splitSegments(s, [], 0, "win32") : []);
  const unixSegs = (s) => (s ? splitSegments(s, [], 0, "linux").map(stripEnvAssign) : []);
  if (tok === "cmd" || tok === "%comspec%") return cmdSegs(cmdInner(rest));
  if (tok === "powershell" || tok === "pwsh") return psScript(psInvocation(rest).script);
  if (tok === "iex" || tok === "invoke-expression") return psScript(rest);
  if (tok === "start-process" || tok === "saps") return cmdSegs(startProcessInner(rest));
  // start 在 cmd 里是 start 命令，在 PowerShell 里是 Start-Process 的别名，两种读法都算
  if (tok === "start") return [...cmdSegs(cmdStartInner(rest)), ...cmdSegs(startProcessInner(rest))];
  if (tok === "forfiles") return cmdSegs(forfilesInner(rest));
  if (tok === "wsl") return unixSegs(wslInner(rest));
  return unixSegs(nestedCommand(bare));
}
/** Windows 上这一段是不是在删东西：rd / del / Remove-Item 这些，[IO.File]::Delete(…)，`| % Delete` */
function winDeleteSeg(seg) {
  const bare = winBareCommand(seg);
  const tok = bare.split(/\s+/)[0] || "";
  return DELETE_CMDS.has(tok) || WIN_DELETE_CMDS.has(tok) || NET_DELETE_RE.test(seg) || PS_EACH_DELETE_RE.test(bare);
}
/**
 * Windows 兜底：不管引号，整条命令按 ; & | 换行硬切，每块再照常拆一遍，看有没有在删东西的。
 * cmd 的 ^、PowerShell 的 '' 和反引号，引号到底配没配上对，拆的人跟真跑的那个只要认得不一样，
 * rd 就能藏进「引号里」。这条只会把「直接跑」抬成「问一句」。代价是 `echo "a & rd /s /q x"`
 * 这种把删除命令写在字符串里的也会问——认了，比漏掉强。
 */
function winLooseDelete(sec, command) {
  // 再看几种读法：^ 全去掉（`r^\nd` 续行、`cmd /c^ rd`）；引号也去掉（`"&" rd` 这种配对猜不准的）；
  // 最后一种按 cmd 的眼光：; , = 只是空白（`cmd;/c rd x`），`1>&2` 是重定向不是 &
  const raw = String(command || "");
  const noCaret = raw.replace(/\^\r?\n/g, "").replace(/\^/g, "");
  const noQuote = noCaret.replace(/"/g, " ");
  const asCmd = noQuote.replace(/([<>])&(\d)/g, "$1$2").replace(/[;,=]/g, " ");
  const pieces = [...new Set([raw, noCaret, noQuote].flatMap((x) => x.split(/[;&|\n\r]/)).concat(asCmd.split(/[&|\n\r]/)))];
  for (const piece of pieces) {
    if (!piece.trim()) continue;
    for (const s of commandSegments(piece, "win32")) {
      if (winDeleteSeg(s) && !listedCommand(sec, s, "win32")) return s;
    }
  }
  return "";
}

/** 一条命令最多拆出这么多段；套得再深的看不全，按看不全处理（见 checkCommand） */
const SEGS_MAX = 256;
/**
 * 拆段，再把每段里套着的命令也挖出来各算一段（挖出来的里面还套着，接着挖）。
 * 段数到顶还有没挖的，就在返回的数组上标 truncated——以前到顶就悄悄不挖了，
 * 前面垫 64 个 `true;`，后面的 `bash -c 'rm -rf x'` 只剩个 bash 头。
 * @returns {string[] & { truncated?: boolean }}
 */
function commandSegments(command, platform = process.platform) {
  const win = platform === "win32";
  /** @type {string[] & { truncated?: boolean }} */
  const segs = splitSegments(command, [], 0, platform);
  for (let k = 0; k < segs.length; k++) {
    const bare = bareCommand(segs[k], platform);
    const inner = win ? winNested(bare) : splitSegments(nestedCommand(bare), [], 0, platform);
    if (!inner.length) continue;
    if (segs.length + inner.length > SEGS_MAX) { segs.truncated = true; break; }
    segs.push(...inner);
  }
  return segs;
}

/** Windows 上家目录在命令行里的几种写法（都按 foldWin 折过：小写、正斜杠） */
const HOME_VARS = ["%userprofile%", "$env:userprofile", "${env:userprofile}", "$home", "~", "%homepath%"];
/** 一条黑名单路径在命令行里可能长什么样 */
function pathNeedles(entry, platform = process.platform) {
  // 带 * 的、结尾带 / 的按去掉之后的样子认；后面跟什么才算命中由 needleIn 按条目种类管
  const raw = String(entry).trim().replace(/\*+$/, "").replace(/(.)[\\/]+$/, "$1");
  if (!raw) return [];
  if (platform === "win32") return winPathNeedles(raw);
  const out = [raw.toLowerCase(), expandPath(raw).toLowerCase()];
  const tail = raw.replace(/^~|^<app>/, "");
  // `~/.ssh` 写成 `$HOME/.ssh` 也要认出来；但 `/config.json` 这种太泛的尾巴不认，免得天天弹审批
  const parts = tail.split("/").filter(Boolean);
  if (tail.startsWith("/") && (parts.length > 1 || (parts[0] || "").startsWith("."))) out.push(tail.toLowerCase());
  return out;
}
/**
 * 针后面紧跟的那个字决定算不算命中：目录后面得是分隔符、引号、空白或结尾（`/data/usage-2024.csv` 不是账本目录）；
 * 文件还认 .bak、~ 这类留底后缀；前缀条目（audit*）后面跟什么都算。
 */
function needleIn(text, n, kind) {
  if (!n) return false;
  const stop = kind === "prefix" ? null : kind === "file" ? /[A-Za-z0-9_\-]/ : /[A-Za-z0-9_\-.~]/;
  for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) {
    const c = text[i + n.length];
    if (!stop || c === undefined || !stop.test(c)) return true;
  }
  return false;
}
/** 一条黑名单拿去在命令、代码原文里找的针，连同它是哪一种（见 blacklistTargets） */
function needlesOf(entry, platform) {
  const raw = String(entry).trim();
  const t = blacklistTargets(entry, platform)[0];
  const kind = t ? t.kind : "dir";
  const all = pathNeedles(entry, platform);
  if (kind !== "prefix") return { raw, kind, needles: all };
  // 前缀条目后面跟什么都算，所以 `/data/audit` 这种短尾巴不拿去找：不然用户自己项目里的 data/audit_2024.csv 也会被拦
  const fold = platform === "win32" ? foldWin : (/** @type {string} */ x) => x.toLowerCase();
  const tail = fold(raw.replace(/\*+$/, "").replace(/^~|^<app>/, ""));
  return { raw, kind, needles: all.filter((n) => n !== tail) };
}
/**
 * Windows 版：黑名单写的是 `~/.ssh`，命令行里却可能是 `type %USERPROFILE%\.ssh\id_rsa`、
 * `Get-Content $env:USERPROFILE\.SSH\id_rsa`、`C:\Users\Me\.ssh`——大小写、正反斜杠、家目录变量都得认。
 * 返回的都按 foldWin 折过，拿去跟同样折过的命令比。
 */
function winPathNeedles(raw) {
  const exp = foldWin(expandPath(raw, "win32"));
  const out = [foldWin(raw), exp];
  const tail = foldWin(raw.replace(/^~|^<app>/, ""));
  // 尾巴太泛的照样不认（同上）
  const parts = tail.split("/").filter(Boolean);
  if (tail.startsWith("/") && (parts.length > 1 || (parts[0] || "").startsWith("."))) out.push(tail);
  // 落在家目录下的（`~/x`、`<app>/config.json` 都是），换成家目录变量的几种写法各来一份
  const home = foldWin(os.homedir()).replace(/\/$/, "");
  if (exp.startsWith(home + "/")) for (const v of HOME_VARS) out.push(v + exp.slice(home.length));
  return [...new Set(out)];
}

/**
 * 「本会话一直允许」记在这儿。
 *
 * 治的是最招人烦的那件事：同一条 `git status` 连着问你八遍。批一次就把这条规则记下来，
 * 这次进程活着的期间不再问。**只在内存里**——重启就没了，不会悄悄在配置里长出一条你早忘了的放行规则。
 * 要永久放行是另一个按钮（写进 cmd_allow，看得见、删得掉）。
 */
const sessionAllow = new Set();
function addSessionAllow(rule) {
  const r = String(rule || "").trim();
  if (r) sessionAllow.add(r);
  return [...sessionAllow];
}
function listSessionAllow() {
  return [...sessionAllow];
}
function clearSessionAllow() {
  sessionAllow.clear();
}

/**
 * 多子命令的工具，规则粒度取到第二个词：放行 `git status` 不等于放行 `git push --force`。
 * ffmpeg 不在这儿：它没有子命令，第二个词永远是 -i 这种开关，按整个工具记。
 */
const SUBCMD_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "npx", "docker", "kubectl", "pm2", "brew", "cargo", "go", "pip", "pip3", "python", "python3", "node", "gh", "systemctl"]);
/**
 * 子命令前面能插的全局开关里，要吃掉下一个词当值的那几个。不跳过它们，`git -C repo status`
 * 的第二个词是 -C，规则就退成了整个 git——批一次看状态，`git reset --hard` 跟着一起放行。
 * 不带值的（--no-pager、-P）和 `--opt=值` 这种写法不用列，以 - 开头的一律跳过。
 */
const GLOBAL_VALUE_OPTS = {
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
  npm: ["--prefix", "-w", "--workspace"],
  pnpm: ["-C", "--dir", "--filter", "-F"],
  yarn: ["--cwd"],
  npx: ["-p", "--package"],
  docker: ["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"],
  kubectl: ["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server"],
  cargo: ["-C", "-Z", "--config"],
  go: ["-C"],
  systemctl: ["-H", "--host", "-M", "--machine"],
  node: ["-r", "--require", "--import", "--loader"],
  python: ["-W", "-X"],
  python3: ["-W", "-X"],
};
/** 这些开关后面跟的是一段代码：`node -e`、`python -c` 批一次「这类都允许」等于批了任意代码，不给规则 */
const CODE_OPTS = {
  node: /^-[a-z]*[ep]|^--(?:eval|print)\b/,
  python: /^-[a-zA-Z]*c/,
  python3: /^-[a-zA-Z]*c/,
  npx: /^(?:-c|--call)\b/,
};

/**
 * 从一段命令里推出一条「以后遇到这类就别问了」的规则。
 * 粒度太粗会把危险的一起放过去（放行 `git` 等于放行 `git push -f`），
 * 太细又等于没记（带具体文件名的规则下次必然不命中）。取「命令 + 子命令」是这两者之间。
 * 推不出一条稳妥的就返回空串：只放这一次，下回照样问。
 */
function ruleFor(text, platform = process.platform) {
  const seg = splitSegments(String(text || ""), [], 0, platform)[0] || String(text || "");
  const bare = bareCommand(seg, platform).trim();
  const parts = bare.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const tool = parts[0];
  // `. venv/bin/activate` 记成「.」，批一次以后 `./deploy.sh` 也算同类；
  // 包装词只有 `command -v` 会剩下来，记成 command 等于把 `command rm -rf` 一起放了
  if (tool === "source" || tool.startsWith(".") || WRAPPERS.has(tool)) return "";
  if (!SUBCMD_TOOLS.has(tool)) return tool;
  const valued = GLOBAL_VALUE_OPTS[tool] || [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (CODE_OPTS[tool] && CODE_OPTS[tool].test(p)) return "";
    // python -m pytest：-m 后面那个模块名就是它的子命令
    if (p === "-m" && /^python3?$/.test(tool)) return parts[i + 1] ? `${tool} -m ${parts[i + 1]}` : "";
    if (valued.includes(p)) { i++; continue; }
    if (p.startsWith("-")) continue;
    // node <<EOF、python3 < x.py：喂进去的是代码，不是子命令
    return /^[<>]/.test(p) ? "" : `${tool} ${p}`;
  }
  return ""; // 只有开关没有子命令（git --version、node --test）
}

/**
 * 命令行 --allow 写的一条 → 放进本会话放行名单的那个键。
 *
 * 记下的跟审批卡上「本会话同类不再问」是同一种东西，只是开跑前就说好：cron、CI 里没人点头，
 * 又确实要它跑 npm test 的，一类一类点名放行，而不是整个 --perm full 敞开。
 *   npm test / git status   命令前缀，跟 cmd_allow 一个比法（整词：放行 rm 不等于放行 rmdir）
 *   write                   「每步都问」那档下写文件不问
 *   code / code:child_process   跑代码不问 / 只放「代码里开子进程」那一类
 *   danger:<类别>           某一类高危命令（git-force-push 这种）
 * 认不出来的一律报错：写错一个字等于没放行，跑到半夜被拒才发现，不如开跑前就停下。
 * @returns {{ key: string, label: string } | { error: string }}
 */
function parseAllowRule(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t) return { error: "--allow 后面是空的" };
  if (t === "write" || t === "write:*") return { key: "write:*", label: "写文件" };
  if (t === "code" || t === "code:*") return { key: "code:*", label: "跑代码" };
  if (t === "code:child_process") return { key: t, label: "代码里开子进程" };
  const m = /^danger:(.*)$/.exec(t);
  if (m) {
    const d = DANGER_PATTERNS.find((x) => x.key === m[1].trim());
    return d ? { key: "danger:" + d.key, label: d.rule }
      : { error: `没有叫「${m[1]}」的高危类别，有这些：${DANGER_PATTERNS.map((x) => x.key).join(" / ")}` };
  }
  if (/^(write|code):/.test(t)) return { error: `认不出「${t}」：写文件写 write，跑代码写 code 或 code:child_process` };
  // 名单是一段一段比的：带 ; & | 换行的规则永远比不中，等于没写
  if (/[;&|\n]/.test(t)) return { error: `「${t}」里有 ; & | 这种连接符。规则按单条命令比，拆开写成几个 --allow` };
  return { key: t, label: t };
}

/** 审批卡上记的那个键，换回 --allow 该怎么写（给「下回怎么不用批」那句提示用）。记不住的返回空串 */
function allowFlagFor(ruleKey) {
  const k = String(ruleKey || "");
  if (!k) return "";
  if (k === "write:*" || k === "code:*") return k.slice(0, -2);
  return k;
}

/**
 * 同上，再套好 shell 引号，能原样粘进命令行。
 * 一律套双引号不行：`$EDITOR foo.txt` 记下的键是 `$EDITOR`，`--allow "$EDITOR"` 会被 shell 展开成 vim，放行的就不是这一类了
 */
function allowFlagArg(ruleKey) {
  const f = allowFlagFor(ruleKey);
  if (!f) return "";
  return /^[\w.\/:@%+=, -]+$/.test(f) ? `"${f}"` : `'${f.replace(/'/g, "'\\''")}'`;
}

/**
 * 名单里有没有一条是这段的前缀。以字母数字结尾的那条按整词比：批过 `git` 不等于批了 `gitk`，
 * 批过 `rm` 不等于批了 `rmdir`。以 / 这类符号结尾的（`./scripts/`）本来就是写成前缀的，照旧。
 */
function matchesPrefix(list, seg, env, bare) {
  return (list || []).some((p) => {
    const q = String(p || "").trim();
    if (!q) return false;
    const whole = /\w$/.test(q);
    return [seg, env, bare].some((s) => s.startsWith(q) && (!whole || s.length === q.length || /\s/.test(s[q.length])));
  });
}

/** 这一段人已经点过头没有：永久放行名单（cmd_allow）或者本会话「这类都允许」。判险那道闸也靠它跳过批过的段 */
function listedCommand(sec, seg, platform = process.platform) {
  const s = String(seg || "");
  const env = platform === "win32" ? s : stripEnvAssign(s); // cmd 没有 `FOO=1 命令`，见 winBareCommand
  const bare = bareCommand(s, platform);
  return matchesPrefix((sec || {}).cmd_allow, s, env, bare) || matchesPrefix([...sessionAllow], s, env, bare);
}

/**
 * 写文件闸。按权限模式决定：只看不动 → 拒；每步都问 → 问；自动/全自动 → 直接写。
 * 路径本身合不合法（越界、黑名单）是另一条线，在 resolvePathWithPolicy 里管，两者都要过。
 */
function checkWrite(sec, relPath) {
  const mode = permissionMode(sec);
  const m = PERMISSION_MODES[mode];
  if (m.write === "deny") return { action: "deny", rule: `当前权限档位是「${m.label}」，不写文件`, seg: String(relPath || "") };
  if (m.write === "ask") {
    const rule = `写文件 ${String(relPath || "")}`;
    if (sessionAllow.has("write:*")) return { action: "allow" };
    return { action: "ask", rule, seg: String(relPath || ""), ruleKey: "write:*" };
  }
  return { action: "allow" };
}

/**
 * 命令闸。返回 allow / ask / deny（附命中的规则）。
 * 顺序是有讲究的：文件黑名单排在放行名单前面——黑名单是「永远拦」，
 * 不能因为用户放行了 `cat ` 就把 `cat ~/.ssh/id_rsa` 一起放过去。
 * 权限档位排在黑名单之后、名单之前：全自动也不放开黑名单，只看不动则一条都不放。
 */
function checkCommand(sec, command, platform = process.platform) {
  const win = platform === "win32";
  // `bash -c '…'`、`find -exec …` 里套着的那条也各算一段，外面那层批过了不代替里面那条
  const segs = commandSegments(command, platform);
  const mode = permissionMode(sec);
  const needles = sec.gateway ? blacklistOf(sec).map((b) => needlesOf(b, platform)) : [];
  for (const seg of segs) {
    // Windows 上路径不分大小写、正反斜杠混着写，命令也得跟黑名单折成同一个样子再比
    const low = win ? foldWin(seg) : seg.toLowerCase();
    for (const b of needles) {
      if (b.needles.some((n) => needleIn(low, n, b.kind))) {
        // 有 shell 在手，文件黑名单本来是形同虚设的（read_file 拦得住，`cat` 拦不住）
        return blacklistVerdict(`命令碰到了文件黑名单（${b.raw}）`, seg);
      }
    }
    // cmd 没有 `FOO=1 命令` 这种写法：`rd=x git status` 剥成 git status，放行名单里有 git 就把 rd 放过去了
    const env = win ? seg : stripEnvAssign(seg);
    const bare = bareCommand(seg, platform);
    const tok = bare.split(/\s+/)[0] || "";
    // powershell -EncodedCommand 后面是一串 base64，要跑什么根本看不见，删没删东西更无从判断
    const psEncoded = win && (tok === "powershell" || tok === "pwsh") && psInvocation(readWord(bare, true)[1]).encoded;
    if (mode === "plan") return { action: "deny", rule: `当前权限档位是「${PERMISSION_MODES.plan.label}」，不跑命令`, seg };
    if (sec.gateway) {
      // 高危表在放行名单之前查：cmd_allow 是给日常命令省事的，不该顺手把毁数据的形态一起放过去
      const danger = DANGER_PATTERNS.find((d) => d.re.test(seg) && !sessionAllow.has("danger:" + d.key));
      if (danger) return { action: "ask", rule: `高危命令：${danger.rule}`, seg, ruleKey: "danger:" + danger.key };
      // 跟高危表一样排在名单前、全自动也问；不给「同类不再问」——批一次等于以后任何编码命令都放行
      if (psEncoded) return { action: "ask", rule: "PowerShell 编码命令看不到内容，需审批", seg, ruleKey: "" };
    }
    if (matchesPrefix(sec.cmd_allow, seg, env, bare)) continue; // 永久放行名单
    if (matchesPrefix([...sessionAllow], seg, env, bare)) continue; // 本会话已经批过同类
    // 运行时开关是用户明确关掉的东西，不受权限档位影响：全自动也不代表把关掉的运行时打开。
    // Windows 上还有个 py（Python 启动器），python.exe 这种 winName 已经去过后缀
    if (!sec.runtime_python && (win ? /^(python3?|pip3?|py)$/ : /^(python3?|pip3?)$/).test(tok)) {
      return { action: "deny", rule: "内置运行时 Python 已停用", seg };
    }
    if (mode === "full") continue; // 全自动：名单之外的也不问了
    if (mode === "ask") return { action: "ask", rule: `每步都问模式`, seg, ruleKey: ruleFor(seg, platform) };
    const hitAsk = (sec.cmd_ask || []).find((p) => p && (seg.startsWith(p.trim()) || env.startsWith(p.trim()) || bare.startsWith(p.trim())));
    if (hitAsk) return { action: "ask", rule: `命令询问名单「${hitAsk.trim()}」`, seg, ruleKey: ruleFor(seg, platform) };
    // 弹到用户桌面的命令：open / xdg-open / start 会在用户眼前弹出窗口或浏览器标签。
    // 它不毁数据，所以四张名单一张都不管它——而它恰恰是最招人烦的那类：任务收尾「顺手」把
    // 推文、封面、HTML 各开一个，用户桌面被刷一排窗口。真踩过，而且长期记忆里明明写着「别开」，
    // 记忆超预算按相关度一挑就把这条规矩挑掉了。提示词和记忆都是建议，这儿才是闸：
    // 用户没点头就不开，他要真想看，批一次「本会话一直允许」就够了；永久放行写 cmd_allow
    if (DESKTOP_OPEN_CMDS.has(tok)) {
      return { action: "ask", rule: "要在你桌面上打开文件或网页（用户没要求就别替他开，交付只报路径）", seg, ruleKey: ruleFor(seg, platform) };
    }
    if (sec.delete_protect) {
      const findDeletes = tok === "find" && /(\s-delete\b|-(?:exec|ok)(?:dir)?\s+(\S*\/)?(?:rm|rmdir|unlink|shred|srm)\b)/.test(bare);
      // Windows：Remove-Item / ri、[IO.File]::Delete(…)、`| % Delete`；编码命令看不见内容，总开关关着也按删除算
      const winDeletes = win && (winDeleteSeg(seg) || psEncoded);
      if (DELETE_CMDS.has(tok) || findDeletes || winDeletes) {
        return { action: "ask", rule: "删除保护（rm 类命令需审批）", seg, ruleKey: psEncoded ? "" : ruleFor(seg, platform) };
      }
    }
  }
  // 下面两条只在「自动改文件」这档补：全自动本来就不管删除，每步都问、只看不动上面已经拦了
  if (mode === "auto" && sec.delete_protect) {
    // 套得太深、段数到顶没挖完的：没看见的那截里删没删东西判断不了
    if (segs.truncated) return { action: "ask", rule: "命令太长，没拆完，需审批", seg: String(command || ""), ruleKey: "" };
    const loose = win ? winLooseDelete(sec, command) : "";
    if (loose) return { action: "ask", rule: "删除保护（rm 类命令需审批）", seg: loose, ruleKey: ruleFor(loose, platform) };
  }
  return { action: "allow" };
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 相邻两个字符串字面量中间的 `+` 去掉："conf"+"ig.json" 按 "config.json" 看 */
function joinLiterals(s) {
  return String(s).replace(/(["'`])\s*\+\s*(["'`])/g, "");
}
/** 往上一级目录走、或者从脚本自己的位置往上推的写法 */
const UPWARD_HINTS = [/(?:^|[^.])\.\.(?:[/"'`]|$)/, /\bdirname\s*\(\s*(?:process\.cwd|__dirname|__filename|process\.env|require\.)/, /\bchdir\b/];
/** 能落到数据根上的线索（环境变量、应用自己 paths 模块里的名字、数据根的目录名） */
function dataRootHints() {
  const out = [/openworkbuddy/, /node_path/, /\bdatapath\b|\bdata_dir\b|\bapp_dir\b|\bapppath\b/, ...UPWARD_HINTS];
  const base = path.basename(DATA_DIR).toLowerCase();
  if (base.length >= 5) out.push(new RegExp(escRe(base)));
  return out;
}
const HOME_HINTS = [/homedir/, /\benv\s*(?:\.\s*home\b|\[\s*["'`]home["'`])/, /\$home\b|%userprofile%|userprofile/, /["'`]~\//, /\/(?:users|home)\//, ...UPWARD_HINTS];
/**
 * 代码里没写出完整路径、却在拼一个指向黑名单的路径：黑名单那项的文件名（或目录名）作为一截路径出现，
 * 同时又有能定位到它所在位置（数据根 / 家目录）的线索。光有文件名不算——工作区里自己的
 * config.json 是用户的东西，不能一碰就弹卡。认不全，只是纵深；根治靠系统沙箱。
 */
function pointsAtBlacklisted(raw, joined, platform) {
  if (!raw) return false;
  const exp = expandPath(raw, platform);
  const isData = underPrefix(exp, DATA_DIR, platform);
  const isHome = !isData && underPrefix(exp, os.homedir(), platform);
  if (!isData && !isHome) return false; // 别处的绝对路径只认字面量
  const leaf = String(raw).replace(/[\\/]+$/, "").split(/[\\/]/).pop().toLowerCase();
  const stem = leaf.replace(/\*+$/, "");
  if (stem.length < 4) return false;
  // 得是一截路径：前面贴着 / 或引号，后面是 /、引号或备份后缀（.bak、~）；带 * 的按前缀认。
  // 只认 /：Windows 上传进来的已经按 foldWin 把反斜杠折成了 /，别的系统上反斜杠本来就不是分隔符
  const tail = leaf.endsWith("*") ? "" : "(?=[/\"'`.~]|$)";
  const re = new RegExp(`(?<=[/"'\`])${escRe(stem)}${tail}`);
  const text = dropWorkspacePaths(joined); // 工作区里同名的文件是用户自己的
  if (!re.test(text)) return false;
  return (isData ? dataRootHints() : HOME_HINTS).some((h) => h.test(text));
}
/** 能找到应用自己代码在哪儿的线索 */
function appRootLocators() {
  const out = [/node_path/, /openworkbuddy_home|openworkbuddy\.app/, /require\s*\.\s*resolve|resolve\s*\.\s*paths|module\s*\.\s*paths/, /node_modules/, /execpath|resourcespath|\.asar\b/, ...UPWARD_HINTS];
  const lit = foldWin(APP_DIR).replace(/\/$/, "");
  if (lit.length > 1) out.push(new RegExp(escRe(lit) + "(?:[\\/\\\\\"'`]|$)"));
  return out;
}
/** 默认工作区里的绝对路径去掉再看：那底下同名的文件是用户自己的，开发态下它又正好在应用目录底下 */
function dropWorkspacePaths(joined) {
  const ws = escRe(foldWin(path.join(DATA_DIR, "workspace")));
  return joined.replace(new RegExp(ws + "(?:[\\/\\\\](?:(?!\\.\\.)[^\"'`\\s])*)?", "g"), "");
}
/** 应用里能改账号、组织、额度、数据根位置的那些模块 */
const APP_MODULE_RE = /(?:^|["'`\/\\])(?:src[\/\\](?:domains|core|platform|agent|engines|tools|server|cli|im|desktop|util)(?=[\/\\"'`])|(?:accounts?|orgs?|admin|vkeys|budget|quota|pricing|usage-store|paths|security|tenant|cli|server|tool-bridge)(?:\.c?js)?(?=["'`]|$))/;
/** 命令行入口：起一个子进程跑它，跟 require 进来一样能改账号和额度 */
const APP_CLI_RE = /(?:^|["'`\/\\\s])(?:cli|tool-bridge)\.js(?=["'`\s]|$)|src[\/\\](?:cli|engines)[\/\\]/;
const LOAD_CALL_RE = /\b(require|import|createrequire|_load|fork|spawn|spawnsync|exec|execsync|execfile|execfilesync)\s*\(/g;
/** 从左括号往后取到配对的右括号（最多看 300 个字） */
function callArg(s, open) {
  let depth = 0;
  for (let i = open; i < s.length && i < open + 300; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i);
  }
  return s.slice(open + 1, open + 300);
}
/**
 * 代码要直接加载应用自己的模块：那等于不经过任何闸调「改组织预算」「给谁签登录令牌」这类函数，
 * 代码里一个黑名单文件名都不会出现。认法是「找得到应用代码在哪」+「加载的是应用模块、
 * 加载路径是算出来的、或者起子进程跑应用的命令行入口」同时出现。
 * 返回命中的那一小段（给审批卡看），没命中返回 ""。
 */
function loadsAppModule(joined) {
  const loc = appRootLocators().map((r) => r.exec(dropWorkspacePaths(joined))).find(Boolean);
  if (!loc) return "";
  LOAD_CALL_RE.lastIndex = 0;
  for (let m; (m = LOAD_CALL_RE.exec(joined)); ) {
    const fn = m[1];
    const arg = callArg(joined, m.index + m[0].length - 1);
    if (fn === "require" || fn === "import") {
      const literal = /^\s*(["'`])[^"'`$]*\1\s*(?:,[^()]*)?$/.test(arg);
      if (!literal || APP_MODULE_RE.test(arg)) return loc[0].trim().slice(0, 80);
    } else if (fn === "createrequire" || fn === "_load") {
      return loc[0].trim().slice(0, 80);
    } else if (APP_CLI_RE.test(arg)) {
      return loc[0].trim().slice(0, 80);
    }
  }
  return "";
}

/**
 * 代码闸（run_node / 未来的其它运行时）。
 *
 * 命令闸拦得再严，一句 `require("child_process").execSync("rm -rf ~")` 就全绕过去了——
 * 代码是从同一个 agent 嘴里出来的，不能只看 run_shell 那扇门。
 * 这里不做沙箱（做不到），只做一件事：**代码要开子进程、伸手去碰文件黑名单、或者直接加载应用自己的模块，就得你点头**。
 */
function checkCode(sec, code, platform = process.platform) {
  const src = String(code || "");
  const mode = permissionMode(sec);
  if (mode === "plan") return { action: "deny", rule: `当前权限档位是「${PERMISSION_MODES.plan.label}」，不执行代码`, seg: "" };
  if (!sec.gateway) {
    // 总开关关掉的是黑名单、子进程这些规则；「每步都问」是用户当场选的档，照样得问（跟写文件、跑命令一致）
    if (mode === "ask" && !sessionAllow.has("code:*")) return { action: "ask", rule: "每步都问模式", seg: src.slice(0, 80), ruleKey: "code:*" };
    return { action: "allow" };
  }
  // Windows 上代码里的路径常写成 "C:\\Users\\Me\\.ssh"，折完跟黑名单比（同 checkCommand）
  const low = platform === "win32" ? foldWin(src) : src.toLowerCase();
  // 拆成几截再用 + 接起来的字符串，按接好的样子再看一遍
  const joined = joinLiterals(low);
  // 黑名单排最前：下面这几条在任何档位下都拦（全自动也不例外），它们挡的是 ~/.ssh、config.json、账号额度这些
  for (const b of blacklistOf(sec)) {
    const { raw, kind, needles } = needlesOf(b, platform);
    if (needles.some((n) => needleIn(low, n, kind) || needleIn(joined, n, kind))) {
      return blacklistVerdict(`代码碰到了文件黑名单（${raw}）`, raw);
    }
    if (pointsAtBlacklisted(raw, joined, platform)) {
      return blacklistVerdict(`代码在拼文件黑名单里的路径（${raw}）`, raw);
    }
  }
  const appMod = loadsAppModule(joined);
  if (appMod) return blacklistVerdict("代码要直接加载应用自己的模块（能改账号、组织和额度）", appMod);
  if (mode === "full") return { action: "allow" };
  const shellOut = /child_process|execSync|execFileSync|spawnSync|process\.binding|node:child_process/.exec(src);
  if (shellOut) {
    if (sessionAllow.has("code:child_process")) return { action: "allow" };
    return { action: "ask", rule: "代码里要开子进程（等于绕过命令闸）", seg: shellOut[0], ruleKey: "code:child_process" };
  }
  if (mode === "ask") {
    if (sessionAllow.has("code:*")) return { action: "allow" };
    return { action: "ask", rule: "每步都问模式", seg: src.slice(0, 80), ruleKey: "code:*" };
  }
  return { action: "allow" };
}

// ---------- 网络安全 ----------

function checkUrl(sec, url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { allowed: false, reason: "URL 无法解析" };
  }
  const hit = (list) => (list || []).some((d) => {
    const dom = String(d).trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    return dom && (host === dom || host.endsWith("." + dom));
  });
  if (!sec.gateway) return { allowed: true };
  if (hit(sec.url_blacklist)) return { allowed: false, reason: `域名在网络黑名单内（${host}）` };
  if ((sec.url_whitelist || []).filter((s) => String(s).trim()).length && !hit(sec.url_whitelist)) {
    return { allowed: false, reason: `网络白名单已启用，${host} 不在名单内` };
  }
  return { allowed: true };
}

// ---------- 命令审批（挂起等待界面批准） ----------

const approvals = new Map(); // id -> { id, kind, text, ts, owner, resolve }

const approvalWatchers = new Set(); // 有人求批准 / 批完了，挨个通知

/**
 * 盯着审批的开合。
 *
 * 为什么要这么个钩子：网页版是自己轮询 listApprovals 的，命令行不是——`openworkbuddy` 跑在另一个进程里，
 * 它连不上那边的 Map。没有这条通知，命令行里一条危险命令求批准的表现就是「卡住两分钟，然后被拒」，
 * 人从头到尾没被问过。命令行订上这个钩子，才能把卡片同时印在终端和手机上。
 *
 * @param {(ev: {type: "open"|"close", entry?: object, id?: string}) => void} fn
 * @returns 取消订阅
 */
function watchApprovals(fn) {
  if (typeof fn !== "function") return () => {};
  approvalWatchers.add(fn);
  return () => approvalWatchers.delete(fn);
}

// 订阅方自己抛错不能把求批准的人拖下水：那会让 requestApproval 当场炸，比不通知还糟
function emitApproval(ev) {
  for (const fn of approvalWatchers) { try { fn(ev); } catch {} }
}

/** 审批原文最多留多长。几万字的代码真有，全塞进轮询里不划算，超了就留头留尾 */
const APPROVAL_TEXT_MAX = 20000;
/** 太长才截，而且明写中间省了多少字——不许悄悄只给前半截：`| sh`、`--force` 往往就在尾巴上 */
function clipForReview(v, max) {
  const s = String(v || "");
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return s.slice(0, head) + `\n…（中间省略 ${s.length - head - tail} 字）…\n` + s.slice(-tail);
}
/**
 * 「一直允许」写进的是 cmd_allow，而那张表只按命令前缀比。danger:/write:/code: 这几类规则
 * 在闸里只认本会话记忆，写进去等于没写——按钮上说「重启也生效」，重启后照样问，是骗人。
 * 高危命令、写文件、跑代码本来也不该一次点头就永久放开，所以这几类只能「本会话」。
 */
function isPersistableRule(ruleKey) {
  const k = String(ruleKey || "");
  return !!k && !/^(danger|write|code):/.test(k);
}

/**
 * @param owner 发起这次任务的登录名。多人共用一台服务器时这个字段是必须的：
 *   审批卡片上写着别人任务要跑的那条命令（路径、域名、脚本片段都在里面），
 *   没有归属就等于谁登录了都能看，还能替别人点「允许」。
 *   IM / 定时任务这类没有登录态的后台跑法留空，只有平台管理员看得见。
 */
function requestApproval(kind, text, { timeoutMs = 120000, stopSignal = null, rule = "", ruleKey = "", source = "", owner = "", detail = "", seg = "", sessionId = "", blacklist = false } = {}) {
  const id = "ap_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
  // 只算一次：列表、通知、计时器三处必须是同一个时刻，否则审批卡倒数到 0 了人还能点
  const deadline = Date.now() + Math.max(5000, timeoutMs);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      approvals.delete(id);
      if (stopSignal) stopSignal.removeEventListener("abort", onAbort);
      emitApproval({ type: "close", id, allow: !!ok });
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
    const onAbort = () => finish(false);
    if (stopSignal) stopSignal.addEventListener("abort", onAbort);
    approvals.set(id, {
      id,
      kind,
      // 原来是悄悄 slice(0, 500)：危险的那句写在第 501 个字以后，人批的就是一条看不见它的命令
      text: clipForReview(text, APPROVAL_TEXT_MAX),
      rule: String(rule || ""),
      // 「以后别再问这类」批的是这条规则；空字符串表示这次的原因不适合记住（比如碰了文件黑名单）
      ruleKey: String(ruleKey || ""),
      source: String(source || "").slice(0, 60), // 发起审批的任务标题：多任务并行时用户得知道是谁在求批
      owner: String(owner || ""),
      detail: String(detail || "").slice(0, 4000), // 改文件的 diff：审批卡上展开看，批的是具体改动不是文件名
      seg: clipForReview(seg, 400), // 触发审批的那一段：长命令里一眼找到是哪句被拦的
      ts: new Date().toISOString(),
      // deadline 给界面用：不告诉人还剩多久，他就是在对着一个不知道会不会过期的按钮下注
      deadline,
      // 哪个会话在等：侧栏要把点亮在那一行上；空 = 不属于某个会话（只进标题计数）
      sessionId: String(sessionId || ""),
      // 碰了文件黑名单的卡：多人共用时谁也批不了（见 resolveApproval）
      blacklist: !!blacklist,
      resolve: finish,
    });
    emitApproval({ type: "open", entry: { ...approvals.get(id), resolve: undefined } });
  });
}
/**
 * @param scopeTo 只列这个人发起的审批；不传（undefined）= 全都列，给平台管理员和单人桌面版用。
 *   注意 owner 为空的那些（IM / 定时任务）在限定视角下一条都不给：它们是这台服务器自己在跑，
 *   不属于任何一个登录用户。
 */
function listApprovals(scopeTo) {
  const all = [...approvals.values()];
  const mine = scopeTo == null ? all : all.filter((e) => e.owner && e.owner === scopeTo);
  // persistable：这条能不能「一直允许」。不能的就别摆那个按钮，点了也写不进去
  return mine.map(({ id, kind, text, rule, ruleKey, source, detail, seg, ts, deadline, sessionId }) => ({ id, kind, text, rule, ruleKey, source, detail, seg, ts, deadline, sessionId, persistable: isPersistableRule(ruleKey) }));
}
/**
 * @param [scope] once（默认，只放这一次）/ session（本会话同类不再问）/ always（由调用方写进永久放行名单）
 * @param [scopeTo] 限定只能批自己那条；不传 = 不限定（平台管理员 / 单人桌面版）
 * @returns { ok, ruleKey, scope } —— always 的持久化在 server 那边做，配置文件归它管
 */
function resolveApproval(id, allow, scope = "once", scopeTo) {
  const e = approvals.get(id);
  if (!e) return { ok: false };
  // 越权不能跟「这条已经没了」返回同一种结果：前者要报出来，后者是正常的竞态（超时/别处点过）
  if (scopeTo != null && e.owner !== scopeTo) return { ok: false, forbidden: true, error: "这条审批是别人的任务发起的" };
  // 多人共用时闸那头碰了黑名单就直接拦、不出卡；这里兜住切成多人之前就挂着的、或者别的入口摆出来的卡。
  // 只能拒不能批，平台管理员也一样：黑名单护的是 Key 和账号库，不该有「点一下就放」的口子
  if (allow && e.blacklist && isMultiUser()) {
    e.resolve(false);
    return { ok: false, forbidden: true, error: "这条碰了文件黑名单，多人共用时不能批，已按拒绝处理" };
  }
  const key = e.ruleKey;
  if (allow && key && (scope === "session" || scope === "always")) addSessionAllow(key);
  e.resolve(!!allow);
  return { ok: true, ruleKey: key, scope };
}
/**
 * 三档里只有 always 是「改这台服务器」：它把规则写进配置里的永久放行名单，对所有人生效。
 * 所以受限的人（非平台管理员）点 always 时降一档按 session 走，而不是当场拒绝——
 * 他那个任务正挂着等这个回答，拒绝换来的是干等到超时按拒绝收场。降了要说出来，
 * 界面照实讲「本次运行期间不再问」，不许悄悄换个档还报「已永久放行」。
 * @param restricted true = 这人只能管自己那一摊
 */
function effectiveScope(scope, restricted) {
  const s = ["once", "session", "always"].includes(scope) ? scope : "once";
  return s === "always" && restricted ? { scope: "session", downgraded: true } : { scope: s, downgraded: false };
}

// ---------- macOS 系统授权 ----------

/** 完全磁盘访问：能读 TCC.db 即已授权（这是 FDA 的标准探针） */
function checkFullDisk() {
  if (process.platform !== "darwin") return "unknown";
  try {
    const fd = fs.openSync(path.join(os.homedir(), "Library/Application Support/com.apple.TCC/TCC.db"), "r");
    fs.closeSync(fd);
    return "granted";
  } catch (e) {
    return e.code === "EPERM" || e.code === "EACCES" ? "denied" : "unknown";
  }
}

/** 辅助功能：仅桌面版（Electron 主进程）能查询 */
function checkAccessibility() {
  if (process.platform !== "darwin") return "unknown";
  try {
    const { systemPreferences } = require("electron");
    return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}

/** 自动化（Apple Events）：主动探测会触发系统授权弹窗，所以只在用户点「检测/授权」时调用 */
function checkAutomation() {
  if (process.platform !== "darwin") return Promise.resolve("unknown");
  return new Promise((resolve) => {
    // 不加 windowsHide：只在 macOS 走得到
    const c = spawn("osascript", ["-e", 'tell application "System Events" to count processes'], { timeout: 8000 });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve(code === 0 ? "granted" : /1743|not allowed|不允许/.test(err) ? "denied" : "unknown"));
    c.on("error", () => resolve("unknown"));
  });
}

const PREF_PANES = {
  fulldisk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};
function openPrefPane(pane) {
  const url = PREF_PANES[pane];
  if (!url || process.platform !== "darwin") return false;
  spawn("open", [url], { detached: true }).unref(); // 不加 windowsHide：只在 macOS 走得到
  return true;
}

module.exports = {
  getSecurity,
  DEFAULTS,
  DESKTOP_OPEN_CMDS,
  audit,
  auditList,
  auditClear,
  auditExport,
  setAuditSink, // 桥（engines/tool-bridge.js）启动时切成每条追加
  BRIDGE_AUDIT_FILE,
  resolvePathWithPolicy,
  PERMISSION_MODES,
  DEFAULT_MODE, // 命令行要用它判断「现在这档是不是默认那档」，决定状态行印不印
  permissionMode,
  engineGuard, // 把档位翻成外部 CLI 引擎认的开关（claude -p / codex exec）
  readOnlyGuard, // 问答 / 计划那一趟：不管档位，本机 CLI 按只读跑
  askingGuard, // 审批交回了主进程：要问的改挂成 claude 的「先问」，碰到弹卡
  wayOut, // 没批下来时用户去哪儿放行（设置页上的真名）
  checkWrite,
  checkCommand,
  checkCode,
  setMultiUser,
  isMultiUser,
  setPlatformAdmin,
  isPlatformAdmin,
  ruleFor,
  parseAllowRule, // 命令行 --allow：开跑前点名放行的那几类
  allowFlagFor,
  allowFlagArg,
  listedCommand, // 判险那道闸用：人批过的段不再花钱判
  commandSegments, // 同上：两道闸按同一个拆法看命令，不然一边看得见 `bash -c` 里那条、一边看不见
  addSessionAllow,
  listSessionAllow,
  clearSessionAllow,
  splitSegments, // 给测试用：命令拆段是整个命令闸的地基，得能单独验
  underPrefix, // 给测试用：Windows 上工作区边界不分大小写、不分正反斜杠
  pathNeedles, // 给测试用：黑名单在 Windows 命令行里的几种写法
  checkUrl,
  requestApproval,
  watchApprovals,
  listApprovals,
  resolveApproval,
  effectiveScope,
  isPersistableRule, // 哪些规则能写进永久放行名单：server 的 always 和网页的按钮都认它
  checkFullDisk,
  checkAccessibility,
  checkAutomation,
  openPrefPane,
};
