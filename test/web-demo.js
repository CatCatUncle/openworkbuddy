"use strict";
/**
 * 网页演示录屏 record_web_demo —— 纯函数那一层（lib/web-demo-plan.js）+ 马赛克（lib/demo-mask.js）
 *
 * 这个工具出的东西（mp4、每步截图、steps.json）是要发给别人看的，所以钉死的主要是三件事：
 *   ① 步骤脚本写错了，报错要说清是「第几步、哪个动作、怎么改」，模型拿到能自己改对；
 *      能执行脚本、能读本机文件的网址（javascript: / data: / file:）一律拒。
 *   ② 画面：假光标轨迹、打字节奏、自动放大的镜头关键帧，喂给真 ffmpeg 渲出来位置要对、时间要对。
 *   ③ 马赛克：新文档一开头就装（那时连 <html> 都还没有）、脚本和样式里的字不能改、
 *      泄漏扫描只报「哪一类」不回显原文、steps.json 写之前再查一遍。
 *
 * 分段编号【1】【2】……，WEB_DEMO_ONLY=5,9 只跑其中几段。
 * 真 ffmpeg / 真 Chrome 那两段：机器上没有就跳过（OWB_REQUIRE_FFMPEG=1 时没有 ffmpeg 算红）。
 * 录制器那一层（lib/web-demo-recorder.js）的用例从【11】往下接，见文件末尾的标记。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("http");
const assert = require("assert");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-web-demo-"));
// 不许碰真的用户数据目录：下面 require 的模块里有顺手读配置的
process.env.OPENWORKBUDDY_HOME = TMP;

const P = require(path.join(ROOT, "lib", "web-demo-plan"));
const MASK = require(path.join(ROOT, "lib", "demo-mask"));
const TIMING = require(path.join(ROOT, "lib", "demo-timing"));

let pass = 0, fail = 0;
const ok = (v, m, extra) => { if (v) pass++; else { fail++; console.error("  ❌", m, extra === undefined ? "" : "\n     " + extra); } };
const eq = (a, b, m) => { try { assert.deepStrictEqual(a, b, m); pass++; } catch { fail++; console.error("  ❌", m, "\n     实际:", JSON.stringify(a), "期望:", JSON.stringify(b)); } };
/** 应该抛错，且报错能对上 re；返回报错原文，方便再断言「里面没有什么」 */
const throwsWith = (fn, re, m) => {
  try { fn(); } catch (e) {
    const msg = String(e && e.message || e);
    ok(re.test(msg), m, "报错是：" + msg);
    return msg;
  }
  ok(false, m, "没有抛错");
  return "";
};
const stepsOf = (...rest) => [{ goto: "http://127.0.0.1:3000/" }, ...rest];
const sum = (a) => a.reduce((x, y) => x + y, 0);

/** @type {{ n: number, title: string, fn: () => any }[]} */
const SECTIONS = [];
const section = (n, title, fn) => SECTIONS.push({ n, title, fn });

// 一套和本机无关的假清单：断言写得出确切的替换结果，换台机器跑也一样
const FAKE_BASE = [
  ["/home/tester-x", "~"],
  ["box-4242", "demo-machine"],
  ["tester-x", "user"],
];

