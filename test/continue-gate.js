"use strict";
/**
 * 自动续跑之前那道闸：撞上限停下来的时候，先问一句「活儿是不是其实已经干完了」。
 *
 * 这个功能的全部价值在**它什么时候不出手**，所以要守的也全是边界：
 *
 *   1. 该不该花这道题的钱 —— 进度档里还有没打勾的条目，答案本来就是确定的，
 *      再去问一遍是白花钱；「任务还有 N 项没做完」同理。只有尺子够不着那一段才轮到它。
 *   2. 停的门槛 —— 它说「没剩了」但自己只有六成把握就把活儿停在这儿，比多跑一轮贵得多：
 *      多跑一轮是花钱，误停是活儿没了。所以门槛比通用的 0.7 还严。
 *   3. 只停，不改判 —— 这一轮已经做出来的东西一个字都不许动，它只决定「还续不续」。
 *   4. 闸坏了要退回老行为 —— 没配、答不上、问不成、异常，一律照旧续跑。
 *      「问不成」和「问了说没剩」长得完全不一样，不许走到同一个分支去。
 *   5. 误停要有活路 —— 停下来那句话必须写清「跟我说接着上次进度做」，
 *      而不是照抄「去调大上限」：这一停跟上限没关系，调大了也不会再跑。
 *
 * 跑法：node test/continue-gate.js
 * 不花钱、不出外网：判断模型那一趟在这儿是替换掉的假函数。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const cg = require(path.join(ROOT, "continue-gate"));
const systemone = require(path.join(ROOT, "systemone"));
const jev = require(path.join(ROOT, "jev"));
const tools = require(path.join(ROOT, "tools"));
const { createAgentRuntime, stopNotice, unfinishedMilestones } = require(path.join(ROOT, "agent"));
const { McpManager } = require(path.join(ROOT, "mcp"));
const { needsGate, doneQuestions, gateState, readDone, skipNote, DONE_KEY, CONTINUE_MIN, GATE_STOP_PREFIX } = cg;

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
const ans = (value, sure) => ({ key: DONE_KEY, value, sure: sure === undefined ? systemone.sureOfNoul(value) : sure });
const out = (...answers) => ({ ok: true, answers });

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 这道题该不该花钱（免费的尺子先量）");
  // ─────────────────────────────────────────────────────────────
  {
    const none = { open: [], total: 0 };
    ok(needsGate({ stopNote: "已达最大步数（25 步）", milestones: none }) === true,
      "★撞步数上限、进度档里没有没打勾的：这才轮到判断模型★");
    ok(needsGate({ stopNote: "已达最大运行时间（30 分钟）", milestones: none }) === true,
      "  └ 撞时间上限同理");
    ok(needsGate({ stopNote: "已达最大步数（25 步）", milestones: { open: ["写正文"], total: 3 } }) === false,
      "★还有没打勾的条目就不问★ 答案已经是确定的，这道题白花钱");
    ok(needsGate({ stopNote: "任务还有 2 项没做完", milestones: none }) === false,
      "  └「任务还有 N 项没做完」也不问：那本来就是结构判据量出来的结论");
    ok(needsGate({ stopNote: "已手动停止", milestones: none }) === false, "  └ 用户自己按的停，不关它的事");
    ok(needsGate({ stopNote: "任务已完成", milestones: none }) === false, "  └ 正常收尾不问");
    ok(needsGate({ stopNote: "", milestones: none }) === false, "  └ 空的不问");
    ok(needsGate({}) === false, "  └ 什么都没传也不炸（这道闸自己坏了不能把任务卡住）");
    ok(needsGate({ stopNote: "这一轮已达最大步数了", milestones: none }) === false,
      "★只认开头★ 句中提到「已达最大步数」的话不算，别把别的话误判成撞上限");
    ok(needsGate({ stopNote: "已达最大步数（25 步）", milestones: null }) === true,
      "  └ 进度档读不出来（null）当作「没有没打勾的」：那正是尺子够不着的那一段");
    ok(needsGate({ stopNote: "已达最大步数（25 步）", milestones: { open: "写正文", total: 1 } }) === true,
      "  └ open 不是数组也不认，按「量不出来」走，不当成真有条目");
    // 负向对照：判据要是照着「包含」写，上面那条「这一轮已达最大步数了」就会变成 true
    ok("这一轮已达最大步数了".includes("已达最大步数"), "  └（对照）那句话里确实含这几个字，所以上一条测的是 startsWith 不是 includes");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 问出去的那道题");
  // ─────────────────────────────────────────────────────────────
  {
    const qs = doneQuestions();
    const keys = Object.keys(qs);
    eq(keys.length, 1, "★只问一道★ 它是来拦一次花销的，自己不能变成一笔花销");
    eq(keys[0], DONE_KEY, "  └ 题名就是取答案用的那个常量（两边必须是同一份）");
    const norm = systemone.normalizeQuestions(qs);
    eq(norm.errs.length, 0, "  └ 过得了 systemone 的排版检查（真发出去不会被 400 打回来）", norm.errs);
    eq(norm.questions[DONE_KEY].type, "noul", "  └ 是非题（要的是一个概率，不是一段话）");
    const ins = norm.questions[DONE_KEY].instructions;
    ok(/算还有没做完/.test(ins) && /算没有了/.test(ins), "★两边都给了定义★ 只说一边等于把它往那一边推", ins.slice(0, 40));
    ok(/看不出来/.test(ins), "  └ 明说「看不出来就别硬挑一边」：拿不准的时候我们要的是低确定度，不是一个漂亮答案");

    const st = gateState({ task: "写一份年报", progress: "- [ ] 写正文", tail: "我先把资料收集完" });
    ok(/【用户交代的事】/.test(st) && /【工作目录的进度档/.test(st) && /【它停下前最后说的话】/.test(st),
      "★三段各自标好是什么★ 半句话和进度档是两种性质的证据，糊成一坨它分不清谁是谁");
    ok(/（工作目录里没有进度档）/.test(gateState({ task: "x", tail: "y" })), "  └ 没有进度档要明说，不是留白让它猜");
    ok(/（一个字都没说）/.test(gateState({ task: "x" })), "  └ 一句话没留下也明说");
    const long = gateState({ task: "甲".repeat(5000), progress: "乙".repeat(5000), tail: "丙".repeat(5000) });
    ok(long.length < 5000, "★三段都截断★ 一段长文顶掉另外两段，这道题就成了瞎猜", long.length);
    ok(/甲/.test(long) && /乙/.test(long) && /丙/.test(long), "  └ 截断之后三段都还在（没有谁被整段挤掉）");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 什么样的答案才配让活儿停下来");
  // ─────────────────────────────────────────────────────────────
  {
    ok(readDone(out(ans(0.05))) !== null, "★说「没剩了」而且很确定：停★");
    eq(readDone(out(ans(0))).p, 0, "★概率 0 是最铁的那条★ 不许被当成 falsy 丢掉（0 是「没剩了」，不是「没答上来」）");
    ok(readDone(out(ans(0.9))) === null, "★它说还有没做完的：照旧续跑★");
    ok(readDone(out(ans(0.5))) === null, "  └ 正好一半也续跑：拿不准的时候宁可多跑一轮，也不把活儿停在这儿");
    ok(readDone(out(ans(0.49))) === null, "  └ 0.49 说的是「没剩了」，但确定度只有 2%，不算数");
    ok(readDone(out(ans(0.5, 0.99))) === null,
      "  └ 正好一半却自称很确定：也不算（一半就是「没看出来」，那个 99% 只能是上游算错了）");
    ok(readDone(out(ans(0.3, 0.74))) === null, "  └ 差一点点也不行（门槛是 0.75）");
    ok(readDone(out(ans(0.3, 0.75))) !== null, "  └ 正好卡在门槛上算数（跟 systemone.gate 同一把尺子）");
    ok(readDone(out(ans(null))) === null, "  └ 没答上来：续跑");
    ok(readDone(out()) === null, "  └ 一条答案都没有：续跑");
    ok(readDone({ ok: false, error: "额度用完了" }) === null, "★问不成 ≠ 问了说没剩★ 上游挂了要退回老行为");
    ok(readDone(null) === null, "  └ 整个传空也不炸");
    ok(readDone(out({ key: "别的题", value: 0.05, sure: 0.9 })) === null,
      "★题名对不上就取不回来★（这一条钉的是「两边同一个常量」不是摆设）");
    eq(readDone(out(ans(0.05)), CONTINUE_MIN).bar, CONTINUE_MIN, "  └ 门槛能外面传");
    eq(readDone(out(ans(0.3, 0.74)), 0.7) !== null, true, "  └ 传松一点就放行（证明门槛真的在用，不是写死的）");
    ok(readDone(out(ans(0.3, 0.74)), "不是数") === null, "★门槛给了个不是数的要回落默认★ 不能变 NaN 把功能哑掉");
    ok(CONTINUE_MIN > systemone.SURE_MIN, "★比通用门槛严★ 这一问的结论是「别再往下干了」，比普通判断更该闭嘴",
      { CONTINUE_MIN, SURE_MIN: systemone.SURE_MIN });
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ 停下来那句话，得让人知道怎么接着干");
  // ─────────────────────────────────────────────────────────────
  {
    const note = skipNote(readDone(out(ans(0.05, 0.9))));
    ok(note.startsWith(GATE_STOP_PREFIX), "  └ 开头是那个前缀（收尾话术按它分叉）", note);
    ok(/90%/.test(note), "★确定度要露出来★ 凭什么少跑一轮，得让人看得见", note);
    const said = stopNotice(note);
    ok(/接着上次进度做/.test(said), "★★误停要有活路★★ 一句话就能接着干，这是这道闸敢存在的前提", said);
    ok(/设置|关掉/.test(said), "  └ 还要告诉他这道关在哪儿关掉");
    ok(!/调大|上限/.test(said), "★不许劝人去调上限★ 这一停跟上限没关系，调大了也不会再跑", said);
    // 负向对照：真撞上限的那句话，还是老样子劝人调上限——两条路不能混
    ok(/上限/.test(stopNotice("已达最大步数（25 步）")), "  └（对照）真撞上限的那句话照旧提上限，没被这道分叉带偏");
    ok(skipNote(null).startsWith(GATE_STOP_PREFIX), "  └ 传空也拼得出一句人话，不炸");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑤ 真跑一趟：它到底有没有省下那一轮");
  // ─────────────────────────────────────────────────────────────
  {
    const experts = [{ name: "文案写手", description: "写作", system: "你是文案写手。" }];
    // 每一步都要工具、永远不说完——不设这道闸的话，它会把轮数全部烧光
    const busyLLM = () => {
      let calls = 0;
      return {
        provider: "mock", model: "scripted",
        calls: () => calls,
        async chat({ tools: ts, toolChoice }) {
          calls++;
          if (!ts.length || toolChoice === "none") return { text: "资料收集完了，正文还没写。", toolCalls: [], stopReason: "end", usage: { prompt: 10, completion: 5 } };
          return {
            text: "接着做。",
            toolCalls: [{ id: "tc_" + calls, name: "run_node", input: { code: "console.log(1)", purpose: "占位" } }],
            stopReason: "tool_use", usage: { prompt: 10, completion: 5 },
          };
        },
      };
    };
    const baseCfg = (agent) => ({
      agent: { max_steps: 1, tool_timeout_ms: 30000, ...agent },
      decide: { api_key: "假 Key，这趟根本不发网络" },
    });

    // askMetered 整个换掉：这套测试一分钱不花、一个字节不出网
    const realAsk = jev.askMetered;
    let asked = [];
    const stub = (impl) => { asked = []; jev.askMetered = async (config, args, opts) => { asked.push({ args, opts }); return impl(); }; };

    const runOnce = async (cfg, { progress } = {}) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cgate-"));
      if (progress !== undefined) fs.writeFileSync(path.join(dir, "PROGRESS.md"), progress);
      const llm = busyLLM();
      const rt = createAgentRuntime({ config: cfg, llm, mcpManager: new McpManager(), experts });
      const r = await tools.withWorkspace(dir, () => rt.runTask({ history: [{ role: "user", content: "写一份很长的年报" }] }));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return { r, calls: llm.calls() };
    };

    try {
      // A 开着 + 它说「都做完了」→ 这一轮之后不再续
      stub(() => out(ans(0.05, 0.94)));
      const a = await runOnce(baseCfg({ auto_continue_rounds: 3, continue_gate: true }));
      ok(a.r.finalText.includes(GATE_STOP_PREFIX), "★★真省下了那一轮★★ 撞上限但活儿已经干完：没有再重置预算", a.r.finalText.slice(-90));
      eq(asked.length, 1, "  └ 只问了一道题（省一轮的代价是一道题，不是一串）");
      ok(/【用户交代的事】/.test(asked[0].args.state) && /年报/.test(asked[0].args.state), "  └ 问的时候把现场给它看了");
      ok(/接着做/.test(asked[0].args.state),
        "  └ 连它停下前那半句话也给了（撞上限那一刻就只有这半句，收尾那句交代要再花一次调用才有）");
      ok(/资料收集完了/.test(a.r.finalText),
        "★停了也要给交代★ 这一停照样走收尾那一步，用户拿到的不是半句过程叙述", a.r.finalText.slice(0, 40));
      eq(a.calls, 2, "  └ 只跑了一轮：1 步 + 1 次收尾", a.calls);

      // B 对照：开关关着 —— 老样子续满，且一分钱不花
      stub(() => out(ans(0.05, 0.94)));
      const b = await runOnce(baseCfg({ auto_continue_rounds: 3, continue_gate: false }));
      eq(asked.length, 0, "★没打开就一分钱不花★ 它花的是后台的钱，没人点确认");
      ok(!b.r.finalText.includes(GATE_STOP_PREFIX), "  └ 也不会冒出那句话");
      ok(b.calls > 2, "  └（对照组）不设闸就是把三轮烧光：模型调用 " + b.calls + " 次，A 组只有 2 次", b.calls);

      // C 对照：它说「还有没做完的」→ 照旧续跑
      stub(() => out(ans(0.93, 0.86)));
      const c = await runOnce(baseCfg({ auto_continue_rounds: 3, continue_gate: true }));
      ok(!c.r.finalText.includes(GATE_STOP_PREFIX), "★它说还有活儿就接着干★ 这道闸只负责少续一轮，不负责多停一轮");
      ok(c.calls > 2, "  └ 轮数照常用", c.calls);

      // D 对照：问不成（上游挂了）→ 退回老行为，而且要留痕
      const warns = [];
      const realWarn = console.warn;
      console.warn = (...a) => warns.push(a.join(" "));
      stub(() => { throw new Error("上游 502"); });
      const d = await runOnce(baseCfg({ auto_continue_rounds: 3, continue_gate: true }));
      console.warn = realWarn;
      ok(!d.r.finalText.includes(GATE_STOP_PREFIX), "★闸坏了退回老行为★ 问不成不能把一趟还没干完的活儿停在这儿");
      ok(d.calls > 2, "  └ 照旧续跑", d.calls);
      ok(warns.some((w) => /没问成/.test(w)), "★吞掉的异常要留痕★ 悄悄失灵跟一切正常长得一模一样", warns.slice(0, 1));

      // E 对照：进度档里还有没打勾的 → 免费尺子先挡住，一道题都不问
      stub(() => out(ans(0.05, 0.94)));
      const e = await runOnce(baseCfg({ auto_continue_rounds: 2, continue_gate: true }), { progress: "- [x] 收资料\n- [ ] 写正文\n" });
      eq(asked.length, 0, "★确定的答案不花钱去买★ 进度档里明摆着还有没打勾的");
      ok(!e.r.finalText.includes(GATE_STOP_PREFIX), "  └ 照旧续跑");

      // F 对照：全打勾了 —— 同一份进度档只差一个勾，就轮到判断模型了
      stub(() => out(ans(0.05, 0.94)));
      const f = await runOnce(baseCfg({ auto_continue_rounds: 2, continue_gate: true }), { progress: "- [x] 收资料\n- [x] 写正文\n" });
      eq(asked.length, 1, "  └ 全打勾了却还在跑：这才是尺子够不着、该问的那一段");
      ok(/写正文/.test(asked[0].args.state), "  └ 进度档原文也一起给它看了");

      // G 对照：没配判断模型 → 不发请求
      stub(() => out(ans(0.05, 0.94)));
      const envKeep = { ts: process.env.TYPESAFE_API_KEY, or: process.env.OPENROUTER_API_KEY };
      delete process.env.TYPESAFE_API_KEY; delete process.env.OPENROUTER_API_KEY;
      const g = await runOnce({ agent: { max_steps: 1, tool_timeout_ms: 30000, auto_continue_rounds: 2, continue_gate: true } });
      if (envKeep.ts !== undefined) process.env.TYPESAFE_API_KEY = envKeep.ts;
      if (envKeep.or !== undefined) process.env.OPENROUTER_API_KEY = envKeep.or;
      eq(asked.length, 0, "★没配判断模型就不发请求★ 勾上了也不会生效，界面上也是这么说的");
      ok(g.calls > 2, "  └ 照旧续跑", g.calls);
    } finally {
      jev.askMetered = realAsk;
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑥ 接线扫一遍（别让这一整套只活在测试里）");
  // ─────────────────────────────────────────────────────────────
  {
    const ag = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    ok(/askContinueGate\(stopNote, finalText\)/.test(ag), "★真挂在续跑那一步上★ 摆在「要不要续」和「续」之间");
    ok(/continueGate\.needsGate/.test(ag) && /continueGate\.readDone/.test(ag), "  └ 用的是这一层的纯函数，没在 agent 里另抄一份判据");
    ok(/if \(!\(config\.agent \|\| \{\}\)\.continue_gate\) return "";/.test(ag), "★默认关★ 后台自己花的钱，得用户先点头");
    ok(/jev\.status\(config\)\.ready/.test(ag), "  └ 没配判断模型也不发请求");
    ok(/unfinishedMilestones\(progressDir\(\)\)/.test(ag), "  └ 免费那把尺子读的是 agent 自己那份进度档路径，不另算一条");

    const srv = src("server");
    ok(/continue_gate: !!config\.agent\.continue_gate/.test(srv), "设置接口读得出来");
    ok(/config\.agent\.continue_gate = !!b\.agent\.continue_gate/.test(srv), "  └ 也存得回去");
    ok(/judge_ready: jev\.status\(config\)\.ready/.test(srv), "  └ 界面能知道判断模型配没配（两个开关共用这一面旗子）");

    const ui = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
    ok(/id="ag-cgate"/.test(ui), "★设置里摆得出来★ 开关存在但找不到＝没有");
    ok(/continue_gate: pane\.querySelector\("#ag-cgate"\)\.checked/.test(ui), "  └ 勾了真存得下去");
    ok(/s\.agent\.continue_gate \? "checked"/.test(ui), "  └ 存过之后回来还是勾着的（写了但从来没渲染是另一种坏）");
    ok(ui.indexOf('id="ag-cgate"') - ui.indexOf('id="ag-rounds"') > 0 &&
       ui.indexOf('id="ag-cgate"') - ui.indexOf('id="ag-rounds"') < 1400,
      "★就近★ 摆在「自动续跑轮数」正下方：它管的就是那个数字要不要再往下走一轮");
    ok(/两万分之一美金|美金|花钱|计费/.test(ui.slice(ui.indexOf('id="ag-rounds"'), ui.indexOf('id="ag-cgate"'))),
      "  └ 说清楚它花钱");

    const i18n = fs.readFileSync(path.join(ROOT, "public", "js", "i18n.js"), "utf8");
    const label = (ui.match(/<div class="f">(续跑之前[^<]*)<\/div>/) || [])[1];
    ok(!!label, "  └ 找得到那一行的标题", label);
    ok(label && i18n.includes(`"${label}"`), "  └ 标题有英文（这个产品是双语的，漏一条就半中半英）", label);

    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"));
    eq(cfg.agent.continue_gate, false, "  └ 配置模板里默认关着");
    ok(typeof cfg.agent._continue_gate_说明 === "string" && cfg.agent._continue_gate_说明.length > 40,
      "  └ 模板里写清楚它是干什么的（手改配置的人只看得到这一行）");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑦ 上游繁忙自动重试：状态事件带 retry 字段，前端才画得出倒计时");
  // ─────────────────────────────────────────────────────────────
  // 以前重试只有一句文字，前端要显示「3 秒后第 2/3 次重试」只能拿正则去抠。
  // 契约（3.4 界面那边照这个读）：retry = { attempt 从 1 数, total, delayMs }；text 一个字不改，老前端照读
  {
    const llmMod = require(path.join(ROOT, "llm"));
    const { retryField } = require(path.join(ROOT, "agent"));
    const { chatWithRetry, RETRY_DELAYS } = llmMod._internals;
    const realAsk = jev.askMetered;
    jev.askMetered = async () => ({ ok: false, error: "测试桩：不发网络" });

    // A llm.js 这一层：onStatus 的第二个参数
    {
      const realST = global.setTimeout;
      const waited = [];
      const got = [];
      let n = 0;
      global.setTimeout = (fn, ms, ...a) => { waited.push(ms); return realST(fn, 0, ...a); }; // 不真等 2+5 秒
      let res;
      try {
        res = await chatWithRetry(async () => {
          n++;
          if (n <= 2) throw new Error("LLM 接口错误 503: upstream busy");
          return { text: "好了", toolCalls: [] };
        }, { onStatus: (text, info) => got.push({ text, info }) });
      } finally {
        global.setTimeout = realST;
      }
      eq(res && res.text, "好了", "两次 503 之后第三次成功：照常交回结果");
      eq(got.length, 2, "  └ 每重试一次报一次");
      eq(JSON.stringify(got.map((g) => g.info)), JSON.stringify([
        { kind: "retry", attempt: 1, total: 3, delayMs: 2000 },
        { kind: "retry", attempt: 2, total: 3, delayMs: 5000 },
      ]), "★第二个参数是结构化的进度★ attempt 从 1 数，delayMs 就是这一次真要等的那么久");
      eq(JSON.stringify(waited), JSON.stringify([2000, 5000]), "  └ 报出去的 delayMs 跟真等的一样（倒计时不许骗人）");
      eq(got[0].info.total, RETRY_DELAYS.length, "  └ total 跟着重试表走，不是写死的 3");
      ok(/2 秒后自动重试（第 1\/3 次）/.test(got[0].text), "  └ 第一个参数的文字没变：老前端照读", got[0].text);

      // 反向对照：不可重试的错不报、不等
      const got2 = [];
      let threw = null;
      try {
        await chatWithRetry(async () => { throw new Error("LLM 接口错误 401: bad key"); }, { onStatus: (t, i) => got2.push(i) });
      } catch (e) { threw = e; }
      ok(threw && /401/.test(threw.message) && got2.length === 0, "  └（对照）401 不重试，也不发重试进度");
    }

    // B agent.js 这一层：原样挂在 status 事件上
    {
      eq(JSON.stringify(retryField({ kind: "retry", attempt: 2, total: 3, delayMs: 5000 })), JSON.stringify({ retry: { attempt: 2, total: 3, delayMs: 5000 } }),
        "retryField：重试进度 → 事件上的 retry 字段");
      eq(JSON.stringify(retryField(undefined)), "{}", "  └ 没给第二个参数：一个字段都不加（别的状态事件长相不变）");
      eq(JSON.stringify(retryField({ kind: "别的" })), "{}", "  └ 不是重试的也不加");
    }

    // C 真跑一趟：真的 createLLM + 桩 fetch，上游先 503 一次再正常。会真等 2 秒（这是 RETRY_DELAYS 第一档）
    {
      const realFetch = global.fetch;
      let posts = 0;
      global.fetch = async (url) => {
        if (!/\/chat\/completions$/.test(String(url))) throw new Error("测试里不该有别的请求：" + url);
        posts++;
        if (posts === 1) return new Response("upstream busy", { status: 503 });
        return new Response(JSON.stringify({ choices: [{ message: { content: "写好了。" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cgate-"));
      const events = [];
      try {
        const llm = llmMod.createLLM({ models: [{ name: "桩", provider: "openai", base_url: "http://127.0.0.1:9/v1", api_key: "sk-test-offline", model: "mock-model", stream: false }] });
        const rt = createAgentRuntime({ config: { agent: { max_steps: 3, tool_timeout_ms: 30000 } }, llm, mcpManager: new McpManager(), experts: [] });
        const r = await tools.withWorkspace(dir, () => rt.runTask({ history: [{ role: "user", content: "写一句话" }], emit: (e) => events.push(e) }));
        eq(posts, 2, "503 一次、重试一次成功：一共两次请求");
        ok(/写好了/.test(r.finalText), "  └ 重试成功后照常交付", r.finalText);
      } finally {
        global.fetch = realFetch;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      const st = events.filter((e) => e.type === "status");
      const rs = st.filter((e) => e.retry);
      ok(rs.length === 1, "★★重试时发出的状态事件带 retry★★ 前端拿它画倒计时", st.map((e) => e.text));
      const ev = rs[0] || {};
      eq(ev.retry && ev.retry.attempt, 1, "  └ retry.attempt = 1（从 1 数）");
      eq(ev.retry && ev.retry.total, 3, "  └ retry.total = 3");
      eq(ev.retry && ev.retry.delayMs, 2000, "  └ retry.delayMs = 2000");
      ok(/上游出错，2 秒后自动重试/.test(ev.text || "") && ev.depth === 0, "  └ text 和 depth 照旧：老前端只读 text，看到的还是那句话", ev);
      ok(st.filter((e) => !/上游出错/.test(e.text || "")).every((e) => !("retry" in e)), "  └ 别的状态事件不带 retry（界面不会把普通状态当成重试）");
    }

    // D 等重试的那几秒里按了停：当场收，不干等满 2/5/10 秒（界面上倒计时还在走，用户以为停不下来）
    {
      const { getEventListeners } = require("events");
      const ac = new AbortController();
      let n = 0, threw = null;
      const t0 = Date.now();
      const stopAt = setTimeout(() => ac.abort(), 100); // 第一次 503 之后、2 秒退避中间按停
      try {
        await chatWithRetry(async () => { n++; throw new Error("LLM 接口错误 503: upstream busy"); }, { signal: ac.signal, onStatus: () => {} });
      } catch (e) { threw = e; }
      clearTimeout(stopAt);
      const took = Date.now() - t0;
      ok(threw && threw.name === "AbortError", "★★退避中按了停：抛 AbortError★★ agent 按这个名字认成停止，不当成上游报错", threw && { name: threw.name, msg: String(threw.message).slice(0, 60) });
      ok(took < 1500, "  └ 当场收，没干等满 2 秒", took);
      eq(n, 1, "  └ 停了就不再发下一次请求");

      // 超预算也一样：signal 自带的原因原样抛出去（TimeoutError），agent 才分得清「超时」和「手动停」
      let threw2 = null;
      const t1 = Date.now();
      try {
        await chatWithRetry(async () => { throw new Error("LLM 接口错误 429: rate limited"); }, { signal: AbortSignal.timeout(80) });
      } catch (e) { threw2 = e; }
      ok(threw2 && threw2.name === "TimeoutError" && Date.now() - t1 < 1500, "  └ 时限到了也当场收，抛的是 TimeoutError", threw2 && threw2.name);

      // 反向对照：没按停就照常等完、照常重试成功，等完把自己挂的监听摘掉（不然长任务一步挂一个，越攒越多）
      const realST = global.setTimeout;
      global.setTimeout = (fn, ms, ...a) => realST(fn, 0, ...a);
      const ac2 = new AbortController();
      let m = 0, res = null;
      try {
        res = await chatWithRetry(async () => { if (++m === 1) throw new Error("LLM 接口错误 503: upstream busy"); return { text: "好了", toolCalls: [] }; }, { signal: ac2.signal });
      } finally {
        global.setTimeout = realST;
      }
      ok(res && res.text === "好了" && m === 2, "  └（对照）没按停：等完照常重试，第二次成功", { m, res });
      eq(getEventListeners(ac2.signal, "abort").length, 0, "  └（对照）等完之后 abort 监听已经摘掉");
    }

    jev.askMetered = realAsk;
  }

  finished = true;
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
