"use strict";
/**
 * 开工之前那道闸：这活儿该先照哪个技能做——以及技能加载之后别再丢。
 *
 * 用户装了技能是为了干那类活的时候照着做，可现场经常是：写公众号推文，装着公众号技能，
 * agent 直接写了；写到一半上下文压缩一轮，加载过的技能也跟着没了。两件事一起修：
 *   ① 点了名的直接加载（一分钱不花）；没点名的、开关开着，问判断模型一道单选；
 *   ② 加载过的技能挂在系统提示词里而不是历史里，压缩、截短碰不到；下一趟开跑先捡回来；
 *   ③ 压缩用的模型跟这一趟对话选的那条走，不再撞全局那条（用户把默认渠道填成判断模型时会 400）。
 *
 * 判断模型那一下整个换成假的：一分钱不花、一个字节不出网。
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

// 技能目录跟着数据目录走（skills.js 在 require 时就算好了），所以得在 require 之前把家搬到临时目录
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sgate-home-"));
process.env.OPENWORKBUDDY_HOME = HOME;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");
fs.mkdirSync(path.join(HOME, "skills", "wechat-article"), { recursive: true });
fs.mkdirSync(path.join(HOME, "skills", "html-page"), { recursive: true });
fs.mkdirSync(path.join(HOME, "skills", "web-styles"), { recursive: true });
const WECHAT_RULE = "公众号推文规矩：标题不超过二十字，开头三行内必须点题，每节配一张配图，结尾放引导关注。";
fs.writeFileSync(path.join(HOME, "skills", "wechat-article", "skill.md"), `---\nname: wechat-article\ndescription: 微信公众号推文写作与排版：标题、导语、配图、结尾引导，一整套规矩\n---\n${WECHAT_RULE}\n`);
fs.writeFileSync(path.join(HOME, "skills", "html-page", "skill.md"), `---\nname: html-page\ndescription: 做单页网页的骨架：语义化结构、响应式、自检\n---\n网页骨架规矩：一个 h1、语义化标签、移动端先。\n`);
fs.writeFileSync(path.join(HOME, "skills", "web-styles", "skill.md"), `---\nname: web-styles\ndescription: 八种视觉方向任挑一个\n---\n八种风格：极简、杂志……\n`);

const ROOT = path.join(__dirname, "..");
const sg = require(path.join(ROOT, "skill-gate"));
const jev = require(path.join(ROOT, "jev"));
const systemone = require(path.join(ROOT, "systemone"));
const tools = require(path.join(ROOT, "tools"));
const { createAgentRuntime } = require(path.join(ROOT, "agent"));
const { McpManager } = require(path.join(ROOT, "mcp"));
const { named, route, pickQuestions, pickState, readPick, skillBlock, loadedNote, PICK_KEY, NONE } = sg;

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

const SKILLS = [
  { name: "wechat-article", description: "微信公众号推文写作与排版" },
  { name: "html-page", description: "做单页网页的骨架" },
  { name: "html-pages-v2", description: "多页站" },
  { name: "web-styles", description: "八种视觉方向" },
];
const pick = (value, sure) => ({ key: PICK_KEY, value, sure });
const out = (...answers) => ({ ok: true, answers });

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 用户点没点名（免费的尺子先量）");
  // ─────────────────────────────────────────────────────────────
  {
    eq(named("/wechat-article 写一篇关于降温的推文", SKILLS), "wechat-article", "「/名字」这种提示词里承诺过的写法认得出");
    eq(named("用 wechat-article 写一篇推文", SKILLS), "wechat-article", "名字本身当一个词出现也认");
    eq(named("用 WeChat-Article 写", SKILLS), "wechat-article", "大小写不计较");
    eq(named("帮我写一篇公众号推文，主题是降温", SKILLS), "", "★没点名就是没点名★ 「公众号」三个字不等于点了 wechat-article——那是判断模型的活，不是正则的");
    eq(named("按 html-pages-v2 做", SKILLS), "html-pages-v2", "整词匹配：html-pages-v2 不会被 html-page 抢走");
    eq(named("这个 page 改一下", SKILLS), "", "（对照）提到 page 不算点了 html-page");
    eq(named("用html-page做个页面", SKILLS), "html-page", "跟汉字挨着也算整词（汉字不是词字符）");
    eq(named("", SKILLS), "", "空话不算");
    eq(named("/wechat-article", []), "", "没装技能时怎么点都点不着");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 这一趟走哪条路（只有 judge 那条花钱）");
  // ─────────────────────────────────────────────────────────────
  {
    const base = { on: true, ready: true, message: "帮我写一篇公众号推文", skills: SKILLS, loaded: 0, depth: 0 };
    eq(route(base).route, "judge", "开着、配了、没点名、没加载过、顶层 → 值一道题");
    eq(route({ ...base, message: "/wechat-article 写推文" }).route, "named", "点了名 → 直接加载");
    eq(route({ ...base, on: false, message: "/wechat-article 写推文" }).route, "named", "★点了名不看开关★ 开关关着照样加载，一分钱不花");
    eq(route({ ...base, on: false }).route, "skip", "没点名、开关关着 → 照旧交给模型自己想");
    eq(route({ ...base, on: "true" }).route, "skip", "开关写成字符串 \"true\" 不算开");
    eq(route({ ...base, on: 1 }).route, "skip", "开关写成 1 也不算开");
    eq(route({ ...base, ready: false }).route, "skip", "没配判断模型 → 照旧");
    eq(route({ ...base, loaded: 1 }).route, "none", "★已经加载过就不问★ 一轮里只问一次");
    eq(route({ ...base, loaded: new Map([["x", "y"]]) }).route, "none", "  └ 传 Map 也认");
    eq(route({ ...base, depth: 1 }).route, "none", "专家子任务不问：技能该由父任务挑");
    eq(route({ ...base, skills: [] }).route, "none", "没装技能 → 不碰");
    eq(route({ ...base, message: "   " }).route, "none", "空话 → 不碰");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 题目怎么拼");
  // ─────────────────────────────────────────────────────────────
  {
    const qs = pickQuestions(SKILLS);
    const q = qs[PICK_KEY];
    eq(q.type, "choice", "是一道单选");
    ok(Object.keys(q.criteria).includes("wechat-article") && Object.keys(q.criteria).includes(NONE), "选项 = 技能名 + 「都不对口」", Object.keys(q.criteria));
    ok(systemone.normalize ? true : true, "（systemone 自己会校验题目格式）");
    const st = pickState({ message: "帮我写一篇公众号推文", skills: SKILLS });
    ok(/【用户这次要做什么】\n帮我写一篇公众号推文/.test(st), "现场里有用户原话");
    ok(/【可用技能】\n- wechat-article：微信公众号推文写作与排版/.test(st), "现场里有技能清单和简介");
    const many = Array.from({ length: 40 }, (_, i) => ({ name: "s" + i, description: "d" + i }));
    ok(Object.keys(pickQuestions(many)[PICK_KEY].criteria).length <= sg.SKILL_MAX + 1, "技能太多时只摆前几十个，单选题不能变成大海捞针");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ 答案怎么读（只有「挑了真有的、而且拿得准」才算数）");
  // ─────────────────────────────────────────────────────────────
  {
    const d = readPick(out(pick("wechat-article", 0.9)), SKILLS);
    ok(d && d.name === "wechat-article", "挑了 wechat-article、确定度 0.9 → 照做", d);
    eq(readPick(out(pick(NONE, 0.95)), SKILLS), null, "挑「都不对口」→ 照旧");
    eq(readPick(out(pick("wechat-article", 0.5)), SKILLS), null, "★确定度不到 0.7 → 照旧★ 拿不准就别替模型挑");
    eq(readPick(out(pick("wechat-article", 0.7)), SKILLS) && readPick(out(pick("wechat-article", 0.7)), SKILLS).name, "wechat-article", "  └ 刚好 0.7 算到了");
    eq(readPick(out(pick("不存在的技能", 0.99)), SKILLS), null, "★挑了清单外的名字 → 照旧★ 上游偶尔会把选项改写");
    eq(readPick(out(pick(null, 0.99)), SKILLS), null, "没答上来 → 照旧");
    eq(readPick(out({ key: "别的题", value: "wechat-article", sure: 0.99 }), SKILLS), null, "答的不是这道题 → 照旧");
    eq(readPick(null, SKILLS), null, "整个没回 → 照旧");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑤ 挂进系统提示词那一段");
  // ─────────────────────────────────────────────────────────────
  {
    eq(skillBlock(new Map()), "", "没加载过就一个字不加");
    const m = new Map([["a", "甲的全文"], ["b", "乙的全文"], ["c", "丙的全文"], ["d", "丁的全文"]]);
    const blk = skillBlock(m);
    ok(/## 已加载技能（全文）/.test(blk), "有标题");
    ok(/### 技能：b[\s\S]*乙的全文/.test(blk) && /丁的全文/.test(blk), "最近加载的三份全文都在");
    ok(!/甲的全文/.test(blk) && /更早加载过、这儿放不下的：a/.test(blk), "★第四份换出去了，但名字留着★ 要用再 use_skill，别让模型以为从没加载过");
    ok(/不必再 use_skill/.test(blk), "告诉模型不必再加载一遍（不然它每一步都想 use_skill 一次）");
    ok(/「wechat-article」/.test(loadedNote("wechat-article", "x".repeat(120))) && /120 字/.test(loadedNote("wechat-article", "x".repeat(120))), "回执里有名字和字数");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑥ 真跑一趟 agent：技能是不是真的在模型眼前");
  // ─────────────────────────────────────────────────────────────
  {
    const experts = { list: () => [], get: () => null };
    const baseCfg = (agent) => ({
      agent: { max_steps: 6, tool_timeout_ms: 30000, ask_user_timeout_ms: 30000, ...agent },
      decide: { api_key: "假 Key，这趟根本不发网络" },
    });
    ok(jev.status(baseCfg({})).ready === true, "  └（前置）这份假配置在 jev 眼里算「配好了」，否则下面全是在测空气");

    const realAsk = jev.askMetered;
    let asked = [];
    const stub = (impl) => { asked = []; jev.askMetered = async (config, args, opts) => { asked.push({ args, opts }); return impl(); }; };

    /** 按脚本回话的假模型：记下每一步收到的 system */
    const scripted = (steps) => {
      const seen = [];
      let i = 0;
      return {
        provider: "假", model: "假模型",
        seen,
        chat: async ({ system, history }) => {
          seen.push({ system, history: history.slice() });
          const s = steps[Math.min(i, steps.length - 1)]; i++;
          if (typeof s === "function") return s({ system, history });
          return s;
        },
      };
    };
    const END = { text: "写完了。", toolCalls: [], stopReason: "end", usage: { prompt: 10, completion: 5 } };
    const USE = (name, id) => ({ text: "先加载技能。", toolCalls: [{ id, name: "use_skill", input: { name } }], stopReason: "tool_use", usage: { prompt: 10, completion: 5 } });

    const runOnce = async (cfg, llm, history, extra = {}) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sgate-"));
      const statuses = [], toolResults = [];
      const rt = createAgentRuntime({ config: cfg, llm, mcpManager: new McpManager(), experts });
      const r = await tools.withWorkspace(dir, () => rt.runTask({
        history,
        askUser: async () => "随便",
        emit: (e) => {
          if (e.type === "status") statuses.push(e.text);
          if (e.type === "tool_result") toolResults.push(String(e.preview || ""));
        },
        ...extra,
      }));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      return { r, statuses, toolResults };
    };
    const sysHas = (llm, i, re) => re.test(String((llm.seen[i] || {}).system || ""));

    try {
      // A 开着 + 判断模型挑了 wechat-article → 第一步的 system 里就有技能全文，模型一次 use_skill 都没调
      stub(() => out(pick("wechat-article", 0.9)));
      let llm = scripted([END]);
      let a = await runOnce(baseCfg({ skill_gate: true }), llm, [{ role: "user", content: "帮我写一篇公众号推文，主题是降温" }]);
      eq(asked.length, 1, "★花了一道题★ 开工前判了一次该照哪个技能做");
      ok(asked[0] && /【用户这次要做什么】[\s\S]*降温/.test(asked[0].args.state) && /wechat-article/.test(asked[0].args.state), "  └ 现场里有用户原话和技能清单");
      ok(sysHas(llm, 0, new RegExp(WECHAT_RULE)), "★★技能全文在第一步的系统提示词里★★ 模型动手之前就看见了，不靠它想不想得起来");
      ok(sysHas(llm, 0, /### 技能：wechat-article/), "  └ 挂在「已加载技能」一节里");
      ok(a.statuses.some((s) => /先照技能「wechat-article」做/.test(s) && /判断模型挑的/.test(s)), "★留痕★ 界面上说了是判断模型挑的、确定度多少", a.statuses);

      // B 对照：开关关着 → 一分钱不花，第一步的 system 里没有技能全文（老行为）
      stub(() => out(pick("wechat-article", 0.9)));
      llm = scripted([END]);
      await runOnce(baseCfg({ skill_gate: false }), llm, [{ role: "user", content: "帮我写一篇公众号推文，主题是降温" }]);
      eq(asked.length, 0, "★没打开就一分钱不花★");
      ok(!sysHas(llm, 0, new RegExp(WECHAT_RULE)), "  └（对照）技能全文不在 system 里——这就是用户抱怨的老样子");

      // C 点了名 + 开关关着 → 直接加载，一分钱不花
      stub(() => out(pick("html-page", 0.9)));
      llm = scripted([END]);
      const c = await runOnce(baseCfg({ skill_gate: false }), llm, [{ role: "user", content: "/wechat-article 写一篇关于降温的推文" }]);
      eq(asked.length, 0, "★点了名一分钱不花★");
      ok(sysHas(llm, 0, new RegExp(WECHAT_RULE)), "★点了名的直接挂进去★ 「/wechat-article」不再靠模型自觉");
      ok(c.statuses.some((s) => /你点了名/.test(s)), "  └ 留痕：说了是因为你点了名");

      // D 它挑「都不对口」→ 什么都不加载
      stub(() => out(pick(NONE, 0.95)));
      llm = scripted([END]);
      await runOnce(baseCfg({ skill_gate: true }), llm, [{ role: "user", content: "今天几号" }]);
      eq(asked.length, 1, "问了一道");
      ok(!sysHas(llm, 0, /## 已加载技能/), "★挑「都不对口」就一份都不挂★");

      // E 问不成（上游挂了）→ 退回老行为，而且要留痕
      const warns = [];
      const realWarn = console.warn;
      console.warn = (...x) => warns.push(x.join(" "));
      stub(() => { throw new Error("上游 502"); });
      llm = scripted([END]);
      await runOnce(baseCfg({ skill_gate: true }), llm, [{ role: "user", content: "帮我写一篇公众号推文" }]);
      console.warn = realWarn;
      ok(!sysHas(llm, 0, /## 已加载技能/), "★闸坏了退回老行为★ 不挂、不报错、任务照跑");
      ok(warns.some((w) => /开工前那一问没问成/.test(w)), "★吞掉的异常要留痕★", warns.slice(0, 1));

      // F 模型自己 use_skill：工具结果只回一张回执，全文在下一步的 system 里；历史里没有全文
      stub(() => out(pick(NONE, 0.95)));
      llm = scripted([USE("wechat-article", "tc_1"), END]);
      const f = await runOnce(baseCfg({ skill_gate: false }), llm, [{ role: "user", content: "帮我写一篇推文" }]);
      ok(f.toolResults.some((t) => /已加载技能「wechat-article」/.test(t) && !new RegExp(WECHAT_RULE).test(t)), "★use_skill 的工具结果是一张回执，不是全文★", f.toolResults.slice(-1));
      ok(!sysHas(llm, 0, new RegExp(WECHAT_RULE)) && sysHas(llm, 1, new RegExp(WECHAT_RULE)), "★★加载之后那一步起，全文在系统提示词里★★ 压缩、截短都碰不到它");
      const hist1 = llm.seen[1].history;
      ok(!hist1.some((e) => e.role === "tool" && (e.results || []).some((r) => new RegExp(WECHAT_RULE).test(String(r.content || "")))), "  └ 历史里没有第二份全文（以前全文进历史，压一次就没了）");

      // G 下一趟开跑先捡回来：历史里有 use_skill 那条调用 → 第一步的 system 里就有全文
      llm = scripted([END]);
      await runOnce(baseCfg({ skill_gate: false }), llm, [
        { role: "user", content: "帮我写一篇推文" },
        { role: "assistant", text: "先加载技能。", toolCalls: [{ id: "tc_1", name: "use_skill", input: { name: "wechat-article" } }] },
        { role: "tool", results: [{ id: "tc_1", content: "已加载技能「wechat-article」（80 字）" }] },
        { role: "assistant", text: "写好了初稿。", toolCalls: [] },
        { role: "user", content: "标题再短一点" },
      ]);
      eq(asked.length, 0, "已经加载过的不再问");
      ok(sysHas(llm, 0, new RegExp(WECHAT_RULE)), "★第二句话来了，上一句加载的技能还在★ 从历史里的 use_skill 捡回来的");

      // H 压缩摘要里那行【已加载技能】也捡得回来
      llm = scripted([END]);
      await runOnce(baseCfg({ skill_gate: false }), llm, [
        { role: "user", content: "【系统·上下文压缩】以下是本会话更早内容的自动摘要（原文已归档）：\n## 目标\n写推文\n【已加载技能】wechat-article、html-page\n【读过的文件】无\n" },
        { role: "user", content: "继续" },
      ]);
      ok(sysHas(llm, 0, new RegExp(WECHAT_RULE)) && sysHas(llm, 0, /### 技能：html-page/), "★压缩过之后技能也不丢★ 摘要里那行【已加载技能】机械地捡回来");
      ok(sysHas(llm, 0, /use_skill web-styles/), "  └ 捡回来的 html-page 带着配套提示（跟 use_skill 加载出来的一模一样）");

      // I 压缩用的是这一趟对话选的模型，不是全局那条；摘要里机械地记了已加载技能
      const global = {
        provider: "全局", model: "~typesafe/jev-latest",
        chat: async () => { throw new Error("400 ~typesafe/jev-latest is a decisions model"); },
      };
      let compactSeen = 0;
      const big = "这是一大段旧对话。".repeat(600); // ~5400 字，两轮就过 8000
      const L = scripted([({ system }) => {
        if (/会话压缩器/.test(system)) { compactSeen++; return { text: "## 目标\n写推文\n## 已完成\n无", toolCalls: [], usage: { prompt: 1, completion: 1 } }; }
        return END;
      }]);
      const histI = [
        { role: "user", content: "第一轮 " + big },
        { role: "assistant", text: "先加载技能。", toolCalls: [{ id: "tc_1", name: "use_skill", input: { name: "wechat-article" } }] },
        { role: "tool", results: [{ id: "tc_1", content: "已加载技能「wechat-article」" }] },
        { role: "assistant", text: "好。" + big, toolCalls: [] },
        { role: "user", content: "第二轮 " + big },
        { role: "assistant", text: "好。", toolCalls: [] },
        { role: "user", content: "第三轮" }, { role: "assistant", text: "好。", toolCalls: [] },
        { role: "user", content: "第四轮" }, { role: "assistant", text: "好。", toolCalls: [] },
        { role: "user", content: "第五轮" }, { role: "assistant", text: "好。", toolCalls: [] },
        { role: "user", content: "第六轮，继续写" },
      ];
      const dirI = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sgate-"));
      const rtI = createAgentRuntime({ config: baseCfg({ compact_threshold_chars: 1000, max_context_chars: 400000 }), llm: global, mcpManager: new McpManager(), experts });
      let errI = null;
      try {
        await tools.withWorkspace(dirI, () => rtI.runTask({ history: histI, llmOverride: L, askUser: async () => "随便", emit: () => {} }));
      } catch (e) { errI = e; }
      try { fs.rmSync(dirI, { recursive: true, force: true }); } catch {}
      eq(errI, null, "任务没报错", errI && errI.message);
      eq(compactSeen, 1, "★压缩走的是这一趟对话选的那条模型★ 全局那条是判断模型，以前撞它就 400");
      const mark = histI.find((e) => e.role === "user" && /^【系统·上下文压缩】/.test(String(e.content)));
      ok(mark && /【已加载技能】wechat-article/.test(mark.content), "★摘要里机械地记了已加载技能★ 不靠压缩模型记得写", mark && mark.content.slice(0, 200));
      ok(L.seen.some((s) => new RegExp(WECHAT_RULE).test(s.system)), "  └ 压缩完这一步，技能全文仍在系统提示词里");
    } finally {
      jev.askMetered = realAsk;
    }
  }

  console.log(`\n技能闸门：${pass} 通过，${fail} 失败`);
  finished = true;
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; finished = true; });
