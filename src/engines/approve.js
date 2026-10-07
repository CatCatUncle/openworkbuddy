// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 本机 Claude Code 的审批工具（claude 的 --permission-prompt-tool 指到这里）。
 *
 * -p 是非交互的：claude 碰到要审批的动作（名单外的命令、工作目录外的文件、抓网页），没人能点同意，
 * 一律判「This command requires approval」，模型被拒一次就换个写法再撞。挂上这个工具以后，
 * claude 要审批时先来问这里，这里照安全中心的规则裁决——跟内置引擎 run_shell / 写文件 / fetch_url 同一套判法。
 *
 * 只认规则、不摆审批卡：桥是 CLI 拉起的子进程，在这儿摆出的卡网页、终端、手机都看不见
 * （tool-bridge.js 里那条 watchApprovals 当场就拒）。规则说要人点头的（删除、sudo、「每步都问」那档），
 * 这条路没人能批，照拒，拒的时候把为什么、怎么办说清楚。
 * 名单外先判一句（cmd_risk_gate）要花钱问判断模型，桥这边不问——内置那边问不成时也是照规则办。
 *
 * 不认得的工具一律拒：规则一写宽，就等于把审批整个放开。
 * 注意 acceptEdits 档下 claude 自己就放行的（工作目录里改文件、它认得的只读命令）不会来问，这里管不到。
 *
 * 问法、答法（2.1.288 实测，2.1.291 里是同一份 schema）：
 *   问：{tool_name, input, tool_use_id}
 *   答：{behavior:"allow", updatedInput} 照跑；{behavior:"deny", message} 不跑，模型收到的就是 message 原文
 */

const path = require("path");
const security = require("../core/safety/security");
const netGuard = require("../core/safety/net-guard");

const TOOL = "approve";

