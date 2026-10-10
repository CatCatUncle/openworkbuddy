// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 对话模型的「渠道共用一把 Key」层。
 *
 * 老配置里，每条模型自己抄一份接口地址和 Key：
 *   config.models = [{ name, provider: "openai"|"anthropic", base_url, api_key, model }]
 * 可现实是一把 OpenRouter 的 Key 底下挂着几十个模型，一把火山方舟的 Key 底下挂着豆包全家。
 * 抄一遍就多一处要改：换 Key 的时候漏掉一条，那条就在下一次对话时突然 401，
 * 而界面上它跟别的条目长得一模一样，人根本不知道该改哪儿。
 *
 * 所以把「地址 + Key」抽到渠道那一层，模型只记自己属于哪个渠道：
 *   config.providers = [{ id, name, kind, base_url, api_key }]   ← 跟四路媒体模型共用同一张表
 *   config.models[i].channel = 渠道 id
 *
 * 关键的一条：**每次规整都把渠道的地址和 Key 压平回模型条目上**。于是 llm.js、agent.js、
 * eval/run.js 那十来处读 `m.base_url` / `m.api_key` 的代码一个字都不用改，老配置也照跑——
 * 升级不需要用户做任何事。这跟 media-models.js 把默认那条压平回 config.media[cap] 是同一招。
 *
 * 三条红线：
 *   1. **不删模型。** channel 指向一个已经不存在的渠道，就当它没填过 channel 重新认一次，
 *      认不出来也只是没有渠道可挂，条目本身连同它的地址和 Key 原样留着。
 *   2. **协议归渠道管。** 一个接口地址只可能说一种话（OpenAI 兼容 / Anthropic），
 *      所以 provider 这个字段从模型收到渠道的 kind 上，压平时再写回去。
 *   3. **同地址不同 Key 是两个渠道。** 自己的号和同事的号都指着 openrouter，那就是两行，
 *      合并会让人在不知情的情况下用别人的额度。
 */

const {
  PROVIDER_KINDS, CATALOG, guessKind, baseOfKind, protoOfKind, protoOfChannel, normApi, isApiFormat,
  providerKeyOf, uniqueId, normalizeProviders, baseForUse, dedupeProviders, mediaCapOf,
} = require("./media-models");

/** 本机地址：Ollama / LM Studio 这类压根不要 Key，没 Key 也算配过了 */
const isLocalBase = (u) => /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(String(u || ""));
const nb = (u) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();

/**
 * 渠道的认领依据：协议 + 地址 + Key 三样都一样才是同一个渠道。
 *
 * 为什么协议也要算进去：Anthropic 官方没有接口地址（空串），只按地址认的话，
 * 它会跟所有「填了 Key 却忘了填地址」的条目并成一个渠道。
 */
function chanKeyOf(kind, row) {
  return `${protoOfKind(kind)} ${providerKeyOf(row)}`;
}

/** 新建渠道时给个像样的名字：认识的厂商用它的中文名，自建网关用域名——总比「未命名渠道」强 */
function nameForKind(kind, baseUrl) {
  const k = PROVIDER_KINDS.find((x) => x.kind === kind);
  if (k && k.base_url) return k.label;
  const b = String(baseUrl || "").trim();
  if (b) {
    try { const h = new URL(b).host; if (h) return h; } catch {}
  }
  return (k && k.label) || "自定义渠道";
}

/**
 * 这条模型该不该有渠道。
 *
 * 填了 Key 的、或者指着本机地址的（Ollama 那类压根不要 Key）才算配过了。
 * 只有地址没有 Key 的条目是**厂商模板**，不是渠道——老版本出厂 config 里那一排就长这样。
 * 以前它们也建渠道，于是设置页凭空多出一排「未填 Key」的空壳，人删掉之后下一次规整又建回来。
 */
function wantsChannel(m) {
  if (isLocalBase(m.base_url)) return true;
  return !!String(m.api_key || "").trim();
}

