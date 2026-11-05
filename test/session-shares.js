// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const HOME = require("./lib/own-home")("session-shares");
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto"), assert = require("assert/strict");
const { spawn } = require("child_process");
const { mod } = require("./lib/mod"), { entry } = require("./lib/entry");
const shares = require(mod("session-shares"));
const { createSessionSharesRouter } = require(mod("routes/session-shares"));
let checks = 0, child;
const check = async (label, fn) => { await fn(); checks++; console.log("✓ " + label); };
process.on("exit", () => { if (child && child.exitCode === null) child.kill("SIGKILL"); });
function request(port, method, route, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port, path: route, method, headers: token ? { Cookie: "openworkbuddy_token=" + token } : {} }, (res) => {
      let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => { let data; try { data = JSON.parse(text); } catch {} resolve({ code: res.statusCode, data, text, headers: res.headers }); });
    }); r.on("error", reject); r.setTimeout(10000, () => r.destroy(new Error("request timeout"))); r.end();
  });
}
(async () => {
  const unitFile = path.join(HOME, "unit-shares.json"), store = shares.createShareStore(unitFile);
  let first;
  await check("链接随机、持久、重复创建沿用；落盘只有属主可读", () => {
    first = store.create("s_fixture", "owner", "org-a"); assert.match(first.token, shares.TOKEN);
    assert.equal(store.create("s_fixture", "owner", "org-a").token, first.token);
    assert.equal(shares.createShareStore(unitFile).get(first.token).sid, "s_fixture");
    assert.equal(store.get("__proto__"), null);
    if (process.platform !== "win32") assert.equal(fs.statSync(unitFile).mode & 0o777, 0o600);
  });
  await check("撤回后失效，重新分享生成不同链接；其他人不能撤回", () => {
    assert.equal(store.revoke("s_fixture", "other", "org-a"), false); assert.ok(store.get(first.token));
    assert.equal(store.revoke("s_fixture", "owner", "org-a"), true); assert.equal(store.get(first.token), null);
    assert.notEqual(store.create("s_fixture", "owner", "org-a").token, first.token);
    assert.equal(fs.existsSync(unitFile + ".bak"), false);
  });
  await check("坏记录不恢复旧链接，也不覆盖原文件", () => {
    fs.writeFileSync(unitFile + ".bak", JSON.stringify({ version: 1, items: {} })); fs.writeFileSync(unitFile, "{broken");
    assert.throws(() => store.create("s_new", "owner", "org-a")); assert.equal(fs.readFileSync(unitFile, "utf8"), "{broken");
  });
  const ws = path.join(HOME, "workspace"); fs.mkdirSync(ws); fs.writeFileSync(path.join(ws, "report.md"), "# Fixture report");
  fs.writeFileSync(path.join(ws, "not-delivered.txt"), "private"); fs.writeFileSync(path.join(HOME, "outside.txt"), "private");
  fs.symlinkSync(path.join(HOME, "outside.txt"), path.join(ws, "link.txt"));
  const secret = "fixture-" + crypto.randomBytes(18).toString("hex");
  const session = { user: "owner", root: ws, title: "Fixture task", transcript: [
    { type: "user", text: "Please write a report", at: "2026-10-16" },
    { type: "assistant", events: [{ type: "text", delta: secret + "\n" + "Detailed result. ".repeat(60) + "END-OF-RESULT" }, { type: "tool_start", input: { api_key: secret, private_root: HOME } }, { type: "files", changed: ["report.md", "../outside.txt", "link.txt", "/absolute/private", "removed.txt"] }, { type: "files", gone: ["removed.txt"] }] },
  ] };
  await check("只展示请求和最终文本，交付文件以真实路径限定；不读其他文件", () => {
    const data = shares.publicTask(session); assert.equal(data.turns.length, 2); assert.equal(data.turns[1].text.endsWith("END-OF-RESULT"), true);
    assert.deepEqual(data.files.map((f) => f.path), ["report.md"]);
    assert.equal(shares.resolveDelivered(session, "not-delivered.txt"), null); assert.equal(shares.resolveDelivered(session, "../outside.txt"), null); assert.equal(shares.resolveDelivered(session, "link.txt"), null);
    assert.ok(!JSON.stringify(data).includes(HOME)); assert.ok(!JSON.stringify(data).includes("api_key"));
  });
  const routerStore = shares.createShareStore(path.join(HOME, "router-shares.json")); let multi = true, status = "active", ownerOrg = "org-a";
  const app = require("express")();
  app.use((req, _res, next) => { req.user = { username: req.headers["x-fixture-user"] || "owner", org: req.headers["x-fixture-org"] || "org-a" }; next(); });
  app.use(createSessionSharesRouter({ enabled: true, store: routerStore, multiUser: () => multi, sessionOf: (sid) => sid === "s_fixture" ? session : null, ownerOf: (s) => s.user, orgOf: (u) => u.org, memberOf: (org) => ownerOrg === org ? { status } : null, sanitize: (s) => s }));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const row = routerStore.create("s_fixture", "owner", "org-a"), port = server.address().port;
    const callAs = (user, org, method, route) => new Promise((resolve, reject) => { const r = http.request({ hostname: "127.0.0.1", port, path: route, method, headers: { "x-fixture-user": user, "x-fixture-org": org } }, (res) => { let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve(res.statusCode)); }); r.on("error", reject); r.end(); });
    await check("同组织成员只读，跨组织不可见；知道链接不能改任务或重新分享", async () => {
      assert.equal(await callAs("member", "org-a", "GET", "/api/session-shares/" + row.token), 200);
      assert.equal(await callAs("member", "org-b", "GET", "/api/session-shares/" + row.token), 404);
      assert.equal(await callAs("member", "org-a", "POST", "/api/session/s_fixture/share"), 403);
      assert.equal(await callAs("member", "org-a", "DELETE", "/api/session/s_fixture/share"), 403);
      assert.equal(await callAs("member", "org-a", "POST", "/api/session-shares/" + row.token), 404);
    });
    await check("负责人停用、迁出组织和单人模式都使链接不可用", async () => {
      status = "disabled"; assert.equal(await callAs("member", "org-a", "GET", "/api/session-shares/" + row.token), 404); status = "active";
      ownerOrg = "org-b"; assert.equal(await callAs("member", "org-a", "GET", "/api/session-shares/" + row.token), 404); ownerOrg = "org-a";
      multi = false; assert.equal(await callAs("owner", "org-a", "POST", "/api/session/s_fixture/share"), 403); assert.equal(await callAs("owner", "org-a", "GET", "/api/session-shares/" + row.token), 404);
    });
  } finally { await new Promise((r) => server.close(r)); }
  fs.mkdirSync(path.join(HOME, "data", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "data", "sessions", "s_fixture.json"), JSON.stringify({ ...session, at: new Date().toISOString() }));
  const ownerToken = crypto.randomBytes(24).toString("hex"), memberToken = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(HOME, "data", "users.json"), JSON.stringify({ users: [{ username: "owner", org: "default", salt: "fixture", hash: "fixture", role: "admin" }, { username: "member", org: "default", salt: "fixture", hash: "fixture", role: "member" }], tokens: { [ownerToken]: { user: "owner", at: Date.now() }, [memberToken]: { user: "member", at: Date.now() } } }));
  fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify({ workspace_dir: ws, active_model: "fixture", models: [{ name: "fixture", model: "fixture", base_url: "http://127.0.0.1:9", api_key: secret }], mcp_servers: [] }));
  child = spawn(process.execPath, [entry("server")], { env: { ...process.env, HOST: "127.0.0.1", PORT: "0", OWB_IMPORT_HOME: path.join(HOME, "imports") }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", (d) => { output += d; }); child.stderr.on("data", (d) => { output += d; });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(new Error("isolated server did not start")); }, 60000);
    const poll = setInterval(() => { const m = /已启动: http:\/\/localhost:(\d+)/.exec(output); if (m) { clearTimeout(timeout); clearInterval(poll); resolve(Number(m[1])); } else if (child.exitCode !== null) { clearTimeout(timeout); clearInterval(poll); reject(new Error("isolated server exited")); } }, 100);
  });
  await check("真实服务器：分享默认关闭，主人和成员均不能创建、读取或下载", async () => {
    const row = shares.createShareStore(path.join(HOME, "data", "session-shares.json")).create("s_fixture", "owner", "default");
    for (const token of [ownerToken, memberToken]) {
      for (const [method, url] of [["GET", "/api/session/s_fixture/share"], ["POST", "/api/session/s_fixture/share"], ["DELETE", "/api/session/s_fixture/share"], ["GET", "/api/session-shares/" + row.token], ["GET", "/api/session-shares/" + row.token + "/file?path=report.md"]]) {
        const result = await request(port, method, url, token);
        assert.equal(result.code, 404); assert.equal(result.data.disabled, true);
        assert.ok(!result.text.includes(secret) && !result.text.includes("END-OF-RESULT"));
        assert.equal(result.headers["cache-control"], "no-store");
      }
    }
    assert.equal((await request(port, "GET", "/api/session-shares/" + row.token)).code, 401);
    assert.equal((await request(port, "POST", "/api/session/s_fixture/title", memberToken)).code, 403);
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    const ui = fs.readFileSync(path.join(__dirname, "../public/js/app-02.js"), "utf8");
    assert.ok(!html.includes("app-10-share.js"));
    // 入口只在平台管理员打开后才出现
    assert.ok(/settingsCache\?\.session_shares \? \["share"/.test(ui));
  });
  child.kill("SIGINT"); await new Promise((r) => child.once("exit", r));
  console.log(`Session sharing: ${checks} checks passed`);
})().catch((e) => { console.error(e.stack || e); process.exitCode = 1; if (child && child.exitCode === null) child.kill("SIGKILL"); });
