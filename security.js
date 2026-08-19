"use strict";
/**
 * 安全中心 — 沙箱三闸（文件/命令/网络）+ 审计日志 + 命令审批 + macOS 系统授权检测。
 *
 * 设计原则：每一项都是真实闸门（在工具执行层硬拦截），不做仅展示的开关。
 * - 文件安全：workspace 内默认可用；黑名单永远拦；workspace 外仅白名单目录放行
 * - 命令安全：放行名单直接执行；询问名单挂起等用户在界面上批准（超时/停止即拒绝）
 * - 网络安全：域名黑名单拦截；白名单非空时只允许白名单域名
 * - 审计中心：网络访问/命令执行/拦截记录全部落 data/audit.json（环形 1000 条）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const jsonStore = require("./store");

const AUDIT_FILE = path.join(__dirname, "data", "audit.json");
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
  full: { label: "全自动", desc: "命令也不问了，只剩文件黑名单和审计。确定它在干什么再开", write: "allow", cmd: "allow" },
};
const DEFAULT_MODE = "auto";

function permissionMode(sec) {
  const m = String((sec || {}).permission_mode || DEFAULT_MODE);
  return PERMISSION_MODES[m] ? m : DEFAULT_MODE;
}

const DEFAULTS = {
  permission_mode: DEFAULT_MODE, // plan / ask / auto / full，见 PERMISSION_MODES
  gateway: true, // 安全网关总开关：关闭后黑名单/审批闸不再拦截（审计照记）
  delete_protect: true, // 删除保护：rm 类命令需要审批
  batch_delete_threshold: 50,
  file_whitelist: ["<app>/skills"], // workspace 外允许访问的路径前缀（绝对路径或 ~ 开头）；技能自带资源默认放行
  file_blacklist: ["~/.ssh", "~/Library/Keychains", "<app>/config.json", "<app>/data/users.json"],
  cmd_allow: [], // 命令前缀放行名单：匹配即直接执行
  cmd_ask: ["sudo ", "shutdown", "reboot", "mkfs", "diskutil erase", "killall "],
  url_whitelist: [], // 非空 = 只允许这些域名（后缀匹配）
  url_blacklist: [],
  runtime_node: true,
  runtime_python: true,
  approval_timeout_s: 120, // 审批等待上限（秒），超时按拒绝处理
};

/** 给 config.security 补默认值（保留用户已改项），返回引用 */
function getSecurity(config) {
  config.security = { ...DEFAULTS, ...(config.security || {}) };
  return config.security;
}

// ---------- 审计 ----------

let auditDirty = false;
function audit(type, text, action) {
  auditLog.push({ ts: new Date().toISOString(), type, text: String(text || "").slice(0, 300), action: action || "放行" });
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
  return auditLog.slice(-(limit || 100)).reverse();
}
function auditClear() {
  auditLog = [];
  try {
    fs.writeFileSync(AUDIT_FILE, "[]", "utf8");
  } catch {}
}
function auditExport() {
  return auditLog.map((e) => `${e.ts}\t[${e.type}]\t${e.action}\t${e.text}`).join("\n");
}

// ---------- 文件安全 ----------

function expandPath(s) {
  return path.resolve(String(s).replace(/^~(?=$|\/)/, os.homedir()).replace(/^<app>/, __dirname));
}
function underPrefix(p, prefix) {
  return p === prefix || p.startsWith(prefix + path.sep);
}

/**
 * 按文件安全策略解析路径。workspace 内默认放行（黑名单除外）；
 * workspace 外仅白名单前缀放行 —— 这也让文件工具获得受控的越界能力。
 */
function resolvePathWithPolicy(sec, rel, workspaceDir) {
  const p = path.resolve(workspaceDir, String(rel || ".").replace(/\\/g, "/"));
  if (sec.gateway) {
    for (const b of sec.file_blacklist || []) {
      const bp = expandPath(b);
      if (underPrefix(p, bp)) return { path: p, allowed: false, reason: `路径在文件黑名单内（${b}）` };
    }
  }
  if (underPrefix(p, workspaceDir)) return { path: p, allowed: true };
  for (const w of sec.file_whitelist || []) {
    if (underPrefix(p, expandPath(w))) return { path: p, allowed: true, outside: true };
  }
  return { path: p, allowed: false, reason: "路径越界：workspace 外仅文件白名单目录可访问（设置 → 安全中心 → 文件安全）" };
}

// ---------- 命令安全 ----------

/** 只是包在真命令外面的东西，判断「这段到底在跑什么」时要先剥掉 */
const WRAPPERS = new Set(["nohup", "command", "builtin", "exec", "env", "time", "nice", "ionice", "xargs", "then", "else", "do", "{", "("]);
/** 会真的把文件弄没的命令 */
const DELETE_CMDS = new Set(["rm", "rmdir", "srm", "unlink", "shred"]);
const SUB_DEPTH_MAX = 4;

