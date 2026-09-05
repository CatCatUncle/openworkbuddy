#!/usr/bin/env node
"use strict";
/**
 * OpenWorkBuddy CLI — 终端里直接跑 agent 任务，与 Web/IM 共用同一套运行时与配置。
 *
 * 用法：
 *   wb "帮我调研xxx并写成报告"                 单发任务，跑完即退出
 *   wb                                          交互式 REPL（连续对话，保留上下文）
 *   wb -C ~/项目/报表 "把这个目录的表汇总一下"   指定这次在哪个目录干活
 *   cat err.log | wb "这个报错什么意思"          管道进来的内容当附加材料
 *   wb -c "接着上面那个继续"                     续接最近一次 CLI 会话
 *   wb --json "..." | jq -r 'select(.type=="text").delta'   机器可读事件流
 *
 * 两条约定，都是为了能塞进管道和脚本：
 *   1. **模型的回答走 stdout，进度和日志走 stderr。** 所以 `wb "..." > 答案.md` 拿到的是
 *      干净的答案，不会混进「第 3 步 思考中…」那些行。
 *   2. **退出码说实话**：正常 0，任务出错 1，Ctrl+C 打断 130。以前无论如何都返回 0，
 *      `wb ... && 下一步` 在任务失败时照样往下走。
 *
 * npm link 后可直接用 `wb "任务"`。
 */

const fs = require("fs");
const path = require("path");
const { dataPath, preferData } = require("./paths");
const readline = require("readline");
const { createLLM } = require("./llm");
const { setWorkspaceDir, getWorkspaceDir } = require("./tools");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const account = require("./account");
const store = require("./store");

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const opts = { mode: "craft", session: null, mcp: true, workspace: null, cont: false, json: false, quiet: false, list: 0 };
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--mode") opts.mode = argv[++i] || "craft";
  else if (a === "--session") opts.session = argv[++i] || null;
  else if (a === "-c" || a === "--continue") opts.cont = true;
  else if (a === "-C" || a === "--workspace") opts.workspace = argv[++i] || null;
  else if (a === "--no-mcp") opts.mcp = false;
  else if (a === "--json") opts.json = true;
  else if (a === "-q" || a === "--quiet") opts.quiet = true;
  else if (a === "--list") { opts.list = Number(argv[i + 1]) > 0 ? Number(argv[++i]) : 10; }
  else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
  else words.push(a);
}
let oneShot = words.join(" ").trim();

function printHelp() {
  console.log(`OpenWorkBuddy CLI
用法：
  wb "任务描述"                 单发任务（每次都是干净上下文）
  wb                            交互式对话（/help 看内置命令）
  cat 文件 | wb "问题"          管道内容作为附加材料
选项：
  --mode craft|plan|ask         执行模式（默认 craft）
  -C, --workspace <dir>         这次在哪个目录干活（只影响本次，不改配置）
  -c, --continue                续接最近一次 CLI 会话
  --session <id>                续接指定会话
  --list [n]                    列出最近 n 个 CLI 会话（默认 10）
  --json                        事件按 NDJSON 输出到 stdout，给脚本用
  -q, --quiet                   只输出最终答案，不打进度
  --no-mcp                      跳过 MCP 连接器，启动更快
说明：
  答案走 stdout，进度走 stderr；退出码 0=成功 1=出错 130=Ctrl+C 打断。`);
}

