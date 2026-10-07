// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 层级守护：代码按「谁依赖谁」分成 7 层，只许 require 同层或更低的层。
 *
 *   L6 入口   server.js cli.js electron-main.js server-host.js electron-builder.config.js eslint.config.js、eval/、scripts/ —— 随便 require
 *   L5 应用   src/server  src/cli  src/im  src/desktop —— 四块之间不许横向互引
 *   L4 智能体 src/agent  src/tools  src/engines
 *   L3 业务域 src/domains/…
 *   L2 核心   src/core/…
 *   L1 平台   src/platform（含 render）
 *   L0 工具   src/util
 *
 * 边从源码的 AST 里抠（espree，eslint 自带）：require、require.resolve、tryRequire、new Worker(…)、
 * x.fork(…)、require(rootPath(…))，以及代码里任何 path.join(__dirname, …"x.js") 和 appPath / rootPath(…"x.js")
 * （preload、Worker 文件、spawn 的脚本都是这么写的）。注释和字符串里的「require」不算。
 *
 * 判挂：
 *   ① 每条本地边都解析得到文件——tryRequire 吞错、Worker / preload 路径写错，require 图和打包闸门都看不见，
 *      搬家时最容易静悄悄坏的就是这些
 *   ② 每个代码文件都有层（新加一个文件不知道该放哪，这里就红）；老布局的 lib/ engines/ routes/ 不许再长出来
 *   ③ 白名单只减不增：同层的 lazy 环 3 个、「require 一个也会被 spawn 的脚本」2 条，条数写死；
 *      名单里的那一项已经不存在了也红——修好了就从名单里删掉
 *   ④ 层级违规（上行、L5 横向、非入口 require 入口、白名单外的环、白名单外的 require-spawn）：一条就挂。
 *      层按文件的真实路径算（目录重整已收尾，不再有「要搬去哪」的虚拟落位）
 *
 * 规则的人话版、每层放什么、新加 IM 渠道 / 工具 / 路由放哪：docs/代码架构.md
 * 不起进程、不碰数据目录，只读源码。
 *   node test/layers.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { execFileSync } = require("child_process");
const espree = require("espree");

// 取真实路径：require 解析出来的都是真实路径，仓库挂在软链底下时两边才对得上（对不上的话每条边都像「出了仓库」被跳过）
const REPO = fs.realpathSync(path.resolve(__dirname, ".."));
const posix = (p) => p.split(path.sep).join("/");

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};

// ── 层 ──────────────────────────────────────────────────────────────────────
const LAYERS = [
  { name: "L6 入口", rank: 6, dirs: ["server.js", "cli.js", "electron-main.js", "server-host.js", "electron-builder.config.js", "eslint.config.js", "eval/", "scripts/"] },
  { name: "L5 应用", rank: 5, dirs: ["src/server/", "src/cli/", "src/im/", "src/desktop/"], isolate: true },
  { name: "L4 智能体", rank: 4, dirs: ["src/agent/", "src/tools/", "src/engines/"] },
  { name: "L3 业务域", rank: 3, dirs: ["src/domains/"] },
  { name: "L2 核心", rank: 2, dirs: ["src/core/"] },
  { name: "L1 平台", rank: 1, dirs: ["src/platform/"] },
  { name: "L0 工具", rank: 0, dirs: ["src/util/"] },
];

