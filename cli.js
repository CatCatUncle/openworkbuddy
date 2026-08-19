#!/usr/bin/env node
"use strict";
/**
 * OpenWorkBuddy CLI — 终端里直接跑 agent 任务，与 Web/IM 共用同一套运行时与配置。
 *
 * 用法：
 *   node cli.js "帮我调研xxx并写成报告"     # 单发任务，跑完即退出
 *   node cli.js                              # 交互式 REPL（连续对话，保留上下文）
 *   node cli.js --mode ask "这个报错什么意思"
 *   node cli.js --session s_xxx "接着上次做" # 续接指定会话（data/sessions/<id>.json）
 *   node cli.js --no-mcp "..."               # 跳过 MCP 连接，启动更快
 *
 * npm link 后可直接用 `wb "任务"`。
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { createLLM } = require("./llm");
const { setWorkspaceDir, getWorkspaceDir } = require("./tools");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const account = require("./account");
const store = require("./store");

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const opts = { mode: "craft", session: null, mcp: true };
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--mode") opts.mode = argv[++i] || "craft";
  else if (a === "--session") opts.session = argv[++i] || null;
  else if (a === "--no-mcp") opts.mcp = false;
  else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  else words.push(a);
}
const oneShot = words.join(" ").trim();

function printHelp() {
  console.log(`OpenWorkBuddy CLI
用法：
  wb "任务描述"                 单发任务
  wb                            交互式对话（/help 看内置命令）
选项：
  --mode craft|plan|ask         执行模式（默认 craft）
  --session <id>                续接指定会话
  --no-mcp                      跳过 MCP 连接器，启动更快`);
}

// ---------- 终端着色（非 TTY 时输出纯文本） ----------
const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const yellow = (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

// ---------- 配置与运行时（与 server.js 同源） ----------
const CONFIG_PATH = path.join(__dirname, "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(red("找不到 config.json，请先运行一次 npm start 生成，或从 config.example.json 复制。"));
  process.exit(1);
}
const config = store.readJson(CONFIG_PATH, {});
if (config.workspace_dir) {
  try { setWorkspaceDir(config.workspace_dir); } catch {}
}
const llm = createLLM(config);
const expertsDoc = store.readJson(path.join(__dirname, "experts.json"), {}) || {};
let experts = expertsDoc.experts || [];
let expertTeams = expertsDoc.teams || [];
const mcpManager = new McpManager();

// ---------- 会话持久化（与 server.js 同一目录同一结构） ----------
const SESS_DIR = path.join(__dirname, "data", "sessions");
const sessionId = opts.session || "cli_" + new Date().toISOString().slice(0, 10).replace(/-/g, "");
const sessFile = path.join(SESS_DIR, sessionId.replace(/[^\w-]/g, "_") + ".json");
// 跟网页端是同一批文件，写法也得一样：原子改名 + .bak，坏了先回退别直接覆盖
let sess = store.readJson(sessFile, { history: [], transcript: [], title: "" });
function saveSess() {
  sess.updated_at = new Date().toISOString();
  store.writeJsonAtomic(sessFile, sess);
}

// ---------- 事件渲染 ----------
function makeEmit(state) {
  return (ev) => {
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      if (!state.streamed) { process.stdout.write("\n"); state.streamed = true; }
      process.stdout.write(ev.delta);
    } else if (ev.type === "step_start") {
      if (ev.depth === 0) process.stdout.write(dim(`\n· 第 ${ev.step} 步 思考中…`));
      state.streamed = false;
    } else if (ev.type === "parallel") {
      process.stdout.write(dim(`\n  ⚡ ${ev.count} 个只读工具并发执行`));
      state.streamed = false;
    } else if (ev.type === "tool_use") {
      const who = ev.expert ? `${ev.expert} · ` : "";
      process.stdout.write(dim(`\n  ⚙ ${who}${ev.name}${ev.purpose ? `（${String(ev.purpose).slice(0, 60)}）` : ""}`));
      state.lastToolId = ev.id;
      state.streamed = false;
    } else if (ev.type === "tool_result") {
      // 并发跑的时候回来的顺序不一定，勾不能盲目贴在最后一行——那是别人的行
      if (ev.id && state.lastToolId !== ev.id) process.stdout.write(dim(`\n  ⚙ ${ev.name}`));
      process.stdout.write(ev.isError ? red(" ✗") : green(" ✓"));
      state.lastToolId = null;
      if (ev.isError && ev.preview) process.stdout.write(dim("\n    " + String(ev.preview).slice(0, 200).replace(/\n/g, " ")));
    } else if (ev.type === "expert_start") {
      process.stdout.write(yellow(`\n  👥 委派专家「${ev.expert}」`) + dim(`：${String(ev.task || "").slice(0, 60)}`));
    } else if (ev.type === "limit") {
      process.stdout.write(yellow(`\n⏱ ${ev.note}，任务强制收尾`));
    } else if (ev.type === "usage") {
      state.usage = ev;
    } else if (ev.type === "files") {
      state.files = ev.files || state.files;
    }
  };
}

function printSummary(state) {
  process.stdout.write("\n");
  if (state.usage) {
    const u = state.usage;
    const secs = Math.round((u.elapsed_ms || 0) / 1000);
    console.log(dim(`\n✧ 共消耗 ${(u.prompt + u.completion).toLocaleString()} tokens（输入 ${u.prompt.toLocaleString()} / 输出 ${u.completion.toLocaleString()}）· ${u.calls} 次调用 · ${secs}s · ${u.provider}（${u.model}）`));
  }
  if (state.credits && state.credits.spent > 0) {
    console.log(dim(`✦ 本次扣 ${state.credits.spent} 积分 · 余额 ${state.credits.balance.toLocaleString()}`));
  }
  if (state.files && state.files.length) {
    console.log(dim(`📁 工作目录 ${getWorkspaceDir()}：`) + state.files.slice(-8).map((f) => f.name).join("、"));
  }
}

// ---------- 执行一轮任务（Ctrl+C 停止当前任务而不是直接退出） ----------
async function runOnce(runtime, text, mode) {
  // 积分闸门：默认是关的（本地个人用不限额），开了才拦。CLI 消耗记在管理员（首个注册用户）名下
  const owner = account.defaultUser();
  if (owner && account.creditsEnabled() && owner.credits <= 0) {
    console.error(red(`积分不足（${owner.username} 余额 0）：去 Web 端「账号 · 用量」里充值，或者把「积分限额」关掉。`));
    return;
  }
  sess.history.push({ role: "user", content: text });
  if (!sess.title) sess.title = text.slice(0, 24);
  const state = { streamed: false, usage: null, files: null };
  const ctrl = new AbortController();
  const onSigint = () => {
    process.stdout.write(yellow("\n（收到 Ctrl+C，正在停止任务…再按一次强制退出）\n"));
    ctrl.abort();
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onSigint);
  let finalText = "";
  try {
    const r = await runtime.runTask({
      history: sess.history,
      emit: makeEmit(state),
      mode: ["ask", "plan", "craft"].includes(mode) ? mode : "craft",
      user: owner ? owner.username : undefined, // 记忆按人取，命令行走管理员这本账
      stopSignal: ctrl.signal,
    });
    finalText = r.finalText || "";
  } catch (e) {
    console.error(red(`\n出错了：${e.message}`));
  }
  process.removeListener("SIGINT", onSigint);
  // 落盘：Web 端打开该会话也能回放（最终文本 + 用量）
  sess.transcript.push({ type: "user", text, mode });
  const events = [];
  if (finalText) events.push({ type: "text", delta: finalText });
  if (state.usage) events.push(state.usage);
  sess.transcript.push({ type: "assistant", events });
  saveSess();
  // 记账：与 Web 端同一本账（data/usage.json）
  if (owner && state.usage && state.usage.calls > 0) {
    const spent = account.chargeRun(owner, { ...state.usage, source: "cli", sessionId });
    state.credits = { spent, balance: owner.credits };
  }
  printSummary(state);
}

// ---------- 主流程 ----------
(async () => {
  if (!oneShot && !process.stdin.isTTY) { printHelp(); process.exit(1); }
  if (opts.mcp && (config.mcp_servers || []).length) {
    process.stdout.write(dim(`连接 MCP（${config.mcp_servers.length} 个，--no-mcp 可跳过）… `));
    await mcpManager.startAll(config.mcp_servers);
    console.log(dim(`${mcpManager.toolDefs().length} 个工具`));
  }
  const runtime = createAgentRuntime({ config, llm, mcpManager, experts, expertTeams });
  console.log(dim(`模型 ${llm.provider}（${llm.model}）· 模式 ${opts.mode} · 工作目录 ${getWorkspaceDir()}${opts.session ? ` · 会话 ${sessionId}` : ""}`));

  if (oneShot) {
    await runOnce(runtime, oneShot, opts.mode);
    mcpManager.stopAll();
    process.exit(0);
  }

  // ---- REPL ----
  console.log(bold("OpenWorkBuddy CLI 交互模式") + dim("（/mode 切模式 /new 清上下文 /files 看成果 /exit 退出）"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((ok) => rl.question(tty ? "\x1b[36mwb>\x1b[0m " : "wb> ", ok));
  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") { printHelp(); continue; }
    if (line.startsWith("/mode")) {
      const m = line.split(/\s+/)[1];
      if (["ask", "plan", "craft"].includes(m)) { opts.mode = m; console.log(dim(`已切到 ${m} 模式`)); }
      else console.log(dim(`当前 ${opts.mode}；用法 /mode craft|plan|ask`));
      continue;
    }
    if (line === "/new") { sess = { history: [], transcript: [], title: "" }; console.log(dim("上下文已清空")); continue; }
    if (line === "/files") {
      try { console.log(fs.readdirSync(getWorkspaceDir()).filter((f) => !f.startsWith(".")).join("\n") || dim("（空）")); } catch {}
      continue;
    }
    await runOnce(runtime, line, opts.mode);
  }
  rl.close();
  mcpManager.stopAll();
  process.exit(0);
})();
