// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 本机引擎（claude / codex）出岔子的那几种时候：
 *
 *   ① claude 把「没登录 / 限流 / 续跑的会话找不到」写在 result 里、stderr 空着、退出码 1。
 *      以前只看 stderr，用户拿到的是「退出码 1 且没有任何输出」；is_error 但退出码 0 时，报错原文还被当成回答交出去
 *   ② 按停止要当场杀：AbortSignal 挂了监听，不等 2 秒一跳的轮询；连带引擎派生的孙进程一起收。
 *      killAll 给硬退出用（关终端、被 kill）：一把收掉还活着的每一个
 *   ③ 借给引擎的 MCP 配置、工具入口是临时目录（里面有 key）：进程直接 exit 也得删掉
 *   ④ 续跑 id 失效（记录过期、换了机器）：一个工具还没动过就摊平历史重开一根，新 id 记回去；
 *      动过工具、报的是别的错、没有续跑 id、已经按了停止——这四种都不许重来
 *   ⑥ codex：本项目的说明（工作目录、产出放哪）走 developer_instructions 交过去；
 *      自带生图出的图留在它自己的目录里、界面看不到——模型没放进对话目录就替它放
 *
 * 引擎全是本地假的，不出网。
 *   node test/engine-resilience.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { mod } = require("./lib/mod");
// 赶在 require 引擎 / agent 之前：不然单独跑时 trace 记进用户真在用的 workspace/（见 test/lib/own-home.js）
require("./lib/own-home")("engine-resilience");

const ROOT = path.join(__dirname, "..");

let pass = 0;
const ok = (cond, name, extra) => {
  assert.ok(cond, name + (extra !== undefined ? "\n" + (typeof extra === "string" ? extra : JSON.stringify(extra)) : ""));
  pass++;
  console.log("  ✅ " + name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(30); } return false; };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-engres-"));
/** 写一个假 claude：body 是它的 node 源码 */
function fakeBin(name, body) {
  const f = path.join(home, name);
  fs.writeFileSync(f, "#!/usr/bin/env node\n" + body);
  fs.chmodSync(f, 0o755);
  return f;
}
const line = (o) => `process.stdout.write(${JSON.stringify(JSON.stringify(o) + "\n")});`;

