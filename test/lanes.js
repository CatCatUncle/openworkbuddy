"use strict";
/**
 * 两条工作线（lanes.js）的判据测试。
 *
 * 这个模块只回答一件事：「这次的活儿归哪一栏」——办公（做表写稿出图）还是工程
 * （写代码跑脚本，连着本机的 wb 命令行）。它**不**决定用哪个引擎：引擎是用户在设置里
 * 挑一次、两条线共用的另一件事。早先版本把两件事捆在一起，后果是切个标签能把别人配的
 * 模型换掉——服务器上两个人共用一份配置的时候，这是实打实的越权。
 *
 * 所以这份测试里有一整节专门证明「工作线碰不到引擎」，而且是反向证明：
 * 拿同一份 config，走办公和走工程，解析出来必须是同一个引擎、同一个模型。
 *
 * 每一节都配反向对照：既证明该成立的成立，也证明**换一个输入就不成立**。
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
eq(lanes.normalize(" CLI "), "cli", "两头空格 + 大写照样认");
eq(lanes.normalize("工程"), "", "中文显示名不是 id，不认——id 是 cli，改显示名不许影响存档");
eq(lanes.normalize("terminal"), "", "没在册的名字返回空串（不是抛错、不是瞎猜一个）");
eq(lanes.normalize(""), "", "空串就是「没说」");
eq(lanes.normalize(null), "", "null 就是「没说」");
eq(lanes.normalize(undefined), "", "undefined 就是「没说」");
eq(lanes.IDS.length, 2, "一共就两条线");
ok(lanes.IDS.includes("cli") && lanes.IDS.includes("office"), "两条线的 id 是 cli / office");
eq(lanes.get("cli").name, "工程", "工程线的显示名");
eq(lanes.get("office").name, "办公", "办公线的显示名");
eq(lanes.get("没这条"), null, "问不存在的线返回 null");
// 门面话术不许空：侧栏 tooltip、命令行 help、IM 提示读的是同一份
for (const l of lanes.LANES) {
  ok(!!(l.name && l.short && l.hint && l.detail), `「${l.name}」四个字段都有值`);
  ok(!/模式/.test(l.name), `「${l.name}」不带「模式」二字——标签上就两个字`);
}

// ── ② 老会话归哪条线 ───────────────────────────────────────────────────
console.log("\n② 没记过 lane 的老会话");
eq(lanes.DEFAULT_LANE, "office", "回落到办公线");
eq(lanes.laneOf({}), "office", "空会话 → 办公");
eq(lanes.laneOf(null), "office", "null → 办公（不抛）");
eq(lanes.laneOf({ lane: "cli" }), "cli", "记了 cli 就认 cli");
eq(lanes.laneOf({ lane: "office" }), "office", "记了 office 就认 office");
eq(lanes.laneOf({ lane: "乱写的" }), "office", "记了个不认识的值 → 回落，不是照抄");
// 反向对照：装了 CLI 引擎的老会话也不许被「猜」到工程线去。
// 引擎跟工作线无关，服务端只如实记，不替人填
eq(lanes.laneOf({ engine: "claude-code", engine_session: "cc-1" }), "office",
  "有 claude-code 续跑 id 的老会话仍归办公——不拿引擎倒推工作线");

// ── ③ 工作线碰不到引擎（这一节是那条越权 bug 的看门狗） ─────────────────
console.log("\n③ 工作线不许换引擎");
ok(typeof lanes.engineIdFor !== "function", "engineIdFor 已经不存在了（工作线不再决定引擎）");
ok(typeof lanes.viewFor !== "function", "viewFor 已经不存在了");
ok(!("CLI_FALLBACK" in lanes), "CLI_FALLBACK 已经不存在了");
const CFG = Object.freeze({ agent: { engine: "codex", thinking: "high", max_steps: 25 } });
/** backend 为 null 就是内置循环（没有外部命令要起） */
const backendId = (r) => (r && r.backend && r.backend.id) || "builtin";
// 同一份 config，两条线解析出来必须一模一样
const rA = engines.resolve(prefs.agentView(CFG));
const rB = engines.resolve(prefs.agentView(CFG));
eq(backendId(rA), "codex", "用户配了 codex 就跑 codex");
eq(backendId(rA), backendId(rB), "同一份 config 解析结果稳定");
// 引擎自己的那份选项（模型之类）也整份原样带过来——没有哪条工作线插得进手
const rM = engines.resolve(prefs.agentView({ agent: { engine: "codex", engine_options: { codex: { model: "o3" } } } }));
eq(rM.opts.model, "o3", "engine_options 原样带到引擎那层");
// 反向对照：真换 config 才换引擎
eq(backendId(engines.resolve(prefs.agentView({ agent: { engine: "builtin" } }))), "builtin",
  "改 config 才换引擎（证明上面那条不是恒真）");
