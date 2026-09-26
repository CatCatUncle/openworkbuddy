// @ts-check
"use strict";
/**
 * 内容配方：「做一条产品宣传片」「出一组小红书图文」「一稿多投」这种反复出现的活，
 * 开工前用一张表单把岔路一次定完，之后照表单做、不再中途打断人。
 *
 * 为什么要有这一层，而不是只写一份技能说明书：
 *   ① 岔路问法会漂。说明书里写「先问时长和画幅」，模型有时问一半、有时做到第 20 步才想起来问
 *      「横版还是竖版」——人早就走开了，任务就卡在那一问上。表单是一次性、可预期的。
 *   ② 历史压缩会把「用户在第 1 步说了只要竖版」压没。答案钉进系统提示词（pinBlock），
 *      还写一份 <任务目录>/配方表单.json，续跑时从那里读回来（restore）。
 *   ③ 默认 25 步 / 30 分钟不够出一条多画幅成片。配方自带上限（applyLimits），
 *      用户用 --max-steps 明确限过的一步都不改。
 *
 * 表单规格写在代码里、不写在技能目录里：seedDataDir 对技能目录是「缺了才拷」，
 * mergeBuiltinExperts 只加不改——写在技能目录里的表单，老用户永远拿不到新版本。
 *
 * 钱的事：
 *   - 花钱的选项（AI 生视频、AI 生图、语音合成）从不当默认：只剩花钱的一条时，默认是「这次不做」，
 *     表单上写明那一条要花钱、要用就自己点。命令行流程、IM、定时任务、表单超时都按默认走，
 *     没人看见过那张表——默认落在花钱的选项上，就是没人点头就花了钱。
 *   - 预估费用查不到单价就写「单价未知」，绝不写 0 元——0 元会被当成「不花钱」。
 *   - 语音合成没配就是没配：表单上直说，不拿系统自带的朗读凑数。
 *
 * 除了 askForm（要弹窗、要写文件），这里全是纯函数，方便钉测试。
 */
const fs = require("fs");
const path = require("path");

const FORM_FILE = "配方表单.json";
/** CLI 流程和 IM 预设把填好的表单写在用户消息里：一行之内，JSON 不许折行 */
const PRESET_RE = /【配方表单已填：([a-z0-9-]+)】(\{[^\n]*\})/;
/** 配方能把上限抬到多高：再高就不是「一条内容」而是一个项目了，该拆开跑 */
const HARD = { steps: 500, runtimeMin: 180 };
/** 命令行 / 手机 / IM 上没有多项表单，退成两个按钮 */
const FALLBACK_GO = "按默认开工";
const FALLBACK_EDIT = "改几项再开工";
const EDIT_HINT = "直接写，比如：时长 15 秒，只要竖版";
const PIN_MAX = 800;
const BRAND_KIT = "./brand-kit";

/** 选项用不了的原因：说清楚去哪儿补，而不是只说「不可用」 */
const REASON = {
  tts: "语音合成还没配，去 设置 → 模型 接一路",
  image: "生图模型还没配，去 设置 → 模型 接一路",
  video: "生视频模型还没配，去 设置 → 模型 接一路",
  renderer: "命令行里截不了图，去桌面版",
};
/** 这几种能力按量收钱；renderer 是本机截图，不花钱 */
const PAID = new Set(["video", "image", "tts"]);

// 岔路正则都是「成对」的：两边都出现才算在问这个岔路。
// 只认单个词的话，「封面上放哪句话」也会因为有「封面」两个字被拦下。
const RE_ASPECT = [
  "(横版|横屏|16:9).*(竖版|竖屏|9:16)|(竖版|竖屏|9:16).*(横版|横屏|16:9)",
  "(方版|方形|1:1).*(竖版|竖屏|横版|横屏|9:16|16:9)|(竖版|竖屏|横版|横屏|9:16|16:9).*(方版|方形|1:1)",
];
const RE_DURATION = [
  "(?<!\\d)(15|30|60) ?(秒|s)[\\s/、，,；;或还是]*(?<!\\d)(?!\\1)(15|30|60) ?(秒|s)",
  "(视频|片子|成片|宣传片).{0,6}(多长|几秒|时长)",
];
const RE_RENDER = [
  "(生图|AI ?画|AI ?生成|AI ?出图).{0,20}(排版|截图|HTML|网页)|(排版|截图|HTML|网页).{0,20}(生图|AI ?画|AI ?生成|AI ?出图)",
];
const RE_VISUAL = [
  "(卡片|图文|排版).{0,12}(AI|生成|生视频).{0,6}(画面|视频)|(AI|生成).{0,6}(画面|视频).{0,12}(卡片|图文|排版|素材)",
  "(我的|自己的|现成的?)素材.{0,10}(还是|或者)|(还是|或者).{0,10}(我的|自己的|现成的?)素材",
  // 「画面用图文卡片还是 AI 生成？」：AI 那头后面不跟「画面」也算；问的是封面就不归这一项
  "(?<!封面.{0,8})((卡片|图文).{0,12}(还是|或者).{0,6}(AI|生成|生视频)|(AI ?生成|AI ?画面|生视频).{0,12}(还是|或者).{0,6}(卡片|图文))",
  "讲道理.{0,6}讲故事|讲故事.{0,6}讲道理", // 视频成片师拿不准时问的就是这句
];
const RE_VOICE = [
  "要不要(配音|旁白|念白)|需不需要(配音|旁白)",
  "(配音|旁白).{0,10}(还是|或者).{0,10}(字幕|音乐|纯音乐)|(字幕|音乐|纯音乐).{0,10}(还是|或者).{0,10}(配音|旁白)",
];
const RE_PLATFORM = [
  "(发|投|上|做)(哪|哪些|哪几个)(个)?平台",
  "(抖音|视频号|小红书|B站|公众号|知乎|微博|朋友圈).{0,6}(还是|或者).{0,6}(抖音|视频号|小红书|B站|公众号|知乎|微博|朋友圈)",
];

/** @typedef {{ v: string, l: string, d?: string, needs?: "video"|"image"|"tts"|"renderer", disabled?: boolean, reason?: string }} Opt */
/**
 * @typedef {{ name: string, label: string, type: "select"|"multi"|"text", options?: Opt[],
 *   default: string|string[], required?: boolean, max?: number, min?: number, hint?: string,
 *   covers?: string[], source?: "brands", suggest?: string[] }} Field
 */
