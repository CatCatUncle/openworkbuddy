// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 同时跑几个任务（src/core/automation/run-governor.js）。
 * 跑法：node test/run-governor.js
 * 用户原话：「不要占用太多整个电脑的内存，还有保证任务的执行效果」。
 * 所以这里最要紧的不是限得住，是**限了之后任务还完整**：不杀、不丢、不把排队时间算进任务时限、永远不卡死。
 */
const { mod } = require("./lib/mod");
const g = require(mod("run-governor"));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GB = 1024 ** 3;
const task = (log, name, ms = 30) => async () => { log.push("开始 " + name); await sleep(ms); log.push("结束 " + name); return name; };

(async () => {
  g._setMemoryProbe(async () => false);

  console.log("【1】分档");
  ok(g.autoTasks(8 * GB) === 3 && g.autoTasks(16 * GB) === 5 && g.autoTasks(32 * GB) === 8 && g.autoTasks(64 * GB) === 12, "任务上限按内存分档");
  ok(g.autoHeavy(8 * GB) === 1 && g.autoHeavy(16 * GB) === 2 && g.autoHeavy(32 * GB) === 3, "重活比任务紧得多");

  console.log("【2】满了排队，全部跑完");
  g.configure({ agent: { max_parallel_tasks: 2 } });
  {
    const log = [], notes = [];
    const emit = (e) => notes.push(e.text);
    const rs = await Promise.all(["甲", "乙", "丙", "丁"].map((n) => g.admit({ emit }, task(log, n))));
    ok(rs.join() === "甲,乙,丙,丁", "★四个都跑完了★ 只排队不杀，结果一个不少");
    ok(log.indexOf("开始 丙") > log.indexOf("结束 甲") || log.indexOf("开始 丙") > log.indexOf("结束 乙"), "第三个等有人跑完才开始");
    ok(notes.some((t) => /排在第 1 位/.test(t)) && notes.some((t) => /轮到了/.test(t)), "排队和轮到都告诉用户");
    ok(g.stats().tasks.running === 0 && g.stats().tasks.waiting === 0, "名额全还回来了");
  }

  console.log("【3】排队不算任务时间");
  {
    g.configure({ agent: { max_parallel_tasks: 1 } });
    let startedAt = 0;
    const t0 = Date.now();
    await Promise.all([
      g.admit({}, async () => { await sleep(120); }),
      g.admit({}, async () => { startedAt = Date.now(); }),
    ]);
    ok(startedAt - t0 >= 100, "★拿到名额才进 runTask★ 时限在 runTask 里算，等得再久也不会一开跑就超时");
  }

  console.log("【4】出错也还名额");
  {
    g.configure({ agent: { max_parallel_tasks: 1 } });
    let threw = false;
    try { await g.admit({}, async () => { throw new Error("崩了"); }); } catch { threw = true; }
    ok(threw, "错误原样抛给调用方");
    ok((await g.admit({}, async () => "后面的")) === "后面的", "★崩了的不占着名额★ 后面的照跑");
  }

  console.log("【5】停止能从队里抽身");
  {
    g.configure({ agent: { max_parallel_tasks: 1 } });
    const ctrl = new AbortController();
    let ran = false;
    const first = g.admit({}, () => sleep(120));
    const queued = g.admit({ stopSignal: ctrl.signal }, async () => { ran = true; return "收尾"; });
    await sleep(20);
    ok(g.stats().tasks.waiting === 1, "第二个在排队");
    ctrl.abort();
    ok((await queued) === "收尾" && ran, "★点停止当场出队★ 交给 runTask 按自己的规矩收尾，不用等前面跑完");
    ok(g.stats().tasks.waiting === 0, "队里没留下它");
    await first;
  }

  console.log("【6】子智能体不占名额");
  {
    g.configure({ agent: { max_parallel_tasks: 1 } });
    const r = await g.admit({}, async () => g.admit({ depth: 1 }, async () => "子任务完成"));
    ok(r === "子任务完成", "★父任务占着名额时子任务照跑★ 否则就是自己等自己，永远卡死");
  }

  console.log("【7】内存紧：拖着，但不卡死");
  {
    g.configure({ agent: { max_parallel_tasks: 5 } });
    g._setMemoryProbe(async () => true);
    const alone = await Promise.race([g.admit({}, async () => "跑了"), sleep(300).then(() => "卡住")]);
    ok(alone === "跑了", "★一个都没在跑就放行★ 内存紧也不能一个任务都不跑");
    let second = false;
    const first = g.admit({}, () => sleep(150));
    const next = g.admit({}, async () => { second = true; });
    await sleep(60);
    ok(!second, "有任务在跑时，内存紧就先不开新的");
    await first; await next;
    ok(second, "前面跑完了就轮到它");
    g._setMemoryProbe(async () => false);
  }

  console.log("【8】一个人占不满全部名额");
  {
    const pool = g.createPool({ limit: () => 2, perOwner: () => 1 });
    const a1 = await pool.acquire({ owner: "a" });
    const order = [];
    const a2 = pool.acquire({ owner: "a" }).then((s) => { order.push("a2"); return s; });
    const b1 = pool.acquire({ owner: "b" }).then((s) => { order.push("b1"); return s; });
    const sb = await b1;
    ok(order[0] === "b1", "★a 排在前面但已占满自己那份，b 先走★");
    a1.release();
    (await a2).release(); sb.release();
  }

  console.log("【9】重活");
  {
    const pool = g.createPool({ limit: () => 1 });
    const s1 = await pool.acquire({});
    let got = false;
    pool.acquire({}).then((s) => { got = true; s.release(); });
    await sleep(20);
    ok(!got, "一件在做，下一件等");
    s1.release();
    await sleep(20);
    ok(got, "做完轮到下一件");
    for (const t of ["html_to_image", "check_page", "render_motion", "compose_video", "record_web_demo"]) ok(g.HEAVY_TOOLS.has(t), `${t} 算重活`);
    ok(!g.HEAVY_TOOLS.has("read_file"), "读文件不算");
  }

  console.log(`\n任务名额：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
