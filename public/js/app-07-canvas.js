/* 通用无限画布
 *
 * JointJS 只负责画布/节点/连线交互；这里负责 AI 短剧创作工作流的数据。
 * 一张画布可以同时放剧本、角色、场景、镜头、参考素材、生成结果、音频和时间线，
 * 节点数据保存到本地，节点之间的连线表示“这个输入喂给下一个创作步骤”。
 */
const CANVAS_STORAGE_KEY = "openworkbuddy.canvas.v3";
// 本机副本得一张画布一个键，而且键上还得有项目名。以前所有画布共用一个键，于是「切到 B 画布 →
// B 在项目里还是空的 → 拿本机副本来铺底」会把 A 的节点铺到 B 上，再自动保存一次就写进 B 的文件了。
// 后来按画布名分开了，项目名却一直没进去：甲客户的 main 和乙客户的 main 还是同一个键——
// 实测甲客户画布上那两张卡，切到乙客户之后原样出现在屏幕上，还被写进了乙客户的画布文件。
// 这一页正好是拿来跟客户分开工作的，隔壁客户的东西不该出现在这儿。
// 老键（不带项目名的那两个）只当历史副本读、只认第一个来问的项目（见 canvasLoadSaved），
// 不再往里写，免得升级上来的人丢掉手头这张
function canvasScope(name = canvasState.canvasName) { return `${canvasState.workspaceName || "?"}::${name || "main"}`; }
function canvasStorageKey(name = canvasState.canvasName) { return `${CANVAS_STORAGE_KEY}:${canvasScope(name)}`; }

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
  ["character", "人物身份"], ["background", "场景空间"], ["composition", "构图"], ["motion", "动作参考"], ["style", "画面风格"],
  ["prop", "道具"], ["continuity", "连续性"], ["first_frame", "首帧"], ["last_frame", "尾帧"], ["audio", "声音"], ["reference", "其他参考"],
];

const CANVAS_EDGE_RELATIONS = [
  ["input", "输入"], ["split", "拆分"], ["generate", "生成"], ...CANVAS_REFERENCE_USES,
];