// ═════════════════════════════════════════ 【1】步骤脚本 ═════════════════════════════════════════
section(1, "步骤脚本：能写的都规整好，写错了说清第几步、怎么改", () => {
  const s = P.parseSteps([
    { goto: "http://127.0.0.1:3000/app?x=1#top", label: "打开首页" },
    { click: "#start" },
    { click: { text: "登录", nth: 2, zoom: false } },
    { type: { selector: "#q", text: "你好，世界", enter: true } },
    { type: "直接打在焦点上" },
    { press: "esc" },
    { press: { key: "ENTER" } },
    { scroll: 400 },
    { scroll: "bottom" },
    { scroll: { to: 120, ms: 300 } },
    { hover: { selector: ".menu", ms: 1200 } },
    { wait: 800 },
    { wait: "1500" },
    { wait: "#done" },
    { wait: { text: "完成", timeout_ms: 20000 } },
    { zoom: { rect: [10, 20, 300, 200], scale: 2 } },
    { zoom: ".chart" },
    { caption: "  这里是  字幕  " },
    { caption: { text: "不停下来", hold: false, ms: 1000 }, shot: true },
    { goto: { path: "site/index.html?tab=2" }, shot: false },
    { click: { selector: "#go", zoom: 2.5 } },
  ]);
  eq(s.length, 21, "21 步全收");
  eq(s.map((x) => x.i), s.map((_, k) => k + 1), "i 从 1 数起，和报错里的「第 N 步」是同一个数");
  eq(s[0], { i: 1, op: "goto", label: "打开首页", shot: true, url: "http://127.0.0.1:3000/app?x=1#top" }, "goto 网址原样留着");
  eq(s[1].target, { selector: "#start" }, "click 写字符串 = 选择器");
  eq([s[1].zoom, s[2].zoom], [true, false], "click 默认自动放大，zoom:false 能关");
  eq(s[2].target, { text: "登录", nth: 2 }, "按字找 + 第几个");
  eq([s[3].target, s[3].text, s[3].enter], [{ selector: "#q" }, "你好，世界", true], "type 带选择器、回车");
  eq([s[4].target, s[4].text, s[4].enter], [null, "直接打在焦点上", false], "type 只写字 = 打在当前焦点上");
  eq([s[5].key, s[6].key], ["Escape", "Enter"], "按键名不分大小写、认 esc 这种简写");
  eq([s[7].by, s[8].to, s[9].to, s[9].ms], [400, "bottom", 120, 300], "scroll 三种写法");
  eq([s[10].op, s[10].ms], ["hover", 1200], "hover 能指定停多久");
  eq([s[11].ms, s[12].ms], [800, 1500], "wait 写数字或数字字符串 = 等多少毫秒");
  eq([s[13].target, s[13].timeout_ms], [{ selector: "#done" }, 10000], "wait 写选择器 = 等它出现，默认最多等 10 秒");
  eq([s[14].target, s[14].timeout_ms], [{ text: "完成" }, 20000], "按字等，上限 20 秒");
  eq([s[15].rect, s[15].scale, s[15].ms], [[10, 20, 300, 200], 2, 1500], "zoom 指定区域和倍数，默认停 1.5 秒");
  eq(s[16].target, { selector: ".chart" }, "zoom 写字符串 = 选择器");
  eq([s[17].text, s[17].hold, s[17].shot, s[17].ms], ["这里是 字幕", true, false, 2500], "caption 空白收拢、默认停下来等读完、默认不截图");
  eq([s[18].hold, s[18].shot, s[18].ms], [false, true, 1000], "caption 可以不停，也可以要截图");
  eq([s[19].path, s[19].shot], ["site/index.html?tab=2", false], "goto 工作区里的 .html");
  eq([s[20].zoom, s[20].scale], [true, 2.5], "click 指定放大倍数");
  ok(P.parseSteps([{ goto: "site/a.htm" }])[0].path === "site/a.htm", "goto 直接写相对 .htm 路径也行");
  ok(P.parseSteps([{ goto: { url: "https://example.test/" } }])[0].url === "https://example.test/", "goto {url}");
  ok(P.parseSteps(stepsOf({ type: { text: "", enter: true } }))[1].enter === true, "type 空字 + enter：只按回车");

  // ---- 报错：都带「第 N 步（动作）」 ----
  const E = (steps, re, m) => throwsWith(() => P.parseSteps(steps), re, m);
  E({}, /steps 要是数组/, "不是数组");
  E([], /至少要有一步 goto/, "空数组");
  E([{ click: "#a" }], /^第 1 步（click）：第一步得是 goto/, "第一步不是 goto");
  E(stepsOf({ foo: 1 }), /^第 2 步（foo）：不认识这个动作，能用的有 goto \/ click/, "不认识的动作列出能用的");
  E(stepsOf({ label: "只有标签" }), /^第 2 步（\?）：没写要做什么/, "只写了 label");
  E(stepsOf("click #a"), /^第 2 步：每一步要是一个对象/, "一步写成字符串");
  E(stepsOf({ click: "#a", type: "x" }), /^第 2 步（click\+type）：一步只做一件事，拆成 2 步/, "一步两个动作");
  E(stepsOf({ click: "#a", selector: "#b" }), /^第 2 步（click）：「selector」要写进 click 里面，比如 \{"click":\{"selector":…\}\}/, "参数写在外面：教他往里挪");
  E(stepsOf({ click: {} }), /^第 2 步（click）：要给 selector 或 text/, "click 没说点哪个");
  E(stepsOf({ click: "  " }), /^第 2 步（click）：selector 是空的/, "click 选择器空白");
  E(stepsOf({ click: { selector: "#a", nth: 0 } }), /nth 从 1 数起/, "nth 从 1 开始");
  E(stepsOf({ click: { selector: "#a", zoom: 3 } }), /zoom 写 false 关掉自动放大，或者写 1~2\.5/, "放大倍数超范围");
  E(stepsOf({ click: { selector: "#a", ms: 100 } }), /不认识「ms」，能写的是 selector \/ text \/ nth \/ zoom/, "click 不收 ms");
  E(stepsOf({ type: { text: "x".repeat(501) } }), /^第 2 步（type）：text 最多 500 个字，这次 501 个/, "type 超 500 字");
  ok(P.parseSteps(stepsOf({ type: "😀".repeat(500) }))[1].text.length === 1000, "500 个 emoji 不超：按字算，不按 UTF-16 长度算");
  E(stepsOf({ type: "a\u0007b" }), /控制字符，按键用 press/, "type 里夹控制字符");
  ok(P.parseSteps(stepsOf({ type: "第一行\n第二行\t缩进" }))[1].text.includes("\n"), "换行和制表符可以打（textarea 里要用）");
  E(stepsOf({ type: { text: "", enter: false } }), /text 是空的；只想回车用 press/, "type 什么都不打");
  E(stepsOf({ press: "F13" }), /^第 2 步（press）：不认识这个键，能按的有 Enter/, "不认识的键");
  E(stepsOf({ scroll: 0 }), /by 是非零像素数/, "滚 0 像素");
  E(stepsOf({ scroll: 30000 }), /最多 20000/, "一次滚太远");
  E(stepsOf({ scroll: { by: 100, to: "top" } }), /by 和 to 二选一/, "by 和 to 同时给");
  E(stepsOf({ scroll: { to: "middle" } }), /to 写 "top"、"bottom" 或离顶部的像素数/, "to 写错");
  E(stepsOf({ wait: 16000 }), /^第 2 步（wait）：ms 最多 15000 毫秒（15 秒）/, "wait 超 15 秒");
  E(stepsOf({ wait: 0 }), /ms 要大于 0/, "wait 0 毫秒");
  E(stepsOf({ wait: { selector: "#a", ms: 100 } }), /ms 和 selector\/text 二选一/, "等元素又给了毫秒数");
  E(stepsOf({ wait: { selector: "#a", timeout_ms: 30000 } }), /timeout_ms 最多 20000 毫秒/, "等元素超过 20 秒上限");
  E(stepsOf({ wait: { timeout_ms: 100 } }), /timeout_ms 要配 selector 或 text 用/, "只给了 timeout_ms");
  E(stepsOf({ zoom: { rect: [0, 0, 0, 10] } }), /rect 是 \[x, y, 宽, 高\]/, "区域宽为 0");
  E(stepsOf({ zoom: { rect: [0, 0, 10, 10], selector: "#a" } }), /rect 和 selector\/text 二选一/, "区域和选择器一起给");
  E(stepsOf({ zoom: { selector: "#a", scale: 3 } }), /scale 在 1~2\.5 之间/, "放大超 2.5 倍");
  E(stepsOf({ caption: "字".repeat(41) }), /^第 2 步（caption）：字幕最多 40 个汉字宽，这条约 41 个，拆成两条/, "字幕 41 个汉字");
  ok(P.parseSteps(stepsOf({ caption: "a".repeat(80) }))[1].text.length === 80, "字幕 80 个字母 = 40 个汉字宽，不拦");
  E(stepsOf({ caption: { text: "x", ms: 100 } }), /字幕至少挂 300 毫秒/, "字幕一闪而过");
  E(stepsOf({ caption: "  " }), /字幕是空的/, "字幕空白");
  E(stepsOf({ click: "#a", label: "长".repeat(41) }), /label 最多 40 个字/, "label 太长");
  E(stepsOf({ click: "#a", label: 3 }), /label 要是字符串/, "label 不是字符串");
  E(stepsOf({ click: "#a", shot: "yes" }), /shot 只能是 true 或 false/, "shot 不是布尔");
  const many = stepsOf(...Array.from({ length: 60 }, () => ({ wait: 10 })));
  E(many, /^第 61 步：一次最多 60 步，这次给了 61 步，拆成几段录/, "超 60 步：说清从哪一步开始超");
  ok(P.parseSteps(many.slice(0, 60)).length === 60, "正好 60 步不拦");

  // ---- goto 的网址：只放 http/https 和工作区 .html ----
  for (const u of ["javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>", "chrome://settings", "file:///etc/passwd", "about:blank", "view-source:http://a.test/"]) {
    const scheme = u.split(":")[0];
    const msg = E([{ goto: u }], new RegExp("^第 1 步（goto）：只能打开 http/https 网址或工作区里的 \\.html，「" + scheme + ":」这种不行"), "拒 " + scheme + ":");
    ok(!msg.includes(u.slice(scheme.length + 1, scheme.length + 8)), "  └ 报错只提协议名，不把后面的内容原样念出来", msg);
  }
  const cred = E([{ goto: "https://admin:hunter2@intranet.test/" }], /网址里带着账号密码，录出来会露馅/, "网址里带账号密码");
  ok(!/hunter2|admin/.test(cred), "  └ 报错里不回显账号密码", cred);
  E([{ goto: "//cdn.test/x" }], /网址要写全，带上 http:\/\/ 或 https:\/\//, "协议相对网址");
  E([{ goto: "localhost:3000" }], /网址要写全，比如 http:\/\/localhost:3000/, "漏了 http:// 的 localhost:3000");
  E([{ goto: "example.test/app" }], /网址要写全，比如 https:\/\/example\.test\/app/, "漏了协议的域名");
  E([{ goto: "C:\\site\\index.html" }], /本机文件写工作区里的相对路径/, "Windows 盘符路径");
  E([{ goto: "/etc/index.html" }], /本机文件写工作区里的相对路径/, "绝对路径");
  E([{ goto: "~/site/index.html" }], /本机文件写工作区里的相对路径/, "~ 开头");
  E([{ goto: "site/../../index.html" }], /path 不能用 \.\. 跳出工作区/, "用 .. 跳出工作区");
  E([{ goto: { path: "a\\..\\b.html" } }], /path 不能用 \.\. 跳出工作区/, "反斜杠的 .. 也拦");
  E([{ goto: "site/logo.png" }], /path 只能是 \.html 文件/, "不是 .html");
  E([{ goto: "http://a.test/ b" }], /网址里有空格或控制字符/, "网址带空格");
  E([{ goto: { url: "site/a.html" } }], /url 要带 http:\/\/ 或 https:\/\/；工作区文件用 path/, "url 里写了相对路径");
  E([{ goto: { url: "http://a.test/", path: "a.html" } }], /url 和 path 二选一/, "url 和 path 都给");
});

// ═════════════════════════════════════════ 【2】画幅 ═════════════════════════════════════════
section(2, "画幅预设：竖屏按手机来，输出尺寸都是偶数", () => {
  const v = P.aspectPreset("9:16");
  eq([v.out, v.css, v.dsf, v.mobile], [{ w: 1080, h: 1920 }, { w: 360, h: 640 }, 3, true], "9:16 = 360×640 视口 ×3 = 1080×1920，走移动端");
  ok(/iPhone/.test(v.ua) && /Mobile/.test(v.ua), "竖屏带 iPhone UA：页面走自己的移动端布局", v.ua);
  const h = P.aspectPreset();
  eq([h.aspect, h.out, h.mobile, h.ua], ["16:9", { w: 1920, h: 1080 }, false, ""], "默认 16:9 → 1920×1080，桌面 UA 不改");
  for (const k of Object.keys(P.ASPECTS)) {
    const p = P.aspectPreset(k);
    ok(p.out.w % 2 === 0 && p.out.h % 2 === 0, k + " 输出宽高都是偶数（yuv420p 要求）", JSON.stringify(p.out));
    ok(Math.round(p.css.w * p.dsf) === p.out.w && Math.round(p.css.h * p.dsf) === p.out.h, k + " 视口 × 像素比 = 输出，不用再缩放", JSON.stringify(p));
    ok(Math.abs(p.out.w / p.out.h - Number(k.split(":")[0]) / Number(k.split(":")[1])) < 0.01, k + " 比例对得上");
  }
  for (const alias of ["9：16", "9x16", " 9 × 16 ", "9X16", "9*16", "9/16"]) ok(P.aspectPreset(alias).aspect === "9:16", `「${alias}」认成 9:16`);
  throwsWith(() => P.aspectPreset("21:9"), /不认识的画幅「21:9」：可选 16:9 \/ 9:16/, "不认识的画幅列出能选的");
  const mut = P.aspectPreset("1:1"); mut.out.w = 1;
  ok(P.aspectPreset("1:1").out.w === 1080, "拿到的是拷贝：改了不影响下一次");
});

// ═════════════════════════════════════════ 【3】打字与鼠标 ═════════════════════════════════════════
section(3, "打字节奏、假光标轨迹", () => {
  const plan = P.typingPlan("a，b😀c。");
  eq(plan.length, 6, "按字算：emoji 算一个");
  ok(plan.every((d) => Number.isInteger(d) && d >= 1), "都是正整数毫秒");
  ok([0, 2, 3, 4].every((i) => plan[i] >= 41 && plan[i] <= 69), "普通字 55ms ±25%", JSON.stringify(plan));
  ok([1, 5].every((i) => plan[i] >= 165 && plan[i] <= 275), "标点后停 220ms ±25%，像人在断句", JSON.stringify(plan));
  eq(P.typingPlan("你好，世界"), P.typingPlan("你好，世界"), "同一个 seed 永远同一串：录两遍节奏一样");
  ok(JSON.stringify(P.typingPlan("abcdefgh", { seed: 2 })) !== JSON.stringify(P.typingPlan("abcdefgh", { seed: 1 })), "换 seed 节奏会变");
  eq(P.typingPlan(""), [], "空字不停");
  eq(P.typingPlan("abc", { jitter: 0 }), [55, 55, 55], "不抖就是整 55");

  const pts = P.mousePath({ x: 0, y: 0 }, { x: 300, y: 400 });
  const last = pts[pts.length - 1];
  eq([last.x, last.y], [300, 400], "最后一个点严丝合缝落在目标上");
  ok(pts.every((p, i) => i === 0 || (p.x >= pts[i - 1].x && p.y >= pts[i - 1].y)), "一路朝目标走，不回头");
  ok(Math.abs(sum(pts.map((p) => p.dt)) - 405) < 0.5, "距离 500：180 + 500×0.45 = 405ms", sum(pts.map((p) => p.dt)));
  ok(pts.length === Math.round(405 * 60 / 1000), "60Hz 采样", pts.length);
  ok(pts[1].x - pts[0].x < pts[Math.floor(pts.length / 2)].x - pts[Math.floor(pts.length / 2) - 1].x, "先慢后快再慢（缓动），不是匀速");
  ok(Math.abs(sum(P.mousePath({ x: 0, y: 0 }, { x: 5000, y: 0 }).map((p) => p.dt)) - 700) < 0.5, "再远也 700ms 封顶");
  ok(Math.abs(sum(P.mousePath({ x: 0, y: 0 }, { x: 10, y: 0 }).map((p) => p.dt)) - 184.5) < 0.5, "很近也至少 180ms");
  ok(P.mousePath({ x: 0, y: 0 }, { x: 3, y: 0 }).length >= 2, "再近也至少两个点");
  eq(P.mousePath({ x: 5, y: 5 }, { x: 5.4, y: 5 }), [{ x: 5.4, y: 5, dt: 0 }], "不到一像素：直接到位");
  eq(P.mousePath({ x: NaN, y: 0 }, { x: 9, y: 9 }), [{ x: 9, y: 9, dt: 0 }], "起点不知道（刚打开页面）：直接到位");
  const up = P.mousePath({ x: 300, y: 400 }, { x: 0, y: 0 });
  eq([up[up.length - 1].x, up[up.length - 1].y], [0, 0], "反方向也落在目标上");
});

// ═════════════════════════════════════════ 【4】自动放大 ═════════════════════════════════════════
section(4, "自动放大：镜头关键帧", () => {
  const W = { cssW: 1280, cssH: 720 };
  const one = P.zoomPoses([{ t: 2, rect: { x: 600, y: 340, w: 80, h: 30 } }], W);
  eq(one[0], { t: 0, z: 1, cx: 640, cy: 360 }, "第一帧是原样");
  ok(one.every((p, i) => i === 0 || p.t > one[i - 1].t), "时间严格递增", JSON.stringify(one));
  ok(Math.max(...one.map((p) => p.z)) === 1.8, "小按钮放到上限 1.8 倍", JSON.stringify(one));
  const arrive = one.find((p) => p.z === 1.8);
  ok(arrive && arrive.t === 2 && arrive.cx === 640 && arrive.cy === 355, "点下去那一刻镜头正好推到位、对准按钮中心", JSON.stringify(arrive));
  ok(one.some((p) => p.z === 1 && p.t > 0 && p.t < 2), "提前推近（出发点在点击之前）", JSON.stringify(one));
  const endP = one[one.length - 1];
  ok(endP.z === 1 && endP.cx === 640 && Math.abs(endP.t - (2 + 1.1 + 0.45)) < 0.01, "停 1.1 秒再用 0.45 秒拉回原样", JSON.stringify(endP));

  eq(P.zoomPoses([{ t: 1, rect: { x: 0, y: 0, w: 1000, h: 600 } }], W), [{ t: 0, z: 1, cx: 640, cy: 360 }], "大块区域放大不到 1.15 倍：镜头不动");
  const corner = P.zoomPoses([{ t: 1, rect: { x: 1260, y: 700, w: 20, h: 20 } }], W).find((p) => p.z > 1);
  ok(corner && Math.abs(corner.cx - (1280 - 1280 / 3.6)) < 0.1 && Math.abs(corner.cy - (720 - 200)) < 0.1, "贴角的按钮：镜头夹在画面里，不拍到页面外面", JSON.stringify(corner));

  const near = P.zoomPoses([{ t: 1, rect: { x: 100, y: 100, w: 60, h: 30 } }, { t: 1.3, rect: { x: 900, y: 500, w: 60, h: 30 } }], W);
  const between = near.filter((p) => p.t > 1 && p.t < 1.3);
  ok(between.every((p) => p.z > 1), "两次点击隔 0.3 秒：直接平移过去，中间不拉回原样", JSON.stringify(near));
  ok(near.filter((p) => p.z === 1).length === 3, "  └ 整组只有开头、推近前、最后拉回三处原样", JSON.stringify(near));
  const far = P.zoomPoses([{ t: 1, rect: { x: 100, y: 100, w: 60, h: 30 } }, { t: 6, rect: { x: 900, y: 500, w: 60, h: 30 } }], W);
  ok(far.some((p) => p.z === 1 && p.t > 2 && p.t < 6), "隔 5 秒的两次：中间回到原样", JSON.stringify(far));
  ok(far.every((p, i) => i === 0 || p.t > far[i - 1].t), "  └ 时间严格递增");

  const typing = P.zoomPoses([{ t: 1, rect: { x: 100, y: 100, w: 200, h: 30 }, until: 5 }], W);
  ok(typing.some((p) => p.z > 1 && p.t >= 5), "打字：镜头一直停到打完", JSON.stringify(typing));
  const forced = P.zoomPoses([{ t: 1, rect: { x: 0, y: 0, w: 1000, h: 600 }, scale: 2.5 }], W);
  ok(forced.some((p) => p.z === 2.5), "指定了倍数就按指定的来（大区域也放）", JSON.stringify(forced));
  eq(P.zoomPoses([{ t: 1, rect: { x: 0, y: 0, w: 10, h: 10 }, scale: 1 }], W).length, 1, "指定 1 倍 = 不放大");
  eq(P.zoomPoses([{ t: NaN, rect: { x: 0, y: 0, w: 10, h: 10 } }, { t: 1, rect: { x: 0, y: 0, w: 0, h: 10 } }, { t: 1 }], W).length, 1, "坏数据（没时间、宽 0、没矩形）直接丢，不拼出 NaN");
  const zero = P.zoomPoses([{ t: 0, rect: { x: 600, y: 340, w: 80, h: 30 } }], W);
  ok(zero.every((p, i) => i === 0 || p.t > zero[i - 1].t) && zero.some((p) => p.z > 1), "片头第 0 秒就点：照样有推近过程、时间不打架", JSON.stringify(zero));
  const lots = P.zoomPoses(Array.from({ length: 200 }, (_, i) => ({ t: i * 3, rect: { x: 10, y: 10, w: 40, h: 20 } })), W);
  ok(lots.length <= P.MAX_POSES, "关键帧有上限，ffmpeg 表达式不会长得离谱", lots.length);

  const still = P.zoomFilter([{ t: 0, z: 1, cx: 640, cy: 360 }], { w: 1920, h: 1080, fps: 30, cssW: 1280, cssH: 720 });
  eq(still, "fps=30,scale=1920:1080:flags=lanczos,setsar=1", "不放大：只转恒定帧率 + 缩放");
  const f = P.zoomFilter(one, { w: 1920, h: 1080, fps: 30, cssW: 1280, cssH: 720 });
  ok(f.startsWith("fps=30,scale=3840:2160:flags=lanczos,zoompan="), "先转恒定帧率再放大两倍给 zoompan", f.slice(0, 80));
  ok(/:d=1:s=1920x1080:fps=30,setsar=1$/.test(f), "zoompan 一进一出，输出成片尺寸", f.slice(-60));
  ok(!/\d[eE][-+]?\d/.test(f), "表达式里没有科学计数法");
  ok(!/NaN|Infinity|undefined/.test(f), "表达式里没有 NaN");
  ok(f.includes("(in/30)"), "时间用输入帧号换算（前面已转成恒定帧率，这样才是真实秒数）");
});

// ═════════════════════════════════════════ 【5】真 ffmpeg 渲放大 ═════════════════════════════════════════
section(5, "真 ffmpeg：放大滤镜渲出来位置对、时间对", async () => {
  const MP = require(path.join(ROOT, "lib", "media-probe"));
  const mb = await MP.resolveMediaBins();
  if (!mb.ffmpeg.bin) {
    if (process.env.OWB_REQUIRE_FFMPEG === "1") ok(false, "OWB_REQUIRE_FFMPEG=1：这台机器必须有 ffmpeg", mb.ffmpeg.why);
    else console.log("  跳过：本机没有 ffmpeg");
    return;
  }
  const W = 320, H = 180;
  const run = (args, pix) => {
    const r = spawnSync(mb.ffmpeg.bin, ["-nostdin", "-v", "error", ...args, "-f", "rawvideo", "-pix_fmt", pix, "-"], { maxBuffer: 1 << 27, timeout: 60000 });
    if (r.status !== 0) throw new Error("ffmpeg 失败：" + String(r.stderr || r.error).slice(0, 400));
    return r.stdout;
  };
  // 红底右上角一块蓝（占四分之一），镜头 0.5 秒推到那块蓝的中心、放大 2 倍
  const poses = [{ t: 0, z: 1, cx: 160, cy: 90 }, { t: 0.5, z: 2, cx: 240, cy: 45 }, { t: 1.5, z: 2, cx: 240, cy: 45 }, { t: 1.9, z: 1, cx: 160, cy: 90 }];
  const f = P.zoomFilter(poses, { w: W, h: H, fps: 30, cssW: W, cssH: H });
  const buf = run(["-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:r=30:d=2`, "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=2",
    "-filter_complex", `[0:v][1:v]overlay=160:0,${f}[v]`, "-map", "[v]", "-frames:v", "31"], "rgb24");
  const FR = W * H * 3;
  ok(buf.length === FR * 31, "出了 31 帧、尺寸是 320×180", buf.length / FR);
  const blue = (k) => {
    let n = 0;
    for (let i = k * FR; i < (k + 1) * FR; i += 3) if (buf[i + 2] > 150 && buf[i] < 100) n++;
    return n / (W * H);
  };
  ok(Math.abs(blue(0) - 0.25) < 0.03, "第 0 帧没放大：蓝块占四分之一", blue(0).toFixed(3));
  ok(blue(30) > 0.85, "第 1 秒（第 30 帧）推到位：满屏都是那块蓝", blue(30).toFixed(3));
  ok(blue(8) > blue(0) + 0.05 && blue(8) < blue(30), "推近过程中是渐变的", blue(8).toFixed(3));

  // 截来的帧是「画面变了才落一帧」，帧率很低还不均匀；不先转恒定帧率，zoompan 会把两秒压成十帧
  const lo = run(["-f", "lavfi", "-i", `color=c=red:s=${W}x${H}:r=5:d=2`, "-vf", f], "gray");
  const frames = lo.length / (W * H);
  ok(Math.abs(frames - 60) <= 2, "5fps 两秒的输入 → 30fps 约 60 帧，时长不被压缩", frames);
});

// ═════════════════════════════════════════ 【6】帧列表与时间换算 ═════════════════════════════════════════
section(6, "concat 列表、墙钟 → 成片时间", () => {
  const frames = [{ file: "f/000.png", at: 1000, until: 1400 }, { file: "f/it's.png", at: 1500, until: 2900 }, { file: "f/002.png", at: 3000, until: 4000 }];
  const list = P.concatList(frames, [0.5, 1.5, 0.0001]);
  eq(list, "file 'f/000.png'\nduration 0.500\nfile 'f/it'\\''s.png'\nduration 1.500\nfile 'f/002.png'\nduration 0.001\nfile 'f/002.png'\n",
    "file / duration 成对，末帧再列一次，单引号按 concat 的规矩转义，时长至少 1ms");
  throwsWith(() => P.concatList([], []), /一帧都没录到/, "没有帧");

  const iv = 100;
  const fit = TIMING.fitDurations(frames, { interval: iv });
  const d = fit.durations;
  eq(P.mapTime(frames, d, 0), 0, "第一帧之前 = 0");
  eq(P.mapTime(frames, d, 1000), 0, "第一帧那一刻 = 0");
  ok(Math.abs(P.mapTime(frames, d, 1250) - 0.25) < 1e-9, "帧内按比例插", P.mapTime(frames, d, 1250));
  ok(Math.abs(P.mapTime(frames, d, 1500) - d[0]) < 1e-9, "第二帧那一刻 = 第一帧时长");
  ok(Math.abs(P.mapTime(frames, d, 3000) - (d[0] + d[1])) < 1e-9, "第三帧那一刻 = 前两帧时长之和");
  ok(Math.abs(P.mapTime(frames, d, 99999) - sum(d)) < 1e-3, "录完之后 = 成片总长（总长就是 fitDurations 的时长之和）", [P.mapTime(frames, d, 99999), sum(d)]);
  let prev = -1, mono = true;
  for (let t = 0; t < 5000; t += 37) { const v = P.mapTime(frames, d, t); if (v < prev) mono = false; prev = v; }
  ok(mono, "单调不减：步骤起止、字幕都不会倒着走");
  const d2 = TIMING.fitDurations(frames, { interval: iv, speed: 2 }).durations;
  ok(Math.abs(P.mapTime(frames, d2, 2200) - P.mapTime(frames, d, 2200) / 2) < 1e-3, "两倍速：同一时刻落在一半的位置");
  eq(P.mapTime([], [], 5), 0, "没有帧 = 0");
});

// ═════════════════════════════════════════ 【7】马赛克脚本 ═════════════════════════════════════════
/**
 * 够跑 maskScript 的最小 DOM：节点树、TreeWalker（只给文本节点）、querySelectorAll（只认它用到的两种选择器）、
 * 一个只记账不自动触发的 MutationObserver——回调由用例手动喂，时序完全可控。
 */
function fakeDom({ withRoot }) {
  const observers = [];
  const QATTR = ["title", "placeholder", "alt", "aria-label"];
  class N {
    constructor(type, name) { this.nodeType = type; this.nodeName = name; this.childNodes = []; this.parentNode = null; }
    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
    querySelectorAll(sel) {
      const out = [];
      const rec = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1) out.push(c); rec(c); } };
      rec(this);
      if (sel === "*") return out;
      if (sel !== "input,textarea,[title],[placeholder],[alt],[aria-label]") throw new Error("假 DOM 没实现这个选择器：" + sel);
      return out.filter((e) => e.tagName === "INPUT" || e.tagName === "TEXTAREA" || QATTR.some((a) => e.getAttribute(a) != null));
    }
  }
  const text = (v) => { const n = new N(3, "#text"); n.nodeValue = v; return n; };
  const el = (tag, attrs = {}, kids = [], props = {}) => {
    const n = new N(1, tag.toUpperCase());
    n.tagName = tag.toUpperCase();
    n.attrs = { ...attrs };
    n.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(n.attrs, k) ? n.attrs[k] : null);
    n.setAttribute = (k, v) => { n.attrs[k] = String(v); };
    Object.assign(n, props);
    for (const k of kids) n.appendChild(typeof k === "string" ? text(k) : k);
    return n;
  };
  const frag = (kids) => { const f = new N(11, "#document-fragment"); for (const k of kids) f.appendChild(typeof k === "string" ? text(k) : k); return f; };
  const doc = new N(9, "#document");
  doc.title = "";
  doc.documentElement = null;
  doc.createTreeWalker = (r) => {
    const list = [];
    const rec = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) list.push(c); rec(c); } };
    rec(r);
    let i = 0;
    return { nextNode: () => list[i++] || null };
  };
  class MO { constructor(cb) { this.cb = cb; } observe(target, opts) { observers.push({ mo: this, target, opts }); } }
  const ctx = { document: doc, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: MO };
  ctx.window = ctx;
  vm.createContext(ctx);
  if (withRoot) { const html = el("html"); doc.appendChild(html); doc.documentElement = html; }
  return { ctx, doc, el, text, frag, observers, run: (src) => vm.runInContext(src, ctx) };
}

