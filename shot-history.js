"use strict";
/**
 * 分镜节点的版本快照 + 一键恢复。
 *
 * 要治的是这一件事：改一句台词、重跑一下，上一版的首帧被同名文件盖掉了，找不回来。
 * 光记路径没用——路径还是那个路径，里头的字节已经换人了。所以快照存的是**字节本身**：
 * 首帧 / 尾帧 / 视频 / 配音按 sha256 存进 objects/，同一份内容只占一份（重跑十次退十次，
 * 中间态多半重复）。
 *
 * 分镜表是唯一真源，所以恢复是「把这一镜整个换回那一版」，不是合并：合并会留下
 * 上一版的视频配这一版的首帧那种四不像，而且它在界面上跟成功长得一模一样。
 *
 * 恢复之前先给现在这一版拍一张，所以退错了还能再退回来。
 *
 * 安全：账本躺在工作目录里，模型写得到。所以从不信账本里的路径——一律 resolve 回 root
 * 再校验，出去的一律拒；字节也只往 root 里写。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(".openworkbuddy", "shot-history");
const OBJ = "objects";
const MAX_BLOB = 96 * 1024 * 1024;              // 一镜的视频再长也该在这之下；超了不留底，但如实记账
const KEEP_PER_SHOT = 12;
const KEEP_DAYS = 90;
const MAX_STORE = 4 * 1024 * 1024 * 1024;       // 留底不该把用户的盘吃光，超了从最旧的版本开始扔
const GC_EVERY_MS = 60 * 60 * 1000;
const BOARD_MAX = 4 * 1024 * 1024;              // 跟 server.js 的分镜表上限一个数

/** 指着一个文件的字段——只有这些要连字节一起留 */
const MEDIA_FIELDS = {
  shot: ["first_frame", "last_frame", "video", "audio"],
  character: ["ref"],
};

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const storeDir = (root) => path.join(root, DIR);
// 账本是工作目录里一个纯文本，模型写得到。hash 是唯一进到路径里的那截，所以只认 64 位十六进制——
// 手改成 ../../../etc/passwd 也拼不出一个跳得出 objects/ 的路径，直接当「这一版没留下」
const objPath = (root, hash) => (/^[0-9a-f]{64}$/.test(String(hash || "")) ? path.join(storeDir(root), OBJ, hash) : "");
const boardKey = (board) => sha(Buffer.from(String(board), "utf8")).slice(0, 32);
const ledgerPath = (root, board) => path.join(storeDir(root), "boards", boardKey(board) + ".jsonl");

/** 相对路径必须落在 root 里；留底目录自己不许被当成素材（账本改账本，越退越乱） */
function insideRoot(root, rel) {
  const r = path.resolve(root);
  const p = path.resolve(r, String(rel || ""));
  if (p === r || !p.startsWith(r + path.sep)) return null;
  const parts = path.relative(r, p).split(path.sep);
  if (parts[0] === ".openworkbuddy") return null;
  return p;
}

/** 这个文件现在是什么内容。留不下的如实说是哪一种留不下，别混成一句「失败」 */
function probeFile(root, rel) {
  const abs = insideRoot(root, rel);
  if (!abs) return { skip: "outside" };
  let stat;
  try { stat = fs.statSync(abs); } catch { return { skip: "gone" }; }
  if (!stat.isFile()) return { skip: "gone" };
  if (stat.size > MAX_BLOB) return { skip: "toobig", bytes: stat.size };
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return { skip: "failed" }; }
  return { hash: sha(buf), bytes: buf.length, buf };
}

/** 探一遍并把字节真存下来。只有拍快照走这条，列版本走 probeFile——列一下不该往盘上灌东西 */
function putFile(root, rel) {
  const got = probeFile(root, rel);
  if (got.skip) return got;
  const { hash, bytes, buf } = got;
  const p = objPath(root, hash);
  if (!fs.existsSync(p)) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + "." + process.pid + "." + Math.random().toString(36).slice(2, 8);
      fs.writeFileSync(tmp, buf);
      try { fs.renameSync(tmp, p); } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
    } catch { return { skip: "failed" }; }
  }
  return { hash, bytes };
}

