// @ts-check
"use strict";
/**
 * 资料库「工作区」那一栏的取数：一层一层地列（listDir），和一口气数全（walkAll）。
 *
 * 为什么要单独有这一份，而不是接着用 tools.js 的 outputFiles()：
 * outputFiles 是给文件面板、@ 补全用的，它**故意**只走 3 层、只留最新的 500 个——
 * 那几处要的是「最近动过什么」，不是「这里都有什么」。（「本回合产出」的比对也不拿它：
 * 走的是 tools.js 的 turnSnapshot()，底下就是这里的 walkAll，不卡层数、不走记忆。）资料库拿它当全集，
 * 用户工作区里 1712 个文件只露出最新的 120 个，第 4 层往下的 268 个哪儿都找不到，
 * 这就是「资料库没有显示我这个工作区下面的所有文件」那句话的来处。
 *
 * 跳过规则只有一份（skipEntry），outputFiles 也用它：两边各抄一份的话，
 * 哪天一边多跳了一个目录，就会出现「面板里有、资料库里没有」或者反过来。
 *
 * 链接一律不跟：Dirent 的 isDirectory()/isFile() 对符号链接都是 false，
 * 所以指回上层的链接成不了死循环，指到工作区外面的链接也带不出外面的文件。
 */
const fs = require("fs");
const path = require("path");

/** 这几个名字的目录不算交付物：临时区、应用自己的记账、依赖、版本库 */
const SKIP_NAMES = new Set([".tmp", ".openworkbuddy", "node_modules", ".git"]);
/** 一次列一层最多回多少条。再多浏览器那边也铺不动，多出来的照实报 truncated */
const LIST_CAP = 3000;
/** 全量走一趟最多记多少个文件、最深几层。超了就报 capped，不装作走完了 */
const WALK_CAP = 20000;
const WALK_DEPTH = 12;
/** 一层里文件多到这个数，就不再逐个 stat 排新旧了（十万个文件的目录 stat 一遍要一秒多） */
const STAT_CAP = 20000;

/** @typedef {{ name: string, path: string }} Crumb */
/** @typedef {{ name: string, path: string, count: number, mtime: string }} DirRow */
/** @typedef {{ name: string, base: string, size: number, mtime: string }} FileRow */
/**
 * offset/cap：这一页从第几条起、一页几条（文件夹在前、文件在后排成一列）。
 * by_name：这层文件多到不排新旧了，按名字排。dirs_cut：这一页没把这层的文件夹列全
 * @typedef {{ dir: string, crumbs: Crumb[], dirs: DirRow[], files: FileRow[], total: number, truncated: boolean, offset: number, cap: number, by_name: boolean, dirs_cut: boolean }} Listing
 */
/** @typedef {{ name: string, size: number, mtime: string }} WalkFile */
/** @typedef {{ files: ReadonlyArray<WalkFile>, capped: boolean }} WalkResult */
/** @typedef {{ cap?: number, offset?: unknown, appDataDir?: string }} ListOpts */
/**
 * maxDepth 给 Infinity 就是不卡层数（「本回合产出」那趟这么用），只剩条数上限
 * @typedef {{ maxDepth?: number, cap?: number, appDataDir?: string }} WalkOpts
 */

/**
 * 这一项要不要藏起来。点开头的、SKIP_NAMES 里的、以及应用自己的运行数据目录——
 * 桌面版的数据目录默认就落在工作区里，那里面有 im-log、会话记录，
 * 当成「成果」列出来等于把别人发来的消息原文摆上资料库。
 * @param {string} name 这一项自己的名字
 * @param {string} fullPath 这一项的绝对路径（path.join 拼出来的，已规整）
 * @param {string} [appDataDir] 应用数据目录（dataPath("data")），带不带结尾斜杠都行
 * @returns {boolean}
 */
function skipEntry(name, fullPath, appDataDir) {
  if (name.startsWith(".") || SKIP_NAMES.has(name)) return true;
  if (!appDataDir) return false;
  const a = appDataDir.endsWith(path.sep) ? appDataDir : appDataDir + path.sep;
  return fullPath + path.sep === a;
}

/**
 * @param {string} msg 给人看的一句话
 * @param {number} status 路由照这个回 HTTP 状态码
 */
function fail(msg, status) {
  return Object.assign(new Error(msg), { status });
}

/**
 * 把前端传来的相对路径切成段。绝对路径、..、空字符一律拒——
 * 这一步不「帮着修」：把 ../x 默默当成 x，人看到的是另一个目录，还以为自己点对了。
 * 反斜杠和盘符只在 Windows 上算路径：macOS/Linux 上 a\b 是一个文件夹的名字，
 * 在那边也拆开的话，listDir 自己发出去的路径送回来就对不上——要么 404 退回根，要么列成另一个 a/b。
 * @param {unknown} rel
 * @returns {string[]}
 */
