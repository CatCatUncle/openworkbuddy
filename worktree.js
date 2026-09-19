"use strict";
/**
 * worktree 隔离：两条任务同时改同一个仓库时，后进来的那条进自己的 git worktree。
 *
 * 为什么非得有这个：成果目录那套隔离（每条对话一个「任务_月日_标题」文件夹）对文档类活儿
 * 够用——两条任务各写各的文件夹，谁也碰不着谁。但用户把工作目录指到自己代码仓库的那一刻，
 * 这套就失效了：两条任务读的是同一份 src/，A 刚把函数改成三个参数，B 手里还是两个参数的旧文本，
 * 写回去就把 A 的改动抹了。谁也没报错，测试可能还是绿的，坏的是中间那一版。
 *
 * 做法跟 Codex 一样：让第二条任务在 git worktree 里干活。同一个 .git、独立的工作区和分支，
 * 改动进 owb/<会话> 分支，用户的工作区一个字不动。
 *
 * 三条界限，都是故意的：
 * 1) 只有**撞上**才隔离。一个人一条任务是绝大多数情况，凭空把人扔进一个陌生目录只会让人找不着文件。
 * 2) 先到的那条不动。它在用户眼皮底下的那份工作区里改，看得见、摸得着——这是用户的预期。
 *    后到的那条才是"多出来的"，让它去侧线。
 * 3) 绝不自动合回来。分身里的改动只报告、不落地：`git merge owb/xxx` 是用户按的。
 *    自动合并意味着冲突要由 agent 现场决定怎么取舍，那是它最没资格拍板的事。
 *
 * 分身是从 HEAD 开的，所以用户手上没提交的改动得**带过去**（seedFrom），否则第二条任务
 * 看到的是一个「退回上次 commit」的仓库，它会以为同事的活没干，把改好的地方再改一遍。
 *
 * 账本就是 git 自己 + 一个小小的随身单（<store>/<仓库键>/<名字>.owb.json，记会话和起点 commit）。
 * 随身单丢了不影响 git，只是少几句话可说。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const BRANCH_PREFIX = "owb/";
const SEED_MAX_FILES = 200;            // 没跟踪的文件带过去的上限
const SEED_MAX_BYTES = 20 * 1024 * 1024;
const KEEP_DAYS = 14;                  // 没人管的分身留这么久；有改动的只删目录不删分支
const GIT_TIMEOUT = 60000;

function git(cwd, args, opt) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: GIT_TIMEOUT, maxBuffer: 64 * 1048576, ...opt,
  });
}
const out = (r) => (r && r.status === 0 ? String(r.stdout || "").trim() : "");
const keyOf = (p) =>
  path.basename(p).replace(/[^\w.-]+/g, "_").slice(0, 40) + "-" + crypto.createHash("sha1").update(path.resolve(p)).digest("hex").slice(0, 8);
const safeName = (s) => String(s || "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "task";
const metaPath = (dir) => dir + ".owb.json";
// git 报的路径是走完软链的真身（/private/var/…），我们手上的多半还是链（/var/…）。
// 直接比字符串，「分身开在仓库里面」这种要命的情况就检不出来。目录还不存在时往上退到存在的那层
function realOf(p) {
  let cur = path.resolve(p), tail = "";
  for (let i = 0; i < 40; i++) {
    try { return path.join(fs.realpathSync(cur), tail); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    tail = path.join(path.basename(cur), tail);
    cur = up;
  }
  return path.resolve(p);
}

/**
 * dir 属于哪个仓库。不是仓库 / 没装 git / 裸仓库一律返回 null。
 * key 认的是**主仓库**（git-common-dir 的上一级）：主工作区和它的所有分身算同一个仓库，
 * 「这俩任务在不在动同一份代码」问的就是这个。
 */
