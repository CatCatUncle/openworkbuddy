// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
/* 无限画布 · 时间线（第 8 片）
 *
 * 按放映顺序排的时间线、连播预览、角色面板、画布内查找、合成完成的提醒。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
 */
/* ================= 时间线 · 连播预览 · 角色面板 · ⌘F · 合成完成通知 =================
 * 画布上的节点按生成关系摆，不按放映顺序摆。铺开三十个镜头以后，「这部戏先放哪一镜、哪一镜还缺东西」
 * 在图上是看不出来的——得一张卡一张卡点开看。底下这条时间线就是那张「按放映顺序」的表。 */

/**
 * 放映顺序。跟 drama-compose.js 的 orderKeyOf 是同一条规矩，一个字都不能差：
 * 时间线上排第几，成片里就排第几。两边不一样，人在时间线上看着是 A→B、拼出来是 B→A——
 * 这比没有时间线还糟，因为人信了它。
 *   ① payload.order 是数字先认它；② 认镜头号里的「第几场-第几镜」；③ 画布上先上下后左右（200px 算一排）；④ 原次序兜底
 */
function canvasTimelineOrderKey(node, index) {
  const p = canvasPayload(node), pos = typeof node.position === "function" ? node.position() : null;
  const m = /(\d+)\s*[-_–—.]\s*(\d+)/.exec(String(p.id || p.title || ""));
  const ord = Number(p.order);
  return [
    Number.isFinite(ord) ? ord : Infinity,
    m ? Number(m[1]) : Infinity,
    m ? Number(m[2]) : Infinity,
    Math.round((Number(pos && pos.y) || 0) / 200),
    Number(pos && pos.x) || 0,
    index,
  ];
}
function canvasTimelineSort(nodes) {
  return nodes.map((node, index) => ({ node, key: canvasTimelineOrderKey(node, index) }))
    .sort((a, b) => { for (let i = 0; i < a.key.length; i++) { if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1; } return 0; })
    .map((x) => x.node);
}

// 这一镜手上的产物。字段先后照抄 drama-pipeline.js 的 OUTPUT_KEYS，另外多认一道后缀：
// path 字段两类都可能装，一张 png 不能当成「有视频了」
const CANVAS_TIMELINE_KEYS = { frame: ["first_frame", "path", "url", "image"], video: ["video", "path", "url"], audio: ["audio", "voice_file", "path", "url"] };
const CANVAS_TIMELINE_FILE = { frame: "image", video: "video", audio: "audio" };

/** 时间线上的每一格：按放映顺序排好的镜头，带三样产物在不在、占几秒、缺什么 */
function canvasTimelineShots() {
  const graph = canvasState.graph;
  if (!graph || typeof graph.getElements !== "function") return [];
  const rows = new Map(((canvasState.progress && canvasState.progress.shots) || []).map((r) => [String(r.nodeId), r]));
  const fallback = canvasDramaSettings().shotSeconds;
  return canvasTimelineSort(graph.getElements().filter((n) => canvasKind(n) === "shot")).map((node) => {
    const p = canvasPayload(node), row = rows.get(String(node.id));
    const cell = (kind) => {
      const key = CANVAS_TIMELINE_KEYS[kind].find((k) => typeof p[k] === "string" && p[k].trim() && canvasFileKind(p[k]) === CANVAS_TIMELINE_FILE[kind]);
      const path = key ? p[key].trim() : "";
      if (!path) return null;
      // 服务端逐个问过盘的那一格更可信（文件挪了目录它也认得出来）。但只在说的是同一个文件时认它：
      // 刚生成完、进度还没重读的那一会儿，服务端那格还是上一版
      const told = row && row[kind];
      if (told && String(told.path || "") === path) return { path, ok: !!told.ok, ...(told.rel ? { rel: told.rel } : {}) };
      return { path, ok: canvasMediaAvailable(path) };
    };
    const frame = cell("frame"), video = cell("video"), audio = cell("audio");
    const needsVoice = !canvasIsPlaceholderPrompt(p.line);
    const seconds = parseFloat(p.duration);
    // 缺什么只按成片要什么算：视频有了，首帧就不算缺（拼片子用不上它）
    const missing = [];
    if (!(video && video.ok) && !(frame && frame.ok)) missing.push("首帧");
    if (!(video && video.ok)) missing.push("视频");
    if (needsVoice && !(audio && audio.ok)) missing.push("配音");
    const cast = (Array.isArray(p.cast) ? p.cast : typeof p.cast === "string" ? p.cast.split(/[,，、\s]+/) : []).map((v) => String(v || "").trim()).filter(Boolean);
    return {
      node, nodeId: node.id, id: String(p.id || p.title || node.id), seconds: seconds > 0 ? seconds : fallback,
      line: needsVoice ? String(p.line).trim() : "", cast, frame, video, audio, needsVoice, missing,
    };
  });
}

