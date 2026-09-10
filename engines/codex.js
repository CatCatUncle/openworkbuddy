"use strict";
/**
 * 底层引擎：本机已装的 Codex CLI（`codex exec --json`）。
 *
 * 和 claude-code 那条同一个道理：用户已经在为 ChatGPT 订阅付钱，
 * 这里就不该再让他为同一件事买第二份 API 额度。
 *
 * 事件流长得跟 Claude 完全不一样，得单独翻一遍：
 *   thread.started              → 记 thread_id（续跑要用）
 *   item.completed/agent_message→ text（Codex 是整段给，不是流式 token）
 *   item.*  /command_execution  → tool_use + tool_result
 *   item.*  /mcp_tool_call      → tool_use + tool_result
 *   turn.completed              → usage
 *   turn.failed                 → 抛异常（错误就是错误，不许当成"跑完了"）
 *
 * 两个默认值是拍过的，不是抄来的：
 *   · sandbox = workspace-write —— 它得往工作目录写 PPT、报告、图片，read-only 等于废了。
 *   · network_access = true    —— 关着网就查不了资料，本项目一半的活干不了。
 *     这两条都会在设置页写明白，用户可以自己收紧。
 */

const { runJsonl, probeVersion } = require("./jsonl");
const thinking = require("./../thinking");
const { resolveBin } = require("./which");

const ID = "codex";

function shorten(s, n = 80) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
}

/** 把 Codex 的 item 归成 (工具名, 目的说明)；认不出的原样带过去，不假装认识 */
function toolOf(item) {
  switch (item.type) {
    case "command_execution": return { name: "run_shell", purpose: shorten(item.command) };
    case "mcp_tool_call": return { name: `${item.server || "mcp"}.${item.tool || ""}`, purpose: shorten(item.arguments || "") };
    case "web_search": return { name: "web_search", purpose: shorten(item.query) };
    case "file_change": return { name: "edit_file", purpose: shorten((item.changes || []).map((c) => c.path).join(", ")) };
    default: return null;
  }
}

function explain(stderr, code) {
  const s = String(stderr || "");
  if (/not logged in|codex login|401|Unauthorized/i.test(s))
    return "本机 Codex 还没登录。先在终端里跑一次 `codex login`，再回来重试。";
  if (/rate.?limit|429|quota/i.test(s))
    return "本机 Codex 撞到限流或额度上限了，等窗口重置后再跑。";
  if (/ENOENT|command not found/i.test(s))
    return "找不到 codex 命令。装一个（npm i -g @openai/codex）或在设置里填绝对路径。";
  return s ? s.slice(-600) : `codex 异常退出（退出码 ${code}）且没有任何输出`;
}

/** 收整份设置，理由同 claude-code.js 里那条注释 */
async function detect(opts) {
  const explicit = typeof opts === "string" ? opts : (opts && opts.bin) || "";
  const found = await resolveBin("codex", explicit);
  if (!found.bin) return { id: ID, installed: false, path: explicit || "codex", version: "", how: "", error: found.why };
  const r = await probeVersion(found.bin, ["--version"]);
  return {
    id: ID, installed: r.installed, path: found.bin, version: r.version, how: found.how,
    error: r.installed ? "" : "找到了 " + found.bin + "，但 --version 跑不通（装坏了？）",
  };
}

