"use strict";
/**
 * 前端测试 — 在 Electron 的真 Chromium 里跑，验证 public/svgfig.js。
 * SVG 清洗要的是"浏览器真正解析出来的树"，用正则或者假 DOM 测等于没测，
 * 所以这里借项目已有的 electron 开一个隐藏窗口，把断言放进渲染进程执行。
 * 由 test/e2e.js 拉起；electron 没装（纯服务端部署）就整体跳过。
 * 单独运行：npx electron test/frontend.js
 */

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

const SVGFIG = fs.readFileSync(path.join(__dirname, "..", "public", "svgfig.js"), "utf8");

// 在渲染进程里跑的断言体。返回通过的用例名数组，抛错则整体失败。
const CHECKS = `(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const F = window.SvgFig;
  const parse = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };

  // ---- 1. 正常一张图：被抠成占位符，卡片结构齐全 ----
  {
    const r = F.extractSvgFigures('前言\\n<svg viewBox="0 0 100 50"><text x="5" y="20">你好</text></svg>\\n后语');
    ok("完整 SVG 抠成占位符", r.figs.length === 1 && /\\u0000SVG0\\u0000/.test(r.text) && !/<svg/i.test(r.text));
    const d = parse(r.figs[0]);
    ok("卡片结构齐全", d.querySelector(".svg-fig .svg-body svg") && d.querySelectorAll(".svg-acts button").length === 3);
    ok("viewBox 图强制自适应宽度", d.querySelector("svg").getAttribute("width") === "100%" && !d.querySelector("svg").getAttribute("height"));
    ok("原文留在 data-src 里", (d.querySelector(".svg-fig").dataset.src || "").includes("<text"));
  }

  // ---- 2. \`\`\`svg 围栏 ----
  {
    const r = F.extractSvgFigures("说明\\n\\\`\\\`\\\`svg\\n<svg viewBox=\\"0 0 10 10\\"><circle r=\\"3\\"/></svg>\\n\\\`\\\`\\\`\\n收尾");
    ok("svg 围栏当图渲染", r.figs.length === 1 && !/\\\`\\\`\\\`/.test(r.text));
  }

  // ---- 3. 普通代码块里的 <svg> 不能被画出来 ----
  {
    const src = "教学：\\n\\\`\\\`\\\`html\\n<div><svg viewBox=\\"0 0 9 9\\"></svg></div>\\n\\\`\\\`\\\`\\n完";
    const r = F.extractSvgFigures(src);
    ok("代码块里的 SVG 不当图", r.figs.length === 0 && r.text === src);
  }

  // ---- 4. 流式：半截 SVG 也能渲染，且带"绘制中" ----
  {
    const partial = '开头\\n<svg viewBox="0 0 100 50"><text x="5" y="20">半截</text><rect wid';
    const r = F.extractSvgFigures(partial);
    ok("半截 SVG 也出图", r.figs.length === 1);
    const d = parse(r.figs[0]);
    ok("半截图标出绘制中", !!d.querySelector(".svg-acts .growing"));
    ok("半截图内容已渲染", d.querySelector("svg text") && d.querySelector("svg text").textContent === "半截");
    ok("吐到一半的标签被丢掉", !d.querySelector("svg rect"));
  }

  // ---- 5. 逐字流式：每一帧都不能崩，且帧数越多内容越全 ----
  {
    const full = '<svg viewBox="0 0 200 80"><style>.t{font-size:12px}</style><text class="t" x="4" y="20">增长中</text><text x="4" y="40">第二行</text></svg>';
    let rendered = 0;
    for (let i = 10; i <= full.length; i += 7) {
      const r = F.extractSvgFigures(full.slice(0, i));
      if (r.figs.length) { parse(r.figs[0]); rendered++; }
    }
    ok("逐字流式全程不崩", rendered > 10, "只成功渲染了 " + rendered + " 帧");
    const fin = parse(F.extractSvgFigures(full).figs[0]);
    ok("收尾后两行文字都在", fin.querySelectorAll("svg text").length === 2);
  }

  // ---- 6. 安全：脚本/事件/外链一律清掉 ----
  {
    const evil = '<svg viewBox="0 0 10 10" onload="window.__pwned=1">' +
      '<script>window.__pwned=2<\\/script>' +
      '<foreignObject><body>x</body></foreignObject>' +
      '<image href="https://evil.example/track.png" x="0" y="0"/>' +
      '<a xlink:href="javascript:alert(1)"><text>点我</text></a>' +
      '<rect fill="url(https://evil.example/f.svg#g)"/>' +
      '<circle fill="url(#localGrad)"/></svg>';
    const d = parse(F.extractSvgFigures(evil).figs[0]);
    const svg = d.querySelector("svg");
    ok("script 被清掉", !svg.querySelector("script"));
    ok("foreignObject 被清掉", !svg.querySelector("foreignObject"));
    ok("on* 事件被清掉", !svg.getAttribute("onload") && ![...svg.querySelectorAll("*")].some(n => [...n.attributes].some(a => a.name.toLowerCase().startsWith("on"))));
    ok("外链图片被清掉", !svg.querySelector("image[href], image[xlink\\\\:href]"));
    ok("javascript: 链接被清掉", ![...svg.querySelectorAll("a")].some(a => /javascript/i.test(a.getAttribute("xlink:href") || a.getAttribute("href") || "")));
    ok("外链 url() 被清掉", !/evil\\.example/.test(svg.outerHTML));
    ok("图内 url(#id) 保留", svg.querySelector("circle").getAttribute("fill") === "url(#localGrad)");
    ok("没有真的执行到脚本", !window.__pwned);
  }

  // ---- 7. <style> 必须限死在这张图里（模型爱用 .t / .ts 这种通名）----
  {
    const a = F.extractSvgFigures('<svg viewBox="0 0 10 10"><style>.t{fill:#f00}.a,.b{fill:#0f0}</style><text class="t">x</text></svg>');
    const css = parse(a.figs[0]).querySelector("style").textContent;
    ok("style 选择器带上了图 id", /#svgfig\\d+ \\.t\\s*\\{/.test(css) && /#svgfig\\d+ \\.a,#svgfig\\d+ \\.b\\{/.test(css), css);
    ok("scopeCss 不动 @规则", /@media/.test(F.scopeCss("@media (a){.x{c:1}}", "#z")));
    // 真挂进页面，确认没污染到外面同名元素
    const probe = document.createElement("div");
    probe.className = "t";
    probe.textContent = "界面自己的元素";
    document.body.appendChild(probe);
    const host = document.createElement("div");
    host.innerHTML = a.figs[0];
    document.body.appendChild(host);
    ok("没污染页面上的同名 class", getComputedStyle(probe).fill !== "rgb(255, 0, 0)");
    ok("图里的元素确实吃到了样式", getComputedStyle(host.querySelector("svg text")).fill === "rgb(255, 0, 0)");
    host.remove(); probe.remove();
  }

  // ---- 8. 每张图的 id 唯一，两张图的同名 class 不串 ----
  {
    const one = F.extractSvgFigures('<svg viewBox="0 0 10 10"><style>.t{fill:#00f}</style><text class="t">A</text></svg>').figs[0];
    const two = F.extractSvgFigures('<svg viewBox="0 0 10 10"><style>.t{fill:#0f0}</style><text class="t">B</text></svg>').figs[0];
    ok("两张图 id 不同", parse(one).querySelector("svg").id !== parse(two).querySelector("svg").id);
  }

  // ---- 9. 不是 SVG 的东西原样放过 ----
  {
    const src = "普通回复，包含 <div> 和 1 < 2 这种字符。";
    const r = F.extractSvgFigures(src);
    ok("非 SVG 正文不动", r.figs.length === 0 && r.text === src);
  }

  // ---- 10. 导出 PNG：var(--x) 要在导出时解析成实际色值 ----
  {
    document.documentElement.style.setProperty("--color-text-primary", "#123456");
    const host = document.createElement("div");
    host.innerHTML = F.extractSvgFigures('<svg viewBox="0 0 40 20"><text x="2" y="12" fill="var(--color-text-primary)">导出</text></svg>').figs[0];
    document.body.appendChild(host);
    return F.svgToPngDataUrl(host.querySelector("svg"), 1).then((url) => {
      ok("导出的是 PNG data URL", /^data:image\\/png;base64,/.test(url) && url.length > 200);
      host.remove();
      return names;
    });
  }
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
  let code = 0;
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><meta charset='utf-8'><body></body>"));
    await win.webContents.executeJavaScript(SVGFIG);
    const names = await win.webContents.executeJavaScript(CHECKS, true);
    for (const n of names) console.log("  ✓ " + n);
    console.log(`✅ 前端：内联 SVG 信息图（渲染/流式/清洗/作用域/导出）${names.length} 项通过`);
  } catch (e) {
    console.error("❌ 前端测试失败:", e && e.message ? e.message : e);
    code = 1;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.exit(code);
  }
});
