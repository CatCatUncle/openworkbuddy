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
 *   ⑦ 开跑前的闸（engines/gate.js）：组织关了命令行就不起外部引擎、也不退回内置；
 *      型号必须钉死或在属主放行的列表里；附加参数不许换型号/供应商；多人共用默认关、属主打开才放行；
 *      codex 默认不联网、可写目录里没有数据根；多人共用时像 Key 的环境变量不往引擎里传
 *   ⑧ PATH：调用方给的（桥的 owb 目录、属主写的）拼在补全那份前面，不再整个盖掉——
 *      双击启动、PATH 残缺时，开头是 `#!/usr/bin/env node` 的 CLI 借了工具照样起得来；NODE_PATH 指向程序自带的 node_modules
 *   ⑨ 问答 / 计划模式：本机 CLI 按只读跑（claude plan、codex read-only），安全档位是「全自动」也一样；
 *      属主在引擎设置里手填的档位、沙箱、全局连接器、放宽权限的附加参数这一趟不认，运行页上说一句（只报参数名）；
 *      只借读的工具、不给 owb、不挂用户的连接器。反向对照：干活模式下属主手填的照旧以它为准；
 *      安全档「只看不动」干活模式下两个引擎都不给 owb（以前 codex 照给）；codex 的提示词点名沙箱里 owb 跑不成的
 *   ⑩ 用量：codex 的 turn.completed 是整条线程的累计值，按线程记起算点取差值（找不到起算点、不增反减记 0）；
 *      claude 一次调用拆成好几条 assistant，按 message.id 只记一份，被停、超时等不到 result 就拿它兜底
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
  const tryRun = async (bin) => { try { return { r: await claude.run({ prompt: "hi", cwd: home, bin, model: "sonnet" }) }; } catch (e) { return { e }; } };

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
  const r = await claude.run({ prompt: "hi", cwd: home, bin, model: "sonnet", onWrite: (p) => got.push(p) });
  ok(r.finalText === "好了" && same(got, [path.join(home, "汇总.csv"), path.join(home, "任务_x", "报告.md")]),
    "claude：Write / Edit 点名的文件按工作目录解析成绝对路径报上来，Bash、Read 不算", got);
  const none = await claude.run({ prompt: "hi", cwd: home, bin, model: "sonnet" });
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
        prompt: "画一张深圳夜景", cwd, bin, resumeId, systemPrompt, extraArgs, model: "gpt-test",
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
  const rt = createAgentRuntime({ config: { agent: { engine: "t-stale", max_steps: 3, engine_options: { "t-stale": { model: "m1" } } } }, llm, mcpManager: new McpManager(), experts: [] });
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

