// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
/* 通用无限画布
 *
 * JointJS 只负责画布/节点/连线交互；这里负责 AI 短剧创作工作流的数据。
 * 一张画布可以同时放剧本、角色、场景、镜头、参考素材、生成结果、音频和时间线，
 * 节点数据保存到本地，节点之间的连线表示“这个输入喂给下一个创作步骤”。
 *
 * 画布按原先的先后切成几片平铺在 public/js 下，全是顶层声明，
 * 共用同一个全局作用域（普通脚本，不是模块），加载时互不调用。
 * app-03.js 的 loadCanvasDeps 按下面的顺序拉，本文件排最后：
 *   app-07-canvas-state.js      状态与节点数据
 *   app-07-canvas-viewport.js   视口：缩放、排版、键盘
 *   app-07-canvas-nodes.js      节点卡片、选中、撤销重做
 *   app-07-canvas-board.js      画布的存取、同步和冲突合并
 *   app-07-canvas-generate.js   生成、画布对话、回写分镜表
 *   app-07-canvas-inspector.js  节点交互、分镜表展开、检查器、素材面板
 *   app-07-canvas-compose.js    进度、批量补齐、合成成片、恢复
 *   app-07-canvas-timeline.js   时间线、连播、角色面板、查找
 *   app-07-canvas-workspace.js  创作入口、卡片参数、参考输入与结果衔接
 *   app-07-canvas.js            本文件：拆页时的清理和画布页入口
 * 为什么按原先的先后切、不按职责重新归堆：测试按「这个函数到那个函数」切源码，
 * 测试那边按加载顺序把几片拼回去，顺序一乱，切出来的就不是原来那一段。
 * 新功能加进对应那片；哪片都不合适就新开一片，并在 loadCanvasDeps 里挂上。
 */
function canvasDestroy() {
  if (canvasState.inlineEdit) canvasInlineCommit();
  if (canvasState.editSaveTimer && canvasState.graph) canvasPersist();
  if (canvasState.saveHandler) {
    window.removeEventListener("beforeunload", canvasState.saveHandler);
    window.removeEventListener("pagehide", canvasState.saveHandler);
    canvasState.saveHandler = null;
  }
  canvasContextMenuClose(); canvasPlaybackStop(); canvasState.compareClose?.();
  if (canvasState.languageHandler) document.removeEventListener("owb-lang", canvasState.languageHandler);
  if (canvasState.mediaModelsHandler) document.removeEventListener("owb-media-models", canvasState.mediaModelsHandler);
  canvasState.languageHandler = null;
  canvasState.workspaceObserver?.disconnect(); canvasState.workspaceObserver = null;
  canvasState.minimap?.resize?.disconnect();
  if (canvasState.minimap?.frame !== null && canvasState.minimap?.frame !== undefined) cancelAnimationFrame(canvasState.minimap.frame);
  canvasState.minimap = null;
  if (canvasState.wheelFrame !== null) cancelAnimationFrame(canvasState.wheelFrame);
  canvasState.wheelFrame = null; canvasState.wheelQueue = []; canvasState.remotePoll = null;
  for (const key of ["timelineTimer", "remoteWriteTimer", "historyTimer", "castTimer"]) {
    if (canvasState[key]) clearTimeout(canvasState[key]);
    canvasState[key] = null;
  }
  if (canvasState.remoteTimer) clearInterval(canvasState.remoteTimer);
  canvasState.remoteTimer = null;
  if (canvasState.timelineChatObserver) { canvasState.timelineChatObserver.disconnect(); canvasState.timelineChatObserver = null; }
  if (canvasState.fullscreenHandler) document.removeEventListener("fullscreenchange", canvasState.fullscreenHandler);
  const page = document.getElementById("assist-page");
  if (page && canvasState.keyHandler) page.removeEventListener("keydown", canvasState.keyHandler);
  if (page && canvasState.keyUpHandler) page.removeEventListener("keyup", canvasState.keyUpHandler);
  if (canvasState.paper) canvasState.paper.remove();
  Object.assign(canvasState, {
    graph: null, paper: null, wheelHandler: null, keyHandler: null, keyUpHandler: null,
    spacePanning: false, inspectorOpen: false, nodeGesture: null, multiMove: null, dragDirty: false,
    bulk: false, fullscreenHandler: null, selected: null, selectedIds: new Set(), selectedAll: false,
    remoteSnapshot: null, remoteContentKey: "", remoteUpdatedAt: 0, remoteWriteArmed: null,
    remoteWritePending: false, remoteBase: null, remotePushing: null, remoteConflict: null,
    restoreChoice: null, saveFailed: "", proposal: null, shotHistory: new Map(), remoteBroken: "",
    remoteBrokenNotified: false, lostNotified: "", taskSessionId: null, chatReferences: new Map(),
    history: [], historyIndex: -1, find: null,
  });
  document.getElementById("canvas-conflict-dialog")?.remove();
  if (typeof canvasWireCancel === "function") canvasWireCancel();
  if (typeof canvasPortMenuClose === "function") canvasPortMenuClose();
  canvasState.inlineEdit = null;
}

