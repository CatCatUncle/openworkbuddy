// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Windows 系统沙箱（src/platform/sandbox.js 的 Windows 段 + native/owb-sandbox 小助手）。
 *
 * 跑法：node test/sandbox-win.js
 * 全离线：临时数据根，机密文件里只有占位文字。
 *
 *   【1】纯函数（哪个系统上都跑）：命令行引号来回拆得回原样、工作区能不能打标记、打标记的参数、
 *        包好的命令长什么样、「拒绝访问」那句提示、退出码和 main.go 对齐
 *   【2】接线（哪个系统上都跑）：run_shell / run_node 把包法给的环境变量和 spawn 选项真叠上了；
 *        设置页 Windows 上也画开关、英文有译文；打包时缺小助手当场红、只留本架构那份；流水线现编小助手
 *   【3】真降权（只在 Windows）：级别真是低、Key 和账本读不到（含之后新写的、改名换上的）、
 *        工作区和临时目录写得进、应用目录 / 数据根 / 主目录 / 注册表写不进、联接点不跟、
 *        退出码原样、带空格带引号的参数原样到、小助手一死整棵树跟着收；量每条命令多花多少时间
 *   【4】真接线（只在 Windows）：run_shell / run_node / 后台命令真走沙箱；关掉就不套；
 *        小助手不见了 auto 照跑、required 不跑
 *
 * Windows 上没编小助手（npm run build:sandbox）时【3】【4】跳过；CI 那条腿设了 OWB_REQUIRE_SANDBOX_WIN=1，跳过算红。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const { mod } = require("./lib/mod");
const OWN = require("./lib/own-home")("sandbox-win");

