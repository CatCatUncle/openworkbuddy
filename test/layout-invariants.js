// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 目录布局的不变量：代码文件怎么搬，下面这几样都不许跟着动。
 *
 * 仓库根只认一个锚点 src/platform/root.js。以前每个要找根的文件各写各的 __dirname，
 * 文件全在根目录时这样没问题；一挪进子目录，__dirname 就跟着走了。最怕的是 paths.js：
 * 开发态 DATA_DIR 就等于它的 APP_DIR，APP_DIR 一漂，数据根就悄悄分叉到子目录底下——
 * 账号、会话、工作区全对不上，而且代码里好几处拿 DATA_DIR === APP_DIR 的字符串比较判「是不是开发态」，
 * 漂了之后开发壳会往仓库里 seed 一份出厂数据。这些都不会报错，只会「看起来没了」。
 *
 * 所以这里逐字比：
 *   ① ROOT 跟仓库根逐字相等（test/ 不搬，它的上一级就是仓库根）
 *   ② 开发态 APP_DIR === DATA_DIR === 仓库根（干净的子进程里量，不吃本轮测试给的临时家）
 *   ③ 外部工具那张表从 doctor.js 抽到 src/platform/known-tools.js：原名转导出是同一个对象，
 *      除了 cli.js 没有生产代码再 require 体检
 *   ④ root.js 零依赖、老写法（boot-check.js 是 server.js / cli.js 的第一句 require，它也靠 root.js）
 *   ⑤ 打包闸门认得 require(rootPath(...))：不认的话那条边从图上消失，闸门照样绿
 *
 * 每一节都配反向对照：只会变绿的断言不是测试。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { mod } = require("./lib/mod");
const { stripJsComments } = require("./lib/src");
// 单独跑（node test/layout-invariants.js）也不碰真目录：下面要 require paths / doctor / boot-check
require("./lib/own-home")("layout");

/** 仓库根：test/ 这个目录不搬，它的上一级就是 */
const REPO = path.resolve(__dirname, "..");
const ROOT_JS = path.join(REPO, "src", "platform", "root.js");

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (a, b, msg) => ok(a === b, msg, { got: a, want: b });

const root = require(ROOT_JS);

// ── ① 锚点 ────────────────────────────────────────────────────────────────
console.log("\n① ROOT 跟仓库根逐字相等");
eq(root.ROOT, REPO, "★ROOT === 仓库根★（逐字，不是 realpath 之后相等）");
eq(root.rootPath(), REPO, "rootPath() 不带参数就是根本身");
eq(root.rootPath("public", "index.html"), path.join(REPO, "public", "index.html"), "rootPath 按段拼在根下面");
ok(["package.json", "server.js", "paths.js", "public"].every((f) => fs.existsSync(root.rootPath(f))),
  "根下面真有 package.json / server.js / paths.js / public（不是随便哪个目录）");
const pkgOnDisk = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
eq(require(root.rootPath("package.json")).name, "openworkbuddy", "require(rootPath(\"package.json\")).name 是 openworkbuddy");
eq(root.pkg().name, pkgOnDisk.name, "pkg() 读的就是根下那份 package.json");
eq(root.pkg().version, pkgOnDisk.version, "pkg() 的版本号跟盘上那份一致");
ok(root.pkg() === require(root.rootPath("package.json")), "pkg() 走 require 缓存，跟 require(rootPath(…)) 是同一个对象");
// 反向对照：root.js 要是偷懒写成 ROOT = __dirname，得到的是 src/platform——上面那条必须分得出来
ok(path.dirname(ROOT_JS) !== REPO, "反向对照：root.js 自己的 __dirname 不是仓库根（写成 ROOT = __dirname 会被上面抓到）",
  path.dirname(ROOT_JS));

