"use strict";
/**
 * 仓库卫生：测试喂进去的「真文件」，必须真的随仓库发出去。
 *
 *   node test/repo-hygiene.js
 *
 * 为什么要有这个文件：
 *
 * 2026-09-13，v0.1.7 发不出去。CI 上 `npm test` 不是红，是挂着——五个 job 各烧了一个多
 * 小时，日志一个字都没有，最后只能人工取消。给每层子进程拴上看门狗之后，真话才露出来：
 *
 *     ❌ 前端 SVG 测试卡死了：300 秒还没跑完，已强杀
 *     App threw an error during load
 *     Error: skills/brand-guidelines 的说明书不见了，技能例子测试没法用真输入
 *
 * test/frontend.js 拿 skills/brand-guidelines/SKILL.md 当测试输入，而这个技能在
 * .gitignore 里——它是第三方技能，仓库不打包别人的代码，用户是在应用内一键装的。
 * 于是：开发机上有，跑起来常绿；别人一 clone，文件不存在，顶层直接抛。
 * 又因为那是 Electron 的主脚本，加载期抛错的默认行为是弹一个原生错误框，
 * CI 上没人点确定，就成了永久挂起。
 *
 * 这一层测的是根因那一半：**别再把本机私货当测试输入**。
 * 另一半（加载期出错要当场红、不许弹框）钉在 test/frontend.js 和 test/admin-ui.js 顶上。
 *
 * 两条规则：
 *   1. 被 .gitignore 排除的技能，不许出现在测试代码的「名单数组」或路径拼接里。
 *   2. 测试里那些完全由字面量拼出来的仓库内路径，本机存在却被 git 忽略的，一律不许读。
 *
 * 「新加的套件有没有补进 CI 的 --only」不在这儿：test/e2e.js 的 releasePipelineDrift
 * 早就守着了，而且反向对照更全。同一件事守两遍、各自解析同一个文件，迟早分叉。
 *
 * 两条后面都跟反向对照：拿一段编出来的源码去喂扫描器，该抓的抓到、该放的放过，
 * 不然这个文件本身就是个假绿。
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

// 扫描对象：test/ 下所有测试。跳过自己——这个文件里那几段「brand-guidelines」
// 是给反向对照用的样本，不是真的去读盘。
const scanTargets = () =>
  fs.readdirSync(__dirname).filter((f) => f.endsWith(".js") && f !== path.basename(__filename)).sort();

// package.json 里写明的依赖：npm ci 一定会装，测试读它们的文件是正当的。
// 没写明、只是恰好躺在本机 node_modules 里的（别人的传递依赖），
// 换台机器、换个版本就可能不在那儿——那种才是私货。
const DECLARED_DEPS = (() => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return new Set([].concat(
    Object.keys(p.dependencies || {}),
    Object.keys(p.devDependencies || {}),
    Object.keys(p.optionalDependencies || {})
  ));
})();
// node_modules/@scope/pkg/... 或 node_modules/pkg/... → 取出包名
const pkgOf = (rel) => {
  const seg = rel.split("/");
  if (seg[0] !== "node_modules") return null;
  return seg[1] && seg[1][0] === "@" ? seg[1] + "/" + seg[2] : seg[1];
};

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra ? "\n      " + extra : "")); }
};

// ---------- 把注释剥掉，只看真正会执行的代码 ----------
// 不剥的话，注释里那句「原先有 brand-guidelines」自己就会把自己判红。
// 按行剥，不用 /\*[\s\S]*?\*\// 那种整块匹配：这些测试里到处是正则字面量，
// 里头的 /* 和 */ 会跟真注释乱配对。第一版就是这么写的，一口气吃掉了 frontend.js
// 的 343KB（全文 the 90%），于是扫描器面对一个几乎空的文件，当然「全部通过」——
// 一条比没有还糟的假绿。所以下面还跟着一条自检。
function stripComments(src) {
  return src
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
      return l.replace(/(^|[^:])\/\/.*$/, "$1"); // 行尾注释；http:// 这种别误伤
    })
    .join("\n");
}

/**
 * 把「看起来像代码、其实是文本」的那两种挡掉：模板字符串和单引号字符串。
 * 房间里写 require 用的是双引号，所以双引号那一种得留着。
 * 单引号那条故意不允许跨行（[^'\\\n]）——一个写歪的引号就不会把后面半个文件吞掉。
 */
