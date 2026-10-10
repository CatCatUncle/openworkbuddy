// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 渠道上的生图 / 视频 / 配音接口三个下拉，和两颗「测」不拿生图型号发对话。
 *
 *   node test/media-apis.js
 *
 * 不联网、不花钱：上游是本机 127.0.0.1 上起的一台假服务端，按路径记下每一个请求。
 * 真起一份 server.js（临时家，假 Key），从保存渠道一路走到出图，中间不抄任何一段源码。
 *
 * 盯四件事：
 *   一、「测」只拿对话型号发对话请求：百炼渠道对话走 /compatible-mode/v1（跟真跑同一个地址），
 *      挂在对话列表里的 qwen-image 改走不花钱的清单测活、只给半格；拿不到清单就只说验到哪儿，绝不真生成。
 *   二、生图同步 / 异步被上游明说拒了（官方错误码表原文那两句）才换一次，换成了记在这个进程里；
 *      5xx、400、收了单、渠道上选定了，一律不换。回执写清走的是哪种、换没换。
 *   三、三个下拉存在渠道上：保存 → 读回 → 生成整链按选的走；对话专用渠道和认不出的值不落盘。
 *   四、表单「自动」那一项说的走法跟服务端同一套判断；新加的字都有英文，不拿中文顶。
 *
 * 每条正向断言后面跟反向对照：把那一条的依据抽掉，它必须变红。
 */

// 赶在 require 生产模块之前：审计、设置都落进临时家（见 test/lib/own-home.js）
const HOME = require("./lib/own-home")("media-apis");

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { mod } = require("./lib/mod");

const ROOT = path.join(__dirname, "..");
const mm = require(mod("media-models"));
// media.js 的工作目录由 tools.js 接上（bindWorkspace），先加载 tools 再拿同一份模块实例
require(mod("tools"));
const MEDIA = require(path.join(ROOT, "src", "tools", "media"));
const I18N = require(path.join(ROOT, "public", "js", "i18n.js"));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 400) : "")); }
}
const section = (t) => console.log("\n" + t);
process.on("exit", (code) => { if (!code && fail) process.exitCode = 1; });

// ── 假上游 ─────────────────────────────────────────────
// 1×1 的 PNG：出图那一步要真下载、真落盘
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const AUDIO = Buffer.alloc(600, 7); // 配音那一路要求 ≥200 字节才算有声音

// 百炼官方错误码表（https://help.aliyun.com/zh/model-studio/error-code）里「调用方式不对」那两条，原文照抄
const SYNC_NO = { status: 403, json: { code: "AccessDenied", message: "current user api does not support synchronous calls.", request_id: "fake-1" } };
const ASYNC_NO = { status: 403, json: { code: "AccessDenied", message: "Current user api does not support asynchronous calls.", request_id: "fake-2" } };
// 同一张表里地址拼错时回的那条：原生 /api/v1 后面接 /chat/completions 就是这个下场
const URL_ERR = { status: 400, json: { code: "InvalidParameter", message: "url error, please check url!", request_id: "fake-3" } };
// 同一张表的 403 Model.AccessDenied：Key 是好的，是这个工作空间没开这个型号
const DENY = { status: 403, json: { code: "Model.AccessDenied", message: "Model access denied.", request_id: "fake-4" } };
// 百炼原生清单（https://help.aliyun.com/zh/model-studio/list-models）：output.models[].model，分页，一页 20 个；
// name 是中文显示名。qwen-image 排在第一页之后——不按型号查，第一页里就翻不到它
const CATALOG = [...Array.from({ length: 24 }, (_, i) => `qwen-fake-${i}`), "qwen-plus", "qwen-image"];
const nativeList = (q) => {
  const want = q.get("model");
  const rows = want ? CATALOG.filter((m) => m === want) : CATALOG.slice(0, 20);
  return { json: { code: null, message: null, success: true, output: { total: want ? rows.length : CATALOG.length, page_no: 1, page_size: 20, models: rows.map((m) => ({ model: m, name: "显示名·" + m })) } } };
};

let UP = ""; // 假上游的根地址，起来以后填
const imgOk = (ns) => ({ json: { output: { choices: [{ message: { content: [{ image: `${UP}/img/${ns}.png` }] } }] } } });
const accept = (id) => ({ json: { output: { task_id: id, task_status: "PENDING" } } });

/**
 * 每个命名空间是一条渠道（地址 = UP/<ns>/api/v1），各自定同步 / 异步这一下怎么回。没写的：同步出图、异步收单。
 */
const NS = {
  s2a: { sync: SYNC_NO },                    // 千问型号走同步被拒 → 该换异步
  a2s: { async: ASYNC_NO },                  // 万相型号走异步被拒 → 该换同步
  both: { sync: SYNC_NO, async: ASYNC_NO },  // 两种都拒：只换一次，不来回打
  chosen: { sync: SYNC_NO },                 // 渠道上选定了同步：照选的报错，不换
  ref: { sync: SYNC_NO },                    // 带参考图：异步那条不收参考图，不换
  e500: { sync: { status: 500, json: { code: "InternalError", message: "fake upstream 500" } } },
  e400: { sync: URL_ERR },
  // 回包带着任务号就是收了单——哪怕状态码不是 2xx、话里说的是「不支持」，也不许再下一单
  took: { async: { status: 403, json: { ...ASYNC_NO.json, output: { task_id: "t-took" } } } },
};

