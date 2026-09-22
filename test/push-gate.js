"use strict";
/**
 * 定时任务「没变化就不推」：推之前先问一句，这一轮跟上一次真推出去的那条比有没有新东西。
 *
 * 这个功能有个别处没有的性质：**它判错的时候，界面上什么都不会发生**。
 * 少响的那一声铃没人看得见，所以每一条边界都得在这儿钉死，靠事后发现是不可能的：
 *
 *   1. 只能把「推」变成「不推」 —— 红的、出错的、挂了疑问的，一律照推，这道闸碰都不碰。
 *      反过来更不行：它没资格把一条本来不推的变成推。
 *   2. 比的是「上一次真推出去的那条」，不是「上一次跑的那条」 —— 全套设计里最要紧的一条。
 *      某一轮被误判成没变化之后，攒下来的新东西下一次还要比得出来。⑦H 专测这件事。
 *   3. 不推也要留痕 —— 运行记录上得写明为什么没推。不写的话，「少发一条通知」和
 *      「这个任务已经不跑了」在界面上长得一模一样，那是最贵的一种坏。
 *   4. 白给的答案不花钱 —— 跟上一次一字不差，那就是「没变化」本身，不必买一个已经确定的答案。
 *   5. 拿不准、问不成、没配判断模型 —— 一律退回老行为：照推。闸坏了不许把通知吞了。
 *
 * 跑法：node test/push-gate.js
 * 不花钱、不出外网：判断模型那一步是注入进来的假函数，scheduler 本来就不认 config。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const pg = require(path.join(ROOT, "push-gate"));
const so = require(path.join(ROOT, "systemone"));
const { createScheduler } = require(path.join(ROOT, "scheduler"));
const { screen, newsQuestions, newsState, readNews, sameNote, skipNote, NEWS_KEY, KIND_KEY, NEWS_MIN } = pg;

let pass = 0, fail = 0, finished = false;
// 有一条用例是等超时的。真实现里那个计时器要是被 unref 了，事件循环就空了，
// Node 会当没事干一样退掉、退出码还是 0——CI 上看是一片绿，其实后面几组一条都没跑。
process.on("exit", (code) => {
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）——多半是有人 unref 了某个定时器`);
  process.exitCode = 1;
});

function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 一份假答案。p 是「有新东西」的概率：大于 0.5 = 有 */
const ans = (p, sure) => ({ key: NEWS_KEY, value: p, sure: sure === undefined ? Math.abs(p - 0.5) * 2 : sure });
const kind = (v) => ({ key: KIND_KEY, value: v, sure: 0.9 });
const out = (...answers) => ({ ok: true, answers });

