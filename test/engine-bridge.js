// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 借给本机引擎的工具：借哪些只有一份名单（src/engines/lendable.js），三处都照它走——
 * 提示词里列的（attach 给的 lent）、MCP 挂上的（tools/list）、命令行打出来的（owb list）。
 *
 *   ① 名单本身：不传 = 整张表，空数组 = 一个不借，不认识的名字不认，没浏览器就摘掉要浏览器的
 *   ② 一个不借就真的一个不借：桥那头拿到「-」，MCP 和 owb 都是空的，调了被拒
 *   ③ 挑过的名单：attach 的 lent、tools/list、owb list 三处一样，要浏览器的不在里面
 *   ④ 桥被拉起时没拿到名单就不启动（按整张表兜底等于把关掉的工具又借出去）；名单里混进不该借的名字也不认
 *   ⑤ 主进程 require bridge.js / agent.js 不再顺带 require tool-bridge.js（那会把主进程的 console 改道 stderr）。
 *      这里只查得到顶层的 require；写在函数里、开跑才执行的，由 layers 的 require-spawn 检查兜住
 *   ⑥ 产物落在这趟任务的根下面，资料库只看得见这个人的、只看得见项目挂的那一块；给了根却用不了就不启动
 *   ⑦ 主进程真跑一趟（假引擎）：租户的根、资料库根、项目挂载都传到了桥那头；
 *      属主在引擎设置里写了 PATH 也挤不掉打头的 owb 目录
 *   ⑧ 借出去生图（假上游）：回执给相对引擎当前目录的路径 + 完整路径，不说「工作空间内的相对路径」；
 *      主模型和引擎命中同一条生成缓存，各拿各坐标系里的路径
 *
 * 真起桥子进程，但不起任何 CLI 引擎、不出网（假生图上游起在 127.0.0.1）。
 *   node test/engine-bridge.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync, execFileSync, execFile } = require("child_process");
const { mod } = require("./lib/mod");
// 赶在 require 生产模块之前：桥子进程照 OPENWORKBUDDY_HOME 找数据目录，不能落进用户真在用的那份（见 test/lib/own-home.js）
const HOME = require("./lib/own-home")("engine-bridge");