/** 文件落在哪一层：按真实路径（仓库相对、posix 分隔）。不在任何一层的返回 null（② 会红） */
function layerOf(rel) {
  for (const L of LAYERS) for (const d of L.dirs) if (rel === d || (d.endsWith("/") && rel.startsWith(d))) return L;
  return null;
}
const appUnit = (rel) => { const m = /^src\/(server|cli|im|desktop)\//.exec(rel); return m ? m[1] : null; };

/** 一条边违不违规。返回违规种类，不违规返回 null */
function judge(fromRel, toRel) {
  const lf = layerOf(fromRel), lt = layerOf(toRel);
  if (!lf || !lt) return null; // 没有层的另算（②）
  if (lf.rank === 6) return null;
  if (lt.rank === 6) return "非入口 require 入口";
  if (lt.rank > lf.rank) return `上行 ${lf.name} → ${lt.name}`;
  if (lt.rank === lf.rank && lf.isolate && appUnit(fromRel) !== appUnit(toRel)) return `L5 横向 ${appUnit(fromRel)} → ${appUnit(toRel)}`;
  return null;
}

// ── 白名单（一期）：只减不增，条数在下面写死 ──────────────────────────────────
// 同层的 lazy 环：二期拆（license.gather 改注入 accounts；parseFrontmatter 抽到 util；workspace ALS 抽出 tools.js）
const CYCLE_ALLOW = [
  ["src/domains/account/account.js", "src/domains/account/license.js"],
  ["src/core/ext/plugins.js", "src/core/ext/skills.js"],
  ["src/agent/mcp.js", "src/agent/tools.js"],
];
// require 一个也会被 spawn 的脚本。原先 agent.js、bridge.js 为了借工具名单 require tool-bridge，
// 名单抽进 src/engines/lendable.js 之后一条都不剩；要加先想清楚那个脚本被 require 时顶层会干什么
const SPAWN_ALLOW = [];

// ── 抠边 ───────────────────────────────────────────────────────────────────
const REQ_KINDS = new Set(["require", "resolve", "tryRequire"]); // 模块依赖（算层、算环）
const PATH_KINDS = new Set(["worker", "fork", "pathref"]); // 按路径加载（Worker / 子进程 / preload）

/**
 * 从一段源码里抠出本地边：[{ kind, spec, base, line, lazy }]。
 * base："dir" 相对本文件目录（spec 以 ./ ../ 开头），"root" 相对仓库根（rootPath 写法）。
 * 不认识的（拼出来的、带变量的、包名）不算边。
 */
function edgesOf(code) {
  let ast;
  try { ast = espree.parse(code, { ecmaVersion: "latest", sourceType: "commonjs", loc: true }); }
  catch { ast = espree.parse(code, { ecmaVersion: "latest", sourceType: "module", loc: true }); }
  const consts = {}; // 模块顶层 const X = "./x" / path.join(__dirname, "x.js")
  const isDirname = (n) => n && n.type === "Identifier" && n.name === "__dirname";
  const strOf = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value
    : n && n.type === "TemplateLiteral" && n.expressions.length === 0 ? n.quasis[0].value.cooked : null);
  const isPathJoin = (n) => n && n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed
    && n.callee.object.type === "Identifier" && n.callee.object.name === "path" && ["join", "resolve"].includes(n.callee.property.name);
  // rootPath / appPath：相对仓库根（开发态 APP_DIR 就是仓库根）
  const ROOT_FNS = ["rootPath", "appPath"];
  const isRootPath = (n) => n && n.type === "CallExpression" && ((n.callee.type === "Identifier" && ROOT_FNS.includes(n.callee.name))
    || (n.callee.type === "MemberExpression" && !n.callee.computed && ROOT_FNS.includes(n.callee.property.name)));
  function target(n) {
    if (!n) return null;
    const s = strOf(n);
    if (s !== null) return /^\.\.?\//.test(s) ? { spec: s, base: "dir" } : null;
    if (n.type === "Identifier" && consts[n.name]) return consts[n.name];
    if (isPathJoin(n) && isDirname(n.arguments[0])) {
      const parts = n.arguments.slice(1).map(strOf);
      if (parts.length && parts.every((x) => x !== null)) return { spec: "./" + parts.join("/"), base: "dir" };
    }
    if (isRootPath(n)) {
      const parts = n.arguments.map(strOf);
      const spec = parts.every((x) => x !== null) ? parts.join("/") : "";
      if (spec && !/^node_modules\//.test(spec)) return { spec, base: "root" };
    }
    return null;
  }
  for (const st of ast.body) {
    if (st.type !== "VariableDeclaration") continue;
    for (const d of st.declarations) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      const t = target(d.init);
      if (t) consts[d.id.name] = t;
    }
  }
  const out = [];
  const kindOf = (n) => {
    const c = n.callee;
    if (n.type === "NewExpression") return c.type === "Identifier" && c.name === "Worker" ? "worker" : null;
    if (c.type === "Identifier" && c.name === "require") return "require";
    if (c.type === "Identifier" && /^tryRequire$|^tryReq|^optionalRequire$/.test(c.name)) return "tryRequire";
    if (c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier" && c.object.name === "require" && c.property.name === "resolve") return "resolve";
    if (c.type === "MemberExpression" && !c.computed && c.property.name === "fork") return "fork";
    return null;
  };
  const claimed = new Set(); // 已经当某个调用的第一个参数记过的节点，别再按 pathref 记一遍
  function walk(n, depth) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "CallExpression" || n.type === "NewExpression") {
      const kind = kindOf(n);
      if (kind && n.arguments[0]) {
        claimed.add(n.arguments[0]);
        const t = target(n.arguments[0]);
        if (t) out.push({ kind, ...t, line: n.loc.start.line, lazy: depth > 0 });
      }
      if (!claimed.has(n) && ((isPathJoin(n) && isDirname(n.arguments[0])) || isRootPath(n))) {
        const t = target(n);
        if (t && /\.js$/.test(t.spec)) out.push({ kind: "pathref", ...t, line: n.loc.start.line, lazy: depth > 0 });
      }
    }
    const d2 = depth + (/Function/.test(n.type) ? 1 : 0);
    for (const k of Object.keys(n)) {
      if (k === "loc" || k === "range") continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === "string") walk(x, d2); }
      else if (v && typeof v.type === "string") walk(v, d2);
    }
  }
  walk(ast, 0);
  return out;
}

