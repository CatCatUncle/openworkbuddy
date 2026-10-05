// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 任务里装依赖，不许装到应用自己身上。
 *
 * 跑法：node test/deps-guard.js
 * 全在临时家里：假应用目录（带自己的 package.json / 锁 / node_modules）、它底下的 workspace、
 * 一个本地 file: 依赖。npm 走离线 + 指向 127.0.0.1:9 的假 registry，一个字节不上网。
 *
 * 来由（2026-09-28 真实会话）：agent 在任务文件夹的 .tmp 底下反复 `npm init -y && npm install xlsx`。
 * 开发态下工作空间就是 <应用>/workspace，少了 init 那一步，npm 往上找项目根找到的就是应用自己：
 * 改应用的 package.json、往应用的 node_modules 里装，uninstall 还会删应用的依赖。
 * 第 1 组先把这个洞在没护栏的样子下复现出来（★反向对照★），后面每一组查护栏把它堵住了。
 */
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("deps-guard");

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src");

// npm 全程离线、不读人家 ~/.npmrc、缓存落在临时家里。runShell 起的子进程继承这些
Object.assign(process.env, {
  npm_config_cache: path.join(HOME, "npm-cache"),
  npm_config_offline: "true",
  npm_config_registry: "http://127.0.0.1:9/",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_userconfig: path.join(HOME, "no-npmrc"),
  npm_config_store_dir: path.join(HOME, "pnpm-store"),
  XDG_CACHE_HOME: path.join(HOME, "xdg-cache"),
  XDG_DATA_HOME: path.join(HOME, "xdg-data"),
  XDG_STATE_HOME: path.join(HOME, "xdg-state"),
  XDG_CONFIG_HOME: path.join(HOME, "xdg-config"),
});

const tools = require(mod("tools"));
const guard = require(mod("deps-guard"));
const wsBrowse = require(mod("ws-browse"));
const CT = require(mod("code-tools"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);

const DEP = path.join(HOME, "localdep");
fs.mkdirSync(DEP, { recursive: true });
fs.writeFileSync(path.join(DEP, "package.json"), JSON.stringify({ name: "localdep", version: "1.0.0", main: "index.js" }));
fs.writeFileSync(path.join(DEP, "index.js"), "module.exports = 42;\n");
const SPEC = "file:" + DEP;

/** 一个假应用：自己的依赖 keepme 已经装好，底下是开发态的 workspace/任务_x */
function mkApp(tag) {
  const base = path.join(HOME, tag);
  const app = path.join(base, "app");
  const keep = path.join(base, "keepme");
  fs.mkdirSync(keep, { recursive: true });
  fs.writeFileSync(path.join(keep, "package.json"), JSON.stringify({ name: "keepme", version: "1.0.0" }));
  fs.mkdirSync(path.join(app, "node_modules", "keepme"), { recursive: true });
  fs.writeFileSync(path.join(app, "node_modules", "keepme", "package.json"), JSON.stringify({ name: "keepme", version: "1.0.0" }));
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "fake-app", version: "1.0.0", type: "commonjs", dependencies: { keepme: "file:../keepme" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(app, "package-lock.json"), JSON.stringify({ name: "fake-app", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "fake-app", version: "1.0.0", dependencies: { keepme: "file:../keepme" } } } }, null, 2) + "\n");
  const ws = path.join(app, "workspace");
  const task = path.join(ws, "任务_x");
  fs.mkdirSync(task, { recursive: true });
  return { base, app: fs.realpathSync(app), ws: fs.realpathSync(ws), task: fs.realpathSync(task) };
}
/** 应用这边会被装依赖动到的三样：清单、锁、node_modules 里有谁 */
function snap(app) {
  const read = (f) => { try { return fs.readFileSync(path.join(app, f), "utf8"); } catch { return null; } };
  let nm = [];
  try { nm = fs.readdirSync(path.join(app, "node_modules")).filter((n) => !n.startsWith(".")).sort(); } catch {}
  return JSON.stringify({ pj: read("package.json"), lock: read("package-lock.json"), pnpmLock: read("pnpm-lock.yaml"), nm });
}
/** 不挂护栏、原样跑一条命令（老样子） */
const raw = (cmd, cwd) => spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", env: { ...process.env }, timeout: 120000 });
const exitOf = (r) => { const m = /exit code: (-?\d+)/.exec(r.content || ""); return m ? Number(m[1]) : NaN; };
const has = (p) => fs.existsSync(p);
const BLOCK = "OpenWorkBuddy 拦下了这条";
const have = (bin) => spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

