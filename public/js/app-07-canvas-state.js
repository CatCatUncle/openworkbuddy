/* 无限画布 · 状态与节点数据（第 1 片，最先加载）
 *
 * 存储键、节点和连线的定义表、全局画布状态，以及读写节点数据的小工具：
 * 节点类型、默认内容、素材路径和地址、生成结果的文件名与版本号。
 * 后面几片都用到这里的常量和画布状态，所以它排第一。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
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
// 「两边都改了、人还没选」这件事也得记在本机（见 canvasSavePendingConflict）
function canvasConflictStoreKey(scope = canvasScope()) { return `${CANVAS_STORAGE_KEY}.conflict:${scope}`; }

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
  // 正在生成的节点 id。生一张图几十秒，这期间远端那份每 1.8 秒来一趟、整图重铺——
  // 铺的时候这几个节点留本机这份，不然刚写上的结果被一份旧快照盖回去（见 canvasApplySnapshot）
  inflight: new Set(),
  // 乐观并发：remoteBase 是「我上一次跟盘上对齐时的那一份」{ scope, at, snapshot }。
  // 往上写带 at 当 baseUpdatedAt，盘上已经不是它了就 409；snapshot 用来判「哪边改了哪个节点」。
  // remotePushing 把写入排成一队（两枪并发，第二枪拿着旧 base 必撞 409）；
  // remoteConflict 有值 = 同一个节点两边都改了、正等人选，这期间不写也不拉
  remoteBase: null, remotePushing: null, remoteConflict: null,
  // 发出去过的版本号（见 canvasNextVersion）和 shot-history 快照的缓存（见 canvasHistoryVersions）
  versionTaken: new Map(), shotHistory: new Map(),
  // 正在出分镜草稿的剧本卡 id（卡上按钮变「生成中…」、不许再点）；
  // seedDrama 是「新建短剧」表单填的那几项，等新画布铺好后塞进那张剧本卡（见 canvasRestoreOrSeed）
  drafting: new Set(), seedDrama: null,
  // 底部时间线（见 canvasRenderTimeline）：timelineOpen 为 null = 按本机记下的开合来；
  // playback 是正在连播的那一趟，null = 没在放；find 是 ⌘F 那条搜索的命中和走到第几个
  timelineOpen: null, timelineTimer: null, timelineChatObserver: null, castOpen: false, playback: null, find: null, findHandler: null,
};

// 夹着数字的句子：词条按「{n}」模板收，先查词典再把数塞进去。塞完再交给界面，
// 整句查词典那条路就查不到了（「重试失败的 3 条」不在词典里）
function canvasT(zh, params) {
  if (typeof I18N !== "undefined" && I18N.t) return I18N.t(zh, params);
  return String(zh).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
}

/**
 * action = { label, run, params }：在这条提示上挂一颗按钮（「撤销」「重试失败的 2 条」）。
 * 全局那个 toast 只会摆一段字，按钮是摆完再接上去的；下一条提示一来整个换掉，按钮跟着没——
 * 这正是想要的：它只对「刚才那件事」有效，后面又发生了别的事就不该还点得到。
 */
function canvasToast(text, icon, kind, action) {
  if (typeof toast !== "function") { console[kind === "err" ? "error" : "log"](text); return; }
  const out = toast(text, icon || (kind === "err" ? "circle-x" : "circle-check"));
  const box = action && typeof document !== "undefined" ? document.getElementById("owb-toast") : null;
  if (!box) return out;
  const label = canvasT(action.label, action.params);
  const button = document.createElement("button");
  button.type = "button"; button.className = "owb-toast-act"; button.textContent = label;
  button.addEventListener("click", () => { box.classList.remove("show"); button.remove(); action.run(); });
  box.appendChild(button);
  // 带按钮的多留一会儿：人得读完这句、再决定点不点。2.2 秒够读字，不够伸手
  try { clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove("show"), 8000); } catch {}
  return out;
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
function canvasOutputFilename(payload, kind, nodeKind = "", version = 0) {
  const p = payload || {}, clean = (v, fb) => String(v || "").replace(/[^\w\-一-龥]+/g, "_") || fb;
  // 定妆照、场景图得按素材台账认得出的前缀落盘：台账的「用途」是按文件名判的，
  // 名字起错了，生成完在界面上会掉进「其他」，回头人找都找不着。
  if (nodeKind === "character") return `角色_${clean(p.name || p.title, "角色")}_定妆.png`;
  if (nodeKind === "location") return `场景_${clean(p.name || p.title, "场景")}.png`;
  // 镜头的产物带版本号：重跑一次就是 v2，不再把 v1 盖掉——盖掉了就没有「回到上一版」可言。
  // 不给 version（或给 0）还是老名字，老画布上那些没带号的文件照样认得（算作 v0）
  const id = clean(p.id || p.title, "镜头"), v = Number(version) > 0 ? `_v${Math.floor(Number(version))}` : "";
  return kind === "image" ? `镜头_${id}_首帧${v}.png` : kind === "video" ? `镜头_${id}${v}.mp4` : `配音_${id}${v}.mp3`;
}

