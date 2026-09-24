"use strict";
/**
 * 运行时内存：会话缓存必须有上限，清掉的必须原样读得回来。
 *
 * 跑法：node test/memory.js
 *
 * 起因是拿尺子量了一遍自己：server.js 里的 sessions Map 只进不出——用户点开过的每一条会话，
 * 都原地住到进程退出为止。本机 203 条真会话（盘上 29.1MB）全读进来实测：
 *
 *     堆 heapUsed  2.8 → 42.3 MB   (+39.6)
 *     进程 RSS    43.8 → 119.8 MB  (+76.0)
 *
 * 而且再也不回落。metrics.js 里那条 rss 告警说的「如果它不再回落，值得看一眼是不是有
 * 超大会话没被回收」，讲的就是这件事。多人服务器上这个数还要乘人头。
 *
 * 它本来就只是个缓存：真本一直在 data/sessions/<id>.json，清掉大不了下次重读一遍
 * （实测最大的一条 1.3MB 重读 7.07ms，中位数那条 0.30ms）。
 *
 * 所以这一套断言分两半：
 *   一半证「真的会清」——不清的那个版本（阴性对照）必须当场变红；
 *   一半证「清得安全」——正在跑的、有人攥着的、刚碰过的、跟盘上对不上的，一条都不许清，
 *   清掉的那些必须一个字节不差地读得回来。
 *
 * 少了后一半，把 sessions.clear() 写在 getSession 里也能让前一半全绿，
 * 代价是定时任务跑到一半整趟记录蒸发、用户传的附件在发消息前凭空消失。
 */

