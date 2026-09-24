// @ts-check
"use strict";
/**
 * 一次调用到底花了多少钱——模型价目表。
 *
 * 为什么要有这个模块：在它之前，计费是 account.js 里那一行
 *
 *     credits = ceil((prompt - cached*0.9 + completion) / 1000)
 *
 * 也就是**所有模型一个价**。可 Opus 的输出价是 GPT-5 nano 的一百多倍。同样 10 万 token，
 * 账面上是同一个数，真实账单差两个数量级。管理员拿这个数做的任何判断都是错的：
 * 「这个月谁花得多」排出来的是「谁的字数多」，不是「谁花的钱多」——而这两件事经常是反的
 * （一个人用便宜模型跑了十万字，另一个人用 Opus 问了三句）。
 *
 * ── 三个决定，以及为什么这么定 ────────────────────────────────────
 *
 * 1) **单位是「元 / 百万 token」，直接写钱，不用倍率。**
 *    one-api / new-api 那套是「模型倍率 × 补全倍率」，基准 $0.002/1K。抄它很省事，
 *    但有两处受不了：① 看到「倍率 2.5」得在脑子里乘一遍才知道多少钱，而各家官网价目页
 *    印的就是「每百万 token 多少元」，写成同一个形状才能一眼比对、抄错了也一眼看得出来；
 *    ② 基准一改，所有模型的钱**一起**变——那是个没人会去想、改了也不会有人发现的地雷。
 *
 * 2) **缓存命中单独一格价，不是拍脑袋打个折。**
 *    这套东西的真实账本里 prompt:completion ≈ 64:1 —— agent 每走一步要把整段上下文重发，
 *    所以「这一大坨有没有命中缓存」几乎决定了整张账单。各家给的折扣也不一样
 *    （Anthropic cache read 0.1x，OpenAI cached input 0.5x，DeepSeek 命中价单独列），
 *    统一按一个比例折，等于把最大的那一项算错。
 *
 * 3) **认不出的型号不算 0 元，算「不知道」。** 这条最要紧。
 *    一个没登记价目的模型，如果按 0 元入账，账面永远是对的、跟真实账单永远对不上，
 *    而且**一个字都不报**。one-api 的「默认倍率兜底」是另一种形状的同一个毛病：
 *    它给个统一价，于是你以为你在计费，其实你在编数。
 *    这里认不出就把这一笔标成 unknown，后台单列一张「这些型号还没有价目」催人去填；
 *    额度闸门按「记账但不扣」处理——不能因为我们不认识这个型号就把人拦在门外。
 *
 * ── 价钱从哪儿来，四层，后面的盖前面的 ──────────────────────────────
 *
 *     ① 内置表（下面这张，抄于 PRICES_AS_OF）
 *     ② 管理员在后台手填的（存 config.prices，跟着 config.json 走）
 *     ③ 渠道上的覆盖（config.providers[i].prices）——同一个 deepseek-chat，
 *        官网一个价、走 OpenRouter 一个价、走公司自建网关又一个价
 *     ④ 组织折扣（org settings.price_discount，0.85 = 谈下来 85 折）
 *
 * 内置这张表**一定会过期**——各家一年调好几次价。所以它不是权威，只是个能立刻开张的
 * 起点：日期写在 PRICES_AS_OF 上，后台那一页把它印出来，改过的条目标「已由管理员修改」。
 * 过期的价目比没有价目更危险，所以宁可把「这是哪天抄的」摆在脸上。
 */

/**
 * 一行 token 价目，单位 元/百万 token。cached_in 不写 = 这家没有缓存价。
 * @typedef {{ in: number, out: number, cached_in?: number, note?: string }} PriceRow
 */
/**
 * 一行按量价目，单位看 UNITS[cap].unit。
 * @typedef {{ price: number, note?: string }} UnitRow
 */