function stripTemplates(src) {
  return src
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

// 自检：剥完不能把代码也剥没了。这条是上面那个假绿的直接产物——
// 扫描器看不见东西的时候，它报的「通过」和真通过长得一模一样。
function assertStripSane(name, src) {
  const kept = stripComments(src).replace(/\s/g, "").length;
  const all = src.replace(/\s/g, "").length;
  if (all > 2000 && kept < all * 0.3) {
    throw new Error(`剥注释把 ${name} 剥没了：只剩 ${kept}/${all} 个字符，` +
      "扫描器等于在看一个空文件，报出来的绿是假的");
  }
}

// ---------- 规则一：.gitignore 掉的技能不许当测试输入 ----------
// 名单从 .gitignore 现读，不在这儿抄一份——抄了就会和真源分叉。
function ignoredSkills() {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  const out = [];
  for (const line of gi.split("\n")) {
    const m = /^skills\/([^/\s]+)\/?\s*$/.exec(line.trim());
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * 找出源码里「被当成技能目录名用」的字面量。
 *
 * 只认两种写法，其余一概不碰：
 *   - 数组里直接躺着的字符串：["a", "b"]  ——这就是喂给 for…of 去读盘的那种名单
 *   - path.join(..., "a", ...) 的参数
 *
 * 故意不认 { name: "archify" } 这种：那是编出来的对象字段，不读盘。
 * 规则宽一点会天天误报，最后没人看；窄一点、写清楚认什么，才有人信。
 */
function skillNameLiterals(src, names) {
  const code = stripComments(src);
  const hits = [];
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 数组元素：前面是 [ 或 , （只隔空白/换行），后面是 , 或 ]
    const asItem = new RegExp("[\\[,]\\s*[\"']" + esc + "[\"']\\s*[,\\]]");
    // path.join 的参数
    const asSeg = new RegExp("path\\.join\\([^)]*[\"']" + esc + "[\"']");
    if (asItem.test(code) || asSeg.test(code)) hits.push(n);
  }
  return hits;
}

console.log("【1】测试里不许出现 .gitignore 掉的技能名（本机有、新克隆没有）");
{
  const names = ignoredSkills();
  ok(names.length >= 5, `.gitignore 里认出 ${names.length} 个不随包发的技能`, names.join(" "));

  const files = scanTargets();
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    assertStripSane("test/" + f, src);
    const hit = skillNameLiterals(src, names);
    for (const n of hit) bad.push(`test/${f} 用了 skills/${n}`);
  }
  ok(bad.length === 0,
    `${files.length} 个测试文件都只拿随包发出去的技能当输入`,
    bad.join("\n      ") + "\n      （这些技能在 .gitignore 里，别人 clone 下来根本没有；" +
    "换一个 git ls-files skills/ 里有的，或者别读真文件）");

  // 反向对照：编一段一定该抓的源码，抓不到就说明上面那条绿是假的
  const trap = 'for (const n of ["deep-research", "brand-guidelines"]) read(n);';
  ok(skillNameLiterals(trap, names).join() === "brand-guidelines",
    "反向对照：名单数组里混进一个不随包发的技能，抓得出来",
    JSON.stringify(skillNameLiterals(trap, names)));
  const trap2 = 'const p = path.join(ROOT, "skills", "i-have-adhd", "SKILL.md");';
  ok(skillNameLiterals(trap2, names).join() === "i-have-adhd",
    "反向对照：path.join 里拼一个不随包发的技能，也抓得出来");
  // 反向对照的另一头：不读盘的地方不许误报，不然这条规则会被当噪音关掉
  const okSrc = 'const skillsCache = [{ name: "写周报" }, { name: "archify" }];';
  ok(skillNameLiterals(okSrc, names).length === 0,
    "反向对照：{ name: \"archify\" } 这种编出来的对象字段不误报");
}

// ---------- 规则二：字面量路径不许指向被 git 忽略的东西 ----------
console.log("\n【2】测试里写死的仓库内路径，不许是本机私货");
// 这条要问 git。从 release 的 tarball 解出来跑 npm test 是没有 .git 的，
// 那种情况下跳过，不许因为「问不到」就报红——假红和假绿一样会让人不再看测试。
const HAS_GIT = (() => {
  try { execFileSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT, stdio: "ignore" }); return true; }
  catch (e) { return false; }
})();
if (!HAS_GIT) {
  console.log("  - 跳过：这儿不是 git 仓库（多半是从发布包解出来的），问不到谁被忽略");
} else {
  // git check-ignore 一次问一批，比一个个 spawn 快得多
  // 返回被忽略的那些；git 答不上来就返回 null（让调用方跳过，而不是把整个套件炸掉）
  const ignoredOf = (rels) => {
    if (!rels.length) return new Set();
    try {
      const out = execFileSync("git", ["check-ignore", "--stdin", "--no-index"],
        // stderr 也收进来：execFileSync 默认把它直接倒到终端，
        // 于是一行 fatal: 会跟在一堆 ✓ 后面，看着像整个套件炸了。
        { cwd: ROOT, input: rels.join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
    } catch (e) {
      if (e.status === 1) return new Set(); // 一个都没被忽略，git 用退出码 1 表示，不是出错
      // 其余情况（比如 node_modules 是个软链，git 会说 "beyond a symbolic link"）
      // 只说一声就走，别让一条辅助规则把 19 个套件全带红。
      console.log("  - git check-ignore 答不上来（" + String((e.stderr || e.message)).trim().split("\n")[0] + "）");
      return null;
    }
  };

  const files = scanTargets();
  const found = []; // {file, rel}
  for (const f of files) {
    const code = stripComments(fs.readFileSync(path.join(__dirname, f), "utf8"));
    // 只认「参数全是字面量」的 path.join(__dirname, "..", …)，拼变量的一律跳过
    const re = /path\.join\(\s*__dirname\s*((?:\s*,\s*["'][^"']*["'])+)\s*\)/g;
    let m;
    while ((m = re.exec(code))) {
      const segs = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      const rel = path.relative(ROOT, path.resolve(__dirname, ...segs));
      if (rel && !rel.startsWith("..")) found.push({ file: f, rel });
    }
  }
  ok(found.length > 0, `扫出 ${found.length} 处写死的仓库内路径`);

  const ign = ignoredOf([...new Set(found.map((x) => x.rel))]);
  if (!ign) {
    console.log("  - 跳过：问不到谁被忽略");
  } else {
  const bad = [];
  let deps = 0;
  for (const x of found) {
    if (!ign.has(x.rel)) continue;
    const pkg = pkgOf(x.rel);
    if (pkg && DECLARED_DEPS.has(pkg)) { deps++; continue; } // npm ci 会装，正当
    bad.push(`test/${x.file} 读 ${x.rel}` + (pkg ? `（${pkg} 没写进 package.json）` : ""));
  }
  ok(bad.length === 0,
    `被 git 忽略的只剩 ${deps} 处，且都是 package.json 里写明的依赖`,
    bad.join("\n      ") + "\n      （本机跑得通，别人 clone 下来这个文件根本不存在）");

  // 反向对照：拿一个确定被忽略的路径去问，必须答「被忽略」。
  // 探针一定要带上文件名，不能只写目录名——.gitignore 里是 `skills/brand-guidelines/`
  // 这种只匹配目录的写法，git 得先确认磁盘上这个路径真是个目录才认。本机有这些目录，
  // 所以写目录名也绿；CI 上没有（它本来就不随包发），git 就答「不忽略」，于是这条对照
  // 在 2026-09-13 的 CI 上红了——红的是对照本身，不是被测的东西。
  // 带文件名走的是「父目录被忽略」那条路，跟磁盘上有没有这个文件无关，两边答案一致。
  const ghost = "skills/" + ([...ignoredSkills()][0] || "brand-guidelines") + "/SKILL.md";
  const probe = ignoredOf(["node_modules/whatever/x.js", ghost, "server.js"]);
  ok(probe && probe.has("node_modules/whatever/x.js") && probe.has(ghost) && !probe.has("server.js"),
    "反向对照：git check-ignore 认得出谁被忽略、谁没有",
    probe ? "它只认下了：" + ([...probe].join(" ") || "（一个都没认）") : "问不到");
  }
}

// ---------- 规则三：专家绑的技能必须随包发出去 ----------
// electron-builder.config.js 的技能白名单是 `git ls-files skills` 现算的，本机 skills/ 下
// 躺着的第三方技能不进包。所以 experts.json 里一旦绑了一个被 .gitignore 排掉的技能，
// 开发机上一切正常，用户装完打开就是「专家绑定的技能『xxx』不存在」。
// experts-lib.js 的 validateExperts 拿的是 loadSkills()——读的是本机磁盘，照不出这一层。
// 这条只能问 git：磁盘上有不算数，进了索引才算数。
function shippedSkills() {
  try {
    const out = execFileSync("git", ["ls-files", "skills"], { cwd: ROOT, encoding: "utf8" });
    const s = new Set();
    for (const line of out.split("\n")) {
      const m = /^skills\/([^/]+)\//.exec(line.trim());
      if (m) s.add(m[1]);
    }
    return s.size ? s : null;
  } catch (e) { return null; }
}

/** 绑了但没随包发的那些。抽成纯函数，下面好拿编出来的输入做反向对照 */
const unshipped = (bound, shipped) => bound.filter((n) => !shipped.has(n));

console.log("\n【3】experts.json 绑的技能，必须是 git 跟踪的");
{
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "experts.json"), "utf8"));
  const bound = [...new Set((meta.experts || [])
    .flatMap((e) => (Array.isArray(e.skills) ? e.skills : [])))].sort();
  ok(bound.length > 0, `experts.json 里一共绑了 ${bound.length} 个技能`, bound.join(" "));

  const shipped = shippedSkills();
  if (!shipped) {
    console.log("  - 跳过：问不到 git 清单（release tarball 解出来跑就没有 .git）");
  } else {
    ok(shipped.size >= 10, `git ls-files skills 数出 ${shipped.size} 个随包发的技能`);

    const bad = unshipped(bound, shipped);
    ok(bad.length === 0,
      `${bound.length} 个绑定的技能全都随包发`,
      bad.map((n) => `skills/${n} 没被 git 跟踪`).join("\n      ")
      + "\n      （本机有、新克隆没有：用户装完打开就报「绑定的技能不存在」。"
      + "要么 git add 这个技能，要么把它从 experts.json 的 skills 里摘掉）");

    // 反向对照一：.gitignore 掉的技能，一个都不该出现在随包清单里。
    // 这条兜的是「shipped 集合算错了，宽到什么都认」——那样上面那条绿就是假的。
    const ign = ignoredSkills();
    const leaked = ign.filter((n) => shipped.has(n));
    ok(ign.length >= 5 && leaked.length === 0,
      `反向对照：.gitignore 掉的 ${ign.length} 个技能，随包清单里一个都没有`,
      "漏出来的：" + leaked.join(" "));

    // 反向对照二：编一份「绑了本机私货」的名单喂进去，必须抓得出来。
    // 兜的是另一头——unshipped() 恒返回空数组，那它永远绿。
    // 底料只取「确实随包发」的那些：直接拿 bound 当底料的话，一旦上面那条真红了，
    // 这条对照会跟着一起红——一个缺陷报两次，看的人分不清哪个是因、哪个是果。
    const fake = [...bound.filter((n) => shipped.has(n)), ign[0] || "brand-guidelines"];
    ok(unshipped(fake, shipped).join() === (ign[0] || "brand-guidelines"),
      `反向对照：名单里混进一个不随包发的 ${ign[0]}，抓得出来`,
      JSON.stringify(unshipped(fake, shipped)));
  }
}

