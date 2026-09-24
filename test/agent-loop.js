"use strict";
/**
 * 别让它一直转圈。
 *
 * 在这之前卡住的任务只会被「劝」：三连提醒换个思路，五连拦一次不执行。模型不听就一路转到
 * 最大步数，用户看到的是「已达最大运行时间，任务强制收尾」，还以为活儿太多，回头把上限调大——
 * 下一趟转得更久、烧得更多。硬停这一档就是补这个。
 *
 * 这套测试要同时钉住两件互相拉扯的事：
 *   1. 真卡住了就得停。五种卡法各有各的长相。
 *   2. 没卡住的绝不许停。这条更要紧——误停是把正在干活的任务拦腰砍断，用户连「做完没有」都不知道。
 *      所以每一档都配一条差一次就到的反向对照，判据松一格那条当场红。
 * 还有一条常被忘掉的：停下来那句话得说对下一步。撞上限该劝人调大上限，死循环劝这个是反的。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { deadLoop, findCycle, stopNotice, DEAD_LOOP_LIMITS: L } = require(path.join(ROOT, "agent"));
const AGENT_SRC = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}

// 记账那几张表都是 Map，键里用 \u0000 分开工具名和入参。照着造，不另发明一套格式
const NUL = "\u0000";
const key = (tool, input) => tool + NUL + JSON.stringify(input || {});
const hist = (tool, streak, input) => new Map([[key(tool, input), { sig: "一样的结果", streak }]]);
const none = { loopHist: new Map(), errStreaks: new Map(), errSame: new Map(), deadMedia: new Map(), callSeq: [] };
const call = (o) => deadLoop({ ...none, ...o });
// 转圈序列：每一项是「工具+入参+结果」的指纹，同一个字母 = 完全一样的一步
const step = (letter) => key("tool_" + letter, { q: letter }) + "\u0001" + "r_" + letter;
const cycle = (letters, times) => Array.from({ length: times }, () => letters.map(step)).flat();

// ── ① 三档门槛：提醒 < 拦截 < 硬停 ───────────────────────────────────────
console.log("\n① 三档门槛：提醒 < 拦截 < 硬停");
{
  // 三个数分散在两处（提醒和拦截在主循环，硬停在 DEAD_LOOP_LIMITS）。谁改一处忘了另一处，
  // 就会出现「还没提醒过就硬停」或者「拦到天荒地老也不停」
  const nudgeAt = Number((AGENT_SRC.match(/for \(const \[k, v\] of loopHist\) if \(v\.streak >= (\d+)/) || [])[1]);
  const blockAt = Number((AGENT_SRC.match(/seen && seen\.streak >= (\d+) && tc\.name !== "ask_user"/) || [])[1]);
  ok(nudgeAt > 0 && blockAt > 0, "三档的数字在源码里都找得到（找不到就是改名或挪窝了，下两条会失去意义）", { nudgeAt, blockAt });
  ok(nudgeAt < blockAt && blockAt < L.same,
    "★提醒(" + nudgeAt + ") < 拦截(" + blockAt + ") < 硬停(" + L.same + ")★ 顺序一乱就是「还没劝过就砍了」",
    { nudgeAt, blockAt, hard: L.same });
  // 被拦下的那次也要计一笔，否则次数冻在拦截线上，硬停那一档永远够不着
  ok(/拦下的也计数/.test(AGENT_SRC) && /loopHist\.set\(loopKey, \{ sig: seen\.sig, streak: seen\.streak \+ 1 \}\)/.test(AGENT_SRC),
    "★被拦下的那次也得记一笔★ 不记的话拦一万次也停不下来");
  // callSeq 是环形缓冲。短于「三步一圈 × 4 圈 = 12 步」，三步的转圈就永远检不出来
  const cap = Number((AGENT_SRC.match(/if \(callSeq\.length > (\d+)\) callSeq\.shift\(\)/) || [])[1]);
  ok(cap >= 3 * L.cycleReps,
    "★最近几步的缓冲(" + cap + ")装得下一整圈(3×" + L.cycleReps + ")★ 装不下就永远检不出三步一圈",
    { cap, need: 3 * L.cycleReps });
}

// ── ② 五种卡法都得停，差一次的都不许停 ───────────────────────────────────
console.log("\n② 五种卡法都得停，差一次的都不许停");
{
  ok(call({ loopHist: hist("read_file", L.same, { path: "a.md" }) }).includes("read_file"),
    "同参同结果：撞到线就停，并说清是哪个工具");
  eq(call({ loopHist: hist("read_file", L.same - 1, { path: "a.md" }) }), "",
    "★差一次不许停★ 判据松一格，正在干活的任务就被拦腰砍断");

  ok(call({ errSame: new Map([["gen_image", { sig: "余额不足", n: L.sameError }]]) }).includes("同一句报错"),
    "同一句报错：换着参数撞同一堵墙，说明参数根本不是变量");
  eq(call({ errSame: new Map([["gen_image", { sig: "余额不足", n: L.sameError - 1 }]]) }), "", "★差一次不许停★");

  ok(call({ errStreaks: new Map([["run_shell", L.errors]]) }).includes("连续失败"),
    "连续失败：报的是什么不重要，一次没成过就是没成过");
  eq(call({ errStreaks: new Map([["run_shell", L.errors - 1]]) }), "", "★差一次不许停★");

  ok(call({ deadMedia: new Map([["look_at_image", { n: L.media, content: "渠道熔断" }]]) }).includes("熔断"),
    "熔断了还硬调：这条路今天就是不通，调多少次都是同一句话");
  eq(call({ deadMedia: new Map([["look_at_image", { n: L.media - 1, content: "x" }]]) }), "", "★差一次不许停★");

  const spin = call({ callSeq: cycle(["a", "b"], L.cycleReps) });
  ok(spin.includes("来回转") && spin.includes("tool_a") && spin.includes("tool_b"),
    "来回转圈：A→B→A→B 单看每个工具都不重复，只有连起来看才看得见", spin);
  eq(call({ callSeq: cycle(["a", "b"], L.cycleReps - 1) }), "", "★差一圈不许停★");
  ok(call({ callSeq: cycle(["a", "b", "c"], L.cycleReps) }).includes("tool_c"), "三步一圈的也认");
}

// ── ③ 正常跑的任务一个字都不许说 ─────────────────────────────────────────
console.log("\n③ 反向对照：正常跑的任务一个字都不许说");
{
  eq(call({}), "", "什么都没发生：不吽声");
  // 一趟正常任务长这样：同一个工具调很多次但入参和结果每次都不同，中间夹着几次失败
  eq(call({
    loopHist: new Map([[key("write_file", { path: "a" }), { sig: "ok", streak: 1 }],
                       [key("write_file", { path: "b" }), { sig: "ok", streak: 1 }]]),
    errStreaks: new Map([["run_shell", 0], ["web_search", 2]]),
    errSame: new Map([["run_shell", { sig: "npm ERR", n: 2 }]]),
    callSeq: ["a", "b", "c", "d", "e", "f", "g", "h"].map(step),
  }), "", "★八步各不相同：这是在干活，不是在转圈★ 整套里最要紧的一条，误停比不停更伤人");
  eq(findCycle(Array.from({ length: 8 }, () => step("a")), 4), null,
    "★一模一样的一长串不算「转圈」★ 那归同参同结果那一档管，两边都报就是同一件事说两遍");
}

// ── ④ 转圈检测：只看尾巴，周期只认 2 和 3 ────────────────────────────────
console.log("\n④ 转圈检测：只看尾巴，周期只认 2 和 3");
{
  const c = findCycle(cycle(["a", "b"], 4), 4);
  ok(c && c.period === 2 && c.reps === 4, "周期 2 × 4 圈：认得出", c);
  eq(c.tools, ["tool_a", "tool_b"], "报出来的是工具名，不是那一长串指纹（给人看就得是人话）");
  ok(findCycle(cycle(["a", "b", "c"], 4), 4).period === 3, "周期 3 也认");
  eq(findCycle(cycle(["a", "b"], 3), 4), null, "圈数不够：不报");
  eq(findCycle([...cycle(["a", "b"], 4), step("z"), step("y")], 4), null,
    "★已经跳出来了就不算★ 前面转过圈、后面换了路，这是自己走出来了");
  // 同一个工具翻页十次：工具名一样但入参每次都不同，那是正经活儿
  const paging = [];
  for (let i = 0; i < 8; i++) paging.push(key("web_search", { page: i }) + "\u0001r" + i);
  eq(findCycle(paging, 4), null, "★同一个工具但每次入参不同：不算圈★ 翻页、逐个读文件都长这样");
}

// ── ⑤ 停了要说对下一步 ───────────────────────────────────────────────────
console.log("\n⑤ 停了要说对下一步：调上限 / 修路 / 什么都不用做");
{
  const cap = stopNotice("已达最大步数（40 步）");
  ok(cap.includes("执行上限") && cap.includes("自动续跑"),
    "撞上限：开关在哪一页、叫什么名字说全，别让人回头来问", cap);
  const dead = stopNotice("陷入死循环（read_file 连续 6 次拿到同样的结果）");
  ok(!dead.includes("上限"),
    "★死循环不许劝人去调大上限★ 上限再大它也只是多转几圈", dead);
  ok(dead.includes("不会自动续跑"), "死循环：说明这一停不会自己接着跑，不然用户干等", dead);
  ok(dead.includes("接着上次进度做"), "死循环：还是得给一条走得回去的路", dead);
  const man = stopNotice("已手动停止");
  ok(!man.includes("上限"), "手动停止是用户自己按的，别再劝他去调上限", man);

  // 续跑白名单：死循环进了就是自动把同一个圈再转一遍
  const cont = (AGENT_SRC.match(/const continuable = ([^;]+);/) || [])[1] || "";
  ok(cont && !/死循环/.test(cont), "★死循环不进续跑白名单★ 进了就是自动把同一个圈再转一遍", cont);
  ok(/已达最大步数/.test(cont) && /已达最大运行时间/.test(cont), "反向对照：撞上限那两种照旧可以续跑", cont);
}

// ── ⑥ 接线：判出来了要真停，而且要告诉用户 ───────────────────────────────
console.log("\n⑥ 接线：判出来了要真停，而且要告诉用户");
{
  const at = AGENT_SRC.indexOf("const dead = deadLoop({");
  ok(at > 0, "★主循环里真调了 deadLoop★ 纯函数写得再对，没人调就等于没写");
  const after = AGENT_SRC.slice(at, at + 1200);
  ok(/stopNote = `陷入死循环/.test(after), "判出来要落进 stopNote，收尾那段才说得出为什么停");
  ok(after.indexOf("break;") > 0, "★落完还得 break★ 不 break 就是记了一笔然后接着转，等于没停");
  ok(/emit\(\{ type: "text"/.test(after), "★停之前先跟用户说一声★ 界面上凭空少一步，比转圈更让人摸不着头脑");
  // 先劝后停。反过来就是一撞线就砍，模型连改的机会都没有
  ok(AGENT_SRC.indexOf("【系统·循环检测】") < at, "★先劝后停★ 反过来就是不给模型改的机会");
}

// ════════════════════════════════════════════════════════════════════════════
// 下面三件是同一类病：历史里写进去的东西，下一轮被读歪了。
//   ⑦ 「用户这次要的是什么」三处各猜各的 → 统一成 currentAsk
//   ⑧ 引擎回合写进去的 assistant 没有 text → 下一轮请求里一条空 assistant，整段会话从此 400
//   ⑨ 回复撞上输出上限 → 半截的工具调用被当真执行了
// 要真跑 runTask，所以从这里开始是异步的。模型全是桩，一分钱不花、一个字节不出网。
// ════════════════════════════════════════════════════════════════════════════
const os = require("os");
const tools = require(path.join(ROOT, "tools"));
const jev = require(path.join(ROOT, "jev"));
const llmMod = require(path.join(ROOT, "llm"));
const skillGate = require(path.join(ROOT, "skill-gate"));
const continueGate = require(path.join(ROOT, "continue-gate"));
const { McpManager } = require(path.join(ROOT, "mcp"));
const { createAgentRuntime, currentAsk, normalizeEntry, TRUNC_STOP } = require(path.join(ROOT, "agent"));
const { toOpenAIMessages, toAnthropicMessages, sendableHistory, outputCap, outputCapField, DEFAULT_MAX_TOKENS, openaiChat } = llmMod._internals;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-agentloop-")); // 只动自己这一个临时目录
const EXPERTS = [{ name: "文案写手", description: "写作", system: "你是文案写手。" }];
const cfgOf = (agent, extra) => ({ agent: { max_steps: 6, tool_timeout_ms: 30000, ...agent }, ...(extra || {}) });

/** 在一个全新的临时工作目录里真跑一趟 runTask，把事件和目录一起交回来 */
let runSeq = 0;
async function runOnce({ llm, history, config, ...rest }) {
  // 建在 TMP 里面、跟着 TMP 一起收，用不着再 mkdtemp 一层：repo-hygiene【7】只认括号里写了 tmpdir() 的，
  // 嵌套的 mkdtemp 会被它当成「建在 tmp 之外」
  const dir = path.join(TMP, "run-" + (++runSeq));
  fs.mkdirSync(dir);
  const events = [];
  const rt = createAgentRuntime({ config: config || cfgOf(), llm, mcpManager: new McpManager(), experts: EXPERTS });
  const r = await tools.withWorkspace(dir, () => rt.runTask({ history, emit: (e) => events.push(e), ...rest }));
  return { r, dir, events, history };
}

