"use strict";
/**
 * 类型闸门：只拦「报了就一定是 bug」的那三种 tsc 错误。
 *
 *   node test/typecheck.js     （= npm run typecheck）
 *
 * 为什么只认三种：审计把全仓 JS 丢给 tsc --checkJs，报了上千条，逐条核下来真 bug 约 0.6%——
 * 剩下的是「JS 本来就这么写」：对象后来才加的字段、JSDoc 写得随意、DOM 元素没收窄。
 * 但有三种几乎条条是真的：
 *   TS2304  找不到这个名字       （删了函数还有人在调、复制粘贴漏了一个变量——跑到那一行就 ReferenceError）
 *   TS2552  找不到，你是不是想写 X （拼错名字，同上）
 *   TS1117  对象字面量里同一个键写了两遍（后一个悄悄盖掉前一个）
 * 所以：全仓只让这三种报红；文件顶上写了 // @ts-check 的，是作者主动认领了类型，报什么都红。
 *
 * 分四趟跑（并行）：
 *   后端     tsconfig.check.json 本身。CommonJS，谁用谁 require。
 *   主界面   public/index.html 按顺序加载的 <script>，外加 loadScriptOnce("js/…") 按需拉的那几个。
 *   后台     public/admin.html 的 <script>。
 *   类型声明 types/ 下自己写的 .d.ts，报什么都红。上面三趟开着 skipLibCheck，而它不分第三方
 *            还是自己的，凡是 .d.ts 一律不查：drama.d.ts 里引了个不存在的类型名，那个字段
 *            悄悄变成 any，用它的 @ts-check 文件照样全绿。所以单开一趟把它关掉，只认 types/ 下的报错。
 * 前端为什么按「页」分、不把 public/js 一锅端：同一页的脚本共享一个全局作用域（A 文件定义、
 * B 文件直接调），tsc 得把它们放一起看才知道名字在哪；可主界面和后台是两个页面，
 * 各有各的 esc / ic / toast，放一起就互相「遮住」——后台删了自己的 esc，主界面那个会顶上，
 * 真正的 TS2304 就被吞了。哪个页面都没引用的前端文件，归到主界面那一趟，保证至少被看一次。
 *
 * tsconfig.check.json 里写的是 checkJs:false：直接 `npx tsc -p tsconfig.check.json` 时，
 * 只对认领了 @ts-check 的文件报类型错，不会刷出几百条「JS 本来就这么写」。这里命令行再加
 * --checkJs：让 tsc 把所有文件的错误都吐出来，由下面过滤。不加的话 tsc 对没认领的文件
 * 只报语法级错误，TS2304 一条都出不来。
 *
 * 注释里的 TS2304 放过：JSDoc 写成 `@param info { prompt, cached }` 时，tsc 会把 prompt
 * 当成类型名去找，报「找不到 prompt」。这种错不会让任何一行代码在运行时出事，
 * 所以「落在注释里」的一律不算（带 @ts-check 的文件除外：认领了就得写对）。
 * 判「在不在注释里」用 tsc 自己的扫描器，不按行首有没有 * 猜——代码续行也可能以 * 开头。
 *
 * 没装 typescript（比如只装了运行依赖）：本地跳过，CI 上直接红——CI 跑的是 npm ci，
 * 装不上就是依赖声明坏了，不能让这道闸门悄悄变成空跑。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CONFIG = path.join(ROOT, "tsconfig.check.json");
const GLOBALS = path.join(ROOT, "types", "globals.d.ts");
const RED_CODES = new Set([2304, 2552, 1117]);
// 一趟 tsc 的上限。本机后端那趟 4~5 秒；给到 4 分钟是为了 CI 冷启动和机器很忙的时候，
// 真卡住了宁可红，也不能让 all.js 那层 30 分钟的保险丝来收场
const RUN_TIMEOUT_MS = 240000;

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra ? "\n      " + extra : "")); }
};
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

// ── 没装 typescript 时怎么办：本地跳过、CI 红 ──
// GitHub Actions 的 CI 是 "true"；有人本地 export CI=false / 0 也得认成「不是 CI」
function isCI(env) {
  const v = String(env.CI || "").trim().toLowerCase();
  return v !== "" && v !== "false" && v !== "0";
}
function whenMissing(env) {
  return isCI(env) ? "fail" : "skip";
}

let tscBin = null, ts = null;
try {
  tscBin = require.resolve("typescript/bin/tsc");
  ts = require("typescript");
} catch {}
if (!tscBin || !ts) {
  if (whenMissing(process.env) === "fail") {
    console.log("✗ 没装 typescript：CI 上跑的是 npm ci，装不上说明 devDependencies 坏了，这道闸门不能空跑");
    process.exit(1);
  }
  console.log("跳过：没装 typescript（npm install 之后再跑；CI 上缺它会直接红）");
  process.exit(0);
}

// ── 前端每一页加载了哪些脚本 ──

/**
 * 从页面 HTML 里按顺序挑出本地 <script src>，换成仓库内路径（public/…）。外链和 vendor 不收。
 * <!-- --> 里注释掉的不算：浏览器不加载它，文件删了也不该让「页面引用的脚本都在」变红
 */
