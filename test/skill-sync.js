// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 内置技能跟着应用升级（paths.js 的 syncBuiltinSkills + scripts/skill-hashes.js）。
 *
 * 以前数据目录里的内置技能「缺了才拷」，老用户升了十个版本还在跑第一次装机那一版。
 * 现在没人动过的换成新版、动过一个字的整份留着。这里盯的就是那条线两边都不出错：
 *   ① 老装机（没有 manifest）认得出历史上发过的版本，换；改过一个字节的，整份留着、记日志。
 *   ② 运行时多出来的东西（node_modules、__pycache__、.venv、projects/……）一个不删；
 *      新版不要了的老文件，只删认得出的，删空的目录收掉，里面还住着东西的目录留着。
 *   ③ 新装机靠 manifest 认出当初铺进去的那一版；manifest 没了、历史表里也没有，就不换。
 *   ④ 快路：包没变就不读数据目录。
 *   ⑤ 留着的那一份，同一版只念一次。
 *   ⑥ 换到每一步都可能出错：哪一步抛了，技能目录都得一个字节不差地退回去。
 *   ⑦ 换到一半进程没了：下次启动按记录退回去，再正常换一遍。
 *   ⑧ Windows 包落盘是 CRLF：换成 LF 能认出历史版本。
 *   ⑨ 名单以外的技能只补缺、不比对。
 *   ⑩ 不是普通文件 / 不是普通文件夹 / 别处装进来的：留着。
 *   ⑪ 我们放过的文件被删了：留着（删也是一种改）；老装机缺的文件补上。
 *   ⑫ 不分大小写的盘：历史里的 Foo.md 不会被当成现在出厂的 foo.md 删掉。
 *   ⑬ 两个进程抢：别人占着就只补缺；锁的主人早没了就收走接着干。
 *   ⑭ 指纹跟 git hash-object 一个数。
 *   ⑮ 真接线：子进程里 seedDataDir() 铺一遍、把 docx 退回老版本再起一遍，真换回来了。
 *   ⑯ 指纹表跟 git 历史对得上（忘了跑 npm run skill-hashes 就红）。
 *   ⑰ 读坏的东西：带 .. 的历史条目、看不懂的半截记录，一个文件都不按它动。
 *   ⑱ 新放的文件跟用户的东西只差大小写（NOTES.md / notes.md、SKILL.md / skill.md、Scripts/ / scripts/）：
 *      不分大小写的盘上整份留着，不许落到用户那份头上；分大小写的盘上照换。
 *
 * 全在临时目录里造假技能，不碰真数据目录；⑮ 用子进程起一个临时 OPENWORKBUDDY_HOME。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const { mod } = require("./lib/mod");
const ROOT = path.join(__dirname, "..");
const P = require(mod("paths"));
const S = require(path.join(ROOT, "scripts", "skill-hashes.js"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 600) : "")); }
};
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), msg, { got, want });

const H = (s) => P.skillBlobHash(Buffer.from(s));

/** 一套假的应用包 + 数据目录。每个场景各起一份，跑完就收 */
function scenario(title, fn) {
  if (title) console.log("\n" + title);
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "owb-test-skill-sync-"));
  const fx = {
    t,
    app: path.join(t, "app", "skills"),
    data: path.join(t, "data", "skills"),
    root: path.join(t, "data", ".builtin-skills"),
  };
  fs.mkdirSync(fx.app, { recursive: true });
  fs.mkdirSync(fx.data, { recursive: true });
  try { fn(fx); }
  catch (e) { fail++; console.log("  ✗ 场景自己抛了：" + ((e && e.stack) || e)); }
  finally {
    // chmod 过的先改回来，不然收不掉
    try { execFileSync("chmod", ["-R", "u+rwX", t], { stdio: "ignore" }); } catch {}
    fs.rmSync(t, { recursive: true, force: true });
  }
}

/** @param {string} dir @param {Record<string, string|Buffer>} files */
function put(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
}

/** 历史指纹表：[["技能/相对路径", [内容, 内容…]], …] */
function hist(skills, entries) {
  return { skills: new Set(skills), files: new Map(entries.map(([rel, bodies]) => [rel, new Set(bodies.map(H))])) };
}

function run(fx, history, extra = {}) {
  const logs = [];
  const r = P._syncBuiltinSkills({ appSkills: fx.app, dataSkills: fx.data, root: fx.root, history, log: (l) => logs.push(l), ...extra });
  return { r, logs };
}

/** 整棵树的快照：目录、文件（内容指纹 + 权限）、软链（指向哪），一行一个，排好序 */
function tree(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let ents;
    try { ents = fs.readdirSync(abs); } catch { return; }
    for (const n of ents) {
      const p = path.join(abs, n), r = rel ? rel + "/" + n : n;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push("l " + r + " -> " + fs.readlinkSync(p));
      else if (st.isDirectory()) { out.push("d " + r); walk(p, r); }
      else {
        let h = "?";
        try { h = P.skillBlobHash(fs.readFileSync(p)); } catch (e) { h = "unreadable"; }
        out.push("f " + r + " " + h + " " + (st.mode & 0o777).toString(8));
      }
    }
  };
  walk(dir, "");
  return out.sort();
}
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const workLeft = (fx) => fs.existsSync(path.join(fx.root, "work"));

