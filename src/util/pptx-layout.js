// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * PPT 每一页「长什么样」：每个形状在哪、多大、什么底色和边框、字多大什么颜色、图片、表格、图表。
 * 前端照着这份数据按比例摆出来，看到的就是一页幻灯片，而不是一串念出来的字。
 *
 * 为什么要有这一层：以前预览只把每页的字念出来排成卡片。自己生成的汇报、别人发来的模板，
 * 点开都是一列列文字——底色、配图、版式、图表全没了，用户等于没看到这份 PPT。
 * macOS 上还能靠访达/Keynote 补一眼，Windows 上没有这条退路，「预览不了」说的就是这个。
 *
 * 只吐数据不吐 HTML：颜色一律是本层算出来的 #rrggbb / rgba(数字)，尺寸一律是数字，
 * 文字原样交给前端再转义，图片是从包里读出来的二进制再拼成 data URI。
 *
 * 单位：一页的宽固定为 10000「格」，高按比例（16:9 就是 5625）。字号、边框粗细、内边距也用格，
 * 前端换成 cqw（10000 格 = 100cqw）——不管面板多宽，一页里的东西都跟着一起缩放，不会错位。
 *
 * 继承：PowerPoint/WPS 存的文件里，占位符（标题、正文）往往连位置都不写，要到版式、母版里去找；
 * 字号、字色、项目符号一层层往上找，最后落到母版的标题样式/正文样式；颜色写的是主题色名，
 * 要经母版的颜色映射再到主题里取值。这些都在这里按顺序合起来。
 *
 * 认不出来的东西不硬画：没见过的预设形状当矩形，浏览器显示不了的图片格式（emf/wmf/tiff）
 * 画个虚线框写明是什么格式，SmartArt 用文件里存的那份画好的形状。
 */

const U = 10000;               // 一页的宽 = 10000 格
const EMU_PT = 12700;          // 1pt = 12700 EMU
const MEDIA_TOTAL = 40 * 1024 * 1024; // 一份 PPT 的图片一共最多放进来这么多
const MEDIA_ONE = 10 * 1024 * 1024;   // 单张图的上限
const ELS_PER_SLIDE = 600;     // 一页最多画多少个元素（模板里有上千个碎形状的也见过）
const DEPTH = 8;               // 组合套组合最多套几层

const PRESET_CLR = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00",
  gray: "808080", grey: "808080", darkGray: "A9A9A9", lightGray: "D3D3D3", orange: "FFA500",
  purple: "800080", navy: "000080", silver: "C0C0C0", maroon: "800000", teal: "008080", cyan: "00FFFF",
  magenta: "FF00FF", lime: "00FF00", olive: "808000", pink: "FFC0CB", brown: "A52A2A", gold: "FFD700",
};

// 浏览器能直接显示的图片格式；别的（emf/wmf/tiff…）画占位框
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

// 预设形状的轮廓（0~100 的相对坐标）。没列进来的当矩形画
const POLY = {
  triangle: "50,0 100,100 0,100",
  rtTriangle: "0,0 100,100 0,100",
  diamond: "50,0 100,50 50,100 0,50",
  flowChartDecision: "50,0 100,50 50,100 0,50",
  parallelogram: "25,0 100,0 75,100 0,100",
  flowChartInputOutput: "20,0 100,0 80,100 0,100",
  trapezoid: "25,0 75,0 100,100 0,100",
  pentagon: "50,0 100,38 81,100 19,100 0,38",
  homePlate: "0,0 80,0 100,50 80,100 0,100",
  chevron: "0,0 80,0 100,50 80,100 0,100 20,50",
  hexagon: "25,0 75,0 100,50 75,100 25,100 0,50",
  octagon: "29,0 71,0 100,29 100,71 71,100 29,100 0,71 0,29",
  rightArrow: "0,25 60,25 60,0 100,50 60,100 60,75 0,75",
  leftArrow: "100,25 40,25 40,0 0,50 40,100 40,75 100,75",
  upArrow: "25,100 25,40 0,40 50,0 100,40 75,40 75,100",
  downArrow: "25,0 75,0 75,60 100,60 50,100 0,60 25,60",
  leftRightArrow: "0,50 20,0 20,25 80,25 80,0 100,50 80,100 80,75 20,75 20,100",
  plus: "33,0 67,0 67,33 100,33 100,67 67,67 67,100 33,100 33,67 0,67 0,33 33,33",
  mathPlus: "40,10 60,10 60,40 90,40 90,60 60,60 60,90 40,90 40,60 10,60 10,40 40,40",
  star4: "50,0 62,38 100,50 62,62 50,100 38,62 0,50 38,38",
  star5: "50,0 61,35 98,35 68,57 79,91 50,70 21,91 32,57 2,35 39,35",
  star6: "50,0 63,25 93,25 75,50 93,75 63,75 50,100 37,75 7,75 25,50 7,25 37,25",
  snip1Rect: "0,0 83,0 100,17 100,100 0,100",
  snip2SameRect: "17,0 83,0 100,17 100,100 0,100 0,17",
  flowChartManualInput: "0,20 100,0 100,100 0,100",
  flowChartManualOperation: "0,0 100,0 80,100 20,100",
  flowChartPreparation: "20,0 80,0 100,50 80,100 20,100 0,50",
  flowChartOffpageConnector: "0,0 100,0 100,80 50,100 0,80",
  wedgeRectCallout: "0,0 100,0 100,80 58,80 20,100 33,80 0,80",
  notchedRightArrow: "0,25 70,25 70,0 100,50 70,100 70,75 0,75 15,50",
  stripedRightArrow: "0,25 6,25 6,75 0,75 0,25 10,25 10,75 12,75 12,25 75,25 75,0 100,50 75,100 75,75 12,75",
};
const ELLIPSE = /^(ellipse|flowChartConnector|donut|pie|chord|blockArc|arc|flowChartOr|flowChartSummingJunction|smileyFace|noSmoking)$/;
const ROUND = /^(roundRect|round1Rect|round2SameRect|round2DiagRect|snipRoundRect|flowChartAlternateProcess|flowChartTerminator|wedgeRoundRectCallout|plaque|bevel|frame|halfFrame|foldedCorner|cube|can)$/;
const LINE_GEOM = /^(line|lineInv|straightConnector1|bentConnector[2-5]|curvedConnector[2-5])$/;

// ---------------- 小工具 ----------------
const lname = (n) => (n && n.name ? n.name.slice(n.name.indexOf(":") + 1) : "");
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hexRgb(hex) {
  const h = String(hex || "").replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
}
function rgbHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return { h: 0, s: 0, l };
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h / 6, s, l };
}
function hslRgb({ h, s, l }) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: Math.round(f(h + 1 / 3) * 255), g: Math.round(f(h) * 255), b: Math.round(f(h - 1 / 3) * 255) };
}
/** {r,g,b,a} → CSS 颜色字符串。只会产出 #rrggbb 或 rgba(数字) 两种形状 */
function css(c) {
  if (!c) return null;
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  if (c.a >= 0.999) return "#" + h(c.r) + h(c.g) + h(c.b);
  return `rgba(${clamp(Math.round(c.r), 0, 255)},${clamp(Math.round(c.g), 0, 255)},${clamp(Math.round(c.b), 0, 255)},${r3(clamp(c.a, 0, 1))})`;
}

