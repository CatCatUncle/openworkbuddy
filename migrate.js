"use strict";
/**
 * 升级迁移。
 *
 * 装过老版本的机器升上来，之前的文件得替人收进新文件夹里整理好，不能出岔子。
 *
 * 两件事：
 *   1）**升级前先留底**。新版本改了画布的读写规矩（见 tools.js canvasNormalizeState），
 *      老版本写下的文件第一次被新版本打开之前，先原样拷一份走。这条纯粹是保险：
 *      万一新规矩在某台机器上判错了，用户手里永远有一份升级前的原件。
 *   2）**把散在工作区根目录的旧文件收进一个文件夹**。老版本的产出不进 `任务_*` 目录，
 *      一股脑摆在根上；用久了根目录几百个文件，成果面板和文件树全是噪音。
 *
 * 三条规矩，一条都不能破：
 *   · **只搬，不删**。整个文件里没有一处 unlink/rm。搬过去的东西原样躺在新文件夹里。
 *   · **不覆盖**。目标位置已经有同名的就跳过，宁可不整理也不能盖掉谁。
 *   · **搬完留账**。每次迁移写一份 `整理清单.json`，谁从哪儿搬到哪儿写得清清楚楚，
 *      用户想退回去照着搬回来就行。
 *
 * 跑一次就记一笔（data/migrations.json），下次启动认得出来不再跑。出任何错都只写日志，
 * 绝不让启动失败——迁移是锦上添花的事，为它开不了应用是本末倒置。
 */

const fs = require("fs");
const path = require("path");

/** 工作区根目录下这些不算「散落的旧文件」，一概不动 */
const KEEP_AT_ROOT = new Set([".DS_Store", ".openworkbuddy", ".trash", "node_modules", ".git"]);
/** 一次最多搬这么多，防着有人把工作目录指到了下载文件夹这种地方 */
const MOVE_CAP = 2000;

function stampToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function readLedger(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { return {}; }
}

/**
 * 升级前把画布文件原样拷一份。
 *
 * 只拷不动原件，所以跑了也等于没跑——它存在的全部意义是「万一」。
 * 备份落在 .openworkbuddy/升级前备份_<日期>/ 下，跟画布本体挨着，用户找得到。
 */
function backupCanvases(wsRoot) {
  const dir = path.join(wsRoot, ".openworkbuddy");
  if (!fs.existsSync(dir)) return { copied: 0, to: "" };
  const files = [];
  const main = path.join(dir, "canvas.json");
  if (fs.existsSync(main)) files.push(main);
  const more = path.join(dir, "canvases");
  if (fs.existsSync(more)) {
    for (const n of fs.readdirSync(more)) {
      if (n.endsWith(".json")) files.push(path.join(more, n));
    }
  }
  if (!files.length) return { copied: 0, to: "" };
  const to = path.join(dir, "升级前备份_" + stampToday());
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const f of files) {
    const dest = path.join(to, path.basename(f));
    // 已经有了就不覆盖：同一天升级两回，第一份才是真正的「升级前」
    if (fs.existsSync(dest)) continue;
    try { fs.copyFileSync(f, dest); copied++; } catch {}
  }
  return { copied, to: path.relative(wsRoot, to) };
}

/**
 * 把散在工作区根目录的旧文件收进一个新文件夹。
 *
 * 「散落」的定义卡得很紧，只认**根目录下的普通文件**：
 *   · 文件夹一律不动 —— 任务_* 是成果目录，别的文件夹是用户自己建的，搬了就是添乱；
 *   · 点开头的不动 —— .openworkbuddy 是画布和状态，.trash 是回收站；
 *   · 新文件夹自己当然也不动。
 *
 * 判定「旧」用的是修改时间：这次升级之后才产生的文件不该被当成历史遗留收走。
 * 传 quietDays 就是「多久没动过才算旧」，默认 1 天——刚跑完的任务不碰。
 */
function tidyLooseFiles(wsRoot, { quietDays = 1, now = Date.now() } = {}) {
  if (!fs.existsSync(wsRoot)) return { moved: 0, to: "", skipped: [] };
  let names = [];
  try { names = fs.readdirSync(wsRoot); } catch { return { moved: 0, to: "", skipped: [] }; }
  const quietMs = quietDays * 86400000;
  const loose = [];
  for (const n of names) {
    if (KEEP_AT_ROOT.has(n) || n.startsWith(".") || n.startsWith("以前的文件_")) continue;
    let st;
    try { st = fs.statSync(path.join(wsRoot, n)); } catch { continue; }
    if (!st.isFile()) continue;                       // 文件夹一律不动
    if (now - st.mtimeMs < quietMs) continue;         // 刚动过的不算历史遗留
    loose.push({ name: n, size: st.size, mtime: st.mtimeMs });
  }
  if (!loose.length) return { moved: 0, to: "", skipped: [] };
  if (loose.length > MOVE_CAP) {
    // 这个数不正常——多半是工作目录被指到了下载文件夹之类的地方。
    // 搬几千个文件这种事，宁可不做也不能替用户拿主意
    return { moved: 0, to: "", skipped: [], tooMany: loose.length };
  }
  const folder = "以前的文件_" + stampToday();
  const to = path.join(wsRoot, folder);
  fs.mkdirSync(to, { recursive: true });
  const moved = [], skipped = [];
  for (const f of loose) {
    const dest = path.join(to, f.name);
    // 目标已经有同名的就跳过。宁可这一个不整理，也不能盖掉那边那份
    if (fs.existsSync(dest)) { skipped.push({ name: f.name, why: "新文件夹里已经有同名文件了" }); continue; }
    try { fs.renameSync(path.join(wsRoot, f.name), dest); moved.push(f); }
    catch (e) { skipped.push({ name: f.name, why: e.message }); }
  }
  // 留账：谁从哪儿搬到哪儿。用户想退回去，照着这张单子搬回来就行
  try {
    fs.writeFileSync(path.join(to, "整理清单.json"), JSON.stringify({
      说明: "升级时把工作区根目录里这些旧文件收进了这个文件夹。原件一个没删，想放回去就按 files 里的名字搬回上一级。",
      至: folder, 时间: new Date().toISOString(),
      files: moved.map((f) => f.name), skipped,
    }, null, 2), "utf8");
  } catch {}
  if (!moved.length) { try { fs.rmdirSync(to); } catch {} return { moved: 0, to: "", skipped }; }
  return { moved: moved.length, to: folder, skipped };
}

