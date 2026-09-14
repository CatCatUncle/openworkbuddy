/* 通用无限画布
 *
 * JointJS 只负责画布/节点/连线交互；这里负责 AI 短剧创作工作流的数据。
 * 一张画布可以同时放剧本、角色、场景、镜头、参考素材、生成结果、音频和时间线，
 * 节点数据保存到本地，节点之间的连线表示“这个输入喂给下一个创作步骤”。
 */
const CANVAS_STORAGE_KEY = "openworkbuddy.canvas.v3";

const CANVAS_NODE_DEFS = {
  note: { label: "笔记", icon: "notebook-pen", width: 340, height: 205, subtitle: "自由记录想法与任务", group: "策划" },
  script: { label: "剧本", icon: "file-text", width: 360, height: 250, subtitle: "故事、对白、创作目标", group: "策划" },
  agent: { label: "Agent任务", icon: "bot", width: 360, height: 220, subtitle: "可审核、可重跑的协作任务", group: "策划" },
  character: { label: "角色", icon: "user", width: 340, height: 300, subtitle: "人物设定与参考", group: "世界设定" },
  location: { label: "场景", icon: "map-pin", width: 340, height: 285, subtitle: "地点、时间与氛围", group: "世界设定" },
  storyboard: { label: "分镜表", icon: "clapperboard", width: 350, height: 235, subtitle: "short-drama 业务节点", group: "分镜制作" },
  scene: { label: "场次", icon: "film", width: 380, height: 255, subtitle: "场次下的镜头集合", group: "分镜制作" },
  shot: { label: "镜头", icon: "video", width: 360, height: 260, subtitle: "可生成、可重跑的最小单元", group: "分镜制作" },
  image: { label: "参考图", icon: "image", width: 340, height: 330, subtitle: "角色、场景或首帧", group: "素材与生成" },
  video: { label: "视频片段", icon: "video", width: 380, height: 390, subtitle: "生成结果或本地素材", group: "素材与生成" },
  audio: { label: "声音", icon: "music", width: 320, height: 220, subtitle: "对白、配音或音乐", group: "素材与生成" },
  timeline: { label: "剪辑时间线", icon: "film", width: 380, height: 240, subtitle: "本项目 AI 剪辑时间线", group: "交付" },
};

const CANVAS_REFERENCE_USES = [
  ["character", "人物"], ["background", "背景"], ["motion", "动作参考"], ["style", "画面风格"],
  ["first_frame", "首帧"], ["last_frame", "尾帧"], ["audio", "声音"], ["reference", "其他参考"],
];

let canvasState = {
  graph: null, paper: null, wheelHandler: null, scale: 1, x: 0, y: 0, next: 1,
  boards: [], files: [], busy: new Set(), selected: null, selectedIds: new Set(), nodeType: null,
  selectedAll: false, keyHandler: null, keyUpHandler: null, fullscreenHandler: null, spacePanning: false,
  inspectorOpen: false, nodeGesture: null, multiMove: null, skipNodeClick: null, suppressInspectorUntil: 0,
  remoteUpdatedAt: 0, remoteSnapshot: null, remoteTimer: null, remoteWriteTimer: null, remoteWritePending: false, suspendSync: false,
  canvasName: "main", canvasList: [], taskSessionId: null, chatBusy: false, chatStopping: false, chatReferences: new Map(), history: [], historyIndex: -1, historyTimer: null, historyMute: false,
  workspaceProjects: [], workspaceLocked: false, workspaceName: "", workspaceDir: "",
};

function canvasToast(text, icon, kind) {
  if (typeof toast === "function") return toast(text, icon || (kind === "err" ? "circle-x" : "circle-check"));
  console[kind === "err" ? "error" : "log"](text);
}

function canvasType(J) {
  if (canvasState.nodeType) return canvasState.nodeType;
  canvasState.nodeType = J.dia.Element.define("openworkbuddy.CanvasNode", {
    attrs: {
      body: { width: "calc(w)", height: "calc(h)", fill: "transparent", stroke: "transparent", pointerEvents: "none" },
      foreignObject: { width: "calc(w)", height: "calc(h)", overflow: "visible" },
    },
  }, {
    markup: [{ tagName: "rect", selector: "body" }, {
      tagName: "foreignObject", selector: "foreignObject", attributes: { overflow: "visible" },
      children: [{ tagName: "div", namespaceURI: "http://www.w3.org/1999/xhtml", selector: "card", className: "canvas-joint-node" }],
    }],
  });
  return canvasState.nodeType;
}

function canvasPayload(node) { return { ...(node && node.get("canvasPayload") || {}) }; }
function canvasKind(node) { return String(node && node.get("canvasKind") || "note"); }
function canvasEndpointId(endpoint) {
  if (typeof endpoint === "string") return endpoint.trim();
  if (!endpoint || typeof endpoint !== "object") return String(endpoint || "").trim();
  return String(endpoint.id || endpoint.cell || "").trim();
}
function canvasNodeLabel(node) {
  const kind = canvasKind(node), p = canvasPayload(node);
  return String(p.title || p.name || p.id || CANVAS_NODE_DEFS[kind]?.label || "节点");
}
function canvasSafeText(value, fallback = "") { return String(value == null ? fallback : value); }
function canvasResolvedFileName(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(https?:|data:|\/api\/files\/view\/)/i.test(raw)) return raw;
  const files = Array.isArray(canvasState.files) ? canvasState.files : [];
  const hit = files.find((file) => {
    const name = String(file.name || file.path || "");
    return name === raw || name.endsWith("/" + raw) || name.split(/[\\/]/).pop() === raw.split(/[\\/]/).pop();
  });
  return hit ? String(hit.name || hit.path) : raw;
}
function canvasFileUrl(value) {
  const name = canvasResolvedFileName(value);
  if (!name) return "";
  if (/^(https?:|data:|\/api\/files\/view\/)/i.test(name)) return name;
  return "/api/files/view/" + name.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join("/");
}
function canvasMediaPath(payload) { return String(payload && (payload.path || payload.file || payload.url || payload.video || payload.audio || "") || "").trim(); }
function canvasMediaMime(value) {
  const name = String(value || "").split(/[?#]/)[0].toLowerCase();
  if (/\.wave?$/.test(name)) return "audio/wav";
  if (/\.m4a$/.test(name)) return "audio/mp4";
  if (/\.mp3$/.test(name)) return "audio/mpeg";
  if (/\.(ogg|oga)$/.test(name)) return "audio/ogg";
  if (/\.opus$/.test(name)) return "audio/ogg; codecs=opus";
  if (/\.flac$/.test(name)) return "audio/flac";
  if (/\.aac$/.test(name)) return "audio/aac";
  return "audio/*";
}
function canvasMediaAvailable(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(https?:|data:|\/api\/files\/view\/)/i.test(raw)) return Boolean(raw);
  const resolved = canvasResolvedFileName(raw);
  return canvasState.files.some((file) => String(file.name || file.path || "") === resolved);
}
function canvasAudioPreview(value) {
  const url = canvasFileUrl(value);
  if (!url) return "";
  return `<audio class="canvas-audio-preview" data-canvas-audio-preview data-canvas-media-path="${esc(value)}" controls preload="metadata"><source src="${esc(url)}" type="${esc(canvasMediaMime(value))}">此浏览器不支持音频预览。</audio>`;
}
function canvasOutputFilename(payload, kind) {
  const id = String(payload && (payload.id || payload.title || "镜头") || "镜头").replace(/[^\w\-一-龥]+/g, "_");
  return kind === "image" ? `镜头_${id}_首帧.png` : kind === "video" ? `镜头_${id}.mp4` : `配音_${id}.mp3`;
}

function canvasDefaultPayload(kind) {
  switch (kind) {
    case "script": return { title: "新剧本", text: "一句话概念、人物关系、冲突与结局…" };
    case "agent": return { title: "Agent任务", role: "导演 Agent", task: "根据上游剧本和素材生成可审核的短剧创作计划。", status: "待执行", approval: "先给方案，等我确认" };
    case "character": return { name: "新角色", role: "主角", description: "人物外形、性格、目标与关系…", reference: "" };
    case "location": return { name: "新场景", description: "地点、时间、天气、光线与氛围…" };
    case "shot": return { id: "S1-01", title: "新镜头", shot_size: "中景", duration: "4", prompt: "镜头内容与运动…", line: "对白或旁白…" };
    case "image": return { title: "参考图", url: "", role: "参考素材", tags: "", prompt: "这张图要保持的主体、风格与构图…" };
    case "video": return { title: "Video", url: "", role: "生成结果", tags: "", prompt: "描述你想生成的内容…", model: "", aspect_ratio: "16:9", resolution: "1080p", duration: "5s" };
    case "audio": return { title: "声音", url: "", role: "对白/音乐", tags: "", text: "对白、旁白或音乐说明…" };
    case "timeline": return { title: "最终剪辑", description: "把镜头按顺序交给本项目 Agent 生成时间线。" };
    case "scene": return { id: "S1", place: "未命名场景", time: "", shots: [] };
    default: return { title: "新笔记", text: "记录灵感、任务或需要补充的内容…" };
  }
}

function canvasZoom(page, value) {
  if (!canvasState.paper) return;
  canvasState.scale = Math.max(.12, Math.min(1.8, value));
  canvasState.paper.scale(canvasState.scale, canvasState.scale);
  const label = page.querySelector("#canvas-zoom");
  if (label) label.textContent = Math.round(canvasState.scale * 100) + "%";
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
  if (!elements.length) { canvasToast("画布里还没有节点。", "circle-info"); return; }
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
  if (!nodes.length) return canvasToast("画布里还没有节点。", "circle-info");
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
    const pan = evt.button === 1 || canvasState.spacePanning || !evt.shiftKey;
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
      canvasState.selectedIds = new Set((canvasState.graph?.getElements?.() || []).filter((node) => { const rect = node.findView(canvasState.paper)?.el?.getBoundingClientRect(); return rect && rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom; }).map((node) => node.id));
      canvasState.selectedAll = canvasState.selectedIds.size === (canvasState.graph?.getElements?.() || []).length && canvasState.selectedIds.size > 0; canvasState.selected = [...canvasState.selectedIds][0] || null; canvasState.inspectorOpen = false;
      selectionBox?.remove(); selectionBox = null; boxDrag = null; canvasRenderInspector(false); return;
    }
    drag = null; world.classList.remove("dragging");
  });
  if (canvasState.wheelHandler) world.removeEventListener("wheel", canvasState.wheelHandler);
  canvasState.wheelHandler = (evt) => { evt.preventDefault(); canvasZoom(page, canvasState.scale * (evt.deltaY > 0 ? .92 : 1.08)); };
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
      canvasState.selectedIds = new Set(nodes.map((node) => node.id));
      canvasState.selectedAll = nodes.length > 0;
      canvasState.selected = nodes[0]?.id || null;
      canvasRenderInspector(false);
      canvasToast(nodes.length ? `已全选 ${nodes.length} 个节点。按 Delete 可删除。` : "画布里还没有节点。", nodes.length ? "check-square" : "circle-info");
    } else if ((evt.key === "Backspace" || evt.key === "Delete") && canvasState.selectedIds.size) {
      evt.preventDefault();
      const ids = new Set(canvasState.selectedIds); (canvasState.graph?.getElements?.() || []).filter((node) => ids.has(node.id)).forEach((node) => node.remove());
      canvasState.selectedAll = false; canvasState.selectedIds = new Set(); canvasState.selected = null; canvasRenderInspector(); canvasPersist();
    }
  };
  canvasState.keyUpHandler = (evt) => { if (evt.code === "Space") canvasState.spacePanning = false; };
  page.addEventListener("keydown", canvasState.keyHandler);
  page.addEventListener("keyup", canvasState.keyUpHandler);
}

