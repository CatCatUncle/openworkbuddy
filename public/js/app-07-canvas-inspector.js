/* 无限画布 · 节点交互与检查器（第 6 片）
 *
 * 开头是统一画风和选模型那几个小工具：生成、展开分镜表、预估花费都用它们。
 * 然后是节点卡片上的按钮和拖拽、分镜表展开成画布、镜头编号查重、加节点，
 * 右侧检查器，以及素材面板。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
 */
/**
 * 统一风格：这一镜该用哪段画风。只管镜头卡——定妆照、场景图是参考图，套上画风反而把人脸和地方带偏。
 * 展开时盖上的 board_style 最准（那就是分镜表的 style）；挂在分镜表上、表里却没写风格，就是没有风格，
 * 不拿画布那层的去凑。手搓的镜头才退回「新建短剧」时填的那段（canvasDramaSettings）。
 * 这几个函数夹在 canvasGenerate 和 canvasBindNode 之间，测试按这一段切源码进沙箱——沙箱里没有
 * canvasDramaSettings，所以只能 typeof 着用
 */
function canvasShotStyle(p, nodeKind) {
  if (nodeKind !== "shot" || !p) return "";
  const own = String(p.board_style || "").trim();
  if (own || String(p.board || "").trim()) return own;
  const drama = typeof canvasDramaSettings === "function" ? canvasDramaSettings() : null;
  return String((drama && drama.style) || "").trim();
}
/**
 * 把画风摆到提示词最前面。展开出来的首帧提示词尾巴上已经接了一遍画风（canvasBoardPlan 的老口径，
 * 回表和测试都钉着），这里先剥掉尾巴再放到开头，免得一句话里说两遍。
 * 已经以画风开头的不再加；除了画风什么都没写的，原样交回去——凭一段画风生不出这一镜
 */
function canvasStyledPrompt(text, style) {
  const body = String(text || "").trim();
  if (!style || !body) return body;
  const tail = "\n" + style;
  const core = body === style ? "" : body.endsWith(tail) ? body.slice(0, body.length - tail.length).trim() : body;
  if (!core) return body;
  return core.startsWith(style) ? core : style + "\n" + core;
}
// 生成用哪个模型：卡上自己选了的最大；没选就用「新建短剧」时定的；都没有就不带，服务端按设置里的走。
// 「新建短剧」定的只管这部戏的卡（镜头、角色、场景）：通用图片 / 视频卡的检查器写的是「跟随设置默认模型」，
// 拿短剧那个去跑就是说一套做一套
function canvasDramaModel(p, kind, nodeKind) {
  if (p && p.model) return String(p.model);
  if (kind !== "image" && kind !== "video") return "";
  if (nodeKind !== "shot" && nodeKind !== "character" && nodeKind !== "location") return "";
  const drama = typeof canvasDramaSettings === "function" ? canvasDramaSettings() : null;
  return String((drama && (kind === "image" ? drama.imageModel : drama.videoModel)) || "");
}

