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
  { kind: "anthropic", label: "Anthropic Claude 官方", base_url: "", key_url: "https://console.anthropic.com/settings/keys", chat_only: true },
  { kind: "deepseek", label: "DeepSeek 官方", base_url: "https://api.deepseek.com/v1", key_url: "https://platform.deepseek.com/api_keys", chat_only: true },
  { kind: "moonshot", label: "Kimi（月之暗面）", base_url: "https://api.moonshot.cn/v1", key_url: "https://platform.moonshot.cn/console/api-keys", chat_only: true },
  { kind: "ollama", label: "Ollama 本地（不要 Key）", base_url: "http://localhost:11434/v1", key_url: "https://ollama.com/download" },
  { kind: "newapi", label: "new-api / one-api 自建网关", base_url: "", key_url: "" },
  { kind: "custom", label: "其它 OpenAI 兼容接口", base_url: "", key_url: "" },
];

/**
 * 这个渠道走哪家协议。渠道这一层定协议，不是模型那一层——一个接口地址只可能说一种话。
 * 老配置里协议记在模型条目上（config.models[i].provider），迁移时按这条规则收上来。
 */
function protoOfKind(kind) {
  return kind === "anthropic" ? "anthropic" : "openai";
}

/**
 * 精选模型目录：下拉框里排在最前面那一段。
 *
 * 只放「这套协议确认跑得通」的型号，不追求穷举——穷举也追不上各家发版的速度。
 * 下拉框是三段式：精选目录 → 从渠道 /models 现拉的活列表 → 「自己填…」。
 * 目录过时了不至于挡路，活列表拉不到也不至于抓瞎。
 *
 * chat 那一段给对话模型用（chat-models.js / 设置里的渠道卡片），其余四段给四路媒体。
 */