/**
 * @typedef {{ id: string, skill: string, title: string, blurb: string,
 *   limits: { max_steps: number, max_runtime_min: number }, fields: Field[],
 *   deliver: { videos?: boolean, images?: boolean, covers: number, titles: number, platforms?: boolean|string[] } }} Recipe
 */
/** @typedef {Record<string, string|string[]>} Values */
/** @typedef {{ id: string, title: string, values: Values, notes: string[], at: string, from?: string }} Pin */
/**
 * @typedef {{ id: string, title: string, blurb: string, fields: Field[],
 *   estimate: { text: string, yuan: number, unknown: boolean }, limitsNote: string, notes: string[],
 *   limits: { max_steps: number, max_runtime_min: number } }} Form
 */

/** @type {Recipe} */
const promoVideo = {
  id: "promo-video",
  skill: "promo-video",
  title: "产品宣传片 30 秒",
  blurb: "填一张表，出竖横成片、3 封面、3 标题和各平台文案",
  limits: { max_steps: 150, max_runtime_min: 60 },
  deliver: { videos: true, covers: 3, titles: 3, platforms: true },
  fields: [
    { name: "product", label: "产品", type: "text", required: true, max: 60, default: "", hint: "产品名，或一句话说清卖什么", source: "brands", covers: ["(哪个|什么)产品(?![图照])|产品(名字?)?(叫|是)(什么|啥)(?!.{0,8}(要不要|需不需要|放不放|放在|放到|放哪))"] },
    { name: "points", label: "主打卖点", type: "text", max: 120, default: "", hint: "不填就从资料里挑", covers: ["(主打|突出|强调)(哪|什么).{0,4}卖点|卖点.{0,6}(是什么|有哪些|选哪)"] },
    {
      name: "duration", label: "时长", type: "select", default: "30", covers: RE_DURATION,
      options: [{ v: "15", l: "15 秒" }, { v: "30", l: "30 秒" }, { v: "60", l: "60 秒" }],
    },
    {
      name: "aspects", label: "画幅", type: "multi", min: 1, default: ["9:16", "16:9"], covers: RE_ASPECT,
      options: [{ v: "9:16", l: "竖版 9:16" }, { v: "16:9", l: "横版 16:9" }, { v: "1:1", l: "方版 1:1" }],
    },
    {
      name: "visual", label: "画面", type: "select", default: "cards", covers: RE_VISUAL,
      options: [
        { v: "cards", l: "图文卡片", d: "不花画面钱" },
        { v: "ai", l: "AI 生成画面", d: "按秒计费", needs: "video" },
        { v: "mine", l: "用我的素材", d: "把视频图片放进任务目录" },
      ],
    },
    {
      name: "voice", label: "声音", type: "select", default: "music", covers: RE_VOICE,
      options: [
        { v: "tts", l: "配音+字幕", d: "按字数计费", needs: "tts" },
        { v: "music", l: "只要字幕+音乐" },
      ],
    },
    {
      name: "cover", label: "封面", type: "select", default: "html", covers: RE_RENDER,
      options: [
        { v: "html", l: "排版截图", d: "不花钱", needs: "renderer" },
        { v: "ai", l: "AI 生图", d: "按张计费", needs: "image" },
      ],
    },
    {
      name: "platforms", label: "发哪些平台", type: "multi", min: 1, default: ["抖音", "视频号"], covers: RE_PLATFORM,
      options: [{ v: "抖音", l: "抖音" }, { v: "视频号", l: "视频号" }, { v: "小红书", l: "小红书" }, { v: "B站", l: "B站" }],
    },
  ],
};

/** @type {Recipe} */
const xhsCarousel = {
  id: "xhs-carousel",
  skill: "xhs-carousel",
  title: "小红书图文 6–9 张",
  blurb: "填一张表，出一组 3:4 卡片、3 封面、3 标题和正文标签",
  limits: { max_steps: 120, max_runtime_min: 45 },
  deliver: { images: true, covers: 3, titles: 3, platforms: ["小红书"] },
  fields: [
    { name: "topic", label: "选题", type: "text", required: true, max: 80, default: "", hint: "比如：新手露营 5 件必带", covers: ["(写|做)(什么|哪个)(主题|选题)|选题.{0,6}(是什么|定哪个)"] },
    { name: "product", label: "带哪个产品", type: "text", max: 60, default: "", hint: "不带货就空着", source: "brands" },
    {
      name: "count", label: "张数", type: "select", default: "7",
      covers: ["(?<!封面.{0,8})(做|出|要)(几|多少)张(?!.{0,4}封面)|(?<!\\d)[6-9] ?张[\\s/、，,或还是]*(?<!\\d)[6-9] ?张"],
      options: [{ v: "6", l: "6 张" }, { v: "7", l: "7 张" }, { v: "8", l: "8 张" }, { v: "9", l: "9 张" }],
    },
    {
      name: "render", label: "怎么出图", type: "select", default: "html", covers: RE_RENDER,
      options: [
        { v: "html", l: "排版截图", d: "不花钱，字清楚", needs: "renderer" },
        { v: "ai", l: "AI 生图", d: "按张计费", needs: "image" },
      ],
    },
    {
      name: "style", label: "风格", type: "select", default: "light",
      covers: ["(什么|哪种|哪个)(风格|配色)|(风格|配色)(选|用)(哪|什么)|(浅色|亮色).{0,10}(深色|暗色)|(深色|暗色).{0,10}(浅色|亮色)"],
      options: [{ v: "light", l: "浅色杂志" }, { v: "dark", l: "深色质感" }, { v: "collage", l: "手账拼贴" }, { v: "bold", l: "极简大字" }],
    },
    {
      name: "tone", label: "语气", type: "select", default: "tips",
      covers: ["(干货|种草|测评).{0,8}(还是|或者).{0,8}(干货|种草|测评)|(什么|哪种)(语气|调性|口吻)"],
      options: [{ v: "tips", l: "干货" }, { v: "seed", l: "种草" }, { v: "review", l: "测评" }],
    },
  ],
};

