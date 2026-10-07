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
 *   ⑥ 产物落在这趟任务的根下面，资料库只看得见这个人的、只看得见项目挂的那一块，取素材也只取得到自己的；
 *      给了根却用不了就不启动
 *   ⑦ 主进程真跑一趟（假引擎）：租户的根、资料库根、项目挂载都传到了桥那头；
 *      属主在引擎设置里写了 PATH 也挤不掉打头的 owb 目录
 *   ⑧ 借出去生图（假上游）：回执给相对引擎当前目录的路径 + 完整路径，不说「工作空间内的相对路径」；
 *      主模型和引擎命中同一条生成缓存，各拿各坐标系里的路径
 *   ⑨ 设置文件读不出来（JSON 坏了、最外层不是一组设置）：借来的工具一律不执行，报文件在哪和原话、
 *      系统日志里留一条；文件不在照常跑；MCP 那条路上文件改好了下一条就执行
 *   ⑩ 提示词说真话（主进程真跑一趟，桩引擎拿真名）：列的工具 = MCP 挂的 = owb list = 借出名单；技能一个不落、
 *      每条带正文的完整路径；claude「自动改文件」档说清命令会被拒、被拒就停；看图按引擎分；
 *      owb 的 --help 写在哪都认；敲错工具名给近似名；借出去的 library_read 不指没借出的 library_import，借了就指它
 *   ⑪ 问答 / 计划那一趟（readOnly）：只借读的那几个（跟内置引擎这两档的只读工具对齐），桥那头照表再拦一道，
 *      名单被改过也借不出生图；不写 owb 脚本、不挂用户的连接器
 *   ⑫ codex 命令沙箱里 owb 跑不成的（要记账、要写数据目录、要起 Chrome）：开跑前就说、退出码 2、上游不调；
 *      哪几样跑不成逐个点名核对；attach 照这次借出去的点名给提示词；安全档「只看不动」两个引擎都不给 owb
 *   ⑬ 连接器转给本机引擎：插件带来的照转（claude 那边套一层先切到插件根，codex 直接认 cwd）；连接器页上关掉的、
 *      暂停的不转；走网址的不转、在运行页上点名；名字里带 __、带点的改成两个 CLI 都认得的；套的那一层交回退出码、转信号
 *   ⑭ CLI 报上来的工具名归回原名（mcp__openworkbuddy__x、openworkbuddy.x、owb x → x），原叫法留在 raw_name；
 *      主进程真跑一趟：播出去的事件名、标题、结果那条按 id 跟上；别人的连接器、带别的命令的 shell 原样
 *   ⑮ 桥里的审计每条当场追加一行：命令行入口跑完就退出也不丢、不去盖主进程那份；写不进去原样打到 stderr；
 *      主进程看列表、导出时按时间并进来，清空时一起清；过 512KB 换一份
 *   ⑯ 生视频上游收了单就落台账（不带 Key、不带地址）：CLI 叫停（notifications/cancelled、SIGTERM）桥真停、回话说清、不撤单；
 *      主进程收尾按任务号后台收回放进对话目录、记账、删台账，绝不重新下单；用户点了停止的能撤就撤；
 *      同一单只收一次、桥还活着先等它、同名文件不覆盖、认不回渠道台账留着；claude 那边 MCP 和 Bash 的时限给足 15 分钟
 *
 * 真起桥子进程，但不起任何 CLI 引擎、不出网（假生图、假视频上游都起在 127.0.0.1）。
 *   node test/engine-bridge.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync, execFileSync, execFile } = require("child_process");
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
function mcpOnce(server, req, extraEnv = {}, cwd) {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, ...req },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const env = { ...process.env, ...(server.env || {}), ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const p = spawnSync(server.command, server.args || [], { input, env, cwd, encoding: "utf8", timeout: 60000 });
  const msgs = String(p.stdout || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
  return { status: p.status, stdout: String(p.stdout || ""), stderr: String(p.stderr || ""), msgs, res: msgs.find((m) => m.id === 2) };
}
function mcpList(server, extraEnv = {}, cwd) {
  const r = mcpOnce(server, { method: "tools/list" }, extraEnv, cwd);
  return { ...r, names: r.res && r.res.result ? r.res.result.tools.map((t) => t.name) : null };
}
function mcpCall(server, name, args) {
  const r = mcpOnce(server, { method: "tools/call", params: { name, arguments: args } });
  const out = r.res && r.res.result;
  return { status: r.status, ok: !!(out && !out.isError), text: out ? out.content.map((c) => c.text).join("\n") : "", err: r.stderr.slice(-400) };
}

/** 一个 MCP 会话里按顺序发几条请求，中间可以插一步（函数）。答完一条才发下一条 */
function mcpSteps(server, steps) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(server.env || {}) };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
    const ch = spawn(server.command, server.args || [], { env, stdio: ["pipe", "pipe", "pipe"] });
    const results = [];
    let buf = "", id = 1, i = 0, err = "";
    const timer = setTimeout(() => { try { ch.kill(); } catch {} }, 60000);
    const send = (m) => ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    const next = () => {
      while (i < steps.length && typeof steps[i] === "function") steps[i++]();
      if (i >= steps.length) { ch.stdin.end(); return; }
      if (steps[i].wait) { setTimeout(next, steps[i++].wait); return; } // { wait: 毫秒 }：桥多活一会儿再往下
      send({ id: ++id, ...steps[i++] });
    };
    ch.stderr.on("data", (d) => { err += d; });
    ch.stdout.on("data", (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ method: "notifications/initialized" }); next(); continue; }
        const out = m.result || {};
        results.push({ isError: !!out.isError, text: (out.content || []).map((c) => c.text).join("\n") });
        next();
      }
    });
    ch.on("close", (code) => { clearTimeout(timer); resolve({ code, results, err }); });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  });
}

