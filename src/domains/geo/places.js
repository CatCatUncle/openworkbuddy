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
 *
 * 坐标系：高德给的是 GCJ-02，OpenStreetMap 给的是 WGS-84。每个点都带上 datum，
 * 画在哪张底图上由前端换算（src/util/geo-coords.js / public/tripcard.js）。
 *
 * 三条克制：
 *   1. 查过的都记盘（runtime/geo/places.json），同一个地方第二次不再打外部接口。
 *   2. 按对方的规矩限速：Nominatim 每秒最多一次（它的使用条款），高德个人开发者 3 次/秒。
 *   3. 高德每天打多少次有上限（默认 2000，map.amap_daily_cap 可改），到了就改走 OpenStreetMap，
 *      不让一张卡片把免费额度吃光。
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
const DAY_CAP = 2000;
const TTL_HIT = 30 * 864e5;
const TTL_MISS = 3 * 864e5;
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
/** @param {string} u */
const hostOf = (u) => { try { return new URL(u).host; } catch { return "地图服务"; } };

// ---------------- 设置 ----------------

/**
 * 地图这一节的设置，连带「Key 从哪来」。provider：auto（有 Key 用高德，没有用 OpenStreetMap）/ amap / osm。
 * 选了 osm 就一次也不打高德，哪怕连接器里填着 Key——有人就是不想把行程发给高德。
 * @param {any} config
 */
