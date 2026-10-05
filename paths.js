// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 代码在哪 vs 数据在哪。
 *
 * 开发态（git clone + npm run app）：两者都是仓库目录，跟以前一模一样，行为一个字节都不变。
 * 装机态（.dmg / .exe 装出来的那份）：代码在应用包里，那地方是只读的——macOS 上往签名过的
 *   包里写东西会直接破坏签名，Windows 装在 Program Files 下普通用户也没有写权限。
 *   所以所有会被写的东西（配置、账号、会话、工作区、技能、插件、备份、日程）一律落到
 *   用户家目录下的 ~/OpenWorkBuddy。
 *
 * 为什么用家目录而不是 Library/Application Support 或 AppData：工作区里放的是 PPT/Word/Excel
 * 这些要交到用户手上的成果文件，得让人在访达/资源管理器里自己找得到、能拖走。
 *
 * 想放别处：设环境变量 OPENWORKBUDDY_HOME=/你的/路径（开发态也吃这个变量，方便隔离测试）。
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** 只读：代码、public/、config.example.json、随包出厂的 skills/ */
const APP_DIR = require("./src/platform/root").ROOT; // 仓库根只认 root.js 这一处锚点：本文件搬进子目录也不漂

/** @returns {boolean} 是不是装机态（.dmg / .exe 装出来的那份） */
function isPackaged() {
  // 独立服务进程（utilityProcess，2026-09-29 起桌面版默认）里没有 electron.app，由主进程
  // 用 OWB_PACKAGED 告诉它。放最前面：答错了装机版会拿应用包当数据根，账号、会话全对不上
  if (/** @type {any} */ (process).type === "utility") return process.env.OWB_PACKAGED === "1";
  // ELECTRON_RUN_AS_NODE：run_node 派生出去的子进程也带 electron 版本号，但它不是应用本体
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) return false;
  try {
    return !!require("electron").app.isPackaged;
  } catch {
    return false;
  }
}

/** 可写：配置 / 数据 / 工作区 / 技能 / 插件 / 备份都在这儿 */
const DATA_DIR = process.env.OPENWORKBUDDY_HOME
  ? path.resolve(process.env.OPENWORKBUDDY_HOME)
  : isPackaged()
    ? path.join(os.homedir(), "OpenWorkBuddy")
    : APP_DIR;

/** 数据根下的路径 @param {...string} seg @returns {string} */
function dataPath(...seg) {
  return path.join(DATA_DIR, ...seg);
}

/** 应用包内的只读资源 @param {...string} seg @returns {string} */
function appPath(...seg) {
  return path.join(APP_DIR, ...seg);
}

/** 两处同名时，用户那份优先、包里那份兜底（读用；写一律写 dataPath） @param {...string} seg @returns {string} */
function preferData(...seg) {
  const mine = dataPath(...seg);
  return fs.existsSync(mine) ? mine : appPath(...seg);
}

/**
 * 拷一整棵目录，能走 APFS 的 clonefile 就走（cp -c）。
 *
 * clonefile 是写时复制：拷完两边各是各的文件，改哪边都不影响对面，语义和真拷贝一模一样，
 * 但底下共享同一批数据块，所以几乎不占盘、也几乎不花时间。
 *
 * 值得为这个多写十行，是因为 seedDataDir 每铺一个新数据目录就要把 skills/ 整份拷过去。
 * 本机装了 ppt-master 之后这一份是 189M，实测（df 量真占盘，不是 du——du 看不见 clone 共享）：
 *
 *     普通拷贝 170MB / 次     clone 5MB / 次
 *
 * 装机的真实用户首次启动就得干等这一下。更凶的是端到端测试：每个用例起一个新 HOME，
 * 一轮几十个用例约 7.5G 白写，攒几十轮就是 /var/folders 底下上百 G——磁盘报到 99% 那次
 * 就是这么来的（清理那一半在 test/e2e.js 的 reapStaleTempHomes）。
 *
 * 不是 macOS、不是 APFS、跨卷、或者 cp 不认 -c：退回 fs.cpSync。退回的是慢，不是错。
 * 失败过一次就整个进程不再试——否则每个技能目录都要白 spawn 一次 cp。
 */
let canClone = process.platform === "darwin";
/** @param {string} from @param {string} to */
function copyTree(from, to) {
  if (canClone) {
    try {
      // 不加 windowsHide：canClone 只在 macOS 上为真
      require("child_process").execFileSync("/bin/cp", ["-Rc", from, to], { stdio: "ignore" });
      return;
    } catch {
      canClone = false;
      // 挂在半道上会留下一棵拷了一半的树，下面 cpSync 撞见它就只补缺的那几个文件，
      // 拼出来的东西比没拷更难查。先清干净再走老路。
      try { fs.rmSync(to, { recursive: true, force: true }); } catch {}
    }
  }
  fs.cpSync(from, to, { recursive: true });
}

