"use strict";
/**
 * 终端里带文件进来：拖进来的路径、@ 补全、剪贴板。
 *
 * 用户原话：「还有我的wb cli也要支持复制文件 图片这些啊」。
 *
 * 这一套要挡的是三类事故，三类都不报错、只是悄悄办错事：
 *
 *   1. **该认的没认出来。** 从访达把文件拖进终端，粘出来的是 `/w/图\ 1.png`（空格被反斜杠
 *      转义了）；用「拷贝路径」粘出来的却是 `/w/图 1.png`（没转义，按词切会切成两截）。
 *      同一个文件两种写法，认错一种，人就只会得到一句「我没看到文件」。
 *   2. **不该认的乱认。** 「帮我写周报」里的「周报」不是路径，「这句话里提到 ./nope.png」
 *      里的那个也不该去撞文件名。一旦乱认，人的正文会被啃掉一块，而他看不出来。
 *   3. **文件进了对话历史。** 图片进历史意味着往后每一步都重发一遍，纯文本模型直接 400；
 *      而会话是存盘的，那就等于把这个会话永久弄坏了。带文件的唯一正确做法是「给个名字，
 *      让模型自己去看」——跟网页端共用同一句标记，一个字节都不能差。
 *
 * 所以每一节都配反向对照：「没认出来」和「认成了别的」在测试里长得一模一样，不摆一条
 * 反着的用例，判据失效了也看不出来。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const A = require(path.join(ROOT, "cli-attach"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra) : ""}`); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}

const CLI_SRC = fs.readFileSync(path.join(ROOT, "cli.js"), "utf8");
const ATTACH_SRC = fs.readFileSync(path.join(ROOT, "cli-attach.js"), "utf8");

// 一张假盘：路径在这张表里就算存在。二十几种写法能逐个对，不用真往盘上摆文件
const DISK = new Set([
  "/w/a.png", "/w/b.csv", "/w/图 1.png", "/w/报告.md", "/w/子目录/c.txt",
  "/home/me/b.png", "/home/me/桌面/截图.png",
]);
const OPT = { home: "/home/me", roots: ["/w"], exists: (x) => DISK.has(x) };
const P = (line) => A.parseLine(line, OPT);

// ── ① 拖进来的路径：三种写法都得认出是同一个文件 ──────────────────────────
console.log("\n① 同一个文件，三种粘法，都得认出来");
{
  const 拖进来 = P("/w/图\\ 1.png 这张图里写了什么");
  eq(拖进来.files.map((f) => f.path), ["/w/图 1.png"], "★拖进终端的反斜杠转义路径★ 访达拖进来就长这样");
  eq(拖进来.text, "这张图里写了什么", "文件摘走了，剩下的才是要问的话");

  const 拷贝路径 = P("/w/图 1.png");
  eq(拷贝路径.files.map((f) => f.path), ["/w/图 1.png"],
    "★「拷贝路径」粘出来的空格没转义★ 只有整行当一条路径试一次才认得出，按词切会切成两截");
  eq(拷贝路径.text, "", "整行就是一条路径时，正文是空的");

  eq(P("'/w/图 1.png' 看看").files.map((f) => f.path), ["/w/图 1.png"], "单引号裹起来的也认");
  eq(P("\"/w/图 1.png\" 看看").files.map((f) => f.path), ["/w/图 1.png"], "双引号裹起来的也认");
  eq(P("file:///w/%E5%9B%BE%201.png 看看").files.map((f) => f.path), ["/w/图 1.png"],
    "file:// 开头的 URL 也认（有些终端和浏览器拖出来的是这个）");
  eq(P("~/b.png 这是什么").files.map((f) => f.path), ["/home/me/b.png"], "~ 展开成家目录");
  eq(P("@报告.md 帮我改改").files.map((f) => f.path), ["/w/报告.md"], "@ 后面的相对路径按工作目录找");
  eq(P("@子目录/c.txt 读一下").files.map((f) => f.path), ["/w/子目录/c.txt"], "@ 后面带子目录也行");

  const 两个 = P("/w/a.png 和 /w/b.csv 一起看");
  eq(两个.files.map((f) => f.path), ["/w/a.png", "/w/b.csv"], "一行里两个文件都摘得出来");
  eq(两个.text, "和 一起看", "两个都摘走，正文按位置剪，不是整行重拼");

  eq(P("/w/a.png /w/a.png 看两遍").files.length, 1, "同一个文件写两遍只算一个");
}

// ── ② 反向对照：不是路径的词，一个都不许动 ───────────────────────────────
console.log("\n② 不是路径的词一个都不许动（正文被啃掉一块，人是看不出来的）");
{
  eq(P("写周报").text, "写周报", "普通一句话原样留着");
  eq(P("写周报").files.length, 0, "普通一句话里没有文件");
  eq(P("a.png 和 b.csv 一起看").files.length, 0,
    "★光秃秃一个文件名不算路径★ 不然「周报」这种词也会被拿去撞文件名，撞上了就成了莫名其妙的附件");
  eq(P("a.png 和 b.csv 一起看").text, "a.png 和 b.csv 一起看", "没认出文件时正文一个字不动");
  eq(P("这句话里提到 ./nope.png 但盘上没有").files.length, 0, "长得像路径但盘上没有：不认");
  eq(P("这句话里提到 ./nope.png 但盘上没有").text, "这句话里提到 ./nope.png 但盘上没有", "不认的时候正文原样留着");

  const 缺 = P("@不存在.md 看看");
  eq(缺.files.length, 0, "@ 指的文件找不到：不算带进来了");
  eq(缺.missing, ["@不存在.md"], "★找不到要吭一声★ 人明说了要带这个文件，静悄悄当普通字发走等于骗他");
  eq(缺.text, "@不存在.md 看看", "找不到的 @ 词留在正文里，别把人的话啃掉");

  // 反向对照：判据本身得会判红
  let 红 = false;
  try { eq0(); } catch { 红 = true; }
  function eq0() { if (JSON.stringify(P("写周报").files) !== "[]") throw new Error("x"); }
  ok(!红, "（自检）普通句子确实没有文件");
  ok(P("/w/报告.md 看看").files.length === 1 && P("报告.md 看看").files.length === 0,
    "★同一个文件：写全路径认、光写名字不认★ 两条摆一块儿才说明规则是「像不像路径」而不是「碰不碰得上」");
}

// ── ③ 正在打的那个 @词 ───────────────────────────────────────────────────
console.log("\n③ @ 补全：正在打的是哪个词");
{
  eq(A.atToken("看看 @报"), { at: 3, prefix: "报" }, "光标停在 @报 后面：认出前缀是「报」");
  eq(A.atToken("看看 @我的\\ 文"), { at: 3, prefix: "我的 文" }, "★转义空格要还原成真空格★ 不然名字里带空格的文件永远补不出来");
  eq(A.atToken("@"), { at: 0, prefix: "" }, "只打了个 @：前缀是空的，该把整个目录列出来");
  eq(A.atToken("看看 @报 "), null, "后面跟了空格：这个词打完了，菜单该收掉");
  eq(A.atToken("看看"), null, "没有 @：不是在补路径");
  eq(A.atToken(""), null, "空行不弹");
  eq(A.atToken("看 @a 再看 @b"), { at: 8, prefix: "b" }, "两个 @：认最后那个（光标在那儿）");
}

// ── ④ 名字里的转义：补出来的，得跟拖进来的长一个样 ────────────────────────
console.log("\n④ 补出来的路径要跟拖进来的长一个样");
{
  eq(A.escPath("图 1.png"), "图\\ 1.png", "★空格转义★ 补出来的路径 parseLine 得认得，不然补完反而带不进去");
  eq(A.escPath("a(b).png"), "a\\(b\\).png", "括号也转义");
  eq(A.escPath("子目录/a.png"), "子目录/a.png", "斜杠不转义——它是路径分隔符，转了就不是同一个路径了");
  eq(A.parseLine("@" + A.escPath("图 1.png") + " 看看", { ...OPT, roots: ["/w"] }).files.map((f) => f.path),
    ["/w/图 1.png"], "★补出来的原样发回去，parseLine 认得★ 这一条断了，@ 补全就是个摆设");
  eq(A.expandHome("~/x", "/home/me"), "/home/me/x", "~ 展开");
  eq(A.expandHome("~别人/x", "/home/me"), "~别人/x", "~ 后面不是斜杠就不是家目录，别乱展开");
  eq(A.pathLike("周报"), false, "光秃秃一个词不算路径");
  eq(A.pathLike("./a"), true, "./ 开头算");
  eq(A.pathLike("C:\\tmp\\a.png"), true, "Windows 盘符也算");
}

// ── ⑤ 搬进工作目录 ───────────────────────────────────────────────────────
console.log("\n⑤ 搬进工作目录：重名不覆盖、已经在里面的不搬第二份");
function fakeFs(table) {
  const copied = [];
  return {
    copied, table,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(table, p),
    statSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(table, p)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      const v = table[p];
      return { isDirectory: () => v === "dir", size: v === "dir" ? 0 : v };
    },
    copyFileSync: (a, b) => { copied.push([a, b]); table[b] = table[a]; },
  };
}
{
  const f1 = fakeFs({ "/src/a.png": 100 });
  const r1 = A.collect([{ ref: "a.png", path: "/src/a.png" }], { workspaceDir: "/w", fs: f1 });
  eq(r1.names, ["a.png"], "搬进去了，名字给模型");
  eq(f1.copied, [["/src/a.png", "/w/a.png"]], "真的复制了一份到工作目录");

  const f2 = fakeFs({ "/src/a.png": 100, "/w/a.png": 7 });
  const r2 = A.collect([{ ref: "a.png", path: "/src/a.png" }], { workspaceDir: "/w", fs: f2 });
  eq(r2.names, ["a-2.png"], "★重名不覆盖★ 覆盖掉的那份可能正是上一轮的产出");

  const f3 = fakeFs({ "/w/子目录/x.png": 100 });
  const r3 = A.collect([{ ref: "x", path: "/w/子目录/x.png" }], { workspaceDir: "/w", fs: f3 });
  eq(r3.names, ["子目录/x.png"], "本来就在工作目录里：给相对路径");
  eq(f3.copied, [], "★已经在里面的不再复制一份★ 不然文件面板里同一个文件出现两遍");

  const f4 = fakeFs({ "/src/d": "dir" });
  const r4 = A.collect([{ ref: "d", path: "/src/d" }], { workspaceDir: "/w", fs: f4 });
  eq(r4.names, [], "目录不当文件搬");
  ok(/目录/.test((r4.skipped[0] || {}).why || ""), "并且说清楚为什么", r4.skipped);

  const f5 = fakeFs({ "/src/big.bin": A.MAX_BYTES + 1 });
  const r5 = A.collect([{ ref: "big", path: "/src/big.bin" }], { workspaceDir: "/w", fs: f5 });
  eq(r5.names, [], "超大的不搬");
  ok(/MB/.test((r5.skipped[0] || {}).why || ""), "并且把尺寸说出来，别只说「失败」", r5.skipped);
  const f5b = fakeFs({ "/src/big.bin": A.MAX_BYTES });
  eq(A.collect([{ ref: "big", path: "/src/big.bin" }], { workspaceDir: "/w", fs: f5b }).names, ["big.bin"],
    "反向对照：正好卡在上限上的要搬得进去（不然阈值判反了也看不出来）");

  const f6 = fakeFs({});
  const r6 = A.collect([{ ref: "没了", path: "/src/gone.png" }], { workspaceDir: "/w", fs: f6 });
  eq(r6.names, [], "刚才还在、现在没了：不搬");
  ok(r6.skipped.length === 1, "并且报出来", r6.skipped);

  const f7 = fakeFs({ "/src/a.png": 1 });
  eq(A.collect([{ ref: "a", path: "/src/a.png" }, { ref: "a", path: "/src/a.png" }], { workspaceDir: "/w", fs: f7 }).names,
    ["a.png"], "★同一个文件给两遍只搬一次★ 剪贴板里重复的条目不该在工作目录里变成 a.png 和 a-2.png");

  eq(A.cleanName("../../etc/passwd"), "passwd", "★名字里的路径分隔符洗掉★ 带进来的名字不该能往工作目录外面写");
  eq(A.cleanName("a\u0007b.png"), "ab.png", "控制字符洗掉——文件名里它没有正当用途");
  eq(A.cleanName(""), "文件", "洗完空了给个兜底名字");
  ok(/^粘贴图_\d{4}_\d{6}\.png$/.test(A.stampName("粘贴图", "png", new Date(2026, 8, 13, 14, 25, 30))),
    "时间戳名字跟网页端一个格式", A.stampName("粘贴图", "png", new Date(2026, 8, 13, 14, 25, 30)));
  eq(A.stampName("粘贴图", "png", new Date(2026, 8, 13, 14, 25, 30)), "粘贴图_0913_142530.png", "逐字对一遍");
}

// ── ⑥ 挂给模型的那句标记：跟网页端一个字节都不能差 ────────────────────────
console.log("\n⑥ 「（已上传文件：…）」跟网页端一个字节都不能差");
{
  eq(A.note(["a.png", "b.csv"]), "（已上传文件：a.png、b.csv）", "★标记原文★ agent.js 规范 3.1 认的就是这一句");
  eq(A.note([]), "", "没文件就不挂标记");
  eq(A.withNote("看看", ["a.png"]), "看看\n（已上传文件：a.png）", "正文在上、标记在下，中间一个换行");
  eq(A.withNote("", ["a.png"]), "（已上传文件：a.png）", "只有文件没正文时只剩标记");
  eq(A.withNote("看看", []), "看看", "只有正文时一个字都不加");

  // 网页端两头：app-02.js 拼出来的、app-01.js 解回去的，必须跟这儿是同一句
  const web02 = fs.readFileSync(path.join(ROOT, "public", "js", "app-02.js"), "utf8");
  ok(web02.includes("`（已上传文件：${pendingAttach.join(\"、\")}）`"),
    "★网页端拼标记的那行还在★ 它改了这儿也得跟着改，不然两头对不上", "app-02.js");
  const web01 = fs.readFileSync(path.join(ROOT, "public", "js", "app-01.js"), "utf8");
  const m = web01.match(/\/（已上传文件：\(\[\^）\]\+\)）\/g/);
  ok(!!m, "★网页端解标记的那个正则还在★", "app-01.js");
  const re = /（已上传文件：([^）]+)）/g;
  const hit = re.exec(A.note(["图 1.png", "b.csv"]));
  eq(hit && hit[1].split("、"), ["图 1.png", "b.csv"],
    "★CLI 挂的标记，网页历史里要能还原成两个附件名★ 终端发的会话在网页上打开就靠这一条");

  // 注释里提这句话是应该的（那儿解释的正是这套协议），代码里再拼一遍才是事故
  const cliCode = CLI_SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ok(!/已上传文件/.test(cliCode),
    "★cli.js 的代码里不许再自己拼一遍这句话★ 两处各写一份，改一处漏一处，终端发的会话在网页上就成了裸文字",
    (cliCode.match(/.*已上传文件.*/) || [])[0]);
  ok(A.anyImage(["a.png"]) && A.anyImage(["b.JPG"]) && !A.anyImage(["c.csv"]), "认得出哪些名字是图片");
}

