"use strict";
/**
 * 往长期记忆里写之前的那道闸。
 *
 * 记忆这东西的贵，不在写的那一下，在写完之后：每一条都会跟着**往后每一趟任务**进系统提示词，
 * 你为它付一遍 token、模型照着它走一次路。所以写错一条的代价不是浪费一行字，是往后每一趟
 * 都被它带偏一点点，而且越往后越难查——没人会想到今天这个怪结果是三周前记下的一句话干的。
 *
 * 现在拦它的是两条正则：像密钥的不收，「某功能已修复」这类对本机能力的断言不收（后面那条
 * 是拿一次真事故换来的，见 memory.js 里的注释）。正则管用，但它认的是**措辞**：
 *
 *     「generate_image 的水印问题已解决」          → 拦住了
 *     「出图右下角有水印，得再走一遍 edit_image」  → 一模一样的错，一个字都没命中，收了
 *     「这次把 config.json 第 3 行改成了 8081」    → 纯粹是这一趟的过程，收了，然后跟你一年
 *
 * 加正则补不完这个洞：能力断言有一万种说法，而「这一趟的临时细节」压根没有固定措辞。
 * 措辞这把尺子量不了的，是**这句话下个月还成不成立**——那是判断模型该答的一道题。
 *
 * 三条边界，跟命令那道闸是同一套规矩：
 *   - **只能把「记」变成「不记」**，反过来不行：正则拦下的照样拦，这道闸救不回来；
 *   - **只拦用户自己没开口的那些**：source 不是 agent（用户在设置里手敲的）一律不判，
 *     用户说记就是记，轮不到模型评审；
 *   - **说不准、答不上、问不成，一律照旧记下**。闸坏了要退回老行为，不能反过来把记忆吞了。
 *
 * 拒了要说清为什么、以及该记什么才对——回执是给 agent 看的，它得能照着改一句再记一次。
 *
 * 这儿一个字的网络都不发，发请求那一下在 tools.js。分开是为了这套判据能当纯函数测。
 */

const so = require("./systemone");

/** 两道题的名字。答案按名字取回来，两边必须是同一个常量。 */
const KEEP_KEY = "下个月还用得上吗";
const KIND_KEY = "最像哪一类";

/**
 * 拒收的门槛。比通用的 0.7 严：判错的代价是用户亲口交代的一条偏好没记住，
 * 而这种错发现不了——用户只会觉得「说过的事它又忘了」。
 */
const KEEP_MIN = 0.8;

/** 归类只用来把拒收的理由说人话，不参与拍板（拍板的永远是上面那道是非题）。 */
const KIND_CHOICES = {
  偏好: "用户的偏好、习惯、规矩、明确的纠正——下个月还照着它做",
  事实: "稳定的事实：业务/产品叫什么、常用链接、固定的交付格式、长期用的路径",
  临时: "这一趟任务里的过程或中间状态：改了哪一行、这次用了哪个参数、这个文件现在多大",
  能力: "对本机功能好没好、支不支持某件事的断言——用的时候试一次就知道，不该靠记",
  说不清: "上面几类都不像，或者信息太少看不出来",
};

/** 摆给它看的现场，各段的上限。记忆本身最多 400 字（memory.MAX_TEXT），照抄一份不做二次截断。 */
const TEXT_CHARS = 400;
const TASK_CHARS = 400;

const cut = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

/**
 * 这一条该不该花那道题的钱。回 false 的都是白给的尺子量得出来的。
 * @param {{text?:string, source?:string, on?:boolean, ready?:boolean}} x
 */
function needsJudge({ text, source, on, ready } = {}) {
  if (on !== true) return false;                 // 开关默认关；写成别的值（字符串、1）都不算开
  if (!ready) return false;                      // 没配判断模型
  if (source !== "agent") return false;          // 用户自己写的不判：他说记就是记
  const t = cut(text, TEXT_CHARS + 1);
  if (!t) return false;                          // 空的，现成的规矩已经拒了
  if (t.length > TEXT_CHARS) return false;       // 超长，现成的规矩已经拒了
  return true;
}