/** 跑 owb 脚本，跟引擎里模型敲的一样 */
function owb(shim, args, env) {
  try {
    const opt = { encoding: /** @type {const} */ ("utf8"), timeout: 60000, stdio: /** @type {any} */ (["pipe", "pipe", "pipe"]), env: env ? { ...process.env, ...env } : process.env };
    return { code: 0, out: execFileSync("/bin/sh", [shim, ...args], opt) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}
/** 同上，但不卡住事件循环：工具要连本进程里起的假上游 */
function owbAsync(shim, args, env) {
  return new Promise((resolve) => execFile("/bin/sh", [shim, ...args], { encoding: "utf8", timeout: 60000, env: env ? { ...process.env, ...env } : process.env }, (e, out, err) =>
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
    const lend = ["gen_diagram", "library_list", "library_read", "library_import"];
    const dot = (f) => JSON.stringify({ kind: "dot", source: "digraph{A->B}", filename: f });

    const a = bridge.attach("claude-code", { home: HOME, root: rootA, baseDir: "任务_根", user: "甲", tools: lend, library: { base: libA, mount: "" } });
    try {
      const sv = serverOf(a);
      ok(sv.env.OPENWORKBUDDY_BRIDGE_ROOT === rootA && sv.env.OPENWORKBUDDY_BRIDGE_LIB_ROOT === libA && !("OPENWORKBUDDY_BRIDGE_LIB_MOUNT" in sv.env),
        "MCP 配置里带上了这趟任务的根和资料库根；没挂子目录就不写挂载", sv.env);
      const c = mcpCall(sv, "gen_diagram", JSON.parse(dot("经MCP.png")));
      ok(c.ok && fs.existsSync(path.join(rootA, "任务_根", "经MCP.png")), "MCP 调出来的图落在这趟任务的根下面", c);
      // 取素材：只从这个人的资料库复制进这一趟的目录
      const li = mcpCall(sv, "library_import", { name: "甲方合同.md" });
      const got = path.join(rootA, "任务_根", "甲方合同.md");
      ok(li.ok && fs.existsSync(got) && fs.readFileSync(got, "utf8") === "甲的合同正文", "甲取素材：复制进这一趟任务的目录", li);
      const bad = ["乙方报价.md", "../乙/乙方报价.md", "主人的.md", "../../library/主人的.md"].map((name) => ({ name, r: mcpCall(sv, "library_import", { name }) }));
      ok(bad.every((x) => !x.r.ok) && !fs.existsSync(path.join(rootA, "任务_根", "乙方报价.md")) && !fs.existsSync(path.join(rootA, "任务_根", "主人的.md")),
        "★甲取不到乙的、也取不到机器主人的★ 按名字、带 ../ 都不行", bad.map((x) => [x.name, x.r.ok, x.r.text.slice(0, 80)]));
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

  section("⑨ 设置文件读不出来：借来的工具一律不执行，报原话、留痕；改好了下一次就认");
  {
    const entry = mod("tool-bridge");
    // 另起一个数据家：⑧ 在 HOME/config.json 里写了生图渠道，这儿不碰它
    const H = path.join(HOME, "坏设置");
    fs.mkdirSync(H, { recursive: true });
    const cfgFile = path.join(H, "config.json");
    const env = { ...process.env, OPENWORKBUDDY_HOME: H, OPENWORKBUDDY_BRIDGE_TOOLS: "library_list,remember", OPENWORKBUDDY_BRIDGE_BASEDIR: "任务_设置" };
    delete env.OPENWORKBUDDY_BRIDGE_ROOT; delete env.OPENWORKBUDDY_LOG_DIR;
    const cli = (name, args) => spawnSync(process.execPath, [entry, name, JSON.stringify(args || {})], { env, encoding: "utf8", timeout: 60000 });
    const logRows = () => {
      const dir = path.join(H, "logs");
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => /^app-.*\.jsonl$/.test(f))
        .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    };

    fs.writeFileSync(cfgFile, '{ "security": { "gateway": true }, }');   // 结尾多一个逗号
    const p = cli("library_list");
    ok(p.status === 1 && p.stdout === "", "JSON 坏了：命令行调用退出码 1，什么都没执行", { status: p.status, out: p.stdout.slice(0, 200) });
    ok(p.stderr.includes(cfgFile) && /不是合法 JSON/.test(p.stderr) && /不执行/.test(p.stderr), "报错里有文件在哪、解析器的原话、这次不执行", p.stderr);
    const rows = logRows().filter((r) => r.mod === "engine-bridge" && r.level === "error");
    ok(rows.length === 1 && rows[0].file === cfgFile && /JSON/.test(String(rows[0].err)), "系统日志里留了一条（设置 → 系统日志看得见）", rows);

    fs.writeFileSync(cfgFile, "null");
    const n = cli("library_list");
    ok(n.status === 1 && /不是一组设置/.test(n.stderr), "解析得出来但不是一组设置（null）：同样不执行", n.stderr);
    fs.writeFileSync(cfgFile, "[]");
    ok(/不是一组设置/.test(cli("library_list").stderr), "顶层是数组：同样不执行");

    fs.rmSync(cfgFile, { force: true });
    const miss = cli("library_list");
    ok(miss.status === 0 && !/不执行/.test(miss.stderr + miss.stdout), "反向对照：还没存过设置（文件不在）照常执行，安全策略按默认", { status: miss.status, err: miss.stderr.slice(0, 300) });
    fs.writeFileSync(cfgFile, "{}");
    ok(cli("library_list").status === 0, "反向对照：合法的空设置照常执行");

    // MCP 那条路：同一个进程里，第一条被拒，文件改好之后下一条就执行
    fs.writeFileSync(cfgFile, "{ 坏");
    const r = await mcpSteps({ command: process.execPath, args: [entry], env }, [
      { method: "tools/call", params: { name: "library_list", arguments: {} } },
      () => fs.writeFileSync(cfgFile, "{}"),
      { method: "tools/call", params: { name: "library_list", arguments: {} } },
    ]);
    const [a, b] = r.results;
    ok(a && a.isError && /不执行/.test(a.text) && a.text.includes(cfgFile), "MCP：设置坏着时回 isError，人话里有文件在哪", a);
    ok(b && !b.isError && !/不执行/.test(b.text), "MCP：文件改好后下一条直接执行，不用重开引擎", b);
  }

  section("⑩ 提示词说真话：清单就是借出去的那份，技能一个不落带路径，owb 的说明看得全、敲错了给近似名");
  {
    const tools = require(mod("tools"));
    const engines = require(mod("engines"));
    const skills = require(mod("skills"));
    const { createAgentRuntime } = require(mod("agent"));
    const { McpManager } = require(mod("mcp"));
    // 45 个技能：以前只列前 40 个，后面的叫它「用 library_list 看全」——那个工具翻的是资料库，翻不到技能
    for (let i = 1; i <= 45; i++) {
      const d = path.join(skills.SKILLS_DIR, `fx-${String(i).padStart(2, "0")}`);
      fs.mkdirSync(d, { recursive: true });
      // 第 45 个正文叫 SKILL.md（大写）：路径得照盘上的真名给，不能想当然写成 skill.md
      fs.writeFileSync(path.join(d, i === 45 ? "SKILL.md" : "skill.md"), `---\nname: fx-${i}\ndescription: 夹具技能第 ${i} 个\n---\n照着做第 ${i} 步`);
    }
    let seen = null;
    const run = async (o) => {
      // owb 脚本和 MCP 配置都是跑完就删：三处清单得趁现在拿
      const first = String((o.env && o.env.PATH) || "").split(path.delimiter)[0];
      const shim = path.join(first, "owb");
      seen = { prompt: o.systemPrompt || "", addDirs: o.addDirs || [], mcp: null, owb: null };
      if (o.mcpConfigPath) seen.mcp = mcpList(JSON.parse(fs.readFileSync(o.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME]).names;
      if (SH && fs.existsSync(shim)) { const l = owb(shim, ["list"]); seen.owb = l.code === 0 ? listedNames(l.out) : null; seen.owbOut = l.out; }
      return { finalText: "好", usage: {}, stopped: null, sessionId: null };
    };
    // 拿 claude-code / codex 这两个名字起桩：提示词按引擎分叉（看图、止血那句），得用真名。原来那个先摘下来，跑完放回去
    const withStub = async (id, cfg, fn) => {
      const i = engines.BACKENDS.findIndex((b) => b.id === id);
      const real = i >= 0 ? engines.BACKENDS.splice(i, 1)[0] : null;
      const stub = { id, label: "桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: false, models: [],
        async detect() { return { id, installed: true, path: "", version: "0" }; }, run };
      engines.BACKENDS.push(stub);
      try {
        const fakeLLM = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
        const rt = createAgentRuntime({ config: { ...cfg, agent: { engine: id, max_steps: 3, engine_options: { [id]: { model: "m1", ...((cfg.opts) || {}) } } } }, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
        seen = null;
        await rt.runTask({ history: [{ role: "user", content: "干活" }], emit() {} });
        return await fn(seen || {});
      } finally {
        engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
        if (real) engines.BACKENDS.splice(i, 0, real);
      }
    };
    const promptTools = (p) => [...p.matchAll(/^ {2}· mcp__openworkbuddy__(\w+)/gm)].map((m) => m[1]);
    const skillLines = (p) => { const k = p.indexOf("## 你会的技能"); return k < 0 ? [] : p.slice(k).split("\n").filter((l) => /^- .+ → /.test(l)); };

    await withStub("claude-code", {}, async (s) => {
      const want = lendable.lentFor({ renderer: false });
      const listed = promptTools(s.prompt);
      ok(sorted(listed) === sorted(want) && listed.length === want.length, "★提示词里列的工具 = 借出名单★（一个不多一个不少，不重复）", { listed, want });
      ok(s.mcp && sorted(s.mcp) === sorted(want), "MCP 挂上的 = 借出名单", s.mcp);
      if (SH) ok(s.owb && sorted(s.owb) === sorted(want), "owb list 打出来的 = 借出名单", s.owb);
      ok(!/library_list[^\n]*技能库/.test(s.prompt) && /library_list[^\n]*资料库/.test(s.prompt), "library_list 标的是资料库，不再叫「技能库」", s.prompt.match(/.*library_list.*/g));
      ok(/check_page[^\n]*不开浏览器/.test(s.prompt) && !/check_page[^\n]*控制台报错，/.test(s.prompt), "check_page 说的是这条路上真做得到的（静态体检，不开浏览器）", s.prompt.match(/.*check_page.*/g));
      ok(/mcp__openworkbuddy__library_import {2}资料库：把一个文件复制进这一趟的工作目录/.test(s.prompt), "★借出去的 library_import 提示词里列着，说清是复制进这一趟的工作目录★", s.prompt.match(/.*library_import.*/g));
      ok(!/挂不上 MCP/.test(s.prompt), "「挂不上 MCP、命令行是唯一入口」那段死分支没了");
      ok(/owb <工具名> --help/.test(s.prompt), "命令行入口告诉它怎么看一个工具的完整说明");

      const lines = skillLines(s.prompt);
      const n = skills.loadSkills().length;
      ok(n >= 45 && lines.length === n, `★技能一个不落：${lines.length}/${n}★`, lines.slice(-3));
      const paths = lines.map((l) => l.split(" → ").pop());
      ok(paths.every((p) => path.isAbsolute(p) && fs.existsSync(p)), "每条后面都是正文的完整路径，而且真有这个文件", paths.filter((p) => !fs.existsSync(p)).slice(0, 3));
      ok(paths.some((p) => p.endsWith(path.join("fx-45", "SKILL.md"))), "正文叫 SKILL.md 的，路径照盘上的真名给", paths.filter((p) => p.includes("fx-45")));
      const block = s.prompt.slice(s.prompt.indexOf("## 你会的技能"));
      ok(!/library_list|library_read|还有 \d+ 个没列/.test(block.split("\n").slice(0, 4).join("\n")), "不再叫它拿资料库工具去翻技能，也不截断", block.slice(0, 300));
      ok(s.addDirs.includes(skills.SKILLS_DIR) && s.addDirs.includes(skills.PLUGINS_DIR), "--add-dir 带上技能库和插件目录（插件带的技能正文在那儿）", s.addDirs);

      ok(/自动改文件/.test(s.prompt) && /被拒一次就别换个写法再试/.test(s.prompt), "★claude 按「自动改文件」跑：提示词说清命令会被拒、被拒就停★");
      ok(/Read 读图片文件/.test(s.prompt) && !/view_image/.test(s.prompt), "claude：看图用它自己的 Read，look_at_image 只兜底");
      ok(/require\("pptxgenjs"\)/.test(s.prompt) && /import 写法找不到/.test(s.prompt), "告诉它 node 脚本直接 require 自带的 pptxgenjs / docx / exceljs");
    });
    // 反向对照：「全自动」档 claude 不审批命令，那句止血的话不该出现；engine_options 里手填的档位也认
    await withStub("claude-code", { security: { permission_mode: "full" } }, async (s) => {
      ok(s.prompt && !/被拒一次就别换个写法再试/.test(s.prompt), "反向对照：「全自动」档不说命令会被拒");
    });
    await withStub("claude-code", { opts: { permissionMode: "bypassPermissions" } }, async (s) => {
      ok(s.prompt && !/被拒一次就别换个写法再试/.test(s.prompt), "反向对照：引擎设置里手填了 bypassPermissions，照实际档位说");
    });
    await withStub("codex", {}, async (s) => {
      ok(/view_image/.test(s.prompt) && !/Read 读图片文件/.test(s.prompt), "codex：看图用它自带的 view_image");
      ok(!/被拒一次就别换个写法再试/.test(s.prompt), "codex 没有 claude 那套审批，不说那句");
    });

    // owb：help 写在哪儿都认，只打说明不执行；清单里说明被截了要说一声；敲错名给近似名
    if (SH) {
      const cc = bridge.attach("claude-code", { home: HOME, baseDir: "任务_说明", user: "t", tools: ["generate_image", "remember", "library_list"] });
      try {
        const def = tools.TOOL_DEFS.find((d) => d.name === "generate_image");
        const tail = String(def.description).trim().slice(-20);
        for (const args of [["generate_image", "--help"], ["help", "generate_image"], ["generate_image", JSON.stringify({ prompt: "雪山" }), "-h"]]) {
          const h = owb(cc.shim, args);
          ok(h.code === 0 && h.out.includes(tail) && /参数：/.test(h.out) && /prompt\s+\[必填\]/.test(h.out), `owb ${args.join(" ")}：打完整说明和全部参数`, h.out.slice(0, 300));
        }
        const l = owb(cc.shim, ["list"]);
        ok(/owb <工具名> --help/.test(l.out) && sorted(listedNames(l.out)) === sorted(cc.lent), "owb list 末尾说一声怎么看全，名字清单不受影响", l.out.slice(-200));
        const typo = owb(cc.shim, ["generate_imag", "{}"]);
        ok(typo.code !== 0 && /没有借给/.test(typo.out) && /名字相近的有 generate_image/.test(typo.out), "★敲错名（generate_imag）：拒，并点出近似的 generate_image★", typo.out);
        const far = owb(cc.shim, ["zzzz_qqqq", "{}"]);
        ok(far.code !== 0 && /没有借给/.test(far.out) && !/名字相近/.test(far.out), "反向对照：差得远的名字不乱猜", far.out);
        const notLent = owb(cc.shim, ["gen_diagram", "--help"]);
        ok(notLent.code !== 0 && /没有借给/.test(notLent.out), "没借出去的工具，--help 也说没借", notLent.out);
      } finally { cc.cleanup(); }
    }

    // 资料库里的二进制：这条路上没有 library_import，别再叫它用
    {
      const lib = path.join(HOME, "data", "library-users", "看图的");
      fs.mkdirSync(lib, { recursive: true });
      fs.writeFileSync(path.join(lib, "图.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 1, 2, 3]));
      const a = bridge.attach("claude-code", { home: HOME, baseDir: "任务_资料", user: "看图的", tools: ["library_read"], library: { base: lib, mount: "" } });
      try {
        const r = mcpCall(serverOf(a), "library_read", { name: "图.png" });
        ok(/不是文本文件/.test(r.text) && !/library_import/.test(r.text) && /拖进对话/.test(r.text), "★借出去的 library_read 读到二进制：不叫它用没借出的 library_import★", r.text);
      } finally { a.cleanup(); }
      const own = await tools.withLibraryBase(lib, () => tools.executeTool("library_read", { name: "图.png" }, {}));
      ok(/library_import/.test(own.content), "反向对照：内置引擎那边照旧指到 library_import", own.content);
      const b2 = bridge.attach("claude-code", { home: HOME, baseDir: "任务_取素材", user: "看图的", tools: ["library_read", "library_import"], library: { base: lib, mount: "" } });
      try {
        const r = mcpCall(serverOf(b2), "library_read", { name: "图.png" });
        ok(/library_import/.test(r.text) && !/拖进对话/.test(r.text), "★借了 library_import：读到二进制就指它★", r.text);
        const c = mcpCall(serverOf(b2), "library_import", { name: "图.png" });
        const at = path.join(HOME, "workspace", "任务_取素材", "图.png");
        ok(c.ok && fs.existsSync(at) && fs.readFileSync(at).equals(fs.readFileSync(path.join(lib, "图.png"))), "取素材原样落在这一趟的目录里", { c, at });
      } finally { b2.cleanup(); }
    }
  }

  section("⑪ 问答 / 计划那一趟：只借读的，桥那头照表再拦一道，不给命令行入口、不挂用户的连接器");
  {
    const RO = lendable.lentFor({ renderer: false, readOnly: true });
    // 跟内置引擎这两档摆给模型的那份对齐：内置那边问答时没有的，换成本机引擎借出去也不该有
    const agentSrc = fs.readFileSync(require.resolve(mod("agent")), "utf8");
    const roLine = agentSrc.split("\n").find((l) => /const READ_ONLY_TOOLS = \[/.test(l)) || "";
    const builtin = [...roLine.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    ok(builtin.length > 5 && sorted(lendable.READ_ONLY) === sorted(lendable.LENDABLE.filter((n) => builtin.includes(n))),
      "★只读名单 = 内置引擎问答档的只读工具 ∩ 能借的★ 换了底层引擎能做的事不变多", { READ_ONLY: lendable.READ_ONLY, builtin });
    ok(RO.length > 0 && ["generate_image", "remember", "install_skill", "gen_diagram", "library_import"].every((n) => !RO.includes(n)), "只读那一趟没有生图、记忆、装技能、出图表、取素材（要往工作目录写）", RO);

    const conn = [{ name: "userconn", command: "/bin/echo" }];
    const a = bridge.attach("claude-code", { home: HOME, baseDir: "任务_只读", user: "t", extraServers: conn, readOnly: true });
    try {
      ok(sorted(a.lent) === sorted(RO) && a.readOnly === true, "attach 给的 lent 只剩读的（提示词照它列）", a.lent);
      ok(!a.shimBin && !a.shim && !(a.runOpts.env || {}).PATH, "★不写 owb 脚本、不往 PATH 里挂目录★ 只读档的 CLI 本来就不该跑命令", { shim: a.shim, env: a.runOpts.env });
      ok(sorted(a.runOpts.mcpServerNames) === bridge.SERVER_NAME, "★用户配的连接器不挂★ 它们能干什么这边判断不了", a.runOpts.mcpServerNames);
      const s = serverOf(a);
      ok(s.env.OPENWORKBUDDY_BRIDGE_READONLY === "1", "桥那头知道这一趟是只读", Object.keys(s.env));
      const l = mcpList(s);
      ok(l.names && sorted(l.names) === sorted(RO), "MCP 挂上的也只有读的", l.names);
      // 名单被人改过、多写了生图和记忆：桥那头照只读表再滤一道
      const bad = { OPENWORKBUDDY_BRIDGE_TOOLS: lendable.toEnv(["generate_image", "remember", "web_search"]) };
      const l2 = mcpList(s, bad);
      ok(l2.names && sorted(l2.names) === "web_search", "★名单里混进生图、记忆：只读那一趟照样不挂★", l2.names);
      const c = mcpCall({ ...s, env: { ...s.env, ...bad } }, "generate_image", { prompt: "雪山" });
      ok(!c.ok && /只读/.test(c.text) && /没有执行/.test(c.text), "★硬调生图：拒，说清这一趟是只读★", c.text);
      const l3 = mcpList(s, { ...bad, OPENWORKBUDDY_BRIDGE_READONLY: undefined });
      ok(l3.names && l3.names.includes("generate_image"), "反向对照：不是只读那一趟，同一份名单照借", l3.names);
    } finally { a.cleanup(); }

    const cx = bridge.attach("codex", { home: HOME, baseDir: "任务_只读", user: "t", extraServers: conn, readOnly: true });
    try {
      const flat = cx.runOpts.mcpArgs.join("\n");
      ok(!/mcp_servers\.userconn/.test(flat) && /OPENWORKBUDDY_BRIDGE_READONLY = "1"/.test(flat), "codex 那边同样：连接器不挂，桥知道是只读", flat.slice(0, 400));
      ok(!cx.shimBin && !(cx.runOpts.env || {}).PATH, "codex 那边也不给命令行入口", cx.runOpts.env);
    } finally { cx.cleanup(); }

    const full = bridge.attach("claude-code", { home: HOME, baseDir: "任务_只读", user: "t", extraServers: conn });
    try {
      ok(full.shimBin && full.runOpts.mcpServerNames.includes("userconn") && full.lent.includes("generate_image"), "反向对照：平时照借整张表、给 owb、挂连接器", { names: full.runOpts.mcpServerNames, shim: full.shimBin });
    } finally { full.cleanup(); }
  }

  section("⑫ codex 命令沙箱里 owb 跑不成的：开跑前就说、退出码 2、不执行；提示词照借出去的点名");
  {
    const { SANDBOX_BLOCKED, LENDABLE, NEEDS_RENDERER } = lendable;
    // 新借一个工具，得先想清它在沙箱里跑不跑得成：表变了这里跟着改，不许悄悄漏掉
    const want = {
      generate_image: "paid", generate_video: "paid", text_to_speech: "paid", transcribe_audio: "paid", look_at_image: "paid", web_search: "paid",
      save_skill: "data", install_skill: "data", add_connector: "data", remember: "data", forget: "data",
      record_web_demo: "chrome",
    };
    ok(sorted(Object.entries(SANDBOX_BLOCKED).map((e) => e.join(":"))) === sorted(Object.entries(want).map((e) => e.join(":"))),
      "★沙箱里跑不成的逐个点名★ 要花钱的、要写数据目录的、要起 Chrome 的", SANDBOX_BLOCKED);
    const free = LENDABLE.filter((n) => !SANDBOX_BLOCKED[n] && !NEEDS_RENDERER.includes(n));
    ok(sorted(free) === sorted(["delivery_page", "gen_diagram", "read_document", "check_page", "library_list", "library_read", "library_import", "canvas_manage"]),
      "★沙箱里照跑的也逐个点名★ 写工作区的、只读的；新借的工具不进两张表之一就红", free);

    const pick = ["generate_image", "remember", "library_list", "record_web_demo", "canvas_manage"];
    const cx = bridge.attach("codex", { home: HOME, baseDir: "任务_沙箱", user: "t", tools: pick });
    try {
      ok(sorted(cx.shimBlocked || []) === sorted(["generate_image", "remember", "record_web_demo"]), "codex：提示词点名的 = 这次借出去的里头沙箱跑不成的（没借的不提）", cx.shimBlocked);
      if (SH) {
        const inBox = { CODEX_SANDBOX: "seatbelt" };
        const rec = owb(cx.shim, ["record_web_demo", "{}"], inBox);
        ok(rec.code === 2 && /没有执行/.test(rec.out) && /Chrome/.test(rec.out) && /mcp__openworkbuddy__record_web_demo/.test(rec.out),
          "★codex 沙箱里录屏：开跑前就说起不来 Chrome，退出码 2，指到 MCP 那条路★", rec);
        const recOut = owb(cx.shim, ["record_web_demo", "{}"], { CODEX_SANDBOX: "" });
        ok(recOut.code !== 2 && !/起不来/.test(recOut.out), "反向对照：不在 codex 沙箱里，录屏不拦（参数不全照常报错）", recOut);

        const dataDir = path.join(HOME, "data");
        fs.mkdirSync(dataDir, { recursive: true });
        const mode0 = fs.statSync(dataDir).mode & 0o777;
        fs.chmodSync(dataDir, 0o555);
        let locked = false;
        const probe = path.join(dataDir, ".probe");
        try { fs.mkdirSync(probe); fs.rmdirSync(probe); } catch { locked = true; }
        try {
          if (!locked) console.log("  （跳过：改了权限照样写得进去，多半是 root 在跑）");
          else {
            const g = owb(cx.shim, ["generate_image", JSON.stringify({ prompt: "雪山" })], inBox);
            ok(g.code === 2 && /没有执行（上游没调，没花钱）/.test(g.out) && /写不进去/.test(g.out) && /codex 的命令沙箱/.test(g.out) && /mcp__openworkbuddy__generate_image/.test(g.out),
              "★数据目录写不进去：生图开跑前就停，上游没调、没花钱，指到 MCP 那条路★ 以前是钱花了、账没记上", g);
            const r = owb(cx.shim, ["remember", JSON.stringify({ text: "x" })], inBox);
            ok(r.code === 2 && /存东西/.test(r.out) && !/花钱/.test(r.out), "记忆：同样不执行，说的是存不进去，不扯花钱", r);
            const g2 = owb(cx.shim, ["generate_image", JSON.stringify({ prompt: "雪山" })], { CODEX_SANDBOX: "" });
            ok(g2.code === 2 && /写不进去/.test(g2.out) && !/codex 的命令沙箱/.test(g2.out), "不在 codex 沙箱里、数据目录照样写不进去：照停，但不说是沙箱（只说看得见的）", g2);
            const nv = owb(cx.shim, ["generate_video", JSON.stringify({ prompt: "雪山" })], inBox);
            ok(nv.code !== 2 && /没有借给/.test(nv.out) && !/mcp__openworkbuddy__generate_video/.test(nv.out), "这次没借的（生视频）：照说没有借给，不指一条不存在的 MCP 工具", nv);
            const ll = owb(cx.shim, ["library_list"], inBox);
            ok(ll.code === 0, "反向对照：读资料库不写数据目录，照跑", ll);
            const cv = owb(cx.shim, ["canvas_manage", JSON.stringify({ action: "list" })], inBox);
            ok(cv.code !== 2 && !/没有执行/.test(cv.out), "反向对照：画布写的是工作区，不拦", cv);
            const h = owb(cx.shim, ["generate_image", "--help"], inBox);
            ok(h.code === 0 && /prompt/.test(h.out), "反向对照：--help 只打说明，不拦", h);
          }
        } finally { fs.chmodSync(dataDir, mode0); }
        const f = owb(cx.shim, ["forget", JSON.stringify({ text: "没有这一条" })], inBox);
        ok(f.code !== 2 && !/没有执行/.test(f.out), "反向对照：数据目录写得进去时，codex 沙箱里的记忆照跑", f);
        const g3 = await owbAsync(cx.shim, ["generate_image", "{}"], inBox);
        ok(g3.code !== 2 && !/没花钱/.test(g3.out), "反向对照：写得进去时生图不拦（参数不全照常报错）", g3);
      } else console.log("  （Windows：跳过 owb 脚本那几条）");
    } finally { cx.cleanup(); }

    const cc = bridge.attach("claude-code", { home: HOME, baseDir: "任务_沙箱", user: "t", tools: pick });
    try {
      ok(Array.isArray(cc.shimBlocked) && cc.shimBlocked.length === 0 && cc.shimBin, "claude 的 owb 不在 codex 那个沙箱里：不点名、照给", cc.shimBlocked);
    } finally { cc.cleanup(); }
    for (const id of ["codex", "claude-code"]) {
      const n = bridge.attach(id, { home: HOME, baseDir: "任务_沙箱", user: "t", tools: pick, noShim: true });
      try {
        ok(!n.shimBin && !(n.runOpts.env || {}).PATH && n.lent.length === pick.length && sorted(n.shimBlocked || []) === "",
          `★${id}：noShim（安全档「只看不动」）不写 owb、PATH 里不挂，MCP 照借★`, { shim: n.shimBin, env: n.runOpts.env, lent: n.lent });
      } finally { n.cleanup(); }
    }
  }

  section("⑬ 连接器转给本机引擎：插件的照转、在插件根里起；关掉的不转；走网址的点名；名字两个 CLI 都认得");
  {
    const node = process.execPath;
    const plugRoot = path.join(HOME, "插件根");
    fs.mkdirSync(plugRoot, { recursive: true });
    // 按相对路径起的服务器（插件里最常见的写法）：不在插件根里起就找不到 server.js。
    // tools/list 那条的说明里报自己在哪个目录、拿到了什么环境
    const SERVER = `
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "p", version: "0" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "where", inputSchema: { type: "object", properties: {} },
      description: JSON.stringify({ cwd: process.cwd(), electron: process.env.ELECTRON_RUN_AS_NODE || "", root: process.env.PLUGIN_ROOT || "" }) }] } });
    else if (m.id != null) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`;
    fs.writeFileSync(path.join(plugRoot, "server.js"), SERVER);
    const where = (r) => { try { return JSON.parse(r.res.result.tools[0].description); } catch { return null; } };
    const plug = { name: "acme.tools__srv", transport: "stdio", command: node, args: ["server.js"], env: { PLUGIN_ROOT: plugRoot }, cwd: plugRoot, plugin: "acme.tools" };
    const conns = [
      { name: "userconn", command: "/bin/echo" },
      { name: "offconn", command: "/bin/echo" },
      { name: "paused", command: "/bin/echo", enabled: false },
      { name: "webconn", transport: "streamable-http", url: "https://example.com/mcp" },
      { name: "urlonly", url: "https://example.com/mcp2" },
      // 写了 sse 又留着 command：内置那边按 transport 走网址，这边也不能当 stdio 转
      { name: "sseconn", transport: "sse", url: "https://example.com/sse", command: "/bin/echo" },
      { name: "nocmd" },
      { name: bridge.SERVER_NAME, command: "/bin/echo" },
      { name: "dup", command: "/bin/echo", args: ["先"] },
      { name: "my__conn", command: "/bin/echo" },
      { name: "my.conn", command: "/bin/echo" },
      { name: "dup", command: "/bin/echo", args: ["后"] },
      plug,
    ];
    const WANT = [bridge.SERVER_NAME, "userconn", "dup", "my_conn", "my_conn-2", "acme_tools_srv"];

    const a = bridge.attach("claude-code", { home: HOME, baseDir: "任务_连接器", user: "t", extraServers: conns, disabled: ["offconn"] });
    try {
      const cfgPath = a.runOpts.mcpConfigPath;
      const all = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers;
      ok(sorted(a.runOpts.mcpServerNames) === sorted(WANT) && sorted(Object.keys(all)) === sorted(WANT),
        "★关掉的、暂停的、没命令的、跟本项目重名的不转；插件的照转★", a.runOpts.mcpServerNames);
      ok(a.skipped.join(",") === "webconn,urlonly,sseconn", "★走网址的两台点名★ 不转、也不悄悄丢掉", a.skipped);
      ok(JSON.stringify(all.dup.args) === JSON.stringify(["后"]), "重名的后面那条算数（跟内置那边一个规矩）", all.dup);
      ok(a.runOpts.mcpServerNames.every((n) => /^[A-Za-z0-9_-]+$/.test(n) && !n.includes("__")),
        "★名字里带 __ 和点的改成 CLI 认得的★ claude 按 __ 切放行规则，codex 按点切配置键", a.runOpts.mcpServerNames);
      if (process.platform !== "win32") ok((fs.statSync(cfgPath).mode & 0o777) === 0o600, "mcp 配置里有连接器的 key：文件只给本人读写", (fs.statSync(cfgPath).mode & 0o777).toString(8));
      const p = all.acme_tools_srv;
      ok(p && p.args[0] === bridge.CWD_ENTRY && p.args[1] === plugRoot && p.args[2] === node && p.args[3] === "server.js" && !("cwd" in p),
        "★claude 那边插件的连接器套一层先切目录★ 它的 mcp.json 不认 cwd", p);
      // 从一个没有 server.js 的目录起（仓库根里就有一个，是本项目自己的服务器，不能让它被误起）
      const r = mcpList(p, { ELECTRON_RUN_AS_NODE: "1" }, HOME);
      const w = where(r);
      ok(w && w.cwd === fs.realpathSync(plugRoot) && w.root === plugRoot, "★真起一台：在插件根里起、stdio 原样接上★ 相对路径的 server.js 找得到", { w, err: r.stderr.slice(-300) });
      ok(w && w.electron === "", "套的那一层是借 ELECTRON_RUN_AS_NODE 起的：传给真服务器之前摘掉", w);
      const bare = mcpList({ command: node, args: ["server.js"], env: plug.env }, {}, HOME);
      ok(!bare.names, "反向对照：不套那一层、在别的目录起，相对路径的 server.js 找不到", { status: bare.status, err: bare.stderr.slice(-200) });
    } finally { a.cleanup(); }

    const cx = bridge.attach("codex", { home: HOME, baseDir: "任务_连接器", user: "t", extraServers: conns, disabled: ["offconn"] });
    try {
      const flat = cx.runOpts.mcpArgs.join("\n");
      const keys = [...new Set([...flat.matchAll(/^mcp_servers\.([^.=]+)\./gm)].map((m) => m[1]))];
      ok(sorted(keys) === sorted(WANT) && cx.skipped.join(",") === "webconn,urlonly,sseconn", "codex 那边转的、点名的一样", { keys, skipped: cx.skipped });
      ok(flat.includes(`mcp_servers.acme_tools_srv.command=${JSON.stringify(node)}`) && flat.includes(`mcp_servers.acme_tools_srv.cwd=${JSON.stringify(plugRoot)}`) && !flat.includes(bridge.CWD_ENTRY),
        "★codex 认 cwd：插件的连接器直接在插件根里起★ 不套那一层", flat.split("\n").filter((l) => /acme/.test(l)));
      ok(!/mcp_servers\.(acme|my)\.|mcp_servers\.my__conn/.test(flat), "带点、带 __ 的原名一个没漏进配置键", flat.split("\n").filter((l) => /acme|my/.test(l)));
    } finally { cx.cleanup(); }

    const ro = bridge.attach("claude-code", { home: HOME, baseDir: "任务_连接器", user: "t", extraServers: conns, disabled: ["offconn"], readOnly: true });
    try {
      ok(sorted(ro.runOpts.mcpServerNames) === bridge.SERVER_NAME && ro.skipped.length === 0, "只读那一趟一台不挂，也就不点名", { names: ro.runOpts.mcpServerNames, skipped: ro.skipped });
    } finally { ro.cleanup(); }
    // 自动放行那一道：claude 的 --allowed-tools 照 mcpServerNames 逐台给（上面已经只剩本项目这台），
    // codex 的放行写在每台自己的配置里——只读那一趟整台放行的只能是本项目这台，它那头还照只读表拦着
    const rox = bridge.attach("codex", { home: HOME, baseDir: "任务_连接器", user: "t", extraServers: conns, disabled: ["offconn"], readOnly: true });
    try {
      const approved = rox.runOpts.mcpArgs.filter((a) => /\.default_tools_approval_mode="approve"$/.test(a)).map((a) => a.split(".")[1]);
      ok(approved.join(",") === bridge.SERVER_NAME && rox.skipped.length === 0, "★只读那一趟 codex 只放行本项目这台★ 连接器一台没挂、也没放行", approved);
    } finally { rox.cleanup(); }

    // 套的那一层自己：退出码原样交回、起不来说清、信号转给真服务器不留孤儿
    const W = (args, o = {}) => spawnSync(node, [bridge.CWD_ENTRY, ...args], { encoding: "utf8", timeout: 30000, ...o });
    ok(W([plugRoot, node, "-e", "process.exit(7)"]).status === 7, "真服务器的退出码原样交回");
    // 命令不带目录：系统原话里只有命令名，目录得是这一层自己说的
    const miss = W([plugRoot, "没有这个命令-7d1"]);
    ok(miss.status === 1 && /起不来/.test(miss.stderr) && miss.stderr.includes("没有这个命令-7d1") && miss.stderr.includes(plugRoot), "命令起不来：退出码 1，说清哪个命令、哪个目录", miss.stderr);
    ok(W([]).status === 2, "参数不全：退出码 2、打用法");
    if (process.platform !== "win32") {
      const pidFile = path.join(HOME, "mcp-cwd-child.pid");
      const ch = spawn(node, [bridge.CWD_ENTRY, plugRoot, node, "-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], { stdio: "ignore" });
      const t0 = Date.now();
      while (!fs.existsSync(pidFile) && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
      const childPid = Number(fs.readFileSync(pidFile, "utf8"));
      const closed = new Promise((r) => ch.on("close", (code, sig) => r({ code, sig })));
      ch.kill("SIGTERM");
      // 这一层要是把信号吞了，它自己也不会退：等 10 秒还没退就判失败，别把整套测试挂住
      const res = await Promise.race([closed, new Promise((r) => setTimeout(() => r({ hung: true }), 10000))]);
      if (res.hung) try { ch.kill("SIGKILL"); } catch {}
      const alive = () => { try { process.kill(childPid, 0); return true; } catch { return false; } };
      const t1 = Date.now();
      while (alive() && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 50));
      const still = alive();
      if (still) try { process.kill(childPid, "SIGKILL"); } catch {}
      ok(!still && res.sig === "SIGTERM", "★CLI 收工停这一层：信号转给真服务器，不留孤儿★ 这一层也照这个信号退", { res, still });
    }

    // 主进程真跑一趟（桩引擎）：自己配的在前、插件带来的在后，连接器页上关掉的不挂，走网址的在运行页上说一句
    const engines = require(mod("engines"));
    const { createAgentRuntime } = require(mod("agent"));
    const { McpManager } = require(mod("mcp"));
    const plugins = require(mod("plugins"));
    const plugDir = path.join(HOME, "plugins", "acme.tools");
    fs.mkdirSync(plugDir, { recursive: true });
    fs.writeFileSync(path.join(plugDir, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "acme.tools" }));
    fs.writeFileSync(path.join(plugDir, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {
      srv: { type: "stdio", command: "node", args: ["server.js"] },
      web: { type: "streamable-http", url: "https://example.com/mcp" },
    } }));
    fs.writeFileSync(path.join(plugDir, "server.js"), SERVER);
    let seen = null;
    const stub = {
      id: "t-conn", label: "连接器桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: false, models: [],
      async detect() { return { id: "t-conn", installed: true, path: "", version: "0" }; },
      async run(o) {
        try { seen = { names: o.mcpServerNames || [], servers: JSON.parse(fs.readFileSync(o.mcpConfigPath, "utf8")).mcpServers }; } catch (e) { seen = { err: e.message }; }
        return { finalText: "好", usage: {}, stopped: null, sessionId: null };
      },
    };
    engines.BACKENDS.push(stub);
    const fakeLLM = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
    const config = { mcp_servers: [{ name: "userconn", command: "/bin/echo" }, { name: "offconn", command: "/bin/echo" }], mcp_disabled: ["offconn"],
      agent: { engine: "t-conn", max_steps: 3, engine_options: { "t-conn": { model: "m1" } } } };
    const rt = createAgentRuntime({ config, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
    try {
      ok(plugins.pluginMcpServers().some((s) => s.name === "acme.tools__srv"), "自检：插件装上了、连接器认得出", plugins.loadPlugins().map((p) => p.error || p.warnings));
      const st = [];
      seen = null;
      const evs = [];
      await rt.runTask({ history: [{ role: "user", content: "干活" }], emit(e) { if (e && e.type === "status") { st.push(e.text); evs.push(e); } } });
      const names = (seen && seen.names) || [];
      ok(names.includes("userconn") && names.includes("acme_tools_srv") && !names.includes("offconn"), "★插件带来的连接器本机引擎也挂上；连接器页上关掉的不挂★", seen);
      const ps = seen && seen.servers && seen.servers.acme_tools_srv;
      ok(ps && ps.args[0] === bridge.CWD_ENTRY && fs.realpathSync(ps.args[1]) === fs.realpathSync(plugDir), "插件的那台在插件根里起", ps);
      ok(st.some((t) => /走网址/.test(t) && t.includes("acme.tools__web")), "★走网址的那台在运行页上点名★ 名字照连接器页上的说", st);
      ok(evs.some((e) => /走网址/.test(e.text) && e.notice === true), "点名那一句标成提示：运行页留在引擎那一行下面，回看也在", evs);
      seen = null; st.length = 0;
      await rt.runTask({ history: [{ role: "user", content: "问问" }], mode: "ask", emit(e) { if (e && e.type === "status") st.push(e.text); } });
      ok(seen && sorted(seen.names) === bridge.SERVER_NAME && !st.some((t) => /走网址/.test(t)), "反向对照：问答那一趟一台不挂，也不点名", { seen, st });
      // 桥搭不起来：照常跑，只是少了本项目的工具；这句要标成提示，不然回看时就没了
      const realAttach = bridge.attach;
      bridge.attach = () => { throw new Error("桥坏了-9c2"); };
      try {
        seen = null; evs.length = 0;
        const r = await rt.runTask({ history: [{ role: "user", content: "干活" }], emit(e) { if (e && e.type === "status") evs.push(e); } });
        const note = evs.find((e) => /没能挂给引擎/.test(e.text || ""));
        ok(note && note.notice === true && note.text.includes("桥坏了-9c2") && note.depth === 0, "★桥没搭起来照常跑，运行页上留一句提示★ 原话带上", evs);
        ok(seen && r && r.finalText === "好", "桥没搭起来任务不毙", { seen, r });
      } finally { bridge.attach = realAttach; }
    } finally {
      engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
      fs.rmSync(plugDir, { recursive: true, force: true });
    }
  }

  section("⑭ CLI 报上来的工具名归回原名，原叫法留在 raw_name");
  {
    const tn = require(mod("tool-names"));
    ok(tn.SERVER === bridge.SERVER_NAME, "自检：认的服务器名就是桥挂上去的那台", tn.SERVER);
    const T = [
      // [CLI 报的名字, 目的说明, 归回的名字, raw_name]
      ["mcp__openworkbuddy__generate_image", "一只猫", "generate_image", "mcp__openworkbuddy__generate_image"],
      ["openworkbuddy.look_at_image", "a.png", "look_at_image", "openworkbuddy.look_at_image"],
      ["Bash", "owb generate_image '{\"prompt\":\"猫\"}'", "generate_image", "Bash"],
      ["run_shell", "  owb library_list", "library_list", "run_shell"],
      ["run_shell", "owb --help", "run_shell", ""],
      ["Bash", "cd x && owb generate_image '{}'", "Bash", ""],
      ["Bash", "owbx generate_image", "Bash", ""],
      ["mcp__github__create_issue", "", "mcp__github__create_issue", ""],
      ["github.create_issue", "", "github.create_issue", ""],
      ["mcp__openworkbuddy__", "", "mcp__openworkbuddy__", ""],
      ["Read", "owb generate_image", "Read", ""],
      ["", "", "", ""],
    ];
    const bad = T.filter(([n, pu, want, raw]) => { const r = tn.normalizeToolName(n, pu); return r.name !== want || r.raw_name !== raw; })
      .map(([n, pu]) => [n, pu, tn.normalizeToolName(n, pu)]);
    ok(bad.length === 0, "★三种叫法都归回原名★ 别人的连接器、带别的命令的 shell、光一个前缀原样", bad);
    const ev0 = { type: "text", delta: "x" };
    ok(tn.normalizeToolEvent(ev0) === ev0, "不是工具事件原样返回");
    // codex 报 MCP 调用时入参是对象（0.154 实测），直接转字符串只剩 [object Object]
    const codex = require(mod("codex"));
    const mc = (args) => codex.toolOf({ type: "mcp_tool_call", server: "openworkbuddy", tool: "library_read", arguments: args });
    const P = [
      [{ path: "资料/a.md", limit: 20 }, "资料/a.md"],
      [{ prompt: "一只橘猫", size: "1024x1024" }, "一只橘猫"],
      [{ n: 2, size: "1024x1024" }, '{"n":2,"size":"1024x1024"}'],
      ['{"path":"b.md"}', '{"path":"b.md"}'],
      [{}, ""],
      [undefined, ""],
    ];
    const badP = P.map(([a, want]) => [a, want, mc(a)]).filter(([, want, r]) => r.name !== "openworkbuddy.library_read" || r.purpose !== want);
    ok(badP.length === 0, "★codex 的 MCP 入参是对象也说得清在干什么★ 先挑人看得懂的那一个，挑不出整段 JSON，不出 [object Object]", badP);

    // 主进程真跑一趟（桩引擎）：claude 那种名字、codex 那种名字、命令行入口各来一条
    const engines = require(mod("engines"));
    const { createAgentRuntime } = require(mod("agent"));
    const { McpManager } = require(mod("mcp"));
    const stub = {
      id: "t-names", label: "工具名桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: false, models: [],
      async detect() { return { id: "t-names", installed: true, path: "", version: "0" }; },
      async run(o) {
        o.emit({ type: "tool_use", id: "c1", name: "mcp__openworkbuddy__generate_image", purpose: "一只橘猫", depth: 0 });
        o.emit({ type: "tool_result", id: "c1", name: "mcp__openworkbuddy__generate_image", preview: "好", depth: 0 });
        o.emit({ type: "tool_use", id: "c2", name: "openworkbuddy.library_read", purpose: "{\"path\":\"资料/a.md\"}", depth: 0 });
        o.emit({ type: "tool_use", id: "c3", name: "Bash", purpose: "owb text_to_speech '{\"text\":\"你好\"}'", depth: 0 });
        o.emit({ type: "tool_result", id: "c3", name: "Bash", preview: "ok", depth: 0 });
        o.emit({ type: "tool_use", id: "c4", name: "Bash", purpose: "ls -la", depth: 0 });
        o.emit({ type: "tool_use", id: "c5", name: "mcp__github__create_issue", purpose: "修个 bug", depth: 0 });
        return { finalText: "好", usage: {}, stopped: null, sessionId: null };
      },
    };
    engines.BACKENDS.push(stub);
    const fakeLLM = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
    const config = { agent: { engine: "t-names", max_steps: 3, engine_options: { "t-names": { model: "m1" } } } };
    const rt = createAgentRuntime({ config, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
    try {
      const evs = [];
      await rt.runTask({ history: [{ role: "user", content: "干活" }], emit(e) { if (e && (e.type === "tool_use" || e.type === "tool_result")) evs.push(e); } });
      const use = (id) => evs.find((e) => e.type === "tool_use" && e.id === id) || {};
      const res = (id) => evs.find((e) => e.type === "tool_result" && e.id === id) || {};
      ok(use("c1").name === "generate_image" && use("c1").raw_name === "mcp__openworkbuddy__generate_image", "★claude 那种叫法播出去是原名★ 原叫法留着", use("c1"));
      ok(/^生图/.test(use("c1").title || "") && (use("c1").title || "").includes("一只橘猫"), "标题跟内置那边一样「生图 …」", use("c1").title);
      ok(res("c1").name === "generate_image", "结果那条也归回", res("c1"));
      ok(use("c2").name === "library_read" && /资料\/a\.md/.test(use("c2").title || "") && !/[{}"]|path/.test(use("c2").title || ""), "codex 那种叫法也归回；入参 JSON 解得开就照内置那边算标题（不把整段 JSON 原样贴上去）", use("c2"));
      ok(use("c3").name === "text_to_speech" && use("c3").raw_name === "Bash" && /你好/.test(use("c3").title || "") && !/owb/.test(use("c3").title || ""),
        "★命令行入口那条认成调的那个工具★ 标题里不再带 owb 前缀", use("c3"));
      ok(res("c3").name === "text_to_speech" && res("c3").raw_name === "Bash", "命令行那条的结果只有 Bash：认调用 id 跟上", res("c3"));
      ok(use("c4").name === "Bash" && !use("c4").raw_name && !use("c4").title, "反向对照：别的命令原样、不加标题", use("c4"));
      ok(use("c5").name === "mcp__github__create_issue" && !use("c5").raw_name, "反向对照：别人的连接器原样", use("c5"));
    } finally {
      engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
    }
  }

  section("⑮ 桥里的审计每条当场追加：跑完马上退出也在，主进程看列表、导出时并进来");
  {
    const entry = mod("tool-bridge");
    const H = path.join(HOME, "审计");
    fs.mkdirSync(H, { recursive: true });
    fs.writeFileSync(path.join(H, "config.json"), "{}");
    const env = { ...process.env, OPENWORKBUDDY_HOME: H, OPENWORKBUDDY_BRIDGE_TOOLS: "render_page", OPENWORKBUDDY_BRIDGE_BASEDIR: "任务_审计" };
    delete env.OPENWORKBUDDY_BRIDGE_ROOT; delete env.OPENWORKBUDDY_LOG_DIR;
    // 不是 http 的地址：安全中心当场拦、记一条「网络拦截」，不联网
    const cli = (url) => spawnSync(process.execPath, [entry, "render_page", JSON.stringify({ url })], { env, encoding: "utf8", timeout: 60000 });
    const jf = path.join(H, "data", "audit-bridge.jsonl");
    const mainFile = path.join(H, "data", "audit.json");
    const rows = (f = jf) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    const inMain = (re) => fs.existsSync(mainFile) && re.test(fs.readFileSync(mainFile, "utf8"));

    const p = cli("ftp://audit-a1.invalid/x");
    const r1 = rows();
    ok(p.status === 1 && r1.length === 1 && r1[0].type === "网络拦截" && r1[0].action === "拦截" && r1[0].text.includes("audit-a1") && typeof r1[0].ts === "string",
      "★命令行入口跑完马上退出，这条也落了盘★ 一行一条", { status: p.status, rows: r1, err: String(p.stderr).slice(-300) });

    const m = await mcpSteps({ command: process.execPath, args: [entry], env }, [
      { method: "tools/call", params: { name: "render_page", arguments: { url: "ftp://audit-m1.invalid/" } } },
      { method: "tools/call", params: { name: "render_page", arguments: { url: "ftp://audit-m2.invalid/" } } },
      { wait: 800 }, // 过了主进程那份半秒一落盘的点：追加之外要是还进了内存那份，这会儿就盖进 audit.json 了
    ]);
    const r2 = rows();
    ok(m.results.length === 2 && r2.length === 3 && r2[1].text.includes("audit-m1") && r2[2].text.includes("audit-m2"), "MCP 那条路也是一条一行追加", r2);
    ok(!inMain(/audit-(?:a1|m1|m2)/), "★不去整份覆盖主进程那份 audit.json★（以前写进去的是桥启动时的旧快照，主进程下一次写又盖回去）");

    // 主进程：看列表、导出时并进来（按时间），清空时一起清
    const sec = mod("security");
    const code = [
      `const fs = require("fs"); const sec = require(${JSON.stringify(sec)});`,
      `sec.audit("测试", "主进程这条", "放行");`,
      `const list = sec.auditList(10).map((e) => e.text); const exp = sec.auditExport();`,
      `sec.auditClear();`,
      `process.stdout.write("\\nRESULT " + JSON.stringify({ list, exp, gone: !fs.existsSync(${JSON.stringify(jf)}), after: sec.auditList(10).length }) + "\\n");`,
      `process.exit(0);`,
    ].join("\n");
    const q = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, OPENWORKBUDDY_HOME: H }, encoding: "utf8", timeout: 60000 });
    const line = String(q.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    const res = line ? JSON.parse(line.slice(7)) : null;
    ok(res && res.list.length === 4 && res.list[0] === "主进程这条" && /audit-m2/.test(res.list[1]) && /audit-a1/.test(res.list[3]),
      "★审计中心列表里看得见桥那边的★ 跟主进程的按时间排（新的在前）", res || { status: q.status, err: String(q.stderr).slice(-400) });
    ok(res && /\[网络拦截\]\t拦截\tftp:\/\/audit-a1/.test(res.exp) && /主进程这条/.test(res.exp), "导出也带上", res && res.exp);
    ok(res && res.gone && res.after === 0, "清空时桥那份一起清", res);

    // 写不进去（codex 的命令沙箱不让写数据目录）：原样打到 stderr，工具照常回话
    fs.mkdirSync(jf, { recursive: true }); // 占成目录，追加必失败
    const w = cli("ftp://audit-w1.invalid/");
    ok(w.status === 1 && /审计记录没写进/.test(w.stderr) && w.stderr.includes(jf) && /\[网络拦截\] 拦截 ftp:\/\/audit-w1/.test(w.stderr) && /没抓成|拦截/.test(w.stdout),
      "★写不进去就把这条原样打到 stderr★ 文件在哪、哪一条都说清，工具照常回话", { status: w.status, err: w.stderr.slice(-400), out: w.stdout.slice(0, 200) });
    fs.rmSync(jf, { recursive: true, force: true });

    // 过 512KB 换一份：旧的留一份 .1，并列表时两份都读
    const old = [];
    for (let i = 0; old.join("").length < 600 * 1024; i++) old.push(JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "网络访问", text: "旧-" + i + "-" + "x".repeat(80), action: "放行" }) + "\n");
    fs.writeFileSync(jf, old.join(""));
    cli("ftp://audit-r1.invalid/");
    const r3 = rows(), r3old = rows(jf + ".1");
    ok(r3.length === 1 && /audit-r1/.test(r3[0].text) && r3old.length === old.length, "★过 512KB 换一份★ 新的从空文件记起，旧的整份留在 .1", { now: r3.length, old: r3old.length });
    const q2 = spawnSync(process.execPath, ["-e", `const sec = require(${JSON.stringify(sec)}); const x = sec.auditExport(); process.stdout.write("\\nRESULT " + JSON.stringify({ old: (x.match(/旧-/g) || []).length, now: /audit-r1/.test(x) }) + "\\n"); process.exit(0);`],
      { env: { ...process.env, OPENWORKBUDDY_HOME: H }, encoding: "utf8", timeout: 60000 });
    const l2 = String(q2.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
    const res2 = l2 ? JSON.parse(l2.slice(7)) : null;
    ok(res2 && res2.old === old.length && res2.now, "导出时 .1 那份也并进来", res2 || String(q2.stderr).slice(-300));
  }

  section("⑯ 生视频上游收了单：桥被叫停不撤单、台账留着；主进程按任务号后台收回，不重新下单");
  {
    const harvest = require(mod("harvest"));
    const mm = require(mod("media-models"));
    const quota = require(mod("quota"));
    const { buildChildEnv } = require(mod("child-env"));
    harvest._internals.setPollMs(40);
    // 前面几节造过运行时，开张后排的那次接着收还没到点的话撤掉：别半路插进来抢这一节的台账
    ok(harvest._internals.sweepArmed(), "造运行时就排上了一次「接着收上次留下的」（只排一次）");
    harvest._internals.cancelSweep();
    // 假视频上游（通义万相那门话）：提交回任务号；放行之前查单一直是「跑着」；撤单、下载各记一笔
    const st = { submits: 0, checks: /** @type {Record<string, number>} */ ({}), cancels: /** @type {string[]} */ ([]), ready: new Set(), downloads: 0, cancelDelay: 0 };
    let seq = 0, origin = "";
    const MP4 = Buffer.from("假片子-engine-bridge-16");
    const vs = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const u = String(req.url || "");
        const json = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
        let m;
        if (req.method === "POST" && /\/services\/aigc\/video-generation\/video-synthesis$/.test(u)) { st.submits++; return json({ output: { task_id: `vt-${++seq}`, task_status: "PENDING" } }); }
        if (req.method === "POST" && (m = /\/tasks\/([^/]+)\/cancel$/.exec(u))) {
          // cancelDelay：撤单那头慢（真上游跨了公网），撤单落地、回话都晚这么久
          const id = decodeURIComponent(m[1]);
          return setTimeout(() => { st.cancels.push(id); json({ request_id: "c" }); }, st.cancelDelay);
        }
        if (req.method === "GET" && (m = /\/tasks\/([^/?]+)$/.exec(u))) {
          const id = decodeURIComponent(m[1]);
          st.checks[id] = (st.checks[id] || 0) + 1;
          if (st.cancels.includes(id)) return json({ output: { task_id: id, task_status: "CANCELED" } });
          if (st.ready.has(id)) return json({ output: { task_id: id, task_status: "SUCCEEDED", video_url: `${origin}/files/${id}.mp4` } });
          return json({ output: { task_id: id, task_status: "RUNNING" } });
        }
        if (req.method === "GET" && u.startsWith("/files/")) { st.downloads++; res.writeHead(200, { "Content-Type": "video/mp4" }); return res.end(MP4); }
        res.writeHead(404); res.end("{}");
      });
    });
    await new Promise((r) => vs.listen(0, "127.0.0.1", () => r(null)));
    origin = `http://127.0.0.1:${(/** @type {import("net").AddressInfo} */ (vs.address())).port}`;
    process.env.NO_PROXY = process.env.no_proxy = "127.0.0.1,localhost";
    const KEY = "sk-test-engine-bridge-0015";
    const cfg = {
      providers: [{ id: "fakev", name: "假视频", kind: "dashscope", base_url: `${origin}/api/v1`, api_key: KEY }],
      media_models: [{ id: "v1", cap: "video", name: "万相假", provider: "fakev", model: "wan2.2-t2v-plus", default: true }],
    };
    mm.normalize(cfg);
    fs.writeFileSync(path.join(HOME, "config.json"), JSON.stringify(cfg)); // ⑯ 是最后一节，桥子进程读的那份换成视频渠道
    const media = () => mm.resolve(cfg);
    const pdir = harvest.pendingDir();
    const pending = () => { try { return fs.readdirSync(pdir).filter((n) => /\.json$/.test(n)); } catch { return []; } };
    const until = async (cond, ms = 20000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20)); return !!cond(); };
    // 收货最多等这么久：改坏了会一直查下去，不能把整个测试挂死，断言照样红
    const settle = (jobs, ms = 8000) => Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, ms).unref())]);
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const root = path.join(HOME, "orgs", "丁", "workspace");
    const task = path.join(root, "任务_视频");
    fs.mkdirSync(task, { recursive: true });
    /** 拉起桥（照 CLI 的样子），回话按 id 收着；叫停、关输入、发信号由用例自己来 */
    const liveBridge = (server) => {
      const env = { ...process.env, ...(server.env || {}) };
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
      const ch = spawn(server.command, server.args || [], { env, stdio: ["pipe", "pipe", "pipe"] });
      const got = new Map();
      let buf = "", err = "";
      ch.stderr.on("data", (d) => { err += d; });
      ch.stdout.on("data", (d) => {
        buf += d;
        let k;
        while ((k = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, k); buf = buf.slice(k + 1);
          try { const m = JSON.parse(line); if (m.id != null) got.set(m.id, m); } catch {}
        }
      });
      const closed = new Promise((r) => ch.on("close", (code, sig) => r({ code, sig })));
      const send = (m) => ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
      send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      send({ method: "notifications/initialized" });
      const said = (id) => { const r = ((got.get(id) || {}).result) || {}; return { isError: !!r.isError, text: (r.content || []).map((c) => c.text).join("\n") }; };
      return { ch, got, closed, send, said, err: () => err };
    };
    const call = (b, filename) => b.send({ id: 2, method: "tools/call", params: { name: "generate_video", arguments: { prompt: "一只猫在跑", filename } } });
    const recs = [];
    const record0 = quota.record;
    quota.record = (cap, o) => { recs.push({ cap, ...o }); };
    try {
      // —— 叫停（notifications/cancelled）：CLI 不等这一单了 ——
      const a = bridge.attach("claude-code", { home: HOME, root, baseDir: "任务_视频", user: "丁", run: "run-15a", tools: ["generate_video"] });
      try {
        const srv = serverOf(a);
        ok(srv.env.OPENWORKBUDDY_BRIDGE_RUN === "run-15a", "这一趟的编号带给了桥（台账靠它认是哪一趟留下的）", srv.env);
        ok(srv.timeout === bridge.TOOL_TIMEOUT_MS && bridge.TOOL_TIMEOUT_MS === 900000, "★claude 那边本项目这台 MCP 写了 timeout 15 分钟★（不写就按它的空闲时限半路掐掉出视频）", srv);
        const b = liveBridge(srv);
        call(b, "猫跑.mp4");
        const polled = await until(() => (st.checks["vt-1"] || 0) >= 1);
        const ledger = pending();
        b.send({ method: "notifications/cancelled", params: { requestId: 2, reason: "用户停了" } });
        const answered = await until(() => b.got.has(2), 8000);
        if (!answered) b.ch.kill("SIGKILL"); // 叫不停就别等它
        b.ch.stdin.end();
        await b.closed;
        const r = b.said(2);
        ok(polled && st.submits === 1 && ledger.length === 1, "上游收单那一刻台账就落了一条（片子还在跑）", { st, ledger, err: b.err().slice(-400) });
        ok(answered && r.isError && r.text.includes("上游已经收下这一单（任务号 vt-1），这边没去撤单"), "★CLI 叫停：桥当场停下，回话说清上游收了、没撤★", { answered, r });
        ok(st.cancels.length === 0 && st.submits === 1, "桥这头不撤单、不重新下单", st);
        const f = pending()[0] || "";
        const e = f ? harvest.readEntry(path.join(pdir, f)) : null;
        ok(!!e && e.taskId === "vt-1" && e.run === "run-15a" && e.proto === "dashscope" && real(e.saveDir) === real(task) && e.fname === "猫跑.mp4" && e.units > 0 && e.user === "丁",
          "台账留着：任务号、这一趟的编号、对话目录、文件名、计价量、谁的都在", e);
        const raw = f ? fs.readFileSync(path.join(pdir, f), "utf8") : "";
        ok(!!raw && !raw.includes(KEY) && !raw.includes(origin) && !raw.includes("127.0.0.1"), "★台账里没有 Key，也没有渠道地址本身★（只有地址的哈希）", raw);

        // —— 收尾：没停、后台按任务号收回 ——
        st.ready.add("vt-1");
        // 别的一趟留下的、还在等出片的：这一趟收尾不认它
        const decoy = harvest.writeEntry(pdir, { proto: "dashscope", model: "wan2.2-t2v-plus", chan: "0", saveDir: task, units: 5, user: "丁", pid: 0, at: Date.now(), taskId: "vt-x", fname: "别人.mp4", run: "run-15x" });
        const notes = [];
        const ar = harvest.afterRun({ run: "run-15a", media, userStopped: false, emit: (ev) => notes.push(ev), actor: { org: "o15", user: "丁" } });
        ok(ar.count === 1 && notes.length === 1 && notes[0].notice === true && notes[0].text === "有 1 条视频上游已经收单还没收回（任务号 vt-1），后台接着等，出好了放进对话目录",
          "收尾说一句：几条、任务号、后台接着等（别的一趟留下的不算）", notes);
        harvest.dropEntry(decoy);
        await settle(ar.jobs);
        const out = path.join(task, "猫跑.mp4");
        ok(fs.existsSync(out) && fs.readFileSync(out).equals(MP4) && st.submits === 1 && st.downloads === 1, "★后台按任务号收回来，放进对话目录；上游只收过一次单★", { st, has: fs.existsSync(out) });
        ok(pending().length === 0, "收回来了台账就删", pending());
        ok(recs.length === 1 && recs[0].cap === "video" && recs[0].model === "wan2.2-t2v-plus" && recs[0].units === e.units && /后台收回 猫跑\.mp4/.test(recs[0].meta) && recs[0].actor && recs[0].actor.user === "丁",
          "收回来记一笔账：照收单时的计价量、记在这一趟的人头上", recs);
        ok(harvest.afterRun({ run: "run-15a", media, emit: (ev) => notes.push(ev) }).count === 0 && notes.length === 1, "反向对照：没有剩下的就一句不说", notes);
      } finally { a.cleanup(); }

      // —— 桥挨 SIGTERM（CLI 收工、Bash 超时）+ 用户点了停止：能撤的去撤 ——
      const a2 = bridge.attach("claude-code", { home: HOME, root, baseDir: "任务_视频", user: "丁", run: "run-15b", tools: ["generate_video"] });
      try {
        const b2 = liveBridge(serverOf(a2));
        call(b2, "狗跑.mp4");
        await until(() => (st.checks["vt-2"] || 0) >= 1);
        // Windows 上 kill 就是硬杀，不走 SIGTERM 那段处理：那边改用叫停 + 关输入，照样得回完话、台账留着
        if (process.platform === "win32") { b2.send({ method: "notifications/cancelled", params: { requestId: 2 } }); if (!(await until(() => b2.got.has(2), 8000))) b2.ch.kill(); b2.ch.stdin.end(); }
        else { b2.ch.kill("SIGTERM"); setTimeout(() => b2.ch.kill("SIGKILL"), 8000).unref(); }
        await b2.closed;
        const r2 = b2.said(2);
        ok(st.submits === 2 && r2.isError && r2.text.includes("任务号 vt-2") && pending().length === 1, "★桥挨了 SIGTERM：先把手上那单叫停、回完话再走，台账留着★", { r2, st, p: pending(), err: b2.err().slice(-400) });
        const notes2 = [];
        const ar2 = harvest.afterRun({ run: "run-15b", media, userStopped: true, emit: (ev) => notes2.push(ev) });
        await settle(ar2.jobs);
        ok(st.cancels.includes("vt-2") && (notes2[0] || {}).text === "停下时有 1 条视频上游已经收单（任务号 vt-2）：能撤的已去上游撤单，撤不掉的出好了放进对话目录",
          "★用户点了停止：万相这家收尾时去上游撤了单，回话照实说★", { st, notes2 });
        ok(pending().length === 0 && !fs.existsSync(path.join(task, "狗跑.mp4")) && st.downloads === 1, "上游回「已取消」：台账删掉、不落文件、不记账", { p: pending(), recs: recs.length });
        ok(recs.length === 1, "撤掉的那单不记账", recs);
      } finally { a2.cleanup(); }

      const v = mm.pick(media(), "video");
      const chan = harvest.chanKey(v.base_url);
      const entry = (o) => ({ proto: "dashscope", model: "wan2.2-t2v-plus", chan, saveDir: task, units: 5, user: "丁", pid: 0, at: Date.now(), ...o });

      // —— 撤不掉的那几家：照实说「停不掉、照样扣费」；认不回渠道的台账留着下次再查 ——
      harvest.writeEntry(pdir, entry({ taskId: "zp-1", proto: "zhipu", model: "cogvideox-x", fname: "鱼.mp4", run: "run-15z" }));
      const notesZ = [];
      const arZ = harvest.afterRun({ run: "run-15z", media, userStopped: true, emit: (ev) => notesZ.push(ev) });
      await settle(arZ.jobs);
      ok((notesZ[0] || {}).text === "停下时有 1 条视频上游已经收单（任务号 zp-1），这家停不掉、照样扣费；出好了放进对话目录", "停不掉的那家照实说照样扣费", notesZ);
      ok(pending().length === 1 && harvest.readEntry(path.join(pdir, pending()[0])).taskId === "zp-1", "设置里认不回这条渠道：台账留着（改回原名），下次启动再查", pending());
      harvest.dropEntry(path.join(pdir, harvest.entryName("zhipu", "zp-1")));

      // —— 同一单只收一次：两份收货的（模拟两个进程）同时伸手，只有一个占得到 ——
      harvest.writeEntry(pdir, entry({ taskId: "vt-3", fname: "鸟.mp4", run: "run-15c" }));
      st.ready.add("vt-3");
      const k = require.resolve(mod("harvest"));
      const keep = require.cache[k];
      delete require.cache[k];
      const other = require(k); // 另一份模块：自己的「正在收」表，模拟另一个进程
      require.cache[k] = keep;
      other._internals.setPollMs(40);
      const x3 = harvest.listEntries(pdir).find((x) => x.entry.taskId === "vt-3");
      const d0 = st.downloads;
      await settle([harvest._internals.take(x3, { media }), other._internals.take(x3, { media }), ...harvest.sweep({ media }).jobs]);
      ok(st.downloads - d0 === 1 && fs.existsSync(path.join(task, "鸟.mp4")) && !fs.existsSync(path.join(task, "鸟_2.mp4")) && (st.checks["vt-3"] || 0) === 1,
        "★两份收货同时伸手：改名占住，只收一次、只下一次★", { st, d0 });
      ok(pending().length === 0 && recs.length === 2, "收完台账删掉、记一笔账", { p: pending(), recs: recs.length });

      // —— 桥还活着先等它（它可能自己还在等这一单）；它走了再收 ——
      const hold = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      harvest.writeEntry(pdir, entry({ taskId: "vt-4", fname: "猫跑.mp4", run: "run-15d", pid: hold.pid, at: fs.statSync(path.join(task, "猫跑.mp4")).mtimeMs + 1 }));
      st.ready.add("vt-4");
      const x4 = harvest.listEntries(pdir).find((x) => x.entry.taskId === "vt-4");
      const t4 = harvest._internals.take(x4, { media });
      await new Promise((r) => setTimeout(r, 300));
      ok(!st.checks["vt-4"] && pending().length === 1 && fs.existsSync(x4.file), "★桥那个进程还在：不去抢，台账原样★", { st, p: pending() });
      const gone = new Promise((r) => hold.on("exit", () => r(null)));
      hold.kill();
      await gone;
      await settle([t4]);
      ok(st.checks["vt-4"] >= 1 && fs.existsSync(path.join(task, "猫跑_2.mp4")) && fs.readFileSync(path.join(task, "猫跑.mp4")).equals(MP4),
        "它走了再收；★对话目录里同名的是早先那条：另起「猫跑_2.mp4」，不覆盖★", { st, ls: fs.readdirSync(task) });

      // —— 占着却没人收的（占的那个进程没了）：启动时放回来接着收；占的进程还在的不动 ——
      harvest.writeEntry(pdir, entry({ taskId: "vt-5", fname: "马.mp4", run: "run-15e" }));
      harvest.writeEntry(pdir, entry({ taskId: "vt-6", fname: "牛.mp4", run: "run-15e" }));
      st.ready.add("vt-5"); st.ready.add("vt-6");
      const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise((r) => dead.on("exit", () => r(null)));
      const f5 = path.join(pdir, harvest.entryName("dashscope", "vt-5")), f6 = path.join(pdir, harvest.entryName("dashscope", "vt-6"));
      fs.renameSync(f5, `${f5}.claim-${dead.pid}`);
      fs.renameSync(f6, `${f6}.claim-${process.ppid}`);
      const sw = harvest.sweep({ media });
      await settle(sw.jobs);
      ok(fs.existsSync(path.join(task, "马.mp4")) && !fs.existsSync(f5) && !fs.existsSync(`${f5}.claim-${dead.pid}`), "占的进程没了：放回来、收完、删掉", fs.readdirSync(pdir));
      ok(!fs.existsSync(path.join(task, "牛.mp4")) && fs.existsSync(`${f6}.claim-${process.ppid}`), "反向对照：占的进程还在，不动", fs.readdirSync(pdir));
      fs.rmSync(`${f6}.claim-${process.ppid}`, { force: true });

      // —— 上游明说失败：一般不收钱，台账删掉、不落文件 ——
      harvest.writeEntry(pdir, entry({ taskId: "vt-7", fname: "羊.mp4", run: "run-15f" }));
      st.cancels.push("vt-7"); // 假上游对它回「已取消」= 失败
      await settle(harvest.afterRun({ run: "run-15f", media }).jobs);
      ok(pending().length === 0 && !fs.existsSync(path.join(task, "羊.mp4")) && recs.length === 4, "上游说失败了：台账删掉、不落文件、不记账", { p: pending(), recs: recs.length });

      // —— 主进程真跑一趟：编号带给桥，收尾按它认出这一趟留下的那条，说一句、后台收回 ——
      {
        const engines = require(mod("engines"));
        const { createAgentRuntime } = require(mod("agent"));
        const { McpManager } = require(mod("mcp"));
        const runs = [];
        let during = null;
        const stub = {
          id: "t-harvest", label: "收货桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: false, models: [],
          async detect() { return { id: "t-harvest", installed: true, path: "", version: "0" }; },
          // 装作桥收了一单视频、没交到手 CLI 就收工了：照桥那份环境变量里的编号落一条台账（配置文件跑完就删，只能在这儿读）
          async run(o) {
            let r = "";
            try { r = JSON.parse(fs.readFileSync(o.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME].env.OPENWORKBUDDY_BRIDGE_RUN || ""; } catch {}
            runs.push(r);
            if (r) harvest.writeEntry(pdir, entry({ taskId: `vt-${7 + runs.length}`, fname: `兔${runs.length}.mp4`, run: r }));
            if (during) during();
            const halted = !!(o.stopSignal && o.stopSignal.aborted);
            return { finalText: halted ? "" : "好", usage: {}, stopped: halted ? "user" : null, sessionId: null };
          },
        };
        engines.BACKENDS.push(stub);
        try {
          const fakeLLM = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
          const rt = createAgentRuntime({ config: { ...cfg, agent: { engine: "t-harvest", max_steps: 3, engine_options: { "t-harvest": { model: "m1" } } } }, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
          st.ready.add("vt-8"); st.ready.add("vt-9");
          const evs = [];
          await rt.runTask({ history: [{ role: "user", content: "出条视频" }], emit: (ev) => evs.push(ev) });
          await rt.runTask({ history: [{ role: "user", content: "再出一条" }], emit() {} });
          const said = evs.filter((ev) => ev && ev.notice && /视频上游已经收单/.test(ev.text || "")).map((ev) => ev.text);
          ok(runs.length === 2 && !!runs[0] && !!runs[1] && runs[0] !== runs[1], "★每一趟各有各的编号，带给了桥★", runs);
          ok(said.length === 1 && said[0] === "有 1 条视频上游已经收单还没收回（任务号 vt-8），后台接着等，出好了放进对话目录",
            "★收尾按编号只认这一趟留下的那条，说一句★", said);
          const got = await until(() => fs.existsSync(path.join(task, "兔1.mp4")) && fs.existsSync(path.join(task, "兔2.mp4")) && pending().length === 0, 8000);
          ok(got && recs.length === 6, "★没交到手的两条，后台按任务号收回进对话目录、记账、删台账★", { p: pending(), recs: recs.length, ls: fs.readdirSync(task) });
          // 用户点了停止的那一趟：收尾时能撤的去上游撤
          const ac = new AbortController();
          during = () => ac.abort();
          st.cancelDelay = 400;
          const evs3 = [];
          await rt.runTask({ history: [{ role: "user", content: "第三条" }], emit: (ev) => evs3.push(ev), stopSignal: ac.signal });
          during = null;
          const said3 = evs3.filter((ev) => ev && ev.notice && /视频上游已经收单/.test(ev.text || "")).map((ev) => ev.text);
          const gone3 = await until(() => fs.readdirSync(pdir).length === 0, 8000);
          ok(said3[0] === "停下时有 1 条视频上游已经收单（任务号 vt-10）：能撤的已去上游撤单，撤不掉的出好了放进对话目录" && st.cancels.includes("vt-10") && gone3 && !fs.existsSync(path.join(task, "兔3.mp4")),
            "★用户点了停止的那一趟：收尾认得出是停了的，去上游撤单★", { said3, cancels: st.cancels, p: pending() });
          st.cancelDelay = 0;
          ok(st.checks["vt-10"] === 1, "撤单慢也等它发出去了再开始收：头一次查单就看到「已取消」，不白等一轮", st.checks);
        } finally { engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1); }
      }
    } finally {
      quota.record = record0;
      harvest._internals.stopAll();
      vs.close();
    }

    // —— 时限：claude 的 Bash 给足 15 分钟；codex 那边不加这一项；属主设过的照传给子进程 ——
    if (SH) {
      const c1 = bridge.attach("claude-code", { home: HOME, root, baseDir: "任务_视频", user: "丁", tools: ["generate_video"] });
      const c2 = bridge.attach("codex", { home: HOME, root, baseDir: "任务_视频", user: "丁", tools: ["generate_video"] });
      try {
        const want = process.env.BASH_MAX_TIMEOUT_MS ? undefined : "900000";
        ok(c1.runOpts.env.BASH_MAX_TIMEOUT_MS === want, "★claude 跑 owb 走它的 Bash：上限放到 15 分钟（属主自己设过就不动）★", c1.runOpts.env);
        ok(!("BASH_MAX_TIMEOUT_MS" in ((c2.runOpts || {}).env || {})), "codex 那边不加（它的时限写在 tool_timeout_sec）", c2.runOpts && c2.runOpts.env);
        ok(!("OPENWORKBUDDY_BRIDGE_RUN" in serverOf(c1).env), "反向对照：没给编号就不带这一项", serverOf(c1).env);
      } finally { c1.cleanup(); c2.cleanup(); }
      const own = process.env.BASH_MAX_TIMEOUT_MS;
      process.env.BASH_MAX_TIMEOUT_MS = "1234";
      const c3 = bridge.attach("claude-code", { home: HOME, root, baseDir: "任务_视频", user: "丁", tools: ["generate_video"] });
      try { ok(!("BASH_MAX_TIMEOUT_MS" in c3.runOpts.env), "反向对照：属主自己设过 Bash 时限，桥不去改它", c3.runOpts.env); }
      finally { c3.cleanup(); if (own === undefined) delete process.env.BASH_MAX_TIMEOUT_MS; else process.env.BASH_MAX_TIMEOUT_MS = own; }
    }
    const ce = buildChildEnv({}, { base: { BASH_MAX_TIMEOUT_MS: "1", BASH_DEFAULT_TIMEOUT_MS: "2", MCP_TOOL_TIMEOUT: "3", CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "4", MCP_TIMEOUT: "5", OWB_NOT_LISTED_15: "x" }, allow: [], keys: false });
    ok(ce.BASH_MAX_TIMEOUT_MS === "1" && ce.BASH_DEFAULT_TIMEOUT_MS === "2" && ce.MCP_TOOL_TIMEOUT === "3" && ce.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT === "4" && ce.MCP_TIMEOUT === "5" && !("OWB_NOT_LISTED_15" in ce),
      "属主在 shell 里设的 CLI 时限照传给子进程（反向对照：没列的照拦）", ce);
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
