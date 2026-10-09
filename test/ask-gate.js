// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 弹给用户那一问之前的那道闸：这一问，非得用户本人答不可吗。
 *
 * 这个功能的全部价值也在**它什么时候不出手**——它拦掉一句废问，用户根本不会注意到；
 * 它拦错一个真岔路口，用户也不会立刻注意到，只会在半小时后发现整件事做歪了。
 * 所以要守的全是边界：
 *
 *   1. 该不该花这道题的钱 —— 开关没开不问、没配判断模型不问、**一轮里的头一问不问**
 *      （开工前问一题本来就是对的），一字不差又问一遍的也不问（那是白拦，不是白花钱，
 *      所以开关关着也拦）。
 *   2. 拦的门槛 —— 两边错得不一样重：放行一句废问，用户白点一下；拦错一个真岔路口，
 *      agent 替他挑了一条，整件事可能白做。所以门槛比通用的 0.7 严，按 0.8 收。
 *   3. 只少问，不多问 —— 它只能把「问」变成「不问」，绝不会凭空多弹一句。
 *   4. 是非题和单选题打架时，按「照旧弹出去」收场 —— 归类落在放行那几类里就不拦，
 *      宁可白花一道题的钱，也不能吞掉一个说得上名字的岔路。
 *   5. 闸坏了要退回老行为 —— 没配、答不上、问不成、异常，一律照旧弹给用户，而且要留痕。
 *   6. 拦了得有活路 —— 回执里要写清「真是岔路就把岔在哪说清楚再问一次」，
 *      不能只丢一句「不许问」，那等于把 agent 堵死在这儿。
 *   7. 问过的要记住 —— 真弹出去、用户答过的那几问也得记一笔，
 *      不然这道闸只看得见自己拦过什么，看不见用户已经答过什么。
 *   8. 答过的压缩也压不掉 —— 用户答过的、中途补充的钉在系统提示词里，压缩摘要里机械地记一行；
 *      长任务压过几轮之后，模型照样看得见用户选了什么，不会换个说法再问一遍。
 *
 * 跑法：node test/ask-gate.js
 * 不花钱、不出外网：判断模型那一趟在这儿是替换掉的假函数。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { mod } = require("./lib/mod");

const ROOT = path.join(__dirname, "..");
// 赶在 require 生产模块之前：不然单独跑时 trace 记进用户真在用的 workspace/（见 test/lib/own-home.js）
require("./lib/own-home")("ask-gate");
const ag = require(mod("ask-gate"));
const systemone = require(mod("systemone"));
const jev = require(mod("jev"));
const tools = require(mod("tools"));
const { createAgentRuntime } = require(mod("agent"));
const { McpManager } = require(mod("mcp"));
const { route, needQuestions, askState, readNeed, skipNote, dupNote, flat, NEED_KEY, KIND_KEY, NEED_MIN, KIND_CHOICES, SKIP_KINDS } = ag;

let pass = 0, fail = 0, finished = false;
// 这一套里有真跑 agent 的用例。跑不到收尾就退出、退出码还是 0，CI 看就是一片绿——
// 判定器自己会骗人，所以钉一道：没走到最后一行就算红。
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});

