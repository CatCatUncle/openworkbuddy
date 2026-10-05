// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Windows 上的路径和写盘。
 *
 * 本机多半不是 Windows，CI 也没有 Windows 机器，所以这些行为都做成按 platform 参数走：
 * 测试传 "win32" 验 Windows 那条路，再传 "darwin" 当反向对照——同一个输入在别的系统上必须跟改之前一样。
 *
 *   ① 文件名：冒号（NTFS 备用数据流）、保留名（含 `CON .txt`）、末尾的点和空格（src/util/winname.js）
 *   ② 工作区边界不分大小写、不分正反斜杠：设置里填 d:\work，模型写 D:\Work\a.md 是同一处
 *   ③ 文件黑名单在 Windows 命令行和代码里的写法：%USERPROFILE%、$env:USERPROFILE、反斜杠、大写
 *   ④ 存盘改名被杀毒软件、索引短暂占着（EPERM / EACCES / EBUSY）：等 10→20→40… 毫秒重试，攒满约 1 秒；
 *      最后还不成抛原错误、不留 .tmp；后台版从挂 .bak 到改名之间不让出主线程；等的时候真睡、不空转
 *
 * 不出网、不调模型、不碰用户真实数据：家目录和数据目录都换成临时目录。
 *   node test/win-paths.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { mod } = require("./lib/mod");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owb-winpaths-")));
// 家目录也换成假的：黑名单 `~/.ssh` 会展开到家目录下，测试只该碰临时目录里那份
const HOME = path.join(TMP, "home");
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.OPENWORKBUDDY_HOME = path.join(HOME, "OWB");
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "OWB", "data");

const ROOT = path.join(__dirname, "..");
const { badSegment, badPath, safeSegment } = require(mod("winname"));
const security = require(mod("security"));
const store = require(mod("store"));

let pass = 0, fail = 0;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 600) : "")); }
}
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, { got, want });
const section = (t) => console.log("\n— " + t + " —");

