"use strict";
/**
 * 命令行参数：声明表 + 「认不出来就停下来问」。
 *
 * 这一套要挡的是同一类事故——**参数没读懂，却不吭声照跑**：
 *   `wb --qiet "写周报"`        拼错的选项被当成任务文本，塞给模型，钱照花
 *   `wb --session --json "x"`   session 变成 "--json"，而 --json 就此消失
 *   `wb --mode crat "x"`        模式名写错了没人说
 * 三条都不会报错、不会变慢、不会留痕，只会把结果悄悄变成另一个样子。
 *
 * 所以断言几乎都长成一个形状：**这句话必须被说出来，而且必须跟别的那句不一样。**
 * 每一节都配反向对照，不然「没报错」和「报错了但说的是废话」在测试里长得一模一样。
 */

const path = require("path");
const { spawnSync } = require("child_process");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const A = require(path.join(ROOT, "cli-args"));
const { cols } = require(path.join(ROOT, "text-width"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 把一次解析压成一句话，好拿来比对 */
const say = (argv) => A.parse(argv).problems.map((p) => p.message + " " + p.hint).join(" | ");
const clean = (argv) => A.parse(argv).problems.length === 0;

// ── ① 拼错的选项：拦下来，并且猜出他想说什么 ──────────────────────────────
console.log("\n① 拼错的选项不许被当成任务文本");
{
  const r = A.parse(["--qiet", "写周报"]);
  eq(r.problems.length, 1, "--qiet 被拦下来了");
  ok(/没有 --qiet/.test(r.problems[0].message), "明说没有这个选项", r.problems[0]);
  ok(/--quiet/.test(r.problems[0].hint), "★猜出他想说 --quiet★ 只说「参数错误」等于让人自己去翻文档", r.problems[0]);
  ok(!r.words.join(" ").includes("--qiet"), "拼错的词没有混进任务文本里", r.words);

  ok(!clean(["-x", "写周报"]), "短选项拼错同样拦");
  ok(/-x/.test(say(["-x", "x"])), "报错里点名是哪个字母", say(["-x", "x"]));

  // 反向对照：差太远就别瞎猜，猜错比不猜更让人迷糊
  const far = A.parse(["--zzzzzzzz", "x"]);
  eq(far.problems.length, 1, "反向对照：认不出的长选项照样拦");
  ok(!/是不是想说/.test(far.problems[0].hint), "反向对照：差太远就不瞎猜，改成指路 --help", far.problems[0].hint);
  ok(/--help/.test(far.problems[0].hint), "不猜的时候也得给条路走", far.problems[0].hint);

  // 反向对照：正确拼写必须一路绿灯
  ok(clean(["--quiet", "写周报"]), "反向对照：拼对了不报错");
  ok(A.parse(["--quiet", "写周报"]).opts.quiet === true, "反向对照：拼对了值也真落进去了");
}

// ── ② 要跟值的选项，不许把后面那个选项吞掉 ────────────────────────────────
console.log("\n② 要跟值的选项不许吞掉后面的选项");
{
  const r = A.parse(["--session", "--json", "x"]);
  eq(r.problems.length, 1, "--session 后面跟着 --json：拦");
  ok(r.opts.session !== "--json", "★session 没有变成 \"--json\"★ 吞掉的话 --json 就此消失，脚本拿不到事件流", r.opts.session);
  ok(/--session=/.test(r.problems[0].hint), "告诉他值真以横杠开头怎么写", r.problems[0].hint);

  const tail = A.parse(["--session"]);
  eq(tail.problems.length, 1, "--session 是最后一个词：拦");
  ok(/最后一个词/.test(tail.problems[0].message), "说清楚是「后面没有了」", tail.problems[0].message);
  ok(say(["--session"]) !== say(["--session", "--json", "x"]), "★两种缺值说的不是同一句话★");

  // 反向对照：正常给值照旧
  eq(A.parse(["--session", "cli_123", "接着做"]).opts.session, "cli_123", "反向对照：正常给值收得到");
  eq(A.parse(["--session=cli_123"]).opts.session, "cli_123", "反向对照：等号写法也收得到");
  eq(A.parse(["--session=-怪id"]).opts.session, "-怪id", "反向对照：等号写法能塞进以横杠开头的值");
}

// ── ③ --mode 只认三个值 ──────────────────────────────────────────────────
console.log("\n③ --mode 只认 craft / plan / ask");
{
  const r = A.parse(["--mode", "crat", "x"]);
  eq(r.problems.length, 1, "写错的模式名被拦");
  ok(/craft \/ plan \/ ask/.test(r.problems[0].message), "把三个合法值全列出来", r.problems[0].message);
  ok(/craft/.test(r.problems[0].hint), "并且猜出他想说 craft", r.problems[0].hint);
  eq(A.parse(["--mode", "crat", "x"]).opts.mode, "craft", "拦下来之后 mode 保持默认，不会变成 crat");
  for (const m of ["craft", "plan", "ask"]) {
    ok(clean(["--mode", m, "x"]) && A.parse(["--mode", m, "x"]).opts.mode === m, `反向对照：${m} 收得到`);
  }
}

// ── ④ 好用的写法都得支持：等号、短选项合写、-- ───────────────────────────
console.log("\n④ 等号 / 短选项合写 / --");
{
  eq(A.parse(["--mode=plan", "x"]).opts.mode, "plan", "--mode=plan");
  const qc = A.parse(["-qc", "x"]);
  ok(qc.opts.quiet === true && qc.opts.cont === true, "-qc 等于 -q -c", qc.opts);
  ok(!clean(["-Cq", "x"]), "★要跟值的短选项挤在中间要报错★ 读成什么都是猜");
  ok(/拆开写/.test(say(["-Cq", "x"])), "并且告诉他拆开写", say(["-Cq", "x"]));
  eq(A.parse(["-C", "/tmp/a", "x"]).opts.workspace, "/tmp/a", "反向对照：-C 拆开写照收");

  const lit = A.parse(["--", "--qiet", "写周报"]);
  ok(lit.problems.length === 0, "-- 之后一律当任务文本，不再解析选项", lit.problems);
  eq(lit.words.join(" "), "--qiet 写周报", "-- 之后的词原样留在任务里");
  ok(/--/.test(A.helpText()), "帮助里写着 -- 这条路");
}

// ── ⑤ 看着像话的词，照旧当任务 ───────────────────────────────────────────
console.log("\n⑤ 以横杠开头但明显是句话的，别拦");
{
  ok(clean(["-- 这句话什么意思"]), "「-- 这句话什么意思」是任务，不是选项");
  ok(clean(["-5 度穿什么衣服"]), "「-5 度穿什么衣服」是任务");
  eq(A.parse(["-5 度穿什么衣服"]).words.join(" "), "-5 度穿什么衣服", "原样进任务文本");
  ok(clean(["-"]), "单个 - 是管道惯例，放行");
  // 反向对照：既没空格又没汉字的短词，就是拼错的选项
  ok(!clean(["--qiet"]), "反向对照：--qiet 没空格没汉字，照拦");
  ok(A.looksLikeProse("-- 这句话什么意思"), "判据：带空格或汉字算话");
  ok(!A.looksLikeProse("--qiet"), "判据：不带空格不带汉字不算话");
}

// ── ⑥ 子命令拼错最亏：认不出就当任务发出去，钱照花 ──────────────────────
console.log("\n⑥ 子命令拼错拦下来（这条直接省钱）");
{
  for (const [bad, good] of [["doctro", "doctor"], ["engine", "engines"], ["sesions", "sessions"], ["resumee", "resume"]]) {
    const r = A.parse([bad]);
    eq(r.problems.length, 1, `wb ${bad} 被拦`);
    ok(new RegExp("wb " + good).test(r.problems[0].hint), `并且猜出 wb ${good}`, r.problems[0].hint);
  }
  ok(/-- /.test(A.parse(["doctro"]).problems[0].hint), "留了后路：真要当任务就写 wb -- doctro");
  // 反向对照：真子命令、整句话、多个词，都不许打扰
  for (const argv of [["doctor"], ["engines"], ["engines", "use", "builtin"], ["帮我写周报"], ["engine 这个词什么意思"], ["hello"], ["resume", "cli_1", "接着做"]]) {
    ok(clean(argv), `反向对照：${JSON.stringify(argv)} 不该被打扰`, say(argv));
  }
}

// ── ⑦ --list 只列会话，多出来的词不许被默默扔掉 ──────────────────────────
console.log("\n⑦ --list 后面多出来的词");
{
  ok(!clean(["--list", "abc"]), "--list abc：abc 用不上，说出来");
  ok(/abc/.test(say(["--list", "abc"])), "点名是哪个词用不上", say(["--list", "abc"]));
  eq(A.parse(["--list", "5"]).opts.list, 5, "反向对照：--list 5 收得到");
  eq(A.parse(["--list"]).opts.list, 10, "反向对照：--list 不给数就是默认 10");
  ok(clean(["sessions", "5"]), "反向对照：wb sessions 5 是子命令，不走这条");
}

// ── ⑧ 帮助从表里长出来，两边对不上是不可能的 ─────────────────────────────
console.log("\n⑧ 帮助和声明表不许对不上");
{
  const help = A.helpText();
  for (const f of A.FLAGS) ok(help.includes("--" + f.long), `帮助里有 --${f.long}`);
  for (const f of A.FLAGS) if (f.short) ok(help.includes("-" + f.short + ", "), `帮助里有 -${f.short}`);
  for (const s of A.SUBS) ok(help.includes(s.usage), `帮助里有 ${s.usage}`);
  // 反向：帮助里出现的每一个 --xxx，都得在表里查得到
  const inHelp = [...new Set((help.match(/--[a-z][a-z-]*/g) || []))].filter((x) => x !== "--");
  const known = new Set(A.FLAGS.map((f) => "--" + f.long));
  const stray = inHelp.filter((x) => !known.has(x));
  eq(stray.length, 0, "★帮助里没有表里查不到的选项★ 两份手写的清单迟早对不上，所以只留一份");
  ok(/退出码/.test(help) && /2=/.test(help), "帮助里写清楚退出码，包括新加的 2＝参数写错了");
}

// ── ⑨ 帮助对齐按显示宽度算，不是按码位 ───────────────────────────────────
console.log("\n⑨ 帮助的对齐");
{
  eq(cols("中"), 2, "一个汉字两列");
  eq(cols("ab"), 2, "两个字母两列");
  const lines = A.helpText().split("\n");
  const optLines = lines.filter((l) => /^ {2}(-|\s{4}--)/.test(l) && /  /.test(l.trim()));
  ok(optLines.length >= A.FLAGS.length, "取到了全部选项行", optLines.length);
  const at = optLines.map((l) => {
    const m = l.match(/^(\s+(?:-\S,\s)?\s*--[a-z-]+(?:\s\S+)?\s+)/);
    return m ? cols(m[1]) : -1;
  });
  eq(new Set(at).size, 1, "★所有选项的说明从同一列开始★ 有中文的行用 padEnd 对齐必然歪", at);
  ok(at[0] > 0, "而且真的量到了列号（量不到会一起变成 -1，那也是「一样」）", at);
}

// ── ⑩ 老用法一个都不能变 ────────────────────────────────────────────────
// 拿改造前那段 else if 当参照物：凡是它能读对的写法，新解析器必须读出一模一样的东西。
console.log("\n⑩ 老用法回归：跟改造前的解析器逐条对齐");
{
  function oldParse(argv) {
    const opts = { mode: "craft", session: null, mcp: true, workspace: null, cont: false, json: false, quiet: false, list: 0 };
    const words = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "--mode") opts.mode = argv[++i] || "craft";
      else if (a === "--session") opts.session = argv[++i] || null;
      else if (a === "-c" || a === "--continue") opts.cont = true;
      else if (a === "-C" || a === "--workspace") opts.workspace = argv[++i] || null;
      else if (a === "--no-mcp") opts.mcp = false;
      else if (a === "--json") opts.json = true;
      else if (a === "-q" || a === "--quiet") opts.quiet = true;
      else if (a === "--list") { opts.list = Number(argv[i + 1]) > 0 ? Number(argv[++i]) : 10; }
      else words.push(a);
    }
    return { opts, words };
  }
  const LEGACY = [
    ["帮我写周报"],
    ["--no-mcp", "第一条任务"],
    ["--no-mcp", "--json", "给我个答案"],
    ["--no-mcp", "-q", "给我个答案"],
    ["--no-mcp", "--session", "cli_abc", "接着刚才那条"],
    ["-C", "/tmp/工作区", "随便干点啥"],
    ["--workspace", "/tmp/工作区", "干活"],
    ["-c", "接着上面那个继续"],
    ["--continue", "接着上面那个继续"],
    ["--mode", "plan", "先出个方案"],
    ["--mode", "ask", "这是什么"],
    ["--list", "5"],
    ["--list"],
    ["-q", "--no-mcp", "看看这些改动有没有明显问题"],
    ["sessions", "5"],
    ["resume", "cli_abc", "接着做"],
    ["engines", "use", "builtin"],
  ];
  for (const argv of LEGACY) {
    const a = oldParse(argv), b = A.parse(argv);
    ok(b.problems.length === 0, `老写法不报错：${argv.join(" ")}`, say(argv));
    eq(JSON.stringify(b.words), JSON.stringify(a.words), `老写法任务文本一致：${argv.join(" ")}`);
    const keys = ["mode", "session", "mcp", "workspace", "cont", "json", "quiet", "list"];
    const pick = (o) => JSON.stringify(keys.map((k) => o[k]));
    eq(pick(b.opts), pick(a.opts), `老写法选项一致：${argv.join(" ")}`);
  }
  // 反向对照：这份参照物本身能被区分——老解析器读错的那几条，新的必须不一样
  const bad = ["--qiet", "写周报"];
  ok(JSON.stringify(oldParse(bad).words) !== JSON.stringify(A.parse(bad).words),
    "★反向对照：老解析器把 --qiet 当任务文本，新的不这么干★ 两边永远一致的话，这一节等于没测");
}

