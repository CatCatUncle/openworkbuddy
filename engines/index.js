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

/**
 * 探测本机装了哪些底层 CLI。只跑 --version，不花任何额度，也不碰用户的会话。
 *
 * 有缓存，因为这事不便宜也不常变：一次探测要给每个 CLI 起一个 --version 子进程
 * （本机实测冷启 322ms、热的 ~120ms），而 /api/engines、/api/thinking、设置页、
 * 引导页、命令行每次都在调它——「装没装 claude」这种事没必要每次都现问一遍。
 * 用户点「重新检测本机」走 force：刚装完的人必须当场看见，那条路才清 which 的缓存。
 * 缓存的是 Promise，所以同时来的几个请求只会真探一次。
 */
const DETECT_TTL = 60000;
let detectCache = null; // { key, at, promise }

async function detectAll(overrides = {}, { force = false } = {}) {
  const key = JSON.stringify(overrides || {});
  if (!force && detectCache && detectCache.key === key && Date.now() - detectCache.at < DETECT_TTL) {
    return detectCache.promise;
  }
  if (force) which.forget(); // 刚装完就点检测的人，得当场看见结果
  const promise = detectAllUncached(overrides).catch((e) => {
    if (detectCache && detectCache.promise === promise) detectCache = null; // 失败不许被缓存住一分钟
    throw e;
  });
  detectCache = { key, at: Date.now(), promise };
  return promise;
}

/** 缓存失效时真正去探。改这里记得想一下 detectAll 的缓存键够不够用 */
async function detectAllUncached(overrides = {}) {
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

/**
 * 借正在用的那个本机 CLI 问一句话——「动脑不动手」的活（把目标拆成验收标准、对着标准判分）。
 *
 * 为什么非要有这条路：用户切到本机引擎，图的就是不花 API 的钱。可 Goal 模式的拆解和验收
 * 原来一直偷偷走 API 模型——没配 Key 的人这两步永远静默失败，目标卡永远卡在 0/N，
 * 从用户那边看就是「Goal 模式根本没做」。同一个订阅已经付过钱了，这两句就该问它。
 *
 * 一次性问答，不接管任务会话（不传 resumeId），也不在用户的工作目录里落脚：
 * 开个临时目录跑，问完就删，绝不让「问一句」把成果文件夹弄脏。
 */
async function ask({ id, opts = {}, system, prompt, timeoutMs = 60000, signal }) {
  const backend = get(id);
  if (!backend) throw new Error(`「${id}」不是一个本机引擎`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ask-"));
  try {
    const r = await backend.run({
      ...opts,
      prompt,
      cwd,
      systemPrompt: system,
      deadline: Date.now() + timeoutMs,
      maxTurns: 1, // 只要一句回答，不许它在临时目录里开工
      stopSignal: signal,
      emit: () => {},
    });
    return String((r && r.finalText) || "");
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { list, get, detectAll, resolve, testConnect, ask, which, BUILTIN, BACKENDS };
