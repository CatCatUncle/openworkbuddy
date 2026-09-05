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

/** div 当按钮用时补齐键盘语义：Tab 能停、Enter/空格等价于点击、读屏念得出是个按钮 */
function markActivatable(el) {
  if (!el) return el;
  if (el.tabIndex < 0) el.tabIndex = 0;
  el.dataset.activate = "1"; // 键盘处理认这个标记，不认 role——见下面为什么 role 不能一律加
  // 成果卡这类元素自己带着「预览 / 打开位置 / 下载」几个真按钮，外层再声明 role="button"
  // 就成了按钮套按钮，读屏会把里面那几个吞掉。有交互子元素时只给焦点，不动语义。
  if (!el.getAttribute("role") && !el.querySelector("a[href],button,input,select,textarea")) {
    el.setAttribute("role", "button");
  }
  return el;
}

/** 绑点击事件的同时把上面那套补上。凡是 `x.onclick = fn` 的 div，都该换成这个 */
function onActivate(el, fn) {
  if (!el) return el;
  el.onclick = fn;
  return markActivatable(el);
}

/* 键盘可达：侧栏的会话、项目、导航项全是 <div>，鼠标能点、Tab 走不到。
   实测这一屏 198 个"看着能点"（cursor:pointer）的元素里有 30 个键盘够不着，
   其中就包括切会话和切项目这两件最常做的事——纯键盘用户根本换不了会话。
   这里不动任何渲染代码，只给侧栏那几类行补 tabindex/role，并把 Enter/空格映射成 click。
   只观察侧栏容器：正文那片在流式输出时每个 token 都在动，往那儿挂 MutationObserver 是纯浪费。 */
(function () {
  const SEL = ".hist-item, .proj-item, .side-nav .item";
  function arm() {
    document.querySelectorAll(SEL).forEach(markActivatable);
  }
  // 正文那片不挂观察器（流式输出时每个 token 都在动），改由 onActivate 在生成处就地补上
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = document.activeElement;
    if (!el || !el.matches || !el.matches('[data-activate="1"]')) return;
    e.preventDefault(); // 空格默认是翻页，落在行上会把侧栏滚走
    el.click();
  });
  function boot() {
    arm();
    const mo = new MutationObserver(arm);
    ["proj-list", "history"].forEach((id) => {
      const n = document.getElementById(id);
      if (n) mo.observe(n, { childList: true, subtree: true });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
