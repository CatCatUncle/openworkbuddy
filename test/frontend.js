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

// 附件（粘贴/拖拽：文件、图片、大段文字）用的是 app-02.js 里那一段真源码——
// 抄一份到测试里只能证明抄的那份是对的。段落靠标题定位，标题被改了就当场报错，不许静默跳过。
const APP02 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
const A0 = APP02.indexOf("// ================= ＋ 上传文件到工作空间");
const A1 = APP02.indexOf("// ================= 会话历史");
if (A0 < 0 || A1 <= A0) throw new Error("app-02.js 里的附件段找不到了（段标题被改过？），前端测试没法定位真源码");
const ATTACH_SRC = APP02.slice(A0, A1);

const ATTACH_HTML =
  "<!doctype html><meta charset='utf-8'><body>" +
  "<div class='input-card'><div id='attach-chips'></div><textarea id='input'></textarea></div>" +
  "<button id='attach-btn'></button><input type='file' id='file-input'></body>";

// 页面里其他文件提供的东西，在这儿给最小替身；网络请求全部截下来当证据
const ATTACH_STUBS = [
  "window.uploads = []; window.toasts = [];",
  "window.fetch = async (url, init) => {",
  "  if (url === '/api/upload') { window.uploads.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }",
  "  return { ok: true, json: async () => [] };",
  "};",
  "window.toast = (m) => window.toasts.push(m);",
  "window.renderFiles = () => {};",
  "window.syncInputHl = () => {};",
  "window.inputEl = document.getElementById('input');",
].join("\n");

