"use strict";
/**
 * 自定义斜杠命令 + /review：
 *   - .openworkbuddy/commands/*.md 两处都读，项目那份压过个人那份，撞内置的不接且说清为什么
 *   - $ARGUMENTS / $1…$9 填得对，引号里的空格不切，模板没占位符时参数不丢
 *   - REPL 认得出自定义命令，拼错时也往自定义名字上猜，帮助里列得出来
 *   - /review 取的是对的那份改动：没提交的 + 新文件；给基准时从分叉点算；截断会明说
 *   - 命令行三个新开关 --model / --max-steps / --append-system 解析得对
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 300) : "")); } };
const eq = (a, b, m) => ok(a === b, m, a === b ? undefined : { got: a, want: b });

const CC = require("../custom-commands");
const repl = require("../repl-commands");
const review = require("../review");
const cliArgs = require("../cli-args");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-slash-"));
const proj = path.join(tmp, "proj"), home = path.join(tmp, "home");
const pdir = path.join(proj, ".openworkbuddy", "commands"), hdir = path.join(home, ".openworkbuddy", "commands");
fs.mkdirSync(pdir, { recursive: true }); fs.mkdirSync(hdir, { recursive: true });

console.log("\n【1】读命令文件");
fs.writeFileSync(path.join(pdir, "fix-issue.md"), "---\ndescription: 修一个 issue\n---\n修掉 issue #$1，优先级 $2。背景：$ARGUMENTS\n");
fs.writeFileSync(path.join(hdir, "fix-issue.md"), "个人那份，不该被用上");
fs.writeFileSync(path.join(hdir, "standup.md"), "把今天的 git log 写成站会三句话");
fs.writeFileSync(path.join(pdir, "diff.md"), "想顶掉内置的 /diff");
fs.writeFileSync(path.join(pdir, "Bad Name.md"), "名字不合规");
fs.writeFileSync(path.join(pdir, "empty.md"), "---\ndescription: 空\n---\n\n");
fs.writeFileSync(path.join(pdir, "notes.txt"), "不是 .md，不管");
const got = CC.load({ cwd: proj, home, builtins: repl.COMMANDS.flatMap((c) => [c.name, ...(c.aliases || [])]) });
eq(got.list.map((c) => c.name).join(","), "fix-issue,standup", "只接两条：项目的 fix-issue + 个人的 standup");
const fix = got.list.find((c) => c.name === "fix-issue");
eq(fix.scope, "project", "同名时项目那份赢");
eq(fix.description, "修一个 issue", "frontmatter 的 description 读出来了");
ok(!/description/.test(fix.body), "正文里不带 frontmatter");
const why = (n) => (got.skipped.find((s) => path.basename(s.file) === n) || {}).why || "";
ok(/内置/.test(why("diff.md")), "撞内置 /diff 的不接，且说了为什么", why("diff.md"));
ok(/小写字母/.test(why("Bad Name.md")), "名字不合规的说了为什么");
ok(/空/.test(why("empty.md")), "空正文说了为什么");
ok(/项目那份优先/.test(why("fix-issue.md")), "被项目压掉的个人那份也留了一句");
ok(!got.skipped.some((s) => /notes\.txt/.test(s.file)), "非 .md 不算，也不吵");
eq(CC.load({ cwd: path.join(tmp, "nope"), home: path.join(tmp, "nope2") }).list.length, 0, "两个目录都不存在：空表，不抛");

console.log("\n【2】填参数");
eq(CC.expand("修掉 issue #$1，优先级 $2。背景：$ARGUMENTS", '123 高 "登录 超时"'), '修掉 issue #123，优先级 高。背景：123 高 "登录 超时"', "$1/$2/$ARGUMENTS 各就各位");
eq(CC.splitArgs(`a "b c" 'd e' f`).join("|"), "a|b c|d e|f", "双引号、单引号里的空格不切");
eq(CC.expand("看 $3", "a b"), "看 ", "没给那么多参数：空着，不留 $3 原样");
eq(CC.expand("把今天的 git log 写成三句话", "只看 main"), "把今天的 git log 写成三句话\n\n只看 main", "模板没占位符：参数接在后面，不丢");
eq(CC.expand("把今天的 git log 写成三句话", ""), "把今天的 git log 写成三句话", "没给参数：原样");
eq(CC.expand("$10 块 $1", "x"), "$10 块 x", "$10 不当成 $1 加个 0");
eq(CC.expand("$ARGUMENTS", "价格 $5 元"), "价格 $5 元", "参数里的 $5 不会被二次展开");

console.log("\n【3】REPL 认得出");
const custom = got.list;
let v = repl.parse("/fix-issue 42 高", { custom });
eq(v.kind, "custom", "/fix-issue 认成自定义命令");
eq(v.name + "|" + v.arg, "fix-issue|42 高", "名字和参数拆对了");
eq(repl.parse("/diff", { custom }).kind, "cmd", "/diff 仍是内置");
v = repl.parse("/standpu", { custom });
eq(v.kind + "|" + v.suggest, "unknown|/standup", "拼错时往自定义名字上猜");
eq(repl.parse("/fix-issue 42").kind, "unknown", "不传 custom：老行为不变");
const help = repl.helpText({ custom });
ok(/\/fix-issue \[参数\]\s+修一个 issue/.test(help) && /\/standup/.test(help), "/help 里列出自定义命令和它的说明");
ok(/\.openworkbuddy\/commands/.test(repl.helpText()), "没有自定义命令时，帮助里告诉人去哪儿放");
ok(repl.complete("/fix", { custom }).some((x) => /fix-issue/.test(Array.isArray(x) ? x.join(" ") : String(x))), "Tab 补全补得出自定义名字", repl.complete("/fix", { custom }));
eq(repl.parse("/review main").kind + "|" + repl.parse("/review main").arg, "cmd|main", "/review 是内置命令，吃一个基准参数");

console.log("\n【4】/review 取改动");
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
g("init", "-q", "-b", "main");
g("config", "user.email", "t@example.com"); g("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.js"), "let x = 1;\n");
g("add", "a.js"); g("commit", "-q", "-m", "one");
eq(review.collect(repo, "").empty, true, "干净的工作区：empty");
fs.writeFileSync(path.join(repo, "a.js"), "let x = 2;\n");
fs.writeFileSync(path.join(repo, "new.js"), "let y = 3;\n");
let r = review.collect(repo, "");
ok(/-let x = 1;/.test(r.diff) && /\+let x = 2;/.test(r.diff), "没提交的改动进了 diff");
eq(r.untracked.join(","), "new.js", "没进 git 的新文件单独列出");
let p = review.prompt(r);
ok(/new\.js/.test(p) && /read_file/.test(p), "提示词里让它去读新文件");
ok(/只审不改/.test(p) && /严重度/.test(p), "提示词里有审法和只审不改");
g("add", "-A"); g("commit", "-q", "-m", "two");
g("checkout", "-q", "-b", "feat");
fs.writeFileSync(path.join(repo, "b.js"), "let z = 4;\n");
g("add", "b.js"); g("commit", "-q", "-m", "three");
g("checkout", "-q", "main");
fs.writeFileSync(path.join(repo, "main-only.js"), "1;\n");
g("add", "main-only.js"); g("commit", "-q", "-m", "main moved on");
g("checkout", "-q", "feat");
r = review.collect(repo, "main");
ok(/b\.js/.test(r.diff), "给了基准：分支上的提交算进去");
ok(!/main-only\.js/.test(r.diff), "基准自己后来多的提交不算（从分叉点算，不是跟基准现状比）");
ok(/分叉/.test(r.label), "说清楚审的是哪一份");
ok(/找不到/.test(review.collect(repo, "no-such-branch").error || ""), "基准不存在：直说");
ok(/不像/.test(review.collect(repo, "--output=/tmp/x").error || ""), "以横杠开头的基准不传给 git");
ok(/不是 git 仓库/.test(review.collect(tmp, "").error || ""), "不在仓库里：直说");
fs.writeFileSync(path.join(repo, "big.js"), "x".repeat(review.DIFF_MAX + 5000) + "\n");
g("add", "big.js");
r = review.collect(repo, "");
ok(r.truncated && r.diff.length === review.DIFF_MAX, "太长就截到上限");
ok(/只放了前/.test(review.prompt(r)), "截了会在提示词里明说");

console.log("\n【5】命令行新开关");
let a = cliArgs.parse(["--model", "gpt-x", "--max-steps", "40", "--append-system", "只用 TypeScript", "写个脚本"]);
eq(a.problems.length, 0, "三个开关都认得");
eq(a.opts.model + "|" + a.opts.maxSteps + "|" + a.opts.appendSystem, "gpt-x|40|只用 TypeScript", "值各就各位");
eq(a.words.join(" "), "写个脚本", "任务文本没被吃掉");
eq(cliArgs.parse(["--max-steps", "0", "x"]).problems.length, 1, "--max-steps 0 报错");
eq(cliArgs.parse(["--max-steps", "abc", "x"]).problems.length, 1, "--max-steps abc 报错");
eq(cliArgs.parse(["--max-steps", "9999", "x"]).problems.length, 1, "--max-steps 超上限报错");
eq(cliArgs.parse(["review", "main"]).words.join(" "), "review main", "review 是子命令");
ok(/openworkbuddy review/.test(cliArgs.helpText()), "帮助里有 review");

console.log("\n【6】cli.js 接线");
const src = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
const rvBranch = (src.split('if (v.name === "review") {')[1] || "").split("\n    }")[0];
ok(/mode: "ask"/.test(rvBranch), "/review 交出来的活儿按 ask 跑（手里没 shell，改不了文件）");
const loop = src.split("const line = await nextInput();")[1] || "";
ok(/, 这趟模式, true\)/.test(loop), "主循环真按命令交出来的模式跑，不是一律 opts.mode");
ok(/repl\.parse\(line, \{ custom:/.test(src), "主循环 parse 时带上了自定义命令");
ok(/customCmds\.expand\(c\.body, v\.arg\)/.test(loop), "自定义命令展开后才发");
const sub = src.split('if (sub === "review") {')[1] || "";
ok(/opts\.mode = "ask"/.test(sub.split("\n  }")[0]), "openworkbuddy review 也按 ask 跑");
ok(src.indexOf('if (sub === "review") {') > src.indexOf("const shot = splitFiles(oneShot);"), "review 的提示词不过 splitFiles（diff 里的路径不该被当附件摘走）");
ok(/maxSteps: opts\.maxSteps/.test(src) && /opts\.appendSystem\]/.test(src), "--max-steps / --append-system 真传进了 runTask");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? "挂了" : "全部通过"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