async function partGate() {
  console.log("\n— ⑦ 开跑前的闸：命令行开关、型号钉死、附加参数、沙箱只写工作区 —");
  const gate = require(mod("gate"));
  const engines = require(mod("engines"));
  const security = require(mod("security"));
  const tools = require(mod("tools"));
  const prefs = require(mod("prefs"));
  const codex = require(mod("codex"));
  const claude = require(mod("claude-code"));
  const bridge = require(mod("bridge"));
  const { callerEnv } = require(mod("jsonl"));
  const { dataPath } = require(mod("paths"));
  const { createAgentRuntime } = require(mod("agent"));
  const { McpManager } = require(mod("mcp"));
  const SHELL_OFF = "本组织关了命令行，外部引擎自带命令行，所以也不能用。";
  const codeOf = (fn) => { try { fn(); return ""; } catch (e) { return e.engineGate ? e.code : "非闸错：" + e.message; } };
  const cfg = (o) => ({ agent: { engine: "codex", engine_options: { codex: o } } });

  // —— 纯判定：engines.admit 收原始 config ——
  {
    let msg = "";
    try { engines.admit("codex", cfg({ model: "gpt-5", enabled: true }), { shellOff: true, multi: false }); } catch (e) { msg = e.message; }
    ok(msg === SHELL_OFF, "★组织关了命令行★ 外部引擎直接拒绝，文案说清为什么", msg);
    ok(codeOf(() => engines.admit("codex", cfg({}), { multi: false })) === "no_model", "★没钉型号就报错★ 不拿 CLI 自己配置里的默认型号顶上");
    const r = engines.admit("codex", cfg({ model: "gpt-5" }), { multi: false });
    ok(r.model === "gpt-5" && same(r.allowed, ["gpt-5"]) && r.opts.model === "gpt-5" && same(r.opts.allowedModels, ["gpt-5"]),
      "反向对照：单机、钉了型号 → 放行，交给 run() 的就是钉的那个", r.opts);
    ok(codeOf(() => engines.admit("codex", cfg({ model: "gpt-5" }), { multi: true })) === "engine_off", "★多人共用默认关★ 属主没打开就不能用");
    ok(codeOf(() => engines.admit("codex", cfg({ model: "gpt-5", enabled: true }), { multi: true })) === "", "属主打开以后放行");
    ok(codeOf(() => engines.admit("codex", cfg({ model: "gpt-5" }), { multi: false, model: "o3" })) === "model_not_allowed",
      "★自己挑的型号不在放行列表★ 拒绝");
    ok(codeOf(() => engines.admit("codex", cfg({ model: "gpt-5", models: ["o3"] }), { multi: false, model: "o3" })) === "",
      "反向对照：在属主给的候选列表里 → 放行");
    ok(codeOf(() => engines.admit("codex", cfg({ model: "gpt-5", extraArgs: ["-c", "model=o3"] }), { multi: false })) === "extra_model",
      "★附加参数里换型号★ 开跑前就拦下");
    // 报错得指到真找得到的地方：设置页左栏没有「底层引擎」，那张卡在「智能体」分区里；附加参数没有界面，只在 config.json
    {
      const msgOf = (f) => { try { f(); } catch (e) { return e.message; } return ""; };
      const app05 = fs.readFileSync(path.join(ROOT, "public/js/app-05.js"), "utf8");
      const [, cat, card] = gate.WHERE.split(" → ");
      const cats = (app05.match(/const SETTING_CATS = \[[\s\S]*?\n\];/) || [""])[0];
      const pane = app05.slice(app05.indexOf("async function renderAgentPane"), app05.indexOf("async function renderAgentPane") + 800);
      ok(new RegExp(`\\["agent", "${cat}"`).test(cats) && pane.includes(`<div class="t">${card}</div>`),
        "★报错里的设置路径是真的★ 左栏有这个分区，分区里有这张卡", gate.WHERE);
      const ea = msgOf(() => engines.admit("codex", cfg({ model: "gpt-5", extraArgs: ["--model", "o3"] }), { multi: false }));
      ok(ea.includes("config.json 的 agent.engine_options.codex.extraArgs"), "  └ 附加参数没有界面：报错点名在 config.json 哪一项", ea);
      const off = msgOf(() => engines.admit("codex", cfg({ model: "gpt-5" }), { multi: true }));
      ok(/切回内置引擎/.test(off) && off.includes(gate.WHERE), "  └ 多人共用没打开：告诉成员自己能切回内置引擎，不用干等", off);
    }
    ok(codeOf(() => engines.admit("claude-code", { agent: { engine_options: { "claude-code": { model: "sonnet" } } } }, { shellOff: true, multi: false })) === "shell_off",
      "Claude Code 也一样受命令行开关管");
  }
  // —— 个人设置文件里塞属主才有的键：盖不上去 ——
  {
    const sneaky = { agent: { engine_options: { codex: { model: "o9", models: ["o9"], enabled: true, network: true, extraArgs: ["--yolo"], bin: "/bin/sh" } } } };
    const owner = cfg({ model: "gpt-5", enabled: true });
    prefs.withPrefs(sneaky, () => {
      const eo = prefs.agentCfg(owner).engine_options.codex;
      ok(eo.model === "o9" && same(eo.models, undefined) && eo.network === undefined && eo.extraArgs === undefined && eo.bin === undefined,
        "★个人设置只叠 model / thinking★ models、network、extraArgs、bin 塞进去也不算数", eo);
      ok(codeOf(() => engines.admit("codex", owner, { multi: true })) === "model_not_allowed", "  └ 所以自己往列表里加的 o9 照样不放行");
    });
    prefs.withPrefs(sneaky, () => {
      ok(codeOf(() => engines.admit("codex", cfg({ model: "gpt-5" }), { multi: true })) === "engine_off", "  └ 自己写 enabled:true 也打不开属主没开的引擎");
    });
  }
  // —— 老配置升级：型号留空的、在用 Codex 的，升上来先说一声（不改配置、不替人选型号） ——
  {
    const migrate = require(mod("migrate"));
    const base = path.join(process.env.OPENWORKBUDDY_HOME, "mig-eng");
    const run = (k, o) => migrate.runMigrations(path.join(base, k), path.join(base, k + ".json"), { version: "9.9.9", priorUse: true, ...o });
    const a = run("a", { engineNoModel: "本机 Claude Code", codexNet: true });
    ok(a.some((n) => n.id === "engine-pin-model-v1" && /本机 Claude Code/.test(n.note) && n.note.includes(gate.WHERE)),
      "★选着外部引擎、属主没放行型号★ 升上来提示一次去哪儿填", a);
    ok(a.some((n) => n.id === "codex-offline-v1" && /默认不再联网/.test(n.note)), "★在用 Codex★ 升上来提示命令默认不联网、开关在哪", a);
    const q = run("b", { engineNoModel: "", codexNet: false });
    ok(!q.some((n) => n.id === "engine-pin-model-v1" || n.id === "codex-offline-v1"), "反向对照：没受影响的不打扰", q);
    const fresh = migrate.runMigrations(path.join(base, "c"), path.join(base, "c.json"), { version: "9.9.9", priorUse: false, engineNoModel: "本机 Codex", codexNet: true });
    ok(!fresh.some((n) => n.id === "engine-pin-model-v1" || n.id === "codex-offline-v1"), "反向对照：全新装不提示", fresh);
    const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    ok(/engineNoModel, codexNet,?\s*\}\);/.test(srv) && /engines\.gateView\(id, config\)\.allowed\.length/.test(srv),
      "启动时把「哪个外部引擎没放行型号」「在用 Codex」递给升级提示");
  }
  // —— 附加参数：每一种换型号、换供应商的写法 ——
  {
    const cx = [
      ["--model", "x"], ["--model=x"], ["-m", "x"], ["-mx"], ["--fallback-model", "x"],
      ["-c", "model=x"], ["-c", 'model="x"'], ["-c", " model = x"], ["--config", "model=x"], ["--config=model_provider=y"],
      ["-cprofile=z"], ["-c", "model_providers.evil.base_url=http://127.0.0.1:9"], ["-c", "profiles.p.model=x"],
      ["--profile", "p"], ["--profile=p"], ["-p", "p"], ["--oss"], ["--local-provider", "ollama"],
      ["--full-auto", "-c", "model=x"],
      // -c=KEY=VAL：codex 吃掉开头那个 =，跟 -cKEY=VAL 一个意思
      ["-c=model=x"], ["-c=model_provider=y"], ["-c=profile=p"], ["-c=model_providers.evil.base_url=http://127.0.0.1:9"],
    ];
    const bad = cx.filter((a) => !gate.modelArg(a, "codex"));
    ok(bad.length === 0, `★codex 附加参数换型号的 ${cx.length} 种写法全拦★（含 = 连写、-c 覆盖配置、换配置档 / 供应商）`, bad);
    const cc = [["--model", "opus"], ["--model=opus"], ["-m", "opus"], ["--fallback-model", "haiku"], ["--settings", "{}"], ["--agents", "{}"]];
    ok(cc.every((a) => gate.modelArg(a, "claude-code")), "claude 附加参数：--model / --fallback-model / --settings / --agents 全拦", cc.filter((a) => !gate.modelArg(a, "claude-code")));
    const fine = [["-c", 'developer_instructions="x"'], ["--full-auto"], ["-c", "model_reasoning_effort=high"], ["-c=model_reasoning_effort=high"], ["-c", "sandbox_mode=read-only"], []];
    ok(fine.every((a) => gate.modelArg(a, "codex") === ""), "反向对照：不换型号的参数照常放行（model_reasoning_effort 不是 model）", fine.filter((a) => gate.modelArg(a, "codex")));
    ok(gate.modelArg(["--verbose", "--max-turns", "3"], "claude-code") === "", "反向对照：claude 的普通参数照常放行");
    // 设置页保存：属主填附加参数时就拦，而且拦在改动任何配置之前（不留内存里改了一半的状态）
    const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    const chk = srv.indexOf("engineGate.modelArg(v.extraArgs, id)");
    const firstWrite = srv.indexOf("config.models = b.models;");
    ok(chk > 0 && firstWrite > chk, "设置页保存附加参数也过同一个判定，而且在写配置之前", { chk, firstWrite });
  }

  // —— run() 自己也挡一道：绕过 agent 直接调的入口（试连、目标拆解）——
  const srcHome = path.join(home, "codex-gate-src");
  fs.mkdirSync(srcHome, { recursive: true });
  const argvLog = path.join(home, "gate-argv.json");
  const dump = `
const a = process.argv.slice(2);
if (a[0] === "debug" || a[0] === "--version") process.exit(1);
require("fs").writeFileSync(process.env.FAKE_LOG, JSON.stringify(a));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  out({ type: "thread.started", thread_id: "th-gate" });
  out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "好" } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
});
`;
  const cxBin = fakeBin("codex-gate", dump);
  const ccBin = fakeBin("cc-gate", `
const a = process.argv.slice(2);
require("fs").writeFileSync(process.env.FAKE_LOG, JSON.stringify(a));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "好" }) + "\\n");
`);
  const cxRun = async (extra = {}) => {
    fs.rmSync(argvLog, { force: true });
    const cwd = path.join(home, "gate-ws");
    fs.mkdirSync(cwd, { recursive: true });
    let r = null, err = null;
    try { r = await codex.run({ prompt: "hi", cwd, bin: cxBin, env: { CODEX_HOME: srcHome, FAKE_LOG: argvLog }, ...extra }); } catch (e) { err = e; }
    const argv = fs.existsSync(argvLog) ? JSON.parse(fs.readFileSync(argvLog, "utf8")) : null;
    return { r, err, argv };
  };
  const ccRun = async (extra = {}) => {
    fs.rmSync(argvLog, { force: true });
    let r = null, err = null;
    try { r = await claude.run({ prompt: "hi", cwd: home, bin: ccBin, env: { FAKE_LOG: argvLog }, ...extra }); } catch (e) { err = e; }
    const argv = fs.existsSync(argvLog) ? JSON.parse(fs.readFileSync(argvLog, "utf8")) : null;
    return { r, err, argv };
  };
  {
    const A = await cxRun({});
    ok(A.err && /指定型号/.test(A.err.message) && A.argv === null, "★codex 没钉型号★ run() 报错、进程都没起", A.err ? A.err.message : A.argv);
    const B = await ccRun({});
    ok(B.err && /指定型号/.test(B.err.message) && B.argv === null, "★claude 没钉型号★ 同上", B.err ? B.err.message : B.argv);
    const C = await cxRun({ model: "gpt-test", extraArgs: ["--model", "o3"] });
    ok(C.err && /换型号/.test(C.err.message) && C.argv === null, "codex 附加参数带 --model：run() 拒绝", C.err ? C.err.message : C.argv);
    const D = await ccRun({ model: "sonnet", extraArgs: ["--settings", "{}"] });
    ok(D.err && /换型号/.test(D.err.message) && D.argv === null, "claude 附加参数带 --settings：run() 拒绝", D.err ? D.err.message : D.argv);
    const E = await ccRun({ model: "sonnet" });
    ok(!E.err && E.argv && E.argv[E.argv.indexOf("--model") + 1] === "sonnet", "反向对照：claude 钉了型号 → 带着 --model 起", E.err ? E.err.message : E.argv);
  }
  {
    const root = dataPath();
    const keep = path.join(root, "workspace", "项目甲");
    const A = await cxRun({ model: "gpt-test", writableRoots: [root, path.join(root, "data"), path.join(root, "data", "users"), path.dirname(root), keep] });
    ok(!A.err && A.argv, "codex 钉了型号：跑通", A.err && A.err.message);
    const m = A.argv[A.argv.indexOf("-m") + 1];
    ok(m === "gpt-test", "★-m 带的就是钉的那个★", A.argv);
    ok(!A.argv.some((x) => /network_access\s*=\s*true/.test(x)), "★默认不联网★ argv 里没有 network_access=true", A.argv);
    const wr = A.argv.find((x) => x.startsWith("sandbox_workspace_write.writable_roots="));
    const roots = wr ? JSON.parse(wr.slice("sandbox_workspace_write.writable_roots=".length)) : [];
    ok(same(roots, [keep]), "★可写目录只剩工作区里的★ 数据根、data/、包着数据根的上级目录全剔掉", roots);
    const B = await cxRun({ model: "gpt-test", network: true });
    ok(!B.err && B.argv.includes("sandbox_workspace_write.network_access=true"), "反向对照：属主在设置里打开联网 → 才带上", B.argv);
    const C = await cxRun({ model: "gpt-test", network: "true" });
    ok(!C.err && !C.argv.some((x) => /network_access/.test(x)), "只认布尔 true：字符串 \"true\" 不算打开", C.argv);
    const D = await cxRun({ model: "gpt-test", writableRoots: [root] });
    ok(!D.err && !D.argv.some((x) => /writable_roots/.test(x)), "剔完一个不剩：干脆不带 writable_roots", D.argv);
  }
  {
    const att = bridge.attach("codex", { home: dataPath(), baseDir: "任务_闸", user: "gate" });
    try {
      ok(!("writableRoots" in att.runOpts), "★借工具时不再把数据根塞进 codex 的可写目录★", Object.keys(att.runOpts));
      ok(att.runOpts.mcpArgs.includes("mcp_servers.openworkbuddy.tool_timeout_sec=900"), "MCP 工具给足 15 分钟（生图、出视频慢）", att.runOpts.mcpArgs.filter((x) => /timeout/.test(x)));
      ok(att.shimIsPrimary === false && att.shimSandboxed === true, "codex 以 MCP 为主，命令行入口在沙箱里只当后备");
    } finally { att.cleanup(); }
  }

  // —— 接进 runTask：组织关了命令行时不起引擎、也不退回内置 ——
  const calls = [];
  let llmCalls = 0;
  const stub = {
    id: "t-gate", label: "闸桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: false, models: [],
    async detect() { return { id: "t-gate", installed: true, path: "", version: "0" }; },
    async run(o) { calls.push(o); return { finalText: "桩答的", usage: {}, stopped: null, sessionId: null }; },
  };
  const fakeLLM = { provider: "mock", model: "scripted", async chat() { llmCalls++; return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
  engines.BACKENDS.push(stub);
  const rtOf = (o) => createAgentRuntime({ config: { agent: { engine: "t-gate", max_steps: 3, engine_options: { "t-gate": o } } }, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
  const go = async (rt) => {
    calls.length = 0;
    llmCalls = 0;
    let r = null, err = null;
    try { r = await rt.runTask({ history: [{ role: "user", content: "干活" }], emit: () => {} }); } catch (e) { err = e; }
    return { r, err };
  };
  try {
    {
      const A = await tools.withPolicy({ allow_shell: false }, () => go(rtOf({ model: "m1" })));
      ok(A.err && A.err.message === SHELL_OFF, "★allow_shell:false → 任务报错★ 文案原样交给用户", A.err ? A.err.message : A.r);
      ok(calls.length === 0 && llmCalls === 0, "★引擎没起、也没悄悄退回内置引擎★", { engine: calls.length, builtin: llmCalls });
      const B = await go(rtOf({ model: "m1" }));
      ok(!B.err && calls.length === 1 && calls[0].model === "m1" && llmCalls === 0, "反向对照：组织没关命令行 → 照常交给引擎，带着钉的型号", B.err ? B.err.message : calls.map((c) => c.model));
    }
    {
      const A = await go(rtOf({}));
      ok(A.err && A.err.code === "no_model" && calls.length === 0 && llmCalls === 0, "没钉型号：任务报错，不退回内置", A.err ? A.err.message : A.r);
      ok(A.err.message.includes(gate.WHERE), "  └ 报错说清去哪配", A.err.message);
    }
    security.setMultiUser(() => true);
    {
      const A = await go(rtOf({ model: "m1" }));
      ok(A.err && A.err.code === "engine_off" && calls.length === 0 && llmCalls === 0, "★多人共用、属主没打开★ 任务报错，不退回内置", A.err ? A.err.message : A.r);
      const B = await go(rtOf({ model: "m1", enabled: true }));
      ok(!B.err && calls.length === 1, "反向对照：属主打开以后照常跑", B.err && B.err.message);
      const C = await prefs.withPrefs({ agent: { engine_options: { "t-gate": { model: "偷换的" } } } }, () => go(rtOf({ model: "m1", enabled: true })));
      ok(C.err && C.err.code === "model_not_allowed" && calls.length === 0, "★成员自己挑的型号不在放行列表★ 拒绝", C.err ? C.err.message : C.r);
      const D = await prefs.withPrefs({ agent: { engine_options: { "t-gate": { model: "m2" } } } }, () => go(rtOf({ model: "m1", models: ["m2"], enabled: true })));
      ok(!D.err && calls.length === 1 && calls[0].model === "m2", "反向对照：在列表里的型号放行，引擎拿到的就是它", D.err ? D.err.message : calls.map((c) => c.model));
    }
    // —— 环境变量：多人共用时像 Key 的一个都不往引擎里传 ——
    {
      const env = { OPENAI_API_KEY: "sk-test-xxxx", ANTHROPIC_AUTH_TOKEN: "sk-test-yyyy", CODEX_HOME: "/x", FAKE_LOG: "/y" };
      const multi = callerEnv(env);
      ok(!("OPENAI_API_KEY" in multi) && !("ANTHROPIC_AUTH_TOKEN" in multi), "★多人共用：像 Key 的变量剔掉★", Object.keys(multi));
      ok(multi.CODEX_HOME === "/x" && multi.FAKE_LOG === "/y", "  └ 别的照传", multi);
      security.setMultiUser(null);
      const solo = callerEnv(env);
      ok(solo.OPENAI_API_KEY === "sk-test-xxxx", "反向对照：单机桌面照传（用户自己的机器、自己的 Key）", Object.keys(solo));
    }
  } finally {
    security.setMultiUser(null);
    engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
  }
}

async function partPath() {
  console.log("\n— ⑧ PATH：调用方给的目录在前，补全的那份不丢 —");
  const { enginePath, mergeEnv } = require(mod("jsonl"));
  const { appPath } = require(mod("paths"));
  const codex = require(mod("codex"));
  const bridge = require(mod("bridge"));

  ok(same(mergeEnv({ PATH: "/桥" }, { PATH: "/属主/bin", FOO: "1" }, "darwin"), { FOO: "1", PATH: "/桥:/属主/bin" }),
    "★属主也写了 PATH：拼起来，桥的在前★ 不再整个盖掉");
  ok(same(mergeEnv({ PATH: "/桥", A: "1" }, { A: "2" }, "darwin"), { A: "2", PATH: "/桥" }), "别的变量照旧后一份盖前一份");
  ok(same(mergeEnv(null, undefined, "darwin"), {}), "两份都没有：空的，不凭空写一个 PATH");
  ok(same(mergeEnv({ PATH: "/桥" }, { Path: "/x" }, "darwin"), { Path: "/x", PATH: "/桥" }), "反向对照：Mac 上 Path 是另一个变量，不当 PATH 拼");

  if (process.platform === "win32") return; // 下面靠 `#!/usr/bin/env node` 找 node；Windows 的 Path / PATH 在 win-env 里验
  const ep = enginePath("/调用方/一:/调用方/二:/调用方/一").split(":");
  ok(ep[0] === "/调用方/一" && ep[1] === "/调用方/二", "调用方给的目录打头、顺序不变", ep.slice(0, 3));
  ok(new Set(ep).size === ep.length, "重复的只留第一次出现的那个", ep);
  ok(ep.includes("/opt/homebrew/bin") && ep.includes("/usr/local/bin"), "补全的常见安装位置接在后面", ep);

  // 双击启动的应用：PATH 里一个有用的目录都没有，node 只在「常见安装位置」里（这里借 ~/bin 那一格）
  const fakeHome = path.join(home, "家");
  const nodeDir = path.join(fakeHome, "bin");
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeDir, "node"));
  const empty = path.join(home, "空的PATH");
  fs.mkdirSync(empty);
  // 问账号能用哪些型号（debug models）那一下也得起得来：环境里只带了 CODEX_HOME，记号只能写死路径
  const probed = path.join(home, "codex-debug-ran");
  const bin = fakeBin("codex-env", `
const fs = require("fs");
if (process.argv[2] === "debug") {
  fs.writeFileSync(${JSON.stringify(probed)}, "1");
  process.stdout.write(JSON.stringify({ models: [{ slug: "gpt-test" }] }));
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => { input += d; }).on("end", () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ PATH: process.env.PATH || "", NODE_PATH: process.env.NODE_PATH || "" }));
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "thread.started", thread_id: "th-path" });
  out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "好" } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
});
`);
  const srcHome = path.join(home, "codex-src-path");
  fs.mkdirSync(srcHome, { recursive: true });
  const logFile = path.join(home, "codex-path.json");
  const cwd = path.join(home, "对话-PATH");
  fs.mkdirSync(cwd, { recursive: true });
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  let a = null, r = null, err = null, shimDir = "";
  try {
    process.env.PATH = empty;
    process.env.HOME = fakeHome;
    a = bridge.attach("codex", { home: process.env.OPENWORKBUDDY_HOME, baseDir: "任务_PATH", user: "", tools: ["gen_diagram"] });
    shimDir = a.shimDir;
    try {
      r = await codex.run({
        prompt: "干活", cwd, bin, model: "gpt-test", emit() {}, onWrite() {},
        ...a.runOpts,
        env: mergeEnv(a.runOpts.env, { CODEX_HOME: srcHome, FAKE_LOG: logFile }),
      });
    } catch (e) { err = e; }
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    if (a) a.cleanup();
  }
  ok(!err && r && r.finalText === "好", "★PATH 残缺、开头是 #!/usr/bin/env node 的 codex，借了工具照样起得来★", err ? err.message : r);
  const got = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : { PATH: "", NODE_PATH: "" };
  const dirs = got.PATH.split(":");
  ok(!!shimDir && dirs[0] === shimDir, "owb 那个目录还在 PATH 最前面（模型敲裸命令靠它）", dirs.slice(0, 3));
  ok(dirs.indexOf(nodeDir) > 0, "补全的常见安装位置接在后面，node 就是从那儿找到的", dirs);
  ok(new Set(dirs).size === dirs.length, "没有重复的目录", dirs);
  ok(fs.existsSync(probed), "★开跑前问账号型号的那一下（codex debug models）也找得到 node★ 以前它拿的是本进程那份残缺的 PATH");
  ok(got.NODE_PATH.split(":")[0] === appPath("node_modules"), "★NODE_PATH 打头的是程序自带的 node_modules★ 引擎写的脚本 require 得到 pptxgenjs", got.NODE_PATH);
}

async function partReadOnly() {
  console.log("\n— ⑨ 问答 / 计划模式：本机 CLI 按只读跑，属主手填的放宽设置这一趟不认 —");
  const gate = require(mod("gate"));
  const lendable = require(mod("lendable"));
  const { createAgentRuntime } = require(mod("agent"));
  const { McpManager } = require(mod("mcp"));

  // —— 纯判定：哪些附加参数要摘 ——
  {
    const L = gate.looseArgs;
    ok(same(L(["--permission-mode", "bypassPermissions", "--setting-sources", "user"], "claude-code"), { keep: ["--setting-sources", "user"], dropped: ["--permission-mode"] }),
      "claude：--permission-mode 连值一起摘，别的照带");
    ok(same(L(["--dangerously-skip-permissions", "--allowed-tools", "Bash(*)", "Write", "--verbose"], "claude-code"), { keep: ["--verbose"], dropped: ["--dangerously-skip-permissions", "--allowed-tools"] }),
      "claude：--allowed-tools 是变长的，后面不带 - 的值全摘");
    ok(same(L(["--allowedTools=Bash", "--mcp-config", "a.json", "--plugin-dir", "/x", "--add-dir", "/y"], "claude-code"), { keep: ["--add-dir", "/y"], dropped: ["--allowedTools", "--mcp-config", "--plugin-dir"] }),
      "claude：= 连写也认；--add-dir 只多给读的地方，照带");
    ok(same(L(["--full-auto", "-s", "danger-full-access", "-c", "model_reasoning_effort=high", "-c", 'sandbox_mode="danger-full-access"'], "codex"),
      { keep: ["-c", "model_reasoning_effort=high"], dropped: ["--full-auto", "-s", "-c sandbox_mode"] }), "codex：--full-auto、-s、-c sandbox_mode 摘掉，思考档照带");
    const k = L(["-sdanger-full-access", "--sandbox=x", "-c=approval_policy=never", "--config", 'mcp_servers.x.env.K="v-secret"', "-c", "sandbox_workspace_write.network_access=true", "--yolo", "--add-dir", "/z", "--search"], "codex");
    ok(same(k.keep, ["--search"]) && k.dropped.length === 7, "codex：连写、= 写法、--config、可写目录、联网、多挂 MCP 一个不漏", k);
    ok(!k.dropped.join(" ").includes("v-secret"), "★摘掉的只记参数名★ 值里可能有 Key，不往运行页上写", k.dropped);
    ok(same(L(null, "codex"), { keep: [], dropped: [] }) && same(L(["--model", "x"], "claude-code").keep, ["--model", "x"]), "没填 / 跟放宽无关的：原样留着（换型号由开跑前的闸管）");
  }

  // —— 真跑一趟：真的 claude-code / codex 后端，假的二进制把收到的 argv、MCP 配置、PATH 里有没有 owb 记下来 ——
  const logFile = path.join(home, "ro-run.json");
  const ccBin = fakeBin("cc-ro", `
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] !== "-p") { process.stdout.write("Usage: claude [options]\\n  --add-dir <directories...>\\n"); process.exit(0); }
const i = a.indexOf("--mcp-config");
let mcp = null; try { mcp = JSON.parse(fs.readFileSync(a[i + 1], "utf8")); } catch {}
const owb = (process.env.PATH || "").split(path.delimiter).filter((d) => d && fs.existsSync(path.join(d, "owb")));
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, mcp, owb }));
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "好" }) + "\\n"));
`);
  const cxBin = fakeBin("codex-ro", `
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] === "debug" || a[0] === "--version") process.exit(1);
const owb = (process.env.PATH || "").split(path.delimiter).filter((d) => d && fs.existsSync(path.join(d, "owb")));
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: a, owb }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  out({ type: "thread.started", thread_id: "th-ro" });
  out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "好" } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
});
`);
  const srcHome = path.join(home, "codex-ro-src");
  fs.mkdirSync(srcHome, { recursive: true });
  const fakeLLM = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
  const go = async (id, o, mode, sec = { permission_mode: "full" }) => {
    fs.rmSync(logFile, { force: true });
    // 默认安全档位是「全自动」：只读是这一趟任务的性质，跟档位开到多大无关
    const config = {
      security: sec,
      mcp_servers: [{ name: "userconn", command: "/bin/echo" }],
      agent: { engine: id, max_steps: 3, engine_options: { [id]: { ...o, env: { ...(o.env || {}), FAKE_LOG: logFile } } } },
    };
    const rt = createAgentRuntime({ config, llm: fakeLLM, mcpManager: new McpManager(), experts: [] });
    const evs = [];
    let r = null, err = null;
    try { r = await rt.runTask({ history: [{ role: "user", content: "看看这个项目怎么样" }], emit: (e) => evs.push(e), mode }); } catch (e) { err = e; }
    const got = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : null;
    return { r, err, got, status: evs.filter((e) => e.type === "status").map((e) => e.text).join("\n") };
  };
  const valsOf = (argv, flag) => argv.flatMap((x, i) => (x === flag ? [argv[i + 1]] : []));
  // 照手写的表比，不拿 lentFor 自己算：它被改坏了，期望值跟着坏就验不出来了（render_page 要渲染器，桥上本来就不借）
  const RO = ["look_at_image", "read_document", "web_search", "library_list", "library_read"];

  const ccOpts = {
    model: "sonnet", bin: ccBin, permissionMode: "bypassPermissions", globalMcp: true,
    extraArgs: ["--dangerously-skip-permissions", "--allowed-tools", "Bash(*)", "Write", "--mcp-config", "/x/别的.json", "--setting-sources", "user"],
  };
  {
    const A = await go("claude-code", ccOpts, "ask");
    ok(!A.err && A.got, "问答模式 + claude：跑通", A.err && A.err.message);
    const argv = A.got.argv;
    ok(same(valsOf(argv, "--permission-mode"), ["plan"]), "★--permission-mode 只有一个 plan★ 属主手填的 bypassPermissions、档位「全自动」这一趟都不认", valsOf(argv, "--permission-mode"));
    ok(!argv.includes("--dangerously-skip-permissions"), "★附加参数里的 --dangerously-skip-permissions 摘掉了★", argv);
    const allowed = valsOf(argv, "--allowed-tools");
    ok(allowed.length > 0 && allowed.every((t) => t.startsWith("mcp__")), "★--allowed-tools 只剩 mcp__…★ 附加参数里的 Bash(*)、owb 那条都没有", allowed);
    ok(!argv.includes("Write") && !argv.includes("/x/别的.json") && valsOf(argv, "--mcp-config").length === 1, "摘的时候连后面跟的值一起摘，--mcp-config 只剩本项目那份", argv);
    ok(argv.includes("--strict-mcp-config"), "★属主手填的 globalMcp 这一趟不认★ 用户全局的 MCP 不挂", argv);
    ok(argv[argv.indexOf("--setting-sources") + 1] === "user", "反向对照：跟放宽无关的附加参数照带", argv);
    const servers = (A.got.mcp && A.got.mcp.mcpServers) || {};
    ok(same(Object.keys(servers), ["openworkbuddy"]), "★只挂本项目这一台★ 用户配的连接器这一趟不挂", Object.keys(servers));
    const env = (servers.openworkbuddy || {}).env || {};
    ok(same(lendable.parseList(env.OPENWORKBUDDY_BRIDGE_TOOLS).sort(), RO.slice().sort()) && env.OPENWORKBUDDY_BRIDGE_READONLY === "1", "★借出去的只有读的那几个★ 桥那头也知道是只读", env.OPENWORKBUDDY_BRIDGE_TOOLS);
    ok(same(A.got.owb, []), "★PATH 里没有 owb★", A.got.owb);
    const sp = valsOf(argv, "--append-system-prompt")[0] || "";
    ok(/mcp__openworkbuddy__read_document/.test(sp) && !/generate_image|owb list|被拒一次就别换个写法再试|require\("pptxgenjs"\)/.test(sp),
      "提示词照这一趟实际借的说：没有生图、没有 owb、没有「自动改文件」那句、不教它写 PPT", sp.slice(0, 400));
    ok(/问答模式，本机 CLI 按只读跑/.test(A.status) && /bypassPermissions/.test(A.status) && /--dangerously-skip-permissions/.test(A.status) && /全局连接器/.test(A.status),
      "★运行页上说一句：手填的哪几样这次不用★ 免得属主以为设置坏了", A.status);
    ok(!/Bash\(\*\)|别的\.json/.test(A.status), "说的时候只报参数名，不带值", A.status);
  }
  {
    // 属主手填 acceptEdits：平时提示词里有「被拒一次就停」那句，计划模式按 plan 跑，那句不该出现
    const P = await go("claude-code", { ...ccOpts, permissionMode: "acceptEdits" }, "plan");
    const argv = (P.got && P.got.argv) || [];
    const sp = valsOf(argv, "--append-system-prompt")[0] || "";
    ok(!P.err && same(valsOf(argv, "--permission-mode"), ["plan"]) && sp && !/被拒一次就别换个写法再试/.test(sp),
      "★计划模式 + 手填 acceptEdits：提示词照 plan 说★ 不出「被拒一次就停」那句", P.err ? P.err.message : sp.slice(0, 300));
  }
  {
    const B = await go("claude-code", ccOpts, "craft");
    const argv = (B.got && B.got.argv) || [];
    ok(!B.err && same(valsOf(argv, "--permission-mode"), ["bypassPermissions"]) && argv.includes("--dangerously-skip-permissions") && !argv.includes("--strict-mcp-config"),
      "反向对照：干活模式下属主手填的档位、附加参数、全局连接器照旧以它为准", B.err ? B.err.message : argv);
    ok(B.got && B.got.owb.length === 1 && Object.keys(B.got.mcp.mcpServers).includes("userconn"), "反向对照：干活模式照给 owb、挂用户的连接器", B.got);
    ok(!/按只读跑/.test(B.status), "反向对照：干活模式不说那句", B.status);
  }
  {
    const cxOpts = {
      model: "gpt-test", bin: cxBin, sandbox: "danger-full-access", network: true, env: { CODEX_HOME: srcHome },
      extraArgs: ["--full-auto", "-s", "danger-full-access", "-c", "approval_policy=never", "--add-dir", "/tmp", "-c", "model_reasoning_effort=high"],
    };
    const C = await go("codex", cxOpts, "plan");
    ok(!C.err && C.got, "计划模式 + codex：跑通", C.err && C.err.message);
    const argv = (C.got && C.got.argv) || [];
    const sm = argv.filter((x) => /^sandbox_mode=/.test(x));
    ok(sm.length === 1 && sm[0] === 'sandbox_mode="read-only"', "★sandbox_mode 只有一个 read-only★ 属主手填的 danger-full-access 不认", sm);
    ok(!argv.some((x) => /danger-full-access|approval_policy|network_access/.test(x)) && !argv.includes("--full-auto") && !argv.includes("-s") && !argv.includes("--add-dir"),
      "★附加参数里放宽沙箱、审批、可写目录的全摘了，联网也关了★", argv);
    ok(argv.includes("model_reasoning_effort=high"), "反向对照：思考档这类无关的照带", argv);
    const flat = argv.join("\n");
    ok(!/mcp_servers\.userconn/.test(flat) && /OPENWORKBUDDY_BRIDGE_READONLY = "1"/.test(flat), "codex：用户的连接器不挂，桥知道是只读", flat.slice(0, 300));
    ok(same(C.got.owb, []), "codex：PATH 里也没有 owb", C.got.owb);
    ok(/计划模式，本机 CLI 按只读跑/.test(C.status) && /沙箱 danger-full-access/.test(C.status) && !/approval_policy=never|\/tmp/.test(C.status), "运行页说清这次不用的，只报参数名", C.status);
    const D = await go("codex", cxOpts, "craft");
    const dv = (D.got && D.got.argv) || [];
    ok(!D.err && dv.includes('sandbox_mode="danger-full-access"') && dv.includes("--full-auto"), "反向对照：干活模式照属主手填的跑", D.err ? D.err.message : dv);
  }
  {
    // 安全档「只看不动」+ 干活模式：命令行入口两个引擎都不给。以前只有 claude 不放行，codex 照样把 owb 挂进 PATH
    const cxPlain = { model: "gpt-test", bin: cxBin, env: { CODEX_HOME: srcHome } };
    const P = await go("codex", cxPlain, "craft", { permission_mode: "plan" });
    ok(!P.err && P.got && same(P.got.owb, []), "★codex + 「只看不动」：PATH 里没有 owb★", P.err ? P.err.message : P.got);
    const di = ((P.got && P.got.argv) || []).find((x) => /^developer_instructions=/.test(x)) || "";
    ok(!/owb list/.test(di), "codex + 「只看不动」：提示词里也不提 owb", di.slice(0, 300));
    const A = await go("codex", cxPlain, "craft", { permission_mode: "auto" });
    ok(!A.err && A.got && A.got.owb.length === 1, "反向对照：「自动」档照给 owb", A.err ? A.err.message : A.got);
    const ai = ((A.got && A.got.argv) || []).find((x) => /^developer_instructions=/.test(x)) || "";
    ok(/2 是这条入口跑不了它/.test(ai) && /generate_image、/.test(ai) && /record_web_demo/.test(ai) && /在沙箱里从这条路调会直接退出/.test(ai),
      "★codex 提示词点名沙箱里 owb 跑不成的★ 退出码 2 也说清是什么", ai.slice(0, 300));
    const C = await go("claude-code", { model: "sonnet", bin: ccBin }, "craft", { permission_mode: "plan" });
    const cv = (C.got && C.got.argv) || [];
    ok(!C.err && C.got && same(C.got.owb, []) && !cv.some((x) => /Bash\(owb/.test(x)), "claude + 「只看不动」：PATH 里没有 owb，也不放行 Bash(owb", C.err ? C.err.message : cv);
  }
}

async function partUsage() {
  console.log("\n— ⑩ 用量：codex 按线程取差值；claude 一次调用只记一份，等不到 result 拿它兜底 —");
  const codex = require(mod("codex"));
  const claude = require(mod("claude-code"));

  // 假 codex：thread_id 照 FAKE_THREAD 报，turn.completed 的 usage 照 FAKE_USAGE 原样报（空 = 不报这一条）
  const cxBin = fakeBin("codex-usage", `
const a = process.argv.slice(2);
if (a[0] === "debug") process.exit(1);
process.stdin.on("data", () => {}).on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "thread.started", thread_id: process.env.FAKE_THREAD });
  out({ type: "turn.started" });
  out({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "好" } });
  if (process.env.FAKE_USAGE) out({ type: "turn.completed", usage: JSON.parse(process.env.FAKE_USAGE) });
});
`);
  const srcHome = path.join(home, "codex-src-usage");
  fs.mkdirSync(srcHome, { recursive: true });
  const cwd = path.join(home, "用量");
  fs.mkdirSync(cwd, { recursive: true });
  const U = (i, c, o, reason) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o, ...(reason != null ? { reasoning_output_tokens: reason } : {}) });
  const cx = async (thread, resumeId, cum) => {
    const r = await codex.run({
      prompt: "hi", cwd, bin: cxBin, resumeId, model: "gpt-test",
      env: { CODEX_HOME: srcHome, FAKE_THREAD: thread, FAKE_USAGE: cum ? JSON.stringify(cum) : "" },
    });
    return [r.usage.prompt, r.usage.cached, r.usage.completion];
  };

  let u = await cx("th-u1", null, U(100, 40, 10, 4));
  ok(same(u, [100, 40, 10]), "新线程从 0 算；reasoning 本来就算在 output 里，不再另加（以前记 14）", u);
  u = await cx("th-u1", "th-u1", U(250, 100, 25, 9));
  ok(same(u, [150, 60, 15]), "★续跑：只记这一趟多出来的★ 以前照单全加，记 250——前面几轮又算一遍", u);
  u = await cx("th-u1", "th-u1", U(400, 160, 40));
  ok(same(u, [150, 60, 15]), "再续一趟，照样只记差值", u);
  u = await cx("th-u1", "th-u1", null);
  ok(same(u, [0, 0, 0]), "这一趟没报 turn.completed：记 0，起算点不动", u);
  u = await cx("th-u1", "th-u1", U(550, 200, 55));
  ok(same(u, [150, 40, 15]), "下一趟接着上一次报过的数算", u);

  u = await cx("th-old", "th-old", U(5000, 1000, 300));
  ok(same(u, [0, 0, 0]), "★续跑一条以前的线程、找不到起算点：记 0★ 不拿整条线程的累计值充这一趟", u);
  u = await cx("th-old", "th-old", U(5200, 1100, 330));
  ok(same(u, [200, 100, 30]), "那一趟把起算点记下了，往后照常取差值", u);
  u = await cx("th-old", "th-old", U(100, 10, 5));
  ok(same(u, [0, 0, 0]), "累计值不增反减：记 0，不记负数", u);
  u = await cx("th-old", "th-old", U(160, 20, 9));
  ok(same(u, [60, 10, 4]), "起算点换成那次报的，往后照常", u);
  u = await cx("th-u2", null, U(70, 0, 7));
  ok(same(u, [70, 0, 7]), "另一条新线程从 0 算，不受别的线程影响", u);

  const baseDir = path.join(process.env.OPENWORKBUDDY_HOME, "data", "runtime", "codex-usage");
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(path.join(baseDir, "th-u1.json"), "utf8")); } catch {}
  ok(same(saved, U(550, 200, 55)), "起算点记在应用自己的数据目录里，是最后一次报的累计值", saved);
  const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name])); } catch { return []; } };
  const codexHome = path.join(process.env.OPENWORKBUDDY_HOME, "data", "runtime", "codex");
  ok(![...walk(srcHome), ...walk(codexHome)].includes("th-u1.json"), "没往 codex 自己的目录里写");
  try { await cx("../../evil", "../../evil", U(10, 0, 1)); } catch {}
  ok(!fs.existsSync(path.join(process.env.OPENWORKBUDDY_HOME, "data", "evil.json")) && !walk(path.join(process.env.OPENWORKBUDDY_HOME, "data")).includes("evil.json"),
    "线程 id 不像个 id（带 ../）：不拿它拼路径写文件");

  // 假 claude：一次调用（msg_1）拆成一段字、一个工具两条吐，带同一份 usage（输出数随写随涨）；
  // FAKE_RESULT 有就收尾报 result，没有就一直挂着等人按停止
  const ccBin = fakeBin("cc-usage", `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "s-usage" });
const asst = (id, u, content) => out({ type: "assistant", message: { id, usage: u, content } });
asst("msg_1", { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 3 }, [{ type: "text", text: "先看看" }]);
asst("msg_1", { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 }, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.txt" } }]);
asst("msg_2", { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 8 }, [{ type: "text", text: "好" }]);
if (process.env.FAKE_RESULT) out({ type: "result", subtype: "success", is_error: false, result: "好", num_turns: 4, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 2, output_tokens: 3 } });
else setInterval(() => {}, 1000);
`);
  {
    const ctrl = new AbortController();
    let steps = 0;
    const p = claude.run({ prompt: "hi", cwd: home, bin: ccBin, model: "sonnet", emit: (e) => { if (e.type === "step_start") steps++; }, stopSignal: ctrl.signal });
    ok(await until(() => steps >= 3), "假 claude 吐完三条 assistant");
    ctrl.abort();
    const r = await p;
    const got = [r.usage.prompt, r.usage.cached, r.usage.completion, r.usage.calls];
    ok(r.stopped === "已手动停止" && same(got, [335, 300, 15, 2]),
      "★按了停止、等不到 result：拿每次调用的用量兜底，同一个 message.id 只记一份★ 以前记 0", { stopped: r.stopped, got });
  }
  {
    const r = await claude.run({ prompt: "hi", cwd: home, bin: ccBin, model: "sonnet", env: { FAKE_RESULT: "1" } });
    const got = [r.usage.prompt, r.usage.cached, r.usage.completion, r.usage.calls];
    ok(same(got, [3, 2, 3, 4]), "等到了 result：以它为准（整趟的权威值），不跟前面几条叠加", got);
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
    await partGate();
    await partPath();
    await partReadOnly();
    await partUsage();
    console.log(`\n引擎韧性：${pass} 项全过`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.error("\n❌ " + e.message); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} process.exit(1); });