// ---------------- 自定义形状的公式 ----------------
// custGeom 的路径坐标可以写成「r」「wd2」或者 gdLst 里算出来的名字，不全是数字。
function guideEnv(w, h) {
  const ss = Math.min(w, h), ls = Math.max(w, h);
  const env = { w, h, l: 0, t: 0, r: w, b: h, hc: w / 2, vc: h / 2, ss, ls, wd2: w / 2, hd2: h / 2,
    cd2: 10800000, cd4: 5400000, cd8: 2700000, "3cd4": 16200000, "3cd8": 8100000, "5cd8": 13500000, "7cd8": 18900000 };
  for (const d of [3, 4, 5, 6, 8, 10, 12, 16, 32]) { env["wd" + d] = w / d; env["hd" + d] = h / d; env["ssd" + d] = ss / d; }
  env.ssd2 = ss / 2;
  return env;
}
function evalGuide(fmla, env) {
  const p = String(fmla || "").trim().split(/\s+/);
  const v = (s) => (s == null ? 0 : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : num(env[s]));
  const rad = (a) => (a / 60000) * Math.PI / 180;
  const [op, x, y, z] = [p[0], v(p[1]), v(p[2]), v(p[3])];
  switch (op) {
    case "val": return x;
    case "*/": return y === 0 && z === 0 ? 0 : z === 0 ? 0 : (x * y) / z;
    case "+-": return x + y - z;
    case "+/": return z === 0 ? 0 : (x + y) / z;
    case "?:": return x > 0 ? y : z;
    case "abs": return Math.abs(x);
    case "at2": return (Math.atan2(y, x) * 180 / Math.PI) * 60000;
    case "cat2": return x * Math.cos(Math.atan2(z, y));
    case "sat2": return x * Math.sin(Math.atan2(z, y));
    case "cos": return x * Math.cos(rad(y));
    case "sin": return x * Math.sin(rad(y));
    case "tan": return x * Math.tan(rad(y));
    case "max": return Math.max(x, y);
    case "min": return Math.min(x, y);
    case "mod": return Math.sqrt(x * x + y * y + z * z);
    case "pin": return y < x ? x : y > z ? z : y;
    case "sqrt": return Math.sqrt(Math.max(0, x));
    default: return 0;
  }
}

/**
 * @param {object} zip   preview.readZip 的返回
 * @param {object} h     preview.js 里的解析小工具：parseXml / findAll / kids / child / textOf / resolvePart
 */
