"use strict";
/**
 * 界面上不许再冒出 emoji（#85 的闸门）。
 *
 * 这条线不是洁癖：emoji 在每个系统上是不同画风，尺寸、基线、配色都不归我们管，
 * 拼在自己的图标旁边就是一块补丁。所以界面上的图形统一走 public/index.html 里那张
 * sprite，代码里用 ic("name") 引；这份测试盯着「别又混回来」。
 *
 * 五件事分开看：
 *   ① 扫描器自检——先证明它抓得到，否则后面全绿等于没测；
 *   ② 前端源码一个 emoji 都不许有（连注释也不留，免得复制粘贴又带回去）；
 *   ③ 会往终端 / IM 吐字的后端文件，只放行单色排版符号，例外逐条记名；
 *   ④ 头像 / 专家 / MCP 目录里写的图标名，必须在 sprite 里查得到；
 *   ⑤ 存盘和转换：图标名不许被当「超长 emoji」拦掉，提示条记号不许漏给用户看见。
 *
 * 每一节都配反向对照：塞个 emoji 进去必须被抓出来，编个图标名必须被判不存在。
 * 只会变绿不会变红的断言不是测试。
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { iconNames, isIconName } = require(path.join(ROOT, "icons"));
const callout = require(path.join(ROOT, "callout"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

// ── 扫描器 ────────────────────────────────────────────────────────────
// 广口径：Unicode 里当表情用的区段都收进来。口径窄了等于没闸门。
const PICT = new RegExp(
  "[\\u00a9\\u00ae\\u203c\\u2049\\u2122\\u2139\\u2194-\\u21aa\\u231a-\\u231b\\u2328\\u23cf" +
  "\\u23e9-\\u23fa\\u24c2\\u25aa-\\u25fe\\u2600-\\u27bf\\u2934\\u2935\\u2b00-\\u2bff\\u3030" +
  "\\u303d\\u3297\\u3299\\ufe0f]|[\\u{1F000}-\\u{1FAFF}]", "gu");
// 白名单：单色、跟正文同色、没有彩图变体的排版符号——终端里就靠这些标状态
const TYPO = new Set(Array.from(
  "★☆✓✗✕✦✧☰≡←→↑↓↔" +
  "↗↘↖↙▶◀▲▼▸▾◂▴◆◇" +
  "●○■□▪▫·©®™"));

function hits(line) {
  return (line.match(PICT) || []).filter((c) => !TYPO.has(c));
}

/** 把 js 注释换成等长空格，行号一个都不动。
 *  模板串里能嵌代码、代码里又能嵌模板，所以用栈；' 和 " 不许跨行——
 *  扫到行尾还没闭合，那个引号就不是字符串开头。漏判一次，整份文件从那儿起全串味。 */
const KW = ["return", "typeof", "case", "in", "of", "do", "else", "yield", "await", "new", "delete", "void", "instanceof"];
function regexCanStart(src, i) {
  let j = i - 1;
  while (j >= 0 && " \t\r\n".includes(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if (")]}".includes(c)) return false;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return KW.includes(src.slice(k + 1, j + 1));
  }
  return true;
}
function stripComments(src) {
  const out = src.split("");
  const n = src.length;
  const stack = [["code", 0]];
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i], d = src[i + 1] || "";
    if (top[0] === "tpl") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); i++; continue; }
      if (c === "$" && d === "{") { stack.push(["code", 0]); i += 2; continue; }
      i++; continue;
    }
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") out[i++] = " "; continue; }
    if (c === "/" && d === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] !== "\n") out[i] = " "; i++; }
      if (i < n) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    if (c === "/" && regexCanStart(src, i)) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (cls) { if (src[j] === "]") cls = false; }
        else if (src[j] === "[") cls = true;
        else if (src[j] === "/") break;
        j++;
      }
      i = (j < n && src[j] === "/") ? j + 1 : i + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      i = (j < n && src[j] === c) ? j + 1 : i + 1;
      continue;
    }
    if (c === "`") { stack.push(["tpl"]); i++; continue; }
    if (c === "{") { top[1]++; i++; continue; }
    if (c === "}") { if (top[1] > 0) top[1]--; else if (stack.length > 1) stack.pop(); i++; continue; }
    i++;
  }
  return out.join("");
}

