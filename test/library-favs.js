// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 资料库收藏（lib-favs.js + src/server/routes/library.js 的 /api/library/favorite(s)）和资料库列表上顺带多出来的字段：
 *
 *   ① 收藏 / 取消：来回点，状态对；取消一个本来没收藏的不写盘；重复收藏不改「收藏于」
 *   ② 20 下并发：20 个不同文件一起收藏一条不丢；同一个文件连点 20 下，最后的状态就是最后那一下
 *   ③ 文件坏了：原样改名成 .bad-<毫秒> 留着，按没有收藏往下走，下一次收藏照常写出一份好的
 *   ④ 文件没了：清单里不抹掉，列出来标 missing
 *   ⑤ 两个账号互相看不见；收藏文件本身不会出现在资料库列表里、也不能被当成资料读
 *   ⑥ /api/library、/api/library/outputs 的文件行带 fav、mtime、size；outputs 的「未归属」能按 orphan_offset 翻页
 *   ⑦ 同目录有 deck.json 的网页标 deck:true
 *
 * 为什么较这个真：收藏是用户手点出来的，丢一条他会记得。20 下并发不是瞎编的数——一屏卡片连点星标，
 * 前端是一下一个请求、不等上一个回来；读-改-写不排队的话，最后落盘的那份只认得它自己读到的旧清单。
 *
 * 真起一份 server.js（临时 HOME、随机端口），不联网、不花钱、不起 Electron。
 *   node test/library-favs.js
 */
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");
const HOME = require("./lib/own-home")("library-favs");

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const favs = require(mod("lib-favs"));
const store = require(mod("store"));