function canvasTimelineIsOpen() {
  if (typeof canvasState.timelineOpen === "boolean") return canvasState.timelineOpen;
  try { return localStorage.getItem("openworkbuddy.canvas.timeline") !== "0"; } catch { return true; }
}
function canvasTimelineNum(n) { return String(Math.round((Number(n) || 0) * 10) / 10); }
// 片内时间码 m:ss。时间线上每格左下角那个是「这一镜从成片第几秒开始」
function canvasTimelineClock(sec) { const t = Math.max(0, Math.floor(Number(sec) || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; }
// 这一镜三样东西各自什么状态：有了 / 缺（成片要它） / 用不上（有视频就不要首帧，没台词就不要配音）
function canvasTimelineParts(s) {
  const has = (x) => !!(x && x.ok);
  return [
    { key: "首帧", state: has(s.frame) ? "ok" : has(s.video) ? "off" : "miss" },
    { key: "视频", state: has(s.video) ? "ok" : "miss" },
    { key: "配音", state: has(s.audio) ? "ok" : s.needsVoice ? "miss" : "off" },
  ];
}
// 这一格的画面。首帧铺成胶片条：一帧挨一帧排满整格，第一帧完整摆着，竖的、横的都不拉不裁。
// 只有视频没首帧的，放视频自己的第一帧
function canvasTimelineThumb(s) {
  if (s.frame && s.frame.ok) {
    const url = canvasFileUrl(s.frame.rel || s.frame.path, 320);
    return `<span class="ctl-thumb is-film" style="background-image:url(&quot;${esc(url)}&quot;)"><img src="${esc(url)}" alt="" draggable="false" data-ctl-aspect="${esc(s.frame.path)}">`;
  }
  if (s.video && s.video.ok) return `<span class="ctl-thumb"><video src="${esc(canvasFileUrl(s.video.rel || s.video.path))}#t=0.1" muted preload="metadata" tabindex="-1" aria-hidden="true" data-ctl-aspect="${esc(s.video.path)}"></video>`;
  return `<span class="ctl-thumb">${ic("image")}`;
}

/** 画那条时间线。没有镜头的画布（不是短剧）整条不出现 */
function canvasRenderTimeline() {
  const box = document.getElementById("canvas-timeline");
  if (!box) return;
  const shots = canvasTimelineShots();
  if (!shots.length) { box.hidden = true; box.innerHTML = ""; return; }
  const open = canvasTimelineIsOpen();
  const lacking = shots.filter((s) => s.missing.length);
  const total = shots.reduce((sum, s) => sum + s.seconds, 0);
  const keep = box.querySelector(".ctl-strip")?.scrollLeft || 0;
  // 焦点在哪一格，重画完还落回那一格：Alt+→ 挪完一镜、生成完一镜都会整条重画，
  // 不接回来焦点就掉到页面上，再按一下方向键挪的是画布上的卡
  const active = document.activeElement, focusId = active && box.contains(active) && active.dataset && active.dataset.ctlShot ? active.dataset.ctlShot : "";
  const pb = canvasState.playback, playing = pb && !pb.ended && pb.shots[pb.index] ? String(pb.shots[pb.index].nodeId) : "";
  // 方向键在格子之间走，Tab 只停一格（选中的那格，没有就第一格）：三十镜不该是三十个 Tab 站
  const home = Math.max(0, shots.findIndex((s) => canvasState.selectedIds.has(s.nodeId)));
  let clock = 0;
  const starts = shots.map((s) => { const at = clock; clock += s.seconds; return at; });
  const cells = open ? shots.map((s, i) => {
    const tip = [s.id, ...s.missing.map((k) => canvasT("缺" + k)), canvasT("拖动或 Alt+←/→ 换顺序")].join(" · ");
    // 格子宽窄跟着时长走，一眼看得出哪一镜长：一秒 16px，夹在 80–160 之间
    const w = Math.round(Math.min(160, Math.max(80, s.seconds * 16)));
    const pips = canvasTimelineParts(s).map((x) => `<i class="is-${x.state}"></i>`).join("");
    return `<button type="button" class="ctl-cell${s.missing.length ? " is-lacking" : ""}${canvasState.selectedIds.has(s.nodeId) ? " is-selected" : ""}${playing === String(s.nodeId) ? " is-playing" : ""}" data-ctl-shot="${esc(s.nodeId)}" data-ctl-i="${i}" tabindex="${i === home ? 0 : -1}" aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" title="${esc(tip)}" style="--ctl-w:${w}px">${canvasTimelineThumb(s)}<span class="ctl-tc">${canvasTimelineClock(starts[i])}</span></span><span class="ctl-pips" aria-hidden="true">${pips}</span><span class="ctl-cap"><b>${esc(s.id)}</b><span>${esc(canvasT("{n} 秒", { n: canvasTimelineNum(s.seconds) }))}</span></span>${s.missing.length ? '<i class="ctl-dot" aria-hidden="true"></i>' : ""}</button>`;
  }).join("") : "";
  box.hidden = false;
  box.classList.toggle("is-open", open);
  box.innerHTML = `${canvasState.castOpen ? canvasCastPanelHtml(shots) : ""}<div class="ctl-panel"><div class="ctl-head"><button type="button" class="ctl-toggle" data-ctl-toggle aria-expanded="${open}" title="${open ? "收起时间线" : "展开时间线"}">${ic(open ? "chevron-down" : "chevron-up")}<b>时间线</b></button><span class="ctl-meta"><span>${esc(canvasT("{n} 镜", { n: shots.length }))}</span><span>${esc(canvasT("{n} 秒", { n: canvasTimelineNum(total) }))}</span>${lacking.length ? `<button type="button" class="ctl-lack" data-ctl-lack title="选中缺素材的镜头"><i class="ctl-dot" aria-hidden="true"></i>${esc(canvasT("{n} 镜缺素材", { n: lacking.length }))}</button>` : ""}</span><span class="ctl-actions"><button type="button" class="ui-btn ui-btn--ghost ui-btn--xs${canvasState.castOpen ? " is-active" : ""}" data-ctl-cast aria-pressed="${canvasState.castOpen}">${ic("users")}角色</button><button type="button" class="ui-btn ui-btn--outline ui-btn--xs" data-ctl-play title="只放本机已有的视频和配音，不花钱">${ic("play")}连播预览</button></span></div>${open ? `<div class="ctl-strip" role="list">${cells}</div>` : ""}</div>`;
  const strip = box.querySelector(".ctl-strip");
  if (strip) strip.scrollLeft = keep;   // 重画是常事（生成完一镜就画一遍），别每次都把人滚回第一镜
  const back = focusId && strip ? [...strip.querySelectorAll("[data-ctl-shot]")].find((el) => el.dataset.ctlShot === focusId) : null;
  if (back) { strip.querySelectorAll("[data-ctl-shot]").forEach((el) => { el.tabIndex = el === back ? 0 : -1; }); back.focus({ preventScroll: true }); canvasTimelineReveal(strip, back); }
  box.querySelector("[data-ctl-toggle]").addEventListener("click", () => {
    canvasState.timelineOpen = !open;
    try { localStorage.setItem("openworkbuddy.canvas.timeline", open ? "0" : "1"); } catch {}
    canvasRenderTimeline();
  });
  box.querySelector("[data-ctl-lack]")?.addEventListener("click", () => canvasProgressFocus(lacking.map((s) => s.nodeId)));
  box.querySelector("[data-ctl-cast]").addEventListener("click", () => { canvasState.castOpen = !canvasState.castOpen; canvasRenderTimeline(); });
  box.querySelector("[data-ctl-play]").addEventListener("click", () => canvasPlaybackStart());
  box.querySelectorAll("[data-ctl-shot]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // 拖完松手浏览器还会补一个 click：那一下不是「点了这一格」，别让画布跳过去
      if (Date.now() - (canvasState.timelineDragEndAt || 0) < 400) return;
      canvasProgressFocus([btn.dataset.ctlShot]);
      box.querySelectorAll(".ctl-cell.is-selected").forEach((el) => el.classList.remove("is-selected"));
      btn.classList.add("is-selected");
    });
    btn.addEventListener("dblclick", () => canvasPlaybackStart(btn.dataset.ctlShot));   // 双击从这一镜往后连着放
    const i = Number(btn.dataset.ctlI);
    btn.addEventListener("pointerenter", () => canvasTimelinePeekSoon(box, btn, shots[i], starts[i]));
    btn.addEventListener("pointerleave", () => canvasTimelinePeekHide(box));
  });
  // 格子里的图、视频到了就记下它的宽高比：悬停放大那张按它摆，画布上同一个文件的卡也不用再等
  box.querySelectorAll("[data-ctl-aspect]").forEach((el) => {
    const read = () => { const w = el.naturalWidth || el.videoWidth, h = el.naturalHeight || el.videoHeight; if (w > 0 && h > 0) CANVAS_ASPECTS.set(String(el.dataset.ctlAspect || "").trim(), w / h); };
    if ((el.complete && el.naturalWidth) || el.videoWidth) read(); else el.addEventListener(el.tagName === "VIDEO" ? "loadedmetadata" : "load", read, { once: true });
  });
  if (strip) {
    strip.addEventListener("scroll", () => canvasTimelinePeekHide(box), { passive: true });
    strip.addEventListener("pointerdown", (e) => canvasTimelineDragStart(e, box, strip));
    // ←/→ 在镜头之间走，Home/End 到头到尾。走到哪格就选中哪格、画布跟过去，跟点一下一样。
    // 截住不往上冒：画布页自己也认方向键（挪选中的卡），不截的话格子一换、身后的卡也跟着挪
    strip.addEventListener("keydown", (e) => {
      const cur = e.target.closest && e.target.closest("[data-ctl-shot]");
      if (!cur || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const all = [...strip.querySelectorAll("[data-ctl-shot]")], at = all.indexOf(cur);
      // 按着 Alt（Mac 上是 Option）：不是走到旁边那格，是把这一镜往前、往后挪一位；Alt+Home/End 挪到头、到尾。
      // 焦点跟着这一镜走（重画时接回来），连按几下就挪几位、记几步撤销
      if (e.altKey) {
        canvasTimelineMove(cur.dataset.ctlShot, e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : at + (e.key === "ArrowRight" ? 1 : -1));
        return;
      }
      const to = all[e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.max(0, Math.min(all.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)))];
      if (!to || to === cur) return;
      all.forEach((el) => { el.tabIndex = el === to ? 0 : -1; });
      to.focus({ preventScroll: true }); canvasTimelineReveal(strip, to); to.click();
    });
  }
  box.querySelectorAll("[data-ctl-focus]").forEach((btn) => btn.addEventListener("click", () => canvasProgressFocus([btn.dataset.ctlFocus])));
  box.querySelectorAll("[data-ctl-attach]").forEach((btn) => btn.addEventListener("click", () => canvasCastAttach([[btn.dataset.ctlAttach, btn.dataset.ctlAttachShot]])));
  box.querySelector("[data-ctl-attach-all]")?.addEventListener("click", () => canvasCastAttach(canvasCastRows(canvasTimelineShots()).flatMap((r) => r.loose.map((x) => [r.node.id, x.shot.nodeId]))));
  box.querySelector("[data-ctl-cast-close]")?.addEventListener("click", () => { canvasState.castOpen = false; canvasRenderTimeline(); });
}