/** html 里的 <!-- --> 和 <style> 里的 /* *\/ 同样换成等长空格 */
function stripHtmlComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 「这里的 emoji 是数据，不是界面图形」——唯一允许表情留在前端源码里的形式。
 *  用成对记号圈出来，而不是记行号：行号会跟着上面任何一次编辑整体漂掉，漂完要么放行了
 *  不该放的那行，要么对不上号让整份测试红。理由写在起记号里，读代码的人当场看得见。
 *  记号必须写足理由（≥6 个字），空着的不算放行——不然这道闸门谁都能一句话打开。 */
const REGION = /\/\* emoji-数据区 起：([^*]{6,}?)\s*\*\/[\s\S]*?\/\* emoji-数据区 止 \*\//g;
function stripEmojiRegions(src, sink) {
  return src.replace(REGION, (m, why) => {
    if (sink) sink.push(why.trim());
    return m.replace(/[^\n]/g, " "); // 等长空格：行号一个都不能动
  });
}

const regionsSeen = []; // 「文件：理由」——放行过的数据区逐条记下来，末尾对账
function scan(rel) {
  let src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  // 数据区先摘：它靠注释记号圈定，下一步 stripComments 会把记号本身抹成空格
  const why = [];
  src = stripEmojiRegions(src, why);
  for (const w of why) regionsSeen.push(rel + "：" + w);
  // 注释一律不扫：讲「以前这儿写的是什么」的那些话里本来就得引用当年的表情，
  // 把它们删掉等于把改动的来龙去脉也删了。闸门只管真会显示出来的字。
  if (/\.js$/.test(rel)) src = stripComments(src);
  else if (/\.html$/.test(rel)) src = stripHtmlComments(src);
  const found = [];
  src.split("\n").forEach((line, i) => {
    const h = hits(line);
    if (h.length) found.push(rel + ":" + (i + 1) + " " + h.join(""));
  });
  return found;
}

// ① 扫描器自检 ────────────────────────────────────────────────────────
console.log("\n① 扫描器自检（不先证明它能红，后面全绿等于没测）");
eq(hits("✅ 完成").length, 1, "抓得到勾");
ok(hits("⚠️ 注意").length >= 1, "抓得到告警号");
eq(hits("\u{1F680} 上线").length, 1, "抓得到补充平面的 emoji");
eq(hits("✓ ✗ ▲ ▸ ·").length, 0, "排版符号不算（白名单）");
eq(hits("普通中文 abc 123").length, 0, "汉字和 ASCII 不算");
eq(stripComments("const a = 1; // \u{1F680}\nconst b = 2;").includes("\u{1F680}"), false, "行注释里的被剔掉");
eq(stripComments("const a = `x ${ 1 } \u{1F680}`;").includes("\u{1F680}"), true, "模板串里的不剔（那是真要输出的字）");
eq(stripComments("const re = /a'b/; const s = '\u{1F680}';").includes("\u{1F680}"), true, "正则里的引号不会把后面整个串味");

// 数据区（唯一允许 emoji 留在前端源码里的形式）也得先证明它关得紧
const allHits = (src) => src.split("\n").reduce((n, l) => n + hits(l).length, 0);
const REG = '/* emoji-数据区 起：头像候选表，用户挑的数据 */\nconst A = ["\u{1F680}"];\n/* emoji-数据区 止 */\n';
{
  const why = [];
  eq(allHits(stripEmojiRegions(REG, why)), 0, "圈进数据区的表情放行");
  eq(why.join(""), "头像候选表，用户挑的数据", "放行时把理由交出来了（没理由就没法对账）");
  eq(stripEmojiRegions(REG).split("\n").length, REG.split("\n").length, "行号一个都没动");
  eq(allHits(stripEmojiRegions(REG + 'const B = "\u{1F680}";')), 1, "★反向★ 圈外面那个照抓");
  eq(allHits(stripEmojiRegions('/* emoji-数据区 起： */\nconst A = ["\u{1F680}"];\n/* emoji-数据区 止 */')), 1,
     "★反向★ 记号里不写理由不算放行（否则一句话就能把闸门打开）");
  eq(allHits(stripEmojiRegions('/* emoji-数据区 起：忘了收口 */\nconst A = ["\u{1F680}"];')), 1,
     "★反向★ 只有起没有止不算放行（不然半个记号能一路放行到文件末尾）");
}

// ② 前端 ──────────────────────────────────────────────────────────────
console.log("\n② 前端源码（界面上的图形全走 sprite）");
const FRONT = ["public/index.html", "public/pet.html", "mcp-catalog.js", "experts.json"]
  .concat(fs.readdirSync(path.join(ROOT, "public", "js")).filter((f) => f.endsWith(".js")).map((f) => "public/js/" + f));
