"use strict";
/**
 * agent 手里的 decide 工具：把一批判断交给判断模型，而不是自己一条条读着判。
 *
 * 这一套要挡的，是把一个「不产文字」的模型塞进一个「满脑子文字」的 agent 时最容易出的四类哑巴错：
 *   1. 题名重了 —— 数组转成 { 名字: … } 的时候后一道盖掉前一道，少问一道题、少回一条答案，一路不报错
 *   2. 确定度被当摆设 —— 65% 的答案跟 99% 的一样被照做，这个模型最值钱的那一半直接没了
 *   3. 没配也摆出来 —— 模型先想一个方案、调一次、吃一条「没配」、再重想，白烧一轮
 *   4. 额度按请求数记 —— 一趟能带 32 道题，按请求数记等于发了张三十二倍的白条
 *
 * 跑法：node test/decide-tool.js
 * 不花钱、不出外网：判断模型指到本机起的一个假上游，pickRoute 对 localhost 本来就不要 Key。
 */

const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 假上游：照真接口的形状回，但每道题的答案由这次测试点名 */
function fakeUpstream(answerFor) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let j = {};
      try { j = JSON.parse(body); } catch {}
      seen.push(j);
      const answers = {};
      for (const k of Object.keys(j.questions || {})) answers[k] = answerFor(k, j.questions[k]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "fake/jev-0", id: "gen-test", answers, usage: { input_tokens: 515, output_tokens: 79, cost: 0.00002163 } }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, port: srv.address().port })));
}

/** 跑一趟真 agent：第一步调 decide，第二步收工。返回工具那条结果的正文 */
async function runDecide(input, { cfg = {}, upstream } = {}) {
  const { createAgentRuntime } = require(path.join(ROOT, "agent"));
  const { McpManager } = require(path.join(ROOT, "mcp"));
  let step = 0;
  const llm = {
    provider: "mock", model: "scripted",
    async chat() {
      step++;
      if (step === 1) return { text: "我先把这一批判断问掉。", usage: { prompt: 10, completion: 2 }, toolCalls: [{ id: "d1", name: "decide", input }], stopReason: "tool_use" };
      return { text: "判完了。", usage: { prompt: 20, completion: 2 }, toolCalls: [], stopReason: "end" };
    },
  };
  const config = {
    agent: { max_steps: 4, tool_timeout_ms: 30000 },
    ...(upstream ? { decide: { route: "typesafe", base_url: `http://127.0.0.1:${upstream.port}/v1/systemone` } } : {}),
    ...cfg,
  };
  const events = [];
  const rt = createAgentRuntime({ config, llm, mcpManager: new McpManager(), experts: [] });
  await rt.runTask({ history: [{ role: "user", content: "判一下" }], emit: (e) => events.push(e), taskLabel: "批量判断", sessionId: "s-decide" });
  const r = events.find((e) => e.type === "tool_result");
  // 过程卡带的是 preview（前 800 字），正好是模型真读到的那一段的开头
  return { text: String((r && r.preview) || ""), isError: !!(r && r.isError), events, config, rt };
}

/** 三道题的一批：分派（单选）、紧急度（打分）、要不要升级（是非） */
const 三道题 = [
  { name: "归谁处理", type: "choice", instructions: "这条工单该交给哪个组", criteria: ["支付", "技术", "销售"] },
  { name: "有多急", type: "score", instructions: "这位客户有多着急", criteria: ["不急", "希望尽快", "已经在造成损失了"] },
  { name: "要不要升级", type: "noul", instructions: "该升级给主管跟进" },
];
const 工单 = "客服工单：我的收款账号连了三天都连不上，订单都在丢，麻烦尽快。";

