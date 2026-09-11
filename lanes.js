"use strict";
/**
 * 两条工作线（lane）——「这次的活儿在哪条线上干」。
 *
 * 同一个人一天里本来就在两种完全不同的活儿之间来回切：
 *
 *   办公：做表、写稿、出图、发消息。鼠标流，产出是能直接发出去的文件。
 *         跑在这台机器的桌面办公 agent 上（网页端 / 桌面端那个进程）。
 *   工程：写代码、跑脚本、查日志。键盘流，产出是代码和命令的结果。
 *         跑在本机的 OpenWorkBuddy 命令行（wb）里——终端里起的任务都归这条线，
 *         手机上点开就能看见它此刻在干什么、插一句话改需求。
 *
 * 注意这两条线分的是**在哪儿干、干哪种活儿**，不是「用哪个模型/引擎」。
 * 引擎（内置循环 / 本机 Claude Code / Codex）是另一件正交的事，用户在设置里选一次，
 * 两条线都照着它跑。早先版本让工作线顺手把引擎也换掉，是把两件事捆在一起了：
 * 那样一来「切到工程线」会连带把别人配的模型也换掉，而用户要的只是换一批活儿。
 *
 * 三条红线：
 *   1. **没说要哪条线时，行为一个字节不差。** 定时任务 / IM / 老版本前端不传 lane，
 *      一路上不许因为多了这个字段而改变任何取值。
 *   2. **只如实记，不替人编。** 会话上没记过 lane 就是没记过（老会话都是这样），
 *      该把它显示在哪条线下是读它的那个前端的事，服务端不替他填。
 *   3. **底层 CLI 的会话 id 认引擎。** claude 的 resume id 喂给 codex 只会当场炸，
 *      所以按引擎分开记——这条跟工作线无关，是引擎自己的账。
 */

const LANES = [
  {
    id: "office",
    name: "办公",
    short: "办公",
    hint: "做表、写稿、出图、发消息——鼠标流",
    detail: "本机的桌面办公 agent：专家团、技能库、记忆、生图生视频都在这条线上",
  },
  {
    id: "cli",
    name: "工程",
    short: "工程",
    hint: "写代码、跑脚本、查日志——键盘流",
    detail: "本机 OpenWorkBuddy 命令行（wb）那条线：终端里起的任务都归这儿，手机上点开就能接管、插话",
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
 * 没记过 lane 的会话归哪条线：办公。
 *
 * 工作线是这一版才有的字段，在它之前的会话一条都没记过。这些老会话绝大多数是从网页
 * 起的（终端里 wb 起的任务当时也不多），全放办公线，历史看起来就跟升级前一样。
 * 工程线的空态会写清楚「在终端里 wb 起的任务会出现在这儿」，不至于让人以为功能坏了。
 */
const DEFAULT_LANE = "office";

/** 一条会话属于哪条线。会话上记了就认它，没记过归办公 */
function laneOf(sess) {
  return normalize(sess && sess.lane) || DEFAULT_LANE;
}

/**
 * 取这条会话在某个引擎下的续跑 id。
 *
 * 按引擎分开记是必须的：claude -p 的 resume id 拿去喂 codex exec，那边只会当场报「找不到会话」，
 * 而用户看到的是「换个引擎就报错」。老会话只有一对扁平字段（engine_session + engine），
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
  LANES, IDS, DEFAULT_LANE,
  normalize, get, laneOf,
  engineSessionFor, rememberEngineSession,
};
