// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 豆包语音和自定义 HTTP（src/tools/voice-apis.js）。跑法：node test/voice-apis.js
 * 全离线：假 fetch 按官方文档的报文回话，核的是我们发出去的字段和解析结果。
 * 文档：https://docs.volcengine.com/docs/6561/1598757（配音）、/1631584（极速版转写）。
 * 没有真 Key，所以这里证明的是「跟文档写的一致」，不是「线上调通了」。
 */
const { mod } = require("./lib/mod");
const v = require(mod("voice-apis"));
const mm = require(mod("media-models"));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };
const B64 = (s) => Buffer.from(s).toString("base64");
const respond = (body, { status = 200, headers = {} } = {}) => new Response(body, { status, headers });

(async () => {
  console.log("【1】配音请求");
  let seen = null;
  const lines = [{ code: 0, message: "", data: B64("AAA") }, { code: 0, message: "", data: null, sentence: { text: "x" } }, { code: 0, message: "", data: B64("BBB") }, { code: 20000000, message: "ok", data: null }];
  const fake = async (url, o) => { seen = { url, o, body: JSON.parse(o.body) }; return respond(lines.map((l) => JSON.stringify(l)).join("\n")); };
  const r = await v.volcTts({ base: "https://openspeech.bytedance.com/", key: "k1", model: "seed-tts-2.0", text: "你好", voice: "zh_female_vv_uranus_bigtts", speed: 2, fetchFn: fake });
  ok(seen.url === "https://openspeech.bytedance.com/api/v3/tts/unidirectional", "打的是文档上的地址");
  ok(seen.o.headers["X-Api-Key"] === "k1" && seen.o.headers["X-Api-Resource-Id"] === "seed-tts-2.0", "新版控制台：X-Api-Key + 资源 ID");
  ok(seen.body.req_params.text === "你好" && seen.body.req_params.speaker === "zh_female_vv_uranus_bigtts", "text、speaker 放在 req_params 下");
  ok(seen.body.req_params.audio_params.speech_rate === 100, "2 倍速换成 100");
  ok(r.audio.toString() === "AAABBB", "★分段音频按顺序拼起来，字幕行跳过★");

  console.log("【2】鉴权两种写法");
  ok(JSON.stringify(v.volcAuth("appid:tok", "tts")) === JSON.stringify({ "X-Api-App-Id": "appid", "X-Api-Access-Key": "tok" }), "老版控制台 配音：App-Id");
  ok(JSON.stringify(v.volcAuth("appid:tok", "asr")) === JSON.stringify({ "X-Api-App-Key": "appid", "X-Api-Access-Key": "tok" }), "老版控制台 转写：App-Key，两个接口的头名字不一样");

  console.log("【3】错的都说得清");
  ok(/2\.0 音色/.test((await v.volcTts({ base: "b", key: "k", model: "seed-tts-2.0", text: "x", voice: "zh_female_shuangkuaisisi_moon_bigtts", fetchFn: fake })).error), "★1.0 音色配 2.0 资源：发请求之前就拦★");
  ok(/1\.0 音色/.test((await v.volcTts({ base: "b", key: "k", model: "seed-tts-1.0", text: "x", voice: "zh_female_vv_uranus_bigtts", fetchFn: fake })).error), "反过来也拦");
  ok(v.volcVoiceProblem("seed-icl-2.0", "S_abcdef") === "", "声音复刻的音色是用户自己的 ID，不判");
  const bad = await v.volcTts({ base: "b", key: "k", model: "seed-tts-2.0", text: "x", voice: "", fetchFn: async () => respond(JSON.stringify({ code: 40402003, message: "resource not granted" })) });
  ok(/40402003/.test(bad.error) && /not granted/.test(bad.error), "上游错误码和原话带回来");
  ok((await v.volcTts({ base: "b", key: "k", model: "seed-tts-2.0", text: "x", voice: "", fetchFn: async () => respond("nope", { status: 401 }) })).status === 401, "HTTP 错误带状态码，渠道健康账认得出");

  console.log("【4】转写");
  let asr = null;
  const ok200 = { "x-api-status-code": "20000000", "x-api-message": "OK" };
  const fakeAsr = async (url, o) => { asr = { url, o, body: JSON.parse(o.body) }; return respond(JSON.stringify({ audio_info: { duration: 2499 }, result: { text: "关闭透传。", utterances: [{ start_time: 450, end_time: 1530, text: "关闭透传。" }] } }), { headers: ok200 }); };
  const t = await v.volcAsr({ base: "https://openspeech.bytedance.com", key: "k", buf: Buffer.from("audio"), name: "a.mp3", fetchFn: fakeAsr });
  ok(asr.url.endsWith("/api/v3/auc/bigmodel/recognize/flash") && asr.o.headers["X-Api-Resource-Id"] === "volc.bigasr.auc_turbo" && asr.o.headers["X-Api-Sequence"] === "-1", "地址、资源 ID、序号都按文档");
  ok(asr.body.audio.data === B64("audio") && asr.body.request.model_name === "bigmodel", "音频走 base64，model_name 是 bigmodel");
  ok(t.text === "关闭透传。" && t.segments[0].start === 0.45 && t.segments[0].end === 1.53, "★毫秒换成秒★ 字幕那边按秒算");
  const failed = await v.volcAsr({ base: "b", key: "k", buf: Buffer.from("a"), name: "a.mp3", fetchFn: async () => respond("{}", { headers: { "x-api-status-code": "45000001", "x-api-message": "bad" } }) });
  ok(/45000001/.test(failed.error), "★HTTP 200 也可能失败★ 成败看响应头");
  ok(/WAV/.test((await v.volcAsr({ base: "b", key: "k", buf: Buffer.from("a"), name: "a.m4a", fetchFn: fakeAsr })).error), "不收的格式当场说，并给转码命令");

  console.log("【5】自定义 HTTP");
  let h = null;
  const tpl = { url: "https://api.example.com/tts", headers: { Authorization: "Bearer {{key}}" }, body: { text: "{{text}}", voice: "{{voice}}", speed: "{{speed}}" }, audio: "base64:data.audio" };
  const out = await v.httpTts({ template: tpl, key: "sk-1", model: "m", text: "你好", voice: "v1", speed: 1.5, fetchFn: async (u, o) => { h = { u, o, b: JSON.parse(o.body) }; return respond(JSON.stringify({ data: { audio: B64("WAV") } })); } });
  ok(h.o.headers.Authorization === "Bearer sk-1" && h.b.text === "你好", "占位符换好了");
  ok(h.b.speed === 1.5, "整个值就是占位符时保留数字类型");
  ok(out.audio.toString() === "WAV", "按路径取到音频");
  ok((await v.httpTts({ template: { ...tpl, audio: "binary" }, key: "k", model: "m", text: "x", voice: "", fetchFn: async () => respond(Buffer.from("RAW")) })).audio.toString() === "RAW", "二进制直接收");
  const leak = await v.httpTts({ template: tpl, key: "sk-secret", model: "m", text: "x", voice: "", fetchFn: async () => respond("bad key sk-secret", { status: 401 }) });
  ok(!leak.error.includes("sk-secret") && leak.error.includes("***"), "★上游把 Key 回显了也不进报错★");
  ok(/url/.test(v.templateProblem({ url: "ftp://x" }, "tts")), "只收 http / https");
  ok(/text/.test(v.templateProblem({ url: "https://x" }, "asr")), "转写模板要写清文字路径");
  const a = await v.httpAsr({ template: { url: "https://x/asr", upload: "base64:audio.data", body: { model: "{{model}}" }, text: "r.text", segments: "r.segs", time_scale: 0.001 }, key: "k", model: "m", buf: Buffer.from("A"), name: "a.mp3",
    fetchFn: async (u, o) => { h = JSON.parse(o.body); return respond(JSON.stringify({ r: { text: "好", segs: [{ start: 1000, end: 2000, text: "好" }] } })); } });
  ok(h.audio.data === B64("A") && h.model === "m", "base64 放到模板指定的路径");
  ok(a.text === "好" && a.segments[0].end === 2, "分段时间按 time_scale 换算");

  console.log("【6】接线");
  ok(mm.mediaApiOf("tts", { kind: "volc_speech" }).api === "volc" && mm.mediaApiOf("asr", { kind: "volc_speech" }).api === "volc", "豆包语音渠道自动走豆包接口");
  ok(mm.mediaApiOf("tts", { base_url: "https://openspeech.bytedance.com" }).api === "volc", "只填地址也认得出");
  ok(mm.mediaApiOf("tts", { kind: "custom", tts_api: "http" }).api === "http", "渠道上选了自定义 HTTP 最大");
  ok(mm.mediaApiOf("asr", { kind: "openai" }).api === "openai", "别的渠道不受影响");
  ok(JSON.stringify(mm.chosenApi("tts", { tts_api: "http", http_api: { tts: {} } })).includes("http_api"), "模板跟着渠道走");
  ok(!JSON.stringify(mm.chosenApi("tts", { tts_api: "openai", http_api: { tts: {} } })).includes("http_api"), "没选自定义就不带模板");
  ok(mm.catalogFor("tts", "volc_speech").length === 2 && mm.catalogFor("asr", "volc_speech").length === 1, "目录里摆上了");
  ok(!mm.canHost("volc_speech", "chat") && mm.canHost("volc_speech", "tts"), "语音渠道不进对话下拉");

  console.log(`\n语音接口：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