/**
 * 四层合并后的表：table 是价目，from 记每个键是哪一层给的（builtin / admin / channel）。
 * @template R
 * @typedef {{ table: Record<string, R>, from: Record<string, string> }} Merged
 */
/**
 * 查价 / 算钱共用的选项。config 就是 config.json，provider 是其中一条渠道。
 * _merged 是调用方已经合并好的表，一次算一大批时省得每笔都重合并。
 * @typedef {object} PriceOpts
 * @property {any} [config]
 * @property {any} [provider]
 * @property {number|string} [discount] 组织折扣，(0,1] 之外按不打折算
 * @property {boolean} [local] 明说走的是本地引擎，直接 0 元
 * @property {Merged<any>} [_merged]
 */
/**
 * 查到的那一行价。src 是哪一层给的，key 是最后命中的那个型号名（可能是退化后的）。
 * @template R
 * @typedef {{ row: R, key: string, src: string }} PriceHit
 */

/** 内置价目是哪天抄的。后台会把这个日期印出来——「三个月前抄的」本身就是一条信息 */
const PRICES_AS_OF = "2026-09-17";

/**
 * 美元价换算成人民币用的汇率。
 *
 * 为什么不按模型各自的币种存：存两种币种，就要在**每一处**求和的地方处理两种币种——
 * 后台的「本月一共花了多少」、额度闸门、账单导出，漏一处就是一个悄悄错掉的合计。
 * 统一折成元，汇率就这一个常量，看得见、改得动、也能在测试里钉住。
 * 代价是汇率波动会让历史账目有几个点的偏差——对「谁花得多」「有没有超预算」这两个
 * 真正的用途来说，几个点不影响结论；真要跟供应商对美元账单，用的是人家的账单，不是这儿。
 */
const USD_CNY = 7.1;
const $ = (usd) => Math.round(usd * USD_CNY * 1e4) / 1e4;

/**
 * 内置价目表：型号 → { in, out, cached_in }，单位 元/百万 token。
 *
 * cached_in 留空 = 这家没有缓存价，命中也按 in 收（别默认打折，那是在替供应商编价钱）。
 * 注释里写的是官网原价，方便下次对着改：改的时候盯注释，不盯换算出来的数。
 */
const BUILTIN = {
  // ── Anthropic（官网美元价，cache read 是 in 的 0.1 倍）──
  "claude-opus-5":           { in: $(15),   out: $(75),  cached_in: $(1.5)  },  // $15 / $75 / $1.50
  "claude-sonnet-5":         { in: $(3),    out: $(15),  cached_in: $(0.3)  },  // $3 / $15 / $0.30
  "claude-haiku-4-5":        { in: $(1),    out: $(5),   cached_in: $(0.1)  },  // $1 / $5 / $0.10
  // ── OpenAI（官网美元价，cached input 约 in 的 0.1~0.5 倍，各型号不同）──
  "gpt-5.2":                 { in: $(1.25), out: $(10),  cached_in: $(0.125) }, // $1.25 / $10 / $0.125
  "gpt-5-mini":              { in: $(0.25), out: $(2),   cached_in: $(0.025) }, // $0.25 / $2 / $0.025
  "gpt-5-nano":              { in: $(0.05), out: $(0.4), cached_in: $(0.005) }, // $0.05 / $0.40 / $0.005
  "gpt-4.1":                 { in: $(2),    out: $(8),   cached_in: $(0.5)  },  // $2 / $8 / $0.50
  "gpt-4o":                  { in: $(2.5),  out: $(10),  cached_in: $(1.25) },  // $2.50 / $10 / $1.25
  "o4-mini":                 { in: $(1.1),  out: $(4.4), cached_in: $(0.275) }, // $1.10 / $4.40 / $0.275
  // ── 国内厂商，官网就是人民币价，不过汇率这一道 ──
  "deepseek-chat":           { in: 2,    out: 8,    cached_in: 0.5 },
  "deepseek-reasoner":       { in: 4,    out: 16,   cached_in: 1 },
  "doubao-seed-1-6":         { in: 0.8,  out: 8 },
  "doubao-seed-1-6-flash":   { in: 0.15, out: 1.5 },
  "doubao-1-5-pro-32k":      { in: 0.8,  out: 2 },
  "doubao-1-5-pro-256k":     { in: 5,    out: 9 },
  "moonshotai/kimi-k2":      { in: 4,    out: 16 },
  "kimi-k2":                 { in: 4,    out: 16 },
  "glm-4.6":                 { in: 2,    out: 8 },
  "qwen3-max":               { in: 6,    out: 24 },
  // ── 向量化：只有输入，没有输出。out 写 0 是「确实不收」，不是「不知道」──
  // （只放官网价目页上直接查得到的那几条；国内几家的嵌入价这两年改过好几次，
  //   记不准就不写，让它走 unknown 去被后台催一句，比填一个错数强）
  "text-embedding-3-small":  { in: $(0.02), out: 0 },                            // $0.02 / M
  "text-embedding-3-large":  { in: $(0.13), out: 0 },                            // $0.13 / M
  "text-embedding-ada-002":  { in: $(0.10), out: 0 },                            // $0.10 / M
  // ── 本地模型：电费不算在这本账上，但必须**有**一条，否则会被当成「不知道」天天催人填 ──
  "__local__":               { in: 0,    out: 0, note: "本机跑的，没有 API 账单" },
};