let canvasState = {
  graph: null, paper: null, wheelHandler: null, scale: 1, x: 0, y: 0, next: 1,
  boards: [], files: [], busy: new Set(), selected: null, selectedIds: new Set(), nodeType: null,
  // 服务端**逐个确认过**盘上真没有的素材路径。注意不是「不在 files 里的那些」——
  // files 是截断过的清单（最深 3 层、最多 500 条），拿它判缺失会冤枉一大片，详见 canvasMediaAvailable
  missing: new Set(),
  selectedAll: false, marqueeMode: false, keyHandler: null, keyUpHandler: null, fullscreenHandler: null, spacePanning: false,
  inspectorOpen: false, nodeGesture: null, multiMove: null, skipNodeClick: null, suppressInspectorUntil: 0,
  // remoteContentKey：服务器上那份画布的内容指纹。屏幕上这份跟它一样就不再往上写（见 canvasPersist）
  remoteUpdatedAt: 0, remoteContentKey: "", remoteSnapshot: null, remoteTimer: null, remoteWriteTimer: null, remoteWriteArmed: null, remoteWritePending: false, suspendSync: false, castTimer: null,
  // 盘上那份画布读不出来时记下原因。有值就等于「这张画布现在不能写」，
  // 界面必须显示错误而不是一张白板——白板 + 自动保存正好把还有救的原件盖掉
  remoteBroken: "", remoteBrokenNotified: false, lostNotified: "",
  // 素材台账：/api/canvas/assets 算出来的「哪个文件谁在用」。null = 还没读到，
  // 这时素材面板退回只列文件——台账读不出来不该把整个面板一起拖下水
  assets: null, assetRole: "all", assetOnlyOrphan: false,
  // 制片进度：/api/canvas/progress 算出来的「这部戏做到哪了」。null = 还没读到，
  // 这时整条进度带不显示——宁可不显示，也不要显示一条编出来的 0%
  progress: null, progressOpen: false, batch: null,
  // 合成成片：composePlan 是「这次打算怎么拼」（算好了先给人看，不背着人跑），
  // composeJob 是「正在拼到哪了」。两个都是 null 就等于这条带子上只有一颗「合成成片」按钮
  composePlan: null, composeJob: null, composeTimer: null, composeSub: true, composeBgm: true,
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
function canvasRelationLabel(relation) { return CANVAS_EDGE_RELATIONS.find(([key]) => key === relation)?.[1] || "输入"; }
function canvasDefaultRelation(source, target) {
  const sourceKind = canvasKind(source), targetKind = canvasKind(target);
  if (["image", "video", "audio"].includes(targetKind)) return "generate";
  if (sourceKind === "script" && targetKind === "storyboard") return "split";
  if (sourceKind === "character") return "character";
  if (sourceKind === "location") return "background";
  if (sourceKind === "video") return "motion";
  if (sourceKind === "audio") return "audio";
  if (sourceKind === "image") return "reference";
  return "input";
}
function canvasLinkRelation(link, source, target) { return String(link?.get?.("canvasRelation") || canvasDefaultRelation(source, target)); }
function canvasRelationOptions(selected, source, target) {
  const defaults = new Set([canvasDefaultRelation(source, target), "reference"]);
  const allowed = CANVAS_EDGE_RELATIONS.filter(([key]) => ["input", "split", "generate"].includes(key) || defaults.has(key) || ["character", "background", "composition", "motion", "style", "prop", "continuity", "first_frame", "last_frame", "audio"].includes(key));
  return allowed.map(([key, label]) => `<option value="${key}" ${key === selected ? "selected" : ""}>${label}</option>`).join("");
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
/**
 * 画布节点上那张图要的地址。w 传了就要缩略图。
 *
 * 节点里的预览框最高 204px（ui.css .canvas-node-preview），可短剧画布上摆的是
 * 生成出来的成图——本机工作空间里真实躺着 3552×4736 的图，一张解码后 64 MB。
 * 一块摆满三十个镜头的画布就是几个 GB 的位图，浏览器直接放弃，画面上一片空白：
 * 用户那句「无限画布还有很大文件都没有办法正常显示」说的就是这个。
 * 所以节点预览一律要 640 的缩略图（画布能放大，640 留够余量），双击放大那个灯箱
 * 才给原图——那时候屏幕上就这一张，本来就该看清楚。
 * 服务端缩不动会自己发原图（细账在 thumb.js），所以这儿不用判断跑在哪儿。
 * svg 不缩：矢量本来就小，栅格化反而更大更糊。外链和 data: 更不能动。
 */
function canvasFileUrl(value, w) {
  const name = canvasResolvedFileName(value);
  if (!name) return "";
  const thumb = w && !/\.svg(\?|$)/i.test(name) ? "?thumb=" + w : "";
  if (/^(https?:|data:)/i.test(name)) return name;
  if (/^\/api\/files\/view\//i.test(name)) return thumb && !/[?&]thumb=/.test(name) ? name + (name.includes("?") ? "&" : "?") + "thumb=" + w : name;
  return "/api/files/view/" + name.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join("/") + thumb;
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
/**
 * 这个素材还在不在。
 *
 * 曾经的写法是「不在 canvasState.files 里就是被删了」，而那份列表是**截断过的**：
 * 服务端最深只走 3 层、最多给 500 条（tools.js 的 outputFiles），/api/files 那一趟失败时
 * 它还会是空的。于是工作目录一攒多、或者素材落在深一层的会话子目录里、或者网络抖一下，
 * 满画布的节点一起挂出「素材已从工作区移除」——文件明明就在盘上躺着。
 * 这事犯过不止一次，所以这回从根上改。
 *
 * 所以默认改成**认在**：在清单里当然在；不在清单里只能说明「这份清单里没有」，
 * 那就去问盘（canvasVerifyMissing → POST /api/files/exists），盘回了「确实没有」才进
 * missing，也才画那条横幅。宁可晚一个来回说实话，不抢在前面说瞎话。
 */
function canvasMediaAvailable(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(https?:|data:|\/api\/files\/view\/)/i.test(raw)) return Boolean(raw);
  const resolved = canvasResolvedFileName(raw);
  if (canvasState.files.some((file) => String(file.name || file.path || "") === resolved)) return true;
  return !canvasState.missing.has(resolved) && !canvasState.missing.has(raw);
}
function canvasAudioPreview(value) {
  const url = canvasFileUrl(value);
  if (!url) return "";
  return `<audio class="canvas-audio-preview" data-canvas-audio-preview data-canvas-media-path="${esc(value)}" controls preload="metadata"><source src="${esc(url)}" type="${esc(canvasMediaMime(value))}">此浏览器不支持音频预览。</audio>`;
}
function canvasOutputFilename(payload, kind, nodeKind = "") {
  const p = payload || {}, clean = (v, fb) => String(v || "").replace(/[^\w\-一-龥]+/g, "_") || fb;
  // 定妆照、场景图得按素材台账认得出的前缀落盘：台账的「用途」是按文件名判的，
  // 名字起错了，生成完在界面上会掉进「其他」，回头人找都找不着。
  if (nodeKind === "character") return `角色_${clean(p.name || p.title, "角色")}_定妆.png`;
  if (nodeKind === "location") return `场景_${clean(p.name || p.title, "场景")}.png`;
  const id = clean(p.id || p.title, "镜头");
  return kind === "image" ? `镜头_${id}_首帧.png` : kind === "video" ? `镜头_${id}.mp4` : `配音_${id}.mp3`;
}

function canvasDefaultPayload(kind) {
  switch (kind) {
    case "script": return { title: "新剧本", text: "一句话概念、人物关系、冲突与结局…" };
    case "agent": return { title: "Agent任务", role: "导演 Agent", task: "根据上游剧本和素材生成可审核的短剧创作计划。", status: "待执行", approval: "先给方案，等我确认" };
    case "character": return { name: "新角色", role: "主角", description: "人物外形、性格、目标与关系…", reference: "", voice: "" };
    case "location": return { name: "新场景", description: "地点、时间、天气、光线与氛围…" };
    case "shot": return { id: "S1-01", title: "新镜头", shot_size: "中景", duration: "4", prompt: "镜头内容与运动…", motion_prompt: "", line: "对白或旁白…", speaker: "" };
    case "image": return { title: "参考图", url: "", role: "参考素材", tags: "", prompt: "这张图要保持的主体、风格与构图…" };
    case "video": return { title: "Video", url: "", role: "生成结果", tags: "", prompt: "描述你想生成的内容…", model: "", aspect_ratio: "16:9", resolution: "1080p", duration: "5s" };
    case "audio": return { title: "声音", url: "", role: "对白/音乐", tags: "", text: "对白、旁白或音乐说明…", voice: "" };
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
  // 当前这条路径不在上面两组里的时候，必须留一个**选中的**选项把它自己摆出来，否则 select 的
  // value 就掉成 ""——用户随手点开一下右侧面板，这条引用当场被抹掉。这不是显示问题是丢数据。
  // 只有「问过盘、确认它真没了」的才换成提醒占位（那时候这条路径本来也没用了）；
  // 仅仅是「不在那份截断过的清单里」，一律原样留着。判据统一走 canvasMediaAvailable。
  const inGroups = files.includes(current) || uniqueNodes.some((item) => item.value === current);
  const currentOption = !current || inGroups
    ? ""
    : canvasMediaAvailable(current)
      ? `<option value="${esc(current)}" selected>${esc(String(current).split(/[\\/]/).pop())}（当前）</option>`
      : '<option value="" selected>素材已移除，请重新选择</option>';
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
  // 这个版本认不出的类型：照原样显示，只读。可能是新版本建的，也可能是别的分支建的。
  // 要紧的是别把它画成一张可编辑的空白笔记——那样用户随手一打字，就把人家节点的
  // payload 盖成 { text: "..." } 了。服务端已经保证读写不丢这种节点
  // （tools.js canvasNormalizeState 不再按白名单挑食），这里只要不误导人。
  if (!CANVAS_NODE_DEFS[kind]) {
    const shown = Object.keys(payload || {}).filter((key) => payload[key] !== "" && payload[key] != null).slice(0, 6);
    return `<article class="canvas-node canvas-node-unknown">${header(payload.title || payload.name || payload.id || "认不出的节点", `这个版本不认识「${kind}」`)}<div class="canvas-node-body"><p class="canvas-unknown-tip">内容已原样保留，不会丢。换回建它的那个版本就能编辑。</p>${shown.length ? `<ul class="canvas-unknown-keys">${shown.map((key) => `<li><b>${esc(key)}</b><span>${esc(String(payload[key]).slice(0, 60))}</span></li>`).join("")}</ul>` : ""}</div></article>`;
  }
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
      ? `<img class="canvas-node-preview" data-canvas-image-preview data-canvas-media-path="${esc(payload.first_frame)}" src="${esc(canvasFileUrl(payload.first_frame, 640))}" alt="首帧" loading="lazy" title="双击放大预览">`
      : payload.reference_video
        ? `<video class="canvas-node-preview" src="${esc(canvasFileUrl(payload.reference_video))}" controls preload="metadata"></video>`
        : "";
    return `<article class="canvas-node canvas-node-shot">${header(payload.id || payload.title || "新镜头", `${payload.shot_size || "镜头"} · ${payload.duration || "4"}s`)}<div class="canvas-node-body">${shotMedia}<div class="canvas-shot-prompt">${esc(payload.prompt || "还没有镜头提示词")}</div><div class="canvas-shot-line">${esc(payload.line || "无人声")}</div>${canvasGenerationSummary(payload)}<div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-generate="image" ${imageBusy ? "disabled" : ""}>${imageBusy ? "生成中…" : payload.first_frame ? "重跑首帧" : "生成首帧"}</button><button class="ui-btn ui-btn--sm ui-btn--ghost" data-canvas-generate="video" ${videoBusy || !payload.first_frame ? "disabled" : ""}>${videoBusy ? "生成中…" : "生成视频"}</button>${payload.first_frame ? `<button class="canvas-node-icon-action" data-canvas-side-preview="${esc(payload.first_frame)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button>` : ""}</div></div></article>`;
  }
  if (kind === "agent") return `<article class="canvas-node canvas-node-agent">${header(payload.title || "Agent任务", payload.role || "本项目 Agent") }<div class="canvas-node-body"><div class="canvas-agent-status">${esc(payload.status || "待执行")}</div><div class="canvas-node-copy">${esc(payload.task || "描述要让 Agent 完成的创作任务")}</div><button class="ui-btn ui-btn--sm ui-btn--brand" data-canvas-agent>${ic("sparkles")}运行这个任务</button></div></article>`;
  if (kind === "video") {
    const busy = canvasState.busy.has(`${nodeId}:video`), mediaPath = String(payload.video || canvasMediaPath(payload) || "").trim(), frame = String(payload.first_frame || "").trim();
    const preview = mediaPath ? `<video class="canvas-video-preview" src="${esc(canvasFileUrl(mediaPath))}" controls preload="metadata"></video>` : `<div class="canvas-video-empty">${ic("play")}<span>生成结果会显示在这里</span></div>`;
    const refs = [frame ? `首帧 · ${frame.split(/[\\/]/).pop()}` : "首帧 · 未设置", payload.last_frame ? `尾帧 · ${String(payload.last_frame).split(/[\\/]/).pop()}` : "尾帧 · 可选", payload.reference_video ? `参考视频 · ${String(payload.reference_video).split(/[\\/]/).pop()}` : "参考视频 · 可选"];
    return `<article class="canvas-node canvas-node-video">${header(payload.title || "Video", `${payload.model || "视频生成"} · ${payload.aspect_ratio || "16:9"}`)}<div class="canvas-node-body"><div class="canvas-video-stage">${preview}</div><textarea class="canvas-video-prompt" data-canvas-inline-key="prompt" rows="2" placeholder="描述任何你想生成的内容…">${esc(payload.prompt || "")}</textarea><div class="canvas-video-refs">${refs.map((ref) => `<span>${esc(ref)}</span>`).join("")}</div><div class="canvas-video-settings"><span>${esc(payload.model || "默认模型")}</span><span>${esc(payload.aspect_ratio || "16:9")}</span><span>${esc(payload.resolution || "1080p")}</span><span>${esc(payload.duration || "5s")}</span></div>${canvasGenerationSummary(payload)}<div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--brand" data-canvas-generate="video" ${busy ? "disabled" : ""}>${busy ? "生成中…" : mediaPath ? "重新生成" : "生成视频"}</button>${mediaPath ? `<button class="canvas-node-icon-action" data-canvas-side-preview="${esc(mediaPath)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button>` : ""}</div></div></article>`;
  }
  if (kind === "image" || kind === "audio") {
    const mediaText = payload.text || payload.prompt || "还没有素材或描述";
    const mediaPath = canvasMediaPath(payload), mediaAvailable = canvasMediaAvailable(mediaPath), media = kind === "image" && mediaPath && mediaAvailable
      ? `<img class="canvas-node-preview canvas-image-preview" data-canvas-image-preview data-canvas-media-path="${esc(mediaPath)}" src="${esc(canvasFileUrl(mediaPath, 640))}" alt="${esc(payload.title || def.label)}" loading="lazy" title="双击放大预览">`
      : kind === "audio" && mediaPath && mediaAvailable
        ? canvasAudioPreview(mediaPath)
        : "";
    const missing = mediaPath && !mediaAvailable ? `<div class="canvas-media-missing">素材已从工作区移除，请在右侧重新选择或上传。</div>` : "";
    const action = kind === "audio" ? "生成配音" : mediaPath && mediaAvailable ? `重跑${def.label}` : `生成${def.label}`;
    const busy = canvasState.busy.has(`${nodeId}:${kind}`);
    return `<article class="canvas-node canvas-node-media canvas-node-${kind}">${header(payload.title || def.label, kind === "image" ? "点击图片放大" : "可直接播放")}<div class="canvas-node-body">${media}${missing}<div class="canvas-media-text">${esc(mediaText)}</div>${canvasGenerationSummary(payload)}<div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-generate="${kind}" ${busy ? "disabled" : ""}>${busy ? "生成中…" : action}</button>${mediaPath && mediaAvailable ? `<button class="canvas-node-icon-action" data-canvas-side-preview="${esc(mediaPath)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button>` : ""}</div></div></article>`;
  }
  if (kind === "timeline") {
    // 这一格以前只有一颗「交给 Agent」，按下去得到的是一段文字方案，不是一条片子。
    // 前面六档都已经是「按一下就出文件」了，最后一档不能是「按一下出一段话」
    const film = String(payload.subtitled || payload.video || "").trim();
    const running = canvasState.composeJob && !canvasState.composeJob.done;
    const preview = film ? `<video class="canvas-video-preview" src="${esc(canvasFileUrl(film))}" controls preload="metadata"></video>` : "";
    return `<article class="canvas-node canvas-node-timeline">${header(payload.title || "最终剪辑", film ? `成片 · ${payload.shots ? payload.shots + " 镜" : "已合成"}` : "把镜头按顺序拼成成片")}<div class="canvas-node-body">${preview || `<p>${esc(payload.description || "按分镜顺序逐镜合轨、拼接、垫配乐、烧字幕，全在本机跑。")}</p>`}<div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--brand" data-canvas-compose ${running ? "disabled" : ""}>${running ? "正在合成…" : film ? "重新合成" : "合成成片"}</button>${film ? `<button class="canvas-node-icon-action" data-canvas-side-preview="${esc(film)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button>` : ""}<button class="ui-btn ui-btn--sm ui-btn--ghost" data-canvas-agent>交给本项目 Agent</button></div>${film ? `<p class="canvas-node-hint">${esc(film)}</p>` : ""}</div></article>`;
  }
  if (kind === "script") return `<article class="canvas-node canvas-node-script">${header(payload.title || "新剧本")}<div class="canvas-node-body canvas-node-copy">${esc(payload.text || "还没有剧本内容")}</div></article>`;
  if (kind === "character" || kind === "location") {
    const embedded = canvasEmbeddedImage(payload, kind), preview = embedded ? `<img class="canvas-node-preview canvas-embedded-preview" data-canvas-image-preview data-canvas-media-path="${esc(embedded)}" src="${esc(canvasFileUrl(embedded, 640))}" alt="${esc(payload.name || def.label)}" loading="lazy" title="双击放大预览">` : "";
    // 定妆照以前只能自己去文件夹里挑一张，或者指望 Agent 临场发挥。可它是整部戏一致性的地基：
    // 镜头生首帧时会把上游角色节点的图当参考图带上，没有这张图，每一镜的脸就不是同一个人。
    const busy = canvasState.busy.has(`${nodeId}:image`);
    const what = kind === "character" ? "定妆照" : "场景图";
    const act = busy ? "生成中…" : embedded ? `重生成${what}` : `生成${what}`;
    return `<article class="canvas-node canvas-node-${kind}">${header(kind === "character" ? (payload.name || "新角色") : (payload.name || "新场景"), kind === "character" ? (payload.role || "角色") : def.subtitle)}<div class="canvas-node-body canvas-node-copy">${preview}${esc(payload.description || (embedded ? "" : kind === "character" ? "还没有人物设定" : "还没有场景设定"))}${canvasGenerationSummary(payload)}<div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-generate="image" ${busy ? "disabled" : ""}>${esc(act)}</button>${embedded ? `<button class="canvas-node-icon-action" data-canvas-side-preview="${esc(embedded)}" title="右侧预览" aria-label="右侧预览">${ic("eye")}</button>` : ""}</div></div></article>`;
  }
  return `<article class="canvas-node canvas-node-note">${header(payload.title || "画布笔记")}<div class="canvas-node-body canvas-note-edit" contenteditable="true" spellcheck="false">${esc(payload.text || "在这里记录想法、任务或素材线索…")}</div></article>`;
}

function canvasSelectedNode() { return canvasState.graph && canvasState.selected ? canvasState.graph.getCell(canvasState.selected) : null; }
/**
 * 把选中集合落到状态里，再让界面跟上。anchor 是「这一下点的是谁」——
 * 属性面板认的是它，不给就取集合里的第一个。
 */
function canvasSetSelection(ids, anchor) {
  const next = ids instanceof Set ? ids : new Set(ids || []);
  const all = canvasState.graph?.getElements?.() || [];
  canvasState.selectedIds = next;
  canvasState.selectedAll = next.size > 0 && next.size === all.length;
  canvasState.selected = anchor && next.has(anchor) ? anchor : [...next][0] || null;
  if (next.size !== 1) canvasState.inspectorOpen = false;
  canvasRenderInspector(false);
}
function canvasPreviewRight(value) {
  const path = String(value || "").trim(); if (!path) return canvasToast("这个节点还没有可预览的文件。", "info");
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
  root.classList.toggle("is-selected", canvasState.selectedAll || canvasState.selectedIds.has(node.id) || canvasState.selected === node.id);
}

function canvasSnapshot() {
  if (!canvasState.graph) return { version: 1, nodes: [], edges: [], updatedAt: Date.now() };
  return {
    version: 1,
    nodes: canvasState.graph.getElements().map((node) => ({ id: node.id, kind: canvasKind(node), payload: canvasPayload(node), position: node.position(), size: node.size() })),
    edges: canvasState.graph.getLinks().map((link) => {
      const source = canvasState.graph.getCell(canvasEndpointId(link.get("source"))), target = canvasState.graph.getCell(canvasEndpointId(link.get("target")));
      return { source: { id: canvasEndpointId(link.get("source")) }, target: { id: canvasEndpointId(link.get("target")) }, relation: canvasLinkRelation(link, source, target) };
    }).filter((edge) => edge.source.id && edge.target.id && edge.source.id !== edge.target.id),
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
  // 换项目更急：服务端认的是「当前项目」，这边一换，欠着的那趟就会写进新项目的画布文件
  await canvasFlushRemoteWrite();
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
  await canvasFlushRemoteWrite();   // 手上这张还欠着一趟存盘，先写完再换人
  const response = await fetch("/api/canvas/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return canvasToast(data.error || "新建画布失败", "circle-x", "err");
  canvasState.canvasName = data.name || name; try { localStorage.setItem("openworkbuddy.canvas.name", canvasState.canvasName); } catch {}
  // 以前叫这个名字的画布留下的本机副本，跟这张新的没有关系。不擦掉的话，删一张再建一张同名的，
  // 上面原样长出删掉那张的东西，还会被存回服务器——用户明明删过一次
  try { localStorage.removeItem(canvasStorageKey(canvasState.canvasName)); } catch {}
  await renderCanvasPage(); canvasToast(`已创建画布「${canvasState.canvasName}」`, "circle-check");
}
async function canvasDeleteBoard() {
  if (canvasState.canvasName === "main") return canvasToast("主画布不能删除。", "info");
  if (!confirm("删除这张画布？画布节点会删除，素材文件不会删除。")) return;
  await canvasFlushRemoteWrite();   // 欠着的那一趟要么现在写给它自己，要么等会儿写到 main 上去
  const gone = canvasState.canvasName;
  const response = await fetch("/api/canvas/boards/" + encodeURIComponent(gone), { method: "DELETE" });
  if (!response.ok) return canvasToast("删除画布失败", "circle-x", "err");
  try { localStorage.removeItem(canvasStorageKey(gone)); } catch {}   // 服务器那份删了，本机这份也得删
  canvasState.canvasName = "main"; try { localStorage.setItem("openworkbuddy.canvas.name", "main"); } catch {}
  renderCanvasPage();
}

function canvasPersist() {
  // 一次摆几十个节点和连线的时候（展开分镜表就是），每加一个都整图序列化一遍存盘 + 记一条撤销，
  // 十二镜的戏要跑六十来趟。收在这儿而不是收在调用方：canvasConnect 里那句存盘也在这条路上。
  // 顺带一个好处——整次展开只记一条撤销，按一次 ⌘Z 回到展开前，而不是要按六十次。
  if (canvasState.bulk) return;
  if (!canvasState.graph || typeof localStorage === "undefined") return;
  const snapshot = canvasSnapshot();
  try { localStorage.setItem(canvasStorageKey(), JSON.stringify({ ...snapshot, version: 3, savedAt: Date.now() })); } catch {}
  canvasHistorySchedule(snapshot);
  if (canvasState.suspendSync) return;
  // 屏幕上这份跟服务器上那份一个字不差，就别再写一趟。省的不是流量，是那条死循环：
  // 服务端每写一次都把 updatedAt 换成现在，对面那个标签页看见就当是新改动，拉下来、
  // 铺上去、再写回来……两边每 1.8 秒各写一次盘，每次还连带把旧文件拷一份 .bak
  const contentKey = canvasHistoryKey(snapshot);
  if (contentKey === canvasState.remoteContentKey) return;
  if (canvasState.remoteWriteTimer) clearTimeout(canvasState.remoteWriteTimer);
  // 这一趟要写给哪张画布，现在就定死。等 240 毫秒后定时器烧到了再去读 canvasState.canvasName，
  // 这中间切走的话就写到下一张画布上了——实测防抖还没烧完就切画布，第二张画布上原来那个节点
  // 被第一张的内容整个顶掉，而且它自己的文件从此就是这样了
  const armed = { scope: canvasScope(), name: canvasState.canvasName, snapshot, contentKey };
  canvasState.remoteWriteArmed = armed;
  canvasState.remoteWriteTimer = window.setTimeout(() => { canvasState.remoteWriteTimer = null; canvasPushRemote(armed); }, 240);
}

/** 把一份快照写回它自己那张画布。写给谁是按下那一刻记好的，不看现在选的是哪张 */
async function canvasPushRemote(armed) {
  if (!armed) return;
  if (canvasState.remoteWriteArmed === armed) canvasState.remoteWriteArmed = null;
  // 已经切到别的画布、别的项目了：服务端认的是「当前项目」，这份寄不回原来那张，
  // 硬写就是拿这张的内容去盖那张。本机副本里还留着，回到那张画布接着改照样写得上去
  if (canvasScope() !== armed.scope) return;
  canvasState.remoteWritePending = true;
  try {
    const response = await fetch("/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: armed.name, state: armed.snapshot }) });
    const result = await response.json().catch(() => ({}));
    if (response.status === 409 && result.unreadable) {
      // 服务器拒绝拿屏幕上这份去盖一个读不出来的文件。这是对的，但必须让用户知道，
      // 否则他会一直以为在存，关掉页面才发现今天白干了
      canvasState.remoteBroken = result.error || "盘上那份画布读不出来，所以没有覆盖它";
      if (!canvasState.remoteBrokenNotified) {
        canvasState.remoteBrokenNotified = true;
        canvasToast("项目里那份画布文件读不出来，刚才的改动没存进去（本机还留着）。刷新页面看怎么处理。", "circle-x", "err");
      }
    } else if (response.ok && result.state) {
      canvasState.remoteUpdatedAt = Number(result.state.updatedAt) || canvasState.remoteUpdatedAt;
      canvasState.remoteContentKey = armed.contentKey;   // 存上去了，这会儿两边一样
    }
  } catch {} finally { canvasState.remoteWritePending = false; }
}

/** 切画布、切项目之前，先把欠着的那一趟写完 —— 走了再写就寄不到原来那张了 */
async function canvasFlushRemoteWrite() {
  const armed = canvasState.remoteWriteArmed;
  if (!armed) return;
  if (canvasState.remoteWriteTimer) { clearTimeout(canvasState.remoteWriteTimer); canvasState.remoteWriteTimer = null; }
  await canvasPushRemote(armed);
}

function canvasLoadSaved() {
  try {
    const raw = localStorage.getItem(canvasStorageKey());
    if (!raw) return canvasLoadLegacySaved();
    const value = JSON.parse(raw); return value && Array.isArray(value.nodes) ? value : null;
  } catch { return null; }
}

/**
 * 升级上来的那份本机副本，键上没有项目名，看不出是谁的。
 * 谁问就给谁的话，第二个项目一打开画布就会看见第一个项目的东西，还会把它存进自己的画布文件。
 * 所以只让第一个来问的项目认领一次，认领结果记在旁边；别的项目问到的是「没有」。
 */
function canvasLoadLegacySaved() {
  const name = canvasState.canvasName || "main";
  const raw = localStorage.getItem(`${CANVAS_STORAGE_KEY}:${name}`) || (name === "main" ? localStorage.getItem(CANVAS_STORAGE_KEY) : null);
  if (!raw) return null;
  const ownerKey = `${CANVAS_STORAGE_KEY}.owner:${name}`, me = canvasState.workspaceName || "?";
  const owner = localStorage.getItem(ownerKey);
  if (owner && owner !== me) return null;
  const value = JSON.parse(raw || "null");
  if (!value || !Array.isArray(value.nodes)) return null;
  if (!owner) { try { localStorage.setItem(ownerKey, me); } catch {} }
  return value;
}

function canvasDecorateLink(link, relation) {
  if (!link) return;
  const text = canvasRelationLabel(relation);
  link.set("canvasRelation", relation);
  link.labels([{ position: .5, attrs: { text: { text, fill: "var(--owb-brand-text)", fontSize: 10, fontWeight: 650 }, rect: { fill: "var(--owb-bg)", stroke: "var(--owb-border)", strokeWidth: 1, rx: 7, ry: 7 } } }]);
}

function canvasConnect(source, target, relation = "") {
  if (!canvasState.graph || !source || !target || source.id === target.id) return;
  const normalizedRelation = CANVAS_EDGE_RELATIONS.some(([key]) => key === relation) ? relation : canvasDefaultRelation(source, target);
  const existing = canvasState.graph.getLinks().find((link) => canvasEndpointId(link.get("source")) === source.id && canvasEndpointId(link.get("target")) === target.id);
  if (existing) { canvasDecorateLink(existing, normalizedRelation); canvasPersist(); return existing; }
  const J = typeof joint !== "undefined" ? joint : null; if (!J) return;
  const link = new J.shapes.standard.Link({ source: { id: source.id }, target: { id: target.id }, router: { name: "manhattan", args: { step: 16, padding: 20 } }, attrs: { line: { stroke: "var(--owb-brand-text)", strokeWidth: 2.25, strokeLinecap: "round", targetMarker: { type: "path", d: "M 9 -4.5 0 0 9 4.5 z" } } }, connector: { name: "rounded" }, z: 1 });
  canvasDecorateLink(link, normalizedRelation);
  canvasState.graph.addCell(link); canvasPersist();
  return link;
}

async function canvasLoadRemote() {
  // 要 response 本身，不能直接 .json()：服务器用 409 表示「盘上那份读不出来」。
  // 只看 body 的话，那个响应里的 nodes: [] 会被当成一张真的空画布——
  // 接着界面画白板、自动保存一回，原件就没了。这正是要防的那件事。
  canvasState.remoteBroken = "";                    // 先清掉上一张画布/上一次的结论，免得拿旧账报新错
  const scope = canvasScope();                      // 这趟问的是哪张画布，先记下
  const response = await fetch("/api/canvas?name=" + encodeURIComponent(canvasState.canvasName)).catch(() => null);
  if (!response) return null;                       // 断网：什么都不做，本机那份还在
  const body = await response.json().catch(() => null);
  // 等回包这会儿人已经切到别的画布 / 别的项目了：这份是上一张的，不能往新的身上安
  if (canvasScope() !== scope) return null;
  if (!response.ok || (body && body.unreadable)) {
    canvasState.remoteBroken = (body && body.error) || `画布读取失败（HTTP ${response.status}）`;
    return null;
  }
  canvasState.remoteBroken = "";
  if (!body || !Array.isArray(body.nodes)) return null;
  canvasState.remoteSnapshot = body;
  if (body.lost) canvasReportLost(body.lost);
  return body;
}

/**
 * 这一趟读少了什么，说出来。
 *
 * 服务端现在不替用户删东西了，但有些情况它确实没法原样给出来（比如连线的一头
 * 已经不在了），还有些是「超了上限但留着」。这些都得让用户看见——
 * 默默少几个节点，正是之前那个「打开画布发现东西没了」的手感。
 */
function canvasReportLost(lost) {
  const parts = [];
  if (lost.noId) parts.push(`${lost.noId} 个节点没有 id，画不出来`);
  if (lost.danglingEdges) parts.push(`${lost.danglingEdges} 条连线的一头不在了`);
  if (lost.overflowNodes) parts.push(`节点数超出上限 ${lost.overflowNodes} 个（照样都在，只是加不了新的）`);
  if (lost.overflowEdges) parts.push(`连线数超出上限 ${lost.overflowEdges} 条（照样都在）`);
  if (!parts.length) return;
  const message = parts.join("；");
  if (canvasState.lostNotified === message) return;   // 同步每 1.8 秒跑一次，同一句话别刷屏
  canvasState.lostNotified = message;
  canvasToast(`这张画布：${message}`, "triangle-alert", "err");
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

/**
 * 把一份快照铺到画布上。
 *
 * fromRemote：这份是刚从服务器拉回来的。拉回来的东西铺完不能再写回去——
 * 服务端每写一次就把 updatedAt 换成现在（tools.js canvasWriteState），另一个标签页
 * 一看「又新了」就也拉、也铺、也写回去，两边能这么来回顶到天亮，谁都没动过画布。
 * 撤销、重做、本机改动走的是同一个函数，那些当然要写回去，所以默认是 false。
 *
 * 这儿以前还有一句按标题删节点的代码：标题是「开始工作」或「开始创作」的一律不铺，
 * 连着的线也一起扔。本意大概是清掉模板起始卡片，可代码里从来没有谁造过这两个标题的节点，
 * 于是它能撞上的只有用户自己写的那张卡——而「开始工作」恰好是人给第一张卡起的名字。
 * 删完还顺手存一次盘，本机那份、服务器那份一起变瘦。整句拿掉了。
 */
function canvasApplySnapshot(snapshot, { fromRemote = false } = {}) {
  if (!canvasState.graph || !snapshot || !Array.isArray(snapshot.nodes)) return;
  const previousSelection = canvasState.selected;
  const previousIds = [...(canvasState.selectedIds || [])];
  const currentEdges = canvasState.graph.getLinks().length ? canvasSnapshot().edges : [];
  const incomingEdges = Array.isArray(snapshot.edges) && snapshot.edges.length ? snapshot.edges : currentEdges;
  const restoredSnapshot = canvasInferLegacyEdges({ ...snapshot, edges: incomingEdges });
  canvasState.suspendSync = true;
  try {
    canvasState.graph.clear(); const byId = new Map();
    restoredSnapshot.nodes.forEach((item) => { const node = canvasAddNode(item.kind, item.payload, item.position, { persist: false, skipSelect: true, id: item.id }); if (node) { if (item.size) node.resize(Number(item.size.width) || node.size().width, Number(item.size.height) || node.size().height); byId.set(item.id, node); } });
    (restoredSnapshot.edges || []).forEach((edge) => canvasConnect(byId.get(canvasEndpointId(edge.source)), byId.get(canvasEndpointId(edge.target)), edge.relation));
    // 加载或同步不应抢走画布空间：只保留用户已经打开、且仍存在的节点属性。
    // 选中的是一片就还它一片——框选十二个之后来一趟同步只剩一个还选着的话，
    // 下一下 Delete 删掉的就不是他以为的那一片。对方真删掉的那几个才从集合里去掉。
    const keptIds = previousIds.filter((id) => byId.has(id));
    const keepSelection = previousSelection && byId.has(previousSelection) ? previousSelection : keptIds[0] || null;
    canvasState.selectedIds = new Set(keptIds);
    canvasState.selectedAll = keptIds.length > 0 && keptIds.length === byId.size;
    canvasState.selected = keepSelection; canvasState.remoteUpdatedAt = Number(snapshot.updatedAt) || canvasState.remoteUpdatedAt; canvasRenderInspector(false);
  } finally { canvasState.suspendSync = false; }
  // 从服务器拉回来的这份，铺完就是服务器上那份，记一下指纹：接下来那趟存盘
  // 只存本机，不再往上顶（见 canvasPersist）
  if (fromRemote) canvasState.remoteContentKey = canvasHistoryKey(canvasSnapshot());
  canvasPersist();
}

function canvasStartRemoteSync() {
  if (canvasState.remoteTimer) clearInterval(canvasState.remoteTimer);
  canvasState.remoteTimer = window.setInterval(async () => {
    if (!canvasState.graph || canvasState.remoteWritePending) return;
    const previous = Number(canvasState.remoteUpdatedAt || 0);
    const state = await canvasLoadRemote();
    if (state && Number(state.updatedAt) > previous) canvasApplySnapshot(state, { fromRemote: true });
  }, 1800);
}

function canvasRunInternal(node) {
  const kind = node && String(node.get("canvasKind") || "note"), p = canvasPayload(node);
  const text = kind === "shot"
    ? `请处理这个短剧镜头：${p.id || p.title || "新镜头"}\n景别：${p.shot_size || "未指定"}\n时长：${p.duration || "4"} 秒\n镜头提示词：${p.prompt || ""}\n对白/旁白：${p.line || ""}\n读取连线时必须按用途区分人物身份、场景空间、构图、动作与连续性；需要时直接调用 generate_image / generate_video，并用 canvas_manage 更新当前镜头节点的 first_frame 或 video。`
    : kind === "script" ? `请使用 /short-drama 把下面剧本拆成角色、场景和可执行镜头，并用 canvas_manage 写入当前项目画布，生成可审核的创作计划：\n${p.text || ""}`
      : kind === "timeline" ? "请检查这部短剧的镜头顺序、配音和字幕有没有问题，指出哪一镜该调。拼成片不用你敲 ffmpeg：画布「最终剪辑」节点上的「合成成片」按钮会按分镜顺序逐镜合轨、拼接、垫配乐、烧字幕，跑的就是 short-drama 那套命令。"
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

function canvasUpstreamInputs(node) {
  if (!node || !canvasState.graph) return [];
  return canvasState.graph.getLinks().filter((link) => link.get("target")?.id === node.id).map((link) => {
    const source = canvasState.graph.getCell(link.get("source")?.id);
    if (!source) return null;
    const kind = canvasKind(source), payload = canvasPayload(source);
    const path = String(canvasMediaPath(payload) || canvasEmbeddedImage(payload, kind) || payload.first_frame || "").trim();
    return { node: source, nodeId: source.id, kind, label: canvasNodeLabel(source), relation: canvasLinkRelation(link, source, node), path };
  }).filter(Boolean);
}

function canvasUpstreamNodes(node) { return canvasUpstreamInputs(node).map((item) => item.node); }

function canvasGenerationContext(node) {
  return canvasUpstreamInputs(node).map((item) => {
    const p = canvasPayload(item.node);
    return `【${canvasRelationLabel(item.relation)}】${CANVAS_NODE_DEFS[item.kind]?.label || "节点"}：${item.label}\n${p.description || p.text || p.prompt || p.line || p.task || ""}`;
  }).join("\n");
}

// 参考图和首尾帧能收哪些后缀，是服务端 tools.js 的 IMAGE_EXT 说了算——收不下的整枪退回，不是少一张。
// 不能直接拿 canvasFileKind 当判据：它把 svg / ico 也算图（画布上显示确实该算），可那两样服务端不收。
// ⚠️ 改这行记得同步 tools.js 的 IMAGE_EXT，test/e2e.js 有闸门盯着两边一个字不差。
const CANVAS_REF_IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * 上游那个节点身上，能当参考图用的那一张。
 *
 * 一个节点上常常同时挂着片子和图：上一镜的 video 是成品、first_frame 是那张图。
 * canvasMediaPath 先看 path/url/video/audio，所以「上一镜」交出来的是 .mp4。
 */
function canvasUpstreamImage(item) {
  if (!item || !item.node) return "";
  const p = canvasPayload(item.node);
  return [item.path, canvasEmbeddedImage(p, item.kind), p.first_frame, p.last_frame]
    .map((value) => String(value || "").trim())
    .find((value) => value && !/^https?:/i.test(value) && CANVAS_REF_IMAGE_EXT.test(value.split(/[?#]/)[0])) || "";
}

/**
 * 连进来的上游里，能当参考图的都挑出来（最多 4 张，跟 generate_image 的上限对齐）。
 *
 * 以前这里不挑类型，手边第一个文件就递过去。后果不是「参考图差一点」，是整枪打不出去：
 * 把分镜按顺序连起来（这是画布上摆一部戏最自然的做法），上一镜一旦出了视频，
 * 它交出来的就是 .mp4；generate_image 收到非图片参考当场报错退回（tools.js 那条「不是图片」），
 * 于是后面每一镜的首帧都生不出来，一键补齐会一路红到底。
 */
function canvasUpstreamImages(node) {
  return canvasUpstreamInputs(node).map(canvasUpstreamImage).filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index).slice(0, 4);
}

/**
 * 这一句台词该用谁的嗓子。
 *
 * 分镜表里每个角色定一个音色、每句台词写明谁说的（references/分镜表.schema.json 就是这么写的，
 * skill 里那句「同一个角色全程一个音色，别让它中途换人」也是这个意思）。画布上一直漏了这件事：
 * text_to_speech 那一枪只递了 text，于是整部戏所有角色共用设置里那一个默认音色——
 * 十个镜头听下来是同一个人在自言自语。而且这种错没有任何一条会报红，要等到成片放出来才听得出。
 *
 * 认的顺序：节点自己写死的 voice → 镜头点名的说话人 → 连上来的角色。
 */
function canvasVoiceCandidates(node) {
  return canvasUpstreamInputs(node).filter((item) => item.kind === "character").map((item) => {
    const p = canvasPayload(item.node);
    // id 也要收：分镜表里 speaker 写的是角色的短 id（A / B），展开到画布上的角色节点带着它
    return { id: String(p.id || "").trim(), name: String(p.name || item.label || "").trim(), voice: String(p.voice || "").trim() };
  });
}

/** @returns {{voice?: string, error?: string}} 定不下来就交 error，由调用方停下来问人，不许自己挑 */
function canvasResolveVoice(node, p) {
  const own = String(p.voice || "").trim();
  if (own) return { voice: own };
  const cast = canvasVoiceCandidates(node), speaker = String(p.speaker || "").trim();
  if (speaker && cast.length) {
    const hit = cast.find((item) => item.name === speaker || (item.id && item.id === speaker));
    // 点了名却在连上来的角色里找不到这个人：多半是名字打错了，或者那个角色压根没连到这一镜上。
    // 这时候拿在场另一个人的音色顶上去，等于把这句台词换了个人说——宁可停在这儿。
    if (!hit) return { error: `这一镜写的说话人是「${speaker}」，可连到它上面的角色里没有这个人：${cast.map((item) => item.name || item.id || "未命名角色").join("、")}。检查一下名字，或者把那个角色连过来。` };
    return { voice: hit.voice };
  }
  // 一个角色都没连上来的时候，speaker 只是从分镜表带过来的一条备注，没有谁跟谁要分辨——
  // 照常发，用设置里配的默认音色。在这儿报错等于把「展开分镜表」生出来的画布整个堵死。
  // 空字符串也是一档：它代表「用设置里配的默认音色」，跟 Cherry 是两个不一样的结果。
  // 所以「一个角色定了音色、另一个还没定」照样算岔路，不是「只有一个候选」。
  const distinct = [...new Set(cast.map((item) => item.voice))];
  if (distinct.length > 1) {
    return { error: `这一镜连着 ${cast.length} 个角色，音色各不相同，不知道该用谁的嗓子念这句：${cast.map((item) => item.name || "未命名角色").join("、")}。在镜头的「说话的角色」里点个名。` };
  }
  return { voice: distinct[0] || "" };
}

function canvasGenerationInputs(node) {
  return canvasUpstreamInputs(node).filter((item) => item.path).map((item) => ({ nodeId: item.nodeId, label: item.label, relation: item.relation, path: item.path })).slice(0, 8);
}

function canvasGenerationSummary(payload) {
  const run = payload?.generation;
  if (!run || !run.output) return "";
  const model = run.model ? ` · ${run.model}` : "";
  const inputs = Array.isArray(run.inputs) ? run.inputs.length : 0;
  return `<div class="canvas-generation-lineage" title="${esc(run.output)}">${ic("git-branch")}<span>最近生成${model} · ${inputs} 个输入</span></div>`;
}

function canvasGenerationInspector(payload) {
  const run = payload?.generation;
  if (!run || !run.output) return "";
  const inputs = Array.isArray(run.inputs) ? run.inputs : [];
  const time = run.at ? new Date(run.at).toLocaleString() : "刚刚";
  return `<div class="canvas-inspector-section canvas-provenance"><span class="canvas-inspector-section-title">最近一次生成</span><div class="canvas-provenance-meta"><span>${esc(run.kind === "image" ? "图片" : run.kind === "video" ? "视频" : "音频")}</span><span>${esc(run.model || "默认模型")}</span><span>${esc(time)}</span>${run.reused ? "<span>缓存复用</span>" : ""}</div><div class="canvas-provenance-output" title="${esc(run.output)}">${ic("file-check")}<span>${esc(String(run.output).split(/[\\/]/).pop())}</span></div>${inputs.length ? `<div class="canvas-provenance-inputs">${inputs.map((item) => `<span title="${esc(item.path)}">${esc(canvasRelationLabel(item.relation))} · ${esc(item.label)}</span>`).join("")}</div>` : '<p class="canvas-inspector-hint">本次没有使用画布上游素材。</p>'}${run.replaced ? `<p class="canvas-inspector-hint">已保留上一版记录：${esc(String(run.replaced).split(/[\\/]/).pop())}</p>` : ""}</div>`;
}

function canvasRecordGeneration(node, kind, input, output, result, ms) {
  const previous = canvasPayload(node), oldOutput = kind === "image" ? previous.first_frame || previous.path || previous.url : kind === "video" ? previous.video || previous.path || previous.url : previous.audio || previous.path || previous.url;
  const run = {
    id: `run_${Date.now().toString(36)}`, kind, at: Date.now(), ...(Number(ms) > 0 ? { ms: Number(ms) } : {}), model: String(input.model || previous.model || ""), output,
    inputs: canvasGenerationInputs(node), reused: !!result?.cached, ...(oldOutput && oldOutput !== output ? { replaced: oldOutput } : {}),
  };
  const runs = [...(Array.isArray(previous.generation_runs) ? previous.generation_runs : []), run].slice(-12);
  return { ...previous, generation: run, generation_runs: runs };
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

/**
 * 画布这个执行模式下拉，选项从 /api/modes 取。
 *
 * 这儿原本是四个写死的 <option>——全站第三份手抄的模式表。模式表只该有一份（modes.js），
 * 剩下的都是它的读者：漏抄一个 goal，用户就会在某个入口里找不到他昨天还在用的模式。
 */
async function canvasRenderChatModeSelect() {
  const select = document.querySelector("[data-canvas-chat-mode]");
  if (!select) return;
  const data = await fetch("/api/modes").then((x) => x.json()).catch(() => null);
  const list = data && Array.isArray(data.modes) ? data.modes : [];
  if (!list.length) { select.innerHTML = '<option value="craft">Craft · 执行</option>'; return; }
  const keep = select.value || canvasState.chatMode || (data && data.default) || "craft";
  select.innerHTML = list.map((m) => `<option value="${esc(m.id)}" title="${esc(m.sub || "")}">${esc(m.label)}</option>`).join("");
  select.value = list.some((m) => m.id === keep) ? keep : list[0].id;
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
  overlay.innerHTML = `<div class="canvas-media-lightbox-card" role="dialog" aria-modal="true" aria-label="图片预览"><div class="canvas-media-lightbox-head"><b></b><button type="button" class="canvas-media-lightbox-copy icon-btn" title="复制图片（可直接粘到微信 / Word / PPT）" aria-label="复制图片">${ic("copy")}</button><button type="button" class="canvas-media-lightbox-close" title="关闭预览" aria-label="关闭预览">${ic("x")}</button></div><div class="canvas-media-lightbox-stage"><img alt="" style="cursor:copy" title="双击复制这张图"></div></div>`;
  overlay.querySelector(".canvas-media-lightbox-head b").textContent = title;
  const image = overlay.querySelector("img"); image.src = src; image.alt = title;
  // 放大看图多半就是为了拿走它。复制走 app-01 里那套（非 PNG 先转 PNG，不然剪贴板不收）
  const copyThis = () => copyImageFromUrl(src);
  overlay.querySelector(".canvas-media-lightbox-copy").addEventListener("click", copyThis);
  image.addEventListener("dblclick", copyThis);
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
  const directive = "你正在控制当前 OpenWorkBuddy 项目的 AI 短剧无限画布。只操作当前项目和当前画布，不连接其他本地项目。先用 canvas_manage 的 get 读取现有画布，再按用户要求 add/update/connect/delete 节点；connect 时必须为真实创作依赖填写 relation（character/background/composition/motion/style/prop/continuity/first_frame/last_frame/audio/reference），不能只画装饰箭头。需要生图、生视频或配音时直接调用对应工具，并把真实产物路径写回当前画布。" + referenceContext + "\n用户指令：" + userText;
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
    const latest = await canvasLoadRemote(); if (latest && latest.updatedAt > canvasState.remoteUpdatedAt) { canvasApplySnapshot(latest, { fromRemote: true }); await canvasLoadLibrary(); }
  } catch (error) { write("发送失败：" + String(error.message || error).slice(0, 180)); }
  finally { canvasState.chatBusy = false; canvasState.chatStopping = false; canvasSyncChatSendButton(); if (typeof renderHistory === "function") renderHistory(); }
}

/**
 * 在画布上给一镜多连一个角色、或者拆掉一条角色线，分镜表里那一镜的 cast 也得跟着改。
 *
 * cast 不是装饰：它决定这一镜 generate_image 拿谁的定妆照当参考图。画布上连了两个人、
 * 分镜表里还写着一个人，从短剧页或命令行重跑这一镜，只会带一张参考图——第二个人当场变成
 * 另一张脸。反过来（画布上拆了、表里还留着）更糟：多带一张不相干的参考图，两个人会糊到一块儿。
 *
 * 角色在分镜表里的钥匙优先用展开时盖的 board_character：画布上把角色改名了，
 * 分镜表里那一条还是按原来的 id 认人。
 */
function canvasBoardCastOf(node) {
  return canvasUpstreamNodes(node)
    .filter((n) => canvasKind(n) === "character")
    .map((n) => { const cp = canvasPayload(n); return String(cp.board_character || cp.id || cp.name || "").trim(); })
    .filter((v, i, all) => v && all.indexOf(v) === i);
}
async function canvasBoardCastSync(node) {
  if (!node || canvasKind(node) !== "shot") return "";
  const p = canvasPayload(node);
  const board = String(p.board || "").trim(), shot = String(p.board_shot || "").trim();
  if (!board || !shot) return "";
  // 编号在画布上被改过：这个节点已经跟分镜表脱钩了。改内容那条路上已经说过一次，
  // 这儿不再重复弹——但更不能猜着往老编号那一镜写
  if (String(p.id || "").trim() && String(p.id || "").trim() !== shot) return "";
  try {
    const body = { name: board, shot, ...(p.board_scene ? { scene: String(p.board_scene) } : {}), fields: { cast: canvasBoardCastOf(node) } };
    const r = await fetch("/api/drama/storyboard/output", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return `${shot} 的出场角色没写回分镜表（${String(out.error || r.status).slice(0, 120)}）——重跑这一镜时参考图还是按老的来，人会变脸`;
    return "";
  } catch (e) {
    return `${shot} 的出场角色没写回分镜表（${String(e.message || e).slice(0, 120)}）——重跑这一镜时参考图还是按老的来，人会变脸`;
  }
}

/**
 * 画布上改一镜的内容（提示词 / 台词 / 景别 / 时长 / 音色），也得回到分镜表里。
 *
 * 产物路径已经会回写了，内容还没有。少这一半的代价比少那一半更贵：
 * 在画布上把第 7 镜的提示词改好、重生成、满意了——分镜表里还是老那句。下次从短剧页或命令行
 * 重跑，跑的是**老提示词**，而且参数跟上次不一样、缓存命不中，于是花钱买回一张老图，
 * 把刚才改好的那张盖掉。人看到的是「重跑成功」。
 *
 * 只认「展开场次与镜头」盖过戳的节点；手搓的节点没有真源可回。
 * 绝不抛：它挂在输入框的 change 上，抛出去就是一个没人接的 Promise。
 */
const CANVAS_BOARD_SYNC_KEYS = {
  // 画布上的字段名 → 分镜表里的字段名。两边不同名的只有 prompt 和 description
  shot: { shot_size: "shot_size", motion_prompt: "motion_prompt", line: "line", speaker: "speaker", duration: "duration", prompt: "frame_prompt" },
  character: { name: "name", description: "look", voice: "voice" },
};
/**
 * 画布上那段「首帧提示词」是展开时拿 frame_prompt 接上全片画风拼出来的。
 * 原样写回去，下次展开会在它后面再接一遍画风，接几次堆几次。所以先把尾巴上那段画风剥掉。
 * 剥不掉（人把画风那段自己改了或删了）不偷偷猜：整段写回去，同时说清楚下次展开会再接一遍。
 */
function canvasBoardFramePrompt(payload) {
  const prompt = String((payload && payload.prompt) || "").trim(), style = String((payload && payload.board_style) || "").trim();
  if (!style) return { text: prompt, folded: false };
  if (prompt === style) return { text: "", folded: false };
  const tail = "\n" + style;
  if (prompt.endsWith(tail)) return { text: prompt.slice(0, prompt.length - tail.length).trim(), folded: false };
  return { text: prompt, folded: true };
}
async function canvasBoardContentSync(node, key) {
  const p = canvasPayload(node);
  const board = String(p.board || "").trim();
  const shot = String(p.board_shot || "").trim(), character = String(p.board_character || "").trim();
  if (!board || (!shot && !character)) return "";
  const map = CANVAS_BOARD_SYNC_KEYS[shot ? "shot" : "character"];
  const field = map[key];
  if (!field) return "";
  // 编号被人在画布上改过：这个节点已经指不着分镜表里那一镜了。不猜着往老编号那一镜写——
  // 写错地方比不写更难查，得等放片子才发现
  const own = String(p.id || "").trim(), key0 = shot || character;
  if (shot && own && own !== shot) return `这个节点的镜头号改成了 ${own}，跟分镜表里的 ${shot} 对不上，内容就不自动回表了——编号要改请去分镜表里改`;

  let value = p[key], folded = false;
  if (field === "frame_prompt") { const r = canvasBoardFramePrompt(p); value = r.text; folded = r.folded; }
  else if (field === "duration") {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "时长要是一个大于 0 的秒数，这一笔没回表";
    value = n;
  } else value = String(value == null ? "" : value);

  try {
    const body = { name: board, fields: { [field]: value }, ...(shot ? { shot, ...(p.board_scene ? { scene: String(p.board_scene) } : {}) } : { character }) };
    const r = await fetch("/api/drama/storyboard/output", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return `${key0} 这一笔没写回分镜表（${String(out.error || r.status).slice(0, 120)}）——从短剧页或命令行重跑，用的还是改之前那句`;
    if (folded) return `${key0} 的提示词已整段写回分镜表，但里面那段全片画风是你改过的：下次「展开场次与镜头」会在它后面再接一遍分镜表里的画风。要换全片画风，改分镜表的 style`;
    return "";
  } catch (e) {
    return `${key0} 这一笔没写回分镜表（${String(e.message || e).slice(0, 120)}）——从短剧页或命令行重跑，用的还是改之前那句`;
  }
}

/**
 * 画布上生成出来的东西，回到分镜表里。
 *
 * 分镜表是唯一真源，可画布一直只读不写：在画布上把十二镜的首帧和视频全生完，盘上那份
 * 分镜表里还是一个路径都没有。于是短剧页每张卡都还写着「暂无首帧」，人照着点「重跑首帧」——
 * 十二镜再买一遍（那条路关着缓存，一分钱省不下）；命令行那条「改一镜只重算一镜」读的也是
 * 这份 JSON，它看到的是一部什么都没开工的戏。
 *
 * 只有「展开场次与镜头」摆出来的节点身上盖着 board / board_shot（或 board_character）这几个戳，
 * 手搓的节点没有真源可回，直接返回空串不打扰。
 *
 * 绝不抛：这个函数是在钱已经花掉、文件已经落盘之后才跑的。让它把异常掀到外面那层 catch，
 * 界面上就会显示「生成失败」——那是假红，人会以为白花了钱去再点一次，于是真的又花一次。
 * 回不去就把回不去这件事单独说清楚。
 */
async function canvasBoardWriteback(payload, fields) {
  const p = payload || {};
  const board = String(p.board || "").trim();
  const shot = String(p.board_shot || "").trim(), character = String(p.board_character || "").trim();
  if (!board || (!shot && !character)) return "";
  try {
    const body = { name: board, fields, ...(shot ? { shot, ...(p.board_scene ? { scene: String(p.board_scene) } : {}) } : { character }) };
    const r = await fetch("/api/drama/storyboard/output", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) return `没能回写进分镜表（${String(out.error || r.status).slice(0, 120)}）——短剧页那头还当这一步没做，再点重跑会再花一次钱`;
    return "";
  } catch (e) {
    return `没能回写进分镜表（${String(e.message || e).slice(0, 120)}）——短剧页那头还当这一步没做，再点重跑会再花一次钱`;
  }
}

async function canvasGenerate(node, kind) {
  if (!node || !["image", "video", "audio"].includes(kind)) return;
  const key = `${node.id}:${kind}`;
  if (canvasState.busy.has(key)) return;
  const p = canvasPayload(node), upstream = canvasUpstreamImages(node), upstreamInputs = canvasUpstreamInputs(node);
  const nodeKind = canvasKind(node);
  // 角色 / 场景节点生的是定妆照和场景图：它们是后面每一镜的参考图，不是镜头本身，
  // 所以提示词、文件名、写回哪个字段，三样都跟镜头那条不一样。
  const castKind = kind === "image" && (nodeKind === "character" || nodeKind === "location") ? nodeKind : "";
  if (castKind && canvasIsPlaceholderPrompt(p.description)) {
    canvasToast(castKind === "character"
      ? "先把人物设定写出来：只有一个名字，生出来的脸每次都不是同一个人，当参考图没用。"
      : "先把场景设定写出来：只有一个地名，生出来的景每次都不一样。", "triangle-alert", "err");
    return;
  }
  // 首帧只认三样：自己身上那张、连线上明写着「首帧」的那个节点、上游挂着的图片节点。
  // 以前兜底是 upstream[0]——上游第一个是谁全看连线顺序，多半是角色的定妆照。
  // 拿定妆照当首帧生出来的片子跟这一镜没关系，而这一枪是花钱的。宁可在这儿停下说「还没有首帧」。
  const frameFrom = upstreamInputs.find((item) => item.relation === "first_frame")
    || upstreamInputs.find((item) => item.kind === "image");
  let firstFrame = p.first_frame || (kind === "video" && frameFrom ? canvasUpstreamImage(frameFrom) : "");
  if (kind === "video" && !firstFrame && canvasKind(node) === "shot") {
    canvasToast("这个视频节点还没有首帧，请先生成首帧或连接一个参考图节点。", "triangle-alert", "err"); return;
  }
  // 起手模板里那句占位文字原样没改就开枪，买回来的就是一张「这张图要保持的主体、风格与构图…」。
  // 定妆照那条已经这么拦了（castKind 那一段），图 / 视频 / 配音三种节点身上的默认文案一样得拦：
  // 这几个节点的面板上就摆着「生成…」按钮，一按就是真花钱。
  const ownPrompt = kind === "audio"
    ? String(p.text || p.line || p.description || "").trim()
    : String(p.prompt || p.description || p.text || "").trim();
  if (!castKind && ownPrompt && canvasIsPlaceholderPrompt(ownPrompt)) {
    canvasToast(kind === "audio"
      ? "这还是模板里那句占位文字，念出来也只是一句占位文字——先把台词或旁白写上。"
      : "这还是模板里那句占位文字，生出来的东西跟你想要的没关系——先把提示词写上。", "triangle-alert", "err");
    return;
  }
  // 配音多一道：用谁的嗓子。定不下来就停，不替用户挑（挑错了声音是好声音，只是不是这个人的，
  // 而这种错要等到把成片放出来才听得见）
  let voice = "";
  if (kind === "audio") {
    const picked = canvasResolveVoice(node, p);
    if (picked.error) { canvasToast(picked.error, "triangle-alert", "err"); return; }
    voice = picked.voice;
  }
  const context = canvasGenerationContext(node);
  const castPrompt = castKind === "character"
    ? [`角色定妆照：${p.name || p.title || "角色"}`, p.role ? `身份：${p.role}` : "", p.description || "",
       "正面全身、站姿自然、纯色背景、光线均匀、五官清晰——这张图后面每一镜都要当角色参考反复用"].filter(Boolean).join("\n")
    : castKind === "location"
      ? [`场景图：${p.name || p.title || "场景"}`, p.description || "",
         "空镜、画面里不要出现人物，时间和光线要看得出来——这张图后面每一镜都要当场景参考反复用"].filter(Boolean).join("\n")
      : "";
  const prompt = castPrompt ? [castPrompt, context].filter(Boolean).join("\n") : kind === "image"
    ? [p.prompt || p.description || p.text || "", context].filter(Boolean).join("\n")
    : kind === "video"
      // 首帧已经把画面定死了，这一枪只该说「怎么动」。把首帧提示词再递一遍，模型会照着它重画一遍画面，
      // 生出来的片子跟你刚确认过的那张首帧对不上（skill 第 4 节）。所以有运镜提示词就只用它。
      ? [p.motion_prompt || p.prompt || p.description || "保持角色和场景一致，动作自然，镜头运动克制。", p.line ? `对白/旁白：${p.line}` : "", context].filter(Boolean).join("\n")
      : String(p.text || p.line || p.description || "").trim();
  if (!prompt) { canvasToast(kind === "audio" ? "请先填写对白或音乐说明。" : "请先填写生成提示词。", "triangle-alert", "err"); return; }
  const input = kind === "image"
    // 参考图这一栏自己也把一道关：节点上随手填的 reference 也可能不是图，四个位子本来就不够几个角色分
    ? { prompt, reference_images: [...new Set([p.reference, p.first_frame, ...upstream].map((v) => String(v || "").trim()).filter((v) => v && CANVAS_REF_IMAGE_EXT.test(v.split(/[?#]/)[0])))].slice(0, 4), ...(p.model ? { model: p.model } : {}), filename: canvasOutputFilename(p, "image", nodeKind), no_cache: true }
    : kind === "video"
      ? { prompt, first_frame: firstFrame, ...(p.last_frame ? { last_frame: p.last_frame } : {}), ...(p.model ? { model: p.model } : {}), filename: canvasOutputFilename(p, "video", nodeKind), no_cache: true }
      : { text: prompt, ...(voice ? { voice } : {}), filename: canvasOutputFilename(p, "audio", nodeKind), no_cache: true };
  const castLabel = castKind === "character" ? "定妆照" : castKind === "location" ? "场景图" : CANVAS_NODE_DEFS[kind].label;
  canvasState.busy.add(key); canvasRefreshNode(node); canvasRenderInspector(false);
  const startedAt = Date.now();   // 真跑过多久要记下来，不然「还要多久」永远只能靠猜
  try {
    const response = await fetch("/api/tool/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: kind === "audio" ? "text_to_speech" : `generate_${kind}`, input }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.isError || result.ok === false) throw new Error(result.error || result.content || "生成失败");
    const file = String(result.file || "").trim();
    if (!file) throw new Error("生成接口成功，但没有返回产物路径");
    const next = canvasRecordGeneration(node, kind, input, file, result, Date.now() - startedAt);
    if (nodeKind === "shot") {
      if (kind === "image") next.first_frame = file;
      if (kind === "video") next.video = file;
      if (kind === "audio") next.audio = file;
      node.set("canvasPayload", next); canvasUpsertResult(node, kind, file);
    } else {
      // 定妆照写回 reference、场景图写回 image：进度条和素材台账认的就是这两个字段。
      // 写去别处等于「图确实生出来了，界面上还是说你没做」——最气人的那种假红。
      const slot = castKind === "character" ? { reference: file } : castKind === "location" ? { image: file } : { path: file, url: file };
      node.set("canvasPayload", { ...next, ...slot });
    }
    canvasState.selected = node.id; canvasRefreshNode(node); canvasPersist(); canvasRenderInspector(false);
    // 画布上摆着路径不等于分镜表里有这一笔。这两处分家的代价是真金白银（短剧页会让人再买一遍），
    // 所以回写失败要跟「已生成」摆在同一条提示里说，不能只在控制台留个影
    const boardKey = nodeKind === "shot" ? (kind === "image" ? "first_frame" : kind === "video" ? "video" : "audio")
      : castKind === "character" ? "ref" : "";
    const back = boardKey ? await canvasBoardWriteback(canvasPayload(node), { [boardKey]: file }) : "";
    const shortName = String(file).split(/[\\/]/).pop();
    if (back) canvasToast(`${castLabel}已生成：${shortName}，但${back}`, "triangle-alert", "err");
    else canvasToast(`${castLabel}已生成：${shortName}`, "circle-check");
    if (typeof previewFile === "function") previewFile(canvasResolvedFileName(file));
  } catch (error) {
    canvasToast(`${castLabel}生成失败：${String(error.message || error).slice(0, 180)}`, "circle-x", "err");
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
    if (evt.shiftKey || evt.metaKey || evt.ctrlKey) {
      const ids = new Set(canvasState.selectedAll ? (canvasState.graph?.getElements?.() || []).map((item) => item.id) : canvasState.selectedIds);
      if (ids.has(node.id) && ids.size > 1) ids.delete(node.id); else ids.add(node.id);
      canvasSetSelection(ids, node.id);
      return;
    }
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
  root.querySelector("[data-canvas-compose]")?.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasComposeOpen(); });
  root.querySelectorAll("[data-canvas-generate]").forEach((button) => button.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasGenerate(node, button.dataset.canvasGenerate); }));
  root.querySelectorAll("[data-canvas-inline-key]").forEach((field) => field.addEventListener("input", () => { const next = canvasPayload(node); next[field.dataset.canvasInlineKey] = field.value; node.set("canvasPayload", next); canvasPersist(); }));
  root.querySelector("[data-canvas-expand]")?.addEventListener("click", async (evt) => {
    evt.preventDefault(); evt.stopPropagation(); const select = root.querySelector("[data-canvas-board]"), name = select && select.value; if (!name) return;
    const button = evt.currentTarget; button.disabled = true; button.textContent = "加载中…";
    try {
      const r = await fetch("/api/drama/storyboard?name=" + encodeURIComponent(name)).then((x) => x.json());
      if (!r || !r.data) throw new Error(r && r.error || "分镜表读取失败");
      const stat = canvasApplyBoardPlan(node, canvasBoardPlan(r.data, name));
      button.textContent = `已展开 ${stat.scenes} 场`;
      canvasPersist();
      if (stat.missing.length) canvasToast(`展开了 ${stat.scenes} 场 ${stat.shots} 镜 ${stat.characters} 个角色。有 ${stat.missing.length} 个角色 id 在分镜表的 characters 里查无此人：${stat.missing.join("、")}——点到它们的那几镜没连上角色，生首帧时没有定妆照当参考图、配音也只能用默认音色。`, "triangle-alert", "err");
      else canvasToast(`展开了 ${stat.scenes} 场 ${stat.shots} 镜 ${stat.characters} 个角色，定妆照和音色顺着连线走。`, "circle-check");
    } catch (e) { button.disabled = false; button.textContent = "展开场次与镜头"; canvasToast(`分镜节点展开失败：${String(e.message || e).slice(0, 140)}`, "circle-x", "err"); }
  });
  const edit = root.querySelector(".canvas-note-edit"); edit?.addEventListener("pointerdown", (evt) => evt.stopPropagation());
  edit?.addEventListener("input", () => { node.set("canvasPayload", { ...canvasPayload(node), text: edit.textContent || "" }); canvasRenderInspector(false); canvasPersist(); });
  root.querySelector("[data-canvas-board]")?.addEventListener("change", (evt) => { node.set("canvasPayload", { ...canvasPayload(node), board: evt.target.value }); canvasRenderInspector(false); canvasPersist(); });
  root.addEventListener("contextmenu", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasOpenContextMenu(evt.clientX, evt.clientY, node); });
}

/**
 * 分镜表 → 画布上摆什么（纯函数，不碰图）。
 *
 * 「展开场次与镜头」以前只摆场次和镜头，characters[] 整个不管、shot 里的字段原样铺开。
 * 后果不是「少了几个节点」，是展开出来的画布根本用不了：
 *   · 角色节点是定妆照、参考图、音色三条链子唯一的挂点。没有它，每一镜生首帧都没有参考图
 *     （跨镜头同一个人会一镜一个样），每一句台词都用设置里那个默认音色（全剧一个嗓子）。
 *   · 分镜表里写的是 frame_prompt / motion_prompt，画布上的镜头读的是 prompt。原样铺开的话，
 *     每一镜的 prompt 都还是起手模板那句「镜头内容与运动…」——「制片进度」把整部戏判成
 *     「没写提示词」，一键补齐一个都不做。展开这一步全程没有一条红，摆出来的却是一张点不动的画布。
 * 画风（style）要跟着每一镜走：skill 第 1 节写死的规矩，不带上镜与镜之间画风会飘。
 */
function canvasBoardPlan(data, board) {
  const d = data || {}, style = String(d.style || "").trim(), from = String(board || "").trim();
  const characters = (Array.isArray(d.characters) ? d.characters : []).map((c, i) => ({
    // id 和 name 都当钥匙：镜头的 cast 写的是 id（A / B），人手动改的时候写的多半是名字
    keys: [String(c.id || "").trim(), String(c.name || "").trim()].filter(Boolean),
    payload: {
      id: String(c.id || "").trim(), name: String(c.name || c.id || `角色 ${i + 1}`).trim(),
      description: String(c.look || "").trim(), reference: String(c.ref || "").trim(), voice: String(c.voice || "").trim(),
      // 从哪份分镜表的哪个角色来的。定妆照生出来之后要顺着这个戳回写 characters[].ref，
      // 不然短剧页那头重跑首帧永远没有参考图
      ...(from ? { board: from, board_character: String(c.id || c.name || "").trim() } : {}),
    },
  }));
  const scenes = (Array.isArray(d.scenes) ? d.scenes : []).map((scene) => ({
    payload: { ...scene },
    shots: (Array.isArray(scene.shots) ? scene.shots : []).map((shot, j) => ({
      cast: (Array.isArray(shot.cast) ? shot.cast : []).map((v) => String(v || "").trim()).filter(Boolean),
      payload: {
        ...shot, title: shot.title || shot.id || `镜头 ${j + 1}`,
        prompt: [String(shot.frame_prompt || "").trim(), style].filter(Boolean).join("\n"),
        // 接在提示词尾巴上的那段全片画风原样留一份：在画布上改完提示词往回写的时候，
        // 得先把这段剥掉，不然下次展开又接一遍，接几次堆几次
        ...(from && style ? { board_style: style } : {}),
        motion_prompt: String(shot.motion_prompt || "").trim(),
        // 场次号也盖上：镜头号重了的时候，服务端靠它分得清是哪一场的那一镜
        ...(from ? { board: from, board_scene: String(scene.id || "").trim(), board_shot: String(shot.id || "").trim() } : {}),
      },
    })),
  }));
  return { characters, scenes };
}

/**
 * 把 canvasBoardPlan 摆到画布上：角色一排在最上面，场次一列，镜头挂在场次右边，
 * 镜头的 cast 里点到的角色各连一条线过来——定妆照、参考图、音色都是顺着这条线找过去的。
 *
 * cast 里写了个 characters[] 里没有的 id 时不吞：那一镜会安静地少参考图少音色，
 * 而少了参考图这件事要等十二镜都生完、发现人一镜一个样才看得出来。
 */
function canvasApplyBoardPlan(node, plan) {
  const cast = new Map(), missing = new Set();
  // 角色排在分镜表节点右手边一行：场次是往下摆的（y 430 起），角色再往下摆就跟场次挤在一起了
  const base = (typeof node.position === "function" && node.position()) || { x: 100, y: 90 };
  let shots = 0;
  canvasState.bulk = true;
  try {
    plan.characters.forEach((item, i) => {
      const n = canvasAddNode("character", item.payload, { x: base.x + 420 + i * 300, y: base.y }, { skipSelect: true, persist: false });
      if (!n) return;
      canvasConnect(node, n);
      item.keys.forEach((k) => cast.set(k, n));
    });
    plan.scenes.forEach((scene, i) => {
      const sceneNode = canvasAddNode("scene", scene.payload, { x: 100 + (i % 3) * 520, y: 430 + Math.floor(i / 3) * 390 }, { skipSelect: true, persist: false });
      if (!sceneNode) return;
      canvasConnect(node, sceneNode);
      scene.shots.forEach((shot, j) => {
        const shotNode = canvasAddNode("shot", shot.payload, { x: 100 + (i % 3) * 520 + 410, y: 430 + Math.floor(i / 3) * 390 + j * 295 }, { skipSelect: true, persist: false });
        if (!shotNode) return;
        shots++; canvasConnect(sceneNode, shotNode);
        shot.cast.forEach((id) => { const c = cast.get(id); if (c) canvasConnect(c, shotNode, "character"); else missing.add(id); });
      });
    });
  } finally { canvasState.bulk = false; }
  return { characters: plan.characters.length, scenes: plan.scenes.length, shots, missing: [...missing] };
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
  // 认不出的类型：面板上只说清楚情况，一个输入框都不给。给了就等于邀请用户改一份
  // 这个版本读不懂的数据，而且标题不能显示成 def.label（那是 note 的「画布笔记」，是假话）
  const unknownKind = !CANVAS_NODE_DEFS[kind];
  if (unknownKind) fields = `<p class="canvas-inspector-hint">这个版本不认识「${esc(kind)}」这种节点，所以没法编辑它的字段。内容已原样保留在项目里，一个字节都没动；换回建它的那个版本就能正常打开。</p>`;
  if (kind === "note") fields = canvasField("内容", "text", p.text || "", "textarea", "记录想法、任务或素材线索");
  if (kind === "script") fields = canvasField("标题", "title", p.title || "新剧本") + canvasField("剧本内容", "text", p.text || "", "textarea", "一句话概念、角色、冲突、对白…");
  if (kind === "agent") fields = canvasField("任务名称", "title", p.title || "Agent任务") + canvasField("Agent角色", "role", p.role || "导演 Agent") + canvasField("任务说明", "task", p.task || "", "textarea", "例如：根据剧本生成 6 个镜头并等待我审核") + canvasField("完成状态", "status", p.status || "待执行");
  if (kind === "character") fields = canvasField("角色名", "name", p.name || "") + canvasField("身份", "role", p.role || "") + canvasField("人物设定", "description", p.description || "", "textarea") + canvasField("音色", "voice", p.voice || "", "text", "配音用的音色名，全程不换，例如 alloy / nova / Cherry") + canvasFilePicker("参考图", "image/*", p.reference || "", "character-reference");
  if (kind === "location") fields = canvasField("场景名", "name", p.name || "") + canvasField("场景设定", "description", p.description || "", "textarea");
  if (kind === "storyboard") fields = `<label class="canvas-inspector-field"><span>分镜表</span><select data-inspect-board>${canvasState.boards.map((b) => `<option value="${esc(b.name)}" ${p.board === b.name ? "selected" : ""}>${esc(b.title || b.name)}</option>`).join("") || '<option value="">还没有分镜表</option>'}</select></label>`;
  if (kind === "scene") fields = canvasField("场次 ID", "id", p.id || "S1") + canvasField("地点", "place", p.place || "") + canvasField("时间/天气", "time", p.time || "", "text", "例如：2000年3月20日，上午，阴天");
  if (kind === "shot") fields = canvasField("镜头 ID", "id", p.id || "S1-01") + canvasField("标题", "title", p.title || "新镜头") + canvasField("景别", "shot_size", p.shot_size || "中景") + canvasField("时长（秒）", "duration", p.duration || "4", "number") + canvasField("首帧提示词", "prompt", p.prompt || "", "textarea", "这一镜画面长什么样：景别 + 场景 + 姿态 + 光线 + 画风") + canvasField("运镜提示词", "motion_prompt", p.motion_prompt || "", "textarea", "只写怎么动，例如「她缓缓抬头，镜头轻微推进」。留空就拿首帧提示词顶上") + canvasField("对白/旁白", "line", p.line || "", "textarea") + canvasField("说话的角色", "speaker", p.speaker || "", "text", "连上来的角色里，这句话是谁说的——决定用谁的音色") + canvasFilePicker("拖入参考图或视频", "image/*,video/*", p.first_frame || p.reference_video || "", "shot-reference");
  if (kind === "image") fields = canvasField("名称", "title", p.title || def.label) + canvasField("素材用途", "role", p.role || "参考素材") + canvasTagField(p.tags) + canvasMediaModelField("生图模型", "image", p.model || "") + canvasAssetField("素材路径/URL（工作区）", p.url || p.path || "", kind) + canvasFilePicker("上传素材", "image/*", p.url || p.path || "", "image-media") + canvasField("生成/使用说明", "prompt", p.prompt || "", "textarea");
  if (kind === "video") fields = canvasField("名称", "title", p.title || "Video") + canvasMediaModelField("生视频模型", "video", p.model || "") + canvasField("画面比例", "aspect_ratio", p.aspect_ratio || "16:9") + canvasField("分辨率", "resolution", p.resolution || "1080p") + canvasField("时长", "duration", p.duration || "5s") + canvasAssetField("首帧（可选）", p.first_frame || "", "image", "first_frame") + canvasAssetField("尾帧（可选）", p.last_frame || "", "image", "last_frame") + canvasAssetField("参考视频（可选）", p.reference_video || "", "video", "reference_video") + canvasAssetField("已有视频（可选）", p.url || p.path || "", kind) + canvasFilePicker("上传参考视频", "video/*", p.url || p.path || "", "video-media") + canvasField("生成提示词", "prompt", p.prompt || "", "textarea");
  if (kind === "audio") fields = canvasField("名称", "title", p.title || "声音") + canvasField("素材用途", "role", p.role || "对白/音乐") + canvasTagField(p.tags) + canvasAssetField("音频路径/URL（工作区）", p.url || p.path || "", "audio") + canvasFilePicker("上传音频", "audio/*", p.url || p.path || "", "audio-media") + canvasField("音色", "voice", p.voice || "", "text", "留空就用设置里配的默认音色") + canvasField("对白/音乐说明", "text", p.text || "", "textarea");
  if (kind === "timeline") fields = canvasField("名称", "title", p.title || "最终剪辑") + canvasField("剪辑目标", "description", p.description || "", "textarea");
  const allNodes = canvasState.graph.getElements().filter((item) => item.id !== node.id);
  const connected = canvasState.graph.getLinks().filter((link) => link.get("source")?.id === node.id).map((link) => ({ link, target: canvasState.graph.getCell(link.get("target")?.id) })).filter((item) => item.target);
  const defaultTarget = allNodes[0], defaultRelation = defaultTarget ? canvasDefaultRelation(node, defaultTarget) : "input";
  const generateActions = kind === "shot" ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-generate="image">${ic("image")}生成首帧</button><button class="ui-btn ui-btn--sm ui-btn--outline" data-inspect-generate="video" ${p.first_frame ? "" : "disabled"}>${ic("video")}生成视频</button>` : ["image", "video", "audio"].includes(kind) ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-generate="${kind}">${ic(kind === "audio" ? "volume-2" : kind)}${kind === "audio" ? "生成配音" : `生成${def.label}`}</button>` : "";
  box.innerHTML = `<div class="canvas-inspector-head"><div><small>节点属性</small><h3>${esc(unknownKind ? kind : def.label)}</h3></div><button class="canvas-node-remove" data-inspect-close title="关闭设置">${ic("x")}</button></div><div class="canvas-inspector-fields">${fields}</div>${canvasGenerationInspector(p)}<div class="canvas-inspector-section"><span class="canvas-inspector-section-title">工作流连接</span><div class="canvas-connect-row"><select data-connect-target><option value="">连接到下游节点…</option>${allNodes.map((item) => `<option value="${item.id}">${esc(canvasNodeLabel(item))}</option>`).join("")}</select><select data-connect-relation title="这个节点为下游提供什么">${canvasRelationOptions(defaultRelation, node, defaultTarget)}</select><button class="ui-btn ui-btn--sm ui-btn--outline" data-connect>${ic("link")}连接</button></div>${connected.length ? `<div class="canvas-connected-list">${connected.map(({ link, target }) => `<span title="${esc(canvasRelationLabel(canvasLinkRelation(link, node, target)))}">${esc(canvasRelationLabel(canvasLinkRelation(link, node, target)))} · ${esc(canvasNodeLabel(target) || "节点")}</span>`).join("")}</div>` : '<p class="canvas-inspector-hint">选择用途再连线。Agent 会把它当作真实生成输入，而不是一条装饰箭头。</p>'}</div><div class="canvas-inspector-actions">${generateActions}${["agent", "shot", "script", "scene", "storyboard", "timeline"].includes(kind) ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-agent>${ic("sparkles")}交给本项目 Agent</button>` : ""}<button class="ui-btn ui-btn--sm ui-btn--ghost canvas-inspector-delete" data-inspect-delete>删除节点</button></div>`;
  box.querySelectorAll("[data-inspect-key]").forEach((field) => {
    const update = () => canvasUpdateSelected(field.dataset.inspectKey, field.value);
    field.addEventListener("input", update); field.addEventListener("change", update);
    // 这一笔改完（离开输入框 / 回车）才回分镜表。绑在 input 上等于每敲一个字写一次盘；
    // 不回写的代价也不是「两个页面显示得不一样」：下次重跑会拿老提示词买回一张老图，
    // 把刚在画布上改好的那张盖掉，而界面上写的是「重跑成功」
    field.addEventListener("change", async () => {
      const node = canvasSelectedNode(); if (!node) return;
      const back = await canvasBoardContentSync(node, field.dataset.inspectKey);
      if (back) canvasToast(back, "triangle-alert", "err");
    });
  });
  box.querySelector("[data-inspect-tags]")?.addEventListener("change", (evt) => canvasUpdateSelected("tags", evt.target.value));
  box.querySelector("[data-inspect-board]")?.addEventListener("change", (evt) => canvasUpdateSelected("board", evt.target.value, true));
  box.querySelector("[data-connect-target]")?.addEventListener("change", (event) => {
    const target = canvasState.graph.getCell(event.target.value); const select = box.querySelector("[data-connect-relation]");
    if (target && select) select.innerHTML = canvasRelationOptions(canvasDefaultRelation(node, target), node, target);
  });
  box.querySelector("[data-connect]")?.addEventListener("click", () => { const target = canvasState.graph.getCell(box.querySelector("[data-connect-target]")?.value); canvasConnect(node, target, box.querySelector("[data-connect-relation]")?.value); canvasRenderInspector(false); });
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

/**
 * 素材面板。
 *
 * 用户要的是「做好素材管理」，而做短剧的素材不是一堆文件，是一张关系表：
 * 这张图是谁的定妆照、那段视频是第几镜、哪张图根本没人用、哪一镜引用的文件已经不在了。
 * 所以这里显示的重点不是文件名，是**用途**和**谁在用**。
 *
 * 台账（/api/canvas/assets）读不到时退回只列文件——台账是增量信息，
 * 它算不出来不该把整个素材面板一起拖下水。
 */
function canvasAssetRows() {
  const ledger = canvasState.assets;
  if (ledger && Array.isArray(ledger.assets)) return ledger.assets;
  // 兜底：没有台账就拿文件列表凑一份，用途和占用都标「不知道」，绝不冒充已知
  return (canvasState.files || []).filter((f) => ["image", "video", "audio"].includes(canvasFileKind(f.name)))
    .map((f) => ({ name: f.name, base: String(f.name).split("/").pop(), kind: canvasFileKind(f.name), role: "", usedBy: null, orphan: false }));
}

function canvasAssetUseText(asset) {
  if (!Array.isArray(asset.usedBy)) return "";                       // 台账没读到，不知道就不说
  if (!asset.usedBy.length) return "没人用";
  const first = asset.usedBy[0];
  const more = asset.usedBy.length > 1 ? ` 等 ${asset.usedBy.length} 处` : "";
  return `${first.title || first.id || first.from} 在用${more}`;
}

function canvasRenderLibrary() {
  const box = document.getElementById("canvas-library-items"); if (!box) return;
  const query = String(document.getElementById("canvas-library-search")?.value || "").trim().toLowerCase();
  const filter = String(document.getElementById("canvas-library-kind")?.value || "all");
  const role = String(document.getElementById("canvas-library-role")?.value || "all");
  const onlyOrphan = !!document.getElementById("canvas-library-orphan")?.checked;
  const all = canvasAssetRows();
  const rows = all.filter((asset) => (filter === "all" || asset.kind === filter)
    && (role === "all" || asset.role === role)
    && (!onlyOrphan || asset.orphan)
    && (!query || String(asset.name).toLowerCase().includes(query)));
  const shown = rows.slice(0, 40);

  const ledger = canvasState.assets;
  // 引用了但盘上没有的排在最前。这类最要紧：那一镜现在就是生不出来，
  // 而它在文件列表里永远不出现——不主动摆出来，用户只会看见「怎么老是失败」
  const missing = (ledger && Array.isArray(ledger.missing) ? ledger.missing : []).slice(0, 8);
  const missingHtml = missing.length ? `<div class="canvas-library-missing"><b>${ic("triangle-alert")}${missing.length} 个引用的文件不在了</b>${missing.map((m) => `<div><span>${esc(m.base)}</span><small>${esc((m.usedBy || []).map((u) => u.title || u.id).join("、") || "有人在引用")} 还指着它</small></div>`).join("")}<small class="canvas-library-missing-tip">重跑对应的那一镜就会重新生成；不需要了就把引用它的节点改掉。</small></div>` : "";

  const statHtml = ledger && ledger.stat ? `<div class="canvas-library-stat">${ledger.stat.total} 个素材 · 图 ${ledger.stat.byKind.image} / 视频 ${ledger.stat.byKind.video} / 音 ${ledger.stat.byKind.audio}${ledger.stat.orphan ? ` · <b>${ledger.stat.orphan} 个没人用</b>` : ""}${ledger.stat.bytes ? ` · ${canvasBytesText(ledger.stat.bytes)}` : ""}</div>` : "";

  const listHtml = shown.length ? shown.map((asset) => {
    const kind = asset.kind, label = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
    const use = canvasAssetUseText(asset);
    const roleTag = asset.role && asset.role !== "其他" ? `<em class="canvas-library-role">${esc(asset.role)}</em>` : "";
    const useTag = use ? `<span class="canvas-library-use${asset.orphan ? " is-orphan" : ""}">${esc(use)}</span>` : "";
    return `<button class="canvas-library-item" data-library-file="${esc(asset.name)}" title="添加到画布：${esc(asset.name)}"><span class="canvas-library-icon">${ic(CANVAS_NODE_DEFS[kind].icon)}</span><span><b>${esc(asset.base || String(asset.name).split("/").pop())}${roleTag}</b><small>${label} · ${esc(String(asset.name))}</small>${useTag}</span><span class="canvas-library-add">+</span></button>`;
  }).join("") : `<div class="canvas-library-empty">${all.length ? "这些条件下没有素材" : "工作区里还没有图片、视频或音频"}</div>`;
  const moreHtml = rows.length > shown.length ? `<div class="canvas-library-more">还有 ${rows.length - shown.length} 个，用上面的搜索框缩小范围</div>` : "";

  box.innerHTML = missingHtml + statHtml + listHtml + moreHtml;
  box.querySelectorAll("[data-library-file]").forEach((button) => button.addEventListener("click", () => {
    const name = button.dataset.libraryFile, kind = canvasFileKind(name);
    const node = canvasAddNode(kind, { title: String(name).split("/").pop(), path: name, role: kind === "image" ? "参考素材" : kind === "video" ? "视频素材" : "声音素材", tags: "", url: `/api/files/view/${name.split("/").filter(Boolean).map(encodeURIComponent).join("/")}` }, { x: 120 + (canvasState.next % 3) * 420, y: 760 + Math.floor(canvasState.next / 3) * 290 });
    if (node) canvasToast("素材已添加到画布，可在右侧继续编辑或连接。", "plus");
  }));
}

function canvasBytesText(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(1) + " GB";
}

/** 素材台账。单独一条路：算得慢一点也不该挡住文件列表出现 */
/* ── 短剧制片进度带 ────────────────────────────────────────────────────────
 * 用户要的是「真的能拿这个做 AI 短剧」。画布上摆得下三十个镜头，但摆得下不等于做得完：
 * 还差几张首帧、哪一镜卡着、剩下的活儿大概多久，光看画布是看不出来的，
 * 用户只能一个节点一个节点点开数——那不叫工作流。
 *
 * 这条带子回答三个问题，顺序就是它在屏幕上的顺序：
 *   ① 做到哪了（七档进度：剧本 → 定妆 → 分镜 → 首帧 → 镜头视频 → 配音 → 成片）
 *   ② 卡在哪（点一下直接跳到出问题的那几个节点上）
 *   ③ 还剩多少活儿、按这张画布自己跑过的速度大概要多久，以及「一键把差的补上」
 *
 * 判定全在服务端 drama-pipeline.js 里做（纯函数、可单测），这里只负责显示和按按钮。
 */
function canvasEtaText(ms) {
  if (!ms || ms < 1000) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `约 ${m} 分钟`;
  return `约 ${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 跳到出问题的节点上：选中 + 居中。卡在哪要能点得过去，不然说了等于没说 */
function canvasProgressFocus(ids) {
  const wanted = new Set((ids || []).map(String));
  const hit = (canvasState.graph?.getElements?.() || []).filter((n) => wanted.has(String(n.id)));
  if (!hit.length) { canvasToast("这些节点在当前画布上找不到了（可能刚被删掉）。", "info"); return; }
  canvasState.selectedAll = false;
  canvasState.selectedIds = new Set(hit.map((n) => n.id));
  canvasState.selected = hit[0].id;
  canvasRenderInspector(false);
  canvasCenterSelected(document.querySelector(".canvas-page"));
  hit.forEach((n) => canvasRefreshNode(n));
}

/** 进度带里那块合成区。方案、跑动、结果三种样子，同一块地方，不弹窗 */
function canvasComposeHtml(p) {
  const job = canvasState.composeJob, plan = canvasState.composePlan;
  const shots = p.shots || [];
  const canCompose = shots.length > 0 && shots.every((r) => r.video && r.video.ok);
  const button = (label, extra) => `<button class="ui-btn ui-btn--xs ui-btn--brand" data-cp-compose ${extra || ""}>${esc(label)}</button>`;

  if (job && !job.done) {
    const at = Math.max(1, Number(job.at) || 1), total = Math.max(1, Number(job.total) || 1);
    const step = (job.steps || [])[at - 1] || {};
    return `<div class="cp-compose"><div class="cp-compose-head"><b>正在拼成片</b>`
      + `<span>第 ${at}/${total} 步 · ${esc(step.label || "")}</span>`
      + `<button class="ui-btn ui-btn--xs ui-btn--ghost" data-cp-compose-stop>停下</button></div>`
      + `<div class="cp-bar is-sub"><i style="width:${Math.round(((at - 1) / total) * 100)}%"></i></div>`
      + (job.log || []).map((l) => `<div class="cp-compose-log">${esc(l)}</div>`).join("")
      + `</div>`;
  }
  if (job && job.output) {
    return `<div class="cp-compose is-done"><div class="cp-compose-head"><b>成片好了</b>`
      + `<code>${esc(job.subtitled || job.output)}</code>`
      + `<button class="ui-btn ui-btn--xs ui-btn--outline" data-cp-compose-open="${esc(job.subtitled || job.output)}">打开看看</button>`
      + button("重新合成") + `</div>`
      + (job.subtitled && job.output !== job.subtitled ? `<div class="cp-compose-log">不带字幕的那条也在：${esc(job.output)}</div>` : "")
      // 没烧进画面的时候更要说字幕文件在哪：不说，用户会以为字幕根本没做出来，
      // 而它其实就躺在旁边，拖进剪映/达芬奇就能用
      + (job.subtitleFile && !job.subtitled ? `<div class="cp-compose-log">字幕文件也在：${esc(job.subtitleFile)}（没烧进画面，拖进剪辑软件就能用）</div>` : "")
      + (job.log || []).map((l) => `<div class="cp-compose-log">${esc(l)}</div>`).join("")
      + `</div>`;
  }
  if (job && job.error) {
    const bad = (job.steps || []).filter((x) => x.state === "fail");
    return `<div class="cp-compose is-bad"><div class="cp-compose-head"><b>没拼成</b><span>${esc(job.error)}</span>${button("再来一次")}</div>`
      + bad.map((x) => `<div class="cp-compose-log">${esc(x.label)}：${esc(x.note || "")}</div>`).join("")
      + `</div>`;
  }
  if (plan === "loading") return `<div class="cp-compose"><span class="cp-compose-tip">正在看这部戏能不能拼（在探每一镜的真实时长和画幅）…</span></div>`;
  if (plan) {
    const stop = (plan.blockers || []).filter((b) => b.level === "stop");
    const warn = (plan.blockers || []).filter((b) => b.level !== "stop");
    const rows = (plan.shots || []).map((r, i) => `<li${r.why ? ' class="is-bad"' : ""}>`
      + `<span class="cp-ord">${i + 1}</span><b>${esc(r.id)}</b>`
      + `<span>${r.seconds ? r.seconds + "s" : "时长探不到"}</span>`
      + `<span>${r.audio ? "有配音" : r.line ? "缺配音" : "无人声"}${r.pad ? `（画面补 ${r.pad}s）` : ""}</span>`
      + `<span class="cp-why">${esc(r.why || "")}</span></li>`).join("");
    const eta = canvasEtaText(plan.etaMs);
    // 「烧不了」有三种不一样的原因，混成一句「做不了」等于没说：
    // 自己关掉的不用解释；没台词/探不到时长是这张画布的事；没 libass 是这台机器的事，
    // 而且后者字幕文件照样给——不说清楚，用户会以为字幕根本没生成
    const burnBlocked = (plan.blockers || []).some((b) => /libass/.test(b.text));
    const subNote = !canvasState.composeSub || plan.outputs.subtitled ? ""
      : burnBlocked ? "（本机 ffmpeg 没带 libass，烧不进画面；字幕文件照样给你）"
      : "（这次做不了：没有台词，或者探不到时长）";
    return `<div class="cp-compose is-plan"><div class="cp-compose-head"><b>合成方案</b>`
      + `<span>${(plan.shots || []).length} 镜 · ${plan.totalSeconds ? plan.totalSeconds + " 秒" : "总时长探不到"} · ${plan.mode === "copy" ? "直接拼，一帧都不重压" : `统一到 ${plan.target.w}×${plan.target.h} 重新编码`}</span>`
      + `<button class="ui-btn ui-btn--xs ui-btn--ghost" data-cp-compose-close>收起</button></div>`
      + `<div class="cp-compose-tip">下面就是成片里的先后顺序，按分镜编号排的。不对就改镜头 ID 或者调整顺序后再来。</div>`
      + `<ol class="cp-order">${rows}</ol>`
      + [...stop, ...warn].map((b) => `<div class="cp-compose-log is-${esc(b.level)}">${esc(b.text)}</div>`).join("")
      + `<label class="cp-compose-sub"><input type="checkbox" data-cp-compose-sub ${canvasState.composeSub ? "checked" : ""}>把字幕烧进画面${subNote}</label>`
      // 配乐：用了哪一段得写出来。画布上可能摆着好几段音乐，
      // 「它到底混了哪一首」是开跑前一眼能纠正、跑完只能重跑一遍的事
      + (plan.music
        ? `<label class="cp-compose-sub"><input type="checkbox" data-cp-compose-bgm ${canvasState.composeBgm ? "checked" : ""}>垫上配乐<code>${esc(plan.music.title || plan.music.base)}</code><span class="cp-why">${plan.music.duck ? "说话的时候自动压低" : "固定音量垫在台词底下"}</span></label>`
        : `<div class="cp-compose-tip">想加配乐：往画布上放一个「声音」节点，素材用途写成「配乐」，把音乐文件拖进去。</div>`)
      + `<div class="cp-compose-out">会写出 <code>${esc(plan.outputs.film)}</code>${plan.outputs.subtitled ? ` 和 <code>${esc(plan.outputs.subtitled)}</code>` : ""}${plan.outputs.srt ? ` 和 <code>${esc(plan.outputs.srt)}</code>` : ""}${(plan.outputs.clips || []).length ? ` · 中间片段放在 <code>${esc(plan.outputs.dir)}/</code>` : ""}。同名的旧成片不会被盖掉。</div>`
      + `<div class="cp-compose-act"><button class="ui-btn ui-btn--xs ui-btn--brand" data-cp-compose-go ${plan.ready ? "" : "disabled"}>开始合成${eta ? `（${eta}）` : ""}</button></div>`
      + `</div>`;
  }
  if (!canCompose) return "";
  return `<div class="cp-compose">${button("合成成片")}<span class="cp-compose-tip">逐镜头把画面接上配音 → 按顺序拼起来 → 垫配乐 → 烧字幕。全在本机跑，不花钱。</span></div>`;
}

/**
 * 进度条占了多高，就从画布视口里扣掉多少。
 *
 * 视口的高度是写死的 calc(100vh - 278px)，那个 278 是这一条还不存在时算出来的。
 * 它一出现（展开之后还会长出卡点清单和镜头表）就把下面的画布连同对话区一起顶下去，
 * 界面上看到的就是「又被挡住了」。所以把它的实际高度量出来喂给 CSS，视口自己让位。
 */
function canvasProgressHeight(box) {
  const page = document.getElementById("assist-page");
  // 让位只是好看，量不出来就算了：一条进度带不能因为「高度没算成」整条画不出来
  if (!page || !page.style || typeof page.style.setProperty !== "function") return;
  const h = box && !box.hidden ? (box.offsetHeight || 0) + 8 : 0; // +8 是它自己的下边距
  page.style.setProperty("--cp-h", h + "px");
}

function canvasRenderProgress() {
  const box = document.getElementById("canvas-progress");
  if (!box) return;
  const p = canvasState.progress;
  // 读不到就整条不显示。显示一个「0%」比什么都不显示更糟：那是在撒谎
  if (!p || !Array.isArray(p.stages)) { box.hidden = true; box.innerHTML = ""; canvasProgressHeight(box); return; }
  const counted = p.stages.filter((s) => s.total > 0);
  if (!counted.length && !(p.blockers || []).length) { box.hidden = true; box.innerHTML = ""; canvasProgressHeight(box); return; }
  box.hidden = false;

  const chips = p.stages.map((s) => s.total === 0
    ? `<span class="cp-chip is-none" title="这张画布上没有这一档的节点">${esc(s.label)}</span>`
    : `<span class="cp-chip is-${s.state}" title="${esc(s.label + "：" + s.done + "/" + s.total)}">${esc(s.label)}<b>${s.done}/${s.total}</b></span>`).join("");

  const stops = (p.blockers || []).filter((b) => b.level === "stop");
  const others = (p.blockers || []).filter((b) => b.level !== "stop");
  const blockerHtml = [...stops, ...others].slice(0, 6).map((b, i) => `<li class="cp-blocker is-${esc(b.level)}">`
    + `<span>${esc(b.text)}</span>`
    + (b.ids && b.ids.length ? `<button class="ui-btn ui-btn--xs ui-btn--ghost" data-cp-focus="${i}">跳过去看</button>` : "")
    + `</li>`).join("");

  const pend = p.pending || {};
  const jobs = [["cast", "定妆照", pend.cast], ["image", "首帧", pend.image], ["video", "镜头视频", pend.video], ["audio", "配音", pend.audio]]
    .filter(([, , n]) => n > 0);
  const eta = p.eta ? canvasEtaText(p.eta.ms) : "";
  const running = canvasState.batch;
  const jobsHtml = jobs.length
    ? `<div class="cp-jobs"><span class="cp-jobs-label">还要生成</span>`
      + jobs.map(([kind, label, n]) => `<button class="ui-btn ui-btn--xs ui-btn--outline" data-cp-run="${kind}" ${running ? "disabled" : ""} title="${esc("按镜头顺序一个一个跑，中途可以停")}">${esc(label)} ${n} 个</button>`).join("")
      + (eta ? `<span class="cp-eta" title="${esc(p.eta.basis + (p.eta.partial ? "；有一类还没跑过，这个数只算了跑过的那些" : ""))}">${esc(eta)}${p.eta.partial ? "（还不全）" : ""}</span>`
             : `<span class="cp-eta is-unknown" title="这张画布还没跑过生成，估不出来">时间估不出来</span>`)
      + (running ? `<span class="cp-running">正在跑第 ${running.at}/${running.total} 个${running.label ? "：" + esc(running.label) : ""}</span><button class="ui-btn ui-btn--xs ui-btn--ghost" data-cp-stop>停下</button>` : "")
      + `</div>`
    : "";

  const shots = (p.shots || []).filter((r) => r.blocked || !r.frame || !r.video);
  const shotsHtml = shots.length ? `<table class="cp-shots"><thead><tr><th>镜头</th><th>首帧</th><th>视频</th><th>配音</th><th>卡在哪</th></tr></thead><tbody>`
    + shots.slice(0, 30).map((r) => {
      const cell = (v, need) => !need ? `<span class="cp-x is-skip" title="这一镜不需要">—</span>`
        : v && v.ok ? `<span class="cp-x is-ok">✓</span>`
          : v ? `<span class="cp-x is-lost" title="${esc(v.path)}">文件没了</span>`
            : `<span class="cp-x is-todo">·</span>`;
      return `<tr data-cp-shot="${esc(r.nodeId)}"><td>${esc(r.id)}</td><td>${cell(r.frame, true)}</td><td>${cell(r.video, true)}</td><td>${cell(r.audio, r.needsVoice)}</td><td class="cp-why">${esc(r.blocked || "")}</td></tr>`;
    }).join("")
    + `</tbody></table>${shots.length > 30 ? `<div class="cp-more">还有 ${shots.length - 30} 个镜头没列出来</div>` : ""}` : "";

  box.innerHTML = `<div class="cp-bar"><i style="width:${Math.max(0, Math.min(100, p.percent))}%"></i></div>`
    + `<button class="cp-head" type="button" data-cp-toggle aria-expanded="${canvasState.progressOpen ? "true" : "false"}">`
      + `<span class="cp-pct">${p.percent}%</span>`
      + `<span class="cp-stages">${chips}</span>`
      // 收起时这里是唯一一句话，展开时下面第一条卡点就是它——同一句话摆两遍，看着像出了两个故障。
      // 展开时留着这个格子当撑满的间隔（flex:1），只是不写字
      + `<span class="cp-next" title="${esc(p.next?.text || "")}">${(canvasState.progressOpen ? "" : esc(p.next?.text || ""))}</span>`
      + `<span class="cp-caret">${ic(canvasState.progressOpen ? "chevron-up" : "chevron-down")}</span>`
    + `</button>`
    + (canvasState.progressOpen
      ? `<div class="cp-body">${blockerHtml ? `<ul class="cp-blockers">${blockerHtml}</ul>` : ""}${jobsHtml}${canvasComposeHtml(p)}${shotsHtml}${p.boardUnreadable ? `<div class="cp-warn">画布文件读不出来，这里算的是空的：${esc(p.boardUnreadable)}</div>` : ""}</div>`
      : "");

  canvasProgressHeight(box);
  box.querySelector("[data-cp-toggle]")?.addEventListener("click", () => { canvasState.progressOpen = !canvasState.progressOpen; canvasRenderProgress(); });
  const all = [...stops, ...others].slice(0, 6);
  box.querySelectorAll("[data-cp-focus]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); canvasProgressFocus(all[Number(b.dataset.cpFocus)]?.ids); }));
  box.querySelectorAll("[data-cp-shot]").forEach((tr) => tr.addEventListener("click", () => canvasProgressFocus([tr.dataset.cpShot])));
  box.querySelectorAll("[data-cp-run]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); canvasRunPending(b.dataset.cpRun); }));
  box.querySelector("[data-cp-stop]")?.addEventListener("click", (e) => { e.stopPropagation(); if (canvasState.batch) canvasState.batch.stop = true; canvasToast("这一个跑完就停。", "info"); });
  box.querySelector("[data-cp-compose]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasComposeOpen(); });
  box.querySelector("[data-cp-compose-go]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasComposeStart(); });
  box.querySelector("[data-cp-compose-stop]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasComposeStop(); });
  box.querySelector("[data-cp-compose-close]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasState.composePlan = null; canvasRenderProgress(); });
  box.querySelector("[data-cp-compose-open]")?.addEventListener("click", (e) => { e.stopPropagation(); canvasPreviewRight(e.currentTarget.dataset.cpComposeOpen); });
  // 字幕烧不烧会换掉输出文件名，所以改了就重算一遍方案，别让屏幕上写的和真跑的是两回事
  box.querySelector("[data-cp-compose-sub]")?.addEventListener("change", (e) => { e.stopPropagation(); canvasState.composeSub = !!e.currentTarget.checked; canvasComposeOpen(); });
  box.querySelector("[data-cp-compose-bgm]")?.addEventListener("change", (e) => { e.stopPropagation(); canvasState.composeBgm = !!e.currentTarget.checked; canvasComposeOpen(); });
}

async function canvasLoadProgress() {
  const r = await fetch("/api/canvas/progress?name=" + encodeURIComponent(canvasState.canvasName)).then((x) => x.json()).catch(() => null);
  canvasState.progress = r && Array.isArray(r.stages) ? r : null;
  canvasRenderProgress();
}

/**
 * 把缺的那一类一次跑完。
 *
 * 一个一个串着跑，不并发：生图生视频是花钱也吃显存的活儿，十个一起发出去，
 * 失败了都不知道是哪个先撞的墙。中途能停，停的意思是「这一个跑完就不再开下一个」，
 * 不是把正在跑的那个掐死——掐死只会留下一个半截文件。
 */
async function canvasRunPending(kind) {
  if (canvasState.batch) return;
  const elements = canvasState.graph?.getElements?.() || [];
  const has = (p, k) => {
    const row = (canvasState.progress?.shots || []).find((r) => String(r.nodeId) === String(p));
    if (!row) return true;
    const v = k === "image" ? row.frame : k === "video" ? row.video : row.audio;
    if (k === "audio" && !row.needsVoice) return true;
    if (k === "video" && !(row.frame && row.frame.ok)) return true;   // 没首帧的镜头轮不到生视频
    return !!(v && v.ok);
  };
  // 定妆照这一档数的是角色节点，判「做完了没」看的是盘上到底有没有那张图（进度接口算的），
  // 不是画布上写没写路径——写着路径而文件没了，照样得重跑。
  const castRows = (canvasState.progress && canvasState.progress.cast) || [];
  const castOk = (id) => { const row = castRows.find((r) => String(r.nodeId) === String(id)); return !!(row && row.image && row.image.ok); };
  const todo = kind === "cast"
    ? elements.filter((n) => canvasKind(n) === "character" && !castOk(n.id) && !canvasIsPlaceholderPrompt(canvasPayload(n).description))
    : elements.filter((n) => canvasKind(n) === "shot" && !has(n.id, kind)
      && !canvasIsPlaceholderPrompt(canvasPayload(n).prompt));
  if (!todo.length) {
    // 「没有要补的了」和「有要补的，但都还没写设定」是两回事，不能都报一句绿的
    const held = kind === "cast" && elements.some((n) => canvasKind(n) === "character" && !castOk(n.id));
    canvasToast(held ? "这几个角色还没写人物设定，只有名字生不出能当参考的定妆照。" : "这一类没有要补的了。",
      held ? "triangle-alert" : "circle-check", held ? "err" : undefined);
    return;
  }
  // 配音这一档多一道：不知道该用谁的嗓子的镜头先拦下来。
  // 整批停掉太狠（二十个镜头里一个没点名，另外十九个也做不了），一个一个弹错误又只会被
  // 最后那句「N 个没成」盖掉——所以把它们摘出来单算，跑完一起说清楚，再跳到那几个镜头上。
  const noSpeaker = kind === "audio" ? todo.filter((n) => canvasResolveVoice(n, canvasPayload(n)).error) : [];
  const queue = todo.filter((n) => !noSpeaker.includes(n));
  const heldNote = noSpeaker.length ? `，${noSpeaker.length} 个不知道该用谁的嗓子（去镜头的「说话的角色」里点个名）` : "";
  if (!queue.length) {
    canvasToast(`这一批都不知道该用谁的嗓子：${noSpeaker.length} 个镜头连着好几个角色，音色不一样，得先点名说话的是谁。`, "triangle-alert", "err");
    canvasProgressFocus(noSpeaker.map((n) => n.id));
    return;
  }
  canvasState.batch = { kind, total: queue.length, at: 0, label: "", stop: false };
  canvasRenderProgress();
  let ok = 0, bad = 0;
  try {
    for (const node of queue) {
      if (canvasState.batch.stop) break;
      canvasState.batch.at += 1;
      canvasState.batch.label = String(canvasPayload(node).id || canvasPayload(node).name || canvasPayload(node).title || "");
      canvasRenderProgress();
      const before = canvasPayload(node);
      await canvasGenerate(node, kind === "cast" ? "image" : kind);
      const after = canvasPayload(node);
      const key = kind === "cast" ? "reference" : kind === "image" ? "first_frame" : kind === "video" ? "video" : "audio";
      if (after[key] && after[key] !== before[key]) ok += 1; else bad += 1;
    }
  } finally {
    const stopped = canvasState.batch?.stop;
    canvasState.batch = null;
    canvasToast(`${ok} 个做好了${bad ? `，${bad} 个没成` : ""}${heldNote}${stopped ? "（手动停了）" : ""}`, bad || noSpeaker.length ? "triangle-alert" : "circle-check", bad || noSpeaker.length ? "err" : undefined);
    if (noSpeaker.length) canvasProgressFocus(noSpeaker.map((n) => n.id));
    await canvasLoadProgress();
    canvasLoadLibrary();
  }
}

/**
 * 合成成片：把画布上的镜头真的拼成一条能播的片子。
 *
 * 三步，缺一不可：
 *   ① 先算方案，**摆出来给人看**——镜头排成什么顺序、哪一镜缺配音、会写出哪几个文件。
 *      排错顺序是这条链路上最贵的错：片子能播、时长也对，只有情节是乱的，
 *      没有任何一条报错会红，只有人看到第三分钟才发现。所以顺序必须先过一眼。
 *   ② 确认了才跑。跑的是服务端拼好的 ffmpeg 命令，一条一条来，跑到哪写到哪。
 *   ③ 跑完了认账：成片真的落盘才说成了，没落盘就说没落盘。
 * 中途能停。停下来已经拼好的片段都留着，下次接着拼不用重跑。
 */
async function canvasComposeOpen() {
  canvasState.progressOpen = true;
  canvasState.composePlan = "loading";
  canvasState.composeJob = null;
  canvasRenderProgress();
  const r = await fetch("/api/canvas/compose", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: canvasState.canvasName, subtitles: canvasState.composeSub, music: canvasState.composeBgm }),
  }).then((x) => x.json()).catch((e) => ({ error: String((e && e.message) || e) }));
  if (!r || !r.plan) {
    canvasState.composePlan = null; canvasRenderProgress();
    canvasToast("算不出合成方案：" + ((r && r.error) || "服务端没回话"), "circle-x", "err");
    return;
  }
  canvasState.composePlan = r.plan;
  canvasRenderProgress();
}

async function canvasComposeStart() {
  const plan = canvasState.composePlan;
  if (!plan || plan === "loading" || !plan.ready) return;
  const r = await fetch("/api/canvas/compose", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: canvasState.canvasName, subtitles: canvasState.composeSub, run: true }),
  }).then((x) => x.json()).catch((e) => ({ error: String((e && e.message) || e) }));
  if (!r || !r.job) { canvasToast("没跑起来：" + ((r && r.error) || "服务端没回话"), "circle-x", "err"); return; }
  canvasState.composePlan = null;
  canvasState.composeJob = r.job;
  canvasRenderProgress();
  canvasComposePoll();
}

/** 盯着这条合成跑到哪了。1.2 秒问一次：ffmpeg 一条命令动辄几十秒，问太勤没有意义 */
function canvasComposePoll() {
  window.clearTimeout(canvasState.composeTimer);
  canvasState.composeTimer = window.setTimeout(async () => {
    const id = canvasState.composeJob && canvasState.composeJob.id;
    if (!id) return;
    const r = await fetch("/api/canvas/compose?job=" + encodeURIComponent(id)).then((x) => x.json()).catch(() => null);
    if (r && r.job) canvasState.composeJob = r.job;
    canvasRenderProgress();
    if (!r || !r.job || !r.job.done) return canvasComposePoll();
    const job = r.job;
    if (job.output) {
      canvasToast(`成片出来了：${job.subtitled || job.output}${job.wroteNode ? "，" + job.wroteNode : ""}`, "circle-check");
      canvasLoadLibrary();   // 素材台账、制片进度、节点上的那格视频，都等着这一下刷新
    } else {
      canvasToast("没拼成：" + (job.error || "不知道为什么，展开看看哪一步红了"), "circle-x", "err");
    }
  }, 1200);
}

async function canvasComposeStop() {
  const id = canvasState.composeJob && canvasState.composeJob.id;
  if (!id) return;
  await fetch("/api/canvas/compose", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cancel: id }),
  }).catch(() => null);
  canvasToast("正在停…已经拼好的片段都留着。", "info");
}

/** 起手模板里那几句占位文字。跟服务端 drama-pipeline.js 的 PLACEHOLDERS 是同一份口径 */
const CANVAS_PROMPT_PLACEHOLDERS = ["一句话概念、人物关系、冲突与结局…", "在这里写一句话概念、人物关系、冲突、对白和结局。", "还没有剧本内容", "镜头内容与运动…", "对白或旁白…", "人物外形、性格、目标与关系…", "地点、时间、天气、光线与氛围…", "这张图要保持的主体、风格与构图…", "描述你想生成的内容…", "对白、旁白或音乐说明…"];
function canvasIsPlaceholderPrompt(text) { const t = String(text || "").trim(); return !t || CANVAS_PROMPT_PLACEHOLDERS.includes(t); }

async function canvasLoadAssets() {
  const r = await fetch("/api/canvas/assets?name=" + encodeURIComponent(canvasState.canvasName)).then((x) => x.json()).catch(() => null);
  canvasState.assets = r && Array.isArray(r.assets) ? r : null;
  canvasRenderLibrary();
}

/** 节点上所有装文件路径的字段。跟服务端 ASSET_REF_KEYS 是同一份口径 */
const CANVAS_REF_KEYS = ["path", "file", "url", "video", "audio", "image", "reference", "first_frame", "last_frame", "reference_video", "subtitled", "voice_file", "ref"];

/**
 * 把「清单里没有」的那批素材拿去问盘，问出来真没有的才算没有。
 *
 * 只问清单里找不到的那些——画布上大部分素材都在清单里，没必要为它们跑一趟。
 * 问完两头都写：盘说没有的进 missing（横幅这才画得出来），盘说有的从 missing 里拿掉
 * （用户把文件补回来之后，横幅得自己消失，不能等刷新整页）。
 */
async function canvasVerifyMissing() {
  const nodes = canvasState.graph?.getElements?.() || [];
  const inList = new Set(canvasState.files.map((f) => String(f.name || f.path || "")));
  const ask = new Set();
  for (const node of nodes) {
    const payload = canvasPayload(node) || {};
    for (const key of CANVAS_REF_KEYS) {
      const raw = String(payload[key] || "").trim();
      if (!raw || /^(https?:|data:|\/api\/files\/view\/)/i.test(raw)) continue;
      const resolved = canvasResolvedFileName(raw);
      if (!inList.has(resolved)) ask.add(resolved);
    }
  }
  // 清单里全找得着，就没什么可问的；顺手把上一轮留下的判决清掉
  if (!ask.size) { if (canvasState.missing.size) { canvasState.missing.clear(); nodes.forEach((n) => canvasRefreshNode(n)); } return; }
  const r = await fetch("/api/files/exists", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [...ask] }),
  }).then((x) => x.json()).catch(() => null);
  // 问不到（断网、接口挂了）就维持「认在」——没问出结果不是给文件盖章的理由
  if (!r || !r.exists) return;
  let changed = false;
  for (const [path, ok] of Object.entries(r.exists)) {
    const had = canvasState.missing.has(path);
    if (ok && had) { canvasState.missing.delete(path); changed = true; }
    else if (!ok && !had) { canvasState.missing.add(path); changed = true; }
  }
  if (!changed) return;
  nodes.forEach((node) => canvasRefreshNode(node));
  if (canvasSelectedNode()) canvasRenderInspector(false);
}

async function canvasLoadLibrary() {
  const response = await fetch("/api/files").then((x) => x.json()).catch(() => []);
  canvasState.files = Array.isArray(response) ? response : [];
  canvasState.graph?.getElements?.().forEach((node) => canvasRefreshNode(node));
  canvasRenderLibrary(); canvasMaterializeResultNodes(); if (canvasSelectedNode()) canvasRenderInspector(false);
  canvasLoadAssets();   // 台账后到，到了再刷一次面板
  canvasLoadProgress();  // 制片进度跟素材台账一样后到，各刷各的，谁先到谁先显示
  canvasVerifyMissing(); // 缺失判决也后到：清单里没有的那几个，问过盘才敢说它没了
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

/**
 * 盘上那份画布读不出来时，整页显示这个，而不是往下画。
 *
 * 往下画的后果很具体：JointJS 起来 → 铺一张空画布（或者拿本机副本铺）→ 用户随手一动 →
 * 自动保存。服务端现在会挡住这一下（PUT 不带 force 就不覆盖读不出来的文件），
 * 但用户看不见挡没挡住，只会以为一直在正常干活。所以这里把话说全：
 * 出了什么事、原件在哪、有哪几条路可以走。
 */
function canvasRenderBroken(page, world) {
  const local = canvasLoadSaved();
  const count = local ? local.nodes.length : 0;
  world.innerHTML = `<div class="canvas-empty canvas-broken"><div>
    <h3>这张画布现在读不出来</h3>
    <p class="canvas-broken-why">${esc(canvasState.remoteBroken)}</p>
    <p>没有把它当成空画布显示——那样你在上面随手一动，自动保存就会把还有救的原件盖掉。原件一个字节都没动。</p>
    <div class="canvas-broken-acts">
      <button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-broken-retry>重新读一次</button>
      ${count ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-canvas-broken-restore>用本机这份恢复（${count} 个节点）</button>` : ""}
    </div>
    <p class="canvas-broken-tip">${count ? "本机副本是这台机器上次打开时的样子，可能比项目里那份旧一点。" : "这台机器上没有本机副本，所以只能先修文件本身。"}把 .openworkbuddy 目录里的 canvas 备份（.bak / .坏了-*.bak）拷回去，也能救。</p>
  </div></div>`;
  world.querySelector("[data-canvas-broken-retry]").onclick = () => renderCanvasPage();
  world.querySelector("[data-canvas-broken-restore]")?.addEventListener("click", () => canvasRestoreFromLocal(local));
  // 这一页上别的按钮都没绑（下面那一大段绑定被跳过了），但换画布得留着：
  // 一张画布坏了不该把人锁死在这儿
  const select = page.querySelector("[data-canvas-board-select]");
  if (select) select.onchange = async (event) => { await canvasFlushRemoteWrite(); canvasState.canvasName = event.target.value || "main"; try { localStorage.setItem("openworkbuddy.canvas.name", canvasState.canvasName); } catch {} renderCanvasPage(); };
}

/** 拿本机副本盖掉那份读不出来的文件。只有用户自己点了才会走到这儿，且原件已经备份过。 */
async function canvasRestoreFromLocal(local) {
  if (!local || !local.nodes.length) return;
  if (!confirm(`用本机这份（${local.nodes.length} 个节点）覆盖项目里那份读不出来的画布？\n\n原文件已经原样备份在 .openworkbuddy 目录里，随时能翻回去。`)) return;
  const state = { version: 1, nodes: local.nodes, edges: local.edges || [], updatedAt: Date.now() };
  const response = await fetch("/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: canvasState.canvasName, state, force: true }) }).catch(() => null);
  const result = response ? await response.json().catch(() => ({})) : {};
  if (!response || !response.ok) { canvasToast(result.error || "恢复失败，项目里那份没有动", "circle-x", "err"); return; }
  canvasState.remoteBroken = ""; canvasState.remoteBrokenNotified = false;
  canvasToast("已用本机这份恢复", "circle-check");
  renderCanvasPage();
}

function canvasRestoreOrSeed(remote = null) {
  const local = canvasLoadSaved();
  const saved = remote && remote.nodes.length ? remote : local;
  if (saved && saved.nodes.length) {
    // 服务器那份直接铺、不回写；本机那份铺完要往上顶一次（这台机器上有、服务器上没有的改动）
    canvasApplySnapshot(saved, { fromRemote: saved === remote }); return;
  }
  // 起手那两张卡只给「从来没人动过」的画布。判据不能是「现在是空的」——用户把画布自己清空之后
  // 就正好是空的，于是每打开一次长回来两张，还连带存回服务器，换台机器打开看见的也是这两张。
  // 动过没有看两处：本机有没有存过这张画布，以及服务器那份的 updatedAt（新建出来的是 0）
  if (local || (remote && Number(remote.updatedAt) > 0)) {
    if (remote) canvasApplySnapshot(remote, { fromRemote: true });
    return;
  }
  const script = canvasAddNode("script", { title: "一句话概念", text: "在这里写一句话概念、人物关系、冲突、对白和结局。" }, { x: 100, y: 110 }, { persist: false, skipSelect: true });
  const storyboard = canvasAddNode("storyboard", {}, { x: 510, y: 110 }, { persist: false, skipSelect: true });
  if (script && storyboard) canvasConnect(script, storyboard); canvasState.selected = null; canvasState.selectedIds = new Set(); canvasRenderInspector(false); canvasPersist();
}

function canvasDestroy() { if (canvasState.remoteTimer) clearInterval(canvasState.remoteTimer); if (canvasState.remoteWriteTimer) clearTimeout(canvasState.remoteWriteTimer); if (canvasState.historyTimer) clearTimeout(canvasState.historyTimer); if (canvasState.fullscreenHandler) document.removeEventListener("fullscreenchange", canvasState.fullscreenHandler); const page = document.getElementById("assist-page"); if (page && canvasState.keyHandler) page.removeEventListener("keydown", canvasState.keyHandler); if (page && canvasState.keyUpHandler) page.removeEventListener("keyup", canvasState.keyUpHandler); if (canvasState.paper) canvasState.paper.remove(); canvasState.graph = null; canvasState.paper = null; canvasState.wheelHandler = null; canvasState.keyHandler = null; canvasState.keyUpHandler = null; canvasState.spacePanning = false; canvasState.inspectorOpen = false; canvasState.nodeGesture = null; canvasState.multiMove = null; canvasState.fullscreenHandler = null; canvasState.selected = null; canvasState.selectedIds = new Set(); canvasState.selectedAll = false; canvasState.remoteSnapshot = null; canvasState.remoteContentKey = ""; canvasState.remoteUpdatedAt = 0; canvasState.remoteWriteArmed = null; canvasState.remoteWritePending = false; canvasState.remoteBroken = ""; canvasState.remoteBrokenNotified = false; canvasState.lostNotified = ""; canvasState.taskSessionId = null; canvasState.chatReferences = new Map(); canvasState.history = []; canvasState.historyIndex = -1; canvasState.historyTimer = null; }

async function renderCanvasPage() {
  const page = document.getElementById("assist-page"); if (!page) return;
  await canvasFlushRemoteWrite();   // canvasDestroy 会把定时器掐掉，掐之前先把欠的写出去
  canvasDestroy(); await Promise.all([canvasLoadWorkspaceProjects(), canvasLoadCanvasList()]); canvasState.scale = 1; canvasState.x = 0; canvasState.y = 0; canvasState.next = 1;
  const groupOrder = ["策划", "世界设定", "分镜制作", "素材与生成", "交付"];
  const groupedMenu = groupOrder.map((group) => `<span class="canvas-menu-group"><span class="canvas-menu-group-label">${group}</span>${Object.entries(CANVAS_NODE_DEFS).filter(([, def]) => def.group === group).map(([kind, def]) => `<button class="canvas-type-btn" data-canvas-add="${kind}" title="${esc(def.subtitle)}">${ic(def.icon)}<span>${esc(def.label)}</span></button>`).join("")}</span>`).join("");
  const workspaceOptions = canvasState.workspaceProjects.map((item) => `<option value="${esc(item.name)}" ${item.name === canvasState.workspaceName ? "selected" : ""}>${esc(item.name)}</option>`).join("");
  page.classList.add("canvas-page");
  page.innerHTML = `<div class="canvas-head"><div><div class="canvas-kicker">WORKSPACE · 无限画布</div><h1>无限画布</h1><div class="canvas-board-switch"><label class="canvas-workspace-switch" title="${esc(canvasState.workspaceDir)}">${ic("folder")}<select data-canvas-workspace-select ${canvasState.workspaceLocked ? "disabled" : ""}>${workspaceOptions || `<option value="">${esc(canvasState.workspaceDir.split(/[\\/]/).pop() || "当前工作文件夹")}</option>`}${canvasState.workspaceLocked ? "" : '<option value="__pick__">选择其他文件夹…</option>'}</select></label><span class="canvas-switch-divider"></span><select data-canvas-board-select>${canvasState.canvasList.map((item) => `<option value="${esc(item.name)}" ${item.name === canvasState.canvasName ? "selected" : ""}>${esc(item.title || item.name)}</option>`).join("")}</select><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-new>新建画布</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-delete>删除当前</button></div></div><div class="canvas-head-actions"><button class="ui-btn ui-btn--brand ui-btn--sm" data-canvas-starter>${ic("sparkles")}新建短剧工作流</button><button class="ui-btn ui-btn--outline ui-btn--sm" data-canvas-agent>${ic("bot")}Agent</button><button class="ui-btn ui-btn--outline ui-btn--sm" data-canvas-fullscreen>全屏</button><button class="ui-btn ui-btn--outline ui-btn--sm" data-canvas-save>${ic("save")}保存</button></div></div>
    <section class="canvas-progress" id="canvas-progress" hidden aria-label="短剧制片进度"></section>
    <div class="canvas-toolbar"><span class="canvas-tool-cluster" aria-label="画布创作工具">
      <details class="canvas-node-menu"><summary title="添加节点" aria-label="添加节点"><span class="canvas-menu-label">${ic("plus")}</span></summary><div class="canvas-node-menu-body">${groupedMenu}</div></details>
      <details class="canvas-library"><summary title="打开素材" aria-label="打开素材"><span>${ic("folder-open")}</span></summary><div class="canvas-library-panel"><div class="canvas-library-tools"><input id="canvas-library-search" type="search" placeholder="搜索工作区素材…" /><select id="canvas-library-kind" aria-label="素材类型"><option value="all">全部类型</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select><select id="canvas-library-role" aria-label="素材用途"><option value="all">全部用途</option><option value="定妆照">定妆照</option><option value="首帧">首帧</option><option value="镜头">镜头</option><option value="配音">配音</option><option value="场景图">场景图</option><option value="其他">其他</option></select><label class="canvas-library-toggle" title="只看没有任何镜头或节点在用的素材"><input type="checkbox" id="canvas-library-orphan"><span>没人用</span></label><button class="canvas-tool-button" type="button" title="刷新素材" aria-label="刷新素材" data-library-refresh>${ic("refresh-cw")}</button></div><div id="canvas-library-items" class="canvas-library-items"><div class="canvas-library-empty">正在读取工作区素材…</div></div></div></details>
      <span class="canvas-tool-divider"></span>
      <button class="canvas-tool-button" type="button" data-canvas-history="undo" title="撤销（Ctrl/Cmd+Z）" aria-label="撤销">${ic("rotate-ccw")}</button>
      <button class="canvas-tool-button is-redo" type="button" data-canvas-history="redo" title="重做（Ctrl/Cmd+Shift+Z）" aria-label="重做">${ic("rotate-ccw")}</button>
      <button class="canvas-tool-button" type="button" data-canvas-layout title="按生成关系自动排版" aria-label="自动排版">${ic("git-branch")}</button>
      <button class="canvas-tool-button" type="button" data-canvas-marquee title="框选：拖出一个框，碰到的节点都选中（不开这个开关时按住 Shift 拖也一样）。Shift/⌘ 点节点加选减选，Delete 删除" aria-label="框选">${ic("square-dashed")}</button>
    </span><span class="canvas-zoom-box"><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-zoom="out">−</button><span id="canvas-zoom">100%</span><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-zoom="in">+</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-fit>适配</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-center>居中</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-zoom="reset">${ic("target")}复位</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-clear>清空</button></span></div>
    <div class="canvas-layout"><div id="canvas-viewport" class="canvas-viewport"><div id="canvas-world" class="canvas-world"></div></div><aside id="canvas-inspector" class="canvas-inspector"></aside></div>
    <section class="canvas-chat" aria-label="画布 Agent 对话"><div class="canvas-chat-head"><div><b>画布 Agent</b><small>直接对话，让 Agent 读取、添加、连接和生成节点</small></div><span>本项目内执行</span></div><div id="canvas-chat-log" class="canvas-chat-log"><div class="canvas-chat-message is-agent"><span class="canvas-chat-role">Agent</span><span class="canvas-chat-text">输入 @ 可引用画布节点或工作区素材。</span></div></div><div id="canvas-chat-mention-menu" class="canvas-chat-mention-menu" hidden></div><div class="canvas-chat-compose"><div id="canvas-chat-ref-chips" class="canvas-chat-ref-chips"></div><textarea id="canvas-chat-input" rows="2" placeholder="描述人物关系、交互动作和镜头；输入 @ 添加人物、背景、风格或首尾帧"></textarea><div class="canvas-chat-tools"><button class="canvas-chat-tool" type="button" data-canvas-chat-attach title="上传文件到当前工作文件夹">${ic("paperclip")}</button><input type="file" data-canvas-chat-file accept="image/*,video/*,audio/*" multiple hidden><button class="canvas-chat-tool" type="button" data-canvas-chat-mention title="引用画布节点或素材">@</button><div class="canvas-chat-tools-spacer"></div><select class="canvas-chat-mode" data-canvas-chat-mode title="执行模式"></select><select class="canvas-chat-model" data-canvas-chat-model title="模型"><option value="">默认模型</option></select><button class="canvas-chat-send" type="button" title="发送（Enter）" aria-label="发送" data-canvas-chat-send>${ic("arrow-up")}</button></div></div></section>`;
  await canvasLoadBoards(); const remote = await canvasLoadRemote(); const world = page.querySelector("#canvas-world"), J = typeof joint !== "undefined" ? joint : null;
  // 读不出来就到此为止。再往下一行 JointJS 就起来了，起来就会铺底、就会自动保存
  if (canvasState.remoteBroken) { canvasRenderBroken(page, world); return; }
  if (!J || !J.dia || !J.dia.Paper) { world.innerHTML = '<div class="canvas-empty">画布组件加载失败，请刷新页面。</div>'; return; }
  canvasState.graph = new J.dia.Graph({}, { cellNamespace: J.shapes });
  canvasState.paper = new J.dia.Paper({ el: world, model: canvasState.graph, width: 2400, height: 1600, gridSize: 16, drawGrid: { name: "dot", args: { color: "var(--owb-text-3)", thickness: 1, gap: 22 } }, background: { color: "transparent" }, cellViewNamespace: J.shapes, interactive: { elementMove: true, linkMove: false, labelMove: false, addLinkFromMagnet: false } });
  canvasBindViewport(page); canvasState.graph.on("change:position", canvasPersist); canvasState.graph.on("remove", canvasPersist);
  // 连线动了 → 分镜表里那一镜的 cast 也得跟着动。收在图上而不是收在 canvasConnect 里：
  // 在画布上直接拖一条线出来根本不走 canvasConnect，只走图的 add。
  // 攒一小下再发：删掉一个角色节点会连带掀掉它身上十二条线，一条一条发就是十二条红
  const castQueue = new Set();
  const castWatch = (cell) => {
    if (canvasState.bulk || canvasState.suspendSync) return;
    if (!cell || typeof cell.isLink !== "function" || !cell.isLink()) return;
    const id = canvasEndpointId(cell.get("target")); if (!id) return;
    castQueue.add(id);
    if (canvasState.castTimer) clearTimeout(canvasState.castTimer);
    canvasState.castTimer = window.setTimeout(async () => {
      const ids = [...castQueue]; castQueue.clear(); canvasState.castTimer = null;
      const bad = [];
      for (const nodeId of ids) {
        const target = canvasState.graph.getCell(nodeId); if (!target) continue;
        const back = await canvasBoardCastSync(target); if (back) bad.push(back);
      }
      // 一次只说一条：十二镜同时回不去的时候，十二条红盖满屏幕反而没人看得清是哪一句
      if (bad.length === 1) canvasToast(bad[0], "triangle-alert", "err");
      else if (bad.length > 1) canvasToast(`${bad.length} 个镜头的出场角色没写回分镜表（${bad[0].slice(0, 80)}）`, "triangle-alert", "err");
    }, 120);
  };
  canvasState.graph.on("add", castWatch); canvasState.graph.on("remove", castWatch);
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
  page.querySelector("[data-canvas-board-select]").onchange = async (event) => { await canvasFlushRemoteWrite(); canvasState.canvasName = event.target.value || "main"; try { localStorage.setItem("openworkbuddy.canvas.name", canvasState.canvasName); } catch {} renderCanvasPage(); };
  page.querySelector("[data-canvas-workspace-select]")?.addEventListener("change", (event) => canvasSwitchWorkspace(event.target.value));
  page.querySelector("[data-canvas-new]").onclick = canvasCreateBoard;
  page.querySelector("[data-canvas-delete]").onclick = canvasDeleteBoard;
  // 工具条上那个「框选」开关。只有 Shift+拖 这一条路的时候没人会去试：
  // 空白处拖出来的默认动作是平移，试一次以为不支持，就不会有第二次。
  const marqueeBtn = page.querySelector("[data-canvas-marquee]");
  if (marqueeBtn) {
    const syncMarquee = () => {
      marqueeBtn.classList.toggle("is-active", canvasState.marqueeMode);
      marqueeBtn.setAttribute("aria-pressed", canvasState.marqueeMode ? "true" : "false");
      page.querySelector("#canvas-viewport")?.classList.toggle("is-marquee", canvasState.marqueeMode);
    };
    marqueeBtn.onclick = (evt) => { evt.preventDefault(); canvasState.marqueeMode = !canvasState.marqueeMode; syncMarquee(); };
    syncMarquee();
  }
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
  canvasRenderChatModeSelect();
  canvasSyncChatSendButton();
  const full = page.querySelector("[data-canvas-fullscreen]"), updateFullscreenLabel = () => { if (full) full.textContent = document.fullscreenElement === page ? "退出全屏" : "全屏"; };
  canvasState.fullscreenHandler = updateFullscreenLabel; document.addEventListener("fullscreenchange", updateFullscreenLabel);
  full.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (page.requestFullscreen) await page.requestFullscreen();
      else if (page.webkitRequestFullscreen) page.webkitRequestFullscreen();
      else canvasToast("当前窗口不支持全屏模式。", "info", "err");
    } catch (error) { canvasToast(`进入全屏失败：${String(error.message || error).slice(0, 120)}`, "circle-x", "err"); }
  };
  updateFullscreenLabel();
  page.querySelector("[data-library-refresh]").onclick = (evt) => { evt.preventDefault(); canvasLoadLibrary(); };
  page.querySelector("#canvas-library-search").oninput = canvasRenderLibrary;
  page.querySelector("#canvas-library-kind").onchange = canvasRenderLibrary;
  page.querySelector("#canvas-library-role").onchange = canvasRenderLibrary;
  page.querySelector("#canvas-library-orphan").onchange = canvasRenderLibrary;
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
  // 整份传进去，别在这儿把「空的」换成 null：那样里头就只剩「现在是空的」可看，
  // 而「服务器上那份是空的、但早就有人动过」正是不该再铺起手卡的那种
  canvasRestoreOrSeed(remote); canvasHistoryReset(canvasSnapshot()); canvasStartRemoteSync();
  window.setTimeout(() => canvasFitAll(page), 0);
  canvasLoadLibrary();
}
