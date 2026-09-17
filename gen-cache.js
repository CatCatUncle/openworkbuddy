"use strict";
/**
 * 生成结果缓存 —— 同一格重跑，别再烧第二次钱。
 *
 * 为什么要有它：生图、生视频、配音是这个 agent 里唯三**每调一次就真扣一次费**的工具。
 * 一集十二镜的短剧，中间任何一步失败（拼片缺 ffmpeg、步数撞上限、用户中途改了一句台词），
 * 常见的做法是把整条任务重跑一遍——前面十一镜的图和配音于是又买了一遍，而它们跟上一次
 * 逐字节一样。真实会话里这一幕出现过不止一次，用户看到的只是「怎么又等这么久」，
 * 账单上看到的才是重复的那几块钱。
 *
 * 口径：**内容寻址**。key 由「哪个工具 + 这次的全部参数 + 真正解析出来的模型和接口 +
 * 产物落在哪个对话目录 + 哪个工作空间」算出来。参数里凡是指向工作空间文件的（参考图、
 * 首尾帧），算的是**文件内容的哈希**而不是路径——用户把参考图重画了一版还叫原来的名字，
 * 那是另一件事，必须重出，不能拿旧的冒充。
 *
 * 三条边界，都是故意画的：
 *
 * 1. **只缓存点了名的那一格**（input.filename 有值）。点了名 = 「我要的就是这一格」，
 *    重跑它当然该拿回同一样东西；没点名 = 「再给我一个」，生图本来就没有 seed，
 *    同样的描述出来的图本来就该每次不一样。不分这一刀，「生成三张不同的封面」
 *    这种连着三次一模一样的调用会拿回同一张图，而且不留痕迹。
 *
 * 2. **no_cache: true 是硬旁路**。模型和用户都得有一条「我就是要重出一份」的路，
 *    否则缓存会把「换一版试试」这条正当需求堵死。命中时的回执里也把这句话写进去，
 *    省得模型自己去猜怎么绕开。
 *
 * 3. **只记指针，不搬字节**。索引里存的是工作空间内的相对路径，不是文件本身——
 *    一段 30 秒的视频十几兆，复制一份进 data/ 等于为了省钱先多占一倍磁盘。
 *    代价是指针会悬空（用户把产物删了），所以每次命中都先看文件还在不在，
 *    不在就把这条删掉、当作没命中——绝不返回一个指向空气的路径。
 *
 * 索引是明文 JSON，所以里面**一个字节的 api_key 都不能有**：接口只记 host + path。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { dataPath } = require("./paths");
const store = require("./store");

const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data");
const FILE = path.join(DATA_DIR, "gen-cache.json");

/** 索引上限。超了按「最近用过」淘汰——指针很小，几百条也就几十 KB */
const MAX_ENTRIES = 500;

/** 这两个字段只决定「要不要走缓存」，不影响生成出来的东西本身，不进 key */
const IGNORE = new Set(["no_cache"]);

/**
 * 值是工作空间文件路径的字段：要按内容算，不按路径算。
 * 漏登记一个字段的后果是「图换了、key 没变」——拿旧图冒充新图，而且不报错。
 */
const FILE_FIELDS = {
  generate_image: ["reference_images"],
  generate_video: ["first_frame", "last_frame"],
};

/** 命中时补在回执后面的一句。必须说清两件事：这次没花钱、怎么强制重出 */
const HIT_NOTE =
  "\n（这一次没有再调模型：参数跟上一次逐字一样，直接复用了上次的产物，这一格的钱只花过一次。" +
  "确实要重出一份不一样的，这个工具加一个参数 no_cache: true。）";

/** 接口地址只留 host + path。索引是明文的，api_key 一个字节都不能进来 */
function endpointOf(u) {
  const s = String(u || "").trim();
  try {
    const x = new URL(s);
    return x.host + x.pathname.replace(/\/+$/, "");
  } catch {
    return s.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
  }
}

/**
 * 一个文件参数算成一段指纹。
 * 读不到就退回「路径原文 + 读不到」这个标记——这一趟本来就会在真正的工具里报错，
 * 这里不抢着替它报，但也绝不能让两个都读不到的不同文件算出同一个 key。
 */
function fileFingerprint(rel, resolveFile) {
  const s = String(rel == null ? "" : rel);
  try {
    const buf = fs.readFileSync(resolveFile(s));
    return "h:" + crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
  } catch {
    return "x:" + s;
  }
}

/**
 * 算 key。不该缓存的情况一律返回 null，调用方见 null 就当没有缓存这回事。
 *
 * @param {string}   kind        工具名（generate_image / generate_video / text_to_speech）
 * @param {object}   input       这次调用的全部参数
 * @param {object}   cfg         mediaModels.pick 解析出来的渠道（要 model 和 base_url）
 * @param {string}   dir         产物落点（本对话的成果子目录）
 * @param {function} resolveFile 相对路径 → 绝对路径（安全策略解析器）
 * @param {string}   wsRoot      当前工作空间根
 */