/** 按剧本回话的模型桩。第 n 次带工具的调用回 script[n]（用完就重复最后一条）；不带工具的是收尾那一问，单独记 */
function scripted(script) {
  const seen = [];
  let wraps = 0;
  return {
    provider: "mock", model: "scripted",
    seen, wraps: () => wraps,
    async chat({ history, tools: ts }) {
      if (!ts || !ts.length) { wraps++; return { text: "（收尾）", toolCalls: [], stopReason: "end_turn", usage: { prompt: 1, completion: 1 } }; }
      seen.push(JSON.parse(JSON.stringify(history)));
      const r = script[Math.min(seen.length - 1, script.length - 1)];
      return JSON.parse(JSON.stringify({ usage: { prompt: 10, completion: 5 }, raw: undefined, ...r }));
    },
  };
}
const userTexts = (h) => h.filter((e) => e && e.role === "user" && typeof e.content === "string").map((e) => e.content);
/** 一条 OpenAI 格式的消息是不是「空 assistant」：没正文也没工具调用。部分供应商见到它直接 400 */
const emptyOA = (m) => m.role === "assistant" && !String(m.content || "").trim() && !(m.tool_calls && m.tool_calls.length);
/** Anthropic 那边：content 是空数组或空串 */
const emptyAN = (m) => m.role === "assistant" && (!m.content || (Array.isArray(m.content) && !m.content.length) || (typeof m.content === "string" && !m.content.trim()));

