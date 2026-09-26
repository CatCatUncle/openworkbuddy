"use strict";
/**
 * 资料库「工作区」那一栏（lib/ws-browse.js + /api/files/tree + /api/library/outputs 的全量计数）：
 *
 *   ① 一层层列：第七层的文件从根一路点得到；从根往下点能到的文件，跟全量走一趟数出来的一个不差
 *   ② 该藏的藏：点开头的、临时区/依赖/版本库、应用自己的数据目录；用户自己叫 data 的文件夹不误伤
 *   ③ 越界一律拒：..、绝对路径、路上有链接；指回上层的链接走不成死循环，指到外面的带不出文件
 *   ④ 一层太多就截、截了照实说（文件夹一个不丢，文件留最新的）；全量走撞了条数/层数的线也照实说
 *   ⑤ 几秒的记忆：该命中命中、过期重走、clear 立刻看见新文件；回来的东西冻住，谁也改不动
 *   ⑥ 跟文件面板共用一份「跳过谁」：outputFiles() 前三层列出来的，跟这边前三层一个不差
 *   ⑦c 本回合产出拿整树做差：第五层新写的、改写的都报；跳过的照旧跳过；带记忆的全量挡不住；深过 12 层照样差得出
 *   ⑦d 只有条数撞线才报 scan_capped（老工程的深目录链不算）；撞线时报过的产出不丢、自己文件夹补走一遍
 *   ⑦ 真起 server.js：tree 路由、outputs 的 ws_total / orphan_total / orphan_limit、搜索搜得到第七层
 *
 * 用户那句话是「资料库没有显示我这个工作区下面的所有文件」：以前资料库拿 outputFiles()（最近 500 个、
 * 最深 3 层）当全集，第四层往下的文件哪儿都找不到。这里每一条都是冲着「全」去的。
 *
 * 不联网、不花钱、不起 Electron。
 *   node test/library-ws.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

// 工作区、数据目录、账号全跟着 OPENWORKBUDDY_HOME 走：require 任何项目模块之前先把家搬到临时目录，
// 绝不碰用户真实的工作区和数据
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-library-ws-"));
process.env.OPENWORKBUDDY_HOME = HOME;

const ROOT = path.join(__dirname, "..");
const wsb = require(path.join(ROOT, "lib", "ws-browse"));

let pass = 0, fail = 0, finished = false;
/** @type {import("child_process").ChildProcess | null} */
let serverChild = null;
process.on("exit", (code) => {
  try { if (serverChild && serverChild.exitCode === null) serverChild.kill(); } catch {}
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
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 3).join(" | ")}`); }
}
/** 两个名字集合一个不差；不一样就把多的少的各列几条出来，红的时候不用再去翻 */
function sameSet(got, want, name) {
  const g = new Set(got), w = new Set(want);
  const extra = [...g].filter((x) => !w.has(x)), missing = [...w].filter((x) => !g.has(x));
  ok(!extra.length && !missing.length && g.size === got.length, name,
    extra.length || missing.length ? { 多了: extra.slice(0, 6), 少了: missing.slice(0, 6) } : undefined);
}
/** 期望它抛、而且抛的是这个状态码（路由原样回给前端，前端靠 404 判「文件夹没了，退回根」） */
function throwsStatus(fn, status, name, msgPart) {
  try { fn(); ok(false, name, "没抛"); }
  catch (e) {
    const m = String(e && e.message);
    ok(e && e.status === status && (!msgPart || m.includes(msgPart)), name,
      e && e.status === status && (!msgPart || m.includes(msgPart)) ? undefined : { status: e && e.status, message: m });
  }
}
const segs = (/** @type {string} */ n) => n.split("/").length;
const ms = (/** @type {bigint} */ t0) => Number(process.hrtime.bigint() - t0) / 1e6;

// ---------------------------------------------------------------------------------------------
// 夹具：一棵七层深的树，外加该藏的、链接、一层很宽的
// ---------------------------------------------------------------------------------------------
const U = path.join(HOME, "unit");
const R = path.join(U, "根");                 // 工作区根
const OUT = path.join(U, "外面");             // 工作区外面：链接指到这里，里面的文件绝不能被列出来
const APPDATA = path.join(R, "data");         // 桌面版的数据目录默认就落在工作区里，就是这个样子
const put = (/** @type {string} */ rel, body = "x", /** @type {Date=} */ at) => {
  const f = path.join(R, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  if (at) fs.utimesSync(f, at, at);
};
const DEEP = "L1/L2/L3/L4/L5/L6/深.md";      // 第七层（根算第一层）
const VISIBLE = [
  "a.md", "b.txt",
  "L1/c.md", "L1/data/自己的.csv",
  "L1/L2/d.md", "L1/L2/L3/e.md", "L1/L2/L3/L4/f.md", "L1/L2/L3/L4/L5/g.md", DEEP,
  "宽/第1集/x.md", "宽/第2集/x.md", "宽/第10集/x.md",
  ...Array.from({ length: 10 }, (_, i) => `宽/f${i}.md`),
];
const HIDDEN = [
  ".hidden.md", ".tmp/t.md", ".openworkbuddy/state.json", "node_modules/x/index.js", ".git/HEAD",
  "data/im-log.json", "L1/L2/node_modules/y.js", "L1/.DS_Store",
];
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "外面.md"), "工作区外面的东西");
{
  const base = Date.now() - 3600e3;
  VISIBLE.forEach((rel, i) => put(rel, "x" + i, new Date(base + i * 1000)));
  HIDDEN.forEach((rel) => put(rel));
  // 宽/ 里的十个文件：f9 最新、f0 最旧，截断的时候该留下的是 f9、f8
  for (let i = 0; i < 10; i++) put(`宽/f${i}.md`, "f" + i, new Date(base + 100e3 + i * 1000));
  fs.symlinkSync(R, path.join(R, "L1", "L2", "回环"));                    // 指回根：跟进去就是死循环
  fs.symlinkSync(path.join(R, "a.md"), path.join(R, "L1", "L2", "链到文件.md"));
  fs.symlinkSync(OUT, path.join(R, "L1", "外链"));                        // 指到工作区外面
  fs.symlinkSync(R, path.join(U, "别名"));                                // 根本身挂在链接底下（/tmp → /private/tmp 那种）
}
const LIST = { appDataDir: APPDATA };

(async () => {
  await section("① 一层层列：七层深的文件从根一路点得到", () => {
    const top = wsb.listDir(R, "", LIST);
    sameSet(top.dirs.map((d) => d.name), ["L1", "宽"], "根：只有 L1、宽 两个文件夹（data/.tmp/node_modules/.git/.openworkbuddy 都藏了）");
    sameSet(top.files.map((f) => f.name), ["a.md", "b.txt"], "根：两个文件，.hidden.md 不在");
    eq(top.total, 4, "根：total 是看得见的条数");
    eq(top.truncated, false, "根：没截");
    eq(top.dir, "", "根：dir 是空串");
    eq(top.crumbs.length, 0, "根：没有面包屑");
    const l1 = top.dirs.find((d) => d.name === "L1");
    // L1 底下看得见的：c.md、data/、L2/；外链是链接不算，.DS_Store 点开头不算
    eq(l1 && l1.count, 3, "文件夹行上的「N 项」跟点进去看到的一样多（链接、点开头的不算）");
    ok(l1 && /^\d{4}-\d\d-\d\dT/.test(l1.mtime), "文件夹行带修改时间", l1);

    const six = wsb.listDir(R, "L1/L2/L3/L4/L5/L6", LIST);
    eq(six.files.length === 1 && six.files[0].name, DEEP, "第六层文件夹里列出第七层的文件，name 是完整相对路径");
    eq(six.files[0] && six.files[0].base, "深.md", "base 只是文件自己的名字");
    eq(six.crumbs.length, 6, "面包屑六段");
    ok(six.crumbs[2] && six.crumbs[2].name === "L3" && six.crumbs[2].path === "L1/L2/L3", "面包屑每段带到这一层为止的路径", six.crumbs[2]);

    const l2 = wsb.listDir(R, "L1/L2", LIST);
    sameSet(l2.dirs.map((d) => d.name), ["L3"], "L1/L2：回环（链接）和 node_modules 都不列");
    sameSet(l2.files.map((f) => f.name), ["L1/L2/d.md"], "L1/L2：链到文件.md（文件链接）不列");

    // 像人一样从根一层层点：顺着 dirs[].path 往下走，能摸到的文件跟全量走一趟的一个不差。
    // 两边任何一边多跳或少跳一种东西，这条就红
    const reached = [];
    const todo = [""];
    let calls = 0;
    while (todo.length) {
      const d = todo.shift();
      const L = wsb.listDir(R, d, LIST);
      calls++;
      for (const x of L.dirs) todo.push(x.path);
      for (const f of L.files) reached.push(f.name);
    }
    sameSet(reached, VISIBLE, `从根点下去能摸到的就是全部 ${VISIBLE.length} 个（点了 ${calls} 层）`);
    sameSet(wsb.walkAll(R, LIST).files.map((f) => f.name), reached, "★一层层点到的 = 全量走一趟数到的★");
  });

  await section("② 该藏的藏，不该藏的不藏", () => {
    const withData = wsb.listDir(R, "", {});
    ok(withData.dirs.some((d) => d.name === "data"), "反向对照：不告诉它数据目录在哪，data 就列出来了（证明上面藏它靠的是 appDataDir，不是名字）");
    const slash = wsb.listDir(R, "", { appDataDir: APPDATA + path.sep });
    ok(!slash.dirs.some((d) => d.name === "data"), "数据目录带不带结尾斜杠都认");
    const l1 = wsb.listDir(R, "L1", LIST);
    ok(l1.dirs.some((d) => d.name === "data"), "用户自己项目里叫 data 的文件夹照列（只藏恰好等于数据目录的那一个）");
    eq(wsb.listDir(R, "L1/data", LIST).files.map((f) => f.name).join(), "L1/data/自己的.csv", "点得进去，里面的文件也在");
    const all = wsb.walkAll(R, LIST).files.map((f) => f.name);
    ok(!all.some((n) => HIDDEN.includes(n)), "全量走也一个都不带出来", all.filter((n) => HIDDEN.includes(n)));
    ok(wsb.walkAll(R, {}).files.some((n) => n.name === "data/im-log.json"), "反向对照：全量走不给数据目录，im-log.json 就被数进来了");
    for (const [name, want] of [[".x", true], ["node_modules", true], [".git", true], [".tmp", true], [".openworkbuddy", true], ["data", false], ["报告.md", false]]) {
      eq(wsb.skipEntry(String(name), path.join(U, "别处", String(name)), APPDATA), want, `skipEntry(${name}) = ${want}（不在数据目录那个位置上）`);
    }
    eq(wsb.skipEntry("data", APPDATA, APPDATA), true, "skipEntry：恰好是数据目录那个位置就藏");
  });

  await section("③ 越界一律拒：..、绝对路径、链接", () => {
    const OUTSIDE = "只能看工作区里面的文件夹";
    for (const bad of ["..", "../x", "L1/..", "L1/../..", "L1/L2/../../.."]) throwsStatus(() => wsb.listDir(R, bad, LIST), 400, `「${bad}」→ 400`, OUTSIDE);
    for (const bad of ["/etc", "/", R, R + "/L1"]) {
      const label = bad === R ? "（工作区自己的绝对路径）" : bad === R + "/L1" ? "（工作区里 L1 的绝对路径）" : bad;
      throwsStatus(() => wsb.listDir(R, bad, LIST), 400, `绝对路径「${label}」→ 400`, OUTSIDE);
    }
    throwsStatus(() => wsb.listDir(R, "L1\0", LIST), 400, "带空字符 → 400");
    throwsStatus(() => wsb.listDir(R, "L1/L2/回环", LIST), 400, "路上有指回根的链接 → 400（不跟进去）", "链接");
    throwsStatus(() => wsb.listDir(R, "L1/外链", LIST), 400, "路上有指到外面的链接 → 400", "链接");
    throwsStatus(() => wsb.listDir(R, "L1/外链/..", LIST), 400, "链接后面再接 .. 也一样拒");
    throwsStatus(() => wsb.listDir(R, "L1/没有这层", LIST), 404, "不存在的文件夹 → 404（前端据此退回根）", "不在了");
    throwsStatus(() => wsb.listDir(R, "a.md", LIST), 400, "文件当文件夹点 → 400", "不是文件夹");
    for (const hid of ["node_modules", ".git", ".tmp", "data", "L1/L2/node_modules"]) throwsStatus(() => wsb.listDir(R, hid, LIST), 400, `藏起来的「${hid}」直接敲路径也进不去`);
    eq(wsb.listDir(R, "./L1/", LIST).dir, "L1", "「./L1/」规整成 L1（不是越界，只是写法）");
    // 反斜杠、盘符只在 Windows 上是路径：那边的规矩在这台机器上也走一遍（platform 每次现读）
    const asPlatform = (/** @type {string} */ p, /** @type {() => void} */ fn) => {
      const was = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: p, configurable: true });
      try { fn(); } finally { if (was) Object.defineProperty(process, "platform", was); }
    };
    asPlatform("win32", () => {
      throwsStatus(() => wsb.listDir(R, "..\\x", LIST), 400, "Windows：「..\\x」→ 400", OUTSIDE);
      for (const bad of ["C:/Windows", "c:\\x", "\\etc"]) throwsStatus(() => wsb.listDir(R, bad, LIST), 400, `Windows：绝对路径「${bad}」→ 400`, OUTSIDE);
      eq(wsb.listDir(R, "L1\\L2", LIST).dir, "L1/L2", "Windows：反斜杠当分隔符认");
    });
    if (process.platform !== "win32") {
      asPlatform("darwin", () => {
        // macOS/Linux 上反斜杠是名字里的一个字：这几个都只是「一个叫这名字的文件夹」，没有就 404，出不了根
        throwsStatus(() => wsb.listDir(R, "..\\x", LIST), 400, "macOS：「..\\x」是个点开头的名字，照藏（出不了根）");
        for (const bad of ["C:/Windows", "c:\\x", "\\etc", "L1\\L2"]) throwsStatus(() => wsb.listDir(R, bad, LIST), 404, `macOS：「${bad}」只是个名字，没有这个文件夹 → 404`, "不在了");
      });
      // 真有人把文件夹叫 a\b：列出来的路径原样送回去，点开的得是它自己。
      // x\y 旁边再摆一个真的 x/y——拆错了不是 404，是悄悄列成另一个文件夹
      const BS = path.join(U, "反斜杠");
      for (const [rel, body] of [["a\\b/甲.md", "甲"], ["x/y/乙.md", "乙"], ["x\\y/丙.md", "丙"]]) {
        const f = path.join(BS, rel);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, body);
      }
      const top = wsb.listDir(BS, "", LIST);
      sameSet(top.dirs.map((d) => d.path), ["a\\b", "x", "x\\y"], "macOS：名字带反斜杠的文件夹照列，路径就是它的名字");
      for (const d of top.dirs.filter((x) => x.path.includes("\\"))) {
        let got;
        try { got = wsb.listDir(BS, d.path, LIST); } catch (e) { got = { error: String(e && e.message), status: e && e.status }; }
        const want = d.path === "a\\b" ? "a\\b/甲.md" : "x\\y/丙.md";
        ok(!!got.files && got.dir === d.path && got.files.map((/** @type {{name:string}} */ f) => f.name).join() === want,
          `★macOS：点「${d.path}」进去的是它自己（${want}），不是 404、也不是别的文件夹★`, got);
      }
      const reach = [];
      for (const q = [""]; q.length;) {
        const L = wsb.listDir(BS, q.shift(), LIST);
        L.dirs.forEach((x) => q.push(x.path));
        L.files.forEach((f) => reach.push(f.name));
      }
      sameSet(reach, wsb.walkAll(BS, LIST).files.map((f) => f.name), "macOS：一层层点到的 = 全量走一趟数到的（带反斜杠的也算）");
    }

    // 根本身挂在链接底下：realpath 那道比对不能把正常的子目录误判成越界
    const viaAlias = wsb.listDir(path.join(U, "别名"), "L1/L2", LIST);
    eq(viaAlias.files.map((f) => f.name).join(), "L1/L2/d.md", "根是个链接（像 /tmp → /private/tmp）也照常往下点");
    eq(wsb.walkAll(path.join(U, "别名"), { appDataDir: path.join(U, "别名", "data") }).files.length, VISIBLE.length, "根是个链接，全量走也照常");

    const t0 = process.hrtime.bigint();
    const w = wsb.walkAll(R, LIST);
    const took = ms(t0);
    ok(took < 5000, `有指回根的链接，全量走照样走得完（${took.toFixed(1)} ms）`);
    ok(!w.files.some((f) => /回环|外链|外面|链到文件/.test(f.name)), "链接一个都没跟进去", w.files.filter((f) => /回环|外链|外面|链到文件/.test(f.name)).slice(0, 3));

    const missing = wsb.listDir(path.join(U, "还没建"), "", LIST);
    ok(missing.total === 0 && !missing.dirs.length && !missing.files.length && !missing.truncated, "工作区还没建出来：根是正常的空，不报错", missing);
    throwsStatus(() => wsb.listDir(path.join(U, "还没建"), "x", LIST), 404, "工作区还没建出来，点子目录 → 404");
  });

  await section("④ 一层太多就截、截了照实说；全量走撞线也照实说", () => {
    const cut = wsb.listDir(R, "宽", { ...LIST, cap: 5 });
    eq(cut.total, 13, "total 永远是真实条数（3 个文件夹 + 10 个文件）");
    eq(cut.truncated, true, "截了就说截了");
    eq(cut.dirs.map((d) => d.name).join(","), "第1集,第2集,第10集", "文件夹一个不丢，名字按数字大小排（第 2 集在第 10 集前面）");
    eq(cut.files.map((f) => f.base).join(","), "f9.md,f8.md", "剩下的位置留给最新的文件");
    const whole = wsb.listDir(R, "宽", { ...LIST, cap: 100 });
    eq(whole.truncated, false, "放得下就不截");
    eq(whole.files.map((f) => f.base).join(","), Array.from({ length: 10 }, (_, i) => `f${9 - i}.md`).join(","), "文件新的在前");
    eq(wsb.LIST_CAP, 3000, "默认一层最多回 3000 条");

    // 截掉的那些要够得着：按 offset 往后翻，一页一页拼起来就是这一层的全部，不多不少不重
    ok(cut.offset === 0 && cut.cap === 5 && cut.by_name === false && cut.dirs_cut === false, "第一页：offset=0、cap=5、文件按新旧排、文件夹全在这页",
      { offset: cut.offset, cap: cut.cap, by_name: cut.by_name, dirs_cut: cut.dirs_cut });
    const p2 = wsb.listDir(R, "宽", { ...LIST, cap: 5, offset: 5 });
    ok(p2.offset === 5 && !p2.dirs.length && p2.files.map((f) => f.base).join(",") === "f7.md,f6.md,f5.md,f4.md,f3.md" && p2.truncated,
      "offset=5：接着往下是 f7…f3（新的在前），还是照实说截了", { offset: p2.offset, files: p2.files.map((f) => f.base) });
    const p3 = wsb.listDir(R, "宽", { ...LIST, cap: 5, offset: 10 });
    eq(p3.files.map((f) => f.base).join(","), "f2.md,f1.md,f0.md", "offset=10：最后一页是最旧的三个");
    const pages = [cut, p2, p3].flatMap((p) => [...p.dirs.map((d) => d.path), ...p.files.map((f) => f.name)]);
    sameSet(pages, ["宽/第1集", "宽/第2集", "宽/第10集", ...Array.from({ length: 10 }, (_, i) => `宽/f${i}.md`)], "三页拼起来 = 这一层全部 13 项，一个不重");
    eq(wsb.listDir(R, "宽", { ...LIST, cap: 5, offset: 999 }).offset, 10, "翻过头：退回末页开头（10），不给一张空页");
    for (const bad of ["abc", -3, "", null, "2.9e999"]) eq(wsb.listDir(R, "宽", { ...LIST, cap: 5, offset: bad }).offset, bad === "2.9e999" ? 10 : 0, `offset=${JSON.stringify(bad)}：按 0 算（或退回末页），不炸`);
    const d2 = wsb.listDir(R, "宽", { ...LIST, cap: 2 });
    ok(d2.dirs_cut === true && d2.dirs.map((d) => d.name).join(",") === "第1集,第2集" && !d2.files.length, "文件夹多过一页：dirs_cut=true（界面据此不说「文件夹全在」）", d2);
    const d2b = wsb.listDir(R, "宽", { ...LIST, cap: 2, offset: 2 });
    ok(d2b.dirs.map((d) => d.name).join(",") === "第10集" && d2b.files.map((f) => f.base).join(",") === "f9.md" && d2b.dirs_cut === true,
      "第二页：剩下那个文件夹 + 最新的文件；截掉的文件夹也点得到", { dirs: d2b.dirs.map((d) => d.name), files: d2b.files.map((f) => f.base) });

    const w = wsb.walkAll(R, LIST);
    eq(w.capped, false, "全量走没撞线：capped=false");
    ok(w.files.every((f, i) => i === 0 || w.files[i - 1].mtime >= f.mtime), "全量结果新的在前");
    ok(w.files.every((f) => typeof f.size === "number" && /Z$/.test(f.mtime)), "每条带体积和 ISO 时间");

    const shallow = wsb.walkAll(R, { ...LIST, maxDepth: 3 });
    eq(shallow.capped, true, "层数撞线（maxDepth=3）：capped=true");
    sameSet(shallow.files.map((f) => f.name), VISIBLE.filter((n) => segs(n) <= 3), "maxDepth=3：恰好是三段以内的那些");

    eq(wsb.walkAll(R, { ...LIST, cap: VISIBLE.length }).capped, false, `条数刚好等于上限（${VISIBLE.length}）不算撞线`);
    const c21 = wsb.walkAll(R, { ...LIST, cap: VISIBLE.length - 1 });
    ok(c21.capped && c21.files.length === VISIBLE.length - 1, "少一个名额：capped=true，条数就是上限", { capped: c21.capped, n: c21.files.length });
    // 按层走：撞线时留下来的是浅的——根下那两个一定在
    sameSet(wsb.walkAll(R, { ...LIST, cap: 2 }).files.map((f) => f.name), ["a.md", "b.txt"], "按层走：只给两个名额时留下的是根下那两个");

    ok(Object.isFrozen(w) && Object.isFrozen(w.files), "结果是冻住的");
    let threw = false;
    try { /** @type {any} */ (w.files).push({ name: "x", size: 0, mtime: "" }); } catch { threw = true; }
    ok(threw, "往结果里塞东西直接抛（几条请求共用一份，谁改了都会串到别人那里）");
  });

  await section("⑤ 几秒的记忆", () => {
    let t = 1000, calls = 0;
    const m = wsb.createMemo(3000, () => t);
    const v1 = m.get("k", () => ({ n: ++calls }));
    t += 2999;
    const v2 = m.get("k", () => ({ n: ++calls }));
    ok(v1 === v2 && calls === 1, "TTL 之内：同一份，不重算", { calls });
    t += 1;
    const v3 = m.get("k", () => ({ n: ++calls }));
    ok(v3 !== v1 && calls === 2, "到点：重算", { calls });
    m.get("别的", () => ({ n: ++calls }));
    eq(m.size(), 2, "两个键各记各的");
    t += 3000;
    m.get("第三个", () => ({ n: ++calls }));
    eq(m.size(), 1, "过期的键顺手清掉（多组织服务器上不会一直攒着）");
    m.clear();
    eq(m.size(), 0, "clear 清空");

    wsb.walkMemo.clear();
    const t0 = Date.now();
    const a = wsb.walkAllCached(R, LIST);
    const b = wsb.walkAllCached(R, LIST);
    ok(a === b, "walkAllCached：几秒之内第二次拿的是同一份");
    put("新来的.md");
    const c = wsb.walkAllCached(R, LIST);
    if (Date.now() - t0 < 2500) ok(c === a && c.files.length === VISIBLE.length, "几秒之内新文件还没被看见（下一次重画就对上）", c.files.length);
    else console.log("  - 机器太慢，两次调用隔了超过 2.5 秒，「几秒之内还是旧的」这条不判");
    ok(wsb.walkAllCached(R, {}) !== a, "数据目录不同算不同的键（切项目、切组织各算各的）");
    wsb.walkMemo.clear();
    const d = wsb.walkAllCached(R, LIST);
    ok(d.files.length === VISIBLE.length + 1 && d.files.some((f) => f.name === "新来的.md"), "clear 之后立刻看见新文件", d.files.length);
    fs.rmSync(path.join(R, "新来的.md"));
    wsb.walkMemo.clear();
  });

  await section("⑥ 跟文件面板共用一份「跳过谁」", () => {
    // 桌面版的真实布局：工作区就是数据根，data/ 在它里面。把 tools.js 的工作区指到 HOME，
    // outputFiles() 的数据目录是 dataPath("data") = HOME/data，正好落在工作区里
    fs.mkdirSync(path.join(HOME, "data"), { recursive: true });
    fs.writeFileSync(path.join(HOME, "data", "im-log.json"), "[]");
    fs.mkdirSync(path.join(HOME, "资料", "data"), { recursive: true });
    fs.writeFileSync(path.join(HOME, "资料", "data", "我的.csv"), "a,b");
    fs.writeFileSync(path.join(HOME, "资料", "报告.md"), "# 报告");
    const tools = require(path.join(ROOT, "tools"));
    tools.setWorkspaceDir(HOME);
    const panel = tools.outputFiles().map((/** @type {{name:string}} */ f) => f.name);
    ok(panel.length > 0 && panel.length < 500, `文件面板那份没被 500 条截断（${panel.length} 条），下面的比对才算数`);
    const mine = wsb.walkAll(HOME, { appDataDir: path.join(HOME, "data"), maxDepth: 3 }).files.map((f) => f.name);
    sameSet(panel, mine, "★outputFiles() 前三层列的 = 资料库前三层数的★（一边多跳一种，这条当场红）");
    ok(!panel.some((n) => n.startsWith("data/")), "两边都不把应用数据目录当成果");
    ok(panel.includes("资料/data/我的.csv"), "两边都照列用户自己叫 data 的文件夹");
    ok(!panel.some((n) => segs(n) > 3) && mine.length === panel.length, "文件面板仍然只看三层（那几处要的是「最近动过什么」，这次不动它）");
    const src = fs.readFileSync(path.join(ROOT, "tools.js"), "utf8");
    const body = src.slice(src.indexOf("function outputFiles()"), src.indexOf("function outputFiles()") + 3000);
    ok(/skipEntry\(e\.name, full, APP_DATA_DIR\)/.test(body) && /require\("\.\/lib\/ws-browse"\)/.test(body), "outputFiles 用的就是 lib/ws-browse 的 skipEntry，不是自己抄的一份");
  });

  await section("⑦ 两万个文件：走得多快、撞没撞线", () => {
    // 用户真实工作区是 1712 个文件；这里造一个比上限还多一个的，看撞线和耗时
    const big = path.join(HOME, "big");
    const PER = 200, DIRS = wsb.WALK_CAP / PER;
    const t0 = process.hrtime.bigint();
    for (let d = 0; d < DIRS; d++) {
      const dir = path.join(big, `批次${String(d).padStart(3, "0")}`, "子");
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < PER; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "");
    }
    fs.writeFileSync(path.join(big, "多一个.md"), "");
    console.log(`  · 造了 ${wsb.WALK_CAP + 1} 个文件（${ms(t0).toFixed(0)} ms）`);
    const t1 = process.hrtime.bigint();
    const capped = wsb.walkAll(big);
    const cold = ms(t1);
    eq(capped.files.length, wsb.WALK_CAP, `默认上限 ${wsb.WALK_CAP}：多出来的那个不装进来`);
    eq(capped.capped, true, "撞了条数的线：capped=true（「未归属」据此写「N+ 个」）");
    ok(capped.files.some((f) => f.name === "多一个.md"), "撞线时根下那个浅的在（按层走）");
    const t2 = process.hrtime.bigint();
    const full = wsb.walkAll(big, { cap: wsb.WALK_CAP + 1 });
    const again = ms(t2);
    ok(full.files.length === wsb.WALK_CAP + 1 && !full.capped, "上限放宽一个：全数、没撞线", { n: full.files.length, capped: full.capped });
    console.log(`  · 两万个文件走一趟：${cold.toFixed(1)} ms（第一次）/ ${again.toFixed(1)} ms（第二次）`);
    // 这台机器上常年十来个任务一起跑，耗时只卡一条很宽的线：防的是退化成平方级那种，不是抠毫秒
    ok(cold < 20000 && again < 20000, "两万个文件 20 秒内走完", { cold, again });
    wsb.walkMemo.clear();
    const t3 = process.hrtime.bigint();
    const m1 = wsb.walkAllCached(big);
    const miss = ms(t3);
    const t4 = process.hrtime.bigint();
    const m2 = wsb.walkAllCached(big);
    const hit = ms(t4);
    ok(m1 === m2, `记住了：第二次拿的是同一份（没记住 ${miss.toFixed(1)} ms / 记住了 ${hit.toFixed(2)} ms）`);
    wsb.walkMemo.clear();
    fs.rmSync(big, { recursive: true, force: true });
  });

  await section("⑦b 一层两万多个文件：不排新旧、按名字翻，最后一个也翻得到", () => {
    // 以前：多过 STAT_CAP 就按名字留前两万个再排新旧，名字排在两万名以后的（往往就是最新的那几帧）哪儿都到不了，
    // 界面还说「文件是最新的那些，更早的用搜索找」——而搜索那趟全量也撞了线，一样搜不到
    const flat = path.join(HOME, "flat");
    fs.mkdirSync(flat, { recursive: true });
    const N = wsb.STAT_CAP + 5;
    const nm = (/** @type {number} */ i) => `frame_${String(i).padStart(6, "0")}.png`;
    for (let i = 0; i < N; i++) fs.writeFileSync(path.join(flat, nm(i)), "");
    const newest = new Date(Date.now() + 60e3);
    fs.utimesSync(path.join(flat, nm(N - 1)), newest, newest); // 名字最靠后的那个也是最新的
    const t0 = process.hrtime.bigint();
    const first = wsb.listDir(flat, "", {});
    const t1 = ms(t0);
    ok(first.by_name === true && first.total === N && first.truncated && first.files.length === wsb.LIST_CAP, "多过 STAT_CAP：by_name=true，一页照旧 3000 条，total 是真数",
      { by_name: first.by_name, total: first.total, n: first.files.length });
    eq(first.files[0].base + "," + first.files[wsb.LIST_CAP - 1].base, nm(0) + "," + nm(wsb.LIST_CAP - 1), "第一页是按名字排的前 3000 个");
    const seen = new Set(first.files.map((f) => f.base));
    let off = first.offset, pages = 1, last = first;
    while (off + wsb.LIST_CAP < N && pages < 20) {
      off += wsb.LIST_CAP;
      last = wsb.listDir(flat, "", { offset: off });
      last.files.forEach((f) => seen.add(f.base));
      pages++;
    }
    eq(seen.size, N, `一页页往后翻（${pages} 页）：${N} 个文件一个不少、不重`);
    ok(last.files.some((f) => f.base === nm(N - 1) && f.mtime === newest.toISOString()), "★名字排在两万名以后的那个（也是最新的）翻得到，体积时间照带★", last.files.slice(-2));
    ok(last.files.length === N % wsb.LIST_CAP || last.files.length === wsb.LIST_CAP, "末页条数对得上", last.files.length);
    console.log(`  · ${N} 个文件的一层，列一页 ${t1.toFixed(0)} ms`);
    fs.rmSync(flat, { recursive: true, force: true });
  });

  await section("⑦c 本回合产出：第 4 层往下写的、改的都差得出来（不拿 outputFiles 做差）", () => {
    // 用户看到的：agent 把成品写进「任务_x/site/assets/img/」，文件在，对话里「本回合产出」一张卡都没有。
    // 以前拿 outputFiles()（最深 3 层、最新 500 条）前后各拍一份做差，第 4 层往下两份里都没有
    const tools = require(path.join(ROOT, "tools"));
    const { makeFilesEmitter, makeOwnership } = require(path.join(ROOT, "agent"));
    tools.setWorkspaceDir(HOME); // 跟 ⑥ 一样：应用数据目录 HOME/data 落在工作区里
    const BASE = "任务_深";
    const abs = (/** @type {string} */ rel) => path.join(HOME, rel);
    const wput = (/** @type {string} */ rel, body = "x") => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body); };
    const OLD5 = `${BASE}/site/assets/css/旧.css`;  // 第五层，开跑前就在
    const NEW5 = `${BASE}/site/assets/img/新.png`;  // 第五层，这回合新写
    wput(OLD5, "a{}");
    const past = new Date(Date.now() - 60e3);
    fs.utimesSync(abs(OLD5), past, past);
    const names = (/** @type {any[]} */ a) => (a || []).map((f) => f.name);
    const evs = /** @type {any[]} */ ([]);
    const own = makeOwnership();
    own.claimBaseDir(BASE, "run-deep");
    // 先把资料库那份带记忆的全量拍一次：本回合的差要是走了它，3 秒内的第二份就是第一份，差不出东西
    wsb.walkMemo.clear();
    wsb.walkAllCached(HOME, { appDataDir: path.join(HOME, "data") });
    const em = makeFilesEmitter({ emit: (e) => evs.push(e), ownership: own, baseDir: BASE, runToken: "run-deep" });
    try {
      wput(NEW5, "png");
      wput(OLD5, "a{color:red}");
      const SKIPPED = [`${BASE}/.tmp/a/b/c.md`, `${BASE}/node_modules/p/q/r.js`, `${BASE}/.git/objects/ab/cd`, `${BASE}/.隐藏/深/深.md`, "data/sessions/深/一/二.json"];
      SKIPPED.forEach((r) => wput(r));
      em.push(true);
      const e1 = evs[evs.length - 1] || { changed: [], files: [] };
      ok(evs.length === 1 && e1.changed.includes(NEW5), "★第五层新写的文件：changed 里有★（带记忆的全量刚拍过，也没挡住）", e1.changed);
      ok(e1.changed.includes(OLD5), "★第五层原来就在、这回合改写的：changed 里有★", e1.changed);
      const t1 = new Map((e1.turn_files || []).map((/** @type {any} */ f) => [f.name, f]));
      ok(t1.has(NEW5) && t1.get(NEW5).size === 3 && t1.has(OLD5) && t1.get(OLD5).size === 12, "turn_files 带着这两个的体积和时间（files 那份里没有它们，前端靠它画卡）", e1.turn_files);
      ok(!e1.changed.some((/** @type {string} */ n) => SKIPPED.includes(n)) && !(e1.turn_files || []).some((/** @type {any} */ f) => SKIPPED.includes(f.name)),
        "跳过的照旧跳过：.tmp、node_modules、.git、点开头的、应用自己的 data/", e1.changed);
      sameSet(names(e1.files), names(tools.outputFiles()), "files 仍是 outputFiles() 那份（面板、@ 补全的口径不动）");
      ok(!names(e1.files).some((n) => segs(n) > 3), "  └ 仍然最深 3 层");
      ok(!("scan_capped" in e1), "没撞上限：不带 scan_capped");

      wput(`${BASE}/说明.md`, "说明");
      em.push(true);
      const e2 = evs[evs.length - 1];
      ok(evs.length === 2 && e2.changed.join() === `${BASE}/说明.md` && names(e2.turn_files).includes(NEW5) && names(e2.turn_files).includes(OLD5),
        "后面的事件接着带前面报过的深处产出（前端拿 files ∪ turn_files 判「已删除」，不带就误撤卡）", e2 && { changed: e2.changed, turn: names(e2.turn_files) });
      em.push(true);
      eq(evs.length, 2, "盘上没动：不再发一条一模一样的");

      fs.rmSync(abs(NEW5));
      em.push(true);
      const e3 = evs[evs.length - 1];
      ok(evs.length === 3 && !names(e3.turn_files).includes(NEW5) && names(e3.turn_files).includes(OLD5) && e3.full !== false,
        "删掉的深处产出：从 turn_files 里划掉，清单仍是全的（前端据此撤那张卡）", e3 && { turn: names(e3.turn_files), full: e3.full });

      // 第十三层：本回合的比对不卡层数（资料库那条「最深 12 层」不用在这里），文件夹里外都差得出来，也不报 scan_capped
      const D13 = `${BASE}/2/3/4/5/6/7/8/9/10/11/12/十三.md`;
      const FAR = "别处/2/3/4/5/6/7/8/9/10/11/12/外.md";
      wput(D13); wput(FAR);
      em.push(true);
      const e4 = evs[evs.length - 1];
      ok(e4.changed.includes(D13) && names(e4.turn_files).includes(D13), "第十三层：本回合自己文件夹里的差得出来", e4.changed);
      ok(e4.changed.includes(FAR) && names(e4.turn_files).includes(FAR), "  └ 文件夹外面的第十三层也差得出来（不卡层数）", e4.changed);
      ok(!("scan_capped" in e4), "  └ 条数没撞线：不带 scan_capped（深不等于没数全）", e4 && Object.keys(e4));
      fs.rmSync(abs("别处"), { recursive: true, force: true });
      fs.rmSync(abs(`${BASE}/2`), { recursive: true, force: true });

      // turn_files 一次最多带 500 条：截了就 full:false，前端不拿这份判「已删除」
      for (let i = 0; i < 501; i++) wput(`${BASE}/批/深/${String(i).padStart(3, "0")}.txt`, "b");
      em.push(true);
      const e5 = evs[evs.length - 1];
      ok(e5.changed.length === 501 && (e5.turn_files || []).length === 500 && e5.full === false,
        "一回合写了 501 个深处文件：changed 501 条、turn_files 截到 500、full=false（不静默丢，也不误撤卡）", e5 && { changed: e5.changed.length, turn: (e5.turn_files || []).length, full: e5.full });
    } finally {
      em.stop();
      wsb.walkMemo.clear();
      fs.rmSync(abs(BASE), { recursive: true, force: true });
      fs.rmSync(abs("别处"), { recursive: true, force: true });
      fs.rmSync(abs("data/sessions/深"), { recursive: true, force: true });
    }
  });

  await section("⑦d 本回合产出：只有条数撞线才报 scan_capped；撞线时报过的产出不丢、自己文件夹照样补走", () => {
    const tools = require(path.join(ROOT, "tools"));
    const { makeFilesEmitter, makeOwnership } = require(path.join(ROOT, "agent"));
    tools.setWorkspaceDir(HOME);
    const abs = (/** @type {string} */ rel) => path.join(HOME, rel);
    const past = new Date(Date.now() - 60e3);
    const wput = (/** @type {string} */ rel, old = false) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), "x");
      if (old) fs.utimesSync(abs(rel), past, past);
    };
    const names = (/** @type {any[]} */ a) => (a || []).map((f) => f.name);
    const B = "任务_撞线";
    const JAVA = "旧项目/src/main/java/com/acme/app/core/impl/v1/util/deep/X.java"; // 13 层，开跑前就在
    const OLD = ["旧0.md", "旧1.md", "旧2.md"];
    const OUT4 = "别处2/a/b/外.md"; // 本回合写在文件夹外面、第 4 层：面板那份（最深 3 层）里没有它
    const IN5 = `${B}/x/y/z/深.md`;
    const NEW5 = `${B}/新/深/深/新.md`;
    // 条数上限两万个，测试里不真造两万个文件：把整个工作区那一趟的上限压到 1（自己文件夹那趟补走不压）。
    // turnSnapshot 每次现取 require("./lib/ws-browse").walkAll，换这个导出就换到了它手上
    const realWalk = wsb.walkAll;
    let squeeze = false;
    wsb.walkAll = (root, o) => realWalk(root, squeeze && path.resolve(root) === path.resolve(HOME) ? { ...o, cap: 1 } : o);
    /** @type {any[]} */
    const evs = [];
    let em = null;
    try {
      // 用户那种工作区：一条老 Java 工程的 13 层目录链，这回合只写了一份报告
      OLD.forEach((r) => wput(r, true));
      wput(JAVA, true);
      const snap0 = tools.turnSnapshot(B);
      ok(!snap0.capped && snap0.files.some((f) => f.name === JAVA), "★工作区里躺着一条 13 层的老目录链：整树那趟照样走到底，不报 capped★", { capped: snap0.capped, n: snap0.files.length });
      const own = makeOwnership();
      own.claimBaseDir(B, "run-cap");
      em = makeFilesEmitter({ emit: (e) => evs.push(e), ownership: own, baseDir: B, runToken: "run-cap" });
      wput(`${B}/报告.md`);
      em.push(true);
      const e1 = evs[evs.length - 1] || {};
      ok(evs.length === 1 && e1.changed.join() === `${B}/报告.md` && !("scan_capped" in e1),
        "★  └ 这回合写的报告照报，事件不带 scan_capped（以前每一回合都挂「可能没列全」）★", e1 && { changed: e1.changed, capped: e1.scan_capped });

      wput(OUT4); wput(IN5);
      em.push(true);
      const e2 = evs[evs.length - 1];
      ok(e2.changed.includes(OUT4) && e2.changed.includes(IN5) && names(e2.turn_files).includes(OUT4), "没撞线时：文件夹外第 4 层、文件夹里第 5 层都报了", e2 && e2.changed);

      squeeze = true; // 之后的每一趟：整个工作区只数得到 1 个文件就撞线
      em.push(true);
      const e3 = evs[evs.length - 1];
      ok(evs.length === 3 && e3.scan_capped === true, "条数撞线：事件带 scan_capped（前端写「可能没列全」）", e3 && Object.keys(e3));
      ok(names(e3.turn_files).includes(OUT4),
        "★  └ 撞线后这一趟没走到的、前面报过的产出（文件还在）：turn_files 里接着带（逐个 stat 过），不当成删了★", e3 && names(e3.turn_files));
      ok(names(e3.turn_files).includes(IN5), "  └ 自己文件夹里的靠补走一遍，照样在", e3 && names(e3.turn_files));

      wput(NEW5);
      em.push(true);
      const e4 = evs[evs.length - 1];
      ok(e4.changed.includes(NEW5) && e4.scan_capped === true, "撞线时自己文件夹里新写的第 5 层：补走差得出来，scan_capped 仍照实带着（文件夹外面没走到）", e4 && { changed: e4.changed, capped: e4.scan_capped });

      fs.rmSync(abs("别处2"), { recursive: true, force: true });
      em.push(true);
      const e5 = evs[evs.length - 1];
      ok(!names(e5.turn_files).includes(OUT4) && names(e5.turn_files).includes(IN5) && e5.full !== false,
        "  └ 没走到的那份真删了：stat 不到就从 turn_files 划掉（前端据此撤卡）", e5 && names(e5.turn_files));
    } finally {
      wsb.walkAll = realWalk;
      if (em) em.stop();
      for (const r of [B, "旧项目", "别处2", ...OLD]) fs.rmSync(abs(r), { recursive: true, force: true });
    }
  });

  await section("⑧ 真起 server.js：tree 路由、全量计数、搜索", async () => {
    const WS = path.join(HOME, "workspace");
    const OUTSIDE = path.join(HOME, "outside");
    const DEEP7 = "项目/一/二/三/四/五/第七层.md";
    const wput = (/** @type {string} */ rel, body = "x") => {
      const f = path.join(WS, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    };
    wput(DEEP7, "# 第七层\n藏得很深的那份周报\n");
    wput("根.md", "# 根");
    const BULK = 450;
    for (let i = 0; i < BULK; i++) wput(`批量/f${String(i).padStart(3, "0")}.txt`, "b");
    wput(".tmp/临时.md");
    wput("node_modules/x/index.js");
    wput(".隐藏.md");
    fs.mkdirSync(OUTSIDE, { recursive: true });
    fs.writeFileSync(path.join(OUTSIDE, "外面.md"), "外面");
    fs.symlinkSync(OUTSIDE, path.join(WS, "项目", "外链"));
    fs.symlinkSync(WS, path.join(WS, "项目", "一", "回环"));
    const TOTAL = BULK + 2;

    // 一次对话认领了两个：根.md 和第七层那个。未归属应当是剩下的全部
    const at = new Date().toISOString();
    fs.mkdirSync(path.join(HOME, "data", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(HOME, "data", "sessions", "s_deep.json"), JSON.stringify({
      id: "s_deep", title: "周报", user: "lib", updated_at: at,
      transcript: [{ type: "assistant", at, events: [{ type: "files", changed: ["根.md", DEEP7] }] }],
    }));
    // 第十三层：全量那趟（最深 12 层）走不到。文件等到最后才写，前面那些「数全了」的断言不受影响
    const D13 = "深/2/3/4/5/6/7/8/9/10/11/12/十三层.md";
    fs.writeFileSync(path.join(HOME, "data", "sessions", "s_d13.json"), JSON.stringify({
      id: "s_d13", title: "十三层任务", user: "lib", updated_at: at,
      transcript: [{ type: "assistant", at, events: [{ type: "files", changed: [D13] }] }],
    }));
    const token = "lib" + crypto.randomBytes(12).toString("hex");
    fs.writeFileSync(path.join(HOME, "data", "users.json"), JSON.stringify({
      users: [{ username: "lib", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
      tokens: { [token]: { user: "lib", at: Date.now() } },
    }));
    // ⑥ 那段把 tools.js 的工作区指到了 HOME，那是本进程里的事；子进程自己读 config，工作区是 HOME/workspace
    fs.rmSync(path.join(HOME, "资料"), { recursive: true, force: true });

    const booted = bootRealServer({ OPENWORKBUDDY_HOME: HOME }, { timeoutMs: 120000 });
    serverChild = booted.child;
    const { up, port, why } = await booted.wait();
    ok(up, "真 server.js 起来了", up ? undefined : why);
    if (!up) return;
    const get = (/** @type {string} */ p) => new Promise((resolve) => {
      const rq = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { Cookie: "openworkbuddy_token=" + token } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(body); } catch {}
          resolve({ code: res.statusCode, body, json });
        });
      });
      rq.on("error", (e) => resolve({ code: 0, body: e.message, json: null }));
      rq.end();
    });
    const tree = (/** @type {string} */ dir) => get("/api/files/tree" + (dir === undefined ? "" : "?dir=" + encodeURIComponent(dir)));
    try {
      const top = await tree(undefined);
      eq(top.code, 200, "GET /api/files/tree → 200");
      const tj = top.json || {};
      sameSet((tj.dirs || []).map((d) => d.name), ["项目", "批量"], "根：项目、批量；.tmp、node_modules 藏了");
      eq(((tj.dirs || []).find((d) => d.name === "批量") || {}).count, BULK, `批量 那一行写着 ${BULK} 项`);
      sameSet((tj.files || []).map((f) => f.name), ["根.md"], "根：一个文件，.隐藏.md 不在");
      ok(typeof tj.root === "string" && tj.root.length === 8, "回工作区的键（跟 /api/files 一个口径）", tj.root);

      let dir = "", last = tj;
      for (const name of ["项目", "一", "二", "三", "四", "五"]) {
        const row = (last.dirs || []).find((d) => d.name === name);
        if (!row) { ok(false, `往下点：${dir || "根"} 里找不到「${name}」`, last.dirs); return; }
        dir = row.path;
        const r = await tree(dir);
        if (r.code !== 200) { ok(false, `往下点：${dir} → HTTP ${r.code}`, r.body.slice(0, 200)); return; }
        last = r.json;
      }
      ok((last.files || []).some((f) => f.name === DEEP7 && f.base === "第七层.md"), "顺着 dirs[].path 点六下，第七层的文件就在那儿（完整相对路径）", last.files);
      eq((last.crumbs || []).map((c) => c.name).join("/"), "项目/一/二/三/四/五", "面包屑一路带着");
      const proj = (await tree("项目")).json || {};
      ok(!(proj.dirs || []).some((d) => d.name === "外链"), "指到外面的链接不列", proj.dirs);
      const one = (await tree("项目/一")).json || {};
      ok(!(one.dirs || []).some((d) => d.name === "回环"), "指回根的链接不列", one.dirs);

      for (const [bad, code, why2] of [
        ["..", 400, "上一层"], ["项目/../..", 400, "绕一圈再出去"], ["/etc", 400, "绝对路径"], [WS, 400, "工作区自己的绝对路径"],
        ["项目/外链", 400, "链接"], ["项目/一/回环", 400, "回环链接"], [".tmp", 400, "藏起来的临时区"], ["node_modules", 400, "依赖"],
        ["根.md", 400, "文件当文件夹"], ["项目/没有这层", 404, "已经不在的文件夹"],
      ]) {
        const r = await tree(String(bad));
        ok(r.code === code && r.json && typeof r.json.error === "string" && r.json.error.length > 0, `?dir=（${why2}）→ ${code}，带一句人话`, { code: r.code, body: r.body.slice(0, 120) });
      }

      const dl = await get("/api/files/download/" + DEEP7.split("/").map(encodeURIComponent).join("/"));
      ok(dl.code === 200 && dl.body.includes("藏得很深的那份周报"), "第七层的文件按列出来的路径打得开", { code: dl.code, body: dl.body.slice(0, 80) });

      const o = await get("/api/library/outputs");
      eq(o.code, 200, "GET /api/library/outputs → 200");
      const oj = o.json || {};
      eq(oj.ws_total, TOTAL, `ws_total 是整个工作区的文件数（${TOTAL}，含第七层；藏起来的、链接后面的都不算）`);
      eq(oj.ws_capped, false, "ws_capped=false：数全了");
      eq(oj.orphan_total, TOTAL - 2, `orphan_total 是全量（${TOTAL} 减去任务认领的 2 个）`);
      eq((oj.orphans || []).length, 200, "不带 orphan_limit：只回 200 条（文件夹视图、搜索用不着全量）");
      ok(!(oj.orphans || []).some((f) => f.name === DEEP7 || f.name === "根.md"), "被任务认领的不进未归属");
      const task = (oj.tasks || []).find((x) => x.id === "s_deep");
      const deepRow = task && task.files.find((f) => f.name === DEEP7);
      ok(deepRow && deepRow.gone === false && deepRow.size > 0, "任务里第七层那个文件：在、有体积（按全量认领，不是回头一个个 stat 猜）", task && task.files);
      eq(tj.root, oj.root, "tree 和 outputs 说的是同一个工作区");

      const all = (await get("/api/library/outputs?orphan_limit=20000")).json || {};
      eq((all.orphans || []).length, TOTAL - 2, "orphan_limit=20000：未归属一条不少全回来（「按任务」翻得完）");
      eq((await get("/api/library/outputs?orphan_limit=999999")).json.orphans.length, TOTAL - 2, "orphan_limit 超上限按两万算，不报错");
      eq((await get("/api/library/outputs?orphan_limit=abc")).json.orphans.length, 200, "orphan_limit 乱写就按默认 200");

      const s = (await get("/api/library/search?q=" + encodeURIComponent("第七层"))).json || {};
      ok((s.ws || []).some((f) => f.name === DEEP7), "搜名字：第七层的文件搜得到（以前只搜最近 500 个、最深 3 层）", (s.ws || []).map((f) => f.name));
      const s2 = (await get("/api/library/search?q=" + encodeURIComponent("藏得很深"))).json || {};
      ok((s2.ws || []).some((f) => f.name === DEEP7 && (f.by === "text" || f.by === "both")), "搜正文：第七层的文件也搜得到", s2.ws);
      eq(s.ws_capped, false, "全量没撞线：搜索回 ws_capped=false（界面才说「都翻过了」）");

      const pg = (await get("/api/files/tree?dir=" + encodeURIComponent("批量") + "&offset=400")).json || {};
      ok(pg.offset === 400 && (pg.files || []).length === BULK - 400 && pg.total === BULK && pg.truncated === true,
        "tree 路由把 offset 带给 listDir：批量 第 401 条往后", { offset: pg.offset, n: (pg.files || []).length, total: pg.total });
      const pgBad = (await get("/api/files/tree?dir=" + encodeURIComponent("批量") + "&offset=abc")).json || {};
      ok(pgBad.offset === 0 && (pgBad.files || []).length === BULK, "offset 乱写按 0 算", { offset: pgBad.offset, n: (pgBad.files || []).length });

      // 走一趟的结果记几秒：刚才那几条请求都打过了，现在加一个文件，
      // 过了记忆期再问一次，总数就该对上（不用重启、不用手动刷新）
      wput("项目/一/二/三/四/五/六/第八层.md", "新来的");
      wput(D13, "十三层的正文");
      await new Promise((r) => setTimeout(r, 3200));
      eq(((await get("/api/library/outputs")).json || {}).ws_total, TOTAL + 1, "几秒之后再问：新加的第八层文件数进来了");

      // 第十三层：全量那趟走不到（撞了层数的线）。搜索得照实说没搜全；任务里那个文件还在，不能判成「已不在」
      const s13 = (await get("/api/library/search?q=" + encodeURIComponent("十三层"))).json || {};
      eq(s13.ws_capped, true, "全量撞了线：搜索回 ws_capped=true（界面据此不说「都翻过了」）");
      const t13 = (s13.tasks || []).find((x) => x.id === "s_d13");
      const f13 = t13 && t13.files.find((f) => f.name === D13);
      ok(!!f13 && f13.gone === false && f13.size > 0, "★任务里第十三层那个文件：全量里没有就再 stat 一眼——还在，不判「已不在」★", t13 && t13.files);
      const t7 = ((await get("/api/library/search?q=" + encodeURIComponent("周报"))).json || {}).tasks || [];
      const f7 = (t7.find((x) => x.id === "s_deep") || { files: [] }).files.find((f) => f.name === DEEP7);
      ok(!!f7 && f7.gone === false && f7.size > 0, "反向对照：全量里有的照旧直接用", f7);
      fs.rmSync(path.join(WS, D13));
      const s13b = (await get("/api/library/search?q=" + encodeURIComponent("十三层"))).json || {};
      const f13b = ((s13b.tasks || []).find((x) => x.id === "s_d13") || { files: [] }).files.find((f) => f.name === D13);
      ok(!!f13b && f13b.gone === true, "反向对照：真删了的才判「已不在」", f13b);
      const deepDir = D13.split("/").slice(0, -1).join("/");
      wput(D13, "十三层的正文");
      const lt = (await tree(deepDir)).json || {};
      ok((lt.files || []).some((f) => f.name === D13), "全量走不到的第十三层，一层层点进去照样列得出来", lt);
    } finally {
      try { booted.child.kill(); } catch {}
    }
  });

  await section("⑨ 路由接线：跟 /api/files 同一个根、同一个数据目录", () => {
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    const at = src.indexOf('app.get("/api/files/tree"');
    const route = src.slice(at, src.indexOf("\n});", at));
    ok(at > 0 && /getWorkspaceDir\(\)/.test(route) && /appDataDir: dataPath\("data"\)/.test(route), "tree 路由：根是 getWorkspaceDir()（租户作用域），藏的是 dataPath(\"data\")");
    const n = (src.match(/walkAllCached\(\s*(getWorkspaceDir\(\)|wsRoot)\s*,\s*\{\s*appDataDir: dataPath\("data"\)\s*\}\)/g) || []).length;
    ok(n >= 2, `outputs 和搜索都走带记忆的全量（找到 ${n} 处）`);
    // 存盘那份（历史回放靠它重建产出卡）：第 4 层往下的产出在 turn_files 里，裁的时候得一起算上。
    // 切 server.js 的真源码来跑，宠物、存盘两个副作用换成空的
    const r0 = src.indexOf("function recordingEmit(");
    const r1 = src.indexOf("\nconst app = express();", r0);
    ok(r0 > 0 && r1 > r0, "server.js 里找得到 recordingEmit");
    const recordingEmit = new Function("petSay", "autosaveSession", src.slice(r0, r1) + "\nreturn recordingEmit;")(() => {}, () => {});
    const saved = /** @type {any[]} */ ([]);
    const DEEP5 = "任务_深/site/assets/img/新.png";
    recordingEmit(() => {}, saved, "", { pet: false })({
      type: "files", changed: ["根.md", DEEP5], root: "r1",
      files: [{ name: "根.md", size: 1, mtime: "t" }, { name: "别的.md", size: 1, mtime: "t" }],
      turn_files: [{ name: DEEP5, size: 3, mtime: "t" }],
    });
    const rec = saved[0] || {};
    ok(rec.partial === true && (rec.files || []).map((/** @type {any} */ f) => f.name).join() === "根.md," + DEEP5,
      "★存盘的 files 事件带上 turn_files 里那个第五层的产出（回放时卡画得出来）★，没改动的照旧裁掉", rec.files);
  });

  finished = true;
  console.log(`\n${fail ? "✗" : "✓"} 资料库工作区：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();

/**
 * 起一份真的 server.js。照抄 test/e2e.js 里的 bootRealServer：那边 require 不得（e2e.js 一 require
 * 就开跑整套），抄过来的这份只认「已启动: http://localhost:端口」那一行。
 * @param {Record<string,string>} env
 * @param {{ timeoutMs?: number, port?: string }} [opts]
 */
function bootRealServer(env, { timeoutMs = 60000, port = "0" } = {}) {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
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