const FRONT_ALLOW = {
  "public/js/app-02.js": { 1098: "TOAST_ICON 兼容层：插件/技能的老写法还会往消息前面塞表情，这张表就是用来认出它们再换成图标的" },
};
const frontAllowUsed = new Set();
for (const rel of FRONT) {
  const found = scan(rel).filter((str) => {
    const m = str.match(/^(.+):(\d+) /);
    if (FRONT_ALLOW[m[1]] && FRONT_ALLOW[m[1]][Number(m[2])]) { frontAllowUsed.add(m[1] + ":" + m[2]); return false; }
    return true;
  });
  ok(found.length === 0, rel + " 没有 emoji", found.slice(0, 5));
}
const frontAllowTotal = Object.values(FRONT_ALLOW).reduce((n, o) => n + Object.keys(o).length, 0);
eq(frontAllowUsed.size, frontAllowTotal, "前端例外清单每条都还对得上号");

// ③ 后端 ──────────────────────────────────────────────────────────────
console.log("\n③ 后端源码（会往终端 / IM 吐字的那几个）");
// 例外只有一类：emoji 在这儿是**数据**不是界面——正则要匹配模型写出来的 emoji，
// 示例字符串要演示 emoji 的排版。每条都写清楚为什么，过期了就得删。
const ALLOW_LINES = {
  "agent.js": { 117: "CLAIM_RE 要匹配模型自己写的勾，删了就漏判「口头交付」" },
  "task-verdict.js": { 60: "同上：判「它说做完了」的正则，emoji 是待匹配的数据" },
  "skills.js": { 436: "技能文档里的示例字符串，演示的就是 emoji + 阿拉伯语的分词量宽" },
};
const BACK = ["agent.js", "cli.js", "electron-main.js", "evolve.js", "im.js", "server.js",
  "skills.js", "task-verdict.js", "tools.js", "eval/run.js", "callout.js", "icons.js", "account.js"];
const allowUsed = new Set();
for (const rel of BACK) {
  const found = scan(rel).filter((s) => {
    const m = s.match(/^(.+):(\d+) /);
    if (ALLOW_LINES[m[1]] && ALLOW_LINES[m[1]][Number(m[2])]) { allowUsed.add(m[1] + ":" + m[2]); return false; }
    return true;
  });
  ok(found.length === 0, rel + " 只剩排版符号", found.slice(0, 5));
}
const allowTotal = Object.values(ALLOW_LINES).reduce((n, o) => n + Object.keys(o).length, 0);
eq(allowUsed.size, allowTotal, "例外清单每条都还对得上号（对不上就是该删了）");

// 数据区用在哪、为什么，逐条摆出来。多开一处、少写一句理由，这行就对不上——
// 「哪儿还留着 emoji」这个问题，任何时候都该能一眼答完。
const REGIONS_DECLARED = [
  "public/js/app-00-ui.js：头像候选表，用户挑给自己的数据，不是界面图形",
];
eq(regionsSeen.join(" | "), REGIONS_DECLARED.join(" | "), "emoji 数据区跟声明的一一对得上");

// ④ 图标名 ────────────────────────────────────────────────────────────
console.log("\n④ 图标名真的存在");
const names = iconNames();
ok(names.size > 120, "sprite 里有 " + names.size + " 个符号", names.size);
ok(!isIconName("definitely-not-an-icon"), "编一个名字查不到（反向对照）");
ok(!isIconName(""), "空串不算图标名");
ok(!isIconName("\u{1F680}"), "emoji 不算图标名");

const catalog = require(path.join(ROOT, "mcp-catalog.js"));
const badCat = (catalog.ITEMS || []).filter((x) => x.icon && !isIconName(x.icon)).map((x) => x.id + ":" + x.icon);
ok((catalog.ITEMS || []).length > 20, "MCP 目录有 " + (catalog.ITEMS || []).length + " 条", (catalog.ITEMS || []).length);
ok(badCat.length === 0, "MCP 目录里的图标名全查得到", badCat);

const experts = JSON.parse(fs.readFileSync(path.join(ROOT, "experts.json"), "utf8"));
const avatars = [].concat(experts.experts || [], experts.teams || []).map((x) => x.avatar).filter(Boolean);
ok(avatars.length > 20, "experts.json 里有 " + avatars.length + " 个头像", avatars.length);
ok(avatars.filter((a) => !isIconName(a)).length === 0, "experts.json 里的头像全是查得到的图标名", avatars.filter((a) => !isIconName(a)));