/** 让这一格露在时间线的可见范围里。不用 scrollIntoView：它会连带把整页也滚一下 */
function canvasTimelineReveal(strip, cell) {
  if (!strip || !cell) return;
  const sr = strip.getBoundingClientRect(), cr = cell.getBoundingClientRect();
  if (cr.left < sr.left) strip.scrollLeft -= sr.left - cr.left + 8;
  else if (cr.right > sr.right) strip.scrollLeft += cr.right - sr.right + 8;
}
/**
 * 把一镜挪到放映顺序的第 to 位（从 0 数）。拖格子松手、Alt+←/→ 都走这里。
 *
 * 挪完整条时间线每一镜都写上 order（1、2、3…），不只写挪的那一镜：
 * 没写 order 的镜头一律排在写了的后面，只给一镜写上，它就跑到最前面去了。
 * 镜头号、产物文件名一个都不动——文件名里带镜头号，改号就跟盘上的首帧、视频对不上。
 * 一次挪动记一步撤销；分镜表是真源，顺序跟着写回去（canvasBoardOrderSync）。
 * 合成那边认的是同一个 order（drama-compose.js orderKeyOf），时间线上排第几，成片里就排第几
 * @returns {boolean} 挪没挪
 */
function canvasTimelineMove(nodeId, to) {
  if (canvasState.playback) return false;   // 连播拿的是开播那一刻的顺序，放着的时候不换
  const shots = canvasTimelineShots();
  const from = shots.findIndex((s) => String(s.nodeId) === String(nodeId));
  const at = Math.max(0, Math.min(shots.length - 1, Math.round(Number(to) || 0)));
  if (from < 0 || at === from) return false;
  const list = shots.map((s) => s.node);
  list.splice(at, 0, list.splice(from, 1)[0]);
  // 先把还在防抖里的上一笔记下来：刚改完一句台词紧接着拖，⌘Z 不该把两件事一起退掉
  canvasHistoryFlush();
  list.forEach((node, i) => { if (canvasPayload(node).order !== i + 1) node.set("canvasPayload", { ...canvasPayload(node), order: i + 1 }); });
  canvasPersist();
  canvasHistoryFlush();   // 这一挪单独记一步：连按三下 Alt+→ 是三步，⌘Z 一下退一格
  canvasRenderTimeline();
  canvasToast(canvasT("{id} 挪到第 {n} 镜", { id: shots[from].id, n: at + 1 }), "arrow-right", undefined, canvasUndoAction());
  canvasBoardOrderSync(list).then((why) => { if (why) canvasToast(why, "triangle-alert", "err"); });
  return true;
}

