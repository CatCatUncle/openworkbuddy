"use strict";
/**
 * `openworkbuddy workflow` 跑着时那块面板（workflow-panel.js）：画什么、不画什么。
 *
 * 钉这几件事：
 *   1. 每一行都不超过给的宽度——超一格就折行，cli.js 按行数往上挪着重画，折了的那行擦不干净，屏幕越画越乱
 *   2. 头只有名字；第几步、用时、token、模型只在最底下那行说一次
 *   3. 分了阶段又放得下：左边一栏阶段，右边只列当前阶段；放不下退成一栏；收尾定格那张一律平铺全部
 *   4. 安静满 IDLE_SHOW_MS 才说「安静 Ns」；子智能体的动静不改主线那一行
 *   5. 前面挂了、后面没跑的不算「做完」，进度条不能走满
 */
const wp = require("../workflow-panel");
const { cols } = require("../text-width");

let n = 0;
const bad = [];
// 一条没过不停下：把没过的全列出来，最后统一让退出码变 1（all.js 只看退出码）
const ok = (name, cond) => { if (cond) n++; else { bad.push(name); console.log(`  ✗ ${name}`); } };

const FLOW = {
  name: "发版前检查：跑测试、看文档、写发布说明，一口气做完再推草稿箱",
  description: "每一步的结论贴给下一步；挂了就停，后面的不跑。这一行故意写得很长很长很长很长很长很长很长很长",
  steps: [
    { name: "test", title: "跑测试", phase: "Build" },
    { name: "types", title: "类型检查和一个特别长特别长的名字", phase: "Build" },
    { name: "docs", phase: "文档" },
    { name: "notes", title: "写发布说明", phase: "Release" },
    { name: "push", title: "推草稿", phase: "Release" },
  ],
};

function running(now) {
  const st = wp.init(FLOW, 0);
  st.model = "gpt-5.4-mini";
  Object.assign(st.steps[0], { status: "ok", t0: 0, t1: 64000, tokens: 48500 });
  Object.assign(st.steps[1], { status: "run", t0: 64000, lastAt: now - 1000, tokens: 12000, activity: "执行 npm run typecheck -- --project 一个很长很长的路径/子目录/tsconfig.json" });
  return st;
}

// ---- 1. 宽度 ----
// 不给下限：给多宽就不超多宽（cli.js 给的是终端宽 − 2，窄分屏终端 30 列上下是常事）
for (const w of [1, 8, 12, 16, 20, 28, 30, 34, 36, 38, 40, 44, 52, 60, 71, 72, 78, 80, 100, 118, 140, 200]) {
  for (const flat of [false, true]) {
    const lines = wp.render(running(95000), { width: w, now: 95000, flat });
    const W = Math.min(w, 140);
    const over = lines.filter((l) => cols(l) > W);
    ok(`宽 ${w}${flat ? "（平铺）" : ""}：没有一行超宽（超了就折行、重画就错位）${over[0] ? "：" + over[0] : ""}`, !over.length);
  }
}
// 按终端列数量：cli.js 传 cols − 2，每行得 ≤ cols − 1
for (const c of [30, 44, 60, 80, 120]) {
  const lines = wp.render(running(95000), { width: c - 2, now: 95000 });
  ok(`终端 ${c} 列：每行 ≤ ${c - 1}`, lines.every((l) => cols(l) <= c - 1));
}
{
  const narrow = wp.render(running(95000), { width: 28, now: 95000 });
  ok("窄到 28：缩名字栏，耗时照样右对齐（不是退成只截）", narrow.some((l) => l.includes("跑测试") && l.endsWith("1m04s ") && cols(l) === 28));
  const tiny = wp.render(running(95000), { width: 10, now: 95000 });
  ok("窄到 10：只截不对齐，名字开头还认得出", tiny.some((l) => l.includes("⏺ 类型")));
  // 阶段名很长：两栏的框头、一栏的小标题都得截
  const longPhase = { ...FLOW, steps: FLOW.steps.map((s, i) => (i < 2 ? { ...s, phase: "构建阶段：跑全部测试、类型检查、打包、签名、公证、上传到发布平台再回来核对哈希" } : s)) };
  const st = running(95000);
  const lp = wp.init(longPhase, 0);
  lp.steps.forEach((s, i) => Object.assign(s, st.steps[i], { name: s.name, phase: s.phase }));
  for (const w of [78, 60]) {
    const lines = wp.render(lp, { width: w, now: 95000 });
    ok(`阶段名很长、宽 ${w}：框头/小标题也不超宽`, lines.every((l) => cols(l) <= w));
  }
  const two = wp.render(lp, { width: 78, now: 95000 });
  ok("阶段名很长：框头截名字，不截「· N 步」", /…( · 2 步 )─*╮$/.test(two.find((l) => l.startsWith("╭")) || ""));
}
{
  const lines = wp.render(running(95000), { width: 100, now: 95000 });
  const box = lines.filter((l) => /^[│╭╰]/.test(l));
  ok("框线那几行一样宽（右边的 │ 对得齐）", box.length > 2 && box.every((l) => cols(l) === cols(box[0])));
}

