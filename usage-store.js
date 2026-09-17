"use strict";
/**
 * 用量流水账本：按月分片的 append-only JSONL。
 *
 * 换掉的是什么：原来整本账是一个 `data/usage.json`，**每记一笔都要把整本读出来、
 * unshift 一条、再整本写回去**，并且只留最新 2000 条。两个后果都是真的：
 *
 *   · 50 个人 × 每天 10 次 = 4 天就撞满 2000 条的顶。而后台「本月用量」「谁在用」
 *     两张图读的就是它——**月报会安静地少算，一个错都不报**。账对不上，还查不出为什么。
 *   · 写入耗时跟历史长度成正比。实测过：2000 条 612 KB 要 5.4ms，20000 条 6 MB 要 57ms，
 *     100000 条 30 MB 要 262ms。每一趟任务结束都付这笔钱，越用越慢。
 *
 * 现在的写法：一笔一行，`fs.appendFileSync` 直接追加到 `data/usage/2026-09.jsonl`。
 * **追加的耗时跟历史有多长完全无关**，一年也是这个速度。查「本月」只读一个分片；
 * 查区间只读跟区间重叠的那几片；要清理就删文件，不用重写。
 *
 * 为什么是「月」而不是「天」或者「年」：一年 12 个文件，`ls` 一眼看得完；
 * 按天是 365 个文件，查一个季度要开 90 个句柄；按年就退化回原来那个问题了。
 * 后台的时间筛选最细到天、最粗到「全部」，月分片两头都不吃亏。
 *
 * 不再封顶。封顶丢掉的是**计费和审计数据**——那正是最不该被悄悄丢掉的东西。
 * 一条流水 ~280 字节，50 个人一年不到 50 MB，留着没有任何压力。真要清，删月份文件。
 */

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./paths");

// 跟 account.js 用同一个口径，包括 OPENWORKBUDDY_DATA_DIR 这个测试专用的口子——
// 两边算出来的目录只要差一点，测试就会对着临时目录记账、对着真账本查数
const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data");

/**
 * 一本账 = 一个目录（月分片）+ 一个老文件（第一次用到时自动拆成分片）。
 *
 * 写成工厂而不是写死一本，是因为后来发现不只一本账有这个毛病：
 * quota.js 那本「按次计费」的流水（搜一次 / 生一张图 / 转一段音）当时还是
 * 「整本读出来 → unshift 一条 → 截到两万条 → 整本写回去」。而那本才是真正在给
 * 企业那把统一 Key 记账的那一本——最不该惄悉丢数据的恰恰是它。
 *
 * @param DIR     月分片放哪（目录，里头是 2026-09.jsonl 这样的文件）
 * @param LEGACY  改造前那个大 JSON 文件的路径。还在就拆成分片，拆完改名留着对账。
 */