section(7, "马赛克：搬家后两头一致、新文档一开头就能装、脚本里的字不动", () => {
  ok(require(path.join(ROOT, "scripts", "demo-mask")) === MASK, "scripts/demo-mask.js 转发的就是 lib 那份（record-demo.js、老测试照旧能用）");
  ok(require(path.join(ROOT, "scripts", "demo-timing")) === TIMING, "scripts/demo-timing.js 同上");
  eq(Object.keys(MASK).sort(), ["defaultPairs", "maskScript"], "导出没少");
  const libSrc = fs.readFileSync(path.join(ROOT, "lib", "web-demo-plan.js"), "utf8");
  ok(/require\("\.\/demo-mask"\)/.test(libSrc) && !/scripts\//.test(libSrc.split("\n").filter((l) => /require\(/.test(l)).join("\n")),
    "lib 里只 require lib：scripts/ 不进安装包");

  const mp = P.maskPairs({ base: FAKE_BASE, extra: ["张三", "客户甲乙丙"], tmpDirs: ["/var/folders/zz/T/owb-web-demo-abc"] });
  const pairs = mp.pairs;
  const HOME = "/home/tester-x";

  // ---- 新文档一开头：<html> 还没有 ----
  const A = fakeDom({ withRoot: false });
  const n = A.run(MASK.maskScript(pairs));
  eq(n, pairs.length, "documentElement 为空时照样装上，报出清单条数");
  ok(A.observers.length === 1 && A.observers[0].target === A.doc, "观察的是 document 本身：<html> 一插进来就接得住");
  ok(A.observers[0].opts.attributeFilter.includes("value") && A.observers[0].opts.subtree, "观察者盯子树和 value 属性");
  const script = A.el("script", {}, [`var p = "${HOME}/a";`]);
  const style = A.el("style", {}, [`.x{background:url(${HOME}/bg.png)}`]);
  const txt = A.el("input", { value: HOME + "/a.txt" }, [], { type: "text", value: HOME + "/typed" });
  const pw = A.el("input", { type: "password", value: HOME + "/pw" }, [], { type: "password", value: HOME + "/pw" });
  const hid = A.el("input", { type: "hidden", value: HOME + "/h" }, [], { type: "hidden", value: HOME + "/h" });
  const ta = A.el("textarea", {}, [HOME + "/ta"], { value: HOME + "/ta" });
  const btn = A.el("button", { title: "在 " + HOME, "aria-label": "张三的按钮" }, ["点我"]);
  const p = A.el("p", {}, ["路径 " + HOME + "/项目，客户甲乙丙"]);
  const host = A.el("div", {}, [], { shadowRoot: A.frag([A.el("span", {}, ["影子里 " + HOME])]) });
  const body = A.el("body", {}, [script, style, txt, pw, hid, ta, btn, p, host]);
  const html = A.el("html", {}, [A.el("head"), body]);
  A.doc.appendChild(html); A.doc.documentElement = html;
  A.observers[0].mo.cb([{ type: "childList", addedNodes: [html] }]);
  eq(p.childNodes[0].nodeValue, "路径 ~/项目，●●●●●●", "解析出来的正文被遮");
  eq(script.childNodes[0].nodeValue, `var p = "${HOME}/a";`, "<script> 里的字不动：改了页面自己的代码就坏了");
  eq(style.childNodes[0].nodeValue, `.x{background:url(${HOME}/bg.png)}`, "<style> 里的字不动");
  eq([txt.value, txt.attrs.value], ["~/typed", "~/a.txt"], "文本框：.value 和 value 属性都遮");
  eq([pw.value, pw.attrs.value, hid.value, hid.attrs.value], [HOME + "/pw", HOME + "/pw", HOME + "/h", HOME + "/h"], "密码框、隐藏域不碰：不上屏，改了表单提交出去的东西就变了");
  eq(ta.value, "~/ta", "textarea 的 .value 遮");
  eq([btn.attrs.title, btn.attrs["aria-label"]], ["在 ~", "●●●●●●的按钮"], "title、aria-label 遮");
  eq(host.shadowRoot.childNodes[0].childNodes[0].nodeValue, "影子里 ~", "开放的 shadow root 里的字也遮");
  ok(A.observers.some((o) => o.target === host.shadowRoot), "  └ 并且单独给它挂了观察者（外面那个看不进去）");

  // ---- 之后的变动 ----
  p.childNodes[0].nodeValue = "改成 " + HOME + "/c";
  A.observers[0].mo.cb([{ type: "characterData", target: p.childNodes[0] }]);
  eq(p.childNodes[0].nodeValue, "改成 ~/c", "原地改字（流式输出那种）也遮");
  btn.setAttribute("title", "客户甲乙丙");
  A.observers[0].mo.cb([{ type: "attributes", target: btn }]);
  eq(btn.attrs.title, "●●●●●●", "属性改了也遮");
  const late = A.el("div", {}, ["晚到 " + HOME]);
  body.appendChild(late);
  A.observers[0].mo.cb([{ type: "childList", addedNodes: [late] }]);
  eq(late.childNodes[0].nodeValue, "晚到 ~", "后插入的节点也遮");
  txt.value = HOME + "/脚本直接赋值";
  A.ctx.__demoMask.rescan();
  eq(txt.value, "~/脚本直接赋值", "脚本直接赋 .value 不触发观察者：rescan 补上");
  A.doc.title = "标题 " + HOME;
  A.ctx.__demoMask.rescan();
  eq(A.doc.title, "标题 ~", "rescan 也补标题");

  const before = A.observers.length;
  eq(A.run(MASK.maskScript(pairs)), pairs.length, "同一份清单再装一遍：照样报条数");
  eq(A.observers.length, before, "  └ 但不再挂第二个观察者（两个互相触发只会白忙）");

  // ---- 页面加载完再装（record-demo.js 那种） ----
  const B = fakeDom({ withRoot: true });
  B.doc.documentElement.appendChild(B.el("body", {}, ["在 " + HOME]));
  B.run(MASK.maskScript(pairs));
  ok(B.observers[0].target === B.doc.documentElement, "<html> 已经在：观察 <html>");
  eq(B.doc.documentElement.childNodes[0].childNodes[0].nodeValue, "在 ~", "  └ 已有的字立刻遮");

  // ---- 页面里的 fix 和 Node 里的 fixString 逐字一致 ----
  const fix = B.ctx.__demoMask.fix;
  const parts = [...pairs.map((x) => x[0]), "普通字", "/", " ", "tester", "box-", "~", "●"];
  let same = 0;
  for (let i = 0; i < 50; i++) {
    let s = "";
    for (let k = 0; k < 1 + (i % 5); k++) s += parts[(i * 7 + k * 13) % parts.length];
    if (fix(s) === P.fixString(s, pairs)) same++;
    else ok(false, "页面和 Node 遮出来不一样", JSON.stringify([s, fix(s), P.fixString(s, pairs)]));
  }
  ok(same === 50, "50 条拼出来的串：页面里遮的和 Node 里算的一模一样", same);

  // ---- 你列的项正好撞上某个替换词 ----
  const clash = P.maskPairs({ base: [["bob", "user"]], extra: ["user"] });
  const C = fakeDom({ withRoot: true });
  C.run(MASK.maskScript(clash.pairs));
  eq([P.fixString("bob", clash.pairs), C.ctx.__demoMask.fix("bob")], ["●●●●●●", "●●●●●●"], "用户名换成 user、而 user 又是你点名要遮的：再过一遍也遮掉，两边一致");
});

// ═════════════════════════════════════════ 【8】打码清单 ═════════════════════════════════════════
section(8, "打码清单 maskPairs：两个字的名字也收、太短的退回来、不会越换越长", () => {
  const mp = P.maskPairs({ base: FAKE_BASE, extra: ["张三", "王", "  ", 12, null, "客户甲乙丙", "张三", "●●●●●●"], tmpDirs: ["/var/folders/zz/T/owb-x", "/tmp"] });
  ok(mp.pairs.some(([a, b]) => a === "张三" && b === "●●●●●●"), "两个字的中文名收下（defaultPairs 对不满 6 个字的是悄悄丢的）");
  eq(mp.rejected, ["王", "  ", "12", "null", "●●●●●●"], "一个字的、空白、不是字符串、本身就是圆点的：退回来让人看见，不悄悄跳过");
  ok(mp.pairs.every((x, i) => i === 0 || mp.pairs[i - 1][0].length >= x[0].length), "越长越先换");
  ok(mp.pairs.filter(([a]) => a === "张三").length === 1, "重复的只留一条");
  ok(mp.pairs.some(([a, b]) => a === "/var/folders/zz/T/owb-x" && b === "/tmp/demo") && mp.pairs.some(([a]) => a === "/private/var/folders/zz/T/owb-x"), "临时目录两种写法都遮（macOS 上 /var 就是 /private/var）");
  ok(!mp.pairs.some(([a]) => a === "/tmp"), "太短的临时目录不收（会把页面上所有 /tmp 都换掉）");
  eq(mp.labels.length, mp.pairs.length, "每条都有标签");
  eq(mp.labels[mp.pairs.findIndex(([a]) => a === "/home/tester-x")], "home 目录", "home 的标签");
  eq(mp.labels[mp.pairs.findIndex(([a]) => a === "box-4242")], "主机名", "主机名的标签");
  eq(mp.labels[mp.pairs.findIndex(([a]) => a === "客户甲乙丙")], "你列的第 6 项", "你列的项按你给的顺序编号");
  const loop = P.maskPairs({ base: [["demo", "demo-machine"], ["user", "user"], ["mach", "~"], ["tmp", "~"]], tmpDirs: ["/var/tmp/owb-x"] });
  ok(!loop.pairs.some(([a]) => a === "demo" || a === "user" || a === "mach" || a === "tmp"),
    "本机名字正好出现在替换结果里（主机叫 demo、用户叫 user）：不遮，否则观察者越换越长", JSON.stringify(loop.pairs));
  ok(P.maskPairs().pairs.length >= 1 && P.maskPairs().labels.includes("home 目录"), "什么都不给：至少遮本机 home");
});