function readLedger(root, board) {
  let raw = "";
  try { raw = fs.readFileSync(ledgerPath(root, board), "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && e.id) out.push(e); } catch {} // 半截行（写到一半断电）跳过，别让一行坏账废掉整本
  }
  return out;
}

function appendLedger(root, board, entry) {
  const p = ledgerPath(root, board);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
}

/** 分镜表里叫这个名字的镜头 / 角色。返回全部命中，重号交给调用方去骂 */
function findTarget(data, kind, id) {
  const want = String(id || "");
  const hits = [];
  if (kind === "character") {
    for (const c of (Array.isArray(data && data.characters) ? data.characters : [])) {
      if (c && typeof c === "object" && (String(c.id || "") === want || String(c.name || "") === want)) hits.push(c);
    }
  } else {
    for (const s of (Array.isArray(data && data.scenes) ? data.scenes : [])) {
      for (const sh of (Array.isArray(s && s.shots) ? s.shots : [])) {
        if (sh && typeof sh === "object" && String(sh.id || "") === want) hits.push(sh);
      }
    }
  }
  return hits;
}

/** 字段顺序不是差别：前端把 key 重排一遍不该凭空多占一版，也不该在「改了什么」里冒出来 */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = stable(v[k]); return o; }
  return v;
}

/** 一版的指纹：字段一模一样、指着的字节也一模一样，就不算新的一版 */
function fingerprint(fields, blobs) {
  const b = {};
  for (const k of Object.keys(blobs).sort()) b[k] = blobs[k].hash || ("skip:" + blobs[k].skip + ":" + (blobs[k].rel || ""));
  return sha(Buffer.from(JSON.stringify({ f: stable(fields), b }), "utf8"));
}

const lastGc = new Map();

/**
 * 给这一镜当前的样子拍一张，**在改它之前调**。
 * 没这一镜、或者跟上一版一模一样，返回 null——调用方照常干活，只是这一步不占一版。
 */
function snapshot(root, { board, kind = "shot", id, data, why = "", session = "" } = {}) {
  try {
    const r = path.resolve(root);
    if (!board || !id || !data) return null;
    const hits = findTarget(data, kind, id);
    if (hits.length !== 1) return null;        // 查无此镜 / 重号：真源本身有问题，留底解决不了，交给调用方报
    const fields = JSON.parse(JSON.stringify(hits[0]));
    const blobs = {};
    for (const f of (MEDIA_FIELDS[kind] || [])) {
      const rel = typeof fields[f] === "string" ? fields[f].trim() : "";
      if (!rel) continue;
      blobs[f] = { rel, ...putFile(r, rel) };
    }
    const fp = fingerprint(fields, blobs);
    const all = readLedger(r, board);
    const prev = all.filter((e) => e.kind === kind && e.target === String(id)).pop();
    if (prev && prev.fp === fp) return null;   // 连点十次保存不该攒出十版
    const entry = {
      id: "sv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      ts: new Date().toISOString(),
      board: String(board), kind, target: String(id),
      why: String(why || ""), session: String(session || ""),
      fields, blobs, fp,
    };
    appendLedger(r, board, entry);
    const t = lastGc.get(r) || 0;
    if (Date.now() - t > GC_EVERY_MS) { lastGc.set(r, Date.now()); try { gc(r); } catch {} }
    return entry;
  } catch {
    return null; // 留底失败不能挡住改分镜表本身：用户要的是这一笔先写对
  }
}

/** 这一版的素材现在还回得来吗——回不来的要在界面上写清楚是哪一种回不来 */
function blobState(root, b) {
  if (!b) return null;
  if (b.skip) return { rel: b.rel, kept: false, why: b.skip === "toobig" ? "当时这个文件超过 96MB，没留底" : b.skip === "gone" ? "拍这一版的时候文件就已经不在了" : b.skip === "outside" ? "路径不在工作目录里" : "当时没读出来" };
  const p = objPath(root, b.hash);
  const ok = !!p && fs.existsSync(p);
  return { rel: b.rel, kept: ok, bytes: b.bytes || 0, ...(ok ? {} : { why: p ? "留底超过保留期被清掉了" : "账本里这一版的留底编号不对，认不出来" }) };
}

/**
 * 这一镜有过哪些版本，新的在前。
 * 传了 data 就顺手标出哪一版跟现在盘上一模一样——界面据此画「当前」那个点。
 */
function list(root, { board, kind = "shot", id, data = null } = {}) {
  const r = path.resolve(root);
  const rows = readLedger(r, board).filter((e) => e.kind === kind && e.target === String(id));
  let liveFp = "";
  if (data) {
    const hits = findTarget(data, kind, id);
    if (hits.length === 1) {
      const fields = JSON.parse(JSON.stringify(hits[0]));
      const blobs = {};
      for (const f of (MEDIA_FIELDS[kind] || [])) {
        const rel = typeof fields[f] === "string" ? fields[f].trim() : "";
        if (rel) { const { buf, ...rest } = probeFile(r, rel); blobs[f] = { rel, ...rest }; }
      }
      liveFp = fingerprint(fields, blobs);
    }
  }
  return rows.reverse().map((e) => {
    const files = {};
    for (const f of Object.keys(e.blobs || {})) files[f] = blobState(r, e.blobs[f]);
    return {
      id: e.id, ts: e.ts, why: e.why, session: e.session,
      fields: e.fields, files,
      restorable: Object.values(files).every((x) => x.kept),
      same: !!liveFp && liveFp === e.fp,
    };
  });
}