function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 一条答案长什么样：sure 是 jev 那边按概率算出来的，这儿照同一把尺子造 */
const need = (value, sure) => ({ key: NEED_KEY, value, sure: sure === undefined ? systemone.sureOfNoul(value) : sure });
const kind = (value) => ({ key: KIND_KEY, value });
const out = (...answers) => ({ ok: true, answers });

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 这道题该不该花钱（免费的尺子先量）");
  // ─────────────────────────────────────────────────────────────
  {
    const on = { on: true, ready: true };
    const prior1 = [{ q: "报告交 Word 还是 PDF？", a: "PDF" }];

    eq(route({ ...on, question: "封面走生图还是排版截图？", prior: [] }).route, "ask",
      "★一轮里的头一问永远放行★ 开工前问一题本来就是对的，出问题的从来是第二第三问");
    eq(route({ ...on, question: "抓数据用 axios 还是 node-fetch？", prior: prior1 }).route, "judge",
      "★问过别的了，这一问才值一道题★");
    eq(route({ ...on, question: "还继续吗？", prior: [{ q: "还继续吗?", a: "继续" }] }).route, "dup",
      "★一字不差又问一遍：白拦，不花钱★ 标点和全半角不该成为「换了个问题」");
    eq(route({ on: false, ready: true, question: "还继续吗", prior: prior1 }).route, "ask",
      "★没打开就一分钱不花★ 它花的是后台的钱，没人点确认");
    eq(route({ on: false, ready: false, question: "还继续吗？", prior: [{ q: "还继续吗?", a: "继续" }] }).route, "dup",
      "★一字不差又问一遍，开关关着也拦★ 这条不花钱，不该躲在管花钱的开关后面（开关默认关，以前这道拦截从来没生效过）");
    eq(route({ on: false, ready: false, question: "要继续吗？", prior: [{ q: "还继续吗?", a: "继续" }] }).route, "ask",
      "  └（对照）开关关着、换了个字：照旧弹，不花钱——关着的时候只拦一字不差的那种");
    eq(route({ on: "true", ready: true, question: "还继续吗", prior: prior1 }).route, "ask",
      "  └ 开关写成字符串 \"true\" 也不算开：只认真正的 true，别让一个手改的配置悄悄把闸打开");
    eq(route({ on: true, ready: false, question: "还继续吗", prior: prior1 }).route, "ask",
      "  └ 没配判断模型：照旧弹出去");
    eq(route({ ...on, question: "   ", prior: prior1 }).route, "ask",
      "  └ 空问句不判：上游那条规矩已经挡了，轮不到这儿");
    eq(route({}).route, "ask",
      "  └ 什么都没传也不炸，而且默认是放行（这道闸自己坏了不能把用户想答的那一问吞了）");
    eq(route({ ...on, question: "x", prior: "不是数组" }).route, "ask",
      "  └ prior 不是数组当成「一问都没问过」：按头一问放行，不按「问过了」去判");

    // 拦下过的也算问过：同一句话被拦一次、原样再来一次，第二次不该再花钱判一遍
    const r2 = route({ ...on, question: "我写完前三节了，要继续吗", prior: [{ q: "我写完前三节了，要继续吗", skipped: true }] });
    eq(r2.route, "dup", "★拦下过的也算「问过了」★ 不然原样再来一次又得花一道题的钱");
    eq(r2.dup.skipped, true, "  └ 而且记得住那次是被拦的，不是用户答过的（回执两种写法不一样）");

    // 负向对照：判据要是拿原串直接比，标点不同的那条就会变成 judge（白花一道题，还会弹第二次）
    ok("还继续吗？" !== "还继续吗?", "  └（对照）那两句原串确实不相等，所以上面测的是折叠后的形，不是字面相等");
    ok(flat("还 继续吗？") === flat("还继续吗?"), "  └（对照）折叠后才相等：空白、中英文问号都抹平了");
    ok(flat("还继续吗") !== flat("要继续吗"), "★别折叠过头★ 换了个字就是另一个问题，不能当重复拦掉");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 问出去的那道题");
  // ─────────────────────────────────────────────────────────────
  {
    const qs = needQuestions();
    const keys = Object.keys(qs);
    eq(keys.length, 2, "★只问两道★ 一道拍板、一道把理由说人话。它是来省用户一次打断的，自己不能变成一笔大花销");
    ok(keys.includes(NEED_KEY) && keys.includes(KIND_KEY), "  └ 题名就是取答案用的那两个常量（两边必须是同一份）");
    const norm = systemone.normalizeQuestions(qs);
    eq(norm.errs.length, 0, "  └ 过得了 systemone 的排版检查（真发出去不会被 400 打回来）", norm.errs);
    eq(norm.questions[NEED_KEY].type, "noul", "  └ 拍板那道是是非题（要的是一个概率，不是一段话）");
    eq(norm.questions[KIND_KEY].type, "choice", "  └ 归类那道是单选题");

    const ins = norm.questions[NEED_KEY].instructions;
    ok(/算非得问/.test(ins) && /算不必问/.test(ins), "★两边都给了定义★ 只说一边等于把它往那一边推", ins.slice(0, 40));
    ok(/拿不准就当非得问/.test(ins), "★拿不准往哪边倒，得明写★ 不写它就会挑一个漂亮答案，而这儿挑错一边的代价不对称");
    ok(/白做/.test(ins), "  └ 而且把那个代价说出来了：拦错一个真岔路口，整件事可能白做");
    ok(/看选项也能看出来/.test(ins), "  └ 提醒它看选项：真岔路的两个选项得到的东西完全不同，汇报式的选项通常是「继续 / 停下」");

    // 归类表得跟拦不拦那张表对得上：多一个少一个都会让 readNeed 的守卫形同虚设
    for (const k of SKIP_KINDS) ok(Object.prototype.hasOwnProperty.call(KIND_CHOICES, k), `  └ 拦下那几类里的「${k}」在选项表里有定义`);
    ok(!SKIP_KINDS.has("岔路") && !SKIP_KINDS.has("关键信息") && !SKIP_KINDS.has("得你拍板") && !SKIP_KINDS.has("说不清"),
      "★该放行的那几类一个都不在拦截表里★ 包括「说不清」：看不出来就是要弹出去");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 摆给它看的现场");
  // ─────────────────────────────────────────────────────────────
  {
    const st = askState({
      task: "写一份年报",
      question: "我已经把前三节写完了，要继续往下写吗？",
      options: [{ label: "继续", detail: "接着写第四节" }, { label: "先停", detail: "停在这儿" }],
      prior: [{ q: "交 Word 还是 PDF？", a: "PDF" }, { q: "用哪个库抓数据？", skipped: true }],
    });
    ok(/【这一趟在干什么】/.test(st) && /【它想问的这一句】/.test(st) && /【它给的选项】/.test(st) && /【这一轮前面已经问过】/.test(st),
      "★四段各自标好是什么★ 问句、选项、前面问过的是三种性质的证据，糊成一坨它分不清谁是谁");
    ok(/年报/.test(st) && /前三节/.test(st), "  └ 活儿是什么、问的是什么，都在里面");
    ok(/接着写第四节/.test(st), "  └ 选项的 detail 也给了：「选了会得到什么」正是判岔路真假的那把尺子");
    ok(/→ 用户答：PDF/.test(st), "★前面答过什么也得给★ 连环追问只有把前面几问摆在一起才看得出来");
    ok(/这一问被拦下了/.test(st), "  └ 被拦下的那几问也标明白，别让它以为用户答过了");

    ok(/（一个选项都没给）/.test(askState({ question: "在吗" })), "  └ 没给选项要明说，不是留白让它猜");
    ok(/（没有）/.test(askState({ question: "在吗", options: [{ label: "嗯" }] })), "  └ 前面没问过也明说");
    ok(/（没记下来）/.test(askState({ question: "在吗" })), "  └ 不知道在干什么活儿也明说");
    ok(/（没写选了会怎样）/.test(askState({ question: "x", options: [{ label: "光秃秃的选项" }] })),
      "★选项只有 label 没有 detail，要当面点出来★ 那本身就是「这不是个真岔路」的信号");

    const big = askState({
      task: "x".repeat(9999), question: "q".repeat(9999),
      options: Array.from({ length: 20 }, (_, i) => ({ label: "L".repeat(999) + i, detail: "D".repeat(999) })),
      prior: Array.from({ length: 20 }, (_, i) => ({ q: "第" + i + "问：" + "P".repeat(999), a: "A".repeat(999) })),
    });
    ok(big.length < 4000, "★各段都有上限★ 再长的现场，该不该打断人这件事也早在前头露出来了", big.length);
    eq((big.match(/^· /gm) || []).length, ag.OPT_MAX, "  └ 选项最多摆四个（工具本来就只要 2~4 个）");
    eq((big.match(/^\d+\. /gm) || []).length, ag.PRIOR_MAX, "  └ 前面问过的最多摆四问，再往前的判这一问用不上");
    ok(big.includes("第19问") && big.includes("第16问") && !big.includes("第15问") && !big.includes("第0问"),
      "  └ 摆的是最近那四问（16~19），不是最早那四问");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ 读答案（只有一种情况才拦）");
  // ─────────────────────────────────────────────────────────────
  {
    ok(readNeed(out(need(0.04, 0.93), kind("汇报进度"))) !== null,
      "★它说不必问、自己也拿得准、归类也在拦截表里：这才拦★");
    eq(readNeed(out(need(0.04, 0.93), kind("汇报进度"))).label, "汇报进度", "  └ 归类带出来，回执要靠它说人话");
    eq(readNeed(out(need(0.95, 0.9), kind("岔路"))), null, "★它说非得问：照旧弹★ 这道闸只负责少问一句，不负责多拦一句");
    eq(readNeed(out(need(0.04, 0.62), kind("技术路线"))), null,
      "★它说不必问，但自己也拿不准：照旧弹★ 门槛只有 systemone 那一把尺子");
    eq(readNeed(out(need(0.04, 0.93), kind("岔路"))), null,
      "★是非题和单选题打架，按「弹出去」收场★ 宁可白花一道题，也不能吞掉一个说得上名字的岔路");
    eq(readNeed(out(need(0.04, 0.93), kind("说不清"))), null,
      "  └「说不清」也放行：看不出来就是要弹出去");
    eq(readNeed(out(need(0.04, 0.93))), null,
      "  └ 归类那道没答上来也放行：只剩一半证据的时候，默认永远是打扰用户，不是替他做主");
    eq(readNeed(out({ key: NEED_KEY, value: "不必问", sure: 0.99 }, kind("汇报进度"))), null,
      "★答非所问当没答上来★ 万一上游哪天把是非题当单选答了，拿一句话跟 0.5 比大小比出来的东西没有意义");
    eq(readNeed(out()), null, "  └ 一条答案都没有：照旧弹");
    eq(readNeed(null), null, "  └ 整个 out 是 null 也不炸");
    eq(readNeed({ ok: true, answers: [kind("汇报进度")] }), null, "  └ 只有归类没有拍板：照旧弹");

    // 门槛这条线本身要钉住：0.8 是「记忆那道闸」同一档，不是通用的 0.7
    eq(NEED_MIN, 0.8, "★门槛比通用的 0.7 严★ 拦错一个真岔路口比放行一句废问贵得多");
    ok(systemone.SURE_MIN < NEED_MIN, "  └（对照）通用门槛确实更松，所以这一条抬过了", { 通用: systemone.SURE_MIN, 这道闸: NEED_MIN });
    eq(readNeed(out(need(0.04, 0.72), kind("汇报进度"))), null, "  └ 0.72 过得了通用的 0.7，过不了这道闸");
    ok(readNeed(out(need(0.04, 0.72), kind("汇报进度")), 0.7) !== null, "  └（对照）把门槛降到 0.7，同一条答案就拦得下来——证明上一条卡的是门槛，不是别的");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑤ 拦下来那句回执（是给 agent 看的，它得能照着接着干）");
  // ─────────────────────────────────────────────────────────────
  {
    const n = skipNote({ sure: 0.93, label: "汇报进度" });
    ok(/没弹给用户/.test(n), "★明说没弹★ 不能让 agent 以为用户答了个什么");
    ok(/汇报/.test(n) || /接着干/.test(n), "  └ 说清为什么", n.slice(0, 40));
    ok(/93%/.test(n), "  └ 带上确定度：拦一次要留得下判据");
    ok(/最合理默认/.test(n) && /汇报里注明/.test(n), "★告诉它接下来干什么★ 挑个默认往下做，并且在汇报里注明替用户做了什么假设");
    ok(/再问一次/.test(n), "★留一条活路★ 真是选错就白做的岔路，把岔在哪说清楚再问一次——不能只丢一句「不许问」把它堵死");
    ok(/axios|node-fetch|跑几轮|哪个库/.test(skipNote({ sure: 0.9, label: "技术路线" })),
      "  └ 技术路线那一类，回执里直接点明什么算技术路线");
    ok(/查/.test(skipNote({ sure: 0.9, label: "查得到" })), "  └ 自己查得到那一类，让它去查");
    ok(skipNote({ sure: 0.9, label: "" }).length > 30, "  └ 归类是空的也给得出一句像样的话");
    ok(skipNote(null).length > 30, "  └ 传 null 也不炸");

    const d1 = dupNote({ q: "报告交 Word 还是 PDF？", a: "PDF", skipped: false });
    ok(/已经问过/.test(d1) && /PDF/.test(d1), "★重复问：把用户当时的答案还给它★ 不然它拿不到答案只能再瞎猜一次");
    ok(/没在听/.test(d1), "  └ 说清代价：同一个问题问两遍，用户只会觉得你没在听");
    const d2 = dupNote({ q: "要继续吗", skipped: true });
    ok(/没弹出去/.test(d2) && !/照那个答案/.test(d2), "★上次就被拦的，别编一个「用户答过」出来★ 这种得让它自己挑默认");
    ok(dupNote(null).length > 20, "  └ 传 null 也不炸");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑥ 真跑一趟 agent：这道闸到底拦没拦住");
  // ─────────────────────────────────────────────────────────────
  {
    const experts = { list: () => [], get: () => null };
    /** 连问三句的假模型：头一问是真岔路，后两问是汇报和技术路线 */
    const chattyLLM = () => {
      let calls = 0;
      const QS = [
        { question: "封面走 AI 生图还是 HTML 排版截图？", options: [{ label: "AI 生图", detail: "有氛围但风格随机" }, { label: "排版截图", detail: "版式全可控但偏平面" }] },
        { question: "我已经把前三节写完了，要继续往下写吗？", options: [{ label: "继续", detail: "接着写第四节" }, { label: "先停", detail: "停在这儿" }] },
        { question: "抓数据用 axios 还是 node-fetch？", options: [{ label: "axios", detail: "顺手" }, { label: "node-fetch", detail: "轻" }] },
      ];
      return {
        calls: () => calls,
        chat: async () => {
          const i = calls++;
          if (i >= QS.length) return { text: "写完了。", toolCalls: [], stopReason: "end", usage: { prompt: 10, completion: 5 } };
          return {
            text: "问一句。",
            toolCalls: [{ id: "tc_" + i, name: "ask_user", input: QS[i] }],
            stopReason: "tool_use", usage: { prompt: 10, completion: 5 },
          };
        },
      };
    };
    const baseCfg = (agent) => ({
      agent: { max_steps: 6, tool_timeout_ms: 30000, ask_user_timeout_ms: 30000, ...agent },
      decide: { api_key: "假 Key，这趟根本不发网络" },
    });
    ok(jev.status(baseCfg({})).ready === true, "  └（前置）这份假配置在 jev 眼里算「配好了」，否则下面全是在测空气");

    // askMetered 整个换掉：这套测试一分钱不花、一个字节不出网
    const realAsk = jev.askMetered;
    let asked = [];
    const stub = (impl) => { asked = []; jev.askMetered = async (config, args, opts) => { asked.push({ args, opts }); return impl(); }; };

    const runOnce = async (cfg) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-agate-"));
      const llm = chattyLLM();
      const popped = [];           // 真弹到用户面前的那几问
      const notes = [];            // 回给模型的工具结果
      const statuses = [];         // 界面上留的痕
      const rt = createAgentRuntime({ config: cfg, llm, mcpManager: new McpManager(), experts });
      const r = await tools.withWorkspace(dir, () => rt.runTask({
        history: [{ role: "user", content: "做一份竞品报告，带封面" }],
        askUser: async ({ question }) => { popped.push(question); return "随便"; },
        emit: (e) => {
          if (e.type === "ask_user") return;
          if (e.type === "status") statuses.push(e.text);
          if (e.type === "tool_result" && /没弹给用户/.test(String(e.content || ""))) notes.push(String(e.content));
        },
      }));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return { r, popped, statuses, notes, calls: llm.calls() };
    };

    try {
      // A 开着 + 它说「后两问不必问」→ 只有头一问弹到人面前
      stub(() => out(need(0.04, 0.93), kind("汇报进度")));
      const a = await runOnce(baseCfg({ ask_gate: true }));
      eq(a.popped.length, 1, "★★真少打扰了两次★★ 三问里只有头一问弹到了用户面前", a.popped);
      ok(/封面/.test(a.popped[0]), "  └ 弹出去的正是那个真岔路（头一问白放行，压根没判）", a.popped[0]);
      eq(asked.length, 2, "  └ 只为后两问各花了一道题（头一问一分钱不花）");
      ok(/【它想问的这一句】/.test(asked[0].args.state) && /前三节/.test(asked[0].args.state), "  └ 问的时候把现场给它看了");
      ok(/做一份竞品报告/.test(asked[0].args.state), "★用户原话也给了★ 离了「他本来让你干什么」，判不了该不该打断他");
      ok(/→ 用户答：随便/.test(asked[0].args.state), "★真弹出去、答过的那一问也记了一笔★ 不然这道闸只看得见自己拦过什么");
      ok(/封面/.test(asked[1].args.state), "  └ 第二次判的时候，前面两问都在现场里");
      ok(a.statuses.some((s) => /没有弹给你/.test(s)), "★拦了要留痕★ 后台悄悄不干活，表现就是「一切正常」——那是最贵的一种坏", a.statuses);

      // B 对照：开关关着 —— 三问全弹出去，且一分钱不花
      stub(() => out(need(0.04, 0.93), kind("汇报进度")));
      const b = await runOnce(baseCfg({ ask_gate: false }));
      eq(asked.length, 0, "★没打开就一分钱不花★");
      eq(b.popped.length, 3, "★（对照组）不设闸就是打断三次★ A 组只有 1 次", b.popped.length);

      // C 对照：它说「非得问」→ 照旧全弹
      stub(() => out(need(0.95, 0.9), kind("岔路")));
      const c = await runOnce(baseCfg({ ask_gate: true }));
      eq(c.popped.length, 3, "★它说非问不可就照旧弹★ 这道闸只负责少问一句，不负责多拦一句");
      eq(asked.length, 2, "  └ 还是判了两次，只是两次都放行");

      // D 对照：问不成（上游挂了）→ 退回老行为，而且要留痕
      const warns = [];
      const realWarn = console.warn;
      console.warn = (...x) => warns.push(x.join(" "));
      stub(() => { throw new Error("上游 502"); });
      const d = await runOnce(baseCfg({ ask_gate: true }));
      console.warn = realWarn;
      eq(d.popped.length, 3, "★闸坏了退回老行为★ 问不成不能把用户想答的那一问吞了");
      ok(warns.some((w) => /没问成/.test(w)), "★吞掉的异常要留痕★ 悄悄失灵跟一切正常长得一模一样", warns.slice(0, 1));

      // E 对照：它说不必问，但归类落在「岔路」上 → 打架时按「弹出去」收场
      stub(() => out(need(0.04, 0.93), kind("岔路")));
      const e = await runOnce(baseCfg({ ask_gate: true }));
      eq(e.popped.length, 3, "★两道题打架，按弹出去收场★ 同一份答案，只把归类从「汇报进度」换成「岔路」，结果就从拦 2 次变成一次不拦");
    } finally {
      jev.askMetered = realAsk;
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑦ 用户答过的：记成什么样、读不读得回来");
  // ─────────────────────────────────────────────────────────────
  {
    const { answerNote, readAnswer, answeredIn, mergeDecided, summaryLine, pinBlock, INTERJECT_HEAD, DECIDED_MAX, DECIDED_PIN_MAX } = ag;
    const n1 = answerNote("AI 生成水墨插图", "每页配一张水墨意境图");
    eq(n1, "用户的回答：AI 生成水墨插图（这条路你自己写的是：每页配一张水墨意境图——照它做）",
      "  └ 回给模型的那句话一字没变（老会话里存的、e2e 认的都是这句）");
    eq(JSON.stringify(readAnswer(n1)), JSON.stringify({ a: "AI 生成水墨插图", d: "每页配一张水墨意境图" }),
      "★写出去的读得回来★ 用户选的那一项和那条路的承诺分得开");
    eq(readAnswer(answerNote("水墨国风（推荐）")).a, "水墨国风（推荐）", "  └ 选项名自己带括号也不切错");
    eq(readAnswer("等了 300 秒，用户没有回应。按你判断的最合理默认继续做，并在最终汇报里注明你替用户做了什么假设，别再重复问。"), null,
      "★超时没答的不算用户定的★ 那是模型自己挑的默认");
    eq(readAnswer(dupNote({ q: "走哪条路？", a: "AI 生图" })), null, "  └ 被拦下没弹的回执也不算");

    const ask = (id, question, extra) => ({ role: "assistant", text: "", toolCalls: [{ id, name: "ask_user", input: { question, options: [], ...extra } }] });
    const res = (id, content) => ({ role: "tool", results: [{ id, name: "ask_user", content }] });
    const hist = [
      { role: "user", content: "帮我做一个讲《沁园春·长沙》的 PPT" },
      ask("a1", "走哪种视觉风格？"), res("a1", answerNote("水墨国风·留白意境")),
      { role: "user", content: INTERJECT_HEAD + "我的受众是高一的学生。" },
      ask("a2", "画面走哪条路？"), res("a2", answerNote("AI 生成水墨插图", "每页配一张水墨意境图")),
      ask("a3", "要不要加一页课堂小练习？"), res("a3", "等了 300 秒，用户没有回应。按你判断的最合理默认继续做"),
      ask("f1", "开头表单", { form: { recipe: "宣传片" } }), res("f1", answerNote("表单填好了")),
    ];
    const got = answeredIn(hist);
    eq(got.length, 3, "★答过的两问 + 一句插话，一条不多一条不少★ 超时的、配方表单的不算（表单钉在配方那边）", got);
    eq(got[0].a, "水墨国风·留白意境", "  └ 按先后排");
    eq(got[1].said, "我的受众是高一的学生。", "  └ 中途插的话也记，去掉了那个头");
    eq(got[2].d, "每页配一张水墨意境图", "  └ 选中那条路自己写的承诺也带着");

    const sumOf = (line) => ({ role: "user", content: "【系统·上下文压缩】以下是本会话更早内容的自动摘要（原文已归档）：\n## 目标\n做 PPT\n" + line + "\n【读过的文件】无\n【改过的文件】无\n（摘要结束。）" });
    eq(JSON.stringify(answeredIn([sumOf(summaryLine(got))])), JSON.stringify(got),
      "★压缩摘要里那一行读得回来★ 下一趟开跑照它捡，不靠摘要模型转述");
    eq(answeredIn([sumOf(summaryLine(got)), ...hist.slice(4)]).length, 3,
      "  └ 摘要里一份、还没压掉的原文里又一份：并起来不重复");
    eq(answeredIn([{ role: "user", content: summaryLine(got) }]).length, 0,
      "  └ 只认系统写的摘要：用户自己敲一行【用户定过的】不算");
    eq(answeredIn([sumOf("【用户定过的】[{坏的")]).length, 0, "  └ 那一行坏了也不炸，当没有");
    eq(summaryLine([]), "", "  └ 什么都没答过，摘要里就不写这一行");

    const m = mergeDecided([{ q: "走哪种风格？", a: "红色经典" }, { said: "用 ppt master" }], [{ q: "走哪种风格?", a: "水墨国风" }, { said: "用ppt master" }]);
    eq(m.length, 2, "★同一问答过两次只留一条★ 标点、空格不同也算同一问", m);
    eq(m.find((x) => x.q).a, "水墨国风", "★以最后答的那次为准★");
    const many = Array.from({ length: DECIDED_MAX + 5 }, (_, i) => ({ q: `第 ${i} 问？`, a: `答 ${i}` }));
    const capped = mergeDecided(many);
    eq(capped.length, DECIDED_MAX, `  └ 最多留最近 ${DECIDED_MAX} 条`);
    eq(capped[capped.length - 1].a, `答 ${DECIDED_MAX + 4}`, "  └ 丢的是最老的，最近答的留着");

    const pin = pinBlock(got);
    ok(/用户已经答过的/.test(pin) && /历史压缩也不会丢/.test(pin), "★钉进系统提示词的那一段★", pin);
    ok(pin.includes("你问「画面走哪条路？」→ 用户选「AI 生成水墨插图」"), "★问了什么、用户选了什么，一行说清★");
    ok(pin.includes("用户中途补充：「我的受众是高一的学生。」"), "  └ 中途插的话也在");
    ok(/不许悄悄换一条路/.test(pin), "★做不成要先说清再问，不许悄悄换路★ 那趟 PPT 就是换了个说法，把「不生成 AI 图片」塞了回来");
    ok(/问句里自己写的前提不算数/.test(pin), "  └ 问句里夹带的前提不算用户定的");
    eq(pinBlock([]), "", "  └ 什么都没答过就一个字不加，不白占提示词");
    eq(pinBlock(undefined), "", "  └ 没有这份记录也不炸");
    const fat = Array.from({ length: DECIDED_MAX }, (_, i) => ({ q: `第${i}问` + "问".repeat(90), a: "答".repeat(120), d: "路".repeat(80) }));
    const big = pinBlock(fat);
    ok(big.length <= DECIDED_PIN_MAX, `★钉的那段有上限★ ${big.length} ≤ ${DECIDED_PIN_MAX}，再多就是每一步都白付的钱`);
    ok(big.includes(`第${DECIDED_MAX - 1}问`) && !big.includes("第0问"), "  └ 放不下时丢最老的，最近答的那条一定在");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑧ 真跑一趟 agent：答过的选项，压缩过后还在");
  // ─────────────────────────────────────────────────────────────
  {
    const experts = { list: () => [], get: () => null };
    const Q = "《沁园春·长沙》讲课 PPT 的画面走哪条路？";
    const OPTS = [{ label: "纯 SVG 手绘水墨", detail: "矢量画，不花钱" }, { label: "AI 生成水墨插图", detail: "每页配一张水墨意境图" }];
    const PIN = "你问「《沁园春·长沙》讲课 PPT 的画面走哪条路？」→ 用户选「AI 生成水墨插图」";
    const usage = { prompt: 10, completion: 5 };
    /** 照剧本走的假模型：记下每一步的系统提示词；压缩那一下单独认出来，给一份不提选项的摘要 */
    const scriptLLM = (script) => {
      const systems = [];
      let step = 0, compacts = 0;
      return {
        systems,
        compacts: () => compacts,
        chat: async ({ system }) => {
          if (/^你是会话压缩器/.test(String(system || ""))) {
            compacts++;
            // 摘要模型真会这么写：只记得「定了水墨风」，用户点的那一项一个字没提
            return { text: "## 目标\n做讲课 PPT\n## 已完成\n定了水墨风\n## 下一步\n出图", toolCalls: [], stopReason: "end", usage };
          }
          systems.push(String(system || ""));
          const s = script[step++];
          if (!s) return { text: "做完了。", toolCalls: [], stopReason: "end", usage };
          return { text: s.text || "", toolCalls: s.calls || [], stopReason: "tool_use", usage };
        },
      };
    };
    const script = [
      { text: "先问一句。", calls: [{ id: "s1", name: "ask_user", input: { question: Q, options: OPTS } }] },
      // 撑过压缩那道 8000 字的下限：老轮次够肉才压
      { text: "读了一份很长的技能说明。".repeat(900), calls: [{ id: "s2", name: "list_files", input: { path: "." } }] },
      { text: "接着排版。".repeat(80), calls: [{ id: "s3", name: "list_files", input: { path: "." } }] },
      // 压过之后：一字不差又问一遍（判断开关是默认关的）
      { text: "", calls: [{ id: "s4", name: "ask_user", input: { question: Q, options: OPTS } }] },
    ];
    const cfg = {
      agent: { max_steps: 8, tool_timeout_ms: 30000, ask_user_timeout_ms: 30000, compact_threshold_chars: 2000, compact_keep_chars: 200 },
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-apin-"));
    fs.writeFileSync(path.join(dir, "教案.md"), "# 沁园春·长沙\n");
    try {
      const llm = scriptLLM(script);
      const popped = [];
      const statuses = [];
      const history = [{ role: "user", content: "帮我做一个讲《沁园春·长沙》的 PPT" }];
      const rt = createAgentRuntime({ config: cfg, llm, mcpManager: new McpManager(), experts });
      await tools.withWorkspace(dir, () => rt.runTask({
        history,
        askUser: async ({ question }) => { popped.push(question); return "AI 生成水墨插图"; },
        emit: (e) => { if (e.type === "status") statuses.push(e.text); },
      }));
      const S = llm.systems;
      ok(S.length >= 4, "  └（前置）剧本四步都走到了", S.length);
      ok(!S[0].includes(PIN), "  └（对照）答之前，系统提示词里没有这一段");
      ok(S[1].includes(PIN) && S[2].includes(PIN), "★答完下一步起，系统提示词里就钉着用户选了什么★");
      eq(llm.compacts(), 1, "  └（前置）中途真压缩了一次，测的不是空气");
      const head = String(history[0].content || "");
      ok(head.startsWith("【系统·上下文压缩】") && head.includes("【用户定过的】"), "★压缩摘要里机械地记了一行【用户定过的】★", head.slice(0, 300));
      const raw = history.some((e) => e.role === "tool" && (e.results || []).some((r) => String(r.content || "").startsWith("用户的回答：")));
      const sumText = head.replace(/【用户定过的】[^\n]*/, "");
      ok(!raw && !sumText.includes("AI 生成水墨插图"),
        "  └（对照）压完之后，原文里那条答案没了，摘要模型写的那段也没提——不钉住，模型就是在这儿忘的");
      ok(S[3].includes(PIN), "★★压缩过后，系统提示词里照样钉着「AI 生成水墨插图」★★");
      eq(popped.length, 1, "★一字不差又问一遍：没再弹给用户★ 开关关着也拦（以前这道拦截躲在开关后面）", popped);
      const dupRes = history.flatMap((e) => (e.role === "tool" ? e.results || [] : [])).find((r) => r.id === "s4");
      ok(dupRes && /用户当时答的是「AI 生成水墨插图」/.test(dupRes.content), "  └ 回给模型的是用户当时的答案，照着往下做", dupRes && dupRes.content);
      ok(statuses.some((t) => /问过了/.test(t)), "  └ 界面上留了痕：这一问没再弹，为什么", statuses);

      // 下一句话来了：新的一趟从历史里把答案捡回来（原文早被压掉，只剩摘要里那一行）
      history.push({ role: "user", content: "第三页字太小了，改大一点" });
      const llm2 = scriptLLM([]);
      const rt2 = createAgentRuntime({ config: cfg, llm: llm2, mcpManager: new McpManager(), experts });
      await tools.withWorkspace(dir, () => rt2.runTask({ history, askUser: async () => "随便", emit: () => {} }));
      ok(llm2.systems[0] && llm2.systems[0].includes(PIN), "★★下一趟开跑第一步就钉着★★ 不靠摘要模型转述，靠摘要里机械记的那一行");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} 弹给用户那一问之前那道闸（免费尺子·出题·现场·读答案·回执·真跑一趟·答过的钉住）${pass} 项通过${fail ? `，${fail} 项失败` : ""}`);
  finished = true;
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试自己炸了：", e);
  process.exit(1);
});
