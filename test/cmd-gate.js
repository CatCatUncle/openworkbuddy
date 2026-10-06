// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 命令闸认命令的那一步：「这段到底在跑什么」认错了，后面的名单、删除保护、判险全白搭。
 *
 *   ① 包装词连参数一起剥：`nice -n 5 rm`、`timeout 30 rm`、`stdbuf -o0 rm` 的头是 rm，不是 5 / 30
 *   ② 引号、反斜杠按 shell 的规矩去掉：`\rm`、`'rm'`、`r''m` 都是 rm
 *   ③ 套着的命令挖出来单独算：`bash -c '…'`、`eval '…'`、`find -exec/-execdir …`
 *   ④ 强推的几种写法：-uf、+refspec；设备直写不要求 > 前有空格
 *   ⑤ 「这类都允许」的规则：跳过全局开关（git -C），`node -e` / `python -c` 不给规则，按整词比
 *   ⑥ 判险那道闸跳过人已经批过的段，不花钱问一个答过的问题
 *   ⑦ Windows（platform 传 "win32"）：Remove-Item / DEL / RD /S、.exe 和全路径、cmd /c 和 powershell -c 包着的
 *      都按删除问；-EncodedCommand 一律问；dir / Get-ChildItem 这类只读的照跑。每条配 darwin 反向对照
 *   ⑧ Windows 上绕删除保护的写法：del=x、^" 转义、PowerShell 单引号、start / Start-Process 套一层、
 *      $fso.DeleteFolder、`. Remove-Item`；再加一刀不管引号的兜底（认下的误报也写在里面）
 *   ⑨ 代码闸：拼出来的路径指到黑名单、加载应用自己能改账号额度的模块，全自动也要点头，多人共用直接拦
 *   ⑩ 硬链接：跟黑名单文件同一份数据、换了名字放进工作区的，文件工具也拦
 *
 * 纯函数，不起进程、不出网。
 *   node test/cmd-gate.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { mod } = require("./lib/mod");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cmdgate-home-"));
process.env.OPENWORKBUDDY_HOME = HOME;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");

const ROOT = path.join(__dirname, "..");
const security = require(mod("security"));
const cmdRisk = require(mod("cmd-risk"));

let pass = 0, fail = 0;
process.on("exit", () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} });
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
}
const eq = (a, b, name) => ok(a === b, name, a);
const section = (t) => console.log("\n— " + t + " —");

const sec = (over = {}) => ({ ...security.DEFAULTS, permission_mode: "auto", ...over });
const verdict = (cmd, over) => security.checkCommand(sec(over), cmd);
const asksDelete = (cmd) => {
  const v = verdict(cmd);
  return v.action === "ask" && /删除保护/.test(v.rule);
};

section("① 包装词连参数一起剥");
for (const c of ["nice -n 5 rm -rf build", "timeout 30 rm -rf build", "timeout -s KILL 30 rm x", "stdbuf -o0 rm x",
  "env -u HOME rm x", "env -i FOO=1 rm x", "ionice -c 3 rm x", "xargs -I {} rm {}", "nohup nice -n 3 rm x"]) {
  ok(asksDelete(c), `删除保护认得出：${c}`, verdict(c));
}
eq(verdict("timeout 30 npm test").action, "allow", "反向对照：timeout 包着的普通命令照跑");
eq(verdict("command -v rm").action, "allow", "反向对照：command -v rm 是问装没装，不是删");

section("② 引号、反斜杠去掉再比");
for (const c of ["\\rm -rf x", "'rm' -rf x", "\"rm\" x", "r''m -rf x", "/bin/rm x"]) {
  ok(asksDelete(c), `删除保护认得出：${c}`, verdict(c));
}

