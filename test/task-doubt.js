"use strict";
/**
 * 定时任务「跑绿之后再看一眼」：判断模型给那一段**没人验过的绿**挂疑问。
 *
 * 要守的是一件很容易在实现里丢掉的事：这个功能的价值全在**边界**上，不在功能本身。
 * 边界一旦走样，它不是坏掉，而是变成噪音或者变成摆设——两种都比没有更糟：
 *
 *   1. 问的范围走样 —— 往短正文上也问，等于每天给已经查过的东西重复付钱；
 *      往红的上面问，等于给已经定性的失败再补一刀。这一套把「判据撒手」和「这一问接手」
 *      的那个长度**测出来对齐**，不是各自写死一个 400。
 *   2. 出声的门槛走样 —— 模型说「没办成」但自己只有六成把握，照样弹一句疑问，
 *      用户被冤枉两次就再也不看这行字了，然后真的那条也一起略过。
 *   3. 把绿改成了红 —— 模型没这个资格。运行记录必须还是绿的，它只能加注。
 *   4. 悄悄没问成 —— 上游挂了、额度满了、超时了，功能整个失灵的表现是「再也没有疑问」，
 *      跟「一切正常」长得一模一样。所以吞掉的异常必须在运行记录上留字段。
 *   5. 写了但没渲染 / 开关摆了但找不到 —— 后两组扫真源码，别让这一整套只活在测试里。
 *
 * 跑法：node test/task-doubt.js
 * 不花钱、不出外网：判断模型那一步在这儿是注入进来的假函数，scheduler 本来就不认 config。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const srcLib = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const tv = require(path.join(ROOT, "task-verdict"));
const systemone = require(path.join(ROOT, "systemone"));
const { createScheduler } = require(path.join(ROOT, "scheduler"));
const { needsSecondOpinion, deliveryQuestions, readDelivery, doubtMessage, DELIVERY_KEY, SECOND_OPINION_MIN, judgeRun } = tv;

let pass = 0, fail = 0, finished = false;
// 「悄悄提前退场」得算红。这一套里有一条用例是等超时的：真实现里那个定时器要是被 unref 了，
// 事件循环就空了，Node 会**当没事干一样退掉，退出码还是 0**——CI 上看就是一片绿，
// 实际上后面几组一条都没跑。判定器自己会骗人，所以在这儿钉一道：没走到收尾就是失败。
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）——多半是有人 unref 了某个定时器，事件循环空了`);
  process.exitCode = 1;
});

function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 把一句话垫到指定字数。垫的是句号，不带任何判据认识的词 */
const padTo = (base, n) => base + "。".repeat(Math.max(0, n - base.length));

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 什么时候该多问一道");
  // ─────────────────────────────────────────────────────────────
  {
    // 这个 fixture 短的时候一定被判红（整条正文就是那句报错），垫长了一定被放过——
    // 判据自己在注释里写的：「正文超过这个长度就认为 agent 真干活了」。
    const ERR = "报错：ECONNREFUSED，连不上上游";
    ok(judgeRun({ result: ERR }).ok === false, "垫料本身：短的时候判据会翻案（fixture 站得住）", judgeRun({ result: ERR }).label);

    eq(needsSecondOpinion({ result: ERR }), false, "短正文的红：不问（已经定性了，再问是补刀）");
    eq(needsSecondOpinion({ result: "已完成，推送成功" }), false, "短正文的绿：不问（这一段判据刚查过，重复花钱）");

    const LONG = padTo("今天的行业晨报已经生成并推送到飞书。第一次调用撞了 429 rate limit，等 20 秒重试后拿到了全部数据", 500);
    eq(needsSecondOpinion({ result: LONG }), true, "★长正文的绿：问★ 判据在这一段主动让路了，这条绿从来没人验过");

    eq(needsSecondOpinion({ result: LONG, stopped: "撞上限" }), false, "结构信号说了话：不问（stopped 零误判，轮不到猜）");
    eq(needsSecondOpinion({ result: LONG, error: "boom" }), false, "已经报错了：不问");
    eq(needsSecondOpinion({ result: "" }), false, "一个字没吐：不问（那本来就判红）");
    eq(needsSecondOpinion(), false, "什么都不给：不问，也不炸");

    // ★ 真正的那条断言：两边的长度门槛是同一个数，而且是**量出来**的不是抄来的。
    // 两把尺子分开量，才量得出中间有没有缝：
    //   · 判据什么时候撒手 —— 拿那句报错往长了垫，它从判红翻成判绿的那一字；
    //   · 这一问什么时候接手 —— 拿一条**没有任何失败字眼**的汇报往长了垫，它开始问的那一字。
    //     必须用干净正文：拿报错来量的话，needsSecondOpinion 末尾那句 judgeRun 会把结果拽到
    //     跟判据一样，两边就算错开了也看不出来——尺子和被量的东西成了同一个。
    // 谁哪天把 ERROR_ONLY_MAX_CHARS 调大而忘了这一问，中间那一段就成了「判据不看、
    // 这一问也不问」的黑洞；调小则是「判据刚查过、这一问又付一遍钱」。
    const CLEAN = "晨报已生成并推送到飞书群，覆盖 12 家公司";
    ok(judgeRun({ result: CLEAN }).ok, "量尺二：干净正文任何长度都是绿的（量的是「问不问」，不是「绿不绿」）");
    let flipJudge = -1, flipAsk = -1;
    for (let n = 100; n <= 700; n++) {
      if (flipJudge < 0 && judgeRun({ result: padTo(ERR, n) }).ok) flipJudge = n;
      if (flipAsk < 0 && needsSecondOpinion({ result: padTo(CLEAN, n) })) flipAsk = n;
    }
    ok(flipJudge > 100 && flipAsk > 100, "两个门槛都在扫描区间里找到了（不是撞在区间边上）", { flipJudge, flipAsk });
    eq(flipAsk, flipJudge, `★判据撒手的那一刻，正好是这一问接手的那一刻★ 中间不许有黑洞、也不许重叠（量出来是第 ${flipJudge} 字）`);
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 问出去的那道题");
  // ─────────────────────────────────────────────────────────────
  {
    const TASK = "每天早上八点生成行业晨报并推送到飞书群";
    const q = deliveryQuestions(TASK);

    ok(q && typeof q === "object" && !Array.isArray(q), "是对象不是数组（normalizeQuestions 只认对象，给数组它整趟拒收）");
    eq(Object.keys(q).length, 1, "只问一道（这一问要便宜到能天天问）");
    ok(Object.prototype.hasOwnProperty.call(q, DELIVERY_KEY), "题名就是导出的那个常量（答案是按名字取回来的）");
    eq(q[DELIVERY_KEY].type, "noul", "是非题：要的是「办了没有」，不是让它写字");
    ok(q[DELIVERY_KEY].instructions.includes(TASK), "题面里带着这条任务原本要干什么（不然它只能凭汇报自说自话）");
    ok(/办完/.test(q[DELIVERY_KEY].instructions), "题面写清了「怎么算办完」（模型不产文字，判据只能写在题面里）");
    ok(/今日休市/.test(q[DELIVERY_KEY].instructions), "「说清楚为什么办不成」也算办完（不然跳过日全被冤枉成没干活）");

    // ★ 过真正的那道门，不是手写一份「我觉得它长这样」
    const norm = systemone.normalizeQuestions(q);
    eq(norm.errs.length, 0, "★真的过 normalizeQuestions★ 零错误", norm.errs.join(" / "));
    eq(Object.keys(norm.questions).length, 1, "  └ 归一化之后还是那一道");
    ok(norm.questions[DELIVERY_KEY].instructions.length > 50, "  └ 题面没被吃掉");

    // 负向对照：证明上面那道门真的在守，不是随便给什么都零错误
    const bad = systemone.normalizeQuestions([q[DELIVERY_KEY]]);
    ok(bad.errs.length > 0, "  └ 负向对照：写成数组就报错（这道门是真的）", bad.errs[0]);

    // 任务描述可以很长（用户在界面上能写一大段），题面不能被它撑爆——
    // 状态那一栏要留给汇报正文，题面挤太多会把正文顶出 MAX_STATE。
    const huge = deliveryQuestions("查" + "极".repeat(5000));
    ok(huge[DELIVERY_KEY].instructions.length < 1400, "超长任务描述被截住了", huge[DELIVERY_KEY].instructions.length);
    eq(systemone.normalizeQuestions(huge).errs.length, 0, "  └ 截完照样是道合法的题");
    eq(systemone.normalizeQuestions(deliveryQuestions()).errs.length, 0, "任务描述为空也问得出去（老数据里真有没描述的）");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 答案怎么读：说得准才出声");
  // ─────────────────────────────────────────────────────────────
  {
    const ans = (value, sure) => ({ answers: [{ key: DELIVERY_KEY, type: "noul", value, sure }] });

    ok(readDelivery(ans(0.1, 0.8)) !== null, "它说没办完、而且挺确定：出声");
    ok(readDelivery(ans(0, 0.9)) !== null, "★概率 0 是「铁定没办完」，不是「没答上来」★ 别被 == null 顺手吃掉");
    eq(readDelivery(ans(0.9, 0.95)), null, "它说办完了：闭嘴");
    eq(readDelivery(ans(0.5, 0.99)), null, "正好一半：算办完，闭嘴（宁可漏判不误判）");
    eq(readDelivery(ans(0.4, 0.2)), null, "它说没办完但自己也没底：闭嘴");

    ok(readDelivery(ans(0.4, SECOND_OPINION_MIN)) !== null, "确定度正好卡在门槛上：出声（含等号）");
    eq(readDelivery(ans(0.4, SECOND_OPINION_MIN - 0.0001)), null, "  └ 差一丁点：闭嘴");
    ok(SECOND_OPINION_MIN > systemone.SURE_MIN, "★这道门比通用门槛严★ 冤枉一条真绿，比漏掉一条假绿贵", { SECOND_OPINION_MIN, SURE_MIN: systemone.SURE_MIN });

    eq(readDelivery(ans(null, 0.9)), null, "没答上来：当没问过，绝不拿「读不懂」当「没干完」");
    eq(readDelivery(ans(undefined, 0.9)), null, "  └ undefined 同理");
    eq(readDelivery({ answers: [] }), null, "一条答案都没有：闭嘴");
    eq(readDelivery({ answers: [{ key: "别的题", value: 0.1, sure: 0.9 }] }), null, "答的是别的题：闭嘴");
    eq(readDelivery(null), null, "整个 out 是 null：闭嘴，不炸");
    eq(readDelivery({}), null, "out 里没有 answers：闭嘴，不炸");

    ok(readDelivery(ans(0.4, 0.6), 0.5) !== null, "调用方可以自己压低门槛");
    eq(readDelivery(ans(0.4, 0.6), 0.9), null, "  └ 也可以自己抬高");
    eq(readDelivery(ans(0.4, 0.8), "呵呵").bar, SECOND_OPINION_MIN, "门槛给了个不是数的：退回默认，别把门槛变成 NaN（NaN 比一切都大，等于整个功能哑了）");

    const d = readDelivery(ans(0.12, 0.86));
    eq(d.sure, 0.86, "读回来的确定度就是它答的那个");
    eq(d.p, 0.12, "  └ 概率也原样带出来");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ 挂出来的那句话");
  // ─────────────────────────────────────────────────────────────
  {
    const msg = doubtMessage({ sure: 0.86 });
    ok(/86%/.test(msg), "带着确定度（用户得知道它有多硬气）", msg.slice(0, 40));
    ok(/记绿|不是裁定/.test(msg), "★说明白记录还是绿的★ 不说清楚，用户会以为任务失败了");
    ok(/执行过程/.test(msg), "告诉他下一步上哪儿看（说动作+后果，别光下判断）");

    // 这句话让用户「去设置里关掉那个开关」。开关叫什么，得跟设置界面上写的一模一样——
    // 一边改名一边忘了另一边，用户就会在设置里找一个不存在的东西。
    const ui = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
    const quoted = (msg.match(/「([^」]+)」/g) || []).map((x) => x.slice(1, -1)).filter((x) => x.length > 3);
    ok(quoted.length > 0, "  └ 那句话里确实点名了开关", quoted.join(" "));
    // 只在**这一行开关自己的那段界面**里找，不在整个设置页里找：
    // 设置页上词多，随便起个名字都可能在别处撞上，那样这条断言就变成了摆设。
    const at = ui.indexOf('id="ag-second"');
    const row = at > 0 ? ui.slice(Math.max(0, at - 1200), at + 200) : "";
    ok(row.length > 0, "  └ 找得到那一行开关", at);
    const ghost = quoted.filter((w) => !row.includes(w));
    eq(ghost.length, 0, "★让人去关的那个开关，界面上那一行真叫这个名字★", ghost.join(" ") || "对得上");
    ok(/设置\s*→\s*智能体设置/.test(msg), "  └ 路径也写了（「在设置里」等于没说）");
    ok(doubtMessage().length > 0 && doubtMessage(null).length > 0, "没给参数也不炸");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑤ 接进调度器：只加注，不改判");
  // ─────────────────────────────────────────────────────────────
  {
    const LONG = padTo("已经开始处理这条任务。我先读了任务描述，然后想了几种做法，中间试了三次都没跑通", 500);
    const SHORT = "已完成，结果已推送";

    function boot({ finalText, stopped, secondOpinion, doubtTimeoutMs }) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-doubt-"));
      const notes = [];
      const calls = [];
      const wrapped = secondOpinion && (async (item, text) => { calls.push({ item, text }); return secondOpinion(item, text); });
      const s = createScheduler({
        runtime: { runTask: async () => ({ finalText, stopped }) },
        storePath: path.join(dir, "schedules.json"),
        onResult: async (item, text) => notes.push(String(text == null ? "" : text)),
        secondOpinion: wrapped,
        doubtTimeoutMs,
      });
      s.stop(); // 关掉定时器，这儿手动驱动
      const item = s.add({ name: "晨报", cron: "0 8 * * *", task: "每天早上八点生成行业晨报并推送到飞书群" });
      return { s, item, notes, calls, dir };
    }
    /** 跑一趟，红的也别让它把测试炸了 */
    const run1 = async (b) => { try { await b.s.runOne(b.item.id, "手动"); } catch {} return b.s.runs(5)[0]; };

    const SAYS_NO = async () => ({ msg: "判断模型觉得这一轮多半没真办完（确定度 86%）。", sure: 0.86 });

    {
      const b = boot({ finalText: LONG, secondOpinion: SAYS_NO });
      const r = await run1(b);
      eq(r.ok, true, "★挂了疑问，运行记录还是绿的★ 模型没资格替人把绿改成红");
      ok(/没真办完/.test(r.doubt || ""), "  └ 疑问记在运行记录上", (r.doubt || "").slice(0, 24));
      eq(r.doubt_sure, 0.86, "  └ 确定度也存下来了（以后想调门槛，得先有历史数据）");
      eq(b.calls.length, 1, "  └ 只问了一趟");
      eq(b.calls[0].item.id, b.item.id, "  └ 拿到的是任务本体");
      eq(b.calls[0].text, LONG, "  └ 拿到的是这一轮的汇报原文");
      ok(b.notes[0].startsWith(LONG.slice(0, 30)), "★通知里正文在前★ 用户要的是结果，疑问是加注不是替换");
      ok(/没真办完/.test(b.notes[0]), "  └ 疑问缀在后面");
    }
    {
      const b = boot({ finalText: SHORT, secondOpinion: SAYS_NO });
      const r = await run1(b);
      eq(b.calls.length, 0, "★短正文一次都不问★ 这一段判据查过了，问了就是白花钱");
      eq(r.ok, true, "  └ 照样是绿的");
      eq(r.doubt, undefined, "  └ 不留空字段（前端拿 r.doubt 判有没有）");
    }
    {
      const b = boot({ finalText: LONG, stopped: "撞上限", secondOpinion: SAYS_NO });
      const r = await run1(b);
      eq(b.calls.length, 0, "★红的一次都不问★ 已经定性的失败不用再补一刀");
      eq(r.ok, false, "  └ 该红还是红");
    }
    {
      const b = boot({ finalText: LONG }); // 压根没注入：CLI、老部署、没开开关都走这条
      const r = await run1(b);
      eq(r.ok, true, "没接判断模型：一切照旧（这是默认形态，不是异常分支）");
      eq(r.doubt, undefined, "  └ 不挂疑问");
      eq(b.notes[0], LONG, "  └ 通知就是原文，一个字不多");
    }
    {
      const b = boot({ finalText: LONG, secondOpinion: async () => null }); // 它说办完了
      const r = await run1(b);
      eq(r.doubt, undefined, "它说办完了：什么都不挂");
      eq(b.notes[0], LONG, "  └ 通知也不动");
    }
    {
      const b = boot({ finalText: LONG, secondOpinion: async () => { throw new Error("额度用完了"); } });
      const r = await run1(b);
      eq(r.ok, true, "★第二意见炸了，任务照样交差★ 它不许把任务跑挂");
      ok(/额度用完/.test(r.doubt_failed || ""), "★但得留痕★ 不然整个功能失灵的样子跟「一切正常」一模一样", r.doubt_failed);
      eq(r.doubt, undefined, "  └ 没问成就不是疑问，别把报错当成模型的判断挂出去");
      eq(b.notes[0], LONG, "  └ 通知不受影响");
    }
    {
      // 上游挂着不出声比报错更难查：任务不是红了，是从此再也不跑了（这条一直锁着）。
      // 所以闸门在 scheduler 自己手里，不指望注入的人记得加超时。
      const t0 = Date.now();
      const b = boot({ finalText: LONG, secondOpinion: () => new Promise(() => {}), doubtTimeoutMs: 120 });
      const r = await run1(b);
      const took = Date.now() - t0;
      eq(r.ok, true, "★上游挂死：这一轮照样按时交差★");
      ok(/超时/.test(r.doubt_failed || ""), "  └ 留痕说的是超时，不是别的死因", r.doubt_failed);
      ok(took < 3000, "  └ 真的没被拖住", took + "ms");
      // 锁松开了才是真没拖住：锁没松，这条任务从下一分钟起就永远「正在跑」
      let again = null;
      try { await b.s.runOne(b.item.id, "手动"); again = "跑了"; } catch (e) { again = e.message; }
      eq(again, "跑了", "★下一趟还能跑★ 任务锁松开了，不是卡在「正在跑」上");
    }
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑥ 写了，得真渲染出来");
  // ─────────────────────────────────────────────────────────────
  {
    // 后台算得再对，没人看见就等于没有。
    // 这儿刻意不 grep：源码里出现过 `r.doubt` 这几个字，证明不了它被印了出来——
    // 真出过的事就是「算好了塞进变量，那个变量再没人读过」。所以把运行记录那一格的渲染函数
    // 从真源码里抠出来**真跑一遍**，看它到底吐不吐得出那句话。
    const list = fs.readFileSync(path.join(ROOT, "public", "js", "app-03.js"), "utf8");
    const at = list.indexOf("const runCell = (r) => {");
    ok(at > 0, "找得到运行记录那一格的渲染函数", at);
    const tail = list.slice(at);
    const src = tail.slice(0, tail.indexOf("\n  };")) + "\n  }";
    const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const cell = new Function("esc", "escInline", `const bold = escInline; ${src}; return runCell;`)(esc, esc);

    ok(cell({ result: "晨报已推送", doubt: "多半没真办完（确定度 86%）" }).includes("确定度 86%"),
      "★疑问真的印在运行记录那一格里★ 只写不渲染＝白写");
    const f = cell({ result: "晨报已推送", doubt_failed: "额度用完了" });
    ok(f.includes("额度用完了") && /没问成/.test(f), "★「没问成」也露脸★ 这功能最怕的死法是悄悄失灵（表现跟一切正常一模一样）", f.slice(0, 60));
    const plain = cell({ result: "晨报已推送" });
    ok(!/at-hint/.test(plain), "  └ 没疑问的那条干干净净，不挂空壳", plain);
    ok(cell({ result: "晨报已推送", doubt: "X" }).startsWith("晨报已推送"), "  └ 正文还在前面，疑问是加注");
    ok(!/\$\{r\.doubt/.test(list), "  └ 疑问是转义之后才印的（模型写的字不许直接进 HTML）");

    const srv = srcLib.src("server");
    ok(/second_opinion/.test(srv), "server 里有这个开关");
    ok(/if \(!\(config\.agent \|\| \{\}\)\.second_opinion\) return null;/.test(srv), "★默认关★ 没打开就一分钱不花（它花的是后台的钱，没人点确认）");
    ok(/jev\.status\(config\)\.ready/.test(srv), "  └ 没配判断模型也不发请求");
    ok(/judge_ready/.test(srv), "  └ 界面能知道「配没配」，好说实话");
    ok(/deliveryQuestions/.test(srv) && /readDelivery/.test(srv), "  └ 用的是这一层的纯函数，没在 server 里另抄一份判据");

    const ui = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
    ok(/id="ag-second"/.test(ui), "★设置里摆得出来★ 开关存在但找不到＝没有");
    ok(/second_opinion: pane\.querySelector\("#ag-second"\)\.checked/.test(ui), "  └ 勾了真存得下去");
    ok(/judge_ready/.test(ui), "  └ 没配判断模型时界面明说，别让它假装能开");
    ok(/两万分之一美金|美金|花钱|费/.test(ui), "  └ 说清楚它花钱（后台自己花的钱，必须先讲明白）");

    const i18n = fs.readFileSync(path.join(ROOT, "public", "js", "i18n.js"), "utf8");
    const label = (ui.match(/<div class="f">(定时任务[^<]*)<\/div>/) || [])[1];
    ok(!!label, "  └ 找得到那一行的标题", label);
    ok(label && i18n.includes(`"${label}"`), "  └ 标题有英文（这个产品是双语的，漏一条就半中半英）", label);
  }

  finished = true;
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
