// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
/* 无限画布 · 视口（第 2 片）
 *
 * 缩放、滚轮、适配窗口、居中选中、自动排版，以及画布上的键盘和空格拖动。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
 */
function canvasZoom(page, value) {
  if (!canvasState.paper) return;
  canvasState.scale = Math.max(.12, Math.min(1.8, value));
  canvasState.paper.scale(canvasState.scale, canvasState.scale);
  const label = page.querySelector("#canvas-zoom");
  if (label) label.textContent = Math.round(canvasState.scale * 100) + "%";
}

// 滚轮三种来源分开处理（以前一律缩放、还以左上角为原点，触控板根本没法平移）：
// - ctrlKey：macOS 触控板捏合，Chromium 会把 pinch 报成 ctrl+wheel，deltaY 很小很密，按指数连续缩放；
// - deltaMode=1（按行）：普通鼠标滚轮，保持原来一格 8% 的手感；
// - 其余（按像素，触控板双指滑动）：按 deltaX/deltaY 平移，不改缩放。
// 缩放的两种都以光标为锚点：缩放前光标下是哪一点，缩放后还在光标下。
// macOS 下有些鼠标也报像素模式，会变成上下平移；按住 ⌘/Ctrl 滚仍然是缩放。
function canvasWheelFactor(evt) {
  const dy = Number(evt.deltaY) || 0;
  return evt.deltaMode === 1 || Math.abs(dy) >= 50 ? (dy > 0 ? .92 : 1.08) : Math.exp(-Math.max(-10, Math.min(10, dy)) * .01);
}
function canvasWheel(page, evt) {
  const paper = canvasState.paper;
  if (!paper || !evt) return;
  const dx = Number(evt.deltaX) || 0, dy = Number(evt.deltaY) || 0;
  const zoom = evt.ctrlKey || evt.metaKey || (evt.deltaMode === 1 && dy);
  if (!zoom) {
    const unit = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? Math.max(200, page?.querySelector("#canvas-viewport")?.clientHeight || 600) : 1;
    if (!dx && !dy) return;
    canvasState.x -= dx * unit; canvasState.y -= dy * unit;
    paper.translate(canvasState.x, canvasState.y);
    return;
  }
  if (!dy) return;
  const factor = canvasWheelFactor(evt);
  const client = { x: evt.clientX, y: evt.clientY };
  const exact = typeof paper.clientToLocalPoint === "function" && typeof paper.localToClientPoint === "function";
  const anchor = exact ? paper.clientToLocalPoint(client) : null;
  const before = canvasState.scale || 1, rect = !exact ? paper.el?.getBoundingClientRect?.() : null;
  canvasZoom(page, before * factor);
  if (exact) {
    const now = paper.localToClientPoint(anchor), cur = typeof paper.translate === "function" ? paper.translate() : null;
    canvasState.x = (Number.isFinite(cur?.tx) ? cur.tx : canvasState.x) + client.x - now.x;
    canvasState.y = (Number.isFinite(cur?.ty) ? cur.ty : canvasState.y) + client.y - now.y;
  } else if (rect) {
    // 没有 JointJS 的换算函数时按「屏幕 = 原点 + 平移 + 本地×缩放」手算，结果一样
    const ratio = canvasState.scale / before, ox = client.x - rect.left, oy = client.y - rect.top;
    canvasState.x = ox - (ox - canvasState.x) * ratio; canvasState.y = oy - (oy - canvasState.y) * ratio;
  }
  paper.translate(canvasState.x, canvasState.y);
}

// 一帧内的滚轮只更新一次 SVG 变换；每个缩放事件仍按自己的光标锚点计算，不能丢掉累计位移。
function canvasFlushWheel(page) {
  if (canvasState.wheelFrame !== null) cancelAnimationFrame(canvasState.wheelFrame);
  canvasState.wheelFrame = null;
  const events = canvasState.wheelQueue; canvasState.wheelQueue = [];
  const paper = canvasState.paper;
  if (!events.length || !paper) return;
  const origin = paper.localToClientPoint({ x: 0, y: 0 });
  let scale = canvasState.scale || 1, x = canvasState.x, y = canvasState.y, ox = origin.x, oy = origin.y;
  const height = Math.max(200, page.querySelector("#canvas-viewport")?.clientHeight || 600);
  for (const evt of events) {
    const zoom = evt.ctrlKey || evt.metaKey || (evt.deltaMode === 1 && evt.deltaY);
    if (zoom && evt.deltaY) {
      const next = Math.max(.12, Math.min(1.8, scale * canvasWheelFactor(evt)));
      const dx = (evt.clientX - ox) * (1 - next / scale), dy = (evt.clientY - oy) * (1 - next / scale);
      x += dx; y += dy; ox += dx; oy += dy; scale = next;
    } else if (!zoom) {
      const unit = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? height : 1;
      const dx = evt.deltaX * unit, dy = evt.deltaY * unit;
      x -= dx; y -= dy; ox -= dx; oy -= dy;
    }
  }
  if (scale !== canvasState.scale) canvasZoom(page, scale);
  canvasState.x = x; canvasState.y = y; paper.translate(x, y);
}