// ---- 2. 头和底栏 ----
{
  const lines = wp.render(running(95000), { width: 100, now: 95000 });
  ok("头一行是名字", lines[0].startsWith(" 发版前检查") && lines[0].includes("推草稿箱"));
  ok("名字太长：截断补 …", wp.render(running(95000), { width: 50, now: 95000 })[0].endsWith("…"));
  ok("头一行不重复进度（底栏说过了）", !/步 ·/.test(lines[0]));
  const foot = lines[lines.length - 1];
  ok("底栏：进度条 + 1/5 + 用时 + token + 模型", /▰+▱+ {2}1\/5 · 1m35s · ↓ 60\.5k tokens · gpt-5\.4-mini$/.test(foot));
  const narrow = wp.render(running(95000), { width: 44, now: 95000 });
  ok("窄了先丢模型名，不折行", !narrow[narrow.length - 1].includes("gpt-5.4-mini") && narrow[narrow.length - 1].includes("tokens"));
  ok("步骤行不写模型（几步都是同一个，写了是噪音）", !lines.slice(1, -1).some((l) => l.includes("gpt-5.4-mini")));
  ok("没写 title 的步骤用 name", wp.init(FLOW).steps[2].name === "docs" && wp.init(FLOW).steps[0].name === "跑测试");
}

// ---- 3. 分栏 ----
{
  const two = wp.render(running(95000), { width: 100, now: 95000 });
  ok("放得下：两栏，左边列阶段，当前阶段带 ❯ 和进度", two.some((l) => l.includes("❯ 1 Build 1/2")) && two.some((l) => l.includes("3 Release")));
  const rows = two.filter((l) => l.startsWith("│")); // 名字和说明那两行里也有这几个词，只看框里的
  ok("右边只列当前阶段的步骤", rows.some((l) => l.includes("跑测试")) && !rows.some((l) => l.includes("写发布说明")));
  const one = wp.render(running(95000), { width: 60, now: 95000 });
  ok("放不下：退成一栏，阶段当小标题，步骤全列", !one.some((l) => l.includes("│")) && one.some((l) => l.includes("❯ 1 Build")) && one.some((l) => l.includes("写发布说明")));
  const flat = wp.render(running(95000), { width: 100, now: 95000, flat: true });
  ok("定格那张：平铺全部、没有「当前」", !flat.some((l) => l.includes("│")) && flat.some((l) => l.includes("写发布说明")) && !flat.some((l) => l.includes("❯")));
  const single = wp.render(wp.init({ steps: [{ name: "a" }, { name: "b" }] }), { width: 100 });
  ok("没写 phase：一栏、不出阶段标题", single.length === 4 && !single.some((l) => l.includes("❯") || l.includes("│")));
}

// ---- 4. 一行里说什么 ----
{
  const row = (st, now) => wp.render(st, { width: 100, now, flat: true }).find((l) => l.startsWith(" ⏺ 类型检查") || l.startsWith(" ○ 类型检查"));
  const st = running(95000);
  ok("跑着：token · 在干什么 · 右边走秒", /⏺ 类型检查.*12k tok · 执行 npm run typecheck.*31s $/.test(row(st, 95000)));
  ok("在干什么太长就截", row(st, 95000).includes("…"));
  st.steps[1].lastAt = 64000;
  ok(`安静不满 ${wp.IDLE_SHOW_MS / 1000}s 不说`, !row(st, 64000 + wp.IDLE_SHOW_MS - 1000).includes("安静"));
  ok(`安静满 ${wp.IDLE_SHOW_MS / 1000}s 才说，盖掉「在干什么」`, row(st, 64000 + 36000).includes("安静 36s") && !row(st, 64000 + 36000).includes("typecheck"));
  ok("闪：跑着那个图标交替空心", wp.render(st, { width: 100, now: 95000, blink: true, flat: true }).some((l) => l.includes("○ 类型检查")));
  ok("做完那行：✔ + 用了多久", wp.render(st, { width: 100, now: 95000, flat: true }).some((l) => /^ ✔ 跑测试 .*48\.5k tok.* 1m04s $/.test(l)));
  Object.assign(st.steps[1], { status: "fail", t1: 70000, error: "退出码 2" });
  for (let k = 2; k < 5; k++) st.steps[k].status = "skip";
  const fin = wp.render(st, { width: 100, now: 99000, flat: true });
  ok("挂了那行：✗ + 原因", fin.some((l) => /✗ 类型检查.*退出码 2/.test(l)));
  ok("后面没跑的：⊘ 说清楚为什么", fin.filter((l) => l.includes("⊘") && l.includes("前面没成，没跑")).length === 3);
  ok("★没跑的不算做完★ 进度 2/5，条没走满", /2\/5/.test(fin[fin.length - 1]) && fin[fin.length - 1].includes("▱"));
  const painted = wp.render(st, { width: 100, now: 99000, flat: true, paint: (s, k) => `<${k}>${s}` });
  ok("上色走 paint，kind 只有这几种", painted.join("").match(/<(\w+)>/g).every((m) => ["<dim>", "<ok>", "<fail>", "<run>", "<title>", "<sel>"].includes(m)));
}

