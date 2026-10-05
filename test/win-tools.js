// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 工具层在 Windows 上的那几处：文件名、路径大小写、回执里的分隔符、.sh 自检、python3、退出收进程、PDF 装法。
 *
 * 跑法：node test/win-tools.js
 * 本机是 Mac，Windows 的行为全靠参数化：被测函数都收一个 platform（默认本机），这里传 "win32"。
 * 假的 WindowsApps、System32、Git 目录都建在临时数据家里；不碰真实数据、不调付费模型、不开窗口。
 *
 * 每一条都配反向对照：同一个输入换成 darwin（或者去掉那一处修复的样子）结论必须翻过来。
 */
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("win-tools");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tools = require(mod("tools"));
const MEDIA = require(path.join(ROOT, "src", "tools", "media"));
const TTSB = require(path.join(ROOT, "src", "tools", "tts-batch"));
const { executeTool } = tools;
const I = tools._internals;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (detail === undefined ? "" : "\n      " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\n/g, "\n      "))); }
};
// 没跑完就退出（哪儿抛了没接住）也算红
let finished = false;
process.on("exit", () => { if (!finished) { console.log("✗ 套件没跑完就退出了"); process.exitCode = 1; } });

/** 在假目录里放一个文件（可选可执行），返回绝对路径 */
const put = (p, body = "", mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); if (mode) fs.chmodSync(p, mode); return p; };