// 头像格子里摆错名字，用户看到的是一格空白——这份清单也得对着 sprite 核
const uiSrc = fs.readFileSync(path.join(ROOT, "public", "js", "app-00-ui.js"), "utf8");
const mIcons = uiSrc.match(/const AVATAR_ICONS = \[([\s\S]*?)\];/);
ok(!!mIcons, "app-00-ui.js 里找得到 AVATAR_ICONS");
if (mIcons) {
  const picks = (mIcons[1].match(/"([a-z0-9-]+)"/g) || []).map((s) => s.slice(1, -1));
  ok(picks.length > 20, "头像格子里摆了 " + picks.length + " 个图标", picks.length);
  ok(picks.filter((n) => !isIconName(n)).length === 0, "头像格子里的图标名全查得到", picks.filter((n) => !isIconName(n)));
}

// ⑤ 存盘与转换 ────────────────────────────────────────────────────────
console.log("\n⑤ 存盘认图标名、提示条记号不漏给用户");
const normalizeAvatar = require(path.join(ROOT, "account"))._internals.normalizeAvatar;
const accepts = (v) => { try { normalizeAvatar(v); return true; } catch { return false; } };
ok(accepts("rocket"), "六个字母的图标名存得进去");
ok(accepts("chart-column"), "带横杠的长图标名也存得进去（以前被「最多两个字符」拦掉）");
ok(accepts("@cat"), "内置猫标的哨兵值照旧放行");
ok(accepts("\u{1F680}"), "老配置里的 emoji 头像还认（存量不许失效）");
ok(!accepts("definitely-not-an-icon"), "不在 sprite 里的长字符串照旧拦下（反向对照）");
ok(!accepts("<img src=x>"), "带标签的照旧拦下");
ok(!accepts("https://a/b.png"), "外链照旧拦下");

// 专家卡的头像不许被切半截：图标名最长十几个字符
const longest = Array.from(names).reduce((a, b) => (b.length > a.length ? b : a), "");
ok(longest.length > 8, "最长的图标名是 " + longest + "（" + longest.length + " 字），比早先 slice(0,8) 长", longest);
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const mCap = serverSrc.match(/const cardAvatar = [^\n]*slice\(0, (\d+)\)/);
ok(!!mCap, "server.js 里找得到专家头像的长度上限");
if (mCap) ok(Number(mCap[1]) >= longest.length, "上限 " + mCap[1] + " 放得下最长的图标名", { cap: Number(mCap[1]), need: longest.length });

eq(callout.strip("> [!warn] 小心").trim(), "> 注意 · 小心", "终端 / IM 里记号换成文字标签");
eq(callout.strip("> [!wait] 等等").trim(), "> 进行中 · 等等", "等待态同理");
eq(callout.strip("> [!nope] x"), "> [!nope] x", "认不出的记号原样留着，不许把正文吃掉（反向对照）");
eq(callout.strip("前面有字 > [!warn] x"), "前面有字 > [!warn] x", "不在行首的不动");
ok(callout.line("warn", "x").includes("> [!warn] x"), "line() 拼出来的就是渲染器认的那种写法");
// 网页那头的映射表要跟这边四种口径对得上，少一种就会渲染成没有图标的空条
const appSrc = fs.readFileSync(path.join(ROOT, "public", "js", "app-01.js"), "utf8");
const mMap = appSrc.match(/const CALLOUT_ICON = \{([^}]*)\}/);
ok(!!mMap, "app-01.js 里找得到 CALLOUT_ICON");
if (mMap) {
  const kinds = (mMap[1].match(/([a-z]+):/g) || []).map((s) => s.slice(0, -1));
  eq(kinds.sort().join(","), Object.keys(callout.LABEL).sort().join(","), "网页图标表和 callout.LABEL 口径一一对应");
  const icons = (mMap[1].match(/"([a-z-]+)"/g) || []).map((s) => s.slice(1, -1));
  ok(icons.length === kinds.length && icons.every((n) => isIconName(n)), "提示条用的图标都在 sprite 里", icons.filter((n) => !isIconName(n)));
}

