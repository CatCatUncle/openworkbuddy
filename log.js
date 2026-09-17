"use strict";
/**
 * 运行期日志：一行一条 JSON，落 `logs/app-<年-月-日>.jsonl`。
 *
 * 为什么要有这个东西——在它之前，这个项目的 `logs/` 目录里只有一个 `boot.log`，
 * 记的是**启动那几秒**的事。启动之后发生了什么，全在内存里和 trace 里：
 *
 *   · trace 是给「看某一趟任务的调用树」用的，默认还是关着的，而且只在工作空间里；
 *   · console.log 打到终端，桌面用户根本看不到终端，关掉窗口就没了。
 *
 * 于是「昨天下午它卡了一下」这种话，除了让用户复现一遍，没有别的查法。
 *
 * 三条自我约束，跟 trace.js 那三条一个道理：
 *   1. **日志不能把程序搞挂。** 所有写盘都在 try 里，写不进去就算了，绝不上抛。
 *   2. **不在热路径上做重活。** 一条就是一次 appendFileSync，不读旧文件、不 JSON.parse、
 *      不算目录大小。按天换文件是靠比较日期字符串，比对上了才去碰磁盘。
 *   3. **不悄悄把盘写满。** 这是桌面软件最常见的死法。保留 14 天（KEEP_DAYS），过期文件在换天
 *      那一下顺手删掉——一天只做一次，不是每写一条都去扫目录。
 *
 * 跟 audit.json 的分工：audit 记的是「安全决定」（这条命令放行还是拦下），是给人复核的，
 * 有界面、有导出、环形 1000 条；这里记的是「程序自己干了什么」，是给排查用的，按天滚。
 * 两件事混在一个文件里，结果是两边都不好用。
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");

const DIR = process.env.OPENWORKBUDDY_LOG_DIR || dataPath("logs");
const KEEP_DAYS = 14;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// 默认不记 debug：它的量级比其它三种加起来还大，而且 99% 的时间没人看
let minLevel = LEVELS[String(process.env.OPENWORKBUDDY_LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;

function today() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
function fileOf(day) {
  return path.join(DIR, `app-${day}.jsonl`);
}

let curDay = "";
/**
 * 日志目录，0700 建、0700 收。
 *
 * 这里躺的不是「程序自言自语」：一行一条 JSON，带着谁在什么时候登录了、会话 id、
 * 报错原文和出错时那几个参数。默认权限 0755 的话，同一台 VPS / 同一台办公电脑上
 * 任何一个别的本地账号，`cat` 一下就是一份「谁在干什么」的流水，而且这事不留痕迹。
 * 收在这儿而不是 server.js 的开机那一段：写日志的不止服务端，CLI 和桌面壳也写，
 * 而这一处是**目录唯一的出生地**。一天只走一次（换天那下），不在热路径上。
 * mkdir 的 mode 只对新建的生效，所以老目录还要补一次 chmod；照例失败就算了
 * （Windows 上 chmod 基本是空操作，容器挂载卷也可能不让改）。
 */
function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DIR, 0o700); } catch {}
}
/** 过期的日志文件删掉。**只在换天的那一次调用**，不是每条日志都扫一遍目录 */
function pruneOld() {
  try {
    const keep = new Set();
    for (let i = 0; i < KEEP_DAYS; i++) {
      const d = new Date(Date.now() - i * 86400 * 1000);
      keep.add(`app-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.jsonl`);
    }
    for (const f of fs.readdirSync(DIR)) {
      if (/^app-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && !keep.has(f)) {
        try { fs.rmSync(path.join(DIR, f), { force: true }); } catch {}
      }
    }
  } catch {}
}

/**
 * 记一条。
 * @param level  debug | info | warn | error
 * @param mod    哪个模块写的（"chat" / "im" / "scheduler" …），排查时第一个用来过滤的字段
 * @param msg    一句人话。**别把变量拼进来**，拼进来就没法按 msg 聚合了，放 fields 里
 * @param fields 结构化字段：task_id / user / ms / err / … 想加什么加什么
 */
function log(level, mod, msg, fields) {
  const lv = LEVELS[level] || LEVELS.info;
  if (lv < minLevel) return;
  // 出错和警告照旧打到终端：开发时盯着终端的人不该因为「现在有日志文件了」反而看不见了
  if (lv >= LEVELS.warn) {
    try { (lv >= LEVELS.error ? console.error : console.warn)(`[${mod}] ${msg}`, fields && fields.err ? String(fields.err) : ""); } catch {}
  }
  try {
    const day = today();
    if (day !== curDay) { curDay = day; ensureDir(); pruneOld(); }
    const row = { ts: new Date().toISOString(), level, mod: mod || "app", msg: String(msg || "") };
    if (fields) for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      // 一条日志再重要也不值得写进去 200 KB。截断比「日志把盘写满」强
      row[k] = typeof v === "string" ? v.slice(0, 2000) : v instanceof Error ? String(v.message || v).slice(0, 2000) : v;
    }
    fs.appendFileSync(fileOf(day), JSON.stringify(row) + "\n", "utf8");
  } catch {
    // 写日志失败本身不值得再写一条日志（而且多半也写不进去）
  }
}

const debug = (mod, msg, f) => log("debug", mod, msg, f);
const info = (mod, msg, f) => log("info", mod, msg, f);
const warn = (mod, msg, f) => log("warn", mod, msg, f);
const error = (mod, msg, f) => log("error", mod, msg, f);

/**
 * 读最近的日志，**新的在前**。给「设置 → 系统日志」和排查用。
 * @param day    哪一天，默认今天
 * @param level  只看这个级别**及以上**
 * @param q      关键词（在 msg / mod / 各字段里找）
 */
function tail({ day = "", level = "", q = "", limit = 200 } = {}) {
  const want = LEVELS[String(level).toLowerCase()] || 0;
  const needle = String(q || "").trim().toLowerCase();
  let raw = "";
  try { raw = fs.readFileSync(fileOf(day || today()), "utf8"); } catch { return []; }
  const out = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }   // 断电留下的半行，跳过就是了
    if (!row || typeof row !== "object") continue;
    if (want && (LEVELS[row.level] || 0) < want) continue;
    if (needle && !JSON.stringify(row).toLowerCase().includes(needle)) continue;
    out.push(row);
  }
  return out;
}

/** 有哪几天的日志，新的在前。给日期下拉框用 */
function days() {
  try {
    return fs.readdirSync(DIR)
      .filter((f) => /^app-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(4, 14)).sort().reverse();
  } catch { return []; }
}

function setLevel(name) {
  const lv = LEVELS[String(name || "").toLowerCase()];
  if (lv) minLevel = lv;
  return Object.keys(LEVELS).find((k) => LEVELS[k] === minLevel);
}

module.exports = { log, debug, info, warn, error, tail, days, setLevel, _internals: { DIR, fileOf, today, pruneOld, LEVELS, KEEP_DAYS } };