/** @type {Recipe} */
const multiPost = {
  id: "multi-post",
  skill: "multi-post",
  title: "一稿多投",
  blurb: "一篇稿子改成各平台的版本，每个平台一份能直接贴的",
  limits: { max_steps: 80, max_runtime_min: 30 },
  deliver: { covers: 3, titles: 3, platforms: true },
  fields: [
    { name: "source", label: "原稿", type: "text", required: true, max: 200, default: "", hint: "文件名，或直接贴一段", covers: ["(原稿|稿子|原文)(在哪|是哪|发我|给我)"] },
    {
      name: "platforms", label: "发哪些平台", type: "multi", min: 1, default: ["公众号", "小红书", "抖音口播"], covers: RE_PLATFORM,
      options: ["公众号", "小红书", "抖音口播", "视频号", "知乎", "微博", "朋友圈"].map((v) => ({ v, l: v })),
    },
    {
      name: "keep", label: "改多少", type: "select", default: "wording",
      covers: ["(保留|照搬|忠于)原(文|稿|意).{0,10}(还是|或者)|(重排|重写|改结构).{0,10}(还是|或者)|(还是|或者).{0,10}(重排|重写|改结构)"],
      options: [{ v: "wording", l: "保留原意只改说法" }, { v: "restructure", l: "允许重排结构" }],
    },
    {
      name: "images", label: "配图", type: "select", default: "none",
      covers: ["要不要(配图|封面)|需不需要(配图|封面)", ...RE_RENDER],
      options: [
        { v: "none", l: "只要文字" },
        { v: "html", l: "每个平台一张排版封面", d: "不花钱", needs: "renderer" },
        { v: "ai", l: "AI 生图封面", d: "按张计费", needs: "image" },
      ],
    },
  ],
};

/** @type {Recipe[]} */
const BUILTIN = [promoVideo, xhsCarousel, multiPost];

/** @param {unknown} id @returns {Recipe|null} */
function get(id) {
  const k = String(id == null ? "" : id).trim().toLowerCase();
  return BUILTIN.find((r) => r.id === k) || null;
}

/** @returns {Recipe[]} */
function list() { return BUILTIN.slice(); }

/** @template T @param {T} x @returns {T} */
const clone = (x) => JSON.parse(JSON.stringify(x));
/** @param {unknown} s @param {number} n */
const cut = (s, n) => { const t = String(s == null ? "" : s).trim(); return t.length > n ? t.slice(0, n) : t; };

/**
 * 这台机器上哪几路能用。跟 generate_image 这些工具挑模型走的是同一个判据
 * （media-models.pick 空名字时拿的就是 media[cap]）：有模型、有地址才算接上了。
 * @param {any} config @param {boolean} renderer
 */
function capsReady(config, renderer) {
  /** @type {any} */
  let media = {};
  try { media = require("./media-models").resolve(config || {}) || {}; } catch { media = {}; }
  /** @param {string} cap */
  const ok = (cap) => { const m = media[cap]; return !!(m && m.model && m.base_url); };
  return { video: ok("video"), image: ok("image"), tts: ok("tts"), renderer: !!renderer, media };
}

/**
 * 品牌档案里有哪些产品。品牌档案模块还没装上、或者读挂了，都当没有——
 * 这一项退成普通的文本框，不影响开工。
 * 没给工作目录也照读：用户级的档案不挂在哪个目录下，只是少了项目里那几份。
 * @param {string|undefined} cwd
 * @returns {string[]}
 */
function brandNames(cwd) {
  try {
    // 模块名放变量里：品牌档案是另一块在做的，没合进来之前类型检查不该因为「找不到模块」变红
    /** @type {any} */
    const bk = require(BRAND_KIT);
    const got = bk && typeof bk.loadAll === "function" ? bk.loadAll({ cwd }) : null;
    /** @type {any[]} */
    const rows = got && Array.isArray(got.list) ? got.list : [];
    return [...new Set(rows.map((e) => cut(e && (e.name || e.slug), 60)).filter(Boolean))].slice(0, 12);
  } catch { return []; }
}

/**
 * 把一个值对到某个选项上。模型给 defaults、用户在命令行里敲字，常常给的是标签（「15 秒」「竖版」）
 * 而不是值（"15"、"9:16"），两种都认；标签只认开头那个词，「竖版」能对上「竖版 9:16」。
 * @param {Opt[]} opts @param {unknown} raw @param {boolean} [enabledOnly]
 * @returns {Opt|null}
 */
function matchOpt(opts, raw, enabledOnly = true) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const pool = enabledOnly ? opts.filter((o) => !o.disabled) : opts;
  const bare = s.replace(/\s*(秒|s|张)$/, "");
  return pool.find((o) => o.v.toLowerCase() === s || o.v.toLowerCase() === bare)
    || pool.find((o) => o.l.toLowerCase() === s)
    || pool.find((o) => o.l.toLowerCase().split(" ")[0] === s)
    || null;
}

/**
 * 按字段规格收一个值。收不下返回 undefined（调用方决定是退默认还是报错）。
 * @param {Field} f @param {unknown} raw @param {boolean} [enabledOnly]
 * @returns {string|string[]|undefined}
 */
function coerce(f, raw, enabledOnly = true) {
  if (raw == null) return undefined;
  if (f.type === "text") return cut(raw, f.max || 200);
  const opts = f.options || [];
  if (f.type === "select") {
    const o = matchOpt(opts, Array.isArray(raw) ? raw[0] : raw, enabledOnly);
    return o ? o.v : undefined;
  }
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,，、/;；]+/);
  const picked = [];
  for (const p of parts) {
    const o = matchOpt(opts, p, enabledOnly);
    if (!o) return undefined; // 一个不认识就整项不收：半截的勾选比默认更容易误导
    if (!picked.includes(o.v)) picked.push(o.v);
  }
  if (picked.length < (f.min || 1)) return undefined;
  // 按选项顺序排：同一组值不管用户点的先后，摆出来都一样，钉进提示词才不会每次变样
  return opts.map((o) => o.v).filter((v) => picked.includes(v));
}

/** @param {{ fields: Field[] }} form @returns {Values} */
function defaultValues(form) {
  /** @type {Values} */
  const out = {};
  for (const f of form.fields) out[f.name] = Array.isArray(f.default) ? f.default.slice() : f.default;
  return out;
}

/**
 * 摆给用户看的那张表单：把「这台机器上用不了的选项」标灰并写明原因，
 * 默认值落在用不了的选项上就挪开，并记一条说明摆在卡片上。
 * @param {string} id
 * @param {{ config?: any, hasRenderer?: boolean, brands?: string[], defaults?: Record<string, unknown>, cwd?: string }} [opts]
 * @returns {Form|null}
 */
