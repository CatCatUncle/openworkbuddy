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
  PROVIDER_KINDS, guessKind, baseOfKind, protoOfKind,
  providerKeyOf, uniqueId, normalizeProviders, baseForUse, dedupeProviders,
} = require("./media-models");

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
 * 没地址、没 Key、也不是 Anthropic 协议的条目是「还没配过」——初始 config 里那一排
 * 预置渠道就长这样。给它们建渠道只会凭空多出一堆空壳，界面上还得一个个提示「未填 Key」。
 */
function wantsChannel(m) {
  return !!String(m.base_url || "").trim() || m.provider === "anthropic";
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
    m.provider = protoOfKind(prov.kind);
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

module.exports = { normalize, modelsOf, chanKeyOf, nameForKind, wantsChannel };