function key(kind, input, cfg, dir, resolveFile, wsRoot) {
  const inp = input || {};
  if (inp.no_cache) return null;
  // 只认点了名的那一格，理由见文件顶上第 1 条
  if (!String(inp.filename || "").trim()) return null;
  if (!cfg || !cfg.model || !cfg.base_url) return null;

  const fileFields = FILE_FIELDS[kind] || [];
  const norm = {};
  for (const k of Object.keys(inp).sort()) {
    if (IGNORE.has(k)) continue;
    const v = inp[k];
    if (fileFields.includes(k)) {
      const list = v == null || v === "" ? [] : Array.isArray(v) ? v : [v];
      norm[k] = list.map((rel) => fileFingerprint(rel, resolveFile));
    } else {
      norm[k] = v;
    }
  }
  let rel = ".";
  try {
    rel = path.relative(wsRoot, dir) || ".";
  } catch {}
  const payload = JSON.stringify({
    kind,
    input: norm,
    model: cfg.model,
    endpoint: endpointOf(cfg.base_url),
    dir: rel,
    // 多租户下不同公司各有各的工作空间，key 不带它就会跨租户命中——那是数据串门，不是省钱
    ws: crypto.createHash("sha1").update(String(wsRoot || "")).digest("hex").slice(0, 8),
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function load() {
  try {
    const db = store.readJson(FILE, null);
    if (db && db.items && typeof db.items === "object") return db;
  } catch (e) {
    console.warn("[gen-cache] 索引读不了，这一轮当作没有缓存：" + e.message);
  }
  return { v: 1, items: {} };
}

function save(db) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    store.writeJsonAtomic(FILE, db);
  } catch (e) {
    // 写不进去只是省不了钱，不该把一次成功的生成拖成失败。但必须留一行，
    // 不然「缓存怎么一直不命中」会变成一个查不出原因的问题。
    console.warn("[gen-cache] 索引写不进去，这次的产物没记进缓存：" + e.message);
  }
}

/** 超量按「最近用过」淘汰：最久没被命中的先走 */
function prune(db) {
  const ids = Object.keys(db.items);
  if (ids.length <= MAX_ENTRIES) return;
  ids
    .sort((a, b) => (db.items[b].last || 0) - (db.items[a].last || 0))
    .slice(MAX_ENTRIES)
    .forEach((id) => delete db.items[id]);
}

/**
 * 查缓存。命中返回一个跟工具成功时同形状的结果（多一个 cached: true），没命中返回 null。
 * 指针悬空（产物被删了）当没命中，并把这条清掉——绝不返回一个指向空气的路径。
 */
function get(k, wsRoot) {
  if (!k) return null;
  const db = load();
  const e = db.items[k];
  if (!e || !e.file) return null;
  let abs;
  try {
    abs = path.join(wsRoot, e.file);
  } catch {
    return null;
  }
  if (!fs.existsSync(abs)) {
    delete db.items[k];
    save(db);
    return null;
  }
  e.hits = (e.hits || 0) + 1;
  e.last = Date.now();
  save(db);
  return { content: String(e.content || "") + HIT_NOTE, isError: false, file: path.basename(e.file), cached: true };
}

/**
 * 记一条。只记成功的、只记产物真落在工作空间里的。
 * out.file 是工具报出来的产物文件名——没有它就没法记指针，静默跳过（这不是错，
 * html_to_image 这类本来就不进缓存）。
 */
function put(k, out, dir, wsRoot, model) {
  if (!k || !out || out.isError || !out.file) return;
  let rel;
  try {
    rel = path.relative(wsRoot, path.join(dir || wsRoot, out.file));
  } catch {
    return;
  }
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return; // 落在工作空间外面就不记：指针会指到外面去
  const db = load();
  db.items[k] = {
    file: rel.split(path.sep).join("/"),
    content: String(out.content || ""),
    model: String(model || ""),
    at: Date.now(),
    last: Date.now(),
    hits: 0,
  };
  prune(db);
  save(db);
}

/** 统计：设置页要拿它告诉用户「这份缓存替你省了多少次调用」 */
function stats() {
  const db = load();
  const items = Object.values(db.items);
  return { entries: items.length, hits: items.reduce((n, e) => n + (e.hits || 0), 0) };
}

/** 清空。产物文件一个都不动——那是用户的东西，缓存只是一张索引 */
function clear() {
  save({ v: 1, items: {} });
}

module.exports = { key, get, put, stats, clear, endpointOf, FILE, MAX_ENTRIES, HIT_NOTE };
