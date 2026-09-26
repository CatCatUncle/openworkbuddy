"use strict";
/**
 * 飞书任务卡片（im-card.js）：卡上放什么、不放什么。
 *
 * 钉这几件事：
 *   1. 卡头就是交代的那件事，副标题「第 n 步 · 耗时 · tokens」，状态标签五选一——手机上瞄卡头就够
 *   2. 过程只留最近几行，每行一个图标；跑着那行太久没动静才说「安静 Ns」，几秒没动静不说
 *   3. 工具前那几句过场白不算回答：碰到下一次工具调用就从正文那格清掉
 *   4. 文件名里的 _ * 原样显示（过程行走纯文本，不走 markdown）
 *   5. 收尾：过程收进折叠面板，出错才默认摊开；排队的那段不算进耗时
 *   6. 只有一整句「停」才算叫停，句子里顺带提到的不算
 *   7. 卡片里用到的颜色/模板全在飞书认的名单里（名单外的值飞书整张卡拒收，任务回复就退成纯文本）
 *   8. 长工具报的进度挂在正在跑的那行后面，结果一到就换成结果量；迟到的、子智能体的、对不上号的都不上卡
 *   9. 卡头「已花 ¥0.84」：每趟只数自己的（两趟同时跑互不串账）；有一项没单价就绝不写 ¥0，
 *      一分钱没花就不出这一格；这一格排在 tokens 前面，收尾、出错、停下的卡都带着
 */
const c = require("../im-card");

let n = 0;
const bad = [];
// 一条没过不停下：把没过的全列出来，最后统一让退出码变 1（all.js 只看退出码）
const ok = (name, cond) => { if (cond) n++; else { bad.push(name); console.log(`  ✗ ${name}`); } };

// 飞书卡片 JSON 2.0 认的值。写错一个，建卡接口整张拒收
const COLORS = new Set(["default", "neutral", "blue", "wathet", "turquoise", "green", "lime", "yellow", "orange", "red", "carmine", "violet", "purple", "indigo", "grey"]);
const TEMPLATES = new Set(["default", "blue", "wathet", "turquoise", "green", "yellow", "orange", "red", "carmine", "violet", "purple", "indigo", "grey"]);

function walk(o, fn) {
  if (Array.isArray(o)) return o.forEach((x) => walk(x, fn));
  if (o && typeof o === "object") { fn(o); for (const k of Object.keys(o)) walk(o[k], fn); }
}
function texts(card) {
  const out = [];
  walk(card.body, (o) => { if (typeof o.content === "string") out.push(o.content); });
  return out;
}
function legal(card, why) {
  ok(`${why}：模板在名单里（${card.header.template}）`, TEMPLATES.has(card.header.template));
  walk(card, (o) => {
    if (o.text_color) ok(`${why}：text_color=${o.text_color} 在名单里`, COLORS.has(o.text_color));
    if (o.tag === "text_tag") ok(`${why}：标签颜色 ${o.color} 在名单里`, COLORS.has(o.color));
  });
  ok(`${why}：副标题不是空的`, !!card.header.subtitle.content);
  ok(`${why}：整张卡不超过 30KB`, JSON.stringify(card).length < 30000);
}

// ---- 1. 卡头 ----
{
  const st = c.init({ title: "## 帮我把 report_v2.md 做成 PPT\n要十页", now: 0 });
  ok("标题取头一行、剥掉行首 #，文件名里的 _ 留着", st.title === "帮我把 report_v2.md 做成 PPT");
  c.begin(st, 1000);
  c.feed(st, { type: "step_start", step: 1 }, { now: 1500 });
  c.feed(st, { type: "tool_use", id: "a", name: "read_file", title: "读 report_v2.md" }, { now: 2000 });
  c.feed(st, { type: "tool_result", id: "a", outcome: "120 行" }, { now: 3000 });
  c.feed(st, { type: "step_usage", prompt: 12000, completion: 300 }, { now: 3000 });
  const card = c.render(st, { now: 73000 });
  ok("副标题：第几步 · 耗时（从 begin 算）· tokens", card.header.subtitle.content === "第 1 步 · 1m12s · 12.3k tokens");
  ok("状态标签：进行中", card.header.text_tag_list[0].text.content === "进行中");
  ok("聊天列表里的预览说在跑什么", card.config.summary.content.startsWith("进行中：帮我把"));
  ok("跑着的时候是流式卡", card.config.streaming_mode === true);
  ok("告诉人怎么叫停", texts(card).some((t) => t.includes("回复「停」")));
  ok("做完那行：✔ 动词+对象 · 结果量，文件名原样", texts(card).includes("✔ 读 report_v2.md · 120 行"));
  legal(card, "进行中");
}