(async function main() {
  // ─────────────────────────────────────────────────────────
  console.log("① 配没配决定摆不摆出来——量的是真发给模型的那张工具表");
  {
    const { createAgentRuntime } = require(path.join(ROOT, "agent"));
    const { McpManager } = require(path.join(ROOT, "mcp"));
    // 没配就不摆，而不是摆出来再拒：摆出来的话模型会先想一个方案、调一次、吃一条「没配」、再重想。
    // 这一组不看源码、不看内部函数，只看 llm.chat 真收到的 tools——发出去的那张表才算数。
    const 摆了什么 = async (config, mode) => {
      let tools = null;
      const llm = { provider: "m", model: "m", async chat(a) { if (tools === null) tools = ((a && a.tools) || []).map((t) => t.name); return { text: "好", usage: {}, toolCalls: [], stopReason: "end" }; } };
      await createAgentRuntime({ config, llm, mcpManager: new McpManager(), experts: [] })
        .runTask({ history: [{ role: "user", content: "吗" }], emit: () => {}, mode, sessionId: "s-list" });
      return tools || [];
    };
    const 没配 = { agent: { max_steps: 2 } };
    const 配了 = { agent: { max_steps: 2 }, decide: { route: "typesafe", base_url: "http://127.0.0.1:1/v1/systemone" } };

    const a = await 摆了什么(没配, "craft");
    const b = await 摆了什么(配了, "craft");
    ok(a.length > 5, "打底：这张表本来就是满的（不是根本没取到）", a.length);
    ok(!a.includes("decide"), "★没配判断模型：发给模型的工具表里没有 decide★", a);
    ok(b.includes("decide"), "（反向对照）配了就摆出来，不是永远不摆");
    const 只有聊天渠道 = { agent: { max_steps: 2 }, providers: [{ id: "or", kind: "openrouter", api_key: "sk-or-x", base_url: "https://openrouter.ai/api/v1" }] };
    const e = await 摆了什么(只有聊天渠道, "craft");
    ok(e.length > 5 && !e.includes("decide"), "★只配了 OpenRouter 聊天渠道也不摆★ 有 Key ≠ 想用判断模型，没点头就一次都不调", e);

    const c = await 摆了什么(配了, "ask");
    const d = await 摆了什么(没配, "ask");
    ok(c.includes("decide"), "只看不动的档位里也摆——判断不动任何东西，「哪几条要人工看」本就是个只读问题", c);
    ok(!c.includes("write_file"), "  └ （反向对照）这一档真是只读的，不是把整张表原样搬过来了", c);
    ok(!d.includes("decide"), "（反向对照）没配的机器上这一档也没有");

    // 真调到了又没配（MCP / 回放能把任意工具名递进来）：话得说清楚，并且叫它别重试
    const out = await runDecide({ state: 工单, questions: 三道题 });
    ok(out.isError, "没配的机器上真调到了，是一条错，不是假装判了");
    ok(/还没接上/.test(out.text) && /设置|Key|TypeSafe/.test(out.text), "  └ 说的是「还没接上」，并且带上了去哪儿配", out.text.slice(0, 100));
    ok(/别重试/.test(out.text), "★叫它别重试★ 不说这句，模型会把「没配」当偶发失败一遍遍撞", out.text.slice(0, 120));
  }

  // ─────────────────────────────────────────────────────────
  console.log("\n② 一批判断真跑通：数组进去，按名字取回来");
  const up = await fakeUpstream((k) => {
    if (k === "归谁处理") return { type: "choice", choice: "支付", confidence: 0.93, probabilities: { 支付: 0.93, 技术: 0.05, 销售: 0.02 } };
    if (k === "有多急") return { type: "score", score: 2, confidence: 0.88, legend: { 0: "不急", 1: "希望尽快", 2: "已经在造成损失了" } };
    return { type: "noul", noul: 0.96 };
  });
  {
    const out = await runDecide({ state: 工单, questions: 三道题 }, { upstream: up });
    ok(!out.isError, "跑通了", out.text.slice(0, 120));
    eq(up.seen.length, 1, "★三道题只发了一趟★ 一题一个请求的话，这个模型省时间的那一半就没了");
    const q = up.seen[0].questions;
    eq(Object.keys(q).length, 3, "  └ 三道题都在这一趟里");
    ok(!Array.isArray(q), "  └ 发出去的是 { 名字: … } 而不是数组——上游只认这一种，发数组回的是一坨 zod issue");
    ok(Array.isArray(q["有多急"].criteria), "  └ 打分的档位保持数组（顺序就是分数，转成对象会把顺序丢掉）", q["有多急"].criteria);
    for (const k of ["归谁处理", "有多急", "要不要升级"]) ok(out.text.includes(k), `结果里有「${k}」这条`, out.text);
    ok(/支付/.test(out.text) && /已经在造成损失了/.test(out.text), "  └ 选项和档位是按名字念出来的，不是 0/1/2", out.text);
    ok(/都过了/.test(out.text), "★三条都很确定的时候，明说一句「都过了」★ 不说的话，模型读不出「这批可以直接往下走」", out.text);
  }

  // ─────────────────────────────────────────────────────────
  console.log("\n③ 拿不准的那几条要被单独拎出来");
  const up2 = await fakeUpstream((k) => {
    if (k === "归谁处理") return { type: "choice", choice: "技术", confidence: 0.41, probabilities: { 技术: 0.41, 支付: 0.39, 销售: 0.2 } };
    if (k === "有多急") return { type: "score", score: 1, confidence: 0.95, legend: { 0: "不急", 1: "希望尽快", 2: "已经在造成损失了" } };
    return { type: "noul", noul: 0.52 };   // 51 开 49，等于没判出来
  });
  {
    const out = await runDecide({ state: 工单, questions: 三道题 }, { upstream: up2 });
    ok(/拿不准/.test(out.text), "★点名说哪几条拿不准★ 这是这个模型最值钱的一半，混在结果里等于没有", out.text);
    ok(/归谁处理/.test(out.text.split("拿不准的（")[1] || ""), "  └ 41% 的单选在名单里", out.text);
    ok(/要不要升级/.test(out.text.split("拿不准的（")[1] || ""), "  └ 52% 的是非也在名单里——是非题的确定度是「离五五开多远」，不是那个概率本身", out.text);
    ok(!/有多急/.test(out.text.split("拿不准的（")[1] || ""), "（反向对照）95% 那条不在名单里，不是一股脑全标成拿不准", out.text);
    ok(/别当定论/.test(out.text), "  └ 并且说清楚这几条该怎么办", out.text);

    // 门槛能调：调到 0.3 之后，41% 那条就该放行
    const out2 = await runDecide({ state: 工单, questions: 三道题, sure_min: 0.3 }, { upstream: up2 });
    ok(!/拿不准的（[^]*归谁处理/.test(out2.text), "★门槛调低，41% 那条就放行了★ 门槛写死的话，这个工具只能服务一种业务", out2.text);
  }

  // ─────────────────────────────────────────────────────────
  console.log("\n④ 参数写坏的三种：当场说清楚，别让它撞上游的 400");
  {
    const dup = await runDecide({ state: 工单, questions: [三道题[0], { ...三道题[1], name: "归谁处理" }] }, { upstream: up });
    ok(dup.isError && /重名/.test(dup.text), "★题名重了当场拒★ 不拒的话后一道盖掉前一道，少问一道少回一条，一路不报错", dup.text.slice(0, 120));
    ok(/归谁处理/.test(dup.text), "  └ 指名是哪一道重了", dup.text);

    const noName = await runDecide({ state: 工单, questions: [{ type: "noul", instructions: "是不是投诉" }] }, { upstream: up });
    ok(noName.isError && /name/.test(noName.text), "没写 name 的题当场拒——回答是按名字取回来的", noName.text.slice(0, 120));

    const noState = await runDecide({ state: "   ", questions: 三道题 }, { upstream: up });
    ok(noState.isError && /state/.test(noState.text), "没给材料当场拒，不发出去白花一趟", noState.text.slice(0, 120));

    const empty = await runDecide({ state: 工单, questions: [] }, { upstream: up });
    ok(empty.isError && /questions/.test(empty.text), "一道题都没有也当场拒", empty.text.slice(0, 120));

    eq(up.seen.length, 1, "★这四种坏参数，一个请求都没发出去★ 发出去的话既花钱，回来的还是一串上游 zod issue");
  }

  // ─────────────────────────────────────────────────────────
  console.log("\n④' 材料太长被截了，得当场说");
  {
    // 判断是拿前半段做的。不说的话模型会当它读了全文往下走，
    // 而这种错事后最难查——结论看着好端端的，只是基于一半的材料。
    const big = "客服工单：" + "收款连不上，订单在丢。".repeat(4000);
    ok(big.length > 20000, "  └ 先造一份真超长的材料", big.length + " 字");
    const one = [{ name: "要不要升级", type: "noul", instructions: "该升级给主管" }];
    const cut = await runDecide({ state: big, questions: one }, { upstream: up });
    ok(!cut.isError, "  └ 截了也照常判（不是报错）");
    ok(/材料太长/.test(cut.text),
      "★截了就得说★ 不说的话模型当它读了全文，结论看着没毛病、实际只基于前半段",
      cut.text.slice(0, 110));
    ok(/只判了前 \d+ 字/.test(cut.text),
      "  └ 带上到底判了多少字（光说「截了」，人不知道截掉的是一成还是九成）");

    const short = await runDecide({ state: 工单, questions: one }, { upstream: up });
    ok(!/材料太长/.test(short.text), "  └ （反向对照）正常长度的不凭空冒这句");
  }

  // ─────────────────────────────
  console.log("\n⑤ 额度按题数算，不按请求数");
  {
    const quota = require(path.join(ROOT, "quota"));
    const jev = require(path.join(ROOT, "jev"));
    const calls = [];
    const g0 = quota.gate, r0 = quota.record;
    quota.gate = (cap, c) => { calls.push(["gate", cap, c.n]); return g0.call(quota, cap, c); };
    quota.record = (cap, c) => { calls.push(["record", cap, c.n]); return r0.call(quota, cap, c); };
    try {
      await jev.askMetered(
        { decide: { route: "typesafe", base_url: `http://127.0.0.1:${up.port}/v1/systemone` } },
        { state: 工单, questions: { a: { type: "noul", instructions: "x" }, b: { type: "noul", instructions: "y" }, c: { type: "noul", instructions: "z" } } },
        { meta: "测试" }
      );
    } finally { quota.gate = g0; quota.record = r0; }
    const gate = calls.find((c) => c[0] === "gate");
    const rec = calls.find((c) => c[0] === "record");
    eq(gate && gate[2], 3, "★占额度占的是 3（题数）不是 1（请求数）★ 一趟能带 32 道，按请求记等于发了张三十二倍的白条");
    eq(rec && rec[2], 3, "  └ 记账也是 3");
  }

  // ─────────────────────────────────────────────────────────
  console.log("\n⑥ 发不出去的时候不许占着额度");
  {
    const quota = require(path.join(ROOT, "quota"));
    const jev = require(path.join(ROOT, "jev"));
    let undone = 0, recorded = 0;
    const u0 = quota.undo, r0 = quota.record;
    quota.undo = (h) => { undone++; return u0.call(quota, h); };
    quota.record = (...a) => { recorded++; return r0.apply(quota, a); };
    try {
      // 题写坏了（type 拼错）：ask 在发出去之前就退回来
      const bad = await jev.askMetered(
        { decide: { route: "typesafe", base_url: `http://127.0.0.1:${up.port}/v1/systemone` } },
        { state: 工单, questions: { a: { type: "yesno", instructions: "x" } } },
        { meta: "测试" }
      );
      eq(bad.ok, false, "type 拼错，退回来了");
      eq(undone, 1, "★退款了★ 没发出去还占着额度的话，用量会一天比一天虚高，而且没人看得出来");
      eq(recorded, 0, "  └ 也没记花销");

      // 上游连不上：同样退款
      undone = 0;
      const dead = await jev.askMetered(
        { decide: { route: "typesafe", base_url: "http://127.0.0.1:1/v1/systemone" } },
        { state: 工单, questions: { a: { type: "noul", instructions: "x" } } },
        { meta: "测试" }
      );
      eq(dead.ok, false, "上游连不上，退回来了");
      eq(undone, 1, "  └ 这一路也退款");
    } finally { quota.undo = u0; quota.record = r0; }
  }

  // ─────────────────────────────────────────────────────────
  console.log("\n⑦ 记账这件事只有一份，不是各处各抄一遍");
  {
    const fs = require("fs");
    const srv = src("server");
    const ag = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    // 测活那条自己带着量（题数固定 3），其余都必须走 askMetered
    const hand = (srv.match(/quota\.gate\("decide"/g) || []).length;
    eq(hand, 1, "★server.js 里只剩测活那一处手写★ 每多抄一份，就多一个「占了没退 / 花了没记」的地方", hand);
    eq((ag.match(/quota\.gate\("decide"/g) || []).length, 0, "agent.js 一处都没抄");
    ok(/jev\.askMetered\(/.test(ag), "  └ agent 走的是同一本账");
    ok((srv.match(/jev\.askMetered\(/g) || []).length >= 2, "  └ 目标验收和 /api/decide 也都走它");
  }

  // ─────────────────────────────
  console.log("\n\u2467 技能里写的工具名，得是真实存在的工具");
  {
    const fs = require("fs");
    const skills = require(path.join(ROOT, "skills.js"));
    const all = skills.loadSkills();
    const t = (Array.isArray(all) ? all : all.skills || []).find((x) => x.name === "triage");
    ok(!!t, "技能 triage 扫得到（skills/ 是自动发现的，不用登记）");
    ok(t && (t.description || "").length > 10, "  └ 带描述（模型就靠这句话决定要不要开它）");

    // 工具分两处：tools.js 里的是一直在的，agent.js 里的是按配置挂上去的
    const { TOOL_DEFS } = require(path.join(ROOT, "tools.js"));
    const fromTools = (Array.isArray(TOOL_DEFS) ? TOOL_DEFS : Object.values(TOOL_DEFS))
      .map((d) => d.name || (d.function && d.function.name)).filter(Boolean);
    const agSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    const fromAgent = [...new Set((agSrc.match(/name: "[a-z_]+"/g) || []).map((x) => x.slice(7, -1)))];
    const known = new Set([...fromTools, ...fromAgent]);
    ok(known.has("decide"), "  └ decide 真的是个工具名");

    // 只扫这一门技能：它是专门教 agent 用工具的，反引号里的带下划线词就是工具名。
    // （别的技能里那些 `block_id` `access_token` 是字段名和错误码，泛化扫全是误报）
    const body = fs.readFileSync(path.join(ROOT, "skills", "triage", "skill.md"), "utf8");
    const cited = [...new Set((body.match(/`[a-z][a-z0-9_]{3,}`/g) || []).map((x) => x.slice(1, -1)))].filter((w) => /_/.test(w) || w === "decide");
    ok(cited.length >= 3, "  └ 技能里确实点名了几个工具", cited.join(" "));
    const ghost = cited.filter((w) => !known.has(w));
    eq(ghost.length, 0, "★没有一个是编出来的★ 技能里叫一个不存在的工具，模型会先试再绕，整门技能当场废掉", ghost.join(" ") || "都对得上");

    // 没配判断模型时技能不能括号里冷场：技能是按描述挑中的，工具却是按配置挂的，两边不同步
    ok(/没有 `decide` 这个工具/.test(body), "  └ 写了「工具不在手上时怎么办」（技能能被挑中、工具却没挂上，是真会发生的）");
  }

  up.srv.close(); up2.srv.close();
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
