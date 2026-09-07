"use strict";
/**
 * 底层引擎注册表 —— 决定「这次任务由谁来跑」。
 *
 * OpenWorkBuddy 原来只有一条路：自己的 agent 循环 + 用户配的 API Key。
 * 门槛卡在最前面一步——想试一下，先去买 token。
 * 但很多人电脑里本来就装着 Claude Code / Codex，订阅早就付过了。
 * 这层就是为了让那份订阅直接变成本项目的动力：装了就能选，选了就不再花 API 的钱。
 *
 * 一条红线：**引擎不许静默降级。**
 * 用户在设置里选了「本机 Codex」，而 codex 没装或没登录，那就当场报错说清楚，
 * 绝不偷偷退回内置引擎拿 API Key 去跑——那等于用户以为免费，账单却在涨。
 * （同一条规矩在模型选择上已经执行了，这里保持一致。）
 */

const BACKENDS = [require("./claude-code"), require("./codex")];

/** 内置引擎不是插件，是本项目自己的 agent 循环，单独列一条方便前端统一渲染 */
const BUILTIN = {
  id: "builtin",
  label: "内置引擎",
  bin: null,
  launchHeader: "OpenWorkBuddy 自己的 agent 循环",
  note: "用你在「模型」里配置的 API Key 跑，功能最全（专家团、技能库、记忆、自进化都在这条路上）",
  install: "",
  supportsResume: true,
};

function list() {
  return [BUILTIN, ...BACKENDS];
}

function get(id) {
  if (!id || id === "builtin") return null; // null = 走内置那条老路
  return BACKENDS.find((b) => b.id === id) || undefined; // undefined = 根本没这个引擎
}

/** 探测本机装了哪些底层 CLI。只跑 --version，不花任何额度，也不碰用户的会话。 */
async function detectAll(overrides = {}) {
  const out = [];
  for (const b of BACKENDS) {
    let r;
    try { r = await b.detect(overrides[b.id] || undefined); }
    catch (e) { r = { id: b.id, installed: false, path: overrides[b.id] || b.bin, version: "", error: e.message }; }
    out.push({
      id: b.id, label: b.label, note: b.note, install: b.install,
      launchHeader: b.launchHeader, supportsResume: b.supportsResume,
      installed: !!r.installed, path: r.path, version: r.version || "",
    });
  }
  return out;
}

/**
 * 按配置解析出这次该用哪个引擎。
 * @returns {{backend:object|null, opts:object}} backend 为 null 表示内置引擎
 * @throws  配置了一个不存在的引擎 id 时抛错（写错名字就该当场知道）
 */
function resolve(config) {
  const a = (config && config.agent) || {};
  const id = String(a.engine || "builtin").trim() || "builtin";
  const backend = get(id);
  if (backend === undefined) {
    throw new Error(`设置里的底层引擎「${id}」不存在。可选：${list().map((b) => b.id).join(" / ")}`);
  }
  const per = (a.engine_options && a.engine_options[id]) || {};
  return { backend, opts: per };
}

module.exports = { list, get, detectAll, resolve, BUILTIN, BACKENDS };
