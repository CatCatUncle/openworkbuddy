"use strict";
/**
 * 清中间物 —— 「任务跑完了，盘上剩下的哪些是成品、哪些只是路上的脚手架」这条链路。
 *
 *   node test/sweep.js
 *
 * 这套东西坏掉的时候后果不对称，所以两个方向都得测，而且反向那一半更重要：
 *
 *   · 该提的没提 → 用户的硬盘继续涨，他自己不会发现（2026-09-18 那次，仓库涨到 4.3 GB
 *     才被翻出来）。这种坏法很安静：界面上永远写着「没找着能清的」，全绿。
 *   · 不该提的提了 → 用户点了确定，交付物没了，而且**删就是真删**，不进回收站。
 *
 * 所以每条规则都成对写：正向证明它会响，反向证明前提不成立时它闭嘴。
 * 少了反向那一半，「一条永远返回空清单的规则」和「一条见谁删谁的规则」都能全绿。
 *
 * 真踩过的坑，下面都各有一条钉在这儿：
 *   ① separated/ 和它里面的 htdemucs/ 都在名单里，同一批 wav 被报了两遍，
 *      界面上「能省 20 MB」其实只有 10 MB —— 一个说大话的数字比不说更糟。
 *   ② 一个任务的成果本来就是一棵 Python 源码树，按「任务里另有成品」判，
 *      整棵树都被当成了脚手架 —— 那是把交付物本身删掉。
 *   ③ 一张 1.7 KB 的 card_07.html 是七张卡片之一，按「小网页 = 抓取残渣」被判了进去。
 *   ④ 规则算是「响了」还是「压根没跑到」，从清单上看不出来 —— script 那条曾经
 *      静悄悄地一条都不出，因为取任务名的函数在目录上用错了。所以这里连
 *      「这一组必须非空」都写成断言。
 *
 * 最后一条红线单独一组：apply() 不许信任传进来的路径。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const sweep = require(path.join(ROOT, "sweep"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400) : "")); }
}

/** 造一棵树。键是相对路径，值是文件内容（字符串）或字节数（数字，填 0x61） */
function tree(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sweep-"));
  for (const [rel, val] of Object.entries(spec)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof val === "number" ? Buffer.alloc(val, 0x61) : String(val));
  }
  return dir;
}
const trash = [];
function fixture(spec) { const d = tree(spec); trash.push(d); return d; }
/** 某一组在不在清单里，以及它认领了哪些路径（展开 paths 批量项） */
function group(plan, key) { return (plan.groups || []).find((g) => g.key === key) || null; }
function pathsOf(plan, key) {
  const g = group(plan, key);
  if (!g) return [];
  const out = [];
  for (const it of g.items) { if (it.paths) out.push(...it.paths); else out.push(it.path); }
  return out;
}
/** 把一批文件整体挪到某个前缀底下 */
function pfx(prefix, o) { const r = {}; for (const [k, v] of Object.entries(o)) r[prefix + k] = v; return r; }
/** 连号图：造 n 张，文件名 frame_001.jpg 那种 */
function frames(prefix, n, size) {
  const o = {};
  for (let i = 1; i <= n; i++) o[`${prefix}${String(i).padStart(3, "0")}.jpg`] = size || 1000;
  return o;
}

console.log("\n① 抽帧 / 逐帧图：成片出来了才敢提");
{
  const ws = fixture({ ...pfx("任务A/frames/", frames("f_", 30, 1000)), "任务A/成片.mp4": 5000 });
  const p = sweep.plan(ws);
  const g = group(p, "frames");
  ok(g && g.count === 30, "30 张连号图被认出来了", g && g.count);
  ok(g && g.bytes === 30000, "算的是这 30 张的真实字节数", g && g.bytes);
  ok(g && g.on === true, "默认就勾上（这一条有把握）", g && g.on);
  ok(!pathsOf(p, "frames").includes("任务A/成片.mp4"), "成片本身绝不在清单里");

  // 反向：同样 30 张图，但成片没出来 —— 这批图就是这个任务仅剩的东西
  const ws2 = fixture(pfx("任务A/frames/", frames("f_", 30, 1000)));
  ok(!group(sweep.plan(ws2), "frames"), "反向对照：没有成片就一张都不提（渲染半截被掐断的任务，这批图是全部家当）");

  // 反向：只有 5 张，够不上「这是个抽帧目录」
  const ws3 = fixture({ ...pfx("任务A/图/", frames("f_", 5, 1000)), "任务A/成片.mp4": 5000 });
  ok(!group(sweep.plan(ws3), "frames"), "反向对照：五张图不算抽帧目录（用户手放进去的几张图不许碰）");
}