// ── ⑦ 剪贴板：先认文件、再认位图、最后才认文字 ───────────────────────────
console.log("\n⑦ 剪贴板：文件 > 位图 > 文字，顺序不能反");
{
  const mac = A.clipboardPlan("darwin", "/w/粘贴图.png");
  eq(mac.map((s) => s.kind), ["files", "image", "text"],
    "★顺序★ 在访达里 Cmd+C 一个图片文件，剪贴板里文件和位图同时在；先认位图就成了重新编码、名字是时间戳的 PNG");
  ok(mac[1].writesFile === true, "★位图那步自己写文件★ 二进制从 stdout 捞回来会被当文本糟蹋掉");
  ok(mac[1].args.join(" ").includes("/w/粘贴图.png"), "位图那步知道该写到哪儿");
  eq(A.clipboardPlan("win32", "/w/x.png").map((s) => s.kind), ["files", "image", "text"], "Windows 上同一个顺序");
  eq(A.clipboardPlan("linux", "/w/x.png").map((s) => s.kind), ["files", "files", "image", "image", "text", "text"],
    "Linux 上 Wayland 和 X11 各试一遍，谁先成算谁的");
  eq(A.clipboardPlan("aix", "/w/x.png"), [], "没见过的系统：一条命令都不编");
  eq(A.readClipboard({ platform: "aix", dest: "/w/x.png", run: () => { throw new Error("不该跑"); } }).kind,
    "unsupported", "★不支持就明说★ 不许装成「剪贴板是空的」——两句话该让人做的事完全不一样");

  // 那段 AppleScript 是真会跑的代码，不是字符串常量。两条实测过的坑各来一个闸：
  //   ① 只复制了一个文件时，拿回来的是单个文件引用而不是列表，直接 repeat 会去问它 count，
  //      当场 -1708。而「在访达里 Cmd+C 一张截图」正是最常走的那条路。
  //   ② 剪贴板里是纯文字时，as «class furl» 会把那段文字硬掰成文件路径（实测掰出过
  //      "Macintosh HD:or"），不先问「有没有文件这个口味」就会把人的一段文字当成附件。
  // 下面不读真剪贴板：把取剪贴板那一句换成写死的值再跑，结果是确定的。
  ok(/clipboard info for/.test(mac[0].args[1]), "★先问有没有「文件」这个口味★ 不问的话纯文字会被掰成一个假路径");
  ok(/class of cb is not list/.test(mac[0].args[1]), "★单个文件也要能当列表走★ 只 Cmd+C 了一个文件是最常见的情况");
  if (process.platform === "darwin") {
    const { spawnSync } = require("child_process");
    const runAs = (script) => {
      const r = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
      return { status: r.status, out: String(r.stdout || "").trim(), err: String(r.stderr || "") };
    };
    const stub = (src, value) => src
      .replace("if (count of (clipboard info for «class furl»)) > 0 then", "if true then")
      .replace("set cb to (the clipboard as «class furl»)", `set cb to ${value}`);
    const one = runAs(stub(mac[0].args[1], '(POSIX file "/etc/hosts")'));
    eq([one.status, one.out], [0, "/etc/hosts"],
      "★只复制一个文件时这段脚本得跑得通★ 老写法在这儿会 -1708，而这正是最常走的那条路：" + one.err.slice(0, 160));
    const many = runAs(stub(mac[0].args[1], '{(POSIX file "/etc/hosts"), (POSIX file "/etc/passwd")}'));
    eq([many.status, many.out.split("\n")], [0, ["/etc/hosts", "/etc/passwd"]],
      "复制一堆文件时一个都不能漏：" + many.err.slice(0, 160));
    // 反向对照：去掉那句 list 判断（就是踩坑的老写法），同一条判据必须判红
    const old = runAs(stub(mac[0].args[1], '(POSIX file "/etc/hosts")').replace("if class of cb is not list then set cb to {cb}", ""));
    ok(old.status !== 0, "★闸门反向对照★ 老写法在这儿居然没报错，说明这条判据白设了", old);
  } else {
    console.log("  · （非 macOS，跳过 AppleScript 实跑）");
  }
}

