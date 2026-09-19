"use strict";
/**
 * 清中间物 —— 一次任务跑完，盘上留下的东西里哪些是成品、哪些只是路上的脚手架。
 *
 * 为什么要有这个文件：
 *
 * 2026-09-18 用户翻自己的机器，发现这个仓库涨到了 4.3 GB。逐项看下去，真正的成果只占一小截：
 *
 *   · 一次做竖屏动画的任务，留了 373 MB 的逐帧 PNG —— 成片 mp4 早在同一个文件夹里躺着；
 *   · 一次拆音轨的任务，留了 81 MB 的 demucs wav —— 转好的两条 mp3 就在上一层；
 *   · 一次做 iOS demo 的任务，留了 119 MB 的 Xcode build —— .xcodeproj 还在，随时能重编；
 *   · 一次抓小红书的任务，留了 234 张抽帧图、两个装着 cookie 的 ck.db、八个空的 .err。
 *
 * 三条贯穿全文件的原则：
 *
 * ① **先证明成品在手上，再提议删过程。**
 *    「逐帧 PNG 是中间物」这句话只在成片真的出来了的时候才成立。渲染半截被掐断的任务，
 *    那批 PNG 就是这次任务仅剩的东西。所以每一条规则都带一个前提，前提不成立就整条不提。
 *
 * ② **只提议，不自作主张。** 这个模块算出一张清单交给界面，删不删是用户点的。
 *    每一组都写明「为什么认为它是中间物」，用户得能在点头之前判断我是不是看错了。
 *
 * ③ **删就是真删。** 不挪进 .trash —— 用户要的是腾出空间，挪一下照样占着地方。
 *    正因为是真删，才有前面两条兜着。
 *
 * 为什么不复用 tools.js 的 outputFiles()：它按 mtime 倒序只取最新 500 条、最深只走 3 层。
 * 而上面四宗里，anim/frames/ 在第 4 层、separated/htdemucs/full_audio/ 在第 5 层——
 * 最占地方的那两块，产品原来根本看不见。这里自己走一遍，深度和条数都另设闸门。
 */

const fs = require("fs");
const path = require("path");

/** 走多深、看多少个文件。比 outputFiles() 放得开，但不是不设防 */
const MAX_DEPTH = 8;
const MAX_FILES = 40000;

/** 编译/依赖目录：名字本身就说明了它是产物，不用进去看 */
const BUILD_DIRS = new Set([
  "build", "dist", "out", "target", ".next", ".nuxt", ".parcel-cache", ".turbo",
  "node_modules", "__pycache__", ".venv", "venv", "DerivedData", ".gradle", "Pods",
]);
/** 音轨分离工具的输出目录 */
const STEM_DIRS = new Set(["separated", "stems", "htdemucs", "htdemucs_ft", "demucs", "mdx", "mdx_extra", "uvr"]);
/** 连号图：前缀 + 至少两位数字 + 图片后缀。frame_001.jpg / s_129.jpg / 镜头12.png 都算 */
const SEQ_RE = /^(.*?)(\d{2,6})\.(jpe?g|png|webp|bmp)$/i;
/** 一个目录里连号图占到这么多张、且占了这么大比例，才当它是抽帧目录 */
const SEQ_MIN = 20;
const SEQ_RATIO = 0.8;
/** 成品的样子：有这些东西在，才说得上「过程可以扔了」 */
const VIDEO_RE = /\.(mp4|mov|webm|m4v|mkv|ogv)$/i;
const AUDIO_RE = /\.(mp3|m4a|aac|ogg|opus)$/i;
const DOC_RE = /\.(md|markdown|docx?|pptx?|xlsx?|pdf|csv|html?|json|srt|vtt)$/i;
/** 这些名字一律不碰：一眼就是成品，哪怕它恰好长得像中间物 */
const KEEP_NAME_RE = /(封面|成片|终稿|定稿|final|cover|poster|thumbnail|readme)/i;
/** 过程脚本 */
const SCRIPT_RE = /\.(js|mjs|cjs|ts|py|sh|bash|rb)$/i;