(async () => {
  // ─────────────────────────────────────────────────────────────
  console.log("\n① 白给的尺子：哪几条根本不必花钱问");
  // ─────────────────────────────────────────────────────────────
  {
    eq(screen({ prev: "今天没有更新", text: "今天没有更新" }), "same", "★一字不差＝没变化本身★ 已经确定的答案不必花钱买");
    eq(screen({ prev: "今天没有更新\n", text: "  今天没有更新  " }), "same", "  └ 空白折叠：换行多一个不算新东西");
    eq(screen({ prev: "今天没有更新\n\n  耗时 3 秒", text: "今天没有更新 耗时 3 秒" }), "same",
      "  └ 中间的空白也折叠（trim 只管两头）：同一句话排版松紧不同，不该为它买一道题");
    eq(screen({ prev: "股价 12.3", text: "股价 12.4" }), "ask", "★字面不同才值一道题★ 只差一个字符，可能正是该响的那种");
    eq(screen({ prev: "今天没有更新（08:00）", text: "今天没有更新（09:00）" }), "ask", "  └ 夹着时间戳的：正则分不出，交给判断模型");

    eq(screen({ prev: "一样", text: "一样", ok: false }), "push", "★红的一律照推★ 坏消息一秒都不许拦");
    eq(screen({ prev: "一样", text: "一样", doubt: "这条你自己看一眼" }), "push", "★挂了疑问的一律照推★ 那正是最该到人眼前的一条");
    eq(screen({ prev: "", text: "第一次跑出来的结果" }), "push", "★没有基线：推★ 第一次跑不许被吞");
    eq(screen({ prev: "上一次", text: "" }), "push", "  └ 这一轮空的：照推（本来就不对劲，别拿它当没变化）");
    eq(screen({ prev: "上一次", text: "   \n  " }), "push", "  └ 只有空白也算空");
    eq(screen(), "push", "  └ 什么都不给：推，也不炸");
    eq(screen({ prev: "一样", text: "一样", ok: undefined }), "same", "  └ ok 缺省当成功（scheduler 只在绿的那条路上调它）");
    eq(screen({ prev: "一样", text: "一样", ok: "true" }), "push", "  └ ok 不是真的 true 就当红的：宁可多响一声");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n② 问出去的两道题");
  // ─────────────────────────────────────────────────────────────
  {
    const qs = newsQuestions("每天看一眼竞品官网的更新日志");
    const keys = Object.keys(qs);
    eq(keys.length, 2, "★两道：一道拍板，一道只为把话说人话★");
    ok(keys.includes(NEWS_KEY) && keys.includes(KIND_KEY), "  └ 名字跟读答案那头用的是同一对常量", keys);
    eq(qs[NEWS_KEY].type, "noul", "  └ 拍板那道是是非题（能拿到确定度的只有这一种）");
    eq(qs[KIND_KEY].type, "choice", "  └ 归类那道是单选");
    ok(/竞品官网/.test(qs[NEWS_KEY].instructions), "★任务要什么也告诉它★ 不知道这条任务图什么，判不出什么才算新");
    ok(/时间戳|措辞/.test(qs[NEWS_KEY].instructions), "  └ 明说了哪些不算新（时间戳、措辞这些）");
    ok(/拿不准就当有/.test(qs[NEWS_KEY].instructions), "★拿不准往「推」那边倒★ 漏一条真消息比多响一次铃贵");
    ok(Object.keys(qs[KIND_KEY].criteria || {}).length >= 4, "  └ 归类给够了选项", Object.keys(qs[KIND_KEY].criteria || {}));
    ok("说不清" in (qs[KIND_KEY].criteria || {}), "  └ 留了「说不清」：不逼它在四个都不像的里头硬挑一个");

    const norm = so.normalizeQuestions(qs);
    ok(norm && norm.questions && Object.keys(norm.questions).length === 2, "  └ 两道题过得了 systemone 那道校验（形状不对上游会 400）");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n③ 摆给它看的现场");
  // ─────────────────────────────────────────────────────────────
  {
    const st = newsState({ task: "看竞品更新日志", prev: "上次：v1.2 发布", text: "这次：v1.3 发布" });
    ok(/上一次/.test(st) && /这一次/.test(st), "★哪条是旧的哪条是新的，标死★ 标反了它连方向都判反");
    ok(st.indexOf("上次：v1.2") < st.indexOf("这次：v1.3"), "  └ 旧的在前新的在后，跟标签对得上");
    ok(/看竞品更新日志/.test(st), "  └ 这条任务要什么也在（判不出什么算新，就是因为不知道图什么）");

    const empty = newsState({});
    ok(/（没有）/.test(empty), "  └ 没有基线时明说「没有」，不是留一段空白让它猜");
    ok(/（空的）/.test(empty) && /（没记下来）/.test(empty), "  └ 空的那几段都说人话");

    const long = newsState({ task: "活".repeat(9999), prev: "旧".repeat(9999), text: "新".repeat(9999) });
    ok(long.length < 2000, "  └ 三段都有上限（别拿两份长报告去付 token）——这条写死数，拿被测常量当尺子等于没拦", long.length);
    ok(long.split("旧").length - 1 <= pg.TEXT_CHARS, "  └ 上一条也截，不只截这一条");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n④ 什么样的答案才配吞掉一条通知");
  // ─────────────────────────────────────────────────────────────
  {
    const no = readNews(out(ans(0.02), kind("换了说法")));
    ok(no && no.sure >= 0.9, "★说没有新东西、而且拿得准：不推★", no);
    eq(no.bar, NEWS_MIN, "  └ 用的是默认门槛");
    eq(no.label, "换了说法", "  └ 归类带出来，好把理由说人话");

    eq(readNews(out(ans(0.97), kind("数变了"))), null, "★它说有新东西：照推★ 这道闸只能少推，不能多推");
    eq(readNews(out(ans(0.5))), null, "  └ 正好五五开：照推");
    eq(readNews(out(ans(0.35))), null, "★六成把握不许吞通知★ 确定度 30%，离 0.7 差得远");
    eq(readNews(out({ key: NEWS_KEY, value: 0.02, sure: 0.69 })), null, "  └ 差一点点也是不到（0.69 < 0.7）");
    ok(readNews(out({ key: NEWS_KEY, value: 0.02, sure: 0.7 })), "  └ 正好到线：算数");
    eq(readNews(out(ans(0.02, 0.99)), 0.995), null, "  └ 门槛给得更严时听调用方的");
    eq(readNews(out({ key: NEWS_KEY, value: "没有新东西", sure: 0.99 })), null,
      "★答非所问也当没答上来★ 拿一句话跟 0.5 比大小比出来的东西没意义，却能凭空吞掉一条通知");
    eq(readNews(out({ key: "别的题", value: 0.01, sure: 0.99 })), null, "  └ 答的不是这道题：当没问过");
    eq(readNews(out()), null, "  └ 一个答案都没有：当没问过");
    eq(readNews({}), null, "  └ 形状不对也不炸");
    eq(readNews(out(ans(0.02), kind("出岔子"))), null,
      "★它自己说这次出岔子了，就别拿「没新东西」把它吞了★ 两道题打架时往推那边倒");
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑤ 没推的那条留痕");
  // ─────────────────────────────────────────────────────────────
  {
    const s1 = sameNote();
    ok(/没推/.test(s1), "★一字不差那条也要留痕★ 不留的话，「少发一条」和「它不跑了」长得一模一样");
    ok(!/确定度/.test(s1), "  └ 没花钱问就不写确定度（写了就是假的）");
    ok(/运行记录/.test(s1), "  └ 告诉人去哪儿看全文");

    const n = skipNote({ sure: 0.88, label: "换了说法" });
    ok(/没推/.test(n) && /88%/.test(n), "★说清为什么没推、有多确定★ 凭什么替我把铃摁掉，得让人看得见");
    ok(/时间|措辞/.test(n), "  └ 「换了说法」那一类说的是它自己的理由", n);
    const n2 = skipNote({ sure: 0.88, label: "说不清" });
    ok(n2 !== n && /没看过/.test(n2), "  └ 归类不同，理由跟着不同，不是一句万能话", n2);
    ok(/下一次/.test(n) && /一起推/.test(n), "★说清判错了也不会漏★ 这是用户敢开这个开关的唯一理由", n);
    ok(/运行记录/.test(n), "  └ 也告诉人去哪儿看全文");
    ok(skipNote().length > 0 && !/NaN|undefined/.test(skipNote()), "  └ 什么都不给也不吐 NaN", skipNote());
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑥ 接进调度器：真跑一遍");
  // ─────────────────────────────────────────────────────────────
  {
    function boot({ newsGate, doubtTimeoutMs, secondOpinion } = {}) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pushgate-"));
      const notes = [];
      const calls = [];
      let finalText = "";
      let stopped = "";
      const wrapped = newsGate && (async (item, args) => { calls.push({ item, args }); return newsGate(item, args); });
      const s = createScheduler({
        runtime: { runTask: async () => ({ finalText, stopped }) },
        storePath: path.join(dir, "schedules.json"),
        onResult: async (item, text) => notes.push(String(text == null ? "" : text)),
        newsGate: wrapped,
        secondOpinion,
        doubtTimeoutMs,
      });
      s.stop(); // 关掉定时器，这儿手动驱动
      const item = s.add({ name: "竞品日志", cron: "0 8 * * *", task: "每天看一眼竞品官网的更新日志" });
      const b = {
        s, item, notes, calls, dir,
        set: (t, st) => { finalText = t; stopped = st || ""; },
        run: async () => { try { await s.runOne(item.id, "手动"); } catch {} return s.runs(20)[0]; },
        base: () => (s.get(item.id) || {}).last_push,
      };
      return b;
    }
    const SAYS_NO = async () => ({ msg: skipNote({ sure: 0.9, label: "换了说法" }), sure: 0.9 });
    const SAYS_YES = async () => null;

    // A 跟上一次一字不差：不推、一分钱不花、运行记录上说清为什么
    {
      const b = boot({ newsGate: SAYS_NO });
      b.set("今天没有更新");
      await b.run();
      eq(b.notes.length, 1, "★第一次一定推★ 没有基线，不许吞");
      eq(b.calls.length, 0, "  └ 第一次也不花钱（没得比）");
      eq(b.base(), "今天没有更新", "★推出去的那条留了底★ 下一次拿它当基线");

      const r = await b.run(); // 同一句话再跑一遍
      eq(b.notes.length, 1, "★一字不差：这一声铃不响★");
      eq(b.calls.length, 0, "★白给的答案不花钱★ 已经确定的事不必买");
      ok(/没推/.test(r.push_skipped || ""), "  └ 运行记录上写明没推", (r.push_skipped || "").slice(0, 20));
      eq(r.push_sure, undefined, "  └ 没花钱问就不写确定度");
      eq(r.ok, true, "  └ 这一轮还是绿的（没推不是没跑）");
      eq(r.result, "今天没有更新", "★正文一个字不少照存★ 通知没响，运行记录就是唯一看得见它的地方");
    }

    // B 判「没有新东西」：不推，但花了一道题，留痕带确定度
    {
      const b = boot({ newsGate: SAYS_NO });
      b.set("今天没有更新（08:00 抓取，耗时 1.2 秒）");
      await b.run();
      b.set("今天没有更新（09:00 抓取，耗时 0.9 秒）");
      const r = await b.run();
      eq(b.notes.length, 1, "★判了没有新东西：不推★ 只有时间戳在动的那种");
      eq(b.calls.length, 1, "  └ 花了一道题");
      ok(/没推/.test(r.push_skipped || ""), "  └ 留痕");
      eq(r.push_sure, 0.9, "  └ 确定度也存下来（以后想调门槛，得先有历史数据）");
      eq(b.calls[0].args.prev, "今天没有更新（08:00 抓取，耗时 1.2 秒）", "★拿去比的是上一次推出去的那条★");
      eq(b.calls[0].args.text, "今天没有更新（09:00 抓取，耗时 0.9 秒）", "  └ 和这一轮刚跑出来的这条");
      eq(b.calls[0].item.id, b.item.id, "  └ 拿到的是任务本体（判断模型要看任务要什么）");
      eq(b.base(), "今天没有更新（08:00 抓取，耗时 1.2 秒）", "★没推就不换底★ 换了的话攒下的变化会跟着这次判断一起沉掉");
    }

    // C 判「有新东西」：照推，并且换底
    {
      const b = boot({ newsGate: SAYS_YES });
      b.set("v1.2 已发布");
      await b.run();
      b.set("v1.3 已发布，新增导出功能");
      const r = await b.run();
      eq(b.notes.length, 2, "★它说有新东西：照推★");
      eq(r.push_skipped, undefined, "  └ 不留空字段（前端拿这个字段判有没有）");
      eq(b.base(), "v1.3 已发布，新增导出功能", "  └ 推出去了才换底");
    }

    // D 红的：一道题都不花，照推
    {
      const b = boot({ newsGate: SAYS_NO });
      b.set("今天没有更新");
      await b.run();
      b.set("今天没有更新", "撞上限");
      const r = await b.run();
      eq(r.ok, false, "  └ 该红还是红");
      eq(b.calls.length, 0, "★红的一次都不问★ 已经定性的失败，问了也不许拦");
      eq(b.notes.length, 2, "★坏消息一律照推★ 哪怕跟上次一字不差");
      eq(b.base(), b.notes[1], "★红的那条也留了底★ 不留的话，等它真恢复了，拿几天前那条绿的一比＝「没变化」，「终于好了」反倒成了唯一被吞掉的消息");
    }

    // E 挂了疑问的那条：照推
    {
      const LONG = "已经开始处理这条任务。我先读了任务描述，然后想了几种做法，中间试了三次都没跑通" + "。".repeat(500);
      const b = boot({ newsGate: SAYS_NO, secondOpinion: async () => ({ msg: "这条你自己看一眼", sure: 0.86 }) });
      b.set(LONG);
      await b.run();
      const r = await b.run(); // 一字不差的第二轮
      ok(/自己看一眼/.test(r.doubt || ""), "  └ 第二意见照挂（前提：这一条确实挂上了疑问）");
      eq(r.push_skipped, undefined, "★挂了疑问的一律照推★ 那正是最该到人眼前的一条");
      eq(b.notes.length, 2, "  └ 铃响了");
      eq(b.calls.length, 0, "  └ 也不必花这道题的钱");
    }

    // F 压根没注入（开关没开 / 老部署 / 纯 CLI）：行为跟今天一模一样
    {
      const b = boot({});
      b.set("今天没有更新");
      await b.run();
      await b.run();
      await b.run();
      eq(b.notes.length, 3, "★没接这道闸：一切照旧★ 这是默认形态，不是异常分支");
      eq(b.s.runs(20)[0].push_skipped, undefined, "  └ 不留空字段");
    }

    // G 问不成：照推 + 留痕
    {
      const b = boot({ newsGate: async () => { throw new Error("额度用完了"); } });
      b.set("今天没有更新（08:00）");
      await b.run();
      b.set("今天没有更新（09:00）");
      const r = await b.run();
      eq(b.notes.length, 2, "★闸自己坏了不能把通知吞了★ 退回老行为：照推");
      ok(/额度用完了/.test(r.push_gate_failed || ""), "  └ 死因原话留在运行记录上", r.push_gate_failed);
      eq(r.push_skipped, undefined, "  └ 没推的痕迹不许留（它是推了的）");
      eq(b.base(), "今天没有更新（09:00）", "  └ 推出去了就换底");
    }

    // H ★全套设计里最要紧的一条★：基线是「真推出去的那条」，所以误判不会把变化吞掉
    {
      let verdict = SAYS_NO;
      const b = boot({ newsGate: async (i, a) => verdict(i, a) });
      b.set("A 版：3 条更新");
      await b.run();                      // 第一轮：推，底 = A
      b.set("B 版：4 条更新");
      await b.run();                      // 第二轮：被（误）判成没变化，不推
      eq(b.notes.length, 1, "  └ 第二轮被判没变化，没推（假设它判错了）");
      eq(b.base(), "A 版：3 条更新", "★没推的那一轮不换底★");
      verdict = SAYS_YES;
      b.set("C 版：5 条更新");
      const r = await b.run();            // 第三轮：拿 A 比，不是拿 B 比
      eq(b.calls[b.calls.length - 1].args.prev, "A 版：3 条更新",
        "★第三轮拿去比的还是 A★ 拿 B 比的话，B→C 之间那点差别会让整段变化一起沉掉");
      eq(b.notes.length, 2, "  └ 推出去了");
      eq(r.push_skipped, undefined, "  └ 这一条没被吞");
      eq(b.base(), "C 版：5 条更新", "  └ 换成了刚推出去的那条");
    }

    // I 超时：不许把任务卡死在这一问上
    {
      const b = boot({ newsGate: () => new Promise(() => {}), doubtTimeoutMs: 60 });
      b.set("今天没有更新（08:00）");
      await b.run();
      b.set("今天没有更新（09:00）");
      const t0 = Date.now();
      const r = await b.run();
      const spent = Date.now() - t0;
      ok(spent < 5000, "★上游挂死也得有个头★ 卡住的话这条任务不是红了，是从此再也不跑了", spent);
      eq(b.notes.length, 2, "  └ 照推");
      ok(/超时/.test(r.push_gate_failed || ""), "  └ 超时也留痕", r.push_gate_failed);
      ok(/变没变化/.test(r.push_gate_failed || ""), "  └ 留的痕说得清是哪一问超时（跟第二意见那一问分得开）", r.push_gate_failed);
    }

  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑦ 出错那条路也得换底");
  // ─────────────────────────────────────────────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pushgate-err-"));
    const notes = [];
    const asked = [];
    let boom = true;
    const s = createScheduler({
      runtime: { runTask: async () => { if (boom) throw new Error("连不上上游"); return { finalText: "今天没有更新", stopped: "" }; } },
      storePath: path.join(dir, "schedules.json"),
      onResult: async (item, text) => notes.push(String(text || "")),
      newsGate: async (i, a) => { asked.push(a); return null; }, // 它说有新东西
    });
    s.stop();
    const item = s.add({ name: "抓日志", cron: "0 8 * * *", task: "看日志" });
    try { await s.runOne(item.id, "手动"); } catch {}
    eq(notes.length, 1, "★抛异常那条路照推★");
    ok(/连不上上游/.test((s.get(item.id) || {}).last_push || ""), "  └ 出错那条也留了底：下一轮「恢复了」才算得出是新消息", (s.get(item.id) || {}).last_push);
    boom = false;
    try { await s.runOne(item.id, "手动"); } catch {}
    eq(notes.length, 2, "★从错误里恢复了是新消息★ 推了");
    ok(/连不上上游/.test((asked[0] || {}).prev || ""),
      "  └ 拿去比的底就是上一轮那条错误（所以「恢复了」算得出是新消息）", (asked[0] || {}).prev);
  }

  // ─────────────────────────────────────────────────────────────
  console.log("\n⑧ 摆出来了没有（开关存在但找不到＝没有）");
  // ─────────────────────────────────────────────────────────────
  {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
    const ui = read("public/js/app-05.js");
    ok(/id="ag-pgate"/.test(ui), "★设置里摆得出来★ 只活在配置文件里的开关＝没有这个开关");
    ok(/push_gate:\s*pane\.querySelector\("#ag-pgate"\)\.checked/.test(ui), "  └ 勾了存得回去");
    ok(/s\.agent\.push_gate \? "checked"/.test(ui), "  └ 存过之后回来还勾着（写了但从来没渲染是另一种坏）");
    const iSecond = ui.indexOf('id="ag-second"');
    const iPush = ui.indexOf('id="ag-pgate"');
    ok(iSecond > 0 && iPush > iSecond && iPush - iSecond < 2000, "★就近★ 跟另外那道定时任务的闸摆在一块儿", { iSecond, iPush });
    ok(/两万分之一美金/.test(ui.slice(iSecond, iPush + 400)), "  └ 说清楚它花钱");
    ok(/定时任务没变化就不推/.test(ui), "  └ 找得到那一行的标题");
    ok(/"定时任务没变化就不推":/.test(read("public/js/i18n.js")), "  └ 标题有英文（这个产品是双语的，漏一条就半中半英）");

    // 这儿刻意不 grep。源码里出现过 `r.push_skipped` 这几个字，证明不了它被印了出来；
    // 把运行记录那一格的渲染函数从真源码里抠出来跑一遍，看它到底吐不吐得出那句话。
    const runs = read("public/js/app-03.js");
    const at = runs.indexOf("const runCell = (r) => {");
    ok(at > 0, "找得到运行记录那一格的渲染函数", at);
    const tail = runs.slice(at);
    const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const cell = new Function("esc", "escInline",
      `const bold = escInline; ${tail.slice(0, tail.indexOf("\n  };"))}\n  }; return runCell;`)(esc, esc);

    const cSkip = cell({ result: "今天没有更新", push_skipped: "没推：跟上一次一字不差。" });
    ok(/没推/.test(cSkip), "★运行记录里真印得出来★ 铃没响，这儿是唯一能看见它跑过的地方", cSkip.slice(0, 60));
    ok(/今天没有更新/.test(cSkip), "  └ 正文还在前头，「没推」是加注不是替换");
    const cFail = cell({ result: "今天没有更新", push_gate_failed: "额度用完了" });
    ok(/额度用完了/.test(cFail) && /没问成/.test(cFail),
      "★没问成也露脸★ 这条链哪天整个失灵，表现就是「再也没有没推的」——不印就永远看不出来", cFail.slice(0, 60));
    ok(!/at-hint/.test(cell({ result: "今天没有更新" })), "  └ 正常推出去的那条干干净净，不挂空壳");
    ok(!/\$\{r\.push_skipped/.test(runs), "  └ 转义之后才印（判断模型写的字不许直接进 HTML）");

    const srv = read("server.js");
    ok(/if \(b\.agent\.push_gate !== undefined\) config\.agent\.push_gate = !!b\.agent\.push_gate;/.test(srv), "  └ 后端收得下这个开关");
    ok(/push_gate: !!config\.agent\.push_gate/.test(srv), "  └ 也读得出来（存了读不回等于没存）");
    ok(/if \(!\(config\.agent \|\| \{\}\)\.push_gate\) return null;/.test(srv), "★开关没开就不发请求★ 默认那条路一分钱不花");
    ok(/newsGate,/.test(srv), "  └ 真插到调度器上了");

    const cfg = JSON.parse(read("config.example.json"));
    eq((cfg.agent || {}).push_gate, false, "★配置模板里默认关着★ 它会少响一声铃，而少响的那声用户看不见，得他自己点头");
    ok(/判断模型/.test((cfg.agent || {})["_push_gate_说明"] || ""), "  └ 模板里写清楚它是干什么的（手改配置的人只看得到这一行）");
    ok(/上一次真推出去的那条/.test((cfg.agent || {})["_push_gate_说明"] || ""), "  └ 也写清楚判错了不会漏");
  }

  finished = true;
  console.log(`\n${fail ? "✗ 挂了" : "全部通过"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