// ================= ⑥ 圆角只走令牌阶梯 =================
// 挨着的两个控件一个圆 7px 一个圆 9px，没人看得出这是设计，只看得出没对齐。
// ui.css 里有一条 4/6/8/10/12/14/999 的阶梯（--radius-xs…-full），index.html 那 1400 行
// 内联样式以前完全没用它，自己写死了 29 个不同的圆角。这条闸门盯着别再写死。
// 放行的只有：var(--radius-*)、50%（正圆头像）、0（要方角的那几处）、inherit。
{
  const indexHtml = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const a = indexHtml.indexOf("<style>"), b = indexHtml.indexOf("</style>", a);
  ok(a > 0 && b > a, "index.html 里定位得到那段内联样式");
  const inlineCss = indexHtml.slice(a + 7, b);

  // 阶梯本身得在 ui.css 里齐全，少一档下面的映射就没地方落
  const uiCss = fs.readFileSync(path.join(ROOT, "public", "css", "ui.css"), "utf8");
  const LADDER = ["xs", "sm", "md", "lg", "xl", "2xl", "full"];
  const missing = LADDER.filter((n) => !new RegExp("--radius-" + n + "\\s*:").test(uiCss));
  eq(missing.length, 0, "ui.css 里 7 档圆角令牌齐全", missing);

  // 扫描器：挑出所有写死像素的圆角
  const hardCoded = (css) => (css.match(/border-radius\s*:\s*[^;}]+/g) || [])
    .map((d) => d.split(":").slice(1).join(":").trim())
    .filter((v) => /\d+(\.\d+)?px/.test(v));

  // ★反向对照★ 先证明扫描器抓得到，否则下面全绿等于没测
  const planted = hardCoded(inlineCss + "\n.wb-fake { border-radius: 7px; }");
  eq(planted.length, 1, "反向对照：种一条 7px 的圆角进去，扫描器当场抓出来", planted);

  const left = hardCoded(inlineCss);
  eq(left.length, 0, "index.html 的内联样式里一处写死的 px 圆角都没有了（原来 218 处里有 199 处是写死的）", left.slice(0, 6));

  // 落到的档位也要都在阶梯上——写个 var(--radius-huge) 一样是没对齐
  const used = [...new Set((inlineCss.match(/border-radius\s*:\s*[^;}]+/g) || [])
    .flatMap((d) => d.match(/var\(--radius-([a-z0-9]+)\)/g) || [])
    .map((v) => v.replace(/var\(--radius-|\)/g, "")))];
  const offLadder = used.filter((n) => !LADDER.includes(n));
  eq(offLadder.length, 0, "用到的档位全在阶梯上，没有生造的名字", offLadder);
  ok(used.length >= 5, "阶梯是真被用起来了（不是一档包打天下）", used.sort());
}

// ── ⑥ 别再拿标点当图标 ────────────────────────────────────────────────
// emoji 清干净之后，替它顶位的是一批排版符号：按钮上的「＋ 新建项目」、折叠条上的
// ›、关闭键上的 ✕、链接尾巴上的 →。它们不在 ③ 的白名单之外，所以上面那几节全绿，
// 界面上却仍是一半 sprite 一半字符——字重、基线、粗细归字体管，跟旁边的图标怎么调都对不齐。
// 判据是位置不是字符本身：正文里的「设置 → 模型」「首屏＋卖点＋FAQ」照旧允许，
// 只有紧贴着标签边界的那个（>✕< / >＋ 上传< / 收起 ✕<）才算拿它当图标使。
{
  const GLYPHS = "＋→↗↑↓›‹▸▾▶◀✕✓✗✦×";
  const BOUNDARY = new RegExp(">\\s*([" + GLYPHS + "])(?=[\\s<])|(?<=[\\s>])([" + GLYPHS + "])\\s*<", "g");
  const scanGlyph = (src) => {
    const out = [];
    src.split("\n").forEach((line, i) => {
      let m;
      BOUNDARY.lastIndex = 0;
      while ((m = BOUNDARY.exec(line))) out.push({ line: i + 1, g: m[1] || m[2], txt: line.trim().slice(0, 90) });
    });
    return out;
  };

  // ★反向对照★ 三种写法都得抓到：光杆字符、字符在前、字符在后
  const planted = scanGlyph([
    '<span class="caret" id="more-caret">▾</span>',
    '<button class="btn-brand" id="pj-new">＋ 新建项目</button>',
    '<a class="link" href="#">用这个模版新建 →</a>',
  ].join("\n"));
  eq(planted.length, 3, "反向对照：种三种拿标点当图标的写法进去，三条全被抓出来",
    planted.map((h) => h.g));
  // 正文里的箭头和加号不许误伤，否则闸门一响大家就去关它
  eq(scanGlyph('<div class="d">拆子问题→逐个查证→自我挑刺</div>\n<div>首屏＋卖点＋FAQ</div>').length, 0,
    "反向对照：句子中间的 → 和 ＋ 是正文，不报");

  const FRONT_SRC = ["public/index.html", "public/pet.html", "public/js/app-00-ui.js", "public/js/app-01.js",
    "public/js/app-02.js", "public/js/app-03.js", "public/js/app-04.js", "public/js/app-05.js",
    "public/js/app-06.js", "public/js/admin.js"];
  const left = [];
  for (const rel of FRONT_SRC) {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    // 注释里写 `![alt](url) → <img>` 是讲人话，不是画界面
    const src = rel.endsWith(".html") ? stripHtmlComments(stripComments(raw)) : stripComments(raw);
    for (const h of scanGlyph(src)) left.push(rel + ":" + h.line + " [" + h.g + "] " + h.txt);
  }
  eq(left.length, 0, "前端源码里一处拿标点当图标的都没有了（改之前 32 处）", left.slice(0, 8));
}