function formFor(id, { config, hasRenderer = false, brands, defaults, cwd } = {}) {
  const r = get(id);
  if (!r) return null;
  const caps = capsReady(config, hasRenderer);
  /** @type {string[]} */
  const notes = [];
  const names = Array.isArray(brands) ? brands.map((b) => cut(b, 60)).filter(Boolean) : brandNames(cwd);
  /** @type {Field[]} */
  const fields = r.fields.map((f0) => {
    const f = clone(f0);
    delete f.covers; // 岔路正则只在服务端用，别塞进事件里发给前端
    for (const o of f.options || []) {
      if (o.needs && !(/** @type {any} */ (caps))[o.needs]) { o.disabled = true; o.reason = REASON[o.needs]; }
    }
    if (f.source === "brands" && names.length) {
      f.suggest = names;
      if (names.length === 1 && !f.default) f.default = names[0];
    }
    if (f.type === "select" && f.options) {
      const cur = f.options.find((o) => o.v === f.default);
      if (!cur || cur.disabled) {
        const free = f.options.find((o) => !o.disabled && !(o.needs && PAID.has(o.needs)));
        const paid = f.options.find((o) => !o.disabled);
        const was = cur ? cur.l : String(f.default);
        const why = cur && cur.reason ? `（${cur.reason}）` : "";
        if (free) {
          f.default = free.v;
          notes.push(`${f.label}：「${was}」用不了${why}，先按「${free.l}」`);
        } else if (paid) {
          // 只剩花钱的一条：不替人选。默认留空＝这次不做，要花这笔钱得用户自己点上（或 -i 明写）
          // 卡片说明 ≤40 字：有原因就只写原因（原因已点明哪条用不了），那条照样能点，不用再说「要用就自己选」
          f.default = "";
          notes.push(`${f.label}：${cur && cur.reason ? cur.reason : `「${was}」用不了`}；「${paid.l}」要花钱，没替你选`);
        } else {
          // 一条都用不了：值留空，摘要里就是「没选」，而不是摆一个这台机器做不出来的选项
          f.default = "";
          notes.push(`${f.label}：这台机器上都用不了${why}，这次不做这一项`);
        }
      }
    }
    if (f.type === "multi" && f.options && Array.isArray(f.default)) {
      const ok = f.default.filter((v) => f.options && f.options.some((o) => o.v === v && !o.disabled));
      if (ok.length) f.default = ok;
    }
    return f;
  });
  // 模型从用户原话里摘出来的项：照规格收，收不下就不收（不拿它去改默认以外的东西）
  if (defaults && typeof defaults === "object") {
    for (const f of fields) {
      if (!Object.prototype.hasOwnProperty.call(defaults, f.name)) continue;
      const v = coerce(f, defaults[f.name]);
      if (v !== undefined && !(f.type === "text" && !v)) f.default = v;
    }
  }
  /** @type {Form} */
  const form = {
    id: r.id, title: r.title, blurb: r.blurb, fields, notes, limits: { ...r.limits },
    estimate: { text: "", yuan: 0, unknown: false },
    limitsNote: `最多 ${r.limits.max_steps} 步、${r.limits.max_runtime_min} 分钟`,
  };
  form.estimate = estimate(form, defaultValues(form), config);
  return form;
}

/**
 * 这组选择要花哪些按量的钱：每一项 { cap, units }。只列真会调付费接口的——
 * 排版截图、用自己的素材、只要字幕都不在里面。
 * @param {string} id @param {Values} v
 * @returns {Array<{ cap: "video"|"image"|"tts", units: number }>}
 */
function paidItems(id, v) {
  const num = (/** @type {unknown} */ x, /** @type {number} */ d) => (Number.isFinite(+(/** @type {any} */ (x))) && +(/** @type {any} */ (x)) > 0 ? +(/** @type {any} */ (x)) : d);
  const arr = (/** @type {unknown} */ x) => (Array.isArray(x) ? x : x ? [x] : []);
  /** @type {Array<{ cap: "video"|"image"|"tts", units: number }>} */
  const out = [];
  if (id === "promo-video") {
    const dur = num(v.duration, 30);
    const aspects = Math.max(1, arr(v.aspects).length);
    if (v.visual === "ai") out.push({ cap: "video", units: dur * aspects });
    if (v.voice === "tts") out.push({ cap: "tts", units: Math.round(dur * 4.5) / 1000 }); // 口播约每秒 4.5 字
    if (v.cover === "ai") out.push({ cap: "image", units: 3 });
  } else if (id === "xhs-carousel") {
    if (v.render === "ai") out.push({ cap: "image", units: num(v.count, 7) + 3 }); // 内页 + 3 张封面候选
  } else if (id === "multi-post") {
    if (v.images === "ai") out.push({ cap: "image", units: Math.max(3, arr(v.platforms).length) });
  }
  return out;
}

/**
 * 预估生成费。查不到单价的项写「单价未知」，**绝不当 0 元算**；
 * 一部分知道、一部分不知道的，知道的加起来，并写明几项没算进去。
 * @param {{ id: string }} form @param {Values} values @param {any} [config]
 * @returns {{ text: string, yuan: number, unknown: boolean }}
 */
function estimate(form, values, config) {
  const items = paidItems(form.id, values || {});
  if (!items.length) return { text: "画面和封面不花钱", yuan: 0, unknown: false };
  /** @type {any} */
  let pricing = null;
  try { pricing = require("./pricing"); } catch { pricing = null; }
  const caps = capsReady(config, false);
  let yuan = 0, unknownN = 0;
  /** @type {Array<{ what: string, unknown: boolean }>} */
  const parts = [];
  for (const it of items) {
    const m = caps.media[it.cap] || {};
    const model = String(m.model || "");
    let hit = null;
    if (pricing && model) {
      let provider;
      try {
        const row = (caps.media.list || []).find((/** @type {any} */ x) => x.cap === it.cap && x.model === model);
        provider = row ? ((config && config.providers) || []).find((/** @type {any} */ p) => p.id === row.provider) : undefined;
      } catch { provider = undefined; }
      try { hit = pricing.costOfUnits({ cap: it.cap, model, units: it.units }, { config, provider }); } catch { hit = null; }
    }
    const what = it.cap === "video" ? `生成视频 ${it.units} 秒`
      : it.cap === "image" ? `生成图片 ${it.units} 张`
      : `语音合成约 ${Math.round(it.units * 1000)} 字`;
    if (!hit || hit.unknown) { unknownN++; parts.push({ what, unknown: true }); continue; }
    yuan += hit.yuan;
    parts.push({ what, unknown: false });
  }
  yuan = Math.round(yuan * 1e4) / 1e4;
  const money = pricing ? pricing.yuanText(yuan) : `${yuan} 元`;
  const plain = parts.map((p) => p.what).join("、");
  let text;
  if (unknownN === items.length) text = `单价未知：${plain}`;
  else if (unknownN) text = `约 ${money}（${unknownN} 项单价未知没算进去）：${parts.map((p) => p.what + (p.unknown ? "（单价未知）" : "")).join("、")}`;
  else if (yuan === 0) text = `按价目表不花钱：${plain}`;
  else text = `约 ${money}：${plain}`;
  return { text, yuan, unknown: unknownN > 0 };
}