/**
 * 按住一格拖到别处松手，就插到那里。挪过 6px 才算拖：不然点一下、双击连播都会被当成拖。
 * 拖着的时候两格之间亮一道竖线，说清楚松手会插在哪；拖到时间线左右边上自己往那头滚。
 * 用 pointer 事件自己算落点，不用浏览器自带的拖放：那套拖起来是一张半透明截图，落点也画不出来
 */
function canvasTimelineDragStart(e, box, strip) {
  const cell = e.target && e.target.closest ? e.target.closest("[data-ctl-shot]") : null;
  if (!cell || e.button !== 0 || canvasState.playback) return;
  const x0 = e.clientX, y0 = e.clientY, from = Number(cell.dataset.ctlI), id = cell.dataset.ctlShot;
  let slot = -1, dragging = false;
  const cells = () => [...strip.querySelectorAll("[data-ctl-shot]")];
  const mark = (k) => cells().forEach((el, i, all) => {
    el.classList.toggle("is-drop-before", i === k);
    el.classList.toggle("is-drop-after", k === all.length && i === all.length - 1);
  });
  const move = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - x0) < 6 && Math.abs(ev.clientY - y0) < 6) return;
      dragging = true;
      cell.classList.add("is-dragging"); strip.classList.add("is-reordering");
      canvasTimelinePeekHide(box);
    }
    ev.preventDefault();
    const r = strip.getBoundingClientRect();
    if (ev.clientX < r.left + 32) strip.scrollLeft -= 16; else if (ev.clientX > r.right - 32) strip.scrollLeft += 16;
    // 落点：插在第几格前面（按挪之前的排法数）。过了哪一格的中线就算插到它后面
    const all = cells();
    slot = all.findIndex((el) => ev.clientX < el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2);
    if (slot < 0) slot = all.length;
    mark(slot);
  };
  const end = (ev) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    if (!dragging) return;
    canvasState.timelineDragEndAt = Date.now();
    cell.classList.remove("is-dragging"); strip.classList.remove("is-reordering"); mark(-1);
    if (ev.type === "pointercancel" || slot < 0) return;
    // 插在第 slot 格前面：往右挪的时候，自己原来那一格让出来了，要扣掉
    canvasTimelineMove(id, slot > from ? slot - 1 : slot);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}

/** 连播放到哪一镜，时间线上哪一格就亮着，看不见就滚过去。nodeId 给空 = 不在放了 */
function canvasTimelineMarkPlaying(nodeId) {
  const box = document.getElementById("canvas-timeline");
  if (!box) return;
  let hit = null;
  box.querySelectorAll("[data-ctl-shot]").forEach((el) => { const on = !!nodeId && el.dataset.ctlShot === String(nodeId); el.classList.toggle("is-playing", on); if (on) hit = el; });
  if (hit) canvasTimelineReveal(box.querySelector(".ctl-strip"), hit);
}

/**
 * 悬停一格，在它正上方放大看这一镜：整张首帧（不裁）、在成片里从几秒到几秒、台词、三样东西齐没齐。
 * 格子太小，竖屏的首帧在格子里只有二十几像素宽，看不出画的是什么。停 300ms 才出：手扫过去不闪
 */
function canvasTimelinePeekSoon(box, btn, s, start) {
  canvasTimelinePeekHide(box);
  if (!s) return;
  canvasState.timelinePeekTimer = window.setTimeout(() => {
    canvasState.timelinePeekTimer = null;
    if (!btn.isConnected || canvasState.playback) return;
    const frame = s.frame && s.frame.ok ? s.frame : null, video = !frame && s.video && s.video.ok ? s.video : null;
    const path = frame ? frame.path : video ? video.path : "";
    const ratio = canvasAspectOf(path, canvasDramaRatio()), shape = canvasIsTall(ratio) ? "tall" : "wide";
    const fit = `style="aspect-ratio:auto ${Math.round(ratio * 10000) / 10000}" data-shape="${shape}"`;
    const media = frame ? `<img src="${esc(canvasFileUrl(frame.rel || frame.path, 640))}" alt="" draggable="false" ${fit}>`
      : video ? `<video src="${esc(canvasFileUrl(video.rel || video.path))}#t=0.1" muted preload="metadata" ${fit}></video>`
      : `<span class="ctl-peek-none">${esc(canvasT("这一镜还没画面"))}</span>`;
    const parts = canvasTimelineParts(s).map((x) => `<span class="is-${x.state}">${esc(canvasT(x.key))}</span>`).join("");
    const peek = document.createElement("div");
    peek.className = "ctl-peek"; peek.setAttribute("role", "tooltip");
    peek.innerHTML = `<div class="ctl-peek-media">${media}</div><div class="ctl-peek-meta"><b>${esc(s.id)}</b><span>${canvasTimelineClock(start)}–${canvasTimelineClock(start + s.seconds)} · ${esc(canvasT("{n} 秒", { n: canvasTimelineNum(s.seconds) }))}</span></div>${s.line ? `<p class="ctl-peek-line">${esc(s.line)}</p>` : ""}<div class="ctl-peek-parts">${parts}</div>`;
    box.appendChild(peek);
    // 摆在这一格正上方，左右不出时间线那一条；上下贴着面板顶
    const br = box.getBoundingClientRect(), cr = btn.getBoundingClientRect(), panel = box.querySelector(".ctl-panel").getBoundingClientRect();
    const w = peek.offsetWidth;
    peek.style.left = Math.round(Math.max(0, Math.min(br.width - w, cr.left - br.left + cr.width / 2 - w / 2))) + "px";
    peek.style.bottom = Math.round(br.bottom - panel.top + 6) + "px";
    peek.classList.add("is-open");
  }, 300);
}
function canvasTimelinePeekHide(box) {
  if (canvasState.timelinePeekTimer) { clearTimeout(canvasState.timelinePeekTimer); canvasState.timelinePeekTimer = null; }
  (box || document).querySelectorAll(".ctl-peek").forEach((el) => el.remove());
}

