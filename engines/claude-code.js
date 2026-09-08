"use strict";
/**
 * 底层引擎：本机已装的 Claude Code CLI。
 *
 * 为什么要有它：用户电脑里那个 `claude` 是按订阅算的，跑一次任务不额外掏 API 钱。
 * 把它当底层，OpenWorkBuddy 就从「你得先去买 token」变成「你已经有的东西，接上就能用」。
 *
 * 接法是整层替换，不是换个模型：`claude -p` 本身就是一个完整的 agent（自带工具、自带循环），
 * 没有"给我一步"这种调用方式。所以这里做的是把它的 stream-json 事件流翻译成
 * OpenWorkBuddy 自己那套 emit 事件，前端、CLI、IM 三处的渲染一行都不用改。
 *
 * 翻译表（左边是 claude 的，右边是本项目的）：
 *   system/init                    → status（顺带记下 session_id，给续跑用）
 *   assistant.content[].text       → text
 *   assistant.content[].tool_use   → tool_use
 *   user.content[].tool_result     → tool_result
 *   result(subtype=success)        → finalText + usage
 *   result(subtype=error_max_turns)→ stopped="已达最大步数"，交给 task-verdict 判红
 *
 * 提示词走 stdin 不走 argv：任务描述可能上万字，argv 有长度上限，
 * 而且里面带引号和换行时，拼命令行迟早出事。
 */

const fs = require("fs");
const { runJsonl, probeVersion, probeOption, probeHelp } = require("./jsonl");
const thinking = require("./../thinking");
const { resolveBin } = require("./which");

const ID = "claude-code";

/** 把工具入参压成一句人能看懂的目的说明，长度对齐内置引擎的 purpose */
function purposeOf(name, input) {
  if (!input || typeof input !== "object") return "";
  const pick = input.file_path || input.path || input.command || input.pattern || input.url || input.query || input.prompt || input.description;
  return pick ? String(pick).replace(/\s+/g, " ").slice(0, 80) : "";
}

function textOfToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" ? c.text || "" : String(c || ""))).join("\n");
  }
  return content == null ? "" : String(content);
}

/**
 * stderr 翻译：进程非零退出时，用户唯一能看到的解释就是这里返回的话。
 * 不认识的原文照抄——瞎猜一个原因比直说"不知道"更耽误人。
 */
function explain(stderr, code) {
  const s = String(stderr || "");
  if (/not logged in|please run .*login|Invalid API key|authentication_error|OAuth token/i.test(s))
    return "本机 Claude Code 还没登录。先在终端里跑一次 `claude` 完成登录，再回来重试。";
  if (/rate.?limit|429|usage limit reached/i.test(s))
    return "本机 Claude Code 撞到订阅限流了，等窗口重置后再跑。";
  if (/credit balance|insufficient/i.test(s))
    return "本机 Claude Code 账号额度不够了。";
  if (/ENOENT|command not found/i.test(s))
    return "找不到 claude 命令。装一个（npm i -g @anthropic-ai/claude-code）或在设置里填绝对路径。";
  return s ? s.slice(-600) : `claude 异常退出（退出码 ${code}）且没有任何输出`;
}

/**
 * 这版 claude 认不认 --thinking？
 *
 * 非探不可：claude 对不认识的选项是**静默忽略**的，老版本上发了等于没发，
 * 用户在设置里点了「关闭思考」却毫无动静，还看不出哪儿不对。探到不支持就在
 * 界面上直说（见 thinking.planForEngine 的 note），不假装生效。
 *
 * 一个进程一次，按 bin 缓存：这是个 spawn，设置页每刷一次就探一次太浪费。
 */
const thinkingCaps = new Map();
async function probeThinking(bin) {
  if (thinkingCaps.has(bin)) return thinkingCaps.get(bin);
  const p = probeOption(bin, "--thinking");
  thinkingCaps.set(bin, p);
  return p;
}

/**
 * 这版 claude 认不认 --add-dir？（老版没有；不认的选项它静默吞掉，发了等于没发）
 * 用 --help 探：--add-dir 给个不存在的目录也 exit 0，probeOption 那套假值法判不出来。
 */
const addDirCaps = new Map();
async function probeAddDir(bin) {
  if (addDirCaps.has(bin)) return addDirCaps.get(bin);
  const p = probeHelp(bin, "--add-dir");
  addDirCaps.set(bin, p);
  return p;
}

/**
 * 工作目录之外还要让它读哪些地方：真实存在、不是 cwd 本身、去重。
 * 导出是为了让测试不起进程也能验这段逻辑。
 */
