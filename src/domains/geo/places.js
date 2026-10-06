// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 行程卡上的地点和路线：拿模型写的地点名去地图服务查坐标、照片、评分；相邻两站之间查一条路。
 *
 * 两条路，按有没有高德 Key 走：
 *   · 有 Key（设置 → 搜索 → 地图里填的，或者装高德连接器时填的那把）：
 *     高德 POI 搜索（v5 place/text），带照片和评分；相邻两站查步行 / 驾车路线，画的是真的路。
 *     高德没查到（多半是国外的地方）再去 OpenStreetMap 查一遍。
 *   · 没 Key：OpenStreetMap 的 Nominatim 查坐标，照片从 Wikidata 拿（有就有，没有就算了），
 *     没有评分；两站之间画直线、标直线距离。一个 Key 都不用填也能看到地图。
 * 不管哪条路，查到的地方没带照片，就拿名字去 Wikidata 搜一次，位置对得上才用它的头图。
 * 照片单独一个接口（photos）：前端先拿坐标把钉子钉上，再慢慢补图——连不上 Wikidata 时钉子不跟着干等。
 *
 * 每一站回三种结果，前端照实写：查到了；没查成（报错原话，能再查一次）；
 * 没找到（问过的每一家都正常回了「没有」——有 Key 是高德和 OpenStreetMap 都没有，没 Key 是 OpenStreetMap 没有）。
 *
 * 坐标系：高德给的是 GCJ-02，OpenStreetMap 给的是 WGS-84。每个点都带上 datum，
 * 画在哪张底图上由前端换算（src/util/geo-coords.js / public/tripcard.js）。
 *
 * 四条克制：
 *   1. 查过的都记盘（runtime/geo/places.json），同一个地方第二次不再打外部接口。
 *      老缓存里少了后来才加的字段，就少着用，不为补字段再查一遍。
 *   2. 按对方的规矩限速：Nominatim 每秒最多一次（它的使用条款），高德个人开发者 3 次/秒。
 *   3. 高德按自然月给免费额度，搜索和路线规划各算各的（个人认证开发者每月搜索 5000、路线 15 万，企业更多），
 *      这里也分开按月数：默认搜索 4500、路线 14 万（map.amap_search_cap / amap_route_cap 可改），到数就改走
 *      OpenStreetMap / 画直线，不让卡片把免费额度吃光。老配置只有一个「每天上限」，见 settingsOf。
 *   4. 高德回的是 Key 本身的毛病（Key 不对、平台不对、当天总量用完），当天不再打高德：每站再试一次只是白记用量。
 * 报错原样往上递（「高德：INVALID_USER_KEY（10001）」），不替人猜原因。错误里不带请求地址——地址里有 Key。
 */
const path = require("path");
const store = require("../../platform/store");
const log = require("../../platform/log");
const { dataPath } = require("../../platform/paths");
const geo = require("../../util/geo-coords");

const UA = "OpenWorkBuddy (+https://github.com/CatCatUncle/openworkbuddy)";
const BASES = { amap: "https://restapi.amap.com", nominatim: "https://nominatim.openstreetmap.org", wikidata: "https://www.wikidata.org" };
const GAPS = { amap: 350, nominatim: 1100, wikidata: 250 };
/** 每月默认上限：比高德给个人认证开发者的免费额度（搜索 5000、路线 15 万）各留一点，给「测一下」和别处用同一把 Key 的 */
const SEARCH_CAP = 4500;
const ROUTE_CAP = 140000;
const TTL_HIT = 30 * 864e5;
const TTL_MISS = 3 * 864e5;
/** 补照片出错（多半是 Wikidata 连不上）：记一小会儿，这段时间里每张卡片不再挨个等它超时 */
const TTL_ERR = 10 * 60e3;
const MAX_CACHE = 4000;
/** 一次最多查几个地点 / 几段路。前端按天要，一天十几站够了 */
const MAX_ITEMS = 20;
const MAX_LEGS = 20;
/** 两站直线超过这么远就不查路了（跨城那一段画直线，标距离） */
const MAX_ROUTE_M = 150e3;
/** 直线这么近以内按步行查，再远按驾车 */
const WALK_M = 2000;
/** 按名字在 Wikidata 搜到的条目，坐标离查到的点这么近以内才算同一个地方（湖、山的中心点能差出两公里） */
const WIKI_NEAR_M = 3000;