console.log("\n② 分离出来的音轨：mp3 已经转好了才敢提");
{
  const ws = fixture({
    "任务B/separated/htdemucs/full/vocals.wav": 40000,
    "任务B/separated/htdemucs/full/drums.wav": 40000,
    "任务B/人声.mp3": 3000,
  });
  const p = sweep.plan(ws);
  const g = group(p, "stems");
  ok(g && g.bytes === 80000, "两条 wav 的大小都算上了", g && g.bytes);
  // ① 那个坑：separated/ 和 htdemucs/ 都在名单里，别把同一批报两遍
  ok(g && g.items.length === 1 && g.items[0].path === "任务B/separated",
    "同一批 wav 只报一次（外层 separated/ 认领了，里面的 htdemucs/ 不再单算）", g && g.items.map((i) => i.path));
  ok(g && g.bytes === 80000, "★这个数字不许说大话★ 报两遍的话这里会变成 160000", g && g.bytes);

  const ws2 = fixture({ "任务B/separated/htdemucs/full/vocals.wav": 40000, "任务B/说明.md": 100 });
  ok(!group(sweep.plan(ws2), "stems"), "反向对照：没转出 mp3 就不提（wav 是这次任务唯一的产出）");
}

console.log("\n③ 编译产物：源码还在，随时重编得出来");
{
  const ws = fixture({ "任务C/app.xcodeproj/project.pbxproj": 200, "任务C/build/App.app/bin": 90000, "任务C/说明.md": 100 });
  const p = sweep.plan(ws);
  ok(group(p, "build") && group(p, "build").bytes === 90000, "build/ 整个算进去了", group(p, "build"));
  ok(pathsOf(p, "build").join() === "任务C/build", "认领的是目录本身，不是里面一条条文件", pathsOf(p, "build"));

  // 反向：一个任务里只有 build/，说明我理解错了这个目录是什么
  const ws2 = fixture({ "任务D/build/x.o": 1000 });
  ok(!group(sweep.plan(ws2), "build"), "反向对照：任务里除了 build/ 什么都没有，就不碰（多半是我看错了这个目录）");
}

console.log("\n④ 零碎：cookie 库、空的错误输出、抓取残渣");
{
  const ws = fixture({
    "任务E/ck.db": 8000, "任务E/cmd.err": 0, "任务E/out.json": 2,
    "任务E/空.log": 0, "任务E/跳转.html": 300, "任务E/报告.md": 4000,
  });
  const got = pathsOf(sweep.plan(ws), "scratch").sort();
  ok(got.length === 5, "五样零碎都认出来了", got);
  ok(!got.includes("任务E/报告.md"), "★真正的成品不在里面★ 报告.md 一个字节都没动");

  // ③ 那个坑：小网页不一定是残渣
  const site = fixture({ "任务F/dist/index.html": 500, "任务F/dist/404.html": 300, "任务F/x.mp4": 100 });
  ok(!pathsOf(sweep.plan(site), "scratch").includes("任务F/dist/404.html"),
    "反向对照：站点目录里的 404.html 不算残渣（旁边就躺着 index.html）");
  const cards = fixture({
    "任务G/card_01.html": 300, "任务G/card_02.html": 300, "任务G/card_03.html": 300, "任务G/说明.md": 10,
  });
  ok(!pathsOf(sweep.plan(cards), "scratch").length,
    "反向对照：成套的 card_0X.html 不算残渣（它们就是这次的交付）", pathsOf(sweep.plan(cards), "scratch"));
  const keep = fixture({ "任务H/封面.html": 300, "任务H/final.err": 0, "任务H/x.mp4": 10 });
  ok(!pathsOf(sweep.plan(keep), "scratch").length, "反向对照：名字里带「封面 / final」的一律不碰", pathsOf(sweep.plan(keep), "scratch"));
}

console.log("\n⑤ 过程脚本：默认不勾，而且只认摊在任务根上的");
{
  const ws = fixture({ "任务I/get_cookie.js": 900, "任务I/成片.mp4": 5000 });
  const g = group(sweep.plan(ws), "script");
  // ④ 那个坑：这一条曾经静悄悄一条都不出，清单上看不出是「没有」还是「没跑到」
  ok(g && g.count === 1, "★这一组必须真的响★ 任务根上的 get_cookie.js 被认出来了", g);
  ok(g && g.on === false, "但默认不勾（用户完全可能就是让我写个脚本给他）", g && g.on);

  // ② 那个坑：交付物本身是一棵源码树
  const src = fixture({
    "任务J/typeless/core/audio.py": 4000, "任务J/typeless/cli.py": 2000, "任务J/演示.mp4": 5000,
  });
  ok(!group(sweep.plan(src), "script"),
    "反向对照：任务里那棵源码树一个文件都不提（深一层的 .py 是交付物，不是脚手架）", pathsOf(sweep.plan(src), "script"));
}