function relSegments(rel) {
  const win = process.platform === "win32"; // 每次现读：测试要能在 macOS 上把 Windows 那条路也走一遍
  const raw = String(rel == null ? "" : rel);
  const s = win ? raw.replace(/\\/g, "/") : raw;
  if (s.includes("\0")) throw fail("路径里有非法字符", 400);
  if (s.startsWith("/") || (win && /^[a-zA-Z]:/.test(s))) throw fail("只能看工作区里面的文件夹", 400);
  const segs = s.split("/").filter((x) => x && x !== ".");
  if (segs.includes("..")) throw fail("只能看工作区里面的文件夹", 400);
  return segs;
}

/** 名字排序：数字按大小比（第 2 集排在第 10 集前面），跟访达一样 */
const byName = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" }).compare;
/** ISO 时间串直接比字面，比 localeCompare 快一个数量级（两万条排序时差得出来） */
const newestFirst = (/** @type {{mtime:string}} */ a, /** @type {{mtime:string}} */ b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0);

/**
 * 一个目录里「看得见的」有几项（给文件夹行上的「N 项」用）。跟 listDir 同一套规矩数，
 * 不然点进去看到的条数跟外面写的对不上。
 * @param {string} dir
 * @param {string} appDataDir
 */
function visibleCount(dir, appDataDir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if ((e.isDirectory() || e.isFile()) && !skipEntry(e.name, path.join(dir, e.name), appDataDir)) n++;
    }
  } catch {}
  return n;
}

/**
 * 列工作区里的一层，像访达那样：文件夹在前（按名字），文件在后（新的在前）。
 *
 * 越界的三条路都在这儿堵：.. 和绝对路径在切段时拒；路上任何一段是链接就拒（不跟链接，
 * 哪怕它指向工作区里面——指向里面的那份从正路也走得到）；最后再拿 realpath 对一次根，
 * 防的是根本身挂在链接底下（/tmp → /private/tmp）时前两道比不出来的情况。
 *
 * 一层超过 cap 条就截，截的时候文件夹优先（文件夹是往下走的路，丢了就真到不了了），
 * 文件留最新的；total 永远是真实条数，truncated 照实说。截掉的那些拿 offset 往后翻得到——
 * 搜索走的是 walkAll，撞了 WALK_CAP 就搜不全，所以「翻页」是一层里每个文件都够得着的那条路。
 * @param {string} root 工作区根（绝对路径）
 * @param {unknown} rel 相对路径，"" 是根
 * @param {ListOpts} [opts]
 * @returns {Listing}
 */
function listDir(root, rel, opts) {
  const o = opts || {};
  const cap = o.cap && o.cap > 0 ? Math.floor(o.cap) : LIST_CAP;
  const appDataDir = o.appDataDir || "";
  const base = path.resolve(root);
  const segs = relSegments(rel);
  let cur = base;
  for (const seg of segs) {
    const next = path.join(cur, seg);
    if (skipEntry(seg, next, appDataDir)) throw fail("这个文件夹不在资料库里显示", 400);
    let st;
    try { st = fs.lstatSync(next); } catch { throw fail("这个文件夹已经不在了", 404); }
    if (st.isSymbolicLink()) throw fail("这是一个链接，资料库不跟进去", 400);
    if (!st.isDirectory()) throw fail("这不是文件夹", 400);
    cur = next;
  }
  if (segs.length) {
    let realBase = base, realCur = cur;
    try { realBase = fs.realpathSync(base); realCur = fs.realpathSync(cur); } catch { throw fail("这个文件夹已经不在了", 404); }
    if (realCur !== realBase && !realCur.startsWith(realBase + path.sep)) throw fail("只能看工作区里面的文件夹", 400);
  }
  /** @type {fs.Dirent[]} */
  let entries = [];
  try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch {
    // 根还没建出来（新项目一个文件都没写过）是正常的空，不是错
    if (segs.length) throw fail("读不了这个文件夹", 404);
  }
  /** @type {string[]} */
  const dirNames = [];
  /** @type {string[]} */
  const fileNames = [];
  for (const e of entries) {
    if (skipEntry(e.name, path.join(cur, e.name), appDataDir)) continue;
    if (e.isDirectory()) dirNames.push(e.name);
    else if (e.isFile()) fileNames.push(e.name);
  }
  const total = dirNames.length + fileNames.length;
  const prefix = segs.length ? segs.join("/") + "/" : "";
  dirNames.sort(byName);
  // 一页 cap 条，按 offset 往后翻：文件夹在前、文件在后排成一列，第几页就切第几截。
  // 超出末页的 offset 退回末页开头（那一层刚被删掉一批时，别翻到一张空页上）
  let offset = Math.max(0, Math.floor(Number(o.offset)) || 0);
  if (offset >= total) offset = total ? Math.floor((total - 1) / cap) * cap : 0;
  /** @type {DirRow[]} */
  const dirs = dirNames.slice(offset, offset + cap).map((name) => {
    const full = path.join(cur, name);
    let mtime = "";
    try { mtime = fs.lstatSync(full).mtime.toISOString(); } catch {}
    return { name, path: prefix + name, count: visibleCount(full, appDataDir), mtime };
  });
  const fStart = Math.max(0, offset - dirNames.length);
  const room = Math.max(0, cap - dirs.length);
  // 多到 stat 不过来的那种目录，就不排新旧了：按名字排，只 stat 这一页那一截——
  // 不能让一次点击卡住整个服务一两秒；by_name 照实告诉界面「这层文件是按名字排的」
  const byNameOnly = fileNames.length > STAT_CAP;
  /** @type {FileRow[]} */
  const all = [];
  if (room) {
    const toStat = byNameOnly ? fileNames.sort(byName).slice(fStart, fStart + room) : fileNames;
    for (const name of toStat) {
      const st = fs.statSync(path.join(cur, name), { throwIfNoEntry: false });
      if (!st) continue;
      all.push({ name: prefix + name, base: name, size: st.size, mtime: st.mtime.toISOString() });
    }
    if (!byNameOnly) all.sort(newestFirst);
  }
  const files = byNameOnly ? all : all.slice(fStart, fStart + room);
  return {
    dir: segs.join("/"),
    crumbs: segs.map((name, i) => ({ name, path: segs.slice(0, i + 1).join("/") })),
    dirs,
    files,
    total,
    truncated: dirs.length + files.length < total,
    offset,
    cap,
    by_name: byNameOnly,
    dirs_cut: dirs.length < dirNames.length,
  };
}

