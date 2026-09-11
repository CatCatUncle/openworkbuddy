/**
 * 图像 / 视频 / 语音 / 视觉这四路模型的「多模型 + 共用 Key」层。
 *
 * 老配置长这样，一路只能配一个模型，而且 Key 要一路填一遍：
 *   config.media = { image: {base_url, api_key, model}, video: {...}, tts: {...}, vision: {...} }
 * 可现实是：一把 OpenRouter 的 Key 能同时喂图、视频、视觉；一把火山方舟的 Key 也是。
 * 同一把 Key 抄四遍，换 Key 的时候就得记着改四处——漏一处，某一路就在半年后突然 401。
 *
 * 所以拆成两张表：
 *   config.providers    = [{ id, name, kind, base_url, api_key }]      一把 Key 一行
 *   config.media_models = [{ id, cap, name, provider, model, voice }]  一个模型一行，只引用渠道，不抄 Key
 * 再把「每一路当前默认是谁」压平回 config.media[cap]，于是 tools.js / agent.js 那边一行都不用改，
 * 老配置也照跑——升级不需要用户做任何事。
 */

/** 四路能力的中文名，报错和界面共用一套说法 */
const CAP_CN = { image: "图像模型", video: "视频模型", tts: "语音模型", vision: "视觉模型" };
const CAPS = ["vision", "image", "video", "tts"];

/**
 * 渠道类型。kind 决定三件事：接口地址长什么样、目录里有哪些模型、协议按哪家走。
 * 协议的最终判断仍在 tools.js 里按 base_url 认（dashscope / ark），这里只管配置和目录。
 */
const PROVIDER_KINDS = [
  { kind: "ark", label: "火山方舟（豆包 / 即梦 / Seedance）", base_url: "https://ark.cn-beijing.volces.com/api/v3", key_url: "https://console.volcengine.com/ark" },
  { kind: "dashscope", label: "阿里云百炼（通义 / 万相 / Qwen-TTS）", base_url: "https://dashscope.aliyuncs.com/api/v1", key_url: "https://bailian.console.aliyun.com/" },
  { kind: "openai", label: "OpenAI 官方", base_url: "https://api.openai.com/v1", key_url: "https://platform.openai.com/api-keys" },
  { kind: "openrouter", label: "OpenRouter（聚合，一把 Key 通吃）", base_url: "https://openrouter.ai/api/v1", key_url: "https://openrouter.ai/keys" },
  { kind: "siliconflow", label: "硅基流动 SiliconFlow", base_url: "https://api.siliconflow.cn/v1", key_url: "https://cloud.siliconflow.cn/account/ak" },
  { kind: "zhipu", label: "智谱 GLM / CogView / CogVideo", base_url: "https://open.bigmodel.cn/api/paas/v4", key_url: "https://bigmodel.cn/usercenter/apikeys" },
  { kind: "newapi", label: "new-api / one-api 自建网关", base_url: "", key_url: "" },
  { kind: "custom", label: "其它 OpenAI 兼容接口", base_url: "", key_url: "" },
];

/**
 * 精选模型目录：下拉框里排在最前面那一段。
 *
 * 只放「这套协议确认跑得通」的型号，不追求穷举——穷举也追不上各家发版的速度。
 * 下拉框是三段式：精选目录 → 从渠道 /models 现拉的活列表 → 「自己填…」。
 * 目录过时了不至于挡路，活列表拉不到也不至于抓瞎。
 */
