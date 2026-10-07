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
 *
 * 真起桥子进程，但不起任何 CLI 引擎、不出网。
 *   node test/engine-bridge.js
 */
const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
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

/** 照 CLI 的样子拉起 MCP 服务器：发 initialize + tools/list，stdin 一关它答完就走 */
function mcpList(server, extraEnv = {}) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const env = { ...process.env, ...(server.env || {}), ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const p = spawnSync(server.command, server.args || [], { input, env, encoding: "utf8", timeout: 60000 });
  const msgs = String(p.stdout || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
  const list = msgs.find((m) => m.id === 2);
  return { status: p.status, stdout: String(p.stdout || ""), stderr: String(p.stderr || ""), msgs, names: list && list.result ? list.result.tools.map((t) => t.name) : null };
}

/** 跑 owb 脚本，跟引擎里模型敲的一样 */
function owb(shim, args) {
  try {
    return { code: 0, out: execFileSync("/bin/sh", [shim, ...args], { encoding: "utf8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
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

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
