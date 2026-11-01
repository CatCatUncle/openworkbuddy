// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
const crypto = require("crypto");
const folders = require("../util/task-delete");

// A confirmation names a server-owned snapshot. Never accept a path from HTTP.
function createTaskDeletion({ locks, lookup, authorize, snapshot, running, cliRunning, stop, settle, remove, invalidate, trashItem, blocked = () => "", now = Date.now, waitMs = 30000 }) {
  const previews = new Map();
  const problem = (message, status = 409) => Object.assign(new Error(message), { status });
  function session(req) {
    const id = req.params.id;
    if (!/^[\w-]{1,180}$/.test(id || "")) throw problem("任务编号不合法", 400);
    const s = lookup(id);
    if (!s) throw problem("任务已经不存在", 404);
    if (!authorize(req, s)) throw problem("这条对话不属于你", 403);
    return s;
  }
  const owner = req => String(req.user && req.user.username || "");
  async function preview(req, res) {
    try {
      const s = session(req), id = req.params.id;
      if (locks.has(id)) throw problem("正在删除此任务，请稍候");
      let value;
      try { value = await folders.plan(await snapshot(req, id, s)); }
      catch { value = { folders: [], retained: [{ name: "任务文件夹", reason: "目录归属暂时无法完整核对，本次只删除对话，保留文件" }] }; }
      for (const [k, v] of previews) if (now() - v.at > 600000) previews.delete(k);
      while (previews.size >= 100) previews.delete(previews.keys().next().value);
      const token = crypto.randomBytes(24).toString("hex");
      previews.set(token, { id, owner: owner(req), at: now(), value });
      res.json({ ok: true, folders: value.folders.map(({ root, rel, files, bytes, more }) => ({ root, rel, files, bytes, more })), retained: value.retained, token, running: !!running(id), cli: !!cliRunning(id), blocked: blocked(id) });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  }
  async function deleteTask(req, res) {
    let locked = false, moved = [];
    const id = req.params.id;
    try {
      const s = session(req), b = req.body || {};
      if (locks.has(id)) throw problem("正在删除此任务，请稍候");
      const consent = b.trash_files === true ? previews.get(b.token) : null;
      if (b.trash_files === true && (!consent || consent.id !== id || consent.owner !== owner(req) || now() - consent.at > 600000)) throw problem("删除确认已过期，请重新打开确认框");
      if (cliRunning(id)) throw problem("此任务正在终端运行，请先在终端停止，再删除");
      if (blocked(id)) throw problem(blocked(id));
      locks.add(id); locked = true;
      stop(id);
      const end = now() + waitMs;
      while (running(id)) {
        if (now() >= end) throw problem("任务还在收尾，文件和对话已保留，请稍后重试");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await settle(id);
      if (cliRunning(id)) throw problem("此任务正在终端运行，请先停止，再删除");
      if (consent) {
        const current = await folders.plan({ ...await snapshot(req, id, s), count: false });
        folders.validatePlan(consent.value, current);
        moved = await folders.trashFolders(current, { id, trashItem });
      }
      await remove(id, s);
      await invalidate(id, moved);
      for (const [key, p] of previews) if (p.id === id) previews.delete(key);
      res.json({ ok: true, moved });
    } catch (e) {
      moved = e.moved || moved;
      res.status(e.status || 400).json({ error: e.message + (moved.length ? "；部分文件夹已移到回收区，对话仍保留" : ""), moved });
    } finally { if (locked) locks.delete(id); }
  }
  return { preview, deleteTask };
}
module.exports = { createTaskDeletion };