// ---------- 输出通道 ----------
// 着色只在「那一头真的是终端」时才加：answer 判 stdout，progress 判 stderr。
// 两个可能一个是 tty 一个被重定向，共用一个 isTTY 会往管道里塞转义序列。
const ttyErr = process.stderr.isTTY;
const dim = (s) => (ttyErr ? `\x1b[2m${s}\x1b[0m` : s);
const yellow = (s) => (ttyErr ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (ttyErr ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (ttyErr ? `\x1b[32m${s}\x1b[0m` : s);
const bold = (s) => (ttyErr ? `\x1b[1m${s}\x1b[0m` : s);
/** 进度/诊断：一律 stderr，且 --quiet / --json 下彻底闭嘴 */
const prog = (s) => { if (!opts.quiet && !opts.json) process.stderr.write(s); };
/** 模型的回答：stdout，--json 下改走事件流 */
const answer = (s) => { if (!opts.json) process.stdout.write(s); };
/** 机器可读事件流 */
const emitJson = (o) => { if (opts.json) process.stdout.write(JSON.stringify(o) + "\n"); };

// ---------- 配置与运行时（与 server.js 同源） ----------
const CONFIG_PATH = dataPath("config.json");
if (!fs.existsSync(CONFIG_PATH)) {
  process.stderr.write(red("找不到 config.json，请先运行一次 npm start 生成，或从 config.example.json 复制。\n"));
  process.exit(1);
}
const config = store.readJson(CONFIG_PATH, {});
// -C 优先于配置：命令行是「这一次」的意思，不该把配置文件改掉
const wantWorkspace = opts.workspace || config.workspace_dir;
if (wantWorkspace) {
  try { setWorkspaceDir(wantWorkspace); }
  catch (e) {
    // 显式传了 -C 却用不了，那是命令写错了，得当场停——默默退回默认目录会把文件写到别处
    if (opts.workspace) { process.stderr.write(red(`工作目录用不了：${e.message}\n`)); process.exit(1); }
  }
}

// 运行时三件套：模型、专家、MCP。与 server.js 读同一批文件，CLI 不另立一套配置
const llm = createLLM(config);
const expertsDoc = store.readJson(preferData("experts.json"), {}) || {};
const experts = expertsDoc.experts || [];
const expertTeams = expertsDoc.teams || [];
const mcpManager = new McpManager();

// ---------- 会话持久化（与 server.js 同一目录同一结构） ----------
const SESS_DIR = dataPath("data", "sessions");
const sessFileOf = (id) => path.join(SESS_DIR, String(id).replace(/[^\w-]/g, "_") + ".json");
/** 列最近的 CLI 会话，新的在前 */
function listCliSessions(n) {
  let names = [];
  try { names = fs.readdirSync(SESS_DIR).filter((f) => f.startsWith("cli_") && f.endsWith(".json")); } catch { return []; }
  return names
    .map((f) => {
      const p = path.join(SESS_DIR, f);
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
      const j = store.readJson(p, {}) || {};
      // 轮数按「问了几次」算：transcript 里一问一答是两条，直接数长度会把一次问答报成 2 轮
      const turns = (j.transcript || []).filter((t) => t && t.type === "user").length;
      return { id: f.replace(/\.json$/, ""), mtime, title: j.title || "", turns };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n);
}
/** 新会话 id：带到秒 + 三位随机。
 *  以前是 `cli_YYYYMMDD`，同一天的每条命令共用一个文件，而 runTask 会把助手回复和工具结果
 *  就地追加进 history —— 于是「单发任务」其实拖着当天所有前一条任务的完整上下文，
 *  既烧 token 又让模型在别的任务的阴影里答新问题。默认改成一次一个。 */
function newSessionId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `cli_${stamp}_${Math.random().toString(36).slice(2, 5)}`;
}
let sessionId = opts.session || (opts.cont && (listCliSessions(1)[0] || {}).id) || newSessionId();
if (opts.cont && !opts.session && !listCliSessions(1).length) prog(dim("（没有可续接的 CLI 会话，开一个新的）\n"));
let sessFile = sessFileOf(sessionId);
// 跟网页端是同一批文件，写法也得一样：原子改名 + .bak，坏了先回退别直接覆盖
let sess = store.readJson(sessFile, { history: [], transcript: [], title: "" });
function saveSess() {
  sess.updated_at = new Date().toISOString();
  store.writeJsonAtomic(sessFile, sess);
}

// ---------- 事件渲染 ----------
function makeEmit(state) {
  return (ev) => {
    if (opts.json) {
      // 事件原样出去，只把 files 这类大字段留给调用方自己挑
      emitJson(ev);
      if (ev.type === "text" && ev.depth === 0) state.finalParts.push(ev.delta);
      if (ev.type === "usage") state.usage = ev;
      if (ev.type === "files") state.files = ev.files || state.files;
      return;
    }
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      // 这个空行是用来跟上面的进度隔开的；-q / 没进度可打的时候没东西要隔，
      // 再吐一个就是往重定向出来的文件里塞前导空行。
      if (!state.streamed) { if (!opts.quiet) answer("\n"); state.streamed = true; }
      state.finalParts.push(ev.delta); // 收尾要看正文是不是已经以换行结束，所以流式这条也得记下来
      answer(ev.delta);
    } else if (ev.type === "step_start") {
      if (ev.depth === 0) prog(dim(`\n· 第 ${ev.step} 步 思考中…`));
      state.streamed = false;
    } else if (ev.type === "parallel") {
      prog(dim(`\n  ⚡ ${ev.count} 个只读工具并发执行`));
      state.streamed = false;
    } else if (ev.type === "tool_use") {
      const who = ev.expert ? `${ev.expert} · ` : "";
      prog(dim(`\n  ⚙ ${who}${ev.name}${ev.purpose ? `（${String(ev.purpose).slice(0, 60)}）` : ""}`));
      state.lastToolId = ev.id;
      state.streamed = false;
    } else if (ev.type === "tool_result") {
      // 并发跑的时候回来的顺序不一定，勾不能盲目贴在最后一行——那是别人的行
      if (ev.id && state.lastToolId !== ev.id) prog(dim(`\n  ⚙ ${ev.name}`));
      prog(ev.isError ? red(" ✗") : green(" ✓"));
      state.lastToolId = null;
      if (ev.isError && ev.preview) prog(dim("\n    " + String(ev.preview).slice(0, 200).replace(/\n/g, " ")));
    } else if (ev.type === "expert_start") {
      prog(yellow(`\n  👥 委派专家「${ev.expert}」`) + dim(`：${String(ev.task || "").slice(0, 60)}`));
    } else if (ev.type === "limit") {
      prog(yellow(`\n⏱ ${ev.note}，任务强制收尾`));
    } else if (ev.type === "usage") {
      state.usage = ev;
    } else if (ev.type === "files") {
      state.files = ev.files || state.files;
    }
  };
}

function printSummary(state) {
  if (opts.json) {
    emitJson({ type: "done", ok: !state.error, error: state.error || null, session: sessionId,
      usage: state.usage || null, credits: state.credits || null,
      files: (state.files || []).map((f) => f.name), workspace: getWorkspaceDir() });
    return;
  }
  // 收尾补一个换行让文本文件规规矩矩地结束；正文自己已经以换行收尾就别再补一个
  if (!/\n$/.test(state.finalParts.join(""))) answer("\n");
  if (state.usage) {
    const u = state.usage;
    const secs = Math.round((u.elapsed_ms || 0) / 1000);
    prog(dim(`\n✧ 共消耗 ${(u.prompt + u.completion).toLocaleString()} tokens（输入 ${u.prompt.toLocaleString()} / 输出 ${u.completion.toLocaleString()}）· ${u.calls} 次调用 · ${secs}s · ${u.provider}（${u.model}）\n`));
  }
  if (state.credits && state.credits.spent > 0) {
    prog(dim(`✦ 本次扣 ${state.credits.spent} 积分 · 余额 ${state.credits.balance.toLocaleString()}\n`));
  }
  if (state.files && state.files.length) {
    prog(dim(`📁 工作目录 ${getWorkspaceDir()}：`) + dim(state.files.slice(-8).map((f) => f.name).join("、")) + "\n");
  }
}

// ---------- 执行一轮任务（Ctrl+C 停止当前任务而不是直接退出） ----------
/** @returns {"ok"|"error"|"aborted"} 给退出码用 */
async function runOnce(runtime, text, mode) {
  // 积分闸门：默认是关的（本地个人用不限额），开了才拦。CLI 消耗记在管理员（首个注册用户）名下
  const owner = account.defaultUser();
  if (owner && account.creditsEnabled() && owner.credits <= 0) {
    process.stderr.write(red(`积分不足（${owner.username} 余额 0）：去 Web 端「账号 · 用量」里充值，或者把「积分限额」关掉。\n`));
    return "error";
  }
  sess.history.push({ role: "user", content: text });
  if (!sess.title) sess.title = text.slice(0, 24);
  const state = { streamed: false, usage: null, files: null, finalParts: [], error: null };
  const ctrl = new AbortController();
  let aborted = false;
  const onSigint = () => {
    aborted = true;
    prog(yellow("\n（收到 Ctrl+C，正在停止任务…再按一次强制退出）\n"));
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
    state.error = e.message;
    process.stderr.write(red(`\n出错了：${e.message}\n`));
  }
  process.removeListener("SIGINT", onSigint);
  // --json 下正文没走 stdout，最终文本从事件里攒回来，落盘的内容两种模式必须一样
  if (!finalText && state.finalParts.length) finalText = state.finalParts.join("");
  // 落盘：Web 端打开该会话也能回放（最终文本 + 用量）
  sess.transcript.push({ type: "user", text, mode, at: new Date().toISOString() });
  const events = [];
  if (finalText) events.push({ type: "text", delta: finalText });
  if (state.usage) events.push(state.usage);
  sess.transcript.push({ type: "assistant", events, at: new Date().toISOString() });
  saveSess();
  // 记账：与 Web 端同一本账（data/usage.json）
  if (owner && state.usage && state.usage.calls > 0) {
    const spent = account.chargeRun(owner, { ...state.usage, source: "cli", sessionId });
    state.credits = { spent, balance: owner.credits };
  }
  printSummary(state);
  return aborted ? "aborted" : state.error ? "error" : "ok";
}

/** 管道进来的内容。没接管道（stdin 是终端）就返回空串，绝不阻塞等输入。 */
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}
const STDIN_MAX = 200000; // 再多就不是「材料」是「数据集」了，该让 agent 自己去读文件

