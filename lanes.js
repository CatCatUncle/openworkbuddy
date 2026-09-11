"use strict";
/**
 * 两条工作线（lane）——「这次的活儿交给谁的手」。
 *
 * 同一个 agent 平台上，用户其实一直在两种完全不同的活儿之间来回切：
 *
 *   命令行模式：写代码、跑脚本、查日志。键盘流，产出是代码和命令的结果。
 *               本机装着的 Claude Code / Codex 来干最合适——订阅早付过了，不再花 API 的钱。
 *   办公模式：  做表、写稿、出图、发消息。鼠标流，产出是能直接发出去的文件。
 *               本项目自己的循环来干最合适——专家团、技能库、记忆、生图生视频全在这条路上。
 *
 * 以前这两件事共用「设置里选的那一个引擎」：选了本机 Codex，办公模式那些工具就整批消失；
 * 想出张图得先回设置页把引擎切回内置，出完再切回去。一天切八回，谁都会切忘。
 * 所以把它从「一个全局开关」改成「两条并排的线」——顶上两个标签，各自记各自的会话，
 * 共用同一份文件和工作目录，切过去不用改任何设置。
 *
 * 三条红线：
 *   1. **没说要哪条线时，行为一个字节不差。** viewFor(undefined, config) 原样返回 config，
 *      定时任务 / IM / 老版本前端走的还是今天这条路。
 *   2. **不静默降级。** 命令行模式解析到一个没装的 CLI，就让 engines 那层当场报错，
 *      绝不偷偷退回内置引擎拿用户的 API Key 去跑（那是「以为免费、账单在涨」）。
 *   3. **底层 CLI 的会话 id 认引擎。** claude 的 resume id 喂给 codex 只会当场炸，
 *      而切线之后这事从「偶尔」变成「每天」，所以按引擎分开记。
 */

/** 命令行模式没挑过具体哪个 CLI 时的兜底。装没装由 engines 那层当场判，这里只负责给个名字 */
const CLI_FALLBACK = "claude-code";

/**
 * 两条线的门面信息。前端拿它画顶上的标签，改文案只改这儿一处。
 * engine 字段是「这条线钉死用哪个引擎」，空串表示「看用户挑的那个 CLI」。
 */
const LANES = [
  {
    id: "office",
    name: "办公模式",
    short: "办公",
    hint: "做表、写稿、出图、发消息——鼠标流",
    detail: "本项目自己的桌面办公 agent：专家团、技能库、记忆、生图生视频都在这条线上，用你配的模型 API 跑",
    engine: "builtin",
  },
  {
    id: "cli",
    name: "命令行模式",
    short: "命令行",
    hint: "写代码、跑脚本、查日志——键盘流",
    detail: "交给本机装的 Claude Code / Codex 跑，用的是你已经付过的订阅，不再花 API 的钱",
    engine: "",
  },
];

const IDS = LANES.map((l) => l.id);

/** 认不出来的一律返回空串，交给上层决定回落到哪——空串在这个模块里就是「没说」 */
function normalize(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return IDS.includes(s) ? s : "";
}

function get(id) {
  const k = normalize(id);
  return k ? LANES.find((l) => l.id === k) : null;
}

/**
 * 老会话、老配置该落在哪条线上。
 *
 * 判据就一条：今天这份配置本来会用哪个引擎跑。选了本机 CLI 的人，他所有的老对话
 * 本来就都是 CLI 跑出来的，那它们属于命令行模式；用内置引擎的人属于办公模式。
 * 这样升级上来的历史不会整批跑到另一个标签下去「消失」。
 */
function defaultLane(agentCfg) {
  const cur = String(((agentCfg || {}).engine) || "builtin").trim() || "builtin";
  return cur === "builtin" ? "office" : "cli";
}

/** 一条会话属于哪条线。会话上记了就认它，没记过按配置回落 */
function laneOf(sess, agentCfg) {
  return normalize(sess && sess.lane) || defaultLane(agentCfg);
}

/**
 * 这条线该用哪个引擎 id。
 *
 * 办公模式钉死内置。命令行模式优先用用户为这条线挑的那个（agent.cli_engine，个人偏好），
 * 没挑过就沿用他在设置页选的那个 CLI；连那个都是内置（= 从来没挑过 CLI），才给兜底名字。
 * 返回的名字不保证装过——装没装是 engines.detectAll / backend.run 的事，在那儿报错才说得清。
 */
function engineIdFor(laneId, agentCfg) {
  const a = agentCfg || {};
  const cur = String(a.engine || "builtin").trim() || "builtin";
  const lane = normalize(laneId);
  if (!lane) return cur;
  const fixed = get(lane).engine;
  if (fixed) return fixed;
  const picked = String(a.cli_engine || "").trim();
  if (picked) return picked;
  return cur !== "builtin" ? cur : CLI_FALLBACK;
}

/**
 * 给 engines.resolve 用的 config 视图：只把 agent.engine 按这条线换掉，别的一律不动。
 * 没说要哪条线（定时任务 / IM / 老前端）就**原样返回同一个对象**——不是复制，
 * 因为 config.agent 会被就地热更新，复制一份出去会让改动看起来「没生效」（prefs.agentCfg 同理）。
 */
function viewFor(laneId, config) {
  const lane = normalize(laneId);
  if (!lane) return config;
  const a = (config && config.agent) || {};
  const id = engineIdFor(lane, a);
  if (id === (String(a.engine || "builtin").trim() || "builtin")) return config;
  return { ...config, agent: { ...a, engine: id } };
}

/**
 * 取这条会话在某个引擎下的续跑 id。
 *
 * 按引擎分开记是必须的：claude -p 的 resume id 拿去喂 codex exec，那边只会当场报「找不到会话」，
 * 而用户看到的是「换个标签就报错」。老会话只有一对扁平字段（engine_session + engine），
 * engine 为空的是更早以前升级上来的记录，那时候机器上只可能有一个引擎在跑，认它。
 */
function engineSessionFor(sess, engineId) {
  const id = String(engineId || "").trim();
  if (!sess || !id || id === "builtin") return null;
  const m = sess.engine_sessions;
  if (m && typeof m === "object" && !Array.isArray(m) && m[id]) return String(m[id]);
  const flat = sess.engine_session;
  if (flat && (!sess.engine || sess.engine === id)) return String(flat);
  return null;
}

/** 记下某个引擎给的续跑 id。扁平字段继续写：命令行 wb 和桌面端的旧代码读的是它 */
function rememberEngineSession(sess, engineId, sid) {
  const id = String(engineId || "").trim();
  const v = String(sid || "").trim();
  if (!sess || !id || !v || id === "builtin") return sess;
  if (!sess.engine_sessions || typeof sess.engine_sessions !== "object" || Array.isArray(sess.engine_sessions)) {
    sess.engine_sessions = {};
  }
  sess.engine_sessions[id] = v;
  sess.engine_session = v;
  sess.engine = id;
  return sess;
}

module.exports = {
  LANES, IDS, CLI_FALLBACK,
  normalize, get, defaultLane, laneOf, engineIdFor, viewFor,
  engineSessionFor, rememberEngineSession,
};
