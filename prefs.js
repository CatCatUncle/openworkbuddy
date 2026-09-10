"use strict";
/**
 * 按账号存的个人偏好。
 *
 * 起因是一条很具体的抱怨：桌面上那只宠物，普通成员点一下开关，服务端回「这块是服务器级设置，
 * 归平台管理员管」。底层引擎（内置 / 本机 Claude Code / 本机 Codex）也一样，界面上只显示四个字
 * ——「切换失败」。这两样都不该归管理员：一只宠物出不出现，跟谁掏 API 的钱、谁担安全的风险，
 * 半点关系都没有。
 *
 * 于是把设置分成两层，判据是**改了影响谁**：
 *
 *   影响整台服务器（留给平台管理员）：API Key 与模型清单、MCP、插件、安全档位与 shell/联网策略、
 *     全局工作目录、备份、IM 机器人凭证、自进化/评测、席位与组织、agent 的步数与超时上限、
 *     助理形象与人设、引擎的可执行文件路径。这些一个人改，所有人的账单、权限、身份跟着变。
 *   只影响他自己（落在这儿，一人一份）：底层引擎、思考档位、上次选的模型与「新对话沿用它」、
 *     桌面宠物的那些开关、全局快捷键。
 *
 * 存成一人一个 JSON（data/prefs/<账号>.json）而不是塞进 users.json：偏好会被高频写
 * （切个引擎、拖个透明度滑块都写一次），跟账号密码摆在同一个文件里，任何一次写坏都是登录出事。
 *
 * 运行期怎么生效：走 AsyncLocalStorage，跟 tools.js 里的工作目录/策略是同一套路子。
 * 没有请求上下文的地方（定时任务、IM 消息、命令行 wb）取不到当前账号，一律回落到 config.json
 * ——也就是今天的行为，一个字节不差。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { dataPath } = require("./paths");

// WB_DATA_DIR 跟 account.js / org.js 同一个口子：跑测试时指到临时目录，免得动到真偏好
const DATA_DIR = process.env.WB_DATA_DIR || dataPath("data");

const store = new AsyncLocalStorage();

/** 把这条请求整条异步链绑到调用者的个人偏好上 */
function withPrefs(p, fn) {
  return p ? store.run(p, fn) : fn();
}
/** 当前请求的个人偏好；没有请求上下文（定时任务 / IM / CLI）时是 null */
function current() {
  return store.getStore() || null;
}

/**
 * 文件名。
 *
 * 登录名允许中文和各种符号，直接当文件名会出三种事：跨平台非法字符、大小写不敏感的盘上撞车、
 * 以及 ../ 逃逸。所以「可读前缀 + 全名哈希」：前缀只为人肉排查方便，唯一性由后面 10 位哈希保证。
 */
function keyOf(user) {
  const name = typeof user === "string" ? user : (user && user.username) || "";
  if (!name) return "";
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const h = crypto.createHash("sha256").update(name).digest("hex").slice(0, 10);
  return (slug ? slug + "-" : "") + h;
}
function fileOf(user) {
  const k = keyOf(user);
  return k ? path.join(DATA_DIR, "prefs", k + ".json") : "";
}

/**
 * 读。
 *
 * 内存里留一份缓存，但**带 mtime 校验**：这个文件除了本进程还有别人会写——命令行 `wb` 是另一个
 * 进程，多开的窗口也是。只按「读过一次就不再看盘」缓存的话，另一边改完这边永远看不见，
 * 用户体感是「设置没保存」。校验一次 statSync 的代价远小于一次误判。
 */