// ── ⑪ 这个模块必须是纯的 ────────────────────────────────────────────────
// 不纯的话，每一句报错都只能靠起一个进程去撞，撞不出来的那些就永远没人验证。
console.log("\n⑪ cli-args.js 是纯的：不退出、不读盘");
{
  const src = fs.readFileSync(path.join(ROOT, "cli-args.js"), "utf8");
  ok(!/process\.exit/.test(src), "★不自己 exit★ 退不退、退几，是 cli.js 的事");
  ok(!/require\(["']fs["']\)/.test(src), "不读盘");
  ok(!/process\.stderr|process\.stdout|console\./.test(src), "不自己打印");
  ok(/process\.argv/.test(src) === false, "连 argv 都是传进来的（好在测试里喂任意输入）");
}

// ── ⑫ 真跑一遍：退出码得说实话 ──────────────────────────────────────────
console.log("\n⑫ 真跑：退出码");
{
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, "cli.js"), ...args], { encoding: "utf8" });
  const h = run(["--help"]);
  eq(h.status, 0, "wb --help 退 0");
  ok(/OpenWorkBuddy CLI/.test(h.stdout), "帮助走的是 stdout（能 | less）");

  const v = run(["--version"]);
  eq(v.status, 0, "wb --version 退 0");
  ok(/^OpenWorkBuddy \d+\.\d+\.\d+/.test(v.stdout.trim()), "版本号是真的版本号", v.stdout.trim());
  eq(v.stdout.trim().split(" ")[1], require(path.join(ROOT, "package.json")).version, "★跟 package.json 对得上★");

  const e = run(["--qiet", "写周报"]);
  eq(e.status, 2, "★参数写错退 2★ 跟「任务失败」的 1 分开，脚本才好处理");
  ok(/--quiet/.test(e.stderr), "建议走 stderr", e.stderr);
  eq(e.stdout, "", "★参数写错时 stdout 一个字都不许有★ 不然 wb ... > 答案.md 会收到一份报错当答案");

  const d = run(["doctro"]);
  eq(d.status, 2, "子命令拼错也退 2（而不是花钱跑一趟）");
}

