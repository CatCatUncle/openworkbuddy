// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 行程卡的底图瓦片和地点照片：由本机服务端去取、记盘，页面只跟自己的服务端要。
 *
 * 为什么不让页面直接去拿：
 *   · 生成的网页、图表里的外链本来就一律剥掉（public/svgfig.js），聊天记录一打开就往外发请求、
 *     把「你在看哪儿」告诉第三方，跟这条线不合；
 *   · OpenStreetMap 的瓦片条款要求带能认出是谁的 User-Agent、要缓存、别反复拉同一张，浏览器给不了前两样；
 *   · 记了盘，翻回老对话不用再拉一遍，断网也能看已经看过的那几张。
 *
 * 两种底图：
 *   osm   OpenStreetMap 官方瓦片，WGS-84。国外的地方默认用它。
 *   amap  高德的公开栅格瓦片，GCJ-02，中文标注全、国内快。国内的地方默认用它。
 *
 * 照片只代理认得的几个图床（高德的照片、Wikimedia），每一跳跳转都重新对一遍名单——
 * 不然这个口子就是一个能替任何人去请求任意地址的代理。
 *
 * 盘上一共留多少：瓦片和照片合起来 200MB，超了从最久没用的删到八成。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const log = require("../../platform/log");
const { dataPath } = require("../../platform/paths");
const { UA } = require("./places");

const CAP_BYTES = 200 * 1024 * 1024;
const TILE_MAX_BYTES = 1024 * 1024;
const IMG_MAX_BYTES = 4 * 1024 * 1024;

/** @typedef {{ url: (z: number, x: number, y: number) => string, datum: string, maxZoom: number, conc: number, attr: string }} Source */
/** @type {Record<string, Source>} */
const SOURCES = {
  osm: {
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    datum: "wgs84", maxZoom: 19, conc: 2, attr: "© OpenStreetMap 贡献者",
  },
  amap: {
    url: (z, x, y) => `https://webrd0${1 + ((x + y) % 4)}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`,
    datum: "gcj02", maxZoom: 18, conc: 6, attr: "© 高德地图",
  },
};

/** 照片只代理这几个图床 */
// Wikimedia 的缩略图会从 commons 跳到 upload / thumb 等子域，跳去哪家说变就变，所以整个 wikimedia.org 都认
let imgHosts = [/(^|\.)amap\.com$/, /(^|\.)autonavi\.com$/, /(^|\.)wikimedia\.org$/];
/** 测试时把瓦片指到本机假服务 */
let tileBase = "";
let capBytes = CAP_BYTES;

const baseDir = () => path.join(process.env.OPENWORKBUDDY_DATA_DIR || dataPath("data"), "runtime", "geo");

// ---------------- 并发、去重 ----------------

/** @type {Record<string, { n: number, q: Array<() => void> }>} */
const slots = {};
/** @param {string} name @param {number} max @param {() => Promise<any>} fn */
async function limited(name, max, fn) {
  const sl = (slots[name] = slots[name] || { n: 0, q: [] });
  if (sl.n >= max) await new Promise((r) => sl.q.push(() => r(undefined)));
  sl.n++;
  try { return await fn(); }
  finally { sl.n--; const next = sl.q.shift(); if (next) next(); }
}
/** @type {Map<string, Promise<any>>} */
const inflight = new Map();
/** @param {string} key @param {() => Promise<any>} fn */
function once(key, fn) {
  let p = inflight.get(key);
  if (!p) { p = fn().finally(() => inflight.delete(key)); inflight.set(key, p); }
  return p;
}

// ---------------- 盘上缓存 ----------------

let used = -1;
let pruning = false;
async function walk(dir, out = /** @type {{ f: string, size: number, t: number }[]} */ ([])) {
  let ents = [];
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) await walk(f, out);
    else if (e.isFile()) { try { const st = await fs.promises.stat(f); out.push({ f, size: st.size, t: st.mtimeMs }); } catch {} }
  }
  return out;
}
/** 写进一个文件后记账；超了删最久没用的 @param {number} add */
async function account(add) {
  if (used < 0) used = (await walk(baseDir())).reduce((a, x) => a + x.size, 0);
  else used += add;
  if (used <= capBytes || pruning) return;
  pruning = true;
  try {
    const all = (await walk(baseDir())).filter((x) => !x.f.endsWith(".json")).sort((a, b) => a.t - b.t);
    let total = all.reduce((a, x) => a + x.size, 0);
    for (const x of all) {
      if (total <= capBytes * 0.8) break;
      try { await fs.promises.unlink(x.f); total -= x.size; } catch {}
    }
    used = total;
  } finally { pruning = false; }
}
/** @param {string} f */
async function readHit(f) {
  try {
    const buf = await fs.promises.readFile(f);
    const now = new Date();
    fs.promises.utimes(f, now, now).catch(() => {}); // 用过的往后排，删的时候最后轮到
    return buf;
  } catch { return null; }
}
/** @param {string} f @param {Buffer} buf */
async function writeFile(f, buf) {
  try {
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, f);
    await account(buf.length);
  } catch (e) {
    log.warn("geo", "地图缓存写盘失败", { err: String(/** @type {any} */ (e).message || e) });
  }
}

