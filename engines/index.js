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

const os = require("os");
const fs = require("fs");
const path = require("path");
const which = require("./which");

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
  which.forget(); // 刚装完就点检测的人，得当场看见结果
  const out = [];
  for (const b of BACKENDS) {
    let r;
    try { r = await b.detect(overrides[b.id] || undefined); }
    catch (e) { r = { id: b.id, installed: false, path: overrides[b.id] || b.bin, version: "", error: e.message }; }
    out.push({
      id: b.id, label: b.label, note: b.note, install: b.install,
      launchHeader: b.launchHeader, supportsResume: b.supportsResume,
      installed: !!r.installed, path: r.path, version: r.version || "",
      how: r.how || "", error: r.error || "",
      // 设置页要画「模型」候选和「思考/effort」下拉：候选和标签写在引擎自己身上
      models: b.models || [],
      thinkingLabel: b.thinkingLabel || "",
      // 用户在设置里给这个引擎填过什么（路径 / 模型 / 思考档），前端要能回显出来
      options: {
        bin: (overrides[b.id] || {}).bin || "",
        model: (overrides[b.id] || {}).model || "",
        thinking: (overrides[b.id] || {}).thinking || "", // 空 = 跟随全局档位
      },
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

/**
 * 真连一次。
 *
 * 为什么光有 detect 不够：`--version` 只证明**文件在**，证明不了**能用**。
 * 装了没登录、订阅过期、被限流——这三种在设置页上长得和"已装 ✓"一模一样，
 * 用户点了切换，然后每一个任务都在原地报错，还以为是本项目坏了。
 * 所以「一键连接」按的这一下必须真跑一句话过去，把答案拿回来。
 *
 * 成本：一句 "回复 ok 两个字"，几十个 token，走的是用户自己的订阅，不碰 API Key。
 * 跑在系统临时目录里，不往用户工作区留任何东西。
 *
 * @returns {Promise<{ok:boolean, ms:number, engine:string, path:string, version:string,
 *                    reply:string, model:string, why:string, hint:string}>}
 */
async function testConnect(id, opts = {}, timeoutMs = 90000) {
  const backend = get(id);
  if (!backend) throw new Error(`「${id}」不是一个本机引擎`);
  const t0 = Date.now();
  const det = await backend.detect(opts);
  if (!det.installed) {
    return { ok: false, ms: Date.now() - t0, engine: id, path: det.path || "", version: "",
             reply: "", model: "", why: det.error || `本机没找到 ${backend.bin}`, hint: backend.install };
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "owb-engine-test-"));
  let model = "";
  try {
    const r = await backend.run({
      prompt: "回复 ok 两个字，不要做别的任何事，不要写文件。",
      cwd,
      emit: (ev) => { if (ev && ev.type === "status" && ev.model) model = ev.model; },
      deadline: Date.now() + timeoutMs,
      maxTurns: 1,
      systemPrompt: "这是一次连通性自检，直接回两个字就行。",
      ...opts,
    });
    return {
      ok: true, ms: Date.now() - t0, engine: id, path: det.path, version: det.version,
      reply: String(r.finalText || "").trim().slice(0, 120), model: opts.model || model, why: "", hint: "",
    };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 400);
    // 登录/限流这类原因，各引擎的 explain() 已经翻成人话了，这里只补一句「接下来干什么」
    const hint = /没登录|登录/.test(why) ? (backend.login || backend.install || "")
      : /限流|额度/.test(why) ? "等订阅窗口重置后再点一次"
      : /找不到|没有/.test(why) ? backend.install
      : "";
    return { ok: false, ms: Date.now() - t0, engine: id, path: det.path, version: det.version, reply: "", model: "", why, hint };
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { list, get, detectAll, resolve, testConnect, which, BUILTIN, BACKENDS };
