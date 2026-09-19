"use strict";
/**
 * API 中转站：对外说 OpenAI 的话，对内按渠道分发、按虚拟 Key 计费限额。
 *
 * 一句话说清它是什么：业务方把 `base_url` 指到这台机器的 `/v1`、`api_key` 填一把
 * 我们发的虚拟 Key，剩下的代码一个字不用改——他那边用的还是 openai 官方 SDK。
 * 而这边拿到的是：谁在调、调了什么型号、花了多少钱、超没超额度、上游哪条渠道挂了。
 *
 * ── 三条边界，先说清楚不做什么 ──────────────────────────────────────
 *
 * 1) **只转 OpenAI 兼容协议。** Anthropic 官方那套协议（渠道 kind=anthropic）不在这条路上。
 *    把 OpenAI 的请求体翻成 Anthropic 的再把响应翻回来，是一个会持续追着两边发版跑的活儿，
 *    而且翻错了不报错、只是行为变了（tool_choice、response_format、n、logprobs 各有各的坑）。
 *    宁可这条路上明说「这条渠道不走中转」，也不要给一个七成像的东西。
 *    想用 Claude 的，走 OpenRouter 或者任何 OpenAI 兼容的网关，那是一条渠道的事。
 *
 * 2) **请求体原样转发。** 除了必须动的两处（见下面 prepBody），客户端发什么就转什么。
 *    中转站最容易犯的错是"顺手规整一下参数"——今天多删一个不认识的字段，
 *    明天上游新出的功能就在这儿被悄悄吃掉，而用的人只会觉得"这个网关怪怪的"。
 *
 * 3) **流式必须真流。** 上游一个字节出来就往下游写一个字节，不缓冲、不重组。
 *    中间只做一件事：顺手把最后那条带 usage 的 chunk 抄一份下来记账。
 *
 * ── 计费与额度在这条路上怎么串 ──────────────────────────────────────
 *
 *     verify(虚拟 Key) → 选渠道 → budget.reserve(预扣) → 转发 → 读 usage
 *                                                        → budget.settle(实扣) → 记流水
 *
 *   预扣在**转发之前**：并发打进来的请求看到的余额已经扣过了，不会五十条一起穿过去
 *   （budget.js 开头那段写了为什么非这样不可）。
 *   转发失败（渠道挂了、参数错了）走 release，额度原样还回去——
 *   一次没发出去的调用扣掉额度，是那种月底才会被发现、且永远说不清的错。
 */

const crypto = require("crypto");
const pricing = require("./pricing");
const budget = require("./budget");
const vkeys = require("./vkeys");
const log = require("./log");
const { cleanKey } = require("./llm");

/** 上游多久没有第一个字节就换下一条渠道。流式回答本身可以跑一小时，卡的是**握手** */
const CONNECT_TIMEOUT_MS = 30000;
/** 整趟最长多久。跟 nginx 那份模板里的 proxy_read_timeout 对齐，两边不一致最难查 */
const TOTAL_TIMEOUT_MS = 3600 * 1000;
/** 一趟最多换几条渠道。不设上限的话，一个全挂的账号会把每个请求拖成 N × 30 秒 */
const MAX_TRIES = 3;

/**
 * 哪些上游错误值得换一条渠道再试。
 *
 * 只认「这条路不通」，不认「你说的话不对」：4xx 里除了 429（限流）和 402（欠费）之外
 * 一律不重试——参数写错了换一条渠道还是错，只是把同一个错误乘以三份账单。
 * 401 尤其不能重试：那是我们自己的 Key 配错了，换渠道等于拿另一把 Key 再试一次，
 * 属于在拿别人的额度掩盖自己的配置问题。
 */
function worthRetry(status) {
  return !status || status === 429 || status === 402 || status >= 500;
}

/**
 * 挑渠道：能跑这个型号的、启用着的，按 priority 从小到大，同级按权重随机。
 *
 * "能跑这个型号"三种写法，从严到松：
 *   ① 渠道自己写了 models 白名单（支持尾部 *）——最准，也最要手动维护
 *   ② config.models 里有条目挂在这条渠道上、且 model 字段对得上——大多数人的实际情况
 *   ③ 渠道什么都没写 —— 当成"什么都能跑"的自建网关（new-api / one-api / OpenRouter 就是这样）
 *
 * 为什么③默认放行而不是默认拒绝：这个产品的绝大多数用户只有一条渠道，
 * 要求他先去登记型号清单才能用，等于给一个人的场景加一道企业流程。
 * 而登记了清单的人，得到的是真正的路由能力。
 */
function pickChannels(config, model) {
  const providers = (config.providers || []).filter((p) => p && p.id);
  const byChannel = new Map();
  for (const m of config.models || []) {
    if (!m || !m.channel) continue;
    if (!byChannel.has(m.channel)) byChannel.set(m.channel, []);
    byChannel.get(m.channel).push(String(m.model || m.name || ""));
  }
  const want = String(model || "").toLowerCase();
  const out = [];
  for (const p of providers) {
    if (p.enabled === false) continue;
    if ((p.kind || "") === "anthropic") continue;         // 见文件头第 1 条
    if (!String(p.base_url || "").trim()) continue;        // 没地址就不是一条能转发的渠道
    let ok, why;
    if (Array.isArray(p.models) && p.models.length) {
      ok = vkeys._internals.modelAllowed(p.models, want); why = "白名单";
    } else if (byChannel.has(p.id)) {
      ok = byChannel.get(p.id).some((x) => String(x).toLowerCase() === want); why = "已登记的模型";
    } else {
      ok = true; why = "未登记型号，当作通用网关";
    }
    if (ok) out.push({ p, why, priority: num(p.priority, 100), weight: Math.max(1, num(p.weight, 1)) });
  }
  out.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  // 同一优先级内按权重洗牌，让两条平级渠道真的分得开流量
  const groups = new Map();
  for (const c of out) { if (!groups.has(c.priority)) groups.set(c.priority, []); groups.get(c.priority).push(c); }
  const ordered = [];
  for (const g of [...groups.keys()].sort((a, b) => a - b)) ordered.push(...weightedShuffle(groups.get(g)));
  return ordered;
}