/** @param {string} from @param {string} to @returns {boolean} 真拷了才是 true */
function copyIfMissing(from, to) {
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  copyTree(from, to);
  return true;
}

// ———————————————— 内置技能跟着应用升级 ————————————————
//
// 以前只「缺了才拷」：数据目录里有了就再也不碰。结果是老用户升了十个版本，手上跑的还是第一次
// 装机时那一版技能——docx 那次重写，一个老用户都没拿到。可也不能见了就盖：技能是 Markdown，
// 用户改两句再正常不过，盖掉就是把人家的东西弄丢了。
//
// 所以判据只有一条：数据目录里这份技能的每个文件，是不是「我们发出去过的某一版」原样。
//   - 是：没人动过，换成这一版（多出来的老文件也只删认得出的）；
//   - 有一个不是：整份原样留着，记一行日志，告诉人想要新版怎么办。
// 「发出去过的哪一版」有两个来源：
//   ① .builtin-skills/manifest.json：这台机器上每次铺进去 / 换进去的那一版，逐文件记指纹；
//   ② lib/builtin-skill-hashes.json：git 历史里每一版的指纹，给没有 ① 的老装机认老版本用。
// 不靠修改时间猜：cp -c、解压、同步盘都会改 mtime，猜错一次就是丢用户的字。
//
// 同一个数据目录被新旧两版应用轮流打开时，没人动过的内置技能会跟着正在跑的那版来回换——
// 这是故意的（技能跟着跑它的那版应用走），改过的照样原样留着，不丢东西。

/**
 * 一个文件的指纹：跟 `git hash-object` 同一个算法（blob 头 + 内容取 SHA-1），只留前 16 位。
 * 用 git 的算法，是因为老装机手上那份没有任何记录，只能拿 git 历史里每一版的 blob 来认——
 * 算法一样，git 里查出来的数直接就能比。16 位只拿来跟一百来个历史版本比，撞上的机会可以不计。
 * @param {Buffer} buf @returns {string}
 */
function skillBlobHash(buf) {
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex").slice(0, 16);
}

/** @typedef {{ skills: Set<string>, files: Map<string, Set<string>> }} SkillHistory */

/** 技能目录里的相对路径：/ 分隔、不许绝对、不许带 .. 或空段——按这些路径要删文件，一点不能含糊 @param {any} rel @returns {boolean} */
function safeRel(rel) {
  return typeof rel === "string" && rel !== "" && !path.isAbsolute(rel) && !/^[a-zA-Z]:/.test(rel)
    && !rel.split(/[\\/]/).some((s) => s === "" || s === "." || s === "..");
}

/**
 * 读随包带的「历来出厂过的每一版」指纹表（scripts/skill-hashes.js 生成）。
 * 用 readFileSync 不用 require：读不出来得当场接住、退回只补缺，不能让整个启动跟着抛。
 * @param {string} [file] @returns {SkillHistory|null}
 */
function loadSkillHistory(file = path.join(APP_DIR, "lib", "builtin-skill-hashes.json")) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || !Array.isArray(j.skills) || !j.files || typeof j.files !== "object") return null;
    /** @type {Map<string, Set<string>>} */
    const files = new Map();
    for (const [rel, hs] of Object.entries(j.files)) {
      const r = rel.normalize("NFC");
      if (safeRel(r) && Array.isArray(hs)) files.set(r, new Set(hs.map(String)));
    }
    return { skills: new Set(j.skills.map(String).filter((n) => safeRel(n) && !/[\\/]/.test(n))), files };
  } catch {
    return null;
  }
}

// 运行时自己长出来的东西（装依赖、跑 Python、访达留的），永远不算出厂文件。
// 开发仓库里它们就躺在技能底下（Docker、测试的临时家都从这儿铺），算进去的话，数据目录那边
// Python 重新编出来的 .pyc 跟包里那份对不上，整份技能就会被当成「改过」留住
const SKIP_IN_SKILL = new Set([".DS_Store", "Thumbs.db", "__pycache__", "node_modules", ".venv", ".git"]);

/**
 * 一整个技能目录的指纹：相对路径（/ 分隔、NFC）→ 指纹。只认普通文件，软链和别的一概不算。
 * 键统一成 NFC：git 历史、macOS 和 Linux 上同一个中文文件名的字节可能不一样，不统一就对不上。
 * @param {string} dir
 * @param {Map<string, string>} [raw] 顺手记 NFC 键 → 盘上原名（拷文件时得按原名找）
 * @returns {Map<string, string>}
 */