// 量堆要 global.gc。npm test 是拿 node 直接拉起来的，自己换身皮再跑一遍
if (!global.gc) {
  const r = require("child_process").spawnSync(process.execPath, ["--expose-gc", __filename], {
    stdio: ["ignore", "inherit", "inherit"], timeout: 300000,
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const store = require(path.join(ROOT, "store.js"));

let pass = 0, fail = 0;
const ok = (msg, cond, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};

// ---------------- 把真源码切出来单跑 ----------------
// 跟 e2e 里 testSessionCacheReload 同一个路子：这一整段是纯的，注入
// fs/path/SESS_DIR/store/sessions/activeRuns/console 就能真读真写磁盘。
// 切真源码而不是照抄一份：照抄的那份改了也不会红，等于没测。
const SRC = src("server");
const A = SRC.indexOf("function sessFile(id) {");
const B = SRC.indexOf("const sessMetaCache = new Map();", A);
if (A < 0 || B <= A) throw new Error("server.js 里的会话读写找不到了（改名/挪走？），测试没法定位真源码");
const SLICE = SRC.slice(A, B);

// 阴性对照：把「读完顺手清一清」那一行摘掉，还原成改之前只进不出的样子
const TRIM_CALL = /\n *trimSessionCache\(id\);[^\n]*\n/;

const RET = "\nreturn { getSession, saveSession, autosaveSession, forgetSession, trimSessionCache,"
  + " holdSession, releaseSession, sessSynced, sessCacheBytes, sessFile,"
  + " SESS_CACHE_BYTES, SESS_CACHE_KEEP, SESS_CACHE_IDLE_MS, sessUsedAt, sessHold, sessStamp };";

const HOMES = [];
function build(loose) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mem-"));
  HOMES.push(home);
  const SESS_DIR = path.join(home, "sessions");
  fs.mkdirSync(SESS_DIR, { recursive: true });
  let body = SLICE;
  if (loose) body = body.replace(TRIM_CALL, "\n");
  const sessions = new Map();
  const activeRuns = new Map();
  const warns = [];
  const M = new Function("fs", "path", "SESS_DIR", "store", "sessions", "activeRuns", "console",
    body + RET)(fs, path, SESS_DIR, store, sessions, activeRuns,
    { log() {}, warn: (...a) => warns.push(a.join(" ")) });
  return { ...M, sessions, activeRuns, SESS_DIR, warns };
}

/** 造一条大约 sizeKB 的会话，正文里掺一个只此一条才有的记号，好证明读回来的是同一条 */
function makeSession(mark, sizeKB) {
  const pad = "工作台把这一步的来龙去脉都记在这儿，重启之后还查得到。".repeat(12);
  const history = [];
  const n = Math.max(1, Math.round(sizeKB * 1024 / (Buffer.byteLength(pad) + 40)));
  for (let i = 0; i < n; i++) {
    history.push({ role: i % 2 ? "assistant" : "user", content: `${mark}#${i} ${pad}` });
  }
  return { history, transcript: [{ type: "user", text: mark, at: "2026-09-20T00:00:00.000Z" }], title: mark, updated_at: null };
}

const idOf = (i) => `s_17300000000${String(i).padStart(2, "0")}_t`;
/** 铺一批会话到盘上，返回总字节 */
function seed(srv, count, sizeKB) {
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const f = srv.sessFile(idOf(i));
    store.writeJsonAtomic(f, makeSession(`第${i}条`, sizeKB));
    bytes += fs.statSync(f).size;
  }
  return bytes;
}
/** 把这些会话「都点开一遍」，并把最后一次使用时间往前拨，模拟人翻了一下午历史。
 *  freshId 那条不往前拨：它代表「刚刚才碰过的那条」，测闸门③要的就是这个 */
function browseAll(srv, count, ageMs, freshId) {
  for (let i = 0; i < count; i++) {
    srv.getSession(idOf(i));
    if (!ageMs) continue;
    for (const k of srv.sessUsedAt.keys()) if (k !== freshId) srv.sessUsedAt.set(k, Date.now() - ageMs);
  }
}

const MB = (b) => +(b / 1048576).toFixed(1);
const COUNT = 30, SIZE_KB = 1024;            // 30 条 × 1MB ≈ 30MB，是 8MB 预算的将近四倍
const OLD = 10 * 60 * 1000;                  // 当成十分钟前翻过的

console.log("\n— 先证明这道闸门真的在拦：不拦的那个版本什么样 —");
const loose = build(true);
const diskBytes = seed(loose, COUNT, SIZE_KB);
ok(`料铺好了：${COUNT} 条会话，盘上 ${MB(diskBytes)} MB，越过了 ${MB(loose.SESS_CACHE_BYTES)} MB 那道线`,
  diskBytes > loose.SESS_CACHE_BYTES, { diskBytes, cap: loose.SESS_CACHE_BYTES });
global.gc();
const looseBase = process.memoryUsage().heapUsed;
browseAll(loose, COUNT, OLD);
global.gc();
const looseGrow = process.memoryUsage().heapUsed - looseBase;
ok(`★不清的版本：翻完 ${COUNT} 条，${loose.sessions.size} 条全留在内存里，占 ${MB(loose.sessCacheBytes())} MB★`,
  loose.sessions.size === COUNT, loose.sessions.size);
ok(`★不清的版本：堆涨了 ${MB(looseGrow)} MB 且不回落——这就是改之前的样子★`,
  looseGrow > 20 * 1048576, MB(looseGrow));

console.log("\n— 现在的版本：一样翻一遍，内存得停在预算里 —");
const srv = build(false);
const diskBytes2 = seed(srv, COUNT, SIZE_KB);
ok("对照组用的是同一批料（同样越过预算）", diskBytes2 > srv.SESS_CACHE_BYTES, { diskBytes2 });
global.gc();
const base = process.memoryUsage().heapUsed;
browseAll(srv, COUNT, OLD);
global.gc();
const grow = process.memoryUsage().heapUsed - base;
const held = srv.sessCacheBytes();
ok(`翻完同样 ${COUNT} 条，内存里只剩 ${srv.sessions.size} 条`, srv.sessions.size < COUNT, srv.sessions.size);
// 预算不是一刀切的硬顶：保底那几条永远留着。所以契约是「要么在预算内，要么只剩保底那几条」——
// 一条 20MB 的巨型会话不该把自己挤掉，否则来回切两条就成了来回读盘
ok(`留下来的这些 ${MB(held)} MB，要么在 ${MB(srv.SESS_CACHE_BYTES)} MB 预算内，要么就只剩保底那 ${srv.SESS_CACHE_KEEP} 条`,
  held <= srv.SESS_CACHE_BYTES || srv.sessions.size <= srv.SESS_CACHE_KEEP,
  { held, cap: srv.SESS_CACHE_BYTES, size: srv.sessions.size });
ok(`堆只涨了 ${MB(grow)} MB（不清的那版是 ${MB(looseGrow)} MB，省下 ${MB(looseGrow - grow)} MB）`,
  grow < looseGrow * 0.75, { grow: MB(grow), looseGrow: MB(looseGrow) });
ok("跟着一起清干净了：stamp / 上次用时 两张表没留下孤儿",
  srv.sessStamp.size === srv.sessions.size && srv.sessUsedAt.size === srv.sessions.size,
  { sessions: srv.sessions.size, stamp: srv.sessStamp.size, usedAt: srv.sessUsedAt.size });
ok(`最近用过的那条一定还在（${srv.SESS_CACHE_KEEP} 条保底）`,
  srv.sessions.has(idOf(COUNT - 1)) && srv.sessions.size >= 1, [...srv.sessions.keys()].length);

console.log("\n— 空转不许触发冷却（这一格踩过一次真坑）—");
{
  /**
   * 「超了预算，但一条都挑不动」有两种，性质完全不同：
   *   a. 真挑过，每条都在用着／都还没落盘  → 该歇一分钟，不然每开一条会话都要把整份缓存逐个读盘比对一遍；
   *   b. 压根没挑过（条数正好卡在保底线上）→ 绝不能歇，歇了接下来这一分钟内存是彻底敞开的。
   * 这两种以前是一个写法。预算 8MB／保底 8 条／每条 1MB 时正好撞进 b：
   * 第 8 条触发一次空转，armed 之后翻完 30 条一条没清，30.1MB 全留着，这道闸门等于白装。
   */
  const g = build(false);
  seed(g, COUNT, SIZE_KB);
  for (let i = 0; i < g.SESS_CACHE_KEEP; i++) g.getSession(idOf(i));
  for (const k of g.sessUsedAt.keys()) g.sessUsedAt.set(k, Date.now() - OLD);
  const overAtFloor = g.sessCacheBytes() > g.SESS_CACHE_BYTES;
  ok(`先验：正好 ${g.SESS_CACHE_KEEP} 条时已经超了预算（${MB(g.sessCacheBytes())} MB），这一趟注定挑不动`,
    overAtFloor && g.sessions.size === g.SESS_CACHE_KEEP, { size: g.sessions.size, bytes: g.sessCacheBytes() });
  ok("这一趟确实一条没清（空转）", g.trimSessionCache(null) === 0);
  // 紧接着再开一条：条数过了保底线，这一趟必须真清掉东西
  g.getSession(idOf(g.SESS_CACHE_KEEP));
  ok(`空转之后马上还能清（不是被冷却锁住一分钟）：现在 ${g.sessions.size} 条`,
    g.sessions.size <= g.SESS_CACHE_KEEP, g.sessions.size);
}

console.log("\n— 清掉的必须原样读得回来（不然这不叫省内存，叫丢数据）—");
{
  const gone = [];
  for (let i = 0; i < COUNT; i++) if (!srv.sessions.has(idOf(i))) gone.push(i);
  ok(`确实有被清掉的：${gone.length} 条`, gone.length > 0, gone.length);
  let same = 0, checked = 0;
  for (const i of gone) {
    const disk = JSON.parse(fs.readFileSync(srv.sessFile(idOf(i)), "utf8"));
    const back = srv.getSession(idOf(i));
    checked++;
    if (JSON.stringify(back) === JSON.stringify(disk) && back.title === `第${i}条`) same++;
  }
  ok(`被清掉的 ${checked} 条，重新打开后跟盘上那份一字不差`, checked > 0 && same === checked, { checked, same });
}

console.log("\n— 四道闸门，一道都不许漏 —");
{
  /**
   * A/B 各跑一遍同一个剧本，只差「闸门开不开」这一件事。
   *
   * 只跑「开着」那一遍是证不了什么的：这四条会话就算被保护，也可能只是凑巧排在队尾没轮到它。
   * 所以关掉闸门再跑一遍同一个剧本 —— 同样这四条必须全被清走，那才说明它们活下来靠的是闸门。
   */
  const play = (gates) => {
    const g = build(false);
    seed(g, COUNT, SIZE_KB);
    const RUNNING = idOf(0), HELD = idOf(1), FRESH = idOf(2), DIRTY = idOf(3);
    g.getSession(RUNNING); if (gates) g.activeRuns.set(RUNNING, { ctrl: {} });
    g.getSession(HELD); if (gates) g.holdSession(HELD);
    const dirty = g.getSession(DIRTY);
    // 附件是「先传后发」的：/api/upload 把文件名记在 sess.pending_uploads 上**而且不存盘**，
    // 等下一条消息发出去才用。这种只活在内存里的改动，清掉就等于用户传的图凭空消失
    if (gates) dirty.pending_uploads = ["报价单.xlsx"];
    g.getSession(FRESH);
    // 闸门③要的是「翻历史的这一路上，它一直是刚碰过的那条」。
    // 翻完再补一句 sessUsedAt.set 是没用的：翻到一半它就已经被清走了，那时候补谁都来不及
    browseAll(g, COUNT, OLD, gates ? FRESH : null);
    g.trimSessionCache(null);
    return {
      g, size: g.sessions.size,
      running: g.sessions.has(RUNNING), held: g.sessions.has(HELD),
      fresh: g.sessions.has(FRESH), dirty: g.sessions.has(DIRTY),
      upload: ((g.sessions.get(DIRTY) || {}).pending_uploads || [])[0] || null,
      synced: g.sessSynced(DIRTY),
    };
  };
  const on = play(true), off = play(false);

  ok("先验：两趟都真的清掉了一批（不然下面全是空头支票）", on.size < COUNT && off.size < COUNT, { on: on.size, off: off.size });
  ok("先验：脏的那条确实跟盘上对不上了（闸门④判的就是这个）", !on.synced, on.synced);
  ok("先验：关掉闸门那一趟，这四条本来就会被清走（它们排在队头）",
    !off.running && !off.held && !off.fresh && !off.dirty, off);

  ok("① 正在跑的那条没被清（那份对象正被这一轮改着）", on.running, on.running);
  ok("② 有人长期攥着的那条没被清（定时任务那条路）", on.held, on.held);
  ok("③ 一分钟内碰过的那条没被清", on.fresh, on.fresh);
  ok("④ 跟盘上对不上的那条没被清（用户传的附件还在内存里等着）",
    on.dirty && on.upload === "报价单.xlsx", on.upload || "已经被清掉了");
}

console.log("\n— 攥着对象的人，写盘不许落空 —");
{
  const g = build(false);
  const id = "s_1730000000999_hold";
  const sess = g.getSession(id);
  sess.history = [{ role: "user", content: "每天早八点把昨天的数汇总一下" }];
  sess.title = "每日汇总";
  g.saveSession(id, sess);
  // 定时任务跑十几分钟，期间用户在界面上翻历史，这条被挤了出去
  g.sessions.delete(id);
  sess.history.push({ role: "assistant", content: "汇总好了，三张表" });
  g.saveSession(id, sess);                    // 手里这份为准
  const onDisk = JSON.parse(fs.readFileSync(g.sessFile(id), "utf8"));
  ok("被清掉之后，攥着对象的那一方存盘照样落到对的内容上", onDisk.history.length === 2, onDisk.history.length);
  ok("而且没有乱报警（递了对象就是正常路径）", g.warns.length === 0, g.warns);

  // 反向对照：既不在内存里、也没人递对象——这是真出事了，必须留痕，不许悄悄 return
  g.saveSession("s_1730000000998_nobody");
  ok("★内存里没有、也没人递对象：必须在日志里留一句，不许无声跳过★",
    g.warns.length === 1 && /s_1730000000998_nobody/.test(g.warns[0]), g.warns);
}

console.log("\n— 删会话：五张表一起清干净 —");
{
  const g = build(false);
  const id = idOf(0);
  seed(g, 1, 8);
  g.getSession(id);
  g.holdSession(id);
  g.autosaveSession(id, 0);
  ok("先验：五张表里都记上了这条", g.sessions.has(id) && g.sessStamp.has(id) && g.sessUsedAt.has(id) && g.sessHold.has(id), {
    sessions: g.sessions.has(id), stamp: g.sessStamp.has(id), usedAt: g.sessUsedAt.has(id), hold: g.sessHold.has(id),
  });
  g.forgetSession(id);
  ok("删完之后一张表都没剩下（漏一张，那张就是新的只进不出）",
    !g.sessions.has(id) && !g.sessStamp.has(id) && !g.sessUsedAt.has(id) && !g.sessHold.has(id), {
      sessions: g.sessions.has(id), stamp: g.sessStamp.has(id), usedAt: g.sessUsedAt.has(id), hold: g.sessHold.has(id),
    });
}

console.log("\n— 重读的代价：清掉它得真的便宜，不然这笔买卖不划算 —");
{
  const g = build(false);
  const id = idOf(0);
  seed(g, 1, SIZE_KB);
  for (let i = 0; i < 3; i++) { g.getSession(id); g.forgetSession(id); }   // 预热
  const t = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) { g.getSession(id); g.forgetSession(id); }
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / 20;
  ok(`一条 ${SIZE_KB} KB 的会话重新读一遍 ${ms.toFixed(2)} ms（人感觉不到，所以清得起）`, ms < 50, ms.toFixed(2));
}

console.log("\n— 接线：省下来的这块得有人看得见 —");
{
  ok("指标里报了内存里现在留着多少 MB（不然这道闸门有没有在干活没人知道）",
    /session_cache_mb:\s*Math\.round\(sessCacheBytes\(\)/.test(SRC), false);
  ok("定时任务录制器攥住了自己那条会话（它不走 activeRuns，光靠那道闸门盖不住）",
    /holdSession\(sessionId\);/.test(SRC) && /releaseSession\(sessionId\);/.test(SRC), false);
  ok("录制器存盘时把手里那份递进去了（被清过也写得对）",
    (SRC.match(/saveSession\(sessionId, sess\)/g) || []).length === 2, (SRC.match(/saveSession\(sessionId, sess\)/g) || []).length);
  ok("删会话和清定时任务残留都走 forgetSession（不再各自手写 delete，漏一张表就是新的泄漏）",
    (SRC.match(/forgetSession\(/g) || []).length >= 3 && !/sessions\.delete\(req\.params\.id\)/.test(SRC), false);
}

for (const h of HOMES) { try { fs.rmSync(h, { recursive: true, force: true }); } catch {} }
console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
process.exit(fail ? 1 : 0);
