"use strict";
/**
 * LLM 适配层 — 统一 Anthropic（Claude）与 OpenAI 兼容接口（DeepSeek/Qwen/GLM/Kimi/Ollama）。
 *
 * 统一的会话历史格式（neutral history）：
 *   { role: "user", content: string }
 *   { role: "assistant", text: string, toolCalls: [{id, name, input}], raw?: any[] }  // raw 仅 anthropic 用，保留 thinking 块
 *   { role: "tool", results: [{ id, content, isError }] }
 *
 * chat() 返回 { text, toolCalls, stopReason }
 */

// ---------- Anthropic (Claude) —— 可选适配器，仅在 provider=anthropic 时才需要安装 @anthropic-ai/sdk ----------

function toAnthropicMessages(history) {
  const messages = [];
  for (const entry of history) {
    if (entry.role === "user") {
      // 插队消息可能紧跟在 tool 结果（也是 user 角色）之后：并入上一条，保持角色交替
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push({ type: "text", text: entry.content });
      } else {
        messages.push({ role: "user", content: entry.content });
      }
    } else if (entry.role === "assistant") {
      // raw 保留了原始 content 块（含 thinking 块），多轮 tool use 必须原样传回
      if (entry.raw) {
        messages.push({ role: "assistant", content: entry.raw });
      } else {
        const blocks = [];
        if (entry.text) blocks.push({ type: "text", text: entry.text });
        for (const tc of entry.toolCalls || []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
        messages.push({ role: "assistant", content: blocks });
      }
    } else if (entry.role === "tool") {
      messages.push({
        role: "user",
        content: entry.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          is_error: !!r.isError,
        })),
      });
    }
  }
  return messages;
}

async function anthropicChat(cfg, { system, history, tools, onTextDelta, signal }) {
  let Anthropic;
  try {
    Anthropic = require("@anthropic-ai/sdk");
  } catch {
    throw new Error(
      "使用 Claude 需先安装可选依赖：npm install @anthropic-ai/sdk（默认配置走 OpenAI 兼容接口，无需此依赖）"
    );
  }
  const client = new Anthropic({
    apiKey: cfg.api_key || process.env.ANTHROPIC_API_KEY,
  });

  const stream = client.messages.stream(
    {
      model: cfg.model,
      max_tokens: 32000,
      system,
      messages: toAnthropicMessages(history),
      // 空数组要整个字段不发：不给工具是一种正当用法（比如强制收尾那一问），
      // 而一部分服务端会把 tools: [] 判成参数非法直接 400
      ...(tools && tools.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema,
            })),
          }
        : {}),
    },
    { signal }
  );

  if (onTextDelta) stream.on("text", (delta) => onTextDelta(delta));

  const msg = await stream.finalMessage();

  let text = "";
  const toolCalls = [];
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  const usage = msg.usage ? { prompt: msg.usage.input_tokens || 0, completion: msg.usage.output_tokens || 0 } : null;
  return { text, toolCalls, stopReason: msg.stop_reason, raw: msg.content, usage };
}

// ---------- OpenAI 兼容接口 (DeepSeek / Qwen / GLM / Kimi / Ollama ...) ----------

