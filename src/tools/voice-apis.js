// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 配音和转写的另外两门话：豆包语音、自定义 HTTP。
 *
 * OpenAI 兼容和千问 TTS 在 media.js 里。这两种放这儿，是因为它们跟那边的形状都不一样：
 *
 * 豆包语音（火山引擎 openspeech.bytedance.com，文档 https://docs.volcengine.com/docs/doubao-voice/list）
 *   配音  POST /api/v3/tts/unidirectional。返回一行一个 JSON，音频是 base64 分段给的，
 *         code 20000000 收尾，0 是中间段，别的都是错。音色和资源必须配对：
 *         seed-tts-2.0 只吃 2.0 音色，seed-tts-1.0 只吃 1.0 音色，错配就是报错。
 *   转写  POST /api/v3/auc/bigmodel/recognize/flash，一次请求拿结果，音频走 base64。
 *         成败看响应头 X-Api-Status-Code，不看 HTTP 状态码。上限 100MB、两小时，只收 WAV / MP3 / OGG。
 *   鉴权  新版控制台一把 API Key。老版控制台是 App ID + Access Token，渠道上写成「AppID:Token」。
 *
 * 自定义 HTTP 是给「别家的配音 / 转写接口」用的：地址、请求头、请求体、结果在哪，写成一份模板就能接，
 * 不用改代码。模板由平台管理员配在渠道上，成员碰不到；{{key}} 只在发请求时替换，不进日志和报错。
 */
const crypto = require("crypto");

const VOLC_OK = 20000000;
const VOLC_ASR_MAX = 100 * 1048576;
const VOLC_ASR_EXT = /\.(wav|mp3|ogg|opus)$/i;

/** 2.0 和 1.0 的音色长得不一样，默认音色要跟资源配对，错配上游直接拒 */
const VOLC_VOICES = {
  "seed-tts-2.0": ["zh_female_vv_uranus_bigtts", "zh_female_xiaohe_uranus_bigtts", "zh_male_m191_uranus_bigtts", "zh_male_taocheng_uranus_bigtts", "zh_male_liufei_uranus_bigtts", "zh_female_sophie_uranus_bigtts"],
  "seed-tts-1.0": ["zh_female_shuangkuaisisi_moon_bigtts", "zh_female_linjianvhai_moon_bigtts", "zh_male_yangguangqingnian_moon_bigtts", "zh_male_yuanboxiaoshu_moon_bigtts"],
};
const VOLC_TTS_MODELS = ["seed-tts-2.0", "seed-tts-1.0", "seed-tts-1.0-concurr", "seed-icl-2.0", "seed-icl-1.0", "seed-icl-1.0-concurr"];
const VOLC_ASR_DEFAULT = "volc.bigasr.auc_turbo";

/** 这个音色是不是跟这个资源配得上。声音复刻的音色是用户自己的 ID，不判 */
function volcVoiceProblem(/** @type {string} */ model, /** @type {string} */ voice) {
  if (!voice) return "";
  if (/^seed-tts-2/.test(model) && /_(moon|mars)_bigtts$|^BV\d/.test(voice)) return `音色 ${voice} 是 1.0 的，${model} 只能用 2.0 音色（名字里带 uranus 或 saturn）`;
  if (/^seed-tts-1/.test(model) && /_(uranus|saturn)_bigtts$/.test(voice)) return `音色 ${voice} 是 2.0 的，${model} 只能用 1.0 音色`;
  return "";
}

/** 新版一把 Key，老版 AppID:Token。TTS 和转写的头名字不一样，这是官方接口的差异 */
function volcAuth(/** @type {string} */ key, /** @type {"tts"|"asr"} */ use) {
  const k = String(key || "").trim();
  const i = k.indexOf(":");
  if (i <= 0) return { "X-Api-Key": k };
  return { [use === "tts" ? "X-Api-App-Id" : "X-Api-App-Key"]: k.slice(0, i), "X-Api-Access-Key": k.slice(i + 1) };
}

/** 语速：我们的 0.5–2 倍换成它的 [-50, 100] */
function volcRate(/** @type {any} */ speed) {
  const s = Number(speed);
  if (!s) return 0;
  return Math.round((Math.min(Math.max(s, 0.5), 2) - 1) * 100);
}

/**
 * 读一行一个 JSON 的响应，拼出音频。出错的行把上游原话带回去。
 * @param {string} text
 * @returns {{ audio: Buffer, error: string }}
 */
function parseVolcTts(text) {
  const parts = [];
  let done = false;
  for (const line of String(text).split("\n")) {
    const t = line.trim().replace(/^data:\s*/, "");
    if (!t || t[0] !== "{") continue;
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (j.code === VOLC_OK) { done = true; continue; }
    if (j.code !== 0 && j.code !== undefined) return { audio: Buffer.alloc(0), error: `${j.code} ${j.message || ""}`.trim() };
    if (typeof j.data === "string" && j.data) parts.push(Buffer.from(j.data, "base64"));
  }
  const audio = Buffer.concat(parts);
  if (!audio.length) return { audio, error: done ? "上游说完成了，但没有音频" : "上游没有返回音频" };
  return { audio, error: "" };
}

