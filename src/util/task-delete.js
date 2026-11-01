// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
// Only session-owned, generated folders are eligible. The request never supplies
// a filesystem path, and symlinks are never followed while counting or moving.
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { canonDir } = require("./task-dirs");
const LIMIT = 20000;
const under = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const overlap = (a, b) => under(a, b) || under(b, a);
const generated = rel => /^任务_\d{4}_[^/]+$/.test(rel) || /^IM_对话\/\d{4}_[^/]+$/.test(rel);
const peerCache = new Map();
async function readPeers(directory, live) {
  const peers = [], seen = new Set();
  const view = (id, s) => ({ id, root: s.root, dir: s.dir, dirs: s.dirs });
  for (const name of await fs.promises.readdir(directory)) {
    if (!/^[\w-]+\.json$/.test(name)) continue;
    const id = name.slice(0, -5), file = path.join(directory, name);
    seen.add(file);
    let st;
    try { st = await fs.promises.stat(file); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    let hit = peerCache.get(file);
    if (!hit || hit.mtime !== st.mtimeMs || hit.ctime !== st.ctimeMs || hit.ino !== st.ino || hit.size !== st.size) {
      const s = JSON.parse(await fs.promises.readFile(file, "utf8"));
      if (!s || typeof s !== "object") throw Error("部分任务的目录归属无法读取，请先仅删除对话记录");
      hit = { mtime: st.mtimeMs, ctime: st.ctimeMs, ino: st.ino, size: st.size, value: { id, root: s.root, dir: s.dir, dirs: s.dirs } };
      peerCache.set(file, hit);
    }
    peers.push(hit.value);
  }
  for (const key of peerCache.keys()) if (path.dirname(key) === directory && !seen.has(key)) peerCache.delete(key);
  // Both states matter: CLI may have changed the disk copy while the web cache
  // still has the old one; a running web task may not have saved its new folder
  // yet. Keeping both claims is conservative and prevents a stale cache from
  // making another task's folder look unowned.
  for (const [id, s] of live) peers.push(view(id, s));
  return peers;
}

function foldersOf(session, defaultRoot) {
  const out = [];
  if (session && session.dir) out.push({ root: session.root || defaultRoot, rel: session.dir });
  for (const [root, rel] of Object.entries(session && session.dirs || {})) if (rel) out.push({ root, rel });
  const seen = new Set();
  return out.filter(item => {
    if (typeof item.root !== "string" || typeof item.rel !== "string") return false;
    const key = canonDir(item.root) + "\0" + item.rel.replace(/\\/g, "/");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function resolveFolder(item) {
  const rel = item.rel.replace(/\\/g, "/");
  if (!generated(rel) || /[\u0000-\u001f]/.test(rel) || rel.split("/").some(p => p === "." || p === "..")) throw Error("不是此任务自动创建的独立文件夹");
  const root = fs.realpathSync(item.root);
  let full = root;
  for (const part of rel.split("/")) {
    full = path.join(full, part);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isDirectory()) throw Error("目录包含链接或已被替换，暂不清理");
  }
  const st = fs.lstatSync(full), real = fs.realpathSync(full);
  if (!under(canonDir(real), canonDir(root)) || canonDir(real) === canonDir(root)) throw Error("目录归属无法确认，暂不清理");
  return { root, rel, path: real, dev: String(st.dev), ino: String(st.ino), born: st.birthtimeMs };
}

async function countFolder(full, deadline = Date.now() + 500) {
  let files = 0, entries = 0, bytes = 0;
  const stack = [full];
  while (stack.length) {
    const dir = stack.pop();
    // opendir yields entries instead of allocating an enormous readdir array.
    for await (const entry of await fs.promises.opendir(dir)) {
      if (++entries > LIMIT || Date.now() > deadline) return { files, bytes, more: true };
      const name = path.join(dir, entry.name);
      const st = await fs.promises.lstat(name);
      if (st.isDirectory() && !st.isSymbolicLink()) stack.push(name);
      else { files++; bytes += st.size; }
    }
  }
  return { files, bytes, more: false };
}

async function plan({ id, session, defaultRoot, peers = [], protectedPaths = [], busyPaths = [], canAccess = () => true, count = true }) {
  const folders = [], retained = [];
  const deadline = Date.now() + 500;
  for (const raw of foldersOf(session, defaultRoot)) {
    try {
      if (!canAccess(raw.root)) throw Error("没有此任务目录的文件访问权限");
      const folder = resolveFolder(raw), key = canonDir(folder.path);
      if (protectedPaths.filter(Boolean).some(p => under(canonDir(p), key))) throw Error("该目录正在作为项目或工作目录使用，保留文件");
      if (session.kind === "schedule" || session.schedule_id) throw Error("定时任务共用的成果文件夹会保留");
      for (const peer of peers) {
        if (peer.id === id) continue;
        const places = foldersOf(peer, defaultRoot).map(p => path.resolve(p.root, p.rel));
        if (peer.root && under(canonDir(peer.root), key)) places.push(peer.root);
        if (places.some(p => overlap(canonDir(p), key))) throw Error("其他任务也在使用此文件夹，保留文件");
      }
      if (busyPaths.some(p => overlap(canonDir(p), key))) throw Error("此文件夹仍被运行中的任务使用，请稍后再试");
      folders.push({ ...folder, ...(count ? await countFolder(folder.path, deadline) : {}) });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      retained.push({ name: raw.rel, reason: error.message || "目录暂时无法访问" });
    }
  }
  return { folders, retained };
}

function sameFolder(a, b) {
  return canonDir(a.path) === canonDir(b.path) && a.dev === b.dev && a.ino === b.ino && a.born === b.born;
}

// A disappearing empty folder is harmless; a replacement, new folder, or newly
// shared folder requires a fresh confirmation. Never silently broaden consent.
function validatePlan(previous, current) {
  for (const folder of current.folders) if (!previous.folders.some(old => sameFolder(old, folder))) throw Error("任务文件夹已变化，请重新确认后删除");
  for (const old of previous.folders) {
    if (current.folders.some(folder => sameFolder(old, folder))) continue;
    try { fs.lstatSync(old.path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw Error("任务文件夹归属或使用状态已变化，请重新确认后删除");
  }
}

async function moveToLocalTrash(folder, id) {
  let trash = folder.root;
  for (const name of [".trash", "tasks"]) {
    trash = path.join(trash, name);
    try { await fs.promises.mkdir(trash); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const st = await fs.promises.lstat(trash);
    if (st.isSymbolicLink() || !st.isDirectory()) throw Error("文件回收目录不可用，原文件夹已保留");
  }
  const entry = path.join(trash, Date.now() + "-" + crypto.randomBytes(8).toString("hex"));
  await fs.promises.mkdir(entry);
  const target = path.join(entry, path.basename(folder.path));
  try {
    await fs.promises.writeFile(path.join(entry, "restore.json"), JSON.stringify({ session: id, original: folder.path, folder: path.basename(folder.path), at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    await fs.promises.rename(folder.path, target);
  } catch (error) {
    await fs.promises.rm(entry, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { name: folder.rel, root: folder.root, path: target, method: "local" };
}

async function trashFolders(planValue, { id, trashItem }) {
  const moved = [];
  try {
    for (const folder of planValue.folders) {
      const fresh = resolveFolder(folder);
      if (!sameFolder(fresh, folder)) throw Error("任务文件夹已被替换，请重新确认");
      if (trashItem) { await trashItem(folder.path); moved.push({ name: folder.rel, root: folder.root, method: "system" }); }
      else moved.push(await moveToLocalTrash(folder, id));
    }
  } catch (error) {
    error.moved = moved;
    throw error;
  }
  return moved;
}

module.exports = { plan, foldersOf, resolveFolder, sameFolder, validatePlan, trashFolders, countFolder, readPeers };