const CATALOG = {
  vision: [
    { kind: "ark", id: "doubao-seed-1-6-250615", label: "豆包 Seed 1.6（看图 + 推理）" },
    { kind: "ark", id: "doubao-1-5-vision-pro-250328", label: "豆包 1.5 Vision Pro" },
    { kind: "dashscope", id: "qwen-vl-max", label: "通义千问 VL Max" },
    { kind: "dashscope", id: "qwen-vl-plus", label: "通义千问 VL Plus（便宜）" },
    { kind: "openai", id: "gpt-5.2", label: "GPT-5.2" },
    { kind: "openai", id: "gpt-5-mini", label: "GPT-5 mini（便宜）" },
    { kind: "openrouter", id: "openai/gpt-5.2", label: "GPT-5.2（走 OpenRouter）" },
    { kind: "openrouter", id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5（走 OpenRouter）" },
    { kind: "openrouter", id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash（便宜）" },
    { kind: "zhipu", id: "glm-4v-plus", label: "GLM-4V Plus" },
    { kind: "siliconflow", id: "Qwen/Qwen2.5-VL-72B-Instruct", label: "Qwen2.5-VL 72B" },
  ],
  image: [
    { kind: "ark", id: "doubao-seedream-4-0-250828", label: "即梦 Seedream 4.0（中文标题写得对）" },
    { kind: "ark", id: "doubao-seedream-3-0-t2i-250415", label: "即梦 Seedream 3.0" },
    { kind: "dashscope", id: "qwen-image", label: "通义千问 Image（中文海报）" },
    { kind: "dashscope", id: "wan2.2-t2i-flash", label: "通义万相 2.2 极速版" },
    { kind: "dashscope", id: "wanx2.1-t2i-turbo", label: "通义万相 2.1 Turbo" },
    { kind: "openai", id: "gpt-image-1", label: "GPT Image 1" },
    { kind: "openai", id: "dall-e-3", label: "DALL-E 3" },
    { kind: "zhipu", id: "cogview-4", label: "智谱 CogView-4" },
    { kind: "siliconflow", id: "Kwai-Kolors/Kolors", label: "可图 Kolors" },
  ],
  video: [
    { kind: "ark", id: "doubao-seedance-1-0-pro-250528", label: "Seedance 1.0 Pro（画质好）" },
    { kind: "ark", id: "doubao-seedance-1-0-lite-t2v-250428", label: "Seedance 1.0 Lite（快且便宜）" },
    { kind: "dashscope", id: "wan2.2-t2v-plus", label: "通义万相 2.2 文生视频 Plus" },
    { kind: "dashscope", id: "wanx2.1-t2v-turbo", label: "通义万相 2.1 Turbo（快）" },
  ],
  tts: [
    { kind: "dashscope", id: "qwen3-tts-flash", label: "通义 Qwen3-TTS Flash（中文自然）", voices: ["Cherry", "Serena", "Ethan", "Chelsie"] },
    { kind: "dashscope", id: "qwen-tts", label: "通义 Qwen-TTS", voices: ["Cherry", "Serena", "Ethan", "Chelsie"] },
    { kind: "openai", id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS（能听指令调语气）", voices: ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] },
    { kind: "openai", id: "tts-1-hd", label: "OpenAI TTS-1 HD", voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] },
    { kind: "openai", id: "tts-1", label: "OpenAI TTS-1（快）", voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] },
    { kind: "siliconflow", id: "FunAudioLLM/CosyVoice2-0.5B", label: "CosyVoice2（开源音色克隆）" },
  ],
};

/** 从活列表里猜一个模型是哪一路的——各家 /models 都是混着返回的，只能按名字认 */
const CAP_HINT = {
  image: /(image|seedream|dall-?e|cogview|kolors|flux|sd3|stable-?diffusion|wanx?[\d.]+-t2i|midjourney)/i,
  video: /(video|seedance|t2v|i2v|sora|kling|hailuo|veo)/i,
  tts: /(tts|speech|voice|cosyvoice|audio-?gen|sambert)/i,
  vision: /(vl|vision|gpt-[45]|claude|gemini|glm-4v|omni|seed-1|multimodal)/i,
};
function guessCap(modelId) {
  const s = String(modelId || "");
  for (const cap of ["video", "image", "tts"]) if (CAP_HINT[cap].test(s)) return cap;
  return CAP_HINT.vision.test(s) ? "vision" : "";
}

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** 在一堆已有 id 里挑一个不撞的。撞了就 -2 -3 往后排，不用随机数——配置文件 diff 起来好看 */
function uniqueId(base, taken) {
  const b = slug(base) || "x";
  if (!taken.has(b)) return b;
  for (let i = 2; ; i++) if (!taken.has(`${b}-${i}`)) return `${b}-${i}`;
}

/** 按 base_url + api_key 认渠道：同一把 Key 同一个地址就是同一个渠道，不重复建 */
function providerKeyOf(p) {
  return `${String(p.base_url || "").trim().replace(/\/+$/, "").toLowerCase()} ${String(p.api_key || "").trim()}`;
}

/** 从接口地址猜渠道类型，给迁移和「粘个地址就建渠道」用 */
function guessKind(baseUrl) {
  const b = String(baseUrl || "").toLowerCase();
  if (/ark\.|volces\.com/.test(b)) return "ark";
  if (/dashscope/.test(b)) return "dashscope";
  if (/openrouter/.test(b)) return "openrouter";
  if (/siliconflow/.test(b)) return "siliconflow";
  if (/bigmodel\.cn/.test(b)) return "zhipu";
  if (/api\.openai\.com/.test(b)) return "openai";
  return "custom";
}

/** 渠道类型对应的默认接口地址（迁移时补空用） */
function baseOfKind(kind) {
  const k = PROVIDER_KINDS.find((p) => p.kind === kind);
  return k ? k.base_url : "";
}

/**
 * 把配置规整成两张表，幂等——跑一百遍结果一样。
 *
 * 老配置（一路一个模型、Key 抄四份）进来，出去就是 providers + media_models；
 * 已经是新结构的原样保留，只补 id、补默认项、把引用不存在渠道的那条挂回去。
 * 返回 true 表示真改了东西（调用方据此决定要不要落盘）。
 */
function normalize(config) {
  const before = JSON.stringify([config.providers || null, config.media_models || null, config.media || null]);
  const providers = Array.isArray(config.providers) ? config.providers.filter((p) => p && typeof p === "object") : [];
  const models = Array.isArray(config.media_models) ? config.media_models.filter((m) => m && typeof m === "object") : [];
  const ids = new Set();
  for (const p of providers) {
    p.name = String(p.name || "").trim() || "未命名渠道";
    p.kind = PROVIDER_KINDS.some((k) => k.kind === p.kind) ? p.kind : guessKind(p.base_url);
    p.base_url = String(p.base_url || "").trim() || baseOfKind(p.kind);
    p.api_key = String(p.api_key || "").trim();
    p.id = p.id && !ids.has(String(p.id)) ? String(p.id) : uniqueId(p.name || p.kind, ids);
    ids.add(p.id);
  }
  const byKey = new Map(providers.map((p) => [providerKeyOf(p), p]));

  // 老的 config.media[cap] 那份扁平配置：找/建渠道，再建一条模型条目
  const legacy = config.media || {};
  for (const cap of CAPS) {
    const old = legacy[cap] || {};
    const base = String(old.base_url || "").trim();
    const model = String(old.model || "").trim();
    if (!base || !model) continue;
    if (models.some((m) => m.cap === cap && String(m.model).trim() === model)) continue; // 迁过了
    const key = providerKeyOf(old);
    let prov = byKey.get(key);
    if (!prov) {
      const kind = guessKind(base);
      prov = {
        id: uniqueId(kind, ids),
        name: (PROVIDER_KINDS.find((k) => k.kind === kind) || {}).label || base,
        kind, base_url: base, api_key: String(old.api_key || "").trim(),
      };
      ids.add(prov.id);
      providers.push(prov);
      byKey.set(key, prov);
    }
    models.push({ cap, name: model, provider: prov.id, model, voice: String(old.voice || "").trim() });
  }

  const mids = new Set();
  for (const m of models) {
    m.cap = CAPS.includes(m.cap) ? m.cap : "image";
    m.model = String(m.model || "").trim();
    m.name = String(m.name || "").trim() || m.model;
    m.voice = String(m.voice || "").trim();
    if (!providers.some((p) => p.id === m.provider)) m.provider = providers.length ? providers[0].id : "";
    m.id = m.id && !mids.has(String(m.id)) ? String(m.id) : uniqueId(`${m.cap}-${m.name}`, mids);
    mids.add(m.id);
  }
  // 每一路恰好一个默认：一个都没标就点名第一条，标了好几个就只认第一个
  for (const cap of CAPS) {
    const mine = models.filter((m) => m.cap === cap);
    const win = mine.find((m) => m.default) || mine[0];
    for (const m of mine) m.default = m === win;
  }
  config.providers = providers;
  config.media_models = models;
  config.media = flatten(providers, models, config.media);
  return JSON.stringify([config.providers, config.media_models, config.media]) !== before;
}

/** 把每一路的默认那条压平回老的 config.media[cap]，让 tools.js 那边完全无感 */
function flatten(providers, models, prev) {
  const out = {};
  for (const cap of CAPS) {
    const m = models.find((x) => x.cap === cap && x.default) || models.find((x) => x.cap === cap);
    const p = m ? providers.find((x) => x.id === m.provider) : null;
    out[cap] = m && p
      ? { base_url: p.base_url, api_key: p.api_key, model: m.model, ...(cap === "tts" ? { voice: m.voice || "" } : {}) }
      : { base_url: "", api_key: "", model: "", ...(cap === "tts" ? { voice: "" } : {}) };
    // 老配置里手填了地址却没填模型名的，迁不成条目也别在保存时给人抹掉
    const old = (prev || {})[cap] || {};
    if (!out[cap].base_url && old.base_url) out[cap] = { ...out[cap], ...old };
  }
  return out;
}

/**
 * 给 agent / 工具用的解析结果：四路的默认配置 + 一张「还能选谁」的清单。
 * 清单里带着 Key，只在进程内流转，绝不回给前端（前端那份走 /api/settings，Key 另算）。
 */
function resolve(config) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const models = Array.isArray(config.media_models) ? config.media_models : [];
  const list = models.map((m) => {
    const p = providers.find((x) => x.id === m.provider) || {};
    return {
      id: m.id, cap: m.cap, name: m.name, model: m.model, voice: m.voice || "",
      base_url: p.base_url || "", api_key: p.api_key || "", provider: m.provider, default: !!m.default,
    };
  });
  return { ...(config.media || {}), list };
}