/** 浏览器/工具随手落下的临时库。只认这几个名字——用户真交付一个 .db 是可能的，别一锅端 */
const SCRATCH_DB_RE = /^(ck|cookie|cookies|cache|tmp|temp|session)\.(db|sqlite3?)$/i;
const SCRATCH_SIDECAR_RE = /\.(db-journal|db-wal|db-shm|sqlite-journal)$/i;

function isHidden(name) { return name.startsWith("."); }

/**
 * 这个目录看着像个做好的站点吗（有 index.html）。像的话里头的小网页是页面，不是抓取残渣。
 * 真事故：一个静态站的 dist_xinjiang/404.html 才 1125 字节，差点被当成「跳转页」提议删掉。
 */
function siteish(d) { return d.files.some((f) => /^index\.html?$/i.test(f.name)); }
/**
 * 它是不是「一套东西里的一个」。card_01.html…card_07.html 是七张成品卡，
 * 单看 card_07 只有 1721 字节，看一眼兄弟就知道它不是残渣。
 */
function partOfSet(d, f) {
  const stem = f.name.replace(/[-_]?\d+\.html?$/i, "");
  if (stem === f.name) return false;
  let n = 0;
  for (const o of d.files) if (/\.html?$/i.test(o.name) && o.name.startsWith(stem)) n++;
  return n >= 3;
}

/**
 * 一个目录有多大。只用来给「整个目录一起删」的那几条报体积，所以给了预算：
 * node_modules 动辄十万个文件，为了显示一个数字把事件循环卡死不值得。
 * 预算用完就如实标 capped，界面显示「至少 xx」而不是假装数准了。
 */
function dirSize(abs, budget = 60000) {
  let count = 0, bytes = 0, capped = false;
  (function walk(d, depth) {
    if (capped || depth > MAX_DEPTH) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (budget-- <= 0) { capped = true; return; }
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      count++; bytes += st.size;
    }
  })(abs, 1);
  return { count, bytes, capped };
}

/**
 * 走一遍工作区。返回的是「按目录整理好的」样子，因为绝大多数判断都是目录级的：
 * 一个目录里躺着 129 张连号图，这件事看单个文件是看不出来的。
 *
 * 点开头的目录整个跳过：.trash 是回收站、.openworkbuddy 是追踪账本和画布状态，
 * 都不是用户的成果，也都不该被这个按钮碰。
 */
