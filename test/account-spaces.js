// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 工作目录、成果、资料库按账号分开（src/domains/account/spaces.js、admin.js 的 keepsSharedSpace、
 * server.js 的 libraryRootOf 和 /api/files/delete）：
 *
 *   ① 不止一个账号：默认组织的管理员留在原来那份共享根上，项目照建照切（老账本里一个管理员都没有时，
 *      留排第一的老主人）；其余每人一份自己的。同组织两个成员、租户里的成员，
 *      谁也列不出、打不开、搜不到别人的成果和资料
 *   ② 让 AI 去读别人的：绝对路径、../、列别人的目录、全文搜，一个字都带不回来
 *   ③ 升级前的老对话：本人凭对话 id 照样打得开留在共享根里的成果，别人凭同一个 id 打不开；
 *      管理员凭 id 看得到成员这次对话的产出，不凭 id 看不到
 *   ④ 删：只删自己根里的；..、绝对路径、别人的、应用数据、资料库一律不删；这个根里有任务在跑先不删；
 *      别人的任务在跑不挡我；删了记审计
 *   ⑤ 默认组织的管理员一切照旧；只有一个账号时一切照旧，不建 accounts/、不记分配表
 *
 * 客户原话：「成果文件夹现在是组织间隔离，希望做到账号间隔离」「资料库希望也做成账号隔离的，
 * 并且在本地产物下可以进行移除」。
 *
 * 真起 server.js + 假模型。不联网、不花钱、不起 Electron。
 *   node test/account-spaces.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");

// 数据根、工作区、账号全跟着 OPENWORKBUDDY_HOME 走：require 项目模块之前先把家搬到临时目录
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "owb-account-spaces-"));
const HOME = path.join(BASE, "home");
fs.mkdirSync(path.join(HOME, "data", "sessions"), { recursive: true });
process.env.OPENWORKBUDDY_HOME = HOME;
delete process.env.OPENWORKBUDDY_DATA_DIR; // 这个口子指到别处的话，组织表会写到别人的目录里
const org = require(mod("org"));
const prefs = require(mod("prefs"));

let pass = 0, fail = 0, finished = false;
/** @type {import("child_process").ChildProcess[]} */
const children = [];
process.on("exit", (code) => {
  for (const c of children) { try { if (c.exitCode === null) c.kill(); } catch {} }
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  if (finished || code !== 0) return;
  console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
  process.exitCode = 1;
});
setTimeout(() => { console.log("\n✗ 整套跑了 5 分钟还没完，按挂处理"); process.exit(1); }, 300000).unref();
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 400) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 3).join(" | ")}`); }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch {}
    if (Date.now() > end) return false;
    await pause(step);
  }
}
const write = (abs, text) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
/** 路径按段编码：中文名照样走得通，.. 原样留着（要测的就是它） */
const enc = (rel) => rel.split("/").map((s) => (s === ".." ? s : encodeURIComponent(s))).join("/");
/** /api/files 回的那份名单 */
const namesOf = (r) => (Array.isArray(r.json) ? r.json : (r.json && r.json.files) || []).map((f) => String(f.name));

/**
 * 假模型。只认带工具的请求（起标题那类不带工具，随手回一句）：
 *   「【读】」第一趟按 READS 一口气调一串工具，第二趟把每个工具的结果按 id 记进 toolOut；
 *   「【等】」攥着不回，等 release() 再回——用来造「这个根里有任务正在跑」。
 */
/** @type {{ id: string, name: string, args: any }[]} */
let READS = [];
/** @type {Record<string, string>} */
const toolOut = {};
let holding = false;
/** @type {null | (() => void)} */
let releaseHold = null;
const llm = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const usage = { prompt_tokens: 9, completion_tokens: 3 };
    const j = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const say = (text) => j({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
    if (!req.url.includes("/chat/completions")) { res.writeHead(404); return res.end("{}"); }
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (!Array.isArray(body.tools) || !body.tools.length) return say("标题");
    const text = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p && p.text) || "").join("") : "");
    if (msgs.some((m) => m.role === "tool")) {
      for (const m of msgs) if (m.role === "tool") toolOut[m.tool_call_id] = text(m);
      return say("看完了");
    }
    const ask = msgs.filter((m) => m.role === "user").map(text).join("\n");
    if (ask.includes("【读】")) {
      return j({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: READS.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }], usage });
    }
    if (ask.includes("【等】")) {
      holding = true;
      await new Promise((r) => (releaseHold = () => r(undefined)));
      holding = false;
      return say("等完了");
    }
    say("好的");
  });
});

function writeConfig(home, llmPort, extra) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf8"));
  // 模型列表优先于 provider/openai 那套老字段；stream:false 让 llm.js 走非流式，假模型回个普通 JSON 就够
  const m = { base_url: `http://127.0.0.1:${llmPort}/v1`, api_key: "k", model: "mock", stream: false };
  cfg.provider = "openai";
  cfg.openai = { ...m };
  cfg.models = [{ name: "假模型", provider: "openai", ...m }];
  cfg.active_model = "假模型";
  cfg.agent = { ...(cfg.agent || {}), max_steps: 4, tool_timeout_ms: 8000, llm_timeout_ms: 30000 };
  cfg.mcp_servers = [];
  Object.assign(cfg, extra || {});
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2));
}
const at = (ms) => new Date(Date.now() - ms).toISOString();
const user = (username, role, ms, more) => ({ username, salt: "x", hash: "x", role, credits: 0, created_at: at(ms), ...(more || {}) });
const newToken = () => "t" + crypto.randomBytes(16).toString("hex");

