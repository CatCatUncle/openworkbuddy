// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
const HOME = require("./lib/own-home")("task-delete");
const fs = require("fs"), path = require("path"), assert = require("assert/strict");
const { spawn } = require("child_process");
const folders = require("../src/util/task-delete");
const { createTaskDeletion } = require("../src/server/task-delete");
let passed = 0, seq = 0;
async function check(name, fn) { await fn(); passed++; console.log("✅ " + name); }
const dir = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const put = (p, text = "original") => { dir(path.dirname(p)); fs.writeFileSync(p, text); return p; };
function fixture() {
  const root = dir(path.join(HOME, "case" + ++seq)), rel = "任务_1031_测试";
  const file = put(path.join(root, rel, "report.docx"));
  const session = { root, dir: rel };
  return { root, rel, file, session, input: { id: "a", session, defaultRoot: root } };
}
function service(f, extra = {}) {
  const rows = new Map([["a", f.session]]), locks = new Set(), state = { run: false, cli: false, settled: false, invalidated: false };
  const api = createTaskDeletion({ locks, lookup: id => rows.get(id), authorize: req => req.user.username === "alice",
    snapshot: async () => f.input, running: () => state.run, cliRunning: () => state.cli,
    stop: () => {}, settle: async () => { state.settled = true; }, remove: id => { assert(state.settled); rows.delete(id); },
    invalidate: () => { state.invalidated = true; }, ...extra });
  async function call(op, body = {}, who = "alice", id = "a") {
    const res = { code: 200, status(n) { this.code = n; return this; }, json(b) { this.body = b; } };
    await api[op]({ params: { id }, body, user: { username: who } }, res);
    return res;
  }
  return { call, rows, locks, state };
}
async function main() {
  await check("任务专属目录计数准确，子目录不计作文件，链接不跟随", async () => {
    const f = fixture(); put(path.join(f.root, f.rel, "nested", "x.md"), "x");
    if (process.platform !== "win32") fs.symlinkSync(HOME, path.join(f.root, f.rel, "link"));
    const p = await folders.plan(f.input);
    assert.equal(p.folders.length, 1); assert.equal(p.folders[0].files, process.platform === "win32" ? 2 : 3);
    assert(fs.existsSync(f.file));
  });
  await check("同一任务跨项目的旧目录与新目录都列出，重复目录仅列一次", async () => {
    const f = fixture(), other = dir(path.join(f.root, "other")); put(path.join(other, f.rel, "old.md"));
    f.session.dirs = { [f.root]: f.rel, [other]: f.rel };
    assert.equal((await folders.plan(f.input)).folders.length, 2);
  });
  await check("项目根、项目下含另一项目的目录、其他任务共用目录均保留", async () => {
    const f = fixture();
    for (const input of [
      { protectedPaths: [path.dirname(f.file)] }, { protectedPaths: [path.join(path.dirname(f.file), "subproject")] },
      { peers: [{ id: "b", root: f.root, dir: f.rel }] }, { peers: [{ id: "b", root: path.dirname(f.file) }] },
      { busyPaths: [path.dirname(f.file)] }, { canAccess: () => false },
    ]) { const p = await folders.plan({ ...f.input, ...input }); assert.equal(p.folders.length, 0); assert.equal(p.retained.length, 1); }
    assert(fs.existsSync(f.file));
  });
  await check("自选目录、路径穿越、定时任务共享成果不进入清理范围", async () => {
    const f = fixture();
    for (const s of [{ ...f.session, dir: "../任务_1031_测试" }, { ...f.session, dir: "." }, { ...f.session, dir: "项目" }, { ...f.session, kind: "schedule" }, { ...f.session, schedule_id: "s1" }]) {
      const p = await folders.plan({ ...f.input, session: s }); assert.equal(p.folders.length, 0); assert.equal(p.retained.length, 1);
    }
  });
  await check("缺失目录可以删对话；符号链接目录不移动", async () => {
    const f = fixture(); fs.rmSync(path.dirname(f.file), { recursive: true });
    assert.equal((await folders.plan(f.input)).folders.length, 0);
    if (process.platform !== "win32") {
      fs.symlinkSync(HOME, path.dirname(f.file)); const p = await folders.plan(f.input);
      assert.equal(p.folders.length, 0); assert.equal(p.retained.length, 1);
    }
  });
  await check("确认后替换目录或变成共享目录必须重新确认", async () => {
    const f = fixture(), before = await folders.plan(f.input);
    fs.renameSync(path.dirname(f.file), path.join(f.root, "saved")); put(f.file, "replacement");
    assert.throws(() => folders.validatePlan(before, { folders: [], retained: [] }));
    assert.throws(() => folders.validatePlan(before, { folders: [folders.resolveFolder({ root: f.root, rel: f.rel })] }));
    await assert.rejects(folders.trashFolders(before, { id: "a" })); assert.equal(fs.readFileSync(f.file, "utf8"), "replacement");
  });
  await check("无桌面引擎时移入同盘回收区，原内容和恢复清单完整", async () => {
    const f = fixture(), p = await folders.plan(f.input), moved = await folders.trashFolders(p, { id: "a" });
    assert.equal(moved[0].method, "local"); assert(!fs.existsSync(f.file));
    assert.equal(fs.readFileSync(path.join(moved[0].path, "report.docx"), "utf8"), "original");
    assert.equal(require("../src/util/task-dirs").canonDir(JSON.parse(fs.readFileSync(path.join(path.dirname(moved[0].path), "restore.json"))).original), require("../src/util/task-dirs").canonDir(path.dirname(f.file)));
    assert.equal(require("../src/domains/library/ws-browse").walkAll(f.root).files.length, 0);
  });
  await check("回收区是链接时拒绝移动，原文件保留", async () => {
    if (process.platform === "win32") return;
    const f = fixture(); fs.symlinkSync(HOME, path.join(f.root, ".trash"));
    await assert.rejects(folders.trashFolders(await folders.plan(f.input), { id: "a" })); assert(fs.existsSync(f.file));
  });
  await check("读取盘上共享归属并合并内存中新任务，缓存识别后续修改", async () => {
    const f = fixture(), sd = dir(path.join(f.root, "sessions")), file = path.join(sd, "b.json");
    put(file, JSON.stringify({ root: f.root, dir: f.rel }));
    let peers = await folders.readPeers(sd, new Map([["c", { root: f.root, dir: "任务_1031_新" }]]));
    assert.equal(peers.length, 2); assert.equal((await folders.plan({ ...f.input, peers })).folders.length, 0);
    put(file, JSON.stringify({ root: f.root, dir: "任务_1031_另" })); peers = await folders.readPeers(sd, new Map());
    assert.equal((await folders.plan({ ...f.input, peers })).folders.length, 1);
    peers = await folders.readPeers(sd, new Map([["b", { ...f.session }]]));
    assert.equal((await folders.plan({ ...f.input, peers })).folders.length, 0, "尚未保存的内存归属也受保护");
    put(file, JSON.stringify(f.session));
    peers = await folders.readPeers(sd, new Map([["b", { root: f.root, dir: "任务_1031_另" }]]));
    assert.equal((await folders.plan({ ...f.input, peers })).folders.length, 0, "CLI 写入的新归属不能被旧网页缓存覆盖");
  });
  await check("勾选清理须提供本人本任务的有效确认，跨用户与跨任务均不放行", async () => {
    const f = fixture(), s = service(f), p = await s.call("preview");
    assert.equal((await s.call("deleteTask", { trash_files: true })).code, 409);
    assert.equal((await s.call("deleteTask", { trash_files: true, token: p.body.token }, "bob")).code, 403);
    s.rows.set("b", { ...f.session });
    assert.equal((await s.call("deleteTask", { trash_files: true, token: p.body.token }, "alice", "b")).code, 409);
    assert(s.rows.has("a")); assert(fs.existsSync(f.file));
    assert.equal((await s.call("preview", {}, "alice", "../a")).code, 400);
    assert.equal((await s.call("preview", {}, "alice", "missing")).code, 404);
  });
  await check("取消清理或旧客户端仅删记录时，成果文件完整保留", async () => {
    for (const body of [{ trash_files: false }, {}]) {
      const f = fixture(), s = service(f), r = await s.call("deleteTask", body);
      assert.equal(r.code, 200); assert(!s.rows.has("a")); assert(fs.existsSync(f.file)); assert(s.state.invalidated);
    }
  });
  await check("原生回收失败保留任务与原文件，不降级成永久删除", async () => {
    const f = fixture(), s = service(f, { trashItem: async () => { throw Error("trash failed"); } }), p = await s.call("preview");
    const r = await s.call("deleteTask", { trash_files: true, token: p.body.token });
    assert.equal(r.code, 400); assert(s.rows.has("a")); assert(fs.existsSync(f.file)); assert(!s.locks.size);
  });
  await check("等待真正收尾完成，阻止重复删除；晚到的最后一次保存不会复活任务", async () => {
    const f = fixture(), events = [], s = service(f, { stop: () => { events.push("stop"); setTimeout(() => { put(path.join(path.dirname(f.file), "last.md")); s.state.run = false; }, 150); } });
    s.state.run = true;
    const p = await s.call("preview"); assert(p.body.running);
    const pending = s.call("deleteTask", { trash_files: true, token: p.body.token });
    await new Promise(r => setTimeout(r, 20)); assert(s.rows.has("a")); assert(s.locks.has("a"));
    assert.equal((await s.call("deleteTask")).code, 409);
    const r = await pending; assert.equal(r.code, 200); assert.equal(events[0], "stop");
    assert(!s.rows.has("a")); assert(!fs.existsSync(path.dirname(f.file))); assert(s.state.invalidated);
    assert(fs.existsSync(path.join(r.body.moved[0].path, "last.md")));
  });
  await check("任务停不下来、确认过期、CLI仍运行时均保持原状", async () => {
    const f = fixture(), s = service(f, { waitMs: 1 }); s.state.run = true;
    assert.equal((await s.call("deleteTask")).code, 409); assert(s.rows.has("a"));
    s.state.run = false; s.state.cli = true; assert.equal((await s.call("deleteTask")).code, 409);
    let clock = 100; const e = service(f, { now: () => clock }), p = await e.call("preview"); clock += 600001;
    assert.equal((await e.call("deleteTask", { trash_files: true, token: p.body.token })).code, 409); assert(fs.existsSync(f.file));
  });
  await check("自动化仍持有记录、后台命令收尾失败时不删除记录和文件", async () => {
    const f = fixture();
    for (const overrides of [{ blocked: () => "自动化仍在执行" }, { settle: async () => { throw Error("background command still alive"); } }]) {
      const s = service(f, overrides), r = await s.call("deleteTask");
      assert(r.code >= 400); assert(s.rows.has("a")); assert(fs.existsSync(f.file)); assert.equal(s.locks.size, 0);
    }
  });
  await check("确认后目录被其他任务使用时中止，不静默删掉任务记录", async () => {
    const f = fixture(), s = service(f), p = await s.call("preview");
    f.input.peers = [{ id: "b", ...f.session }];
    const r = await s.call("deleteTask", { trash_files: true, token: p.body.token });
    assert.equal(r.code, 400); assert(s.rows.has("a")); assert(fs.existsSync(f.file));
  });
  await check("多目录清理部分失败时保留对话，准确报告已回收的目录", async () => {
    const f = fixture(), other = dir(path.join(f.root, "other")); put(path.join(other, f.rel, "old.md"));
    f.session.dirs = { [other]: f.rel };
    let count = 0;
    const s = service(f, { trashItem: async p => { if (++count === 2) throw Error("second failed"); fs.renameSync(p, p + ".recycled"); } }), p = await s.call("preview");
    const r = await s.call("deleteTask", { trash_files: true, token: p.body.token });
    assert.equal(r.body.moved.length, 1); assert.match(r.body.error, /部分文件夹已移到回收区/); assert(s.rows.has("a"));
    assert(fs.existsSync(path.join(other, f.rel, "old.md")));
  });
  await check("归属元数据损坏时仍可选择仅删除对话，文件清理不冒险", async () => {
    const f = fixture(), s = service(f, { snapshot: async () => { throw Error("bad metadata"); } });
    const p = await s.call("preview"); assert.equal(p.body.folders.length, 0); assert(p.body.retained.length);
    assert.equal((await s.call("deleteTask", { trash_files: false })).code, 200); assert(fs.existsSync(f.file));
  });
  await realServer();
  console.log(`任务删除：${passed} 组通过`);
}