section("③ 套着的命令挖出来");
const cases3 = [
  ["bash -c 'rm -rf x'", "rm -rf x"],
  ["sh -euxo pipefail -c \"rm x\"", "rm x"],
  ["zsh -lc 'cd a && rm x'", "rm x"],
  ["eval 'rm -rf x'", "rm -rf x"],
  ["find . -name '*.o' -execdir rm {} \\;", null],
  ["find . -exec sh -c 'rm \"$1\"' _ {} \\;", null],
  ["bash -c \"bash -c 'rm x'\"", "rm x"],
];
for (const [c, seg] of cases3) {
  const v = verdict(c);
  ok(v.action === "ask" && /删除保护/.test(v.rule) && (seg == null || v.seg.trim() === seg), `挖出来了：${c}`, v);
}
eq(security.commandSegments("bash build.sh").length, 1, "反向对照：bash 跑脚本文件不瞎挖");
eq(verdict("bash -c 'npm test'").action, "allow", "反向对照：套着的是普通命令就照跑");
{
  const v = verdict("bash -c 'rm x'", { cmd_allow: ["bash"] });
  ok(v.action === "ask" && v.seg.trim() === "rm x", "外面那层放行了，里面那条照样过删除保护", v);
}

section("④ 强推、设备直写");
const danger = (c) => { const v = verdict(c); return v.action === "ask" && /^danger:/.test(v.ruleKey || "") ? v.ruleKey : ""; };
eq(danger("git push -uf origin main"), "danger:git-force-push", "-uf 并在一起的也是强推");
eq(danger("git push origin +main"), "danger:git-force-push", "+refspec 也是强推");
eq(danger("git push --force-with-lease"), "danger:git-force-push", "--force-with-lease 照旧算");
eq(danger("git push -u origin main"), "", "反向对照：-u 不是强推");
eq(danger("git push --follow-tags origin feature-fix"), "", "反向对照：--follow-tags、分支名里的 f 不算");
eq(danger("cat img>/dev/disk4"), "danger:dev-write", "> 前没空格也认得出设备直写");
eq(danger("make 2>/dev/null"), "", "反向对照：2>/dev/null 不算");

section("⑤ 「这类都允许」的规则");
const rules = [
  ["git -C repo status", "git status"],
  ["git -c core.quotepath=off --no-pager log -3", "git log"],
  ["kubectl -n prod get pods", "kubectl get"],
  ["python3 -m pytest -q", "python3 -m pytest"],
  ["ffmpeg -i a.mp4 b.mp3", "ffmpeg"],
  ["node -e \"require('fs').rmSync('x')\"", ""],
  ["python3 -c 'import os'", ""],
  ["node --test", ""],
  ["node <<EOF", ""],
  [". venv/bin/activate", ""],
  ["command -v rm", ""],
  ["nice -n 5 rm -rf x", "rm"],
  ["git push --force origin main", "git push"],
];
for (const [c, want] of rules) eq(security.ruleFor(c), want, `${c} → ${want ? `「${want}」` : "不给规则"}`);

ok(security.listedCommand({ cmd_allow: ["git"] }, "git status"), "批过 git：git status 算批过");
ok(!security.listedCommand({ cmd_allow: ["git"] }, "gitk --all"), "批过 git 不等于批了 gitk");
ok(!security.listedCommand({ cmd_allow: ["rm"] }, "rmdir x"), "批过 rm 不等于批了 rmdir");
ok(security.listedCommand({ cmd_allow: ["./scripts/"] }, "./scripts/x.sh"), "以 / 结尾的照旧按前缀");
// git -C 的规则跟 git -C 的段匹配不上：宁可多问一次，也不按「推出来的规则」放行——
// `git -c core.fsmonitor='…' status` 推出来也是 git status，按规则比就把任意命令放过去了
ok(!security.listedCommand({ cmd_allow: ["git status"] }, "git -c core.fsmonitor='rm -rf ~' status"), "带 -c 的 git 不按推出来的规则放行");