/**
 * 角色面板的底账：每个角色、它的定妆照、它出场的镜头。
 * 「出场」认两样：分镜表里这一镜的 cast 写了它，或者画布上连了一条它 → 镜头的线。
 * 只写了没连的就是「出场了但没挂参考图」——生成这一镜时拿不到这张脸，出来就是另一个人
 */
function canvasCastRows(shots) {
  const graph = canvasState.graph;
  if (!graph || typeof graph.getElements !== "function") return [];
  const tied = new Set(graph.getLinks().map((l) => canvasEndpointId(l.get("source")) + "\u0000" + canvasEndpointId(l.get("target"))));
  return graph.getElements().filter((n) => canvasKind(n) === "character").map((node) => {
    const p = canvasPayload(node);
    // 分镜表里认人的钥匙跟 canvasBoardCastOf 一样：先认展开时盖的 board_character，画布上改了名也认得
    const keys = [p.board_character, p.id, p.name].map((v) => String(v || "").trim()).filter(Boolean);
    const inShots = (shots || []).map((shot) => {
      const linked = tied.has(node.id + "\u0000" + shot.nodeId);
      return linked || shot.cast.some((k) => keys.includes(k)) ? { shot, linked } : null;
    }).filter(Boolean);
    return { node, name: String(p.name || p.title || p.id || "角色"), photo: canvasEmbeddedImage(p, "character"), shots: inShots, loose: inShots.filter((x) => !x.linked) };
  });
}

function canvasCastPanelHtml(shots) {
  const rows = canvasCastRows(shots);
  const loose = new Set(rows.flatMap((r) => r.loose.map((x) => x.shot.nodeId))).size;
  const body = rows.map((r) => {
    const photo = r.photo && canvasMediaAvailable(r.photo) ? `<img src="${esc(canvasFileUrl(r.photo, 160))}" alt="" loading="lazy" draggable="false">` : "<span>没有定妆照</span>";
    const chips = r.shots.map((x) => x.linked
      ? `<button type="button" class="ctl-chip" data-ctl-focus="${esc(x.shot.nodeId)}">${esc(x.shot.id)}</button>`
      : `<span class="ctl-chip is-loose" title="出场了但没挂参考图"><button type="button" data-ctl-focus="${esc(x.shot.nodeId)}">${esc(x.shot.id)}</button><button type="button" class="ctl-attach" data-ctl-attach="${esc(r.node.id)}" data-ctl-attach-shot="${esc(x.shot.nodeId)}">挂上</button></span>`).join("");
    return `<div class="ctl-cast-row"><button type="button" class="ctl-cast-photo" data-ctl-focus="${esc(r.node.id)}" title="${esc(r.name)}">${photo}</button><div class="ctl-cast-body"><div class="ctl-cast-name"><b>${esc(r.name)}</b><small>${esc(canvasT("{n} 镜", { n: r.shots.length }))}</small></div><div class="ctl-cast-shots">${chips || "<small>没出场</small>"}</div></div></div>`;
  }).join("") || '<div class="ctl-cast-empty">画布上还没有角色节点。</div>';
  return `<div class="ctl-cast" role="dialog" aria-label="角色"><div class="ctl-cast-head"><b>角色</b>${loose ? `<span class="ctl-lack"><i class="ctl-dot" aria-hidden="true"></i>${esc(canvasT("{n} 镜没挂参考图", { n: loose }))}</span><button type="button" class="ui-btn ui-btn--default ui-btn--xs" data-ctl-attach-all>全部挂上</button>` : ""}<button type="button" class="canvas-tool-button" data-ctl-cast-close title="关闭" aria-label="关闭">${ic("x")}</button></div><div class="ctl-cast-list">${body}</div></div>`;
}

/**
 * 一键挂参考图 = 在画布上连一条「角色 → 镜头」的线，走 canvasConnect，跟人手拖出来的是同一种线。
 * 分镜表里那一镜的 cast 由图上的 castWatch → canvasBoardCastSync 回写。这里不另开一条写表的路：
 * 两条路迟早写岔，画布上连着、表里没有，重跑那一镜照样少一张脸
 */
function canvasCastAttach(pairs) {
  const graph = canvasState.graph;
  if (!graph) return 0;
  let made = 0;
  for (const [charId, shotId] of pairs || []) {
    const source = graph.getCell(charId), target = graph.getCell(shotId);
    if (source && target && canvasConnect(source, target, "character")) made++;
  }
  if (made) canvasToast(canvasT("已挂上 {n} 条参考图", { n: made }), "link");
  canvasRenderTimeline();
  return made;
}

/**
 * 连播预览：按时间线的顺序，把本机已经有的视频和配音一镜接一镜放出来。
 * 只读盘上现成的文件，一个生成请求都不发——这是「花钱之前先看一眼顺不顺」的那一眼，它自己会花钱就没意义了。
 * 缺视频的镜头拿首帧静帧顶上这一镜的时长；连首帧都没有就黑一格、照样占住时长：节奏不能因为缺素材被压扁，
 * 不然放出来的长度跟成片对不上，人看完心里那个「一分半」是假的
 */
