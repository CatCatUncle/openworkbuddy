"use strict";
/**
 * ESLint 闸门：只对「新增的」违规报红。
 *
 *   node test/lint.js                   （= npm run lint）
 *   node test/lint.js --write-baseline  （把现在的违规全记进基线；只在确认「这些先不修」时用）
 *
 * 规则开哪几条见 eslint.config.js 顶上（十二条，每条命中即 bug）。这里管的是「怎么判红」：
 *   - 已知的违规记在 test/lint-baseline.json，按「文件 + 规则 + 原话」计数，不记行号——
 *     上面加一行、下面所有行号都挪，按行号记的基线会让每次无关的改动都红一片。
 *   - 同一个文件同一条规则的次数比基线多了，多出来的就是新增的，红。
 *   - 基线里记着、现在已经没了的：提示一句去清，不红（修好 bug 不该被惩罚）。
 *   - 解析不了的文件（语法错）永远红，不许进基线：那个文件在运行时根本加载不起来。
 * 基线现在是空的，也应该一直是空的：新发现的违规当场修，别往基线里塞。
 *
 * 没装 eslint：本地跳过，CI 上直接红（CI 跑的是 npm ci，装不上就是依赖声明坏了）。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BASELINE = path.join(__dirname, "lint-baseline.json");

// 必须和 eslint.config.js 里开的一模一样。多开一条会误报的，这道闸门很快就没人信了；
// 少开一条，那一类 bug 就悄悄没人管了
const EXPECTED_RULES = [
  "no-dupe-keys", "no-unreachable", "no-unsafe-finally", "no-func-assign", "no-redeclare", "no-self-assign",
  "no-dupe-else-if", "no-const-assign", "valid-typeof", "use-isnan", "getter-return", "no-dupe-class-members",
];

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra ? "\n      " + extra : "")); }
};
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

// GitHub Actions 的 CI 是 "true"；本地 export CI=false / 0 也认成「不是 CI」
function isCI(env) {
  const v = String(env.CI || "").trim().toLowerCase();
  return v !== "" && v !== "false" && v !== "0";
}

let ESLint = null;
try { ({ ESLint } = require("eslint")); } catch {}
if (!ESLint) {
  if (isCI(process.env)) {
    console.log("✗ 没装 eslint：CI 上跑的是 npm ci，装不上说明 devDependencies 坏了，这道闸门不能空跑");
    process.exit(1);
  }
  console.log("跳过：没装 eslint（npm install 之后再跑；CI 上缺它会直接红）");
  process.exit(0);
}

// ── 和基线比 ──

/** 一条违规在基线里的身份：文件 + 规则 + 原话。不带行号，理由见文件顶上 */
const keyOf = (v) => v.file + "\u0000" + v.rule + "\u0000" + v.message;

/**
 * current: [{ file, rule, message, line, col }]（本次扫出来的，每条一项）
 * baseline: [{ file, rule, message, count }]
 * → fresh：比基线多出来的（红）；stale：基线里记着、现在少了的（只提示）
 */
function diffBaseline(current, baseline) {
  const left = new Map();
  for (const b of baseline || []) left.set(keyOf(b), (left.get(keyOf(b)) || 0) + (Number(b.count) || 1));
  const fresh = [];
  for (const v of current) {
    const k = keyOf(v);
    const n = left.get(k) || 0;
    if (n > 0) left.set(k, n - 1);
    else fresh.push(v);
  }
  const stale = [];
  for (const b of baseline || []) {
    const n = left.get(keyOf(b)) || 0;
    if (n > 0) { stale.push({ file: b.file, rule: b.rule, message: b.message, count: n }); left.set(keyOf(b), 0); }
  }
  return { fresh, stale };
}