function num(x, dflt) { const n = typeof x === "string" ? parseFloat(x) : x; return Number.isFinite(n) ? n : dflt; }

/** 按权重抽样排序：权重 3 的被排在前面的概率是权重 1 的三倍 */
function weightedShuffle(list) {
  const pool = list.slice(), out = [];
  while (pool.length) {
    let total = pool.reduce((s, c) => s + c.weight, 0), r = Math.random() * total, i = 0;
    while (i < pool.length - 1 && (r -= pool[i].weight) > 0) i++;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/**
 * 请求体只动两处，别的一个字节不碰：
 *
 *   ① 流式时补上 stream_options.include_usage —— 不补的话，OpenAI 兼容的流式响应
 *      **根本不带 usage**，于是所有流式调用在账上都是 0 元。这是中转站漏账最大的一个口子，
 *      而且漏得悄无声息：非流式的账对得上，流式的全是 0，看汇总只觉得"最近用得少"。
 *      客户端自己写了 stream_options 的不覆盖——他可能有别的打算。
 *   ② model 换成这条渠道认的名字（渠道上配了 model_map 时）。
 *      同一个型号在各家叫法不一样（deepseek-chat / deepseek/deepseek-chat / DeepSeek-V3），
 *      映射写在渠道上，客户端那边永远只写一个名字。
 */
function prepBody(body, provider) {
  const b = { ...body };
  if (b.stream && !b.stream_options) b.stream_options = { include_usage: true };
  const map = (provider && provider.model_map) || null;
  if (map && map[b.model]) b.model = map[b.model];
  return b;
}

/** 从一条非流式响应里把 usage 抠出来，统一成账本那套字段名 */
function usageOf(json, model) {
  const u = (json && json.usage) || {};
  const details = u.prompt_tokens_details || u.input_tokens_details || {};
  return {
    model: (json && json.model) || model,
    prompt: +u.prompt_tokens || +u.input_tokens || 0,
    cached: +details.cached_tokens || +u.cache_read_input_tokens || 0,
    completion: +u.completion_tokens || +u.output_tokens || 0,
  };
}

/**
 * 转发一趟。返回 { res, provider, tries } 或者抛错。
 * res 是 undici/node 的 fetch Response，body 还没读——流式那条路要原样往下写。
 *
 * `path` 是上游的接口路径，默认 /chat/completions。分出这个参数是为了
 * /v1/embeddings：选渠道、重试、超时、model_map 那一整套逻辑两边逐字一样，
 * 差的只是 URL 尾巴。拄成两份的话，以后改重试策略必定只改得动其中一份。
 */
async function forward({ config, model, body, headers, signal, path = "/chat/completions" }) {
  const cands = pickChannels(config, model);
  if (!cands.length) {
    const e = new Error(`没有渠道能跑 ${model}。去「设置 → 模型」加一条 OpenAI 兼容的渠道，或者在渠道上登记这个型号。`);
    e.status = 503; throw e;
  }
  const tried = [];
  for (const c of cands.slice(0, MAX_TRIES)) {
    const p = c.p;
    const key = cleanKey(p.api_key || "", config) || "";
    const url = String(p.base_url).replace(/\/+$/, "") + path;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    // 连接超时和整趟超时是两回事：握手 30 秒不通就换渠道，但已经在吐字的流可以跑一小时。
    // 只设一个总超时的话，要么长任务被掐断，要么一条挂掉的渠道让每个请求都等一小时。
    const connectTimer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS);
    const totalTimer = setTimeout(() => ac.abort(), TOTAL_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          // 转发客户端的 user 字段方便上游做自己的风控，别的头一律不带——
          // 客户端的 cookie / 自定义头转上去等于把我们的用户凭据泄给上游
          ...(headers && headers["x-title"] ? { "x-title": headers["x-title"] } : {}),
        },
        body: JSON.stringify(prepBody(body, p)),
        signal: ac.signal,
      });
      clearTimeout(connectTimer);
      if (!res.ok && worthRetry(res.status)) {
        const text = await res.text().catch(() => "");
        tried.push({ channel: p.name || p.id, status: res.status, ms: Date.now() - t0, why: text.slice(0, 200) });
        clearTimeout(totalTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        continue;
      }
      return { res, provider: p, tried, cleanup: () => { clearTimeout(totalTimer); if (signal) signal.removeEventListener("abort", onAbort); } };
    } catch (err) {
      clearTimeout(connectTimer); clearTimeout(totalTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal && signal.aborted) throw err;          // 是客户端自己断的，不是渠道的错
      tried.push({ channel: p.name || p.id, status: 0, ms: Date.now() - t0, why: String(err.message || err).slice(0, 200) });
    }
  }
  // 全挂了才报错，而且把每条渠道各自怎么挂的都列出来——
  // 只说「上游错误」的话，有三条渠道的人根本无从下手
  const e = new Error(
    `${tried.length} 条渠道都没通：\n` +
    tried.map((t) => `  · ${t.channel}：${t.status || "连不上"}（${t.ms}ms）${t.why ? " " + t.why : ""}`).join("\n"));
  e.status = 502; e.tried = tried;
  throw e;
}