function canvasPlaybackStart(fromNodeId) {
  canvasPlaybackStop();
  const shots = canvasTimelineShots(), page = document.getElementById("assist-page");
  if (!page || !shots.length) { canvasToast("画布上还没有镜头。", "info"); return; }
  const box = document.createElement("div");
  box.className = "canvas-playback"; box.id = "canvas-playback"; box.tabIndex = -1;
  box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "连播预览");
  box.innerHTML = `<div class="cpb-card"><div class="cpb-stage" data-cpb-stage></div><div class="cpb-bar"><span class="cpb-now" data-cpb-now></span><span class="cpb-note" data-cpb-note></span><span class="cpb-spacer"></span><button type="button" class="ui-btn ui-btn--ghost ui-btn--xs" data-cpb-nav="-1">上一个</button><button type="button" class="ui-btn ui-btn--ghost ui-btn--xs" data-cpb-nav="1">下一个</button><button type="button" class="ui-btn ui-btn--outline ui-btn--xs" data-cpb-close title="关闭（Esc）">关闭</button></div></div>`;
  // 挂在画布页里面：人切到别的页，这一层跟着整页一起被换掉
  page.appendChild(box);
  // 放映框的比例跟着这部戏走：竖屏戏放在横的框里，片子只剩中间一条
  box.style.setProperty("--cpb-ar", String(Math.round(canvasDramaRatio() * 10000) / 10000));
  canvasTimelinePeekHide();
  const pb = { shots, index: -1, box, timers: [], media: [], token: 0, played: [], ended: false, watch: null };
  canvasState.playback = pb;
  box.querySelectorAll("[data-cpb-nav]").forEach((b) => b.addEventListener("click", () => canvasPlaybackShow(pb.index + Number(b.dataset.cpbNav))));
  box.querySelector("[data-cpb-close]").addEventListener("click", canvasPlaybackStop);
  box.addEventListener("click", (e) => { if (e.target === box) canvasPlaybackStop(); });
  // 播放层挂在画布页里面，按键会一路冒到画布页的键盘处理（canvasBindViewport）：
  // 盯着片子按一下 Backspace，身后选中的节点就被删了；⌘Z 撤掉的也是身后画布上的一步。在这一层截住
  box.addEventListener("keydown", (e) => e.stopPropagation());
  // 页被换掉了，正在响的那段声音可不会自己停——脱离了文档的 <audio> 照样往外念台词
  pb.watch = window.setInterval(() => { if (!box.isConnected) canvasPlaybackStop(); }, 500);
  window.setTimeout(() => box.classList.add("is-open"), 0);
  try { box.focus({ preventScroll: true }); } catch {}
  const from = fromNodeId ? shots.findIndex((s) => String(s.nodeId) === String(fromNodeId)) : 0;
  canvasPlaybackShow(Math.max(0, from));
}

function canvasPlaybackHalt(pb) {
  pb.token++;
  pb.timers.forEach((t) => window.clearTimeout(t)); pb.timers = [];
  pb.media.forEach((m) => { try { m.pause(); m.removeAttribute("src"); m.load(); } catch {} });
  pb.media = [];
}

function canvasPlaybackStop() {
  const pb = canvasState.playback;
  if (!pb) return;
  canvasState.playback = null;
  canvasPlaybackHalt(pb);
  window.clearInterval(pb.watch);
  pb.box.remove();
  canvasTimelineMarkPlaying(null);
}

/** 放第 index 镜。每一镜等它身上所有东西放完（视频、配音、静帧的时长）再走下一镜 */
function canvasPlaybackShow(index) {
  const pb = canvasState.playback;
  if (!pb) return;
  if (!pb.box.isConnected) { canvasPlaybackStop(); return; }
  canvasPlaybackHalt(pb);
  const stage = pb.box.querySelector("[data-cpb-stage]"), now = pb.box.querySelector("[data-cpb-now]"), note = pb.box.querySelector("[data-cpb-note]");
  pb.index = Math.max(0, Math.min(index, pb.shots.length));
  if (pb.index >= pb.shots.length) {
    pb.ended = true;
    stage.innerHTML = '<div class="cpb-empty"><b>放完了</b><button type="button" class="ui-btn ui-btn--default ui-btn--xs" data-cpb-again>从头再放</button></div>';
    stage.querySelector("[data-cpb-again]").addEventListener("click", () => canvasPlaybackShow(0));
    now.textContent = canvasT("{n} 镜", { n: pb.shots.length }); note.textContent = "";
    canvasTimelineMarkPlaying(null);
    return;
  }
  pb.ended = false;
  const s = pb.shots[pb.index], token = pb.token;
  const videoOk = !!(s.video && s.video.ok), frameOk = !!(s.frame && s.frame.ok), audioOk = !!(s.audio && s.audio.ok);
  const mode = videoOk ? "video" : frameOk ? "frame" : "empty";
  pb.played.push({ id: s.id, nodeId: s.nodeId, mode, audio: audioOk });
  canvasTimelineMarkPlaying(s.nodeId);
  now.textContent = `${pb.index + 1}/${pb.shots.length} · ${s.id}`;
  note.textContent = [mode === "frame" ? canvasT("没视频，先放首帧") : mode === "empty" ? canvasT("这一镜还没画面") : "", s.needsVoice && !audioOk ? canvasT("没配音") : ""].filter(Boolean).join(" · ");
  let waiting = 0;
  const next = () => { if (canvasState.playback === pb && pb.token === token && --waiting <= 0) canvasPlaybackShow(pb.index + 1); };
  const hold = (ms) => { waiting++; pb.timers.push(window.setTimeout(next, ms)); };
  // 一段媒体放完算一件事办完。打不开（文件丢了、格式不认、自动播放被拦）不许卡死在这一镜：
  // 画面按这一镜的时长顶过去，配音直接算放完
  const follow = (media, onFail) => {
    waiting++;
    let settled = false;
    const finish = (failed) => { if (settled) return; settled = true; if (failed && onFail) { onFail(); next(); } else next(); };
    media.addEventListener("ended", () => finish(false));
    media.addEventListener("error", () => finish(true));
    pb.media.push(media);
    const played = media.play();
    if (played && typeof played.catch === "function") played.catch(() => finish(true));
  };
  const seconds = Math.max(0.2, s.seconds) * 1000;
  if (mode === "video") {
    const v = document.createElement("video");
    v.className = "cpb-media"; v.playsInline = true; v.preload = "auto";
    // 单独配过音的镜头以配音为准：视频里自带的那轨多半是生成出来的环境声，两轨一起响会盖住台词
    v.muted = audioOk;
    if (frameOk) v.poster = canvasFileUrl(s.frame.rel || s.frame.path, 640);
    v.src = canvasFileUrl(s.video.rel || s.video.path);
    stage.replaceChildren(v);
    follow(v, () => hold(seconds));
  } else if (mode === "frame") {
    const img = document.createElement("img");
    img.className = "cpb-media"; img.alt = ""; img.draggable = false;
    img.src = canvasFileUrl(s.frame.rel || s.frame.path, 640);
    stage.replaceChildren(img);
    hold(seconds);
  } else {
    stage.innerHTML = `<div class="cpb-empty"><b>${esc(s.id)}</b><span>这一镜还没画面</span></div>`;
    hold(seconds);
  }
  if (audioOk) {
    const a = document.createElement("audio");
    a.preload = "auto"; a.src = canvasFileUrl(s.audio.rel || s.audio.path);
    follow(a);
  }
}