// ———————————————————————————————————————————————
scenario("① 老装机（没有 manifest）：历史上发过的那一版原样躺着 → 换；改过一个字节 → 整份留着", (fx) => {
  const h = hist(["s1"], [["s1/skill.md", ["v1\n"]]]);
  put(path.join(fx.app, "s1"), { "skill.md": "v2\n" });
  put(path.join(fx.data, "s1"), { "skill.md": "v1\n" });
  const { r, logs } = run(fx, h);
  eq(r.updated.map((u) => u.name), ["s1"], "认出是历史上的 v1，换了");
  eq(read(path.join(fx.data, "s1", "skill.md")), "v2\n", "换完是包里那一版");
  const m = JSON.parse(read(path.join(fx.root, "manifest.json")) || "{}");
  eq(m.skills && m.skills.s1, { files: { "skill.md": H("v2\n") } }, "manifest 记下了这一版（下次走快路）");
  ok(logs.some((l) => /s1 已换成新版/.test(l)), "日志说了换了哪一个", logs);
  ok(!workLeft(fx), "工作目录收干净了");

  // 反向对照：v1 多一个字节
  fs.rmSync(fx.root, { recursive: true, force: true });
  fs.writeFileSync(path.join(fx.data, "s1", "skill.md"), "v1\nx");
  const before = tree(fx.data);
  const b = run(fx, h);
  eq(b.r.updated, [], "反向对照：改过一个字节的，不换");
  eq(tree(fx.data), before, "反向对照：技能目录一个字节不差");
  ok(b.r.kept.length === 1 && b.r.kept[0].paths.includes("skill.md"), "反向对照：留着的清单里写着是哪个文件", b.r.kept);
  ok(b.logs.some((l) => /s1 没更新：1 个文件跟出厂的哪一版都对不上（skill\.md）/.test(l) && /挪走/.test(l)), "反向对照：日志说了留着、说了想要新版怎么办", b.logs);
});