async function run({
  prompt, cwd, emit = () => {}, deadline, stopSignal,
  model, resumeId, bin, sandbox, network = true, mcpArgs = [], writableRoots = [], env, extraArgs = [],
  thinking: thinkingLevel,
}) {
  const found = await resolveBin("codex", bin);
  if (!found.bin) throw new Error(found.why + "。装一个（npm i -g @openai/codex），或在设置里填 codex 的绝对路径。");
  const exe = found.bin;
  // 同 claude 那边：本机 CLI 冷启动那几秒界面本来全空，看着像发送没点上。
  // bin 一确认存在就先挂一枚「正在启动」的牌子占位，thread.started 一到原地换成带模型名的
  // 正式版（前端认的是同一个 .run-eng 节点）。
  emit({ type: "status", starting: true, text: `本机 Codex 正在启动（连接工具中，一般 3~8 秒），不消耗 API 额度`, depth: 0 });
  const args = ["exec"];
  if (resumeId) args.push("resume", resumeId);
  args.push("--json", "--skip-git-repo-check");
  // 沙箱与网络一律走 -c 配置覆盖，不用 -s / -C：
  // `codex exec resume` 这个子命令根本不收 -s 和 -C（会直接报 unexpected argument 退出），
  // 而 -c 两条路都收。工作目录由子进程自己的 cwd 决定，本来也不需要 -C。
  args.push("-c", `sandbox_mode="${sandbox || "workspace-write"}"`);
  if (network) args.push("-c", "sandbox_workspace_write.network_access=true");
  // workspace-write 默认只让写 cwd。本项目借出去的工具里，remember / save_skill 要写到
  // 数据目录（在 cwd 外面），不开这个口子就是「工具调得动、东西存不下」，报错还特别难懂。
  if (writableRoots.length) args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`);
  if (model) args.push("-m", model);
  // 本项目自己的工具（生图/视频/技能/记忆）当成 MCP 服务器挂上去，
  // 否则切到本机 Codex 就等于把这些全丢了
  for (const a of mcpArgs) args.push(a);
  // 思考模式：跟 app 设置页那个下拉框同一个档位（codex 这边是 model_reasoning_effort，
  // 关掉就是 none）。auto 不发，配置文件里怎么写就怎么来
  for (const a of thinking.planForEngine(ID, thinkingLevel).args) args.push(a);
  for (const a of extraArgs) args.push(a);
  args.push("-"); // 提示词从 stdin 读，和 claude 那条保持一致

  let finalText = "";
  let sessionId = resumeId || null;
  let step = 0;
  let failure = null;
  let turnDone = false;
  const usage = { prompt: 0, completion: 0, cached: 0, calls: 0, elapsed_ms: 0 };
  const startedAt = Date.now();
  const announced = new Set(); // item.started 报过的工具，completed 时别重复报一遍卡片

  const onLine = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.type === "thread.started") {
      sessionId = m.thread_id || sessionId;
      // 把实际用的模型带上：设置页那个「测试连接」要显示它，用户下一个任务看到的得是同一个名字
      emit({ type: "status", text: `本机 Codex 已启动（模型 ${model || "默认"}），不消耗 API 额度`, model: model || "", depth: 0 });
      return;
    }
    if (m.type === "turn.started") {
      step += 1;
      usage.calls += 1;
      emit({ type: "step_start", step, depth: 0 });
      return;
    }
    if (m.type === "turn.completed") {
      turnDone = true;
      const u = m.usage || {};
      usage.prompt += Number(u.input_tokens || 0);
      usage.completion += Number(u.output_tokens || 0) + Number(u.reasoning_output_tokens || 0);
      usage.cached += Number(u.cached_input_tokens || 0);
      return;
    }
    if (m.type === "turn.failed") {
      failure = (m.error && m.error.message) || "Codex 这一轮失败了，但没给出原因";
      return;
    }
    const item = m.item;
    if (!item || typeof item !== "object") return;

    if (item.type === "agent_message") {
      if (m.type === "item.completed" && item.text) {
        finalText = String(item.text).trim(); // 最后一条 agent_message 就是交付正文
        emit({ type: "text", delta: item.text, depth: 0 });
      }
      return;
    }
    if (item.type === "error") {
      if (m.type === "item.completed") failure = item.message || "Codex 报了一个没有说明的错误";
      return;
    }
    const t = toolOf(item);
    if (!t) return;
    if (m.type === "item.started" && !announced.has(item.id)) {
      announced.add(item.id);
      emit({ type: "tool_use", id: item.id, name: t.name, purpose: t.purpose, depth: 0 });
      return;
    }
    if (m.type === "item.completed") {
      if (!announced.has(item.id)) {
        announced.add(item.id);
        emit({ type: "tool_use", id: item.id, name: t.name, purpose: t.purpose, depth: 0 });
      }
      const bad = item.status === "failed" || (item.exit_code != null && item.exit_code !== 0);
      const out = item.aggregated_output || item.output || item.result || "";
      emit({ type: "tool_result", id: item.id, name: t.name, isError: !!bad, preview: shorten(out, 300), depth: 0 });
    }
  };

  const r = await runJsonl({ bin: exe, args, cwd, env, stdin: prompt, onLine, deadline, stopSignal });
  usage.elapsed_ms = Date.now() - startedAt;

  if (r.killed === "stopped") return { finalText, usage, stopped: "已手动停止", sessionId };
  if (r.killed === "deadline") return { finalText, usage, stopped: "已达最大运行时间", sessionId };
  if (failure) throw new Error(failure);
  if (!turnDone || r.code !== 0) {
    if (finalText && r.code === 0) return { finalText, usage, stopped: null, sessionId };
    throw new Error(explain(r.stderr, r.code));
  }
  return { finalText, usage, stopped: null, sessionId };
}

module.exports = {
  id: ID,
  label: "本机 Codex",
  bin: "codex",
  launchHeader: "codex exec --json",
  note: "用你电脑上已登录的 Codex（ChatGPT 订阅）跑，不消耗本项目配置的 API 额度",
  install: "npm i -g @openai/codex，然后终端里跑一次 codex login",
  login: "在终端里跑一次 codex login 完成登录，再回来点一次",
  supportsResume: true,
  models: ["gpt-5.4-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5-codex", "gpt-5"],
  thinkingLabel: "推理强度 effort（关闭=none，低/中/高=low/medium/high）",
  detect, run, explain,
};
