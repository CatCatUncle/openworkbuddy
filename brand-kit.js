// @ts-check
"use strict";
/**
 * 产品品牌档案（brand kit + 事实卡）：一个产品的名字、一句话、卖点（带出处）、配色、字体、口吻、禁用词……
 *
 * 为什么要有它：同一个产品，这周做小红书卡片、下周剪宣传片，每次都从头跟 agent 讲一遍配色和卖点，
 * 讲漏一次就出一张「颜色不对、数字是它自己估的」的图。档案把这些钉在一份文件里，提到这个产品时
 * 自动把 ≤300 字的摘要放进提示词，交付前还能拿同一份档案逐条查。
 *
 * 放在哪：
 *   - 项目档案  <项目>/.openworkbuddy/brand.json，素材放同目录 brand/ 下。从工作目录往上找到 git 根为止，
 *               规则和 project-memo 一样：不在 git 仓库里就只看工作目录这一层
 *   - 全局档案  <数据目录>/data/brands/<slug>/brand.json。跟着搬家和备份走，测试里跟着临时家走，
 *               所以不放 ~/.openworkbuddy（那里跨实例共享、测试也隔离不住）
 *   同 slug 两边都有时项目那份说了算。
 *
 * 三条硬规矩：
 *   1. 带数字或比较的卖点必须有出处（链接或档案里的文件），没出处的存不进，更进不了摘要——
 *      档案会被读进每一轮提示词，编出来的「10 万用户」一旦进来，之后每份文案都会复读它
 *   2. 存档一律弹卡、人点头才落盘，ruleKey 留空，批过「写文件这类都允许」也绕不过去：
 *      档案常常是从网页上抓来的，一句藏在卖点里的「忽略之前的指令」会在每一轮里生效
 *   3. 摘要只进提示词的易变段（stableSystem 之后），不碰稳定段，前缀缓存不受影响
 *
 * 不 require ./tools：tools.js 要 require 这里，反过来就是循环依赖。审批、路径解析都由调用方从 ctx 递进来。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pathToFileURL } = require("url");
const { dataPath } = require("./paths");
const { chainToGitRoot, warnOnce } = require("./project-memo");
const { looksSecret } = require("./memory");
const guard = require("./skill-guard");
const { shrinkPng, pngInfo } = require("./thumb-png");

const SCHEMA_VERSION = 1;
/** 注入提示词的摘要上限（按码点数）。两份档案一起进来时两份分这一个额度 */
const DIGEST_MAX = 300;
const KIT_MAX_BYTES = 64 * 1024;
/** 一轮最多带几份档案：再多就是在拿别的产品的配色污染这一份 */
const MAX_KITS = 2;
const STICKY_MAX = 256;
const LOOKBACK = 6;

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp"];
const LOGO_EXT = [".png", ".svg", ".webp", ".jpg", ".jpeg"];
/** @type {Record<string, string>} */
const FONT_EXT = { ".ttf": "truetype", ".otf": "opentype", ".woff": "woff", ".woff2": "woff2" };
const EVIDENCE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf", ".txt", ".md", ".html", ".htm"];
const IMAGE_CAP = 5 * 1024 * 1024;
const FONT_CAP = 20 * 1024 * 1024;
const FONT_WARN = 15 * 1024 * 1024;
const TOTAL_CAP = 50 * 1024 * 1024;
const ROLES = ["primary", "text", "bg", "accent"];
/** @type {Record<string, string>} */
const ROLE_LABEL = { primary: "主色", text: "文字", bg: "背景", accent: "点缀" };
const KNOWN_KEYS = [
  "schema", "name", "slug", "aliases", "one_liner", "audience", "selling_points", "links", "screenshots", "logo",
  "colors", "fonts", "voice", "tone", "signature", "cta", "banned_words", "compliance_notes", "updated_at",
];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const CJK_RE = /[\u{3400}-\u{9FFF}\u{F900}-\u{FAFF}]/u;
// 从网页复制来的零宽字符：屏幕上看不见，进了提示词模型却看得见。存档时直接剥掉
const ZERO_WIDTH_RE = /[\u{200B}-\u{200D}\u{2060}\u{FEFF}]/gu;
/**
 * 「这句卖点在比、在报数」：带数字、百分号、倍数、第一/最/唯一/领先这类词。
 * 命中就必须给出处。宁可多要一次出处，也别让一个估出来的数进档案。
 */
const CLAIM_RE = /\d|[%％倍×]|第一|最[好强快佳大多高低少新全优受便]|唯一|首款|首个|首家|领先|遥遥|no\.?\s*1\b|top\s*\d|#1\b|\bbest\b|fastest|leading|number\s+one|world'?s\s+first/i;
// 别名太常见，聊天里随口一说就会把这份档案带进来
const ALIAS_STOP = new Set([
  "app", "ai", "pro", "plus", "max", "mini", "lite", "go", "one", "the", "home", "tool", "tools", "bot", "web", "desktop",
  "工具", "助手", "产品", "我们", "平台", "软件", "应用", "系统", "项目", "小程序", "官网",
]);

// ────────────────────────────── 小工具 ──────────────────────────────

/** @param {any} v @returns {string} */
function str(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" ? v.replace(ZERO_WIDTH_RE, "").trim() : "";
}
/** 码点数：一个汉字、一个 emoji 都算 1，跟人数字的直觉一致 @param {string} s */
function len(s) { return Array.from(s).length; }
/** @param {string} s @param {number} n */
function cut(s, n) {
  const a = Array.from(s);
  return a.length <= n ? s : a.slice(0, Math.max(0, n - 1)).join("") + "…";
}
/** 判重、匹配都在这一层上做：全角半角、大小写不该让同一个词认不出来 @param {any} s */
function norm(s) { return String(s == null ? "" : s).normalize("NFKC").toLowerCase(); }
/** @param {string} s */
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
/** 传进来的可能是 KitEntry 也可能直接是 kit @param {any} x @returns {any} */
function kitOf(x) { return x && x.kit && typeof x.kit === "object" ? x.kit : x && typeof x === "object" ? x : null; }
/** @param {any} p */
function isClaim(p) { return CLAIM_RE.test(norm(p)); }

/**
 * 档案里的文件路径：只认档案目录下的相对路径。
 * 绝对路径、带 ..、~ 开头的一律不收：logo 写成 ../../.ssh/id_rsa，下游读素材的工具就会把私钥当图片读走
 * @param {any} p @returns {{ok: boolean, rel?: string, why?: string}}
 */
function kitRel(p) {
  const s = str(p).replace(/\\/g, "/");
  if (!s) return { ok: false, why: "是空的" };
  if (path.isAbsolute(s) || s.startsWith("/") || s.startsWith("~") || /^[a-zA-Z]:/.test(s) || /^[a-z]+:\/\//i.test(s)) {
    return { ok: false, why: "得是档案目录下的相对路径（比如 brand/logo.svg），不能是绝对路径" };
  }
  if (s.split("/").includes("..")) return { ok: false, why: "不能带 ..，只能指向档案目录里面" };
  const rel = path.posix.normalize(s).replace(/^(\.\/)+/, "");
  if (!rel || rel === "." || rel.startsWith("../")) return { ok: false, why: "没指向档案目录里的文件" };
  return { ok: true, rel };
}

/** 真落在 dir 里面（含软链解开之后） @param {string} dir @param {string} rel */
function insideDir(dir, rel) {
  const base = path.resolve(dir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  try {
    const real = fs.realpathSync(abs);
    const realBase = fs.realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) return null;
  } catch { /* 文件不存在：交给调用方判 */ }
  return abs;
}

// ────────────────────────────── 校验 ──────────────────────────────

/**
 * 把一份原始档案整理成 v1 形状，并列出问题。
 *   problems：存不进的理由（存档时有一条就不存、不弹卡）
 *   warnings：提醒，不挡
 *   fatal：读盘时这份整个不用（没名字、slug 坏了、像有密钥、太大）；其余问题读盘时只丢那一项
 * 不合规的条目从 kit 里剔掉；唯一例外是「带数字但没出处」的卖点——留着给人看，但摘要和查稿都不认它
 * @param {any} raw
 * @param {{dir?: string, checkFiles?: boolean}} [opts]
 * @returns {{ok: boolean, kit: any, problems: string[], warnings: string[], fatal: boolean}}
 */
