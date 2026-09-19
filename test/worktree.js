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
const { spawnSync } = require("child_process");
const wt = require("../worktree");

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
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  ok(/worktree\.plan\(getWorkspaceDir\(\)/.test(srv), "★服务端按当前工作目录判要不要隔离★");
  ok(/enterWorkspace\(opened\.dir\)/.test(srv), "★判出来要隔离就真的换了工作目录★ 少这行整套就是个空壳");
  ok(/cliLive\.list\(\{ prune: false \}\)[\s\S]{0,200}busy\.push/.test(srv),
    "★撞车名单把终端里那趟也算上★ 网页一条 + 终端一条是最常见的撞法，而它俩是两个进程");
  ok(/worktree\.release\(WORKTREE_DIR/.test(srv), "收工要收尾");
  ok(/worktree\.sweep\(WORKTREE_DIR/.test(srv), "开机扫一遍没人管的分身");
  const cli = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
  ok(/withWorkspace\(opened\.dir, \(\) => runOnceIn\(/.test(cli),
    "★命令行用 withWorkspace 包住这一趟★ 交互模式下 enterWith 会把工作目录留给 REPL，之后 /cwd 显示的就是分身目录");
  ok(/sub === "worktree"/.test(cli), "openworkbuddy worktree 这条子命令在");
  const ag = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
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
  const { withWorkspace, enterWorkspace, getWorkspaceDir } = require("../tools");
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

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail === 0 ? 0 : 1);
})();