// ═════════════════════════════════════════ 【9】泄漏扫描、字幕、文件名、steps.json ═════════════════════════════════════════
section(9,"泄漏扫描只报类别、字幕页、输出目录、截图文件名、steps.json", () => {
  const mp = P.maskPairs({ base: FAKE_BASE, extra: ["张三"] });
  const { pairs, labels } = mp;
  const HOME = "/home/tester-x";
  const T = (v) => ({ nodeType: 3, nodeName: "#text", nodeValue: v });
  const E = (name, attributes = [], children = [], more = {}) => ({ nodeType: 1, nodeName: name, attributes, children, ...more });
  const doc = (bodyKids) => ({ nodeType: 9, nodeName: "#document", children: [E("HTML", [], [E("HEAD"), E("BODY", [], bodyKids)])] });
  const clean = doc([
    E("SCRIPT", [], [T(`var h="${HOME}"`)]),
    E("STYLE", [], [T(`.a{content:"${HOME}"}`)]),
    E("NOSCRIPT", [], [T(HOME)]),
    E("TEMPLATE", [], [], { templateContent: { nodeType: 11, children: [T(HOME)] } }),
    { nodeType: 8, nodeName: "#comment", nodeValue: HOME },
    E("INPUT", ["type", "password", "value", HOME], [], { shadowRoots: [{ nodeType: 11, shadowRootType: "user-agent", children: [E("DIV", [], [T(HOME)])] }] }),
    E("INPUT", ["TYPE", "Hidden", "value", HOME]),
    E("DIV", ["data-path", HOME, "class", "x"], [T("正常文字 ~")]),
  ]);
  eq(P.findLeaks(clean, ["普通输入"], pairs, labels), [], "脚本、样式、模板、注释、密码框、隐藏域、data-* 属性：都不上屏，不算泄漏");
  const dirty = doc([
    E("DIV", ["id", "host"], [], { shadowRoots: [{ nodeType: 11, children: [T("在 " + HOME + "/x")] }] }),
    E("IFRAME", [], [], { contentDocument: doc([E("P", [], [T("框里的张三")])]) }),
    E("BUTTON", ["title", "box-4242"]),
  ]);
  const leaks = P.findLeaks(dirty, [], pairs, labels);
  // home 路径里本来就带着用户名，露了 home 就是两样都露了：两类都报是实话
  eq(leaks, ["home 目录", "主机名", "用户名", "你列的第 1 项"], "shadow root 里、iframe 里、title 里的都查得出，按标签报");
  ok(!JSON.stringify(leaks).includes(HOME) && !JSON.stringify(leaks).includes("张三"), "  └ 只报是哪一类，不回显原文（报错会进日志和对话）");
  eq(P.findLeaks(doc([E("INPUT", ["value", "tester-x 的文件"])]), [], pairs, labels), ["用户名"], "文本框的 value 属性算");
  eq(P.findLeaks(doc([]), ["标题", "输入框里打的 " + HOME], pairs, labels), ["home 目录", "用户名"], "活的输入值（DOM 树里没有的 .value）也查");
  eq(P.findLeaks(null, null, pairs, labels), [], "空树不报错");
  eq(P.findLeaks(doc([E("P", [], [T(HOME), T(HOME)])]), [HOME], pairs, labels), ["home 目录", "用户名"], "同一类只报一次");

  // ---- 字幕页 ----
  const cap = P.captionHtml("<b>打开</b> " + HOME + " 看看", { w: 1920, h: 1080, pairs });
  ok(cap.includes("&lt;b&gt;打开&lt;/b&gt; ~ 看看"), "字幕文字转义 + 打码", cap.slice(-120));
  ok(!cap.includes(HOME), "  └ 原文不在字幕页里");
  ok(/letter-spacing:0;/.test(cap), "中文不加字距");
  ok(/font-size:45px/.test(cap) && /font-size:45px/.test(P.captionHtml("x", { w: 1080, h: 1920 })), "字号按短边算：横屏竖屏一样大");
  const nums = [...cap.matchAll(/padding:(\d+)px (\d+)px;border-radius:(\d+)px/g)][0];
  ok(nums && nums.slice(1).every((x) => Number(x) % 4 === 0), "内边距、圆角都是 4 的倍数", nums && nums[0]);
  ok(/-webkit-line-clamp:2/.test(cap) && /background:transparent/.test(cap), "最多两行、页面底透明（叠到视频上）");
  ok(/PingFang SC/.test(cap) && /Noto Sans CJK SC/.test(cap), "字体按平台挑中文字体");

  // ---- 输出目录 ----
  eq(P.outDirRel(undefined, { now: new Date(2026, 8, 26, 9, 5, 7) }), "web-demo-0926-090507", "不给就按时间起名");
  ok(/^web-demo-\d{4}-\d{6}$/.test(P.outDirRel("")), "空字符串同上");
  eq(P.outDirRel("demo\\首页"), "demo/首页", "反斜杠统一成 /");
  eq(P.outDirRel("./a//b/"), "a/b", "多余的 ./ 和斜杠收掉");
  for (const bad of ["../x", "a/../../x", "/abs", "~/x", "C:\\x", "C:x", "a<b", "a|b", "a\u0001b", "x".repeat(201)]) throwsWith(() => P.outDirRel(bad), /out_dir/, "拒 out_dir：" + JSON.stringify(bad).slice(0, 30));
  throwsWith(() => P.outDirRel(12), /out_dir 要是字符串/, "out_dir 不是字符串");

  // ---- 截图文件名 ----
  eq(P.shotName({ i: 3, op: "click", label: "打开 " + HOME + "/项目" }, pairs), "03-click-打开-~-项目.png", "label 先打码、再去掉文件名不能用的字符");
  eq(P.shotName({ i: 12, op: "goto", label: "" }), "12-goto.png", "没 label 就是编号 + 动作");
  eq(P.shotName({ i: 1, op: "type", label: "a:b*c?d" }), "01-type-a-b-c-d.png", "冒号星号问号换掉");
  ok(Array.from(P.shotName({ i: 1, op: "caption", label: "长".repeat(40) }).replace(/^01-caption-|\.png$/g, "")).length === 24, "label 截到 24 个字");

  // ---- steps.json ----
  const sj = P.buildStepsJson({
    aspect: "16:9", size: [1920, 1080], fps: 30, durationSec: 12.3456, speed: 1,
    steps: [
      { i: 1, op: "goto", label: "打开 " + HOME, start: 0, end: 1.234567, shot: "steps/01-goto.png", target: null },
      { i: 2, op: "click", label: "", start: 1.2345, end: 2.5, shot: "steps/02-click.png", target: { x: 10.4, y: 20.6, w: 80.5, h: 30.2 } },
    ],
    zooms: [{ t: 0, z: 1, cx: 640, cy: 360 }, { t: 1.23456, z: 1.8, cx: 355.55, cy: 200.4 }],
    captions: [{ text: "张三来演示", start: 3, end: 5.5 }],
    pairs, labels: ["home 目录", "home 目录", "主机名", "用户名"], probes: 2, scans: 3,
  });
  eq([sj.version, sj.video, sj.aspect, sj.size, sj.fps, sj.duration_sec, sj.speed], [1, "demo.mp4", "16:9", [1920, 1080], 30, 12.35, 1], "头部字段");
  eq(sj.steps[0], { i: 1, op: "goto", label: "打开 ~", start: 0, end: 1.23, shot: "steps/01-goto.png", target: null }, "步骤的 label 打码、时间两位小数");
  eq(sj.steps[1].target, { x: 10, y: 21, w: 81, h: 30 }, "目标矩形取整");
  eq(sj.zooms[1], { t: 1.23, z: 1.8, cx: 356, cy: 200 }, "镜头关键帧取整");
  eq(sj.captions, [{ text: "●●●●●●来演示", start: 3, end: 5.5 }], "字幕文字打码");
  eq(sj.mask, { ok: true, pairs: pairs.length, labels: ["home 目录", "主机名", "用户名"], probes: 2, scans: 3, limits: "画布/图片/视频里的字遮不到" }, "mask 段：条数、去重后的标签、自检次数、遮不到什么");
  ok(!JSON.stringify(sj).includes(HOME) && !JSON.stringify(sj).includes("张三"), "整份里没有原文");
  const bad = P.maskPairs({ base: [["QQzz", "xQQzzy"]], extra: [] });
  eq(bad.pairs, [], "替换结果里含原文的一条根本进不了清单");
  const msg = throwsWith(() => P.buildStepsJson({ aspect: "1:1", size: [1080, 1080], fps: 30, durationSec: 1, steps: [{ i: 1, op: "goto", label: "QQzz", start: 0, end: 1 }], pairs: [["QQzz", "xQQzzy"]], labels: ["测试项"] }),
    /^steps\.json 里还有没遮住的测试项，不写$/, "万一遮完还剩原文：抛错不写");
  ok(!msg.includes("QQzz"), "  └ 报错里只有标签");
});

