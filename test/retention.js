// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 派生数据的保留规则：该删的删得掉，不该删的一个字节都碰不到。
 *
 * 跑法：node test/retention.js
 *
 * 起因是 2026-09-28 量了一台用了一个月的机器：data/ 里只进不出的东西——会话旁边的孪生 .bak
 * （38M，正本才 41M）、正本早没了的 .bak（删过的对话原样躺在里头）、压缩归档、缩略图、
 * Codex 引擎自己的缓存和线程记录。每样都不大，加起来比会话本身还多，而且用得越久越大。
 *
 * 删东西的代码，怕的从来不是「删不掉」，是「删多了」。所以每条规则都是两半：
 *   一半证它真删得掉（先 dryRun 数一遍，数对了再真删，删的正好是数到的那些）；
 *   一半是★反向对照★：摆一个长得很像、却必须活下来的——用户自己起名的文件、正本读不出来的 .bak、
 *   还被会话记着的线程、软链接、别人的会话。它们要是跟着没了，这条规则就是个事故。
 *
 * 全部夹具都在自己的临时家里（test/lib/own-home.js），不碰 data/ 一个文件。
 */
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("retention");

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src");
const store = require(mod("store"));
const R = require(mod("retention"));
const thumb = require(mod("thumb"));
const metrics = require(mod("metrics"));
const { createImSessionStore } = require(mod("im-store"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
let seq = 0;
/** 每组一个干净目录，全在临时家底下 */
const fresh = (tag) => { const d = path.join(HOME, `${tag}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
/** 写一个文件并把 mtime 拨到 ageMs 以前 */
function put(file, text, ageMs = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (ageMs) { const t = new Date(NOW - ageMs); fs.utimesSync(file, t, t); }
  return file;
}
const age = (file, ageMs) => { const t = new Date(NOW - ageMs); fs.utimesSync(file, t, t); };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const names = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const base = (list) => list.map((p) => path.basename(p)).sort();

// ---------------- 会话读写那一段：切真源码单跑（同 test/memory.js 的路子） ----------------
const SRC = src("server");
const A = SRC.indexOf("function sessFile(id) {");
const B = SRC.indexOf("const sessMetaCache = new Map();", A);
if (A < 0 || B <= A) throw new Error("server.js 里的会话读写找不到了（改名/挪走？），测试没法定位真源码");
const SLICE = SRC.slice(A, B);
const RET = "\nreturn { getSession, saveSession, forgetSession, removeSessionFiles, sessFile, sessStamp };";
const TRUST = "store.writeJsonAtomic(sessFile(id), s, { trustPrev });";

function buildSess(body = SLICE) {
  const home = fresh("sess");
  const SESS_DIR = path.join(home, "sessions");
  fs.mkdirSync(SESS_DIR, { recursive: true });
  const sessions = new Map();
  const M = new Function("fs", "path", "SESS_DIR", "store", "sessions", "activeRuns", "console", body + RET)(
    fs, path, SESS_DIR, store, sessions, new Map(), { log() {}, warn() {}, error() {} });
  return { ...M, sessions, SESS_DIR, home };
}

(async () => {
  console.log("\n【1】存盘留 .bak：上一版挂成硬链接，一个字节都不搬；拿不准的时候还走老路");
  {
    const dir = fresh("store");
    const f = path.join(dir, "a.json");
    store.writeJsonAtomic(f, { v: 1 });
    ok(!exists(f + ".bak"), "第一次存：没有上一版，就没有 .bak");
    const ino1 = fs.statSync(f).ino;
    store.writeJsonAtomic(f, { v: 2 }, { trustPrev: true });
    ok(JSON.parse(fs.readFileSync(f + ".bak", "utf8")).v === 1 && JSON.parse(fs.readFileSync(f, "utf8")).v === 2,
      "担保过的上一版照样变成 .bak，内容就是上一版");
    ok(fs.statSync(f + ".bak").ino === ino1 && fs.statSync(f).ino !== ino1,
      ".bak 就是上一版那个 inode（硬链接，没拷数据），正本换成了新 inode");
    ok(!names(dir).some((n) => n.endsWith(".tmp")), "不留 .bak.<pid>.tmp 这种半截临时名", names(dir));

    // 链不上的盘（exFAT / SMB）：退回整份拷贝
    const realLink = fs.linkSync;
    fs.linkSync = () => { const e = new Error("EXDEV 模拟"); /** @type {any} */ (e).code = "EXDEV"; throw e; };
    try { store.writeJsonAtomic(f, { v: 3 }, { trustPrev: true }); } finally { fs.linkSync = realLink; }
    ok(JSON.parse(fs.readFileSync(f + ".bak", "utf8")).v === 2, "硬链接不支持的盘：退回整份拷贝，.bak 仍是上一版");

    // ★反向对照★：不担保的时候，残骸顶不掉一份好的 .bak（老路的规矩没被新路绕开）
    fs.writeFileSync(f, "{\"v\":");
    store.writeJsonAtomic(f, { v: 4 });
    ok(JSON.parse(fs.readFileSync(f + ".bak", "utf8")).v === 2, "★反向对照★ 没担保 + 正本是半截：.bak 还是那份好的 v2");
  }

  console.log("\n【2】会话存盘：盘上那份跟自己上次读写的对得上才担保，对不上（命令行写过）照走老路");
  {
    const run = (body) => {
      const S = buildSess(body);
      const id = "s_1730000000000_t";
      const s = S.getSession(id);
      s.history.push({ role: "user", content: "第一版" });
      S.saveSession(id);
      const f = S.sessFile(id);
      const ino1 = fs.statSync(f).ino;
      s.history.push({ role: "assistant", content: "第二版" });
      S.saveSession(id);
      const linked = fs.statSync(f + ".bak").ino === ino1;
      // 别的进程（命令行 openworkbuddy）写到一半断了，盘上留下半截
      fs.writeFileSync(f, "{\"history\":[{\"role\":");
      s.history.push({ role: "user", content: "第三版" });
      S.saveSession(id);
      let bakOk = false;
      try { bakOk = JSON.parse(fs.readFileSync(f + ".bak", "utf8")).history.length === 1; } catch {}
      return { linked, bakOk, main: JSON.parse(fs.readFileSync(f, "utf8")).history.length };
    };
    const real = run(SLICE);
    ok(real.linked, "自己上一次写下的那份：直接硬链接成 .bak，不重读不重解析");
    ok(real.bakOk && real.main === 3, "盘上被别人写成半截：不担保，.bak 还是上一份好的，正本是新的第三版", real);
    ok(SLICE.includes(TRUST), "saveSession 里那句担保写法还在（下面的阴性对照靠它定位）");
    const loose = run(SLICE.replace(TRUST, "store.writeJsonAtomic(sessFile(id), s, { trustPrev: true });"));
    ok(!loose.bakOk, "★反向对照★ 把担保条件摘掉、一律担保：半截残骸当场顶掉好的 .bak——证明那道比对是在干活", loose);
  }

  console.log("\n【3】删会话：正本、.bak、隔离件、半截临时文件、压缩归档一起走，别的会话一个不碰");
  {
    const S = buildSess();
    const id = "s_1730000000000_ab";
    const f = S.sessFile(id);
    const arch = path.join(S.home, "compact-archive");
    const mine = [f, f + ".bak", f + ".corrupt", f + ".corrupt-1727000000000", f + ".4242.tmp", f + ".bak.4242.tmp",
      path.join(arch, `${id}-1727000000000.json`), path.join(arch, `${id}-1727000000001.json`)];
    for (const p of mine) put(p, "{}");
    // ★反向对照★：前缀相同的另一条会话、老式不带 id 的归档、用户自己放的文件
    const other = S.sessFile("s_1730000000000_abc");
    const keep = [other, other + ".bak", S.sessFile("s_1730000000000_a") + ".bak",
      f + ".notes.txt", path.join(arch, "1727000000000.json"), path.join(arch, "s_1730000000000_abc-1727000000000.json"),
      path.join(arch, `${id}-notes.json`)];
    for (const p of keep) put(p, "{}");
    S.forgetSession(id);
    S.removeSessionFiles(id);
    ok(mine.every((p) => !exists(p)), "这条会话名下的 8 份全删了", mine.filter(exists).map((p) => path.basename(p)));
    ok(keep.every(exists), "★反向对照★ 前缀相同的别的会话、老归档、用户起名的文件全在", keep.filter((p) => !exists(p)).map((p) => path.basename(p)));
    ok(/forgetSession\(req\.params\.id\);\s*removeSessionFiles\(req\.params\.id\);/.test(SRC),
      "删除接口真调了 removeSessionFiles（不是定义了没人用）");
    ok(/forgetSession\(id\);\s*removeSessionFiles\(id\);/.test(SRC), "定时任务清残留那条路也调了");
  }

  console.log("\n【4】会话 .bak 扫除（开机那趟迁移）：先数不删，数对了再删");
  {
    const dir = fresh("baks");
    const S = (n) => path.join(dir, n);
    const H = 3600 * 1000;
    // 该删的两种
    put(S("orphan.json.bak"), "{\"v\":1}", 2 * H);                        // 正本没了，过了十分钟余量
    put(S("stale.json.bak"), "{\"v\":1}", 9 * DAY); put(S("stale.json"), "{\"v\":2}", 8 * DAY); // 八天没存、正本读得出
    // 必须活下来的
    put(S("young.json.bak"), "{}", 60 * 1000);                              // 孤儿但才一分钟：可能正删着 / 改着名
    put(S("hurt.json.bak"), "{}", 2 * H); put(S("hurt.json.corrupt"), "x"); // 旁边有隔离件：出过事的现场
    put(S("bad.json.bak"), "{\"v\":1}", 9 * DAY); put(S("bad.json"), "{\"v\":", 8 * DAY);   // 正本读不出来：.bak 是退路
    put(S("busy.json.bak"), "{\"v\":1}", 9 * DAY); put(S("busy.json"), "{\"v\":2}", DAY);   // .bak 老，可正本昨天刚存过
    put(S("back.json"), "{\"v\":1}", 20 * DAY); put(S("back.json.bak"), "{\"v\":2}", 9 * DAY); // 正本比 .bak 旧（恢复过）
    put(S("new.json"), "{}"); put(S("new.json.bak"), "{}");
    put(S("notes.bak"), "用户的", 90 * DAY); put(S("traces.jsonl.bak"), "x", 90 * DAY);
    fs.symlinkSync(S("new.json"), S("link.json.bak")); age(S("new.json"), 0);
    const before = names(dir);

    const dry = await R.sweepBaks(dir, { now: NOW, dryRun: true });
    ok(base(dry.removed).join() === "orphan.json.bak,stale.json.bak", "dryRun 数到正好两份：孤儿一份、过期一份", base(dry.removed));
    ok(names(dir).join() === before.join(), "dryRun 一个文件都没动");
    const real = await R.sweepBaks(dir, { now: NOW });
    ok(base(real.removed).join() === base(dry.removed).join(), "真删的就是数到的那两份", base(real.removed));
    ok(!exists(S("orphan.json.bak")) && !exists(S("stale.json.bak")), "两份都真没了");
    ok(exists(S("young.json.bak")), "★反向对照★ 才一分钟的孤儿 .bak 留着（十分钟余量）");
    ok(exists(S("hurt.json.bak")), "★反向对照★ 旁边有 .corrupt 的留着");
    ok(exists(S("bad.json.bak")), "★反向对照★ 正本读不出来：.bak 是最后的退路，留着");
    ok(exists(S("busy.json.bak")), "★反向对照★ 正本昨天刚存过（硬链接 .bak 带的是上一版的老 mtime）：留着");
    ok(exists(S("back.json.bak")), "★反向对照★ 正本比 .bak 还旧：留着");
    ok(exists(S("new.json.bak")) && exists(S("notes.bak")) && exists(S("traces.jsonl.bak")), "★反向对照★ 新的、名字对不上的都在");
    ok(fs.lstatSync(S("link.json.bak")).isSymbolicLink(), "★反向对照★ 软链接不碰");
    ok(["stale.json", "bad.json", "busy.json", "back.json", "new.json"].every((n) => exists(S(n))), "★反向对照★ 每一份 .json 正本都在");
  }

  console.log("\n【5】data/ 顶层几本账的 .bak：只清一个月没人要的孤儿，过期规则不在这儿用");
  {
    const dataDir = fresh("data");
    const D = (n) => path.join(dataDir, n);
    put(D("usage.json.bak"), "{}", 31 * DAY);                               // usage.json 拆成分片后留下的
    put(D("recent.json.bak"), "{}", 5 * DAY);
    put(D("accounts.json"), "{}", 60 * DAY); put(D("accounts.json.bak"), "{}", 61 * DAY);
    put(D("orgs.json.bak-1727000000000"), "{}", 90 * DAY); put(D("usage.json.migrated"), "{}", 90 * DAY);
    const r = await R.sweepAll({ dataDir, now: NOW, log() {} });
    ok(base(r["账本孤儿 .bak"].removed).join() === "usage.json.bak", "只删了一个月没人要的 usage.json.bak", base(r["账本孤儿 .bak"].removed));
    ok(exists(D("recent.json.bak")), "★反向对照★ 五天的孤儿留着（门槛是三十天）");
    ok(exists(D("accounts.json.bak")), "★反向对照★ 账本旁边的 .bak 再老也留着（顶层不跑过期规则）");
    ok(exists(D("orgs.json.bak-1727000000000")) && exists(D("usage.json.migrated")), "★反向对照★ 手动留的 .bak-<时间>、.migrated 不是应用生成的，不碰");
    ok(Object.keys(r).length === 6, "六条规则都跑了，空目录也不报错", Object.keys(r));
  }

  console.log("\n【6】压缩归档：九十天 / 200MB，只认自己的文件名");
  {
    const dir = fresh("archive");
    const P = (n) => path.join(dir, n);
    put(P("s_1730000000000_t-1727000000000.json"), "[]", 100 * DAY);
    put(P("1727000000001.json"), "[]", 100 * DAY);                          // 老版本不带 id 的
    put(P("s_1730000000000_t-1727000000002.json"), "[]", 10 * DAY);
    put(P("notes.json"), "用户的", 200 * DAY); put(P("readme.txt"), "x", 200 * DAY);
    const dry = await R.pruneArchive(dir, { now: NOW, dryRun: true });
    ok(dry.removed.length === 2 && names(dir).length === 5, "dryRun 数到两份过期的，一个没删", base(dry.removed));
    const real = await R.pruneArchive(dir, { now: NOW });
    ok(base(real.removed).join() === base(dry.removed).join(), "真删的就是那两份（新旧两种文件名都认）");
    ok(exists(P("s_1730000000000_t-1727000000002.json")), "★反向对照★ 十天的留着");
    ok(exists(P("notes.json")) && exists(P("readme.txt")), "★反向对照★ 名字对不上的，两百天也不碰");

    // 总量超了：从最久没动的那头删，删到线以下就停
    const dir2 = fresh("archive-cap");
    const blob = "x".repeat(1000);
    for (let i = 0; i < 5; i++) put(path.join(dir2, `s_1-172700000000${i}.json`), blob, (10 - i) * DAY);
    put(path.join(dir2, "big-user-file.json"), "y".repeat(50000), 50 * DAY);
    const cap = await R.pruneArchive(dir2, { now: NOW, maxBytes: 2500 });
    ok(base(cap.removed).join() === "s_1-1727000000000.json,s_1-1727000000001.json,s_1-1727000000002.json",
      "超了 2500 字节的线：删掉最老的三份，剩两份刚好在线下", base(cap.removed));
    ok(exists(path.join(dir2, "big-user-file.json")), "★反向对照★ 名字对不上的大文件不算进总量，也不被删");
    ok(R.ARCHIVE_RE.test("s_1730000000000_t-1727000000000.json") && R.ARCHIVE_RE.test("1727000000000.json") && !R.ARCHIVE_RE.test("notes-2026.json"),
      "归档名的正则：新旧两种都认，别的不认");
    const AG = fs.readFileSync(mod("agent"), "utf8");
    ok(/`\$\{sid \? sid \+ "-" : ""\}\$\{Date\.now\(\)\}\.json`\), JSON\.stringify\(old\)\)/.test(AG),
      "agent.js 写归档：文件名带会话 id、不缩进");
    ok((AG.match(/compactHistory\(history, \{[^}]*sessionId \}\)/g) || []).length >= 2, "两处自动压缩都把会话 id 递进去了");
  }

  console.log("\n【7】缩略图：一个月没用到的、超 100MB 的、写到一半的 .part");
  {
    const dir = fresh("thumbs");
    const sha = (i) => String(i).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, "a");
    const P = (n) => path.join(dir, n);
    put(P(sha(1) + ".png"), "p", 40 * DAY);
    put(P(sha(2) + ".png"), "p", 5 * DAY);
    put(P(sha(3) + ".png.123.7.part"), "p", 2 * DAY);
    put(P(sha(4) + ".png.123.8.part"), "p", 3600 * 1000);
    put(P("photo.png"), "用户的", 400 * DAY); put(P(sha(5) + ".jpg"), "x", 400 * DAY);
    fs.symlinkSync(P(sha(2) + ".png"), P(sha(6) + ".png"));
    const dry = await R.pruneThumbs(dir, { now: NOW, dryRun: true });
    ok(base(dry.removed).join() === [sha(1) + ".png", sha(3) + ".png.123.7.part"].sort().join(), "dryRun 数到：40 天那张、两天的 .part", base(dry.removed));
    const real = await R.pruneThumbs(dir, { now: NOW });
    ok(base(real.removed).join() === base(dry.removed).join() && !exists(P(sha(1) + ".png")), "真删的就是那两份");
    ok(exists(P(sha(2) + ".png")) && exists(P(sha(4) + ".png.123.8.part")), "★反向对照★ 五天的、一小时的 .part（可能正写着）留着");
    ok(exists(P("photo.png")) && exists(P(sha(5) + ".jpg")), "★反向对照★ 名字对不上的不碰");
    ok(fs.lstatSync(P(sha(6) + ".png")).isSymbolicLink(), "★反向对照★ 软链接不碰");

    const dir2 = fresh("thumbs-cap");
    for (let i = 0; i < 4; i++) put(path.join(dir2, sha(i + 1) + ".png"), "z".repeat(1000), (4 - i) * DAY);
    const cap = await R.pruneThumbs(dir2, { now: NOW, maxBytes: 2000 });
    ok(base(cap.removed).join() === [sha(1) + ".png", sha(2) + ".png"].sort().join(), "超线：从最久没用到的那头删两张", base(cap.removed));

    // 命中就「摸」一下：mtime 就是最后一次用到。一天之内不重复摸
    const hitFile = put(path.join(dir, sha(7) + ".png"), "p", 2 * DAY);
    ok(thumb.cacheHit(hitFile, NOW) === true && Math.abs(fs.statSync(hitFile).mtimeMs - NOW) < 2000, "两天没摸过的命中一次：mtime 摸到现在");
    const t1 = fs.statSync(hitFile).mtimeMs;
    thumb.cacheHit(hitFile, NOW + 3600 * 1000);
    ok(fs.statSync(hitFile).mtimeMs === t1, "★反向对照★ 一小时后再命中：不再摸（一天最多一次，翻聊天记录不往盘上写一串元数据）");
    ok(thumb.cacheHit(path.join(dir, "nope.png"), NOW) === false, "没有这张：照实说没命中");

    // 资料库封面（lib-cover.js）：同一个目录、自己一本账。一个月没用到的 .png 和 .fail 都走
    const cdir = fresh("covers");
    const C = (n) => path.join(cdir, n);
    put(C("cover-" + sha(1) + ".png"), "p", 31 * DAY);
    put(C("cover-" + sha(2) + ".fail"), "", 31 * DAY);
    put(C("cover-" + sha(3) + ".png"), "p", 29 * DAY);
    put(C("cover-" + sha(4) + ".fail"), "", 2 * DAY);
    put(C("cover-" + sha(5) + ".png.123.9.part"), "p", 2 * DAY);
    put(C("cover-photo.png"), "用户的", 400 * DAY); put(C("cover-" + sha(6) + ".jpg"), "x", 400 * DAY);
    const cdry = await R.pruneThumbs(cdir, { now: NOW, dryRun: true });
    ok(base(cdry.removed).join() === ["cover-" + sha(1) + ".png", "cover-" + sha(2) + ".fail", "cover-" + sha(5) + ".png.123.9.part"].sort().join(),
      "封面：31 天的 .png、31 天的 .fail、两天的 .part 都数到", base(cdry.removed));
    const creal = await R.pruneThumbs(cdir, { now: NOW });
    ok(base(creal.removed).join() === base(cdry.removed).join() && !exists(C("cover-" + sha(1) + ".png")) && !exists(C("cover-" + sha(2) + ".fail")), "真删的就是那三份");
    ok(exists(C("cover-" + sha(3) + ".png")) && exists(C("cover-" + sha(4) + ".fail")), "★反向对照★ 29 天的封面、两天的 .fail 留着");
    ok(exists(C("cover-photo.png")) && exists(C("cover-" + sha(6) + ".jpg")), "★反向对照★ cover- 开头但名字对不上的不碰");
    ok(R.THUMB_RE.test("cover-" + sha(1) + ".png") && R.THUMB_RE.test("cover-" + sha(1) + ".fail") && R.THUMB_RE.test(sha(1) + ".png") && !R.THUMB_RE.test("cover-" + sha(1) + ".jpg"),
      "THUMB_RE 认普通缩略图和两种封面，别的不认");

    // 超了封面自己的线：从最久没用到的那头删；普通缩略图不算进封面的账，也不被连带
    const cdir2 = fresh("covers-cap");
    for (let i = 0; i < 4; i++) put(path.join(cdir2, "cover-" + sha(i + 1) + ".png"), "z".repeat(1000), (4 - i) * DAY);
    for (let i = 0; i < 3; i++) put(path.join(cdir2, sha(i + 1) + ".png"), "t".repeat(5000), (20 - i) * DAY);
    const ccap = await R.pruneThumbs(cdir2, { now: NOW, coverMaxBytes: 2000 });
    ok(base(ccap.removed).join() === ["cover-" + sha(1) + ".png", "cover-" + sha(2) + ".png"].sort().join(), "封面超 2000 字节：删最老的两张", base(ccap.removed));
    ok(exists(path.join(cdir2, "cover-" + sha(3) + ".png")) && exists(path.join(cdir2, "cover-" + sha(4) + ".png")), "★反向对照★ 新的两张封面留着");
    ok([1, 2, 3].every((i) => exists(path.join(cdir2, sha(i) + ".png"))), "★反向对照★ 更老更大的普通缩略图（15KB，在它自己 100MB 线下）一张没动");
    const tcap = await R.pruneThumbs(cdir2, { now: NOW, maxBytes: 6000 });
    ok(base(tcap.removed).join() === [sha(1) + ".png", sha(2) + ".png"].sort().join(), "反过来：普通缩略图超线只删普通缩略图", base(tcap.removed));
    ok(exists(path.join(cdir2, "cover-" + sha(3) + ".png")), "★反向对照★ 封面不被普通缩略图的线连带");
    ok(R.RULES.COVER_MAX_BYTES === 100 * 1024 * 1024 && R.RULES.COVER_MAX_AGE_MS === 30 * DAY, "封面的默认线：100MB、30 天");
  }

  console.log("\n【8】Codex 引擎的家：只清没人记得的旧线程、旧快照、旧缓存");
  {
    const root = fresh("codex");
    const home = path.join(root, "data", "runtime", "codex");
    const sess = path.join(root, "data", "sessions");
    const uid = (c) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
    const roll = (sub, c, ageMs) => put(path.join(home, sub, "2026", "08", "01", `rollout-2026-08-01T00-00-00-${uid(c)}.jsonl`), "{}\n", ageMs);
    const kept = roll("sessions", "a", 40 * DAY);          // 老，但会话还记着
    const gone = roll("sessions", "b", 40 * DAY);
    const young = roll("sessions", "c", 5 * DAY);
    const arch = roll("archived_sessions", "d", 40 * DAY);
    put(path.join(sess, "s_1.json"), JSON.stringify({ engine_sessions: { codex: uid("a").toUpperCase() } }));
    const snapOld = put(path.join(home, "shell_snapshots", "old.sh"), "x", 8 * DAY);
    const snapNew = put(path.join(home, "shell_snapshots", "new.sh"), "x", DAY);
    const cacheOld = put(path.join(home, "cache", "plugins", "list.json"), "x", 40 * DAY);
    const cacheNew = put(path.join(home, "cache", "apps.json"), "x", DAY);
    const userAuth = put(path.join(root, "user-codex", "auth.json"), "{\"token\":\"占位\"}", 400 * DAY);
    fs.symlinkSync(userAuth, path.join(home, "auth.json"));
    const untouched = [
      put(path.join(home, "plugins", "p", "index.js"), "x", 400 * DAY),
      put(path.join(home, "state_5.sqlite"), "x", 400 * DAY),
      put(path.join(home, "config.toml"), "x", 400 * DAY),
      put(path.join(home, "sessions", "notes.txt"), "x", 400 * DAY),
    ];
    const opt = { refDirs: [sess, path.join(root, "data", "im-sessions")], now: NOW };
    const dry = await R.pruneCodexHome(home, { ...opt, dryRun: true });
    const want = base([gone, arch, snapOld, cacheOld]).join();
    ok(base(dry.removed).join() === want, "dryRun 数到四份：没人记得的两条旧线程、旧快照、旧缓存", base(dry.removed));
    ok([gone, arch, snapOld, cacheOld].every(exists), "dryRun 一个没删");
    const real = await R.pruneCodexHome(home, opt);
    ok(base(real.removed).join() === want && [gone, arch, snapOld, cacheOld].every((p) => !exists(p)), "真删的就是那四份");
    ok(exists(kept), "★反向对照★ 一个月没动、可会话里还记着它的 id（大小写不同也认）：留着，下一轮还要接着聊");
    ok(exists(young) && exists(snapNew) && exists(cacheNew), "★反向对照★ 新的线程、快照、缓存留着");
    ok(fs.lstatSync(path.join(home, "auth.json")).isSymbolicLink() && fs.readFileSync(userAuth, "utf8").includes("占位"),
      "★反向对照★ auth.json 软链和它指向的登录态原样在（删了等于把用户命令行里的 Codex 一起登出）");
    ok(untouched.every(exists), "★反向对照★ plugins、sqlite、config.toml、名字对不上的文件，四百天也不碰");
  }

  console.log("\n【9】运维指标：闲着时十分钟一行，只留 3 个月");
  {
    const { isIdle, shouldWrite, KEEP_MONTHS, IDLE_EVERY_MS } = metrics._internals;
    const idle = { tasks: 0, model_calls: 0, tokens: 0, http_5xx: 0, active_runs: 0, rss_mb: 180, disk_free_pct: 40 };
    ok(isIdle(idle), "只有内存、磁盘这类读数的一分钟算闲（它们每分钟都有值，拿来判就永远不闲）");
    ok(!isIdle({ ...idle, active_runs: 1 }) && !isIdle({ ...idle, tasks: 1 }) && !isIdle({ ...idle, http_5xx: 2 }),
      "★反向对照★ 有任务在跑、这分钟跑完一趟、出过 5xx：都不算闲");
    ok(shouldWrite({ ...idle, tokens: 5 }, { at: NOW, idle: true }, NOW + 1000), "有事的一分钟：一行不落");
    ok(shouldWrite(idle, { at: NOW, idle: false }, NOW + 1000), "忙转闲的头一行照落（看得见降回 0）");
    ok(!shouldWrite(idle, { at: NOW, idle: true }, NOW + IDLE_EVERY_MS - 1), "闲着、离上一行不满十分钟：不落");
    ok(shouldWrite(idle, { at: NOW, idle: true }, NOW + IDLE_EVERY_MS), "★反向对照★ 闲着满十分钟：落一行（不是闲了就一行都没有）");
    ok(KEEP_MONTHS === 3, "分片只留 3 个月", KEEP_MONTHS);
  }

  console.log("\n【10】IM「清空上下文」：正本旁边的 .bak / .corrupt 一起走，别人的那段不碰");
  {
    const dir = fresh("im");
    const P = (n) => path.join(dir, n);
    const msg = JSON.stringify([{ role: "user", content: "你好" }]);
    for (const n of ["alice.json", "alice.json.bak", "bob.json", "bob.json.bak"]) put(P(n), msg);
    put(P("alice.json.corrupt"), "x"); put(P("gone.json.bak"), msg); put(P("notes.txt"), "用户的");
    const im = createImSessionStore({ dir });
    const n = im.clear((k) => k === "alice");
    ok(n === 1 && !exists(P("alice.json")) && !exists(P("alice.json.bak")) && !exists(P("alice.json.corrupt")),
      "按人清：alice 的正本、.bak、.corrupt 全走（以前 .bak 留着，清掉的对话原样躺在盘上）");
    ok(exists(P("bob.json")) && exists(P("bob.json.bak")) && exists(P("gone.json.bak")), "★反向对照★ bob 的两份、不归 alice 的孤儿 .bak 都在");
    im.clear();
    ok(!exists(P("bob.json")) && !exists(P("bob.json.bak")) && !exists(P("gone.json.bak")), "全清：剩下的正本、.bak、孤儿 .bak 一起走");
    ok(exists(P("notes.txt")), "★反向对照★ 不是会话文件的，全清也不碰");
  }

  console.log("\n【11】备份包：能重新生成的不进包，真 tar 打一遍看包里有什么");
  {
    const lit = (SRC.match(/const BACKUP_EXCLUDES = (\[[\s\S]*?\]);/) || [])[1];
    const EX = lit ? new Function("return " + lit)() : [];
    ok(EX.length === 5 && EX.every((p) => /^data\//.test(p)), "server.js 里有 BACKUP_EXCLUDES 这张单子，都从顶层 data/ 算", EX);
    ok(/backupExcludeArgs\(\)\.then\(\(excludes\) => [^\n]*\n\s*"tar", \["-czf", path\.join\(BACKUP_DIR, name\), \.\.\.excludes, "-C"/.test(SRC)
      && /tarExcludeArgs\(v, BACKUP_EXCLUDES\)/.test(SRC),
    "打包命令用的是按本机 tar 换算过的那组参数，而且摆在文件参数前面（GNU tar 规定 --exclude 只管后面的参数）");
    const { tarExcludeArgs } = require(mod("backup-auto"));
    const bsd = tarExcludeArgs("bsdtar 3.5.3 - libarchive 3.7.4 zlib/1.2.12", EX);
    const gnu = tarExcludeArgs("tar (GNU tar) 1.35\nCopyright (C) 2023 Free Software Foundation, Inc.", EX);
    ok(bsd.length === 5 && bsd.every((a) => a.startsWith("--exclude=^data/")), "bsdtar：每条前面加 ^ 锚定开头", bsd);
    ok(gnu[0] === "--anchored" && gnu.slice(1).every((a, i) => a === "--exclude=" + EX[i]), "GNU tar：--anchored 打头，模式原样（它不认 ^）", gnu);
    ok(tarExcludeArgs("BusyBox v1.36.1", EX).length === 0 && tarExcludeArgs("", EX).length === 0,
      "★反向对照★ 认不出是哪家 tar、没问到版本：一个都不排除（包大一点，不少东西）");
    const probe = spawnSync("tar", ["--version"], { encoding: "utf8" });
    const ARGS = probe.error ? [] : tarExcludeArgs(probe.stdout, EX);
    if (probe.error) console.log("  ⏭  这台机器没有 tar，跳过真打包那段");
    else if (!ARGS.length) console.log("  ⏭  认不出这台机器的 tar（" + String(probe.stdout).split("\n")[0] + "），跳过真打包那段");
    else {
      const root = fresh("tar");
      // 用户自己写的技能 skills/x/ 底下也有个 data/，里面的名字跟我们的派生数据撞了——这些是用户的，一个都不许漏
      const skillData = ["skills/x/data/metrics/m.jsonl", "skills/x/data/thumbs/t.png", "skills/x/data/s.json.bak",
        "skills/x/data/runtime/codex/cache/k.bin", "skills/x/data/compact-archive/c.json"];
      const files = ["data/sessions/a.json", "data/sessions/a.json.bak", "data/thumbs/x.png", "data/compact-archive/1727000000000.json",
        "data/runtime/codex/cache/c.json", "data/runtime/codex/sessions/r.jsonl", "data/metrics/2026-09.jsonl", "data/usage.json.bak",
        "data/traces.jsonl.bak", "data/orgs.json.bak-1727000000000", "data/metrics-alerts.json", "data/thumbsup.txt", "prefs/p.json", "prefs/p.json.bak",
        "skills/x/SKILL.md", ...skillData];
      for (const f of files) put(path.join(root, "src", f), "x");
      const pack = (args, out) => {
        const r = spawnSync("tar", ["-czf", out, ...args, "-C", path.join(root, "src"), "data", "prefs", "skills/x"], { encoding: "utf8" });
        const list = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout.split("\n").map((s) => s.replace(/^\.\//, "").replace(/\/$/, "")).filter(Boolean);
        return { r, list, has: (p) => list.includes(p) };
      };
      const { r, list, has } = pack(ARGS, path.join(root, "b.tar.gz"));
      ok(r.status === 0, "tar 打包成功（" + String(probe.stdout).split("\n")[0].trim() + "）", r.stderr);
      ok(["data/sessions/a.json.bak", "data/thumbs/x.png", "data/compact-archive/1727000000000.json", "data/runtime/codex/cache/c.json",
        "data/metrics/2026-09.jsonl", "data/usage.json.bak"].every((p) => !has(p)), "缩略图、.json.bak、压缩归档、codex 缓存、运维指标都没进包",
      list.filter((p) => /^data\/.*(thumbs\/|\.json\.bak$|compact-archive\/|codex\/cache\/|metrics\/)/.test(p)));
      ok(["data/sessions/a.json", "data/runtime/codex/sessions/r.jsonl", "data/traces.jsonl.bak", "data/orgs.json.bak-1727000000000",
        "data/metrics-alerts.json", "data/thumbsup.txt", "prefs/p.json", "prefs/p.json.bak"].every(has),
      "★反向对照★ 会话正本、codex 线程、名字只是相近的（thumbsup.txt、metrics-alerts.json）、data/ 以外的 .bak 全在包里",
      list);
      ok(["skills/x/SKILL.md", ...skillData].every(has), "用户技能 skills/x/data/ 底下同名的 metrics、thumbs、.json.bak、codex 缓存、压缩归档全在包里",
        skillData.filter((p) => !has(p)));
      // ★反向对照★ 改之前那组不锚定的参数：技能里撞名的那几样一样不剩，打包照样成功、一个字都不说
      const old = pack(EX.map((p) => "--exclude=" + p), path.join(root, "old.tar.gz"));
      ok(old.r.status === 0 && skillData.every((p) => !old.has(p)) && old.has("skills/x/SKILL.md"),
        "★反向对照★ 换回不锚定的老参数：技能里撞名的五样全被漏打，tar 还照样报成功", skillData.filter((p) => old.has(p)));
    }
  }

  console.log("\n【12】/api 的 GET 默认 no-store，要缓存的路由自己盖得掉");
  {
    const at = SRC.indexOf("/api 的 GET 默认 no-store");
    const from = SRC.indexOf("app.use((req, res, next) => {", at);
    const to = SRC.indexOf("\n});", from) + 4;
    ok(at > 0 && from > at && to > from, "server.js 里找到这层中间件");
    const firstApi = SRC.search(/app\.(get|post)\("\/api\//);
    ok(from < firstApi, "它挂在第一条 /api 路由前面（挂在后面就等于没挂）");
    const express = require(path.join(ROOT, "node_modules", "express"));
    const app = express();
    new Function("app", SRC.slice(from, to))(app);
    const file = put(path.join(fresh("http"), "x.txt"), "hello");
    app.get("/api/plain", (_q, res) => res.json({ ok: 1 }));
    app.get("/api/file", (_q, res) => res.sendFile(file));
    app.get("/api/files/view/x", (_q, res) => { res.set("Cache-Control", "private, max-age=604800, immutable"); res.sendFile(file); });
    app.post("/api/post", (_q, res) => res.json({ ok: 1 }));
    app.get("/index.html", (_q, res) => res.send("page"));
    const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const port = srv.address().port;
    const hit = (method, p) => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: p, method }, (res) => { res.resume(); res.on("end", () => resolve(res.headers["cache-control"])); });
      req.on("error", reject); req.end();
    });
    try {
      ok(await hit("GET", "/api/plain") === "no-store", "GET /api/…（JSON）：no-store，Chromium 不往盘上的 HTTP 缓存里落");
      ok(await hit("GET", "/api/file") === "no-store", "GET /api/… 走 sendFile：no-store 没被它那句 public, max-age=0 盖掉");
      ok(await hit("GET", "/api/files/view/x") === "private, max-age=604800, immutable", "★反向对照★ 带对版本号的预览：路由自己设的长期缓存照样生效");
      ok(await hit("POST", "/api/post") === undefined, "★反向对照★ POST 不加（本来就不进缓存）");
      ok(await hit("GET", "/index.html") !== "no-store", "★反向对照★ 静态页不归它管");
    } finally { srv.close(); }
  }

  console.log("\n【13】开机那趟清理：一分钟后在后台跑，之后每天一次，都不拖着进程不退");
  {
    ok(/setTimeout\(sweep, 60 \* 1000\)\.unref\(\);/.test(SRC) && /setInterval\(sweep, 24 \* 3600 \* 1000\)\.unref\(\);/.test(SRC),
      "server.js 挂了开机一分钟后 + 每天一次，都 unref");
    ok(/require\("\.\/retention"\)\.sweepAll\(\{ dataDir: dataPath\("data"\)/.test(SRC), "清的是数据目录下的 data/，不是别处");
  }

  console.log("\n【14】成果文件夹的 .tmp/ 草稿区：三天没动过的才清，「动没动过」按里面最新的那一项算");
  {
    // 2026-09-29 复审：原来按目录自己的 mtime 判，可往已有文件里接着写、在更深一层加东西，目录 mtime 都不变——
    // 三天前建的 .tmp/venv 今天还在用，整棵被删
    const from = SRC.indexOf("const TASK_TMP_SCAN_MAX");
    const to = SRC.indexOf("function cacheStats() {", from);
    const body = from > 0 && to > from ? SRC.slice(from, to) : "";
    ok(!!body && /async function pruneTaskTmp\(taskAbs\)/.test(body) && /async function touchedSince\(/.test(body), "server.js 里切得到 pruneTaskTmp 和 touchedSince");
    ok(/pruneTaskTmp\(path\.join\(getWorkspaceDir\(\), taskBaseDir\)\)\.catch\(/.test(SRC), "收尾处不等它：异步翻，出了错也不冒到收尾里");
    ok(!/Sync\(/.test(body), "翻目录、删目录一个同步调用都没有（收尾在 Electron 主进程上，同步翻 node_modules 整个应用陪着卡）", (body.match(/\w+Sync\(/g) || []));
    const load = (max) => new Function("fs", "path", body.replace(/const TASK_TMP_SCAN_MAX = \d+;/, `const TASK_TMP_SCAN_MAX = ${max};`) + "\nreturn pruneTaskTmp;")(fs, path);
    const realMax = Number((/const TASK_TMP_SCAN_MAX = (\d+);/.exec(body) || [])[1] || 0);
    // 改之前那一版，原样抄在这儿当反向对照
    const oldPrune = (taskAbs) => {
      const dir = path.join(taskAbs, ".tmp");
      const dead = Date.now() - 3 * DAY;
      let list = [];
      try { list = fs.readdirSync(dir); } catch { return; }
      for (const n of list) {
        const fp = path.join(dir, n);
        try {
          const st = fs.lstatSync(fp);
          if (st.mtimeMs >= dead) continue;
          if (st.isSymbolicLink()) fs.unlinkSync(fp); else fs.rmSync(fp, { recursive: true, force: true });
        } catch {}
      }
    };
    const OLD = 4 * DAY;
    const lage = (p, ms) => { const t = new Date(NOW - ms); fs.lutimesSync(p, t, t); };
    /** 摆一份草稿区：文件先写、mtime 先拨，目录最后拨（往目录里建东西会把目录 mtime 刷新） */
    const mk = () => {
      const root = fresh("tasktmp");
      const task = path.join(root, "任务_做表"), T = path.join(task, ".tmp");
      const out = path.join(root, "外面"); // 软链指着的地方：今天刚写过，绝不能被跟进去删
      put(path.join(out, "keep.txt"), "用户的");
      put(path.join(T, "old.png"), "x", OLD);
      put(path.join(T, "new.png"), "x", 1 * DAY);
      put(path.join(T, "venv", "lib", "a.py"), "x", OLD);
      put(path.join(T, "venv", "lib", "b.py"), "今天刚改过"); // 深一层今天写过：目录 mtime 不会跟着变
      put(path.join(T, "stale", "deep", "x.txt"), "x", OLD);
      fs.mkdirSync(path.join(T, "linked"));
      fs.symlinkSync(out, path.join(T, "linked", "out"));
      lage(path.join(T, "linked", "out"), OLD);
      fs.symlinkSync(out, path.join(T, "ln-top"));
      lage(path.join(T, "ln-top"), OLD);
      for (let i = 0; i < 60; i++) put(path.join(T, "big", `f${i}.txt`), "x", OLD);
      for (const d of ["venv/lib", "venv", "stale/deep", "stale", "linked", "big"]) age(path.join(T, d), OLD);
      return { task, T, out };
    };
    const has = (T, rel) => exists(path.join(T, rel));

    let F = mk();
    await load(50)(F.task);
    ok(!has(F.T, "old.png") && !has(F.T, "stale"), "四天没动过的文件、整棵都旧的目录：清掉");
    ok(has(F.T, "new.png"), "★反向对照★ 昨天的文件留着");
    ok(has(F.T, "venv/lib/a.py") && has(F.T, "venv/lib/b.py"), "★目录自己四天没变、深一层今天写过：整棵留着，连里面旧的那个 a.py 也不动★");
    ok(!has(F.T, "linked") && !has(F.T, "ln-top") && exists(path.join(F.out, "keep.txt")),
      "软链只看它自己：链接跟装着链接的旧目录都清了，指着的那边（今天刚写过）一个字节不碰");
    ok(has(F.T, "big/f0.txt"), "翻了上限那么多项还没翻完（这里调成 50，放了 60 个）：按还在用算，留着");
    await load(realMax)(F.task);
    ok(realMax >= 1000 && !has(F.T, "big"), "★反向对照★ 同一棵换回真上限（" + realMax + "）翻得完、全是旧的：清掉", realMax);
    ok(has(F.T, "venv/lib/b.py"), "  └ venv 还在");

    F = mk();
    oldPrune(F.task);
    ok(!has(F.T, "venv"), "★反向对照★ 改之前按目录自己的 mtime 判：同一份草稿区里今天还在写的 venv 整棵被删");
    ok(exists(path.join(F.out, "keep.txt")), "  └ 老版本也没跟软链（这一条两边一样）");

    const empty = path.join(fresh("tasktmp"), "任务_空");
    fs.mkdirSync(empty, { recursive: true });
    await load(realMax)(empty);
    ok(!exists(path.join(empty, ".tmp")), "没有 .tmp/ 的成果文件夹：什么都不做、不报错，也不替它建一个");
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
