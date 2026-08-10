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

const DEFAULTS = {
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
 * 命令闸。返回 allow / ask / deny（附命中的规则）。
 * 顺序是有讲究的：文件黑名单排在放行名单前面——黑名单是「永远拦」，
 * 不能因为用户放行了 `cat ` 就把 `cat ~/.ssh/id_rsa` 一起放过去。
 */
function checkCommand(sec, command) {
  const segs = splitSegments(command);
  const needles = sec.gateway ? (sec.file_blacklist || []).map((b) => ({ raw: String(b).trim(), needles: pathNeedles(b) })) : [];
  for (const seg of segs) {
    const low = seg.toLowerCase();
    for (const b of needles) {
      if (b.needles.some((n) => n && low.includes(n))) {
        // 有 shell 在手，文件黑名单本来是形同虚设的（read_file 拦得住，`cat` 拦不住）
        return { action: "ask", rule: `命令碰到了文件黑名单（${b.raw}）`, seg };
      }
    }
    const env = stripEnvAssign(seg);
    const bare = bareCommand(seg);
    const tok = bare.split(/\s+/)[0] || "";
    if ((sec.cmd_allow || []).some((p) => p && (seg.startsWith(p.trim()) || env.startsWith(p.trim())))) continue;
    const hitAsk = (sec.cmd_ask || []).find((p) => p && (seg.startsWith(p.trim()) || env.startsWith(p.trim()) || bare.startsWith(p.trim())));
    if (hitAsk) return { action: "ask", rule: `命令询问名单「${hitAsk.trim()}」`, seg };
    if (sec.delete_protect) {
      const findDeletes = tok === "find" && /(\s-delete\b|-exec\s+(\S*\/)?rm\b)/.test(bare);
      if (DELETE_CMDS.has(tok) || findDeletes) return { action: "ask", rule: "删除保护（rm 类命令需审批）", seg };
    }
    if (!sec.runtime_python && /^(python3?|pip3?)$/.test(tok)) {
      return { action: "deny", rule: "内置运行时 Python 已停用", seg };
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
  if (!sec.gateway) return { action: "allow" };
  const shellOut = /child_process|execSync|execFileSync|spawnSync|process\.binding|node:child_process/.exec(src);
  if (shellOut) {
    return { action: "ask", rule: "代码里要开子进程（等于绕过命令闸）", seg: shellOut[0] };
  }
  const low = src.toLowerCase();
  for (const b of sec.file_blacklist || []) {
    const raw = String(b).trim();
    if (pathNeedles(b).some((n) => n && low.includes(n))) {
      return { action: "ask", rule: `代码碰到了文件黑名单（${raw}）`, seg: raw };
    }
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

function requestApproval(kind, text, { timeoutMs = 120000, stopSignal } = {}) {
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
    approvals.set(id, { id, kind, text: String(text || "").slice(0, 500), ts: new Date().toISOString(), resolve: finish });
  });
}
function listApprovals() {
  return [...approvals.values()].map(({ id, kind, text, ts }) => ({ id, kind, text, ts }));
}
function resolveApproval(id, allow) {
  const e = approvals.get(id);
  if (!e) return false;
  e.resolve(!!allow);
  return true;
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
  checkCommand,
  checkCode,
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
