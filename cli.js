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

// Node 太老 / 依赖没装：排在所有 require 最前面，不然用户拿到的是一句 Cannot find module
require("./boot-check").enforce({ rootDir: __dirname });
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dataPath, preferData } = require("./paths");
const readline = require("readline");
const { createLLM } = require("./llm");
const { setWorkspaceDir, getWorkspaceDir } = require("./tools");
const { McpManager } = require("./mcp");
const { createAgentRuntime } = require("./agent");
const lanes = require("./lanes"); // 终端里起的任务归「工程」线；续跑 id 按引擎分开记
const callout = require("./callout"); // 正文里的提示条：终端没有图标，换成文字标签
const cliLive = require("./cli-live"); // 把这趟活儿播给网页/手机：看得见、插得上话
const account = require("./account");
const store = require("./store");

// ---------- 参数解析 ----------
// 解析规则和帮助文本都在 cli-args.js 的那张声明表里，它是纯的：认不出来的选项会
// 原样报回来，由这儿决定怎么说、退出码给几。以前是一串 else if，认不出的词一律
// 当任务文本塞给模型——拼错一个 --quiet，钱照花、进度照打，人还以为自己关掉了。
const cliArgs = require("./cli-args");
const parsed = cliArgs.parse(process.argv.slice(2));
const opts = parsed.opts;
const words = parsed.words;

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

// ---------- 帮助 / 版本 / 参数写错了 ----------
if (opts.help) { console.log(cliArgs.helpText()); process.exit(0); }
if (opts.version) { console.log(`OpenWorkBuddy ${require("./package.json").version}`); process.exit(0); }
if (parsed.problems.length) {
  // 退出码 2 单独留给「参数写错了」：脚本里能跟「任务失败」分开处理，
  // 也免得 `wb --qiet ... && 下一步` 在打错字的时候照样往下走
  process.stderr.write(red(cliArgs.problemText(parsed.problems)));
  process.stderr.write(dim("wb --help 看全部用法。\n"));
  process.exit(2);
}

// 子命令。动词式的写法（wb resume / wb sessions / wb engines）是给人记的，
// 老的 --session / --list / -c 一个都没动，脚本不用改。
let sub = "";
if (cliArgs.SUBS.some((x) => x.name === words[0])) {
  sub = words.shift();
  // 会话 id 有固定前缀（cli_ 是命令行开的，s_ 是桌面开的），认得出就当 id，认不出就当任务描述
  if (sub === "resume" && words[0] && /^(cli_|s_)/.test(words[0])) opts.session = words.shift();
  if (sub === "sessions") opts.list = Number(words[0]) > 0 ? Number(words.shift()) : opts.list || 10;
}
let oneShot = words.join(" ").trim();

// ---------- 配置与运行时（与 server.js 同源） ----------
const CONFIG_PATH = dataPath("config.json");
// wb doctor 是个例外：它就是用来查「为什么什么都没配好」的，在这儿把它拦下等于
// 把唯一一根救命稻草也收走。别的命令照旧当场停——没有配置它们干不了活。
if (!fs.existsSync(CONFIG_PATH) && sub !== "doctor") {
  process.stderr.write(red("找不到 config.json，请先运行一次 npm start 生成，或从 config.example.json 复制。\n"));
  process.stderr.write(dim("不确定是哪儿不对的话，先跑一句 wb doctor。\n"));
  process.exit(1);
}
const config = store.readJson(CONFIG_PATH, {});