/** 假上游收到的每一个请求：方法、路径、请求体里的 model */
const hits = [];
const hitsOf = (re, method) => hits.filter((h) => re.test(h.path) && (!method || h.method === method));

function route(method, p, body, q) {
  const seg = p.split("/").filter(Boolean);
  const ns = seg[0] || "";
  if (method === "GET" && ns === "img") return { buf: PNG, type: "image/png" };
  if (method === "GET" && ns === "aud") return { buf: AUDIO, type: "audio/wav" };
  if (ns === "deny") return DENY; // 这条渠道的 Key 没开任何型号：清单、对话一律 403
  if (method === "GET" && /\/models$/.test(p)) {
    // nolist：这条渠道不给模型清单
    if (ns === "nolist") return { status: 404, json: { code: "NotFound", message: "fake: no model list" } };
    if (/\/api\/v1\/models$/.test(p)) return nativeList(q);
    return { json: { data: [{ id: "qwen-image" }, { id: "qwen-plus" }] } };
  }
  if (method === "POST" && /\/chat\/completions$/.test(p)) {
    if (/\/api\/v1\/chat\/completions$/.test(p)) return URL_ERR;
    if (mm.mediaCapOf((body || {}).model)) return { status: 400, json: { error: { message: `fake: ${(body || {}).model} is not a chat model` } } };
    return { json: { id: "c1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] } };
  }
  const plan = NS[ns] || {};
  if (method === "POST" && /\/services\/aigc\/multimodal-generation\/generation$/.test(p)) {
    // 同一个口子：配音的请求体是 input.text，生图是 input.messages
    if (body && body.input && body.input.text != null) return { json: { output: { audio: { url: `${UP}/aud/${ns}.wav` } } } };
    return plan.sync || imgOk(ns);
  }
  if (method === "POST" && /\/services\/aigc\/text2image\/image-synthesis$/.test(p)) return plan.async || accept(`t-${ns}`);
  if (method === "GET" && /\/tasks\/[^/]+$/.test(p)) {
    const id = seg[seg.length - 1];
    if (id === "t-fail") return { json: { output: { task_id: id, task_status: "FAILED", code: "FakeFailed", message: "fake failed" } } };
    return { json: { output: { task_id: id, task_status: "SUCCEEDED", results: [{ url: `${UP}/img/${ns}.png` }] } } };
  }
  if (method === "POST" && /\/images\/generations$/.test(p)) return { json: { data: [{ url: `${UP}/img/${ns}-oai.png` }] } };
  if (method === "POST" && /\/audio\/speech$/.test(p)) return { buf: AUDIO, type: "audio/mpeg" };
  if (method === "POST" && /\/contents\/generations\/tasks$/.test(p)) return { status: 400, json: { error: { code: "FakeRejected", message: "fake: video submit rejected on purpose" } } };
  return { status: 404, json: { error: "fake: no route " + p } };
}

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    hits.push({ method: req.method, path: p, query: u.search.slice(1), model: body && body.model, body });
    const r = route(req.method, p, body, u.searchParams);
    if (r.buf) { res.writeHead(r.status || 200, { "content-type": r.type }); res.end(r.buf); return; }
    res.writeHead(r.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(r.json || {}));
  });
});

/** 一条百炼渠道 + 一个默认生图模型，走真的 flatten / resolve，跟 tools 那边拿到的是同一份 */
function dsMedia(ns, model, extra) {
  const c = {
    providers: [{ id: ns, name: ns, kind: "dashscope", base_url: `${UP}/${ns}/api/v1`, api_key: "sk-fake-" + ns, ...(extra || {}) }],
    media_models: [{ id: ns + "-img", cap: "image", name: ns, provider: ns, model, default: true }],
  };
  c.media = mm.flatten(c.providers, c.media_models);
  return mm.resolve(c);
}

(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  UP = `http://127.0.0.1:${upstream.address().port}`;
  const saveDir = path.join(HOME, "ws");
  fs.mkdirSync(saveDir, { recursive: true });
  try {
    pureChecks();
    await testButtons();
    await imageWays(saveDir);
    await formAndCopy();
  } catch (e) {
    fail++;
    console.log("  ✗ 套件中途炸了：" + ((e && e.stack) || e));
  } finally {
    upstream.closeAllConnections();
    upstream.close();
  }
  console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})();