section("⑥ 判险那道闸跳过批过的段");
const ALLOW = { action: "allow" };
const rsec = (over) => sec({ cmd_risk_gate: true, ...over });
eq(cmdRisk.needsJudge({ verdict: ALLOW, sec: rsec({ cmd_allow: ["npm run build"] }), text: "npm run build && git reset --hard" }), "git reset --hard", "放行名单里那段跳过，判的是后面那段");
eq(cmdRisk.needsJudge({ verdict: ALLOW, sec: rsec({ cmd_allow: ["npm run build"] }), text: "npm run build" }), "", "整条都批过：不花钱判");
security.addSessionAllow("git reset");
eq(cmdRisk.needsJudge({ verdict: ALLOW, sec: rsec(), text: "git reset --hard" }), "", "本会话「这类都允许」过的也跳过");
security.clearSessionAllow();
eq(cmdRisk.needsJudge({ verdict: ALLOW, sec: rsec(), text: "git reset --hard" }), "git reset --hard", "反向对照：没批过照判");
eq(cmdRisk.needsJudge({ verdict: ALLOW, sec: rsec({ cmd_allow: ["gi"] }), text: "git reset --hard" }), "git reset --hard", "反向对照：gi 不是 git 的整词");

section("⑦ Windows：cmd / PowerShell 的删除也认得出");
// run_shell 在 Windows 上走 cmd.exe，PowerShell 只会套在里面出现。本机不是 Windows，靠 platform 参数测；
// 每条都拿 darwin 跑一遍当反向对照：这些写法只在 Windows 上认，别的系统一点不变
const vw = (cmd, over, platform = "win32") => security.checkCommand(sec(over), cmd, platform);
const isDel = (v) => v.action === "ask" && /删除保护/.test(v.rule);
const winDeletes = [
  "Remove-Item -Recurse -Force C:\\proj\\build", "ri build -Recurse", "DEL /Q build\\*.tmp", "RD /S /Q build",
  "rd/s/q build", "del/f x", "ERASE x.tmp", "rm.exe -rf build", "Clear-RecycleBin -Force",
  // 带 .exe / 全路径 / 被 cmd、powershell 包着
  "C:\\Windows\\System32\\cmd.exe /c del x", "cmd /c \"rd /s /q build\"", "cmd /d /s /c \"echo hi & rd /s /q build\"",
  "cmd /c\"del x\"", "%ComSpec% /c del x",
  "powershell -NoProfile -Command \"Remove-Item -Recurse build\"", "pwsh.exe -c \"Get-ChildItem *.tmp | Remove-Item\"",
  "pwsh -c \"gci x | % { ri $_ }\"", "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -c \"Remove-Item x\"",
  "powershell /c \"Remove-Item x\"", "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"Remove-Item x\"",
  "powershell -c \"if (Test-Path x) { Remove-Item x }\"",
  // 转义符、前缀、条件、循环（\u0060 就是 PowerShell 的反引号转义符。源码里落一个孤零零的反引号，
  // repo-hygiene 剥模板串时会错配对，后面整段测试数据都被当成代码去查 require）
  "powershell -c \"R\u0060emove-Item x\"", "r^d /s /q build", "@del x", "if exist build rd /s /q build",
  "if /i \"%a%\"==\"y\" del x", "if %n% GEQ 3 del x", "if not errorlevel 1 del x", "call del x",
  "for %i in (*.tmp) do @del %i", "forfiles /m *.tmp /c \"cmd /c del @path\"",
  "$null = Remove-Item x", "Microsoft.PowerShell.Management\\Remove-Item x",
  "powershell -c \"[IO.File]::Delete('x')\"", "powershell -c [IO.Directory]::Delete('x', $true)",
  "iex \"Remove-Item x\"", "wsl rm -rf /mnt/c/x", "wsl -d Ubuntu -- rm -rf x",
  // cmd 的 & 前面是反斜杠、单引号在 cmd 里不算引号：都得照样切段
  "dir C:\\& rd /s /q x", "echo it's & rd /s /q x",
];
for (const c of winDeletes) {
  ok(isDel(vw(c)), `Windows 删除保护认得出：${c}`, vw(c));
  ok(!isDel(vw(c, {}, "darwin")), `反向对照 macOS 不按删除算：${c}`, vw(c, {}, "darwin"));
}
eq(vw("ri Array", {}, "darwin").action, "allow", "反向对照：ri 在 macOS 上是查 Ruby 文档，照跑");