/**
 * 老版本出厂 config.json（以及更老的启动迁移）塞进来的那九行厂商模板。名字 + 地址就认得出来。
 * 这张表只用来**收回我们自己塞的**：用户自己起名建的行永远不在这张表里。
 */
const SEEDED_PRESETS = [
  { name: "DeepSeek", base_url: "https://api.deepseek.com/v1" },
  { name: "通义Qwen", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "智谱GLM", base_url: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "Kimi", base_url: "https://api.moonshot.cn/v1" },
  { name: "Ollama本地", base_url: "http://localhost:11434/v1" },
  { name: "OpenAI", base_url: "https://api.openai.com/v1" },
  { name: "Anthropic Claude", base_url: "" },
  { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1" },
  { name: "火山方舟", base_url: "https://ark.cn-beijing.volces.com/api/v3" },
];
const isSeededPreset = (m) => SEEDED_PRESETS.some((p) => p.name === String(m.name || "").trim() && nb(p.base_url) === nb(m.base_url));
/** 没在行上填 Key，但环境变量能兜住的（llm.js 只把这两把通用 Key 发给官方域名）：那不算没配 */
function envKeyFor(m) {
  const base = String(m.base_url || "").trim();
  if (!base) return m.provider === "anthropic" && !!process.env.ANTHROPIC_API_KEY;
  try { return /(^|\.)openai\.com$/i.test(new URL(base).hostname) && !!process.env.OPENAI_API_KEY; } catch { return false; }
}
/** 向导 / 老配置迁移给模型行起的短名：跟老出厂模板同名，用户看着眼熟 */
const SHORT_NAME = {
  ark: "火山方舟", dashscope: "阿里云百炼", openai: "OpenAI", openrouter: "OpenRouter", siliconflow: "硅基流动",
  zhipu: "智谱GLM", anthropic: "Anthropic Claude", deepseek: "DeepSeek", moonshot: "Kimi", ollama: "Ollama本地",
};

/**
 * 收回出厂占位：没填 Key 的模板行，和它们留下的空壳渠道。server.js 开机跑一次，跑过盖 presets_pruned 章。
 *
 * 只收两种东西，别的一律不碰：
 *   1. 名字和地址都跟出厂模板一模一样、Key 空着（环境变量也兜不住）、又不是本机地址的模型行。
 *      本机 Ollama 那行不要 Key，「没 Key」不是没配过的证据。正在用的那条也照收：没 Key 的行
 *      本来就一句话都发不出去，留着只是让人以为「配了」——收掉之后 active_model 清空，向导会重新弹。
 *   2. 空 Key、地址还是这家的默认地址、底下一条对话模型和媒体模型都没挂的渠道行（模板行删掉后留下的壳）。
 * 幂等：收完一遍再跑，什么都不会动。返回收掉了哪些（名字），调用方据此落盘、打日志。
 */
function pruneSeededPresets(config) {
  const models = Array.isArray(config.models) ? config.models.filter((m) => m && typeof m === "object") : [];
  const providers = Array.isArray(config.providers) ? config.providers.filter((p) => p && typeof p === "object") : [];
  const mediaModels = Array.isArray(config.media_models) ? config.media_models.filter((m) => m && typeof m === "object") : [];
  const goneRows = models.filter((m) => !String(m.api_key || "").trim() && !isLocalBase(m.base_url) && !envKeyFor(m) && isSeededPreset(m));
  config.models = models.filter((m) => !goneRows.includes(m));
  if (goneRows.some((m) => m.name === String(config.active_model || ""))) config.active_model = "";
  const used = new Set([...config.models.map((m) => m.channel), ...mediaModels.map((m) => m.provider)]);
  const goneChans = providers.filter((p) => !String(p.api_key || "").trim() && !used.has(p.id) && !isLocalBase(p.base_url) && nb(p.base_url) === nb(baseOfKind(p.kind)));
  config.providers = providers.filter((p) => !goneChans.includes(p));
  return { models: goneRows.map((m) => m.name), channels: goneChans.map((p) => p.name || p.id) };
}

/** 向导给每家默认挑的对话模型：老出厂模板里那几个，目录里有的以目录第一条兜底 */
const DEFAULT_CHAT_MODEL = {
  ark: "doubao-seed-1-6-250615", dashscope: "qwen-max", openai: "gpt-5.2", openrouter: "deepseek/deepseek-chat",
  zhipu: "glm-4-plus", anthropic: "claude-sonnet-5", deepseek: "deepseek-chat", moonshot: "moonshot-v1-32k", ollama: "qwen3:8b",   // 兜底而已：连得上本机时向导按它真装了什么来（14b 要 9GB，16G 的 Mac 跑不动）
};

/**
 * 首页向导的「服务商」清单。以前它读的是 config.models 里那排模板行——所以模板行不能删；
 * 现在它读目录，config 里从此只有用户真配过的东西。
 */
function templates() {
  return PROVIDER_KINDS
    .filter((k) => !k.media_only && !k.decide_only && k.kind !== "newapi" && k.kind !== "custom")
    .map((k) => {
      const cat = (CATALOG.chat || []).find((c) => c.kind === k.kind);
      return {
        kind: k.kind, label: k.label,
        name: SHORT_NAME[k.kind] || String(k.label).replace(/（.*$/, "").trim(),
        base_url: k.base_url || "", key_url: k.key_url || "",
        model: DEFAULT_CHAT_MODEL[k.kind] || (cat ? cat.id : ""),
        local: k.kind === "ollama" || isLocalBase(k.base_url),
      };
    })
    .filter((t) => t.model);
}

/**
 * 按模板起一条模型：先算好要建什么，**不动 config**——向导要先拿它验活，验过了再 commitTemplate 落下去。
 * 同家同地址的渠道已经有了就复用（空壳补 Key；Key 一样就是同一个号）；返回 null 表示没这家。
 */
function planTemplate(config, kind, modelId) {
  const t = templates().find((x) => x.kind === String(kind || "").trim());
  if (!t) return null;
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const models = Array.isArray(config.models) ? config.models : [];
  const model = String(modelId || "").trim() || t.model;
  const prov = providers.find((p) => p.kind === t.kind && nb(p.base_url) === nb(t.base_url)) || null;
  const taken = new Set(models.map((m) => String(m.name || "")));
  const name = taken.has(t.name) ? `${t.name} ${model}` : t.name;
  const row = { name, provider: protoOfKind(t.kind), base_url: baseForUse(t.base_url, "chat", t.kind), api_key: "", model };
  return { t, prov, row };
}

/** 贴进来的地址常常多带一截：文档里抄的是整条 …/chat/completions。去掉它，剩下的才是渠道地址 */
function trimEndpoint(u) {
  return String(u || "").trim().replace(/\/+$/, "")
    .replace(/\/(chat\/completions|completions|responses|messages)$/i, "")
    .replace(/\/+$/, "");
}

/**
 * 向导里「自己填地址」那一条：中转站、new-api / one-api 网关、公司内网、本机 vLLM / LM Studio……
 * 跟 planTemplate 一样只算不落，验活过了再 commitTemplate。
 *
 * 以前向导只列目录里那几家，填中转的人得先跳过第一步、进了界面再去设置里找「自定义」——
 * 可大脑没接上就什么都干不了，第一步正是最需要这条路的地方。
 *
 * 地址认得出是哪家官方的（把 DeepSeek 官方地址贴进来了）就按那家记，渠道卡上的名字才对；
 * 认不出的记成「其它 OpenAI 兼容接口」，名字用域名。
 * 返回 { t, prov, row, alt } 或 { err }。alt：只填了域名时补上 /v1 的备选——中转站的接口多半挂在 /v1 下。
 * @param {any} config
 * @param {{ base_url?: string, model?: string, api?: string }} [input]
 */
function planCustom(config, { base_url, model, api } = {}) {
  const base = trimEndpoint(base_url);
  let url = null;
  try { url = new URL(base); } catch {}
  if (!url || !/^https?:$/.test(url.protocol) || !url.host) return { err: "接口地址要填完整，例如 https://api.example.com/v1" };
  const modelId = String(model || "").trim();
  if (!modelId) return { err: "模型名还空着，照这家接口文档填" };
  const fmt = isApiFormat(api) ? api : "openai";
  const kind = guessKind(base);
  const label = nameForKind(kind, base);
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const models = Array.isArray(config.models) ? config.models : [];
  // 同一个地址说两门话（一个中转同时给 OpenAI 和 Anthropic 两种格式）是两条渠道，不能并
  const prov = providers.find((p) => p.kind === kind && nb(p.base_url) === nb(base) && protoOfChannel(p) === fmt) || null;
  const short = SHORT_NAME[kind] || label;
  const taken = new Set(models.map((m) => String(m.name || "")));
  let name = taken.has(short) ? `${short} ${modelId}` : short;
  for (let i = 2; taken.has(name); i++) name = `${short} ${modelId} ${i}`;
  const row = { name, provider: fmt, base_url: baseForUse(base, "chat", kind), api_key: "", model: modelId };
  const bare = !url.pathname.replace(/\/+$/, "");
  const alt = bare && (fmt === "openai" || fmt === "openai-responses") ? base + "/v1" : "";
  return {
    t: { kind, label, name: short, base_url: base, api: fmt !== protoOfKind(kind) ? fmt : "", local: isLocalBase(base) },
    prov, row, alt,
  };
}

/** 把 planTemplate / planCustom 算好的那条落进 config：渠道（带 Key）+ 模型行（挂在它下面）。返回最后那条模型行 */
function commitTemplate(config, plan, key) {
  config.providers = Array.isArray(config.providers) ? config.providers : [];
  config.models = Array.isArray(config.models) ? config.models : [];
  const k = String(key || "").trim();
  let prov = plan.prov;
  // 已有的那行填着另一把 Key：那是另一个号，另起一行，别把人家的 Key 盖掉
  if (prov && String(prov.api_key || "").trim() && k && prov.api_key !== k) prov = null;
  if (!prov) {
    const ids = new Set(config.providers.map((p) => String(p.id)));
    prov = { id: uniqueId(plan.t.kind, ids), name: plan.t.label, kind: plan.t.kind, base_url: plan.t.base_url, api_key: k, ...(plan.t.api ? { api: plan.t.api } : {}) };
    config.providers.push(prov);
  } else if (k) prov.api_key = k;
  const dup = config.models.find((m) => m.channel === prov.id && String(m.model) === String(plan.row.model));
  if (dup) return dup;
  const row = { ...plan.row, channel: prov.id, api_key: prov.api_key };
  config.models.push(row);
  return row;
}

/**
 * 还没有 models 表的老配置（provider / openai / anthropic 三块）：只把填了 Key 的那家搬成一条模型。
 * 以前这一步会顺手塞进五家厂商的模板行——用户看到的就是一排没 Key 的占位渠道。
 */
function legacyRows(config) {
  const rows = [];
  const o = config.openai || {};
  const a = config.anthropic || {};
  if (String(o.api_key || "").trim() && String(o.base_url || "").trim() && String(o.model || "").trim()) {
    const kind = guessKind(o.base_url);
    rows.push({ name: SHORT_NAME[kind] || nameForKind(kind, o.base_url), provider: "openai", base_url: String(o.base_url).trim(), api_key: String(o.api_key).trim(), model: String(o.model).trim() });
  }
  if (String(a.api_key || "").trim() && String(a.model || "").trim()) {
    rows.push({ name: "Anthropic Claude", provider: "anthropic", base_url: "", api_key: String(a.api_key).trim(), model: String(a.model).trim() });
  }
  if (rows.length > 1 && config.provider === "anthropic") rows.reverse();
  return rows;
}

/**
 * 把对话模型规整成「渠道 + 模型」两层，幂等——跑一百遍结果一样。
 * 返回 true 表示真改了东西（调用方据此决定要不要落盘）。
 */
function normalize(config) {
  const before = JSON.stringify([config.providers || null, config.models || null]);
  const providers = Array.isArray(config.providers) ? config.providers.filter((p) => p && typeof p === "object") : [];
  const models = Array.isArray(config.models) ? config.models.filter((m) => m && typeof m === "object") : [];
  const ids = normalizeProviders(providers);
  // 先把重复的渠道并掉，再往上挂模型。顺序不能反：反了的话模型会先被压平成「那行空壳的空 Key」，
  // 合并之后 channel 虽然改指到有 Key 的那行，条目上压平的 api_key 还是空的——
  // 用户看到的就是「首页明明填了火山的 Key，设置里还说没填」。
  config.providers = providers;
  if (dedupeProviders(config)) providers.splice(0, providers.length, ...config.providers);
  config.providers = providers;
  const byKey = new Map(providers.map((p) => [chanKeyOf(p.kind, p), p]));

  /** 同一家、同一个地址、但还空着 Key 的那行。它不是「另一个账号」，是「这家还没填」 */
  const nb = (u) => baseForUse(String(u || "").trim(), "media").replace(/\/+$/, "").toLowerCase();
  const shellFor = (kind, baseUrl) => providers.find(
    (p) => p.kind === kind && !String(p.api_key || "").trim() && nb(p.base_url) === nb(baseUrl || baseOfKind(kind))
  );

  for (const m of models) {
    // 老条目的协议记在自己身上，这一步之后它归渠道管；这里先归一化，好拿来认渠道
    m.provider = normApi(m.provider);
    const ref = String(m.channel || "").trim();
    let prov = ref ? providers.find((p) => p.id === ref) : null;
    if (!prov && wantsChannel(m)) {
      // 协议是用户在模型条目上选的，认渠道时它说了算：填了中转地址的 Anthropic 协议
      // 也该归到「Anthropic 协议」那个渠道，而不是按域名猜成一个 OpenAI 兼容渠道。
      // 例外是地址认得出是哪家的（智谱的 open.bigmodel.cn/api/anthropic）：那就是那家的渠道，
      // 协议记在 api 上（下一行），不然渠道类型写着 Anthropic、型号却是 glm-4.6，挂错家的判断会拦它
      const g = guessKind(m.base_url);
      const kind = m.provider !== "anthropic" ? g : g === "custom" || g === "ollama" ? "anthropic" : g;
      // 条目上记的格式跟这类渠道的默认对不上（本地部署说的是 Ollama 原生 / Responses），新建渠道时带上它
      const api = m.provider !== protoOfKind(kind) ? m.provider : "";
      const key = chanKeyOf(kind, m);
      prov = byKey.get(key);
      // 条目上带着 Key、这家的行却还空着：那就是同一个渠道的「还没填」状态，把 Key 填给它。
      // 不这么干就会分叉出第二行——用户看到两张一模一样的卡片，填的 Key 在新那行上、
      // 模型还挂在旧那行上，于是卡片照样写着「未填 Key」。这是首次开箱向导写 Key 的必经之路。
      if (!prov && String(m.api_key || "").trim()) {
        const shell = shellFor(kind, m.base_url);
        if (shell) {
          byKey.delete(chanKeyOf(shell.kind, shell));
          shell.api_key = String(m.api_key).trim();
          byKey.set(chanKeyOf(shell.kind, shell), shell);
          prov = shell;
        }
      }
      if (!prov) {
        prov = {
          id: uniqueId(kind, ids),
          name: nameForKind(kind, m.base_url),
          kind,
          base_url: String(m.base_url || "").trim() || baseOfKind(kind),
          api_key: String(m.api_key || "").trim(),
          ...(api ? { api } : {}),
        };
        ids.add(prov.id);
        providers.push(prov);
        byKey.set(key, prov);
      }
    }
    if (!prov) { delete m.channel; continue; } // 还没配过的条目：留着，别硬塞一个渠道给它
    m.channel = prov.id;
    // 压平：地址、Key、协议照旧写在模型条目上，下游那十来处读扁平字段的代码完全无感。
    // 地址过一遍 baseForUse：通义那家的对话在兼容层、画图在原生层，渠道只存一个地址，用时换对的那个
    m.base_url = baseForUse(prov.base_url, "chat", prov.kind);
    m.api_key = prov.api_key;
    m.provider = protoOfChannel(prov);
  }

  config.providers = providers;
  config.models = models;
  return JSON.stringify([config.providers, config.models]) !== before;
}

/** 某个渠道底下挂了哪些对话模型——界面折叠卡和「删渠道会连带删几个」都读它 */
function modelsOf(config, channelId) {
  const id = String(channelId || "").trim();
  if (!id) return [];
  return (Array.isArray(config.models) ? config.models : []).filter((m) => m && String(m.channel || "") === id);
}

/**
 * 渠道「测一下」拿哪个型号、用哪把 Key、发去哪儿。纯函数：不联网、不读盘，server.js 那条路由照着发。
 *
 * 两条规矩，护的都是「存着的 Key 只用在用户配过的地方」：
 *   1. 型号只认这条渠道底下已登记的。点名的不在列表里就报错，没点名就拿列表第一个。
 *      以前列表空着会退到精选目录的第一条——那是用户从没配过的型号，拿他的 Key 去打；
 *      打出来的 404 还会让人以为 Key 坏了。
 *   2. 用存着的那把 Key 时，地址、渠道类型、协议都得是存着的那一套。要换地址就连 Key 一起重填：
 *      存着的 Key 跟着一个改过的地址走，等于把它送到了一个没人核对过的门口。
 *
 *   3. 看名字是生图 / 视频 / 配音的型号（qwen-image、wan2.2-t2v…）不拿来发对话请求：
 *      挂错在对话列表里也一样。上游对它回的 400 只会让人以为 Key 或地址坏了。
 *
 * 返回 { known, kind, base, api, key, model, skipped } 或 { error }。
 * model 为空 = 这条渠道底下一个能发对话的模型都没有，走不走媒体清单那条不花钱的测活由调用方定；
 * skipped = 因为看名字是媒体型号而没挑的（点名的那个、或列表里的），调用方拿它走清单测活。
 * @param {any} config
 * @param {any} body
 */
function testPlan(config, body) {
  const b = body || {};
  const provs = Array.isArray(config && config.providers) ? config.providers : [];
  const known = (b.id != null && provs.find((p) => p && p.id === b.id)) || {};
  const kind = String(b.kind || known.kind || "").trim();
  const base = String(b.base_url == null ? known.base_url || "" : b.base_url).trim();
  const api = b.api == null ? known.api : b.api;
  // 掩码原样传回来时用库里那把真的：界面上 Key 框平时是空的（只显示末四位），
  // 没重填就点「测一下」是最常见的一次点击，这时候不该测成「Key 为空」
  const rawKey = String(b.api_key == null ? "" : b.api_key).trim();
  const stored = !rawKey || /^\*+$/.test(rawKey);
  const key = stored ? String(known.api_key || "") : rawKey;
  if (stored && key) {
    const same = (/** @type {any} */ x, /** @type {any} */ y) => trimEndpoint(x) === trimEndpoint(y);
    if (!same(base, known.base_url) || !same(kind, known.kind) || (b.api != null && !same(b.api, known.api)))
      return { error: "改了地址或类型就要重新填 Key 再测：存着的 Key 只发往原来那家" };
  }
  const mine = modelsOf(config || {}, known.id).map((m) => String(m.model || "").trim()).filter(Boolean);
  const want = String(b.model || "").trim();
  if (want && !mine.includes(want)) return { error: "「" + want.slice(0, 60) + "」没登记在这条渠道下。先到 设置 → 模型 加上再测" };
  const talk = mine.filter((id) => !mediaCapOf(id));
  const skipped = (want ? [want] : mine).filter((id) => !!mediaCapOf(id));
  return { known, kind, base, api, key, model: want ? (skipped.length ? "" : want) : talk[0] || "", skipped };
}

module.exports = {
  normalize, modelsOf, testPlan, chanKeyOf, nameForKind, wantsChannel,
  pruneSeededPresets, SEEDED_PRESETS, templates, planTemplate, planCustom, trimEndpoint, commitTemplate, legacyRows, isLocalBase,
};
