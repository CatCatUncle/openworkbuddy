// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 行程卡（聊天里的地图卡片）用的几个接口：
 *   GET  /api/geo/config                    用哪家查地点、有没有 Key（不给 Key 本身）、几种底图的坐标系和署名、
 *                                           这个月打了高德几次（设置页看）
 *   POST /api/geo/places   { items }        一批地点名 → 坐标、照片、评分（src/domains/geo/places.js）
 *   POST /api/geo/photos   { items }        钉子钉上之后再补的照片（去 Wikidata 找，慢，所以单独一趟）
 *   POST /api/geo/legs     { pairs }        相邻两站之间的路线 / 直线距离
 *   GET  /api/geo/tile/:src/:z/:x/:y        底图瓦片，本机记盘（src/domains/geo/tiles.js）
 *   GET  /api/geo/img?u=                    地点照片，只代理名单里的图床
 *   GET  /api/geo/qr?u=                     「发到手机」的二维码（SVG）。只编卡片自己生成的那几种导航链接，别的一律 400
 *   POST /api/geo/test     { key? }         设置页「测一下」。在 admin.PLATFORM_WRITE 里：拿的是整台服务器那把 Key
 *
 * 查地点、取瓦片谁都能用（看自己的聊天记录就要用到）；配 Key、测 Key 归平台管理员，走 /api/settings 那道闸。
 * 写法照 prompt-tpls.js：依赖由 createGeoRouter(deps) 一次填上，不回头 require server.js。
 */
const express = require("express");
const places = require("../../domains/geo/places");
const tiles = require("../../domains/geo/tiles");

let getConfig = () => ({});

/** @param {import("express").Response} res @param {() => Promise<any>} fn */
async function send(res, fn) {
  try { res.json(await fn()); }
  catch (e) { res.status((e && e.status) || 502).json({ error: (e && e.message) || String(e) }); }
}

/** @param {import("express").Response} res @param {() => Promise<{ buf: Buffer, type: string }>} fn */
async function sendImg(res, fn) {
  try {
    const { buf, type } = await fn();
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=604800");
    res.end(buf);
  } catch (e) {
    res.status((e && e.status) || 502).type("text/plain; charset=utf-8").end((e && e.message) || String(e));
  }
}

const router = express.Router();

router.get("/api/geo/config", (_req, res) => {
  const st = places.settingsOf(getConfig());
  res.json({ provider: st.provider, amap: !!st.key, keyFrom: st.from, sources: tiles.sources(), usage: places.usage(getConfig()) });
});

router.post("/api/geo/places", (req, res) => send(res, () => places.lookup(getConfig(), (req.body || {}).items)));
router.post("/api/geo/photos", (req, res) => send(res, () => places.photos((req.body || {}).items)));
router.post("/api/geo/legs", (req, res) => send(res, () => places.legs(getConfig(), (req.body || {}).pairs)));
router.post("/api/geo/test", (req, res) => send(res, () => places.test(getConfig(), (req.body || {}).key)));

router.get("/api/geo/tile/:src/:z/:x/:y", (req, res) => {
  const n = (v) => (/^\d{1,7}$/.test(String(v)) ? +v : NaN);
  const y = String(req.params.y).replace(/\.png$/, "");
  sendImg(res, () => tiles.tile(req.params.src, n(req.params.z), n(req.params.x), n(y)));
});

router.get("/api/geo/img", (req, res) => sendImg(res, () => tiles.image(String(req.query.u || ""))));

/**
 * 「发到手机」只编行程卡自己生成的导航链接（public/tripcard.js 的 legNavUrl / dayNavUrl / stopNavUrl）：
 * 高德 https://uri.amap.com/navigation、高德网页版路线规划 https://www.amap.com/dir（一天四站以上）、
 * Google 地图 https://www.google.com/maps/dir/。不是这几种的不编——不然它就是一台替任何人把任意网址做成二维码的机器，扫的人看不出指向哪。
 * 编进去的是解析后再拼回的地址（x.href），跟这里检查过的是同一串。
 */
const QR_MAX = 2000;
const NAV_LINKS = /** @type {Record<string, string>} */ ({ "uri.amap.com": "/navigation", "www.amap.com": "/dir", "www.google.com": "/maps/dir/" });
/** @param {unknown} u @returns {string} 能编的地址；不能编的抛 400 */
function navLink(u) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (typeof u !== "string" || !u) throw bad("没给链接");
  if (u.length > QR_MAX) throw bad("链接太长，编不进二维码");
  let x;
  try { x = new URL(u); } catch (e) { throw bad("这不是一个链接"); }
  if (x.protocol !== "https:" || x.username || x.password || x.port || NAV_LINKS[x.hostname] !== x.pathname) throw bad("只给行程卡里的导航链接生成二维码");
  return x.href;
}

router.get("/api/geo/qr", async (req, res) => {
  try {
    const svg = await require("qrcode").toString(navLink(req.query.u), { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(svg);
  } catch (e) {
    res.status((e && e.status) || 500).type("text/plain; charset=utf-8").end((e && e.message) || String(e));
  }
});

/** @param deps.getConfig () => 当前内存里的那份配置（热生效，所以每次现取） */
function createGeoRouter(deps = {}) {
  if (deps.getConfig) getConfig = deps.getConfig;
  return router;
}

module.exports = { createGeoRouter, navLink };