function hashTree(dir, raw) {
  /** @type {Map<string, string>} */
  const out = new Map();
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_IN_SKILL.has(e.name)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) {
        const k = r.normalize("NFC");
        out.set(k, skillBlobHash(fs.readFileSync(path.join(abs, e.name))));
        if (raw) raw.set(k, r);
      }
    }
  };
  walk(dir, "");
  return out;
}

/** 这一版包里技能的签名：文件清单 + 每个的指纹。「这一版已经说过留着了」就靠它认 @param {Map<string, string>} m */
function bundleSig(m) {
  return skillBlobHash(Buffer.from([...m.keys()].sort().map((r) => r + "\0" + m.get(r)).join("\n")));
}

/** @param {Map<string, string>} m @returns {Record<string, string>} 键排好序，manifest 前后比较才不会因为顺序白写一次 */
function filesObj(m) {
  /** @type {Record<string, string>} */
  const o = {};
  for (const k of [...m.keys()].sort()) o[k] = /** @type {string} */ (m.get(k));
  return o;
}

/** @param {string} p @returns {fs.Stats|null} */
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

/**
 * 按「盘上真叫这个名字」找文件：每一段都在父目录的清单里逐字对（比 NFC）。
 * 不能直接 lstat：macOS / Windows 默认不分大小写，历史里的 Foo.md 会「存在」成现在出厂的 foo.md，
 * 被当成老文件删掉。中途撞上软链或文件也不往下走——不顺着软链去动别处的东西。
 * @param {string} root
 * @param {string} rel
 * @param {Map<string, Map<string, fs.Dirent>>} cache 同一个技能里多次查同一个目录，只读一遍
 * @returns {{ kind: "none"|"file"|"other", disk: string, created: string[] }}
 *   disk：盘上实际的相对路径（没有的段按 rel 补）；created：放这个文件得新建的目录（浅到深）
 */
function existsExact(root, rel, cache) {
  const segs = rel.split("/");
  /** @type {string[]} */
  const disk = [];
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    let ents = cache.get(cur);
    if (!ents) {
      // 读不了就让它抛：目录明明在却读不了，当成「没有」会去补文件、甚至删错
      ents = new Map();
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) ents.set(e.name.normalize("NFC"), e);
      cache.set(cur, ents);
    }
    const e = ents.get(segs[i]);
    if (!e) {
      /** @type {string[]} */
      const created = [];
      for (let k = i; k < segs.length - 1; k++) created.push([...disk, ...segs.slice(i, k + 1)].join("/"));
      return { kind: "none", disk: [...disk, ...segs.slice(i)].join("/"), created };
    }
    disk.push(e.name);
    if (i === segs.length - 1) return { kind: e.isFile() ? "file" : "other", disk: disk.join("/"), created: [] };
    if (!e.isDirectory()) return { kind: "other", disk: disk.join("/"), created: [] };
    cur = path.join(cur, e.name);
  }
  return { kind: "other", disk: rel, created: [] }; // 走不到：segs 至少一段
}

/** 先写临时文件再改名：写到一半断电，留下的是旧的那份，不是半截 JSON @param {string} file @param {any} obj */
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + "\n");
  fs.renameSync(tmp, file);
}

/** 只删空目录，从 dir 往上一路删到 top（不含）为止，碰到不空的就停：里面住着运行时的东西 @param {string} top @param {string} dir */
function pruneUp(top, dir) {
  while (dir.length > top.length && dir.startsWith(top + path.sep)) {
    try { fs.rmdirSync(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && /** @type {any} */ (e).code === "EPERM"; }
}

/**
 * 同一个数据目录同时只许一个进程换技能：两个进程一起挪同一批文件，回滚记录会互相踩。
 * 平时没人抢（壳和服务进程是先后跑的），这把锁防的是同一个数据目录被两份应用同时打开。
 * 锁的主人已经不在了、或者锁放了十分钟以上，当它是上次崩掉留下的，收走再拿一次。
 * @param {string} root @returns {(() => void)|null} 拿到了返回放锁的函数，别人占着返回 null
 */
function takeLock(root) {
  const f = path.join(root, "lock");
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(f, String(process.pid), { flag: "wx" });
      return () => {
        try { if (fs.readFileSync(f, "utf8") === String(process.pid)) fs.unlinkSync(f); } catch {}
      };
    } catch (e) {
      if (!e || /** @type {any} */ (e).code !== "EEXIST") throw e;
      let stale = true;
      try {
        const pid = Number(fs.readFileSync(f, "utf8").trim());
        stale = !pidAlive(pid) || Date.now() - fs.statSync(f).mtimeMs > 10 * 60000;
      } catch {}
      if (!stale) return null;
      try { fs.unlinkSync(f); } catch {}
    }
  }
  return null;
}