function repoOf(dir) {
  if (!dir) return null;
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  if (out(git(dir, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null;
  const root = out(git(dir, ["rev-parse", "--show-toplevel"]));
  if (!root) return null;
  // 必须站在仓库根上问：从子目录问，git 答的是相对子目录的 ../../.git，
  // 而我们只有仓库根能当基准——算出来就会是仓库外面某个地方，于是「同一个仓库」认不出来了
  const common = path.resolve(root, out(git(root, ["rev-parse", "--git-common-dir"])) || ".git");
  const main = path.basename(common) === ".git" ? path.dirname(common) : common;
  return { root: path.resolve(root), main, key: keyOf(main) };
}

/**
 * 这条任务要不要开分身。
 * busy 是现在正在跑的其他任务：[{ session, dir }]。撞上同一个仓库才 need。
 */
function plan(dir, { session, busy } = {}) {
  const me = repoOf(dir);
  if (!me) return { need: false, why: "工作目录不是 git 仓库，成果目录那套隔离就够了" };
  const cache = new Map();
  const keyFor = (d) => {
    if (!cache.has(d)) cache.set(d, (repoOf(d) || {}).key || "");
    return cache.get(d);
  };
  const clash = (busy || []).filter((b) => b && b.dir && b.session !== session && keyFor(b.dir) === me.key);
  if (!clash.length) return { need: false, why: "没有别的任务在改这个仓库", repo: me };
  return { need: true, why: `另有 ${clash.length} 条任务正在改这个仓库`, repo: me, clash: clash.map((b) => b.session) };
}

/**
 * 把用户手上还没提交的改动带到分身里。
 * 两样：已跟踪文件的改动（diff HEAD 打成补丁再 apply，带 --binary 所以图片二进制也过得去）、
 * 没跟踪也没被 ignore 的文件（照抄）。超上限就整批不带并如实说一声——
 * 把一个 800MB 的 dist/ 拷过去比不带更糟。
 */
function seedFrom(src, dst) {
  const note = { patched: 0, copied: 0, skipped: "" };
  try {
    const names = out(git(src, ["diff", "HEAD", "--name-only"]));
    if (names) {
      const patch = git(src, ["diff", "HEAD", "--binary"], { encoding: "buffer", maxBuffer: 256 * 1048576 });
      if (patch.status === 0 && patch.stdout && patch.stdout.length) {
        const ap = spawnSync("git", ["-C", dst, "apply", "--whitespace=nowarn"], { input: patch.stdout, encoding: "utf8", timeout: GIT_TIMEOUT });
        if (ap.status === 0) note.patched = names.split("\n").length;
        else note.skipped = "没提交的改动打不进分身（" + String(ap.stderr || "").trim().split("\n")[0].slice(0, 80) + "）";
      }
    }
  } catch (e) { note.skipped = "没提交的改动没带过去：" + e.message; }
  try {
    const raw = git(src, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const rels = String(raw.stdout || "").split("\0").filter(Boolean);
    let bytes = 0;
    const keep = [];
    for (const rel of rels) {
      let st; try { st = fs.statSync(path.join(src, rel)); } catch { continue; }
      if (!st.isFile()) continue;
      bytes += st.size;
      keep.push(rel);
      if (keep.length > SEED_MAX_FILES || bytes > SEED_MAX_BYTES) break;
    }
    if (keep.length > SEED_MAX_FILES || bytes > SEED_MAX_BYTES) {
      note.skipped = (note.skipped ? note.skipped + "；" : "") + `没跟踪的文件太多（${rels.length} 个），没带过去`;
    } else {
      for (const rel of keep) {
        const to = path.join(dst, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(src, rel), to);
        note.copied++;
      }
    }
  } catch (e) { note.skipped = (note.skipped ? note.skipped + "；" : "") + "没跟踪的文件没带过去：" + e.message; }
  return note;
}

/** 开一个分身。同一个会话再来就接着用上次那个（改到一半的东西不能丢） */
function open(store, { repo, session, seed = true } = {}) {
  if (!repo || !repo.root) return { error: "不是 git 仓库" };
  const root = path.resolve(store);
  // 分身放在仓库里等于让 git 自己观察自己，况且清理时一个手滑就删到人家代码上
  const real = realOf(root), main = realOf(repo.main);
  if (real === main || real.startsWith(main + path.sep)) return { error: "分身目录在仓库里面，不能这么放" };
  const name = safeName(session);
  const dir = path.join(root, repo.key, name);
  if (fs.existsSync(path.join(dir, ".git"))) {
    const m = readMeta(dir);
    return { dir, branch: m.branch || out(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])), base: m.base || "", repo: repo.main, reused: true };
  }
  const head = out(git(repo.root, ["rev-parse", "HEAD"]));
  if (!head) return { error: "这个仓库还没有第一次提交，开不出分身" };
  fs.mkdirSync(path.join(root, repo.key), { recursive: true });
  // 分支重名多半是上一次跑完留下的。绝不用 -B：那会把人家分支上的提交直接盖掉
  let branch = "", add = null;
  for (let i = 1; i <= 9; i++) {
    branch = BRANCH_PREFIX + name + (i > 1 ? "-" + i : "");
    add = git(repo.root, ["worktree", "add", "-b", branch, dir, head], { timeout: 120000 });
    if (add.status === 0) break;
  }
  if (!add || add.status !== 0) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { error: String((add && add.stderr) || "").trim().split("\n").pop().slice(0, 160) || "worktree 开不出来" };
  }
  const seeded = seed ? seedFrom(repo.root, dir) : null;
  // 带过来的改动让分身一出生就是"脏"的。不按下这个指纹，agent 一个字没写也会被算成有产出，
  // 于是每撞一次车就多留一个分身和一根分支，删又不敢删——它看起来确实有改动
  const meta = { session: String(session || ""), repo: repo.main, branch, base: head, at: new Date().toISOString(), seed_sig: sigOf(dir) };
  try { fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2)); } catch {}
  return { ...meta, dir, seeded };
}