/**
 * ── 按量计价的那五路：搜索 / 生图 / 生视频 / 语音合成 / 语音转写 ──────
 *
 * 为什么不能塞进上面那张表：它们的计量单位根本不是 token。一张图就是一张图，
 * 一条视频按秒收，念一段话按字符收，转写按音频分钟收，搜一次就是一次。
 * 硬折成 token 要先编一个换算率，而那个换算率是假的——假的换算率会让每一笔都错，
 * 还错得很体面（有小数点，看着很精确）。
 *
 * ── 三件跟上面那张表不一样的事 ─────────────────────────
 *
 * 1) **单位要跟着钱一起存。** 只存一个数字的话，0.14 到底是一张图还是一千张，
 *    过三个月谁也说不清。所以每一路有一个固定单位（见 UNITS），后台连单位一起显示，
 *    管理员改价的时候看到的是「0.14 元 / 张」，不是一个孤零零的 0.14。
 *
 * 2) **各家的计费口径不一样，这里统一折算，所以是「估」不是「账单」。**
 *    方舟按视频 token 收、万相按秒收、海螺按条收，同一条 5 秒片子三家的账单长得完全不同。
 *    折算的依据写在每一行的注释里（按哪档分辨率、按几秒估的）。要跟供应商对账，
 *    用的是人家的账单；这张表回答的是「这个月谁花得多、有没有超预算」，几个点的偏差不影响结论。
 *
 * 3) **这张表故意很短。** 只放能对上官网价目页、且计费口径说得清的那些。
 *    剩下的一律走「不知道」——跟上面那张表同一个规矩：认不出就记 unknown，
 *    后台单列一张催人去填的单子，闸门记账但不扣。编一个数填进去看着更全，
 *    代价是没人会再去改它，而它从填进去那天就是错的。
 */
const UNITS = {
  search: { unit: "次",    cn: "联网搜索" },
  image:  { unit: "张",    cn: "生成图片" },
  video:  { unit: "秒",    cn: "生成视频" },
  tts:    { unit: "千字符", cn: "语音合成" },
  asr:    { unit: "分钟",  cn: "语音转写" },
};
const UNIT_CAPS = Object.keys(UNITS);

/**
 * 内置按量价目：cap → { 型号/引擎 → 元每单位 }。跟上面那张表同一天抄的（PRICES_AS_OF）。
 * 注释里写的是官网原价和折算依据——改价的时候盯注释，不盯换算出来的那个数。
 */
