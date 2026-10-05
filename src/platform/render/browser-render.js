// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Electron 隐藏窗口渲染服务 —— mermaid 渲染与 SVG→PNG 截图靠它。
 * 应用本身跑在 Electron 里（npm run app），等于自带一个无头 Chromium，
 * 不用像 mermaid-cli 那样额外拖一个 puppeteer。
 * 仅在 Electron 主进程可用；node 直跑（npm start / eval CLI）时 available() 为 false，
 * 调用方自行降级（在线渲染或只交付 SVG）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// 服务端在独立服务进程里（2026-09-29 起桌面版默认）：那边开不了窗口，渲染交给主进程，
// 能不能渲染看主进程报上来的 caps.windows
const bridge = require("../../../electron-bridge");

function available() {
  if (bridge.isRemote()) return !!bridge.caps().windows;
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) return false;
  try {
    const { app } = require("electron");
    return !!(app && app.isReady());
  } catch {
    return false;
  }
}

async function withHiddenWindow(width, height, fn) {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({
    show: false,
    width: Math.min(4000, Math.max(10, Math.ceil(width))),
    height: Math.min(4000, Math.max(10, Math.ceil(height))),
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    return await fn(win);
  } finally {
    try { win.destroy(); } catch {}
  }
}

/** data: URL 装不下 mermaid.min.js（2.8MB），落临时文件用 loadFile，加载完即删 */
async function loadHtml(win, html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-render-"));
  const f = path.join(dir, "page.html");
  fs.writeFileSync(f, html);
  try {
    await win.loadFile(f);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * gen_diagram 的默认配色。
 *
 * mermaid 自带的 default 主题是一套高饱和的粉/黄/紫/绿，单看还行，一旦贴进正经报告里
 * 就跟正文的配色打架，贴进去只会显得丑。这里换成一套低饱和的浅底 + 深墨字：
 * 四个色相（靛/青/琥珀/玫瑰）都压到浅色，线是灰蓝，字一律 #23262e 而不是纯黑——
 * 打印、贴 Word、贴飞书都不会糊成一团。调用方显式指定 theme 时不覆盖它。
 *
 * 字体也必须在这里给死：mermaid 默认 "trebuchet ms"，中文只能靠浏览器兜底，
 * 不同机器上字宽不一样，文字会顶出框。
 */
const MERMAID_THEME = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  fontSize: "14px",
  background: "#ffffff",
  textColor: "#23262e",
  lineColor: "#8f97a6",
  primaryColor: "#eef1f8", primaryTextColor: "#23262e", primaryBorderColor: "#c3cad8",
  secondaryColor: "#f4f1ea", secondaryTextColor: "#23262e", secondaryBorderColor: "#ddd5c6",
  tertiaryColor: "#fafbfd", tertiaryTextColor: "#23262e", tertiaryBorderColor: "#e2e6ee",
  noteBkgColor: "#fdf6e3", noteTextColor: "#4a3f2a", noteBorderColor: "#e6d9b8",
  edgeLabelBackground: "#ffffff",
  titleColor: "#23262e",
  // 思维导图/饼图/旅程图按层级取这一组；四个色相循环两轮，深浅错开
  cScale0: "#e6e8fb", cScale1: "#ddf0ec", cScale2: "#fbeedb", cScale3: "#fbe6ea",
  cScale4: "#eef1f8", cScale5: "#eaf4f1", cScale6: "#f7f1e6", cScale7: "#f8eef0",
  cScaleLabel0: "#23262e", cScaleLabel1: "#23262e", cScaleLabel2: "#23262e", cScaleLabel3: "#23262e",
  cScaleLabel4: "#23262e", cScaleLabel5: "#23262e", cScaleLabel6: "#23262e", cScaleLabel7: "#23262e",
};

/** mermaid 源码 → SVG 字符串（离线；不指定 theme 时用上面那套克制的配色） */
async function renderMermaid(source, theme) {
  if (bridge.isRemote()) return String(await bridge.call("mermaid.render", { source: String(source), theme: theme || null }, { timeoutMs: 30000 }));
  const mermaidSrc = fs
    .readFileSync(require.resolve("mermaid/dist/mermaid.min.js"), "utf8")
    .replace(/<\/script>/gi, "<\\/script>");
  return withHiddenWindow(1200, 800, async (win) => {
    await loadHtml(win, `<!doctype html><meta charset="utf-8"><body><script>${mermaidSrc}</script>`);
    return win.webContents.executeJavaScript(
      `(async () => {
        mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(theme || "base")}, themeVariables: ${theme ? "undefined" : JSON.stringify(MERMAID_THEME)}, securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false, curve: "basis", nodeSpacing: 44, rankSpacing: 48 }, class: { htmlLabels: false }, state: { htmlLabels: false } }); // htmlLabels 会把文字放 <foreignObject>，<img>/Word/飞书 里直接丢字，一律用原生 <text>
        const { svg } = await mermaid.render("mmd" + Math.floor(Math.random() * 1e9), ${JSON.stringify(String(source))});
        return svg;
      })()`,
      true
    );
  });
}

/** 从 <svg> 头部量出像素尺寸（graphviz 用 pt，×4/3 换算；量不到就退 viewBox，再退默认） */
function svgSize(svg) {
  const head = (String(svg).match(/<svg[^>]*>/) || [""])[0];
  const num = (re) => {
    const m = head.match(re);
    return m ? parseFloat(m[1]) : 0;
  };
  let w = num(/\bwidth="([\d.]+)(?:px)?"/), h = num(/\bheight="([\d.]+)(?:px)?"/);
  if (/\bwidth="[\d.]+pt"/.test(head)) {
    w = (num(/\bwidth="([\d.]+)pt"/) * 4) / 3;
    h = (num(/\bheight="([\d.]+)pt"/) * 4) / 3;
  }
  if (!w || !h) {
    const vb = head.match(/viewBox="[\s\d.-]*?([\d.]+)[\s,]+([\d.]+)"\s*/);
    if (vb) { w = parseFloat(vb[1]); h = parseFloat(vb[2]); }
  }
  return { w: Math.min(Math.max(w || 800, 40), 4000), h: Math.min(Math.max(h || 600, 40), 4000) };
}

/** SVG → PNG（2 倍清晰度截图；中文字体由 Chromium 渲染，无乱码） */
async function svgToPng(svg, scale = 2) {
  if (bridge.isRemote()) {
    const buf = bridge.toBuf(await bridge.call("svg.png", { svg: String(svg), scale }, { timeoutMs: 30000 }));
    if (!buf) throw new Error("桌面主进程没有返回图片数据（svg.png）");
    return buf;
  }
  const { w, h } = svgSize(svg);
  return withHiddenWindow(w * scale, h * scale, async (win) => {
    const html =
      `<!doctype html><meta charset="utf-8">` +
      `<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}svg{display:block;width:${w}px;height:${h}px}</style>` +
      `<body>${svg}`;
    await loadHtml(win, html);
    win.webContents.setZoomFactor(scale);
    await win.webContents.executeJavaScript("document.fonts.ready.then(() => 1)", true);
    await delay(150); // 等一帧合成，offscreen 下截早了会是白图
    const img = await win.webContents.capturePage();
    return img.toPNG();
  });
}

// ---------- 缩图三件活交给隐藏渲染窗口（Windows） ----------
//
// 缩略图、给模型看的图压小、宠物头像，原来是 nativeImage 在主进程里**同步**解码缩放编码，
// 而主进程就是界面线程：一张 4032 的手机照片 40–61ms，6016² 的 145–181ms（2026-09-29 量的）。
// macOS 上交给 sips 子进程（thumb-sips.js）；Windows 没有 sips，就交给一个隐藏的渲染窗口——
// 它是另一个进程：读文件走 Chromium 自己的 IO 线程，解码在它的解码线程，缩放、编码都在那边，
// 界面线程上只剩来回一趟消息。接口跟 createSipsPixels 一模一样，bridge-main.js 不用分辨是谁在做。
//
// 做不了（窗口建不起来、读不了文件、解不出图、超时）一律回 null：调用方退回 nativeImage 老路，
// 结果跟以前一样，只是那一张还在界面线程上做。每次退回都记一笔日志（前几次逐条记，之后抽着记）。

/**
 * 在隐藏窗口里跑的那段（整段 toString 过去）。读图 → 按 EXIF 转正 → 裁 / 缩 → 编码，回 base64。
 * 尺寸口径跟 nativeImage 老路一样：长边缩到目标、另一边按比例四舍五入；宠物头像中心裁方再缩到 320。
 * @param {{url:string, mode:"thumb"|"vision"|"pet", w?:number, maxEdge?:number, quality?:number}} a
 */
async function pixelsPageJob(a) {
  // 下面几样是网页里才有的（后端类型检查不带 DOM 库，直接写名字会报找不到）。
  // 整段要 toString 到页面里跑，只能从页面自己的 globalThis 上拿，不能引外面的任何东西
  const g = /** @type {any} */ (globalThis);
  // 异常过 executeJavaScript 回来只剩一个空对象，看不出是哪一步：每一步自己把话说清楚再回
  const why = (e) => String((e && (e.name && e.message ? e.name + ": " + e.message : e.message || e.name)) || e);
  let blob, full;
  try { blob = await (await fetch(a.url)).blob(); } catch (e) { return { err: "读不到这个文件：" + why(e) }; }
  // 从 Blob 解：页面自己造的数据，不会把画布弄脏（直接拿 file:// 的 <img> 画，导出时会被当成跨域拦下）
  try { full = await g.createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (e) { return { err: "解不出这张图：" + why(e) }; }
  try {
    const W = full.width, H = full.height;
    const fit = (edge) => (W >= H ? [edge, Math.max(1, Math.round((H * edge) / W))] : [Math.max(1, Math.round((W * edge) / H)), edge]);
    let sx = 0, sy = 0, sw = W, sh = H, ow = W, oh = H;
    if (a.mode === "thumb") {
      if (Math.max(W, H) <= Number(a.w)) return { w: W, h: H, skip: true };
      [ow, oh] = fit(Number(a.w));
    } else if (a.mode === "vision") {
      if (Math.max(W, H) > Number(a.maxEdge)) [ow, oh] = fit(Number(a.maxEdge));
    } else {
      // 裁的坐标是转正以后的：手机竖拍的照片也是按看到的样子取中间
      const side = Math.min(W, H);
      sx = Math.round((W - side) / 2); sy = Math.round((H - side) / 2); sw = sh = side; ow = oh = 320;
    }
    const bmp = await g.createImageBitmap(full, sx, sy, sw, sh, { resizeWidth: ow, resizeHeight: oh, resizeQuality: "high" });
    const cv = new g.OffscreenCanvas(ow, oh);
    const ctx = cv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const out = await cv.convertToBlob(a.mode === "vision" ? { type: "image/jpeg", quality: (Number(a.quality) || 82) / 100 } : { type: "image/png" });
    const b64 = await new Promise((res, rej) => {
      const r = new g.FileReader();
      r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(",") + 1)); };
      r.onerror = () => rej(r.error);
      r.readAsDataURL(out);
    });
    return { w: W, h: H, ow, oh, b64 };
  } catch (e) {
    return { err: "缩放或编码出错：" + why(e) };
  } finally {
    full.close();
  }
}

