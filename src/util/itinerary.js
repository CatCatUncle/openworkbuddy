// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 行程卡（```itinerary 围栏）的数据口径，纯函数，不碰网络。
 *
 * 模型规划行程时在正文里写一段 ```itinerary JSON：网页把它画成「按天切换的地图 + 时间线」卡片
 * （public/tripcard.js），飞书 / 微信 / QQ / 命令行看不了卡片，就在这里换成一段按天排好的文字。
 * 地点坐标、照片、评分不让模型给——模型报的经纬度常常偏出去几公里，评分更是张口就来——
 * 由服务端拿地点名去地图服务查（src/domains/geo/places.js）。
 *
 * normalize 跟 public/tripcard.js 里那份是同一套口径（字段别名、长度上限、几天几站封顶），
 * test/trip-card.js 拿同一批样例两边各跑一遍对答案，改一边忘了另一边会当场红。
 */

const LIMIT = { days: 14, stops: 15, name: 40, time: 16, note: 140, kind: 12, city: 20, addr: 60, title: 40, summary: 160 };

/** @param {unknown} v @param {number} n */
function str(v, n) {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * @typedef {{ name: string, time: string, note: string, kind: string, city: string, addr: string }} Stop
 * @typedef {{ label: string, title: string, summary: string, stops: Stop[], more?: number }} Day
 * @typedef {{ title: string, city: string, days: Day[], more?: number }} Itinerary
 * more：超过 LIMIT 被截掉了几站 / 几天。没截就没有这个字段。
 */

/**
 * 已经收过一遍的数据里带着的 more。卡片把收好的 JSON 存在 data-tc 里，点活、复制时再收一遍——
 * 那时候多出来的已经截掉了，不接着记，第二遍就忘了少过几站。
 * 只认我们自己收过的那份（normalize 的 own）：模型在围栏里自己写个 "more"，不能让卡片说「后面还有几站没列出」。
 * @param {unknown} v
 */
const moreOf = (v) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1e4 ? v : 0);

/**
 * 截掉了多少，卡片和文字版说同一句话。
 * @param {"天"|"站"} unit @param {number} n
 */
const moreText = (unit, n) => (unit === "天"
  ? `只显示前 ${LIMIT.days} 天，后面 ${n} 天没列出`
  : `这天只显示前 ${LIMIT.stops} 站，后面 ${n} 站没列出`);

/** @param {any} s @returns {Stop | null} */
function normStop(s) {
  if (typeof s === "string") s = { name: s };
  if (!s || typeof s !== "object") return null;
  const name = str(s.name || s.place || s.title || s.poi, LIMIT.name);
  if (!name) return null;
  return {
    name,
    time: str(s.time || s.when || s.period || s.slot, LIMIT.time),
    note: str(s.note || s.desc || s.description || s.tip || s.tips, LIMIT.note),
    kind: str(s.kind || s.type || s.category, LIMIT.kind),
    city: str(s.city, LIMIT.city),
    addr: str(s.address || s.addr, LIMIT.addr),
  };
}

/** @param {any} d @param {boolean} [own] @returns {Day | null} */
function normDay(d, own) {
  if (Array.isArray(d)) d = { stops: d };
  if (!d || typeof d !== "object") return null;
  const raw = d.stops || d.items || d.places || d.spots || d.schedule || [];
  const all = (Array.isArray(raw) ? raw : []).map(normStop).filter(Boolean);
  const stops = all.slice(0, LIMIT.stops);
  if (!stops.length) return null;
  /** @type {Day} */
  const day = {
    label: str(d.label || (typeof d.day === "string" ? d.day : ""), 12),
    title: str(d.title || d.theme || d.name, LIMIT.title),
    summary: str(d.summary || d.desc || d.description || d.note, LIMIT.summary),
    stops: /** @type {Stop[]} */ (stops),
  };
  const more = all.length - stops.length + (own ? moreOf(d.more) : 0);
  if (more) day.more = more;
  return day;
}

/**
 * 模型给的东西收成一个形状。认不出来返回 null，调用方原样当代码块显示。
 * @param {any} obj
 * @param {boolean} [own] obj 是我们自己收过的那份（data-tc 里存的）：里面的 more 是真截掉过的，接着记
 * @returns {Itinerary | null}
 */
function normalize(obj, own) {
  if (Array.isArray(obj)) obj = { days: obj };
  if (!obj || typeof obj !== "object") return null;
  const raw = obj.days || obj.itinerary || obj.plan || [];
  const all = (Array.isArray(raw) ? raw : []).map((d) => normDay(d, own)).filter(Boolean);
  const days = all.slice(0, LIMIT.days);
  if (!days.length) return null;
  /** @type {Itinerary} */
  const it = { title: str(obj.title || obj.name, LIMIT.title), city: str(obj.city || obj.destination, LIMIT.city), days: /** @type {Day[]} */ (days) };
  const more = all.length - days.length + (own ? moreOf(obj.more) : 0);
  if (more) it.more = more;
  return it;
}

const BARE_KEY = /[A-Za-z_$][\w$]*(?=\s*:)/y;
const TRAIL_COMMA = /,(?=\s*[}\]])/y;
/**
 * 模型最常犯的两处格式错：多一个收尾逗号，键名漏了引号（kind:"商业街"）。只改字符串外面这两处，
 * 字符串里的内容一个字不动——这两处补上不会改变行程本身。
 * @param {string} s
 */
function loosen(s) {
  let out = "", last = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += s[++i] || "";
      else if (c === '"') { inStr = false; last = c; }
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ",") { TRAIL_COMMA.lastIndex = i; if (TRAIL_COMMA.test(s)) continue; }
    else if ((last === "{" || last === ",") && /[A-Za-z_$]/.test(c)) {
      BARE_KEY.lastIndex = i;
      const m = BARE_KEY.exec(s);
      if (m) { out += '"' + m[0] + '"'; i += m[0].length - 1; last = '"'; continue; }
    }
    out += c;
    if (!/\s/.test(c)) last = c;
  }
  return out;
}

/**
 * 围栏里的文字 → 行程。先按严格 JSON 解；不行把上面那两处格式错补上再试一次。
 * 别的修补不做（单引号、注释、半截 JSON）：猜错了画出来的是一份错的行程，比显示原文更糟。
 * @param {string} text @returns {Itinerary | null}
 */
function parse(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  for (const t of [s, loosen(s)]) {
    try { return normalize(JSON.parse(t)); } catch {}
  }
  return null;
}

/**
 * JSON 第一处语法错在第几个字符；解得开回 -1。只用来告诉人「第几行」，什么都不修。
 * 不读 JSON.parse 的报错：各家浏览器写法不一样，有的根本不带位置。
 * @param {string} s
 */
function badAt(s) {
  let i = 0;
  const ws = () => { while (i < s.length && " \t\n\r".includes(s[i])) i++; };
  const fail = () => { throw i; };
  const lit = () => {
    if (s[i] !== '"') fail();
    for (i++; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { i++; return; }
      if (c === "\\") i++;
      else if (c < " ") fail();
    }
    fail();
  };
  const val = () => {
    ws();
    const c = s[i];
    if (c === "{" || c === "[") {
      const end = c === "{" ? "}" : "]";
      i++; ws();
      if (s[i] === end) { i++; return; }
      for (;;) {
        if (end === "}") { ws(); lit(); ws(); if (s[i] !== ":") fail(); i++; }
        val(); ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === end) { i++; return; }
        fail();
      }
    }
    if (c === '"') return lit();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i, i + 64));
    if (!m) fail();
    i += /** @type {RegExpExecArray} */ (m)[0].length;
  };
  try { val(); ws(); if (i < s.length) fail(); return -1; }
  catch (e) { if (typeof e === "number") return e; throw e; }
}

/**
 * 围栏解不开的时候说一句哪儿不对（行号从围栏里第一行数起）；解得开回 ""。
 * 网页卡片、聊天软件、命令行都拿这一句，前面加「行程卡没画成：」。
 * @param {string} text
 */
function whyBad(text) {
  const raw = String(text || "");
  const s = raw.trim();
  if (!s) return "里面是空的";
  if (parse(s)) return "";
  const t = loosen(s);   // 那两处常见格式错先补上再找：补的时候换行一个不动，行号对得上
  const at = badAt(t);
  if (at < 0) return "里面没有能画的地点";
  const lead = raw.slice(0, raw.length - raw.trimStart().length);
  const line = (lead.match(/\n/g) || []).length + (t.slice(0, at).match(/\n/g) || []).length + 1;
  return `第 ${line} 行格式不对`;
}

/**
 * 「上午 / 9:30 / 晚饭」→ 卡片上分段用的那一格。认不出来回空串（不分段，照原顺序排）。
 * @param {string} time
 */
function segmentOf(time) {
  const t = String(time || "").toLowerCase();
  const m = t.match(/(\d{1,2})[:：点](\d{2})?/);
  if (m) {
    const h = +m[1];
    if (h < 5) return "晚上";
    if (h < 11) return "上午";
    if (h < 13) return "中午";
    if (h < 17) return "下午";
    if (h < 19) return "傍晚";
    return "晚上";
  }
  if (/清晨|早上|早晨|上午|早饭|早餐|morning|breakfast/.test(t)) return "上午";
  if (/中午|午饭|午餐|noon|lunch/.test(t)) return "中午";
  if (/下午|afternoon/.test(t)) return "下午";
  if (/傍晚|黄昏|日落|sunset|dusk/.test(t)) return "傍晚";
  if (/晚|夜|evening|night|dinner/.test(t)) return "晚上";
  return "";
}

/** @param {Day} d @param {number} i */
const dayLabel = (d, i) => d.label || `第${i + 1}天`;

/**
 * 发不了卡片的地方（飞书、微信、QQ、命令行）用的文字版。
 * @param {Itinerary} it
 */
function toMarkdown(it) {
  const out = [];
  if (it.title) out.push(`**${it.title}**`, "");
  it.days.forEach((d, i) => {
    out.push(`**${dayLabel(d, i)}${d.title ? " · " + d.title : ""}**`);
    if (d.summary) out.push(d.summary);
    for (const s of d.stops) {
      const head = (s.time ? s.time + " · " : "") + s.name;
      out.push(`- ${head}${s.note ? "：" + s.note : ""}`);
    }
    if (d.more) out.push(`（${moreText("站", d.more)}）`);
    out.push("");
  });
  if (it.more) out.push(`（${moreText("天", it.more)}）`);
  return out.join("\n").trim();
}

/** 收了尾的围栏，和正文末尾没收尾的那一段（模型忘了写收尾的三个反引号） */
const FENCE_RE = /```itinerary[^\S\n]*\n([\s\S]*?)(?:```|$)/gi;

/** 解不开的那段前面加的那句话，和认出「已经加过了」用的尾巴 */
const BAD_TAIL = "，下面是原文：\n\n";
const BAD_HEAD_RE = /行程卡没画成：[^\n]*，下面是原文：\n\n$/;

/**
 * 正文里所有 ```itinerary 围栏换成文字版。解不出来的先说一句哪儿不对，再原样贴原文——宁可贴原文，不吞内容。
 * 同一段正文过两遍也只说一次：IM 先在 prepareFigures 里换一遍，切段（chunks）时又换一遍，
 * 解不开的那段原文还留着围栏，第二遍不认得就会再加一句「行程卡没画成」。
 * @param {string} md
 */
function fencesToMarkdown(md) {
  const s = String(md || "");
  if (!/```itinerary/i.test(s)) return s;
  return s.replace(FENCE_RE, (all, body, at) => {
    const it = parse(body);
    if (it) return toMarkdown(it);
    if (BAD_HEAD_RE.test(s.slice(Math.max(0, at - 200), at))) return all;
    return `行程卡没画成：${whyBad(body)}${BAD_TAIL}${all}`;
  });
}

/** 系统提示词里那一节。内置引擎和本机 Codex / Claude Code 两条路共用这一份 */
const PROMPT_BLOCK = [
  "## 行程规划：地图行程卡",
  "用户要规划旅行、出游、一日游、逛吃路线时，在回复正文里写一个 ```itinerary 围栏，界面会把它画成「按天切换的地图 + 时间线」卡片。地点的坐标、照片、评分由程序拿地点名去地图服务查，你**不要**给经纬度、评分。",
  "- 写法（必须是合法 JSON：每个键名、字符串都用双引号，不带注释，不带多余逗号）：",
  "```itinerary",
  '{"title":"昆明三日游","city":"昆明","days":[{"title":"老昆明慢逛","summary":"翠湖周边步行串起来，傍晚去老街觅食","stops":[{"time":"上午","name":"翠湖公园","kind":"公园","note":"湖边散步、喝咖啡"},{"time":"晚上","name":"南强街","kind":"街区","note":"小锅米线、烧饵块"}]}]}',
  "```",
  "- name 写地图上搜得到的正式全称（写「云南陆军讲武堂」，别写「讲武堂」）；跟 city 不在同一个城市的那一站，单独加 \"city\"。",
  "- time 写「上午 / 中午 / 下午 / 晚上」或「9:30」这种；每天 3～6 站，按顺路的先后排。",
  "- 围栏前用一两句说清整体安排；围栏后按天各一句交通和注意事项。门票、营业时间、预约这些没查证过的，别写成确定的。",
  "- 目的地都没说就先问一句再排；天数没说就按 2～3 天排，并在开头说一句可以改。",
].join("\n");

module.exports = { parse, normalize, whyBad, moreText, segmentOf, toMarkdown, fencesToMarkdown, dayLabel, PROMPT_BLOCK, LIMIT };
