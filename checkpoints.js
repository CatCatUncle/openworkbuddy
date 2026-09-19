"use strict";
/**
 * 文件检查点：write_file / edit_file 落盘之前，把「改之前」的内容存一份，事后能整步退回去。
 *
 * 为什么不是 git：用户的工作目录多半不是仓库（一堆 docx、xlsx、mp4），而且就算是仓库，
 * 「把 agent 第 7 步改坏的那个文件退回第 7 步之前」和「git checkout」也不是一回事——
 * 前者只该动这一个会话碰过的文件，别人的、用户自己手改的都不许碰。
 *
 * 存法：内容寻址。改之前的全文按 sha256 存进 workspace/.history/objects/<hash>，
 * 同一份内容只存一次（改十次、退十次，中间态多半重复）。账本 .history/checkpoints.jsonl
 * 一行一次改动：{ id, ts, session, call, tool, rel, before, after, size }，before/after 是
 * 对象 hash，null 表示「那时文件不存在」——所以「新建」退回去就是删掉，「删掉」退回去就是写回。
 *
 * 回退本身也记一行（tool: "rewind"），所以退错了还能再退回来，账上一笔不缺。
 *
 * 安全：账本躺在工作目录里，模型是写得到的。所以回退时从不信账本里的路径——
 * 一律 path.resolve(root, rel) 后校验仍在 root 之内，出去的一律拒。对象内容只往 root 里写。
 * 工作目录之外的文件（白名单放行的那些）不留检查点：diff 照样给看，但退不回去，账上如实不记。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = ".history";
const OBJ = "objects";
const LEDGER = "checkpoints.jsonl";
const MAX_SNAPSHOT = 32 * 1024 * 1024; // 再大的多半不是 write_file 写得出来的文本，不存
const KEEP_DAYS = 30;
const GC_EVERY_MS = 60 * 60 * 1000;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const objPath = (root, hash) => path.join(root, DIR, OBJ, hash);
const ledgerPath = (root) => path.join(root, DIR, LEDGER);

/** 相对路径必须落在 root 里；.history 自己不许当检查点（账本改账本，越退越乱） */
function insideRoot(root, rel) {
  const r = path.resolve(root);
  const p = path.resolve(r, String(rel || ""));
  if (p === r || !p.startsWith(r + path.sep)) return null;
  if (path.relative(r, p).split(path.sep)[0] === DIR) return null;
  return p;
}

function relOf(root, abs) {
  const r = path.resolve(root);
  const p = path.resolve(abs);
  if (!p.startsWith(r + path.sep)) return null;
  return path.relative(r, p).split(path.sep).join("/");
}

/** 把一段内容存成对象，返回 hash。已有就不重写（内容寻址，同 hash 必同内容） */
function putObject(root, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (buf.length > MAX_SNAPSHOT) return null;
  const hash = sha(buf);
  const p = objPath(root, hash);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 先写临时名再改名：两个任务同时存同一份内容，谁都不会读到半截
    const tmp = p + "." + process.pid + "." + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(tmp, buf);
    try { fs.renameSync(tmp, p); } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
  }
  return hash;
}

function readObject(root, hash) {
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  try { return fs.readFileSync(objPath(root, hash)); } catch { return null; }
}

