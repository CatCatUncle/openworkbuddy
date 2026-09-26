"use strict";
/**
 * `openworkbuddy` 交互模式：一行输入到底被当成什么。
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
// 模式清单从唯一真源取。在测试里抄一份的话，模式表加一个、测试还绿着——
// 它验的是自己手里那份旧清单，而不是程序真认的那份
const MODES = require(path.join(ROOT, "modes"));
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
  const shown = Array.from(new Set((h.match(/(?<![\w.~])\/[a-z?][a-z0-9-]*/g) || [])));
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
  eq(vals.join(" "), MODES.MODE_IDS.map((m) => "/mode " + m).join(" "), "带取值的命令连取值一起补");
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

// ── ⑰ /model 的选单 ─────────────────────────────────────────────────────
console.log("\n⑰ /model：这趟活儿谁来干");
{
  const ENG = [
    { id: "builtin", label: "内置引擎" },
    { id: "claude", label: "本机 Claude Code", installed: true, install: "" },
    { id: "codex", label: "本机 Codex", installed: false, install: "npm i -g @openai/codex" },
  ];
  const MOD = [
    { name: "甲", model: "m-1", channelName: "OpenRouter" },
    { name: "乙", model: "m-2", channelName: "DeepSeek" },
  ];

  const r1 = R.modelRows({ engines: ENG, models: MOD, engine: "builtin", activeModel: "乙" });
  eq(r1.length, 4, "两个本机引擎 + 两条模型");
  ok(!r1.some((x) => x.key === "builtin"), "★内置不当一个选项★ 它就是「用下面那些模型」，列出来只会让人以为还有第三条路");
  eq(r1.map((x) => x.n).join(","), "1,2,3,4", "序号从 1 连着编，跨组不重来——用户敲的是序号，不是「第二组第一个」");
  eq(r1.filter((x) => x.current).map((x) => x.key).join(","), "乙", "选中的是 active_model 那条");
  eq(r1.find((x) => x.key === "codex").ready, false, "没装的引擎标出来");
  ok(r1.find((x) => x.key === "codex").install.includes("codex"), "并且带上怎么装");

  // ★口径必须跟 llm.js 算得一样★：active_model 写了个不存在的名字时，真正在跑的是第一条。
  // 这里如果各算各的，表上会一行箭头都没有，而用户明明正用着其中一条
  const { createLLM } = require(path.join(ROOT, "llm"));
  const cfg = { models: [{ name: "甲", model: "m-1" }, { name: "乙", model: "m-2" }], active_model: "根本没这条" };
  eq(createLLM(cfg).model, "m-1", "（先证明 llm.js 的规则是「找不到就用第一条」）");
  const r2 = R.modelRows({ engines: ENG, models: MOD, engine: "builtin", activeModel: "根本没这条" });
  eq(r2.filter((x) => x.current).map((x) => x.key).join(","), "甲", "★找不到就跟着落到第一条★ 跟 createLLM 一个口径");

  // 走本机引擎的时候，模型那组一行都不该带箭头——那趟活儿根本不经过 API
  const r3 = R.modelRows({ engines: ENG, models: MOD, engine: "claude", activeModel: "乙" });
  eq(r3.filter((x) => x.current).map((x) => x.key).join(","), "claude", "★选了本机引擎，模型组不许还标着「现在这个」★");

  // 认名字
  eq(R.pickModelRow(r1, "2").row.key, "codex", "序号认");
  eq(R.pickModelRow(r1, "甲").row.key, "甲", "全名认");
  eq(R.pickModelRow(r1, "m-2").row.key, "乙", "模型 id 的一部分也认");
  eq(R.pickModelRow(r1, "").kind, "list", "不给值 = 看选单");
  eq(R.pickModelRow(r1, "99").kind, "none", "越界不认");
  ok(R.pickModelRow(r1, "99").why.includes("4"), "并且说清楚到几");
  eq(R.pickModelRow(r1, "zzz").kind, "none", "没有的不瞎认");
  const many = R.pickModelRow(R.modelRows({
    engines: [], models: [{ name: "deepseek-chat", model: "a" }, { name: "或者这条", model: "deepseek/v3" }],
  }), "deepseek");
  eq(many.kind, "many", "★对得上两条就说是哪两条，不替他挑★ 挑错了要么在花不该花的钱，要么在等一个没装的东西");
  eq(many.rows.length, 2, "两条都摆出来");
  // 反向对照：只对得上一条的时候不许也说「好几条」
  eq(R.pickModelRow(r1, "codex").kind, "ok", "★（反向对照）只对得上一条就直接选★");

  const txt = R.modelListText(r1);
  eq((txt.match(/^>/gm) || []).length, 1, "★选单上有且只有一行带标记★ 两行或零行都说明「现在用哪个」算错了");
  ok(!/[▸»]/.test(txt), "★标记只用 ASCII★ ▸ 这类符号在东亚宽度表里算不准，中文终端会把那一行画歪");
  ok(txt.includes("不动配置文件"), "说清楚只管这一趟——不然用户以为改完就长期生效了");
  ok(R.modelListText(R.modelRows({ engines: [], models: [] })).includes("设置"), "一条模型都没配的时候，得告诉人去哪儿配");
}

// ── ⑰之二 cli.js 那头真的换得动 ─────────────────────────────────────────
console.log("\n⑰之二 /model 换完真的换掉了");
{
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  ok(/let llmImpl = createLLM\(config\)/.test(src),
     "★模型客户端是个能换里层的活壳子★ 直接 const llm = createLLM(config) 的话，runtime 早把它拿在手里了，换完还是老的那条在跑");
  ok(/llmImpl = createLLM\(config\)/.test(src.split("v.name === \"model\"")[1] || ""),
     "★/model 里真的重造了一次★ 只改 config.active_model 不重造，等于什么都没换");
  ok(/chat: \(args\) => llmImpl\.chat\(args\)/.test(src), "壳子把 chat 转给当前那层");
  const hand = (src.split('v.name === "model"')[1] || "").split('v.name === "cd"')[0];
  ok(/config\.agent\.engine = "builtin"/.test(hand), "选模型时把底层引擎扳回内置——不扳的话这一步不起作用");
  ok(/was !== "builtin"/.test(hand) && /扳回内置/.test(hand),
     "★顺手改了另一个字段就得说出来★ 不说的话用户以为只换了模型，其实连账单都从订阅挪回了 API");
  ok(/if \(!row\.ready\)/.test(hand) && /没装/.test(hand),
     "★选了个没装的引擎当场拒绝★ 偷偷退回内置就是拿 API 的钱办事，用户还以为免费");
  ok(/const runReplCommand = async/.test(src), "命令处理是异步的——探测本机装没装要等一下");
  ok(/await runReplCommand\(v\)/.test(src), "★并且主循环真的等它★ 不等的话提示符会插进输出中间");
}