// ── 一、接口表和判断顺序（纯函数） ────────────────────────
function pureChecks() {
  section("【一】三路接口表、判断顺序：渠道上选的 > 模型条目的 protocol > 渠道类型 > 地址 > 默认");
  const ids = (cap) => mm.MEDIA_APIS[cap].map((f) => f.id).join(",");
  ok(ids("image") === "openai,dashscope-sync,dashscope-async" && ids("video") === mm.VIDEO_PROTOS.join(",") && ids("tts") === "openai,dashscope",
    "可选项只有已经接好的协议：生图三种、视频五家（跟 VIDEO_PROTOS 一字不差）、配音两种", [ids("image"), ids("video"), ids("tts")]);

  const of = (cap, c) => mm.mediaApiOf(cap, c);
  const ds = { kind: "dashscope", base_url: "https://dashscope.aliyuncs.com/api/v1" };
  let w = of("image", { ...ds, model: "qwen-image" });
  ok(w.api === "dashscope-sync" && w.from === "kind", "百炼渠道、千问生图、没手选：按类型走百炼同步", w);
  w = of("image", { ...ds, model: "wanx2.1-t2i-turbo" });
  ok(w.api === "dashscope-async" && w.from === "kind", "……万相老几代：按型号分到百炼异步", w);
  w = of("image", { ...ds, model: "qwen-image", image_api: "openai" });
  ok(w.api === "openai" && w.from === "channel", "★渠道上选了 OpenAI 兼容：盖过渠道类型★", w);
  w = of("image", { ...ds, model: "qwen-image", image_api: "sora-magic" });
  ok(w.api === "dashscope-sync" && w.from === "kind", "（反向对照）选了个不认识的值：当没选，照类型走", w);
  w = of("image", { kind: "newapi", base_url: "https://relay.example.com/v1", model: "qwen-image", protocol: "dashscope" });
  ok(w.api === "dashscope-sync" && w.from === "model", "中转、模型条目上写着 dashscope：按模型提示走百炼", w);
  w = of("image", { kind: "newapi", base_url: "https://relay.example.com/v1", model: "qwen-image", protocol: "dashscope", image_api: "dashscope-async" });
  ok(w.api === "dashscope-async" && w.from === "channel", "★中转也能选，渠道上选的盖过模型提示★", w);
  w = of("image", { kind: "newapi", base_url: "https://relay.example.com/v1", model: "qwen-image" });
  ok(w.api === "openai" && w.from === "default", "（反向对照）中转什么都没写：生图退到最通用的 OpenAI 兼容", w);
  w = of("video", { kind: "dashscope", base_url: "https://dashscope.aliyuncs.com/api/v1", protocol: "ark" });
  ok(w.api === "ark" && w.from === "model", "视频：模型提示排在渠道类型前面（渠道显式 > 模型提示 > 类型和地址）", w);
  w = of("video", { kind: "custom", base_url: "https://gw.mycorp.com/ark/api/v3" });
  ok(w.api === "ark" && w.from === "host", "视频：自建网关挂在 /ark 下照样按地址认出方舟", w);
  w = of("video", { kind: "newapi", base_url: "https://relay.example.com/v1" });
  ok(w.api === "" && w.from === "default", "视频：中转认不出就是空，不猜一家去发", w);
  w = of("tts", { ...ds, tts_api: "openai" });
  ok(w.api === "openai" && w.from === "channel" && MEDIA.ttsApiOf({ ...ds, tts_api: "openai" }) === "openai", "配音：百炼渠道选了 OpenAI 兼容就走 /audio/speech", w);
  ok(MEDIA.ttsApiOf(ds) === "dashscope" && MEDIA.ttsApiOf({ kind: "newapi", base_url: "https://relay.example.com/v1", tts_api: "dashscope" }) === "dashscope",
    "（反向对照）没选按类型走千问 TTS；中转选了千问 TTS 就走千问");

  section("渠道上收哪几个字段：对话专用 / 只判断的渠道一个不收，认不出的值不收");
  const pick3 = { image_api: "openai", video_api: "ark", tts_api: "dashscope" };
  ok(JSON.stringify(mm.mediaApisOf({ kind: "newapi", ...pick3 })) === JSON.stringify(pick3), "中转渠道：三个都收", mm.mediaApisOf({ kind: "newapi", ...pick3 }));
  ok(JSON.stringify(mm.mediaApisOf({ kind: "deepseek", ...pick3 })) === "{}" && JSON.stringify(mm.mediaApisOf({ kind: "typesafe", ...pick3 })) === "{}",
    "★对话专用（DeepSeek）、只判断（Jev）的渠道：一个都不收★");
  ok(JSON.stringify(mm.mediaApisOf({ kind: "openai", image_api: "OPENAI", video_api: "sora", tts_api: "" })) === "{}", "大小写不对、不在表里、空串：都不收");

  const prov = [{ id: "r", kind: "newapi", base_url: "https://relay.example.com/v1", api_key: "k", ...pick3 }, { id: "d", kind: "dashscope", base_url: "https://dashscope.aliyuncs.com/api/v1", api_key: "k" }];
  const rows = [{ id: "i1", cap: "image", name: "i1", provider: "r", model: "qwen-image", default: true }, { id: "i2", cap: "image", name: "i2", provider: "d", model: "qwen-image" }];
  const flat = mm.flatten(prov, rows);
  const list = mm.resolve({ providers: prov, media_models: rows, media: flat }).list;
  ok(flat.image.image_api === "openai" && list[0].image_api === "openai", "压平和解析出来的配置带着渠道上选的那一种", { flat: flat.image, row: list[0] });
  ok(!["image_api", "video_api", "tts_api"].some((k) => k in list[1]), "（反向对照）没选的渠道：配置里一个字段都不多（老配置压平出来逐字节不变）", list[1]);
}