function canvasField(label, key, value, type = "text", placeholder = "") {
  if (type === "textarea") return `<label class="canvas-inspector-field"><span>${label}</span><textarea data-inspect-key="${key}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
  return `<label class="canvas-inspector-field"><span>${label}</span><input type="${type}" data-inspect-key="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" /></label>`;
}

function canvasAssetField(label, value, kind, key = "url") {
  const current = String(value || "");
  const files = canvasState.files.filter((file) => canvasFileKind(file.name) === kind).map((file) => String(file.name));
  const nodeFiles = (canvasState.graph?.getElements?.() || []).flatMap((node) => {
    const nodeKind = canvasKind(node), p = canvasPayload(node), values = kind === "image"
      ? nodeKind === "image" ? [p.path || p.url] : nodeKind === "shot" ? [p.first_frame] : []
      : kind === "video"
        ? nodeKind === "video" ? [p.path || p.url || p.video] : nodeKind === "shot" ? [p.video || p.reference_video] : []
        : nodeKind === "audio" ? [p.path || p.url] : nodeKind === "shot" ? [p.audio] : [];
    return values.filter((item) => item && canvasMediaAvailable(item)).map((item) => ({ value: String(item), label: `画布 · ${canvasNodeLabel(node)}` }));
  });
  const uniqueNodes = nodeFiles.filter((item, index, list) => list.findIndex((candidate) => candidate.value === item.value) === index);
  const workspaceOptions = files.slice(0, 80).map((file) => `<option value="${esc(file)}" ${file === current ? "selected" : ""}>${esc(file.split(/[\\/]/).pop())}</option>`).join("");
  const nodeOptions = uniqueNodes.map((item) => `<option value="${esc(item.value)}" ${item.value === current ? "selected" : ""}>${esc(item.label)}</option>`).join("");
  // 节点只是创作关系，不能让已删的文件继续伪装成可选素材；保留一个明确的占位提醒，
  // 用户选新的素材时会直接覆盖旧路径。
  const currentOption = current && !files.includes(current) && !uniqueNodes.some((item) => item.value === current) ? '<option value="" selected>素材已移除，请重新选择</option>' : "";
  return `<label class="canvas-inspector-field"><span>${label}</span><select data-inspect-key="${esc(key)}"><option value="">不选择，稍后再补</option>${currentOption}${workspaceOptions ? `<optgroup label="工作区素材">${workspaceOptions}</optgroup>` : ""}${nodeOptions ? `<optgroup label="画布参考节点">${nodeOptions}</optgroup>` : ""}${!workspaceOptions && !nodeOptions && !currentOption ? '<option value="" disabled>暂无可用素材</option>' : ""}</select></label>`;
}

function canvasTagField(value) {
  const options = ["角色", "场景", "风格", "首帧", "道具", "参考", "生成结果", "对白", "音乐"];
  const current = String(value || "").split(/[、,，\s]+/).filter(Boolean)[0] || "";
  return `<label class="canvas-inspector-field"><span>标签</span><select data-inspect-tags><option value="">选择标签…</option>${options.map((item) => `<option value="${item}" ${item === current ? "selected" : ""}>${item}</option>`).join("")}</select></label>`;
}

function canvasFileKindFromFile(file) {
  const byName = canvasFileKind(file?.name || "");
  if (byName !== "note") return byName;
  const mime = String(file?.type || "").toLowerCase();
  return /^(image|video|audio)\//.test(mime) ? mime.split("/")[0] : "note";
}

function canvasBytesToB64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(text);
}

async function canvasUploadWorkspaceFile(file) {
  if (!file) throw new Error("没有选择文件");
  const kind = canvasFileKindFromFile(file);
  if (!["image", "video", "audio"].includes(kind)) throw new Error("只支持图片、视频或音频文件");
  if (file.size > 30 * 1048576) throw new Error("文件不能超过 30MB");
  const response = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, data_b64: canvasBytesToB64(new Uint8Array(await file.arrayBuffer())) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.name) throw new Error(result.error || "文件上传失败");
  return String(result.name);
}

function canvasFilePicker(label, accept, current, targetKey, hint = "拖拽文件到这里，自动保存到工作区") {
  return `<div class="canvas-file-picker" data-canvas-picker data-picker-target="${esc(targetKey)}"><span>${esc(label)}</span><div class="canvas-file-picker-row"><button type="button" class="ui-btn ui-btn--sm ui-btn--outline" data-inspect-choose>选择文件</button><input type="file" data-inspect-file accept="${esc(accept)}" hidden></div><div class="canvas-file-drop" data-inspect-drop>拖拽文件到这里，自动保存到工作区</div><small>${esc(current ? `当前：${current}` : hint)}</small></div>`;
}

function canvasNodeHtml(kind, payload, nodeId = "") {
  const def = CANVAS_NODE_DEFS[kind] || CANVAS_NODE_DEFS.note;
  const header = (title, subtitle = def.subtitle) => `<header class="canvas-node-head"><span class="canvas-node-icon">${ic(def.icon)}</span><div><b>${esc(title || def.label)}</b><small>${esc(subtitle)}</small></div><button class="canvas-node-settings" data-canvas-settings title="打开设置" aria-label="打开设置">${ic("settings")}</button><button class="canvas-node-remove" data-canvas-remove title="删除节点" aria-label="删除节点">${ic("x")}</button></header>`;
  if (kind === "storyboard") {
    const options = canvasState.boards.length
      ? canvasState.boards.map((b) => `<option value="${esc(b.name)}">${esc(b.title || b.name)} · ${b.shots} 镜</option>`).join("")
      : '<option value="">还没有分镜表</option>';
    return `<article class="canvas-node canvas-node-storyboard">${header("短剧分镜", "short-drama 业务节点")}<div class="canvas-node-body"><label>选择分镜表</label><select data-canvas-board ${canvasState.boards.length ? "" : "disabled"}>${options}</select><div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-expand ${canvasState.boards.length ? "" : "disabled"}>展开场次与镜头</button><button class="ui-btn ui-btn--sm ui-btn--ghost" data-canvas-agent>交给本项目 Agent</button></div><p class="canvas-node-hint">分镜表是输入，场次/镜头是可继续创作的节点。</p></div></article>`;
  }
  if (kind === "scene") {
    const shots = Array.isArray(payload.shots) ? payload.shots : [];
    return `<article class="canvas-node canvas-node-scene">${header(payload.id || "场次", `${payload.place || "未命名场次"}${payload.time ? ` · ${payload.time}` : ""}`)}<div class="canvas-node-body"><div class="canvas-scene-count">${shots.length} 镜</div>${shots.slice(0, 6).map((s, i) => `<div class="canvas-shot-row"><span>${esc(s.id || `${payload.id || "S"}-${String(i + 1).padStart(2, "0")}`)}</span><span>${esc(s.shot_size || "镜头")}</span><span>${esc(s.line || "无人声")}</span></div>`).join("") || '<div class="canvas-node-hint">这场还没有镜头。</div>'}<button class="ui-btn ui-btn--sm ui-btn--ghost" data-canvas-agent>交给本项目 Agent</button></div></article>`;
  }
  if (kind === "shot") {
    const imageBusy = canvasState.busy.has(`${nodeId}:image`), videoBusy = canvasState.busy.has(`${nodeId}:video`);
    const shotMedia = payload.first_frame
      ? `<img class="canvas-node-preview" data-canvas-image-preview data-canvas-media-path="${esc(payload.first_frame)}" src="${esc(canvasFileUrl(payload.first_frame))}" alt="首帧" loading="lazy" title="双击放大预览">`
      : payload.reference_video
        ? `<video class="canvas-node-preview" src="${esc(canvasFileUrl(payload.reference_video))}" controls preload="metadata"></video>`
        : "";
    return `<article class="canvas-node canvas-node-shot">${header(payload.id || payload.title || "新镜头", `${payload.shot_size || "镜头"} · ${payload.duration || "4"}s`)}<div class="canvas-node-body">${shotMedia}<div class="canvas-shot-prompt">${esc(payload.prompt || "还没有镜头提示词")}</div><div class="canvas-shot-line">${esc(payload.line || "无人声")}</div><div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-generate="image" ${imageBusy ? "disabled" : ""}>${imageBusy ? "生成中…" : payload.first_frame ? "重跑首帧" : "生成首帧"}</button><button class="ui-btn ui-btn--sm ui-btn--ghost" data-canvas-generate="video" ${videoBusy || !payload.first_frame ? "disabled" : ""}>${videoBusy ? "生成中…" : "生成视频"}</button>${payload.first_frame ? `<button class="canvas-node-icon-action" data-canvas-side-preview="${esc(payload.first_frame)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button>` : ""}</div></div></article>`;
  }
  if (kind === "agent") return `<article class="canvas-node canvas-node-agent">${header(payload.title || "Agent任务", payload.role || "本项目 Agent") }<div class="canvas-node-body"><div class="canvas-agent-status">${esc(payload.status || "待执行")}</div><div class="canvas-node-copy">${esc(payload.task || "描述要让 Agent 完成的创作任务")}</div><button class="ui-btn ui-btn--sm ui-btn--brand" data-canvas-agent>${ic("sparkles")}运行这个任务</button></div></article>`;
  if (kind === "video") {
    const busy = canvasState.busy.has(`${nodeId}:video`), mediaPath = String(payload.video || canvasMediaPath(payload) || "").trim(), frame = String(payload.first_frame || "").trim();
    const preview = mediaPath ? `<video class="canvas-video-preview" src="${esc(canvasFileUrl(mediaPath))}" controls preload="metadata"></video>` : `<div class="canvas-video-empty">${ic("play")}<span>生成结果会显示在这里</span></div>`;
    const refs = [frame ? `首帧 · ${frame.split(/[\\/]/).pop()}` : "首帧 · 未设置", payload.last_frame ? `尾帧 · ${String(payload.last_frame).split(/[\\/]/).pop()}` : "尾帧 · 可选", payload.reference_video ? `参考视频 · ${String(payload.reference_video).split(/[\\/]/).pop()}` : "参考视频 · 可选"];
    return `<article class="canvas-node canvas-node-video">${header(payload.title || "Video", `${payload.model || "视频生成"} · ${payload.aspect_ratio || "16:9"}`)}<div class="canvas-node-body"><div class="canvas-video-stage">${preview}</div><textarea class="canvas-video-prompt" data-canvas-inline-key="prompt" rows="2" placeholder="描述任何你想生成的内容…">${esc(payload.prompt || "")}</textarea><div class="canvas-video-refs">${refs.map((ref) => `<span>${esc(ref)}</span>`).join("")}</div><div class="canvas-video-settings"><span>${esc(payload.model || "默认模型")}</span><span>${esc(payload.aspect_ratio || "16:9")}</span><span>${esc(payload.resolution || "1080p")}</span><span>${esc(payload.duration || "5s")}</span></div><div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--brand" data-canvas-generate="video" ${busy ? "disabled" : ""}>${busy ? "生成中…" : mediaPath ? "重新生成" : "生成视频"}</button>${mediaPath ? `<button class="canvas-node-icon-action" data-canvas-side-preview="${esc(mediaPath)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button>` : ""}</div></div></article>`;
  }
  if (kind === "image" || kind === "audio") {
    const mediaText = payload.text || payload.prompt || "还没有素材或描述";
    const mediaPath = canvasMediaPath(payload), mediaAvailable = canvasMediaAvailable(mediaPath), media = kind === "image" && mediaPath && mediaAvailable
      ? `<img class="canvas-node-preview canvas-image-preview" data-canvas-image-preview data-canvas-media-path="${esc(mediaPath)}" src="${esc(canvasFileUrl(mediaPath))}" alt="${esc(payload.title || def.label)}" loading="lazy" title="双击放大预览">`
      : kind === "audio" && mediaPath && mediaAvailable
        ? canvasAudioPreview(mediaPath)
        : "";
    const missing = mediaPath && !mediaAvailable ? `<div class="canvas-media-missing">素材已从工作区移除，请在右侧重新选择或上传。</div>` : "";
    const action = kind === "audio" ? "生成配音" : mediaPath && mediaAvailable ? `重跑${def.label}` : `生成${def.label}`;
    const busy = canvasState.busy.has(`${nodeId}:${kind}`);
    return `<article class="canvas-node canvas-node-media canvas-node-${kind}">${header(payload.title || def.label, kind === "image" ? "点击图片放大" : "可直接播放")}<div class="canvas-node-body">${media}${missing}<div class="canvas-media-text">${esc(mediaText)}</div><div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-generate="${kind}" ${busy ? "disabled" : ""}>${busy ? "生成中…" : action}</button>${mediaPath && mediaAvailable ? `<button class="canvas-node-icon-action" data-canvas-side-preview="${esc(mediaPath)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button>` : ""}</div></div></article>`;
  }
  if (kind === "timeline") return `<article class="canvas-node canvas-node-timeline">${header(payload.title || "最终剪辑", "本项目 AI 剪辑时间线")}<div class="canvas-node-body"><p>${esc(payload.description || "把镜头按顺序交给本项目 Agent 生成时间线。")}</p><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-agent>开始本项目剪辑</button></div></article>`;
  if (kind === "script") return `<article class="canvas-node canvas-node-script">${header(payload.title || "新剧本")}<div class="canvas-node-body canvas-node-copy">${esc(payload.text || "还没有剧本内容")}</div></article>`;
  if (kind === "character" || kind === "location") {
    const embedded = canvasEmbeddedImage(payload, kind), preview = embedded ? `<img class="canvas-node-preview canvas-embedded-preview" data-canvas-image-preview data-canvas-media-path="${esc(embedded)}" src="${esc(canvasFileUrl(embedded))}" alt="${esc(payload.name || def.label)}" loading="lazy" title="双击放大预览">` : "";
    return `<article class="canvas-node canvas-node-${kind}">${header(kind === "character" ? (payload.name || "新角色") : (payload.name || "新场景"), kind === "character" ? (payload.role || "角色") : def.subtitle)}<div class="canvas-node-body canvas-node-copy">${preview}${esc(payload.description || (embedded ? "" : kind === "character" ? "还没有人物设定" : "还没有场景设定"))}${embedded ? `<div class="canvas-node-actions"><button class="canvas-node-icon-action" data-canvas-side-preview="${esc(embedded)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button></div>` : ""}</div></article>`;
  }
  return `<article class="canvas-node canvas-node-note">${header(payload.title || "画布笔记")}<div class="canvas-node-body canvas-note-edit" contenteditable="true" spellcheck="false">${esc(payload.text || "在这里记录想法、任务或素材线索…")}</div></article>`;
}