let pass = 0, fail = 0, finished = false;
const keepAlive = setInterval(() => {}, 1 << 30);
/** @type {import("child_process").ChildProcess | null} */
let serverChild = null;
process.on("exit", (code) => {
  try { if (serverChild && serverChild.exitCode === null) serverChild.kill("SIGKILL"); } catch {}
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 400) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
function sameSet(got, want, name) {
  const a = [...got].sort(), b = [...want].sort();
  ok(a.length === b.length && a.every((x, i) => x === b[i]), name, { got: a, want: b });
}
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 4).join(" | ")}`); }
}

const U = path.join(HOME, "unit");
let seq = 0;
const fresh = (tag) => { const d = path.join(U, `${tag}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
function put(root, rel, body = "x") {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return f;
}
const favFile = (root) => path.join(root, favs.FAV_FILE);
const badsOf = (root) => fs.readdirSync(root).filter((n) => n.startsWith(favs.FAV_FILE + ".bad-"));
const rawItems = (root) => JSON.parse(fs.readFileSync(favFile(root), "utf8")).items;
/** 静音一段 console.error（坏文件那几段会故意打出「读不出来」），顺带把打了什么收回来 */
async function quietErrors(fn) {
  const orig = console.error;
  /** @type {string[]} */
  const said = [];
  console.error = (...a) => { said.push(a.join(" ")); };
  try { return { value: await fn(), said }; } finally { console.error = orig; }
}

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 单元：lib-favs.js
  // ---------------------------------------------------------------------------------------------
  await section("① 收藏 / 取消", async () => {
    const root = fresh("one");
    eq(await favs.setFav(root, { src: "lib", path: "报告/周报.md", on: true, now: 1000 }), true, "收藏：回 true");
    ok(fs.existsSync(favFile(root)), "收藏文件落在资料库根里（.favorites.json）");
    ok(favs.favKeys(root).has("lib:报告/周报.md"), "favKeys 里有它");
    eq(await favs.setFav(root, { src: "lib", path: "报告/周报.md", on: false }), false, "取消：回 false");
    ok(!favs.favKeys(root).has("lib:报告/周报.md"), "取消后 favKeys 里没它了");
    eq(Object.keys(rawItems(root)).length, 0, "盘上那份也空了");

    // 取消一个本来就没收藏的：不写盘
    const empty = fresh("noop");
    eq(await favs.setFav(empty, { src: "lib", path: "从没收藏过.md", on: false }), false, "取消一个没收藏的：回 false");
    ok(!fs.existsSync(favFile(empty)), "取消一个没收藏的：连文件都没建");
    // ★反向对照★ 同一个根上收藏一下，文件就有了（上一条的「没建」不是因为这个根写不进去）
    await favs.setFav(empty, { src: "lib", path: "从没收藏过.md", on: true });
    ok(fs.existsSync(favFile(empty)), "★反向对照★ 同一个根上收藏一下，文件就建出来了");

    // 重复收藏不改「收藏于」
    const r2 = fresh("again");
    await favs.setFav(r2, { src: "ws", path: "产出/a.md", on: true, now: 1000 });
    await favs.setFav(r2, { src: "ws", path: "产出/a.md", on: true, now: 2000 });
    eq(rawItems(r2)["ws:产出/a.md"].at, 1000, "同一个再点一次收藏：收藏于还是第一次那个时刻");
    // ★反向对照★ 取消后再收藏：算新收藏
    await favs.setFav(r2, { src: "ws", path: "产出/a.md", on: false });
    await favs.setFav(r2, { src: "ws", path: "产出/a.md", on: true, now: 3000 });
    eq(rawItems(r2)["ws:产出/a.md"].at, 3000, "★反向对照★ 取消了再收藏：收藏于换成新的时刻");

    // 键的规整：反斜杠、./、首尾斜杠都认成同一条
    await favs.setFav(r2, { src: "lib", path: "\\资料\\.\\合同.pdf/", on: true, now: 4000 });
    ok(favs.favKeys(r2).has("lib:资料/合同.pdf"), "反斜杠、./、尾斜杠规整成同一个键");
    // lib 和 ws 同名不串
    ok(!favs.favKeys(r2).has("ws:资料/合同.pdf"), "★反向对照★ 同一个路径换个 src 是另一条");
  });

  await section("① 不合法的路径：拒，一个字节都不写", async () => {
    const root = fresh("bad-key");
    for (const [src, p, why] of [["lib", "../外面.md", "带 .."], ["lib", "a/../../b", "中间带 .."], ["xx", "a.md", "src 不认识"], ["lib", "", "空路径"], ["lib", "a\u0001b", "控制字符"]]) {
      let err = null;
      try { await favs.setFav(root, { src, path: p, on: true }); } catch (e) { err = e; }
      ok(err && err.status === 400, `${why}：拒，状态 400`, err && err.message);
    }
    ok(!fs.existsSync(favFile(root)), "一条都没写进去（文件都没建）");
    // ★反向对照★ 同一个根、合法路径：收得进去；前面那几下出错没把这个根的队堵死
    eq(await favs.setFav(root, { src: "lib", path: "a.md", on: true }), true, "★反向对照★ 合法路径照收，前面的错没堵住后面");
    eq(favs.favKey("lib", "a/b.md"), "lib:a/b.md", "★反向对照★ favKey 认合法的");
  });

  await section("① 原子写：先写临时名再改名，写完不留临时文件", async () => {
    const root = fresh("atomic");
    const origRename = fs.renameSync;
    /** @type {[string, string][]} */
    const renames = [];
    fs.renameSync = (a, b) => { renames.push([String(a), String(b)]); return origRename(a, b); };
    try {
      await favs.setFav(root, { src: "lib", path: "a.md", on: true });
      await favs.setFav(root, { src: "lib", path: "b.md", on: true });
      const onto = renames.filter(([, b]) => b === favFile(root));
      eq(onto.length, 2, "两次收藏：两次改名落到 .favorites.json 上");
      ok(onto.every(([a]) => a !== favFile(root) && path.dirname(a) === root), "改名的来源是同目录下的临时文件", onto);
      renames.length = 0;
      await favs.setFav(root, { src: "lib", path: "没收藏的.md", on: false });
      eq(renames.length, 0, "★反向对照★ 取消一个没收藏的：一次改名都没有（量的是真在写的那一下）");
    } finally { fs.renameSync = origRename; }
    sameSet(fs.readdirSync(root), [favs.FAV_FILE], "根里只剩 .favorites.json：没有 .tmp、没有 .bak");
  });

  await section("② 20 下并发：一条不丢", async () => {
    const root = fresh("burst");
    const names = Array.from({ length: 20 }, (_, i) => `卡片/第${i + 1}张.md`);
    const got = await Promise.all(names.map((p) => favs.setFav(root, { src: "lib", path: p, on: true })));
    ok(got.every((x) => x === true), "20 个都回 true");
    eq(Object.keys(rawItems(root)).length, 20, "盘上那份：20 条一条不少");

    // 收藏和取消混着来：取消前 10 个的同时再收藏 10 个新的
    const more = Array.from({ length: 10 }, (_, i) => `卡片/新${i + 1}.md`);
    await Promise.all([
      ...names.slice(0, 10).map((p) => favs.setFav(root, { src: "lib", path: p, on: false })),
      ...more.map((p) => favs.setFav(root, { src: "lib", path: p, on: true })),
    ]);
    sameSet(Object.keys(rawItems(root)), [...names.slice(10), ...more].map((p) => "lib:" + p), "取消 10 个、同时新收藏 10 个：剩下的正好是那 20 个");

    // 同一个文件连点 20 下（收、取消、收……）：按点的先后排队，最后的状态是最后那一下
    const one = fresh("same");
    const seqOut = await Promise.all(Array.from({ length: 20 }, (_, i) => favs.setFav(one, { src: "ws", path: "产出/x.md", on: i % 2 === 0 })));
    ok(seqOut.every((v, i) => v === (i % 2 === 0)), "每一下回的都是它自己那一下的结果（按点的先后）", seqOut);
    ok(!favs.favKeys(one).has("ws:产出/x.md"), "连点 20 下（最后一下是取消）：最后没收藏");
    // ★反向对照★ 连点 19 下（最后一下是收藏）：最后收藏着
    const odd = fresh("same");
    await Promise.all(Array.from({ length: 19 }, (_, i) => favs.setFav(odd, { src: "ws", path: "产出/x.md", on: i % 2 === 0 })));
    ok(favs.favKeys(odd).has("ws:产出/x.md"), "★反向对照★ 连点 19 下（最后一下是收藏）：最后收藏着");

    // ★反向对照★ 不排队的读-改-写（读完让一拍再写）：20 下并发只剩 1 条——这把尺子量得出丢
    const naive = fresh("naive");
    const naiveSet = async (/** @type {string} */ p) => {
      let d = { v: 1, items: /** @type {Record<string, any>} */ ({}) };
      try { d = JSON.parse(fs.readFileSync(favFile(naive), "utf8")); } catch {}
      await new Promise((r) => setImmediate(r));
      d.items["lib:" + p] = { at: Date.now() };
      fs.writeFileSync(favFile(naive), JSON.stringify(d));
    };
    await Promise.all(names.map(naiveSet));
    const lost = Object.keys(rawItems(naive)).length;
    ok(lost < 20, `★反向对照★ 不排队的写法：20 下并发只剩 ${lost} 条（这把尺子量得出丢）`, lost);
  });

  await section("③ 文件坏了：改名成 .bad 留着，按空的往下走", async () => {
    const root = fresh("corrupt");
    fs.writeFileSync(favFile(root), "{坏了一半");
    const { value, said } = await quietErrors(() => favs.readFavs(root));
    eq(Object.keys(value.items).length, 0, "读出来按没有收藏算");
    const bads = badsOf(root);
    eq(bads.length, 1, "留了一份 .favorites.json.bad-<毫秒>", fs.readdirSync(root));
    eq(bads.length ? fs.readFileSync(path.join(root, bads[0]), "utf8") : "", "{坏了一半", ".bad 里是原样的坏内容，一个字没动");
    ok(!fs.existsSync(favFile(root)), "坏的那份挪走了，不在原名上");
    ok(said.some((s) => s.includes(".bad-")), "打了一句说改名成了什么", said);
    eq(await favs.setFav(root, { src: "lib", path: "a.md", on: true }), true, "坏过以后照常收藏");
    ok(!!rawItems(root)["lib:a.md"], "新写出来的那份是好的 JSON");
    eq(badsOf(root).length, 1, ".bad 还在，没被新的覆盖");

    // 结构不对（items 是数组）也算坏
    const shape = fresh("shape");
    fs.writeFileSync(favFile(shape), JSON.stringify({ v: 1, items: ["lib:a.md"] }));
    await quietErrors(() => favs.readFavs(shape));
    eq(badsOf(shape).length, 1, "items 是个数组：也算坏，隔离");

    // 单独一条坏了不拖累整份
    const partial = fresh("partial");
    fs.writeFileSync(favFile(partial), JSON.stringify({ v: 1, items: { "lib:好的.md": { at: 5 }, "lib:../越界.md": { at: 6 }, "lib:空值.md": null, "zz:别的.md": { at: 7 } } }));
    const d = favs.readFavs(partial);
    sameSet(Object.keys(d.items), ["lib:好的.md"], "单条坏的（越界、空值、src 不认识）丢掉，好的那条留着");
    eq(badsOf(partial).length, 0, "★反向对照★ 只是几条坏：整份不隔离");

    // ★反向对照★ 好的文件：读多少遍都不改名
    const good = fresh("good");
    await favs.setFav(good, { src: "lib", path: "a.md", on: true });
    for (let i = 0; i < 3; i++) favs.readFavs(good);
    eq(badsOf(good).length, 0, "★反向对照★ 好的文件读三遍：没有 .bad");
    ok(fs.existsSync(favFile(good)), "★反向对照★ 好的文件还在原名上");
  });

  await section("④ 文件没了：清单里留着，标 missing", async () => {
    const root = fresh("missing");
    const lib = fresh("lib-files");
    put(lib, "在的.md"); put(lib, "要删的.md");
    await favs.setFav(root, { src: "lib", path: "在的.md", on: true, now: 100 });
    await favs.setFav(root, { src: "lib", path: "要删的.md", on: true, now: 200 });
    await favs.setFav(root, { src: "ws", path: "解析会炸的.md", on: true, now: 300 });
    fs.rmSync(path.join(lib, "要删的.md"));
    const rows = favs.listFavs(root, (src, rel) => {
      if (rel === "解析会炸的.md") throw new Error("解析不了");
      return src === "lib" && fs.existsSync(path.join(lib, rel));
    });
    const by = Object.fromEntries(rows.map((r) => [r.path, r]));
    eq(rows.length, 3, "三条都列出来：删掉的那条没被偷偷抹掉");
    eq((by["要删的.md"] || {}).missing, true, "删掉的：missing=true");
    eq((by["解析会炸的.md"] || {}).missing, true, "判存在时抛错的：按没了算，missing=true");
    eq((by["在的.md"] || {}).missing, false, "★反向对照★ 还在的：missing=false");
    ok(rows.map((r) => r.at).join(",") === "300,200,100", "新收藏的在前", rows.map((r) => r.at));
    ok(rows.every((r) => typeof r.src === "string" && typeof r.path === "string" && typeof r.at === "number"), "每行都有 src、path、at");
    eq(Object.keys(rawItems(root)).length, 3, "列一遍不改盘上那份");
  });

  await section("⑤ 两个根互相看不见", async () => {
    const a = fresh("甲"), b = fresh("乙");
    await favs.setFav(a, { src: "lib", path: "合同.pdf", on: true });
    ok(!favs.favKeys(b).has("lib:合同.pdf"), "甲收藏的，乙的清单里没有");
    ok(!fs.existsSync(favFile(b)), "乙的根里连文件都没有");
    ok(favs.favKeys(a).has("lib:合同.pdf"), "★反向对照★ 甲自己看得见");
    // 两个根同时来 20 下：各记各的
    await Promise.all(Array.from({ length: 20 }, (_, i) => favs.setFav(i % 2 ? a : b, { src: "lib", path: `并发/${i}.md`, on: true })));
    eq([...favs.favKeys(a)].filter((k) => k.startsWith("lib:并发/")).length, 10, "两个根一起写：甲这边 10 条");
    eq([...favs.favKeys(b)].filter((k) => k.startsWith("lib:并发/")).length, 10, "乙那边 10 条，不串");
  });

  await section("收藏上限：满了不让加，但已有的照常点", async () => {
    const root = fresh("cap");
    const items = {};
    for (let i = 0; i < favs.FAV_MAX; i++) items["lib:满/" + i + ".md"] = { at: i };
    fs.writeFileSync(favFile(root), JSON.stringify({ v: 1, items }));
    const t0 = process.hrtime.bigint();
    const cold = favs.favKeys(root);
    const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    favs.favKeys(root);
    const warmMs = Number(process.hrtime.bigint() - t1) / 1e6;
    console.log(`    （量了一下：${favs.FAV_MAX} 条的清单，第一次读 ${coldMs.toFixed(1)}ms，文件没动再读 ${warmMs.toFixed(2)}ms）`);
    eq(cold.size, favs.FAV_MAX, `${favs.FAV_MAX} 条都读得出来`);
    ok(favs.readFavs(root) === favs.readFavs(root), "文件没动：第二次读拿的是同一份（没重新 parse）");
    let err = null;
    try { await favs.setFav(root, { src: "lib", path: "再加一个.md", on: true }); } catch (e) { err = e; }
    ok(err && err.status === 400 && /5000/.test(err.message), "满了再加：400，说清楚上限是多少", err && err.message);
    eq(await favs.setFav(root, { src: "lib", path: "满/7.md", on: true }), true, "★反向对照★ 满了以后，点一个已经收藏的：照常");
    eq(await favs.setFav(root, { src: "lib", path: "满/8.md", on: false }), false, "★反向对照★ 满了以后取消：照常");
    eq(await favs.setFav(root, { src: "lib", path: "再加一个.md", on: true }), true, "★反向对照★ 腾出一个位子，再加就进得去了");
  });

  // ---------------------------------------------------------------------------------------------
  // 真起 server.js
  // ---------------------------------------------------------------------------------------------
  const prefs = require(mod("prefs"));
  const LIB = path.join(HOME, "data", "library");
  const LIB_BOB = path.join(HOME, "data", "library-users", prefs.keyOf("bob"));
  const WS = path.join(HOME, "workspace");
  const OUTSIDE = path.join(HOME, "外面");
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.writeFileSync(path.join(OUTSIDE, "秘密.md"), "外面的\n");
  put(LIB, "报告/周报.md", "# 周报\n");
  put(LIB, "报告/要删的.md", "删\n");
  put(LIB, "说明.txt", "说明");
  for (let i = 0; i < 20; i++) put(LIB, `卡片/第${i + 1}张.md`, "卡片" + i);
  fs.symlinkSync(path.join(OUTSIDE, "秘密.md"), path.join(LIB, "外链.md"));
  put(LIB_BOB, "乙的笔记.md", "乙\n");
  // 工作区：一次任务认领两个，其余的都是「未归属」。walkAllCached 有 3 秒记忆，所以起服务前一次铺齐
  put(WS, "产出/周报.md", "# 周报\n");
  put(WS, "产出/图.png", "png");
  put(WS, "杂/手放的.md", "手放的\n");
  const BULK = 25;
  for (let i = 0; i < BULK; i++) put(WS, `批量/第${String(i + 1).padStart(2, "0")}个.txt`, "第" + i);
  put(WS, "幻灯/deck.json", "{}");
  put(WS, "幻灯/index.html", "<p>1</p>");
  put(WS, "幻灯/第二页.HTM", "<p>2</p>");
  put(WS, "幻灯/讲稿.md", "讲稿");
  put(WS, "幻灯/子/index.html", "<p>子</p>");
  put(WS, "别处/index.html", "<p>别处</p>");
  const at = new Date().toISOString();
  fs.mkdirSync(path.join(HOME, "data", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "data", "sessions", "s_fav.json"), JSON.stringify({
    id: "s_fav", title: "写周报", user: "lib", updated_at: at,
    transcript: [
      { type: "user", at, text: "写周报" },
      { type: "assistant", at, events: [{ type: "files", changed: ["产出/周报.md", "产出/图.png", "幻灯/index.html"] }] },
    ],
  }));
  const tokA = "lib" + crypto.randomBytes(12).toString("hex");
  const tokB = "bob" + crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(path.join(HOME, "data", "users.json"), JSON.stringify({
    users: [
      { username: "lib", org: "default", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() },
      { username: "bob", org: "default", salt: "x", hash: "x", role: "member", credits: 0, created_at: Date.now() },
    ],
    tokens: { [tokA]: { user: "lib", at: Date.now() }, [tokB]: { user: "bob", at: Date.now() } },
  }));
  const SERVER_TMP = path.join(HOME, "tmp");
  fs.mkdirSync(SERVER_TMP, { recursive: true });
  const booted = bootRealServer({ OPENWORKBUDDY_HOME: HOME, TMPDIR: SERVER_TMP, TMP: SERVER_TMP, TEMP: SERVER_TMP }, { timeoutMs: 120000 });
  serverChild = booted.child;
  const { up, port, why } = await booted.wait();
  ok(up, "真 server.js 起来了", up ? undefined : why);
  /** @returns {Promise<{ code: number, body: string, json: any }>} */
  const call = (method, p, tok, body) => new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const rq = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: { Cookie: "openworkbuddy_token=" + tok, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ code: res.statusCode || 0, body: text, json });
      });
    });
    rq.on("error", (e) => resolve({ code: 0, body: e.message, json: null }));
    if (data) rq.write(data);
    rq.end();
  });
  const fav = (tok, src, p, on) => call("POST", "/api/library/favorite", tok, { src, path: p, on });
  const list = async (tok) => ((await call("GET", "/api/library/favorites", tok)).json || {}).items || [];
  const outputs = async (q = "") => (await call("GET", "/api/library/outputs" + q, tokA)).json || {};

  if (up) {
    await section("接口：收藏 / 取消 / 列表", async () => {
      const r = await fav(tokA, "lib", "报告/周报.md", true);
      eq(r.code, 200, "POST /api/library/favorite → 200");
      ok(r.json && r.json.ok === true && r.json.fav === true, "回 {ok:true, fav:true}", r.json);
      ok(fs.existsSync(favFile(LIB)), "管理员的收藏落在他自己的资料库根里");
      ok(!fs.existsSync(favFile(LIB_BOB)), "★反向对照★ bob 的资料库里没有");
      const items = await list(tokA);
      const row = items.find((x) => x.path === "报告/周报.md");
      ok(row && row.src === "lib" && typeof row.at === "number" && row.missing === false, "GET /api/library/favorites 列出来：src、path、at、missing=false", items);
      const off = await fav(tokA, "lib", "报告/周报.md", false);
      ok(off.json && off.json.ok === true && off.json.fav === false, "取消：回 {ok:true, fav:false}", off.json);
      ok(!(await list(tokA)).some((x) => x.path === "报告/周报.md"), "取消后列表里没了");
      await fav(tokA, "lib", "报告/周报.md", true);
    });

    await section("接口：拒什么、放什么", async () => {
      const cases = [
        [{ src: "lib", path: "没有这个.md", on: true }, 404, "收藏一个不存在的文件"],
        [{ src: "lib", path: "../外面/秘密.md", on: true }, 400, "带 .."],
        [{ src: "lib", path: path.join(OUTSIDE, "秘密.md"), on: true }, 400, "绝对路径"],
        [{ src: "lib", path: "外链.md", on: true }, 400, "指到根外面的软链接"],
        [{ src: "lib", path: favs.FAV_FILE, on: true }, 400, "收藏文件自己"],
        [{ src: "zz", path: "说明.txt", on: true }, 400, "src 不认识"],
        [{ src: "lib", path: "说明.txt", on: "true" }, 400, "on 不是布尔值"],
        [{ src: "lib", path: "说明.txt" }, 400, "没给 on"],
      ];
      for (const [body, code, why] of cases) {
        const r = await call("POST", "/api/library/favorite", tokA, body);
        eq(r.code, code, `${why}：${code}`);
        ok(r.json && typeof r.json.error === "string" && r.json.error.length > 0, `${why}：带一句 error`, r.json);
      }
      ok(!Object.keys(rawItems(LIB)).some((k) => /秘密|没有这个|外链|favorites|说明/.test(k)), "上面这些一条都没进清单", Object.keys(rawItems(LIB)));
      // ★反向对照★ 同样的写法换成合法的：收得进去
      const r = await fav(tokA, "lib", "说明.txt", true);
      ok(r.code === 200 && r.json && r.json.fav === true, "★反向对照★ 合法的 说明.txt：200、fav:true", r);
      ok(!!rawItems(LIB)["lib:说明.txt"], "★反向对照★ 清单里有了");
      // 收藏文件本身不能被当成资料读出来
      const raw = await call("GET", "/api/library/file/" + encodeURIComponent(favs.FAV_FILE), tokA);
      ok(raw.code >= 400 && !raw.body.includes("lib:说明.txt"), "GET /api/library/file/.favorites.json 读不出清单", raw.code);
      const txt = await call("GET", "/api/library/file/" + encodeURIComponent("说明.txt"), tokA);
      eq(txt.code, 200, "★反向对照★ 同一条路读普通文件：200");
    });

    await section("接口：文件没了标 missing，取消照样能取消", async () => {
      await fav(tokA, "lib", "报告/要删的.md", true);
      fs.rmSync(path.join(LIB, "报告", "要删的.md"));
      const items = await list(tokA);
      eq((items.find((x) => x.path === "报告/要删的.md") || {}).missing, true, "删掉的那条：missing=true，还在列表里");
      eq((items.find((x) => x.path === "报告/周报.md") || {}).missing, false, "★反向对照★ 还在的那条：missing=false");
      const again = await fav(tokA, "lib", "报告/要删的.md", true);
      eq(again.code, 404, "没了的文件再点收藏：404");
      const off = await fav(tokA, "lib", "报告/要删的.md", false);
      ok(off.code === 200 && off.json && off.json.fav === false, "没了的文件点取消：200、fav:false（取消不查文件在不在）", off);
      ok(!(await list(tokA)).some((x) => x.path === "报告/要删的.md"), "取消以后列表里没了");
    });

    await section("接口：两个账号互相看不见", async () => {
      eq((await list(tokB)).length, 0, "bob 的收藏列表是空的（看不到管理员收藏的）");
      const r = await fav(tokB, "lib", "报告/周报.md", true);
      eq(r.code, 404, "bob 收藏管理员资料库里的路径：在 bob 自己的根下找，没有，404");
      const mine = await fav(tokB, "lib", "乙的笔记.md", true);
      ok(mine.code === 200 && mine.json && mine.json.fav === true, "★反向对照★ bob 收藏他自己的：200", mine);
      sameSet((await list(tokB)).map((x) => x.path), ["乙的笔记.md"], "bob 只看得到他自己那一条");
      ok(!(await list(tokA)).some((x) => x.path === "乙的笔记.md"), "管理员看不到 bob 的");
      ok(fs.existsSync(favFile(LIB_BOB)), "bob 的收藏落在 bob 自己的根里");
      const bl = (await call("GET", "/api/library", tokB)).json || {};
      ok((bl.files || []).every((f) => f.path !== "报告/周报.md"), "bob 的资料库列表里没有管理员的文件");
      eq(((bl.files || []).find((f) => f.path === "乙的笔记.md") || {}).fav, true, "bob 的列表上他自己那条 fav:true");
    });

    await section("② 接口：20 个请求一起发，一条不丢", async () => {
      const names = Array.from({ length: 20 }, (_, i) => `卡片/第${i + 1}张.md`);
      const rs = await Promise.all(names.map((p) => fav(tokA, "lib", p, true)));
      ok(rs.every((r) => r.code === 200 && r.json && r.json.fav === true), "20 个都 200、fav:true", rs.map((r) => r.code));
      const have = new Set((await list(tokA)).map((x) => x.path));
      eq(names.filter((p) => have.has(p)).length, 20, "列表里 20 个一个不少");
      // 取消 10 个的同时 bob 也在收藏：谁也不吃谁的
      const rs2 = await Promise.all([
        ...names.slice(0, 10).map((p) => fav(tokA, "lib", p, false)),
        ...Array.from({ length: 10 }, () => fav(tokB, "lib", "乙的笔记.md", true)),
      ]);
      ok(rs2.every((r) => r.code === 200), "混着发的 20 个都 200");
      const after = new Set((await list(tokA)).map((x) => x.path));
      sameSet(names.filter((p) => after.has(p)), names.slice(10), "管理员这边：剩下后 10 个");
      sameSet((await list(tokB)).map((x) => x.path), ["乙的笔记.md"], "bob 那边还是他那一条");
      ok(!fs.readdirSync(LIB).some((n) => /\.tmp$/.test(n)), "资料库根里没有写到一半的临时文件");
    });

    await section("③ 接口：收藏文件坏了，照常用", async () => {
      fs.writeFileSync(favFile(LIB_BOB), "not json {");
      const items = await list(tokB);
      eq(items.length, 0, "坏了：列表按空的给，不报错");
      eq(badsOf(LIB_BOB).length, 1, "bob 的根里留了一份 .bad");
      eq(badsOf(LIB).length, 0, "★反向对照★ 管理员那份是好的：没被动");
      const r = await fav(tokB, "lib", "乙的笔记.md", true);
      ok(r.code === 200 && r.json && r.json.fav === true, "坏过以后照常收藏", r);
      sameSet((await list(tokB)).map((x) => x.path), ["乙的笔记.md"], "新的那份好好的");
      const bl = (await call("GET", "/api/library", tokB)).json || {};
      ok(!(bl.files || []).some((f) => f.name.startsWith(".favorites")), ".bad 也不出现在资料库列表里");
    });

    await section("⑥ /api/library：文件行带 fav、size、mtime；收藏文件不露面", async () => {
      const r = await call("GET", "/api/library", tokA);
      eq(r.code, 200, "GET /api/library → 200");
      const files = (r.json && r.json.files) || [];
      eq((files.find((f) => f.path === "说明.txt") || {}).fav, true, "收藏了的 说明.txt：fav:true");
      ok(files.length > 0 && files.every((f) => typeof f.fav === "boolean" && typeof f.size === "number" && typeof f.mtime === "string"), "每个文件行都有 fav（布尔）、size、mtime", files[0]);
      ok(!files.some((f) => f.name === favs.FAV_FILE), ".favorites.json 不在列表里");
      ok(files.some((f) => f.name === "说明.txt"), "★反向对照★ 同一层的普通文件在列表里（量的是同一份列表）");
      const sub = ((await call("GET", "/api/library?dir=" + encodeURIComponent("报告"), tokA)).json || {}).files || [];
      eq((sub.find((f) => f.path === "报告/周报.md") || {}).fav, true, "子目录里收藏了的：fav:true");
      await fav(tokA, "lib", "说明.txt", false);
      const r2 = ((await call("GET", "/api/library", tokA)).json || {}).files || [];
      eq((r2.find((f) => f.path === "说明.txt") || {}).fav, false, "★反向对照★ 取消以后：fav:false");
    });

    await section("⑥ /api/library/outputs：任务产出、未归属都带 fav", async () => {
      ok((await fav(tokA, "ws", "产出/周报.md", true)).json.fav === true, "收藏工作区里的 产出/周报.md");
      ok((await fav(tokA, "ws", "杂/手放的.md", true)).json.fav === true, "收藏工作区里的 杂/手放的.md（未归属的）");
      const o = await outputs("?orphan_limit=2000");
      const task = (o.tasks || []).find((t) => t.id === "s_fav");
      ok(!!task, "任务 s_fav 在", (o.tasks || []).map((t) => t.id));
      const tf = Object.fromEntries(((task && task.files) || []).map((f) => [f.name, f]));
      eq((tf["产出/周报.md"] || {}).fav, true, "任务产出里收藏了的：fav:true");
      eq((tf["产出/图.png"] || {}).fav, false, "★反向对照★ 同一个任务里没收藏的：fav:false");
      ok(Object.values(tf).every((f) => typeof f.size === "number" && typeof f.mtime === "string" && f.mtime), "任务产出每行都有 size、mtime", tf);
      const orf = Object.fromEntries((o.orphans || []).map((f) => [f.name, f]));
      eq((orf["杂/手放的.md"] || {}).fav, true, "未归属里收藏了的：fav:true");
      eq((orf["批量/第01个.txt"] || {}).fav, false, "★反向对照★ 未归属里没收藏的：fav:false");
      ok((o.orphans || []).every((f) => typeof f.fav === "boolean" && typeof f.size === "number" && typeof f.mtime === "string"), "未归属每行都有 fav、size、mtime");
      ok(!orf["产出/周报.md"], "任务认领了的不在未归属里");
      // 工作区的收藏和资料库的收藏是两条：同名不串
      eq(((await call("GET", "/api/library?dir=" + encodeURIComponent("报告"), tokA)).json.files.find((f) => f.path === "报告/周报.md") || {}).fav, true, "资料库里的 报告/周报.md 还是 fav:true（它是另一条）");
      await fav(tokA, "ws", "产出/周报.md", false);
      const o2 = await outputs();
      const t2 = ((o2.tasks || []).find((t) => t.id === "s_fav") || { files: [] }).files;
      eq((t2.find((f) => f.name === "产出/周报.md") || {}).fav, false, "★反向对照★ 取消以后任务产出里 fav:false");
      // bob 看 outputs：他的收藏清单里没有这些
      const ob = (await call("GET", "/api/library/outputs?orphan_limit=2000", tokB)).json || {};
      ok(!(ob.orphans || []).some((f) => f.fav), "bob 看未归属：一个 fav 都没有（管理员的收藏不串过去）");
    });

    await section("⑥ /api/library/outputs：orphan_offset 翻页", async () => {
      const all = await outputs("?orphan_limit=20000");
      const total = all.orphan_total;
      const full = (all.orphans || []).map((f) => f.name);
      ok(total >= BULK + 5 && full.length === total, `全量：orphan_total=${total}，回了 ${full.length} 条`, { total, n: full.length });
      eq(all.orphan_offset, 0, "没带 orphan_offset：回 0");
      const pages = [];
      for (let off = 0; off < total; off += 10) {
        const p = await outputs(`?orphan_limit=10&orphan_offset=${off}`);
        eq(p.orphan_total, total, `第 ${off / 10 + 1} 页：orphan_total 不变（${total}）`);
        eq(p.orphan_offset, off, `第 ${off / 10 + 1} 页：orphan_offset 照实回 ${off}`);
        pages.push(...(p.orphans || []).map((f) => f.name));
      }
      eq(pages.length, total, "一页页翻完：条数正好等于 orphan_total");
      eq(new Set(pages).size, pages.length, "页和页之间不重叠");
      ok(pages.every((n, i) => n === full[i]), "拼起来跟一次要全量的顺序一模一样");
      const p0 = await outputs("?orphan_limit=10");
      const p0b = await outputs("?orphan_limit=10&orphan_offset=0");
      ok(JSON.stringify(p0.orphans) === JSON.stringify(p0b.orphans), "★反向对照★ 不带 offset 和 offset=0 是同一页");
      const p1 = await outputs("?orphan_limit=10&orphan_offset=10");
      ok(JSON.stringify(p0.orphans) !== JSON.stringify(p1.orphans), "★反向对照★ offset=10 那页跟第一页不一样（offset 真起作用）");
      const past = await outputs(`?orphan_limit=10&orphan_offset=${total + 5}`);
      ok(Array.isArray(past.orphans) && past.orphans.length === 0 && past.orphan_total === total, "翻过头：空页，orphan_total 照旧");
      const junk = await outputs("?orphan_limit=10&orphan_offset=abc");
      ok(junk.orphan_offset === 0 && JSON.stringify(junk.orphans) === JSON.stringify(p0.orphans), "orphan_offset 乱写：按 0 算");
      const neg = await outputs("?orphan_limit=10&orphan_offset=-5");
      eq(neg.orphan_offset, 0, "负数：按 0 算");
      eq((await outputs()).orphans.length, Math.min(200, total), "没带 orphan_limit：还是默认 200 以内");
      ok(Array.isArray(p1.tasks) && p1.tasks.some((t) => t.id === "s_fav"), "翻到后面几页，tasks 照样给（语义没变）");
    });

    await section("⑦ 同目录有 deck.json 的网页：deck:true", async () => {
      const o = await outputs("?orphan_limit=20000");
      const orf = Object.fromEntries((o.orphans || []).map((f) => [f.name, f]));
      const tf = Object.fromEntries((((o.tasks || []).find((t) => t.id === "s_fav") || {}).files || []).map((f) => [f.name, f]));
      eq((tf["幻灯/index.html"] || {}).deck, true, "任务产出里的 幻灯/index.html：deck:true");
      eq((orf["幻灯/第二页.HTM"] || {}).deck, true, "大写 .HTM 也认");
      ok(!("deck" in (orf["幻灯/讲稿.md"] || { deck: 1 })), "同目录的 .md：不标（不是网页）");
      ok(!("deck" in (orf["幻灯/子/index.html"] || { deck: 1 })), "子目录里的网页：不标（deck.json 不在它那一层）");
      ok(!("deck" in (orf["别处/index.html"] || { deck: 1 })), "★反向对照★ 别的目录、没有 deck.json：不标");
      ok(!("deck" in (orf["幻灯/deck.json"] || { deck: 1 })), "deck.json 自己：不标");
    });
  }

  if (serverChild) {
    await section("收尾：关掉服务", async () => {
      const code = await stopServer(/** @type {import("child_process").ChildProcess} */ (serverChild));
      ok(code !== null, "服务 SIGINT 后自己退了", code);
    });
  }

  finished = true;
  clearInterval(keepAlive);
  console.log(`\n${fail ? "✗" : "✓"} 资料库收藏：${pass} 过 / ${fail} 挂`);
  try { if (serverChild && serverChild.exitCode === null) serverChild.kill("SIGKILL"); } catch {}
  process.exit(fail ? 1 : 0);
})();

