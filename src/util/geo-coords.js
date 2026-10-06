// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 两套经纬度之间换算：WGS-84（GPS、OpenStreetMap）和 GCJ-02（高德，国内地图都用它）。
 *
 * 国内的点，同一个地方在两套坐标里差三五百米。高德查出来的点画到 OpenStreetMap 的底图上，
 * 翠湖公园的钉子会落在隔壁街区——所以服务端每个点都标上它是哪一套（datum），
 * 画图那一侧按底图的那一套换过去。国外的点两套是同一个数，原样返回。
 *
 * 「在不在国内」用的是几块矩形拼出来的近似边界，比一个大方框准：
 * 一个大方框会把首尔、大阪也框进来，平白给它们挪几百米。
 * public/tripcard.js 里有同一份（浏览器那边不能 require），test/trip-card.js 对答案。
 */

const A = 6378245.0;
const EE = 0.00669342162296594323;
// [西经界, 北纬界, 东经界, 南纬界]
const IN = [
  [79.4462, 49.2204, 96.33, 42.8899],
  [109.6872, 54.1415, 135.0002, 39.3742],
  [73.1246, 42.8899, 124.143255, 29.5297],
  [82.9684, 29.5297, 97.0352, 26.7186],
  [97.0253, 29.5297, 124.367395, 20.4127],
  [107.975793, 20.4127, 111.744104, 17.871542],
];
const OUT = [
  [119.921265, 25.398623, 122.497559, 21.785006],
  [101.8652, 22.284, 106.665, 20.0988],
  [106.4525, 21.5422, 108.051, 20.4878],
  [109.0323, 55.8175, 119.127, 50.3257],
  [127.4568, 55.8175, 137.0227, 49.5574],
  [131.2662, 44.8922, 137.0227, 42.5692],
];
/** @param {number[][]} rects @param {number} lng @param {number} lat */
const hit = (rects, lng, lat) => rects.some(([w, n, e, s]) => lng >= w && lng <= e && lat >= s && lat <= n);
/** @param {number} lng @param {number} lat */
const inChina = (lng, lat) => hit(IN, lng, lat) && !hit(OUT, lng, lat);

/** @param {number} x @param {number} y */
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}
/** @param {number} x @param {number} y */
function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}

/** @param {number} lng @param {number} lat @returns {[number, number]} */
function wgsToGcj(lng, lat) {
  if (!inChina(lng, lat)) return [lng, lat];
  let dLat = tLat(lng - 105, lat - 35);
  let dLng = tLng(lng - 105, lat - 35);
  const rad = (lat / 180) * Math.PI;
  let magic = Math.sin(rad);
  magic = 1 - EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * Math.PI);
  dLng = (dLng * 180) / ((A / sq) * Math.cos(rad) * Math.PI);
  return [lng + dLng, lat + dLat];
}

/** 反过来没有解析解，迭代几轮逼近（五轮误差已在厘米级） @param {number} lng @param {number} lat @returns {[number, number]} */
function gcjToWgs(lng, lat) {
  if (!inChina(lng, lat)) return [lng, lat];
  let x = lng, y = lat;
  for (let i = 0; i < 5; i++) {
    const [gx, gy] = wgsToGcj(x, y);
    x -= gx - lng;
    y -= gy - lat;
  }
  return [x, y];
}

/**
 * 一个点从它自己那套坐标换到目标那套。datum 只认 "gcj02" / "wgs84"，别的原样返回。
 * @param {number} lng @param {number} lat @param {string} from @param {string} to @returns {[number, number]}
 */
function convert(lng, lat, from, to) {
  if (from === to) return [lng, lat];
  if (from === "wgs84" && to === "gcj02") return wgsToGcj(lng, lat);
  if (from === "gcj02" && to === "wgs84") return gcjToWgs(lng, lat);
  return [lng, lat];
}

/** 两点直线距离（米） @param {number} lng1 @param {number} lat1 @param {number} lng2 @param {number} lat2 */
function distance(lng1, lat1, lng2, lat2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = { wgsToGcj, gcjToWgs, convert, inChina, distance };