async function main() {
  section("① Windows 不认的文件名");
  {
    for (const s of ["a:b.txt", "报告?.pdf", "x*.log", "a<b", "a|b", "a\"b", "tab\there"]) ok(badSegment(s) !== "", `坏字符：${JSON.stringify(s)}`);
    for (const s of ["CON", "con.txt", "NUL.json", "COM1.log", "lpt9", "AUX.tar.gz", "CON .txt", "nul  .md", "COM¹", "CONIN$"]) {
      ok(/保留名/.test(badSegment(s)), `保留名：${JSON.stringify(s)}`, badSegment(s));
    }
    for (const s of ["CONSOLE.txt", "icon.png", "nullable.js", "COM10", "con_fig.txt", "a.b.c", ".gitignore", "..", "."]) {
      eq(badSegment(s), "", `能用：${JSON.stringify(s)}`);
    }
    ok(/末尾/.test(badSegment("草稿.")) && /末尾/.test(badSegment("notes ")), "末尾的点和空格不能用");

    ok(badPath("C:\\Users\\Me\\a:b.txt", "win32") !== "", "badPath：路径里有冒号的段 → 拦");
    eq(badPath("C:\\Users\\Me\\a:b.txt", "darwin"), "", "反向对照 macOS：照旧放行");
    eq(badPath("C:\\Users\\Me\\ok.txt", "win32"), "", "盘符的冒号不算");
    eq(badPath("\\\\?\\C:\\long\\ok.txt", "win32"), "", "\\\\?\\ 前缀不算");
    eq(badPath("\\\\server\\share\\ok.txt", "win32"), "", "网络路径前缀不算");
    ok(/保留名/.test(badPath("docs/CON .txt", "win32")), "badPath：扩展名前带空格的保留名也拦（`CON .txt`）");
    eq(badPath("docs/CON .txt", "linux"), "", "反向对照 Linux：照旧放行");
    ok(badPath("out/草稿./a.md", "win32") !== "", "中间一段末尾带点也拦");

    eq(safeSegment("Q3:计划?.docx", "win32"), "Q3_计划_.docx", "safeSegment：坏字符换成 _");
    eq(safeSegment("CON.txt", "win32"), "_CON.txt", "safeSegment：保留名前面加 _");
    eq(safeSegment("CON .txt", "win32"), "_CON .txt", "safeSegment：`CON .txt` 也加 _");
    eq(safeSegment("草稿.. ", "win32"), "草稿", "safeSegment：去掉末尾的点和空格");
    eq(safeSegment("NUL", "win32"), "_NUL", "safeSegment：光一个 NUL 也换");
    eq(safeSegment("Q3:计划?.docx", "darwin"), "Q3:计划?.docx", "反向对照 macOS：原样返回");
    eq(safeSegment("CON.txt", "linux"), "CON.txt", "反向对照 Linux：原样返回");
  }

  section("② 工作区边界不分大小写、不分正反斜杠");
  {
    const U = security.underPrefix;
    ok(U("C:\\Users\\Me\\Proj\\a.txt", "c:/users/me/proj", "win32"), "D:\\Work\\a.md 在 d:/work 底下");
    ok(U("C:\\Users\\Me\\Proj", "c:\\users\\me\\proj\\", "win32"), "就是工作区本身，前缀带结尾分隔符也算");
    ok(U("C:\\x\\y", "C:\\", "win32"), "盘根 C:\\ 底下");
    ok(U("C:\\Users\\Me\\\\Proj//a.txt", "C:/Users/Me/Proj", "win32"), "连着几个分隔符也算一个");
    ok(!U("C:\\Users\\Me\\Project2\\a", "C:\\Users\\Me\\Proj", "win32"), "名字开头一样的隔壁目录不算");
    ok(!U("D:\\Users\\Me\\Proj\\a", "C:\\Users\\Me\\Proj", "win32"), "别的盘不算");
    ok(!U("/Users/Me/Proj/a", "/users/me/proj", "darwin"), "反向对照 macOS：大小写不同不算（照旧）");
    ok(U("/Users/Me/Proj/a", "/Users/Me/Proj", "darwin"), "反向对照 macOS：一模一样的照旧算");

    const sec = (over = {}) => ({ ...security.DEFAULTS, ...over });
    const ws = path.join(TMP, "Proj");
    fs.mkdirSync(ws, { recursive: true });
    const lower = path.join(TMP, "proj", "a.txt"); // 模型写的大小写跟设置里的不一样
    const win = security.resolvePathWithPolicy(sec(), lower, ws, null, "win32");
    ok(win.allowed === true, "Windows：大小写不同的工作区路径放行", win);
    const mac = security.resolvePathWithPolicy(sec(), lower, ws, null, "darwin");
    ok(mac.allowed === false && /越界/.test(mac.reason), "反向对照 macOS：照旧按越界拦", mac);
    const back = security.resolvePathWithPolicy(sec(), "sub\\b.txt", ws, null, "win32");
    ok(back.allowed === true && back.path === path.join(ws, "sub", "b.txt"), "反斜杠的相对路径按目录分隔算", back);

    // 黑名单同理：`Secret` 拦得住 `SECRET\key.txt`
    const bl = sec({ file_blacklist: [path.join(ws, "Secret")] });
    const hit = security.resolvePathWithPolicy(bl, "SECRET\\key.txt", ws, null, "win32");
    ok(hit.allowed === false && /黑名单/.test(hit.reason), "Windows：黑名单不分大小写", hit);
    const miss = security.resolvePathWithPolicy(bl, "SECRET/key.txt", ws, null, "darwin");
    ok(miss.allowed === true, "反向对照 macOS：大小写不同照旧不算黑名单", miss);
    const tilde = security.resolvePathWithPolicy(sec({ file_blacklist: ["~\\.SSH"] }), path.join(HOME, ".ssh", "id_rsa"), ws, null, "win32");
    ok(tilde.allowed === false && /黑名单/.test(tilde.reason), "Windows：黑名单写成 ~\\.SSH 也是家目录下的 .ssh", tilde);
  }

  section("③ 文件黑名单在命令行和代码里的写法");
  {
    const needles = security.pathNeedles("~/.ssh", "win32");
    for (const n of ["~/.ssh", "%userprofile%/.ssh", "$env:userprofile/.ssh", "${env:userprofile}/.ssh", "$home/.ssh"]) {
      ok(needles.includes(n), `~/.ssh 的写法里有 ${n}`, needles);
    }
    ok(needles.every((n) => n === n.toLowerCase() && !n.includes("\\")), "都折成小写、正斜杠");
    ok(!security.pathNeedles("~/.ssh", "darwin").some((n) => n.includes("%userprofile%")), "反向对照 macOS：不加 Windows 的家目录变量");

    const sec = (over = {}) => ({ ...security.DEFAULTS, permission_mode: "full", ...over });
    const asks = (v) => v.action === "ask" && /黑名单/.test(v.rule);
    const hits = [
      "type %USERPROFILE%\\.ssh\\id_rsa",
      "powershell -c \"Get-Content $env:USERPROFILE\\.SSH\\id_rsa\"",
      "Get-Content ${env:USERPROFILE}\\.ssh\\id_rsa",
      "type ~\\.ssh\\id_rsa",
      "Get-Content $HOME\\.ssh\\config",
      "type C:\\Users\\Me\\.SSH\\id_rsa",
      `type ${HOME.toUpperCase().replace(/\//g, "\\")}\\.ssh\\id_rsa`,
      "type %USERPROFILE%\\OWB\\CONFIG.JSON",
    ];
    for (const c of hits) {
      ok(asks(security.checkCommand(sec(), c, "win32")), `Windows 全自动也问：${c}`, security.checkCommand(sec(), c, "win32"));
      ok(!asks(security.checkCommand(sec(), c, "darwin")), `反向对照 macOS 不算黑名单：${c}`, security.checkCommand(sec(), c, "darwin"));
    }
    eq(security.checkCommand(sec(), "type C:\\other\\secret.txt", "win32").action, "allow", "不在黑名单里的照跑");
    eq(security.checkCommand(sec(), "type %USERPROFILE%\\Documents\\notes.txt", "win32").action, "allow", "家目录里别的文件照跑");

    const code = 'require("fs").readFileSync("C:\\\\Users\\\\Me\\\\.SSH\\\\id_rsa", "utf8")';
    const vc = security.checkCode(sec(), code, "win32");
    ok(vc.action === "ask" && /黑名单/.test(vc.rule), "代码里双反斜杠、大写的 .SSH 也认得出", vc);
    eq(security.checkCode(sec(), code, "darwin").action, "allow", "反向对照 macOS：照旧");
    const envCode = 'require("fs").readFileSync(process.env.USERPROFILE + "\\\\.ssh\\\\id_rsa")';
    eq(security.checkCode(sec(), envCode, "win32").action, "ask", "家目录用变量拼、后半截写着 \\\\.ssh 的也认得出");
    eq(security.checkCode(sec(), envCode, "darwin").action, "allow", "反向对照 macOS：照旧");
  }

  section("④ 改名被占着：Windows 上等一等再试");
  {
    const dir = path.join(TMP, "store");
    fs.mkdirSync(dir, { recursive: true });
    const busy = (code) => Object.assign(new Error(`${code}: resource busy or locked, rename`), { code });
    const tmpsIn = () => fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    /** 前 n 次改名正本抛 code，之后真改 */
    const flaky = (n, code = "EPERM", match = () => true) => {
      let left = n; const calls = [];
      return { calls, rename: (a, b) => { calls.push(b); if (match(b) && left > 0) { left--; throw busy(code); } fs.renameSync(a, b); } };
    };
    const always = (code = "EPERM") => { const calls = []; return { calls, rename: (a, b) => { calls.push(b); throw busy(code); } }; };

    // 两次 EPERM 后成功
    const f1 = path.join(dir, "flaky.json");
    store.writeTextAtomic(f1, "v1");
    let sleeps = [];
    const r1 = flaky(2);
    store.writeTextAtomic(f1, "v2", { io: { platform: "win32", rename: r1.rename, sleep: (ms) => sleeps.push(ms) } });
    eq(fs.readFileSync(f1, "utf8"), "v2", "两次 EPERM 之后第三次成了，内容是新的");
    eq(sleeps, [10, 20], "中间等了 10、20 毫秒");
    eq(tmpsIn(), [], "不留 .tmp");

    // 一直被占着：攒满 1 秒抛原错误
    const f2 = path.join(dir, "locked.json");
    store.writeTextAtomic(f2, "old");
    sleeps = [];
    const a2 = always("EPERM");
    let err = null;
    try { store.writeTextAtomic(f2, "new", { io: { platform: "win32", rename: a2.rename, sleep: (ms) => sleeps.push(ms) } }); } catch (e) { err = e; }
    eq(err && err.code, "EPERM", "一直被占着：最后把 EPERM 原样抛出来");
    eq(sleeps, [10, 20, 40, 80, 160, 320, 370], "每次翻倍，攒满 1000 毫秒为止");
    eq(sum(sleeps), 1000, "合计正好 1 秒");
    eq(a2.calls.length, 8, "等 7 回、试 8 次");
    eq(tmpsIn(), [], "失败了也不留 .tmp");
    eq(fs.readFileSync(f2, "utf8"), "old", "正本还是上一版");

    // 同一个文件上回卡满了：这回只等 100 毫秒，别每次存盘都卡主线程一整秒
    sleeps = [];
    err = null;
    try { store.writeTextAtomic(f2, "new", { io: { platform: "win32", rename: always("EBUSY").rename, sleep: (ms) => sleeps.push(ms) } }); } catch (e) { err = e; }
    eq(err && err.code, "EBUSY", "第二回照样抛原错误");
    eq(sum(sleeps), 100, "上回卡满的文件，这回只等 100 毫秒");
    store.writeTextAtomic(f2, "ok", { io: { platform: "win32", sleep: (ms) => sleeps.push(ms) } });
    eq(fs.readFileSync(f2, "utf8"), "ok", "不占了就写得进去");
    sleeps = [];
    try { store.writeTextAtomic(f2, "x", { io: { platform: "win32", rename: always("EACCES").rename, sleep: (ms) => sleeps.push(ms) } }); } catch {}
    eq(sum(sleeps), 1000, "成过一次就恢复整份 1 秒的预算");

    // 不是「被占着」的错误不重试
    sleeps = [];
    const x3 = always("EXDEV");
    err = null;
    try { store.writeTextAtomic(path.join(dir, "exdev.json"), "v", { io: { platform: "win32", rename: x3.rename, sleep: (ms) => sleeps.push(ms) } }); } catch (e) { err = e; }
    ok(err && err.code === "EXDEV" && x3.calls.length === 1 && sleeps.length === 0, "EXDEV 不是被占着：试一次就抛", { calls: x3.calls.length, sleeps });

    // 反向对照：别的系统上 EPERM 就是真没权限，照旧一次就抛
    for (const platform of ["darwin", "linux"]) {
      sleeps = [];
      const m = flaky(1);
      err = null;
      try { store.writeTextAtomic(path.join(dir, `posix-${platform}.json`), "v", { io: { platform, rename: m.rename, sleep: (ms) => sleeps.push(ms) } }); } catch (e) { err = e; }
      ok(err && err.code === "EPERM" && m.calls.length === 1 && sleeps.length === 0, `反向对照 ${platform}：不重试，第一次 EPERM 就抛`, { calls: m.calls.length, sleeps });
    }
    eq(tmpsIn(), [], "上面这些都不留 .tmp");

    // 挂 .bak 那一步（trustPrev 走硬链接）：链接、改名被占着也等
    const f4 = path.join(dir, "bak.json");
    store.writeTextAtomic(f4, "第一版");
    sleeps = [];
    let linkLeft = 1;
    const link = (a, b) => { if (linkLeft-- > 0) throw busy("EBUSY"); fs.linkSync(a, b); };
    store.writeTextAtomic(f4, "第二版", { trustPrev: true, io: { platform: "win32", link, sleep: (ms) => sleeps.push(ms) } });
    eq(fs.readFileSync(f4 + ".bak", "utf8"), "第一版", "建链接 EBUSY 一次：等完 .bak 照样是上一版");
    eq(fs.readFileSync(f4, "utf8"), "第二版", "正本是新的");
    eq(sleeps, [10], "只等了一回 10 毫秒");
    sleeps = [];
    const r4 = flaky(1, "EPERM", (b) => b.endsWith(".bak"));
    store.writeTextAtomic(f4, "第三版", { trustPrev: true, io: { platform: "win32", rename: r4.rename, sleep: (ms) => sleeps.push(ms) } });
    eq(fs.readFileSync(f4 + ".bak", "utf8"), "第二版", "改名成 .bak 时被占一次：等完照样挂上");
    eq(fs.readFileSync(f4, "utf8"), "第三版", "正本是新的");
    eq(sleeps, [10], ".bak 那步也只等了一回");
    eq(fs.readdirSync(dir).filter((n) => n.includes(".bak.") && n.endsWith(".tmp")), [], "不留 .bak 的临时名");

    // 后台版
    const f5 = path.join(dir, "async.json");
    await store.writeTextAtomicAsync(f5, "a1");
    sleeps = [];
    const r5 = flaky(2);
    const done = await store.writeTextAtomicAsync(f5, "a2", { io: { platform: "win32", rename: r5.rename, sleep: (ms) => sleeps.push(ms) } });
    ok(done === true && fs.readFileSync(f5, "utf8") === "a2", "后台版：两次 EPERM 后写成了");
    eq(sleeps, [10, 20], "后台版：同样等 10、20 毫秒");
    sleeps = [];
    let committed = false;
    err = null;
    try {
      await store.writeTextAtomicAsync(f5, "a3", { onCommit: () => { committed = true; }, io: { platform: "win32", rename: always().rename, sleep: (ms) => sleeps.push(ms) } });
    } catch (e) { err = e; }
    eq(err && err.code, "EPERM", "后台版一直被占着：把 EPERM 抛给调用方");
    ok(!committed, "没改成名就不报「已写入」（onCommit 没被调）");
    eq(fs.readFileSync(f5, "utf8"), "a2", "后台版：正本还是上一版");
    eq(tmpsIn(), [], "后台版：不留 .tmp");

    // 从挂 .bak 到改名不许让出主线程：在中间排一个微任务，改名那一刻它还不该跑过
    const f6 = path.join(dir, "noyield.json");
    await store.writeTextAtomicAsync(f6, "n1");
    let flipped = false, seenAtRename = null;
    const r6 = flaky(2);
    await store.writeTextAtomicAsync(f6, "n2", {
      trustPrev: () => { queueMicrotask(() => { flipped = true; }); return true; },
      io: {
        platform: "win32",
        rename: (a, b) => { if (b === f6) seenAtRename = flipped; r6.rename(a, b); },
        sleep: () => {},
      },
    });
    eq(seenAtRename, false, "等着重试的时候没让出主线程：中间排的微任务改名后才跑");
    ok(flipped, "（对照：那个微任务后来确实跑了）");
    eq(fs.readFileSync(f6 + ".bak", "utf8"), "n1", "这期间 .bak 挂的是上一版");

    // 真睡：不换 sleep，等够约 1 秒，但 CPU 几乎不花（不是空转）
    const f7 = path.join(dir, "realsleep.json");
    const t0 = Date.now();
    const c0 = process.cpuUsage();
    try { store.writeTextAtomic(f7, "v", { io: { platform: "win32", rename: always().rename } }); } catch {}
    const wall = Date.now() - t0;
    const cpu = process.cpuUsage(c0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    ok(wall >= 900, `真等了约 1 秒（${wall}ms）`);
    ok(cpuMs < 500, `等的时候不烧 CPU（${cpuMs.toFixed(0)}ms CPU / ${wall}ms）`);
  }
}

main().then(
  () => {
    console.log(`\n${fail ? "✗" : "✓"} Windows 路径与写盘：${pass} 过 / ${fail} 挂`);
    process.exit(fail ? 1 : 0);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