const CATALOG = {
  chat: [
    { kind: "anthropic", id: "claude-sonnet-5", label: "Claude Sonnet 5（写代码、干活稳）" },
    { kind: "anthropic", id: "claude-opus-5", label: "Claude Opus 5（最强，也最贵）" },
    { kind: "anthropic", id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5（快且便宜）" },
    { kind: "openai", id: "gpt-5.2", label: "GPT-5.2" },
    { kind: "openai", id: "gpt-5-mini", label: "GPT-5 mini（便宜）" },
    { kind: "openai", id: "gpt-5-nano", label: "GPT-5 nano（最便宜）" },
    { kind: "openai", id: "gpt-4.1", label: "GPT-4.1" },
    { kind: "openai", id: "gpt-4o", label: "GPT-4o" },
    { kind: "openai", id: "o4-mini", label: "o4-mini（会推理）" },
    { kind: "openrouter", id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5（走 OpenRouter）" },
    { kind: "openrouter", id: "anthropic/claude-opus-5", label: "Claude Opus 5（走 OpenRouter）" },
    { kind: "openrouter", id: "openai/gpt-5.2", label: "GPT-5.2（走 OpenRouter）" },
    { kind: "openrouter", id: "deepseek/deepseek-chat", label: "DeepSeek Chat（走 OpenRouter · 便宜）" },
    { kind: "openrouter", id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro（走 OpenRouter）" },
    { kind: "openrouter", id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash（走 OpenRouter · 便宜）" },
    { kind: "openrouter", id: "x-ai/grok-4", label: "Grok 4（走 OpenRouter）" },
    { kind: "openrouter", id: "qwen/qwen3-max", label: "通义 Qwen3 Max（走 OpenRouter）" },
    { kind: "openrouter", id: "moonshotai/kimi-k2", label: "Kimi K2（走 OpenRouter）" },
    { kind: "openrouter", id: "z-ai/glm-4.6", label: "智谱 GLM-4.6（走 OpenRouter）" },
    { kind: "ark", id: "doubao-seed-1-6-250615", label: "豆包 Seed 1.6（能看图）" },
    { kind: "ark", id: "doubao-seed-1-6-flash-250715", label: "豆包 Seed 1.6 Flash（快且便宜）" },
    { kind: "ark", id: "doubao-seed-1-6-thinking-250715", label: "豆包 Seed 1.6 Thinking（会想一会儿）" },
    { kind: "ark", id: "doubao-1-5-pro-32k-250115", label: "豆包 1.5 Pro 32K" },
    { kind: "ark", id: "doubao-1-5-pro-256k-250115", label: "豆包 1.5 Pro 256K（长文）" },
    { kind: "ark", id: "doubao-1-5-lite-32k-250115", label: "豆包 1.5 Lite 32K（最便宜）" },
    { kind: "ark", id: "deepseek-v3-250324", label: "DeepSeek V3（火山托管）" },
    { kind: "ark", id: "deepseek-r1-250528", label: "DeepSeek R1（火山托管 · 会推理）" },
    { kind: "ark", id: "kimi-k2-250711", label: "Kimi K2（火山托管）" },
    { kind: "dashscope", id: "qwen-max", label: "通义千问 Max" },
    { kind: "dashscope", id: "qwen-plus", label: "通义千问 Plus（便宜）" },
    { kind: "dashscope", id: "qwen-turbo", label: "通义千问 Turbo（最便宜）" },
    { kind: "dashscope", id: "qwen3-max", label: "通义千问 3 Max" },
    { kind: "dashscope", id: "qwen-long", label: "通义千问 Long（长文）" },
    { kind: "dashscope", id: "qwq-plus", label: "通义 QwQ Plus（会推理）" },
    { kind: "dashscope", id: "deepseek-v3", label: "DeepSeek V3（百炼托管）" },
    { kind: "deepseek", id: "deepseek-chat", label: "DeepSeek Chat" },
    { kind: "deepseek", id: "deepseek-reasoner", label: "DeepSeek Reasoner（会想一会儿）" },
    { kind: "moonshot", id: "kimi-k2-0905-preview", label: "Kimi K2" },
    { kind: "moonshot", id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo（快）" },
    { kind: "moonshot", id: "moonshot-v1-128k", label: "Moonshot v1 128K（长文）" },
    { kind: "zhipu", id: "glm-4.6", label: "智谱 GLM-4.6" },
    { kind: "zhipu", id: "glm-4.5", label: "智谱 GLM-4.5" },
    { kind: "zhipu", id: "glm-4.5-air", label: "智谱 GLM-4.5 Air（便宜）" },
    { kind: "zhipu", id: "glm-4-plus", label: "智谱 GLM-4 Plus" },
    { kind: "zhipu", id: "glm-4-flash", label: "智谱 GLM-4 Flash（便宜）" },
    { kind: "siliconflow", id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3（硅基流动）" },
    { kind: "siliconflow", id: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1（硅基流动 · 会推理）" },
    { kind: "siliconflow", id: "Qwen/Qwen3-32B", label: "Qwen3 32B（硅基流动）" },
    { kind: "siliconflow", id: "moonshotai/Kimi-K2-Instruct", label: "Kimi K2（硅基流动）" },
    { kind: "ollama", id: "qwen3:14b", label: "Qwen3 14B（本地跑，不花钱）" },
    { kind: "ollama", id: "qwen3:8b", label: "Qwen3 8B（本地跑，更省内存）" },
    { kind: "ollama", id: "deepseek-r1:14b", label: "DeepSeek R1 14B（本地跑，会推理）" },
    { kind: "ollama", id: "llama3.1:8b", label: "Llama 3.1 8B（本地跑）" },
    { kind: "ollama", id: "gemma3:12b", label: "Gemma 3 12B（本地跑）" },
  ],
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

/**
 * 通义百炼一家有两个接口地址：图像 / 视频 / 配音走原生 `/api/v1`，对话走 OpenAI 兼容层
 * `/compatible-mode/v1`。同一把 Key、同一个账号，没道理逼用户建两个渠道、把 Key 填两遍。
 *
 * 所以渠道只记一个地址，压平到模型条目时按用途换成对的那个。llm.js 算 embedding 时早就
 * 这么干了（见那边的 `/compatible-mode/v1` 改写），这里只是把同一条规矩挪到渠道这一层。
 * 别家一律原样返回——这不是通用改写，是通义一家的历史包袱。
 */
function baseForUse(baseUrl, use) {
  const b = String(baseUrl || "").trim();
  if (!/dashscope\.aliyuncs\.com/i.test(b)) return b;
  return use === "chat"
    ? b.replace(/\/api\/v\d+$/i, "/compatible-mode/v1")
    : b.replace(/\/compatible-mode\/v\d+$/i, "/api/v1");
}

/**
 * 按 base_url + api_key 认渠道：同一把 Key 同一个地址就是同一个渠道，不重复建。
 * 地址先过一遍 baseForUse 归一，于是老配置里「对话填了兼容层、画图填了原生层」的同一个
 * 通义账号会并成一个渠道，而不是两行同名卡片。
 */
function providerKeyOf(p) {
  const b = baseForUse(String(p.base_url || "").trim(), "media");
  return `${b.replace(/\/+$/, "").toLowerCase()} ${String(p.api_key || "").trim()}`;
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
  if (/api\.anthropic\.com/.test(b)) return "anthropic";
  if (/deepseek\.com/.test(b)) return "deepseek";
  if (/moonshot\.cn/.test(b)) return "moonshot";
  if (/(localhost|127\.0\.0\.1):11434/.test(b)) return "ollama";
  return "custom";
}

/** 渠道类型对应的默认接口地址（迁移时补空用） */
function baseOfKind(kind) {
  const k = PROVIDER_KINDS.find((p) => p.kind === kind);
  return k ? k.base_url : "";
}

/**
 * 把渠道行就地规整齐：补名字、认类型、补默认地址、去重 id。返回这批 id 的集合。
 *
 * 对话模型（chat-models.js）和四路媒体模型共用同一张 config.providers 表——用户填的
 * 就是一把 OpenRouter 的 Key，没道理在「模型」里填一遍、在「画图」里再填一遍。
 * 共用一张表就必须共用一套规整规矩，所以这段抽出来，两边都调它。
 */
function normalizeProviders(providers) {
  const ids = new Set();
  for (const p of providers) {
    p.name = String(p.name || "").trim() || "未命名渠道";
    p.kind = PROVIDER_KINDS.some((k) => k.kind === p.kind) ? p.kind : guessKind(p.base_url);
    p.base_url = String(p.base_url || "").trim() || baseOfKind(p.kind);
    p.api_key = String(p.api_key || "").trim();
    p.id = p.id && !ids.has(String(p.id)) ? String(p.id) : uniqueId(p.name || p.kind, ids);
    ids.add(p.id);
  }
  return ids;
}

/**
 * 渠道去重：把重复的行并成一行，被并掉的那些引用一起改指过去。
 *
 * 为什么会冒出重复行——「怎么有两个火山方舟」就是这么来的：
 * 认领渠道时把 Key 也算进了依据（providerKeyOf），这条本身没错，自己的号和同事的号
 * 指着同一个地址确实该是两行，合并了就是在不知情的情况下用别人的额度。
 * 可**空 Key 是个例外**：它不代表「另一个账号」，它代表「这家还没填」。
 * 于是首次开箱向导写下一把火山的 Key，规整时一比对「跟那行空壳不是同一个渠道」，
 * 又建了一行。用户在设置里看到两张火山卡片，而且他填的 Key 在新那行上、
 * 模型还挂在旧那行上——所以卡片照样写着「未填 Key」。
 *
 * 合并规矩（只并，不动有 Key 的行）：
 *   1. 同类型 + 同地址 + 同 Key → 同一个渠道，留先出现的那行。
 *   2. 同类型 + 同地址，一行有 Key 一行空着 → 空的那行是「还没填」，并到有 Key 的那行上。
 *   3. 同类型 + 同地址、全都空着 → 留一行，其余是重复的空壳。
 * 按类型分组而不是只按地址：newapi 和 custom 的默认地址都是空串，只按地址会把它们并成一个。
 *
 * 返回 true 表示真并掉了行。
 */
function dedupeProviders(config) {
  const providers = Array.isArray(config.providers) ? config.providers.filter((p) => p && typeof p === "object") : [];
  if (providers.length < 2) return false;
  const groupOf = (p) => `${p.kind} ${baseForUse(String(p.base_url || "").trim(), "media").replace(/\/+$/, "").toLowerCase()}`;
  const groups = new Map();
  for (const p of providers) {
    const g = groupOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const remap = new Map(); // 被并掉的 id → 留下来的 id
  const gone = new Set();
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const byKey = new Map();
    let host = null; // 这一组的落脚行：优先第一个填了 Key 的
    for (const p of rows) {
      const k = String(p.api_key || "").trim();
      if (!k) continue;
      if (byKey.has(k)) { remap.set(p.id, byKey.get(k).id); gone.add(p); continue; }
      byKey.set(k, p);
      if (!host) host = p;
    }
    const empties = rows.filter((p) => !String(p.api_key || "").trim());
    const landing = host || empties[0];
    for (const p of empties) {
      if (p === landing) continue;
      remap.set(p.id, landing.id);
      gone.add(p);
    }
  }
  if (!gone.size) return false;
  config.providers = providers.filter((p) => !gone.has(p));
  // 并了两三层（A→B、B→C）也要落到最后那个；给个上限，配置再怎么坏也别转成死循环
  const to = (id) => { let v = String(id || ""); for (let i = 0; i < 8 && remap.has(v); i++) v = remap.get(v); return v; };
  for (const m of Array.isArray(config.models) ? config.models : []) if (m && m.channel) m.channel = to(m.channel);
  for (const m of Array.isArray(config.media_models) ? config.media_models : []) if (m && m.provider) m.provider = to(m.provider);
  return true;
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
  const ids = normalizeProviders(providers);
  config.providers = providers;
  if (dedupeProviders(config)) providers.splice(0, providers.length, ...config.providers);
  config.providers = providers;
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
      ? { base_url: baseForUse(p.base_url, "media"), api_key: p.api_key, model: m.model, ...(cap === "tts" ? { voice: m.voice || "" } : {}) }
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
      base_url: baseForUse(p.base_url || "", "media"), api_key: p.api_key || "", provider: m.provider, default: !!m.default,
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
  guessCap, guessKind, baseOfKind, catalogFor, protoOfKind,
  providerKeyOf, uniqueId, normalizeProviders, baseForUse, dedupeProviders,
  normalize, flatten, resolve, pick, MediaPickError,
};