/**
 * @param {{ base: string, key: string, model: string, text: string, voice: string, speed?: any, format?: string, signal?: AbortSignal, fetchFn?: typeof fetch }} o
 * @returns {Promise<{ audio?: Buffer, error?: string, status?: number }>}
 */
async function volcTts(o) {
  const model = o.model || "seed-tts-2.0";
  const voice = o.voice || (VOLC_VOICES[/** @type {keyof typeof VOLC_VOICES} */ (model)] || [""])[0];
  if (!voice) return { error: "没指定音色。声音复刻要填你自己的音色 ID" };
  const bad = volcVoiceProblem(model, voice);
  if (bad) return { error: bad };
  const f = o.fetchFn || fetch;
  const r = await f(`${String(o.base).replace(/\/+$/, "")}/api/v3/tts/unidirectional`, {
    method: "POST", signal: o.signal,
    headers: { "Content-Type": "application/json", ...volcAuth(o.key, "tts"), "X-Api-Resource-Id": model, "X-Api-Request-Id": crypto.randomUUID() },
    body: JSON.stringify({
      user: { uid: "openworkbuddy" },
      req_params: { text: o.text, speaker: voice, audio_params: { format: o.format || "mp3", sample_rate: 24000, speech_rate: volcRate(o.speed) } },
    }),
  });
  const body = await r.text();
  if (!r.ok) return { error: `接口错误 ${r.status}: ${body.slice(0, 300)}`, status: r.status };
  const { audio, error } = parseVolcTts(body);
  return error ? { error: `语音接口错误：${error}` } : { audio };
}

/**
 * @param {{ base: string, key: string, model?: string, buf: Buffer, name: string, signal?: AbortSignal, fetchFn?: typeof fetch }} o
 * @returns {Promise<{ text?: string, segments?: Array<{ start: number, end: number, text: string }>, error?: string, status?: number }>}
 */
async function volcAsr(o) {
  if (!VOLC_ASR_EXT.test(o.name)) return { error: `豆包转写只收 WAV / MP3 / OGG，${o.name} 要先转一下：ffmpeg -i "${o.name}" -ac 1 -ar 16000 -b:a 64k out.mp3` };
  if (o.buf.length > VOLC_ASR_MAX) return { error: `文件超过豆包转写 100MB 的上限（${(o.buf.length / 1048576).toFixed(1)}MB），先压小或切段` };
  const f = o.fetchFn || fetch;
  const r = await f(`${String(o.base).replace(/\/+$/, "")}/api/v3/auc/bigmodel/recognize/flash`, {
    method: "POST", signal: o.signal,
    headers: { "Content-Type": "application/json", ...volcAuth(o.key, "asr"), "X-Api-Resource-Id": o.model || VOLC_ASR_DEFAULT, "X-Api-Request-Id": crypto.randomUUID(), "X-Api-Sequence": "-1" },
    body: JSON.stringify({ user: { uid: "openworkbuddy" }, audio: { data: o.buf.toString("base64") }, request: { model_name: "bigmodel", enable_itn: true, enable_punc: true } }),
  });
  const body = await r.text();
  const code = Number(r.headers.get("x-api-status-code") || 0);
  if (!r.ok || (code && code !== VOLC_OK)) return { error: `转写接口错误 ${r.status}${code ? " / " + code : ""}: ${r.headers.get("x-api-message") || body.slice(0, 300)}`, status: r.status };
  let j;
  try { j = JSON.parse(body); } catch { return { error: "转写接口返回的不是 JSON" }; }
  const res = j.result || {};
  return {
    text: String(res.text || "").trim(),
    // 上游给的是毫秒，字幕那边按秒算
    segments: (Array.isArray(res.utterances) ? res.utterances : []).filter((u) => u && typeof u.text === "string").map((u) => ({ start: (+u.start_time || 0) / 1000, end: (+u.end_time || 0) / 1000, text: u.text })),
  };
}

// ---------- 自定义 HTTP ----------