// ═════════════════════════════════════════ 【10】真 Chrome ═════════════════════════════════════════
section(10, "真 Chrome：马赛克自检、泄漏扫描、假光标、找元素", async () => {
  const cdp = require(path.join(ROOT, "cdp"));
  if (!cdp.findChrome()) { console.log("  跳过：本机没有 Chrome"); return; }
  const HOME = os.homedir();
  const SECRET = "机密客户甲乙丙";
  const mp = P.maskPairs({ extra: [SECRET], tmpDirs: [TMP] });
  const jsStr = (s) => JSON.stringify(s).replace(/</g, "\\u003c");
  const escA = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>标题 ${escA(HOME)}</title>
<style>body{margin:0;font:16px sans-serif} #cover{position:absolute;left:0;top:0;width:200px;height:60px;background:rgba(0,0,0,.1)}</style></head><body>
<p id="t">路径 ${escA(HOME)}/项目，${SECRET}，临时 ${escA(TMP)}/x</p>
<input id="i" value="${escA(HOME)}/in">
<input id="pw" type="password" value="${escA(HOME)}/pw">
<input id="h" type="hidden" value="${escA(HOME)}/h">
<textarea id="ta">${escA(HOME)}/ta</textarea>
<button id="b" title="${escA(HOME)}">按钮甲</button>
<div id="sh"></div>
<iframe id="fr" srcdoc="<p>框里 ${escA(escA(HOME))}</p>" style="width:200px;height:50px"></iframe>
<div style="position:relative;width:200px;height:60px"><button id="under" style="width:200px;height:60px">被盖住</button><div id="cover"></div></div>
<div style="height:3000px"></div>
<button id="far">远处的按钮</button>
<script>
  document.getElementById("sh").attachShadow({ mode: "open" }).innerHTML = "<span>影子里 " + ${jsStr(HOME)} + "</span>";
  setTimeout(() => { const d = document.createElement("div"); d.id = "late"; d.textContent = "晚到 " + ${jsStr(SECRET)}; document.body.appendChild(d); }, 30);
</script></body></html>`;
  const srv = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  let br = null;
  const clients = [];
  try {
    try {
      br = await cdp.spawnIsolated({ headless: true, windowSize: { w: 1280, h: 720 }, prefix: "owb-web-demo-prof-", timeoutMs: 20000 });
    } catch (e) {
      console.log("  跳过：Chrome 没起来（" + String(e && e.message || e).split("\n")[0].slice(0, 120) + "）");
      return;
    }
    const open = async () => {
      const t = await cdp.newPage(br.port);
      const c = await cdp.connect(t.webSocketDebuggerUrl, { idleMs: 0 });
      clients.push(c);
      await c.call("Page.enable", {}, 10000);
      await c.call("Runtime.enable", {}, 10000);
      await c.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, 10000);
      return c;
    };
    const ev = async (c, expression) => {
      const r = await c.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 10000);
      if (r.exceptionDetails) throw new Error("页面脚本出错：" + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    };
    const nav = async (c, u) => {
      let off = () => {};
      const loaded = new Promise((res, rej) => {
        const t = setTimeout(() => { off(); rej(new Error("页面 10 秒没加载完")); }, 10000);
        off = c.on("Page.loadEventFired", () => { clearTimeout(t); off(); res(); });
      });
      await c.call("Page.navigate", { url: u }, 10000);
      await loaded;
      await new Promise((r) => setTimeout(r, 120));
    };
    const scan = async (c) => {
      await ev(c, "window.__demoMask ? window.__demoMask.rescan() : false");
      const tree = await c.call("DOM.getDocument", { depth: -1, pierce: true }, 10000);
      const live = await ev(c, P.liveValuesScript());
      return { leaks: P.findLeaks(tree.root, live, mp.pairs, mp.labels), live };
    };

    // ---- 装了马赛克的页 ----
    const c = await open();
    await c.call("Page.addScriptToEvaluateOnNewDocument", { source: MASK.maskScript(mp.pairs) }, 10000);
    await c.call("Page.addScriptToEvaluateOnNewDocument", { source: P.overlayScript({ mode: "arrow" }) }, 10000);
    await nav(c, url);
    eq(await ev(c, P.probeScript(mp.pairs)), { installed: true, masked: true }, "新文档一开头就注入：自检说装上了、真遮了");
    const s1 = await scan(c);
    eq(s1.leaks, [], "整页（shadow root、iframe、输入框、标题、晚到的节点）扫下来没有泄漏", JSON.stringify(s1.leaks));
    ok(!s1.live.some((v) => v.includes(HOME)), "  └ 活的输入值里也没有原文");
    ok(await ev(c, `document.getElementById("t").textContent.includes("●●●●●●") && document.getElementById("t").textContent.includes("/tmp/demo/x")`), "你列的项换成圆点、临时目录换成 /tmp/demo");
    ok(await ev(c, `document.getElementById("h").value === ${jsStr(HOME + "/h")} && document.getElementById("pw").value === ${jsStr(HOME + "/pw")}`), "隐藏域、密码框的值没被改（表单照常提交）");
    ok(await ev(c, `(() => { const s = [...document.scripts].map((x) => x.textContent).join(""); return s.includes(${jsStr(HOME)}); })()`), "页面自己的脚本原样没动");
    await ev(c, `document.getElementById("i").value = ${jsStr(HOME + "/脚本赋值")}; true`);
    const s2 = await scan(c);
    eq(s2.leaks, [], "脚本直接赋 .value：扫之前 rescan 一次就补上了");

    // ---- 假光标 ----
    eq(await ev(c, P.overlayScript({ mode: "arrow" })), "arrow", "假光标装好了（再装一遍不重复装）");
    eq(await ev(c, `document.querySelectorAll("owb-demo-cursor").length`), 1, "页面上只有一个光标");
    eq(await ev(c, `document.getElementById("fr").contentDocument.querySelectorAll("owb-demo-cursor").length`), 0, "iframe 里不画（不然一个页面两个光标）");
    await c.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 200 }, 10000);
    await c.call("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 200, button: "left", clickCount: 1 }, 10000);
    await c.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 200, button: "left", clickCount: 1 }, 10000);
    eq(await ev(c, `window.__demoCursor.pos()`), { x: 100, y: 200, down: false, clicks: 1 }, "光标跟着真的指针事件走，点击记上一次");
    ok(await ev(c, `document.elementFromPoint(100, 200) !== document.querySelector("owb-demo-cursor")`), "光标不挡点击（pointer-events:none）");
    await ev(c, `document.body.innerHTML = "<p>整个换掉</p>"; true`);
    await c.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 50, y: 60 }, 10000);
    eq(await ev(c, `window.__demoCursor.installed()`), true, "单页应用把整个 body 换掉：光标还在（挂在 <html> 上）");

    // ---- 找元素 ----
    await nav(c, url);
    const far = await ev(c, P.resolveTargetScript({ selector: "#far" }));
    ok(far && far.y >= 0 && far.y + far.h <= 720 && far.n === 1 && !far.covered, "视口外的元素先滚进来再给坐标", JSON.stringify(far));
    const byText = await ev(c, P.resolveTargetScript({ text: "按钮甲" }));
    ok(byText && byText.w > 0 && byText.w < 400, "按字找：拿到的是按钮本身，不是包着它的 body", JSON.stringify(byText));
    const under = await ev(c, P.resolveTargetScript({ selector: "#under" }));
    ok(under && under.covered === true, "被半透明遮罩盖住的按钮：报 covered", JSON.stringify(under));
    eq(await ev(c, P.resolveTargetScript({ selector: "#nope" })), null, "找不到 = null");
    eq(await ev(c, P.resolveTargetScript({ selector: "[[bad" })), { error: "selector 写错了" }, "选择器写错 = {error}");
    eq(await ev(c, P.resolveTargetScript({ selector: "button", nth: 99 })), null, "第 99 个不存在 = null");

    // ---- 反向对照：没装马赛克的页，同一套扫描必须查得出来 ----
    const raw = await open();
    await nav(raw, url);
    eq(await ev(raw, P.probeScript(mp.pairs)), { installed: false, masked: false }, "没装马赛克：自检说没装（自检不是摆设）");
    const s3 = await scan(raw);
    ok(s3.leaks.includes("home 目录") && s3.leaks.includes("你列的第 1 项") && s3.leaks.includes("临时目录"), "没装马赛克：泄漏扫描报出 home、你列的项、临时目录", JSON.stringify(s3.leaks));
    ok(!JSON.stringify(s3.leaks).includes(HOME), "  └ 报的是类别不是原文");
  } finally {
    for (const c of clients) { try { c.close(); } catch {} }
    if (br) await br.kill();
    await new Promise((r) => srv.close(r));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// demo-b 从这里往下接【11】起：录制器（lib/web-demo-recorder.js）的用例，用 section(11, "…", async () => { … }) 登记。
// 上面几段只测纯函数和注入脚本；泄漏扫描前先调 window.__demoMask.rescan()，理由见【7】【10】。
// ─────────────────────────────────────────────────────────────────────────────
//
// 录制器那一层反过来：扫之前**不** rescan。rescan 只能把此刻的 DOM 改干净，之前收进来的帧里原文已经上过屏，
// 先补再扫是自己骗自己——观察者漏掉的（脚本直接赋 .value）就该当场拒绝出片，【14】【15】钉着。
// 【11】~【14】用假 DevTools + 假 ffmpeg，钉「发了哪些 CDP、按什么顺序、闸门拦在哪、拦下之后工作区里剩什么」；
// 【15】真 Chrome + 真 ffmpeg 录本地页面（test/fixtures/web-demo/），没有就跳过；【16】【17】说明书和工具定义不跑偏。

const crypto = require("crypto");
const CDP = require(path.join(ROOT, "cdp"));
const REC = require(path.join(ROOT, "lib", "web-demo-recorder"));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const wsText = (s) => {
  const b = Buffer.from(s), h = [0x81];
  if (b.length < 126) h.push(b.length); else if (b.length < 65536) h.push(126, b.length >> 8, b.length & 255);
  else h.push(127, 0, 0, 0, 0, (b.length >>> 24) & 255, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255);
  return Buffer.concat([Buffer.from(h), b]);
};
const CLEAN_TREE = { nodeType: 9, nodeName: "#document", children: [{ nodeType: 1, nodeName: "HTML", attributes: [], children: [{ nodeType: 1, nodeName: "BODY", attributes: [], children: [{ nodeType: 3, nodeName: "#text", nodeValue: "干净的页面" }] }] }] };
const leakTree = (s) => ({ nodeType: 9, nodeName: "#document", children: [{ nodeType: 1, nodeName: "HTML", attributes: [], children: [{ nodeType: 1, nodeName: "BODY", attributes: [], children: [{ nodeType: 1, nodeName: "P", attributes: ["class", "path"], children: [{ nodeType: 3, nodeName: "#text", nodeValue: `保存在 ${s}/Documents` }] }] }] }] });

/**
 * 假 DevTools：握手照 test/cdp.js 的 fakeChrome（带 Origin 就 403、/json/new 只收 PUT），
 * 只回录制器真会发的那几条方法，全部记进 st.log（按页签分），断言看「发了什么、按什么顺序」。
 * Runtime.evaluate 按表达式里的记号认出是哪段注入脚本，回 o 里配好的值——录制器只认返回值，不认脚本怎么写。
 * 收帧每 12ms 推一帧、每三帧内容相同：既有「和上一帧一样」也有「比成片帧率还密」两种情况。
 */
async function fakeDevtools(o = {}) {
  const st = { log: [], sent: 0, acks: 0, opened: [], closed: [], scans: 0 };
  const sockets = new Set();
  let nextTab = 1;
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    if (req.url.startsWith("/json/new")) {
      if (req.method !== "PUT") { res.writeHead(405); return res.end(`Using unsafe HTTP verb ${req.method} to invoke /json/new.`); }
      const id = "TAB" + nextTab++;
      st.opened.push(id);
      return res.end(JSON.stringify({ id, type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` }));
    }
    if (req.url.startsWith("/json/close/")) { st.closed.push(decodeURIComponent(req.url.slice("/json/close/".length))); return res.end("Target is closing"); }
    res.writeHead(404); res.end("[]");
  });
  const evalReply = (e) => {
    if (e.includes("const RAW")) return o.probe || { installed: true, masked: true };
    if (e.includes("const MAX = 2000")) return o.live || [];
    if (e.includes("elementFromPoint")) return e.includes("[[bad") ? { error: "selector 写错了" } : (o.target || { x: 100, y: 200, w: 80, h: 30, n: 1, covered: false });
    if (e === "document.readyState") return "complete";
    if (e.includes("getElementById(\"cap\")")) return { x: 100, y: 10, w: 400, h: 60 };
    if (e.includes("scrollY")) return { y: 0, max: 1000 };
    if (e.includes("document.activeElement")) return { x: 10, y: 10, w: 100, h: 20 };
    return true;
  };
  srv.on("upgrade", (req, socket) => {
    if (req.headers.origin) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    sockets.add(socket);
    const tab = String(req.url).split("/").pop();
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (obj) => { if (!socket.destroyed) socket.write(wsText(JSON.stringify(obj))); };
    const emit = (method, params) => send({ method, params });
    let cast = null, frameNo = 0;
    const stopCast = () => { if (cast) { clearInterval(cast); cast = null; } };
    socket.on("close", () => { stopCast(); sockets.delete(socket); });
    socket.on("error", () => {});
    const handle = (msg) => {
      const m = msg.method, p = msg.params || {};
      const reply = (result) => send({ id: msg.id, result });
      if (m === "Page.screencastFrameAck") { st.acks++; return reply({}); }
      st.log.push({ tab, method: m, params: p });
      if (o.onMethod) o.onMethod(m, p);
      if (o.hangupOn === m) { stopCast(); socket.destroy(); return; }
      switch (m) {
        case "Page.navigate":
          if (o.navError) return reply({ frameId: "F1", errorText: o.navError });
          emit("Page.frameNavigated", { frame: { id: "F1", loaderId: "L1", url: p.url } });
          reply({ frameId: "F1", loaderId: "L1" });
          setTimeout(() => emit("Page.loadEventFired", { timestamp: 1 }), 20);
          return;
        case "Page.startScreencast":
          reply({});
          stopCast();
          cast = setInterval(() => {
            frameNo++; st.sent++;
            emit("Page.screencastFrame", { data: Buffer.from(`frame-${tab}-${Math.floor(frameNo / 3)}`).toString("base64"), sessionId: frameNo, metadata: {} });
          }, 12);
          return;
        case "Page.stopScreencast": stopCast(); return reply({});
        case "Runtime.evaluate": return reply({ result: { type: "object", value: evalReply(String(p.expression || "")) } });
        case "DOM.getDocument": {
          const k = st.scans++; const t = typeof o.tree === "function" ? o.tree(k) : o.tree;
          // 第 k 次扫页面时页面自己跳走（比如最后一步点的链接晚到了），事件先于回包到
          if (o.jumpAtScan && o.jumpAtScan.at === k) emit("Page.frameNavigated", { frame: { id: "F1", loaderId: "L3", url: o.jumpAtScan.url } });
          return reply({ root: t || CLEAN_TREE });
        }
        case "Page.captureScreenshot": return reply({ data: Buffer.from(`PNG-${tab}-${st.log.length}`).toString("base64") });
        case "Page.getFrameTree": return reply({ frameTree: { frame: { id: "CAPF" } } });
        case "Input.synthesizeScrollGesture":
          if (o.noGesture) return send({ id: msg.id, error: { code: -32601, message: "'Input.synthesizeScrollGesture' wasn't found" } });
          return reply({});
        case "Input.dispatchMouseEvent":
          reply({});
          if (p.type === "mousePressed" && o.dialogOnClick) emit("Page.javascriptDialogOpening", { message: "确定吗？", type: "confirm", url: "" });
          if (p.type === "mousePressed" && o.jumpTo) emit("Page.frameNavigated", { frame: { id: "F1", loaderId: "L2", url: o.jumpTo } });
          return;
        default: return reply({});
      }
    };
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && !socket.destroyed) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = !!(buf[1] & 128), key = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
        if (buf.length < off + len) return;
        const body = Buffer.from(buf.slice(off, off + len)); buf = buf.slice(off + len);
        if (key) for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
        let msg; try { msg = JSON.parse(body.toString()); } catch { continue; }
        handle(msg);
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: srv.address().port, st,
    close: async () => {
      for (const s of sockets) s.destroy();
      if (srv.closeAllConnections) srv.closeAllConnections();
      await new Promise((r) => srv.close(() => r()));
    },
  };
}

/** 假 ffmpeg / ffprobe：滤镜、编码器清单可配；ffprobe 报的时长照 list.txt 加起来，尺寸照 o.size（probeWrong 报歪的） */
function fakeBins(o = {}) {
  const F = { args: null, cwd: "", capsAtEncode: null, probes: 0 };
  const filters = o.filters || ["fps", "scale", "zoompan", "overlay", "format"];
  const encoders = o.encoders || ["libx264", "aac"];
  return {
    F,
    bins: async () => (o.noFfmpeg
      ? { ffmpeg: { bin: null, how: "", why: "PATH 里没有 ffmpeg" }, ffprobe: { bin: null }, install: "brew install ffmpeg" }
      : { ffmpeg: { bin: "fake-ffmpeg", how: "test" }, ffprobe: { bin: "fake-ffprobe", how: "test" }, install: "brew install ffmpeg" }),
    runBin: async (bin, args) => {
      if (bin === "fake-ffmpeg" && args.includes("-filters")) return { stdout: filters.map((f) => ` TSC ${f.padEnd(16)} V->V       假滤镜`).join("\n") + "\n", stderr: "" };
      if (bin === "fake-ffmpeg" && args.includes("-encoders")) return { stdout: encoders.map((e) => ` V....D ${e.padEnd(20)} 假编码器`).join("\n") + "\n", stderr: "" };
      if (bin === "fake-ffprobe") {
        F.probes++;
        const video = args[args.length - 1];
        const list = fs.readFileSync(path.join(path.dirname(video), "list.txt"), "utf8");
        const dur = sum([...list.matchAll(/^duration ([\d.]+)$/gm)].map((m) => Number(m[1])));
        const [w, h] = o.probeWrong ? [640, 360] : o.size;
        return { stdout: JSON.stringify({ streams: [{ width: w, height: h }], format: { duration: dur.toFixed(6) } }), stderr: "" };
      }
      throw new Error("假 runBin 不认识：" + bin + " " + args.join(" "));
    },
    runFfmpeg: async (args, eo) => {
      F.args = args; F.cwd = eo.cwd;
      try { F.capsAtEncode = fs.readdirSync(path.join(eo.cwd, "caps")); } catch {}
      eo.onTime(0.5);
      if (o.ffmpegFail) throw new Error(o.ffmpegFail);
      fs.writeFileSync(path.join(eo.cwd, "out.part.mp4"), "FAKE-MP4");
    },
  };
}

/** 一个干净的假工作区 + 指到假 DevTools 的 ctx。browser 工厂记开了几次、收了几次 */
let wsSeq = 0;
function ctxFor(dt, fb, extra = {}) {
  const { cleanupError, ...rest } = extra;
  const ws = path.join(TMP, `ws-${++wsSeq}`);
  fs.mkdirSync(ws, { recursive: true });
  const resolveFile = (p) => {
    const abs = path.resolve(ws, String(p));
    if (abs !== ws && !abs.startsWith(ws + path.sep)) throw new Error("不在工作区里：" + p);
    return abs;
  };
  const B = { calls: 0, cleanups: 0, pageId: "", preset: null, opts: null };
  const prog = [];
  const ctx = {
    outRel: "demo/out", outAbs: resolveFile("demo/out"), resolveFile,
    browser: async (preset, o) => {
      B.calls++; B.preset = preset; B.opts = o;
      const t = await CDP.newPage(dt.port);
      B.pageId = t.id;
      return {
        port: dt.port, pageWs: t.webSocketDebuggerUrl, pageId: t.id, dir: path.join(TMP, "fake-prof"),
        cleanup: async () => { B.cleanups++; if (cleanupError) throw new Error(cleanupError); },
      };
    },
    bins: fb.bins, runBin: fb.runBin, runFfmpeg: fb.runFfmpeg,
    onProgress: (p) => prog.push(p),
    ...rest,
  };
  return { ctx, ws, B, prog };
}

const tmpSnap = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => /^owb-webdemo-(work|prof)-/.test(n)));
const tmpNew = (before) => [...tmpSnap()].filter((n) => !before.has(n));
const byTab = (dt, tab) => dt.st.log.filter((x) => x.tab === tab);