const BUILTIN_UNIT = {
  search: {
    // 按次计费的三家。免费兜底那两条也必须**有**一行，否则每次退到 DuckDuckGo
    // 都会被记成「不知道多少钱」，后台那张催填单子上天天挂着两个永远填不上的名字。
    // 国内几家：下面这些数字是照各家公开报价记的，没有一条是我逐项核过官网的——
    // 改价的时候先去对一遍再动，别把这几行当成已经核实过的账
    "bocha":      { price: 0.036, note: "博查公开价约 ￥0.036/次，未逐条核过官网" },
    "zhipu":      { price: 0.03, note: "智谱 Web Search，按公开档位估，未逐条核过官网" },
    "qiniu":      { price: 0.02, note: "七牛云按 Token 计，这里按一次搜索粗估，未核" },
    "serper":     { price: $(0.002), note: "Serper 约 $2 / 1000 次，未逐条核过官网" },
    "custom":     { price: 0, note: "自建/自定义接口，按你自己的合同算，这里不猜" },
    "tavily":     { price: $(0.008) },                                  // $0.008 / 次
    "brave":      { price: $(0.005) },                                  // $5 / 1000 次
    "jina":       { price: 0.02, note: "Jina 按 token 收，这里按一次搜索约 1 万 token 折算" },
    "duckduckgo": { price: 0, note: "免费兜底，不产生账单" },
    "baidu":      { price: 0, note: "免费兜底，不产生账单" },
  },
  image: {
    "dall-e-3":                { price: $(0.04) },                      // $0.040 / 张（1024 标准档）
    "gpt-image-1":             { price: $(0.04), note: "按 1024×1024 中等质量档折算，高清档更贵" },
    "wanx2.1-t2i-turbo":       { price: 0.14 },                         // 万相 turbo 0.14 元/张
    "wanx2.1-t2i-plus":        { price: 0.20 },                         // 万相 plus 0.20 元/张
    "cogview-4":               { price: 0.06 },                         // 智谱 0.06 元/张
    "doubao-seedream-3-0-t2i": { price: 0.259 },                        // 方舟 0.259 元/张
    "black-forest-labs/flux.1-schnell": { price: 0.0037 },              // 硅基流动 0.0037 元/张
  },
  // 视频的量是**实际出片的秒数**：tools.js unitsFor 按 media-models.js videoPlan 夹紧之后的秒数给，
  // 不是人要的秒数（万相 2.x 固定 5 秒，要 10 秒也只出 5 秒、只收 5 秒的钱）。
  // 海螺是按条收的（02 型号 6 秒 768P 一档价、10 秒 / 1080P 另一档），摊不成单一的元/秒，
  // 没核实过的价不往表里写——查不到单价的走 costOfUnits 的 unknown 标记，不当免费。
  video: {
    "wanx2.1-t2v-turbo": { price: 0.24 },                               // 万相 turbo 0.24 元/秒
    "wanx2.1-t2v-plus":  { price: 0.70 },                               // 万相 plus 0.70 元/秒
    // 方舟按「视频 token」收，不按秒。720p 5 秒一条约 10 万 token、约 1.5 元，折下来 0.3 元/秒。
    // 分辨率一变这个折算就不准了——所以注释写着依据，别看到 0.3 就以为是官网价。
    "doubao-seedance-1-0-lite-t2v": { price: 0.30, note: "方舟按视频 token 收，这里按 720p 折算" },
  },
  tts: {
    "tts-1":        { price: $(0.015) },                                // $15 / 100 万字符
    "tts-1-hd":     { price: $(0.03) },                                 // $30 / 100 万字符
    "cosyvoice-v1": { price: 0.2 },                                     // 百炼 2 元/万字符
    "cosyvoice-v2": { price: 0.2 },
  },
  asr: {
    "whisper-1":              { price: $(0.006) },                      // $0.006 / 分钟
    "gpt-4o-transcribe":      { price: $(0.006) },                      // $0.006 / 分钟
    "gpt-4o-mini-transcribe": { price: $(0.003) },                      // $0.003 / 分钟
    "paraformer-v2":          { price: 0.0048, note: "百炼按小时档收，这里按 0.288 元/小时折算" },
  },
};