// ── ⑦ 换图标的时候，词典的键要跟着原文一起改 ──────────────────────────
// i18n 是拿中文原句当键的，而且比的是「整个文本节点去掉首尾空白」之后的那一串。
// 所以把 `＋ 上传` 换成 `${ic("plus")}上传`，文本节点就只剩「上传」，词典里那条
// "＋ 上传" 再也匹配不上——界面不会报错，只是英文那边默默变回中文。
// 这条闸门盯的就是这种「键还停在老原文」：键里带图标字符、原句已经不在源码里了，
// 可把字符剔掉之后的那句还活着。实测：改之前有 1 条是上一轮换图标留下的（"已达成 ✓"），
// 这一轮把 32 处标点换成图标、词典先不动的话，会一口气变成 14 条。
{
  const GLYPHS = "＋→↗↑↓›‹▸▾▶◀✕✓✗✦×";
  const SRC_FILES = ["public/index.html", "public/pet.html", "public/js/app-00-ui.js", "public/js/app-01.js",
    "public/js/app-02.js", "public/js/app-03.js", "public/js/app-04.js", "public/js/app-05.js",
    "public/js/app-06.js", "public/js/admin.js"];
  const corpus = SRC_FILES.map((rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")).join("\n");
  const strip = (s) => Array.from(s).filter((c) => !GLYPHS.includes(c)).join("").replace(/\s+/g, " ").trim();
  const stale = (dict) => {
    const keys = [];
    const re = /^[ \t]*"((?:[^"\\]|\\.)*)"\s*:\s*"/gm;
    let m;
    while ((m = re.exec(dict))) keys.push(m[1].replace(/\\"/g, '"'));
    return keys.filter((k) => Array.from(k).some((c) => GLYPHS.includes(c)) && !corpus.includes(k))
      .filter((k) => { const s = strip(k); return s && corpus.includes(s); });
  };

  // ★反向对照★ 拿一句真在界面上的话，给键尾巴加个 ✓，必须被判成停在老原文
  const live = '已达成';
  ok(corpus.includes(live), "对照用的这句确实还在界面上", live);
  eq(stale('      "' + live + ' ✓": "Achieved ✓",\n').length, 1,
    "反向对照：键尾巴多带一个 ✓、原句已经没了，当场判成停在老原文");
  eq(stale('      "设置 → 模型": "Settings → Models",\n').length, 0,
    "反向对照：正文里真带箭头的那种键不误伤");

  const dict = fs.readFileSync(path.join(ROOT, "public", "js", "i18n.js"), "utf8");
  const left = stale(dict);
  eq(left.length, 0, "词典里没有键还停在带图标字符的老原文（这轮换图标时一度有 14 条，英文那边会默默漏翻）", left);
}

// ── ⑧ 会滚的面板要给滚动条留位 ────────────────────────────────────────
// mac 默认是覆盖式滚动条，开发机上一辈子看不出问题；用户一旦在系统设置里选「总是显示
// 滚动条」，没留位的面板就会随内容长短横跳。实测（强制 15px 经典滚动条，往面板里塞根
// 高垫片逼它出条）：设置面板 12 个分页里有 4 个内容不够长、不出滚动条，来回切整页横移
// 11px；弹窗正文和左侧任务列表同样 11px。补上 scrollbar-gutter 之后 25 个测点全是 0。
{
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const a = html.indexOf("<style>"), b = html.indexOf("</style>", a);
  const css = html.slice(a, b);
  // 这四块是「内容长短不定、还要跟旁边的东西对齐」的主面板，横跳一眼就看得见
  const PANES = ["#chat-scroll", ".settings-pane", ".m-body", "#history"];
  const ruleOf = (sel) => {
    const i = css.indexOf("\n  " + sel + " {");
    if (i < 0) return null;
    return css.slice(i + 3, css.indexOf("}", i) + 1);
  };
  const hasGutter = (rule) => /scrollbar-gutter:\s*stable/.test(rule || "");

  // ★反向对照★ 把声明抠掉，扫描器必须当场说没留位
  const sample = ruleOf(".settings-pane");
  ok(sample, "定位得到 .settings-pane 那条规则", sample);
  ok(hasGutter(sample), "样本规则本身是留了位的");
  ok(!hasGutter(sample.replace(/\s*scrollbar-gutter:\s*stable[^;}]*;?/, "")),
    "反向对照：把 scrollbar-gutter 抠掉，当场判成没留位");

  const naked = [];
  for (const sel of PANES) {
    const rule = ruleOf(sel);
    if (!rule) { naked.push(sel + "（这条规则找不着了）"); continue; }
    if (!/overflow(-y)?:\s*auto/.test(rule)) { naked.push(sel + "（不再是滚动容器？规则变了就得重新想）"); continue; }
    if (!hasGutter(rule)) naked.push(sel);
  }
  eq(naked.length, 0, "四块主滚动面板都给滚动条留了位（改之前三块会横跳 11px）", naked);
}