// ═════════════════════════════════════════ 【11】录制器：横屏跑通 ═════════════════════════════════════════
section(11, "录制器（假 Chrome + 假 ffmpeg）：横屏一条跑通——发了什么、按什么顺序、交了什么", async () => {
  const HOME = os.homedir();
  const dt = await fakeDevtools();
  const fb = fakeBins({ size: [1920, 1080] });
  const { ctx, ws, B, prog } = ctxFor(dt, fb);
  const before = tmpSnap();
  const homeLabel = HOME.length <= 30 ? `首页 ${HOME}` : "首页";
  const steps = [
    { goto: "http://127.0.0.1:3000/", label: homeLabel },
    { caption: { text: "给机密客户甲看", ms: 400 } },
    { click: { text: "开始" } },
    { type: { selector: "#q", text: "你好ab", enter: true } },
    { press: "Tab" },
    { scroll: { by: 300, ms: 200 } },
    { hover: { selector: ".menu", ms: 200 } },
    { wait: 200 },
    { zoom: { rect: [100, 100, 200, 100], scale: 2, ms: 300 } },
  ];
  let r;
  try {
    r = await REC.record({ steps, mask: ["机密客户甲"], fps: 30 }, ctx);
  } finally {
    await pause(150); // 让最后几帧的回执落地再关
    await dt.close();
  }
  eq(B.calls, 1, "只开了一次浏览器");
  eq([B.preset.aspect, B.opts], ["16:9", { headless: true }], "默认横屏、不弹窗口");

  const main = byTab(dt, B.pageId);
  const idx = (m) => main.findIndex((x) => x.method === m);
  const order = ["Page.enable", "Emulation.setDeviceMetricsOverride", "Page.addScriptToEvaluateOnNewDocument", "Page.navigate", "Page.startScreencast"].map(idx);
  ok(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), "先定视口、再挂马赛克和光标、再导航，最后才收帧", JSON.stringify(order));
  const firstProbe = main.findIndex((x) => x.method === "Runtime.evaluate" && String(x.params.expression).includes("const RAW"));
  ok(firstProbe > idx("Page.navigate") && firstProbe < idx("Page.startScreencast"), "  └ 打开页面先自检马赛克，过了才开始收帧（白屏和没遮的都不进片子）");
  const dm = main[idx("Emulation.setDeviceMetricsOverride")].params;
  eq([dm.width, dm.height, dm.deviceScaleFactor, dm.mobile], [1280, 720, 1.5, false], "横屏：1280×720 视口 × 1.5 = 1920×1080");
  ok(idx("Emulation.setUserAgentOverride") < 0 && idx("Emulation.setTouchEmulationEnabled") < 0, "横屏不装手机 UA、不开触屏");
  const inj = main.filter((x) => x.method === "Page.addScriptToEvaluateOnNewDocument").map((x) => x.params.source);
  ok(inj.length === 2 && inj[0].includes("__demoMask") && inj[1] === P.overlayScript({ mode: "arrow" }), "新文档一开头注入两段：马赛克在前、箭头光标在后");
  ok(!main.some((x) => x.method === "Runtime.evaluate" && /__demoMask\.rescan\(/.test(String(x.params.expression))), "扫之前从不 rescan（先补再扫，扫出来干净、片子却是脏的）");

  const mouse = main.filter((x) => x.method === "Input.dispatchMouseEvent");
  eq(mouse.filter((x) => x.params.type === "mousePressed").length, 2, "按下两次：click 一次、type 先点输入框一次");
  ok(mouse.filter((x) => x.params.type === "mouseMoved").length >= 10, "光标一路滑过去，不瞬移");
  eq(main.filter((x) => x.method === "Input.insertText").map((x) => x.params.text), ["你", "好", "a", "b"], "一个字一次 insertText（中文不走键码）");
  eq(main.filter((x) => x.method === "Input.dispatchKeyEvent").map((x) => [x.params.type, x.params.key, x.params.text || ""]),
    [["keyDown", "Enter", "\r"], ["keyUp", "Enter", ""], ["rawKeyDown", "Tab", ""], ["keyUp", "Tab", ""]], "回车带 text 才提交得了表单；Tab 没字走 rawKeyDown");
  const sg = main.find((x) => x.method === "Input.synthesizeScrollGesture");
  ok(sg && sg.params.yDistance === -300 && sg.params.gestureSourceType === "mouse", "往下滚 300：滚轮手势", JSON.stringify(sg && sg.params));
  const sc = main[idx("Page.startScreencast")].params;
  eq([sc.format, sc.maxWidth, sc.maxHeight], ["jpeg", 1920, 1080], "按成片尺寸收帧");
  ok(dt.st.sent > 20 && dt.st.acks === dt.st.sent && r.acks === dt.st.sent, "每一帧都回执（不回执 Chrome 就不发下一帧）", `发 ${dt.st.sent}、回 ${dt.st.acks}、收 ${r.acks}`);
  ok(r.frames > 3 && r.frames < dt.st.sent * 0.6, "一样的帧、比成片帧率还密的帧都并掉了", `${r.frames}/${dt.st.sent}`);

  const out = path.join(ws, "demo", "out");
  eq(fs.readdirSync(out).sort(), ["demo.mp4", "steps", "steps.json"], "交付目录里只有成片、截图目录、steps.json");
  ok(r.video === "demo/out/demo.mp4" && fs.readFileSync(path.join(out, "demo.mp4"), "utf8") === "FAKE-MP4", "成片从临时目录搬进工作区");
  const sj = JSON.parse(fs.readFileSync(path.join(out, "steps.json"), "utf8"));
  eq(sj.steps.map((s) => s.op), ["goto", "caption", "click", "type", "press", "scroll", "hover", "wait", "zoom"], "steps.json 九步都在");
  ok(sj.steps.every((s, i) => s.start <= s.end && (i === 0 || sj.steps[i - 1].end <= s.start)), "每步起止单调、一步接一步（配音照它摆）", JSON.stringify(sj.steps.map((s) => [s.start, s.end])));
  eq(sj.steps[2].target, { x: 100, y: 200, w: 80, h: 30 }, "点的元素位置记进 steps.json");
  eq([sj.size, sj.fps, sj.aspect], [[1920, 1080], 30, "16:9"], "尺寸、帧率、画幅");
  ok(sj.captions.length === 1 && sj.captions[0].text.includes("●") && !sj.captions[0].text.includes("机密客户甲"), "字幕里你列的字换成了圆点", JSON.stringify(sj.captions));
  ok(sj.zooms.length >= 2, "有镜头关键帧（点击、打字自动推近 + 点名放大）");
  ok(sj.mask.ok && sj.mask.probes >= 1 && sj.mask.scans >= 10, "自检、扫描次数进了 mask 段：每步一遍 + 录完一遍", JSON.stringify(sj.mask));
  const wantShots = P.parseSteps(steps).filter((s) => s.shot).length;
  eq(r.shots.length, wantShots, `每步一张截图（字幕那步默认不截）：${wantShots} 张`);
  ok(r.shots.every((s) => fs.existsSync(path.join(ws, s))), "  └ 都落在 steps/ 下");
  const blob = JSON.stringify(sj) + r.shots.join() + prog.map((p) => p.label).join();
  ok(!blob.includes(HOME) && !blob.includes("机密客户甲"), "steps.json、截图文件名、进度文字里都没有原文");

  const a = fb.F.args || [];
  const g = a[a.indexOf("-filter_complex") + 1] || "";
  ok(a.includes("libx264") && a.join(" ").includes("-progress pipe:1") && a.includes("caps/cap1.png"), "ffmpeg：libx264、-progress 读进度、字幕 PNG 当输入", a.join(" "));
  ok(/zoompan/.test(g) && /overlay=\(W-w\)\/2:H-h-86:/.test(g) && g.endsWith("format=yuv420p[out]"), "滤镜串：先放大、再叠字幕（横屏离底 8%）、最后转 yuv420p", g);
  ok(/scale=out_range=tv,format=yuv420p\[out\]$/.test(g), "  └ 收尾转成有限范围（tv）：JPEG 帧是全范围，只写 format 新版 ffmpeg 会出 yuvj420p");
  ok(a.indexOf("-reinit_filter") >= 0 && a[a.indexOf("-reinit_filter") + 1] === "0" && a.indexOf("-reinit_filter") < a.indexOf("list.txt"), "  └ 帧尺寸中途变了也不重建滤镜（重建会把 fps、zoompan 的计数清零，片子变短）");
  const tArg = a[a.lastIndexOf("-t") + 1];
  // steps.json 的 duration_sec 只留两位小数、-t 留三位：5.155 对 5.16 是对的。容差卡 0.002 时，总长落在「x.xx5」附近就随机红（总长跟着墙钟走）
  ok(a.lastIndexOf("-t") > a.indexOf("-filter_complex") && Math.abs(Number(tArg) - sj.duration_sec) < 0.006, "  └ 输出用 -t 定死总长（最后一帧的时长 ffmpeg 会拿前一段间隔去猜）", `${tArg} / ${sj.duration_sec}`);
  eq(fb.F.capsAtEncode, ["cap1.png"], "合成前字幕已经截好");
  ok(path.dirname(fb.F.cwd) === os.tmpdir() && /^owb-webdemo-work-/.test(path.basename(fb.F.cwd)) && !fs.existsSync(fb.F.cwd), "工作目录 owb-webdemo-work-* 直接开在系统临时目录下，录完删掉", fb.F.cwd);

  const capTab = dt.st.opened[1];
  const capLog = byTab(dt, capTab);
  const doc = capLog.find((x) => x.method === "Page.setDocumentContent");
  ok(doc && doc.params.frameId === "CAPF" && doc.params.html.includes("●") && !doc.params.html.includes("机密客户甲"), "字幕在第二个页签里排，排的是打过码的字");
  ok(capLog.some((x) => x.method === "Emulation.setDefaultBackgroundColorOverride" && x.params.color.a === 0), "  └ 透明底");
  const cs = capLog.find((x) => x.method === "Page.captureScreenshot");
  eq(cs && cs.params.clip, { x: 100, y: 10, width: 400, height: 60, scale: 1 }, "  └ 只截字幕那一块");
  ok(dt.st.closed.includes(capTab), "  └ 用完关掉");
  eq(B.cleanups, 1, "录完收掉临时 Chrome");
  eq(tmpNew(before), [], "没留下 owb-webdemo-* 临时目录");
  const stages = [...new Set(prog.map((p) => p.stage))];
  eq(stages, ["step", "shot", "encode"], "进度按步骤 → 字幕 → 合成报");
  ok(prog[0].label.startsWith("第 1/9 步：打开 首页"), "进度文字说第几步、干什么", prog[0].label);
  eq(r.warnings, [], "没有要提醒的");
});

// ═════════════════════════════════════════ 【12】录制器：竖屏 ═════════════════════════════════════════
section(12, "录制器：竖屏按手机录（触屏、手机 UA），runTool 的回话，同目录重录清掉旧截图", async () => {
  const dt = await fakeDevtools();
  const fb = fakeBins({ size: [1080, 1920], filters: ["fps", "scale", "format"] });
  const { ctx, ws, B } = ctxFor(dt, fb);
  fs.mkdirSync(path.join(ws, "site"), { recursive: true });
  fs.writeFileSync(path.join(ws, "site", "index.html"), "<p>hi</p>");
  const stepsDir = path.join(ctx.outAbs, "steps");
  fs.mkdirSync(stepsDir, { recursive: true });
  for (const f of ["05-click-旧.png", "fail-03.png", "我的封面.png"]) fs.writeFileSync(path.join(stepsDir, f), "old");
  let res;
  try {
    res = await REC.runTool({ steps: [{ goto: { path: "site/index.html" } }, { click: "#go" }, { type: "hi" }, { scroll: { to: "bottom" } }], aspect: "9:16", auto_zoom: false, fps: 24 }, ctx);
  } finally { await pause(50); await dt.close(); }
  ok(!res.isError, "竖屏一条跑通", res.content);
  const lines = res.content.split("\n");
  ok(/^录好了：demo\/out\/demo\.mp4（[\d.]+ 秒，1080×1920）$/.test(lines[0]), "第一行：成片在哪、多长、多大", lines[0]);
  eq(lines[1], "每步截图在 demo/out/steps/，每步起止时间在 demo/out/steps.json", "第二行：截图目录、steps.json");
  ok(/打码自检通过/.test(lines[2]) && /遮不到/.test(lines[2]), "第三行：自检过了，也说清哪些遮不到", lines[2]);
  eq(lines.length, 3, "没有要提醒的就不加「注意」行");

  const main = byTab(dt, B.pageId);
  const find = (m) => main.find((x) => x.method === m);
  const dm = find("Emulation.setDeviceMetricsOverride").params;
  eq([dm.width, dm.height, dm.deviceScaleFactor, dm.mobile], [360, 640, 3, true], "竖屏：360×640 手机视口 × 3 = 1080×1920");
  eq(find("Emulation.setUserAgentOverride") && find("Emulation.setUserAgentOverride").params, { userAgent: P.IPHONE_UA, platform: "iPhone" }, "手机 UA：页面走自己的移动端布局");
  eq(find("Emulation.setTouchEmulationEnabled") && find("Emulation.setTouchEmulationEnabled").params, { enabled: true, maxTouchPoints: 5 }, "开触屏");
  eq(main.filter((x) => x.method === "Page.addScriptToEvaluateOnNewDocument")[1].params.source, P.overlayScript({ mode: "touch" }), "光标画成触点圆");
  eq(main.filter((x) => x.method === "Input.dispatchTouchEvent").map((x) => x.params.type), ["touchStart", "touchEnd"], "点一下 = 手指按下、抬起");
  ok(!main.some((x) => x.method === "Input.dispatchMouseEvent"), "手机上不发鼠标事件");
  eq(main.filter((x) => x.method === "Input.insertText").map((x) => x.params.text), ["h", "i"], "不给选择器的 type 打在焦点上");
  const nav = find("Page.navigate").params.url;
  ok(nav.startsWith("file://") && nav.endsWith("/site/index.html"), "工作区里的 .html 用 file:// 打开", nav);
  const sg = find("Input.synthesizeScrollGesture").params;
  ok(sg.yDistance === -1000 && sg.gestureSourceType === "touch", "滚到底：手指往上划剩下的整段", JSON.stringify(sg));
  const sc = find("Page.startScreencast").params;
  eq([sc.maxWidth, sc.maxHeight], [1080, 1920], "按竖屏成片尺寸收帧");
  const a = fb.F.args || [];
  const g = a[a.indexOf("-filter_complex") + 1] || "";
  ok(!/zoompan|overlay/.test(g), "auto_zoom:false、没字幕：不放大、不叠字幕（所以缺这俩滤镜的 ffmpeg 也录得了）", g);
  eq(a[a.indexOf("-r") + 1], "24", "帧率 24");
  eq(fs.readdirSync(stepsDir).sort(), ["01-goto.png", "02-click.png", "03-type.png", "04-scroll.png", "我的封面.png"].sort(), "同一目录重录：上一遍的截图清掉，你自己放的文件不动");
});

// ═════════════════════════════════════════ 【13】录制器：开 Chrome 之前的闸门 ═════════════════════════════════════════
section(13, "录制器：开 Chrome 之前能拒的都拒掉（登录态、打码项、要打的字、地址、文件、ffmpeg）", async () => {
  const HOME = os.homedir();
  const dt = await fakeDevtools();
  const before = tmpSnap();
  const run = async (input, o = {}) => {
    const fb = fakeBins({ size: [1920, 1080], ...(o.bins || {}) });
    const c = ctxFor(dt, fb, o.ctx || {});
    const res = await REC.runTool(input, c.ctx);
    ok(c.B.calls === 0 && !fs.existsSync(c.ctx.outAbs), "  └ 浏览器没开，工作区里没写东西");
    return res;
  };
  try {
    let x = await run({ steps: stepsOf(), use_login: true });
    ok(x.isError && /隔离 Chrome/.test(x.content) && /演示账号/.test(x.content), "要借登录态：直说做不到、为什么、怎么办", x.content);
    x = await run({ steps: stepsOf(), mask: ["Z", "机密客户甲"] });
    ok(x.isError && /^mask 里有 1 项太短/.test(x.content) && !x.content.includes("Z"), "打码项太短：报几项，不回显是哪项", x.content);
    x = await run({ steps: stepsOf({ type: { selector: "#q", text: "客户是机密客户甲" } }), mask: ["机密客户甲"] });
    ok(x.isError && /^第 2 步（type）：要打的字里有要遮的内容（你列的第 1 项）/.test(x.content) && !x.content.includes("机密客户甲"), "要打的字里有要遮的：拒，只报类别", x.content);
    x = await run({ steps: stepsOf({ type: `存到 ${HOME}/x` }) });
    ok(x.isError && /要打的字里有要遮的内容（[^）]*home 目录/.test(x.content) && !x.content.includes(HOME), "  └ 本机路径也算", x.content);
    x = await run({ steps: [{ goto: "https://example.com/" }] });
    ok(x.isError && /^第 1 步（goto）：没接网络放行规则时只录本机地址，example\.com不行$/.test(x.content), "没接放行规则：只录本机地址", x.content);
    x = await run({ steps: [{ goto: "https://example.com/" }] }, { ctx: { checkNav: (u) => ({ ok: false, why: "安全中心没放行 " + new URL(u).hostname }) } });
    eq(x.content, "第 1 步（goto）：安全中心没放行 example.com", "接了放行规则：照它的话拒");
    x = await run({ steps: [{ goto: { path: "nope.html" } }] });
    eq(x.content, "第 1 步（goto）：工作区里没有这个文件：nope.html", "要打开的文件不在");
    x = await run({ steps: [{ click: "#a" }] });
    ok(x.isError && /第一步得是 goto/.test(x.content), "第一步不是 goto", x.content);
    x = await run({ steps: stepsOf(), fps: 120 });
    eq(x.content, "fps 要在 24~60 之间", "参数越界说范围");
    x = await run({ steps: stepsOf() }, { bins: { noFfmpeg: true } });
    ok(x.isError && /^没装 ffmpeg，合不了视频。装法：brew install ffmpeg$/.test(x.content), "没有 ffmpeg：说怎么装", x.content);
    x = await run({ steps: stepsOf({ click: "#a" }) }, { bins: { filters: ["fps", "scale", "overlay"] } });
    ok(x.isError && /少了 zoompan/.test(x.content) && /auto_zoom:false/.test(x.content), "缺放大滤镜：直说缺什么、两条路（换完整版或者不放大），不偷偷降级", x.content);
    x = await run({ steps: stepsOf() }, { bins: { encoders: ["aac"] } });
    ok(x.isError && /少了 libx264/.test(x.content), "缺 H.264 编码器", x.content);
  } finally { await dt.close(); }
  eq(dt.st.opened.length, 0, "上面这些一个页签都没开");
  eq(tmpNew(before), [], "也没建临时目录");
});

