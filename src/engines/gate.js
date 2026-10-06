// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 外部引擎（本机 Claude Code / Codex）开跑前的那道闸。
 *
 * 护住的是「AI 只能用属主配好的型号」。外部引擎是另一个程序：自带命令行，自带换型号、
 * 换供应商的参数，内置引擎那套模型白名单管不到它里面。所以在拉起它之前，按属主的设置把口子堵上：
 *   · 组织关了命令行：外部引擎本身就是一条命令行，放它跑等于绕开组织的决定 → 拒绝，
 *     也不悄悄退回内置引擎（用户会以为自己在用选的那个）
 *   · 多人共用：默认关，平台属主在设置页逐个打开；单机桌面不受这条影响
 *   · 型号：必须是属主钉死的那个，或在属主给的候选列表里，成员自己挑的也一样；
 *     没钉就报错，不拿 CLI 自己配置里的默认型号顶上
 *   · 附加参数：能换型号、换供应商、换配置档的一律拒绝——型号只认设置页
 *
 * 全是纯函数，谁调都一样，测试不用起子进程。
 */

const path = require("path");

const WHERE = "设置 → 底层引擎";

/** @param {unknown} s */
function clean(s) {
  return typeof s === "string" ? s.trim() : "";
}

/**
 * 属主放行的型号：钉死的那个 + 给成员的候选列表。只读属主那份设置（config.json），
 * 成员的个人设置不算数——不然成员自己往列表里加一个就放行了。
 * @param {{model?: string, models?: unknown}} [owner]
 * @returns {string[]}
 */
function allowedModels(owner) {
  const o = owner || {};
  /** @type {string[]} */
  const out = [];
  const add = (/** @type {unknown} */ m) => { const s = clean(m); if (s && !out.includes(s)) out.push(s); };
  add(o.model);
  if (Array.isArray(o.models)) for (const m of o.models) add(m);
  return out;
}

/** -c / --config 的键：这些能换掉型号或整个供应商（连带它的地址和 Key） */
const CONFIG_MODEL_KEY = /^(model|model_provider|profile|oss_provider)$|^(model_providers|profiles)\./;

/**
 * 附加参数里第一个能换型号的那项；没有返回 ""。
 * 两种 CLI 都认的：--model / -m / --fallback-model（含 --model=x、-mx 连写）。
 * codex 另有 -c 覆盖配置和 --profile / --oss 换供应商；claude 的 --settings / --agents 里能带 model。
 * @param {unknown} args
 * @param {string} [engineId]
 * @returns {string}
 */
function modelArg(args, engineId = "") {
  if (!Array.isArray(args)) return "";
  const list = args.map((a) => String(a == null ? "" : a));
  for (let i = 0; i < list.length; i++) {
    const a = list[i].trim();
    if (/^--(model|fallback-model)(=|$)/.test(a)) return a;
    if (/^-m/.test(a) && !a.startsWith("--")) return a;
    if (engineId === "claude-code" && /^--(settings|agents)(=|$)/.test(a)) return a;
    if (engineId !== "claude-code") {
      if (/^--(profile|oss|local-provider)(=|$)/.test(a) || /^-p/.test(a)) return a;
      let kv = null;
      if (a === "-c" || a === "--config") kv = list[i + 1] == null ? "" : list[i + 1];
      else if (a.startsWith("--config=")) kv = a.slice("--config=".length);
      else if (/^-c./.test(a)) kv = a.slice(2);
      if (kv != null) {
        const key = String(kv).split("=")[0].trim().replace(/["']/g, "").replace(/\s*\.\s*/g, ".");
        if (CONFIG_MODEL_KEY.test(key)) return a.length > 2 && a !== "--config" ? a : `${a} ${kv}`;
      }
    }
  }
  return "";
}

/**
 * 沙箱可写目录只留工作区：数据根本身、包着数据根的目录、数据根下的 data/（配置、账号、个人设置都在那）
 * 一律剔掉。护的是「引擎里的命令改不动 OpenWorkBuddy 自己的配置和账号」。
 * @param {unknown} roots
 * @param {string} dataRoot
 * @returns {string[]}
 */
function safeRoots(roots, dataRoot) {
  if (!Array.isArray(roots)) return [];
  const home = dataRoot ? path.resolve(dataRoot) : "";
  const inside = (/** @type {string} */ p, /** @type {string} */ dir) => p === dir || p.startsWith(dir + path.sep);
  return roots
    .map((r) => clean(r))
    .filter(Boolean)
    .map((r) => path.resolve(r))
    .filter((r) => !home || !(inside(home, r) || inside(r, path.join(home, "data"))));
}

/**
 * @param {string} code
 * @param {string} message
 */
function refuse(code, message) {
  const e = /** @type {Error & {code?: string, engineGate?: boolean}} */ (new Error(message));
  e.code = code;
  e.engineGate = true;
  return e;
}

/**
 * 能不能开跑、用哪个型号。不行就抛带 code 的错，文案说清去哪改。
 * @param {object} o
 * @param {string} o.id                 引擎 id
 * @param {string} [o.label]            界面上的名字（报错里用）
 * @param {object} [o.owner]            属主那份 engine_options[id]（config.json 原样）
 * @param {object} [o.mine]             叠过个人设置之后的那份（成员自己挑的 model 在这）
 * @param {boolean} [o.shellOff]        组织关了命令行
 * @param {boolean} [o.multi]           多人共用
 * @returns {{model: string, allowed: string[]}}
 */
function admit({ id, label, owner, mine, shellOff = false, multi = false }) {
  const name = label || id;
  const own = owner || {};
  if (shellOff) throw refuse("shell_off", "本组织关了命令行，外部引擎自带命令行，所以也不能用。");
  if (multi && own.enabled !== true) throw refuse("engine_off", `多人共用时${name}默认关着，平台属主在 ${WHERE} 里打开后才能用。`);
  const bad = modelArg(own.extraArgs, id);
  if (bad) throw refuse("extra_model", `${name}的附加参数里有换型号的「${bad}」，型号只能在 ${WHERE} 里选。`);
  const allowed = allowedModels(own);
  const want = clean((mine || {}).model) || clean(own.model);
  if (!want) throw refuse("no_model", `先在 ${WHERE} 里给${name}指定型号，再开跑。`);
  if (!allowed.includes(want)) throw refuse("model_not_allowed", `型号「${want}」不在属主给${name}放行的列表里，去 ${WHERE} 换一个。`);
  return { model: want, allowed };
}

module.exports = { admit, allowedModels, modelArg, safeRoots, WHERE };