function validate(raw, opts = {}) {
  /** @type {string[]} */ const problems = [];
  /** @type {string[]} */ const warnings = [];
  let fatal = false;
  /** @type {any} */ const kit = { schema: SCHEMA_VERSION };
  let src = raw;
  if (typeof src === "string") {
    try { src = JSON.parse(src); } catch (e) {
      return { ok: false, kit, problems: [`档案不是合法的 JSON：${e && e.message}`], warnings, fatal: true };
    }
  }
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return { ok: false, kit, problems: ["档案得是一个 JSON 对象，至少有 name 和 slug"], warnings, fatal: true };
  }
  const dir = opts.dir ? path.resolve(opts.dir) : "";
  const checkFiles = !!(opts.checkFiles && dir);

  for (const k of Object.keys(src)) if (!KNOWN_KEYS.includes(k)) warnings.push(`不认识的字段「${cut(k, 24)}」，已丢掉`);
  if (src.schema != null && Number(src.schema) !== SCHEMA_VERSION) {
    warnings.push(`档案标的格式版本是 ${cut(String(src.schema), 8)}，这里按 v1 读，认不出的字段会丢`);
  }

  /** 文字字段：超长算问题（不悄悄截——截掉的可能正好是那半句限定语） */
  const text = (/** @type {string} */ key, /** @type {string} */ label, /** @type {number} */ max) => {
    const v = str(src[key]);
    if (!v) return;
    if (len(v) > max) problems.push(`${label}超过 ${max} 字（现在 ${len(v)} 字）`);
    kit[key] = v;
  };
  /**
   * 档案内文件：路径合规 + 扩展名对 + （要查的话）文件在
   * @param {any} p @param {string} label @param {string[]} exts @returns {string}
   */
  const fileField = (p, label, exts) => {
    const r = kitRel(p);
    if (!r.ok) { problems.push(`${label}「${cut(str(p), 40)}」${r.why}`); return ""; }
    const rel = r.rel;
    if (exts.length && !exts.includes(path.extname(rel).toLowerCase())) {
      problems.push(`${label}「${cut(rel, 40)}」格式不对，只收 ${exts.join(" / ")}`);
      return "";
    }
    if (dir) {
      const abs = insideDir(dir, rel);
      if (!abs) { problems.push(`${label}「${cut(rel, 40)}」指到档案目录外面去了`); return ""; }
      if (checkFiles) {
        let st = null;
        try { st = fs.statSync(abs); } catch {}
        if (!st || !st.isFile()) { problems.push(`${label}「${cut(rel, 40)}」这个文件不存在`); return ""; }
      }
    }
    return rel;
  };

  // name / slug：认档案全靠这两样，坏了整份不用
  const name = str(src.name);
  if (!name) { problems.push("缺产品名（name）"); fatal = true; }
  else if (len(name) > 40) { problems.push(`产品名超过 40 字`); fatal = true; }
  kit.name = cut(name, 40);
  const slug = str(src.slug);
  if (!SLUG_RE.test(slug)) {
    problems.push(`slug「${cut(slug, 40)}」不合规：只能用小写字母、数字、连字符，2–40 位，字母或数字开头`);
    fatal = true;
  }
  kit.slug = slug;

  // 别名：太短的会在聊天里误触发
  if (src.aliases != null) {
    const list = Array.isArray(src.aliases) ? src.aliases : [src.aliases];
    if (list.length > 12) problems.push(`别名最多 12 个（现在 ${list.length} 个）`);
    /** @type {string[]} */ const out = [];
    const seen = new Set();
    for (const a0 of list.slice(0, 12)) {
      const a = str(a0);
      if (!a) continue;
      const n = norm(a);
      if (seen.has(n)) continue;
      seen.add(n);
      if (!tokenLongEnough(n)) { problems.push(`别名「${cut(a, 20)}」太短，容易误触发（中文至少 2 个字，英文至少 3 个字母）`); continue; }
      if (len(a) > 40) { problems.push(`别名「${cut(a, 20)}」超过 40 字`); continue; }
      if (ALIAS_STOP.has(n)) warnings.push(`别名「${a}」太常见，聊天里随口一提就会带上这份档案`);
      out.push(a);
    }
    if (out.length) kit.aliases = out;
  }

  // 一句话：给个字符串也认，按里头有没有汉字归到 zh / en
  if (src.one_liner != null) {
    /** @type {any} */ let ol = src.one_liner;
    if (typeof ol === "string") ol = CJK_RE.test(ol) ? { zh: ol } : { en: ol };
    /** @type {any} */ const o = {};
    for (const l of ["zh", "en"]) {
      const v = str(ol && ol[l]);
      if (!v) continue;
      if (len(v) > 80) problems.push(`一句话介绍（${l}）超过 80 字`);
      o[l] = v;
    }
    if (o.zh || o.en) kit.one_liner = o;
  }
  if (!kit.one_liner) problems.push("一句话介绍（one_liner）至少写一种语言（zh 或 en）");

  text("audience", "目标用户（audience）", 120);

  // 卖点：带数字或比较的必须有出处
  if (src.selling_points != null) {
    const list = Array.isArray(src.selling_points) ? src.selling_points : [src.selling_points];
    if (list.length > 8) problems.push(`卖点最多 8 条（现在 ${list.length} 条）：挑最硬的 8 条`);
    /** @type {any[]} */ const out = [];
    for (const p0 of list.slice(0, 8)) {
      /** @type {any} */ const p = typeof p0 === "string" ? { text: p0 } : p0 || {};
      const t = str(p.text);
      if (!t) continue;
      if (len(t) > 80) { problems.push(`卖点「${cut(t, 24)}」超过 80 字`); continue; }
      /** @type {any} */ const item = { text: t };
      const s = str(p.source);
      if (s) {
        if (URL_RE.test(s)) item.source = s;
        else {
          const f = fileField(s, `卖点「${cut(t, 16)}」的出处`, EVIDENCE_EXT);
          if (f) item.source = f;
        }
      }
      if (!item.source && isClaim(t)) problems.push(`卖点「${cut(t, 24)}」带数字或比较，得给出处（链接或文件）`);
      const c = str(p.checked_at);
      if (c) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(c)) item.checked_at = c;
        else warnings.push(`卖点「${cut(t, 16)}」的核实日期「${cut(c, 20)}」要写成 YYYY-MM-DD，已丢掉`);
      }
      out.push(item);
    }
    if (out.length) kit.selling_points = out;
  }

  if (src.links != null) {
    const list = Array.isArray(src.links) ? src.links : [src.links];
    if (list.length > 10) problems.push(`链接最多 10 条（现在 ${list.length} 条）`);
    /** @type {any[]} */ const out = [];
    for (const l0 of list.slice(0, 10)) {
      /** @type {any} */ const l = typeof l0 === "string" ? { url: l0 } : l0 || {};
      const url = str(l.url);
      if (!URL_RE.test(url)) { problems.push(`链接「${cut(url || str(l.label), 40)}」不是 http(s) 地址`); continue; }
      let label = str(l.label);
      if (!label) { try { label = new URL(url).hostname; } catch { label = "链接"; } }
      if (len(label) > 20) problems.push(`链接名「${cut(label, 20)}」超过 20 字`);
      out.push({ label: cut(label, 20), url });
    }
    if (out.length) kit.links = out;
  }

  if (src.screenshots != null) {
    const list = Array.isArray(src.screenshots) ? src.screenshots : [src.screenshots];
    if (list.length > 12) problems.push(`截图最多 12 张（现在 ${list.length} 张）`);
    const out = list.slice(0, 12).map((s) => fileField(s, "截图", IMAGE_EXT)).filter(Boolean);
    if (out.length) kit.screenshots = out;
  }

  if (src.logo != null) {
    /** @type {any} */ const lg = typeof src.logo === "string" ? { light: src.logo } : src.logo || {};
    /** @type {any} */ const o = {};
    for (const k of ["light", "dark"]) {
      if (!str(lg[k])) continue;
      const f = fileField(lg[k], `logo（${k}）`, LOGO_EXT);
      if (f) o[k] = f;
    }
    if (o.light || o.dark) kit.logo = o;
  }

  // 配色：最多 4 色。多了就不叫品牌色了，出图时模型会每样都用一点
  if (src.colors != null) {
    const list = Array.isArray(src.colors) ? src.colors : [src.colors];
    if (list.length > 4) problems.push(`配色最多 4 色（现在 ${list.length} 色）：主色、文字、背景、点缀各一就够了`);
    /** @type {any[]} */ const out = [];
    const roles = new Set();
    for (const c0 of list.slice(0, 4)) {
      /** @type {any} */ const c = typeof c0 === "string" ? { hex: c0 } : c0 || {};
      const hex = str(c.hex);
      if (!HEX_RE.test(hex)) { problems.push(`颜色「${cut(hex || str(c.name), 20)}」要写成 #RRGGBB 六位十六进制`); continue; }
      /** @type {any} */ const item = { name: cut(str(c.name), 10), hex: hex.toUpperCase() };
      if (len(str(c.name)) > 10) warnings.push(`颜色名「${cut(str(c.name), 10)}」超过 10 字，已截短`);
      const role = str(c.role);
      if (role) {
        if (!ROLES.includes(role)) warnings.push(`颜色 ${item.hex} 的用途「${cut(role, 12)}」不认识（只认 primary / text / bg / accent），已丢掉`);
        else if (roles.has(role)) warnings.push(`用途 ${role} 出现了两次，后一个（${item.hex}）不算`);
        else { roles.add(role); item.role = role; }
      }
      out.push(item);
    }
    if (out.length) kit.colors = out;
  }
  if (!kit.colors) warnings.push("没配色：出图时只能用系统默认色");

  // 字体：只收档案里的本地文件。从网上拉字体既有版权问题，出图时也未必连得上
  if (src.fonts != null) {
    /** @type {any} */ const fo = src.fonts || {};
    /** @type {any} */ const o = {};
    for (const k of ["zh", "en"]) {
      if (!str(fo[k])) continue;
      if (/^https?:/i.test(str(fo[k]))) { problems.push(`字体（${k}）只收档案里的本地字体文件，不从网上拉`); continue; }
      const f = fileField(fo[k], `字体（${k}）`, Object.keys(FONT_EXT));
      if (!f) continue;
      o[k] = f;
      if (checkFiles) {
        try { if (fs.statSync(path.join(dir, f)).size > FONT_WARN) warnings.push(`字体（${k}）超过 15 MB，出图会慢；能子集化就子集化`); } catch {}
      }
    }
    if (o.zh || o.en) kit.fonts = o;
  }

  if (src.voice != null) {
    /** @type {any} */ const v = src.voice || {};
    /** @type {any} */ const o = {};
    const tv = str(v.tts_voice);
    if (tv) { if (len(tv) > 60) problems.push("配音音色名（voice.tts_voice）超过 60 字"); o.tts_voice = cut(tv, 60); }
    if (v.speed != null && v.speed !== "") {
      const sp = Number(v.speed);
      if (!Number.isFinite(sp) || sp < 0.5 || sp > 2) problems.push(`语速（voice.speed）要在 0.5–2 之间（现在是 ${cut(String(v.speed), 10)}）`);
      else o.speed = sp;
    }
    if (o.tts_voice || o.speed) kit.voice = o;
  }

  text("tone", "口吻（tone）", 120);
  // 署名默认留空：这是开源软件，写死一个人的署名等于在每个用户的内容上盖作者的章
  text("signature", "署名（signature）", 20);
  text("cta", "行动号召（cta）", 40);

  /** @param {string} key @param {string} label @param {number} maxN @param {number} maxLen */
  const strList = (key, label, maxN, maxLen) => {
    if (src[key] == null) return;
    const list = Array.isArray(src[key]) ? src[key] : [src[key]];
    if (list.length > maxN) problems.push(`${label}最多 ${maxN} 条（现在 ${list.length} 条）`);
    /** @type {string[]} */ const out = [];
    const seen = new Set();
    for (const x of list.slice(0, maxN)) {
      const v = str(x);
      if (!v || seen.has(norm(v))) continue;
      seen.add(norm(v));
      if (len(v) > maxLen) { problems.push(`${label}「${cut(v, 20)}」超过 ${maxLen} 字`); continue; }
      out.push(v);
    }
    if (out.length) kit[key] = out;
  };
  strList("banned_words", "禁用词", 50, 20);
  strList("compliance_notes", "合规说明", 10, 80);

  const ua = str(src.updated_at);
  if (ua && !Number.isNaN(Date.parse(ua))) kit.updated_at = ua;

  // 密钥：档案每轮都进提示词，也会跟着项目目录被同步、被打包
  for (const s of flatStrings(kit)) {
    if (looksSecret(s.text)) { problems.push(`档案里像是有密钥或口令，别存进来（${s.where}）`); fatal = true; break; }
  }
  const bytes = Buffer.byteLength(JSON.stringify(kit, null, 2));
  if (bytes > KIT_MAX_BYTES) { problems.push(`档案太大（${Math.round(bytes / 1024)} KB，上限 64 KB）：长文放文件里，档案里只放链接`); fatal = true; }

  return { ok: problems.length === 0, kit, problems, warnings, fatal };
}