/** @returns {Promise<{ code: number, body: string, json: any }>} */
function call(port, token, method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const rq = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      Cookie: "openworkbuddy_token=" + token,
    } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ code: res.statusCode || 0, body: text, json });
      });
    });
    rq.on("error", (e) => resolve({ code: 0, body: e.message, json: null }));
    if (data) rq.write(data);
    rq.end();
  });
}

(async () => {
  await new Promise((r) => llm.listen(0, "127.0.0.1", () => r(undefined)));
  const llmPort = /** @type {any} */ (llm.address()).port;

  // ---------- 一台有五个账号的机器：老主人、同组织一个管理员两个成员、分公司一个成员 ----------
  writeConfig(HOME, llmPort);
  const tenant = org.createOrg({ name: "分公司" }).id;
  const TOK = { boss: newToken(), adm: newToken(), amy: newToken(), bob: newToken(), fen: newToken() };
  fs.writeFileSync(path.join(HOME, "data", "users.json"), JSON.stringify({
    users: [user("boss", "owner", 40000), user("adm", "admin", 35000), user("amy", "member", 30000), user("bob", "member", 20000), user("fen", "member", 10000, { org: tenant })],
    tokens: Object.fromEntries(Object.entries(TOK).map(([u, t]) => [t, { user: u, at: Date.now() }])),
  }));
  const SHARED = path.join(HOME, "workspace");
  write(path.join(SHARED, "老主人.md"), "KEEPER-SECRET 老主人的");
  write(path.join(HOME, "data", "library", "共享资料.md"), "LIB-SHARED");
  write(path.join(HOME, "data", "library-users", prefs.keyOf("bob"), "bob资料.md"), "BOB-LIB");
  // 升级前 amy 跑过的一条对话：那会儿成员都在共享根上，成果留在那里，没人去搬
  const OLD_REL = "任务_0901_老的/amy旧成果.md";
  write(path.join(SHARED, OLD_REL), "AMY-OLD");
  fs.writeFileSync(path.join(HOME, "data", "sessions", "s_old_amy.json"), JSON.stringify({
    id: "s_old_amy", title: "升级前的对话", user: "amy", updated_at: Date.now() - 50000, root: SHARED, dir: "任务_0901_老的",
    transcript: [
      { type: "user", text: "写个东西", at: Date.now() - 60000 },
      { type: "assistant", at: Date.now() - 50000, events: [{ type: "files", changed: [OLD_REL] }] },
    ],
  }));

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: HOME }, { timeoutMs: 120000 });
  children.push(booted.child);
  const { up, port, why } = await booted.wait();
  ok(up, "真 server.js 起来了", up ? undefined : why);
  if (!up) { finished = true; process.exit(1); }
  const as = (/** @type {keyof typeof TOK} */ who) => (method, p, body) => call(port, TOK[who], method, p, body);
  const K = as("boss"), D = as("adm"), A = as("amy"), B = as("bob"), F = as("fen");

  const ROOT = {
    amy: path.join(HOME, "accounts", "amy"),
    bob: path.join(HOME, "accounts", "bob"),
    fen: path.join(HOME, "data", "tenants", tenant, "fen"),
  };
  const FILE = {
    amy: path.join(ROOT.amy, "amy的报告.md"),
    bob: path.join(ROOT.bob, "bob的报告.md"),
    bobDeep: path.join(ROOT.bob, "深", "一层", "bob深.md"),
    fen: path.join(ROOT.fen, "fen文件.md"),
    keeper: path.join(SHARED, "老主人.md"),
  };

  await section("【1】谁用哪份：老主人留在共享根上，其余每人第一次来就分到自己那份，文件夹名一眼认得出是谁", async () => {
    // 先拿设置页分配（不走列表：列表有几秒记忆，空根的结果会挡住后面刚写进去的文件）
    const s = {};
    for (const [who, f] of Object.entries({ boss: K, amy: A, bob: B, fen: F })) s[who] = await f("GET", "/api/settings");
    eq(s.boss.json && s.boss.json.workspace_personal, false, "老主人：不算个人目录（界面照旧能换文件夹、开项目）");
    eq(path.resolve(String(s.boss.json && s.boss.json.workspace_dir)), SHARED, "老主人：还是原来那份工作目录");
    for (const who of ["amy", "bob", "fen"]) {
      eq(s[who].json && s[who].json.workspace_personal, true, `${who}：用的是自己的工作目录`);
      eq(path.resolve(String(s[who].json && s[who].json.workspace_dir)), ROOT[who], `${who}：工作目录就是 ${path.relative(HOME, ROOT[who])}`);
      ok(fs.existsSync(ROOT[who]), `${who}：那个文件夹已经建好了`);
    }
    // 分完再往各自的根里放东西（分配前就有同名文件夹的话会改分 amy_2，那是另一条规矩）
    write(FILE.amy, "AMY-SECRET 报告");
    write(FILE.bob, "BOB-SECRET 报告");
    write(FILE.bobDeep, "BOB-DEEP");
    write(FILE.fen, "FEN-SECRET");
  });

  await section("【2】各看各的：文件面板、工作区、本地产物、搜索，列出来的都只有自己的", async () => {
    const files = {};
    for (const [who, f] of Object.entries({ boss: K, amy: A, bob: B, fen: F })) files[who] = namesOf(await f("GET", "/api/files"));
    ok(files.amy.includes("amy的报告.md") && files.amy.length === 1, "amy 只看到自己那一个", files.amy);
    ok(files.bob.includes("bob的报告.md") && files.bob.includes("深/一层/bob深.md") && files.bob.length === 2, "bob 只看到自己那两个", files.bob);
    ok(files.fen.includes("fen文件.md") && files.fen.length === 1, "分公司的 fen 只看到自己那一个", files.fen);
    ok(files.boss.includes("老主人.md") && !files.boss.some((n) => /amy的|bob|fen/.test(n)), "老主人看到共享根里的，看不到成员自己的", files.boss);

    const treeA = await A("GET", "/api/files/tree");
    ok(treeA.code === 200 && treeA.body.includes("amy的报告.md") && !/bob|fen文件|老主人/.test(treeA.body), "工作区那一栏：amy 的根下只有她自己的", treeA.body.slice(0, 300));
    eq((await A("GET", "/api/files/tree?dir=" + encodeURIComponent("../bob"))).code, 400, "工作区那一栏：amy 拿 ../bob 去点 → 400");
    const treeB = await B("GET", "/api/files/tree?dir=" + encodeURIComponent("深/一层"));
    ok(treeB.code === 200 && treeB.body.includes("bob深.md"), "bob 一层层点得到自己第三层的文件", treeB.body.slice(0, 300));

    const outA = await A("GET", "/api/library/outputs?orphan_limit=500");
    ok(outA.code === 200 && outA.json && outA.json.ws_total === 1, "本地产物：amy 的工作区一共 1 个文件", outA.json && { ws_total: outA.json.ws_total });
    ok(!/bob的|bob深|fen文件|老主人/.test(outA.body), "本地产物：amy 那份里没有别人的名字");
    const outK = await K("GET", "/api/library/outputs?orphan_limit=500");
    ok(outK.body.includes("老主人.md") && !/amy的报告|bob的|fen文件/.test(outK.body), "本地产物：老主人那份照旧是共享根，没混进成员的");

    const q = (f) => f("GET", "/api/library/search?q=SECRET");
    const [qa, qb, qf, qk] = await Promise.all([q(A), q(B), q(F), q(K)]);
    ok(qa.body.includes("amy的报告.md") && !/bob|fen文件|老主人/.test(qa.body), "搜 SECRET：amy 只搜到自己的", qa.body.slice(0, 300));
    ok(qb.body.includes("bob的报告.md") && !/amy的|fen文件|老主人/.test(qb.body), "搜 SECRET：bob 只搜到自己的", qb.body.slice(0, 300));
    ok(qf.body.includes("fen文件.md") && !/amy的|bob|老主人/.test(qf.body), "搜 SECRET：fen 只搜到自己的", qf.body.slice(0, 300));
    ok(qk.body.includes("老主人.md") && !/amy的|bob|fen文件/.test(qk.body), "搜 SECRET：老主人只搜到共享根里的", qk.body.slice(0, 300));
  });

  await section("【3】资料库也分开：老主人还是原来那份，成员各一份", async () => {
    const [lk, la, lb] = await Promise.all([K("GET", "/api/library"), A("GET", "/api/library"), B("GET", "/api/library")]);
    ok(lk.body.includes("共享资料.md") && !lk.body.includes("bob资料"), "老主人的资料库：原来那份共享资料还在", lk.body.slice(0, 300));
    ok(la.code === 200 && !/共享资料|bob资料/.test(la.body), "amy 的资料库：看不到老主人的，也看不到 bob 的", la.body.slice(0, 300));
    ok(lb.body.includes("bob资料.md") && !lb.body.includes("共享资料"), "bob 的资料库：只有他自己的", lb.body.slice(0, 300));
    const [sa, sb] = await Promise.all([A("GET", "/api/library/search?q=" + encodeURIComponent("资料")), B("GET", "/api/library/search?q=LIB")]);
    ok(sa.code === 200 && !/共享资料|bob资料/.test(sa.body), "amy 搜「资料」：搜不到别人的资料库", sa.body.slice(0, 300));
    ok(sb.body.includes("bob资料.md") && !sb.body.includes("共享资料"), "bob 搜正文 LIB：只搜到自己资料库里的", sb.body.slice(0, 300));
  });

  await section("【4】打不开别人的：猜文件名、../、老主人的、拿别人的对话 id", async () => {
    const dl = (f, rel, q) => f("GET", "/api/files/download/" + enc(rel) + (q ? "?" + q : ""));
    const r1 = await dl(A, "bob的报告.md");
    ok(r1.code !== 200 && !r1.body.includes("BOB-SECRET"), "amy 猜 bob 的文件名 → 下不到", r1.code);
    eq((await dl(A, "../bob/bob的报告.md")).code, 400, "amy 走 ../bob → 400");
    const r3 = await dl(A, "老主人.md");
    ok(r3.code !== 200 && !r3.body.includes("KEEPER"), "amy 猜老主人共享根里的文件名 → 下不到", r3.code);
    eq((await dl(F, "../../../../accounts/amy/amy的报告.md")).code, 400, "分公司的 fen 一路 ../ 到 amy 那份 → 400");
    const r5 = await dl(B, OLD_REL, "sid=s_old_amy");
    ok(r5.code !== 200 && !r5.body.includes("AMY-OLD"), "bob 拿 amy 那条老对话的 id 去下 → 下不到", r5.code);
    const r6 = await B("GET", "/api/session/s_old_amy");
    ok(r6.code === 403 || r6.code === 404, "bob 打不开 amy 的老对话", r6.code);
  });

  await section("【5】升级前的老对话：成果留在共享根里没搬，本人照样打得开", async () => {
    const own = await A("GET", "/api/files/download/" + enc(OLD_REL) + "?sid=s_old_amy");
    ok(own.code === 200 && own.body === "AMY-OLD", "amy 从老对话里点开当时的成果 → 打得开", { code: own.code, body: own.body.slice(0, 80) });
    const bare = await A("GET", "/api/files/download/" + enc(OLD_REL));
    ok(bare.code !== 200, "不带对话 id 就不行：共享根不是她的", bare.code);
    const out = await A("GET", "/api/library/outputs?orphan_limit=500");
    ok(JSON.stringify((out.json && out.json.tasks) || []).includes("amy旧成果.md"), "「按任务」里还列得出那条老对话的成果", out.body.slice(0, 300));
    const outB = await B("GET", "/api/library/outputs?orphan_limit=500");
    ok(!outB.body.includes("amy旧成果"), "bob 的「按任务」里没有 amy 的老对话");
  });

  await section("【6】让 AI 去读别人的：绝对路径、../、列别人的目录、全文搜，都带不回来", async () => {
    READS = [
      { id: "c_write", name: "write_file", args: { path: "amy产出.md", content: "AMY-MADE" } },
      { id: "c_own", name: "read_file", args: { path: FILE.amy } },
      { id: "c_bob", name: "read_file", args: { path: FILE.bob } },
      { id: "c_up", name: "read_file", args: { path: "../bob/bob的报告.md" } },
      { id: "c_keeper", name: "read_file", args: { path: FILE.keeper } },
      { id: "c_fen", name: "read_file", args: { path: FILE.fen } },
      { id: "c_ls", name: "list_files", args: { path: ROOT.bob } },
      // 不给 dir 时只搜这条对话自己那格，给成整个根才搜得到 amy 早先放进去的那份
      { id: "c_grep", name: "search_files", args: { query: "SECRET", dir: ROOT.amy } },
      { id: "c_grep_bob", name: "search_files", args: { query: "SECRET", dir: ROOT.bob } },
    ];
    const go = await A("POST", "/api/chat", { sessionId: "s_amy_read", message: "【读】看看大家的文件", mode: "craft", detach: true });
    ok(go.code === 200 && go.json && go.json.accepted, "amy 发起一条对话", go.body.slice(0, 200));
    const done = await waitFor(async () => Object.keys(toolOut).length > 0 && !((await A("GET", "/api/chat/running")).json || []).includes("s_amy_read"), 60000, 200);
    ok(done, "那条对话跑完了", toolOut);
    ok(String(toolOut.c_own || "").includes("AMY-SECRET"), "对照：读自己的文件读得到（工具真跑了）", toolOut.c_own);
    for (const [id, secret] of [["c_bob", "BOB-SECRET"], ["c_up", "BOB-SECRET"], ["c_keeper", "KEEPER-SECRET"], ["c_fen", "FEN-SECRET"]]) {
      ok(id in toolOut && !String(toolOut[id]).includes(secret), `${id}：读不到 ${secret}`, toolOut[id]);
    }
    ok("c_ls" in toolOut && !String(toolOut.c_ls).includes("bob深"), "列 bob 的目录：列不出他的文件", toolOut.c_ls);
    ok(String(toolOut.c_grep || "").includes("amy的报告") && !/bob|fen文件|老主人/.test(String(toolOut.c_grep)), "全文搜 SECRET：只搜到自己的", toolOut.c_grep);
    ok("c_grep_bob" in toolOut && !/BOB-SECRET|bob的报告\.md:|bob深/.test(String(toolOut.c_grep_bob)), "到 bob 的目录里全文搜：搜不到", toolOut.c_grep_bob);
  });

  await section("【7】管理员凭对话 id 看成员这次的产出；不凭 id、别的成员凭 id 都看不到", async () => {
    const rel = namesOf(await A("GET", "/api/files")).find((n) => n.endsWith("amy产出.md")) || "";
    ok(!!rel && fs.existsSync(path.join(ROOT.amy, rel)), "AI 写的文件落在 amy 自己的根里", rel);
    if (!rel) return;
    const k1 = await K("GET", "/api/files/download/" + enc(rel) + "?sid=s_amy_read");
    ok(k1.code === 200 && k1.body === "AMY-MADE", "老主人从 amy 的对话里点开 → 打得开", { code: k1.code, body: k1.body.slice(0, 80) });
    const k2 = await K("GET", "/api/files/download/" + enc(rel));
    ok(k2.code !== 200, "老主人不带对话 id → 打不开（他的根里没有这个）", k2.code);
    for (const [who, f] of [["bob", B], ["fen", F]]) {
      const r = await f("GET", "/api/files/download/" + enc(rel) + "?sid=s_amy_read");
      ok(r.code !== 200 && !r.body.includes("AMY-MADE"), `${who} 拿 amy 的对话 id → 打不开`, r.code);
    }
    const m = await K("GET", "/api/admin/members");
    ok(m.code === 200 && m.body.includes(JSON.stringify(ROOT.amy).slice(1, -1)), "后台成员列表：平台管理员看得到 amy 的文件夹在哪", m.body.slice(0, 300));
  });

  await section("【8】删：只删自己根里的；越界、别人的、资料库都不删", async () => {
    const del = (f, p, dry) => f("POST", "/api/files/delete", dry ? { path: p, dry: true } : { path: p });
    eq((await del(A, "../bob/bob的报告.md")).code, 400, "amy 删 ../bob/… → 400");
    eq((await del(A, FILE.bob)).code, 400, "amy 拿 bob 文件的绝对路径删 → 400");
    const r3 = await del(A, "bob的报告.md");
    ok(r3.code === 404 && r3.json && r3.json.stale === true, "amy 删一个她根里没有的名字 → 404（界面据此重画）", r3.json);
    eq((await del(A, "")).code, 400, "没说删哪个 → 400");
    eq((await del(A, `../../data/library-users/${prefs.keyOf("amy")}`)).code, 400, "amy 删自己的资料库（不在工作目录里）→ 400");
    eq((await del(F, "../../../../accounts/amy/amy的报告.md")).code, 400, "分公司的 fen 删 amy 的 → 400");
    ok(fs.existsSync(FILE.bob) && fs.existsSync(FILE.amy), "上面那几下之后，谁的文件都还在");
    eq((await del(A, `../../data/library/共享资料.md`)).code, 400, "amy 删老主人的资料库 → 400");
    ok(fs.existsSync(path.join(HOME, "data", "library", "共享资料.md")), "共享资料还在");
    const dk = await del(K, "老主人.md", true);
    ok(dk.code === 200 && dk.json && dk.json.ok && dk.json.dry && dk.json.dir === false, "老主人删自己根里的：先问一句（dry）照常回", dk.json);
    ok(fs.existsSync(FILE.keeper), "dry 不真删");
  });

  await section("【9】这个根里有任务正在跑先不删；别人的任务在跑不挡我；删完记审计", async () => {
    const del = (f, p, dry) => f("POST", "/api/files/delete", dry ? { path: p, dry: true } : { path: p });
    const go = await A("POST", "/api/chat", { sessionId: "s_amy_hold", message: "【等】一下", mode: "craft", detach: true });
    ok(go.code === 200 && go.json && go.json.accepted, "amy 又发起一条，模型那头先不回", go.body.slice(0, 200));
    try {
      ok(await waitFor(() => holding, 30000), "那条对话正卡在等模型");
      const busy = await del(A, "amy的报告.md");
      ok(busy.code === 409 && /正在跑/.test(String(busy.json && busy.json.error)), "amy 的根里有任务在跑 → 409，先不删", busy.json);
      ok(fs.existsSync(FILE.amy), "文件还在");
      const dry = await del(B, "深", true);
      ok(dry.code === 200 && dry.json && dry.json.dir === true && dry.json.files === 1 && dry.json.more === false, "bob 删文件夹前先问：里面 1 个文件", dry.json);
      ok(fs.existsSync(path.join(ROOT.bob, "深")), "dry 不真删");
      const gone = await del(B, "深");
      ok(gone.code === 200 && gone.json && gone.json.ok, "amy 的任务在跑，不挡 bob 删自己的文件夹", gone.json);
      ok(!fs.existsSync(path.join(ROOT.bob, "深")), "bob 的那个文件夹真没了");
    } finally {
      if (releaseHold) releaseHold();
    }
    ok(await waitFor(async () => !((await A("GET", "/api/chat/running")).json || []).includes("s_amy_hold"), 30000, 200), "那条对话跑完了");
    const dryA = await del(A, "amy的报告.md", true);
    ok(dryA.code === 200 && dryA.json && dryA.json.dir === false, "跑完了，amy 再问一句：能删", dryA.json);
    const r = await del(A, "amy的报告.md");
    ok(r.code === 200 && r.json && r.json.ok && r.json.removed === "amy的报告.md", "amy 删掉自己的文件", r.json);
    ok(!fs.existsSync(FILE.amy) && fs.existsSync(FILE.bob), "她的没了，bob 的还在");
    ok(!namesOf(await A("GET", "/api/files")).includes("amy的报告.md"), "刷新列表，那一行没了");
    const again = await del(A, "amy的报告.md");
    ok(again.code === 404 && again.json && again.json.stale, "再删一次 → 已经不在了（界面据此重画）", again.json);
    const AUDIT = path.join(HOME, "data", "audit.json");
    const logged = await waitFor(() => {
      const t = fs.readFileSync(AUDIT, "utf8");
      return t.includes("amy：amy的报告.md") && t.includes("bob：深（文件夹，1 个文件）");
    }, 5000, 200);
    ok(logged, "审计里记着谁删了什么（删文件夹的还记着几个文件）");
  });

  await section("【10】项目只归管理员：成员开不了", async () => {
    const r = await A("POST", "/api/projects", { name: "我的项目" });
    eq(r.code, 403, "amy 新建项目 → 403");
  });

  await section("【10.5】默认组织里不是老主人的管理员：跟老主人一样留在共享那份上，项目照建照切", async () => {
    // 10-09 那一版只留了老主人一个：别的管理员被挪进 accounts/ 下一份新的空目录，
    // 他们在共享根上建的项目、攒下的工作空间全看不见了。一个账号本来就能有好几个工作空间
    const st = await D("GET", "/api/settings");
    eq(st.json && st.json.workspace_personal, false, "adm（管理员）：用的是共享那份，不单开一份");
    eq(path.resolve(String(st.json && st.json.workspace_dir)), SHARED, "adm：工作目录还是原来的共享根");
    ok(!fs.existsSync(path.join(HOME, "accounts", "adm")), "  └ 没给他另建 accounts/adm");
    ok(namesOf(await D("GET", "/api/files")).includes("老主人.md"), "adm 的文件面板里看得到共享根里原来的东西");
    const dl = await D("GET", "/api/files/download/" + enc("老主人.md"));
    ok(dl.code === 200 && dl.body.includes("KEEPER"), "adm 打得开共享根里的文件", dl.code);
    ok(/共享资料/.test((await D("GET", "/api/library")).body), "adm 的资料库就是共享那份");
    const pj = (await D("GET", "/api/projects")).json;
    ok(pj && pj.locked === false && pj.active === "默认项目", "adm 的侧栏有项目这一块，当前在默认项目", pj);
    const mk = await D("POST", "/api/projects", { name: "管理员的项目" });
    ok(mk.code === 200 && mk.json && mk.json.ok && mk.json.active === "管理员的项目", "adm 新建项目照常，建完就切过去", mk.json);
    const names = (((await K("GET", "/api/projects")).json || {}).projects || []).map((/** @type {any} */ p) => p.name);
    ok(names.includes("默认项目") && names.includes("管理员的项目"), "老主人那边的项目列表里也有这一个（两人用同一份列表）", names);
    const back = await D("POST", "/api/projects/switch", { name: "默认项目" });
    ok(back.code === 200 && back.json && back.json.ok, "adm 切回默认项目", back.json);
    eq(path.resolve(String((await K("GET", "/api/settings")).json.workspace_dir)), SHARED, "  └ 切回来了，共享根原样");
    eq((await A("POST", "/api/projects", { name: "成员的项目" })).code, 403, "成员 amy 还是建不了项目（跟 10-09 之前一样）");
  });

  // ---------- 只有一个账号的机器：一切照旧 ----------
  await section("【11】只有一个账号：工作目录、资料库照旧；工作目录把数据根包在里面也删不到数据和资料库", async () => {
    const SOLO = path.join(BASE, "solo");
    const HOME2 = path.join(SOLO, "home");
    fs.mkdirSync(path.join(HOME2, "data"), { recursive: true });
    // 工作目录挑在数据根的上一层：自己选文件夹时选大了，就是这个样子
    writeConfig(HOME2, llmPort, { workspace_dir: SOLO });
    const tok = newToken();
    fs.writeFileSync(path.join(HOME2, "data", "users.json"), JSON.stringify({
      users: [user("solo", "owner", 1000)], tokens: { [tok]: { user: "solo", at: Date.now() } },
    }));
    write(path.join(SOLO, "报告.md"), "SOLO-REPORT");
    write(path.join(HOME2, "data", "library", "资料.md"), "SOLO-LIB");
    write(path.join(HOME2, "workspace", "默认区.md"), "x");
    const b2 = bootRealServer({ OPENWORKBUDDY_HOME: HOME2 }, { timeoutMs: 120000 });
    children.push(b2.child);
    const w = await b2.wait();
    ok(w.up, "第二份 server.js 起来了", w.up ? undefined : w.why);
    if (!w.up) return;
    const S = (method, p, body) => call(w.port, tok, method, p, body);
    const st = await S("GET", "/api/settings");
    eq(st.json && st.json.workspace_personal, false, "一个账号：不算个人目录");
    eq(path.resolve(String(st.json && st.json.workspace_dir)), SOLO, "一个账号：工作目录还是自己选的那个");
    ok(namesOf(await S("GET", "/api/files")).includes("报告.md"), "文件面板照旧列得出");
    ok((await S("GET", "/api/library")).body.includes("资料.md"), "资料库照旧是 data/library 那份");
    const del = (p, dry) => S("POST", "/api/files/delete", dry ? { path: p, dry: true } : { path: p });
    const d0 = await del("报告.md", true);
    ok(d0.code === 200 && d0.json && d0.json.ok, "自己的文件照常能删（先问一句）", d0.json);
    for (const p of ["home", "home/data", "home/data/library/资料.md", "home/workspace"]) {
      const r = await del(p);
      eq(r.code, 400, `删 ${p} → 400（应用数据、资料库、默认工作区不给删）`);
    }
    ok(fs.existsSync(path.join(HOME2, "data", "library", "资料.md")) && fs.existsSync(path.join(HOME2, "workspace", "默认区.md")), "资料库、默认工作区都还在");
    ok(!fs.existsSync(path.join(HOME2, "accounts")) && !fs.existsSync(path.join(HOME2, "data", "account-spaces.json")), "一个账号：不建 accounts/，不记分配表");
  });

  finished = true;
  try { llm.close(); } catch {}
  console.log(`\n${fail ? "✗" : "✓"} 按账号分开工作目录和资料库：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();

/**
 * 起一份真的 server.js。照抄 test/library-ws.js 里那份（再往上是 test/e2e.js）：只认「已启动: http://localhost:端口」那一行。
 * @param {Record<string,string>} env
 * @param {{ timeoutMs?: number, port?: string }} [opts]
 */
function bootRealServer(env, { timeoutMs = 60000, port = "0" } = {}) {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [entry("server")], {
    env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const ready = new Promise((resolve) => {
    const done = (/** @type {boolean} */ v) => { clearInterval(tick); clearTimeout(t); resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    const tick = setInterval(() => {
      if (/已启动: http:\/\/localhost:\d+/.test(log)) done(true);
      else if (child.exitCode !== null) done(false);
    }, 200);
  });
  return {
    child,
    get log() { return log; },
    async wait() {
      const up = await ready;
      const m = /已启动: http:\/\/localhost:(\d+)/.exec(log);
      return { up: !!up && !!m, port: m ? Number(m[1]) : 0, why: `退出码=${child.exitCode} 存活=${child.exitCode === null} 日志尾巴=${JSON.stringify(log.slice(-400)) || "(空)"}` };
    },
  };
}