let bases = { ...BASES };
let gaps = { ...GAPS };

const baseDir = () => path.join(process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data"), "runtime", "geo");
const cacheFile = () => path.join(baseDir(), "places.json");

/** @param {unknown} v 高德空字段给的是 []，统一收成字符串 */
const s = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
/** 报错里说是哪一家：用人认得的名字，不用域名 */
const NAMES = { amap: "高德", nominatim: "OpenStreetMap", wikidata: "Wikidata" };

// ---------------- 设置 ----------------

/** 上限：0 或正整数（小数取整）；没填、乱填回 NaN @param {unknown} v */
const capOf = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? +v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN;
};

/**
 * 地图这一节的设置，连带「Key 从哪来」。provider：auto（有 Key 用高德，没有用 OpenStreetMap）/ amap / osm。
 * 选了 osm 就一次也不打高德，哪怕连接器里填着 Key——有人就是不想把行程发给高德。
 *
 * 每月上限 caps.search / caps.route。老配置只有 amap_daily_cap（每天一个数，搜索和路线合着算）：
 * 新的没填时按 31 天折成每月，再不超过新的默认值——不会比他原来允许的多打；填过 0（不用高德）的还是 0。
 * 设置页存一次就写成新的两项，老的那项随之删掉。
 * @param {any} config
 */
function settingsOf(config) {
  const m = (config && typeof config.map === "object" && config.map) || {};
  const provider = ["auto", "amap", "osm"].includes(m.provider) ? m.provider : "auto";
  const old = capOf(m.amap_daily_cap);
  const pick = (/** @type {unknown} */ v, /** @type {number} */ def) => {
    const n = capOf(v);
    if (Number.isFinite(n)) return n;
    return Number.isFinite(old) ? Math.min(def, old * 31) : def;
  };
  const caps = { search: pick(m.amap_search_cap, SEARCH_CAP), route: pick(m.amap_route_cap, ROUTE_CAP) };
  let key = "", from = "";
  if (provider !== "osm") {
    if (s(m.amap_key)) { key = s(m.amap_key); from = "settings"; }
    else {
      for (const srv of (config && Array.isArray(config.mcp_servers) ? config.mcp_servers : [])) {
        const k = srv && srv.env && s(srv.env.AMAP_MAPS_API_KEY);
        if (k) { key = k; from = "connector"; break; }
      }
    }
  }
  return { provider, key, from, caps };
}

// ---------------- 限速、额度、缓存 ----------------

const gateNext = /** @type {Record<string, number>} */ ({});
const gateChain = /** @type {Record<string, Promise<void>>} */ ({});
/** 按开始时间排队：两次之间至少隔 gap 毫秒。不限并发——限的是对方看到的频率 @param {string} name @param {() => Promise<any>} fn */
function gated(name, fn) {
  const turn = (gateChain[name] || Promise.resolve()).then(async () => {
    const wait = (gateNext[name] || 0) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gateNext[name] = Date.now() + (gaps[/** @type {keyof GAPS} */ (name)] || 0);
  });
  gateChain[name] = turn.catch(() => {});
  return turn.then(fn);
}

/**
 * 盘上一份：查过的地点和路（items）、这个月打了高德几次（month + used，搜索和路线分开）、
 * 今天是不是停了高德（stop：哪天、高德的原话）。老文件是 { day, used: 数字, items }：items 照用，次数从这个月重新数。
 * @type {{ loaded: boolean, map: Map<string, { t: number, r: any, e?: boolean }>, month: string, used: { search: number, route: number }, stop: { day: string, msg: string } | null }}
 */
const cache = { loaded: false, map: new Map(), month: "", used: { search: 0, route: 0 }, stop: null };
const today = () => new Date().toLocaleDateString("sv");
const thisMonth = () => today().slice(0, 7);
function loadCache() {
  if (cache.loaded) return;
  cache.loaded = true;
  const raw = store.readJson(cacheFile(), null);
  if (!raw || typeof raw !== "object") return;
  for (const [k, v] of Object.entries(raw.items || {})) if (v && typeof v.t === "number") cache.map.set(k, v);
  if (raw.month === thisMonth() && raw.used && typeof raw.used === "object") {
    cache.month = raw.month;
    cache.used = { search: +raw.used.search || 0, route: +raw.used.route || 0 };
  }
  if (raw.stop && raw.stop.day === today() && typeof raw.stop.msg === "string") cache.stop = { day: raw.stop.day, msg: raw.stop.msg };
}
const saver = store.coalesce(async () => {
  while (cache.map.size > MAX_CACHE) cache.map.delete(/** @type {string} */ (cache.map.keys().next().value));
  await store.writeJsonAtomicAsync(cacheFile(), { month: cache.month, used: cache.used, stop: cache.stop, items: Object.fromEntries(cache.map) }, { backup: false });
}, { minGapMs: 2000, onError: (e) => log.warn("geo", "地点缓存写盘失败", { err: String(e && e.message || e) }) });