function toOpenAIMessages(system, history) {
  const messages = [{ role: "system", content: system }];
  for (const entry of history) {
    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.content });
    } else if (entry.role === "assistant") {
      const m = { role: "assistant", content: entry.text || "" };
      if (entry.toolCalls && entry.toolCalls.length) {
        m.tool_calls = entry.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
      messages.push(m);
    } else if (entry.role === "tool") {
      for (const r of entry.results) {
        messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
  }
  return messages;
}

async function openaiChat(cfg, { system, history, tools, onTextDelta, signal }) {
  const apiKey = cfg.api_key || process.env.OPENAI_API_KEY || "ollama";
  const useStream = cfg.stream !== false;
  const resp = await fetch(`${cfg.base_url.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      ...(cfg.extra_body || {}), // 模型条目可带厂商特有参数（如 OpenRouter 的 reasoning）；核心字段在后，不会被覆盖
      model: cfg.model,
      stream: useStream,
      ...(useStream ? { stream_options: { include_usage: true } } : {}), // 流式也带回 token 用量（DeepSeek/OpenRouter 等均支持）
      messages: toOpenAIMessages(system, history),
      // 同上：OpenAI 兼容接口对 tools: [] 一律报「数组不能为空」，没有工具就别带这个字段
      ...(tools && tools.length
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.input_schema },
            })),
          }
        : {}),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    // 上下文超限是最常见的 400，原文是一坨英文 JSON，翻成用户能照着做的话
    if (resp.status === 400 && /context length|context_length|maximum context|too many tokens|reduce the length/i.test(body)) {
      throw new Error(
        `这次请求超出了模型的上下文长度上限。可以在 设置 → 智能体设置 调小「上下文预算」或「单任务最大步数」，` +
          `也可以换一个上下文更大的模型；这条任务的历史已经很长，新开一个任务接着做更稳。\n原始报错：${body.slice(0, 300)}`
      );
    }
    throw new Error(`LLM 接口错误 ${resp.status}: ${body.slice(0, 500)}`);
  }

  if (!useStream) {
    const data = await resp.json();
    return parseOpenAIChoice(
      data.choices && data.choices[0],
      onTextDelta,
      data.usage ? { prompt: data.usage.prompt_tokens || 0, completion: data.usage.completion_tokens || 0 } : null
    );
  }

  // ---- SSE 流式解析 ----
  let text = "";
  let finishReason = null;
  let usage = null; // 最后一个 chunk 里的 token 用量（stream_options.include_usage）
  const tcByIndex = new Map(); // index -> {id, name, args}
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.usage) usage = { prompt: chunk.usage.prompt_tokens || 0, completion: chunk.usage.completion_tokens || 0 };
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) {
        text += delta.content;
        if (onTextDelta) onTextDelta(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const slot = tcByIndex.get(tc.index) || { id: "", name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        tcByIndex.set(tc.index, slot);
      }
    }
  }

  const toolCalls = [...tcByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, s]) => {
      let input = {};
      try {
        input = JSON.parse(s.args || "{}");
      } catch {
        input = { _raw: s.args };
      }
      return { id: s.id || `call_${i}`, name: s.name, input };
    });

  return { text, toolCalls, stopReason: finishReason, usage };
}

function parseOpenAIChoice(choice, onTextDelta, usage) {
  if (!choice) throw new Error("LLM 返回为空");
  const text = choice.message.content || "";
  if (text && onTextDelta) onTextDelta(text);
  const toolCalls = (choice.message.tool_calls || []).map((tc) => {
    let input = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = { _raw: tc.function.arguments };
    }
    return { id: tc.id, name: tc.function.name, input };
  });
  return { text, toolCalls, stopReason: choice.finish_reason, usage: usage || null };
}

// ---------- 瞬时错误自动重试 ----------

// 上游繁忙/限流/网关抖动（DeepSeek 高峰 503 最常见）；仅在还没吐出任何流式文字时重试，避免界面出现重复内容
const RETRYABLE = /LLM 接口错误 (429|500|502|503|504)|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|terminated|other side closed/i;
const RETRY_DELAYS = [2000, 5000, 10000];

async function chatWithRetry(fn, args) {
  for (let attempt = 0; ; attempt++) {
    let streamed = false;
    const onTextDelta = args.onTextDelta
      ? (d) => {
          streamed = true;
          args.onTextDelta(d);
        }
      : undefined;
    try {
      return await fn({ ...args, onTextDelta });
    } catch (e) {
      const msg = String((e && e.message) || e);
      const canRetry =
        RETRYABLE.test(msg) && !streamed && attempt < RETRY_DELAYS.length && !(args.signal && args.signal.aborted);
      if (!canRetry) {
        if (RETRYABLE.test(msg) && attempt > 0) {
          e.message = `${msg}\n（已自动重试 ${attempt} 次仍失败：上游服务繁忙，可稍后再试或在 设置→模型 切换备用渠道）`;
        }
        throw e;
      }
      console.warn(`[llm] 瞬时错误，${RETRY_DELAYS[attempt] / 1000}s 后重试（第 ${attempt + 1} 次）：${msg.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
}

// ---------- 统一入口 ----------

/**
 * 模型配置的两种来源（优先 models 列表）：
 * 1. config.models: [{ name, provider: "openai"|"anthropic", base_url?, api_key, model }] + config.active_model（按 name 选中）
 * 2. 旧式 config.provider + config.openai / config.anthropic
 */
function createLLM(config) {
  if (Array.isArray(config.models) && config.models.length) {
    const entry = config.models.find((m) => m.name === config.active_model) || config.models[0];
    const provider = entry.provider === "anthropic" ? "anthropic" : "openai";
    return {
      provider: entry.name || provider,
      model: entry.model,
      chat: (args) =>
        chatWithRetry((a) => (provider === "anthropic" ? anthropicChat(entry, a) : openaiChat(entry, a)), args),
    };
  }

  const provider = config.provider;
  if (provider === "anthropic") {
    return {
      provider,
      model: config.anthropic.model,
      chat: (args) => chatWithRetry((a) => anthropicChat(config.anthropic, a), args),
    };
  }
  if (provider === "openai") {
    return {
      provider,
      model: config.openai.model,
      chat: (args) => chatWithRetry((a) => openaiChat(config.openai, a), args),
    };
  }
  throw new Error(`未知 provider: ${provider}（可选 anthropic / openai）`);
}

module.exports = { createLLM };
