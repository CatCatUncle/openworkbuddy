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
const { DATA_DIR, dataPath } = require("./paths");
const os = require("os");
const { spawn } = require("child_process");

const jsonStore = require("./store");

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
 *
 * @returns {{mode:string, claudeMode:string, codexSandbox:string, allowShim:boolean, disallow:string[], note:string}}
 */
function engineGuard(sec) {
  const mode = permissionMode(sec);
  const m = ENGINE_MODES[mode] || ENGINE_MODES[DEFAULT_MODE];
  const heads = [];
  if (mode !== "full") {
    // 名单里写的是前缀（"sudo "、"diskutil erase"），CLI 那边的匹配单位是可执行文件名，
    // 所以取第一个词。"diskutil erase" 收紧成整个 diskutil：宁可多禁一点，也别放过
    for (const p of (sec || {}).cmd_ask || []) heads.push(String(p || "").trim().split(/\s+/)[0]);
    // 删除保护是另一颗独立开关（不在 cmd_ask 里），但道理一样：说了要问，这条路问不着
    if ((sec || {}).delete_protect !== false) heads.push("rm");
  }
  const uniq = [...new Set(heads.filter(Boolean))];
  const notes = {
    plan: "安全档位是「只看不动」：本机 CLI 这一趟按只读跑，不写文件也不跑命令。",
    ask: "安全档位是「每步都问」，而本机 CLI 这条路没有审批通道（非交互，没人能点同意）——它要写文件或跑命令会被直接拒。想让它动手，把档位调到「自动改文件」。",
    auto: uniq.length ? `按你的安全设置，本机 CLI 不许自己跑这些命令：${uniq.join("、")}（这条路没有审批通道，只能直接禁）。` : "",
    full: "",
  };
  return {
    mode,
    claudeMode: m.claude,
    codexSandbox: m.codex,
    // 只看不动 / 每步都问：连本项目借出去的那条命令行入口也不放行，否则等于从后门绕开档位
    allowShim: PERMISSION_MODES[mode].cmd !== "deny",
    disallow: uniq.map((h) => `Bash(${h}:*)`),
    note: notes[mode] || "",
  };
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
  return path.resolve(String(s).replace(/^~(?=$|\/)/, os.homedir()).replace(/^<app>/, DATA_DIR));
}
function underPrefix(p, prefix) {
  return p === prefix || p.startsWith(prefix + path.sep);
}

/**
 * 按文件安全策略解析路径。workspace 内默认放行（黑名单除外）；
 * workspace 外仅白名单前缀放行 —— 这也让文件工具获得受控的越界能力。
 */
