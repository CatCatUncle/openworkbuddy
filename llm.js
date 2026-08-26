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

async function anthropicChat(cfg, { system, history, tools, onTextDelta, onActivity, signal }) {
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
  if (onActivity) stream.on("streamEvent", () => onActivity());

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

// ---------- 把「说出来」的工具调用救回来 ----------
// DeepSeek 一类模型的工具调用在权重里是特殊 token（<｜tool▁sep｜> 等）。经过某些
// 中转/兼容层时它们不会被解析进 tool_calls 字段，而是原样解码进正文——于是模型以为
// 自己调了工具，实际什么都没发生，接着开始编造"抓取结果"。这不是提示词能治的，
// 只能在解析层认出来并还原成真正的工具调用。
const LEAK_MARK = /[<＜][|｜]tool[_▁]?(?:calls?[_▁]?)?(?:begin|sep)[|｜][>＞]/;
const LEAK_SEP = /[<＜][|｜]tool[_▁]?sep[|｜][>＞]\s*([A-Za-z_][\w.-]*)/g;

/**
 * 从正文里抠出被"说"出来的工具调用。
 * 返回 { text, toolCalls }：text 是剔掉这些标记后的干净正文（通常剩不下什么）。
 */
function rescueLeakedToolCalls(raw) {
  if (!raw || !LEAK_MARK.test(raw)) return { text: raw, toolCalls: [] };
  const toolCalls = [];
  LEAK_SEP.lastIndex = 0;
  let m;
  while ((m = LEAK_SEP.exec(raw))) {
    const name = m[1];
    const rest = raw.slice(m.index + m[0].length);
    // 参数紧跟在后面，可能裹在 ```json 围栏里，也可能是裸的 {...}
    const fence = rest.match(/^\s*```(?:json)?\s*([\s\S]*?)```/);
    const body = fence ? fence[1] : sliceFirstObject(rest);
    // 参数没读全（有 { 但配不上对，说明被截断了）就宁可丢掉这次调用，
    // 拿半截参数去执行比不执行更糟。真正不带参数的工具（rest 里压根没有 {）才按 {} 放行。
    if (body === null && rest.includes("{")) continue;
    let input = {};
    try {
      input = JSON.parse((body || "{}").trim());
    } catch {
      continue;
    }
    toolCalls.push({ id: `rescued_${toolCalls.length}`, name, input });
  }
  // 标记之前的那段还是模型的正常叙述，留着；标记之后全是调用负载，砍掉
  const cut = raw.search(LEAK_MARK);
  return { text: (cut > 0 ? raw.slice(0, cut) : "").replace(/\bfunction\s*$/, "").trimEnd(), toolCalls };
}

/** 从字符串开头找出第一个花括号对（按深度配平，跳过字符串字面量） */
function sliceFirstObject(s) {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/**
 * 流式转发时的闸门：一旦冒出特殊 token 的开头就停止往界面吐字。
 * 后面全是工具调用负载，让用户看见一堆 <｜tool▁sep｜> 只会以为程序坏了。
 */
function createLeakGuard(onTextDelta) {
  let leaking = false;
  let hold = ""; // 标记可能被切在两个 chunk 中间，留一个字符不发
  return (delta) => {
    if (!onTextDelta) return;
    if (leaking) return;
    const s = hold + delta;
    const i = s.search(/[<＜][|｜]/);
    if (i >= 0) {
      leaking = true;
      hold = "";
      if (i > 0) onTextDelta(s.slice(0, i));
      return;
    }
    // 结尾恰好是 "<" 时先扣住：下一片可能接上 "｜" 组成标记
    if (/[<＜]$/.test(s)) { hold = s.slice(-1); onTextDelta(s.slice(0, -1)); return; }
    hold = "";
    onTextDelta(s);
  };
}

async function openaiChat(cfg, { system, history, tools, onTextDelta, onActivity, signal }) {
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
    // 欠费/余额不足：这不是抖动也不是 bug，重试一百次也没用。翻成人话并指名是哪条渠道，
    // 免得用户以为是软件坏了（原始报错还是留在后面，方便贴给渠道客服）
    if (resp.status === 402 || /insufficient balance|insufficient_quota|欠费|余额不足|arrearage/i.test(body)) {
      throw new Error(
        `渠道「${cfg.name || cfg.model}」余额不足，模型不给跑了——这不是软件出错，去这条渠道的官网充值即可；` +
          `急着继续可以在 设置 → 模型 换一条有余额的渠道，或者在 设置 → 智能体设置 里指定「备用渠道」，以后这条挂了会自动接上。\n原始报错：${body.slice(0, 200)}`
      );
    }
    throw new Error(`LLM 接口错误 ${resp.status}: ${body.slice(0, 500)}`);
  }

  if (!useStream) {
    const data = await resp.json();
    if (data.error) {
      throw new Error(`LLM 接口错误 ${data.error.code || ""}: ${data.error.message || JSON.stringify(data.error).slice(0, 300)}`);
    }
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
  const guard = createLeakGuard(onTextDelta);
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
      // 任何解析成功的数据块都算「模型还活着」：正文、思考(reasoning)、工具参数流全在内。
      // 排队中的 keep-alive 注释行（如 OpenRouter 的 ": PROCESSING"）不带 data: 前缀，天然不算
      if (onActivity) onActivity();
      // 网关（OpenRouter 等）常常 HTTP 200 之后把错误装在流里发过来：{"error":{...}}，没有 choices。
      // 以前这里被 continue 静默跳过，整条流走完变成「空回答」，用户什么都看不到——必须抛出去
      if (chunk.error) {
        const code = chunk.error.code || chunk.error.status || "";
        const emsg = chunk.error.message || JSON.stringify(chunk.error).slice(0, 300);
        throw new Error(`LLM 接口错误 ${code}: ${emsg}`);
      }
      if (chunk.usage) usage = { prompt: chunk.usage.prompt_tokens || 0, completion: chunk.usage.completion_tokens || 0 };
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      // 错误还有一种挂在 choice 上的姿势：{"choices":[{"finish_reason":"error","error":{...}}]}
      if (choice.error || choice.finish_reason === "error") {
        const ce = choice.error || {};
        throw new Error(`LLM 接口错误 ${ce.code || 502}: ${ce.message || "上游在流中途报错（finish_reason=error）"}`);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) {
        text += delta.content;
        guard(delta.content);
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

  // 正经的 tool_calls 字段是空的，但正文里躺着工具调用的特殊 token —— 救回来
  if (!toolCalls.length) {
    const rescued = rescueLeakedToolCalls(text);
    if (rescued.toolCalls.length) {
      console.warn(`[llm] 模型把 ${rescued.toolCalls.map((t) => t.name).join("、")} 当成正文吐了出来，已还原成真正的调用`);
      return { text: rescued.text, toolCalls: rescued.toolCalls, stopReason: "tool_calls", usage };
    }
  }

  // 整条流走完却什么都没有（没正文/没工具调用/没记账/没结束原因）：典型是连上之后立刻被掐断，
  // 或上游异常但没走错误载荷。当失败抛出去让重试接手——以前这里返回空结果，agent 会当成「模型答完了」正常收尾
  if (!text && !toolCalls.length && !usage) {
    throw new Error("LLM 返回了空响应（连接建立后没有收到任何内容，上游服务或网络异常）");
  }
  return { text, toolCalls, stopReason: finishReason, usage };
}

function parseOpenAIChoice(choice, onTextDelta, usage) {
  if (!choice) throw new Error("LLM 返回为空");
  let text = choice.message.content || "";
  const rescued = (choice.message.tool_calls || []).length ? null : rescueLeakedToolCalls(text);
  if (rescued && rescued.toolCalls.length) {
    console.warn(`[llm] 模型把 ${rescued.toolCalls.map((t) => t.name).join("、")} 当成正文吐了出来，已还原成真正的调用`);
    if (rescued.text && onTextDelta) onTextDelta(rescued.text);
    return { text: rescued.text, toolCalls: rescued.toolCalls, stopReason: "tool_calls", usage: usage || null };
  }
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
const RETRYABLE = /LLM 接口错误 (429|500|502|503|504)|LLM 返回了空响应|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|terminated|other side closed/i;
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
      // 重试以前在后台默默进行，用户只看到界面一动不动——报出去让前端显示
      if (args.onStatus) {
        try { args.onStatus(`上游出错，${RETRY_DELAYS[attempt] / 1000} 秒后自动重试（第 ${attempt + 1}/${RETRY_DELAYS.length} 次）：${msg.slice(0, 100)}`); } catch {}
      }
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

// ---------- Embeddings（记忆向量召回用） ----------
// 找一条能算文本向量的路：优先 config.embedding 显式指定；否则在 models 列表里找认识的
// 厂商（DashScope/智谱/OpenAI/Ollama 本地）复用它的 key 和域名。DeepSeek/OpenRouter 压根
// 没有 embeddings 接口，配了也是白配，所以不瞎猜。一条都找不到就返回 null——
// 记忆召回自动退回关键词匹配，功能不缺，只是召回没那么聪明。
const EMBED_KNOWN = [
  { match: /dashscope\.aliyuncs\.com/i, model: "text-embedding-v4" },
  { match: /open\.bigmodel\.cn/i, model: "embedding-3" },
  { match: /api\.openai\.com/i, model: "text-embedding-3-small" },
  { match: /localhost:11434|127\.0\.0\.1:11434/, model: "nomic-embed-text" },
];

/**
 * 攒一份候选清单而不是只挑一条：配了 Ollama 但没开机、或某条渠道欠费，都不该让记忆召回
 * 直接哑掉。媒体渠道（图像/视频）的 key 也算数——用户常把通义的 key 只填在视频那一栏，
 * 但同一把 key 就能算向量，只是 DashScope 的原生地址要换成 OpenAI 兼容地址。
 */
function embedCandidates(config) {
  const out = [];
  const push = (base_url, api_key, model, label) => {
    if (!base_url || !model) return;
    let b = String(base_url).trim().replace(/\/+$/, "");
    // DashScope 原生 /api/v1 不认 /embeddings，OpenAI 兼容层在 /compatible-mode/v1
    if (/dashscope\.aliyuncs\.com/i.test(b)) b = b.replace(/\/api\/v\d+$/i, "/compatible-mode/v1");
    if (out.some((c) => c.base_url === b && c.model === model)) return;
    out.push({ base_url: b, api_key: api_key || "", model, label });
  };

  const ec = config.embedding;
  if (ec && ec.base_url && ec.model) push(ec.base_url, ec.api_key, ec.model, "设置里显式指定的嵌入渠道");

  const knownFor = (url) => (EMBED_KNOWN.find((k) => k.match.test(String(url || ""))) || {}).model;
  const isLocal = (url) => /localhost:11434|127\.0\.0\.1:11434/.test(String(url || ""));

  const fromModels = [];
  for (const m of Array.isArray(config.models) ? config.models : []) {
    if (!m || !m.base_url) continue;
    // 没填 key 的条目跳过（本地 Ollama 除外，它不要 key）：拿空 key 去打只会制造一堆 401 噪音
    if (!m.api_key && !isLocal(m.base_url)) continue;
    const model = knownFor(m.base_url);
    if (model) fromModels.push({ m, model });
  }
  for (const { m, model } of fromModels.filter((x) => !isLocal(x.m.base_url)))
    push(m.base_url, m.api_key, model, `模型渠道「${m.name || m.model}」`);

  // 媒体渠道（图像/视频/语音）的 key 也算数：用户常把通义的 key 只填在视频那一栏
  const media = config.media || {};
  for (const [key, mc] of [["图像", media.image], ["视频", media.video], ["语音", media.tts]]) {
    if (!mc || !mc.base_url || !mc.api_key) continue;
    const model = knownFor(String(mc.base_url).replace(/\/api\/v\d+$/i, "/compatible-mode/v1"));
    if (model) push(mc.base_url, mc.api_key, model, `${key}渠道的 key`);
  }

  // 本地 Ollama 垫底：没开机时它必然 fetch failed，别让它占着第一顺位把功能拖死
  for (const { m, model } of fromModels.filter((x) => isLocal(x.m.base_url)))
    push(m.base_url, m.api_key, model, `本地 Ollama`);
  return out;
}

function createEmbedder(config) {
  const cands = embedCandidates(config);
  if (!cands.length) return null;

  let idx = 0, fails = 0, dead = false;
  /** @param {string[]} texts @returns {Promise<number[][]|null>} 失败返回 null，绝不抛出 */
  const embed = async (texts) => {
    if (dead) return null;
    const cfg = cands[idx];
    try {
      const resp = await fetch(`${cfg.base_url}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key || "ollama"}` },
        body: JSON.stringify({ model: cfg.model, input: texts }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const err = new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        // 4xx = 这条渠道压根不给用（没开通/欠费/key 不对/模型不存在），重试三次也是白试
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) err.fatalForChannel = true;
        throw err;
      }
      const data = await resp.json();
      const out = (Array.isArray(data.data) ? data.data : [])
        .slice()
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map((d) => d.embedding);
      if (out.length !== texts.length || out.some((v) => !Array.isArray(v))) throw new Error("返回的向量条数或形状不对");
      fails = 0;
      return out;
    } catch (e) {
      fails = e && e.fatalForChannel ? 3 : fails + 1; // 4xx 一次就够，不用陪它试满三次
      const why = String((e && e.message) || e).slice(0, 160);
      // 一条候选挂到头就换下一条；全部挂完才停用。换道要出声，不搞静默降级
      if (fails >= 3 && idx < cands.length - 1) {
        idx++; fails = 0;
        embed.model = cands[idx].model; // 换了嵌入模型，memory 那边会自动把旧向量作废重算
        console.warn(`[记忆向量] ${cfg.label} ${e && e.fatalForChannel ? "不可用" : "连挂 3 次"}（${why}），改用 ${cands[idx].label}（${cands[idx].model}）`);
      } else if (fails >= 3) {
        dead = true;
        console.warn(`[记忆向量] ${cfg.label} 也不行（${why}）。可用的嵌入渠道已用尽，记忆召回退回关键词匹配——` +
          `想恢复语义召回，去 设置 → 模型 配一条支持 embeddings 的渠道（通义/智谱/OpenAI，或本机跑起 Ollama）`);
      } else {
        console.warn(`[记忆向量] ${cfg.label} 调用失败（${fails}/3）：${why}`);
      }
      return null;
    }
  };
  embed.model = cands[0].model;
  embed.candidates = cands.map((c) => `${c.label} → ${c.model}`); // 供 /api/info 之类如实展示
  return embed;
}

module.exports = { createLLM, createEmbedder, _internals: { rescueLeakedToolCalls, createLeakGuard, openaiChat, EMBED_KNOWN, embedCandidates } };