/** 迁移清单。加一条就往这儿加，id 改了等于重跑一次，所以 id 是稳定的。 */
const MIGRATIONS = [
  {
    id: "canvas-backup-v1",
    title: "升级前把画布原样留一份",
    run: (ctx) => {
      const r = backupCanvases(ctx.workspace);
      return r.copied ? `画布留底 ${r.copied} 份 → ${r.to}` : "";
    },
  },
  {
    id: "tidy-root-v1",
    title: "把散在工作区根目录的旧文件收进一个文件夹",
    // 要整理的是**更新的时候**之前留下的那些文件。
    // 「更新的时候」是条件，不是修辞：全新装一台、或者把软件指到一个已经有东西的文件夹上，
    // 都不该擅自去动人家的文件。所以这条只在**确实从一个旧版本升上来**时才跑。
    upgradeOnly: true,
    run: (ctx) => {
      const r = tidyLooseFiles(ctx.workspace, ctx.options);
      if (r.tooMany) return `根目录有 ${r.tooMany} 个散文件，太多了，没敢自动整理——这多半是工作目录指错了地方`;
      return r.moved ? `整理了 ${r.moved} 个旧文件 → ${r.to}/（原件一个没删，清单在 ${r.to}/整理清单.json）` : "";
    },
  },
];

/**
 * 跑一遍还没跑过的迁移。返回这次真做了事的那几条，供启动日志和界面提示用。
 *
 * ledgerFile 记的是「哪些 id 跑过了」，按工作区根分开记 —— 换过工作目录的人，
 * 新目录里那些散文件同样需要整理一次。
 */
/**
 * @param {string} workspace 当前工作目录
 * @param {string} ledgerFile 账本路径
 * @param {{version?:string, priorUse?:boolean, quietDays?:number, now?:number}} options
 *
 * 账本里除了「哪些迁移跑过了」，还记一个 version：**上次启动时是哪个版本**。
 * 加上调用方给的 priorUse（这台机器以前用过这个软件没有），四种情况就分得开了：
 *
 *   全新装（没账本、也没用过）        → upgradeOnly 的不跑，直接销账。
 *                                      人家刚装完，工作目录里的东西是人家自己放的，凭什么动。
 *   老用户升上来（没账本、但用过）    → 跑。这正是用户要的那一下：带migrations的第一个版本
 *                                      装到一台早就有一堆散文件的机器上。
 *   原地重启（有账本、版本没变）      → 不跑。
 *   再升一次（有账本、版本变了）      → 跑这一版新加的那几条。
 */
function runMigrations(workspace, ledgerFile, options = {}) {
  const ledger = readLedger(ledgerFile);
  const key = workspace;
  const done = new Set((ledger.done || {})[key] || []);
  const results = [];
  const version = String(options.version || "");
  const hasLedger = !!ledger.version;                       // 账本里有版本 = 这套迁移机制见过这台机器
  // 没账本又确实用过 = 从「还没有迁移机制的那些版本」升上来的，这就是升级
  const isUpgrade = hasLedger ? (!!version && ledger.version !== version) : !!options.priorUse;
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    if (m.upgradeOnly && !isUpgrade) {
      // 不是升级，就不动用户的文件。第一次装直接销账，别在每次重启时挂着
      if (!hasLedger) done.add(m.id);
      continue;
    }
    let note = "";
    try { note = m.run({ workspace, options }) || ""; }
    catch (e) {
      // 一条挂了不影响别的，也绝不影响启动。不记进账本，下次启动再试一遍
      console.warn(`[迁移] ${m.title} 没做成（不影响使用）：${e.message}`);
      continue;
    }
    done.add(m.id);
    if (note) results.push({ id: m.id, title: m.title, note });
  }
  try {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, JSON.stringify({ ...ledger, version: version || ledger.version || "", done: { ...(ledger.done || {}), [key]: [...done] } }, null, 2), "utf8");
  } catch (e) {
    console.warn("[迁移] 账本写不进去，下次启动会再跑一遍（不影响使用）：" + e.message);
  }
  return results;
}

module.exports = { runMigrations, MIGRATIONS, _internals: { tidyLooseFiles, backupCanvases, stampToday } };