/**
 * 合并四层按量价目，形状跟 tableFor 一样：{ table, from }
 * @param {string} cap search / image / video / tts / asr
 * @param {PriceOpts} [opts] 只看 config 和 provider
 * @returns {Merged<UnitRow>}
 */
function unitTableFor(cap, { config, provider } = {}) {
  /** @type {Record<string, UnitRow>} */
  const table = Object.create(null);
  /** @type {Record<string, string>} */
  const from = Object.create(null);
  /** @param {string} src @param {Record<string, unknown>|undefined} rows */
  const put = (src, rows) => {
    for (const [k, v] of Object.entries(rows || {})) {
      const row = normalizeUnitRow(v);
      if (!row) continue;
      const key = String(k).trim().toLowerCase();
      table[key] = row;
      from[key] = src;
    }
  };
  put("builtin", BUILTIN_UNIT[cap]);
  if (config && config.unit_prices) put("admin", config.unit_prices[cap]);
  if (provider && provider.unit_prices) put("channel", provider.unit_prices[cap]);
  return { table, from };
}

/**
 * 一行按量价目拍干净。0 是合法的（免费兜底那两条），负数和 NaN 当没填过。
 * 允许直接写一个数字（后台表单里填的就是一个数），也允许写 { price, note }。
 * @param {any} v
 * @returns {UnitRow|null}
 */
function normalizeUnitRow(v) {
  const raw = v && typeof v === "object" ? v.price : v;
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (!Number.isFinite(n) || n < 0) return null;
  /** @type {UnitRow} */
  const row = { price: n };
  if (v && typeof v === "object" && v.note) row.note = String(v.note).slice(0, 80);
  return row;
}

/**
 * 查一路按量价。跟 priceOf 同一套退化匹配（去聚合商前缀、去日期后缀、最长前缀族），
 * 理由也一样：各家几乎每月发一个带日期的新 id，要求精确登记的结果是这张表天天在报警。
 * @param {string} cap
 * @param {unknown} model
 * @param {PriceOpts} [opts]
 * @returns {PriceHit<UnitRow>|null} null = 不知道，不是 0
 */
