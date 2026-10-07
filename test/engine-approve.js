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
 *   ⑦ 主进程真跑一趟（桩引擎）：开没开、哪种引擎、哪种模式，传下去的和提示词里说的对得上；设置页读得到这个开关
 *   ⑧ 服务端真存：起一台真的 server.js，属主勾上、去掉，config.json 跟着变
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

(async () => {
  section("① 判法：跟内置引擎 run_shell / 写文件 / fetch_url 同一套规则，只是没有「摆卡等人批」");
  {
    security.auditClear();
    // 命令：自动改文件档
    const ls = await ask("Bash", { command: "ls -la", description: "看一眼" });
    ok(allowed(ls) && ls.updatedInput.command === "ls -la" && ls.updatedInput.description === "看一眼", "名单外的普通命令放行，参数原样交回（不改写）", ls);
    ok(allowed(await ask("Bash", { command: "npm test" })), "跑测试这类放行：这正是以前被 claude 自己拒掉、模型反复换写法撞的那种");
    const sudo = await ask("Bash", { command: "sudo ls /" });
    ok(denied(sudo, /命令询问名单「sudo」/) && /没人能批/.test(sudo.message) && /被拒一次就别换个写法再试/.test(sudo.message), "★询问名单里的（sudo）照拒★ 说清是哪条、这条路没人能批、别换写法再撞", sudo);
    ok(/设置 → 安全中心/.test(sudo.message), "拒的话里告诉它用户能去哪放行", sudo.message);
    ok(denied(await ask("Bash", { command: "rm -rf build" }), /删除保护/), "★删除保护照拒★（rm 要人点头）");
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
    ok(denied(wAsk, /要人点头/) && /自动改文件/.test(wAsk.message), "每步都问档：写文件要人点头 → 拒，并说用户能把档位调到哪", wAsk);
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
    ok(has("命令审批", /sudo ls \//, "已拒绝（本机引擎这条路没人能批）"), "审计：要人点头的命令记「已拒绝（本机引擎这条路没人能批）」", rows.slice(0, 5));
    ok(has("命令执行", /^npm test$/, "放行（本机引擎）"), "审计：放行的命令也记一笔，标明是本机引擎");
    ok(has("命令拦截", /^ls$/, "拦截"), "审计：只看不动档拦下的命令");
    ok(has("文件拦截", /Write: .*外面\.txt/, "拦截"), "审计：越界的文件，带工具名");
    ok(has("改文件审批", /报告\.md/, "已拒绝（本机引擎这条路没人能批）"), "审计：每步都问档拒掉的写文件");
    ok(has("网络拦截", /127\.0\.0\.1/, "拦截") && has("网络访问", /1\.1\.1\.1/), "审计：抓网页拦了的、放了的都有");
    ok(has("本机引擎拦截", /SomeNewTool/, "拦截"), "审计：不认得的工具");
    ok(!rows.some((r) => r.action === "等待审批"), "没有一条「等待审批」：这条路不摆卡");
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
    const run = async (o) => {
      seen = { prompt: o.systemPrompt || "", tool: o.permissionPromptTool, env: null };
      if (o.mcpConfigPath) seen.env = JSON.parse(fs.readFileSync(o.mcpConfigPath, "utf8")).mcpServers[bridge.SERVER_NAME].env;
      return { finalText: "好", usage: {}, stopped: null, sessionId: null };
    };
    const withStub = async (id, { opts = {}, security: s, mode } = {}) => {
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
        await rt.runTask({ history: [{ role: "user", content: "干活" }], emit() {}, ...(mode ? { mode } : {}) });
        return seen || {};
      } finally {
        engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
        if (real) engines.BACKENDS.splice(i, 0, real);
      }
    };
    const on = await withStub("claude-code", { opts: { approval: true } });
    ok(on.tool === TOOL && on.env && on.env.OPENWORKBUDDY_BRIDGE_APPROVE === "1", "★属主开了：run() 拿到审批工具，桥那头开关也打开了★", { tool: on.tool, env: on.env });
    ok(/按安全中心的名单/.test(on.prompt) && /被拒一次就别换个写法再试/.test(on.prompt) && !/别的多半会被拒/.test(on.prompt),
      "提示词照实说：命令按名单裁决，不再说「别的多半会被拒」", (on.prompt.match(/.*自动改文件.*/g) || []).slice(0, 2));
    const off = await withStub("claude-code");
    ok(off.tool === undefined && off.env && !("OPENWORKBUDDY_BRIDGE_APPROVE" in off.env), "反向对照：没开就不传", { tool: off.tool, env: off.env });
    ok(/别的多半会被拒/.test(off.prompt), "反向对照：没开，提示词照旧说命令多半会被拒");
    const str = await withStub("claude-code", { opts: { approval: "true" } });
    ok(str.tool === undefined, "开关只认布尔 true（手写成字符串的不算）", str.tool);
    const ro = await withStub("claude-code", { opts: { approval: true, permissionPromptTool: "mcp__x__y" }, mode: "ask" });
    ok(ro.tool === undefined, "★问答那一趟：开了也不挂★ 属主手填的同名参数也盖回去", ro.tool);
    const cx = await withStub("codex", { opts: { approval: true } });
    ok(cx.tool === undefined && !(cx.env && "OPENWORKBUDDY_BRIDGE_APPROVE" in cx.env), "codex：开了也不挂", cx.tool);
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
})().catch((e) => { fail++; console.log("  ❌ 套件自己崩了：" + ((e && e.stack) || e)); });
