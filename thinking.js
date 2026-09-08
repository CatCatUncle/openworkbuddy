"use strict";
/**
 * 思考模式开关 —— 「有思考模式的模型可以支持关闭思考模式」。
 *
 * 为什么值得单开一个文件：关思考这件事，各家参数名没有一个是通的。
 * OpenRouter 叫 reasoning、OpenAI 叫 reasoning_effort、通义叫 enable_thinking、
 * 智谱叫 thinking.type、Anthropic 是「不发这个字段就等于关」、本机 CLI 又是命令行参数。
 * 散在各处写 if 迟早写歪，所以集中成一张表，配一份「这次到底会发什么」的自述，
 * 设置页直接把这句话显示给用户看。
 *
 * 三条规矩：
 *
 * 1）**默认 auto = 一个字段都不发**。老用户的行为一个字节都不变，
 *    只有用户自己去点了「关/低/中/高」，才会开始发厂商参数。
 *
 * 2）**认不出来的接口就说认不出来**，不瞎发。乱发一个参数换来的是 400，
 *    用户的任务当场挂掉，比"开关没生效"糟得多。认不出时如实告诉用户
 *    「这个接口我不认识，可以自己在模型条目的 extra_body 里填」。
 *
 * 3）**关不到零就别谎称关到零**。OpenAI 的推理模型最低只有 minimal，
 *    deepseek-reasoner 压根没有关闭开关（要不思考得换 deepseek-chat）。
 *    这些都在 note 里直说，不许拿一句"已关闭"糊过去。
 *
 * extra_body 的优先级高于这里推导出来的参数：它是老资格的逃生口，
 * 用户手填的东西不该被一个下拉框覆盖掉；万一这张表哪家猜错了，
 * 用户也能自己纠正。
 */

/** 用户能选的档位。auto 排第一 = 默认 */
const LEVELS = ["auto", "off", "low", "medium", "high"];
const LEVEL_LABEL = { auto: "跟随模型默认", off: "关闭思考", low: "低", medium: "中", high: "高" };

/** Anthropic 的思考预算（token）。max_tokens 是 32000，预算必须小于它 */
const CLAUDE_BUDGET = { low: 4000, medium: 10000, high: 24000 };
/** 通义的思考预算 */
const QWEN_BUDGET = { low: 1024, medium: 4096, high: 16384 };

function norm(level) {
  const s = String(level || "").trim().toLowerCase();
  return LEVELS.includes(s) ? s : "auto";
}

/** 这一档是不是「要它想」 */
const isOn = (lv) => lv === "low" || lv === "medium" || lv === "high";

/**
 * Claude 里哪些型号真有 extended thinking。老型号（claude-3-5 及以前）发 thinking 字段会被 400，
 * 所以只在认得出的型号上开。关闭那一档不受影响 —— 不发字段本来就等于关。
 */
const CLAUDE_THINKS = /claude-(?:3[-.]7|4|opus-[45]|sonnet-[45]|haiku-4)|-thinking\b/i;

/**
 * 一条模型配置 + 一个档位 → 这次请求要额外带的参数。
 *
 * @param {object} entry  config.models 里的那一条（provider / base_url / model / extra_body）
 * @param {string} level  auto | off | low | medium | high
 * @returns {{level:string, vendor:string, supported:boolean, params:object, note:string}}
 *   supported=false 表示这个开关对它不生效，note 里写清为什么 —— 界面要如实显示，不许装作生效了
 */