// ── ⑰之三 /resume 的选单 ────────────────────────────────────────────────
// `openworkbuddy resume` 一直有，但那是开新进程用的；人坐在交互里想翻回半小时前那段，
// 只能先 /exit——一 exit，当前这段的上下文、带着没发的文件、临时调过的档位全没了。
console.log("\n⑰之三 /resume：接着之前那段往下聊");
{
  const T = 1758153600000;                  // 钉死的「现在」
  const m = (min) => T - min * 60000;
  const LIST = [
    { id: "cli_a", mtime: m(12), title: "给周报改个标题", turns: 3, from: "命令行" },
    { id: "s_b", mtime: m(60 * 30), title: "分析这个 CSV", turns: 8, from: "桌面" },
    { id: "cli_c", mtime: m(9), title: "", turns: 1, from: "命令行" },
  ];
  const rows = R.sessionRows(LIST, { now: T, currentId: "cli_c" });

  eq(rows.map((r) => r.n).join(","), "1,2,3", "序号从 1 连着编——用户敲的是序号");
  eq(rows.filter((r) => r.current).map((r) => r.id).join(","), "cli_c", "当前这条标出来");
  ok(rows.some((r) => r.from === "桌面"), "★桌面端开的也列出来★ 只列 cli_ 那半边，等于把「早上在桌面开头、下午在终端接着做」这条路堵死");
  eq(rows[0].when, "12 分钟前", "相对时间，不是时间戳");
  eq(rows[1].when, "昨天", "跨到昨天就说昨天");

  // ★时钟必须是外面那只★：不传就宁可不显示，也不许拿 0 当「现在」——
  // 那会把每一条都说成「刚刚」，比不显示更糟，而且错得看不出来
  eq(R.sessionRows(LIST, { currentId: "cli_a" })[0].when, "", "★没给时钟就不印这一列★");
  eq(R.ago(m(0), T), "刚刚", "一分钟内是「刚刚」");
  eq(R.ago(m(90), T), "1 小时前", "小时");
  eq(R.ago(m(60 * 24 * 3), T), "3 天前", "天");
  eq(R.ago(m(60 * 24 * 100), T), "3 个月前", "月");
  eq(R.ago(0, T), "", "没有 mtime 也不瞎编");
  eq(R.ago(m(12)), "", "★（反向对照）没时钟就是空串，不是「12 分钟前」★");

  // 认哪一条
  eq(R.pickSessionRow(rows, "").kind, "list", "不给值 = 看选单");
  eq(R.pickSessionRow(rows, "2").row.id, "s_b", "序号认");
  eq(R.pickSessionRow(rows, "cli_a").row.id, "cli_a", "完整 id 认");
  eq(R.pickSessionRow(rows, "周报").row.id, "cli_a", "标题里的几个字也认");
  eq(R.pickSessionRow(rows, "99").kind, "none", "越界不认");
  ok(R.pickSessionRow(rows, "99").why.includes("3"), "并且说清楚到几");
  eq(R.pickSessionRow(rows, "根本没有").kind, "none", "没有的不瞎认");
  const many = R.pickSessionRow(R.sessionRows([
    { id: "cli_x", title: "周报第一版", turns: 1, from: "命令行" },
    { id: "cli_y", title: "周报第二版", turns: 2, from: "命令行" },
  ], { now: T }), "周报");
  eq(many.kind, "many", "★对得上两条就说是哪两条，不替他挑★ 挑错了是接进了另一段对话——比没接更难发现");
  eq(many.rows.length, 2, "两条都摆出来");
  eq(R.pickSessionRow(rows, "CLI_A").row.id, "cli_a", "id 不分大小写");
  eq(R.pickSessionRow([], "1").kind, "none", "一条都没有时也别崩");

  // 选单长什么样
  const txt = R.sessionListText(rows);
  eq((txt.match(/^>/gm) || []).length, 1, "★有且只有一行带标记★ 两行或零行都说明「现在在哪条」算错了");
  ok(!/[▸»]/.test(txt), "★标记只用 ASCII★ ▸ 在东亚宽度表里算不准，中文终端会把那一行画歪");
  ok(rows.every((r) => txt.includes(r.id)), "★每行都带 id★ 它是 /resume <id> 和 --session 要粘的那个串");
  ok(txt.includes("无标题"), "还没起标题的那条也得有个名字占位，不然那一列是空的，看着像坏了");
  ok(/刚才那段不会丢|不会丢|回来/.test(txt), "得说清楚接走之后现在这段没丢——不说的话没人敢按");
  // 新开还没存过的会话：一行标记都没有才是对的
  eq((R.sessionListText(R.sessionRows(LIST, { now: T, currentId: "cli_还没存过" })).match(/^>/gm) || []).length, 0,
     "★（反向对照）当前这条不在列表里时，一行标记都不许有★");
  ok(R.sessionListText([]).includes("还没有"), "一条会话都没有的时候得说人话，不是印个空表");
  // 刚开的会话还没存过盘，压根不在表里。这时候还说「带 > 的是你现在这条」，
  // 人会去找那个不存在的箭头，以为表印坏了
  ok(!R.sessionListText(R.sessionRows(LIST, { now: T, currentId: "还没存过" })).includes("带 >"),
     "★表里没有当前这条时，脚注不许再让人找箭头★");

  // id 是拿眼睛扫着找、拿鼠标划走的那一列，它必须每行都从同一格开始。
  // 「3 轮」和「21 轮」差一位、「昨天」和「12 分钟前」差四位——不补齐的话 id 那列参差不齐
  {
    const long = R.sessionRows([
      { id: "cli_1", mtime: m(12), title: "短", turns: 3, from: "命令行" },
      { id: "s_2", mtime: m(60 * 24 * 17), title: "长一点的标题在这里", turns: 21, from: "桌面" },
    ], { now: T, currentId: "cli_1" });
    const at = R.sessionListText(long).split("\n").filter((l) => /^[ >]\s+\d/.test(l))
      .map((l) => cols(l.slice(0, l.lastIndexOf("  ") + 2)));
    eq(at[0], at[1], "★id 那列每行都从同一格开始★ 轮数和时间长短不一，不补齐它就参差不齐");
  }

  // 对齐按显示宽度算（中文两列），跟 ⑫ 一个道理
  const wide = R.sessionListText(R.sessionRows([
    { id: "cli_1", mtime: m(1), title: "中文中文中文", turns: 1, from: "命令行" },
    { id: "cli_2", mtime: m(2), title: "ab", turns: 1, from: "命令行" },
  ], { now: T, currentId: "cli_1" })).split("\n").filter((l) => /^[ >]\s+\d/.test(l));
  eq(cols(wide[0].slice(0, wide[0].indexOf("命令行"))), cols(wide[1].slice(0, wide[1].indexOf("命令行"))),
     "★中文标题和英文标题的下一列对齐在同一格★ 按 length 算的话中文那行会短一半");
}

