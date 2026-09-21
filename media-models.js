/**
 * 图像 / 视频 / 语音 / 视觉 / 转写这五路模型的「多模型 + 共用 Key」层。
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

/** 五路能力的中文名，报错和界面共用一套说法 */
const CAP_CN = { image: "图像模型", video: "视频模型", tts: "语音模型", vision: "视觉模型", asr: "转写模型" };
// asr 排在 tts 后面：新加的一路挂在最后，老配置文件的字段顺序不会因为升级而整体重排。
const CAPS = ["vision", "image", "video", "tts", "asr"];

/**
 * 渠道类型。kind 决定三件事：接口地址长什么样、目录里有哪些模型、协议按哪家走。
 * 视频那一路的协议判断见下面的 videoProtoOf——认 kind，认不出才退回按地址猜。
 */
const PROVIDER_KINDS = [
  { kind: "ark", label: "火山方舟（豆包 / 即梦 / Seedance）", base_url: "https://ark.cn-beijing.volces.com/api/v3", key_url: "https://console.volcengine.com/ark" },
  { kind: "dashscope", label: "阿里云百炼（通义 / 万相 / Qwen-TTS）", base_url: "https://dashscope.aliyuncs.com/api/v1", key_url: "https://bailian.console.aliyun.com/" },
  { kind: "openai", label: "OpenAI 官方", base_url: "https://api.openai.com/v1", key_url: "https://platform.openai.com/api-keys" },
  { kind: "openrouter", label: "OpenRouter（聚合，一把 Key 通吃）", base_url: "https://openrouter.ai/api/v1", key_url: "https://openrouter.ai/keys" },
  { kind: "siliconflow", label: "硅基流动 SiliconFlow", base_url: "https://api.siliconflow.cn/v1", key_url: "https://cloud.siliconflow.cn/account/ak" },
  { kind: "zhipu", label: "智谱 GLM / CogView / CogVideo", base_url: "https://open.bigmodel.cn/api/paas/v4", key_url: "https://bigmodel.cn/usercenter/apikeys" },
  // media_only 是 chat_only 的反面：海螺的对话接口路径是 /text/chatcompletion_v2，不是 /chat/completions，
  // 这个地址挂对话模型必然 404。它在这儿只为视频那一路存在，所以别让它出现在对话渠道的下拉里。
  { kind: "minimax", label: "MiniMax 海螺（Hailuo 视频）", base_url: "https://api.minimax.chat/v1", key_url: "https://platform.minimaxi.com/user-center/basic-information/interface-key", media_only: true },
  { kind: "anthropic", label: "Anthropic Claude 官方", base_url: "", key_url: "https://console.anthropic.com/settings/keys", chat_only: true },
  { kind: "deepseek", label: "DeepSeek 官方", base_url: "https://api.deepseek.com/v1", key_url: "https://platform.deepseek.com/api_keys", chat_only: true },
  { kind: "moonshot", label: "Kimi（月之暗面）", base_url: "https://api.moonshot.cn/v1", key_url: "https://platform.moonshot.cn/console/api-keys", chat_only: true },
  { kind: "ollama", label: "Ollama 本地（不要 Key）", base_url: "http://localhost:11434/v1", key_url: "https://ollama.com/download" },
  // decide_only 是第三种「偏科」：Jev 既不聊天也不画图，它只做判断——给它一段状态和一道有类型的题，
  // 回一个选项 / 分数 / 概率，外加一个「我有多确定」。它的接口路径是 /v1/systemone，
  // 拿 /chat/completions 打它会被 400 顶回来（上游原话：is a decisions model）。
  // 所以对话和媒体两个下拉里都不该出现它，理由跟 chat_only / media_only 完全一样。
  { kind: "typesafe", label: "TypeSafe Jev（判断模型，不产文字）", base_url: "https://api.typesafe.ai/v1", key_url: "https://console.typesafe.ai/settings/keys", decide_only: true },
  // relay：这两类是**中转**，后面接的是谁只有用户自己知道，所以别家的原始型号名在这儿是合法的
  // （new-api 正是按型号名路由到上游渠道的）。其余每一类都只认自己家的型号名，见下面的 brandOf / mismatch。
  { kind: "newapi", label: "new-api / one-api 自建网关", base_url: "", key_url: "", relay: true },
  // 名字里带「OpenAI 兼容」是给用户看的：vLLM / LM Studio / one-api 这些自建的、
  // 内网里的网关都走这一条。它跟别的渠道类型不一样的地方是**地址和型号都得自己填**——
  // 没有默认地址可补，模型清单也只能现问它自己（见 chat-models.js 的 customTemplate）。
  { kind: "custom", label: "OpenAI 兼容（自定义）", base_url: "", key_url: "", relay: true },
];

