/* ============================================================================
 * app-00-ui.js —— 界面底层小工具，排在 app-01 之前，后面所有模块直接用
 *   ic(name)  取一个 lucide 图标（sprite 在 index.html 顶部，离线可用）
 *   tooltip   顶掉浏览器原生 title
 * ========================================================================== */

/** 取一个 lucide 图标的内联 svg。name 见 index.html 里 #wb-sprite 的 symbol id */
function ic(name, cls) {
  return `<svg class="i${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/* 自建 tooltip 顶掉原生 title：原生那个要悬停一秒才出来，出来是一坨系统灰框，
   成果卡上那种长路径会直接糊掉半张卡。这里 380ms 出、跟着目标走、贴不下就翻到下方。
   不改任何标记——鼠标扫过时把 title 就地搬进 data-tip，动态插入的节点一样吃得到。 */
(function () {
  let tipEl = null, timer = null, cur = null;

  function ensure() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "ui-tooltip";
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function place(target) {
    const t = ensure();
    const r = target.getBoundingClientRect();
    const b = t.getBoundingClientRect();
    let top = r.top - b.height - 8;
    if (top < 6) top = r.bottom + 8;                                  // 上面塞不下就翻到下面
    let left = r.left + r.width / 2 - b.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - b.width - 6)); // 别顶出屏幕
    t.style.top = `${Math.round(top)}px`;
    t.style.left = `${Math.round(left)}px`;
  }

  function hide() {
    clearTimeout(timer);
    cur = null;
    if (tipEl) tipEl.classList.remove("show");
  }

  function show(target, text) {
    const t = ensure();
    cur = target;
    t.textContent = text;
    t.style.top = "-9999px";
    t.classList.add("show");
    place(target);
  }

  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest && e.target.closest("[title],[data-tip]");
    if (!el) return;
    if (el.hasAttribute("title")) {
      // 搬家而不是复制：留着 title 的话原生框还会照样弹出来，变成两个提示叠着
      const raw = el.getAttribute("title");
      el.removeAttribute("title");
      if (raw) el.dataset.tip = raw;
    }
    const text = el.dataset.tip;
    if (!text || el === cur) return;
    clearTimeout(timer);
    timer = setTimeout(() => show(el, text), 380);
  });

  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest && e.target.closest("[data-tip]");
    if (el && el === cur) hide();
    else if (el) clearTimeout(timer);
  });
  // 点一下就把提示收走：点完按钮还挂着一条说明，看着像卡住了
  document.addEventListener("mousedown", hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
})();