// ── ⑧ 剪贴板真去读一次：谁先中算谁的，没中的要擦干净 ──────────────────────
console.log("\n⑧ 读剪贴板：谁先中算谁的，半成品要擦干净");
function runner(map) {
  const calls = [];
  return {
    calls,
    run: (cmd, args, step) => {
      calls.push(cmd + ":" + (step ? step.kind : ""));
      const key = (step ? step.kind : "") + ":" + cmd;
      const v = map[key];
      if (!v) return { status: 1, stdout: Buffer.from("") };
      return v;
    },
  };
}
{
  // 文件和位图同时在：必须拿文件
  const r1 = runner({
    "files:osascript": { status: 0, stdout: Buffer.from("/src/a.png\n/src/b.png\n") },
    "image:osascript": { status: 0, stdout: Buffer.from("") },
  });
  const fs1 = fakeFs({ "/src/a.png": 1, "/src/b.png": 1, "/w/粘贴图.png": 9 });
  const got1 = A.readClipboard({ platform: "darwin", dest: "/w/粘贴图.png", fs: fs1, run: r1.run });
  eq(got1, { kind: "files", paths: ["/src/a.png", "/src/b.png"] },
    "★文件和位图都在时拿的是文件★ 拿到的是原图：原分辨率、原格式、原文件名");
  eq(r1.calls, ["osascript:files"], "拿到文件就不再往下试了");

  // 没有文件、有位图
  const r2 = runner({ "image:osascript": { status: 0, stdout: Buffer.from("") } });
  const fs2 = fakeFs({ "/w/粘贴图.png": 1234 });
  eq(A.readClipboard({ platform: "darwin", dest: "/w/粘贴图.png", fs: fs2, run: r2.run }),
    { kind: "image", file: "/w/粘贴图.png" }, "只有截图时拿截图");

  // 位图那步失败：AppleScript 的 open for access 会先把空文件建出来，得擦掉
  const unlinked = [];
  const fs3 = fakeFs({ "/w/粘贴图.png": 0 });
  fs3.unlinkSync = (p) => { unlinked.push(p); delete fs3.table[p]; };
  const r3 = runner({ "text:pbpaste": { status: 0, stdout: Buffer.from("一段文字") } });
  eq(A.readClipboard({ platform: "darwin", dest: "/w/粘贴图.png", fs: fs3, run: r3.run }),
    { kind: "text", text: "一段文字" }, "位图那步没中就往下走到文字");
  eq(unlinked, ["/w/粘贴图.png"],
    "★没中的那步留下的空文件要擦掉★ 不擦的话工作目录里会多出一个 0 字节的 粘贴图_xxx.png");

  // 位图那步「成功」了但文件是 0 字节：一样不算数
  const fs4 = fakeFs({ "/w/粘贴图.png": 0 });
  const unl4 = [];
  fs4.unlinkSync = (p) => { unl4.push(p); delete fs4.table[p]; };
  const r4 = runner({ "image:osascript": { status: 0, stdout: Buffer.from("") } });
  eq(A.readClipboard({ platform: "darwin", dest: "/w/粘贴图.png", fs: fs4, run: r4.run }).kind, "empty",
    "★写出来是 0 字节就不算截图★ 不然模型会对着一个空文件说「我看不出来」");
  eq(unl4, ["/w/粘贴图.png"], "0 字节那份也擦掉");

  // 什么都没有
  const r5 = runner({});
  eq(A.readClipboard({ platform: "darwin", dest: "/w/x.png", fs: fakeFs({}), run: r5.run }).kind, "empty",
    "剪贴板空的时候说空的");
  eq(r5.calls, ["osascript:files", "osascript:image", "pbpaste:text"], "三样都试过了才说空");

  // 命令根本起不来（没装 xclip 之类）不该把整个 /paste 炸掉
  const r6 = { run: () => { throw new Error("spawn ENOENT"); } };
  eq(A.readClipboard({ platform: "linux", dest: "/w/x.png", fs: fakeFs({}), run: r6.run }).kind, "empty",
    "命令起不来只当这一路没中，不抛");

  // 文件列表里指向的文件已经不在了：不许把不存在的路径当附件报上去
  const r7 = runner({ "files:osascript": { status: 0, stdout: Buffer.from("/src/gone.png\n") } });
  eq(A.readClipboard({ platform: "darwin", dest: "/w/x.png", fs: fakeFs({}), run: r7.run }).kind, "empty",
    "剪贴板里的文件已经被删了：当没有，别报一个不存在的名字");
}