// -EncodedCommand 后面是 base64，看不见要跑什么：全自动、批过 powershell 都照样问，也不给「同类不再问」
for (const c of ["powershell -enc ZQBjAGgAbwA=", "powershell -e ZQBj", "pwsh -EncodedCommand ZQBj",
  "powershell.exe -NoP -NonI -W Hidden -Enc ZQBj", "PowerShell -EC ZQBj", "cmd /c powershell -ec ZQBj"]) {
  const v = vw(c, { permission_mode: "full" });
  ok(v.action === "ask" && /编码命令/.test(v.rule) && v.ruleKey === "", `编码命令全自动也问、不给同类放行：${c}`, v);
  eq(vw(c, { permission_mode: "full" }, "darwin").action, "allow", `反向对照 macOS：${c} 照旧`);
}
const encAllowed = vw("powershell -enc ZQBj", { permission_mode: "full", cmd_allow: ["powershell"] });
eq(encAllowed.action, "ask", "放行名单里有 powershell，编码命令照样问");
const encNoGw = vw("powershell -enc ZQBj", { gateway: false });
ok(isDel(encNoGw) && encNoGw.ruleKey === "", "总开关关着：编码命令按删除保护问，不给同类放行", encNoGw);
eq(vw("powershell -enc ZQBj", { gateway: false }, "darwin").action, "allow", "反向对照 macOS：总开关关着照旧放行");

// 只读的不能误拦，不然每条 dir 都弹审批
for (const c of ["Get-ChildItem -Recurse C:\\proj", "gci", "dir /s build", "DIR", "dir /b /a-d", "Get-Content x.txt",
  "type x.txt", "powershell -c \"Get-ChildItem build\"", "cmd /c dir build", "powershell -ExecutionPolicy Bypass -File build.ps1",
  "powershell -WindowStyle Hidden -Command Get-Date", "pwsh -NoLogo -c \"Get-Process | Sort-Object CPU\"",
  "Get-Item x | Select-Object Name", "where.exe node", "findstr /s foo *.js", "if exist x echo yes", "echo it's fine", "git status"]) {
  eq(vw(c).action, "allow", `Windows 只读命令照跑：${c}`);
}

// 「这类都允许」的规则：Windows 上不分大小写、去掉 .exe 和全路径
const winRules = [
  ["Remove-Item -Recurse x", "remove-item"],
  ["RD /S /Q x", "rd"],
  ["rd/s/q x", "rd"],
  ["GIT.EXE status", "git status"],
  ["C:\\Python311\\python.exe -m pytest", "python -m pytest"],
];
for (const [c, want] of winRules) eq(security.ruleFor(c, "win32"), want, `Windows：${c} → 「${want}」`);
eq(security.ruleFor("RD /S /Q x", "darwin"), "RD", "反向对照 macOS：大小写照原样");

// 用户关掉的 Python 运行时，Windows 上的 py 启动器和全路径 python.exe 也算
const noPy = { runtime_python: false };
eq(vw("py -3 x.py", noPy).action, "deny", "Windows：关了 Python，py -3 也不跑");
eq(vw("C:\\Python311\\python.exe x.py", noPy).action, "deny", "Windows：关了 Python，全路径 python.exe 也不跑");
eq(vw("py -3 x.py", noPy, "darwin").action, "allow", "反向对照 macOS：py 不是 Python，照旧");