function canvasBindNode(node, root) {
  root.querySelector("[data-canvas-remove]")?.addEventListener("click", async (evt) => { evt.preventDefault(); evt.stopPropagation(); if (!(await askConfirm({ title: `删掉节点「${canvasNodeLabel(node)}」？`, hint: "挂在它身上的连线也会一起删掉。", ok: "删掉", danger: true }))) return; if (canvasState.selected === node.id) { canvasState.selected = null; canvasRenderInspector(); } node.remove(); canvasPersist(); });
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
  root.querySelector("[data-canvas-draft]")?.addEventListener("click", (evt) => { evt.preventDefault(); evt.stopPropagation(); canvasDraftStoryboard(node); });
  root.querySelectorAll("[data-canvas-inline-key]").forEach((field) => field.addEventListener("input", () => { const next = canvasPayload(node); next[field.dataset.canvasInlineKey] = field.value; node.set("canvasPayload", next); canvasPersist(); }));
  root.querySelector("[data-canvas-expand]")?.addEventListener("click", async (evt) => {
    evt.preventDefault(); evt.stopPropagation(); const select = root.querySelector("[data-canvas-board]"), name = select && select.value; if (!name) return;
    const button = evt.currentTarget; button.disabled = true; button.textContent = "加载中…";
    try {
      const r = await fetch("/api/drama/storyboard?name=" + encodeURIComponent(name)).then((x) => x.json());
      if (!r || !r.data) throw new Error(r && r.error || "分镜表读取失败");
      const stat = canvasApplyBoardPlan(node, canvasBoardPlan(r.data, name));
      // 顺手记下这份表的风格：检查器里「统一风格」那一栏读的就是它，改了再写回表（见 canvasBoardStyleSync）
      node.set("canvasPayload", { ...canvasPayload(node), board: name, style: String(r.data.style || "").trim() });
      button.textContent = `已展开 ${stat.scenes} 场`;
      canvasPersist();
      // 摆完顺手整理一次：按固定格子摆的新卡会压在旧卡上（尤其是再展开一次、场次数变了的时候）。
      // 整理自己也会弹一句，所以放在下面那条结果提示前面，留在屏幕上的是结果
      if (typeof canvasAutoLayout === "function") canvasAutoLayout(document.getElementById("assist-page"));
      if (stat.missing.length) canvasToast(`展开了 ${stat.scenes} 场 ${stat.shots} 镜 ${stat.characters} 个角色。${stat.missing.length} 个角色 id 在 characters 里查无此人：${stat.missing.join("、")}，相关镜头将缺定妆照参考、用默认音色。`, "triangle-alert", "err");
      else canvasToast(`展开了 ${stat.scenes} 场 ${stat.shots} 镜 ${stat.characters} 个角色，定妆照和音色顺着连线走。`, "circle-check");
    } catch (e) { button.disabled = false; button.textContent = "展开场次与镜头"; canvasToast(`分镜节点展开失败：${String(e.message || e).slice(0, 140)}`, "circle-x", "err"); }
  });
  const edit = root.querySelector(".canvas-note-edit"); edit?.addEventListener("pointerdown", (evt) => evt.stopPropagation());
  edit?.addEventListener("input", () => { node.set("canvasPayload", { ...canvasPayload(node), text: edit.textContent || "" }); canvasRenderInspector(false); canvasPersist(); });
  // 换了一份表，上一份的风格作废（检查器里那一栏读的是它），再去读新那份的
  root.querySelector("[data-canvas-board]")?.addEventListener("change", (evt) => { const next = { ...canvasPayload(node), board: evt.target.value }; delete next.style; node.set("canvasPayload", next); canvasRenderInspector(false); canvasPersist(); if (typeof canvasBoardStyleLoad === "function") canvasBoardStyleLoad(node).catch(() => {}); });
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
    // 场次卡上只放这一场自己的字段。以前整份 shots 原样抄进来：镜头卡改了、删了它不知道，
    // 画布存盘每一镜的字存两遍；再展开一次还按这份抄本去比，越比越乱。镜头是挂在它右边的那几张卡
    payload: {
      ...Object.fromEntries(Object.entries(scene || {}).filter(([k]) => k !== "shots")),
      ...(from ? { board: from, board_scene: String((scene && scene.id) || "").trim() } : {}),
    },
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
  let shots = 0, updated = 0;
  // 同一份分镜表再展开一次（改了分镜表回来同步、手滑多点一下）：按戳找已经摆着的卡，
  // 找到了只更新字段、不再建一张。以前每点一次整套角色、场次、镜头各多一份，
  // 生过的首帧挂在旧卡上，新卡全是空的，进度条也跟着把镜头数翻倍。
  // 没盖戳的计划（没说是哪份分镜表）没法认亲，照旧新建
  const graph = canvasState.graph;
  const existing = (graph && typeof graph.getElements === "function" ? graph.getElements() : []).slice();
  const stamp = (kind, p) => !p || !p.board ? ""
    : kind === "character" ? `${p.board}\n${p.board_character || ""}`
      : kind === "scene" ? `${p.board}\n${p.board_scene || ""}`
        : kind === "shot" ? `${p.board}\n${p.board_scene || ""}\n${p.board_shot || ""}` : "";
  const linkedFrom = (id) => (graph && typeof graph.getLinks === "function" ? graph.getLinks() : [])
    .filter((l) => (l.get("source") || {}).id === id).map((l) => (l.get("target") || {}).id);
  // 这一趟已经认领过的卡不再认第二次：分镜表里镜头号空着或重了，几镜的戳是同一个，
  // 不记的话全都更新到第一张上去，后面几张原样摆着、字段一直是旧的
  const used = new Set();
  const claim = (n) => { if (n) used.add(n.id); return n || null; };
  const findExisting = (kind, payload) => {
    const key = stamp(kind, payload);
    if (!key) return null;
    const hit = existing.find((n) => !used.has(n.id) && canvasKind(n) === kind && stamp(kind, canvasPayload(n)) === key);
    if (hit || kind !== "scene") return claim(hit);
    // 老画布上的场次没盖过戳：认「挂在这个分镜节点下面、场次号一样」的那张
    const under = new Set(linkedFrom(node.id));
    return claim(existing.find((n) => !used.has(n.id) && canvasKind(n) === "scene" && under.has(n.id) && !canvasPayload(n).board
      && String(canvasPayload(n).id || "") === String(payload.id || "")));
  };
  // 只拿分镜表里有值的字段去盖：分镜表里空着的（还没回写的首帧、视频）不能把画布上已经生出来的抹掉
  const merge = (n, payload) => {
    const next = { ...canvasPayload(n) };
    Object.entries(payload).forEach(([k, v]) => { if (v !== "" && v != null && !(Array.isArray(v) && !v.length)) next[k] = v; });
    if (canvasKind(n) === "scene") delete next.shots;
    // 分镜表把全片画风删了（替换成没写风格的一份、或别处清掉了）：上面只盖有值的字段，老的 board_style 会留着，
    // 生成时 canvasShotStyle 认的就是它，于是照旧按老画风往提示词前面接。这里跟着摘掉，提示词尾巴上那段也剥掉
    if (canvasKind(n) === "shot" && payload.board && !payload.board_style && next.board_style) {
      const old = String(next.board_style).trim(), prompt = String(next.prompt || "").trim();
      if (prompt === old) next.prompt = "";
      else if (old && prompt.endsWith("\n" + old)) next.prompt = prompt.slice(0, prompt.length - old.length - 1).trim();
      delete next.board_style;
    }
    n.set("canvasPayload", next); canvasRefreshNode(n); updated++;
    return n;
  };
  const place = (kind, payload, position) => {
    const hit = findExisting(kind, payload);
    return hit ? merge(hit, payload) : canvasAddNode(kind, payload, position, { skipSelect: true, persist: false });
  };
  const sceneNodes = [];
  canvasState.bulk = true;
  try {
    plan.characters.forEach((item, i) => {
      const n = place("character", item.payload, { x: base.x + 420 + i * 300, y: base.y });
      if (!n) return;
      canvasConnect(node, n);
      item.keys.forEach((k) => cast.set(k, n));
    });
    plan.scenes.forEach((scene, i) => {
      const sceneNode = place("scene", scene.payload, { x: 100 + (i % 3) * 520, y: 430 + Math.floor(i / 3) * 390 });
      if (!sceneNode) return;
      sceneNodes.push(sceneNode);
      canvasConnect(node, sceneNode);
      scene.shots.forEach((shot, j) => {
        const shotNode = place("shot", shot.payload, { x: 100 + (i % 3) * 520 + 410, y: 430 + Math.floor(i / 3) * 390 + j * 295 });
        if (!shotNode) return;
        shots++; canvasConnect(sceneNode, shotNode);
        shot.cast.forEach((id) => { const c = cast.get(id); if (c) canvasConnect(c, shotNode, "character"); else missing.add(id); });
      });
    });
  } finally { canvasState.bulk = false; }
  // 场次卡上的「N 镜」数的是连出去的镜头卡，连线是建完场次之后才接上的，这会儿再画一遍
  sceneNodes.forEach((n) => canvasRefreshNode(n));
  return { characters: plan.characters.length, scenes: plan.scenes.length, shots, updated, missing: [...missing] };
}

