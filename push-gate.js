"use strict";
/**
 * 定时任务推之前的那道闸：跟上一次真推出去的那条比，这一轮有没有新东西值得再响一次。
 *
 * 一条每天跑的「看看竞品官网更没更新」，一年推 365 条，其中 350 条是「今天没有更新」。
 * 第三天开始人就不看了，第十天把群机器人静音——然后在真有更新的那天，通知照样发出去了，
 * 照样没人看。这个功能坏掉的方式不是报错，是**被人关掉**，而且关掉之前它一直显示正常。
 *
 * 去重这件事没法用正则做：两条「今天没有更新」中间夹着日期和抓取耗时，字节上永远不一样；
 * 而「股价 12.3 → 12.4」字面上只差一个字符，却正是要通知的那种变化。变没变化这件事
 * 量的是**意思**，不是字符——那是判断模型该答的一道题。
 *
 * 三条边界：
 *   - **只能把「推」变成「不推」**。红的、出错的、挂了疑问的一律推，这道闸碰都不碰；
 *   - **比的是「上一次真推出去的那条」，不是「上一次跑的那条」**。这一条是全部设计里最要紧的：
 *     万一某一轮被误判成没变化，攒下来的新东西下一次照样比得出来，不会跟着那次误判一起沉掉；
 *   - **不推也要留痕**。运行记录上写明这条为什么没推、有多确定，正文一个字不少照样存着。
 *     后台功能悄悄不干活，表现是「一切正常」——那是最贵的一种坏。
 *
 * 这儿一个字的网络都不发，发请求那一下在 server.js。分开是为了这套判据能当纯函数测。
 */

const so = require("./systemone");

/** 两道题的名字。答案按名字取回来，两边必须是同一个常量。 */
const NEWS_KEY = "有新东西吗";
const KIND_KEY = "新在哪儿";

/**
 * 不推的门槛。跟通用的 0.7 一样，没往上抬：判错了这一条也不会丢——下一次还是拿
 * 「上一次真推出去的那条」当底子比，攒下的变化会在下一轮一起到人眼前。
 */
const NEWS_MIN = 0.7;

/** 归类只用来把「为什么没推」说人话，不参与拍板（拍板的永远是上面那道是非题）。 */
const KIND_CHOICES = {
  换了说法: "说的还是同一件事，只是时间戳、日期、措辞或排序不同",
  数变了: "同一件事，但里头的数字、状态、进度变了",
  多了事: "出现了上一次没有的条目、事件或结论",
  出岔子: "这一次报了错、没拿到数据、或者半路停了",
  说不清: "上面几类都不像，或者信息太少看不出来",
};

/** 摆给它看的现场，各段的上限。两条正文各 700 字：再长的汇报，差别也早在前头露出来了。 */
const TEXT_CHARS = 700;
const TASK_CHARS = 300;

/** 留底那条的上限。比 TEXT_CHARS 略宽一点，截断这一刀留给 newsState 统一去切。 */
const BASE_CHARS = 800;

const cut = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
/** 空白折叠。判「一字不差」时用，免得换行多一个就当成有新东西 */
const flat = (v) => cut(v, BASE_CHARS + 200).replace(/\s+/g, " ");

/**
 * 这一轮走哪条路。三选一，只有 "ask" 那条才花钱。
 *   push —— 照旧推（第一次跑、没基线、红的、挂了疑问的，全走这儿）
 *   same —— 跟上一次一字不差：这就是「没变化」本身，不必花钱去问
 *   ask  —— 字面不同，但不同的可能只是时间戳。这一条才值一道题
 * @param {{prev?:string, text?:string, ok?:boolean, doubt?:string}} x
 */
function screen({ prev, text, ok = true, doubt } = {}) {
  if (ok !== true) return "push";        // 红的、出错的：坏消息永远推，一秒都不许拦
  if (doubt) return "push";              // 挂了疑问的那条，正是最该到人眼前的那条
  const cur = flat(text);
  if (!cur) return "push";               // 空的照旧推：这一轮本来就不对劲
  const old = flat(prev);
  if (!old) return "push";               // 第一次跑，没有基线可比
  if (cur === old) return "same";
  return "ask";
}