// ---- 5. 事件 ----
{
  const s = wp.init(FLOW).steps[0];
  wp.feed(s, { type: "step_start", step: 1 }, { now: 10 });
  ok("开想：思考中", s.activity === "思考中" && s.lastAt === 10);
  wp.feed(s, { type: "tool_use", name: "read_file", title: "读 report_v2.md" }, { now: 20, toolLine: (e) => e.title });
  ok("调工具：那行写动词+对象，文件名原样", s.activity === "读 report_v2.md");
  wp.feed(s, { type: "text", delta: "子智能体说话", depth: 1 }, { now: 30 });
  wp.feed(s, { type: "tool_use", name: "grep", depth: 1 }, { now: 30 });
  ok("子智能体的动静不改那一行（但算有动静）", s.activity === "读 report_v2.md" && s.lastAt === 30);
  wp.feed(s, { type: "step_usage", prompt: 1000, completion: 234 }, { now: 40 });
  ok("token：主线累计", s.tokens === 1234);
  wp.feed(s, { type: "text", delta: "好" }, { now: 50 });
  ok("写回答", s.activity === "在写回答");
}
// 长工具报进度（tool_progress）：主线那行换成 label，而且算有动静——渲染十分钟，不能被说成「安静 600s」
{
  const s = wp.init(FLOW).steps[0];
  wp.feed(s, { type: "tool_use", id: "c1", name: "render_motion", title: "渲染 a.html" }, { now: 10, toolLine: (e) => e.title });
  wp.feed(s, { type: "tool_progress", id: "c1", name: "render_motion", depth: 0, stage: "render", done: 432, total: 900, label: "渲染帧 432/900 · 30fps" }, { now: 70000 });
  ok("进度：那行换成 label", s.activity === "渲染帧 432/900 · 30fps");
  ok("进度：算有动静（lastAt 跟着走）", s.lastAt === 70000);
  wp.feed(s, { type: "tool_progress", id: "c9", depth: 1, stage: "tts", done: 1, total: 3, label: "配音 1/3 段" }, { now: 71000 });
  ok("子智能体的进度不改主线那行（但算有动静）", s.activity === "渲染帧 432/900 · 30fps" && s.lastAt === 71000);
  wp.feed(s, { type: "tool_progress", id: "c1", depth: 0, stage: "encode", pct: 40 }, { now: 72000 });
  ok("没带 label 的进度不把那行清空", s.activity === "渲染帧 432/900 · 30fps" && s.lastAt === 72000);
  // 反向对照：刚才那几条要是没进 feed，安静计时会从 10 算起——这把尺子是真量得出「有没有动静」的
  const q = wp.init(FLOW).steps[0];
  wp.feed(q, { type: "tool_use", id: "c1", name: "render_motion", title: "渲染 a.html" }, { now: 10, toolLine: (e) => e.title });
  ok("负对照：不报进度的话 lastAt 停在开跑那一刻", q.lastAt === 10 && q.activity === "渲染 a.html");
}

// ---- 6. 数字 ----
ok("dur", wp.dur(12000) === "12s" && wp.dur(185000) === "3m05s" && wp.dur(3720000) === "1h02m" && wp.dur(-5) === "0s");
ok("tok", wp.tok(812) === "812" && wp.tok(48500) === "48.5k" && wp.tok(12000) === "12k" && wp.tok(1.6e6) === "1.6m");
ok("bar", wp.bar(2, 8, 8) === "▰▰▱▱▱▱▱▱" && wp.bar(0, 0, 4) === "▱▱▱▱");

if (bad.length) {
  console.log(`❌ workflow 面板：${bad.length} 条没过（过了 ${n} 条）`);
  process.exit(1);
}
console.log(`✅ workflow 面板：${n} 条断言全过（不超宽、头尾不重复、分栏/平铺、安静多久才说、没跑的不算做完）`);