/**
 * 这个渠道走哪家协议。渠道这一层定协议，不是模型那一层——一个接口地址只可能说一种话。
 * 老配置里协议记在模型条目上（config.models[i].provider），迁移时按这条规则收上来。
 *
 * 第二个参数是渠道行上手写的 protocol：自建网关后面接的是谁，从 kind 上看不出来
 * （custom 的地址长得跟谁都一样），所以留一个地方能直说「我这台后面接的是 Claude」。
 * 只在值合法时才认——写错一个词就把整条渠道换了协议太危险，宁可退回按 kind 的老规矩。
 */
const PROTOCOLS = ["openai", "anthropic"];
function protoOfKind(kind, protocol) {
  const p = String(protocol || "").trim().toLowerCase();
  if (PROTOCOLS.includes(p)) return p;
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
    { kind: "ollama", id: "qwen3:8b", label: "Qwen3 8B（本地跑，不花钱 · 约 5GB）" },
    { kind: "ollama", id: "qwen3:14b", label: "Qwen3 14B（本地跑，更聪明 · 约 9GB）" },
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
  // 文生和图生分开摆。名字里的 t2v / i2v 不是装饰：图生的型号只给文字就会在上游失败，
  // 而视频是按条计费的异步任务，那一趟钱和几分钟全白扔。generate_video 会在发请求之前
  // 按名字把这两种对不上的组合拦下来，所以这里必须把标签写清楚，让人选之前就知道差别。
  video: [
    { kind: "ark", id: "doubao-seedance-1-0-pro-250528", label: "Seedance 1.0 Pro（文生，画质好）" },
    { kind: "ark", id: "doubao-seedance-1-0-lite-t2v-250428", label: "Seedance 1.0 Lite（文生，快且便宜）" },
    { kind: "ark", id: "doubao-seedance-1-0-pro-i2v-250528", label: "Seedance 1.0 Pro 图生视频（要首帧图）" },
    { kind: "ark", id: "doubao-seedance-1-0-lite-i2v-250428", label: "Seedance 1.0 Lite 图生视频（要首帧图）" },
    { kind: "dashscope", id: "wan2.2-t2v-plus", label: "通义万相 2.2 文生视频 Plus" },
    { kind: "dashscope", id: "wanx2.1-t2v-turbo", label: "通义万相 2.1 Turbo（快）" },
    { kind: "dashscope", id: "wan2.2-i2v-plus", label: "通义万相 2.2 图生视频 Plus（要首帧图）" },
    { kind: "dashscope", id: "wanx2.1-kf2v-plus", label: "通义万相 2.1 首尾帧生视频（要首尾两张图）" },
    { kind: "zhipu", id: "cogvideox-3", label: "智谱 CogVideoX-3（文生、图生都收，能出声）" },
    { kind: "zhipu", id: "cogvideox-flash", label: "智谱 CogVideoX Flash（免费档，出得快）" },
    { kind: "minimax", id: "MiniMax-Hailuo-02", label: "海螺 02（文生、图生都收，运镜好）" },
    { kind: "minimax", id: "T2V-01-Director", label: "海螺 T2V-01 导演版（文生，提示词里能写运镜）" },
    { kind: "minimax", id: "I2V-01-live", label: "海螺 I2V-01 live 图生视频（要首帧图，适合二次元）" },
    { kind: "siliconflow", id: "Wan-AI/Wan2.2-T2V-A14B", label: "硅基流动 · 万相 2.2 文生视频" },
    { kind: "siliconflow", id: "Wan-AI/Wan2.2-I2V-A14B", label: "硅基流动 · 万相 2.2 图生视频（要首帧图）" },
  ],
  // 转写这一路只收「说 OpenAI 兼容 /audio/transcriptions 这门话」的型号。
  // 通义百炼的 ASR 是另一套：先上传文件、再轮询异步任务，和这里的一次 multipart 完全不同协议。
  // 没实现就不往目录里摆——摆上去等于让人选一个必然报错的选项。
  asr: [
    { kind: "openai", id: "gpt-4o-transcribe", label: "GPT-4o Transcribe（最准）" },
    { kind: "openai", id: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe（快且便宜）" },
    { kind: "openai", id: "whisper-1", label: "Whisper（老牌，便宜）" },
    { kind: "siliconflow", id: "FunAudioLLM/SenseVoiceSmall", label: "SenseVoice Small（中文快，开源）" },
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
  // asr 必须排在 tts 前面判：SenseVoice 带 voice、speech-to-text 带 speech，
  // 按 tts 先判的话这两个转写模型会被当成配音模型，配好了一调就报「接口 404」。
  // 这里不写光秃秃的 asr / stt：它们太短，any 型号名里蹭上三个字母就会误伤，所以钉在分隔符上。
  asr: /(whisper|sensevoice|paraformer|transcrib|(^|[-_/])asr([-_/.\d]|$)|speech-?to-?text|(^|[-_/])stt([-_/.\d]|$))/i,
  tts: /(tts|speech|voice|cosyvoice|audio-?gen|sambert)/i,
  vision: /(vl|vision|gpt-[45]|claude|gemini|glm-4v|omni|seed-1|multimodal)/i,
};
function guessCap(modelId) {
  const s = String(modelId || "");
  for (const cap of ["video", "image", "asr", "tts"]) if (CAP_HINT[cap].test(s)) return cap;
  return CAP_HINT.vision.test(s) ? "vision" : "";
}

const MODAL = (v) => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : null);

/**
 * 一个模型是哪一路的：先听渠道自己怎么说，它没说才按名字猜。
 *
 * 名字是一层很薄的伪装。拿 OpenRouter 当天那 446 个型号实测：真能接图的有 263 个，
 * 按名字只认得出 134 个——用户自己配的那条 z-ai/glm-5.3-flash 名字里一个 vl / vision
 * 都没有，于是「看图」那张卡的下拉里把它扔进了「其它模型」；另一头 gpt-5-image、
 * gemini-3-pro-image 这些**出图**的，名字里带 image，照样在看图的下拉里排着队等人选。
 *
 * 选中一个出图的拿去看图，
 * 上游要么报一串看不懂的参数错，要么真去画了一张图再超时，界面上只剩「卡住」。
 *
 * 好在 /models 这一层越来越多家会报 architecture.input_modalities / output_modalities
 * （OpenRouter、new-api、one-api 都透传）。那是渠道自己说的，比猜准，也比我们维护
 * 一张永远追不上的型号表准。报了就信它，`sure: true`；没报就退回 guessCap，`sure: false`。
 *
 * 出图 / 出视频的一律先认「产出」那一路：gemini-3-pro-image 既能接图也能出图，
 * 可把它配在「看图」上是纯纯的浪费和卡顿，它的正业是画图。
 */
function capOfModel(raw) {
  const id = typeof raw === "string" ? raw : String((raw && (raw.id || raw.name)) || "");
  const a = (raw && typeof raw === "object" && raw.architecture) || (raw && typeof raw === "object" ? raw : {});
  const inp = MODAL(a.input_modalities) || MODAL(a.input_modality);
  const out = MODAL(a.output_modalities) || MODAL(a.output_modality);
  const guess = { cap: guessCap(id), sure: false };
  if (!out || !out.length) return guess;
  if (out.includes("video")) return { cap: "video", sure: true };
  if (out.includes("image")) return { cap: "image", sure: true };
  if (out.includes("audio")) return { cap: "tts", sure: true };
  if (!inp || !inp.length) return guess;
  if (inp.includes("audio")) return { cap: "asr", sure: true };
  if (inp.includes("image")) return { cap: "vision", sure: true };
  // 进出都只有文字：这条**确定**哪一路都不是。说死了才拦得住 gpt-5.x-codex 混进看图那一组
  return { cap: "", sure: true };
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
  if (/minimax/.test(b)) return "minimax";
  if (/api\.openai\.com/.test(b)) return "openai";
  if (/api\.anthropic\.com/.test(b)) return "anthropic";
  if (/deepseek\.com/.test(b)) return "deepseek";
  if (/moonshot\.cn/.test(b)) return "moonshot";
  if (/typesafe\.ai/.test(b)) return "typesafe";
  if (/(localhost|127\.0\.0\.1):11434/.test(b)) return "ollama";
  return "custom";
}

/**
 * 视频这一路，这条渠道说的是哪门话。
 *
 * 聊天有 OpenAI 兼容这个最大公约数，视频没有：五家的路径、字段名、轮询方式、结果取法
 * 没一处对得上，只能一家一条分支。所以先得知道是哪家。判断顺序是有讲究的——
 *   ① 渠道卡片上选的「渠道类型」：用户自己指的，最准，也是唯一能覆盖前两条的口子；
 *   ② 接口地址里的域名：直连官方的人什么都不用配，开箱就对；
 *   ③ 模型条目上手写的 protocol：中转和自建网关（国内用的人是多数）地址里什么都看不出来，
 *      得留一个地方能直说「我这台后面接的是万相」。
 * 三条都认不出就返回 ""，由调用方把支持的几家摆出来——而不是闷头发一个必然失败的请求，
 * 视频是按条计费的异步任务，白发一趟要等好几分钟才看得到错。
 */
const VIDEO_PROTOS = ["dashscope", "ark", "zhipu", "minimax", "siliconflow"];
const VIDEO_PROTO_CN = {
  dashscope: "阿里云百炼 · 通义万相",
  ark: "火山方舟 · Seedance",
  zhipu: "智谱 · CogVideoX",
  minimax: "MiniMax · 海螺 Hailuo",
  siliconflow: "硅基流动 SiliconFlow",
};
function videoProtoOf(cfg) {
  const c = cfg || {};
  const kind = String(c.kind || "").trim().toLowerCase();
  if (VIDEO_PROTOS.includes(kind)) return kind;
  const b = String(c.base_url || "").toLowerCase();
  if (/dashscope/.test(b)) return "dashscope";
  // `\/ark\b` 那半截不能省：自建网关常把上游挂在 /ark 这样的路径下（https://gw.mycorp.com/ark/api/v3），
  // 只认 ark. 域名的话这类地址会掉到「认不出」，而它以前是认得的
  if (/volces|\/ark\b|ark\./.test(b)) return "ark";
  if (/bigmodel|zhipu/.test(b)) return "zhipu";
  if (/minimax/.test(b)) return "minimax";
  if (/siliconflow/.test(b)) return "siliconflow";
  const hint = String(c.protocol || c.video_protocol || "").trim().toLowerCase();
  return VIDEO_PROTOS.includes(hint) ? hint : "";
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
    // 手写的协议只在「跟这个 kind 的默认协议不一样」时才留在配置里。custom 底下写一个
    // openai 是句废话，留着反倒会让「同一个地址、同一把 Key、两种协议」这个判据看不出差别
    const proto = String(p.protocol || "").trim().toLowerCase();
    if (PROTOCOLS.includes(proto) && proto !== protoOfKind(p.kind)) p.protocol = proto;
    else delete p.protocol;
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
  // 分组里带上协议：同一个地址、同一把 Key，一个说 OpenAI 一个说 Anthropic，是两条渠道。
  // 不带的话它们会被并成一行，其中一半模型就会按错的协议去打（表现是「某几个模型一用就 400」）
  const groupOf = (p) => `${p.kind} ${protoOfKind(p.kind, p.protocol)} ${baseForUse(String(p.base_url || "").trim(), "media").replace(/\/+$/, "").toLowerCase()}`;
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
  const before = JSON.stringify([config.providers || null, config.media_models || null, config.media || null, !!config.media_migrated]);
  const providers = Array.isArray(config.providers) ? config.providers.filter((p) => p && typeof p === "object") : [];
  const models = Array.isArray(config.media_models) ? config.media_models.filter((m) => m && typeof m === "object") : [];
  const ids = normalizeProviders(providers);
  config.providers = providers;
  if (dedupeProviders(config)) providers.splice(0, providers.length, ...config.providers);
  config.providers = providers;
  const byKey = new Map(providers.map((p) => [providerKeyOf(p), p]));

  /**
   * 老的 config.media[cap] 那份扁平配置：找/建渠道，再建一条模型条目。
   *
   * 这是**一次性的搬家**，搬完在 config 上盖个戳，以后再也不做。
   * 以前没有这个戳，每存一次就重跑一遍迁移，于是跟下面 flatten 里那条「别把手填的地址
   * 抹掉」的兜底凑成了一个死循环：
   *   用户在设置里把「看图」那一路删光 → flatten 看见 media_models 里没有 vision 了，
   *   就把上一版的 config.media.vision 原样留着（那份里还带着模型名）
   *   → 下一轮 normalize 走到这儿，看见 config.media.vision 有地址有模型，
   *     就又给他建回一条 vision 模型。
   * 用户看到的就是「我删除所有的然后又马上出现两个」，而且删几次回几次。
   *
   * 所以：迁移只认「从老版本升上来的第一次」，之后用户删成空就是空。别再把这个戳去掉。
   */
  // 没盖过戳、但 media_models 里已经有行了的，也算搬完了——这张表只可能是 normalize 自己
  // 建出来的，而 normalize 一次就把五路全搬了。不认这一条的话，老用户升上来的**第一次保存**
  // 还会再被咬一口：他这一次提交的正是「把看图删光」，而 config.media.vision 里的旧值还在。
  const migrated = config.media_migrated || (Array.isArray(config.media_models) && config.media_models.length > 0);
  const legacy = migrated ? {} : (config.media || {});
  config.media_migrated = true;
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
  const kept = [];
  for (const m of models) {
    m.cap = CAPS.includes(m.cap) ? m.cap : "image";
    m.model = String(m.model || "").trim();
    m.name = String(m.name || "").trim() || m.model;
    m.voice = String(m.voice || "").trim();
    // 渠道没了，挂在它下面的模型跟着没——设置页删渠道时就是这么承诺的（「挂在它下面的 N 个媒体模型也会一起删掉」）。
    // 以前是改挂到第一个渠道上：那等于拿另一家的 Key 去调这家的型号，必然 401，人还找不出是谁改的
    if (!providers.some((p) => p.id === m.provider)) {
      console.warn(`[媒体模型] ${CAP_CN[m.cap] || m.cap}「${m.name}」引用的渠道「${m.provider || "（空）"}」已不存在，这条一并去掉`);
      continue;
    }
    m.id = m.id && !mids.has(String(m.id)) ? String(m.id) : uniqueId(`${m.cap}-${m.name}`, mids);
    mids.add(m.id);
    kept.push(m);
  }
  models.splice(0, models.length, ...kept);
  // 挂错家的型号先挪回去，再选默认——顺序不能反：默认那条正是压平进 config.media 的那条，
  // 挪之前选的话，压平下来的还是错渠道的地址，白挪一趟。
  rehomeMismatched(providers, models);
  // 每一路恰好一个默认：一个都没标就点名第一条，标了好几个就只认第一个
  for (const cap of CAPS) {
    const mine = models.filter((m) => m.cap === cap);
    const win = mine.find((m) => m.default) || mine[0];
    for (const m of mine) m.default = m === win;
  }
  config.providers = providers;
  config.media_models = models;
  config.media = flatten(providers, models, config.media);
  return JSON.stringify([config.providers, config.media_models, config.media, !!config.media_migrated]) !== before;
}

/** 把每一路的默认那条压平回老的 config.media[cap]，让 tools.js 那边完全无感 */
function flatten(providers, models, prev) {
  const out = {};
  for (const cap of CAPS) {
    const m = models.find((x) => x.cap === cap && x.default) || models.find((x) => x.cap === cap);
    const p = m ? providers.find((x) => x.id === m.provider) : null;
    // kind 跟着压平下来：视频那一路要靠它认协议（渠道卡上选的比按地址猜准），
    // 以前这里只留地址和 Key，走到 tools.js 就只剩一个地址可猜了，中转地址一律认不出
    out[cap] = m && p
      ? { base_url: baseForUse(p.base_url, "media"), api_key: p.api_key, model: m.model, kind: p.kind || "", protocol: m.protocol || "", ...(cap === "tts" ? { voice: m.voice || "" } : {}) }
      : { base_url: "", api_key: "", model: "", kind: "", protocol: "", ...(cap === "tts" ? { voice: "" } : {}) };
    // 老配置里**手填了地址、却没填模型名**的：上面那个迁移循环要求 base 和 model 都在，
    // 所以它迁不成条目，但也不该在保存时被抹掉——人下次打开 config.json 还指望地址还在。
    // 关键是最后那个条件：old 自己也必须没有模型名。带着模型名的那份绝不能留——
    // 留下来就等于用户刚在界面上删掉的模型，被 config.media 悄悄存了一份副本，
    // 下一轮迁移再把它请回来。这正是「删了又自己冒出来」的另一半。
    const old = (prev || {})[cap] || {};
    if (!out[cap].base_url && old.base_url && !String(old.model || "").trim()) out[cap] = { ...out[cap], ...old };
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
      base_url: baseForUse(p.base_url || "", "media"), api_key: p.api_key || "", kind: p.kind || "", protocol: m.protocol || "",
      provider: m.provider, default: !!m.default,
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

/**
 * ────────── 「型号是哪家的」──────────
 *
 * 这一段是拿真实事故换来的。用户在 设置 → 视觉模型 的下拉框里选了「豆包 Seed 1.6」，
 * 选的时候当前渠道是 OpenRouter，于是配置落成了：
 *     base_url = openrouter.ai/api/v1 , model = doubao-seed-1-6-250615
 * OpenRouter 的型号名一律是 `厂商/型号`，它那儿根本没有这个 id，每次看图都回一句
 * 400 "not a valid model ID"。用户看到的是「我下拉框里选的模型，怎么用不了」——
 * 他没做错任何事，是下拉框把别家的型号摆在了这条渠道下面。
 *
 * 所以要有一个能回答「这个型号名是哪家的」的函数，三处都要用它：
 *   · 下拉框：非中转渠道就别再摆别家的型号（app-05.js）
 *   · 存配置：挂错了当场挪回对的那条渠道（下面 normalize 里的自愈）
 *   · 真要调之前：还是错的就直接拦，不浪费一次网络往返和一次熔断计数（tools.js）
 *
 * 判断只在**有把握**的时候给答案，拿不准一律回空串——宁可漏判，不可误判：
 * 误判会把用户手填的、本来能跑的型号从他选的渠道上硬挪走，那比原来的 bug 更气人。
 */

/** 中转网关：后面接谁只有用户知道，别家的型号名在这儿合法，一概不判 */
const RELAY_KINDS = new Set(PROVIDER_KINDS.filter((k) => k.relay).map((k) => k.kind));

/**
 * 认不出目录的时候按名字认门第。只放**各家自己的前缀**，不放通用词
 * （比如不能写 /vision/：那是能力不是厂商，谁家都有）。
 */
const BRAND_HINTS = [
  ["^(doubao|seedream|seedance|skylark)", "ark"],
  ["^(qwen[0-9-]|qwen-|qwq-|wan[0-9x]|wanx)", "dashscope"],
  ["^(gpt-|dall-e|o[134]-mini|whisper-1|tts-1|text-embedding-)", "openai"],
  ["^(glm-|cogview|cogvideo)", "zhipu"],
  ["^claude-", "anthropic"],
  ["^deepseek-(chat|reasoner)$", "deepseek"],
  ["^(kimi-|moonshot-v)", "moonshot"],
  ["^(minimax-|abab[0-9]|[ti]2v-0)", "minimax"],
];

/** 目录里这个 id 属于哪个 kind；同一个 id 被两家用（这种确实有）就算认不出 */
function brandInCatalog(modelId) {
  const id = String(modelId || "").trim().toLowerCase();
  if (!id) return "";
  const kinds = new Set();
  for (const cap of Object.keys(CATALOG)) {
    for (const m of CATALOG[cap]) if (String(m.id).toLowerCase() === id) kinds.add(m.kind);
  }
  return kinds.size === 1 ? [...kinds][0] : "";
}

/**
 * 方舟给自己上架的每个型号都盖一个 `-YYMMDD` 的日期尾巴，别家一个都不这么写
 * （精选目录里方舟 17 个型号 17 个带，其余十家 79 个一个不带）。
 * 它又是个**转售别家型号**的平台：目录里 `deepseek-v3-250324`、`kimi-k2-250711`
 * 挂的就是 ark。所以尾巴比前缀可信——光看 `glm-` 前缀会把方舟上架的
 * `glm-5-3-flash-260828` 判成智谱家的，再被 rehomeMismatched 从用户填对的
 * 方舟渠道上挪走，而那个型号在方舟上是真能调通的（实测 200）。
 */
function arkDated(id) {
  const m = /-(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!m) return false;
  const mo = +m[2], d = +m[3];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

/**
 * 这个型号名是哪家的。认不出回空串。
 * 带冒号的（qwen3:14b）是 Ollama 的本地 tag，名字随便起，一律不认。
 */
function brandOf(modelId) {
  const id = String(modelId || "").trim();
  if (!id || id.includes(":")) return "";
  const hit = brandInCatalog(id);
  if (hit) return hit;
  // 带斜杠的是 `厂商/型号` 这种命名法，OpenRouter 和硅基流动都这么写，光看名字分不出是哪边的
  if (id.includes("/")) return "";
  // 日期尾巴排在前缀之前：方舟转售的别家型号，前缀是原厂的，上架的却是方舟
  if (arkDated(id)) return "ark";
  for (const [src, kind] of BRAND_HINTS) if (new RegExp(src, "i").test(id)) return kind;
  return "";
}

/**
 * 这个型号挂在这类渠道上是不是挂错了。挂错了就回**它本该在的那类渠道**，没挂错回空串。
 * ollama 一并放过：本地跑的模型名是用户自己 pull 的，叫什么都算数。
 */
function mismatch(kind, modelId) {
  const k = String(kind || "").trim();
  if (!k || k === "ollama" || RELAY_KINDS.has(k)) return "";
  const brand = brandOf(modelId);
  return brand && brand !== k ? brand : "";
}

/** 渠道类型的中文名，报错里用得着 */
function kindLabel(kind) {
  return (PROVIDER_KINDS.find((k) => k.kind === kind) || {}).label || kind || "（未知渠道）";
}

/**
 * 挂错渠道的模型，能挪就挪回去。
 *
 * 只往**已经存在的**同家渠道上挪，绝不新建渠道——新建出来的必然是没有 Key 的空壳，
 * 同家有好几条时优先挑填了 Key 的那条（空壳挪过去等于换一种方式失败）。
 * 一条都没有就只留一句警告：这时候只有用户自己知道该去哪儿开号。
 * 返回真正挪动过的条目，调用方拿去写日志 / 回给前端。
 */
function rehomeMismatched(providers, models) {
  const moved = [];
  for (const m of models) {
    const p = providers.find((x) => x.id === m.provider);
    const want = mismatch(p && p.kind, m.model);
    if (!want) continue;
    const alt = providers.filter((x) => x.kind === want);
    const fix = alt.find((x) => String(x.api_key || "").trim()) || alt[0];
    const what = `${CAP_CN[m.cap] || m.cap}「${m.name}」的型号 ${m.model} 是${kindLabel(want)}家的`;
    if (fix) {
      moved.push({ cap: m.cap, name: m.name, model: m.model, from: m.provider, to: fix.id, want });
      m.provider = fix.id;
      console.warn(`[媒体模型] ${what}，却挂在${kindLabel(p && p.kind)}那条渠道上（调过去必然报「型号不存在」），已改挂到「${fix.name}」`);
    } else {
      console.warn(`[媒体模型] ${what}，却挂在${kindLabel(p && p.kind)}那条渠道上，调过去必然报「型号不存在」；本机没有${kindLabel(want)}的渠道，去 设置 → 模型 里加一条，或者换一个这条渠道上有的型号`);
    }
  }
  return moved;
}

module.exports = {
  CAPS, CAP_CN, PROVIDER_KINDS, CATALOG, PROTOCOLS,
  guessCap, capOfModel, guessKind, baseOfKind, catalogFor, protoOfKind, videoProtoOf, VIDEO_PROTOS, VIDEO_PROTO_CN,
  providerKeyOf, uniqueId, normalizeProviders, baseForUse, dedupeProviders,
  normalize, flatten, resolve, pick, MediaPickError,
  RELAY_KINDS, BRAND_HINTS, brandOf, brandInCatalog, arkDated, mismatch, kindLabel, rehomeMismatched,
};
