// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
/* ============================================================================
 * app-00-ui.js —— 界面底层小工具，排在 app-01 之前，后面所有模块直接用
 *   ic(name)  取一个 lucide 图标（sprite 在 index.html 顶部，离线可用）
 *   tooltip   顶掉浏览器原生 title
 * ========================================================================== */

/** 取一个 lucide 图标的内联 svg。name 见 index.html 里 #owb-sprite 的 symbol id */
function ic(name, cls) {
  return `<svg class="i${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/** 往一行小提示里写「图标 + 一句话」。
 *  以前满仓库都是 el.textContent = "✅ 已保存"：图标是当文字塞进去的，
 *  而且每处都得自己记着把上一次失败留下的红色擦掉——擦漏一处就是绿事配红字。
 *  kind: "ok" 成功绿 / "err" 失败红 / 省略则用继承来的颜色。 */
function setMsg(el, icon, text, kind) {
  if (!el) return;
  el.style.color = kind === "err" ? "var(--owb-err-text)" : kind === "ok" ? "var(--owb-ok-text)" : "";
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
  "🍎", "🍜", "🍰", "☕", "🍺", "🍵", "🍉", "🥑",
  "🎧", "🎮", "🎨", "🎸", "📚", "💡", "🔑", "🏆",
  "🚀", "🛸", "⚓", "🧭", "💎", "🎯", "🧩", "✨",
];
/* emoji-数据区 止 */
// 这张表只放 Emoji 12.0 及更早就有的。Windows 10 自带的 Segoe UI Emoji 停在 12.x，
// 更新的（原来这里的珍珠奶茶、魔法棒都是 13.0）在那边画成一个方框，候选格里就是两块空白。
// 新加之前先查它是哪一版进的标准；test/win-ui.js 按码位盯着 13.0 以后的

/** 一格候选头像。三种来源画法各不相同（内置猫标 / 图标 / 表情），但格子一律同一个尺寸。
 *  以前图标那格是行内 span，里面的 svg 用 62% 量自己——百分比撞上没有宽度的行内元素，
 *  浏览器只能退回 SVG 的默认尺寸 300×150，于是助理设置里每个候选都有巴掌大
 *  格子定死，百分比才有参照物。 */
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

/** 这一下按键是不是给输入法的（拼音/假名选词、上屏、取消），而不是给我们的回车/Esc。
 *  拼音打一半按回车，是把字母原样上屏；当成「发送」的话，半截拼音就作为整条消息发出去了。
 *  Chromium 里这一下带 isComposing / keyCode 229，一看就知道；Safari 反过来——先发 compositionend
 *  再发这个回车，到它手里 isComposing 已经是 false，所以还得看「是不是拼字刚结束」。
 *  50ms 远短于人手连按两个键的间隔：空格选完词再按回车发送，不会被误吞。 */
function imeKey(e) {
  if (!e) return false;
  if (e.isComposing || e.keyCode === 229) return true;
  return performance.now() - (window.__imeEndAt ?? -Infinity) < 50;
}
if (!window.__imeEndWired) {
  window.__imeEndWired = true;
  document.addEventListener("compositionend", () => { window.__imeEndAt = performance.now(); }, true);
}

/* ---------- 这台机器是什么系统：界面上「访达」「⌘」这类词按它换 ----------
   以前满仓库写死「在访达里打开」「Shift/⌘ 点节点」，到 Windows 上用户既找不到访达，键盘上也没有 ⌘。
   放在最先加载的这一份里，后面哪个脚本用都拿得到，不用操心加载顺序（app-02 的 SC_MAC 是快捷键引擎自己的，
   e2e 会把那段单独切出来跑，别去动它）。
   认的是浏览器这一台：桌面版里它就是跑服务的那台；网页版由平台管理员从别的电脑打开时，
   「在访达里打开」开的其实是服务端那台的窗口，前端拿不到那台的系统，只能按眼前这台说。 */
/** 平台名 → "mac" / "win" / "linux"。navigator 的写法（MacIntel、Win32、macOS、Windows）和
 *  node 的写法（darwin、win32）都认；认不出的一律按 linux 那套说（Ctrl、文件管理器） */
function uiOsOf(platform) {
  const p = String(platform || "");
  if (/mac|darwin|iphone|ipad|ipod/i.test(p)) return "mac";   // darwin 里也有 win，得先判 mac
  if (/win/i.test(p)) return "win";
  return "linux";
}
const UI_OS = uiOsOf(typeof navigator === "undefined" ? ""
  : (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform);
/** 系统自带的文件管理器叫什么：拼「在__里打开」「去__里找找」用 */
function fileMgrName(os = UI_OS) {
  return os === "mac" ? "访达" : os === "win" ? "资源管理器" : "文件管理器";
}
/** 主修饰键怎么写：mac 是 ⌘，Windows/Linux 是 Ctrl。只管提示文字，真按键的判断各处自己认 metaKey/ctrlKey */
function modKeyName(os = UI_OS) {
  return os === "mac" ? "⌘" : "Ctrl";
}

/** 搜索只接收已确认的输入；重复绑定保留定时器和输入法状态。 */
function bindPageSearch(input, commit, delay = 200) {
  let state = input._pageSearch;
  if (state) { state.commit = commit; return; }
  state = input._pageSearch = { commit, composing: false, timer: null };
  const schedule = () => {
    clearTimeout(state.timer);
    if (state.composing) return;
    state.timer = setTimeout(() => {
      if (input.isConnected && !state.composing) state.commit(input.value);
    }, delay);
  };
  input.oninput = (event) => {
    clearTimeout(state.timer);
    if (!state.composing && !event?.isComposing) schedule();
  };
  input.oncompositionstart = () => { state.composing = true; clearTimeout(state.timer); };
  input.oncompositionend = () => { state.composing = false; schedule(); };
}

/** 刷新简单搜索页时保留顶栏搜索框及其祖先，不能移走焦点或重建正在组词的节点。 */
function renderSearchPage(page, markup, selector, keepHead = false) {
  const input = page.querySelector(selector), head = input?.closest(".hub-head"), search = input?.closest(".hub-search");
  if (!head || head.parentNode !== page || search?.parentNode !== head) { page.innerHTML = markup; return; }
  const template = document.createElement("template");
  template.innerHTML = markup;
  const nextInput = template.content.querySelector(selector), nextHead = nextInput?.closest(".hub-head"), nextSearch = nextInput?.closest(".hub-search");
  if (!nextHead || nextHead.parentNode !== template.content || nextSearch?.parentNode !== nextHead) { page.innerHTML = markup; return; }
  const replaceAround = (parent, next, keep, nextKeep) => {
    const children = [...next.childNodes], at = children.indexOf(nextKeep);
    for (const child of [...parent.childNodes]) if (child !== keep) child.remove();
    for (const child of children.slice(0, at)) parent.insertBefore(child, keep);
    for (const child of children.slice(at + 1)) parent.appendChild(child);
  };
  if (!keepHead) replaceAround(head, nextHead, search, nextSearch);
  replaceAround(page, template.content, head, nextHead);
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
  // 键盘处理认这个标记，不认 role——见下面为什么 role 不能一律加。
  // 已经是 "1" 就别再写：同值照样算一次属性变更，观察器、样式失效都要跟着走一遍
  if (el.dataset.activate !== "1") el.dataset.activate = "1";
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
  // 观察器只补新挂上来的行。以前侧栏动一下（换一颗「在跑」的点、改一行标题）就把全页几百行从头标一遍：
  // 2026-09-29 实测 551 条历史、5 路并跑，静置 10 秒侧栏 data-activate 被重写 5510 次，行一个没新增。
  // 没换掉的行身上的标记还在，不用再碰
  function armAdded(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(SEL)) markActivatable(n);
        n.querySelectorAll(SEL).forEach(markActivatable);
      }
    }
  }
  function boot() {
    arm();
    const mo = new MutationObserver(armAdded);
    ["proj-list", "history"].forEach((id) => {
      const n = document.getElementById(id);
      if (n) mo.observe(n, { childList: true, subtree: true });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/* 左右两栏拖着改宽。
   三条边：侧栏右边、预览面板左边、成果文件面板左边。宽度存 localStorage，下次打开还是这个宽。
   夹逼的上限不是拍脑袋的数字，而是「正文至少还剩 MAIN_MIN」——正文被挤没了，宽的那栏也没意义。
   所以上限得现算：另外两栏此刻占了多少，剩下的才是这一栏能长到的地方。
   窗口本身变小时按同一把尺子重夹一次，不然存着的宽度会把正文顶出屏幕（body 是 overflow:hidden，
   顶出去就是永远看不见的一截）。*/
const RSZ_MAIN_MIN = 470;   // 和 .main { min-width: 460px } 对齐，留一点余量
const RSZ_SMALL = 900;      // 到这个宽度以下两栏是浮层，拖不动也不该拖（和 CSS 的断点一致）
const RSZ = {
  side: { css: "--owb-side-w", sel: "aside", min: 180, dir: 1 },
  pv: { css: "--owb-pv-w", sel: "#preview-panel", min: 320, dir: -1 },
  fp: { css: "--owb-fp-w", sel: "#files-panel", min: 200, dir: -1 },
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
  try { localStorage.setItem("owb-w-" + key, String(w)); } catch {}
  return w;
}
function resetPanelW(key) {
  document.documentElement.style.removeProperty(RSZ[key].css);
  try { localStorage.removeItem("owb-w-" + key); } catch {}
}
// 存过的宽度重新贴一遍（开局、窗口大小变了都走这儿）。小屏直接把变量摘掉，让 CSS 的浮层宽度说了算
function applyStoredW() {
  Object.keys(RSZ).forEach((k) => {
    let v = 0;
    try { v = parseInt(localStorage.getItem("owb-w-" + k) || "", 10); } catch {}
    if (!(v > 0)) return;
    if (window.innerWidth <= RSZ_SMALL) { document.documentElement.style.removeProperty(RSZ[k].css); return; }
    const c = RSZ[k];
    // rszRoom 本来就不含这一栏自己，直接拿它当上限夹一遍
    document.documentElement.style.setProperty(c.css, Math.round(Math.max(c.min, Math.min(rszRoom(k), v))) + "px");
  });
}
// 预览、成果两栏都开着，窗口又放不下几栏的最小宽度时，让成果栏浮在预览上面（CSS 那边是 html.owb-fp-float）。
// 不让的话多出来的那截被 body 的 overflow:hidden 切掉，最右边成果栏的关闭钮整个看不见。
// 判据只读各栏的 min-width 和侧栏实宽，不读两栏此刻的宽度——它们正在过渡动画里，读到的是半路的值。
// 小屏（≤900）两栏本来就是浮层，同时开着时成果栏照样往下让出预览的标题栏
function fitPanels() {
  const pv = document.getElementById("preview-panel"), fp = document.getElementById("files-panel");
  if (!pv || !fp) return;
  let float = false;
  if (pv.classList.contains("show") && fp.classList.contains("show")) {
    const minW = (el) => (el ? parseFloat(getComputedStyle(el).minWidth) || 0 : 0);
    float = window.innerWidth <= RSZ_SMALL
      || rszW("aside") + minW(document.querySelector(".main")) + minW(pv) + minW(fp) > window.innerWidth;
    const head = pv.querySelector(".pv-head");
    if (float && head) document.documentElement.style.setProperty("--owb-fp-top", Math.round(head.getBoundingClientRect().bottom) + "px");
  }
  if (document.documentElement.classList.contains("owb-fp-float") !== float) document.documentElement.classList.toggle("owb-fp-float", float);
}
function initResizers() {
  applyStoredW();
  fitPanels();
  let raf = 0;
  window.addEventListener("resize", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { applyStoredW(); fitPanels(); }); });
  // 两栏开关、侧栏收起/展开都是改 class，盯着 class 变化重判一次
  const fitMo = new MutationObserver(fitPanels);
  ["preview-panel", "files-panel"].forEach((id) => { const n = document.getElementById(id); if (n) fitMo.observe(n, { attributes: true, attributeFilter: ["class"] }); });
  fitMo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
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

/* ---------- 侧栏里那条横的：任务历史的高度 ----------
 * 竖着那条调的是「侧栏多宽」，这条调的是「侧栏里导航和历史怎么分」。
 * 默认自适应（导航先按内容拿够、历史吃剩下）；拖过一次就固定成用户拖出来的那个高度，
 * 剩下的全归导航。双击回自适应。 */
const HIST_KEY = "owb-h-hist", HIST_MIN = 56, NAV_MIN = 56;
// 上限得现算：侧栏多高、上面的品牌行/新建/工作线/账号行占多少，都会变（窗口缩放、工作线标签换行）。
// chrome = 侧栏高度里既不是导航也不是历史的那部分，拖动过程中它不变，所以够用。
function histMax() {
  const a = document.querySelector("aside"), nav = document.querySelector(".side-nav.top"), h = document.getElementById("history");
  if (!a || !nav || !h) return 9999;
  const chrome = a.clientHeight - nav.offsetHeight - h.offsetHeight;
  return Math.max(HIST_MIN, a.clientHeight - chrome - NAV_MIN);
}
function setHistH(px) {
  const v = Math.round(Math.max(HIST_MIN, Math.min(histMax(), px)));
  document.documentElement.classList.add("hist-h");
  document.documentElement.style.setProperty("--owb-hist-h", v + "px");
  try { localStorage.setItem(HIST_KEY, String(v)); } catch {}
  return v;
}
function resetHistH() {
  document.documentElement.classList.remove("hist-h");
  document.documentElement.style.removeProperty("--owb-hist-h");
  try { localStorage.removeItem(HIST_KEY); } catch {}
  toast("任务历史高度已恢复自适应");
}
function applyStoredHistH() {
  let v = 0;
  try { v = parseInt(localStorage.getItem(HIST_KEY) || "", 10); } catch {}
  if (!(v > 0)) return;
  // 先挂上类再夹上限：没挂类的时候 #history 还是 flex:1 1 0，量出来的 offsetHeight 不是它「想要」的高度
  document.documentElement.classList.add("hist-h");
  document.documentElement.style.setProperty("--owb-hist-h", v + "px");
  document.documentElement.style.setProperty("--owb-hist-h", Math.round(Math.max(HIST_MIN, Math.min(histMax(), v))) + "px");
}
function initHistResizer() {
  applyStoredHistH();
  let raf = 0;
  window.addEventListener("resize", () => {
    if (!document.documentElement.classList.contains("hist-h")) return;
    cancelAnimationFrame(raf); raf = requestAnimationFrame(applyStoredHistH);
  });
  const h = document.querySelector('.rsz-v[data-rszv="hist"]');
  if (!h) return;
  h.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    const el = document.getElementById("history");
    if (!el) return;
    // 握把在历史的**上**边，所以往上拖 = 历史变高，这里是减号
    const y0 = e.clientY, h0 = el.getBoundingClientRect().height;
    const move = (ev) => setHistH(h0 - (ev.clientY - y0));
    const up = () => {
      h.removeEventListener("pointermove", move);
      h.removeEventListener("pointerup", up);
      h.removeEventListener("lostpointercapture", up);
      document.body.classList.remove("rszv-on");
      h.classList.remove("on");
    };
    try { h.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add("rszv-on");
    h.classList.add("on");
    h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", up);
    h.addEventListener("lostpointercapture", up);
    e.preventDefault();
  });
  h.addEventListener("dblclick", resetHistH);
  h.addEventListener("keydown", (e) => {            // 键盘也能推，一次 16px（Shift 一次 48px）
    if (e.key === "Escape") { resetHistH(); e.preventDefault(); return; }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const el = document.getElementById("history");
    if (!el) return;
    setHistH(el.getBoundingClientRect().height + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 48 : 16));
    e.preventDefault();
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initHistResizer);
else initHistResizer();

/* 会滚的容器，边沿加一层渐隐。
 * 导航装不下的时候最后一行会被切掉半截；光秃秃的切口看着像「坏了」，而不是「还能往下滚」——
 * 上一轮用户正是从这个切口发现整段导航出事的。渐隐是最省事的一句「下面还有」。
 * 内容是随时在变的（项目增删、「更多」展开、历史来一条），所以 scroll / ResizeObserver /
 * MutationObserver 三处都接一下，别指望某一次渲染之后就不动了。 */
function fadeOnOverflow(el) {
  if (!el) return;
  const sync = () => {
    el.classList.toggle("sc-more", el.scrollHeight - el.clientHeight - el.scrollTop > 2);
    el.classList.toggle("sc-up", el.scrollTop > 2);
  };
  // 内容一变就量，是在微任务里读 scrollHeight：这时候版还是脏的，等于当场逼浏览器把整页排一遍，
  // 而同一趟任务后面接着还要改 DOM，到了帧里再排一遍。2026-09-29 实测切会话时侧栏换高亮行就撞上这个，
  // 10 次切换里有 14 次被逼排版超过 1ms，合计 69.5ms，最长一次 21.7ms。这个渐隐晚一帧没人看得出，攒到下一帧开头量一次
  let raf = 0;
  const syncSoon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; sync(); }); };
  el.addEventListener("scroll", sync, { passive: true });
  try { new ResizeObserver(sync).observe(el); } catch {} // 尺寸回调在排完版之后，读是现成的，不用攒
  try { new MutationObserver(syncSoon).observe(el, { childList: true, subtree: true, characterData: true }); } catch {}
  sync();
}
function initSideFades() {
  fadeOnOverflow(document.querySelector(".side-nav.top"));
  fadeOnOverflow(document.getElementById("history"));
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initSideFades);
else initSideFades();

// Match the visible viewport when keyboards/browser bars resize the phone UI.
(() => {
  let timer = 0;
  const update = () => {
    timer = 0;
    const root = document.documentElement, view = window.visualViewport;
    if (window.innerWidth > 700) { root.style.removeProperty("--owb-viewport-height"); root.classList.remove("owb-keyboard"); return; }
    if (view && Math.abs(view.scale - 1) > .01) return; // Keep pinch zoom available.
    const height = Math.round(view ? view.height : window.innerHeight) + "px";
    if (root.style.getPropertyValue("--owb-viewport-height") !== height) root.style.setProperty("--owb-viewport-height", height);
    const editing = document.activeElement && document.activeElement.matches("input, textarea, [contenteditable=true]");
    root.classList.toggle("owb-keyboard", !!(editing && view && view.height < window.innerHeight - 140));
  };
  // Timers also run when a browser suspends animation frames during keyboard transitions.
  const schedule = () => { if (!timer) timer = setTimeout(update, 16); };
  window.addEventListener("resize", schedule);
  window.addEventListener("pageshow", schedule);
  document.addEventListener("visibilitychange", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", schedule);
  update();
})();