// ———————————————————————————————————————————————
const EXTRAS = {
  "node_modules/x/index.js": "module.exports = 1;\n",
  "__pycache__/a.pyc": "pyc-a",
  "scripts/__pycache__/b.pyc": "pyc-b",
  "projects/out.pptx": "pptx-bytes",
  ".DS_Store": "ds",
};
function extrasOf(snap) {
  return snap.filter((l) => /node_modules|__pycache__|\.venv|projects|\.DS_Store/.test(l));
}
scenario("② 运行时多出来的一个不删；新版不要了的老文件只删认得出的，删空的目录收掉", (fx) => {
  const h = hist(["s2"], [["s2/skill.md", ["v1\n"]], ["s2/scripts/old.py", ["old\n"]], ["s2/lib/gone/x.py", ["gone\n"]]]);
  // 打包机上跑过脚本留下的 __pycache__ 也会跟着进包：它不算出厂文件，不能拿它去盖用户自己的那份
  put(path.join(fx.app, "s2"), { "skill.md": "v2\n", "scripts/new.py": "new\n", "__pycache__/a.pyc": "pyc-from-build-machine" });
  const D = path.join(fx.data, "s2");
  put(D, { "skill.md": "v1\n", "scripts/old.py": "old\n", "lib/gone/x.py": "gone\n", ...EXTRAS });
  fs.mkdirSync(path.join(D, ".venv", "bin"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(D, ".venv", "bin", "python"));
  const extrasBefore = extrasOf(tree(D));
  const { r } = run(fx, h);
  eq(r.updated, [{ name: "s2", written: 2, removed: 2 }], "换了：改 1 个、加 1 个、删 2 个老文件");
  eq(extrasOf(tree(D)), extrasBefore, "node_modules / __pycache__ / .venv 软链 / projects / .DS_Store 原样都在（包里那份 __pycache__ 没盖过来）");
  ok(!fs.existsSync(path.join(D, "scripts", "old.py")), "新版不要了的 scripts/old.py 删了");
  ok(fs.existsSync(path.join(D, "scripts", "__pycache__", "b.pyc")), "scripts/ 里还住着 __pycache__，目录留着");
  ok(!fs.existsSync(path.join(D, "lib")), "lib/gone/ 删空了，一路收到 lib/ 为止");
  eq(read(path.join(D, "scripts", "new.py")), "new\n", "新版新加的文件放进来了");

  // 反向对照：要删的那个老文件被改过 → 整份留着
  scenario("②′ 反向对照：要删的老文件被改过", (fx2) => {
    put(path.join(fx2.app, "s2"), { "skill.md": "v2\n", "scripts/new.py": "new\n" });
    const D2 = path.join(fx2.data, "s2");
    put(D2, { "skill.md": "v1\n", "scripts/old.py": "old\n# 我加的一行\n", "lib/gone/x.py": "gone\n", ...EXTRAS });
    const before = tree(D2);
    const b = run(fx2, h);
    eq(b.r.updated, [], "不换");
    eq(tree(D2), before, "old.py 还在，skill.md 还是 v1，一个字节不差");
    ok(b.r.kept[0] && b.r.kept[0].paths.join() === "scripts/old.py", "留着的原因指着 scripts/old.py", b.r.kept);
  });
});

// ———————————————————————————————————————————————
scenario("③ 新装机：manifest 认得出当初铺进去的那一版（哪怕历史表里没有）", (fx) => {
  const h = hist(["s3"], []); // 名单里有这个技能，但历史表里一版都没有：只能靠 manifest
  put(path.join(fx.app, "s3"), { "skill.md": "a1\n" });
  const first = run(fx, h);
  eq(first.r.seeded, ["s3"], "缺的铺过去了");
  eq(first.logs, [], "刚铺的不出声");
  put(path.join(fx.app, "s3"), { "skill.md": "a2\n" });
  const { r } = run(fx, h);
  eq(r.updated.map((u) => u.name), ["s3"], "包换成 a2 → 认出是 manifest 记的 a1，换了");
  eq(read(path.join(fx.data, "s3", "skill.md")), "a2\n", "换完是 a2");
});
scenario("③′ 反向对照：manifest 没了、历史表里也没有 → 认不出，不换", (fx) => {
  const h = hist(["s3"], []);
  put(path.join(fx.app, "s3"), { "skill.md": "a1\n" });
  run(fx, h);
  fs.rmSync(path.join(fx.root, "manifest.json"));
  put(path.join(fx.app, "s3"), { "skill.md": "a2\n" });
  const { r } = run(fx, h);
  eq(r.updated, [], "不换");
  eq(read(path.join(fx.data, "s3", "skill.md")), "a1\n", "还是 a1");
});

// ———————————————————————————————————————————————
const canChmod = process.platform !== "win32" && !(process.getuid && process.getuid() === 0);
scenario("④ 快路：包没变，数据目录一个文件都不读", (fx) => {
  if (!canChmod) { console.log("  ⚠️  这台机器上 chmod 000 拦不住读（Windows 或 root），这条跳过了"); return; }
  const h = hist(["s4"], []);
  put(path.join(fx.app, "s4"), { "skill.md": "v1\n" });
  run(fx, h);
  fs.chmodSync(path.join(fx.data, "s4", "skill.md"), 0o000);
  const a = run(fx, h);
  ok(!a.r.failed.length && !a.r.updated.length && !a.r.kept.length && !a.logs.length, "读不了的文件没碰着：没报错、没日志", a);
  ok(!fs.existsSync(path.join(fx.root, "lock")), "快路连锁都没拿");
  // 反向对照：包变了，这回真得去读——读不了就报出来，不瞎换
  put(path.join(fx.app, "s4"), { "skill.md": "v2\n" });
  const b = run(fx, h);
  ok(b.r.failed.length === 1 && /EACCES|EPERM/.test(b.r.failed[0].error), "反向对照：包变了才去读，读不了就记一笔失败（原话）", b.r.failed);
  ok(b.logs.some((l) => /✗ s4/.test(l)), "反向对照：失败进了日志");
});

// ———————————————————————————————————————————————
scenario("⑤ 留着的那一份，同一版只念一次", (fx) => {
  const h = hist(["s5"], []);
  put(path.join(fx.app, "s5"), { "skill.md": "v1\n" });
  run(fx, h);
  fs.writeFileSync(path.join(fx.data, "s5", "skill.md"), "我改过\n");
  put(path.join(fx.app, "s5"), { "skill.md": "v2\n" });
  const a = run(fx, h), b = run(fx, h);
  eq([a.logs.length, b.logs.length], [1, 0], "第一次说一句，第二次不再说");
  eq(read(path.join(fx.data, "s5", "skill.md")), "我改过\n", "改过的那份一直在");
  put(path.join(fx.app, "s5"), { "skill.md": "v3\n" });
  const c = run(fx, h);
  ok(c.logs.length === 1 && /s5 没更新/.test(c.logs[0]), "反向对照：包又换了一版，再说一次", c.logs);
  eq(read(path.join(fx.data, "s5", "skill.md")), "我改过\n", "反向对照：照样留着");
});

// ———————————————————————————————————————————————
// ⑥⑦ 用同一个夹具：manifest 记着 v1；v2 改 skill.md、新加 newdir/n.txt、不要 gone/x.txt
function fixture6(fx) {
  const h = hist(["s6"], []);
  put(path.join(fx.app, "s6"), { "skill.md": "v1\n", "gone/x.txt": "x\n" });
  run(fx, h);
  put(path.join(fx.data, "s6"), EXTRAS);
  fs.rmSync(path.join(fx.app, "s6"), { recursive: true });
  put(path.join(fx.app, "s6"), { "skill.md": "v2\n", "newdir/n.txt": "n\n" });
  return h;
}
let reference = null; // 一次都不出错换完的样子，⑦ 拿来比
scenario("⑥ 换到每一步都可能出错：哪一步抛了，技能目录都一个字节不差地退回去", (fx) => {
  const h = fixture6(fx);
  const before = tree(path.join(fx.data, "s6"));
  const mBefore = read(path.join(fx.root, "manifest.json"));
  const bad = [];
  let k = 1;
  for (; k < 40; k++) {
    const { r } = run(fx, h, { faultAt: k });
    if (r.updated.length) break;
    const after = tree(path.join(fx.data, "s6"));
    if (JSON.stringify(after) !== JSON.stringify(before)) bad.push(`第 ${k} 步：目录变了`);
    if (workLeft(fx)) bad.push(`第 ${k} 步：工作目录没收`);
    if (read(path.join(fx.root, "manifest.json")) !== mBefore) bad.push(`第 ${k} 步：manifest 动了`);
    if (!(r.failed.length === 1 && /faultAt/.test(r.failed[0].error))) bad.push(`第 ${k} 步：没记失败`);
  }
  ok(k >= 6 && k < 40, `一共 ${k - 1} 步，每一步都试着抛了一次`, k);
  eq(bad, [], "每一步抛了都退回原样、工作目录收掉、manifest 不动、失败记着");
  // 反向对照：不出错就真换了（上面循环最后一趟就是）
  ok(JSON.stringify(tree(path.join(fx.data, "s6"))) !== JSON.stringify(before), "反向对照：不出错时目录真变了");
  eq(read(path.join(fx.data, "s6", "skill.md")), "v2\n", "反向对照：换成了 v2");
  reference = tree(path.join(fx.data, "s6"));
  ok(reference.some((l) => /^f node_modules\/x\/index\.js /.test(l)) && !reference.some((l) => /gone/.test(l)), "换完 extras 在、gone/ 收了");
});

console.log("\n⑦ 换到一半进程没了：下次启动按记录退回去，再正常换一遍");
{
  const bad = [];
  let halfSeen = 0;
  for (let k = 1; k < 40; k++) {
    let done = false;
    // 每一步各起一套干净的夹具，不打标题：几十个空标题只会把真结果冲没
    scenario("", (fx) => {
      const h = fixture6(fx);
      const before = tree(path.join(fx.data, "s6"));
      const crash = run(fx, h, { faultAt: k, noRollback: true });
      if (crash.r.updated.length) { done = true; return; }
      const mid = tree(path.join(fx.data, "s6"));
      if (JSON.stringify(mid) !== JSON.stringify(before)) halfSeen++;
      const again = run(fx, h);
      const final = tree(path.join(fx.data, "s6"));
      if (JSON.stringify(final) !== JSON.stringify(reference)) bad.push(`第 ${k} 步崩的：最后不是干净的新版 ${JSON.stringify(final)}`);
      if (workLeft(fx)) bad.push(`第 ${k} 步崩的：工作目录没收`);
      if (!again.r.updated.length) bad.push(`第 ${k} 步崩的：重启后没换`);
      const j = fs.existsSync(path.join(fx.root, "work"));
      if (j) bad.push(`第 ${k} 步崩的：还留着记录`);
    });
    if (done) break;
  }
  ok(reference !== null, "有 ⑥ 换出来的样子当参照");
  eq(bad, [], "崩在哪一步，下次启动都收拾成干净的新版，extras 一个不少");
  ok(halfSeen >= 3, `反向对照：真有 ${halfSeen} 种「崩在半路、目录已经半新半旧」的情况被收拾回来了（不是每次都崩在动手之前）`, halfSeen);
}

scenario("⑦′ 崩在半路时 recovered 里点了名，日志说了退回原样", (fx) => {
  const h = fixture6(fx);
  run(fx, h, { faultAt: 5, noRollback: true });
  const j = JSON.parse(read(path.join(fx.root, "work", "s6", "journal.json")) || "null");
  ok(j && j.phase === "staged", "崩完留着 staged 的记录");
  const { r, logs } = run(fx, h);
  eq(r.recovered, ["s6"], "recovered 里有 s6");
  ok(logs.some((l) => /s6 上次换到一半停了，已退回原样/.test(l)), "日志说了", logs);
});

// ———————————————————————————————————————————————
scenario("⑧ Windows 包落盘是 CRLF：换成 LF 能认出历史版本", (fx) => {
  const h = hist(["s8"], [["s8/skill.md", ["line1\nline2\n"]]]);
  put(path.join(fx.app, "s8"), { "skill.md": "v2\n" });
  put(path.join(fx.data, "s8"), { "skill.md": "line1\r\nline2\r\n" });
  eq(run(fx, h).r.updated.map((u) => u.name), ["s8"], "CRLF 那份认出来了，换了");
  fs.rmSync(fx.root, { recursive: true, force: true });
  put(path.join(fx.data, "s8"), { "skill.md": "line1\r\nline2\r\n!" });
  const b = run(fx, h);
  eq(b.r.updated, [], "反向对照：CRLF 再多一个字，不认");
});

// ———————————————————————————————————————————————
scenario("⑨ 名单以外的技能只补缺、不比对；同一趟里名单内的照换", (fx) => {
  const h = hist(["m9"], [["m9/skill.md", ["v1\n"]]]);
  put(path.join(fx.app, "u9"), { "skill.md": "u2\n" });
  put(path.join(fx.data, "u9"), { "skill.md": "u1\n" });
  put(path.join(fx.app, "u9b"), { "skill.md": "fresh\n" });
  put(path.join(fx.app, "m9"), { "skill.md": "v2\n" });
  put(path.join(fx.data, "m9"), { "skill.md": "v1\n" });
  const { r } = run(fx, h);
  eq(read(path.join(fx.data, "u9", "skill.md")), "u1\n", "名单外的 u9 没动");
  eq(r.seeded, ["u9b"], "名单外缺的 u9b 照样铺了");
  const m = JSON.parse(read(path.join(fx.root, "manifest.json")) || "{}");
  ok(!("u9" in m.skills) && !("u9b" in m.skills), "名单外的连 manifest 都不进");
  eq(r.updated.map((u) => u.name), ["m9"], "反向对照：名单内的 m9 同一趟换了");
});
scenario("⑨′ 指纹表读不出来：只补缺，一个都不换，说一句", (fx) => {
  put(path.join(fx.app, "m9"), { "skill.md": "v2\n" });
  put(path.join(fx.data, "m9"), { "skill.md": "v1\n" });
  put(path.join(fx.app, "n9"), { "skill.md": "n\n" });
  const { r, logs } = run(fx, null);
  eq([r.updated, r.seeded], [[], ["n9"]], "不换，缺的照铺");
  ok(logs.some((l) => /指纹表读不出来/.test(l)), "说了一句", logs);
});

// ———————————————————————————————————————————————
scenario("⑩ 不是普通文件 / 不是普通文件夹 / 从别处装进来的：留着", (fx) => {
  const h = hist(["a", "b", "c", "d"], [["a/skill.md", ["v1\n"]], ["b/skill.md", ["v1\n"]], ["c/skill.md", ["v1\n"]], ["d/skill.md", ["v1\n"]]]);
  for (const n of ["a", "b", "c", "d"]) put(path.join(fx.app, n), { "skill.md": "v2\n" });
  fs.mkdirSync(path.join(fx.data, "a", "skill.md"), { recursive: true }); // 目录占着
  put(path.join(fx.data, "elsewhere"), { "real.md": "v1\n" });
  fs.mkdirSync(path.join(fx.data, "b"));
  fs.symlinkSync(path.join(fx.data, "elsewhere", "real.md"), path.join(fx.data, "b", "skill.md")); // 软链占着
  fs.symlinkSync(path.join(fx.data, "elsewhere"), path.join(fx.data, "c")); // 整个技能是软链
  put(path.join(fx.data, "d"), { "skill.md": "v1\n", ".install.json": "{}" });
  const before = tree(fx.data);
  const { r } = run(fx, h);
  eq(r.updated, [], "一个都没换");
  eq(tree(fx.data), before, "全都原样");
  const why = Object.fromEntries(r.kept.map((k) => [k.name, k.reason]));
  ok(why.a && why.b && /不是普通文件夹/.test(why.c) && /\.install\.json/.test(why.d), "各自留着的原因对得上", why);
  // 反向对照：去掉 .install.json，同样的 v1 就换
  fs.rmSync(path.join(fx.data, "d", ".install.json"));
  put(path.join(fx.app, "d"), { "skill.md": "v3\n" });
  const b = run(fx, hist(["d"], [["d/skill.md", ["v1\n"]]]));
  eq(b.r.updated.map((u) => u.name), ["d"], "反向对照：没有 .install.json 就换");
});

// ———————————————————————————————————————————————
scenario("⑪ 我们放过的文件被删了：留着；老装机缺的文件补上", (fx) => {
  const h = hist(["s11"], [["s11/skill.md", ["v1\n"]], ["s11/a.md", ["a\n"]]]);
  put(path.join(fx.app, "s11"), { "skill.md": "v1\n", "a.md": "a\n" });
  run(fx, h);
  fs.rmSync(path.join(fx.data, "s11", "a.md"));
  put(path.join(fx.app, "s11"), { "skill.md": "v2\n" });
  const a = run(fx, h);
  ok(a.r.kept[0] && a.r.kept[0].paths.join() === "a.md", "manifest 记着放过 a.md、现在没了 → 留着", a.r);
  eq(read(path.join(fx.data, "s11", "skill.md")), "v1\n", "skill.md 也没动");
  ok(!fs.existsSync(path.join(fx.data, "s11", "a.md")), "也没替人把 a.md 放回去");
  // 反向对照：老装机（没有 manifest），缺的照补
  fs.rmSync(fx.root, { recursive: true, force: true });
  const b = run(fx, h);
  eq(b.r.updated.map((u) => u.name), ["s11"], "反向对照：没有 manifest 时缺的补上、旧的换掉");
  eq([read(path.join(fx.data, "s11", "skill.md")), read(path.join(fx.data, "s11", "a.md"))], ["v2\n", "a\n"], "反向对照：两个文件都是这一版");
});

// ———————————————————————————————————————————————
scenario("⑫ 不分大小写的盘：历史里的 Foo.md 不会被当成现在的 foo.md 删掉", (fx) => {
  fs.writeFileSync(path.join(fx.t, "a"), "");
  if (!fs.existsSync(path.join(fx.t, "A"))) { console.log("  ⚠️  这块盘分大小写，这条跳过了"); return; }
  const h = hist(["s12"], [["s12/skill.md", ["v1\n"]], ["s12/Foo.md", ["foo\n"]]]);
  put(path.join(fx.app, "s12"), { "skill.md": "v2\n", "foo.md": "foo\n" });
  put(path.join(fx.data, "s12"), { "skill.md": "v1\n", "foo.md": "foo\n" });
  ok(fs.existsSync(path.join(fx.data, "s12", "Foo.md")), "反向对照：这块盘上直接问 Foo.md，真会说「在」（陷阱是真的）");
  const { r } = run(fx, h);
  eq(r.updated, [{ name: "s12", written: 1, removed: 0 }], "只换了 skill.md，一个都没删");
  ok(fs.readdirSync(path.join(fx.data, "s12")).includes("foo.md"), "foo.md 还在");
  // 出厂文件改了大小写：foo.md → Foo.md
  scenario("⑫′ 出厂文件改了大小写：老的挪走、新的放进来，不会把新的一起挪走", (fx2) => {
    const h2 = hist(["s12"], [["s12/foo.md", ["foo\n"]]]);
    put(path.join(fx2.app, "s12"), { "Foo.md": "FOO\n" });
    put(path.join(fx2.data, "s12"), { "foo.md": "foo\n" });
    const b = run(fx2, h2);
    eq(b.r.updated, [{ name: "s12", written: 1, removed: 1 }], "换了");
    eq(fs.readdirSync(path.join(fx2.data, "s12")), ["Foo.md"], "盘上只剩新名字");
    eq(read(path.join(fx2.data, "s12", "Foo.md")), "FOO\n", "内容是新的");
  });
});

// ———————————————————————————————————————————————
// 新放的文件跟用户自己的东西只差大小写。不分大小写的盘上，挪进去就落在用户那份头上，old/ 里也没留底。
// 分大小写的盘上两个名字各是各的，照换——所以这条两种盘都跑，各对各的结论；用户那份一个字节不差是两边共同的底线
scenario("⑱ 新版要放的文件跟用户的东西只差大小写：不分大小写的盘上整份留着，用户那份一个字节不差", (fx) => {
  fs.writeFileSync(path.join(fx.t, "a"), "");
  const ci = fs.existsSync(path.join(fx.t, "A"));
  console.log("  （这块盘" + (ci ? "不分" : "分") + "大小写）");

  // 有 manifest：用户在内置技能里加了自己的 NOTES.md，新版正好多发一个 notes.md
  const h = hist(["s18"], [["s18/skill.md", ["v1\n"]]]);
  put(path.join(fx.app, "s18"), { "skill.md": "v1\n" });
  run(fx, h);
  put(path.join(fx.data, "s18"), { "NOTES.md": "USER NOTES\n" });
  put(path.join(fx.app, "s18"), { "skill.md": "v2\n", "notes.md": "shipped notes\n" });
  const before = tree(fx.data);
  const a = run(fx, h);
  const names = fs.readdirSync(path.join(fx.data, "s18"));
  ok(names.includes("NOTES.md") && read(path.join(fx.data, "s18", "NOTES.md")) === "USER NOTES\n", "用户的 NOTES.md 一个字节不差", names);
  if (ci) {
    eq(a.r.updated, [], "整份没换（skill.md 也还是 v1）");
    eq(tree(fx.data), before, "技能目录一个字节不差");
    ok(a.r.kept.length === 1 && a.r.kept[0].paths.join() === "notes.md", "留着的清单里写着是新版的 notes.md", a.r.kept);
    ok(a.logs.some((l) => /s18 没更新：新版要放的 notes\.md 在这块盘上跟已有的 NOTES\.md 算同一个名字/.test(l)), "日志写的是盘上真叫的 NOTES.md", a.logs);
    ok(!workLeft(fx), "工作目录都没建");
  } else {
    eq(a.r.updated, [{ name: "s18", written: 2, removed: 0 }], "分大小写的盘：两个名字各是各的，照换");
    eq(read(path.join(fx.data, "s18", "notes.md")), "shipped notes\n", "分大小写的盘：notes.md 是新版那份");
  }

  // 用户的目录 Scripts/，新版发 scripts/x.py：一挪就进了用户的目录，Scripts/x.py 被盖
  fs.rmSync(fx.root, { recursive: true, force: true });
  fs.rmSync(path.join(fx.data, "s18"), { recursive: true, force: true });
  fs.rmSync(path.join(fx.app, "s18"), { recursive: true, force: true });
  put(path.join(fx.app, "s18"), { "skill.md": "v1\n" });
  run(fx, h);
  put(path.join(fx.data, "s18"), { "Scripts/x.py": "user script\n" });
  put(path.join(fx.app, "s18"), { "skill.md": "v2\n", "scripts/x.py": "shipped script\n" });
  const b = run(fx, h);
  ok(read(path.join(fx.data, "s18", "Scripts", "x.py")) === "user script\n", "用户的 Scripts/x.py 一个字节不差");
  if (ci) {
    ok(b.r.updated.length === 0 && b.r.kept.length === 1, "不分大小写的盘：整份留着", b.r);
    ok(b.logs.some((l) => /scripts\/x\.py 在这块盘上跟已有的 Scripts 算同一个名字/.test(l)), "日志写的是盘上的 Scripts", b.logs);
    eq(read(path.join(fx.data, "s18", "skill.md")), "v1\n", "skill.md 也没动");
  } else {
    eq(b.r.updated.map((u) => u.name), ["s18"], "分大小写的盘：照换");
  }

  // 反向对照：同样的新版，用户没放那个只差大小写的东西 → 照换（留着确实是因为撞名，不是别的）。
  // 上一趟说过「这一版留着」，manifest 一并收掉，从老装机那条路重新判
  fs.rmSync(fx.root, { recursive: true, force: true });
  fs.rmSync(path.join(fx.data, "s18"), { recursive: true, force: true });
  put(path.join(fx.data, "s18"), { "skill.md": "v1\n" });
  const c = run(fx, h);
  eq(c.r.updated, [{ name: "s18", written: 2, removed: 0 }], "反向对照：没有撞名的东西，照换");
  eq(read(path.join(fx.data, "s18", "scripts", "x.py")), "shipped script\n", "反向对照：scripts/x.py 是新版那份");
});

scenario("⑱′ 老装机（没有 manifest）：用户自己放了大写的 SKILL.md，新版的 skill.md 不许盖上去", (fx) => {
  fs.writeFileSync(path.join(fx.t, "a"), "");
  const ci = fs.existsSync(path.join(fx.t, "A"));
  const h = hist(["docx"], [["docx/skill.md", ["SHIPPED OLD\n"]]]);
  put(path.join(fx.app, "docx"), { "skill.md": "SHIPPED NEW\n" });
  put(path.join(fx.data, "docx"), { "SKILL.md": "USER OWN\n" });
  const before = tree(fx.data);
  const { r } = run(fx, h);
  ok(fs.readdirSync(path.join(fx.data, "docx")).includes("SKILL.md") && read(path.join(fx.data, "docx", "SKILL.md")) === "USER OWN\n", "用户的 SKILL.md 一个字节不差");
  if (ci) {
    eq(r.updated, [], "不分大小写的盘：没换");
    eq(tree(fx.data), before, "不分大小写的盘：技能目录一个字节不差");
  } else {
    eq(r.updated.map((u) => u.name), ["docx"], "分大小写的盘：两个文件各是各的，skill.md 补上");
  }
  // 反向对照：用户那份正好是历史上发过的 skill.md（逐字同名）→ 认得出，换
  fs.rmSync(fx.root, { recursive: true, force: true });
  fs.rmSync(path.join(fx.data, "docx"), { recursive: true, force: true });
  put(path.join(fx.data, "docx"), { "skill.md": "SHIPPED OLD\n" });
  const b = run(fx, h);
  eq(b.r.updated.map((u) => u.name), ["docx"], "反向对照：逐字同名的老版本照换");
  eq(read(path.join(fx.data, "docx", "skill.md")), "SHIPPED NEW\n", "反向对照：换完是新版");
});

// ———————————————————————————————————————————————
scenario("⑬ 两个进程抢：别人占着就只补缺；锁的主人早没了就收走接着干", (fx) => {
  const h = hist(["s13"], [["s13/skill.md", ["v1\n"]]]);
  put(path.join(fx.app, "s13"), { "skill.md": "v2\n" });
  put(path.join(fx.data, "s13"), { "skill.md": "v1\n" });
  put(path.join(fx.app, "new13"), { "skill.md": "n\n" });
  fs.mkdirSync(fx.root, { recursive: true });
  fs.writeFileSync(path.join(fx.root, "lock"), String(process.pid)); // 一个活着的进程占着
  const a = run(fx, h);
  ok(a.r.locked === true && a.r.updated.length === 0, "活人占着锁：不换", a.r);
  eq(a.r.seeded, ["new13"], "缺的照样铺");
  ok(a.logs.some((l) => /另一个进程正在核对内置技能/.test(l)), "说了一句");
  eq(read(path.join(fx.root, "lock")), String(process.pid), "别人的锁没被动");
  // 反向对照：锁里写的是早就退出的进程
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(path.join(fx.root, "lock"), String(dead));
  const b = run(fx, h);
  ok(!b.r.locked && b.r.updated.map((u) => u.name).join() === "s13", "反向对照：死锁收走，接着换了", b.r);
  ok(!fs.existsSync(path.join(fx.root, "lock")), "反向对照：用完把锁放了");
});

// ———————————————————————————————————————————————
const hasGit = (() => {
  try { execFileSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT, stdio: "ignore" }); return true; } catch { return false; }
})();
const shallow = hasGit && (() => {
  try { return execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: ROOT, encoding: "utf8" }).trim() === "true"; } catch { return true; }
})();

