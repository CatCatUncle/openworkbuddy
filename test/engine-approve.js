// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 本机 Claude Code 的审批工具（src/engines/approve.js）：claude 要审批时来问桥，桥照安全中心的规则裁决。
 *
 *   ① 判法本身：命令、改文件、读文件、抓网页、搜索、不认得的工具，四个档位 + 闸门关着 + 只读那一趟；
 *      拒的话说清卡在哪条规则、别换写法再撞；每次裁决都进审计；判的时候出错按拒
 *   ② 桥那头：只有开了审批的那台 MCP 挂这个工具；每次现读设置（安全中心改了名单下一条就认），
 *      设置读不出来一律拒；审计落进桥那份；owb 命令行那条路不收审批
 *   ③ attach：只有 claude、只有属主开了、不是问答 / 计划那一趟才挂；owb 脚本里不烘这个开关
 *   ④ claude 的命令行：开了才带 --permission-prompt-tool，而且只跟在 --mcp-config 后面
 *   ⑤ 真走一遍：假 claude 照 --mcp-config 拉起桥、照 --permission-prompt-tool 去问，拿回的就是安全中心的判词
 *   ⑥ claude 报这个参数用不了：报错照原话，点名是哪个开关；问答 / 计划那一趟属主手填的这个参数也摘掉
 *   ⑦ 主进程真跑一趟（桩引擎）：开没开、哪种引擎、哪种模式，传下去的和提示词里说的对得上；设置页读得到这个开关；
 *      从桥那头问一句，主进程真摆出卡（谁的、哪个任务、哪条对话），点了批 / 拒、叫停，回去的判词跟着变
 *   ⑧ 服务端真存：起一台真的 server.js，属主勾上、去掉，config.json 跟着变
 *   ⑨ 审批交回主进程（decide 带 ask）：要人点头的去问，批了放、没批拒；不用问的、问了也白问的不摆卡；改文件的卡带 diff
 *   ⑩ cardAsk：摆的卡跟内置那张一样（来源、谁的、哪条对话、等多久）；叫停了不摆、摆了也收；别人批不了
 *   ⑪ 口子上的审批（tool-relay）：不看借出去的名单；凭据、叫停、超时、收工照拒；判的时候带着开口子时那份上下文
 *   ⑫ 桥连回主进程问：判词原样交给 claude；看不懂的、判挂的按拒；claude 不等了、桥被叫停，卡跟着收；连不上才退回桥里照规则判
 *   ⑬ claude 的命令行：「先问」写成 --settings；这版不认、或没挂审批，要问的并回直接禁
 *   ⑭ 安全设置那几句：名单翻成 claude 的禁 / 问、运行页那句、没批下来时说去哪放行（设置里没地方的就不指）
 *
 * 不起任何真 CLI、不出网（抓网页只判 IP 字面量，不解析域名）。⑧ 起的 server.js 只听 127.0.0.1。
 *   node test/engine-approve.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { mod, ROOT: REPO } = require("./lib/mod");
// 赶在 require 生产模块之前：审计、设置都落进临时家（见 test/lib/own-home.js）
const HOME = require("./lib/own-home")("engine-approve");

const approve = require(mod("approve"));
const security = require(mod("security"));
const bridge = require(mod("bridge"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);
const SH = process.platform !== "win32"; // owb 脚本、假 claude 都是脚本写的
process.on("exit", (code) => {
  console.log(`\n${pass} 通过，${fail} 失败`);
  if (fail && !code) process.exitCode = 1;
});

const TOOL = "mcp__" + bridge.SERVER_NAME + "__" + approve.TOOL;
const sec = (o = {}) => security.getSecurity({ security: { ...o } });
const ROOT = path.join(HOME, "ws");
const BASE = path.join(ROOT, "任务_审");
fs.mkdirSync(BASE, { recursive: true });
const ask = (tool_name, input, o = {}) => approve.decide({ tool_name, input, tool_use_id: "t1" }, { sec: sec(o.sec), root: ROOT, base: BASE, readOnly: o.readOnly, platform: o.platform });
const allowed = (d) => d && d.behavior === "allow";
const denied = (d, re) => d && d.behavior === "deny" && typeof d.message === "string" && (!re || re.test(d.message));

/** 照 CLI 的样子拉起 MCP 服务器：initialize 之后按顺序发几条，中间可以插一步（函数）。stdin 一关它答完就走 */
function mcpRun(server, steps, extraEnv = {}) {
  const env = { ...process.env, ...(server.env || {}), ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const out = [];
  let id = 1;
  for (const s of steps) {
    if (typeof s === "function") { s(); continue; }
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: ++id, ...s },
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const p = spawnSync(server.command, server.args || [], { input, env, encoding: "utf8", timeout: 60000 });
    const msgs = String(p.stdout || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
    out.push({ status: p.status, stderr: String(p.stderr || ""), res: msgs.find((m) => m.id === id) });
  }
  return out;
}
/**
 * 同一个桥进程里先后问几次（mcpRun 是一步一个进程，看不出「每次现读设置」还是「起进程时读一次」）。
 * 30 秒没回话按没回算，不把整套测试挂住
 */
function mcpLive(server) {
  const env = { ...process.env, ...(server.env || {}) };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const p = spawn(server.command, server.args || [], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const waiting = new Map();
  let buf = "", err = "", id = 1;
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d) => { err += d; });
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  // 进程没了：等着的那几条当没回（不干等 30 秒）
  p.on("close", () => { for (const [k, w] of waiting) { waiting.delete(k); w(undefined); } });
  p.stdin.write([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n");
  const send = (msg) => new Promise((resolve) => {
    const my = ++id;
    const t = setTimeout(() => { waiting.delete(my); resolve(undefined); }, 30000);
    waiting.set(my, (m) => { clearTimeout(t); resolve(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, ...msg }) + "\n");
  });
  return {
    pid: () => p.pid,
    send: async (msg) => ({ status: 0, stderr: err, res: await send(msg) }),
    /** 下一条 send 会用的请求 id（发 notifications/cancelled 要点名） */
    nextId: () => id + 1,
    notify: (msg) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"),
    kill: (sig) => { try { p.kill(sig); } catch {} },
    exited: () => p.exitCode !== null || p.signalCode !== null,
    close: () => { try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill(); } catch {} }, 2000).unref(); },
  };
}
const listOf = (r) => (r.res && r.res.result ? r.res.result.tools.map((t) => t.name) : null);
/** tools/call approve 回来的那段文字就是判词（JSON） */
const verdictOf = (r) => {
  const t = r.res && r.res.result && r.res.result.content && r.res.result.content[0] && r.res.result.content[0].text;
  try { return JSON.parse(t); } catch { return { raw: t, res: r.res, err: r.stderr.slice(-300) }; }
};
const callApprove = (tool_name, input) => ({ method: "tools/call", params: { name: approve.TOOL, arguments: { tool_name, input, tool_use_id: "t" } } });
const serverOf = (att) => JSON.parse(fs.readFileSync(att.runOpts.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME];
const pairsOf = (argv, flag) => argv.map((a, i) => (a === flag ? argv[i + 1] : null)).filter(Boolean);
/** 等到 fn() 有值（每 20ms 看一次），超时回 undefined */
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return undefined;
    await new Promise((r) => setTimeout(r, 20));
  }
}