/** 两版之间人眼看得出的差别：哪些字段动了。给界面上那行「改了台词、首帧」用 */
function changed(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) if (JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k])) out.push(k);
  return out.sort();
}

/**
 * 一键回到某一版。
 *
 * 整镜回退，不是合并。字节回不来的那个字段是唯一的例外：它保持现在的值，
 * 并在返回里单列出来——宁可说「这一版的首帧找不回来了」，也不能让分镜表里写着
 * 老路径、盘上躺着新图，那种分家要等下次重跑白花一次钱才看得出来。
 */
function restore(root, { board, kind = "shot", id, version, session = "" } = {}) {
  const r = path.resolve(root);
  const abs = insideRoot(r, board);
  if (!abs) return { ok: false, error: "分镜表路径不在工作目录里" };
  let data;
  try { data = JSON.parse(fs.readFileSync(abs, "utf8")); }
  catch (e) { return { ok: false, error: "分镜表读不出来：" + e.message }; }
  const hits = findTarget(data, kind, id);
  const label = kind === "character" ? "角色" : "镜头";
  if (!hits.length) return { ok: false, error: `分镜表里没有${label} ${id}——它多半被改名或删掉了` };
  if (hits.length > 1) return { ok: false, error: `分镜表里有 ${hits.length} 个${label}都叫 ${id}，不替你猜是哪一个` };
  const entry = readLedger(r, board).find((e) => e.id === version && e.kind === kind && e.target === String(id));
  if (!entry) return { ok: false, error: "没有这一版（可能超过保留期被清理了，或者它不是这一镜的）" };

  const before = snapshot(r, { board, kind, id, data, why: `恢复到 ${entry.ts} 那一版之前`, session });
  // 没占新版说明现在这个样子账上已经有了，undo 指过去那一条就行，别交白卷让人退不回来
  const undoId = before ? before.id : (readLedger(r, board).filter((e) => e.kind === kind && e.target === String(id)).pop() || {}).id || "";

  const target = hits[0];
  const want = JSON.parse(JSON.stringify(entry.fields));
  const files = [];
  for (const f of (MEDIA_FIELDS[kind] || [])) {
    const b = (entry.blobs || {})[f];
    if (!b) continue;
    const dest = insideRoot(r, b.rel);
    if (!b.hash || !dest) { files.push({ field: f, rel: b.rel, action: "missing", why: b.skip === "toobig" ? "当时文件超过 96MB 没留底" : "留底不在了" }); want[f] = target[f]; continue; }
    let buf = null;
    try { buf = fs.readFileSync(objPath(r, b.hash)); } catch {}
    if (!buf) { files.push({ field: f, rel: b.rel, action: "missing", why: "留底超过保留期被清掉了" }); want[f] = target[f]; continue; }
    let now = null;
    try { now = fs.readFileSync(dest); } catch {}
    if (now && sha(now) === b.hash) { files.push({ field: f, rel: b.rel, action: "unchanged" }); continue; }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      files.push({ field: f, rel: b.rel, action: "restored", bytes: buf.length });
    } catch (e) {
      files.push({ field: f, rel: b.rel, action: "failed", why: e.message });
      want[f] = target[f];
    }
  }
  // 那一版没有的字段要真的没有：留着这一版的 video 配那一版的首帧，比什么都不恢复更坏
  for (const k of Object.keys(target)) if (!(k in want)) delete target[k];
  for (const k of Object.keys(want)) if (want[k] === undefined) delete want[k]; else target[k] = want[k];

  const raw = JSON.stringify(data, null, 2) + "\n";
  if (Buffer.byteLength(raw) > BOARD_MAX) return { ok: false, error: "恢复之后分镜表会超过 4MB 上限，没写" };
  try { fs.writeFileSync(abs, raw, "utf8"); }
  catch (e) { return { ok: false, error: "分镜表写不回去：" + e.message }; }

  return {
    ok: true, board: String(board), kind, target: String(id), version,
    undo: undoId,
    fields: JSON.parse(JSON.stringify(target)),
    changed: changed(entry.fields, want),
    files,
    partial: files.some((f) => f.action === "missing" || f.action === "failed"),
  };
}

