// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const HOME = require("./lib/own-home")("file-routing");
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto"), assert = require("assert/strict");
const { spawn } = require("child_process");
const { entry } = require("./lib/entry");
const { mod } = require("./lib/mod");
const key = require(mod("tools")).workspaceKeyOf;
const A = path.join(HOME, "workspace"), B = path.join(HOME, "other-project"), C = path.join(HOME, "external project 中文");
for (const [dir, content] of [[A, "PROJECT_A"], [B, "PROJECT_B"], [C, "PROJECT_C"]]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>" + content + "</title>" + content); }
fs.writeFileSync(path.join(C, "package.json"), '{"name":"fixture"}');
fs.mkdirSync(path.join(C, "pages")); fs.mkdirSync(path.join(C, "assets"));
fs.writeFileSync(path.join(C, "pages", "index.html"), '<link rel="stylesheet" href="../assets/style.css">NESTED_C');
fs.writeFileSync(path.join(C, "assets", "style.css"), "body{color:purple}");
let child, count = 0;
process.on("exit", () => { if (child && child.exitCode === null) child.kill("SIGKILL"); });
function request(port, method, route, token, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, headers: { ...(token ? { Cookie: "openworkbuddy_token=" + token } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } }, res => {
      let text = ""; res.on("data", d => { text += d; }); res.on("end", () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json }); });
    });
    req.on("error", reject); req.setTimeout(15000, () => req.destroy(new Error("request timeout"))); req.end(data);
  });
}
async function check(label, fn) { await fn(); count++; console.log("✓ " + label); }
(async () => {
  fs.mkdirSync(path.join(HOME, "data"), { recursive: true });
  fs.mkdirSync(path.join(HOME, "data", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "data", "sessions", "s_other.json"), JSON.stringify({ id: "s_other", owner: "owner", root: B, title: "Other", history: [], transcript: [] }));
  const owner = crypto.randomBytes(24).toString("hex"), member = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(HOME, "data", "users.json"), JSON.stringify({ users: [{ username: "owner", org: "default", salt: "fixture", hash: "fixture", role: "admin" }, { username: "member", org: "default", salt: "fixture", hash: "fixture", role: "member" }], tokens: { [owner]: { user: "owner", at: Date.now() }, [member]: { user: "member", at: Date.now() } } }));
  fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify({ workspace_dir: A, projects: [{ id: "project-b", name: "B", dir: B }], assist_model: "legacy-api-label", agent: { engine: "codex", engine_options: { codex: { model: "fixture-model", enabled: true } } }, mcp_servers: [] }));
  child = spawn(process.execPath, [entry("server")], { env: { ...process.env, HOST: "127.0.0.1", PORT: "0", OPENWORKBUDDY_INSTALL_CLI: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { output += d; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(new Error("isolated server did not start")); }, 60000);
    const poll = setInterval(() => { const m = /已启动: http:\/\/localhost:(\d+)/.exec(output); if (m || child.exitCode !== null) { clearTimeout(timeout); clearInterval(poll); if (m) resolve(Number(m[1])); else reject(new Error("isolated server exited")); } }, 100);
  });
  const call = (method, route, body, token = owner) => request(port, method, route, token, body);
  await check("trace APIs aggregate known projects and keep owner-only access", async () => {
    const write = (root, id) => {
      const dir = path.join(root, ".openworkbuddy"); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "traces.jsonl"), [
        { schema: 1, traceId: id, kind: "trace", phase: "start", name: id, startTime: new Date().toISOString() },
        { schema: 1, traceId: id, kind: "trace", phase: "end", output: "fixture result", endTime: new Date().toISOString() },
      ].map(x => JSON.stringify(x)).join("\n") + "\n");
    };
    write(A, "fixture-trace-a"); write(B, "fixture-trace-b"); write(HOME, "fixture-trace-root");
    const r = await call("GET", "/api/traces");
    assert.equal(r.status, 200); assert.equal(r.json.traces.length, 3);
    assert.equal((await call("GET", "/api/traces/fixture-trace-b")).json.trace.output, "fixture result");
    assert.equal((await call("GET", "/api/traces", undefined, member)).status, 403);
    assert.equal((await call("DELETE", "/api/traces")).status, 200);
    assert.equal((await call("GET", "/api/traces")).json.traces.length, 0);
  });
  await check("assistant engine choice is saved separately and accepts API or local engines", async () => {
    assert.equal((await call("GET", "/api/settings")).json.assist_engine, "codex", "旧 API 标签不能把现有本机引擎切成付费 API");
    const api = await call("POST", "/api/assist/model", { engine: "builtin", model: null });
    assert.equal(api.status, 200); assert.equal(api.json.engine, "builtin");
    const globalBefore = (await call("GET", "/api/settings")).json.agent.engine;
    const local = await call("POST", "/api/assist/model", { engine: "codex", model: null });
    assert.equal(local.status, 200); assert.equal(local.json.engine, "codex");
    const setting = (await call("GET", "/api/settings")).json;
    assert.equal(setting.assist_engine, "codex"); assert.equal(setting.agent.engine, globalBefore);
    assert.equal((await call("POST", "/api/assist/model", { engine: "invalid" })).status, 400);
    assert.equal((await call("POST", "/api/assist/model", { engine: "builtin", model: null }, member)).status, 200);
    assert.equal((await call("GET", "/api/settings", undefined, member)).json.assist_engine, "builtin");
    assert.equal((await call("GET", "/api/settings")).json.assist_engine, "codex", "成员选择不影响主人");
  });
  await check("explicit roots beat a same-name file in the current workspace for preview and download", async () => {
    for (const endpoint of ["view", "download"]) {
      const a = await call("GET", "/api/files/" + endpoint + "/index.html?root=" + key(A));
      const b = await call("GET", "/api/files/" + endpoint + "/index.html?root=" + key(B));
      assert.equal(a.status, 200); assert.ok(a.text.includes("PROJECT_A"));
      assert.equal(b.status, 200); assert.ok(b.text.includes("PROJECT_B") && !b.text.includes("PROJECT_A"));
      const sid = await call("GET", "/api/files/" + endpoint + "/index.html?sid=s_other");
      assert.equal(sid.status, 200); assert.ok(sid.text.includes("PROJECT_B") && !sid.text.includes("PROJECT_A"));
    }
  });
  await check("deleted files and unknown origins never fall back to a same-name file", async () => {
    fs.renameSync(path.join(B, "index.html"), path.join(B, "saved.html"));
    for (const endpoint of ["view", "download"]) {
      const missing = await call("GET", "/api/files/" + endpoint + "/index.html?root=" + key(B));
      assert.equal(missing.status, 404); assert.ok(!missing.text.includes("PROJECT_A"));
      assert.equal((await call("GET", "/api/files/" + endpoint + "/index.html?sid=s_other")).status, 404);
      const unknown = await call("GET", "/api/files/" + endpoint + "/index.html?root=00000000");
      assert.equal(unknown.status, 400); assert.ok(!unknown.text.includes("PROJECT_A"));
    }
    fs.renameSync(path.join(B, "saved.html"), path.join(B, "index.html"));
  });
  await check("external local files resolve by exact absolute path and only for the platform owner", async () => {
    const file = path.join(C, "index.html");
    const privateFile = path.join(require(mod("spaces")).accountsDir(), "fixture-member", "index.html");
    fs.mkdirSync(path.dirname(privateFile), { recursive: true }); fs.writeFileSync(privateFile, "MEMBER_PRIVATE");
    const r = await call("POST", "/api/files/resolve-local", { path: file });
    assert.equal(r.status, 200); assert.equal(r.json.root, key(fs.realpathSync(C))); assert.equal(r.json.name, "index.html");
    const opened = await call("GET", "/api/files/view/index.html?root=" + r.json.root);
    assert.ok(opened.text.includes("PROJECT_C") && !opened.text.includes("PROJECT_A"));
    assert.equal((await call("POST", "/api/files/resolve-local", { path: file }, member)).status, 403);
    assert.equal((await call("POST", "/api/files/resolve-local", { path: file }, "")).status, 401);
    assert.equal((await call("POST", "/api/files/resolve-local", { path: privateFile })).status, 404);
    for (const p of ["index.html", path.join(C, "gone.html"), C]) assert.equal((await call("POST", "/api/files/resolve-local", { path: p })).status, 404);
    assert.equal((await call("GET", "/api/files/view/index.html?root=" + key(fs.realpathSync(C)), undefined, member)).status, 400);
    const nested = await call("POST", "/api/files/resolve-local", { path: path.join(C, "pages", "index.html") });
    assert.equal(nested.json.name, "pages/index.html"); assert.equal(nested.json.root, r.json.root);
  });
  await check("each project's browser deployment serves its own index.html", async () => {
    const started = [];
    for (const [dir, expected] of [[A, "PROJECT_A"], [B, "PROJECT_B"], [C, "PROJECT_C"]]) {
      const r = await call("POST", "/api/preview/start?root=" + key(dir === C ? fs.realpathSync(C) : dir), { lan: false });
      assert.equal(r.status, 200); assert.equal(r.json.root, key(dir === C ? fs.realpathSync(C) : dir)); started.push(r.json.port);
      const served = await request(r.json.port, "GET", "/index.html?t=" + r.json.token);
      assert.equal(served.status, 200); assert.ok(served.text.includes(expected));
      assert.equal((await request(r.json.port, "GET", "/index.html")).status, 401);
      if (dir === C) {
        assert.equal((await request(r.json.port, "GET", "/pages/index.html?t=" + r.json.token)).text.includes("NESTED_C"), true);
        assert.equal((await request(r.json.port, "GET", "/assets/style.css?t=" + r.json.token)).status, 200);
        try {
          fs.symlinkSync(path.join(A, "index.html"), path.join(C, "outside.html"));
          assert.equal((await request(r.json.port, "GET", "/outside.html?t=" + r.json.token)).status, 403);
          assert.equal((await request(r.json.port, "GET", "/outside?t=" + r.json.token)).status, 403);
          fs.mkdirSync(path.join(C, "linked")); fs.symlinkSync(path.join(A, "index.html"), path.join(C, "linked", "index.html"));
          assert.equal((await request(r.json.port, "GET", "/linked/?t=" + r.json.token)).status, 403);
        } catch (e) { if (e.code !== "EPERM") throw e; }
      }
    }
    assert.equal(new Set(started).size, 3);
    for (const route of ["status", "stop", "start"]) {
      const r = await call(route === "status" ? "GET" : "POST", "/api/preview/" + route + "?root=00000000", {});
      assert.equal(r.status, 400);
    }
    assert.equal((await call("GET", "/api/preview/status?root=" + key(A))).json.running, true);
    fs.writeFileSync(path.join(B, "ambiguous.txt"), "B"); fs.writeFileSync(path.join(C, "ambiguous.txt"), "C");
    const ambiguous = await call("GET", "/api/files/view/ambiguous.txt");
    assert.equal(ambiguous.status, 400); assert.ok(ambiguous.text.includes("同名"));
    const bad = await call("POST", "/api/preview/start?root=" + key(B), { open: "missing/index.html" });
    assert.equal(bad.status, 404);
    assert.equal((await call("POST", "/api/preview/start?root=" + key(B), { open: "../index.html" })).status, 404);
    await call("POST", "/api/preview/stop?root=" + key(B));
    assert.equal((await call("GET", "/api/preview/status?root=" + key(B))).json.running, false);
    assert.equal((await call("GET", "/api/preview/status?root=" + key(A))).json.running, true);
  });
  child.kill("SIGINT"); await new Promise(resolve => child.once("exit", resolve));
  console.log("File routing: " + count + " groups passed");
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; if (child && child.exitCode === null) child.kill("SIGKILL"); });
