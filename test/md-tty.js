"use strict";
/**
 * 终端里的 Markdown 渲染。
 *
 * 起因是用户在 `wb` 里看到的那一屏：
 *   「- **查资料** — 行业调研…  怎么cli里面还有**这种啊」
 * 模型的回答本来就是 Markdown，网页那边翻成 HTML，终端这边一直原样打印，
 * 于是星号、井号、方括号全糊在脸上。
 *
 * 这一套要挡的是四类事故，每一类都**不报错**，只是难看或者更糟——把人的原文改坏了：
 *   1. 记号裸奔：`**加粗**` 打成四个星号；
 *   2. 矫枉过正：`2 * 3`、`snake_case`、`` `a ** b` `` 这些本来就是字面量的，被当记号翻掉；
 *   3. 流式切坏：正文是一小片一小片来的，半个 `**` 先吐出去就再也收不回来（终端不能重绘）；
 *   4. 管道里掺转义：`wb "…" > 答案.md`、`wb … | pbcopy` 必须拿到原始 Markdown。
 *
 * 所以每节都配反向对照：不然「渲染对了」和「什么都没做」在测试里长得一模一样。
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const M = require(path.join(ROOT, "md-tty"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }

/** 一次性渲染一段（不带色，好拿字符串直接对） */
function plain(md) {
  const r = M.createRenderer({ color: false });
  return r.write(md) + r.end();
}
/** 带色渲染，用来看转义序列有没有加对 */
function colored(md) {
  const r = M.createRenderer({ color: true });
  return r.write(md) + r.end();
}
/** 按 n 个字符一刀切片喂进去——模拟流式 */
function streamed(md, n, color) {
  const r = M.createRenderer({ color: !!color });
  let out = "";
  for (let i = 0; i < md.length; i += n) out += r.write(md.slice(i, i + n));
  return out + r.end();
}

const ESC = "\u001b";

