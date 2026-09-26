"use strict";
/**
 * 交付页（delivery_page）的测试。
 *
 * 盯四件事，每件都配反向对照（只会变绿的断言不是测试）：
 *   ① 清单校验：缺文件要一次列全、不出页；链接/..目录外路径不收；数量不够照实记进「还差这些」。
 *   ② 页面本身：各画幅都有 <video> 且 aspect-ratio 对得上；标题和平台文案都有复制按钮；
 *      不引任何外链；中文不加字距；有深色模式；用户写的字全转义（包括 JSON 块里的 </script>）；
 *      内联脚本能编译；不带 emoji。
 *   ③ 工具入口：量出来是横的却声明 9:16 → 报错不出页；没 ffprobe → 出页但说没核对；清单坏了说清楚。
 *   ④ 真 ffprobe（本机有才跑）：真视频、带旋转的竖屏都按显示方向判。
 *
 * 全程在 owb- 临时目录里跑，不碰真实数据目录和工作区。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-delivery-page-"));
process.env.OPENWORKBUDDY_HOME = TMP;

const ROOT = path.join(__dirname, "..");
const DP = require(path.join(ROOT, "delivery-page"));
const { normalize, render, runTool, TOOL_DEFS, MANIFEST_NAME, PAGE_NAME, _internals: I } = DP;

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 600) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });
const has = (s, sub, msg) => ok(String(s).includes(sub), msg, { missing: sub, in: String(s).slice(0, 400) });
const lacks = (s, sub, msg) => ok(!String(s).includes(sub), msg, { unexpected: sub });

let seq = 0;
/** 新建一个任务目录，按 files 放空文件（探针是注入的，内容不重要） */
function taskDir(files = [], name) {
  const d = path.join(TMP, "work", name || `任务_${++seq}`);
  fs.mkdirSync(d, { recursive: true });
  for (const f of files) {
    const p = path.join(d, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x");
  }
  return d;
}
const writeJson = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
/** 按文件名给尺寸的假探针：名字里带 9x16 就是 1080×1920，以此类推 */
const SIZES = { "9x16": [1080, 1920], "16x9": [1920, 1080], "1x1": [1080, 1080], "4x5": [1080, 1350] };
function fakeProbe(over = {}) {
  const calls = [];
  const fn = async (abs) => {
    calls.push(abs);
    const b = path.basename(abs);
    if (Object.prototype.hasOwnProperty.call(over, b)) return over[b];
    for (const [k, [w, h]] of Object.entries(SIZES)) if (b.includes(k)) return { w, h, dur: 12.5 };
    return { w: 1920, h: 1080, dur: 3 };
  };
  fn.calls = calls;
  return fn;
}
const NOW = new Date(2026, 8, 26, 9, 5);

function fullManifest() {
  return {
    title: "春日新品 · 宣传片",
    summary: "两条成片 + 三张封面 + 三个标题 + 三个平台文案。",
    recipe: "promo-video",
    videos: [{ aspect: "9:16", file: "成片_9x16.mp4" }, { aspect: "16:9", file: "成片_16x9.mp4", label: "横版 B站" }],
    covers: [{ file: "封面_A.png", note: "大字标题" }, { file: "封面_B.png" }, "封面_C.png"],
    titles: ["标题一", "标题二", { text: "标题三" }],
    platforms: [
      { name: "小红书", title: "小红书标题", body: "正文第一段\n第二段", tags: ["#春日", "新品", "春日"] },
      { name: "抖音", body: "抖音正文", tags: "探店 好物" },
      { name: "B站", title: "B站标题", body: "B站正文" },
    ],
    assumptions: ["默认用品牌主色"],
    missing: [{ what: "英文版", why: "表单没选" }],
    cost: { text: "单价未知" },
  };
}
const FULL_FILES = ["成片_9x16.mp4", "成片_16x9.mp4", "封面_A.png", "封面_B.png", "封面_C.png"];

(async () => {
  // ───────────────────────── ① relPath / normalize ─────────────────────────
  console.log("\n① 路径与清单校验");
  {
    const d = taskDir([], "路径");
    eq(I.relPath("./a/b.mp4", d).rel, "a/b.mp4", "./ 前缀去掉");
    eq(I.relPath("a\\b.mp4", d).rel, "a/b.mp4", "反斜杠当分隔符");
    eq(I.relPath(path.join(d, "x.mp4"), d).rel, "x.mp4", "任务目录里的绝对路径转成相对");
    ok(/任务目录外面/.test(I.relPath("/etc/passwd.png", d).err || ""), "目录外的绝对路径不收");
    ok(/\.\./.test(I.relPath("../x.mp4", d).err || ""), ".. 不收");
    ok(/\.\./.test(I.relPath("a/../../x.mp4", d).err || ""), "中间夹 .. 也不收");
    ok(/链接/.test(I.relPath("https://cdn.example.com/a.mp4", d).err || ""), "http 链接不收");
    ok(/链接/.test(I.relPath("data:image/png;base64,AAAA", d).err || ""), "data: 不收");
    ok(/链接/.test(I.relPath("file:///tmp/a.png", d).err || ""), "file: 不收");
    ok(I.relPath("", d).err !== undefined, "空路径报错");
    // 反向对照：正常的中文文件名、带空格的文件名要能过
    eq(I.relPath("成片 最终版.mp4", d).rel, "成片 最终版.mp4", "（对照）带空格的中文文件名照收");

    eq(I.normAspect("9x16"), "9:16", "9x16 → 9:16");
    eq(I.normAspect("9：16"), "9:16", "全角冒号认");
    eq(I.normAspect(" 16 × 9 "), "16:9", "× 和空格认");
    eq(I.normAspect("4/5"), "4:5", "斜杠认");
    eq(I.normAspect("3:2"), "", "（对照）不认识的画幅给空");
    eq(I.nearestAspect(1080, 1920), "9:16", "1080×1920 是 9:16");
    eq(I.nearestAspect(1088, 1920), "9:16", "编码对齐的 1088×1920 也算 9:16");
    eq(I.nearestAspect(1440, 1080), "", "（对照）4:3 不硬套");
  }
  {
    const d = taskDir(FULL_FILES);
    const { m, errors, warnings } = normalize(fullManifest(), { dir: d });
    eq(errors.length, 0, "完整清单没错", errors);
    eq(m.videos.length, 2, "两条成片");
    eq(m.covers.length, 3, "三张封面（字符串写法也收）");
    eq(m.titles.length, 3, "三个标题（对象写法也收）");
    eq(JSON.stringify(m.platforms[0].tags), JSON.stringify(["春日", "新品"]), "话题去 # 去重");
    eq(JSON.stringify(m.platforms[1].tags), JSON.stringify(["探店", "好物"]), "话题写成字符串也拆开");
    eq(m.missing[0], "英文版：表单没选", "missing 的 {what, why} 拼成一句");
    eq(m.cost, "单价未知", "「单价未知」原样过");
    eq(m.gaps.length, 0, "配方要的都齐了，没有「还差」", m.gaps);
    eq(warnings.length, 0, "没有提醒", warnings);
  }
  {
    // 缺文件：一次列全，不是只报第一个
    const d = taskDir(["成片_9x16.mp4", "封面_A.png"]);
    const { errors } = normalize(fullManifest(), { dir: d });
    const e = errors.join("\n");
    has(e, "找不到（3 个）", "缺 3 个文件说 3 个");
    has(e, "成片_16x9.mp4", "缺的成片点名");
    has(e, "封面_B.png", "缺的封面 B 点名");
    has(e, "封面_C.png", "缺的封面 C 点名");
    lacks(e, "成片_9x16.mp4", "（对照）在的文件不点名");
    has(e, "missing", "告诉模型没做出来就写进 missing");
  }
  {
    // 模型把任务目录名又拼了一遍：剥掉那层
    const d = taskDir(["成片_9x16.mp4"], "任务_重拼");
    const { m, errors } = normalize({ title: "t", videos: [{ aspect: "9:16", file: "任务_重拼/成片_9x16.mp4" }] }, { dir: d });
    eq(errors.length, 0, "多拼一层目录名能认出来", errors);
    eq(m.videos[0] && m.videos[0].file, "成片_9x16.mp4", "剥成目录内路径");
  }
  {
    const d = taskDir(["a.mkv", "b.psd", "c.mp4", "sub/d.png"]);
    const { errors } = normalize({
      title: "t",
      videos: [{ aspect: "9:16", file: "a.mkv" }, { aspect: "3:2", file: "c.mp4" }],
      covers: ["b.psd", "sub/d.png"],
      platforms: [{ name: "", body: "x" }, { name: "小红书" }],
    }, { dir: d });
    const e = errors.join("\n");
    has(e, "a.mkv 浏览器播不了", "mkv 当场报错");
    has(e, "b.psd 浏览器显示不了", "psd 当场报错");
    has(e, "3:2", "不认识的画幅报错");
    has(e, "没写 name", "平台没名字报错");
    has(e, "没写 body", "平台没正文报错");
    lacks(e, "sub/d.png", "（对照）子目录里的 png 照收");
  }
  {
    const d = taskDir([]);
    ok(normalize({ title: "t" }, { dir: d }).errors.some((x) => /一样成品都没有/.test(x)), "什么都没有的清单报错");
    ok(normalize({ titles: ["a"] }, { dir: d }).errors.some((x) => /缺 title/.test(x)), "缺 title 报错");
    ok(normalize([], { dir: d }).errors.length === 1, "顶层是数组报错");
    ok(normalize({ title: "t", videos: "a.mp4" }, { dir: d }).errors.some((x) => /数组/.test(x)), "videos 不是数组报错");
    eq(normalize({ title: "t", titles: ["a"] }, { dir: d }).errors.length, 0, "（对照）只有标题也能出页");
  }
  {
    // 软链指到外面：不收（页面拷走就断了）
    const d = taskDir([]);
    const outside = path.join(TMP, "外面.png");
    fs.writeFileSync(outside, "x");
    let linked = true;
    try { fs.symlinkSync(outside, path.join(d, "封面.png")); } catch { linked = false; }
    if (linked) {
      const { errors } = normalize({ title: "t", covers: ["封面.png"] }, { dir: d });
      ok(errors.some((x) => /指到了任务目录外面/.test(x)), "软链指到目录外报错", errors);
      fs.mkdirSync(path.join(d, "图"), { recursive: true });
      fs.writeFileSync(path.join(d, "图", "真.png"), "x");
      fs.symlinkSync(path.join(d, "图", "真.png"), path.join(d, "内链.png"));
      eq(normalize({ title: "t", covers: ["内链.png"] }, { dir: d }).errors.length, 0, "（对照）目录内的软链照收");
    } else console.log("  - 跳过：本机建不了软链");
  }
  {
    // 数量对不上：少了记进 gaps（页面照实列），多了只提醒
    const d = taskDir(["成片_9x16.mp4", "封面_A.png", "封面_B.png", "c1.png", "c2.png", "c3.png", "c4.png"]);
    const r1 = normalize({
      title: "t", recipe: "promo-video", videos: ["成片_9x16.mp4"], covers: ["封面_A.png", "封面_B.png"],
      titles: ["a", "b", "c", "d"], platforms: [{ name: "抖音", body: "x" }],
    }, { dir: d });
    ok(r1.m.gaps.includes("封面只有 2 张，配方要 3 张"), "封面少一张记进还差", r1.m.gaps);
    ok(r1.warnings.includes("封面只有 2 张，配方要 3 张"), "也提醒模型");
    ok(r1.warnings.some((w) => /标题候选有 4 个/.test(w)), "标题多了提醒");
    ok(!r1.m.gaps.some((g) => /标题/.test(g)), "（对照）标题多了不算还差");
    const r2 = normalize({ title: "t", recipe: "multi-post", titles: ["a", "b", "c"], platforms: [{ name: "知乎", body: "x" }] }, { dir: d });
    eq(r2.m.gaps.length, 0, "一稿多投没封面不算缺", r2.m.gaps);
    const r3 = normalize({ title: "t", recipe: "multi-post", covers: ["c1.png"], titles: ["a", "b", "c"], platforms: [{ name: "知乎", body: "x" }] }, { dir: d });
    ok(r3.m.gaps.some((g) => /封面只有 1 张/.test(g)), "一稿多投给了封面但不够 3 张算缺");
    const r4 = normalize({ title: "t", recipe: "xhs-carousel", covers: ["c1.png", "c2.png", "c3.png"], titles: ["a", "b", "c"], platforms: [{ name: "小红书", body: "x" }] }, { dir: d });
    ok(r4.m.gaps.includes("没有图组，这个配方要出图"), "小红书图文没图组算缺");
    const r5 = normalize({ title: "t", titles: ["a"] }, { dir: d });
    eq(r5.m.gaps.length, 0, "（对照）不知道是哪个配方就不核数量");
    const r6 = normalize({ title: "t", recipe: "Promo Video!", titles: ["a"] }, { dir: d });
    ok(r6.warnings.some((w) => /不是配方名/.test(w)), "recipe 写得不像配方名要说");
  }
  {
    // 拿表单核：图组张数、平台
    const d = taskDir(["p1.png", "p2.png", "p3.png", "c1.png", "c2.png", "c3.png"]);
    const form = { id: "xhs-carousel", title: "小红书图文", values: { count: "5", platforms: ["小红书", "抖音"] } };
    const r = normalize({
      title: "t", images: ["p1.png", "p2.png", "p3.png"], covers: ["c1.png", "c2.png", "c3.png"],
      titles: ["a", "b", "c"], platforms: [{ name: "小红书", body: "x" }],
    }, { dir: d, form });
    eq(r.m.recipe, "xhs-carousel", "清单没写 recipe 时用表单的");
    eq(r.m.kicker, "小红书图文", "页眉带表单标题");
    ok(r.m.gaps.includes("图组只有 3 张，表单要 5 张"), "图组张数不够记进还差", r.m.gaps);
    ok(r.m.gaps.includes("表单要了抖音的文案，清单里没有"), "表单要的平台缺了记进还差");
    ok(!r.m.gaps.some((g) => /小红书的文案/.test(g)), "（对照）给了的平台不算缺");
    const r2 = normalize({ title: "t", recipe: "promo-video", titles: ["a", "b", "c"] }, { dir: d, form });
    ok(!r2.m.gaps.some((g) => /图组|抖音的文案/.test(g)), "（对照）表单是别的配方就不拿它核");
    const r3 = normalize({ title: "t", images: ["p1.png"], titles: ["a", "b", "c"], covers: ["c1.png", "c2.png", "c3.png"], platforms: [{ name: "小红书", body: "x" }] },
      { dir: d, form: { id: "xhs-carousel", values: { count: "随便", platforms: ["douyin"] } } });
    ok(!r3.m.gaps.some((g) => /表单要/.test(g)), "（对照）看不懂的表单值不核");
  }
  {
    // 截断要说
    const d = taskDir([]);
    const long = "字".repeat(120);
    const r = normalize({ title: long, titles: [long] }, { dir: d });
    eq(Array.from(r.m.title).length, 80, "标题截到 80 字");
    ok(r.warnings.some((w) => /title 超过 80 字/.test(w)), "截了要说");
    const body = "文".repeat(6000);
    const r2 = normalize({ title: "t", platforms: [{ name: "公众号", body }] }, { dir: d });
    eq(r2.m.platforms[0].body.length, 6000, "公众号长文 6000 字不截");
    eq(r2.warnings.length, 0, "（对照）没截就不提醒");
  }

  // ───────────────────────── ② render ─────────────────────────
  console.log("\n② 页面");
  const d0 = taskDir(FULL_FILES);
  const base = normalize(fullManifest(), { dir: d0 }).m;
  base.videos[0].w = 1080; base.videos[0].h = 1920; base.videos[0].dur = 12.5;
  const html = render(base, { now: NOW });
  {
    eq((html.match(/<video /g) || []).length, 2, "两条成片两个 <video>");
    has(html, 'src="%E6%88%90%E7%89%87_9x16.mp4"', "视频走相对路径（逐段编码）");
    ok(/controls playsinline preload="metadata"/.test(html), "能播、手机上不自动全屏、不预载整条");
    has(html, "aspect-ratio:9/16", "竖版框是 9:16");
    has(html, "aspect-ratio:16/9", "横版框是 16:9");
    has(html, "竖版 9:16 · 抖音/视频号", "tab 写明画幅和给哪个平台");
    has(html, ">横版 B站<", "自己写的 label 优先");
    eq((html.match(/role="tab"/g) || []).length, 2, "两个 tab");
    ok(/id="v-1"[^>]*hidden/.test(html), "第二个 tab 默认收起");
    ok(!/id="v-0"[^>]*hidden/.test(html), "（对照）第一个 tab 默认展开");
    has(html, "1080×1920 · 12.5 秒", "量出来的尺寸和时长写上");
    ok((html.match(/download>下载</g) || []).length >= 5, "成片和封面都能下载");
    eq((html.match(/<img src="[^"]*%E5%B0%81%E9%9D%A2_/g) || []).length, 3, "三张封面图");
    has(html, "<b>A</b>大字标题", "封面按 A/B/C 标");
    has(html, "<b>C</b>", "第三张是 C");
    eq((html.match(/class="card row"/g) || []).length, 3, "三行标题");
    eq((html.match(/data-copy="\d+">复制</g) || []).length, 3, "每行标题一个复制");
    eq((html.match(/>复制标题</g) || []).length, 2, "有标题的平台才有「复制标题」");
    eq((html.match(/>复制正文</g) || []).length, 3, "每个平台一个「复制正文」");
    has(html, "还差这些", "有 missing 就有「还差这些」");
    has(html, "英文版：表单没选", "missing 照实列出");
    has(html, "替你做的假设", "假设照列");
    has(html, "费用：单价未知", "费用照写");
    has(html, "2 条成片 / 3 张封面 / 3 个标题 / 3 个平台", "页眉数量");
    has(html, "2026-09-26 09:05", "页眉时间");
    has(html, '<html lang="zh-CN">', "lang 是中文");
    has(html, '<meta name="viewport"', "手机能看");
    has(html, '<meta name="owb-delivery" content="1">', "带交付页标记");
    has(html, "<title>春日新品 · 宣传片 · 交付</title>", "标题");
    has(html, "发布时记得勾选", "页脚提醒 AI 声明");

    // 复制原文：JSON 块里有，正文复制连话题
    const cj = /<script type="application\/json" id="owb-copy">([\s\S]*?)<\/script>/.exec(html);
    ok(!!cj, "复制原文放在 JSON 块里");
    const copies = cj ? JSON.parse(cj[1]) : [];
    ok(copies.includes("标题一") && copies.includes("标题三"), "标题原文可复制");
    ok(copies.includes("正文第一段\n第二段\n\n#春日 #新品"), "正文复制连话题、保留换行", copies);
    ok(copies.includes("抖音正文\n\n#探店 #好物"), "字符串话题也拼上");
    ok(copies.includes("B站正文"), "（对照）没话题就不加空行");
    // 每个 data-copy 都有对应 id 的元素（选中兜底要用）
    const ids = [...html.matchAll(/data-copy="(\d+)"/g)].map((x) => x[1]);
    ok(ids.length === copies.length && ids.every((n) => html.includes(`id="c${n}"`)), "每个复制按钮都有能选中的原文元素");

    // 不引外链
    const refs = [...html.matchAll(/\b(?:src|href|action|poster)="([^"]*)"/g)].map((x) => x[1]);
    ok(refs.length > 0 && refs.every((u) => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(u)), "所有 src/href 都是相对路径", refs.filter((u) => /:|^\/\//.test(u)));
    ok(!/https?:\/\//.test(html), "页面里没有 http(s) 链接");
    ok(!/@import|url\(|<link\b/i.test(html), "没有外部样式、字体、url()");
    // 反向对照：扫描器抓得到外链
    ok(/https?:\/\//.test(html.replace("</main>", '<img src="https://x.com/a.png"></main>')), "（对照）塞个外链能扫出来");

    // 中文不加字距
    const ls = [...html.matchAll(/letter-spacing\s*:\s*([^;}"]+)/g)].map((x) => x[1].trim());
    ok(ls.every((v) => v === "0" || v === "normal"), "letter-spacing 只有 0", ls);
    // 颜色：tokens + 深色模式 + body 显式背景
    ok(/:root\{--bg:[^}]*--surface:[^}]*--text:[^}]*--brand:/.test(html), ":root 上有颜色 token");
    ok(/@media \(prefers-color-scheme:dark\)\{:root\{--bg:/.test(html), "有深色模式");
    ok(/body\{[^}]*background:var\(--bg\)/.test(html), "body 显式背景");
    const hexes = new Set((html.match(/#[0-9a-f]{6}\b/gi) || []).map((x) => x.toLowerCase()));
    ok(hexes.size <= 8, "颜色只有 4 个（亮暗各一套）", [...hexes]);
    // 间距：px 都是 4 的倍数（边框 1/2px 不是间距，border-top 这类不算）
    const spacingPx = (css) => (css.match(/(?<![\w-])(?:margin|padding|gap|top|bottom|left|right)(?:-[a-z]+)?\s*:[^;{}]*/g) || [])
      .flatMap((d) => [...d.matchAll(/(\d+)px/g)].map((x) => +x[1])).filter((n) => n % 4);
    eq(spacingPx(I.CSS).length, 0, "间距都是 4 的倍数", spacingPx(I.CSS));
    eq(JSON.stringify(spacingPx(".a{padding:6px 12px;border-top:1px solid}")), "[6]", "（对照）6px 抓得到、边框不误抓");

    // 没有 emoji
    const PICT = /\p{Extended_Pictographic}/u;
    const src = fs.readFileSync(path.join(ROOT, "delivery-page.js"), "utf8");
    const bad = [...html].filter((c) => PICT.test(c) && !"©®".includes(c));
    eq(bad.length, 0, "页面没有 emoji", bad);
    eq([...src].filter((c) => PICT.test(c) && !"©®".includes(c)).length, 0, "源码没有 emoji");
    ok(PICT.test("\u{1F600}"), "（对照）emoji 扫描器抓得到");
    ok(!/水印|watermark/i.test(html), "页面不带水印字样");

    // 内联脚本能编译
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
    eq(scripts.length, 1, "一段内联脚本");
    let compiled = true;
    try { new vm.Script(scripts[0]); } catch (e) { compiled = String(e); }
    eq(compiled, true, "内联脚本能编译");
    let broken = true;
    try { new vm.Script(scripts[0] + "{"); broken = false; } catch { /* 应当编译失败 */ }
    ok(broken, "（对照）坏脚本编译不过");
    ok(!/=>|\blet\b|\bconst\b|`/.test(I.SCRIPT), "页面脚本是 ES5（老内核也能跑）");
    has(I.SCRIPT, "isSecureContext", "clipboard 只在安全上下文用");
    has(I.SCRIPT, "execCommand", "沙盒里退到 execCommand");
    has(I.SCRIPT, "已选中，按 ⌘C / Ctrl+C", "都不行就选中让人自己复制");
  }
  {
    // 用户的字全转义：标题、正文、note、文件名
    const d = taskDir(["a&b.png", "v.mp4"]);
    const evil = '<img src=x onerror=alert(1)>"\'</script><script>alert(2)</script> ';
    const r = normalize({
      title: evil, summary: evil, covers: [{ file: "a&b.png", note: evil }], titles: [evil],
      videos: [{ aspect: "1:1", file: "v.mp4", label: evil }],
      platforms: [{ name: "小红书", title: evil, body: evil + "\n</script>", tags: [evil] }], assumptions: [evil], missing: [evil],
    }, { dir: d });
    eq(r.errors.length, 0, "恶意文字不影响校验", r.errors);
    const h = render(r.m, { now: NOW });
    // JSON 块里只转 <（> 在 type=application/json 里不起作用），所以扫 HTML 时先把它拿掉
    const markup = h.replace(/<script type="application\/json" id="owb-copy">[\s\S]*?<\/script>/, "");
    lacks(h, "<img src=x", "尖括号转义");
    lacks(markup, "onerror=alert(1)>", "属性注入挡住");
    lacks(markup, "\"'", "引号转义");
    eq((h.match(/<\/script>/g) || []).length, 2, "</script> 只剩页面自己的两个");
    eq((h.match(/<script/g) || []).length, 2, "<script 只剩页面自己的两个");
    has(h, 'src="a%26b.png"', "文件名里的 & 编码");
    const cj = /<script type="application\/json" id="owb-copy">([\s\S]*?)<\/script>/.exec(h);
    let parsed = null;
    try { parsed = JSON.parse(cj ? cj[1] : ""); } catch { parsed = null; }
    ok(Array.isArray(parsed) && parsed.some((x) => x.includes("</script>")), "JSON 块解析回来原文完整（含 </script>）");
    lacks(cj ? cj[1] : "", " ", "JSON 块里 U+2028 转义");
    // 反向对照：不转义的话会被抓到
    ok(/<img src=x/.test(`<p>${evil}</p>`), "（对照）没转义能扫出来");
  }
  {
    // 图组：手机框、翻页、缩略图、说明
    const d = taskDir(["p1.png", "p2.png", "p3.png"]);
    const r = normalize({ title: "t", images: [{ file: "p1.png", note: "封面页" }, "p2.png", { file: "p3.png", note: "结尾" }] }, { dir: d });
    const h = render(r.m, { now: NOW });
    has(h, 'class="phone"', "手机框");
    has(h, 'id="track"', "可滑动轨道");
    eq((h.match(/class="slide"/g) || []).length, 3, "三张图");
    has(h, ">上一张<", "上一张");
    has(h, ">下一张<", "下一张");
    has(h, "1 / 3", "页码");
    eq((h.match(/data-slide="\d"/g) || []).length, 3, "三个缩略图");
    has(h, 'id="capnote">封面页<', "第一张说明先显示");
    has(h, 'data-note="结尾"', "每张带说明");
    const one = render(normalize({ title: "t", images: ["p1.png"] }, { dir: d }).m, { now: NOW });
    lacks(one, ">下一张<", "（对照）一张图不出翻页");
    lacks(one, "还差这些", "（对照）没有缺的就不出「还差这些」");
    const single = render(normalize({ title: "t", videos: [{ aspect: "4:5", file: "p1.png" }] }, { dir: taskDir(["p1.png"]) }).m);
    lacks(single, "<video", "（对照）图片冒充视频被挡在校验里，不会渲染");
  }
  {
    // 单条成片不出 tab；同画幅两条 tab 名不撞
    const d = taskDir(["a_9x16.mp4", "b_9x16.mp4"]);
    const one = render(normalize({ title: "t", videos: [{ aspect: "9:16", file: "a_9x16.mp4" }] }, { dir: d }).m);
    lacks(one, 'role="tab"', "一条成片不出 tab");
    has(one, "竖版 9:16 · 抖音/视频号 · ", "一条成片把画幅写在说明里");
    const two = render(normalize({ title: "t", videos: [{ aspect: "9:16", file: "a_9x16.mp4" }, { aspect: "9:16", file: "b_9x16.mp4" }] }, { dir: d }).m);
    has(two, "竖版 9:16 · 抖音/视频号（2）", "同画幅第二条加序号");
  }

  // ───────────────────────── ③ runTool ─────────────────────────
  console.log("\n③ 工具入口");
  {
    const d = taskDir(FULL_FILES);
    writeJson(d, MANIFEST_NAME, fullManifest());
    const probe = fakeProbe();
    const r = await runTool({}, { dir: d, probe, now: NOW });
    eq(r.isError, false, "完整清单出页", r.content);
    has(r.content, `已生成 ${PAGE_NAME}（2 条成片 / 3 张封面 / 3 个标题 / 3 个平台）`, "回话说出了几样");
    has(r.content, "在浏览器打开", "告诉模型怎么让用户看");
    eq(probe.calls.length, 2, "两条成片各量一次");
    const page = fs.readFileSync(path.join(d, PAGE_NAME), "utf8");
    has(page, "成片画幅已用 ffprobe 核对", "页脚写明核对过");
    ok(!fs.readdirSync(d).some((f) => /\.bak$|\.tmp/.test(f)), "不留 .bak / 临时文件", fs.readdirSync(d));
    // 再跑一次覆盖也不留 .bak
    await runTool({}, { dir: d, probe, now: NOW });
    ok(!fs.readdirSync(d).some((f) => /\.bak$|\.tmp/.test(f)), "覆盖重写也不留 .bak");
  }
  {
    // 缺文件：不出页，全部点名
    const d = taskDir(["成片_9x16.mp4"]);
    writeJson(d, MANIFEST_NAME, fullManifest());
    const probe = fakeProbe();
    const r = await runTool({}, { dir: d, probe });
    eq(r.isError, true, "缺文件报错");
    for (const f of ["成片_16x9.mp4", "封面_A.png", "封面_B.png", "封面_C.png"]) has(r.content, f, `点名 ${f}`);
    has(r.content, "交付页没生成", "说清楚没生成");
    ok(!fs.existsSync(path.join(d, PAGE_NAME)), "不写页面");
    eq(probe.calls.length, 0, "清单有错就不去量视频");
  }
  {
    // 声明 9:16，量出来是横的
    const d = taskDir(["成片_9x16.mp4", "t.png"]);
    writeJson(d, MANIFEST_NAME, { title: "t", videos: [{ aspect: "9:16", file: "成片_9x16.mp4" }] });
    const r = await runTool({}, { dir: d, probe: fakeProbe({ "成片_9x16.mp4": { w: 1920, h: 1080, dur: 3 } }) });
    eq(r.isError, true, "画幅对不上报错");
    has(r.content, "成片_9x16.mp4 实际是 1920×1080，不是 9:16", "说出实际尺寸");
    ok(!fs.existsSync(path.join(d, PAGE_NAME)), "不写页面");
    const r2 = await runTool({}, { dir: d, probe: fakeProbe({ "成片_9x16.mp4": { w: 1088, h: 1920 } }) });
    eq(r2.isError, false, "（对照）差 3% 以内算对", r2.content);
  }
  {
    // 没 ffprobe：出页，但说没核对
    const d = taskDir(["a.mp4"]);
    writeJson(d, MANIFEST_NAME, { title: "t", videos: [{ aspect: "9:16", file: "a.mp4" }] });
    const r = await runTool({}, { dir: d, probe: async () => null });
    eq(r.isError, false, "没 ffprobe 也出页");
    has(r.content, "没装 ffprobe，没核对画幅", "回话说没核对");
    has(fs.readFileSync(path.join(d, PAGE_NAME), "utf8"), "没用 ffprobe 核对过", "页面上也照实写");
    const r2 = await runTool({}, { dir: d, probe: async () => ({ skip: "ffprobe 没跑成，没核对画幅：超时" }) });
    eq(r2.isError, false, "skip 也出页");
    has(r2.content, "超时", "skip 的原因带出来");
    const r3 = await runTool({}, { dir: d, probe: async () => ({ bad: "ffprobe 读不懂，文件可能坏了或不是视频" }) });
    eq(r3.isError, true, "读不懂的视频报错");
    has(r3.content, "a.mp4 ffprobe 读不懂", "点名哪个文件");
    const r4 = await runTool({}, { dir: d, probe: async () => { throw new Error("炸了"); } });
    eq(r4.isError, false, "探针自己抛错按没核对处理");
    has(r4.content, "炸了", "原因带出来");
    const ac = new AbortController();
    ac.abort();
    const r5 = await runTool({}, { dir: d, probe: async () => null, signal: ac.signal });
    eq(r5.isError, true, "已停止就不出页");
    has(r5.content, "已停止", "说已停止");
  }
  {
    // 没写 aspect：靠量出来；量不了就报错
    const d = taskDir(["x.mp4", "y.mp4"]);
    writeJson(d, MANIFEST_NAME, { title: "t", videos: ["x.mp4", "y.mp4"] });
    const r = await runTool({}, { dir: d, probe: fakeProbe({ "x.mp4": { w: 1080, h: 1080 }, "y.mp4": { w: 1440, h: 1080 } }) });
    eq(r.isError, false, "没写 aspect 也能出页", r.content);
    const page = fs.readFileSync(path.join(d, PAGE_NAME), "utf8");
    has(page, "方版 1:1", "1080×1080 认成方版");
    has(page, "aspect-ratio:1440/1080", "认不出的画幅按实际尺寸摆");
    has(page, ">1440×1080<", "tab 名写实际尺寸");
    const r2 = await runTool({}, { dir: d, probe: async () => null });
    eq(r2.isError, true, "没写 aspect 又量不了就报错");
    has(r2.content, "没写 aspect，也量不了", "说要写 aspect");
  }
  {
    // 表单要的画幅：量完才核
    const d = taskDir(["a.mp4", "c1.png", "c2.png", "c3.png"]);
    writeJson(d, "配方表单.json", { id: "promo-video", title: "产品宣传片", values: { aspects: ["9:16", "16:9"], platforms: ["抖音"] } });
    writeJson(d, MANIFEST_NAME, {
      title: "t", videos: ["a.mp4"], covers: ["c1.png", "c2.png", "c3.png"], titles: ["1", "2", "3"], platforms: [{ name: "抖音", body: "x" }],
    });
    const r = await runTool({}, { dir: d, probe: fakeProbe({ "a.mp4": { w: 1080, h: 1920 } }) });
    eq(r.isError, false, "少个画幅照出页", r.content);
    has(r.content, "表单要了横版 16:9，成片里没有", "回话提醒少了横版");
    const page = fs.readFileSync(path.join(d, PAGE_NAME), "utf8");
    has(page, "表单要了横版 16:9，成片里没有", "页面「还差这些」照实列");
    lacks(page, "表单要了竖版 9:16", "（对照）量出来是竖版的不算缺");
    has(page, "交付 · 产品宣传片 · ", "页眉带表单标题");
    // 表单文件坏了：当没有，不动它
    writeJson(d, "配方表单.json", "{坏的");
    const r2 = await runTool({}, { dir: d, probe: fakeProbe({ "a.mp4": { w: 1080, h: 1920 } }) });
    eq(r2.isError, false, "表单坏了照出页");
    eq(fs.readFileSync(path.join(d, "配方表单.json"), "utf8"), "{坏的", "坏表单原样留着（不隔离、不改名）");
  }
  {
    // 入参和清单本身的错
    const d = taskDir([]);
    const r1 = await runTool({}, { dir: d, probe: fakeProbe() });
    eq(r1.isError, true, "没清单报错");
    has(r1.content, "write_file", "告诉模型先写清单");
    has(r1.content, '"videos"', "带上格式");
    writeJson(d, MANIFEST_NAME, "{ not json");
    const r2 = await runTool({}, { dir: d, probe: fakeProbe() });
    eq(r2.isError, true, "坏 JSON 报错");
    has(r2.content, "不是合法 JSON", "说不是合法 JSON");
    writeJson(d, MANIFEST_NAME, "﻿" + JSON.stringify({ title: "t", titles: ["a"] }));
    eq((await runTool({}, { dir: d })).isError, false, "（对照）带 BOM 的清单照读");
    for (const out of ["../x.html", "a/b.html", "x.txt", ".hidden.html", "x.html/"]) {
      eq((await runTool({ out }, { dir: d })).isError, true, `out=${out} 不收`);
    }
    const ok2 = await runTool({ out: "交付_v2.html" }, { dir: d });
    eq(ok2.isError, false, "（对照）自定义文件名照收");
    ok(fs.existsSync(path.join(d, "交付_v2.html")), "写到自定义文件名");
    eq((await runTool({ manifest: "../x.json" }, { dir: d })).isError, true, "清单路径带 .. 不收");
    eq((await runTool({}, {})).isError, true, "没给 dir 报错");
    fs.mkdirSync(path.join(d, "sub"));
    writeJson(path.join(d, "sub"), "m.json", { title: "t2", titles: ["a"] });
    eq((await runTool({ manifest: "sub/m.json" }, { dir: d })).isError, false, "子目录里的清单照读");
  }

  // ───────────────────────── ④ parseProbe ─────────────────────────
  console.log("\n④ ffprobe 输出解析");
  {
    const p = (s, f) => I.parseProbe({ streams: s, format: f || {} });
    eq(JSON.stringify(p([{ codec_type: "video", width: 1920, height: 1080, duration: "3.5" }])), JSON.stringify({ w: 1920, h: 1080, dur: 3.5 }), "普通横版");
    eq(JSON.stringify(p([{ codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], { duration: "2" })),
      JSON.stringify({ w: 1080, h: 1920, dur: 2 }), "旋转 -90（新版 side_data）按竖版算，时长取 format");
    eq(JSON.stringify(p([{ codec_type: "video", width: 1920, height: 1080, tags: { rotate: "270" } }])), JSON.stringify({ w: 1080, h: 1920, dur: 0 }), "旧版 tags.rotate 也认");
    eq(JSON.stringify(p([{ codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }])), JSON.stringify({ w: 1920, h: 1080, dur: 0 }), "（对照）转 180 不换宽高");
    eq(JSON.stringify(p([{ codec_type: "video", width: 720, height: 576, sample_aspect_ratio: "64:45" }])), JSON.stringify({ w: 1024, h: 576, dur: 0 }), "非方像素按显示宽度");
    eq(JSON.stringify(p([{ codec_type: "video", width: 720, height: 576, sample_aspect_ratio: "1:1" }])), JSON.stringify({ w: 720, h: 576, dur: 0 }), "（对照）方像素不动");
    ok("bad" in (p([{ codec_type: "audio" }]) || {}), "只有声音算读不出");
    ok("bad" in (p([{ codec_type: "video", width: 0, height: 0 }]) || {}), "宽高是 0 算读不出");
    ok("bad" in (p([{ codec_type: "video", width: 600, height: 600, disposition: { attached_pic: 1 } }]) || {}), "只有封面图算读不出");
    ok("w" in (p([{ codec_type: "video", width: 600, height: 600, disposition: { attached_pic: 1 } }, { codec_type: "video", width: 1280, height: 720 }]) || {}), "（对照）封面图后面有真视频流照读");
    ok("bad" in (I.parseProbe(null) || {}), "空输入算读不出");
  }

  // ───────────────────────── ⑤ 真 ffprobe ─────────────────────────
  console.log("\n⑤ 真 ffprobe");
  {
    const MP = require(path.join(ROOT, "lib", "media-probe"));
    const bins = await MP.resolveMediaBins();
    const need = process.env.OWB_REQUIRE_FFMPEG === "1";
    if (!bins.ffmpeg.bin || !bins.ffprobe.bin) {
      console.log("  - 跳过：本机没有 ffmpeg");
      if (need) ok(false, "OWB_REQUIRE_FFMPEG=1 时必须有 ffmpeg / ffprobe");
    } else {
      const d = taskDir([], "真视频");
      const mk = async (name, size, extra = []) => {
        await MP.runBin(bins.ffmpeg.bin, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=${size}:d=0.4:r=10`,
          "-c:v", "libx264", "-pix_fmt", "yuv420p", ...extra, path.join(d, name)], { timeout: 60000, what: "ffmpeg" });
      };
      let made = true;
      try {
        await mk("竖_9x16.mp4", "108x192");
        await mk("横.mp4", "192x108");
        // 手机式竖屏：画面存成横的 + 旋转矩阵。-display_rotation 是输入端选项（ffmpeg 7+），
        // 老版本没有就退到 rotate 标签——两种 ffprobe 都会报，parseProbe 两种都认
        await MP.runBin(bins.ffmpeg.bin, ["-v", "error", "-y", "-display_rotation", "90", "-i", path.join(d, "横.mp4"), "-c", "copy", path.join(d, "转.mp4")], { timeout: 60000, what: "ffmpeg" })
          .catch(() => MP.runBin(bins.ffmpeg.bin, ["-v", "error", "-y", "-i", path.join(d, "横.mp4"), "-c", "copy", "-metadata:s:v:0", "rotate=90", path.join(d, "转.mp4")], { timeout: 60000, what: "ffmpeg" }));
      } catch (e) {
        made = false;
        // 造不出来是跳过，不是一条「✓」：打成 ✓ 的话，下面那几条真 ffprobe 一条没跑，清单上却是全绿
        const why = String(e && e.message || e).slice(0, 200);
        if (need) ok(false, "造测试视频失败：" + why);
        else console.log("  - 跳过：这台 ffmpeg 造不出测试视频（" + why + "）");
      }
      if (made) {
        const a = await DP.defaultProbe(path.join(d, "竖_9x16.mp4"));
        eq(JSON.stringify(a && "w" in a ? [a.w, a.h] : a), JSON.stringify([108, 192]), "真竖版量出 108×192");
        ok(a && "dur" in a && a.dur > 0.2 && a.dur < 1, "时长量得出", a);
        const rt = await DP.defaultProbe(path.join(d, "转.mp4"));
        eq(JSON.stringify(rt && "w" in rt ? [rt.w, rt.h] : rt), JSON.stringify([108, 192]), "带旋转的按竖版量");
        fs.writeFileSync(path.join(d, "坏.mp4"), "这不是视频");
        const bad = await DP.defaultProbe(path.join(d, "坏.mp4"));
        ok(!!bad && "bad" in bad, "坏文件判成 bad", bad);

        writeJson(d, MANIFEST_NAME, { title: "真", videos: [{ aspect: "9:16", file: "竖_9x16.mp4" }, { aspect: "9:16", file: "转.mp4" }, { aspect: "16:9", file: "横.mp4" }] });
        const r = await runTool({}, { dir: d, now: NOW });
        eq(r.isError, false, "真视频三条都对得上", r.content);
        has(fs.readFileSync(path.join(d, PAGE_NAME), "utf8"), "成片画幅已用 ffprobe 核对", "页脚写明真核对过");
        writeJson(d, MANIFEST_NAME, { title: "真", videos: [{ aspect: "9:16", file: "横.mp4" }] });
        const r2 = await runTool({}, { dir: d, now: NOW });
        eq(r2.isError, true, "（对照）横的说成竖的被真 ffprobe 抓到");
        has(r2.content, "实际是 192×108", "说出真实尺寸");
      }
    }
  }

  // ───────────────────────── ⑥ 工具定义 ─────────────────────────
  console.log("\n⑥ 工具定义");
  {
    eq(TOOL_DEFS.length, 1, "一个工具");
    const t = TOOL_DEFS[0];
    eq(t.name, "delivery_page", "名字 delivery_page");
    eq(t.input_schema.type, "object", "schema 是 object");
    ok(Array.isArray(t.input_schema.required) && t.input_schema.required.length === 0, "两个参数都可省（required 给空表：tool-bridge 按类型读它）", t.input_schema.required);
    ok(Object.keys(t.input_schema.properties).join() === "manifest,out", "只有 manifest / out");
    has(t.description, "不拿占位充数", "描述里写明不拿占位充数");
    has(t.description, "missing", "描述里告诉模型没做出来写 missing");
    has(t.description, MANIFEST_NAME, "描述里写清单文件名");
    ok(Array.from(t.description).length < 1200, "描述别太长", Array.from(t.description).length);
    const src = fs.readFileSync(path.join(ROOT, "delivery-page.js"), "utf8");
    ok(!/\bsay\b/.test(src), "不用 macOS say");
    ok(!/https?:\/\//.test(src), "源码里没有外链");
    eq(src.split("\n")[0], "// @ts-check", "第一行 @ts-check");
  }

  // ───────────────────────── ⑦ 从 tools.executeTool 走一遍 ─────────────────────────
  // 上面测的都是 delivery-page.js 自己；真跑时模型调的是 tools.executeTool。
  // 漏了 TOOL_DEFS 展开或 switch 分支，上面全绿、线上却是一句「未知工具」——这一段就是为了抓这个。
  // 清单只放图不放视频：不量画幅，本机有没有 ffprobe 结论都一样
  console.log("\n⑦ 工具分派（tools.executeTool）");
  {
    const tools = require(path.join(ROOT, "tools"));
    const W = path.join(TMP, "ws-dispatch");
    const base = "任务_分派";
    const d = path.join(W, base);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "卡片_01.png"), "x");
    writeJson(d, MANIFEST_NAME, { title: "分派冒烟", images: [{ file: "卡片_01.png" }], titles: ["标题一"] });
    const events = [];
    const run = (input) => tools.withWorkspace(W, () => tools.executeTool("delivery_page", input, { baseDir: base, onProgress: (e) => events.push(e) }));
    ok(tools.TOOL_DEFS.some((t) => t.name === "delivery_page"), "tools.TOOL_DEFS 里有 delivery_page");
    const r = await run({});
    eq(r.isError, false, "按对话的成果子目录出页", r.content);
    lacks(r.content, "未知工具", "没落到 default 分支");
    ok(fs.existsSync(path.join(d, PAGE_NAME)), "页面写在成果子目录里（不是工作区根）");
    ok(!fs.existsSync(path.join(W, PAGE_NAME)), "（对照）工作区根下没有页面");
    // 本工具不发进度：只要 onProgress 传进去不报错，事件数是 0 就对
    eq(events.length, 0, "不发进度事件");
    const r2 = await run({ manifest: "没有这份.json" });
    eq(r2.isError, true, "（对照）清单不在：报错");
    has(r2.content, "没有这份.json", "报错点名找不到的那份清单");
    const r3 = await tools.withWorkspace(W, () => tools.executeTool("delivery_pages", {}, { baseDir: base }));
    has(r3.content, "未知工具", "（对照）名字拼错确实会落到「未知工具」，上面那条断言不是恒真");
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  console.log(`\n交付页：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 同上 */ }
  process.exit(1);
});