function pickAddDirs(addDirs, cwd) {
  const out = [];
  for (const d of addDirs || []) {
    if (!d || typeof d !== "string") continue;
    let real;
    try { real = fs.realpathSync(d); } catch { continue; } // 不存在的目录发过去 claude 会直接报错退出
    if (!fs.statSync(real).isDirectory()) continue;
    let c = cwd; try { c = fs.realpathSync(cwd); } catch {}
    if (real === c || out.includes(real)) continue;
    out.push(real);
  }
  return out;
}

/**
 * 收的是这个引擎的整份设置（{ bin, model, ... }），不是一个字符串——
 * 注册表那边传下来的本来就是整个 engine_options[id]，当字符串使会 spawn 一个对象，
 * 结果是「用户填了绝对路径反而永远显示没装」。
 */
async function detect(opts) {
  const explicit = typeof opts === "string" ? opts : (opts && opts.bin) || "";
  const found = await resolveBin("claude", explicit);
  if (!found.bin) return { id: ID, installed: false, path: explicit || "claude", version: "", how: "", error: found.why };
  const r = await probeVersion(found.bin, ["--version"]);
  // 装上了才去探选项：没装的话探了也只是白花一个 spawn
  const thinkingFlag = r.installed ? await probeThinking(found.bin) : false;
  return {
    id: ID, installed: r.installed, path: found.bin, version: r.version, how: found.how,
    caps: { thinkingFlag },
    error: r.installed ? "" : "找到了 " + found.bin + "，但 --version 跑不通（装坏了？）",
  };
}

/**
 * @returns {Promise<{finalText:string, usage:object, stopped:string|null, sessionId:string|null}>}
 */