/** ⌘F：按标题、台词、镜头号找节点。命中按放映顺序排，回车一个一个走过去 */
function canvasFindHits(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q || !canvasState.graph) return [];
  return canvasTimelineSort(canvasState.graph.getElements()).filter((n) => {
    const p = canvasPayload(n);
    // 台词还是起手模板那句占位的不算：搜「旁白」不该把三十个没写台词的镜头全拎出来
    const fields = [p.title, p.name, p.id, p.board_shot, canvasIsPlaceholderPrompt(p.line) ? "" : p.line];
    return fields.some((v) => (typeof v === "string" || typeof v === "number") && String(v).toLowerCase().includes(q));
  }).map((n) => n.id);
}
function canvasFindCount() {
  const bar = document.getElementById("canvas-find"), f = canvasState.find;
  const out = bar && bar.querySelector("[data-canvas-find-count]");
  if (!out) return;
  const miss = !!(f && f.query.trim() && !f.hits.length);
  out.textContent = !f || !f.query.trim() ? "" : miss ? canvasT("没找到") : f.index < 0 ? canvasT("{n} 个", { n: f.hits.length }) : `${f.index + 1}/${f.hits.length}`;
  out.classList.toggle("is-miss", miss);
}
function canvasFindRun() {
  const input = document.querySelector("#canvas-find [data-canvas-find-input]");
  const query = input ? input.value : "";
  canvasState.find = { query, hits: canvasFindHits(query), index: -1 };
  canvasFindCount();
}
function canvasFindStep(dir) {
  const f = canvasState.find;
  if (!f) return;
  // 两次回车之间图可能变了（删了节点、改了标题）：按现在的图重算一遍，从刚才那个接着往下走
  const current = f.index >= 0 ? f.hits[f.index] : null;
  f.hits = canvasFindHits(f.query);
  if (!f.hits.length) { f.index = -1; canvasFindCount(); return; }
  const at = current == null ? -1 : f.hits.indexOf(current);
  f.index = at < 0 ? (dir < 0 ? f.hits.length - 1 : 0) : (at + dir + f.hits.length) % f.hits.length;
  canvasProgressFocus([f.hits[f.index]]);
  canvasFindCount();
}
function canvasFindOpen() {
  const bar = document.getElementById("canvas-find");
  if (!bar || !canvasState.graph) return;
  bar.hidden = false;
  const input = bar.querySelector("[data-canvas-find-input]");
  input.focus(); input.select();
  canvasFindRun();
}
function canvasFindClose() {
  const bar = document.getElementById("canvas-find");
  if (bar) bar.hidden = true;
  canvasState.find = null;
  try { document.getElementById("assist-page")?.focus({ preventScroll: true }); } catch {}
}

/**
 * 画布页上的 ⌘F（Windows/Linux 是 Ctrl+F）找的是节点，不是对话记录。
 * 全局那条快捷键挂在 document 冒泡阶段（app-02 的 SHORTCUT_ACTIONS），这里挂在 window 捕获阶段、
 * 只在画布页上截住它；离开画布页就原样放行。连播开着时 Esc 也在这儿先截——
 * 让它冒上去就是全局那条「停下正在跑的任务」
 */
function canvasBindFindKey() {
  if (canvasState.findHandler) return;
  canvasState.findHandler = (e) => {
    const page = document.getElementById("assist-page");
    if (!page || !page.classList.contains("canvas-page") || !canvasState.graph) return;
    const pb = canvasState.playback;
    if (pb && pb.box.isConnected) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); canvasPlaybackStop(); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); canvasPlaybackShow(pb.index + (e.key === "ArrowRight" ? 1 : -1)); return; }
      // 连播盖在上面时不开搜索条：它开在播放层底下，光标落进一个看不见的输入框，接着按的字全打进去
      return;
    }
    const mac = typeof SC_MAC !== "undefined" ? SC_MAC : /Mac/i.test(navigator.platform || "");
    const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.altKey || e.shiftKey || !(e.code === "KeyF" || String(e.key || "").toLowerCase() === "f")) return;
    e.preventDefault(); e.stopPropagation();
    canvasFindOpen();
  };
  window.addEventListener("keydown", canvasState.findHandler, true);
}