/**
 * 把工作区从头到尾走一遍，回所有看得见的文件（相对路径、体积、修改时间），新的在前。
 *
 * 按层走（广度优先）而不是一条道走到黑：真撞上上限时，留下来的是浅层那些——
 * 人更可能认得出、也更可能要找的那部分。深度和条数任何一个撞线，capped 都是 true：
 * 「按任务」那边的「未归属」总数要照这个说是不是全的。
 * @param {string} root
 * @param {WalkOpts} [opts]
 * @returns {WalkResult}
 */
function walkAll(root, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth && o.maxDepth > 0 ? Math.floor(o.maxDepth) : WALK_DEPTH;
  const cap = o.cap && o.cap > 0 ? Math.floor(o.cap) : WALK_CAP;
  const appDataDir = o.appDataDir || "";
  /** @type {WalkFile[]} */
  const files = [];
  let capped = false;
  /** @type {{ dir: string, rel: string, depth: number }[]} */
  const queue = [{ dir: path.resolve(root), rel: "", depth: 1 }];
  outer: for (let i = 0; i < queue.length; i++) {
    const { dir, rel, depth } = queue[i];
    /** @type {fs.Dirent[]} */
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (skipEntry(e.name, full, appDataDir)) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (depth >= maxDepth) { capped = true; continue; }
        queue.push({ dir: full, rel: r, depth: depth + 1 });
      } else if (e.isFile()) {
        if (files.length >= cap) { capped = true; break outer; }
        const st = fs.statSync(full, { throwIfNoEntry: false });
        if (!st) continue;
        files.push({ name: r, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  }
  files.sort(newestFirst);
  return Object.freeze({ files: Object.freeze(files), capped });
}

/**
 * 几秒钟的记忆。资料库一次重画会并发打好几条接口，搜索框每敲一个字又是一轮，
 * 每条都从头走一遍工作区是白干活；而几秒之内工作区里多出来/少掉的那一两个文件，
 * 下一次重画就对上了。按键区分（键里带着工作区根），切项目、切组织各算各的。
 * @template T
 * @param {number} ttlMs
 * @param {() => number} [now] 测试里换成假钟
 */
function createMemo(ttlMs, now) {
  const clock = now || Date.now;
  /** @type {Map<string, { at: number, v: T }>} */
  const m = new Map();
  return {
    /**
     * @param {string} key
     * @param {() => T} fn
     * @returns {T}
     */
    get(key, fn) {
      const t = clock();
      const hit = m.get(key);
      if (hit && t - hit.at < ttlMs) return hit.v;
      // 过期的顺手清掉：多组织的服务器上，键的个数跟组织数一样多，不清会一直攒着
      for (const [k, x] of m) if (t - x.at >= ttlMs) m.delete(k);
      const v = fn();
      m.set(key, { at: t, v });
      return v;
    },
    clear() { m.clear(); },
    size() { return m.size; },
  };
}

/** @type {{ get(key: string, fn: () => WalkResult): WalkResult, clear(): void, size(): number }} */
const walkMemo = createMemo(3000);

/**
 * walkAll 加上几秒记忆。回来的东西是冻住的，调用方拿去 filter/slice 可以，原地 sort 会直接抛——
 * 这是故意的：同一份结果几条请求共用，谁原地改了都会串到别人那里去。
 * @param {string} root
 * @param {WalkOpts} [opts]
 * @returns {WalkResult}
 */
function walkAllCached(root, opts) {
  const o = opts || {};
  const key = [path.resolve(root), o.appDataDir || "", o.maxDepth || WALK_DEPTH, o.cap || WALK_CAP].join("\n");
  return walkMemo.get(key, () => walkAll(root, o));
}

module.exports = { SKIP_NAMES, LIST_CAP, WALK_CAP, WALK_DEPTH, STAT_CAP, skipEntry, relSegments, listDir, walkAll, walkAllCached, createMemo, walkMemo };