console.log("\n⑭ 指纹跟 git hash-object 一个数");
if (!hasGit) console.log("  ⚠️  这儿不是 git 仓库，这条跳过了");
else {
  const f = path.join(ROOT, "skills", "docx", "skill.md");
  const want = execFileSync("git", ["hash-object", f], { cwd: ROOT, encoding: "utf8" }).trim().slice(0, 16);
  const buf = fs.readFileSync(f);
  eq(P.skillBlobHash(buf), want, "skills/docx/skill.md：跟 git hash-object 前 16 位一样");
  ok(P.skillBlobHash(Buffer.from(buf.toString("latin1").replace(/\n/g, "\r\n"), "latin1")) !== want, "反向对照：换成 CRLF 就不一样了");
}

// ———————————————————————————————————————————————
scenario("⑮ 真接线：子进程里 seedDataDir() 铺一遍，把 docx 退回老版本再起一遍", (fx) => {
  if (!hasGit || shallow) { console.log("  ⚠️  没有 git 或是浅克隆，拿不到 docx 的老版本，这条跳过了"); return; }
  const list = JSON.parse(fs.readFileSync(S.OUT, "utf8"));
  const cur = P.skillBlobHash(fs.readFileSync(path.join(ROOT, "skills", "docx", "skill.md")));
  const oldMd = (list.files["docx/skill.md"] || []).find((x) => x !== cur);
  const dropped = Object.keys(list.files).find((k) => k.startsWith("docx/scripts/") && !fs.existsSync(path.join(ROOT, "skills", k)));
  if (!oldMd || !dropped) { console.log("  ⚠️  指纹表里没有 docx 的老版本，这条跳过了"); return; }
  const home = path.join(fx.t, "home");
  const seed = () => spawnSync(process.execPath, ["-e", "require(process.argv[1]).seedDataDir()", mod("paths")],
    { encoding: "utf8", env: { ...process.env, OPENWORKBUDDY_HOME: home } });
  const r1 = seed();
  ok(r1.status === 0 && !/\[内置技能\]/.test(r1.stdout), "全新的数据目录铺一遍，一行日志都没有", r1.stdout + r1.stderr);
  const D = path.join(home, "skills", "docx");
  const blob = (h) => execFileSync("git", ["cat-file", "blob", h], { cwd: ROOT });
  fs.writeFileSync(path.join(D, "skill.md"), blob(oldMd));
  put(D, { "node_modules/keep.txt": "runtime\n" });
  const droppedRel = dropped.slice("docx/".length);
  fs.mkdirSync(path.dirname(path.join(D, droppedRel)), { recursive: true });
  fs.writeFileSync(path.join(D, droppedRel), blob(list.files[dropped][0]));
  fs.rmSync(path.join(home, ".builtin-skills", "manifest.json"));
  const r2 = seed();
  ok(r2.status === 0, "第二遍跑完了", r2.stderr);
  ok(fs.readFileSync(path.join(D, "skill.md")).equals(fs.readFileSync(path.join(ROOT, "skills", "docx", "skill.md"))), "docx/skill.md 换回了仓库里这一版");
  ok(fs.existsSync(path.join(D, "node_modules", "keep.txt")), "node_modules/keep.txt 还在");
  ok(!fs.existsSync(path.join(D, droppedRel)), `新版不要了的 ${droppedRel} 删了`);
  const lines = r2.stdout.split("\n").filter((l) => l.startsWith("[内置技能]"));
  ok(lines.length === 1 && /docx 已换成新版/.test(lines[0]), "只有 docx 这一行（别的内置技能全认出是原样）", lines);
  ok(/内置技能：docx 已换成新版/.test(read(path.join(home, "logs", "boot.log")) || ""), "boot.log 里也留了一行");
  const r3 = seed();
  ok(r3.status === 0 && !/\[内置技能\]/.test(r3.stdout), "反向对照：第三遍走快路，一行都不说", r3.stdout);
});