/** 角色那张卡跟镜头之间最后一条线没了：把这个角色从镜头卡的 cast 里摘掉（认人的钥匙跟 canvasCastRows 一样） */
function canvasCastUnlink(graph, from, to) {
  if (!graph || graph !== canvasState.graph || canvasState.bulk || canvasState.suspendSync) return false;
  const ch = graph.getCell(from), shot = graph.getCell(to);
  if (!ch || !shot || canvasKind(ch) !== "character" || canvasKind(shot) !== "shot") return false;
  // 两张卡之间还连着别的线：人没说「这一镜没有他」
  if (graph.getLinks().some((l) => canvasEndpointId(l.get("source")) === from && canvasEndpointId(l.get("target")) === to)) return false;
  const cp = canvasPayload(ch), p = canvasPayload(shot);
  const keys = new Set([cp.board_character, cp.id, cp.name].map((v) => String(v || "").trim()).filter(Boolean));
  const list = (Array.isArray(p.cast) ? p.cast : typeof p.cast === "string" ? p.cast.split(/[,，、\s]+/) : []).map((v) => String(v || "").trim()).filter(Boolean);
  const kept = list.filter((v) => !keys.has(v));
  if (kept.length === list.length) return false;
  shot.set("canvasPayload", { ...p, cast: kept });
  canvasPersist();
  return true;
}

/** renderCanvasPage 铺完模板、图也建好之后调：时间线跟图走、量对话框多高、搜索条的按键 */
function canvasBindTimeline(page) {
  // 加减镜头、改时长、刚生成出一段视频，时间线都得重画。攒 200ms 再画：展开分镜一次铺几十张卡，一张一画就是几十遍。
  // 挪卡也算：镜头号认不出场次的那些是按画布上的摆法排的，拖一下顺序就变了
  canvasState.graph.on("add remove change:canvasPayload change:position", () => {
    if (canvasState.timelineTimer) clearTimeout(canvasState.timelineTimer);
    canvasState.timelineTimer = window.setTimeout(() => { canvasState.timelineTimer = null; if (canvasState.graph) canvasRenderTimeline(); }, 200);
  });
  // 人手删掉一条「角色 → 镜头」的线，是在说「这一镜没有他」。castWatch 已经把分镜表那一镜的 cast 跟着改了，
  // 镜头卡上展开时抄下的那份 cast 却还记着他：角色面板照着它标「出场了但没挂参考图」，
  // 一点「全部挂上」又把人刚删掉的线连了回去。卡上那份跟着摘掉。
  // 挪到下一拍再看：删节点时连带掀掉的线也走这里，那会儿卡本身马上就没了，别去改一张正在删的卡
  canvasState.graph.on("remove", (cell) => {
    if (canvasState.bulk || canvasState.suspendSync || canvasState.historyMute) return;
    if (!cell || typeof cell.isLink !== "function" || !cell.isLink()) return;
    const from = canvasEndpointId(cell.get("source")), to = canvasEndpointId(cell.get("target")), graph = canvasState.graph;
    if (from && to) window.setTimeout(() => canvasCastUnlink(graph, from, to), 0);
  });
  // 时间线浮在对话框正上方。对话框的高度会变（输入框拉高、挂上引用卡片），量着它走，不写死
  if (canvasState.timelineChatObserver) { try { canvasState.timelineChatObserver.disconnect(); } catch {} canvasState.timelineChatObserver = null; }
  const chat = page.querySelector(".canvas-chat");
  if (chat && typeof ResizeObserver === "function") {
    canvasState.timelineChatObserver = new ResizeObserver(() => page.style.setProperty("--ctl-chat-h", chat.offsetHeight + "px"));
    canvasState.timelineChatObserver.observe(chat);
  }
  const bar = page.querySelector("#canvas-find");
  if (bar) {
    const input = bar.querySelector("[data-canvas-find-input]");
    input.addEventListener("input", canvasFindRun);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !imeKey(e)) { e.preventDefault(); canvasFindStep(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape" && !imeKey(e)) { e.preventDefault(); e.stopPropagation(); canvasFindClose(); }
    });
    bar.querySelectorAll("[data-canvas-find-nav]").forEach((b) => b.addEventListener("click", () => canvasFindStep(Number(b.dataset.canvasFindNav))));
    bar.querySelector("[data-canvas-find-close]").addEventListener("click", canvasFindClose);
  }
  canvasState.find = null;
  canvasBindFindKey();
}

/**
 * 合成完了、人却不在这个窗口前（切去别的应用、窗口最小化）：那条 toast 他看不见，
 * 补一条系统通知。人就在跟前就不发——toast 已经够了，再弹一条是打扰。
 * 通知权限还没问过就问一次；拒过就算了，不反复问
 */
function canvasComposeNotify(job) {
  try {
    if (!job || !job.output || typeof Notification === "undefined") return;
    const away = document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus());
    if (!away) return;
    // 认的是这趟合成是哪张画布发起的（job.name），不是眼下开着哪张：合成要跑几分钟，
    // 人中途切去别的画布，照眼下那张起名，通知就把「第9集」报成「第10集」
    const board = String(job.name || canvasState.canvasName || "");
    const item = (canvasState.canvasList || []).find((x) => x && x.name === board);
    const named = String((item && item.title) || (board !== "main" ? board : "") || "").trim();
    const name = named ? (named.length > 30 ? named.slice(0, 30) + "…" : named) : canvasT("成片");
    const title = canvasT("{name}已合成，点开查看", { name });
    const file = String(job.subtitled || job.output);
    const base = file.split(/[\\/]/).pop() || file;
    const body = base.length > 60 ? base.slice(0, 59) + "…" : base;
    const show = () => {
      const n = new Notification(title, { body, tag: "owb-compose-" + String(job.id || "") });
      n.onclick = () => { try { window.focus(); } catch {} canvasPreviewRight(file); try { n.close(); } catch {} };
    };
    if (Notification.permission === "granted") show();
    else if (Notification.permission === "default" && typeof Notification.requestPermission === "function") {
      Promise.resolve(Notification.requestPermission()).then((p) => { if (p === "granted") show(); }).catch(() => {});
    }
  } catch {}
}