/**
 * @typedef {{ rel: string, disk: string, existed: boolean, hash: string }} JournalWrite
 * @typedef {{ rel: string, disk: string }} JournalRemove
 * @typedef {{ v: 1, name: string, phase: "staged"|"applied", writes: JournalWrite[], removes: JournalRemove[], mkdirs: string[] }} Journal
 */

/** 记录是不是我们自己写的那个样子：按它挪文件，路径不对就一个都不能动 @param {any} j @param {string} name @returns {boolean} */
function validJournal(j, name) {
  return !!j && j.v === 1 && j.name === name && (j.phase === "staged" || j.phase === "applied")
    && Array.isArray(j.writes) && j.writes.every((/** @type {any} */ w) => w && safeRel(w.rel) && safeRel(w.disk) && typeof w.existed === "boolean" && typeof w.hash === "string")
    && Array.isArray(j.removes) && j.removes.every((/** @type {any} */ r) => r && safeRel(r.rel) && safeRel(r.disk))
    && Array.isArray(j.mkdirs) && j.mkdirs.every(safeRel);
}

/**
 * 按记录把技能目录退回换之前的样子。每一步都先看盘上现状再动，所以重复跑一遍也没事——
 * 上次退到一半又崩了，下次启动接着退。
 * @param {string} D 数据目录里这份技能 @param {string} work 它的工作目录 @param {Journal} j
 */
function rollback(D, work, j) {
  const OLD = path.join(work, "old");
  for (const w of [...j.writes].reverse()) {
    const o = path.join(OLD, w.rel), d = path.join(D, w.disk);
    if (lstatOrNull(o)) {
      if (lstatOrNull(d)) fs.unlinkSync(d);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.renameSync(o, d);
    } else if (!w.existed) {
      // 原来没有这个文件：盘上那个正好是我们放的那一版才删，别的一概不碰
      const st = lstatOrNull(d);
      if (st && st.isFile() && skillBlobHash(fs.readFileSync(d)) === w.hash) fs.unlinkSync(d);
    }
  }
  for (const r of [...j.removes].reverse()) {
    const o = path.join(OLD, r.rel), d = path.join(D, r.disk);
    if (lstatOrNull(o) && !lstatOrNull(d)) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.renameSync(o, d);
    }
  }
  // 为放新文件建的目录，深的先删；只删空的——原来就有的目录不在这张单子上
  for (const m of [...j.mkdirs].sort((a, b) => b.split("/").length - a.split("/").length)) {
    try { fs.rmdirSync(path.join(D, m)); } catch {}
  }
  fs.rmSync(work, { recursive: true, force: true });
}

/**
 * @typedef {{ rel: string, disk: string, src: string, existed: boolean, hash: string }} PlanWrite
 * @typedef {{ name: string, D: string, work: string, writes: PlanWrite[], removes: JournalRemove[], mkdirs: string[] }} Plan
 * @typedef {{ faultAt?: number, noRollback?: boolean }} FaultOpts
 */

/**
 * 换一份技能：先把新文件全拷进工作目录，再逐个挪进去，旧的挪进 old/ 留底；
 * 中途哪一步抛了，按记录挪回去。只按清单逐个文件动，从不遍历技能目录——
 * node_modules、.venv、projects/ 这些运行时的东西连看都不看一眼。
 * @param {Plan} p @param {FaultOpts} f
 */