/** 档案里所有的字，带上它在哪（报问题时指得出位置） @param {any} v @param {string} [where] @returns {{where: string, text: string}[]} */
function flatStrings(v, where = "") {
  /** @type {{where: string, text: string}[]} */ const out = [];
  if (typeof v === "string") out.push({ where: where || "档案", text: v });
  else if (Array.isArray(v)) v.forEach((x, i) => out.push(...flatStrings(x, `${where}[${i}]`)));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) out.push(...flatStrings(v[k], where ? `${where}.${k}` : k));
  return out;
}

/**
 * 档案里的话会被原样读进每一轮提示词，所以用技能扫描器再过一遍。
 * 拦得比技能更严：block 级之外，「冲着 agent 去」的那一类（忽略之前的指令、别告诉用户、跳过确认……）
 * 和藏在注释里的话也一律不收——一份品牌档案里没有任何正当理由写这些
 * @param {any} kit @returns {{refuse: any[], notes: any[]}}
 */
function guardScan(kit) {
  const body = flatStrings(kit).map((s) => s.text).join("\n");
  const rep = guard.scanOne("brand.md", body);
  const refuse = rep.findings.filter((f) => f.level === "block" || f.cat === "inject" || f.rule === "html-comment-instruction");
  const notes = rep.findings.filter((f) => !refuse.includes(f));
  return { refuse, notes };
}

// ────────────────────────────── 读盘 ──────────────────────────────

function registryDir() {
  return process.env.OPENWORKBUDDY_BRANDS_DIR || path.join(process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data"), "brands");
}

/** 工作目录，再往上直到 git 根（近的在前），每层的 .openworkbuddy @param {string} cwd @returns {string[]} */
function projectCandidates(cwd) {
  if (!cwd) return [];
  const start = path.resolve(cwd);
  /** @type {string[]} */ const out = [];
  for (const d of [start, ...chainToGitRoot(start).slice().reverse()]) {
    const k = path.join(d, ".openworkbuddy");
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** 每轮都要读一次，所以按文件缓存，stat 对得上就不重新解析 @type {Map<string, {mtimeMs: number, ctimeMs: number, size: number, res: any}>} */
const CACHE = new Map();

/** @param {string} file @param {"project"|"user"} scope @returns {null | {skip: string} | {entry: any}} */
function readKitFile(file, scope) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = CACHE.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.size === st.size) return hit.res;
  const res = parseKitFile(file, scope, st.size);
  CACHE.set(file, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, res });
  if (CACHE.size > 512) CACHE.delete(CACHE.keys().next().value);
  return res;
}

/** @param {string} file @param {"project"|"user"} scope @param {number} size */
function parseKitFile(file, scope, size) {
  if (size > KIT_MAX_BYTES) return { skip: `档案超过 64 KB，没读` };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { skip: `不是合法的 JSON：${cut(String(e && e.message), 80)}` }; }
  const dir = path.dirname(file);
  const v = validate(raw, { dir, checkFiles: true });
  if (v.fatal) return { skip: v.problems[0] || "档案坏了" };
  // 手改过的档案绕过了存档那道卡，读的时候再扫一遍，扫出冲着 agent 去的话就整份不用
  const g = guardScan(v.kit);
  if (g.refuse.length) return { skip: `里头有不该进提示词的话：${g.refuse[0].why}` };
  const warnings = v.warnings.concat(v.problems.map((p) => `${p}（这一项先不用）`));
  if (scope === "user" && path.basename(dir) !== v.kit.slug) warnings.push(`目录名 ${path.basename(dir)} 和 slug ${v.kit.slug} 不一致`);
  return { entry: { slug: v.kit.slug, name: v.kit.name, scope, dir, file, kit: v.kit, warnings } };
}

/**
 * 找得到的全部档案。项目的在前（近的优先），全局的在后；同 slug 只留一份。永不抛
 * @param {{cwd?: string, registry?: string}} [opts]
 * @returns {{list: any[], skipped: {file: string, why: string}[]}}
 */