async function partResultErrors() {
  console.log("\n— ① result 里报的错 —");
  const claude = require(mod("claude-code"));
  const tryRun = async (bin) => { try { return { r: await claude.run({ prompt: "hi", cwd: home, bin }) }; } catch (e) { return { e }; } };

  {
    const bin = fakeBin("cc-nologin", line({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }) + "process.exitCode = 1;");
    const { r, e } = await tryRun(bin);
    ok(e && /还没登录/.test(e.message), "★没登录写在 result 里、stderr 空着★ 报的是「还没登录」", e ? e.message : r);
    ok(e && !/没有任何输出/.test(e.message), "不再是「退出码 1 且没有任何输出」", e && e.message);
  }
  {
    const bin = fakeBin("cc-stale", line({ type: "result", subtype: "success", is_error: true, result: "No conversation found with session ID: 0000-dead" }) + "process.exitCode = 1;");
    const { e } = await tryRun(bin);
    ok(e && /No conversation found/.test(e.message), "认不出的错原文带出来（续跑重开靠这句认人）", e && e.message);
  }
  {
    const bin = fakeBin("cc-err0", line({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded" }));
    const { r, e } = await tryRun(bin);
    ok(e && /529/.test(e.message), "★is_error 但退出码 0★ 也按出错报，不把报错当成回答交出去", e ? e.message : r);
  }
  {
    const bin = fakeBin("cc-ok", line({ type: "result", subtype: "success", is_error: false, result: "做完了" }));
    const { r, e } = await tryRun(bin);
    ok(!e && r.finalText === "做完了", "反向对照：正常的 result 照常交回答", e ? e.message : r);
  }
  {
    const bin = fakeBin("cc-maxturns", line({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 7, result: "" }));
    const { r, e } = await tryRun(bin);
    ok(!e && /最大步数/.test(r.stopped || ""), "反向对照：跑满步数还是「撞上限」，不当报错抛", e ? e.message : r);
  }
}

async function partWriteHints() {
  console.log("\n— ⑤ 点名写的文件报上去（几条对话共用一趟扫描时靠它认主）—");
  const claude = require(mod("claude-code"));
  const codex = require(mod("codex"));
  const tool = (name, input) => line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t-" + name, name, input }] } });
  const bin = fakeBin("cc-write",
    tool("Write", { file_path: "汇总.csv", content: "a" }) +
    tool("Edit", { file_path: path.join(home, "任务_x", "报告.md"), old_string: "a", new_string: "b" }) +
    tool("Bash", { command: "echo hi > 顺手.txt" }) +
    tool("Read", { file_path: "别的.md" }) +
    line({ type: "result", subtype: "success", is_error: false, result: "好了" }));
  const got = [];
  const r = await claude.run({ prompt: "hi", cwd: home, bin, onWrite: (p) => got.push(p) });
  ok(r.finalText === "好了" && same(got, [path.join(home, "汇总.csv"), path.join(home, "任务_x", "报告.md")]),
    "claude：Write / Edit 点名的文件按工作目录解析成绝对路径报上来，Bash、Read 不算", got);
  const none = await claude.run({ prompt: "hi", cwd: home, bin });
  ok(none.finalText === "好了", "不传 onWrite 照常跑（不是每个调用方都要）");
  ok(same(codex.changedPaths({ type: "file_change", changes: [{ path: "a.md", kind: "add" }, { path: "/abs/b.md" }, {}] }, home), [path.join(home, "a.md"), "/abs/b.md"]),
    "codex：file_change 里改的文件按工作目录解析，缺路径的跳过");
  ok(same(codex.changedPaths({ type: "command_execution", command: "touch c.md" }, home), []), "codex：跑命令这种不算点名写");
}

async function partCodexImages() {
  console.log("\n— ⑥ codex：说明交过去，自带生图出的图放进对话目录 —");
  const codex = require(mod("codex"));
  const NOTE = JSON.parse(codex.instructionsPlan("", null, "darwin").args[1].replace(/^developer_instructions=/, ""));
  const decoded = (argv) => { const a = argv.find((x) => x.startsWith("developer_instructions=")); return a ? JSON.parse(a.slice("developer_instructions=".length)) : null; };

  // 假 codex：记下参数和 stdin，按 FAKE_MODE 出图 / 自己把图复制进工作目录 / 报失败
  const bin = fakeBin("codex-img", `
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] === "debug") process.exit(1);
let input = "";
process.stdin.on("data", (d) => { input += d; }).on("end", () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, stdin: input }));
  const tid = process.env.FAKE_THREAD, mode = process.env.FAKE_MODE || "";
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "thread.started", thread_id: tid });
  out({ type: "turn.started" });
  const dir = path.join(process.env.CODEX_HOME, "generated_images", tid);
  const n = /gen2/.test(mode) ? 2 : /gen/.test(mode) ? 1 : 0;
  for (let i = 1; i <= n; i++) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "exec-" + i + ".png"), "PNG-" + tid + "-" + i);
  }
  if (/copied/.test(mode)) fs.copyFileSync(path.join(dir, "exec-1.png"), path.join(process.cwd(), "夜景.png"));
  out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "图好了" } });
  if (/fail/.test(mode)) { out({ type: "turn.failed", error: { message: "上游断了" } }); process.exit(1); }
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
});
`);
  const srcHome = path.join(home, "codex-src"); // 没有 auth.json：不去碰用户真的 ~/.codex
  fs.mkdirSync(srcHome, { recursive: true });
  const logFile = path.join(home, "codex-img.json");
  let seq = 0;
  const go = async ({ mode = "", thread, resumeId = null, systemPrompt = "", extraArgs = [] }) => {
    const cwd = path.join(home, "对话-" + (++seq));
    fs.mkdirSync(cwd, { recursive: true });
    const wrote = [], evs = [];
    let r = null, err = null;
    try {
      r = await codex.run({
        prompt: "画一张深圳夜景", cwd, bin, resumeId, systemPrompt, extraArgs,
        env: { CODEX_HOME: srcHome, FAKE_LOG: logFile, FAKE_THREAD: thread, FAKE_MODE: mode },
        emit: (e) => evs.push(e), onWrite: (p) => wrote.push(p),
      });
    } catch (e) { err = e; }
    const log = JSON.parse(fs.readFileSync(logFile, "utf8"));
    const imgs = fs.readdirSync(cwd).filter((n) => /^codex-image-\d{4}-\d{6}(_\d+)?\.png$/.test(n)).sort();
    const status = evs.filter((e) => e.type === "status").map((e) => e.text).join("\n");
    return { cwd, r, err, log, imgs, wrote, status };
  };
  const genDir = (tid) => path.join(process.env.OPENWORKBUDDY_HOME, "data", "runtime", "codex", "generated_images", tid);

  {
    const sp = "工作目录是 /x/任务_1，产出文件都写在这里。\n引号\"、反斜杠\\、制表\t都原样";
    const A = await go({ mode: "gen", thread: "th-a", systemPrompt: sp, extraArgs: ["-c", 'developer_instructions="用户自己填的"'] });
    ok(!A.err && A.r.finalText === "图好了", "跑通", A.err && A.err.message);
    ok(decoded(A.log.argv) === sp + "\n\n" + NOTE, "★系统提示交给 codex 了★ 以前这条路压根没接，codex 不知道产出放哪", A.log.argv);
    const mine = A.log.argv.findIndex((x) => x.startsWith("developer_instructions="));
    ok(mine >= 0 && mine < A.log.argv.indexOf('developer_instructions="用户自己填的"'), "排在设置里手填的参数前面（后出现的覆盖前面的，手填的为准）", A.log.argv);
    ok(A.log.stdin === "画一张深圳夜景", "走参数时提示词原样，不重复拼说明", A.log.stdin);
    ok(A.imgs.length === 1 && fs.readFileSync(path.join(A.cwd, A.imgs[0]), "utf8") === "PNG-th-a-1",
      "★模型没放进对话目录 → 替它放★ 用户这才在成果栏里看得到、点得开预览", A.imgs);
    ok(same(A.wrote, [path.join(A.cwd, A.imgs[0])]), "放进去的图按写文件报上去（产出卡靠这个认主）", A.wrote);
    ok(/已放进对话目录/.test(A.status) && A.status.includes(A.imgs[0]), "界面上说一声放到哪了", A.status);
  }
  {
    const B = await go({ mode: "gen copied", thread: "th-b" });
    ok(!B.err && B.imgs.length === 0 && B.wrote.length === 0 && fs.existsSync(path.join(B.cwd, "夜景.png")),
      "★模型自己复制过 → 不再放一份★ 反向对照：不然对话目录里一张图两份", fs.readdirSync(B.cwd));
    ok(!/已放进对话目录/.test(B.status), "这时也不多嘴", B.status);
  }
  {
    const C = await go({ mode: "gen2", thread: "th-c" });
    const got = C.imgs.map((n) => fs.readFileSync(path.join(C.cwd, n), "utf8")).sort();
    ok(same(got, ["PNG-th-c-1", "PNG-th-c-2"]) && C.wrote.length === 2, "一趟出了两张：两张都放、不互相覆盖", C.imgs);
  }
  {
    // 续跑的线程：上一轮的旧图还在线程目录里；另一条对话的线程刚出了图
    fs.mkdirSync(genDir("th-d"), { recursive: true });
    const old = path.join(genDir("th-d"), "exec-old.png");
    fs.writeFileSync(old, "PNG-old");
    const t = new Date(Date.now() - 3600e3);
    fs.utimesSync(old, t, t);
    fs.mkdirSync(genDir("th-other"), { recursive: true });
    fs.writeFileSync(path.join(genDir("th-other"), "exec-9.png"), "PNG-other");
    const D = await go({ thread: "th-d", resumeId: "th-d", systemPrompt: "说明" });
    ok(!D.err && D.imgs.length === 0 && D.wrote.length === 0, "★上一轮的旧图、别的对话线程的图都不捡★", fs.readdirSync(D.cwd));
    ok(D.log.argv.includes("resume") && decoded(D.log.argv) === "说明\n\n" + NOTE, "续跑也带说明（-c 两条路都收）", D.log.argv);
  }
  {
    const E = await go({ mode: "gen fail", thread: "th-e" });
    ok(E.err && /上游断了/.test(E.err.message), "这一轮失败照常报错", E.err && E.err.message);
    ok(E.imgs.length === 1 && E.wrote.length === 1, "★失败了出过的图也放进来★ 订阅额度已经花掉了", E.imgs);
  }

  // 说明怎么交：参数 / 拼进提示词
  const W = codex.instructionsPlan("说明", null, "win32");
  ok(W.args.length === 0 && W.prefix === "说明\n\n" + NOTE + "\n\n---\n\n", "Windows（.cmd 垫片过 cmd.exe）：拼在提示词前面", W);
  ok(codex.instructionsPlan("说明", "th-1", "win32").prefix === "", "Windows 续跑：线程里已经有了，不再拼");
  const zh = codex.instructionsPlan("汉".repeat(40000), null, "linux");
  ok(zh.args.length === 0 && zh.prefix.startsWith("汉"), "★按字节算长度★ 四万个汉字 12 万字节，Linux 单个参数放不下，改拼进提示词", zh.args.length);
  ok(codex.instructionsPlan("a".repeat(40000), null, "linux").args.length === 2, "反向对照：同样字数的英文 4 万字节，照走参数");
  const del = codex.instructionsPlan("a\u007fb\ud800c", null, "darwin").args[1];
  ok(!del.includes("\u007f") && del.includes("\\u007f") && JSON.parse(del.split("=").slice(1).join("=")).startsWith("a\u007fb�c"),
    "DEL 转义成 TOML 认的写法、孤立代理项抹平（不然 TOML 解析失败，整串原样露给模型）", del.slice(0, 60));
}

async function partKill() {
  console.log("\n— ② 按停止当场杀、硬退出一把收 —");
  const { runJsonl, killAll } = require(mod("jsonl"));
  // 假引擎：派一个孙进程（像 claude 起的 bash），把两个 pid 写出来，然后一直挂着
  const hang = (tag) => fakeBin("hang-" + tag, `
const { spawn } = require("child_process");
const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
require("fs").writeFileSync(${JSON.stringify(path.join(home, "pids-"))} + ${JSON.stringify(tag)}, JSON.stringify([process.pid, g.pid]));
setInterval(() => {}, 1000);
`);
  const pidsOf = (tag) => { try { return JSON.parse(fs.readFileSync(path.join(home, "pids-" + tag), "utf8")); } catch { return null; } };

  {
    const ctrl = new AbortController();
    const started = Date.now();
    const p = runJsonl({ bin: hang("abort"), args: [], cwd: home, onLine() {}, stopSignal: ctrl.signal });
    ok(await until(() => pidsOf("abort")), "假引擎起来了、孙进程也起了");
    const [kid, grand] = pidsOf("abort");
    // 挑在轮询刚跳过一下之后按：老写法得等下一跳（再过将近 2 秒），这样量出来的差别不看运气
    while (Date.now() - started < 2200) await sleep(20);
    const t0 = Date.now();
    ctrl.abort();
    const r = await p;
    const took = Date.now() - t0;
    ok(r.killed === "stopped", "按停止记成 stopped", r);
    ok(took < 800, `★按下停止当场杀★ ${took}ms（以前要等轮询下一跳，这个时点上将近 2 秒）`, took);
    ok(await until(() => !alive(kid) && !alive(grand), 5000), "引擎和它派生的孙进程都没了", { kid: alive(kid), grand: alive(grand) });
  }
  {
    const ctrl = new AbortController();
    ctrl.abort();
    const t0 = Date.now();
    const r = await runJsonl({ bin: hang("pre"), args: [], cwd: home, onLine() {}, stopSignal: ctrl.signal });
    ok(r.killed === "stopped" && Date.now() - t0 < 1500, "开跑前就已经停了：一起来就收", { r, ms: Date.now() - t0 });
  }
  {
    // 老式的 { aborted } 对象挂不上监听：照旧靠轮询，停得下来就行（反向对照，别把老调用方弄坏）
    const flag = { aborted: false };
    const p = runJsonl({ bin: hang("poll"), args: [], cwd: home, onLine() {}, stopSignal: flag });
    ok(await until(() => pidsOf("poll")), "老式停止对象：假引擎起来了");
    flag.aborted = true;
    const r = await Promise.race([p, sleep(6000).then(() => ({ killed: "超时没停" }))]);
    ok(r.killed === "stopped", "反向对照：老式 { aborted } 照旧靠轮询停下", r);
  }
  {
    // 同一个信号跑好几次引擎：跑完要把监听拆掉，不然越堆越多
    const ctrl = new AbortController();
    const quick = fakeBin("quick", line({ type: "x" }));
    const { getEventListeners } = require("events");
    for (let i = 0; i < 5; i++) await runJsonl({ bin: quick, args: [], cwd: home, onLine() {}, stopSignal: ctrl.signal });
    ok(getEventListeners(ctrl.signal, "abort").length === 0, "同一个信号跑了 5 趟，abort 监听一个不剩", getEventListeners(ctrl.signal, "abort").length);
  }
  {
    const p = runJsonl({ bin: hang("all"), args: [], cwd: home, onLine() {} });
    ok(await until(() => pidsOf("all")), "没有停止信号的一趟也起来了");
    const [kid, grand] = pidsOf("all");
    killAll("SIGTERM");
    const r = await Promise.race([p, sleep(5000).then(() => null)]);
    ok(r !== null, "★killAll 把还活着的引擎收掉★（关终端、被 kill 时走这条）");
    ok(await until(() => !alive(kid) && !alive(grand), 5000), "连孙进程一起", { kid: alive(kid), grand: alive(grand) });
  }
}

function partTempDirs() {
  console.log("\n— ③ 临时目录在进程退出时删掉 —");
  const bridge = mod("bridge");
  const run = (tail) => spawnSync(process.execPath, ["-e", `
const b = require(${JSON.stringify(bridge)}), path = require("path");
const m = b.writeMcpConfig({ x: { command: "node", env: { KEY: "sk-secret" } } });
const s = b.writeShim({ command: "node", args: ["x.js"], env: { KEY: "sk-secret" } });
process.stdout.write(JSON.stringify([path.dirname(m.path), s.dir]));
${tail}
`], { encoding: "utf8" });
  {
    const r = run("process.exit(0);");
    const dirs = JSON.parse(r.stdout || "[]");
    ok(dirs.length === 2 && dirs.every((d) => /owb-(mcp|shim)-/.test(d)), "起了两个临时目录", dirs);
    ok(dirs.every((d) => !fs.existsSync(d)), "★没走 cleanup 就 process.exit★ 目录也删掉了（里面有 key）", dirs.filter((d) => fs.existsSync(d)));
  }
  {
    const r = run("process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 2000);");
    const dirs = JSON.parse(r.stdout || "[]");
    // 没人接 SIGTERM 时 node 直接被信号带走，exit 钩子根本不跑——所以 cli.js 自己接 SIGTERM 再 process.exit
    ok(dirs.length === 2 && dirs.every((d) => fs.existsSync(d)), "反向对照：没人接的 SIGTERM 走不到 exit 钩子（cli.js 得自己接）", dirs);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  {
    const b = require(bridge);
    const m = b.writeMcpConfig({ x: { command: "node" } });
    const d = path.dirname(m.path);
    m.cleanup();
    ok(!fs.existsSync(d), "照常 cleanup 当场就删");
    m.cleanup();
    ok(true, "cleanup 调两次不炸");
  }
}

async function partStaleResume() {
  console.log("\n— ④ 续跑 id 失效：没动过工具就重开一根 —");
  const engines = require(mod("engines"));
  const { createAgentRuntime } = require(mod("agent"));
  const { McpManager } = require(mod("mcp"));
  const llm = require(mod("llm")).createLLM({ models: [{ name: "桩", provider: "openai", base_url: "http://127.0.0.1:9/v1", api_key: "sk-test-offline", model: "mock", stream: false }] });

  let script = () => ({ finalText: "" });
  const calls = [];
  const stub = {
    id: "t-stale", label: "续跑桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: true, models: [],
    async detect() { return { id: "t-stale", installed: true, path: "", version: "0" }; },
    async run(o) { calls.push({ prompt: o.prompt, resumeId: o.resumeId, systemPrompt: o.systemPrompt }); return script(o, calls.length); },
  };
  engines.BACKENDS.push(stub);
  const rt = createAgentRuntime({ config: { agent: { engine: "t-stale", max_steps: 3 } }, llm, mcpManager: new McpManager(), experts: [] });
  const history = () => [
    { role: "user", content: "先查一下 ALPHA" },
    { role: "assistant", text: "查完了" },
    { role: "user", content: "再做 BETA" },
  ];
  const go = async (engineSession, sc, stopSignal) => {
    calls.length = 0;
    script = sc;
    const evs = [];
    let r = null, err = null;
    try { r = await rt.runTask({ history: history(), emit: (e) => evs.push(e), engineSession, stopSignal }); } catch (e) { err = e; }
    return { r, err, evs, status: evs.filter((e) => e.type === "status").map((e) => e.text).join("\n") };
  };
  const gone = new Error("No conversation found with session ID: dead-1");

  try {
    {
      const A = await go("dead-1", (o, n) => { if (n === 1) throw gone; return { finalText: "接上了", sessionId: "new-2" }; });
      ok(!A.err && A.r.finalText === "接上了", "★续跑 id 失效 → 重开一根跑完了★ 以前这条会话之后每一轮都报同一个错", A.err ? A.err.message : A.r);
      ok(calls.length === 2 && calls[0].resumeId === "dead-1" && calls[1].resumeId === null, "先带旧 id 试一次，再不带 id 重来一次", calls.map((c) => c.resumeId));
      ok(calls[0].prompt === "再做 BETA", "续跑那次只发最新一句（反向对照：没改坏正常续跑）", calls[0].prompt);
      ok(/ALPHA/.test(calls[1].prompt) && /BETA/.test(calls[1].prompt), "★重开那次把对话历史摊平带过去★ 不然新线程只知道最后一句", calls[1].prompt);
      ok(calls[0].systemPrompt && calls[0].systemPrompt === calls[1].systemPrompt, "两次用的是同一份系统提示（只拼一次）");
      ok(A.r.sessionId === "new-2", "新线程的 id 带回去，调用方照常记下、盖掉失效的", A.r.sessionId);
      ok(/不在了/.test(A.status), "界面上说一声为什么重来", A.status);
    }
    {
      const B = await go("dead-1", (o) => { o.emit({ type: "tool_use", name: "Bash", input: {} }); throw gone; });
      ok(B.err && calls.length === 1, "★动过工具就不重来★ 重来等于把事做两遍", calls.length);
    }
    {
      const C = await go("live-1", () => { throw new Error("本机 Claude Code 撞到订阅限流了"); });
      ok(C.err && calls.length === 1 && /限流/.test(C.err.message), "别的错不重来、原样报", calls.length);
    }
    {
      const D = await go(null, () => { throw gone; });
      ok(D.err && calls.length === 1, "本来就没带续跑 id：不重来", calls.length);
    }
    {
      const ctrl = new AbortController();
      const E = await go("dead-1", () => { ctrl.abort(); throw gone; }, ctrl.signal);
      ok(E.err && calls.length === 1, "已经按了停止：不重来", calls.length);
    }
    {
      const F = await go("ok-1", () => ({ finalText: "好", sessionId: "ok-1" }));
      ok(!F.err && calls.length === 1 && !/不在了/.test(F.status), "反向对照：续跑正常时只跑一次、不多嘴", calls.length);
    }
  } finally {
    engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
  }
}

(async () => {
  try {
    await partResultErrors();
    await partWriteHints();
    await partCodexImages();
    await partKill();
    partTempDirs();
    await partStaleResume();
    console.log(`\n引擎韧性：${pass} 项全过`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.error("\n❌ " + e.message); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} process.exit(1); });
