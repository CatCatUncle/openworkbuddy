// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
/* 无限画布 · 创作工具（第 10 片）
 *
 * `/` 快捷面板、宫格切分、工作流、批量做视频。
 * 这些都只组合已有的节点、连线和批量生成，不另造存储格式。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
 */

// ── `/` 快捷面板 ────────────────────────────────────────────────────────────
function canvasPaletteItems() {
  const page = document.getElementById("assist-page");
  const nodes = Object.entries(CANVAS_NODE_DEFS).map(([kind, def]) => ({
    icon: def.icon, label: canvasT(def.label), group: canvasT(def.group),
    run: (client) => canvasAddNode(kind, {}, canvasNewNodePosition(kind, client)),
  }));
  const flows = (canvasState.workflows || []).map((flow) => ({
    icon: "layout-grid", label: flow.name, group: canvasT("工作流 · {n} 张卡", { n: flow.nodes.length }), flow,
    run: (client) => canvasInsertWorkflow(flow, client),
  }));
  const actions = [
    { icon: "upload", label: canvasT("导入素材"), group: canvasT("操作"), run: () => page?.querySelector("[data-canvas-import-file]")?.click() },
    { icon: "maximize-2", label: canvasT("看全图"), group: canvasT("操作"), run: () => canvasFitAll(page) },
    { icon: "clapperboard", label: canvasT("短剧工作流"), group: canvasT("操作"), run: () => canvasCreateDramaWorkflow() },
  ];
  return [...flows, ...nodes, ...actions];
}

function canvasPaletteClose() { canvasState.paletteClose?.(); }

