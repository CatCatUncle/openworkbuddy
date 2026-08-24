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

/** mermaid 源码 → SVG 字符串（离线，主题跟 mermaid 默认） */
async function renderMermaid(source, theme) {
  const mermaidSrc = fs
    .readFileSync(require.resolve("mermaid/dist/mermaid.min.js"), "utf8")
    .replace(/<\/script>/gi, "<\\/script>");
  return withHiddenWindow(1200, 800, async (win) => {
    await loadHtml(win, `<!doctype html><meta charset="utf-8"><body><script>${mermaidSrc}</script>`);
    return win.webContents.executeJavaScript(
      `(async () => {
        mermaid.initialize({ startOnLoad: false, theme: ${JSON.stringify(theme || "default")}, securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false }, class: { htmlLabels: false }, state: { htmlLabels: false } }); // htmlLabels 会把文字放 <foreignObject>，<img>/Word/飞书 里直接丢字，一律用原生 <text>
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