function makeStore(DIR, LEGACY) {

  /** 一条流水属于哪一片。优先用 day（本地日期），老记录只有 ts 就从 ts 上截 */
  function shardOf(row) {
    const d = String((row && row.day) || (row && row.ts) || "").slice(0, 7);
    return /^\d{4}-\d{2}$/.test(d) ? d : nowShard();
  }
  function nowShard() {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
  }
  function fileOf(shard) {
    return path.join(DIR, shard + ".jsonl");
  }

  /** 盘上现有的分片，新的在前 */
  function shards() {
    try {
      return fs.readdirSync(DIR)
        .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
        .map((f) => f.slice(0, 7))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * 把老的 usage.json 拆成月分片。只在**第一次**用到账本时跑一次。
   *
   * 老文件不删、改名成 usage.json.migrated 留在原地：万一拆错了还能对账。
   * 已经迁过的机器上这个函数是一次 existsSync，没有额外代价。
   */
  function migrate() {
    if (!fs.existsSync(LEGACY)) return false;
    let rows = [];
    try {
      const d = JSON.parse(fs.readFileSync(LEGACY, "utf8"));
      // 两本账的老文件不是同一个形状：token 那本落的是裸数组，
      // quota 那本（api-usage.json）落的是 { usage: [...] }。只认数组的话，
      // 老用户升级上来会把整本账当成空的、再把源文件改名挡走——
      // 数据还在盘上，但后台那张「本月用量」当场归零。
      rows = Array.isArray(d) ? d : (d && Array.isArray(d.usage) ? d.usage : []);
    } catch {
      // 老文件坏了：改名挪开就是了，别让它每次启动都重试一遍，也别因此不让新账本开张
      try { fs.renameSync(LEGACY, LEGACY + ".broken"); } catch {}
      return false;
    }
    fs.mkdirSync(DIR, { recursive: true });
    // 老账本是「新的在前」，分片文件里我们统一存成「老的在前」（追加天然如此）
    const byShard = new Map();
    for (const r of rows.slice().reverse()) {
      const s = shardOf(r);
      if (!byShard.has(s)) byShard.set(s, []);
      byShard.get(s).push(r);
    }
    for (const [s, list] of byShard) {
      // 追加而不是覆盖：万一这台机器上新账本已经开了张，别把新记的那几条盖掉
      fs.appendFileSync(fileOf(s), list.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    }
    try { fs.renameSync(LEGACY, LEGACY + ".migrated"); } catch {}
    return true;
  }

  let migrated = false;
  function ensure() {
    if (!migrated) { migrated = true; try { migrate(); } catch {} }
    fs.mkdirSync(DIR, { recursive: true });
  }

  /** 记一笔。这是热路径上唯一会碰盘的动作，必须是 O(1) */
  function append(row) {
    ensure();
    fs.appendFileSync(fileOf(shardOf(row)), JSON.stringify(row) + "\n", "utf8");
  }

  /** 读一片，返回**老的在前**（跟文件里的顺序一致） */
  function readShard(shard) {
    let raw;
    try { raw = fs.readFileSync(fileOf(shard), "utf8"); } catch { return []; }
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      // 断电断在一行中间会留下半行。跳过它，别因为一行坏了就把整个月的账当成没有——
      // 这正是 JSONL 相对于「一个大 JSON」最实在的好处
      try { const o = JSON.parse(line); if (o && typeof o === "object") out.push(o); } catch {}
    }
    return out;
  }

  /**
   * 读流水，**新的在前**（跟老的 loadUsage() 口径一致，调用方不用改）。
   *
   * @param from/to  YYYY-MM-DD。给了就只读跟这个区间重叠的分片——
   *                 查「本月」时，历史有多少年都不影响这一次读多少。
   * @param limit    只要最近这么多条时给它，够数就不再往老分片翻。
   */
  function read({ from = "", to = "", limit = 0 } = {}) {
    ensure();
    const lo = String(from || "").slice(0, 7);
    const hi = String(to || "").slice(0, 7);
    const out = [];
    for (const s of shards()) {              // 新片在前
      if (lo && s < lo) break;               // 再往老里翻只会更老，可以停
      if (hi && s > hi) continue;
      const rows = readShard(s);
      for (let i = rows.length - 1; i >= 0; i--) out.push(rows[i]); // 片内也要新的在前
      if (limit && out.length >= limit) break;
    }
    return limit ? out.slice(0, limit) : out;
  }

  /**
   * 整本重写。只有改用户名这一件事会用到——它要把历史流水里的名字一起换掉。
   * 罕见操作，慢一点没关系；换来的是热路径上那条 append 永远是 O(1)。
   */
  function rewriteAll(mutate) {
    ensure();
    let changed = 0;
    for (const s of shards()) {
      const rows = readShard(s);
      let touched = false;
      for (const r of rows) if (mutate(r)) { touched = true; changed++; }
      if (!touched) continue;
      const tmp = fileOf(s) + ".tmp";
      fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      fs.renameSync(tmp, fileOf(s)); // 原子替换：中途挂掉也不会留下半个文件
    }
    return changed;
  }

  /** 删掉比 keepMonths 更老的分片。返回删掉了哪几片 —— 谁调它谁负责先说清楚要删什么 */
  function prune(keepMonths) {
    ensure();
    const n = Math.max(1, Math.floor(+keepMonths || 0));
    const keep = new Set(shards().slice(0, n));
    const dropped = [];
    for (const s of shards()) {
      if (keep.has(s)) continue;
      try { fs.unlinkSync(fileOf(s)); dropped.push(s); } catch {}
    }
    return dropped;
  }

  /** 账本现状，给后台和 doctor 用：几片、多少条、多大 */
  function stat() {
    ensure();
    const list = shards().map((s) => {
      let size = 0;
      try { size = fs.statSync(fileOf(s)).size; } catch {}
      return { shard: s, size, rows: readShard(s).length };
    });
    return { dir: DIR, shards: list, rows: list.reduce((a, b) => a + b.rows, 0), size: list.reduce((a, b) => a + b.size, 0) };
  }

  /**
   * 整本换成这一份（**新的在前**的数组）。只给迁移和测试用——正常记账走 append。
   * 先写新分片再删旧分片：中途挂掉最差是多留几片老文件，不会出现「账没了」。
   */
  function replaceAll(rows) {
    ensure();
    const list = Array.isArray(rows) ? rows : [];
    const byShard = new Map();
    for (const r of list.slice().reverse()) {          // 文件里老的在前
      const s = shardOf(r);
      if (!byShard.has(s)) byShard.set(s, []);
      byShard.get(s).push(r);
    }
    for (const [s, part] of byShard) {
      const tmp = fileOf(s) + ".tmp";
      fs.writeFileSync(tmp, part.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      fs.renameSync(tmp, fileOf(s));
    }
    for (const s of shards()) if (!byShard.has(s)) { try { fs.unlinkSync(fileOf(s)); } catch {} }
    return list.length;
  }

  /**
   * 每个人最后一次活动是什么时候。成员列表要的就是这一格。
   *
   * 为什么单独写一个而不是 read() 完再 map：成员列表**每开一次后台就查一次**，
   * 而它只需要「最近一次」。从新分片往老里翻，人齐了就停——常见情况下只读一个文件，
   * 跟账本里躺着三年还是三天没关系。翻不满也不硬翻：查不到的人本来就显示空白。
   */
  function lastActive(names, maxShards = 6) {
    ensure();
    const want = new Set(names || []);
    const out = new Map();
    let opened = 0;
    for (const s of shards()) {
      if (opened++ >= maxShards || !want.size) break;
      const rows = readShard(s);
      for (let i = rows.length - 1; i >= 0; i--) {     // 片内也是新的在前
        const u = rows[i] && rows[i].user;
        if (u && want.has(u)) { out.set(u, rows[i].ts); want.delete(u); if (!want.size) break; }
      }
    }
    return out;
  }

  return { append, read, replaceAll, rewriteAll, lastActive, prune, stat, shards, migrate, _internals: { DIR, LEGACY, shardOf, readShard, fileOf } };
}

// 默认这一本：模型 token 的用量流水（account.js 记的那本）。
// 直接 require 拿到的就是它，调用方一字不用改。
module.exports = makeStore(path.join(DATA_DIR, "usage"), path.join(DATA_DIR, "usage.json"));
// 再开一本走这儿。
module.exports.make = makeStore;