// 使用实际没有被对话框、时间线和属性面板遮住的区域；面板在视口外时不重复扣空间。
function canvasViewportArea(page = document.getElementById("assist-page")) {
  const viewport = page?.querySelector("#canvas-viewport"); if (!viewport) return null;
  const rect = viewport.getBoundingClientRect();
  let right = Math.min(rect.right, window.innerWidth), bottom = Math.min(rect.bottom, window.innerHeight);
  let top = Math.max(0, rect.top); const left = Math.max(0, rect.left);
  const tools = page.querySelector(".canvas-toolbar");
  if (tools?.offsetParent !== null) { const r = tools?.getBoundingClientRect(); if (r?.height && r.bottom > top && r.top < bottom) top = r.bottom + 12; }
  const inspector = page.querySelector(".canvas-layout:not(.canvas-inspector-hidden) .canvas-inspector");
  if (inspector?.offsetParent !== null && inspector?.offsetWidth) right = Math.min(right, inspector.getBoundingClientRect().left - 12);
  page.querySelectorAll(".canvas-chat, .canvas-timeline").forEach((el) => {
    if (el.hidden || el.offsetParent === null) return;
    const r = el.getBoundingClientRect();
    if (r.height && r.left < right && r.right > left && r.top > top && r.top < bottom) bottom = r.top - 12;
  });
  return { left, top, width: Math.max(120, right - left), height: Math.max(120, bottom - top), offsetX: left - rect.left, offsetY: top - rect.top, rect };
}

function canvasEnsureNodeVisible(node, page = document.getElementById("assist-page")) {
  const area = canvasViewportArea(page), paper = canvasState.paper; if (!node || !area || !paper) return;
  const b = node.getBBox(), pad = 16;
  const scale = Math.max(.12, Math.min(canvasState.scale, (area.width - pad * 2) / b.width, (area.height - pad * 2) / b.height));
  const left = canvasState.x + b.x * scale, top = canvasState.y + b.y * scale;
  const outside = left < area.offsetX + pad || left + b.width * scale > area.offsetX + area.width - pad || top < area.offsetY + pad || top + b.height * scale > area.offsetY + area.height - pad;
  if (!outside && scale === canvasState.scale) return;
  canvasState.scale = scale;
  canvasState.x = area.offsetX + (area.width - b.width * scale) / 2 - b.x * scale;
  canvasState.y = area.offsetY + (area.height - b.height * scale) / 2 - b.y * scale;
  paper.scale(scale, scale); paper.translate(canvasState.x, canvasState.y);
  const label = page.querySelector("#canvas-zoom"); if (label) label.textContent = Math.round(scale * 100) + "%";
}

function canvasFitToBox(page, box, padding = 64, minScale = .12) {
  const viewport = page?.querySelector("#canvas-viewport"), paper = canvasState.paper;
  if (!viewport || !paper || !box || !box.width || !box.height) return;
  const area = canvasViewportArea(page), vw = area.width, vh = area.height;
  const scale = Math.max(minScale, Math.min(1.6, (vw - padding * 2) / box.width, (vh - padding * 2) / box.height));
  canvasState.scale = scale;
  canvasState.x = area.offsetX + (vw - box.width * scale) / 2 - box.x * scale;
  canvasState.y = area.offsetY + (vh - box.height * scale) / 2 - box.y * scale;
  paper.scale(scale, scale); paper.translate(canvasState.x, canvasState.y);
  const label = page.querySelector("#canvas-zoom"); if (label) label.textContent = Math.round(scale * 100) + "%";
}

