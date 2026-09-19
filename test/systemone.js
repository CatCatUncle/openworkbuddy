"use strict";
/**
 * 判断模型（Jev / System One）：答得出，而且知道自己什么时候答不准。
 *
 * 它跟别的模型不是一路货——
 * 对话模型吃一段话吐一段话，这个吃一段**状态**加一道**有类型的题**，吐回来的是
 * 选中的选项 / 一个分数 / 一个 0~1 的概率，外加一个确定度。它压根不会写字。
 *
 * 这一套要挡的是五类静默失败，每一类在健康机器上都不报错：
 *   1. 挂错地方 —— 当成对话模型塞进 config.models，每一趟都是 400，而界面上它跟别的条目长得一样
 *   2. 类型写错要等发出去才知道 —— 上游回的是一坨 zod issue，落到界面上是天书
 *   3. 确定度被当摆设 —— 65% 的答案跟 99% 的答案一样被照做，这个模型最值钱的那一半直接没了
 *   4. noul 的确定度被当成模型给的 —— 上游那一类**根本没有** confidence 字段，是我们算的
 *   5. 材料被悄悄截断 —— 判断是拿前半段做的，人却以为它看了全文
 *
 * 所以断言几乎都成对：一条「该这样」，紧跟一条反向对照「不该那样的没那样」。
 *
 * 跑法：node test/systemone.js　（不联网、不花钱：请求怎么拼、回答怎么读都是纯函数）
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const S = require(path.join(ROOT, "systemone"));
const jev = require(path.join(ROOT, "jev"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 上游真回过的一份（照抄自 openrouter /api/alpha/decisions 的返回，只改了中文字面） */
const REPLY = {
  model: "typesafe/jev-1.13-20260917",
  id: "gen-dec-1789714248-2ppxbshXNvPnFhn6g4JR",
  answers: {
    lane: { type: "choice", choice: "表格", probabilities: { 代码: 0.01, 写作: 0, 研究: 0, 表格: 0.99 }, confidence: 0.99 },
    risk: { type: "score", score: 0.98, legend: { 0: "只读不改，没风险", 1: "会新建或改动文件", 2: "会删除或覆盖已有文件" }, probabilities: { 0: 0.03, 1: 0.97, 2: 0 }, confidence: 0.95 },
    needs_confirm: { type: "noul", noul: 0.63 },
  },
  usage: { input_tokens: 515, output_tokens: 79, cost: 0.00002163 },
};

// ─────────────────────────────────────────────────────────────
console.log("\n① 两条上游，同一套请求体——这是接这个模型时最值钱的一条发现");
{
  eq(S.ROUTES.openrouter.url, "https://openrouter.ai/api/alpha/decisions", "OpenRouter 走 decisions 那条独立的路");
  ok(!/chat\/completions/.test(S.ROUTES.openrouter.url), "（反向对照）不是 /chat/completions —— 拿聊天接口打它会被 400 顶回来");
  eq(S.ROUTES.typesafe.url, "https://api.typesafe.ai/v1/systemone", "官方走 /v1/systemone");
  eq(S.ROUTES.openrouter.model, "typesafe/jev-1.13", "OpenRouter 上的模型名带厂商前缀");
  eq(S.ROUTES.typesafe.model, "jev-latest", "官方那条不带前缀");
  const a = S.buildBody({ model: "m", state: "s", questions: { q: { type: "noul", instructions: "i" } } });
  eq(JSON.stringify(Object.keys(a).sort()), '["model","questions","state"]', "★请求体只有三个字段，两家共用一份★ 各写一套适配是这类接入最容易长歪的地方");
}