// ---------- 规则四：`wb` 这个简写不许再长回来 ----------
// 2026-09-17 把它从仓库里清干净，是一处一处手工改的：环境变量、登录 Cookie、数据目录、
// CSS 变量和动画名、预加载暴露给页面的那个 window 对象、几个函数名和全局量。
// 手工清掉的东西会手工地长回来——下次谁顺手写个 wbFoo，没有任何人会注意到。
// 为什么在意：`wb` 太短，短到会被读成别家产品的缩写；这个项目跟腾讯 WorkBuddy 没有任何关系
// （README 末尾那段声明讲的就是这件事）。所以自己的代码里不留这两个字母打头的标识符。
// 扫的是「代码里露脸的名字」：单独成词的 wb、wbXxx、wb- / wb_ / WB- / WB_。
// **不**扫 WorkBuddy 这个词本身——README / NOTICE / 商业授权里指名道姓说「与腾讯 WorkBuddy
// 无关」「别起容易认错的近似名」，那是指示性使用，恰恰是要留着的。
// 也扫不到 owb- / OWB_ / --owb-*：前面那个 o 就是词的一部分，正则的左边界不认。
const NAMING_RE = /(^|[^A-Za-z0-9_])(wb([^A-Za-z0-9_]|$)|wb[A-Z]|wb[-_]|WB[-_])/;

