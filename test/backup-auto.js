// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 定时自动备份（backup-auto.js）。
 *
 * 盯五件事，每件配反向对照：
 *   ① 默认关：没配、配了个怪值，一份都不打。
 *   ② 到点才打：离上一份自动备份不满一个周期不打；手点的备份不算数（不然手点一次就把自动的推迟一天）。
 *   ③ 只清自己的：超过 KEEP 份只删最老的自动备份，手动的、导入的、恢复前留底的一份不碰。
 *   ④ 恢复中不打、同时只跑一份。
 *   ⑤ 失败留痕：make 抛错要进审计、lastError 带着原话，而且不能删任何旧备份。
 *
 * 不起服务、不碰磁盘：list/make/remove 全是注入的假货。
 */
const path = require("path");
const { mod } = require("./lib/mod");
const ROOT = path.join(__dirname, "..");
const { createAutoBackup, normalizeDays, isDue, toPrune, isAuto, KEEP } = require(mod("backup-auto"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 600) : "")); }
};
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), msg, { got, want });

const H = 3600000, D = 24 * H;
const NOW = Date.parse("2026-09-27T12:00:00Z");
const bk = (name, ago) => ({ name, size: 1, at: new Date(NOW - ago).toISOString() });
const autoName = (i) => `openworkbuddy-backup-2026092${i}-000000-auto.tar.gz`;

/** 一套假磁盘：list 按时间倒序，make 往里塞一份新的 */
function fakeDisk(initial, opts = {}) {
  const files = initial.slice();
  const audits = [];
  let clock = NOW;
  const deps = {
    everyDays: () => opts.days,
    list: () => files.slice().sort((a, b) => b.at.localeCompare(a.at)),
    make: async (tag) => {
      if (opts.makeFails) throw new Error(opts.makeFails);
      const name = `openworkbuddy-backup-new${files.length}-${tag}.tar.gz`;
      files.push({ name, size: 1, at: new Date(clock).toISOString() });
      return name;
    },
    remove: (name) => {
      if (opts.removeFails) throw new Error(opts.removeFails);
      const i = files.findIndex((f) => f.name === name);
      if (i >= 0) files.splice(i, 1);
    },
    busy: () => !!opts.busy,
    audit: (msg, verdict) => audits.push({ msg, verdict }),
  };
  return { files, audits, deps, setClock: (t) => { clock = t; } };
}