module.exports = {
  forward, pickChannels, prepBody, usageOf, worthRetry,
  CONNECT_TIMEOUT_MS, TOTAL_TIMEOUT_MS, MAX_TRIES,
  _internals: { weightedShuffle, num },
};

/**
 * 对外那两条路：`/v1/chat/completions` 和 `/v1/models`。
 *
 * 挂在 authGuard **之前**（server.js 里紧挨着 mountPublic 那一段），因为它的身份
 * 不是 cookie 而是 Authorization 头里的虚拟 Key。挂在后面的话，每个请求都会被
 * 「未登录」挡掉——而业务方的 SDK 根本没有 cookie 这个概念。
 *
 * 错误一律用 OpenAI 的形状 `{ error: { message, type, code } }`：
 * 客户端那边是 openai 官方 SDK，它按这个形状解错误。回一个我们自家的 {error:"..."}，
 * SDK 会把它变成一句没有信息量的 APIError，用的人只能去翻我们的日志。
 */
function createRouter(deps = {}) {
  const express = require("express");
  const fs = require("fs");
  const os = require("os");
  const nodePath = require("path");
  const usageStore = require("./usage-store");
  // 这几个放在函数里而不是文件头：tools.js 是整个仓库最重的一个模块，
  // 而 relay.js 的上半截（forward / pickChannels）被测试和别的地方单独引用。
  // 放文件头的话，只想算一下该走哪条渠道也要把它整个拉起来。
  const tools = require("./tools");
  const mediaModels = require("./media-models");
  const relayFiles = require("./relay-files");
  const router = express.Router();
  const getConfig = deps.config || (() => ({}));
  const getOrgSettings = deps.orgSettings || (() => ({}));
  const getUser = deps.user || (() => null);
  const clientIp = deps.clientIp || ((req) => (req.socket && req.socket.remoteAddress) || "");
  const limiter = deps.limiter || null;

  const fail = (res, status, message, type, code) =>
    res.status(status).json({ error: { message, type: type || "invalid_request_error", code: code || null } });

  /**
   * 认一把虚拟 Key。分界线画在「这串东西是不是我们发的」上，不是画在「能不能用」上：
   *
   *   查不到（随机字符串撞门）→ 只回一句「这把 API Key 不对」。不说「不存在」，
   *     免得让人靠错误信息一把一把试出哪些是真的。
   *   查得到、但不让用（停用 / 过期 / 型号不在白名单 / 来源地址不对）
   *     → 直说是哪一种。对面**已经握着这把 Key** 了，enumerate 这件事在这儿无从谈起；
   *       含糊其辞唯一的效果是让业务方对着一句「Key 不对」查两个钟头，
   *       而真正的原因是三个月前给外包那把到期了。
   *
   * 两种都是 401，区别只在那句话和日志：「一把已吊销的 Key 还在被调」是要有人去看的事，
   * 「随机字符串撞门」不是。
   */
  function auth(req, res, model, cap) {
    const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim()
      || String(req.headers["x-api-key"] || "").trim();
    const ip = clientIp(req);
    if (limiter) {
      const wait = limiter.retryAfter("relay|" + ip, 60);
      if (wait) { fail(res, 429, `试太多次了，${wait} 秒后再试`, "rate_limit_error"); return null; }
    }
    const hit = vkeys.verify(raw, { ip, model, cap });
    if (!hit) {
      if (limiter) limiter.fail("relay|" + ip);
      log.warn("relay", "拿了一把不存在的 Key", { ip, model, cap });
      fail(res, 401, "这把 API Key 不对", "authentication_error", "invalid_api_key");
      return null;
    }
    if (hit.reason) {
      // 这一条跟上面那条的区别很重要：Key 是真的，只是不让用。
      // 有人拿着一把已吊销的 Key 在调，是要去看看怎么回事的事。
      log.warn("relay", "一把不能用的 Key 还在被调", { key: hit.key.id, name: hit.key.name, ip, model, cap, why: hit.reason });
      fail(res, 401, hit.reason, "authentication_error", "invalid_api_key");
      return null;
    }
    return hit.key;
  }

  /**
   * 这把 Key 能看见哪些型号。没设白名单就把渠道上登记的都列出来。
   *
   * 媒体那几路的型号也列在这里，多一个 cap 字段说它是哪一路的。
   * OpenAI 的 model 对象没有这个字段，多出来的字段官方 SDK 会直接忽略；
   * 而不列的话，业务方根本无从知道这把 Key 能叫哪些生图模型——
   * 只能来问人，而这正是中转站要省掉的那一步。
   */
  router.get("/v1/models", (req, res) => {
    const k = auth(req, res, "", "");
    if (!k) return;
    const cfg = getConfig();
    let ids = k.models.filter((m) => !m.endsWith("*"));
    if (!ids.length) {
      ids = [...new Set((cfg.models || []).filter((m) => m && m.channel).map((m) => String(m.model || m.name)))];
      if (k.models.length) ids = ids.filter((m) => vkeys._internals.modelAllowed(k.models, m));
    }
    // 一把一路文本都没开的 Key（比如只给生图的那把）不该在列表里看见对话型号。
    // 列出来的每一个 id 都是一句「你可以叫它」的承诺，而它叫过去只会拿到一个 401——
    // 对面的程序员会去查自己的代码，查半天才发现问题在这把 Key 的能力开关上。
    const textOk = vkeys.capAllowed(k.caps, "chat") || vkeys.capAllowed(k.caps, "embedding");
    const data = (textOk ? ids.filter(Boolean).sort() : []).map((id) => ({ id, object: "model", owned_by: "openworkbuddy", cap: "chat" }));
    const CAP_OF = { image: "image", video: "video", tts: "tts", asr: "asr" };
    for (const m of ((cfg.media || {}).list || [])) {
      if (!m || !CAP_OF[m.cap]) continue;
      if (!vkeys.capAllowed(k.caps, m.cap)) continue;
      const id = String(m.name || m.model || "").trim();
      if (!id || data.some((x) => x.id === id)) continue;
      if (k.models.length && !vkeys._internals.modelAllowed(k.models, id)) continue;
      data.push({ id, object: "model", owned_by: "openworkbuddy", cap: m.cap });
    }
    res.json({ object: "list", data });
  });

  router.post("/v1/chat/completions", async (req, res) => {
    const body = req.body || {};
    const model = String(body.model || "").trim();
    if (!model) return fail(res, 400, "请求里没写 model");
    const k = auth(req, res, model, "chat");
    if (!k) return;

    const cfg = getConfig();
    const orgSettings = getOrgSettings(k.org) || {};
    const user = getUser(k.user) || (k.user ? { username: k.user } : null);
    const price = { config: cfg, discount: orgSettings.price_discount };

    // 预估输入有多长。中转站这一层拿不到真正的分词器，按「4 个字符 ≈ 1 token」估——
    // 这个数只用来**预扣**，settle 的时候会被上游报上来的真数换掉，所以宁可估大。
    // 中文比这个比例更费 token，所以估大的方向天然是对的。
    const chars = JSON.stringify(body.messages || []).length;
    let hold;
    try {
      hold = budget.reserve({
        org: orgSettings, orgId: k.org, user, vkey: k, price,
        usage: { model, prompt: Math.ceil(chars / 4), max_tokens: body.max_tokens || body.max_completion_tokens || 0 },
      });
    } catch (e) {
      if (e.status === 402) {
        log.warn("relay", "额度拦下一次调用", { key: k.id, name: k.name, ...e.budget });
        return fail(res, 402, e.message, "insufficient_quota", "insufficient_quota");
      }
      throw e;
    }

    const ac = new AbortController();
    // 客户端半路关掉连接就别让上游接着烧钱。不接这一条的话，一个刷新页面的动作
    // 会留下一条继续跑到底、照常计费、而且没人会去读的请求。
    req.on("aborted", () => ac.abort());
    const t0 = Date.now();
    let out = null;
    try {
      out = await forward({ config: cfg, model, body, headers: req.headers, signal: ac.signal });
    } catch (e) {
      budget.release(hold);
      log.warn("relay", "转发失败", { key: k.id, model, status: e.status || 0, why: String(e.message).slice(0, 300) });
      return fail(res, e.status || 502, e.message, "api_error");
    }

    const done = (usage, extra) => {
      out.cleanup();
      const cost = pricing.costOf(usage, price);
      budget.settle(hold, cost.yuan);
      vkeys.touch(k.id);
      try {
        usageStore.append({
          ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10),
          kind: "relay", user: k.user || "", vkey: k.id, vkey_name: k.name,
          source: "api", model: usage.model || model, provider: out.provider.name || out.provider.id,
          prompt: usage.prompt, cached: usage.cached, completion: usage.completion, calls: 1,
          elapsed_ms: Date.now() - t0,
          cost: cost.yuan, cost_unknown: cost.unknown, price_key: cost.unknown ? "" : cost.key,
          discount: cost.discount, org: k.org,
          // 流式那一路上游有时压根不报 usage，这时的数是按字数估的。
          // 不标出来的话，后台那张账单里估出来的数和真数长得一模一样，谁也不知道哪些能信。
          ...(extra || {}),
        });
      } catch {}
    };

    if (!body.stream) {
      const json = await out.res.json().catch(() => ({}));
      done(usageOf(json, model));
      return res.status(out.res.status).json(json);
    }

    // ── 流式：上游出一个字节就往下写一个字节 ──────────────────────────
    res.status(out.res.status);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");   // nginx 那层也别缓冲，见 deploy/nginx.conf
    let usage = null, chars_out = 0;
    try {
      for await (const chunk of out.res.body) {
        res.write(chunk);
        const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        chars_out += s.length;
        // 只在看见 usage 这个词的时候才去解析。每个 chunk 都 JSON.parse 一遍的话，
        // 一条长回答要白解析上千次——而带 usage 的只有最后那一条。
        if (s.includes('"usage"')) {
          for (const line of s.split("\n")) {
            if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
            try { const j = JSON.parse(line.slice(6)); if (j && j.usage) usage = usageOf(j, model); } catch {}
          }
        }
      }
    } catch (e) {
      log.warn("relay", "流断了", { key: k.id, model, why: String(e.message).slice(0, 200) });
    }
    res.end();
    if (usage) done(usage);
    else done({ model, prompt: Math.ceil(chars / 4), cached: 0, completion: Math.ceil(chars_out / 4) }, { cost_estimated: true });
  });

  // ── 除对话之外的那几路 ────────────────────────────────────────────
  // 企业买的 API 从来不止对话一样：搜索、生图、生视频、语音合成、语音转写，
  // 每一样都是一把单独的 Key、一份单独的账单、一个单独的后台。中转站只转对话的话，
  // 统一管理这件事只做了五分之一——剩下四样还是各买各的、各花各的、月底各对各的账。
  // 这几路跟对话有两处根本不同，下面所有代码都是围着这两点写的：
  //   ① **账不是上游报的，是我们自己数的。** 对话的 token 数由上游在响应里给出，
  //      我们抄下来就行；生图生视频没有这一条，几张图、几秒片、几千字符、几分钟音频
  //      全靠这边数。所以数量在**发出去之前**就定死，预扣用它、结算用它、记流水还用它，
  //      三处一个数——错也只会错在一处，而不是三个数互相对不上。
  //   ② **产出是文件，不是文本。** 上游给的是一个几分钟到一天就失效的临时地址。
  //      原样回给业务方，他明天再来取就是 404，而那一趟已经计过费了。
  //      所以产出先落到 relay-files.js，再发一个我们自己说了算的地址出去。
  // 协议上贴着 OpenAI 走：/v1/images/generations、/v1/audio/speech、
  // /v1/audio/transcriptions、/v1/embeddings 都是官方 SDK 里现成的方法。
  // 官方没有对应方法的两路（生视频、搜索）用同一套形状自己定，
  // 请求体和错误形状跟别的路一模一样，学一次就够。

  /** 媒体那几路的配置。pick 抛的那句话是写给人看的（「现在能用的是：…」），原样带出去比包一层有用 */
  function pickMedia(cap, want) {
    const media = (getConfig() || {}).media || {};
    try { return { cfg: mediaModels.pick(media, cap, want) || {} }; }
    catch (e) { return { err: e.message }; }
  }

  /**
   * 客户端没写 model 的时候，型号白名单要核的是**实际会用的那个**。
   *
   * 不补这一句的话有个真实的口子：一把只开了 deepseek-chat 的 Key，
   * 调生图时不写 model，就用上了后台配的默认生图模型——白名单看着限住了，实际没限住。
   * 返回 true 表示已经把响应写出去了，调用方直接 return。
   */
  function modelGate(res, k, want, real) {
    if (want || !real || !k.models.length) return false;
    if (vkeys._internals.modelAllowed(k.models, real)) return false;
    fail(res, 401, `这把 Key 不能用 ${real}，只开了：${k.models.join("、")}`, "authentication_error", "invalid_api_key");
    return true;
  }

  /** 把路径钉死在这间临时工作目录里。上游和客户端给的文件名都是不可信输入 */
  function mkResolve(dir) {
    const root = nodePath.resolve(dir);
    return (rel) => {
      const p = nodePath.resolve(root, String(rel || ""));
      if (p !== root && !p.startsWith(root + nodePath.sep)) throw new Error("路径越界");
      return p;
    };
  }

  /**
   * 开一间临时工作目录跑一趟媒体工具，跑完连目录一起删。
   *
   * 为什么不直接用工作空间：中转站的调用方是**别家的程序**，不是这台机器的使用者。
   * 把他生成的东西写进某个人的工作空间，等于让一个 API 调用在别人的文件夹里留下东西；
   * 而所有产出都要经 relay-files 才发得出去，留在盘上的那一份纯属多余。
   */
  async function inTmp(fn) {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "owb-relay-"));
    try {
      return await tools.withWorkspace(dir, () => fn(dir, mkResolve(dir)));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * 预扣 → 跑 → 结算，按次计费那几路共用。
   *
   * 返回 run() 的结果；返回 null 表示已经把错误响应写出去了，调用方直接 return。
   * 跑失败一律 release：一次没成的生图扣掉额度，是那种月底才会被发现、
   * 且永远说不清的错（跟上面对话那条路上的处理是同一条规矩）。
   */
  async function meter(req, res, { k, cap, model, units, provider = "", run }) {
    const cfg = getConfig();
    const orgSettings = getOrgSettings(k.org) || {};
    const user = getUser(k.user) || (k.user ? { username: k.user } : null);
    const price = { config: cfg, discount: orgSettings.price_discount };
    let hold;
    try {
      hold = budget.reserve({ org: orgSettings, orgId: k.org, user, vkey: k, price, usage: { cap, model, units } });
    } catch (e) {
      if (e.status === 402) {
        log.warn("relay", "额度拦下一次调用", { key: k.id, name: k.name, cap, ...e.budget });
        fail(res, 402, e.message, "insufficient_quota", "insufficient_quota");
        return null;
      }
      throw e;
    }
    const t0 = Date.now();
    let out;
    try {
      out = await run();
    } catch (e) {
      budget.release(hold);
      log.warn("relay", "转发失败", { key: k.id, cap, model, why: String((e && e.message) || e).slice(0, 300) });
      fail(res, (e && e.status) || 502, String((e && e.message) || e), "api_error");
      return null;
    }
    // 媒体适配器不抛异常，它把失败包成 { isError: true, content: 一句人话 }。
    // 那句话是给人看的（「图像模型未配置：请在 设置 → 模型 …」），原样带出去比换成
    // 「上游错误」有用得多——对面是业务方的程序员，他看到的就是这句。
    if (out && out.isError) {
      budget.release(hold);
      log.warn("relay", "转发失败", { key: k.id, cap, model, why: String(out.content).slice(0, 300) });
      fail(res, out.status || 502, String(out.content || "上游没跑成"), "api_error");
      return null;
    }
    // 真跑完才知道的量（比如要 4 张只成了 3 张）以实际为准；没给就是发出去之前定的那个数
    const real = out && out.units != null ? out.units : units;
    const cost = pricing.costOfUnits({ cap, model, units: real }, price);
    budget.settle(hold, cost.yuan);
    vkeys.touch(k.id);
    try {
      const now = new Date();
      usageStore.append({
        ts: now.toISOString(), day: now.toISOString().slice(0, 10),
        kind: "relay", cap, user: k.user || "", vkey: k.id, vkey_name: k.name,
        source: "api", model: model || "", provider: provider || (out && out.provider) || "",
        units: real, unit: (pricing.UNITS[cap] || {}).unit || "",
        // token 那四个字段照样写 0：后台那张表是按列汇总的，缺字段和 0 在汇总里
        // 长得一样，但缺字段会让「按型号排序」这类操作在某些行上拿到 undefined
        prompt: 0, cached: 0, completion: 0, calls: 1,
        elapsed_ms: Date.now() - t0,
        cost: cost.yuan, cost_unknown: cost.unknown, price_key: cost.unknown ? "" : cost.key,
        discount: cost.discount, org: k.org,
      });
    } catch {}
    return out;
  }

  /** 产出落盘 + 组一条能直接回给客户端的记录 */
  function stash(buf, meta) {
    const m = relayFiles.save(buf, meta);
    return {
      id: m.id, filename: m.name, bytes: m.bytes, content_type: m.content_type,
      // 相对地址：中转站常常挂在 nginx / 内网域名后面，这里拼一个绝对地址十有八九是错的
      url: `/v1/files/${m.id}/content`, expires_at: m.expires_at,
    };
  }

  /**
   * 生图。OpenAI 的 /v1/images/generations，官方 SDK 的 images.generate 直接能用。
   *
   * 跟官方有一处**故意**的不同：response_format 默认给 b64_json，官方默认给 url。
   * 因为我们的 url 是要带 Key 才取得到的（见 relay-files.js 第 1 条），默认回 url 等于
   * 递给人一个在浏览器里打不开的链接；b64_json 在所有 SDK 里都是开箱即用。
   * 明写 response_format: "url" 的照给 url。
   */
  router.post("/v1/images/generations", async (req, res) => {
    const b = req.body || {};
    const want = String(b.model || "").trim();
    const k = auth(req, res, want, "image");
    if (!k) return;
    const prompt = String(b.prompt || "").trim();
    if (!prompt) return fail(res, 400, "请求里没写 prompt");
    const m = pickMedia("image", want);
    if (m.err) return fail(res, 503, m.err, "api_error");
    const model = m.cfg.model || want;
    if (modelGate(res, k, want, model)) return;
    // 上游那个适配器一次出一张（生图接口 n>1 各家行为不一，有的静默只给一张）。
    // 要几张就跑几趟，封顶 4 张：一趟四张已经是 4 倍单价，再多该走自己的批处理。
    const n = Math.min(Math.max(Math.floor(+b.n || 1), 1), 4);
    const out = await meter(req, res, {
      k, cap: "image", model, units: n, provider: m.cfg.provider || "",
      run: () => inTmp(async (dir, resolveFile) => {
        const media = (getConfig() || {}).media || {};
        const data = [];
        for (let i = 0; i < n; i++) {
          const r = await tools._internals.generateImage(
            media, { prompt, model: want || undefined, size: b.size, filename: `image_${i + 1}.png` }, 300000, dir, resolveFile);
          // 第一张就失败 = 这一趟整个失败；已经出了几张再失败，按出了几张算账，
          // 把出来的给他。中途报废已经生成的图，等于让他付了钱还什么都没拿到。
          if (r.isError) { if (!data.length) return r; break; }
          data.push({ buf: fs.readFileSync(nodePath.join(dir, r.file)), name: r.file });
        }
        return { data, units: data.length };
      }),
    });
    if (!out) return;
    const asUrl = String(b.response_format || "b64_json") === "url";
    res.json({
      created: Math.floor(Date.now() / 1000), model,
      data: out.data.map((d) => (asUrl
        ? stash(d.buf, { name: d.name, cap: "image", org: k.org, vkey: k.id, model })
        : { b64_json: d.buf.toString("base64") })),
    });
  });

  /**
   * 生视频。OpenAI 那边没有一个稳定的同名接口，形状自己定，但字段名跟别的路一致。
   *
   * 这一路**只回 url，不回 base64**：一条 5 秒的片子十几兆，转成 base64 是二十几兆的
   * JSON 字符串——客户端那边解析它要把二十几兆读进内存，而他真正想要的是一个文件。
   */
  router.post("/v1/videos/generations", async (req, res) => {
    const b = req.body || {};
    const want = String(b.model || "").trim();
    const k = auth(req, res, want, "video");
    if (!k) return;
    const prompt = String(b.prompt || "").trim();
    if (!prompt) return fail(res, 400, "请求里没写 prompt");
    const m = pickMedia("video", want);
    if (m.err) return fail(res, 503, m.err, "api_error");
    const model = m.cfg.model || want;
    if (modelGate(res, k, want, model)) return;
    // 秒数：各家默认都是 5 秒，而且绝大多数接口压根不收这个参数——
    // 这个数在这儿的唯一作用是**算钱**，所以按各家的默认值算，别自作主张改上游行为。
    const seconds = Math.min(Math.max(+b.seconds || +b.duration || 5, 1), 60);
    const ac = new AbortController();
    req.on("aborted", () => ac.abort());
    const out = await meter(req, res, {
      k, cap: "video", model, units: seconds, provider: m.cfg.provider || "",
      run: () => inTmp(async (dir, resolveFile) => {
        const media = (getConfig() || {}).media || {};
        const input = { prompt, model: want || undefined, filename: "out.mp4" };
        // 首尾帧：客户端给 data URI 或 http 地址都行，落成临时文件再交给适配器——
        // 它认的是「工作空间里的相对路径」，而这间工作空间就是这趟请求自己的临时目录
        for (const [field, key] of [["first_frame", "first"], ["last_frame", "last"]]) {
          const v = String(b[field] || "").trim();
          if (!v) continue;
          const mm = /^data:([^;,]+);base64,(.+)$/s.exec(v);
          if (!mm) { input[field] = v; continue; }
          const ext = (mm[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "png";
          const fn = `${key}.${ext}`;
          fs.writeFileSync(nodePath.join(dir, fn), Buffer.from(mm[2], "base64"));
          input[field] = fn;
        }
        const r = await tools._internals.generateVideo(media, input, { saveDir: dir, resolveFile, stopSignal: ac.signal });
        if (r.isError) return r;
        return { buf: fs.readFileSync(nodePath.join(dir, r.file)), name: r.file };
      }),
    });
    if (!out) return;
    res.json({
      created: Math.floor(Date.now() / 1000), model, seconds,
      data: [stash(out.buf, { name: out.name, cap: "video", org: k.org, vkey: k.id, model })],
    });
  });

  /**
   * 语音合成。OpenAI 的 /v1/audio/speech 回的是**裸音频字节**，不是 JSON——
   * 官方 SDK 的 audio.speech.create() 按这个来解，回一个 JSON 会让它当场炸。
   * 所以这一路不走 relay-files：内容就在响应体里，存一份下来没人会去取。
   */
  router.post("/v1/audio/speech", async (req, res) => {
    const b = req.body || {};
    const want = String(b.model || "").trim();
    const k = auth(req, res, want, "tts");
    if (!k) return;
    const text = String(b.input || b.text || "").trim();
    if (!text) return fail(res, 400, "请求里没写 input（要念的文字）");
    const m = pickMedia("tts", want);
    if (m.err) return fail(res, 503, m.err, "api_error");
    const model = m.cfg.model || want;
    if (modelGate(res, k, want, model)) return;
    const out = await meter(req, res, {
      k, cap: "tts", model, units: Math.max(0.001, text.length / 1000), provider: m.cfg.provider || "",
      run: () => inTmp(async (dir) => {
        const media = (getConfig() || {}).media || {};
        const r = await tools._internals.textToSpeech(media, { text, voice: b.voice, model: want || undefined, filename: "speech" }, 300000, dir);
        if (r.isError) return r;
        // textToSpeech 按渠道协议决定扩展名（DashScope 出 wav，OpenAI 兼容出 mp3），
        // 所以文件名要从目录里读回来，不能在这儿硬猜一个
        const f = fs.readdirSync(dir).find((x) => /^speech\./i.test(x)) || fs.readdirSync(dir)[0];
        if (!f) return { content: "语音合成没有产出文件", isError: true };
        return { buf: fs.readFileSync(nodePath.join(dir, f)), name: f };
      }),
    });
    if (!out) return;
    res.setHeader("content-type", relayFiles.typeOf(out.name));
    res.setHeader("content-disposition", `inline; filename="${out.name}"`);
    res.end(out.buf);
  });

  /**
   * 语音转写。OpenAI 的 /v1/audio/transcriptions 是 multipart/form-data —— 整个仓库里
   * 只有这一条接口是这个格式，为它装一个 multipart 解析库不划算（多一个依赖、多一份
   * 攻击面，而它要解的就是「一个文件加三个字符串」）。
   *
   * 所以这里用 Node 自带的那一套：express.raw 把整包收成 Buffer，交给
   * `new Request(...).formData()` —— 那是 undici 的解析器，Node 18 起内置，
   * fetch 上传文件时用的就是它，跟我们发给上游的那一包是同一套代码。
   * 只挂在这一条路由上，别的接口的请求体一个字节都不经过它。
   */
  router.post("/v1/audio/transcriptions", express.raw({ type: "multipart/form-data", limit: "30mb" }), async (req, res) => {
    let form;
    try {
      form = await new Request("http://relay.invalid/", {
        method: "POST",
        headers: { "content-type": String(req.headers["content-type"] || "") },
        body: req.body,
      }).formData();
    } catch (e) {
      return fail(res, 400, "这个请求不是一包合法的 multipart/form-data：" + String(e.message || e).slice(0, 200));
    }
    const want = String(form.get("model") || "").trim();
    const k = auth(req, res, want, "asr");
    if (!k) return;
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function") return fail(res, 400, "请求里没有 file 这个文件字段");
    const buf = Buffer.from(await file.arrayBuffer());
    if (!buf.length) return fail(res, 400, "file 是空的");
    const m = pickMedia("asr", want);
    if (m.err) return fail(res, 503, m.err, "api_error");
    const model = m.cfg.model || want;
    if (modelGate(res, k, want, model)) return;
    // 分钟数按字节估：128kbps ≈ 16KB/s。真实秒数要解音频头，而这条路上每一次调用
    // 都要解一遍；误差在 2 倍以内，用来预扣够了，跟 tools.js 里 unitsFor 用的是同一个估法。
    const mins = Math.max(0.1, buf.length / 16000 / 60);
    const withTs = /^(1|true|yes|verbose_json)$/i.test(String(form.get("response_format") || form.get("timestamp_granularities") || ""));
    const out = await meter(req, res, {
      k, cap: "asr", model, units: mins, provider: m.cfg.provider || "",
      run: () => inTmp(async (dir, resolveFile) => {
        const media = (getConfig() || {}).media || {};
        const name = nodePath.basename(String(file.name || "audio.mp3")).replace(/[\/\\]/g, "_").slice(0, 80) || "audio.mp3";
        fs.writeFileSync(nodePath.join(dir, name), buf);
        const r = await tools._internals.transcribeAudio(
          media, { path: name, model: want || undefined, language: form.get("language") || "", hint: form.get("prompt") || "", with_timestamps: withTs, filename: "transcript.txt" },
          0, resolveFile, dir);
        if (r.isError) return r;
        // 适配器回的 content 是给模型看的一段话（「转写完成，存到 …」），不是稿子本身。
        // 稿子在它写下的那个文件里，从盘上读回来才是原文——把那段话当稿子回给业务方，
        // 他拿到的就是一句中文提示加上被截断的正文。
        const txt = fs.readFileSync(nodePath.join(dir, "transcript.txt"), "utf8");
        let srt = "";
        try { srt = fs.readFileSync(nodePath.join(dir, "transcript.srt"), "utf8"); } catch {}
        return { text: txt, srt };
      }),
    });
    if (!out) return;
    if (withTs) return res.json({ text: out.text, srt: out.srt || "", model });
    res.json({ text: out.text });
  });

  /**
   * 联网搜索。没有 OpenAI 官方接口可贴，形状按这条路自己定。
   *
   * 只走**配了 Key 的付费引擎**，不做 DuckDuckGo 那种免费兜底：
   * 兜底那一档是给内部 agent 用的——它宁可拿到差一点的结果也不该整趟失败。
   * 中转站这边相反：业务方按次付了钱，拿到的必须是他买的那家的结果；
   * 悄悄换成免费源，他的程序不会报错，只会在某一天发现质量莫名其妙变差了。
   */
  router.post("/v1/search", async (req, res) => {
    const b = req.body || {};
    const k = auth(req, res, "", "search");
    if (!k) return;
    const query = String(b.query || b.q || "").trim();
    if (!query) return fail(res, 400, "请求里没写 query");
    const n = Math.min(Math.max(+b.count || +b.n || 5, 1), 10);
    const scfg = (getConfig() || {}).search || {};
    const provider = String(b.provider || scfg.provider || "jina").toLowerCase();
    const fn = tools.SEARCH_PROVIDERS[provider];
    if (!fn) return fail(res, 400, `没有叫「${provider}」的搜索引擎，能用的是：${Object.keys(tools.SEARCH_PROVIDERS).join(" / ")}`);
    const key = tools.searchProviderKey(scfg, provider);
    if (!key) return fail(res, 503, `${provider} 还没配 Key，去 设置 → 搜索 填一把（中转站这条路不退免费引擎，见代码注释）`, "api_error");
    const out = await meter(req, res, {
      k, cap: "search", model: provider, units: 1, provider,
      run: async () => ({ results: await fn(key, query, n) }),
    });
    if (!out) return;
    res.json({ query, provider, results: out.results });
  });

  /**
   * 向量化。这一路是**按 token 计费**的，跟生图那几路不是一回事，所以它走的是
   * 对话那条路的账本（prompt / completion），不是 costOfUnits。
   * 转发本身跟对话完全一样，只是换了个上游路径。
   */
  router.post("/v1/embeddings", async (req, res) => {
    const body = req.body || {};
    const model = String(body.model || "").trim();
    if (!model) return fail(res, 400, "请求里没写 model");
    const k = auth(req, res, model, "embedding");
    if (!k) return;
    const cfg = getConfig();
    const orgSettings = getOrgSettings(k.org) || {};
    const user = getUser(k.user) || (k.user ? { username: k.user } : null);
    const price = { config: cfg, discount: orgSettings.price_discount };
    const chars = JSON.stringify(body.input || "").length;
    let hold;
    try {
      hold = budget.reserve({
        org: orgSettings, orgId: k.org, user, vkey: k, price,
        usage: { model, prompt: Math.ceil(chars / 4), max_tokens: 0 },
      });
    } catch (e) {
      if (e.status === 402) {
        log.warn("relay", "额度拦下一次调用", { key: k.id, name: k.name, cap: "embedding", ...e.budget });
        return fail(res, 402, e.message, "insufficient_quota", "insufficient_quota");
      }
      throw e;
    }
    const ac = new AbortController();
    req.on("aborted", () => ac.abort());
    const t0 = Date.now();
    let out;
    try {
      out = await forward({ config: cfg, model, body, headers: req.headers, signal: ac.signal, path: "/embeddings" });
    } catch (e) {
      budget.release(hold);
      log.warn("relay", "转发失败", { key: k.id, cap: "embedding", model, status: e.status || 0, why: String(e.message).slice(0, 300) });
      return fail(res, e.status || 502, e.message, "api_error");
    }
    out.cleanup();
    const json = await out.res.json().catch(() => ({}));
    const usage = usageOf(json, model);
    const cost = pricing.costOf(usage, price);
    budget.settle(hold, cost.yuan);
    vkeys.touch(k.id);
    try {
      const now = new Date();
      usageStore.append({
        ts: now.toISOString(), day: now.toISOString().slice(0, 10),
        kind: "relay", cap: "embedding", user: k.user || "", vkey: k.id, vkey_name: k.name,
        source: "api", model: usage.model || model, provider: out.provider.name || out.provider.id,
        prompt: usage.prompt, cached: usage.cached, completion: usage.completion, calls: 1,
        elapsed_ms: Date.now() - t0,
        cost: cost.yuan, cost_unknown: cost.unknown, price_key: cost.unknown ? "" : cost.key,
        discount: cost.discount, org: k.org,
      });
    } catch {}
    res.status(out.res.status).json(json);
  });

  /**
   * 取产出。两条：`/v1/files/:id` 是这份文件的信息，`/v1/files/:id/content` 是字节本身。
   * 两条都要带 Key，而且必须是**同一个组织**发出去的 Key——理由写在 relay-files.js 第 1 条。
   */
  router.get("/v1/files/:id", (req, res) => {
    const k = auth(req, res, "", "");
    if (!k) return;
    const got = relayFiles.get(req.params.id, { org: k.org });
    if (got.err) return fail(res, got.status || 404, got.err, "invalid_request_error", "file_not_found");
    res.json({ ...got.meta, url: `/v1/files/${got.meta.id}/content` });
  });

  router.get("/v1/files/:id/content", (req, res) => {
    const k = auth(req, res, "", "");
    if (!k) return;
    const got = relayFiles.get(req.params.id, { org: k.org });
    if (got.err) return fail(res, got.status || 404, got.err, "invalid_request_error", "file_not_found");
    res.setHeader("content-type", got.meta.content_type);
    res.setHeader("content-disposition", `inline; filename="${got.meta.name}"`);
    res.end(got.buf);
  });

  return router;
}

module.exports.createRouter = createRouter;