/** 工作区此刻的样子，按指纹比。只用来回答「跟刚开出来的时候比，变了没有」 */
function sigOf(dir) {
  return crypto.createHash("sha1").update(out(git(dir, ["status", "--porcelain"]))).digest("hex");
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(metaPath(dir), "utf8")) || {}; } catch { return {}; }
}

/** 这个分身现在什么样：改了几个文件、提交了几笔、能不能收 */
function status(dir) {
  const m = readMeta(dir);
  const branch = out(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]));
  const porcelain = out(git(dir, ["status", "--porcelain"]));
  const files = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
  // 起点 commit 丢了就说不出"比原来多几笔"，如实报 0，绝不猜一个数出来
  const commits = m.base ? Number(out(git(dir, ["rev-list", "--count", "HEAD", "^" + m.base])) || 0) : 0;
  let at = 0;
  try { at = fs.statSync(dir).mtimeMs; } catch {}
  // "空"不等于"干净"：分身里本来就躺着用户带过来的改动。跟出生时的指纹比，一样就是这趟白跑了
  const empty = !commits && (m.seed_sig ? sigOf(dir) === m.seed_sig : files === 0);
  // 跟起点 commit 比，这根分支上一共动了几个文件（提交了的和还没提交的一起算）。
  // files 只数"没提交的"，收工时自动提交完它就归零了——拿它报"这趟改了几个文件"会一直是 0
  const touched = m.base
    ? (out(git(dir, ["diff", "--name-only", m.base])).split("\n").filter(Boolean).length
       + out(git(dir, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean).length)
    : files;
  return { dir, branch: branch || m.branch || "", base: m.base || "", session: m.session || "", repo: m.repo || "",
    dirty: files > 0, files, touched, commits, empty, at, created: m.at || "" };
}

/** 我们开过的分身（按仓库筛）。git 自己都不认的（被 prune 过）顺手把随身单收掉 */
function list(store, { repo } = {}) {
  const root = path.resolve(store);
  const rows = [];
  let keys = [];
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  try { keys = fs.readdirSync(root).filter((n) => isDir(path.join(root, n))); } catch { return rows; }
  if (repo && repo.key) keys = keys.filter((k) => k === repo.key);
  for (const k of keys) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, k)); } catch { continue; }
    for (const n of names) {
      if (n.endsWith(".owb.json")) continue;
      const dir = path.join(root, k, n);
      if (!fs.existsSync(path.join(dir, ".git"))) {
        try { fs.rmSync(metaPath(dir), { force: true }); } catch {}
        continue;
      }
      rows.push(status(dir));
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}

/**
 * 收掉一个分身。
 * 有改动 / 有提交的默认不收——那是还没合回去的活，删了就真没了。keepBranch 时只删目录：
 * 提交都在 git 里，分支还在，人什么时候想合都合得回来，腾的是磁盘不是成果。
 */
function close(store, dir, { force = false, keepBranch = null } = {}) {
  const st = status(dir);
  if (!st.branch) return { ok: false, error: "这不是一个分身目录" };
  // 拦的是「这趟干出来的活」。只有用户自己带过来的那份改动不算——那份在他自己的工作区里原样躺着
  if (!force && !st.empty) {
    return { ok: false, error: `分支 ${st.branch} 里还有没合回去的改动（${st.files} 个文件改动 / ${st.commits} 笔提交）`, ...st };
  }
  const repo = st.repo && fs.existsSync(st.repo) ? st.repo : path.dirname(dir);
  const args = ["worktree", "remove", dir];
  if (force || st.dirty) args.splice(2, 0, "--force");
  const r = git(repo, args, { timeout: 120000 });
  if (r.status !== 0) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    git(repo, ["worktree", "prune"]);
  }
  // 空分支不留（一条提交都没有 = 什么都没产出）；有提交的除非明说，一律留着
  const drop = keepBranch === null ? !st.commits : !keepBranch;
  if (drop && st.branch.startsWith(BRANCH_PREFIX)) git(repo, ["branch", "-D", st.branch]);
  try { fs.rmSync(metaPath(dir), { force: true }); } catch {}
  return { ok: true, branch: st.branch, kept_branch: !drop, files: st.files, commits: st.commits };
}