section("⑧ Windows：绕过删除保护的几种写法");
// 每条都是「拆的人和真跑的那个认得不一样」：cmd 的分隔符、^ 转义、PowerShell 的引号、start 套一层……
// 认错一处 rd 就溜过去。darwin 照样拿来当反向对照
const winBypasses = [
  // cmd 里命令名碰到 = , ; 就断了；cmd 也没有 FOO=1 开头的写法，不能当赋值剥掉
  "del=x", "rd=/s=/q=x", "rd=/s /q x", "del,x", "call del=x", "cmd /c rd=/s=/q x",
  // ^ 在引号外转义下一个字：^" 是个字面的引号，不开引号，后面的 & 照样分段
  "echo ^\" & rd /s /q x",
  // PowerShell 的单引号里 " 就是个字，分号照样分段
  "powershell -c echo '\"'; Remove-Item C:\\x", "pwsh -c echo '\"' ; ri x",
  "powershell -c \"Write-Output \\\"$(Remove-Item x)\\\"\"", "powershell -c \"& {Remove-Item x}\"",
  // start / Start-Process 套一层
  "Start-Process cmd -ArgumentList '/c rd /s /q x'", "Start-Process -FilePath powershell -ArgumentList '-c','Remove-Item x -Recurse'",
  "Start-Process -FilePath powershell -ArgumentList \"-c\", \"Remove-Item x\"", "saps cmd '/c rd /s /q x'",
  "powershell -c \"Start-Process cmd -ArgumentList @('/c','rd /s /q x') -Wait\"",
  // 文件系统对象、.NET 的删法
  // cmd 在命令名前面不管的：@ , ; = 和写在前头的重定向
  "@ rd /s /q x", ",rd /s /q x", "=rd /s /q x", ">nul rd /s /q x", "2>nul rd /s /q x", "<nul rd /s /q x", "1>&2 rd /s /q x",
  // 内部命令名碰到 . : \ 也断；cmd 带全路径、%ComSpec%、开关贴着写
  "del.x", "del:x", "rd\\x", "cmd.exe/c rd /s /q x", "C:\\Windows\\System32\\cmd.exe/c rd /s /q x", "%ComSpec%/c rd /s /q x",
  "cmd,/c rd /s /q x", "cmd;/c rd /s /q x", "cmd /q/c rd /s /q x", "cmd /c/q rd x",
  // ^ 续行、^ 夹在开关里；forfiles 的 /c 贴着引号；cmd 剥第一个和最后一个引号
  "r^\nd /s /q x", "cmd /c^ rd /s /q x", "cmd ^/c rd /s /q x", "forfiles /p . /c\"cmd /c del @path\"",
  "cmd /c \"echo a\" \"&\" rd /s /q x",
  "$fso.DeleteFolder(\"C:\\x\")", "$fso.DeleteFile('x')", "[IO.Directory]::Delete('x')",
  "powershell -c \"(New-Object -ComObject Scripting.FileSystemObject).DeleteFolder('C:\\x')\"", "gci *.tmp | % Delete",
  // 点号调用、& 调用
  ". Remove-Item x -Recurse", "& Remove-Item x", "& 'Remove-Item' x", "powershell -c \". Remove-Item x\"",
  // wsl 里跑的是 Linux 命令，FOO=1 开头照旧剥
  "wsl FOO=1 rm -rf x",
];
for (const c of winBypasses) {
  ok(isDel(vw(c)), `Windows 删除保护认得出：${c}`, vw(c));
  ok(!isDel(vw(c, {}, "darwin")), `反向对照 macOS 不按删除算：${c}`, vw(c, {}, "darwin"));
}
// 拆出来就是两段的：commandSegments 里得看得见 rd 那一段，不能只靠兜底
const segsOf = (c) => security.commandSegments(c, "win32").map((s) => s.trim());
ok(segsOf("echo ^\" & rd /s /q x").includes("rd /s /q x"), "^\" 不开引号：rd 那段单独拆出来", segsOf("echo ^\" & rd /s /q x"));
ok(segsOf("powershell -c echo '\"'; Remove-Item C:\\x").some((s) => /^Remove-Item/.test(s)), "PowerShell 按自己的引号拆：Remove-Item 那段单独拆出来", segsOf("powershell -c echo '\"'; Remove-Item C:\\x"));
ok(segsOf("start /b /wait rd /s /q x").includes("rd /s /q x"), "start 的开关跳过：里面的 rd 单独算一段", segsOf("start /b /wait rd /s /q x"));
ok(segsOf("start \"\" cmd /c rd /s /q x").includes("rd /s /q x"), "start 的空标题跳过：cmd /c 里的 rd 单独算一段", segsOf("start \"\" cmd /c rd /s /q x"));

