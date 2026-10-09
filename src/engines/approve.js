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
 * 规则说要人点头的（删除、sudo、「每步都问」那档）：桥把这一问交回主进程（engines/tool-relay.js 的 approve），
 * 主进程在这里摆一张跟内置引擎一样的审批卡——网页、终端、手机都看得见——等人点了再答。
 * 交不回去（口子没开成、连不上）就退回只认规则：桥自己摆的卡谁也看不见（tool-bridge.js 里那条
 * watchApprovals 当场就拒），照拒，拒的时候把为什么、去哪儿放行说清楚。
 * 名单外先判一句（cmd_risk_gate）要花钱问判断模型，这里不问——内置那边问不成时也是照规则办。
 *
 * 不认得的工具一律拒：规则一写宽，就等于把审批整个放开。
 * 注意 acceptEdits 档下 claude 自己就放行的（工作目录里改文件、它认得的只读命令）不会来问，这里管不到。
 * rm、rmdir 在这档它也自己放行（2.1.295 实测）：所以审批交回了主进程时，按安全设置给它挂「先问」规则
 * （security.askingGuard，claude-code.js 拼成 --settings），逼它来问这里。
 *
 * 问法、答法（2.1.288 实测，2.1.291 里是同一份 schema）：
 *   问：{tool_name, input, tool_use_id}
 *   答：{behavior:"allow", updatedInput} 照跑；{behavior:"deny", message} 不跑，模型收到的就是 message 原文
 */

const fs = require("fs");
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

/** @typedef {{action: string, rule?: string, seg?: string, ruleKey?: string, blacklist?: boolean}} Verdict */
/** @typedef {(verdict: Verdict, label: string, text: string, detail: string) => Promise<boolean>} Ask 摆审批卡、等人点，批了回 true */

/** 问不了的时候，用户去哪儿放行（设置页上的真名，跟内置引擎同一份） */
const wayOut = security.wayOut;

/**
 * 安全中心的判词 → 拒的话（放行返回空串）。跟 tools.js 的 passGate 同一个口径：要人点头的摆卡等人批；
 * 没有 ask（审批没交回主进程）就照拒，告诉它用户能去哪儿放行
 * @param {any} sec
 * @param {Verdict} verdict
 * @param {string} label
 * @param {string} text
 * @param {boolean} force 档位（只看不动 / 每步都问）不受安全闸门总开关影响
 * @param {Ask|null} ask
 * @param {string} [detail] 审批卡上展开看的（改文件的 diff）
 */
async function refuse(sec, verdict, label, text, force, ask, detail = "") {
  if ((!sec.gateway && !force) || verdict.action === "allow") return "";
  if (verdict.action === "deny") {
    security.audit(label + "拦截", text, "拦截");
    return `${label}被安全中心拦截：${verdict.rule}（命中「${verdict.seg}」）`;
  }
  if (!ask) {
    security.audit(label + "审批", text, "已拒绝（这一趟没法问人）");
    const how = wayOut(verdict);
    return `${label}要用户点头（${verdict.rule}），这一趟没法问他，没有执行。别换个写法再试：换一种不需要它的做法，或者在交付里写清楚卡在哪、要干什么，${how ? `告诉用户可以${how}` : "让用户决定"}。`;
  }
  security.audit(label + "审批", text, "等待审批");
  const ok = await ask(verdict, label, text, detail);
  security.audit(label + "审批", text, ok ? "已批准" : "已拒绝");
  if (ok) return "";
  // 别说「用户拒了」：也可能是等超时、或者当时没人在跟前——模型照着这句会跟人说「你拒了」
  return `${label}没批下来（${verdict.rule}）：被拒、等超时，或者当时没人能批，没有执行。别换个写法再试：换一种不需要它的做法，或者在交付里写清楚卡在哪、要干什么，让用户决定。`;
}