// ── 二、真起 server.js：保存读回 + 两颗「测」 ─────────────
async function testButtons() {
  section("【二】真起一份 server.js：三个下拉存进渠道、读得回来；两颗「测」只拿对话型号发对话");
  const H = path.join(HOME, "srv");
  fs.mkdirSync(H, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, OPENWORKBUDDY_HOME: H, OPENWORKBUDDY_DATA_DIR: path.join(H, "data"), HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  try {
    const port = await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        const m = /已启动: http:\/\/localhost:(\d+)/.exec(log);
        if (m || child.exitCode !== null || Date.now() - t0 > 60000) { clearInterval(tick); resolve(m ? Number(m[1]) : 0); }
      }, 200);
    });
    ok(port > 0, "server.js 起来了", { exit: child.exitCode, log: log.slice(-400) });
    if (!port) return;
    const req = (method, p, body, cookie) => new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
        ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
        ...(cookie ? { cookie } : {}),
      } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c));
        res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, j: j || {}, setCookie: res.headers["set-cookie"] }); });
      });
      r.on("error", (e) => resolve({ status: 0, body: String(e.message), j: {} }));
      if (data) r.write(data);
      r.end();
    });
    const reg = await req("POST", "/api/auth/register", { username: "admin", password: "Str0ngPass!2345" });
    const cookie = (reg.setCookie || []).map((c) => c.split(";")[0]).join("; ");
    const B = (ns, tail) => `${UP}/${ns}${tail}`;
    // 跟设置页 saveAllModelTables 发的同一个形状：三张表一起整表存
    const providers = [
      { id: "bl", name: "百炼", kind: "dashscope", base_url: B("bl", "/api/v1"), api_key: "sk-fake-bl", image_api: "", video_api: "", tts_api: "" },
      { id: "relay", name: "中转", kind: "newapi", base_url: B("relay", "/v1"), api_key: "sk-fake-relay", image_api: "dashscope-sync", video_api: "ark", tts_api: "dashscope" },
      { id: "ds", name: "深度求索", kind: "deepseek", base_url: B("ds", "/v1"), api_key: "sk-fake-ds", image_api: "openai", video_api: "ark", tts_api: "openai" },
      { id: "odd", name: "乱填", kind: "openai", base_url: B("odd", "/v1"), api_key: "sk-fake-odd", image_api: "sora-magic", video_api: "DASHSCOPE", tts_api: "dashscope" },
      { id: "bl2", name: "百炼二", kind: "dashscope", base_url: B("bl2", "/api/v1"), api_key: "sk-fake-bl2" },
      { id: "nolist", name: "百炼三", kind: "dashscope", base_url: B("nolist", "/api/v1"), api_key: "sk-fake-nolist" },
      { id: "deny", name: "百炼四", kind: "dashscope", base_url: B("deny", "/api/v1"), api_key: "sk-fake-deny" },
    ];
    const models = [
      { name: "千问生图（挂在对话里）", model: "qwen-image", channel: "bl" },
      { name: "千问 Plus", model: "qwen-plus", channel: "bl" },
      { name: "二号生图", model: "qwen-image", channel: "bl2" },
      { name: "三号生图", model: "qwen-image", channel: "nolist" },
      { name: "四号对话", model: "qwen-plus", channel: "deny" },
      { name: "四号生图", model: "qwen-image", channel: "deny" },
    ];
    const media_models = [
      { cap: "image", name: "中转千问", provider: "relay", model: "qwen-image", default: true },
      { cap: "video", name: "中转方舟", provider: "relay", model: "doubao-seedance-1-0-pro-250528", default: true },
      { cap: "tts", name: "中转配音", provider: "relay", model: "qwen-tts", voice: "Cherry", default: true },
    ];
    const s1 = await req("POST", "/api/settings", { providers, models, media_models }, cookie);
    ok(s1.status === 200, "存得下（渠道带着三个下拉的值）", { status: s1.status, body: s1.body.slice(0, 300) });
    const disk = () => { try { return JSON.parse(fs.readFileSync(path.join(H, "config.json"), "utf8")); } catch { return {}; } };
    const onDisk = (id) => ((disk().providers || []).find((p) => p.id === id) || {});
    const got = await req("GET", "/api/settings", null, cookie);
    const back = (id) => ((got.j.providers || []).find((p) => p.id === id) || {});
    const three = (p) => [p.image_api, p.video_api, p.tts_api].join("|");
    ok(three(back("relay")) === "dashscope-sync|ark|dashscope" && three(onDisk("relay")) === "dashscope-sync|ark|dashscope",
      "★中转渠道选的三种：config.json 里有、读接口读得回★", { read: three(back("relay")), disk: three(onDisk("relay")) });
    ok(three(back("bl")) === "||" && !("image_api" in onDisk("bl")), "（反向对照）选「自动」：读回空串，盘上不出这个字段", { read: three(back("bl")), disk: onDisk("bl") });
    ok(three(back("ds")) === "||" && !("image_api" in onDisk("ds")) && !("tts_api" in onDisk("ds")), "★对话专用的 DeepSeek 渠道：传了也不落盘★", onDisk("ds"));
    ok(three(back("odd")) === "||dashscope", "认不出的值（sora-magic、大写的 DASHSCOPE）不落盘，认得的照存", three(back("odd")));
    ok(!JSON.stringify(got.j.providers || []).includes("sk-fake-"), "读接口不回 Key 原文（只回掩码）");

    // 保存 → 读回 → 生成：拿盘上那份配置走真的 resolve，看出图 / 配音 / 视频各打到哪个口子
    const media = mm.resolve(disk());
    hits.length = 0;
    let r = await MEDIA.generateImage(media, { prompt: "一只猫", filename: "relay.png" }, 1000, path.join(HOME, "ws"));
    ok(!r.isError && hitsOf(/^\/relay\/v1\/services\/aigc\/multimodal-generation\/generation$/, "POST").length === 1 && !hitsOf(/images\/generations/).length,
      "★中转选了「百炼同步」：出图打的是百炼同步的口子★", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });
    ok(/这次走的是百炼同步接口/.test(r.content || ""), "……回执写明走的是同步", r.content);
    hits.length = 0;
    r = await MEDIA.textToSpeech(media, { text: "你好", filename: "relay-voice" }, 1000, path.join(HOME, "ws"));
    ok(!r.isError && hitsOf(/^\/relay\/v1\/services\/aigc\/multimodal-generation\/generation$/, "POST").length === 1 && !hitsOf(/audio\/speech/).length && /\.wav/.test(r.content || ""),
      "★中转选了「千问 TTS」：配音打千问的口子，落 wav★", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });
    hits.length = 0;
    r = await MEDIA.generateVideo(media, { prompt: "一只猫跑过草地", filename: "relay.mp4" }, { saveDir: path.join(HOME, "ws") });
    ok(hitsOf(/^\/relay\/v1\/contents\/generations\/tasks$/, "POST").length === 1 && /视频接口错误 400/.test(r.content || ""),
      "★中转选了「火山方舟」：视频打方舟的口子（假上游回 400，照实报状态码和原文）★", { content: (r.content || "").slice(0, 200), hits: hits.map((h) => h.method + " " + h.path) });

    // 改回「自动」再存一次：盘上字段没了，生成跟着回到按类型和地址认
    const s2 = await req("POST", "/api/settings", { providers: providers.map((p) => (p.id === "relay" ? { ...p, image_api: "", video_api: "", tts_api: "" } : p)), models, media_models }, cookie);
    ok(s2.status === 200 && !("image_api" in onDisk("relay")) && !("video_api" in onDisk("relay")), "改回「自动」再存：盘上这三个字段跟着没了", onDisk("relay"));
    const auto = mm.resolve(disk());
    hits.length = 0;
    r = await MEDIA.generateImage(auto, { prompt: "一只猫", filename: "relay-auto.png" }, 1000, path.join(HOME, "ws"));
    ok(!r.isError && hitsOf(/^\/relay\/v1\/images\/generations$/, "POST").length === 1 && !hitsOf(/multimodal-generation/).length,
      "（反向对照）中转没选：出图退回 OpenAI 兼容 /images/generations", hits.map((h) => h.method + " " + h.path));
    hits.length = 0;
    r = await MEDIA.textToSpeech(auto, { text: "你好", filename: "relay-voice-auto" }, 1000, path.join(HOME, "ws"));
    ok(!r.isError && hitsOf(/^\/relay\/v1\/audio\/speech$/, "POST").length === 1, "（反向对照）中转没选：配音走 /audio/speech", hits.map((h) => h.method + " " + h.path));
    hits.length = 0;
    r = await MEDIA.generateVideo(auto, { prompt: "一只猫跑过草地", filename: "relay-auto.mp4" }, { saveDir: path.join(HOME, "ws") });
    ok(r.isError && !hits.length && /视频接口/.test(r.content || ""), "（反向对照）中转没选视频接口：认不出就不发，话里指到「视频接口」那一栏", { content: (r.content || "").slice(0, 200), hits: hits.length });

    section("渠道「测一下」/ 每一行的「测」：生图型号不拿来发对话");
    const ptest = (body) => req("POST", "/api/provider-test", body, cookie);
    const chatPosts = () => hitsOf(/\/chat\/completions$/, "POST");
    hits.length = 0;
    let t = await ptest({ id: "bl", kind: "dashscope", base_url: B("bl", "/api/v1"), api_key: "" });
    ok(t.j.ok === true && t.j.model === "qwen-plus", "★百炼渠道、对话列表第一行是 qwen-image：测的是 qwen-plus★", t.j);
    ok(chatPosts().length === 1 && chatPosts()[0].path === "/bl/compatible-mode/v1/chat/completions",
      "★对话测活打 /compatible-mode/v1（跟真跑同一个地址），不是 /api/v1★", chatPosts().map((h) => h.path));
    ok(!hits.some((h) => h.method === "POST" && h.model === "qwen-image"), "★qwen-image 一次都没拿去发对话★", hits.map((h) => `${h.method} ${h.path} ${h.model || ""}`));

    hits.length = 0;
    t = await ptest({ id: "bl", kind: "dashscope", base_url: B("bl", "/api/v1"), api_key: "", model: "qwen-image" });
    ok(t.j.ok === true && t.j.partial === true && /^「qwen-image」看名字是图像模型，没拿它发对话请求。/.test(t.j.note || ""),
      "点名测 qwen-image：改走清单测活、只给半格，话里说清没发对话", t.j);
    ok(!chatPosts().length && hitsOf(/^\/bl\/api\/v1\/models$/, "GET").length === 1, "……只 GET 了一次 /api/v1/models，没发 POST", hits.map((h) => h.method + " " + h.path));
    // 百炼原生清单分页，qwen-image 不在第一页：不按型号查就会翻不到，把好好的渠道判成「没有这个模型」
    ok((hitsOf(/^\/bl\/api\/v1\/models$/, "GET")[0] || {}).query === "model=qwen-image" && /查到了「qwen-image」/.test(t.j.note || ""),
      "★百炼原生清单：带 model 参数按型号查，认 output.models[].model，查到了就照实说★", { q: (hitsOf(/\/models$/, "GET")[0] || {}).query, note: t.j.note });
    hits.length = 0;
    t = await ptest({ id: "relay", kind: "newapi", base_url: B("relay", "/v1"), api_key: "" });
    ok(t.j.ok === true && (hitsOf(/^\/relay\/v1\/models$/, "GET")[0] || {}).query === "" && /在这条渠道的清单里（一共 2 个）/.test(t.j.note || ""),
      "（反向对照）中转地址：不加 model 参数，照 data[].id 认", { j: t.j, hits: hits.map((h) => `${h.method} ${h.path}?${h.query}`) });

    // 403 不替人下结论：百炼的 Model.AccessDenied 是「这个工作空间没开这个型号」，Key 本身是好的
    hits.length = 0;
    t = await ptest({ id: "deny", kind: "dashscope", base_url: B("deny", "/api/v1"), api_key: "" });
    ok(t.j.ok === false && /HTTP 403/.test(t.j.error || "") && /上游原文：.*Model access denied\./.test(t.j.error || "") && !/上游不认/.test(t.j.error || ""),
      "★对话测活撞 403：报状态码和上游原文，不说「Key 上游不认」★", { j: t.j, hits: hits.map((h) => h.method + " " + h.path) });
    hits.length = 0;
    t = await ptest({ id: "deny", kind: "dashscope", base_url: B("deny", "/api/v1"), api_key: "", model: "qwen-image" });
    ok(t.j.ok === false && /HTTP 403/.test(t.j.error || "") && /上游原文：.*Model access denied\./.test(t.j.error || "") && !/上游不认/.test(t.j.error || "") && !chatPosts().length,
      "★生图型号清单测活撞 403：同样只报状态码和原文★", { j: t.j, hits: hits.map((h) => h.method + " " + h.path) });

    hits.length = 0;
    t = await ptest({ id: "bl2", kind: "dashscope", base_url: B("bl2", "/api/v1"), api_key: "" });
    ok(t.j.ok === true && t.j.partial === true && t.j.model === "qwen-image" && /没拿它发对话请求/.test(t.j.note || "") && !chatPosts().length,
      "★对话列表里只有 qwen-image 的渠道：清单测活，不发对话★", { j: t.j, hits: hits.map((h) => h.method + " " + h.path) });

    hits.length = 0;
    t = await ptest({ id: "nolist", kind: "dashscope", base_url: B("nolist", "/api/v1"), api_key: "" });
    ok(t.j.ok === true && t.j.partial === true && /不给模型清单（HTTP 404）/.test(t.j.note || "") && /得真生成一次才知道/.test(t.j.note || ""),
      "拿不到清单：照实说 HTTP 404、只验到地址通，不编绿勾", t.j);
    ok(!hits.some((h) => h.method === "POST"), "★拿不到清单也不真生成：一个 POST 都没有★", hits.map((h) => h.method + " " + h.path));

    const rows = (await req("GET", "/api/settings", null, cookie)).j.models || [];
    const at = (name) => rows.findIndex((m) => m.name === name);
    hits.length = 0;
    t = await req("POST", "/api/model-test", { scope: "chat", index: at("千问生图（挂在对话里）") }, cookie);
    ok(t.j.partial === true && /^「qwen-image」看名字是图像模型，没拿它发对话请求。/.test(t.j.note || t.j.error || "") && !chatPosts().length,
      "★对话行上的 qwen-image 点「测」：不发对话，走清单、只给半格★", { j: t.j, hits: hits.map((h) => h.method + " " + h.path) });
    hits.length = 0;
    t = await req("POST", "/api/model-test", { scope: "chat", index: at("千问 Plus") }, cookie);
    ok(t.j.ok === true && chatPosts().length === 1 && chatPosts()[0].path === "/bl/compatible-mode/v1/chat/completions" && chatPosts()[0].model === "qwen-plus",
      "（反向对照）对话行上的 qwen-plus：照常真发一次对话，地址同样是 /compatible-mode/v1", { j: t.j, hits: hits.map((h) => h.method + " " + h.path) });
  } finally { child.kill("SIGKILL"); }
}