// lanes 模块整个导出面上不许再出现引擎相关的名字
const EXPORTS = Object.keys(lanes).sort().join(",");
eq(EXPORTS, "DEFAULT_LANE,IDS,LANES,engineSessionFor,get,laneOf,normalize,rememberEngineSession",
  "导出面就这些——多一个引擎相关的都算回潮");

// ── ④ 续跑 id 按引擎分开记（这条跟工作线无关，是引擎自己的账） ───────────
console.log("\n④ 续跑 id 按引擎分开记");
const s1 = { engine_sessions: { "claude-code": "cc-1", codex: "cx-1" } };
eq(lanes.engineSessionFor(s1, "claude-code"), "cc-1", "claude-code 拿自己那条");
eq(lanes.engineSessionFor(s1, "codex"), "cx-1", "codex 拿自己那条");
eq(lanes.engineSessionFor(s1, "builtin"), null, "内置循环没有续跑 id");
eq(lanes.engineSessionFor(s1, "没跑过的引擎"), null, "没记过的引擎返回 null，不乱借一个");
const s2 = { engine_session: "cc-9", engine: "claude-code" };
eq(lanes.engineSessionFor(s2, "claude-code"), "cc-9", "老格式（扁平字段）认得");
eq(lanes.engineSessionFor(s2, "codex"), null, "老格式记的是 claude-code 的 id，不许喂给 codex");
const s3 = { engine_session: "old-1" }; // 更早以前升级上来的：那会儿机器上只可能有一个引擎在跑
eq(lanes.engineSessionFor(s3, "codex"), "old-1", "更老的记录没记引擎名，认它");
eq(lanes.engineSessionFor({ engine_sessions: "不是对象" }, "codex"), null, "字段类型坏了也不抛");
eq(lanes.engineSessionFor({}, "codex"), null, "空会话没有续跑 id");
eq(lanes.engineSessionFor(null, "codex"), null, "null 会话不抛");
eq(lanes.engineSessionFor(s1, ""), null, "没说引擎名就没有续跑 id");

console.log("\n⑤ 记下续跑 id");
const s6 = {};
lanes.rememberEngineSession(s6, "claude-code", "cc-new");
eq(s6.engine_sessions["claude-code"], "cc-new", "写进按引擎分的表里");
eq(s6.engine_session, "cc-new", "扁平字段同步写——桌面端和命令行的旧代码读的是它");
eq(s6.engine, "claude-code", "扁平字段的引擎名也写上");
lanes.rememberEngineSession(s6, "codex", "cx-new");
eq(s6.engine_sessions["claude-code"], "cc-new", "换引擎不覆盖上一个引擎的续跑 id");
eq(s6.engine_sessions.codex, "cx-new", "新引擎的 id 也记上了");
eq(lanes.engineSessionFor(s6, "claude-code"), "cc-new", "转一圈回来，claude-code 那条还在");
const s7 = {};
lanes.rememberEngineSession(s7, "builtin", "b-1");
eq(s7.engine_session, undefined, "内置循环不记续跑 id（它没有这个概念）");
lanes.rememberEngineSession(s7, "codex", "");
eq(s7.engine_session, undefined, "空 id 不记");
ok(lanes.rememberEngineSession(null, "codex", "x") === null, "null 会话不抛");

// ── ⑥ 个人偏好里不许再有 cli_engine ────────────────────────────────────
console.log("\n⑥ cli_engine 已经退役");
const sp = prefs.split({ agent: { cli_engine: "codex", max_steps: 99 } });
eq(sp.personal.agent && sp.personal.agent.cli_engine, undefined,
  "cli_engine 不再是个人偏好——它本来就不该存在");
const view = prefs.agentView({ agent: { engine: "builtin", cli_engine: "codex" } }, { prefs: { agent: { cli_engine: "codex" } } });
eq(backendId(engines.resolve(view)), "builtin", "config 里残留的 cli_engine 影响不到实际引擎");

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