console.log("\n⑥ 圈定范围：只看一个任务 / 只看这一轮新造的");
{
  const ws = fixture({
    "任务K/frames/a.jpg": 10, "任务K/ck.db": 500, "任务K/x.mp4": 10,
    "任务L/ck.db": 700, "任务L/y.mp4": 10,
  });
  ok(pathsOf(sweep.plan(ws, { task: "任务K" })).join() === "任务K/ck.db"
    || pathsOf(sweep.plan(ws, { task: "任务K" }), "scratch").join() === "任务K/ck.db",
    "task=任务K 时，任务L 的东西一个都不进来", pathsOf(sweep.plan(ws, { task: "任务K" }), "scratch"));

  const old = path.join(ws, "任务L/ck.db");
  const longAgo = Date.now() - 7 * 86400000;
  fs.utimesSync(old, longAgo / 1000, longAgo / 1000);
  const fresh = sweep.plan(ws, { since: Date.now() - 3600000 });
  ok(!pathsOf(fresh, "scratch").includes("任务L/ck.db"),
    "since 卡住之后，一周前那个 ck.db 不再被端上来（收尾问一句时不该翻旧账）", pathsOf(fresh, "scratch"));
  ok(pathsOf(fresh, "scratch").includes("任务K/ck.db"), "★反向对照★ 刚造的那个照样在（证明 since 不是把整条规则关了）");
}

console.log("\n⑦ 地盘账：地方到底花在哪了");
{
  const ws = fixture({
    "任务M/big.mp4": 100000, "任务M/build/x.o": 50000, "任务N/small.md": 1000, "散的.txt": 10,
  });
  const u = sweep.plan(ws, { usage: 1 }).usage;
  const m = u.tasks.find((t) => t.name === "任务M");
  ok(m && m.bytes === 150000, "编译产物目录也算进任务的占用里（scan 不进去，得单独补一次）", m);
  ok(u.tasks[0].name === "任务M", "按占用从大到小排", u.tasks.map((t) => t.name));
  ok(u.tasks.find((t) => t.name === "") && u.tasks.find((t) => t.name === "").bytes === 10,
    "根目录上的散文件单独归一档（不硬塞给某个任务）", u.tasks.map((t) => [t.name, t.bytes]));
  ok(u.bytes === 151010, "总数对得上", u.bytes);
  ok(sweep.plan(ws).usage === undefined, "不要的时候就不算（收尾那一句用不上，别白走一趟）");
}

console.log("\n⑧ 红线：apply() 不许信任传进来的路径");
{
  const ws = fixture({ "任务O/ck.db": 500, "任务O/x.mp4": 10, "任务O/报告.md": 4000, "机密.txt": 20 });
  const outside = path.join(ws, "..", path.basename(ws) + "-邻居.txt");
  fs.writeFileSync(outside, "别人的东西");
  trash.push(outside);

  const r = sweep.apply(ws, ["任务O/ck.db", "任务O/报告.md", "机密.txt", "../" + path.basename(outside), "/etc/hosts"]);
  ok(r.removed.join() === "任务O/ck.db", "只删了清单上那一个", r.removed);
  ok(r.skipped === 4, "另外四条一条都没动", r.skipped);
  ok(fs.existsSync(path.join(ws, "任务O/报告.md")), "★成品还在★ 报告.md 虽然被点了名，但它不在清单上");
  ok(fs.existsSync(path.join(ws, "机密.txt")), "★工作区里没被提名的文件还在★");
  ok(fs.existsSync(outside), "★工作区外面的文件还在★ ../ 那一手没得逞");
  ok(fs.existsSync("/etc/hosts"), "★绝对路径也没得逞★");
  ok(r.bytes === 500, "报的是真腾出来的字节数", r.bytes);
  ok(!fs.existsSync(path.join(ws, "任务O/ck.db")), "该删的是真删了（不是挪进 .trash —— 挪一下照样占着地方）");
  ok(!fs.existsSync(path.join(ws, ".trash")), "★没有 .trash★ 用户要的是腾出空间");

  // 清单是几分钟前算的，这中间文件可能已经被别处动过了
  const ws2 = fixture({ "任务P/ck.db": 500, "任务P/x.mp4": 10 });
  fs.rmSync(path.join(ws2, "任务P/ck.db"));
  const r2 = sweep.apply(ws2, ["任务P/ck.db"]);
  ok(r2.removed.length === 0 && r2.skipped === 1, "已经不在的文件算 skipped，不算删成功", r2);
}

console.log("\n⑨ 不碰的地方");
{
  const ws = fixture({
    ".trash/20260918/旧文件.err": 0, ".openworkbuddy/traces.jsonl": 100,
    "任务Q/ck.db": 500, "任务Q/x.mp4": 10,
  });
  const all = (sweep.plan(ws).groups || []).flatMap((g) => g.items.map((i) => i.path));
  ok(!all.some((p) => p.startsWith(".")), "点开头的目录整个跳过（.trash 是回收站、.openworkbuddy 是账本）", all);
  ok(all.includes("任务Q/ck.db"), "★反向对照★ 正常任务照常扫（证明不是整棵树都跳过了）");
}

for (const d of trash) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