function pageScripts(html) {
  const out = [];
  const live = String(html || "").replace(/<!--[\s\S]*?-->/g, "");
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(live))) {
    const src = m[1].split(/[?#]/)[0];
    if (/^([a-z]+:)?\/\//i.test(src)) continue;
    const p = "public/" + src.replace(/^\.?\/+/, "");
    if (p.startsWith("public/vendor/")) continue;
    out.push(p);
  }
  return out;
}

/** 这些脚本里 loadScriptOnce("js/…") 按需拉进来的本地脚本（画布那个就是这么来的） */
function lazyScripts(files) {
  const out = [];
  for (const f of files) {
    let text = "";
    try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    const re = /loadScriptOnce\(\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(text))) {
      const src = m[1].split(/[?#]/)[0];
      if (/^([a-z]+:)?\/\//i.test(src)) continue;
      const p = "public/" + src.replace(/^\.?\/+/, "");
      if (p.startsWith("public/vendor/")) continue;
      out.push(p);
    }
  }
  return out;
}

/** public/ 下所有自己写的 .js（不含 vendor） */
function allFrontendFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) { if (p !== "public/vendor") walk(p); }
      else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p);
    }
  };
  walk("public");
  return out.sort();
}

/** types/ 下自己写的 .d.ts（绝对路径）。「类型声明」那一趟只查这些 */
function ownDeclFiles() {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(path.join(ROOT, "types"));
  return out.sort();
}

function frontendPrograms() {
  const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { return ""; } };
  const uniq = (a) => [...new Set(a)];
  const indexTop = pageScripts(read("public/index.html"));
  const index = uniq(indexTop.concat(lazyScripts(indexTop)));
  const adminTop = pageScripts(read("public/admin.html"));
  const admin = uniq(adminTop.concat(lazyScripts(adminTop)));
  const orphans = allFrontendFiles().filter((f) => !index.includes(f) && !admin.includes(f));
  return { index: index.concat(orphans), admin, orphans };
}

/**
 * .gitignore 里「以 / 结尾」的目录行 → 判一个仓库内路径在不在被挡掉的目录里（和 eslint.config.js 同一个口径）。
 * 这些目录里是本机私货或跑出来的产物（eval/runs/ 底下全是模型写的代码），别人 clone 下来没有：
 * 查进来的话本机红、CI 绿，这道闸门就没人信了
 */
function gitignoredDirMatcher(text) {
  const res = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!") || !line.endsWith("/")) continue;
    const dir = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!dir) continue;
    const body = dir.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    // 中间带斜杠的只认仓库根下那一处；不带的哪一层都算
    res.push(new RegExp((dir.includes("/") ? "^" : "(^|/)") + body + "/"));
  }
  return (relPath) => res.some((re) => re.test(relPath));
}

// ── 跑 tsc ──