/**
 * 命令行里用户敲的一句「时长 15 秒，只要竖版」：能稳稳对上的单选项、「只要 X」的多选项就直接改掉，
 * 对不上的不猜——整句话照样作为「用户补充」钉进去，跟默认值冲突时以那句为准。
 * @param {Form} form @param {string} text @param {Values} values
 */
function applyFreeText(form, text, values) {
  const t = text.toLowerCase();
  for (const f of form.fields) {
    const opts = (f.options || []).filter((o) => !o.disabled);
    if (!opts.length) continue;
    // 只认够长、够特别的词：「15」要跟着「秒/张」（不然「售价 150 元」也算），
    // 「AI 生图」要整个出现（不然任何带 ai 两个字母的英文都算）
    const hitOf = (/** @type {Opt} */ o) => {
      const full = o.l.toLowerCase();
      const key = full.split(" ")[0];
      if (/^\d+$/.test(key)) return new RegExp(`(?<!\\d)${key} ?(秒|张|s)`).test(t);
      if (t.includes(full) || t.includes(full.replace(/\s+/g, ""))) return true;
      if (key.length >= 2 && /[一-鿿]/.test(key) && t.includes(key)) return true;
      return /:/.test(o.v) && t.includes(o.v);
    };
    if (f.type === "select") {
      const hits = opts.filter(hitOf);
      if (hits.length === 1) values[f.name] = hits[0].v;
    } else if (f.type === "multi" && /只要|只出|只做|只发/.test(text)) {
      const hits = opts.filter(hitOf);
      if (hits.length) values[f.name] = hits.map((o) => o.v);
    }
  }
}

/**
 * 把一次回答（表单卡片交回来的 JSON、命令行里点的按钮、敲的一句话、或者超时 null）收成一组值。
 * 收不下的项退回默认并记一条说明——绝不因为一项填错就整张表作废。
 * @param {Form|Recipe} form @param {string|null|undefined} answer
 * @returns {{ values: Values, notes: string[], timedOut: boolean }}
 */
function parseAnswer(form, answer) {
  const values = defaultValues(form);
  /** @type {string[]} */
  const notes = [];
  // 必填项空着最常见的就是「按默认开工」和超时——这两条路更得提醒模型去找，不能提前返回漏掉
  const done = (/** @type {boolean} */ timedOut) => {
    for (const f of form.fields) {
      if (f.required && f.type === "text" && !String(values[f.name] || "").trim()) notes.push(`${f.label}没填：从用户前面的话里找，找不到就在第一次汇报里问`);
    }
    return { values, notes, timedOut };
  };
  if (answer == null) return done(true);
  const s = String(answer).trim();
  if (!s || s === FALLBACK_GO) return done(false);
  /** @type {any} */
  let obj = null;
  if (s.startsWith("{")) { try { obj = JSON.parse(s); } catch { obj = null; } }
  if (obj && typeof obj === "object") {
    const given = obj.values && typeof obj.values === "object" ? obj.values : obj;
    for (const f of form.fields) {
      if (!Object.prototype.hasOwnProperty.call(given, f.name)) continue;
      // 默认就是「这次不做」的单选项，卡片原样交回空值：照收，不算填错
      if (f.type === "select" && f.default === "" && (given[f.name] === "" || given[f.name] == null)) continue;
      const v = coerce(f, given[f.name]);
      if (v === undefined) {
        const shown = Array.isArray(f.default) ? f.default.join("、") : String(f.default || "空");
        notes.push(`${f.label}填的「${cut(given[f.name], 40)}」用不了，按默认「${shown}」`);
      } else values[f.name] = v;
    }
  } else {
    applyFreeText(/** @type {Form} */ (form), s, values);
    notes.push(`用户补充：${cut(s, 300)}`);
  }
  return done(false);
}

/**
 * 一项一行的人话摘要：「时长：30 秒」「画幅：竖版 9:16、横版 16:9」。
 * @param {{ fields: Field[] }} form @param {Values} values
 * @returns {string[]}
 */
function summary(form, values) {
  return form.fields.map((f) => `${f.label}：${shownValue(f, (values || {})[f.name])}`);
}

/** @param {Field} f @param {unknown} v */
function shownValue(f, v) {
  const opts = f.options || [];
  const label = (/** @type {unknown} */ x) => { const o = opts.find((p) => p.v === x); return o ? o.l : String(x); };
  if (f.type === "multi") { const a = Array.isArray(v) ? v : v ? [v] : []; return a.length ? a.map(label).join("、") : "（没选）"; }
  if (f.type === "select") return v == null || v === "" ? "这次不做" : label(v);
  const t = String(v == null ? "" : v).trim();
  return t || "（没填）";
}

/**
 * ask_user 带了 form 时走这里：弹一张多项表单（桌面），或者两个按钮（命令行、手机、IM），
 * 或者没人在（无人值守）直接按默认。答案钉进 stats.recipe、写进任务目录，并把上限抬到配方要的档。
 * @param {{ question?: string, form?: string, defaults?: Record<string, unknown> }} input
 * @param {{ emit?: (e: any) => void, depth?: number, askUser?: ((q: any) => Promise<string|null>)|null,
 *   stats?: any, saveDir?: string|null, config?: any, hasRenderer?: boolean, brands?: string[], cwd?: string }} ctx
 * @returns {Promise<{ content: string, isError: boolean, extendMs?: number, raiseLimits?: { max_steps: number, max_runtime_min: number } }>}
 */
