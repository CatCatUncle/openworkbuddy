// ================= 内联 SVG 信息图（流式） =================
// 模型直接在正文里画 <svg>，界面当图渲染而不是当代码贴出来。流式输出时 SVG 是一点点吐出来的，
// 把半截内容补全再渲染，就能看着图自己长出来——比对着满屏尖括号干等强得多。
//
// 单独成文件是为了能在 Electron 里跑真 DOM 测试（test/frontend.js），
// 不用把整个 index.html 连同它的 fetch/WebSocket 一起拉起来。
(function (root) {
  let seq = 0;

  /** 半截 SVG 补成能渲染的样子：切回最后一个完整标签，再把还开着的 style/svg 闭上 */
  function repairPartialSvg(code) {
    let s = String(code || "");
    const lastGt = s.lastIndexOf(">");
    const lastLt = s.lastIndexOf("<");
    if (lastLt > lastGt) s = s.slice(0, lastLt); // 正吐到一半的标签整个丢掉，别渲染出畸形节点
    const opens = (s.match(/<style[\s>]/gi) || []).length;
    const closes = (s.match(/<\/style>/gi) || []).length;
    if (opens > closes) s += "</style>";
    return s + "</svg>";
  }

  /** 把 CSS 每条规则的选择器前面加上作用域前缀 */
  function scopeCss(css, prefix) {
    return String(css || "").replace(/(^|\})([^{}]*)\{/g, (m, close, sel) => {
      const list = sel.split(",").map((x) => x.trim()).filter(Boolean);
      if (!list.length) return m;
      return close + list.map((x) => (x.startsWith("@") ? x : `${prefix} ${x}`)).join(",") + "{";
    });
  }

  /**
   * 清洗并作用域化一段 SVG。返回 null 表示这段根本不是 SVG。
   * 三件事：① 砍掉能跑代码/发外链的东西；② 把 <style> 限死在这张图里；③ 强制自适应宽度。
   */
  function sanitizeSvg(code) {
    const holder = document.createElement("div");
    holder.innerHTML = String(code || ""); // HTML 解析器很宽容，缺闭合标签会自动补
    const svg = holder.querySelector("svg");
    if (!svg) return null;
    svg.querySelectorAll("script,foreignObject,iframe,object,embed,link,meta,audio,video,handler,animation").forEach((n) => n.remove());
    const uid = "svgfig" + ++seq;
    for (const n of [svg, ...svg.querySelectorAll("*")]) {
      for (const a of [...n.attributes]) {
        const name = a.name.toLowerCase();
        const val = String(a.value || "");
        if (name.startsWith("on")) n.removeAttribute(a.name);
        // 引用只准指向图内部（#id）。外链图片/字体会把"用户看了这张图"这件事悄悄发出去
        else if ((name === "href" || name === "xlink:href" || name === "src") && !val.trim().startsWith("#")) n.removeAttribute(a.name);
        else if (/url\(\s*['"]?(?!#)/i.test(val)) n.removeAttribute(a.name);
        else if (/^\s*(javascript|data:text\/html)/i.test(val)) n.removeAttribute(a.name);
      }
    }
    // 内联 SVG 里的 <style> 是对整个页面生效的。模型爱用 .t / .ts 这种通名，
    // 不限定作用域会顺手把界面自己的元素一起改了。
    svg.querySelectorAll("style").forEach((st) => { st.textContent = scopeCss(st.textContent, "#" + uid); });
    svg.id = uid;
    if (svg.getAttribute("viewBox")) { svg.setAttribute("width", "100%"); svg.removeAttribute("height"); }
    return svg.outerHTML;
  }

  const escAttr = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /**
   * 一张图的完整卡片 HTML。
   *
   * growing=true 表示这段 SVG 没闭合，先补全再渲染。
   * live=true 才是「这会儿还在往外吐字」——只有这时候才配说「绘制中」。
   *
   * 以前 growing 一路直通那枚闪烁的「绘制中」：模型把闭合标签写漏了（或者话没说完就被截断），
   * 这张图在回合结束之后、乃至每一次回放历史的时候，都还永远挂着「绘制中」在那儿闪。
   * 用户原话：「怎么一直在绘制中，对话都结束了，这是卡住了啊」——他以为整个 agent 卡死了。
   * 停笔之后它就是一张没画完的图：静静说一句实话，别再装作还在动。
   */
  function svgFigureHtml(code, growing, live) {
    const clean = sanitizeSvg(growing ? repairPartialSvg(code) : code);
    if (!clean) return null;
    const note = !growing ? ""
      : live ? '<span class="growing">绘制中</span>'
      : '<span class="partial" title="这段 SVG 少了闭合标签，画出来的是补全后的样子">图没画完</span>';
    return (
      `<div class="svg-fig" data-src="${escAttr(code)}">` +
      // 图本身可点：在对话里图被挤成一小条，细节根本看不清，点一下就铺满屏
      `<div class="svg-body" data-a="svg-zoom" title="点开看大图">${clean}</div>` +
      `<div class="svg-acts">${note}` +
      `<button data-a="svg-zoom">放大看</button><button data-a="svg-code">看源码</button>` +
      `<button data-a="svg-save">存矢量图</button><button data-a="svg-png">存图片</button>` +
      `<button data-a="svg-as">另存为…</button></div></div>`
    );
  }

  /**
   * 一段东西到底是不是"图"：光有个 <svg> 壳、里面一个子元素都没有的，
   * 多半是正文在讲 SVG 这个标签本身，不是真要画图
   */
  function hasFigureBody(code) {
    return /<[A-Za-z]/.test(String(code || "").replace(/^\s*<svg[^>]*>/i, ""));
  }

  // 不该被当成图画出来的片段：``` 围栏（含流式还没闭合的）、以及行内代码 `…`。
  // 行内代码这条是补的：正文里写一句"图以 `<svg>` 内联"，之前会把这个 <svg> 当成
  // 一张正在流式输出的图，从它往后的正文整段被吞掉，界面上只剩一个"绘制中"的空框
  const SKIP = "```[\\s\\S]*?```|```[\\s\\S]*$|``[^\\n]*?``|`[^`\\n]*`";

  /**
   * 把正文里的 SVG 换成占位符 \x00SVG<n>\x00，返回 { text, figs }。
   * 三种形态都认：完整 ```svg 围栏、裸 <svg>…</svg>、以及流式还没闭合的那一段。
   * 带 skip 分组的两条是为了跳过代码块和行内代码——讲解 SVG 语法的例子不该被画出来。
   */
  function extractSvgFigures(src, live) {
    const figs = [];
    const push = (code, growing) => {
      if (!hasFigureBody(code)) return null;
      const html = svgFigureHtml(code, growing, live);
      if (!html) return null;
      figs.push(html);
      return `\n\x00SVG${figs.length - 1}\x00\n`;
    };
    const keep = (m, skip, growing) => skip ?? (push(m, growing) ?? m);
    let s = String(src || "");
    s = s.replace(/```svg[^\S\n]*\n([\s\S]*?)```/gi, (m, body) => push(body.trim(), false) ?? m);
    s = s.replace(/```svg[^\S\n]*\n([\s\S]*)$/i, (m, body) => push(body.trim(), true) ?? m);
    // 闭合标签写成 </svg > 也算闭合。差这一个空格，整张图就会被下一条当成「还没写完」，
    // 回合结束后永远挂着「绘制中」在闪——用户看到的是「卡住了」
    s = s.replace(new RegExp("(" + SKIP + ")|<svg[\\s>][\\s\\S]*?<\\/\\s*svg\\s*>", "gi"), (m, skip) => keep(m, skip, false));
    s = s.replace(new RegExp("(" + SKIP + ")|<svg[\\s>][\\s\\S]*$", "gi"), (m, skip) => keep(m, skip, true));
    return { text: s, figs };
  }

  /**
   * SVG → PNG：画进 canvas 再导出。var(--x) 要在这里就地解析成当前主题的实际值，
   * 字体也要内联——脱离页面后这些都没人给它兜底，中文会掉成豆腐块。
   */
  function svgToPngDataUrl(svgEl, scale = 2) {
    return new Promise((resolve, reject) => {
      const clone = svgEl.cloneNode(true);
      const rootStyle = getComputedStyle(document.documentElement);
      const fill = (s) => String(s).replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g, (_, name, dflt) =>
        rootStyle.getPropertyValue(name).trim() || (dflt || "").trim() || "#333");
      for (const el of [clone, ...clone.querySelectorAll("*")]) {
        for (const a of [...el.attributes]) if (a.value.includes("var(")) el.setAttribute(a.name, fill(a.value));
      }
      clone.querySelectorAll("style").forEach((st) => { st.textContent = fill(st.textContent); });
      clone.setAttribute("style", `font-family:${getComputedStyle(svgEl).fontFamily}`);
      const vb = (svgEl.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
      const w = vb[2] || svgEl.clientWidth || 800;
      const h = vb[3] || svgEl.clientHeight || 600;
      clone.setAttribute("width", w);
      clone.setAttribute("height", h);
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = Math.round(w * scale);
        cv.height = Math.round(h * scale);
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("浏览器画不出这张图"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    });
  }

  root.SvgFig = { repairPartialSvg, scopeCss, sanitizeSvg, svgFigureHtml, extractSvgFigures, hasFigureBody, svgToPngDataUrl };
})(window);
