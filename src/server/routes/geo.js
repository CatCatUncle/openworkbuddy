// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 行程卡（聊天里的地图卡片）用的几个接口：
 *   GET  /api/geo/config                    用哪家查地点、有没有 Key（不给 Key 本身）、几种底图的坐标系和署名
 *   POST /api/geo/places   { items }        一批地点名 → 坐标、照片、评分（src/domains/geo/places.js）
 *   POST /api/geo/legs     { pairs }        相邻两站之间的路线 / 直线距离
 *   GET  /api/geo/tile/:src/:z/:x/:y        底图瓦片，本机记盘（src/domains/geo/tiles.js）
 *   GET  /api/geo/img?u=                    地点照片，只代理名单里的图床
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
  res.json({ provider: st.provider, amap: !!st.key, keyFrom: st.from, sources: tiles.sources() });
});

router.post("/api/geo/places", (req, res) => send(res, () => places.lookup(getConfig(), (req.body || {}).items)));
router.post("/api/geo/legs", (req, res) => send(res, () => places.legs(getConfig(), (req.body || {}).pairs)));
router.post("/api/geo/test", (req, res) => send(res, () => places.test(getConfig(), (req.body || {}).key)));

router.get("/api/geo/tile/:src/:z/:x/:y", (req, res) => {
  const n = (v) => (/^\d{1,7}$/.test(String(v)) ? +v : NaN);
  const y = String(req.params.y).replace(/\.png$/, "");
  sendImg(res, () => tiles.tile(req.params.src, n(req.params.z), n(req.params.x), n(y)));
});

router.get("/api/geo/img", (req, res) => sendImg(res, () => tiles.image(String(req.query.u || ""))));

/** @param deps.getConfig () => 当前内存里的那份配置（热生效，所以每次现取） */
function createGeoRouter(deps = {}) {
  if (deps.getConfig) getConfig = deps.getConfig;
  return router;
}

module.exports = { createGeoRouter };