function canvasSelectedNode() { return canvasState.graph && canvasState.selected ? canvasState.graph.getCell(canvasState.selected) : null; }
function canvasPreviewRight(value) {
  const path = String(value || "").trim(); if (!path) return canvasToast("这个节点还没有可预览的文件。", "circle-info");
  if (/^https?:/i.test(path) || typeof previewFile !== "function") return canvasOpenImagePreview(path, "素材预览");
  previewFile(canvasResolvedFileName(path));
}
function canvasDeleteSelection(fallbackNode) {
  const selected = canvasState.selectedIds.size ? [...canvasState.selectedIds] : fallbackNode ? [fallbackNode.id] : [];
  const nodes = selected.map((id) => canvasState.graph?.getCell(id)).filter((node) => node?.isElement?.());
  if (!nodes.length) return;
  const label = nodes.length === 1 ? `节点「${canvasNodeLabel(nodes[0])}」` : `${nodes.length} 个节点`;
  if (!confirm(`删除${label}？关联连线也会一起删除。`)) return;
  nodes.forEach((node) => node.remove()); canvasState.selected = null; canvasState.selectedIds = new Set(); canvasState.selectedAll = false; canvasRenderInspector(); canvasPersist();
}
function canvasOpenContextMenu(clientX, clientY, node = null) {
  document.getElementById("canvas-context-menu")?.remove();
  const menu = document.createElement("div"); menu.id = "canvas-context-menu"; menu.className = "canvas-context-menu";
  const media = node ? canvasMediaPath(canvasPayload(node)) || canvasEmbeddedImage(canvasPayload(node), canvasKind(node)) : "";
  menu.innerHTML = node
    ? `<button data-canvas-context="agent">${ic("bot")}<span>交给 Agent</span></button>${media ? `<button data-canvas-context="preview">${ic("eye")}<span>右侧预览</span></button>` : ""}<button data-canvas-context="duplicate">${ic("copy")}<span>复制节点</span></button><button data-canvas-context="connect">${ic("link")}<span>连接到下游</span></button><button data-canvas-context="layout">${ic("git-branch")}<span>整理画布</span></button><span class="canvas-context-divider"></span><button class="is-danger" data-canvas-context="delete">${ic("x")}<span>删除节点</span></button>`
    : `<button data-canvas-context="add-note">${ic("notebook-pen")}<span>添加笔记</span></button><button data-canvas-context="add-image">${ic("image")}<span>添加参考图</span></button><button data-canvas-context="layout">${ic("git-branch")}<span>自动排版</span></button><button data-canvas-context="fit">${ic("target")}<span>适配全部节点</span></button>`;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect(), left = Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8)), top = Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`; menu.style.top = `${top}px`;
  const close = () => { menu.remove(); document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", onKey, true); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  menu.querySelectorAll("[data-canvas-context]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.canvasContext; close();
    if (action === "agent") canvasRunInternal(node);
    else if (action === "preview") canvasPreviewRight(media);
    else if (action === "duplicate") { const p = node.position(); canvasAddNode(canvasKind(node), canvasPayload(node), { x: p.x + 42, y: p.y + 42 }); }
    else if (action === "connect") { canvasState.selected = node.id; canvasState.selectedIds = new Set([node.id]); canvasState.inspectorOpen = true; canvasRenderInspector(false); window.setTimeout(() => document.querySelector("[data-connect-target]")?.focus(), 0); }
    else if (action === "layout") canvasAutoLayout(document.getElementById("assist-page"));
    else if (action === "fit") canvasFitAll(document.getElementById("assist-page"));
    else if (action === "delete") canvasDeleteSelection(node);
    else if (action === "add-note" || action === "add-image") canvasAddNode(action === "add-note" ? "note" : "image");
  }));
  window.setTimeout(() => { document.addEventListener("pointerdown", close, true); document.addEventListener("keydown", onKey, true); }, 0);
}
function canvasRefreshNode(node) {
  if (!node || !canvasState.paper) return;
  const view = node.findView(canvasState.paper), root = view && view.el && view.el.querySelector(".canvas-joint-node");
  if (!root) return;
  root.innerHTML = canvasNodeHtml(canvasKind(node), canvasPayload(node), node.id); canvasBindNode(node, root);
  root.classList.toggle("is-selected", canvasState.selectedAll || canvasState.selected === node.id);
}

function canvasSnapshot() {
  if (!canvasState.graph) return { version: 1, nodes: [], edges: [], updatedAt: Date.now() };
  return {
    version: 1,
    nodes: canvasState.graph.getElements().map((node) => ({ id: node.id, kind: canvasKind(node), payload: canvasPayload(node), position: node.position(), size: node.size() })),
    edges: canvasState.graph.getLinks().map((link) => ({ source: { id: canvasEndpointId(link.get("source")) }, target: { id: canvasEndpointId(link.get("target")) } })).filter((edge) => edge.source.id && edge.target.id && edge.source.id !== edge.target.id),
    updatedAt: Date.now(),
  };
}

function canvasHistoryKey(snapshot) { return JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges }); }
function canvasHistoryCommit(snapshot) {
  if (canvasState.historyMute || !snapshot) return;
  const last = canvasState.history[canvasState.historyIndex];
  if (last && canvasHistoryKey(last) === canvasHistoryKey(snapshot)) return;
  canvasState.history = canvasState.history.slice(0, canvasState.historyIndex + 1);
  canvasState.history.push(JSON.parse(JSON.stringify(snapshot)));
  if (canvasState.history.length > 60) canvasState.history.shift();
  canvasState.historyIndex = canvasState.history.length - 1;
}
function canvasHistorySchedule(snapshot) {
  if (canvasState.historyMute) return;
  if (canvasState.historyTimer) clearTimeout(canvasState.historyTimer);
  canvasState.historyTimer = window.setTimeout(() => { canvasState.historyTimer = null; canvasHistoryCommit(snapshot); }, 260);
}
function canvasHistoryReset(snapshot) {
  if (canvasState.historyTimer) clearTimeout(canvasState.historyTimer);
  canvasState.historyTimer = null; canvasState.history = snapshot ? [JSON.parse(JSON.stringify(snapshot))] : []; canvasState.historyIndex = snapshot ? 0 : -1;
}
function canvasHistoryFlush() {
  if (canvasState.historyTimer) clearTimeout(canvasState.historyTimer);
  canvasState.historyTimer = null;
  if (!canvasState.historyMute && canvasState.graph) canvasHistoryCommit(canvasSnapshot());
}
function canvasUndo() {
  canvasHistoryFlush();
  if (canvasState.historyIndex <= 0) return canvasToast("已经是最早一步了。", "rotate-ccw");
  const target = canvasState.history[--canvasState.historyIndex]; canvasState.historyMute = true;
  try { canvasApplySnapshot(target); } finally { canvasState.historyMute = false; }
  canvasToast("已撤销上一步操作。", "rotate-ccw");
}
function canvasRedo() {
  canvasHistoryFlush();
  if (canvasState.historyIndex >= canvasState.history.length - 1) return canvasToast("已经是最新一步了。", "rotate-ccw");
  const target = canvasState.history[++canvasState.historyIndex]; canvasState.historyMute = true;
  try { canvasApplySnapshot(target); } finally { canvasState.historyMute = false; }
  canvasToast("已恢复下一步操作。", "rotate-ccw");
}

async function canvasLoadCanvasList() {
  const data = await fetch("/api/canvas/list").then((r) => r.json()).catch(() => ({}));
  canvasState.canvasList = Array.isArray(data.canvases) && data.canvases.length ? data.canvases : [{ name: "main", title: "主画布", nodes: 0 }];
  try { const saved = localStorage.getItem("openworkbuddy.canvas.name"); if (saved && canvasState.canvasList.some((item) => item.name === saved)) canvasState.canvasName = saved; } catch {}
  if (!canvasState.canvasList.some((item) => item.name === canvasState.canvasName)) canvasState.canvasName = canvasState.canvasList[0]?.name || "main";
}

async function canvasLoadWorkspaceProjects() {
  const data = await fetch("/api/projects").then((r) => r.json()).catch(() => ({}));
  canvasState.workspaceProjects = Array.isArray(data.projects) ? data.projects : [];
  canvasState.workspaceLocked = !!data.locked;
  canvasState.workspaceName = String(data.active || "");
  canvasState.workspaceDir = String(canvasState.workspaceProjects.find((item) => item.name === canvasState.workspaceName)?.dir || (typeof settingsCache !== "undefined" ? settingsCache?.workspace_dir : "") || "");
}

function canvasUniqueProjectName(base) {
  const clean = String(base || "短剧项目").trim().slice(0, 26) || "短剧项目";
  if (!canvasState.workspaceProjects.some((item) => item.name === clean)) return clean;
  let index = 2; while (canvasState.workspaceProjects.some((item) => item.name === `${clean} ${index}`)) index++;
  return `${clean} ${index}`;
}

async function canvasFinishWorkspaceSwitch(name, message = "") {
  canvasState.workspaceName = name; canvasState.canvasName = "main"; canvasState.taskSessionId = null;
  try { localStorage.setItem("openworkbuddy.canvas.name", "main"); } catch {}
  if (typeof activeProject !== "undefined") activeProject = name;
  if (typeof refreshProjects === "function") await refreshProjects();
  if (typeof refreshSettingsCache === "function") await refreshSettingsCache();
  if (typeof renderFiles === "function") fetch("/api/files").then((response) => response.json()).then(renderFiles).catch(() => {});
  await renderCanvasPage();
  canvasToast(message || `已切换工作文件夹：${name}`, "folder-open");
}

async function canvasSwitchWorkspace(value) {
  if (!value) return;
  if (value === "__pick__") {
    const response = await fetch("/api/pick-folder", { method: "POST" }).catch(() => null);
    const picked = response ? await response.json().catch(() => ({})) : {};
    if (!response || !response.ok || !picked.path) {
      if (!picked.canceled) canvasToast(picked.error || "选择文件夹失败", "circle-x", "err");
      return renderCanvasPage();
    }
    const existing = canvasState.workspaceProjects.find((item) => item.dir === picked.path);
    if (existing) {
      const switched = await fetch("/api/projects/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: existing.name }) });
      if (!switched.ok) return canvasToast("切换工作文件夹失败", "circle-x", "err");
      return canvasFinishWorkspaceSwitch(existing.name);
    }
    const parts = String(picked.path).split(/[\\/]/).filter(Boolean), name = canvasUniqueProjectName(parts.pop() || "短剧项目");
    const created = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, dir: picked.path }) });
    const data = await created.json().catch(() => ({}));
    if (!created.ok) return canvasToast(data.error || "添加工作文件夹失败", "circle-x", "err");
    return canvasFinishWorkspaceSwitch(data.active || name, `已添加并切换到：${name}`);
  }
  if (value === canvasState.workspaceName) return;
  const response = await fetch("/api/projects/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: value }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return canvasToast(data.error || "切换工作文件夹失败", "circle-x", "err");
  await canvasFinishWorkspaceSwitch(data.active || value);
}

function canvasAskNewBoardName() {
  return new Promise((resolve) => {
    document.getElementById("canvas-create-board-dialog")?.remove();
    const defaultName = "短剧_" + new Date().toISOString().slice(5, 10).replace("-", "");
    const overlay = document.createElement("div"); overlay.id = "canvas-create-board-dialog"; overlay.className = "canvas-create-board-dialog";
    overlay.innerHTML = `<form class="canvas-create-board-card"><div class="canvas-create-board-head"><span class="canvas-create-board-icon">${ic("map")}</span><div><b>新建画布</b><small>一张画布对应一个短剧任务</small></div></div><label><span>画布名称</span><input name="canvasName" maxlength="80" autocomplete="off" value="${esc(defaultName)}" placeholder="例如：外卖小哥第 1 集"></label><div class="canvas-create-board-error" aria-live="polite"></div><div class="canvas-create-board-actions"><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-canvas-create-cancel>取消</button><button type="submit" class="ui-btn ui-btn--brand ui-btn--sm">创建</button></div></form>`;
    const finish = (value) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
    const onKey = (event) => { if (event.key === "Escape") finish(""); };
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(""); });
    overlay.querySelector("[data-canvas-create-cancel]").addEventListener("click", () => finish(""));
    overlay.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault(); const input = overlay.querySelector("input"), name = String(input.value || "").trim(), error = overlay.querySelector(".canvas-create-board-error");
      if (!name) { error.textContent = "请输入画布名称"; input.focus(); return; }
      if (/[\\/\0]/.test(name)) { error.textContent = "名称不能包含斜杠"; input.focus(); return; }
      if (canvasState.canvasList.some((item) => item.name === name)) { error.textContent = "已经有同名画布，请换一个名称"; input.focus(); input.select(); return; }
      finish(name);
    });
    document.addEventListener("keydown", onKey); document.body.appendChild(overlay);
    const input = overlay.querySelector("input"); requestAnimationFrame(() => { input.focus(); input.select(); overlay.classList.add("is-open"); });
  });
}

async function canvasCreateBoard() {
  const name = await canvasAskNewBoardName();
  if (!name) return;
  const response = await fetch("/api/canvas/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return canvasToast(data.error || "新建画布失败", "circle-x", "err");
  canvasState.canvasName = data.name || name; try { localStorage.setItem("openworkbuddy.canvas.name", canvasState.canvasName); } catch {}
  await renderCanvasPage(); canvasToast(`已创建画布「${canvasState.canvasName}」`, "circle-check");
}
async function canvasDeleteBoard() {
  if (canvasState.canvasName === "main") return canvasToast("主画布不能删除。", "circle-info");
  if (!confirm("删除这张画布？画布节点会删除，素材文件不会删除。")) return;
  const response = await fetch("/api/canvas/boards/" + encodeURIComponent(canvasState.canvasName), { method: "DELETE" });
  if (!response.ok) return canvasToast("删除画布失败", "circle-x", "err");
  canvasState.canvasName = "main"; try { localStorage.setItem("openworkbuddy.canvas.name", "main"); } catch {}
  renderCanvasPage();
}

function canvasPersist() {
  if (!canvasState.graph || typeof localStorage === "undefined") return;
  const snapshot = canvasSnapshot();
  try { localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...snapshot, version: 3, savedAt: Date.now() })); } catch {}
  canvasHistorySchedule(snapshot);
  if (canvasState.suspendSync) return;
  if (canvasState.remoteWriteTimer) clearTimeout(canvasState.remoteWriteTimer);
  canvasState.remoteWriteTimer = window.setTimeout(async () => {
    canvasState.remoteWritePending = true;
    try {
      const response = await fetch("/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: canvasState.canvasName, state: snapshot }) });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.state) canvasState.remoteUpdatedAt = Number(result.state.updatedAt) || canvasState.remoteUpdatedAt;
    } catch {} finally { canvasState.remoteWritePending = false; }
  }, 240);
}

function canvasLoadSaved() {
  try { const value = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY) || "null"); return value && Array.isArray(value.nodes) ? value : null; } catch { return null; }
}

function canvasConnect(source, target) {
  if (!canvasState.graph || !source || !target || source.id === target.id) return;
  const exists = canvasState.graph.getLinks().some((link) => canvasEndpointId(link.get("source")) === source.id && canvasEndpointId(link.get("target")) === target.id);
  if (exists) return;
  const J = typeof joint !== "undefined" ? joint : null; if (!J) return;
  const sourceKind = canvasKind(source), targetKind = canvasKind(target);
  const relation = ["image", "video", "audio"].includes(targetKind) ? "生成" : sourceKind === "script" && targetKind === "storyboard" ? "拆分" : ["character", "location", "image"].includes(sourceKind) ? "参考" : "输入";
  const link = new J.shapes.standard.Link({ source: { id: source.id }, target: { id: target.id }, router: { name: "manhattan", args: { step: 16, padding: 20 } }, attrs: { line: { stroke: "var(--wb-brand-text)", strokeWidth: 2.25, strokeLinecap: "round", targetMarker: { type: "path", d: "M 9 -4.5 0 0 9 4.5 z" } } }, connector: { name: "rounded" }, labels: [{ position: .5, attrs: { text: { text: relation, fill: "var(--wb-brand-text)", fontSize: 10, fontWeight: 600 }, rect: { fill: "var(--wb-bg)", stroke: "var(--wb-border)", strokeWidth: 1, rx: 7, ry: 7 } } }], z: 1 });
  canvasState.graph.addCell(link); canvasPersist();
}

async function canvasLoadRemote() {
  const response = await fetch("/api/canvas?name=" + encodeURIComponent(canvasState.canvasName)).then((x) => x.json()).catch(() => null);
  if (!response || !Array.isArray(response.nodes)) return null;
  canvasState.remoteSnapshot = response;
  return response;
}

function canvasInferLegacyEdges(snapshot) {
  if (!snapshot || (snapshot.edges || []).length) return snapshot;
  const shots = snapshot.nodes.filter((item) => item.kind === "shot");
  if (shots.length !== 1) return snapshot;
  const shot = shots[0], candidates = snapshot.nodes.filter((item) => {
    if (item.kind === "location") return String(item.payload?.name || "").trim() && item.payload?.name !== "新场景";
    return item.kind === "image" && String(item.payload?.role || "").includes("首帧");
  });
  const edges = candidates.map((item) => ({ source: { id: item.id }, target: { id: shot.id } }));
  return edges.length ? { ...snapshot, edges } : snapshot;
}

function canvasApplySnapshot(snapshot) {
  if (!canvasState.graph || !snapshot || !Array.isArray(snapshot.nodes)) return;
  const previousSelection = canvasState.selected;
  const starterIds = new Set(snapshot.nodes.filter((item) => ["开始工作", "开始创作"].includes(String(item.payload?.title || item.payload?.name || ""))).map((item) => item.id));
  const currentEdges = canvasState.graph.getLinks().length ? canvasSnapshot().edges : [];
  const incomingEdges = Array.isArray(snapshot.edges) && snapshot.edges.length ? snapshot.edges : currentEdges;
  const cleanSnapshot = starterIds.size ? { ...snapshot, nodes: snapshot.nodes.filter((item) => !starterIds.has(item.id)), edges: incomingEdges.filter((edge) => !starterIds.has(canvasEndpointId(edge.source)) && !starterIds.has(canvasEndpointId(edge.target))) } : { ...snapshot, edges: incomingEdges };
  const restoredSnapshot = canvasInferLegacyEdges(cleanSnapshot);
  canvasState.suspendSync = true;
  try {
    canvasState.graph.clear(); const byId = new Map();
    restoredSnapshot.nodes.forEach((item) => { const node = canvasAddNode(item.kind, item.payload, item.position, { persist: false, skipSelect: true, id: item.id }); if (node) { if (item.size) node.resize(Number(item.size.width) || node.size().width, Number(item.size.height) || node.size().height); byId.set(item.id, node); } });
    (restoredSnapshot.edges || []).forEach((edge) => canvasConnect(byId.get(canvasEndpointId(edge.source)), byId.get(canvasEndpointId(edge.target))));
    // 加载或同步不应抢走画布空间：只保留用户已经打开、且仍存在的节点属性。
    const keepSelection = previousSelection && byId.has(previousSelection) ? previousSelection : null;
    canvasState.selectedAll = false; canvasState.selectedIds = new Set(keepSelection ? [keepSelection] : []); canvasState.selected = keepSelection; canvasState.remoteUpdatedAt = Number(snapshot.updatedAt) || canvasState.remoteUpdatedAt; canvasRenderInspector(false);
  } finally { canvasState.suspendSync = false; }
  canvasPersist();
}

function canvasStartRemoteSync() {
  if (canvasState.remoteTimer) clearInterval(canvasState.remoteTimer);
  canvasState.remoteTimer = window.setInterval(async () => {
    if (!canvasState.graph || canvasState.remoteWritePending) return;
    const previous = Number(canvasState.remoteUpdatedAt || 0);
    const state = await canvasLoadRemote();
    if (state && Number(state.updatedAt) > previous) canvasApplySnapshot(state);
  }, 1800);
}

function canvasRunInternal(node) {
  const kind = node && String(node.get("canvasKind") || "note"), p = canvasPayload(node);
  const text = kind === "shot"
    ? `请处理这个短剧镜头：${p.id || p.title || "新镜头"}\n景别：${p.shot_size || "未指定"}\n时长：${p.duration || "4"} 秒\n镜头提示词：${p.prompt || ""}\n对白/旁白：${p.line || ""}\n需要时直接调用 generate_image / generate_video，并用 canvas_manage 更新当前镜头节点的 first_frame 或 video。`
    : kind === "script" ? `请使用 /short-drama 把下面剧本拆成角色、场景和可执行镜头，并用 canvas_manage 写入当前项目画布，生成可审核的创作计划：\n${p.text || ""}`
      : kind === "timeline" ? "请在当前 OpenWorkBuddy 项目内检查镜头顺序、音频和字幕，并使用 /video-compose 或相关技能给出可执行方案。"
        : kind === "agent" ? `请执行这个本项目 Agent 任务，并把计划、产物和需要我确认的地方写回当前画布：\n角色：${p.role || "导演 Agent"}\n任务：${p.task || ""}\n审批规则：${p.approval || "先给方案，等我确认"}`
          : `请基于这个${CANVAS_NODE_DEFS[kind]?.label || "节点"}参与短剧制作：${p.title || p.name || p.id || "未命名"}\n${p.description || p.text || p.prompt || ""}`;
  const input = document.getElementById("canvas-chat-input");
  if (!input) { canvasToast("画布对话框还没有准备好，请刷新页面后重试。", "circle-x", "err"); return; }
  if (node) {
    const reference = { key: `node:${node.id}`, label: canvasNodeLabel(node), kind, path: canvasMediaPath(p) || canvasEmbeddedImage(p, kind), nodeId: node.id };
    reference.use = canvasChatReferenceDefaultUse(reference); canvasState.chatReferences.set(reference.key, reference); canvasRenderChatReferences();
  }
  input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
  canvasToast("已把当前节点加入画布对话，确认后发送。", "sparkles");
}

function canvasUpstreamNodes(node) {
  if (!node || !canvasState.graph) return [];
  const ids = canvasState.graph.getLinks().filter((link) => link.get("target")?.id === node.id).map((link) => link.get("source")?.id);
  return ids.map((id) => canvasState.graph.getCell(id)).filter(Boolean);
}

function canvasGenerationContext(node) {
  return canvasUpstreamNodes(node).map((source) => {
    const kind = canvasKind(source), p = canvasPayload(source);
    return `${CANVAS_NODE_DEFS[kind]?.label || "节点"}：${p.title || p.name || p.id || "未命名"}\n${p.description || p.text || p.prompt || p.line || p.task || ""}`;
  }).join("\n");
}

function canvasUpstreamMedia(node) {
  return canvasUpstreamNodes(node).map((source) => {
    const p = canvasPayload(source), value = p.path || p.first_frame || p.reference || p.file || "";
    return String(value).trim();
  }).filter((value) => value && !/^https?:/i.test(value)).slice(0, 4);
}

function canvasUpsertResult(source, kind, file) {
  if (!source || !file || !["image", "video", "audio"].includes(kind)) return;
  const existing = canvasState.graph.getElements().find((item) => canvasKind(item) === kind && canvasPayload(item).sourceId === source.id);
  if (existing) {
    existing.set("canvasPayload", { ...canvasPayload(existing), path: file, url: file, title: String(file).split(/[\\/]/).pop() });
    canvasRefreshNode(existing); canvasPersist(); return existing;
  }
  const pos = source.position(), sourceSize = source.size();
  const result = canvasAddNode(kind, { title: String(file).split(/[\\/]/).pop(), path: file, url: file, sourceId: source.id }, { x: pos.x + sourceSize.width + 48, y: pos.y }, { skipSelect: true });
  if (result) canvasConnect(source, result);
  return result;
}

function canvasCreateDramaWorkflow() {
  const existing = canvasState.graph?.getElements?.() || [];
  const isEmptyStarter = existing.length === 2 && existing.every((node) => ["script", "storyboard"].includes(canvasKind(node)))
    && existing.some((node) => canvasPayload(node).title === "一句话概念");
  if (isEmptyStarter) canvasState.graph.clear();
  const base = 120 + (canvasState.next % 2) * 40;
  const note = canvasAddNode("note", { title: "创作方向", text: "先写清楚受众、情绪、时长和发布平台。" }, { x: base, y: 100 }, { skipSelect: true });
  const script = canvasAddNode("script", { title: "短剧剧本", text: "在这里写一句话概念、人物关系、冲突、对白和结局。" }, { x: base + 430, y: 100 }, { skipSelect: true });
  const character = canvasAddNode("character", { name: "主角", role: "主角", description: "外形、性格、目标、秘密、关系和表演要求。" }, { x: base + 430, y: 440 }, { skipSelect: true });
  const location = canvasAddNode("location", { name: "核心场景", description: "地点、时间、天气、光线、色彩和空间连续性。" }, { x: base + 790, y: 440 }, { skipSelect: true });
  const storyboard = canvasAddNode("storyboard", {}, { x: base + 860, y: 100 }, { skipSelect: true });
  const timeline = canvasAddNode("timeline", {}, { x: base + 1290, y: 100 }, { skipSelect: true });
  if (note && script) canvasConnect(note, script);
  if (script && character) canvasConnect(script, character);
  if (script && location) canvasConnect(script, location);
  if (script && storyboard) canvasConnect(script, storyboard);
  if (storyboard && timeline) canvasConnect(storyboard, timeline);
  canvasState.selectedAll = false; canvasState.selectedIds = new Set(); canvasState.selected = null; canvasRenderInspector(false); canvasPersist();
  window.setTimeout(() => canvasFitAll(document.getElementById("assist-page")), 0);
  canvasToast("短剧创作骨架已建立：先编辑剧本，再连接角色、场景和镜头。", "sparkles");
}

function canvasChatDisplayText(value) {
  const text = String(value || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= 560) return text;
  return `${text.slice(0, 180)}\n…执行明细已折叠，完整过程请在任务历史 / Trace 查看…\n${text.slice(-300)}`;
}

function canvasCompactToolPreview(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "已完成";
  if (/^\{[\s\S]*\}$/.test(text) || /["'](?:nodes|edges|canvas_name|updatedAt)["']\s*:/.test(text)) return "画布数据已同步";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function canvasChatReferenceIcon(kind) { return kind === "image" ? "image" : kind === "video" ? "video" : kind === "audio" ? "music" : CANVAS_NODE_DEFS[kind]?.icon || "file-text"; }
function canvasChatReferenceDefaultUse(item) { return item.use || (item.kind === "character" ? "character" : item.kind === "location" ? "background" : item.kind === "video" ? "motion" : item.kind === "audio" ? "audio" : "reference"); }
function canvasChatReferenceUseLabel(item) { const use = canvasChatReferenceDefaultUse(item); return CANVAS_REFERENCE_USES.find(([value]) => value === use)?.[1] || "其他参考"; }
function canvasChatReferenceKind(item) { return `${canvasChatReferenceUseLabel(item)} · ${item.file ? "素材" : CANVAS_NODE_DEFS[item.kind]?.label || "节点"}`; }
function canvasChatReferenceMarkup(item, removable = false) {
  const use = canvasChatReferenceDefaultUse(item);
  const role = removable
    ? `<select data-canvas-ref-use="${esc(item.key)}" title="这张素材的用途" aria-label="这张素材的用途">${CANVAS_REFERENCE_USES.map(([value, label]) => `<option value="${value}" ${value === use ? "selected" : ""}>${label}</option>`).join("")}</select>`
    : `<small>${esc(canvasChatReferenceKind(item))}</small>`;
  return `<span class="canvas-chat-ref-chip" data-ref-kind="${esc(item.kind || "file")}" data-ref-use="${esc(use)}"><span class="canvas-chat-ref-icon">${ic(canvasChatReferenceIcon(item.kind))}</span><span class="canvas-chat-ref-copy"><b>${esc(item.label)}</b>${role}</span>${removable ? `<button type="button" data-canvas-ref-remove="${esc(item.key)}" title="移除引用" aria-label="移除引用">${ic("x")}</button>` : ""}</span>`;
}

function canvasChatAppend(role, text, extraClass = "", references = []) {
  const log = document.getElementById("canvas-chat-log"); if (!log) return;
  const item = document.createElement("div"); item.className = `canvas-chat-message ${role === "user" ? "is-user" : "is-agent"} ${extraClass}`.trim();
  const refs = references.length ? `<span class="canvas-chat-message-refs">${references.map((reference) => canvasChatReferenceMarkup(reference)).join("")}</span>` : "";
  item.innerHTML = `<span class="canvas-chat-role">${role === "user" ? "你" : "Agent"}</span><span class="canvas-chat-message-body">${refs}<span class="canvas-chat-text"></span></span>`;
  item.querySelector(".canvas-chat-text").textContent = role === "agent" && !extraClass.includes("is-status") ? canvasChatDisplayText(text) : text;
  log.appendChild(item); log.scrollTop = log.scrollHeight; return item.querySelector(".canvas-chat-text");
}

function canvasChatCandidates() {
  const nodes = (canvasState.graph?.getElements?.() || []).map((node) => {
    const kind = canvasKind(node), payload = canvasPayload(node), path = canvasMediaPath(payload) || canvasEmbeddedImage(payload, kind);
    return { key: `node:${node.id}`, label: canvasNodeLabel(node), kind, path, nodeId: node.id };
  });
  const files = (canvasState.files || []).filter((file) => ["image", "video", "audio"].includes(canvasFileKind(file.name))).slice(0, 80).map((file) => ({
    key: `file:${file.name}`, label: String(file.name).split(/[\\/]/).pop(), kind: canvasFileKind(file.name), path: String(file.name), file: true,
  }));
  return [...nodes, ...files];
}

function canvasRenderChatModelSelect() {
  const select = document.querySelector("[data-canvas-chat-model]"); if (!select) return;
  const cache = typeof settingsCache !== "undefined" ? settingsCache : null, models = Array.isArray(cache?.models) ? cache.models : [];
  select.innerHTML = `<option value="">${esc(cache?.active_model || "默认模型")}</option>${models.filter((item) => item && item.name && item.name !== cache?.active_model).map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join("")}`;
  select.value = canvasState.chatModel || "";
}

function canvasMediaModelField(label, cap, value = "") {
  const cache = typeof settingsCache !== "undefined" ? settingsCache : null;
  const models = Array.isArray(cache?.media_models) ? cache.media_models.filter((item) => item && item.cap === cap && (item.model || item.name)) : [];
  const current = String(value || "");
  const currentOption = current && !models.some((item) => String(item.model || item.name) === current) ? `<option value="${esc(current)}" selected>${esc(current)}（当前值）</option>` : "";
  const options = models.map((item) => {
    const id = String(item.model || item.name), labelText = item.name && item.name !== id ? `${item.name} · ${id}` : id;
    return `<option value="${esc(id)}" ${id === current ? "selected" : ""}>${esc(labelText)}</option>`;
  }).join("");
  return `<label class="canvas-inspector-field"><span>${label}</span><select data-inspect-key="model">${currentOption}<option value="" ${!current ? "selected" : ""}>跟随设置默认模型${models.length ? "" : "（请先在设置中配置）"}</option>${options}</select></label>`;
}

function canvasRenderChatReferences() {
  const chips = document.getElementById("canvas-chat-ref-chips");
  if (chips) {
    chips.innerHTML = [...canvasState.chatReferences.values()].map((item) => canvasChatReferenceMarkup(item, true)).join("");
    chips.querySelectorAll("[data-canvas-ref-remove]").forEach((button) => button.addEventListener("click", () => { canvasState.chatReferences.delete(button.dataset.canvasRefRemove); canvasRenderChatReferences(); }));
    chips.querySelectorAll("[data-canvas-ref-use]").forEach((select) => select.addEventListener("change", () => { const item = canvasState.chatReferences.get(select.dataset.canvasRefUse); if (item) { item.use = select.value; canvasState.chatReferences.set(item.key, item); canvasRenderChatReferences(); } }));
  }
}

function canvasRenderChatMentionMenu() {
  const menu = document.getElementById("canvas-chat-mention-menu"), input = document.getElementById("canvas-chat-input");
  if (!menu || !input) return;
  const at = input.value.lastIndexOf("@");
  if (at < 0 || /\s/.test(input.value.slice(at + 1))) { menu.hidden = true; return; }
  const query = input.value.slice(at + 1).toLowerCase();
  const candidates = canvasChatCandidates().filter((item) => `${item.label} ${item.path || ""}`.toLowerCase().includes(query)).slice(0, 12);
  menu.innerHTML = candidates.length ? candidates.map((item) => `<button type="button" class="canvas-chat-mention-item" data-canvas-ref="${esc(item.key)}"><span class="canvas-chat-mention-icon">${ic(item.kind === "image" ? "image" : item.kind === "video" ? "video" : item.kind === "audio" ? "music" : "file-text")}</span><span><b>${esc(item.label)}</b><small>${esc(item.file ? "工作区素材" : `画布 · ${item.kind}`)}</small></span></button>`).join("") : '<div class="canvas-chat-mention-empty">没有匹配的节点或素材</div>';
  menu.hidden = false;
  menu.querySelectorAll("[data-canvas-ref]").forEach((button) => button.addEventListener("click", () => {
    const item = canvasChatCandidates().find((candidate) => candidate.key === button.dataset.canvasRef); if (!item) return;
    const atIndex = input.value.lastIndexOf("@"); input.value = input.value.slice(0, atIndex).replace(/\s+$/, "");
    const reference = { ...item, use: canvasChatReferenceDefaultUse(item) };
    canvasState.chatReferences.set(reference.key, reference); canvasRenderChatReferences(); menu.hidden = true; input.focus();
  }));
}

async function canvasChatAttachFile(file) {
  if (!file) return;
  try {
    const kind = canvasFileKindFromFile(file);
    if (!["image", "video", "audio"].includes(kind)) throw new Error("只支持图片、视频或音频文件");
    const name = await canvasUploadWorkspaceFile(file);
    const node = canvasAddNode(kind, { title: file.name, path: name, url: name, role: "对话附件", tags: "参考" }, { x: 140 + (canvasState.next % 3) * 390, y: 180 + Math.floor(canvasState.next / 3) * 280 });
    if (node) { const reference = { key: `node:${node.id}`, label: file.name, kind, path: name, nodeId: node.id }; reference.use = canvasChatReferenceDefaultUse(reference); canvasState.chatReferences.set(reference.key, reference); canvasRenderChatReferences(); canvasLoadLibrary(); canvasChatAppend("agent", `已把「${file.name}」加入画布，请选择它作为人物、背景、动作或其他参考。`, "is-status is-complete"); }
  } catch (error) { canvasChatAppend("agent", `附件加入失败：${String(error.message || error).slice(0, 120)}`, "is-status is-error"); }
}

function canvasOpenImagePreview(value, title = "图片预览") {
  const src = canvasFileUrl(value); if (!src) return;
  document.getElementById("canvas-media-lightbox")?.remove();
  const overlay = document.createElement("div"); overlay.id = "canvas-media-lightbox"; overlay.className = "canvas-media-lightbox";
  overlay.innerHTML = `<div class="canvas-media-lightbox-card" role="dialog" aria-modal="true" aria-label="图片预览"><div class="canvas-media-lightbox-head"><b></b><button type="button" class="canvas-media-lightbox-close" title="关闭预览" aria-label="关闭预览">${ic("x")}</button></div><div class="canvas-media-lightbox-stage"><img alt=""></div></div>`;
  overlay.querySelector(".canvas-media-lightbox-head b").textContent = title;
  const image = overlay.querySelector("img"); image.src = src; image.alt = title;
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (evt) => { if (evt.key === "Escape") close(); };
  overlay.addEventListener("click", (evt) => { if (evt.target === overlay || evt.target.classList.contains("canvas-media-lightbox-stage")) close(); });
  overlay.querySelector(".canvas-media-lightbox-close").addEventListener("click", close);
  document.addEventListener("keydown", onKey); document.body.appendChild(overlay); requestAnimationFrame(() => overlay.classList.add("is-open"));
}

function canvasChatHasDraft() {
  return !!String(document.getElementById("canvas-chat-input")?.value || "").trim() || canvasState.chatReferences.size > 0;
}

function canvasSyncChatSendButton() {
  const button = document.querySelector("[data-canvas-chat-send]"); if (!button) return;
  const draft = canvasChatHasDraft();
  button.classList.toggle("is-stop", canvasState.chatBusy && !draft);
  button.classList.toggle("is-interject", canvasState.chatBusy && draft);
  button.innerHTML = canvasState.chatBusy && !draft ? ic("square") : ic("arrow-up");
  const label = canvasState.chatBusy ? (draft ? "插入补充要求" : "停止生成") : "发送";
  button.title = `${label}（Enter）`; button.setAttribute("aria-label", label);
  button.disabled = !canvasState.chatBusy && !draft;
}

function canvasReferenceContext(references) {
  return references.length ? `\n用户已编排这些生成输入。必须按每项标注的用途使用，不要把人物当背景，也不要混淆多个人物：\n${references.map((item, index) => `- 输入 ${index + 1}｜${canvasChatReferenceUseLabel(item)}｜${item.label}（${item.kind}）${item.path ? `：${item.path}` : ""}`).join("\n")}` : "";
}

async function canvasChatStop() {
  if (!canvasState.chatBusy || canvasState.chatStopping) return;
  canvasState.chatStopping = true; canvasSyncChatSendButton();
  const sessionId = canvasTaskSessionId();
  await fetch("/api/chat/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) }).catch(() => {});
  canvasChatAppend("agent", "正在停止…", "is-status is-running");
  canvasState.chatStopping = false;
}

async function canvasChatInterject() {
  const input = document.getElementById("canvas-chat-input"), text = String(input?.value || "").trim(), references = [...canvasState.chatReferences.values()];
  if (!text && !references.length) return canvasChatStop();
  const message = `${text || "继续使用这些引用处理"}${canvasReferenceContext(references)}`;
  const response = await fetch("/api/chat/interject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: canvasTaskSessionId(), message }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return canvasChatAppend("agent", data.error || "补充要求发送失败", "is-status is-error");
  canvasChatAppend("user", text || "补充引用", "", references); input.value = ""; canvasState.chatReferences = new Map(); canvasRenderChatReferences(); canvasSyncChatSendButton();
  canvasChatAppend("agent", "补充要求已插入，Agent 会在当前安全步骤完成后读取。", "is-status is-complete");
}

async function canvasChatSend() {
  return canvasState.chatBusy ? (canvasChatHasDraft() ? canvasChatInterject() : canvasChatStop()) : canvasChatRun();
}

function canvasRegisterTask(sessionId, text) {
  if (typeof sessions === "undefined" || typeof saveSessions !== "function") return;
  if (!sessions.some((item) => item.id === sessionId)) {
    sessions.unshift({ id: sessionId, title: String(text).slice(0, 24), at: Date.now(), project: typeof activeProject === "string" ? activeProject : undefined, lane: typeof activeLane === "string" ? activeLane : "office" });
    saveSessions();
  }
  if (typeof renderHistory === "function") renderHistory();
}

function canvasTaskSessionId() {
  if (canvasState.taskSessionId) return canvasState.taskSessionId;
  const scope = [canvasState.workspaceName || "workspace", canvasState.canvasName || "main"].map((part) => encodeURIComponent(part)).join(".");
  const key = "openworkbuddy.canvas.task." + scope;
  try {
    canvasState.taskSessionId = localStorage.getItem(key) || "";
    if (!canvasState.taskSessionId) { canvasState.taskSessionId = "s_canvas_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); localStorage.setItem(key, canvasState.taskSessionId); }
  } catch { canvasState.taskSessionId = "s_canvas_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); }
  return canvasState.taskSessionId;
}

function canvasRenameTask(sessionId, title) {
  if (typeof sessions === "undefined") return;
  const row = sessions.find((item) => item.id === sessionId);
  if (row && title) { row.title = String(title); row.at = row.at || Date.now(); if (typeof saveSessions === "function") saveSessions(); if (typeof renderHistory === "function") renderHistory(); }
}

async function canvasChatRun() {
  const input = document.getElementById("canvas-chat-input"), button = document.querySelector("[data-canvas-chat-send]");
  const text = String(input?.value || "").trim();
  const references = [...canvasState.chatReferences.values()];
  if ((!text && !references.length) || canvasState.chatBusy) return;
  const userText = text || "使用这些引用继续创作";
  canvasState.chatBusy = true; canvasChatAppend("user", userText, "", references); input.value = "";
  canvasState.chatReferences = new Map(); canvasRenderChatReferences();
  canvasSyncChatSendButton();
  const sessionId = canvasTaskSessionId();
  canvasRegisterTask(sessionId, userText);
  const requestedModel = document.querySelector("[data-canvas-chat-model]")?.value || "";
  if (requestedModel) await fetch(`/api/session/${encodeURIComponent(sessionId)}/model`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: requestedModel }) }).catch(() => {});
  const referenceContext = canvasReferenceContext(references);
  const mode = document.querySelector("[data-canvas-chat-mode]")?.value || "craft";
  const directive = "你正在控制当前 OpenWorkBuddy 项目的 AI 短剧无限画布。只操作当前项目和当前画布，不连接其他本地项目。先用 canvas_manage 的 get 读取现有画布，再按用户要求 add/update/connect/delete 节点；需要生图、生视频或配音时直接调用对应工具，并把真实产物路径写回当前画布。" + referenceContext + "\n用户指令：" + userText;
  let answer = "", assistant = null;
  const write = (value) => {
    if (!assistant) assistant = canvasChatAppend("agent", "", "is-live");
    answer += String(value || ""); if (assistant) assistant.textContent = canvasChatDisplayText(answer);
    const log = document.getElementById("canvas-chat-log"); if (log) log.scrollTop = log.scrollHeight;
  };
  try {
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message: directive, mode, lang: "zh" }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "Agent 请求失败"); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    const consume = (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n\n"); buffer = parts.pop() || "";
      parts.forEach((part) => {
        if (!part.startsWith("data: ")) return;
        let event; try { event = JSON.parse(part.slice(6)); } catch { return; }
        if (event.type === "text") write(event.delta);
        else if (event.type === "title") canvasRenameTask(sessionId, event.title);
        else if (event.type === "tool_use") canvasChatAppend("agent", `执行：${event.name || event.tool || "工具"}`, "is-status is-running");
        else if (event.type === "tool_result") canvasChatAppend("agent", `完成：${canvasCompactToolPreview(event.preview)}`, "is-status is-complete");
        else if (event.type === "error") canvasChatAppend("agent", `失败：${event.message || "执行失败"}`, "is-status is-error");
        else if (event.type === "done") canvasChatAppend("agent", "已完成 · 画布已同步", "is-status is-complete");
      });
    };
    while (true) { const part = await reader.read(); if (part.done) break; consume(part.value); }
    const latest = await canvasLoadRemote(); if (latest && latest.updatedAt > canvasState.remoteUpdatedAt) { canvasApplySnapshot(latest); await canvasLoadLibrary(); }
  } catch (error) { write("发送失败：" + String(error.message || error).slice(0, 180)); }
  finally { canvasState.chatBusy = false; canvasState.chatStopping = false; canvasSyncChatSendButton(); if (typeof renderHistory === "function") renderHistory(); }
}

async function canvasGenerate(node, kind) {
  if (!node || !["image", "video", "audio"].includes(kind)) return;
  const key = `${node.id}:${kind}`;
  if (canvasState.busy.has(key)) return;
  const p = canvasPayload(node), upstream = canvasUpstreamMedia(node);
  let firstFrame = p.first_frame || (kind === "video" ? upstream[0] : "");
  if (kind === "video" && !firstFrame && canvasKind(node) === "shot") {
    canvasToast("这个视频节点还没有首帧，请先生成首帧或连接一个参考图节点。", "triangle-alert", "err"); return;
  }
  const context = canvasGenerationContext(node);
  const prompt = kind === "image"
    ? [p.prompt || p.description || p.text || "", context].filter(Boolean).join("\n")
    : kind === "video"
      ? [p.prompt || p.description || "保持角色和场景一致，动作自然，镜头运动克制。", p.line ? `对白/旁白：${p.line}` : "", context].filter(Boolean).join("\n")
      : String(p.text || p.line || p.description || "").trim();
  if (!prompt) { canvasToast(kind === "audio" ? "请先填写对白或音乐说明。" : "请先填写生成提示词。", "triangle-alert", "err"); return; }
  const input = kind === "image"
    ? { prompt, reference_images: [...new Set([...(p.reference ? [p.reference] : []), ...(p.first_frame ? [p.first_frame] : []), ...upstream])].slice(0, 4), ...(p.model ? { model: p.model } : {}), filename: canvasOutputFilename(p, "image"), no_cache: true }
    : kind === "video"
      ? { prompt, first_frame: firstFrame, ...(p.last_frame ? { last_frame: p.last_frame } : {}), ...(p.model ? { model: p.model } : {}), filename: canvasOutputFilename(p, "video"), no_cache: true }
      : { text: prompt, filename: canvasOutputFilename(p, "audio"), no_cache: true };
  canvasState.busy.add(key); canvasRefreshNode(node); canvasRenderInspector(false);
  try {
    const response = await fetch("/api/tool/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: kind === "audio" ? "text_to_speech" : `generate_${kind}`, input }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.isError || result.ok === false) throw new Error(result.error || result.content || "生成失败");
    const file = String(result.file || "").trim();
    if (!file) throw new Error("生成接口成功，但没有返回产物路径");
    const next = canvasPayload(node);
    if (canvasKind(node) === "shot") {
      if (kind === "image") next.first_frame = file;
      if (kind === "video") next.video = file;
      if (kind === "audio") next.audio = file;
      node.set("canvasPayload", next); canvasUpsertResult(node, kind, file);
    } else {
      node.set("canvasPayload", { ...next, path: file, url: file });
    }
    canvasState.selected = node.id; canvasRefreshNode(node); canvasPersist(); canvasRenderInspector(false);
    canvasToast(`${CANVAS_NODE_DEFS[kind].label}已生成：${String(file).split(/[\\/]/).pop()}`, "circle-check");
    if (typeof previewFile === "function") previewFile(canvasResolvedFileName(file));
  } catch (error) {
    canvasToast(`${CANVAS_NODE_DEFS[kind].label}生成失败：${String(error.message || error).slice(0, 180)}`, "circle-x", "err");
  } finally {
    canvasState.busy.delete(key); canvasRefreshNode(node); canvasRenderInspector(false);
  }
}

function canvasBindNode(node, root) {
  root.querySelector("[data-canvas-remove]")?.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); if (!confirm(`删除节点「${canvasNodeLabel(node)}」？关联连线也会一起删除。`)) return; if (canvasState.selected === node.id) { canvasState.selected = null; canvasRenderInspector(); } node.remove(); canvasPersist(); });
  root.querySelector("[data-canvas-settings]")?.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasState.selectedAll = false; canvasState.selectedIds = new Set([node.id]); canvasState.selected = node.id; canvasState.inspectorOpen = true; canvasRenderInspector(); });
  root.addEventListener("click", (evt) => {
    if (evt.target.closest("button,select,input,textarea,[contenteditable=true]")) return;
    // 节点本体只负责选中：属性面板只能由右上角齿轮显式打开，拖拽结束后的 click 绝不遮挡画布。
    if (canvasState.skipNodeClick === node.id || Date.now() < canvasState.suppressInspectorUntil) { canvasState.skipNodeClick = null; return; }
    canvasState.selectedAll = false; canvasState.selectedIds = new Set([node.id]); canvasState.selected = node.id; canvasState.inspectorOpen = false; canvasRenderInspector(false);
  });
  root.querySelectorAll("[data-canvas-image-preview]").forEach((image) => image.addEventListener("dblclick", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasOpenImagePreview(image.dataset.canvasMediaPath, image.alt || "图片预览"); }));
  root.querySelectorAll("[data-canvas-audio-preview]").forEach((audio) => {
    const fail = () => {
      if (audio.dataset.canvasAudioFailed) return;
      audio.dataset.canvasAudioFailed = "1";
      const tip = document.createElement("div"); tip.className = "canvas-media-error";
      tip.textContent = "音频无法播放：请确认文件仍在工作区，或换用浏览器支持的编码。";
      audio.after(tip);
    };
    audio.addEventListener("error", fail);
    audio.querySelector("source")?.addEventListener("error", fail);
  });
  root.querySelectorAll("[data-canvas-side-preview]").forEach((button) => button.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasPreviewRight(button.dataset.canvasSidePreview); }));
  root.querySelector("[data-canvas-agent]")?.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasRunInternal(node); });
  root.querySelectorAll("[data-canvas-generate]").forEach((button) => button.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasGenerate(node, button.dataset.canvasGenerate); }));
  root.querySelectorAll("[data-canvas-inline-key]").forEach((field) => field.addEventListener("input", () => { const next = canvasPayload(node); next[field.dataset.canvasInlineKey] = field.value; node.set("canvasPayload", next); canvasPersist(); }));
  root.querySelector("[data-canvas-expand]")?.addEventListener("click", async (evt) => {
    evt.preventDefault(); evt.stopPropagation(); const select = root.querySelector("[data-canvas-board]"), name = select && select.value; if (!name) return;
    const button = evt.currentTarget; button.disabled = true; button.textContent = "加载中…";
    try {
      const r = await fetch("/api/drama/storyboard?name=" + encodeURIComponent(name)).then((x) => x.json());
      if (!r || !r.data) throw new Error(r && r.error || "分镜表读取失败");
      const scenes = Array.isArray(r.data.scenes) ? r.data.scenes : [];
      const sceneNodes = [];
      scenes.forEach((scene, i) => {
        const sceneNode = canvasAddNode("scene", scene, { x: 100 + (i % 3) * 520, y: 430 + Math.floor(i / 3) * 390 });
        if (!sceneNode) return;
        sceneNodes.push(sceneNode); canvasConnect(node, sceneNode);
        (Array.isArray(scene.shots) ? scene.shots : []).forEach((shot, j) => {
          const shotNode = canvasAddNode("shot", { ...shot, title: shot.title || shot.id || `镜头 ${j + 1}` }, { x: 100 + (i % 3) * 520 + 410, y: 430 + Math.floor(i / 3) * 390 + j * 295 });
          if (shotNode) canvasConnect(sceneNode, shotNode);
        });
      });
      button.textContent = `已展开 ${scenes.length} 场`;
      canvasPersist();
    } catch (e) { button.disabled = false; button.textContent = "展开场次与镜头"; canvasToast(`分镜节点展开失败：${String(e.message || e).slice(0, 140)}`, "circle-x", "err"); }
  });
  const edit = root.querySelector(".canvas-note-edit"); edit?.addEventListener("pointerdown", (evt) => evt.stopPropagation());
  edit?.addEventListener("input", () => { node.set("canvasPayload", { ...canvasPayload(node), text: edit.textContent || "" }); canvasRenderInspector(false); canvasPersist(); });
  root.querySelector("[data-canvas-board]")?.addEventListener("change", (evt) => { node.set("canvasPayload", { ...canvasPayload(node), board: evt.target.value }); canvasRenderInspector(false); canvasPersist(); });
  root.addEventListener("contextmenu", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasOpenContextMenu(evt.clientX, evt.clientY, node); });
}

function canvasAddNode(kind, payload = {}, position, options = {}) {
  const page = document.getElementById("assist-page"), J = typeof joint !== "undefined" ? joint : null; if (!page || !canvasState.graph || !canvasState.paper || !J) return null;
  const def = CANVAS_NODE_DEFS[kind] || CANVAS_NODE_DEFS.note, Type = canvasType(J), n = canvasState.next++;
  const node = new Type({ id: options.id, position: position || { x: 90 + ((n - 1) % 3) * 410, y: 100 + Math.floor((n - 1) / 3) * 300 }, size: { width: def.width, height: def.height }, z: 2 });
  node.set({ canvasKind: kind, canvasPayload: { ...canvasDefaultPayload(kind), ...payload } }); canvasState.graph.addCell(node); canvasRefreshNode(node);
  if (!options.skipSelect) { canvasState.selectedAll = false; canvasState.selectedIds = new Set([node.id]); canvasState.selected = node.id; canvasState.inspectorOpen = false; canvasRenderInspector(false); }
  if (options.persist !== false) canvasPersist(); return node;
}

function canvasUpdateSelected(key, value, rerender = true) {
  const node = canvasSelectedNode(); if (!node) return;
  const next = { ...canvasPayload(node), [key]: value };
  if (key === "url") next.path = value;
  node.set("canvasPayload", next); if (rerender) canvasRefreshNode(node); canvasPersist();
}

function canvasRenderInspector(focus = true) {
  const box = document.getElementById("canvas-inspector"); if (!box) return; const node = canvasSelectedNode();
  canvasState.graph?.getElements().forEach((item) => {
    const view = canvasState.paper && item.findView(canvasState.paper), root = view && view.el && view.el.querySelector(".canvas-joint-node");
    root?.classList.toggle("is-selected", canvasState.selectedAll || canvasState.selectedIds.has(item.id) || item.id === canvasState.selected);
  });
  const layout = box.closest(".canvas-layout");
  if (!canvasState.inspectorOpen || !node || canvasState.selectedIds.size > 1) { box.innerHTML = ""; layout?.classList.add("canvas-inspector-hidden"); return; }
  layout?.classList.remove("canvas-inspector-hidden");
  const kind = canvasKind(node), p = canvasPayload(node), def = CANVAS_NODE_DEFS[kind] || CANVAS_NODE_DEFS.note; let fields = "";
  if (kind === "note") fields = canvasField("内容", "text", p.text || "", "textarea", "记录想法、任务或素材线索");
  if (kind === "script") fields = canvasField("标题", "title", p.title || "新剧本") + canvasField("剧本内容", "text", p.text || "", "textarea", "一句话概念、角色、冲突、对白…");
  if (kind === "agent") fields = canvasField("任务名称", "title", p.title || "Agent任务") + canvasField("Agent角色", "role", p.role || "导演 Agent") + canvasField("任务说明", "task", p.task || "", "textarea", "例如：根据剧本生成 6 个镜头并等待我审核") + canvasField("完成状态", "status", p.status || "待执行");
  if (kind === "character") fields = canvasField("角色名", "name", p.name || "") + canvasField("身份", "role", p.role || "") + canvasField("人物设定", "description", p.description || "", "textarea") + canvasFilePicker("参考图", "image/*", p.reference || "", "character-reference");
  if (kind === "location") fields = canvasField("场景名", "name", p.name || "") + canvasField("场景设定", "description", p.description || "", "textarea");
  if (kind === "storyboard") fields = `<label class="canvas-inspector-field"><span>分镜表</span><select data-inspect-board>${canvasState.boards.map((b) => `<option value="${esc(b.name)}" ${p.board === b.name ? "selected" : ""}>${esc(b.title || b.name)}</option>`).join("") || '<option value="">还没有分镜表</option>'}</select></label>`;
  if (kind === "scene") fields = canvasField("场次 ID", "id", p.id || "S1") + canvasField("地点", "place", p.place || "") + canvasField("时间/天气", "time", p.time || "", "text", "例如：2000年3月20日，上午，阴天");
  if (kind === "shot") fields = canvasField("镜头 ID", "id", p.id || "S1-01") + canvasField("标题", "title", p.title || "新镜头") + canvasField("景别", "shot_size", p.shot_size || "中景") + canvasField("时长（秒）", "duration", p.duration || "4", "number") + canvasField("镜头提示词", "prompt", p.prompt || "", "textarea") + canvasField("对白/旁白", "line", p.line || "", "textarea") + canvasFilePicker("拖入参考图或视频", "image/*,video/*", p.first_frame || p.reference_video || "", "shot-reference");
  if (kind === "image") fields = canvasField("名称", "title", p.title || def.label) + canvasField("素材用途", "role", p.role || "参考素材") + canvasTagField(p.tags) + canvasMediaModelField("生图模型", "image", p.model || "") + canvasAssetField("素材路径/URL（工作区）", p.url || p.path || "", kind) + canvasFilePicker("上传素材", "image/*", p.url || p.path || "", "image-media") + canvasField("生成/使用说明", "prompt", p.prompt || "", "textarea");
  if (kind === "video") fields = canvasField("名称", "title", p.title || "Video") + canvasMediaModelField("生视频模型", "video", p.model || "") + canvasField("画面比例", "aspect_ratio", p.aspect_ratio || "16:9") + canvasField("分辨率", "resolution", p.resolution || "1080p") + canvasField("时长", "duration", p.duration || "5s") + canvasAssetField("首帧（可选）", p.first_frame || "", "image", "first_frame") + canvasAssetField("尾帧（可选）", p.last_frame || "", "image", "last_frame") + canvasAssetField("参考视频（可选）", p.reference_video || "", "video", "reference_video") + canvasAssetField("已有视频（可选）", p.url || p.path || "", kind) + canvasFilePicker("上传参考视频", "video/*", p.url || p.path || "", "video-media") + canvasField("生成提示词", "prompt", p.prompt || "", "textarea");
  if (kind === "audio") fields = canvasField("名称", "title", p.title || "声音") + canvasField("素材用途", "role", p.role || "对白/音乐") + canvasTagField(p.tags) + canvasAssetField("音频路径/URL（工作区）", p.url || p.path || "", "audio") + canvasFilePicker("上传音频", "audio/*", p.url || p.path || "", "audio-media") + canvasField("对白/音乐说明", "text", p.text || "", "textarea");
  if (kind === "timeline") fields = canvasField("名称", "title", p.title || "最终剪辑") + canvasField("剪辑目标", "description", p.description || "", "textarea");
  const allNodes = canvasState.graph.getElements().filter((item) => item.id !== node.id), connected = canvasState.graph.getLinks().filter((link) => link.get("source")?.id === node.id).map((link) => link.get("target")?.id);
  const generateActions = kind === "shot" ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-generate="image">${ic("image")}生成首帧</button><button class="ui-btn ui-btn--sm ui-btn--outline" data-inspect-generate="video" ${p.first_frame ? "" : "disabled"}>${ic("video")}生成视频</button>` : ["image", "video", "audio"].includes(kind) ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-generate="${kind}">${ic(kind === "audio" ? "volume-2" : kind)}${kind === "audio" ? "生成配音" : `生成${def.label}`}</button>` : "";
  box.innerHTML = `<div class="canvas-inspector-head"><div><small>节点属性</small><h3>${esc(def.label)}</h3></div><button class="canvas-node-remove" data-inspect-close title="关闭设置">${ic("x")}</button></div><div class="canvas-inspector-fields">${fields}</div><div class="canvas-inspector-section"><span class="canvas-inspector-section-title">工作流连接</span><div class="canvas-connect-row"><select data-connect-target><option value="">连接到下游节点…</option>${allNodes.map((item) => `<option value="${item.id}">${esc(canvasNodeLabel(item))}</option>`).join("")}</select><button class="ui-btn ui-btn--sm ui-btn--outline" data-connect>${ic("link")}连接</button></div>${connected.length ? `<div class="canvas-connected-list">${connected.map((id) => `<span>${esc(canvasNodeLabel(canvasState.graph.getCell(id)) || "节点")}</span>`).join("")}</div>` : '<p class="canvas-inspector-hint">还没有下游节点。连接后，AI 才能理解输入关系。</p>'}</div><div class="canvas-inspector-actions">${generateActions}${["agent", "shot", "script", "scene", "storyboard", "timeline"].includes(kind) ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-agent>${ic("sparkles")}交给本项目 Agent</button>` : ""}<button class="ui-btn ui-btn--sm ui-btn--ghost canvas-inspector-delete" data-inspect-delete>删除节点</button></div>`;
  box.querySelectorAll("[data-inspect-key]").forEach((field) => { const update = () => canvasUpdateSelected(field.dataset.inspectKey, field.value); field.addEventListener("input", update); field.addEventListener("change", update); });
  box.querySelector("[data-inspect-tags]")?.addEventListener("change", (evt) => canvasUpdateSelected("tags", evt.target.value));
  box.querySelector("[data-inspect-board]")?.addEventListener("change", (evt) => canvasUpdateSelected("board", evt.target.value, true));
  box.querySelector("[data-connect]")?.addEventListener("click", () => { const target = canvasState.graph.getCell(box.querySelector("[data-connect-target]")?.value); canvasConnect(node, target); canvasRenderInspector(false); });
  box.querySelector("[data-inspect-close]")?.addEventListener("click", () => { canvasState.inspectorOpen = false; canvasRenderInspector(false); });
  box.querySelector("[data-inspect-delete]")?.addEventListener("click", () => { if (!confirm("删除这个节点？关联连线也会一起删除。")) return; node.remove(); canvasState.selected = null; canvasState.selectedIds = new Set(); canvasRenderInspector(); canvasPersist(); });
  box.querySelectorAll("[data-inspect-generate]").forEach((button) => button.addEventListener("click", () => canvasGenerate(node, button.dataset.inspectGenerate)));
  box.querySelector("[data-inspect-agent]")?.addEventListener("click", () => canvasRunInternal(node)); if (focus) box.querySelector("[data-inspect-key]")?.focus();
  box.querySelectorAll("[data-canvas-picker]").forEach((picker) => {
    const input = picker.querySelector("[data-inspect-file]"), choose = picker.querySelector("[data-inspect-choose]"), drop = picker.querySelector("[data-inspect-drop]"), target = picker.dataset.pickerTarget;
    const handle = async (file) => {
      try {
        const kindFromFile = canvasFileKindFromFile(file);
        const expected = target === "shot-reference" ? ["image", "video"] : target === "character-reference" ? ["image"] : target === "audio-media" ? ["audio"] : target.startsWith("image-") ? ["image"] : target.startsWith("video-") ? ["video"] : [];
        if (expected.length && !expected.includes(kindFromFile)) throw new Error(`这里需要${expected.join("或")}文件`);
        const name = await canvasUploadWorkspaceFile(file), next = canvasPayload(node);
        if (target === "shot-reference") { if (kindFromFile === "image") next.first_frame = name; else next.reference_video = name; }
        else if (target === "character-reference") next.reference = name;
        else { next.path = name; next.url = name; }
        node.set("canvasPayload", next); canvasState.selected = node.id; canvasRefreshNode(node); canvasPersist(); canvasRenderInspector(false); canvasLoadLibrary();
        canvasToast(`${file.name} 已上传到工作区。`, "circle-check");
      } catch (error) { canvasToast(`文件上传失败：${String(error.message || error).slice(0, 140)}`, "circle-x", "err"); }
    };
    choose?.addEventListener("click", () => input?.click()); input?.addEventListener("change", () => { const file = input.files?.[0]; if (file) handle(file); input.value = ""; });
    [drop, picker].forEach((area) => area?.addEventListener("dragover", (evt) => { evt.preventDefault(); evt.stopPropagation(); drop?.classList.add("is-dragging"); }));
    [drop, picker].forEach((area) => area?.addEventListener("dragleave", () => drop?.classList.remove("is-dragging")));
    [drop, picker].forEach((area) => area?.addEventListener("drop", (evt) => { evt.preventDefault(); evt.stopPropagation(); drop?.classList.remove("is-dragging"); const file = evt.dataTransfer?.files?.[0]; if (file) handle(file); }));
  });
}