/** 问出去的两道题。一道拍板，一道只为把话说人话。 */
function keepQuestions() {
  return {
    [KEEP_KEY]: so.noul(
      "下面是一个 AI 助手想写进**长期记忆**的一句话。长期记忆会跟着往后每一趟任务进系统提示词，" +
      "一直生效，不会自己过期。\n" +
      "判断：下个月做一件类似的活儿时，这句话还成立、还派得上用场吗？\n" +
      "算还用得上：用户的偏好和规矩（「报告别写开场白」）、稳定的身份和事实（「他的产品叫 X」）、" +
      "长期不变的路径和格式。\n" +
      "算用不上：只在这一趟里成立的过程和中间状态（「这次把第 3 行改成了 8081」「刚才那张图存成了 a.png」）、" +
      "对本机功能好没好的断言（「某某工具现在已经支持了」——下个月代码改了它就是错的，而且没人会回头核对）、" +
      "一次性的具体数值和临时文件名。\n" +
      "看不出来就别硬挑一边：判错了要么让一条真偏好丢掉，要么让一句废话跟着用户一整年。"
    ),
    [KIND_KEY]: so.choice("上面那句话最像哪一类。只为把理由说清楚，拿不准就选「说不清」。", KIND_CHOICES),
  };
}

/** 摆给它看的现场。两段各自标好是什么：要记的那句话，和它是在干什么活儿的时候想记的。 */
function keepState({ text, task } = {}) {
  return [
    "【它想记的那句话】\n" + (cut(text, TEXT_CHARS) || "（空的）"),
    "【这一趟在干什么】\n" + (cut(task, TASK_CHARS) || "（没记下来）"),
  ].join("\n\n");
}

/**
 * 读答案。只有一种情况回非空：它说「下个月用不上」，而且自己也拿得准 —— 那就别记。
 * 其余全回 null = 当没问过 = 照老样子记下。
 */
function readKeep(out, min) {
  const bar = Number.isFinite(Number(min)) ? Number(min) : KEEP_MIN;
  const answers = (out && out.answers) || [];
  const a = answers.find((x) => x && x.key === KEEP_KEY);
  // 答非所问也得当没答上来：万一哪天上游把这道是非题当单选答了，value 会是一句话，
  // 拿它跟 0.5 比大小比出来的东西没有意义，却能凭空吞掉一条记忆
  if (!a || !Number.isFinite(Number(a.value))) return null;
  if (Number(a.value) >= 0.5) return null;  // 它说还用得上
  if (!so.gate(a, bar).act) return null;    // 它说用不上，但自己也拿不准。确定度这把尺子只有 systemone 那一把
  const k = answers.find((x) => x && x.key === KIND_KEY);
  return { sure: Number(a.sure) || 0, p: Number(a.value), bar, label: (k && k.value) || "" };
}

/** 拒收的回执。说清三件事：为什么不收、有多确定、该记什么才对。 */
function dropNote(d) {
  const kind = d && d.label;
  const why = kind === "临时"
    ? "它看着是这一趟任务里的过程或中间状态，不是下个月还成立的事"
    : kind === "能力"
      ? "它看着是在断言某个功能现在好没好——这种事用的时候试一次就知道，记下来只会在它变了之后继续骗你自己"
      : "它看着下个月就不成立了，长期记忆里留着只会误导以后的任务";
  return `没记：${why}（判断模型确定度 ${so.pct(d && d.sure)}）。`
    + "要记就记它背后那条下个月还成立的规矩——比如别记「这次把端口改成了 8081」，"
    + "记「这个项目的服务端口固定用 8081」；实在只是这一趟要用的，写进任务产物里，别写进记忆。";
}

module.exports = {
  needsJudge, keepQuestions, keepState, readKeep, dropNote,
  KEEP_KEY, KIND_KEY, KEEP_MIN, KIND_CHOICES, TEXT_CHARS, TASK_CHARS,
};