/** 按 a.b.0.c 取值。路径写错返回 undefined，由调用方报人话 */
function pathGet(/** @type {any} */ obj, /** @type {string} */ p) {
  let cur = obj;
  for (const k of String(p || "").split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 把 {{text}} 这些换掉。整个值就是一个占位符时保留原类型；字符串里嵌着的走字面替换 */
function fill(/** @type {any} */ v, /** @type {Record<string, any>} */ vars) {
  if (typeof v === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(v);
    if (whole) return vars[whole[1]] === undefined ? "" : vars[whole[1]];
    return v.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined ? "" : String(vars[k])));
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

/**
 * 模板写得对不对。保存时和调用前都过一遍，错了说清楚哪一项。
 * @param {any} t @param {"tts"|"asr"} use
 */
function templateProblem(t, use) {
  if (!t || typeof t !== "object") return "模板要是一个 JSON 对象";
  let u;
  try { u = new URL(String(t.url || "").replace(/\{\{\w+\}\}/g, "x")); } catch { return "url 不是合法地址"; }
  if (!/^https?:$/.test(u.protocol)) return "url 只支持 http / https";
  if (t.headers && typeof t.headers !== "object") return "headers 要是对象";
  if (use === "tts" && !/^(binary|base64:.+|url:.+)$/.test(String(t.audio || "binary"))) return "audio 写 binary、base64:路径 或 url:路径";
  if (use === "asr") {
    if (!t.text) return "text 要写清结果里文字的路径，比如 result.text";
    if (!/^(multipart:.+|base64:.+)$/.test(String(t.upload || "multipart:file"))) return "upload 写 multipart:字段名 或 base64:路径";
  }
  return "";
}

/** 报错里不能带 Key：上游常把请求头原样回显 */
const scrub = (/** @type {string} */ s, /** @type {string} */ key) => (key ? String(s).split(key).join("***") : String(s));

/**
 * @param {{ template: any, key: string, model: string, text: string, voice: string, speed?: any, signal?: AbortSignal, fetchFn?: typeof fetch, download?: (u: string) => Promise<Buffer> }} o
 * @returns {Promise<{ audio?: Buffer, error?: string, status?: number }>}
 */
async function httpTts(o) {
  const bad = templateProblem(o.template, "tts");
  if (bad) return { error: `自定义配音接口的模板有问题：${bad}` };
  const t = o.template;
  const vars = { text: o.text, voice: o.voice, model: o.model, speed: o.speed || 1, key: o.key };
  const f = o.fetchFn || fetch;
  const r = await f(fill(t.url, vars), {
    method: String(t.method || "POST").toUpperCase(), signal: o.signal,
    headers: { "Content-Type": "application/json", ...fill(t.headers || {}, vars) },
    ...(t.body === undefined ? {} : { body: JSON.stringify(fill(t.body, vars)) }),
  });
  if (!r.ok) return { error: scrub(`接口错误 ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`, o.key), status: r.status };
  const how = String(t.audio || "binary");
  if (how === "binary") return { audio: Buffer.from(await r.arrayBuffer()) };
  const j = await r.json().catch(() => null);
  const at = how.slice(how.indexOf(":") + 1);
  const val = pathGet(j, at);
  if (typeof val !== "string" || !val) return { error: `结果里 ${at} 没取到音频：${scrub(JSON.stringify(j) || "", o.key).slice(0, 200)}` };
  if (how.startsWith("base64:")) return { audio: Buffer.from(val, "base64") };
  if (!o.download) return { error: "这个模板要下载音频地址，当前调用没给下载函数" };
  return { audio: await o.download(val) };
}

/**
 * @param {{ template: any, key: string, model: string, buf: Buffer, name: string, language?: string, signal?: AbortSignal, fetchFn?: typeof fetch }} o
 * @returns {Promise<{ text?: string, segments?: Array<{ start: number, end: number, text: string }>, error?: string, status?: number }>}
 */
async function httpAsr(o) {
  const bad = templateProblem(o.template, "asr");
  if (bad) return { error: `自定义转写接口的模板有问题：${bad}` };
  const t = o.template;
  const vars = { model: o.model, key: o.key, filename: o.name, language: o.language || "" };
  const how = String(t.upload || "multipart:file");
  const field = how.slice(how.indexOf(":") + 1);
  const headers = fill(t.headers || {}, vars);
  /** @type {any} */
  let body;
  if (how.startsWith("multipart:")) {
    body = new FormData();
    body.append(field, new Blob([new Uint8Array(o.buf)]), o.name);
    for (const [k, v] of Object.entries(fill(t.fields || {}, vars))) body.append(k, String(v));
  } else {
    const b = fill(t.body || {}, vars);
    let cur = b;
    const keys = field.split(".");
    keys.slice(0, -1).forEach((k) => { cur = cur[k] = cur[k] || {}; });
    cur[keys[keys.length - 1]] = o.buf.toString("base64");
    body = JSON.stringify(b);
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  const f = o.fetchFn || fetch;
  const r = await f(fill(t.url, vars), { method: String(t.method || "POST").toUpperCase(), signal: o.signal, headers, body });
  if (!r.ok) return { error: scrub(`转写接口错误 ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`, o.key), status: r.status };
  const j = await r.json().catch(() => null);
  const text = pathGet(j, t.text);
  if (typeof text !== "string" || !text.trim()) return { error: `结果里 ${t.text} 没取到文字：${scrub(JSON.stringify(j) || "", o.key).slice(0, 200)}` };
  const raw = t.segments ? pathGet(j, t.segments) : null;
  const scale = +t.time_scale || 1; // 毫秒写 0.001
  const segments = Array.isArray(raw) ? raw.map((s) => ({ start: (+s.start || +s.start_time || 0) * scale, end: (+s.end || +s.end_time || 0) * scale, text: String(s.text || "") })) : [];
  return { text: text.trim(), segments };
}

module.exports = { VOLC_VOICES, VOLC_TTS_MODELS, VOLC_ASR_DEFAULT, VOLC_ASR_MAX, volcAuth, volcRate, volcVoiceProblem, parseVolcTts, volcTts, volcAsr, fill, pathGet, templateProblem, httpTts, httpAsr };