// ---------- wb doctor：跑不起来时的一次性体检 ----------
// 位置很讲究：必须排在下面 createLLM 前面。模型一个都没配的机器上 createLLM 当场抛
// 「未知 provider: undefined」——而那恰恰是最需要体检的时刻，体检工具自己先死没有道理。
if (sub === "doctor") {
  const doctor = require("./doctor");
  const paint = { ok: green, warn: yellow, bad: red, dim };
  (async () => {
    const items = await doctor.gather({
      paths: require("./paths"),
      config,
      engines: require("./engines"),
      workspaceDir: opts.workspace || config.workspace_dir || getWorkspaceDir(),
      bootCheck: require("./boot-check"),
    });
    process.stdout.write(doctor.render(items, (t, lv) => (paint[lv] || ((x) => x))(t)));
    // 退出码说实话：有要处理的就 1，好写进安装脚本和 CI（wb doctor && npm start）
    process.exit(doctor.worst(items) >= doctor.LEVELS.bad ? 1 : 0);
  })();
  return; // CommonJS 的模块体本身就是个函数，这行是合法的「到此为止」，下面那一整套运行时不用再起
}
/** 设置里挑的那个底层引擎。命令行没有登录态，取不到个人偏好，读的就是这份全局配置 */
const cfgEngine = () => String((config.agent || {}).engine || "builtin").trim() || "builtin";
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
/**
 * 列最近的会话，新的在前。
 *
 * 默认把桌面端的会话一起列出来 —— 桌面和命令行写的本来就是同一批文件
 * （data/sessions/<id>.json，同一套字段），只列 cli_ 开头那半边，等于人为把
 * 「早上在桌面开了个头，下午想在终端接着做」这条路堵死。
 * @param {number} n
 * @param {boolean} [cliOnly] 只看命令行自己开的（-c 续接时用，免得接到桌面那边正开着的会话）
 */