function planFor(entry, level) {
  const lv = norm(level);
  const e = entry || {};
  const model = String(e.model || "");
  const url = String(e.base_url || "");
  const anthropic = e.provider === "anthropic";
  const none = (vendor, note) => ({ level: lv, vendor, supported: false, params: {}, note: note || "" });

  if (lv === "auto") return { level: lv, vendor: "", supported: true, params: {}, note: "不发任何思考参数，模型怎么默认就怎么来。" };

  // ── Anthropic 原生接口：不发 thinking 字段 = 关闭，这是接口本身的语义，最省事也最安全
  if (anthropic) {
    if (!isOn(lv)) return { level: lv, vendor: "anthropic", supported: true, params: {}, note: "不发 thinking 字段，Claude 就不会进入扩展思考。" };
    if (!CLAUDE_THINKS.test(model)) return none("anthropic", `${model} 不是带扩展思考的 Claude 型号，开着也没有思考可给。`);
    return {
      level: lv, vendor: "anthropic", supported: true,
      params: { thinking: { type: "enabled", budget_tokens: CLAUDE_BUDGET[lv] } },
      note: `thinking.budget_tokens=${CLAUDE_BUDGET[lv]}`,
    };
  }

  // ── 以下都是 OpenAI 兼容接口。先按网关认，再按模型名认 ——
  //    很多人挂的是自建聚合网关（base_url 看不出厂商），这时候模型名才是真话。
  if (/openrouter\.ai/i.test(url)) {
    if (!isOn(lv)) return { level: lv, vendor: "openrouter", supported: true, params: { reasoning: { enabled: false } }, note: "reasoning.enabled=false" };
    return { level: lv, vendor: "openrouter", supported: true, params: { reasoning: { effort: lv } }, note: `reasoning.effort=${lv}` };
  }

  if (/\bgpt-5|^o[134]\b|^o[134]-/i.test(model)) {
    // OpenAI 的推理模型没有"完全不想"这一档，最低是 minimal。这里如实说，不写"已关闭"
    const eff = isOn(lv) ? lv : "minimal";
    return {
      level: lv, vendor: "openai", supported: true, params: { reasoning_effort: eff },
      note: isOn(lv) ? `reasoning_effort=${eff}` : "reasoning_effort=minimal（OpenAI 的推理模型关不到零，minimal 是最低档）",
    };
  }

  if (/qwen|qwq/i.test(model)) {
    if (!isOn(lv)) return { level: lv, vendor: "qwen", supported: true, params: { enable_thinking: false }, note: "enable_thinking=false" };
    return {
      level: lv, vendor: "qwen", supported: true,
      params: { enable_thinking: true, thinking_budget: QWEN_BUDGET[lv] },
      note: `enable_thinking=true, thinking_budget=${QWEN_BUDGET[lv]}`,
    };
  }

  if (/glm|chatglm/i.test(model)) {
    const type = isOn(lv) ? "enabled" : "disabled";
    return { level: lv, vendor: "zhipu", supported: true, params: { thinking: { type } }, note: `thinking.type=${type}` };
  }

  if (/deepseek/i.test(model)) {
    // 这一家是两个型号两条命，不是一个开关：reasoner 永远思考，chat 永远不思考
    if (/reasoner|-r1\b|\br1\b/i.test(model)) return none("deepseek", "deepseek-reasoner 没有关闭思考的参数。要不思考，把模型换成 deepseek-chat。");
    return none("deepseek", `${model} 本来就不是思考模型，没有可关的东西。`);
  }

  return none("", "认不出这个接口/模型的思考参数，没敢乱发（发错一个参数会直接 400，任务当场挂）。要用的话，在这条模型的 extra_body 里手填。");
}

/**
 * 本机引擎那一路。两个 CLI 的开关长得完全不一样，而且都有坑：
 *
 * · claude：`--thinking enabled|adaptive|disabled`，但这是个**隐藏选项**，而且
 *   claude 对不认识的选项是**静默忽略**的（实测 `claude --nosuchflag x --version` 照样退出 0）。
 *   所以老版本上直接发等于什么也没发，必须先探一下支不支持（见 engines/claude-code.js 的 probeThinking）。
 * · codex：`-c model_reasoning_effort="..."`，取值取自 0.146.0 二进制里的枚举
 *   （none/minimal/low/medium/high/xhigh/max/ultra），关掉就是 none。
 *
 * @returns {{args:string[], env:object, supported:boolean, note:string}}
 */
function planForEngine(engineId, level, caps = {}) {
  const lv = norm(level);
  if (lv === "auto") return { args: [], env: {}, supported: true, note: "跟随 CLI 自己的默认设置。" };

  if (engineId === "claude-code") {
    if (caps.thinkingFlag === false) {
      return { args: [], env: {}, supported: false, note: "你装的这版 claude 没有 --thinking 开关（不认识的参数它会静默吞掉，发了也没用）。升级 claude 后即可。" };
    }
    const mode = isOn(lv) ? "enabled" : "disabled";
    // 强度档 claude 这边只有开/关，没有低中高；如实说明，不假装分了档
    return {
      args: ["--thinking", mode], env: {}, supported: true,
      note: isOn(lv) ? "--thinking enabled（claude 只有开/关，不分强度，强度由它自己按题目定）" : "--thinking disabled",
    };
  }

  if (engineId === "codex") {
    const eff = isOn(lv) ? lv : "none";
    return { args: ["-c", `model_reasoning_effort="${eff}"`], env: {}, supported: true, note: `model_reasoning_effort=${eff}` };
  }

  return { args: [], env: {}, supported: false, note: "" };
}

module.exports = { LEVELS, LEVEL_LABEL, norm, planFor, planForEngine, CLAUDE_BUDGET, QWEN_BUDGET };