// ── ② 开发态数据根 ────────────────────────────────────────────────────────
console.log("\n② 开发态 APP_DIR === DATA_DIR === 仓库根");
// 必须在子进程里量：本轮 test/all.js 给了临时家（OPENWORKBUDDY_HOME），本进程里的 DATA_DIR 是那个临时目录。
// 子进程把会改数据根的变量全摘掉，cwd 换到别处——证明它跟从哪儿启动无关。
// 只 require paths.js、只打印，不写盘（护栏照挂，写了就红）
function measurePaths(extraEnv) {
  const env = { ...process.env };
  for (const k of ["OPENWORKBUDDY_HOME", "OPENWORKBUDDY_DATA_DIR", "ELECTRON_RUN_AS_NODE", "OWB_PACKAGED"]) delete env[k];
  Object.assign(env, extraEnv || {});
  const r = spawnSync(process.execPath, ["-e",
    "const p = require(process.argv[1]); process.stdout.write(JSON.stringify({ APP_DIR: p.APP_DIR, DATA_DIR: p.DATA_DIR, packaged: p.isPackaged() }))",
    mod("paths")], { cwd: os.tmpdir(), env, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return { error: (r.stderr || String(r.error || "")).slice(0, 400) };
  try { return JSON.parse(r.stdout); } catch { return { error: "输出不是 JSON：" + String(r.stdout).slice(0, 200) }; }
}
const dev = measurePaths();
ok(!dev.error, "干净的子进程里 require paths.js 起得来", dev.error);
eq(dev.packaged, false, "子进程判的是开发态（不是装机态）");
eq(dev.APP_DIR, REPO, "★开发态 APP_DIR === 仓库根★");
eq(dev.DATA_DIR, REPO, "★开发态 DATA_DIR === 仓库根★ 漂了的话账号、会话、工作区会分叉到另一个目录");
ok(dev.DATA_DIR === dev.APP_DIR, "DATA_DIR === APP_DIR 字符串相等（seedDataDir 和 server.js 拿这个判开发态）", dev);
// 反向对照：给了 OPENWORKBUDDY_HOME，DATA_DIR 得真跟着走、APP_DIR 不动——证明上面量的不是写死的值
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "owb-layout-alt-"));
try {
  const moved = measurePaths({ OPENWORKBUDDY_HOME: elsewhere });
  eq(moved.DATA_DIR, path.resolve(elsewhere), "反向对照：设了 OPENWORKBUDDY_HOME，DATA_DIR 跟着走");
  eq(moved.APP_DIR, REPO, "反向对照：APP_DIR 不跟数据根走，仍是仓库根");
} finally { fs.rmSync(elsewhere, { recursive: true, force: true }); }
// 本进程里：APP_DIR 一样是仓库根（DATA_DIR 此时是本轮的临时家，不比）
eq(require(mod("paths")).APP_DIR, REPO, "本进程里 require 的 paths.js，APP_DIR 也是仓库根");
// boot-check 在模块加载时就按根读依赖清单：根要是错了，清单会退回手写那三个
const boot = require(mod("boot-check"));
eq(boot.REQUIRED_DEPS.slice().sort().join(","), Object.keys(pkgOnDisk.dependencies || {}).sort().join(","),
  "boot-check 加载时按 ROOT 读到的依赖清单 = package.json 的 dependencies（不是兜底那三个）");

// ── ③ known-tools 抽离 ────────────────────────────────────────────────────
console.log("\n③ 外部工具清单抽到 src/platform/known-tools.js");
const kt = require(path.join(REPO, "src", "platform", "known-tools.js"));
const doctor = require(mod("doctor"));
for (const k of ["EXTERNAL_TOOLS", "TOOL_ALIASES", "knownTool"]) {
  ok(doctor[k] !== undefined && doctor[k] === kt[k], `doctor.${k} 原名转导出，跟 known-tools 是同一个对象`);
}
eq((kt.knownTool("ffprobe", "darwin") || {}).name, "ffmpeg", "按名字查照旧：ffprobe 折回 ffmpeg");
eq(kt.knownTool("python", "darwin"), null, "反向对照：Mac 上不认 python（only: win32 那条照旧生效）");

// 除了 cli.js（体检命令本身），生产代码不许再 require doctor：底层模块反过来依赖体检，搬家后就是一条上行边
const REQ_DOCTOR = /require\(\s*["'](?:\.{1,2}\/)+(?:[^"']*\/)?doctor(?:\.js)?["']\s*\)/;
const requiresDoctor = (text) => REQ_DOCTOR.test(stripJsComments(text));
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.js"], { cwd: REPO, encoding: "utf8" }).split("\0")
  .filter((f) => f && !f.startsWith("test/") && fs.existsSync(path.join(REPO, f)));
ok(tracked.length > 150, `扫了 ${tracked.length} 个跟踪中的非测试 js（太少说明 git ls-files 坏了）`);
const doctorUsers = tracked.filter((f) => requiresDoctor(fs.readFileSync(path.join(REPO, f), "utf8")));
eq(doctorUsers.join(","), "cli.js", "★require 体检的生产代码只剩 cli.js★ 合成任务、媒体探测、run_shell 都直接 require known-tools");
ok(requiresDoctor('try { x = require("../doctor").knownTool("ffmpeg"); } catch {}'), "反向对照：require(\"../doctor\") 抓得到");
ok(requiresDoctor('const { knownTool } = require("./doctor");'), "反向对照：require(\"./doctor\") 抓得到");
ok(!requiresDoctor(' * 老的 require("./doctor").knownTool 照样能用'), "反向对照：注释里提一句不算");
ok(!requiresDoctor('require("./doctor-report")'), "反向对照：名字只是以 doctor 开头的文件不算");

