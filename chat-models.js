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
 *      自建网关（kind=custom）的地址长得跟谁都一样，从地址上看不出后面接的是谁，
 *      所以渠道行上可以手写一个 protocol 覆盖掉 kind 的默认协议（见 media-models.protoOfKind）。
 *   3. **同地址不同 Key 是两个渠道。** 自己的号和同事的号都指着 openrouter，那就是两行，
 *      合并会让人在不知情的情况下用别人的额度。
 */

const {
  PROVIDER_KINDS, CATALOG, guessKind, baseOfKind, protoOfKind,
  providerKeyOf, uniqueId, normalizeProviders, baseForUse, dedupeProviders,
} = require("./media-models");

/** 本机地址：Ollama / LM Studio 这类压根不要 Key，没 Key 也算配过了 */
const isLocalBase = (u) => /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(String(u || ""));
const nb = (u) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();

/**
 * 渠道的认领依据：协议 + 地址 + Key 三样都一样才是同一个渠道。
 *
 * 为什么协议也要算进去：Anthropic 官方没有接口地址（空串），只按地址认的话，
 * 它会跟所有「填了 Key 却忘了填地址」的条目并成一个渠道。
 * 自建网关可以在渠道行上手写 protocol（那台机器后面接的其实是 Claude），
 * 所以这里得按渠道行自己的协议算，不能只看 kind。
 */