// ———————————————————————————————————————————————
console.log("\n⑯ 指纹表跟 git 历史对得上");
if (!hasGit) console.log("  ⚠️  这儿不是 git 仓库，内置技能指纹表的新鲜度这条跳过了");
else if (shallow) console.log("  ⚠️  浅克隆仓库，内置技能指纹表的新鲜度这条跳过了");
else {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(S.OUT, "utf8")); } catch {}
  const now = S.compute();
  const problems = S.stale(saved, now);
  ok(problems.length === 0, "指纹表跟 git 历史对得上", problems.slice(0, 10).join("\n      ") + "\n      跑一遍 `npm run skill-hashes` 再提交");
  const pairs = Object.values(now.files).reduce((a, hs) => a + hs.length, 0);
  ok(now.skills.length >= 10 && pairs >= now.skills.length, `算出来 ${now.skills.length} 个技能、${pairs} 个历史版本`, "数字小得不像话，下面的对照等于空跑");
  const curOf = (rel) => { try { return P.skillBlobHash(fs.readFileSync(path.join(ROOT, "skills", rel))); } catch { return ""; } };
  const clone = () => JSON.parse(JSON.stringify(saved || now));
  // 反向对照一：删掉一个「不是工作区现在这份」的历史版本 → 红一条
  const old = Object.entries(now.files).map(([rel, hs]) => [rel, hs.find((h) => h !== curOf(rel))]).find(([, h]) => h);
  if (old) {
    const s1 = clone();
    s1.files[old[0]] = s1.files[old[0]].filter((h) => h !== old[1]);
    eq(S.stale(s1, now), [`${old[0]} ${old[1]}`], "反向对照：表里少一个发过的老版本，正好红那一条");
  }
  // 反向对照二：删掉的正是工作区现在这份 → 不红（这次要发的那版，启动时直接跟包比）
  const curRel = Object.keys(now.files).find((rel) => now.files[rel].includes(curOf(rel)));
  if (curRel) {
    const s2 = clone();
    s2.files[curRel] = s2.files[curRel].filter((h) => h !== curOf(curRel));
    eq(S.stale(s2, now), [], "反向对照：少的是工作区现在这一版，不算缺（省得改一次技能提交两次）");
  }
  ok(S.stale(null, now).length >= pairs, "反向对照：表读不出来，每一条都算缺，不许悄悄放过");
  ok(S.stale(clone(), { ...now, skills: [...now.skills, "zz-假技能"] }).some((p) => /zz-假技能/.test(p)), "反向对照：多出一个出厂技能，红");
  ok(S.stale(clone(), { ...now, files: { ...now.files, "x/node_modules/y.js": ["0123456789abcdef"] } }).some((p) => /node_modules/.test(p)), "反向对照：出厂文件放在 node_modules 底下，红（启动时那种目录整个跳过）");
  ok(S.serialize(now) === S.serialize(S.compute()), "连算两遍一字不差（生成结果是确定的）");
  ok(P._loadSkillHistory(S.OUT) !== null, "随包那张表 paths.js 读得出来");
}

