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

console.log("\n" + (fail === 0 ? "全部通过" : "有失败") + "：" + pass + " 过 / " + fail + " 挂");
process.exit(fail === 0 ? 0 : 1);