function chanKeyOf(kind, row) {
  return `${protoOfKind(kind, (row || {}).protocol)} ${providerKeyOf(row)}`;
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
 * 向导里「地址和型号都得自己填」的那一类（OpenAI 兼容的自建网关 / 本机部署）。
 *
 * 它进不了 templates()：那张表有一条不成立的判据是「每家都带一个默认型号」，
 * 而自建网关上有哪些型号，只有那台机器自己知道——所以地址和型号由向导带上来，
 * 这里只给一份空的模板（kind 和名字），好让向导和 planTemplate 认得这个入口。
 */
function customTemplate() {
  const k = PROVIDER_KINDS.find((x) => x.kind === "custom");
  if (!k) return null;
  return { kind: k.kind, label: k.label, name: "", base_url: "", key_url: "", model: "", local: false, custom: true };
}

/**
 * 按模板起一条模型：先算好要建什么，**不动 config**——向导要先拿它验活，验过了再 commitTemplate 落下去。
 * 同家同地址的渠道已经有了就复用（空壳补 Key；Key 一样就是同一个号）；返回 null 表示没这家。
 *
 * 后两个参数只给自定义那一家用：预设几家的地址是官方的、型号是目录里挑的，都不由用户说了算。
 */
function planTemplate(config, kind, modelId, baseUrl) {
  const kk = String(kind || "").trim();
  const blank = customTemplate();
  const t = templates().find((x) => x.kind === kk) || (blank && blank.kind === kk ? blank : null);
  if (!t) return null;
  // 自建网关的地址是用户填的，没有就没得算。留着空地址往下走，落盘的就是一条必然 404 的渠道
  const base = String((t.custom ? baseUrl : t.base_url) || "").trim();
  if (!base) return null;
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const models = Array.isArray(config.models) ? config.models : [];
  const model = String(modelId || "").trim() || t.model;
  if (!model) return null; // 自定义那类没有默认型号：向导没点名就不算数（省得落一条模型名为空的条目）
  const prov = providers.find((p) => p.kind === t.kind && nb(p.base_url) === nb(base)) || null;
  const taken = new Set(models.map((m) => String(m.name || "")));
  // 预设的用短名（DeepSeek / Kimi）；自定义那家没有名字可用，拿域名当名字——
  // 「gw.mycorp.com」比「自定义渠道」强，一个账号下接了两台网关时也分得清
  const nm = t.custom ? nameForKind(t.kind, base) : t.name;
  const name = taken.has(nm) ? `${nm} ${model}` : nm;
  const row = { name, provider: protoOfKind(t.kind), base_url: baseForUse(base, "chat"), api_key: "", model };
  return { t, prov, row, base_url: base };
}

/** 把 planTemplate 算好的那条落进 config：渠道（带 Key）+ 模型行（挂在它下面）。返回最后那条模型行 */
function commitTemplate(config, plan, key) {
  config.providers = Array.isArray(config.providers) ? config.providers : [];
  config.models = Array.isArray(config.models) ? config.models : [];
  const k = String(key || "").trim();
  let prov = plan.prov;
  // 已有的那行填着另一把 Key：那是另一个号，另起一行，别把人家的 Key 盖掉
  if (prov && String(prov.api_key || "").trim() && k && prov.api_key !== k) prov = null;
  if (!prov) {
    const ids = new Set(config.providers.map((p) => String(p.id)));
    // 地址用算好的那份：自定义那家是用户填的，plan.t.base_url 是空串（预设那几家两者一样）
    const base = plan.base_url || plan.t.base_url;
    prov = {
      id: uniqueId(plan.t.kind, ids),
      name: plan.t.custom ? nameForKind(plan.t.kind, base) : plan.t.label,
      kind: plan.t.kind, base_url: base, api_key: k,
    };
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
  // 协议也要对上：自建网关可以在渠道行上手写协议，同一个地址下「说 OpenAI 的空壳」和
  // 「说 Anthropic 的那条」是两回事，认错了等于把 Key 填到另一条渠道上
  const shellFor = (kind, baseUrl, protocol) => providers.find(
    (p) => p.kind === kind && protoOfKind(p.kind, p.protocol) === protoOfKind(kind, protocol)
      && !String(p.api_key || "").trim() && nb(p.base_url) === nb(baseUrl || baseOfKind(kind))
  );

  for (const m of models) {
    // 老条目的协议记在自己身上，这一步之后它归渠道管；这里先归一化，好拿来认渠道
    m.provider = m.provider === "anthropic" ? "anthropic" : "openai";
    const ref = String(m.channel || "").trim();
    let prov = ref ? providers.find((p) => p.id === ref) : null;
    if (!prov && wantsChannel(m)) {
      // 协议是用户在模型条目上选的，认渠道时它说了算：填了中转地址的 Anthropic 协议
      // 也该归到「Anthropic 协议」那个渠道，而不是按域名猜成一个 OpenAI 兼容渠道
      const kind = m.provider === "anthropic" ? "anthropic" : guessKind(m.base_url);
      const key = chanKeyOf(kind, m);
      prov = byKey.get(key);
      // 条目上带着 Key、这家的行却还空着：那就是同一个渠道的「还没填」状态，把 Key 填给它。
      // 不这么干就会分叉出第二行——用户看到两张一模一样的卡片，填的 Key 在新那行上、
      // 模型还挂在旧那行上，于是卡片照样写着「未填 Key」。这是首次开箱向导写 Key 的必经之路。
      if (!prov && String(m.api_key || "").trim()) {
        const shell = shellFor(kind, m.base_url, m.protocol);
        if (shell) {
          byKey.delete(chanKeyOf(shell.kind, shell));
          shell.api_key = String(m.api_key).trim();
          byKey.set(chanKeyOf(shell.kind, shell), shell);
          prov = shell;
        }
      }
      if (!prov) {
        // 条目上万一写着协议（手改过 config.json 的人才会这么干），新建的渠道要把它带上：
        // 不带的话下面 byKey.set 用的那把 key 跟这条渠道自己的 key 对不上，下一条同家的模型又认不回来
        const proto = protoOfKind(kind, m.protocol);
        prov = {
          id: uniqueId(kind, ids),
          name: nameForKind(kind, m.base_url),
          kind,
          base_url: String(m.base_url || "").trim() || baseOfKind(kind),
          api_key: String(m.api_key || "").trim(),
          ...(proto !== protoOfKind(kind) ? { protocol: proto } : {}),
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
    m.base_url = baseForUse(prov.base_url, "chat");
    m.api_key = prov.api_key;
    m.provider = protoOfKind(prov.kind, prov.protocol);
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

module.exports = {
  normalize, modelsOf, chanKeyOf, nameForKind, wantsChannel,
  pruneSeededPresets, SEEDED_PRESETS, templates, customTemplate, planTemplate, commitTemplate, legacyRows,
};
