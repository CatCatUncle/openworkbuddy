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
 *
 * 纯函数，不起进程、不出网。
 *   node test/cmd-gate.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cmdgate-home-"));
process.env.OPENWORKBUDDY_HOME = HOME;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(HOME, "data");

const ROOT = path.join(__dirname, "..");
const security = require(path.join(ROOT, "security"));
const cmdRisk = require(path.join(ROOT, "cmd-risk"));

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

console.log(`\n${fail ? "✗" : "✓"} 命令闸认命令：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