function unitPriceOf(cap, model, opts = {}) {
  if (!UNITS[cap]) return null;
  const { table, from } = opts._merged || unitTableFor(cap, opts);
  for (const c of candidates(model)) {
    if (table[c]) return { row: table[c], key: c, src: from[c] };
  }
  const m = String(model || "").trim().toLowerCase();
  const tail = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
  let best = null;
  for (const k of Object.keys(table)) {
    if (k.length >= 4 && tail.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? { row: table[best], key: best, src: from[best] } : null;
}

/**
 * 按量算钱。
 *
 * @param {{ cap?: string, model?: string, units?: number|string }} [call]
 *   units 的含义由 UNITS[cap].unit 定（张 / 秒 / 千字符 / 分钟 / 次）
 * @param {PriceOpts} [opts] 看 config / provider / discount
 * @returns {{ yuan: number, unknown: boolean, cap: string, unit: string, per: number,
 *   units: number, model: string, key: string, src: string, discount: number }}
 *
 * units 允许是小数：3.4 秒的视频、0.62 千字符的一段话，四舍五入到整数会系统性地多收或少收。
 */
function costOfUnits(call = {}, opts = {}) {
  const cap = String(call.cap || "").trim();
  const meta = UNITS[cap];
  const units = Math.max(0, +call.units || 0);
  const base = {
    cap, unit: meta ? meta.unit : "", units,
    model: String(call.model || ""), per: 0, key: "", src: "", discount: 1,
  };
  if (!meta) return { ...base, yuan: 0, unknown: true };
  const hit = unitPriceOf(cap, call.model, opts);
  if (!hit) return { ...base, yuan: 0, unknown: true };
  const d = discountOf(opts.discount);
  return {
    ...base, yuan: r6(hit.row.price * units * d), unknown: false,
    per: hit.row.price, key: hit.key, src: hit.src, discount: d,
  };
}

/** 本地引擎那几条：命中就是 0 元，而且是「确实 0」，不是「不知道」 */
const LOCAL_RE = /^(ollama|lmstudio|local|llama|qwen2?\.?5?-?coder|__local__)/i;

/**
 * 把型号名收敛成能查表的样子，从最精确往最模糊退，一步一步：
 *
 *   ① 原样                                  claude-sonnet-5
 *   ② 去掉聚合商前缀                         anthropic/claude-sonnet-5 → claude-sonnet-5
 *   ③ 去掉版本日期后缀                        doubao-seed-1-6-250615   → doubao-seed-1-6
 *                                           claude-haiku-4-5-20251001 → claude-haiku-4-5
 *   ④ 去掉上下文长度后缀                      moonshot-v1-8k           → moonshot-v1
 *   ⑤ 最长前缀族匹配                          gpt-4o-2024-11-20        → gpt-4o
 *
 * 为什么要退这么多步而不是要求精确登记：各家几乎每月发一个带日期的新 id，
 * 要求精确登记的结果就是「每次上游发版，这边全变成不知道」——于是这张表天天在报警，
 * 报到没人看为止。退化匹配的代价是可能拿老型号的价算新型号，差个一两成；
 * 而报警疲劳的代价是整套计费没人信。两害相权。
 * @param {unknown} model
 * @returns {string[]}
 */
function candidates(model) {
  const m = String(model || "").trim().toLowerCase();
  if (!m) return [];
  const out = [m];
  /** @param {string} x */
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };
  const slash = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : "";
  push(slash);
  for (const base of [m, slash].filter(Boolean)) {
    push(base.replace(/-(?:\d{6}|\d{8}|\d{4}-\d{2}-\d{2})$/, ""));       // -250615 / -20251001 / -2024-11-20
    push(base.replace(/-\d+k$/, ""));                                     // -8k / -128k
    push(base.replace(/-(?:latest|preview|exp|beta)$/, ""));
  }
  return out;
}

/**
 * 合并四层价目，返回 { table, from } —— from 记着每个型号的价是哪一层给的，后台要显示
 * @param {PriceOpts} [opts] 只看 config 和 provider
 * @returns {Merged<PriceRow>}
 */
function tableFor({ config, provider } = {}) {
  /** @type {Record<string, PriceRow>} */
  const table = Object.create(null);
  /** @type {Record<string, string>} */
  const from = Object.create(null);
  /** @param {string} src @param {Record<string, any>|undefined} rows */
  const put = (src, rows) => {
    for (const [k, v] of Object.entries(rows || {})) {
      if (!v || typeof v !== "object") continue;
      const row = normalizeRow(v);
      if (!row) continue;
      table[String(k).trim().toLowerCase()] = row;
      from[String(k).trim().toLowerCase()] = src;
    }
  };
  put("builtin", BUILTIN);
  if (config && config.prices) put("admin", config.prices);
  if (provider && provider.prices) put("channel", provider.prices);
  return { table, from };
}

/**
 * 一行价目拍干净：三格都得是非负有限数，负价和 NaN 一律当没填过
 * @param {any} v
 * @returns {PriceRow|null}
 */
function normalizeRow(v) {
  /** @param {any} x @returns {number|null} */
  const num = (x) => {
    const n = typeof x === "string" ? parseFloat(x) : x;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const i = num(v.in), o = num(v.out);
  if (i === null && o === null) return null;
  /** @type {PriceRow} */
  const row = { in: i === null ? 0 : i, out: o === null ? 0 : o };
  const c = num(v.cached_in);
  if (c !== null) row.cached_in = c;
  if (v.note) row.note = String(v.note).slice(0, 80);
  return row;
}

/**
 * 查一个型号的价。返回 { row, key, src } 或者 null（= 不知道，不是 0）。
 * @param {unknown} model
 * @param {PriceOpts} [opts]
 * @returns {PriceHit<PriceRow>|null}
 */
function priceOf(model, opts = {}) {
  const { table, from } = opts._merged || tableFor(opts);
  if (LOCAL_RE.test(String(model || "")) || opts.local) {
    return { row: { in: 0, out: 0 }, key: "__local__", src: "local" };
  }
  for (const c of candidates(model)) {
    if (table[c]) return { row: table[c], key: c, src: from[c] };
  }
  // 最后一步：最长前缀族。gpt-4o-audio-preview → gpt-4o
  const m = String(model || "").trim().toLowerCase();
  const tail = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
  let best = null;
  for (const k of Object.keys(table)) {
    if (k.length >= 4 && tail.startsWith(k) && (!best || k.length > best.length)) best = k;
  }
  return best ? { row: table[best], key: best, src: from[best] } : null;
}

/**
 * 算钱。
 *
 * @param {{ model?: string, prompt?: number, cached?: number, completion?: number }} [usage]
 *   跟 account.js 的 chargeRun 同一个形状
 * @param {PriceOpts} [opts] 看 config / provider / discount / local
 * @returns {{ yuan: number, unknown: boolean, model: string, key: string, src: string,
 *   detail: { in_yuan: number, cached_yuan: number, out_yuan: number }, discount: number }}
 *
 * yuan 保留 6 位小数：单次调用常常是几厘钱，四舍五入到分的话，一万次调用里
 * 每次丢掉的不到半分钱加起来就是一大笔——而且是系统性地少算，不是随机误差。
 */
function costOf(usage = {}, opts = {}) {
  const prompt = Math.max(0, +usage.prompt || 0);
  const cached = Math.min(Math.max(0, +usage.cached || 0), prompt);
  const fresh = prompt - cached;
  const completion = Math.max(0, +usage.completion || 0);
  const hit = priceOf(usage.model, opts);
  if (!hit) {
    return { yuan: 0, unknown: true, model: usage.model || "", key: "", src: "",
             detail: { in_yuan: 0, cached_yuan: 0, out_yuan: 0 }, discount: 1 };
  }
  const p = hit.row;
  // 没给缓存价就按原价收。这里**不**替供应商打折：猜低了账就永远对不上，
  // 而对不上的方向是「我们以为便宜」，最坏的那个方向。
  const cin = typeof p.cached_in === "number" ? p.cached_in : p.in;
  const d = discountOf(opts.discount);
  /** @param {number} tok @param {number} price */
  const per = (tok, price) => (tok / 1e6) * price;
  const detail = {
    in_yuan: r6(per(fresh, p.in) * d),
    cached_yuan: r6(per(cached, cin) * d),
    out_yuan: r6(per(completion, p.out) * d),
  };
  return {
    yuan: r6(detail.in_yuan + detail.cached_yuan + detail.out_yuan),
    unknown: false, model: usage.model || "", key: hit.key, src: hit.src, detail, discount: d,
  };
}

/**
 * 折扣夹在 (0,1] 里。填 0 或者负数不是「全免」，是填错了——那种时候按不打折算，宁可多收
 * @param {any} x 数字或后台表单里填的字符串
 * @returns {number}
 */
function discountOf(x) {
  const n = typeof x === "string" ? parseFloat(x) : x;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1;
}

/** 保留 6 位小数，单次调用常常只有几厘钱 @param {number} n @returns {number} */
function r6(n) { return Math.round((n + Number.EPSILON) * 1e6) / 1e6; }

/**
 * 给人看的一个数。
 *
 * 单独显示一个数（ref 不传）：几厘钱的用「分」，别的用「元」——0.000123 元没人读得懂。
 *
 * 一句话里要拿几个数互相比（ref 传那一组里**最小的那个非零值**）：一律用元，
 * 小数位数按最小的那个定，最多 4 位。两条都是踩出来的：
 *   · 各自挑单位 → 「上限 0.010 分，已用 0.011 元」，两个数各自都对，
 *     摆在一起读起来却像已用比上限小。
 *   · 按最大的那个定位数 → 「上限 100.00 元，已用 99.99 元，这一趟还要 0.00 元」，
 *     那个 0.00 是把这句话唯一的重点四舍五入没了。
 * @param {unknown} n
 * @param {unknown} [ref]
 * @returns {string}
 */
function yuanText(n, ref) {
  const v = Math.abs(+n || 0);
  if (ref !== undefined) {
    const s = Math.abs(+ref || 0) || v || 1;
    const dp = Math.max(2, Math.min(4, Math.ceil(-Math.log10(s)) + 1));
    return `${v.toFixed(dp)} 元`;
  }
  if (v === 0) return "0 元";
  if (v < 0.01) return `${(v * 100).toFixed(3)} 分`;
  if (v < 1) return `${v.toFixed(3)} 元`;
  if (v < 1000) return `${v.toFixed(2)} 元`;
  return `${v.toFixed(0)} 元`;
}

/**
 * 后台那一页：把内置表 + 管理员改过的合成一张，标出每条是哪来的。
 * 再把「这个月真出现过、但查不到价」的型号列出来——这张单子就是待办事项。
 * @param {{ config?: any, seen?: unknown[], seen_units?: Array<{ cap?: string, model?: string }|null> }} [opts]
 */
function catalog({ config, seen = [], seen_units = [] } = {}) {
  const { table, from } = tableFor({ config });
  const rows = Object.keys(table).sort().map((k) => ({ model: k, ...table[k], src: from[k] }));
  const missing = [...new Set(seen.map((m) => String(m || "").trim()).filter(Boolean))]
    .filter((m) => !priceOf(m, { config }))
    .sort();

  // 按量那五路：一路一张小表，外加一张「这个月真调过、但查不到价」的催填单子。
  // 跟 token 那张分开列，因为单位不一样，混在一起看只会让人把 0.14 元/张当成 0.14 元/百万。
  const units = UNIT_CAPS.map((cap) => {
    const t = unitTableFor(cap, { config });
    return {
      cap, ...UNITS[cap],
      rows: Object.keys(t.table).sort().map((k) => ({ model: k, ...t.table[k], src: t.from[k] })),
    };
  });
  const seenUnitKeys = new Set();
  const unit_missing = [];
  for (const it of seen_units) {
    const cap = String((it && it.cap) || "").trim();
    const model = String((it && it.model) || "").trim();
    if (!UNITS[cap] || !model) continue;
    const k = cap + "\u0000" + model.toLowerCase();
    if (seenUnitKeys.has(k)) continue;
    seenUnitKeys.add(k);
    if (!unitPriceOf(cap, model, { config })) unit_missing.push({ cap, model, unit: UNITS[cap].unit });
  }
  unit_missing.sort((a, b) => (a.cap + a.model).localeCompare(b.cap + b.model));

  return { as_of: PRICES_AS_OF, usd_cny: USD_CNY, rows, missing, units, unit_missing };
}

module.exports = {
  costOf, priceOf, catalog, tableFor, yuanText,
  costOfUnits, unitPriceOf, unitTableFor,
  PRICES_AS_OF, USD_CNY, BUILTIN, BUILTIN_UNIT, UNITS, UNIT_CAPS,
  _internals: { candidates, normalizeRow, normalizeUnitRow, discountOf, r6, LOCAL_RE },
};