(async () => {
  // realpath 过的临时根：Mac 的 /var 是 /private/var 的链接，不先展开，大小写那条会被前缀差异搅掉
  const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owb-win-tools-")));
  const WS = path.join(BASE, "ws");
  fs.mkdirSync(WS, { recursive: true });
  tools.setWorkspaceDir(WS);
  const S = { sessionId: "s_win", actor: "tester", taskLabel: "测试" };
  const W32 = { ...S, platform: "win32" };
  const MAC = { ...S, platform: "darwin" };

  console.log("\n① 模型起的文件名：Windows 上带冒号、保留名的当场拦下，不悄悄改名");
  {
    const r = await executeTool("write_file", { path: "纪要_10:30.md", content: "会议纪要" }, W32);
    ok(r.isError && /Windows 不认的字符/.test(r.content) && /换个名字/.test(r.content), "win32：write_file 纪要_10:30.md 报错，说清楚哪里不行、让它换名字", r.content);
    ok(!fs.existsSync(path.join(WS, "纪要_10")) && !fs.existsSync(path.join(WS, "纪要_10:30.md")), "win32：拦下来以后盘上什么都没写（没有那个 0 字节的「纪要_10」）");
    const m = await executeTool("write_file", { path: "纪要_10:30.md", content: "会议纪要" }, MAC);
    ok(!m.isError && fs.existsSync(path.join(WS, "纪要_10:30.md")), "★反向对照★ darwin：同一个名字照常写进去（Mac 上冒号是合法字符）", m.content);

    const con = await executeTool("write_file", { path: "con.txt", content: "x" }, W32);
    ok(con.isError && /保留名/.test(con.content), "win32：con.txt 是保留名，拦", con.content);
    const deep = await executeTool("write_file", { path: "资料/aux/说明.md", content: "x" }, W32);
    ok(deep.isError && /aux/.test(deep.content), "win32：中间哪一层是保留名（资料/aux/…）也拦", deep.content);
    const dot = await executeTool("write_file", { path: "报告.", content: "x" }, W32);
    ok(dot.isError && /末尾是点或空格/.test(dot.content), "win32：末尾带点的名字拦（系统会悄悄去掉那个点）", dot.content);
    const good = await executeTool("write_file", { path: "报告/周报 第3期.md", content: "x" }, W32);
    ok(!good.isError && fs.existsSync(path.join(WS, "报告", "周报 第3期.md")), "★反向对照★ win32：正常的中文名、带空格的名字照常写", good.content);

    // 改文件也是往盘上写：同样拦
    const e = await executeTool("edit_file", { path: "纪要_10:30.md", old_text: "会议纪要", new_text: "周会纪要" }, W32);
    ok(e.isError && /Windows 不认的字符/.test(e.content), "win32：edit_file 带冒号的名字拦", e.content);
    const me = await executeTool("multi_edit", { path: "纪要_10:30.md", edits: [{ old_text: "会议纪要", new_text: "周会纪要" }] }, W32);
    ok(me.isError && /Windows 不认的字符/.test(me.content), "win32：multi_edit 也拦", me.content);
    await executeTool("read_file", { path: "纪要_10:30.md" }, MAC);
    const em = await executeTool("edit_file", { path: "纪要_10:30.md", old_text: "会议纪要", new_text: "周会纪要" }, MAC);
    ok(!em.isError && fs.readFileSync(path.join(WS, "纪要_10:30.md"), "utf8") === "周会纪要", "★反向对照★ darwin：同一处 edit_file 照常改成", em.content);
    const rd = await executeTool("read_file", { path: "纪要_10:30.md" }, W32);
    ok(!/Windows 不认的字符/.test(String(rd.content)), "读不拦：只管往盘上写的那几样", rd.content);

    // 技能名：小写字母数字那条正则放得过 con、nul
    const sk = await executeTool("save_skill", { name: "nul", content: "# nul\n测试用的技能\n" }, W32);
    ok(sk.isError && /保留名/.test(sk.content) && !fs.existsSync(require(mod("paths")).dataPath("skills", "nul")), "win32：save_skill 叫 nul 拦下，技能文件夹没建", sk.content);
    const skm = await executeTool("save_skill", { name: "nul", content: "# nul\n测试用的技能\n" }, MAC);
    ok(!/保留名/.test(String(skm.content)), "★反向对照★ darwin：同名不提保留名", skm.content);

    // 画布名：存成 canvases/<名字>.json
    const cv = await executeTool("canvas_manage", { operation: "get", canvas_name: "第1集:开场" }, W32);
    ok(cv.isError && /画布名称不合法/.test(cv.content) && /Windows 不认的字符/.test(cv.content), "win32：画布名带冒号拦", cv.content);
    const cvc = await executeTool("canvas_manage", { operation: "get", canvas_name: "CON" }, W32);
    ok(cvc.isError && /保留名/.test(cvc.content), "win32：画布名 CON 拦（不分大小写）", cvc.content);
    const cvm = await executeTool("canvas_manage", { operation: "get", canvas_name: "第1集:开场" }, MAC);
    ok(!cvm.isError, "★反向对照★ darwin：同一个画布名照常读", cvm.content);
    const cvg = await executeTool("canvas_manage", { operation: "get", canvas_name: "第1集 开场" }, W32);
    ok(!cvg.isError, "★反向对照★ win32：正常的画布名照常读", cvg.content);
  }

  console.log("\n② 工具自己起的产物名：Windows 上就地换成能用的（回执报的就是换过的名字）");
  {
    ok(I.safeOutName("nul", ".png", "image", "win32") === "_nul.png", "win32：生图给 filename=nul → _nul.png", I.safeOutName("nul", ".png", "image", "win32"));
    ok(I.safeOutName("nul", ".png", "image", "darwin") === "nul.png", "★反向对照★ darwin：还是 nul.png");
    ok(I.safeOutName("片头\x01", ".mp4", "video", "win32") === "片头_.mp4", "win32：控制字符换成 _");
    ok(I.safeOutName("片头\x01", ".mp4", "video", "darwin") === "片头\x01.mp4", "★反向对照★ darwin：控制字符原样（跟以前一样）");
    ok(I.safeOutName("海报 终版", ".png", "image", "win32") === "海报 终版.png", "win32：正常名字一个字不动");
    ok(/^image_\d+\.png$/.test(I.safeOutName("", ".png", "image", "win32")), "win32：没给名字照旧按时间戳起");
    const tv = TTSB.validate({ segments: ["你好"], filename: "con.wav" }, "win32");
    ok(tv.ok && tv.stem === "_con", "win32：按句配音整轨叫 con.wav → 落盘名 _con", tv);
    const tm = TTSB.validate({ segments: ["你好"], filename: "con.wav" }, "darwin");
    ok(tm.ok && tm.stem === "con", "★反向对照★ darwin：还是 con", tm);
    const td = TTSB.validate({ segments: ["你好"], filename: "...wav" }, "win32");
    ok(td.ok && td.stem === "旁白", "win32：名字整理完是空的，退回默认的「旁白」", td);
  }

  console.log("\n③ 回执里的路径一律用 /（Windows 上 relative 给的是反斜杠）");
  {
    const w = MEDIA.savedAt("C:\\Work\\任务_0930_海报\\图", "封面.png", path.win32, "C:\\Work");
    ok(w === "任务_0930_海报/图/封面.png", "win32 路径：任务_0930_海报/图/封面.png", w);
    const raw = path.win32.relative("C:\\Work", "C:\\Work\\任务_0930_海报\\图") + "/封面.png";
    ok(raw.includes("\\"), "★反向对照★ 不做这一步，拼出来是反斜杠和 / 混着的", raw);
    ok(MEDIA.savedAt("D:\\Out", "封面.png", path.win32, "C:\\Work") === "封面.png", "win32：换了盘（relative 给的是绝对路径）只报文件名");
    ok(MEDIA.savedAt("C:\\Work", "封面.png", path.win32, "C:\\Work") === "封面.png", "win32：就在根上只报文件名");
    const sub = path.join(WS, "任务_A", "图");
    ok(I.savedAt(sub, "图.png") === "任务_A/图/图.png" && I.savedAt(WS, "图.png") === "图.png", "★反向对照★ 本机（posix）照旧", I.savedAt(sub, "图.png"));
  }

  console.log("\n④ 工作区路径：Windows 上不分大小写");
  {
    ok(I.underRoot("D:\\Work\\a.md", "d:\\work", "win32"), "win32：D:\\Work\\a.md 在 d:\\work 里面");
    ok(!I.underRoot("D:\\Work\\a.md", "d:\\work", "darwin"), "★反向对照★ darwin：照字面比，大小写不同就不算");
    ok(!I.underRoot("d:\\work2\\x.md", "d:\\work", "win32"), "win32：d:\\work2 不算 d:\\work 里面（边界还在）");
    ok(I.underRoot("d:\\WORK", "D:\\work", "win32"), "win32：根本身也算");
    ok(I.underRoot("D:\\资料\\a.md", "d:\\", "win32") && !I.underRoot("E:\\a.md", "d:\\", "win32"), "win32：整个盘当工作区（d:\\）时盘里的都算、别的盘不算");
    const t = tools.safePath("子目录/a.md");
    ok(t === path.join(WS, "子目录", "a.md"), "本机 safePath 照常解析", t);
    let threw = "";
    try { tools.safePath("../越界.md"); } catch (e) { threw = e.message; }
    ok(/路径越界/.test(threw), "★反向对照★ 本机 safePath 越界照样拦", threw);
    const src = fs.readFileSync(mod("tools"), "utf8");
    ok(/function safePath\([\s\S]{0,200}underRoot\(p, ws\(\)\)/.test(src) && /function safePathIn\([\s\S]{0,300}underRoot\(p, base\)/.test(src), "safePath / safePathIn 都走 underRoot");

    fs.mkdirSync(path.join(BASE, "CaseDir"), { recursive: true });
    const lower = path.join(BASE, "casedir");
    if (!fs.existsSync(lower)) console.log("  （这台机器的磁盘分大小写，大小写那两条跳过）");
    else {
      ok(I.winCanonCase(lower, "win32") === path.join(BASE, "CaseDir"), "win32：手敲的 casedir 换成盘上真实的 CaseDir", I.winCanonCase(lower, "win32"));
      ok(I.winCanonCase(lower, "darwin") === lower, "★反向对照★ darwin：原样返回");
      const got = tools.setWorkspaceDir(lower, "win32");
      ok(got === path.join(BASE, "CaseDir") && tools.getDefaultWorkspaceDir() === path.join(BASE, "CaseDir"), "win32：setWorkspaceDir 存的是真实大小写", got);
      const mac = tools.setWorkspaceDir(lower);
      ok(mac === lower, "★反向对照★ 本机：setWorkspaceDir 存的就是传进来的", mac);
      tools.setWorkspaceDir(WS);
    }
    const nope = path.join(BASE, "不存在的", "x");
    ok(I.winCanonCase(nope, "win32") === nope, "win32：realpath 失败（目录不在）就原样返回");
  }

  console.log("\n⑤ .sh 自检：Windows 上只认 Git 自带的 bash，环境问题不算语法错");
  {
    const F = path.join(BASE, "fake");
    const sys32 = path.join(F, "Windows", "System32");
    const apps = path.join(F, "Users", "u", "AppData", "Local", "Microsoft", "WindowsApps");
    const gitBin = path.join(F, "Program Files", "Git", "bin");
    const gitCmd = path.join(F, "Program Files", "Git", "cmd");
    put(path.join(sys32, "bash.exe"), "#!/bin/sh\necho 'No such file or directory' >&2\nexit 127\n", 0o755);
    put(path.join(apps, "bash.exe"), "#!/bin/sh\nexit 1\n", 0o755);
    fs.mkdirSync(gitBin, { recursive: true });
    try { fs.symlinkSync("/bin/bash", path.join(gitBin, "bash.exe")); } catch {}
    put(path.join(gitCmd, "git.exe"), "", 0o755);

    ok(I.shCheckBin(".sh", "darwin") === "bash" && I.shCheckBin(".zsh", "darwin") === "zsh", "★反向对照★ darwin：照旧 bash / zsh");
    ok(I.shCheckBin(".sh", "win32", [sys32, apps].join(";")) === "", "win32：PATH 里只有 System32、WindowsApps 的 bash → 不查");
    ok(I.shCheckBin(".sh", "win32", [sys32, gitBin].join(";")) === path.join(gitBin, "bash.exe"), "win32：System32 排在前面也跳过，用 Git\\bin 的");
    ok(I.shCheckBin(".sh", "win32", [sys32, gitCmd].join(";")) === path.join(gitCmd, "..", "bin", "bash.exe"), "win32：PATH 里只有 Git\\cmd（Git 默认装法）→ 顺着 git.exe 找到 Git\\bin\\bash.exe");
    ok(I.shCheckBin(".zsh", "win32", gitBin) === "", "win32：.zsh 没有能查的，不查");

    const broken = put(path.join(WS, "坏.sh"), "if then\n");
    const viaWsl = await I.selfCheck(broken, "坏.sh", false, { platform: "win32", path: [sys32, apps].join(";") });
    ok(!viaWsl.bad && !viaWsl.note, "win32：只有 WSL 的 bash 时不拿它查，不报假的语法错", viaWsl);
    const mac = await I.selfCheck(broken, "坏.sh", false, { platform: "darwin" });
    ok(mac.bad && /Shell 脚本语法没过/.test(mac.note), "★反向对照★ darwin：同一个坏脚本照报语法错", mac);
    const viaGit = await I.selfCheck(broken, "坏.sh", false, { platform: "win32", path: [sys32, gitBin].join(";") });
    ok(viaGit.bad && /Shell 脚本语法没过/.test(viaGit.note), "win32：有 Git 的 bash 时真的语法错照报", viaGit);

    // Git 的 bash 自己没跑起来（打不开路径）：不当成脚本的错
    const noisy = path.join(F, "noisy", "Git", "bin");
    put(path.join(noisy, "bash.exe"), "#!/bin/sh\necho '/bin/bash: /mnt/c/Users/u/a.sh: No such file or directory' >&2\nexit 127\n", 0o755);
    const n = await I.selfCheck(broken, "坏.sh", false, { platform: "win32", path: noisy });
    ok(!n.bad, "win32：stderr 是 No such file、/mnt/ 这种环境问题 → 算跳过", n);
    const loud = path.join(F, "loud", "Git", "bin");
    put(path.join(loud, "bash.exe"), "#!/bin/sh\necho \"a.sh: line 1: syntax error near unexpected token \\`then'\" >&2\nexit 2\n", 0o755);
    const l = await I.selfCheck(broken, "坏.sh", false, { platform: "win32", path: loud });
    ok(l.bad && /syntax error near unexpected token/.test(l.note), "★反向对照★ win32：同一个 Git bash 报的是真语法错就照报（过滤只认环境问题）", l);
    const good = put(path.join(WS, "好.sh"), "echo hi\n");
    const g = await I.selfCheck(good, "好.sh", false, { platform: "win32", path: gitBin });
    ok(!g.bad, "win32：没毛病的脚本用 Git bash 查过，不报", g);
  }

  console.log("\n⑥ python3：Windows 上没有真的 python3 时，垫一个 python3.cmd 转到真 Python");
  {
    const F = path.join(BASE, "py");
    const stubApps = path.join(F, "stub", "WindowsApps");
    put(path.join(stubApps, "python.exe")); put(path.join(stubApps, "python3.exe"));
    const realPy = path.join(F, "Programs", "Python", "Python312");
    put(path.join(realPy, "python.exe"));
    const launcher = path.join(F, "Launcher");
    put(path.join(launcher, "py.exe"));
    const storeApps = path.join(F, "store", "WindowsApps");
    put(path.join(storeApps, "python3.exe")); put(path.join(storeApps, "python.exe"));
    fs.mkdirSync(path.join(storeApps, "PythonSoftwareFoundation.Python.3.12_qbz5n2kfra8p0"), { recursive: true });
    const read = (d) => { try { return fs.readFileSync(path.join(d, "python3.cmd"), "utf8"); } catch { return null; } };
    const VIA_ENV = '@"%OWB_PYTHON3%" %*\r\n';
    const realExe = path.join(realPy, "python.exe");

    const d1 = path.join(F, "shim1");
    const r1 = I.winPython3Shim(d1, [stubApps, realPy].join(";"), "win32");
    ok(r1.dir === d1 && read(d1) === VIA_ENV && r1.env.OWB_PYTHON3 === realExe,
      "win32：占位程序排在前面、后面有真 python → 垫片转给 OWB_PYTHON3，变量里是真的那个的全路径", { r1, body: read(d1) });
    const m1 = path.join(F, "shim1-mac");
    const rm1 = I.winPython3Shim(m1, [stubApps, realPy].join(";"), "darwin");
    ok(rm1.dir === "" && !Object.keys(rm1.env).length && read(m1) === null, "★反向对照★ darwin：同样的 PATH 什么都不生成，也不带变量", rm1);

    const d2 = path.join(F, "shim2");
    const r2 = I.winPython3Shim(d2, [stubApps, launcher].join(";"), "win32");
    ok(r2.dir === d2 && read(d2) === "@py -3 %*\r\n" && !("OWB_PYTHON3" in r2.env), "win32：只有占位程序和 py 启动器 → 转给 py -3，不带变量", { r2, body: read(d2) });

    const d3 = path.join(F, "shim3");
    put(path.join(d3, "python3.cmd"), "@旧的 %*\r\n");
    ok(I.winPython3Shim(d3, [storeApps, launcher].join(";"), "win32").dir === "" && read(d3) === null, "win32：商店里真装了 Python（旁边有 PythonSoftwareFoundation 包目录）→ 不垫，旧垫片删掉");
    const d4 = path.join(F, "shim4");
    ok(I.winPython3Shim(d4, stubApps, "win32").dir === "" && read(d4) === null, "win32：只有占位程序、没东西可转 → 不垫");

    // 中文用户名：cmd 按系统代码页（中文系统 GBK）读 .cmd，路径要是按 UTF-8 写进垫片，读出来就是乱码
    const cnPy = path.join(F, "Users", "张三", "AppData", "Local", "Programs", "Python", "Python312");
    const cnExe = put(path.join(cnPy, "python.exe"));
    const dCn = path.join(F, "shim-cn");
    const rCn = I.winPython3Shim(dCn, [stubApps, cnPy].join(";"), "win32");
    const bytes = (() => { try { return fs.readFileSync(path.join(dCn, "python3.cmd")); } catch { return null; } })();
    ok(rCn.dir === dCn && !!bytes && bytes.length > 0 && bytes.every((b) => b < 0x80), "★win32：真 Python 在中文目录下，垫片每个字节都是 ASCII★", bytes && bytes.toString("utf8"));
    ok(rCn.env.OWB_PYTHON3 === cnExe, "win32：中文全路径原样放进 OWB_PYTHON3（变量按 Unicode 递，不过代码页）", rCn.env);
    ok(Buffer.from(`@"${cnExe}" %*\r\n`).some((b) => b >= 0x80), "★反向对照★ 以前那种把全路径写进垫片的做法，同一个路径写出来有非 ASCII 字节");
    const mCn = path.join(F, "shim-cn-mac");
    const rmCn = I.winPython3Shim(mCn, [stubApps, cnPy].join(";"), "darwin");
    ok(rmCn.dir === "" && !Object.keys(rmCn.env).length && read(mCn) === null, "★反向对照★ darwin：中文路径也什么都不写");
    // 路径里带 %：变量值原样放，不再像写进批处理那样改成 %%
    const pctPy = path.join(F, "100%", "Python");
    const pctExe = put(path.join(pctPy, "python.exe"));
    ok(I.winPython3Shim(path.join(F, "shim-pct"), [stubApps, pctPy].join(";"), "win32").env.OWB_PYTHON3 === pctExe, "win32：路径里有 % 也原样放进变量");

    // 换了 python：同一个垫片目录跟着改，变量跟着换，内容该改的改
    const dSw = path.join(F, "shim-switch");
    const sA = I.winPython3Shim(dSw, [stubApps, realPy].join(";"), "win32");
    const sB = I.winPython3Shim(dSw, [stubApps, cnPy].join(";"), "win32");
    ok(sA.env.OWB_PYTHON3 === realExe && sB.env.OWB_PYTHON3 === cnExe && read(dSw) === VIA_ENV, "win32：PATH 上换了一个 python → 变量换成新的，垫片内容不用动", { sA, sB });
    const sC = I.winPython3Shim(dSw, [stubApps, launcher].join(";"), "win32");
    ok(sC.dir === dSw && read(dSw) === "@py -3 %*\r\n" && !("OWB_PYTHON3" in sC.env), "win32：只剩 py 启动器 → 垫片改写成 py -3", { sC, body: read(dSw) });
    const sA2 = I.winPython3Shim(dSw, [stubApps, realPy].join(";"), "win32");
    ok(read(dSw) === VIA_ENV && sA2.env.OWB_PYTHON3 === realExe, "win32：又有了真 python → 改回转给变量");
    // 同一份 PATH 记住的结论：记下的那个 python 被卸了，要重判，不能接着递一个不存在的路径
    const gonePy = path.join(F, "gone", "Python");
    const goneExe = put(path.join(gonePy, "python.exe"));
    const dGone = path.join(F, "shim-gone");
    const gBase = [stubApps, gonePy, launcher].join(";");
    const g1 = I.winPython3Shim(dGone, gBase, "win32");
    fs.rmSync(goneExe);
    const g2 = I.winPython3Shim(dGone, gBase, "win32");
    ok(g1.env.OWB_PYTHON3 === goneExe && g2.dir === dGone && !("OWB_PYTHON3" in g2.env) && read(dGone) === "@py -3 %*\r\n",
      "win32：同一份 PATH，记下的 python 没了 → 重判，改转 py -3", { g1, g2, body: read(dGone) });
    // 垫片文件被删了（清过数据目录）：同一份 PATH 也要补回来
    fs.rmSync(path.join(dGone, "python3.cmd"));
    ok(I.winPython3Shim(dGone, gBase, "win32").dir === dGone && read(dGone) === "@py -3 %*\r\n", "win32：垫片被删了 → 同一份 PATH 也写回来");
    ok(I.winStoreStub(path.join(stubApps, "python.exe")) && !I.winStoreStub(path.join(storeApps, "python.exe")) && !I.winStoreStub(path.join(realPy, "python.exe")),
      "认占位程序：WindowsApps 里、旁边没有 PythonSoftwareFoundation 的才算");

    // 只生成一次：内容没变就不重写
    const old = new Date("2000-01-01T00:00:00Z");
    fs.utimesSync(path.join(d1, "python3.cmd"), old, old);
    I.winPython3Shim(d1, [stubApps, realPy].join(";") + ";", "win32");
    ok(fs.statSync(path.join(d1, "python3.cmd")).mtime.getTime() === old.getTime(), "win32：换了一份 PATH 但内容一样 → 文件不重写");

    // 接进 depsGuardEnv：工作区在应用外面时护栏不改 PATH，Windows 上照样垫 python3
    const outside = path.join(BASE, "outside-ws");
    tools.setWorkspaceDir(outside);
    const base = [stubApps, realPy].join(";");
    const ew = I.depsGuardEnv(path.join(outside, "任务_py"), "python3 a.py", base, "win32");
    const shimDir = require(mod("paths")).dataPath("data", "pm-guard");
    ok(shimDir.startsWith(HOME), "垫片目录在套件自己的临时数据家里", shimDir);
    ok(ew.PATH === shimDir + ";" + base && read(shimDir) !== null, "win32：depsGuardEnv 把垫片目录垫在 PATH 最前面，原来的接在后面", ew);
    ok(ew.OWB_PYTHON3 === realExe, "★win32：垫片目录垫上 PATH 的同时带上 OWB_PYTHON3★ 不然垫片转给的是空的", ew);
    const ewCn = I.depsGuardEnv(path.join(outside, "任务_py"), "python3 a.py", [stubApps, cnPy].join(";"), "win32");
    const shimBytes = fs.readFileSync(path.join(shimDir, "python3.cmd"));
    ok(ewCn.OWB_PYTHON3 === cnExe && shimBytes.every((b) => b < 0x80), "win32：中文路径走 depsGuardEnv 也一样：变量里是中文全路径，垫片纯 ASCII", ewCn);
    const em = I.depsGuardEnv(path.join(outside, "任务_py"), "python3 a.py", base, "darwin");
    ok(!Object.keys(em).length, "★反向对照★ darwin：还是空的，跟以前一样（没有 OWB_PYTHON3）", em);
    tools.setWorkspaceDir(WS);
    const src = fs.readFileSync(mod("tools"), "utf8");
    ok(/function runShell\([\s\S]*?\.\.\.depsGuardEnv\(cwd, command, shellPath\(\)\)/.test(src), "run_shell 那处调用的写法没变（deps-guard 套件按字面认它）");
    // 垫片目录只从 depsGuardEnv 这一处垫上 PATH，变量也在这一处带；run_shell / 后台命令 / run_node 都并进它的结果
    ok((src.match(/\bwinPython3Shim\(/g) || []).length === 2, "winPython3Shim 只有定义和 depsGuardEnv 里那一处调用", (src.match(/\bwinPython3Shim\(/g) || []).length);
    ok(/if \(py\.dir\) env = \{ \.\.\.env, \.\.\.py\.env, PATH: py\.dir \+ ";" \+ base \}/.test(src), "depsGuardEnv 垫 PATH 的那一句同时并进了垫片给的变量");
    for (const [what, re] of [
      ["run_shell", /function runShell\([\s\S]*?env: \{[^}]*\.\.\.depsGuardEnv\(cwd, command,/],
      ["后台命令", /function startBackground\([\s\S]*?env: \{[^}]*\.\.\.depsGuardEnv\(cwd, cmd,/],
      ["run_node", /function runNode\([\s\S]*?env: \{[^}]*\.\.\.depsGuardEnv\(cwd, code,/],
    ]) ok(re.test(src), `${what} 的子进程环境并进了 depsGuardEnv（OWB_PYTHON3 跟着 PATH 一起到）`);
  }

  console.log("\n⑦ 没有能用的 Python：Windows 上翻成 py -3 / winget 的装法");
  {
    const has = (s) => /py -3/.test(s) && /winget install Python\.Python\.3\.12/.test(s);
    const nr = "'python3' is not recognized as an internal or external command,\r\noperable program or batch file.";
    ok(has(I.missingBinHint(nr, "win32")), "win32：'python3' is not recognized → 给 py -3 和 winget 装法", I.missingBinHint(nr, "win32"));
    ok(I.missingBinHint(nr, "darwin") === "", "★反向对照★ darwin：同一句不给 Python 提示");
    const cn = "'python' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。";
    ok(has(I.missingBinHint(cn, "win32")), "win32：中文系统那句也认");
    const stub = "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.";
    ok(has(I.missingBinHint(stub, "win32")), "win32：商店占位程序那句 Python was not found 也认");
    ok(I.missingBinHint(stub, "darwin") === "", "★反向对照★ darwin：不认");
    ok(has(I.missingBinHint("", "win32", { code: 9009, command: "python3 build.py" })), "win32：输出是空的、退出码 9009、命令里有 python → 也认");
    ok(I.missingBinHint("", "win32", { code: 9009, command: "foo --bar" }) === "", "★反向对照★ win32：9009 但命令里没 python → 不乱说");
    ok(I.missingBinHint("", "win32", { code: 1, command: "python3 build.py" }) === "", "★反向对照★ win32：python 脚本自己退 1 → 不乱说");
    const twice = I.missingBinHint(stub + "\n" + nr, "win32");
    ok(twice.split(I.WIN_PYTHON_HINT).length === 2, "win32：两处都撞上也只说一遍", twice);
    const ff = I.missingBinHint("'ffmpeg' is not recognized as an internal or external command,", "win32");
    ok(/ffmpeg/.test(ff) && !/Python/.test(ff), "win32：ffmpeg 那句照旧走 ffmpeg 的提示，不串成 Python", ff);

    // 9009 只说明「有个程序找不到」，命令里带 .py 不等于缺的是 Python：只认某一段打头的程序名是 py / python / python3
    const h = (text, command) => I.missingBinHint(text, "win32", { code: 9009, command });
    ok(h("", "node build.py.js") === "", "★win32：node build.py.js 撞 9009 → 不说 Python★（.py 只是文件名里的一截）", h("", "node build.py.js"));
    ok(!/Python/.test(h("'node' is not recognized as an internal or external command,", "node build.py.js")), "win32：输出点了名是 node → 不说 Python");
    ok(!/Python/.test(h("'git' is not recognized as an internal or external command,", "git log -- a.py")), "★win32：git log -- a.py 撞 9009、点名是 git → 不说 Python★");
    ok(h("", "git log -- a.py") === "", "win32：git log -- a.py 撞 9009、输出空 → 也不说 Python");
    ok(has(h("", "python3 x.py")), "win32：python3 x.py 撞 9009、输出空 → 说 Python");
    ok(has(h("", "cd 资料 && py -3 x.py")), "win32：后面一段是 py -3 → 说 Python");
    ok(has(h("", '"C:\\Python312\\python.exe" x.py')), "win32：带引号的全路径 python.exe → 说 Python");
    ok(has(h("", "@python x.py")) && has(h("", "(python x.py)")), "win32：@python、括号里的 python → 也认");
    ok(h("", 'echo "a; python3 x.py"') === "", "★反向对照★ win32：python3 只出现在双引号里（echo 的参数）→ 不认");
    ok(h("", "pythonw x.py") === "" && h("", "mypython x.py") === "", "★反向对照★ win32：pythonw / mypython 不是那几个名字 → 不认");
    const mixed = h("'ffmpeg' is not recognized as an internal or external command,", "python3 a.py && ffmpeg -i a.mp4 b.mp3");
    ok(/ffmpeg/.test(mixed) && !/Python/.test(mixed), "win32：python3 a.py && ffmpeg …，点名是 ffmpeg → 只说 ffmpeg", mixed);
    ok(I.missingBinHint("", "darwin", { code: 9009, command: "python3 x.py" }) === "", "★反向对照★ darwin：同样的 9009 + python3 不说");
    ok(I.runsPython("python3 x.py") && I.runsPython("a & PY.EXE -3 x.py") && !I.runsPython("node build.py.js") && !I.runsPython("") && !I.runsPython(undefined),
      "runsPython：只看每段打头的程序名");
    const src = fs.readFileSync(mod("tools"), "utf8");
    ok(!/\\bpy\(\?:thon3\?\)\?\\b/.test(src.slice(src.indexOf("function missingBinHint"), src.indexOf("function runShell"))), "missingBinHint 里不再拿 \\bpy(thon3?)?\\b 去刮整条命令");
    ok(/missingBinHint\(o \+ "\\n" \+ e, process\.platform, \{ code: code2, command \}\)/.test(src), "run_shell 把退出码和命令递给 missingBinHint");
  }

  console.log("\n⑧ 退出时收后台命令：Windows 上同步 taskkill 整棵树");
  {
    const calls = [], kills = [];
    const run = (...a) => { calls.push(a); return { status: 0 }; };
    const kill = (...a) => { kills.push(a); };
    I.reapBgJob({ pid: 4242 }, "win32", run, kill);
    const c = calls[0] || [];
    ok(calls.length === 1 && c[0] === "taskkill" && JSON.stringify(c[1]) === JSON.stringify(["/pid", "4242", "/T", "/F"]), "win32：taskkill /pid 4242 /T /F", calls);
    ok(c[2] && c[2].windowsHide === true && c[2].stdio === "ignore" && c[2].timeout === 3000, "win32：不弹黑窗、不接输出、3 秒封顶", c[2]);
    ok(!kills.length, "win32：不走 process.kill（只杀得到 cmd 那一层）");
    calls.length = 0;
    I.reapBgJob({ pid: 4242 }, "darwin", run, kill);
    ok(!calls.length && kills.length === 1 && kills[0][0] === -4242 && kills[0][1] === "SIGTERM", "★反向对照★ darwin：照旧给整个进程组发 SIGTERM", kills);
    let boom = false;
    try { I.reapBgJob({ pid: 1 }, "win32", () => { throw new Error("x"); }); } catch { boom = true; }
    ok(!boom, "taskkill 自己出错不往外抛（exit 回调里抛了，后面几条就收不到了）");
    const src = fs.readFileSync(mod("tools"), "utf8");
    ok(/function hookBgExit\([\s\S]{0,600}CT\.bgKillAll\(\(c\) => reapBgJob\(c\)\)/.test(src), "hookBgExit 的 exit 回调走的是 reapBgJob");
  }

  console.log("\n⑨ PDF 取文字：Windows 上给 winget 装法");
  {
    const w = I.pdfHowTo("合同.pdf", "win32");
    ok(/winget install oschwartz10612\.Poppler/.test(w) && /where pdftotext/.test(w), "win32：winget install oschwartz10612.Poppler，用 where 查", w);
    ok(!/scoop|choco/.test(w), "win32：不再给 scoop / choco（得先装包管理器本身）");
    // 这个包不往 WinGet\Links 放链接（清单里是 ArchiveBinariesDependOnPath），找不到时让它按文件名去 Packages 下搜
    ok(w.includes('dir /s /b "%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\pdftotext.exe"'), "★win32：where 找不到时给 dir /s /b 到 WinGet\\Packages 下按文件名搜★", w);
    ok(!/WinGet\\Links/.test(w), "★win32：不再说装在 WinGet\\Links 下★（那里没有它）", w);
    const which = require(mod("which"));
    const L = "C:\\Users\\张三\\AppData\\Local";
    const pkg = L + "\\Microsoft\\WinGet\\Packages";
    const io = { readdirSync: (d) => {
      if (d === pkg) return ["oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe"];
      if (d === pkg + "\\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe") return ["poppler-25.07.0"];
      throw new Error("ENOENT");
    } };
    const extra = which.extraDirs("win32", { LOCALAPPDATA: L }, io);
    ok(extra.includes(pkg + "\\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe\\poppler-25.07.0\\Library\\bin"), "win32：run_shell 的 PATH 会现去 Packages 下的 poppler…\\Library\\bin 找", extra);
    const m = I.pdfHowTo("合同.pdf", "darwin");
    ok(/brew install poppler/.test(m) && /which pdftotext/.test(m) && !/winget/.test(m), "★反向对照★ darwin：照旧 brew、which", m);
    ok(/apt install poppler-utils/.test(I.pdfHowTo("a.pdf", "linux")), "★反向对照★ linux：照旧 apt");
  }

  console.log("\n⑩ run_node 的 PATH 跟 run_shell 同一份");
  {
    const src = fs.readFileSync(mod("tools"), "utf8");
    const body = src.slice(src.indexOf("function runNode("), src.indexOf("function runNode(") + 3000);
    ok(/env: \{[^}]*PATH: shellPath\(\)[^}]*\.\.\.depsGuardEnv\(cwd, code, shellPath\(\)\)/.test(body), "run_node：PATH 和 depsGuardEnv 的底子都是 shellPath()，不是 process.env.PATH");
    // 实跑一次：服务进程的 PATH 只剩系统那两个，脚本里看到的得是 run_shell 那份（补上了 /opt/homebrew/bin 这些）
    const saved = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    let r;
    try { r = await I.runNode('console.log("PATH=" + process.env.PATH)', 20000, WS); }
    finally { process.env.PATH = saved; }
    const seen = ((r && r.content || "").match(/PATH=(.*)/) || [])[1] || "";
    ok(seen.split(":").includes("/opt/homebrew/bin") && seen.split(":").includes("/usr/bin"), "★run_node 脚本里的 PATH 带着 shellPath 补的目录★（以前只有启动那一刻的 PATH）", r && r.content);
  }

  finished = true;
  console.log(`\n${fail ? "✗" : "✓"} win-tools：${pass} 通过，${fail} 失败`);
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("✗ 套件异常：" + (e && e.stack || e));
  process.exit(1);
});