/** @param {string} k */
function cached(k) {
  loadCache();
  const v = cache.map.get(k);
  if (!v) return undefined;
  if (Date.now() - v.t > (v.e ? TTL_ERR : v.r ? TTL_HIT : TTL_MISS)) { cache.map.delete(k); return undefined; }
  cache.map.delete(k); cache.map.set(k, v); // 挪到队尾：最近用过的最后才被挤掉
  return v.r;
}
/** @param {string} k @param {any} r @param {boolean} [err] 出错了记的空结果：只留 TTL_ERR */
function remember(k, r, err) { cache.map.delete(k); cache.map.set(k, err ? { t: Date.now(), r, e: true } : { t: Date.now(), r }); saver.request(); }

/** 这个月的高德次数（搜索 / 路线各算各的）还够不够；够就记一次 @param {"search"|"route"} kind @param {number} cap */
function spendAmap(kind, cap) {
  loadCache();
  const m = thisMonth();
  if (cache.month !== m) { cache.month = m; cache.used = { search: 0, route: 0 }; }
  if (cache.used[kind] >= cap) return false;
  cache.used[kind]++;
  saver.request();
  return true;
}
/** 今天停了高德的话，高德当时的原话；没停回 "" */
function stopMsg() {
  loadCache();
  if (cache.stop && cache.stop.day !== today()) { cache.stop = null; saver.request(); }
  return cache.stop ? cache.stop.msg : "";
}
/** 地图设置存过（多半换了 Key）、或者「测一下」这把 Key 通了：今天的停用作废 */
function resetStop() {
  loadCache();
  if (!cache.stop) return;
  cache.stop = null;
  saver.request();
}
/** 设置页看的：这个月打了几次、上限多少、今天停没停 @param {any} config */
function usage(config) {
  loadCache();
  const st = settingsOf(config);
  const m = thisMonth();
  const used = cache.month === m ? { ...cache.used } : { search: 0, route: 0 };
  return { month: m, used, caps: st.caps, stop: stopMsg() };
}

// ---------------- 网络 ----------------

/** @param {string} url @param {{ name: string, headers?: Record<string,string>, timeoutMs?: number }} o name：报错里说是哪一家 */
async function getJson(url, { name, headers = {}, timeoutMs = 8000 }) {
  const host = name;
  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = /** @type {any} */ (e);
    const why = err && err.name === "TimeoutError" ? `${Math.round(timeoutMs / 1000)} 秒没回` : (err && err.cause && err.cause.code) || (err && err.message) || String(e);
    throw new Error(`${host} 连不上：${why}`);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`${host} 回了 HTTP ${r.status}${text ? "：" + text.replace(/\s+/g, " ").slice(0, 120) : ""}`);
  try { return JSON.parse(text); } catch { throw new Error(`${host} 回的不是 JSON：${text.replace(/\s+/g, " ").slice(0, 120)}`); }
}

const CAP_HIT = {
  search: "这个月的高德搜索次数到上限了，先改用 OpenStreetMap",
  route: "这个月的高德路线次数到上限了，两站之间先画直线",
};
/**
 * 高德说的是 Key 本身的毛病，当天再打也一样：10001 Key 不对，10003 / 10044 当天总量用完，10009 Key 的平台类型不对。
 * 别的（单次超时、某个地点参数不对）只算这一次没成。
 */
const KEY_DEAD = new Set(["10001", "10003", "10009", "10044"]);

/**
 * @typedef {{ key: string, caps: { search: number, route: number }, probe?: boolean }} AmapSt probe：设置页「测一下」，不受上限和停用挡
 */