/** 一条边落到哪个文件（绝对路径）；解析不到返回 null */
function resolveEdge(fromAbs, e) {
  const abs = e.base === "root" ? path.join(REPO, ...e.spec.split("/")) : path.resolve(path.dirname(fromAbs), e.spec);
  if (PATH_KINDS.has(e.kind)) return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
  try { return Module.createRequire(fromAbs).resolve(abs); } catch { return null; }
}

// ── 扫仓库 ─────────────────────────────────────────────────────────────────
const CODE_SKIP = /^(test|public|skills|docs|node_modules|dist|build|out)\//;
const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "*.js"], { cwd: REPO, encoding: "utf8" })
  .split("\n").filter((f) => f && !CODE_SKIP.test(f) && fs.existsSync(path.join(REPO, f)));
const codeFiles = [...new Set(listed)].sort();
const codeSet = new Set(codeFiles);
const layered = (rel) => codeSet.has(rel) || (rel.startsWith("src/") && layerOf(rel) !== null); // src/ 下被 require 的 json 也算进层

const parseErr = [], edges = [], unresolved = [];
for (const f of codeFiles) {
  const abs = path.join(REPO, f);
  let es;
  try { es = edgesOf(fs.readFileSync(abs, "utf8")); } catch (e) { parseErr.push(`${f}: ${e.message}`); continue; }
  for (const e of es) {
    const hit = resolveEdge(abs, e);
    if (!hit) { unresolved.push(`${f}:${e.line} ${e.kind}(${e.base === "root" ? "仓库根/" : ""}${e.spec})`); continue; }
    const to = posix(path.relative(REPO, hit));
    if (to.startsWith("..") || /(^|\/)node_modules\//.test(to)) continue;
    edges.push({ from: f, to, ...e });
  }
}

console.log("\n① 每条本地边都解析得到文件");
ok(parseErr.length === 0, `${codeFiles.length} 个代码文件都解析得过`, parseErr);
const byKind = {};
for (const e of edges) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
ok(unresolved.length === 0, `★${edges.length + unresolved.length} 条本地边全部解析到文件★（${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join("、")}）`, unresolved);
// 正向对照：每种写法都真抠到了——抠边坏了的话上面那条拿空清单也是绿的
const has = (pred) => edges.some(pred);
ok(codeFiles.length >= 180 && edges.length >= 600, `扫到的文件和边够数（${codeFiles.length} 个文件、${edges.length} 条边；少了说明扫描或抠边坏了）`);
ok(has((e) => e.kind === "tryRequire" && e.from === "src/domains/library/lib-cover.js"), "  └ 认得 tryRequire（lib-cover 的可选依赖）");
ok(has((e) => e.kind === "worker" && e.from === "src/platform/render/thumb.js" && e.to === "src/platform/render/thumb-worker.js"), "  └ 认得 new Worker(常量)（thumb.js → thumb-worker.js）");
ok(has((e) => e.kind === "fork" && e.from === "electron-main.js" && e.to === "server-host.js"), "  └ 认得 fork(path.join(__dirname, …))（electron-main → server-host）");
ok(has((e) => e.kind === "pathref" && e.to === "src/engines/tool-bridge.js") && has((e) => e.kind === "pathref" && e.to === "src/desktop/pet-preload.js"),
  "  └ 认得 spawn / preload 用的 path.join(__dirname, \"x.js\")（tool-bridge、pet-preload）");
ok(has((e) => e.kind === "resolve" && e.from === "src/agent/agent.js" && e.to === "src/domains/library/ws-browse.js"), "  └ 认得 require.resolve（agent.js 交给 Worker 的 ws-browse）");
ok(has((e) => e.kind === "require" && e.base === "root" && e.from === "src/domains/media/drama-pipeline.js" && /分镜表\.schema\.json$/.test(e.to)), "  └ 认得 require(rootPath(…))（drama-pipeline 的分镜表 schema）");
ok(has((e) => e.kind === "require" && e.lazy) && has((e) => e.kind === "require" && !e.lazy), "  └ 分得出模块顶层的和函数里（lazy）的 require");
{
  // 反向对照：抠边器和解析器自己——注释、拼出来的、包名不算边；写错的路径解析不到
  const probe = edgesOf('// require("./nope")\nconst a = require("fs");\nconst b = require("./x" + y);\nconst c = `require("./in-string")`;\nfunction f() { return require("./lazy"); }\nconst W = path.join(__dirname, "w.js");\nnew Worker(W);\nspawn(process.execPath, [appPath("eval", "r.js")]);\nappPath("node_modules/a/b.js");\n');
  const got = probe.map((e) => `${e.kind}:${e.spec}:${e.lazy ? "lazy" : "top"}`).join(",");
  ok(got === "require:./lazy:lazy,pathref:./w.js:top,worker:./w.js:top,pathref:eval/r.js:top",
    "反向对照：注释 / 字符串 / 拼接 / 包名 / node_modules 不算边；常量里的 Worker 路径、appPath 拼的脚本路径算", got);
  const from = path.join(REPO, "server.js");
  const bare = "./src/platform/paths";
  ok(resolveEdge(from, { kind: "require", spec: "./definitely-not-here", base: "dir" }) === null
    && resolveEdge(from, { kind: "require", spec: bare, base: "dir" }) !== null
    && resolveEdge(from, { kind: "pathref", spec: bare, base: "dir" }) === null
    && resolveEdge(from, { kind: "pathref", spec: bare + ".js", base: "dir" }) !== null,
    "反向对照：写错的路径解析不到；require 会补 .js，按路径加载的不补（Worker / spawn 不会替你补）");
}

console.log("\n② 每个代码文件都有层，老布局的目录没再长出来");
{
  const noLayer = codeFiles.filter((f) => !layerOf(f));
  ok(noLayer.length === 0, "★每个代码文件都落在某一层★（新文件不知道放哪：按上面的 7 层挑一个目录，见 docs/代码架构.md）", noLayer);
  // 目录重整前的三个源码目录已经搬空删掉。再建回来的话：打包白名单只认 src/**，闸门只核 src/，装机包里就少文件
  const oldDirs = ["lib", "engines", "routes"].filter((d) => fs.existsSync(path.join(REPO, d)));
  ok(oldDirs.length === 0, "老布局的 lib/ engines/ routes/ 都不在了（新代码放进 src/ 下对应的层）", oldDirs);
  ok(codeFiles.filter((f) => f.startsWith("src/")).length >= 150, `src/ 下扫到 ${codeFiles.filter((f) => f.startsWith("src/")).length} 个代码文件（少了说明扫描坏了）`);
  // 反向对照：层判得出来
  ok(layerOf("src/util/x.js").rank === 0 && layerOf("server.js").rank === 6 && layerOf("scripts/a.js").rank === 6
    && layerOf("lib-nope.js") === null && layerOf("lib/x.js") === null && layerOf("src/nope/x.js") === null,
    "反向对照：src/util 是 L0、入口和 scripts 是 L6；根目录下不在名单里的、老目录里的、src/ 下不认识的目录里的文件都没有层");
}

console.log("\n③ 白名单只减不增");
// 环：只看模块依赖（require / resolve / tryRequire），Worker、子进程不是同一个模块图
const adj = new Map();
for (const e of edges) if (REQ_KINDS.has(e.kind) && layered(e.from) && layered(e.to) && e.from !== e.to) {
  if (!adj.has(e.from)) adj.set(e.from, new Set());
  adj.get(e.from).add(e.to);
}
function sccs() {
  let idx = 0;
  const st = [], on = new Set(), I = new Map(), L = new Map(), out = [];
  const nodes = [...new Set([...adj.keys(), ...[...adj.values()].flatMap((s) => [...s])])].sort();
  const visit = (v) => {
    I.set(v, idx); L.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!I.has(w)) { visit(w); L.set(v, Math.min(L.get(v), L.get(w))); }
      else if (on.has(w)) L.set(v, Math.min(L.get(v), I.get(w)));
    }
    if (L.get(v) === I.get(v)) {
      const c = [];
      let w;
      do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1) out.push(c.sort());
    }
  };
  for (const v of nodes) if (!I.has(v)) visit(v);
  return out;
}
const cycles = sccs();
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const allowedCycle = (c) => CYCLE_ALLOW.some((w) => sameSet(w, c));
// 被按路径加载（Worker / fork / spawn / preload）的脚本，又被别人 require 的
const pathLoaded = new Set(edges.filter((e) => PATH_KINDS.has(e.kind)).map((e) => e.to));
const reqSpawn = edges.filter((e) => REQ_KINDS.has(e.kind) && pathLoaded.has(e.to) && layerOf(e.to) && layerOf(e.to).rank !== 6);
const reqSpawnPairs = [...new Set(reqSpawn.map((e) => `${e.from} → ${e.to}`))];
const allowedSpawn = (e) => SPAWN_ALLOW.some(([a, b]) => a === e.from && b === e.to);
ok(CYCLE_ALLOW.length <= 3 && SPAWN_ALLOW.length === 0, `白名单条数没涨（环 ${CYCLE_ALLOW.length} ≤ 3、require-spawn ${SPAWN_ALLOW.length} = 0）`);
// 名单里的环拆掉了才算过期；被一个更大的新环吞进去不算过期（那个大环在 ④ 里按白名单外的环列出来）
const staleCycles = CYCLE_ALLOW.filter((w) => !cycles.some((c) => w.every((x) => c.includes(x))));
ok(staleCycles.length === 0, `白名单里的 ${CYCLE_ALLOW.length} 个环都还在（拆掉了就从名单里删）`, staleCycles);
const staleSpawn = SPAWN_ALLOW.filter(([a, b]) => !reqSpawn.some((e) => e.from === a && e.to === b));
ok(staleSpawn.length === 0, `白名单里的 ${SPAWN_ALLOW.length} 条 require-spawn 都还在（拆掉了就从名单里删）`, staleSpawn);
console.log(`    环 ${cycles.length} 个：${cycles.map((c) => c.join(" ⇄ ")).join("；") || "无"}`);
console.log(`    require-spawn ${reqSpawnPairs.length} 条：${reqSpawnPairs.join("；") || "无"}`);
{
  // 反向对照：判层的规则自己
  const cases = [
    ["src/util/text-width.js", "src/agent/agent.js", /^上行/],
    ["src/cli/cli-args.js", "src/im/im.js", /^L5 横向/],
    ["src/core/config/prefs.js", "server.js", /^非入口/],
    ["src/agent/agent.js", "src/platform/paths.js", null],
    ["server.js", "src/agent/agent.js", null],
    ["src/server/relay.js", "src/server/routes/canvas.js", null],
  ];
  const bad = cases.filter(([a, b, want]) => { const v = judge(a, b); return want ? !(v && want.test(v)) : v !== null; });
  ok(bad.length === 0, "反向对照：util→agent 判上行、cli→im 判横向、core→server.js 判非入口，下行和入口随便引不判", bad.map(([a, b]) => `${a}→${b}: ${judge(a, b)}`));
}

console.log("\n④ 层级违规（一条就挂）");
const violations = [];
for (const e of edges) {
  if (!REQ_KINDS.has(e.kind) && e.kind !== "fork" && e.kind !== "worker" && e.kind !== "pathref") continue;
  if (!layered(e.from) || !layered(e.to)) continue;
  const v = judge(e.from, e.to);
  if (v) violations.push(`${v}：${e.from}:${e.line} → ${e.to}${e.lazy ? "（lazy）" : ""}`);
}
for (const c of cycles) if (!allowedCycle(c)) violations.push(`白名单外的环：${c.join(" ⇄ ")}`);
for (const e of reqSpawn) if (!allowedSpawn(e)) violations.push(`require 一个也会被 spawn 的脚本：${e.from}:${e.line} → ${e.to}`);
for (const v of violations) console.log("    · " + v);
ok(violations.length === 0, `★没有层级违规★（白名单内的环 ${cycles.filter(allowedCycle).length} 个、require-spawn ${reqSpawn.filter(allowedSpawn).length} 处）`, violations.length);

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
