// @ts-check
"use strict";
/**
 * 片头卡、片尾卡（CTA）的 HTML。渲染成 PNG 以后当一张不推镜的图片接进时间轴。
 *
 * 为什么不用 ffmpeg 的 drawtext 直接写字：本机 Homebrew 的 ffmpeg 就没带 drawtext，
 * 而且 drawtext 排中文要自己算换行、算居中，品牌字体还得另配——HTML 一行 CSS 的事。
 * 模板写在这里而不是 templates/ 目录：那个目录不进安装包，装好的桌面版里会找不到。
 *
 * 几条规矩：
 *   - 所有文字都转义：CTA 是用户（或模型）写的，里面有个 < 就能把整张卡弄没；
 *   - 颜色只认 #rgb / #rrggbb / #rrggbbaa，别的一律换成默认色——颜色值是直接拼进 CSS 的；
 *   - 中文不加字距（letter-spacing:0），也不加任何「AI 生成」字样或水印。
 */
const { pathToFileURL } = require("url");
const path = require("path");

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DEFAULT_BG = "#111111";
const DEFAULT_FG = "#FFFFFF";
const SYSTEM_STACK = `-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif`;

/** @param {unknown} s */
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
}
/** @param {unknown} c @param {string} fallback */
function color(c, fallback) { const s = String(c == null ? "" : c).trim(); return HEX_RE.test(s) ? s : fallback; }

/** #rgb/#rrggbb → 相对亮度，用来给品牌底色配一个读得清的字色 @param {string} hex */
function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
/** 底色深就用白字，浅就用近黑 @param {string} bg */
function contrastFg(bg) { return luminance(bg) > 0.45 ? "#111111" : "#FFFFFF"; }

/**
 * 素材路径 → HTML 里能用的 URL。卡片 HTML 落在 .work 里，工作区里的素材用相对路径；
 * 品牌包在用户目录，只能用 file://。路径里的引号括号都编码掉，不会把 CSS 的 url() 截断
 * @param {string} asset 工作区相对路径或绝对路径
 * @param {string} htmlRel 卡片 HTML 的工作区相对路径
 * @returns {string}
 */
function assetUrl(asset, htmlRel) {
  const a = String(asset || "");
  if (!a) return "";
  if (path.isAbsolute(a) || /^[A-Za-z]:[\\/]/.test(a)) return pathToFileURL(a).href.replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
  const rel = path.posix.relative(path.posix.dirname(htmlRel.replace(/\\/g, "/")), a.replace(/\\/g, "/"));
  return rel.split("/").map((p) => (p === ".." ? p : encodeURIComponent(p))).join("/").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * @typedef {{
 *   w: number, h: number, htmlRel: string,
 *   colors?: {bg?: string, fg?: string, accent?: string},
 *   logo?: string, font?: {file?: string, family?: string} | null,
 *   title?: string, sub?: string,
 * }} CardInput
 */

/** @param {CardInput} o */
function frame(o, body) {
  const bg = color(o.colors && o.colors.bg, DEFAULT_BG);
  const fg = color(o.colors && o.colors.fg, contrastFg(bg.length === 9 ? bg.slice(0, 7) : bg));
  const accent = color(o.colors && o.colors.accent, fg);
  const base = Math.min(o.w, o.h);
  const fontUrl = o.font && o.font.file ? assetUrl(o.font.file, o.htmlRel) : "";
  const face = fontUrl ? `@font-face{font-family:"card-brand";src:url('${fontUrl}');font-display:block}` : "";
  const family = (fontUrl ? `"card-brand",` : "") + SYSTEM_STACK;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
${face}
html,body{margin:0;padding:0;width:${o.w}px;height:${o.h}px;overflow:hidden;background:${bg};}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(base * 0.04)}px;
  color:${fg};font-family:${family};letter-spacing:0;text-align:center;-webkit-font-smoothing:antialiased;}
.logo{max-width:${Math.round(o.w * 0.42)}px;max-height:${Math.round(o.h * 0.22)}px;object-fit:contain;}
.logo.small{max-width:${Math.round(o.w * 0.24)}px;max-height:${Math.round(o.h * 0.1)}px;}
.title{font-size:${Math.round(base * 0.075)}px;font-weight:700;line-height:1.3;max-width:84%;letter-spacing:0;}
.cta{font-size:${Math.round(base * 0.09)}px;font-weight:800;line-height:1.25;max-width:86%;letter-spacing:0;}
.sub{font-size:${Math.round(base * 0.045)}px;line-height:1.4;max-width:80%;opacity:.86;letter-spacing:0;}
.bar{width:${Math.round(base * 0.12)}px;height:${Math.max(2, Math.round(base * 0.008))}px;background:${accent};border-radius:2px;}
</style></head>
<body>
${body}
</body></html>
`;
}

/**
 * 片头卡：品牌色铺底、logo 居中、下面一行片名
 * @param {CardInput} o
 * @returns {string}
 */
function introCardHtml(o) {
  const logo = o.logo ? `<img class="logo" src="${escHtml(assetUrl(o.logo, o.htmlRel))}" alt="">` : "";
  const title = o.title ? `<div class="title">${escHtml(o.title)}</div>` : "";
  return frame(o, [logo, logo && title ? `<div class="bar"></div>` : "", title].filter(Boolean).join("\n"));
}

/**
 * 片尾卡：一句行动号召（扫码领券 / 搜索店名）+ 一行补充 + 小 logo
 * @param {CardInput} o
 * @returns {string}
 */
function outroCardHtml(o) {
  const logo = o.logo ? `<img class="logo small" src="${escHtml(assetUrl(o.logo, o.htmlRel))}" alt="">` : "";
  const cta = o.title ? `<div class="cta">${escHtml(o.title)}</div>` : "";
  const sub = o.sub ? `<div class="sub">${escHtml(o.sub)}</div>` : "";
  return frame(o, [logo, cta, cta && sub ? `<div class="bar"></div>` : "", sub].filter(Boolean).join("\n"));
}

module.exports = { introCardHtml, outroCardHtml, escHtml, assetUrl, contrastFg, _internals: { color, luminance, HEX_RE } };