/** 本次的违规 → 基线文件的写法（同一个键合并计数，排好序，diff 起来稳定） */
function toBaseline(current) {
  const m = new Map();
  for (const v of current) {
    const k = keyOf(v);
    if (!m.has(k)) m.set(k, { file: v.file, rule: v.rule, message: v.message, count: 0 });
    m.get(k).count++;
  }
  return [...m.values()].sort((a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
}

/** ESLint 的结果拆成两堆：解析不了的（永远红）和按规则报的（跟基线比）。只收 error 级别 */
function splitResults(results) {
  const fatal = [], violations = [];
  for (const r of results) {
    for (const m of r.messages) {
      const v = { file: rel(r.filePath), rule: m.ruleId || "(解析失败)", message: m.message, line: m.line || 0, col: m.column || 0 };
      if (m.fatal || !m.ruleId) fatal.push(v);
      else if (m.severity === 2) violations.push(v);
    }
  }
  return { fatal, violations };
}

const show = (v) => `${v.file}:${v.line}:${v.col}  ${v.rule}  ${v.message}`;

async function main() {
  const t0 = Date.now();
  const eslint = new ESLint({ cwd: ROOT });

  console.log("\n【1】配置：开的正好是那十二条，该忽略的目录都忽略了");
  const cfgOf = async (f) => eslint.calculateConfigForFile(path.join(ROOT, f));
  const serverCfg = await cfgOf("server.js");
  const on = Object.entries((serverCfg && serverCfg.rules) || {})
    .filter(([, v]) => { const s = Array.isArray(v) ? v[0] : v; return s !== 0 && s !== "off"; })
    .map(([k]) => k).sort();
  const want = EXPECTED_RULES.slice().sort();
  ok(JSON.stringify(on) === JSON.stringify(want), "开着的规则正好是那十二条（没多开会误报的，也没漏）",
    "多了：" + on.filter((r) => !want.includes(r)).join("、") + "；少了：" + want.filter((r) => !on.includes(r)).join("、"));
  ok(!on.includes("no-undef"), "no-undef 没开（前端十来个文件共享全局，交给 typecheck 的 TS2304 整页一起看）");
  ok(serverCfg && serverCfg.languageOptions.sourceType === "commonjs", "后端按 CommonJS 解析");
  const feCfg = await cfgOf("public/js/app-01.js");
  ok(feCfg && feCfg.languageOptions.sourceType === "script", "public/js 按经典 <script> 解析（顶层声明就是全局）");
  const mjsCfg = await cfgOf("scripts/__probe__.mjs");
  ok(mjsCfg && mjsCfg.languageOptions.sourceType === "module", ".mjs 按 ES module 解析");
  const mustIgnore = ["workspace/a.js", "projects/p/a.js", "dist/a.js", "build/a.js", "node_modules/x/a.js",
    "任务_整理/a.js", "public/vendor/joint/joint.min.js"];
  const notIgnored = [];
  for (const f of mustIgnore) if (!(await eslint.isPathIgnored(path.join(ROOT, f)))) notIgnored.push(f);
  ok(notIgnored.length === 0, "用户数据、构建产物、依赖、任务_* 临时目录、public/vendor 都不查", "漏了：" + notIgnored.join("、"));
  const wronglyIgnored = [];
  for (const f of ["server.js", "public/js/app-01.js", "test/lint.js", "engines/__probe__.js"]) {
    if (await eslint.isPathIgnored(path.join(ROOT, f))) wronglyIgnored.push(f);
  }
  ok(wronglyIgnored.length === 0, "反向对照：自己写的代码没被误忽略", "被忽略了：" + wronglyIgnored.join("、"));

  console.log("\n【2】反向对照：每条规则喂一段错代码，都得抓得到");
  const probePath = path.join(ROOT, "__lint_probe__.js");
  const lintProbe = async (code, filePath) => {
    const [r] = await eslint.lintText(code, { filePath: filePath || probePath });
    return r ? r.messages : [];
  };
  const SAMPLES = {
    "no-dupe-keys": "const o = { a: 1, a: 2 };\nuse(o);",
    "no-unreachable": "function f() { return 1; use(); }\nuse(f);",
    "no-unsafe-finally": "function f() { try { return 1; } finally { return 2; } }\nuse(f);",
    "no-func-assign": "function f() {}\nf = 1;",
    "no-redeclare": "var a = 1;\nvar a = 2;\nuse(a);",
    "no-self-assign": "let a = 1;\na = a;",
    "no-dupe-else-if": "if (x) { use(1); } else if (x) { use(2); }",
    "no-const-assign": "const a = 1;\na = 2;",
    "valid-typeof": "if (typeof x === \"strnig\") use(x);",
    "use-isnan": "if (x === NaN) use(x);",
    "getter-return": "const o = { get v() { use(1); } };\nuse(o);",
    "no-dupe-class-members": "class A { m() {} m() {} }\nuse(A);",
  };
  const missed = [];
  for (const rule of EXPECTED_RULES) {
    const msgs = await lintProbe(SAMPLES[rule] || "");
    if (!msgs.some((m) => m.ruleId === rule && m.severity === 2)) missed.push(rule + " → " + JSON.stringify(msgs.map((m) => m.ruleId)));
  }
  ok(missed.length === 0 && Object.keys(SAMPLES).length === EXPECTED_RULES.length,
    `十二条规则各喂一段错代码，${EXPECTED_RULES.length - missed.length} 条都抓到了`, "没抓到：" + missed.join("；"));
  const quiet = await lintProbe("callSomethingNobodyDefined();\nvar   messy={'a':1,\"b\":2}\nif(messy){console.log( messy )}\n");
  ok(quiet.length === 0, "反向对照：用了没定义的名字、格式乱七八糟，都不报（这两类不归这道闸门）", JSON.stringify(quiet.map((m) => m.ruleId)));
  // 前端那一块配置只改了解析方式，规则得照样生效——同一个文件里顶层 var 写两遍，照抓
  const fe = await lintProbe("var sharedState = 0;\nfunction sharedHelper() { return 1; }\nvar sharedState = 1;\n",
    path.join(ROOT, "public/js/__probe__.js"));
  ok(fe.length === 1 && fe[0].ruleId === "no-redeclare", "前端文件同样有这十二条（同一个文件顶层 var 写两遍照抓）",
    JSON.stringify(fe.map((m) => m.ruleId)));
  const broken = splitResults(await eslint.lintText("function (", { filePath: probePath }));
  ok(broken.fatal.length === 1 && broken.violations.length === 0, "反向对照：语法错的文件单独归一堆（永远红，不进基线）");

  console.log("\n【3】基线比对的算术");
  const v = (file, rule, message, line) => ({ file, rule, message, line: line || 1, col: 1 });
  const A = v("a.js", "no-dupe-keys", "Duplicate key 'x'.");
  ok(diffBaseline([A], []).fresh.length === 1, "基线是空的，扫出一条 → 红");
  ok(diffBaseline([A], toBaseline([A])).fresh.length === 0, "基线里记着的那条 → 不红");
  ok(diffBaseline([{ ...A, line: 99 }], toBaseline([A])).fresh.length === 0, "只是行号挪了 → 还是那一条，不红");
  ok(diffBaseline([A, { ...A, line: 5 }], toBaseline([A])).fresh.length === 1, "同一个文件同一条规则多了一次 → 多出来那一次红");
  ok(diffBaseline([v("b.js", "no-dupe-keys", "Duplicate key 'x'.")], toBaseline([A])).fresh.length === 1,
    "别的文件出了同样的错 → 红（基线按文件记，不是按规则一刀切放行）");
  const fixed = diffBaseline([], toBaseline([A, A]));
  ok(fixed.fresh.length === 0 && fixed.stale.length === 1 && fixed.stale[0].count === 2, "基线里的已经修好了 → 不红，只提示去清");

  console.log("\n【4】全仓");
  let baseline = [];
  let baselineErr = "";
  try { baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")); } catch (e) { baselineErr = String(e && e.message || e); }
  ok(!baselineErr && Array.isArray(baseline), "test/lint-baseline.json 读得出来、是个数组", baselineErr);
  if (!Array.isArray(baseline)) baseline = [];

  const results = await eslint.lintFiles(["."]);
  const files = results.map((r) => rel(r.filePath));
  ok(files.length >= 150 && files.includes("server.js") && files.includes("public/js/app-01.js"),
    `真查了 ${files.length} 个文件（含 server.js、public/js/app-01.js）`, "少于 150 个：ignores 多半写宽了，零报错是假绿");
  const leaked = files.filter((f) => /^(workspace|projects|dist|build|node_modules)\//.test(f) || /^任务_/.test(f) || f.startsWith("public/vendor/"));
  ok(leaked.length === 0, "没查进用户数据和构建产物", leaked.slice(0, 5).join("、"));

  const { fatal, violations } = splitResults(results);
  ok(fatal.length === 0, "每个文件都解析得了", fatal.map(show).join("\n      "));

  if (process.argv.includes("--write-baseline")) {
    const next = toBaseline(violations);
    fs.writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
    console.log(`\n    已把 ${violations.length} 条违规（${next.length} 个键）写进 test/lint-baseline.json`);
    baseline = next;
  }
  const { fresh, stale } = diffBaseline(violations, baseline);
  ok(fresh.length === 0, `没有新增违规（共 ${violations.length} 条，基线里记着 ${baseline.reduce((a, b) => a + (Number(b.count) || 1), 0)} 条）`,
    fresh.slice(0, 40).map(show).join("\n      ") + (fresh.length > 40 ? "\n      …还有 " + (fresh.length - 40) + " 条" : "")
      + "\n      这些都是写出来的意思和实际跑的不一样，当场修；实在修不了才 node test/lint.js --write-baseline");
  if (stale.length) {
    console.log(`\n    基线里有 ${stale.reduce((a, b) => a + b.count, 0)} 条已经修好了：跑一遍 node test/lint.js --write-baseline 把它们清掉`);
    for (const s of stale.slice(0, 10)) console.log("      " + s.file + "  " + s.rule + " ×" + s.count);
  }
  console.log(`\n    用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().then(() => {
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
}, (e) => {
  console.log("✗ lint 闸门自己崩了：" + (e && e.stack || e));
  process.exit(1);
});
