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
 *
 * 引擎全是本地假的，不出网。
 *   node test/engine-resilience.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
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
  const claude = require(path.join(ROOT, "engines", "claude-code"));
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

async function partKill() {
  console.log("\n— ② 按停止当场杀、硬退出一把收 —");
  const { runJsonl, killAll } = require(path.join(ROOT, "engines", "jsonl"));
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
  const bridge = path.join(ROOT, "engines", "bridge.js");
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
  const engines = require(path.join(ROOT, "engines"));
  const { createAgentRuntime } = require(path.join(ROOT, "agent"));
  const { McpManager } = require(path.join(ROOT, "mcp"));
  const llm = require(path.join(ROOT, "llm")).createLLM({ models: [{ name: "桩", provider: "openai", base_url: "http://127.0.0.1:9/v1", api_key: "sk-test-offline", model: "mock", stream: false }] });

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
    await partKill();
    partTempDirs();
    await partStaleResume();
    console.log(`\n引擎韧性：${pass} 项全过`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.error("\n❌ " + e.message); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} process.exit(1); });