function tmpConfig(dir, name, files, extra) {
  const cfg = {
    extends: CONFIG,
    compilerOptions: Object.assign({
      // 浏览器里跑的经典脚本：要 DOM，不要 node 的类型；也别按 node16 的规则把文件当成模块
      // （package.json 写着 "type": "commonjs"，node16 下每个 .js 都会被当成独立模块，
      //  跨文件的全局一个都认不出来——实测主界面 2456 条 TS2304 全是这么来的）
      lib: ["es2023", "dom", "dom.iterable"],
      types: [],
      module: "esnext",
      moduleResolution: "bundler",
    }, extra || {}),
    include: [],
    files: files.map((f) => path.isAbsolute(f) ? f : path.join(ROOT, f)),
  };
  const p = path.join(dir, name + ".json");
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function runTsc(label, configPath) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const args = [tscBin, "-p", configPath, "--checkJs", "--pretty", "false", "--listFiles"];
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, RUN_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ label, code, signal, out, secs: (Date.now() - t0) / 1000 });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ label, code: null, signal: null, out: String(e && e.message || e), secs: (Date.now() - t0) / 1000 });
    });
  });
}

/**
 * tsc --pretty false 的输出：
 *   path/to/a.js(12,5): error TS2304: Cannot find name 'x'.
 *   error TS2688: Cannot find type definition file for 'node'.      ← 配置级，没有位置
 *     后面缩进的是同一条的补充说明，跳过
 *   /abs/path/b.js                                                   ← --listFiles
 */
function parseTscOutput(out) {
  const errors = [], files = [];
  for (const raw of String(out).split(/\r?\n/)) {
    if (!raw || /^\s/.test(raw)) continue;
    let m = raw.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/);
    if (m) {
      errors.push({ file: path.resolve(ROOT, m[1]), line: +m[2], col: +m[3], code: +m[4], msg: m[5] });
      continue;
    }
    m = raw.match(/^error TS(\d+): (.*)$/);
    if (m) { errors.push({ file: null, line: 0, col: 0, code: +m[1], msg: m[2] }); continue; }
    if (path.isAbsolute(raw.trim()) && /\.(js|cjs|mjs|ts)$/.test(raw.trim())) files.push(path.normalize(raw.trim()));
  }
  return { errors, files };
}

// ── 哪些算红 ──

const infoCache = new Map();
/** 文件顶上有没有认领 @ts-check、注释都在哪几段。按 tsc 自己的规矩判，不自己猜 */
function fileInfo(file) {
  if (infoCache.has(file)) return infoCache.get(file);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch {}
  // tsc 只认文件开头那一串注释里的 // @ts-check（写在中间的不算），这里照同样的规矩
  const head = ts.getLeadingCommentRanges(text, 0) || [];
  const tsCheck = head.some((r) => r.kind === ts.SyntaxKind.SingleLineCommentTrivia
    && /^\/\/\/?\s*@ts-check\b/.test(text.slice(r.pos, r.end)));
  const info = { text, tsCheck, sf: null, comments: null };
  infoCache.set(file, info);
  return info;
}

/**
 * 写了 // @ts-check、tsc 却不认：常见是写在 "use strict"; 下面。tsc 只看第一条语句之前的注释，
 * 这个文件于是既不被当成认领（直接 npx tsc -p 时一条类型错都不报），这里也按没认领的放过——
 * 作者以为它在被查，其实谁都没查。docs/编码规范.md 写的是「放在 "use strict"; 上面」
 */
function misplacedTsCheck(info) {
  return !info.tsCheck && /^[ \t]*\/\/\/?[ \t]*@ts-check\b/m.test(info.text);
}

/** 把整份文件的注释区间都收齐：挨个节点、挨个 token 看前导和尾随注释。只在要判的时候才算 */
function commentRanges(info) {
  if (info.comments) return info.comments;
  const sf = info.sf || (info.sf = ts.createSourceFile("x.js", info.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  const seen = new Set(), out = [];
  const add = (rs) => { for (const r of rs || []) if (!seen.has(r.pos)) { seen.add(r.pos); out.push([r.pos, r.end]); } };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(info.text, node.pos));
    add(ts.getTrailingCommentRanges(info.text, node.end));
    // JSDoc 节点本身就在注释里，它整段已经被上面那一句收进来了，再往里钻只会把注释正文当代码扫
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    for (const ch of node.getChildren(sf)) visit(ch);
  };
  visit(sf);
  info.comments = out;
  return out;
}