// ── ⑬ Tab 补全：三种 shell 都得真能用，且跟上面那张表长在一起 ──────────────
// 补全脚本是最容易烂掉的那种东西：加一个选项，--help 里有了、解析认了，补全还停在半年前。
// 人按 Tab 补不出 --raw，只会以为没这个选项。所以这一节不看「生成了没有」，看两件事：
//   1. 表里每一项都必须出现在三份脚本里（少一个就是漏同步）
//   2. 拿真的 bash / zsh 跑一遍，别让脚本自己就是坏的
console.log("\n⑬ wb completion：三种 shell");
{
  const SH = ["bash", "zsh", "fish"];
  const ctx = { sessionsDir: "/home/me/.openworkbuddy/data/sessions", engines: ["builtin", "claude-code"] };
  const gen = {};
  for (const sh of SH) gen[sh] = A.completionScript(sh, ctx);

  for (const sh of SH) {
    // fish 的写法是 `complete -l mode`，没有那两道横杠——按各自的规矩找
    const token = (f) => (sh === "fish" ? "-l " + f.long : "--" + f.long);
    const miss = A.FLAGS.map(token).filter((x) => !gen[sh].includes(x));
    ok(miss.length === 0, `★${sh}：每个选项都在补全里★ 漏一个人就以为没这功能`, miss);
    const missSub = A.SUBS.map((x) => x.name).filter((x) => !gen[sh].includes(x));
    ok(missSub.length === 0, `${sh}：每个子命令都在补全里`, missSub);
    ok(!/\bnode\b/.test(gen[sh]),
      `★${sh}：按 Tab 不许起 node★ wb 启动要过 boot-check，等半秒的补全没人会用`);
    ok(gen[sh].includes(ctx.sessionsDir), `${sh}：会话目录是烤进去的`);
  }

  // 家目录里带个撇号（O'Brien 这种）不能把引号顶穿。这是唯一会从外面进来的字符串
  const qd = A.completionScript("bash", { sessionsDir: "/Users/o'brien/data/sessions", engines: [] });
  ok(qd.includes("'/Users/o'\\''brien/data/sessions'"), "★路径里的撇号要转义★ 不然生成出来的脚本是坏的", qd.match(/.*brien.*/)[0]);

  const has = (bin) => spawnSync("command", ["-v", bin], { shell: true, encoding: "utf8" }).status === 0;
  const tmp = path.join(require("os").tmpdir(), "wb-comp-test-" + process.pid);
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "wb.bash"), gen.bash);
  fs.writeFileSync(path.join(tmp, "_wb"), gen.zsh);

  if (has("bash")) {
    const syn = spawnSync("bash", ["-n", path.join(tmp, "wb.bash")], { encoding: "utf8" });
    eq(syn.status, 0, "★bash 脚本本身是好的★", syn.stderr);
    // 真驱动一次补全：把 COMP_WORDS 摆好，调 _wb_complete，看 COMPREPLY 出什么
    const drive = spawnSync("bash", ["-c", `
      source ${JSON.stringify(path.join(tmp, "wb.bash"))}
      COMP_WORDS=(wb --qu); COMP_CWORD=1; _wb_complete; echo "A:\${COMPREPLY[*]}"
      COMP_WORDS=(wb do);   COMP_CWORD=1; _wb_complete; echo "B:\${COMPREPLY[*]}"
      COMP_WORDS=(wb --mode ""); COMP_CWORD=2; _wb_complete; echo "C:\${COMPREPLY[*]}"
    `], { encoding: "utf8" });
    const out = drive.stdout || "";
    ok(/A:--quiet\b/.test(out), "★bash：--qu 补成 --quiet★", out);
    ok(/B:.*\bdoctor\b/.test(out), "bash：do 补出 doctor", out);
    ok(/C:craft plan ask/.test(out), "bash：--mode 后面给的是三个模式", out);
  } else ok(true, "（本机没有 bash，跳过真驱动）");

  if (has("zsh")) {
    const syn = spawnSync("zsh", ["-n", path.join(tmp, "_wb")], { encoding: "utf8" });
    eq(syn.status, 0, "★zsh 脚本本身是好的★", syn.stderr);
    // zsh 这边栽过一次：`*{-f,--file}'[说明]'` 展开成 `*-f'[说明]'`，一个没引号的 *
    // 后面跟方括号，zsh 当通配符去匹配文件名，当场 "no matches found"，整个函数废掉。
    // 语法检查查不出来——它只在**调用的时候**炸。所以这儿必须真调一次。
    const drive = spawnSync("zsh", ["-f", "-c", `
      compadd() { :; }; _describe() { echo "D:$3"; }; _values() { echo "V:$*"; }
      _arguments() { echo "G:$#"; }; _files() { :; }
      source ${JSON.stringify(path.join(tmp, "_wb"))} 2>/dev/null
      words=(wb doct); CURRENT=2; _wb
      words=(wb --mo);  CURRENT=2; _wb
    `], { encoding: "utf8" });
    ok(!/no matches found|parse error|not found/.test(drive.stderr || ""),
      "★zsh：调起来不炸★ 语法过了不代表跑得起来", (drive.stderr || "").slice(0, 200));
    ok(/D:/.test(drive.stdout || ""), "zsh：第一个词走子命令那条路", drive.stdout);
    ok(/G:\d+/.test(drive.stdout || ""), "zsh：选项位走 _arguments", drive.stdout);
  } else ok(true, "（本机没有 zsh，跳过真驱动）");

  // fish 装的人少，CI 上多半没有。至少把形状钉死：除注释外每一行都得是 complete -c wb，
  // 单引号得成对——这两条能挡住绝大多数「生成出来是半截」的事故
  const fishLines = gen.fish.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  ok(fishLines.every((l) => l.startsWith("complete -c wb")), "fish：每一行都是一条 complete",
    fishLines.find((l) => !l.startsWith("complete -c wb")));
  ok(fishLines.every((l) => (l.match(/'/g) || []).length % 2 === 0), "fish：单引号都成对",
    fishLines.find((l) => (l.match(/'/g) || []).length % 2));

  // 真跑 wb completion：拿不认识的 shell 要当场停，别生成一份谁也用不了的东西
  const run = (args, env) => spawnSync(process.execPath, [path.join(ROOT, "cli.js"), ...args],
    { encoding: "utf8", env: Object.assign({}, process.env, env || {}) });
  const bad = run(["completion", "powershell"]);
  eq(bad.status, 2, "不认识的 shell 退 2");
  eq(bad.stdout, "", "★不认识就一个字节都不输出★ 不然 > _wb 会存下半份垃圾");
  const good = run(["completion", "bash"]);
  eq(good.status, 0, "wb completion bash 退 0");
  ok(good.stdout.includes("complete -F _wb_complete wb"), "脚本走 stdout（能 > 文件）");
  ok(/source|~\/\./.test(good.stderr), "★装法走 stderr★ 重定向到文件时脚本干净，人还看得见怎么装", good.stderr.slice(0, 120));

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── ⑭ NO_COLOR ─────────────────────────────────────────────────────────
// 外部约定（no-color.org）：设了它，谁都不该再往输出里加颜色。
// 用的人是屏幕阅读器、日志收集器，以及一切分不清 ESC[33m 和正文的下游。
console.log("\n⑭ NO_COLOR");
{
  const run = (env) => spawnSync(process.execPath, [path.join(ROOT, "cli.js"), "--qiet", "写周报"],
    { encoding: "utf8", env: Object.assign({}, process.env, { NO_COLOR: "", FORCE_COLOR: "" }, env) });
  const colored = run({ FORCE_COLOR: "1" });
  ok(/\u001b\[/.test(colored.stderr), "★反向对照：FORCE_COLOR 下确实是有颜色的★ 没这条，下面那句等于没测");
  const plain = run({ FORCE_COLOR: "1", NO_COLOR: "1" });
  ok(!/\u001b\[/.test(plain.stderr), "★NO_COLOR 压过 FORCE_COLOR★", JSON.stringify(plain.stderr.slice(0, 120)));
  ok(/--quiet/.test(plain.stderr), "去了颜色，话还是那句话", plain.stderr.slice(0, 80));
}

// ── ⑮ 文档里的选项表 ───────────────────────────────────────────────────
// 跟 repl-commands 那一节同一个道理：文档里少一行，这个选项对外就等于不存在。
// 代码里加个 FLAGS 很容易，回头去补文档很容易忘——所以让测试记着。
console.log("\n⑮ 文档里的选项表");
{
  const doc = fs.readFileSync(path.join(ROOT, "docs", "命令行用法.md"), "utf8");
  const missF = A.FLAGS.filter((f) => !doc.includes("--" + f.long));
  ok(missF.length === 0, "★每个选项在文档里都有一行★", missF.map((f) => "--" + f.long));
  const missS = A.SUBS.filter((x) => !doc.includes("wb " + x.name));
  ok(missS.length === 0, "★每个子命令在文档里都有一行★", missS.map((x) => x.name));
  ok(!doc.includes("--qiet-不存在的选项"), "★（反向对照）文档里当然找不到一个不存在的选项★");
  // 退出码 2 是后加的，文档里那句「0 成功 1 出错 130 打断」漏了它很久
  ok(/退出码/.test(doc) && /`2`/.test(doc), "退出码 2（参数写错）写进文档了");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