// ── ⑨ cli.js 的接线 ──────────────────────────────────────────────────────
console.log("\n⑨ cli.js 接线：顺序和边界");
{
  const has = (re, name, why) => ok(re.test(CLI_SRC), name, why);
  has(/require\("\.\/cli-attach"\)/, "cli.js 引了 cli-attach");
  has(/roots: \[getWorkspaceDir\(\), process\.cwd\(\)\]/, "相对路径先按工作目录找，再按人现在所在的目录找");

  const iWanted = CLI_SRC.indexOf("const wanted = namedFiles.concat(shot.files);");
  const iPipe = CLI_SRC.indexOf("const piped = await readStdin();");
  ok(iWanted > 0 && iPipe > 0 && iWanted < iPipe,
    "★摘文件必须排在读管道前面★ `cat 报错.log | wb \"这什么意思\"` 里提到的路径是材料不是附件，" +
    "扫一遍会把人家日志里随口提到的文件全搬进工作目录", { iWanted, iPipe });

  const iEmpty = CLI_SRC.indexOf("if (!oneShot && wanted.length)");
  const iBring = CLI_SRC.indexOf("const attachNames = bringIn(wanted);");
  ok(iEmpty > 0 && iBring > 0 && iEmpty < iBring,
    "★先判「有没有话要问」，再往工作目录里搬★ 搬完才发现没话可问、人补一句重跑，目录里就多出一份 报告-2.md",
    { iEmpty, iBring });

  has(/-f \$\{ref\}：找不到这个文件/, "-f 指的文件找不到时说的是人话");
  has(/process\.exit\(2\)/, "★-f 找不到就当场停★ 让模型对着一个不存在的文件名瞎猜，钱花了事没办");
  has(/runOnce\(runtime, attach\.withNote\(oneShot, attachNames\), opts\.mode\)/, "单发那趟真把标记挂上去了");
  has(/runOnce\(runtime, attach\.withNote\(body, pending\.splice\(0\)\), opts\.mode\)/,
    "★交互模式发出去时把攒着的文件一次性挂上并清空★ 不清空的话下一句话会再挂一遍同样的文件");

  has(/const pending = \[\];/, "交互模式有个「带上了还没发出去」的清单");
  has(/if \(!pending\.includes\(n\)\) pending\.push\(n\)/, "同一个文件不许在清单里排两遍");
  has(/if \(!body\) \{/, "★只拖了文件还没说要干什么：先攒着★ 这时候发出去等于让模型自己猜要拿它干嘛");
  has(/v\.name === "paste"/, "/paste 有人接");
  has(/v\.name === "drop"/, "/drop 有人接");
  has(/pending\.length = 0;/, "/drop 真把清单清了");
  ok(!/pending[\s\S]{0,80}unlinkSync|rmSync\(path\.join\(getWorkspaceDir/.test(CLI_SRC),
    "★/drop 不删文件★ 删掉的可能正是人刚拖进来、还打算用的那份");

  has(/attach\.BIG_TEXT_CHARS/, "粘进来的长文按网页端同一个阈值分流");
  has(/stampName\("粘贴文本", "txt"\)/, "长文存成文件，名字跟网页端一个格式");
  has(/stampName\("粘贴图", "png"\)/, "截图存成文件");

  has(/visionWarned/, "图片没配视觉模型时的提醒只说一次");
  has(/设置 → 模型 → 视觉模型/, "★提醒里得说清楚去哪儿配★ 不吭声地把图交出去，回头人只会以为是自己路径写错了");
  ok(!/return \[\];[\s\S]{0,200}visionWarned = true/.test(CLI_SRC), "（自检）提醒不在提前 return 的后面");

  has(/completer: completeLine/, "Tab 补全接上了 @ 路径");
  has(/\|\| fileMenu\(rl\.line \|\| ""\)/, "★菜单也接上了 @ 路径★ 补全有、菜单没有，等于只有按 Tab 的人能用");
  has(/e\.name\.startsWith\("\."\)/, "点开头的不列——那是配置和缓存，不是人要带走的东西");
  has(/attach\.escPath\(sub \+ e\.name\)/, "★补出来的名字按 shell 那套转义★ 不转义的话带空格的文件名补完反而带不进去");
  ok(!/cursorTo\(process\.stdout, \d+, \d+\)/.test(CLI_SRC), "（守住老规矩）菜单不算绝对行号");
}

// ── ⑩ 两条新命令在那张表里，Tab 和菜单都得认 ─────────────────────────────
console.log("\n⑩ /paste 和 /drop：表里有、Tab 补得出、菜单列得出");
{
  const R = require(path.join(ROOT, "repl-commands"));
  const names = R.COMMANDS.map((c) => c.name);
  ok(names.includes("paste"), "/paste 在命令表里");
  ok(names.includes("drop"), "/drop 在命令表里");
  eq(R.parse("/paste"), { kind: "cmd", name: "paste", arg: "" }, "/paste 认得出");
  eq(R.parse("/v"), { kind: "cmd", name: "paste", arg: "" }, "/v 是 /paste 的简写");
  eq(R.parse("/drop"), { kind: "cmd", name: "drop", arg: "" }, "/drop 认得出");
  const menu = R.menu("/d");
  eq((menu ? menu.items : []).map((i) => i.insert), ["/drop"], "打 /d 菜单里出得来");
  eq(R.complete("/d")[0], ["/drop"], "Tab 补得出来，跟菜单是同一张表");
  for (const n of ["paste", "drop"]) {
    ok(CLI_SRC.includes(`v.name === "${n}"`), `★/${n} 在 cli.js 里真有人接★ 列在菜单里却没人接，等于敲了没反应`);
  }
}

// ── ⑪ cli-attach 自己得是干净的 ──────────────────────────────────────────
console.log("\n⑪ cli-attach 自己不说话、不做主");
{
  ok(!/console\./.test(ATTACH_SRC), "★不打印★ 怎么说话是 cli.js 的事：--quiet / --json 下这儿一个字都不该冒出来");
  ok(!/process\.exit/.test(ATTACH_SRC), "★不替人退出★ 一个解析模块把进程杀了，调用方没有任何余地");
  ok(/opt\.fs \|\| fs/.test(ATTACH_SRC) && /opt\.run \|\|/.test(ATTACH_SRC),
    "fs 和 run 都能从外面塞进来——所以上面那些时序才真对得了");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