function listCliSessions(n, cliOnly = false) {
  let names = [];
  try { names = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  if (cliOnly) names = names.filter((f) => f.startsWith("cli_"));
  return names
    .map((f) => {
      const p = path.join(SESS_DIR, f);
      let mtime = 0; try { mtime = fs.statSync(p).mtimeMs; } catch {}
      const j = store.readJson(p, {}) || {};
      // 轮数按「问了几次」算：transcript 里一问一答是两条，直接数长度会把一次问答报成 2 轮
      const turns = (j.transcript || []).filter((t) => t && t.type === "user").length;
      const id = f.replace(/\.json$/, "");
      return { id, mtime, title: j.title || "", turns, from: id.startsWith("cli_") ? "命令行" : "桌面", engine: j.engine || "" };
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
// wb resume 不给 id = 接最近动过的那个，不管它是在桌面开的还是命令行开的。
// 这是"丝滑切换"的落点：桌面上做到一半，终端里 wb resume 就能接着往下走。
if (sub === "resume" && !opts.session) {
  const last = listCliSessions(1)[0];
  if (!last) { process.stderr.write(red("没有可续接的会话。先跑一次 wb \"任务\" 或在桌面端聊一句。\n")); process.exit(1); }
  opts.session = last.id;
  prog(dim(`（续接 ${last.from}会话 ${last.id}：${last.title || "无标题"}）\n`));
}
let sessionId = opts.session || (opts.cont && (listCliSessions(1, true)[0] || {}).id) || newSessionId();
if (opts.cont && !opts.session && !listCliSessions(1, true).length) prog(dim("（没有可续接的命令行会话，开一个新的）\n"));
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
    // 先播给网页/手机，再管终端怎么显示：这两件事互不相干，哪边坏了都不该拖累另一边
    if (state.live) state.live.event(ev);
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
      // 提示条是整条一次 emit 的（agent.js 那几处 callout.line），不会被切片切成半个记号
      const text = callout.strip(ev.delta);
      state.finalParts.push(text); // 收尾要看正文是不是已经以换行结束，所以流式这条也得记下来
      answer(text);
    } else if (ev.type === "step_start") {
      if (ev.depth === 0) prog(dim(`\n· 第 ${ev.step} 步 思考中…`));
      state.streamed = false;
    } else if (ev.type === "parallel") {
      prog(dim(`\n  ▸▸ ${ev.count} 个只读工具并发执行`));
      state.streamed = false;
    } else if (ev.type === "tool_use") {
      const who = ev.expert ? `${ev.expert} · ` : "";
      prog(dim(`\n  ▸ ${who}${ev.name}${ev.purpose ? `（${String(ev.purpose).slice(0, 60)}）` : ""}`));
      state.lastToolId = ev.id;
      state.streamed = false;
    } else if (ev.type === "tool_result") {
      // 并发跑的时候回来的顺序不一定，勾不能盲目贴在最后一行——那是别人的行
      if (ev.id && state.lastToolId !== ev.id) prog(dim(`\n  ▸ ${ev.name}`));
      prog(ev.isError ? red(" ✗") : green(" ✓"));
      state.lastToolId = null;
      if (ev.isError && ev.preview) prog(dim("\n    " + String(ev.preview).slice(0, 200).replace(/\n/g, " ")));
    } else if (ev.type === "status") {
      if (ev.depth === 0 || ev.depth === undefined) { prog(dim(`\n· ${ev.text}`)); state.streamed = false; }
    } else if (ev.type === "expert_start") {
      prog(yellow(`\n  ◆ 委派专家「${ev.expert}」`) + dim(`：${String(ev.task || "").slice(0, 60)}`));
    } else if (ev.type === "limit") {
      prog(yellow(`\n▲ ${ev.note}，任务强制收尾`));
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
    prog(dim(`▪ 工作目录 ${getWorkspaceDir()}：`) + dim(state.files.slice(-8).map((f) => f.name).join("、")) + "\n");
  }
}

// ---------- 执行一轮任务（Ctrl+C 停止当前任务而不是直接退出） ----------
/** 任务跑着的时候 = 停它的那个函数，空闲时 = null。交互模式的 Ctrl+C 从这儿调进去 */
let stopCurrent = null;
/** 终端里打的插话，下一步交给 agent。跟网页/手机上补的那句合并成一份 */
const termInterject = [];
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
  // 在终端里起的活儿归「工程」线。网页/手机上切到那个标签就能看见这条会话——
  // 这是两条线里唯一一条服务端替人填的：它确实是从命令行进来的，不是猜的。
  sess.lane = "cli";
  const state = { streamed: false, usage: null, files: null, finalParts: [], error: null };
  // 挂到实时目录上：网页端的「工程」标签就是靠它知道这台机器的终端里此刻在干什么
  const live = cliLive.announce({
    id: sessionId, title: sess.title || text.slice(0, 60), cwd: getWorkspaceDir(),
    mode, user: owner ? owner.username : "",
  });
  state.live = live;
  live.event({ type: "status", text: `终端里起了一趟活儿：${text.slice(0, 60)}` });
  // 心跳：模型想得久的时候一个事件都不出，光靠事件盖时间戳会被判成「这进程死了」
  const beatTimer = live.live ? setInterval(() => live.beat(), cliLive.BEAT_MS) : null;
  if (beatTimer && beatTimer.unref) beatTimer.unref();
  const ctrl = new AbortController();
  let aborted = false;
  const onSigint = () => {
    if (aborted) {
      // 第二次：不等了。收尾还是要做——MCP 那几个子进程是 spawn 出来的，
      // 不收就留在系统里，下次启动还会再起一批
      process.stderr.write(yellow("\n（不等了，直接退出）\n"));
      try { mcpManager.stopAll(); } catch {}
      process.exit(130);
    }
    aborted = true;
    prog(yellow("\n（收到 Ctrl+C，正在停止任务…再按一次直接退出）\n"));
    ctrl.abort();
  };
  // 单发模式走信号；交互模式下 readline 在终端里把 Ctrl+C 自己截住了，进程根本收不到，
  // 所以那边改从 stopCurrent 这个把手调进来——改写前那条路在交互模式下从来没通过
  process.on("SIGINT", onSigint);
  stopCurrent = onSigint;
  let finalText = "";
  try {
    const r = await runtime.runTask({
      history: sess.history,
      emit: makeEmit(state),
      mode: ["ask", "plan", "craft"].includes(mode) ? mode : "craft",
      user: owner ? owner.username : undefined, // 记忆按人取，命令行走管理员这本账
      stopSignal: ctrl.signal,
      // 底层 CLI 引擎的线程 id：跟会话存在一起，所以在桌面开的头能在这儿接着跑，反过来也一样
      engineSession: lanes.engineSessionFor(sess, cfgEngine()),
      // 网页/手机上补的那句话，在两步之间读走。终端这边也回显一下——
      // 不然坐在电脑前的人只会看见 agent 突然改了主意，不知道是有人从手机上插了一句
      getInterject: () => {
        const more = live.interjections();
        // 坐在电脑前的人也能插话：任务跑着的时候在终端里打的字排在 termInterject 里，
        // 跟手机上补的那句走同一个口子
        if (termInterject.length) more.push(...termInterject.splice(0));
        if (more.length) prog(yellow(`\n  » 收到插话：${more.join(" / ").slice(0, 120)}\n`));
        return more;
      },
    });
    if (r && r.sessionId) lanes.rememberEngineSession(sess, r.engine || cfgEngine(), r.sessionId);
    finalText = r.finalText || "";
  } catch (e) {
    state.error = e.message;
    process.stderr.write(red(`\n出错了：${e.message}\n`));
  }
  process.removeListener("SIGINT", onSigint);
  stopCurrent = null;
  if (beatTimer) clearInterval(beatTimer);
  live.finish({ error: state.error, title: sess.title });
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
  // ---------- wb engines：看本机能拿什么当底层，以及一键切过去 ----------
  if (sub === "engines") {
    const engines = require("./engines");
    const want = words[0] === "use" ? String(words[1] || "").trim() : "";
    if (words[0] === "use") {
      if (engines.get(want) === undefined) {
        process.stderr.write(red(`没有这个引擎：${want}。可选：${engines.list().map((b) => b.id).join(" / ")}\n`));
        process.exit(1);
      }
      if (want !== "builtin") {
        // 切过去之前先确认它真的装了。让用户以为切成功、下一次跑任务才报错，是最难查的那种坑
        const found = (await engines.detectAll((config.agent || {}).engine_options || {})).find((e) => e.id === want);
        if (!found || !found.installed) {
          const b = engines.get(want);
          process.stderr.write(red(`${b.label} 没装或跑不起来，没有切换。\n`) + dim(`装法：${b.install}\n`));
          process.exit(1);
        }
      }
      config.agent = config.agent || {};
      config.agent.engine = want;
      store.writeJsonAtomic(CONFIG_PATH, config, { pretty: true });
      process.stdout.write(green(`底层引擎已切到「${(engines.get(want) || engines.BUILTIN).label}」\n`));
      process.exit(0);
    }
    const cur = (config.agent || {}).engine || "builtin";
    const found = await engines.detectAll((config.agent || {}).engine_options || {});
    const rows = [{ ...engines.BUILTIN, installed: true, version: "" }, ...found];
    for (const e of rows) {
      const mark = e.id === cur ? green(" ●") : "  ";
      const state = e.id === "builtin" ? "" : e.installed ? green(`已装 ${e.version}`) : yellow("没装");
      process.stdout.write(`${mark} ${e.id.padEnd(12)} ${e.label}  ${state}\n`);
      process.stdout.write(dim(`     ${e.note}\n`));
      if (!e.installed && e.install) process.stdout.write(dim(`     装法：${e.install}\n`));
    }
    process.stdout.write(dim("\n切换：wb engines use <id>。选了本机 Claude Code / Codex，任务就跑在你已经付过钱的订阅上，不再消耗 API 额度。\n"));
    process.exit(0);
  }

  if (opts.list) {
    const rows = listCliSessions(opts.list);
    if (!rows.length) { process.stdout.write("（还没有任何会话）\n"); process.exit(0); }
    for (const r of rows) {
      // 本地时间。toISOString() 给的是 UTC，跟会话 id 里那串本地时间戳差一个时区，
      // 同一个会话在 id 上写着 17:36、在列表里显示 09:36，照时间挑会挑错。
      const d = new Date(r.mtime), q = (n) => String(n).padStart(2, "0");
      const when = `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())} ${q(d.getHours())}:${q(d.getMinutes())}`;
      process.stdout.write(`${r.id}  ${when}  ${r.from}  ${String(r.turns).padStart(3)} 轮  ${r.title}${r.engine ? dim("  [" + r.engine + "]") : ""}\n`);
    }
    process.stdout.write(dim(`\n续接：wb resume <id> "接着做…"；不给 id 就接最近动过的那个（桌面开的也能接）\n`));
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
  if (!oneShot && !process.stdin.isTTY) { console.log(cliArgs.helpText()); process.exit(1); }

  if (opts.mcp && (config.mcp_servers || []).length) {
    prog(dim(`连接 MCP（${config.mcp_servers.length} 个，--no-mcp 可跳过）… `));
    await mcpManager.startAll(config.mcp_servers);
    prog(dim(`${mcpManager.toolDefs().length} 个工具\n`));
  }
  const runtime = createAgentRuntime({ config, llm, mcpManager, experts, expertTeams });
  const engineId = (config.agent || {}).engine || "builtin";
  const engineBackend = require("./engines").get(engineId);
  const who = engineBackend ? `底层 ${engineBackend.label}` + green("（不花 API 额度）") : `模型 ${llm.provider}（${llm.model}）`;
  prog(dim(`${who} · 模式 ${opts.mode} · 工作目录 ${getWorkspaceDir()} · 会话 ${sessionId}\n`));

  if (oneShot) {
    const r = await runOnce(runtime, oneShot, opts.mode);
    mcpManager.stopAll();
    process.exit(r === "ok" ? 0 : r === "aborted" ? 130 : 1);
  }

  // ---- REPL ----
  // 这一段是重写过的。改写前有四样毛病，在健康机器上一个都不报错，只是悄悄办错事：
  //   1. 粘贴多行只进去第一行——readline 一个换行一个 line 事件，rl.question 一次只接一条，
  //      剩下的没人接、静默丢掉（实测贴 4 行进去，循环只收到 1 行）。
  //   2. Ctrl+C 停不掉任务——终端模式下 readline 自己把 Ctrl+C 截走了，
  //      runOnce 里那句 process.once("SIGINT") 在交互模式下从来没被调用过。
  //   3. 打错的斜杠命令（/exi、/moe）整行当任务发给模型，钱花了事没办。
  //   4. Ctrl+D 之后等在 question 上的 Promise 永远不 resolve，MCP 子进程跟着挂死。
  // 现在一行输入先过 repl-commands 那张纯表，再由这儿决定怎么说、怎么做。
  const repl = require("./repl-commands");
  const PROMPT = ttyErr ? "\x1b[36mwb>\x1b[0m " : "wb> ";
  const HIST_FILE = dataPath("data", "cli-history.txt");
  const loadHistory = () => {
    // 文件里老的在前（跟 bash 一样，人直接 cat 也顺眼），readline 要的是新的在前
    try { return repl.sanitizeHistory(fs.readFileSync(HIST_FILE, "utf8").split("\n").reverse()); } catch { return []; }
  };
  const saveHistory = () => {
    // 里面是这个人自己的任务原话，权限收到 0600：跟 config.json 一个待遇
    try {
      const list = repl.sanitizeHistory(Array.isArray(rl.history) ? rl.history : []);
      if (!list.length) return;
      fs.mkdirSync(path.dirname(HIST_FILE), { recursive: true });
      fs.writeFileSync(HIST_FILE, list.slice().reverse().join("\n") + "\n", { mode: 0o600 });
    } catch {}
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    completer: repl.complete,
    history: loadHistory(),
    historySize: repl.HISTORY_MAX,
    removeHistoryDuplicates: true,
  });

  // 输入侧：line 事件原样交给 repl.makeInbox——合并粘贴、排队、插话、关掉时叫醒等着的那个人，
  // 全在那张纯逻辑里。时钟和定时器能从外面塞进去，所以这套时序在测试里可以手动推、逐帧断言
  let quitArmed = 0;
  const inbox = repl.makeInbox({
    onInterject: (text) => {
      // 任务跑着的时候敲的字是「插话」，不是下一条任务
      termInterject.push(text);
      prog(yellow(`\n  » 记下了，下一步带给它：${text.replace(/\n/g, " ").slice(0, 60)}\n`));
    },
    onMerged: (n, blocks) => {
      // 粘进来的 N 行，readline 一行一条记进了历史。合成一条之后把多出来的退掉，
      // 不然往上翻一次只翻回一行，还把真正有用的历史挤没了
      if (n > 1 && blocks.length === 1 && Array.isArray(rl.history)) rl.history.splice(0, n - 1);
      saveHistory();
    },
  });
  rl.on("line", (raw) => inbox.line(raw));
  rl.on("close", () => inbox.close());
  rl.on("SIGINT", () => {
    if (inbox.busy) { if (stopCurrent) stopCurrent(); return; } // 停这趟活儿，不退出
    if (rl.line) { // 打了一半不想要了：清掉这行就行，别退出
      rl.write(null, { ctrl: true, name: "e" });
      rl.write(null, { ctrl: true, name: "u" });
      quitArmed = 0;
      return;
    }
    const now = Date.now();
    if (now - quitArmed < 3000) { rl.close(); return; }
    quitArmed = now;
    process.stdout.write("\n");
    prog(dim("再按一次 Ctrl+C 退出，或者敲 /exit\n"));
    rl.prompt();
  });
  const nextInput = () => inbox.next();

  const runReplCommand = (v) => {
    if (v.name === "help") { prog(repl.helpText()); return; }
    if (v.name === "clear") { process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); return; }
    if (v.name === "mode") {
      if (!v.arg) { prog(dim(`当前是 ${opts.mode} 模式；换：/mode craft|plan|ask\n`)); return; }
      opts.mode = v.arg;
      prog(dim(`已经切到 ${v.arg} 模式\n`));
      return;
    }
    if (v.name === "new") {
      // 换一个新会话文件，而不是把当前这个清空后覆盖回去——刚才那段对话是资料，不该被顺手抹掉
      const oldId = sessionId;
      sessionId = newSessionId();
      sessFile = sessFileOf(sessionId);
      sess = { history: [], transcript: [], title: "" };
      prog(dim(`开了新会话 ${sessionId}（刚才那段还在：wb --session ${oldId}）\n`));
      return;
    }
    if (v.name === "session") { prog(dim(`${sessionId}\n${sessFile}\n`)); return; }
    if (v.name === "status") {
      const eng = require("./engines").get(cfgEngine());
      const who = eng ? `底层 ${eng.label}` + green("（不花 API 额度）") : `模型 ${llm.provider}（${llm.model}）`;
      const turns = (sess.transcript || []).filter((t) => t.type === "user").length;
      prog(dim(`模式 ${opts.mode} · ${who}\n工作目录 ${getWorkspaceDir()}\n会话 ${sessionId} · 跑过 ${turns} 轮\n`));
      return;
    }
    if (v.name === "cd") {
      // 底下的 setWorkspaceDir 只收绝对路径，.. 和 ~ 在这儿先翻译好——
      // 改写前 /cd .. 和 /cd ~/项目 一律报「工作空间必须是绝对路径」
      const target = repl.resolveCd(v.arg, getWorkspaceDir(), os.homedir());
      if (!target) { prog(dim(`当前工作目录 ${getWorkspaceDir()}\n`)); return; }
      try { setWorkspaceDir(target); prog(dim(`工作目录换到 ${getWorkspaceDir()}\n`)); }
      catch (e) { prog(red(`换不过去：${e.message}\n`)); }
      return;
    }
    if (v.name === "files") {
      try {
        const names = fs.readdirSync(getWorkspaceDir()).filter((f) => !f.startsWith("."));
        process.stdout.write((names.join("\n") || "（空）") + "\n");
      } catch (e) { prog(red(`看不了：${e.message}\n`)); }
      return;
    }
  };

  prog(bold("OpenWorkBuddy CLI 交互模式") + dim("　/help 看命令 · 多行需求直接粘 · Ctrl+C 停当前这趟\n"));
  let last = "ok";
  rl.prompt();
  for (;;) {
    const line = await nextInput();
    if (line === null) { process.stdout.write("\n"); break; } // Ctrl+D / 关掉了：正常收尾，不挂死
    const v = repl.parse(line);
    if (v.kind === "blank") { rl.prompt(); continue; }
    if (v.kind === "unknown") { prog(yellow(repl.unknownText(v))); rl.prompt(); continue; }
    if (v.kind === "bad-arg") { prog(yellow(repl.badArgText(v))); rl.prompt(); continue; }
    if (v.kind === "cmd") {
      if (v.name === "exit") break;
      runReplCommand(v);
      rl.prompt();
      continue;
    }
    inbox.setBusy(true);
    rl.setPrompt(""); // 任务跑着的时候别让提示符插进流式正文里
    last = await runOnce(runtime, v.text, opts.mode);
    inbox.setBusy(false);
    quitArmed = 0;
    rl.setPrompt(PROMPT);
    rl.prompt();
  }
  saveHistory();
  rl.close();
  mcpManager.stopAll();
  process.exit(last === "ok" ? 0 : last === "aborted" ? 130 : 1);
})();