function inComment(info, line, col) {
  const sf = info.sf || (info.sf = ts.createSourceFile("x.js", info.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  let pos;
  try { pos = ts.getPositionOfLineAndCharacter(sf, line - 1, col - 1); } catch { return false; }
  return commentRanges(info).some(([a, b]) => pos >= a && pos < b);
}

/** 一条错误红不红：没位置的（配置坏了）红；@ts-check 文件里的全红；其余只有那三种、且不在注释里才红 */
function isRed(e) {
  if (!e.file) return true;
  if (/\.d\.ts$/.test(e.file)) return true;
  const info = fileInfo(e.file);
  if (info.tsCheck) return true;
  if (!RED_CODES.has(e.code)) return false;
  return !inComment(info, e.line, e.col);
}

// ── 反向对照用的样本：每一种「该红 / 该放」都有一条，整条管道真跑一遍 ──
// 名字各不相同：没有 package.json 的临时目录里这些是经典脚本，共享一个全局作用域
const FIXTURES = {
  "fx-undef.js": "function fxUndef() {\n  return notDefinedAnywhere + 1;\n}\n",
  "fx-typo.js": "const fxTotalCount = 1;\nfunction fxTypo() {\n  return fxTotalCont;\n}\n",
  "fx-dupe.js": "const fxDupe = { k: 1, k: 2 };\n",
  "fx-jsdoc.js": "/**\n * @param info { prompt, cached }\n */\nfunction fxJsdoc(info) {\n  return info;\n}\n",
  "fx-star.js": "const fxStar = 2\n  * fxMissingFactor;\n",
  "fx-checked.js": "// @ts-check\nconst fxChecked = 1;\nfxChecked.foo();\n",
  "fx-loose.js": "const fxLoose = 1;\nfxLoose.foo();\n",
  "fx-late.js": "\"use strict\";\n// @ts-check\nconst fxLate = 1;\nfxLate.foo();\n",
};
// 「类型声明」那一趟的反向对照：跟 types/ 下的真文件一起查，证明那一趟真的关掉了 skipLibCheck
const FIXTURE_DTS = { name: "fx-bad.d.ts", text: "declare var fxBadDecl: FxNoSuchType;\n" };

async function main() {
  const t0 = Date.now();
  // 取真路径：macOS 的临时目录 /var 是 /private/var 的软链，两种写法混着比会对不上。
  // 前缀用 owb-：中途被杀留下的，e2e.js 的 reapStaleTempHomes 会按这个前缀收走
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owb-typecheck-")));
  try {
    // ── 配置本身：spec 钉死的那几个开关 ──
    console.log("\n【1】tsconfig.check.json");
    const parsed = ts.readConfigFile(CONFIG, ts.sys.readFile);
    const co = (parsed.config && parsed.config.compilerOptions) || {};
    ok(!parsed.error, "读得出来", parsed.error && ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
    ok(co.allowJs === true && co.checkJs === false, "allowJs 开、checkJs 关（直接 npx tsc -p 时只报认领了 @ts-check 的文件；全仓那一遍由这里加 --checkJs 再过滤）");
    ok(co.noEmit === true && !co.composite && !co.incremental,
      "noEmit 开、composite/incremental 都不开（composite 下裸跑 tsc 会往源码旁边吐 .d.ts / .tsbuildinfo）");
    ok(co.skipLibCheck === true, "skipLibCheck 开（第三方的 .d.ts 不归我们查；自己的 types/*.d.ts 另开一趟关掉它来查）");
    ok(fs.existsSync(GLOBALS), "types/globals.d.ts 在");
    const ownDts = ownDeclFiles();

    // ── 前端分页 ──
    console.log("\n【2】前端按页分趟");
    const fe = frontendPrograms();
    const missing = fe.index.concat(fe.admin).filter((f) => !fs.existsSync(path.join(ROOT, f)));
    ok(missing.length === 0, "页面引用的本地脚本都在磁盘上", "找不到：" + missing.join("、") + "（页面加载时会 404）");
    const idx = fe.index.filter((f) => !missing.includes(f));
    const adm = fe.admin.filter((f) => !missing.includes(f));
    ok(idx.includes("public/js/app-01.js") && idx.includes("public/js/i18n.js") && idx.includes("public/svgfig.js"),
      "主界面那趟有 svgfig / i18n / app-01（从 index.html 的 <script> 读出来的）", idx.join(" "));
    ok(idx.includes("public/js/app-07-canvas.js"), "画布脚本是 loadScriptOnce 按需拉的，也跟着主界面那趟一起查");
    ok(adm.includes("public/js/admin.js") && !adm.includes("public/js/app-01.js"),
      "后台那趟有 admin.js、没有主界面的脚本（各有各的 esc / toast，放一起会互相遮住）", adm.join(" "));
    const covered = new Set(idx.concat(adm));
    const unseen = allFrontendFiles().filter((f) => !covered.has(f));
    ok(unseen.length === 0, "public/ 下每个自己写的 .js 至少被一趟查到", unseen.join("、"));
    if (fe.orphans.length) console.log("    （哪个页面都没引用、归到主界面那趟的：" + fe.orphans.join("、") + "）");
    // 反向对照：解析器认得出 ./ 和 / 开头、带查询串的写法，外链和 vendor 不收
    const probe = pageScripts('<script src="/js/a.js?v=3"></script><script defer src=\'./b.js\'></script>'
      + '<script src="https://cdn.example.com/x.js"></script><script src="/vendor/joint/joint.min.js"></script><script>inline()</script>'
      + '<!-- 停用：<script src="js/gone.js"></script> -->');
    ok(JSON.stringify(probe) === JSON.stringify(["public/js/a.js", "public/b.js"]),
      "反向对照：<script src> 解析（/ 和 ./ 开头、带 ?v=、外链、vendor、<!-- --> 里注释掉的都跳过）", JSON.stringify(probe));

    // ── 并行跑五趟：后端、主界面、后台、类型声明、样本 ──
    for (const [name, text] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(tmp, name), text);
    const fxDts = path.join(tmp, FIXTURE_DTS.name);
    fs.writeFileSync(fxDts, FIXTURE_DTS.text);
    const runs = await Promise.all([
      runTsc("后端", CONFIG),
      runTsc("主界面", tmpConfig(tmp, "index", [GLOBALS].concat(idx))),
      runTsc("后台", tmpConfig(tmp, "admin", [GLOBALS].concat(adm))),
      // 前后端的声明都在这一趟：DOM 和 node 的类型一起给，免得 drama.d.ts 用 Buffer、globals.d.ts
      // 用 HTMLElement 时报假的「找不到」。临时配置在系统临时目录里，types 默认按配置所在目录找
      // node_modules/@types，找不着，所以显式指回仓库
      runTsc("类型声明", tmpConfig(tmp, "decl", ownDts.concat(fxDts), {
        skipLibCheck: false, types: ["node"], typeRoots: [path.join(ROOT, "node_modules", "@types")],
      })),
      runTsc("样本", tmpConfig(tmp, "fixture", Object.keys(FIXTURES).map((n) => path.join(tmp, n)),
        { lib: ["es2023"] })),
    ]);
    const res = {};
    for (const r of runs) res[r.label] = Object.assign(r, parseTscOutput(r.out));

    // ── 样本：整条管道的反向对照 ──
    console.log("\n【3】反向对照：拿编出来的样本走一遍同一条管道");
    const fx = res["样本"];
    const fxErr = (name, code) => fx.errors.filter((e) => e.file === path.join(tmp, name) && (code == null || e.code === code));
    const fxRed = (name) => fxErr(name).filter(isRed);
    ok(fxErr("fx-undef.js", 2304).length === 1 && fxRed("fx-undef.js").length === 1, "用了没定义的名字 → TS2304 红");
    ok(fxErr("fx-typo.js", 2552).length === 1 && fxRed("fx-typo.js").length === 1, "名字拼错一个字母 → TS2552 红");
    ok(fxErr("fx-dupe.js", 1117).length === 1 && fxRed("fx-dupe.js").length === 1, "对象里同一个键写两遍 → TS1117 红");
    ok(fxErr("fx-jsdoc.js", 2304).length >= 1 && fxRed("fx-jsdoc.js").length === 0,
      "JSDoc 里 `@param info { prompt, cached }` 的 TS2304 放过（tsc 确实报了，是这里认出它在注释里）");
    ok(fxRed("fx-star.js").length === 1, "以 * 开头的代码续行里的 TS2304 照样红（判注释靠扫描器，不靠看行首）");
    ok(fxErr("fx-checked.js", 2339).length === 1 && fxRed("fx-checked.js").length === 1,
      "认领了 @ts-check 的文件，别的错误（TS2339）也红");
    ok(fxErr("fx-loose.js", 2339).length === 1 && fxRed("fx-loose.js").length === 0,
      "没认领的文件，TS2339 这种「JS 本来就这么写」的放过");
    const lateInfo = fileInfo(path.join(tmp, "fx-late.js"));
    ok(!lateInfo.tsCheck && misplacedTsCheck(lateInfo) && !misplacedTsCheck(fileInfo(path.join(tmp, "fx-checked.js")))
      && !misplacedTsCheck(fileInfo(path.join(tmp, "fx-loose.js"))),
      "写在 \"use strict\"; 下面的 // @ts-check 认得出来（tsc 不认它，下面全仓那几趟会单独报红）");
    const decl = res["类型声明"];
    const fxDtsRed = decl.errors.filter((e) => e.file === fxDts && e.code === 2304).filter(isRed);
    ok(fxDtsRed.length === 1, "「类型声明」那一趟真关了 skipLibCheck：.d.ts 里引了不存在的类型 → TS2304 红",
      "样本 .d.ts 没报错：那一趟的 skipLibCheck 多半又开回去了，types/ 下写错什么都查不出来");
    ok(isRed({ file: null, line: 0, col: 0, code: 2688, msg: "" }), "没有位置的配置级错误（比如找不到 @types/node）一律红");
    const parsedProbe = parseTscOutput("a.js(3,7): error TS2304: Cannot find name 'q'.\n  补充说明\nerror TS5083: Cannot read file.\n"
      + path.join(ROOT, "server.js") + "\n");
    ok(parsedProbe.errors.length === 2 && parsedProbe.errors[0].line === 3 && parsedProbe.errors[0].col === 7
      && parsedProbe.errors[1].file === null && parsedProbe.files.length === 1,
      "输出解析：带位置的、没位置的、缩进的补充行、--listFiles 的文件行各归各位");
    ok(whenMissing({ CI: "true" }) === "fail" && whenMissing({}) === "skip" && whenMissing({ CI: "false" }) === "skip",
      "没装 typescript：CI 上红、本地跳过（CI=false 也算本地）");
    const ignProbe = gitignoredDirMatcher("# x\nlogs/\neval/runs/\nskills/*-pro/\n!keep/\n*.log\n");
    ok(ignProbe("eval/runs/2026/workspace/a.js") && ignProbe("engines/logs/a.js") && ignProbe("skills/abc-pro/x.js")
      && !ignProbe("eval/run.js") && !ignProbe("server.js") && !ignProbe("skills/abc/x.js") && !ignProbe("keep/a.js"),
      ".gitignore 目录行的判法：带斜杠的只认根下、不带的哪层都算、* 不跨目录、注释和 ! 行不算");

    // ── 正式三趟 ──
    console.log("\n【4】全仓");
    const minFiles = { "后端": 80, "主界面": 8, "后台": 2 };
    const mustSee = { "后端": "server.js", "主界面": "public/js/app-01.js", "后台": "public/js/admin.js" };
    let gitignoreText = "";
    try { gitignoreText = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"); } catch {}
    const ignoredByGit = gitignoredDirMatcher(gitignoreText);
    let totalRed = 0;
    for (const label of ["后端", "主界面", "后台"]) {
      const r = res[label];
      const ours = r.files.filter((f) => f.startsWith(ROOT + path.sep) && !f.includes(path.sep + "node_modules" + path.sep)
        && /\.(js|cjs|mjs)$/.test(f)).map(rel);
      const crashed = r.signal || r.code == null || r.code > 2 || (r.code !== 0 && r.errors.length === 0);
      ok(!crashed, `${label}：tsc 正常跑完（${r.secs.toFixed(1)}s）`,
        (r.signal ? "被 " + r.signal + " 杀了（超过 " + RUN_TIMEOUT_MS / 1000 + " 秒？）" : "退出码 " + r.code) + "\n      " + r.out.slice(-800));
      ok(ours.length >= minFiles[label] && ours.includes(mustSee[label]),
        `${label}：真查了 ${ours.length} 个 JS 文件（含 ${mustSee[label]}）`,
        "少于 " + minFiles[label] + " 个或者没有 " + mustSee[label] + "：配置的 include 多半写坏了，零报错是假绿");
      const privy = ours.filter(ignoredByGit);
      ok(privy.length === 0, `${label}：没把 .gitignore 挡掉的目录查进来（本机私货、跑出来的产物）`,
        privy.slice(0, 5).join("、") + (privy.length > 5 ? " 等 " + privy.length + " 个" : "") + "（去 tsconfig.check.json 的 exclude 里挡掉）");
      const late = ours.filter((f) => misplacedTsCheck(fileInfo(path.join(ROOT, f))));
      ok(late.length === 0, `${label}：// @ts-check 都写在文件最顶上（写在语句后面 tsc 不认，等于没认领）`,
        late.join("、") + "（挪到第一行，\"use strict\"; 上面）");
      const red = r.errors.filter(isRed);
      const checked = [...new Set(ours.filter((f) => fileInfo(path.join(ROOT, f)).tsCheck))];
      const loose = {};
      for (const e of r.errors) if (!isRed(e)) loose["TS" + e.code] = (loose["TS" + e.code] || 0) + 1;
      const looseTop = Object.entries(loose).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + "×" + v).join(" ");
      totalRed += red.length;
      ok(red.length === 0,
        `${label}：没有红的（认领了 @ts-check 的 ${checked.length} 个文件零错误；其余放过 ${r.errors.length - red.length} 条${looseTop ? "：" + looseTop + "…" : ""}）`,
        red.slice(0, 40).map((e) => (e.file ? rel(e.file) + ":" + e.line + ":" + e.col + " " : "") + "TS" + e.code + " " + e.msg).join("\n      ")
          + (red.length > 40 ? "\n      …还有 " + (red.length - 40) + " 条" : ""));
    }

    // 类型声明那一趟：只认 types/ 下自己写的（第三方 .d.ts 这趟也被顺带查了，它们的错不归我们）
    {
      const typesDir = path.join(ROOT, "types") + path.sep;
      const crashed = decl.signal || decl.code == null || decl.code > 2 || (decl.code !== 0 && decl.errors.length === 0);
      ok(!crashed, `类型声明：tsc 正常跑完（${decl.secs.toFixed(1)}s）`,
        (decl.signal ? "被 " + decl.signal + " 杀了" : "退出码 " + decl.code) + "\n      " + decl.out.slice(-800));
      const seen = new Set(decl.files);
      const unseenDts = ownDts.filter((f) => !seen.has(f));
      ok(ownDts.includes(GLOBALS) && unseenDts.length === 0,
        `类型声明：types/ 下 ${ownDts.length} 个 .d.ts 都查了（${ownDts.map(rel).join("、")}）`, "没查到：" + unseenDts.map(rel).join("、"));
      const red = decl.errors.filter((e) => !e.file || e.file.startsWith(typesDir));
      totalRed += red.length;
      ok(red.length === 0, "类型声明：types/ 下零错误（写错一个类型名，用到它的地方会悄悄变成 any）",
        red.slice(0, 40).map((e) => (e.file ? rel(e.file) + ":" + e.line + ":" + e.col + " " : "") + "TS" + e.code + " " + e.msg).join("\n      "));
    }
    if (totalRed) {
      console.log("\n    怎么修：TS2304/TS2552 是名字找不到——拼错了、删了还在用、或者是别的文件挂到全局上的（那就去 types/globals.d.ts 登记，写明是谁挂的）；"
        + "\n    TS1117 是同一个键写了两遍；@ts-check 文件里的其它错误照 tsc 说的改，改不动就先把那行 @ts-check 拿掉。");
    }
    console.log(`\n    用时 ${((Date.now() - t0) / 1000).toFixed(1)}s（五趟并行：${runs.map((r) => r.label + " " + r.secs.toFixed(1) + "s").join("、")}）`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().then(() => {
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
}, (e) => {
  console.log("✗ 类型闸门自己崩了：" + (e && e.stack || e));
  process.exit(1);
});