// 放行名单只认 git 时，`rd=x git status` 不能被当成 git status 放过去：cmd 里它是 rd 删三个目录
const gitOk = vw("rd=x git status", { cmd_allow: ["git"] });
ok(isDel(gitOk), "放行了 git，rd=x git status 照样按删除问", gitOk);
eq(security.listedCommand(sec({ cmd_allow: ["git"] }), "rd=x git status", "win32"), false, "放行名单比的时候也不剥：rd=x git status 不算批过的 git");
eq(vw("FOO=1 git status", { cmd_allow: ["git"] }, "darwin").action, "allow", "反向对照 macOS：FOO=1 开头照旧剥，git 照放行");

// start 本身会弹窗，批过「本会话 start 都允许」只管弹窗那一层，里面的 rd 照样问
eq(security.ruleFor("start \"\" cmd /c rd /s /q x", "win32"), "start", "start 那一段记的规则是 start");
security.addSessionAllow("start");
for (const c of ["start \"\" cmd /c rd /s /q x", "start /b /wait rd /s /q x", "start \"t\" /min powershell -c Remove-Item x"]) {
  ok(isDel(vw(c)), `批过 start，里面的删除照样问：${c}`, vw(c));
}
eq(vw("start https://example.com").action, "allow", "反向对照：批过 start，开网页不再问");
security.clearSessionAllow();

// 兜底那一刀：不管引号硬切。代价是把删除命令写在字符串里的也问——这是认下的误报，写在这儿当文档
for (const c of ["echo \"a & rd /s /q x\"", "findstr \"a|del\" x.txt"]) {
  ok(isDel(vw(c)), `认下的误报：引号里写着删除命令也问一句：${c}`, vw(c));
  eq(vw(c, {}, "darwin").action, "allow", `反向对照 macOS：${c} 照旧`);
}
// 兜底只抬不压：全自动不管删除，批过 rd 的也不再问
eq(vw("echo \"a & rd /s /q x\"", { permission_mode: "full" }).action, "allow", "兜底不碰全自动那档");
security.addSessionAllow("rd");
eq(vw("echo \"a & rd /s /q x\"").action, "allow", "兜底认本会话放行：批过 rd 就不再问");
security.clearSessionAllow();

// 日常命令不能因为这几刀开始弹审批
for (const c of ["echo a=b", "set X=1", "set PATH=C:\\x;%PATH%", "git commit -m \"fix: a; b\"", "npm run build && npm test",
  "dir /b", "python -c \"print(1); print(2)\"", "powershell -c \"Write-Output 'a | b'\"", "powershell -c \"Write-Output 'Remove-Item x'\"",
  "pwsh -c \"Get-ChildItem | Where-Object { $_.Name -like '*.log' }\"", "Start-Process notepad", "Start-Process -Verb RunAs notepad",
  "git branch --delete feat", "echo $x.deleted", "$list.deleteAll", ".\\build.ps1", "./x", "echo a & ver",
  "x=1 rd /s /q x"]) { // 最后这条在 cmd 里跑的是叫「x=1」的程序，不是 rd
  eq(vw(c).action, "allow", `Windows 日常命令照跑：${c}`);
}

// 段数到顶：前面垫一长串，后面那条套着的以前就不挖了，现在没拆完按看不全问
const pad = Array(300).fill("true").join(";");
const deep = vw(pad + "; bash -c 'rm -rf x'", {}, "darwin");
ok(deep.action === "ask", "段数到顶没拆完：按看不全问，不悄悄放过", deep);
eq(vw(pad, {}, "darwin").action, "allow", "反向对照：只是长、没套东西的照跑");