/** 问出去的两道题。一道拍板，一道只为把话说人话。 */
function newsQuestions(task) {
  return {
    [NEWS_KEY]: so.noul(
      "下面是同一条定时任务两次跑出来的汇报：一次是上次推送给用户看过的，一次是刚跑完还没推的。\n" +
      "判断：这一次里有没有用户还没看过、而且值得为它再响一次通知的新东西？\n" +
      "算有：数字变了、状态翻了、多了或少了条目、出现了新的结论或新的问题。\n" +
      "算没有：说的还是同一件事，只是时间戳、日期、耗时、措辞、排序或者条目顺序不同；" +
      "两边都是「没有更新」「一切正常」这类空结论。\n" +
      "拿不准就当有——漏推一条真消息，比多响一次铃贵得多。\n" +
      "这条任务要的是：" + cut(task, TASK_CHARS)
    ),
    [KIND_KEY]: so.choice("这一次跟上一次比，差别最像哪一类。只为把话说清楚，拿不准就选「说不清」。", KIND_CHOICES),
  };
}

/** 摆给它看的现场。哪条是旧的、哪条是新的，得标死了，不然它连方向都判反。 */
function newsState({ task, prev, text } = {}) {
  return [
    "【这条任务要什么】\n" + (cut(task, TASK_CHARS) || "（没记下来）"),
    "【上一次推给用户的】\n" + (cut(prev, TEXT_CHARS) || "（没有）"),
    "【这一次刚跑出来的】\n" + (cut(text, TEXT_CHARS) || "（空的）"),
  ].join("\n\n");
}

/**
 * 读答案。只有一种情况回非空：它说「没有新东西」，而且自己也拿得准 —— 那就别推。
 * 其余全回 null = 当没问过 = 照老样子推出去。
 */
function readNews(out, min) {
  const bar = Number.isFinite(Number(min)) ? Number(min) : NEWS_MIN;
  const answers = (out && out.answers) || [];
  const a = answers.find((x) => x && x.key === NEWS_KEY);
  // 答非所问也得当没答上来：万一上游把这道是非题当单选答了，value 会是一句话，
  // 拿它跟 0.5 比大小比出来的东西没有意义，却能凭空吞掉一条通知
  if (!a || !Number.isFinite(Number(a.value))) return null;
  if (Number(a.value) >= 0.5) return null;  // 它说有新东西
  if (!so.gate(a, bar).act) return null;    // 它说没有，但自己也拿不准。确定度这把尺子只有 systemone 那一把
  const k = answers.find((x) => x && x.key === KIND_KEY);
  const label = (k && k.value) || "";
  // 它自己都说这一次出岔子了，那两道题就是打架的：出错的一律推，别拿「没新东西」把它吞了
  if (label === "出岔子") return null;
  return { sure: Number(a.sure) || 0, p: Number(a.value), bar, label };
}

/** 一字不差那条的留痕。没花钱，所以不写确定度——写了就是假的。 */
function sameNote() {
  return "没推：这一轮的结果跟上一次推给你的那条一字不差。"
    + "正文照常存在运行记录里，点进去看得到全文。";
}

/** 判出来的「没新东西」的留痕。说清三件事：为什么没推、有多确定、下一次会不会漏。 */
function skipNote(d) {
  const why = (d && d.label) === "换了说法"
    ? "跟上一次推给你的那条说的是同一件事，只是时间或措辞不同"
    : "跟上一次推给你的那条比，没有你还没看过的新东西";
  return `没推：${why}（判断模型确定度 ${so.pct(d && d.sure)}）。`
    + "正文照常存在运行记录里，点进去看得到全文；"
    + "下一次还是拿「上一次真推出去的那条」当底子比——这一轮要是判错了，攒下的变化下次会一起推给你。";
}

module.exports = {
  screen, newsQuestions, newsState, readNews, sameNote, skipNote,
  NEWS_KEY, KIND_KEY, NEWS_MIN, KIND_CHOICES, TEXT_CHARS, TASK_CHARS, BASE_CHARS,
};