// ---- 2. 安静多久才说 ----
{
  const st = c.init({ title: "跑测试", now: 0 });
  c.feed(st, { type: "tool_use", id: "t", name: "run_shell", title: "执行 npm test" }, { now: 1000 });
  const quiet = (at) => texts(c.render(st, { now: at })).find((t) => t.startsWith("⏺"));
  ok("安静 5 秒不说（常态，说了是噪音）", quiet(6000) === "⏺ 执行 npm test");
  ok(`安静满 ${c.IDLE_SHOW_MS / 1000} 秒才说`, quiet(1000 + c.IDLE_SHOW_MS + 5000) === "⏺ 执行 npm test · 安静 25s");
  const row = (() => { let hit = null; walk(c.render(st, { now: 9000 }).body, (o) => { if (o.text && o.text.content === "⏺ 执行 npm test") hit = o.text; }); return hit; })();
  ok("跑着那行是蓝的、单行截断", row && row.text_color === "blue" && row.lines === 1);
  c.feed(st, { type: "tool_result", id: "t", isError: true, outcome: "退出码 1" }, { now: 9000 });
  let red = false;
  walk(c.render(st, { now: 9000 }).body, (o) => { if (o.text && o.text.content === "✗ 执行 npm test · 退出码 1") red = o.text.text_color === "red"; });
  ok("出错那行：✗ + 原因，红的", red);
}

// ---- 3. 过场白不算回答；只留最近几行 ----
{
  const st = c.init({ title: "查资料", now: 0 });
  c.feed(st, { type: "text", delta: "我先搜一下。" }, { now: 100 });
  ok("模型在写的字流进正文那格", texts(c.render(st, { now: 200 })).includes("我先搜一下。"));
  c.feed(st, { type: "tool_use", id: "s", name: "web_search", title: "搜「飞书卡片」" }, { now: 300 });
  ok("下一次工具调用一来，过场白清掉", !texts(c.render(st, { now: 400 })).includes("我先搜一下。"));
  c.feed(st, { type: "text", delta: "子智能体的话", depth: 1 }, { now: 500 });
  c.feed(st, { type: "tool_use", id: "x", name: "read_file", title: "读 子任务.md", depth: 1 }, { now: 500 });
  ok("子智能体的字和工具不上卡", !texts(c.render(st, { now: 600 })).some((t) => t.includes("子智能体") || t.includes("子任务")));
  c.feed(st, { type: "tool_use", id: "td", name: "todo_write", title: "清单 0/3" }, { now: 600 });
  ok("写清单那次调用不占一行过程", st.lines.length === 1);
  for (let i = 0; i < 9; i++) c.feed(st, { type: "tool_use", id: `r${i}`, name: "read_file", title: `读 第${i}个.md` }, { now: 700 + i });
  const t = texts(c.render(st, { now: 800 }));
  ok("只留最近 5 行 + 「前面还有 n 步」", t.includes("… 前面还有 5 步") && t.includes("⏺ 读 第8个.md") && !t.includes("⏺ 读 第3个.md"));
  c.feed(st, { type: "text", delta: "_斜体_" }, { now: 900 });
  const drafted = c.render(st, { now: 900, clean: (s) => s.replace(/_/g, "") });
  ok("正文先过 clean（callout 标记、[[不发文件]] 在 im.js 那头剥）", texts(drafted).includes("斜体"));
}

