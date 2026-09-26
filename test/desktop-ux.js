"use strict";
/**
 * 桌面端（网页界面）那几处「跑着的时候人看到什么、跑完了人能点什么」。
 *
 *   【1】Plan 跑完那两颗按钮的字、开干时发出去的那句，跟终端 Plan 跑完那张单子是同一份
 *   【2】这一份经 /api/modes 发给前端，前端接住了、不自己再抄一份
 *   【3】计划卡：编号步骤 + 两颗真按钮，不再是勾了也没用的勾选框
 *   【4】结论在折叠区外面流：挪出去 / 收回来的接线点对不对
 *   【5】英文界面：服务端发来的按钮字和计划卡标题都有译文
 *   【6】注意力的纯核：一行亮哪颗点、喊不喊、「跳到下一条」跳去哪、标题上的数
 *   【7】审批带着截止时刻和会话号出来：倒计时和侧栏那颗点都靠这两样
 *   【8】注意力的接线：事件流/轮询/收尾/点开各处都进了同一份账，标题前缀只有一个写的地方
 *   【9】英文界面：倒计时、侧栏点的提示、系统通知的字都有译文
 *   【10】注意力的账只记点得开的会话：IM 的审批不挂到 IM 会话键上；删掉了的会话收尾不再回来
 *   【11】这轮新加的间距（审批倒计时、配方卡说明、计划卡）落在 4 的倍数上
 *
 * 行为（真 DOM 里点按钮、看正文挪没挪、直播和回放是不是同一个样子）在 test/frontend.js 的回合那一段；
 * 这里钉的是那边钉不到的：跨文件同一份文案有没有漂、接线有没有断、该在的调用点在不在。
 * 往后加新的一节，照【n】的编号接着往下排，用 section() 包起来——一节炸了不拖累后面的节。
 *
 * 不起服务、不花钱、不出网，只读源码和 require 纯模块。
 *   node test/desktop-ux.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const vm = require("vm");

// repl-commands → security 会去读数据目录，require 之前先把家搬到临时目录，别碰真的那份
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-desktopux-home-"));
process.env.OPENWORKBUDDY_HOME = HOME;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");

const ROOT = path.join(__dirname, "..");
const { src, stripJsComments } = require("./lib/src");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 400) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
/** 一段炸了记一条失败接着往下跑，要的是完整的红灯清单 */
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 3).join(" | ")}`); }
}
/** 从 from 切到 to；切不出来直接抛——锚点改名了就该红，不能切到空串悄悄变绿 */
function slice(text, from, to, what) {
  const a = text.indexOf(from);
  const b = a < 0 ? -1 : text.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`切不出「${what}」那一段（${a < 0 ? from : to} 找不到，改名了？）`);
  return text.slice(a, b);
}
const CJK = /[㐀-鿿＀-￯　-〿]/;

(async () => {
  const modes = require(path.join(ROOT, "modes"));
  const repl = require(path.join(ROOT, "repl-commands"));
  const H = modes.PLAN_HANDOFF;
  const APP01 = read("public", "js", "app-01.js");
  const APP02 = read("public", "js", "app-02.js");
  const HTML = read("public", "index.html");
  const I18N = read("public", "js", "i18n.js");

  await section("【1】Plan 收尾：桌面两颗按钮和终端那张单子是同一份话", () => {
    ok(H && typeof H === "object" && Object.isFrozen(H), "modes.js 导出 PLAN_HANDOFF，而且冻住了（谁顺手改一个字，两边就对不上）");
    for (const k of ["go", "goLabel", "moreLabel", "morePlaceholder", "doneLabel"]) {
      ok(typeof H[k] === "string" && H[k].trim().length > 0, `PLAN_HANDOFF.${k} 有字`, H[k]);
    }
    // 同一份计划在终端开干和在界面上开干，模型收到的得是同一句要求，收尾汇报的口径才对得上
    eq(H.go, repl.PLAN_GO_TEXT, "「开干」发出去的那句跟终端 PLAN_GO_TEXT 一字不差");
    const rows = repl.planNextRows();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    eq(H.goLabel, byId.go && byId.go.label, "「开干」按钮的字跟终端单子第一行一样");
    eq(H.moreLabel, byId.more && byId.more.label, "「接着改」按钮的字跟终端单子第二行一样");
    // 按钮上一行放得下、读得完：长了在窄窗口里会折成两行，跟旁边那颗高低不齐
    for (const k of ["goLabel", "moreLabel", "doneLabel"]) ok(H[k].length <= 12, `${k} 不超过 12 个字`, H[k]);
    for (const k of ["go", "morePlaceholder"]) ok(H[k].length <= 70, `${k} 不超过 70 个字`, H[k].length);
  });

  await section("【2】/api/modes 把这一份发给前端，前端接住了", () => {
    const SERVER = src("server");
    ok(/app\.get\("\/api\/modes"[^\n]*plan: modes\.PLAN_HANDOFF/.test(SERVER), "/api/modes 的回包里带 plan: modes.PLAN_HANDOFF");
    const load = slice(APP02, "async function loadExecModes(", "\n}\n", "loadExecModes");
    ok(/planHandoff = d\.plan/.test(load), "loadExecModes 把 d.plan 存进 planHandoff");
    ok(/^let planHandoff = null;$/m.test(APP02), "planHandoff 起始是 null：没取到就不画按钮，不留一份兜底文案");
    // 前端代码里一个字都不许抄：抄了就是第二份真源，改 modes.js 界面不跟着变（注释里提一句不算）
    for (const f of fs.readdirSync(path.join(ROOT, "public", "js")).filter((n) => /^app-.*\.js$/.test(n))) {
      const code = stripJsComments(read("public", "js", f));
      const hit = [H.go, H.goLabel, H.moreLabel, H.morePlaceholder, H.doneLabel].filter((s) => code.includes(s));
      ok(!hit.length, `${f} 里没有手抄 PLAN_HANDOFF 的字`, hit);
    }
    // 「接着改计划」的提示语：updateSendUI / setMode 每次都会重算 placeholder，所以得住在 syncPlaceholder 里
    const sp = slice(APP02, "function syncPlaceholder() {", "\n}\n", "syncPlaceholder");
    ok(/planPlaceholder && currentMode === "plan"/.test(sp), "syncPlaceholder 认 planPlaceholder（只在还停在 Plan 时）");
    const send = slice(APP02, "async function doSend(", "\n}\n", "doSend");
    ok(/planPlaceholder = ""/.test(send), "发出去就把「哪一步要改？」收回");
    ok(/planPlaceholder = ""/.test(slice(APP02, "async function openSession(", "\n}\n", "openSession")), "换会话也收回");
    ok(/planPlaceholder = ""/.test(slice(APP02, 'document.getElementById("new-task").onclick', "\n};\n", "新建任务")), "新建任务也收回");
  });

  await section("【3】计划卡：编号步骤 + 两颗真按钮", () => {
    const pl = slice(APP01, "function renderPlanChecklist() {", "\n  }\n", "renderPlanChecklist");
    ok(!/type="checkbox"/.test(pl) && !/pl-item/.test(pl), "不再画勾选框（勾了模型也收不到）");
    ok(/<ol class="pl-steps">/.test(pl), "步骤是编号列表");
    ok(/计划 \$\{steps\.length\} 步/.test(pl), "卡头写「计划 N 步」（英文由 i18n 的 PATTERNS 接）");
    ok(/doSend\(hand\.go, "craft"[,)]/.test(pl) && /setMode\("craft"\)/.test(pl), "「开干」切 Craft 并当场发出 PLAN_HANDOFF.go");
    // 英文界面下气泡里放译文（第 4 个参数 shown），模型收到的照旧是原话。真点一下的验证在 frontend.js 计划卡那段
    ok(/doSend\(hand\.go, "craft", [^,]+, [^)]*I18N\.lookup\(hand\.go, lang\)/.test(pl), "「开干」在英文界面把译文当 shown 带上，不让中文原话进他的气泡");
    ok(/disabled = true/.test(pl), "点过「开干」两颗都置灰，再点就是同一份计划跑两遍");
    ok(/curBusy\(\)/.test(pl) && /:scope > \.turn/.test(pl), "开干前查两件事：没在跑、这是最后一轮");
    ok(/setMode\("plan"\)/.test(pl) && /planAskEdit\(hand\.morePlaceholder\)/.test(pl), "「接着改」留在 Plan，输入框问改哪一步");
    ok(/typeof planHandoff !== "undefined"/.test(pl), "别的页面没这个全局也不炸");
    ok(/textContent = hand\.goLabel/.test(pl) && /textContent = hand\.moreLabel/.test(pl), "按钮字走 textContent（服务端来的字不当 HTML 拼）");
    ok(/\.plan-list \.pl-steps \{/.test(HTML) && /\.plan-list \.pl-more \{/.test(HTML) && /\.plan-list \.pl-acts button:disabled \{/.test(HTML), "index.html 有步骤列表、次按钮、置灰三条样式");
    ok(!/\.pl-item/.test(HTML), "勾选框那几条旧样式撤了");
    for (const id of ["list-ordered", "play", "pencil"]) ok(new RegExp(`<symbol id="i-${id}"`).test(HTML), `图标 ${id} 在 sprite 里`);
  });

  await section("【4】结论在折叠区外面流：挪出去、收回来的接线点", () => {
    const turn = slice(APP01, "function createTurnUI(", "// ================= 空状态", "createTurnUI");
    ok(/const TAIL_MIN_CHARS = \d+, TAIL_MIN_MS = \d+;/.test(turn), "挪出去有字数和时长两道门槛");
    const ens = slice(turn, "const ensureProc = () => {", "\n  };\n", "ensureProc");
    // 撞上限、睡醒、换渠道、截短、压完、进度单这些只是记一笔，后面不一定还有活，不能把已经在流的结论收回去
    ok(!/foldTail\(/.test(ens), "ensureProc 里不收（它被一堆「只记一笔」的事件共用）");
    const branch = (a, b) => slice(turn, `} else if (ev.type === "${a}") {`, `} else if (ev.type === "${b}") {`, a);
    for (const [a, b] of [["expert_start", "parallel"], ["parallel", "tool_use"], ["tool_use", "tool_result"], ["auto_continue", "sleep"], ["compact_start", "compact"]]) {
      ok(/foldTail\(\);/.test(branch(a, b)), `${a}：后面有真活要干，把挪出去的那段收回`);
    }
    for (const [a, b] of [["limit", "auto_continue"], ["sleep", "failover"], ["failover", "trim"], ["trim", "compact_start"]]) {
      ok(!/foldTail\(/.test(branch(a, b)), `${a}：只记一笔，不收`);
    }
    const step = slice(turn, 'if (ev.type === "step_start") {', '} else if (ev.type === "status") {', "step_start");
    ok(step.indexOf("if (ev.depth > 0) return;") < step.indexOf("foldTail();"), "step_start 只有主线那一步才收（专家内层的步不算）");
    const fold = slice(turn, "const foldTail = () => {", "\n  };\n", "foldTail");
    ok(/className = "a-text-ghost"/.test(fold) && !/className = "a-text"/.test(fold), "收回去时留的空壳不带 .a-text（复制/导出按 .a-text 找正文）");
    ok(/reducedMotion\(\)/.test(fold), "系统设了减少动态效果就不播缩回动画");
    const promote = slice(turn, "const promoteTail = (el) => {", "\n  };\n", "promoteTail");
    ok(/isReplaying/.test(promote) && /el\._folded/.test(promote), "回放不挪；收回过的不再挪（免得来回跳）");
    const append = slice(turn, "const appendText = (delta) => {", "\n  };\n", "appendText");
    ok(append.indexOf("promoteTail(el)") > 0 && append.indexOf("promoteTail(el)") < append.indexOf("paintStream(el)"), "挪位置跟着 100ms 那一帧走，在 paintStream 之前");
    const fin = slice(turn, "function finish(opts) {", "\n  }\n", "finish");
    ok(/tailText && tailText\.parentNode === body \? tailText :/.test(fin), "收尾认已经挪出去的那段，不另挑一段");
    ok((turn.match(/currentText = null/g) || []).length === 2, "没多出绕过 endText 的置空（e2e testStreamRender 同一条）");
    ok(/\.a-text-ghost \{[^}]*transition: height/.test(HTML), "index.html 给空壳配了高度过渡");
  });

  await section("【5】英文界面：服务端发来的字也有译文", () => {
    // 这几个字不在 app-0*.js 的模板里（是 /api/modes 带回来的），e2e testI18n 的覆盖率扫不到，只能在这儿钉
    const toasts = ["这条还在跑，等它停了再开干", "这份计划后面已经有新的对话了，按最新的来"];
    // H.go 也要有：英文界面点「开干」，气泡里显示的是它的译文（查不到才退成按钮上那几个字）
    for (const zh of [H.go, H.goLabel, H.moreLabel, H.morePlaceholder, H.doneLabel, ...toasts]) {
      const m = new RegExp(`"${zh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}": "([^"]*)"`).exec(I18N);
      ok(m && m[1] && !CJK.test(m[1]), `「${zh}」有英文，而且译文里没有中文`, m && m[1]);
    }
    for (const t of toasts) ok(APP01.includes(`toast("${t}")`), `app-01.js 的提示语「${t.slice(0, 8)}…」跟词典的键一致`);
    const pat = /\[\/\^计划 \(\\d\+\) 步\$\/, "([^"]+)"\]/.exec(I18N);
    ok(pat && !CJK.test(pat[1]) && /\$1/.test(pat[1]), "「计划 N 步」有英文句式，数字带过去", pat && pat[1]);
  });

  const ATTN = read("public", "js", "app-01-attention.js");

  await section("【6】注意力的纯核：亮哪颗点、喊不喊、跳去哪、标题上几", () => {
    // 丢进一个什么都没有的 vm 里跑得通 = 顶层没碰 document/window/别的文件的全局
    // （这个文件夹在 app-01 和 app-02 之间加载，顶层去碰就是碰到半截状态）
    const A = vm.runInNewContext(ATTN + "\n;({ ATTN_DEDUPE_MS, attnPick, attnShouldCall, attnNextSid, attnCount })", {});
    const st = (o) => ({ asks: new Map((o.asks || []).map((k) => [k, {}])), error: !!o.error, unseen: !!o.unseen });
    eq(A.attnPick(st({ asks: ["q"], error: true, unseen: true }), true), "ask", "等你回答压过一切（出错、在跑、跑完）");
    eq(A.attnPick(st({ error: true, unseen: true }), true), "error", "出错压过在跑");
    eq(A.attnPick(st({ unseen: true }), true), "running", "在跑压过「跑完了没看」（排队的下一条马上开跑，不许说一件已经不成立的事）");
    eq(A.attnPick(st({ unseen: true }), false), "unseen", "不在跑了才亮「跑完了没看」");
    eq(A.attnPick(null, true), "running", "账上没这条、在跑：跟原来一样亮在跑");
    eq(A.attnPick(undefined, false), "", "什么都没有：不亮");

    const last = new Map();
    eq(A.attnShouldCall(last, "s1", 1000), true, "第一声喊");
    eq(A.attnShouldCall(last, "s1", 1000 + A.ATTN_DEDUPE_MS - 1), false, "一分钟内同一条不再喊");
    eq(A.attnShouldCall(last, "s2", 1500), true, "别的会话不受影响");
    eq(A.attnShouldCall(last, "s1", 1000 + A.ATTN_DEDUPE_MS), true, "过了一分钟再来题，再喊");
    eq(A.attnShouldCall(last, "s1", 1000 + A.ATTN_DEDUPE_MS + 10), false, "喊过就记上时间（调用方不用自己记）");
    eq(A.attnShouldCall(new Map([["k", 0]]), "k", 5, 3), true, "窗口可以传进来（测试和别处能用短的）");

    const order = ["a", "b", "c", "d"];
    const pickOf = (m) => (id) => m[id] || "";
    eq(A.attnNextSid(order, "b", pickOf({ a: "ask", c: "ask" })), "c", "从当前这条的下一条往后找");
    eq(A.attnNextSid(order, "c", pickOf({ a: "ask", c: "ask" })), "a", "到底了绕回头（连按能挨个过一遍，不是永远跳回第一条）");
    eq(A.attnNextSid(order, "c", pickOf({ c: "ask" })), "c", "只有眼前这条在等：还是它（排最后，不是找不到）");
    eq(A.attnNextSid(order, "a", pickOf({ b: "error", d: "ask" })), "d", "等你回答的先于出错的，哪怕出错那条更近");
    eq(A.attnNextSid(order, "a", pickOf({ b: "unseen", c: "error" })), "c", "出错的先于跑完没看的");
    eq(A.attnNextSid(order, "a", pickOf({ b: "running" })), null, "只是在跑的不算等你：返回 null");
    eq(A.attnNextSid(order, "zz", pickOf({ a: "unseen", d: "unseen" })), "a", "当前这条不在侧栏里：从头找");
    eq(A.attnNextSid(["", "a"], "x", pickOf({ "": "ask", a: "ask" })), "a", "不属于会话的那格（空 id）不当跳转目标");

    const m = new Map([["s1", st({ asks: ["x", "y"] })], ["s2", st({ error: true, unseen: true })], ["", st({ asks: ["ap"] })]]);
    eq(A.attnCount(m), 3, "标题上的数 = 题数（一条会话卡两道就是 2），不属于会话的审批也算");
    eq(A.attnCount(new Map()), 0, "没有等你的：0（标题不带前缀）");
  });

  await section("【7】审批带着截止时刻和会话号出来", async () => {
    const security = require(path.join(ROOT, "security"));
    const seen = [];
    const off = security.watchApprovals((ev) => seen.push(ev));
    try {
      const t0 = Date.now();
      const p = security.requestApproval("命令执行", "rm -rf /tmp/owb-desktopux-a", { timeoutMs: 60000, sessionId: "s_attn" });
      const row = security.listApprovals().find((a) => a.text === "rm -rf /tmp/owb-desktopux-a");
      ok(row, "列表里有这一条");
      eq(row && row.sessionId, "s_attn", "列表带着是哪条会话在等（侧栏才知道点亮哪一行）");
      ok(row && row.deadline >= t0 + 60000 && row.deadline <= Date.now() + 60000, "列表带着截止时刻，就是发起时刻 + 超时", row && row.deadline - t0);
      const open = seen.find((ev) => ev.type === "open" && ev.entry && ev.entry.id === (row && row.id));
      ok(open, "订阅方收到 open");
      eq(open && open.entry.deadline, row && row.deadline, "通知里的截止时刻跟列表是同一个数（只算一次，倒计时和真超时对得上）");
      eq(open && open.entry.sessionId, "s_attn", "通知里也带会话号");
      ok(open && typeof open.entry.resolve !== "function", "通知出去的那份不带 resolve：订阅方（桌面主进程、命令行）不能顺手替人点了");
      security.resolveApproval(row.id, false);
      eq(await p, false, "拒了就是拒了");
      ok(seen.some((ev) => ev.type === "close" && ev.id === row.id), "收尾有 close");

      const p2 = security.requestApproval("命令执行", "echo owb-desktopux-b", { timeoutMs: 10 });
      const r2 = security.listApprovals().find((a) => a.text === "echo owb-desktopux-b");
      eq(r2 && r2.sessionId, "", "不属于会话的（IM、定时任务）：会话号是空串，不是 undefined");
      ok(r2 && r2.deadline - Date.now() > 4000, "超时给得再短也有 5 秒下限，截止时刻按下限算（不许界面显示 0:00 而真的还能点）", r2 && r2.deadline - Date.now());
      security.resolveApproval(r2.id, false);
      await p2;
    } finally { off(); }

    const TOOLS = src("tools");
    const gate = slice(TOOLS, "const passGate = async", 'security.audit(label + "审批", text, ok', "passGate");
    ok(/requestApproval\([\s\S]*sessionId: opts\.sessionId/.test(gate), "工具闸门求批准时把会话号递进去（agent execOpts 本来就带着 sessionId）");
    const SERVER = src("server");
    ok(/now: Date\.now\(\)/.test(slice(SERVER, 'app.get("/api/security/approvals"', "\n});", "审批列表接口")), "审批列表带服务器此刻的钟（两边钟差多少倒计时都准）");
    ok(/now: Date\.now\(\)/.test(slice(SERVER, 'app.get("/api/cli/pending"', "\n});", "终端待答接口")), "终端待答接口也带服务器的钟");
  });

  await section("【8】注意力的接线：各处进同一份账，标题前缀只有一个写的地方", () => {
    const code01 = stripJsComments(APP01);
    const code02 = stripJsComments(APP02);
    const iA = HTML.indexOf('<script src="js/app-01.js"></script>');
    const iB = HTML.indexOf('<script src="js/app-01-attention.js"></script>');
    const iC = HTML.indexOf('<script src="js/app-02.js"></script>');
    ok(iA > 0 && iA < iB && iB < iC, "index.html：app-01 → app-01-attention → app-02（app-02 顶层就要用 sessionAttn）", [iA, iB, iC]);

    // 事件流：直播记，回放不记（回放出来的旧题不是现在在等你）
    ok(/if \(!isReplaying\) attnAsk\(turnSid, ev\.ask_id/.test(code01), "ask_user：直播时记一道题，回放不记");
    ok(/ev\.type === "ask_answer"[\s\S]{0,200}attnAnswered\(turnSid, ev\.ask_id\)/.test(code01), "ask_answer：划掉那道题");
    ok(/if \(!isReplaying\) attnFlag\(turnSid, "error"\)/.test(code01), "error：直播时记一笔出错");
    ok(!/"shield-alert"/.test(code01) && !/"shield-alert"/.test(ATTN), "不用图标库里没有的 shield-alert（画出来是一块空白）");
    const card = slice(code01, "function makeAskCard", "\n}\n", "makeAskCard");
    ok(/ev\.deadline > 0/.test(card) && /Number\(ev\.now\)/.test(card), "问答卡倒计时认服务端给的截止时刻，按服务器的钟校正");
    ok(/后自动拒绝/.test(card) && /已自动拒绝/.test(card), "审批卡倒数到头说「已自动拒绝」，不说「按默认继续」（审批没有默认，超时就是拒）");

    const endRun = slice(code02, "function endRun(sid, ui, opts) {", "\n}\n", "endRun");
    ok(/attnRunEnded\(sid\)/.test(endRun), "一轮收尾：流里没等到回答的题作废");
    ok(/attnFlag\(sid, "unseen"\)/.test(endRun) && /sessionQueues\.get\(sid\)/.test(endRun), "一轮收尾：队列里没下一条了才记「跑完没看」");
    ok(/attnSeen\(id\)/.test(slice(code02, "async function openSession(id, opts) {", "\n}\n", "openSession")), "点开会话 = 看过了");
    ok(/attnForget\(id\)/.test(code02), "删会话把它名下的账一起清");
    const live = slice(code02, "async function pollCliLive() {", "\n}\n", "pollCliLive");
    ok(/attnSyncAsks\("cli", p\.rows\)/.test(live) && /cliLiveRows\.some\(\(r\) => r\.live\)/.test(live), "终端那几趟：有在跑的才去问 /api/cli/pending，没有就按空账对（点熄掉）");
    const ask = slice(code02, "async function pollCliAsk() {", "\n}\n", "pollCliAsk");
    ok(/if \(d\) attnSyncAsks\("cli", rows, w\.id\)/.test(ask), "正在跟的那趟：只对它自己的账，请求失败不当成「都答完了」");
    ok((ask.match(/deadline: a\.deadline/g) || []).length >= 2, "终端那趟的问答卡和审批卡都带上截止时刻");
    ok(/attnRunEnded\(w\.id\)/.test(slice(code02, "function finishCliWatch", "\n}\n", "finishCliWatch")), "终端那趟收尾同样作废没答的题");

    const hist = slice(code02, "function renderHistory() {", "\n}\n", "renderHistory");
    ok((hist.match(/attnDotHtml\(/g) || []).length === 2, "侧栏两条线（本机、终端）的点都从 attnDotHtml 出");
    ok(!/class="hrun"/.test(code02), "app-02 不再自己拼「在跑」那颗点：只剩一个地方决定亮哪颗");
    ok(ATTN.includes(`'<span class="hrun" title="正在跑"></span>'`) && ATTN.includes(`'<span class="hrun" title="任务运行中"></span>'`), "「在跑」那颗跟改之前一字不差（样式、测试、别处的选择器都认它）");
    ok(/askFirst\(a\.id\) - askFirst\(b\.id\)/.test(hist), "在等你回答的排在侧栏最上面");

    // 终点那行是注释，得在剥注释之前切（跟 perm-gate 切的是同一段）
    const ap = stripJsComments(slice(APP02, "async function pollApprovals", "// ================= 权限档位", "pollApprovals"));
    ok(/if \(d\) attnSyncAsks\("approval", list\)/.test(ap), "审批轮询进同一份账；请求失败不清账");
    ok(/class="ap-left" data-dl=/.test(ap) && /Number\(d\.now\)/.test(ap), "审批条每条带倒计时，截止时刻按服务器的钟校正");
    ok(!/a\.text\.slice\(/.test(ap), "没把审批原文截半（perm-gate 同一条）");
    ok(/clearInterval\(apTimer\)/.test(slice(code02, "function apTick() {", "\n}\n", "apTick")), "审批条空了，倒计时定时器自己停");

    // 标题前缀：只有 syncTitleCount 写；别处改标题只改底下那截，改完叫它补前缀
    const titleWrites = [];
    for (const f of fs.readdirSync(path.join(ROOT, "public", "js")).filter((n) => /^app-0.*\.js$/.test(n))) {
      for (const l of stripJsComments(read("public", "js", f)).split("\n")) if (/document\.title\s*=[^=]/.test(l)) titleWrites.push(f + ": " + l.trim());
    }
    ok(titleWrites.length === 2 && titleWrites.some((l) => /app-02\.js: if \(document\.title !== want\) document\.title = want;/.test(l)), "document.title 只有两处写：syncTitleCount 和助理改名", titleWrites);
    const ident = slice(code01, "function applyAssistantIdentity() {", "\n}\n", "applyAssistantIdentity");
    ok(ident.indexOf("document.title = assistant.name;") >= 0 && ident.indexOf("syncTitleCount();") > ident.indexOf("document.title = assistant.name;"), "助理改名后立刻补回前缀（不然 Dock 角标跟着清零）");
    const sync = slice(code02, "function syncTitleCount() {", "\n}\n", "syncTitleCount");
    ok(/attnCount\(sessionAttn\) \+ doneWhileAway/.test(sync) && /replace\(\/\^\\\(\\d\+\\\) \//.test(sync), "前缀 = 在等你的题数 + 不在时跑完的；先剥旧前缀再算");
    ok(/if \(!document\.hidden\) return;/.test(slice(code02, "function bumpDoneWhileAway", "\n}\n", "bumpDoneWhileAway")), "人正看着页面时跑完不记数（不然标题挂个 (1) 没人来清）");

    const EM = read("electron-main.js");
    const title = slice(EM, 'win.on("page-title-updated"', "\n  });", "page-title-updated");
    ok(/setBadgeCount/.test(title) && /\/\^\\\(\(\\d\+\)\\\) \//.test(title), "桌面版：标题前缀 (n) → Dock 角标，跟标题是同一个数");
    ok(!/preventDefault/.test(title), "不拦标题更新（拦了窗口标题就不变了）");
    ok(/watchApprovals\([\s\S]{0,200}isFocused\(\)/.test(EM), "来审批时窗口不在前台：弹一下 Dock / 闪任务栏");

    const defs = slice(code02, "SHORTCUT_DEFS", "];", "SHORTCUT_DEFS");
    ok(/\["next-attn", "跳到下一条等你的", "Alt\+Mod\+U"\]/.test(defs), "快捷键表里有「跳到下一条等你的」");
    ok(/"next-attn": \(\) => nextAttn\(\)/.test(code02), "快捷键接到 nextAttn");
  });

  await section("【9】英文界面：倒计时、侧栏点的提示、通知的字", () => {
    for (const zh of ["跳到下一条等你的", "跑完了，还没看", "出错了，点开看看", "已自动拒绝", "已超时", "没有等你的会话", "有一步要你批准", "有个问题要问你"]) {
      const m = new RegExp(`"${zh}": "([^"]*)"`).exec(I18N);
      ok(m && m[1] && !CJK.test(m[1]), `「${zh}」有英文，译文里没有中文`, m && m[1]);
    }
    // 句式真拿来套一遍：只查「有这一行」查不出正则写错了套不上
    const pats = [];
    for (const l of I18N.split("\n")) {
      const mm = /^\s*\[\/(.+)\/, "(.*)"\],?\s*$/.exec(l);
      if (mm) { try { pats.push([new RegExp(mm[1]), mm[2]]); } catch {} }
    }
    const tr = (s) => { for (const [re, to] of pats) if (re.test(s)) return s.replace(re, to); return null; };
    for (const [zh, want] of [
      ["1:05 后自动拒绝", /1:05/],
      ["0:09 后按默认继续", /0:09/],
      ["在等你回答：要用哪个模板", /要用哪个模板/],
      ["在等你批准：命令执行", /命令执行/],
      ["「周报」在等你回答，点这里过去", /周报/],
      ["「周报」在等你批准，点这里过去", /周报/],
    ]) {
      const en = tr(zh);
      ok(en && want.test(en) && !CJK.test(en.replace(want, "")), `「${zh}」套得上英文句式，变的那截带过去`, en);
    }
    // 这两句只在 notifyAttention 里拼给系统通知，不经过 DOM 自动翻译，必须走 attnT
    ok(/attnT\(e\.approval \? "有一步要你批准" : "有个问题要问你"\)/.test(ATTN), "系统通知的标题自己翻（通知不在页面 DOM 里）");
  });

  await section("【10】注意力的账只记点得开的会话", async () => {
    // 真的注意力那页 + 真的 endRun / notifyRunDone，别的全是桩：快捷键跳去哪、弹了什么提示，看得见
    const APP02_SRC = read("public", "js", "app-02.js");
    const endRunSrc = slice(APP02_SRC, "function endRun(sid, ui, opts) {", "\n}\n", "endRun") + "\n}\n";
    const doneSrc = slice(APP02_SRC, "function notifyRunDone(sid, ui, opts) {", "\n}\n", "notifyRunDone") + "\n}\n";
    const make = () => {
      const T = { toasts: [], opened: [], away: 0 };
      const ctx = {
        sessions: [{ id: "web1", title: "周报" }, { id: "web2", title: "要删的那条" }],
        runningSessions: new Map(), cliLiveRows: [{ id: "cli1", title: "终端那趟" }], cliWatch: null,
        sessionId: "", activeLane: "office", settingsCache: null, sessionQueues: new Map(),
        document: { hidden: false, hasFocus: () => true, querySelectorAll: () => [], querySelector: () => null },
        window: {}, chatCol: { querySelectorAll: () => [] }, inputEl: { focus() {} },
        renderHistory() {}, syncTitleCount() {}, updateSendUI() {}, drainQueue() {}, renderLaneTabs() {},
        stripSceneTag: (x) => x || "", esc: (x) => x,
        toast: (m) => T.toasts.push(m),
        openSession: async (id) => { T.opened.push(id); },
        openCliLive: async (row) => { T.opened.push("cli:" + row.id); },
        bumpDoneWhileAway: () => { T.away++; },
      };
      const A = vm.runInNewContext(ATTN + "\n" + endRunSrc + doneSrc + "\n;({ sessionAttn, attnSyncAsks, attnForget, attnFlag, attnAsk, attnCount, nextAttn, endRun })", ctx);
      return { A, T, ctx };
    };
    const settle = async () => { for (let i = 0; i < 6; i++) await null; };
    const ui = { finish() {}, stats: () => null };

    {
      const { A, T } = make();
      A.attnSyncAsks("approval", [{ id: "ap1", kind: "删文件", sessionId: "feishu_oc_abc" }]);
      ok(!A.sessionAttn.has("feishu_oc_abc"), "IM 起的审批（带 IM 会话键）不挂在那个键上", [...A.sessionAttn.keys()]);
      ok(A.sessionAttn.get("") && A.sessionAttn.get("").asks.has("ap1") && A.attnCount(A.sessionAttn) === 1, "记在「不属于会话」那格：照样算进标题的数");
      A.nextAttn(); await settle();
      ok(!T.opened.length && T.toasts.includes("没有等你的会话"), "快捷键不跳进一条空会话", T);
      A.attnSyncAsks("approval", [{ id: "ap1", kind: "删文件", sessionId: "feishu_oc_abc" }, { id: "ap2", kind: "发消息", sessionId: "web1" }, { id: "ap3", kind: "跑命令", sessionId: "cli1" }]);
      ok(A.sessionAttn.get("web1") && A.sessionAttn.get("web1").asks.has("ap2"), "反向对照：网页会话自己的审批照旧挂在那条上");
      ok(A.sessionAttn.get("cli1") && A.sessionAttn.get("cli1").asks.has("ap3"), "反向对照：终端那趟的审批照旧挂在那一趟上");
      eq(A.attnCount(A.sessionAttn), 3, "三道都算数，同一道不重复记");
      A.nextAttn(); await settle();
      eq(T.opened[0], "web1", "快捷键跳去网页会话那条");
    }
    {
      const { A, T, ctx } = make();
      ctx.runningSessions.set("web2", {});
      // 删会话那几步（app-02 删除按钮）：列表里去掉、清账；停止请求不等，流稍后才收尾
      ctx.sessions = ctx.sessions.filter((x) => x.id !== "web2");
      A.attnForget("web2");
      A.attnSyncAsks("approval", [{ id: "ap9", kind: "删文件", sessionId: "web2" }]);
      ok(!A.sessionAttn.has("web2"), "删了还在跑的那条：它那一轮的审批不再挂回它名下");
      A.attnSyncAsks("approval", []);
      A.attnAsk("web2", "k1", { text: "还要继续吗" });
      ok(!A.sessionAttn.has("web2") && !T.toasts.length, "删了还在跑的那条：流里再来题也不记账、不喊人", T.toasts);
      A.endRun("web2", ui, {});
      ok(!A.sessionAttn.has("web2"), "删了还在跑的那条：收尾不再记一笔「跑完没看」", [...A.sessionAttn.keys()]);
      ok(!T.toasts.some((m) => /已完成/.test(m)), "删了的那条收尾不弹「已完成」", T.toasts);
      A.nextAttn(); await settle();
      ok(!T.opened.length && T.toasts.includes("没有等你的会话"), "快捷键不跳进删了的会话", T);
      // 反向对照：没删的后台那条收尾，照旧记「跑完没看」、弹「已完成」——桩没把整条路堵死
      ctx.runningSessions.set("web1", {});
      A.endRun("web1", ui, {});
      ok(A.sessionAttn.get("web1") && A.sessionAttn.get("web1").unseen, "反向对照：没删的那条收尾照旧记「跑完没看」");
      ok(T.toasts.some((m) => /「周报」已完成/.test(m)), "反向对照：没删的那条照旧弹「已完成」", T.toasts);
    }
  });

  await section("【11】这轮新加的间距落在 4 的倍数上", () => {
    // 只管这轮加进来的几条规则（整份样式表里老的 6px 还有一大堆，不在这一节的账上）
    const rule = (sel) => {
      const m = new RegExp("\\n\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}").exec(HTML);
      if (!m) throw new Error(`index.html 里找不到「${sel}」这条样式（改名了？）`);
      return m[1];
    };
    const px = (body, prop) => {
      const m = new RegExp("(?:^|;)\\s*" + prop + "\\s*:\\s*([^;]+)").exec(body);
      return m ? m[1].trim().split(/\s+/).map((v) => (/^-?\d+(\.\d+)?px$/.test(v) ? parseFloat(v) : v === "0" ? 0 : NaN)) : [];
    };
    for (const sel of [".ap-row .ap-left", ".ask-form .rf-notes li", ".plan-list .pl-acts"]) {
      const body = rule(sel);
      for (const prop of ["margin", "margin-left", "margin-right", "margin-top", "margin-bottom", "padding", "gap"]) {
        for (const v of px(body, prop)) ok(v % 4 === 0, `「${sel}」的 ${prop} 是 4 的倍数`, { got: v, body: body.trim() });
      }
    }
    // 计划卡的步骤行故意是 2px：上下 padding 不叠，行与行之间 2+2=4，标题到第一步 6+2=8——人看到的两段距离都在格子上。
    // 改成 4px 反而离格（标题下 10、行距 8），所以这里量的是「看到的距离」，不是单个值
    const head = px(rule(".plan-list .pl-head"), "margin-bottom")[0];
    const li = px(rule(".plan-list .pl-steps li"), "padding")[0];
    ok(Number.isFinite(head) && Number.isFinite(li), "计划卡标题和步骤行的间距量得出来", { head, li });
    ok((li * 2) % 4 === 0, "计划卡：步骤和步骤之间落在 4 的倍数上", { li, gap: li * 2 });
    ok((head + li) % 4 === 0, "计划卡：标题到第一步落在 4 的倍数上", { head, li, gap: head + li });
  });

  finished = true;
  console.log(`\n${fail ? "✗" : "✓"} 桌面端体验：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