function canvasOpenPalette(client) {
  canvasPaletteClose(); canvasContextMenuClose();
  const box = document.createElement("div");
  box.id = "canvas-palette"; box.className = "canvas-palette"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", canvasT("添加到画布"));
  box.innerHTML = `<input type="text" data-canvas-palette-input placeholder="${esc(canvasT("搜索节点、工作流或操作"))}" aria-label="${esc(canvasT("搜索节点、工作流或操作"))}" autocomplete="off"><div class="canvas-palette-list" role="listbox"></div>`;
  document.body.appendChild(box);
  const anchor = client || canvasState.pointer || { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  const rect = box.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - 340))}px`;
  const input = box.querySelector("input"), list = box.querySelector(".canvas-palette-list");
  let rows = [], active = 0;
  const close = () => {
    box.remove(); document.removeEventListener("pointerdown", outside, true);
    if (canvasState.paletteClose === close) canvasState.paletteClose = null;
  };
  const outside = (event) => { if (!box.contains(event.target)) close(); };
  const pick = (row) => { if (!row) return; close(); row.run(client || canvasState.pointer); };
  const paint = () => {
    const word = input.value.trim().toLowerCase();
    rows = canvasPaletteItems().filter((row) => !word || `${row.label} ${row.group}`.toLowerCase().includes(word));
    active = Math.max(0, Math.min(active, rows.length - 1));
    list.innerHTML = rows.length
      ? rows.map((row, i) => `<div class="canvas-palette-row${i === active ? " is-active" : ""}" role="option" aria-selected="${i === active}" data-i="${i}">${ic(row.icon)}<span>${esc(row.label)}</span><small>${esc(row.group)}</small>${row.flow ? `<button type="button" data-canvas-flow-delete="${i}" aria-label="${esc(canvasT("删除工作流"))}" title="${esc(canvasT("删除工作流"))}">${ic("x")}</button>` : ""}</div>`).join("")
      : `<div class="canvas-palette-empty">${esc(canvasT("没有匹配的项目"))}</div>`;
    list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => { active = 0; paint(); });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" && !imeKey(event)) { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); active = rows.length ? (active + 1) % rows.length : 0; paint(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); active = rows.length ? (active - 1 + rows.length) % rows.length : 0; paint(); }
    else if (event.key === "Enter" && !imeKey(event)) { event.preventDefault(); pick(rows[active]); }
  });
  list.addEventListener("click", async (event) => {
    const remove = event.target.closest("[data-canvas-flow-delete]");
    if (remove) { event.stopPropagation(); await canvasDeleteWorkflow(rows[Number(remove.dataset.canvasFlowDelete)]?.flow); paint(); return; }
    const row = event.target.closest("[data-i]"); if (row) pick(rows[Number(row.dataset.i)]);
  });
  canvasState.paletteClose = close;
  paint(); input.focus();
  document.addEventListener("pointerdown", outside, true);
  canvasLoadWorkflows().then(() => { if (canvasState.paletteClose === close) paint(); });
}

// ── 宫格切分 ────────────────────────────────────────────────────────────────
const CANVAS_GRID_CHOICES = [[2, 2], [3, 3], [4, 4], [1, 2], [1, 3], [2, 1], [3, 1], [2, 3], [3, 2]];

/** 切线取整后每格首尾相接：直接按比例四舍五入宽度，累计误差会让最后一列缺一条边。 */
function canvasGridRects(width, height, rows, cols) {
  const out = [], xs = (i) => Math.round(width * i / cols), ys = (i) => Math.round(height * i / rows);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) out.push({ r, c, x: xs(c), y: ys(r), width: xs(c + 1) - xs(c), height: ys(r + 1) - ys(r) });
  return out;
}

function canvasOpenGridMenu(node, clientX, clientY) {
  canvasContextMenuClose();
  const menu = document.createElement("div"); menu.id = "canvas-context-menu"; menu.className = "canvas-context-menu canvas-grid-menu";
  menu.innerHTML = CANVAS_GRID_CHOICES.map(([rows, cols]) => `<button type="button" data-canvas-grid="${rows}x${cols}"><span class="canvas-grid-icon" style="--rows:${rows};--cols:${cols}">${"<i></i>".repeat(rows * cols)}</span><span>${esc(canvasT("{r} 行 {c} 列", { r: rows, c: cols }))}</span></button>`).join("");
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;
  const close = (event) => {
    if (event?.type === "pointerdown" && menu.contains(event.target)) return;
    menu.remove(); document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", onKey, true);
    if (canvasState.contextMenuClose === close) canvasState.contextMenuClose = null;
  };
  const onKey = (event) => { if (event.key === "Escape" && !imeKey(event)) close(); };
  canvasState.contextMenuClose = close;
  menu.querySelectorAll("[data-canvas-grid]").forEach((button) => button.addEventListener("click", () => {
    const [rows, cols] = button.dataset.canvasGrid.split("x").map(Number); close(); canvasSplitGrid(node, rows, cols);
  }));
  document.addEventListener("pointerdown", close, true); document.addEventListener("keydown", onKey, true);
}

async function canvasSplitGrid(node, rows, cols) {
  const payload = canvasPayload(node), file = canvasMediaPath(payload), scope = canvasScope(), graph = canvasState.graph;
  if (!file || !canvasMediaAvailable(file)) { canvasToast(canvasT("请先生成或导入一张可用图片"), "info"); return []; }
  canvasToast(canvasT("正在切分…"), "loader-circle");
  try {
    const image = new Image(); image.src = canvasFileUrl(file); await image.decode();
    const stem = String(file).split(/[\\/]/).pop().replace(/\.[^.]+$/, "") || "image", saved = [];
    for (const tile of canvasGridRects(image.naturalWidth, image.naturalHeight, rows, cols)) {
      const surface = document.createElement("canvas"); surface.width = tile.width; surface.height = tile.height;
      surface.getContext("2d").drawImage(image, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height);
      // 外链图片会污染画布，toBlob 直接抛错，走下面的失败提示
      const blob = await new Promise((resolve, reject) => { try { surface.toBlob((b) => (b ? resolve(b) : reject(new Error(canvasT("图片读取失败")))), "image/png"); } catch (error) { reject(error); } });
      const name = `${stem}-${tile.r + 1}-${tile.c + 1}.png`;
      saved.push({ ...tile, name, path: await canvasUploadWorkspaceFile(new File([blob], name, { type: "image/png" })) });
    }
    if (graph !== canvasState.graph || scope !== canvasScope() || graph.getCell(node.id) !== node) { canvasToast(canvasT("素材已上传到原项目，画布已切换，没有放入当前画布。"), "info"); return []; }
    const def = CANVAS_NODE_DEFS.image, at = node.position(), left = at.x + node.size().width + 96, made = [];
    canvasHistoryFlush(); graph.startBatch("canvas-edit");
    try {
      for (const tile of saved) {
        const piece = canvasAddNode("image", { title: tile.name, path: tile.path, url: tile.path, role: "宫格切片" }, { x: left + tile.c * (def.width + 32), y: at.y + tile.r * (def.height + 32) }, { persist: false, skipSelect: true });
        if (piece) { canvasConnect(node, piece, "split"); made.push(piece); }
      }
    } finally { graph.stopBatch("canvas-edit"); }
    canvasFitFlush(); canvasSetSelection(made.map((piece) => piece.id)); canvasPersist(); canvasHistoryFlush();
    canvasCenterSelected(document.getElementById("assist-page")); canvasLoadLibrary();
    canvasToast(canvasT("已切成 {n} 张，原图保留。", { n: made.length }), "circle-check");
    return made;
  } catch (error) {
    canvasToast(`${canvasT("切分失败")}：${String(error.message || error).slice(0, 160)}`, "circle-x", "err");
    return [];
  }
}

// ── 工作流 ──────────────────────────────────────────────────────────────────
// 工作流只留做法（提示词、型号、参数、连线），不留这次的素材和回执：
// 带着旧结果插到新画布，既会把别的片子的图当成已完成，也可能收错待取的任务。
const CANVAS_FLOW_DROP = ["generation", "generation_runs", "pending_jobs", "board", "board_scene", "board_shot", "board_character", "path", "file", "url", "video", "audio", "first_frame", "last_frame", "reference", "image", "sourceId"];

function canvasWorkflowDraft(nodes) {
  const box = canvasNodeBounds(nodes), keys = new Map(nodes.map((node, i) => [node.id, String(i)]));
  const items = nodes.map((node) => {
    const kind = canvasKind(node), payload = JSON.parse(JSON.stringify(canvasPayload(node))), at = node.position();
    for (const key of CANVAS_FLOW_DROP) delete payload[key];
    if (["shot", "character", "location"].includes(kind)) delete payload.id;
    return { key: keys.get(node.id), kind, payload, x: Math.round(at.x - box.x), y: Math.round(at.y - box.y) };
  });
  const edges = canvasSnapshot().edges.map((edge) => ({ source: keys.get(canvasEndpointId(edge.source)), target: keys.get(canvasEndpointId(edge.target)), relation: edge.relation })).filter((edge) => edge.source && edge.target);
  return { nodes: items, edges };
}

async function canvasLoadWorkflows() {
  const scope = canvasScope();
  const data = await fetch("/api/canvas/workflows").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (scope === canvasScope()) canvasState.workflows = Array.isArray(data?.workflows) ? data.workflows : [];
}

async function canvasSaveWorkflow() {
  const graph = canvasState.graph, nodes = [...canvasState.selectedIds].map((id) => graph?.getCell(id)).filter((node) => node?.isElement?.());
  if (!nodes.length) return null;
  if (canvasState.inlineEdit) canvasInlineCommit();
  const draft = canvasWorkflowDraft(nodes);
  const name = await askText({ title: canvasT("存为工作流"), hint: canvasT("保留提示词、型号、参数和连线，不带素材和生成结果。"), placeholder: canvasT("比如：产品图转短视频"), ok: canvasT("保存") });
  if (!name) return null;
  const response = await fetch("/api/canvas/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, ...draft }) }).catch(() => null);
  const data = await response?.json().catch(() => ({}));
  if (!response?.ok) { canvasToast(data?.error || canvasT("工作流保存失败"), "circle-x", "err"); return null; }
  await canvasLoadWorkflows();
  canvasToast(canvasT("已保存。按 / 可插入这个工作流。"), "circle-check");
  return data.workflow;
}

function canvasInsertWorkflow(flow, client) {
  const graph = canvasState.graph; if (!graph || !flow?.nodes?.length) return [];
  if (graph.getElements().length + flow.nodes.length > 500) { canvasToast(canvasT("画布节点太多，放不下这个工作流。"), "triangle-alert", "err"); return []; }
  canvasHistoryFlush();
  const at = canvasNewNodePosition(flow.nodes[0].kind, client), made = new Map();
  graph.startBatch("canvas-edit");
  try {
    for (const item of flow.nodes) {
      if (!CANVAS_NODE_DEFS[item.kind]) continue;
      const node = canvasAddNode(item.kind, JSON.parse(JSON.stringify(item.payload || {})), { x: at.x + item.x, y: at.y + item.y }, { persist: false, skipSelect: true });
      if (node) made.set(item.key, node);
    }
    for (const edge of flow.edges || []) { const a = made.get(edge.source), b = made.get(edge.target); if (a && b) canvasConnect(a, b, edge.relation); }
  } finally { graph.stopBatch("canvas-edit"); }
  const nodes = [...made.values()];
  canvasFitFlush(); canvasSetSelection(nodes.map((node) => node.id)); canvasPersist(); canvasHistoryFlush();
  canvasCenterSelected(document.getElementById("assist-page"));
  return nodes;
}

async function canvasDeleteWorkflow(flow) {
  if (!flow) return;
  const yes = await askConfirm({ title: canvasT("删除工作流「{n}」？", { n: flow.name }), hint: "已插入画布的卡片不受影响。", ok: "删除", danger: true });
  if (!yes) return;
  await fetch("/api/canvas/workflows/" + encodeURIComponent(flow.id), { method: "DELETE" }).catch(() => null);
  await canvasLoadWorkflows();
}

// ── 批量 ────────────────────────────────────────────────────────────────────
function canvasSelectedNodes() {
  const graph = canvasState.graph;
  return [...canvasState.selectedIds].map((id) => graph?.getCell(id)).filter((node) => node?.isElement?.());
}

/** 每张图接一张视频卡，图作首帧。只建卡不扣费：描述写好后再点批量生成。 */
function canvasBatchVideo() {
  const graph = canvasState.graph, sources = canvasSelectedNodes().filter((node) => canvasUpstreamImage({ node, kind: canvasKind(node), path: canvasMediaPath(canvasPayload(node)) }));
  if (!sources.length) return [];
  canvasHistoryFlush(); graph.startBatch("canvas-edit");
  const made = [];
  try {
    for (const source of sources) {
      const at = source.position();
      const card = canvasAddNode("video", { ...canvasMediaDefaults("video"), title: canvasT("让画面动起来"), prompt: "" }, { x: at.x + source.size().width + 96, y: at.y }, { persist: false, skipSelect: true });
      if (card) { canvasConnect(source, card, "first_frame"); made.push(card); }
    }
  } finally { graph.stopBatch("canvas-edit"); }
  canvasFitFlush(); canvasSetSelection(made.map((node) => node.id)); canvasPersist(); canvasHistoryFlush();
  canvasCenterSelected(document.getElementById("assist-page"));
  canvasToast(canvasT("已建 {n} 张视频卡。写好描述后点批量生成。", { n: made.length }), "circle-check");
  return made;
}

function canvasBatchKind(nodes) {
  const kinds = new Set(nodes.map(canvasKind));
  return kinds.size === 1 && (kinds.has("image") || kinds.has("video")) ? [...kinds][0] : "";
}

function canvasBatchPrompt(text) {
  const value = String(text || "").trim(), nodes = canvasSelectedNodes(), graph = canvasState.graph;
  if (!value || !canvasBatchKind(nodes)) return;
  canvasHistoryFlush(); graph.startBatch("canvas-edit");
  try { nodes.forEach((node) => { node.set("canvasPayload", { ...canvasPayload(node), prompt: value }); canvasRefreshNode(node); }); }
  finally { graph.stopBatch("canvas-edit"); }
  canvasPersist(); canvasHistoryFlush();
}

async function canvasBatchGenerate() {
  const nodes = canvasSelectedNodes(), kind = canvasBatchKind(nodes); if (!kind) return false;
  const blank = nodes.filter((node) => !String(canvasPayload(node).prompt || "").trim());
  if (blank.length) { canvasToast(canvasT("{n} 张卡还没写描述。", { n: blank.length }), "triangle-alert", "err"); canvasProgressFocus(blank.map((node) => node.id)); return false; }
  // 上一单没收回来的不进这一批，否则同一张卡买两次（理由同 canvasRunPending）
  const waiting = nodes.filter((node) => canvasPendingJob(canvasPayload(node), kind)), queue = nodes.filter((node) => !waiting.includes(node));
  if (!queue.length) { canvasToast(canvasT("{n} 格的上一单还没收到结果，先在卡片上点「看结果」。", { n: waiting.length }), "triangle-alert", "err"); return false; }
  return canvasRunQueue(kind, queue, [], waiting.length ? `，${waiting.length} 个上一单没收到结果，没排进来` : "");
}

/** 多选工具条上的这几样。列在这里，让工具条本身只管排版和整理。 */
function canvasSelectionExtras(box, selected, images) {
  const kind = canvasBatchKind(selected);
  const html = `${images ? `<button type="button" class="canvas-selection-action" data-canvas-batch-video>${ic("video")}<span>${esc(canvasT("批量做视频"))}</span></button>` : ""}`
    + `${kind ? `<input type="text" data-canvas-batch-prompt placeholder="${esc(canvasT("给选中的卡写同一段描述"))}" aria-label="${esc(canvasT("给选中的卡写同一段描述"))}"><button type="button" class="canvas-selection-action" data-canvas-batch-run>${ic("sparkles")}<span>${esc(canvasT("批量生成"))}</span></button>` : ""}`
    + `<button type="button" class="canvas-selection-action" data-canvas-flow-save>${ic("layout-grid")}<span>${esc(canvasT("存为工作流"))}</span></button>`;
  box.insertAdjacentHTML("beforeend", html);
  box.querySelector("[data-canvas-batch-video]")?.addEventListener("click", canvasBatchVideo);
  box.querySelector("[data-canvas-flow-save]")?.addEventListener("click", canvasSaveWorkflow);
  box.querySelector("[data-canvas-batch-run]")?.addEventListener("click", canvasBatchGenerate);
  const prompt = box.querySelector("[data-canvas-batch-prompt]");
  prompt?.addEventListener("keydown", (event) => { event.stopPropagation(); if (event.key === "Enter" && !imeKey(event)) { event.preventDefault(); canvasBatchPrompt(prompt.value); } });
  prompt?.addEventListener("change", () => canvasBatchPrompt(prompt.value));
}

function canvasBindTools(page) {
  const viewport = page.querySelector("#canvas-viewport"), paper = canvasState.paper;
  viewport?.addEventListener("pointermove", (event) => { canvasState.pointer = { x: event.clientX, y: event.clientY }; }, { passive: true });
  paper.on("blank:pointerdblclick", (event) => canvasOpenPalette({ x: event.clientX, y: event.clientY }));
}

function canvasToolsDestroy() {
  canvasPaletteClose();
  canvasState.workflows = []; canvasState.pointer = null;
}