function canvasFitAll(page) {
  const elements = canvasState.graph?.getElements?.() || [];
  if (!elements.length) { canvasToast("画布里还没有节点。", "info"); return; }
  const box = elements.reduce((out, node) => {
    const b = node.getBBox();
    if (!out) return { x: b.x, y: b.y, width: b.width, height: b.height };
    const right = Math.max(out.x + out.width, b.x + b.width), bottom = Math.max(out.y + out.height, b.y + b.height);
    out.x = Math.min(out.x, b.x); out.y = Math.min(out.y, b.y); out.width = right - out.x; out.height = bottom - out.y; return out;
  }, null);
  // 小型短剧工作流优先可读，而不是为了挤进最后几个像素缩成缩略图；大型画布仍可完整适配。
  canvasFitToBox(page, box, 64, elements.length <= 10 ? .38 : .12);
}

function canvasCenterSelected(page) {
  const node = canvasSelectedNode();
  if (!node) { canvasFitAll(page); return; }
  const selected = [...canvasState.selectedIds].map((id) => canvasState.graph.getCell(id)).filter((item) => item?.isElement?.());
  const b = canvasNodeBounds(selected.length ? selected : [node]), viewport = page?.querySelector("#canvas-viewport");
  if (!viewport || !canvasState.paper) return;
  const area = canvasViewportArea(page), scale = canvasState.scale || 1;
  canvasState.x = area.offsetX + area.width / 2 - (b.x + b.width / 2) * scale; canvasState.y = area.offsetY + area.height / 2 - (b.y + b.height / 2) * scale;
  canvasState.paper.translate(canvasState.x, canvasState.y);
}

function canvasNodeBounds(nodes) {
  return nodes.reduce((out, node) => {
    const b = node.getBBox();
    if (!out) return { x: b.x, y: b.y, width: b.width, height: b.height };
    const right = Math.max(out.x + out.width, b.x + b.width), bottom = Math.max(out.y + out.height, b.y + b.height);
    out.x = Math.min(out.x, b.x); out.y = Math.min(out.y, b.y);
    out.width = right - out.x; out.height = bottom - out.y; return out;
  }, null);
}

function canvasArrangeSelection(action) {
  const graph = canvasState.graph, nodes = [...canvasState.selectedIds].map((id) => graph?.getCell(id)).filter((node) => node?.isElement?.());
  if (nodes.length < 2) return;
  const box = canvasNodeBounds(nodes), horizontal = action === "space-x";
  if (!["left", "top", "space-x", "space-y"].includes(action)) return;
  if (canvasState.inlineEdit) canvasInlineCommit();
  canvasHistoryFlush(); graph.startBatch("canvas-edit");
  try {
    if (action === "left" || action === "top") nodes.forEach((node) => {
      const p = node.position(); node.position(action === "left" ? box.x : p.x, action === "top" ? box.y : p.y);
    });
    else {
      const key = horizontal ? "x" : "y", size = horizontal ? "width" : "height";
      nodes.sort((a, b) => a.position()[key] - b.position()[key]);
      const gap = Math.max(32, (box[size] - nodes.reduce((sum, node) => sum + node.size()[size], 0)) / (nodes.length - 1));
      let at = box[key];
      nodes.forEach((node) => { const p = node.position(); node.position(horizontal ? at : p.x, horizontal ? p.y : at); at += node.size()[size] + gap; });
    }
  } finally { graph.stopBatch("canvas-edit"); }
  canvasPersist();
}

