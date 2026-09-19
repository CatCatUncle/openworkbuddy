"use strict";
/**
 * 终端里看产出的图。
 *
 * 改之前一轮跑完只打一行文件名，
 * 人得自己开访达翻过去双击，SVG 在终端里根本无从看起。
 *
 * 这一套要挡的，是「直接出图」这条路上唯一那个比没有还糟的失败：
 * **协议不支持却照发**——那串转义序列会原样吐成满屏 base64，把整段对话冲掉，
 * 而且人第一反应是「这软件坏了」。所以判据是宁可不画：
 *
 *   1. 认得出的终端才画（iTerm2 / kitty / Ghostty / WezTerm / mintty）。
 *   2. 认不出的一律不画，**而且不许悄悄不画**——VS Code 这种「其实支持但默认关着」
 *      的，得说清楚开哪个开关；tmux 这种「要额外配置」的，得说清楚为什么。
 *   3. 画不了也永远有退路：`/open` 交给系统默认程序，任何终端任何格式都成立。
 *
 * 所以每条白名单后面都跟一条反向对照：把环境换成不支持的那种，必须变成不画。
 * 少了这层，detect() 退化成「一律返回 iterm」也照样全绿。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const T = require(path.join(ROOT, "term-image"));

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
const SRC = fs.readFileSync(path.join(ROOT, "term-image.js"), "utf8");

// ── ① 认得出的终端才画 ───────────────────────────────────────────────
console.log("① 哪些终端能直接出图");
{
  eq(T.detect({ TERM_PROGRAM: "iTerm.app" }, true).proto, "iterm", "iTerm2 走 iTerm2 内联图协议");
  eq(T.detect({ TERM_PROGRAM: "WezTerm" }, true).proto, "iterm", "WezTerm 两套都支持，用铺得更广的那套");
  eq(T.detect({ TERM_PROGRAM: "mintty" }, true).proto, "iterm", "mintty（Git Bash）也认这套");
  eq(T.detect({ TERM: "xterm-kitty" }, true).proto, "kitty", "kitty 走自己的图形协议");
  eq(T.detect({ KITTY_WINDOW_ID: "3" }, true).proto, "kitty", "TERM 被人改过时还有 KITTY_WINDOW_ID 兜着");
  eq(T.detect({ TERM_PROGRAM: "ghostty" }, true).proto, "kitty", "Ghostty 实现的是 kitty 那套");
}

// ── ② 认不出来的一律不画（这一节是整个模块的命根子）─────────────────
console.log("\n② ★不支持就绝不发★ 发了得到的是满屏 base64，比没有还糟");
{
  eq(T.detect({ TERM_PROGRAM: "Apple_Terminal" }, true).proto, null, "macOS 自带终端：不支持，不发");
  eq(T.detect({ TERM: "xterm-256color" }, true).proto, null, "普通 xterm：不支持，不发");
  eq(T.detect({}, true).proto, null, "什么都探不到：不发");
  eq(T.detect({ TERM_PROGRAM: "iTerm.app" }, false).proto, null, "★重定向到文件时不发★ 否则写进去的是一坨二进制");
  eq(T.detect({ TERM_PROGRAM: "iTerm.app", OPENWORKBUDDY_TERM_IMAGES: "0" }, true).proto, null, "人明说不要就不发");
}

// ── ③ 不画也不许悄悄不画 ─────────────────────────────────────────────
console.log("\n③ 没画出来得说清楚为什么、怎么才能画");
{
  const vs = T.detect({ TERM_PROGRAM: "vscode" }, true);
  eq(vs.proto, null, "VS Code 默认关着这个能力，探不到开没开，所以不赌");
  ok(/enableImages/.test(vs.hint || ""), "但得把开关名字说出来，不能只说「不支持」", vs.hint);
  eq(T.detect({ TERM_PROGRAM: "vscode", OPENWORKBUDDY_TERM_IMAGES: "1" }, true).proto, "iterm",
    "用户开完开关能强行打开");

  const tm = T.detect({ TERM: "xterm-kitty", TMUX: "/tmp/s" }, true);
  eq(tm.proto, null, "tmux 里转义序列过不去（要 allow-passthrough），不赌");
  ok(/open/.test(tm.hint || ""), "但得指一条真能看到图的路", tm.hint);
  eq(T.detect({ TERM: "xterm-kitty", TMUX: "/tmp/s", OPENWORKBUDDY_TERM_IMAGES: "1" }, true).proto, "kitty",
    "配好了 passthrough 的人能强行打开");

  // 反向对照：认不出的终端强行打开，也得用一套真存在的协议，不能返回 null 还说开了
  eq(T.detect({ TERM: "foo", OPENWORKBUDDY_TERM_IMAGES: "1" }, true).proto, "iterm", "认不出但坚持要：给铺得最广的那套");
  // 强行打开时协议仍按终端认：在 kitty 里硬发 iTerm2 那套照样是乱码
  eq(T.detect({ TERM: "xterm-kitty", OPENWORKBUDDY_TERM_IMAGES: "1" }, true).proto, "kitty",
    "★强行打开不等于换协议★ kitty 里发 iTerm2 那套一样是乱码");
  // 认错终端时的逃生口：直接点名要哪套协议
  eq(T.detect({ TERM: "foo", OPENWORKBUDDY_TERM_IMAGES: "kitty" }, true).proto, "kitty", "=kitty 直接点名 kitty 那套");
  eq(T.detect({ TERM_PROGRAM: "Apple_Terminal", OPENWORKBUDDY_TERM_IMAGES: "iterm" }, true).proto, "iterm",
    "=iterm 直接点名 iTerm2 那套");
}

// ── ④ 转义序列的形状（照协议对，不是照自己的想象对）───────────────────
console.log("\n④ 序列形状");
const png = Buffer.from("89504e470d0a1a0a" + "00".repeat(200), "hex"); // 前 8 字节是真 PNG magic
{
  const s = T.encode("iterm", png, { name: "架构图.png", cols: 40 });
  ok(s.startsWith("\x1b]1337;File="), "iTerm2：OSC 1337 开头");
  ok(s.endsWith("\x07\n"), "iTerm2：BEL 收尾（少这一下终端会一直等下去）");
  ok(/inline=1/.test(s), "★inline=1★ 不写这个 iTerm2 会当成附件，图还是看不见");
  ok(/preserveAspectRatio=1/.test(s), "按原比例缩放，别把图压扁");
  ok(new RegExp("width=40[;:]").test(s), "宽度按终端宽给");
  // 注意这里要用字面量比对而不是正则：base64 里的 '+' 在正则里是量词
  ok(s.includes("name=" + Buffer.from("架构图.png").toString("base64")),
    "文件名是 base64 的（中文名直接塞进去会把序列打断）");
  const body = Buffer.from(s.slice(s.indexOf(":") + 1, -2), "base64");
  ok(body.equals(png), "★载荷解回来必须一个字节不差★ 差一个字节终端就画不出来");
}
{
  // 切块：造一份一定超过一块的载荷（4096 字节 base64 ≈ 3072 字节原始数据）
  const big = Buffer.alloc(20000, 7);
  const s = T.encode("kitty", big, { cols: 30 });
  const parts = s.slice(0, -1).split("\x1b\\").filter(Boolean);
  ok(parts.length >= 5, `载荷切成了 ${parts.length} 块（kitty 规定单块 base64 不超过 ${T.KITTY_CHUNK} 字节）`);
  ok(/^\x1b_Gf=100,a=T,c=30,m=1;/.test(parts[0]), "第一块带齐 f=100(PNG) / a=T(传完就显示) / 列数 / m=1");
  ok(parts.slice(1, -1).every((p) => /^\x1b_Gm=1;/.test(p)), "中间每块都是 m=1（还有后续）");
  ok(/^\x1b_Gm=0;/.test(parts[parts.length - 1]), "★最后一块 m=0★ 忘了这一下 kitty 会一直等下一块，图永远不出现");
  const joined = parts.map((p) => p.slice(p.indexOf(";") + 1)).join("");
  ok(Buffer.from(joined, "base64").equals(big), "★拼回来一个字节不差★");
  ok(parts.every((p) => p.slice(p.indexOf(";") + 1).length <= T.KITTY_CHUNK), "没有哪一块超过协议上限");
}

// ── ⑤ 挑哪几张画 ────────────────────────────────────────────────────
console.log("\n⑤ 挑图");
{
  eq(T.pickDrawable([{ name: "报告.md" }, { name: "图.svg" }, { name: "表.xlsx" }, { name: "封面.png" }]),
    ["图.svg", "封面.png"], "只挑看得见的，文档表格不画");
  eq(T.pickDrawable(["a.PNG", "b.JPEG", "c.WebP", "d.BMP", "e.GIF"], 9),
    ["a.PNG", "b.JPEG", "c.WebP", "d.BMP", "e.GIF"], "大写后缀也认");
  eq(T.pickDrawable(["1.png", "2.png", "3.png", "4.png", "5.png"]), ["3.png", "4.png", "5.png"],
    "★一次跑出二十张不能全贴★ 只取最后三张：先草图后成品，人要看的是成品");
  eq(T.pickDrawable([]), [], "没产出就没事");
  eq(T.pickDrawable(null), [], "事件里没带 files 也不能炸");
  eq(T.pickDrawable(["a.mp4", "b.html"]), [], "视频和网页终端里画不出来，交给 /open");
}

// ── ⑥ /open 用什么命令 ──────────────────────────────────────────────
console.log("\n⑥ 交给系统默认程序");
{
  eq(T.openerFor("darwin", "/w/图 1.svg"), { cmd: "open", args: ["/w/图 1.svg"] }, "macOS");
  eq(T.openerFor("linux", "/w/a.svg"), { cmd: "xdg-open", args: ["/w/a.svg"] }, "Linux");
  eq(T.openerFor("win32", "C:\\我的 文件\\a.svg"), { cmd: "cmd", args: ["/c", "start", "", "C:\\我的 文件\\a.svg"] },
    "★Windows 那个空引号不能省★ start 会把第一个引号参数当窗口标题，省了则路径带空格就打不开");
}

// ── ⑦ /open 后面那半句指的是谁 ───────────────────────────────────────
console.log("\n⑦ /open 的名字解析");
{
  const dir = ["架构图.svg", "架构图-旧.svg", "封面.PNG", "报告.md", "3"];
  const recent = ["封面.PNG", "架构图.svg"]; // 屏幕上刚打出来的那行，序号数的是它
  const R = (a) => T.resolveTarget(a, dir, recent);
  eq(R("").kind, "dir", "不给名字 = 打开工作目录本身");
  eq(R(null).kind, "dir", "没带参数也一样");
  eq(R("  "), { kind: "dir" }, "只打了空格也一样");
  eq(R("1"), { kind: "file", name: "封面.PNG" }, "★序号数的是屏幕上那行★ 不是目录列表");
  eq(R("2"), { kind: "file", name: "架构图.svg" }, "序号 2");
  eq(R("架构图.svg"), { kind: "file", name: "架构图.svg" }, "全名");
  eq(R("封面.png"), { kind: "file", name: "封面.PNG" }, "大小写打岔也认（真实文件名是 .PNG）");
  // 完整名（哪怕大小写不一致）必须压过「半截名对上了好几个」：
  // 打了全名还被反问「你说的是哪个」，是最气人的一种没反应
  eq(T.resolveTarget("A.PNG", ["a.png", "a.png.bak", "旧-a.png"], []), { kind: "file", name: "a.png" },
    "★打的是完整名就别再问★ 哪怕它同时是另外两个文件名的一部分");
  eq(R("报告"), { kind: "file", name: "报告.md" }, "打半截、唯一命中：认");
  eq(R("架构图"), { kind: "ambiguous", candidates: ["架构图.svg", "架构图-旧.svg"] },
    "★对上两个就摆出来让人说全★ 猜错等于用系统程序开了个不相干的文件，人还得回去关窗口");
  eq(R("不存在"), { kind: "missing" }, "真没有就说没有");
  eq(R("9"), { kind: "outofrange", count: 2 },
    "★序号超出清单长度要说「清单只有 2 个」★ 说「没有这个文件」会让人以为名字打错了");
  eq(T.resolveTarget("3", dir, []), { kind: "file", name: "3" },
    "清单是空的时候，数字退回按文件名找——目录里真有个文件就叫「3」");
  eq(T.resolveTarget("9", dir, []), { kind: "outofrange", count: 0 }, "一次都没产出过：说这个，别说文件不存在");
  eq(T.resolveTarget("x", null, null), { kind: "missing" }, "目录读不出来（权限/被删）也不能炸");
  eq(T.resolveTarget("3", dir, ["a.png", "b.png", "c.png"]), { kind: "file", name: "c.png" },
    "★序号优先★ 目录里恰好有个文件叫「3」也不抢");
}

// ── ⑧ SVG 到底能不能变成终端能画的东西（真跑一遍，不是假设）─────────────
console.log("\n⑧ SVG 栅格化这条真路");
{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">'
    + '<rect width="120" height="40" fill="#0d1117"/><circle cx="20" cy="20" r="12" fill="#3fb950"/></svg>';
  const r = require(path.join(ROOT, "diagram")).svgToPngAnyhow(svg);
  const done = (out) => {
    if (out && out.png && out.png.length) {
      ok(out.png.slice(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
        `SVG → PNG 成了（via ${out.via}），而且真是 PNG（前 8 字节对得上）`);
      const seq = T.encode("kitty", out.png, { cols: 30 });
      ok(seq.startsWith("\x1b_G") && seq.endsWith("\x1b\\\n"), "转出来的 PNG 能直接进 kitty 序列");
    } else {
      // 这台机器上既不在桌面版里跑、也没装 Chrome。契约是「安静跳过」——
      // 绝不能抛、绝不能返回个半截东西让调用方往终端里灌
      ok(out && !out.png, "★没有渲染器时返回「没转成」而不是抛★ 调用方据此跳过，不会把半截数据吐进终端",
        out && Object.keys(out));
    }
    console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
    process.exit(fail === 0 ? 0 : 1);
  };
  Promise.resolve(r).then(done, (e) => { ok(false, "svgToPngAnyhow 不该抛", String(e && e.message)); done(null); });
}

// ── ⑨ 接线对不对（这几条断在源码上，跑不起来也能查）────────────────────
console.log("\n⑨ cli.js 那头接上了没");
{
  ok(/termImage\.detect\(process\.env, !!process\.stderr\.isTTY\)/.test(CLI_SRC),
    "★探的是 stderr 是不是终端★ 图走进度通道，判 stdout 的话 `openworkbuddy … > 答案.md` 会把图灌进文件");
  ok(/drawOutputs\(state\.changed\)/.test(CLI_SRC), "一轮跑完会去画这轮的产出");
  // 真踩过：一开始画的是 state.files（整个工作目录），结果一次什么图都没出的对话，
  // 末尾也会冒一句「看图：任务_0826_…/封面.png」——那是八月留下的东西
  ok(!/drawOutputs\(state\.files\)/.test(CLI_SRC) && !/hintOutputs\(state\.files/.test(CLI_SRC),
    "★认的是 changed 不是 files★ files 是「目录里现在有什么」，含上个月的旧产出");
  ok(/for \(const n of changed \|\| \[\]\)/.test(CLI_SRC),
    "★changed 是增量，一轮里响很多次，得攒★ 只留最后一次的话，前面几步的产出全丢");
  ok(/hintOutputs\(/.test(CLI_SRC), "没画出来的会告诉人怎么看");
  ok(/v\.name === "open"/.test(CLI_SRC), "/open 有实现");
  ok(/termImage\.resolveTarget\(v\.arg, names, lastFiles\)/.test(CLI_SRC),
    "★/open 3 数的是屏幕上那行产出清单★ 另读一遍目录顺序对不上");
  for (const k of ["ambiguous", "outofrange", "missing"]) {
    ok(new RegExp(`hit\\.kind === "${k}"`).test(CLI_SRC), `没对上的四种情况里「${k}」有话说，不是闷着不动`);
  }
  // 先把注释剥掉再查：文件头那段说明里恰好写着「这个文件不碰 process」「process.env」，
  // 不剥的话，真在代码里读 process 也会被这句解释喂饱，闸门等于没有
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  ok(!/console\.log/.test(code), "★term-image 自己不打印★ 怎么说话是 cli.js 的事");
  ok(!/process\./.test(code), "★也不碰 process★ 所以上面每种终端才能在测试里逐个对");
  const cmds = fs.readFileSync(path.join(ROOT, "repl-commands.js"), "utf8");
  ok(/name: "open"/.test(cmds), "命令表里登记了，/help 和 Tab 补全才有它");
}