async function run({
  prompt, cwd, emit = () => {}, deadline, stopSignal,
  model, systemPrompt, resumeId, maxTurns, mcpConfigPath, mcpServerNames = [], shimBin = "", bin, permissionMode, env, extraArgs = [],
  thinking: thinkingLevel, addDirs = [],
}) {
  // 起进程也走同一套解析：detect 认出来的是绝对路径，run 却还 spawn 裸名字的话，
  // 双击启动的桌面版会「设置页显示已装、一跑就 ENOENT」
  const found = await resolveBin("claude", bin);
  if (!found.bin) throw new Error(found.why + "。装一个（npm i -g @anthropic-ai/claude-code），或在设置里填 claude 的绝对路径。");
  const exe = found.bin;
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  // acceptEdits：本项目的定位是"替你把活干了"，每一步都停下来问等于没法用。
  // 真正危险的动作由本项目自己的安全中心把关（工具经 MCP 回流时会走那道闸）。
  args.push("--permission-mode", permissionMode || "acceptEdits");
  if (model) args.push("--model", model);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (resumeId) args.push("--resume", resumeId);
  if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
  // 工作目录之外的东西——别的对话的产出、资料库、技能正文——-p 模式下默认不许碰：
  // 读一下都是「需要审批」，而这里没人能点同意。用户的原话是"不能读取文件"。
  // --add-dir 把这几处明着放进来（一个目录一个 --add-dir：这个选项是变长参数，
  // 一口气跟一串会把后面的东西也当目录吞掉）。老版 claude 不认这个选项时不发。
  const dirs = pickAddDirs(addDirs, cwd);
  if (dirs.length && await probeAddDir(exe)) for (const d of dirs) args.push("--add-dir", d);
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
    // -p 是非交互的：MCP 工具默认要人点一下"允许"，而这里没有人。
    // 不放行的话工具挂上了也调不动，模型看见一堆用不了的名字反而更糟。
    // 真正危险的动作由本项目自己的安全中心把关（工具是从这台桥回流的）。
    for (const n of mcpServerNames) args.push("--allowed-tools", "mcp__" + n);
  }
  // 命令行那条路也得放行，否则模型敲了也白敲。实测（2026-09-08）：acceptEdits 下
  // `echo` 这种它自己判得出安全的命令能直接跑，但调一个它没见过的可执行文件会返回
  // 「This command requires approval」——-p 是非交互的，没人能点同意，于是工具形同虚设。
  // 只放行 owb 这一个前缀，不是整个 Bash：本项目的工具都从这台桥回流，安全中心照样把关。
  if (shimBin) args.push("--allowed-tools", `Bash(${shimBin}:*)`);
  // 思考模式：跟 app 设置页那个下拉框同一个档位。auto 什么也不发（今天的行为一个字节不变），
  // 这版 claude 不认 --thinking 时也什么都不发 —— 发了会被静默吞掉，不如明着在界面上说不支持
  const think = thinking.planForEngine(ID, thinkingLevel, { thinkingFlag: await probeThinking(exe) });
  for (const a of think.args) args.push(a);
  for (const a of extraArgs) args.push(a);

  let finalText = "";
  let sessionId = null;
  let stopped = null;
  let resultSeen = false;
  let step = 0;
  // tool_result 块只带 tool_use_id 不带名字；名字在前面那条 tool_use 里。这里存一张 id→名字 的表——
  // 以前一律填空串，复盘挖掘器看到的就是「（空名）报错 49 次」：最大的一类信号却说不出是哪个工具
  const toolNames = new Map();
  const usage = { prompt: 0, completion: 0, cached: 0, calls: 0, elapsed_ms: 0 };
  const startedAt = Date.now();

  const onLine = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.session_id && !sessionId) sessionId = m.session_id;

    if (m.type === "system" && m.subtype === "init") {
      emit({ type: "status", text: `本机 Claude Code 已启动（模型 ${m.model || "默认"}，${(m.tools || []).length} 个工具），不消耗 API 额度`, model: m.model || "", depth: 0 });
      return;
    }
    if (m.type === "assistant" && m.message) {
      step += 1;
      emit({ type: "step_start", step, depth: 0 });
      const u = m.message.usage || {};
      // 每条 assistant 消息都带一次累计用量；这里按增量记，最后 result 那条会给权威值
      usage.calls += 1;
      for (const b of m.message.content || []) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && b.text) emit({ type: "text", delta: b.text, depth: 0 });
        else if (b.type === "tool_use") {
          toolNames.set(b.id, b.name);
          emit({ type: "tool_use", id: b.id, name: b.name, purpose: purposeOf(b.name, b.input), depth: 0 });
        }
      }
      void u;
      return;
    }
    if (m.type === "user" && m.message) {
      for (const b of m.message.content || []) {
        if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
        const text = textOfToolResult(b.content);
        emit({
          type: "tool_result", id: b.tool_use_id, name: toolNames.get(b.tool_use_id) || "",
          isError: !!b.is_error, preview: text.slice(0, 300), depth: 0,
        });
      }
      return;
    }
    if (m.type === "result") {
      resultSeen = true;
      const u = m.usage || {};
      // Anthropic 的 input_tokens 不含缓存读的那部分，要加回来才是「这次真的喂进去多少」（跟 llm.js 同口径）。
      // 以前没加：缓存读 3 万、非缓存 1 千，界面就算出「缓存命中 3209%」
      usage.prompt = Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
      usage.completion = Number(u.output_tokens || 0);
      usage.cached = Number(u.cache_read_input_tokens || 0);
      if (m.num_turns > 0) usage.calls = m.num_turns;
      if (typeof m.result === "string" && m.result.trim()) finalText = m.result.trim();
      if (m.subtype === "error_max_turns") stopped = `已达最大步数（${maxTurns || m.num_turns} 步）`;
      else if (m.is_error) stopped = null; // 真错误走抛异常那条路，不假装"跑满了"
    }
  };

  const r = await runJsonl({ bin: exe, args, cwd, env, stdin: prompt, onLine, deadline, stopSignal });
  usage.elapsed_ms = Date.now() - startedAt;

  if (r.killed === "stopped") return { finalText, usage, stopped: "已手动停止", sessionId };
  if (r.killed === "deadline") return { finalText, usage, stopped: "已达最大运行时间", sessionId };
  if (!resultSeen || r.code !== 0) {
    if (finalText && r.code === 0) return { finalText, usage, stopped, sessionId }; // 有正文、干净退出，只是没吐 result
    throw new Error(explain(r.stderr, r.code));
  }
  return { finalText, usage, stopped, sessionId };
}

module.exports = {
  id: ID,
  label: "本机 Claude Code",
  bin: "claude",
  launchHeader: "claude -p --output-format stream-json",
  note: "用你电脑上已登录的 Claude Code 订阅跑，不消耗本项目配置的 API 额度",
  install: "npm i -g @anthropic-ai/claude-code，然后终端里跑一次 claude 登录",
  // 连不上时前端要给一句「接下来敲什么」。写在引擎自己身上，注册表那边就不用按 id 打补丁了
  login: "在终端里跑一次 claude 完成登录，再回来点一次",
  supportsResume: true,
  // 设置页「模型」输入框的候选（只是提示，用户填什么就发什么；以这版 claude 认的名字为准）
  models: ["opus", "sonnet", "haiku", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  thinkingLabel: "扩展思考（claude 只有开/关，低中高都算开）",
  detect, run, explain, pickAddDirs,
};