function canvasRenderSelectionTools() {
  const box = document.getElementById("canvas-selection-tools"); if (!box) return;
  const count = canvasState.selectedIds.size;
  box.hidden = count < 2;
  if (count < 2) { box.replaceChildren(); return; }
  const graph = canvasState.graph, selected = [...canvasState.selectedIds].map((id) => graph?.getCell(id)).filter(Boolean);
  const images = selected.every((node) => !!canvasUpstreamImage({ node, kind: canvasKind(node), path: canvasMediaPath(canvasPayload(node)) }));
  const targets = images ? graph.getElements().filter((node) => !canvasState.selectedIds.has(node.id) && ["image", "shot", "character", "location"].includes(canvasKind(node))) : [];
  const references = images ? `<select data-canvas-reference-target aria-label="${esc(canvasT("批量连接参考图"))}"><option value="">${canvasT("作为参考图…")}</option><option value="__new__">${canvasT("新建图片节点")}</option>${targets.map((node) => `<option value="${esc(node.id)}">${esc(canvasNodeLabel(node))}</option>`).join("")}</select>` : "";
  box.innerHTML = `<span>${esc(canvasT("已选 {n} 个", { n: count }))}</span><select data-canvas-arrange aria-label="${esc(canvasT("整理选中节点"))}"><option value="">${canvasT("整理选中节点")}</option><option value="left">${canvasT("左对齐")}</option><option value="top">${canvasT("顶部对齐")}</option><option value="space-x">${canvasT("水平等距")}</option><option value="space-y">${canvasT("垂直等距")}</option></select>${references}<button type="button" class="canvas-tool-button" data-canvas-duplicate-selection title="${esc(canvasT("复制节点与参考"))}" aria-label="${esc(canvasT("复制节点与参考"))}">${ic("copy")}</button><button type="button" class="canvas-tool-button" data-canvas-export-selection title="${esc(canvasT("导出选中节点与素材"))}" aria-label="${esc(canvasT("导出选中节点与素材"))}">${ic("download")}</button><button type="button" class="canvas-tool-button" data-canvas-delete-selection title="${esc(canvasT("删除选中节点"))}" aria-label="${esc(canvasT("删除选中节点"))}">${ic("trash-2")}</button>`;
  box.querySelector("[data-canvas-arrange]").addEventListener("change", (evt) => { canvasArrangeSelection(evt.target.value); evt.target.value = ""; });
  box.querySelector("[data-canvas-export-selection]")?.addEventListener("click", () => canvasExportSelection(true));
  box.querySelector("[data-canvas-delete-selection]").addEventListener("click", () => canvasDeleteSelection());
  box.querySelector("[data-canvas-duplicate-selection]").addEventListener("click", () => canvasDuplicateSelection());
  box.querySelector("[data-canvas-reference-target]")?.addEventListener("change", (evt) => { const target = evt.target.value; evt.target.value = ""; if (target) canvasConnectReferences(target); });
  canvasSelectionExtras(box, selected, images);
}

function canvasConnectReferences(targetId) {
  const graph = canvasState.graph;
  const sources = [...canvasState.selectedIds].map((id) => graph?.getCell(id)).filter((node) => node?.isElement?.());
  if (!sources.length) return;
  const paths = sources.map((node) => canvasUpstreamImage({ node, kind: canvasKind(node), path: canvasMediaPath(canvasPayload(node)) }));
  if (paths.some((path) => !path)) return canvasToast("选中的节点包含不可用的图片。", "triangle-alert", "err");
  let target = targetId === "__new__" ? null : graph.getCell(targetId);
  if (targetId !== "__new__" && !target) return;
  if (target) {
    const problem = sources.map((source) => canvasLinkProblem(source, target)).find(Boolean);
    if (problem) return canvasToast(problem, "triangle-alert", "err");
  }
  const p = target ? canvasPayload(target) : {};
  const all = new Set([...paths, ...(target ? canvasUpstreamImages(target) : []), p.reference, p.first_frame].filter(Boolean));
  if (all.size > 4) return canvasToast("最多使用 4 张参考图，请减少选择后再连接。", "triangle-alert", "err");
  canvasHistoryFlush(); graph.startBatch("canvas-edit");
  try {
    if (!target) target = canvasAddNode("image", {}, undefined, { persist: false, skipSelect: true });
    if (!target) return;
    sources.forEach((source) => canvasConnect(source, target, "reference"));
  } finally { graph.stopBatch("canvas-edit"); }
  canvasSetSelection([target.id]); canvasPersist(); canvasFocusNodeInput(target);
}