function createLayoutReader(zip, h) {
  const { parseXml, findAll, kids, child, textOf, resolvePart } = h;
  const xmlCache = new Map();
  const xml = (part) => {
    if (!part) return null;
    if (!xmlCache.has(part)) {
      let r = null;
      try { const t = zip.has(part) ? zip.text(part) : null; r = t ? parseXml(t) : null; } catch { r = null; }
      xmlCache.set(part, r);
    }
    return xmlCache.get(part);
  };
  const relsCache = new Map();
  /** 某个部件的关系表：Id → { type, part（已解析成包内路径）, ext（外链时为 true） } */
  const relsOf = (part) => {
    if (relsCache.has(part)) return relsCache.get(part);
    const m = new Map();
    const root = xml(part.replace(/\/([^/]+)$/, "/_rels/$1.rels"));
    for (const r of root ? findAll(root, "Relationship") : []) {
      const ext = /^external$/i.test(r.attrs.TargetMode || "");
      m.set(r.attrs.Id, { type: String(r.attrs.Type || "").split("/").pop(), part: ext ? "" : resolvePart(part, r.attrs.Target || ""), ext });
    }
    relsCache.set(part, m);
    return m;
  };
  const relOfType = (part, type) => { for (const r of relsOf(part).values()) if (r.type === type) return r.part; return ""; };

  // ---- 整份文件共用：页面大小、图片表 ----
  const pres = xml("ppt/presentation.xml");
  const sz = pres ? findAll(pres, "p:sldSz")[0] : null;
  const SW = num(sz && sz.attrs.cx, 9144000) || 9144000;
  const SH = num(sz && sz.attrs.cy, 6858000) || 6858000;
  const K = U / SW;               // EMU → 格
  const HU = r1(SH * K);          // 一页的高（格）
  const g = (emu) => r1(num(emu) * K);
  const ptU = (pt) => r1(pt * EMU_PT * K); // 磅 → 格
  const defaultText = pres ? findAll(pres, "p:defaultTextStyle")[0] || null : null;

  const media = {};
  let mediaBytes = 0;
  const mediaKey = new Map(); // 包内路径 → media 里的键（同一张图多页复用只放一份）
  /** 图片：返回 { m: 键 } 或者 { bad: "emf" / "too-big" / "missing" } */
  const imageOf = (part, rid) => {
    const rel = relsOf(part).get(rid);
    if (!rel || rel.ext || !rel.part) return { bad: "missing" };
    if (mediaKey.has(rel.part)) return mediaKey.get(rel.part);
    const ext = (rel.part.split(".").pop() || "").toLowerCase();
    let out;
    if (!IMG_MIME[ext]) out = { bad: ext || "unknown" };
    else {
      let buf = null;
      try { buf = zip.get(rel.part); } catch { buf = null; }
      if (!buf) out = { bad: "missing" };
      else if (buf.length > MEDIA_ONE || mediaBytes + buf.length > MEDIA_TOTAL) out = { bad: "too-big" };
      else {
        const key = "m" + mediaKey.size;
        media[key] = `data:${IMG_MIME[ext]};base64,${buf.toString("base64")}`;
        mediaBytes += buf.length;
        out = { m: key };
      }
    }
    mediaKey.set(rel.part, out);
    return out;
  };

  // ---- 主题：颜色表、字体、填充样式 ----
  const themeCache = new Map();
  const themeOf = (masterPart) => {
    const tp = relOfType(masterPart, "theme");
    if (themeCache.has(tp)) return themeCache.get(tp);
    const root = xml(tp);
    const t = { colors: {}, major: {}, minor: {}, fills: [], lines: [], bgFills: [] };
    if (root) {
      const cs = findAll(root, "a:clrScheme")[0];
      for (const c of kids(cs)) {
        const v = kids(c)[0];
        if (!v) continue;
        const hex = lname(v) === "srgbClr" ? v.attrs.val : lname(v) === "sysClr" ? v.attrs.lastClr || (v.attrs.val === "window" ? "FFFFFF" : "000000") : "";
        const rgb = hexRgb(hex);
        if (rgb) t.colors[lname(c)] = rgb;
      }
      const fontOf = (el) => {
        if (!el) return {};
        const pick = (n) => { const e = child(el, n); return e ? String(e.attrs.typeface || "") : ""; };
        const hans = kids(el).find((c) => lname(c) === "font" && c.attrs.script === "Hans");
        return { latin: pick("a:latin"), ea: pick("a:ea") || (hans ? String(hans.attrs.typeface || "") : "") };
      };
      t.major = fontOf(findAll(root, "a:majorFont")[0]);
      t.minor = fontOf(findAll(root, "a:minorFont")[0]);
      const fl = findAll(root, "a:fillStyleLst")[0];
      const ll = findAll(root, "a:lnStyleLst")[0];
      const bl = findAll(root, "a:bgFillStyleLst")[0];
      t.fills = kids(fl); t.lines = kids(ll); t.bgFills = kids(bl);
    }
    themeCache.set(tp, t);
    return t;
  };

  // ---- 颜色 ----
  const CLR_TAGS = /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/;
  /** 一个含颜色的元素（solidFill / buClr / gs / 颜色本身）→ {r,g,b,a}；ph 是 phClr 要代入的颜色 */
  function colorIn(node, ctx, ph) {
    if (!node) return null;
    const el = CLR_TAGS.test(lname(node)) ? node : kids(node).find((c) => CLR_TAGS.test(lname(c)));
    if (!el) return null;
    let c = null;
    const k = lname(el), val = String(el.attrs.val || "");
    if (k === "srgbClr") c = hexRgb(val);
    else if (k === "sysClr") c = hexRgb(el.attrs.lastClr || (val === "window" ? "FFFFFF" : "000000"));
    else if (k === "prstClr") c = hexRgb(PRESET_CLR[val] || "");
    else if (k === "scrgbClr") c = { r: num(el.attrs.r) / 100000 * 255, g: num(el.attrs.g) / 100000 * 255, b: num(el.attrs.b) / 100000 * 255, a: 1 };
    else if (k === "hslClr") c = { ...hslRgb({ h: num(el.attrs.hue) / 21600000, s: num(el.attrs.sat) / 100000, l: num(el.attrs.lum) / 100000 }), a: 1 };
    else if (k === "schemeClr") {
      if (val === "phClr") c = ph ? { ...ph } : null;
      else {
        const mapped = (ctx.clrMap && ctx.clrMap[val]) || val;
        const t = ctx.theme.colors[mapped];
        c = t ? { ...t } : null;
      }
    }
    if (!c) return null;
    c = { ...c };
    for (const m of kids(el)) {
      const mv = num(m.attrs.val) / 100000;
      switch (lname(m)) {
        case "alpha": c.a = mv; break;
        case "alphaMod": c.a *= mv; break;
        case "alphaOff": c.a = clamp(c.a + mv, 0, 1); break;
        case "lumMod": case "lumOff": case "satMod": case "satOff": case "hueOff": case "hueMod": {
          const hsl = rgbHsl(c);
          const n = lname(m);
          if (n === "lumMod") hsl.l = clamp(hsl.l * mv, 0, 1);
          else if (n === "lumOff") hsl.l = clamp(hsl.l + mv, 0, 1);
          else if (n === "satMod") hsl.s = clamp(hsl.s * mv, 0, 1);
          else if (n === "satOff") hsl.s = clamp(hsl.s + mv, 0, 1);
          else if (n === "hueOff") hsl.h = (hsl.h + num(m.attrs.val) / 21600000 + 1) % 1;
          else hsl.h = (hsl.h * mv) % 1;
          Object.assign(c, hslRgb(hsl));
          break;
        }
        case "tint": c.r = 255 - (255 - c.r) * mv; c.g = 255 - (255 - c.g) * mv; c.b = 255 - (255 - c.b) * mv; break;
        case "shade": c.r *= mv; c.g *= mv; c.b *= mv; break;
        case "inv": c.r = 255 - c.r; c.g = 255 - c.g; c.b = 255 - c.b; break;
        case "gray": { const y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; c.r = c.g = c.b = y; break; }
        default: break;
      }
    }
    return c;
  }

  // ---- 填充 / 线条 ----
  /** spPr 这类容器里的填充。返回 undefined = 这一层没说（往上继承）；{ none:1 } = 明说不填 */
  function fillIn(holder, ctx, part, ph) {
    for (const c of kids(holder)) {
      const k = lname(c);
      if (k === "noFill") return { none: 1 };
      if (k === "solidFill") { const col = colorIn(c, ctx, ph); return col ? { c: css(col) } : { none: 1 }; }
      if (k === "gradFill") {
        const stops = findAll(c, "a:gs").map((s) => [r1(num(s.attrs.pos) / 1000), css(colorIn(s, ctx, ph))]).filter((s) => s[1]).sort((a, b) => a[0] - b[0]);
        if (!stops.length) return { none: 1 };
        const lin = child(c, "a:lin");
        const path = child(c, "a:path");
        return { g: stops.slice(0, 10), a: r1(num(lin && lin.attrs.ang) / 60000), radial: path ? 1 : 0 };
      }
      if (k === "blipFill") {
        const blip = child(c, "a:blip");
        const img = blip ? imageOf(part, blip.attrs["r:embed"] || "") : { bad: "missing" };
        return { img, tile: child(c, "a:tile") ? 1 : 0 };
      }
      if (k === "pattFill") { const fg = child(c, "a:fgClr"); const col = colorIn(fg, ctx, ph); return col ? { c: css(col) } : { none: 1 }; }
      if (k === "grpFill") return { grp: 1 };
    }
    return undefined;
  }
  function lineIn(ln, ctx, ph) {
    if (!ln) return undefined;
    const fill = kids(ln).find((c) => /^(noFill|solidFill|gradFill|pattFill)$/.test(lname(c)));
    const out = {};
    if (fill) {
      if (lname(fill) === "noFill") return { none: 1 };
      const col = lname(fill) === "gradFill" ? colorIn(findAll(fill, "a:gs")[0], ctx, ph) : colorIn(lname(fill) === "pattFill" ? child(fill, "a:fgClr") : fill, ctx, ph);
      if (col) out.c = css(col);
    }
    if (ln.attrs.w != null) out.w = Math.max(0.3, r1(num(ln.attrs.w) * K));
    const dash = child(ln, "a:prstDash");
    if (dash && dash.attrs.val && dash.attrs.val !== "solid") out.d = /dot/i.test(dash.attrs.val) && !/dash/i.test(dash.attrs.val) ? "dot" : "dash";
    const he = child(ln, "a:headEnd"), te = child(ln, "a:tailEnd");
    if (he && he.attrs.type && he.attrs.type !== "none") out.he = 1;
    if (te && te.attrs.type && te.attrs.type !== "none") out.te = 1;
    return Object.keys(out).length ? out : undefined;
  }
  /** p:style 里的 fillRef / lnRef / fontRef：形状没写自己的填充/线条/字色时用这里的 */
  function styleRefs(styleEl, ctx) {
    if (!styleEl) return {};
    const out = {};
    const fr = child(styleEl, "a:fillRef"), lr = child(styleEl, "a:lnRef"), fo = child(styleEl, "a:fontRef");
    if (fr && num(fr.attrs.idx) > 0) {
      const col = colorIn(fr, ctx);
      const tpl = ctx.theme.fills[num(fr.attrs.idx) - 1];
      const f = tpl ? fillIn({ children: [tpl] }, ctx, "", col) : undefined;
      out.fill = f && !f.none ? f : col ? { c: css(col) } : undefined;
    }
    if (lr && num(lr.attrs.idx) > 0) {
      const col = colorIn(lr, ctx);
      const tpl = ctx.theme.lines[num(lr.attrs.idx) - 1];
      out.line = (tpl && lineIn(tpl, ctx, col)) || (col ? { c: css(col), w: g(9525 * num(lr.attrs.idx)) } : undefined);
    }
    if (fo) { const col = colorIn(fo, ctx); if (col) out.font = css(col); }
    return out;
  }

  // ---- 文字样式：一层层合起来 ----
  function rPrOf(n, ctx) {
    if (!n) return {};
    const a = n.attrs, o = {};
    if (a.sz != null) o.sz = num(a.sz) / 100;
    if (a.b != null) o.b = a.b === "1" || a.b === "true";
    if (a.i != null) o.i = a.i === "1" || a.i === "true";
    if (a.u != null) o.u = a.u !== "none";
    if (a.strike != null) o.s = a.strike !== "noStrike";
    if (a.baseline != null && num(a.baseline)) o.sup = num(a.baseline) > 0 ? "sup" : "sub";
    if (a.cap === "all") o.cap = 1;
    const fill = kids(n).find((c) => /^(solidFill|gradFill|noFill)$/.test(lname(c)));
    if (fill) {
      if (lname(fill) === "noFill") o.c = "transparent";
      else { const col = colorIn(lname(fill) === "gradFill" ? findAll(fill, "a:gs")[0] : fill, ctx); if (col) o.c = css(col); }
    }
    const lat = child(n, "a:latin"), ea = child(n, "a:ea");
    if (lat && lat.attrs.typeface) o.lat = lat.attrs.typeface;
    if (ea && ea.attrs.typeface) o.ea = ea.attrs.typeface;
    const hl = child(n, "a:highlight");
    if (hl) { const col = colorIn(hl, ctx); if (col) o.hl = css(col); }
    return o;
  }
  function pPrOf(n, ctx) {
    if (!n) return {};
    const a = n.attrs, o = {};
    if (a.algn) o.algn = a.algn;
    if (a.marL != null) o.marL = num(a.marL);
    if (a.indent != null) o.indent = num(a.indent);
    const sp = (tag) => {
      const e = child(n, tag);
      if (!e) return undefined;
      const pct = child(e, "a:spcPct"), pts = child(e, "a:spcPts");
      return pct ? { pct: num(pct.attrs.val) / 100000 } : pts ? { pt: num(pts.attrs.val) / 100 } : undefined;
    };
    const ln = sp("a:lnSpc"), bf = sp("a:spcBef"), af = sp("a:spcAft");
    if (ln) o.lnSpc = ln;
    if (bf) o.spcBef = bf;
    if (af) o.spcAft = af;
    for (const c of kids(n)) {
      const k = lname(c);
      if (k === "buNone") o.bu = { none: 1 };
      else if (k === "buChar") o.bu = { ch: String(c.attrs.char || "•").slice(0, 2) };
      else if (k === "buAutoNum") o.bu = { num: String(c.attrs.type || "arabicPeriod"), start: num(c.attrs.startAt, 1) || 1 };
      else if (k === "buBlip") o.bu = { ch: "•" };
      else if (k === "buClr") { const col = colorIn(c, ctx); if (col) o.buClr = css(col); }
      else if (k === "buClrTx") o.buClr = null;
      else if (k === "buSzPct") o.buSz = num(c.attrs.val) / 100000;
    }
    const d = child(n, "a:defRPr");
    if (d) o.def = rPrOf(d, ctx);
    return o;
  }
  const mergeP = (base, top) => {
    const out = { ...base, ...top };
    out.def = { ...(base.def || {}), ...(top.def || {}) };
    return out;
  };
  /** 一个 lstStyle（或母版的 titleStyle/bodyStyle）里第 lvl 级的段落样式 */
  function lvlOf(lst, lvl, ctx) {
    if (!lst) return {};
    const def = child(lst, "a:defPPr");
    const one = child(lst, `a:lvl${lvl + 1}pPr`);
    return mergeP(pPrOf(def, ctx), pPrOf(one, ctx));
  }

  // ---- 占位符：去版式、母版里找同一个位置 ----
  const phOf = (el) => {
    const nv = kids(el).find((c) => /^nv\w*Pr$/.test(lname(c)));
    const nvPr = nv ? kids(nv).find((c) => lname(c) === "nvPr") : null;
    const ph = nvPr ? child(nvPr, "p:ph") : null;
    if (!ph) return null;
    return { type: String(ph.attrs.type || ""), idx: ph.attrs.idx != null ? String(ph.attrs.idx) : "" };
  };
  const phKind = (t) => (t === "ctrTitle" || t === "title" ? "title" : !t || t === "obj" || t === "subTitle" || t === "body" ? "body" : t);
  const phList = (root) => {
    const out = [];
    const tree = root ? findAll(root, "p:spTree")[0] : null;
    const walk = (n) => { for (const c of kids(n)) { const k = lname(c); if (k === "grpSp") walk(c); else if (/^(sp|pic|graphicFrame)$/.test(k)) { const ph = phOf(c); if (ph) out.push({ el: c, ...ph }); } } };
    if (tree) walk(tree);
    return out;
  };
  const phListCache = new Map();
  const phsOf = (part) => { if (!phListCache.has(part)) phListCache.set(part, phList(xml(part))); return phListCache.get(part); };
  function phChain(ph, ctx) {
    const chain = [];
    const lay = phsOf(ctx.layoutPart);
    let l = null;
    if (ph.idx) l = lay.find((p) => p.idx === ph.idx);
    if (!l) l = lay.find((p) => p.type === ph.type) || lay.find((p) => phKind(p.type) === phKind(ph.type) && (phKind(ph.type) !== "body" || !ph.idx));
    if (l) chain.push(l.el);
    const want = phKind((l && l.type) || ph.type);
    const m = phsOf(ctx.masterPart).find((p) => phKind(p.type) === want);
    if (m) chain.push(m.el);
    return chain; // 由近到远：版式那个、母版那个
  }

  // ---- 一个形状 ----
  const spPrOf = (el) => kids(el).find((c) => lname(c) === "spPr" || lname(c) === "grpSpPr") || null;
  const xfrmOf = (el) => {
    if (lname(el) === "graphicFrame") return kids(el).find((c) => lname(c) === "xfrm") || null;
    const pr = spPrOf(el);
    return pr ? child(pr, "a:xfrm") : null;
  };
  /** a:xfrm → 页面上的框（格），经过组合的坐标换算 */
  function boxOf(xf, tf) {
    const off = child(xf, "a:off"), ext = child(xf, "a:ext");
    if (!off || !ext) return null;
    let x = num(off.attrs.x), y = num(off.attrs.y), w = num(ext.attrs.cx), hh = num(ext.attrs.cy);
    if (tf) { x = tf.ox + (x - tf.cx) * tf.sx; y = tf.oy + (y - tf.cy) * tf.sy; w *= tf.sx; hh *= tf.sy; }
    return { x, y, w, h: hh, rot: num(xf.attrs.rot) / 60000, fh: xf.attrs.flipH === "1", fv: xf.attrs.flipV === "1" };
  }

  function geomOf(spPr, box) {
    const pg = spPr ? child(spPr, "a:prstGeom") : null;
    if (pg) {
      const prst = String(pg.attrs.prst || "rect");
      if (LINE_GEOM.test(prst)) return { line: prst };
      if (ELLIPSE.test(prst)) return { t: "ellipse" };
      if (ROUND.test(prst)) {
        const gd = findAll(pg, "a:gd").find((x) => x.attrs.name === "adj");
        const adj = gd ? num(String(gd.attrs.fmla || "").replace(/^val\s+/, ""), 16667) : prst === "flowChartTerminator" ? 50000 : 16667;
        return { t: "round", r: r1(Math.min(box.w, box.h) * K * clamp(adj, 0, 50000) / 100000) };
      }
      if (POLY[prst]) return { t: "poly", p: POLY[prst] };
      return { t: "rect" };
    }
    const cg = spPr ? child(spPr, "a:custGeom") : null;
    if (cg) {
      const d = custPath(cg, box);
      return d ? { t: "path", d } : { t: "rect" };
    }
    return { t: "rect" };
  }
  /** custGeom → SVG 路径（坐标已换成这个形状自己的格） */
  function custPath(cg, box) {
    const W = box.w * K, H = box.h * K;
    const env = guideEnv(box.w, box.h);
    for (const lst of [child(cg, "a:avLst"), child(cg, "a:gdLst")]) for (const gd of kids(lst)) env[gd.attrs.name] = evalGuide(gd.attrs.fmla, env);
    const pl = child(cg, "a:pathLst");
    const parts = [];
    for (const p of kids(pl).slice(0, 50)) {
      const pw = num(p.attrs.w) || box.w || 1, ph = num(p.attrs.h) || box.h || 1;
      const sx = W / pw, sy = H / ph;
      const pv = (s) => (/^-?\d+(\.\d+)?$/.test(String(s)) ? Number(s) : num(env[s]));
      let cx = 0, cy = 0;
      const pt = (e) => { const x = pv(e.attrs.x), y = pv(e.attrs.y); return [x, y]; };
      const out = [];
      for (const cmd of kids(p).slice(0, 2000)) {
        const k = lname(cmd), pts = kids(cmd).filter((c) => lname(c) === "pt").map(pt);
        if (k === "moveTo" && pts[0]) { [cx, cy] = pts[0]; out.push(`M${r1(cx * sx)} ${r1(cy * sy)}`); }
        else if (k === "lnTo" && pts[0]) { [cx, cy] = pts[0]; out.push(`L${r1(cx * sx)} ${r1(cy * sy)}`); }
        else if (k === "cubicBezTo" && pts.length === 3) { out.push("C" + pts.map(([x, y]) => `${r1(x * sx)} ${r1(y * sy)}`).join(" ")); [cx, cy] = pts[2]; }
        else if (k === "quadBezTo" && pts.length === 2) { out.push("Q" + pts.map(([x, y]) => `${r1(x * sx)} ${r1(y * sy)}`).join(" ")); [cx, cy] = pts[1]; }
        else if (k === "arcTo") {
          const wr = pv(cmd.attrs.wR), hr = pv(cmd.attrs.hR), st = pv(cmd.attrs.stAng) / 60000 * Math.PI / 180, sw = pv(cmd.attrs.swAng) / 60000 * Math.PI / 180;
          // 当前点在椭圆上角度 st 的位置：先倒推出圆心，再算终点
          const ox = cx - wr * Math.cos(st), oy = cy - hr * Math.sin(st);
          const ex = ox + wr * Math.cos(st + sw), ey = oy + hr * Math.sin(st + sw);
          if (Math.abs(sw) >= 2 * Math.PI - 1e-6) {
            const mx = ox + wr * Math.cos(st + Math.PI), my = oy + hr * Math.sin(st + Math.PI);
            out.push(`A${r1(wr * sx)} ${r1(hr * sy)} 0 0 1 ${r1(mx * sx)} ${r1(my * sy)}`, `A${r1(wr * sx)} ${r1(hr * sy)} 0 0 1 ${r1(cx * sx)} ${r1(cy * sy)}`);
          } else out.push(`A${r1(wr * sx)} ${r1(hr * sy)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${r1(ex * sx)} ${r1(ey * sy)}`);
          cx = ex; cy = ey;
        } else if (k === "close") out.push("Z");
      }
      if (out.length) parts.push(out.join(""));
    }
    const d = parts.join(" ");
    return d.length > 200000 ? "" : d;
  }

  /** 文字框里的段落 → 前端要的结构 */
  function textOfBody(txBody, ctx, o) {
    if (!txBody) return null;
    const bodyPr = child(txBody, "a:bodyPr");
    const ba = { ...(o.bodyAttrs || {}), ...(bodyPr ? bodyPr.attrs : {}) };
    const fit = bodyPr && child(bodyPr, "a:normAutofit");
    const fitFrom = fit || o.inheritedFit || null;
    const scale = fitFrom && fitFrom.attrs.fontScale ? num(fitFrom.attrs.fontScale) / 100000 : 1;
    const lnRed = fitFrom && fitFrom.attrs.lnSpcReduction ? num(fitFrom.attrs.lnSpcReduction) / 100000 : 0;
    const lst = child(txBody, "a:lstStyle");
    const paras = [];
    const counters = [];
    let any = false;
    for (const p of kids(txBody).filter((c) => lname(c) === "p")) {
      const ppr = child(p, "a:pPr");
      const lvl = clamp(num(ppr && ppr.attrs.lvl), 0, 8);
      // 由远到近：表演示文稿默认 → 母版文字样式 → 母版/版式占位符的 lstStyle → 自己的 lstStyle → 段落
      let st = lvlOf(defaultText, lvl, ctx);
      st = mergeP(st, lvlOf(o.masterStyle, lvl, ctx));
      for (const l of o.inheritLst || []) st = mergeP(st, lvlOf(l, lvl, ctx));
      // 形状样式里的字色（深色块上的白字）压过母版/默认的字色，但让位给形状自己写的
      if (o.fontColor) st.def = { ...st.def, c: o.fontColor };
      st = mergeP(st, lvlOf(lst, lvl, ctx));
      st = mergeP(st, pPrOf(ppr, ctx));
      const baseR = { sz: 18, ...st.def };
      const runs = [];
      for (const r of kids(p)) {
        const k = lname(r);
        if (k === "r" || k === "fld") {
          const t = textOf(child(r, "a:t"));
          if (!t) continue;
          const rp = { ...baseR, ...rPrOf(child(r, "a:rPr"), ctx) };
          runs.push(runOut(t, rp, ctx, scale));
        } else if (k === "br") runs.push({ br: 1 });
      }
      const endR = { ...baseR, ...rPrOf(child(p, "a:endParaRPr"), ctx) };
      const fsEnd = ptU(endR.sz * scale);
      const para = { al: st.algn && st.algn !== "l" ? st.algn : undefined, runs };
      if (st.marL) para.ml = g(st.marL);
      if (st.indent) para.ind = g(st.indent);
      const fsFirst = runs.find((x) => x.fs) ? runs.find((x) => x.fs).fs : fsEnd;
      if (st.lnSpc) {
        if (st.lnSpc.pct != null) para.lh = r3(Math.max(0.5, st.lnSpc.pct * 1.2 * (1 - lnRed)));
        else para.lhu = ptU(st.lnSpc.pt * scale);
      } else if (lnRed) para.lh = r3(1.2 * (1 - lnRed));
      const spc = (s) => (!s ? 0 : s.pt != null ? ptU(s.pt * scale) : r3(fsFirst * s.pct * 1.2));
      const sb = spc(st.spcBef), sa = spc(st.spcAft);
      if (sb) para.sb = sb;
      if (sa) para.sa = sa;
      // 项目符号：空段落不画
      const hasText = runs.some((x) => x.t);
      if (st.bu && !st.bu.none && hasText) {
        if (st.bu.num) {
          for (let k = lvl + 1; k < counters.length; k++) counters[k] = null;
          const cur = counters[lvl];
          const n = cur && cur.type === st.bu.num ? cur.n + 1 : st.bu.start;
          counters[lvl] = { type: st.bu.num, n };
          para.bu = autoNum(st.bu.num, n);
        } else { para.bu = st.bu.ch; counters[lvl] = null; }
        if (st.buClr) para.buc = st.buClr;
        else if (runs[0] && runs[0].c) para.buc = runs[0].c;
        if (st.buSz && st.buSz !== 1) para.bus = r3(clamp(st.buSz, 0.25, 4));
      } else if (hasText) counters.length = 0;
      if (!hasText) para.efs = fsEnd;
      if (hasText) any = true;
      paras.push(para);
    }
    if (!any) return null;
    const ins = (k, d) => g(ba[k] != null ? num(ba[k]) : d);
    const out = { p: paras, ins: [ins("lIns", 91440), ins("tIns", 45720), ins("rIns", 91440), ins("bIns", 45720)] };
    if (ba.anchor && ba.anchor !== "t") out.an = ba.anchor === "ctr" ? "m" : ba.anchor === "b" ? "b" : undefined;
    if (ba.wrap === "none") out.nw = 1;
    if (ba.vert && ba.vert !== "horz") out.v = ba.vert === "vert270" ? "270" : ba.vert === "eaVert" || ba.vert === "mongolianVert" || ba.vert === "wordArtVertRtl" ? "ea" : "90";
    if (ba.rot) out.rot = r1(num(ba.rot) / 60000);
    return out;
  }
  function fontsOf(rp, ctx) {
    const resolve = (f) => {
      if (!f) return "";
      if (f.startsWith("+mj")) return f.endsWith("ea") ? ctx.theme.major.ea : ctx.theme.major.latin;
      if (f.startsWith("+mn")) return f.endsWith("ea") ? ctx.theme.minor.ea : ctx.theme.minor.latin;
      return f;
    };
    const lat = resolve(rp.lat || "+mn-lt"), ea = resolve(rp.ea || "+mn-ea");
    const out = [];
    for (const f of [lat, ea]) {
      const clean = String(f || "").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, 60);
      if (clean && !out.includes(clean)) out.push(clean);
    }
    return out;
  }
  function runOut(t, rp, ctx, scale) {
    const o = { t: rp.cap ? t.toUpperCase() : t, fs: ptU(rp.sz * scale) };
    if (rp.b) o.b = 1;
    if (rp.i) o.i = 1;
    if (rp.u) o.u = 1;
    if (rp.s) o.s = 1;
    if (rp.sup) o.sup = rp.sup;
    if (rp.c) o.c = rp.c;
    if (rp.hl) o.hl = rp.hl;
    const f = fontsOf(rp, ctx);
    if (f.length) o.f = f;
    return o;
  }

  // ---- 表格 ----
  function tableOf(tbl, ctx, part, box) {
    const grid = findAll(child(tbl, "a:tblGrid") || { children: [] }, "a:gridCol").map((c) => num(c.attrs.w));
    const tw = grid.reduce((s, x) => s + x, 0) || box.w || 1;
    const tp = child(tbl, "a:tblPr");
    const firstRow = tp && tp.attrs.firstRow === "1", band = tp && tp.attrs.bandRow === "1";
    const styled = tp && !!child(tp, "a:tableStyleId");
    const accent = ctx.theme.colors.accent1 || hexRgb("4472C4");
    const rows = [];
    findAll(tbl, "a:tr").slice(0, 200).forEach((tr, ri) => {
      const cells = [];
      for (const tc of kids(tr).filter((c) => lname(c) === "tc").slice(0, 60)) {
        if (tc.attrs.hMerge === "1" || tc.attrs.vMerge === "1") { cells.push({ skip: 1 }); continue; }
        const tcPr = child(tc, "a:tcPr");
        const header = firstRow && ri === 0;
        let fill = tcPr ? fillIn(tcPr, ctx, part) : undefined;
        // 套了表格样式又没写单元格底色：照最常见的那款（标题行主题色、隔行浅色）画
        if (!fill && styled) {
          if (header) fill = { c: css(accent) };
          else if (band && (ri - (firstRow ? 1 : 0)) % 2 === 0) fill = { c: css({ ...accent, ...hslRgb({ ...rgbHsl(accent), l: 0.88 }) , a: 1 }) };
          else fill = { c: css({ ...accent, ...hslRgb({ ...rgbHsl(accent), l: 0.95 }), a: 1 }) };
        }
        const tx = textOfBody(child(tc, "a:txBody"), ctx, {
          masterStyle: null,
          fontColor: header && styled ? "#ffffff" : undefined,
          bodyAttrs: { lIns: tcPr && tcPr.attrs.marL || 91440, rIns: tcPr && tcPr.attrs.marR || 91440, tIns: tcPr && tcPr.attrs.marT || 45720, bIns: tcPr && tcPr.attrs.marB || 45720, anchor: tcPr && tcPr.attrs.anchor },
        });
        if (tx && header && styled) for (const p of tx.p) for (const r of p.runs) if (r.t && r.b == null) r.b = 1;
        const cell = { tx };
        if (fill && fill.c) cell.f = fill.c;
        if (num(tc.attrs.gridSpan) > 1) cell.cs = num(tc.attrs.gridSpan);
        if (num(tc.attrs.rowSpan) > 1) cell.rs = num(tc.attrs.rowSpan);
        const bd = {};
        for (const [tag, k] of [["a:lnL", "l"], ["a:lnR", "r"], ["a:lnT", "t"], ["a:lnB", "b"]]) {
          const ln = tcPr ? lineIn(child(tcPr, tag), ctx) : undefined;
          if (ln && !ln.none && ln.c && ln.w) bd[k] = [ln.w, ln.c];
        }
        if (Object.keys(bd).length) cell.bd = bd;
        cells.push(cell);
      }
      rows.push({ h: g(num(tr.attrs.h)), c: cells });
    });
    return { cols: grid.map((w) => r3(w / tw * 100)), rows, line: styled ? "#ffffff" : null };
  }

  // ---- 图表：只念缓存的数，前端画成简单的柱/线/饼 ----
  const CHART_T = { barChart: "bar", bar3DChart: "bar", lineChart: "line", line3DChart: "line", pieChart: "pie", pie3DChart: "pie", doughnutChart: "doughnut", areaChart: "area", area3DChart: "area", scatterChart: "scatter", radarChart: "radar" };
  function chartOf(part, ctx) {
    const root = xml(part);
    const plot = root ? findAll(root, "c:plotArea")[0] : null;
    if (!plot) return null;
    const typeEl = kids(plot).find((c) => CHART_T[lname(c)]);
    if (!typeEl) return { kind: "other" };
    const kind = CHART_T[lname(typeEl)];
    const titleEl = findAll(root, "c:title")[0];
    const title = titleEl ? findAll(titleEl, "a:t").map((t) => textOf(t)).join("").trim().slice(0, 200) : "";
    const barDir = child(typeEl, "c:barDir");
    const grouping = child(typeEl, "c:grouping");
    const points = (holder) => {
      const pts = [];
      for (const pt of holder ? findAll(holder, "c:pt") : []) {
        const v = child(pt, "c:v");
        pts[clamp(num(pt.attrs.idx), 0, 199)] = v ? textOf(v).trim().slice(0, 80) : "";
      }
      return pts;
    };
    const accents = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((a) => ctx.theme.colors[a]).filter(Boolean);
    const series = [];
    let cats = [];
    for (const ser of findAll(typeEl, "c:ser").slice(0, 12)) {
      const tx = child(ser, "c:tx");
      const name = tx ? (points(tx).filter(Boolean)[0] || findAll(tx, "c:v").map((v) => textOf(v)).join("")).slice(0, 80) : "";
      const c = points(child(ser, "c:cat") || child(ser, "c:xVal"));
      if (c.length > cats.length) cats = c;
      const v = points(child(ser, "c:val") || child(ser, "c:yVal")).slice(0, 200).map((x) => (x === "" || x == null ? null : num(x, null)));
      const sp = child(ser, "c:spPr");
      const f = sp ? fillIn(sp, ctx, part) : undefined;
      const ln = sp ? lineIn(child(sp, "a:ln"), ctx) : undefined;
      const s = { n: name, v };
      const col = (f && f.c) || (kind === "line" && ln && ln.c) || (accents.length ? css(accents[series.length % accents.length]) : null);
      if (col) s.c = col;
      if (kind === "pie" || kind === "doughnut") {
        const pc = [];
        for (const dp of findAll(ser, "c:dPt")) {
          const i = num(child(dp, "c:idx") && child(dp, "c:idx").attrs.val);
          const dsp = child(dp, "c:spPr");
          const df = dsp ? fillIn(dsp, ctx, part) : undefined;
          if (df && df.c && i < 200) pc[i] = df.c;
        }
        s.pc = Array.from({ length: v.length }, (_, i) => pc[i] || (accents.length ? css(accents[i % accents.length]) : "#888888"));
      }
      series.push(s);
    }
    return {
      kind, title, cats: cats.slice(0, 200).map((x) => (x == null ? "" : x)), series,
      dir: barDir && barDir.attrs.val === "bar" ? "h" : undefined,
      stack: grouping && /stacked/i.test(grouping.attrs.val || "") ? (/percent/i.test(grouping.attrs.val) ? "pct" : 1) : undefined,
    };
  }

  // ---- 背景 ----
  function bgOf(part, ctx) {
    const root = xml(part);
    const bg = root ? findAll(root, "p:bg")[0] : null;
    if (!bg) return undefined;
    const pr = child(bg, "p:bgPr");
    if (pr) { const f = fillIn(pr, ctx, part); return f && !f.none ? f : f; }
    const ref = child(bg, "p:bgRef");
    if (ref) {
      const col = colorIn(ref, ctx);
      const idx = num(ref.attrs.idx);
      const tpl = idx >= 1001 ? ctx.theme.bgFills[idx - 1001] : idx > 0 ? ctx.theme.fills[idx - 1] : null;
      const f = tpl ? fillIn({ children: [tpl] }, ctx, part, col) : undefined;
      if (f && !f.none) return f;
      return col ? { c: css(col) } : undefined;
    }
    return undefined;
  }

  // ---- 走一棵形状树 ----
  function walkTree(treeEl, ctx, part, els, opts) {
    const { tf = null, depth = 0, skipPh = false, grpFill = null } = opts || {};
    if (depth > DEPTH) return;
    for (const el of kids(treeEl)) {
      if (els.length >= ELS_PER_SLIDE) { ctx.cut = true; return; }
      const k = lname(el);
      if (k === "AlternateContent") {
        const pickFrom = child(el, "mc:Fallback") || child(el, "mc:Choice");
        if (pickFrom) walkTree(pickFrom, ctx, part, els, opts);
        continue;
      }
      if (!/^(sp|pic|graphicFrame|grpSp|cxnSp)$/.test(k)) continue;
      const nv = kids(el).find((c) => /^nv\w*Pr$/.test(lname(c)));
      const cNvPr = nv ? kids(nv).find((c) => lname(c) === "cNvPr") : null;
      if (cNvPr && (cNvPr.attrs.hidden === "1" || cNvPr.attrs.hidden === "true")) continue;
      const ph = phOf(el);
      if (ph && skipPh) continue; // 版式/母版上的占位符只是提示框，放映时看不见
      const chain = ph ? phChain(ph, ctx) : [];

      if (k === "grpSp") {
        const xf = xfrmOf(el);
        const b = xf ? boxOf(xf, tf) : null;
        const chOff = xf ? child(xf, "a:chOff") : null, chExt = xf ? child(xf, "a:chExt") : null;
        let ntf = tf;
        if (b && chOff && chExt) {
          const cw = num(chExt.attrs.cx), chh = num(chExt.attrs.cy);
          ntf = { ox: b.x, oy: b.y, cx: num(chOff.attrs.x), cy: num(chOff.attrs.y), sx: cw ? b.w / cw : 1, sy: chh ? b.h / chh : 1 };
        }
        const gf = fillIn(spPrOf(el), ctx, part);
        walkTree(el, ctx, part, els, { tf: ntf, depth: depth + 1, skipPh, grpFill: gf && !gf.grp ? gf : grpFill });
        continue;
      }

      // 位置：自己 → 版式 → 母版
      let xf = xfrmOf(el);
      if (!xf) for (const c of chain) { xf = xfrmOf(c); if (xf) break; }
      if (!xf) continue;
      const b = boxOf(xf, tf);
      if (!b) continue;
      const base = { x: g(b.x), y: g(b.y), w: g(b.w), h: g(b.h) };
      if (b.rot) base.rot = r1(b.rot);

      if (k === "graphicFrame") {
        const gd = findAll(el, "a:graphicData")[0];
        const uri = gd ? String(gd.attrs.uri || "") : "";
        if (/\/table$/.test(uri)) {
          const tbl = findAll(gd, "a:tbl")[0];
          if (tbl) els.push({ k: "tbl", ...base, tbl: tableOf(tbl, ctx, part, b) });
        } else if (/\/chart$/.test(uri)) {
          const cref = findAll(gd, "c:chart")[0];
          const rel = cref ? relsOf(part).get(cref.attrs["r:id"]) : null;
          const ch = rel && rel.part ? chartOf(rel.part, ctx) : null;
          els.push({ k: "chart", ...base, chart: ch || { kind: "other" } });
        } else if (/\/diagram$/.test(uri)) {
          // SmartArt：文件里存着 PowerPoint 画好的一份形状（drawingN.xml），坐标相对这个框
          const dm = findAll(gd, "dgm:relIds")[0];
          const dataRel = dm ? relsOf(part).get(dm.attrs["r:dm"]) : null;
          const dataRoot = dataRel && dataRel.part ? xml(dataRel.part) : null;
          const ext = dataRoot ? findAll(dataRoot, "dsp:dataModelExt")[0] : null;
          const drawRel = ext ? relsOf(part).get(ext.attrs.relId) : null;
          const draw = drawRel && drawRel.part ? xml(drawRel.part) : null;
          const tree = draw ? findAll(draw, "dsp:spTree")[0] : null;
          if (tree) walkTree(tree, ctx, drawRel.part, els, { tf: { ox: b.x, oy: b.y, cx: 0, cy: 0, sx: 1, sy: 1 }, depth: depth + 1, skipPh: true });
        } else {
          // OLE 对象之类：里面一般带一张预览图
          const pic = findAll(el, "p:pic")[0];
          if (pic) {
            const blip = findAll(pic, "a:blip")[0];
            if (blip) els.push({ k: "pic", ...base, img: imageOf(part, blip.attrs["r:embed"] || "") });
          }
        }
        continue;
      }

      const spPr = spPrOf(el);
      const chainPr = chain.map(spPrOf);
      const geom = geomOf(spPr && (child(spPr, "a:prstGeom") || child(spPr, "a:custGeom")) ? spPr : chainPr.find((p) => p && (child(p, "a:prstGeom") || child(p, "a:custGeom"))) || spPr, b);
      const style = styleRefs(kids(el).find((c) => lname(c) === "style"), ctx);

      let fill;
      for (const p of [spPr, ...chainPr]) { if (!p) continue; fill = fillIn(p, ctx, part); if (fill !== undefined) break; }
      if (fill && fill.grp) fill = grpFill || undefined;
      if (fill === undefined) fill = style.fill;
      let line;
      for (const p of [spPr, ...chainPr]) { if (!p) continue; line = lineIn(child(p, "a:ln"), ctx); if (line !== undefined) break; }
      if (line && !line.none && !line.c && style.line) line = { ...style.line, ...line, c: style.line.c };
      if (line === undefined) line = style.line;
      if (line && !line.none && !line.w) line.w = g(9525);
      if (line && !line.none && !line.c) line = undefined;

      // 宽或高为 0 的自定义形状就是一条线（导出工具常这么画分隔线）：框是扁的，按形状画就看不见了
      const flat = geom.t === "path" && (b.w === 0 || b.h === 0);
      if (geom.line || k === "cxnSp" || flat) {
        if (!line || line.none) continue;
        let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        if (b.fh) [x1, x2] = [x2, x1];
        if (b.fv) [y1, y2] = [y2, y1];
        if (b.rot) {
          const cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = b.rot * Math.PI / 180;
          const rt = (x, y) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)];
          [x1, y1] = rt(x1, y1); [x2, y2] = rt(x2, y2);
        }
        els.push({ k: "ln", p: [g(x1), g(y1), g(x2), g(y2)], ln: line });
        continue;
      }

      const out = { k: k === "pic" ? "pic" : "sp", ...base };
      if (b.fh) out.fh = 1;
      if (b.fv) out.fv = 1;
      if (geom.t !== "rect") out.geo = geom;
      if (fill && !fill.none) out.fill = fill;
      if (line && !line.none) out.ln = line;

      if (k === "pic") {
        const bf = kids(el).find((c) => lname(c) === "blipFill");
        const blip = bf ? child(bf, "a:blip") : null;
        if (blip) out.img = imageOf(part, blip.attrs["r:embed"] || blip.attrs["r:link"] || "");
        const sr = bf ? child(bf, "a:srcRect") : null;
        if (sr) {
          const c = ["l", "t", "r", "b"].map((s) => num(sr.attrs[s]) / 1000);
          if (c.some((v) => v)) out.crop = c.map(r1);
        }
        if (!out.img) continue;
      }

      // 文字：版式/母版占位符给的 bodyPr、lstStyle 都要带上
      const txBody = kids(el).find((c) => lname(c) === "txBody");
      if (txBody) {
        const chainBody = chain.map((c) => kids(c).find((x) => lname(x) === "txBody")).filter(Boolean);
        const bodyAttrs = {};
        let inheritedFit = null;
        for (const cb of chainBody.slice().reverse()) {
          const bp = child(cb, "a:bodyPr");
          if (bp) { Object.assign(bodyAttrs, bp.attrs); const nf = child(bp, "a:normAutofit"); if (nf) inheritedFit = nf; }
        }
        const kind = ph ? phKind(ph.type) : "";
        // 不是占位符的文本框只认演示文稿的默认样式；页脚、页码这类占位符才用母版的「其他」样式
        const masterStyle = kind === "title" ? ctx.titleStyle : kind === "body" ? ctx.bodyStyle : ph ? ctx.otherStyle : null;
        const tx = textOfBody(txBody, ctx, {
          masterStyle,
          inheritLst: chainBody.slice().reverse().map((cb) => child(cb, "a:lstStyle")).filter(Boolean),
          bodyAttrs, inheritedFit,
          fontColor: style.font,
        });
        if (tx) {
          // SmartArt 的形状另带一个文字框位置
          const txXfrm = kids(el).find((c) => lname(c) === "txXfrm");
          const tb = txXfrm ? boxOf(txXfrm, tf) : null;
          if (tb) tx.box = [r1((tb.x - b.x) * K), r1((tb.y - b.y) * K), r1(tb.w * K), r1(tb.h * K)];
          out.tx = tx;
        }
      }
      if (!out.tx && !out.fill && !out.ln && !out.img) continue;
      els.push(out);
    }
  }

  /** 一页 → { w, h, bg, els } */
  function slide(slidePart) {
    const layoutPart = relOfType(slidePart, "slideLayout");
    const masterPart = layoutPart ? relOfType(layoutPart, "slideMaster") : "";
    const master = xml(masterPart);
    const theme = themeOf(masterPart);
    const clrMap = {};
    const cm = master ? findAll(master, "p:clrMap")[0] : null;
    if (cm) Object.assign(clrMap, cm.attrs);
    for (const p of [layoutPart, slidePart]) {
      const r = xml(p);
      const ov = r ? findAll(r, "a:overrideClrMapping")[0] : null;
      if (ov) Object.assign(clrMap, ov.attrs);
    }
    if (!Object.keys(clrMap).length) Object.assign(clrMap, { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" });
    const tx = master ? findAll(master, "p:txStyles")[0] : null;
    const ctx = {
      theme, clrMap, layoutPart, masterPart,
      titleStyle: tx ? child(tx, "p:titleStyle") : null,
      bodyStyle: tx ? child(tx, "p:bodyStyle") : null,
      otherStyle: tx ? child(tx, "p:otherStyle") : null,
      cut: false,
    };
    const els = [];
    const sroot = xml(slidePart), lroot = xml(layoutPart);
    const showMaster = (r) => { const x = r ? kids(r)[0] : null; return !(x && x.attrs.showMasterSp === "0"); };
    // 母版、版式上的装饰（logo、色条、底纹）画在最底下；占位符跳过
    if (master && showMaster(lroot) && showMaster(sroot)) {
      const t = findAll(master, "p:spTree")[0];
      if (t) walkTree(t, ctx, masterPart, els, { skipPh: true });
    }
    if (lroot && showMaster(sroot)) {
      const t = findAll(lroot, "p:spTree")[0];
      if (t) walkTree(t, ctx, layoutPart, els, { skipPh: true });
    }
    const st = sroot ? findAll(sroot, "p:spTree")[0] : null;
    if (st) walkTree(st, ctx, slidePart, els, {});
    let bg = bgOf(slidePart, ctx);
    if (bg === undefined) bg = bgOf(layoutPart, ctx);
    if (bg === undefined) bg = bgOf(masterPart, ctx);
    const out = { els };
    if (bg && !bg.none) out.bg = bg;
    if (ctx.cut) out.cut = 1;
    return out;
  }

  return { size: { w: U, h: HU }, media, slide };
}

function autoNum(type, n) {
  const roman = (v, up) => {
    const t = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let s = "";
    for (const [k, r] of t) while (v >= k) { s += r; v -= k; }
    return up ? s.toUpperCase() : s;
  };
  const alpha = (v, up) => { let s = ""; while (v > 0) { v--; s = String.fromCharCode(97 + (v % 26)) + s; v = Math.floor(v / 26); } return up ? s.toUpperCase() : s; };
  const CN = "零一二三四五六七八九十";
  const cn = (v) => (v <= 10 ? CN[v] : v < 20 ? "十" + (v % 10 ? CN[v % 10] : "") : v < 100 ? CN[Math.floor(v / 10)] + "十" + (v % 10 ? CN[v % 10] : "") : String(v));
  const circled = (v) => (v >= 1 && v <= 20 ? String.fromCharCode(0x2460 + v - 1) : String(v));
  const m = /^(arabic|romanUc|romanLc|alphaUc|alphaLc|ea1Chs|ea1ChtPeriod|circleNumDb|circleNumWd)(.*)$/.exec(type) || [];
  const core = m[1] === "romanUc" ? roman(n, true) : m[1] === "romanLc" ? roman(n, false) : m[1] === "alphaUc" ? alpha(n, true)
    : m[1] === "alphaLc" ? alpha(n, false) : m[1] === "ea1Chs" || m[1] === "ea1ChtPeriod" ? cn(n) : /^circleNum/.test(m[1] || "") ? circled(n) : String(n);
  const tail = m[2] || "Period";
  if (/^circleNum/.test(m[1] || "")) return core;
  if (tail === "ParenBoth") return `(${core})`;
  if (tail === "ParenR") return core + ")";
  if (tail === "Plain") return core;
  if (tail === "Period" && /^ea1/.test(m[1] || "")) return core + "、";
  return core + ".";
}

module.exports = { createLayoutReader, autoNum, evalGuide, guideEnv, css, U };
