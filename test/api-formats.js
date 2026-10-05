// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 通用接口格式：OpenAI Responses / Google Gemini / Ollama 原生，外加渠道上手选格式那条链路。
 *
 * 跑法：node test/api-formats.js（不联网、不花钱：每种格式起一个本机假服务端）
 *
 * 为什么要有：客户本地部署的模型不一定说 OpenAI 的 chat/completions——有的只开了 Ollama 原生口，
 * 有的是 Gemini 兼容网关，有的新网关只认 /responses。以前渠道只分 openai / anthropic 两种，
 * 选不对就只能看一串 404。这里每种格式都真打一遍：
 *   - 地址、头、正文字段对不对（这家认的是什么就发什么）；
 *   - 流式 / 非流式都拼得出正文，用量对得上；
 *   - 工具来回一整圈：模型要调工具 → 我们回结果 → 下一轮请求里那段往来按这家的写法带回去；
 *   - 出错说人话，被拦要说是被拦，不是一句「空响应」。
 */

const http = require("http");
const assert = require("assert");
const { mod } = require("./lib/mod");
const { createLLM, pingRequest, _internals } = require(mod("llm"));
const mediaModels = require(mod("media-models"));
const chatModels = require(mod("chat-models"));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log("  ✅ " + name); }
  catch (e) { fail++; console.log("  ❌ " + name + "\n     " + String((e && e.stack) || e).split("\n").slice(0, 4).join("\n     ")); }
}

