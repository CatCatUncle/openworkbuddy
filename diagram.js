"use strict";
/**
 * 文本 → 图 渲染中枢（gen_diagram 工具的实现）。
 * 五种输入，统一产出 SVG，环境允许时再产出 PNG（飞书/Word 只收 PNG/JPG）：
 *  - echarts：官方 SSR（renderToSVGString），纯 Node 离线
 *  - dot：@viz-js/viz（Graphviz 的 WASM 编译），纯 Node 离线
 *  - mermaid：Electron 隐藏窗口离线渲染；node 直跑时降级到 kroki 在线
 *  - plantuml：本机 plantuml 命令 → config.diagram.plantuml_server → kroki，三级尝试
 *  - svg：直传校验 + 转 PNG
 * SVG→PNG：Electron 隐藏窗口截图；否则找本机 Chrome 无头截图；都没有就只交付 SVG。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const vm = require("vm");
const { spawnSync } = require("child_process");
const browserRender = require("./browser-render");

function diagramCfg() {
  try {
    return (JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")).diagram) || {};
  } catch {
    return {};
  }
}

// ---------- PlantUML 服务器 URL 编码（deflate + PlantUML 自家 base64 字母表，借鉴 plantuml-encoder） ----------
const P64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
function plantumlEncode(text) {
  const data = zlib.deflateRawSync(Buffer.from(text, "utf8"), { level: 9 });
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i], b2 = i + 1 < data.length ? data[i + 1] : 0, b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += P64[b1 >> 2] + P64[((b1 & 3) << 4) | (b2 >> 4)] + P64[((b2 & 15) << 2) | (b3 >> 6)] + P64[b3 & 63];
  }
  return out;
}

// ---------- echarts：option 收 JSON 或 JS 对象字面量（模型爱写后者），字面量在无权限沙箱里求值 ----------
function renderECharts(source, width, height) {
  let option;
  try {
    option = JSON.parse(source);
  } catch {
    try {
      option = vm.runInNewContext("(" + source + ")", Object.create(null), { timeout: 2000 });
    } catch (e) {
      throw new Error(`echarts option 解析失败（${e.message}）：传 option 的 JSON 或 JS 对象字面量，不要带 echarts.init 等代码`);
    }
  }
  if (!option || typeof option !== "object" || Array.isArray(option)) throw new Error("echarts source 必须是 option 对象");
  const echarts = require("echarts");
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: width || 800, height: height || 500 });
  try {
    chart.setOption({ animation: false, ...option });
    return chart.renderToSVGString();
  } finally {
    chart.dispose(); // SSR 图不销毁会留着动画定时器，进程/任务就挂住了
  }
}

// ---------- dot：WASM 实例只初始化一次 ----------
let vizPromise = null;
async function renderDot(source) {
  if (!vizPromise) vizPromise = require("@viz-js/viz").instance();
  const viz = await vizPromise;
  return viz.renderString(source, { format: "svg" });
}

// ---------- plantuml：本机命令 → 配置的服务器 → kroki ----------
async function renderPlantuml(source, fmt) {
  const src = /^\s*@start/.test(source) ? source : `@startuml\n${source}\n@enduml`;
  const local = spawnSync("plantuml", [`-t${fmt}`, "-pipe", "-charset", "UTF-8"], {
    input: src, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
  });
  if (!local.error && local.status === 0 && local.stdout && local.stdout.length > 100) return local.stdout;
  const cfg = diagramCfg();
  const servers = [];
  if (cfg.plantuml_server) servers.push({ type: "plantuml", url: cfg.plantuml_server });
  servers.push({ type: "plantuml", url: "https://www.plantuml.com/plantuml" });
  servers.push({ type: "kroki", url: cfg.kroki_server || "https://kroki.io" });
  let lastErr = "";
  for (const s of servers) {
    try {
      const base = s.url.replace(/\/+$/, "");
      const resp = s.type === "plantuml"
        ? await fetch(`${base}/${fmt}/${plantumlEncode(src)}`, { signal: AbortSignal.timeout(20000) })
        : await fetch(`${base}/plantuml/${fmt}`, { method: "POST", body: src, headers: { "Content-Type": "text/plain" }, signal: AbortSignal.timeout(20000) });
      if (!resp.ok) { lastErr = `${base} HTTP ${resp.status}`; continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 50) return buf;
      lastErr = `${base} 返回内容异常`;
    } catch (e) {
      lastErr = `${s.url} ${e.message}`;
    }
  }
  throw new Error(
    `PlantUML 渲染失败：本机没装 plantuml 命令，在线服务也没通（${lastErr}）。` +
      `可 brew install plantuml 后离线用，或在设置里配自建服务；UML 类图/时序图也可以改用 mermaid 画`
  );
}

// ---------- kroki 渲染 mermaid（node 直跑、没有 Electron 窗口时的在线降级） ----------
async function krokiRender(diagramType, source, fmt) {
  const base = (diagramCfg().kroki_server || "https://kroki.io").replace(/\/+$/, "");
  const resp = await fetch(`${base}/${diagramType}/${fmt}`, {
    method: "POST", body: source, headers: { "Content-Type": "text/plain" }, signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`kroki HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ---------- SVG → PNG：Electron 截图 → 本机 Chrome 无头截图 → 放弃（只交付 SVG） ----------
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  // Windows：Chrome 两个惯常位置 + Edge（自带且同为 Chromium，无头截图参数一致）
  (process.env["ProgramFiles"] || "C:\\Program Files") + "\\Google\\Chrome\\Application\\chrome.exe",
  (process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)") + "\\Google\\Chrome\\Application\\chrome.exe",
  (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
  (process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)") + "\\Microsoft\\Edge\\Application\\msedge.exe",
];
async function svgToPngAnyhow(svg) {
  if (browserRender.available()) {
    try { return { png: await browserRender.svgToPng(svg), via: "electron" }; } catch {}
  }
  const chrome = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (chrome) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-svg2png-"));
    try {
      const { w, h } = browserRender.svgSize(svg);
      const htmlFile = path.join(dir, "d.html");
      const pngFile = path.join(dir, "d.png");
      fs.writeFileSync(
        htmlFile,
        `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}svg{display:block;width:${w}px;height:${h}px}</style><body>${svg}`
      );
      const r = spawnSync(chrome, [
        "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
        `--screenshot=${pngFile}`, `--window-size=${Math.ceil(w)},${Math.ceil(h)}`, `file://${htmlFile}`,
      ], { timeout: 30000 });
      if (!r.error && fs.existsSync(pngFile)) return { png: fs.readFileSync(pngFile), via: "chrome" };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
  return { png: null, via: "" };
}

function looksLikeSvg(s) {
  const t = String(s || "").trim();
  return t.includes("<svg") && t.includes("</svg>");
}

/**
 * 统一入口。
 * @param {{kind:string, source:string, width?:number, height?:number, theme?:string}} p
 * @returns {Promise<{svg:string, png:Buffer|null, note:string}>}
 */