/**
 * 新加一个镜头该叫几号。默认模板写死的是 S1-01，于是每加一张都是 S1-01——文件名是按镜头号起的，
 * 两张卡生成出来写进同一个文件，后生的把先生的盖掉。所以：取画布上编号最大的那一场，接着往下排；
 * 画布上一个像样的编号都没有，就从 S1-01 数起，被占了就往后挪
 */
function canvasNextShotId() {
  const used = new Set(), scenes = new Map();
  (canvasState.graph ? canvasState.graph.getElements() : []).forEach((item) => {
    if (canvasKind(item) !== "shot") return;
    const id = String(canvasPayload(item).id || "").trim(); if (!id) return;
    used.add(id);
    const m = /^S(\d+)-(\d+)$/.exec(id);
    if (m) scenes.set(Number(m[1]), Math.max(scenes.get(Number(m[1])) || 0, Number(m[2])));
  });
  const pad = (n) => String(n).padStart(2, "0");
  if (scenes.size) {
    const scene = Math.max(...scenes.keys());
    let n = scenes.get(scene) + 1; while (used.has(`S${scene}-${pad(n)}`)) n++;
    return `S${scene}-${pad(n)}`;
  }
  let n = 1; while (used.has(`S1-${pad(n)}`)) n++;
  return `S1-${pad(n)}`;
}
// 画布上哪些镜头号出现了不止一次：同号 = 生成时同一个文件名，谁后生谁盖掉谁
/**
 * 撞不撞号按「落到盘上是不是同一个文件名」认，不按字面：canvasOutputFilename 会把空格、斜杠这些洗成 _，
 * mac 和 Windows 的盘默认又不分大小写——「S1 01」和「S1_01」、「S1-01」和「s1-01」写的是同一个文件，
 * 字面比对认不出来，两张卡照样互相盖
 */