/**
 * 把一条命令拆成一段段真正会被执行的东西。
 *
 * 除了 `;` `&&` `||` `|` `&`，还有两件事以前是漏的，而且都能一句话废掉整个命令闸：
 *   - **换行**：agent 写的是多行脚本，`echo hi\nrm -rf ~/x` 以前算一整段，开头是 echo，删除保护看都看不见；
 *   - **`$(...)` 和反引号**：`echo $(rm -rf ~/x)` 同理，得把括号里的东西挖出来单独算一段。
 * 引号里的分隔符不算分隔符（`grep "a|b"` 不该被拆开），但双引号里的 `$()` 照样会执行，所以照挖。
 */
function splitSegments(command, out = [], depth = 0) {
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
      if (ch === "\\") { inner += ch + (src[j + 1] || ""); j++; continue; }
      if (ch === open && open !== close) d++;
      else if (ch === close) { d--; if (!d) break; }
      inner += ch;
    }
    if (depth < SUB_DEPTH_MAX) splitSegments(inner, out, depth + 1);
    else if (inner.trim()) out.push(inner.trim());
    return j;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && quote !== "'") { cur += c + (src[i + 1] || ""); i++; continue; }
    if (quote) {
      if (c === quote) { quote = null; cur += c; continue; }
      if (quote === '"' && c === "$" && src[i + 1] === "(") { i = grab(i + 2, "(", ")"); continue; }
      if (quote === '"' && c === "`") { i = grab(i + 1, "`", "`"); continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "$" && src[i + 1] === "(") { i = grab(i + 2, "(", ")"); continue; }
    if (c === "`") { i = grab(i + 1, "`", "`"); continue; }
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
/** 剥到真正在跑的那条命令：包装词去掉、`/bin/rm` 还原成 `rm` */
function bareCommand(seg) {
  let s = stripEnvAssign(seg).trim();
  for (let i = 0; i < 5; i++) {
    const tok = s.split(/\s+/)[0] || "";
    if (!WRAPPERS.has(tok)) break;
    s = s.slice(tok.length).trim();
  }
  const tok = s.split(/\s+/)[0] || "";
  return tok.includes("/") ? path.basename(tok) + s.slice(tok.length) : s;
}

/** 一条黑名单路径在命令行里可能长什么样 */
function pathNeedles(entry) {
  const raw = String(entry).trim();
  if (!raw) return [];
  const out = [raw.toLowerCase(), expandPath(raw).toLowerCase()];
  const tail = raw.replace(/^~|^<app>/, "");
  // `~/.ssh` 写成 `$HOME/.ssh` 也要认出来；但 `/config.json` 这种太泛的尾巴不认，免得天天弹审批
  const parts = tail.split("/").filter(Boolean);
  if (tail.startsWith("/") && (parts.length > 1 || (parts[0] || "").startsWith("."))) out.push(tail.toLowerCase());
  return out;
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

/** 多子命令的工具，规则粒度取到第二个词：放行 `git status` 不等于放行 `git push --force` */
const SUBCMD_TOOLS = new Set(["git", "npm", "pnpm", "yarn", "npx", "docker", "kubectl", "pm2", "brew", "cargo", "go", "pip", "pip3", "python", "python3", "node", "gh", "systemctl", "ffmpeg"]);

/**
 * 从一段命令里推出一条「以后遇到这类就别问了」的规则。
 * 粒度太粗会把危险的一起放过去（放行 `git` 等于放行 `git push -f`），
 * 太细又等于没记（带具体文件名的规则下次必然不命中）。取「命令 + 子命令」是这两者之间。
 */
function ruleFor(text) {
  const seg = splitSegments(String(text || ""))[0] || String(text || "");
  const bare = bareCommand(seg).trim();
  const parts = bare.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (SUBCMD_TOOLS.has(parts[0]) && parts[1] && !parts[1].startsWith("-")) return `${parts[0]} ${parts[1]}`;
  return parts[0];
}

function matchesPrefix(list, seg, env, bare) {
  return (list || []).some((p) => {
    const q = String(p || "").trim();
    return q && (seg.startsWith(q) || env.startsWith(q) || bare.startsWith(q));
  });
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
function checkCommand(sec, command) {
  const segs = splitSegments(command);
  const mode = permissionMode(sec);
  const needles = sec.gateway ? (sec.file_blacklist || []).map((b) => ({ raw: String(b).trim(), needles: pathNeedles(b) })) : [];
  for (const seg of segs) {
    const low = seg.toLowerCase();
    for (const b of needles) {
      if (b.needles.some((n) => n && low.includes(n))) {
        // 有 shell 在手，文件黑名单本来是形同虚设的（read_file 拦得住，`cat` 拦不住）
        return { action: "ask", rule: `命令碰到了文件黑名单（${b.raw}）`, seg, ruleKey: "" };
      }
    }
    const env = stripEnvAssign(seg);
    const bare = bareCommand(seg);
    const tok = bare.split(/\s+/)[0] || "";
    if (mode === "plan") return { action: "deny", rule: `当前权限档位是「${PERMISSION_MODES.plan.label}」，不跑命令`, seg };
    if (matchesPrefix(sec.cmd_allow, seg, env, bare)) continue; // 永久放行名单
    if (matchesPrefix([...sessionAllow], seg, env, bare)) continue; // 本会话已经批过同类
    // 运行时开关是用户明确关掉的东西，不受权限档位影响：全自动也不代表把关掉的运行时打开
    if (!sec.runtime_python && /^(python3?|pip3?)$/.test(tok)) {
      return { action: "deny", rule: "内置运行时 Python 已停用", seg };
    }
    if (mode === "full") continue; // 全自动：名单之外的也不问了
    if (mode === "ask") return { action: "ask", rule: `每步都问模式`, seg, ruleKey: ruleFor(seg) };
    const hitAsk = (sec.cmd_ask || []).find((p) => p && (seg.startsWith(p.trim()) || env.startsWith(p.trim()) || bare.startsWith(p.trim())));
    if (hitAsk) return { action: "ask", rule: `命令询问名单「${hitAsk.trim()}」`, seg, ruleKey: ruleFor(seg) };
    if (sec.delete_protect) {
      const findDeletes = tok === "find" && /(\s-delete\b|-exec\s+(\S*\/)?rm\b)/.test(bare);
      if (DELETE_CMDS.has(tok) || findDeletes) return { action: "ask", rule: "删除保护（rm 类命令需审批）", seg, ruleKey: ruleFor(seg) };
    }
  }
  return { action: "allow" };
}

/**
 * 代码闸（run_node / 未来的其它运行时）。
 *
 * 命令闸拦得再严，一句 `require("child_process").execSync("rm -rf ~")` 就全绕过去了——
 * 代码是从同一个 agent 嘴里出来的，不能只看 run_shell 那扇门。
 * 这里不做沙箱（做不到），只做一件事：**代码要开子进程、或者伸手去碰文件黑名单，就得你点头**。
 */
function checkCode(sec, code) {
  const src = String(code || "");
  const mode = permissionMode(sec);
  if (mode === "plan") return { action: "deny", rule: `当前权限档位是「${PERMISSION_MODES.plan.label}」，不执行代码`, seg: "" };
  if (!sec.gateway) return { action: "allow" };
  const low = src.toLowerCase();
  for (const b of sec.file_blacklist || []) {
    const raw = String(b).trim();
    // 黑名单排最前：这条在任何档位下都拦（全自动也不例外），它挡的是 ~/.ssh、config.json 这些
    if (pathNeedles(b).some((n) => n && low.includes(n))) {
      return { action: "ask", rule: `代码碰到了文件黑名单（${raw}）`, seg: raw, ruleKey: "" };
    }
  }
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

const approvals = new Map(); // id -> { id, kind, text, ts, resolve }

function requestApproval(kind, text, { timeoutMs = 120000, stopSignal, rule = "", ruleKey = "" } = {}) {
  const id = "ap_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      approvals.delete(id);
      if (stopSignal) stopSignal.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), Math.max(5000, timeoutMs));
    const onAbort = () => finish(false);
    if (stopSignal) stopSignal.addEventListener("abort", onAbort);
    approvals.set(id, {
      id,
      kind,
      text: String(text || "").slice(0, 500),
      rule: String(rule || ""),
      // 「以后别再问这类」批的是这条规则；空字符串表示这次的原因不适合记住（比如碰了文件黑名单）
      ruleKey: String(ruleKey || ""),
      ts: new Date().toISOString(),
      resolve: finish,
    });
  });
}
function listApprovals() {
  return [...approvals.values()].map(({ id, kind, text, rule, ruleKey, ts }) => ({ id, kind, text, rule, ruleKey, ts }));
}
/**
 * @param scope once（默认，只放这一次）/ session（本会话同类不再问）/ always（由调用方写进永久放行名单）
 * @returns { ok, ruleKey, scope } —— always 的持久化在 server 那边做，配置文件归它管
 */
function resolveApproval(id, allow, scope = "once") {
  const e = approvals.get(id);
  if (!e) return { ok: false };
  const key = e.ruleKey;
  if (allow && key && (scope === "session" || scope === "always")) addSessionAllow(key);
  e.resolve(!!allow);
  return { ok: true, ruleKey: key, scope };
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
  spawn("open", [url], { detached: true }).unref();
  return true;
}

module.exports = {
  getSecurity,
  DEFAULTS,
  audit,
  auditList,
  auditClear,
  auditExport,
  resolvePathWithPolicy,
  PERMISSION_MODES,
  permissionMode,
  checkWrite,
  checkCommand,
  checkCode,
  ruleFor,
  addSessionAllow,
  listSessionAllow,
  clearSessionAllow,
  splitSegments, // 给测试用：命令拆段是整个命令闸的地基，得能单独验
  checkUrl,
  requestApproval,
  listApprovals,
  resolveApproval,
  checkFullDisk,
  checkAccessibility,
  checkAutomation,
  openPrefPane,
};