function resolvePathWithPolicy(sec, rel, workspaceDir, base) {
  // base：本次任务的成果子目录（默认工作空间按对话分文件夹）；越界判定仍以整个 workspace 为界
  const p = path.resolve(base || workspaceDir, String(rel || ".").replace(/\\/g, "/"));
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
const DELETE_CMDS = new Set(["rm", "rmdir", "srm", "unlink", "shred", "del", "erase", "rd"]);
/** 会在用户桌面上弹出东西的命令（macOS open、Linux xdg-open、Windows start/explorer），见 checkCommand 里那段 */
const DESKTOP_OPEN_CMDS = new Set(["open", "xdg-open", "start", "explorer"]);

// P5 软护栏：不可逆、毁数据的命令形态。任何权限档位（含全自动）都要用户点头，
// 永久放行名单也盖不住——这不是沙箱，只是把「一条命令毁掉一晚上工作」换成一次审批。
// 批过一次的（「以后别再问这类」）按 danger:key 记在本会话里，不会反复骚扰。
const DANGER_PATTERNS = [
  { key: "dev-write", re: /(?:^|\s)>{1,2}\s*\/dev\/(?!null\b|stdout\b|stderr\b|tty\b|zero\b|fd\/)/i, rule: "重定向直写设备文件（> /dev/…）" },
  { key: "dd-dev", re: /\bdd\b[^\n]*\bof=\/dev\//i, rule: "dd 直写设备（of=/dev/…）" },
  { key: "compose-down-v", re: /\bdocker(?:-|\s+)compose\b[^\n]*\bdown\b[^\n]*(?:\s-\w*v|\s--volumes\b)/i, rule: "compose down 带 -v 会把数据卷一起删掉" },
  { key: "git-force-push", re: /\bgit\b[^\n]*\bpush\b[^\n]*(?:\s--force\b|\s-f\b)/i, rule: "git 强推会改写远端历史" },
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
    if (sec.gateway) {
      // 高危表在放行名单之前查：cmd_allow 是给日常命令省事的，不该顺手把毁数据的形态一起放过去
      const danger = DANGER_PATTERNS.find((d) => d.re.test(seg) && !sessionAllow.has("danger:" + d.key));
      if (danger) return { action: "ask", rule: `高危命令：${danger.rule}`, seg, ruleKey: "danger:" + danger.key };
    }
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
    // 弹到用户桌面的命令：open / xdg-open / start 会在用户眼前弹出窗口或浏览器标签。
    // 它不毁数据，所以四张名单一张都不管它——而它恰恰是最招人烦的那类：任务收尾「顺手」把
    // 推文、封面、HTML 各开一个，用户桌面被刷一排窗口。真踩过，而且长期记忆里明明写着「别开」，
    // 记忆超预算按相关度一挑就把这条规矩挑掉了。提示词和记忆都是建议，这儿才是闸：
    // 用户没点头就不开，他要真想看，批一次「本会话一直允许」就够了；永久放行写 cmd_allow
    if (DESKTOP_OPEN_CMDS.has(tok)) {
      return { action: "ask", rule: "要在你桌面上打开文件或网页（用户没要求就别替他开，交付只报路径）", seg, ruleKey: ruleFor(seg) };
    }
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

/**
 * @param owner 发起这次任务的登录名。多人共用一台服务器时这个字段是必须的：
 *   审批卡片上写着别人任务要跑的那条命令（路径、域名、脚本片段都在里面），
 *   没有归属就等于谁登录了都能看，还能替别人点「允许」。
 *   IM / 定时任务这类没有登录态的后台跑法留空，只有平台管理员看得见。
 */
function requestApproval(kind, text, { timeoutMs = 120000, stopSignal, rule = "", ruleKey = "", source = "", owner = "", detail = "" } = {}) {
  const id = "ap_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
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
      source: String(source || "").slice(0, 60), // 发起审批的任务标题：多任务并行时用户得知道是谁在求批
      owner: String(owner || ""),
      detail: String(detail || "").slice(0, 4000), // 改文件的 diff：审批卡上展开看，批的是具体改动不是文件名
      ts: new Date().toISOString(),
      resolve: finish,
    });
    // deadline 给界面用：不告诉人还剩多久，他就是在对着一个不知道会不会过期的按钮下注
    emitApproval({ type: "open", entry: { ...approvals.get(id), resolve: undefined, deadline: Date.now() + Math.max(5000, timeoutMs) } });
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
  return mine.map(({ id, kind, text, rule, ruleKey, source, detail, ts }) => ({ id, kind, text, rule, ruleKey, source, detail, ts }));
}
/**
 * @param scope once（默认，只放这一次）/ session（本会话同类不再问）/ always（由调用方写进永久放行名单）
 * @param scopeTo 限定只能批自己那条；不传 = 不限定（平台管理员 / 单人桌面版）
 * @returns { ok, ruleKey, scope } —— always 的持久化在 server 那边做，配置文件归它管
 */
function resolveApproval(id, allow, scope = "once", scopeTo) {
  const e = approvals.get(id);
  if (!e) return { ok: false };
  // 越权不能跟「这条已经没了」返回同一种结果：前者要报出来，后者是正常的竞态（超时/别处点过）
  if (scopeTo != null && e.owner !== scopeTo) return { ok: false, forbidden: true, error: "这条审批是别人的任务发起的" };
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
  DESKTOP_OPEN_CMDS,
  audit,
  auditList,
  auditClear,
  auditExport,
  resolvePathWithPolicy,
  PERMISSION_MODES,
  DEFAULT_MODE, // 命令行要用它判断「现在这档是不是默认那档」，决定状态行印不印
  permissionMode,
  engineGuard, // 把档位翻成外部 CLI 引擎认的开关（claude -p / codex exec）
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
  watchApprovals,
  listApprovals,
  resolveApproval,
  effectiveScope,
  checkFullDisk,
  checkAccessibility,
  checkAutomation,
  openPrefPane,
};