console.log("\n【1】裸露的记号不许打到终端上");
{
  const got = plain("- **查资料** — 行业调研、竞品对比\n");
  ok(!got.includes("**"), "★星号不再糊在脸上★ 用户原话：「怎么cli里面还有**这种啊」", got);
  ok(got.includes("查资料") && got.includes("行业调研、竞品对比"), "字还是那些字，一个没少", got);
  // 反向对照：不过渲染器的原文里，星号本来就在。没有这一条的话，
  // 「渲染对了」和「输入里压根没有星号」在测试里分不开
  ok("- **查资料** — 行业调研\n".includes("**"), "反向对照：原文里确实有 ** —— 上面那条不是因为输入就干净");

  eq(plain("# 标题\n").trim(), "标题", "标题只留字，井号去掉");
  eq(plain("## 二级\n").trim(), "二级", "二级标题同理");
  eq(plain("### 三级\n").trim(), "三级", "三级标题同理");
  ok(!/[#>]/.test(plain("# 标题\n> 引用\n")), "标题的 # 和引用的 > 都不该出现在正文里", plain("# 标题\n> 引用\n"));
  ok(plain("~~删掉~~\n").trim() === "删掉", "删除线的波浪号去掉");
  ok(plain("*斜的*\n").trim() === "斜的", "单星号的斜体也要去掉");
  ok(plain("__也是粗的__\n").trim() === "也是粗的", "下划线写法的粗体同样处理");
}

console.log("\n【2】本来就是字面量的，一个字都不许动");
{
  const cases = [
    ["2 * 3 = 6", "乘号两边有空格 —— 这是算式不是斜体"],
    ["snake_case 和 __dunder__ 混在词里", "词中间的下划线不是斜体（变量名最常中招）"],
    ["a_b_c 这种写法", "下划线连着字母也不算记号"],
    ["价格 5*8 元", "数字之间的星号"],
  ];
  for (const [src, why] of cases) {
    const got = plain(src + "\n").replace(/\n$/, "");
    // __dunder__ 这条例外：它两侧真的是空白，按 Markdown 就是粗体，翻掉是对的
    const want = src === "snake_case 和 __dunder__ 混在词里" ? "snake_case 和 dunder 混在词里" : src;
    eq(got, want, why);
  }
  const code = plain("跑 `npm test --  ** --` 看看\n").replace(/\n$/, "");
  ok(code.includes("npm test --  ** --"), "★行内代码里的星号原样留着★ 人在代码里打的星号就是星号", code);
  const fence = plain("```js\nconst a = x ** 2; // **注意**\n```\n");
  ok(fence.includes("x ** 2") && fence.includes("**注意**"), "★代码块里一个记号都不翻★ 翻了就是把人的代码改错了", fence);
  ok(plain("\\*不是斜体\\*\n").replace(/\n$/, "") === "*不是斜体*", "反斜杠转义的星号，还原成裸星号");
  // 反向对照：同样这几个字，不带反斜杠时就该被当成记号翻掉
  ok(plain("*不是斜体*\n").replace(/\n$/, "") === "不是斜体", "反向对照：去掉反斜杠，它就真的是斜体了");
}

console.log("\n【3】占位符不许泄漏给用户");
{
  // 内部拿 NUL 包边的占位符腾挪代码段，正文里恰好写了 C0 / E1 也不能被吃掉
  const got = plain("C0 和 E1 是板子上的丝印，`C0` 那颗电容\n");
  ok(got.includes("C0 和 E1 是板子上的丝印"), "★正文里的 C0 / E1 原样留着★ 占位符长得像正文就是一起事故", got);
  ok(!got.includes("\u0000"), "占位符本身不许漏到输出里", JSON.stringify(got));
  ok(!plain("a\\`b\\*c\n").includes("\u0000"), "转义占位符同样不许漏出去");
}

console.log("\n【4】流式：切成几片喂进去，结果必须跟一次性喂一样");
{
  const doc = [
    "# 周报",
    "",
    "本周做了 **三件事**：",
    "",
    "1. 把 `wb` 的输出[改成了终端能看的样子](https://example.com/pr/42)",
    "2. 修了 *一个* 老 bug",
    "3. 写了 ~~一堆~~ 几行测试",
    "",
    "> 下周继续。2 * 3 = 6，snake_case 不动。",
    "",
    "| 项 | 状态 |",
    "| --- | --- |",
    "| 渲染 | 好了 |",
    "",
    "```sh",
    "npm test  # **不翻译**",
    "```",
    "",
  ].join("\n");
  const once = plain(doc);
  for (const n of [1, 2, 3, 5, 7, 13, 64]) {
    eq(streamed(doc, n, false), once, `切成每片 ${n} 个字，结果跟一次性喂的一模一样`);
  }
  eq(streamed(doc, 3, true), colored(doc), "带色的时候也一样（转义序列不能因为切片就多一段或少一段）");
  const prose = once.split("│ sh")[0]; // 代码块里的 ** 本来就该原样留着，别把它算成漏网
  ok(!prose.includes("**") && !prose.includes("~~"), "整篇渲染完没有漏网的记号", prose.slice(0, 120));
  ok(once.includes("npm test  # **不翻译**"), "代码块里的记号在流式下同样原样留着");
}

console.log("\n【5】半行没闭合就压住，宁可晚一点也不许吐错");
{
  const r = M.createRenderer({ color: false });
  const a = r.write("这是 **加粗");
  ok(!a.includes("加粗"), "★等不到配对的 ** 就先别吐★ 吐出去就收不回来了（终端不能重绘已经滚过去的字）", a);
  ok(!a.includes("**"), "更不许把半个记号吐出去", a);
  const b = r.write("的词** 收工\n");
  ok((a + b).includes("加粗的词") && !(a + b).includes("**"), "下一片来了，整句一起渲染出来", a + b);

  const r2 = M.createRenderer({ color: false });
  const c = r2.write("先说一句正常的话，");
  ok(c.includes("先说一句正常的话"), "★没有未闭合记号的那截要当场吐★ 不然就成了「想了二十秒什么都没有，然后唰地全出来」", c);

  // safeCut 自己的账：未闭合时必须比整行短，闭合了才让吐完
  ok(M.safeCut("好的 **粗") < "好的 **粗".length, "safeCut：未闭合的 ** 之后一律不许吐");
  eq(M.safeCut("好的 **粗体** 完事"), "好的 **粗体** 完事".length, "反向对照：配平了就整行放行");
  ok(M.safeCut("看这个 `代码") < "看这个 `代码".length, "未闭合的反引号同理");
  ok(M.safeCut("点[这里") < "点[这里".length, "只有 [ 还没等到 ](…)，也压住");
  eq(M.safeCut("点[这里](http://a.b) 看"), "点[这里](http://a.b) 看".length, "反向对照：链接写全了就放行");
  ok(M.safeCut("行尾一个反斜杠\\") < "行尾一个反斜杠\\".length, "行尾孤零零一个反斜杠：下一片可能是被它转义的字符");
  // 未闭合的记号在 end() 时必须补吐出来，不能吞掉用户的字
  const r3 = M.createRenderer({ color: false });
  const tail = r3.write("没写完的 **粗") + r3.end();
  ok(tail.includes("没写完的") && tail.includes("粗"), "★流断在半截也要把字吐干净★ 压住是为了晚点吐，不是为了吞掉", tail);
}

console.log("\n【6】块级：列表、待办、引用、表格、分隔线");
{
  ok(/^•\s/.test(plain("- 一项\n")), "无序列表换成圆点", plain("- 一项\n"));
  ok(/^1\.\s/.test(plain("1. 第一\n")), "有序列表保留序号", plain("1. 第一\n"));
  ok(plain("  - 二层\n").includes("◦"), "缩进一层的列表换个记号，好分层", plain("  - 二层\n"));
  ok(plain("- [ ] 没做\n").includes("□") && plain("- [x] 做完\n").includes("■"), "待办用空心/实心方块");
  ok(!plain("- [x] 做完\n").includes("[x]"), "反向对照：方括号那套记号不该还留着");
  ok(plain("> 引用一句\n").includes("│"), "引用块用竖线顶头", plain("> 引用一句\n"));
  ok(/^─+$/.test(plain("---\n").trim()), "分隔线画成一道细线", plain("---\n"));
  const tb = plain("| 项 | 状态 |\n| --- | --- |\n| 渲染 | 好了 |\n");
  ok(!tb.includes("---"), "表格的分隔行不该原样打出来", tb);
  ok(tb.includes("项") && tb.includes("好了"), "表格里的字都还在", tb);
  const link = plain("看[这个页面](https://example.com/a)\n");
  ok(link.includes("这个页面") && link.includes("https://example.com/a"), "链接的文字和地址都要留着——终端里地址才是能点能复制的那个", link);
  ok(!link.includes("](") , "反向对照：Markdown 的链接记号不该还在", link);
}

console.log("\n【7】颜色：该加的时候加，不该加的时候一个转义都不许有");
{
  ok(!plain("**粗**\n").includes(ESC), "★color:false 时输出里不许有任何转义序列★ 重定向到文件、喂给别的程序都靠它", JSON.stringify(plain("**粗**\n")));
  const c = colored("**粗**\n");
  ok(c.includes(ESC + "[1m") && c.includes(ESC + "[22m"), "带色时粗体前后各有一段转义", JSON.stringify(c));
  ok(!c.includes(ESC + "[0m"), "★关样式用精确的关码，不用 0m 全清★ 0m 会把外层（比如引用块的灰）一起抹掉", JSON.stringify(c));
  const q = colored("> 引用 **粗** 完\n");
  ok(!q.includes(ESC + "[0m"), "引用块里更明显：粗体收尾时把引用的灰一起清掉，后面半句就变色了", JSON.stringify(q));
}

console.log("\n【8】接进 wb：只在「那头真是终端」时渲染");
{
  const src = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
  const line = (src.split("\n").find((l) => l.startsWith("const renderMd =")) || "");
  ok(line, "cli.js 里有一处统一的开关，而不是散在各处判断");
  ok(line.includes("process.stdout.isTTY"),
     "★不是终端就不渲染★ `wb \"…\" > 答案.md`、`wb … | pbcopy` 要的是原始 Markdown——那才是能接着加工的东西", line);
  ok(line.includes("!opts.json"), "--json 走事件流，不归渲染管", line);
  ok(line.includes("!opts.raw"), "留一条 --raw：人明说了别动就别动", line);
  ok(/state\.finalParts\.push\(text\)/.test(src),
     "★存盘和收尾判断读的是原文★ 存渲染结果的话，会话文件里全是转义序列，下次续接喂给模型的也是它");
  ok(/answer\(state\.md \? state\.md\.write\(text\) : text\)/.test(src), "渲染只加在「打到屏幕上」这一步");
  ok(/answer\(state\.md\.end\(\)\)/.test(src),
     "★收尾要把渲染器里压着的半行吐干净★ 不吐的话，最后一句没配平记号的话会整句消失");
  const A = require(path.join(ROOT, "cli-args"));
  ok(A.parse(["--raw", "问题"]).opts.raw === true, "wb --raw 能解析出来");
  ok(A.parse(["问题"]).opts.raw === false, "反向对照：不写 --raw 时默认是关的（默认要渲染）");
  ok(A.helpText().includes("--raw"), "帮助里写着这条路");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