section("⑨ 代码闸：不写完整路径也认得出在碰黑名单、在加载应用自己的模块");
{
  const code = (c, over, platform) => security.checkCode(sec(over), c, platform);
  const isBl = (v) => v.action === "ask" && v.blacklist === true && v.ruleKey === "";
  // 拼出来的路径指到数据根里的黑名单文件（config.json 是默认黑名单里的）
  const toBlacklist = [
    `const p=process.env.OPENWORKBUDDY_HOME+"/config"+".json";require("fs").writeFileSync(p,"{}")`,
    `const fs=require("fs");console.log(fs.readFileSync(process.env.OPENWORKBUDDY_HOME+"/config.json","utf8"))`,
    `console.log(require("fs").readFileSync("../../config.json","utf8"))`,
    `const fs=require("fs"),os=require("os"),path=require("path");fs.readFileSync(path.join(os.homedir(),".ssh","id_rsa"))`,
    `const fs=require("fs");fs.readFileSync(require("path").join(process.env.OPENWORKBUDDY_HOME,"data","users.json"))`,
    `require("fs").readFileSync(${JSON.stringify(path.join(HOME, "workspace") + "/../config.json")})`,
  ];
  for (const c of toBlacklist) ok(isBl(code(c)), `认出在拼黑名单路径：${c.slice(0, 70)}`, code(c));
  // 加载应用自己的模块（命令里一个黑名单文件名都没有）
  const appMods = [
    `const app=require("path").dirname(process.env.NODE_PATH);require(app+"/org.js").updateOrg("default",{},"x")`,
    `const app=require("path").dirname(process.env.NODE_PATH);console.log(require(app+"/account.js")._internals.issueToken("boss"))`,
    `const p=require(require("path").dirname(process.env.NODE_PATH)+"/paths");console.log(p.DATA_DIR)`,
    `require("../../src/domains/account/org.js")`,
    `const app=require("path").dirname(process.env.NODE_PATH);const m="o"+"rg";require(app+"/src/domains/account/"+m)`,
    `const {createRequire}=require("module");createRequire(process.env.NODE_PATH+"/x")("../src/core/billing/budget")`,
    `const app=require("path").dirname(process.env.NODE_PATH);require("child_process").execSync("node "+app+"/cli.js owner bob")`,
    `require(${JSON.stringify(path.join(ROOT, "src", "domains", "account", "org.js"))})`,
  ];
  for (const c of appMods) {
    const v = code(c);
    ok(isBl(v) && /应用自己的模块/.test(v.rule), `认出在加载应用模块：${c.slice(0, 70)}`, v);
  }
  // 全自动也拦（跟字面量黑名单一个待遇）；总开关关着不管
  ok(isBl(code(appMods[0], { permission_mode: "full" })), "全自动档：加载应用模块照样要点头", code(appMods[0], { permission_mode: "full" }));
  ok(isBl(code(toBlacklist[0], { permission_mode: "full" })), "全自动档：拼黑名单路径照样要点头", code(toBlacklist[0], { permission_mode: "full" }));
  eq(code(appMods[0], { gateway: false }).action, "allow", "总开关关着：不看这些（跟字面量黑名单一致）");
  // 多人共用：直接拦、不出卡
  security.setMultiUser(() => true);
  ok(code(appMods[0]).action === "deny" && code(toBlacklist[1]).action === "deny", "多人共用：这两类直接拦下", [code(appMods[0]), code(toBlacklist[1])]);
  security.setMultiUser(null);
  // Windows 写法：反斜杠、大小写
  ok(isBl(code(`require("fs").readFileSync(process.env.OPENWORKBUDDY_HOME + "\\\\Config.json")`, {}, "win32")),
    "Windows：反斜杠、大小写不同也认得出", code(`require("fs").readFileSync(process.env.OPENWORKBUDDY_HOME + "\\\\Config.json")`, {}, "win32"));

  // 日常代码不能因为这几条开始弹卡
  for (const c of [
    `const c=JSON.parse(require("fs").readFileSync("config.json","utf8"));console.log(c)`,
    `const path=require("path");require("fs").writeFileSync(path.join(process.cwd(),"out","config.json"),"{}")`,
    `const P=require("pptxgenjs");const p=new P();p.writeFile({fileName:"a.pptx"})`,
    `const docx=require("docx");require("fs").writeFileSync("a.docx","")`,
    `console.log("usage: foo"); const a = "../x";`,
    `const os=require("os");console.log(require("path").join(os.homedir(),"Downloads"))`,
    `const mods=["docx","exceljs"];for(const m of mods)require(m)`,
    `const m=/a(b)/.exec("ab");console.log(m)`,
    `require("fs").mkdirSync(${JSON.stringify(path.join(HOME, "workspace", "s1", "admin"))},{recursive:true})`,
    `require("fs").writeFileSync(${JSON.stringify(path.join(HOME, "workspace", "proj", "config.json"))},"{}")`,
  ]) eq(code(c).action, "allow", `日常代码照跑：${c.slice(0, 70)}`);
  // 原来那条子进程规则还在，而且仍然可以「本会话不再问」
  const cp = code(`require("child_process").execSync("ls")`);
  ok(cp.action === "ask" && cp.ruleKey === "code:child_process" && !cp.blacklist, "反向对照：普通开子进程还是原来那张卡", cp);
}