// ---- 4. 进度清单 ----
{
  const st = c.init({ title: "做 PPT", now: 0 });
  c.feed(st, { type: "todos", items: [{ content: "读报告", status: "done" }, { content: "出大纲", status: "in_progress" }, { content: "做 PPT", status: "pending" }] }, { now: 10 });
  const t = texts(c.render(st, { now: 20 }));
  ok("清单：进度 1/3 + ✔/⏺/◯", t.includes("**进度 1/3**") && t.includes("✔ 读报告") && t.includes("⏺ 出大纲") && t.includes("◯ 做 PPT"));
  c.feed(st, { type: "todos", items: Array.from({ length: 12 }, (_, i) => ({ content: `第${i}条`, status: i < 6 ? "done" : "pending" })) }, { now: 30 });
  const long = texts(c.render(st, { now: 40 }));
  ok("清单太长：做完的收成一行", long.includes("✔ 已做完 6 条") && !long.includes("✔ 第0条") && long.includes("◯ 第6条"));
}

// ---- 5. 收尾 ----
{
  const st = c.init({ title: "写周报", queued: true, now: 0 });
  const q = c.render(st, { now: 5000 });
  ok("排队中：灰卡 + 排队标签", q.header.template === "grey" && q.header.text_tag_list[0].text.content === "排队中");
  legal(q, "排队中");
  c.begin(st, 60000);
  ok("轮到了：耗时从轮到那会儿算，排队那一分钟不算", c.render(st, { now: 65000 }).header.subtitle.content === "5s");
  c.feed(st, { type: "tool_use", id: "w", name: "write_file", title: "写 周报.md" }, { now: 61000 });
  c.feed(st, { type: "tool_result", id: "w", outcome: "40 行" }, { now: 62000 });
  const done = c.render(st, { phase: "done", now: 90000, body: "# 周报写好了\n在 周报.md", files: ["out/周报.md"] });
  ok("完成：绿卡 + 完成标签 + 用时/步数", done.header.template === "green" && done.header.text_tag_list[0].text.content === "完成" && done.header.subtitle.content === "用时 30s · 1 步");
  ok("完成：不再流式、不再说怎么叫停", done.config.streaming_mode === false && !texts(done).some((t) => t.includes("回复「停」")));
  const panel = done.body.elements.find((e) => e.tag === "collapsible_panel");
  ok("完成：过程收进默认折叠的面板，面板头上写几步", panel && panel.expanded === false && panel.header.title.content === "执行过程 · 1 步");
  ok("完成：聊天列表预览是回答的头一句", done.config.summary.content === "周报写好了");
  ok("完成：附件名列在正文底下", texts(done).some((t) => t.startsWith("📎 周报.md")));
  legal(done, "完成");
  const fail = c.render(st, { phase: "fail", now: 90000, body: "出错了：模型超时" });
  const fp = fail.body.elements.find((e) => e.tag === "collapsible_panel");
  ok("没做成：红卡、过程默认摊开", fail.header.template === "red" && fp.expanded === true && fail.header.subtitle.content.startsWith("跑了 30s，做到第 1 步"));
  legal(fail, "没做成");
  const stopped = c.render(st, { phase: "stopped", now: 90000, body: "已按你的要求停下" });
  ok("已停止：灰卡 + 已停止标签", stopped.header.template === "grey" && stopped.header.text_tag_list[0].text.content === "已停止");
  legal(stopped, "已停止");
  const chat = c.render(c.init({ title: "你好", now: 0 }), { phase: "done", now: 1000, body: "你好！" });
  ok("纯聊天没有过程：不出空的折叠面板", !chat.body.elements.some((e) => e.tag === "collapsible_panel"));
}

// ---- 6. 什么算「停」 ----
for (const s of ["停", "停下", "停止", " 停。", "/stop", "／停", "别做了", "STOP", "取消"]) ok(`「${s}」算叫停`, c.isStopWord(s));
for (const s of ["停车场在哪", "帮我写个停止按钮", "不要停", "", "stop the server please"]) ok(`「${s}」不算叫停`, !c.isStopWord(s));

// ---- 7. token 只增不减、换模型会记下 ----
{
  const st = c.init({ title: "x", now: 0 });
  c.feed(st, { type: "step_usage", prompt: 100, completion: 20 }, { now: 1 });
  c.feed(st, { type: "usage", prompt: 50, completion: 5, model: "gpt-5.4-mini" }, { now: 2 });
  ok("token 取大的那个（引擎收尾那条 usage 可能是单轮的）", st.tokens === 120 && st.model === "gpt-5.4-mini");
}