async function askForm(input, ctx) {
  const { emit = () => {}, depth = 0, askUser = null, stats = null, saveDir = null, config = {}, hasRenderer = false, brands, cwd } = ctx || {};
  const id = String((input && input.form) || "").trim().toLowerCase();
  const r = get(id);
  if (!r) return { content: `没有叫「${cut(id, 40)}」的配方，能用的是：${BUILTIN.map((x) => x.id).join(" / ")}。不走配方就去掉 form 照常问。`, isError: true };
  const raiseLimits = { ...r.limits };
  const limitLine = `这个配方的上限会自动放宽到 ${r.limits.max_steps} 步 / ${r.limits.max_runtime_min} 分钟（用户用 --max-steps 限过的不动），不用让用户去设置里调。`;

  // 同一棵任务树里再调一次：不再弹。命令行流程把表单预填在消息里（PRESET_RE），也走这条
  if (stats && stats.recipe && stats.recipe.id === id) {
    const lines = summary(r, stats.recipe.values || {});
    const extra = (stats.recipe.notes || []).map((/** @type {string} */ n) => `- ${n}`);
    return {
      content: `表单已经填过了，照这个做，别再问：\n${[...lines.map((l) => `- ${l}`), ...extra].join("\n")}\n${limitLine}`,
      isError: false, raiseLimits,
    };
  }
  // 上一轮是专家、团队在子任务里填的表：钉在那一轮的 stats 上，这一轮读不回来。
  // 任务目录里那份还在就照它，不再弹——弹了没人填，超时的默认值还会把上一轮的答案盖掉
  if (!(stats && stats.recipe) && saveDir && path.isAbsolute(saveDir)) {
    const prev = restore({ dir: saveDir, loaded: [r.skill] });
    if (prev && prev.id === id) {
      if (stats) stats.recipe = prev;
      emit({ type: "status", text: "照上一轮填的表单做，不再弹", depth });
      const lines = [...summary(r, prev.values), ...prev.notes].map((l) => `- ${l}`);
      return {
        content: `表单上一轮已经填过了（从任务目录的 ${FORM_FILE} 读回来的），照这个做，别再问：\n${lines.join("\n")}\n` +
          `用户这一轮说的跟表单冲突时，以这一轮说的为准。\n${limitLine}`,
        isError: false, raiseLimits,
      };
    }
  }

  const form = /** @type {Form} */ (formFor(id, { config, hasRenderer, brands, cwd, defaults: input && input.defaults }));
  const question = cut(input && input.question, 200) || `开工前定几件事：${r.title}`;
  const defaultsLine = cut(summary(form, defaultValues(form)).join("；"), 200);
  const options = [{ label: FALLBACK_GO, detail: defaultsLine }, { label: FALLBACK_EDIT, detail: EDIT_HINT }];
  const timeoutMs = Math.max(30000, Number(((config && config.agent) || {}).ask_user_timeout_ms) || 300000);
  const newId = () => "ask_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /** @type {string|null} */
  let answer = null;
  let waited = 0;
  const unattended = typeof askUser !== "function";
  if (!unattended) {
    const askId = newId();
    emit({
      type: "ask_user", ask_id: askId, question, options, fields: form.fields, form: form.id,
      title: form.title, blurb: form.blurb, estimate: form.estimate.text, limits_note: form.limitsNote,
      notes: form.notes, timeout_ms: timeoutMs, depth,
    });
    const t0 = Date.now();
    answer = await /** @type {(q: any) => Promise<string|null>} */ (askUser)({ askId, question, options, timeoutMs, fields: form.fields });
    // 命令行里点了「改几项再开工」：接着问一句改哪几项，这一句答的才是真正的改动
    if (answer === FALLBACK_EDIT) {
      emit({ type: "ask_answer", ask_id: askId, answer, depth });
      const id2 = newId();
      const q2 = `改哪几项？${EDIT_HINT}`;
      const opts2 = [{ label: FALLBACK_GO, detail: "不改了，照默认" }];
      emit({ type: "ask_user", ask_id: id2, question: q2, options: opts2, timeout_ms: timeoutMs, depth });
      const a2 = await /** @type {(q: any) => Promise<string|null>} */ (askUser)({ askId: id2, question: q2, options: opts2, timeoutMs });
      answer = a2;
      waited = Date.now() - t0;
      const parsed2 = parseAnswer(form, a2);
      emit(a2 == null ? { type: "ask_answer", ask_id: id2, timeout: true, depth } : { type: "ask_answer", ask_id: id2, answer: a2, summary: summary(form, parsed2.values), depth });
    } else {
      waited = Date.now() - t0;
      const parsed1 = parseAnswer(form, answer);
      const est1 = estimate(form, parsed1.values, config).text;
      emit(answer == null
        ? { type: "ask_answer", ask_id: askId, timeout: true, summary: summary(form, parsed1.values), estimate: est1, depth }
        : { type: "ask_answer", ask_id: askId, answer, summary: summary(form, parsed1.values), estimate: est1, depth });
    }
  }
  const parsed = parseAnswer(form, unattended ? FALLBACK_GO : answer);
  const notes = [...form.notes, ...parsed.notes];
  const lines = summary(form, parsed.values);
  const est = estimate(form, parsed.values, config);

  // ask-gate 靠 stats.asks 判「这一轮问过了没有」：表单算这一轮的头一问
  if (stats) {
    const asks = (stats.asks = Array.isArray(stats.asks) ? stats.asks : []);
    asks.push({ q: "开头表单：" + r.title, a: cut(lines.join("；"), 300), skipped: unattended });
    stats.recipe = { id: r.id, title: r.title, values: parsed.values, notes, at: new Date().toISOString() };
  }

  let fileNote = "";
  if (saveDir && path.isAbsolute(saveDir)) {
    try {
      fs.mkdirSync(saveDir, { recursive: true });
      require("./store").writeJsonAtomic(path.join(saveDir, FORM_FILE), { v: 1, id: r.id, title: r.title, values: parsed.values, notes, at: new Date().toISOString() }, { pretty: true, backup: false });
    } catch (e) {
      fileNote = `\n（表单没写进任务目录：${cut(/** @type {any} */ (e).message, 80)}。这一轮照样钉在提示词里）`;
    }
  }

  let tail = "";
  if (unattended) tail = "\n现在没人在线填表（无人值守），按默认值开工；替用户定的项写进交付清单的 assumptions。";
  else if (parsed.timedOut) tail = `\n表单等了 ${Math.round(waited / 1000)} 秒没人填，按默认值开工；在交付清单 assumptions 里列出来。`;
  const noteLines = notes.map((n) => `- ${n}`);
  return {
    content: `用户在开头表单里定好了（照做，这些岔路别再问）：\n${lines.map((l) => `- ${l}`).join("\n")}` +
      (noteLines.length ? `\n${noteLines.join("\n")}\n（上面的补充和默认值冲突时，以补充为准）` : "") +
      `\n预估生成费：${est.text}\n${limitLine}` + tail + fileNote,
    isError: false,
    ...(waited ? { extendMs: waited } : {}),
    raiseLimits,
  };
}