const ATTACH_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const chips = () => [...document.getElementById("attach-chips").children];
  const B64PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const fire = (target, type, key, data) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, key, { value: data });
    target.dispatchEvent(ev);
    return ev;
  };

  // ---- 1. 粘贴截图：存进工作空间、chip 带缩略图、二进制一个字节都不能变 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([bytes(B64PNG)], "image.png", { type: "image/png" }));
    const ev = fire(document.body, "paste", "clipboardData", dt);
    await tick();
    const up = uploads.at(-1);
    ok("粘贴截图会上传", !!up, "根本没发上传请求");
    ok("剪贴板的通用名换成时间戳", /^粘贴图片_\\d{4}_\\d{6}\\.png$/.test(up.name), up.name);
    ok("图片二进制没被改坏", up.data_b64 === B64PNG);
    ok("chip 带缩略图", !!document.querySelector("#attach-chips img.attach-thumb"));
    ok("粘贴被接管（没再往输入框里塞）", ev.defaultPrevented);
  }

  // ---- 2. 同一秒连贴两张：撞名要编号，不能悄悄覆盖掉第一张 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([bytes(B64PNG)], "image.png", { type: "image/png" }));
    fire(document.body, "paste", "clipboardData", dt);
    await tick();
    const [a, b] = uploads.slice(-2).map((u) => u.name);
    ok("连贴两张不互相覆盖", a !== b, a + " / " + b);
    ok("两张各挂一个 chip", chips().length === 2, "chip 数=" + chips().length);
  }

  // ---- 3. 短文本照常粘进输入框，别多管闲事 ----
  {
    const before = uploads.length;
    const dt = new DataTransfer();
    dt.setData("text/plain", "帮我改一下标题");
    const ev = fire(inputEl, "paste", "clipboardData", dt);
    await tick();
    ok("短文本不当附件", !ev.defaultPrevented && uploads.length === before);
  }

  // ---- 4. 大段文字：落成 txt 附件，输入框不被撑爆，中文不能乱码 ----
  {
    const big = "第一行是报错：\\n" + "巨长的日志".repeat(600);
    inputEl.value = "帮我看看这个";
    const dt = new DataTransfer();
    dt.setData("text/plain", big);
    const ev = fire(inputEl, "paste", "clipboardData", dt);
    await tick();
    const up = uploads.at(-1);
    ok("大段文字落成 txt", /^粘贴文本_\\d{4}_\\d{6}\\.txt$/.test(up.name), up.name);
    const back = new TextDecoder().decode(bytes(up.data_b64));
    ok("中文原文一字不差", back === big, "长度 " + back.length + " vs " + big.length);
    ok("输入框没被撑爆", inputEl.value === "帮我看看这个" && ev.defaultPrevented);
    ok("chip 上能看见开头几个字", /第一行是报错/.test(chips().at(-1).title || ""));
  }

  // ---- 5. 拖文件进窗口 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode("hello")], "笔记.md", { type: "text/markdown" }));
    fire(document.body, "drop", "dataTransfer", dt);
    await tick();
    ok("拖进来的文件按原名上传", uploads.at(-1).name === "笔记.md", uploads.at(-1).name);
  }

  // ---- 6. 拖一小段选中的文字：插在光标处，别把写了一半的话顶到后面 ----
  {
    inputEl.value = "开头结尾";
    inputEl.selectionStart = inputEl.selectionEnd = 2;
    const before = uploads.length;
    const dt = new DataTransfer();
    dt.setData("text/plain", "插进来");
    fire(document.body, "drop", "dataTransfer", dt);
    await tick();
    ok("拖进来的短文字插在光标处", inputEl.value === "开头插进来结尾", inputEl.value);
    ok("短文字不当附件", uploads.length === before);
  }

  // ---- 7. 拖一大段文字：和粘贴走同一条路 ----
  {
    const dt = new DataTransfer();
    dt.setData("text/plain", "整篇文档".repeat(700));
    fire(document.body, "drop", "dataTransfer", dt);
    await tick();
    ok("拖进来的大段文字也落成 txt", /^粘贴文本_\\d{4}_\\d{6}(-\\d+)?\\.txt$/.test(uploads.at(-1).name), uploads.at(-1).name);
  }

  // ---- 8. 发消息时附件名随消息一起走，输入框里永远不出现这些标记 ----
  {
    const n = chips().length;
    const out = composeOutgoing();
    ok("附件名拼进了消息", (out.match(/已上传文件：/g) || []).length === 1 && n > 0);
    ok("发完 chip 清空", chips().length === 0);
  }
  return names;
})()`;


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

  // ---- 3b. 行内代码里提到 <svg> 也不能被画出来 ----
  // 用户报的真实现象：正文写"图以 \`<svg>\` 内联"，界面把这个 <svg> 当成一张正在流式输出的图，
  // 从它往后的正文整段被吞掉，只剩一个"绘制中"的空框
  {
    const src = '报告里无任何 \`src="*.svg"\` 外链引用，图以 \`<svg>\` 内联。\\n\\n下一段正文还在。';
    const r = F.extractSvgFigures(src);
    ok("行内代码里的 <svg> 不当图", r.figs.length === 0 && r.text === src);
  }
  {
    const src = '写法是 \`<svg viewBox="0 0 680 400">\`，别写死宽高。';
    const r = F.extractSvgFigures(src);
    ok("行内代码里带属性的 <svg> 也不当图", r.figs.length === 0 && r.text === src);
  }
  {
    const src = "空壳 <svg></svg> 不算图";
    const r = F.extractSvgFigures(src);
    ok("一个子元素都没有的 <svg> 不当图", r.figs.length === 0 && r.text === src);
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

    // 附件那一段要在干净的 DOM 里跑：真源码里有 document 级监听，和上面的用例混在一起会互相打架
    const win2 = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win2.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ATTACH_HTML));
      // 替身 + 真源码 + 断言必须是同一段脚本：源码里的 const 是脚本级作用域，分两次注入就互相看不见了
      const names2 = await win2.webContents.executeJavaScript(ATTACH_STUBS + "\n" + ATTACH_SRC + "\n" + ATTACH_CHECKS, true);
      for (const n of names2) console.log("  ✓ " + n);
      console.log(`✅ 前端：粘贴/拖拽附件（截图·文件·大段文字）${names2.length} 项通过`);
    } finally {
      if (!win2.isDestroyed()) win2.destroy();
    }
  } catch (e) {
    console.error("❌ 前端测试失败:", e && e.message ? e.message : e);
    code = 1;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.exit(code);
  }
});
