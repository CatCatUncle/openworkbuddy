// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * worktree 隔离：两条任务同时改一个仓库时，后来的那条进自己的分身。
 *
 * 钉的是这么几件事——每一件都是"没有它这个功能就是骗人"的那种：
 *   1. **不撞不隔离**。一个人一条任务是绝大多数情况，凭空把人扔进陌生目录只会让他找不着文件。
 *   2. 隔离之后，**用户那份工作区一个字都不能动**。这是整个功能的全部意义。
 *   3. 用户手上**没提交的改动要带过去**。不带的话第二条任务看到的是回到上次 commit 的仓库，
 *      它会以为同事的活没干，把改好的地方再改一遍——比不隔离还糟。
 *   4. 收工时**有产出的要自动提交**。没提交的改动合不回来：用户照着提示敲 git merge
 *      会发现这分支跟自己一模一样，然后他得 cd 进一个从没听说过的目录。
 *   5. **白跑的分身要收掉、有活儿的一个都不许删**。删错的那次是不可逆的。
 *   6. 提示词里得**明说不许自己 merge**，不然它会很热心地帮你合掉。
 *
 * 全程用真 git：这个模块干的每件事都是 git 的行为，拿假的 spawn 测等于测我自己写的假货。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");
const { src } = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const { spawnSync } = require("child_process");
const wt = require(mod("worktree"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra != null ? "\n      " + String(extra).replace(/\n/g, "\n      ") : "")); }
}
const eq = (a, b, name) => ok(a === b, name, `实到 ${JSON.stringify(a)}，该是 ${JSON.stringify(b)}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-wt-"));
// 每节自己的存放处：sweep 是按"整个存放处"扫的，几节共用一个的话，上一节留下的分身会被算进这一节的账
const store = (n) => path.join(TMP, "store-" + n);
const git = (cwd, ...a) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const out = (cwd, ...a) => String(git(cwd, ...a).stdout || "").trim();

/** 造一个有一次提交的小仓库 */
function mkRepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "测试");
  fs.writeFileSync(path.join(dir, "a.txt"), "第一行\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "起个头");
  return dir;
}

// ── ① 认不认得出仓库 ───────────────────────────────────────────────────
console.log("\n① 这地方是不是个仓库");
{
  const repo = mkRepo("repo1");
  const notRepo = path.join(TMP, "普通文件夹");
  fs.mkdirSync(notRepo);
  ok(!!wt.repoOf(repo), "仓库认得出");
  eq(wt.repoOf(notRepo), null, "★不是仓库就返回 null★ 后面全靠它决定要不要隔离");
  eq(wt.repoOf(path.join(TMP, "根本不存在")), null, "目录不存在也不炸，返回 null");
  eq(wt.repoOf(""), null, "空串返回 null");
  // 子目录问出来的还是同一个仓库——用户的工作目录多半指在 src/ 上，不是仓库根
  const sub = path.join(repo, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  eq(wt.repoOf(sub).key, wt.repoOf(repo).key, "★仓库子目录算同一个仓库★ 工作目录指在 src/ 上是常态");
}

// ── ② 撞不撞车 ─────────────────────────────────────────────────────────
console.log("\n② 撞不撞车（不撞就不隔离）");
{
  const repo = mkRepo("repo2");
  const other = mkRepo("repo3");
  eq(wt.plan(repo, { session: "s1", busy: [] }).need, false, "★就我一条任务 → 不隔离★ 凭空换个目录只会让人找不着文件");
  eq(wt.plan(repo, { session: "s1", busy: [{ session: "s1", dir: repo }] }).need, false, "名单里那条就是我自己 → 不隔离");
  eq(wt.plan(repo, { session: "s1", busy: [{ session: "s2", dir: other }] }).need, false, "★别人在改的是另一个仓库 → 不隔离★");
  eq(wt.plan(repo, { session: "s1", busy: [{ session: "s2", dir: repo }] }).need, true, "★同一个仓库里已经有别人 → 隔离★");
  const subBusy = path.join(repo, "src");
  fs.mkdirSync(subBusy, { recursive: true });
  eq(wt.plan(repo, { session: "s1", busy: [{ session: "s2", dir: subBusy }] }).need, true, "别人在这仓库的子目录里改，一样算撞上");
  const plain = path.join(TMP, "非仓库");
  fs.mkdirSync(plain);
  eq(wt.plan(plain, { session: "s1", busy: [{ session: "s2", dir: plain }] }).need, false,
    "★不是 git 仓库就不隔离★ 成果目录那套本来就够用，而且非仓库根本开不出 worktree");
}

// ── ③ 开一个分身：用户的工作区一个字都不许动 ───────────────────────────
console.log("\n③ 开分身");
let REPO = "", WT = null;
{
  REPO = mkRepo("repo4");
  // 用户手上还没提交的：改了一个、新建一个、还有一个被 ignore 的
  fs.writeFileSync(path.join(REPO, "a.txt"), "第一行\n用户刚改的\n");
  fs.writeFileSync(path.join(REPO, "草稿.md"), "还没 add\n");
  fs.mkdirSync(path.join(REPO, "build"));
  fs.writeFileSync(path.join(REPO, "build", "垃圾.bin"), "x".repeat(4096));
  const p = wt.plan(REPO, { session: "sess_A", busy: [{ session: "sess_B", dir: REPO }] });
  WT = wt.open(store("A"), { repo: p.repo, session: "sess_A" });
  ok(WT && WT.dir && !WT.error, "分身开出来了", WT && WT.error);
  eq(WT.branch, "owb/sess_A", "★分支名带 owb/ 前缀★ 用户在 git branch 里一眼认得出这是谁开的");
  ok(!path.resolve(WT.dir).startsWith(path.resolve(REPO) + path.sep), "★分身不在仓库里面★ 放里面 git 会看见它，清理时还容易删到人家代码");
  eq(fs.readFileSync(path.join(WT.dir, "a.txt"), "utf8"), "第一行\n用户刚改的\n", "★没提交的改动带过去了★ 不带的话它会把改好的地方再改一遍");
  ok(fs.existsSync(path.join(WT.dir, "草稿.md")), "★没跟踪的新文件也带过去了★");
  ok(!fs.existsSync(path.join(WT.dir, "build", "垃圾.bin")), "★被 ignore 的不带★ 拷一个 800MB 的 build/ 过去比不带更糟");
  eq(wt.repoOf(WT.dir).key, wt.repoOf(REPO).key, "★分身跟主仓库算同一个仓库★ 第三条任务才知道自己也得开一个");
  eq(wt.markOf(WT.dir).branch, "owb/sess_A", "markOf 不起 git 进程也认得出这是分身（每轮提示词都要问一次）");
  eq(wt.markOf(REPO), null, "普通目录 markOf 是 null");
}

// ── ④ 干活：改的是分身，用户的工作区纹丝不动 ───────────────────────────
console.log("\n④ 干活");
{
  fs.writeFileSync(path.join(WT.dir, "a.txt"), "第一行\n用户刚改的\nagent 加的\n");
  fs.writeFileSync(path.join(WT.dir, "新产出.md"), "agent 写的\n");
  eq(fs.readFileSync(path.join(REPO, "a.txt"), "utf8"), "第一行\n用户刚改的\n",
    "★用户的工作区一个字没动★ 这是整个功能的全部意义");
  ok(!fs.existsSync(path.join(REPO, "新产出.md")), "agent 新建的文件也没落到用户工作区里");
  const st = wt.status(WT.dir);
  eq(st.empty, false, "干了活就不是白跑");
  ok(st.touched >= 2, "touched 数得出这根分支比 HEAD 多了几个文件", st.touched);
}

// ── ⑤ 收工：有产出的自动提交，白跑的就地收掉 ───────────────────────────
console.log("\n⑤ 收工");
{
  const rel = wt.release(store("A"), WT.dir, { title: "给 a.txt 加一行" });
  eq(rel.removed, false, "有产出 → 留着");
  eq(rel.commits, 1, "★自动提交了一笔★ 没提交的改动是合不回来的");
  ok(out(REPO, "log", "--oneline", "owb/sess_A").includes("给 a.txt 加一行"), "提交信息里带着任务标题",
    out(REPO, "log", "--oneline", "owb/sess_A"));
  ok(out(REPO, "diff", "--stat", "HEAD...owb/sess_A").includes("a.txt"), "★主仓库这边 diff 看得见★ 提示里给的就是这条命令");
  const h = wt.hint(rel);
  ok(h.includes("git -C") && h.includes("merge owb/sess_A"), "★提示里把合回去的命令给全了★ 不然用户得自己去查 git 手册", h);
  eq(out(REPO, "rev-parse", "--abbrev-ref", "HEAD"), "main", "用户还在 main 上，分支没被切走");
  eq(fs.readFileSync(path.join(REPO, "a.txt"), "utf8"), "第一行\n用户刚改的\n", "收工之后用户工作区还是一个字没动");
}

// ── ⑥ 白跑的那趟 ───────────────────────────────────────────────────────
console.log("\n⑥ 白跑的那趟：分身一出生就是脏的，不能算成有产出");
{
  const repo = mkRepo("repo5");
  fs.writeFileSync(path.join(repo, "a.txt"), "第一行\n用户改了但没提交\n");
  const p = wt.plan(repo, { session: "sX", busy: [{ session: "sY", dir: repo }] });
  const o = wt.open(store("6"), { repo: p.repo, session: "sX" });
  const st = wt.status(o.dir);
  eq(st.dirty, true, "反向对照：带过来的改动确实让它看起来是脏的");
  eq(st.empty, true, "★可 agent 一个字没写 → 算白跑★ 不这么判，每撞一次车就多留一根删不掉的分支");
  const rel = wt.release(store("6"), o.dir);
  eq(rel.removed, true, "白跑的就地收掉");
  ok(!fs.existsSync(o.dir), "目录没了");
  eq(out(repo, "branch", "--list", "owb/sX"), "", "★空分支也不留★");
  eq(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "第一行\n用户改了但没提交\n", "收掉分身没碰用户那份改动");
}

// ── ⑦ 删不删：有活儿的一个都不许删 ─────────────────────────────────────
console.log("\n⑦ 删不删");
{
  const repo = mkRepo("repo6");
  const p = wt.plan(repo, { session: "sK", busy: [{ session: "sJ", dir: repo }] });
  const S = store("7");
  const o = wt.open(S, { repo: p.repo, session: "sK" });
  fs.writeFileSync(path.join(o.dir, "干了活.txt"), "别删我\n");
  const no = wt.close(S, o.dir);
  eq(no.ok, false, "★有没合回去的改动 → 拒绝删★ 删错这一次是不可逆的");
  ok(fs.existsSync(o.dir), "拒绝之后东西还在");
  eq(wt.sweep(S, { alive: [], days: 0 }).length, 0, "★定期打扫也不碰它★ 没提交的改动 git 里一份都没有");
  wt.release(S, o.dir, { title: "干了活" });
  const swept = wt.sweep(S, { alive: [], days: 0 });
  ok(swept.length === 1 && swept[0].kept_branch === true, "提交过之后：放久了只删目录、**留分支**——腾的是磁盘不是成果", JSON.stringify(swept));
  eq(out(repo, "branch", "--list", "owb/sK"), "owb/sK", "★分支还在，什么时候想合都合得回来★");
  ok(!fs.existsSync(o.dir), "目录腾出来了");
  // 还在跑的一律不碰
  const o2 = wt.open(S, { repo: p.repo, session: "sLive" });
  eq(wt.sweep(S, { alive: [o2.dir], days: 0 }).length, 0, "★正在跑的那个一个都不碰★");
  ok(fs.existsSync(o2.dir), "它还在");
  wt.close(S, o2.dir, { force: true });
}

// ── ⑧ 开不出来的那些情况：一律退回老样子，绝不让任务起不来 ─────────────
console.log("\n⑧ 开不出来的时候");
{
  const fresh = path.join(TMP, "还没提交过");
  fs.mkdirSync(fresh);
  git(fresh, "init", "-q", "-b", "main");
  const p = wt.plan(fresh, { session: "s1", busy: [{ session: "s2", dir: fresh }] });
  eq(p.need, true, "反向对照：它确实是个仓库，也确实撞上了");
  const o = wt.open(store("8"), { repo: p.repo, session: "s1" });
  ok(o && o.error && /第一次提交/.test(o.error), "★一次提交都没有的仓库：说清楚为什么，不抛★", JSON.stringify(o));
  const repo = mkRepo("repo7");
  const inside = wt.open(path.join(repo, "分身放这儿"), { repo: wt.repoOf(repo), session: "s1" });
  ok(inside && inside.error, "★分身目录在仓库里面 → 拒绝★ 放里面 git 会看见它，清理时一手滑就删到人家代码", JSON.stringify(inside));
  eq(wt.open(store("8"), { repo: null, session: "s1" }).error, "不是 git 仓库", "没仓库就说没仓库");
}

// ── ⑨ 同一条会话再来，接着用上次那个 ───────────────────────────────────
console.log("\n⑨ 同一条会话第二轮");
{
  const repo = mkRepo("repo8");
  const p = wt.plan(repo, { session: "sR", busy: [{ session: "sO", dir: repo }] });
  const S = store("9");
  const a = wt.open(S, { repo: p.repo, session: "sR" });
  fs.writeFileSync(path.join(a.dir, "上一轮.txt"), "还没写完\n");
  const b = wt.open(S, { repo: p.repo, session: "sR" });
  eq(b.dir, a.dir, "★同一条会话第二轮：还是上次那个分身★ 换一个的话改到一半的东西就丢了");
  eq(b.reused, true, "而且明说是接着用的");
  ok(fs.existsSync(path.join(b.dir, "上一轮.txt")), "上一轮写的东西还在");
  wt.close(S, a.dir, { force: true });
}

// ── ⑩ 接线：服务端和命令行真的挂上了 ───────────────────────────────────
console.log("\n⑩ 接线");
{
  const srv = src("server");
  ok(/await worktree\.planAsync\(getWorkspaceDir\(\)/.test(srv), "★服务端按当前工作目录判要不要隔离（异步那一版，不卡窗口线程）★");
  ok(!/worktree\.plan\(getWorkspaceDir\(\)/.test(srv), "★服务端不许退回同步 plan★ 每轮卡整个应用约 90ms");
  // root 必须在 await 之前先登上：await 那几十毫秒里进来的下一条要看得见这一条
  const rootFirst = (s) => {
    const at = s.indexOf("await worktree.planAsync(");
    return at > 0 && /runState\.root = getWorkspaceDir\(\);/.test(s.slice(Math.max(0, at - 400), at));
  };
  ok(rootFirst(srv), "★await 之前先把自己的 root 登上★ 不然两条同时进来会一起改用户那份工作区");
  ok(!rootFirst("const busy = [];\n    const p = await worktree.planAsync(getWorkspaceDir(), {});\n  runState.root = getWorkspaceDir();"),
    "反向对照：root 只在 await 之后才登（改之前那种写法）会被认出来");
  ok(/enterWorkspace\(opened\.dir\)/.test(srv), "★判出来要隔离就真的换了工作目录★ 少这行整套就是个空壳");
  ok(/cliLive\.list\(\{ prune: false \}\)[\s\S]{0,200}busy\.push/.test(srv),
    "★撞车名单把终端里那趟也算上★ 网页一条 + 终端一条是最常见的撞法，而它俩是两个进程");
  ok(/worktree\.release\(worktreeStore\(\)/.test(srv), "收工要收尾");
  ok(/\[worktreeStore\(\), WORKTREE_LEGACY\][\s\S]{0,80}worktree\.sweep\(/.test(srv), "开机扫一遍没人管的分身（挪走之前的老位置也扫）");
  // 2026-09-29：默认位置落在应用仓库里，open() 一律拦。三处都得走 defaultStore，漏一处那一处就还是坏的
  ok(/worktree\.open\(worktreeStore\(\)/.test(srv) && !/worktree\.(open|release|sweep)\(dataPath\(/.test(srv),
    "★服务端开分身用的是挪过的默认位置★ 直接拿 dataPath 那个，开发态下一个分身都开不出来");
  ok(/worktreeStore = \(\) => [^\n]*worktree\.defaultStore\(WORKTREE_LEGACY\)/.test(srv), "worktreeStore 真的过了 defaultStore");
  // 2026-09-29 复审：挪位置之前开着的分身，两处都得把老地方告诉 open()，漏一处那一处就另开 -2（见 ⑭）
  const legacyRe = /worktree\.open\(worktreeStore\(\), \{[^}]*legacy: \[WORKTREE_LEGACY\]/;
  ok(legacyRe.test(srv), "★服务端开分身时把挪走之前的老地方也交给 open()★");
  ok(!legacyRe.test("const opened = worktree.open(worktreeStore(), { repo: p.repo, session: sessionId });"), "反向对照：改之前那句（没带 legacy）认得出来");
  ok(!/worktree\.open\(worktreeStore\(\)/.test('const opened = worktree.open(WORKTREE_DIR, { repo: p.repo, session: sessionId });'),
    "反向对照：改之前那句直接拿 WORKTREE_DIR 的写法认得出来");
  const cli = fs.readFileSync(entry("cli"), "utf8");
  ok(/withWorkspace\(opened\.dir, \(\) => runOnceIn\(/.test(cli),
    "★命令行用 withWorkspace 包住这一趟★ 交互模式下 enterWith 会把工作目录留给 REPL，之后 /cwd 显示的就是分身目录");
  ok(/sub === "worktree"/.test(cli), "openworkbuddy worktree 这条子命令在");
  ok(/STORE = wt\.defaultStore\(dataPath\("data", "worktrees"\)\)/.test(cli) && /wt\.defaultStore\(LEGACY\)/.test(cli)
    && !/const STORE = dataPath\("data", "worktrees"\)/.test(cli),
    "★命令行开分身、列分身也走挪过的默认位置★ 终端里撞车跟网页上是同一个坑");
  ok(/wt\.open\(STORE, \{[^}]*legacy: \[dataPath\("data", "worktrees"\)\]/.test(cli), "★命令行开分身也把挪走之前的老地方交给 open()★");
  const ag = fs.readFileSync(mod("agent"), "utf8");
  ok(/worktreeLine\(\)/.test(ag) && /不要自己 merge\/rebase 回主分支/.test(ag),
    "★提示词里明说不许自己 merge★ 不说这句它会很热心地帮你合掉，而冲突怎么取舍是它最没资格拍板的事");
  const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "命令行用法.md"), "utf8");
  ok(doc.includes("openworkbuddy worktree"), "命令行文档里有这条（少一行这条命令对外就等于不存在）");
}

// ── ⑪ 换工作目录这件事本身：只染当前这条异步链 ─────────────────────────
// 服务端是靠 enterWorkspace（AsyncLocalStorage.enterWith）把后面三百行的工作目录换掉的。
// 它要是会串到别的请求上，那就是把 A 的活儿写进 B 的仓库——比不隔离严重得多
console.log("\n⑪ 换工作目录只染自己这条链");
(async () => {
  const { withWorkspace, enterWorkspace, getWorkspaceDir } = require(mod("tools"));
  const A = path.join(TMP, "链A"), B = path.join(TMP, "链B");
  fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true });
  const seen = {};
  const chain = (name, dir) => withWorkspace(dir, async () => {
    enterWorkspace(dir + "-分身");
    await new Promise((r) => setTimeout(r, 5));
    seen[name] = getWorkspaceDir();
  });
  const before = getWorkspaceDir();
  await Promise.all([chain("a", A), chain("b", B)]);
  eq(seen.a, A + "-分身", "★换完之后，await 那边看到的是分身★ 少了这条，整套隔离就是个摆设");
  eq(seen.b, B + "-分身", "★另一条链是另一个分身★ 两条请求同时进来不会串");
  eq(getWorkspaceDir(), before, "★出了那条链，工作目录还是原来那个★ 串出去就是把 A 的活儿写进 B 的仓库");
  // 服务端现在是先 await 问 git、再 enterWorkspace：换目录发生在 await 之后，照样只能染自己这条
  const seen2 = {};
  const late = (name, dir) => withWorkspace(dir, async () => {
    await new Promise((r) => setTimeout(r, 3)); // 等 planAsync 回话的那一下
    enterWorkspace(dir + "-分身");
    await new Promise((r) => setTimeout(r, 5));
    seen2[name] = getWorkspaceDir();
  });
  const watch = withWorkspace(A, async () => {
    for (let i = 0; i < 8; i++) { await new Promise((r) => setTimeout(r, 1)); if (getWorkspaceDir() !== A) seen2.leak = getWorkspaceDir(); }
  });
  await Promise.all([late("a", A), late("b", B), watch]);
  eq(seen2.a, A + "-分身", "★await 之后再换目录，后面看到的也是分身★");
  eq(seen2.b, B + "-分身", "另一条链 await 之后换的是它自己的");
  eq(seen2.leak, undefined, "★同时在跑的第三条链一次都没被染到★");
  eq(getWorkspaceDir(), before, "出了链还是原来那个");

  // ── ⑫ 每轮开头那一问：异步、按目录记 60 秒 ─────────────────────────────
  console.log("\n⑫ 每轮开头那一问不卡窗口线程");
  const cp = require("child_process");
  const realExec = cp.execFile;
  let execN = 0;
  cp.execFile = function (...a) { if (a[0] === "git") execN++; return realExec.apply(this, a); };
  const I = wt._internals;
  try {
    const r1 = mkRepo("repo-a1"), r2 = mkRepo("repo-a2");
    const sub = path.join(r1, "src"); fs.mkdirSync(sub, { recursive: true });
    const plain = path.join(TMP, "异步非仓库"); fs.mkdirSync(plain);
    const cases = [
      [r1, { session: "s1", busy: [] }],
      [r1, { session: "s1", busy: [{ session: "s1", dir: r1 }] }],
      [r1, { session: "s1", busy: [{ session: "s2", dir: r2 }] }],
      [r1, { session: "s1", busy: [{ session: "s2", dir: r1 }, { session: "s3", dir: r2 }, { session: "s4", dir: sub }] }],
      [plain, { session: "s1", busy: [{ session: "s2", dir: plain }] }],
      [path.join(TMP, "根本不存在-异步"), { session: "s1", busy: [] }],
      [r1, { session: "s1", busy: [{ session: "s2", dir: path.join(TMP, "也不存在") }, { session: "s3", dir: "" }, null] }],
    ];
    let same = 0; const diff = [];
    for (const [d, o] of cases) {
      const a = JSON.stringify(wt.plan(d, o)), b = JSON.stringify(await wt.planAsync(d, o));
      if (a === b) same++; else diff.push(a + "\n≠ " + b);
    }
    eq(same, cases.length, "★异步版每种情况跟同步 plan 答得一字不差★", diff.join("\n"));
    ok(cases.some(([d, o]) => wt.plan(d, o).need) && cases.some(([d, o]) => !wt.plan(d, o).need),
      "反向对照：这组情况里要隔离、不要隔离的都有，不是全挑同一种答案的来比");

    const gOk = await I.gitAsync(r1, ["rev-parse", "--show-toplevel"]);
    const gBad = await I.gitAsync(plain, ["rev-parse", "--show-toplevel"]);
    eq(gOk.status, 0, "gitAsync 成功时 status 是 0，跟 spawnSync 一个样");
    ok(gBad.status !== 0 && typeof gBad.status === "number", "★git 报错时 status 非 0★ 不然 out() 会把报错那次的输出当真", JSON.stringify(gBad));

    I.repoCache.clear(); execN = 0;
    await wt.planAsync(r2, { session: "s1", busy: [] });
    eq(execN, 3, "★冷的时候走 execFile 问 3 下★（不占窗口线程）");
    execN = 0; wt.plan(r2, { session: "s1", busy: [] });
    eq(execN, 0, "反向对照：同步 plan 一次 execFile 都不走（它走的是 spawnSync）");
    ok(!/\brepoOf\(|[^.\w]git\(/.test(wt.planAsync.toString() + I.repoOfCached.toString() + wt.repoOfAsync.toString()),
      "★异步那条路上一个同步 git 调用都没有★");
    ok(/\brepoOf\(/.test(wt.plan.toString()), "反向对照：同一个检查对同步 plan 是命中的");

    execN = 0;
    for (let i = 0; i < 5; i++) await wt.planAsync(r2, { session: "s1", busy: [{ session: "s2", dir: r2 }] });
    eq(execN, 0, "★60 秒内同一个目录再问：一个 git 进程都不起★ 每轮都起三次就是每轮卡一下");
    I.repoCache.get(path.resolve(r2)).at -= I.REPO_TTL + 1;
    execN = 0; await wt.planAsync(r2, { session: "s1", busy: [] });
    eq(execN, 3, "反向对照：过了 60 秒就重新问（仓库被挪走、换了的话一分钟内认得出）");

    I.repoCache.clear(); execN = 0;
    const many = await Promise.all([1, 2, 3, 4].map(() => wt.planAsync(r1, { session: "s1", busy: [] })));
    eq(execN, 3, "★四条同时进来只问一遍★ 并发的共用同一个 Promise");
    ok(many.every((p) => p.repo && p.repo.key === many[0].repo.key), "四条拿到的是同一个仓库");

    // 不是仓库不记：用户 git init 完，下一轮就得认出来
    const late2 = path.join(TMP, "等会儿才init"); fs.mkdirSync(late2);
    eq((await wt.planAsync(late2, {})).repo, undefined, "反向对照：init 之前它确实不是仓库");
    git(late2, "init", "-q", "-b", "main");
    ok(!!(await wt.planAsync(late2, {})).repo, "★「不是仓库」不记账★ git init 完下一轮当场认得出，不用等一分钟");

    // 目录没了就不算：分身收掉之后那条路径不该还被当成仓库
    const gone = mkRepo("repo-gone");
    ok(!!(await I.repoOfCached(gone)), "反向对照：删之前认得出、而且记进了缓存");
    ok(I.repoCache.has(path.resolve(gone)), "（缓存里确实有它）");
    fs.rmSync(gone, { recursive: true, force: true });
    eq(await I.repoOfCached(gone), null, "★目录删了，缓存里有也不认★ 目录在不在每次现查");

    // 交出去的是拷贝：调用方改了它，下一轮拿到的还是对的
    const pa = await wt.planAsync(r1, {});
    const realKey = pa.repo.key;
    pa.repo.key = "被人改坏了";
    eq((await wt.planAsync(r1, {})).repo.key, realKey, "★调用方改了返回值，串不到下一轮★ 缓存里那份是共用的");
  } finally { cp.execFile = realExec; }

  // ── ⑬ 「分身目录在仓库里面，不能这么放」：日常用法里是怎么撞上的 ─────────
  // 2026-09-29 查到的真实路径：开发态数据根 = 应用仓库。默认工作空间 <仓库>/workspace 被 .gitignore 挡着，
  // git 照样答「在工作区里」→ 两条对话一起跑就被判成撞车 → open(<仓库>/data/worktrees) → 护栏拦下。
  // 另一条：用户拿它改应用自己的源码（工作目录 = 应用仓库），默认分身位置天生在仓库里，一个都开不出来。
  console.log("\n⑬ 默认位置本身得过得了护栏");
  {
    const app = mkRepo("app仓库");
    fs.writeFileSync(path.join(app, ".gitignore"), "workspace/\ndata/\n");
    git(app, "add", "-A"); git(app, "commit", "-qm", "挡住数据目录");
    const wsRoot = path.join(app, "workspace"), task = path.join(wsRoot, "任务_0929_甲");
    fs.mkdirSync(task, { recursive: true });
    const legacy = path.join(app, "data", "worktrees");
    const home = path.join(TMP, "假家目录");

    eq(out(wsRoot, "rev-parse", "--is-inside-work-tree"), "true", "反向对照：git 对被挡掉的工作空间确实答「在工作区里」（撞车误判就是从这来的）");
    eq(wt.repoOf(wsRoot), null, "★被 .gitignore 挡掉的工作空间不算仓库★");
    eq(wt.repoOf(task), null, "被挡掉的目录底下的任务文件夹也不算");
    eq(await wt.repoOfAsync(task), null, "异步那一版答得一样");
    ok(!!wt.repoOf(app), "（仓库根照样认得出）");
    fs.mkdirSync(path.join(app, "src"), { recursive: true });
    ok(!!wt.repoOf(path.join(app, "src")), "反向对照：没被挡的子目录照样算这个仓库");
    const two = { session: "s2", busy: [{ session: "s1", dir: wsRoot }] };
    eq(wt.plan(wsRoot, two).need, false, "★两条对话同在默认工作空间：不再判成撞车★ 以前这里每回都去开分身、每回都被拦");
    eq((await wt.planAsync(wsRoot, two)).need, false, "异步那一版也不判撞车");

    // 用户拿它改应用自己的源码：真撞车，默认位置得开得出来
    const hit = wt.plan(app, { session: "s2", busy: [{ session: "s1", dir: app }] });
    eq(hit.need, true, "反向对照：工作目录就是应用仓库、两条一起改，确实要隔离");
    const old = wt.open(legacy, { repo: hit.repo, session: "s2" });
    eq(old && old.error, "分身目录在仓库里面，不能这么放", "反向对照：原来那个默认位置（仓库/data/worktrees）确实被护栏拦下");
    const S = wt.defaultStore(legacy, { home });
    ok(S.startsWith(path.join(home, ".openworkbuddy", "worktrees") + path.sep), "★默认位置在仓库里 → 挪到家目录下★", S);
    const o = wt.open(S, { repo: hit.repo, session: "s2" });
    ok(o && o.dir && fs.existsSync(path.join(o.dir, "a.txt")), "★挪过之后分身真开得出来★", JSON.stringify(o));
    ok(o && o.dir && !fs.realpathSync(o.dir).startsWith(fs.realpathSync(app) + path.sep), "开出来的分身不在应用仓库里");
    eq(wt.list(S).length, 1, "列得出来（命令行 openworkbuddy worktree 靠它）");
    if (o && o.dir) wt.close(S, o.dir, { force: true });

    const plainData = path.join(TMP, "装机态数据根", "data", "worktrees");
    eq(wt.defaultStore(plainData, { home }), path.resolve(plainData), "反向对照：数据根不在仓库里（装机态、测试）就原地不动");
    eq(wt.defaultStore(legacy, { home: path.join(app, "家") }), path.resolve(legacy),
      "★家目录也在同一个仓库里：没有干净地方可放，原样交回★ 让 open() 如实拦，不硬塞");
    const S2 = wt.defaultStore(path.join(TMP, "另一份实例", "data", "worktrees"), { home });
    eq(S2, path.resolve(path.join(TMP, "另一份实例", "data", "worktrees")), "（不在仓库里的不挪）");
    const otherApp = mkRepo("另一份app");
    const S3 = wt.defaultStore(path.join(otherApp, "data", "worktrees"), { home });
    ok(S3 !== S && path.dirname(S3) === path.dirname(S), "★两份实例各占一格★ 不串到同一个目录里", S3 + " vs " + S);
    const bad = wt.open(path.join(app, "我偏要放这"), { repo: hit.repo, session: "s3" });
    eq(bad && bad.error, "分身目录在仓库里面，不能这么放", "★显式传进来的坏位置，护栏照拦★");
  }

  // ── ⑭ 挪位置之前老地方开着的分身：同一条对话接着用 ─────────────────
  // 2026-09-29 复审：defaultStore 挪到家目录以后，老地方（<应用>/data/worktrees）里别的仓库的分身还开着、
  // 分支 owb/<会话> 还挂着。open() 只看新地方，同一条对话再来就另开 owb/<会话>-2，上次改到一半的东西没人接
  console.log("\n⑭ 挪位置之前开着的分身接着用");
  {
    const app = mkRepo("app仓库2");
    fs.writeFileSync(path.join(app, ".gitignore"), "data/\n");
    git(app, "add", "-A"); git(app, "commit", "-qm", "挡住数据目录");
    const legacy = path.join(app, "data", "worktrees");
    const home = path.join(TMP, "假家目录2");
    const user = mkRepo("用户项目14");
    const hit = wt.plan(user, { session: "s14", busy: [{ session: "s13", dir: user }] });
    eq(hit.need, true, "（用户项目里两条对话撞车，要隔离）");
    // 挪之前：老版本就开在 <应用>/data/worktrees 底下（用户项目不在应用仓库里，护栏放行）
    const before = wt.open(legacy, { repo: hit.repo, session: "s14" });
    ok(before && before.dir && before.dir.startsWith(path.resolve(legacy) + path.sep), "老版本在老地方开出了分身", JSON.stringify(before));
    fs.writeFileSync(path.join(before.dir, "改到一半.txt"), "上次的活\n");

    const S = wt.defaultStore(legacy, { home });
    ok(S !== path.resolve(legacy), "升级以后默认位置挪走了", S);
    const again = wt.open(S, { repo: hit.repo, session: "s14", legacy: [legacy] });
    ok(again && again.reused && again.dir === before.dir, "★同一条对话再来：接着用老地方那个分身★", JSON.stringify(again));
    eq(again && again.branch, before.branch, "  └ 还是原来那根分支");
    ok(again && again.dir && fs.existsSync(path.join(again.dir, "改到一半.txt")), "  └ 上次改到一半的东西都在");
    eq(wt.list(S).length, 0, "  └ 新地方没多开一个");

    const fresh = wt.open(S, { repo: hit.repo, session: "s14" });
    ok(fresh && fresh.dir && fresh.dir !== before.dir && fresh.branch === before.branch + "-2" && !fs.existsSync(path.join(fresh.dir, "改到一半.txt")),
      "★反向对照★ 不告诉它老地方（改之前）：另开一个 -2 分支，上次的改动看不见", JSON.stringify(fresh && { dir: fresh.dir, branch: fresh.branch }));
    if (fresh && fresh.dir) wt.close(S, fresh.dir, { force: true });

    // 老地方落在这个仓库自己里面的，不认：跟「分身目录在仓库里面」同一条护栏
    const appHit = wt.plan(app, { session: "s15", busy: [{ session: "s16", dir: app }] });
    const planted = path.join(legacy, appHit.repo.key, wt._internals.safeName("s15"));
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    git(app, "worktree", "add", "-q", "-b", "手放的", planted);
    const Module = require("module");
    const WT = mod("worktree");
    const wsrc = fs.readFileSync(WT, "utf8");
    const guardLine = ".filter((l) => l && !inRepo(l))";
    ok(wsrc.includes(guardLine), "（反向对照要换的那句还在源码里）");
    const m = new Module(WT, module);
    m.filename = WT;
    m.paths = Module._nodeModulePaths(path.dirname(WT));
    m._compile(wsrc.replace(guardLine, ".filter((l) => l)"), WT);
    const loose = m.exports.open(S, { repo: appHit.repo, session: "s15", legacy: [legacy], seed: false });
    eq(loose && loose.dir, planted, "★反向对照★ 不看老地方在不在仓库里：仓库里那个手放的目录被当成分身接着用");
    const safe = wt.open(S, { repo: appHit.repo, session: "s15", legacy: [legacy], seed: false });
    ok(safe && safe.dir && safe.dir !== planted && !safe.reused, "★老地方在这个仓库里面：不认，照常在新地方开★", JSON.stringify(safe && { dir: safe.dir, reused: safe.reused }));
    if (safe && safe.dir) wt.close(S, safe.dir, { force: true });
    wt.close(legacy, before.dir, { force: true });
    git(app, "worktree", "remove", "--force", planted);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})();