/**
 * 打一次高德。没打成的三种：今天停了（off: "stop"）、这个月到数了（off: "cap"）、高德报错（普通 Error，
 * 是 Key 级的毛病就顺手把今天停了，也标 off: "stop"）。off 的那些不算「没查成」：再查一次也一样，前端改走别家。
 * @param {URL} u @param {AmapSt} st @param {"search"|"route"} kind
 */
async function amapGet(u, st, kind) {
  if (!st.probe) {
    const stop = stopMsg();
    if (stop) throw Object.assign(new Error(stop), { off: "stop" });
    if (!spendAmap(kind, st.caps[kind])) throw Object.assign(new Error(CAP_HIT[kind]), { off: "cap" });
  } else spendAmap(kind, Infinity);
  u.searchParams.set("key", st.key);
  const j = await gated("amap", () => getJson(u.toString(), { name: NAMES.amap }));
  if (String(j && j.status) !== "1") {
    const code = s(j && j.infocode);
    const msg = `高德：${s(j && j.info) || "没给原因"}${code ? `（${code}）` : ""}`;
    if (KEY_DEAD.has(code) && !st.probe) {
      loadCache();
      cache.stop = { day: today(), msg };
      saver.request();
      log.warn("geo", "高德 Key 用不了，今天先不打高德", { err: msg });
      throw Object.assign(new Error(msg), { off: "stop" });
    }
    throw new Error(msg);
  }
  return j;
}

/** @param {string} loc "lng,lat" @returns {[number, number] | null} */
function parseLoc(loc) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s(loc));
  if (!m) return null;
  const lng = +m[1], lat = +m[2];
  return Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? [lng, lat] : null;
}

/** 城市名比对用：去掉「市 / 省 / 自治州…」这种尾巴 @param {string} c */
const bareCity = (c) => s(c).replace(/(特别行政区|自治州|自治区|地区|盟|市|省|县|区)$/, "");

/**
 * 高德 POI 搜索。按城市限定（city_limit），城市对不上的结果不要——
 * 不限定的话，「埃菲尔铁塔」在国内能搜出一座仿建的，钉子就钉到杭州去了。
 * @param {AmapSt} st @param {string} name @param {string} city
 */
async function amapPlace(st, name, city) {
  const u = new URL("/v5/place/text", bases.amap);
  u.searchParams.set("keywords", name.slice(0, 80));
  if (city) { u.searchParams.set("region", city); u.searchParams.set("city_limit", "true"); }
  u.searchParams.set("show_fields", "business,photos");
  u.searchParams.set("page_size", "3");
  const j = await amapGet(u, st, "search");
  const pois = (Array.isArray(j.pois) ? j.pois : []).filter((p) => p && parseLoc(p.location));
  const want = bareCity(city);
  const inCity = want ? pois.filter((p) => [p.cityname, p.pname, p.adname].some((x) => bareCity(x) && (bareCity(x).includes(want) || want.includes(bareCity(x))))) : pois;
  const p = inCity.find((x) => s(x.name) === name) || inCity[0];
  if (!p) return null;
  const [lng, lat] = /** @type {[number, number]} */ (parseLoc(p.location));
  const biz = p.business && typeof p.business === "object" ? p.business : {};
  const rating = parseFloat(s(biz.rating));
  const photo = (Array.isArray(p.photos) ? p.photos : []).map((x) => s(x && x.url)).find(Boolean) || "";
  const type = s(p.type).split(/[;|]/).filter(Boolean);
  return {
    name: s(p.name) || name, lng, lat, datum: "gcj02",
    addr: [s(p.adname), s(p.address)].filter(Boolean).join(" ").slice(0, 60),
    kind: type[type.length - 1] || "",
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
    photo, photoSrc: photo ? "amap" : "", src: "amap",
  };
}

const OSM_KIND = /** @type {Record<string,string>} */ ({
  park: "公园", garden: "花园", museum: "博物馆", gallery: "美术馆", attraction: "景点", viewpoint: "观景点",
  zoo: "动物园", aquarium: "水族馆", theme_park: "乐园", place_of_worship: "寺庙", temple: "寺庙", church: "教堂",
  castle: "城堡", monument: "纪念碑", memorial: "纪念地", ruins: "遗址", restaurant: "餐厅", cafe: "咖啡馆",
  bar: "酒吧", pub: "酒馆", fast_food: "小吃", food_court: "美食街", marketplace: "市场", mall: "商场",
  hotel: "酒店", hostel: "青旅", beach: "海滩", peak: "山峰", water: "湖泊", lake: "湖泊", island: "岛屿",
  pedestrian: "步行街", university: "大学", library: "图书馆", theatre: "剧院", stadium: "体育场", station: "车站",
});