// ── ⑨ 搜索框的宽度只许有一个出处 ──────────────────────────────────────
// 同一个 .hub-search，项目页内联写 260、自动化页内联写 240、技能中心和模板页干脆不写
// 由 flex:1 一路撑开——实测在 1440 宽的窗口上量出四种宽度：240 / 260 / 565 / 746。
// 用户切个标签就觉得换了套界面。宽度归 CSS 那一条管，页面里不许再各写各的。
{
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const a = html.indexOf("<style>"), b = html.indexOf("</style>", a);
  const rule = html.slice(a, b).match(/\n {2}\.hub-search \{[^}]*\}/);
  ok(rule, "index.html 里定位得到 .hub-search 那条规则");
  ok(/max-width:\s*\d+px/.test(rule[0]), "宽度上限写在 CSS 里", rule && rule[0].trim());

  const JS = ["app-01.js", "app-02.js", "app-03.js", "app-04.js", "app-05.js", "app-06.js"];
  const inlineWidth = (src) => {
    const out = [];
    const re = /class="hub-search"[^>]*?style="([^"]*)"/g;
    let m;
    while ((m = re.exec(src))) if (/(max-)?width\s*:/.test(m[1])) out.push(m[1]);
    return out;
  };
  // ★反向对照★ 种一处内联宽度回去，必须被抓到；只写 margin 的不误伤
  eq(inlineWidth('<div class="hub-search" style="max-width:240px">x</div>').length, 1,
    "反向对照：内联写死宽度，当场抓出来");
  eq(inlineWidth('<div class="hub-search" style="margin-left:auto">x</div>').length, 0,
    "反向对照：只调位置不调宽度的内联样式不误伤");

  const left = [];
  for (const f of JS) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, "public", "js", f), "utf8"));
    for (const s of inlineWidth(src)) left.push(f + " → " + s);
  }
  eq(left.length, 0, "没有页面再内联写搜索框宽度了（改之前两处，实测四种宽度）", left);
}

