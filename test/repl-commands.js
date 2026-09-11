"use strict";
/**
 * `wb` 交互模式：一行输入到底被当成什么。
 *
 * 这一套要挡的是同一类事故——**输入没读懂，却不吭声照跑**。改写前实测到的四样，
 * 每一样在健康机器上都不报错、不变慢、不留痕：
 *   贴 10 行需求进去，模型只看见第 1 行，另外 9 行静默丢掉；
 *   `/moe craft` 整行喂给模型，它一本正经去执行一条不存在的指令，钱照花；
 *   `/moderate` 被 startsWith 认成 `/mode rate`，`/cdrom` 被认成 `/cd rom`；
 *   Ctrl+D 之后等在输入上的 Promise 永远不回来，MCP 子进程跟着挂死。
 *
 * 所以断言几乎都长成一个形状：**这一行必须落到这一类，而且必须跟旁边那一类分得开。**
 * 每节都配反向对照——不然「没认错」和「全都认成任务」在测试里长得一模一样。
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "repl-commands"));
const { cols, padCols } = require(path.join(ROOT, "text-width"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 等一个本来就该很快回来的 Promise。回不来要判红，不能把整个测试挂在那儿——
 *  「挂死」正是这一节要抓的毛病，抓法本身不能也跟着挂死 */
function 限时(p, ms) {
  let t = null;
  // 定时器不 unref：要是等的东西真回不来，就靠它把事件循环撑到判红那一刻。
  // unref 了 node 会当「没事可做」直接退 0，挂死反而显得像通过
  return Promise.race([
    Promise.resolve(p).then((v) => { clearTimeout(t); return v; }),
    new Promise((r) => { t = setTimeout(() => r("★没回来：挂死了★"), ms || 1500); }),
  ]);
}

/** 把一行输入压成 "类别:细节"，好拿来直接比对 */
function tag(line) {
  const v = R.parse(line);
  if (v.kind === "cmd") return `cmd:${v.name}${v.arg ? " " + v.arg : ""}`;
  if (v.kind === "task") return `task:${v.text}`;
  if (v.kind === "unknown") return `unknown:${v.typed}`;
  if (v.kind === "bad-arg") return `bad-arg:${v.name}`;
  return v.kind;
}

/** 给 makeInbox 装一个手动时钟 + 手动定时器，时序就能一帧一帧断言 */
function fakeInbox(extra) {
  let now = 100000;
  let pending = null;
  const log = { interject: [], merged: [] };
  const box = R.makeInbox(Object.assign({
    gapMs: 80,
    now: () => now,
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = null; },
    onInterject: (t) => log.interject.push(t),
    onMerged: (n, blocks) => log.merged.push({ n, out: blocks.length }),
  }, extra || {}));
  return {
    box, log,
    type(text, dt) { now += dt || 0; box.line(text); },
    tick() { const p = pending; pending = null; if (p) p(); },   // 手停下来了，静默期到
  };
}