// ---------------- 取 ----------------

/** @param {string} url @param {{ redirect?: "follow" | "manual", headers?: Record<string,string> }} [o] */
async function fetchBytes(url, o = {}) {
  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": UA, ...(o.headers || {}) }, redirect: o.redirect || "follow", signal: AbortSignal.timeout(12000) });
  } catch (e) {
    const err = /** @type {any} */ (e);
    let host = "";
    try { host = new URL(url).host; } catch {}
    throw Object.assign(new Error(`${host} 连不上：${err && err.name === "TimeoutError" ? "12 秒没回" : (err && err.cause && err.cause.code) || (err && err.message) || String(e)}`), { status: 502 });
  }
  return r;
}
/** @param {Response} r @param {number} max */
async function bodyOf(r, max) {
  const len = +(r.headers.get("content-length") || 0);
  if (len > max) throw Object.assign(new Error(`图太大了（${Math.round(len / 1024)}KB）`), { status: 502 });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > max) throw Object.assign(new Error(`图太大了（${Math.round(buf.length / 1024)}KB）`), { status: 502 });
  return buf;
}

/**
 * 一张底图瓦片。返回 { buf, type }；参数不对抛 status 400，取不到抛 502。
 * @param {string} src @param {number} z @param {number} x @param {number} y
 */
async function tile(src, z, x, y) {
  const S = SOURCES[src];
  if (!S) throw Object.assign(new Error("没有这种底图"), { status: 400 });
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > S.maxZoom || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    throw Object.assign(new Error("瓦片编号不对"), { status: 400 });
  }
  const f = path.join(baseDir(), "tiles", src, String(z), String(x), `${y}.png`);
  const hit = await readHit(f);
  if (hit) return { buf: hit, type: sniff(hit) || "image/png" };
  return once(f, () => limited(src, S.conc, async () => {
    const url = tileBase ? `${tileBase}/${src}/${z}/${x}/${y}` : S.url(z, x, y);
    const r = await fetchBytes(url);
    if (!r.ok) throw Object.assign(new Error(`底图服务回了 HTTP ${r.status}`), { status: 502 });
    const buf = await bodyOf(r, TILE_MAX_BYTES);
    const type = sniff(buf);
    if (!type) throw Object.assign(new Error("底图服务回的不是图片"), { status: 502 });
    await writeFile(f, buf);
    return { buf, type };
  }));
}

/** 只认图片的头几个字节，不信对方的 Content-Type @param {Buffer} b */
function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length > 6 && b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return "";
}

/** 这个地址能不能代理：http(s)、名单里的域名、默认端口（测试放开端口） @param {string} u */
function allowed(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  if (x.protocol !== "https:" && x.protocol !== "http:") return false;
  if (x.username || x.password) return false;
  if (x.port && !tileBase) return false;
  return imgHosts.some((re) => re.test(x.hostname.toLowerCase()));
}

/**
 * 一张地点照片。跳转自己跟，每一跳都对名单。
 * @param {string} u
 */
async function image(u) {
  if (!allowed(u)) throw Object.assign(new Error("这个图片地址不在可代理的名单里"), { status: 400 });
  const key = crypto.createHash("sha1").update(u).digest("hex");
  const f = path.join(baseDir(), "img", key.slice(0, 2), key);
  const hit = await readHit(f);
  if (hit) return { buf: hit, type: sniff(hit) || "application/octet-stream" };
  return once(f, () => limited("img", 4, async () => {
    let url = u;
    for (let hop = 0; hop < 5; hop++) {
      const r = await fetchBytes(url, { redirect: "manual", headers: { Accept: "image/*" } });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        const next = loc ? new URL(loc, url).toString() : "";
        if (!next || !allowed(next)) throw Object.assign(new Error("图片跳到了名单外的地址"), { status: 502 });
        url = next;
        continue;
      }
      if (!r.ok) throw Object.assign(new Error(`图床回了 HTTP ${r.status}`), { status: 502 });
      const buf = await bodyOf(r, IMG_MAX_BYTES);
      const type = sniff(buf);
      if (!type) throw Object.assign(new Error("图床回的不是图片"), { status: 502 });
      await writeFile(f, buf);
      return { buf, type };
    }
    throw Object.assign(new Error("图片跳转太多次"), { status: 502 });
  }));
}

/** 前端要知道的底图信息：坐标系、最大缩放、署名 */
function sources() {
  return Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, { datum: v.datum, maxZoom: v.maxZoom, attr: v.attr }]));
}

/** 只给测试用 @param {{ tileBase?: string, imgHosts?: RegExp[], capBytes?: number, reset?: boolean }} o */
function _testing(o = {}) {
  if (o.tileBase !== undefined) tileBase = o.tileBase;
  if (o.imgHosts) imgHosts = o.imgHosts;
  if (o.capBytes) capBytes = o.capBytes;
  if (o.reset) used = -1;
}

module.exports = { tile, image, sources, allowed, sniff, SOURCES, _testing };
