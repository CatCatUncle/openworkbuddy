"use strict";
/**
 * 开工之前那道闸：这活儿，该先照哪个技能做。
 *
 * 用户装了技能，是指望 agent 干那类活的时候会照着做——写公众号推文就按他那套排版规矩来，
 * 做网页就按 html-page 的骨架来。可技能在提示词里只是一份「名字 + 80 字简介」的清单，
 * 加载与否全看模型那一步想不想得起来。现场看到的样子是这样的：
 *
 *     用户：帮我写一篇公众号推文，主题是……            ← 他装着 wechat-article，就是为这个装的
 *     agent：好的，我来写。（直接 write_file，从没 use_skill）
 *     用户：你怎么不用我的技能？
 *     agent：抱歉，这就加载。（这一篇已经按它自己的路子写完了）
 *
 * 这不是模型笨，是清单太长、简介太短、而「先加载再动手」只是提示词里的一句建议。
 * 建议在第一步就漏，何况用户还常常换着说法：「用那个公众号技能」「按我之前那套来」。
 *
 * 两层，先便宜的：
 *   - **用户点了名，一分钱不花，直接加载。** 「/wechat-article」「用 wechat-article 写」——
 *     这是提示词里早就承诺过的语法（「/某技能名」表示要求使用该技能），只是以前
 *     靠模型自觉，现在改成机械地做。
 *   - 没点名，才问判断模型一道单选：这活儿该先照哪个技能做，选项是技能名加一个「都不对口」。
 *     它挑了一个、并且确定度到 70%，就替模型把那份技能加载好；挑「都不对口」或拿不准，一律照旧。
 *
 * 四条边界：
 *   - **只会多加载一份技能，不会少加载**。加载多了的代价是几千 token；漏加载的代价是整篇白做。
 *   - **已经加载过就不再问**——一轮里问一次，续跑的时候技能还在（挂在系统提示词里）。
 *   - **只在顶层任务问**，专家子任务不问：它接的是父任务派下来的小活，技能该由父任务挑。
 *   - **说不准、答不上、问不成，一律照旧**：老行为是「模型自己想得起来就用」，闸坏了就退回这儿。
 *
 * 这儿一个字的网络都不发，发请求那一下在 agent.js。分开是为了这套判据能当纯函数测。
 */

const so = require("./systemone");

/** 那道题的名字。答案按名字取回来，两边必须是同一个常量。 */
const PICK_KEY = "这活儿该先照哪个技能做";
/** 「一个都不对口」那个选项。 */
const NONE = "都不对口";
/** 照做的门槛：通用的 0.7。挑错了多加载一份技能而已，不必像拦问那样按 0.8 收。 */
const PICK_MIN = 0.7;

/** 摆给它看的现场，各段的上限。 */
const MSG_CHARS = 600;
const BRIEF_CHARS = 80;
/** 选项最多摆这么多个技能：再多，单选题本身就成了大海捞针。按清单顺序取前几个。 */
const SKILL_MAX = 24;

const cut = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const brief = (d) => { const t = String(d || "").replace(/\s+/g, " ").trim(); return t.length > BRIEF_CHARS ? t.slice(0, BRIEF_CHARS) + "…" : t; };
const names = (skills) => (Array.isArray(skills) ? skills : []).map((s) => cut(s && s.name, 80)).filter(Boolean);

/**
 * 用户在这句话里点没点名。点了就返回那个技能名，没点返回空串。
 *
 * 认两种写法：「/名字」（提示词里承诺过的语法），或者名字本身作为一个完整的词出现
 * （「用 wechat-article 写」）。整词是指前后不挨着字母数字——「html-page」不该被「html-pages-v2」
 * 蒙混过去，也不该因为用户提到「page」就把 html-page 拽进来。
 * 几个都点了取最长的那个：名字之间常有包含关系（web-styles / web-styles-dark），长的才是他说的那个。
 */
function named(message, skills) {
  const msg = String(message == null ? "" : message);
  if (!msg.trim()) return "";
  const low = msg.toLowerCase();
  let best = "";
  for (const n of names(skills)) {
    const nl = n.toLowerCase();
    let i = -1;
    while ((i = low.indexOf(nl, i + 1)) >= 0) {
      const before = i > 0 ? low[i - 1] : "";
      const after = low[i + nl.length] || "";
      const wordy = (c) => /[a-z0-9_]/.test(c);
      if (wordy(before) && before !== "/") continue;
      if (wordy(after)) continue;
      if (nl.length > best.length) best = n;
      break;
    }
  }
  return best;
}

/**
 * 这一趟走哪条路。四选一，只有 "judge" 那条才花钱。
 *   none  —— 不碰（没技能、不是顶层、已经加载过、这句话是空的）
 *   named —— 用户点了名：直接加载，一分钱不花，开关关着也照做
 *   skip  —— 没点名，而且开关没开 / 没配判断模型：照旧交给模型自己想
 *   judge —— 值一道题
 *
 * @param {{on?:boolean, ready?:boolean, message?:string, skills?:Array<{name:string}>,
 *          loaded?:Iterable<string>|number, depth?:number}} x
 * @returns {{route:"none"|"named"|"skip"|"judge", name?:string}}
 */