// ── ⑰之四 cli.js 那头真的接得过去 ───────────────────────────────────────
console.log("\n⑰之四 /resume 换完真的换过去了");
{
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  const hand = (src.split('v.name === "resume"')[1] || "").split('v.name === "session"')[0];
  ok(hand.length > 100, "（先证明切到了 /resume 那段）", hand.length);

  // 三样必须一起换。只换 sessionId 不换 sessFile 的话，接过来的内容会被写回**旧文件**——
  // 两条会话当场互相污染，而且要等下次打开才发现
  ok(/sessionId = row\.id/.test(hand), "★换 sessionId★");
  ok(/sessFile = f/.test(hand), "★sessFile 跟着换★ 不换的话新会话的内容会写回旧文件，两条当场互相污染");
  ok(/(?:sess = |adoptSess\()\{ history: \[\], transcript: \[\], title: "", \.\.\.loaded \}/.test(hand),
     "★sess 整个换掉，并且补齐三个字段★ 老会话文件缺 transcript 的话，下一轮 push 就炸在 undefined 上");

  ok(/store\.readJson\(f, null\)/.test(hand), "从盘上读，读不出来给 null");
  ok(/if \(!loaded \|\| typeof loaded !== "object"\)/.test(hand) && /没给你接过去|一点没动/.test(hand),
     "★读不出来就当场停★ 绝不「接了一个空的」——那等于把旧对话悄悄换成白纸，而他下一句是冲着旧对话说的");
  ok(/contextLine\(\)/.test(hand),
     "★接完印一行上下文占用★ 一条跑过二十轮的会话接过来，下一句就带着那二十轮发出去，不印只能在账单上发现");
  ok(/桌面/.test(hand) && /同时跑/.test(hand),
     "★接桌面那条要提醒一句★ 轮流聊每轮开跑前会重读，剩下的风险是两头同时跑，不说的话人以为怎么用都行");
  ok(/\/resume \$\{leaving\}/.test(hand), "★把刚离开那条的 id 打出来★ 不打的话它就掉出十二行之外，再也找不回来");
  ok(/fs\.existsSync\(sessFileOf\(raw\)\)/.test(hand),
     "★按 id 接不受选单十二行限制★ 选单只是给记不住 id 的人看的，记得住的不该被它挡住");
  ok(/repl\.sessionRows\(/.test(src) && /repl\.pickSessionRow\(/.test(src) && /repl\.sessionListText\(/.test(src),
     "★走的是纯逻辑那层★ 在 cli.js 里另抄一份的话，上面那一整节测的就是没人用的代码");
  ok(/now: Date\.now\(\)/.test(hand), "时钟由 cli.js 供给——纯逻辑那层自己不读表");
  // 反向对照
  ok(!/sess\.history = \[\]/.test(hand), "★（反向对照）不是把当前这条清空，是换一条★");

  // /new 得指向 /resume，不能再教人退出去重开——现在原地就能接回来
  const nw = (src.split('v.name === "new"')[1] || "").split('v.name === "resume"')[0];
  ok(/\/resume \$\{oldId\}/.test(nw), "★/new 把旧 id 指给 /resume★");
  ok(!/openworkbuddy --session \$\{oldId\}/.test(nw), "★不再教人退出去重开★ 一退出，上下文、带着的文件、临时档位全没了");
}

// ── ⑱ 打 `/` 时冒出来的那张菜单 ──────────────────────────────────────────
// Tab 补全一直都在，
// 可一个记不住命令的人不会去按 Tab——他打个 `/` 就等着看有什么。菜单得自己冒出来。
console.log("\n⑱ / 菜单：打一半就能看见有什么命令");
{
  const all = R.menu("/");
  ok(all && all.kind === "cmd", "光一个斜杠就出菜单");
  eq(all.items.length, R.COMMANDS.length, "★所有命令一条不少★ 菜单里漏掉的那条，对用户来说就等于不存在");
  ok(all.items.every((i) => i.text && i.insert && typeof i.desc === "string"), "每条都有名字、要插进去的串、和一句人话", all.items[0]);
  eq(R.menu("/mo").items.map((i) => i.text).join(" "), "/mode /model", "打一半只留沾边的");
  eq(R.menu("/q").items.map((i) => i.text).join(""), "/exit", "★别名也认★ 打 /q 得看得见 /exit");
  // 插进去的那一串：吃参数的后面留个空格，不吃的不留。留错了的后果不一样——
  // /new 后面多一个空格，回车进历史的就是带尾空格的另一条，翻上来还得自己删
  eq(R.menu("/mod").items.find((i) => i.text === "/mode").insert, "/mode ", "吃参数的命令后面跟一个空格，接着打值就行");
  eq(R.menu("/ne").items[0].insert, "/new", "★不吃参数的不许多带空格★");
  // 第二层：命令打完了，轮到取值
  const vals = R.menu("/mode ");
  ok(vals && vals.kind === "choice", "命令后面一个空格：该轮到挑取值了");
  eq(vals.items.map((i) => i.insert).join(" "), MODES.MODE_IDS.map((m) => "/mode " + m).join(" "),
     `${MODES.MODE_IDS.length} 个取值都在，挑中插回去的是整行`);
  eq(R.menu("/mode p").items.map((i) => i.text).join(""), "plan", "取值也能打一半");
  // 反向对照：不该出菜单的地方一条都不许出——菜单是会把光标顶走的，乱弹比不弹更烦人
  eq(R.menu("你好"), null, "★普通一句话不出菜单★");
  eq(R.menu(""), null, "空行不出");
  eq(R.menu("/zzz"), null, "★压根没有的命令不出★ 弹一张空菜单等于骗人");
  eq(R.menu("/new "), null, "★不吃参数的命令后面没什么好挑的★");
  eq(R.menu("/mode zzz"), null, "取值里没这个，也不出");
  eq(R.menu("帮我 /help 一下"), null, "★斜杠不在行首就不是命令★");
  eq(R.menu("/mode craft 再多一个词"), null, "★值后面还接着打字就不是在挑值了★");

  // 默认选中、回车跑什么（跟 Claude Code 一样：亮着的那条就是回车会跑的）
  eq(R.menu("/st").sel, 0, "★打命令名时第一条默认亮着★ 回车就跑它，不是把 /st 当打错的命令");
  eq(R.menu("/st").items[0].run, "/status", "回车跑的是整条命令，不带尾空格");
  eq(R.menu("/r").items[0].text, "/resume", "★一字不差的别名排最前★ /r 就是 /resume");
  eq(R.menu("/c").items.slice(0, 3).map((i) => i.text).join(" "), "/compact /cd /clear", "名字打头的排在只有别名沾边的（/status 的 cost）前面");
  eq(R.menu("/c").items[0].run, null, "★要花钱的命令打一半回车只补全★ /c 回车排第一的是 /compact，手滑一下就是一趟模型");
  eq(R.menu("/compact").items[0].run, "/compact", "打全了名字才算是真要跑");
  eq(R.menu("/in").items[0].run, null, "/init 同理");
  eq(R.menu("/", { custom: [{ name: "weekly", description: "写周报" }] }).items.find((i) => i.text === "/weekly").run, null, "★自定义命令也是花钱的★ 打一半不开跑");
  eq(R.menu("/mode ").sel, -1, "★挑取值那层一个字没打就不选★ /mode 不给值本身就是一种用法（弹选择器）");
  eq(R.menu("/mode cr").sel, 0, "打了几个字就选第一条");
  eq(R.menu("/mode cr").items[0].run, "/mode craft", "回车跑整行");
  ok(R.menu("/").items.every((i) => i.run === null || /^\/[a-z-]+$/.test(i.run)), "run 要么空、要么是一整条不带参数的命令");
}

// ── ⑱之一 档位条和不给值时的选择器 ──────────────────────────────────────
console.log("\n⑱之一 /perm 的档位条、/mode 和 /rewind 的选择器");
{
  const SEC = require("../security");
  const stops = Object.entries(SEC.PERMISSION_MODES).map(([id, m]) => ({ id, ...m }));
  const v = R.sliderView(stops, 2, { cur: "auto", width: 80 });
  eq(v.track.filter((t) => t.kind === "on").length, 1, "★永远只有一档是亮的★");
  ok(v.track.find((t) => t.kind === "on").text.includes("自动改文件"), "亮的是挪到的那档");
  ok(v.desc.join("").includes("现在就是这档"), "现在这档标出来");
  ok(R.sliderView(stops, 3, { width: 60 }).desc.join("").includes("确定它在干什么再开"), "★说明折行摆全不截★ 全自动那句最要紧的提醒就在句尾");
  ok(/←\/→.*回车.*Esc/.test(v.foot), "脚注把能按的键写出来");
  const { cols } = require("../text-width");
  for (const w of [30, 44, 60, 80, 120]) {
    const x = R.sliderView(stops, 3, { cur: "auto", width: w });
    const line = x.track.map((t) => t.text).join("");
    ok(cols(line) <= w - 1 && x.desc.every((l) => cols(l) <= w - 1), `宽 ${w}：档位条和说明都不折行（折了擦不干净）`, { line: cols(line), desc: x.desc.map(cols) });
  }
  const narrow = R.sliderView(stops, 1, { width: 30 }).track.map((t) => t.text).join("");
  ok(narrow.includes("‹") && narrow.includes("›") && narrow.includes("2/4") && narrow.includes("每步都问"), "★窄到摆不下一排：只摆当前这档，‹ › 说还能往哪挪★", narrow);
  eq(R.sliderView(stops, 99).at, 3, "越界夹回来");
  eq(R.sliderView(stops, -5).at, 0, "越界夹回来");
  ok(!R.sliderView(stops, 1, { cur: "auto" }).desc.join("").includes("现在就是这档"), "挪开了就不说「现在」");

  const MODES = require("../modes");
  const mr = R.modePickerRows(MODES.EXEC_MODES, "plan");
  eq(mr.length, MODES.EXEC_MODES.length, "四个模式都列");
  ok(mr.find((r) => r.id === "plan").meta.startsWith("现在这个"), "现在这个标出来");
  ok(mr.every((r) => r.meta.length > 0), "每个都说一句干什么的");

  const ck = [
    { tool: "write_file", rel: "a.md", before: null, after: "x", ts: "2026-09-26T10:00:00Z" },
    { tool: "edit_file", rel: "b.md", before: "x", after: "y", ts: "2026-09-26T10:05:00Z", current: "changed" },
  ];
  const cr = R.checkpointPickerRows(ck, Date.parse("2026-09-26T10:06:00Z"));
  eq(cr.map((r) => r.n).join(","), "2,1", "★新的在上面★ 要退的十有八九是刚才那一步");
  ok(cr[0].label === "修改 b.md" && /第 2 步/.test(cr[0].meta) && /之后又被改过/.test(cr[0].meta), "说清动了什么、第几步、之后又被改过", cr[0]);
  eq(cr[1].label, "新建 a.md", "新建");
}

// ── ⑱之二 菜单和 Tab 补全不许各说各的 ───────────────────────────────────
// 两套逻辑各算一遍同一张表，迟早会分叉：菜单里看得见、Tab 一按补不出来，
// 或者反过来。分叉了人只会觉得「这破玩意儿时灵时不灵」。
console.log("\n⑱之二 菜单里有的，Tab 一定补得出来");
{
  const 行 = ["/", "/m", "/mo", "/c", "/e", "/q", "/mode ", "/mode p"];
  for (const line of 行) {
    const hit = R.menu(line);
    const [comp] = R.complete(line);
    const fromMenu = hit ? hit.items.map((i) => i.insert.trim()).sort().join(" ") : "";
    const fromComp = comp.slice().sort().join(" ");
    eq(fromMenu, fromComp, `「${line}」菜单和 Tab 补全说的是同一批`);
  }
  // 反向对照：上面那几行得真有内容，不然这一节是在比两个空串
  ok(行.every((l) => (R.menu(l) || { items: [] }).items.length > 0), "★（先证明这几行确实各有内容）★ 比两个空串永远相等");
}

// ── ⑱之三 cli.js 那头真的把菜单画出来了 ─────────────────────────────────
console.log("\n⑱之三 菜单的画法：不许把人的输入搞乱");
{
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  ok(/require\("\.\/repl-commands"\)\.menu\(/.test(src), "★画之前先问上面那个纯函数★ 不问的话这一整节测的是没人用的代码");
  ok(/const menuUsable = \(\) => [^\n]*process\.stdout\.isTTY[^\n]*process\.stdin\.isTTY/.test(src),
     "★不是终端就一行都不画★ openworkbuddy … | tee 里画菜单，出来的是一堆转义序列");
  ok(/pos\.rows > 0/.test(src), "★输入自己换行了就不画★ 光标不在最后一行，画下去会盖掉人打的字");
  ok(/inbox\.busy/.test(src.split("function menuDraw")[1] || ""), "★活儿跑着的时候不画★ 正文一冲下来菜单就成了残渣");
  ok(/menuClose\(\); \/\/ 活儿要开跑了/.test(src), "★回车开跑前先擦干净★");
  ok(/rl\.on\("close", \(\) => \{ menuClose\(\)/.test(src), "★Ctrl\+D 退出前擦干净★ 不擦的话残菜单会留在退出后的终端里");
  ok(/menuClose\(\);/.test((src.split('rl.on("SIGINT"')[1] || "").slice(0, 200)), "★Ctrl\+C 也擦★");
  // 光标是靠相对位移回去的：写真换行把屏幕顶上去，再按同样的行数退回来。
  // 算绝对行号的写法在「屏幕刚好滚了一行」的时候会差一行——终端滚没滚，程序这边是不知道的
  ok(/readline\.moveCursor\(process\.stdout, 0, -lines\.length\)/.test(src), "★画完按相对行数退回来★");
  ok(!/cursorTo\(process\.stdout, \d+, \d+\)/.test(src), "★不许按绝对行号定位★ 屏幕一滚就错一行");
  ok(/while \(tw\.cols\(body\) > room\)/.test(src), "★每行都砍到终端宽度以内★ 超一个字就会折行，折了行擦的时候就擦不干净");
  ok(/MENU_MAX/.test(src), "★条数有上限★ 一次弹二十行把整屏顶走了");

  // ↑↓ 是从 readline 手里抢过来的，抢的时机必须卡死：只在菜单开着的时候
  const tty = src.split("const ttyWriteOrig")[1] || "";
  ok(/typeof rl\._ttyWrite === "function" \?/.test(src), "★拿不到 readline 内部就降级，不许崩★ 换个 Node 版本就打不开 CLI，那是最糟的一种坏");
  ok(/if \(ttyWriteOrig\) \{/.test(src), "★降级之后菜单照样弹，只是挑不动★");
  const iGuard = tty.indexOf("menuState.items.length");
  const iUp = tty.indexOf('k.name === "up"');
  ok(iGuard >= 0 && iUp > iGuard, "★↑↓ 只在菜单开着时才归菜单管★ 否则翻历史这个最常用的键就没了", { iGuard, iUp });
  ok(/\(enter && menuState\.sel >= 0\)/.test(tty), "★亮着才接回车★ 没亮的（@ 补路径默认不亮）回车照常发走");
  ok(/const go = enter && !!pick\.run && !multi\.length/.test(tty), "★回车跑 run，run 为空只补全★ 攒着几行的时候也不跑（那是多行消息里的一行）");
  ok(/key !== menuState\.key/.test(src.split("function menuDraw")[1] || ""), "★人按过 ↑↓、候选没变就停在他挑的那条★ 每次重画都拉回第一条，等于 ↓ 按不动");
  ok(/k\.name === "escape"/.test(tty), "Esc 收菜单");
  ok(/ttyWriteOrig\(ch, key\);/.test(tty), "★其余按键原样交回 readline★ 拦下来自己处理，等于重写一个 readline");
  // 反向对照：这一节不是永远绿
  ok(!/k\.name === "pageup"/.test(tty), "★（反向对照）没处理过的键在源码里当然找不到★");
}

// ── ⑲ 选择器：↑↓ 挑、打字搜 ────────────────────────────────────────────
// 之前是印一张表让人数着序号敲——序号得用眼睛数，数错一位就接错会话。
// 这一层只算「该画哪几行、谁是选中的」，所以能在这儿逐帧验，不用真开终端。
console.log("\n⑲ 选择器：算得对不对");
{
  const 行 = (id, label, hay) => ({ id, label, meta: "", hay: hay || label });
  const 十条 = Array.from({ length: 10 }, (_, i) => 行("s" + i, "第" + i + "条", "第" + i + "条 " + (i % 2 ? "周报" : "日报")));

  // 搜：空格分词，每个词都得命中。「周报 标题」这种想缩范围的写法才有意义
  eq(R.filterPickerRows(十条, "").length, 10, "不搜就是全都要");
  eq(R.filterPickerRows(十条, "周报").length, 5, "搜一个词");
  eq(R.filterPickerRows(十条, "周报 第3").length, 1, "★两个词是「且」不是「或」★ 「或」的话越打越多，等于打字没用");
  eq(R.filterPickerRows(十条, "周报第3").length, 0, "词之间的空格有意义，不是随便忽略的");
  eq(R.filterPickerRows(十条, "  周报  ").length, 5, "前后空格不算词");
  eq(R.filterPickerRows(十条, "找不着").length, 0, "搜不着就是 0，不是退回全部");
  eq(R.filterPickerRows(null, "x").length, 0, "喂 null 不炸");
  // 大小写：会话 id 是小写，人打大写照样得中
  eq(R.filterPickerRows([行("A1", "Alpha")], "alpha").length, 1, "★搜不分大小写★ 分了的话人得记住当时是怎么写的");

  // 窗口：选中的那条必须始终露在外面，不然按了半天不知道按到哪儿了
  eq(JSON.stringify(R.pickerWindow(5, 0, 8)), '{"start":0,"end":5}', "列表比窗口短就整个显示");
  eq(JSON.stringify(R.pickerWindow(20, 0, 8)), '{"start":0,"end":8}', "选第一条时窗口贴着顶");
  eq(JSON.stringify(R.pickerWindow(20, 19, 8)), '{"start":12,"end":20}', "★选最后一条时窗口贴着底★ 硬把选中项摆中间的话，末尾会露出一截空白");
  {
    let 露在外 = true;
    for (let i = 0; i < 20; i++) { const w = R.pickerWindow(20, i, 8); if (!(i >= w.start && i < w.end)) 露在外 = false; }
    ok(露在外, "★二十条挨个选一遍，选中的那条每次都在窗口里★ 露不出来的话人按着按着就不知道按到哪儿了");
  }

  // 画出来的那几行
  {
    const v = R.pickerView(十条, { q: "", sel: 3, title: "挑一条", verb: "接上", max: 4 });
    eq(v.lines.length, 4, "一屏就画 max 行");
    eq(v.lines.filter((l) => l.on).length, 1, "★永远只有一行是选中的★ 两行同时高亮，回车到底进哪条就成了猜");
    ok(v.lines.find((l) => l.on).text.trim().startsWith(">"), "选中那行带箭头——只靠颜色的话，不上色的终端上等于没标");
    ok(/第 \d+-\d+ 条 \/ 共 10/.test(v.foot), "★没露出来的条数要说清楚★ 不说的话人以为「就这几条」，其实还压着一屏");
    ok(/↑↓|回车|Esc/.test(v.foot), "脚注把能按的键写出来");
    ok(/搜索/.test(v.search), "★一个字都没打的时候，搜索框也得摆在那儿★ 等人打了字才冒出来，等于只有已经知道能搜的人搜得了");
    ok(v.search.includes("打字就筛"), "空框里写清楚打字就筛——一个空框不说能筛什么，人不会去试");
    eq(v.typing, false, "没打字时标成没打字：cli.js 靠它决定这一行压不压暗");
    ok(!/打字搜/.test(v.foot), "★脚注不再重复「打字搜」★ 框已经摆在眼前了，脚注再说一遍只是把按键提示挤长");
  }
  {
    const v = R.pickerView(十条, { q: "周报", sel: 0, title: "挑一条" });
    eq(v.total, 5, "搜完只剩命中的");
    ok(v.search.includes("周报"), "★搜的词要回显在框里★ 不回显的话，剩三条到底是搜出来的还是本来就三条，分不出来");
    eq(v.typing, true, "打了字就标成打了字");
    ok(!v.head.includes("周报"), "标题别再跟着变——搜的词归框，标题归标题，两处都写就是同一句话说两遍");
  }
  {
    const v = R.pickerView(十条, { q: "根本没有", sel: 0 });
    eq(v.total, 0, "搜空了");
    eq(v.lines.length, 0, "★一行都不画★ 画个空框比说人话糟");
    ok(/退格|Esc/.test(v.foot), "★搜空了要给出路★ 只说「没有」，人只会一直按一直没有");
    ok(v.search.includes("根本没有"), "★搜空了框里还得留着刚打的词★ 框一清空，人就不知道该退格删什么");
  }
  {
    // 选中位越界要自己夹回来：搜完命中从 10 条掉到 2 条，sel 还停在 7
    const v = R.pickerView(十条, { q: "周报", sel: 99 });
    ok(v.sel >= 0 && v.sel < v.total, "★选中位越界自己夹回来★ 搜一下从十条掉到两条，回车就会读到 undefined", v.sel);
    eq(R.pickerView([], { q: "" }).sel, -1, "一条都没有时没有选中项");
  }

  // 两条命令的行长什么样
  {
    const rows = R.sessionRows(
      [{ id: "a1", title: "这周的周报", turns: 8, from: "桌面", mtime: 1000 },
       { id: "b2", title: "", turns: 1, from: "cli", mtime: 1000 }],
      { now: 1000, currentId: "a1" });
    const p = R.sessionPickerRows(rows);
    eq(p.length, 2, "一条会话一行");
    eq(p[0].id, "a1", "id 带过去了——回车之后要靠它去盘上找文件");
    eq(p[1].label, "无标题", "★没标题也得有个能看的名字★ 空着的话那一行看起来像坏了");
    ok(p[0].meta.includes("现在这条") && p[0].meta.includes("桌面"), "右边那串灰字带上来源和「现在这条」");
    ok(p[0].hay.includes("a1") && p[0].hay.includes("周报"), "★id 和标题都能搜★ 记得住 id 的人不该被迫去数序号");
    ok(p[0].row && p[0].row.id === "a1", "原行挂着——cli.js 拿它去接会话，不是拿 label 反查");
  }
  {
    const rows = R.modelRows({
      engines: [{ id: "codex", label: "Codex", installed: false, install: "npm i -g codex" }],
      models: [{ name: "kimi", model: "k2" }], engine: "builtin", activeModel: "kimi",
    });
    const p = R.modelPickerRows(rows);
    eq(p.length, 2, "引擎和模型都在同一张单子里");
    ok(p[0].meta.includes("npm i -g codex"), "★没装的引擎要写明怎么装★ 只写「没装」等于让人自己去猜包名");
    ok(p.find((x) => x.id === "kimi").meta.includes("在用"), "当前在用的那个标出来");
  }
}

// ── ⑲之二 选择器在 cli.js 那头真接上了 ──────────────────────────────────
console.log("\n⑲之二 选择器接线：键归谁管");
{
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  ok(/v\.typing \? v\.search : dim\(v\.search\)/.test(src), "★搜索框真画出来了★ 纯层算得再对，cli.js 不画就等于没做；打了字那行不压暗——那几个字是人刚敲的");
  ok((src.match(/hint:/g) || []).length >= 3, "★三个选择器各给一句「这儿能搜什么」★ 只写「打字就筛」，人不知道筛的是标题还是 id");
  ok(/repl\.pickerView\(/.test(src) && /repl\.sessionPickerRows\(/.test(src) && /repl\.modelPickerRows\(/.test(src),
     "★画的是上面那层算出来的★ 在 cli.js 里另抄一份的话，⑲ 整节测的是没人用的代码");

  const tty = src.split("const ttyWriteOrig")[1] || "";
  const i选 = tty.indexOf("picker.on");
  const i菜 = tty.indexOf("menuState.items.length");
  ok(i选 >= 0 && i菜 > i选, "★选择器开着就整场归它，排在菜单前面★ 排后面的话打字搜会被菜单半路截走", { i选, i菜 });
  ok(/if \(picker\.on\) \{ picker\.key\(ch, k\); return; \}/.test(tty), "★一个键都不漏给 readline★ 漏过去的话搜索词会同时落到输入行上");

  const pu = src.split("const pickerUsable")[1] || "";
  ok(/!menuState\.dead/.test(pu),
     "★画花过一次就跟菜单一起退回印表格★ 两套各记各的，等于给同一台坏终端留了一条还在画的路");
  ok(/!!process\.stdout\.isTTY/.test(pu), "不是终端就不弹");

  const 两段 = [["resume", (src.split('v.name === "resume"')[1] || "").split('v.name === "session"')[0]],
               ["model", (src.split('v.name === "model"')[1] || "").split('v.name === "cd"')[0]]];
  for (const [名, 段] of 两段) {
    ok(/if \(!pickerUsable\(\)\) \{ prog\(repl\.(session|model)ListText/.test(段),
       "★/" + 名 + " 在管道里退回印表格★ 退不回去的话 openworkbuddy … | tee 出来的是一堆转义序列");
    ok(/await chooseFrom\(/.test(段), "★/" + 名 + " 不给参数时弹的是选择器★");
    ok(/没接|没换/.test(段), "★/" + 名 + " Esc 走人要吭一声★ 不吭声的话人不知道到底换没换");
  }
  // 反向对照
  ok(!/k\.name === "pagedown"/.test(tty), "★（反向对照）没处理过的键在源码里当然找不到★");
}

// ── ⑲之三 两个键位：Shift+Tab 和 Esc Esc ───────────────────────────────
console.log("\n⑲之三 两个键位");
{
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  const tty = src.split("const ttyWriteOrig")[1] || "";
  const iTab = tty.indexOf('k.name === "tab" && k.shift');
  const i菜 = tty.indexOf("menuState.items.length");
  const iEsc = tty.indexOf('k.name === "escape" && !rl.line');
  ok(iTab >= 0 && i菜 > iTab, "★Shift+Tab 排在菜单之前★ 排后面会被当成补全的 Tab 吃掉", { iTab, i菜 });
  ok(iEsc >= 0 && iEsc > i菜, "★Esc Esc 排在菜单之后★ 排前面的话第一下 Esc 就收不了菜单了", { iEsc, i菜 });

  const cyc = (src.split("function cyclePerm")[1] || "").slice(0, 900);
  ok(/filter\(\(id\) => id !== "full"\)/.test(cyc),
     "★这个圈里没有「全自动」★ Shift+Tab 就挨着 Tab，误碰一下把命令确认也关了，而人正盯着自己那半行字");
  ok(/PERMISSION_MODES/.test(cyc), "档位从唯一真源取，不在这儿抄一份");
  ok(/permission_mode/.test(cyc) && !/saveConfig|writeConfig/.test(cyc),
     "★只管这一趟，不写配置文件★ 顺手按一下就把长期设置改了，人不会知道");
  ok(/perm full/.test(cyc), "★把「想要全自动就明着敲 /perm full」说出来★ 不说的话人以为按不到就是没有");

  // Node 的 keypress 解码器把连按的两下 ESC 合成**一个**事件（sequence 是两个 \x1b）。
  // 掐表那套永远等不到第二下——这是实测出来的，不是推的
  const esc = tty.slice(iEsc, iEsc + 400);
  ok(/k\.sequence === "\\x1b\\x1b"/.test(esc),
     "★认 sequence★ Node 把连按的两下 ESC 合成一个事件，纯掐表的写法永远等不到第二下");
  ok(/escArmed/.test(esc), "掐表那条留着兜底——万一哪天 Node 改成真发两个事件，这边照样认");
  ok(/!rl\.line/.test(esc), "★正在打字时不抢 Esc★ 抢了的话输入到一半按 Esc 想清空，弹出来的是个选择器");
  ok(/!inbox\.busy/.test(esc), "★活儿跑着的时候不弹★ 正文一冲下来选择器就成了残渣");

  const re = (src.split("async function reEditLast")[1] || "").slice(0, 1200);
  ok(/loadComposer\(picked\.text\)/.test(re), "★挑中的原样放回输入行★ 放不回去的话这个键只是个只读的历史；多行的走 loadComposer 还是原来那几行");
  ok(!/sess\.history\.(splice|length =)/.test(re) && !/sess\.transcript\.(splice|length =)/.test(re),
     "★只放回去，不回卷历史★ 真删掉跑过的那几轮，等于把模型做过的事悄悄抹了，而人看不见抹了什么");
  ok(/没问过什么|没得改/.test(re), "★一句都没问过时说人话★ 弹个空框比说一句糟");
}

// ── ⑳ 三条新命令：/compact /diff /mcp ──────────────────────────────────
console.log("\n⑳ /compact /diff /mcp");
{
  // 体积说人话：不到 1K 报字节——「0.0K」看着像空文件，其实里头有东西
  eq(R.sizeText(0), "0 B", "0 字节就说 0 B");
  eq(R.sizeText(900), "900 B", "★不到 1K 报字节★ 报「0.9 K」看着像个空壳");
  eq(R.sizeText(4200), "4.1 K", "K");
  eq(R.sizeText(2 * 1048576), "2.0 M", "M");
  eq(R.sizeText(-1), "", "负数不瞎报");
  eq(R.sizeText("不是数"), "", "喂脏数据不炸");

  {
    const t = R.changedFilesText([]);
    ok(/还没动过文件/.test(t) && /write_file/.test(t),
       "★一个都没动时讲清楚「动过」怎么算★ 只说「没有」，人会以为是坏了");
  }
  {
    const t = R.changedFilesText(
      [{ path: "周报.md", state: "ok", size: "4.1 K", when: "刚刚" },
       { path: "草稿.md", state: "gone" }], { notRepo: true });
    ok(/周报\.md/.test(t) && /4\.1 K/.test(t), "列出来带体积");
    ok(/草稿\.md/.test(t) && /没了/.test(t),
       "★后来被删掉的也照列，标「没了」★ 悄悄不显示等于替模型圆谎——它确实写过");
    ok(/不是 git 仓库/.test(t), "★不是仓库要说明为什么没有逐行 diff★ 不说的话人以为 diff 坏了");
  }
  {
    const t = R.changedFilesText([{ path: "a.md", state: "ok" }], { git: " a.md | 3 +++" });
    ok(/a\.md \| 3 \+\+\+/.test(t) && /git 仓库/.test(t), "是仓库就把 diff --stat 一起出了");
  }

  {
    ok(/还没配/.test(R.mcpText([])) && /mcpServers/.test(R.mcpText([])),
       "★一个连接器都没有时说去哪儿加★ 只说「没有」，人不知道下一步干什么");
    const t = R.mcpText([{ name: "高德", ok: true, tools: 6 }, { name: "飞书", ok: false, why: "token 过期" }]);
    ok(/高德/.test(t) && /6 个工具/.test(t), "接上了的报带了几个工具");
    ok(/飞书/.test(t) && /token 过期/.test(t),
       "★没接上的要说卡在哪儿★ 只打个叉，人只会反复重启，重启一百次也还是 token 过期");
    ok(/接上了 1 个/.test(t), "先说个总数，不用自己数");
  }

  {
    const t0 = R.compactedText(50000, 50000, 0);
    ok(/没压/.test(t0) && /一点没动/.test(t0),
       "★没压成就直说「没压」★ 先说「压缩中」再说「没到阈值」，读起来像自相矛盾");
    const t = R.compactedText(100000, 40000, 12);
    ok(/12 条/.test(t) && /100k → 40k/.test(t) && /60%/.test(t), "压完报省了多少");
    ok(/compact-archive/.test(t) && /没删/.test(t),
       "★说清楚原文归档了没删★ 不说的话「压缩」听着就是「删掉」，没人敢按第二次");
  }

  // cli.js 那头
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  const d = (src.split('v.name === "diff"')[1] || "").split('v.name === "mcp"')[0];
  ok(/c\.name !== "write_file" && c\.name !== "edit_file"/.test(d),
     "★「动过」以工具调用为准★ 模型嘴上说改了而没真调 write_file 的情况是存在的，听它自述等于替它圆谎");
  ok(/fs\.statSync/.test(d) && /state: "gone"/.test(d), "文件还在不在当场看一眼，不是照着记录念");
  ok(/rev-parse", "--is-inside-work-tree/.test(d), "★先问是不是 git 仓库再跑 diff★ 不是仓库的话 git 会把一堆报错吐到屏幕上");
  const c = (src.split('v.name === "compact"')[1] || "").split('v.name === "diff"')[0];
  ok(/force: true/.test(c), "★手动敲的 /compact 不看阈值★「关了自动压缩」管的是「别自作主张」，不是「不许我自己压」");
  ok(/saveSess\(\)/.test(c), "★压完落盘★ 不落盘的话这一趟白压，下次打开还是老样子");
  ok(/compactHistory/.test(c) && /不支持/.test(c), "引擎不支持时当场说，不是假装压了");
  const m = (src.split('v.name === "mcp"')[1] || "").split('v.name === "resume"')[0];
  ok(/mcpManager\.status\(\)/.test(m), "连接器状态问的是管理器，不是另抄一份");
}

// ── ⑳之二 /init：让它自己去看，别自己动手写文件 ──────────────────────────
console.log("\n⑳之二 /init");
{
  const 新 = R.initTask({});
  ok(/AGENTS\.md/.test(新.prompt), "交出去的那句话里点名 AGENTS.md——项目规范就是从这个文件名读的");
  ok(/别编|真看到/.test(新.prompt),
     "★命令照抄真看到的那几条★ 不拦一句的话它会顺手编一条 npm test 出来，而这个项目可能根本没有");
  ok(/找不到就不写/.test(新.prompt),
     "★找不到依据就别写★ 拿通用建议凑满十条，读的人分不出哪条是这个项目真有的规矩");
  ok(/没依据.*直说|直说没依据/.test(新.prompt), "写完要交代依据了哪些文件");

  const 旧 = R.initTask({ has: "AGENTS.md" });
  ok(/增补|不整篇/.test(旧.note), "已经有的时候先说一声这趟是增补");
  ok(/不要整篇覆盖/.test(旧.prompt),
     "★已经有就不许整篇盖掉★ 那份八成是人手写的，盖掉了 git 之外一点痕迹都没有");
  ok(旧.prompt.length > 新.prompt.length, "（反向对照：两种情况交出去的话确实不一样）");

  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  const h = (src.split('v.name === "init"')[1] || "").split('v.name === "compact"')[0];
  ok(/return t\.prompt/.test(h),
     "★/init 是把话交回主循环去跑，不是自己写文件★ 自己写的话，人按一下盘上就多个文件，中间什么都没问过");
  ok(/AGENTS\.md", "CLAUDE\.md/.test(h) && /size > 0/.test(h),
     "★两个文件名都认，空文件不算数★ 一个空的 AGENTS.md 会让它以为「已经有了」，于是只增补不重写");
  const loop = (src.split("const line = await nextInput();")[1] || "");
  ok(/typeof 交出来的 !== "string"/.test(loop), "★主循环真收下了命令交出来的那句话★ 不收的话 /init 按下去什么都不会发生");
  ok(/现成的 \? \{ files: \[\], missing: \[\], text: 现成的 \}/.test(loop),
     "★现成的那句话不过 splitFiles★ 那一步是摘「人拖进来的文件」的，拿它扫一句现成的话会把 AGENTS.md 当附件摘走，句子当场缺一块");
}

// ── ⑳之三 !命令：自己在终端里跑一条 shell，输出跟下一句话带给模型 ─────────
console.log("\n⑳之三 !命令");
{
  const sh = (line) => { const v = R.parse(line); return v.kind === "shell" ? `shell:${v.cmd}` : tag(line); };
  eq(sh("!git status"), "shell:git status", "★!git status 是自己跑，不是发给模型★");
  eq(sh("!  ls -la  "), "shell:ls -la", "! 后面的空白修掉");
  eq(sh("!"), "task:!", "★光一个 ! 没东西可跑★ 当普通的话发，不能跑一条空命令");
  eq(sh("!   "), "task:!", "! 加一串空格也一样");
  eq(sh(" !ls"), "task:!ls", "★行首一个空格 = 逃生口★ 跟 / 那条规矩一样");
  eq(sh("!!重要：先别动数据库"), "task:!重要：先别动数据库", "★!! = 我就是想发一句 ! 开头的话★ 吃掉一个 !，跟 // 同一个路数");
  eq(sh("！太好了"), "task:！太好了", "★全角感叹号不算★ 中文里一句感叹不能被当成 shell 跑掉");
  eq(sh("ls !important"), "task:ls !important", "! 不在行首就是普通字");
  eq(sh("/mode craft"), "cmd:mode craft", "（反向对照）斜杠命令照旧");
  ok(/!命令/.test(R.helpText()) && /!!/.test(R.helpText()), "/help 里写着能敲 !命令，也写着 !! 这个逃生口", R.helpText().slice(-400));

  // 交给模型的那段：颜色码、进度条、太长、退出码
  const n1 = R.shellNote({ cmd: "npm test", out: "\x1b[32m✓ ok\x1b[0m\n\x1b]8;;http://x\x07link\x1b]8;;\x07\n", code: 0 });
  eq(n1, "$ npm test\n✓ ok\nlink", "★颜色码和终端超链接转义都剥掉★ 带给模型的是字，不是控制序列");
  eq(R.shellNote({ cmd: "curl -O x", out: "  1%\r 50%\r100%\ndone\n", code: 0 }), "$ curl -O x\n100%\ndone", "★\\r 进度条只留最后画上去的那版★ 不然一条下载能灌几百行");
  eq(R.shellNote({ cmd: "false", out: "", code: 1 }), "$ false\n（没有输出）\n（退出码 1）", "★非零退出码写明★ 模型要知道这条是失败的");
  eq(R.shellNote({ cmd: "sleep 30", out: "", code: null, signal: "SIGINT" }), "$ sleep 30\n（没有输出）\n（被 SIGINT 停掉了）", "被 Ctrl+C 停掉的也说清楚");
  eq(R.shellNote({ cmd: "nope", out: "", code: null, error: "spawn ENOENT" }), "$ nope\n（没有输出）\n（没跑起来：spawn ENOENT）", "没跑起来说没跑起来");
  ok(!/退出码/.test(R.shellNote({ cmd: "true", out: "x", code: 0 })), "（反向对照）退出码 0 不写，不然每条都像出了事");
  const big = "HEAD-" + "m".repeat(20000) + "-TAIL";
  const nb = R.shellNote({ cmd: "cat big.log", out: big, code: 0 });
  ok(nb.length < R.SHELL_NOTE_MAX + 200, "★太长就截★ 一条 cat 大日志不能把上下文灌满", nb.length);
  ok(nb.includes("HEAD-") && nb.includes("-TAIL"), "★头尾都留★ 报错和汇总在尾巴上，开头说明跑的是什么");
  ok(/中间省略 \d+ 字/.test(nb), "截了要说截了", nb.slice(0, 200));
  const [headPart, tailPart] = nb.slice("$ cat big.log\n".length).split(/\n…（中间省略 \d+ 字）…\n/);
  ok(tailPart && tailPart.length > headPart.length * 2, "★尾巴分得比头多★", [headPart.length, tailPart && tailPart.length]);

  // 拼到下一句话前面
  eq(R.withShellNotes("帮我修一下", []), "帮我修一下", "★没跑过 !命令 就原样返回★ 一个字都不多");
  eq(R.withShellNotes("帮我修一下", undefined), "帮我修一下", "不传也不崩");
  const w = R.withShellNotes("帮我修一下", ["$ git status\nM a.js"]);
  ok(w.endsWith("\n\n帮我修一下"), "★人自己那句话放最后★ 模型最后读到的是要它干什么", w);
  ok(w.includes("```\n$ git status\nM a.js\n```"), "每条输出用围栏包起来", w);
  ok(/自己跑了/.test(w), "说清楚这是人自己跑的，不是它跑的", w);
  const md = R.withShellNotes("看看", ["$ cat README.md\n```js\nx()\n```"]);
  ok(md.includes("````\n$ cat README.md") && md.includes("```\n````"), "★输出里自带 ``` 的：外层围栏多一个反引号★ 不然 cat 一份 Markdown 就提前收口", md);
  const many = Array.from({ length: 8 }, (_, i) => `$ echo ${i}\n${i}`);
  const wm = R.withShellNotes("好", many);
  ok(!wm.includes("$ echo 2\n") && wm.includes("$ echo 3\n") && wm.includes("$ echo 7\n"), `★最多带最近 ${R.SHELL_NOTES_KEEP} 条★ 连敲一串 ls 看东西，要的是最后那几条`, wm);
  ok(/最近这 5 条/.test(wm), "丢了前面的要说", wm.slice(0, 80));

  // cli.js 那头真接上了
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  ok(/v\.kind === "shell"/.test(src), "★cli.js 主循环真的认 shell 这一类★ 不然 !ls 会落到「当任务发走」");
  ok(/repl\.withShellNotes\(/.test(src) && /repl\.shellNote\(/.test(src), "输出真的记下来、真的拼进下一句");
  const sig = src.slice(src.indexOf('rl.on("SIGINT"'), src.indexOf('rl.on("SIGINT"') + 300);
  ok(sig.indexOf("shellKid") > -1 && sig.indexOf("shellKid") < sig.indexOf("inbox.busy"), "★Ctrl+C 先停正在跑的 !命令★ 不能落到「再按一次退出」上", sig);
  ok(/detached: process\.platform !== "win32"/.test(src) && /process\.kill\(-kid\.pid/.test(src), "★整组收★ !npm run dev 起的子进程也得一块儿停", "");
  const drop = src.slice(src.indexOf('v.name === "drop"'), src.indexOf('v.name === "drop"') + 700);
  ok(/shellNotes\.length = 0/.test(drop), "/drop 连 !命令 的输出一起不带", drop);
  ok(/notes\.length \? 这句 : undefined/.test(src), "★拼了输出时，会话里显示的还是人自己那句（shown）★ 标题不能变成一大段 git status");
}

// ── ⑳之四 Plan 出完计划：摆「开干 / 接着改」 ─────────────────────────
console.log("\n⑳之四 Plan 出完计划");
{
  const rows = R.planNextRows();
  ok(rows.length === 2 && rows[0].id === "go" && rows[1].id === "more", "★两条，开干在前★ 回车默认就是开干", rows);
  ok(/开干/.test(rows[0].label) && /Craft/.test(rows[0].meta), "开干那条说清楚会切到 Craft", rows[0]);
  ok(/改计划/.test(rows[1].label) && /Plan/.test(rows[1].meta), "接着改那条说清楚还留在 Plan", rows[1]);
  ok(R.filterPickerRows(rows, "craft").length === 1 && R.filterPickerRows(rows, "改").length >= 1, "打字能筛（选择器那套本来就能搜）");
  const v = R.pickerView(rows, { title: "t", verb: "定" });
  ok(v.total === 2 && v.sel === 0, "摆出来选中第一条", v);
  ok(/计划/.test(R.PLAN_GO_TEXT) && /逐条对照/.test(R.PLAN_GO_TEXT), "★开干那句要它做完对着计划交账★ 不然做一半说做完了没人对得出来", R.PLAN_GO_TEXT);

  const m = (o) => R.planNextMode({ mode: "plan", result: "ok", usable: true, typed: "", ...o });
  ok(m({}) === "pick", "Plan 正常跑完、画得了单子：摆");
  ok(m({ usable: false }) === "hint", "★画不了单子也得说下一步怎么走★");
  ok(/\/mode craft/.test(R.PLAN_NEXT_HINT), "那句提示给的是真能敲的命令", R.PLAN_NEXT_HINT);
  ok(m({ mode: "craft" }) === "" && m({ mode: "ask" }) === "" && m({ mode: "goal" }) === "", "别的模式不问");
  ok(m({ result: "error" }) === "" && m({ result: "aborted" }) === "", "★出错、Ctrl+C 停掉的不问★ 半截计划不该让人开干");
  ok(m({ typed: "x" }) === "" && m({ typed: "x", usable: false }) === "", "★输入行上已经打了字不问★ 他已经在说下一句了");
  ok(R.planNextMode(null) === "", "没参数不炸");

  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  const at = src.indexOf("repl.planNextMode(");
  const blk = src.slice(at, at + 1200);
  ok(at > 0 && /mode: 这趟模式/.test(blk) && /result: last/.test(blk) && /typed: repl\.composeText\(multi, rl\.line\)/.test(blk), "★cli.js 主循环真的问了★ 按这一趟的模式和结果问；攒着几行没发也算已经在打字", blk.slice(0, 200));
  ok(/opts\.mode = "craft"/.test(blk) && /runOnce\(runtime, repl\.PLAN_GO_TEXT, "craft", true\)/.test(blk), "★选开干：切到 Craft 并且马上照计划跑★", blk);
}

// ── 文档那张表得跟着命令表走 ─────────────────────────────────────────
// 真实发生过：命令表里已经有 /open /paste /drop，docs/命令行用法.md 还写着「十条内置命令」、
// 表里一条都没有。文档是很多人唯一读过的东西，少三条 = 这三个功能对外等于不存在
console.log("\n㉑ 文档里的命令表");
{
  const doc = fs.readFileSync(path.join(ROOT, "docs", "命令行用法.md"), "utf8");
  const missing = R.COMMANDS.map((c) => c.name).filter((n) => !new RegExp("\\|\\s*`/" + n + "[ `]").test(doc));
  ok(missing.length === 0, "★每条命令在文档表格里都有一行★ 文档少一条 = 这个功能对外等于不存在", missing);
  const CN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
    "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二"];
  const said = (doc.match(/([零一二三四五六七八九十]+)条内置命令/) || [])[1] || "";
  ok(said === CN[R.COMMANDS.length], `文档说的条数对得上（现在 ${R.COMMANDS.length} 条）`, { said, want: CN[R.COMMANDS.length] });
  // 反向对照：这条不是永远绿
  ok(!/\|\s*`\/nosuchcmd[ `]/.test(doc), "★（反向对照）文档里当然找不到一条不存在的命令★");
}

// ── ⑲之四 多行输入 ─────────────────────────────────────────────────────
// 回车 = 发出去；粘进来的多行不自己发；行尾 \、Ctrl+J、Option+回车 换行；Ctrl+G 编辑器；Ctrl+R 搜历史。
// 真终端里走一遍的在 cli-pty ⑧，这儿钉纯函数和接线
console.log("\n⑲之四 多行输入");
{
  eq(R.continuedLine("第一行\\", 4), "第一行", "★行尾一个 \\ 且光标在行尾 = 没完★ 去掉那个 \\");
  eq(R.continuedLine("a\\", undefined), "a", "不给光标就只看行尾");
  eq(R.continuedLine("C:\\dir\\\\", 8), null, "★偶数个 \\ 是转义过的，照原样发★ 路径结尾的 \\\\ 不该把人卡在续行里");
  eq(R.continuedLine("C:\\dir\\\\", undefined), null, "偶数个 \\ 不看光标也照原样发");
  eq(R.continuedLine("x\\\\\\", 4), "x\\\\", "三个 = 转义的一对 + 续行的一个");
  eq(R.continuedLine("abc\\", 2), null, "★光标不在行尾不算★ 人在行中间按回车就是要发");
  eq(R.continuedLine("abc", 3), null, "没有 \\ 就是发");
  eq(R.continuedLine("\\", 1), "", "只打了一个 \\：攒一行空的");
  eq(R.continuedLine(null, 0), null, "空的不崩");

  eq(R.newlineKey({ name: "return", meta: true, sequence: "\x1b\r" }, 9999), "newline", "★Option+回车★（终端把 Option 当 Meta）");
  eq(R.newlineKey({ name: "undefined", sequence: "\x1b[13;2u" }, 9999), "newline", "★Shift+回车 的 CSI-u 写法★ Node 25 认不出名字，只能看 sequence");
  eq(R.newlineKey({ sequence: "\x1b[27;2;13~" }, 9999), "newline", "Shift+回车 的 modifyOtherKeys 写法");
  eq(R.newlineKey({ name: "enter", sequence: "\n" }, 5000), "newline", "★Ctrl+J 换行★");
  eq(R.newlineKey({ name: "enter", sequence: "\n" }, 20), "crlf-tail", "★回车后紧跟的 \\n 是 \\r\\n 的尾巴★ 当成 Ctrl+J 会多出一行空的");
  eq(R.newlineKey({ name: "enter", sequence: "\n" }, 20, 10), "newline", "crlfDelay 可调：超了窗口就是真的 Ctrl+J");
  eq(R.newlineKey({ name: "return", sequence: "\r" }, 0), "", "★（反向对照）光回车不是换行★ 不然回车永远发不出去");
  eq(R.newlineKey({ name: "a", sequence: "a" }, 0), "", "普通字不是换行");
  eq(R.newlineKey(null, 0), "", "空的不崩");

  eq(R.composeText(["第一行", "第二行"], "第三行"), "第一行\n第二行\n第三行", "攒着的几行 + 输入行 = 整段");
  eq(R.composeText([], "单行"), "单行", "没攒 = 就是那一行");
  eq(R.composeText(null, null), "", "空的不崩");
  const sp = R.splitComposed("甲\r\n乙\r丙");
  ok(sp.above.length === 2 && sp.above[0] === "甲" && sp.above[1] === "乙" && sp.line === "丙", "★\\r\\n、单个 \\r 都算换行★ 最后一行进输入行", sp);
  eq(R.splitComposed("一行").above.length, 0, "一行的不攒");
  for (const t of ["a\n\nb", "x\n", "\tindent\n  y", ""]) {
    const q = R.splitComposed(t);
    eq(R.composeText(q.above, q.line), t, "★拆开再合回去一字不差★ " + JSON.stringify(t));
  }

  const eight = Array.from({ length: 8 }, (_, i) => "r" + i);
  eq(R.echoRows(eight, 8).length, 8, "八行以内全印");
  const many = R.echoRows(Array.from({ length: 200 }, (_, i) => "r" + i), 8);
  ok(many.length === 8 && many[6] === "r6" && /还有 193 行，都收下了/.test(many[7]), "★粘两百行只印头几行 + 一句还有多少★ 行数对得上（7 + 193 = 200）", many.slice(-2));
  eq(R.echoRows(Array.from({ length: 9 }, () => "x")).length, 8, "不给上限默认 8");

  eq(R.historyLine("第一行\n  第二行\r\n第三行 "), "第一行 第二行 第三行", "★进历史压成一行★ 历史文件一行一条，不压的话 ↑ 翻回来只剩第一行");
  const hr = R.historyRows(["甲 乙", "丙", "甲 乙", "/exit", "", "  "], { full: ["甲\n乙"] });
  ok(hr.length === 2 && hr[0].text === "甲\n乙" && hr[1].text === "丙", "★同一句只留一条；这个会话里的多行原话换回带换行的原样★ /exit 和空的不进单子", hr);
  ok(hr[0].label === "甲 乙" && hr[0].hay === "甲 乙", "单子上显示的、拿来筛的都是压成一行的", hr[0]);
  eq(R.historyRows(["a", "b", "c"], { max: 2 }).length, 2, "有上限");
  const long = R.historyRows(["字".repeat(80)])[0];
  ok(long.label.length === 57 && long.label.endsWith("…") && long.text.length === 80, "长的单子上截短，放回去的是全文", long.label.length);
  eq(R.historyRows(null).length, 0, "空的不崩");

  eq(R.kCount(0), "0", "0");
  eq(R.kCount(999), "999", "不到一千原样");
  eq(R.kCount(1000), "1k", "★整千不带 .0★");
  eq(R.kCount(8400), "8.4k", "8.4k");
  eq(R.kCount(12345), "12.3k", "12.3k");
  eq(R.kCount(99949), "99.9k", "99.9k");
  eq(R.kCount(123456), "123k", "★十万往上不要小数★");
  eq(R.kCount(-5), "0", "负数当 0");
  eq(R.kCount("abc"), "0", "不是数当 0");

  eq(R.tickSuffix({ secs: 12, tokens: 8400, stop: "Esc" }), " · 12s · 8.4k tokens · Esc 停", "★跑着的那一行：用了多久 · 花了多少 · 怎么停★");
  eq(R.tickSuffix({ secs: 75, stop: "Ctrl+C" }), " · 1m15s · Ctrl+C 停", "过一分钟写成 1m15s");
  eq(R.tickSuffix({ secs: 3, tokens: 0 }), " · 3s", "★token 没报上来就不写★ 不是 0，是还没记过；stop 空 = 收尾定格");
  eq(R.tickSuffix({}), " · 0s", "空的不崩");
  // 打头那个字转起来
  const { cols: wcols } = require("../text-width");
  ok(R.SPIN_FRAMES.every((g) => wcols(g) === 1), "★转的每一帧都只占一格★ 占两格的话行长一帧一变，尾巴跟着左右抖");
  eq(R.spinGlyph(0), "·", "第一帧就是定格时那个 ·：一开始转和没转长得一样，不跳");
  eq(R.SPIN_FRAMES[R.SPIN_FRAMES.length - 1], R.SPIN_FRAMES[1], "★来回呼吸★ 最后一帧挨着第一帧，转回头不跳");
  eq(R.spinGlyph(R.SPIN_FRAMES.length + 2), R.spinGlyph(2), "帧号一直往上加也循环");
  ok(R.SPIN_MS >= 80 && R.SPIN_MS <= 200, "一秒五到十来帧：再快是白写终端，再慢看着像卡");
  {
    const cliSrc = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
    const draw = cliSrc.split("function tickDraw()")[1].split("\nfunction ")[0];
    ok(/if \(!tick\.anim && sec === tick\.lastSec\) return;/.test(draw), "★不转的行秒数没跳就不画★ 定时器一秒跑八次，工具那行不能跟着写八次终端");
    ok(/if \(secs < 2\) \{ if \(glyph && tickPaint\(\{ bare: true, glyph \}\)\)/.test(draw), "★头两秒只转那个字、不挂尾巴★ 一眨眼就完的步骤照旧没有尾巴");
    ok(/tick\.tailed \? \{ secs: [^}]+\} : \{ bare: true \}/.test(cliSrc), "★定格时转着的字落回 ·，没挂过尾巴的也不补一截「· 0s」★");
  }

  const help = R.helpText();
  ok(/Ctrl\+J/.test(help) && /Option\+回车/.test(help) && /行尾 \\ 再回车/.test(help), "★/help 写着三种换行★ 不写 = 人只会以为回车就是发", help);
  ok(/Ctrl\+G/.test(help) && /Ctrl\+R/.test(help), "/help 写着编辑器和搜历史");
  ok(/粘进来的多行不会自己发出去/.test(help), "★/help 说清楚粘进来的不自己发★");
  ok(/Esc 或 Ctrl\+C 停这趟活儿/.test(help), "/help 写着 Esc 能停");

  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  const tty = src.split("rl._ttyWrite = (ch, key) =>")[1] || "";
  const hook = tty.slice(0, tty.indexOf("\n    };\n"));
  const at = (needle) => hook.indexOf(needle);
  const iPaste = at('k.name === "paste-start"'), iTab = at('k.name === "tab" && k.shift'), i菜 = at("menuState.items.length");
  ok(hook.length > 1000 && iPaste >= 0 && iPaste < iTab && iPaste < i菜, "★括号粘贴排在 Shift+Tab 和菜单前面★ 粘进来的 Tab、回车不能被当成按键", { iPaste, iTab, i菜 });
  ok(at("keyGrab") >= 0 && at("keyGrab") < iPaste && at("picker.on") < iPaste, "审批单子、选择器开着的时候整场归它们，粘贴也不抢");
  const pb = hook.slice(iPaste, iTab);
  ok(/if \(pasting\) \{[\s\S]*?paste-end[\s\S]*?takePaste\(pbuf\)[\s\S]*?pbuf \+=[\s\S]*?return;/.test(pb), "★粘的时候按键都进 pbuf，不进 readline★ 里头的回车不是「发出去」", pb.slice(0, 400));
  ok(/k\.ctrl && k\.name === "c"/.test(pb) && /takePaste\(""\)/.test(pb), "粘到一半按 Ctrl+C：那块不要了，Ctrl+C 照常往下走");

  const escBusy = (hook.match(/if \(k\.name === "escape" && inbox\.busy[^\n]*/) || [""])[0];
  ok(/!pendingAsk/.test(escBusy) && /!rl\.line/.test(escBusy) && /!multi\.length/.test(escBusy), "★跑着按 Esc 停这趟，但在等回答、在打字、攒着几行时不抢★", escBusy);
  ok(/stopSoft\(\)/.test(escBusy) && !/stopCurrent|process\.exit/.test(escBusy), "★Esc 走软停，不退出★", escBusy);
  ok(at(escBusy) > i菜, "Esc 排在菜单后面：菜单开着时第一下 Esc 是收菜单");
  const soft = (src.split("stopSoft = () =>")[1] || "").slice(0, 400);
  ok(/ctrl\.abort\(\)/.test(soft) && /按了 Esc/.test(soft) && /Ctrl\+C 强退/.test(soft), "stopSoft 真停这一趟，并告诉人卡住了怎么强退", soft);

  const iNl = at("repl.newlineKey(k"), iRet = at('k.name === "return" && !k.meta'), iLast = hook.lastIndexOf("ttyWriteOrig(ch, key);");
  ok(iNl > i菜 && iRet > iNl && iLast > iRet, "换行键、回车续行都在菜单之后、交给 readline 之前", { iNl, iRet, iLast });
  ok(/nk === "crlf-tail"\) \{ if \(!lastReturn\.ours\) ttyWriteOrig/.test(hook), "★\\r\\n 的尾巴：回车是这边接的就吞掉★ 不吞的话续行/发完会多出一行空的");
  const ret = hook.slice(iRet, iRet + 600);
  ok(/repl\.continuedLine\(rl\.line, rl\.cursor\)/.test(ret) && /holdRow\(cont, cont\)/.test(ret), "行尾 \\ 回车：去掉 \\ 攒起来");
  ok(/if \(multi\.length\) \{ lastReturn\.ours = true; submitComposed\(\); return; \}/.test(ret), "★攒着几行时回车 = 整段发出去★");
  const iD = at('k.ctrl && k.name === "d" && !rl.line && multi.length');
  ok(iD > 0 && iD < iLast && /dropComposed\(\)/.test(hook.slice(iD, iD + 120)), "★攒着几行时 Ctrl+D 只扔这段★ 交给 readline 会当成关掉整个程序");
  ok(/k\.ctrl && k\.name === "r" && !inbox\.busy && !multi\.length\) \{ void searchHistory\(\)/.test(hook), "Ctrl+R 搜历史：跑着、攒着几行时不弹");
  ok(/k\.ctrl && k\.name === "g" && !inbox\.busy\) \{ openEditor\(\)/.test(hook), "Ctrl+G 开编辑器：跑着时不开");

  ok(/const pasteMode = !!ttyWriteOrig && !!process\.stdin\.isTTY && !!process\.stdout\.isTTY;/.test(src), "★装不上按键钩子就不开括号粘贴★ 开了没人拆包，200~ 会原样进输入行");
  ok(/process\.on\("exit", \(\) => \{ try \{ process\.stdout\.write\(PASTE_OFF\); \} catch \{\} \}\)/.test(src), "★退出时关掉括号粘贴★ 不关的话回到 shell 里粘贴会多出 200~");

  const ed = (src.split("function openEditor()")[1] || "").slice(0, 3200);
  ok(/finally \{[\s\S]*?setRawMode\(true\)[\s\S]*?rl\.resume\(\)[\s\S]*?rmSync\(/.test(ed), "★编辑器怎么退出都把终端还回原样、删掉临时文件★", ed.slice(0, 200));
  ok(/mode: 0o600/.test(ed), "临时文件只有自己能读：里头可能是没发出去的需求");
  ok(/loadComposer\(got === null \? cur : got\)/.test(ed), "★编辑器没用上（非零退出、打不开）原来打的字还在★");
  ok(/process\.on\("SIGINT", hush\)/.test(ed), "编辑器里按 Ctrl+C 不会连带把 openworkbuddy 关掉");

  const sig = (src.split('rl.on("SIGINT", () => {')[1] || "").slice(0, 600);
  const iBusy = sig.indexOf("inbox.busy"), iMulti = sig.indexOf("if (multi.length) { dropComposed();"), iLine = sig.indexOf("if (rl.line)");
  ok(iBusy >= 0 && iMulti > iBusy && iLine > iMulti, "★Ctrl+C：跑着先停活儿，攒着几行就扔这段，都不退出★", { iBusy, iMulti, iLine });

  const sub = (src.split("function submitComposed()")[1] || "").slice(0, 700);
  ok(/repl\.historyLine\(text\)/.test(sub) && /inbox\.line\(text\)/.test(sub), "整段进历史压成一行，发出去的是带换行的原样");
  ok(/if \(multi\.length\) reshowHeld\(\);/.test(src), "★跑完回来还攒着几行（跑着时打的）就重印一遍★ 不印的话人看不见自己打过什么");
  ok(/typed: repl\.composeText\(multi, rl\.line\)/.test(src), "Shift+Tab 进计划模式时看的是整段，不只是输入行那一截");

  const mk = (src.split("function makeEmit(")[1] || "").slice(0, 1800);
  ok(/if \(ev\.type === "step_usage"\) return;/.test(mk), "★--json 不多出 step_usage★ 那是终端走字用的，接 json 的脚本不认识");
  // `&& !wfp.st`：workflow 面板开着的时候这两条都闭嘴，屏幕归面板（见 test/workflow-panel.js）
  ok(/const prog = \(s\) => \{ if \(!opts\.quiet && !opts\.json(?: && !wfp\.st)?\) \{ tickSettle\(\);/.test(src) && /const answer = \(s\) => \{ if \(!opts\.json(?: && !wfp\.st)?\) \{ tickSettle\(\);/.test(src), "★往终端写东西之前先把走字那行定格★ 不定格的话下一次重画会把正文盖掉");
  const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
  ok(/if \(depth === 0\) emit\(\{ type: "step_usage"/.test(agentSrc), "只报主线的用量：子任务的另算，混进来数字会跳");
}

console.log("\n【会话花了多少：/status /cost】");
{
  const P = require(path.join(ROOT, "pricing"));
  const costOf = (u) => P.costOf(u, { local: !!u.local });
  const u = (x) => ({ type: "assistant", events: [{ type: "text", delta: "…" }, { type: "usage", ...x }] });
  const tr = [{ type: "user", text: "a" }, u({ model: "deepseek-chat", prompt: 12000, completion: 800, cached: 9000, calls: 3 }), { type: "user", text: "b" }, u({ model: "deepseek-chat", prompt: 5000, completion: 200, calls: 1 })];
  const s = R.sessionUsageText(tr, costOf);
  ok(/一共 18,000 tokens/.test(s) && /输入 17,000/.test(s) && /缓存命中 9,000/.test(s) && /输出 1,000/.test(s) && /4 次调用/.test(s), "★每一轮的用量加起来★", s);
  const want = tr.filter((t) => t.type === "assistant").reduce((n, t) => n + costOf(t.events[1]).yuan, 0);
  ok(want > 0 && s.includes("¥" + (want < 0.01 ? want.toFixed(4) : want.toFixed(2))), "钱数跟价目表逐轮算出来的一致", { s, want });
  const miss = R.sessionUsageText(tr.concat([u({ model: "no-such-model-zz", prompt: 10, completion: 10, calls: 1 })]), costOf);
  ok(/1 轮的模型查不到价/.test(miss) && !/¥/.test(miss), "★有一轮查不到价就不报钱数★ 少算一截的「约 ¥」比不报更误导", miss);
  const local = R.sessionUsageText([u({ model: "本机 Claude Code", local: true, prompt: 500, completion: 5, calls: 1 })], costOf);
  ok(/505 tokens/.test(local) && !/查不到价/.test(local) && !/¥/.test(local), "本机引擎：报 token、不报钱、也不说查不到价", local);
  eq(R.sessionUsageText([{ type: "user", text: "x" }], costOf), "这个会话还没花过 token", "还没跑过：直说");
  eq(R.sessionUsageText(null, costOf), "这个会话还没花过 token", "没有记录也不崩");
  ok(tag("/cost") === "cmd:status" && tag("/usage") === "cmd:status", "/cost /usage 都落到 /status", [tag("/cost"), tag("/usage")]);
  ok(/\/cost/.test(R.helpText()), "/help 里写着能敲 /cost");
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  const blk = src.slice(src.indexOf('if (v.name === "status")'), src.indexOf('if (v.name === "cd")'));
  ok(/repl\.sessionUsageText\(sess\.transcript/.test(blk) && /local: !!u\.local/.test(blk), "/status 真把这一行打出来，本机引擎按不花钱算", blk.slice(0, 300));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