async function realServer() {
  await check("真实服务：预览、可恢复清理、备份与归档删除、资料库立即失效", async () => {
    const ws = dir(path.join(HOME, "workspace")), rel = "任务_1031_API", sid = "delete_api", sd = dir(path.join(HOME, "data", "sessions"));
    const file = put(path.join(ws, rel, "result.md"), "# result");
    const token = "taskdeletefixture", at = new Date().toISOString();
    put(path.join(HOME, "data", "users.json"), JSON.stringify({ users: [{ username: "test", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }], tokens: { [token]: { user: "test", at: Date.now() } } }));
    const data = { user: "test", title: "删除夹具", root: ws, dir: rel, history: [{ role: "user", content: "test" }], updated_at: at, transcript: [{ type: "assistant", at, events: [{ type: "files", changed: [rel + "/result.md"] }] }] };
    put(path.join(sd, sid + ".json"), JSON.stringify(data)); put(path.join(sd, sid + ".json.bak"), JSON.stringify(data));
    const archive = put(path.join(HOME, "data", "compact-archive", sid + "-1793331310000.json"), JSON.stringify(data));
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, HOST: "127.0.0.1", PORT: "0", OPENWORKBUDDY_INSTALL_CLI: "0", OPENWORKBUDDY_TOOLWARD: "off" }, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; child.stdout.on("data", c => { log += c; }); child.stderr.on("data", c => { log += c; });
    try {
      const end = Date.now() + 60000;
      while (!/已启动: http:\/\/localhost:(\d+)/.test(log) && child.exitCode === null && Date.now() < end) await new Promise(r => setTimeout(r, 100));
      const match = /已启动: http:\/\/localhost:(\d+)/.exec(log); assert(match, log.slice(-1500));
      const api = async (url, method = "GET", body) => {
        const r = await fetch("http://127.0.0.1:" + match[1] + url, { method, headers: { Cookie: "openworkbuddy_token=" + token, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, body: await r.json() };
      };
      const before = await api("/api/library/outputs"); assert.equal(before.status, 200);
      const p = await api("/api/session/" + sid + "/delete-preview"); assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.folders.length, 1, JSON.stringify(p.body));
      const result = await api("/api/session/" + sid, "DELETE", { trash_files: true, token: p.body.token });
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.moved.length, 1); assert(!fs.existsSync(file));
      assert(!fs.existsSync(path.join(sd, sid + ".json"))); assert(!fs.existsSync(path.join(sd, sid + ".json.bak"))); assert(!fs.existsSync(archive));
      const outputs = await api("/api/library/outputs"); assert.equal(outputs.status, 200); assert(!JSON.stringify(outputs.body).includes(rel));
      const rows = await api("/api/sessions"); assert.equal(rows.status, 200); assert(!JSON.stringify(rows.body).includes(sid));
      await new Promise(r => setTimeout(r, 1200)); assert(!fs.existsSync(path.join(sd, sid + ".json")));
    } finally { child.kill("SIGTERM"); await new Promise(r => { child.once("exit", r); setTimeout(() => { child.kill("SIGKILL"); r(); }, 3000).unref(); }); }
  });
}
main().catch(e => { console.error(e); process.exitCode = 1; });