function route({ on, ready, message, skills, loaded, depth } = {}) {
  const list = names(skills);
  if (!list.length) return { route: "none" };
  if (Number(depth) > 0) return { route: "none" };
  const nLoaded = typeof loaded === "number" ? loaded : loaded ? Array.from(loaded).length : 0;
  if (nLoaded > 0) return { route: "none" };
  const msg = cut(message, MSG_CHARS + 400);
  if (!msg) return { route: "none" };
  const hit = named(msg, skills);
  if (hit) return { route: "named", name: hit };
  if (on !== true) return { route: "skip" };   // 开关默认关；写成别的值（字符串、1）都不算开
  if (!ready) return { route: "skip" };        // 没配判断模型
  return { route: "judge" };
}

/** 问出去的那道单选。选项 = 技能名 + 「都不对口」。 */
function pickQuestions(skills) {
  const list = (Array.isArray(skills) ? skills : []).slice(0, SKILL_MAX);
  const criteria = {};
  for (const s of list) {
    const n = cut(s && s.name, 80);
    if (!n || n === NONE) continue;
    criteria[n] = brief(s.description) || "（没写简介）";
  }
  criteria[NONE] = "清单里没有一个是干这类活的；或者用户要的只是一句回答，根本不是一件要做出来的东西";
  return {
    [PICK_KEY]: so.choice(
      "下面是用户刚给一个 AI 办公助手下的活，和它装着的技能清单（每个技能是一份怎么干某类活的规矩：排版、骨架、口径）。\n" +
      "判断：动手之前，该先照哪个技能做？\n" +
      "只挑「这类活正是那个技能管的」——写公众号推文对口公众号技能，做网页对口网页技能。\n" +
      "沾点边但不是同一类活，或者用户只是问一句话、不是要做出一件东西，选「" + NONE + "」。",
      criteria
    ),
  };
}

/** 摆给它看的现场：用户原话 + 技能清单。 */
function pickState({ message, skills } = {}) {
  const list = (Array.isArray(skills) ? skills : []).slice(0, SKILL_MAX)
    .map((s) => { const n = cut(s && s.name, 80); return n ? `- ${n}：${brief(s.description) || "（没写简介）"}` : ""; })
    .filter(Boolean);
  return [
    "【用户这次要做什么】\n" + (cut(message, MSG_CHARS) || "（空的）"),
    "【可用技能】\n" + (list.length ? list.join("\n") : "（没有）"),
  ].join("\n\n");
}

/**
 * 读答案。只有一种情况回非空：它挑了清单里真有的一个技能，而且自己也拿得准。
 * 挑了「都不对口」、挑了清单外的名字（上游偶尔会把选项改写）、确定度不到，都回 null，照旧。
 */
function readPick(out, skills, min) {
  const bar = Number.isFinite(Number(min)) ? Number(min) : PICK_MIN;
  const answers = (out && out.answers) || [];
  const a = answers.find((x) => x && x.key === PICK_KEY);
  if (!a || a.value == null) return null;
  const v = String(a.value).trim();
  if (!v || v === NONE) return null;
  if (!names(skills).includes(v)) return null;
  if (!so.gate(a, bar).act) return null;
  return { name: v, sure: Number(a.sure) || 0, bar };
}

/** 系统提示词里那一段：已加载的技能全文。挂在系统提示词而不是历史里，压缩、截短都碰不到它。 */
const BLOCK_MAX = 3;
function skillBlock(loaded) {
  const entries = loaded instanceof Map ? Array.from(loaded.entries()) : Array.isArray(loaded) ? loaded : [];
  if (!entries.length) return "";
  const keep = entries.slice(-BLOCK_MAX);
  const dropped = entries.slice(0, -BLOCK_MAX).map(([n]) => n);
  let p = `\n\n## 已加载技能（全文）\n以下技能已经加载好了（用户点名、自动匹配、或你自己 use_skill 过的），照着做，不必再 use_skill。这一段挂在系统提示词里，历史压缩、截短都不会丢。`;
  if (dropped.length) p += `\n（更早加载过、这儿放不下的：${dropped.join("、")}。要用再 use_skill 一次）`;
  for (const [n, text] of keep) p += `\n\n### 技能：${n}\n${String(text || "").trim()}`;
  return p;
}

/** 给模型的回执：技能全文不在这条工具结果里，在系统提示词里。 */
function loadedNote(name, text) {
  return `已加载技能「${name}」（${String(text || "").length} 字），全文已挂到系统提示词「已加载技能」一节里，每一步都看得见，历史压缩/截短不会丢。照着它做。`;
}

module.exports = {
  named, route, pickQuestions, pickState, readPick, skillBlock, loadedNote,
  PICK_KEY, NONE, PICK_MIN, MSG_CHARS, SKILL_MAX, BLOCK_MAX,
};