function loadAll(opts = {}) {
  /** @type {any[]} */ const list = [];
  /** @type {{file: string, why: string}[]} */ const skipped = [];
  try {
    const seen = new Set();
    for (const d of projectCandidates(opts.cwd || "")) {
      const file = path.join(d, "brand.json");
      const r = readKitFile(file, "project");
      if (!r) continue;
      if ("skip" in r) { skipped.push({ file, why: r.skip }); continue; }
      if (seen.has(r.entry.slug)) { skipped.push({ file, why: `离工作目录更近的项目档案也叫 ${r.entry.slug}，用近的那份` }); continue; }
      seen.add(r.entry.slug);
      list.push(r.entry);
    }
    const reg = opts.registry || registryDir();
    /** @type {string[]} */ let names = [];
    try { names = fs.readdirSync(reg, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch {}
    for (const n of names) {
      const file = path.join(reg, n, "brand.json");
      const r = readKitFile(file, "user");
      if (!r) continue;
      if ("skip" in r) { skipped.push({ file, why: r.skip }); continue; }
      if (seen.has(r.entry.slug)) { skipped.push({ file, why: "被项目档案覆盖" }); continue; }
      seen.add(r.entry.slug);
      list.push(r.entry);
    }
  } catch (e) {
    skipped.push({ file: "", why: `读档案时出错：${e && e.message}` });
  }
  return { list, skipped };
}

/**
 * 按 slug 取一份；slug 没对上时名字、别名完全相同也认（模型常拿产品名当 slug 传）
 * @param {string} slug @param {{cwd?: string, registry?: string}} [opts] @returns {any}
 */
function get(slug, opts = {}) {
  const want = norm(str(slug));
  if (!want) return null;
  const { list } = loadAll(opts);
  return list.find((e) => e.slug === want)
    || list.find((e) => norm(e.name) === want || (e.kit.aliases || []).some((/** @type {string} */ a) => norm(a) === want))
    || null;
}

// ────────────────────────────── 认出「这次说的是哪个产品」 ──────────────────────────────

/** @param {string} t 已 norm 过 */
function tokenLongEnough(t) {
  return CJK_RE.test(t) ? len(t.replace(/\s+/g, "")) >= 2 : t.replace(/[^a-z0-9]/g, "").length >= 3;
}
/** 中文按子串认；英文按词边界认，不然别名 OWB 会在 rowboat 里被认出来 @param {string} hay @param {string} t */
function hasToken(hay, t) {
  if (CJK_RE.test(t)) return hay.includes(t);
  return new RegExp(`(?<![a-z0-9_\\u00c0-\\u024f])${escRe(t)}(?![a-z0-9_\\u00c0-\\u024f])`).test(hay);
}
const MARK_RE = /【\s*产品\s*[:：]\s*([^】\n]{1,40})】|\[\s*brand\s*:\s*([^\]\n]{1,40})\]|(?<![a-z0-9_])brand\s*:\s*([a-z0-9][a-z0-9-]{1,39})/g;

/**
 * 一段话里提到了哪些产品（返回 slug，按档案顺序）
 * @param {string} text @param {any[]} entries @returns {string[]}
 */
function detect(text, entries) {
  const hay = norm(text);
  if (!hay || !Array.isArray(entries) || !entries.length) return [];
  /** 显式点名：【产品：X】/ [brand:x] / brand:x——哪怕 X 短到不能当别名用 */
  const marked = new Set();
  for (const m of hay.matchAll(MARK_RE)) marked.add((m[1] || m[2] || m[3] || "").trim());
  /** @type {string[]} */ const out = [];
  for (const e of entries) {
    const toks = [e.kit.name, e.slug, ...(e.kit.aliases || [])].map(norm).filter(Boolean);
    const hit = toks.some((t) => marked.has(t)) || toks.some((t) => tokenLongEnough(t) && hasToken(hay, t));
    if (hit && !out.includes(e.slug)) out.push(e.slug);
  }
  return out;
}

/** 用户最近几轮真正说的话（跳过系统包装，口径同 agent.js currentAsk） @param {any[]} history @param {number} n */
function recentUserTexts(history, n) {
  /** @type {string[]} */ const out = [];
  for (let i = history.length - 1; i >= 0 && out.length < n; i--) {
    const e = history[i];
    if (!e || e.role !== "user") continue;
    let c = typeof e.content === "string" ? e.content
      : Array.isArray(e.content) ? e.content.map((/** @type {any} */ p) => (p && typeof p.text === "string" ? p.text : "")).join("\n") : "";
    c = c.trim();
    if (!c) continue;
    if (c.startsWith("【系统")) {
      const m = /【最近的用户指令原文】([^\n]*)/.exec(c);
      if (m && m[1].trim()) out.push(m[1]);
      continue;
    }
    if (c.startsWith("【目标验收")) continue;
    if (c.startsWith("【用户插话")) c = c.replace(/^【用户插话[^】]*】/, "");
    out.push(c);
  }
  return out;
}

/** 之前调过 brand_kit_* 的那个 slug：上一轮查过的档案，这一轮多半还在用 @param {any[]} history */
function toolSlugs(history) {
  /** @type {string[]} */ const out = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (!e || e.role !== "assistant" || !Array.isArray(e.toolCalls)) continue;
    for (const tc of e.toolCalls) {
      if (!tc || (tc.name !== "brand_kit_read" && tc.name !== "brand_kit_save")) continue;
      /** @type {any} */ let inp = tc.input;
      if (typeof inp === "string") { try { inp = JSON.parse(inp); } catch { inp = {}; } }
      /** @type {any} */ let k = inp && inp.kit;
      if (typeof k === "string") { try { k = JSON.parse(k); } catch { k = null; } }
      const s = norm(str((inp && inp.slug) || (k && k.slug)));
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/**
 * 这一轮带哪几份档案：本项目的档案总在最前，然后是最近 6 轮用户话里提到的（新的在前），
 * 再然后是之前工具调用里点过名的。最多 2 份
 * @param {any[]} history @param {any[]} entries @param {{lookback?: number}} [opts] @returns {string[]}
 */
function pickForHistory(history, entries, opts = {}) {
  const hist = Array.isArray(history) ? history : [];
  const list = Array.isArray(entries) ? entries : [];
  /** @type {string[]} */ const out = [];
  const add = (/** @type {string} */ s) => { if (s && out.length < MAX_KITS && !out.includes(s) && list.some((e) => e.slug === s)) add0(s); };
  const add0 = (/** @type {string} */ s) => out.push(s);
  const proj = list.find((e) => e.scope === "project");
  if (proj) add(proj.slug);
  for (const t of recentUserTexts(hist, opts.lookback || LOOKBACK)) for (const s of detect(t, list)) add(s);
  for (const s of toolSlugs(hist)) {
    const e = list.find((x) => x.slug === s || norm(x.name) === s);
    if (e) add(e.slug);
  }
  return out;
}

// ────────────────────────────── 摘要 + 提示词块 ──────────────────────────────

/** 能进摘要的卖点：不带数字的，或者带了但有出处的 @param {any} kit @returns {any[]} */
function usablePoints(kit) {
  return (kit && Array.isArray(kit.selling_points) ? kit.selling_points : []).filter((p) => p && p.text && (p.source || !isClaim(p.text)));
}

/**
 * ≤300 字的摘要，按重要程度往里装：名字和一句话 → 有出处的卖点 → 配色 → 口吻 → 行动号召 → 署名 → 禁用词 → 合规。
 * 装不下的整条不要，不切半句；色值更不能切成半个（#FF6 比没有更糟）
 * @param {any} kitOrEntry @param {{lang?: string, max?: number}} [opts] @returns {string}
 */
function digest(kitOrEntry, opts = {}) {
  const kit = kitOf(kitOrEntry);
  if (!kit || !kit.name) return "";
  const max = Math.max(40, Math.min(DIGEST_MAX, Number(opts.max) || DIGEST_MAX));
  const en = opts.lang === "en";
  /** @type {string[]} */ const lines = [];
  let used = 0;
  const fits = (/** @type {string} */ s) => used + len(s) + (lines.length ? 1 : 0) <= max;
  const push = (/** @type {string} */ s) => { if (!s || !fits(s)) return false; used += len(s) + (lines.length ? 1 : 0); lines.push(s); return true; };
  /** 一行里装尽量多的条目：整条整条地加 @param {string} label @param {string[]} items @param {string} sep */
  const pushList = (label, items, sep) => {
    let line = "";
    for (const it of items) {
      const next = line ? line + sep + it : label + it;
      if (!fits(next)) break;
      line = next;
    }
    if (line) push(line);
  };
  /** 长文本：装得下整句就整句，装不下且剩的地方还够说点什么就截 @param {string} label @param {string} s */
  const pushText = (label, s) => {
    if (!s) return;
    if (push(label + s)) return;
    const room = max - used - (lines.length ? 1 : 0) - len(label);
    if (room >= 12) push(label + cut(s, room));
  };

  const ol = kit.one_liner || {};
  const one = en ? ol.en || ol.zh : ol.zh || ol.en;
  push(cut(kit.name + (one ? "：" + one : ""), max));
  pushList("卖点：", usablePoints(kit).map((p) => p.text), "；");
  pushList("配色：", (kit.colors || []).map((/** @type {any} */ c) => `${c.name || ROLE_LABEL[c.role] || "色"}${c.hex}`), " ");
  pushText("口吻：", kit.tone);
  pushText("行动号召：", kit.cta);
  if (kit.signature) push(`署名：${kit.signature}`);
  pushList("禁用词：", kit.banned_words || [], "、");
  if (kit.compliance_notes && kit.compliance_notes[0]) pushText("合规：", kit.compliance_notes[0]);
  return lines.join("\n");
}

/** runToken → 这趟任务选中的档案。专家子任务拿到的历史只有一句任务描述，靠它接上父任务的档案 @type {Map<any, string[]>} */
const STICKY = new Map();

/**
 * 提示词里的品牌块。没选中任何档案就是空串
 * @param {{history?: any[], cwd?: string, registry?: string, runToken?: any, lang?: string, viaTool?: boolean}} [opts]
 * @returns {string}
 */
function promptBlock(opts = {}) {
  const { list } = loadAll({ cwd: opts.cwd || "", registry: opts.registry });
  if (!list.length) return "";
  const picks = pickForHistory(opts.history || [], list, { lookback: LOOKBACK });
  const tok = opts.runToken;
  if (tok != null && tok !== "") {
    for (const s of STICKY.get(tok) || []) if (picks.length < MAX_KITS && !picks.includes(s) && list.some((e) => e.slug === s)) picks.push(s);
    if (picks.length) {
      STICKY.delete(tok);
      STICKY.set(tok, picks.slice());
      while (STICKY.size > STICKY_MAX) STICKY.delete(STICKY.keys().next().value);
    }
  }
  if (!picks.length) return "";
  const entries = picks.map((s) => list.find((e) => e.slug === s)).filter(Boolean);
  // 两份一起来时平分额度（连中间那个换行一起算）：注入的摘要合计不超过 DIGEST_MAX
  const per = Math.floor((DIGEST_MAX - (entries.length - 1)) / entries.length);
  const body = entries.map((e) => digest(e, { lang: opts.lang, max: per })).join("\n");
  const where = opts.viaTool === false
    ? `完整档案在 ${entries.map((e) => e.file).join("；")}`
    : `完整档案：brand_kit_read get ${entries.map((e) => `slug=${e.slug}`).join(" / ")}`;
  return `\n\n## 品牌档案（本次涉及：${entries.map((e) => e.name).join("、")}）\n${body}\n` +
    `规矩：文案里的数字、排名、背书只用档案里带出处的；档案没有的不写不估。配色/字体/口吻/禁用词照档案（和长期记忆说法不一样时以档案为准）。${where}`;
}

/** 同上，但永不抛：档案读坏了不能让任务起不来 @param {Parameters<typeof promptBlock>[0]} [opts] */
function safePromptBlock(opts = {}) {
  try { return promptBlock(opts); } catch (e) {
    warnOnce("brand-kit:prompt", `[brand-kit] 品牌档案没能放进提示词：${e && e.message}`);
    return "";
  }
}

// ────────────────────────────── 给出图/出片的工具用 ──────────────────────────────

const SYSTEM_STACK = `-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif`;

/** 档案字体在 CSS 里叫什么。用 slug 起名，纯 ASCII，引号里不会出岔子 @param {any} x @returns {string[]} */
function fontFamilies(x) {
  const kit = kitOf(x);
  if (!kit || !kit.fonts || !kit.slug) return [];
  return ["en", "zh"].filter((k) => kit.fonts[k]).map((k) => `brand-${kit.slug}-${k}`);
}

/** `:root{--brand-primary:…}`。没写用途时第一色当主色 @param {any} x @returns {string} */
function cssVars(x) {
  const kit = kitOf(x);
  if (!kit) return "";
  const cols = Array.isArray(kit.colors) ? kit.colors : [];
  /** @type {Record<string, string>} */ const byRole = {};
  for (const c of cols) if (c.role && !byRole[c.role]) byRole[c.role] = c.hex;
  if (!byRole.primary && cols[0]) byRole.primary = cols[0].hex;
  /** @type {string[]} */ const vars = [];
  for (const r of ROLES) if (byRole[r]) vars.push(`--brand-${r}:${byRole[r]}`);
  cols.forEach((/** @type {any} */ c, /** @type {number} */ i) => vars.push(`--brand-color-${i + 1}:${c.hex}`));
  const fams = fontFamilies(kit).map((f) => `"${f}"`);
  vars.push(`--brand-font:${fams.concat(SYSTEM_STACK).join(",")}`);
  return `:root{${vars.join(";")}}`;
}

/** @param {string} abs @param {string} [fromDir] */
function urlFor(abs, fromDir) {
  if (fromDir) {
    const r = path.relative(path.resolve(fromDir), abs);
    if (r && !path.isAbsolute(r)) return r.split(path.sep).map(encodeURIComponent).join("/");
  }
  return pathToFileURL(abs).href;
}

/**
 * 本地 @font-face。url 按 HTML 所在目录算相对路径；不做 base64 内联——中文字体动辄 10–20 MB，
 * 塞进 HTML 里出图和预览都会卡死
 * @param {any} entry @param {{fromDir?: string}} [opts] @returns {string}
 */
function fontFaceCss(entry, opts = {}) {
  if (!entry || !entry.kit || !entry.dir || !entry.kit.fonts) return "";
  /** @type {string[]} */ const out = [];
  for (const k of ["en", "zh"]) {
    const rel = entry.kit.fonts[k];
    if (!rel) continue;
    const abs = insideDir(entry.dir, rel);
    if (!abs || !fs.existsSync(abs)) continue;
    const fmt = FONT_EXT[path.extname(abs).toLowerCase()] || "truetype";
    out.push(`@font-face{font-family:"brand-${entry.kit.slug}-${k}";src:url("${urlFor(abs, opts.fromDir)}") format("${fmt}");font-display:block}`);
  }
  return out.join("\n");
}

/**
 * 素材的绝对路径。文件不在的不给路径、记进 missing——给一个不存在的路径，下游只会报一句莫名其妙的 ENOENT
 * @param {any} entry
 * @returns {{logo: {light?: string, dark?: string}, fonts: {zh?: string, en?: string}, screenshots: string[], missing: string[]}}
 */
function assetPaths(entry) {
  /** @type {any} */ const out = { logo: {}, fonts: {}, screenshots: [], missing: [] };
  if (!entry || !entry.kit || !entry.dir) return out;
  const kit = entry.kit;
  const abs = (/** @type {string} */ rel) => {
    const a = insideDir(entry.dir, rel);
    if (a && fs.existsSync(a)) return a;
    out.missing.push(rel);
    return "";
  };
  for (const k of ["light", "dark"]) if (kit.logo && kit.logo[k]) { const a = abs(kit.logo[k]); if (a) out.logo[k] = a; }
  for (const k of ["zh", "en"]) if (kit.fonts && kit.fonts[k]) { const a = abs(kit.fonts[k]); if (a) out.fonts[k] = a; }
  for (const s of kit.screenshots || []) { const a = abs(s); if (a) out.screenshots.push(a); }
  return out;
}

// ────────────────────────────── 查稿 ──────────────────────────────

/** @type {Record<string, number>} */
const MULT = { k: 1e3, "千": 1e3, w: 1e4, "万": 1e4, m: 1e6, "亿": 1e8 };
const NUM_SRC = String.raw`(?<![\d.,a-z])(\d+(?:[.,]\d+)*)\s*(k|w|m|万|千|亿)?\s*(\+)?`;
// 只认挂在「宣传单位」上的数：日期、价格、页码、版本号都不算，不然每份稿子都是一片红
const UNIT_SRC = String.raw`(%|倍|x(?![a-z0-9])|×|stars?|颗星|星标|星(?!期)|(?:位|名|个)?用户|users?|人|次?下载|downloads?|装机|installs?|好评|家(?:企业|公司|门店|客户)?|企业|客户|customers?|团队|teams?)`;
const CLAIM_NUM_RE = new RegExp(NUM_SRC + String.raw`\s*` + UNIT_SRC, "g");
const ANY_NUM_RE = new RegExp(NUM_SRC, "g");
const CN_NUM = "一二三四五六七八九";
const RANK_SRC = String.raw`(?:全网|全国|全球|全行业|行业|业内|同类|市场|销量|榜单?|类目|排名|排行|国内|世界|亚洲|品类)\s*(?:排名)?\s*第\s*([0-9]+|[一二三四五六七八九十]+)|第\s*([0-9]+|[一二三四五六七八九十]+)\s*[名位]|\btop\s*([0-9]+)\b|\bno\.\s*([0-9]+)\b|#([0-9]{1,2})(?![0-9a-z])`;

/** 一、十二、二十 → 数字；认不出就原样 @param {string} s */
function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const d = (/** @type {string} */ c) => CN_NUM.indexOf(c) + 1;
  if (s.length === 1) return s === "十" ? 10 : d(s);
  const i = s.indexOf("十");
  if (i < 0) return NaN;
  return (i === 0 ? 1 : d(s[0])) * 10 + (i === s.length - 1 ? 0 : d(s[s.length - 1]));
}

/** 1.2k / 1,200 / 1200 / 0.12万 都归一成 1200 @param {string} num @param {string} [mult] */
function numValue(num, mult) {
  let n = num;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(n)) n = n.replace(/,/g, "");
  else n = n.replace(/,/g, ".");
  const v = parseFloat(n) * (mult ? MULT[mult] || 1 : 1);
  return Math.round(v * 100) / 100;
}

/** 档案里带出处的卖点提到过的数和名次：查稿时只有这些算「有出处」 @param {any} kit */
function sourcedFacts(kit) {
  const nums = new Set();
  const ranks = new Set();
  const pts = (kit && Array.isArray(kit.selling_points) ? kit.selling_points : []).filter((/** @type {any} */ p) => p && p.source);
  for (const p of pts) {
    const t = norm(p.text);
    for (const m of t.matchAll(ANY_NUM_RE)) nums.add(numValue(m[1], m[2]));
    for (const m of t.matchAll(new RegExp(RANK_SRC, "g"))) ranks.add(cnNum(m[1] || m[2] || m[3] || m[4] || m[5]));
  }
  return { nums, ranks };
}

/**
 * 成品上的「AI 生成」标识。只认标签式的写法：「一键 AI 生成海报」是在说功能，不是水印
 */
const WATERMARK_RE = /(?:^|[\s(（[【|·,，。:：]|由|本(?:图|文|视频|内容)?)ai\s*生成(?:的?(?:内容|图片|图像|画面|视频|素材))?(?!\s*\p{Script=Han})|generated\s+(?:by|with)\s+ai\b|\bai[\s-]generated\b|made\s+with\s+ai\b|aigc\s*标识|由\s*ai\s*(?:创作|制作)/gu;
// 「一个人做的」是对外文案里最劝退付费客户的一句话：甲方听到的是「出了事没人接」
const SOLO_RE = /一个人(?:做|写|开发|撑|搞|扛|完成|包办|独立)|一人(?:公司|团队|开发|包办|全栈)|独立开发者?|\bsolo[\s-]*(?:dev|developer|founder|maker|entrepreneur|project)\b|\bone[\s-](?:person|man|woman)[\s-](?:team|company|startup|business|show|band|shop)\b|\bone-(?:person|man)\b|\bbuilt\s+by\s+(?:one|a\s+single)\b|\bindie[\s-]*(?:dev|developer|hacker|maker)s?\b/g;

/**
 * @typedef {{kind: string, severity: "error"|"warn", hit: string, hint: string}} Finding
 */

/**
 * 按档案查一段文案
 * @param {string} text @param {any} kitOrEntry @returns {Finding[]}
 */
function lintCopy(text, kitOrEntry) {
  const kit = kitOf(kitOrEntry) || {};
  const nf = String(text == null ? "" : text).normalize("NFKC");
  const hay = nf.toLowerCase();
  // 匹配在小写上做，报出来的用原文的大小写：「AI 生成」报成「ai 生成」，人会以为查的不是自己那句
  const orig = (/** @type {RegExpMatchArray} */ m) => (hay.length === nf.length ? nf.slice(m.index || 0, (m.index || 0) + m[0].length) : m[0]);
  /** @type {Finding[]} */ const out = [];
  const seen = new Set();
  const add = (/** @type {Finding} */ f) => {
    const key = f.kind + "\u0000" + f.hit;
    if (seen.has(key) || out.filter((x) => x.kind === f.kind).length >= 30) return;
    seen.add(key);
    out.push(f);
  };
  if (!hay.trim()) return out;

  for (const w of kit.banned_words || []) {
    if (w && hay.includes(norm(w))) add({ kind: "banned", severity: "error", hit: w, hint: `档案里「${w}」是禁用词，换个说法` });
  }

  const facts = sourcedFacts(kit);
  for (const m of hay.matchAll(CLAIM_NUM_RE)) {
    const [whole, num, mult, plus, unit] = m;
    // 「3 人」多半是在说团队规模或者人数限制；只有「3 万人」「300+ 人在用」这种才是宣传
    if (unit === "人" && !mult && !plus && !/^(?:在用|使用|选择|付费|下载)/.test(hay.slice((m.index || 0) + whole.length))) continue;
    if (facts.nums.has(numValue(num, mult))) continue;
    const hit = orig(m).trim();
    add({ kind: "unsourced-number", severity: "error", hit, hint: `「${hit}」在档案里找不到带出处的对应数字：删掉，或先把出处补进档案` });
  }
  for (const m of hay.matchAll(new RegExp(RANK_SRC, "g"))) {
    const n = cnNum(m[1] || m[2] || m[3] || m[4] || m[5]);
    if (facts.ranks.has(n)) continue;
    const hit = orig(m).trim();
    add({ kind: "unsourced-number", severity: "error", hit, hint: `「${hit}」这个名次档案里没有出处：删掉，或先把出处补进档案` });
  }

  for (const m of hay.matchAll(SOLO_RE)) {
    add({ kind: "solo-framing", severity: "error", hit: orig(m).trim(), hint: "别写「一个人做的」这类话：付费客户读到的是「出了事没人接」。写产品能做什么" });
  }

  // 档案的合规说明要求标注 AI 生成时（比如平台规定），这一条让位给档案。
  // 按词认 AI：写成 /ai/ 的话，一条「别写 email 地址」也会把水印检查关掉
  const mustLabel = (kit.compliance_notes || []).some((/** @type {string} */ n) => /\bai(?:gc)?\b|人工智能|标识/i.test(norm(n)));
  if (!mustLabel) {
    for (const m of hay.matchAll(WATERMARK_RE)) {
      add({ kind: "watermark", severity: "error", hit: orig(m).replace(/^[\s(（[【|·,，。:：]/, "").trim(), hint: "成品不打「AI 生成」这类标识；档案的合规说明要求标注时除外" });
    }
  }
  return out;
}

const SYSTEM_FONTS = new Set([
  "-apple-system", "blinkmacsystemfont", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
  "sans-serif", "serif", "monospace", "cursive", "fantasy", "emoji", "math", "inherit", "initial", "unset", "revert",
  "segoe ui", "roboto", "helvetica neue", "helvetica", "arial", "tahoma", "verdana", "ubuntu", "cantarell",
  "sf pro", "sf pro text", "sf pro display", "sf mono", "menlo", "monaco", "consolas", "courier new", "courier",
  "pingfang sc", "pingfang tc", "pingfang hk", "hiragino sans gb", "hiragino sans", "microsoft yahei", "microsoft jhenghei",
  "noto sans cjk sc", "noto sans sc", "noto serif sc", "noto serif cjk sc", "source han sans sc", "source han serif sc",
  "songti sc", "heiti sc", "kaiti sc", "stheiti", "stsong", "simsun", "simhei", "wenquanyi micro hei",
  "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji",
]);

/** @param {string} h @returns {[number, number, number] | null} */
function hexRgb(h) {
  let s = h.replace(/^#/, "");
  if (s.length === 3 || s.length === 4) s = s.slice(0, 3).split("").map((c) => c + c).join("");
  else if (s.length === 8) s = s.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
/** @param {number[]} c */
function rgbHex(c) { return "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase(); }
/** 灰阶（黑白灰、近似灰）不算品牌色，用不着在档案里：看色度（最大通道减最小通道）@param {number[]} c */
function isNeutral(c) { return (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255 < 0.08; }
/** @param {number[]} a @param {number[]} b */
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/** 声明（属性: 值）逐条拿出来 @param {string} css @returns {{prop: string, value: string}[]} */
function decls(css) {
  /** @type {{prop: string, value: string}[]} */ const out = [];
  for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) out.push({ prop: m[1].toLowerCase(), value: m[2].trim() });
  return out;
}

/**
 * 按档案查一份 HTML：可见文字过一遍 lintCopy，再查中文字距、配色、字体
 * @param {string} html @param {any} kitOrEntry @returns {Finding[]}
 */
function lintHtml(html, kitOrEntry) {
  const kit = kitOf(kitOrEntry) || {};
  const src = String(html || "");
  const styleBlocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const styleAttrs = [...src.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] || m[2] || "");
  const visible = src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
  /** @type {Finding[]} */ const out = lintCopy(visible, kit);
  const seen = new Set(out.map((f) => f.kind + "\u0000" + f.hit));
  const add = (/** @type {Finding} */ f) => {
    const key = f.kind + "\u0000" + f.hit;
    if (seen.has(key) || out.filter((x) => x.kind === f.kind).length >= 30) return;
    seen.add(key);
    out.push(f);
  };

  // 字体：@font-face 先拎出来——它里头的 font-family 是在定义，不是在用
  const kitFontFiles = kit.fonts ? Object.values(kit.fonts).map((f) => path.posix.basename(String(f)).toLowerCase()) : [];
  const allowed = new Set(fontFamilies(kit).map((f) => f.toLowerCase()));
  let cssAll = styleBlocks.join("\n");
  for (const m of cssAll.matchAll(/@font-face\s*{([^}]*)}/gi)) {
    const fam = /font-family\s*:\s*["']?([^;"']+)/i.exec(m[1]);
    const srcUrl = /src\s*:[^;]*/i.exec(m[1]);
    const s = srcUrl ? srcUrl[0].toLowerCase() : "";
    if (/url\(\s*["']?https?:/.test(s)) {
      add({ kind: "font-off-kit", severity: "error", hit: fam ? fam[1].trim() : "网络字体", hint: "别用网络字体：出图时未必连得上，还有版权问题。用档案里的本地字体" });
    } else if (fam && kitFontFiles.some((f) => f && s.includes(f))) allowed.add(fam[1].trim().toLowerCase());
  }
  cssAll = cssAll.replace(/@font-face\s*{[^}]*}/gi, " ");
  if (/<link[^>]+href\s*=\s*["']https?:\/\/fonts\.(?:googleapis|gstatic)\.com/i.test(src) || /@import\s+url\(\s*["']?https?:\/\/fonts\./i.test(cssAll)) {
    add({ kind: "font-off-kit", severity: "error", hit: "Google Fonts", hint: "别用网络字体：出图时未必连得上。用档案里的本地字体或系统字体栈" });
  }
  const all = decls(cssAll).concat(...styleAttrs.map(decls));
  const noKitFonts = !kit.fonts || !Object.keys(kit.fonts).length;
  for (const d of all.filter((x) => x.prop === "font-family")) {
    for (const f0 of d.value.split(",")) {
      const f = f0.replace(/!important/i, "").trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
      if (!f || f.startsWith("var(") || SYSTEM_FONTS.has(f) || allowed.has(f)) continue;
      add({
        kind: "font-off-kit", severity: "warn", hit: f,
        hint: noKitFonts ? `「${f}」不是系统字体：档案没配品牌字体，用系统字体栈` : `「${f}」既不是档案字体也不是系统字体：用 brand_kit_read get 给的 @font-face`,
      });
    }
  }

  // 中文字距：中文加字距就是散的，一眼看上去像排版出错
  if (CJK_RE.test(visible)) {
    for (const d of all.filter((x) => x.prop === "letter-spacing")) {
      const v = d.value.replace(/!important/i, "").trim();
      if (/^(?:[-+]?0(?:\.0+)?(?:px|em|rem|pt|%)?|normal|initial|inherit|unset|revert)$/i.test(v)) continue;
      add({ kind: "cjk-letter-spacing", severity: "error", hit: `letter-spacing:${v}`, hint: "中文不加字距：改成 letter-spacing:0" });
    }
    for (const m of src.matchAll(/\bclass\s*=\s*["'][^"']*\b(tracking-(?!normal\b)[a-z0-9[\].-]+)/gi)) {
      add({ kind: "cjk-letter-spacing", severity: "error", hit: m[1], hint: "中文不加字距：去掉这个 tracking 类" });
    }
  }

  // 配色：出了档案色（和灰阶）就提醒。容差 28，同一个色的轻微变体不算
  const palette = (kit.colors || []).map((/** @type {any} */ c) => hexRgb(c.hex)).filter(Boolean);
  /** @type {string[]} */ const colorVals = all.map((d) => d.value);
  for (const m of src.matchAll(/\s(?:fill|stroke|color|bgcolor|stop-color)\s*=\s*["']([^"']+)["']/gi)) colorVals.push(m[1]);
  for (const v of colorVals) {
    /** @type {number[][]} */ const found = [];
    for (const m of v.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi)) { const c = hexRgb(m[1]); if (c) found.push(c); }
    for (const m of v.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) found.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    for (const c of found) {
      if (isNeutral(c) || palette.some((p) => dist(p, c) <= 28)) continue;
      const hex = rgbHex(c);
      add({
        kind: "color-off-palette", severity: "warn", hit: hex,
        hint: palette.length ? `${hex} 不在档案配色里：换成档案色，或者先把它加进档案（最多 4 色）` : `${hex}：档案没配色，只用灰阶或先在档案里定好配色`,
      });
    }
  }
  return out;
}

/** 解 shrinkPng 吐出来的图：8 位 RGB/RGBA，每行滤波器都是 0 @param {Buffer} buf */
function decodeFilter0(buf) {
  const info = pngInfo(buf);
  if (!info || info.depth !== 8 || (info.color !== 2 && info.color !== 6)) return null;
  /** @type {Buffer[]} */ const idat = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const n = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    if (type === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + n));
    if (type === "IEND") break;
    p += 12 + n;
  }
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const ch = info.color === 6 ? 4 : 3;
  const stride = info.width * ch;
  if (raw.length < info.height * (stride + 1)) return null;
  return { width: info.width, height: info.height, ch, stride, raw };
}

/**
 * PNG 的主色（占比从大到小）。先缩到 64 px 再数，千万像素的截图也就几千个点
 * @param {Buffer} png @param {{k?: number, minShare?: number}} [opts]
 * @returns {{hex: string, share: number}[] | null}
 */
function dominantColors(png, opts = {}) {
  const k = opts.k || 5;
  const minShare = opts.minShare == null ? 0.06 : opts.minShare;
  if (!Buffer.isBuffer(png)) return null;
  const info = pngInfo(png);
  if (!info) return null;
  const big = Math.max(info.width, info.height);
  // shrinkPng 不放大也不「缩到同样大」：本来就小的图缩到比自己小一点，还是拿它来统一解码
  const target = big > 64 ? 64 : big - 1;
  if (target < 1) return null;
  const small = shrinkPng(png, target);
  if (!small) return null;
  const img = decodeFilter0(small);
  if (!img) return null;
  /** @type {Map<number, number[]>} */ const buckets = new Map();
  let total = 0;
  for (let y = 0; y < img.height; y++) {
    const row = y * (img.stride + 1);
    if (img.raw[row] !== 0) return null;
    for (let x = 0; x < img.width; x++) {
      const o = row + 1 + x * img.ch;
      if (img.ch === 4 && img.raw[o + 3] < 128) continue; // 透明的地方不算颜色
      const r = img.raw[o], g = img.raw[o + 1], b = img.raw[o + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const acc = buckets.get(key) || [0, 0, 0, 0];
      acc[0] += r; acc[1] += g; acc[2] += b; acc[3]++;
      buckets.set(key, acc);
      total++;
    }
  }
  if (!total) return [];
  // 相邻的格子合并：同一块颜色被 4 位量化切成两半时，别报成两个主色
  /** @type {{c: number[], n: number}[]} */ const clusters = [];
  for (const acc of [...buckets.values()].sort((a, b) => b[3] - a[3])) {
    const c = [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]];
    const near = clusters.find((cl) => dist(cl.c, c) <= 24);
    if (near) {
      const n = near.n + acc[3];
      near.c = near.c.map((v, i) => (v * near.n + c[i] * acc[3]) / n);
      near.n = n;
    } else clusters.push({ c, n: acc[3] });
  }
  return clusters
    .sort((a, b) => b.n - a.n)
    .filter((cl) => cl.n / total >= minShare)
    .slice(0, k)
    .map((cl) => ({ hex: rgbHex(cl.c), share: Math.round((cl.n / total) * 1000) / 1000 }));
}

/**
 * 主色是否都在档案配色里（灰阶不算）
 * @param {{hex: string, share: number}[] | null} colors @param {any} kitOrEntry @param {{tolerance?: number}} [opts]
 * @returns {{ok: boolean, offenders: {hex: string, share: number}[]}}
 */
function paletteMatches(colors, kitOrEntry, opts = {}) {
  const kit = kitOf(kitOrEntry) || {};
  const tol = opts.tolerance == null ? 28 : opts.tolerance;
  const palette = (kit.colors || []).map((/** @type {any} */ c) => hexRgb(c.hex)).filter(Boolean);
  if (!Array.isArray(colors)) return { ok: false, offenders: [] };
  const offenders = colors.filter((c) => {
    const rgb = hexRgb(c.hex);
    if (!rgb || isNeutral(rgb)) return false;
    return !palette.some((/** @type {number[]} */ p) => dist(p, rgb) <= tol);
  });
  return { ok: offenders.length === 0, offenders };
}

// ────────────────────────────── 两个工具 ──────────────────────────────

const TOOL_DEFS = [
  {
    name: "brand_kit_read",
    description: "读产品品牌档案。list 看有哪些；get 取整份（配色 CSS、本地字体、logo/截图路径、带出处的卖点）；check 按档案查成稿（file 或 text）。",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "check"], description: "list 列出全部；get 取一份；check 查成稿" },
        slug: { type: "string", description: "产品 slug（get / check 用；只有一份档案时可不填）" },
        text: { type: "string", description: "check：要查的文案" },
        file: { type: "string", description: "check：要查的文件（工作目录相对路径）。.html 查文字+字距+配色+字体，.png 查主色，其他按文案查" },
      },
      required: ["action"],
    },
  },
  {
    name: "brand_kit_save",
    description: "存产品品牌档案（新建或覆盖），一定弹卡请用户确认。带数字或比较的卖点必须给出处（链接或档案里的文件）。",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["project", "user"], description: "project=存在本项目；user=全局，各项目都能用" },
        kit: {
          type: "object",
          description:
            "档案。必填 name、slug（小写字母/数字/连字符）、one_liner{zh,en}；可选 aliases、audience、selling_points[{text,source,checked_at}]、" +
            "links[{label,url}]、screenshots、logo{light,dark}、colors[{name,hex,role}]（≤4 色，role=primary/text/bg/accent）、fonts{zh,en}、" +
            "voice{tts_voice,speed}、tone、signature、cta、banned_words、compliance_notes。文件一律写档案内相对路径 brand/…",
        },
        assets: {
          type: "array",
          description: "要一起存进档案的文件：from=工作目录里的文件，as=档案内路径（必须以 brand/ 开头）",
          items: { type: "object", properties: { from: { type: "string" }, as: { type: "string" } }, required: ["from", "as"] },
        },
      },
      required: ["scope", "kit"],
    },
  },
];

/** @param {string} content */
const fail = (content) => ({ content, isError: true });

/** 默认用哪一份：给了 slug 按 slug；没给时本项目的档案优先，只有一份就用那份 @param {any[]} list @param {any} slug */
function pickEntry(list, slug) {
  const want = norm(str(slug));
  if (want) {
    return list.find((e) => e.slug === want)
      || list.find((e) => norm(e.name) === want || (e.kit.aliases || []).some((/** @type {string} */ a) => norm(a) === want))
      || null;
  }
  return list.find((e) => e.scope === "project") || (list.length === 1 ? list[0] : null);
}

/** @param {Finding[]} fs0 */
function reportFindings(fs0) {
  const errs = fs0.filter((f) => f.severity === "error");
  const warns = fs0.filter((f) => f.severity !== "error");
  if (!fs0.length) return "结论：通过，没查出问题。";
  const lines = [`结论：要改 ${fs0.length} 处（必须改 ${errs.length}，建议改 ${warns.length}）`];
  for (const f of errs) lines.push(`· [必须改] ${f.hint}`);
  for (const f of warns) lines.push(`· [建议] ${f.hint}`);
  return lines.join("\n");
}

/** @param {any} input @param {any} ctx */
async function readTool(input, ctx) {
  const action = str(input.action);
  const { list, skipped } = loadAll({ cwd: ctx.root || "" });
  if (action === "list") {
    if (!list.length && !skipped.length) return { content: "还没有品牌档案。要建的话：use_skill 加载 brand-kit，照「建档」走。", isError: false };
    const lines = list.map((e) =>
      `· ${e.name}（slug=${e.slug}，${e.scope === "project" ? "本项目" : "全局"}）${e.warnings.length ? `，${e.warnings.length} 条提醒：${cut(e.warnings.join("；"), 120)}` : ""}`);
    for (const s of skipped) lines.push(`· 没用上：${s.file} —— ${s.why}`);
    return { content: lines.join("\n"), isError: false };
  }
  if (action === "get") {
    const e = pickEntry(list, input.slug);
    if (!e) return fail(notFound(list, input.slug));
    let fromDir = "";
    try { fromDir = ctx.resolveFile ? ctx.resolveFile(".") : ""; } catch {}
    const out = {
      scope: e.scope, file: e.file, kit: e.kit,
      assets: assetPaths(e),
      cssVars: cssVars(e),
      fontFaceCss: fontFaceCss(e, { fromDir }),
      usable_selling_points: usablePoints(e.kit).map((p) => p.text),
      warnings: e.warnings,
    };
    return { content: JSON.stringify(out, null, 2), isError: false };
  }
  if (action === "check") {
    const e = pickEntry(list, input.slug);
    if (input.slug && !e) return fail(notFound(list, input.slug));
    const head = e ? `按「${e.name}」的档案查：` : "没找到品牌档案，只查了通用规矩（中文字距、AI 标识、「一个人做的」、没出处的数字）：";
    const file = str(input.file);
    if (file) {
      const abs = ctx.resolveFile(file);
      const ext = path.extname(abs).toLowerCase();
      let st;
      try { st = fs.statSync(abs); } catch { return fail(`找不到文件 ${file}`); }
      if (!st.isFile()) return fail(`${file} 不是文件`);
      if (ext === ".png") {
        const cols = dominantColors(fs.readFileSync(abs));
        if (!cols) return fail(`${file} 解不开（隔行扫描或低位深的 PNG 不支持），换一张普通的 PNG`);
        const pm = paletteMatches(cols, e);
        const shares = cols.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join("、") || "（全透明）";
        const verdict = !e || !(e.kit.colors || []).length ? "档案没配色，没法比对"
          : pm.ok ? "和档案配色对得上" : `这几个主色不在档案配色里：${pm.offenders.map((c) => `${c.hex}（${Math.round(c.share * 100)}%）`).join("、")}`;
        return { content: `${head}\n主色：${shares}\n结论：${verdict}`, isError: false };
      }
      if ([".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return fail("图片只能查 PNG 的配色；JPG/WebP 先导出成 PNG 再查");
      if (st.size > 4 * 1024 * 1024) return fail(`${file} 太大了（超过 4 MB），不像是一份成稿`);
      const body = fs.readFileSync(abs, "utf8");
      const found = ext === ".html" || ext === ".htm" ? lintHtml(body, e) : lintCopy(body, e);
      return { content: `${head}${file}\n${reportFindings(found)}`, isError: false };
    }
    const t = typeof input.text === "string" ? input.text : "";
    if (!t.trim()) return fail("check 要给 file（工作目录里的文件）或 text（一段文案）");
    return { content: `${head}\n${reportFindings(lintCopy(t, e))}`, isError: false };
  }
  return fail('action 只能是 "list"、"get" 或 "check"');
}

/** @param {any[]} list @param {any} slug */
function notFound(list, slug) {
  const have = list.map((e) => e.slug).join("、");
  return slug
    ? `没找到品牌档案「${str(slug)}」。${have ? `现有：${have}` : "现在一份都没有；要建的话 use_skill 加载 brand-kit。"}`
    : `有 ${list.length} 份档案，说一下要哪份（slug）：${have || "（一份都没有）"}`;
}

/** 审批卡上先给人看的那一段：每条卖点有没有出处一眼看清，再看 diff @param {any} kit @param {any[]} copies @param {string} where */
function fieldSummary(kit, copies, where) {
  const lines = [`存到：${where}`, `产品：${kit.name}（slug=${kit.slug}）`];
  const ol = kit.one_liner || {};
  if (ol.zh) lines.push(`一句话：${ol.zh}`);
  if (ol.en) lines.push(`One-liner：${ol.en}`);
  const pts = kit.selling_points || [];
  if (pts.length) {
    lines.push("卖点：");
    for (const p of pts) lines.push(p.source ? `  ✓有出处 ${p.text}（${p.source}）` : `  ✗无出处 ${p.text}（不带数字，可以不给）`);
  }
  if (kit.colors) lines.push(`配色：${kit.colors.map((/** @type {any} */ c) => `${c.name || ROLE_LABEL[c.role] || ""} ${c.hex}`.trim()).join(" · ")}`);
  if (kit.fonts) lines.push(`字体：${Object.entries(kit.fonts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  if (kit.voice) lines.push(`配音：${[kit.voice.tts_voice, kit.voice.speed ? `${kit.voice.speed} 倍速` : ""].filter(Boolean).join(" · ")}`);
  if (kit.tone) lines.push(`口吻：${kit.tone}`);
  if (kit.signature) lines.push(`署名：${kit.signature}`);
  if (kit.cta) lines.push(`行动号召：${kit.cta}`);
  if (kit.banned_words) lines.push(`禁用词：${kit.banned_words.join("、")}`);
  for (const c of copies) lines.push(`复制素材：${c.from} → ${c.as}（${Math.max(1, Math.round(c.size / 1024))} KB）`);
  return lines.join("\n");
}

/** @param {any} input @param {any} ctx */
async function saveTool(input, ctx) {
  const scope = str(input.scope);
  if (scope !== "project" && scope !== "user") return fail('scope 只能是 "project"（存在本项目）或 "user"（全局，各项目都能用）');
  if (!ctx || !ctx.security || typeof ctx.passGate !== "function") return fail("存品牌档案需要审批通道，这个入口没有");
  // 1. 整理 + 校验：有问题直接退回，不弹卡——让人去批一份本来就存不进的档案没有意义
  const v = validate(input.kit, { checkFiles: false });
  if (!v.ok) {
    return fail(`品牌档案没存，先改这几处：\n${v.problems.map((p) => `· ${p}`).join("\n")}${v.warnings.length ? `\n另外：${v.warnings.join("；")}` : ""}`);
  }
  const kit = v.kit;
  // 2. 扫描：冲着 agent 去的话、藏起来的话，一律不收
  const g = guardScan(kit);
  if (g.refuse.length) {
    return fail(`品牌档案没存：档案会被读进每一轮提示词，里头这几处不能进来——\n${g.refuse.slice(0, 6).map((f) => `· ${f.why}${f.excerpt ? `\n    ${cut(f.excerpt, 80)}` : ""}`).join("\n")}\n把这些字从档案里删掉再存。`);
  }
  // 3. 素材：工作目录里的文件，复制进档案的 brand/ 下
  const dir = scope === "project" ? path.join(ctx.root, ".openworkbuddy") : path.join(registryDir(), kit.slug);
  const file = path.join(dir, "brand.json");
  const rel = scope === "project" ? ".openworkbuddy/brand.json" : `brands/${kit.slug}/brand.json`;
  const list = Array.isArray(input.assets) ? input.assets : [];
  if (list.length > 40) return fail("一次最多带 40 个素材文件");
  /** @type {{from: string, as: string, abs: string, size: number}[]} */ const copies = [];
  let total = 0;
  const allExt = [...new Set([...LOGO_EXT, ...EVIDENCE_EXT, ...Object.keys(FONT_EXT)])];
  for (const a of list) {
    const from = str(a && a.from);
    const r = kitRel(a && a.as);
    if (!from) return fail("素材少了 from（工作目录里的文件）");
    if (!r.ok) return fail(`素材 as「${cut(str(a && a.as), 40)}」${r.why}`);
    if (!r.rel.startsWith("brand/")) return fail(`素材 as「${r.rel}」必须放在 brand/ 下，比如 brand/logo.svg`);
    const ext = path.extname(r.rel).toLowerCase();
    if (!allExt.includes(ext)) return fail(`素材「${r.rel}」格式不收，只收图片、字体、PDF、文本和网页快照`);
    let abs;
    try { abs = ctx.resolveFile(from); } catch (e) { return fail(`素材 ${from} 读不了：${e && e.message}`); }
    let st;
    try { st = fs.statSync(abs); } catch { return fail(`素材 ${from} 不存在`); }
    if (!st.isFile()) return fail(`素材 ${from} 不是文件`);
    const cap = FONT_EXT[ext] ? FONT_CAP : IMAGE_CAP;
    if (st.size > cap) return fail(`素材 ${from} 有 ${Math.round(st.size / 1048576)} MB，超过上限 ${cap / 1048576} MB`);
    total += st.size;
    if (total > TOTAL_CAP) return fail("素材加起来超过 50 MB：挑要紧的存，其余放链接");
    copies.push({ from, as: r.rel, abs, size: st.size });
  }
  // 档案里点名的文件，要么档案目录里已经有，要么这次带进来
  const incoming = new Set(copies.map((c) => c.as));
  const named = [
    ...Object.values(kit.logo || {}), ...Object.values(kit.fonts || {}), ...(kit.screenshots || []),
    ...(kit.selling_points || []).map((/** @type {any} */ p) => p.source).filter((/** @type {any} */ s) => s && !URL_RE.test(s)),
  ].map(String);
  const missing = named.filter((n) => !incoming.has(n) && !fs.existsSync(path.join(dir, n)));
  if (missing.length) return fail(`档案里点名的这些文件既不在档案目录里、也没在 assets 里带上：${missing.join("、")}`);

  const body = JSON.stringify({ ...kit, updated_at: new Date().toISOString() }, null, 2) + "\n";
  // 4. 审批：任何档位都要人点头（只看不动档直接拒）。ruleKey 留空，「这类都允许」绕不过去
  const was = ctx.readBefore ? ctx.readBefore(file) : null;
  let verdict = ctx.security.checkWrite(ctx.sec || {}, rel);
  if (verdict.action !== "deny") {
    verdict = { action: "ask", rule: was ? `改品牌档案「${kit.name}」` : `新建品牌档案「${kit.name}」`, seg: rel, ruleKey: "" };
  }
  const where = scope === "project" ? `本项目 ${rel}` : `全局 ${rel}`;
  const notes = g.notes.length ? `\n\n扫描提示：\n${g.notes.slice(0, 5).map((f) => `· ${f.why}`).join("\n")}` : "";
  const warn = v.warnings.length ? `\n\n提醒：\n${v.warnings.map((w) => `· ${w}`).join("\n")}` : "";
  const diff = ctx.diffText ? ctx.diffText(rel, was, body) : "";
  const blocked = await ctx.passGate(verdict, "保存品牌档案", rel, {
    force: true,
    detail: fieldSummary(kit, copies, where) + warn + notes + (diff ? "\n\n" + diff : ""),
  });
  if (blocked) {
    if (verdict.action === "deny") return blocked;
    return { ...blocked, content: `${blocked.content}\n品牌档案只有人在 OpenWorkBuddy 里点「允许」才存得下：机器人、定时任务、没人值守的命令行里存不了。要改哪里，改完再存一次。` };
  }
  // 5. 落盘：素材先到位，档案最后原子替换——中途失败不会留下一份指向不存在素材的档案
  fs.mkdirSync(dir, { recursive: true });
  for (const c of copies) {
    const to = path.join(dir, c.as);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(c.abs, to);
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
  CACHE.delete(file);
  const preview = digest(kit);
  return {
    content: `已保存品牌档案「${kit.name}」（${where}）。以后提到它，提示词里会带上这段摘要：\n${preview}` +
      (v.warnings.length ? `\n提醒：${v.warnings.join("；")}` : ""),
    isError: false,
  };
}

/**
 * 工具入口。ctx 由 tools.js 递进来：{ root, resolveFile, passGate, readBefore, diffText, security, sec }
 * @param {string} name @param {any} input @param {any} ctx @returns {Promise<{content: string, isError: boolean}>}
 */
async function runTool(name, input, ctx) {
  const inp = input && typeof input === "object" ? input : {};
  const c = ctx || {};
  try {
    if (name === "brand_kit_read") return await readTool(inp, c);
    if (name === "brand_kit_save") return await saveTool(inp, c);
    return fail(`没有这个工具：${name}`);
  } catch (e) {
    return fail(`品牌档案出错：${e && e.message}`);
  }
}

function _resetCache() {
  CACHE.clear();
  STICKY.clear();
}

module.exports = {
  SCHEMA_VERSION,
  DIGEST_MAX,
  registryDir,
  projectCandidates,
  loadAll,
  get,
  validate,
  digest,
  detect,
  pickForHistory,
  promptBlock,
  safePromptBlock,
  cssVars,
  fontFaceCss,
  fontFamilies,
  assetPaths,
  lintCopy,
  lintHtml,
  dominantColors,
  paletteMatches,
  TOOL_DEFS,
  runTool,
  _resetCache,
  _internals: { CLAIM_RE, kitRel, isClaim, usablePoints, numValue, guardScan, fieldSummary, STICKY, CACHE },
};