function canvasShotFileKey(id) {
  const raw = String(id || "").trim();
  return raw ? raw.replace(/[^\w\-一-龥]+/g, "_").toLowerCase() : "";
}
function canvasDupShotIds() {
  const count = new Map();
  (canvasState.graph ? canvasState.graph.getElements() : []).forEach((item) => {
    if (canvasKind(item) !== "shot") return;
    const id = canvasShotFileKey(canvasPayload(item).id);
    if (id) count.set(id, (count.get(id) || 0) + 1);
  });
  return new Set([...count].filter(([, n]) => n > 1).map(([id]) => id));
}
function canvasMarkDupShots() {
  if (!canvasState.graph || !canvasState.paper) return;
  const dup = canvasDupShotIds();
  canvasState.graph.getElements().forEach((item) => {
    const view = item.findView(canvasState.paper), root = view && view.el && view.el.querySelector(".canvas-joint-node");
    root?.classList.toggle("is-dup-id", canvasKind(item) === "shot" && dup.has(canvasShotFileKey(canvasPayload(item).id)));
  });
  // 检查器里那句提示也跟着翻：改编号时检查器不重画（重画会把光标弄丢），只能就地开关
  const hint = document.querySelector("[data-canvas-dup-hint]"), sel = canvasSelectedNode();
  if (hint) hint.hidden = !(sel && canvasKind(sel) === "shot" && dup.has(canvasShotFileKey(canvasPayload(sel).id)));
}

function canvasAddNode(kind, payload = {}, position, options = {}) {
  const page = document.getElementById("assist-page"), J = typeof joint !== "undefined" ? joint : null; if (!page || !canvasState.graph || !canvasState.paper || !J) return null;
  // 新加的镜头没给编号就取下一个空号；恢复存档（带 options.id）、展开分镜表（自带编号）都不动
  if (kind === "shot" && !options.id && !String((payload && payload.id) || "").trim()) payload = { ...payload, id: canvasNextShotId() };
  const def = CANVAS_NODE_DEFS[kind] || CANVAS_NODE_DEFS.note, Type = canvasType(J), n = canvasState.next++;
  const node = new Type({ id: options.id, position: position || { x: 90 + ((n - 1) % 3) * 410, y: 100 + Math.floor((n - 1) / 3) * 300 }, size: { width: def.width, height: def.height }, z: 2 });
  node.set({ canvasKind: kind, canvasPayload: { ...canvasDefaultPayload(kind), ...payload } }); canvasState.graph.addCell(node); canvasRefreshNode(node);
  if (!options.skipSelect) { canvasState.selectedAll = false; canvasState.selectedIds = new Set([node.id]); canvasState.selected = node.id; canvasState.inspectorOpen = false; canvasRenderInspector(false); }
  if (options.persist !== false) canvasPersist(); return node;
}