/**
 * 这张画布的产物落到哪个子目录：跟服务端 canvasAssetNear 同一个口径（短剧/<画布名>），
 * 画布名的清洗照抄 tools.js 的 canvasSafeName——两边算出来不一样，素材台账就对不上号。
 * 服务端 toolRunSubdir 会拒掉带「..」或控制字符的段；这种名字干脆不带 subdir，
 * 落回工作区根目录，也别让一次花钱的生成因为目录名被拒
 */
function canvasOutputSubdir(name) {
  let n = String(name || "main").trim();
  if (!n || n === "." || n === ".." || n.length > 80 || /[\\/\0]/.test(n)) n = "main";
  if (n.includes("..") || /[\0-\x1f\x7f]/.test(n)) return "";
  return `短剧/${n}`;
}
// 镜头节点上三类产物各落在哪个字段
function canvasOutputField(kind) {
  return kind === "image" ? "first_frame" : kind === "video" ? "video" : "audio";
}
/**
 * 一个文件是不是「这一镜这一类」的产物，是的话第几版。
 * 老名字（不带 _vN）算 v0；对不上这一镜的名字返回 -1。只看文件名，不看目录：
 * 老画布的产物落在工作区根目录，新的落在「短剧/画布名」下，都是这一镜的历史
 */