/** @type {Map<string, RegExp>} */
const RE_CACHE = new Map();
/** @param {string} src */
function re(src) {
  let r = RE_CACHE.get(src);
  if (!r) { r = new RegExp(src, "i"); RE_CACHE.set(src, r); }
  return r;
}

/**
 * 后面又冒出一问，而这一问表单里已经定过了：不弹，直接把表单上的答案还给模型。
 * 只认成对的岔路（两个选项都出现），「封面上放哪句话」这种不拦。
 * 值是空的项不拦——用户没填产品名，后面问一句「是哪个产品」是正当的。
 * @param {Pin|null|undefined} pin @param {string} question @param {any[]} [options]
 * @returns {string|null}
 */
function coveredAsk(pin, question, options) {
  if (!pin || !pin.id) return null;
  const r = get(pin.id);
  if (!r) return null;
  const labels = (Array.isArray(options) ? options : [])
    .map((o) => (o && typeof o === "object" ? String(o.label || "") : String(o == null ? "" : o)))
    .filter(Boolean);
  const text = [String(question || ""), ...labels].join(" / ");
  for (const f of r.fields) {
    if (!f.covers || !f.covers.length) continue;
    const v = (pin.values || {})[f.name];
    if (v == null || (Array.isArray(v) ? !v.length : !String(v).trim())) continue;
    if (!f.covers.some((src) => re(src).test(text))) continue;
    const said = (pin.notes || []).find((n) => n.startsWith("用户补充："));
    return `开头表单里已经定了「${f.label}：${shownValue(f, v)}」，照这个做，别再问。要改得用户自己开口。` +
      (said ? `用户另外说过「${cut(said.slice(5), 80)}」，跟表单冲突时以那句为准。` : "");
  }
  return null;
}

/**
 * 钉进系统提示词的那一段。跟技能块挨着放，历史压缩压不到这里。
 * @param {Pin|null|undefined} pin
 * @returns {string}
 */
function pinBlock(pin) {
  if (!pin || !pin.id) return "";
  const r = get(pin.id);
  const title = cut((r && r.title) || pin.title || pin.id, 40);
  const lines = r ? summary(r, pin.values || {}) : Object.entries(pin.values || {}).map(([k, v]) => `${k}：${Array.isArray(v) ? v.join("、") : v}`);
  const notes = (pin.notes || []).map((n) => cut(n, 160));
  const head = `\n\n## 本次配方：${title}（开头表单已定，历史压缩也不会丢）\n`;
  const foot = "\n表单没覆盖的小事自己定，别问；补充和默认值冲突时以补充为准；交付用 delivery_page 出 交付.html。";
  let body = [...lines, ...notes].map((l) => `- ${cut(l, 160)}`).join("\n");
  const room = PIN_MAX - head.length - foot.length;
  if (body.length > room) body = body.slice(0, Math.max(0, room - 1)) + "…";
  return head + body + foot;
}

/** @param {any} m @returns {string} */
function textOf(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (p && typeof p.text === "string" ? p.text : typeof p === "string" ? p : "")).join("\n");
  return typeof m.text === "string" ? m.text : "";
}

/**
 * 按原始字段规格收一组值（不看这台机器能不能用——那是当时开表单时判的）。
 * @param {Recipe} r @param {any} raw
 * @returns {Values}
 */
function cleanValues(r, raw) {
  const values = defaultValues(r);
  const given = raw && typeof raw === "object" ? (raw.values && typeof raw.values === "object" ? raw.values : raw) : {};
  for (const f of r.fields) {
    if (!Object.prototype.hasOwnProperty.call(given, f.name)) continue;
    const v = coerce(f, given[f.name], false);
    if (v !== undefined) values[f.name] = v;
    else if (f.type === "select" && given[f.name] === "") values[f.name] = ""; // 开表单时这一项一条都用不了
  }
  return values;
}

/**
 * 新一轮 runTask 开头：把上次定过的表单找回来。
 *   ① 历史里最后一条带【配方表单已填：…】的用户消息（命令行流程）。这一轮要做的就是那条（ask）
 *      才直接认；更早的只在这个配方的技能还挂着时认，跟②一个道理——
 *      跑完一趟流程、在同一个会话里接着说「帮我写封邮件」，不能还钉着宣传片那张表；
 *   ② 否则任务目录里有 配方表单.json，而且这个配方的技能本轮已经加载着——
 *      只认「技能还在」的那份，免得同一个目录里做别的事时被一张旧表单绑住；
 *   ③ 都没有就是 null。
 * ask：这一轮用户要的那句（agent.js 的 currentAsk，空白已压成一个空格）。不给就拿最后一条用户消息。
 * @param {{ history?: any[], dir?: string|null, loaded?: string[], ask?: string }} arg
 * @returns {Pin|null}
 */
function restore({ history, dir, loaded, ask } = {}) {
  const h = Array.isArray(history) ? history : [];
  const flat = (/** @type {string} */ s) => String(s).replace(/\s+/g, " ").trim();
  const lastUser = [...h].reverse().find((m) => m && m.role === "user");
  const now = typeof ask === "string" ? flat(ask) : flat(textOf(lastUser));
  const on = Array.isArray(loaded) ? loaded : [];
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i];
    if (!m || m.role !== "user") continue;
    const hit = PRESET_RE.exec(textOf(m));
    if (!hit) continue;
    const r = get(hit[1]);
    if (!r) continue;
    if (!(now && now.includes(flat(hit[0]))) && !on.includes(r.skill)) continue;
    /** @type {any} */
    let raw = null;
    try { raw = JSON.parse(hit[2]); } catch { raw = null; }
    if (!raw || typeof raw !== "object") continue;
    return { id: r.id, title: r.title, values: cleanValues(r, raw), notes: Array.isArray(raw.notes) ? raw.notes.map((/** @type {unknown} */ n) => cut(n, 300)).filter(Boolean).slice(0, 6) : [], at: "", from: "preset" };
  }
  if (!dir) return null;
  /** @type {any} */
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(path.join(dir, FORM_FILE), "utf8")); } catch { return null; }
  const r = saved && get(saved.id);
  if (!r) return null;
  if (!on.includes(r.skill)) return null;
  return {
    id: r.id, title: r.title, values: cleanValues(r, saved.values),
    notes: Array.isArray(saved.notes) ? saved.notes.map((/** @type {unknown} */ n) => cut(n, 300)).filter(Boolean).slice(0, 8) : [],
    at: String(saved.at || ""), from: "file",
  };
}