/**
 * 跑完了。什么都没产出就地收掉（跟「空的任务文件夹不留」同一个道理）。
 *
 * 有产出的先替它提交一笔再留下。这一步不能省：agent 收工时工作区多半是脏的，
 * 而**没提交的改动是合不回来的**——用户照着提示敲 git merge，git 会说这分支跟你一模一样，
 * 他得自己 cd 进一个他从没听说过的目录才找得到那些改动。提交了，它才真的是"一个分支"。
 */
function release(store, dir, { title = "" } = {}) {
  const st = status(dir);
  if (!st.branch) return null;
  if (st.empty) return { ...close(store, dir), removed: true, empty: true };
  if (st.dirty) commitAll(dir, "OpenWorkBuddy 任务产出" + (title ? "：" + String(title).slice(0, 60) : ""));
  return { ...status(dir), removed: false };
}

/** 把分身里所有改动提交到它自己那根分支上。仓库没配 user.name 的机器上也得成 */
function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  const id = out(git(dir, ["config", "user.email"]))
    ? [] : ["-c", "user.name=OpenWorkBuddy", "-c", "user.email=noreply@openworkbuddy.local"];
  const r = git(dir, [...id, "commit", "-q", "-m", message]);
  return r.status === 0;
}

/**
 * 定期打扫。alive 是此刻还在跑的分身目录，一个都不碰。
 * 什么都没产出的直接收；有产出但放了 days 天没人管的，只删目录、留分支。
 */
function sweep(store, { alive = [], days = KEEP_DAYS, now = Date.now() } = {}) {
  const live = new Set((alive || []).map((d) => path.resolve(d)));
  const done = [];
  for (const st of list(store)) {
    if (live.has(path.resolve(st.dir))) continue;
    const old = now - st.at > days * 86400000;
    if (st.empty) done.push({ ...close(store, st.dir), dir: st.dir, why: "什么都没产出" });
    else if (old && !st.dirty) done.push({ ...close(store, st.dir, { force: true, keepBranch: true }), dir: st.dir, why: `放了 ${days} 天没人管（分支留着）` });
  }
  return done;
}

/**
 * 这个目录是不是我们开的分身。只读随身单，不起 git 进程——
 * 每轮提示词都要问一次，为一行提示语 fork 一个 git 出来太贵了
 */
function markOf(dir) {
  const m = readMeta(dir);
  return m && m.branch ? { branch: m.branch, repo: m.repo || "", session: m.session || "" } : null;
}

/** 给用户看的那句话。合回去的命令必须给全，不然他得自己去查 git 手册 */
function hint(info) {
  if (!info || !info.branch) return "";
  const lines = [`这条任务在独立分身里改，你的工作区一个字没动。分支：${info.branch}`];
  if (info.seeded && (info.seeded.patched || info.seeded.copied)) {
    lines.push(`你手上没提交的改动已经带过去了（${info.seeded.patched} 个改动文件 / ${info.seeded.copied} 个新文件）。`);
  }
  if (info.seeded && info.seeded.skipped) lines.push("⚠ " + info.seeded.skipped + "。");
  if (typeof info.touched === "number") lines.push(`这根分支上比你的 HEAD 多了 ${info.touched} 个文件的改动。`);
  const R = info.repo || ".";
  lines.push(`先看改了啥：git -C ${R} diff HEAD...${info.branch}　　合回来：git -C ${R} merge ${info.branch}`);
  if (info.seeded && (info.seeded.patched || info.seeded.copied)) lines.push("合之前先把你自己那份改动提交或 stash 掉，不然 git 不让动这些文件。");
  return lines.join("\n");
}

module.exports = {
  repoOf, plan, open, list, status, close, release, sweep, hint, commitAll, markOf,
  BRANCH_PREFIX, KEEP_DAYS,
  _internals: { git, seedFrom, keyOf, safeName, metaPath, readMeta, SEED_MAX_FILES, SEED_MAX_BYTES },
};
