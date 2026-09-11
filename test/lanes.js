"use strict";
/**
 * 两条工作线（lanes.js）的判据测试。
 *
 * 这个模块决定「这次的活儿交给谁的手」，一旦判错，用户的体感是两种事故：
 *   · 办公模式点下去，活儿其实交给了本机 CLI —— 生图、专家团、技能库整批消失，
 *     用户以为是工具坏了（这正是加两条线之前每天在发生的事）；
 *   · 命令行模式点下去，活儿悄悄回落到内置引擎 —— 用户以为在用已经付过的订阅，
 *     账单却在涨。这条是红线：宁可当场报错说「本机没装 claude」，也不许静默降级。
 *
 * 所以下面每一节都配反向对照：既证明该成立的成立，也证明**换一个输入就不成立**。
 * 只会变绿不会变红的断言不是测试。
 */

const path = require("path");
const ROOT = path.join(__dirname, "..");
const lanes = require(path.join(ROOT, "lanes"));
const engines = require(path.join(ROOT, "engines"));
const prefs = require(path.join(ROOT, "prefs"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

// ── ① 认名字：认不出来的一律当「没说」 ──────────────────────────────────
console.log("\n① 名字归一化");
eq(lanes.normalize("cli"), "cli", "cli 认得");
eq(lanes.normalize("office"), "office", "office 认得");
eq(lanes.normalize(" OFFICE "), "office", "前后空格和大小写都容忍（前端传什么样的都有）");
eq(lanes.normalize("craft"), "", "反向对照：mode 的值（craft）不是 lane，不许被认成一条线");
eq(lanes.normalize(undefined), "", "反向对照：没传 = 没说");
eq(lanes.normalize(null), "", "反向对照：null = 没说");
eq(lanes.normalize({ id: "cli" }), "", "反向对照：传个对象也只当没说，不许 [object Object] 混进来");
ok(lanes.get("cli") && lanes.get("cli").name === "命令行模式", "get 拿得到门面信息");
eq(lanes.get("nope"), null, "反向对照：不存在的线返回 null");
eq(lanes.LANES.length, 2, "一共就两条线");
eq(new Set(lanes.IDS).size, 2, "两条线的 id 不重名");

// ── ② 老会话归位：升级上来的历史不许整批「消失」到另一个标签底下 ──────────
console.log("\n② 老配置 / 老会话默认落在哪条线");
eq(lanes.defaultLane({ engine: "builtin" }), "office", "用内置引擎的人 → 办公模式");
eq(lanes.defaultLane({}), "office", "没配过 engine = 内置 → 办公模式");
eq(lanes.defaultLane(undefined), "office", "配置整个是空的也别炸");
eq(lanes.defaultLane({ engine: "codex" }), "cli", "反向对照：选了本机 Codex 的人，他的历史本来就是 CLI 跑的 → 命令行模式");
eq(lanes.defaultLane({ engine: "claude-code" }), "cli", "反向对照：本机 Claude Code 同理");
eq(lanes.laneOf({ lane: "office" }, { engine: "codex" }), "office", "会话上记过就认它，不受当前配置影响");
eq(lanes.laneOf({}, { engine: "codex" }), "cli", "会话没记过才按配置回落");
eq(lanes.laneOf({ lane: "垃圾" }, { engine: "builtin" }), "office", "反向对照：会话里存了脏值，回落而不是原样返回");

// ── ③ 每条线交给哪个引擎 ────────────────────────────────────────────────
console.log("\n③ 这条线把活儿交给谁");
eq(lanes.engineIdFor("office", { engine: "codex" }), "builtin", "办公模式钉死内置循环——生图 / 专家团 / 技能库都在这条路上");
eq(lanes.engineIdFor("office", { engine: "codex", cli_engine: "claude-code" }), "builtin", "反向对照：挑过 CLI 也改不了办公模式");
eq(lanes.engineIdFor("cli", { engine: "builtin", cli_engine: "codex" }), "codex", "命令行模式优先用为这条线挑的那个");
eq(lanes.engineIdFor("cli", { engine: "codex" }), "codex", "没单独挑过就沿用设置页选的那个 CLI");
eq(lanes.engineIdFor("cli", { engine: "builtin" }), lanes.CLI_FALLBACK, "从来没碰过引擎的人，命令行模式给个兜底名字（装没装由引擎那层当场判）");
eq(lanes.engineIdFor("cli", { engine: "codex", cli_engine: "claude-code" }), "claude-code", "反向对照：两个都填了，这条线自己挑的那个说了算");
eq(lanes.engineIdFor("", { engine: "codex" }), "codex", "没说要哪条线 = 照旧用配置里的那个（命令行 wb / 定时任务走的就是这条）");
eq(lanes.engineIdFor("", { engine: "builtin" }), "builtin", "同上，内置照旧是内置");
eq(lanes.engineIdFor("cli", { engine: "builtin", cli_engine: "   " }), lanes.CLI_FALLBACK, "反向对照：填了一串空格不算挑过");

// ── ④ 给 engines.resolve 的视图：只动 engine 一个字段 ─────────────────────
console.log("\n④ config 视图：改该改的，一个字节都不多改");
const CFG = Object.freeze({
  agent: { engine: "builtin", max_steps: 25, engine_options: { codex: { model: "o3" } } },
  models: [{ name: "主力" }],
  active_model: "主力",
});
ok(lanes.viewFor(undefined, CFG) === CFG, "没传 lane 时返回的是**同一个对象**（config.agent 会被就地热更新，复制一份出去等于让改动不生效）");
ok(lanes.viewFor("", CFG) === CFG, "空串同理");
ok(lanes.viewFor("office", CFG) === CFG, "已经就是内置了，不必造新对象");
const vCli = lanes.viewFor("cli", CFG);
ok(vCli !== CFG, "反向对照：命令行模式要换引擎，这时才造新对象");
eq(vCli.agent.engine, lanes.CLI_FALLBACK, "换过去的就是这条线该用的引擎");
eq(CFG.agent.engine, "builtin", "原配置一个字没被改（不是就地改，是视图）");
eq(vCli.agent.max_steps, 25, "agent 里别的字段原样带过去");
ok(vCli.agent.engine_options === CFG.agent.engine_options, "engine_options 原样引用，不深拷（用户填的 bin / model 不能在这儿丢）");
eq(vCli.active_model, "主力", "config 顶层的字段原样带过去");
const vOff = lanes.viewFor("office", { agent: { engine: "codex", thinking: "high" } });
eq(vOff.agent.engine, "builtin", "反向对照：CLI 用户点办公模式，视图里换成内置");
eq(vOff.agent.thinking, "high", "思考档跟着过去");

// ── ⑤ 接线：视图真的能让 engines 解出不同的 backend ──────────────────────
// 只解析，不起任何子进程——这一节不碰用户本机的 claude / codex，也不花一分钱
console.log("\n⑤ 接到 engines.resolve 上真的分岔了");
const rOff = engines.resolve(lanes.viewFor("office", { agent: { engine: "codex" } }));
eq(rOff.backend, null, "办公模式解出来 backend === null（null = 走内置那条老路）");
const rCli = engines.resolve(lanes.viewFor("cli", { agent: { engine: "codex" } }));
ok(rCli.backend && rCli.backend.id === "codex", "命令行模式解出来是本机 Codex", rCli.backend && rCli.backend.id);
eq(rCli.opts.model, undefined, "这份配置没给 codex 填过 model，opts 里就该是空的");
const rOpts = engines.resolve(lanes.viewFor("cli", { agent: { engine: "codex", engine_options: { codex: { model: "o3" } } } }));
eq(rOpts.opts.model, "o3", "反向对照：填过就带过去（换了引擎不能把用户填的模型弄丢）");
let threw = "";
try { engines.resolve(lanes.viewFor("cli", { agent: { engine: "builtin", cli_engine: "不存在的引擎" } })); }
catch (e) { threw = e.message; }
ok(/不存在/.test(threw), "反向对照：这条线挑了个不存在的引擎 → 当场抛错，绝不静默退回内置拿 API Key 去跑", threw);

// ── ⑥ 底层 CLI 的续跑 id 认引擎 ────────────────────────────────────────
console.log("\n⑥ 续跑 id 按引擎分开记");
const s1 = { engine_sessions: { "claude-code": "cc-1", codex: "cx-1" } };
eq(lanes.engineSessionFor(s1, "claude-code"), "cc-1", "各取各的");
eq(lanes.engineSessionFor(s1, "codex"), "cx-1", "各取各的（另一个）");
eq(lanes.engineSessionFor(s1, "builtin"), null, "内置循环没有续跑 id 这回事");
eq(lanes.engineSessionFor(s1, ""), null, "没说引擎就别给");
eq(lanes.engineSessionFor(null, "codex"), null, "会话是空的也别炸");
const s2 = { engine_session: "cc-9", engine: "claude-code" };
eq(lanes.engineSessionFor(s2, "claude-code"), "cc-9", "老会话（一对扁平字段）照样认");
eq(lanes.engineSessionFor(s2, "codex"), null, "反向对照：claude 的 id 绝不喂给 codex——喂过去只会当场报「找不到会话」，用户看到的是「换个标签就报错」");
const s3 = { engine_session: "old-1" }; // 更早以前升级上来的：那会儿机器上只可能有一个引擎在跑
eq(lanes.engineSessionFor(s3, "codex"), "old-1", "远古会话没记引擎名，认它（当时不存在第二个引擎）");
const s4 = { engine_sessions: "不是对象" };
eq(lanes.engineSessionFor(s4, "codex"), null, "反向对照：字段被写坏了也只是取不到，不许抛");
const s5 = {};
lanes.rememberEngineSession(s5, "codex", "cx-7");
eq(s5.engine_sessions.codex, "cx-7", "记下来了");
eq(s5.engine_session, "cx-7", "扁平字段继续写——命令行 wb 和桌面端的旧代码读的是它");
eq(s5.engine, "codex", "同上");
lanes.rememberEngineSession(s5, "claude-code", "cc-7");
eq(s5.engine_sessions.codex, "cx-7", "换个引擎跑完，上一个引擎的续跑 id 还在（切回去接着跑）");
eq(lanes.engineSessionFor(s5, "codex"), "cx-7", "切回去真取得到");
eq(lanes.engineSessionFor(s5, "claude-code"), "cc-7", "新的那个也在");
const s6 = {};
lanes.rememberEngineSession(s6, "builtin", "x");
eq(s6.engine_session, undefined, "反向对照：内置引擎不记续跑 id（它根本没有）");
lanes.rememberEngineSession(s6, "codex", "");
eq(s6.engine_session, undefined, "反向对照：空 id 不记");

// ── ⑦ 「命令行模式用哪个 CLI」是个人的，不是管理员的 ──────────────────────
// 起因是用户的原话：连桌面宠物都被判成「管理员设置」，界面上只回四个字「切换失败」。
// 挑哪个 CLI 跟谁掏 API 的钱、谁担安全风险半点关系都没有，必须落在个人那层。
console.log("\n⑦ cli_engine 落个人偏好");
ok(prefs.isPersonalPatch({ agent: { cli_engine: "codex" } }), "只改 cli_engine = 纯个人改动，平台闸门放行");
ok(prefs.isPersonalPatch({ agent: { engine: "builtin", cli_engine: "codex" } }), "跟底层引擎一起改也还是个人的");
ok(!prefs.isPersonalPatch({ agent: { cli_engine: "codex", max_steps: 99 } }), "反向对照：顺手夹带一个服务器级字段就整条不算个人改动");
ok(!prefs.isPersonalPatch({ agent: { engine_options: { codex: { bin: "/tmp/x" } } } }), "反向对照：bin 是「起哪个可执行文件」，多人服务器上等于任意命令执行，绝不下放");
const sp = prefs.split({ agent: { cli_engine: "codex", max_steps: 99 } });
eq(sp.personal.agent.cli_engine, "codex", "拆包：cli_engine 落到个人那一半");
eq(sp.rest.agent.max_steps, 99, "拆包：服务器级的那半留给 config");
eq(sp.personal.agent.max_steps, undefined, "反向对照：个人那半里没有服务器级字段");
eq(sp.rest.agent.cli_engine, undefined, "反向对照：服务器那半里没有个人字段");
const BASE = { agent: { engine: "builtin", max_steps: 25 } };
eq(prefs.agentCfg(BASE).cli_engine, undefined, "没套上个人偏好时取不到（这就是今天的行为）");
prefs.withPrefs({ agent: { cli_engine: "codex" } }, () => {
  eq(prefs.agentCfg(BASE).cli_engine, "codex", "套上之后执行层立刻看得见");
  eq(prefs.agentCfg(BASE).max_steps, 25, "服务器级字段照旧从 config 来");
  eq(lanes.engineIdFor("cli", prefs.agentCfg(BASE)), "codex", "接到一起：这个账号点命令行模式，跑的就是他自己挑的 Codex");
  eq(lanes.engineIdFor("office", prefs.agentCfg(BASE)), "builtin", "同一个账号点办公模式，还是内置循环");
});
eq(prefs.agentCfg(BASE).cli_engine, undefined, "出了这段又回落（定时任务 / IM / 命令行取不到账号，行为一字不差）");

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
if (fail) process.exitCode = 1;
