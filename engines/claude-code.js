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

const { runJsonl, probeVersion } = require("./jsonl");

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

async function detect(bin) {
  const exe = bin || "claude";
  const r = await probeVersion(exe, ["--version"]);
  return { id: ID, installed: r.installed, path: exe, version: r.version };
}

/**
 * @returns {Promise<{finalText:string, usage:object, stopped:string|null, sessionId:string|null}>}
 */
async function run({
  prompt, cwd, emit = () => {}, deadline, stopSignal,
  model, systemPrompt, resumeId, maxTurns, mcpConfigPath, bin, permissionMode, extraArgs = [],
}) {
  const exe = bin || "claude";
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  // acceptEdits：本项目的定位是"替你把活干了"，每一步都停下来问等于没法用。
  // 真正危险的动作由本项目自己的安全中心把关（工具经 MCP 回流时会走那道闸）。
  args.push("--permission-mode", permissionMode || "acceptEdits");
  if (model) args.push("--model", model);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (resumeId) args.push("--resume", resumeId);
  if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  for (const a of extraArgs) args.push(a);

  let finalText = "";
  let sessionId = null;
  let stopped = null;
  let resultSeen = false;
  let step = 0;
  const usage = { prompt: 0, completion: 0, cached: 0, calls: 0, elapsed_ms: 0 };
  const startedAt = Date.now();

  const onLine = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.session_id && !sessionId) sessionId = m.session_id;

    if (m.type === "system" && m.subtype === "init") {
      emit({ type: "status", text: `本机 Claude Code 已启动（模型 ${m.model || "默认"}，${(m.tools || []).length} 个工具），不消耗 API 额度`, depth: 0 });
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
        else if (b.type === "tool_use")
          emit({ type: "tool_use", id: b.id, name: b.name, purpose: purposeOf(b.name, b.input), depth: 0 });
      }
      void u;
      return;
    }
    if (m.type === "user" && m.message) {
      for (const b of m.message.content || []) {
        if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
        const text = textOfToolResult(b.content);
        emit({
          type: "tool_result", id: b.tool_use_id, name: "",
          isError: !!b.is_error, preview: text.slice(0, 300), depth: 0,
        });
      }
      return;
    }
    if (m.type === "result") {
      resultSeen = true;
      const u = m.usage || {};
      usage.prompt = Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
      usage.completion = Number(u.output_tokens || 0);
      usage.cached = Number(u.cache_read_input_tokens || 0);
      if (m.num_turns > 0) usage.calls = m.num_turns;
      if (typeof m.result === "string" && m.result.trim()) finalText = m.result.trim();
      if (m.subtype === "error_max_turns") stopped = `已达最大步数（${maxTurns || m.num_turns} 步）`;
      else if (m.is_error) stopped = null; // 真错误走抛异常那条路，不假装"跑满了"
    }
  };

  const r = await runJsonl({ bin: exe, args, cwd, stdin: prompt, onLine, deadline, stopSignal });
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
  supportsResume: true,
  detect, run, explain,
};