function scan(root) {
  const dirs = new Map();   // rel -> { files:[{name,rel,size,mtime}], subdirs:[rel] }
  let total = 0, capped = false;
  const get = (rel) => {
    if (!dirs.has(rel)) dirs.set(rel, { rel, files: [], subdirs: [], build: null, stem: false });
    return dirs.get(rel);
  };
  get("");
  (function walk(abs, rel, depth) {
    if (capped || depth > MAX_DEPTH) return;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    const here = get(rel);
    for (const e of ents) {
      if (isHidden(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        here.subdirs.push(childRel);
        // 编译产物目录不进去走：名字已经说明一切，进去只会白烧几万次 stat
        if (BUILD_DIRS.has(e.name) && rel) { const d = get(childRel); d.build = e.name; continue; }
        if (STEM_DIRS.has(e.name)) get(childRel).stem = true;
        walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (total++ >= MAX_FILES) { capped = true; return; }
      let st; try { st = fs.statSync(childAbs); } catch { continue; }
      here.files.push({ name: e.name, rel: childRel, size: st.size, mtime: st.mtimeMs });
    }
  })(root, "", 1);
  return { dirs, capped };
}

/**
 * 这条**文件**路径属于哪个任务（工作区下的第一层目录）。工作区根上的散文件不属于任何任务，归 ""。
 *
 * 跟 taskOfDir 分成两个函数，是因为同一个字符串对文件和对目录含义不同：
 * 「任务_0918」当文件名看是根上的散文件（没有任务），当目录名看它自己就是那个任务。
 * 一开始只有一个 taskOf，目录也拿它算，于是任务目录一律算出 ""——「这个任务另有成品吗」
 * 永远问到了根目录头上，过程脚本那条规则写完之后一次都没触发过。哑火的规则比没有更糟：
 * 代码摆在那儿，读的人以为它在干活。
 */
function taskOf(rel) { const i = rel.indexOf("/"); return i < 0 ? "" : rel.slice(0, i); }
/** 这个**目录**属于哪个任务。目录自己就在第一层时，它就是那个任务 */
function taskOfDir(rel) { const i = rel.indexOf("/"); return i < 0 ? rel : rel.slice(0, i); }

/**
 * 一个任务手上有没有成品。这是所有「可以删过程」判断的前提，
 * 所以宁可判得保守：只要这个任务目录下（含子目录）有一个视频/音频/文档，就算有。
 */
function deliverablesOf(dirs) {
  const has = new Map(); // task -> { video, audio, doc, other }
  for (const d of dirs.values()) {
    for (const f of d.files) {
      const t = taskOf(f.rel);
      if (!has.has(t)) has.set(t, { video: 0, audio: 0, doc: 0, any: 0 });
      const h = has.get(t);
      h.any++;
      if (VIDEO_RE.test(f.name)) h.video++;
      else if (AUDIO_RE.test(f.name)) h.audio++;
      else if (DOC_RE.test(f.name)) h.doc++;
    }
  }
  return has;
}

/** 这个目录是不是「一屋子连号图」。是的话连带给出张数和共同前缀，好写理由 */
function seqDirInfo(d) {
  if (!d.files.length) return null;
  const byPrefix = new Map();
  for (const f of d.files) {
    const m = SEQ_RE.exec(f.name);
    if (!m) continue;
    const k = m[1] + "|" + m[3].toLowerCase();
    if (!byPrefix.has(k)) byPrefix.set(k, []);
    byPrefix.get(k).push(f);
  }
  let best = null;
  for (const [k, list] of byPrefix) if (!best || list.length > best.list.length) best = { k, list };
  if (!best || best.list.length < SEQ_MIN) return null;
  const seqCount = [...byPrefix.values()].reduce((n, l) => n + (l.length >= SEQ_MIN ? l.length : 0), 0);
  if (seqCount / d.files.length < SEQ_RATIO) return null;   // 半屋子是图半屋子是别的：那不是抽帧目录
  const files = [];
  for (const l of byPrefix.values()) if (l.length >= SEQ_MIN) files.push(...l);
  return { count: files.length, files, prefix: best.k.split("|")[0] || "连号" };
}

const GROUP_META = {
  frames: { label: "抽帧 / 逐帧图", on: true },
  stems:  { label: "分离出来的音轨", on: true },
  build:  { label: "编译产物", on: true },
  scratch:{ label: "零碎（cookie 库、空的错误输出）", on: true },
  script: { label: "过程脚本", on: false },
};

/**
 * 整个工作区的地盘账：每个任务占了多大。
 *
 * 跟 plan() 不是一回事——plan 回答「哪些能删」，这个回答「地方到底花在哪了」。
 * 两个都得给：用户点开「整理文件夹」，第一眼想看的往往不是我建议删什么，
 * 而是**谁把我的硬盘吃了**。有时候答案是一个早该自己删掉的旧任务，那不归规则管，
 * 但摆出来他一眼就认出来了。
 *
 * 复用 scan() 走过的那一遍，不另走一趟。编译产物目录 scan 不进去（名字已说明一切），
 * 所以这儿单独给它们补一次 dirSize——只有这么几个，不心疼。
 */
function usageOf(root, dirs) {
  const tasks = new Map();
  const hit = (name) => {
    if (!tasks.has(name)) tasks.set(name, { name, bytes: 0, count: 0, mtime: 0 });
    return tasks.get(name);
  };
  for (const d of dirs.values()) {
    if (d.build && d.rel) {
      const t = hit(taskOfDir(d.rel));
      const s = dirSize(path.join(root, d.rel));
      t.bytes += s.bytes; t.count += s.count;
      continue;
    }
    for (const f of d.files) {
      const t = hit(taskOf(f.rel));
      t.bytes += f.size; t.count += 1;
      if (f.mtime > t.mtime) t.mtime = f.mtime;
    }
  }
  const list = [...tasks.values()].sort((a, b) => b.bytes - a.bytes);
  return { bytes: list.reduce((n, t) => n + t.bytes, 0), count: list.reduce((n, t) => n + t.count, 0), tasks: list };
}

/**
 * 算出这次能清什么。
 *
 * @param root          工作区绝对路径
 * @param opts.task     只看这一个任务目录（资料库里按任务清的时候传）
 * @param opts.since    只看这个时刻之后动过的文件（一轮任务刚跑完时传，免得把三周前的旧任务一起端上来）
 * @param opts.usage    顺带把「每个任务占多大」一起算出来（面板要，收尾那一句不要）
 * @returns {{groups:Array, bytes:number, count:number, capped:boolean, usage?:object}}
 */
function plan(root, opts = {}) {
  const { dirs, capped } = scan(root);
  const has = deliverablesOf(dirs);
  const since = Number(opts.since) || 0;
  const inScope = (rel) => {
    if (opts.task && taskOf(rel) !== opts.task) return false;
    return true;
  };
  const fresh = (f) => !since || f.mtime >= since;
  const groups = new Map();
  const add = (key, item) => {
    if (!groups.has(key)) groups.set(key, { key, ...GROUP_META[key], items: [], bytes: 0, count: 0 });
    const g = groups.get(key);
    g.items.push(item); g.bytes += item.bytes; g.count += item.count;
  };
  const seqDirs = new Set();
  // 认领过的目录，底下的子目录不再单独算一遍。
  // 真事故：separated/ 和它里面的 htdemucs/ 都在 STEM_DIRS 里，同一批 wav 被报了两次，
  // 界面上「能省 20 MB」其实只有 10 MB——一个说大话的数字比不说更糟
  const claimed = [];
  const under = (rel) => claimed.some((c) => rel === c || rel.startsWith(c + "/"));

  for (const d of dirs.values()) {
    if (!d.rel || under(d.rel)) continue;
    const task = taskOfDir(d.rel);
    const h = has.get(task) || { video: 0, audio: 0, doc: 0, any: 0 };

    // ① 编译产物目录。前提：这个任务还有别的东西在——一个任务只产出一个 build/ 是不可能的，
    //    真出现了说明我理解错了这个目录是什么，那就别碰
    if (d.build && inScope(d.rel) && h.any > 0) {
      const s = dirSize(path.join(root, d.rel));
      if (s.count) add("build", {
        path: d.rel, count: s.count, bytes: s.bytes, capped: s.capped,
        why: `${d.build}/ 是编译产物，源码还在同一个任务里，随时能重新编出来`,
      });
      claimed.push(d.rel);
      continue;
    }

    // ② 抽帧目录。前提：这个任务手上有成片或成品音频——没有的话这批图就是这次任务仅剩的东西
    const seq = seqDirInfo(d);
    if (seq && inScope(d.rel)) {
      const wholeDir = seq.count === d.files.length && !d.subdirs.length;
      const usable = seq.files.filter(fresh);
      if ((h.video || h.audio) && usable.length >= SEQ_MIN) {
        seqDirs.add(d.rel);
        if (wholeDir) claimed.push(d.rel);
        const bytes = usable.reduce((n, f) => n + f.size, 0);
        add("frames", wholeDir && usable.length === d.files.length
          ? { path: d.rel, count: usable.length, bytes, why: `整个文件夹是 ${usable.length} 张连号图（${seq.prefix}…），这个任务的成片已经出来了` }
          : { paths: usable.map((f) => f.rel), path: d.rel + "/" + seq.prefix + "*", count: usable.length, bytes, why: `${usable.length} 张连号抽帧图，这个任务的成片已经出来了` });
      }
    }

    // ③ 分离出来的音轨。前提：转好的 mp3/m4a 已经在这个任务里了
    if (d.stem && inScope(d.rel) && h.audio) {
      const s = dirSize(path.join(root, d.rel));
      if (s.count) add("stems", {
        path: d.rel, count: s.count, bytes: s.bytes, capped: s.capped,
        why: "音轨分离工具的输出（wav 原始大小），这个任务里转好的 mp3 已经有了",
      });
      claimed.push(d.rel);
      continue;
    }

    if (seqDirs.has(d.rel)) continue;   // 抽帧目录里剩下的零碎不再单独挑

    // ④ 单个文件的零碎
    for (const f of d.files) {
      if (!inScope(f.rel) || !fresh(f) || KEEP_NAME_RE.test(f.name)) continue;
      let why = "";
      if (SCRATCH_DB_RE.test(f.name)) why = "浏览器/工具落下的临时库（里面常是 cookie，删掉顺带是件好事）";
      else if (SCRATCH_SIDECAR_RE.test(f.name)) why = "数据库的日志边车文件";
      else if (/\.err$/i.test(f.name)) why = "命令的错误输出";
      else if (/\.json$/i.test(f.name) && f.size <= 16) why = `只有 ${f.size} 字节的 json（空结果）`;
      else if (/\.html?$/i.test(f.name) && f.size <= 600 && !siteish(d) && !partOfSet(d, f)) why = `只有 ${f.size} 字节的网页（抓取时的跳转/报错页）`;
      else if (/\.(log|txt)$/i.test(f.name) && f.size === 0) why = "空文件";
      if (why) { add("scratch", { path: f.rel, count: 1, bytes: f.size, why }); continue; }

      // ⑤ 过程脚本。默认不勾——用户完全可能就是让我写个脚本给他。
      //    前提：这个任务另有成品，脚本不是这次唯一的交付
      // 只认**任务目录第一层**的脚本。真事故：一个任务的成果本来就是一棵 Python 源码树
      // （typeless/core/audio.py 那种），按「任务里另有成品」判，整棵源码树都被当成了脚手架
      // ——那是把交付物本身删掉。摊在任务根上的 cdp_read.js、get_cookie.js 才是随手写的。
      if (SCRIPT_RE.test(f.name) && task && f.rel.split("/").length === 2 && (h.video || h.audio || h.doc)) {
        add("script", { path: f.rel, count: 1, bytes: f.size, why: "任务目录里随手写的脚本；这个任务另有成品，所以它多半只是过程" });
      }
    }
  }

  const list = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  const bytes = list.filter((g) => g.on).reduce((n, g) => n + g.bytes, 0);
  const count = list.filter((g) => g.on).reduce((n, g) => n + g.count, 0);
  const out = { groups: list, bytes, count, capped };
  if (opts.usage) out.usage = usageOf(root, dirs);
  return out;
}

/**
 * 按清单删。
 *
 * 安全靠的是「不信任传进来的路径」：重新算一遍 plan，只有这次也算出来的路径才删。
 * 换句话说，就算有人构造一个请求说「删 ../../.ssh」，它也不在 plan 里，删不动。
 * 这比逐条写路径校验可靠——校验规则会漏，「必须是我自己刚算出来的」不会。
 */
function apply(root, paths, opts = {}) {
  const p = plan(root, opts);
  const allow = new Map();
  for (const g of p.groups) for (const it of g.items) {
    if (it.paths) for (const one of it.paths) allow.set(one, g.key);
    else allow.set(it.path, g.key);
  }
  const want = new Set((paths || []).map(String));
  const removed = [];
  let bytes = 0, skipped = 0;
  for (const rel of want) {
    if (!allow.has(rel)) { skipped++; continue; }
    const abs = path.resolve(root, rel);
    // 再把绝对路径对一遍：allow 里的键是我自己走出来的，理应安全，但这一步几乎不要钱
    if (abs !== path.join(root, rel.split("/").join(path.sep)) || !abs.startsWith(root + path.sep)) { skipped++; continue; }
    try {
      const st = fs.statSync(abs);
      const sz = st.isDirectory() ? dirSize(abs).bytes : st.size;
      fs.rmSync(abs, { recursive: true, force: true });
      removed.push(rel); bytes += sz;
    } catch { skipped++; }
  }
  return { removed, bytes, skipped };
}

module.exports = { plan, apply, scan, usageOf, dirSize, taskOf, taskOfDir, _internals: { SEQ_RE, SEQ_MIN, BUILD_DIRS, STEM_DIRS } };