// ═════════════════════════════════════════ 【14】录制器：录到一半的闸门 ═════════════════════════════════════════
section(14, "录制器：录到一半拦下（没遮上、扫出原文、跳走、断开、停止、超时、验片不对），拦下之后工作区里剩什么", async () => {
  const HOME = os.homedir();
  const recWith = async (fopts, input, extra = {}) => {
    const dt = await fakeDevtools(fopts);
    const fb = fakeBins({ size: [1920, 1080], ...(extra.bins || {}) });
    const c = ctxFor(dt, fb, typeof extra.ctx === "function" ? extra.ctx() : (extra.ctx || {}));
    const before = tmpSnap();
    let res = null, err = null;
    try { res = await REC.runTool(input, c.ctx); } catch (e) { err = e; }
    await pause(50);
    await dt.close();
    return { res, err, dt, fb, B: c.B, outAbs: c.ctx.outAbs, left: tmpNew(before) };
  };
  const clean = (x, what) => {
    ok(!fs.existsSync(x.outAbs), `  └ ${what}：工作区里一个文件都没写`);
    ok(x.B.cleanups === 1 && x.left.length === 0, `  └ ${what}：临时 Chrome 收了、临时目录删了`, JSON.stringify({ cleanups: x.B.cleanups, left: x.left }));
  };

  let x = await recWith({ probe: { installed: true, masked: false } }, { steps: stepsOf({ click: "#a" }) });
  eq(x.res && x.res.content, "马赛克没生效，拒绝录制（第 1 步）", "马赛克装上了但没遮住：拒绝录");
  ok(!x.dt.st.log.some((l) => l.method === "Page.startScreencast"), "  └ 一帧都没收");
  clean(x, "没遮住");
  x = await recWith({ probe: { installed: false, masked: false } }, { steps: stepsOf() });
  eq(x.res && x.res.content, "马赛克没生效，拒绝录制（第 1 步）", "马赛克没装上：同样拒绝");

  x = await recWith({ tree: (k) => (k >= 1 ? leakTree(HOME) : null) }, { steps: stepsOf({ click: "#a" }) });
  ok(x.res && x.res.isError && /^马赛克没兜住：[^，]*home 目录[^，]*，拒绝出片（第 2 步）$/.test(x.res.content) && !x.res.content.includes(HOME), "第 2 步扫出页面上有原文：拒绝出片，只报类别", x.res && x.res.content);
  ok(!x.dt.st.log.some((l) => l.method === "Page.captureScreenshot" && l.tab === x.B.pageId && x.dt.st.log.indexOf(l) > x.dt.st.log.findIndex((m) => m.method === "Input.dispatchMouseEvent")), "  └ 扫出原文的那一刻不截图");
  clean(x, "页面有原文");
  x = await recWith({ live: [`${HOME}/Desktop/导出`] }, { steps: stepsOf() });
  ok(x.res && /^马赛克没兜住：[^，]*home 目录[^，]*，拒绝出片（第 1 步）$/.test(x.res.content), "输入框里脚本直接赋的值（观察者看不见）也扫得出来", x.res && x.res.content);
  clean(x, "输入框有原文");

  x = await recWith({}, { steps: stepsOf({ click: "[[bad" }) });
  eq(x.res && x.res.content, "第 2 步 click「[[bad」：selector 写错了。现场截图：demo/out/steps/fail-02.png", "步骤出错：说第几步、哪个动作、为什么，附现场截图");
  eq(fs.existsSync(x.outAbs) ? [fs.readdirSync(x.outAbs), fs.readdirSync(path.join(x.outAbs, "steps"))] : null, [["steps"], ["fail-02.png"]], "  └ 工作区里只多了这一张（扫过是干净的才留）");
  x = await recWith({ tree: (k) => (k >= 1 ? leakTree(HOME) : null) }, { steps: stepsOf({ click: "[[bad" }) });
  ok(x.res && /^马赛克没兜住：[^，]*home 目录[^，]*，拒绝出片（第 2 步出错时）$/.test(x.res.content), "出错现场有原文：报泄漏（比步骤出错要紧），不留截图", x.res && x.res.content);
  clean(x, "现场有原文");

  x = await recWith({ jumpTo: "http://evil.example.com/" }, { steps: stepsOf({ click: "#a" }, { wait: 500 }) });
  eq(x.res && x.res.content, "页面跳到了不让打开的地址：没接网络放行规则时只录本机地址，evil.example.com不行。已停止，没出片", "点完页面自己跳到外面：当场停");
  clean(x, "越权跳转");
  // 最后一步做完、收尾扫页面那一下才跳走：后面没有步骤再叫 guard 了，照样得拦，不能交一条带着那页的片子
  x = await recWith({ jumpAtScan: { at: 1, url: "http://evil.example.com/" } }, { steps: stepsOf() });
  eq(x.res && x.res.content, "页面跳到了不让打开的地址：没接网络放行规则时只录本机地址，evil.example.com不行。已停止，没出片", "收尾那一下页面才跳走：照样停，不交片");
  ok(x.dt.st.scans === 2 && !x.fb.F.args, "  └ 跳走发生在收尾扫描（第 2 次扫），没进合成", JSON.stringify({ scans: x.dt.st.scans, encoded: !!x.fb.F.args }));
  clean(x, "收尾越权跳转");
  x = await recWith({ navError: "net::ERR_CONNECTION_REFUSED" }, { steps: stepsOf() });
  eq(x.res && x.res.content, "第 1 步 goto：页面没打开（net::ERR_CONNECTION_REFUSED）", "页面没打开：带上 Chrome 的原因");
  clean(x, "没打开");

  x = await recWith({ hangupOn: "Input.insertText" }, { steps: stepsOf({ type: { selector: "#q", text: "abc" } }) });
  eq(x.res && x.res.content, "录制用的 Chrome 中途断开了（崩了或被关了），没出片", "Chrome 半路断了：说断了，不说「连接已关闭」这种半截话");
  clean(x, "断开");

  const ac = new AbortController();
  x = await recWith({ onMethod: (m) => { if (m === "Input.insertText") ac.abort(); } }, { steps: stepsOf({ type: { selector: "#q", text: "abcdef" } }) }, { ctx: { stop: ac.signal } });
  ok(x.err && x.err.name === "AbortError" && !x.res, "用户点停止：原样抛 AbortError（tools.js 统一说「已停止」）", String(x.err || x.res && x.res.content));
  ok(x.dt.st.log.filter((l) => l.method === "Input.insertText").length === 1, "  └ 当场停，没把剩下的字打完");
  clean(x, "停止");

  x = await recWith({}, { steps: stepsOf({ caption: { text: "慢慢看", ms: 3000 } }) }, { ctx: () => ({ deadline: Date.now() + 1500 }) });
  eq(x.res && x.res.content, "这一轮的时间用完了，录制停在半路，没出片", "这一轮时间到了：停在半路，不硬录完");
  clean(x, "超时");

  x = await recWith({}, { steps: stepsOf({ click: "#a" }) }, { bins: { probeWrong: true } });
  ok(x.res && /^合成出来的视频不对（应为 1920×1080、[\d.]+ 秒，实际 640×360、[\d.]+ 秒），没交付$/.test(x.res.content), "合成出来尺寸不对：不交", x.res && x.res.content);
  clean(x, "验片不对");
  x = await recWith({}, { steps: stepsOf() }, { bins: { ffmpegFail: "ffmpeg 合成出错了（退出码 1）：Unknown encoder" } });
  eq(x.res && x.res.content, "ffmpeg 合成出错了（退出码 1）：Unknown encoder", "ffmpeg 出错：原话带回来");
  clean(x, "合成出错");

  x = await recWith({ probe: { installed: true, masked: false } }, { steps: stepsOf() }, { ctx: { cleanupError: "杀不掉" } });
  eq(x.res && x.res.content, "马赛克没生效，拒绝录制（第 1 步）（另外：录制用的临时 Chrome 没关干净（杀不掉））", "收尾也出错：两件事都说，不吞");
  x = await recWith({ dialogOnClick: true, noGesture: true }, { steps: stepsOf({ click: "#a" }, { scroll: 300 }) }, { ctx: { cleanupError: "杀不掉" } });
  ok(x.res && !x.res.isError, "页面弹对话框、不支持滚动手势：照样出片", x.res && x.res.content);
  eq(x.res && x.res.content.split("\n").pop(), "注意：页面弹了对话框，自动点了确定（成片里看不到那个框）；这个 Chrome 不支持模拟滚动手势，改成了页面平滑滚动；录制用的临时 Chrome 没关干净（杀不掉）", "  └ 但每件都照实说一句");
  ok(x.dt.st.log.some((l) => l.method === "Page.handleJavaScriptDialog" && l.params.accept === true), "  └ 对话框点了确定（不点页面就卡住）");
  ok(x.dt.st.log.some((l) => l.method === "Runtime.evaluate" && /window\.scrollBy\(\{ top: 300, behavior: "smooth" \}\)/.test(l.params.expression)), "  └ 退成页面自己平滑滚");
});

// ═════════════════════════════════════════ 【15】真 Chrome + 真 ffmpeg ═════════════════════════════════════════
section(15, "真 Chrome + 真 ffmpeg：本地页面录一条竖屏，出片、验片；马赛克没装上、脚本赋值露原文都真拦得住", async () => {
  if (!CDP.findChrome()) { console.log("  跳过：本机没有 Chrome"); return; }
  const MP = require(path.join(ROOT, "lib", "media-probe"));
  const mb = await MP.resolveMediaBins();
  if (!mb.ffmpeg.bin || !mb.ffprobe.bin) {
    if (process.env.OWB_REQUIRE_FFMPEG === "1") ok(false, "OWB_REQUIRE_FFMPEG=1：这台机器必须有 ffmpeg 和 ffprobe", mb.ffmpeg.why || mb.ffprobe.why);
    else console.log("  跳过：本机没有 ffmpeg / ffprobe");
    return;
  }
  const HOME = os.homedir();
  // 示例页把 home 目录原样嵌进 HTML 和脚本字符串：有这几个字符就嵌不对，测的就不是马赛克了
  if (/[&"<\\]/.test(HOME)) { console.log("  跳过：home 路径里有 & \" < \\，示例页没法原样嵌进去"); return; }
  const page = fs.readFileSync(path.join(__dirname, "fixtures", "web-demo", "index.html"), "utf8").replace(/\{\{HOME\}\}/g, HOME);
  const LEAK = `<!doctype html><html><head><meta charset="utf-8"><title>脚本赋值</title></head><body><input id="q"><script>document.getElementById("q").value = ${JSON.stringify(HOME + "/报表")};</script></body></html>`;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(req.url.startsWith("/leak") ? LEAK : page);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const ws = path.join(TMP, "ws-real");
  fs.mkdirSync(ws, { recursive: true });
  const resolveFile = (p) => path.resolve(ws, String(p));
  const prog = [];
  const ctx = (rel) => ({ outRel: rel, outAbs: path.join(ws, rel), resolveFile, onProgress: (p) => prog.push(p) });
  const before = tmpSnap();
  try {
    const steps = [
      { goto: base + "/", label: "首页" },
      { wait: 700 },
      { type: { selector: "#q", text: "本月销售" }, label: "输入" },
      { click: "#go", label: "生成" },
      { wait: { selector: "#result.show", timeout_ms: 3000 }, shot: false },
      { zoom: { selector: "#result", scale: 1.6, ms: 600 } },
      { scroll: { to: "bottom" } },
      { caption: { text: "三步生成报表", ms: 800 } },
    ];
    let r = null;
    const t0 = Date.now();
    try { r = await REC.record({ steps, aspect: "9:16", fps: 24 }, ctx("demo")); } catch (e) { ok(false, "真录一条竖屏跑通", String(e && e.message || e)); }
    if (r) {
      console.log(`  （真录 ${((Date.now() - t0) / 1000).toFixed(1)} 秒，成片 ${r.durationSec} 秒、${r.frames} 帧${r.warnings.length ? "；" + r.warnings.join("；") : ""}）`);
      const out = path.join(ws, "demo");
      const mp4 = path.join(out, "demo.mp4");
      const pr = spawnSync(mb.ffprobe.bin, ["-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration", "-of", "json", mp4], { encoding: "utf8", timeout: 30000 });
      let info = {};
      try { info = JSON.parse(pr.stdout); } catch {}
      const vs = (info.streams || [])[0] || {};
      eq([vs.codec_name, vs.width, vs.height, vs.pix_fmt], ["h264", 1080, 1920, "yuv420p"], "成片：H.264、1080×1920、yuv420p（手机和各平台都放得了）");
      const sj = JSON.parse(fs.readFileSync(path.join(out, "steps.json"), "utf8"));
      const dur = Number(info.format && info.format.duration);
      ok(Math.abs(dur - sj.duration_sec) < 0.2 && sj.duration_sec > 3 && sj.duration_sec < (Date.now() - t0) / 1000, "时长对得上 steps.json，而且比整个录制过程短（开 Chrome、合成不进片子）", `${dur} / ${sj.duration_sec}`);
      // 最后一步停在片尾：多出一截说明 ffmpeg 自己猜了最后一帧的时长，短了说明滤镜中途重建丢了帧
      const lastEnd = sj.steps[sj.steps.length - 1].end;
      ok(dur - lastEnd > -0.1 && dur - lastEnd < 0.6, "  └ 片尾就停在最后一步做完那儿，不多不少", `片长 ${dur}、最后一步到 ${lastEnd}`);
      eq(sj.steps.map((s) => s.op), ["goto", "wait", "type", "click", "wait", "zoom", "scroll", "caption"], "steps.json 八步都在");
      ok(sj.steps.every((s, i) => s.start <= s.end && (i === 0 || sj.steps[i - 1].end <= s.start)), "  └ 起止单调", JSON.stringify(sj.steps.map((s) => [s.start, s.end])));
      eq(sj.captions.map((c) => c.text), ["三步生成报表"], "  └ 字幕");
      ok(sj.mask.ok && sj.mask.probes >= 1 && sj.mask.scans >= steps.length + 1 && sj.zooms.length >= 2, "  └ 自检、每步扫描、镜头关键帧都有", JSON.stringify(sj.mask));
      ok(!JSON.stringify(sj).includes(HOME), "  └ 没有 home 目录原文");
      eq(r.shots.length, P.parseSteps(steps).filter((s) => s.shot).length, "每步截图张数对");
      ok(r.shots.every((s) => fs.readFileSync(path.join(ws, s)).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))), "  └ 都是 PNG");
      const fr = spawnSync(mb.ffmpeg.bin, ["-nostdin", "-v", "error", "-ss", (sj.duration_sec / 2).toFixed(2), "-i", mp4, "-frames:v", "1", "-vf", "scale=54:96", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 20, timeout: 30000 });
      const px = [...(fr.stdout || [])];
      const mean = px.length ? sum(px) / px.length : 0;
      const sd = px.length ? Math.sqrt(sum(px.map((v) => (v - mean) ** 2)) / px.length) : 0;
      ok(px.length === 54 * 96 && sd > 8, "成片中间那一帧有东西（不是一片白、一片黑）", `sd=${sd.toFixed(1)}`);
      const stages = new Set(prog.map((p) => p.stage));
      ok(["step", "shot", "encode"].every((s) => stages.has(s)) && prog.some((p) => p.stage === "encode" && p.pct > 0 && p.pct < 100), "进度：步骤、字幕、合成，合成那段有中间百分比（读的是 -progress）", JSON.stringify(prog.filter((p) => p.stage === "encode").map((p) => p.pct)));
    }

    // 反向对照：闸门不是摆设
    let msg = "";
    try { await REC.record({ steps: [{ goto: base + "/", label: "首页" }] }, { ...ctx("neg1"), maskScriptOverride: "(() => 0)()" }); } catch (e) { msg = String(e && e.message || e); }
    eq(msg, "马赛克没生效，拒绝录制（第 1 步 首页）", "反向对照：马赛克没装上 → 自检拦下，不录");
    ok(!fs.existsSync(path.join(ws, "neg1")), "  └ 工作区里一个文件都没写");
    msg = "";
    try { await REC.record({ steps: [{ goto: base + "/leak" }] }, ctx("neg2")); } catch (e) { msg = String(e && e.message || e); }
    ok(/^马赛克没兜住：[^，]*home 目录[^，]*，拒绝出片（第 1 步）$/.test(msg), "反向对照：脚本直接赋 .value（观察者看不见）→ 泄漏扫描拦下，不出片", msg);
    ok(!msg.includes(HOME) && !fs.existsSync(path.join(ws, "neg2")), "  └ 报错只报类别，工作区里一个文件都没写");
    eq(tmpNew(before), [], "三条录完：临时 Chrome 的 profile、工作目录都删干净了");
  } finally {
    if (srv.closeAllConnections) srv.closeAllConnections();
    await new Promise((r) => srv.close(() => r()));
  }
});

