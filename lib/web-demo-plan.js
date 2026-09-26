// @ts-check
"use strict";
/**
 * record_web_demo 的纯函数层：步骤脚本校验、画幅预设、打码清单、打字/鼠标节奏、自动放大、
 * ffmpeg 滤镜串、要注入页面的几段脚本、泄漏扫描、steps.json。
 * 这里没有任何 I/O：录制器（lib/web-demo-recorder.js）只管开浏览器、收帧、调 ffmpeg，
 * 能算的都在这儿算好，单测不用起 Chrome 也能把规矩钉死。
 */
const { defaultPairs } = require("./demo-mask");

/** @typedef {{ w: number, h: number }} Size */
/** @typedef {{ css: Size, dsf: number, mobile: boolean, out: Size }} Aspect */
/** @typedef {[string, string][]} Pairs */
/** @typedef {{ selector?: string, text?: string, nth?: number }} Target */
/**
 * @typedef {{
 *   i: number, op: string, label: string, shot: boolean,
 *   url?: string, path?: string, target?: Target | null, text?: string, enter?: boolean, key?: string,
 *   by?: number, to?: "top" | "bottom" | number, ms?: number, timeout_ms?: number, scale?: number,
 *   rect?: number[], hold?: boolean, zoom?: boolean
 * }} Step
 */
/** @typedef {{ t: number, z: number, cx: number, cy: number }} Pose */

// ---------------------------------------------------------------- 画幅

/**
 * 输出像素 = CSS 视口 × 设备像素比，正好落在常见成片尺寸上，而且全是偶数（yuv420p 要求）。
 * 竖屏按手机来：窄视口 + 触屏 + iPhone UA，页面走它自己的移动端布局，而不是把桌面版硬缩窄。
 * @type {Record<string, Aspect>}
 */
const ASPECTS = {
  "16:9": { css: { w: 1280, h: 720 }, dsf: 1.5, mobile: false, out: { w: 1920, h: 1080 } },
  "9:16": { css: { w: 360, h: 640 }, dsf: 3, mobile: true, out: { w: 1080, h: 1920 } },
  "1:1": { css: { w: 720, h: 720 }, dsf: 1.5, mobile: false, out: { w: 1080, h: 1080 } },
  "4:3": { css: { w: 960, h: 720 }, dsf: 1.5, mobile: false, out: { w: 1440, h: 1080 } },
  "3:4": { css: { w: 540, h: 720 }, dsf: 2, mobile: false, out: { w: 1080, h: 1440 } },
};

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/**
 * @param {string} [aspect]
 * @returns {{ aspect: string, css: Size, dsf: number, mobile: boolean, ua: string, out: Size }}
 */
function aspectPreset(aspect = "16:9") {
  const raw = aspect == null || aspect === "" ? "16:9" : String(aspect);
  // 模型和人都爱写「9：16」「9x16」「9×16」，认成同一个，别为个冒号报错
  const key = raw.trim().replace(/\s+/g, "").replace(/[：xX×*/]/g, ":");
  const p = ASPECTS[key];
  if (!p) throw new Error(`不认识的画幅「${raw.slice(0, 20)}」：可选 ${Object.keys(ASPECTS).join(" / ")}`);
  return { aspect: key, css: { ...p.css }, dsf: p.dsf, mobile: p.mobile, ua: p.mobile ? IPHONE_UA : "", out: { ...p.out } };
}

// ---------------------------------------------------------------- 步骤脚本

const OPS = ["goto", "click", "type", "press", "scroll", "hover", "wait", "zoom", "caption"];
const COMMON = ["label", "shot"];
const LIMITS = Object.freeze({
  steps: 60,
  text: 500, // type 一次最多打多少字（按字算，emoji 算一个）
  caption: 80, // 字幕按显示宽度算：汉字 2、字母 1，80 = 40 个汉字
  waitMs: 15000,
  selectorWaitMs: 20000,
  label: 40,
  selector: 300,
  maxScale: 2.5,
});

/**
 * 按键表：CDP Input.dispatchKeyEvent 要 key / code / windowsVirtualKeyCode 三样都对，
 * 少一样有的页面就收不到（比如只认 keyCode 的老代码）。
 * @type {Record<string, { key: string, code: string, keyCode: number, text?: string }>}
 */
const KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};
/** @type {Record<string, string>} */
const KEY_ALIAS = { esc: "Escape", return: "Enter", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", " ": "Space", del: "Delete" };

/**
 * @param {any} name
 * @returns {string | null} 规范键名（KEYS 的键），不认识给 null
 */
function keyName(name) {
  if (typeof name !== "string") return null;
  const s = name.trim();
  if (!s && name !== " ") return null;
  const low = (s || " ").toLowerCase();
  if (KEY_ALIAS[low]) return KEY_ALIAS[low];
  for (const k of Object.keys(KEYS)) if (k.toLowerCase() === low) return k;
  return null;
}

/**
 * 显示宽度：汉字、全角标点、emoji 算 2，其它算 1。字幕上限按这个量，免得 40 个英文字母被当成 40 个汉字拦下。
 * @param {string} s
 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s || "")) {
    const c = ch.codePointAt(0) || 0;
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

// 控制字符混进文字里，打出去是乱码，写进文件名更麻烦；换行和制表符留着（textarea 里要用）
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** @param {number} n @param {string} op @param {string} msg */
const stepErr = (n, op, msg) => new Error(`第 ${n} 步（${op}）：${msg}`);

/** @param {any} v */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * goto 的网址只放 http/https；工作区里的 .html 走 path。
 * javascript:/data:/file: 这些要么能在页面里执行任意脚本，要么能读本机文件，一律拒。
 * @param {string} s @param {number} n
 * @returns {{ url?: string, path?: string }}
 */
function gotoTarget(s, n) {
  const v = s.trim();
  if (!v) throw stepErr(n, "goto", "网址是空的");
  if (CTRL.test(v) || /\s/.test(v)) throw stepErr(n, "goto", "网址里有空格或控制字符，先编码好再给");
  if (v.length > 2000) throw stepErr(n, "goto", "网址太长了（最多 2000 个字符）");
  // 「//cdn.xx/…」是省了协议的网址，不是本机路径，得排在绝对路径那条前面判
  if (/^\/\//.test(v)) throw stepErr(n, "goto", "网址要写全，带上 http:// 或 https://");
  if (/^[a-zA-Z]:[\\/]/.test(v) || v.startsWith("/") || v.startsWith("\\") || v.startsWith("~")) {
    throw stepErr(n, "goto", "本机文件写工作区里的相对路径，比如 {\"goto\":{\"path\":\"site/index.html\"}}");
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(v);
  if (scheme && /^\d/.test(v.slice(scheme[0].length))) {
    throw stepErr(n, "goto", `网址要写全，比如 http://${v.slice(0, 40)}`);
  }
  if (scheme) {
    const sch = scheme[1].toLowerCase();
    if (sch !== "http" && sch !== "https") throw stepErr(n, "goto", `只能打开 http/https 网址或工作区里的 .html，「${sch}:」这种不行`);
    let u;
    try { u = new URL(v); } catch { throw stepErr(n, "goto", "网址格式不对，打不开"); }
    if (u.username || u.password) throw stepErr(n, "goto", "网址里带着账号密码，录出来会露馅，去掉再录");
    if (!u.hostname) throw stepErr(n, "goto", "网址里没有主机名");
    return { url: u.href };
  }
  return { path: workspaceHtml(v, n) };
}

/** @param {string} p @param {number} n */
function workspaceHtml(p, n) {
  const v = p.trim().replace(/\\/g, "/");
  if (!v) throw stepErr(n, "goto", "path 是空的");
  if (CTRL.test(v)) throw stepErr(n, "goto", "path 里有控制字符");
  if (v.startsWith("/") || /^[a-zA-Z]:/.test(v) || v.startsWith("~")) throw stepErr(n, "goto", "path 写工作区里的相对路径，比如 site/index.html");
  const bare = v.split(/[?#]/)[0];
  if (bare.split("/").some((seg) => seg === "..")) throw stepErr(n, "goto", "path 不能用 .. 跳出工作区");
  if (!/\.html?$/i.test(bare)) {
    throw stepErr(n, "goto", /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(bare)
      ? `网址要写全，比如 https://${bare.slice(0, 40)}`
      : "path 只能是 .html 文件；网址要带 http:// 或 https://");
  }
  return v;
}

/**
 * click / hover / zoom / wait 共用的「找哪个元素」。
 * @param {any} v @param {number} n @param {string} op
 * @param {{ requireTarget?: boolean }} [o]
 * @returns {Target | null}
 */
function parseTargetSpec(v, n, op, o = {}) {
  /** @type {Target} */
  const t = {};
  if (v.selector != null) {
    if (typeof v.selector !== "string" || !v.selector.trim()) throw stepErr(n, op, "selector 要是非空字符串");
    if (v.selector.length > LIMITS.selector) throw stepErr(n, op, `selector 太长了（最多 ${LIMITS.selector} 个字符）`);
    t.selector = v.selector.trim();
  }
  if (v.text != null) {
    if (typeof v.text !== "string" || !v.text.trim()) throw stepErr(n, op, "text 要是非空字符串（按页面上看得见的字找元素）");
    if (Array.from(v.text).length > 200) throw stepErr(n, op, "按字找元素时 text 最多 200 个字");
    t.text = v.text.replace(/\s+/g, " ").trim();
  }
  if (v.nth != null) {
    if (!Number.isInteger(v.nth) || v.nth < 1 || v.nth > 1000) throw stepErr(n, op, "nth 从 1 数起，是第几个匹配的元素");
    t.nth = v.nth;
  }
  if (!t.selector && !t.text) {
    if (o.requireTarget === false) return null;
    throw stepErr(n, op, "要给 selector 或 text，告诉我是页面上哪个元素");
  }
  return t;
}

/**
 * @param {any} v @param {number} n @param {string} op
 * @returns {{ zoom: boolean, scale?: number }}
 */
function parseZoomFlag(v, n, op) {
  if (v === undefined || v === true) return { zoom: true };
  if (v === false) return { zoom: false };
  if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= LIMITS.maxScale) return { zoom: true, scale: v };
  throw stepErr(n, op, `zoom 写 false 关掉自动放大，或者写 1~${LIMITS.maxScale} 之间的倍数`);
}

/**
 * @param {any} v @param {Record<string, boolean>} allowed @param {number} n @param {string} op
 */
function onlyKeys(v, allowed, n, op) {
  for (const k of Object.keys(v)) if (!allowed[k]) throw stepErr(n, op, `不认识「${k.slice(0, 20)}」，能写的是 ${Object.keys(allowed).join(" / ")}`);
}

/** @param {any} ms @param {number} n @param {string} op @param {number} dflt @param {number} max @param {string} [name] */
function msField(ms, n, op, dflt, max, name = "ms") {
  if (ms == null) return dflt;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw stepErr(n, op, `${name} 要是毫秒数`);
  if (ms > max) throw stepErr(n, op, `${name} 最多 ${max} 毫秒（${max / 1000} 秒）`);
  return Math.round(ms);
}

/**
 * 校验并规整步骤脚本。每步只准有一个动作键，外加可选的 label / shot。
 * 出错一律「第 N 步（动作）：原因」，模型拿到就知道改哪一步。
 * shot 默认 true（这一步做完截一张图），caption 默认 false：字幕是后期叠上去的，页面截图里本来就没有。
 * @param {any} raw
 * @param {{ maxSteps?: number }} [o]
 * @returns {Step[]}
 */
function parseSteps(raw, o = {}) {
  const max = o.maxSteps || LIMITS.steps;
  if (!Array.isArray(raw)) throw new Error("steps 要是数组，每一项是一步，比如 [{\"goto\":\"http://127.0.0.1:3000/\"},{\"click\":\"#start\"}]");
  if (!raw.length) throw new Error("steps 是空的：至少要有一步 goto 打开页面");
  if (raw.length > max) throw new Error(`第 ${max + 1} 步：一次最多 ${max} 步，这次给了 ${raw.length} 步，拆成几段录`);
  /** @type {Step[]} */
  const out = [];
  raw.forEach((s, idx) => {
    const n = idx + 1;
    if (!isObj(s)) throw new Error(`第 ${n} 步：每一步要是一个对象，比如 {"click":"#login"}`);
    const keys = Object.keys(s);
    const ops = keys.filter((k) => OPS.includes(k));
    if (ops.length === 0) {
      const k = keys.find((x) => !COMMON.includes(x));
      throw new Error(`第 ${n} 步（${k ? k.slice(0, 20) : "?"}）：${k ? "不认识这个动作" : "没写要做什么"}，能用的有 ${OPS.join(" / ")}`);
    }
    if (ops.length > 1) throw stepErr(n, ops.join("+"), `一步只做一件事，拆成 ${ops.length} 步`);
    const op = ops[0];
    for (const k of keys) {
      if (k === op || COMMON.includes(k)) continue;
      throw stepErr(n, op, `「${k.slice(0, 20)}」要写进 ${op} 里面，比如 {"${op}":{"${k.slice(0, 20)}":…}}`);
    }
    if (idx === 0 && op !== "goto") throw stepErr(n, op, "第一步得是 goto，先打开要录的页面");
    let label = "";
    if (s.label != null) {
      if (typeof s.label !== "string") throw stepErr(n, op, "label 要是字符串");
      label = s.label.replace(/\s+/g, " ").trim();
      if (CTRL.test(label)) throw stepErr(n, op, "label 里有控制字符");
      if (Array.from(label).length > LIMITS.label) throw stepErr(n, op, `label 最多 ${LIMITS.label} 个字`);
    }
    if (s.shot != null && typeof s.shot !== "boolean") throw stepErr(n, op, "shot 只能是 true 或 false");
    const shot = typeof s.shot === "boolean" ? s.shot : op !== "caption";
    /** @type {Step} */
    const st = { i: n, op, label, shot };
    parseOp(st, s[op], n, op);
    out.push(st);
  });
  return out;
}

/**
 * @param {Step} st @param {any} v @param {number} n @param {string} op
 */
function parseOp(st, v, n, op) {
  switch (op) {
    case "goto": {
      if (typeof v === "string") Object.assign(st, gotoTarget(v, n));
      else if (isObj(v)) {
        onlyKeys(v, { url: true, path: true }, n, op);
        if ((v.url != null) === (v.path != null)) throw stepErr(n, op, "url 和 path 二选一");
        if (v.url != null) {
          if (typeof v.url !== "string") throw stepErr(n, op, "url 要是字符串");
          const r = gotoTarget(v.url, n);
          if (!r.url) throw stepErr(n, op, "url 要带 http:// 或 https://；工作区文件用 path");
          st.url = r.url;
        } else {
          if (typeof v.path !== "string") throw stepErr(n, op, "path 要是字符串");
          st.path = workspaceHtml(v.path, n);
        }
      } else throw stepErr(n, op, "写网址字符串，或 {url} / {path}");
      return;
    }
    case "click":
    case "hover": {
      if (typeof v === "string") {
        if (!v.trim()) throw stepErr(n, op, "selector 是空的");
        v = { selector: v };
      }
      if (!isObj(v)) throw stepErr(n, op, "写 CSS 选择器字符串，或 {selector, text, nth}");
      onlyKeys(v, op === "hover" ? { selector: true, text: true, nth: true, zoom: true, ms: true } : { selector: true, text: true, nth: true, zoom: true }, n, op);
      st.target = parseTargetSpec(v, n, op);
      Object.assign(st, parseZoomFlag(v.zoom, n, op));
      if (op === "hover") st.ms = msField(v.ms, n, op, 800, LIMITS.waitMs);
      return;
    }
    case "type": {
      if (typeof v === "string") v = { text: v };
      if (!isObj(v)) throw stepErr(n, op, "写要打的字，或 {selector, text, enter}");
      onlyKeys(v, { selector: true, nth: true, text: true, enter: true, zoom: true }, n, op);
      if (typeof v.text !== "string") throw stepErr(n, op, "text 要是字符串（要打的字）");
      if (!v.text && !v.enter) throw stepErr(n, op, "text 是空的；只想回车用 press");
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.text)) throw stepErr(n, op, "text 里有控制字符，按键用 press");
      const len = Array.from(v.text).length;
      if (len > LIMITS.text) throw stepErr(n, op, `text 最多 ${LIMITS.text} 个字，这次 ${len} 个`);
      if (v.enter != null && typeof v.enter !== "boolean") throw stepErr(n, op, "enter 只能是 true 或 false");
      st.target = v.selector != null || v.nth != null ? parseTargetSpec({ selector: v.selector, nth: v.nth }, n, op) : null;
      st.text = v.text;
      st.enter = !!v.enter;
      Object.assign(st, parseZoomFlag(v.zoom, n, op));
      return;
    }
    case "press": {
      const k = keyName(isObj(v) ? v.key : v);
      if (isObj(v)) onlyKeys(v, { key: true }, n, op);
      if (!k) throw stepErr(n, op, `不认识这个键，能按的有 ${Object.keys(KEYS).join(" / ")}`);
      st.key = k;
      return;
    }
    case "scroll": {
      if (typeof v === "number") v = { by: v };
      else if (v === "top" || v === "bottom") v = { to: v };
      if (!isObj(v)) throw stepErr(n, op, "写 {by: 像素} 往下滚多少，或 {to: \"top\" | \"bottom\" | 像素}");
      onlyKeys(v, { by: true, to: true, ms: true }, n, op);
      if ((v.by != null) === (v.to != null)) throw stepErr(n, op, "by 和 to 二选一");
      if (v.by != null) {
        if (typeof v.by !== "number" || !Number.isFinite(v.by) || v.by === 0 || Math.abs(v.by) > 20000) throw stepErr(n, op, "by 是非零像素数，正数往下、负数往上，最多 20000");
        st.by = Math.round(v.by);
      } else {
        if (v.to !== "top" && v.to !== "bottom" && !(typeof v.to === "number" && Number.isFinite(v.to) && v.to >= 0)) throw stepErr(n, op, "to 写 \"top\"、\"bottom\" 或离顶部的像素数");
        st.to = typeof v.to === "number" ? Math.round(v.to) : v.to;
      }
      st.ms = msField(v.ms, n, op, 700, 5000);
      return;
    }
    case "wait": {
      if (typeof v === "string" && /^\d+$/.test(v.trim())) v = Number(v.trim());
      if (typeof v === "number") v = { ms: v };
      else if (typeof v === "string") v = { selector: v };
      if (!isObj(v)) throw stepErr(n, op, "写毫秒数，或 {selector | text, timeout_ms} 等某个元素出现");
      onlyKeys(v, { ms: true, selector: true, text: true, timeout_ms: true }, n, op);
      const byTarget = v.selector != null || v.text != null;
      if (byTarget && v.ms != null) throw stepErr(n, op, "ms 和 selector/text 二选一");
      if (byTarget) {
        st.target = parseTargetSpec(v, n, op);
        st.timeout_ms = msField(v.timeout_ms, n, op, 10000, LIMITS.selectorWaitMs, "timeout_ms");
      } else {
        if (v.timeout_ms != null) throw stepErr(n, op, "timeout_ms 要配 selector 或 text 用");
        if (v.ms == null) throw stepErr(n, op, "要等多久（ms）？");
        const ms = msField(v.ms, n, op, 0, LIMITS.waitMs);
        if (ms <= 0) throw stepErr(n, op, "ms 要大于 0");
        st.ms = ms;
      }
      return;
    }
    case "zoom": {
      if (typeof v === "string") v = { selector: v };
      if (!isObj(v)) throw stepErr(n, op, "写 {selector | text | rect:[x,y,w,h], scale, ms}");
      onlyKeys(v, { selector: true, text: true, nth: true, rect: true, scale: true, ms: true }, n, op);
      if (v.rect != null) {
        if (v.selector != null || v.text != null) throw stepErr(n, op, "rect 和 selector/text 二选一");
        const r = v.rect;
        if (!Array.isArray(r) || r.length !== 4 || !r.every((x) => typeof x === "number" && Number.isFinite(x)) || r[2] <= 0 || r[3] <= 0) {
          throw stepErr(n, op, "rect 是 [x, y, 宽, 高]，单位是页面 CSS 像素");
        }
        st.rect = r.map((x) => Math.round(x));
        st.target = null;
      } else st.target = parseTargetSpec(v, n, op);
      if (v.scale != null) {
        if (typeof v.scale !== "number" || !Number.isFinite(v.scale) || v.scale < 1 || v.scale > LIMITS.maxScale) throw stepErr(n, op, `scale 在 1~${LIMITS.maxScale} 之间`);
        st.scale = v.scale;
      }
      st.ms = msField(v.ms, n, op, 1500, LIMITS.waitMs);
      return;
    }
    case "caption": {
      if (typeof v === "string") v = { text: v };
      if (!isObj(v)) throw stepErr(n, op, "写字幕文字，或 {text, ms, hold}");
      onlyKeys(v, { text: true, ms: true, hold: true }, n, op);
      if (typeof v.text !== "string" || !v.text.trim()) throw stepErr(n, op, "字幕是空的");
      if (CTRL.test(v.text)) throw stepErr(n, op, "字幕里有控制字符");
      const text = v.text.replace(/\s+/g, " ").trim();
      const w = dispWidth(text);
      if (w > LIMITS.caption) throw stepErr(n, op, `字幕最多 ${LIMITS.caption / 2} 个汉字宽，这条约 ${Math.ceil(w / 2)} 个，拆成两条`);
      if (v.hold != null && typeof v.hold !== "boolean") throw stepErr(n, op, "hold 只能是 true 或 false");
      st.text = text;
      st.ms = msField(v.ms, n, op, 2500, LIMITS.waitMs);
      if (st.ms < 300) throw stepErr(n, op, "字幕至少挂 300 毫秒，不然看不清");
      // hold：默认停在这儿等字幕挂完再做下一步，观众来得及读；false 就是字幕挂着、下一步马上接着做
      st.hold = v.hold !== false;
      return;
    }
    default:
      throw stepErr(n, op, "不认识这个动作");
  }
}

// ---------------------------------------------------------------- 输出目录

/** @param {Date} d */
function stamp(d) {
  const p = (/** @type {number} */ x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 工作区里的相对输出目录。绝对路径、..、盘符一律拒：录屏只往工作区里写。
 * @param {any} input
 * @param {{ now?: Date | number }} [o]
 * @returns {string}
 */
function outDirRel(input, o = {}) {
  const now = o.now instanceof Date ? o.now : new Date(o.now || Date.now());
  const dflt = `web-demo-${stamp(now)}`;
  if (input == null || (typeof input === "string" && !input.trim())) return dflt;
  if (typeof input !== "string") throw new Error("out_dir 要是字符串，比如 demo/首页");
  const s = input.trim().replace(/\\/g, "/");
  if (CTRL.test(s) || /[\n\r\t]/.test(s)) throw new Error("out_dir 里有控制字符");
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s) || s.startsWith("~")) throw new Error("out_dir 写工作区里的相对路径，比如 demo/首页，不能是绝对路径");
  const parts = s.split("/").filter((x) => x && x !== ".");
  if (parts.some((x) => x === "..")) throw new Error("out_dir 不能用 .. 跳出工作区");
  if (parts.some((x) => /[<>:"|?*]/.test(x))) throw new Error("out_dir 里有文件名不能用的字符（< > : \" | ? *）");
  if (s.length > 200) throw new Error("out_dir 太长了（最多 200 个字符）");
  return parts.length ? parts.join("/") : dflt;
}

/**
 * 每步截图的文件名：steps/NN-<op>[-label].png。label 先过一遍打码，再去掉文件名不能用的字符，
 * 免得「打开 /Users/某某/项目」这种 label 把本机路径写进文件名。
 * @param {{ i: number, op: string, label?: string }} step
 * @param {Pairs} [pairs]
 */
function shotName(step, pairs = []) {
  const nn = String(step.i).padStart(2, "0");
  const lab = Array.from(fixString(step.label || "", pairs).replace(/[\\/:*?"<>|\s\u0000-\u001f]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 24).join("").replace(/-+$/, "");
  return `${nn}-${step.op}${lab ? "-" + lab : ""}.png`;
}

// ---------------------------------------------------------------- 打码清单

/** @type {Record<string, string>} */
const BASE_LABEL = { "~": "home 目录", "demo-machine": "主机名", "user": "用户名", "~/OpenWorkBuddy-demo": "演示数据目录", "●●●●●●": "指定遮挡项" };
const DOTS = "●●●●●●";

/**
 * 录屏要遮的清单 + 平行的中文标签。标签是给人看的「遮了哪几类」，报泄漏时也只报标签，不回显原文。
 * - 本机那几样（home、主机名、用户名）来自 defaultPairs；
 * - tmpDirs（录制用的临时目录）→ /tmp/demo，macOS 上 /var 和 /private/var 是同一处，两种写法都遮；
 * - extra 是用户点名要遮的（账号名、邮箱、公司名）：≥2 个字就收，1 个字进 rejected——
 *   单字替换会把页面上所有这个字都换成圆点，得让用户写全，而不是悄悄跳过（defaultPairs 对 <6 字是悄悄丢的）。
 * 替换结果里又含着原文的（比如主机名就叫 user）会让观察者越换越长，这类本机项直接不遮：它本来就是个大路货名字。
 * @param {{ extra?: any[], tmpDirs?: string[], base?: Pairs }} [o]
 * @returns {{ pairs: Pairs, labels: string[], rejected: string[] }}
 */
function maskPairs(o = {}) {
  const base = o.base || defaultPairs(null, []);
  /** @type {{ a: string, b: string, label: string, user: boolean }[]} */
  const list = [];
  /** @type {string[]} */
  const rejected = [];
  for (const [a, b] of base) if (typeof a === "string" && a) list.push({ a, b, label: BASE_LABEL[b] || "本机信息", user: false });
  for (const d of o.tmpDirs || []) {
    if (typeof d !== "string" || d.length < 5) continue;
    const vs = [d];
    if (d.startsWith("/private/")) vs.push(d.slice("/private".length));
    else if (d.startsWith("/var/") || d.startsWith("/tmp/")) vs.push("/private" + d);
    for (const a of vs) list.push({ a, b: "/tmp/demo", label: "临时目录", user: false });
  }
  (o.extra || []).forEach((v, k) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (Array.from(s).length < 2 || DOTS.includes(s) || CTRL.test(s)) { rejected.push(typeof v === "string" ? v : String(v)); return; }
    list.push({ a: s, b: DOTS, label: `你列的第 ${k + 1} 项`, user: true });
  });
  const seen = new Set();
  const uniq = list.filter((p) => (seen.has(p.a) ? false : (seen.add(p.a), true)));
  const bs = [...new Set(uniq.map((p) => p.b))];
  // 本机项的原文出现在任何一个替换结果里（主机名叫 demo、用户名叫 user）：
  // 换完又能匹配上，观察者会一圈圈越换越长，泄漏扫描也会把替换结果当成泄漏
  const kept = uniq.filter((p) => !p.b.includes(p.a) && (p.user || !bs.some((b) => b.includes(p.a))));
  kept.sort((x, y) => y.a.length - x.a.length);
  return { pairs: kept.map((p) => [p.a, p.b]), labels: kept.map((p) => p.label), rejected };
}

/**
 * 页面里 fix 的 Node 版，逐字照抄：同一份清单、同一个顺序，页面里遮成什么这里就算成什么。
 * @template T
 * @param {T} s
 * @param {Pairs} pairs
 * @returns {T}
 */
function fixString(s, pairs) {
  if (typeof s !== "string") return s;
  /** @type {string} */
  let v = s;
  for (let k = 0; k < 4; k++) {
    const o = v;
    for (const [a, b] of pairs) if (v && v.indexOf(a) !== -1) v = v.split(a).join(b);
    if (v === o) break;
  }
  return /** @type {any} */ (v);
}

/**
 * 深拷贝一份并把所有字符串过一遍 fixString（键名不动）。
 * @param {any} obj @param {Pairs} pairs
 * @returns {any}
 */
function deepFix(obj, pairs) {
  if (typeof obj === "string") return fixString(obj, pairs);
  if (Array.isArray(obj)) return obj.map((x) => deepFix(x, pairs));
  if (obj && typeof obj === "object") {
    /** @type {Record<string, any>} */
    const o = {};
    for (const k of Object.keys(obj)) o[k] = deepFix(obj[k], pairs);
    return o;
  }
  return obj;
}

// ---------------------------------------------------------------- 打字、鼠标

/** 可复现的伪随机：同一个 seed 永远同一串，录两遍节奏一样，测试也能钉死 */
/** @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PUNCT = new Set(Array.from("，。,.！？!?；;：:、\n"));

/**
 * 每个字打完之后停多久（毫秒），一字一个（按码点，emoji 算一个）。
 * 节奏照 record-demo.js：平时 55ms，标点后 220ms，像人在断句；再加 ±25% 抖动，不然一眼机器味。
 * @param {string} text
 * @param {{ base?: number, punct?: number, jitter?: number, seed?: number }} [o]
 * @returns {number[]}
 */
function typingPlan(text, o = {}) {
  const base = o.base ?? 55, punct = o.punct ?? 220, jitter = o.jitter ?? 0.25;
  const rnd = mulberry32(o.seed ?? 1);
  return Array.from(String(text || "")).map((ch) => {
    const b = PUNCT.has(ch) ? punct : base;
    return Math.max(1, Math.round(b * (1 + jitter * (rnd() * 2 - 1))));
  });
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** @param {number} v @param {number} [d] */
const round = (v, d = 2) => { const k = 10 ** d; return Math.round(v * k) / k; };

/**
 * 假光标从 from 滑到 to 的轨迹：先快后慢的缓动，60Hz 采样，距离越远越久（180~700ms 封顶）。
 * 最后一个点严丝合缝落在目标上，点下去的位置和画面上光标停的位置才对得上。
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @param {{ hz?: number, minMs?: number, maxMs?: number }} [o]
 * @returns {{ x: number, y: number, dt: number }[]} dt = 距上一个点的毫秒数
 */
function mousePath(from, to, o = {}) {
  const hz = o.hz || 60, minMs = o.minMs ?? 180, maxMs = o.maxMs ?? 700;
  const fx = Number(from && from.x), fy = Number(from && from.y);
  const dx = to.x - fx, dy = to.y - fy, dist = Math.hypot(dx, dy);
  if (!(dist >= 1)) return [{ x: to.x, y: to.y, dt: 0 }];
  const ms = clamp(minMs + dist * 0.45, minMs, maxMs);
  const n = Math.max(2, Math.round((ms * hz) / 1000));
  const dt = ms / n;
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    pts.push(i === n ? { x: to.x, y: to.y, dt } : { x: round(fx + dx * e), y: round(fy + dy * e), dt });
  }
  return pts;
}

// ---------------------------------------------------------------- 自动放大

/** 一条表达式里的关键帧上限：再多 ffmpeg 表达式就长得离谱，也没人看得过来 */
const MAX_POSES = 64;

/**
 * 点击 / 打字的位置 → 镜头关键帧 {t 输出秒, z 倍数, cx, cy CSS 像素中心}。
 * - 倍数按目标大小自动算：让目标占画面约 1/3，封顶 maxZoom；放大不到 1.15 倍就不动镜头（晃一下反而难看）；
 * - 镜头中心夹在画面里，贴边的按钮不会拍到页面外面的黑边；
 * - 提前 lead 秒推近，停 hold 秒（打字就停到打完），再 tail 秒拉回；
 * - 前一个还没拉回、下一个马上又来（间隔 < mergeGap）：直接平移过去，不来回拉伸。
 * @param {{ t: number, rect: { x: number, y: number, w: number, h: number }, until?: number, scale?: number }[]} events
 * @param {{ cssW: number, cssH: number, maxZoom?: number, minGain?: number, lead?: number, hold?: number, tail?: number, mergeGap?: number }} o
 * @returns {Pose[]}
 */
function zoomPoses(events, o) {
  const W = o.cssW, H = o.cssH;
  const maxZoom = o.maxZoom ?? 1.8, minGain = o.minGain ?? 1.15;
  const lead = o.lead ?? 0.35, hold = o.hold ?? 1.1, tail = o.tail ?? 0.45, mergeGap = o.mergeGap ?? 0.7;
  const home = { z: 1, cx: W / 2, cy: H / 2 };
  const evs = (events || [])
    .filter((e) => e && Number.isFinite(e.t) && e.t >= 0 && e.rect && [e.rect.x, e.rect.y, e.rect.w, e.rect.h].every(Number.isFinite) && e.rect.w > 0 && e.rect.h > 0)
    .map((e) => {
      const r = e.rect;
      const z = e.scale != null && Number.isFinite(e.scale)
        ? clamp(e.scale, 1, LIMITS.maxScale)
        : clamp(Math.min(W / (r.w * 3), H / (r.h * 3)), 1, maxZoom);
      const cx = clamp(r.x + r.w / 2, W / (2 * z), W - W / (2 * z));
      const cy = clamp(r.y + r.h / 2, H / (2 * z), H - H / (2 * z));
      return { t: e.t, z, cx, cy, holdEnd: Math.max(e.t + hold, Number.isFinite(e.until) ? /** @type {number} */ (e.until) : 0) };
    })
    .filter((e) => e.z >= minGain)
    .sort((a, b) => a.t - b.t);
  // 分组：组内平移，组间拉回原样
  /** @type {(typeof evs)[]} */
  const groups = [];
  for (const e of evs) {
    const g = groups[groups.length - 1];
    if (g && e.t - lead - Math.max(...g.map((x) => x.holdEnd)) < mergeGap) g.push(e);
    else groups.push([e]);
  }
  /** @type {Pose[]} */
  const poses = [{ t: 0, ...home }];
  const last = () => poses[poses.length - 1];
  /** @param {number} t @param {{ z: number, cx: number, cy: number }} p */
  const add = (t, p) => {
    const tt = round(t, 3);
    if (tt <= last().t) return false;
    poses.push({ t: tt, z: round(p.z, 3), cx: round(p.cx, 1), cy: round(p.cy, 1) });
    return true;
  };
  for (const g of groups) {
    if (poses.length + g.length * 2 + 2 > MAX_POSES) break;
    // 推近：从原样出发，至少给 0.15 秒，贴着片头的点击也有个过渡
    add(Math.max(g[0].t - lead, last().t + 0.01), home);
    for (let k = 0; k < g.length; k++) {
      const e = g[k], next = g[k + 1];
      add(Math.max(e.t, last().t + 0.15), e);
      if (next) {
        // 停到下一个目标出发之前；两次点得太近就不停，直接平移过去
        const pan = Math.min(lead, (next.t - e.t) / 2);
        add(Math.min(e.holdEnd, next.t - pan), e);
      }
    }
    const end = Math.max(...g.map((x) => x.holdEnd));
    const lastE = g[g.length - 1];
    add(Math.max(end, last().t + 0.01), lastE);
    add(last().t + tail, home);
  }
  return poses;
}

/** 表达式里的数字：不许科学计数法（ffmpeg 认得 1e-7，但负号、小数位多了容易拼错），保留 4 位 */
/** @param {number} v */
const num = (v) => {
  const s = String(round(v, 4));
  return /e/i.test(s) ? v.toFixed(4) : s;
};

/**
 * 分段平滑插值表达式：T 在 [t_i, t_{i+1}) 里时从 v_i 缓到 v_{i+1}（smoothstep），最后一段之后停在末值。
 * 相邻两帧同值的段直接写常数，表达式短一半。
 * @param {Pose[]} poses @param {(p: Pose) => number} pick @param {string} T
 */
function piecewise(poses, pick, T) {
  let expr = num(pick(poses[poses.length - 1]));
  for (let i = poses.length - 2; i >= 0; i--) {
    const a = poses[i], b = poses[i + 1];
    const va = pick(a), vb = pick(b);
    const seg = Math.abs(vb - va) < 1e-6
      ? num(va)
      : (() => {
        const u = `min(1,max(0,(${T}-${num(a.t)})*${num(1 / (b.t - a.t))}))`;
        return `${num(va)}+(${num(vb - va)})*${u}*${u}*(3-2*${u})`;
      })();
    expr = `if(lt(${T},${num(b.t)}),${seg},${expr})`;
  }
  return expr;
}

/**
 * 关键帧 → ffmpeg 滤镜串。
 * 先 fps= 转成恒定帧率：截来的帧时长不等（画面不动就不落新帧），zoompan 每个输入帧只出一帧，
 * 不先补齐就会把「停三秒」压成一帧，时间全乱；补齐之后 in/fps 才是真实秒数。
 * 再放大 up 倍给 zoompan 用：它的裁剪坐标是整数，直接在成片尺寸上放大会一抖一抖。
 * crop 做不了变焦（它的宽高只算一次），所以只能是 zoompan，d=1 一进一出。
 * @param {Pose[]} poses
 * @param {{ w: number, h: number, fps: number, cssW: number, cssH?: number, up?: number }} o
 * @returns {string}
 */
function zoomFilter(poses, o) {
  const { w, h, fps } = o;
  const up = o.up || 2;
  const moving = (poses || []).some((p) => p.z > 1.001);
  if (!moving) return `fps=${fps},scale=${w}:${h}:flags=lanczos,setsar=1`;
  const k = (up * w) / o.cssW;
  const T = `(in/${fps})`;
  const Z = piecewise(poses, (p) => p.z, T);
  const CX = piecewise(poses, (p) => p.cx * k, T);
  const CY = piecewise(poses, (p) => p.cy * k, T);
  return `fps=${fps},scale=${w * up}:${h * up}:flags=lanczos,`
    + `zoompan=z='${Z}':x='max(0,min(iw-iw/zoom,${CX}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${CY}-ih/zoom/2))':d=1:s=${w}x${h}:fps=${fps},setsar=1`;
}

// ---------------------------------------------------------------- 帧与时间

/**
 * ffmpeg concat 列表（照 record-demo.js writeList）：file / duration 成对，末帧再列一次，
 * 不然最后一帧的时长会被 concat 吃掉。单引号按 concat 的规矩转义成 '\''。
 * @param {{ file: string }[]} frames
 * @param {number[]} durations 秒
 */
function concatList(frames, durations) {
  if (!frames || !frames.length) throw new Error("一帧都没录到，没法合成");
  const q = (/** @type {string} */ f) => `file '${String(f).replace(/'/g, "'\\''")}'`;
  const lines = [];
  for (let i = 0; i < frames.length; i++) lines.push(q(frames[i].file), `duration ${Math.max(0.001, Number(durations[i]) || 0).toFixed(3)}`);
  lines.push(q(frames[frames.length - 1].file));
  return lines.join("\n") + "\n";
}

/**
 * 墙钟时刻（录制时 Date.now()）→ 成片里的秒数。帧内按比例插，单调不减。
 * 步骤起止、点击时刻、字幕都靠它换算，这样倍速 / 压缩「等待」之后时间轴仍然对得上。
 * @param {{ at: number, until: number }[]} frames
 * @param {number[]} durations 秒
 * @param {number} tWallMs
 */
function mapTime(frames, durations, tWallMs) {
  if (!frames || !frames.length) return 0;
  let acc = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], next = frames[i + 1];
    const d = Number(durations[i]) || 0;
    if (tWallMs < f.at) return round(acc, 3);
    const span = next ? next.at - f.at : Math.max(1, f.until - f.at);
    if (!next || tWallMs < next.at) return round(acc + d * clamp((tWallMs - f.at) / span, 0, 1), 3);
    acc += d;
  }
  return round(acc, 3);
}

// ---------------------------------------------------------------- 注入页面的脚本

/**
 * 马赛克自检：塞一段带原文的隐藏文字，30ms 后看观察者有没有把它换掉。
 * 装没装上（__demoMask 和清单条数对得上）+ 真遮了，两样都要。只返回布尔，原文不出页面。
 * @param {Pairs} pairs
 */
function probeScript(pairs) {
  const raw = pairs.map((p) => p[0]);
  return `(async () => {
  const RAW = ${JSON.stringify(raw)};
  const m = window.__demoMask;
  if (!m || m.pairs !== RAW.length) return { installed: false, masked: false };
  const host = document.body || document.documentElement;
  if (!host) return { installed: true, masked: false };
  const d = document.createElement("div");
  d.setAttribute("aria-hidden", "true");
  d.style.cssText = "position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none";
  d.textContent = RAW.map((a) => a + "/workspace/x.csv").join(" ");
  host.appendChild(d);
  await new Promise((r) => setTimeout(r, 30));
  const t = d.textContent || "";
  d.remove();
  return { installed: true, masked: RAW.every((a) => t.indexOf(a) === -1) };
})()`;
}

/**
 * 假光标：录屏看不到系统光标（无头 / 截帧都没有），画一个跟着指针事件走的。
 * - 挂在 <html> 上而不是 <body>：单页应用整个换 body 时它还在；
 * - closed shadow root + pointer-events:none：页面样式够不着它，它也挡不住点击；
 * - 竖屏（touch）画成一个圆点，按下才出现，抬手淡出，像手机录屏的「显示触摸」；
 * - 新文档一开头就注入时 <html> 还没有，等 DOMContentLoaded 再挂；
 * - iframe 里不画，不然一个页面两个光标。
 * @param {{ mode?: "arrow" | "touch" }} [o]
 */
function overlayScript(o = {}) {
  const mode = o.mode === "touch" ? "touch" : "arrow";
  return String.raw`(() => {
  if (window.top !== window) return "frame";
  if (window.__demoCursor) return window.__demoCursor.mode;
  const MODE = "${mode}";
  const S = { mode: MODE, x: -200, y: -200, down: false, clicks: 0 };
  let host = null, root = null, me = null;
  const ARROW = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.5 25 L17 23.5 L13.5 16 L20 16 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const place = () => {
    if (!me) return;
    if (MODE === "touch") me.style.transform = "translate(" + (S.x - 18) + "px," + (S.y - 18) + "px)";
    else me.style.transform = "translate(" + (S.x - 5) + "px," + (S.y - 3) + "px)";
  };
  const install = () => {
    if (!document.documentElement) return false;
    if (host) { if (!host.isConnected) document.documentElement.appendChild(host); return true; }
    host = document.createElement("owb-demo-cursor");
    host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = "<style>"
      + ":host{all:initial}"
      + "#c{position:fixed;left:0;top:0;pointer-events:none;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}"
      + "#c.t{width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,.28);box-shadow:0 0 0 2px rgba(255,255,255,.9);opacity:0;transition:opacity .2s}"
      + ".r{position:fixed;left:0;top:0;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:2px solid rgba(64,128,255,.9);pointer-events:none}"
      + "</style>"
      + (MODE === "touch" ? '<div id="c" class="t"></div>' : '<div id="c">' + ARROW + "</div>");
    me = root.getElementById("c");
    document.documentElement.appendChild(host);
    place();
    return true;
  };
  const ripple = () => {
    if (!root || !root.appendChild) return;
    const r = document.createElement("div");
    r.className = "r";
    r.style.transform = "translate(" + S.x + "px," + S.y + "px)";
    root.appendChild(r);
    const done = () => r.remove();
    if (r.animate) {
      const a = r.animate([{ opacity: 0.9, transform: r.style.transform + " scale(.2)" }, { opacity: 0, transform: r.style.transform + " scale(1)" }], { duration: 450, easing: "ease-out" });
      a.onfinish = done;
    } else setTimeout(done, 450);
  };
  const on = (ev) => {
    if (!install()) return;
    if (typeof ev.clientX === "number") { S.x = ev.clientX; S.y = ev.clientY; }
    if (ev.type === "pointerdown") { S.down = true; S.clicks++; ripple(); if (MODE === "touch") me.style.opacity = "1"; }
    if (ev.type === "pointerup" || ev.type === "pointercancel") { S.down = false; if (MODE === "touch") me.style.opacity = "0"; }
    place();
  };
  for (const t of ["pointermove", "pointerdown", "pointerup", "pointercancel"]) window.addEventListener(t, on, { capture: true, passive: true });
  if (!install()) document.addEventListener("DOMContentLoaded", install, { once: true });
  window.__demoCursor = {
    mode: MODE,
    pos: () => ({ x: S.x, y: S.y, down: S.down, clicks: S.clicks }),
    moveTo: (x, y) => { S.x = x; S.y = y; install(); place(); return true; },
    installed: () => !!(host && host.isConnected),
  };
  return MODE;
})()`;
}

/**
 * 找到要点的元素，必要时滚进视口，返回它在视口里的 CSS 像素矩形。
 * - text：按看得见的字找，取最深的那个（<body> 也「包含」这段字，要的是真正显示它的元素）；
 * - nth：第几个匹配（从 1 数），只数看得见的；
 * - 已经在视口里就不滚，免得每点一下页面都抖一下；
 * - covered：中心点被别的东西盖着（弹窗、遮罩），录制器据此报「点不到」而不是点在遮罩上。
 * 返回 null = 没找到；{error} = 选择器本身写错了。
 * @param {Target} target
 */
function resolveTargetScript(target) {
  const T = JSON.stringify({ selector: target.selector || "", text: target.text || "", nth: target.nth || 1 });
  return String.raw`(() => {
  const T = ${T};
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.01;
  };
  let list;
  try { list = Array.from(document.querySelectorAll(T.selector || "body *")); }
  catch (e) { return { error: "selector 写错了" }; }
  if (T.text) {
    const want = norm(T.text);
    list = list.filter((el) => norm(el.textContent).indexOf(want) !== -1 || norm(el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.value)).indexOf(want) !== -1);
    if (!T.selector) list = list.filter((el) => !list.some((o) => o !== el && el.contains(o)));
  }
  list = list.filter(vis);
  const el = list[T.nth - 1];
  if (!el) return null;
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    r = el.getBoundingClientRect();
  }
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const covered = !!top && top !== el && !el.contains(top) && !(top.closest && top.closest("owb-demo-cursor"));
  return { x: r.left, y: r.top, w: r.width, h: r.height, n: list.length, covered };
})()`;
}

/**
 * DOM 树里拿不到的「活」字：document.title、输入框当前的 .value（DOM.getDocument 只给 value 属性，
 * 用户打的字不在里面）、可编辑区的文字。开放的 shadow root 和同源 iframe 也翻，数量有上限。
 * 隐藏域、密码框不上屏，不收。
 */
function liveValuesScript() {
  return `(() => {
  const out = [];
  const MAX = 2000;
  const push = (s) => { if (typeof s === "string" && s && out.length < MAX) out.push(s.length > 20000 ? s.slice(0, 20000) : s); };
  const visit = (doc, depth) => {
    if (!doc || depth > 6) return;
    try { push(doc.title); } catch (e) { /* 跨域 iframe 读不了，跳过 */ }
    const roots = [doc];
    while (roots.length && out.length < MAX) {
      const r = roots.pop();
      let els = [];
      try { els = r.querySelectorAll("*"); } catch (e) { continue; }
      for (const el of els) {
        const tag = el.tagName;
        if (tag === "INPUT") { const ty = String(el.type || "").toLowerCase(); if (ty !== "hidden" && ty !== "password") push(el.value); }
        else if (tag === "TEXTAREA") push(el.value);
        else if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) push(el.innerText);
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (tag === "IFRAME" || tag === "FRAME") { try { visit(el.contentDocument, depth + 1); } catch (e) { /* 跨域 */ } }
      }
    }
  };
  visit(document, 0);
  return out;
})()`;
}

const SKIP_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
const SCAN_ATTRS = new Set(["title", "placeholder", "alt", "aria-label"]);

/**
 * 泄漏扫描：遍历 DOM.getDocument({depth:-1, pierce:true}) 那棵树 + 活的输入值，看清单里的原文还在不在。
 * 只查上屏的东西：文本节点（脚本/样式里的不算）、title/placeholder/alt/aria-label、输入框的 value。
 * 返回命中的标签（「home 目录」「你列的第 2 项」），绝不回显原文——报错信息本身也会进日志和对话。
 * @param {any} domRoot CDP DOM.Node
 * @param {string[]} live liveValuesScript 的结果
 * @param {Pairs} pairs
 * @param {string[]} labels
 * @returns {string[]}
 */
function findLeaks(domRoot, live, pairs, labels) {
  /** @type {Set<number>} */
  const hit = new Set();
  /** @param {any} s */
  const check = (s) => {
    if (typeof s !== "string" || !s) return;
    for (let i = 0; i < pairs.length; i++) if (!hit.has(i) && s.indexOf(pairs[i][0]) !== -1) hit.add(i);
  };
  /** @type {{ n: any, skip: boolean }[]} */
  const stack = domRoot ? [{ n: domRoot, skip: false }] : [];
  let guard = 0;
  while (stack.length && guard++ < 1000000) {
    const it = /** @type {{ n: any, skip: boolean }} */ (stack.pop());
    const n = it.n;
    if (!n || typeof n !== "object") continue;
    const name = String(n.nodeName || "").toUpperCase();
    if (n.nodeType === 3) { if (!it.skip) check(n.nodeValue); continue; }
    // 密码框、隐藏域的值不上屏；它们浏览器内部的 shadow 里还抄着一份原值，算泄漏就是误报
    let secret = false;
    if (n.nodeType === 1 && Array.isArray(n.attributes)) {
      const a = n.attributes;
      /** @type {Record<string, string>} */
      const m = {};
      for (let i = 0; i + 1 < a.length; i += 2) m[String(a[i]).toLowerCase()] = a[i + 1];
      for (const k of Object.keys(m)) if (SCAN_ATTRS.has(k)) check(m[k]);
      const ty = String(m.type || "").toLowerCase();
      secret = name === "INPUT" && (ty === "hidden" || ty === "password");
      if (name === "INPUT" && !secret) check(m.value);
    }
    const skip = it.skip || SKIP_TEXT.has(name);
    // template 的内容不渲染，templateContent 不进；伪元素的 content 不在 DOM 里，本来也扫不到
    for (const kids of [n.children, secret ? null : n.shadowRoots]) if (Array.isArray(kids)) for (const c of kids) stack.push({ n: c, skip });
    if (n.contentDocument) stack.push({ n: n.contentDocument, skip: false });
  }
  for (const v of live || []) check(v);
  const out = [];
  for (const i of [...hit].sort((x, y) => x - y)) {
    const lab = labels[i] || "本机信息";
    if (!out.includes(lab)) out.push(lab);
  }
  return out;
}

/** @param {string} s */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
/** @param {number} v */
const r4 = (v) => Math.max(4, Math.round(v / 4) * 4);

/**
 * 字幕页：透明背景上一块半透明黑底白字，录制器用同一个 Chrome 开第二个页签截成透明 PNG，
 * 放大之后再叠上去——画在页面里的话会跟着镜头一起被放大、被裁掉。
 * 字号取短边的 4.2%，横屏竖屏看着一样大；中文不加字距；最多两行，再长截掉（DSL 那边已经卡了 40 个字）。
 * @param {string} text
 * @param {{ w: number, h?: number, pairs?: Pairs }} o
 */
function captionHtml(text, o) {
  const w = Math.round(o.w);
  const short = Math.min(w, Math.round(o.h || w));
  const fs = Math.max(16, Math.round(short * 0.042));
  const padV = r4(fs * 0.4), padH = r4(fs * 0.8), radius = r4(fs * 0.35);
  const body = esc(fixString(String(text || ""), o.pairs || []));
  return "<!doctype html><html><head><meta charset=\"utf-8\"><style>"
    + `html,body{margin:0;padding:0;background:transparent}`
    + `body{width:${w}px;display:flex;justify-content:center}`
    + `#cap{box-sizing:border-box;max-width:${Math.round(w * 0.86)}px;margin:0;padding:${padV}px ${padH}px;border-radius:${radius}px;`
    + `background:rgba(0,0,0,.62);color:#fff;font-family:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;`
    + `font-size:${fs}px;line-height:1.4;font-weight:600;letter-spacing:0;text-align:center;`
    + `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere}`
    + `</style></head><body><div id="cap">${body}</div></body></html>`;
}

// ---------------------------------------------------------------- steps.json

/**
 * steps.json（version 1）。所有字符串再过一遍打码，最后整份再查一次原文：
 * 查到就抛错不写——这份文件会跟着成片一起发出去。
 * @param {{
 *   video?: string, aspect: string, size: number[], fps: number, durationSec: number, speed?: number,
 *   steps: { i: number, op: string, label?: string, start: number, end: number, shot?: string | null, target?: { x: number, y: number, w: number, h: number } | null }[],
 *   zooms?: Pose[], captions?: { text: string, start: number, end: number }[],
 *   pairs: Pairs, labels: string[], probes?: number, scans?: number
 * }} o
 */
function buildStepsJson(o) {
  const t2 = (/** @type {number} */ v) => round(Number(v) || 0, 2);
  const out = {
    version: 1,
    video: o.video || "demo.mp4",
    aspect: o.aspect,
    size: [Math.round(o.size[0]), Math.round(o.size[1])],
    fps: o.fps,
    duration_sec: t2(o.durationSec),
    speed: o.speed || 1,
    steps: (o.steps || []).map((s) => ({
      i: s.i,
      op: s.op,
      label: s.label || "",
      start: t2(s.start),
      end: t2(s.end),
      shot: s.shot || null,
      target: s.target ? { x: Math.round(s.target.x), y: Math.round(s.target.y), w: Math.round(s.target.w), h: Math.round(s.target.h) } : null,
    })),
    zooms: (o.zooms || []).map((z) => ({ t: t2(z.t), z: round(z.z, 3), cx: Math.round(z.cx), cy: Math.round(z.cy) })),
    captions: (o.captions || []).map((c) => ({ text: c.text, start: t2(c.start), end: t2(c.end) })),
    mask: {
      ok: true,
      pairs: o.pairs.length,
      labels: [...new Set(o.labels)],
      probes: o.probes || 0,
      scans: o.scans || 0,
      limits: "画布/图片/视频里的字遮不到",
    },
  };
  const fixed = deepFix(out, o.pairs);
  const s = JSON.stringify(fixed);
  const left = o.pairs.map((p, i) => (s.indexOf(p[0]) !== -1 ? o.labels[i] || "本机信息" : "")).filter(Boolean);
  if (left.length) throw new Error(`steps.json 里还有没遮住的${[...new Set(left)].join("、")}，不写`);
  return fixed;
}

module.exports = {
  ASPECTS, IPHONE_UA, OPS, LIMITS, KEYS, MAX_POSES,
  aspectPreset, parseSteps, keyName, dispWidth,
  outDirRel, shotName,
  maskPairs, fixString, deepFix,
  mulberry32, typingPlan, mousePath,
  zoomPoses, zoomFilter,
  concatList, mapTime,
  probeScript, overlayScript, resolveTargetScript, liveValuesScript,
  findLeaks, captionHtml, buildStepsJson,
};