async function renderDiagram({ kind, source, width, height, theme }) {
  const k = String(kind || "").toLowerCase();
  const src = String(source || "").trim();
  if (!src) throw new Error("source 不能为空");
  let svg = null, png = null, note = "";

  if (k === "echarts") {
    svg = renderECharts(src, +width || 0, +height || 0);
  } else if (k === "dot" || k === "graphviz") {
    svg = await renderDot(src);
  } else if (k === "mermaid") {
    if (browserRender.available()) {
      svg = await browserRender.renderMermaid(src, theme);
    } else {
      try {
        svg = (await krokiRender("mermaid", src, "svg")).toString("utf8");
        note = "mermaid 走了 kroki 在线渲染（桌面应用内会用本地渲染）";
      } catch (e) {
        throw new Error(`mermaid 需要在桌面应用（npm run app）内离线渲染，kroki 在线降级也失败了（${e.message}）。流程/架构图可改用 kind:"dot"（离线可用）`);
      }
    }
  } else if (k === "plantuml") {
    svg = (await renderPlantuml(src, "svg")).toString("utf8");
    try { png = await renderPlantuml(src, "png"); } catch {}
  } else if (k === "svg") {
    if (!looksLikeSvg(src)) throw new Error("kind:svg 时 source 必须是完整的 <svg>…</svg> 内容");
    svg = src;
  } else {
    throw new Error(`不认识的图类型: ${kind}（可选 mermaid / dot / echarts / plantuml / svg）`);
  }

  if (!looksLikeSvg(svg)) throw new Error("渲染结果不是有效 SVG（图源码可能有语法错误）");
  if (!png) {
    const r = await svgToPngAnyhow(svg);
    png = r.png;
    if (!png) note = (note ? note + "；" : "") + "本环境无法转 PNG（桌面应用内或装了 Chrome 才行），已交付 SVG";
  }
  return { svg, png, note };
}

module.exports = { renderDiagram, plantumlEncode, renderECharts, renderDot, looksLikeSvg, svgToPngAnyhow };
