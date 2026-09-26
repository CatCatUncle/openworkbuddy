"use strict";
/**
 * 测试护栏自己的测试：test/lib/real-data-guard.js + test/all.js 里接它的那几行。
 *
 * 护栏要管住的事：开发态 DATA_DIR 就是仓库根，没设 OPENWORKBUDDY_HOME 的套件会把审计、记忆命中数、
 * 用量账本写进用户正在用的 data/。护栏一旦失灵是静悄悄的——套件照样绿，用户的数据照样被改——
 * 所以得有一套专门证明「它还拦得住、还判得红、没拦错」的测试。
 *
 *   【1】护住的地方跟 paths.js 算的是同一处：没有 OPENWORKBUDDY_HOME 时的 DATA_DIR / 装机目录，
 *        以及生产代码里每一处 dataPath("…") 都在护栏里（新加一个落点忘了登记，这里红）
 *   【2】真拦得住：各种写法往真目录写都是 EACCES、记进账；换大小写、从软链绕进去也拦；
 *        读、往临时目录写、建删软链本身照常（目标都挑一个不存在的子目录：护栏真失灵了也只会是 ENOENT）
 *   【3】all.js 真判得红：在一份假仓库里跑真 all.js —— 套件自己吞了异常照样红、孙子进程写也红、
 *        干净的套件照样绿、整轮有临时家并且铺了技能、跑完收干净；SELF_ISOLATED 的套件不给家、
 *        没自己起家就红；挂了只留有东西的现场；ALLOW_REAL_DATA=1 只关护栏、临时家照给
 *   【4】单独跑也不碰真目录、不留垃圾：test/lib/own-home.js 赶在 require 之前起家、过了收走；
 *        e2e.js 单独跑自己建的临时目录自己收
 *
 * 不起 Electron、不出网。
 *   node test/data-guard.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HERE = __dirname;
const ROOT = path.join(HERE, "..");
const GUARD = path.join(HERE, "lib", "real-data-guard.js");
const guard = require("./lib/real-data-guard");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + (typeof extra === "string" ? extra : JSON.stringify(extra)) : "")); }
}
const section = (t) => console.log("\n【" + t + "】");

// macOS 的 /var 是 /private/var 的软链；node 给 __dirname 的是真路径，护栏也按真路径认，这里跟它对齐
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owb-guardtest-")));
const tmpToClean = [TMP];

/** 子进程用的环境：去掉外层（test/all.js）给的护栏和家，免得两层护栏叠在一起 */
function bareEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^OPENWORKBUDDY_(TEST_GUARD|HOME$|DATA_DIR$|ALLOW_REAL_DATA$|TRACE_FILE$)/.test(k)) delete env[k];
  env.NODE_OPTIONS = String(env.NODE_OPTIONS || "").replace(/--require[= ]("[^"]*real-data-guard\.js"|\S*real-data-guard\.js)/g, "").trim();
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  return { ...env, ...extra };
}
const guardEnv = (log, extra) => bareEnv({ NODE_OPTIONS: "--require=" + JSON.stringify(GUARD), OPENWORKBUDDY_TEST_GUARD: "guard", OPENWORKBUDDY_TEST_GUARD_LOG: log, OPENWORKBUDDY_TEST_GUARD_SUITE: "data-guard-probe", ...extra });
const rowsOf = (file) => { try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// ─────────────────────────────────────────────────────────────────────────
section("1 护住的就是 paths.js 算出来的那一处");
{
  const T = guard.realTargets();
  // 子进程里没有 OPENWORKBUDDY_HOME，paths.js 自己算
  const r = spawnSync(process.execPath, ["-e",
    "const p=require(process.argv[1]);console.log(JSON.stringify({dev:p.DATA_DIR,packaged:require('path').join(require('os').homedir(),'OpenWorkBuddy'),isPackaged:p.isPackaged()}))",
    path.join(ROOT, "paths.js")], { env: bareEnv({}), encoding: "utf8" });
  let got = null; try { got = JSON.parse(r.stdout); } catch {}
  ok(got && got.isPackaged === false && got.dev === T.roots.dev, "开发态的 DATA_DIR（没设 OPENWORKBUDDY_HOME）就是护栏护的那个仓库根", { paths: got, guard: T.roots.dev, err: r.stderr.slice(0, 300) });
  ok(got && got.packaged === T.roots.installed, "装机态那份 ~/OpenWorkBuddy 也在里面", { paths: got && got.packaged, guard: T.roots.installed });

  // 生产代码里每一处 dataPath("a", "b", …) 的字面前缀都得落在护栏里（新落点忘了登记会在这里红）
  const SKIP = new Set(["node_modules", "test", "public", "skills", "plugins", "data", "workspace", "dist", "docs", "projects", "logs", "backups", "build", "types"]);
  const files = [];
  (function walk(dir, depth) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4 && !(depth === 0 && SKIP.has(e.name)) && e.name !== "node_modules" && /^[\w.-]+$/.test(e.name)) walk(full, depth + 1); }
      else if (/\.(c|m)?js$/.test(e.name)) files.push(full);
    }
  })(ROOT, 0);
  /** @param {string} src @returns {string[]} 没护住的那些 dataPath 前缀 */
  const uncovered = (src) => {
    const miss = [];
    for (const m of src.matchAll(/\bdataPath\(\s*((?:["'`][^"'`$]+["'`]\s*,?\s*)+)/g)) {
      const segs = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
      const p = path.join(T.roots.dev, ...segs);
      const covered = guard.isReal(p) || guard.isReal(path.join(p, "x"))
        // 只是把上一级目录 mkdir 出来（dataPath("eval")）：底下真写东西的那几处单独查
        || T.dirs.concat(T.files).some((t) => t.startsWith(p + path.sep));
      if (!covered) miss.push(segs.join("/"));
    }
    return miss;
  };
  const missing = new Set();
  let calls = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    calls += (src.match(/\bdataPath\(\s*["'`]/g) || []).length;
    for (const m of uncovered(src)) missing.add(path.relative(ROOT, f) + ": dataPath(" + m + ")");
  }
  ok(calls >= 20, `真扫到了生产代码里的 dataPath（${files.length} 个文件，${calls} 处）`, calls);
  ok(missing.size === 0, "每一处 dataPath(\"…\") 都落在护栏里", [...missing].slice(0, 10));
  ok(uncovered('dataPath("brand-new-dir", "x.json")').length === 1, "反向对照：新冒出一个没登记的落点，这里认得出来");

  // 边界：前缀相同但不是那个目录、只读的出厂文件，都不算
  const R = T.roots.dev;
  const cases = [
    [path.join(R, "data"), true], [path.join(R, "data", "audit.json"), true], [path.join(R, "config.json"), true],
    [path.join(R, "config.json.123.tmp"), true], [path.join(R, "workspace", "a", "b.pptx"), true],
    [path.join(T.roots.installed, "data", "users.json"), true],
    [path.join(R, "data-export", "x"), false], [path.join(R, "config.example.json"), false],
    [path.join(R, "server.js"), false], [path.join(R, "test", "x.js"), false], [path.join(os.tmpdir(), "owb-x", "data", "a"), false],
    // 还不在盘上的文件没法 realpath：不分大小写的盘上，CONFIG.json 的临时文件也是 config.json 那一个
    [path.join(R, "CONFIG.json.9.tmp"), process.platform === "darwin" || process.platform === "win32"],
  ];
  const wrong = cases.filter(([p, want]) => guard.isReal(p) !== want).map(([p, want]) => path.relative(R, p) + " 该是 " + want);
  ok(wrong.length === 0, "哪些算真数据、哪些不算，边界对（data-export/、config.example.json 不算）", wrong);
  // 真目录的上级：删它 / 挪它等于把真目录整个带走（开发态 dataPath() 不带参数就是仓库根）
  const up = [[R, true], [path.dirname(R), true], [path.parse(R).root, true], [path.dirname(T.roots.installed), true],
    [path.join(R, "test"), false], [path.join(R, "data-export"), false], [TMP, false]];
  const badUp = up.filter(([p, want]) => guard.coversReal(p) !== want).map(([p, want]) => p + " 该是 " + want);
  ok(badUp.length === 0, "仓库根、它的上级、家目录都算「连带真目录」；仓库里别的目录、临时目录不算", badUp);
  const flagCases = [["r", false], [undefined, false], [fs.constants.O_RDONLY, false], ["r+", true], ["a", true], ["w", true], [fs.constants.O_WRONLY | fs.constants.O_CREAT, true]];
  const badFlags = flagCases.filter(([f, want]) => guard.writesFlag(f) !== want).map(([f]) => String(f));
  ok(badFlags.length === 0, "open 的 flags：只读放过，r+ / a / w / O_WRONLY 都算写", badFlags);
}

// ─────────────────────────────────────────────────────────────────────────
section("2 真拦得住，也没拦错");
{
  const T = guard.realTargets();
  const miss = "__owb_guard_probe_" + process.pid + "_" + Date.now();
  // 目标全挑不存在的子目录：护栏哪天失灵，这些调用也只会 ENOENT，写不进用户的数据里
  const inData = path.join(T.roots.dev, "data", miss);
  const inInstalled = path.join(T.roots.installed, miss);
  const log = path.join(TMP, "probe.jsonl");
  const scratchFile = path.join(TMP, "scratch.txt");
  // 绕路进真目录：换大小写（macOS / Windows 不分大小写，就是同一处）、从临时目录里的软链进去
  const FOLD = process.platform === "darwin" || process.platform === "win32";
  const inDataUpper = path.join(T.roots.dev, "DATA", miss);
  const dataLink = path.join(TMP, "datalink");
  const script = `
const fs = require("fs"), path = require("path");
const D = ${JSON.stringify(inData)}, I = ${JSON.stringify(inInstalled)}, S = ${JSON.stringify(scratchFile)};
const DU = ${JSON.stringify(inDataUpper)}, L = ${JSON.stringify(dataLink)}, REAL_DATA = ${JSON.stringify(path.join(T.roots.dev, "data"))};
const out = {};
const t = (k, f) => { try { f(); out[k] = "ok"; } catch (e) { out[k] = e.code || String(e); } };
const ta = async (k, f) => { try { await f(); out[k] = "ok"; } catch (e) { out[k] = e.code || String(e); } };
(async () => {
  out.installed = !!global[Symbol.for("openworkbuddy.realDataGuard")];
  t("writeFileSync", () => fs.writeFileSync(path.join(D, "a.json"), "x"));
  t("appendFileSync", () => fs.appendFileSync(path.join(D, "a.jsonl"), "x"));
  t("openSync_w", () => fs.openSync(path.join(D, "b.json"), "w"));
  t("openSync_flags", () => fs.openSync(path.join(D, "c.json"), fs.constants.O_WRONLY | fs.constants.O_CREAT));
  t("mkdirSync", () => fs.mkdirSync(path.join(D, "sub")));
  t("renameSync", () => { fs.writeFileSync(S, "x"); fs.renameSync(S, path.join(D, "moved.txt")); });
  t("copyFileSync", () => fs.copyFileSync(S, path.join(D, "copied.txt")));
  t("unlinkSync", () => fs.unlinkSync(path.join(D, "gone.txt")));
  t("rmSync", () => fs.rmSync(D, { recursive: true, force: true }));
  t("createWriteStream", () => fs.createWriteStream(path.join(D, "s.log")));
  t("installedDir", () => fs.writeFileSync(path.join(I, "x.json"), "x"));
  await ta("promises.writeFile", () => fs.promises.writeFile(path.join(D, "p.json"), "x"));
  await ta("callback.appendFile", () => new Promise((res, rej) => fs.appendFile(path.join(D, "cb.jsonl"), "x", (e) => (e ? rej(e) : res()))));
  t("caseVariant", () => fs.writeFileSync(path.join(DU, "a.json"), "x"));
  // 在临时目录里建一根指向真 data/ 的软链：建软链本身、删软链本身都不动真数据，得照常
  t("symlink_make", () => fs.symlinkSync(REAL_DATA, L));
  t("viaSymlink", () => fs.writeFileSync(path.join(L, path.basename(D), "a.json"), "x"));
  t("viaSymlink_rm", () => fs.rmSync(path.join(L, path.basename(D)), { recursive: true, force: true }));
  t("symlink_unlink", () => fs.unlinkSync(L));
  // 这些得照常：读真文件、mkdir 一个本来就在的真目录（空操作）、写临时目录
  t("read_real", () => fs.readFileSync(${JSON.stringify(path.join(T.roots.dev, "paths.js"))}, "utf8"));
  t("openSync_r", () => fs.closeSync(fs.openSync(${JSON.stringify(path.join(T.roots.dev, "paths.js"))}, "r")));
  t("mkdir_existing", () => fs.mkdirSync(${JSON.stringify(T.roots.dev)}, { recursive: true }));
  t("write_tmp", () => fs.writeFileSync(S + ".2", "x"));
  console.log(JSON.stringify(out));
})();`;
  const r = spawnSync(process.execPath, ["-e", script], { env: guardEnv(log), encoding: "utf8" });
  let out = {}; try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  ok(out.installed === true, "经 NODE_OPTIONS 挂进子进程了", { stdout: r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 300) });
  const blockedOps = ["writeFileSync", "appendFileSync", "openSync_w", "openSync_flags", "mkdirSync", "renameSync", "copyFileSync", "unlinkSync", "rmSync", "createWriteStream", "installedDir", "promises.writeFile", "callback.appendFile"];
  const notBlocked = blockedOps.filter((k) => out[k] !== "EACCES").map((k) => k + "=" + out[k]);
  ok(notBlocked.length === 0, `往真目录写的 ${blockedOps.length} 种写法都是 EACCES（同步 / 回调 / promise / 流 / 改名 / 删除）`, notBlocked);
  // 分大小写的盘上（Linux）DATA/ 跟 data/ 是两个目录，不拦是对的；那边它不存在，只会 ENOENT
  const detour = ["viaSymlink", "viaSymlink_rm"].concat(FOLD ? ["caseVariant"] : []);
  const detourMissed = detour.filter((k) => out[k] !== "EACCES").map((k) => k + "=" + out[k]);
  ok(detourMissed.length === 0, `绕路进真目录也拦：${FOLD ? "换大小写、" : ""}从软链进去写、从软链进去删`, detourMissed);
  const allowed = ["read_real", "openSync_r", "mkdir_existing", "write_tmp", "symlink_make", "symlink_unlink"].filter((k) => out[k] !== "ok").map((k) => k + "=" + out[k]);
  ok(allowed.length === 0, "读真文件、mkdir 一个已经在的目录、写临时目录、建 / 删指向真目录的软链本身都照常", allowed);
  const rows = rowsOf(log);
  const blockedRows = rows.filter((x) => x.blocked);
  const wantRows = blockedOps.length + detour.length;
  ok(blockedRows.length === wantRows, `每拦一下记一笔账（${blockedRows.length}/${wantRows}），带路径和调用栈`, rows.map((x) => x.op));
  ok(blockedRows.every((x) => x.suite === "data-guard-probe" && x.path && Array.isArray(x.stack)), "账里有套件名、路径、调用栈", blockedRows[0]);
  ok(/\[测试护栏\] data-guard-probe 想写真实数据/.test(r.stderr), "stderr 上当场说了一句", r.stderr.slice(0, 200));
  ok(!fs.existsSync(inData) && !fs.existsSync(inInstalled), "真目录里什么也没多出来");
  ok(guard.readBlocked(log).length === new Set(blockedRows.map((x) => x.path)).size, "readBlocked 按路径去重");
  fs.appendFileSync(log, "{半行坏账\n");
  ok(guard.readBlocked(log).some((x) => /读不懂/.test(x.path)), "账里有读不懂的行也算一笔，不当成没写");

  // 删 / 挪真目录的上级：一棵假树（护栏拷一份进去，它护的就是这棵树的 data/），失灵了也只删临时目录
  const TREE = path.join(TMP, "tree");
  fs.mkdirSync(path.join(TREE, "test", "lib"), { recursive: true });
  fs.copyFileSync(GUARD, path.join(TREE, "test", "lib", "real-data-guard.js"));
  fs.mkdirSync(path.join(TREE, "data"));
  fs.writeFileSync(path.join(TREE, "data", "keep.json"), "{}");
  fs.mkdirSync(path.join(TREE, "scratch"));
  const tlog = path.join(TMP, "tree.jsonl");
  const treeScript = `const fs = require("fs"); const out = {};
const t = (k, f) => { try { f(); out[k] = "ok"; } catch (e) { out[k] = e.code || String(e); } };
t("rmRoot", () => fs.rmSync(${JSON.stringify(TREE)}, { recursive: true, force: true }));
t("renameRoot", () => fs.renameSync(${JSON.stringify(TREE)}, ${JSON.stringify(TREE + "-moved")}));
t("rmSibling", () => fs.rmSync(${JSON.stringify(path.join(TREE, "scratch"))}, { recursive: true, force: true }));
console.log(JSON.stringify(out));`;
  const rt = spawnSync(process.execPath, ["-e", treeScript],
    { env: guardEnv(tlog, { NODE_OPTIONS: "--require=" + JSON.stringify(path.join(TREE, "test", "lib", "real-data-guard.js")) }), encoding: "utf8" });
  let ot = {}; try { ot = JSON.parse(rt.stdout.trim().split("\n").pop()); } catch {}
  ok(ot.rmRoot === "EACCES" && ot.renameRoot === "EACCES" && fs.existsSync(path.join(TREE, "data", "keep.json")),
    "删 / 挪真目录的上级（开发态就是仓库根）也拦，底下的真数据还在", { out: ot, err: rt.stderr.slice(0, 300) });
  ok(ot.rmSibling === "ok" && !fs.existsSync(path.join(TREE, "scratch")), "同一层别的目录照删", ot);

  // 显式放行
  const r2 = spawnSync(process.execPath, ["-e", "console.log(!!global[Symbol.for('openworkbuddy.realDataGuard')])"],
    { env: guardEnv(path.join(TMP, "allow.jsonl"), { OPENWORKBUDDY_ALLOW_REAL_DATA: "1" }), encoding: "utf8" });
  ok(r2.stdout.trim() === "false", "OPENWORKBUDDY_ALLOW_REAL_DATA=1：护栏不挂", r2.stdout + r2.stderr);
  const r3 = spawnSync(process.execPath, ["-e", "console.log(!!global[Symbol.for('openworkbuddy.realDataGuard')])"],
    { env: bareEnv({ NODE_OPTIONS: "--require=" + JSON.stringify(GUARD) }), encoding: "utf8" });
  ok(r3.stdout.trim() === "false", "没给 OPENWORKBUDDY_TEST_GUARD 就不挂（生产代码 require 到它也不会被改了 fs）", r3.stdout + r3.stderr);
}

// ─────────────────────────────────────────────────────────────────────────
section("3 all.js 真判得红，也真放得过");
{
  // 一份假仓库：真的 all.js / 护栏 / paths.js，套件换成假的。护栏按「all.js 上两级」认仓库根，
  // 所以在这儿它护的是假仓库的 data/ logs/——怎么写都碰不到用户的东西
  const FAKE = path.join(TMP, "repo");
  fs.mkdirSync(path.join(FAKE, "test", "lib"), { recursive: true });
  fs.copyFileSync(path.join(HERE, "all.js"), path.join(FAKE, "test", "all.js"));
  fs.copyFileSync(GUARD, path.join(FAKE, "test", "lib", "real-data-guard.js"));
  fs.copyFileSync(path.join(HERE, "lib", "own-home.js"), path.join(FAKE, "test", "lib", "own-home.js"));
  fs.copyFileSync(path.join(ROOT, "paths.js"), path.join(FAKE, "paths.js"));
  fs.mkdirSync(path.join(FAKE, "skills", "demo-skill"), { recursive: true });
  fs.writeFileSync(path.join(FAKE, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\n---\n");
  fs.writeFileSync(path.join(FAKE, "experts.json"), "[]");
  // 跟真仓库一样 data/ logs/ 本来就在：拦下的得是写文件那一下，不是 mkdir
  fs.mkdirSync(path.join(FAKE, "data"));
  fs.mkdirSync(path.join(FAKE, "logs"));
  fs.mkdirSync(path.join(FAKE, "workspace", ".openworkbuddy"), { recursive: true });
  const OUT = path.join(TMP, "out");
  fs.mkdirSync(OUT);
  const FAKE_DATA = path.join(FAKE, "data", "audit.json");
  const FAKE_LOG = path.join(FAKE, "logs", "app.jsonl");
  const report = (name) => `require("fs").writeFileSync(${JSON.stringify(OUT)} + "/${name}.json", JSON.stringify({
    home: process.env.OPENWORKBUDDY_HOME || "", dataDir: process.env.OPENWORKBUDDY_DATA_DIR || "", nodeOptions: process.env.NODE_OPTIONS || "",
    guardLog: process.env.OPENWORKBUDDY_TEST_GUARD_LOG || "", trace: process.env.OPENWORKBUDDY_TRACE_FILE || "",
    seeded: !!process.env.OPENWORKBUDDY_HOME && require("fs").existsSync(require("path").join(process.env.OPENWORKBUDDY_HOME, "skills", "demo-skill", "SKILL.md")),
    experts: !!process.env.OPENWORKBUDDY_HOME && require("fs").existsSync(require("path").join(process.env.OPENWORKBUDDY_HOME, "experts.json")) }));`;
  // 假套件的名字得是 SUITES 里有的（all.js 只认那张表）
  // lanes：像 security.js 那样，写真数据包在 try/catch 里吞掉，退出码 0
  fs.writeFileSync(path.join(FAKE, "test", "lanes.js"), `${report("lanes")}
try { require("fs").mkdirSync(require("path").dirname(${JSON.stringify(FAKE_DATA)}), { recursive: true }); require("fs").writeFileSync(${JSON.stringify(FAKE_DATA)}, "[]"); } catch {}
process.exit(0);`);
  // cli-live：自己干净，拉起的孙子进程去写
  fs.writeFileSync(path.join(FAKE, "test", "cli-live.js"), `${report("cli-live")}
require("child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(`try { require("fs").mkdirSync(${JSON.stringify(path.dirname(FAKE_LOG))}, { recursive: true }); require("fs").appendFileSync(${JSON.stringify(FAKE_LOG)}, "x"); } catch {}`)}], { stdio: "inherit" });
process.exit(0);`);
  // md-tty：只往给它的家里写（这才是对的写法）
  fs.writeFileSync(path.join(FAKE, "test", "md-tty.js"), `${report("md-tty")}
const p = require("path").join(process.env.OPENWORKBUDDY_HOME || ${JSON.stringify(OUT)}, "data", "audit.json");
require("fs").mkdirSync(require("path").dirname(p), { recursive: true }); require("fs").writeFileSync(p, "[]");
process.exit(0);`);
  // 在 SELF_ISOLATED 里的两个：agent-loop 忘了起家（像 trace.js 那样落账本、错被吞掉）；continue-gate 起了
  const FAKE_TRACE = path.join(FAKE, "workspace", ".openworkbuddy", "traces.jsonl");
  const traceWrite = `const tf = require("path").join(process.env.OPENWORKBUDDY_HOME || ${JSON.stringify(FAKE)}, "workspace", ".openworkbuddy", "traces.jsonl");
try { require("fs").mkdirSync(require("path").dirname(tf), { recursive: true }); require("fs").appendFileSync(tf, "{}\\n"); } catch {}`;
  fs.writeFileSync(path.join(FAKE, "test", "agent-loop.js"), `${report("agent-loop")}\n${traceWrite}\nprocess.exit(0);`);
  fs.writeFileSync(path.join(FAKE, "test", "continue-gate.js"), `require("./lib/own-home")("continue-gate");\n${report("continue-gate")}\n${traceWrite}\nprocess.exit(0);`);
  // icons：干干净净地挂了（断言红），什么真数据也没碰
  fs.writeFileSync(path.join(FAKE, "test", "icons.js"), `${report("icons")}
require("fs").writeFileSync(require("path").join(process.env.OPENWORKBUDDY_HOME, "left.txt"), "现场");
process.exit(1);`);

  const runAll = (only, extra) => {
    const r = spawnSync(process.execPath, [path.join(FAKE, "test", "all.js"), "--only", only], { env: bareEnv(extra || {}), encoding: "utf8", timeout: 60000 });
    const text = (r.stdout || "") + (r.stderr || "");
    const kept = [...text.matchAll(/留着现场(?:（[^）]*）)?：(.+)/g)].flatMap((m) => m[1].trim().split(/\s{2,}/));
    for (const d of kept) if (path.basename(d).startsWith("owb-")) tmpToClean.push(d);
    return { code: r.status, text, kept };
  };
  const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, name + ".json"), "utf8")); } catch { return null; } };

  // ① 干净的套件：绿；有临时家、铺了技能；护栏挂上了；跑完三个临时目录都收走
  const a = runAll("md-tty");
  const ra = read("md-tty");
  ok(a.code === 0, "干净的套件照样绿", a.text.slice(-400));
  ok(ra && ra.home && path.dirname(ra.home) === path.resolve(os.tmpdir()) && path.basename(ra.home).startsWith("owb-test-home-"),
    "没设 OPENWORKBUDDY_HOME 时，整轮给一个 owb-test-home-* 临时家", ra && ra.home);
  ok(ra && ra.seeded && ra.experts, "临时家里跟 server.js 开机一样铺了技能和 experts.json", ra);
  ok(ra && ra.nodeOptions.includes(path.join(FAKE, "test", "lib", "real-data-guard.js")) && ra.guardLog.endsWith("md-tty.jsonl"),
    "护栏经 NODE_OPTIONS 下发，每个套件一份账", ra && { nodeOptions: ra.nodeOptions, guardLog: ra.guardLog });
  ok(ra && !fs.existsSync(ra.home) && !fs.existsSync(path.dirname(ra.guardLog)) && !fs.existsSync(path.dirname(ra.trace)),
    "全过了：临时家、护栏的账、trace 目录都收走", ra && [ra.home, ra.guardLog, ra.trace].filter((p) => fs.existsSync(p) || fs.existsSync(path.dirname(p))));

  // ② 套件自己把异常吞了（退出码 0），照样判红，路径写得清清楚楚
  const b = runAll("lanes");
  ok(b.code === 1, "写真数据的套件判红，哪怕它自己吞了异常、退出码是 0", b.text.slice(-600));
  ok(b.text.includes("[测试护栏] lanes") && b.text.includes(FAKE_DATA), "红的时候写明是哪个套件、哪个路径", b.text.slice(-600));
  ok(/×\s+lanes/.test(b.text) && b.text.includes("写了真实数据目录"), "汇总那一行也标出来了", b.text.slice(-400));
  ok(!fs.existsSync(FAKE_DATA), "那一下没写进去");
  ok(/留着现场：/.test(b.text), "挂了留着现场，路径打出来");

  // ③ 孙子进程写也抓得到（server.js / cli.js 就是这么被拉起来的）
  const c = runAll("cli-live");
  ok(c.code === 1 && c.text.includes(FAKE_LOG), "套件拉起的子进程写真数据也判红", c.text.slice(-600));
  ok(!fs.existsSync(FAKE_LOG), "孙子进程那一下也没写进去");

  // ④ 自己带了家的，all.js 不换
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), "owb-guardtest-home-"));
  tmpToClean.push(mine);
  const d = runAll("md-tty", { OPENWORKBUDDY_HOME: mine });
  const rd = read("md-tty");
  ok(d.code === 0 && rd && rd.home === mine && fs.existsSync(mine), "外面已经给了 OPENWORKBUDDY_HOME：照用那一个，跑完也不删它", rd && rd.home);

  // ⑤ 明说要写真数据：只关护栏（在假仓库里，写进去也无妨）。临时家照给——
  // 这个开关是护栏误拦时的逃生口，不能顺手把所有没隔离的套件都放进真目录
  const e = runAll("lanes", { OPENWORKBUDDY_ALLOW_REAL_DATA: "1" });
  const re = read("lanes");
  ok(e.code === 0 && fs.existsSync(FAKE_DATA), "OPENWORKBUDDY_ALLOW_REAL_DATA=1：不拦也不判红", e.text.slice(-400));
  ok(re && !re.nodeOptions.includes("real-data-guard") && !re.guardLog, "……护栏不挂", re);
  ok(re && path.basename(re.home).startsWith("owb-test-home-") && re.seeded && !fs.existsSync(re.home),
    "……临时家照给（铺了技能），跑完照样收走", re && re.home);
  ok(/OPENWORKBUDDY_ALLOW_REAL_DATA=1：这一轮没挂护栏/.test(e.text), "汇总里说了这一轮没挂护栏");

  // ⑥ SELF_ISOLATED 的套件：不给家、不给 trace 账本、不给 DATA_DIR，照单独跑的样子跑。
  // 忘了自己起家的，写进（假仓库的）真账本就判红，还说清楚该怎么改
  const outerDataDir = path.join(TMP, "outer-data-dir");
  const f = runAll("agent-loop", { OPENWORKBUDDY_DATA_DIR: outerDataDir });
  const rf = read("agent-loop");
  ok(rf && !rf.home && !rf.trace && !rf.dataDir && rf.nodeOptions.includes("real-data-guard"),
    "SELF_ISOLATED 的套件拿不到整轮的临时家 / trace 账本 / DATA_DIR，护栏照挂", rf);
  ok(f.code === 1 && f.text.includes(FAKE_TRACE) && f.text.includes("SELF_ISOLATED") && f.text.includes("own-home.js"),
    "它没自己起家、往真账本写：判红，路径和改法都写明", f.text.slice(-600));
  ok(!fs.existsSync(FAKE_TRACE), "那一下没写进去");

  // ⑦ 自己起了家的：绿；家是它自己的（不是整轮那个），过了自己收走
  const g = runAll("continue-gate");
  const rg = read("continue-gate");
  ok(g.code === 0 && rg && path.basename(rg.home).startsWith("owb-continue-gate-home-") && !rg.trace,
    "SELF_ISOLATED 的套件自己起了家：绿，用的是自己那个", { code: g.code, home: rg && rg.home, tail: g.text.slice(-300) });
  ok(rg && rg.home && !fs.existsSync(rg.home), "它的家过了就收走", rg && rg.home);

  // ⑧ 干干净净地挂了：留现场，但只留有东西的——空的护栏账、空的 trace 目录删掉，
  // 临时家留着但去掉拷来的出厂技能（Linux 上那是实打实 189M 一份）
  const h = runAll("icons");
  const rh = read("icons");
  ok(h.code === 1 && rh && rh.home, "套件自己挂了：判红", h.text.slice(-300));
  ok(rh && h.kept.length === 1 && h.kept[0] === rh.home && fs.existsSync(path.join(rh.home, "left.txt")),
    "只留临时家这一个现场，路径打出来", { kept: h.kept, home: rh && rh.home });
  ok(rh && !fs.existsSync(path.join(rh.home, "skills")), "留下的家里没有拷来的出厂技能", rh && rh.home);
  ok(rh && !fs.existsSync(path.dirname(rh.guardLog)) && !fs.existsSync(path.dirname(rh.trace)),
    "空的护栏账、空的 trace 目录不留", rh && [rh.guardLog, rh.trace].filter((p) => fs.existsSync(path.dirname(p))));

  // ⑨ SELF_ISOLATED 里写错一个名字，那个套件就照常拿临时家、等于没查：当场退出
  const allSrc = fs.readFileSync(path.join(FAKE, "test", "all.js"), "utf8");
  const typoSrc = allSrc.replace(/const SELF_ISOLATED = new Set\(\[/, '$&"agent-lop", ');
  fs.writeFileSync(path.join(FAKE, "test", "all-typo.js"), typoSrc);
  fs.rmSync(path.join(OUT, "md-tty.json"), { force: true });
  const typoTmp = path.join(TMP, "typo-tmp");
  fs.mkdirSync(typoTmp);
  const ti = spawnSync(process.execPath, [path.join(FAKE, "test", "all-typo.js"), "--only", "md-tty"], { env: bareEnv({ TMPDIR: typoTmp }), encoding: "utf8", timeout: 60000 });
  ok(typoSrc !== allSrc && ti.status === 2 && /SELF_ISOLATED 里有 SUITES 没有的名字.*agent-lop/.test(ti.stderr) && !read("md-tty"),
    "SELF_ISOLATED 里写错名字：一个套件也不跑，退出码 2，名字点出来", { status: ti.status, err: (ti.stderr || "").slice(0, 200) });
  ok(fs.readdirSync(typoTmp).length === 0, "……建了一半的临时目录也收走", fs.readdirSync(typoTmp));
}

// ─────────────────────────────────────────────────────────────────────────
section("4 单独跑也不碰真目录、不留垃圾");
{
  // own-home：赶在 require 生产代码之前起家；过了收走；后面的 exit 钩子才判红的，也算挂了、留着
  const OH = path.join(TMP, "own-home-tmp");
  fs.mkdirSync(OH);
  const ownHome = JSON.stringify(path.join(HERE, "lib", "own-home.js"));
  const probe = (tail) => spawnSync(process.execPath, ["-e",
    `const h = require(${ownHome})("probe"); const p = require(${JSON.stringify(path.join(ROOT, "paths.js"))});
console.log(JSON.stringify({ home: h, env: process.env.OPENWORKBUDDY_HOME, data: p.DATA_DIR }));
require("fs").writeFileSync(require("path").join(h, "x.txt"), "x");
${tail}`], { env: guardEnv(path.join(TMP, "own-home.jsonl"), { TMPDIR: OH }), encoding: "utf8" });
  const parse = (r) => { try { return JSON.parse(r.stdout.trim().split("\n")[0]); } catch { return null; } };
  const green = probe("");
  const pg = parse(green);
  ok(pg && pg.home === pg.env && pg.data === pg.home && path.dirname(pg.home) === OH && path.basename(pg.home).startsWith("owb-probe-home-"),
    "own-home：require paths.js 之前就指好了，DATA_DIR 就是这个临时家", { got: pg, err: green.stderr.slice(0, 300) });
  ok(green.status === 0 && pg && !fs.existsSync(pg.home), "过了（退出码 0）就收走", pg && pg.home);
  const late = probe(`process.on("exit", () => { process.exitCode = 1; });`);
  const pl = parse(late);
  ok(late.status === 1 && pl && fs.existsSync(pl.home) && late.stdout.includes("留着现场（数据目录）：" + pl.home),
    "套件在自己的 exit 钩子里才判红：家留着、路径打出来", { status: late.status, out: late.stdout.slice(-200) });
  const hard = probe(`process.exit(3);`);
  const ph = parse(hard);
  ok(hard.status === 3 && ph && fs.existsSync(ph.home), "process.exit(非 0)：家留着", { status: hard.status });
  ok(guard.readBlocked(path.join(TMP, "own-home.jsonl")).length === 0, "起家、写家里都没碰真目录");

  // e2e.js 单独跑：trace 目录、数据目录都是自己建的，过了都得收走（以前每跑一次留一个 owb-test-trace-*）
  const ET = path.join(TMP, "e2e-tmp");
  fs.mkdirSync(ET);
  const elog = path.join(TMP, "e2e.jsonl");
  const er = spawnSync(process.execPath, [path.join(HERE, "e2e.js")],
    { env: guardEnv(elog, { TMPDIR: ET, E2E_ONLY: "testCron", OPENWORKBUDDY_TEST_GUARD_SUITE: "e2e-standalone" }), encoding: "utf8", timeout: 120000 });
  const leftover = (() => { try { return fs.readdirSync(ET); } catch { return ["读不了"]; } })();
  ok(er.status === 0, "e2e.js 单独跑一条（testCron）：过", (er.stdout + er.stderr).slice(-400));
  ok(leftover.length === 0, "……自己建的临时目录一个不剩", leftover);
  ok(guard.readBlocked(elog).length === 0, "……没碰真目录", guard.readBlocked(elog).slice(0, 3));
}

const failed = fail > 0;
if (failed) console.log("\n留着现场：" + TMP);
for (const d of tmpToClean) { if (failed && d === TMP) continue; try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${failed ? "✗" : "✓"} 测试护栏：${pass} 过 / ${fail} 挂`);
process.exit(failed ? 1 : 0);