/**
 * @param {{electron?: any, max?: number, timeoutMs?: number, staleMs?: number, idleMs?: number,
 *   now?: () => number, log?: (s: string) => void}} [o]
 *   electron / now 给测试换假的。staleMs：排队排了这么久才轮到的缩略图不做了（服务进程那头 10 秒就不等了）。
 *   idleMs：闲了这么久就把窗口关掉——一个渲染进程常驻要占几十 MB；下一批图来了再建，
 *   建一次界面线程上要花一百多毫秒（本机量的 127ms），所以不能一张一建，默认闲 5 分钟才关
 */
function createRenderPixels(o = {}) {
  const electron = o.electron || require("electron");
  const { pathToFileURL } = require("url");
  const max = Math.max(1, Number(o.max) || 2);
  const timeoutMs = Number(o.timeoutMs) || 8000;
  const staleMs = Number(o.staleMs) || 9000;
  const idleMs = Number(o.idleMs) || 5 * 60 * 1000;
  const now = o.now || Date.now;
  const log = typeof o.log === "function" ? o.log : () => {};
  const counts = { runs: 0, ok: 0, fails: 0, fallbacks: 0, stale: 0, peak: 0, queuedPeak: 0, windows: 0 };
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  /** @type {Promise<any>|null} */
  let winP = null;
  let idleTimer = null;
  let closed = false;

  function acquire() {
    clearTimeout(idleTimer);
    if (active < max) { active++; counts.peak = Math.max(counts.peak, active); return Promise.resolve(); }
    return new Promise((res) => {
      waiting.push(() => { active++; counts.peak = Math.max(counts.peak, active); res(); });
      counts.queuedPeak = Math.max(counts.queuedPeak, waiting.length);
    });
  }
  function release() {
    active--;
    const next = waiting.shift();
    if (next) return next();
    if (active === 0 && winP) {
      idleTimer = setTimeout(() => dropWindow(), idleMs);
      if (idleTimer.unref) idleTimer.unref();
    }
  }

  const errText = (e) => {
    const m = e && typeof e === "object" ? e.message || (() => { try { return JSON.stringify(e); } catch { return ""; } })() : e;
    return String(m || "（没有报错原文）").slice(0, 200);
  };
  /** 退回老路时留一笔：前 5 次逐条记，之后每 100 次记一条，坏图成堆时日志不刷屏 */
  function trace(op, why) {
    counts.fallbacks++;
    const n = counts.fallbacks;
    if (n <= 5 || n % 100 === 0) log(`▲ 缩图窗口没做成（${op}），这张退回界面线程上做：${why}（累计 ${n} 次）`);
  }

  function dropWindow() {
    clearTimeout(idleTimer);
    const p = winP;
    winP = null;
    if (p) p.then((w) => { try { if (!w.isDestroyed()) w.destroy(); } catch {} }, () => {});
  }

  /** 隐藏窗口：只建不亮（show:false + 离屏），沙箱、不给 node；装一张空白的 file:// 页 */
  function page() {
    if (winP) return winP;
    const p = (async () => {
      const w = new electron.BrowserWindow({
        show: false, width: 64, height: 64, frame: false, skipTaskbar: true, focusable: false,
        webPreferences: {
          offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
          backgroundThrottling: false, spellcheck: false,
          partition: "owb-pixels", // 不落盘的独立会话，碰不到应用自己的 cookie / localStorage
        },
      });
      counts.windows++;
      // 渲染进程崩了：这一个窗口作废，下一张图来了再建
      w.webContents.on("render-process-gone", () => {
        if (winP === p) winP = null;
        try { w.destroy(); } catch {}
      });
      try {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "owb-px-page-"));
        try {
          const f = path.join(dir, "px.html");
          await fs.promises.writeFile(f, "<!doctype html><meta charset=\"utf-8\"><title>px</title>");
          await w.loadFile(f);
        } finally {
          fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
        try { w.webContents.stopPainting(); } catch {} // 不画任何东西，离屏也别按帧刷
        return w;
      } catch (e) {
        try { w.destroy(); } catch {}
        throw e;
      }
    })();
    winP = p;
    p.catch(() => { if (winP === p) winP = null; });
    return p;
  }

  /** 交给窗口做一张；做不成回 null（已经留过痕） */
  async function run(op, abs, args) {
    if (closed) return null;
    counts.runs++;
    let timer = null;
    try {
      const w = await Promise.race([
        page(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`隐藏窗口 ${timeoutMs}ms 没建好`), { hung: true })), timeoutMs); }),
      ]);
      clearTimeout(timer);
      if (closed) return null;
      const code = `(${pixelsPageJob.toString()})(${JSON.stringify({ ...args, url: pathToFileURL(abs).href })})`;
      // 超时那一路先赢的话，这一趟后来才失败（窗口被关掉）也不能变成没人接的 rejection
      const done = w.webContents.executeJavaScript(code, false);
      done.catch(() => {});
      const r = await Promise.race([
        done,
        new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${timeoutMs}ms 没做完`), { hung: true })), timeoutMs); }),
      ]);
      if (r && r.err) throw new Error(String(r.err));
      if (!r || !(r.w > 0 && r.h > 0)) throw new Error("窗口回的结果没有尺寸");
      if (!r.skip && !(typeof r.b64 === "string" && r.b64.length)) throw new Error("窗口回的图是空的");
      counts.ok++;
      return { w: r.w, h: r.h, skip: !!r.skip, buf: r.skip ? null : Buffer.from(r.b64, "base64") };
    } catch (e) {
      counts.fails++;
      // 卡住不回话的窗口不再用：关掉，下一张重建
      if (e && /** @type {any} */ (e).hung) dropWindow();
      trace(op, errText(e));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function job(fn, { stale = false } = {}) {
    const t0 = now();
    await acquire();
    try {
      if (stale && now() - t0 > staleMs) { counts.stale++; return { value: null }; }
      return await fn();
    } catch (e) {
      trace("排队", errText(e));
      return null;
    } finally {
      release();
    }
  }

  return {
    counts,
    get active() { return active; },
    get queued() { return waiting.length; },
    /** 缩略图：长边缩到 w、出 PNG；本来就不比 w 大回 {value:null}（发原图）。null = 这条路走不通 */
    thumb: (abs, w) => job(async () => {
      const r = await run("缩略图", abs, { mode: "thumb", w });
      return r ? { value: r.buf } : null;
    }, { stale: true }),
    /** 给模型看的图压小：长边超过 maxEdge 才缩，出 JPEG，带（转正以后的）原图宽高 */
    shrinkForVision: (abs, maxEdge, quality) => job(async () => {
      const r = await run("压图", abs, { mode: "vision", maxEdge, quality });
      return r && r.buf ? { value: { jpg: r.buf, width: r.w, height: r.h } } : null;
    }),
    /** 宠物头像：中心裁方、320、GIF 只取第一帧，说明文字跟老路子一字不差 */
    petPhoto: (abs) => job(async () => {
      const r = await run("宠物头像", abs, { mode: "pet" });
      if (!r || !r.buf) return null;
      let note = "";
      if (r.w !== r.h) note += `原图 ${r.w}×${r.h} 不是正方形，已按中心裁成方图；`;
      if (/\.gif$/i.test(abs)) note += "GIF 只取了第一帧（宠物自己带呼吸/跳跃动效）；";
      return { value: { png: r.buf, note } };
    }),
    /** 退出时把窗口收掉 */
    close() {
      closed = true;
      dropWindow();
    },
  };
}

module.exports = { available, renderMermaid, svgToPng, svgSize, createRenderPixels, pixelsPageJob };