const lendable = require(mod("lendable"));
const bridge = require(mod("bridge"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);
const sorted = (a) => [...a].sort().join(",");
const SH = process.platform !== "win32"; // owb 脚本是 sh 写的

/** 照 CLI 的样子拉起 MCP 服务器：发 initialize 再发一条请求（id 2），stdin 一关它答完就走 */
function mcpOnce(server, req, extraEnv = {}) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, ...req },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const env = { ...process.env, ...(server.env || {}), ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const p = spawnSync(server.command, server.args || [], { input, env, encoding: "utf8", timeout: 60000 });
  const msgs = String(p.stdout || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
  return { status: p.status, stdout: String(p.stdout || ""), stderr: String(p.stderr || ""), msgs, res: msgs.find((m) => m.id === 2) };
}
function mcpList(server, extraEnv = {}) {
  const r = mcpOnce(server, { method: "tools/list" }, extraEnv);
  return { ...r, names: r.res && r.res.result ? r.res.result.tools.map((t) => t.name) : null };
}
function mcpCall(server, name, args) {
  const r = mcpOnce(server, { method: "tools/call", params: { name, arguments: args } });
  const out = r.res && r.res.result;
  return { status: r.status, ok: !!(out && !out.isError), text: out ? out.content.map((c) => c.text).join("\n") : "", err: r.stderr.slice(-400) };
}

/** 跑 owb 脚本，跟引擎里模型敲的一样 */
function owb(shim, args) {
  try {
    return { code: 0, out: execFileSync("/bin/sh", [shim, ...args], { encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}
/** 同上，但不卡住事件循环：工具要连本进程里起的假上游 */
function owbAsync(shim, args) {
  return new Promise((resolve) => execFile("/bin/sh", [shim, ...args], { encoding: "utf8", timeout: 60000 }, (e, out, err) =>
    resolve({ code: e ? (typeof e.code === "number" ? e.code : -1) : 0, out: String(out || "") + (e ? String(err || "") : "") })));
}
/** owb list 的输出 → 工具名（每条第一行顶格是名字，第二行缩进是说明） */
const listedNames = (out) => out.split("\n").filter((l) => l && !/^\s/.test(l) && !/^（/.test(l)).map((l) => l.split(/\s/)[0]);

/** 读 claude 那边的 mcp 配置，拿到桥那台服务器的启动参数 */
const serverOf = (att) => JSON.parse(fs.readFileSync(att.runOpts.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME];

(async () => {
  section("① 名单本身");
  {
    const { LENDABLE, NEEDS_RENDERER, NONE, lentFor, toEnv, parseList } = lendable;
    ok(LENDABLE.length > 0 && new Set(LENDABLE).size === LENDABLE.length, "整张表不空、没有重名", LENDABLE);
    ok(NEEDS_RENDERER.every((n) => LENDABLE.includes(n)), "要浏览器的那几个都在整张表里", NEEDS_RENDERER);
    ok(sorted(lentFor()) === sorted(LENDABLE), "不传名单 = 整张表");
    ok(lentFor({ tools: [] }).length === 0, "空数组 = 一个不借，不是整张表", lentFor({ tools: [] }));
    ok(sorted(lentFor({ tools: ["run_shell", "write_file", "generate_image"] })) === "generate_image", "不在表里的名字（run_shell、write_file）不认", lentFor({ tools: ["run_shell", "write_file", "generate_image"] }));
    const noR = lentFor({ renderer: false });
    ok(!noR.some((n) => NEEDS_RENDERER.includes(n)) && noR.length === LENDABLE.length - NEEDS_RENDERER.length, "没浏览器时只摘掉要浏览器的那几个", noR);
    ok(JSON.stringify(lentFor({ tools: ["remember", "generate_image"] })) === JSON.stringify(["generate_image", "remember"]), "顺序跟整张表一致，不跟调用方传的顺序", lentFor({ tools: ["remember", "generate_image"] }));
    ok(toEnv([]) === NONE && NONE !== "", "一个不借时写进环境变量的不是空串（空值的变量在 Windows 上不一定留得住）", toEnv([]));
    ok(parseList(NONE).length === 0 && parseList("").length === 0, "「-」和空串读回来都是一个不借", [parseList(NONE), parseList("")]);
    ok(JSON.stringify(parseList(toEnv(["generate_image", "remember"]))) === JSON.stringify(["generate_image", "remember"]), "写进去再读回来不变");
  }

  section("② 一个不借");
  {
    const cx = bridge.attach("codex", { home: HOME, baseDir: "任务_空", user: "t", tools: [] });
    try {
      ok(Array.isArray(cx.lent) && cx.lent.length === 0 && cx.toolCount === 0, "attach 给出的借出名单是空的", cx.lent);
      ok(cx.runOpts.mcpArgs.some((a) => a.includes(`OPENWORKBUDDY_BRIDGE_TOOLS = ${JSON.stringify(lendable.NONE)}`)),
        "codex 的 MCP 参数里写了「一个不借」，没把这个变量漏掉", cx.runOpts.mcpArgs.filter((a) => /env=/.test(a)));
      if (SH) {
        const src = fs.readFileSync(cx.shim, "utf8");
        ok(src.includes(`OPENWORKBUDDY_BRIDGE_TOOLS='${lendable.NONE}'`), "owb 脚本里也烘进了「一个不借」");
        const l = owb(cx.shim, ["list"]);
        ok(l.code === 0 && /（这次没借出任何工具）/.test(l.out) && listedNames(l.out).length === 0, "owb list 说这次没借出任何工具", l);
        const c = owb(cx.shim, ["generate_image", JSON.stringify({ prompt: "一只猫" })]);
        ok(c.code !== 0 && /没有借给/.test(c.out), "owb 调生图被拒", c);
      } else console.log("  （Windows：跳过 owb 脚本那几条）");
    } finally { cx.cleanup(); }
    const cc = bridge.attach("claude-code", { home: HOME, baseDir: "任务_空", user: "t", tools: [] });
    try {
      const sv = serverOf(cc);
      ok(sv.env.OPENWORKBUDDY_BRIDGE_TOOLS === lendable.NONE, "claude 的 MCP 配置里写了「一个不借」", sv.env.OPENWORKBUDDY_BRIDGE_TOOLS);
      const r = mcpList(sv);
      ok(r.status === 0 && Array.isArray(r.names) && r.names.length === 0, "MCP tools/list 是空的", r);
    } finally { cc.cleanup(); }
  }

  section("③ 挑过的名单：提示词、MCP、owb 三处一样");
  {
    const pick = ["remember", "generate_image", "html_to_image", "render_page", "run_shell", "library_list"];
    const want = ["generate_image", "library_list", "remember"];
    const cc = bridge.attach("claude-code", { home: HOME, baseDir: "任务_挑", user: "t", tools: pick });
    try {
      ok(sorted(cc.lent) === sorted(want) && cc.toolCount === want.length, "attach 的借出名单：要浏览器的、不在表里的都摘了", cc.lent);
      const r = mcpList(serverOf(cc));
      ok(r.status === 0 && r.names && sorted(r.names) === sorted(cc.lent), "MCP 挂上的 = 借出名单", { mcp: r.names, lent: cc.lent, err: r.stderr.slice(-300) });
      if (SH) {
        const l = owb(cc.shim, ["list"]);
        ok(l.code === 0 && sorted(listedNames(l.out)) === sorted(cc.lent), "owb list 打出来的 = 借出名单", { owb: listedNames(l.out), lent: cc.lent });
        const c = owb(cc.shim, ["html_to_image", JSON.stringify({ html: "<p>x</p>" })]);
        ok(c.code !== 0 && /没有借给/.test(c.out), "不在名单里的（html_to_image）owb 调了被拒", c);
      }
    } finally { cc.cleanup(); }
    // 不传名单：整张表去掉要浏览器的
    const all = bridge.attach("claude-code", { home: HOME, baseDir: "任务_全", user: "t" });
    try {
      ok(sorted(all.lent) === sorted(lendable.lentFor({ renderer: false })), "不传名单：整张表去掉要浏览器的", all.lent);
      const r = mcpList(serverOf(all));
      ok(r.names && sorted(r.names) === sorted(all.lent), "不传名单时 MCP 挂上的也 = 借出名单", { mcp: r.names, lent: all.lent });
    } finally { all.cleanup(); }
  }

  section("④ 桥自己把关");
  {
    const entry = mod("tool-bridge");
    const env = { ...process.env, OPENWORKBUDDY_HOME: HOME };
    delete env.OPENWORKBUDDY_BRIDGE_TOOLS;
    const p = spawnSync(process.execPath, [entry, "list"], { env, encoding: "utf8", timeout: 60000 });
    ok(p.status === 2 && /没拿到 OPENWORKBUDDY_BRIDGE_TOOLS/.test(p.stderr) && p.stdout === "", "没拿到名单：owb list 不打整张表，报错退出", { status: p.status, out: p.stdout.slice(0, 200), err: p.stderr.slice(0, 200) });
    const m = mcpList({ command: process.execPath, args: [entry], env });
    ok(m.status === 2 && m.stdout === "" && m.names === null, "没拿到名单：MCP 服务器不启动，一条 tools/list 都不答", { status: m.status, out: m.stdout.slice(0, 200) });
    // 名单里混进不该借的名字：只认表里有的
    const p2 = spawnSync(process.execPath, [entry, "call", "run_shell", JSON.stringify({ command: "echo should-not-run" })],
      { env: { ...env, OPENWORKBUDDY_BRIDGE_TOOLS: "run_shell,remember" }, encoding: "utf8", timeout: 60000 });
    ok(p2.status === 1 && /没有借给/.test(p2.stderr) && !/should-not-run/.test(p2.stdout), "名单里写了 run_shell 也不借（不在整张表里）", { status: p2.status, out: p2.stdout.slice(0, 200), err: p2.stderr.slice(0, 200) });
    const m2 = mcpList({ command: process.execPath, args: [entry], env: { ...env, OPENWORKBUDDY_BRIDGE_TOOLS: "run_shell,remember" } });
    ok(m2.names && sorted(m2.names) === "remember", "名单里写了 run_shell，MCP 上也只挂 remember", m2.names);
  }

  section("⑤ 主进程不再 require tool-bridge.js");
  {
    const code = [
      "const before = console.log;",
      `require(${JSON.stringify(mod("bridge"))});`,
      "const afterBridge = console.log === before;",
      `require(${JSON.stringify(mod("agent"))});`,
      "const afterAgent = console.log === before;",
      "const tb = Object.keys(require.cache).filter((k) => /tool-bridge\\.js$/.test(k)).length;",
      "process.stdout.write('\\nRESULT ' + JSON.stringify({ afterBridge, afterAgent, tb }) + '\\n');",
      "process.exit(0);",
    ].join("\n");
    const p = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, OPENWORKBUDDY_HOME: HOME }, encoding: "utf8", timeout: 120000 });
    const line = String(p.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    const r = line ? JSON.parse(line.slice(7)) : null;
    ok(r && r.afterBridge, "require bridge.js 之后 console.log 还是原来那个", r || { status: p.status, err: String(p.stderr || "").slice(-400) });
    ok(r && r.afterAgent, "require agent.js 之后 console.log 还是原来那个", r);
    ok(r && r.tb === 0, "主进程里没有加载 tool-bridge.js", r);
  }

  section("⑥ 产物落在这趟任务的根，资料库只看得见这个人的");
  {
    const mk = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
    // 两个账号各一份资料库；数据目录下那份当成「这台机器的主人」的
    const rootA = path.join(HOME, "orgs", "甲", "workspace");
    const libA = path.join(HOME, "data", "library-users", "甲");
    const libB = path.join(HOME, "data", "library-users", "乙");
    mk(path.join(libA, "甲方合同.md"), "甲的合同正文");
    mk(path.join(libA, "客户A", "需求.md"), "客户A的需求");
    mk(path.join(libB, "乙方报价.md"), "乙的报价正文");
    mk(path.join(HOME, "data", "library", "主人的.md"), "机器主人的资料");
    const lend = ["gen_diagram", "library_list", "library_read"];
    const dot = (f) => JSON.stringify({ kind: "dot", source: "digraph{A->B}", filename: f });

    const a = bridge.attach("claude-code", { home: HOME, root: rootA, baseDir: "任务_根", user: "甲", tools: lend, library: { base: libA, mount: "" } });
    try {
      const sv = serverOf(a);
      ok(sv.env.OPENWORKBUDDY_BRIDGE_ROOT === rootA && sv.env.OPENWORKBUDDY_BRIDGE_LIB_ROOT === libA && !("OPENWORKBUDDY_BRIDGE_LIB_MOUNT" in sv.env),
        "MCP 配置里带上了这趟任务的根和资料库根；没挂子目录就不写挂载", sv.env);
      const c = mcpCall(sv, "gen_diagram", JSON.parse(dot("经MCP.png")));
      ok(c.ok && fs.existsSync(path.join(rootA, "任务_根", "经MCP.png")), "MCP 调出来的图落在这趟任务的根下面", c);
      if (SH) {
        const g = owb(a.shim, ["gen_diagram", dot("经owb.png")]);
        ok(g.code === 0 && fs.existsSync(path.join(rootA, "任务_根", "经owb.png")), "owb 调出来的图也落在这趟任务的根下面", g);
        ok(!fs.existsSync(path.join(HOME, "workspace", "任务_根")), "数据目录下的默认工作区里没有这趟任务的东西");
        const l = owb(a.shim, ["library_list"]);
        ok(l.code === 0 && /甲方合同\.md/.test(l.out) && /客户A\/需求\.md/.test(l.out), "甲列资料库：看得见自己的", l.out);
        ok(!/乙方报价|主人的/.test(l.out), "甲列资料库：看不见乙的，也看不见机器主人的", l.out);
        const r1 = owb(a.shim, ["library_read", JSON.stringify({ name: "甲方合同.md" })]);
        ok(r1.code === 0 && /甲的合同正文/.test(r1.out), "甲读得到自己的文件", r1);
        const r2 = owb(a.shim, ["library_read", JSON.stringify({ name: "乙方报价.md" })]);
        ok(!/乙的报价正文/.test(r2.out), "甲按名字去读乙的文件读不到", r2);
        const r3 = owb(a.shim, ["library_read", JSON.stringify({ name: "../乙/乙方报价.md" })]);
        ok(!/乙的报价正文/.test(r3.out), "带 ../ 翻到乙的目录也读不到", r3);
      }
    } finally { a.cleanup(); }

    if (SH) {
      const b = bridge.attach("claude-code", { home: HOME, root: path.join(HOME, "orgs", "乙", "workspace"), baseDir: "任务_乙", user: "乙", tools: lend, library: { base: libB } });
      try {
        const l = owb(b.shim, ["library_list"]);
        ok(l.code === 0 && /乙方报价\.md/.test(l.out) && !/甲方合同|需求\.md|主人的/.test(l.out), "乙列资料库：只看得见自己的", l.out);
      } finally { b.cleanup(); }

      const m = bridge.attach("claude-code", { home: HOME, root: rootA, baseDir: "任务_挂", user: "甲", tools: lend, library: { base: libA, mount: "客户A" } });
      try {
        ok(serverOf(m).env.OPENWORKBUDDY_BRIDGE_LIB_MOUNT === "客户A", "项目挂了资料库的一块：配置里写了挂载的子目录", serverOf(m).env);
        const l = owb(m.shim, ["library_list"]);
        ok(l.code === 0 && /需求\.md/.test(l.out) && !/甲方合同/.test(l.out), "项目只挂了「客户A」：列出来的只有那一块", l.out);
      } finally { m.cleanup(); }

      // 反向对照：老调用方什么都不传，还是数据目录下那份（单机个人版一行行为不变）
      const o = bridge.attach("claude-code", { home: HOME, baseDir: "任务_老", user: "", tools: lend });
      try {
        const sv = serverOf(o);
        ok(!("OPENWORKBUDDY_BRIDGE_ROOT" in sv.env) && !("OPENWORKBUDDY_BRIDGE_LIB_ROOT" in sv.env), "什么都不传：配置里不写根，也不写资料库根", sv.env);
        const l = owb(o.shim, ["library_list"]);
        ok(l.code === 0 && /主人的\.md/.test(l.out) && !/甲方合同|乙方报价/.test(l.out), "反向对照：什么都不传就是数据目录下那份", l.out);
        const g = owb(o.shim, ["gen_diagram", dot("老路.png")]);
        ok(g.code === 0 && fs.existsSync(path.join(HOME, "workspace", "任务_老", "老路.png")), "反向对照：什么都不传，产物落数据目录下的 workspace", g);
      } finally { o.cleanup(); }
    }

    // 传了根却用不了：不退回默认根（那是别人的地盘），报错不启动
    const entry = mod("tool-bridge");
    const file = path.join(HOME, "是个文件");
    fs.writeFileSync(file, "x");
    const bad = (extra) => ({ ...process.env, OPENWORKBUDDY_HOME: HOME, OPENWORKBUDDY_BRIDGE_TOOLS: "gen_diagram", OPENWORKBUDDY_BRIDGE_BASEDIR: "任务_坏", ...extra });
    for (const [label, extra] of [
      ["根是个建不出来的目录", { OPENWORKBUDDY_BRIDGE_ROOT: path.join(file, "下面") }],
      ["根不是绝对路径", { OPENWORKBUDDY_BRIDGE_ROOT: "相对/路径" }],
      ["根是空串", { OPENWORKBUDDY_BRIDGE_ROOT: "" }],
      ["资料库根不是绝对路径", { OPENWORKBUDDY_BRIDGE_ROOT: rootA, OPENWORKBUDDY_BRIDGE_LIB_ROOT: "相对/资料库" }],
    ]) {
      const p = spawnSync(process.execPath, [entry, "gen_diagram", dot("不该有.png")], { env: bad(extra), encoding: "utf8", timeout: 60000 });
      ok(p.status === 2 && /没有启动/.test(p.stderr) && p.stdout === "", `${label}：报错不启动`, { status: p.status, out: p.stdout.slice(0, 200), err: p.stderr.slice(0, 300) });
      const mm = mcpList({ command: process.execPath, args: [entry], env: bad(extra) });
      ok(mm.status === 2 && mm.stdout === "", `${label}：MCP 服务器也不启动`, { status: mm.status, out: mm.stdout.slice(0, 200) });
    }
    ok(!fs.existsSync(path.join(HOME, "workspace", "任务_坏")), "用不了的根没有退回默认工作区去建目录、写东西");
  }

  section("⑦ 主进程照这趟任务的根和资料库去借");
  {
    const tools = require(mod("tools"));
    const engines = require(mod("engines"));
    const { createAgentRuntime } = require(mod("agent"));
    const { McpManager } = require(mod("mcp"));
    let seen = null;
    const stub = {
      id: "t-roots", label: "根桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: false, models: [],
      async detect() { return { id: "t-roots", installed: true, path: "", version: "0" }; },
      // 配置文件跑完就删，只能在 run() 里读
      async run(o) {
        // owb 脚本所在的目录也是跑完就删：PATH 打头的是不是它，得趁现在看
        const first = String((o.env && o.env.PATH) || "").split(path.delimiter)[0];
        let shimFirst = false;
        try { shimFirst = !!first && fs.readdirSync(first).some((n) => /^owb(\.cmd)?$/i.test(n)); } catch {}
        try { seen = { env: JSON.parse(fs.readFileSync(o.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME].env, cwd: o.cwd, runEnv: o.env || {}, shimFirst }; }
        catch (e) { seen = { err: e.message }; }
        return { finalText: "好", usage: {}, stopped: null, sessionId: null };
      },
    };
    engines.BACKENDS.push(stub);
    const fakeLLM = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
    const rt = createAgentRuntime({ config: { agent: { engine: "t-roots", max_steps: 3, engine_options: { "t-roots": { model: "m1" } } } }, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
    const go = () => rt.runTask({ history: [{ role: "user", content: "干活" }], emit() {} });
    try {
      const rootT = path.join(HOME, "orgs", "丙", "workspace");
      const libT = path.join(HOME, "data", "library-users", "丙");
      fs.mkdirSync(rootT, { recursive: true });
      await tools.withWorkspace(rootT, () => tools.withLibraryBase(libT, () => tools.withLibraryDir("客户C", go)));
      const env = (seen && seen.env) || {};
      ok(env.OPENWORKBUDDY_BRIDGE_ROOT === rootT, "★租户的任务：桥拿到的是租户自己的根★", seen);
      ok(env.OPENWORKBUDDY_BRIDGE_LIB_ROOT === libT && env.OPENWORKBUDDY_BRIDGE_LIB_MOUNT === "客户C", "★租户的任务：资料库根和项目挂载都跟着这趟任务走★", seen);
      ok(seen && typeof seen.cwd === "string" && (seen.cwd + path.sep).startsWith(rootT + path.sep), "引擎的 cwd 也在这个根下面，跟桥写产物的地方是同一个", seen && seen.cwd);
      seen = null;
      await go();
      const env2 = (seen && seen.env) || {};
      ok(env2.OPENWORKBUDDY_BRIDGE_ROOT === tools.getWorkspaceDir() && env2.OPENWORKBUDDY_BRIDGE_LIB_ROOT === tools.LIB_DIR,
        "反向对照：不在租户的链上就是默认根和数据目录下那份资料库", { env: env2, ws: tools.getWorkspaceDir(), lib: tools.LIB_DIR });
      ok(seen && seen.shimFirst, "属主没写 PATH：owb 那个目录在 PATH 最前面", seen && seen.runEnv);

      // 属主在引擎设置里写了 PATH：拼在 owb 目录后面，不能把它整个顶掉
      seen = null;
      const OWNER = path.join(HOME, "属主的bin");
      const rt2 = createAgentRuntime({ config: { agent: { engine: "t-roots", max_steps: 3, engine_options: { "t-roots": { model: "m1", env: { PATH: OWNER, FOO: "属主的" } } } } }, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
      await rt2.runTask({ history: [{ role: "user", content: "干活" }], emit() {} });
      const runEnv = (seen && seen.runEnv) || {};
      ok(seen && seen.shimFirst, "★属主在引擎设置里写了 PATH：owb 那个目录还在最前面★", runEnv);
      ok(String(runEnv.PATH || "").split(path.delimiter)[1] === OWNER && runEnv.FOO === "属主的", "属主写的 PATH 接在它后面，别的变量照传", runEnv);
    } finally { engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1); }
  }

  section("⑧ 回执里的路径照引擎的当前目录说，缓存两边命中也不串坐标系");
  {
    // 假生图上游：本机随机端口，回一张 1×1 的 PNG。桥子进程要连它，所以这里拉子进程一律不用同步的
    const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    let hits = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.method === "POST" && /\/images\/generations$/.test(req.url || "")) {
          hits++;
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }));
        }
        res.writeHead(404); res.end("{}");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
    // 假上游在本机，别让任何代理设置把请求带出去
    process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";
    const addr = /** @type {import("net").AddressInfo} */ (server.address());
    const media = { image: { base_url: `http://127.0.0.1:${addr.port}/v1`, api_key: "sk-test-engine-bridge-0001", model: "dall-e-3" } };
    const tools = require(mod("tools"));
    const mm = require(mod("media-models"));
    const cfg = { media };
    mm.normalize(cfg);
    // 桥子进程读家目录下的 config.json，存的是整理过的样子（渠道 + 型号表），跟设置页存下来的一样
    fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify(cfg));

    const root = path.join(HOME, "orgs", "丙", "workspace");
    const task = path.join(root, "任务_回执");
    const abs = path.join(task, "猫.png");
    const input = { prompt: "一只猫", filename: "猫.png" };
    /** @returns {Promise<any>} */
    const inProc = () => tools.withWorkspace(root, () => tools.executeTool("generate_image", input, { media: mm.resolve(cfg), security: { gateway: false }, baseDir: "任务_回执" }));
    try {
      if (SH) {
        const a = bridge.attach("claude-code", { home: HOME, root, baseDir: "任务_回执", user: "丙", tools: ["generate_image"] });
        try {
          const g = await owbAsync(a.shim, ["generate_image", JSON.stringify(input)]);
          ok(g.code === 0 && fs.existsSync(abs) && hits === 1, "借出去生了一张：落在这趟任务的根下面，上游收到一次", { g, hits });
          ok(g.out.includes(`图片已生成：猫.png（完整路径 ${abs}，`), "★回执给的是相对引擎当前目录的路径，再附完整路径★", g.out);
          ok(!/工作空间内的相对路径/.test(g.out) && !g.out.includes("图片已生成：任务_回执/"), "不再说「工作空间内的相对路径」，相对路径也不带当前目录外面那一截「任务_回执/」", g.out);
        } finally { a.cleanup(); }
      } else {
        await inProc(); // owb 脚本是 sh 写的：Windows 上由主进程先生一张，下面照样验引擎命中这条
      }

      // 同一个对话里主模型接着跑同一格：命中缓存，回执是主进程那套坐标
      const m = await inProc();
      ok(m && m.cached === true && hits === 1, "主模型重跑同一格：命中缓存，没再打上游", { hits, m });
      ok(m && String(m.content).startsWith("图片已生成：任务_回执/猫.png（工作空间内的相对路径，"), "★缓存里存的是平时的写法★ 主模型拿到的不是引擎坐标系里的路径", m && m.content);

      // 反过来：引擎命中主模型存的那条，也换成引擎的坐标
      tools.setReplyBase(task);
      const e = await inProc();
      ok(e && e.cached === true && hits === 1 && String(e.content).startsWith(`图片已生成：猫.png（完整路径 ${abs}，`),
        "引擎命中缓存：同样换成相对当前目录 + 完整路径", e && e.content);
    } finally {
      tools.setReplyBase(null);
      server.close();
    }
    const back = tools.withWorkspace(root, () => tools._internals.savedAt(task, "猫.png"));
    ok(back === "任务_回执/猫.png", "反向对照：没设的时候（主进程里）照旧报相对工作空间根的路径", back);
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