// 白名单：老名字还得认得出来的地方，以及记录这次改名的变更日志。
// 按「文件 + 这一行里必须出现的字样」配对——只写文件名的话，等于把整个文件放开，
// 那么哪天有人在 server.js 里新写一个 wbFoo，这条规则就白立了。null = 整个文件豁免。
const NAMING_ALLOW = [
  [".gitignore", "wb-data/"],             // 改名前的数据目录：本机还在，得挡着别被 git add
  ["server.js", "wb)-backup-"],           // 老备份包叫这个名字，列表里得认
  ["server.js", "wb- 那个前缀"],           // 上面那行的解释
  ["public/js/app-03.js", "wb_sessions"], // 浏览器 localStorage 里的旧键，要迁过来
  ["CHANGELOG.md", null],                 // 改名这件事本身得写清楚，写清楚就得写出老名字
  ["CHANGELOG.en.md", null],
];
const namingAllowed = (file, line) =>
  NAMING_ALLOW.some(([f, mark]) => f === file && (mark === null || line.includes(mark)));

/** 返回 ["行号: 这一行"]，没命中就是空数组 */
function namingHits(file, src) {
  const out = [];
  src.split("\n").forEach((line, i) => {
    if (!NAMING_RE.test(line)) return;
    if (namingAllowed(file, line)) return;
    out.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

console.log("\n【4】`wb` 这个简写不许再回到代码里");
{
  const SKIP = new Set(["package-lock.json", path.relative(ROOT, __filename).split(path.sep).join("/")]);
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((f) => /\.(js|mjs|cjs|json|md|html|css|sh|yml|yaml|txt)$|^\.gitignore$|^Dockerfile$/.test(f))
    .filter((f) => !SKIP.has(f) && !f.startsWith("vendor/") && !f.startsWith("public/vendor/"));

  // 自检：文件列表空了、或者筛得只剩几个，下面那条「一处都没有」就是假绿。
  ok(tracked.length >= 100, `扫了 ${tracked.length} 个随包文件（少于 100 说明列表筛坏了）`);

  const hits = [];
  for (const f of tracked) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    for (const h of namingHits(f, src)) hits.push(`${f}:${h}`);
  }
  ok(hits.length === 0,
    "随包代码里没有 wb 这个简写（老名字的兼容处走白名单）",
    hits.slice(0, 8).join("\n      "));

  // 反向对照一：编一段「刚长回来」的源码喂进去，四种写法一个都不许漏。
  // 兜的是「正则写坏了，什么都不匹配」——那样上面那条永远绿。
  const fake = [
    'contextBridge.exposeInMainWorld("wbPet", {});',   // wbXxx
    'const dir = "wb-data/";',                          // wb-
    "Environment=WB_TRUST_PROXY=1",                     // WB_
    "const wb = new ExcelJS.Workbook();",               // 单独成词
  ].join("\n");
  ok(namingHits("someplace.js", fake).length === 4,
    "反向对照：wbPet / wb-data / WB_ / 单独的 wb，四种写法都抓得住",
    JSON.stringify(namingHits("someplace.js", fake)));

  // 反向对照二：现在正当的那些写法，一个都不许误伤。
  // 兜的是另一头——正则宽到把 owb-、OWB_、OpenWorkBuddy 也算进去，那这条规则会天天喊狼来了，
  // 喊到最后谁都不看，等于没有。
  const innocent = [
    "  .turn { animation: owbRise .24s var(--owb-ease); }",
    "  const raw = String(env.OPENWORKBUDDY_INTRANET || env.OWB_INTRANET || \"\");",
    "本项目与腾讯公司及其 WorkBuddy 产品无任何关联、授权、赞助或背书。",
    'const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-skill-"));',
  ].join("\n");
  ok(namingHits("someplace.js", innocent).length === 0,
    "反向对照：owb- / OWB_ / --owb-* / 声明里的 WorkBuddy 一个都没误伤",
    JSON.stringify(namingHits("someplace.js", innocent)));

  // 反向对照三：白名单是按文件配的，搬个地方就不算数。
  // 兜的是「白名单只看那段字样、不看文件」——那样一句 wb_sessions 抄到哪儿都豁免了。
  ok(namingHits("server.js", 'localStorage.getItem("wb_sessions");').length === 1,
    "反向对照：app-03.js 的豁免搬到 server.js 就不认了（白名单按文件配）");
}

console.log("\n【5】CI 一次都跑不到的测试文件，至少得能解析");
{
  // test/all.js 的 SUITES 决定了 CI 跑哪些（macOS 那条腿 npm test 跑全套，ubuntu 跑它的子集）。
  // 不在 SUITES 里的，两条腿都不碰——现在是 frontend.js 和 admin-ui.js 这两个要真开
  // BrowserWindow 的（为什么不套 xvfb 赌它能过，.github/workflows/test.yml 顶上写了）。
  // 这两个文件加起来九千多行，其中大半是塞进模板字符串、再发给页面去执行的代码。
  // 2026-09-17 踩到的雷：在 AUTH_CHECKS 那块模板里写了一句 // 注释，注释里带了一对
  // 反引号（拿它引一段代码）——模板当场从那儿断掉，后半截成了真代码。
  // 这类错只有本机开着 Electron 跑一遍才看得见，而这两个文件恰恰是最少被跑到的：
  // 改完界面的人通常只跑 npm test，而 npm test 里没它俩。
  // 这儿只做 `node --check`：文件整体能不能解析。模板**内部**的语法错它看不见
  // （那得连 ${} 插值一起求了，是另一件事），但上面那类「一个反引号把文件劈成两半」
  // 的，它当场就红。
  const os = require("os");
  const allSrc = fs.readFileSync(path.join(__dirname, "all.js"), "utf8");
  const suiteBlock = allSrc.slice(allSrc.indexOf("const SUITES = ["), allSrc.indexOf("\n];", allSrc.indexOf("const SUITES = [")));
  if (!/\["repo-hygiene"/.test(suiteBlock)) throw new Error("test/all.js 的 SUITES 没切到（里头连 repo-hygiene 都找不着），下面算出来的「CI 跑不到」名单不作数");
  const inCI = new Set([...suiteBlock.matchAll(/\["([a-z0-9-]+)"/g)].map((m) => m[1]));

  // 只算真的测试：all.js 是跑器本人，fixtures/ 里是被 require 的样本（真坏了，引它的套件当场就红）。
  const neverInCI = execFileSync("git", ["ls-files", "test"], { cwd: ROOT, encoding: "utf8" })
    .trim().split("\n")
    .filter((f) => f.endsWith(".js") && !f.includes("/fixtures/") && f !== "test/all.js")
    .filter((f) => !inCI.has(path.basename(f, ".js")));

  ok(neverInCI.length > 0 && neverInCI.includes("test/frontend.js") && neverInCI.includes("test/admin-ui.js"),
    `算出 ${neverInCI.length} 个 CI 跑不到的测试文件`,
    "名单空了或者漏了那两个 Electron 测试，说明 SUITES 解析歪了，下面两条会变成空跑：" + JSON.stringify(neverInCI));

  const checkFile = (abs) => {
    try { execFileSync(process.execPath, ["--check", abs], { stdio: "pipe" }); return ""; }
    catch (e) { return String(e.stderr || e.message).split("\n").filter(Boolean).slice(0, 3).join(" | "); }
  };
  const broken = neverInCI.map((f) => [f, checkFile(path.join(ROOT, f))]).filter(([, err]) => err);
  ok(broken.length === 0,
    "这几个文件 node --check 都过（模板字符串没被哪个反引号提前截断）",
    broken.map(([f, err]) => f + "\n        " + err).join("\n      "));

  // 反向对照：真摆一个被反引号劈开的文件进来，得抳得住。
  // 兑的是「checkFile 其实从来没真跑起来」——那样上面那条永远绿，和没写一样。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-syntax-"));
  const bait = path.join(tmp, "bait.js");
  fs.writeFileSync(bait, 'const CHECKS = `\n  // 把 `key.length` 引起来说事，模板就从这儿断了\n  ok(1);\n`;\n');
  const baitErr = checkFile(bait);
  ok(baitErr !== "", "反向对照：注释里一对反引号把模板劈断，抓得住", "摆进去的坏文件居然 --check 过了");
  fs.writeFileSync(bait, 'const CHECKS = `\n  // 把 key.length 说清楚，不用反引号\n  ok(1);\n`;\n');
  ok(checkFile(bait) === "", "反向对照：同一句注释去掉反引号就过（不是见注释就喊）");
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n【6】require 得到的文件，得真的在仓库里");
{
  // 跟【1】同一类毛病，只是更致命：**本机有、新克隆没有**。
  // 新建一个 .js 写完、跑全套测试全绿，就很容易以为完事了——可它还没进 git。
  // 本机一切正常；推上去之后别人 clone 下来、或者 Docker 里 COPY 的是纯净的工作区，
  // 启动第一行就是 Cannot find module。CI 也拦不住：actions/checkout 拉的是提交，
  // 而这个文件在本机工作区里好端端地躺着。
  // （这一节写下来的当天就抳了一个：account.js 要 require("./usage-store")，
  //   而 usage-store.js 当时还是 ?? 未跟踪。）
  const tracked = new Set(execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n"));
  if (!tracked.has("account.js")) throw new Error("git ls-files 没拿到东西（连 account.js 都不在里头），下面算出来的不作数");

  // 能解成哪些真文件。没后缀、.js、目录里的 index.js、.json 都算。
  const resolves = (rel) => [rel, rel + ".js", rel + "/index.js", rel + ".json"].find((c) => tracked.has(c));
  const onDisk = (rel) => [rel, rel + ".js", rel + "/index.js", rel + ".json"].find((c) => fs.existsSync(path.join(ROOT, c)));

  const missing = [];
  let scanned = 0, edges = 0;
  for (const f of tracked) {
    if (!f.endsWith(".js") || f.startsWith("node_modules/")) continue;
    scanned++;
    // 得先把注释和模板字符串剥掉。不剥的话满屏都是假的：
    // 测试里大量「把一段代码写进临时目录再跑」的模板，里头的 require("./server.js")
    // 是相对**那个临时目录**的；还有注释里随手写的 require("./x") ——这一节的
    // 注释自己就带了一个。假的多了，真的就没人看了。
    const src = stripTemplates(stripComments(fs.readFileSync(path.join(ROOT, f), "utf8")));
    for (const m of src.matchAll(/require\(\s*"(\.[^"]*)"\s*\)/g)) {
      edges++;
      const rel = path.posix.join(path.posix.dirname(f), m[1]);
      if (resolves(rel)) continue;
      // 盘上有、git 里没 = 正是这一节要拓的那一种；盘上也没 = 引错了路径，一样得报
      missing.push(`${f} 要 ${m[1]}（${onDisk(rel) ? "盘上有但没进 git" : "盘上也找不到"}）`);
    }
  }
  ok(scanned > 100 && edges > 200, `扫了 ${scanned} 个跟踪中的 js，${edges} 条相对 require`,
    "数字小得不像话，下一条就是空跑：scanned=" + scanned + " edges=" + edges);
  ok(missing.length === 0, "每一条 require(\"./…\") 都落在跟踪中的文件上", missing.join("\n      "));

  // 反向对照：真摆一个没进 git 的依赖进来，得抳得住。
  // 兑的是 resolves() 就不该这么宽——比如不小心写成永远返真，上面那条就永远绿。
  ok(!resolves("这个文件不存在-" + Date.now()), "反向对照：不存在的文件真的解不出来");
  ok(!!resolves("account"), "反向对照：真存在的 account.js 解得出来（不是看什么都没有）");
}

console.log("\n【7】临时目录得有人收：新前缀必须落在 e2e 那把扫帚的射程里");
{
  // 2026-09-20：磁盘报到 99%，查出来是 /var/folders 底下堆了 137G 的测试临时目录。
  // 每个用例 mkdtemp 一个新 OPENWORKBUDDY_HOME 再起 server.js，paths.js 的 seedDataDir()
  // 会把仓库 skills/ 整份铺进去——一个 home 就是 189M。跑完在 finally 里删掉的那些没事，
  // 留得下来的是三种：Ctrl-C、断言挂在建目录和 finally 中间、子进程被 SIGKILL 带走。
  //
  // 治标那一层是 test/e2e.js 顶上的 reapStaleTempHomes()：每轮开跑先清 24 小时以上没动的。
  // 可它靠一条写死的前缀正则认人，而新用例随手起个新前缀是再正常不过的事——头一版就漏了
  // 整个 e2e-* 一族：owb-* 清得干干净净，光 e2e-sched- 就留了 588 个、533 个超 24 小时。
  //
  // 所以这一节不测「清得干不干净」（那是 e2e 自己的事），只钉一件：
  // **仓库里每一个 mkdtemp 前缀，都得被那条正则认得出来。** 新前缀在这儿当场红，
  // 而不是半年后靠磁盘报警来告诉你。
  const e2eSrc = fs.readFileSync(path.join(__dirname, "e2e.js"), "utf8");
  const body = (e2eSrc.match(/function reapStaleTempHomes\(\)\s*\{[\s\S]*?\n\}/) || [""])[0];
  ok(body.length > 0 && /\nreapStaleTempHomes\(\);/.test(e2eSrc),
    "e2e.js 顶上确实有 reapStaleTempHomes()，而且真被调了",
    "找不到这个函数、或者它只是定义了没调用——那下面这些全是空跑");

  // 判据直接从那个函数体里捞正则字面量，不在这儿另抄一份：抄一份迟早两边分叉
  const reaps = [...body.matchAll(/\/\^(?:[^/\\\n]|\\.)+\/(?=\.test)/g)]
    .map((m) => { try { return new RegExp(m[0].slice(1, -1)); } catch { return null; } })
    .filter(Boolean);
  ok(reaps.length >= 2, "从函数体里捞出 " + reaps.length + " 条前缀正则当判据",
    "一条都没捞着，下一条就是空跑");
  const swept = (name) => reaps.some((re) => re.test(name));

  // 取每个 mkdtempSync(...) 括号里最后那个字符串——前缀总在最后一个参数上。
  // 不能图省事拿「第一个引号」：require("os").tmpdir() 这种写法会让你捞回来一个 os。
  const lastLiteralIn = (src, from) => {
    let depth = 1, i = from, last = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '"' || c === "'") {
        const q = c; let j = i + 1, buf = "";
        while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; buf += src[j]; j++; }
        last = buf; i = j + 1; continue;
      }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    return depth === 0 ? last : null;
  };
  // 那把扫帚只扫 os.tmpdir()。建在别处的（家目录之类）它够不着，硬塞进这条正则也是自欺——
  // 正则在 tmp 里永远匹配不到它，看着却像「有人收了」。所以那种单独走白名单，按个数钉死：
  // 多出一个就在这儿红一次，让人当面说清楚它凭什么建在 tmp 之外、谁来收。
  const OUTSIDE_TMP_OK = new Map([
    // macOS 上 Docker 跑在虚拟机里，只共享少数几个宿主机目录，/var/folders 不在其中：
    // -v 挂上去不报错，容器写得欢，宿主机一个文件都看不见。所以这个必须落在家目录下。
    // 只有 test/deploy.js --build 才会走到，且自己 finally 收尾。
    [".owb-deploytest-", "deploy.js"],
  ]);
  const prefixes = new Map();
  for (const f of scanTargets()) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    for (const m of src.matchAll(/mkdtempSync\(/g)) {
      const at = m.index + m[0].length;
      const p = lastLiteralIn(src, at);
      if (!p || prefixes.has(p)) continue;
      // 括号里提没提 tmpdir()，就是它建在哪儿的判据
      const inTmp = /tmpdir\(\)/.test(src.slice(at, at + 200));
      prefixes.set(p, { file: f, inTmp });
    }
  }
  ok(prefixes.size > 40, "扫到 " + prefixes.size + " 个 mkdtemp 前缀",
    "数字小得不像话，多半是取前缀那段没解对，下一条等于没测");
  const outside = [...prefixes].filter(([, v]) => !v.inTmp);
  ok(outside.every(([p]) => OUTSIDE_TMP_OK.has(p)) && outside.length === OUTSIDE_TMP_OK.size,
    "建在 tmp 之外的临时目录就白名单里那 " + OUTSIDE_TMP_OK.size + " 个（各自交代了为什么、谁来收）",
    "对不上：现在是 " + outside.map(([p, v]) => p + "（" + v.file + "）").join("、"));
  const orphans = [...prefixes].filter(([p, v]) => v.inTmp && !swept(p + "Ab12Cd"));
  ok(orphans.length === 0,
    "每个前缀都在 reapStaleTempHomes 的射程里（没人收的临时目录会一直堆到磁盘满）",
    orphans.map(([p, v]) => p + "（" + v.file + "）").join("、")
      + "\n      要么改用现成前缀，要么把它加进 e2e.js reapStaleTempHomes 的那条正则");

  // 反向对照：判据不能是「看什么都认」，也不能是「看什么都不认」
  ok(!swept("zz-别人家的-Ab12Cd"), "反向对照：不相干的前缀扫不到（不然这把扫帚会清到别人头上）");
  ok(swept("owb-Ab12Cd"), "反向对照：owb- 认得出（证明这判据真在生效）");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
