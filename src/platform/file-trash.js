// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bridge = require("./electron-bridge");

function desktopTrash() {
  if (bridge.isRemote()) return p => bridge.call("shell.trashItem", { path: p }, { timeoutMs: 120000 });
  if (bridge.mode() === "inproc") return p => require("electron").shell.trashItem(p);
  return null;
}

function checked(root, rel, previous) {
  const abs = path.resolve(root, rel);
  if (abs === root || !abs.startsWith(root + path.sep)) throw Error("只能回收原目录内的文件");
  if (path.relative(root, abs).split(path.sep).includes(".trash")) throw Error("回收区不能再次回收");
  let current = root, st;
  for (const part of path.relative(root, abs).split(path.sep)) {
    current = path.join(current, part); st = fs.lstatSync(current);
    if (st.isSymbolicLink() || (current !== abs && !st.isDirectory())) throw Error("路径包含链接或已变化，原文件已保留");
  }
  if (!(st.isDirectory() || st.isFile())) throw Error("此文件类型不能回收");
  if (previous && (st.dev !== previous.dev || st.ino !== previous.ino || st.birthtimeMs !== previous.birthtimeMs || st.mtimeMs !== previous.mtimeMs || st.size !== previous.size)) throw Error("文件已变化，请重新确认");
  return { abs, st };
}

// 不提供永久删除回退。桌面回收失败必须保留原件；无桌面时同卷原子移动并先写恢复记录。
async function move(rootValue, file, opts = {}) {
  const rawRoot = path.resolve(rootValue);
  const rel = path.relative(rawRoot, path.resolve(file));
  const root = fs.realpathSync(rawRoot);
  const original = checked(root, rel);
  const trashItem = Object.prototype.hasOwnProperty.call(opts, "trashItem") ? opts.trashItem : desktopTrash();
  const recheck = () => { if (opts.beforeMove) opts.beforeMove(); checked(root, rel, original.st); };
  if (trashItem) {
    recheck(); await trashItem(original.abs);
    return { method: "system", recovery: "可在系统废纸篓/回收站中恢复" };
  }
  let trash = root;
  for (const name of [".trash", "files"]) {
    trash = path.join(trash, name);
    try { await fs.promises.mkdir(trash, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    const st = await fs.promises.lstat(trash);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error("文件回收目录不可用，原文件已保留");
  }
  const entry = path.join(trash, Date.now() + "-" + crypto.randomBytes(8).toString("hex"));
  await fs.promises.mkdir(entry, { mode: 0o700 });
  const payload = path.join(entry, "item"), manifest = path.join(entry, "restore.json");
  try {
    await fs.promises.writeFile(manifest, JSON.stringify({ version: 1, original: path.resolve(rawRoot, rel), canonical: original.abs, relative: rel, name: path.basename(original.abs), payload: "item", at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    recheck(); await fs.promises.rename(original.abs, payload);
  } catch (error) {
    // 这里只收拾自己新建的空容器，绝不递归删除可能已经移入的用户文件。
    if (!fs.existsSync(payload)) {
      await fs.promises.unlink(manifest).catch(() => {});
      await fs.promises.rmdir(entry).catch(() => {});
    }
    throw error;
  }
  return { method: "local", trash: path.relative(root, entry), recovery: "可从原目录的 .trash/files 恢复，原路径见 restore.json" };
}

module.exports = { move, desktopTrash };