// ─────────────────────────────────────────────────────────────
console.log("\n② 题目先在本地查一遍——类型写错这种事不该花钱发一趟才知道");
{
  const bad = S.normalizeQuestions({ a: { type: "yesno", instructions: "急不急" } });
  eq(Object.keys(bad.questions).length, 0, "类型不认识的题不往外发");
  ok(/noul|choice|score/.test(bad.errs[0]) && /yesno/.test(bad.errs[0]), "报错里既说了你写的是什么，也说了能写什么", bad.errs);

  const good = S.normalizeQuestions({ a: { type: "noul", instructions: "急不急" } });
  eq(good.errs.length, 0, "（反向对照）写对的一道题一条错都不报");
  eq(JSON.stringify(good.questions.a), '{"type":"noul","instructions":"急不急"}', "noul 不带 criteria，多塞的字段不往外传");

  eq(S.normalizeQuestions({}).errs.length, 1, "一道题都没有要拦——光给材料它不知道你要判断什么");
  eq(S.normalizeQuestions(null).errs.length, 1, "传了个 null 也拦，不往上游发空请求");
  eq(S.normalizeQuestions([{ type: "noul" }]).errs.length, 1, "数组不是对象：答案是按名字取回来的，数组没有名字");
  ok(/instructions|判断什么/.test(S.normalizeQuestions({ a: { type: "noul", instructions: "  " } }).errs[0]), "只有空白的题面 = 没写");

  const one = S.normalizeQuestions({ a: { type: "choice", instructions: "哪一路", criteria: { 表格: "读写 Excel" } } });
  eq(Object.keys(one.questions).length, 0, "★单选只给一个选项要拦★ 只有一个选项不叫选，上游会照答，答的是废话");
  const two = S.normalizeQuestions({ a: { type: "choice", instructions: "哪一路", criteria: { 表格: "读写 Excel", 写作: "写文档" } } });
  eq(Object.keys(two.questions).length, 1, "（反向对照）两个选项就放行");

  const arr = S.normalizeQuestions({ a: { type: "choice", instructions: "哪一路", criteria: ["表格", "写作"] } });
  eq(JSON.stringify(arr.questions.a.criteria), '{"表格":"表格","写作":"写作"}', "选项给数组也认——命令行上让人敲 key: value 太难为人");

  const sc = S.normalizeQuestions({ a: { type: "score", instructions: "风险", criteria: { 2: "高", 0: "低", 1: "中" } } });
  eq(JSON.stringify(sc.questions.a.criteria), '["低","中","高"]', "★打分的档位给对象也认，而且按数字键排回去★ 档位顺序就是分数，排错了 0 分和 2 分就反了");
  eq(S.normalizeQuestions({ a: { type: "score", instructions: "风险", criteria: ["低"] } }).errs.length, 1, "打分只给一档也要拦");

  const many = {};
  for (let i = 0; i < S.MAX_QUESTIONS + 3; i++) many["q" + i] = { type: "noul", instructions: "x" };
  const cap = S.normalizeQuestions(many);
  eq(Object.keys(cap.questions).length, S.MAX_QUESTIONS, "一次最多 " + S.MAX_QUESTIONS + " 道");
  ok(cap.errs.length === 1 && /挤没|最多/.test(cap.errs[0]), "超了要说一声，不是默默扔掉后面几道", cap.errs);
}

// ─────────────────────────────────────────────────────────────
console.log("\n③ 材料：对象不拍平成文字，太长了要承认自己截了");
{
  const o = S.stateOf({ 文件名: "财报.xlsx", 最近打开: "从没打开过" });
  eq(typeof o.state, "object", "★对象原样传★ 字段名本身就是信息，拍平成一行等于把结构扔了");
  eq(o.cut, false, "没超预算就不截");
  const long = "啊".repeat(S.MAX_STATE + 500);
  const c = S.stateOf(long);
  eq(c.state.length, S.MAX_STATE, "超了截到上限");
  eq(c.cut, true, "★截了一定要说★ 判断是拿前半段做的，人却以为它看了全文——这种错事后最难查");
  eq(c.chars, long.length, "原文多长也带回来，界面才说得出截掉了多少");
  eq(S.stateOf("短的").cut, false, "（反向对照）短材料不谎报截断");
  const big = {};
  for (let i = 0; i < 4000; i++) big["k" + i] = "值值值值值";
  const b = S.stateOf(big);
  eq(typeof b.state, "string", "对象太大了退回成被截断的文字——截过的 JSON 不再是合法 JSON，硬塞回去上游会 400");
  eq(b.cut, true, "退成文字的那一趟同样算截过");
}