// ── ④ root.js 零依赖、老写法 ──────────────────────────────────────────────
console.log("\n④ root.js 零依赖、老写法");
const rootSrc = fs.readFileSync(ROOT_JS, "utf8");
const rootReqs = [...stripJsComments(rootSrc).matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]).sort();
eq(rootReqs.join(","), "../../package.json,path", "只 require 了 path 和根下的 package.json，没有别的本仓库模块");
const espree = require("espree");
let parseErr = "";
try { espree.parse(rootSrc, { ecmaVersion: 5, sourceType: "script" }); } catch (e) { parseErr = String(e.message); }
eq(parseErr, "", "用 ES5 语法解析得过（boot-check 的闸门在它后面，它自己不能先在老 Node 上解析失败）");
let probeErr = "";
try { espree.parse("var a = b?.c;", { ecmaVersion: 5, sourceType: "script" }); } catch (e) { probeErr = String(e.message); }
ok(probeErr !== "", "反向对照：同样的解析参数，?. 会被拒（这条检查有牙）");
const bootSrc = fs.readFileSync(mod("boot-check"), "utf8");
ok(/var ROOT = require\("\.\/src\/platform\/root"\)\.ROOT;/.test(bootSrc), "boot-check.js 的根也从 root.js 拿");
ok(!/__dirname/.test(stripJsComments(bootSrc)), "boot-check.js 代码里不再自己用 __dirname 找根");

// ── ⑤ 打包闸门认得 rootPath ───────────────────────────────────────────────
console.log("\n⑤ 打包闸门认得 require(rootPath(...))");
const gate = require(path.join(REPO, "scripts", "check-package-files.js"));
const viaRoot = gate.localRequires('const s = require(rootPath("skills", "x", "y.json"));');
ok(viaRoot.includes(path.join(REPO, "skills", "x", "y.json")), "require(rootPath(...)) 解成仓库根下的绝对路径", viaRoot);
ok(gate.localRequires('const s = require(root.rootPath("skills", "x", "y.json"));').includes(path.join(REPO, "skills", "x", "y.json")),
  "require(root.rootPath(...)) 挂在模块对象上的也认");
eq(gate.localRequires('const s = require(other("skills", "y.json"));').length, 0, "反向对照：别的函数包一层不认");
eq(gate.localRequires('const s = require(myrootPath("skills", "y.json"));').length, 0, "反向对照：名字里带 rootPath 的别的函数不认");
const graph = gate.walkGraph().map((f) => f.split(path.sep).join("/"));
for (const f of ["src/platform/root.js", "src/platform/known-tools.js", "skills/short-drama/references/分镜表.schema.json", "package.json"]) {
  ok(graph.includes(f), `打包闸门从入口爬得到 ${f}`);
}

console.log("\n⑥ 测试用的路径表（test/lib/mod.js、entry.js）对得上盘");
// 以后每批搬家只改这两张表右边的路径；表里一个写错，所有经它取路径的测试就一起指空
{
  const { entry } = require("./lib/entry");
  const Module = require("module");
  const modNames = mod.names(), entryNames = entry.names();
  const gone = [...modNames.map((n) => mod.rel(n)), ...entryNames.map((n) => entry.rel(n))].filter((rel) => !fs.existsSync(path.join(REPO, rel)));
  ok(modNames.length >= 150 && entryNames.length >= 8 && gone.length === 0, `${modNames.length} 个模块 + ${entryNames.length} 个入口，路径全在盘上`, gone);
  const rels = [...modNames.map((n) => mod.rel(n)), ...entryNames.map((n) => entry.rel(n))];
  ok(new Set(rels).size === rels.length && !modNames.some((n) => entry.has(n)), "两张表不重名、不两个名字指同一个文件");
  const pkg = require(path.join(REPO, "package.json"));
  const pkgEntries = [pkg.main, ...Object.values(pkg.bin || {})].map((f) => path.posix.normalize(f));
  ok(pkgEntries.every((f) => entryNames.some((n) => entry.rel(n) === f)), "package.json 的 main / bin 都在入口表里", pkgEntries);
  // mod.spec 算出来的写法，从入口那个目录 require.resolve 回去，得落在同一个文件上
  const fromServer = Module.createRequire(entry("server"));
  const off = modNames.filter((n) => { try { return fromServer.resolve(mod.spec("server", n)) !== mod(n); } catch { return true; } });
  ok(off.length === 0, "mod.spec 给的 require 写法解析回去就是表里那个文件", off);
  let threw = 0;
  try { mod("没有这个模块"); } catch { threw++; }
  try { entry("agent"); } catch { threw++; }
  ok(threw === 2, "反向对照：名字写错、模块名拿去问入口表，都当场抛");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