/**
 * 按配方抬上限：只抬不降，抬也有顶（500 步 / 180 分钟）。
 * 用户用 --max-steps 明确限过步数的，步数一步不改——那是他的决定，配方只能建议。
 * 截止时间按「多给的那段」往后挪，不是从现在重新算满：前面已经跑掉的时间照样算数。
 * @param {{ maxSteps: number, runtimeMs: number, deadline: number, locked?: boolean }} cur
 * @param {{ max_steps: number, max_runtime_min: number }} want
 * @returns {{ maxSteps: number, runtimeMs: number, deadline: number, note: string }}
 */
function applyLimits(cur, want) {
  const w = want || { max_steps: 0, max_runtime_min: 0 };
  const curSteps = Math.max(1, Math.floor(+cur.maxSteps || 0));
  const curMs = Math.max(0, +cur.runtimeMs || 0);
  const wantSteps = Math.min(HARD.steps, Math.max(0, Math.floor(+w.max_steps || 0)));
  const wantMs = Math.min(HARD.runtimeMin * 60000, Math.max(0, (+w.max_runtime_min || 0) * 60000));
  const maxSteps = cur.locked ? curSteps : Math.max(curSteps, wantSteps);
  const runtimeMs = Math.max(curMs, wantMs);
  const base = Number.isFinite(+cur.deadline) && +cur.deadline > 0 ? +cur.deadline : Date.now() + curMs;
  const deadline = base + (runtimeMs - curMs);
  const mins = Math.round(runtimeMs / 60000);
  let note;
  if (cur.locked && wantSteps > curSteps) note = `你这次限了 ${curSteps} 步，配方建议 ${wantSteps} 步，没改；时长上限 ${mins} 分钟`;
  else if (maxSteps > curSteps || runtimeMs > curMs) note = `按配方把上限放宽到 ${maxSteps} 步 / ${mins} 分钟`;
  else note = `上限够用（${maxSteps} 步 / ${mins} 分钟），没动`;
  return { maxSteps, runtimeMs, deadline, note };
}

/** 每一步开头那两个标记：技能自动加载 + 表单预填（cli 把 {{input.__json}} 换成一行 JSON） */
/** @param {Recipe} r */
const stepHead = (r) => `【使用技能：${r.skill}】【配方表单已填：${r.id}】{{input.__json}}\n`;

/** @type {Record<string, Array<{ name: string, title: string, phase: string, text: string }>>} */
const STEPS = {
  "promo-video": [
    { name: "brief", title: "脚本和分镜", phase: "策划", text: "照技能第 1 步写脚本和分镜表：时长、画幅照表单，开头 3 秒要有钩子。这一步只出脚本和分镜，先别做画面。" },
    { name: "make", title: "做成片", phase: "制作", text: "照技能第 2–4 步，按这份脚本和分镜做成片，表单里每个画幅各一条：\n{{brief}}" },
    { name: "deliver", title: "封面标题和交付页", phase: "交付", text: "照技能第 5–6 步出 3 张封面、3 个标题和各平台文案，写 交付清单.json，再调 delivery_page 出 交付.html。" },
  ],
  "xhs-carousel": [
    { name: "plan", title: "选题和大纲", phase: "策划", text: "照技能第 1 步定选题角度，列出每张卡片放什么。这一步只出大纲，先别排版。" },
    { name: "cards", title: "做卡片", phase: "制作", text: "照技能第 2 步，按这份大纲做卡片，张数、风格照表单：\n{{plan}}" },
    { name: "deliver", title: "封面标题和交付页", phase: "交付", text: "照技能第 3–4 步出 3 张封面候选、3 个标题、正文和标签，写 交付清单.json，再调 delivery_page 出 交付.html。" },
  ],
  "multi-post": [
    { name: "rewrite", title: "各平台改写", phase: "改写", text: "照技能第 1–2 步读原稿，按表单里的平台一个平台一版改写。" },
    { name: "deliver", title: "标题封面和交付页", phase: "交付", text: "照技能第 3–4 步出 3 个标题（表单选了配图才出封面），写 交付清单.json，再调 delivery_page 出 交付.html。" },
  ],
};

/**
 * 内置配方对应的流程文件（`openworkbuddy workflow promo-video`）。
 * 不放 templates/*.json：那个目录不进安装包。inputs 跟表单字段一一对应，改字段这里自动跟着变。
 * 传了 { config, hasRenderer } 时，默认值按这台机器能用的来（命令行里截不了图，封面默认就不是排版截图）。
 * @param {string} id
 * @param {{ config?: any, hasRenderer?: boolean }} [ctx]
 * @returns {{ name: string, description: string, inputs: Array<{ name: string, label: string, type: string, options?: string[], default?: string|string[], required: boolean }>, steps: Array<{ name: string, title: string, phase: string, prompt: string }> }|null}
 */
function workflowOf(id, ctx) {
  const r = get(id);
  if (!r) return null;
  const fields = ctx ? (/** @type {Form} */ (formFor(r.id, ctx))).fields : r.fields;
  return {
    name: r.id,
    description: `${r.title}：${r.blurb}`,
    inputs: fields.map((f) => ({
      name: f.name, label: f.label, type: f.type,
      ...(f.options ? { options: f.options.map((o) => o.v) } : {}),
      // 单选一条都用不了时默认是空串：不写 default，免得流程文件校验说「默认值不在选项里」
      ...(f.type === "select" && f.default === "" ? {} : { default: Array.isArray(f.default) ? f.default.slice() : f.default }),
      required: !!f.required,
    })),
    steps: (STEPS[r.id] || []).map((s) => ({ name: s.name, title: s.title, phase: s.phase, prompt: stepHead(r) + s.text })),
  };
}

module.exports = {
  BUILTIN, get, list, formFor, estimate, parseAnswer, summary, askForm, coveredAsk, pinBlock,
  restore, applyLimits, workflowOf, defaultValues,
  FORM_FILE, PRESET_RE, HARD, FALLBACK_GO, FALLBACK_EDIT,
  _internals: { coerce, matchOpt, paidItems, capsReady, brandNames, cleanValues, REASON, STEPS },
};