// ─────────────────────────────────────────────────────────────
console.log("\n④ 回答读成一套固定形状，界面和命令行照同一份读");
{
  const r = S.readAnswers(REPLY);
  eq(r.model, "typesafe/jev-1.13-20260917", "模型名带回来的是上游真跑的那个版本号，不是我们请求时写的别名");
  eq(r.answers.length, 3, "三道题三条回答");
  const lane = r.answers.find((a) => a.key === "lane");
  eq(lane.value, "表格", "单选取到的是选项名");
  eq(lane.probs[0].name, "表格", "概率按高到低排");
  eq(lane.probs[lane.probs.length - 1].p, 0, "（反向对照）0 概率的选项没被丢掉——「它明确排除了什么」也是信息");
  const risk = r.answers.find((a) => a.key === "risk");
  eq(risk.value, 0.98, "打分取到的是那个小数，不是四舍五入过的整数");
  eq(risk.label, "会新建或改动文件", "★0.98 落在第 1 档★ 光给个 0.98 没人知道那是什么意思，得把档位名配回去");
  eq(JSON.stringify(risk.legend), '["只读不改，没风险","会新建或改动文件","会删除或覆盖已有文件"]', "档位表按数字键排好带回来");
  eq(r.usage.cost, 0.00002163, "上游给了 cost 就用它的");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑤ noul 的确定度是我们算的，不能冒充模型给的");
{
  const r = S.readAnswers(REPLY);
  const n = r.answers.find((a) => a.key === "needs_confirm");
  eq(n.value, 0.63, "noul 的答案就是那个概率本身");
  eq(n.confidence, null, "★noul 的 confidence 必须是 null★ 上游那一类根本没这个字段，填个数进去等于让人拿我们算的数去做审计");
  eq(Math.round(n.sure * 100) / 100, 0.26, "sure 是「离 0.5 多远」算出来的：0.63 → 0.26");
  eq(S.sureOfNoul(0.5), 0, "五五开 = 完全没主意");
  eq(S.sureOfNoul(1), 1, "一边倒 = 很有主意");
  eq(S.sureOfNoul(0), 1, "★倒向「否」同样是有主意★ 只看概率大小的话，0.02 会被当成「最没把握」，其实它非常确定");
  eq(S.sureOfNoul("abc"), 0, "读不出数就是 0，不返回 NaN 往下游传");
  const choice = r.answers.find((a) => a.key === "lane");
  eq(choice.confidence, 0.99, "（反向对照）单选那一类上游真给了 confidence，照实带回来");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑥ 确定度闸门：这个模型最值钱的不是答得准，是知道自己什么时候不准");
{
  const r = S.readAnswers(REPLY);
  const g1 = S.gate(r.answers.find((a) => a.key === "lane"));
  eq(g1.act, true, "99% 的单选可以直接照做");
  const g2 = S.gate(r.answers.find((a) => a.key === "needs_confirm"));
  eq(g2.act, false, "★63% 的是非题不许自动照做★ 65% 跟 99% 一样被照做的话，这个模型一半的价值直接没了");
  ok(/别自动照做|问一声/.test(g2.why), "拦下来要说清下一步干什么，不是只说「不行」", g2.why);
  eq(S.gate(r.answers.find((a) => a.key === "needs_confirm"), 0.2).act, true, "门槛可以调——不同调用点该承担的风险不一样");
  eq(S.gate(null).act, false, "没答上来的当然不能照做");
  eq(S.gate({ value: null, sure: 1 }).act, false, "（反向对照）sure 再高，答案是空的也不行");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑦ 印成一行：三种问法各有各的说法，都得让人一眼看懂");
{
  const r = S.readAnswers(REPLY);
  const L = Object.fromEntries(r.answers.map((a) => [a.key, S.lineOf(a)]));
  ok(/表格/.test(L.lane) && /99%/.test(L.lane) && /确定度/.test(L.lane), "单选：选了谁、多大概率、多确定", L.lane);
  ok(/代码/.test(L.lane), "★第二名也印出来★ 只印第一名的话，55% 对 45% 跟 99% 对 1% 长得一模一样");
  ok(/0\.98/.test(L.risk) && /会新建或改动文件/.test(L.risk), "打分：数字和档位名一起印", L.risk);
  ok(/是/.test(L.needs_confirm) && /63%/.test(L.needs_confirm) && /拿不准/.test(L.needs_confirm), "★是非：0.63 要标「拿不准」★ 光印一个「是」会被当成它很确定", L.needs_confirm);
  const sure = S.lineOf({ key: "x", type: "noul", value: 0.99, label: "是", sure: 0.98, probs: [], legend: [] });
  ok(!/拿不准/.test(sure), "（反向对照）99% 不标拿不准——每行都标等于没标");
  eq(S.pct(0.999), "100%", "接近 1 就印整数，不印 99.9%");
  eq(S.pct(0.634), "63.4%", "中间的数留一位小数");
  eq(S.pct("x"), "—", "读不出的数印一个破折号，不印 NaN%");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑧ 上游的错翻成人话——尤其是 400，它的 body 是一坨 zod");
{
  const zod = '{"error":{"message":"[\\n  {\\n    \\"code\\": \\"invalid_union\\",\\n    \\"path\\": [\\n      \\"questions\\",\\n      \\"a\\",\\n      \\"type\\"\\n    ],\\n    \\"message\\": \\"Invalid discriminator value. Expected \'noul\' | \'choice\' | \'score\'\\"\\n  }\\n]","code":400}}';
  const e = S.errorOf(400, zod);
  ok(/questions\.a\.type/.test(e), "★400 要指出是哪道题的哪个字段★ 把整坨 zod 摔给用户等于什么都没说", e);
  ok(!/invalid_union/.test(e) || /questions\.a\.type/.test(e), "不把 zod 的行话原样端出来");
  eq(S.zodSpot('{"no":"path here"}'), "", "（反向对照）捞不出 path 就返回空，让调用方退回原文，不硬编一个假位置");
  ok(/Key/.test(S.errorOf(401, "")), "401 说的是 Key");
  ok(/余额|充值/.test(S.errorOf(402, "")), "402 说的是钱");
  ok(/decisions|systemone/.test(S.errorOf(404, "")), "★404 要把两条路的正确写法摆出来★ 这个模型最容易踩的就是打错接口");
  ok(/限流/.test(S.errorOf(429, "")), "429 说的是限流");
  ok(/连不上/.test(S.errorOf(0, "ECONNREFUSED")), "压根没发出去的那种也有话说");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑨ 这一趟花了多少：输出 token 不要钱，这是它跟对话模型最不一样的地方");
{
  const c = S.costOf({ input_tokens: 1000000, output_tokens: 999999 });
  eq(Math.round(c.usd * 1000) / 1000, 0.042, "★一百万输入 token = $0.042，输出多少都不加钱★");
  eq(c.estimated, true, "自己估的要标出来");
  eq(S.costOf({ cost: 0.5 }).estimated, false, "（反向对照）上游给了就不是估的——它才知道自己给没给折扣");
  ok(/不要钱/.test(S.costText({ input_tokens: 10, output_tokens: 10, cost: 0.0000001 })), "那句话得印出来，不然没人注意到");
  ok(!/e-/.test(S.costText({ input_tokens: 10, output_tokens: 0, cost: 0.0000001 })), "★钱少到这个份上也不许印成科学计数法★ 1e-7 在界面上没人读得懂");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑩ 挑渠道：先用用户已经有的那把 Key，而且不把 A 家的 Key 发给 B 家");
{
  const OR = { providers: [{ id: "openrouter", kind: "openrouter", api_key: "sk-or-x" }] };
  const r1 = jev.pickRoute(OR);
  eq(r1.ok + ":" + r1.route, "true:openrouter", "★配过 OpenRouter 的人什么都不用填★ 没人会为试一个模型专门再办一个号");
  eq(r1.key, "sk-or-x", "用的就是那条渠道上的 Key");

  const BOTH = { providers: [{ id: "openrouter", kind: "openrouter", api_key: "sk-or-x" }, { id: "ts", kind: "typesafe", api_key: "sk-ts-y" }] };
  eq(jev.pickRoute(BOTH).route, "typesafe", "两条都有的时候走官方——专门去办了号，意思就是想走官方");

  const EMPTY = { providers: [{ id: "openrouter", kind: "openrouter", api_key: "" }] };
  const r2 = jev.pickRoute(EMPTY);
  eq(r2.ok, false, "（反向对照）渠道在但没 Key = 不能用，不拿空 Key 去打一趟");
  ok(/设置|Key/.test(r2.how || ""), "说不能用就得说下一步去哪儿点", r2);

  const DENY = { providers: [{ id: "ds", kind: "deepseek", api_key: "sk-deepseek" }] };
  eq(jev.pickRoute(DENY).ok, false, "★别家的 Key 不拿来凑数★ DeepSeek 的 Key 发给 TypeSafe，轻则 401，重则把 Key 交到了不该去的地方");

  const GW = { providers: [{ id: "gw", kind: "typesafe", api_key: "sk-gw", base_url: "http://127.0.0.1:1/v1" }] };
  eq(jev.pickRoute(GW).url, "http://127.0.0.1:1/v1/systemone",
    "★渠道里填的地址说了算★ 无视它照旧发去官方，等于把人家自建网关的 Key 送到了另一家门口");
  eq(jev.pickRoute({ providers: [{ id: "o", kind: "openrouter", api_key: "k", base_url: "https://openrouter.ai/api/v1" }] }).url,
    "https://openrouter.ai/api/alpha/decisions",
    "（反向对照）填的就是官方那个 base_url，照样得到官方的判断地址——不能因为「认了 base_url」就把默认那条也拧歪");
  eq(S.urlFromBase("openrouter", "https://gw.example.com/api/v1"), "https://gw.example.com/api/alpha/decisions",
    "OpenRouter 那条要先摘掉尾巴上的 /v1：decisions 不在 /v1 底下，而人填渠道时填的一定是带 /v1 的那个");
  eq(S.urlFromBase("typesafe", "https://gw.example.com/v1/"), "https://gw.example.com/v1/systemone", "官方那条不摘，末尾多一道斜杠也认");
  eq(S.urlFromBase("typesafe", ""), S.ROUTES.typesafe.url, "没填就是默认");

  const CUSTOM = { decide: { route: "typesafe", base_url: "http://127.0.0.1:9/v1/systemone", api_key: "k", model: "jev-1.13.0" } };
  const r3 = jev.pickRoute(CUSTOM);
  eq(r3.url, "http://127.0.0.1:9/v1/systemone", "自建网关能自己指地址");
  eq(r3.model, "jev-1.13.0", "模型名也能钉死——别名会跟着上游发版漂");
  eq(jev.pickRoute({ decide: { off: true }, providers: [{ id: "o", kind: "openrouter", api_key: "k" }] }).ok, false, "能一键关掉");

  const st = jev.status(OR);
  eq(st.ready, true, "状态卡说得出能不能用");
  ok(!JSON.stringify(st).includes("sk-or-x"), "★状态卡里绝不能带 Key★ 这张卡是给设置页和 doctor 看的，会落到日志和截图里");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑪ 发不出去的请求在本地就挡住，不白花一趟往返");
{
  const cfg = { providers: [{ id: "o", kind: "openrouter", api_key: "sk-x" }] };
  return Promise.resolve()
    .then(() => jev.ask(cfg, { state: "有材料", questions: { a: { type: "yesno", instructions: "x" } } }))
    .then((r) => {
      eq(r.ok + ":" + !!r.badRequest, "false:true", "类型写错：本地就回，没发网络");
      return jev.ask(cfg, { state: "   ", questions: { a: { type: "noul", instructions: "急不急" } } });
    })
    .then((r) => {
      eq(r.ok, false, "★没给材料也拦★ 问题问得再清楚，没有材料它也判断不了——而上游会照答，答的是幻觉");
      ok(/state|材料/.test(r.error), "错话里说清缺的是材料", r.error);
      return jev.ask({}, { state: "x", questions: { a: { type: "noul", instructions: "y" } } });
    })
    .then((r) => {
      eq(r.ok + ":" + !!r.notReady, "false:true", "（反向对照）一条渠道都没配的机器上，回的是「还没配」而不是「答不上来」");
      rest();
    });
}

async function rest() {
// ─────────────────────────────────────────────────────────────
console.log("\n⑫ 挂在了该挂的地方：渠道目录、两个下拉、额度、接口、命令行");
{
  const mm = require(path.join(ROOT, "media-models"));
  const k = mm.PROVIDER_KINDS.find((x) => x.kind === "typesafe");
  ok(!!k, "渠道目录里有 TypeSafe 这一类，设置页里能加一条");
  eq(!!(k && k.decide_only), true, "标了 decide_only");
  eq(mm.guessKind("https://api.typesafe.ai/v1"), "typesafe", "粘个地址也认得出来");

  const ui = src("public/js/app-05.js");
  ok(/filter\(\(k\) => k\.chat_only \|\| k\.decide_only\)/.test(ui), "★媒体那个下拉把它挡在外面★ 它连文字都不产，更不可能画图配音");
  ok(/filter\(\(k\) => k\.media_only \|\| k\.decide_only\)/.test(ui), "★对话那个下拉也挡★ 判断模型没有 /chat/completions，挂上去每一趟都是 400");

  const q = require(path.join(ROOT, "quota"));
  ok(q.CAP_KEYS.includes("decide"), "额度表里有它——一段脚本跑一夜能问出几十万道");
  eq(q.billable("decide"), false, "（反向对照）不进钱闸：价目表里没有它，硬按次折钱只会算出个假数");

  const srv = src("server.js");
  ok(/app\.get\("\/api\/decide"/.test(srv) && /app\.post\("\/api\/decide"/.test(srv), "接口挂上了：GET 看状态、POST 真问");
  ok(/quota\.gate\("decide", \{ n,/.test(srv), "★额度按题数算，不按请求数★ 一次请求塞 30 道题，按请求记的话那道闸拦不住任何东西");
  ok(/quota\.undo\(g\.hold\)/.test(srv), "没发出去要把占的额度还回去");
  ok(/decide_only/.test(srv), "渠道测活认得出它，不拿 /chat/completions 去 ping");

  const subs = require(path.join(ROOT, "cli-args")).SUBS;
  ok(subs.some((x) => x.name === "jev"), "命令行有 openworkbuddy jev");
  ok(/if \(sub === "jev"\)/.test(src("cli.js")), "而且真接上了实现——写进表里没实现是这类命令最常见的坏法");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑬ 上游哪天加了第四种问法：原样留着，别假装读懂了");
{
  const r = S.readAnswers({ answers: { x: { type: "rank", order: ["a", "b"] } } });
  eq(r.answers[0].value, null, "读不懂的不瞎猜一个值");
  ok(/不认识/.test(r.answers[0].label), "明说这一类还不认识", r.answers[0].label);
  eq(S.readAnswers({}).answers.length, 0, "空回答不炸");
  eq(S.readAnswers(null).answers.length, 0, "null 也不炸");
  eq(S.readAnswers({ answers: { a: { type: "choice" } } }).answers[0].value, null, "单选没带 choice：当没答上来，不返回空串冒充答案");
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑭ 接到活儿上：目标验收改用判断模型，拿不准的不许打勾");
{
  const { createGoalEngine } = require(path.join(ROOT, "goal"));
  const noul = (k, p) => ({ key: k, type: "noul", value: p, label: p > 0.5 ? "是" : "否", confidence: null, sure: S.sureOfNoul(p), probs: [], legend: [] });
  const 卡 = () => ({ dir: "", goal: { text: "出一份周报", status: "active", criteria: [{ text: "生成 docx", done: false }, { text: "发给主管", done: false }] } });

  // 很确定的打勾，像是达成但拿不准的留着
  let sess = 卡(), note = "";
  let 问到的 = null;
  const eng = createGoalEngine({ workspaceDir: "/tmp", decide: async (a) => { 问到的 = a; return { ok: true, answers: [noul("c0", 0.99), noul("c1", 0.62)] }; } });
  await eng.verify(null, sess, "干完了", (w) => (note = w));
  eq(sess.goal.criteria[0].done, true, "99% 那条打勾");
  eq(sess.goal.criteria[1].done, false, "★62% 那条不打勾★ 原来的写法里 51% 和 99% 都是一个 true，框就上了——这张卡最骗人的地方就是打了勾的没人再看");
  ok(/拿不准/.test(note), "而且要在卡上说清是「拿不准」而不是「没干」，不然人会去重做一遍已经做完的事", note);
  eq(sess.goal.status, "active", "还有一条没勾就不算达成");

  // 问出去的那道题得是是非题，材料里得带上机器实测的结论
  eq(Object.keys(问到的.questions).length, 2, "只问还没打勾的那几条，打过勾的不重复花钱");
  eq(问到的.questions.c0.type, "noul", "★验收就是一道道是非题★ 让对话模型吐 {\"results\":[…]} 是拿会写字的东西模拟一张表格，它偶尔就不按格式回话");
  ok("目标" in 问到的.state && "执行汇报" in 问到的.state, "材料是结构化的，字段名本身就是信息", Object.keys(问到的.state));

  // 全过线就算达成
  sess = 卡();
  await createGoalEngine({ workspaceDir: "/tmp", decide: async () => ({ ok: true, answers: [noul("c0", 0.98), noul("c1", 0.97)] }) }).verify(null, sess, "干完了", () => {});
  eq(sess.goal.status, "done", "（反向对照）两条都很确定，目标该判达成");

  // 很确定地说「没达成」，不能因为「它很确定」就打勾
  sess = 卡();
  await createGoalEngine({ workspaceDir: "/tmp", decide: async () => ({ ok: true, answers: [noul("c0", 0.01), noul("c1", 0.02)] }) }).verify(null, sess, "没干", () => {});
  eq(sess.goal.criteria[0].done, false, "★很确定地说「没达成」★ 确定度和答案是两回事，只看 sure 过线就打勾会把「肯定没做」判成做了");

  // 判断模型没配 / 连不上：安静退回对话模型那条老路，不把这一轮废掉
  sess = 卡();
  let 退回了 = false;
  await createGoalEngine({ workspaceDir: "/tmp", decide: async () => ({ ok: false, error: "还没有能用的渠道", notReady: true }) })
    .verify(async () => { 退回了 = true; return JSON.stringify({ results: [{ i: 0, done: true }] }); }, sess, "干完了", () => {});
  eq(退回了, true, "★没配判断模型的机器上，目标卡得照常能用★ 接一个新模型最不能干的事是把没接它的人弄坏");
  eq(sess.goal.criteria[0].done, true, "退回去那条路也真判了");

  // 材料被截断过要说
  sess = 卡(); note = "";
  await createGoalEngine({ workspaceDir: "/tmp", decide: async () => ({ ok: true, answers: [noul("c0", 0.99), noul("c1", 0.99)], truncated: true }) }).verify(null, sess, "干完了", (w) => (note = w));
  ok(/截/.test(note), "★材料截过一定要说★ 这张卡是用来决定还要不要再跑一轮的，拿前半段判的得让人知道", note);
}

// ─────────────────────────────────────────────────────────────
console.log("\n⑮ 这一层是纯的：不联网、不读配置、不打印");
{
  const s = src("systemone.js");
  for (const [re, why] of [
    [/\brequire\(/, "require"],
    [/\bconsole\.\w+\(/, "console"],
    [/\bprocess\./, "process"],
    [/\bfetch\(/, "fetch"],
    [/\bDate\.now\(/, "Date.now"],
  ]) ok(!re.test(s), `不出现 ${why}——喂什么算什么，所以测得动、不花钱`);
  ok(/fetch\(/.test(src("jev.js")), "（反向对照）真正联网的那一半在 jev.js，不是根本没人发请求");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
}