/**
 * 先 SIGINT（服务自己 process.exit），5 秒不退再 SIGKILL。回退出码，被硬杀的回 null
 * @param {import("child_process").ChildProcess} child
 */
async function stopServer(child) {
  if (child.exitCode !== null) return child.exitCode;
  const exited = new Promise((r) => child.once("exit", (c) => r(c)));
  try { child.kill("SIGINT"); } catch {}
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("超时"), 5000))]);
  if (code !== "超时") return /** @type {number|null} */ (code);
  try { child.kill("SIGKILL"); } catch {}
  await exited;
  return null;
}

/**
 * 起一份真的 server.js。跟 test/library-cover.js 那份一样，只认「已启动: http://localhost:端口」那一行。
 * @param {Record<string,string>} env
 * @param {{ timeoutMs?: number, port?: string }} [opts]
 */
function bootRealServer(env, { timeoutMs = 60000, port = "0" } = {}) {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [entry("server")], {
    env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const ready = new Promise((resolve) => {
    const done = (/** @type {boolean} */ v) => { clearInterval(tick); clearTimeout(t); resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    const tick = setInterval(() => {
      if (/已启动: http:\/\/localhost:\d+/.test(log)) done(true);
      else if (child.exitCode !== null) done(false);
    }, 200);
  });
  return {
    child,
    get log() { return log; },
    async wait() {
      const up = await ready;
      const m = /已启动: http:\/\/localhost:(\d+)/.exec(log);
      return { up: !!up && !!m, port: m ? Number(m[1]) : 0, why: `退出码=${child.exitCode} 存活=${child.exitCode === null} 日志尾巴=${JSON.stringify(log.slice(-400)) || "(空)"}` };
    },
  };
}
