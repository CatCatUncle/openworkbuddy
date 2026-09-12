/* ============================================================================
 * app-00-ui.js —— 界面底层小工具，排在 app-01 之前，后面所有模块直接用
 *   ic(name)  取一个 lucide 图标（sprite 在 index.html 顶部，离线可用）
 *   tooltip   顶掉浏览器原生 title
 * ========================================================================== */

/** 取一个 lucide 图标的内联 svg。name 见 index.html 里 #wb-sprite 的 symbol id */
function ic(name, cls) {
  return `<svg class="i${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/** 往一行小提示里写「图标 + 一句话」。
 *  以前满仓库都是 el.textContent = "✅ 已保存"：图标是当文字塞进去的，
 *  而且每处都得自己记着把上一次失败留下的红色擦掉——擦漏一处就是绿事配红字。
 *  kind: "ok" 成功绿 / "err" 失败红 / 省略则用继承来的颜色。 */
function setMsg(el, icon, text, kind) {
  if (!el) return;
  el.style.color = kind === "err" ? "var(--wb-err-text)" : kind === "ok" ? "var(--wb-ok-text)" : "";
  el.innerHTML = (icon ? ic(icon) + " " : "") + esc(text == null ? "" : String(text));
}

/** 头像：专家 / 专家团 / 技能卡上那一格。
 *  现在存的是图标名（"brain"、"search"），老配置里存的是表情字符。
 *  sprite 里查得到就画矢量图标，查不到就原样当文字显示——
 *  用户自己手填过的头像，不该因为我们换了图标系统就凭空消失。 */
/** 这个头像值是不是 sprite 里的图标名？老配置里存的是 emoji 字符、上传的图是 data URI，
 *  查不到就不是——交给调用方当文字或图片处理，别让用户手填的头像凭空消失。 */
function isIconName(v) {
  const s = String(v == null ? "" : v).trim();
  return !!(s && !s.startsWith("data:") && document.getElementById("i-" + s));
}
function ava(v, fallback) {
  const name = String(v == null ? "" : v).trim();
  if (isIconName(name)) return ic(name);
  if (name) return esc(name);
  return ic(fallback || "user");
}

/** 头像可选的图标。不是把 sprite 里 135 个都摆出来——那是让人挑花眼，
 *  这里只留「一眼能说出它代表什么角色」的那些，按用途排，找起来快。 */
const AVATAR_ICONS = [
  "user", "users", "id-card", "bot", "cat", "ghost", "smile", "brain",
  "search", "file-search", "compass", "map", "target", "scale", "flask-conical",
  "chart-column", "trending-up", "table", "file-spreadsheet", "clipboard-list",
  "pencil", "notebook-pen", "file-pen-line", "book-open-text", "scroll-text", "languages",
  "palette", "presentation", "image", "film", "clapperboard", "music", "mic",
  "code", "terminal", "bug", "wrench", "puzzle", "package", "rocket",
  "mail", "megaphone", "message-circle", "bird", "globe", "calendar-days", "clock",
  "briefcase", "building-2", "shield", "key-round", "lightbulb", "sparkles", "sprout", "coffee",
];
/** 头像可以挑的表情。整个界面不许再冒 emoji（#85），这儿是写明了的例外：
 *  它是**用户挑给自己的数据**，不是我们画的界面元素——想让助理顶着一只章鱼是他的自由。
 *  测试那头靠下面这对记号放行（test/icons.js 的「emoji 数据区」），不是靠记行号。 */
/* emoji-数据区 起：头像候选表，用户挑给自己的数据，不是界面图形 */
const AVATAR_EMOJI = [
  "😀", "😄", "😊", "😎", "🤓", "🥳", "🤔", "😴",
  "🤖", "👻", "👽", "🦾", "🧠", "👀", "👋", "💪",
  "🐱", "🐶", "🦊", "🐼", "🐨", "🐯", "🦁", "🐵",
  "🐰", "🐸", "🦉", "🦄", "🐙", "🦋", "🐳", "🦖",
  "🌸", "🌵", "🍀", "🌙", "⭐", "🔥", "⚡", "🌈",
  "🍎", "🍜", "🍰", "☕", "🍺", "🧋", "🍉", "🥑",
  "🎧", "🎮", "🎨", "🎸", "📚", "💡", "🔑", "🏆",
  "🚀", "🛸", "⚓", "🧭", "💎", "🎯", "🧩", "🪄",
];
/* emoji-数据区 止 */

/** 一格候选头像。三种来源画法各不相同（内置猫标 / 图标 / 表情），但格子一律同一个尺寸。
 *  以前图标那格是行内 span，里面的 svg 用 62% 量自己——百分比撞上没有宽度的行内元素，
 *  浏览器只能退回 SVG 的默认尺寸 300×150，于是助理设置里每个候选都有巴掌大
 *  （用户原话：「待选的这些图片 svg 都很大」）。格子定死，百分比才有参照物。 */
function avaCell(v, cur, title) {
  const b = avatarBits(v, "");
  const on = v === cur;
  const t = title || v;
  return `<button type="button" class="ava-pick${b.cls === "mk" ? " mk" : ""}${on ? " on" : ""}"`
    + ` data-e="${esc(v)}" title="${esc(t)}" aria-label="${esc(t)}"`
    + `${on ? ' aria-pressed="true"' : ""}>${b.html}</button>`;
}
/** 画一排可点的图标按钮。cur 是当前选中的那个（高亮它）。 */
function avaPicks(cur) {
  return AVATAR_ICONS.map((n) => avaCell(n, cur)).join("");
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

/* 左右两栏拖着改宽。用户原话：「右边和左边栏都支持拖拽放大或者缩小啊自适应啊」。
   三条边：侧栏右边、预览面板左边、成果文件面板左边。宽度存 localStorage，下次打开还是这个宽。
   夹逼的上限不是拍脑袋的数字，而是「正文至少还剩 MAIN_MIN」——正文被挤没了，宽的那栏也没意义。
   所以上限得现算：另外两栏此刻占了多少，剩下的才是这一栏能长到的地方。
   窗口本身变小时按同一把尺子重夹一次，不然存着的宽度会把正文顶出屏幕（body 是 overflow:hidden，
   顶出去就是永远看不见的一截）。*/
const RSZ_MAIN_MIN = 470;   // 和 .main { min-width: 460px } 对齐，留一点余量
const RSZ_SMALL = 900;      // 到这个宽度以下两栏是浮层，拖不动也不该拖（和 CSS 的断点一致）
const RSZ = {
  side: { css: "--wb-side-w", sel: "aside", min: 180, dir: 1 },
  pv: { css: "--wb-pv-w", sel: "#preview-panel", min: 320, dir: -1 },
  fp: { css: "--wb-fp-w", sel: "#files-panel", min: 200, dir: -1 },
};
const rszW = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect().width : 0; };
// 这一栏还能长多少：窗口宽 - 正文保底 - 另外两栏现在占的
function rszRoom(key) {
  const others = Object.keys(RSZ).filter((k) => k !== key).reduce((s, k) => s + rszW(RSZ[k].sel), 0);
  return Math.max(0, window.innerWidth - RSZ_MAIN_MIN - others);
}
function setPanelW(key, px) {
  const c = RSZ[key];
  if (!c) return 0;
  const w = Math.round(Math.max(c.min, Math.min(rszRoom(key), px)));
  document.documentElement.style.setProperty(c.css, w + "px");
  try { localStorage.setItem("wb-w-" + key, String(w)); } catch {}
  return w;
}
function resetPanelW(key) {
  document.documentElement.style.removeProperty(RSZ[key].css);
  try { localStorage.removeItem("wb-w-" + key); } catch {}
}
// 存过的宽度重新贴一遍（开局、窗口大小变了都走这儿）。小屏直接把变量摘掉，让 CSS 的浮层宽度说了算
function applyStoredW() {
  Object.keys(RSZ).forEach((k) => {
    let v = 0;
    try { v = parseInt(localStorage.getItem("wb-w-" + k) || "", 10); } catch {}
    if (!(v > 0)) return;
    if (window.innerWidth <= RSZ_SMALL) { document.documentElement.style.removeProperty(RSZ[k].css); return; }
    const c = RSZ[k];
    // rszRoom 本来就不含这一栏自己，直接拿它当上限夹一遍
    document.documentElement.style.setProperty(c.css, Math.round(Math.max(c.min, Math.min(rszRoom(k), v))) + "px");
  });
}
function initResizers() {
  applyStoredW();
  let raf = 0;
  window.addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(applyStoredW); });
  document.querySelectorAll(".rsz").forEach((h) => {
    const key = h.dataset.rsz;
    if (!RSZ[key]) return;
    h.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      const c = RSZ[key], el = document.querySelector(c.sel);
      if (!el || window.innerWidth <= RSZ_SMALL) return;
      const x0 = e.clientX, w0 = el.getBoundingClientRect().width;
      const move = (ev) => setPanelW(key, w0 + (ev.clientX - x0) * c.dir);
      const up = () => {
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("lostpointercapture", up);
        document.body.classList.remove("rsz-on");
        h.classList.remove("on");
      };
      try { h.setPointerCapture(e.pointerId); } catch {}
      document.body.classList.add("rsz-on");
      h.classList.add("on");
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("lostpointercapture", up);
      e.preventDefault();
    });
    h.addEventListener("dblclick", () => resetPanelW(key));   // 双击回默认宽
    h.addEventListener("keydown", (e) => {                    // 键盘也能推，一次 16px（按住 Shift 一次 48px）
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const c = RSZ[key], el = document.querySelector(c.sel);
      if (!el) return;
      setPanelW(key, el.getBoundingClientRect().width + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 48 : 16) * c.dir);
      e.preventDefault();
    });
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initResizers);
else initResizers();