async function canvasLoadBoards() { const r = await fetch("/api/drama/storyboards").then((x) => x.json()).catch(() => null); canvasState.boards = r && Array.isArray(r.storyboards) ? r.storyboards : []; }

function canvasFileKind(name) {
  const clean = String(name || "").split(/[?#]/)[0];
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(clean)) return "image";
  if (/\.(mp4|mov|webm|m4v|ogv)$/i.test(clean)) return "video";
  if (/\.(mp3|wave?|m4a|aac|ogg|oga|flac|opus)$/i.test(clean)) return "audio";
  return "note";
}

function canvasRenderLibrary() {
  const box = document.getElementById("canvas-library-items"); if (!box) return;
  const query = String(document.getElementById("canvas-library-search")?.value || "").trim().toLowerCase();
  const filter = String(document.getElementById("canvas-library-kind")?.value || "all");
  const files = canvasState.files.filter((file) => {
    const name = String(file.name || ""), kind = canvasFileKind(name); return ["image", "video", "audio"].includes(kind) && (filter === "all" || kind === filter) && (!query || name.toLowerCase().includes(query));
  }).slice(0, 24);
  box.innerHTML = files.length ? files.map((file) => {
    const kind = canvasFileKind(file.name), label = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
    return `<button class="canvas-library-item" data-library-file="${esc(file.name)}" title="添加到画布：${esc(file.name)}"><span class="canvas-library-icon">${ic(CANVAS_NODE_DEFS[kind].icon)}</span><span><b>${esc(String(file.name).split("/").pop())}</b><small>${label} · ${esc(String(file.name))}</small></span><span class="canvas-library-add">+</span></button>`;
  }).join("") : '<div class="canvas-library-empty">工作区里还没有图片、视频或音频</div>';
  box.querySelectorAll("[data-library-file]").forEach((button) => button.addEventListener("click", () => {
    const name = button.dataset.libraryFile, kind = canvasFileKind(name);
    const node = canvasAddNode(kind, { title: String(name).split("/").pop(), path: name, role: kind === "image" ? "参考素材" : kind === "video" ? "视频素材" : "声音素材", tags: "", url: `/api/files/view/${name.split("/").filter(Boolean).map(encodeURIComponent).join("/")}` }, { x: 120 + (canvasState.next % 3) * 420, y: 760 + Math.floor(canvasState.next / 3) * 290 });
    if (node) canvasToast("素材已添加到画布，可在右侧继续编辑或连接。", "plus");
  }));
}

async function canvasLoadLibrary() {
  const response = await fetch("/api/files").then((x) => x.json()).catch(() => []);
  canvasState.files = Array.isArray(response) ? response : [];
  canvasState.graph?.getElements?.().forEach((node) => canvasRefreshNode(node));
  canvasRenderLibrary(); canvasMaterializeResultNodes(); if (canvasSelectedNode()) canvasRenderInspector(false);
}

function canvasEmbeddedImage(payload, kind) {
  const value = kind === "character" ? (payload.reference || payload.image || payload.path) : (payload.image || payload.reference || payload.path);
  return canvasFileKind(value) === "image" ? String(value).trim() : "";
}

function canvasMaterializeResultNodes() {
  if (!canvasState.graph || !canvasState.files.length) return;
  const elements = canvasState.graph.getElements(), existing = new Set(elements.filter((node) => canvasKind(node) === "image").map((node) => canvasResolvedFileName(canvasMediaPath(canvasPayload(node)))));
  let created = 0;
  elements.filter((node) => ["character", "location"].includes(canvasKind(node))).forEach((source) => {
    const path = canvasResolvedFileName(canvasEmbeddedImage(canvasPayload(source), canvasKind(source)));
    if (!path || existing.has(path) || !canvasState.files.some((file) => String(file.name || file.path || "") === path)) return;
    const pos = source.position(), size = source.size(), title = path.split(/[\\/]/).pop();
    const image = canvasAddNode("image", { title, path, url: path, role: canvasKind(source) === "character" ? "角色定妆" : "场景参考", tags: canvasKind(source) === "character" ? "角色" : "场景", sourceId: source.id }, { x: pos.x + size.width + 70, y: pos.y }, { persist: false, skipSelect: true });
    if (image) { existing.add(path); canvasConnect(source, image); created++; }
  });
  if (created) canvasPersist();
}

function canvasRestoreOrSeed(remote = null) {
  const saved = remote && remote.nodes.length ? remote : canvasLoadSaved();
  if (saved && saved.nodes.length) {
    canvasApplySnapshot(saved); return;
  }
  const script = canvasAddNode("script", { title: "一句话概念", text: "在这里写一句话概念、人物关系、冲突、对白和结局。" }, { x: 100, y: 110 }, { persist: false, skipSelect: true });
  const storyboard = canvasAddNode("storyboard", {}, { x: 510, y: 110 }, { persist: false, skipSelect: true });
  if (script && storyboard) canvasConnect(script, storyboard); canvasState.selected = null; canvasState.selectedIds = new Set(); canvasRenderInspector(false); canvasPersist();
}

function canvasDestroy() { if (canvasState.remoteTimer) clearInterval(canvasState.remoteTimer); if (canvasState.remoteWriteTimer) clearTimeout(canvasState.remoteWriteTimer); if (canvasState.historyTimer) clearTimeout(canvasState.historyTimer); if (canvasState.fullscreenHandler) document.removeEventListener("fullscreenchange", canvasState.fullscreenHandler); const page = document.getElementById("assist-page"); if (page && canvasState.keyHandler) page.removeEventListener("keydown", canvasState.keyHandler); if (page && canvasState.keyUpHandler) page.removeEventListener("keyup", canvasState.keyUpHandler); if (canvasState.paper) canvasState.paper.remove(); canvasState.graph = null; canvasState.paper = null; canvasState.wheelHandler = null; canvasState.keyHandler = null; canvasState.keyUpHandler = null; canvasState.spacePanning = false; canvasState.inspectorOpen = false; canvasState.nodeGesture = null; canvasState.multiMove = null; canvasState.fullscreenHandler = null; canvasState.selected = null; canvasState.selectedIds = new Set(); canvasState.selectedAll = false; canvasState.remoteSnapshot = null; canvasState.remoteWritePending = false; canvasState.taskSessionId = null; canvasState.chatReferences = new Map(); canvasState.history = []; canvasState.historyIndex = -1; canvasState.historyTimer = null; }

async function renderCanvasPage() {
  const page = document.getElementById("assist-page"); if (!page) return; canvasDestroy(); await Promise.all([canvasLoadWorkspaceProjects(), canvasLoadCanvasList()]); canvasState.scale = 1; canvasState.x = 0; canvasState.y = 0; canvasState.next = 1;
  const groupOrder = ["策划", "世界设定", "分镜制作", "素材与生成", "交付"];
  const groupedMenu = groupOrder.map((group) => `<span class="canvas-menu-group"><span class="canvas-menu-group-label">${group}</span>${Object.entries(CANVAS_NODE_DEFS).filter(([, def]) => def.group === group).map(([kind, def]) => `<button class="canvas-type-btn" data-canvas-add="${kind}" title="${esc(def.subtitle)}">${ic(def.icon)}<span>${esc(def.label)}</span></button>`).join("")}</span>`).join("");
  const workspaceOptions = canvasState.workspaceProjects.map((item) => `<option value="${esc(item.name)}" ${item.name === canvasState.workspaceName ? "selected" : ""}>${esc(item.name)}</option>`).join("");
  page.classList.add("canvas-page");
  page.innerHTML = `<div class="canvas-head"><div><div class="canvas-kicker">WORKSPACE · 无限画布</div><h1>无限画布</h1><div class="canvas-board-switch"><label class="canvas-workspace-switch" title="${esc(canvasState.workspaceDir)}">${ic("folder")}<select data-canvas-workspace-select ${canvasState.workspaceLocked ? "disabled" : ""}>${workspaceOptions || `<option value="">${esc(canvasState.workspaceDir.split(/[\\/]/).pop() || "当前工作文件夹")}</option>`}${canvasState.workspaceLocked ? "" : '<option value="__pick__">选择其他文件夹…</option>'}</select></label><span class="canvas-switch-divider"></span><select data-canvas-board-select>${canvasState.canvasList.map((item) => `<option value="${esc(item.name)}" ${item.name === canvasState.canvasName ? "selected" : ""}>${esc(item.title || item.name)}</option>`).join("")}</select><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-new>新建画布</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-delete>删除当前</button></div></div><div class="canvas-head-actions"><button class="ui-btn ui-btn--brand ui-btn--sm" data-canvas-starter>${ic("sparkles")}新建短剧工作流</button><button class="ui-btn ui-btn--outline ui-btn--sm" data-canvas-agent>${ic("bot")}Agent</button><button class="ui-btn ui-btn--outline ui-btn--sm" data-canvas-fullscreen>全屏</button><button class="ui-btn ui-btn--outline ui-btn--sm" data-canvas-save>${ic("save")}保存</button></div></div>
    <div class="canvas-toolbar"><span class="canvas-tool-cluster" aria-label="画布创作工具">
      <details class="canvas-node-menu"><summary title="添加节点" aria-label="添加节点"><span class="canvas-menu-label">${ic("plus")}</span></summary><div class="canvas-node-menu-body">${groupedMenu}</div></details>
      <details class="canvas-library"><summary title="打开素材" aria-label="打开素材"><span>${ic("folder-open")}</span></summary><div class="canvas-library-panel"><div class="canvas-library-tools"><input id="canvas-library-search" type="search" placeholder="搜索工作区素材…" /><select id="canvas-library-kind" aria-label="素材类型"><option value="all">全部类型</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select><button class="canvas-tool-button" type="button" title="刷新素材" aria-label="刷新素材" data-library-refresh>${ic("refresh-cw")}</button></div><div id="canvas-library-items" class="canvas-library-items"><div class="canvas-library-empty">正在读取工作区素材…</div></div></div></details>
      <span class="canvas-tool-divider"></span>
      <button class="canvas-tool-button" type="button" data-canvas-history="undo" title="撤销（Ctrl/Cmd+Z）" aria-label="撤销">${ic("rotate-ccw")}</button>
      <button class="canvas-tool-button is-redo" type="button" data-canvas-history="redo" title="重做（Ctrl/Cmd+Shift+Z）" aria-label="重做">${ic("rotate-ccw")}</button>
      <button class="canvas-tool-button" type="button" data-canvas-layout title="按生成关系自动排版" aria-label="自动排版">${ic("git-branch")}</button>
    </span><span class="canvas-zoom-box"><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-zoom="out">−</button><span id="canvas-zoom">100%</span><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-zoom="in">+</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-fit>适配</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-center>居中</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-zoom="reset">${ic("target")}复位</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-clear>清空</button></span></div>
    <div class="canvas-layout"><div id="canvas-viewport" class="canvas-viewport"><div id="canvas-world" class="canvas-world"></div></div><aside id="canvas-inspector" class="canvas-inspector"></aside></div>
    <section class="canvas-chat" aria-label="画布 Agent 对话"><div class="canvas-chat-head"><div><b>画布 Agent</b><small>直接对话，让 Agent 读取、添加、连接和生成节点</small></div><span>本项目内执行</span></div><div id="canvas-chat-log" class="canvas-chat-log"><div class="canvas-chat-message is-agent"><span class="canvas-chat-role">Agent</span><span class="canvas-chat-text">输入 @ 可引用画布节点或工作区素材。</span></div></div><div id="canvas-chat-mention-menu" class="canvas-chat-mention-menu" hidden></div><div class="canvas-chat-compose"><div id="canvas-chat-ref-chips" class="canvas-chat-ref-chips"></div><textarea id="canvas-chat-input" rows="2" placeholder="描述人物关系、交互动作和镜头；输入 @ 添加人物、背景、风格或首尾帧"></textarea><div class="canvas-chat-tools"><button class="canvas-chat-tool" type="button" data-canvas-chat-attach title="上传文件到当前工作文件夹">${ic("paperclip")}</button><input type="file" data-canvas-chat-file accept="image/*,video/*,audio/*" multiple hidden><button class="canvas-chat-tool" type="button" data-canvas-chat-mention title="引用画布节点或素材">@</button><div class="canvas-chat-tools-spacer"></div><select class="canvas-chat-mode" data-canvas-chat-mode title="执行模式"><option value="craft">Craft · 执行</option><option value="goal">Goal · 目标</option><option value="plan">Plan · 规划</option><option value="ask">Ask · 问答</option></select><select class="canvas-chat-model" data-canvas-chat-model title="模型"><option value="">默认模型</option></select><button class="canvas-chat-send" type="button" title="发送（Enter）" aria-label="发送" data-canvas-chat-send>${ic("arrow-up")}</button></div></div></section>`;
  await canvasLoadBoards(); const remote = await canvasLoadRemote(); const world = page.querySelector("#canvas-world"), J = typeof joint !== "undefined" ? joint : null;
  if (!J || !J.dia || !J.dia.Paper) { world.innerHTML = '<div class="canvas-empty">画布组件加载失败，请刷新页面。</div>'; return; }
  canvasState.graph = new J.dia.Graph({}, { cellNamespace: J.shapes });
  canvasState.paper = new J.dia.Paper({ el: world, model: canvasState.graph, width: 2400, height: 1600, gridSize: 16, drawGrid: { name: "dot", args: { color: "var(--wb-text-3)", thickness: 1, gap: 22 } }, background: { color: "transparent" }, cellViewNamespace: J.shapes, interactive: { elementMove: true, linkMove: false, labelMove: false, addLinkFromMagnet: false } });
  canvasBindViewport(page); canvasState.graph.on("change:position", canvasPersist); canvasState.graph.on("remove", canvasPersist);
  const toolMenus = [...page.querySelectorAll(".canvas-tool-cluster details")];
  toolMenus.forEach((menu) => menu.addEventListener("toggle", () => { if (menu.open) toolMenus.forEach((other) => { if (other !== menu) other.open = false; }); }));
  page.querySelectorAll("[data-canvas-add]").forEach((btn) => btn.addEventListener("click", () => { canvasAddNode(btn.dataset.canvasAdd); const menu = btn.closest("details"); if (menu) menu.open = false; }));
  page.querySelectorAll("[data-canvas-zoom]").forEach((btn) => btn.addEventListener("click", () => { const action = btn.dataset.canvasZoom; if (action === "reset") { canvasState.scale = 1; canvasState.x = 0; canvasState.y = 0; canvasState.paper.translate(0, 0); } else canvasZoom(page, canvasState.scale * (action === "in" ? 1.1 : .9)); canvasZoom(page, canvasState.scale); }));
  page.querySelector("[data-canvas-fit]").onclick = () => canvasFitAll(page);
  page.querySelector("[data-canvas-layout]").onclick = () => canvasAutoLayout(page);
  page.querySelectorAll("[data-canvas-history]").forEach((button) => button.addEventListener("click", () => button.dataset.canvasHistory === "undo" ? canvasUndo() : canvasRedo()));
  page.querySelector("[data-canvas-center]").onclick = () => canvasCenterSelected(page);
  page.querySelector("[data-canvas-clear]").onclick = () => { if (!canvasState.graph.getElements().length || confirm("清空当前画布的全部节点和连线？素材文件不会删除。")) { canvasState.graph.clear(); canvasState.selectedIds = new Set(); canvasState.selectedAll = false; canvasState.selected = null; canvasRenderInspector(); canvasPersist(); } };
  page.querySelector("[data-canvas-save]").onclick = () => { canvasPersist(); canvasToast("画布已保存到本机", "save"); };
  page.querySelector("[data-canvas-board-select]").onchange = (event) => { canvasState.canvasName = event.target.value || "main"; try { localStorage.setItem("openworkbuddy.canvas.name", canvasState.canvasName); } catch {} renderCanvasPage(); };
  page.querySelector("[data-canvas-workspace-select]")?.addEventListener("change", (event) => canvasSwitchWorkspace(event.target.value));
  page.querySelector("[data-canvas-new]").onclick = canvasCreateBoard;
  page.querySelector("[data-canvas-delete]").onclick = canvasDeleteBoard;
  page.querySelector("[data-canvas-agent]").onclick = () => canvasRunInternal(canvasSelectedNode());
  page.querySelector("[data-canvas-starter]").onclick = canvasCreateDramaWorkflow;
  page.querySelector("[data-canvas-chat-send]").onclick = canvasChatSend;
  const chatInput = page.querySelector("#canvas-chat-input"), chatFile = page.querySelector("[data-canvas-chat-file]");
  chatInput.addEventListener("input", () => { canvasRenderChatMentionMenu(); canvasSyncChatSendButton(); });
  chatInput.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) { evt.preventDefault(); canvasChatSend(); }
    else if (evt.key === "Escape") { page.querySelector("#canvas-chat-mention-menu").hidden = true; if (canvasState.chatBusy) canvasChatStop(); }
  });
  page.querySelector("[data-canvas-chat-mention]").onclick = () => { chatInput.value += (chatInput.value && !/\s$/.test(chatInput.value) ? " " : "") + "@"; chatInput.focus(); canvasRenderChatMentionMenu(); };
  page.querySelector("[data-canvas-chat-attach]").onclick = () => chatFile.click();
  chatFile.addEventListener("change", async () => { for (const file of Array.from(chatFile.files || []).slice(0, 6)) await canvasChatAttachFile(file); chatFile.value = ""; canvasSyncChatSendButton(); });
  const composer = page.querySelector(".canvas-chat-compose"), clearComposerDrag = () => composer.classList.remove("is-dragging");
  composer.addEventListener("dragover", (event) => { if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); composer.classList.add("is-dragging"); } });
  composer.addEventListener("dragleave", (event) => { if (!composer.contains(event.relatedTarget)) clearComposerDrag(); });
  composer.addEventListener("drop", async (event) => { event.preventDefault(); clearComposerDrag(); for (const file of Array.from(event.dataTransfer?.files || []).slice(0, 6)) await canvasChatAttachFile(file); canvasSyncChatSendButton(); });
  chatInput.addEventListener("paste", async (event) => { const files = Array.from(event.clipboardData?.files || []); if (!files.length) return; event.preventDefault(); for (const file of files.slice(0, 6)) await canvasChatAttachFile(file); canvasSyncChatSendButton(); });
  page.querySelector("[data-canvas-chat-model]").addEventListener("change", async (evt) => { canvasState.chatModel = evt.target.value || ""; const sessionId = canvasState.taskSessionId; if (sessionId) await fetch(`/api/session/${encodeURIComponent(sessionId)}/model`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: canvasState.chatModel || null }) }).catch(() => {}); });
  canvasRenderChatModelSelect();
  canvasSyncChatSendButton();
  const full = page.querySelector("[data-canvas-fullscreen]"), updateFullscreenLabel = () => { if (full) full.textContent = document.fullscreenElement === page ? "退出全屏" : "全屏"; };
  canvasState.fullscreenHandler = updateFullscreenLabel; document.addEventListener("fullscreenchange", updateFullscreenLabel);
  full.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (page.requestFullscreen) await page.requestFullscreen();
      else if (page.webkitRequestFullscreen) page.webkitRequestFullscreen();
      else canvasToast("当前窗口不支持全屏模式。", "circle-info", "err");
    } catch (error) { canvasToast(`进入全屏失败：${String(error.message || error).slice(0, 120)}`, "circle-x", "err"); }
  };
  updateFullscreenLabel();
  page.querySelector("[data-library-refresh]").onclick = (evt) => { evt.preventDefault(); canvasLoadLibrary(); };
  page.querySelector("#canvas-library-search").oninput = canvasRenderLibrary;
  page.querySelector("#canvas-library-kind").onchange = canvasRenderLibrary;
  page.querySelector("#canvas-viewport").addEventListener("pointerdown", () => toolMenus.forEach((menu) => { menu.open = false; }), { capture: true });
  canvasState.paper.on("element:pointerdown", (view, event) => {
    const movingIds = canvasState.selectedIds.has(view.model.id) && canvasState.selectedIds.size > 1 ? [...canvasState.selectedIds] : [];
    canvasState.nodeGesture = { id: view.model.id, x: Number(event?.clientX) || 0, y: Number(event?.clientY) || 0, moved: false };
    canvasState.multiMove = movingIds.length ? { anchor: view.model.id, positions: new Map(movingIds.map((id) => { const item = canvasState.graph.getCell(id); const point = item?.position?.() || { x: 0, y: 0 }; return [id, { x: point.x, y: point.y }]; })) } : null;
  });
  canvasState.paper.on("element:pointermove", (view, event) => {
    const gesture = canvasState.nodeGesture;
    if (!gesture || gesture.id !== view.model.id) return;
    const dx = (Number(event?.clientX) || 0) - gesture.x, dy = (Number(event?.clientY) || 0) - gesture.y;
    if (Math.hypot(dx, dy) > 4 && !gesture.moved) { gesture.moved = true; if (canvasState.inspectorOpen) { canvasState.inspectorOpen = false; canvasRenderInspector(false); } }
    const group = canvasState.multiMove;
    if (group?.anchor === view.model.id && gesture.moved) {
      const scale = canvasState.scale || 1;
      group.positions.forEach((start, id) => { if (id !== view.model.id) canvasState.graph.getCell(id)?.position(start.x + dx / scale, start.y + dy / scale); });
    }
  });
  canvasState.paper.on("element:pointerup", (view) => {
    const gesture = canvasState.nodeGesture; canvasState.nodeGesture = null;
    canvasState.multiMove = null;
    if (!gesture || gesture.id !== view.model.id || !gesture.moved) return;
    canvasState.skipNodeClick = view.model.id; canvasState.suppressInspectorUntil = Date.now() + 650;
    window.setTimeout(() => { if (canvasState.skipNodeClick === view.model.id) canvasState.skipNodeClick = null; }, 650);
  });
  canvasRestoreOrSeed(remote && remote.nodes.length ? remote : null); canvasHistoryReset(canvasSnapshot()); canvasStartRemoteSync();
  window.setTimeout(() => canvasFitAll(page), 0);
  canvasLoadLibrary();
}