(async () => {
  console.log("① 默认关");
  eq([undefined, null, "", "3", 2, -1, "abc", 1.5].map(normalizeDays), [0, 0, 0, 0, 0, 0, 0, 0], "没配或怪值一律当关");
  eq([0, 1, 7, "1", "7"].map(normalizeDays), [0, 1, 7, 1, 7], "0/1/7（含字符串）照收");
  {
    const d = fakeDisk([], { days: undefined });
    const r = await createAutoBackup(d.deps).tick(NOW);
    eq(r, { skipped: "off" }, "没配周期：不打");
    eq(d.files.length, 0, "没配周期：磁盘上一份都没多");
    // 反向对照：同一套假磁盘开了每天，就该打
    const d2 = fakeDisk([], { days: 1 });
    const r2 = await createAutoBackup(d2.deps).tick(NOW);
    ok(r2.made && isAuto(r2.made), "反向对照：开了每天、一份都没有 → 当场打一份", r2);
  }

  console.log("② 到点才打");
  ok(!isDue([bk(autoName(1), 10 * H)], 1, NOW), "上一份自动备份 10 小时前：每天档不打");
  ok(isDue([bk(autoName(1), 24 * H)], 1, NOW), "反向对照：整 24 小时前：该打了");
  ok(isDue([bk(autoName(1), 23.5 * H)], 1, NOW), "23.5 小时前也打（每小时醒一次，卡死 24 小时会一天天往后漂）");
  ok(!isDue([bk(autoName(1), 3 * D)], 7, NOW), "每周档：3 天前那份还算新");
  ok(isDue([bk(autoName(1), 7 * D)], 7, NOW), "反向对照：每周档 7 天前：该打了");
  ok(isDue([bk("openworkbuddy-backup-20260927-110000.tar.gz", 1 * H)], 1, NOW),
    "一小时前手点了一份，自动的照样打——手动的不算进周期");
  ok(!isDue([bk(autoName(1), 1 * H)], 0, NOW) && !isDue([], 0, NOW), "关着的时候，没有任何备份也不打");

  console.log("③ 只清自己的");
  const manual = [
    bk("openworkbuddy-backup-20260101-000000.tar.gz", 300 * D),
    bk("openworkbuddy-backup-20260102-000000-imported.tar.gz", 299 * D),
    bk("openworkbuddy-backup-20260103-000000-before-restore.tar.gz", 298 * D),
  ];
  const autos = Array.from({ length: KEEP + 3 }, (_, i) => bk(`openworkbuddy-backup-2026-${String(i).padStart(2, "0")}-auto.tar.gz`, (i + 1) * D));
  const pruned = toPrune([...manual, ...autos]);
  eq(pruned.length, 3, `${KEEP + 3} 份自动的留 ${KEEP} 份，删 3 份`);
  ok(pruned.every(isAuto), "要删的全是自动备份", pruned);
  eq(pruned.sort(), autos.slice(KEEP).map((b) => b.name).sort(), "删的是最老的那 3 份");
  ok(!manual.some((m) => pruned.includes(m.name)), "手动、导入、恢复前留底的，一份都不在删除名单里");
  ok(!isAuto("openworkbuddy-backup-20260101-000000-before-restore.tar.gz") && !isAuto("openworkbuddy-backup-auto-x.tar.gz"),
    "只认结尾的 -auto：名字中间带 auto 的不算");
  {
    // 端到端走一次 tick：磁盘上已有 KEEP 份自动的（最近那份也过期了）+ 手动的
    const d = fakeDisk([...manual, ...autos.slice(0, KEEP)], { days: 1 });
    const r = await createAutoBackup(d.deps).tick(NOW);
    ok(r.made, "过期了就打一份", r);
    eq(d.files.filter((f) => isAuto(f.name)).length, KEEP, `打完还是 ${KEEP} 份自动的`);
    ok(manual.every((m) => d.files.some((f) => f.name === m.name)), "手动的原样都在");
    ok(d.files.some((f) => f.name === r.made), "刚打的那份没被自己清掉");
    ok(d.audits.some((a) => a.verdict === "放行" && a.msg.includes(r.made) && a.msg.includes("1 份")), "审计里记了打了哪份、清了几份", d.audits);
  }

  console.log("④ 恢复中不打、同时只跑一份");
  {
    const d = fakeDisk([], { days: 1, busy: true });
    eq(await createAutoBackup(d.deps).tick(NOW), { skipped: "busy" }, "正在恢复：跳过");
    eq(d.files.length, 0, "正在恢复：一份没打");
  }
  {
    const d = fakeDisk([], { days: 1 });
    let release;
    const gate = new Promise((r) => { release = r; });
    const make = d.deps.make;
    d.deps.make = async (tag) => { await gate; return make(tag); };
    const a = createAutoBackup(d.deps);
    const first = a.tick(NOW);
    ok(a.isRunning(), "第一份在打的时候 isRunning() 为真（恢复接口靠它回 409）");
    eq(await a.tick(NOW), { skipped: "running" }, "第一份还没打完，第二次 tick 直接跳过");
    release();
    await first;
    ok(!a.isRunning(), "打完了 isRunning() 回到假");
    eq(d.files.length, 1, "最后磁盘上只多了一份");
  }

  console.log("⑤ 失败留痕");
  {
    const d = fakeDisk(autos.slice(), { days: 1, makeFails: "磁盘满了" });
    const a = createAutoBackup(d.deps);
    const warn = console.warn; console.warn = () => {};
    const r = await a.tick(NOW);
    console.warn = warn;
    eq(r, { error: "磁盘满了" }, "make 抛错 → 返回原话");
    eq(a.lastError(), "磁盘满了", "lastError 带着原话（设置页照着显示）");
    ok(d.audits.some((x) => x.verdict === "失败" && x.msg.includes("磁盘满了")), "审计里记了失败", d.audits);
    eq(d.files.length, autos.length, "新的没打成，旧的一份都没删");
    ok(!a.isRunning(), "失败后 running 标记放开了，下次还能打");
  }
  {
    // 失败之后一次成功，lastError 要清空——不然设置页一直挂着一条过期的红字
    const d = fakeDisk([], { days: 1, makeFails: "x" });
    const a = createAutoBackup(d.deps);
    const warn = console.warn; console.warn = () => {};
    await a.tick(NOW);
    console.warn = warn;
    d.deps.make = fakeDisk([], {}).deps.make;
    await a.tick(NOW);
    eq(a.lastError(), "", "后来成功了，旧的失败原因清掉");
  }
  {
    const d = fakeDisk(autos.slice(), { days: 1, removeFails: "没权限" });
    const r = await createAutoBackup(d.deps).tick(NOW);
    ok(r.made && r.pruned.length === 0, "删旧的失败不影响新的那份算成功", r);
    ok(d.audits.some((x) => x.verdict === "失败" && x.msg.includes("没权限")), "删不掉的每一份都进审计");
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