function readLedger(root) {
  let raw = "";
  try { raw = fs.readFileSync(ledgerPath(root), "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && e.id) out.push(e); } catch {} // 半截行（写到一半断电）跳过，别让一行坏账废掉整本
  }
  return out;
}

function appendLedger(root, entry) {
  const p = ledgerPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
}

const lastGc = new Map(); // root → 上次清理时间；一小时最多一次，别让每次写文件都去扫目录

/**
 * 记一次改动。before / after 传内容（字符串或 Buffer），不存在传 null。
 * 返回账本条目（含 id），文件在工作目录之外或存不下时返回 null——调用方照常干活，只是这步退不回去。
 */
function record(root, { session = "", call = "", tool = "", abs, rel, before, after }) {
  try {
    const r = path.resolve(root);
    const relPath = abs ? relOf(r, abs) : String(rel || "").replace(/\\/g, "/");
    if (!relPath || !insideRoot(r, relPath)) return null;
    const b = before == null ? null : putObject(r, before);
    const a = after == null ? null : putObject(r, after);
    if ((before != null && !b) || (after != null && !a)) return null;
    if (b === a) return null; // 内容没变（比如 edit_file 的 new_text 和 old_text 一样）不占账
    const entry = {
      id: "ck_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      ts: new Date().toISOString(),
      session: String(session || ""),
      call: String(call || ""),
      tool: String(tool || ""),
      rel: relPath,
      before: b,
      after: a,
      size: after == null ? 0 : Buffer.byteLength(after),
    };
    appendLedger(r, entry);
    const t = lastGc.get(r) || 0;
    if (Date.now() - t > GC_EVERY_MS) { lastGc.set(r, Date.now()); try { gc(r); } catch {} }
    return entry;
  } catch {
    return null; // 留底失败不能挡住写文件本身：用户要的是文件先写对
  }
}

function fileHash(abs) {
  try { return sha(fs.readFileSync(abs)); } catch { return null; }
}

/** 这个会话记过的改动，按时间正序。每条附上 `current`：现在盘上是不是还是改完那个样子 */
function list(root, session) {
  const r = path.resolve(root);
  const rows = readLedger(r).filter((e) => !session || e.session === session);
  return rows.map((e) => {
    const abs = insideRoot(r, e.rel);
    const now = abs ? fileHash(abs) : null;
    return { ...e, current: now === (e.after || null) ? "same" : now == null && !e.after ? "same" : "changed" };
  });
}

/**
 * 退回到某一步之前：把这个会话从那一步（含）起动过的每个文件，恢复成那一步之前的样子。
 * 只认 session + id 两把钥匙都对得上的那一条，别人的会话拿着 id 也退不了。
 *
 * 每个文件只写一次：目标是它在这段范围里**最早那条**的 before，中间态不用挨个重放。
 * 恢复动作本身逐条记账（tool: "rewind"），退错了拿返回的 id 再退一次就回来了。
 */
function rewind(root, session, id) {
  const r = path.resolve(root);
  const all = readLedger(r);
  const at = all.findIndex((e) => e.id === id && e.session === session);
  if (at < 0) return { ok: false, error: "没有这个检查点（可能账本被清理过，或者它不属于这个会话）" };
  const range = all.slice(at).filter((e) => e.session === session);
  const target = new Map(); // rel → 最早那条的 before
  for (const e of range) if (!target.has(e.rel)) target.set(e.rel, e.before);
  const rid = "rw_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const files = [];
  for (const [rel, want] of target) {
    const abs = insideRoot(r, rel);
    if (!abs) { files.push({ rel, action: "refused", why: "路径不在工作目录里" }); continue; }
    const now = fileHash(abs);
    if ((now || null) === (want || null)) { files.push({ rel, action: "unchanged" }); continue; }
    let content = null;
    if (want) {
      content = readObject(r, want);
      if (!content) { files.push({ rel, action: "missing", why: "改之前那份内容已经不在了（超过保留期被清理）" }); continue; }
    }
    // 盘上现在这份也先存起来：退回去之后想再退回来，靠的就是这一条
    let nowContent = null;
    try { nowContent = fs.readFileSync(abs); } catch {}
    try {
      if (content == null) fs.rmSync(abs, { force: true });
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
    } catch (e) {
      files.push({ rel, action: "failed", why: e.message });
      continue;
    }
    const entry = record(r, { session, call: rid, tool: "rewind", rel, before: nowContent, after: content });
    files.push({ rel, action: content == null ? "deleted" : "restored", ...(entry ? { id: entry.id } : {}) });
  }
  const undoId = (files.find((f) => f.id) || {}).id || "";
  return { ok: true, id: rid, undo: undoId, files };
}

/** 清理：账本里超过保留期的条目删掉，再把没人引用的对象删掉。返回删了多少 */
function gc(root, { keepDays = KEEP_DAYS, now = Date.now() } = {}) {
  const r = path.resolve(root);
  const all = readLedger(r);
  if (!all.length) return { entries: 0, objects: 0 };
  const cutoff = now - keepDays * 86400000;
  const keep = all.filter((e) => Date.parse(e.ts) >= cutoff);
  if (keep.length !== all.length) {
    const p = ledgerPath(r);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, p);
  }
  const used = new Set();
  for (const e of keep) { if (e.before) used.add(e.before); if (e.after) used.add(e.after); }
  let objects = 0;
  const dir = path.join(r, DIR, OBJ);
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const n of names) {
    if (/^[0-9a-f]{64}$/.test(n) && !used.has(n)) { try { fs.rmSync(path.join(dir, n), { force: true }); objects++; } catch {} }
  }
  return { entries: all.length - keep.length, objects };
}

// ---------- diff ----------
//
// 给人看的，不是给 patch 用的：改文件前弹审批时、改完之后的过程卡上，一眼看清动了哪几行。
// 先掐掉两头没变的行，中间那段 O(mn) 求最长公共子序列——edit_file 的改动是局部的，
// 中间那段通常就几行到几十行；整篇重写的中间段太长（超过 LCS_LIMIT）就直接「全删全加」，
// 不在一次审批等待里烧 CPU。

