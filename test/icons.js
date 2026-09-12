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

console.log("\n" + (fail === 0 ? "全部通过" : "有失败") + "：" + pass + " 过 / " + fail + " 挂");
process.exit(fail === 0 ? 0 : 1);