async function main() {

// ── ① 打错的斜杠命令：当场拦下，并且猜出他想说什么 ────────────────────────
console.log("\n① 打错的斜杠命令不许被当成任务发出去");
{
  const v = R.parse("/moe craft");
  eq(v.kind, "unknown", "★/moe 拦下来了★ 放过去就是花钱让模型执行一条不存在的指令");
  eq(v.suggest, "/mode", "猜出他想说 /mode");
  eq(R.parse("/exi").suggest, "/exit", "/exi → /exit");
  eq(R.parse("/hlep").suggest, "/help", "/hlep → /help");
  eq(R.parse("/statu").suggest, "/status", "/statu → /status");
  eq(R.parse("/exti").suggest, "/exit", "★打颠倒了也猜得出来★ 最常见的手误就是两个字母调个个儿");
  eq(R.parse("/clera").suggest, "/clear", "/clera → /clear");

  const t = R.unknownText(v);
  ok(/没有 \/moe/.test(t), "话里点名是哪一条不认识", t);
  ok(/\/mode/.test(t), "把建议说出来", t);
  ok(/\/\/moe/.test(t), "★顺手告诉他怎么把这行当任务发出去★ 不然人只能干瞪眼", t);

  // 反向对照一：差太远就不瞎猜——猜错比不猜更误导
  eq(R.parse("/xyzzy").suggest, null, "★/xyzzy 不瞎猜★ 编一条建议比不给建议更误导");
  eq(R.nearest("zzzzzzzz"), null, "离谁都远：不给建议");
  ok(!/你是不是想说/.test(R.unknownText(R.parse("/xyzzy"))), "没建议的时候那句话也不出现");
  // 反向对照二：对的命令不许被拦
  eq(tag("/mode craft"), "cmd:mode craft", "拼对了就正常走，不是见 / 就拦");
}

// ── ② 路径长得像命令：一律原样发走 ────────────────────────────────────────
console.log("\n② 以 / 开头的路径不许被当成命令");
{
  eq(tag("/Users/me/报表.xlsx 这个表看一下"), "task:/Users/me/报表.xlsx 这个表看一下", "★带斜杠的绝对路径是话，不是命令★");
  eq(tag("/usr/local/bin 里都装了什么"), "task:/usr/local/bin 里都装了什么", "多段路径同理");
  eq(tag("/Applications 这个目录清一下"), "task:/Applications 这个目录清一下", "★/Applications 不许被当成打错的命令★ 大写开头的是目录名");
  eq(tag("/Volumes"), "task:/Volumes", "光一个 /Volumes 也是目录");
  eq(R.parse("/etc/hosts").kind, "task", "/etc/hosts 原样发走");
  // 反向对照：全小写、没斜杠、又没这条 —— 这种才拦
  eq(R.parse("/moe").kind, "unknown", "★同样以 / 开头，/moe 要拦★ 不然这一节等于把拦截关了");
}

// ── ③ 两个逃生口：我就是想发一句以 / 开头的话 ─────────────────────────────
console.log("\n③ 逃生口：行首空格 / 双斜杠");
{
  eq(tag(" /exit"), "task:/exit", "★行首一个空格 = 别当命令★");
  eq(tag("\t/mode craft"), "task:/mode craft", "制表符一样算");
  eq(tag("//mode"), "task:/mode", "★// 开头 = 吃掉一个斜杠当任务★");
  eq(tag("//exit 这四个字怎么翻译"), "task:/exit 这四个字怎么翻译", "// 后面整句都留着");
  // 反向对照：没逃生口的时候，这几行本来是命令
  eq(tag("/exit"), "cmd:exit", "★不加逃生口就还是命令★");
  eq(tag("/mode craft"), "cmd:mode craft", "同上");
}

// ── ④ startsWith 那两个老坑 ───────────────────────────────────────────────
console.log("\n④ /moderate 不是 /mode rate，/cdrom 不是 /cd rom");
{
  eq(R.parse("/moderate").kind, "unknown", "★/moderate 不许被切成 /mode rate★");
  eq(R.parse("/cdrom").kind, "unknown", "★/cdrom 不许被切成 /cd rom★");
  eq(R.parse("/newsletter").kind, "unknown", "/newsletter 不是 /new sletter");
  eq(R.parse("/session2").kind, "unknown", "/session2 不是 /session");
  // 反向对照：真正的「命令 + 参数」要认得出来
  eq(tag("/cd ../报表"), "cmd:cd ../报表", "★空格分开的才是参数★");
  eq(tag("/mode plan"), "cmd:mode plan", "同上");
}

// ── ⑤ 命令认了，参数不对：说清楚哪儿不对 ─────────────────────────────────
console.log("\n⑤ 参数不对要当场说，不能默默按默认值跑");
{
  const a = R.parse("/mode 认真点");
  eq(a.kind, "bad-arg", "★模式名写错要拦★ 默默留在原模式 = 人以为切了其实没切");
  ok(/craft/.test(R.badArgText(a)) && /plan/.test(R.badArgText(a)), "把可选值列出来", R.badArgText(a));
  ok(/认真点/.test(R.badArgText(a)), "把他打错的那个也说出来", R.badArgText(a));

  const b = R.parse("/new 一个新会话");
  eq(b.kind, "bad-arg", "不吃参数的命令带了参数也要说");
  ok(/不吃参数/.test(R.badArgText(b)), "说明白是「这条不吃参数」", R.badArgText(b));
  ok(R.badArgText(a) !== R.badArgText(b), "★两种毛病说的不是同一句话★");
  // 反向对照
  eq(tag("/mode"), "cmd:mode", "不给参数是合法的：那是「问问当前是哪个」");
  eq(tag("/new"), "cmd:new", "不吃参数的命令，不带参数当然行");
}

// ── ⑥ 大小写：/MODE 认，/Downloads 不认 ──────────────────────────────────
console.log("\n⑥ 大小写");
{
  eq(tag("/MODE plan"), "cmd:mode plan", "大写打的命令照样认");
  eq(tag("/Exit"), "cmd:exit", "首字母大写也认");
  eq(tag("/Downloads 里最近下了什么"), "task:/Downloads 里最近下了什么", "★但大写开头又没这条 = 目录名，别拦★");
}

// ── ⑦ 别名 ───────────────────────────────────────────────────────────────
console.log("\n⑦ 别名");
{
  eq(tag("/q"), "cmd:exit", "/q = /exit");
  eq(tag("/quit"), "cmd:exit", "/quit = /exit");
  eq(tag("/ls"), "cmd:files", "/ls = /files");
  eq(tag("/cls"), "cmd:clear", "/cls = /clear");
  eq(tag("/?"), "task:/?", "★/? 不是命令形状（问号不是字母），当任务发走★");
  eq(R.find("nope"), null, "★不存在的名字 find 要给 null★");
}

// ── ⑧ 粘贴：紧挨着进来的几行合成一条 ─────────────────────────────────────
console.log("\n⑧ 多行粘贴合成一条，一行不丢");
{
  const base = 5000;
  const paste = ["第一行", "第二行", "", "第四行"].map((t, i) => ({ text: t, at: base + i * 3 }));
  const m = R.mergePaste(paste, 80);
  eq(m.length, 1, "★贴 4 行出 1 条★ 改写前只有第 1 行进得去，另外 3 行静默丢掉");
  eq(m[0].split("\n").length, 4, "四行都在");
  ok(m[0].includes("第四行"), "最后一行没丢", m[0]);
  eq(m[0].split("\n")[2], "", "★中间的空行留着★ 那是原文的格式，不是「敲了个回车」");

  // 反向对照：手打的两行是两条
  const typed = R.mergePaste([{ text: "先看看日志", at: base }, { text: "再归个类", at: base + 900 }], 80);
  eq(typed.length, 2, "★隔了 900ms 就是两条★ 不然人手打的第二句会被粘到第一句屁股上");
  eq(R.mergePaste([], 80).length, 0, "空的进空的出");
}

// ── ⑨ 输入闸门：合并 / 排队 / 插话 / Ctrl+D ──────────────────────────────
console.log("\n⑨ 输入闸门 makeInbox");
{
  const f = fakeInbox();
  f.type("第一行"); f.type("第二行", 5); f.type("第三行", 5); f.type("第四行", 5);
  f.tick();
  eq(f.box.queued, 1, "★4 个 line 事件只出 1 条输入★");
  eq(f.log.merged[0].n, 4, "告诉外面原始是 4 行（cli.js 拿这个去退历史）");
  const got = await 限时(f.box.next());
  eq(got.split("\n").length, 4, "取出来还是四行");

  // 反向对照：隔得久的不许合
  const g = fakeInbox();
  g.type("一"); g.type("二", 300);
  g.tick();
  eq(g.box.queued, 2, "★隔了 300ms 就是两条★");

  // Ctrl+D：等在 next 上的那个 Promise 必须回来
  const h = fakeInbox();
  const waiting = h.box.next();
  h.box.close();
  eq(await 限时(waiting), null, "★Ctrl+D 时等着的那个 Promise 必须回来★ 改写前它永远不 resolve，进程连 MCP 子进程一起挂死");
  eq(await 限时(h.box.next()), null, "关掉之后再要还是 null");

  // 关的时候缓冲里那句不许丢
  const k = fakeInbox();
  k.type("最后再补一句");
  k.box.close();
  eq(await 限时(k.box.next()), "最后再补一句", "★静默期还没到就关了，那句也得交出来★");

  // 任务跑着的时候打的字 = 插话，不是下一条任务
  const m = fakeInbox();
  m.box.setBusy(true);
  m.type("顺便把标题也改短点"); m.tick();
  eq(m.box.queued, 0, "★忙的时候打的字不排进任务队列★");
  eq(m.log.interject[0], "顺便把标题也改短点", "走插话通道，下一步带给 agent");
  m.box.setBusy(false);
  m.type("再跑一件事"); m.tick();
  eq(m.box.queued, 1, "★不忙了就回到任务队列★ 不然插话通道会把正经任务也吃掉");
  eq(m.log.interject.length, 1, "这一条没重复算成插话");

  // 没人来取的时候先排队，绝不丢
  const q = fakeInbox();
  q.type("活儿一"); q.tick();
  q.type("活儿二"); q.tick();
  eq(q.box.queued, 2, "两条都排着");
  eq(await 限时(q.box.next()), "活儿一", "先进先出");
  eq(await 限时(q.box.next()), "活儿二", "第二条也在");
}

// ── ⑩ /cd：认 .. 、认 ~ 、认相对路径 ─────────────────────────────────────
console.log("\n⑩ /cd 认人话写的路径");
{
  const cwd = path.join(path.sep, "work", "报表项目");
  const home = path.join(path.sep, "home", "u");
  eq(R.resolveCd("..", cwd, home), path.join(path.sep, "work"), "★/cd .. 要能上一级★ 改写前报「工作空间必须是绝对路径」");
  eq(R.resolveCd("子目录", cwd, home), path.join(cwd, "子目录"), "相对路径按当前工作目录算");
  eq(R.resolveCd("~", cwd, home), home, "/cd ~ 回家");
  eq(R.resolveCd("~/项目", cwd, home), path.join(home, "项目"), "~/x 展开");
  eq(R.resolveCd(path.join(path.sep, "tmp", "x"), cwd, home), path.join(path.sep, "tmp", "x"), "绝对路径原样");
  eq(R.resolveCd("", cwd, home), "", "★不给目录 = 想看看当前在哪★ 不能当成「回家」");
  eq(R.resolveCd("   ", cwd, home), "", "全是空格也一样");
  // 反向对照：底下的 setWorkspaceDir 只收绝对路径，所以出口必须条条绝对
  for (const a of ["..", "子目录", "~", "~/项目"]) {
    ok(path.isAbsolute(R.resolveCd(a, cwd, home)), `★${a} 翻出来是绝对路径★ 否则 setWorkspaceDir 直接抛`, R.resolveCd(a, cwd, home));
  }
}

// ── ⑪ 帮助文本跟声明表双向对得上 ─────────────────────────────────────────
console.log("\n⑪ 帮助文本 ↔ 声明表");
{
  const h = R.helpText();
  for (const c of R.COMMANDS) ok(h.includes("/" + c.name), `★/${c.name} 写进了帮助★ 实现了没写进帮助 = 没人知道它存在`);
  const shown = Array.from(new Set((h.match(/\/[a-z?][a-z0-9-]*/g) || [])));
  const known = new Set(R.COMMANDS.flatMap((c) => [c.name, ...(c.aliases || [])]).map((n) => "/" + n));
  const 假的 = shown.filter((s) => !known.has(s) && s !== "//");
  eq(假的.length, 0, "★帮助里没有实现不了的命令★ 反着也要对得上", 假的);
  ok(/插话/.test(h) && /Ctrl\+C/.test(h), "把「跑着的时候能插话、Ctrl+C 停这趟」写进去", h);
  ok(/多行/.test(h) || /粘/.test(h), "把粘贴的行为写进去", h);
  ok(/行首加个空格/.test(h) || /行首/.test(h), "把逃生口写进去", h);
  // 反向对照：这个检查有能力判假
  ok(!h.includes("/nosuchcmd"), "★不存在的命令不会出现在帮助里★");
}

// ── ⑫ 帮助对齐按显示宽度算，不是按字数 ───────────────────────────────────
console.log("\n⑫ 帮助对齐（中文占两列）");
{
  const lines = R.helpText().split("\n").filter((l) => /^ {2}\//.test(l));
  eq(lines.length, R.COMMANDS.length, "每条命令一行");
  // 说明从第几列开始 = 整行宽 - 说明本身的宽。中文占两列，这么算才是眼睛看到的那一列
  const starts = lines.map((l, i) => {
    const c = R.COMMANDS[i];
    const desc = c.desc + ((c.aliases || []).length ? `（也能写 ${c.aliases.map((a) => "/" + a).join(" ")}）` : "");
    ok(l.endsWith(desc), `第 ${i + 1} 行末尾就是它的说明`, l);
    return cols(l) - cols(desc);
  });
  ok(new Set(starts).size === 1, "★所有说明从同一列起★ 中文占两列，padEnd 数的是码位，/cd <目录> 那行会错开", starts);
  // 反向对照：证明这一节测的确实是显示宽度——同一批左列用 padEnd 补会补出不一样的长度
  const lefts = R.COMMANDS.map((c) => `/${c.name}${c.arg ? " " + c.arg : ""}`);
  const w = lefts.reduce((n, s) => Math.max(n, cols(s)), 0) + 4;
  const naive = new Set(lefts.map((s) => cols(s.padEnd(w))));
  ok(naive.size > 1, "★换成 padEnd 就会参差不齐★ 这一节要是不会红，说明它根本没在量宽度", [...naive]);
  ok(new Set(lefts.map((s) => cols(padCols(s, w)))).size === 1, "padCols 补出来是齐的");
}

// ── ⑬ Tab 补全 ───────────────────────────────────────────────────────────
console.log("\n⑬ Tab 补全");
{
  const [hits] = R.complete("/c");
  ok(hits.includes("/cd") && hits.includes("/clear"), "/c 补出 /cd 和 /clear", hits);
  ok(!hits.includes("/mode"), "★不沾边的不许混进来★", hits);
  const [q] = R.complete("/q");
  eq(q.join(","), "/exit", "★别名也能补★ /q 打出来是 /exit");
  const [vals] = R.complete("/mode ");
  eq(vals.join(" "), "/mode craft /mode plan /mode ask", "带取值的命令连取值一起补");
  eq(R.complete("/mode p")[0].join(","), "/mode plan", "补一半也认");
  eq(R.complete("把日志归个类")[0].length, 0, "★普通一句话不补★ 不然打字打一半会被塞命令");
  eq(R.complete("")[0].length, 0, "空行不补");
}

// ── ⑭ 历史存盘前的收拾 ───────────────────────────────────────────────────
console.log("\n⑭ 历史");
{
  const got = R.sanitizeHistory(["写周报", "", "  ", "写周报", "贴进来的\n第二行", "写周报"], 300);
  eq(got.join("|"), "写周报|贴进来的|写周报", "空行去掉、挨着的重复去掉、多行只留第一行（文件一行一条）");
  eq(R.sanitizeHistory(["a", "b", "c"], 2).join(""), "ab", "★到顶就停★ 不然历史文件会一直长");
  eq(R.sanitizeHistory(null).length, 0, "给了不是数组也不炸");
  // 反向对照：隔开的重复要留着——那是人真的又问了一次
  eq(R.sanitizeHistory(["写周报", "查日志", "写周报"]).length, 3, "★隔开的重复不许去★");
}

// ── ⑮ 这一层是纯的 ───────────────────────────────────────────────────────
console.log("\n⑮ repl-commands 必须是纯的");
{
  const src = fs.readFileSync(path.join(ROOT, "repl-commands.js"), "utf8");
  ok(/require\("path"\)/.test(src), "（先证明读到的是这个文件）", src.slice(0, 40));
  ok(!/\bprocess\./.test(src), "★不碰 process★ 碰了就没法在测试里逐帧推时序");
  ok(!/require\("fs"\)/.test(src), "★不碰 fs★");
  ok(!/console\./.test(src), "★不打印★ 说什么话由 cli.js 定");
  eq((src.match(/Date\.now\(\)/g) || []).length, 1, "★时钟只在那个可替换的默认值上出现一次★ 写死在函数体里，粘贴时序就没法逐帧测");
  ok(/o\.now \|\|/.test(src), "时钟是从外面传进来的");
}

// ── ⑮之二 时钟真的是外面那只 ─────────────────────────────────────────────
console.log("\n⑮之二 传进去的时钟真的在起作用");
{
  const stuck = fakeInbox({ now: () => 42 });   // 时间停住 = 所有行都「紧挨着」
  stuck.type("一"); stuck.type("二"); stuck.type("三");
  stuck.tick();
  eq(stuck.box.queued, 1, "★停住的时钟让三行合成一条★ 说明用的确实是传进去的那只");
  eq((await 限时(stuck.box.next())).split("\n").length, 3, "三行都在");
}

// ── ⑯ cli.js 真的接上了这一层 ────────────────────────────────────────────
console.log("\n⑯ cli.js 接线");
{
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  ok(/require\("\.\/repl-commands"\)/.test(src), "（先证明读到的是这个文件）");
  ok(/repl\.parse\(/.test(src), "★一行输入先过 parse★ 不然这整个测试文件测的是没人用的代码");
  ok(/repl\.makeInbox\(/.test(src), "★输入走闸门★");
  ok(/repl\.resolveCd\(/.test(src), "/cd 走 resolveCd");
  ok(/repl\.helpText\(/.test(src), "/help 打的是 REPL 的帮助，不是命令行选项那份");
  ok(!/rl\.question\(/.test(src), "★不许再用 rl.question★ 它一次只接一条，多行粘贴就是这么丢的");
  ok(!/startsWith\("\/cd"\)/.test(src) && !/startsWith\("\/mode"\)/.test(src), "★不许再用 startsWith 认命令★");
  ok(/rl\.on\("SIGINT"/.test(src), "★交互模式自己接 Ctrl+C★ 终端里 readline 把信号截走了，process.once 那条路从来没通过");
  // 每条命令都得在 cli.js 里真有人管（exit 在主循环里处理，其余在 runReplCommand）
  for (const c of R.COMMANDS) {
    if (c.name === "exit") { ok(/v\.name === "exit"/.test(src), "/exit 在主循环里收尾"); continue; }
    ok(src.includes(`v.name === "${c.name}"`), `★/${c.name} 在 cli.js 里真有人管★ 光写进表里等于画饼`);
  }
  ok(!src.includes('v.name === "nosuchcmd"'), "★（反向对照）不存在的命令当然找不到★ 这一节才不是永远绿");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