// 小地图只绘制几何轮廓，既不加载素材，也不重新创建卡片。
function canvasBindMinimap(page) {
  const el = page.querySelector("#canvas-minimap"), button = page.querySelector("[data-canvas-minimap]");
  if (!el || !button) return;
  const map = { el, svg: el.querySelector("[data-canvas-map-surface]"), nodes: el.querySelector("[data-canvas-map-nodes]"), view: el.querySelector("[data-canvas-map-view]"), bounds: null, frame: null };
  canvasState.minimap = map;
  const draw = () => {
    map.frame = null;
    if (canvasState.minimap !== map || !canvasState.minimapOpen) return;
    const nodes = canvasState.graph?.getElements() || [], box = canvasNodeBounds(nodes);
    const area = canvasViewportArea(page), scale = canvasState.scale || 1;
    const visible = { x: (area.offsetX - canvasState.x) / scale, y: (area.offsetY - canvasState.y) / scale, width: area.width / scale, height: area.height / scale };
    map.el.style.bottom = `${Math.max(12, area.rect.height - area.offsetY - area.height + 12)}px`;
    const left = Math.min(box?.x ?? visible.x, visible.x) - 80, top = Math.min(box?.y ?? visible.y, visible.y) - 80;
    const right = Math.max(box ? box.x + box.width : visible.x, visible.x + visible.width) + 80;
    const bottom = Math.max(box ? box.y + box.height : visible.y, visible.y + visible.height) + 80;
    map.bounds = { x: left, y: top, width: right - left, height: bottom - top };
    map.svg.setAttribute("viewBox", `${left} ${top} ${right - left} ${bottom - top}`);
    map.nodes.innerHTML = nodes.map((node) => { const b = node.getBBox(); return `<rect class="canvas-map-node${canvasState.selectedIds.has(node.id) ? " is-selected" : ""}" x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="12"/>`; }).join("");
    canvasMinimapView();
  };
  map.schedule = () => { if (canvasState.minimap === map && canvasState.minimapOpen && map.frame === null) map.frame = requestAnimationFrame(draw); };
  const toggle = (open) => {
    canvasState.minimapOpen = open; el.hidden = !open; button.setAttribute("aria-pressed", String(open));
    if (open) map.schedule();
  };
  button.addEventListener("click", () => toggle(!canvasState.minimapOpen));
  el.querySelector("button").addEventListener("click", () => toggle(false));
  const jump = (evt) => {
    const matrix = map.svg.getScreenCTM(); if (!matrix || !canvasState.paper) return;
    const point = new DOMPoint(evt.clientX, evt.clientY).matrixTransform(matrix.inverse());
    const area = canvasViewportArea(page), scale = canvasState.scale || 1;
    canvasState.x = area.offsetX + area.width / 2 - point.x * scale;
    canvasState.y = area.offsetY + area.height / 2 - point.y * scale;
    canvasState.paper.translate(canvasState.x, canvasState.y);
  };
  map.svg.addEventListener("pointerdown", (evt) => { if (evt.button !== 0) return; evt.preventDefault(); evt.stopPropagation(); map.svg.setPointerCapture(evt.pointerId); jump(evt); });
  map.svg.addEventListener("pointermove", (evt) => { if (map.svg.hasPointerCapture(evt.pointerId)) jump(evt); });
  map.svg.addEventListener("pointerup", (evt) => { if (map.svg.hasPointerCapture(evt.pointerId)) map.svg.releasePointerCapture(evt.pointerId); });
  canvasState.graph.on("add remove change:position change:size", map.schedule);
  canvasState.paper.on("translate scale", canvasMinimapView);
  map.resize = new ResizeObserver(() => map.schedule()); map.resize.observe(page.querySelector("#canvas-viewport"));
  page.querySelectorAll(".canvas-chat, .canvas-timeline").forEach((el) => map.resize.observe(el));
  toggle(canvasState.minimapOpen);
}

function canvasMinimapView() {
  const map = canvasState.minimap, viewport = document.getElementById("canvas-viewport");
  if (!map || !canvasState.minimapOpen || !viewport) return;
  const scale = canvasState.scale || 1, area = canvasViewportArea();
  const attrs = { x: (area.offsetX - canvasState.x) / scale, y: (area.offsetY - canvasState.y) / scale, width: area.width / scale, height: area.height / scale };
  for (const [key, value] of Object.entries(attrs)) map.view.setAttribute(key, value);
  const b = map.bounds;
  if (b && (attrs.x < b.x || attrs.y < b.y || attrs.x + attrs.width > b.x + b.width || attrs.y + attrs.height > b.y + b.height)) map.schedule();
}