// ── ⑩ ${...} 不许写进普通引号里 ──────────────────────────────────────────
// 这一轮换图标，把 × 改成 ${ic("x")} 的时候踩了两次同一个坑：原来那处是普通单引号字符串，
// 改完 ${} 不求值，界面上原样印出「${ic("x")}」。一处在项目栏的移除按钮，
// 一处在设置-安全里「已授权」那行——后者 e2e 跑不到，是靠这条扫描才翻出来的。
// 判据是位置：模板串里的 ${} 正常，普通引号里的一律是漏网。
// 要认出「在哪种串里」就得像 JS 引擎那样走一遍字符——注释、正则字面量、三种引号、
// 模板串里嵌 ${} 里再嵌模板串，都得跟住。少跟一样就会误报：
// app-01.js 有一句 .replace(/"/g, "") 写在 ${} 里，不认正则的扫描器会把那个 " 当成开引号，
// 从此整段错位。
{
  // 上一个有意义的字符是这些时，/ 开的是正则不是除号；这几个关键字后面同理
  const RE_OK = /[(,=:[!&|?{};+\-*%~^<>]/;
  const RE_KW = /\b(return|typeof|case|in|of|new|delete|do|else|void|yield|await)\s*$/;
  const scanDollar = (src) => {
    const hits = [];
    const stack = [];                       // 帧：{t:"tpl"} 模板串里 / {t:"expr",d:n} 模板串的 ${} 里
    let i = 0, line = 1, prev = "", head = "";
    const top = () => stack[stack.length - 1];
    while (i < src.length) {
      const c = src[i], f = top();
      if (f && f.t === "tpl") {             // 模板串正文
        if (c === "\\") { i += 2; continue; }
        if (c === "\n") { line++; i++; continue; }
        if (c === "`") { stack.pop(); i++; prev = "`"; continue; }
        if (c === "$" && src[i + 1] === "{") { stack.push({ t: "expr", d: 0 }); i += 2; prev = "{"; continue; }
        i++; continue;
      }
      // 以下是「正经代码」：顶层，或者模板串 ${} 里面——两者规则完全一样，所以共用这一段
      if (c === "\n") { line++; i++; head = ""; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; } i += 2; continue; }
      if (c === "/" && (RE_OK.test(prev) || RE_KW.test(head) || prev === "")) {
        i++; let cls = false;
        while (i < src.length) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") cls = true;
          else if (src[i] === "]") cls = false;
          else if (src[i] === "/" && !cls) { i++; break; }
          else if (src[i] === "\n") { line++; break; }
          i++;
        }
        while (i < src.length && /[dgimsuvy]/.test(src[i])) i++;
        prev = "/"; head = ""; continue;
      }
      if (c === "`") { stack.push({ t: "tpl" }); i++; continue; }
      if (c === "'" || c === '"') {
        const q = c, startLine = line; let body = ""; i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === "\\") { body += src[i] + (src[i + 1] || ""); i += 2; continue; }
          if (src[i] === "\n") { line++; break; }           // 普通串不能跨行，断了就当它结束
          body += src[i]; i++;
        }
        i++;
        if (body.includes("${")) hits.push({ line: startLine, txt: (q + body + q).slice(0, 110) });
        prev = q; head = ""; continue;
      }
      if (f && f.t === "expr") {                             // 跟住 ${} 的花括号，配平了就回到模板串
        if (c === "{") f.d++;
        else if (c === "}") { if (f.d === 0) { stack.pop(); i++; prev = "}"; continue; } f.d--; }
      }
      if (!/\s/.test(c)) { prev = c; head = /[A-Za-z_$]/.test(c) ? head + c : ""; }
      i++;
    }
    return hits;
  };

  // ★反向对照★ 真出过的那两种写法必须抓到
  eq(scanDollar("const a = '<span class=\"del\">${ic(\"x\")}</span>';").length, 1,
    "反向对照：单引号里写 ${ic()}，当场抓出来");
  eq(scanDollar('const t = { granted: "<b>${ic(\'check\')} 已授权</b>" };').length, 1,
    "反向对照：双引号里的同样抓");
  // 正常写法一个都不许误报
  eq(scanDollar("const a = `<img src=\"${esc(s)}\" alt=\"${String(x || '').replace(/\"/g, '')}\">`;").length, 0,
    "反向对照：模板串里嵌 ${}、${} 里还有个带引号的正则——不误报（就是这句让上一版扫描器整段错位的）");
  eq(scanDollar("const a = `外层 ${cond ? `内层 ${v}` : ''} 尾`;").length, 0,
    "反向对照：模板串套模板串不误报");
  eq(scanDollar("// 注释里写 '${x}' 不算\nconst s = 'ok';").length, 0, "反向对照：注释里的不算");
  eq(scanDollar("const r = str.split('${')[0];").length, 1,
    "反向对照：真在普通串里出现 ${ 就报——宁可让人去加个注释，也不留判不准的缝");

  const JS = ["app-00-ui.js", "app-01.js", "app-02.js", "app-03.js", "app-04.js", "app-05.js", "app-06.js", "admin.js", "i18n.js"];
  const left = [];
  for (const f of JS) {
    const src = fs.readFileSync(path.join(ROOT, "public", "js", f), "utf8");
    for (const h of scanDollar(src)) left.push(f + ":" + h.line + "  " + h.txt);
  }
  eq(left.length, 0, "没有 ${} 漏在普通引号里（这轮改图标时踩中两处，都会把占位符原样印到界面上）", left);
}

console.log("\n" + (fail === 0 ? "全部通过" : "有失败") + "：" + pass + " 过 / " + fail + " 挂");
process.exit(fail === 0 ? 0 : 1);