/**
 * 主进程那头的 ask：摆一张跟内置引擎 passGate 一样的审批卡，等人点。
 * 等多久也照内置那边算：设置里的审批等待上限，和这一趟剩下的时间（留 10 秒收尾）取小的。
 * signal 断了（CLI 不等了、这一趟叫停）卡当场收掉，按拒
 * @param {{sec: any, signal?: AbortSignal, deadline?: () => number, source?: string, owner?: string, sessionId?: string}} o
 * @returns {Ask}
 */
function cardAsk({ sec, signal, deadline = () => 0, source = "", owner = "", sessionId = "" }) {
  return async (verdict, label, text, detail) => {
    if (signal && signal.aborted) return false;
    const due = deadline();
    return security.requestApproval(label + "执行", text, {
      timeoutMs: Math.min((sec.approval_timeout_s || 120) * 1000, due ? Math.max(5000, due - Date.now() - 10000) : Infinity),
      stopSignal: signal,
      rule: verdict.rule || "",
      ruleKey: verdict.ruleKey || "",
      source,
      owner,
      detail,
      seg: verdict.seg || "",
      sessionId,
      blacklist: !!verdict.blacklist,
    });
  };
}

/**
 * 改文件那张卡上的 diff：看着改了哪几行批，跟内置 write_file / edit_file 那张卡一样。算不出来就空着，照样能批
 * @param {string} name @param {any} input @param {string} abs @param {string} rel
 */
function writeDetail(name, input, abs, rel) {
  try {
    const { diffText } = require("../agent/tools")._internals;
    /** @type {Buffer|null} */
    let was = null;
    try { const st = fs.statSync(abs); if (st.isFile() && st.size <= 2 * 1024 * 1024) was = fs.readFileSync(abs); } catch {}
    if (name === "Write") return diffText(rel, was, String(input.content ?? ""));
    const edits = name === "MultiEdit" ? (Array.isArray(input.edits) ? input.edits : []) : name === "Edit" ? [input] : [];
    if (!was || !edits.length || was.subarray(0, 8192).includes(0)) return "";
    const before = was.toString("utf8");
    let after = before;
    for (const e of edits) {
      const o = String((e && e.old_string) ?? ""), n = String((e && e.new_string) ?? "");
      if (!o) return "";
      after = e.replace_all ? after.split(o).join(n) : after.replace(o, () => n);
    }
    return diffText(rel, before, after);
  } catch {
    return "";
  }
}

/**
 * @param {any} req claude 递过来的 {tool_name, input, tool_use_id}
 * @param {{sec: any, readOnly?: boolean, root: string, base?: string, platform?: string, ask?: Ask|null}} ctx
 *   sec：config.security 补过默认值；root：工作区根；base：这一趟的工作目录（相对路径按它解析）；
 *   ask：审批交回了主进程才有（摆卡等人点），没有就照规则拒
 * @returns {Promise<{behavior: "allow", updatedInput: any} | {behavior: "deny", message: string}>}
 */
async function decide(req, { sec, readOnly = false, root, base, platform = process.platform, ask = null }) {
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
      const abs = /** @type {{path: string}} */ (r).path;
      const rel = where(abs);
      const v = security.checkWrite(sec, rel);
      const why = await refuse(sec, v, "改文件", rel, true, ask, v.action === "ask" && ask ? writeDetail(name, input, abs, rel) : "");
      return why ? deny(why) : allow();
    }
    if (name in SHELLS) {
      const cmd = String(input.command || "");
      if (!cmd.trim()) return deny("command 是空的，没有执行。");
      const v = security.checkCommand(sec, cmd, /** @type {NodeJS.Platform} */ (SHELLS[name] || platform));
      const why = await refuse(sec, v, "命令", cmd, gated, ask);
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

module.exports = { TOOL, DEF, decide, cardAsk, _internals: { globRoot, READS, WRITES, SHELLS, HARMLESS, wayOut, writeDetail } };