// ---- 8. 长工具的进度挂在正在跑的那行后面（tool_progress） ----
{
  const st = c.init({ title: "出片", now: 0 });
  c.feed(st, { type: "tool_use", id: "r", name: "render_motion", title: "渲染 片头.html" }, { now: 1000 });
  const row = (at) => texts(c.render(st, { now: at })).find((t) => t.startsWith("⏺") || t.startsWith("✔"));
  ok("进度改了卡：feed 回 true（im.js 才排一次推送）", c.feed(st, { type: "tool_progress", id: "r", stage: "render", done: 432, total: 900, label: "渲染帧 432/900 · 30fps" }, { now: 2000 }) === true);
  ok("正在跑的那行后面挂着工具报的那句", row(3000) === "⏺ 渲染 片头.html · 渲染帧 432/900 · 30fps");
  ok("同一句再报一遍：卡没变，不推", c.feed(st, { type: "tool_progress", id: "r", label: "渲染帧 432/900 · 30fps" }, { now: 2500 }) === false);
  // 进度一直在报就不算安静：从 tool_use 起算早过了 IDLE_SHOW_MS，但最后一条进度才过去几秒
  c.feed(st, { type: "tool_progress", id: "r", label: "渲染帧 899/900" }, { now: 1000 + c.IDLE_SHOW_MS + 4000 });
  ok("一直报进度的不说「安静」", row(1000 + c.IDLE_SHOW_MS + 6000) === "⏺ 渲染 片头.html · 渲染帧 899/900");
  ok("反向对照：报完就不动了，照样说「安静」", /· 安静 \d+s$/.test(row(1000 + 2 * c.IDLE_SHOW_MS + 9000) || ""));
  ok("卡上挂着「安静」时来一条同样的进度：也要推一次把它摘掉",
    c.feed(st, { type: "tool_progress", id: "r", label: "渲染帧 899/900" }, { now: 1000 + 2 * c.IDLE_SHOW_MS + 9500 }) === true);
  ok("不带 label 的：退回 done/total", c.feed(st, { type: "tool_progress", id: "r", done: 3, total: 12 }, { now: 60000 }) === true && row(60500) === "⏺ 渲染 片头.html · 3/12");
  ok("  └ 只有百分比的：退回 pct%", c.feed(st, { type: "tool_progress", id: "r", pct: 41.6 }, { now: 61000 }) === true && row(61500) === "⏺ 渲染 片头.html · 42%");
  c.feed(st, { type: "tool_progress", id: "r", label: "  渲染\n帧 900/900 " + "很长".repeat(20) }, { now: 62000 });
  ok("label 压成一行、截到 24 字补 …", row(62500) === "⏺ 渲染 片头.html · 渲染 帧 900/900 很长很长很长很长很长…");
  ok("子智能体的进度不上卡（它的工具行本来就不上卡）", c.feed(st, { type: "tool_progress", id: "r", depth: 1, label: "别处的" }, { now: 63000 }) === false);
  ok("对不上号的 id 不上卡", c.feed(st, { type: "tool_progress", id: "nope", label: "别处的" }, { now: 63000 }) === false && !texts(c.render(st, { now: 63000 })).some((t) => t.includes("别处的")));
  c.feed(st, { type: "tool_result", id: "r", outcome: "18 秒" }, { now: 64000 });
  ok("结果一到：结果量接替进度", row(64500) === "✔ 渲染 片头.html · 18 秒");
  ok("结果之后迟到的进度拉不回那行", c.feed(st, { type: "tool_progress", id: "r", label: "渲染帧 1/900" }, { now: 65000 }) === false && row(65500) === "✔ 渲染 片头.html · 18 秒");
  const done = c.render(st, { phase: "done", now: 70000, body: "好了" });
  ok("收尾面板里也没有进度那句", !texts(done).some((t) => t.includes("渲染帧")));
  legal(done, "带进度收尾");
  // 建卡要一两秒，这期间的事件先攒在 im.js 的 60 格缓冲里；进度 400ms 一报，放进去会把后面的工具结果挤掉
  const imSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "im.js"), "utf8");
  const bufLine = imSrc.split("\n").find((l) => /cardEvents\.push\(ev\)/.test(l)) || "";
  ok("im.js 那格缓冲找得到（找不到就是改名了，下一条会失去意义）", !!bufLine);
  ok("进度不进建卡前的缓冲", /ev\.type !== "tool_progress"/.test(bufLine));
}