function applyPlan(p, f) {
  const NEW = path.join(p.work, "new"), OLD = path.join(p.work, "old");
  let step = 0;
  // 测试用：第 N 步故意抛，模拟换到一半磁盘满、权限不够、被杀
  const fault = () => {
    if (f.faultAt === ++step) throw Object.assign(new Error("faultAt " + step), { code: "EFAULT_TEST" });
  };
  fs.rmSync(p.work, { recursive: true, force: true });
  try {
    fs.mkdirSync(NEW, { recursive: true });
    fs.mkdirSync(OLD, { recursive: true });
    for (const w of p.writes) {
      fault();
      const to = path.join(NEW, w.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // FICLONE：APFS 上是写时复制，跟 copyTree 走 cp -c 一个道理；不支持的盘自动退回真拷
      fs.copyFileSync(w.src, to, fs.constants.COPYFILE_FICLONE);
    }
  } catch (e) {
    // 还在往工作目录里拷，技能目录一个字节没动：收掉工作目录就算退回去了
    // （noRollback 是测试在模拟进程被杀：那种时候没人收，留给下次启动去认）
    if (!f.noRollback) fs.rmSync(p.work, { recursive: true, force: true });
    throw e;
  }
  /** @type {Journal} */
  const j = {
    v: 1, name: p.name, phase: "staged",
    writes: p.writes.map((w) => ({ rel: w.rel, disk: w.disk, existed: w.existed, hash: w.hash })),
    removes: p.removes, mkdirs: p.mkdirs,
  };
  writeJsonAtomic(path.join(p.work, "journal.json"), j);
  try {
    // 先挪走要删的，再放新的：出厂文件改了大小写（foo.md → Foo.md）时，不分大小写的盘上
    // 先放新的会盖到老的头上，再挪老的就把新的一起挪走了
    for (const r of p.removes) {
      fault();
      const o = path.join(OLD, r.rel);
      fs.mkdirSync(path.dirname(o), { recursive: true });
      fs.renameSync(path.join(p.D, r.disk), o);
    }
    for (const w of p.writes) {
      const d = path.join(p.D, w.disk);
      if (w.existed) {
        fault();
        const o = path.join(OLD, w.rel);
        fs.mkdirSync(path.dirname(o), { recursive: true });
        fs.renameSync(d, o);
      }
      fault();
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.renameSync(path.join(NEW, w.rel), d);
    }
    fault();
  } catch (e) {
    if (!f.noRollback) {
      try { rollback(p.D, p.work, j); }
      catch (e2) { throw Object.assign(e, { rollbackError: e2 }); }
    }
    throw e;
  }
  j.phase = "applied";
  writeJsonAtomic(path.join(p.work, "journal.json"), j);
  for (const r of p.removes) pruneUp(p.D, path.dirname(path.join(p.D, r.disk)));
  fs.rmSync(p.work, { recursive: true, force: true });
}

/** @param {any} e */
const errText = (e) => ((e && e.code ? e.code + " " : "") + ((e && e.message) || e)).trim();

/**
 * @typedef {{
 *   seeded: string[],
 *   updated: { name: string, written: number, removed: number }[],
 *   kept: { name: string, paths: string[], reason: string }[],
 *   failed: { name: string, error: string }[],
 *   recovered: string[],
 *   locked: boolean,
 * }} SyncReport
 * @typedef {{
 *   appSkills: string, dataSkills: string, root: string,
 *   history: SkillHistory|null, log?: (line: string) => void,
 *   faultAt?: number, noRollback?: boolean,
 * }} SyncOpts
 */

/**
 * 包里的技能 → 数据目录：缺的铺过去，没人动过的跟着换成这一版，动过一个字的整份留着。
 * 名单（history.skills）以外的技能（.gitignore 掉的第三方包、没进 git 的）只补缺，从不比对、从不换。
 * @param {SyncOpts} opts @returns {SyncReport}
 */
function syncBuiltinSkills(opts) {
  const { appSkills, dataSkills, root, history } = opts;
  const log = opts.log || (() => {});
  /** @type {SyncReport} */
  const report = { seeded: [], updated: [], kept: [], failed: [], recovered: [], locked: false };
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(appSkills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return report;
  }
  const managed = (/** @type {string} */ n) => !!history && history.skills.has(n);

  /** @type {Record<string, any>} */
  let manifest = {};
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    if (j && j.v === 1 && j.skills && typeof j.skills === "object" && !Array.isArray(j.skills)) manifest = j.skills;
  } catch {} // 没有或读坏了：当老装机处理，历史指纹表照样护着
  const before = JSON.stringify(manifest);

  // ① 缺的铺过去（老行为，cp -c 那条路不变）。一个铺失败不耽误下一个。
  //    刚铺的不出声：全新的数据目录一行日志都不该有（test/deploy.js【4】按最后一行读结果）
  /** @type {string[]} */
  const existing = [];
  for (const n of names) {
    const B = path.join(appSkills, n), D = path.join(dataSkills, n);
    if (lstatOrNull(D)) {
      if (managed(n)) existing.push(n);
      continue;
    }
    try {
      copyTree(B, D);
      report.seeded.push(n);
      if (managed(n)) manifest[n] = { files: filesObj(hashTree(B)) };
    } catch (e) {
      report.failed.push({ name: n, error: errText(e) });
      log(`✗ ${n} 没铺进去：${errText(e)}`);
    }
  }
  if (!history && names.some((n) => !report.seeded.includes(n))) log("指纹表读不出来，这次只补缺的技能");

  // ② 已经在的内置技能：跟这一版比，能换就换
  let lockState = 0; // 0 还没要过；1 拿到了；-1 别人占着
  /** @type {(() => void)|null} */
  let release = null;
  /** @type {Set<string>} */
  const stuck = new Set(); // 上次换到一半、这次也没退回去的：这一趟不许再碰，old/ 里是原文件
  const workRoot = path.join(root, "work");
  const needLock = () => {
    if (lockState) return lockState === 1;
    try {
      fs.mkdirSync(root, { recursive: true });
      release = takeLock(root);
    } catch (e) {
      // 连锁都建不了（数据目录只读之类）：说一次就收手，别每个技能各报一遍
      lockState = -1;
      log("✗ 这次没法核对内置技能，技能照旧能用：" + errText(e));
      return false;
    }
    lockState = release ? 1 : -1;
    if (!release) {
      report.locked = true;
      log("另一个进程正在核对内置技能，这次跳过");
      return false;
    }
    // 上次换到一半停了的，先按记录退回去，再按正常流程重新判一遍
    let left = [];
    try { left = fs.readdirSync(workRoot); } catch {}
    for (const n of left) {
      const work = path.join(workRoot, n), D = path.join(dataSkills, n);
      /** @type {any} */
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(work, "journal.json"), "utf8")); } catch {}
      try {
        // 没有记录：崩在往工作目录拷的时候，技能目录还没动；已经换完：只差收尾
        if (!j || (validJournal(j, n) && j.phase === "applied")) {
          if (j) for (const r of j.removes) pruneUp(D, path.dirname(path.join(D, r.disk)));
          fs.rmSync(work, { recursive: true, force: true });
          continue;
        }
        if (!validJournal(j, n)) throw new Error("换到一半留下的记录读不懂");
        rollback(D, work, j);
        report.recovered.push(n);
        log(`${n} 上次换到一半停了，已退回原样`);
      } catch (e) {
        stuck.add(n);
        log(`✗ ${n} 上次换到一半停了，退回原样没做完，原文件在 .builtin-skills/work/${n}/old：${errText(e)}`);
      }
    }
    return true;
  };

  try {
    // 先看一眼有没有上次留下的半截：哪怕这次每个技能都走快路，也得先把它退回去
    try { if (fs.readdirSync(workRoot).length) needLock(); } catch {}
    for (const n of existing) {
      if (lockState === -1) break;
      try {
        syncOne(n);
      } catch (e) {
        report.failed.push({ name: n, error: errText(e) });
        log(`✗ ${n} 没核对完，这次没换：${errText(e)}`);
      }
    }
    // 工作目录空了就收掉：下次启动看一眼它在不在，就知道有没有上次留下的半截
    if (lockState === 1) try { fs.rmdirSync(workRoot); } catch {}
  } finally {
    if (release) release();
  }

  // 名单里已经没有的技能，manifest 里那条也收掉。指纹表读不出来时一条都不收：那时谁都不在「名单里」
  if (history) for (const n of Object.keys(manifest)) if (!managed(n) || !names.includes(n)) delete manifest[n];
  if (JSON.stringify(manifest) !== before) {
    try {
      fs.mkdirSync(root, { recursive: true });
      writeJsonAtomic(path.join(root, "manifest.json"), { v: 1, skills: manifest });
    } catch (e) {
      log(`✗ 记录没写进去，下次启动会重新核对一遍：${errText(e)}`);
    }
  }
  return report;

  /** @param {string} n */
  function syncOne(n) {
    const B = path.join(appSkills, n), D = path.join(dataSkills, n);
    /** @type {Map<string, string>} */
    const raw = new Map();
    const bundle = hashTree(B, raw);
    const sig = bundleSig(bundle);
    const rec = manifest[n] && typeof manifest[n] === "object" ? manifest[n] : null;
    /** @type {Map<string, string>|null} */
    const recFiles = rec && rec.files && typeof rec.files === "object" ? new Map(Object.entries(rec.files)) : null;
    // 快路：上次记下的正是这一版——平时每次启动都走这儿，数据目录那边一个文件都不读
    if (recFiles && recFiles.size === bundle.size && [...bundle].every(([k, h]) => recFiles.get(k) === h)) return;
    if (rec && rec.held === sig) return; // 这一版已经说过「留着」了，别每次启动都念一遍
    if (!needLock()) return;
    if (stuck.has(n)) {
      report.kept.push({ name: n, paths: [], reason: "上次换到一半没退回去" });
      return;
    }
    /** @param {string} reason @param {string[]} paths @param {string} line */
    const hold = (reason, paths, line) => {
      manifest[n] = { ...(recFiles ? { files: rec.files } : {}), held: sig };
      report.kept.push({ name: n, paths, reason });
      log(line);
    };
    const st = lstatOrNull(D);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) return hold("不是普通文件夹", [], `${n} 没更新：它不是一个普通文件夹，原样留着`);
    // 别处装进来的同名技能（install_skill 会留 .install.json）：那是另一份东西，不归出厂版管
    if (lstatOrNull(path.join(D, ".install.json"))) {
      return hold("从别处装进来的（有 .install.json）", [".install.json"], `${n} 没更新：这份是从别处装进来的（有 .install.json），原样留着`);
    }

    /** @type {Map<string, Set<string>>} */
    const hist = new Map();
    if (history) for (const [rel, hs] of history.files) if (rel.startsWith(n + "/")) hist.set(rel.slice(n.length + 1), hs);
    const known = [...new Set([...bundle.keys(), ...(recFiles ? recFiles.keys() : []), ...hist.keys()])].filter(safeRel).sort();
    /** @type {Map<string, Map<string, fs.Dirent>>} */
    const cache = new Map();
    /** @type {string[]} */
    const unknown = [];
    /** @type {PlanWrite[]} */
    const writes = [];
    /** @type {JournalRemove[]} */
    const removes = [];
    /** @type {Set<string>} */
    const mkdirs = new Set();
    /** @type {{ rel: string, probe: string }[]} */
    const fresh = []; // 盘上逐字没有、要新放的；probe 是路径里第一段逐字没有的那一截
    for (const rel of known) {
      const want = bundle.get(rel);
      const e = existsExact(D, rel, cache);
      if (e.kind === "other") { unknown.push(rel); continue; }
      if (e.kind === "none") {
        if (want === undefined) continue;
        // 我们放过、这一版还要的文件被删了：删也是一种改，放回去等于替人做主。
        // 老装机没这份记录，分不清是删了还是当初那一版本来就没有（指纹表按文件记、不按版本记），只能补上
        if (recFiles && recFiles.has(rel)) { unknown.push(rel); continue; }
        writes.push({ rel, disk: e.disk, src: path.join(B, raw.get(rel) || rel), existed: false, hash: want });
        for (const m of e.created) mkdirs.add(m);
        fresh.push({ rel, probe: e.created.length ? e.created[0] : e.disk });
        continue;
      }
      const buf = fs.readFileSync(path.join(D, e.disk));
      const h = skillBlobHash(buf);
      const hs = hist.get(rel);
      const seen = h === want || (recFiles && recFiles.get(rel) === h) || (hs && hs.has(h))
        // Windows 上打的包按 CRLF 落盘，git 历史里是 LF：换成 LF 再认一次。只对历史表这么做——
        // manifest 和包里那份记的就是盘上真实的字节
        || (hs && buf.includes("\r\n") && hs.has(skillBlobHash(Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1"))));
      if (!seen) { unknown.push(rel); continue; }
      if (want === undefined) removes.push({ rel, disk: e.disk });
      else if (h !== want) writes.push({ rel, disk: e.disk, src: path.join(B, raw.get(rel) || rel), existed: true, hash: want });
    }
    if (unknown.length) {
      return hold("跟出厂的哪一版都对不上", unknown,
        `${n} 没更新：${unknown.length} 个文件跟出厂的哪一版都对不上（${unknown.slice(0, 3).join("、")}${unknown.length > 3 ? "…" : ""}），原样留着。要新版就把这个文件夹挪走，下次启动会铺一份新的`);
    }
    // 逐字没有，不等于这个名字空着：macOS、Windows 的盘默认不分大小写，用户自己的 NOTES.md、SKILL.md、
    // Scripts/ 会被新放进来的 notes.md、skill.md、scripts/x.py 落到头上——盖掉的东西 old/ 里没留底，退不回来。
    // 哪些名字算同一个，各家文件系统规则不一样，自己比对不全，直接问它：它说有东西占着，那就是有。
    // 占着的正是这一趟先挪走的老文件（出厂文件改了大小写，foo.md → Foo.md）才让得出来，别的整份留着
    const freed = removes.map((r) => lstatOrNull(path.join(D, r.disk))).filter((s) => !!s && !!s.ino);
    for (const f of fresh) {
      const st = lstatOrNull(path.join(D, f.probe));
      if (!st || (st.ino && freed.some((s) => s && s.ino === st.ino && s.dev === st.dev))) continue;
      // 日志里写盘上真叫什么：只说 notes.md，用户在访达里找不到这个名字
      const up = path.dirname(f.probe), dir = path.join(D, up);
      let on = path.basename(f.probe);
      try {
        on = fs.readdirSync(dir).find((x) => { const s = lstatOrNull(path.join(dir, x)); return !!s && s.ino === st.ino && s.dev === st.dev; }) || on;
      } catch {}
      if (up !== ".") on = up + "/" + on;
      return hold("新版的文件跟盘上已有的算同一个名字", [f.rel],
        `${n} 没更新：新版要放的 ${f.rel} 在这块盘上跟已有的 ${on} 算同一个名字，放进去会盖到它头上，原样留着。要新版就把这个文件夹挪走，下次启动会铺一份新的`);
    }
    if (writes.length || removes.length) {
      try {
        applyPlan({ name: n, D, work: path.join(workRoot, n), writes, removes, mkdirs: [...mkdirs] }, opts);
      } catch (e) {
        report.failed.push({ name: n, error: errText(e) });
        const rbe = /** @type {any} */ (e).rollbackError;
        log(rbe
          ? `✗ ${n} 没换成，退回原样也没做完，原文件在 .builtin-skills/work/${n}/old：${errText(e)}；${errText(rbe)}`
          : `✗ ${n} 没换成，已退回原样：${errText(e)}`);
        return; // manifest 不动：下次启动再试
      }
      report.updated.push({ name: n, written: writes.length, removed: removes.length });
      log(`${n} 已换成新版：更新 ${writes.length} 个文件，删掉 ${removes.length} 个旧文件`);
    }
    manifest[n] = { files: filesObj(bundle) };
  }
}

/** 内置技能的动静：控制台一行，boot.log 里也留一行（跟 electron-main 的启动日志同一个文件） @param {string} line */
function skillLog(line) {
  console.log("[内置技能] " + line);
  try {
    fs.mkdirSync(dataPath("logs"), { recursive: true });
    fs.appendFileSync(dataPath("logs", "boot.log"), `[${new Date().toISOString()}] 内置技能：${line}\n`);
  } catch {}
}

/**
 * 装机态每次启动：把包里的「出厂内容」铺到数据目录。
 *   - 缺的技能铺过去：应用升级带来的新内置技能自动出现；
 *   - 没人动过的内置技能换成这一版：老用户也拿得到技能的更新；
 *   - 有一个文件跟出厂的哪一版都对不上，整份原样留着、记一行日志——宁可不更新，不丢用户的字；
 *   - 名单以外的技能（.gitignore 掉的第三方包）只补缺，跟以前一样。
 * 一个壳启动会跑两遍（主进程一遍，独立服务进程里 server.js 再一遍）：第二遍全走快路，不读数据目录。
 * @returns {SyncReport|undefined}
 */
function seedDataDir() {
  if (DATA_DIR === APP_DIR) return; // 开发态：本来就是同一个目录，无事可做
  for (const d of ["data", "workspace", "skills", "plugins", "backups"]) {
    fs.mkdirSync(dataPath(d), { recursive: true });
  }
  copyIfMissing(appPath("experts.json"), dataPath("experts.json"));
  try {
    return syncBuiltinSkills({
      appSkills: appPath("skills"), dataSkills: dataPath("skills"), root: dataPath(".builtin-skills"),
      history: loadSkillHistory(), log: skillLog,
    });
  } catch (e) {
    // 以前这一段整个包在空 catch 里：技能铺不铺得上都不该把启动拖垮。现在照旧不拖垮，但留一句话
    skillLog("✗ 这次没核对完，技能照旧能用：" + errText(e));
  }
}

/**
 * 听哪个端口。放这儿是因为壳（electron-main.js）和服务端（server.js）必须算出同一个数：
 * 各写各的那阵子，谁要是设了 PORT，服务端听 3810、壳去连 3800，窗口就永远等不到人。
 *
 * PORT=0 是操作系统的老规矩：「你替我挑一个空的」。以前这行写的是 `+env.PORT || ...`，
 * 而 +"0" 是 0、是假值，于是显式设的 0 被当成没设，悄悄回落到 3800——本机正跑着一台的时候
 * 就直接撞上用户自己那台了（端到端测试里五处真起 server 全栽在这儿）。
 * 所以这里的判据是「设没设」，不是「真不真」；设了但不是个合法端口号，也当没设。
 * @param {Record<string, string|undefined>|null|undefined} env 一般就是 process.env
 * @param {any} [cfg] config.json，看 server.port
 * @returns {number}
 */
function resolvePort(env, cfg) {
  const raw = env && env.PORT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return (cfg && cfg.server && cfg.server.port) || 3800;
}

module.exports = {
  APP_DIR, DATA_DIR, dataPath, appPath, preferData, seedDataDir, isPackaged, resolvePort, skillBlobHash,
  _copyTree: copyTree, _syncBuiltinSkills: syncBuiltinSkills, _loadSkillHistory: loadSkillHistory, _SKIP_IN_SKILL: SKIP_IN_SKILL,
};
