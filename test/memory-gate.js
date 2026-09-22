"use strict";
/**
 * 往长期记忆里写之前的那道闸：这句话下个月还用得上吗。
 *
 * 这个功能的贵和险都在同一处——记忆会跟着往后每一趟任务进系统提示词。所以两个方向都得守：
 *
 *   1. 该不该花这道题的钱 —— 用户自己敲的不判、开关没开不判、没配判断模型不判、
 *      本来就会被现成规矩拒掉的（空的/太长/像凭据/像能力断言）不判。
 *   2. 什么样的答案才配吞掉一条记忆 —— 它得说「用不上」，而且自己拿得准（0.8，比通用的还严）。
 *      判错的代价是用户亲口交代的偏好没记住，而这种错没人发现得了，用户只会觉得「又忘了」。
 *   3. 只能把「记」变成「不记」 —— 反过来不行：正则拒掉的，这道闸救不回来。
 *   4. 闸坏了退回老行为 —— 问不成、答不上、说不准，一律照旧记下，并且留痕。
 *   5. 拒了要能照着改 —— 回执必须说清为什么不收、该记什么才对，不然 agent 只会原样再记一遍。
 *
 * 跑法：node test/memory-gate.js
 * 不花钱、不出外网：判断模型那一趟是替换掉的假函数；记忆落在临时目录，不碰用户那份。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

// 必须在 require 之前：memory.js 在加载那一刻就把数据目录定死了。
// 落到用户自己那份 data/ 里等于测试污染真数据——这条比测试本身重要
const DATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-memgate-data-"));
process.env.OPENWORKBUDDY_DATA_DIR = DATA_TMP;

const ROOT = path.join(__dirname, "..");
const mg = require(path.join(ROOT, "memory-gate"));
const systemone = require(path.join(ROOT, "systemone"));
const jev = require(path.join(ROOT, "jev"));
const memory = require(path.join(ROOT, "memory"));
const tools = require(path.join(ROOT, "tools"));
const { needsJudge, keepQuestions, keepState, readKeep, dropNote, KEEP_KEY, KIND_KEY, KEEP_MIN, TEXT_CHARS } = mg;

let pass = 0, fail = 0, finished = false;
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

/** 一条是非题的答案：sure 按 jev 那边的同一把尺子算 */
const ans = (value, sure) => ({ key: KEEP_KEY, value, sure: sure === undefined ? systemone.sureOfNoul(value) : sure });
const kind = (label) => ({ key: KIND_KEY, value: label });
const out = (...answers) => ({ ok: true, answers });

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 这道题该不该花钱（白给的尺子先量）");
  // ─────────────────────────────────────────────────────────────
  {
    const base = { text: "周报只要三段", source: "agent", on: true, ready: true };
    eq(needsJudge(base), true, "★开关开着、配了模型、agent 自己要记的：这才轮到判断模型★");
    eq(needsJudge({ ...base, on: false }), false, "  └ 开关关着不判");
    eq(needsJudge({ ...base, on: undefined }), false, "  └ 没这个字段也算关着（默认必须是关的）");
    eq(needsJudge({ ...base, on: "true" }), false, "★写成字符串不算开★ 配置里手抖写个 \"true\"，命令原文就默默发出去了");
    eq(needsJudge({ ...base, ready: false }), false, "  └ 没配判断模型不判");
    eq(needsJudge({ ...base, source: "user" }), false,
      "★用户自己敲的那份记忆不归它管★ 他说记就是记，轮不到模型评审");
    eq(needsJudge({ ...base, text: "   " }), false, "  └ 空的不判（现成的规矩已经拒了）");
    eq(needsJudge({ ...base, text: "字".repeat(TEXT_CHARS + 1) }), false, "  └ 超长的不判（同上）");
    eq(needsJudge(), false, "  └ 什么都不给也不许判");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 问出去的那两道题");
  // ─────────────────────────────────────────────────────────────
  {
    const qs = keepQuestions();
    const keys = Object.keys(qs);
    eq(keys.length, 2, "  └ 只问两道：一道拍板，一道把理由说人话");
    eq(qs[KEEP_KEY].type, "noul", "  └ 拍板那道是是非题");
    eq(qs[KIND_KEY].type, "choice", "  └ 归类那道是单选");
    const norm = systemone.normalizeQuestions(qs);
    ok(norm && norm.questions && Object.keys(norm.questions).length === 2, "★两道题上游收得下★ 本地先规整一遍，省得拿 zod 的报错去猜哪儿写错了");
    const inst = qs[KEEP_KEY].instructions;
    ok(/下个月/.test(inst), "  └ 问的是「下个月还成不成立」，不是「这条好不好」");
    ok(/进系统提示词|一直生效/.test(inst), "  └ 告诉它记下来意味着什么（代价说清楚，它才判得准）");
    ok(/看不出来就别硬挑一边/.test(inst), "  └ 明说拿不准可以不站队");
    const ch = Object.keys(mg.KIND_CHOICES);
    ok(ch.length >= 4 && ch.includes("说不清"), "  └ 归类里留了「说不清」这一格", ch);
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 摆给它看的现场");
  // ─────────────────────────────────────────────────────────────
  {
    const st = keepState({ text: "这次把端口改成了 8081", task: "把服务端口调一下" });
    ok(st.includes("这次把端口改成了 8081"), "  └ 要记的那句话在里头");
    ok(st.includes("把服务端口调一下"), "  └ 这一趟在干什么也在（不知道是什么活儿，判不出是不是临时的）");
    ok(st.indexOf("【它想记的那句话】") < st.indexOf("【这一趟在干什么】"),
      "★两段各自标好是什么★ 糊成一坨它分不清哪句是要记的");
    ok(keepState({ text: "x" }).includes("（没记下来）"), "  └ 没有任务标题就直说没有，别留个空让它自己猜");
    const long = keepState({ text: "字".repeat(9999), task: "活".repeat(9999) });
    ok(long.length < 1200, "  └ 两段都有上限（别拿一整份任务日志去付 token）——这条写死数，拿被测的常量当尺子等于没拦", long.length);
    eq(TEXT_CHARS, memory.MAX_TEXT, "★跟记忆本身的上限同一把尺子★ 比它短就是拿半句话去判，比它长白搞");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ 什么样的答案才配吞掉一条记忆");
  // ─────────────────────────────────────────────────────────────
  {
    ok(readKeep(out(ans(0.03), kind("临时"))) !== null, "★说用不上、而且拿得准：这条不收★");
    eq(readKeep(out(ans(0.97), kind("偏好"))), null, "  └ 说还用得上：照旧记");
    eq(readKeep(out(ans(0.5))), null, "  └ 正中间：照旧记（记错的代价比不记小）");
    eq(readKeep(out(ans(0.35))), null, "★六成把握不许吞记忆★ 确定度 30%，离 0.8 差得远");
    eq(readKeep(out({ key: KEEP_KEY, value: 0.03, sure: 0.79 })), null, "  └ 差一点点也是不到（0.79 < 0.8）");
    ok(readKeep(out({ key: KEEP_KEY, value: 0.03, sure: 0.81 })) !== null, "  └ 过线了才算");
    eq(readKeep(out()), null, "  └ 一条答案都没有：照旧记");
    eq(readKeep({ ok: true, answers: [kind("临时")] }), null, "  └ 只答了归类那道、拍板那道没答：照旧记");
    eq(readKeep(out({ key: KEEP_KEY, value: "用不上了", sure: 0.99 })), null,
      "★答非所问也当没答上来★ 拿一句话跟 0.5 比大小，比出来的东西没有意义，却能凭空吞掉一条记忆");
    eq(readKeep(out(ans(0.03)), 0.99), null, "  └ 门槛能调严（0.94 的确定度过不了 0.99）");
    ok(readKeep(out(ans(0.03)), "不是数") !== null, "  └ 门槛给个不是数的，退回默认那道 0.8，不许当成 0");
    eq(KEEP_MIN, 0.8, "★这道闸的门槛比通用的 0.7 严★ 吞掉一条真偏好，用户只会觉得「说过的事它又忘了」");
    const d = readKeep(out(ans(0.03), kind("临时")));
    eq(d.label, "临时", "  └ 归类原样带回来，给回执用");
    ok(d.sure > 0.9 && d.p === 0.03, "  └ 概率和确定度都带回来（卡上要写得出来）", d);
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑤ 拒了要能照着改");
  // ─────────────────────────────────────────────────────────────
  {
    const n = dropNote(readKeep(out(ans(0.03), kind("临时"))));
    ok(/没记/.test(n), "  └ 第一句就说清没记（别让它以为记住了其实没有）");
    ok(/确定度/.test(n), "  └ 写明有多确定（凭什么吞我这条，得让人看得见）");
    ok(/8081|规矩|背后/.test(n), "★告诉它该记成什么样★ 只说不收，它下一句就原样再记一遍");
    ok(/过程|中间状态/.test(n), "  └ 「临时」那一类说的是它自己的理由，不是一句万能话", n);
    const n2 = dropNote(readKeep(out(ans(0.03), kind("能力"))));
    ok(/试一次就知道/.test(n2), "  └ 能力断言那一类给的是另一套说法", n2);
    ok(n2 !== n, "  └ 两类理由不一样（一句万能话等于没说）");
    ok(dropNote(null).length > 20, "  └ 没有归类也得说得出话来，不许崩");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑥ 只能把「记」变成「不记」");
  // ─────────────────────────────────────────────────────────────
  {
    const secret = memory.preflight({ text: "阿里云的密码是 hunter2", source: "agent" });
    eq(secret.ok, false, "  └ 像凭据的，现成的规矩照样拒");
    const stale = memory.preflight({ text: "内置 generate_image 工具的水印问题已解决", source: "agent" });
    eq(stale.ok, false, "★正则拒掉的，这道闸救不回来★ 它只能往严了走，不能往松了走");
    eq(memory.preflight({ text: "内置 generate_image 工具的水印问题已解决", source: "user" }).ok, true,
      "  └ 但用户自己写的那条老规矩没变（能力断言只拦 agent 自己记的）");
    eq(memory.preflight({ text: "  周报   只要三段  " }).text, "周报 只要三段", "  └ 归一化的结果原样交出去，两边别各洗一遍");
    eq(memory.preflight({ text: "字".repeat(memory.MAX_TEXT + 1) }).ok, false, "  └ 超长照拒");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑦ 接线：remember 这个工具真跑一遍");
  // ─────────────────────────────────────────────────────────────
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-memgate-"));
    const cfg = { decide: { api_key: "假的-只为过配没配那道闸", route: "typesafe" }, providers: [] };
    const real = jev.askMetered;
    let asked = [];
    const stub = (reply) => { jev.askMetered = async (_c, args, o) => { asked.push({ args, o }); return typeof reply === "function" ? reply(args) : reply; }; };
    const run = (input, mem, extra) => tools.withWorkspace(tmp, () =>
      tools.executeTool("remember", input, { memory: { user: "u1", ...mem }, decideConfig: cfg, ...(extra || {}) }));
    const stored = () => memory.list("u1").map((x) => x.text);

    try {
      // A 判「下个月用不上」→ 不收，而且真的没落盘
      asked = [];
      stub(out(ans(0.03), kind("临时")));
      const a = await run({ text: "这次把 config.json 第 3 行的端口改成了 8081" }, { gate: true, task: "调一下服务端口" });
      eq(a.isError, true, "★判用不上就不收★ 收了它会跟着往后每一趟任务进系统提示词");
      ok(!stored().some((t) => /第 3 行/.test(t)), "  └ 真的没落盘（拦在写之前，不是写完再说）");
      ok(/没记/.test(a.content) && /确定度/.test(a.content), "  └ 回执说清了没记、有多确定", a.content);
      eq(asked.length, 1, "  └ 花了一道题的钱");
      ok(/记之前/.test((asked[0].o || {}).meta || ""), "  └ 记账上标明是哪一处花的", (asked[0].o || {}).meta);
      ok(/调一下服务端口/.test(asked[0].args.state), "  └ 这一趟在干什么也发过去了");
      ok(asked[0].args.timeoutMs > 0 && asked[0].args.timeoutMs <= 10000,
        "  └ 卡在一次 remember 前面，等不起默认那 20 秒", asked[0].args.timeoutMs);

      // B 判「还用得上」→ 照常记下
      asked = [];
      stub(out(ans(0.96), kind("偏好")));
      const b = await run({ text: "周报只要三段：进展/问题/下周计划" }, { gate: true, task: "写周报" });
      eq(b.isError, false, "★判还用得上就照常记★ 一个总在误杀的闸，用户第一件事是去把它关掉");
      ok(stored().some((t) => /周报只要三段/.test(t)), "  └ 落盘了");
      eq(asked.length, 1, "  └ 花了一道题");

      // C 开关没开：一道题都不花，行为跟今天一模一样
      asked = [];
      const c = await run({ text: "他的产品叫「青禾」" }, { gate: false, task: "改文案" });
      eq(c.isError, false, "★默认那条路一点没变★");
      ok(stored().some((t) => /青禾/.test(t)), "  └ 照样记下");
      eq(asked.length, 0, "  └ 开关没开就一分钱不花");

      // D 本来就会被拒的：不该再花这道题的钱
      asked = [];
      const d = await run({ text: "内置 run_node 已经支持联网了" }, { gate: true, task: "查个东西" });
      eq(d.isError, true, "  └ 能力断言照样拒（现成的规矩先拦）");
      eq(asked.length, 0, "★本来就拒的不花钱★ 花了也改不了结论");
      const d2 = await run({ text: "后台的口令是 假的不是真的-8x2" }, { gate: true, task: "配模型" });
      eq(d2.isError, true, "  └ 像凭据的照样拒");
      eq(asked.length, 0, "  └ 也不花钱");

      // E 没配判断模型：照旧记
      asked = [];
      const e = await tools.withWorkspace(tmp, () =>
        tools.executeTool("remember", { text: "交付物一律不要水印" }, { memory: { user: "u1", gate: true } }));
      eq(e.isError, false, "★没配判断模型，一切照旧★");
      ok(stored().some((t) => /不要水印/.test(t)), "  └ 记下了");
      eq(asked.length, 0, "  └ 也不会去发请求");

      // F 问不成：照旧记下，而且要留痕
      asked = [];
      jev.askMetered = async () => { throw new Error("上游 500"); };
      const warns = [];
      const realWarn = console.warn;
      console.warn = (...x) => warns.push(x.join(" "));
      const f = await run({ text: "他常用的部署脚本是 deploy.sh" }, { gate: true, task: "部署" });
      console.warn = realWarn;
      eq(f.isError, false, "★闸自己坏了不能把记忆吞了★ 退回老行为：照旧记下");
      ok(stored().some((t) => /deploy\.sh/.test(t)), "  └ 落盘了");
      ok(warns.some((w) => /长期记忆/.test(w)), "  └ 但要留痕：后台吞异常等于这个功能悄悄没了", warns);

      // G 上游回 ok:false（额度满、Key 不对这一类）：跟异常同样退回老路
      asked = [];
      jev.askMetered = async () => ({ ok: false, error: "额度不够了" });
      const warns2 = [];
      const realWarn2 = console.warn;
      console.warn = (...x) => warns2.push(x.join(" "));
      const g = await run({ text: "他们公司周五下午不开会" }, { gate: true, task: "排日程" });
      console.warn = realWarn2;
      eq(g.isError, false, "★上游说不行，也只是退回老路★ 「问不成」跟「问了说用不上」长得完全不一样");
      ok(stored().some((t) => /周五下午/.test(t)), "  └ 记下了");
      ok(warns2.some((w) => /额度不够/.test(w)), "  └ 原话留在日志里，别翻译成别的死因", warns2);

      // H 答非所问：照旧记下
      asked = [];
      stub(out({ key: KEEP_KEY, value: "我觉得用不上", sure: 0.99 }));
      const h = await run({ text: "他习惯用 pnpm 不用 npm" }, { gate: true, task: "装依赖" });
      eq(h.isError, false, "  └ 答非所问 = 没答上来 = 照旧记");
      ok(stored().some((t) => /pnpm/.test(t)), "  └ 落盘了");
    } finally {
      jev.askMetered = real;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑧ 摆出来了没有（开关存在但找不到＝没有）");
  // ─────────────────────────────────────────────────────────────
  {
    const ui = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
    ok(/id="ag-mgate"/.test(ui), "★设置里摆得出来★");
    ok(/memory_gate:\s*pane\.querySelector\("#ag-mgate"\)\.checked/.test(ui), "  └ 勾了存得回去");
    ok(/\$\{s\.agent\.memory_gate \? "checked" : ""\}/.test(ui), "  └ 存过之后回来还勾着（写了但从来没渲染是另一种坏）");
    ok(ui.indexOf('id="ag-mgate"') > ui.indexOf('id="ag-cgate"')
      && ui.indexOf('id="ag-mgate"') - ui.indexOf('id="ag-cgate"') < 2200,
      "★就近★ 跟另外那道判断模型的闸摆在一块儿");
    ok(/两万分之一美金/.test(ui.slice(ui.indexOf('id="ag-cgate"'), ui.indexOf('id="ag-mgate"'))),
      "  └ 说清楚它花钱");
    const label = (ui.match(/<div class="f">(记之前[^<]*)<\/div>/) || [])[1];
    ok(!!label, "  └ 找得到那一行的标题", label);
    const i18n = fs.readFileSync(path.join(ROOT, "public", "js", "i18n.js"), "utf8");
    ok(label && i18n.includes(`"${label}"`), "  └ 标题有英文（这个产品是双语的，漏一条就半中半英）", label);

    const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    ok(/b\.agent\.memory_gate !== undefined/.test(srv), "  └ 后端收得下这个开关");
    ok(/memory_gate: !!config\.agent\.memory_gate/.test(srv), "  └ 也读得出来（存了读不回等于没存）");

    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
    eq(cfg.agent.memory_gate, false, "★配置模板里默认关着★ 它会吞掉记忆，这事得用户自己点头");
    ok(typeof cfg.agent._memory_gate_说明 === "string" && cfg.agent._memory_gate_说明.length > 40,
      "  └ 模板里写清楚它是干什么的（手改配置的人只看得到这一行）");

    const ag = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    ok(/gate: \(config\.agent \|\| \{\}\)\.memory_gate === true/.test(ag),
      "★不是 true 就不算开★ 配置里是别的值时，命令原文不该悄悄发出去");
  }

  finished = true;
  fs.rmSync(DATA_TMP, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