function settingsOf(config) {
  const m = (config && typeof config.map === "object" && config.map) || {};
  const provider = ["auto", "amap", "osm"].includes(m.provider) ? m.provider : "auto";
  const cap = Number.isFinite(+m.amap_daily_cap) && +m.amap_daily_cap >= 0 ? Math.floor(+m.amap_daily_cap) : DAY_CAP;
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
  return { provider, key, from, cap };
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

/** @type {{ loaded: boolean, map: Map<string, { t: number, r: any }>, day: string, used: number }} */
const cache = { loaded: false, map: new Map(), day: "", used: 0 };
const today = () => new Date().toLocaleDateString("sv");
function loadCache() {
  if (cache.loaded) return;
  cache.loaded = true;
  const raw = store.readJson(cacheFile(), null);
  if (!raw || typeof raw !== "object") return;
  for (const [k, v] of Object.entries(raw.items || {})) if (v && typeof v.t === "number") cache.map.set(k, v);
  if (raw.day === today()) { cache.day = raw.day; cache.used = +raw.used || 0; }
}
const saver = store.coalesce(async () => {
  while (cache.map.size > MAX_CACHE) cache.map.delete(/** @type {string} */ (cache.map.keys().next().value));
  await store.writeJsonAtomicAsync(cacheFile(), { day: cache.day, used: cache.used, items: Object.fromEntries(cache.map) }, { backup: false });
}, { minGapMs: 2000, onError: (e) => log.warn("geo", "地点缓存写盘失败", { err: String(e && e.message || e) }) });

/** @param {string} k */
function cached(k) {
  loadCache();
  const v = cache.map.get(k);
  if (!v) return undefined;
  if (Date.now() - v.t > (v.r ? TTL_HIT : TTL_MISS)) { cache.map.delete(k); return undefined; }
  cache.map.delete(k); cache.map.set(k, v); // 挪到队尾：最近用过的最后才被挤掉
  return v.r;
}
/** @param {string} k @param {any} r */
function remember(k, r) { cache.map.delete(k); cache.map.set(k, { t: Date.now(), r }); saver.request(); }

/** 今天的高德次数还够不够；够就记一次 @param {number} cap */
function spendAmap(cap) {
  loadCache();
  const d = today();
  if (cache.day !== d) { cache.day = d; cache.used = 0; }
  if (cache.used >= cap) return false;
  cache.used++;
  saver.request();
  return true;
}

// ---------------- 网络 ----------------

/** @param {string} url @param {{ headers?: Record<string,string>, timeoutMs?: number }} [o] */
async function getJson(url, { headers = {}, timeoutMs = 8000 } = {}) {
  const host = hostOf(url);
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

const CAP_HIT = "今天的高德查询次数到上限了，先改用 OpenStreetMap";

/** @param {URL} u @param {{ key: string, cap: number }} st */
async function amapGet(u, st) {
  if (!spendAmap(st.cap)) throw Object.assign(new Error(CAP_HIT), { capped: true });
  u.searchParams.set("key", st.key);
  const j = await gated("amap", () => getJson(u.toString()));
  if (String(j && j.status) !== "1") throw new Error(`高德：${s(j && j.info) || "没给原因"}${s(j && j.infocode) ? `（${s(j.infocode)}）` : ""}`);
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
 * @param {{ key: string, cap: number }} st @param {string} name @param {string} city
 */
async function amapPlace(st, name, city) {
  const u = new URL("/v5/place/text", bases.amap);
  u.searchParams.set("keywords", name.slice(0, 80));
  if (city) { u.searchParams.set("region", city); u.searchParams.set("city_limit", "true"); }
  u.searchParams.set("show_fields", "business,photos");
  u.searchParams.set("page_size", "3");
  const j = await amapGet(u, st);
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
    photo, src: "amap",
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
  const j = await gated("wikidata", () => getJson(u.toString(), { timeoutMs: 6000 }));
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
  const found = await gated("wikidata", () => getJson(q.toString(), { timeoutMs: 6000 }));
  const ids = (found && Array.isArray(found.search) ? found.search : []).map((x) => s(x && x.id)).filter((id) => /^Q\d{1,12}$/.test(id));
  if (!ids.length) return "";
  const g = new URL("/w/api.php", bases.wikidata);
  for (const [k, v] of Object.entries({ action: "wbgetentities", ids: ids.join("|"), props: "claims", format: "json" })) g.searchParams.set(k, v);
  const j = await gated("wikidata", () => getJson(g.toString(), { timeoutMs: 8000 }));
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

/** OpenStreetMap 的 Nominatim。每秒一次，带上能认出是谁的 User-Agent（它的使用条款要求） @param {string} name @param {string} city */
async function osmPlace(name, city) {
  const u = new URL("/search", bases.nominatim);
  u.searchParams.set("q", city && !name.includes(bareCity(city)) ? `${name}, ${city}` : name);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "1");
  u.searchParams.set("extratags", "1");
  u.searchParams.set("accept-language", "zh-CN,zh,en");
  const arr = await gated("nominatim", () => getJson(u.toString(), { timeoutMs: 10000 }));
  const p = Array.isArray(arr) ? arr[0] : null;
  const lng = p ? +p.lon : NaN, lat = p ? +p.lat : NaN;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const tags = p.extratags && typeof p.extratags === "object" ? p.extratags : {};
  let photo = "";
  const img = s(tags.image);
  if (/^https:\/\/(upload|commons)\.wikimedia\.org\//.test(img)) photo = img;
  else if (s(tags.wikidata)) {
    try { photo = await wikiPhoto(s(tags.wikidata)); }
    catch (e) { log.warn("geo", "Wikidata 头图没拿到", { err: String(/** @type {any} */ (e).message || e) }); }
  }
  const parts = s(p.display_name).split(/,\s*/).filter(Boolean);
  return {
    name: s(p.name) || name, lng, lat, datum: "wgs84",
    addr: parts.slice(1, 4).join("，").slice(0, 60),
    kind: OSM_KIND[s(p.type)] || OSM_KIND[s(p.category)] || "",
    rating: null, photo, src: "osm",
  };
}

// ---------------- 对外：查地点 ----------------

/**
 * 补照片。另记一条缓存（w|城市|名字），不动地点那条——不然为了补张图要把高德 / Nominatim 再打一遍。
 * 搜不到记 ""，按「没查到」那档过期，过几天再试。出错只记日志，地点照样给。
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
    return "";
  }
}

/**
 * @param {any} config
 * @param {Array<{ name?: string, city?: string }>} items
 * @returns {Promise<{ provider: string, items: Array<any>, notes: string[] }>}
 */
async function lookup(config, items) {
  const st = settingsOf(config);
  const notes = new Set();
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
  const out = await Promise.all(list.map(async (it) => {
    const name = s(it && it.name).slice(0, 80);
    const city = s(it && it.city).slice(0, 20);
    if (!name) return { ok: false };
    let failed = false;
    if (st.key) {
      const k = `a|${city}|${name}`;
      let r = cached(k);
      if (r === undefined) {
        try { r = await amapPlace(st, name, city); remember(k, r); }
        catch (e) { r = null; failed = true; notes.add(/** @type {any} */ (e).message); }
      }
      if (r) return { ok: true, ...r, photo: r.photo || await photoByName(name, city, r) };
    }
    const k = `o|${city}|${name}`;
    let r = cached(k);
    if (r === undefined) {
      try { r = await osmPlace(name, city); remember(k, r); }
      catch (e) { r = null; failed = true; notes.add(/** @type {any} */ (e).message); }
    }
    return r ? { ok: true, ...r, photo: r.photo || await photoByName(name, city, r) } : { ok: false, failed };
  }));
  return { provider: st.key ? "amap" : "osm", items: out, notes: [...notes] };
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
 * @param {{ key: string, cap: number }} st
 * @param {[number, number]} a GCJ-02 @param {[number, number]} b GCJ-02 @param {"walking"|"driving"} mode
 */
async function amapRoute(st, a, b, mode) {
  const u = new URL(`/v5/direction/${mode}`, bases.amap);
  u.searchParams.set("origin", a.map((x) => x.toFixed(6)).join(","));
  u.searchParams.set("destination", b.map((x) => x.toFixed(6)).join(","));
  u.searchParams.set("show_fields", "cost,polyline");
  const j = await amapGet(u, st);
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
      catch (e) { r = null; notes.add(/** @type {any} */ (e).message); }
    }
    return r || line;
  }));
  return { items: out, notes: [...notes] };
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
  // 每天的上限管的是卡片自己去查，不管这一下：是人点的，就一次。照算进今天的用量，但不被上限挡住——
  // 上限填 0、或者今天已经用到数了，点「测一下」还说「到上限了」，Key 到底对不对就没法知道了
  const r = await amapPlace({ key: k, cap: Infinity }, "天安门", "北京");
  return { ok: !!r, provider: "amap", msg: r ? `高德 Key 能用：查到「${r.name}」${r.photo ? "，带照片" : ""}` : "高德 Key 能用，但没查到测试地点" };
}

/** 只给测试用：换上游地址、关掉限速、清空缓存 @param {{ bases?: Partial<typeof BASES>, gaps?: Partial<typeof GAPS>, reset?: boolean }} o */
function _testing(o = {}) {
  if (o.bases) bases = { ...BASES, ...o.bases };
  if (o.gaps) gaps = { ...GAPS, ...o.gaps };
  if (o.reset) { cache.loaded = false; cache.map.clear(); cache.day = ""; cache.used = 0; }
  return { flush: () => saver.flush(), cacheFile: cacheFile() };
}

module.exports = { lookup, legs, test, settingsOf, thin, MAX_ITEMS, MAX_LEGS, UA, _testing };