const WIN = process.platform === "win32";
// Windows 上 os.homedir() 认 USERPROFILE，不认 HOME；LocalLow 得是真的那个，这里不动
if (!WIN) {
  const fakeHome = path.join(OWN, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
}

const SB = require(mod("sandbox"));
const T = require(mod("tools"));
const R = T._internals;

let pass = 0, fail = 0, finished = false;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("exit", () => {
  if (!finished) { console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`); process.exitCode = 1; }
  else if (fail) process.exitCode = 1;
});

const SECRET = "placeholder-secret-for-sandbox-win-test";
// Windows 上 git 按 CRLF 检出：统一成 \n，下面按行切函数、按行认规则的正则才认得出
const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\r\n/g, "\n");

/**
 * 按微软 C 运行库的规矩把一行命令拆回参数（CommandLineToArgvW 对 argv[0] 以外那几段的拆法）。
 * winQuote 拼出来的东西拆回去必须一字不差
 */
function parseWinArgs(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= n) break;
    let arg = "", inQ = false;
    while (i < n) {
      const c = line[i];
      if (!inQ && (c === " " || c === "\t")) break;
      if (c === "\\") {
        let bs = 0;
        while (i < n && line[i] === "\\") { bs++; i++; }
        if (line[i] === '"') {
          arg += "\\".repeat(Math.floor(bs / 2));
          if (bs % 2) { arg += '"'; i++; }
        } else arg += "\\".repeat(bs);
        continue;
      }
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { arg += '"'; i += 2; continue; }
        inQ = !inQ; i++; continue;
      }
      arg += c; i++;
    }
    out.push(arg);
  }
  return out;
}

function pure() {
  section("【1】纯函数");
  const q = SB.winQuote;
  ok(q("") === '""', "空串给一对引号", q(""));
  ok(q("abc") === "abc" && q("C:\\x\\y.exe") === "C:\\x\\y.exe", "没空格没引号的原样");
  ok(q("a b") === '"a b"' && q("C:\\Program Files\\x.exe") === '"C:\\Program Files\\x.exe"', "带空格的包一层引号，中间的反斜杠不动", q("C:\\Program Files\\x.exe"));
  ok(q('a"b') === '"a\\"b"', "引号前加反斜杠", q('a"b'));
  ok(q("a b\\") === '"a b\\\\"', "结尾的反斜杠加倍（不然把收尾那个引号吃掉）", q("a b\\"));
  // 随机拼一堆最难缠的字符，拼成一行再按 Windows 的规矩拆回来，必须原样
  const alphabet = ["a", " ", "\t", '"', "\\", "中", "%", "^", "&"];
  let seed = 7, bad = null;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  for (let t = 0; t < 2000 && !bad; t++) {
    const args = Array.from({ length: 1 + rnd(4) }, () => Array.from({ length: rnd(9) }, () => alphabet[rnd(alphabet.length)]).join(""));
    const back = parseWinArgs(args.map(q).join(" "));
    if (!same(back, args)) bad = { args, line: args.map(q).join(" "), back };
  }
  ok(!bad, "2000 组随机参数：拼成一行再拆回来，一字不差", bad);

  const home = "C:\\Users\\u";
  const env = SB.lowEnv(home);
  const low = "C:\\Users\\u\\AppData\\LocalLow\\OpenWorkBuddy";
  ok(same(Object.keys(env).sort(), ["PIP_CACHE_DIR", "TEMP", "TMP", "UV_CACHE_DIR", "npm_config_cache"].sort()), "降权后改的环境变量就这几个（不碰 PYTHONUSERBASE，用户装的包照样找得到）", env);
  ok(Object.values(env).every((v) => v.startsWith(low + "\\")), "全指到 LocalLow\\OpenWorkBuddy 底下", env);
  ok(env.TEMP === env.TMP && env.TEMP === SB.lowDirs(home).tmp, "TEMP 和 TMP 是同一处");

  const H = "C:\\Program Files\\OpenWorkBuddy\\resources\\app\\native\\bin\\owb-sandbox-x64.exe";
  SB._setWinHelper(H);
  // Windows 上 wrapWin 会顺手建临时目录：那就给它这套测试自己的家，别在真机上建 C:\Users\u
  const wh = WIN ? path.join(OWN, "u") : home;
  let w = SB.wrapWin("C:\\Windows\\system32\\cmd.exe", ["/d", "/s", "/c", '"echo a b"'], { verbatim: true, home: wh });
  ok(w.bin === H && same(w.args.slice(0, 2), ["run", "--"]) && w.args.length === 3, "起的是小助手：run -- 后面整条命令一个参数", w.args);
  ok(w.args[2] === 'C:\\Windows\\system32\\cmd.exe /d /s /c "echo a b"', "verbatim：cmd 那几段原样接上，不再加引号", w.args[2]);
  ok(w.opts.windowsVerbatimArguments === true, "整行不让 Node 再加引号");
  ok(w.opts.argv0 === '"' + H + '"', "小助手自己的路径带空格：argv0 先加好引号（Node 原样抄 argv0）", w.opts.argv0);
  ok(same(w.env, SB.lowEnv(wh)), "临时目录和缓存指到 LocalLow");
  w = SB.wrapWin("C:\\Program Files\\nodejs\\node.exe", ["C:\\a b\\x.cjs", 'say "hi"', ""], { home: wh });
  ok(same(parseWinArgs(w.args[2]), ["C:\\Program Files\\nodejs\\node.exe", "C:\\a b\\x.cjs", 'say "hi"', ""]), "不是 verbatim：每段按规矩加引号，拆回来原样", w.args[2]);
  ok(SB.wrapWin("C:\\x.exe", [], { home: wh }).args[2] === "C:\\x.exe", "没参数：末尾不拖空格");
  SB._setWinHelper(null);

  const P = (ws, o = {}) => SB.winWorkspaceProblem(ws, {
    data: "C:\\Users\\u\\OpenWorkBuddy", app: "C:\\Program Files\\OpenWorkBuddy\\resources\\app", home,
    env: { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramData: "C:\\ProgramData", ProgramW6432: "relative\\ignored" }, ...o,
  });
  ok(P("C:\\Users\\u\\OpenWorkBuddy\\workspace") === "", "默认工作区（数据根底下）能标");
  ok(P("D:\\work\\proj") === "" && P("C:\\Users\\u\\Documents\\proj") === "", "别的盘、文档目录底下的项目能标");
  ok(/整个盘/.test(P("C:\\")) && /整个盘/.test(P("D:\\")), "整个盘：不标", P("D:\\"));
  ok(/用户主目录/.test(P("C:\\Users")) && /用户主目录/.test(P("C:\\Users\\u")) && /用户主目录/.test(P("c:\\users\\U\\")), "主目录本身、它的上级（不分大小写、带不带尾斜杠）：不标", P("c:\\users\\U\\"));
  ok(/数据目录/.test(P("D:\\all", { data: "D:\\all\\owb" })), "工作区把数据根包进去了：不标");
  ok(/应用目录/.test(P("D:\\apps", { app: "D:\\apps\\owb\\resources\\app" })), "工作区把应用目录包进去了：不标");
  ok(/系统目录/.test(P("C:\\Windows\\Temp\\x")) && /系统目录/.test(P("C:\\Program Files (x86)\\foo")) && /系统目录/.test(P("c:\\programdata\\x")), "系统和程序目录底下：不标", P("c:\\programdata\\x"));
  ok(P("C:\\Program Filesx\\a") === "", "只是名字开头一样的目录不算在底下");
  ok(P("C:\\relative\\ignored\\x") === "", "环境变量里的相对路径不当真");

  const la = SB.winLabelArgs("C:\\d", ["C:\\d\\workspace", "D:\\proj"], ["config.json", "config.json.bak", "Secrets", "secrets.json", "data", "workspace", "notes.txt"]);
  ok(same(la.slice(0, 4), ["workspace", "C:\\d\\workspace", "workspace", "D:\\proj"]), "工作区先标", la);
  ok(same(la.slice(-2), ["data-root", "C:\\d"]), "数据根本身最后标", la);
  const secrets = la.filter((_, i) => la[i - 1] === "secret");
  ok(["data", "backups", "config.json", "config.json.bak", "Secrets", "secrets.json"].every((n) => secrets.includes("C:\\d\\" + n)), "data、backups（还没有也标）、config.json*、secrets*：都按机密标", secrets);
  ok(!secrets.some((s) => /notes\.txt|workspace/.test(s)), "别的文件、工作区不按机密标", secrets);

  const deny = (t, b = { sandboxed: true }, p = "win32") => R.sandboxDeniedHint(t, b, p);
  ok(/设置 → 安全 → 系统沙箱/.test(deny("Access is denied.")) && deny("拒绝访问。") && deny("Error: EPERM: operation not permitted"), "Windows 上被拒：补一句现状和开关在哪");
  ok(deny("Access is denied.", { sandboxed: false }) === "" && deny("Access is denied.", null) === "", "没套沙箱：不补（那是别的原因）");
  ok(deny("Access is denied.", { sandboxed: true }, "darwin") === "", "macOS 不补（那边只挡机密，拒绝多半跟沙箱无关）");
  ok(deny("file not found") === "", "不是拒绝：不补");

  const go = src("native/owb-sandbox/main.go");
  const goNum = (n) => Number((go.match(new RegExp(n + "\\s*=\\s*(\\d+)")) || [])[1]);
  ok(goNum("exitHelperFailed") === SB.WIN_EXIT.helperFailed && goNum("exitDenied") === SB.WIN_EXIT.denied && goNum("exitOtherError") === SB.WIN_EXIT.other && goNum("exitNotLow") === SB.WIN_EXIT.notLow, "退出码和 main.go 对得上", SB.WIN_EXIT);
  ok(/sddlSecretDir\s*=\s*"S:\(ML;OICI;NRNW;;;ME\)"/.test(go) && /sddlWorkDir\s*=\s*"S:\(ML;OICI;NW;;;LW\)"/.test(go), "机密标「低级别不许读写」、工作区标「低级别能写」，都往下继承");
  ok(/fs\.ModeSymlink\|fs\.ModeIrregular/.test(go), "打标记不跟符号链接和联接点");
}

async function wiring() {
  section("【2】接线");
  // 假包法：只叠一个环境变量和一个 spawn 选项，看 run_shell / run_node 真叠上了没有
  const calls = [];
  const fake = (opts) => ({
    sandboxed: true,
    wrap: (bin, args, o) => { calls.push({ bin, args, o }); return { bin, args, env: { OWB_BOX_MARK: "boxed-env" }, opts }; },
  });
  let r = await R.runShell(WIN ? "echo %OWB_BOX_MARK%" : "echo $OWB_BOX_MARK", 15000, undefined, null, "", fake({}));
  ok(r.content.includes("boxed-env"), "run_shell：包法给的环境变量叠上了", r.content.slice(0, 300));
  ok(calls[0] && calls[0].o && calls[0].o.verbatim === WIN, "run_shell：cmd 那几段已拼好，告诉包法别再加引号（只在 Windows）", calls[0]);
  r = await R.runNode("console.log(process.env.OWB_BOX_MARK + '|' + process.argv0)", 15000, undefined, null, "", fake({ argv0: "owb-fake-argv0" }));
  ok(r.content.includes("boxed-env|owb-fake-argv0"), "run_node：环境变量和 spawn 选项都叠上了", r.content.slice(0, 300));
  const tools = src("src/agent/tools.js");
  const bg = tools.slice(tools.indexOf("function startBackground("), tools.indexOf("function startBackground(") + 4000);
  ok(/box\.wrap\(sh\.bin, sh\.args, \{ verbatim: !!sh\.opts\.windowsVerbatimArguments \}\)/.test(bg) && /\.\.\.w\.env/.test(bg) && /\.\.\.w\.opts/.test(bg), "后台命令同样叠上");
  ok(/sandbox\.preflightWin\(/.test(tools) && /sandbox\.wrapWin\(/.test(tools), "Windows 上走 preflightWin / wrapWin");
  const st = T.sandboxStatus();
  ok(st && st.platform === process.platform, "设置接口带上是哪个系统（界面按它决定画不画开关）", st);
  if (!WIN && process.platform !== "darwin") {
    await R.sandboxFor({ sandbox: "auto" });
    ok(/macOS 和 Windows/.test(T.sandboxStatus().reason || ""), "别的系统：照实说只有 macOS 和 Windows 上有", T.sandboxStatus());
  }

  const ui = src("public/js/app-06.js");
  const fnSrc = (ui.match(/function sandboxHostOs\([\s\S]*?\n}\n/) || [""])[0];
  const ctx = { UI_OS: "mac" };
  vm.runInNewContext(fnSrc + ";this.f = sandboxHostOs;", ctx);
  const f = ctx.f;
  ok(typeof f === "function", "界面里切得出 sandboxHostOs");
  if (typeof f === "function") {
    ok(f({ platform: "win32" }) === "win" && f({ platform: "darwin" }) === "mac" && f({ platform: "linux" }) === "", "按服务端报的系统画：Windows、Mac 画开关，Linux 不画");
    ok(f(null, "win") === "win" && f(undefined, "mac") === "mac" && f(null, "linux") === "", "老服务端没报系统：按界面自己认的");
  }
  ok(/\$\{sbxOs \? `/.test(ui) && /sbxOs === "win"/.test(ui), "开关卡片按系统画，Windows 有自己的说明");
  ok(/\.\.\.\(pane\.querySelector\("#sec-sbx-strict"\) \?/.test(ui), "Windows 没有「严格隔离」那个勾：保存时不乱塞");
  const winDesc = "命令和 run_node 降到低权限跑：读不到 Key 和账本，只能写工作区和临时目录。";
  ok(ui.includes(winDesc) && winDesc.length <= 70, "Windows 那句说明在、不超长");
  const winLimit = "挡不住连本机端口；多人共用时，各组织的工作区彼此读得到。";
  ok(ui.includes(winLimit), "Windows 做不到的两件事也写在开关旁边");
  const i18nSrc = src("public/js/i18n.js");
  ok([winDesc, winLimit].every((t) => i18nSrc.includes('"' + t + '": "')), "英文有译文");
  // 没设过的档位：只有多人用的 Mac 升到「必须」，Windows 照自动走——下拉框里那句得跟代码说的是一回事
  ok(/effectiveMode\(sec\.sandbox, security\.isMultiUser\(\) && process\.platform === "darwin"\)/.test(src("src/agent/tools.js"))
    && ui.includes('sbxOs === "win" ? "默认：同自动" : "默认：多人用时必须，一个人用自动"') && i18nSrc.includes('"默认：同自动": "'),
    "Windows 上「默认」那项写的是同自动，不写多人用时必须");

  // 打包：缺小助手当场红，另一个架构那份删掉，只给 Windows 包带
  const ebcSrc = src("electron-builder.config.js");
  const assertSrc = (ebcSrc.match(/function assertSandboxHelper\([\s\S]*?\n}\n/) || [""])[0];
  const assertSandboxHelper = new Function("fs", "path", "console", assertSrc + "; return assertSandboxHelper;")(fs, path, { log() {} });
  const appDir = path.join(OWN, "packed-app");
  const bin = path.join(appDir, "native", "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const a of ["x64", "arm64"]) fs.writeFileSync(path.join(bin, `owb-sandbox-${a}.exe`), "x");
  let threw = null;
  try { assertSandboxHelper({ electronPlatformName: "win32", arch: 1 }, appDir); } catch (e) { threw = e; }
  ok(!threw && fs.existsSync(path.join(bin, "owb-sandbox-x64.exe")) && !fs.existsSync(path.join(bin, "owb-sandbox-arm64.exe")), "x64 包：留 x64 那份，arm64 那份删掉", threw && threw.message);
  threw = null;
  try { assertSandboxHelper({ electronPlatformName: "win32", arch: 3 }, appDir); } catch (e) { threw = e; }
  ok(threw && /build:sandbox/.test(threw.message), "arm64 包缺 arm64 那份：当场红，告诉怎么补", threw && threw.message);
  threw = null;
  try { assertSandboxHelper({ electronPlatformName: "darwin", arch: 3 }, path.join(OWN, "nope")); } catch (e) { threw = e; }
  ok(!threw, "Mac 包不管这件事");
  ok(/assertSandboxHelper\(ctx, appDir\);\s*\n\s*await adhocSign\(ctx\)/.test(ebcSrc), "afterPack 里在签名之前核");
  const cfg = require("../electron-builder.config.js");
  ok(cfg.win && Array.isArray(cfg.win.files) && cfg.win.files.includes("native/bin/*.exe"), "Windows 包带 native/bin 下的 exe");
  ok(!cfg.files.some((p) => /native/.test(p)), "Mac 包不带");
  const { ARCHES } = require("../scripts/build-sandbox");
  ok(same(Object.values(ARCHES).sort(), ["arm64", "x64"]), "编的架构和打包认的架构对得上", ARCHES);
  ok(/"build:sandbox":\s*"node scripts\/build-sandbox\.js"/.test(src("package.json")), "npm run build:sandbox 在");
  ok(/^native\/bin\/$/m.test(src(".gitignore")), "编出来的 exe 不进 git");

  const rel = src(".github/workflows/release.yml").replace(/^[ \t]*#.*$/gm, "");
  const iGo = rel.indexOf("actions/setup-go@"), iBuild = rel.indexOf("npm run build:sandbox"), iDist = rel.indexOf("npm run ${{ matrix.script }}");
  ok(iGo > 0 && iBuild > iGo && iDist > iBuild, "发版：先装 Go、编小助手，再打包");
  ok(/if: runner\.os == 'Windows'\s*\n\s*uses: actions\/setup-go@v\d+/.test(rel) && /if: runner\.os == 'Windows'\s*\n\s*run: npm run build:sandbox/.test(rel), "只在 Windows 那条腿编");
  const tst = src(".github/workflows/test.yml").replace(/^[ \t]*#.*$/gm, "");
  ok(/os: windows-latest[\s\S]*?cmd: node test\/sandbox-win\.js/.test(tst) && /sandbox_win: "1"/.test(tst) && /OWB_REQUIRE_SANDBOX_WIN: \$\{\{ matrix\.sandbox_win \}\}/.test(tst), "CI 有一条 Windows 腿真跑这套，跳过算红");
  ok(/run: npm run build:sandbox/.test(tst), "CI 的 Windows 腿也现编小助手");
  ok(/scripts\/win-smoke\.js/.test(rel) && /owb-sandbox-\$\{process\.arch\}\.exe/.test(src("scripts/win-smoke.js")), "装机冒烟核小助手装进去了");
}

// ==== 下面只在 Windows ====

/** 起一个进程收输出；超时只杀它自己（整棵树收不收是被测的东西） */
function spawnP(bin, args, opts = {}, timeout = 30000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let c;
    try { c = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...opts }); }
    catch (e) { resolve({ code: null, out: "", err: String(e.message), ms: 0 }); return; }
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { try { c.kill(); } catch {} }, timeout);
    c.on("close", (code) => { clearTimeout(t); resolve({ code, out, err, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); });
    c.on("error", (e) => { clearTimeout(t); resolve({ code: null, out, err: String(e.message), ms: 0 }); });
  });
}
/** 降了级跑 */
function boxed(bin, args, { verbatim = false, cwd, extra = {} } = {}) {
  const w = SB.wrapWin(bin, args, { verbatim });
  return spawnP(w.bin, w.args, { cwd, env: { ...process.env, ...w.env }, ...extra, ...w.opts });
}
/** 降了级用 cmd 跑一行（跟 run_shell 一个拼法） */
function cmdBoxed(line, cwd) {
  const sh = R.pickShell(line, "win32");
  return boxed(sh.bin, sh.args, { verbatim: true, cwd, extra: sh.opts });
}
function cmdBare(line, cwd) {
  const sh = R.pickShell(line, "win32");
  return spawnP(sh.bin, sh.args, { cwd, ...sh.opts });
}
const DENIED = /Access is denied|拒绝访问|EPERM|EACCES/i;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function walkText(dir) {
  let s = "";
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return s; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") s += walkText(p); }
    else if (e.isFile()) { try { s += fs.readFileSync(p, "utf8"); } catch {} }
  }
  return s;
}

async function realLow() {
  section("【3】真降权");
  const helper = SB.winHelper();
  const DATA = path.join(OWN, "数据 根");
  const APP = path.join(OWN, "app 目录");
  const WS = path.join(DATA, "workspace");
  for (const d of [path.join(DATA, "data"), path.join(DATA, "backups", "old"), WS, APP]) fs.mkdirSync(d, { recursive: true });
  const secretFiles = ["config.json", "secrets.json", path.join("data", "orgs.json"), path.join("backups", "old", "b1.json")];
  for (const f of secretFiles) fs.writeFileSync(path.join(DATA, f), SECRET);
  fs.writeFileSync(path.join(APP, "server.js"), "// app\n");
  fs.writeFileSync(path.join(WS, "有 空格.txt"), "workspace-file-content");
  const O = { data: DATA, app: APP, writable: [WS] };

  let t0 = Date.now();
  const pf = await SB.preflightWin(O);
  const firstMs = Date.now() - t0;
  ok(pf.ok === true, `预检通过（打标记 + 7 个探针，第一次 ${firstMs} ms）`, pf);
  if (!pf.ok) return false;
  ok(fs.existsSync(path.join(DATA, "data", "sandbox-canary")), "金丝雀文件建在 data/ 里");
  ok(SB.preflightWin(O) === SB.preflightWin(O), "同样的参数只预检一次（缓存）");
  SB.resetPreflight();
  t0 = Date.now();
  const pf2 = await SB.preflightWin(O);
  ok(pf2.ok, `再预检一次（工作区标过了不再走一遍）：${Date.now() - t0} ms`, pf2);

  let r = await boxed(helper, ["il"]);
  ok(r.code === 0 && r.out.includes("S-1-16-4096"), "包进去的命令跑在低完整性级别", r);
  r = await spawnP(helper, ["il"]);
  ok(r.code === SB.WIN_EXIT.notLow, "★对照★ 不包：不是低级别", r);

  for (const f of secretFiles) {
    r = await cmdBoxed(`type "${path.join(DATA, f)}"`, WS);
    ok(r.code !== 0 && !(r.out + r.err).includes(SECRET) && DENIED.test(r.out + r.err), `读 ${f}：拒绝访问`, r);
  }
  r = await cmdBare(`type "${path.join(DATA, "config.json")}"`, WS);
  ok(r.out.includes(SECRET), "★对照★ 不包：读得到（证明上面是沙箱拦的）", r);
  // OWB 自己之后写的账本、先写临时文件再改名换上的 config.json：照样读不到
  fs.writeFileSync(path.join(DATA, "config.json.tmp"), SECRET);
  fs.renameSync(path.join(DATA, "config.json.tmp"), path.join(DATA, "config.json"));
  fs.writeFileSync(path.join(DATA, "data", "new-ledger.json"), SECRET);
  fs.mkdirSync(path.join(DATA, "backups", "later"));
  fs.writeFileSync(path.join(DATA, "backups", "later", "b2.json"), SECRET);
  for (const f of ["config.json", path.join("data", "new-ledger.json"), path.join("backups", "later", "b2.json")]) {
    r = await cmdBoxed(`type "${path.join(DATA, f)}"`, WS);
    ok(r.code !== 0 && !(r.out + r.err).includes(SECRET), `打完标记以后才写的 ${f}：也读不到`, r);
  }
  r = await boxed(process.execPath, ["-e", `require("fs").readFileSync(${JSON.stringify(path.join(DATA, "config.json"))}, "utf8")`]);
  ok(r.code !== 0 && /EPERM|EACCES/.test(r.err), "node 去读：EPERM", r.err.slice(0, 200));

  r = await cmdBoxed(`echo hi> "${path.join(WS, "boxed-out.txt")}"`, WS);
  ok(r.code === 0 && fs.readFileSync(path.join(WS, "boxed-out.txt"), "utf8").trim() === "hi", "工作区写得进", r);
  r = await cmdBoxed(`mkdir "${path.join(WS, "子 目录")}" && echo x> "${path.join(WS, "子 目录", "a.txt")}"`, WS);
  ok(r.code === 0 && fs.existsSync(path.join(WS, "子 目录", "a.txt")), "工作区里新建目录再写：也行（标记往下继承）", r);
  r = await cmdBoxed(`echo more>> "${path.join(WS, "有 空格.txt")}" && type "${path.join(WS, "有 空格.txt")}"`, WS);
  ok(r.code === 0 && /workspace-file-content[\s\S]*more/.test(r.out), "打标记之前就在的文件：读得到也改得了", r);
  r = await cmdBoxed(`echo x> "${path.join(APP, "pwn.txt")}"`, WS);
  ok(r.code !== 0 && !fs.existsSync(path.join(APP, "pwn.txt")), "应用目录写不进", r);
  r = await cmdBoxed(`echo x>> "${path.join(APP, "server.js")}"`, WS);
  ok(r.code !== 0 && fs.readFileSync(path.join(APP, "server.js"), "utf8") === "// app\n", "应用目录里的文件改不了", r);
  r = await cmdBoxed(`echo x> "${path.join(DATA, "new.txt")}"`, WS);
  ok(r.code !== 0 && !fs.existsSync(path.join(DATA, "new.txt")), "数据根写不进", r);
  const homeProbe = path.join(os.homedir(), "owb-sandbox-probe.txt");
  r = await cmdBoxed(`echo x> "${homeProbe}"`, WS);
  ok(r.code !== 0 && !fs.existsSync(homeProbe), "用户主目录写不进（开机自启那类文件放不进去）", r);
  try { fs.rmSync(homeProbe, { force: true }); } catch {}
  r = await cmdBoxed("reg add HKCU\\Software\\OWBSandboxProbe /v x /d 1 /f", WS);
  ok(r.code !== 0, "注册表 HKCU 写不进", r);
  await cmdBare("reg delete HKCU\\Software\\OWBSandboxProbe /f", WS);
  r = await cmdBoxed("echo %TEMP%", WS);
  ok(/AppData\\LocalLow\\OpenWorkBuddy\\tmp/i.test(r.out), "临时目录换到 LocalLow", r.out);
  r = await cmdBoxed('echo x> "%TEMP%\\t.txt" && type "%TEMP%\\t.txt"', WS);
  ok(r.code === 0 && r.out.trim() === "x", "临时目录写得进", r);

  r = await cmdBoxed("exit /b 7", WS);
  ok(r.code === 7, "退出码原样带出来", r.code);
  const odd = ["a b", 'c"d', "e\\", "", "中 文", 'f\\\\"g', "%PATH%", "x&y|z"];
  r = await boxed(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...odd]);
  let got = null;
  try { got = JSON.parse(r.out); } catch {}
  ok(same(got, odd), "带空格、引号、反斜杠、空串、中文、% & | 的参数原样到", { got, err: r.err.slice(0, 200) });

  // 小助手放在带空格和中文的目录里（装机目录就是这样）
  const spaced = path.join(OWN, "小 助手", path.basename(helper));
  fs.mkdirSync(path.dirname(spaced), { recursive: true });
  fs.copyFileSync(helper, spaced);
  SB._setWinHelper(spaced);
  r = await cmdBoxed("echo spaced-ok", WS);
  ok(r.code === 0 && r.out.includes("spaced-ok"), "小助手路径带空格：照样起得来", r);
  SB._setWinHelper(null);

  // 小助手一死（被 TerminateProcess，不是 taskkill /T），降了级的那棵树跟着收
  const pidFile = path.join(WS, "grandchild.pid");
  const w = SB.wrapWin(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`]);
  const hc = spawn(w.bin, w.args, { stdio: "ignore", windowsHide: true, env: { ...process.env, ...w.env }, ...w.opts });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(100);
  const gpid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
  ok(gpid > 0 && alive(gpid), "降了级的命令起来了", gpid);
  hc.kill();
  for (let i = 0; i < 50 && gpid && alive(gpid); i++) await sleep(100);
  ok(gpid > 0 && !alive(gpid), "小助手被杀：它起的命令跟着没了（不留孤儿）");
  if (gpid && alive(gpid)) await cmdBare(`taskkill /PID ${gpid} /T /F`);

  // 打标记的代价：第一次逐个文件过，之后根目录标过了就跳过
  const BIG = path.join(OWN, "大 工作区");
  for (let d = 0; d < 20; d++) {
    fs.mkdirSync(path.join(BIG, "d" + d), { recursive: true });
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(BIG, "d" + d, i + ".txt"), "x");
  }
  fs.symlinkSync(APP, path.join(BIG, "app-link"), "junction");
  const l1 = await spawnP(helper, ["label", "workspace", BIG], {}, 120000);
  const l2 = await spawnP(helper, ["label", "workspace", BIG], {}, 120000);
  ok(l1.code === 0 && l2.code === 0, `2000 个文件的工作区打标记：第一次 ${Math.round(l1.ms)} ms，之后 ${Math.round(l2.ms)} ms`, { l1, l2 });
  ok(l2.ms < l1.ms, "标过的不再走一遍");
  r = await cmdBoxed(`echo x> "${path.join(BIG, "d19", "new.txt")}"`, BIG);
  ok(r.code === 0, "大工作区深处写得进", r);
  r = await cmdBoxed(`echo x> "${path.join(BIG, "app-link", "via-junction.txt")}"`, BIG);
  ok(r.code !== 0 && !fs.existsSync(path.join(APP, "via-junction.txt")), "工作区里指向应用目录的联接点：不跟过去标，写不进", r);

  // 每条命令多花的时间
  const N = 15;
  const bare = [], box = [], nb = [], nx = [];
  for (let i = 0; i < N; i++) {
    bare.push((await cmdBare("exit 0", WS)).ms);
    box.push((await cmdBoxed("exit 0", WS)).ms);
    nb.push((await spawnP(process.execPath, ["-e", "0"])).ms);
    nx.push((await boxed(process.execPath, ["-e", "0"])).ms);
  }
  const fmt = (a, b) => `直接 ${median(a).toFixed(0)} ms，沙箱里 ${median(b).toFixed(0)} ms（多 ${(median(b) - median(a)).toFixed(0)} ms）`;
  console.log(`  [开销] cmd 空命令：${fmt(bare, box)}`);
  console.log(`  [开销] node -e 0：${fmt(nb, nx)}`);
  ok(median(box) - median(bare) < 1000 && median(nx) - median(nb) < 1000, "每条命令多出来的时间在 1 秒内（实测数见上两行）");
  return true;
}

async function realWiring() {
  section("【4】真接线");
  const sec = require(mod("security"));
  const { DATA_DIR } = require(mod("paths"));
  const cfgPath = path.join(DATA_DIR, "config.json");
  fs.writeFileSync(cfgPath, SECRET);
  const base = { ...sec.DEFAULTS, permission_mode: "full", gateway: false };
  const shell = (command, s) => T.executeTool("run_shell", { command }, { security: { ...base, ...s } });
  const node = (code, s) => T.executeTool("run_node", { code }, { security: { ...base, ...s } });

  let r = await shell(`type "${cfgPath}"`, { sandbox: "auto" });
  ok(r.isError && !r.content.includes(SECRET) && /设置 → 安全 → 系统沙箱/.test(r.content), "run_shell 读 config.json：被拒，并告诉开关在哪", r.content.slice(0, 400));
  const st = T.sandboxStatus();
  ok(st.ok === true && st.platform === "win32" && st.mode === "auto", "设置页看到「已生效」", st);
  r = await node(`console.log(require("fs").readFileSync(${JSON.stringify(cfgPath)}, "utf8"))`, { sandbox: "auto" });
  ok(r.isError && !r.content.includes(SECRET), "run_node 读 config.json：被拒", r.content.slice(0, 300));
  r = await shell("echo plain-ok", { sandbox: "auto" });
  ok(!r.isError && r.content.includes("plain-ok"), "正常命令照常跑", r.content.slice(0, 300));
  r = await node("console.log(6*7)", { sandbox: "auto" });
  ok(!r.isError && r.content.includes("42"), "正常脚本照常跑", r.content.slice(0, 300));
  r = await shell("echo hi> tool-out.txt", { sandbox: "auto" });
  ok(!r.isError && fs.existsSync(path.join(T.getWorkspaceDir(), "tool-out.txt")), "在工作区里写文件照常", r.content.slice(0, 300));
  r = await shell(`type "${cfgPath}" > leak.txt & echo done`, { sandbox: "auto" });
  ok(!walkText(T.getWorkspaceDir()).includes(SECRET), "重定向进工作区的文件里也没有机密", r.content.slice(0, 200));
  r = await shell(`type "${cfgPath}"`, {});
  ok(r.isError && !r.content.includes(SECRET), "没设过档位：默认就套（auto）", r.content.slice(0, 300));
  const bgOut = await T.executeTool("run_shell", { command: `type "${cfgPath}" & echo bg-done`, background: true }, { security: { ...base, sandbox: "auto" }, sessionId: "sbxw" });
  const id = (/(bg\d+)/.exec(bgOut.content) || [])[1];
  let seen = "";
  for (let i = 0; i < 100 && !/bg-done/.test(seen); i++) { await sleep(100); seen += (await T.executeTool("shell_output", { id }, { sessionId: "sbxw" })).content; }
  ok(id && /bg-done/.test(seen) && !seen.includes(SECRET), "后台命令读 config.json：也被拒", seen.slice(0, 300));
  r = await shell(`type "${cfgPath}"`, { sandbox: "off" });
  ok(r.content.includes(SECRET), "★对照★ 关掉沙箱：读得到", r.content.slice(0, 200));
  ok(T.sandboxStatus().ok === false && /已关闭/.test(T.sandboxStatus().reason), "关掉时设置页看到「已关闭」", T.sandboxStatus());

  // 走一整趟 run_shell 的开销（含预检缓存、闸门那些），开和关各量几次
  const on = [], off = [];
  for (let i = 0; i < 8; i++) {
    let t = Date.now(); await shell("exit 0", { sandbox: "auto" }); on.push(Date.now() - t);
    t = Date.now(); await shell("exit 0", { sandbox: "off" }); off.push(Date.now() - t);
  }
  console.log(`  [开销] 一整趟 run_shell：关着 ${median(off)} ms，开着 ${median(on)} ms`);

  SB._setWinHelper(path.join(OWN, "no-such-helper.exe"));
  r = await shell("echo still-runs", { sandbox: "auto" });
  ok(!r.isError && r.content.includes("still-runs"), "auto 档：小助手不见了照常跑", r.content.slice(0, 300));
  ok(T.sandboxStatus().ok === false && /找不到/.test(T.sandboxStatus().reason), "……原因记下来，设置页看得到", T.sandboxStatus());
  r = await shell("echo should-not-run", { sandbox: "required" });
  ok(r.isError && !r.content.includes("should-not-run") && /没有执行/.test(r.content), "required 档：立不起来就不跑", r.content.slice(0, 300));
  r = await node("console.log('should-not-run')", { sandbox: "required" });
  ok(r.isError && /没有执行/.test(r.content), "required 档：run_node 也不跑", r.content.slice(0, 300));
  SB._setWinHelper(null);
}

(async () => {
  pure();
  await wiring();
  if (WIN) {
    const helper = SB.winHelper();
    if (!fs.existsSync(helper)) {
      if (process.env.OWB_REQUIRE_SANDBOX_WIN === "1") ok(false, "这条腿要求真跑，可小助手没编出来：" + helper);
      else console.log(`\n（没有 ${helper}，【3】【4】跳过；先跑 npm run build:sandbox）`);
    } else if (await realLow()) await realWiring();
  } else {
    console.log("\n（不是 Windows，【3】【4】跳过）");
  }
  finished = true;
  console.log(`\n${fail ? "有挂的" : "全部通过"}：${pass} 过 / ${fail} 挂`);
})().catch((e) => { fail++; console.error(e); process.exitCode = 1; });