function canvasAutoLayout(page) {
  // 按量好的卡高排：图刚到、卡还没来得及长高的时候排，排完那张卡一长就压到下一张
  if (canvasState.graph) canvasFitFlush();
  const graph = canvasState.graph, nodes = graph?.getElements?.() || [];
  if (!nodes.length) return canvasToast("画布里还没有节点。", "info");
  const D = typeof dagre !== "undefined" ? dagre : null;
  if (!D?.graphlib?.Graph || typeof D.layout !== "function") return canvasToast("DAG 排版组件没有加载，请刷新后重试。", "circle-x", "err");
  const layoutGraph = new D.graphlib.Graph({ multigraph: true }).setGraph({
    rankdir: "LR", ranker: "network-simplex", acyclicer: "greedy", align: "UL",
    ranksep: 54, nodesep: 30, edgesep: 16, marginx: 44, marginy: 44,
  }).setDefaultEdgeLabel(() => ({}));
  nodes.forEach((node) => { const size = node.size(); layoutGraph.setNode(node.id, { width: size.width, height: size.height }); });
  graph.getLinks().forEach((link, index) => {
    const source = canvasEndpointId(link.get("source")), target = canvasEndpointId(link.get("target"));
    if (layoutGraph.hasNode(source) && layoutGraph.hasNode(target) && source !== target) layoutGraph.setEdge(source, target, {}, `edge-${index}`);
  });
  D.layout(layoutGraph);
  // 每挪一张都会来一次 change:position：bulk 挡住，挪完下面存一次
  canvasState.historyMute = true; canvasState.bulk = true;
  try {
    nodes.forEach((node) => { const point = layoutGraph.node(node.id), size = node.size(); if (point) node.position(Math.round(point.x - size.width / 2), Math.round(point.y - size.height / 2)); });
  } finally { canvasState.historyMute = false; canvasState.bulk = false; }
  canvasPersist(); canvasFitAll(page); canvasToast("已按生成关系紧凑排版并居中。", "git-branch");
}

// 新卡按当前可见区域定位，平移和缩放后仍在眼前。碰撞只在屏幕内找空位，不能为了避让一路挪到屏幕外。
function canvasNewNodePosition(kind, client) {
  canvasFlushWheel(document.getElementById("assist-page"));
  const viewport = document.getElementById("canvas-viewport"), paper = canvasState.paper;
  const def = CANVAS_NODE_DEFS[kind] || CANVAS_NODE_DEFS.note;
  if (!viewport || !paper) return { x: 90, y: 100 };
  const area = canvasViewportArea(), rect = area, scale = canvasState.scale || 1;
  const width = area.width, height = area.height, pad = 24;
  const maxX = Math.max(pad, width - def.width * scale - pad), maxY = Math.max(pad, height - def.height * scale - pad);
  const origin = { x: (client ? client.x - rect.left : width / 2) - def.width * scale / 2, y: (client ? client.y - rect.top : height / 2) - def.height * scale / 2 };
  const bounds = canvasState.graph.getElements().map((node) => node.getBBox());
  let best = null, bestOverlap = Infinity;
  for (let i = 0; i < 49; i++) {
    const ring = Math.ceil(Math.sqrt(i)), angle = i * 2.4;
    const x = Math.max(pad, Math.min(maxX, origin.x + Math.cos(angle) * ring * 40));
    const y = Math.max(pad, Math.min(maxY, origin.y + Math.sin(angle) * ring * 40));
    const at = paper.clientToLocalPoint({ x: rect.left + x, y: rect.top + y });
    const overlap = bounds.reduce((sum, b) => sum + Math.max(0, Math.min(at.x + def.width + 16, b.x + b.width) - Math.max(at.x - 16, b.x)) * Math.max(0, Math.min(at.y + def.height + 16, b.y + b.height) - Math.max(at.y - 16, b.y)), 0);
    if (overlap < bestOverlap) { best = { x: Math.round(at.x), y: Math.round(at.y) }; bestOverlap = overlap; }
    if (!overlap) break;
  }
  return best;
}