(async () => {
  const realAsk = jev.askMetered;
  // 判断模型整个换掉：这套测试里哪道闸都不许真去问
  jev.askMetered = async () => ({ ok: false, error: "测试桩：不发网络" });
  const realWarn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(" ")); // 桩会让几道闸「问不成」，那几句留痕照常打，只是别刷屏

  try {
    // ── ⑦ currentAsk：用户这次要的到底是哪句 ────────────────────────────────
    console.log("\n⑦ currentAsk：三处统一一个口径");
    {
      const U = (content) => ({ role: "user", content });
      const A = (text) => ({ role: "assistant", text, toolCalls: [] });
      eq(currentAsk([]), "", "空历史：空串，不炸");
      eq(currentAsk(undefined), "", "  └ 连数组都不是也不炸");
      eq(currentAsk([U("写一份年报")]), "写一份年报", "只有一句：就是它");
      eq(currentAsk([U("写一份年报"), A("好"), U("【系统·自动续跑 第 1/2 轮】上一轮已达最大步数，继续。")]), "写一份年报",
        "★续跑提示不是用户说的★ 以前记忆召回拿的就是这句，按「继续」去挑记忆等于没挑");
      eq(currentAsk([U("写一份年报"), A("好"), U("【目标验收 · 第 2 轮】以下验收标准还没达成：…")]), "写一份年报", "目标验收的打回也跳过");
      eq(currentAsk([U("写一份年报"), A("好"), U("【用户插话（在任务执行中补充）】封面用蓝色")]), "写一份年报",
        "★插话是补充，不是换了件事★ 续跑前那道闸要对着「年报」判做完没有，不是对着「封面用蓝色」");
      eq(currentAsk([U("写一份年报"), A("先列了提纲"), U("继续")]), "写一份年报",
        "★只说「继续」的：事还是上一句那件★ 以前记忆召回拿「继续」去挑记忆");
      eq(currentAsk([U("写一份年报"), A("好"), U("【任务类型：写作】接着上次进度做")]), "写一份年报", "  └ 带场景标签的「接着上次进度做」也认得是续跑");
      eq(currentAsk([U("继续")]), "继续", "  └ 往前再没有别的话了：退回这句「继续」，总比空串强");
      eq(currentAsk([U("【用户插话（在任务执行中补充）】只有这一句")]), "只有这一句", "  └ 只有插话：退回插话正文（前缀剥掉）");
      eq(currentAsk([U("写一份年报"), A("写完了"), U("封面改成蓝色")]), "封面改成蓝色",
        "★反向对照：正常的新一句就是新的要求★ 插话没赶上、下一趟当普通消息发进来的也是这样");
      eq(currentAsk([
        U("【系统·上下文压缩】以下是本会话更早内容的自动摘要（原文已归档）：\n## 目标\n年报\n【最近的用户指令原文】写一份 2025 年报，带封面\n【读过的文件】无"),
        A("接着写"),
        U("【系统·循环检测】你在原地打转"),
      ]), "写一份 2025 年报，带封面", "★压缩之后原话只活在摘要那一行里★ 认那一行，不认摘要全文");
      eq(currentAsk([U("  写一份\n\n年报  ")]), "写一份 年报", "空白压成一个空格：跟压缩摘要里留的那行对得上");
      ok(/function currentAsk\(history\)/.test(AGENT_SRC), "currentAsk 在 agent.js 里只有一份");
      // 三处都得真用它。以前各写各的：find 第一条 user、reverse 找最后一条 user
      ok(/const memHint = currentAsk\(history\)/.test(AGENT_SRC), "★记忆召回线索用的是它★");
      ok(/stats\.asked = String\(currentAsk\(history\)/.test(AGENT_SRC), "★弹问用户那道闸记的用户原话用的是它★");
      ok(/const asked = currentAsk\(history\)/.test(AGENT_SRC), "★续跑前那道闸用的是它★");
      ok(!/history\.find\(\(h\) => h\.role === "user"\)/.test(AGENT_SRC), "  └ 旧的「整段会话第一条 user」一处都不剩");
    }

    // ── ⑦b 真跑一趟：有插话时三处拿到的是同一句 ───────────────────────────
    console.log("\n⑦b 真跑一趟：有插话、有「继续」，三处拿到的还是同一句");
    {
      const got = {};
      const realRoute = skillGate.route;
      const realGateState = continueGate.gateState;
      skillGate.route = (args) => { got.skill = args.message; return realRoute(args); }; // 第①处 memHint 就是递给它的那句
      continueGate.gateState = (args) => { got.gate = args.task; return realGateState(args); }; // 第③处
      let fed = false;
      const stats = { prompt: 0, completion: 0, cached: 0, calls: 0, startedAt: Date.now() };
      const llm = scripted([{ text: "接着做。", toolCalls: [{ id: "ls1", name: "list_files", input: {} }], stopReason: "tool_use" }]);
      try {
        const { history } = await runOnce({
          llm,
          config: cfgOf({ max_steps: 1, auto_continue_rounds: 1, continue_gate: true }, { decide: { api_key: "假 Key，这趟根本不发网络" } }),
          // 最前面垫一轮闲聊：旧写法「整段会话第一条 user」拿到的是「先聊聊天气」，第②③处真跑也会红，不只靠上面的源码正则
          history: [
            { role: "user", content: "先聊聊天气" }, { role: "assistant", text: "好", toolCalls: [] },
            { role: "user", content: "写一份很长的年报" }, { role: "assistant", text: "先列了提纲", toolCalls: [] }, { role: "user", content: "继续" },
          ],
          stats,
          getInterject: () => (fed ? [] : ((fed = true), ["封面用蓝色"])),
        });
        ok(userTexts(history).some((c) => c.startsWith("【用户插话") && c.includes("封面用蓝色")), "插话真的插进去了（不然下面几条测的不是插话）");
        ok(got.gate !== undefined, "续跑前那道闸真的走到了（不然第③处根本没测到）", got);
        eq(got.skill, "写一份很长的年报", "第①处（记忆召回 / 技能那道闸）：不是「继续」");
        eq(stats.asked, "写一份很长的年报", "第②处（弹问用户那道闸）");
        eq(got.gate, "写一份很长的年报", "第③处（续跑前那道闸）：插话进来之后还是这句");
        ok(got.skill === stats.asked && stats.asked === got.gate, "★★三处是同一句★★ 以前是「继续」/ 第一条 user / 第一条 user，碰上压缩还会三句全不同", got);
      } finally {
        skillGate.route = realRoute;
        continueGate.gateState = realGateState;
      }
    }

    // ── ⑦c 压缩前后：currentAsk 认的是同一句 ───────────────────────────────
    // 摘要里机械留的那行指令原文，以前取「最后一条非系统 user」：压掉的要是「继续」或插话，留下的就是它们，
    // 压完 currentAsk 认的就换了一句——跑到一半压一次，续跑那道闸和开跑时记下的 stats.asked 就对不上
    console.log("\n⑦c 压缩前后：currentAsk 认的是同一句");
    {
      const U = (content) => ({ role: "user", content });
      const A = (text) => ({ role: "assistant", text, toolCalls: [] });
      const big = (ch) => ch.repeat(9000);
      const rtOf = (keepTurns) => createAgentRuntime({
        config: cfgOf({ compact_threshold_chars: 8000, compact_keep_turns: keepTurns, compact_keep_chars: 5000 }),
        llm: { provider: "mock", model: "假压缩器", async chat() { return { text: "## 目标\n年报\n## 已完成\n无", usage: null }; } },
        mcpManager: new McpManager(), experts: EXPERTS,
      });
      // 归档那一下会写进真的数据目录：让它当场失败（压缩本身不受影响），测试不往共享目录落任何东西
      const realMkdir = fs.mkdirSync;
      fs.mkdirSync = function (p, ...a) { if (/compact-archive/.test(String(p))) throw new Error("测试桩：不归档"); return realMkdir.call(this, p, ...a); };
      try {
        // 分轮压缩（用户轮数不超过保留轮数，只能在助手消息边界下刀）：被压掉那截里最后是「继续」和一条插话
        const h1 = [U("写一份很长的年报"), A(big("甲")), U("继续"), U("【用户插话（在任务执行中补充）】封面用蓝色"), A(big("乙")), A(big("丙").slice(0, 6000))];
        const before1 = currentAsk(h1);
        await rtOf(3).compactHistory(h1, {});
        ok(String(h1[0].content).startsWith("【系统·上下文压缩】") && h1.length === 2, "分轮压缩真压了，只留最后那条助手消息（不然下面测的不是分轮压缩之后）", h1.length);
        eq(currentAsk(h1), before1, "★★分轮压缩：压完认的还是「写一份很长的年报」★★ 以前摘要里留的是那条插话");
        // 会话轮次压缩：最近两轮全是自动续跑提示，原始指令整句落在被压掉那截里
        const h2 = [U("写一份很长的年报"), A(big("甲")), U("【系统·自动续跑 第 1/2 轮】上一轮已达最大步数，继续。"), A(big("乙")), U("【系统·自动续跑 第 2/2 轮】上一轮已达最大步数，继续。"), A("好")];
        const before2 = currentAsk(h2);
        await rtOf(2).compactHistory(h2, {});
        ok(String(h2[0].content).startsWith("【系统·上下文压缩】") && h2.length === 5, "会话轮次压缩真压了", h2.length);
        eq(currentAsk(h2), before2, "★会话轮次压缩：最近几轮全是续跑提示时，原话也机械留在摘要里★ 以前压完就只剩空串");
        // 反向对照：留下的那截自己认得出来，就不往摘要里重复塞一行
        const h3 = [U("先随便聊聊"), A(big("甲")), U("写一份很长的年报"), A(big("乙")), U("封面用蓝色"), A("好")];
        await rtOf(2).compactHistory(h3, {});
        ok(String(h3[0].content).startsWith("【系统·上下文压缩】") && !/【最近的用户指令原文】/.test(h3[0].content), "  └ 反向对照：保留的几轮里就有原话，摘要里不重复留", String(h3[0].content).slice(-120));
        eq(currentAsk(h3), "封面用蓝色", "  └ 认的还是保留下来的那句新话");
        // 手动 /compact（cli.js 直接调 compactHistory，不经过 runTask）：老会话里引擎写的 { content } 回复
        // 以前按 e.text 摊转写时整条消失、字数按 0 算——旧轮次「不够肉」直接不压，压了摘要里也少那几轮
        const sent = [];
        const rtCap = createAgentRuntime({
          config: cfgOf({ compact_keep_turns: 2 }),
          llm: { provider: "mock", model: "假压缩器", async chat({ history: hh }) { sent.push(String((hh[0] || {}).content || "")); return { text: "## 目标\n长诗\n## 已完成\n无", usage: null }; } },
          mcpManager: new McpManager(), experts: EXPERTS,
        });
        const h4 = [U("写首长诗"), { role: "assistant", content: big("诗") }, U("再来一首"), A("好"), U("第三首"), A("好")];
        await rtCap.compactHistory(h4, { force: true });
        ok(sent.length === 1 && sent[0].includes("助手：诗诗诗"), "★手动 /compact：引擎写的 { content } 回复也进了摘要转写★", sent.map((s) => s.slice(0, 80)));
        ok(String(h4[0].content).startsWith("【系统·上下文压缩】"), "  └ 真压了（以前按 0 字算，旧轮次「不够肉」直接不压）", h4.length);
      } finally {
        fs.mkdirSync = realMkdir;
      }
    }

    // ── ⑧ 历史方言：引擎回合之后，下一轮请求里没有空 assistant ─────────────────
    console.log("\n⑧ 引擎回合之后：下一轮请求体里没有空 assistant");
    {
      // 老会话文件里躺着的样子：本机 Claude Code / Codex 回合写的是 content，不是 text
      const legacy = () => [
        { role: "user", content: "帮我写首诗" },
        { role: "assistant", content: "（引擎写的）春眠不觉晓" },
        { role: "assistant", text: "", toolCalls: [] }, // 连着两次截断后，半截调用全摘掉剩下的空壳
        { role: "user", content: "再写一首" },
      ];
      const n = normalizeEntry({ role: "assistant", content: "引擎回复" });
      ok(n.text === "引擎回复" && !("content" in n) && Array.isArray(n.toolCalls), "normalizeEntry：content 挪进 text，只留一种写法", n);
      const withRaw = normalizeEntry({ role: "assistant", text: "", raw: [{ type: "tool_use", id: "r1", name: "read_file", input: { path: "a.md" } }] });
      eq(withRaw.toolCalls.map((c) => c.id), ["r1"], "  └ raw 里有 tool_use、toolCalls 没记的：补进来（不补就是没人应答的 tool_use）");
      const good = { role: "assistant", text: "好", toolCalls: [{ id: "x", name: "list_files", input: {} }] };
      const goodCopy = JSON.stringify(good);
      eq(JSON.stringify(normalizeEntry(good)), goodCopy, "  └ 反向对照：正式格式的一个字节都不动");
      ok(/history\.push\(normalizeEntry\(\{ role: "assistant", text: rawFinal/.test(AGENT_SRC), "★引擎回合落盘过 normalizeEntry，写的是 text★");
      ok(!/history\.push\(\{ role: "assistant", content:/.test(AGENT_SRC), "  └ agent.js 里再没有往历史写 { content } 的 assistant");
      const at = AGENT_SRC.indexOf("async function runTask(");
      const nh = AGENT_SRC.indexOf("normalizeHistory(history);", at);
      ok(at > 0 && nh > at && nh < AGENT_SRC.indexOf("底层引擎分岔", at), "★读历史也过一道：runTask 开跑第一件事，在引擎分岔之前★");

      // 转换层自己也得扛得住（历史不一定都经过 runTask，比如评测、CLI 直接喂的）
      const oa = toOpenAIMessages("sys", legacy());
      ok(!oa.some(emptyOA), "★OpenAI 兼容：没有空 assistant★", oa);
      ok(oa.some((m) => m.role === "assistant" && /春眠不觉晓/.test(m.content)), "  └ 引擎那句话没丢，按 content 读出来了");
      ok(!oa.some((m, i) => i && m.role === "user" && oa[i - 1].role === "user"), "  └ 跳过空壳后不留两条 user 挨着（deepseek-reasoner 不收）", oa.map((m) => m.role));
      const an = toAnthropicMessages(legacy());
      ok(!an.some(emptyAN), "★Anthropic：没有空 assistant★", an);
      ok(an.every((m, i) => !i || m.role !== an[i - 1].role) && an[0].role === "user", "  └ 角色严格交替、第一条是 user", an.map((m) => m.role));
      const normal = [{ role: "user", content: "a" }, good, { role: "tool", results: [{ id: "x", content: "ok" }] }];
      ok(sendableHistory(normal, true).every((e, i) => e === normal[i]), "  └ 反向对照：正常历史原样返回同一批对象（不破坏前缀缓存）");

      // 孤立的 tool_use：只在 raw 里（toolCalls 没记），后面也没有结果——补一条「结果缺失」
      const orphan = [
        { role: "user", content: "读一下" },
        { role: "assistant", text: "", toolCalls: [], raw: [{ type: "tool_use", id: "o1", name: "read_file", input: { path: "a.md" } }] },
        { role: "user", content: "怎么没下文了" },
      ];
      const an2 = toAnthropicMessages(orphan);
      const res2 = an2.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result" && b.tool_use_id === "o1");
      ok(res2 && res2.is_error && /结果缺失/.test(res2.content), "★Anthropic：孤立的 tool_use 补了一条「结果缺失」★", an2);
      const oa2 = toOpenAIMessages("sys", orphan);
      const res3 = oa2.find((m) => m.role === "tool" && m.tool_call_id === "o1");
      ok(res3 && /结果缺失/.test(res3.content) && oa2.some((m) => (m.tool_calls || []).some((t) => t.id === "o1")), "  └ OpenAI 兼容那边也配上了对", oa2);

      // 真跑一趟：老会话 + 真的 openaiChat（fetch 是桩），抓下一轮真正发出去的请求体
      const realFetch = global.fetch;
      const bodies = [];
      global.fetch = async (url, init) => {
        if (!/\/chat\/completions$/.test(String(url))) throw new Error("测试里不该有别的请求：" + url);
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "好的，再来一首。" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
      };
      try {
        const llm = llmMod.createLLM({ models: [{ name: "桩", provider: "openai", base_url: "http://127.0.0.1:9/v1", api_key: "sk-test-offline", model: "mock-model", stream: false }] });
        const { history } = await runOnce({ llm, history: legacy() });
        eq(bodies.length, 1, "只发了一次请求");
        const msgs = (bodies[0] || {}).messages || [];
        ok(msgs.length && !msgs.some(emptyOA), "★★下一轮真正发出去的请求体里没有空 assistant★★", msgs.map((m) => [m.role, String(m.content || "").slice(0, 12)]));
        ok(msgs.some((m) => m.role === "assistant" && /春眠不觉晓/.test(m.content)), "  └ 引擎回合那句话也发出去了（不是靠丢掉它来躲 400）");
        ok(history[1].text === "（引擎写的）春眠不觉晓" && !("content" in history[1]), "★调用方那份会话被就地改成正式格式★ 下次落盘就不再带方言", history[1]);
        eq((bodies[0] || {}).max_tokens, DEFAULT_MAX_TOKENS, "★OpenAI 兼容请求体带上了 max_tokens（缺省 8192）★");
      } finally {
        global.fetch = realFetch;
      }
      eq(outputCap({ max_tokens: 2000 }), 2000, "  └ 模型条目自己写了 max_tokens 就用它");
      eq(outputCap({ max_tokens: "abc" }), 8192, "  └ 写了个不是数的：退回缺省，不发 NaN 过去");
      eq(outputCap({ extra_body: { max_completion_tokens: 4000 } }), 0, "  └ extra_body 里写了 max_completion_tokens 的：不再发 max_tokens（有的模型两个一起发会 400）");
      eq(outputCap({ extra_body: { max_tokens: 4000 } }), 0, "  └ extra_body 里自己写了 max_tokens 的：以用户那份为准，不另发");
      eq(outputCapField({ base_url: "https://api.openai.com/v1" }), "max_completion_tokens", "  └ OpenAI 官方：推理模型不收 max_tokens，改发 max_completion_tokens");
      eq(outputCapField({ base_url: "https://foo.openai.azure.com/openai" }), "max_completion_tokens", "  └ Azure OpenAI 同上");
      eq(outputCapField({ base_url: "https://openrouter.ai/api/v1" }), "max_tokens", "  └ 其余兼容厂商照发 max_tokens");
      eq(outputCapField({ base_url: "不是地址" }), "max_tokens", "  └ 地址写坏了不抛错");
      {
        // 端到端：OpenAI 官方地址的请求体里只有 max_completion_tokens，不带 max_tokens（带了 o 系列/gpt-5 会 400）
        const realFetch2 = global.fetch;
        const bodies2 = [];
        global.fetch = async (url, init) => {
          bodies2.push({ url: String(url), body: JSON.parse(init.body) });
          return new Response(JSON.stringify({ choices: [{ message: { content: "好" }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
        try {
          await openaiChat({ base_url: "https://api.openai.com/v1", api_key: "sk-test-offline", model: "gpt-5", stream: false }, { system: "s", history: [{ role: "user", content: "hi" }], tools: [] });
        } finally {
          global.fetch = realFetch2;
        }
        const b2 = (bodies2[0] || {}).body || {};
        ok(bodies2.length === 1 && b2.max_completion_tokens === DEFAULT_MAX_TOKENS && !("max_tokens" in b2), "★OpenAI 官方通道的请求体发的是 max_completion_tokens★", b2);
      }
    }

    // ── ⑨ 撞上输出上限：半截的工具调用不执行，只续写一次 ─────────────────────
    console.log("\n⑨ 撞上输出上限：半截的工具调用不执行，只续写一次");
    {
      // Anthropic SDK 会把截断的 JSON 硬解析成一个「看着完整」的对象——input 本身看不出是半截的，只有 stopReason 知道
      const half = (id, p) => ({ id, name: "write_file", input: { path: p, content: "# 年报\n\n第一章 概况\n营收同比增长" } });
      const cutReply = (id) => ({
        text: "我把报告写进文件。",
        toolCalls: [half(id, "半截.md")],
        stopReason: "max_tokens",
        raw: [{ type: "text", text: "我把报告写进文件。" }, { type: "tool_use", ...half(id, "半截.md") }],
      });

      // A 一直被截：续一次，第二次就停
      {
        const llm = scripted([cutReply("c1"), cutReply("c2")]);
        const { r, dir, events, history } = await runOnce({ llm, history: [{ role: "user", content: "写一份很长的年报" }] });
        ok(!fs.existsSync(path.join(dir, "半截.md")), "★★半截的 write_file 没有执行★★ 执行了就是一份被拦腰截断、还看不出来的文件");
        ok(!events.some((e) => e.type === "tool_use" || e.type === "tool_result"), "  └ 界面上一次工具调用都没出现", events.filter((e) => /tool/.test(e.type)).map((e) => e.type));
        eq(llm.seen.length, 2, "★★只续写了一次★★ 原来那次 + 续写那次；同样的上限再续还是同样的结局");
        eq(userTexts(history).filter((c) => c.startsWith("【系统·输出截断】")).length, 1, "  └ 续写提示只追加了一条");
        ok(/write_file/.test(userTexts(llm.seen[1]).pop() || "") && /append/.test(userTexts(llm.seen[1]).pop() || ""), "  └ 续写提示说清是哪个调用没执行、该怎么拆小", userTexts(llm.seen[1]).pop());
        eq(r.stopped, TRUNC_STOP, "★第二次还被截：停下来★");
        ok(r.finalText.includes("输出被截断，已停止执行"), "★告诉用户「输出被截断，已停止执行」★", r.finalText.slice(-120));
        ok(!/执行上限/.test(r.finalText), "  └ 不劝人去调「执行上限」：这跟步数、时长没关系", r.finalText.slice(-120));
        const saidA = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
        ok(/调用都没有执行/.test(saidA), "  └ 真摘掉了调用：界面上那条提示告诉用户这一批没执行", saidA.slice(-160));
        ok(events.some((e) => e.type === "limit" && e.note === TRUNC_STOP), "  └ 界面收到了 limit 事件");
        eq(llm.wraps(), 0, "  └ 不再花一次钱写收尾：刚连着两次写爆上限，收尾那段大概率也是截断");
        // 摘掉的调用不能在历史里留下没人应答的 tool_use，否则下一轮就是 400
        const dangling = history.filter((e) => e.role === "assistant").some((e) => (e.toolCalls || []).length || (e.raw || []).some((b) => b.type === "tool_use"));
        ok(!dangling, "★历史里没留下没人应答的 tool_use★ 留下了下一轮就是 400");
        ok(!/续跑/.test(AGENT_SRC.match(/const continuable = ([^;]+);/)[1]) && !/输出被截断/.test(AGENT_SRC.match(/const continuable = ([^;]+);/)[1]), "  └ 截断不进自动续跑白名单：续了还是同样的上限");
      }

      // A2 第二次被截的那条里前面还有个参数完整的调用：马上要停，整批都不执行，也不许在历史里留下没人应答的调用
      {
        const llm = scripted([
          cutReply("c1"),
          {
            text: "分两个文件写。",
            toolCalls: [{ id: "a2", name: "write_file", input: { path: "甲.md", content: "甲的全文" } }, half("b2", "乙.md")],
            stopReason: "max_tokens",
            raw: [{ type: "text", text: "分两个文件写。" }, { type: "tool_use", id: "a2", name: "write_file", input: { path: "甲.md", content: "甲的全文" } }, { type: "tool_use", ...half("b2", "乙.md") }],
          },
        ]);
        const { r, dir, history } = await runOnce({ llm, history: [{ role: "user", content: "写一份很长的年报" }] });
        eq(r.stopped, TRUNC_STOP, "第二次被截、前面还有完整调用：照样停");
        ok(!fs.existsSync(path.join(dir, "甲.md")) && !fs.existsSync(path.join(dir, "乙.md")), "  └ 整批都没执行（停之前不再动手）");
        const last = history.filter((e) => e.role === "assistant").pop() || {};
        ok(!(last.toolCalls || []).length && !(last.raw || []).some((b) => b && b.type === "tool_use"),
          "★整批从历史里摘干净★ 留下参数完整的那个，它永远等不到结果，下一轮就是没人应答的调用", last);
      }

      // B 截一次，重发拆小了：照常干完，不停
      {
        const llm = scripted([
          cutReply("c1"),
          { text: "拆小重发。", toolCalls: [{ id: "w2", name: "write_file", input: { path: "年报.md", content: "第一章" } }], stopReason: "tool_use" },
          { text: "好的。", toolCalls: [], stopReason: "end_turn" },
        ]);
        const { r, dir } = await runOnce({ llm, history: [{ role: "user", content: "写一份很长的年报" }] });
        eq(r.stopped, null, "★反向对照：截一次、重发成功就照常干完★ 不许一截就停");
        ok(!fs.existsSync(path.join(dir, "半截.md")), "  └ 被截的那次照样没执行");
        eq(fs.existsSync(path.join(dir, "年报.md")) ? fs.readFileSync(path.join(dir, "年报.md"), "utf8") : null, "第一章", "  └ 重发的那次真执行了");
        eq(llm.seen.length, 3, "  └ 一共三次：被截 / 重发 / 收尾");
        ok(!/输出被截断，已停止/.test(r.finalText), "  └ 最后的回复里没有「已停止」", r.finalText);
      }

      // C 一批两个调用，只截了最后一个：前面那个参数已经闭合，照常执行
      {
        const llm = scripted([
          {
            text: "两个文件一起写。",
            toolCalls: [{ id: "a1", name: "write_file", input: { path: "甲.md", content: "甲的全文" } }, half("b1", "乙.md")],
            stopReason: "max_tokens",
          },
          { text: "好的。", toolCalls: [], stopReason: "end_turn" },
        ]);
        const { r, dir, history } = await runOnce({ llm, history: [{ role: "user", content: "写两个文件" }] });
        ok(fs.existsSync(path.join(dir, "甲.md")), "★只丢最后那一个★ 排在前面、参数已经写完的照常执行");
        ok(!fs.existsSync(path.join(dir, "乙.md")), "  └ 最后那个（半截的）没执行");
        const second = llm.seen[1] || [];
        const tail = second.slice(-2);
        ok(tail[0] && tail[0].role === "tool" && tail[0].results.length === 1 && tail[0].results[0].id === "a1", "  └ 工具结果只配前面那个，没有给半截的那个编结果", tail[0]);
        ok(tail[1] && tail[1].role === "user" && tail[1].content.startsWith("【系统·输出截断】"), "  └ 续写提示排在工具结果后面（先闭合 tool_calls，再说话）", tail[1]);
        eq(r.stopped, null, "  └ 第二次没被截：不停");
        ok(!history.some((e) => e.role === "assistant" && (e.toolCalls || []).some((c) => c.id === "b1")), "  └ 半截那个也从历史里摘掉了");
      }

      // D OpenAI 兼容通道报 length：半截的参数是 _raw 残片，走同一条路
      {
        const realFetch = global.fetch;
        let posts = 0;
        const bodies = [];
        global.fetch = async (url, init) => {
          if (!/\/chat\/completions$/.test(String(url))) throw new Error("测试里不该有别的请求：" + url);
          posts++;
          bodies.push(JSON.parse(init.body));
          const tc = { id: "oa" + posts, type: "function", function: { name: "write_file", arguments: '{"path":"长文.md","content":"第一章 概况\\n营收同比' } };
          return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [tc] }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 8192 } }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
        try {
          const llm = llmMod.createLLM({ models: [{ name: "桩", provider: "openai", base_url: "http://127.0.0.1:9/v1", api_key: "sk-test-offline", model: "mock-model", stream: false, max_tokens: 1024 }] });
          const { r, dir } = await runOnce({ llm, history: [{ role: "user", content: "写一篇长文" }] });
          ok(!fs.existsSync(path.join(dir, "长文.md")), "★OpenAI 兼容报 length：半截的调用同样不执行★");
          eq(posts, 2, "  └ 同样只续写一次");
          eq(r.stopped, TRUNC_STOP, "  └ 第二次还截：停");
          ok(bodies.every((b) => b.max_tokens === 1024), "  └ 请求体里的 max_tokens 取的是模型条目自己写的", bodies.map((b) => b.max_tokens));
          ok(!(bodies[1].messages || []).some(emptyOA), "★续写那次的请求体里也没有空 assistant★ 摘掉半截调用剩下的空壳不发", (bodies[1].messages || []).map((m) => m.role));
        } finally {
          global.fetch = realFetch;
        }
      }

      // E 纯正文被截：同样只续一次，前后两段拼起来交付
      {
        const llm = scripted([
          { text: "上半段……", toolCalls: [], stopReason: "max_tokens" },
          { text: "下半段。", toolCalls: [], stopReason: "end_turn" },
        ]);
        const { r } = await runOnce({ llm, history: [{ role: "user", content: "讲个长故事" }] });
        eq(llm.seen.length, 2, "纯正文被截：续写一次");
        ok(r.finalText.startsWith("上半段……下半段。"), "  └ 交付的是前后两段拼起来的全文，不是只剩后半段", r.finalText);
        eq(r.stopped, null, "  └ 续写成功就不停");
      }

      // F 被截的那条一个正文字都没有（推理模型把额度全花在思考上）：不许把更早那步的旁白拼进交付
      {
        const llm = scripted([
          { text: "我先看看目录。", toolCalls: [{ id: "ls1", name: "list_files", input: {} }], stopReason: "tool_use" },
          { text: "", toolCalls: [], stopReason: "max_tokens" },
          { text: "完整答案。", toolCalls: [], stopReason: "end_turn" },
        ]);
        const { r } = await runOnce({ llm, history: [{ role: "user", content: "讲个长故事" }] });
        eq(llm.seen.length, 3, "空正文被截：同样续写一次");
        ok(r.finalText.startsWith("完整答案。") && !r.finalText.includes("我先看看目录"), "★被截那条是空的：交付里不混进上一步的旁白★", r.finalText);
      }

      // G 纯正文连着两次被截：停，但不许谎称「调用没有执行」——这一趟根本没有调用；两段正文照样交付
      {
        const llm = scripted([
          { text: "上半段……", toolCalls: [], stopReason: "max_tokens" },
          { text: "中段……", toolCalls: [], stopReason: "length" },
        ]);
        const { r, events } = await runOnce({ llm, history: [{ role: "user", content: "讲个长故事" }] });
        eq(r.stopped, TRUNC_STOP, "纯正文连着两次被截：同样停");
        ok(r.finalText.startsWith("上半段……中段……"), "  └ 写出来的两段都交给用户，不是只剩后半段", r.finalText);
        const saidG = events.filter((e) => e.type === "text").map((e) => e.delta).join("") + r.finalText;
        ok(saidG.includes(TRUNC_STOP) && !/调用/.test(saidG), "★没有调用就不说「调用没有执行」★ 措辞跟实际发生的对不上，用户会去找根本不存在的调用", saidG.slice(-200));
      }

      // 停下来那句话：说对下一步
      const tn = stopNotice(TRUNC_STOP);
      ok(tn.includes(TRUNC_STOP) && tn.includes("接着上次进度做") && !tn.includes("执行上限"), "停止提示：给一条走得回去的路，不劝人调执行上限", tn);
      ok(!/调用/.test(tn), "  └ 不说「调用没有执行」：纯正文被截也走这句，有没有调用由循环里那条提示分开说", tn);
    }

    // ════════════════════════════════════════════════════════════════════════
    // 下面三件是同一类钱：每一步都整段重发的那些字。
    //   ⑩ system 的易变段（记忆/项目/时间）以前夹在中间，换一句话问，后面几万字的缓存全作废
    //   ⑪ 历史能带多少字以前写死 12 万，跟模型窗口没关系：64k 的模型塞爆、1M 的模型用不上
    //   ⑫ 一次工具结果几万字，整段进历史，之后每一步都重发一遍
    // ════════════════════════════════════════════════════════════════════════
    const memory = require(path.join(ROOT, "memory"));
    const { contextBudgetChars, spillToolResult, SPILL_OVER, SPILL_KEEP } = require(path.join(ROOT, "agent"));
    const { anthropicSystemBlocks, parseWindowSize, CONTEXT_WINDOW_DEFAULT } = llmMod._internals;
    /** 同一个工作目录里跑（工作目录的路径写在 system 的稳定段里，换目录前缀本来就该变） */
    async function runIn(dir, { llm, history, config, ...rest }) {
      const events = [];
      const rt = createAgentRuntime({ config: config || cfgOf(), llm, mcpManager: new McpManager(), experts: EXPERTS });
      const r = await tools.withWorkspace(dir, () => rt.runTask({ history, emit: (e) => events.push(e), ...rest }));
      return { r, events, history };
    }
    /** 记下每次请求的 system 和稳定段长度，一步就答完 */
    const sysCatcher = (extra) => {
      const seen = [];
      return {
        provider: "mock", model: "scripted", ...extra, seen,
        async chat(args) {
          if (args.tools && args.tools.length) seen.push({ system: args.system, stableLen: args.systemStableLen });
          return { text: "好的。", toolCalls: [], stopReason: "end_turn", usage: { prompt: 1, completion: 1 } };
        },
      };
    };

    // ── ⑩ system 稳定段在前 ────────────────────────────────────────────────
    console.log("\n⑩ system 稳定段在前：换一句话问，前缀逐字不变（提示词缓存才吃得到）");
    {
      const realPB = memory.promptBlock;
      // 记忆按本次线索挑条目：桩把线索原样写进去，两轮线索不同，记忆块就一定不同
      memory.promptBlock = async (u, hint) => `\n\n## 用户的长期记忆（桩）\n- 本次线索：${hint}`;
      const dir = path.join(TMP, "stable");
      fs.mkdirSync(dir);
      try {
        const common = { lang: "en", mode: "craft", projectContext: "封面统一用宋体。" };
        const A = sysCatcher(), B = sysCatcher();
        await runIn(dir, { llm: A, history: [{ role: "user", content: "写一份年报" }], ...common });
        await runIn(dir, { llm: B, history: [{ role: "user", content: "查一下明天的天气" }], ...common });
        const a = A.seen[0] || {}, b = B.seen[0] || {};
        ok(typeof a.stableLen === "number" && a.stableLen > 0 && a.stableLen < String(a.system).length,
          "稳定段长度跟着请求一起带给 L.chat（Anthropic 通道按它打断点）", { stableLen: a.stableLen, len: String(a.system || "").length });
        const sa = String(a.system || "").slice(0, a.stableLen), sb = String(b.system || "").slice(0, b.stableLen);
        ok(sa.length > 1000 && sa === sb, "★★两轮 memHint 不同，稳定段逐字相同★★ 前缀缓存从头命中到这一段末尾",
          sa === sb ? undefined : { a: sa.length, b: sb.length, firstDiff: [...sa].findIndex((c, i) => c !== sb[i]) });
        ok(a.system !== b.system, "  └（对照）整段 system 确实不同：上一条不是因为两轮一模一样才过的");
        const va = String(a.system).slice(a.stableLen), vb = String(b.system).slice(b.stableLen);
        ok(va.includes("本次线索：写一份年报") && vb.includes("本次线索：查一下明天的天气"), "  └ 记忆块在易变段，而且真是按这一轮的线索挑的");
        ok(!sa.includes("本次线索"), "★记忆一个字都不许留在稳定段★ 留一个字，换句话问整段缓存就作废");
        ok(va.includes("封面统一用宋体") && !sa.includes("封面统一用宋体"), "  └ 项目块在易变段（用户改一句项目规范，不该作废角色/工具规则那一大段）");
        ok(/## 当前时间/.test(va) && !/## 当前时间/.test(sa), "  └ 当前时间在易变段（按小时变，放前面等于每小时全价重买一遍）");
        // 日期的写法跟 envToday 一致（「2026 年 9 月 24 日」）；先在易变段里认出它，免得这条因为格式对不上恒真
        const DATE_RE = /\d{4} 年 \d{1,2} 月 \d{1,2} 日/;
        ok(DATE_RE.test(va) && !DATE_RE.test(sa), "  └ 日期只在易变段、稳定段里一个都没有", (sa.match(/.{0,20}\d{4} 年 \d{1,2} 月 \d{1,2} 日.{0,20}/) || [])[0]);
        ok(/## 工具能力/.test(sa) && /当前模式：Craft/.test(sa) && /## Reply language/.test(sa), "  └ 角色、工具规则、语言、模式都在稳定段");
        ok(sa.indexOf("## Reply language") < sa.indexOf("当前模式：Craft"), "  └ 语言在模式前面（顺序跟以前一样，只是把易变的挪到了后面）");
      } finally {
        memory.promptBlock = realPB;
      }

      // Anthropic 通道：稳定段、易变段各一块，各打一个缓存断点
      const blocks = anthropicSystemBlocks("稳定稳定易变", 4);
      eq(blocks.map((b) => b.text), ["稳定稳定", "易变"], "Anthropic：system 拆成两块，切在稳定段末尾");
      ok(blocks.every((b) => b.cache_control && b.cache_control.type === "ephemeral"), "  └ 两块都打了 cache_control（稳定段那个断点是这次要的）");
      eq(anthropicSystemBlocks("整段", 0).length, 1, "  └ 没给稳定段长度：老样子一整块");
      eq(anthropicSystemBlocks("整段", 2).length, 1, "  └ 稳定段就是全部：也是一整块，不拆出一个空块（空 text 块会被接口 400）");
      eq(anthropicSystemBlocks("", 3), "", "  └ 没有 system：原样不动");

      // 真发一趟 Anthropic 请求（本机假服务、回 401，一分钱不花），看发出去的那份 body。
      // 只测 anthropicSystemBlocks 这个函数不够：anthropicChat 没用它、或者没把稳定段长度递进去，上面照样全绿
      {
        const http = require("http");
        const bodies = [];
        const srv = http.createServer((req, res) => {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => {
            try { bodies.push(JSON.parse(b)); } catch { bodies.push(null); }
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "测试桩：只看 body" } }));
          });
        });
        await new Promise((r) => srv.listen(0, "127.0.0.1", r));
        try {
          const an = llmMod.createLLM({ models: [{ name: "桩A", provider: "anthropic", model: "claude-x", api_key: "sk-test-offline", base_url: `http://127.0.0.1:${srv.address().port}` }] });
          const h = [{ role: "user", content: "第一句" }, { role: "assistant", text: "好", toolCalls: [] }, { role: "user", content: "第二句" }];
          try { await an.chat({ system: "稳定稳定易变", systemStableLen: 4, history: h, tools: [] }); } catch {}
          try { await an.chat({ system: "整段", history: h, tools: [] }); } catch {}
        } finally {
          await new Promise((r) => srv.close(r));
        }
        const [b1, b2] = bodies;
        eq(b1 && (b1.system || []).map((x) => x.text), ["稳定稳定", "易变"], "★真发出去的 Anthropic 请求★ system 在稳定段末尾切成两块");
        ok(!!b1 && (b1.system || []).every((x) => x.cache_control && x.cache_control.type === "ephemeral"), "  └ 两块各带一个 cache_control");
        const marks = (o) => (JSON.stringify(o).match(/"cache_control"/g) || []).length;
        ok(!!b1 && marks(b1) >= 2 && marks(b1) <= 4, "  └ 整个请求的缓存断点不超过 4 个（超了接口直接 400）", b1 && marks(b1));
        eq(b2 && (b2.system || []).length, 1, "  └ 没给稳定段长度的调用：还是一整块");
      }

      // 撞上限后收尾那一问也切在同一处：不然主循环攒下的缓存，收尾这一下又全价重买一遍
      {
        const seenW = [];
        const llmW = {
          provider: "mock", model: "scripted",
          async chat(args) {
            const n = (args.tools || []).length;
            seenW.push({ n, stableLen: args.systemStableLen, system: String(args.system || "") });
            if (n) return { text: "看一眼。", toolCalls: [{ id: "w" + seenW.length, name: "list_files", input: {} }], stopReason: "tool_use", usage: { prompt: 1, completion: 1 } };
            return { text: "（收尾）", toolCalls: [], stopReason: "end_turn", usage: { prompt: 1, completion: 1 } };
          },
        };
        await runOnce({ llm: llmW, history: [{ role: "user", content: "列一下目录" }], config: cfgOf({ max_steps: 1, auto_continue_rounds: 0 }) });
        const main = seenW.find((x) => x.n), wrap = seenW.find((x) => !x.n);
        ok(!!main && !!wrap && main.stableLen > 0 && wrap.stableLen === main.stableLen && wrap.system.slice(0, wrap.stableLen) === main.system.slice(0, main.stableLen),
          "  └ 撞上限的收尾那一问：稳定段长度照样带上，切在同一处", { main: main && main.stableLen, wrap: wrap && wrap.stableLen });
      }
    }

    // ── ⑪ 按模型窗口算能带多少历史 ─────────────────────────────────────────
    console.log("\n⑪ 历史能带多少字：按模型窗口算，不再写死 12 万");
    {
      ok(contextBudgetChars(64000) < contextBudgetChars(200000), "★★64k 窗口的模型 maxChars 小于 200k 的★★",
        { k64: contextBudgetChars(64000), k200: contextBudgetChars(200000) });
      eq(contextBudgetChars(64000), 112000, "  └ 64k × 2.5 字/token × 0.7 = 11.2 万字（以前写死 12 万，64k 的模型会塞爆）");
      eq(contextBudgetChars(200000, 120000), 120000, "  └ 用户显式配了上限：取小的那个，用户说了算");
      eq(contextBudgetChars(32000, 400000), 56000, "  └ 显式上限比窗口还大：按窗口来，不许把窗口撑爆");
      eq(contextBudgetChars(undefined), contextBudgetChars(CONTEXT_WINDOW_DEFAULT), "  └ 不知道窗口：按 64k 保守估");

      const cw = llmMod.contextWindowOf;
      eq(cw({ context_window: 1000000 }, "claude-sonnet-4-5"), 1000000, "contextWindowOf：渠道里写了 context_window 就信它");
      eq(cw({ context_window: "256k" }, "whatever"), 256000, "  └ 写成「256k」也认");
      eq(parseWindowSize("1m"), 1000000, "  └ 「1m」也认");
      eq(cw({ context_window: 10 }, "claude-sonnet-4-5"), 200000, "  └ 写了个不像样的数（10）：不信，退回按名字查");
      eq(cw(null, "claude-sonnet-4-5"), 200000, "  └ 没写：查模型族表（claude 200k）");
      eq(cw({}, "deepseek-chat"), 128000, "  └ deepseek 128k");
      eq(cw({}, "moonshot-v1-8k"), 8000, "  └ 名字里带尺寸的按名字（moonshot-v1-8k）");
      eq(cw({}, "gpt-4"), 8192, "  └ 老 gpt-4 只有 8k：不许被 gpt-4o 那条吃掉");
      // 反过来：名字以 gpt-4 开头的 128k 模型不许被「老 gpt-4 = 8k」那条吃掉（吃掉了预算塌到 1.4 万字）
      eq(["gpt-4.5-preview", "openai/gpt-4-0125-preview", "gpt-4-1106-preview", "gpt-4-turbo", "gpt-oss-120b", "mistral-large-latest"].map((m) => cw({}, m)),
        [128000, 128000, 128000, 128000, 128000, 128000], "  └ gpt-4.5 / gpt-4-xxxx-preview / gpt-oss / mistral-large 都是 128k");
      eq(cw({}, "gpt-4-0613"), 8192, "  └ gpt-4-0613 仍按 8k");
      eq(cw({}, "某个自建模型-x"), 64000, "  └ 都查不到：64k 保守估");
      ok(cw({}, "gemini-2.5-pro") <= 200000, "  └ 猜出来的最多按 200k 算（1M 的要用户在渠道里写明，猜错了代价是整段 400）", cw({}, "gemini-2.5-pro"));

      // 真跑：用量条上的 budget 就是这一步截短历史用的那个数
      const budgetOf = async (llm, agentCfg, extra) => {
        const { events } = await runOnce({ llm, history: [{ role: "user", content: "你好" }], config: cfgOf(agentCfg, extra) });
        const ev = events.find((e) => e.type === "context");
        return ev ? ev.budget : null;
      };
      const b64 = await budgetOf(sysCatcher({ contextWindow: 64000 }));
      const b200 = await budgetOf(sysCatcher({ contextWindow: 200000 }));
      ok(b64 && b200 && b64 < b200, "★真跑也一样★ 64k 模型这一步的预算小于 200k 的", { b64, b200 });
      eq(b64, 112000, "  └ 数字对得上 contextBudgetChars");
      eq(await budgetOf(sysCatcher({ contextWindow: 200000 }), { max_context_chars: 120000 }), 120000, "  └ 用户配了 12 万：200k 的模型也只带 12 万");
      // 老的 / 测试里的假客户端没报 contextWindow：按名字回 config.models 找那条渠道
      eq(await budgetOf(sysCatcher({ provider: "小窗口渠道" }), {}, { models: [{ name: "小窗口渠道", model: "scripted", context_window: 32000 }] }), 56000,
        "  └ 客户端没报窗口：回配置里找那条渠道的 context_window");
    }

    // ── ⑫ 大工具结果落盘 ───────────────────────────────────────────────────
    console.log("\n⑫ 单个工具结果超 2 万字：全文落盘，历史里只留头尾和路径");
    {
      const dir = path.join(TMP, "spill");
      fs.mkdirSync(dir);
      const lines = Array.from({ length: 1000 }, (_, i) => `第${String(i + 1).padStart(4, "0")}行 ` + "数据".repeat(10)); // 约 2.6 万字
      const big = lines.join("\n");
      ok(big.length > 25000 && big.length > SPILL_OVER, "（前提）造出来的结果超过 2.5 万字", big.length);

      await tools.withWorkspace(dir, async () => {
        const small = { id: "s1", name: "run_node", content: "短结果", isError: false };
        ok(spillToolResult(small, {}) === small, "没超 2 万字：原样返回，一个字不动");

        const e1 = spillToolResult({ id: "call_big", name: "run_node", content: big, isError: false }, {});
        const f1 = path.join(dir, ".openworkbuddy", "tool-results", "call_big.txt");
        ok(fs.existsSync(f1) && fs.readFileSync(f1, "utf8") === big, "★全文一字不差落到 .openworkbuddy/tool-results/调用id.txt★");
        ok(e1.content.length < 5000, "★★历史里只剩不到 5k 字★★", e1.content.length);
        ok(e1.content.includes(".openworkbuddy/tool-results/call_big.txt") && e1.content.includes("可用 read_file 分段读"), "  └ 带路径，也说了怎么读");
        ok(e1.content.includes(big.slice(0, SPILL_KEEP)) && e1.content.includes(big.slice(-SPILL_KEEP)), "  └ 头尾各 2000 字原样留着");
        ok(e1.id === "call_big" && e1.name === "run_node" && e1.isError === false, "  └ id / 工具名 / 是否出错都不变（tool_use 和结果照样对得上）");
        ok(e1.content.indexOf("tool-results/call_big.txt") < 200, "  └ 路径在开头：历史再被截短（旧结果只留前 300 字）也还在", e1.content.indexOf("tool-results"));

        const e2 = spillToolResult({ id: "call_big", name: "run_node", content: big + "改", isError: false }, {});
        ok(e2.content.includes("tool-results/call_big-2.txt") && fs.readFileSync(f1, "utf8") === big, "★同一个 id 再来一次：另起 -2，绝不覆盖前一份★（有的接口每轮都从 call_0 数起）");

        const e3 = spillToolResult({ id: "rf", name: "read_file", content: big, isError: false }, { path: ".openworkbuddy/tool-results/call_big.txt" });
        ok(e3.content === big, "★读的就是落盘文件本身：不再落一次★ 否则模型永远读不到正文");
        const e4 = spillToolResult({ id: "../../逃出去", name: "run_node", content: big, isError: false }, {});
        const m4 = e4.content.match(/\.openworkbuddy\/tool-results\/([^\s，]+\.txt)/);
        ok(m4 && !/[\\/]/.test(m4[1]) && fs.existsSync(path.join(dir, ".openworkbuddy", "tool-results", m4[1])), "  └ id 里有 ../ 也写不出这个目录", m4 && m4[1]);
      });

      // 真跑：read_file 读一个 2.6 万字的文件，下一步请求里的历史
      fs.writeFileSync(path.join(dir, "大表.txt"), big);
      const llm = scripted([
        { text: "先读。", toolCalls: [{ id: "rf1", name: "read_file", input: { path: "大表.txt" } }], stopReason: "tool_use" },
        { text: "看中间。", toolCalls: [{ id: "rf2", name: "read_file", input: { path: ".openworkbuddy/tool-results/rf1.txt", start_line: 500, end_line: 502 } }], stopReason: "tool_use" },
        { text: "读完了。", toolCalls: [], stopReason: "end_turn" },
      ]);
      await runIn(dir, { llm, history: [{ role: "user", content: "读一下大表" }] });
      const h2 = llm.seen[1] || [];
      const asst = h2.filter((e) => e.role === "assistant").pop() || {};
      const res = h2.filter((e) => e.role === "tool").pop() || { results: [] };
      const r1 = res.results[0] || {};
      ok((asst.toolCalls || []).map((c) => c.id).join() === "rf1" && res.results.map((x) => x.id).join() === "rf1",
        "★tool_use 和结果仍然成对★ 结果换成了摘要，id 还是那一个", { calls: (asst.toolCalls || []).map((c) => c.id), results: res.results.map((x) => x.id) });
      ok(String(r1.content).length < 5000 && String(r1.content).includes(".openworkbuddy/tool-results/rf1.txt"),
        "★★真跑：2.6 万字的读文件结果，下一步请求里只剩不到 5k 字，带路径★★", String(r1.content).length);
      ok(!h2.some((e) => e.role === "tool" && e.results.some((x) => String(x.content).length > SPILL_OVER)), "  └ 整段历史里没有哪条结果超过 2 万字");
      const h3 = llm.seen[2] || [];
      const r2 = ((h3.filter((e) => e.role === "tool").pop() || { results: [] }).results[0]) || {};
      ok(r2.id === "rf2" && String(r2.content).includes(lines[499]) && !r2.isError, "★路径真读得回来★ 按提示分段读，拿到的是原文第 500 行", String(r2.content).slice(0, 80));
    }

    // ── ⑬ 悬空的工具调用：补进历史本身，断在会动东西的那步不重放 ─────────────
    // 进程死在「带 tool_calls 的 assistant 已落盘、工具结果还没落盘」之间，盘上就留下一个没人应答的 tool_use。
    // llm.js 的 repairToolPairs 只在转换层临时补一条，还劝模型「重新调用一次」——断在生成视频上，就是再扣一次钱。
    console.log("\n⑬ 上次断在工具执行中间：结果补进历史，会动东西的不重放，没断过的历史一字不动");
    {
      const { closeDanglingCalls, resumeNotice, INTERRUPTED_RESULT, REDO_SAFE_TOOLS } = require(path.join(ROOT, "agent"));
      const U = (content) => ({ role: "user", content });
      const A = (text, toolCalls) => ({ role: "assistant", text, toolCalls: toolCalls || [] });
      const T = (...results) => ({ role: "tool", results });
      const R = (id, name, content) => ({ id, name, content, isError: false });
      const W = (id, p) => ({ id, name: "write_file", input: { path: p, content: "第一段" } });
      const V = (id) => ({ id, name: "generate_video", input: { prompt: "一只猫在弹琴" } });
      const RF = (id, p) => ({ id, name: "read_file", input: { path: p } });
      /** 每个 tool_use 后面紧跟的那几条 tool 里都得有它的结果：OpenAI / Anthropic 都按这个认 */
      const unpaired = (h) => {
        const miss = [];
        h.forEach((e, i) => {
          if (!e || e.role !== "assistant") return;
          const got = new Set();
          for (let j = i + 1; j < h.length && h[j].role === "tool"; j++) for (const x of h[j].results || []) got.add(x.id);
          for (const c of e.toolCalls || []) if (!got.has(c.id)) miss.push(c.id);
        });
        return miss;
      };

      // A 纯函数：怎么补、补在哪
      {
        const h = [U("写个文件再生成视频"), A("先写文件，再生成视频。", [W("u_w1", "半截.md"), V("u_v1")]), U("接着上次进度做")];
        const p = closeDanglingCalls(h);
        eq(h.map((e) => e.role), ["user", "assistant", "tool", "user"], "★补的结果紧挨着 assistant，插在后面那句用户消息之前★ OpenAI 兼容要求 tool 紧跟 tool_calls");
        eq(unpaired(h), [], "  └ 两个调用都配上了对");
        const [rw, rv] = h[2].results;
        ok(rw.id === "u_w1" && rw.name === "write_file" && rw.isError === true && rw.content.startsWith(INTERRUPTED_RESULT), "★结果就是路线图那句原话★ 标成出错，模型不会当它成功了", rw);
        ok(/不要自动重做/.test(rw.content) && /先问用户/.test(rw.content), "  └ 会动东西的：明说不要自动重做、先问用户", rw.content);
        ok(/再扣一次费/.test(rv.content) && !/再扣一次费/.test(rw.content), "  └ 生成媒体的才提扣费，写文件的不提", [rw.content, rv.content]);
        ok(!/重新调用一次/.test(rw.content + rv.content), "  └ 没有转换层那句「重新调用一次」");
        eq(p.map((x) => [x.id, x.sideEffect, x.tail]), [["u_w1", true, true], ["u_v1", true, true]], "  └ 报回补了哪几个：都是会动东西的、都在最后一条 assistant 上");
        const note = resumeNotice(p);
        ok(note.includes("上次在执行「写 半截.md」等 2 步时中断") && note.includes("不自动重做") && note.includes("再扣一次费"),
          "★给用户那句：断在哪一步、这次不重做、生成媒体重做要扣费★", note);
        const before = JSON.stringify(h);
        eq(closeDanglingCalls(h), [], "★补过一次再跑：什么都不补★ 不会越补越多");
        ok(JSON.stringify(h) === before, "  └ 历史一个字节都不动");
      }
      {
        const h = [U("看看这个文件"), A("先读。", [RF("u_r1", "a.md")])];
        const p = closeDanglingCalls(h);
        eq(h.map((e) => e.role), ["user", "assistant", "tool"], "断在历史最末尾（后面没有用户消息）：结果补在最后");
        ok(h[2].results[0].content === INTERRUPTED_RESULT + "。" && !/不要自动重做/.test(h[2].results[0].content), "  └ 只读的：只说结果未知，不拦重做（重读一遍不花钱也不动东西）", h[2].results[0].content);
        eq(resumeNotice(p), "", "  └ 只读的不跟用户提");
        ok(REDO_SAFE_TOOLS.has("read_file") && !REDO_SAFE_TOOLS.has("write_file") && !REDO_SAFE_TOOLS.has("run_shell") && !REDO_SAFE_TOOLS.has("generate_video") && !REDO_SAFE_TOOLS.has("send_email"),
          "  └ 会动东西的都不在「可放心重做」名单里");
        const mcp = [U("x"), A("", [{ id: "u_m1", name: "mcp_feishu_send_message", input: {} }])];
        ok(closeDanglingCalls(mcp)[0].sideEffect === true, "  └ 没登记的（MCP 连接器）一律当会动东西");
      }
      {
        const h = [U("写两个文件"), A("", [W("u_p1", "甲.md"), W("u_p2", "乙.md")]), T(R("u_p1", "write_file", "已写入 甲.md")), U("继续")];
        const p = closeDanglingCalls(h);
        eq(h.length, 4, "★只缺其中一个结果的：补进已有那条 tool，不另插一条★");
        eq(h[2].results.map((x) => x.id), ["u_p1", "u_p2"], "  └ 已有的结果原样在前，缺的那个接在后面");
        ok(h[2].results[0].content === "已写入 甲.md", "  └ 已有的结果一个字不改");
        eq(p.map((x) => x.id), ["u_p2"], "  └ 报回的只有补上的那个");
      }
      {
        const h = [U("画张图"), { role: "assistant", text: "好", raw: [{ type: "text", text: "好" }, { type: "tool_use", id: "u_raw1", name: "generate_image", input: { prompt: "猫" } }] }, U("继续")];
        closeDanglingCalls(h);
        ok(h[2] && h[2].role === "tool" && h[2].results[0].id === "u_raw1", "★只记在 raw 里的 tool_use 也认得★ 不然 Claude 那边照样 400", h[2]);
        const an = toAnthropicMessages(h);
        const tr = an.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === "tool_result" && b.tool_use_id === "u_raw1");
        ok(tr && String(tr.content).startsWith(INTERRUPTED_RESULT) && !/结果缺失/.test(String(tr.content)), "  └ 转成 Anthropic 格式：发出去的是补进历史的那条，不是转换层的占位", tr);
      }
      {
        const h = [U("写"), A("", [W("u_old", "旧.md")]), U("算了，换个话题"), A("好的。"), U("写首诗")];
        const p = closeDanglingCalls(h);
        ok(p.length === 1 && p[0].tail === false && unpaired(h).length === 0, "修这个之前留下的旧伤（更早的一条 assistant）：照样补上", p);
        eq(resumeNotice(p), "", "  └ 但不跟用户提：用户早就往下聊了");
      }
      {
        // 旧伤补一条 tool 会把后面的下标全往后挪一格：按下标认「最后一条 assistant」就认错了，这一趟真断的那步反而不提
        const h = [U("写"), A("", [W("u_old2", "旧.md")]), U("换个话题"), A("先生成视频。", [V("u_new2")]), U("继续")];
        const p = closeDanglingCalls(h);
        eq(p.map((x) => [x.id, x.tail]), [["u_old2", false], ["u_new2", true]], "★前面有旧伤、这一趟又断了：旧的不算这一趟，新断的那步照样认成最后一条★");
        ok(resumeNotice(p).includes("上次在执行「生成视频") && unpaired(h).length === 0, "  └ 跟用户提的是这一趟断的那步", resumeNotice(p));
      }
      {
        const h = [U("写"), A("", [W("u_dup", "a.md"), W("u_dup", "a.md")]), U("继续")];
        closeDanglingCalls(h);
        eq(h[2].results.map((x) => x.id), ["u_dup"], "同一个 id 记了两遍的：只补一条");
      }
      {
        const clean = () => [U("写首诗"), A("先看看。", [RF("u_ok1", "a.md")]), T(R("u_ok1", "read_file", "内容")), A("写好了。"), U("再来一首")];
        const h = clean();
        const before = JSON.stringify(h);
        eq(closeDanglingCalls(h), [], "★没有悬空调用：什么都不补★");
        ok(JSON.stringify(h) === before, "  └ 历史逐字不变");
        eq(closeDanglingCalls([]), [], "  └ 空历史不炸");
        eq(closeDanglingCalls(undefined), [], "  └ 不是数组也不炸");
      }

      // B 真跑：上次断在「写文件 + 生成视频」上，用户回来说「接着上次进度做」
      {
        const history = [U("写个文件再生成视频"), A("先写文件，再生成视频。", [W("dz_w1", "半截.md"), V("dz_v1")]), U("接着上次进度做")];
        const llm = scripted([{ text: "上次那两步结果未知，我先不重做。要重做的话告诉我。", toolCalls: [], stopReason: "end_turn" }]);
        const events = [];
        let firstSnap = null;
        const emit = (e) => {
          if (!firstSnap) firstSnap = JSON.parse(JSON.stringify(history)); // server.js 在事件上存盘：第一次存下去的就是这一刻的样子
          events.push(e);
        };
        const warned = warns.length;
        const { r, dir } = await runOnce({ llm, history, emit });
        const first = llm.seen[0] || [];
        eq(unpaired(first), [], "★★第一轮请求里 tool_use 和 tool_result 成对★★");
        const res = (first.find((e) => e.role === "tool") || { results: [] }).results;
        eq(res.map((x) => x.id), ["dz_w1", "dz_v1"], "  └ 两个调用各配一条结果");
        ok(res.every((x) => x.isError && x.content.startsWith(INTERRUPTED_RESULT) && /不要自动重做/.test(x.content)), "  └ 结果是「上次运行在这一步中断，结果未知…」，不是空的也不是转换层的占位", res.map((x) => x.content));
        eq(first.map((e) => e.role), ["user", "assistant", "tool", "user"], "  └ 补的结果在那句「接着上次进度做」之前");
        ok(history[2] && history[2].role === "tool" && unpaired(history).length === 0, "★补进的是调用方那份历史（sess.history）★ 落盘的就是配好对的", history.map((e) => e.role));
        ok(firstSnap && unpaired(firstSnap).length === 0 && firstSnap[2].role === "tool", "★同一次写入★ 第一个事件发出时历史里已经是一整对，存盘不会存下半截", firstSnap && firstSnap.map((e) => e.role));
        ok(!fs.existsSync(path.join(dir, "半截.md")), "★★断在写文件上的：没有被重放★★");
        ok(!events.some((e) => (e.type === "tool_use" || e.type === "tool_result") && /^dz_/.test(e.id)), "  └ 两个悬空调用都没有再执行一遍（生成视频不会再扣一次钱）", events.filter((e) => e.type === "tool_use").map((e) => e.name));
        eq(llm.seen.length, 1, "  └ 只问了模型一次");
        const texts = events.filter((e) => e.type === "text").map((e) => e.delta);
        ok(texts[0] && texts[0].includes("上次在执行「写 半截.md」等 2 步时中断") && texts[0].includes("不自动重做") && texts[0].includes("再扣一次费"),
          "★回复开头就说「上次在执行 X 时中断」★ 网页上第一条就是这句提示", texts[0]);
        ok(r.finalText.startsWith("> [!warn] **上次在执行") && r.finalText.includes("上次那两步结果未知"), "  └ finalText 也以它开头（IM / 定时任务读的是这个），模型的回复接在后面", r.finalText);
        eq(texts.filter((t) => t.includes("上次在执行")).length, 1, "  └ 只说一次");
        ok(!warns.slice(warned).some((w) => /dz_/.test(w) && /已补占位/.test(w)), "  └ 转换层没再补占位（历史里已经配好对了）", warns.slice(warned));
      }

      // C 真跑，断在只读的一步上：补上结果，不跟用户提
      {
        const history = [U("看看 a.md"), A("先读。", [RF("dz_r1", "a.md")]), U("继续")];
        const llm = scripted([{ text: "我重新读一下再说。", toolCalls: [], stopReason: "end_turn" }]);
        const { r, events } = await runOnce({ llm, history });
        eq(unpaired(llm.seen[0] || []), [], "断在只读的一步上：第一轮请求照样成对");
        ok(!events.some((e) => e.type === "text" && /上次在执行/.test(e.delta)) && !/上次在执行/.test(r.finalText), "  └ 不跟用户提（重读一遍不花钱也不动东西）", r.finalText);
      }

      // D 真的 openaiChat（fetch 是桩）：真正发出去的请求体里，tool_calls 后面紧跟的就是我们补的那条
      {
        const realFetch = global.fetch;
        const bodies = [];
        global.fetch = async (url, init) => {
          if (!/\/chat\/completions$/.test(String(url))) throw new Error("测试里不该有别的请求：" + url);
          bodies.push(JSON.parse(init.body));
          return new Response(JSON.stringify({ choices: [{ message: { content: "好的。" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
        const warned = warns.length;
        try {
          const llm = llmMod.createLLM({ models: [{ name: "桩", provider: "openai", base_url: "http://127.0.0.1:9/v1", api_key: "sk-test-offline", model: "mock-model", stream: false }] });
          const history = [U("打包一下"), A("先清掉旧产物再构建。", [{ id: "dz_oa1", name: "run_shell", input: { command: "rm -rf dist && npm run build" } }]), U("继续")];
          const { dir, events } = await runOnce({ llm, history });
          eq(bodies.length, 1, "只发了一次请求");
          const msgs = (bodies[0] || {}).messages || [];
          const k = msgs.findIndex((m) => m.role === "assistant" && (m.tool_calls || []).some((t) => t.id === "dz_oa1"));
          const next = msgs[k + 1] || {};
          ok(k > 0 && next.role === "tool" && next.tool_call_id === "dz_oa1", "★★真正发出去的请求体：tool_calls 后面紧跟它的 tool 消息★★", msgs.map((m) => m.role));
          ok(String(next.content).includes(INTERRUPTED_RESULT) && /不要自动重做/.test(String(next.content)) && !/结果缺失/.test(String(next.content)),
            "  └ 内容是补进历史的那句，不是转换层的「结果缺失…重新调用一次」", next.content);
          ok(!warns.slice(warned).some((w) => /dz_oa1/.test(w)), "  └ 转换层没有喊「已补占位」", warns.slice(warned));
          const made = fs.readdirSync(dir).filter((f) => !f.startsWith(".")); // 点开头的是运行时自己的目录（.tmp 之类）
          ok(!made.length && !events.some((e) => e.type === "tool_use"), "  └ 断在跑命令上的：没有被重放（没执行任何工具，工作目录里什么都没多）", made);
        } finally {
          global.fetch = realFetch;
        }
      }

      // E 没断过的会话：历史逐字不变，也没有提示
      {
        const history = [U("写首诗"), A("先看看。", [RF("dz_ok1", "a.md")]), T(R("dz_ok1", "read_file", "内容")), A("写好了。"), U("再来一首")];
        const before = JSON.stringify(history);
        const n = history.length;
        const llm = scripted([{ text: "又一首。", toolCalls: [], stopReason: "end_turn" }]);
        const { r, events } = await runOnce({ llm, history });
        ok(JSON.stringify(history.slice(0, n)) === before, "★★没有悬空调用时，历史逐字不变★★ 只在末尾追加这一轮的回复");
        ok(JSON.stringify((llm.seen[0] || []).slice(0, n)) === before, "  └ 发给模型的也是原样");
        ok(!events.some((e) => e.type === "text" && /上次在执行/.test(e.delta)) && r.finalText === "又一首。", "  └ 没有提示，finalText 就是模型的原话", r.finalText);
      }

      // F 接线：补在 normalizeHistory 之后（raw 里的调用先认出来）、一切事件和引擎分岔之前
      {
        const body = AGENT_SRC.slice(AGENT_SRC.indexOf("async function runTask("));
        const iN = body.indexOf("normalizeHistory(history);");
        const iC = body.indexOf("closeDanglingCalls(history)");
        const iE = body.indexOf("emit({");
        const iF = body.indexOf("底层引擎分岔");
        ok(iN >= 0 && iN < iC && iC < iE && iC < iF, "★runTask 里：normalizeHistory → closeDanglingCalls → 第一个事件 / 引擎分岔★", { iN, iC, iE, iF });
      }
    }
  } catch (e) {
    fail++;
    console.log("  ✗ 跑崩了：" + ((e && e.stack) || e));
  } finally {
    jev.askMetered = realAsk;
    console.warn = realWarn;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }

  console.log("\n" + (fail === 0 ? "全部通过" : "有失败") + "：" + pass + " 过 / " + fail + " 挂");
  process.exit(fail === 0 ? 0 : 1);
})();