// ---------- 主流程 ----------
(async () => {
  if (opts.list) {
    const rows = listCliSessions(opts.list);
    if (!rows.length) { process.stdout.write("（还没有 CLI 会话）\n"); process.exit(0); }
    for (const r of rows) {
      // 本地时间。toISOString() 给的是 UTC，跟会话 id 里那串本地时间戳差一个时区，
      // 同一个会话在 id 上写着 17:36、在列表里显示 09:36，照时间挑会挑错。
      const d = new Date(r.mtime), q = (n) => String(n).padStart(2, "0");
      const when = `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())} ${q(d.getHours())}:${q(d.getMinutes())}`;
      process.stdout.write(`${r.id}  ${when}  ${String(r.turns).padStart(3)} 轮  ${r.title}\n`);
    }
    process.stdout.write(dim(`\n续接：wb --session <id> "接着做…"，或 wb -c 直接接最近这个\n`));
    process.exit(0);
  }

  // 管道：有任务描述时当附加材料，没有时管道内容本身就是任务（wb < 任务.txt）
  const piped = await readStdin();
  if (piped.trim()) {
    const body = piped.length > STDIN_MAX
      ? piped.slice(0, STDIN_MAX) + `\n…（标准输入共 ${piped.length} 字符，这里只截了前 ${STDIN_MAX} 个）`
      : piped;
    oneShot = oneShot
      ? `${oneShot}\n\n---\n以下是从标准输入读到的内容：\n\n${body}`
      : body.trim();
  }
  if (!oneShot && !process.stdin.isTTY) { printHelp(); process.exit(1); }

  if (opts.mcp && (config.mcp_servers || []).length) {
    prog(dim(`连接 MCP（${config.mcp_servers.length} 个，--no-mcp 可跳过）… `));
    await mcpManager.startAll(config.mcp_servers);
    prog(dim(`${mcpManager.toolDefs().length} 个工具\n`));
  }
  const runtime = createAgentRuntime({ config, llm, mcpManager, experts, expertTeams });
  prog(dim(`模型 ${llm.provider}（${llm.model}）· 模式 ${opts.mode} · 工作目录 ${getWorkspaceDir()} · 会话 ${sessionId}\n`));

  if (oneShot) {
    const r = await runOnce(runtime, oneShot, opts.mode);
    mcpManager.stopAll();
    process.exit(r === "ok" ? 0 : r === "aborted" ? 130 : 1);
  }

  // ---- REPL ----
  prog(bold("OpenWorkBuddy CLI 交互模式") + dim("（/mode 切模式 /new 开新会话 /files 看成果 /cd 换目录 /exit 退出）\n"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((ok) => rl.question(ttyErr ? "\x1b[36mwb>\x1b[0m " : "wb> ", ok));
  let last = "ok";
  for (;;) {
    const line = (await ask()).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") { printHelp(); continue; }
    if (line.startsWith("/mode")) {
      const m = line.split(/\s+/)[1];
      if (["ask", "plan", "craft"].includes(m)) { opts.mode = m; prog(dim(`已切到 ${m} 模式\n`)); }
      else prog(dim(`当前 ${opts.mode}；用法 /mode craft|plan|ask\n`));
      continue;
    }
    if (line === "/new") {
      // 换一个新会话文件，而不是把当前这个清空后覆盖回去——刚才那段对话是资料，不该被顺手抹掉
      sessionId = newSessionId();
      sessFile = sessFileOf(sessionId);
      sess = { history: [], transcript: [], title: "" };
      prog(dim(`开了新会话 ${sessionId}（刚才那段还在，wb --session 可以翻回去）\n`));
      continue;
    }
    if (line === "/session") { prog(dim(`${sessionId}\n${sessFile}\n`)); continue; }
    if (line.startsWith("/cd")) {
      const d = line.slice(3).trim();
      if (!d) { prog(dim(`当前工作目录 ${getWorkspaceDir()}\n`)); continue; }
      try { setWorkspaceDir(d); prog(dim(`工作目录换到 ${getWorkspaceDir()}\n`)); }
      catch (e) { prog(red(`换不过去：${e.message}\n`)); }
      continue;
    }
    if (line === "/files") {
      try { process.stdout.write((fs.readdirSync(getWorkspaceDir()).filter((f) => !f.startsWith(".")).join("\n") || "（空）") + "\n"); } catch {}
      continue;
    }
    last = await runOnce(runtime, line, opts.mode);
  }
  rl.close();
  mcpManager.stopAll();
  process.exit(last === "ok" ? 0 : last === "aborted" ? 130 : 1);
})();