function canvasBindViewport(page) {
  const paper = canvasState.paper, world = page.querySelector("#canvas-world");
  if (!paper || !world) return;
  let drag = null, boxDrag = null, selectionBox = null;
  paper.on("blank:pointerdown", (evt) => {
    // 空白左拖是最常用的平移；Shift+拖拽才进入框选，中键与 Space 也可平移。
    const pan = evt.button === 1 || canvasState.spacePanning || (!evt.shiftKey && !canvasState.marqueeMode);
    if (evt.button !== undefined && evt.button !== 0 && evt.button !== 1) return;
    if (canvasState.inspectorOpen) { canvasState.inspectorOpen = false; canvasRenderInspector(false); }
    if (!pan) {
      boxDrag = { x: evt.clientX, y: evt.clientY };
      selectionBox = document.createElement("div"); selectionBox.className = "canvas-selection-box"; page.querySelector("#canvas-viewport").appendChild(selectionBox);
      return;
    }
    drag = { x: evt.clientX, y: evt.clientY, tx: canvasState.x, ty: canvasState.y };
    world.classList.add("dragging");
  });
  paper.on("blank:pointermove", (evt) => {
    if (boxDrag && selectionBox) {
      const left = Math.min(boxDrag.x, evt.clientX), top = Math.min(boxDrag.y, evt.clientY), width = Math.abs(evt.clientX - boxDrag.x), height = Math.abs(evt.clientY - boxDrag.y);
      const rect = page.querySelector("#canvas-viewport").getBoundingClientRect(); selectionBox.style.left = (left - rect.left) + "px"; selectionBox.style.top = (top - rect.top) + "px"; selectionBox.style.width = width + "px"; selectionBox.style.height = height + "px"; return;
    }
    if (!drag) return;
    canvasState.x = drag.tx + evt.clientX - drag.x;
    canvasState.y = drag.ty + evt.clientY - drag.y;
    paper.translate(canvasState.x, canvasState.y);
  });
  paper.on("blank:pointerup", (evt) => {
    if (boxDrag) {
      const left = Math.min(boxDrag.x, evt.clientX), right = Math.max(boxDrag.x, evt.clientX), top = Math.min(boxDrag.y, evt.clientY), bottom = Math.max(boxDrag.y, evt.clientY);
      const hit = (canvasState.graph?.getElements?.() || []).filter((node) => {
        const rect = node.findView(canvasState.paper)?.el?.getBoundingClientRect();
        return rect && rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
      }).map((node) => node.id);
      selectionBox?.remove(); selectionBox = null;
      const tiny = Math.abs(evt.clientX - boxDrag.x) < 4 && Math.abs(evt.clientY - boxDrag.y) < 4;
      boxDrag = null;
      // 按着 Shift 在空白处点一下（没拖动）：当成「取消选中」，不要把整张画布清空得莫名其妙
      canvasSetSelection(tiny ? new Set() : new Set(hit));
      if (!tiny) canvasToast(hit.length ? `框选中 ${hit.length} 个节点。Shift/${modKeyName()} 点节点可加选减选，Delete 删除。` : "这个框里没有节点。", hit.length ? "square-dashed" : "info");
      return;
    }
    drag = null; world.classList.remove("dragging");
  });
  if (canvasState.wheelHandler) world.removeEventListener("wheel", canvasState.wheelHandler);
  canvasState.wheelHandler = (evt) => {
    // 卡内的多行文本、播放器保留自己的滚动行为。
    if (evt.target?.closest?.("textarea, input, select, video, audio, [contenteditable=true]")) { evt.stopPropagation(); return; }
    evt.preventDefault();
    canvasState.wheelQueue.push({ deltaX: Number(evt.deltaX) || 0, deltaY: Number(evt.deltaY) || 0, deltaMode: evt.deltaMode, ctrlKey: evt.ctrlKey, metaKey: evt.metaKey, clientX: evt.clientX, clientY: evt.clientY });
    if (canvasState.wheelFrame === null) canvasState.wheelFrame = requestAnimationFrame(() => canvasFlushWheel(page));
  };
  world.addEventListener("wheel", canvasState.wheelHandler, { passive: false });
  const viewport = page.querySelector("#canvas-viewport");
  if (!viewport) return;
  const clearDropState = () => viewport.classList.remove("is-drop-target");
  viewport.addEventListener("dragenter", (evt) => { if (evt.dataTransfer?.types?.includes("Files")) { evt.preventDefault(); viewport.classList.add("is-drop-target"); } });
  viewport.addEventListener("dragover", (evt) => { if (evt.dataTransfer?.types?.includes("Files")) { evt.preventDefault(); evt.dataTransfer.dropEffect = "copy"; viewport.classList.add("is-drop-target"); } });
  viewport.addEventListener("dragleave", (evt) => { if (!viewport.contains(evt.relatedTarget)) clearDropState(); });
  viewport.addEventListener("drop", async (evt) => {
    evt.preventDefault(); clearDropState();
    const files = Array.from(evt.dataTransfer?.files || []).filter((file) => ["image", "video", "audio"].includes(canvasFileKind(file.name)) || /^(image|video|audio)\//i.test(file.type));
    if (!files.length) { canvasToast("只支持图片、视频或音频文件。", "circle-x", "err"); return; }
    const point = canvasState.paper?.clientToLocalPoint ? canvasState.paper.clientToLocalPoint({ x: evt.clientX, y: evt.clientY }) : { x: 260, y: 220 };
    for (const [index, file] of files.slice(0, 6).entries()) {
      try {
        const kind = canvasFileKind(file.name) === "note" ? String(file.type || "").split("/")[0] : canvasFileKind(file.name);
        const name = await canvasUploadWorkspaceFile(file);
        const def = CANVAS_NODE_DEFS[kind];
        const node = canvasAddNode(kind, { title: file.name, path: name, url: name, role: "拖入素材", tags: "" }, { x: Math.max(20, point.x + index * 26 - (def.width || 320) / 2), y: Math.max(20, point.y + index * 26 - (def.height || 220) / 2) });
        if (node) canvasToast(name !== file.name ? canvasT("工作区里已有同名文件，这一份存成了 {n}，原来那份没动。", { n: name }) : `${file.name} 已添加到画布。`, "plus");
      } catch (error) { canvasToast(`上传失败：${String(error.message || error).slice(0, 140)}`, "circle-x", "err"); }
    }
    canvasLoadLibrary();
  });
  viewport.addEventListener("contextmenu", (evt) => {
    if (evt.target.closest(".canvas-joint-node,button,input,textarea,select,details")) return;
    evt.preventDefault(); canvasOpenContextMenu(evt.clientX, evt.clientY);
  });
  // Delete / Escape / ⌘A / Space 平移 这几手都挂在 #assist-page 上，而点节点、点空白之后
  // activeElement 一直是 <body>——按键根本不经过这个元素。所以选中看得见，
  // 按 Delete 没反应，⌘A 也没反应。在画布上点一下就把焦点收过来
  page.setAttribute("tabindex", "-1");
  viewport.addEventListener("mousedown", (evt) => {
    // 正在输入或者点的是控件：那些本来就在 page 里面，键盘事件照样冒上来，别抢
    if (evt.target?.closest?.("input,textarea,select,button,a,[contenteditable=true]")) return;
    page.focus({ preventScroll: true });
  }, true);
  canvasState.keyHandler = (evt) => {
    const target = evt.target, editing = target && (target.matches?.("input,textarea,select,[contenteditable=true]") || target.closest?.("input,textarea,select,[contenteditable=true]"));
    if (editing) return;
    if (evt.code === "Space") { canvasState.spacePanning = true; return; }
    const command = evt.metaKey || evt.ctrlKey;
    if (command && evt.key.toLowerCase() === "z") {
      evt.preventDefault();
      if (evt.shiftKey) canvasRedo(); else canvasUndo();
    } else if (command && evt.key.toLowerCase() === "y") {
      evt.preventDefault(); canvasRedo();
    } else if (command && evt.key.toLowerCase() === "d") {
      evt.preventDefault(); canvasDuplicateSelection();
    } else if (command && evt.key.toLowerCase() === "a") {
      evt.preventDefault();
      const nodes = canvasState.graph?.getElements?.() || [];
      canvasSetSelection(nodes.map((node) => node.id));
      canvasToast(nodes.length ? `已全选 ${nodes.length} 个节点。按 Delete 可删除。` : "画布里还没有节点。", nodes.length ? "square-dashed" : "info");
    } else if (evt.key === "Escape" && (canvasState.selectedIds.size || canvasState.marqueeMode)) {
      // 多选之后得有个出口。没有的话只能去点别的节点，那又变成选中了那一个
      evt.preventDefault();
      canvasState.marqueeMode = false;
      document.querySelector("[data-canvas-marquee]")?.classList.remove("is-active");
      document.querySelector("#canvas-viewport")?.classList.remove("is-marquee");
      canvasSetSelection(new Set());
    } else if ((evt.key === "/" || evt.code === "Slash") && !command && !evt.shiftKey) {
      // 中文输入法下这颗键出来的是「、」，所以 code 也要认
      evt.preventDefault(); canvasOpenPalette();
    } else if ((evt.key === "Backspace" || evt.key === "Delete") && canvasState.selectedIds.size) {
      evt.preventDefault();
      canvasDeleteSelection();
    }
  };
  canvasState.keyUpHandler = (evt) => { if (evt.code === "Space") canvasState.spacePanning = false; };
  page.addEventListener("keydown", canvasState.keyHandler);
  page.addEventListener("keyup", canvasState.keyUpHandler);
}