const cache = new Map(); // key -> { mtimeMs, size, data }
function read(user) {
  const file = fileOf(user);
  if (!file) return {};
  let st = null;
  try { st = fs.statSync(file); } catch { cache.delete(keyOf(user)); return {}; }
  const hit = cache.get(keyOf(user));
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { data = {}; }
  cache.set(keyOf(user), { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

/** 写：只合并传进来的那几项，没提到的原样留着 */
function write(user, patch) {
  const file = fileOf(user);
  if (!file) return {};
  const next = merge(read(user), patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  cache.delete(keyOf(user));
  return next;
}
/** 只往下钻一层：偏好里嵌套最深的就是 agent.engine_options.<id>.model */
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(out[k] && typeof out[k] === "object" ? out[k] : {}, v) : v;
  }
  return out;
}

/**
 * 「个人」到底包含哪几个字段——这张表是唯一的真源。
 *
 * platformGuard 靠它判一个 POST /api/settings 是不是「只动了自己的东西」，
 * /api/settings 的处理器靠它把请求体拆成两半。两处共用一张表，才不会出现
 * 「闸放行了、处理器没接、于是静默不生效」这种最难查的岔子。
 *
 * 特地不收的：engine_options 里的 bin / permissionMode / sandbox / network / extraArgs。
 * bin 是「起哪个可执行文件」，在多人服务器上等于任意命令执行；后面四个是那个 CLI 的权限档，
 * 谁都能改的话，组织设置里那个 allow_shell=false 就成了摆设。
 */
const PERSONAL_ENGINE_OPTS = ["model", "thinking"];
function isPersonalPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (!keys.length) return false;
  for (const k of keys) {
    if (k === "pet" || k === "shortcuts") continue;
    if (k === "model_follow_last" || k === "last_picked_model") continue;
    if (k === "agent") {
      const a = body.agent;
      if (!a || typeof a !== "object") return false;
      for (const ak of Object.keys(a)) {
        if (ak === "engine" || ak === "thinking") continue;
        if (ak === "engine_options") {
          const eo = a.engine_options;
          if (!eo || typeof eo !== "object") return false;
          for (const id of Object.keys(eo)) {
            const v = eo[id];
            if (!v || typeof v !== "object") return false;
            // 空字符串是「清掉这一项」，也算写，一并要求在白名单里
            if (Object.keys(v).some((f) => !PERSONAL_ENGINE_OPTS.includes(f))) return false;
          }
          continue;
        }
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

/** 把 POST /api/settings 的请求体拆成「个人的」和「服务器级的」两半 */
function split(body) {
  const b = body && typeof body === "object" ? body : {};
  const personal = {};
  const rest = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "pet" || k === "shortcuts" || k === "model_follow_last" || k === "last_picked_model") { personal[k] = v; continue; }
    if (k === "agent" && v && typeof v === "object") {
      const pa = {};
      const ra = {};
      for (const [ak, av] of Object.entries(v)) {
        if (ak === "engine" || ak === "thinking") { pa[ak] = av; continue; }
        if (ak === "engine_options" && av && typeof av === "object") {
          const peo = {};
          const reo = {};
          for (const [id, opt] of Object.entries(av)) {
            if (!opt || typeof opt !== "object") { reo[id] = opt; continue; }
            const p = {};
            const r = {};
            for (const [f, fv] of Object.entries(opt)) (PERSONAL_ENGINE_OPTS.includes(f) ? p : r)[f] = fv;
            if (Object.keys(p).length) peo[id] = p;
            if (Object.keys(r).length) reo[id] = r;
          }
          if (Object.keys(peo).length) pa.engine_options = peo;
          if (Object.keys(reo).length) ra.engine_options = reo;
          continue;
        }
        ra[ak] = av;
      }
      if (Object.keys(pa).length) personal.agent = pa;
      if (Object.keys(ra).length) rest.agent = ra;
      continue;
    }
    rest[k] = v;
  }
  return { personal, rest };
}

/**
 * 运行期取值：个人偏好压在 config 上面。
 *
 * 取不到当前账号就原样返回 config 的那一份——注意是**返回同一个对象**而不是复制，
 * 因为 config.agent 是会被就地改的（热更新），复制一份出去会让改动看起来「没生效」。
 */
function agentCfg(config) {
  const base = (config && config.agent) || {};
  const p = current();
  const a = p && p.agent;
  if (!a) return base;
  const out = { ...base };
  if (a.engine !== undefined) out.engine = a.engine;
  if (a.thinking !== undefined) out.thinking = a.thinking;
  if (a.engine_options) {
    out.engine_options = { ...(base.engine_options || {}) };
    for (const [id, v] of Object.entries(a.engine_options)) out.engine_options[id] = { ...(out.engine_options[id] || {}), ...v };
  }
  return out;
}
/** engines.resolve / agent.js 要的是整份 config，给它一个浅覆盖视图 */
function agentView(config) {
  const a = agentCfg(config);
  return a === (config && config.agent) ? config : { ...config, agent: a };
}
function petCfg(config) {
  const p = current();
  return { ...((config && config.pet) || {}), ...((p && p.pet) || {}) };
}
function shortcutsCfg(config) {
  const p = current();
  return (p && p.shortcuts) || (config && config.shortcuts) || {};
}
function modelCfg(config) {
  const p = current() || {};
  return {
    model_follow_last: p.model_follow_last !== undefined ? !!p.model_follow_last : !!(config && config.model_follow_last),
    last_picked_model: p.last_picked_model !== undefined ? p.last_picked_model : ((config && config.last_picked_model) || ""),
    // 助理页用哪个模型。它有自己的接口（POST /api/assist/model），不走 /api/settings，
    // 所以不在 isPersonalPatch 那张表里，但读的时候要一起按账号覆盖
    assist_model: p.assist_model !== undefined ? p.assist_model : ((config && config.assist_model) || ""),
  };
}

module.exports = {
  withPrefs, current, keyOf, fileOf, read, write, isPersonalPatch, split,
  agentCfg, agentView, petCfg, shortcutsCfg, modelCfg, PERSONAL_ENGINE_OPTS,
  _internals: { merge, cache },
};