/** 起一个假服务端：handler(req, body, res)，记下每次请求 */
function fake(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null; try { body = JSON.parse(raw); } catch {}
      seen.push({ url: req.url, headers: req.headers, body });
      handler(req, body, res, seen.length);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` })));
}
const sse = (res, events) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const json = (res, obj, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const TOOLS = [{
  name: "read_file",
  description: "读文件",
  input_schema: { type: "object", additionalProperties: false, $schema: "x", properties: { path: { type: ["string", "null"], description: "路径", default: "a" } }, required: ["path"] },
}];
const llmOf = (m) => createLLM({ models: [{ name: "测", api_key: "k-test", model: "m1", ...m }], active_model: "测" });

(async () => {
  console.log("OpenAI Responses");
  {
    const f = await fake((req, b, res, n) => {
      if (n === 1) {
        return sse(res, [
          { type: "response.output_text.delta", delta: "我先" },
          { type: "response.output_text.delta", delta: "看看" },
          { type: "response.output_item.done", item: { type: "function_call", call_id: "call_A", name: "read_file", arguments: "{\"path\":\"x.md\"}" } },
          { type: "response.completed", response: { status: "completed", output: [
            { type: "message", content: [{ type: "output_text", text: "我先看看" }] },
            { type: "function_call", call_id: "call_A", name: "read_file", arguments: "{\"path\":\"x.md\"}" },
          ], usage: { input_tokens: 100, output_tokens: 7, input_tokens_details: { cached_tokens: 40 } } } },
        ]);
      }
      json(res, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "写到一半" }] }], usage: { input_tokens: 5, output_tokens: 9 } });
    });
    const llm = llmOf({ provider: "openai-responses", base_url: f.base + "/v1/" });
    let streamed = "";
    let r1;
    await check("流式：打 /v1/responses、带 Bearer、instructions 放系统提示词、store:false", async () => {
      r1 = await llm.chat({ system: "你是助手", history: [{ role: "user", content: "看下 x.md" }], tools: TOOLS, onTextDelta: (d) => (streamed += d) });
      const q = f.seen[0];
      assert.strictEqual(q.url, "/v1/responses");
      assert.strictEqual(q.headers.authorization, "Bearer k-test");
      assert.strictEqual(q.body.instructions, "你是助手");
      assert.strictEqual(q.body.store, false);
      assert.strictEqual(q.body.stream, true);
      assert.deepStrictEqual(q.body.tools[0].name, "read_file");
      assert.strictEqual(q.body.tools[0].type, "function");
      assert.deepStrictEqual(q.body.input, [{ role: "user", content: "看下 x.md" }]);
    });
    await check("流式：正文边到边吐，工具调用和用量都拿到", async () => {
      assert.strictEqual(streamed, "我先看看");
      assert.strictEqual(r1.text, "我先看看");
      assert.deepStrictEqual(r1.toolCalls, [{ id: "call_A", name: "read_file", input: { path: "x.md" } }]);
      assert.strictEqual(r1.stopReason, "tool_calls");
      assert.deepStrictEqual(r1.usage, { prompt: 100, completion: 7, cached: 40 });
    });
    await check("工具来回：下一轮带回 function_call + function_call_output，call_id 对得上", async () => {
      const llm2 = llmOf({ provider: "openai-responses", base_url: f.base + "/v1", stream: false });
      const r = await llm2.chat({ system: "s", tools: TOOLS, history: [
        { role: "user", content: "看下 x.md" },
        { role: "assistant", text: "我先看看", toolCalls: r1.toolCalls },
        { role: "tool", results: [{ id: "call_A", content: "文件内容", isError: false }] },
      ] });
      const input = f.seen[1].body.input;
      assert.deepStrictEqual(input.slice(1), [
        { role: "assistant", content: "我先看看" },
        { type: "function_call", call_id: "call_A", name: "read_file", arguments: "{\"path\":\"x.md\"}" },
        { type: "function_call_output", call_id: "call_A", output: "文件内容" },
      ]);
      assert.strictEqual(f.seen[1].body.stream, false);
      assert.strictEqual(r.text, "写到一半");
      assert.strictEqual(r.stopReason, "length", "被 max_output_tokens 截断要报 length，agent 靠它接着写");
    });
    f.srv.close();
  }

  console.log("Google Gemini");
  {
    const f = await fake((req, b, res, n) => {
      if (n === 1) {
        return sse(res, [
          { candidates: [{ content: { role: "model", parts: [{ text: "想一想", thought: true }, { text: "好的，" }] } }] },
          { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "a.md" } }, thoughtSignature: "SIG1" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 4, thoughtsTokenCount: 6, cachedContentTokenCount: 10 } },
        ]);
      }
      if (n === 2) return json(res, { candidates: [{ content: { role: "model", parts: [{ text: "读完了" }] }, finishReason: "MAX_TOKENS" }] });
      if (n === 3) return json(res, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } });
      json(res, { error: { code: 403, message: "API key not valid" } }, 403);
    });
    const llm = llmOf({ provider: "gemini", base_url: f.base + "/v1beta" });
    let streamed = "";
    let r1;
    await check("流式：打 models/{model}:streamGenerateContent?alt=sse，Key 走 x-goog-api-key", async () => {
      r1 = await llm.chat({ system: "你是助手", history: [{ role: "user", content: "读 a.md" }], tools: TOOLS, onTextDelta: (d) => (streamed += d) });
      const q = f.seen[0];
      assert.strictEqual(q.url, "/v1beta/models/m1:streamGenerateContent?alt=sse");
      assert.strictEqual(q.headers["x-goog-api-key"], "k-test");
      assert.strictEqual(q.headers.authorization, undefined);
      assert.deepStrictEqual(q.body.systemInstruction, { parts: [{ text: "你是助手" }] });
      assert.deepStrictEqual(q.body.contents, [{ role: "user", parts: [{ text: "读 a.md" }] }]);
    });
    await check("工具表按 Gemini 认的子集发：additionalProperties/$schema/default 剥掉，[\"string\",\"null\"] 拆成 nullable", async () => {
      const params = f.seen[0].body.tools[0].functionDeclarations[0].parameters;
      assert.deepStrictEqual(params, { type: "object", properties: { path: { type: "string", nullable: true, description: "路径" } }, required: ["path"] });
    });
    await check("思考摘要不进正文；没带 id 的调用补一个，思考签名收着；用量把思考 token 算进输出", async () => {
      assert.strictEqual(streamed, "好的，");
      assert.strictEqual(r1.text, "好的，");
      assert.strictEqual(r1.toolCalls.length, 1);
      assert.match(r1.toolCalls[0].id, /^gm_/);
      assert.strictEqual(r1.toolCalls[0].sig, "SIG1");
      assert.deepStrictEqual(r1.toolCalls[0].input, { path: "a.md" });
      assert.strictEqual(r1.stopReason, "tool_calls");
      assert.deepStrictEqual(r1.usage, { prompt: 50, completion: 10, cached: 10 });
    });
    await check("工具来回：functionCall 带回签名、不带我们编的 id；functionResponse 按名字认", async () => {
      const llm2 = llmOf({ provider: "gemini", base_url: f.base + "/v1beta/models/m1", stream: false });
      const r = await llm2.chat({ system: "s", tools: TOOLS, history: [
        { role: "user", content: "读 a.md" },
        { role: "assistant", text: "好的，", toolCalls: r1.toolCalls },
        { role: "tool", results: [{ id: r1.toolCalls[0].id, content: "内容A", isError: false }] },
        { role: "user", content: "顺便总结" },
      ] });
      const q = f.seen[1];
      assert.strictEqual(q.url, "/v1beta/models/m1:generateContent", "填成 .../models/m1 的地址也要剪回根");
      assert.deepStrictEqual(q.body.contents, [
        { role: "user", parts: [{ text: "读 a.md" }] },
        { role: "model", parts: [{ text: "好的，" }, { functionCall: { name: "read_file", args: { path: "a.md" } }, thoughtSignature: "SIG1" }] },
        { role: "user", parts: [{ functionResponse: { name: "read_file", response: { result: "内容A" } } }, { text: "顺便总结" }] },
      ], "同角色挨着的要并成一条，Gemini 不收两条连着的 user");
      assert.strictEqual(r.text, "读完了");
      assert.strictEqual(r.stopReason, "length");
    });
    await check("被 Gemini 安全策略拦下：说是它拦的，带上原因，不说成空响应", async () => {
      const llm3 = llmOf({ provider: "gemini", base_url: f.base + "/v1beta", stream: false });
      await assert.rejects(llm3.chat({ system: "", history: [{ role: "user", content: "x" }] }), /Gemini 拦下了这次请求.*PROHIBITED_CONTENT/);
    });
    await check("Key 不对（403）：翻成人话", async () => {
      const llm3 = llmOf({ provider: "gemini", base_url: f.base + "/v1beta", stream: false });
      await assert.rejects(llm3.chat({ system: "", history: [{ role: "user", content: "x" }] }), (e) => !/^LLM 接口错误 403/.test(e.message) && /Key|403/.test(e.message));
    });
    f.srv.close();
  }

  console.log("Ollama 原生");
  {
    const f = await fake((req, b, res, n) => {
      if (n === 1) {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(JSON.stringify({ message: { role: "assistant", content: "查" } }) + "\n");
        res.write(JSON.stringify({ message: { role: "assistant", content: "一下", tool_calls: [{ function: { name: "read_file", arguments: { path: "b.md" } } }] } }) + "\n");
        res.end(JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 30, eval_count: 5 }) + "\n");
        return;
      }
      json(res, { message: { role: "assistant", content: "看完了" }, done: true, done_reason: "length", prompt_eval_count: 40, eval_count: 8 });
    });
    const llm = llmOf({ provider: "ollama", base_url: f.base + "/v1", api_key: "" });
    let streamed = "";
    let r1;
    await check("流式：填的是 .../v1 也打根上的 /api/chat；NDJSON 逐行拼出正文和工具调用", async () => {
      r1 = await llm.chat({ system: "你是助手", history: [{ role: "user", content: "看 b.md" }], tools: TOOLS, onTextDelta: (d) => (streamed += d) });
      const q = f.seen[0];
      assert.strictEqual(q.url, "/api/chat");
      assert.strictEqual(q.body.messages[0].role, "system");
      assert.strictEqual(q.body.tools[0].function.name, "read_file");
      assert.strictEqual(r1.text, "查一下");
      assert.strictEqual(streamed, "查一下");
      assert.strictEqual(r1.toolCalls[0].name, "read_file");
      assert.deepStrictEqual(r1.toolCalls[0].input, { path: "b.md" });
      assert.deepStrictEqual(r1.usage, { prompt: 30, completion: 5, cached: 0 });
    });
    await check("上下文窗口：不给 num_ctx 会被 Ollama 按几千 token 静默截掉，默认发 32k，渠道写了按渠道", async () => {
      assert.strictEqual(f.seen[0].body.options.num_ctx, 32768);
      assert.ok(f.seen[0].body.options.num_predict > 0);
      assert.strictEqual(_internals.ollamaCtx({ model: "qwen3", context_window: 65536 }), 65536);
    });
    await check("工具来回：结果按 tool_name 带回；assistant 的参数是对象不是字符串", async () => {
      const llm2 = llmOf({ provider: "ollama", base_url: f.base, api_key: "", stream: false });
      const r = await llm2.chat({ system: "", tools: TOOLS, history: [
        { role: "user", content: "看 b.md" },
        { role: "assistant", text: "查一下", toolCalls: r1.toolCalls },
        { role: "tool", results: [{ id: r1.toolCalls[0].id, content: "B的内容", isError: false }] },
      ] });
      const msgs = f.seen[1].body.messages;
      assert.deepStrictEqual(msgs[1].tool_calls, [{ function: { name: "read_file", arguments: { path: "b.md" } } }]);
      assert.deepStrictEqual(msgs[2], { role: "tool", content: "B的内容", tool_name: "read_file" });
      assert.strictEqual(r.stopReason, "length");
    });
    f.srv.close();
  }

  console.log("渠道上手选格式");
  await check("渠道写了 api 就按它走，没写按类型；认不出的格式当 OpenAI 兼容", async () => {
    assert.strictEqual(mediaModels.protoOfChannel({ kind: "custom", api: "ollama" }), "ollama");
    assert.strictEqual(mediaModels.protoOfChannel({ kind: "anthropic" }), "anthropic");
    assert.strictEqual(mediaModels.protoOfChannel({ kind: "gemini" }), "gemini");
    assert.strictEqual(mediaModels.protoOfChannel({ kind: "custom", api: "瞎写" }), "openai");
    assert.strictEqual(mediaModels.normApi("gemini"), "gemini");
    assert.strictEqual(mediaModels.normApi(undefined), "openai");
  });
  await check("模型挂在选了格式的渠道上：真跑时 provider 就是那个格式", async () => {
    const cfg = {
      providers: [{ id: "p1", name: "客户本地", kind: "custom", api: "openai-responses", base_url: "http://10.0.0.8:8000/v1", api_key: "x" }],
      models: [{ name: "本地大模型", channel: "p1", model: "local-284b" }],
    };
    chatModels.normalize(cfg);
    const m = cfg.models.find((x) => x.name === "本地大模型");
    assert.strictEqual(m.provider, "openai-responses");
    assert.strictEqual(_internals.chatFor(m).length, 1);
  });
  await check("「测一下」和真跑打同一个地址：每种格式的 ping 地址", async () => {
    const at = (provider, base_url) => pingRequest({ provider, base_url, model: "m1", api_key: "k" }).url;
    assert.strictEqual(at("openai", "http://h/v1/"), "http://h/v1/chat/completions");
    assert.strictEqual(at("openai-responses", "http://h/v1"), "http://h/v1/responses");
    assert.strictEqual(at("gemini", ""), "https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent");
    assert.strictEqual(at("ollama", "http://localhost:11434/v1"), "http://localhost:11434/api/chat");
    assert.match(at("anthropic", ""), /\/v1\/messages$/);
    assert.strictEqual(pingRequest({ provider: "gemini", model: "m1", api_key: "k" }).headers["x-goog-api-key"], "k");
  });

  console.log("流断在半句");
  await check("★没收到结束标记就收流：三种格式都标成 interrupted，agent 靠它接着要后半段★", async () => {
    const f = await fake((req, b, res) => {
      if (req.url.endsWith("/responses")) return sse(res, [{ type: "response.output_text.delta", delta: "说到一" }]);
      if (req.url.includes(":streamGenerateContent")) return sse(res, [{ candidates: [{ content: { role: "model", parts: [{ text: "说到一" }] } }] }]);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(JSON.stringify({ message: { role: "assistant", content: "说到一" }, done: false }) + "\n");
    });
    for (const m of [
      { provider: "openai-responses", base_url: f.base + "/v1" },
      { provider: "gemini", base_url: f.base + "/v1beta" },
      { provider: "ollama", base_url: f.base, api_key: "" },
    ]) {
      const r = await llmOf(m).chat({ system: "", history: [{ role: "user", content: "x" }] });
      assert.strictEqual(r.text, "说到一", m.provider);
      assert.strictEqual(r.stopReason, "interrupted", m.provider);
    }
    f.srv.close();
  });

  console.log(`\n接口格式：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();