// ── 三、生图同步 / 异步：明说拒了才换一次，换成了记住 ─────────
async function imageWays(saveDir) {
  section("【三】生图同步 / 异步：上游明说「不支持这种调用方式」才换一次；收了单、5xx、选定了一律不换");
  const W = MEDIA.wrongWayOf;
  ok(W(403, SYNC_NO.json) === "dashscope-async" && W(403, ASYNC_NO.json) === "dashscope-sync", "错误码表那两句原文：认得出该换哪一种");
  ok(W(500, { code: "AccessDenied", message: SYNC_NO.json.message }) === "" && W(403, { code: "AccessDenied.Unpurchased", message: "x" }) === ""
    && W(400, URL_ERR.json) === "" && W(403, { ...ASYNC_NO.json, output: { task_id: "t1" } }) === "",
    "（反向对照）状态码不对、别的 AccessDenied、url error、带着任务号：都不换");
  MEDIA.imageWays.clear();
  const posts = (ns, kind) => hitsOf(new RegExp(`^/${ns}/api/v1/services/aigc/${kind === "sync" ? "multimodal-generation/generation" : "text2image/image-synthesis"}$`), "POST").length;
  const gen = (m, extra) => MEDIA.generateImage(m, { prompt: "一只猫", ...(extra || {}) }, 1000, saveDir, (rel) => path.join(saveDir, rel));

  hits.length = 0;
  let r = await gen(dsMedia("s2a", "qwen-image"), { filename: "s2a.png" });
  ok(!r.isError && posts("s2a", "sync") === 1 && posts("s2a", "async") === 1 && MEDIA.imageWays.get("s2a\nqwen-image") === "dashscope-async",
    "★同步被拒（403 不支持同步）：自动改走异步，同步异步各提交一次，记下「渠道 + 型号 → 异步」★",
    { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });
  ok(/百炼同步提交被上游拒了（HTTP 403 AccessDenied：current user api does not support synchronous calls\.），没收单；已自动改走百炼异步重新提交一次/.test(r.content || "")
    && /这次走的是百炼异步接口/.test(r.content || ""), "……回执写清：被拒的原文、换成了异步、这次走的是异步", r.content);
  hits.length = 0;
  r = await gen(dsMedia("s2a", "qwen-image"), { filename: "s2a-2.png" });
  ok(!r.isError && posts("s2a", "sync") === 0 && posts("s2a", "async") === 1 && /先前试出来这个型号要这么走/.test(r.content || ""),
    "★同一渠道同一型号再出一张：直接走异步，不再先挨一次拒★", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });
  hits.length = 0;
  r = await gen(dsMedia("oksync", "qwen-image"), { filename: "oksync.png" });
  ok(!r.isError && posts("oksync", "sync") === 1 && posts("oksync", "async") === 0 && /这次走的是百炼同步接口（multimodal-generation）/.test(r.content || "")
    && !/改走|先前试出来/.test(r.content || ""), "（反向对照）换一条渠道、同一个型号：不套别家试出来的，照常同步、回执说同步", r.content);

  hits.length = 0;
  r = await gen(dsMedia("a2s", "wanx2.1-t2i-turbo"), { filename: "a2s.png" });
  ok(!r.isError && posts("a2s", "async") === 1 && posts("a2s", "sync") === 1 && /已自动改走百炼同步/.test(r.content || ""),
    "★反过来：万相走异步被拒（不支持异步）→ 改走同步一次★", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });

  hits.length = 0;
  r = await gen(dsMedia("both", "qwen-image"), { filename: "both.png" });
  ok(r.isError && posts("both", "sync") === 1 && posts("both", "async") === 1 && /也没收单/.test(r.content || "") && !MEDIA.imageWays.has("both\nqwen-image"),
    "★两种都被拒：只换一次、不来回打，换了也被拒就不记★", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });

  hits.length = 0;
  r = await gen(dsMedia("chosen", "qwen-image", { image_api: "dashscope-sync" }), { filename: "chosen.png" });
  ok(r.isError && posts("chosen", "sync") === 1 && posts("chosen", "async") === 0 && /渠道上选定了「百炼同步」，照选的走，没有自动改走另一种/.test(r.content || "")
    && !MEDIA.imageWays.has("chosen\nqwen-image"), "★渠道上选定了同步：被拒照实报，不自动换、不记★", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });

  fs.writeFileSync(path.join(saveDir, "ref.png"), PNG);
  hits.length = 0;
  r = await gen(dsMedia("ref", "qwen-image-edit"), { filename: "ref-out.png", reference_images: ["ref.png"] });
  ok(r.isError && posts("ref", "sync") === 1 && posts("ref", "async") === 0 && /异步那条不收参考图，所以没有改走异步/.test(r.content || ""),
    "带参考图被拒同步：异步那条不收参考图，不换（换了等于悄悄丢图）", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });

  hits.length = 0;
  r = await gen(dsMedia("e400", "qwen-image"), { filename: "e400.png" });
  ok(r.isError && posts("e400", "async") === 0 && /图像接口错误 400/.test(r.content || "") && /url error, please check url!/.test(r.content || "") && !/改走/.test(r.content || ""),
    "400 url error：不换，报状态码和上游原文", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });
  hits.length = 0;
  r = await gen(dsMedia("e500", "qwen-image"), { filename: "e500.png" });
  ok(r.isError && posts("e500", "async") === 0 && /图像接口错误 500/.test(r.content || "") && !/改走/.test(r.content || ""),
    "★5xx：不换另一种（同步那路原有的退避重试照旧）★", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });

  hits.length = 0;
  r = await gen(dsMedia("took", "wanx2.1-t2i-turbo"), { filename: "took.png" });
  ok(r.isError && posts("took", "async") === 1 && posts("took", "sync") === 0, "★回包带着任务号（收了单）：哪怕说「不支持」也不再下一单★",
    { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });
  hits.length = 0;
  r = await gen(dsMedia("fail", "wanx2.1-t2i-turbo"), { filename: "fail.png" });
  ok(r.isError && posts("fail", "async") === 1 && posts("fail", "sync") === 0 && /图像任务失败/.test(r.content || ""),
    "收了单、上游跑完说 FAILED：不换同步重下", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });

  hits.length = 0;
  r = await gen(dsMedia("oai", "qwen-image", { image_api: "openai" }), { filename: "oai.png" });
  ok(!r.isError && hitsOf(/^\/oai\/api\/v1\/images\/generations$/, "POST").length === 1 && posts("oai", "sync") === 0 && /这次走的是OpenAI 兼容接口/.test(r.content || ""),
    "★百炼渠道上选了 OpenAI 兼容：出图打 /images/generations★", { content: r.content, hits: hits.map((h) => h.method + " " + h.path) });
  MEDIA.imageWays.clear();
}