/** 挑不到就报错并把可选项列出来——绝不悄悄退回默认那条（用户点名要哪个就是哪个） */
class MediaPickError extends Error {}

/**
 * 按能力挑一条配置。want 空就用默认那条；给了名字就按「名称 → 模型 id」两轮找。
 * 找不到直接抛，错误里带上全部可选项，agent 下一轮自己就能改对。
 */
function pick(media, cap, want) {
  const list = ((media || {}).list || []).filter((m) => m.cap === cap);
  const w = String(want || "").trim();
  if (!w) return (media || {})[cap] || {};
  const low = w.toLowerCase();
  const hit = list.find((m) => m.name.toLowerCase() === low) || list.find((m) => m.model.toLowerCase() === low);
  if (hit) return hit;
  const names = list.map((m) => (m.name === m.model ? m.name : `${m.name}（${m.model}）`));
  throw new MediaPickError(
    `没有叫「${w}」的${CAP_CN[cap] || cap}。` +
    (names.length
      ? `现在能用的是：${names.join(" / ")}。照着名字再叫一次，或者不写 model 用默认那个。`
      : `一个都没配，请先去 设置 → 模型 配置${CAP_CN[cap] || cap}。`)
  );
}

/** 界面上给某个渠道列候选模型：精选目录里属于这个 kind 的那些 */
function catalogFor(cap, kind) {
  return (CATALOG[cap] || []).filter((m) => !kind || m.kind === kind);
}

module.exports = {
  CAPS, CAP_CN, PROVIDER_KINDS, CATALOG,
  guessCap, guessKind, baseOfKind, catalogFor,
  normalize, flatten, resolve, pick, MediaPickError,
};
