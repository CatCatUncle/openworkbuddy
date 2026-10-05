// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Windows 上的运行环境：PATH 从哪来、提示词怎么说 shell、文件交给谁打开。
 *
 * 三件事都是「用户照着做了，结果还是不行」那一类：
 *  - 照体检给的 `winget install pandoc` 装完，点「重新检测」照样报没装，agent 的 run_shell 也找不到——
 *    进程里的 PATH 定格在启动那一刻，安装器改的是注册表（engines/which 的 refreshWinPath）
 *  - 模型照 Mac 的习惯写 `python3 x.py`、行尾 `\` 续行，在 cmd 里一条都跑不起来（agent.js 的 shellNote）
 *  - 文件名带英文逗号，explorer 把它拆开、打开的是默认文件夹，还一声不吭（server.js 的 openWithSystem）
 *
 * 这台机器多半不是 Windows：平台、环境变量、读注册表、起进程、桌面主进程全换成假的，只验判断逻辑。
 * 每一节都配反向对照——换成 darwin / linux、或者没走修过的那条路，断言就得变红。
 */

// 赶在 require 任何生产模块之前：tools.js / agent.js 一加载就把数据目录定死了
const { mod } = require("./lib/mod");
require("./lib/own-home")("win-env");

const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const srcLib = require("./lib/src");
const which = require(mod("which"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });
const same = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), msg, { got, want });

/** 一次 `reg query <键> /v Path` 的输出，照 reg.exe 的排版 */
const regOut = (key, type, value) => `\r\n${key}\r\n    Path    ${type}    ${value}\r\n\r\n`;
const SYS_KEY = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USR_KEY = "HKEY_CURRENT_USER\\Environment";

(async () => {
  try {
    // ── ① 常见安装位置 ─────────────────────────────────────────────────
    console.log("\n① Windows 上 PATH 之外还该看的地方");
    const ENV = {
      USERPROFILE: "C:\\Users\\小王",
      LOCALAPPDATA: "C:\\Users\\小王\\AppData\\Local",
      APPDATA: "C:\\Users\\小王\\AppData\\Roaming",
      ProgramFiles: "C:\\Program Files",
    };
    const PKGS = "C:\\Users\\小王\\AppData\\Local\\Microsoft\\WinGet\\Packages";
    const POP = "oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe";
    const fakeIo = (tree) => ({ readdirSync: (d) => { if (tree[d]) return tree[d]; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
    const io = fakeIo({
      [PKGS]: ["Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", POP],
      [PKGS + "\\" + POP]: ["poppler-24.08.0", "poppler-25.07.0", "share"],
    });
    const ex = which.extraDirs("win32", ENV, io);
    ok(ex.includes("C:\\Users\\小王\\AppData\\Local\\Microsoft\\WinGet\\Links"), "★winget 免安装包的快捷方式目录 WinGet\\Links★ ffmpeg 就在这", ex);
    ok(ex.includes("C:\\Program Files\\WinGet\\Links"), "--scope machine 装的那个 Links 也看", ex);
    ok(ex.includes("C:\\Users\\小王\\scoop\\shims"), "scoop 的 shims", ex);
    ok(ex.includes("C:\\Program Files\\LibreOffice\\program"), "★LibreOffice 不改 PATH，soffice 只在 program 目录里★", ex);
    ok(ex.includes("C:\\Users\\小王\\AppData\\Local\\Pandoc"), "pandoc 的默认安装位置", ex);
    const p25 = `${PKGS}\\${POP}\\poppler-25.07.0\\Library\\bin`;
    const p24 = `${PKGS}\\${POP}\\poppler-24.08.0\\Library\\bin`;
    ok(ex.includes(p25) && ex.indexOf(p25) < ex.indexOf(p24), "winget 装的 poppler：Library\\bin 列进来，新版本在前", ex);
    ok(!ex.some((d) => /FFmpeg/.test(d)), "反向对照：别的包不当成 poppler", ex);
    ok(!ex.some((d) => /\\share\\Library/.test(d)), "反向对照：poppler 包里不是版本号的子目录不算", ex);
    same(which.popplerBins("D:\\没有这个目录", fakeIo({})), [], "Packages 目录不存在：空的，不报错");
    ok(which.extraDirs("win32", { ...ENV, SCOOP: "D:\\scoop" }, io).includes("D:\\scoop\\shims"), "改过 SCOOP 位置就跟着它");
    const mac = which.extraDirs("darwin", ENV, io);
    ok(!mac.some((d) => /WinGet|LibreOffice|Pandoc|scoop|Library\\bin/.test(d)), "反向对照：Mac 上的补全目录一个 Windows 位置都没有", mac);
    ok(mac.includes("/opt/homebrew/bin"), "反向对照：Mac 上照旧是 homebrew 那些");

    // ── ② 注册表输出怎么读 ─────────────────────────────────────────────
    console.log("\n② 读 reg query 的输出");
    eq(which.parseRegPath(regOut(USR_KEY, "REG_EXPAND_SZ", "%USERPROFILE%\\bin;C:\\x")), "%USERPROFILE%\\bin;C:\\x", "REG_EXPAND_SZ 取出原值");
    eq(which.parseRegPath(regOut(SYS_KEY, "REG_SZ", "C:\\Windows\\system32")), "C:\\Windows\\system32", "REG_SZ 也认");
    eq(which.parseRegPath("\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ\r\n"), "", "值是空的：空串（读成了，只是没东西）");
    eq(which.parseRegPath("\r\nHKEY_CURRENT_USER\\Environment\r\n    PATHEXT    REG_SZ    .COM;.EXE\r\n"), null, "反向对照：PATHEXT 不是 Path");
    eq(which.parseRegPath("错误: 系统找不到指定的注册表项或值。"), null, "反向对照：报错的输出里取不出东西");
    eq(which.expandWinVars("%userprofile%\\bin;%NOPE%\\x", { USERPROFILE: "C:\\Users\\小王" }), "C:\\Users\\小王\\bin;%NOPE%\\x",
      "%VAR% 不分大小写展开；展不开的原样留着");
    same(which.splitWinPath(' C:\\a ;;"C:\\Program Files\\b";%NOPE%\\x;'), ["C:\\a", "C:\\Program Files\\b"], "拆开：去空白、去引号、丢掉展不开的");

    // ── ③ 现读注册表 PATH ──────────────────────────────────────────────
    console.log("\n③ 「重新检测」时现读注册表里的 PATH");
    const REG_ENV = { SystemRoot: "C:\\Windows", LOCALAPPDATA: ENV.LOCALAPPDATA, USERPROFILE: ENV.USERPROFILE, PATH: "C:\\Windows\\system32;C:\\old" };
    const fakeReg = (outs) => {
      const calls = [];
      const fn = async (key) => {
        calls.push(key);
        await new Promise((r) => setTimeout(r, 5)); // 真的 reg.exe 也要几十毫秒：让并发的那次撞上「还在读」
        const o = outs[key.startsWith("HKLM") ? "sys" : "user"];
        if (o instanceof Error) throw o;
        return o;
      };
      fn.calls = calls;
      return fn;
    };
    const GOOD = {
      sys: regOut(SYS_KEY, "REG_EXPAND_SZ", "%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd"),
      user: regOut(USR_KEY, "REG_EXPAND_SZ", "%LOCALAPPDATA%\\Microsoft\\WinGet\\Links;c:\\program files\\git\\cmd\\"),
    };
    which._resetWinPath();
    const before = which.searchDirs("win32", REG_ENV);
    ok(!before.includes("C:\\Program Files\\Git\\cmd"), "反向对照：没读注册表时，启动后才装的 Git 不在搜索路径里", before);
    eq(before[0], "C:\\Windows\\system32", "反向对照：没读之前就是启动时那份打头");

    let logs = [];
    const log = (m) => logs.push(m);
    let reg = fakeReg(GOOD);
    const [r1, r2] = await Promise.all([
      which.refreshWinPath({ platform: "win32", env: REG_ENV, regQuery: reg, log }),
      which.refreshWinPath({ platform: "win32", env: REG_ENV, regQuery: reg, log }),
    ]);
    eq(reg.calls.length, 2, "同时点两次只读一趟（两把键各一次）");
    ok(reg.calls[0].startsWith("HKLM") && reg.calls[1] === "HKCU\\Environment", "系统那把、用户那把都读了", reg.calls);
    same(r1, r2, "两次拿到同一个结果");
    eq(r1.error, "", "都读成了：没有报错");
    same(r1.dirs, ["C:\\Windows\\system32", "C:\\Program Files\\Git\\cmd", "C:\\Users\\小王\\AppData\\Local\\Microsoft\\WinGet\\Links"],
      "★系统在前、用户在后，%VAR% 展开，大小写和结尾斜杠不同的算同一个★");
    eq(logs.length, 0, "读成了不打日志");

    const after = which.searchDirs("win32", REG_ENV);
    same(after.slice(0, 3), r1.dirs, "★搜索路径里注册表那份打头★ 跟重启一下应用拿到的一样");
    ok(after.indexOf("C:\\old") === 3, "启动时那份里注册表没有的跟在后面", after);
    eq(after.filter((d) => /winget\\links$/i.test(d) && /小王/.test(d)).length, 1, "注册表里和常见位置里重复的只留一个");
    eq(which.augmentedPath("win32", REG_ENV), after.join(";"), "给子进程的 PATH 就是这份，用 ; 连");

    // 读成之后 resolveBin 的缓存作废：之前「没找到」的结论不能再用
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-win-env-"));
    try {
      const bin = path.join(tmp, "owb-win-env-probe");
      which.forget();
      eq((await which.resolveBin("owb-win-env-probe", bin)).bin, "", "（准备）还没装：找不到");
      fs.writeFileSync(bin, "#!/bin/sh\n"); fs.chmodSync(bin, 0o755);
      eq((await which.resolveBin("owb-win-env-probe", bin)).bin, "", "反向对照：不刷新的话，缓存里还是「找不到」");
      which._resetWinPath();
      await which.refreshWinPath({ platform: "win32", env: REG_ENV, regQuery: fakeReg(GOOD), log });
      eq((await which.resolveBin("owb-win-env-probe", bin)).bin, bin, "★读完注册表就把缓存清掉★ 刚装好的这回找得到");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

    // 读不成：必须留痕，并且不拿空的把上一次读到的盖掉
    logs = [];
    reg = fakeReg({ sys: new Error("错误: 拒绝访问。"), user: new Error("3 秒没读完") });
    const bad = await which.refreshWinPath({ platform: "win32", env: REG_ENV, regQuery: reg, log });
    ok(/系统 PATH：错误: 拒绝访问。/.test(bad.error) && /用户 PATH：3 秒没读完/.test(bad.error), "★两把都读不成：原话带回来★", bad.error);
    eq(logs.length, 1, "★读不成打了一行日志★ 不许悄悄吞掉");
    ok(/注册表里的 PATH 没读全/.test(logs[0] || "") && /拒绝访问/.test(logs[0] || ""), "日志里写了是哪把、怎么没读成", logs);
    ok(bad.dirs.includes("C:\\Program Files\\Git\\cmd"), "一把都没读成：上一次读到的照用，不清空", bad.dirs);
    ok(which.searchDirs("win32", REG_ENV).includes("C:\\Program Files\\Git\\cmd"), "搜索路径里也还在");

    logs = [];
    which._resetWinPath();
    const half = await which.refreshWinPath({ platform: "win32", env: REG_ENV, regQuery: fakeReg({ sys: new Error("错误: 拒绝访问。"), user: GOOD.user }), log });
    same(half.dirs, ["C:\\Users\\小王\\AppData\\Local\\Microsoft\\WinGet\\Links", "c:\\program files\\git\\cmd\\"], "读成一把：那一把照样算数");
    ok(/^系统 PATH：/.test(half.error) && !/用户/.test(half.error), "只报没读成的那一把", half.error);
    eq(logs.length, 1, "读成一半也留痕");

    const noLine = await which.refreshWinPath({ platform: "win32", env: REG_ENV, regQuery: fakeReg({ sys: "错误: 系统找不到指定的注册表项或值。", user: GOOD.user }), log: () => {} });
    ok(/系统 PATH：输出里没有 Path 这一项/.test(noLine.error), "输出里没有 Path 那一行：照实说", noLine.error);

    reg = fakeReg(GOOD);
    const onMac = await which.refreshWinPath({ platform: "darwin", env: REG_ENV, regQuery: reg, log });
    eq(reg.calls.length, 0, "反向对照：Mac 上一次 reg query 都不跑");
    same(onMac, { dirs: [], error: "" }, "反向对照：Mac 上什么都不做");

    // ── ④ run_shell 的 PATH ────────────────────────────────────────────
    console.log("\n④ run_shell 子进程拿到的 PATH");
    which._resetWinPath();
    await which.refreshWinPath({ platform: "win32", env: REG_ENV, regQuery: fakeReg(GOOD), log: () => {} });
    const tools = require(mod("tools"));
    const winPath = tools.shellPath("win32").split(";");
    // 报错时只打开头一截：在 Mac 上跑，这串里装的是本机的整份 PATH
    ok(winPath[0] === "C:\\Windows\\system32", "★Windows：注册表那份打头★ 刚 winget 装的东西 run_shell 也找得到", winPath[0].slice(0, 60));
    ok(winPath.includes("C:\\Program Files\\Git\\cmd"), "注册表里新加的目录在里面", winPath.slice(0, 3).map((d) => d.slice(0, 60)));
    ok(winPath.some((d) => /\\Microsoft\\WinGet\\Links$/.test(d)), "WinGet\\Links 在里面");
    ok(!winPath.includes("/opt/homebrew/bin"), "反向对照：Windows 上不再拼 homebrew 这种 Mac 路径");
    const macPath = tools.shellPath("darwin");
    ok(!macPath.includes("Git\\cmd") && !/WinGet/.test(macPath), "反向对照：Mac 上的 PATH 里没有注册表那份");
    ok(macPath.split(":").includes("/opt/homebrew/bin"), "反向对照：Mac 上照旧补 homebrew");
    which._resetWinPath();

    // ── ⑤ 提示词里怎么说 shell ─────────────────────────────────────────
    console.log("\n⑤ 提示词里 run_shell 那一句");
    const { shellNote } = require(mod("agent"));
    const w = shellNote("win32");
    ok(/没有 python3/.test(w) && /py -3/.test(w), "★Windows：说清没有 python3，用 python 或 py -3★", w);
    ok(/不认行尾 \\ 续行/.test(w) && /\^/.test(w), "★Windows：cmd 不认 \\ 续行，写成一行或用 ^★", w);
    ok(/del\/copy\/where/.test(w), "原来那几句还在");
    eq(shellNote("darwin"), "zsh/bash", "反向对照：Mac 上还是那句 zsh/bash");
    ok(!/python|\^/.test(shellNote("linux")), "反向对照：Linux 上不提 python、^");
    const AGENT = fs.readFileSync(mod("agent"), "utf8");
    ok(/- run_shell：执行 shell 命令（\$\{shellNote\(\)\}）/.test(AGENT), "提示词里那一行真用的是 shellNote()");

    // ── ⑥ 用系统程序打开 ───────────────────────────────────────────────
    console.log("\n⑥ 用系统程序打开文件（server.js 的 openWithSystem）");
    const SRV = srcLib.src("server");
    const fnSrc = (SRV.match(/async function openWithSystem\([\s\S]*?\n\}/) || [""])[0];
    ok(fnSrc.length > 0, "server.js 里找得到 openWithSystem");
    const openWithSystem = new Function("require", fnSrc + "\nreturn openWithSystem;")(require);
    const FILE = "C:\\资料\\报告,终稿.docx";
    const spy = () => { const calls = []; const fn = (...a) => { calls.push(a); }; fn.calls = calls; return fn; };
    const bridgeOf = (mode, answer) => {
      const calls = [];
      return {
        calls,
        mode: () => mode,
        isRemote: () => mode === "remote",
        call: async (op, args, opts) => { calls.push([op, args, opts]); if (answer instanceof Error) throw answer; return answer; },
      };
    };
    const bErr = (code) => Object.assign(new Error(`假的 ${code}`), { code });

    let ef = spy(), br = bridgeOf("remote", "");
    let r = await openWithSystem(FILE, { platform: "win32", bridge: br, execFile: ef });
    same(r, { ok: true, error: "" }, "桌面版：主进程打开成功");
    eq(br.calls.length && br.calls[0][0], "shell.openPath", "★交给主进程的 shell.openPath★ 不走 explorer 的命令行");
    same(br.calls[0] && br.calls[0][1], { path: FILE }, "路径原样递过去，逗号没被拆");
    eq(ef.calls.length, 0, "反向对照：没再起 explorer");

    ef = spy(); br = bridgeOf("remote", "Failed to open: 没有与之关联的应用");
    r = await openWithSystem(FILE, { platform: "win32", bridge: br, execFile: ef });
    eq(r.ok, false, "★主进程回了报错：如实算失败★");
    ok(/Failed to open: 没有与之关联的应用/.test(r.error), "系统那句话原样带给用户", r);
    eq(ef.calls.length, 0, "失败了也不偷偷换 explorer 再开一次");

    ef = spy(); br = bridgeOf("remote", bErr("NO_OP"));
    r = await openWithSystem(FILE, { platform: "win32", bridge: br, execFile: ef });
    eq(r.ok, true, "主进程是老版本、不认这个操作：退回 explorer");
    same(ef.calls[0] && ef.calls[0].slice(0, 3), ["explorer", [`"${FILE}"`], { windowsVerbatimArguments: true }], "★退回 explorer 时整个路径包引号、原样递★ 逗号不再被当成分隔符");
    for (const code of ["NO_SHELL", "SHELL_GONE"]) {
      ef = spy();
      r = await openWithSystem(FILE, { platform: "win32", bridge: bridgeOf("remote", bErr(code)), execFile: ef });
      ok(r.ok && ef.calls.length === 1, `主进程${code === "NO_SHELL" ? "不在" : "断了"}（${code}）：退回 explorer`, { r, calls: ef.calls });
    }
    ef = spy();
    r = await openWithSystem(FILE, { platform: "win32", bridge: bridgeOf("remote", bErr("SHELL_TIMEOUT")), execFile: ef });
    ok(!r.ok && /SHELL_TIMEOUT/.test(r.error), "主进程超时：报出来", r);
    eq(ef.calls.length, 0, "反向对照：超时不退回 explorer（主进程可能晚点自己打开，再开一次就是两遍）");

    ef = spy();
    r = await openWithSystem(FILE, { platform: "win32", bridge: bridgeOf("none"), execFile: ef });
    eq(r.ok, true, "命令行 / Web 部署：没有主进程，用 explorer");
    eq(ef.calls[0] && ef.calls[0][1][0], `"${FILE}"`, "也是包了引号的");
    ok(ef.calls[0] && ef.calls[0][1][0] !== FILE, "反向对照：不是以前那样把裸路径交给 explorer");

    ef = spy();
    const inprocCalls = [];
    r = await openWithSystem(FILE, { platform: "win32", bridge: bridgeOf("inproc"), execFile: ef,
      electron: { shell: { openPath: async (p) => { inprocCalls.push(p); return "拒绝访问。"; } } } });
    ok(!r.ok && /拒绝访问。/.test(r.error) && inprocCalls[0] === FILE && ef.calls.length === 0, "服务跑在主进程里：直接用 shell.openPath，报错照实回", { r, inprocCalls });

    ef = spy(); br = bridgeOf("remote", "");
    const URL = "http://127.0.0.1:5555/a%2Cb.html?t=abc";
    r = await openWithSystem(URL, { platform: "win32", bridge: br, execFile: ef });
    ok(r.ok && br.calls.length === 0, "网址不走 shell.openPath", br.calls);
    same(ef.calls[0] && ef.calls[0].slice(0, 2), ["explorer", [URL]], "网址照旧交给 explorer");

    for (const [plat, opener] of [["darwin", "open"], ["linux", "xdg-open"]]) {
      ef = spy(); br = bridgeOf("remote", "不该被调");
      r = await openWithSystem("/Users/a/报告,终稿.docx", { platform: plat, bridge: br, execFile: ef });
      ok(r.ok && br.calls.length === 0, `反向对照：${plat} 不碰主进程`, br.calls);
      same(ef.calls[0] && ef.calls[0].slice(0, 2), [opener, ["/Users/a/报告,终稿.docx"]], `反向对照：${plat} 还是 ${opener} + 原样路径，跟以前一模一样`);
    }

    r = await openWithSystem(FILE, { platform: "win32", bridge: bridgeOf("none"), execFile: () => { throw new TypeError("参数不对"); } });
    ok(!r.ok && /参数不对/.test(r.error), "起进程当场就抛：变成一句报错，不变成没人接的 rejection", r);

    // 调用方真把失败说出去了（前端见到 error 就弹出来）
    const route = (re) => (SRV.match(re) || [""])[0];
    for (const [name, re] of [
      ["/api/open-workspace", /app\.post\("\/api\/open-workspace"[\s\S]*?\n\}\);/],
      ["/api/files/open/*", /app\.post\("\/api\/files\/open\/\*"[\s\S]*?\n\}\);/],
      ["/api/files/reveal", /app\.post\("\/api\/files\/reveal"[\s\S]*?\n\}\);/],
    ]) {
      const body = route(re);
      ok(/await openWithSystem\(/.test(body) && /if \(!r\.ok\) return res\.status\(500\)\.json\(\{ error: r\.error \}\)/.test(body),
        `${name} 等打开的结果，失败了把原话回给前端`, body.slice(0, 160));
    }

    // ── ⑦ 「重新检测本机」会去读注册表 ─────────────────────────────────
    console.log("\n⑦ 「重新检测本机」先读注册表再探测");
    const eng = route(/app\.get\("\/api\/engines"[\s\S]*?\n\}\);/);
    const iRefresh = eng.indexOf(`if (req.query.force === "1") await require(${JSON.stringify(mod.spec("server", "which"))}).refreshWinPath();`);
    ok(iRefresh > 0, "force=1 时调 refreshWinPath", eng.slice(0, 200));
    ok(iRefresh > 0 && iRefresh < eng.indexOf("engines.detectAll("), "先读注册表，再 detectAll（顺序反了等于没读）");

    // ── ⑧ WindowsApps 里的应用执行别名 ─────────────────────────────────
    console.log("\n⑧ WindowsApps 里的应用执行别名：stat 报错，但它跑得起来");
    {
      const APPS = "C:\\Users\\小王\\AppData\\Local\\Microsoft\\WindowsApps";
      const PY = "C:\\Users\\小王\\AppData\\Local\\Programs\\Python\\Python312";
      // 照 Windows 上的样子：别名 stat 会抛（重解析点跟不过去），lstat 拿得到；普通文件两个都行
      const ENT = { file: "file", alias: "alias", dir: "dir", broken: "broken" };
      const fakeFs = (tree) => {
        const st = (kind) => ({ isFile: () => kind === ENT.file, isDirectory: () => kind === ENT.dir });
        const miss = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
        return {
          statSync: (p) => {
            const k = tree[p];
            if (!k) miss();
            if (k === ENT.alias || k === ENT.broken) throw Object.assign(new Error("UNKNOWN: unknown error, stat"), { code: "UNKNOWN", errno: -4094 });
            return st(k);
          },
          lstatSync: (p) => (tree[p] ? st(tree[p]) : miss()),
          accessSync: () => {},
        };
      };
      const io = fakeFs({
        [APPS + "\\python.exe"]: ENT.alias,
        [APPS + "\\winget.exe"]: ENT.alias,
        [APPS + "\\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe"]: ENT.dir,
        [PY + "\\python.exe"]: ENT.file,
        ["D:\\tools\\ffmpeg.exe"]: ENT.broken,
      });
      ok(which.runnable(APPS + "\\python.exe", "win32", io), "★win32：WindowsApps 里的 python.exe 别名 stat 报错，lstat 在 → 算跑得起来★");
      ok(which.runnable(APPS + "\\winget.exe", "win32", io), "win32：winget.exe 也是别名，同样认");
      ok(!which.runnable("D:\\tools\\ffmpeg.exe", "win32", io), "★反向对照★ win32：WindowsApps 之外 stat 报错（坏链接之类），lstat 在也不认");
      ok(!which.runnable(APPS + "\\python3.exe", "win32", io), "★反向对照★ win32：WindowsApps 里根本没有的 → 不认");
      ok(!which.runnable(APPS + "\\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe", "win32", io), "★反向对照★ win32：WindowsApps 里的目录 → 不认");
      ok(!which.runnable(APPS + "\\python.exe", "darwin", io), "★反向对照★ 非 Windows：同一个路径 stat 报错就是跑不起来");
      ok(which.runnable(PY + "\\python.exe", "win32", io), "win32：普通的 python.exe 照旧认");
      eq(which.findIn([APPS], "python", "win32", io), APPS + "\\python.exe", "win32：findIn 在 WindowsApps 里找得到别名（按反斜杠拼）");
      // mcp.js 的 resolveWinCommand 拿 findIn 的结果直接起进程、不验真假：WindowsApps 排在前面时，
      // 先撞上商店占位程序，MCP 服务就起不来。别名只当最后一招，后面有真文件就用真文件
      eq(which.findIn([APPS, PY], "python", "win32", io), PY + "\\python.exe", "★win32：WindowsApps 排在前面、后面有真 python → findIn 给真的，不给别名★");
      eq(which.findIn([PY, APPS], "python", "win32", io), PY + "\\python.exe", "反向对照：真 python 排在前面 → 照旧给它");
      eq(which.findIn([APPS, PY], "winget", "win32", io), APPS + "\\winget.exe", "反向对照：winget 只有别名 → 照旧找得到");
      eq(which.findIn([APPS, PY], "python", "darwin", io), "", "反向对照：非 Windows 不认别名，也不受这条影响");
      eq(which.findIn([APPS, PY], "python3", "win32", io), "", "反向对照：两处都没有 python3 → 空");
      eq(which.findIn(["D:\\tools"], "ffmpeg", "win32", io), "", "反向对照：WindowsApps 之外 stat 报错的 → findIn 也找不到");
      // 本机真文件系统上（不传 io）照旧：不存在的路径不算
      ok(!which.runnable(path.join(os.tmpdir(), "WindowsApps", "没有这个.exe"), "win32"), "反向对照：真文件系统上 WindowsApps 下不存在的路径 → 不认");
    }
  } catch (e) {
    ok(false, "这个套件自己崩了：" + ((e && e.stack) || e));
  }

  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})();