// ═════════════════════════════════════════ 【16】技能说明书 ═════════════════════════════════════════
section(16, "技能说明书 product-demo：跟工具定义对得上，过得了安检", () => {
  if (!process.env.OPENWORKBUDDY_TOOLWARD) process.env.OPENWORKBUDDY_TOOLWARD = "off";
  const guard = require(path.join(ROOT, "skill-guard"));
  const dir = path.join(ROOT, "skills", "product-demo");
  const md = fs.readFileSync(path.join(dir, "skill.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(md);
  const name = fm && (/^name:\s*(.+)$/m.exec(fm[1]) || [])[1];
  const desc = fm && (/^description:\s*(.+)$/m.exec(fm[1]) || [])[1];
  eq(name && name.trim(), "product-demo", "frontmatter 的 name 跟目录一致");
  ok(desc && [...desc.trim()].length <= 60 && desc.includes("record_web_demo"), "description 60 字以内（每次都进系统提示词），点名工具", desc && [...desc.trim()].length);
  eq(guard.scanDir(dir).level, "ok", "过得了技能安检");
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
  ok(blocks.length >= 1, "至少有一段能照抄的步骤例子");
  for (const b of blocks) {
    try {
      const s = P.parseSteps(JSON.parse(b));
      ok(s.length >= 3 && s[0].op === "goto", "  └ 例子过得了 parseSteps，第一步是 goto");
    } catch (e) { ok(false, "  └ 例子过得了 parseSteps", e.message); }
  }
  // 反引号里提到的参数名、动作名必须是工具真认的：改了参数名忘了改说明书，模型就照着旧名字调
  const TOOLS_SRC = fs.readFileSync(path.join(ROOT, "tools.js"), "utf8");
  const known = new Set([
    ...Object.keys(REC.TOOL_DEF.input_schema.properties), ...P.OPS,
    "label", "shot", "selector", "text", "enter", "nth", "ms", "hold", "scale", "rect", "by", "to", "timeout_ms", "key", "zoom", "path",
    "start", "end",
    "record_web_demo", "read_file", "look_at_image", "text_to_speech",
  ]);
  const used = [...new Set([...md.matchAll(/`([a-z][a-z0-9_]*)(?::\s[^`]*)?`/g)].map((m) => m[1]))];
  eq(used.filter((u) => !known.has(u)), [], "反引号里的参数名、动作名都是工具真认的");
  for (const t of ["read_file", "look_at_image", "text_to_speech"]) ok(!md.includes("`" + t + "`") || TOOLS_SRC.includes(`name: "${t}"`), `  └ 提到的 ${t} 真有这个工具`);
  ok(!/\bsay\b/.test(md), "没有拿系统朗读（say）凑配音的路");
  ok(!/水印/.test(md) || /不加任何「AI 生成」水印/.test(md), "提到水印只说「不加」");
  ok(!/letter-spacing/.test(md), "没有教人给中文加字距");
});

// ═════════════════════════════════════════ 【17】工具定义 + 源码闸门 ═════════════════════════════════════════
section(17, "工具定义 + 录制器源码闸门（浏览器只能是隔离的、ffmpeg 只认找到的那个、扫前不补）", () => {
  const d = REC.TOOL_DEF;
  eq([d.name, d.input_schema.required], ["record_web_demo", ["steps"]], "工具名、必填项");
  eq(d.input_schema.properties.aspect.enum, Object.keys(P.ASPECTS), "画幅可选值跟预设表一致");
  ok(!("use_login" in d.input_schema.properties) && !/profile|user_data|cookie/i.test(JSON.stringify(d.input_schema)), "参数里没有「借登录态 / 指定 profile」的口子");
  ok(/隔离 Chrome/.test(d.description) && /max_sec:30/.test(d.description) && /遮不到/.test(d.description), "说明讲清：隔离浏览器、先短录、哪些遮不到");
  eq(REC.outDirRel({ out_dir: "demo/a" }), "demo/a", "out_dir 原样用");
  ok(/^web-demo-\d{4}-\d{6}$/.test(REC.outDirRel({})), "不写 out_dir 按时间起名", REC.outDirRel({}));
  throwsWith(() => REC.outDirRel({ out_dir: "/etc" }), /绝对路径/, "绝对路径不收");
  throwsWith(() => REC.outDirRel({ out_dir: "../x" }), /跳出工作区/, "跳出工作区不收");

  const src = fs.readFileSync(path.join(ROOT, "lib", "web-demo-recorder.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
  ok(/cdp\.spawnIsolated\(/.test(code) && !/cdp\.(ensure|run|launch|probe)\(/.test(code) && !/9222/.test(code), "浏览器只从 spawnIsolated 来：不连 9222、不复用你开着的 Chrome");
  ok(/--force-device-scale-factor=\$\{preset\.dsf\}/.test(code), "启动时定死缩放：只靠模拟的倍数，无头 Chrome 的帧大多是 CSS 尺寸（成片糊、尺寸忽大忽小）");
  ok(/prefix: "owb-webdemo-prof-"/.test(code) &&/mkdtempSync\(path\.join\(os\.tmpdir\(\), "owb-webdemo-work-"\)\)/.test(code), "临时目录 owb- 开头、直接开在系统临时目录下");
  ok(/media\.resolveMediaBins\(\)/.test(code) && !/(spawn|execFile|spawnSync|execSync)\(\s*["'`](ffmpeg|ffprobe)/.test(code), "ffmpeg 只用 resolveMediaBins 找到的，不裸调");
  ok(!/__demoMask\.rescan\(/.test(code), "扫描前不 rescan");
  ok(!/\bsay\b/.test(code), "没有 say");

  // 接线（tools.js 的 case、TOOL_DEFS）归集成那一步；接上之后这里自动开始查
  const tsrc = fs.readFileSync(path.join(ROOT, "tools.js"), "utf8");
  if (!tsrc.includes("web-demo-recorder")) { console.log("  跳过接线检查：tools.js 还没接 record_web_demo"); return; }
  ok(/require\("\.\/lib\/web-demo-recorder"\)\.TOOL_DEF/.test(tsrc), "TOOL_DEFS 里登记了");
  const i = tsrc.indexOf("case \"record_web_demo\"");
  ok(i > 0, "executeTool 里有这个 case");
  const body = tsrc.slice(i, i + 1500);
  ok(/checkWrite/.test(body) && /checkUrl/.test(body) && /withStop/.test(body), "  └ 先过写权限、网址闸门，停止按钮接上了");
});

// ═════════════════════════════════════════ 【18】接线：executeTool 真走到录制器 ═════════════════════════════════════════
// 【17】只看 tools.js 的源码里写没写；这里真从 executeTool 调一次。只把「开浏览器、找 ffmpeg」换成假的，
// 工作区、写权限、网址闸、停止信号、进度回调全用 tools.js 递进来的那份——接线漏传一样，这里就红
section(18, "接线：executeTool → 录制器（写权限闸、网址闸、停止、进度一路报到 onProgress）", async () => {
  const tools = require(path.join(ROOT, "tools"));
  const security = require(path.join(ROOT, "security"));
  const WS = path.join(TMP, "dispatch-ws");
  fs.mkdirSync(WS, { recursive: true });
  const orig = REC.runTool;
  const seen = [];
  const B = { calls: 0 };
  const dt = await fakeDevtools();
  const fb = fakeBins({ size: [1920, 1080] });
  REC.runTool = (input, ctx) => {
    seen.push(ctx);
    return orig(input, {
      ...ctx,
      browser: async () => {
        B.calls++;
        const t = await CDP.newPage(dt.port);
        return { port: dt.port, pageWs: t.webSocketDebuggerUrl, pageId: t.id, dir: path.join(TMP, "fake-prof"), cleanup: async () => {} };
      },
      bins: fb.bins, runBin: fb.runBin, runFfmpeg: fb.runFfmpeg,
    });
  };
  const call = (input, extra = {}) => {
    const prog = [];
    const p = tools.withWorkspace(WS, () => tools.executeTool("record_web_demo", input,
      { security: { gateway: false }, onProgress: (x) => prog.push(x), ...extra }));
    return p.then((r) => ({ r, prog }));
  };
  const steps = [{ goto: "http://127.0.0.1:3000/" }, { click: { text: "开始" } }];
  try {
    ok(tools.TOOL_DEFS.some((d) => d.name === "record_web_demo" && d === REC.TOOL_DEF), "TOOL_DEFS 里登记的就是录制器那份定义");

    const { r, prog } = await call({ steps, out_dir: "demo/d1" });
    ok(!r.isError && /^录好了：demo\/d1\/demo\.mp4/.test(r.content), "executeTool 走到了录制器，回的是它那几行话", r.content);
    ok(fs.existsSync(path.join(WS, "demo", "d1", "demo.mp4")) && fs.existsSync(path.join(WS, "demo", "d1", "steps.json")), "  └ 成片和 steps.json 落在工作区的 out_dir 下");
    const c = seen[0] || {};
    ok(c.outRel === "demo/d1" && c.outAbs === path.join(WS, "demo", "d1") && typeof c.resolveFile === "function" && typeof c.checkNav === "function",
      "ctx：输出目录、工作区解析、网址闸都是 tools.js 递进来的");
    ok(!!c.stop && typeof c.stop.aborted === "boolean", "  └ 停止信号接上了（withStop 合成的那一路）");
    ok(prog.length >= 3 && prog.every((p) => p && typeof p.stage === "string" && typeof p.label === "string" && p.label.length > 0), "进度一路报到了调用方的 onProgress", JSON.stringify(prog.slice(0, 3)));
    const stages = [...new Set(prog.map((p) => p.stage))];
    ok(stages.includes("step") && stages.includes("encode"), "  └ 步骤、合成两段都报了", stages.join());
    const last = prog[prog.length - 1] || {};
    ok(last.stage === "encode" && last.pct === 100, "  └ 最后一条是收尾那条（100%）", JSON.stringify(last));
    eq(B.calls, 1, "开了一次（假）浏览器");
    ok(security.auditList(20).some((a) => a.type === "网络访问" && a.text === "录屏打开：http://127.0.0.1:3000/" && a.action === "放行"), "放行的地址留了审计");

    // 反向对照 ①：安全中心黑名单里的地址，开浏览器之前就拒，并留审计
    const n0 = B.calls;
    const bad = await call({ steps: [{ goto: "http://blocked.example/" }], out_dir: "demo/d2" },
      { security: { gateway: true, url_blacklist: ["blocked.example"] } });
    ok(bad.r.isError && /第 1 步（goto）：安全中心拦下了/.test(bad.r.content), "黑名单地址：拒，并说是安全中心拦的", bad.r.content);
    eq(B.calls, n0, "  └ 浏览器没开");
    ok(security.auditList(20).some((a) => a.type === "网络拦截" && a.text === "http://blocked.example/" && a.action === "拦截"), "  └ 拦截留了审计");
    ok(!fs.existsSync(path.join(WS, "demo", "d2", "demo.mp4")), "  └ 没出片");

    // 反向对照 ②：「只看不动」档位不许写，连录制器都不进
    const s0 = seen.length;
    const ro = await call({ steps, out_dir: "demo/d3" }, { security: { gateway: false, permission_mode: "plan" } });
    ok(ro.r.isError && /写录屏被安全中心拦截/.test(ro.r.content), "只看不动：写录屏被拦", ro.r.content);
    eq([seen.length, B.calls], [s0, n0], "  └ 录制器没进、浏览器没开");

    // 反向对照 ③：out_dir 跳出工作区，同样不进录制器
    const esc = await call({ steps, out_dir: "../outside" });
    ok(esc.r.isError && /跳出工作区/.test(esc.r.content), "out_dir 跳出工作区：拒", esc.r.content);
    eq(seen.length, s0, "  └ 录制器没进");

    // 反向对照 ④：已经点了停止，回「用户已停止任务」而不是当成故障（模型看到故障会换参数重来）
    const ac = new AbortController();
    ac.abort();
    const st = await call({ steps, out_dir: "demo/d4" }, { signal: ac.signal });
    ok(st.r.isError && st.r.stopped === true && /用户已停止任务/.test(st.r.content), "停止：按停止回话", JSON.stringify(st.r));
    eq(B.calls, n0, "  └ 浏览器没开");
  } finally {
    REC.runTool = orig;
    await dt.close();
  }
});

(async () => {
  const only = String(process.env.WEB_DEMO_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  for (const s of SECTIONS.slice().sort((a, b) => a.n - b.n)) {
    if (only.length && !only.includes(s.n)) continue;
    console.log(`\n【${s.n}】${s.title}`);
    try { await s.fn(); } catch (e) { fail++; console.error("  ❌ 这一段自己挂了：", e && e.stack || e); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(fail === 0 ? `\n√ web-demo：${pass} 条通过` : `\n× web-demo：${pass} 条通过，${fail} 条失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("套件自己挂了：", e); process.exit(1); });