/** tools/list 里那一条。claude 认它当审批工具以后，模型的工具表里就没有它了 */
const DEF = {
  name: TOOL,
  description: "OpenWorkBuddy 内部用：本机 Claude Code 要审批时来问这里，按安全中心的规则裁决。模型不用直接调它。",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

/** glob 里第一个通配符之前那段：只按这段判路径（`../../.ssh/*` 判的是 `../../.ssh/`） */
const globRoot = (/** @type {unknown} */ p) => String(p || "").split(/[*?[{]/)[0] || ".";

/** 读的那几个：要碰哪几处路径 */
/** @type {Record<string, (i: any) => unknown[]>} */
const READS = {
  Read: (i) => [i.file_path],
  Glob: (i) => [i.path, globRoot(i.pattern)],
  Grep: (i) => [i.path],
  LS: (i) => [i.path],
  NotebookRead: (i) => [i.notebook_path],
};
/** 写的那几个：写到哪 */
/** @type {Record<string, (i: any) => unknown>} */
const WRITES = {
  Write: (i) => i.file_path,
  Edit: (i) => i.file_path,
  MultiEdit: (i) => i.file_path,
  NotebookEdit: (i) => i.notebook_path,
};
/** 跑命令的那几个：按哪种 shell 拆段。PowerShell 只在 Windows 上有 */
/** @type {Record<string, string>} */
const SHELLS = { Bash: "", PowerShell: "win32", Monitor: "" };
/** 不碰文件、不跑新命令的：看它自己起的后台命令、停掉它、记待办 */
const HARMLESS = new Set(["TodoWrite", "BashOutput", "KillShell", "KillBash", "TaskOutput", "TaskStop"]);

/**
 * 安全中心的判词 → 拒的话（放行返回空串）。跟 tools.js 的 passGate 同一个口径，只是没有「摆卡等人批」那一步
 * @param {any} sec
 * @param {{action: string, rule?: string, seg?: string}} verdict
 * @param {string} label
 * @param {string} text
 * @param {boolean} force 档位（只看不动 / 每步都问）不受安全闸门总开关影响
 * @param {string} way 要人点头时，用户能怎么放行
 */
function refuse(sec, verdict, label, text, force, way) {
  if ((!sec.gateway && !force) || verdict.action === "allow") return "";
  if (verdict.action === "deny") {
    security.audit(label + "拦截", text, "拦截");
    return `${label}被安全中心拦截：${verdict.rule}（命中「${verdict.seg}」）`;
  }
  security.audit(label + "审批", text, "已拒绝（本机引擎这条路没人能批）");
  return `${label}要人点头（${verdict.rule}），本机引擎这条路没人能批，没有执行。被拒一次就别换个写法再试：换一种不需要它的做法，或者在交付里写清楚，${way}`;
}

/**
 * @param {any} req claude 递过来的 {tool_name, input, tool_use_id}
 * @param {{sec: any, readOnly?: boolean, root: string, base?: string, platform?: string}} ctx
 *   sec：config.security 补过默认值；root：工作区根；base：这一趟的工作目录（相对路径按它解析）
 * @returns {Promise<{behavior: "allow", updatedInput: any} | {behavior: "deny", message: string}>}
 */
async function decide(req, { sec, readOnly = false, root, base, platform = process.platform }) {
  const name = String((req && req.tool_name) || "");
  const input = req && req.input && typeof req.input === "object" && !Array.isArray(req.input) ? req.input : {};
  const allow = () => /** @type {const} */ ({ behavior: "allow", updatedInput: input });
  const deny = (/** @type {string} */ message) => /** @type {const} */ ({ behavior: "deny", message });
  try {
    // 问答 / 计划那一趟：本来就不动手，要审批的一律不批（读工作目录里的 claude 自己就放行，不会来问）
    if (readOnly) {
      security.audit("本机引擎拦截", name, "拦截");
      return deny(`这一趟是问答 / 计划模式，按只读跑：${name || "这一步"}要审批，没有执行。`);
    }
    const mode = security.permissionMode(sec);
    const gated = mode === "plan" || mode === "ask";
    const where = (/** @type {string} */ p) => {
      const rel = path.relative(root, p);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : p;
    };
    // 路径照内置文件工具那样判：黑名单、工作区、白名单，按真实位置
    const pathRefusal = (/** @type {unknown} */ p) => {
      if (typeof p !== "string" || !p) return null;
      const r = security.resolvePathWithPolicy(sec, p, root, base || root);
      if (r.allowed) return { path: r.path, why: "" };
      security.audit("文件拦截", `${name}: ${p}`, "拦截");
      return { path: r.path, why: `文件访问被安全中心拦截：${r.reason}` };
    };

    if (READS[name]) {
      for (const p of READS[name](input)) {
        const r = pathRefusal(p);
        if (r && r.why) return deny(r.why);
      }
      return allow();
    }
    if (WRITES[name]) {
      const target = WRITES[name](input);
      if (typeof target !== "string" || !target) return deny(`${name} 没说要写哪个文件，没有执行。`);
      const r = pathRefusal(target);
      if (r && r.why) return deny(r.why);
      const rel = where(/** @type {{path: string}} */ (r).path);
      const why = refuse(sec, security.checkWrite(sec, rel), "改文件", rel, true, "让用户决定要不要把安全档位调到「自动改文件」。");
      return why ? deny(why) : allow();
    }
    if (name in SHELLS) {
      const cmd = String(input.command || "");
      if (!cmd.trim()) return deny("command 是空的，没有执行。");
      const v = security.checkCommand(sec, cmd, /** @type {NodeJS.Platform} */ (SHELLS[name] || platform));
      const why = refuse(sec, v, "命令", cmd, gated, "卡在哪条命令、它要干什么，让用户决定是自己在终端里跑，还是在 设置 → 安全中心 的名单里预先放行这类。");
      if (why) return deny(why);
      security.audit("命令执行", cmd, "放行（本机引擎）");
      return allow();
    }
    if (name === "WebFetch") {
      const url = String(input.url || "");
      const org = require("../agent/tools").hostAllowed(null, url);
      if (!org.ok) {
        security.audit("网络拦截", url, "拦截");
        return deny(`网络访问被拦截：${org.why}`);
      }
      const g = await netGuard.checkUrl(sec, url);
      if (!g.allowed) {
        security.audit("网络拦截", url, "拦截");
        return deny(`网络访问被安全中心拦截：${g.reason}`);
      }
      security.audit("网络访问", `本机引擎抓网页：${url}`, "放行");
      return allow();
    }
    // 内置那边联网搜索也不设闸，只记一笔
    if (name === "WebSearch") {
      security.audit("网络访问", `本机引擎联网搜索：${String(input.query || "")}`, "放行");
      return allow();
    }
    if (HARMLESS.has(name)) return allow();
    security.audit("本机引擎拦截", name, "拦截");
    return deny(`${name || "这个工具"} 不在 OpenWorkBuddy 认得的范围里，没有执行。`);
  } catch (e) {
    // 判不出来就按拒：审批这一步出错放过去，等于没设
    return deny(`审批这一步出了错（${(e && /** @type {any} */ (e).message) || e}），按拒绝处理，没有执行。`);
  }
}

module.exports = { TOOL, DEF, decide, _internals: { globRoot, READS, WRITES, SHELLS, HARMLESS } };