(async () => {
  section("① 判法（审批没交回主进程、没有 ask）：跟内置引擎 run_shell / 写文件 / fetch_url 同一套规则，要人点头的照拒");
  {
    security.auditClear();
    // 命令：自动改文件档
    const ls = await ask("Bash", { command: "ls -la", description: "看一眼" });
    ok(allowed(ls) && ls.updatedInput.command === "ls -la" && ls.updatedInput.description === "看一眼", "名单外的普通命令放行，参数原样交回（不改写）", ls);
    ok(allowed(await ask("Bash", { command: "npm test" })), "跑测试这类放行：这正是以前被 claude 自己拒掉、模型反复换写法撞的那种");
    const sudo = await ask("Bash", { command: "sudo ls /" });
    ok(denied(sudo, /命令询问名单「sudo」/) && /这一趟没法问他/.test(sudo.message) && /别换个写法再试/.test(sudo.message), "★询问名单里的（sudo）照拒★ 说清是哪条、这一趟没法问人、别换写法再撞", sudo);
    ok(/到 设置 → 安全 →「沙箱安全 · 命令」/.test(sudo.message) && /「询问名单」/.test(sudo.message) && /「放行名单」/.test(sudo.message) && !/安全中心 的名单/.test(sudo.message),
      "★拒的话里告诉它用户去哪放行，照设置页上的真名★（页签「安全」、「询问名单」「放行名单」；没有「安全中心 的名单」这个地方）", sudo.message);
    const rm = await ask("Bash", { command: "rm -rf build" });
    ok(denied(rm, /删除保护/), "★删除保护照拒★（rm 要人点头）", rm);
    ok(/「数据安全」关掉「删除保护」/.test(rm.message) && /「放行名单」加一行 rm/.test(rm.message), "删除保护拒的：指到「数据安全」那颗开关，或者放行名单加 rm", rm.message);
    ok(denied(await ask("Bash", { command: "cat ~/.ssh/id_rsa" }), /文件黑名单/), "命令里碰了文件黑名单照拒");
    ok(denied(await ask("Bash", { command: "git push --force origin main" }), /强推/), "高危命令（强推）照拒");
    ok(denied(await ask("Bash", { command: "open ." }), /桌面上打开/), "往用户桌面上弹东西的照拒");
    ok(denied(await ask("Bash", { command: "   " }), /command 是空的/) && denied(await ask("Bash", {}), /command 是空的/), "命令是空的：拒，不放一个空的过去");
    ok(denied(await ask("Bash", { command: "ls; sudo reboot" }), /sudo/), "长命令尾巴上藏一句 sudo 也拦得到");
    ok(denied(await ask("PowerShell", { command: "Remove-Item -Recurse x" }), /删除保护/), "PowerShell 按 Windows 那套拆：Remove-Item 算删除");
    ok(allowed(await ask("Monitor", { command: "tail -f run.log" })), "Monitor（盯一条命令的输出）跟 Bash 同一套判法");

    // 档位
    const askMode = await ask("Bash", { command: "ls" }, { sec: { permission_mode: "ask" } });
    ok(denied(askMode, /每步都问/), "★每步都问档：命令一律要人点头，这条路没人批 → 拒★", askMode);
    const plan = await ask("Bash", { command: "ls" }, { sec: { permission_mode: "plan" } });
    ok(denied(plan, /被安全中心拦截/) && /只看不动/.test(plan.message), "只看不动档：命令直接拦", plan);
    ok(allowed(await ask("Bash", { command: "sudo ls" }, { sec: { permission_mode: "full" } })), "全自动档：询问名单不问了（跟内置那边一样）");
    ok(denied(await ask("Bash", { command: "git push --force origin main" }, { sec: { permission_mode: "full" } }), /强推/), "全自动档：高危命令照样要人点头 → 拒");
    // 闸门总开关
    ok(allowed(await ask("Bash", { command: "sudo ls" }, { sec: { gateway: false } })), "闸门关了：名单那套不管（跟内置那边一样）");
    ok(denied(await ask("Bash", { command: "ls" }, { sec: { gateway: false, permission_mode: "ask" } }), /每步都问/), "★闸门关了，档位照管★ 每步都问是用户当场选的档，不归总开关");
    ok(denied(await ask("Write", { file_path: path.join(BASE, "a.md"), content: "x" }, { sec: { gateway: false, permission_mode: "plan" } }), /只看不动/), "闸门关了，只看不动档照样不写文件");

    // 改文件
    const w = await ask("Write", { file_path: path.join(BASE, "报告.md"), content: "x" });
    ok(allowed(w) && w.updatedInput.content === "x", "工作区里写文件：自动改文件档放行", w);
    ok(allowed(await ask("Edit", { file_path: path.join(ROOT, "别的对话", "x.md"), old_string: "a", new_string: "b" })), "工作区里别的对话目录也算工作区");
    const wAsk = await ask("Write", { file_path: path.join(BASE, "报告.md"), content: "x" }, { sec: { permission_mode: "ask" } });
    ok(denied(wAsk, /要用户点头/) && /「权限档位」选「自动改文件」/.test(wAsk.message), "每步都问档：写文件要人点头 → 拒，并说用户去「权限档位」调到哪", wAsk);
    ok(denied(await ask("MultiEdit", { file_path: path.join(BASE, "x.md"), edits: [] }, { sec: { permission_mode: "plan" } }), /只看不动/), "只看不动档：改文件直接拦");
    const out = await ask("Write", { file_path: path.join(HOME, "外面.txt"), content: "x" });
    ok(denied(out, /越界/), "★工作区外写文件拒★（白名单外）", out);
    const cfg = await ask("Edit", { file_path: path.join(HOME, "config.json"), old_string: "a", new_string: "b" });
    ok(denied(cfg, /文件黑名单/), "★改 OpenWorkBuddy 自己的设置文件拒★（黑名单）：不然改一下档位就把自己放出去了", cfg);
    ok(denied(await ask("Write", { file_path: path.join(os.homedir(), ".ssh", "authorized_keys"), content: "x" }), /文件黑名单/), "写 ~/.ssh 拒");
    ok(denied(await ask("NotebookEdit", { notebook_path: "../../../x.ipynb", new_source: "" }), /越界/), "相对路径按这一趟的工作目录解析，走出工作区照拒");
    ok(denied(await ask("Write", { content: "x" }), /没说要写哪个文件/), "没给文件名：拒");

    // 读文件（工作目录里的 claude 自己就放行，会来问的都是外面的）
    ok(allowed(await ask("Read", { file_path: "notes.md" })), "相对路径按这一趟的工作目录解析：在工作区里放行");
    ok(denied(await ask("Read", { file_path: "/etc/hosts" }), /越界/), "工作区外读文件拒（白名单外）");
    ok(denied(await ask("Read", { file_path: path.join(os.homedir(), ".ssh", "id_rsa") }), /文件黑名单/), "读 ~/.ssh 拒");
    ok(denied(await ask("Glob", { pattern: "../../../**/*" }), /越界/), "★glob 按通配符前面那段判★ ../../../** 走出工作区就拒");
    ok(allowed(await ask("Glob", { pattern: "src/**/*.js" })), "glob 在工作区里放行");
    ok(denied(await ask("Glob", { path: "/etc", pattern: "*" }), /越界/), "glob 给了工作区外的 path 拒");
    ok(allowed(await ask("Grep", { pattern: "x" })), "Grep 不带 path（就在当前目录）放行");
    ok(denied(await ask("Grep", { pattern: "x", path: path.join(os.homedir(), ".ssh") }), /文件黑名单/), "Grep 搜 ~/.ssh 拒");
    ok(approve._internals.globRoot("a/b/*.md") === "a/b/" && approve._internals.globRoot("**") === "." && approve._internals.globRoot("x/{a,b}") === "x/", "globRoot：取第一个通配符之前那段");

    // 网络
    ok(denied(await ask("WebFetch", { url: "http://127.0.0.1:9/", prompt: "x" }), /被安全中心拦截/), "★抓本机地址拒★（跟 fetch_url 一样防 SSRF）");
    ok(denied(await ask("WebFetch", { url: "file:///etc/passwd", prompt: "x" })), "非 http 的拒");
    ok(denied(await ask("WebFetch", { url: "https://bad.example/x", prompt: "x" }, { sec: { url_blacklist: ["bad.example"] } }), /黑名单/), "网络黑名单里的域名拒");
    ok(allowed(await ask("WebFetch", { url: "http://1.1.1.1/", prompt: "x" })), "公网地址放行");
    ok(allowed(await ask("WebSearch", { query: "天气" })), "联网搜索放行（内置那边也不设闸，只记一笔）");
    // 不碰文件、不跑新命令的
    for (const n of ["TodoWrite", "BashOutput", "KillShell", "TaskOutput", "TaskStop"]) ok(allowed(await ask(n, {})), `${n} 放行`);
    // 不认得的
    const unk = await ask("SomeNewTool", { x: 1 });
    ok(denied(unk, /不在 OpenWorkBuddy 认得的范围里/), "★不认得的工具一律拒★ 规则一写宽就等于把审批整个放开", unk);
    ok(denied(await approve.decide(null, { sec: sec(), root: ROOT, base: BASE }), /这个工具/), "请求是空的：拒");
    ok(denied(await approve.decide({ tool_name: "Bash", input: "ls" }, { sec: sec(), root: ROOT, base: BASE }), /command 是空的/), "input 不是对象：当空的看，拒");
    // 只读那一趟
    const ro = await ask("Bash", { command: "ls" }, { readOnly: true });
    ok(denied(ro, /问答 \/ 计划模式/), "问答 / 计划那一趟：要审批的一律不批", ro);
    ok(denied(await ask("WebSearch", { query: "x" }, { readOnly: true })), "只读那一趟连搜索也不批（读工作目录 claude 自己就放行，不会来问）");
    // 判的时候出错
    const boom = await approve.decide({ tool_name: "Read", input: { file_path: "a" } }, { sec: null, root: ROOT, base: BASE });
    ok(denied(boom, /审批这一步出了错/) && /按拒绝处理/.test(boom.message), "★判的时候出错按拒★ 放过去等于没设", boom);

    // 审计：每次裁决都留一笔
    const rows = security.auditList(500);
    const has = (type, re, action) => rows.some((r) => r.type === type && re.test(r.text) && (!action || r.action === action));
    ok(has("命令审批", /sudo ls \//, "已拒绝（这一趟没法问人）"), "审计：要人点头的命令记「已拒绝（这一趟没法问人）」", rows.slice(0, 5));
    ok(has("命令执行", /^npm test$/, "放行（本机引擎）"), "审计：放行的命令也记一笔，标明是本机引擎");
    ok(has("命令拦截", /^ls$/, "拦截"), "审计：只看不动档拦下的命令");
    ok(has("文件拦截", /Write: .*外面\.txt/, "拦截"), "审计：越界的文件，带工具名");
    ok(has("改文件审批", /报告\.md/, "已拒绝（这一趟没法问人）"), "审计：每步都问档拒掉的写文件");
    ok(has("网络拦截", /127\.0\.0\.1/, "拦截") && has("网络访问", /1\.1\.1\.1/), "审计：抓网页拦了的、放了的都有");
    ok(has("本机引擎拦截", /SomeNewTool/, "拦截"), "审计：不认得的工具");
    ok(!rows.some((r) => r.action === "等待审批"), "没给 ask（审批没交回主进程）：一条「等待审批」都没有，不摆卡");
  }

  section("② 桥那头：开了审批才挂；每次现读设置；读不出来一律拒；审计落进桥那份");
  {
    const H = path.join(HOME, "桥");
    fs.mkdirSync(H, { recursive: true });
    const cfgFile = path.join(H, "config.json");
    const att = bridge.attach("claude-code", { home: H, root: ROOT, baseDir: "任务_审", user: "t", tools: ["remember"], approve: true });
    const plain = bridge.attach("claude-code", { home: H, root: ROOT, baseDir: "任务_审", user: "t", tools: ["remember"] });
    try {
      const sv = serverOf(att);
      ok(sv.env.OPENWORKBUDDY_BRIDGE_APPROVE === "1", "开了审批：MCP 配置里带着开关", sv.env);
      ok(!("OPENWORKBUDDY_BRIDGE_APPROVE" in serverOf(plain).env), "反向对照：没开就不带");
      const [l1] = mcpRun(sv, [{ method: "tools/list" }]);
      const [l0] = mcpRun(serverOf(plain), [{ method: "tools/list" }]);
      ok(JSON.stringify(listOf(l1)) === JSON.stringify(["remember", approve.TOOL]), "开了审批：tools/list 多一个 approve（claude 认它当审批工具后模型看不见它）", listOf(l1));
      ok(JSON.stringify(listOf(l0)) === JSON.stringify(["remember"]), "反向对照：没开就没有 approve", listOf(l0));
      const [c0] = mcpRun(serverOf(plain), [callApprove("Bash", { command: "ls" })]);
      ok(c0.res && c0.res.result && c0.res.result.isError && /没有借给/.test(c0.res.result.content[0].text), "没开审批时调 approve：当成没借出去的工具拒", c0.res);

      fs.rmSync(cfgFile, { force: true });
      const r = mcpRun(sv, [
        callApprove("Bash", { command: "npm test" }),
        callApprove("Bash", { command: "sudo reboot" }),
        // 安全中心里改了档位：下一条就照新的判，不用重开引擎
        () => fs.writeFileSync(cfgFile, JSON.stringify({ security: { permission_mode: "ask" } })),
        callApprove("Bash", { command: "npm test" }),
        // 名单里预先放行了：下一条就放
        () => fs.writeFileSync(cfgFile, JSON.stringify({ security: { cmd_allow: ["sudo ls"] } })),
        callApprove("Bash", { command: "sudo ls" }),
        // 设置坏了：一律拒，报文件在哪
        () => fs.writeFileSync(cfgFile, "{ 坏"),
        callApprove("Bash", { command: "npm test" }),
        () => fs.writeFileSync(cfgFile, "{}"),
        callApprove("Bash", { command: "npm test" }),
      ]).map(verdictOf);
      ok(allowed(r[0]) && r[0].updatedInput.command === "npm test", "MCP：放行的回 allow + 原参数", r[0]);
      ok(denied(r[1], /sudo/), "MCP：询问名单里的回 deny + 人话", r[1]);
      ok(denied(r[2], /每步都问/), "★设置改了下一条就认★（档位调到每步都问）", r[2]);
      ok(allowed(r[3]), "名单里预先放行的（cmd_allow）照放", r[3]);
      ok(denied(r[4], /读不到安全策略/) && r[4].message.includes(cfgFile), "★设置读不出来一律拒★ 说清是哪个文件", r[4]);
      ok(allowed(r[5]), "文件改好了下一条就认", r[5]);
      // 上面每一步是一个新进程：起进程时读一次也过得了。这里同一个进程先后两问，中间改档位
      fs.rmSync(cfgFile, { force: true });
      const lv = mcpLive(sv);
      try {
        const a = verdictOf(await lv.send(callApprove("Bash", { command: "npm test" })));
        fs.writeFileSync(cfgFile, JSON.stringify({ security: { permission_mode: "ask" } }));
        const b = verdictOf(await lv.send(callApprove("Bash", { command: "npm test" })));
        ok(allowed(a) && denied(b, /每步都问/), "★同一个桥进程里设置改了，下一条就认★（不是起进程时读一次）", { a, b });
      } finally { lv.close(); fs.writeFileSync(cfgFile, "{}"); }
      // 工作区根照这一趟的：工作区外的照拒，里面的照放
      const [inWs, outWs] = mcpRun(sv, [
        callApprove("Write", { file_path: path.join(ROOT, "任务_审", "x.md"), content: "x" }),
        callApprove("Write", { file_path: path.join(H, "x.md"), content: "x" }),
      ]).map(verdictOf);
      ok(allowed(inWs) && denied(outWs, /越界/), "桥认的工作区根是这一趟的根（OPENWORKBUDDY_BRIDGE_ROOT），不是数据目录下那份", { inWs, outWs });
      const [rel, up1] = mcpRun(sv, [
        callApprove("Read", { file_path: "../../外面.txt" }),
        // 从根算的话这条就出了工作区；从根/任务_审 算还在里面。光看上面那条分不出是从哪儿算的
        callApprove("Read", { file_path: "../别的任务/x.md" }),
      ]).map(verdictOf);
      ok(denied(rel, /越界/), "相对路径按这一趟的工作目录（根/任务_审）解析", rel);
      ok(allowed(up1), "★相对路径从根/任务_审 起算★：../别的任务 还在工作区里，放行", up1);
      // 审计落进桥那份（主进程看列表时并进来）
      const lines = fs.readFileSync(path.join(H, "data", "audit-bridge.jsonl"), "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x));
      ok(lines.some((e) => e.type === "命令审批" && /sudo reboot/.test(e.text)) && lines.some((e) => e.type === "命令执行" && e.action === "放行（本机引擎）"),
        "审计每条当场追加进 data/audit-bridge.jsonl（桥进程判完就可能被带走）", lines.slice(-4));

      if (SH) {
        const shim = fs.readFileSync(att.shim, "utf8");
        ok(!/OPENWORKBUDDY_BRIDGE_APPROVE/.test(shim), "owb 脚本里不烘审批开关：命令行那条路不收审批");
        const p = spawnSync("/bin/sh", [att.shim, approve.TOOL, JSON.stringify({ tool_name: "Bash", input: { command: "ls" } })], { encoding: "utf8", timeout: 60000 });
        ok(p.status !== 0 && /没有借给/.test(p.stdout + p.stderr), "owb approve 调不到（模型拿它给自己批不了）", { status: p.status, out: (p.stdout + p.stderr).slice(0, 300) });
      }
    } finally { att.cleanup(); plain.cleanup(); }
  }

  section("③ attach：只有 claude、只有开了、不是只读那一趟才挂");
  {
    const cc = bridge.attach("claude-code", { home: HOME, root: ROOT, baseDir: "任务_审", tools: [], approve: true });
    const off = bridge.attach("claude-code", { home: HOME, root: ROOT, baseDir: "任务_审", tools: [] });
    const ro = bridge.attach("claude-code", { home: HOME, root: ROOT, baseDir: "任务_审", tools: [], approve: true, readOnly: true });
    const cx = bridge.attach("codex", { home: HOME, root: ROOT, baseDir: "任务_审", tools: [], approve: true });
    try {
      ok(cc.approve === true && cc.runOpts.permissionPromptTool === TOOL, "claude + 开了：挂上，审批工具的全名给 run()", { approve: cc.approve, t: cc.runOpts.permissionPromptTool });
      ok(off.approve === false && !("permissionPromptTool" in off.runOpts), "没开：不挂", off.runOpts);
      ok(ro.approve === false && !("permissionPromptTool" in ro.runOpts) && !("OPENWORKBUDDY_BRIDGE_APPROVE" in serverOf(ro).env), "只读那一趟：不挂（这一趟要审批的本来就一律不批）", ro.runOpts);
      ok(cx.approve === false && !("permissionPromptTool" in cx.runOpts) && !cx.runOpts.mcpArgs.some((a) => /APPROVE/.test(a)), "codex：不挂（它没有这个参数）", cx.runOpts.mcpArgs.filter((a) => /env=/.test(a)));
    } finally { cc.cleanup(); off.cleanup(); ro.cleanup(); cx.cleanup(); }
  }

  if (SH) {
    const claude = require(mod("claude-code"));
    const argvOut = path.join(HOME, "argv.json");
    const answers = path.join(HOME, "answers.json");
    // 假 claude：把收到的参数写下来；带了审批工具就照 --mcp-config 拉起那台服务器，照 --permission-prompt-tool 去问
    const fake = path.join(HOME, "fakeclaude");
    fs.writeFileSync(fake, [
      "#!/usr/bin/env node",
      'const fs = require("fs"), { spawnSync } = require("child_process");',
      "const argv = process.argv.slice(2);",
      `fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(argv));`,
      'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ""; };',
      'const tool = at("--permission-prompt-tool"), cfg = at("--mcp-config");',
      "const m = /^mcp__(.+?)__(.+)$/.exec(tool);",
      "const sv = m && cfg ? JSON.parse(fs.readFileSync(cfg, \"utf8\")).mcpServers[m[1]] : null;",
      "if (sv) {",
      "  const ask = (req, id) => [",
      '    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } },',
      '    { jsonrpc: "2.0", method: "notifications/initialized" },',
      '    { jsonrpc: "2.0", id, method: "tools/call", params: { name: m[2], arguments: req } },',
      '  ].map((x) => JSON.stringify(x)).join("\\n") + "\\n";',
      '  const reqs = [{ tool_name: "Bash", input: { command: "sudo reboot" }, tool_use_id: "a" }, { tool_name: "Bash", input: { command: "npm test" }, tool_use_id: "b" }];',
      "  const out = reqs.map((r, k) => {",
      '    const p = spawnSync(sv.command, sv.args || [], { input: ask(r, k + 2), env: { ...process.env, ...(sv.env || {}) }, encoding: "utf8" });',
      '    const msg = String(p.stdout).split("\\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === k + 2);',
      "    return JSON.parse(msg.result.content[0].text);",
      "  });",
      `  fs.writeFileSync(${JSON.stringify(answers)}, JSON.stringify(out));`,
      "}",
      'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: {} }) + "\\n");',
    ].join("\n"));
    fs.chmodSync(fake, 0o755);
    const ccArgv = async (opts) => {
      await claude.run({ prompt: "hi", cwd: BASE, bin: fake, model: "sonnet", ...opts });
      return JSON.parse(fs.readFileSync(argvOut, "utf8"));
    };

    section("④ claude 的命令行：开了才带 --permission-prompt-tool，只跟在 --mcp-config 后面");
    {
      const cfg = path.join(HOME, "mcp.json");
      fs.writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
      const on = await ccArgv({ mcpConfigPath: cfg, mcpServerNames: ["openworkbuddy"], permissionPromptTool: TOOL });
      ok(JSON.stringify(pairsOf(on, "--permission-prompt-tool")) === JSON.stringify([TOOL]), "开了：--permission-prompt-tool 指到桥上那个 approve", on);
      ok(pairsOf(on, "--permission-mode").length === 1 && pairsOf(on, "--allowed-tools").includes("mcp__openworkbuddy"), "档位、MCP 放行照旧", on);
      const offA = await ccArgv({ mcpConfigPath: cfg, mcpServerNames: ["openworkbuddy"] });
      ok(!offA.includes("--permission-prompt-tool"), "没开：不带", offA);
      const noCfg = await ccArgv({ permissionPromptTool: TOOL });
      ok(!noCfg.includes("--permission-prompt-tool"), "★没挂 MCP 就不带★ 指到一台没挂的服务器上，claude 当场退出", noCfg);
    }

    section("⑤ 真走一遍：假 claude 照 --mcp-config 拉起桥、照 --permission-prompt-tool 去问");
    {
      const H = path.join(HOME, "真走");
      fs.mkdirSync(H, { recursive: true });
      const att = bridge.attach("claude-code", { home: H, root: ROOT, baseDir: "任务_审", tools: [], approve: true });
      try {
        fs.rmSync(answers, { force: true });
        await ccArgv({ ...att.runOpts });
        const a = fs.existsSync(answers) ? JSON.parse(fs.readFileSync(answers, "utf8")) : null;
        ok(a && denied(a[0], /sudo/) && allowed(a[1]) && a[1].updatedInput.command === "npm test",
          "★拿回的就是安全中心的判词★ sudo reboot 拒、npm test 放", a);
      } finally { att.cleanup(); }
    }

    section("⑥ claude 说这个参数用不了：照原话报，点名是哪个开关");
    {
      const raw = "Error: MCP tool mcp__openworkbuddy__approve (passed via --permission-prompt-tool) not found. Available MCP tools: none";
      const e = claude.explain(raw, 1);
      ok(/底层引擎/.test(e) && e.includes(raw), "MCP 工具找不到：说是哪个开关、去哪关，原话附上", e);
      const u = claude.explain("error: unknown option '--permission-prompt-tool'", 1);
      ok(/底层引擎/.test(u) && u.includes("unknown option"), "这版 claude 不认这个参数：同上", u);
      ok(!/底层引擎/.test(claude.explain("Error: something else", 1)), "反向对照：别的错照原样");
      const gate = require(mod("gate"));
      const l = gate.looseArgs(["--permission-prompt-tool", "mcp__x__y", "--verbose", "--permission-prompt-tool=mcp__x__z"], "claude-code");
      ok(l && JSON.stringify(l.keep) === JSON.stringify(["--verbose"]) && l.dropped.length === 2, "问答 / 计划那一趟：属主在附加参数里手填的 --permission-prompt-tool 两种写法都摘掉", l);
    }
  } else console.log("\n（Windows：跳过 ④⑤⑥ 的假 claude 那几条）");

  section("⑦ 主进程真跑一趟（桩引擎）：开没开、哪种引擎、哪种模式，传下去的和提示词说的对得上");
  {
    const engines = require(mod("engines"));
    const { createAgentRuntime } = require(mod("agent"));
    const { McpManager } = require(mod("mcp"));
    let seen = null;
    /** 引擎「跑着」的时候插一段：照桥那样拿凭据文件连回主进程问一句（见下面摆卡那几条） */
    let during = null;
    const run = async (o) => {
      seen = { prompt: o.systemPrompt || "", tool: o.permissionPromptTool, env: null, guard: o.guard || {} };
      if (o.mcpConfigPath) seen.env = JSON.parse(fs.readFileSync(o.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME].env;
      // 引擎跑着的时候凭据文件得在（桥要靠它连回来）；跑完收工才删
      if (seen.env && seen.env[relayMod.APPROVE_ENV]) seen.ticketLive = fs.existsSync(seen.env[relayMod.APPROVE_ENV]);
      if (during) {
        try { seen.during = await during(o, seen.env || {}); }
        catch (e) { seen.during = { error: String((e && e.stack) || e) }; }
      }
      return { finalText: "好", usage: {}, stopped: null, sessionId: null };
    };
    const relayMod = require(mod("tool-relay"));
    let notices = [];
    const withStub = async (id, { opts = {}, security: s, mode, user, taskLabel, sessionId, stop, hook } = {}) => {
      const i = engines.BACKENDS.findIndex((b) => b.id === id);
      const real = i >= 0 ? engines.BACKENDS.splice(i, 1)[0] : null;
      const stub = { id, label: "桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: false, models: [],
        async detect() { return { id, installed: true, path: "", version: "0" }; }, run };
      engines.BACKENDS.push(stub);
      try {
        const fakeLLM = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
        const config = { ...(s ? { security: s } : {}), agent: { engine: id, max_steps: 3, engine_options: { [id]: { model: "m1", ...opts } } } };
        const rt = createAgentRuntime({ config, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
        seen = null;
        notices = [];
        during = hook || null;
        await rt.runTask({
          history: [{ role: "user", content: "干活" }], emit(e) { if (e && e.notice) notices.push(String(e.text)); },
          ...(mode ? { mode } : {}), ...(user ? { user } : {}), ...(taskLabel ? { taskLabel } : {}), ...(sessionId ? { sessionId } : {}),
          ...(stop ? { stopSignal: stop.signal } : {}),
        });
        return { ...(seen || {}), notices };
      } finally {
        during = null;
        engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
        if (real) engines.BACKENDS.splice(i, 0, real);
      }
    };
    const on = await withStub("claude-code", { opts: { approval: true } });
    ok(on.tool === TOOL && on.env && on.env.OPENWORKBUDDY_BRIDGE_APPROVE === "1", "★属主开了：run() 拿到审批工具，桥那头开关也打开了★", { tool: on.tool, env: on.env });
    ok(/命令按用户的安全设置裁决/.test(on.prompt) && /会弹卡问用户/.test(on.prompt) && /没批下来就别换个写法再试/.test(on.prompt) && !/别的多半会被拒/.test(on.prompt) && !/这一趟没法问人/.test(on.prompt),
      "★提示词照实说：要人点头的会弹卡问用户★ 没批下来别换写法再撞；不再说「别的多半会被拒」", (on.prompt.match(/.*自动改文件.*/g) || []).slice(0, 2));
    const ticket = on.env && on.env[relayMod.APPROVE_ENV];
    ok(typeof ticket === "string" && ticket.length > 0 && on.ticketLive === true && !(relayMod.ENV in on.env),
      "★审批交回主进程：桥拿到凭据文件的路径（跑着的时候文件在）★ 没勾「交回主进程跑」就不带借工具那个变量", { ticket, live: on.ticketLive, env: on.env });
    ok(ticket && !fs.existsSync(ticket), "跑完收工：凭据文件删掉（吊销）", ticket);
    ok(JSON.stringify(on.guard.disallow) === "[]" && on.guard.ask.includes("Bash(rm:*)") && on.guard.ask.includes("Bash(rmdir:*)") && on.guard.ask.includes("Bash(sudo:*)"),
      "★名单里要问的改挂成「先问」★（rm、rmdir、sudo），不再直接禁", on.guard);
    ok(!on.notices.some((t) => /本机 (CLI|Claude Code)/.test(t) && /(不跑|不许)/.test(t)), "开了：运行页不说「这一趟不跑 rm」那句（现在碰到会弹卡）", on.notices);
    const off = await withStub("claude-code");
    ok(off.tool === undefined && off.env && !("OPENWORKBUDDY_BRIDGE_APPROVE" in off.env) && !(relayMod.APPROVE_ENV in off.env), "反向对照：没开就不传", { tool: off.tool, env: off.env });
    ok(/别的多半会被拒/.test(off.prompt) && /勾上「删文件等操作先问我」/.test(off.prompt), "反向对照：没开，提示词照旧说命令多半会被拒，并说勾哪颗能改成问人");
    ok(off.guard.disallow.includes("Bash(rm:*)") && off.guard.disallow.includes("Bash(rmdir:*)") && !off.guard.ask, "没开：要问的照旧直接禁（rm、rmdir）", off.guard);
    ok(off.notices.some((t) => t.startsWith("按你的安全设置，本机 Claude Code 这一趟不跑：") && t.includes("勾「删文件等操作先问我」") && !t.includes("没有审批通道")),
      "★没开：运行页那句指到「删文件等操作先问我」那颗勾★ 不说「没有审批通道」（说没有，人就不会去找）", off.notices);
    const str = await withStub("claude-code", { opts: { approval: "true" } });
    ok(str.tool === undefined, "开关只认布尔 true（手写成字符串的不算）", str.tool);
    const ro = await withStub("claude-code", { opts: { approval: true, permissionPromptTool: "mcp__x__y" }, mode: "ask" });
    ok(ro.tool === undefined, "★问答那一趟：开了也不挂★ 属主手填的同名参数也盖回去", ro.tool);
    const cx = await withStub("codex", { opts: { approval: true } });
    ok(cx.tool === undefined && !(cx.env && "OPENWORKBUDDY_BRIDGE_APPROVE" in cx.env) && !(cx.env && relayMod.APPROVE_ENV in cx.env), "codex：开了也不挂", cx.tool);
    ok(cx.notices.some((t) => /没有审批通道/.test(t)) && !cx.notices.some((t) => /删文件等操作先问我/.test(t)), "codex 真没有审批通道：照旧这么说，不指那颗只有 claude 有的勾", cx.notices);

    // 引擎跑着的时候，照桥那样拿凭据文件连回主进程问一句：主进程真摆出卡，点了批 / 拒、叫停，回去的判词跟着变
    const opened = [];
    const unwatch = security.watchApprovals((ev) => { if (ev.type === "open") opened.push(ev.entry); });
    try {
      const chain = (answer, cmd = "rm -rf build") => async (o, env) => {
        const p = relayMod.approval(env[relayMod.APPROVE_ENV], { tool_name: "Bash", input: { command: cmd }, tool_use_id: "x" }).catch((e) => ({ error: e.message }));
        const card = await waitFor(() => security.listApprovals().find((c) => c.text === cmd));
        const scoped = { alice: security.listApprovals("alice").length, bob: security.listApprovals("bob").length };
        if (card) security.resolveApproval(card.id, answer);
        return { card, scoped, verdict: await p };
      };
      const yes = await withStub("claude-code", { opts: { approval: true }, user: "alice", taskLabel: "清理构建目录", sessionId: "s-chain", hook: chain(true) });
      const yd = yes.during || {};
      const c = yd.card;
      ok(c && c.kind === "命令执行" && c.text === "rm -rf build" && /^删除保护/.test(c.rule) && c.ruleKey === "rm" && c.source === "清理构建目录" && c.sessionId === "s-chain",
        "★claude 要跑 rm：主进程真摆出卡★ 跟内置那张一样（命令执行、删除保护、哪个任务、哪条对话）", yd);
      const e = opened.find((x) => x.text === "rm -rf build");
      ok(e && e.owner === "alice" && e.blacklist === false, "卡记着是谁的任务（发起的人）", e);
      ok(yd.scoped && yd.scoped.alice === 1 && yd.scoped.bob === 0, "★多人共用：只有发起的人看得见★ 别人那边一张都没有", yd.scoped);
      ok(allowed(yd.verdict) && yd.verdict.updatedInput.command === "rm -rf build", "★点了批：回给 claude 的是放行★ 参数原样", yd.verdict);
      const no = await withStub("claude-code", { opts: { approval: true }, user: "alice", hook: chain(false) });
      const nv = (no.during || {}).verdict;
      ok(denied(nv, /命令没批下来（删除保护/) && /被拒、等超时，或者当时没人能批/.test(nv.message) && !/用户拒/.test(nv.message),
        "★点了拒：回的是拒★ 照实说没批下来，不替人下结论说「用户拒了」", nv);
      ok(security.listApprovals().length === 0, "批完、拒完：一张卡都不剩", security.listApprovals());

      // 卡挂着的时候用户点了停止：卡收掉，按没批回给 claude
      const stop = new AbortController();
      const halted = await withStub("claude-code", { opts: { approval: true }, user: "alice", stop, hook: async (o, env) => {
        const p = relayMod.approval(env[relayMod.APPROVE_ENV], { tool_name: "Bash", input: { command: "rm -rf dist" }, tool_use_id: "y" }).catch((err) => ({ error: err.message }));
        const card = await waitFor(() => security.listApprovals().find((x) => x.text === "rm -rf dist"));
        stop.abort();
        const verdict = await p;
        return { card: !!card, verdict, left: security.listApprovals().length };
      } });
      const hd = halted.during || {};
      ok(hd.card === true && hd.left === 0 && denied(hd.verdict, /没批下来/), "★卡挂着时点了停止：卡收掉，按没批回给 claude★", hd);
    } finally { unwatch(); }

    // 审批口子开不了（建不了套接字之类）：照旧在桥里按规则判，要人点头的照拒；运行页说一句，提示词也照实说
    const realOpen = relayMod.open;
    relayMod.open = async () => { throw new Error("建不了口子"); };
    try {
      const fb = await withStub("claude-code", { opts: { approval: true } });
      ok(fb.tool === TOOL && fb.env && fb.env.OPENWORKBUDDY_BRIDGE_APPROVE === "1" && !(relayMod.APPROVE_ENV in fb.env), "口子开不了：审批工具照挂（桥里照规则判），只是不带凭据文件", { tool: fb.tool, env: fb.env });
      ok(fb.notices.includes("删文件等操作这次没法弹卡问你（建不了口子），碰到会直接不做") && !fb.notices.some((t) => /借出去的工具没能/.test(t)),
        "★运行页说一句这次没法弹卡★ 原话带上；没勾借工具那颗就不说借工具那句", fb.notices);
      ok(/这一趟没法问人/.test(fb.prompt) && !/会弹卡问用户/.test(fb.prompt), "提示词照实说这一趟没法问人，不说会弹卡", (fb.prompt.match(/.*自动改文件.*/g) || []).slice(0, 2));
      ok(fb.guard.disallow.includes("Bash(rm:*)") && !fb.guard.ask, "没法问：rm 照旧直接禁，不挂「先问」（挂了也没人答）", fb.guard);
      ok(!fb.notices.some((t) => /不许自己跑|没有审批通道|这一趟不跑/.test(t)), "口子开不了：不再补一句「不跑 rm / 没有审批通道」（上面那句已经说了碰到会直接不做，说两遍还互相打架）", fb.notices);
      const fbPlan = await withStub("claude-code", { opts: { approval: true }, security: { permission_mode: "plan" } });
      ok(fbPlan.notices.some((t) => /安全档位是「只看不动」/.test(t)), "口子开不了、档位是只看不动：只看不动那句照说（跟弹不弹卡无关）", fbPlan.notices);
      const both = await withStub("claude-code", { opts: { approval: true, relay: true } });
      ok(both.notices.some((t) => /借出去的工具没能改由主进程跑（建不了口子）/.test(t)) && both.notices.some((t) => /没法弹卡问你（建不了口子）/.test(t)), "两颗都勾、口子开不了：两句各说各的", both.notices);
    } finally { relayMod.open = realOpen; }
    const planOn = await withStub("claude-code", { opts: { approval: true }, security: { permission_mode: "plan" } });
    ok(planOn.notices.some((t) => /安全档位是「只看不动」/.test(t)), "开了审批、档位是只看不动：运行页照说只看不动", planOn.notices);
    const both = await withStub("claude-code", { opts: { approval: true, relay: true } });
    ok(both.env && both.env[relayMod.ENV] && both.env[relayMod.ENV] === both.env[relayMod.APPROVE_ENV], "两颗都勾：借工具和审批走同一个口子（同一份凭据）", both.env);
    const full = await withStub("claude-code", { opts: { approval: true }, security: { permission_mode: "full" } });
    ok(!/别的多半会被拒/.test(full.prompt), "全自动档不说止血那句（claude 那边整个放开，审批工具不会被问到）");

    const v = (o) => engines.gateView("claude-code", { agent: { engine_options: { "claude-code": o } } });
    ok(v({ approval: true }).approval === true && v({}).approval === false && v({ approval: "1" }).approval === false, "设置页读得到这个开关（只认 true）", [v({ approval: true }), v({})]);
    const prefs = require(mod("prefs"));
    ok(!prefs.isPersonalPatch({ agent: { engine_options: { "claude-code": { approval: true } } } }), "成员改不了这个开关（不算个人设置）");
  }

  section("⑧ 服务端真存：属主勾上、去掉，config.json 里跟着变（引擎设置那段是一个键一个键收的，漏一个就存不进去）");
  {
    const { spawn } = require("child_process");
    const http = require("http");
    const H = path.join(HOME, "srv");
    fs.mkdirSync(H, { recursive: true });
    const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
      env: { ...process.env, OPENWORKBUDDY_HOME: H, OPENWORKBUDDY_DATA_DIR: path.join(H, "data"), HOST: "127.0.0.1", PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (c) => (log += c));
    child.stderr.on("data", (c) => (log += c));
    try {
      const port = await new Promise((resolve) => {
        const t0 = Date.now();
        const tick = setInterval(() => {
          const m = /已启动: http:\/\/localhost:(\d+)/.exec(log);
          if (m || child.exitCode !== null || Date.now() - t0 > 60000) { clearInterval(tick); resolve(m ? Number(m[1]) : 0); }
        }, 200);
      });
      ok(port > 0, "server.js 起来了", { exit: child.exitCode, log: log.slice(-400) });
      if (port) {
        const req = (method, p, body, cookie) => new Promise((resolve) => {
          const data = body ? JSON.stringify(body) : null;
          const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
            ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
            ...(cookie ? { cookie } : {}),
          } }, (res) => {
            let b = ""; res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ status: res.statusCode, body: b, setCookie: res.headers["set-cookie"] }));
          });
          r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
          if (data) r.write(data);
          r.end();
        });
        const reg = await req("POST", "/api/auth/register", { username: "admin", password: "Str0ngPass!2345" });
        const cookie = (reg.setCookie || []).map((c) => c.split(";")[0]).join("; ");
        const save = (o) => req("POST", "/api/settings", { agent: { engine_options: { "claude-code": o } } }, cookie);
        const cc = () => {
          try { return ((JSON.parse(fs.readFileSync(path.join(H, "config.json"), "utf8")).agent || {}).engine_options || {})["claude-code"] || {}; }
          catch { return {}; }
        };
        const s1 = await save({ approval: true, model: "sonnet" });
        ok(s1.status === 200 && cc().approval === true, "★属主勾上：config.json 里存成 true★", { status: s1.status, body: s1.body.slice(0, 200), saved: cc() });
        const s2 = await save({ approval: false });
        ok(s2.status === 200 && cc().approval === false && cc().model === "sonnet", "去掉勾：存成 false，别的不动", cc());
      }
    } finally { child.kill("SIGKILL"); }
  }

  section("⑨ 审批交回主进程（decide 带 ask）：要人点头的去问，批了放、没批拒；不用问的、问了也白问的不摆卡；改文件的卡带 diff");
  {
    security.auditClear();
    let calls = [];
    /** 假的「摆卡」：记下问了什么，照 answer 答（给个 Error 就当摆卡出错） */
    const rec = (answer) => async (verdict, label, text, detail) => {
      calls.push({ verdict, label, text, detail });
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const askVia = (fn, tool_name, input, o = {}) => {
      calls = [];
      return approve.decide({ tool_name, input, tool_use_id: "t9" }, { sec: sec(o.sec), root: ROOT, base: BASE, readOnly: o.readOnly, ask: fn });
    };
    const y = await askVia(rec(true), "Bash", { command: "rm -rf build" });
    ok(allowed(y) && y.updatedInput.command === "rm -rf build", "★删除保护的 rm：去问，批了就放★", y);
    ok(calls.length === 1 && calls[0].label === "命令" && calls[0].text === "rm -rf build" && /^删除保护/.test(calls[0].verdict.rule) && calls[0].verdict.ruleKey === "rm",
      "问的时候带着哪类、哪条命令、哪条规则（卡上照这个摆）", calls);
    const n = await askVia(rec(false), "Bash", { command: "rm -rf build" });
    ok(denied(n, /命令没批下来（删除保护/) && /被拒、等超时，或者当时没人能批/.test(n.message) && /别换个写法再试/.test(n.message) && !/用户拒/.test(n.message),
      "★没批：拒★ 照实说没批下来（被拒、等超时、没人能批都有可能，不替人下结论），别换写法再撞", n);
    ok(allowed(await askVia(rec(false), "Bash", { command: "npm test" })) && calls.length === 0, "不用问的（npm test）：不摆卡，直接放");
    const bl = await askVia(rec(false), "Bash", { command: "cat ~/.ssh/id_rsa" });
    ok(denied(bl) && calls.length === 1 && calls[0].verdict.blacklist === true && calls[0].verdict.ruleKey === "",
      "碰了文件黑名单：单人用照样问，卡上标黑名单、不给「以后都放」", calls.map((x) => x.verdict));
    security.setMultiUser(() => true);
    try {
      const m = await askVia(rec(true), "Bash", { command: "cat ~/.ssh/id_rsa" });
      ok(denied(m, /多人共用时这类一律拦下/) && calls.length === 0, "★多人共用：碰了黑名单的直接拦，不摆卡★（谁批都不算）", { m, calls });
    } finally { security.setMultiUser(null); }
    ok(denied(await askVia(rec(true), "Bash", { command: "ls" }, { sec: { permission_mode: "plan" } }), /只看不动/) && calls.length === 0, "只看不动档：直接拦，不摆卡");
    ok(denied(await askVia(rec(true), "Bash", { command: "rm -rf build" }, { readOnly: true }), /问答 \/ 计划模式/) && calls.length === 0, "问答 / 计划那一趟：照拒，不摆卡");
    ok(denied(await askVia(rec(true), "Write", { file_path: path.join(HOME, "外面2.txt"), content: "x" }), /越界/) && calls.length === 0, "工作区外写文件：直接拦，不摆卡");

    // 改文件：卡上带 diff，问的时候文件一个字不动（改是 claude 批下来以后自己的事）
    const a = path.join(BASE, "a.md");
    fs.writeFileSync(a, "第一行\n旧的\n");
    const ed = await askVia(rec(true), "Edit", { file_path: a, old_string: "旧的", new_string: "新的" }, { sec: { permission_mode: "ask" } });
    ok(allowed(ed) && calls.length === 1 && calls[0].label === "改文件" && /任务_审\/a\.md$/.test(calls[0].text) && calls[0].verdict.ruleKey === "write:*",
      "★每步都问档改文件：去问★ 卡上是相对工作区的路径", calls.map((x) => ({ label: x.label, text: x.text, key: x.verdict.ruleKey })));
    ok(calls[0] && /-旧的/.test(calls[0].detail) && /\+新的/.test(calls[0].detail), "★改文件的卡带 diff★ 看着改了哪几行批", calls[0] && calls[0].detail);
    ok(fs.readFileSync(a, "utf8") === "第一行\n旧的\n", "问的时候只算 diff，文件一个字没动");
    const nw = await askVia(rec(true), "Write", { file_path: path.join(BASE, "新的.md"), content: "全新\n" }, { sec: { permission_mode: "ask" } });
    ok(allowed(nw) && calls[0] && /\+全新/.test(calls[0].detail), "新建文件：diff 里是整份新内容", calls[0] && calls[0].detail);
    const me = await askVia(rec(true), "MultiEdit", { file_path: a, edits: [{ old_string: "第一行", new_string: "头一行" }, { old_string: "旧的", new_string: "新的" }] }, { sec: { permission_mode: "ask" } });
    ok(allowed(me) && calls[0] && /-第一行/.test(calls[0].detail) && /\+头一行/.test(calls[0].detail) && /\+新的/.test(calls[0].detail), "MultiEdit：几处改动叠起来算 diff", calls[0] && calls[0].detail);
    const b = path.join(BASE, "b.bin");
    fs.writeFileSync(b, Buffer.from([0x41, 0, 0x42]));
    const bin = await askVia(rec(true), "Edit", { file_path: b, old_string: "A", new_string: "C" }, { sec: { permission_mode: "ask" } });
    ok(allowed(bin) && calls.length === 1 && calls[0].detail === "", "二进制文件：算不出 diff 就空着，卡照摆、照样能批", calls.map((x) => x.detail));
    ok(allowed(await askVia(rec(false), "Write", { file_path: path.join(BASE, "c.md"), content: "x" })) && calls.length === 0, "自动改文件档写工作区：不用问，不摆卡");
    ok(allowed(await askVia(rec(false), "Bash", { command: "rm -rf build" }, { sec: { gateway: false } })) && calls.length === 0, "闸门关了：rm 不问（跟内置那边一样）");
    const er = await askVia(rec(new Error("卡摆不出来")), "Bash", { command: "rm -rf build" });
    ok(denied(er, /审批这一步出了错（卡摆不出来）/), "★摆卡出错：按拒★ 原话带上", er);

    const rows = security.auditList(500).filter((r) => r.type === "命令审批" && r.text === "rm -rf build");
    ok(rows.some((r) => r.action === "等待审批") && rows.some((r) => r.action === "已批准") && rows.some((r) => r.action === "已拒绝") && !rows.some((r) => /这一趟没法问人/.test(r.action)),
      "审计：等待审批、已批准、已拒绝各记一笔；问得着就不记「这一趟没法问人」", rows.map((r) => r.action));
  }

  section("⑩ cardAsk：摆的卡跟内置那张一样（来源、谁的、哪条对话、等多久）；叫停了不摆、摆了也收；别人批不了");
  {
    const v = { action: "ask", rule: "删除保护（rm 类命令需审批）", ruleKey: "rm", seg: "rm -rf build", blacklist: false };
    const ac = new AbortController();
    const mk = (s, deadline, signal = ac.signal) => approve.cardAsk({ sec: sec(s), signal, deadline, source: "整理", owner: "alice", sessionId: "s1" });
    const got = [];
    const realReq = security.requestApproval;
    security.requestApproval = (kind, text, o) => { got.push({ kind, text, o }); return Promise.resolve(true); };
    try {
      await mk({ approval_timeout_s: 30 })(v, "命令", "rm -rf build", "");
      await mk({})(v, "命令", "rm -rf build", "");
      await mk({}, () => Date.now() + 20000)(v, "命令", "rm -rf build", "");
      await mk({}, () => Date.now() + 3000)(v, "命令", "rm -rf build", "");
      const t = got.map((x) => x.o.timeoutMs);
      ok(t[0] === 30000 && t[1] === 120000 && Math.abs(t[2] - 10000) <= 300 && t[3] === 5000,
        "★等多久跟内置那张一样★ 照设置里的等待时长；快到这一趟的时限就提前收（留 10 秒），最少 5 秒", t);
      const g = got[0];
      ok(g.kind === "命令执行" && g.text === "rm -rf build" && g.o.rule === v.rule && g.o.ruleKey === "rm" && g.o.seg === "rm -rf build" && g.o.source === "整理"
        && g.o.owner === "alice" && g.o.sessionId === "s1" && g.o.stopSignal === ac.signal && g.o.blacklist === false && g.o.detail === "",
        "卡上的字段跟内置那张一样：哪类、哪条命令、哪条规则、哪一段、哪个任务、谁的、哪条对话；叫停接上", { kind: g.kind, text: g.text, o: { ...g.o, stopSignal: g.o.stopSignal === ac.signal } });
      await mk({})({ action: "ask", rule: "写文件 任务_审/x.md", ruleKey: "", seg: "", blacklist: true }, "改文件", "任务_审/x.md", "--- diff");
      const w = got[got.length - 1];
      ok(w.kind === "改文件执行" && w.o.blacklist === true && w.o.ruleKey === "" && w.o.detail === "--- diff", "改文件的卡：diff 带上；碰了黑名单的标出来", w);
      const pre = new AbortController();
      pre.abort();
      const n0 = got.length;
      const r0 = await mk({}, undefined, pre.signal)(v, "命令", "rm -rf build", "");
      ok(r0 === false && got.length === n0, "★已经叫停了：不摆卡，直接当没批★", { r0, asked: got.length - n0 });
    } finally { security.requestApproval = realReq; }

    // 真摆一张（不打桩）：当场挂出来、只有发起的人看得见、别人批不了；叫停了卡收掉
    const ac1 = new AbortController();
    const p1 = approve.cardAsk({ sec: sec(), signal: ac1.signal, source: "整理", owner: "alice", sessionId: "s1" })(v, "命令", "rm -rf build", "");
    const c1 = security.listApprovals().find((x) => x.text === "rm -rf build");
    ok(c1 && c1.persistable === true && c1.source === "整理" && c1.sessionId === "s1", "★卡当场挂出来★ 删除保护这类能「以后都放」", c1);
    ok(security.listApprovals("alice").length === 1 && security.listApprovals("bob").length === 0, "只有发起的人看得见");
    const fb = security.resolveApproval(c1 && c1.id, true, "once", "bob");
    ok(fb && fb.ok === false && fb.forbidden === true, "★别人批不了这张卡★", fb);
    ac1.abort();
    ok((await p1) === false && security.listApprovals().length === 0, "★叫停：卡收掉，按没批★", security.listApprovals());
    const ac2 = new AbortController();
    const p2 = approve.cardAsk({ sec: sec(), signal: ac2.signal, owner: "alice" })(v, "命令", "rm -rf dist", "");
    const c2 = security.listApprovals().find((x) => x.text === "rm -rf dist");
    const r2 = security.resolveApproval(c2 && c2.id, true, "once", "alice");
    ok(r2 && r2.ok === true && (await p2) === true, "发起的人自己批：放", r2);
  }

  section("⑪ 口子上的审批（tool-relay）：不看借出去的名单；凭据、叫停、超时、收工照拒；判的时候带着开口子时那份上下文");
  {
    const relayMod = require(mod("tool-relay"));
    const errOf = (p) => p.then(() => null, (e) => e);
    const REQ = { tool_name: "Bash", input: { command: "rm -rf build" }, tool_use_id: "u1" };
    const MARK = { behavior: "allow", updatedInput: { command: "rm -rf build", mark: 1 } };
    const exec = async () => ({ content: "借的工具跑了", isError: false });
    const relays = [];
    const open = async (o) => { const r = await relayMod.open({ exec, ...o }); relays.push(r); return r; };
    /** 等人点的那张卡：记下叫停开关，叫停了回拒 */
    let jsig = null;
    const waiter = (req, { signal }) => new Promise((resolve) => {
      jsig = signal;
      signal.addEventListener("abort", () => resolve({ behavior: "deny", message: "卡收了" }), { once: true });
    });
    try {
      let seenReq = null, abortedAtCall = null;
      const r = await open({ approve: async (req, { signal }) => { seenReq = req; abortedAtCall = signal.aborted; return MARK; } });
      const e0 = await errOf(relayMod.call(r.ticketFile, "remember", { x: 1 }));
      ok(e0 && /主进程这边还没准备好/.test(e0.message), "借工具：名单还没定时一律拒", e0 && e0.message);
      const v0 = await relayMod.approval(r.ticketFile, REQ);
      ok(JSON.stringify(v0) === JSON.stringify(MARK) && JSON.stringify(seenReq) === JSON.stringify(REQ) && abortedAtCall === false,
        "★审批不看借出去的名单★ 名单没定也照问；claude 递的请求原样交给判的那头，判词原样回", { v0, seenReq, abortedAtCall });
      r.allow([]);
      const e1 = await errOf(relayMod.call(r.ticketFile, "remember", {}));
      ok(e1 && /没有借给本机引擎/.test(e1.message), "反向对照：借工具照看名单（空名单一个都不借）", e1 && e1.message);
      const forged = path.join(HOME, "假凭据");
      fs.writeFileSync(forged, JSON.stringify({ sock: r.sock, ticket: "0".repeat(64) }));
      const e2 = await errOf(relayMod.approval(forged, REQ));
      ok(e2 && /凭据对不上/.test(e2.message) && !e2.connect, "★凭据对不上：拒★ 连上了就不算连不上（桥不会退回自己判）", e2 && { m: e2.message, c: e2.connect });
      const e3 = await errOf(relayMod.approval(path.join(HOME, "没有这个凭据"), REQ));
      ok(e3 && /凭据文件读不出来/.test(e3.message) && e3.connect === true, "凭据文件没了：报连不上（桥退回自己照规则判）", e3 && { m: e3.message, c: e3.connect });
      const pre = new AbortController();
      pre.abort();
      const e4 = await errOf(relayMod.approval(r.ticketFile, REQ, { signal: pre.signal }));
      ok(e4 && e4.message === "已叫停，没有发出去" && !e4.connect, "桥这头已经叫停：不发", e4 && e4.message);
      const nj = await open({});
      const e5 = await errOf(relayMod.approval(nj.ticketFile, REQ));
      ok(e5 && e5.message === "这一趟没开审批，没有执行", "★没开审批的口子：审批一律拒★（借工具的口子不顺带收审批）", e5 && e5.message);
      const th = await open({ approve: async () => { throw new Error("判不动了"); } });
      const e6 = await errOf(relayMod.approval(th.ticketFile, REQ));
      ok(e6 && e6.message === "判不动了" && !e6.connect, "判的时候抛错：原话交回去（桥那头按拒）", e6 && e6.message);

      const stop = new AbortController();
      const w = await open({ approve: waiter, stopSignal: stop.signal });
      const cac = new AbortController();
      jsig = null;
      const pw = errOf(relayMod.approval(w.ticketFile, REQ, { signal: cac.signal }));
      await waitFor(() => jsig);
      cac.abort();
      const e7 = await pw;
      const gone = await waitFor(() => jsig && jsig.aborted);
      ok(e7 && e7.message === "已叫停" && gone === true, "★桥那头不等了：断开，主进程那张卡跟着收★", e7 && e7.message);
      jsig = null;
      const pw2 = relayMod.approval(w.ticketFile, REQ).catch((err) => ({ error: err.message }));
      await waitFor(() => jsig);
      stop.abort();
      const v2 = await pw2;
      ok(jsig && jsig.aborted && denied(v2, /卡收了/), "★整趟叫停：手上那张卡收掉，判词照回（拒）★", v2);
      const e8 = await errOf(relayMod.approval(w.ticketFile, REQ));
      ok(e8 && /已经叫停/.test(e8.message), "叫停以后再问：拒", e8 && e8.message);
      const late = await open({ approve: async () => MARK, deadline: () => Date.now() - 1 });
      const e9 = await errOf(relayMod.approval(late.ticketFile, REQ));
      ok(e9 && /已经超时/.test(e9.message), "这一趟超时了：拒", e9 && e9.message);

      jsig = null;
      const cl = await open({ approve: waiter });
      const pw3 = relayMod.approval(cl.ticketFile, REQ).catch((err) => ({ error: err.message }));
      await waitFor(() => jsig);
      await cl.close();
      const v3 = await pw3;
      ok(jsig && jsig.aborted && (denied(v3) || (v3 && v3.error)), "★收工时还在等的那张：卡收掉★ 那头拿到拒或者断开", v3);
      const e10 = await errOf(relayMod.approval(cl.ticketFile, REQ));
      ok(e10 && e10.connect === true, "收工以后：凭据吊销，报连不上", e10 && { m: e10.message, c: e10.connect });

      const { AsyncLocalStorage } = require("async_hooks");
      const als = new AsyncLocalStorage();
      const ctx = await als.run({ who: "alice" }, () => open({ approve: async () => ({ behavior: "allow", updatedInput: { who: (als.getStore() || {}).who || "" } }) }));
      const v4 = await als.run({ who: "bob" }, () => relayMod.approval(ctx.ticketFile, REQ));
      ok(v4 && v4.updatedInput && v4.updatedInput.who === "alice", "★判的时候带着开口子时那份上下文★（这一趟是谁在跑，不是连进来的那头）", v4);
    } finally { for (const r of relays) await r.close(); }
  }

  section("⑫ 桥连回主进程问：判词原样交给 claude；看不懂的、判挂的按拒；claude 不等了、桥被叫停，卡跟着收；连不上才退回桥里照规则判");
  {
    const relayMod = require(mod("tool-relay"));
    const H = path.join(HOME, "桥审");
    fs.mkdirSync(H, { recursive: true });
    const cfgFile = path.join(H, "config.json");
    fs.writeFileSync(cfgFile, "{}");
    const MARK = { behavior: "allow", updatedInput: { command: "rm -rf build", mark: 1 } };
    let judge = async () => MARK;
    const r = await relayMod.open({ exec: async () => ({ content: "", isError: false }), approve: (req, o) => judge(req, o) });
    r.allow([]);
    const common = { home: H, root: ROOT, baseDir: "任务_审", tools: [], approve: true };
    const att = bridge.attach("claude-code", { ...common, approveFile: r.ticketFile });
    const noFile = bridge.attach("claude-code", common);
    const cx = bridge.attach("codex", { ...common, approveFile: r.ticketFile });
    const lost = bridge.attach("claude-code", { ...common, approveFile: path.join(H, "没有这个凭据") });
    try {
      ok(serverOf(att).env[relayMod.APPROVE_ENV] === r.ticketFile && att.askHuman === true, "★给了凭据文件：MCP 那台带上，标明这一趟问得着人★", { env: serverOf(att).env, askHuman: att.askHuman });
      ok(noFile.approve === true && noFile.askHuman === false && !(relayMod.APPROVE_ENV in serverOf(noFile).env), "没给凭据文件：审批照挂（桥里照规则判），但问不着人", { askHuman: noFile.askHuman });
      ok(cx.approve === false && cx.askHuman === false && !cx.runOpts.mcpArgs.some((x) => /APPROVE/.test(x)), "codex：给了也不挂", cx.runOpts.mcpArgs.filter((x) => /env=/.test(x)));
      if (SH && att.shim) ok(!fs.readFileSync(att.shim, "utf8").includes(relayMod.APPROVE_ENV), "owb 脚本里没有审批凭据：命令行那条路问不着主进程");

      const lv = mcpLive(serverOf(att));
      try {
        const a = verdictOf(await lv.send(callApprove("Bash", { command: "rm -rf build" })));
        ok(JSON.stringify(a) === JSON.stringify(MARK), "★主进程的判词原样交给 claude★", a);
        fs.writeFileSync(cfgFile, "{ 坏");
        const b = verdictOf(await lv.send(callApprove("Bash", { command: "rm -rf build" })));
        ok(JSON.stringify(b) === JSON.stringify(MARK), "交回主进程以后：桥自己读的设置文件坏了也不碍事（判的是主进程那份）", b);
        fs.writeFileSync(cfgFile, "{}");
        judge = async () => ({ foo: 1 });
        const c = verdictOf(await lv.send(callApprove("Bash", { command: "rm -rf build" })));
        ok(denied(c, /看不懂/), "主进程回的不是批 / 拒：按拒", c);
        judge = async () => { throw new Error("判不动了"); };
        const d = verdictOf(await lv.send(callApprove("Bash", { command: "rm -rf build" })));
        ok(denied(d, /审批这一步没走完（判不动了）/), "★主进程判挂了：按拒★ 原话带上，不退回桥里自己判", d);
        let jsig = null;
        judge = (req, { signal }) => new Promise((resolve) => {
          jsig = signal;
          signal.addEventListener("abort", () => resolve({ behavior: "deny", message: "卡收了" }), { once: true });
        });
        const rid = lv.nextId();
        const pe = lv.send(callApprove("Bash", { command: "rm -rf build" }));
        await waitFor(() => jsig);
        lv.notify({ method: "notifications/cancelled", params: { requestId: rid } });
        const e = verdictOf(await pe);
        const gone = await waitFor(() => jsig && jsig.aborted);
        ok(gone === true && denied(e, /已叫停/), "★claude 不等了（notifications/cancelled）：主进程那张卡收掉★ 回的是拒", e);
      } finally { lv.close(); fs.writeFileSync(cfgFile, "{}"); }

      if (SH) {
        let jsig2 = null;
        judge = (req, { signal }) => new Promise((resolve) => {
          jsig2 = signal;
          signal.addEventListener("abort", () => resolve({ behavior: "deny", message: "卡收了" }), { once: true });
        });
        const lv2 = mcpLive(serverOf(att));
        try {
          const pk = lv2.send(callApprove("Bash", { command: "rm -rf build" }));
          await waitFor(() => jsig2);
          lv2.kill("SIGTERM");
          const k = await pk;
          const kv = k.res ? verdictOf(k) : null;
          const gone = await waitFor(() => jsig2 && jsig2.aborted);
          const exited = await waitFor(() => lv2.exited(), 5000);
          ok(gone === true && (kv === null || denied(kv)) && exited === true, "★桥被叫停（SIGTERM）：手上那张卡收掉，桥自己走人★", { kv, exited });
        } finally { lv2.close(); }
      }

      const [lr, ln] = mcpRun(serverOf(lost), [callApprove("Bash", { command: "rm -rf build" }), callApprove("Bash", { command: "npm test" })]).map(verdictOf);
      ok(denied(lr, /这一趟没法问他/) && allowed(ln), "★连不上主进程（凭据文件没了）：退回桥里照规则判★ 要人点头的照拒，别的照放", { lr, ln });
    } finally { att.cleanup(); noFile.cleanup(); cx.cleanup(); lost.cleanup(); await r.close(); }
  }

  if (SH) {
    section("⑬ claude 的命令行：「先问」写成 --settings；这版不认、或没挂审批，要问的并回直接禁");
    const claude = require(mod("claude-code"));
    const argvFile = path.join(HOME, "argv13.json");
    // 假 claude：--help 印给定的帮助（探 --add-dir、--settings 认不认），--version 印版本，别的把参数记下来
    const mkFake = (file, help) => {
      fs.writeFileSync(file, [
        "#!/usr/bin/env node",
        'const fs = require("fs");',
        "const argv = process.argv.slice(2);",
        `if (argv.includes("--help")) { process.stdout.write(${JSON.stringify(help)}); process.exit(0); }`,
        'if (argv.includes("--version")) { process.stdout.write("2.1.300 (Claude Code)\\n"); process.exit(0); }',
        `fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));`,
        'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: {} }) + "\\n");',
      ].join("\n"));
      fs.chmodSync(file, 0o755);
      return file;
    };
    // 两个新文件名：探测结果按路径缓存，跟 ④⑤ 那个假 claude 分开
    const fakeNew = mkFake(path.join(HOME, "claude-new"), "Usage: claude [options]\n  --add-dir <directories...>\n  --settings <file-or-json>\n");
    const fakeOld = mkFake(path.join(HOME, "claude-old"), "Usage: claude [options]\n  --add-dir <directories...>\n");
    const cfg = path.join(HOME, "mcp13.json");
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
    const G = { claudeMode: "acceptEdits", allowShim: true, disallow: ["Bash(foo:*)"], ask: ["Bash(rm:*)", "Bash(rmdir:*)"] };
    const full = { mcpConfigPath: cfg, mcpServerNames: ["openworkbuddy"], permissionPromptTool: TOOL, guard: G };
    const argvOf = async (bin, o) => {
      fs.rmSync(argvFile, { force: true });
      await claude.run({ prompt: "hi", cwd: BASE, bin, model: "sonnet", ...o });
      return JSON.parse(fs.readFileSync(argvFile, "utf8"));
    };
    const a1 = await argvOf(fakeNew, full);
    ok(JSON.stringify(pairsOf(a1, "--settings")) === JSON.stringify([JSON.stringify({ permissions: { ask: G.ask } })]) && JSON.stringify(pairsOf(a1, "--disallowed-tools")) === JSON.stringify(["Bash(foo:*)"]),
      "★挂了审批、这版认 --settings：rm、rmdir 写成「先问」★ 直接禁的只剩本来就禁的", a1);
    const a2 = await argvOf(fakeOld, full);
    ok(!a2.includes("--settings") && JSON.stringify(pairsOf(a2, "--disallowed-tools")) === JSON.stringify(["Bash(foo:*)", "Bash(rm:*)", "Bash(rmdir:*)"]),
      "★这版不认 --settings：要问的并回直接禁★ 一条不漏（发了会被悄悄吞掉，等于全放）", a2);
    const a3 = await argvOf(fakeNew, { ...full, permissionPromptTool: "" });
    ok(!a3.includes("--settings") && pairsOf(a3, "--disallowed-tools").includes("Bash(rm:*)"), "没挂审批工具：问不着，并回直接禁", a3);
    const a4 = await argvOf(fakeNew, { guard: G });
    ok(!a4.includes("--settings") && !a4.includes("--permission-prompt-tool") && pairsOf(a4, "--disallowed-tools").includes("Bash(rmdir:*)"), "没挂 MCP：同上", a4);
    const a5 = await argvOf(fakeNew, { ...full, guard: { ...G, ask: [] } });
    ok(!a5.includes("--settings") && JSON.stringify(pairsOf(a5, "--disallowed-tools")) === JSON.stringify(["Bash(foo:*)"]), "没有要问的：不带 --settings", a5);
  } else console.log("\n（Windows：跳过 ⑬ 的假 claude）");

  section("⑭ 安全设置那几句：名单翻成 claude 的禁 / 问、运行页那句、没批下来时说去哪放行（设置里没地方的就不指）");
  {
    const heads = (g) => g.disallow.map((x) => (/^Bash\((.+):\*\)$/.exec(x) || [])[1]);
    const g0 = security.engineGuard(sec(), { canAsk: true });
    ok(heads(g0).includes("rm") && heads(g0).includes("rmdir") && heads(g0).includes("sudo"), "默认：询问名单、删除保护（rm、rmdir）都翻成禁", g0.disallow);
    const nd = security.engineGuard(sec({ delete_protect: false }), { canAsk: true });
    ok(!heads(nd).includes("rm") && !heads(nd).includes("rmdir") && heads(nd).includes("sudo"), "★关了删除保护：rm、rmdir 不再禁★ 询问名单照旧", nd.disallow);
    ok(security.engineGuard(sec({ permission_mode: "full" }), { canAsk: true }).disallow.length === 0, "全自动档：一条都不禁");
    const LIST = heads(g0).join("、");
    const TIP = "想让它先问你：设置 → 智能体 → 底层引擎，勾「删文件等操作先问我」";
    ok(g0.note === `按你的安全设置，本机 Claude Code 这一趟不跑：${LIST}。${TIP}。`, "claude 没开审批：运行页说这一趟不跑哪些、勾哪颗能改成先问", g0.note);
    const plain = security.engineGuard(sec());
    ok(plain.note === `按你的安全设置，本机 CLI 不许自己跑这些命令：${LIST}（这条路没有审批通道，只能直接禁）。`, "codex（真没有审批通道）：照旧这么说", plain.note);
    const askN = security.engineGuard(sec({ permission_mode: "ask" }), { canAsk: true }).note;
    ok(askN === `安全档位是「每步都问」，本机 Claude Code 这一趟没开审批，要写文件或跑命令会被直接拒。${TIP}。`, "每步都问档、claude 没开审批：照实说会被直接拒、勾哪颗", askN);
    security.setMultiUser(() => true);
    try {
      const mu = security.engineGuard(sec(), { canAsk: true }).note;
      ok(mu.endsWith(`${TIP}（多人共用时只有平台管理员能改）。`), "多人共用：说明只有平台管理员能改", mu);
      ok(security.wayOut(security.checkCommand(sec(), "rm -rf build")).endsWith("加一行 rm（多人共用时只有平台管理员能改）"), "多人共用：去哪放行那句也说明谁能改");
    } finally { security.setMultiUser(null); }

    const ag = security.askingGuard(g0);
    ok(JSON.stringify(ag.ask) === JSON.stringify(g0.disallow) && ag.disallow.length === 0 && ag.note === "", "★审批交回主进程：要禁的整个改成「先问」★ 运行页不再说「这一趟不跑」", ag);
    ok(security.askingGuard(security.engineGuard(sec({ permission_mode: "ask" }))).note === "", "每步都问档 + 交回主进程：不说「会被直接拒」（现在会弹卡）");
    ok(/只看不动/.test(security.askingGuard(security.engineGuard(sec({ permission_mode: "plan" }))).note), "只看不动档：那句照说（能问了也还是只读）");
    const ro = security.askingGuard(security.readOnlyGuard(g0));
    ok(Array.isArray(ro.ask) && ro.ask.length === 0 && ro.readOnly === true, "问答 / 计划那一趟：不挂「先问」（本来就只读）", ro);

    const W = (rule, ruleKey, extra = {}) => security.wayOut({ rule, ruleKey, ...extra });
    ok(W("删除保护（rm 类命令需审批）", "rm") === "到 设置 → 安全 →「数据安全」关掉「删除保护」，或者在「沙箱安全 · 命令」的「放行名单」加一行 rm", "删除保护：指到「数据安全」那颗开关，或者放行名单加 rm");
    ok(W("命令询问名单「sudo」", "sudo") === "到 设置 → 安全 →「沙箱安全 · 命令」，把它从「询问名单」删掉，或者加进「放行名单」", "询问名单：从询问名单删掉，或者加进放行名单");
    ok(W("每步都问模式", "ls") === "到 设置 → 安全 →「权限档位」选「自动改文件」" && W("写文件 任务_审/x.md", "write:*") === "到 设置 → 安全 →「权限档位」选「自动改文件」", "每步都问、写文件：指到「权限档位」");
    ok(W("网络访问需审批", "curl") === "到 设置 → 安全 →「沙箱安全 · 命令」的「放行名单」加上这类命令", "别的能记住的：放行名单加上这类");
    const none = [W("高危命令：git 强推会改写远端历史", "danger:git-force-push"), W("命令碰到了文件黑名单（~/.ssh）", "", { blacklist: true }), W("代码里开子进程", "code:child_process"), W("说不清", ""), security.wayOut(null), security.wayOut({})];
    ok(none.every((x) => x === ""), "★设置里没地方放行的（高危、黑名单、代码开子进程、没有规则键）：不指路★ 指过去用户翻遍了也找不到", none);

    // 内置引擎那张卡没批下来时的话：能放行的说去哪放，放不了的说只能当场批
    const tools = require(mod("tools"));
    const realReq = security.requestApproval;
    security.requestApproval = async () => false;
    try {
      const run = (command) => tools.executeTool("run_shell", { command }, { security: sec() });
      const sql = await run('echo "drop table t_不存在"');
      ok(sql.isError && /未获批准/.test(sql.content) && /让用户决定/.test(sql.content) && /命令行里跑可以加 --allow/.test(sql.content) && !/预先放行这类：/.test(sql.content),
        "高危命令没批：设置里放不了，说让用户决定、命令行可以加 --allow", sql.content);
      const key = await run("ls ~/.ssh/owb-测试-不存在");
      ok(key.isError && /只能当场批/.test(key.content) && !/--allow/.test(key.content), "碰了黑名单没批：说只能当场批（--allow 也放不了）", key.content);
      const rmc = await run("rm -rf owb-不存在的目录");
      ok(rmc.isError && /或请用户预先放行这类：到 设置 → 安全 →「数据安全」关掉「删除保护」/.test(rmc.content), "rm 没批：说去哪关删除保护", rmc.content);
    } finally { security.requestApproval = realReq; }
    const fp = await ask("Bash", { command: "git push --force origin main" });
    ok(denied(fp, /让用户决定/) && !/告诉用户可以/.test(fp.message), "本机引擎没法问人、设置里又放不了的：说让用户决定，不编一个去处", fp);
  }
})().catch((e) => { fail++; console.log("  ❌ 套件自己崩了：" + ((e && e.stack) || e)); });