/** 存了多少。界面上那句「留底占了 1.2 GB」用它 */
function usage(root) {
  const dir = path.join(path.resolve(root), DIR, OBJ);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { objects: 0, bytes: 0 }; }
  let bytes = 0, objects = 0;
  for (const n of names) {
    if (!/^[0-9a-f]{64}$/.test(n)) continue;
    try { bytes += fs.statSync(path.join(dir, n)).size; objects++; } catch {}
  }
  return { objects, bytes };
}

/**
 * 清理。三把尺子：过期的、每镜留够 KEEP_PER_SHOT 版之外的、以及整个留底超预算时从最旧的开始扔。
 * 每镜**最老那一版留死**——它是「一开始是什么样」，恰恰是最想退回去的那一版。
 */
function gc(root, { keepPerShot = KEEP_PER_SHOT, keepDays = KEEP_DAYS, maxStore = MAX_STORE, now = Date.now() } = {}) {
  const r = path.resolve(root);
  const dir = path.join(storeDir(r), "boards");
  let ledgers = [];
  try { ledgers = fs.readdirSync(dir).filter((n) => /\.jsonl$/.test(n)); } catch { return { entries: 0, objects: 0, bytes: 0 }; }
  const cutoff = now - keepDays * 86400000;
  const kept = new Map();  // 账本文件名 → 留下来的条目
  let dropped = 0;
  for (const n of ledgers) {
    const p = path.join(dir, n);
    let all = [];
    try { all = fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.id); } catch { continue; }
    const byShot = new Map();
    for (const e of all) { const k = e.kind + "\u0000" + e.target; if (!byShot.has(k)) byShot.set(k, []); byShot.get(k).push(e); }
    const keep = new Set();
    for (const rows of byShot.values()) {
      keep.add(rows[0].id);                                   // 最老那一版留死
      for (const e of rows.slice(-keepPerShot)) keep.add(e.id);
      for (const e of rows) if (Date.parse(e.ts) >= cutoff) keep.add(e.id);
    }
    kept.set(p, all.filter((e) => keep.has(e.id)));
    dropped += all.length - keep.size;
  }
  // 超预算：把最旧的整版扔掉，直到回到预算之内。按时间排，跨账本一起排
  const size = usage(r);
  if (size.bytes > maxStore) {
    const flat = [];
    for (const [p, rows] of kept) for (const e of rows) flat.push({ p, e, t: Date.parse(e.ts) || 0 });
    flat.sort((a, b) => a.t - b.t);
    const live = new Map(); // 账本 → 还留着的 id
    for (const [p, rows] of kept) live.set(p, new Set(rows.map((e) => e.id)));
    const firstOf = new Map();
    for (const { p, e } of flat) { const k = p + "\u0000" + e.kind + "\u0000" + e.target; if (!firstOf.has(k)) firstOf.set(k, e.id); }
    let est = size.bytes;
    for (const { p, e } of flat) {
      if (est <= maxStore) break;
      if (firstOf.get(p + "\u0000" + e.kind + "\u0000" + e.target) === e.id) continue; // 最老那一版还是留死
      for (const b of Object.values(e.blobs || {})) est -= b.bytes || 0;
      live.get(p).delete(e.id);
      dropped++;
    }
    for (const [p, ids] of live) kept.set(p, kept.get(p).filter((e) => ids.has(e.id)));
  }
  for (const [p, rows] of kept) {
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, rows.map((e) => JSON.stringify(e)).join("\n") + (rows.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, p);
  }
  const used = new Set();
  for (const rows of kept.values()) for (const e of rows) for (const b of Object.values(e.blobs || {})) if (b.hash) used.add(b.hash);
  let objects = 0, bytes = 0;
  const odir = path.join(storeDir(r), OBJ);
  let names = [];
  try { names = fs.readdirSync(odir); } catch {}
  for (const n of names) {
    if (!/^[0-9a-f]{64}$/.test(n) || used.has(n)) continue;
    try { bytes += fs.statSync(path.join(odir, n)).size; fs.rmSync(path.join(odir, n), { force: true }); objects++; } catch {}
  }
  return { entries: dropped, objects, bytes };
}

module.exports = {
  snapshot, list, restore, gc, usage, changed,
  MEDIA_FIELDS, KEEP_PER_SHOT, KEEP_DAYS, MAX_BLOB, MAX_STORE,
  _internals: { insideRoot, putFile, probeFile, readLedger, ledgerPath, objPath, findTarget, fingerprint, blobState, stable, DIR },
};
