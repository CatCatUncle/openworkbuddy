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
  const factor = evt.deltaMode === 1 || Math.abs(dy) >= 50 ? (dy > 0 ? .92 : 1.08) : Math.exp(-Math.max(-10, Math.min(10, dy)) * .01);
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

function canvasFitToBox(page, box, padding = 64, minScale = .12) {
  const viewport = page?.querySelector("#canvas-viewport"), paper = canvasState.paper;
  if (!viewport || !paper || !box || !box.width || !box.height) return;
  const inspector = page.querySelector(".canvas-layout:not(.canvas-inspector-hidden) .canvas-inspector");
  const inspectorWidth = inspector && inspector.offsetParent !== null ? inspector.offsetWidth + 24 : 0;
  // 对话框在 viewport 外面，不能再从可视高度扣一次；那会把新画布错误缩到 20%。
  const vw = Math.max(280, viewport.clientWidth - inspectorWidth), vh = Math.max(220, viewport.clientHeight);
  const scale = Math.max(minScale, Math.min(1.6, (vw - padding * 2) / box.width, (vh - padding * 2) / box.height));
  canvasState.scale = scale;
  canvasState.x = (vw - box.width * scale) / 2 - box.x * scale;
  canvasState.y = (vh - box.height * scale) / 2 - box.y * scale;
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
  const b = node.getBBox(), viewport = page?.querySelector("#canvas-viewport");
  if (!viewport || !canvasState.paper) return;
  const vw = Math.max(320, viewport.clientWidth), vh = Math.max(260, viewport.clientHeight), scale = canvasState.scale || 1;
  canvasState.x = vw / 2 - (b.x + b.width / 2) * scale; canvasState.y = vh / 2 - (b.y + b.height / 2) * scale;
  canvasState.paper.translate(canvasState.x, canvasState.y);
}

function canvasAutoLayout(page) {
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
  canvasState.historyMute = true;
  try {
    nodes.forEach((node) => { const point = layoutGraph.node(node.id), size = node.size(); if (point) node.position(Math.round(point.x - size.width / 2), Math.round(point.y - size.height / 2)); });
  } finally { canvasState.historyMute = false; }
  canvasPersist(); canvasFitAll(page); canvasToast("已按生成关系紧凑排版并居中。", "git-branch");
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
      if (!tiny) canvasToast(hit.length ? `框选中 ${hit.length} 个节点。Shift/⌘ 点节点可加选减选，Delete 删除。` : "这个框里没有节点。", hit.length ? "square-dashed" : "info");
      return;
    }
    drag = null; world.classList.remove("dragging");
  });
  if (canvasState.wheelHandler) world.removeEventListener("wheel", canvasState.wheelHandler);
  canvasState.wheelHandler = (evt) => { evt.preventDefault(); canvasWheel(page, evt); };
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
        if (node) canvasToast(`${file.name} 已添加到画布。`, "plus");
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
    } else if ((evt.key === "Backspace" || evt.key === "Delete") && canvasState.selectedIds.size) {
      evt.preventDefault();
      // 跟右键菜单的删除（canvasDeleteSelection）是同一件事：先记下删之前那一步，删完挂「撤销」。
      // 这段留在键盘处理里原地写，是因为前端测试按起止标记把这一段单独切出来跑
      if (typeof canvasHistoryFlush === "function") canvasHistoryFlush();
      const ids = new Set(canvasState.selectedIds), gone = (canvasState.graph?.getElements?.() || []).filter((node) => ids.has(node.id));
      gone.forEach((node) => node.remove());
      canvasState.selectedAll = false; canvasState.selectedIds = new Set(); canvasState.selected = null; canvasRenderInspector(); canvasPersist();
      if (gone.length) canvasToast("节点已删除。", "trash-2", undefined, { label: "撤销", run: canvasUndo });
    }
  };
  canvasState.keyUpHandler = (evt) => { if (evt.code === "Space") canvasState.spacePanning = false; };
  page.addEventListener("keydown", canvasState.keyHandler);
  page.addEventListener("keyup", canvasState.keyUpHandler);
}
