// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 工作区清单（src/domains/library/ws-index.js）：走树挪到后台线程、过期先给旧的。
 *
 * 跑法：node test/ws-index.js
 * 这几条都是真出过事或者改错就看不出来的：
 *   · 走树在主线程上：两万文件时点一下页签 200~750ms，所有对话的流式输出跟着停；
 *   · 「先给旧的」做过头：删掉的文件被旧清单再画回来，用户以为没删成。
 * ★反向对照★：同一份断言套在主线程版上必须红，证明这条测试量得出差别。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wsIndex = require(mod("ws-index"));
const wsBrowse = require(mod("ws-browse"));

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owb-wsi-")));
const put = (n) => { fs.mkdirSync(path.dirname(path.join(root, n)), { recursive: true }); fs.writeFileSync(path.join(root, n), "x"); };
const has = (w, n) => w.files.some((f) => f.name === n);

/** 走树期间主线程最长停了多久 */
async function stall(fn) {
  let worst = 0, last = performance.now(), run = true;
  const tick = () => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; if (run) setImmediate(tick); };
  setImmediate(tick);
  await fn();
  run = false;
  await sleep(0);
  return worst;
}

(async () => {
  console.log("【1】基本行为");
  put("a.md"); put("sub/b.md");
  const w1 = await wsIndex.walk(root);
  ok(has(w1, "a.md") && has(w1, "sub/b.md"), "冷启动：等到完整清单");
  ok(Object.isFrozen(w1) && Object.isFrozen(w1.files), "回来的是冻住的：几条请求共用，谁也别原地改");
  ok((await wsIndex.walk(root)) === w1, "三秒内是同一份，不重走");
  const d = wsIndex.derive(w1);
  ok(d.byName.get("a.md") && wsIndex.derive(w1) === d, "查找表一份清单只算一次");

  console.log("【2】增删之后不许把旧的画回来");
  fs.rmSync(path.join(root, "a.md"));
  wsIndex.clear();
  ok(!has(await wsIndex.walk(root), "a.md"), "★clear 之后一定等新结果★ 删掉的文件不再出现");

  console.log("【3】clear 之前发出去的那趟写不回来");
  put("c.md");
  wsIndex.clear();
  const racing = wsIndex.walk(root); // 这趟已经在路上
  fs.rmSync(path.join(root, "c.md"));
  wsIndex.clear(); // 用户此时删了文件
  await racing.catch(() => {});
  ok(!has(await wsIndex.walk(root), "c.md"), "★晚到的旧结果不进缓存★");

  console.log("【4】过期了不让人干等");
  const big = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owb-wsi-big-")));
  for (let i = 0; i < 60; i++) { const d2 = path.join(big, "d" + i); fs.mkdirSync(d2); for (let k = 0; k < 150; k++) fs.writeFileSync(path.join(d2, k + ".txt"), "x"); }
  const first = await wsIndex.walk(big);
  ok(first.files.length === 9000, "九千个文件的清单");
  wsIndex.touch();
  const t0 = performance.now();
  const w = await wsIndex.walk(big);
  const ms = performance.now() - t0;
  ok(ms < wsIndex.SETTLE_MS + 120, `过期后最多等 ${wsIndex.SETTLE_MS}ms 就有东西（这次 ${Math.round(ms)}ms）`);
  ok(w.files.length === 9000, "拿到的是能用的清单");
  await sleep(600);

  console.log("【5】不堵主线程");
  wsIndex.clear();
  const off = await stall(() => wsIndex.walk(big));
  const on = await stall(async () => { wsBrowse.walkAll(big); });
  ok(off < on, `后台线程最长停 ${off.toFixed(0)}ms，比主线程走（${on.toFixed(0)}ms）短`);
  ok(on > 15, `★反向对照★ 主线程走确实停得出来（${on.toFixed(0)}ms），这把尺子量得到差别`);

  console.log("【6】线程挂了清单照样读得出");
  const st = wsIndex._state();
  ok(st.worker === true, "线程在");
  wsIndex._reset();
  ok(wsIndex._state().worker === false, "收得掉，不留着占内存");
  const again = await wsIndex.walk(root);
  ok(has(again, "sub/b.md"), "收掉之后再要，重新起一个");

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(big, { recursive: true, force: true });
  wsIndex._reset();
  console.log(`\n工作区清单：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