section("⑩ 硬链接：跟黑名单文件同一份数据的，换个名字放进工作区也拦");
{
  const WS = path.join(HOME, "workspace");
  fs.mkdirSync(WS, { recursive: true });
  const s = sec();
  // 默认黑名单里的 <app>/config.json
  const cfg = path.join(HOME, "config.json");
  fs.writeFileSync(cfg, "{\"k\":\"sk-test-hl\"}");
  const hl = path.join(WS, "notes.txt");
  let linked = true;
  try { fs.linkSync(cfg, hl); } catch { linked = false; }
  if (!linked) console.log("  （这台机器的临时目录建不了硬链接，跳过本节）");
  else {
    const r = security.resolvePathWithPolicy(s, "notes.txt", WS);
    ok(!r.allowed && /黑名单/.test(r.reason), "硬链接到 config.json：按黑名单拦", r);
    // 黑名单是个目录：目录里任何一个文件的硬链接都算
    const keys = path.join(HOME, "keys");
    fs.mkdirSync(path.join(keys, "sub"), { recursive: true });
    fs.writeFileSync(path.join(keys, "sub", "id"), "secret");
    fs.linkSync(path.join(keys, "sub", "id"), path.join(WS, "id.txt"));
    const r2 = security.resolvePathWithPolicy(sec({ file_blacklist: [keys] }), "id.txt", WS);
    ok(!r2.allowed && /黑名单/.test(r2.reason), "硬链接到黑名单目录里的文件：也拦", r2);
    // 反向对照：工作区里两个互为硬链接的普通文件、链接数是 1 的普通文件，照常
    fs.writeFileSync(path.join(WS, "a.txt"), "a");
    fs.linkSync(path.join(WS, "a.txt"), path.join(WS, "b.txt"));
    eq(security.resolvePathWithPolicy(s, "b.txt", WS).allowed, true, "反向对照：工作区里自己的硬链接照常读写");
    fs.writeFileSync(path.join(WS, "plain.txt"), "p");
    eq(security.resolvePathWithPolicy(s, "plain.txt", WS).allowed, true, "反向对照：普通文件照常");
    eq(security.resolvePathWithPolicy(sec({ gateway: false }), "notes.txt", WS).allowed, true, "反向对照：总开关关着不管黑名单（原样）");
  }
}

console.log(`\n${fail ? "✗" : "✓"} 命令闸认命令：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