function canvasVersionOf(file, payload, kind) {
  const base = String(file || "").split(/[?#]/)[0].split(/[\\/]/).pop();
  const want = canvasOutputFilename(payload, kind, "shot");
  // 不分大小写：mac、Windows 的盘上「镜头_s1-01」和「镜头_S1-01」是同一个文件，认不出来就会发一个撞上的号
  if (!base) return -1;
  if (base.toLowerCase() === want.toLowerCase()) return 0;
  const dot = want.lastIndexOf("."), stem = want.slice(0, dot), ext = want.slice(dot);
  const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^${quote(stem)}_v(\\d+)${quote(ext)}$`, "i").exec(base);
  return m ? Number(m[1]) : -1;
}
/**
 * 这一镜这一类已有哪些版本：节点上挂着的、生成记录里的、素材台账（本画布子目录）里的、
 * 制片进度里这一镜认到的，按路径去重。每行 { rel, version }，按版本号从小到大。
 * 这几份清单都可能缺（沙盒里、台账还没读到），缺哪份就少看哪份，不许抛
 */
function canvasOutputVersions(payload, kind, node, board) {
  const p = payload || {}, field = canvasOutputField(kind), rows = new Map();
  const add = (rel, extra) => {
    const r = String(rel || "").trim();
    if (!r || /^(https?:|data:)/i.test(r)) return;
    const version = canvasVersionOf(r, p, kind);
    if (version < 0) return;
    rows.set(r, { ...(rows.get(r) || {}), ...(extra || {}), rel: r, version });
  };
  add(p[field]);
  for (const run of Array.isArray(p.generation_runs) ? p.generation_runs : []) {
    if (!run || run.kind !== kind) continue;
    add(run.output); add(run.replaced);
  }
  const state = typeof canvasState === "object" && canvasState ? canvasState : {};
  const dir = canvasOutputSubdir(board);
  const assets = state.assets && Array.isArray(state.assets.assets) ? state.assets.assets : [];
  for (const row of assets) {
    const rel = String((row && row.name) || "");
    if (dir && rel.slice(0, rel.lastIndexOf("/")) === dir) add(rel, row.ambiguous ? { ambiguous: true } : null);
  }
  const shots = state.progress && Array.isArray(state.progress.shots) ? state.progress.shots : [];
  const slot = kind === "image" ? "frame" : kind;
  for (const row of shots) {
    if (!row || !((node && String(row.nodeId || "") === String(node.id)) || (p.id && row.id === p.id))) continue;
    const hit = row[slot];
    if (!hit || typeof hit !== "object") continue;
    // 同名好几份时服务端不替人挑，rel 是空的、候选都在 ambiguous 里：每一份都列出来，让人自己点
    if (Array.isArray(hit.ambiguous) && hit.ambiguous.length) hit.ambiguous.forEach((rel) => add(rel, { ambiguous: true }));
    else add(hit.rel || hit.path, hit.ambiguous ? { ambiguous: true } : null);
  }
  return [...rows.values()].sort((a, b) => a.version - b.version || a.rel.localeCompare(b.rel));
}
/**
 * 下一枪用第几版：已有的最大版本 + 1，最小是 1。
 * 台账是生成完才重读的，连点两下时它还没看见上一枪的文件——所以这里把发出去的号记一笔，
 * 同一张画布同一个名字，发过的号不再发第二次，不然两枪写进同一个文件
 */
function canvasNextVersion(payload, kind, node, board) {
  const state = typeof canvasState === "object" && canvasState ? canvasState : {};
  const want = canvasOutputFilename(payload, kind, "shot");
  const key = `${state.workspaceName || ""}::${board || "main"}\n${want.toLowerCase()}`;
  const taken = state.versionTaken instanceof Map ? state.versionTaken : null;
  const seen = canvasOutputVersions(payload, kind, node, board).reduce((max, row) => Math.max(max, row.version), 0);
  const next = Math.max(seen, taken ? Number(taken.get(key)) || 0 : 0) + 1;
  if (taken) taken.set(key, next);
  return next;
}

/**
 * 这一枪的「参数指纹」：同一个指纹 = 同样的输入，再生成一遍就是白花钱（③ 默认复用）。
 *
 * 口径尽量贴着服务端 gen-cache 的缓存键：工具、模型、除 filename / no_cache 外的全部输入、落在哪个子目录。
 * 模型没点名时按设置里这一路的默认模型算——人在设置里换了默认模型，指纹就变，不会拿旧模型的图冒充。
 * 参考图 / 首尾帧只写了路径，路径不变文件却可能被换过（定妆照重生成是同名覆盖），
 * 所以台账里有这个文件就把大小和修改时间一起算进去。台账没读到就只认路径。
 * 存进 generation_runs 的是哈希不是原文：提示词动辄上千字，一镜留 12 条记录会把画布文件撑大
 */
function canvasSigHash(text) {
  // cyrb53：53 位，够一张画布用；不引库
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
// own：节点上现在挂着的这一版。镜头重生成首帧时会把自己的首帧当参考图递进去（保人物/构图不跳），
// 这张图每生一次就换一个文件名，算进指纹的话第二次点永远对不上，默认复用就成了摆设——所以从参考图里剔掉
function canvasInputSig(tool, input, subdir, own) {
  const state = typeof canvasState === "object" && canvasState ? canvasState : {};
  const tail = (v) => String(v || "").split(/[?#]/)[0];
  const self = own ? tail(own) : "";
  const src = input && typeof input === "object" ? input : {};
  const cap = tool === "text_to_speech" ? "tts" : tool === "generate_video" ? "video" : "image";
  const cache = typeof settingsCache !== "undefined" ? settingsCache : null;
  const models = Array.isArray(cache?.media_models) ? cache.media_models.filter((m) => m && m.cap === cap) : [];
  const def = models.find((m) => m.default) || models[0];
  const rows = state.assets && Array.isArray(state.assets.assets) ? state.assets.assets : [];
  const stamp = (v) => {
    const rel = String(v || "");
    const row = rel && rows.find((r) => r && String(r.name || "") === rel);
    return row ? `${rel}|${row.size || ""}|${row.mtime || ""}` : rel;
  };
  const out = { tool: String(tool || ""), model: String(src.model || (def ? def.model || def.name : "") || ""), subdir: String(subdir || "") };
  for (const k of Object.keys(src).sort()) {
    if (k === "filename" || k === "no_cache" || k === "model") continue;
    const v = src[k];
    out[k] = k === "reference_images" && Array.isArray(v) ? v.filter((r) => !self || tail(r) !== self).map(stamp) : k === "first_frame" || k === "last_frame" ? stamp(v) : v;
  }
  return canvasSigHash(JSON.stringify(out));
}
// 节点上这一类产物现在挂在哪个字段：镜头按首帧/视频/配音分，定妆照在 reference，场景图在 image，素材节点在 path
function canvasCurrentOutput(payload, kind, nodeKind) {
  const p = payload || {};
  if (nodeKind === "shot") return String(p[canvasOutputField(kind)] || "");
  if (nodeKind === "character") return String(p.reference || "");
  if (nodeKind === "location") return String(p.image || "");
  return String(p.path || p.url || "");
}
/**
 * 同一个指纹之前生过没有、那一份还在不在：
 * - { same: 当前这份 }：节点上挂着的就是同参数生的，直接沿用，什么都不发；
 * - { same: 老的某一版 }：这一镜以前用同样的参数生过、文件还在（改了提示词又改回来），换回那一版，也不发；
 * - null：没有同参数的产物，照常开枪。
 * 「在不在」按 canvasMediaAvailable 的口径：没问过盘就认在，盘说没了才算没了
 */
function canvasReuseTarget(payload, kind, sig, nodeKind) {
  const p = payload || {};
  if (!sig) return null;
  const state = typeof canvasState === "object" && canvasState ? canvasState : {};
  const tail = (v) => String(v || "").split(/[?#]/)[0];
  // 制片进度问过盘、明说这个路径没了（ok:false）：卡片上写着也不算在。不然一键补齐挑出来的
  // 「首帧文件丢了」那几镜一枪不发就报做好了，下回打开还是缺
  const pr = state.progress || {};
  const cells = [...(Array.isArray(pr.shots) ? pr.shots : []).flatMap((r) => (r ? [r.frame, r.video, r.audio] : [])),
    ...(Array.isArray(pr.cast) ? pr.cast : []).map((r) => r && r.image)];
  const lost = (v) => cells.some((c) => c && typeof c === "object" && c.ok === false && tail(c.path) === tail(v));
  const has = (v) => !!v && !lost(v) && (typeof canvasMediaAvailable !== "function" || canvasMediaAvailable(v));
  const current = canvasCurrentOutput(p, kind, nodeKind);
  const all = (Array.isArray(p.generation_runs) ? p.generation_runs : []).filter((run) => run && run.kind === kind && run.output);
  const runs = all.filter((run) => run.sig === sig);
  if (!runs.length) return null;
  // 卡上这一份是不是按这组参数生的，要看「最后一次写到这个文件的那一枪」：定妆照 / 场景图同名覆盖，
  // A 生过、改成 B 又生（文件被 B 覆盖）、再改回 A——A 那条记录还指着这个文件名，里面却已经是 B 的图
  const lastHere = current ? [...all].reverse().find((run) => tail(run.output) === tail(current)) : null;
  if (lastHere && lastHere.sig === sig && has(current)) return { same: current, current: true };
  // 定妆照 / 场景图是同名覆盖的，老记录指着的那个文件早就不是那张图了；带号的产物才各占一个文件
  if (nodeKind === "character" || nodeKind === "location") return null;
  // 老版本没挂在任何节点上，「没问过盘就认在」那条口径管不到它：得在工作区清单或素材台账里真看得见才算在
  const listed = new Set([
    ...(Array.isArray(state.files) ? state.files.map((f) => String((f && (f.name || f.path)) || "")) : []),
    ...(state.assets && Array.isArray(state.assets.assets) ? state.assets.assets.map((r) => String((r && r.name) || "")) : []),
  ].filter(Boolean));
  const resolve = (v) => (typeof canvasResolvedFileName === "function" ? canvasResolvedFileName(v) : v);
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const out = runs[i].output;
    if (tail(out) !== tail(current) && (listed.has(tail(out)) || listed.has(resolve(tail(out)))) && has(out)) return { same: out, current: false };
  }
  return null;
}

function canvasDefaultPayload(kind) {
  switch (kind) {
    case "script": return { title: "新剧本", text: "一句话概念、人物关系、冲突与结局…" };
    case "agent": return { title: "Agent任务", role: "导演 Agent", task: "根据上游剧本和素材生成可审核的短剧创作计划。", status: "待执行", approval: "先给方案，等我确认" };
    case "character": return { name: "新角色", role: "主角", description: "人物外形、性格、目标与关系…", reference: "", voice: "" };
    case "location": return { name: "新场景", description: "地点、时间、天气、光线与氛围…" };
    // 卡面上那句「短剧分镜」是写死的，所以画布上看着没毛病；掉进 default 分支的是 payload。
    // 于是这张卡在「连接到下游节点…」那个下拉里叫「新笔记」，交给 Agent 的正文也是
    // 「记录灵感、任务或需要补充的内容…」——起手模板铺出来的那张就是这样
    case "storyboard": return { board: "" };
    case "shot": return { id: "S1-01", title: "新镜头", shot_size: "中景", duration: "4", prompt: "镜头内容与运动…", motion_prompt: "", line: "对白或旁白…", speaker: "" };
    case "image": return { title: "参考图", url: "", role: "参考素材", tags: "", prompt: "这张图要保持的主体、风格与构图…" };
    case "video": return { title: "Video", url: "", role: "生成结果", tags: "", prompt: "描述你想生成的内容…", model: "", aspect_ratio: "16:9", resolution: "1080p", duration: "5s" };
    case "audio": return { title: "声音", url: "", role: "对白/音乐", tags: "", text: "对白、旁白或音乐说明…", voice: "" };
    case "timeline": return { title: "最终剪辑", description: "把镜头按顺序交给本项目 Agent 生成时间线。" };
    case "scene": return { id: "S1", place: "未命名场景", time: "" };
    default: return { title: "新笔记", text: "记录灵感、任务或需要补充的内容…" };
  }
}