// ———————————————————————————————————————————————
scenario("⑰ 读坏的东西：带 .. 的历史条目、看不懂的半截记录，一个文件都不按它动", (fx) => {
  const bad = path.join(fx.t, "hist.json");
  fs.writeFileSync(bad, JSON.stringify({ skills: ["s17", "../up"], files: { "s17/skill.md": [H("v1\n")], "s17/../../victim.txt": [H("victim\n")], "/abs/x": [H("x")] } }));
  const h = P._loadSkillHistory(bad);
  ok(h && [...h.files.keys()].join() === "s17/skill.md" && [...h.skills].join() === "s17", "带 .. / 绝对路径的条目读的时候就扔了", h && { files: [...h.files.keys()], skills: [...h.skills] });
  fs.writeFileSync(bad, "{ 坏了");
  ok(P._loadSkillHistory(bad) === null, "反向对照：读坏的表 → null（只补缺）");
  // 看不懂的记录：路径往外跳。不能按它挪任何东西
  put(fx.t, { "victim.txt": "victim\n" });
  put(path.join(fx.app, "s17"), { "skill.md": "v2\n" });
  put(path.join(fx.data, "s17"), { "skill.md": "v1\n" });
  const w = path.join(fx.root, "work", "s17");
  put(w, { "old/x": "x", "journal.json": JSON.stringify({ v: 1, name: "s17", phase: "staged", writes: [], removes: [{ rel: "x", disk: "../../../victim.txt" }], mkdirs: [] }) });
  const { r, logs } = run(fx, hist(["s17"], [["s17/skill.md", ["v1\n"]]]));
  eq(read(path.join(fx.t, "victim.txt")), "victim\n", "技能目录外面的文件一个字节没动");
  ok(fs.existsSync(path.join(w, "old", "x")), "那份记录和 old/ 原样留着，等人来看");
  ok(logs.some((l) => /s17 上次换到一半停了，退回原样没做完/.test(l)), "日志说了", logs);
  ok(r.updated.length === 0 && r.kept.some((k) => k.name === "s17"), "这一趟不再碰 s17", r);
});

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