// ---- 9. 这一趟花了多少（run-spend.js + 卡头那一格） ----
async function spendChecks() {
  const rs = require("../run-spend");
  const tick = () => new Promise((r) => setImmediate(r));

  // 两趟同时跑、await 交错：各记各的，回调也只听到自己那趟
  const seenA = [], seenB = [];
  const runA = async () => {
    rs.note({ cap: "search", model: "tavily", yuan: 0.0568 });
    await tick();
    await new Promise((r) => setTimeout(r, 5));
    rs.note({ cap: "chat", model: "deepseek-chat", yuan: 0.36 });
    await tick();
    return rs.snapshot();
  };
  const runB = async () => {
    await tick();
    rs.note({ cap: "image", model: "some-image", yuan: 0.2 });
    await new Promise((r) => setTimeout(r, 1));
    rs.note({ cap: "search", model: "mystery-search", unknown: true });
    await tick();
    rs.note({ cap: "search", model: "mystery-search", unknown: true });
    return rs.snapshot();
  };
  const [a, b] = await Promise.all([rs.track((s) => seenA.push(s), runA), rs.track((s) => seenB.push(s), runB)]);
  ok("两趟同时跑：A 只数自己的 ¥0.0568 + ¥0.36", a && a.yuan === 0.4168 && a.unknownN === 0, JSON.stringify(a));
  ok("两趟同时跑：B 只数自己的 ¥0.2 和 1 项单价未知", b && b.yuan === 0.2 && b.unknownN === 1, JSON.stringify(b));
  ok("回调只听到自己那趟（A 两笔、B 三笔，A 从没见过未知项）", seenA.length === 2 && seenB.length === 3 && seenA.every((s) => s.unknownN === 0) && seenB[seenB.length - 1].yuan === 0.2);
  ok("track 外面：note 是空操作（返回 false）、snapshot 是 null", rs.note({ cap: "chat", yuan: 1 }) === false && rs.snapshot() === null);

  const u = rs.track(null, () => {
    rs.note({ cap: "search", model: "x", yuan: 3, unknown: true }); // 标了未知就不加钱，哪怕带着数
    rs.note({ cap: "search", model: "x", unknown: true });
    rs.note({ cap: "search", model: "y", unknown: true });
    rs.note({ cap: "tts", model: "x", unknown: true }); // 同名不同能力：另一项
    rs.note({ cap: "chat", model: "m", yuan: -2 });
    rs.note({ cap: "chat", model: "m", yuan: NaN });
    return rs.snapshot();
  });
  ok("未知项按项数不按次数；标了未知的绝不加钱；负数、NaN 不记", u.yuan === 0 && u.unknownN === 3, JSON.stringify(u));
  ok("回调抛错不连累记账", rs.track(() => { throw new Error("卡片挂了"); }, () => rs.note({ cap: "chat", yuan: 0.1 }) && rs.snapshot().yuan === 0.1) === true);

  // 三种写法 + 不出这一格的两种
  ok("都有价：「已花 ¥0.84」", c.spendText({ yuan: 0.84, unknownN: 0 }) === "已花 ¥0.84");
  ok("有几项没价：「已花 ¥0.84 · 1 项单价未知」", c.spendText({ yuan: 0.84, unknownN: 1 }) === "已花 ¥0.84 · 1 项单价未知");
  ok("一项价都没有：「单价未知」，不写 ¥0", c.spendText({ yuan: 0, unknownN: 2 }) === "单价未知");
  ok("确实一分钱没花 / 没这回事：这一格空着", c.spendText({ yuan: 0, unknownN: 0 }) === "" && c.spendText(null) === "" && c.spendText(undefined) === "");
  ok("不到一分钱：多留几位，不四舍五入成 ¥0.00", c.spendText({ yuan: 0.0023, unknownN: 0 }) === "已花 ¥0.0023" && c.spendText({ yuan: 0.000004, unknownN: 0 }) === "已花 ¥0.000004");
  ok("整数分照常两位", c.spendText({ yuan: 12.5, unknownN: 0 }) === "已花 ¥12.50" && c.spendText({ yuan: 0.0568, unknownN: 0 }) === "已花 ¥0.06");

  // 进卡：排在 tokens 前面；推送只在数变了时排
  const st = c.init({ title: "查三家竞品写成表", now: 0 });
  c.begin(st, 1000);
  c.feed(st, { type: "tool_use", id: "s", name: "web_search", title: "搜 竞品" }, { now: 100 });
  c.feed(st, { type: "tool_result", id: "s", outcome: "8 条" }, { now: 900 });
  c.feed(st, { type: "step_usage", prompt: 100000, completion: 20000 }, { now: 1000 });
  ok("没收到 spend：卡头没有这一格", !/已花|单价未知/.test(c.render(st, { now: 2000 }).header.subtitle.content));
  ok("spend 头一回到：feed 回 true", c.feed(st, { type: "spend", yuan: 0.4168, unknownN: 0 }, { now: 2100 }) === true);
  ok("同一个数再来：feed 回 false（不多推一次）", c.feed(st, { type: "spend", yuan: 0.4168, unknownN: 0 }, { now: 2200 }) === false);
  ok("多了一项未知：feed 回 true", c.feed(st, { type: "spend", yuan: 0.4168, unknownN: 1 }, { now: 2300 }) === true);
  c.feed(st, { type: "spend", yuan: 0.4168, unknownN: 0 }, { now: 2400 });
  const run = c.render(st, { now: 4000 });
  ok("跑着的卡：「第 1 步 · 3s · 已花 ¥0.42 · 120k tokens」", run.header.subtitle.content === "第 1 步 · 3s · 已花 ¥0.42 · 120k tokens", run.header.subtitle.content);
  legal(run, "带花费跑着");
  const done = c.render(st, { phase: "done", now: 5000, body: "表做好了" });
  ok("收尾的卡：花费在 tokens 前面", done.header.subtitle.content === "用时 4s · 1 步 · 已花 ¥0.42 · 120k tokens", done.header.subtitle.content);
  legal(done, "带花费收尾");
  const fail = c.render(st, { phase: "fail", now: 4000, body: "出错了" });
  ok("没做成的卡也带着已花的钱", fail.header.subtitle.content.includes("· 已花 ¥0.42 · 120k tokens"), fail.header.subtitle.content);
  const stopped = c.render(st, { phase: "stopped", now: 4000, body: "停了" });
  ok("停下的卡也带着", stopped.header.subtitle.content.includes("按你说的停了 · 已花 ¥0.42"), stopped.header.subtitle.content);
  c.feed(st, { type: "spend", yuan: 0, unknownN: 1 }, { now: 5000 });
  const unk = c.render(st, { now: 5000 }).header.subtitle.content;
  ok("只剩未知项：「单价未知」，卡上一个 ¥ 都不出", unk.includes("· 单价未知 ·") && !unk.includes("¥"), unk);
  c.feed(st, { type: "spend", yuan: 0, unknownN: 0 }, { now: 6000 });
  ok("本地模型整趟 0 元：这一格不出", !/已花|单价未知|¥/.test(c.render(st, { phase: "done", now: 6000, body: "好" }).header.subtitle.content));
  ok("乱数进来不出负数", c.feed(st, { type: "spend", yuan: -3, unknownN: -1 }, { now: 7000 }) === false && st.spend.yuan === 0 && st.spend.unknownN === 0);
}

spendChecks().catch((e) => { bad.push("意外异常"); console.log("  ✗ 意外异常：" + (e && e.stack || e)); }).then(() => {
  if (bad.length) {
    console.log(`❌ 飞书任务卡片：${bad.length} 条没过（过了 ${n} 条）`);
    process.exit(1);
  }
  console.log(`✅ 飞书任务卡片：${n} 条断言全过（卡头说清在干什么、过程只留几行、过场白不算回答、停得下来、颜色全在飞书名单里、花费只数这一趟）`);
});