// ── 四、表单与文案 ──────────────────────────────────────
async function formAndCopy() {
  section("【四】表单：「自动」那一项说的走法跟服务端同一套；对话专用渠道藏起来；保存带上三个值");
  const app05 = fs.readFileSync(path.join(ROOT, "public", "js", "app-05.js"), "utf8");
  const head = app05.indexOf("function mmAutoApi(");
  ok(head >= 0, "app-05.js 里有 mmAutoApi");
  let i = app05.indexOf("{", head), d = 0, end = -1;
  for (; i < app05.length; i++) {
    if (app05[i] === "{") d++;
    else if (app05[i] === "}") { d--; if (d === 0) { end = i + 1; break; } }
  }
  const src = app05.slice(head, end);
  ok(end > head && /return f \? f\.short/.test(src), "抠出来的是整个函数（花括号配平）");
  const auto = new Function("mediaCatalog", `${src}\nreturn mmAutoApi;`)(mm.clientCatalog());
  const bases = ["", "https://dashscope.aliyuncs.com/api/v1", "https://ws1.cn-beijing.maas.aliyuncs.com/api/v1", "https://ark.cn-beijing.volces.com/api/v3",
    "https://gw.mycorp.com/ark/api/v3", "https://open.bigmodel.cn/api/paas/v4", "https://api.minimaxi.com/v1", "https://api.siliconflow.cn/v1", "https://relay.example.com/v1"];
  const kinds = mm.PROVIDER_KINDS.filter((k) => !k.chat_only && !k.decide_only).map((k) => k.kind);
  const bad = [];
  for (const cap of ["image", "video", "tts"]) for (const kind of kinds) for (const base of bases) {
    const w = mm.mediaApiOf(cap, { kind, base_url: base, model: "" });
    const want = cap === "image" && (w.from === "kind" || w.from === "host") && /^dashscope/.test(w.api) ? "百炼，按型号分同步/异步"
      : (mm.MEDIA_APIS[cap].find((f) => f.id === w.api) || {}).short || "认不出，要选一个";
    const saw = auto(cap, kind, base);
    if (saw !== want) bad.push({ cap, kind, base, saw, want });
  }
  ok(!bad.length, `★「自动（…）」跟服务端 mediaApiOf 逐格对得上（${3 * kinds.length * bases.length} 格）★`, bad.slice(0, 4));
  ok(auto("video", "newapi", "https://relay.example.com/v1") === "认不出，要选一个" && auto("image", "newapi", "https://relay.example.com/v1") === "OpenAI 兼容",
    "中转：视频说「认不出，要选一个」，生图说 OpenAI 兼容");

  ok(/<div id="pf-media-apis">\$\{\["image", "video", "tts"\]\.map\(\(cap\) => `[\s\S]{0,80}<select id="pf-\$\{cap\}-api"/.test(app05), "渠道表单上有三个下拉（生图 / 视频 / 配音）");
  ok(/style\.display = row\.chat_only \|\| row\.decide_only \? "none" : ""/.test(app05), "对话专用 / 只判断的渠道：三个下拉整组藏起来");
  ok(/apis\[cap \+ "_api"\] = mediaOn \? v\(`pf-\$\{cap\}-api`\) : ""/.test(app05) && /api: v\("pf-api"\), \.\.\.apis,/.test(app05), "点保存：三个值跟着渠道一起存（藏着时存空 = 自动）");
  ok(/\.value = \(p && p\[cap \+ "_api"\]\) \|\| ""/.test(app05), "编辑已有渠道：下拉回填存着的值");
  ok(/chanTest\.set\(id, \{[^}]*partial: !!d\.partial, note: d\.note \|\| ""/.test(app05) && /if \(t\.ok && t\.partial\) return `<span class="ch-pill is-half"/.test(app05),
    "渠道「测一下」只验了一半：卡上显示半格，不说「真发了一次请求」");
  const css = fs.readFileSync(path.join(ROOT, "public", "css", "ui.css"), "utf8");
  ok(/\.ch-pill\.is-half\s*\{/.test(css), "半格有自己的样式");

  section("文案：新加的字都有英文，没有拿中文原样顶上的");
  const zh = [];
  for (const cap of ["image", "video", "tts"]) for (const f of mm.MEDIA_APIS[cap]) zh.push(f.label, f.short);
  for (const [, cn] of Object.entries({ image: "生图接口", video: "视频接口", tts: "配音接口" })) zh.push(`${cn}：自动`);
  zh.push("这条渠道出图走哪种接口", "这条渠道出视频走哪种接口", "这条渠道配音走哪种接口", "百炼，按型号分同步/异步", "认不出，要选一个", "只验了一半");
  for (const m of app05.matchAll(/hint: "([^"]*「(?:生图|视频|配音)接口」[^"]*)"/g)) zh.push(m[1]);
  const missing = [...new Set(zh)].filter((s) => { const en = I18N.lookup(s, "en"); return !en || en === s || /[一-鿿]/.test(en); });
  ok(zh.length >= 30 && !missing.length, `★${new Set(zh).size} 条新字都有英文★`, missing);
  const pat = I18N.lookup("生图接口：自动（百炼，按型号分同步/异步）", "en");
  ok(pat === "Image API: auto (Model Studio, sync or async by model)", "「X接口：自动（…）」整句翻得出来（括号里那段也翻）", pat);
  ok(I18N.lookup("视频接口：自动（没见过的词）", "en") == null, "（反向对照）括号里是没翻过的词：整句不硬翻，免得半中半英");
}