/** Commons 上一张图的 320 宽缩略图地址 @param {string} file */
const commonsThumb = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, "_"))}?width=320`;
/** Wikidata 一条声明的值 @param {any} claims @param {string} prop */
const claimValue = (claims, prop) => {
  const c = claims && Array.isArray(claims[prop]) ? claims[prop][0] : null;
  return c && c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : undefined;
};

/** Wikidata 上这个地方的头图（P18）。拿不到就空着，不算错 @param {string} qid */
async function wikiPhoto(qid) {
  if (!/^Q\d{1,12}$/.test(qid)) return "";
  const u = new URL("/w/api.php", bases.wikidata);
  u.searchParams.set("action", "wbgetclaims");
  u.searchParams.set("entity", qid);
  u.searchParams.set("property", "P18");
  u.searchParams.set("format", "json");
  const j = await gated("wikidata", () => getJson(u.toString(), { name: NAMES.wikidata, timeoutMs: 6000 }));
  const file = s(claimValue(j && j.claims, "P18"));
  return file ? commonsThumb(file) : "";
}

/**
 * 地图服务没给照片的地方：拿名字去 Wikidata 搜，按搜索排名看，第一个坐标离查到的点 WIKI_NEAR_M 以内的条目算数。
 * 它没头图就算了，不往下找——再往下多半是同名的别处，或者旁边的地铁站，配上去是错图。
 * @param {string} name @param {{ lng: number, lat: number, datum: string }} at
 */
async function wikiPhotoByName(name, at) {
  const [lng, lat] = geo.convert(at.lng, at.lat, at.datum, "wgs84");
  const q = new URL("/w/api.php", bases.wikidata);
  for (const [k, v] of Object.entries({ action: "wbsearchentities", search: name, language: "zh", uselang: "zh", type: "item", limit: "5", format: "json" })) q.searchParams.set(k, v);
  const found = await gated("wikidata", () => getJson(q.toString(), { name: NAMES.wikidata, timeoutMs: 6000 }));
  const ids = (found && Array.isArray(found.search) ? found.search : []).map((x) => s(x && x.id)).filter((id) => /^Q\d{1,12}$/.test(id));
  if (!ids.length) return "";
  const g = new URL("/w/api.php", bases.wikidata);
  for (const [k, v] of Object.entries({ action: "wbgetentities", ids: ids.join("|"), props: "claims", format: "json" })) g.searchParams.set(k, v);
  const j = await gated("wikidata", () => getJson(g.toString(), { name: NAMES.wikidata, timeoutMs: 8000 }));
  for (const id of ids) {
    const claims = j && j.entities && j.entities[id] && j.entities[id].claims;
    const co = claimValue(claims, "P625");
    if (!co || !Number.isFinite(+co.longitude) || !Number.isFinite(+co.latitude)) continue;
    if (geo.distance(lng, lat, +co.longitude, +co.latitude) > WIKI_NEAR_M) continue;
    const file = s(claimValue(claims, "P18"));
    return file ? commonsThumb(file) : "";
  }
  return "";
}

/**
 * OpenStreetMap 的 Nominatim。每秒一次，带上能认出是谁的 User-Agent（它的使用条款要求）。
 * 它标了 Wikidata 条目的，只记下条目号（qid），头图留给 photos 去拿，不在这儿等。
 * @param {string} name @param {string} city
 */
async function osmPlace(name, city) {
  const u = new URL("/search", bases.nominatim);
  u.searchParams.set("q", city && !name.includes(bareCity(city)) ? `${name}, ${city}` : name);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "1");
  u.searchParams.set("extratags", "1");
  u.searchParams.set("accept-language", "zh-CN,zh,en");
  const arr = await gated("nominatim", () => getJson(u.toString(), { name: NAMES.nominatim, timeoutMs: 10000 }));
  const p = Array.isArray(arr) ? arr[0] : null;
  const lng = p ? +p.lon : NaN, lat = p ? +p.lat : NaN;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const tags = p.extratags && typeof p.extratags === "object" ? p.extratags : {};
  const img = s(tags.image);
  const photo = /^https:\/\/(upload|commons)\.wikimedia\.org\//.test(img) ? img : "";
  const qid = /^Q\d{1,12}$/.test(s(tags.wikidata)) ? s(tags.wikidata) : "";
  const parts = s(p.display_name).split(/,\s*/).filter(Boolean);
  return {
    name: s(p.name) || name, lng, lat, datum: "wgs84",
    addr: parts.slice(1, 4).join("，").slice(0, 60),
    kind: OSM_KIND[s(p.type)] || OSM_KIND[s(p.category)] || "",
    rating: null, photo, photoSrc: photo ? "wikimedia" : "", qid, src: "osm",
  };
}

// ---------------- 对外：查地点 ----------------

/**
 * 按名字补照片。另记一条缓存（w|城市|名字），不动地点那条——不然为了补张图要把高德 / Nominatim 再打一遍。
 * 搜不到记 ""，按「没查到」那档过期，过几天再试。出错只记日志，也记一条只留 TTL_ERR 的空结果：
 * Wikidata 连不上的时候（国内常见），十分钟里每张卡片、每一站不再各等一次超时。
 * @param {string} name @param {string} city @param {{ lng: number, lat: number, datum: string }} at
 */
async function photoByName(name, city, at) {
  const k = `w|${city}|${name}`;
  const hit = cached(k);
  if (hit !== undefined) return hit || "";
  try {
    const photo = await wikiPhotoByName(name, at);
    remember(k, photo);
    return photo;
  } catch (e) {
    log.warn("geo", "按名字找 Wikidata 头图没成", { err: String(/** @type {any} */ (e).message || e) });
    remember(k, "", true);
    return "";
  }
}

/**
 * 一个地方的照片：OpenStreetMap 标了 Wikidata 条目的先拿条目头图（q|条目号），没有再按名字搜。
 * @param {string} name @param {string} city @param {string} qid @param {{ lng: number, lat: number, datum: string }} at
 */
async function photoFor(name, city, qid, at) {
  if (/^Q\d{1,12}$/.test(qid)) {
    const k = `q|${qid}`;
    let hit = cached(k);
    if (hit === undefined) {
      try { hit = await wikiPhoto(qid); remember(k, hit); }
      catch (e) {
        log.warn("geo", "Wikidata 头图没拿到", { err: String(/** @type {any} */ (e).message || e) });
        remember(k, "", true);
        return "";   // 刚连不上，这一趟不再按名字去撞同一台机器
      }
    }
    if (hit) return hit;
  }
  return photoByName(name, city, at);
}

/** 照片的答案盘上有没有：有就是那张（可能是 ""，意思是没有），还没问过回 undefined。不打网络 @param {string} name @param {string} city @param {string} qid */
function photoCached(name, city, qid) {
  if (/^Q\d{1,12}$/.test(qid)) {
    const q = cached(`q|${qid}`);
    if (q === undefined) return undefined;
    if (q) return q;
  }
  return cached(`w|${city}|${name}`);
}

/**
 * 查到的一站，带上照片：地图服务自己给了就用；没给的看盘上补过没有，没补过标 photoPending，
 * 前端钉子钉完再来 photos 要——补图要去 Wikidata，连不上时一等好几秒，不能让钉子陪着等。
 * 老缓存没记照片是哪来的：高德的算高德，OpenStreetMap 的照片都在 Wikimedia 上。
 * @param {any} r @param {string} name @param {string} city
 */
function withPhoto(r, name, city) {
  const o = { ok: true, ...r };
  if (o.photo) { if (!o.photoSrc) o.photoSrc = r.src === "amap" ? "amap" : "wikimedia"; return o; }
  const pc = photoCached(name, city, s(r.qid));
  if (pc) { o.photo = pc; o.photoSrc = "wikidata"; }
  else if (pc === undefined) o.photoPending = true;
  return o;
}

/**
 * 每一站回三种之一：
 *   { ok: true, name, lng, lat, datum, src, … }        查到了，src 是哪一家（amap / osm）
 *   { ok: false, failed: true, error }                 没查成：有一家报错、另一家也没给出结果。error 是原话，前端能「再查一次」
 *   { ok: false, tried: ["amap", "osm"] }              没找到：问过的每一家都正常回了「没有」。tried 是问了谁
 * 高德今天停了、这个月到数了的，不算问过，也不算没查成（再查一次也一样）：直接问 OpenStreetMap。
 * provider 照实写查到的那些点来自哪：amap / osm / mixed，一个没查到是 ""。
 * 今天停了高德的话带上 amapOff（高德当时的原话），卡片上说一次。
 * @param {any} config
 * @param {Array<{ name?: string, city?: string }>} items
 * @returns {Promise<{ provider: string, items: Array<any>, notes: string[], amapOff?: string }>}
 */
async function lookup(config, items) {
  const st = settingsOf(config);
  const notes = new Set();
  let off = "";
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
  const out = await Promise.all(list.map(async (it) => {
    const name = s(it && it.name).slice(0, 80);
    const city = s(it && it.city).slice(0, 20);
    if (!name) return { ok: false, tried: [] };
    /** @type {string[]} */
    const tried = [];
    let error = "";
    if (st.key) {
      const k = `a|${city}|${name}`;
      let r = cached(k);
      if (r === undefined) {
        try { r = await amapPlace(st, name, city); remember(k, r); tried.push("amap"); }
        catch (e) {
          const err = /** @type {any} */ (e);
          r = null;
          if (err.off === "stop") off = err.message;
          else if (err.off === "cap") notes.add(err.message);
          else { error = err.message; notes.add(err.message); }
        }
      } else tried.push("amap");
      if (r) return withPhoto(r, name, city);
    }
    const k = `o|${city}|${name}`;
    let r = cached(k);
    if (r === undefined) {
      try { r = await osmPlace(name, city); remember(k, r); tried.push("osm"); }
      catch (e) { r = null; error = error || /** @type {any} */ (e).message; notes.add(/** @type {any} */ (e).message); }
    } else tried.push("osm");
    if (r) return withPhoto(r, name, city);
    return error ? { ok: false, failed: true, error } : { ok: false, tried };
  }));
  const srcs = new Set(out.filter((x) => x.ok).map((x) => x.src));
  const provider = srcs.size > 1 ? "mixed" : srcs.size ? [...srcs][0] : "";
  return { provider, items: out, notes: [...notes], ...(off ? { amapOff: off } : {}) };
}

/**
 * 补照片（lookup 回来标了 photoPending 的那些）。每项 { name, city, lng, lat, datum, qid? }，
 * 回 { items: [{ photo, src }] }，src 是 "wikidata" 或空。拿不到就空着，不算错，不往卡片上报。
 * @param {Array<any>} items
 */
async function photos(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
  const out = await Promise.all(list.map(async (it) => {
    const name = s(it && it.name).slice(0, 80);
    const city = s(it && it.city).slice(0, 20);
    const at = pointOf(it);
    if (!name || !at) return { photo: "", src: "" };
    const photo = await photoFor(name, city, s(it && it.qid), at);
    return { photo, src: photo ? "wikidata" : "" };
  }));
  return { items: out };
}

// ---------------- 对外：两站之间的路 ----------------

/** 折线点太多（驾车动辄上千个）就抽稀，留头留尾 @param {number[][]} pts @param {number} max */
function thin(pts, max = 240) {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  const out = pts.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

/** @param {any} p @returns {{ lng: number, lat: number, datum: string } | null} */
function pointOf(p) {
  // +null、+"" 都是 0：不先挡掉的话，缺了的点会被当成 (0, 0)
  const num = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? +v : NaN);
  if (!p || typeof p !== "object") return null;
  const lng = num(p.lng), lat = num(p.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  return { lng, lat, datum: p.datum === "gcj02" ? "gcj02" : "wgs84" };
}

/**
 * @param {AmapSt} st
 * @param {[number, number]} a GCJ-02 @param {[number, number]} b GCJ-02 @param {"walking"|"driving"} mode
 */
async function amapRoute(st, a, b, mode) {
  const u = new URL(`/v5/direction/${mode}`, bases.amap);
  u.searchParams.set("origin", a.map((x) => x.toFixed(6)).join(","));
  u.searchParams.set("destination", b.map((x) => x.toFixed(6)).join(","));
  u.searchParams.set("show_fields", "cost,polyline");
  const j = await amapGet(u, st, "route");
  const p = j.route && Array.isArray(j.route.paths) ? j.route.paths[0] : null;
  if (!p) return null;
  /** @type {number[][]} */
  const line = [];
  for (const step of Array.isArray(p.steps) ? p.steps : []) {
    for (const pair of s(step && step.polyline).split(";")) {
      const xy = parseLoc(pair);
      if (xy) line.push(xy);
    }
  }
  const dist = +s(p.distance), dur = +s(p.cost && p.cost.duration);
  return {
    mode, src: "amap", datum: "gcj02",
    distance: Number.isFinite(dist) ? dist : null,
    duration: Number.isFinite(dur) && dur > 0 ? dur : null,
    line: thin(line.length >= 2 ? line : [a, b]).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]),
  };
}

/**
 * @param {any} config
 * @param {Array<{ a: any, b: any }>} pairs
 */
async function legs(config, pairs) {
  const st = settingsOf(config);
  const notes = new Set();
  let off = "";
  const list = (Array.isArray(pairs) ? pairs : []).slice(0, MAX_LEGS);
  const out = await Promise.all(list.map(async (pr) => {
    const a = pointOf(pr && pr.a), b = pointOf(pr && pr.b);
    if (!a || !b) return null;
    const pa = geo.convert(a.lng, a.lat, a.datum, "wgs84"), pb = geo.convert(b.lng, b.lat, b.datum, "wgs84");
    const straight = Math.round(geo.distance(pa[0], pa[1], pb[0], pb[1]));
    const line = { mode: "line", src: "line", distance: straight, duration: null, datum: "wgs84", line: [pa, pb] };
    if (!st.key || straight > MAX_ROUTE_M || straight < 30 || !geo.inChina(pa[0], pa[1]) || !geo.inChina(pb[0], pb[1])) return line;
    const ga = geo.convert(a.lng, a.lat, a.datum, "gcj02"), gb = geo.convert(b.lng, b.lat, b.datum, "gcj02");
    const mode = straight < WALK_M ? "walking" : "driving";
    const k = `r|${mode}|${ga.map((x) => x.toFixed(5))}|${gb.map((x) => x.toFixed(5))}`;
    let r = cached(k);
    if (r === undefined) {
      try { r = await amapRoute(st, ga, gb, mode); if (r) remember(k, r); }
      catch (e) {
        const err = /** @type {any} */ (e);
        r = null;
        if (err.off === "stop") off = err.message; else notes.add(err.message);
      }
    }
    return r || line;
  }));
  return { items: out, notes: [...notes], ...(off ? { amapOff: off } : {}) };
}

/**
 * 设置页「测一下」：拿这把 Key（没给就用存着的）真查一次。查的是一个人人都有的地名，不带任何行程内容。
 * @param {any} config @param {string} [key]
 */
async function test(config, key) {
  const st = settingsOf(config);
  const k = s(key) || st.key;
  if (!k) {
    const r = await osmPlace("天安门", "北京");
    return { ok: !!r, provider: "osm", msg: r ? "没填高德 Key，用 OpenStreetMap，连得上" : "OpenStreetMap 连上了，但没查到测试地点" };
  }
  // 每月的上限、今天的停用管的是卡片自己去查，不管这一下：是人点的，就一次。照算进这个月的搜索次数，但不被挡住——
  // 上限填 0、到数了、或者今天停了，点「测一下」还说「到上限了」，Key 到底对不对就没法知道了
  const r = await amapPlace({ key: k, caps: st.caps, probe: true }, "天安门", "北京");
  // 测的就是存着的那把，而且通了：今天的停用作废，卡片接着用高德
  if (k === st.key) resetStop();
  return { ok: !!r, provider: "amap", msg: r ? `高德 Key 能用：查到「${r.name}」${r.photo ? "，带照片" : ""}` : "高德 Key 能用，但没查到测试地点" };
}

/** 只给测试用：换上游地址、关掉限速、清空缓存 @param {{ bases?: Partial<typeof BASES>, gaps?: Partial<typeof GAPS>, reset?: boolean }} o */
function _testing(o = {}) {
  if (o.bases) bases = { ...BASES, ...o.bases };
  if (o.gaps) gaps = { ...GAPS, ...o.gaps };
  if (o.reset) { cache.loaded = false; cache.map.clear(); cache.month = ""; cache.used = { search: 0, route: 0 }; cache.stop = null; }
  return { flush: () => saver.flush(), cacheFile: cacheFile() };
}

module.exports = { lookup, photos, legs, test, usage, resetStop, settingsOf, thin, MAX_ITEMS, MAX_LEGS, SEARCH_CAP, ROUTE_CAP, UA, _testing };