async function renderCanvasPage() {
  const page = document.getElementById("assist-page"); if (!page) return;
  await canvasFlushRemoteWrite();   // canvasDestroy 会把定时器掐掉，掐之前先把欠的写出去
  canvasDestroy(); await Promise.all([canvasLoadWorkspaceProjects(), canvasLoadCanvasList()]); canvasState.scale = 1; canvasState.x = 0; canvasState.y = 0; canvasState.next = 1;
  const groups = [["基础节点", ["note", "image", "video", "audio", "agent"]], ["短剧工作流", ["script", "character", "location", "storyboard", "scene", "shot", "timeline"]]];
  const groupedMenu = groups.map(([group, kinds]) => `<span class="canvas-menu-group"><span class="canvas-menu-group-label">${esc(canvasT(group))}</span>${kinds.map((kind) => { const def = CANVAS_NODE_DEFS[kind]; return `<button class="canvas-type-btn" data-canvas-add="${kind}" title="${esc(def.subtitle)}">${ic(def.icon)}<span>${esc(canvasT(def.label))}</span></button>`; }).join("")}</span>`).join("");
  const workspaceOptions = canvasState.workspaceProjects.map((item) => `<option value="${esc(item.name)}" ${item.name === canvasState.workspaceName ? "selected" : ""}>${esc(item.name)}</option>`).join("");
  page.classList.add("canvas-page");
  page.innerHTML = `<div class="canvas-head"><div class="canvas-board-switch"><label class="canvas-workspace-switch" title="${esc(canvasState.workspaceDir)}">${ic("folder")}<select data-canvas-workspace-select ${canvasState.workspaceLocked ? "disabled" : ""}>${workspaceOptions || `<option value="">${esc(canvasState.workspaceDir.split(/[\\/]/).pop() || "当前工作文件夹")}</option>`}${canvasState.workspaceLocked || canvasState.workspaceOwn ? "" : '<option value="__pick__">选择其他文件夹…</option>'}</select></label><span class="canvas-switch-divider"></span><select data-canvas-board-select aria-label="画布">${canvasState.canvasList.map((item) => `<option value="${esc(item.name)}" ${item.name === canvasState.canvasName ? "selected" : ""}>${esc(item.title || item.name)}</option>`).join("")}${canvasState.canvasTrash.length ? `<optgroup label="${esc(canvasT("回收站"))}">${canvasState.canvasTrash.slice(0, 30).map((item) => `<option value="__trash__:${esc(item.id)}">${esc(canvasTrashLabel(item))}</option>`).join("")}</optgroup>` : ""}</select><button class="canvas-tool-button" data-canvas-new title="新建画布" aria-label="新建画布">${ic("plus")}</button></div><div class="canvas-head-actions"><details class="canvas-workflow-menu"><summary>${ic("git-branch")}<span>工作流</span>${ic("chevron-down")}</summary><div><button type="button" data-canvas-recipe="image-video">${ic("image")}图片 → 视频</button><button type="button" data-canvas-starter>${ic("clapperboard")}短剧工作流</button></div></details><button class="ui-btn ui-btn--ghost ui-btn--sm" data-canvas-chat-open>${ic("sparkles")}Agent</button><button class="canvas-tool-button" data-canvas-fullscreen title="全屏" aria-label="全屏">${ic("monitor")}</button><button class="canvas-tool-button" data-canvas-export title="导出画布与素材" aria-label="导出画布与素材">${ic("download")}</button><button class="canvas-tool-button" data-canvas-save title="保存" aria-label="保存">${ic("save")}</button></div></div>
    <section class="canvas-progress" id="canvas-progress" hidden aria-label="短剧制片进度"></section>
    <div class="canvas-toolbar"><span class="canvas-tool-cluster" aria-label="画布创作工具">
      ${[["image", "image", "图片"], ["video", "video", "视频"], ["note", "file-text", "文字"], ["audio", "music", "声音"]].map(([kind, icon, label]) => `<button type="button" class="canvas-quick-add" data-canvas-add="${kind}">${ic(icon)}<span>${label}</span></button>`).join("")}
      <button type="button" class="canvas-quick-add" data-canvas-import>${ic("upload")}<span>导入</span></button><input type="file" data-canvas-import-file accept="image/*,video/*,audio/*" multiple hidden>
      <details class="canvas-node-menu"><summary title="更多节点" aria-label="更多节点"><span class="canvas-menu-label">${ic("plus")}</span></summary><div class="canvas-node-menu-body">${groupedMenu}</div></details>
      <details class="canvas-library"><summary title="打开素材" aria-label="打开素材"><span>${ic("folder-open")}</span></summary><div class="canvas-library-panel"><div class="canvas-library-tools"><input id="canvas-library-search" type="search" placeholder="搜索工作区素材…" /><select id="canvas-library-kind" aria-label="素材类型"><option value="all">全部类型</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select><select id="canvas-library-role" aria-label="素材用途"><option value="all">全部用途</option><option value="定妆照">定妆照</option><option value="首帧">首帧</option><option value="镜头">镜头</option><option value="配音">配音</option><option value="场景图">场景图</option><option value="其他">其他</option></select><label class="canvas-library-toggle"><input type="checkbox" id="canvas-library-orphan"><span>没人用</span></label><button class="canvas-tool-button" type="button" aria-label="刷新素材" data-library-refresh>${ic("refresh-cw")}</button></div><div id="canvas-library-items" class="canvas-library-items"></div></div></details>
      <span class="canvas-tool-divider"></span><button class="canvas-tool-button" type="button" data-canvas-history="undo" title="撤销（${accelDisplay("Mod+Z")}）" aria-label="撤销">${ic("rotate-ccw")}</button><button class="canvas-tool-button is-redo" type="button" data-canvas-history="redo" title="重做（${accelDisplay("Shift+Mod+Z")}）" aria-label="重做">${ic("rotate-ccw")}</button><button class="canvas-tool-button" type="button" data-canvas-marquee title="框选（Shift + 拖动）" aria-label="框选">${ic("square-dashed")}</button>
    </span></div>
    <div class="canvas-find" id="canvas-find" hidden role="search"><input type="text" data-canvas-find-input placeholder="搜标题、台词、镜头号" aria-label="搜标题、台词、镜头号"><span class="canvas-find-count" data-canvas-find-count aria-live="polite"></span><button type="button" class="canvas-tool-button" data-canvas-find-nav="-1" aria-label="上一个">${ic("chevron-up")}</button><button type="button" class="canvas-tool-button" data-canvas-find-nav="1" aria-label="下一个">${ic("chevron-down")}</button><button type="button" class="canvas-tool-button" data-canvas-find-close aria-label="关闭">${ic("x")}</button></div><div class="canvas-bars" id="canvas-bars" hidden></div>
    <div class="canvas-layout"><div id="canvas-viewport" class="canvas-viewport"><div id="canvas-world" class="canvas-world"></div>${canvasWorkspaceStartMarkup()}<div id="canvas-selection-tools" class="canvas-selection-tools" hidden></div><div class="canvas-zoom-box"><button class="canvas-tool-button" data-canvas-minimap aria-pressed="false" title="小地图" aria-label="小地图">${ic("map")}</button><button class="canvas-tool-button" data-canvas-layout title="自动排版" aria-label="自动排版">${ic("git-branch")}</button><span class="canvas-tool-divider"></span><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-zoom="out" aria-label="缩小">−</button><span id="canvas-zoom">100%</span><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-zoom="in" aria-label="放大">+</button><button class="ui-btn ui-btn--ghost ui-btn--xs" data-canvas-fit>适配</button><details class="canvas-view-menu"><summary aria-label="更多画布操作">${ic("ellipsis")}</summary><div><button type="button" data-canvas-center>居中选中节点</button><button type="button" data-canvas-zoom="reset">复位视图</button><label class="canvas-batch-limit"><span>生成并发</span><select data-canvas-batch-limit aria-label="生成并发">${[1, 2, 3, 4].map((n) => `<option value="${n}"${n === canvasBatchLimit() ? " selected" : ""}>${n}</option>`).join("")}</select></label><button type="button" data-canvas-merge-results>合并重复结果</button><button type="button" data-canvas-clear>清空画布</button><button type="button" data-canvas-delete>删除当前画布</button></div></details></div><div id="canvas-minimap" class="canvas-minimap" hidden><div class="canvas-minimap-head"><span>小地图</span><button type="button" aria-label="关闭小地图">${ic("x")}</button></div><svg data-canvas-map-surface aria-label="画布导航" role="img" preserveAspectRatio="xMidYMid meet"><g data-canvas-map-nodes></g><rect class="canvas-map-view" data-canvas-map-view></rect></svg></div></div><aside id="canvas-inspector" class="canvas-inspector"></aside></div>
    <section class="canvas-timeline" id="canvas-timeline" hidden aria-label="时间线"></section>
    <section class="canvas-chat is-collapsed" aria-label="画布 Agent 对话"><button type="button" class="canvas-chat-toggle" data-canvas-chat-toggle aria-label="画布 Agent 对话" aria-expanded="false">${ic("sparkles")}<b>画布 Agent</b><span data-canvas-chat-status>需要帮助时，让 Agent 一起创作</span>${ic("chevron-up")}</button><div class="canvas-chat-body" hidden><div id="canvas-chat-log" class="canvas-chat-log"><div class="canvas-chat-message is-agent"><span class="canvas-chat-role">Agent</span><span class="canvas-chat-text">输入 @ 可引用画布节点或工作区素材。</span></div></div><div id="canvas-chat-mention-menu" class="canvas-chat-mention-menu" hidden></div><div class="canvas-chat-compose"><div id="canvas-chat-ref-chips" class="canvas-chat-ref-chips"></div><textarea id="canvas-chat-input" rows="2" placeholder="描述创作要求，输入 @ 引用节点或素材"></textarea><div class="canvas-chat-tools"><button class="canvas-chat-tool" type="button" data-canvas-chat-attach title="上传文件">${ic("paperclip")}</button><input type="file" data-canvas-chat-file accept="image/*,video/*,audio/*" multiple hidden><button class="canvas-chat-tool" type="button" data-canvas-chat-mention title="引用画布节点或素材">@</button><div class="canvas-chat-tools-spacer"></div><select class="canvas-chat-mode" data-canvas-chat-mode title="执行模式"></select><select class="canvas-chat-model" data-canvas-chat-model title="模型"><option value="">默认模型</option></select><button class="canvas-chat-send" type="button" title="发送（Enter）" aria-label="发送" data-canvas-chat-send>${ic("arrow-up")}</button></div></div></div></section>`;
  await canvasLoadBoards(); const remote = await canvasLoadRemote(); const world = page.querySelector("#canvas-world"), J = typeof joint !== "undefined" ? joint : null;
  // 读不出来就到此为止。再往下一行 JointJS 就起来了，起来就会铺底、就会自动保存
  if (canvasState.remoteBroken) { canvasRenderBroken(page, world); return; }
  if (!J || !J.dia || !J.dia.Paper) { world.innerHTML = '<div class="canvas-empty">画布组件加载失败，请刷新页面。</div>'; return; }
  canvasState.graph = new J.dia.Graph({}, { cellNamespace: J.shapes });
  // guard：按在卡右边的连接点、卡上正在改字的那一格上，画布整个不接（不拖卡、不平移）——
  // 连接点按下去是拉线（见 canvasPortDown），框里按下去是挪光标、选字
  canvasState.paper = new J.dia.Paper({ el: world, model: canvasState.graph, width: 2400, height: 1600, gridSize: 16, drawGrid: { name: "dot", args: { color: "var(--owb-text-3)", thickness: 1, gap: 22 } }, background: { color: "transparent" }, cellViewNamespace: J.shapes, interactive: { elementMove: true, linkMove: false, labelMove: false, addLinkFromMagnet: false }, guard: (evt) => !!evt.target?.closest?.("[data-canvas-port], [data-canvas-inline-editor], [data-canvas-inline-key]") });
  canvasBindViewport(page); canvasBindLinkHover(canvasState.paper); canvasBindMinimap(page);
  canvasState.saveHandler = () => {
    if (canvasState.inlineEdit) canvasInlineCommit();
    if (canvasState.editSaveTimer) canvasPersist();
  };
  window.addEventListener("beforeunload", canvasState.saveHandler);
  window.addEventListener("pagehide", canvasState.saveHandler);
  // 拖一张卡，每一帧都来一次 change:position。以前每一帧都整图序列化 + 写 localStorage + 记撤销 + 判撞号，
  // 卡一多拖起来一顿一顿的（框选十几张一起拖，每帧还要乘十几）。手还按着就只记一笔「脏了」，松手存一次
  // 量卡高往下让位（fitting）、一口气摆一片（bulk）本来就不存，不能借着手还按着记成「脏了」、松手当改动存掉
  canvasState.graph.on("change:position", () => { if (canvasState.nodeGesture && !canvasState.fitting && !canvasState.bulk) { canvasState.dragDirty = true; return; } canvasPersist(); });
  canvasState.graph.on("remove", canvasPersist);
  // 连线动了 → 分镜表里那一镜的 cast 也得跟着动。收在图上而不是收在 canvasConnect 里：
  // 加线都走 canvasConnect（从连接点上手拖、角色面板「挂上」、展开分镜表），减线却有好几条路——
  // 断开一条线、删节点连带掀掉的线都不经过它，只有图的 add / remove 两头都看得见。
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
  // 场次卡上的「N 镜」数的是连出去的镜头卡，不再读 payload 里的抄本。所以连线一加一减
  // （包括删镜头时连带掀掉的线、重开画布时先摆卡后接线）都要把那张场次卡重画一遍
  const sceneWatch = (cell) => {
    if (canvasState.bulk) return;
    if (!cell || typeof cell.isLink !== "function" || !cell.isLink() || !canvasState.graph) return;
    const src = canvasState.graph.getCell(canvasEndpointId(cell.get("source")));
    if (src && canvasKind(src) === "scene") canvasRefreshNode(src);
  };
  canvasState.graph.on("add", sceneWatch); canvasState.graph.on("remove", sceneWatch);
  canvasBindTimeline(page);   // 底部时间线、角色面板、⌘F 搜索条（见 canvasRenderTimeline）
  const toolMenus = [...page.querySelectorAll(".canvas-tool-cluster details")];
  toolMenus.forEach((menu) => menu.addEventListener("toggle", () => { if (menu.open) toolMenus.forEach((other) => { if (other !== menu) other.open = false; }); }));
  page.querySelectorAll("[data-canvas-add]").forEach((btn) => btn.addEventListener("click", () => { canvasAddNode(btn.dataset.canvasAdd); const menu = btn.closest("details"); if (menu) menu.open = false; }));
  // 一键补齐的并发上限：改了就记下，下一批按新的跑（正在跑的那一批不变，它的池子开跑时就定了）
  page.querySelector("[data-canvas-batch-limit]")?.addEventListener("change", (e) => { e.currentTarget.value = String(canvasSetBatchLimit(e.currentTarget.value)); });
  page.querySelectorAll("[data-canvas-zoom]").forEach((btn) => btn.addEventListener("click", () => { const action = btn.dataset.canvasZoom; if (action === "reset") { canvasState.scale = 1; canvasState.x = 0; canvasState.y = 0; canvasState.paper.translate(0, 0); } else canvasZoom(page, canvasState.scale * (action === "in" ? 1.1 : .9)); canvasZoom(page, canvasState.scale); }));
  page.querySelector("[data-canvas-fit]").onclick = () => canvasFitAll(page);
  page.querySelector("[data-canvas-layout]").onclick = () => canvasAutoLayout(page);
  page.querySelectorAll("[data-canvas-history]").forEach((button) => button.addEventListener("click", () => button.dataset.canvasHistory === "undo" ? canvasUndo() : canvasRedo()));
  page.querySelector("[data-canvas-center]").onclick = () => canvasCenterSelected(page);
  page.querySelector("[data-canvas-clear]").onclick = async () => { if (!canvasState.graph.getElements().length || await askConfirm({ title: "清空这张画布？", hint: `${canvasState.graph.getElements().length} 个节点和全部连线将被删除，素材文件保留。`, ok: "清空", danger: true })) { canvasState.graph.clear(); canvasState.selectedIds = new Set(); canvasState.selectedAll = false; canvasState.selected = null; canvasRenderInspector(); canvasPersist(); } };
  page.querySelector("[data-canvas-save]").onclick = () => { canvasPersist(); canvasToast("画布已保存到本机", "save"); };
  // 回收站那几行选中就是「放回来」，下拉先拨回当前这张：放不回来的话，下拉上不能停在一张没打开的画布上
  page.querySelector("[data-canvas-board-select]").onchange = async (event) => { const picked = String(event.target.value || ""); if (picked.startsWith("__trash__:")) { event.target.value = canvasState.canvasName; return canvasRestoreTrash(picked.slice("__trash__:".length)); } await canvasFlushRemoteWrite(); canvasState.canvasName = event.target.value || "main"; try { localStorage.setItem("openworkbuddy.canvas.name", canvasState.canvasName); } catch {} renderCanvasPage(); };
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
  page.querySelector("[data-canvas-starter]").onclick = canvasCreateDramaWorkflow;
  page.querySelector("[data-canvas-chat-send]").onclick = canvasChatSend;
  const chatInput = page.querySelector("#canvas-chat-input"), chatFile = page.querySelector("[data-canvas-chat-file]");
  chatInput.addEventListener("input", () => { canvasRenderChatMentionMenu(); canvasSyncChatSendButton(); });
  chatInput.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.shiftKey && !imeKey(evt)) { evt.preventDefault(); canvasChatSend(); }
    // 拼字中按 Esc 是关候选框：以前直接落到这儿，把正在跑的那轮叫停了
    else if (evt.key === "Escape" && !imeKey(evt)) { page.querySelector("#canvas-chat-mention-menu").hidden = true; if (canvasState.chatBusy) canvasChatStop(); }
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
  const full = page.querySelector("[data-canvas-fullscreen]"), updateFullscreenLabel = () => { if (full) { const label = document.fullscreenElement === page ? "退出全屏" : "全屏"; full.title = label; full.setAttribute("aria-label", label); } };
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
    canvasState.handsOnAt = Date.now();   // 拖动期间同步要让路（见 canvasBusyNow）
    canvasState.nodeGesture = { id: view.model.id, x: Number(event?.clientX) || 0, y: Number(event?.clientY) || 0, moved: false };
    canvasState.multiMove = movingIds.length ? { anchor: view.model.id, positions: new Map(movingIds.map((id) => { const item = canvasState.graph.getCell(id); const point = item?.position?.() || { x: 0, y: 0 }; return [id, { x: point.x, y: point.y }]; })) } : null;
  });
  canvasState.paper.on("element:pointermove", (view, event) => {
    const gesture = canvasState.nodeGesture;
    if (!gesture || gesture.id !== view.model.id) return;
    canvasState.handsOnAt = Date.now();   // 还在拖，把「手上有活」续上
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
    // 拖的这一路攒着没存的，松手这一下存：整次拖动只存一次、只记一条撤销
    if (canvasState.dragDirty) { canvasState.dragDirty = false; canvasPersist(); }
    if (!gesture || gesture.id !== view.model.id || !gesture.moved) return;
    canvasState.skipNodeClick = view.model.id; canvasState.suppressInspectorUntil = Date.now() + 650;
    window.setTimeout(() => { if (canvasState.skipNodeClick === view.model.id) canvasState.skipNodeClick = null; }, 650);
  });
  // 整份传进去，别在这儿把「空的」换成 null：那样里头就只剩「现在是空的」可看，
  // 而「服务器上那份是空的、但早就有人动过」正是不该再铺起手卡的那种
  // 刷新、重启前发出去还没收到结果的那几单，铺完就挂回卡片上（摆「看结果」），赶在撤销起点之前
  canvasRestoreOrSeed(remote); canvasBindWorkspace(page); canvasAdoptLocalJobs(); canvasHistoryReset(canvasSnapshot()); canvasStartRemoteSync();
  // 不在的这段时间里 Agent 清空过、连删过，打开就挂「撤销」（since 在 canvasRestoreOrSeed 里按本机上回存的时间定）
  canvasOfferSnapshotUndo();
  window.setTimeout(() => { if (canvasState.graph?.getElements().length) canvasFitAll(page); }, 0);
  canvasLoadLibrary();
}
