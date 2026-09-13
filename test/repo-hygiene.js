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
//
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
  const ignoredOf = (rels) => {
    if (!rels.length) return new Set();
    try {
      const out = execFileSync("git", ["check-ignore", "--stdin"],
        { cwd: ROOT, input: rels.join("\n"), encoding: "utf8" });
      return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
    } catch (e) {
      // 一个都没被忽略时 git 用退出码 1 表示，不是出错
      if (e.status === 1) return new Set();
      throw e;
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

  // 反向对照：拿一个确定被忽略的路径去问，必须答「被忽略」
  const probe = ignoredOf(["node_modules", "skills/brand-guidelines", "server.js"]);
  ok(probe.has("node_modules") && probe.has("skills/brand-guidelines") && !probe.has("server.js"),
    "反向对照：git check-ignore 认得出谁被忽略、谁没有",
    [...probe].join(" "));
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
