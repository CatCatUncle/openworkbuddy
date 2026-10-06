// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
// ================= 行程卡：按天切换的地图 + 时间线 =================
// 模型规划行程时在正文里写一段 ```itinerary JSON（口径见 src/util/itinerary.js），这里画成一张卡片：
//   上面一排「第1天 / 第2天」；左边是能拖、能缩放的地图（带照片和编号的钉子、两站之间的路线），
//   右边按上午 / 中午 / 下午 / 晚上排地点卡片，相邻两站之间标距离和「导航」；另一个视图是纯时间线。
// 坐标、照片、评分由服务端拿地点名去查（/api/geo/places）；底图瓦片和照片也走本机服务端（/api/geo/tile、/api/geo/img），
// 页面自己不往外发请求。
//
// 跟 renderMd 怎么配合：renderMd 遇到 ```itinerary 调 cardHtml()，吐一个带完整数据的静态占位
// （没点活之前它就是一份按天排好的文字，导出、复制、没加载这个文件的地方照样看得懂），
// 这里用 MutationObserver 把占位点活成交互卡片。流式输出时正文每 100ms 整段重画一次，占位也跟着被重建——
// 同一份数据（按内容算的 key）的那张活卡片直接搬进新占位：地图不重载，拖到哪还在哪，选的第几天也不变。
//
// 单独成文件同 svgfig.js：能在 Electron 里跑真 DOM 测试（test/frontend.js）。
// 数据口径和坐标换算各有一份在 src/util/ 下，test/trip-card.js 拿同一批样例两边对答案。
(function (root) {
  "use strict";

  // ---------------- 数据口径（跟 src/util/itinerary.js 同一套） ----------------
  const LIMIT = { days: 14, stops: 15, name: 40, time: 16, note: 140, kind: 12, city: 20, addr: 60, title: 40, summary: 160 };
  function str(v, n) {
    if (typeof v === "number" && Number.isFinite(v)) v = String(v);
    if (typeof v !== "string") return "";
    const s = v.replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
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
  function normDay(d) {
    if (Array.isArray(d)) d = { stops: d };
    if (!d || typeof d !== "object") return null;
    const raw = d.stops || d.items || d.places || d.spots || d.schedule || [];
    const stops = (Array.isArray(raw) ? raw : []).map(normStop).filter(Boolean).slice(0, LIMIT.stops);
    if (!stops.length) return null;
    return {
      label: str(d.label || (typeof d.day === "string" ? d.day : ""), 12),
      title: str(d.title || d.theme || d.name, LIMIT.title),
      summary: str(d.summary || d.desc || d.description || d.note, LIMIT.summary),
      stops,
    };
  }
  function normalize(obj) {
    if (Array.isArray(obj)) obj = { days: obj };
    if (!obj || typeof obj !== "object") return null;
    const raw = obj.days || obj.itinerary || obj.plan || [];
    const days = (Array.isArray(raw) ? raw : []).map(normDay).filter(Boolean).slice(0, LIMIT.days);
    if (!days.length) return null;
    return { title: str(obj.title || obj.name, LIMIT.title), city: str(obj.city || obj.destination, LIMIT.city), days };
  }
  function parse(text) {
    const s = String(text || "").trim();
    if (!s) return null;
    for (const t of [s, s.replace(/,\s*([}\]])/g, "$1")]) {
      try { return normalize(JSON.parse(t)); } catch (e) { /* 再试下一种 */ }
    }
    return null;
  }
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
  const dayLabel = (d, i) => d.label || `第${i + 1}天`;

  // ---------------- 坐标（跟 src/util/geo-coords.js 同一套） ----------------
  const A = 6378245.0, EE = 0.00669342162296594323;
  const IN = [[79.4462, 49.2204, 96.33, 42.8899], [109.6872, 54.1415, 135.0002, 39.3742], [73.1246, 42.8899, 124.143255, 29.5297],
    [82.9684, 29.5297, 97.0352, 26.7186], [97.0253, 29.5297, 124.367395, 20.4127], [107.975793, 20.4127, 111.744104, 17.871542]];
  const OUT = [[119.921265, 25.398623, 122.497559, 21.785006], [101.8652, 22.284, 106.665, 20.0988], [106.4525, 21.5422, 108.051, 20.4878],
    [109.0323, 55.8175, 119.127, 50.3257], [127.4568, 55.8175, 137.0227, 49.5574], [131.2662, 44.8922, 137.0227, 42.5692]];
  const hit = (rects, lng, lat) => rects.some(([w, n, e, s]) => lng >= w && lng <= e && lat >= s && lat <= n);
  const inChina = (lng, lat) => hit(IN, lng, lat) && !hit(OUT, lng, lat);
  function tLat(x, y) {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
    r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
    r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
    return r;
  }
  function tLng(x, y) {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
    r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
    r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
    return r;
  }
  function wgsToGcj(lng, lat) {
    if (!inChina(lng, lat)) return [lng, lat];
    let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
    const rad = (lat / 180) * Math.PI;
    let magic = Math.sin(rad);
    magic = 1 - EE * magic * magic;
    const sq = Math.sqrt(magic);
    dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * Math.PI);
    dLng = (dLng * 180) / ((A / sq) * Math.cos(rad) * Math.PI);
    return [lng + dLng, lat + dLat];
  }
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
  function convert(lng, lat, from, to) {
    if (from === to) return [lng, lat];
    if (from === "wgs84" && to === "gcj02") return wgsToGcj(lng, lat);
    if (from === "gcj02" && to === "wgs84") return gcjToWgs(lng, lat);
    return [lng, lat];
  }
  function distance(lng1, lat1, lng2, lat2) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ---------------- 小工具 ----------------
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
  /** renderMd 先把整段正文 HTML 转义过了，围栏里的 JSON 要先解回来 */
  const unescHtml = (s) => String(s || "").replace(/&(lt|gt|quot|#39|amp);/g, (_, k) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" }[k]));
  function hashKey(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + s.length.toString(36);
  }
  function fmtDist(m) {
    if (!Number.isFinite(m)) return "";
    return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} 米` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} 公里`;
  }
  function fmtDur(s) {
    if (!Number.isFinite(s) || s <= 0) return "";
    const min = Math.max(1, Math.round(s / 60));
    return min < 60 ? `约 ${min} 分钟` : `约 ${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ""}`;
  }
  const MODE = { walking: "步行", driving: "驾车", line: "直线" };
  const fx = (n) => (+n).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const imgUrl = (u) => "/api/geo/img?u=" + encodeURIComponent(u);

  // ---------------- 导航链接 ----------------
  /** 两站之间：国内去高德（GCJ-02），国外去 Google 地图（WGS-84） */
  function legNavUrl(a, b, mode) {
    const pa = convert(a.lng, a.lat, a.datum, "wgs84"), pb = convert(b.lng, b.lat, b.datum, "wgs84");
    if (inChina(pa[0], pa[1]) && inChina(pb[0], pb[1])) {
      const ga = convert(a.lng, a.lat, a.datum, "gcj02"), gb = convert(b.lng, b.lat, b.datum, "gcj02");
      return `https://uri.amap.com/navigation?from=${fx(ga[0])},${fx(ga[1])},${encodeURIComponent(a.name)}&to=${fx(gb[0])},${fx(gb[1])},${encodeURIComponent(b.name)}`
        + `&mode=${mode === "walking" ? "walk" : "car"}&coordinate=gaode&callnative=1`;
    }
    return `https://www.google.com/maps/dir/?api=1&origin=${fx(pa[1])},${fx(pa[0])}&destination=${fx(pb[1])},${fx(pb[0])}&travelmode=${mode === "walking" ? "walking" : "driving"}`;
  }
  /**
   * 一整天的路线：国外交给 Google 地图（途经点最多 8 个）；国内高德的网页导航只认一个途经点，
   * 所以三站以内给链接，再多就不给了（每两站之间那条「导航」还在）。国内外混着的也不给。
   */
  function dayNavUrl(pts) {
    if (pts.length < 2) return "";
    const wgs = pts.map((p) => convert(p.lng, p.lat, p.datum, "wgs84"));
    const cn = wgs.map(([x, y]) => inChina(x, y));
    if (cn.every(Boolean)) {
      if (pts.length > 3) return "";
      const g = pts.map((p) => convert(p.lng, p.lat, p.datum, "gcj02"));
      const last = g.length - 1;
      const via = g.length === 3 ? `&via=${fx(g[1][0])},${fx(g[1][1])},${encodeURIComponent(pts[1].name)}` : "";
      return `https://uri.amap.com/navigation?from=${fx(g[0][0])},${fx(g[0][1])},${encodeURIComponent(pts[0].name)}&to=${fx(g[last][0])},${fx(g[last][1])},${encodeURIComponent(pts[last].name)}${via}&mode=car&coordinate=gaode&callnative=1`;
    }
    if (cn.some(Boolean) || pts.length > 10) return "";
    const ll = wgs.map(([x, y]) => `${fx(y)},${fx(x)}`);
    const mid = ll.slice(1, -1);
    return `https://www.google.com/maps/dir/?api=1&origin=${ll[0]}&destination=${ll[ll.length - 1]}${mid.length ? "&waypoints=" + encodeURIComponent(mid.join("|")) : ""}&travelmode=driving`;
  }

  // ---------------- 静态占位（renderMd 里用） ----------------
  function staticHtml(it) {
    const days = it.days.map((d, i) => `<div class="tc-sday"><b>${esc(dayLabel(d, i))}${d.title ? " · " + esc(d.title) : ""}</b>`
      + (d.summary ? `<div class="tc-ssum">${esc(d.summary)}</div>` : "")
      + `<ol>${d.stops.map((s) => `<li>${s.time ? esc(s.time) + " · " : ""}<b>${esc(s.name)}</b>${s.note ? "：" + esc(s.note) : ""}</li>`).join("")}</ol></div>`).join("");
    return `<div class="tc-static">${it.title ? `<div class="tc-stitle">${esc(it.title)}</div>` : ""}${days}</div>`;
  }
  /**
   * renderMd 遇到 ```itinerary 时调这个。code 是 HTML 转义过的围栏正文。
   * 解不出来：还在往外吐字（open && live）给个「正在排行程」；否则回空串，调用方照普通代码块显示。
   */
  function cardHtml(code, o) {
    o = o || {};
    let raw = unescHtml(code);
    // 没闭合的围栏，结尾可能已经挂上收尾那三个反引号的前一两个：去掉再解，
    // 不然 JSON 刚写完那一帧画出卡片，下一帧又退回「正在排行程」，再下一帧才回来
    if (o.open) raw = raw.replace(/\n`{1,2}$/, "");
    const it = parse(raw);
    if (!it) {
      if (!(o.open && o.live)) return "";
      const n = (raw.match(/"name"\s*:/g) || []).length;
      return `<div class="tc tc-pending"><span class="tc-spin" aria-hidden="true"></span>正在排行程…${n ? `<span class="tc-pn">已写 ${n} 站</span>` : ""}</div>`;
    }
    const json = JSON.stringify(it);
    return `<div class="tc" data-tc-key="${hashKey(json)}" data-tc="${esc(json)}">${staticHtml(it)}</div>`;
  }

  /** 一张卡片（点没点活都行）按天排好的文字版：复制、导出用 */
  function staticOf(host) {
    let it = null;
    try { it = normalize(JSON.parse(host.dataset.tc || "")); } catch (e) { /* 下面退回原文字 */ }
    return it ? staticHtml(it) : esc(host.textContent || "");
  }

  // ---------------- 跟服务端要数据 ----------------
  let cfgP = null;
  const getCfg = () => cfgP || (cfgP = fetch("/api/geo/config").then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  /** 设置里改了地图那一节：下一张卡片重新问 */
  function resetConfig() { cfgP = null; }
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let j = null;
    try { j = await r.json(); } catch (e) { /* 下面按状态码说 */ }
    if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
    return j || {};
  }
  /** 查过的地点整页共用：同一份行程重新点活、两条消息提到同一个地方，都不再问服务端 */
  const placeMemo = new Map();
  const pkey = (name, city) => city + "|" + name;

  // ---------------- 墨卡托 ----------------
  const TS = 256;
  const world = (z) => TS * 2 ** z;
  const lngX = (lng, z) => ((lng + 180) / 360) * world(z);
  const latY = (lat, z) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world(z);
  };
  const xLng = (x, z) => (x / world(z)) * 360 - 180;
  const yLat = (y, z) => {
    const n = Math.PI - (2 * Math.PI * y) / world(z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };

  // ---------------- 活卡片 ----------------
  function makeWidget(it, key) {
    const el = document.createElement("div");
    el.className = "tc-w";
    const multi = it.days.length > 1;
    el.innerHTML = `<div class="tc-head"><div class="tc-ttl">${esc(it.title || (it.city ? it.city + "行程" : "行程"))}</div>`
      + `<button type="button" class="tc-found" aria-expanded="false">正在找地点…</button>`
      + `<div class="tc-views" role="tablist"><button type="button" role="tab" data-v="map">地图</button><button type="button" role="tab" data-v="timeline">时间线</button></div></div>`
      + `<div class="tc-tabs" role="tablist"${multi ? "" : " hidden"}>${it.days.map((d, i) => `<button type="button" role="tab" data-d="${i}">${esc(dayLabel(d, i))}</button>`).join("")}</div>`
      + `<div class="tc-list" hidden></div>`
      + `<div class="tc-body"><div class="tc-map" tabindex="0" aria-label="行程地图，拖动平移，双击放大">`
      + `<div class="tc-tiles"></div><svg class="tc-route" aria-hidden="true"></svg><div class="tc-pins"></div>`
      + `<div class="tc-zoom"><button type="button" data-z="1" aria-label="放大" title="放大">+</button><button type="button" data-z="-1" aria-label="缩小" title="缩小">−</button></div>`
      + `<div class="tc-attr"></div><div class="tc-msg" hidden></div></div><div class="tc-panel"></div></div>`
      + `<div class="tc-tl" hidden></div>`;
    const $ = (s) => el.querySelector(s);
    const map = $(".tc-map"), tilesEl = $(".tc-tiles"), routeEl = $(".tc-route"), pinsEl = $(".tc-pins"),
      panel = $(".tc-panel"), tl = $(".tc-tl"), body = $(".tc-body"), msg = $(".tc-msg"), attr = $(".tc-attr"),
      found = $(".tc-found"), list = $(".tc-list");

    const st = {
      day: 0, view: "map", userView: false,
      places: it.days.map(() => null),   // 每天：每站一个地点（没找到 null）；还没查 null 整天
      legs: it.days.map(() => []),       // 每天：第 i 段 = 第 i 站 → 第 i+1 站
      loading: it.days.map(() => null),
      notes: new Set(), provider: "",
      cfg: null, src: "", z: 12, cx: 0, cy: 0, fitted: -1, started: false, active: -1,
    };
    const tiles = new Map();

    // ---- 视图切换 ----
    function setView(v, byUser) {
      st.view = v;
      if (byUser) st.userView = true;
      body.hidden = v !== "map";
      tl.hidden = v !== "timeline";
      el.querySelectorAll(".tc-views button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === v)));
      if (v === "map") { fit(false); draw(); }
    }
    function setDay(d) {
      st.day = d;
      st.active = -1;
      el.querySelectorAll(".tc-tabs button").forEach((b) => b.setAttribute("aria-selected", String(+b.dataset.d === d)));
      renderPanel();
      renderTimeline();
      if (st.places[d]) afterLoad(d);
      else { msg.textContent = "正在找地点…"; msg.hidden = !st.started; }
      if (st.started) loadDay(d);
      fit(true);
      draw();
    }

    // ---- 右侧卡片 ----
    function stopPlace(d, i) { const p = st.places[d]; return p ? p[i] : undefined; }
    function renderPanel() {
      const d = st.day, day = it.days[d];
      const located = day.stops.map((s, i) => { const p = stopPlace(d, i); return p ? { ...p, name: s.name } : null; }).filter(Boolean);
      const nav = located.length === day.stops.length ? dayNavUrl(located) : "";
      let h = `<div class="tc-dh"><div class="tc-dl">${esc(dayLabel(day, d))}</div>${day.title ? `<div class="tc-dt">${esc(day.title)}</div>` : ""}`
        + (day.summary ? `<div class="tc-ds">${esc(day.summary)}</div>` : "")
        + (nav ? `<a class="tc-open" href="${esc(nav)}" target="_blank" rel="noopener">打开路线 ↗</a>` : "") + `</div>`;
      let seg = null;
      day.stops.forEach((s, i) => {
        if (i > 0) h += legHtml(d, i - 1);
        const sg = segmentOf(s.time);
        if (sg && sg !== seg) h += `<div class="tc-seg">${sg}</div>`;
        seg = sg || seg;
        const p = stopPlace(d, i);
        const kind = s.kind || (p && p.kind) || "";
        const meta = [s.time ? esc(s.time) : "", p && p.rating ? `<span class="tc-star">★ ${p.rating}</span>` : "", kind ? esc(kind) : ""].filter(Boolean).join(" · ");
        const ph = p && p.photo ? `<img alt="" loading="lazy" src="${esc(imgUrl(p.photo))}">` : "";
        // 没照片、照片取不到：方块里写地名头一个字，不留一块空白像没加载完
        const ini = [...String(s.name || "").trim()][0] || "";
        h += `<div class="tc-card${i === st.active ? " on" : ""}" data-i="${i}" tabindex="0">`
          + `<div class="tc-ph"><span class="tc-ini" aria-hidden="true">${esc(ini.toUpperCase())}</span>${ph}<span class="tc-no">${i + 1}</span></div>`
          + `<div class="tc-info"><div class="tc-nm">${esc(s.name)}</div>${meta ? `<div class="tc-meta">${meta}</div>` : ""}`
          + (s.note ? `<div class="tc-note">${esc(s.note)}</div>` : "")
          + (p === null ? `<div class="tc-miss">地图上没找到这个地方</div>` : "") + `</div></div>`;
      });
      panel.innerHTML = h;
      panel.querySelectorAll(".tc-ph img").forEach((img) => img.addEventListener("error", () => img.remove(), { once: true }));
    }
    function legHtml(d, i) {
      const leg = st.legs[d][i];
      const a = stopPlace(d, i), b = stopPlace(d, i + 1);
      if (!leg || !a || !b) return `<div class="tc-leg"><span class="tc-legline"></span></div>`;
      const s = it.days[d].stops;
      const bits = [MODE[leg.mode] || "", fmtDist(leg.distance), fmtDur(leg.duration)].filter(Boolean).join(" · ");
      const url = legNavUrl({ ...a, name: s[i].name }, { ...b, name: s[i + 1].name }, leg.mode);
      return `<div class="tc-leg"><span class="tc-legline"></span><span class="tc-legt">${esc(bits)}</span>`
        + `<a href="${esc(url)}" target="_blank" rel="noopener">导航 ›</a></div>`;
    }

    // ---- 时间线 ----
    function renderTimeline() {
      const day = it.days[st.day];
      let last = null;
      tl.innerHTML = (day.title ? `<div class="tc-tlh">${esc(dayLabel(day, st.day))} · ${esc(day.title)}</div>` : "")
        + day.stops.map((s) => {
          const lab = s.time || segmentOf(s.time);
          const show = lab && lab !== last;
          last = lab || last;
          return `<div class="tc-tlr"><div class="tc-tls">${show ? esc(lab) : ""}</div><div class="tc-tld"></div>`
            + `<div class="tc-tlt"><b>${esc(s.name)}</b>${s.note ? `<span>${esc(s.note)}</span>` : ""}</div></div>`;
        }).join("");
    }

    // ---- 找到几个地点 ----
    function renderFound() {
      const loaded = st.places.filter(Boolean);
      const total = it.days.reduce((a, d) => a + d.stops.length, 0);
      const got = loaded.reduce((a, ps) => a + ps.filter(Boolean).length, 0);
      const done = loaded.length === it.days.length;
      found.textContent = done ? `找到 ${got} 个地点 ›` : got ? `已找到 ${got} 个地点…` : "正在找地点…";
      if (done && got < total) found.title = `${total - got} 个没找到`;
      if (list.hidden) return;
      const src = st.provider === "amap" ? "地点数据：高德地图" : "地点数据：OpenStreetMap，照片：Wikimedia";
      list.innerHTML = it.days.map((d, di) => {
        const ps = st.places[di];
        return `<div class="tc-lday"><b>${esc(dayLabel(d, di))}</b>${d.stops.map((s, i) => {
          const p = ps ? ps[i] : undefined;
          const tail = p ? esc(p.addr || p.name) : p === null ? "没找到" : "还在找";
          return `<div class="tc-lrow${p ? "" : " miss"}"><span>${esc(s.name)}</span><em>${tail}</em></div>`;
        }).join("")}</div>`;
      }).join("") + `<div class="tc-lsrc">${src}${[...st.notes].map((n) => `<div class="tc-note-err">${esc(n)}</div>`).join("")}</div>`;
    }

    // ---- 查地点、查路 ----
    function loadDay(d) {
      if (st.loading[d]) return st.loading[d];
      st.loading[d] = (async () => {
        if (!st.cfg) st.cfg = await getCfg();
        const stops = it.days[d].stops;
        const q = stops.map((s) => ({ name: s.name, city: s.city || it.city }));
        const need = q.filter((x) => !placeMemo.has(pkey(x.name, x.city)));
        if (need.length) {
          try {
            const r = await post("/api/geo/places", { items: need });
            st.provider = r.provider || st.provider;
            (r.notes || []).forEach((n) => st.notes.add(n));
            (r.items || []).forEach((p, j) => { if (!(p && p.failed)) placeMemo.set(pkey(need[j].name, need[j].city), p && p.ok ? p : null); });
          } catch (e) { st.notes.add(e.message); }
        }
        if (!st.provider) st.provider = st.cfg && st.cfg.amap ? "amap" : "osm";
        st.places[d] = q.map((x) => placeMemo.get(pkey(x.name, x.city)) || null);
        const ps = st.places[d];
        const pairs = [];
        for (let i = 0; i + 1 < ps.length; i++) if (ps[i] && ps[i + 1]) pairs.push(i);
        if (pairs.length) {
          try {
            const pt = (p) => ({ lng: p.lng, lat: p.lat, datum: p.datum });
            const r = await post("/api/geo/legs", { pairs: pairs.map((i) => ({ a: pt(ps[i]), b: pt(ps[i + 1]) })) });
            (r.notes || []).forEach((n) => st.notes.add(n));
            pairs.forEach((i, j) => { st.legs[d][i] = (r.items || [])[j] || null; });
          } catch (e) { st.notes.add(e.message); }
        }
      })().catch((e) => { st.notes.add(e.message); st.places[d] = st.places[d] || it.days[d].stops.map(() => null); })
        .then(() => {
          renderFound();
          if (d !== st.day) return;
          renderPanel();
          fit(true);
          afterLoad(d);
          draw();
        });
      return st.loading[d];
    }
    function afterLoad(d) {
      const any = st.places[d] && st.places[d].some(Boolean);
      if (!any) {
        msg.hidden = false;
        msg.textContent = st.notes.size ? [...st.notes][0] : "这一天的地点在地图上都没找到";
        if (!st.userView) setView("timeline");
      } else {
        msg.hidden = true;
        if (!st.userView && st.view !== "map") setView("map");
      }
    }
    /** 第一天查完，顺着把后面几天也查了：「找到 N 个地点」要数全，切到第几天也不用等 */
    async function prefetch() {
      await loadDay(st.day);
      for (let d = 0; d < it.days.length; d++) if (!st.places[d]) await loadDay(d);
    }

    // ---- 地图 ----
    function srcOf(d) {
      const c = st.cfg || {}, S = c.sources || {};
      if (c.provider === "osm" || !S.amap) return "osm";
      const ps = (st.places[d] || []).filter(Boolean);
      const cn = ps.filter((p) => { const w = convert(p.lng, p.lat, p.datum, "wgs84"); return inChina(w[0], w[1]); }).length;
      return cn && cn * 2 >= ps.length ? "amap" : "osm";
    }
    const srcInfo = () => ((st.cfg && st.cfg.sources) || {})[st.src] || { datum: "wgs84", maxZoom: 18, attr: "" };
    const ptOf = (p) => convert(p.lng, p.lat, p.datum, srcInfo().datum);
    function fit(force) {
      const W = map.clientWidth, H = map.clientHeight;
      if (!W || !H || !st.cfg) return;
      if (!force && st.fitted === st.day) return;
      const ps = (st.places[st.day] || []).filter(Boolean);
      if (!ps.length) return;
      st.src = srcOf(st.day);
      const pts = ps.map(ptOf);
      const max = Math.min(16, srcInfo().maxZoom);
      let z = max;
      for (; z > 3; z--) {
        const xs = pts.map((p) => lngX(p[0], z)), ys = pts.map((p) => latY(p[1], z));
        if (Math.max(...xs) - Math.min(...xs) <= W - 90 && Math.max(...ys) - Math.min(...ys) <= H - 90) break;
      }
      const xs = pts.map((p) => lngX(p[0], z)), ys = pts.map((p) => latY(p[1], z));
      st.z = z;
      st.cx = (Math.max(...xs) + Math.min(...xs)) / 2;
      st.cy = (Math.max(...ys) + Math.min(...ys)) / 2;
      st.fitted = st.day;
    }
    let raf = 0;
    const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    function draw() {
      if (st.view !== "map") return;
      const W = map.clientWidth, H = map.clientHeight;
      const ps = st.places[st.day];
      if (!W || !H || !st.src || st.fitted !== st.day) {
        tilesEl.replaceChildren(); tiles.clear(); pinsEl.replaceChildren(); pinsKey = ""; routeEl.innerHTML = "";
        return;
      }
      const z = st.z, n = 2 ** z, ox = st.cx - W / 2, oy = st.cy - H / 2;
      // 底图
      const want = new Set();
      for (let x = Math.floor(ox / TS); x <= Math.floor((ox + W) / TS); x++) {
        for (let y = Math.max(0, Math.floor(oy / TS)); y <= Math.min(n - 1, Math.floor((oy + H) / TS)); y++) {
          const k = `${st.src}/${z}/${x}/${y}`;
          want.add(k);
          let img = tiles.get(k);
          if (!img) {
            img = document.createElement("img");
            img.alt = ""; img.draggable = false; img.decoding = "async";
            img.src = `/api/geo/tile/${st.src}/${z}/${((x % n) + n) % n}/${y}.png`;
            tiles.set(k, img);
            tilesEl.appendChild(img);
          }
          img.style.transform = `translate(${Math.round(x * TS - ox)}px, ${Math.round(y * TS - oy)}px)`;
        }
      }
      for (const [k, img] of tiles) if (!want.has(k)) { img.remove(); tiles.delete(k); }
      attr.textContent = srcInfo().attr || "";
      // 路线
      const lines = [];
      (st.legs[st.day] || []).forEach((leg, i) => {
        if (!leg || !ps || !ps[i] || !ps[i + 1]) return;
        const raw = leg.line && leg.line.length >= 2 && leg.mode !== "line"
          ? leg.line.map(([x, y]) => convert(x, y, leg.datum, srcInfo().datum))
          : [ptOf(ps[i]), ptOf(ps[i + 1])];
        const pts = raw.map(([x, y]) => `${(lngX(x, z) - ox).toFixed(1)},${(latY(y, z) - oy).toFixed(1)}`).join(" ");
        lines.push(`<polyline class="tc-rl${leg.mode === "line" ? " dash" : ""}" points="${pts}"/>`);
      });
      routeEl.setAttribute("width", W); routeEl.setAttribute("height", H);
      routeEl.innerHTML = lines.join("");
      // 钉子：元素建一次，拖动时只挪位置（每帧重建会让照片一闪一闪）
      syncPins();
      pinsEl.querySelectorAll(".tc-pin").forEach((b) => {
        const p = ps && ps[+b.dataset.i];
        if (!p) return;
        const [x, y] = ptOf(p);
        const px = lngX(x, z) - ox, py = latY(y, z) - oy;
        b.hidden = px < -40 || py < -40 || px > W + 40 || py > H + 40;
        b.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
        b.classList.toggle("on", +b.dataset.i === st.active);
      });
    }
    let pinsKey = "";
    function syncPins() {
      const ps = st.places[st.day] || [];
      const k = st.day + "|" + ps.map((p) => (p ? `${p.lng},${p.lat},${p.photo || ""}` : "-")).join(";");
      if (k === pinsKey) return;
      pinsKey = k;
      const stops = it.days[st.day].stops;
      pinsEl.innerHTML = ps.map((p, i) => (p
        ? `<button type="button" class="tc-pin" data-i="${i}" title="${esc(stops[i].name)}" aria-label="${i + 1}. ${esc(stops[i].name)}">`
          + (p.photo ? `<img alt="" draggable="false" src="${esc(imgUrl(p.photo))}">` : "") + `<span>${i + 1}</span></button>`
        : "")).join("");
      pinsEl.querySelectorAll("img").forEach((img) => img.addEventListener("error", () => img.remove(), { once: true }));
    }
    function zoomAt(dz, px, py) {
      const W = map.clientWidth, H = map.clientHeight;
      const nz = Math.max(3, Math.min(srcInfo().maxZoom, st.z + dz));
      if (nz === st.z || !st.src) return;
      if (px == null) { px = W / 2; py = H / 2; }
      const wx = st.cx - W / 2 + px, wy = st.cy - H / 2 + py;
      const lng = xLng(wx, st.z), lat = yLat(wy, st.z);
      st.z = nz;
      st.cx = lngX(lng, nz) - px + W / 2;
      st.cy = latY(lat, nz) - py + H / 2;
      draw();
    }
    function focusStop(i, pan) {
      st.active = i;
      panel.querySelectorAll(".tc-card").forEach((c) => c.classList.toggle("on", +c.dataset.i === i));
      const p = stopPlace(st.day, i);
      if (pan && p && st.src) {
        const [x, y] = ptOf(p);
        st.cx = lngX(x, st.z); st.cy = latY(y, st.z);
      }
      draw();
    }

    // ---- 交互 ----
    el.addEventListener("click", (e) => {
      const t = e.target.closest("button, .tc-card");
      if (!t || !el.contains(t)) return;
      if (t.dataset.v) setView(t.dataset.v, true);
      else if (t.dataset.d != null) setDay(+t.dataset.d);
      else if (t.dataset.z) zoomAt(+t.dataset.z);
      else if (t.classList.contains("tc-found")) {
        list.hidden = !list.hidden;
        found.setAttribute("aria-expanded", String(!list.hidden));
        renderFound();
      } else if (t.classList.contains("tc-pin")) {
        const i = +t.dataset.i;
        focusStop(i, false);
        const card = panel.querySelector(`.tc-card[data-i="${i}"]`);
        if (card) panel.scrollTo({ top: card.offsetTop - panel.offsetTop - 8, behavior: "smooth" });
      } else if (t.classList.contains("tc-card") && !e.target.closest("a")) focusStop(+t.dataset.i, true);
    });
    el.addEventListener("keydown", (e) => {
      const card = e.target.closest && e.target.closest(".tc-card");
      if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); focusStop(+card.dataset.i, true); }
      if (e.target === map && (e.key === "+" || e.key === "=")) zoomAt(1);
      if (e.target === map && e.key === "-") zoomAt(-1);
    });
    // 拖动：move/up 挂在 window 上——流式输出时整块卡片每 100ms 会被搬一次家，挂在元素上的指针捕获会丢
    let drag = null;
    map.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, a")) return;
      drag = { x: e.clientX, y: e.clientY, cx: st.cx, cy: st.cy };
      map.classList.add("grab");
    });
    const onMove = (e) => {
      if (!drag) return;
      st.cx = drag.cx - (e.clientX - drag.x);
      st.cy = drag.cy - (e.clientY - drag.y);
      redraw();
    };
    const onUp = () => { if (drag) { drag = null; map.classList.remove("grab"); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    map.addEventListener("dblclick", (e) => {
      if (e.target.closest("button, a")) return;
      const r = map.getBoundingClientRect();
      zoomAt(1, e.clientX - r.left, e.clientY - r.top);
    });
    // 滚轮只在按住 ⌘/Ctrl（触控板双指捏合也是这个）时缩放：普通滚轮留给聊天记录上下翻
    let wheelAcc = 0;
    map.addEventListener("wheel", (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      wheelAcc += e.deltaY;
      if (Math.abs(wheelAcc) < 40) return;
      const r = map.getBoundingClientRect();
      zoomAt(wheelAcc < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      wheelAcc = 0;
    }, { passive: false });
    panel.addEventListener("mouseover", (e) => {
      const c = e.target.closest(".tc-card");
      pinsEl.querySelectorAll(".tc-pin").forEach((p) => p.classList.toggle("hot", !!c && p.dataset.i === c.dataset.i));
    });
    panel.addEventListener("mouseleave", () => pinsEl.querySelectorAll(".tc-pin.hot").forEach((p) => p.classList.remove("hot")));

    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (st.fitted !== st.day) fit(false); redraw(); }) : null;
    if (ro) ro.observe(map);
    function start() {
      if (st.started) return;
      st.started = true;
      if (!st.places[st.day]) { msg.hidden = false; msg.textContent = "正在找地点…"; }
      prefetch();
    }
    const io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "200px" })
      : null;

    setDay(0);
    setView("map");
    renderFound();
    return {
      el, key,
      attached() { if (io && !st.started) io.observe(el); else start(); redraw(); },
      dispose() {
        if (io) io.disconnect();
        if (ro) ro.disconnect();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      },
      _state: st,
    };
  }

  // ---------------- 点活 ----------------
  /** key → 这份数据的活卡片们。离开页面超过 10 秒没被搬回来的，收掉 */
  const live = new Map();
  function prune() {
    const now = Date.now();
    for (const [k, ws] of live) {
      const keep = ws.filter((w) => {
        if (w.el.isConnected) { w.offSince = 0; return true; }
        if (!w.offSince) { w.offSince = now; return true; }
        if (now - w.offSince < 10000) return true;
        w.dispose();
        return false;
      });
      if (keep.length) live.set(k, keep); else live.delete(k);
    }
  }
  function hydrate(host) {
    if (!host || host.dataset.tcOn) return;
    host.dataset.tcOn = "1";
    const key = host.dataset.tcKey || "";
    prune();
    let w = (live.get(key) || []).find((x) => !x.el.isConnected);
    if (!w) {
      let it = null;
      try { it = normalize(JSON.parse(host.dataset.tc || "")); } catch (e) { /* 数据坏了就留着静态那份 */ }
      if (!it) return;
      w = makeWidget(it, key);
      if (!live.has(key)) live.set(key, []);
      live.get(key).push(w);
    }
    w.offSince = 0;
    host.classList.add("tc-on");
    host.replaceChildren(w.el);
    w.attached();
  }
  function hydrateAll(scope) {
    const s = scope || document;
    if (s.nodeType === 1 && s.matches(".tc[data-tc]")) hydrate(s);
    if (s.querySelectorAll) s.querySelectorAll(".tc[data-tc]:not([data-tc-on])").forEach(hydrate);
  }
  let watching = false;
  function watch() {
    if (watching || typeof MutationObserver !== "function" || !document.body) return;
    watching = true;
    hydrateAll(document);
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) hydrateAll(n);
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch, { once: true });
    else watch();
  }

  root.TripCard = {
    parse, normalize, segmentOf, dayLabel, cardHtml, staticHtml, staticOf, unescHtml, hashKey,
    wgsToGcj, gcjToWgs, convert, inChina, distance, legNavUrl, dayNavUrl, fmtDist, fmtDur,
    hydrate, hydrateAll, resetConfig, LIMIT, _live: live,
  };
})(window);