const LCS_LIMIT = 4_000_000; // m*n 上限：2000×2000 行，Uint16 表 8 MB，几十毫秒

function splitLines(s) {
  const t = String(s == null ? "" : s);
  if (!t) return [];
  const lines = t.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // 末尾换行不算多一行
  return lines;
}

/** 返回 [op, line] 列表，op ∈ " " | "-" | "+" */
function diffLines(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ma = a.slice(s, ea), mb = b.slice(s, eb);
  const ops = [];
  for (let i = 0; i < s; i++) ops.push([" ", a[i]]);
  if (ma.length && mb.length && ma.length * mb.length <= LCS_LIMIT) {
    const m = ma.length, n = mb.length;
    const W = n + 1;
    const T = new Uint16Array((m + 1) * W);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        T[i * W + j] = ma[i] === mb[j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (ma[i] === mb[j]) { ops.push([" ", ma[i]]); i++; j++; }
      else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) ops.push(["-", ma[i++]]);
      else ops.push(["+", mb[j++]]);
    }
    while (i < m) ops.push(["-", ma[i++]]);
    while (j < n) ops.push(["+", mb[j++]]);
  } else {
    for (const l of ma) ops.push(["-", l]);
    for (const l of mb) ops.push(["+", l]);
  }
  for (let i = ea; i < a.length; i++) ops.push([" ", a[i]]);
  return ops;
}

/**
 * 统一格式的 diff 文本（@@ 行 + 上下文各 context 行）。超过 maxLines 行就截断并说明还有多少没显示。
 * 两边一样返回空串。
 */
function unifiedDiff(before, after, { name = "", context = 2, maxLines = 120 } = {}) {
  const a = splitLines(before), b = splitLines(after);
  if (a.length === b.length && a.every((l, i) => l === b[i])) return "";
  const ops = diffLines(a, b);
  // 找出每个改动块，带上下文合并成 hunk
  const hunks = [];
  let cur = null;
  let ai = 0, bi = 0; // 当前 op 在 a / b 里的行号（1 起）
  const rows = ops.map(([op, line]) => {
    const row = { op, line, a: op === "+" ? 0 : ++ai, b: op === "-" ? 0 : ++bi };
    return row;
  });
  const changed = rows.map((r) => r.op !== " ");
  let k = 0;
  while (k < rows.length) {
    if (!changed[k]) { k++; continue; }
    const start = Math.max(0, k - context);
    let end = k;
    while (end < rows.length) {
      if (changed[end]) { end++; continue; }
      // 往后看 context*2 行内还有改动就并进同一块
      let next = end;
      while (next < rows.length && !changed[next] && next - end < context * 2) next++;
      if (next < rows.length && changed[next]) { end = next; continue; }
      break;
    }
    end = Math.min(rows.length, end + context);
    cur = rows.slice(start, end);
    hunks.push(cur);
    k = end;
  }
  const out = [];
  if (name) out.push(`--- ${name}`, `+++ ${name}`);
  let shown = 0, hidden = 0;
  for (const h of hunks) {
    const aStart = (h.find((r) => r.a) || {}).a || (a.length ? 1 : 0);
    const bStart = (h.find((r) => r.b) || {}).b || (b.length ? 1 : 0);
    const aLen = h.filter((r) => r.op !== "+").length, bLen = h.filter((r) => r.op !== "-").length;
    const head = `@@ -${aStart},${aLen} +${bStart},${bLen} @@`;
    if (shown >= maxLines) { hidden += h.length + 1; continue; }
    out.push(head); shown++;
    for (const r of h) {
      if (shown >= maxLines) { hidden++; continue; }
      out.push(r.op + r.line); shown++;
    }
  }
  if (hidden) out.push(`… 还有 ${hidden} 行没显示`);
  return out.join("\n");
}

/** 一句话摘要：「+3 −1 行」。给过程卡那一行和 CLI 用 */
function summarize(before, after) {
  const ops = diffLines(splitLines(before), splitLines(after));
  let add = 0, del = 0;
  for (const [op] of ops) { if (op === "+") add++; else if (op === "-") del++; }
  return { add, del, text: `+${add} −${del} 行` };
}

module.exports = { record, list, rewind, gc, unifiedDiff, summarize, _internals: { diffLines, splitLines, insideRoot, relOf, putObject, readObject, readLedger, ledgerPath, objPath, DIR } };