(async () => {
  if (process.platform === "win32") { console.log("Windows 上只有围栏那一层，这个套件按 POSIX 写，跳过"); process.exit(0); }
  if (!have("npm")) { console.log("本机没有 npm，跳过（装依赖的洞本来就要有 npm 才开得出来）"); process.exit(0); }

  // ─────────────────────────────────────────────────────────────
  section("① ★反向对照★ 没有护栏：任务文件夹里装依赖，装到了应用身上");
  {
    const R = mkApp("raw");
    const before = snap(R.app);
    const r = raw(`npm install ${SPEC}`, R.task);
    ok(r.status === 0, "npm 本身是装成了的（离线、本地 file: 依赖）", r.stderr);
    ok(snap(R.app) !== before && /localdep/.test(fs.readFileSync(path.join(R.app, "package.json"), "utf8")),
      "★反向对照★ 应用自己的 package.json 被写进了 localdep——就是要堵的那个洞");
    ok(has(path.join(R.app, "node_modules", "localdep")), "  └ 装进的是应用的 node_modules");
    ok(!has(path.join(R.task, "node_modules")), "  └ 任务文件夹里什么都没有：agent 看着像没装上");
    const u = raw("npm uninstall keepme", R.task);
    ok(u.status === 0 && !/keepme/.test(fs.readFileSync(path.join(R.app, "package.json"), "utf8")),
      "★反向对照★ 在任务文件夹里 uninstall，删掉的是应用自己的依赖", u.stderr);
  }

  // ─────────────────────────────────────────────────────────────
  section("② run_shell 里装依赖：装在任务文件夹里，应用一个字节不动；围栏不算成果");
  const G = mkApp("guard");
  tools.setWorkspaceDir(G.ws);
  tools._internals.setDepsAppDir(G.app);
  {
    const before = snap(G.app);
    const r = await tools._internals.runShell(`npm install ${SPEC}`, 120000, G.task);
    ok(exitOf(r) === 0, "命令照常跑完、exit 0（护栏不拦正经装依赖）", r.content);
    ok(snap(G.app) === before, "应用的 package.json / package-lock.json / node_modules 一个字节没变");
    ok(has(path.join(G.task, "node_modules", "localdep", "index.js")), "依赖装进了任务文件夹自己的 node_modules");
    ok(guard.isFence(path.join(G.task, "package.json")) && guard.isFence(path.join(G.ws, "package.json")),
      "任务文件夹和工作空间根各立了一道带记号的围栏");
    const pj = JSON.parse(fs.readFileSync(path.join(G.task, "package.json"), "utf8"));
    ok(pj[guard.MARK] === true && pj.dependencies && pj.dependencies.localdep, "npm 往围栏里记依赖时记号还在（还认得出是围栏）", pj);

    // 用户自己的 package.json 和锁文件是正经成果：放在另一个任务文件夹里当对照
    const mine = path.join(G.ws, "任务_自己的工程");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "package.json"), JSON.stringify({ name: "my-site", version: "0.1.0" }));
    fs.writeFileSync(path.join(mine, "package-lock.json"), "{}");
    fs.writeFileSync(path.join(G.task, "报告.md"), "# 成果\n");

    const names = tools.outputFiles().map((f) => f.name);
    ok(!names.includes("任务_x/package.json") && !names.includes("任务_x/package-lock.json") && !names.includes("package.json"),
      "成果列表里没有围栏，也没有围栏旁边的锁文件", names);
    ok(names.includes("任务_x/报告.md"), "  └ 同一个文件夹里真正的成果照样在");
    ok(names.includes("任务_自己的工程/package.json") && names.includes("任务_自己的工程/package-lock.json"),
      "★反向对照★ 用户自己的 package.json 和锁文件照样算成果（只认记号，不认名字）", names);

    const turn = tools.turnSnapshot("任务_x").files.map((f) => f.name);
    ok(!turn.some((n) => /(^|\/)package(-lock)?\.json$/.test(n) && !n.startsWith("任务_自己的工程/")),
      "「本回合产出」的快照里也没有围栏和锁", turn);
    ok(turn.includes("任务_自己的工程/package.json"), "★反向对照★ 快照里用户那份 package.json 在");

    const names1 = (rel) => { const l = wsBrowse.listDir(G.ws, rel, {}); return [...l.dirs, ...l.files].map((e) => path.basename(e.name)); };
    const top = names1(""), inTask = names1("任务_x"), inMine = names1("任务_自己的工程");
    ok(!top.includes("package.json") && !inTask.includes("package.json") && !inTask.includes("package-lock.json"),
      "文件面板（资料库「工作区」那一栏）翻进去也看不见围栏", { top, inTask });
    ok(inMine.includes("package.json") && inMine.includes("package-lock.json"), "★反向对照★ 翻进用户自己的工程，两份都看得见", inMine);
  }

  // ─────────────────────────────────────────────────────────────
  section("③ 照着 09-28 那条会话的写法跑：.tmp 底下 init + install，和少了 init 的那一种");
  {
    const before = snap(G.app);
    const t2 = path.join(G.ws, "任务_0928_税务");
    fs.mkdirSync(t2, { recursive: true });
    const r = await tools._internals.runShell(`cd .tmp 2>/dev/null || mkdir -p .tmp && cd .tmp && rm -rf xlsread2 && mkdir -p xlsread2 && cd xlsread2 && npm init -y >/dev/null 2>&1 && npm install ${SPEC} >/dev/null 2>&1 && node -e "console.log(require('localdep'))"`, 120000, t2);
    ok(exitOf(r) === 0 && /42/.test(r.content), "原样那条（先 init）照常装上、require 得到", r.content);
    ok(snap(G.app) === before, "应用没动");

    const r2 = await tools._internals.runShell(`mkdir -p .tmp && cd .tmp && npm install ${SPEC} && node -e "console.log(require('localdep'))"`, 120000, t2);
    ok(exitOf(r2) === 0 && /42/.test(r2.content), "少了 init 那一种：也装上了、require 得到", r2.content);
    ok(snap(G.app) === before, "应用照样没动（没护栏时这一条就是第 ① 组那样装到应用身上）");
    ok(has(path.join(t2, "node_modules", "localdep")), "  └ 落在这个任务文件夹里（往上找碰到它的围栏就停）");
    const names = tools.outputFiles().map((f) => f.name);
    ok(!names.some((n) => n.startsWith("任务_0928_税务/") && /package(-lock)?\.json$/.test(n)), "成果列表里还是看不见围栏", names);

    const u = await tools._internals.runShell("mkdir -p .tmp && cd .tmp && npm uninstall keepme", 120000, t2);
    ok(/keepme/.test(fs.readFileSync(path.join(G.app, "package.json"), "utf8")) && snap(G.app) === before,
      "任务文件夹里 uninstall 应用的依赖：应用那份一个字节没少", u.content);
  }

  // ─────────────────────────────────────────────────────────────
  section("④ 自己走回应用目录的（cd ../.. / --prefix）：当场拦下，别的照常放行");
  {
    const before = snap(G.app);
    const cases = [
      [`cd ${JSON.stringify(G.app)} && npm install ${SPEC}`, "cd 到应用目录再 npm install"],
      [`cd ../.. && npm i ${SPEC}`, "cd ../.. 走回去再 npm i"],
      [`npm install --prefix ${JSON.stringify(G.app)} ${SPEC}`, "--prefix 指到应用目录"],
      [`npm --prefix=${G.app} uninstall keepme`, "--prefix= 写法 + uninstall"],
      [`cd ${JSON.stringify(G.app)} && npm init -y`, "在应用目录里 npm init"],
      [`cd ${JSON.stringify(G.app)} && pnpm add ${SPEC}`, "pnpm add"],
      [`cd ${JSON.stringify(G.app)} && yarn add ${SPEC}`, "yarn add（本机有没有 yarn 都先拦）"],
      [`cd ${JSON.stringify(G.app)} && yarn`, "光一个 yarn（= 装依赖）"],
      [`pnpm -C ${JSON.stringify(G.app)} add ${SPEC}`, "pnpm -C 指到应用目录"],
    ];
    for (const [cmd, what] of cases) {
      const r = await tools._internals.runShell(cmd, 120000, G.task);
      ok(exitOf(r) !== 0 && r.content.includes(BLOCK) && r.content.includes(G.app), `拦下：${what}`, r.content);
    }
    ok(snap(G.app) === before, "拦了一圈，应用的清单 / 锁 / node_modules 一个字节没变");

    const ls = await tools._internals.runShell(`cd ${JSON.stringify(G.app)} && npm ls --depth=0`, 120000, G.task);
    ok(!ls.content.includes(BLOCK) && /keepme/.test(ls.content), "★反向对照★ 应用目录里只读的 npm ls 放行，照常列出", ls.content);
    const gv = await tools._internals.runShell("npm -v", 120000, G.task);
    ok(exitOf(gv) === 0 && /^\s*stdout:\n\d+\.\d+/.test(gv.content), "★反向对照★ npm -v 原样转给真 npm（垫片不吞输出）", gv.content);
    const glob = await tools._internals.runShell(`cd ${JSON.stringify(G.app)} && npm ls -g --depth=0 >/dev/null; npm install -g --dry-run ${SPEC} >/dev/null 2>&1; echo done`, 120000, G.task);
    ok(!glob.content.includes(BLOCK), "★反向对照★ -g 全局的跟应用无关，不拦", glob.content);

    // 同一条命令不带垫片跑：应用被改。证明上面那几条是垫片拦下的，不是命令本来就失败
    const X = mkApp("shim-raw");
    const bx = snap(X.app);
    fs.writeFileSync(path.join(X.task, "package.json"), JSON.stringify({ name: "t", private: true, [guard.MARK]: true }));
    const rr = raw(`cd ${JSON.stringify(X.app)} && npm install ${SPEC}`, X.task);
    ok(rr.status === 0 && snap(X.app) !== bx, "★反向对照★ 同样 cd 回应用目录装，不挂垫片：应用的 package.json 被改了（只有围栏挡不住这一种）");
  }

  // ─────────────────────────────────────────────────────────────
  section("⑤ 只在「工作空间嵌在应用目录里」时挂：别的摆法一律不动");
  {
    const outside = path.join(HOME, "别处的工作空间");
    fs.mkdirSync(path.join(outside, "任务_y"), { recursive: true });
    const p1 = guard.prepare({ appDir: G.app, wsDir: outside, cwd: path.join(outside, "任务_y"), text: "npm i x", shimDir: path.join(HOME, "shims-a") });
    ok(!p1.fences.length && !Object.keys(p1.env).length && !has(path.join(outside, "package.json")),
      "工作空间在应用外面（打包版 ~/OpenWorkBuddy 就是这样）：不立围栏、不改 PATH", p1);
    const p2 = guard.prepare({ appDir: G.app, wsDir: G.app, cwd: G.app, text: "npm i x", shimDir: path.join(HOME, "shims-b") });
    ok(!p2.fences.length && !Object.keys(p2.env).length, "工作空间就是应用仓库本身（人拿它改应用）：npm install 是正经活，不拦", p2);
    const p3 = guard.prepare({ appDir: G.app, wsDir: G.ws, cwd: G.task, text: "echo hi && ls", shimDir: path.join(HOME, "shims-c") });
    ok(!p3.fences.length && p3.env.OWB_PM_GUARD_APP === G.app, "命令里没提包管理器：不多放围栏文件（垫片照挂，便宜）", p3);
    fs.mkdirSync(path.join(G.ws, "任务_新"), { recursive: true });
    const p4 = guard.prepare({ appDir: G.app, wsDir: G.ws, cwd: path.join(G.ws, "任务_新"), text: "npx vite build", shimDir: path.join(HOME, "shims-c") });
    ok(p4.fences.length === 1 && p4.fences[0] === path.join(G.ws, "任务_新"), "★反向对照★ 嵌着、又提到了 npx：新的任务文件夹立上围栏", p4);
    ok(!guard.PM_RE.test("cat snpm.txt") && !guard.PM_RE.test("./node_modules/.bin/npm-run-all") && guard.PM_RE.test("cd a && pnpm i"),
      "认包管理器按词认：snpm.txt、npm-run-all 不算，pnpm i 算");
    const savedWs = tools.getDefaultWorkspaceDir();
    tools.setWorkspaceDir(outside);
    ok(!Object.keys(tools._internals.depsGuardEnv(path.join(outside, "任务_y"), "npm i x", "/usr/bin")).length, "tools 那边也一样：工作空间换到外面，env 是空的");
    tools.setWorkspaceDir(savedWs);
    ok(tools._internals.depsGuardEnv(G.task, "npm i x", "/usr/bin").PATH.endsWith(":/usr/bin"), "★反向对照★ 换回嵌着的：PATH 前面垫了一层，原来的接在后面");
  }

  // ─────────────────────────────────────────────────────────────
  section("⑥ pnpm 也碰到围栏就停");
  if (!have("pnpm")) console.log("  （本机没有 pnpm，跳过这一组；垫片那边第 ④ 组已经查过 pnpm 会被拦）");
  else {
    const before = snap(G.app);
    const t3 = path.join(G.ws, "任务_pnpm");
    fs.mkdirSync(t3, { recursive: true });
    const r = await tools._internals.runShell(`pnpm add ${SPEC} --offline --config.confirmModulesPurge=false`, 120000, t3);
    ok(exitOf(r) === 0 && has(path.join(t3, "node_modules", "localdep")), "pnpm add 装在任务文件夹里", r.content);
    ok(snap(G.app) === before, "应用没动");
    ok(guard.isFence(path.join(t3, "package.json")) && tools.outputFiles().every((f) => !/^任务_pnpm\/(package\.json|pnpm-lock\.yaml)$/.test(f.name)),
      "pnpm 改过的围栏还认得出，pnpm-lock.yaml 跟着藏");
    const P = mkApp("pnpm-raw");
    const bp = snap(P.app);
    const rp = raw(`pnpm add ${SPEC} --offline --config.confirmModulesPurge=false`, P.task);
    ok(snap(P.app) !== bp, "★反向对照★ 没护栏时同一条 pnpm add 改的是应用的 package.json", (rp.stderr || rp.stdout || "").slice(-400));
  }

  // ─────────────────────────────────────────────────────────────
  section("⑦ run_node 脚本里 execSync 装依赖 / 后台命令：同样挡住");
  {
    const N = mkApp("node");
    // run_node 会把 <工作空间>/.tmp/node_modules 软链到应用真的 node_modules；这里先放个真目录占住，
    // 免得测试里的 npm 碰到指向本仓库依赖的那条链接
    fs.mkdirSync(path.join(N.ws, ".tmp", "node_modules"), { recursive: true });
    tools.setWorkspaceDir(N.ws);
    tools._internals.setDepsAppDir(N.app);
    const before = snap(N.app);
    const code = `const { execSync } = require("child_process");
execSync(${JSON.stringify(`npm install ${SPEC}`)}, { cwd: ${JSON.stringify(N.task)}, stdio: "pipe" });
console.log("ok " + require(${JSON.stringify(path.join(N.task, "node_modules", "localdep"))}));`;
    const r = await tools._internals.runNode(code, 120000, N.task);
    ok(!r.isError && /ok 42/.test(r.content), "run_node 里 execSync npm install：装上了", r.content);
    ok(snap(N.app) === before, "应用没动（run_node 的脚本也过了护栏）");
    const blocked = await tools._internals.runNode(`const r = require("child_process").spawnSync("npm", ["install", ${JSON.stringify(SPEC)}], { cwd: ${JSON.stringify(N.app)}, encoding: "utf8" });
console.log("status " + r.status + " " + r.stderr);`, 120000, N.task);
    ok(/status 1/.test(blocked.content) && blocked.content.includes(BLOCK), "run_node 里 cwd 指到应用目录去装：拦下", blocked.content);
    ok(snap(N.app) === before, "  └ 应用没动");

    const bgr = tools._internals.startBackground(`cd ${JSON.stringify(N.app)} && npm install ${SPEC}`, N.task, { sessionId: "s_deps" });
    const id = (/已在后台起好 (bg\d+)/.exec(bgr.content) || [])[1];
    ok(!!id, "后台命令起来了", bgr.content);
    let got = null;
    for (let i = 0; i < 200 && id; i++) {
      got = CT.bgRead(id, { all: true });
      if (got.job && got.job.exit !== undefined) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    ok(got && got.job && got.job.exit === 1 && got.text.includes(BLOCK), "后台命令（background:true）走回应用目录装：一样拦下", got && got.text);
    ok(snap(N.app) === before, "  └ 应用没动");
    tools.setWorkspaceDir(G.ws);
    tools._internals.setDepsAppDir(G.app);
  }

  // ─────────────────────────────────────────────────────────────
  section("⑧ 起子进程的三处都接了护栏；空任务文件夹收尾认得出孤零零的围栏");
  {
    const t = src("tools");
    const sites = [
      ["run_shell", /function runShell\([\s\S]*?env: \{[^}]*\.\.\.depsGuardEnv\(cwd, command,/],
      ["后台命令", /function startBackground\([\s\S]*?env: \{[^}]*\.\.\.depsGuardEnv\(cwd, cmd,/],
      ["run_node", /function runNode\([\s\S]*?env: \{[^}]*\.\.\.depsGuardEnv\(cwd, code,/],
    ];
    for (const [what, re] of sites) ok(re.test(t), `${what} 的子进程环境并进了 depsGuardEnv`);
    const cut = t.replace(/, \.\.\.depsGuardEnv\(cwd, command, shellPath\(\)\)/, "");
    ok(!sites[0][1].test(cut), "★反向对照★ 把 run_shell 那处删掉，上面那条就认不出来（正则真在看这一处）");
    ok(/dropLoneFence\(full\)[\s\S]{0,200}readdirSync\(full\)\.length/.test(src("server")),
      "server.js 收尾删空任务文件夹之前，先把孤零零的围栏拿掉");
    const browseSrc = fs.readFileSync(mod("ws-browse"), "utf8");
    ok(/const depsGuard = require\("\.\/deps-guard"\)/.test(browseSrc) && /depsGuard\.hiddenByFence\(name, fullPath\)/.test(browseSrc),
      "跳过规矩只有一份（ws-browse.js 的 skipEntry）：成果列表、快照、文件面板共用");

    const d1 = path.join(HOME, "lone-1");
    fs.mkdirSync(d1, { recursive: true });
    guard.writeFence(d1);
    ok(guard.dropLoneFence(d1) && !fs.readdirSync(d1).length, "只剩一道围栏（装依赖没装成）：拿掉，文件夹算空的");
    const d2 = path.join(HOME, "lone-2");
    fs.mkdirSync(d2, { recursive: true });
    guard.writeFence(d2);
    fs.writeFileSync(path.join(d2, "a.txt"), "x");
    ok(!guard.dropLoneFence(d2) && has(path.join(d2, "package.json")), "★反向对照★ 围栏旁边还有别的：一个都不碰");
    const d3 = path.join(HOME, "lone-3");
    fs.mkdirSync(d3, { recursive: true });
    fs.writeFileSync(path.join(d3, "package.json"), JSON.stringify({ name: "mine" }));
    ok(!guard.dropLoneFence(d3) && has(path.join(d3, "package.json")), "★反向对照★ 只有一份用户自己的 package.json：不是围栏，不删");
    ok(!guard.writeFence(d3) && JSON.parse(fs.readFileSync(path.join(d3, "package.json"), "utf8")).name === "mine",
      "已经有 package.json 的地方不立围栏、不覆盖人家那份");
  }

  // ─────────────────────────────────────────────────────────────
  section("⑨ 围栏被 npm init 并成真工程：就是人家的了，文件面板照常看得见、收尾不删");
  {
    // 2026-09-29 复审：围栏先立好，npm init 往已有的 package.json 里并字段、记号原样留着。
    // 只认记号的话，这份真的工程清单（连同锁文件）在文件面板里藏掉；文件夹里只剩它时收尾还会把它删了
    const Module = require("module");
    const GUARD_SRC = mod("deps-guard");
    const cut = "yes = !!(pj && pj[MARK]) && Object.keys(pj).every((k) => FENCE_KEYS.has(k));";
    const srcNow = fs.readFileSync(GUARD_SRC, "utf8");
    ok(srcNow.includes(cut), "反向对照要换的那句还在源码里（不在的话下面的对照是空跑）");
    const m = new Module(GUARD_SRC, module);
    m.filename = GUARD_SRC;
    m.paths = Module._nodeModulePaths(path.dirname(GUARD_SRC));
    m._compile(srcNow.replace(cut, "yes = !!(pj && pj[MARK]);"), GUARD_SRC);
    const oldGuard = m.exports; // 改之前：只认记号

    tools.setWorkspaceDir(G.ws);
    tools._internals.setDepsAppDir(G.app);
    const before = snap(G.app);
    const t9 = path.join(G.ws, "任务_init工程");
    fs.mkdirSync(t9, { recursive: true });
    const r = await tools._internals.runShell(`npm init -y >/dev/null && npm install ${SPEC} >/dev/null && node -e "console.log(require('localdep'))"`, 120000, t9);
    ok(exitOf(r) === 0 && /42/.test(r.content), "任务文件夹里 npm init -y && npm install：照常装上", r.content);
    ok(snap(G.app) === before, "  └ 应用没动");
    const pjFile = path.join(t9, "package.json");
    const pj = JSON.parse(fs.readFileSync(pjFile, "utf8"));
    ok(pj[guard.MARK] === true && pj.version && pj.scripts, "npm init 是并进围栏里的：记号还在，version / scripts 也进来了（复审说的那个场景真会出现）", pj);
    ok(oldGuard.isFence(pjFile), "★反向对照★ 只认记号（改之前）：这份真工程清单被当成围栏");
    ok(!guard.isFence(pjFile), "★现在：多出工程字段就不算围栏★");
    const names = tools.outputFiles().map((f) => f.name);
    ok(names.includes("任务_init工程/package.json") && names.includes("任务_init工程/package-lock.json"), "成果列表里看得见这份清单和它的锁文件", names.filter((n) => n.startsWith("任务_init工程/")));
    const l = wsBrowse.listDir(G.ws, "任务_init工程", {});
    const inIt = [...l.dirs, ...l.files].map((e) => path.basename(e.name));
    ok(inIt.includes("package.json") && inIt.includes("package-lock.json"), "文件面板翻进去也看得见", inIt);

    const lone = path.join(HOME, "lone-init");
    fs.mkdirSync(lone, { recursive: true });
    guard.writeFence(lone);
    const sp = spawnSync("npm", ["init", "-y"], { cwd: lone, encoding: "utf8" });
    ok(sp.status === 0 && fs.readdirSync(lone).length === 1, "只 npm init、没装依赖：文件夹里只剩这一份清单", { st: sp.status, ls: fs.readdirSync(lone), err: sp.stderr });
    ok(oldGuard.isFence(path.join(lone, "package.json")), "★反向对照★ 改之前它会被认成「没装成的围栏」");
    ok(!guard.dropLoneFence(lone) && has(path.join(lone, "package.json")), "★收尾不删它★ 那是人家 init 出来的工程");

    let nShape = 0;
    const shape = (extra) => {
      const d = path.join(HOME, "fence-shape-" + ++nShape);
      fs.mkdirSync(d, { recursive: true });
      guard.writeFence(d);
      const f = path.join(d, "package.json");
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...extra }));
      return guard.isFence(f);
    };
    ok(shape({ dependencies: { a: "1" }, devDependencies: { b: "1" }, optionalDependencies: { c: "1" }, packageManager: "pnpm@9.0.0" }),
      "装依赖时包管理器往里记的（依赖清单、corepack 钉的 packageManager）：还是围栏");
    ok(!shape({ scripts: { dev: "vite" } }) && !shape({ version: "1.0.0" }), "★反向对照★ 多一个 scripts 或 version：就不是了");
  }

  CT.bgKillAll && CT.bgKillAll((c) => { try { process.kill(-c.pid, "SIGKILL"); } catch {} });
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
