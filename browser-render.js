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

function available() {
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
 * 就跟正文的配色打架，用户的原话是"这个图很丑"。这里换成一套低饱和的浅底 + 深墨字：
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

module.exports = { available, renderMermaid, svgToPng, svgSize };
