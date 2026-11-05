// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 工程线的改动审阅：/api/code/status、/api/code/diff、/api/code/discard。
 *
 * 全部走 sandboxedGit，理由见 tools.js 那边：工作区的 .git 是 agent 写得到的。
 * 没跟踪的文件也让 git 来读，不用 fs：agent 建一个指向 Key 文件的软链，
 * 服务端一读就读穿了，git diff --no-index 只显示链接目标。
 * path 参数只认这次 status 列出来的名字，所以传不进 ../ 也传不进选项。
 */
const express = require("express");
const os = require("os");
const path = require("path");

const MAX_FILES = 300;
const DIFF_MAX = 400 * 1024;

let getWorkspaceDir, gitIn, isBusy;

const app = express.Router({ caseSensitive: true });

/** git status --porcelain -z：改名那条后面多跟一段旧名字 */
function parseStatus(text) {
  const parts = String(text || "").split("\0"), out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const row = parts[i]; if (row.length < 4) continue;
    const xy = row.slice(0, 2), file = row.slice(3), moved = /[RC]/.test(xy), from = moved ? parts[(i += 1)] : undefined;
    const state = xy === "??" ? "new" : moved ? "renamed" : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : "modified";
    out.push({ path: file, state, ...(from ? { from } : {}) });
  }
  return out;
}

/** git diff --numstat -z：二进制文件的行数是 -，当 0 算 */
function parseNumstat(text) {
  const map = new Map();
  for (const row of String(text || "").split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(row);
    if (m) map.set(m[3], { add: Number(m[1]) || 0, del: Number(m[2]) || 0 });
  }
  return map;
}

/** 当前工作目录的改动。不是仓库返回 { repo: false } */
async function readStatus(req) {
  const dir = getWorkspaceDir(), name = path.basename(dir);
  const top = await gitIn(dir, ["rev-parse", "--show-toplevel"], req, { timeout: 5000 });
  if (top.status !== 0) return { repo: false, dir, name };
  const root = top.stdout.trim();
  const [head, list, stat] = await Promise.all([
    gitIn(root, ["rev-parse", "--abbrev-ref", "HEAD"], req, { timeout: 5000 }),
    gitIn(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"], req, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }),
    gitIn(root, ["diff", "HEAD", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"], req, { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }),
  ]);
  if (list.status !== 0) return { repo: false, dir, name };
  const counts = parseNumstat(stat.stdout), rows = parseStatus(list.stdout);
  const files = rows.slice(0, MAX_FILES).map((row) => ({ ...row, ...(counts.get(row.path) || { add: 0, del: 0 }) }));
  return { repo: true, dir, root, name, branch: head.status === 0 ? head.stdout.trim() : "", files, more: Math.max(0, rows.length - MAX_FILES) };
}

app.get("/api/code/status", async (req, res) => {
  try { res.json(await readStatus(req)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/code/diff", async (req, res) => {
  try {
    const status = await readStatus(req), file = (status.files || []).find((row) => row.path === String(req.query.path || ""));
    if (!file) return res.status(404).json({ error: "这个文件没有改动了" });
    const base = ["--literal-pathspecs"];
    const args = file.state === "new"
      ? [...base, "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", os.devNull, file.path]
      : [...base, "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--", file.path, ...(file.from ? [file.from] : [])];
    const out = await gitIn(status.root, args, req, { timeout: 10000, maxBuffer: DIFF_MAX });
    // --no-index 有差异时退出码就是 1，不算失败
    if (out.status !== 0 && !out.truncated && !(file.state === "new" && out.status === 1)) return res.status(400).json({ error: out.stderr.trim().slice(0, 200) || "读不出这个文件的改动" });
    res.json({ path: file.path, state: file.state, text: out.stdout, truncated: !!out.truncated });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

/** 放弃一个文件的改动。只收改过和删掉的：新文件放弃就是删除，这里不做。 */
app.post("/api/code/discard", async (req, res) => {
  try {
    const dir = getWorkspaceDir();
    if (isBusy(dir)) return res.status(409).json({ error: "这个文件夹有任务在跑，停下后再放弃改动" });
    const status = await readStatus(req), file = (status.files || []).find((row) => row.path === String(req.body?.path || ""));
    if (!file) return res.status(404).json({ error: "这个文件没有改动了" });
    if (!["modified", "deleted"].includes(file.state)) return res.status(400).json({ error: "只能放弃已跟踪文件的修改或删除" });
    const out = await gitIn(status.root, ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", file.path], req, { timeout: 10000 });
    if (out.status !== 0) return res.status(400).json({ error: out.stderr.trim().slice(0, 200) || "放弃改动失败" });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

/** deps：getWorkspaceDir；gitIn(cwd, args, req, opts) 按这个请求的账号走沙箱；isBusy(dir) 这个目录有没有任务在跑 */
function createCodeRouter(deps) {
  ({ getWorkspaceDir, gitIn, isBusy } = deps);
  return app;
}

module.exports = { createCodeRouter, parseStatus, parseNumstat };