function canvasUpdateSelected(key, value, rerender = true) {
  canvasState.handsOnAt = Date.now();   // 同步那边看这个时间决定要不要让一让（见 canvasBusyNow）
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
  // 底部时间线那几格跟着亮：在画布上点了另一张卡，时间线上还亮着上一格，人会当成选的是那一镜
  document.querySelectorAll("#canvas-timeline .ctl-cell[data-ctl-shot]").forEach((el) => el.classList.toggle("is-selected", canvasState.selectedIds.has(el.dataset.ctlShot)));
  const layout = box.closest(".canvas-layout");
  if (!canvasState.inspectorOpen || !node || canvasState.selectedIds.size > 1) { box.innerHTML = ""; layout?.classList.add("canvas-inspector-hidden"); return; }
  layout?.classList.remove("canvas-inspector-hidden");
  const kind = canvasKind(node), p = canvasPayload(node), def = CANVAS_NODE_DEFS[kind] || CANVAS_NODE_DEFS.note; let fields = "";
  // 认不出的类型：面板上只说清楚情况，一个输入框都不给。给了就等于邀请用户改一份
  // 这个版本读不懂的数据，而且标题不能显示成 def.label（那是 note 的「画布笔记」，是假话）
  const unknownKind = !CANVAS_NODE_DEFS[kind];
  if (unknownKind) fields = `<p class="canvas-inspector-hint">当前版本不认识「${esc(kind)}」节点，无法编辑。内容已原样保留，用创建它的版本可正常打开。</p>`;
  if (kind === "note") fields = canvasField("内容", "text", p.text || "", "textarea", "记录想法、任务或素材线索");
  // 剧本卡上记着这部戏的画幅、每镜时长、统一风格（「新建短剧」时填的，见 canvasDramaOf）。
  // 生成分镜表按这几项出；手搓的镜头生首帧、生视频时把统一风格摆在提示词最前面
  if (kind === "script") {
    const drama = canvasDramaOf(p);
    fields = canvasField("标题", "title", p.title || "新剧本") + canvasField("剧本内容", "text", p.text || "", "textarea", "一句话概念、角色、冲突、对白…")
      + `<label class="canvas-inspector-field"><span>画幅</span><select data-inspect-key="aspect">${CANVAS_DRAMA_ASPECTS.map(([v, label]) => `<option value="${v}" ${v === drama.aspect ? "selected" : ""}>${label}</option>`).join("")}</select></label>`
      + canvasField("每镜时长（秒）", "shot_seconds", String(drama.shotSeconds), "number") + canvasField("统一风格", "style", drama.style, "text", "可留空，例如：冷蓝夜色，胶片颗粒");
  }
  if (kind === "agent") fields = canvasField("任务名称", "title", p.title || "Agent任务") + canvasField("Agent角色", "role", p.role || "导演 Agent") + canvasField("任务说明", "task", p.task || "", "textarea", "例如：根据剧本生成 6 个镜头并等待我审核") + canvasField("完成状态", "status", p.status || "待执行");
  if (kind === "character") fields = canvasField("角色名", "name", p.name || "") + canvasField("身份", "role", p.role || "") + canvasField("人物设定", "description", p.description || "", "textarea") + canvasField("音色", "voice", p.voice || "", "text", "配音用的音色名，全程不换，例如 alloy / nova / Cherry") + canvasFilePicker("参考图", "image/*", p.reference || "", "character-reference");
  if (kind === "location") fields = canvasField("场景名", "name", p.name || "") + canvasField("场景设定", "description", p.description || "", "textarea");
  if (kind === "storyboard") fields = `<label class="canvas-inspector-field"><span>分镜表</span><select data-inspect-board>${canvasState.boards.map((b) => `<option value="${esc(b.name)}" ${p.board === b.name ? "selected" : ""}>${esc(b.title || b.name)}</option>`).join("") || '<option value="">还没有分镜表</option>'}</select></label>`
    // 指着一份分镜表时才能改风格：改完写回那份表的 style（见 canvasBoardStyleSync）
    + (p.board ? canvasField("统一风格", "style", p.style || "", "text", "可留空，例如：冷蓝夜色，胶片颗粒") : "");
  if (kind === "scene") fields = canvasField("场次 ID", "id", p.id || "S1") + canvasField("地点", "place", p.place || "") + canvasField("时间/天气", "time", p.time || "", "text", "例如：2000年3月20日，上午，阴天");
  if (kind === "shot") fields = canvasField("镜头 ID", "id", p.id || "S1-01") + `<p class="canvas-inspector-hint canvas-dup-hint" data-canvas-dup-hint${canvasDupShotIds().has(canvasShotFileKey(p.id)) ? "" : " hidden"}>镜头号重复，生成会写到同一个文件</p>` + canvasField("标题", "title", p.title || "新镜头") + canvasField("景别", "shot_size", p.shot_size || "中景") + canvasField("时长（秒）", "duration", p.duration || "4", "number") + canvasField("首帧提示词", "prompt", p.prompt || "", "textarea", "这一镜画面长什么样：景别 + 场景 + 姿态 + 光线 + 画风") + canvasField("运镜提示词", "motion_prompt", p.motion_prompt || "", "textarea", "只写运动，如「她缓缓抬头，镜头推进」。留空用首帧提示词") + canvasField("对白/旁白", "line", p.line || "", "textarea") + canvasField("说话的角色", "speaker", p.speaker || "", "text", "连上来的角色里，这句话是谁说的——决定用谁的音色") + canvasFilePicker("拖入参考图或视频", "image/*,video/*", p.first_frame || p.reference_video || "", "shot-reference");
  if (kind === "image") fields = canvasField("名称", "title", p.title || def.label) + canvasField("素材用途", "role", p.role || "参考素材") + canvasTagField(p.tags) + canvasMediaModelField("生图模型", "image", p.model || "") + canvasAssetField("素材路径/URL（工作区）", p.url || p.path || "", kind) + canvasFilePicker("上传素材", "image/*", p.url || p.path || "", "image-media") + canvasField("生成/使用说明", "prompt", p.prompt || "", "textarea");
  if (kind === "video") fields = canvasField("名称", "title", p.title || "Video") + canvasMediaModelField("生视频模型", "video", p.model || "") + canvasField("画面比例", "aspect_ratio", p.aspect_ratio || "16:9") + canvasField("分辨率", "resolution", p.resolution || "1080p") + canvasField("时长", "duration", p.duration || "5s") + canvasAssetField("首帧（可选）", p.first_frame || "", "image", "first_frame") + canvasAssetField("尾帧（可选）", p.last_frame || "", "image", "last_frame") + canvasAssetField("参考视频（可选）", p.reference_video || "", "video", "reference_video") + canvasAssetField("已有视频（可选）", p.url || p.path || "", kind) + canvasFilePicker("上传参考视频", "video/*", p.url || p.path || "", "video-media") + canvasField("生成提示词", "prompt", p.prompt || "", "textarea");
  if (kind === "audio") fields = canvasField("名称", "title", p.title || "声音") + canvasField("素材用途", "role", p.role || "对白/音乐") + canvasTagField(p.tags) + canvasAssetField("音频路径/URL（工作区）", p.url || p.path || "", "audio") + canvasFilePicker("上传音频", "audio/*", p.url || p.path || "", "audio-media") + canvasField("音色", "voice", p.voice || "", "text", "留空就用设置里配的默认音色") + canvasField("对白/音乐说明", "text", p.text || "", "textarea");
  if (kind === "timeline") fields = canvasField("名称", "title", p.title || "最终剪辑") + canvasField("剪辑目标", "description", p.description || "", "textarea");
  const allNodes = canvasState.graph.getElements().filter((item) => item.id !== node.id);
  const connected = canvasState.graph.getLinks().filter((link) => link.get("source")?.id === node.id).map((link) => ({ link, target: canvasState.graph.getCell(link.get("target")?.id) })).filter((item) => item.target);
  const defaultTarget = allNodes[0], defaultRelation = defaultTarget ? canvasDefaultRelation(node, defaultTarget) : "input";
  // 每颗「生成」旁边挂一个预估价（异步填，见 canvasFillPrices）：点之前就知道这一下大概多少钱
  const price = (k) => `<small class="canvas-price" data-canvas-price="${k}"></small>`;
  const generateActions = kind === "shot" ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-generate="image">${ic("image")}生成首帧</button>${price("image")}<button class="ui-btn ui-btn--sm ui-btn--outline" data-inspect-generate="video" ${p.first_frame ? "" : "disabled"}>${ic("video")}生成视频</button>${p.first_frame ? price("video") : ""}` : ["image", "video", "audio"].includes(kind) ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-generate="${kind}">${ic(kind === "audio" ? "volume-2" : kind)}${kind === "audio" ? "生成配音" : `生成${def.label}`}</button>${price(kind)}` : "";
  // 「换一版」：同参数默认沿用上次的产物不花钱，真要一张不一样的走这里——版本号 +1、带 no_cache，照价扣费。
  // 只在已经有产物的时候出现：还没生过的，点「生成」就是新的一版
  const rerolls = kind === "shot"
    ? [p.first_frame ? ["image", "换一版首帧"] : null, p.video ? ["video", "换一版视频"] : null].filter(Boolean)
    : ["image", "video", "audio"].includes(kind) && (p.path || p.url) ? [[kind, "换一版"]] : [];
  const rerollRow = rerolls.length ? `<div class="canvas-reroll-row">${rerolls.map(([k, label]) => `<button class="ui-btn ui-btn--sm ui-btn--outline" data-inspect-reroll="${k}">${ic("refresh-cw")}${label}</button>`).join("")}<small>会重新扣费</small></div>` : "";
  // 重画之前他的光标在哪个框里、停在第几个字，重画完放回去。整块 innerHTML 一换，
  // 原来那个输入框就是个被扔掉的节点了，焦点会掉回 body——接着敲的字进了空气
  const 原焦点 = document.activeElement;
  const 要放回 = 原焦点 && box.contains(原焦点) && 原焦点.dataset && 原焦点.dataset.inspectKey
    ? { key: 原焦点.dataset.inspectKey, start: 原焦点.selectionStart, end: 原焦点.selectionEnd } : null;
  box.innerHTML = `<div class="canvas-inspector-head"><div><small>节点属性</small><h3>${esc(unknownKind ? kind : def.label)}</h3></div><button class="canvas-node-remove" data-inspect-close title="关闭设置">${ic("x")}</button></div><div class="canvas-inspector-fields">${fields}</div>${canvasGenerationInspector(p)}${canvasHistoryInspector(node)}<div class="canvas-inspector-section"><span class="canvas-inspector-section-title">工作流连接</span><div class="canvas-connect-row"><select data-connect-target><option value="">连接到下游节点…</option>${allNodes.map((item) => `<option value="${item.id}">${esc(canvasNodeLabel(item))}</option>`).join("")}</select><select data-connect-relation title="这个节点为下游提供什么">${canvasRelationOptions(defaultRelation, node, defaultTarget)}</select><button class="ui-btn ui-btn--sm ui-btn--outline" data-connect>${ic("link")}连接</button></div>${connected.length ? `<div class="canvas-connected-list">${connected.map(({ link, target }) => `<span title="${esc(canvasRelationLabel(canvasLinkRelation(link, node, target)))}">${esc(canvasRelationLabel(canvasLinkRelation(link, node, target)))} · ${esc(canvasNodeLabel(target) || "节点")}</span>`).join("")}</div>` : '<p class="canvas-inspector-hint">选择用途再连线。Agent 会把它当作真实生成输入，而不是一条装饰箭头。</p>'}</div><div class="canvas-inspector-actions">${generateActions}${["agent", "shot", "script", "scene", "storyboard", "timeline"].includes(kind) ? `<button class="ui-btn ui-btn--sm ui-btn--brand" data-inspect-agent>${ic("sparkles")}交给本项目 Agent</button>` : ""}<button class="ui-btn ui-btn--sm ui-btn--ghost canvas-inspector-delete" data-inspect-delete>删除节点</button></div>${rerollRow}`;
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
  // 换了一份表，上一份的风格作废：先清掉，再去读新那份的（读不到就空着，不留上一份的冒充）
  box.querySelector("[data-inspect-board]")?.addEventListener("change", (evt) => { const next = canvasPayload(node); delete next.style; node.set("canvasPayload", next); canvasUpdateSelected("board", evt.target.value, true); canvasBoardStyleLoad(node).catch(() => {}); });
  if (kind === "storyboard") {
    box.querySelector('[data-inspect-key="style"]')?.addEventListener("change", async () => {
      const back = await canvasBoardStyleSync(node);
      if (back) canvasToast(back, "triangle-alert", "err");
    });
    // 这份表的风格还没读过（老画布、刚在卡上换了表）：读一次再显示，免得人以为这份表没有风格、另写一段盖上去
    if (p.board && p.style == null) canvasBoardStyleLoad(node).catch(() => {});
  }
  box.querySelector("[data-connect-target]")?.addEventListener("change", (event) => {
    const target = canvasState.graph.getCell(event.target.value); const select = box.querySelector("[data-connect-relation]");
    if (target && select) select.innerHTML = canvasRelationOptions(canvasDefaultRelation(node, target), node, target);
  });
  box.querySelector("[data-connect]")?.addEventListener("click", () => { const target = canvasState.graph.getCell(box.querySelector("[data-connect-target]")?.value); canvasConnect(node, target, box.querySelector("[data-connect-relation]")?.value); canvasRenderInspector(false); });
  box.querySelector("[data-inspect-close]")?.addEventListener("click", () => { canvasState.inspectorOpen = false; canvasRenderInspector(false); });
  box.querySelector("[data-inspect-delete]")?.addEventListener("click", async () => { if (!(await askConfirm({ title: `删掉节点「${canvasNodeLabel(node)}」？`, hint: "挂在它身上的连线也会一起删掉。", ok: "删掉", danger: true }))) return; node.remove(); canvasState.selected = null; canvasState.selectedIds = new Set(); canvasRenderInspector(); canvasPersist(); });
  box.querySelectorAll("[data-inspect-generate]").forEach((button) => button.addEventListener("click", () => canvasGenerate(node, button.dataset.inspectGenerate)));
  box.querySelectorAll("[data-inspect-reroll]").forEach((button) => button.addEventListener("click", () => canvasReroll(node, button.dataset.inspectReroll)));
  canvasFillPrices(box, node).catch(() => {});
  canvasBindHistory(box.querySelector("[data-canvas-history]"), node);
  box.querySelector("[data-inspect-agent]")?.addEventListener("click", () => canvasRunInternal(node)); if (focus) box.querySelector("[data-inspect-key]")?.focus();
  if (要放回) {
    const 同一个 = box.querySelector('[data-inspect-key="' + 要放回.key.replace(/"/g, '\\"') + '"]');
    if (同一个) { 同一个.focus(); try { 同一个.setSelectionRange(要放回.start, 要放回.end); } catch {} }
  }
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
  const missingHtml = missing.length ? `<div class="canvas-library-missing"><b>${ic("triangle-alert")}${missing.length} 个引用的文件不在了</b>${missing.map((m) => `<div><span>${esc(m.base)}</span><small>${esc((m.usedBy || []).map((u) => u.title || u.id).join("、") || "有人在引用")} 还指着它</small></div>`).join("")}<small class="canvas-library-missing-tip">重跑对应镜头可重新生成，或改掉引用它的节点。</small></div>` : "";

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
