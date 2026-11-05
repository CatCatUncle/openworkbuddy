// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 工程线的改动审阅接口。挂真路由、真 git，工作区是临时目录。
 *
 *   node test/code-review.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { spawnSync, execFile } = require("child_process");
const { mod } = require("./lib/mod");
const { createCodeRouter, parseStatus, parseNumstat } = require(mod("routes/code"));
const safeGit = require(mod("safe-git"));

let pass = 0, fail = 0;
const ok = (c, n, extra) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n + (extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 200) : "")); } };

if (spawnSync("git", ["--version"]).status !== 0) { console.log("跳过：没装 git"); process.exit(0); }

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owb-code-")));
const ws = path.join(root, "repo"), plain = path.join(root, "plain"); fs.mkdirSync(ws); fs.mkdirSync(plain);
const sh = (...a) => spawnSync("git", a, { cwd: ws, stdio: "ignore" });
sh("init", "-q", "-b", "main"); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
fs.writeFileSync(path.join(ws, "改.txt"), "一\n"); fs.writeFileSync(path.join(ws, "删.txt"), "x\n"); fs.writeFileSync(path.join(ws, "老名.txt"), "内容一行\n内容二行\n内容三行\n");
sh("add", "."); sh("commit", "-qm", "第一次");
fs.writeFileSync(path.join(ws, "改.txt"), "二\n"); fs.rmSync(path.join(ws, "删.txt")); fs.writeFileSync(path.join(ws, "新.txt"), "新内容\n");
sh("mv", "老名.txt", "新名.txt");
const secret = path.join(root, "config.json"); fs.writeFileSync(secret, "sk-only-a-test-value\n");
fs.symlinkSync(secret, path.join(ws, "链.json"));

let cwd = ws, busy = false;
const gitIn = (dir, args, _req, { timeout = 5000, maxBuffer = 1024 * 1024 } = {}) => new Promise((resolve) => {
  execFile("git", ["-C", dir, ...safeGit.args(dir), ...args], { encoding: "utf8", timeout, maxBuffer }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr, truncated: err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
});
const app = express(); app.use(express.json());
app.use(createCodeRouter({ getWorkspaceDir: () => cwd, gitIn, isBusy: () => busy }));

(async () => {
  console.log("【1】解析");
  const rows = parseStatus(" M a.txt\0R  新 名.txt\0老 名.txt\0?? b\0 D c\0A  d\0");
  ok(rows.length === 5 && rows[1].state === "renamed" && rows[1].from === "老 名.txt" && rows[2].state === "new" && rows[3].state === "deleted" && rows[4].state === "added", "改名多一段、带空格的名字不错位", rows);
  const stat = parseNumstat("3\t1\ta b.txt\0-\t-\tlogo.png\0");
  ok(stat.get("a b.txt").add === 3 && stat.get("logo.png").add === 0, "二进制文件算 0 行");

  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { code: r.status, body: await r.json() }; };
  const discard = async (p) => { const r = await fetch(base + "/api/code/discard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) }); return { code: r.status, body: await r.json() }; };
  const diffOf = (p) => get("/api/code/diff?path=" + encodeURIComponent(p));

  try {
    console.log("【2】状态");
    const st = (await get("/api/code/status")).body;
    const by = (p) => st.files.find((f) => f.path === p);
    ok(st.repo && st.branch === "main" && st.root === ws, "认得仓库和分支", st);
    ok(by("改.txt")?.state === "modified" && by("改.txt").add === 1 && by("改.txt").del === 1, "修改带行数");
    ok(by("删.txt")?.state === "deleted" && by("新.txt")?.state === "new", "删除和新文件分开");
    ok(by("新名.txt")?.state === "renamed" && by("新名.txt").from === "老名.txt", "改名带旧名字");
    cwd = plain; ok((await get("/api/code/status")).body.repo === false, "不是仓库就说不是"); cwd = ws;

    console.log("【3】看改动");
    const d = await diffOf("改.txt");
    ok(d.code === 200 && /-一/.test(d.body.text) && /\+二/.test(d.body.text), "已跟踪文件有 diff", d.body);
    ok(/\+新内容/.test((await diffOf("新.txt")).body.text), "新文件也看得到内容");
    ok(/老名\.txt/.test((await diffOf("新名.txt")).body.text), "改名能看到旧路径");

    console.log("【4】越界");
    ok((await diffOf("../config.json")).code === 404, "../ 不在 status 里，拒绝");
    ok((await diffOf("--output=/tmp/x")).code === 404, "选项形状的名字拒绝");
    ok((await diffOf("/etc/passwd")).code === 404, "绝对路径拒绝");
    const link = await diffOf("链.json");
    ok(!JSON.stringify(link.body).includes("sk-only-a-test-value"), "软链只显示目标路径，不读穿到 Key", link.body);

    console.log("【5】放弃改动");
    busy = true;
    const held = await discard("改.txt");
    ok(held.code === 409 && fs.readFileSync(path.join(ws, "改.txt"), "utf8") === "二\n", "任务在跑时不动文件", held);
    busy = false;
    ok((await discard("新.txt")).code === 400 && fs.existsSync(path.join(ws, "新.txt")), "新文件不收：放弃就是删除");
    ok((await discard("../config.json")).code === 404 && fs.existsSync(secret), "越界路径拒绝");
    ok((await discard("改.txt")).code === 200 && fs.readFileSync(path.join(ws, "改.txt"), "utf8") === "一\n", "修改回到上次提交");
    ok((await discard("删.txt")).code === 200 && fs.existsSync(path.join(ws, "删.txt")), "删掉的文件恢复");
    ok(fs.readFileSync(path.join(ws, "新.txt"), "utf8") === "新内容\n", "别的文件没被连带");

    console.log("【6】工程线就地读写");
    const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    ok(/laneId === "cli" && taskDirs\.hasSourceFiles\(getWorkspaceDir\(\)\)/.test(srv), "有源码的文件夹就地读写，跟命令行一致");
    ok(/sandboxedGit\(cwd, args/.test(srv), "接口走沙箱");
  } finally { server.close(); }
})().catch((e) => { fail++; console.log("  ✗ 跑挂了：" + (e && e.stack || e)); }).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
});
