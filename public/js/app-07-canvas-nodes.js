/* 无限画布 · 节点卡片（第 3 片）
 *
 * 节点卡片的表单字段、上传和选文件、卡片外观、选中与删除、右键菜单，
 * 撤销和重做，以及撤销后把改动回写到分镜表。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
 */
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
  // ai_generated：这张卡是分镜草稿落下来的（见 canvasPlaceCommitted），头上挂一枚「AI 生成」——
  // 人改过也不摘：它说的是「最初谁写的」，让人知道这段文字没人从头审过
  const header = (title, subtitle = def.subtitle) => `<header class="canvas-node-head"><span class="canvas-node-icon">${ic(def.icon)}</span><div><b>${esc(title || def.label)}</b><small>${esc(subtitle)}</small></div>${payload && payload.ai_generated ? '<span class="canvas-ai-badge" title="这张卡由对话模型生成">AI 生成</span>' : ""}<button class="canvas-node-settings" data-canvas-settings title="打开设置" aria-label="打开设置">${ic("settings")}</button><button class="canvas-node-remove" data-canvas-remove title="删除节点" aria-label="删除节点">${ic("x")}</button></header>`;
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
      ? canvasState.boards.map((b) => `<option value="${esc(b.name)}" ${b.name === payload.board ? "selected" : ""}>${esc(b.title || b.name)} · ${b.shots} 镜</option>`).join("")
      : '<option value="">还没有分镜表</option>';
    return `<article class="canvas-node canvas-node-storyboard">${header("短剧分镜", "short-drama 业务节点")}<div class="canvas-node-body"><label>选择分镜表</label><select data-canvas-board ${canvasState.boards.length ? "" : "disabled"}>${options}</select><div class="canvas-node-actions"><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-expand ${canvasState.boards.length ? "" : "disabled"}>展开场次与镜头</button><button class="ui-btn ui-btn--sm ui-btn--ghost" data-canvas-agent>交给本项目 Agent</button></div><p class="canvas-node-hint">分镜表是输入，场次/镜头是可继续创作的节点。</p></div></article>`;
  }
  if (kind === "scene") {
    // 这一场有几镜，数的是挂在它右边的镜头卡，不是 payload 里抄的一份：抄本不跟着改、删、重排走，
    // 展开两次还会各抄一份。老画布里没连线、只剩抄本的场次照旧显示抄本
    const graph = canvasState.graph;
    const linked = nodeId && graph && typeof graph.getLinks === "function" && typeof graph.getCell === "function"
      ? graph.getLinks().filter((l) => (l.get("source") || {}).id === nodeId)
        .map((l) => graph.getCell((l.get("target") || {}).id)).filter((n) => n && canvasKind(n) === "shot").map((n) => canvasPayload(n))
      : [];
    const shots = linked.length ? linked : Array.isArray(payload.shots) ? payload.shots : [];
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
  if (kind === "script") {
    // 「生成分镜表」只出草稿、不落盘：草稿先进预览表给人改，点「放到画布上」才提交（见 canvasDraftStoryboard）。
    // 旁边那句写明花的是对话模型的 token——跟生图生视频那种按张按秒扣的不是一个量级，但也不是白给
    const drafting = !!(canvasState.drafting && canvasState.drafting.has(nodeId));
    return `<article class="canvas-node canvas-node-script">${header(payload.title || "新剧本")}<div class="canvas-node-body canvas-script-body"><div class="canvas-node-copy canvas-script-text">${esc(payload.text || "还没有剧本内容")}</div><div class="canvas-node-actions canvas-script-actions"><button class="ui-btn ui-btn--sm ui-btn--outline" data-canvas-draft ${drafting ? "disabled" : ""}>${drafting ? "生成中…" : "生成分镜表"}</button><small class="canvas-script-cost">用对话模型生成，消耗少量 token</small></div></div></article>`;
  }
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
/**
 * 删掉选中的节点。右键菜单走这里，跟 Delete 键（canvasBindViewport 键盘那一段）做的是同一件事：
 * 不先问、直接删，删完提示上挂一颗「撤销」。以前右键删要先过一道确认、删了却撤不回来，
 * Delete 键不问、也撤不回来——两条路两个脾气，哪条都兜不住手滑。
 * 右键点的那张不在选中里时只删它：不然框选着一片、右键点另一张删，删掉的是那一片。
 */
function canvasDeleteSelection(fallbackNode) {
  const selected = fallbackNode && !canvasState.selectedIds.has(fallbackNode.id) ? [fallbackNode.id]
    : canvasState.selectedIds.size ? [...canvasState.selectedIds] : fallbackNode ? [fallbackNode.id] : [];
  const nodes = selected.map((id) => canvasState.graph?.getCell(id)).filter((node) => node?.isElement?.());
  if (!nodes.length) return;
  // 先把删之前那一步记进撤销栈：刚拖完一张卡紧接着删，那一步还在 260ms 的防抖里，
  // 不先记下来，撤销就直接退到拖之前了
  canvasHistoryFlush();
  nodes.forEach((node) => node.remove()); canvasState.selected = null; canvasState.selectedIds = new Set(); canvasState.selectedAll = false; canvasRenderInspector(); canvasPersist();
  canvasToast("节点已删除。", "trash-2", undefined, { label: "撤销", run: canvasUndo });
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
    else if (action === "duplicate") {
      // 复制镜头：编号和分镜表的戳都不能跟着抄——抄过去就是两张卡写同一个文件、回同一行分镜表
      const p = node.position(), copy = { ...canvasPayload(node) };
      if (canvasKind(node) === "shot") ["id", "board", "board_scene", "board_shot", "board_character"].forEach((k) => { delete copy[k]; });
      canvasAddNode(canvasKind(node), copy, { x: p.x + 42, y: p.y + 42 });
    }
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
  if (canvasKind(node) === "shot" && typeof canvasDupShotIds === "function") root.classList.toggle("is-dup-id", canvasDupShotIds().has(canvasShotFileKey(canvasPayload(node).id)));
}

function canvasSnapshot() {
  if (!canvasState.graph) return { version: 2, nodes: [], edges: [], updatedAt: Date.now() };
  return {
    // 版本 2 的意思只有一条：这份画布把连线照实记下来了，没有连线就是真的一根都没有。
    // 版本 1 那会儿是「连线这一段可能压根没存过」，两者得分得开，不然删不掉线（见下面两处）
    version: 2,
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
  const before = canvasSnapshot(), target = canvasState.history[--canvasState.historyIndex]; canvasState.historyMute = true;
  try { canvasApplySnapshot(target); } finally { canvasState.historyMute = false; }
  canvasToast("已撤销上一步操作。", "rotate-ccw");
  canvasHistoryWriteback(before, canvasSnapshot());
}
function canvasRedo() {
  canvasHistoryFlush();
  if (canvasState.historyIndex >= canvasState.history.length - 1) return canvasToast("已经是最新一步了。", "rotate-ccw");
  const before = canvasSnapshot(), target = canvasState.history[++canvasState.historyIndex]; canvasState.historyMute = true;
  try { canvasApplySnapshot(target); } finally { canvasState.historyMute = false; }
  canvasToast("已恢复下一步操作。", "rotate-ccw");
  canvasHistoryWriteback(before, canvasSnapshot());
}
/**
 * 撤销 / 重做之后，分镜表那边也跟着退。
 *
 * 撤销只动画布的话，台词退回去了、分镜表里还是刚才那句：短剧页和命令行重跑读的是分镜表，
 * 等于花钱照着一句已经撤掉的台词再生一遍。所以撤销完把「这一步里动过的分镜表字段」补丁写回，
 * 一个节点一趟，挨个发（同一份分镜表两趟并发是两次读-改-写，后到的会把先到的抹掉）。
 * 回表规矩跟检查器那条一样：镜头号跟分镜表对不上的不回；产物路径、景别、提示词退成空的不回——
 * 服务端不收空的（清空产物路径等于抹掉买到手的东西），这一格分镜表就留着较新的那份。
 * 绝不抛：它跑在撤销之后，没人接它的 Promise
 */
const CANVAS_BOARD_MEDIA_KEYS = { shot: { first_frame: "first_frame", last_frame: "last_frame", video: "video", audio: "audio" }, character: { reference: "ref" } };
const CANVAS_BOARD_MUST = new Set(["first_frame", "last_frame", "video", "audio", "shot_size", "frame_prompt", "motion_prompt", "ref", "name", "look"]);
async function canvasHistoryWriteback(before, after) {
  try {
    const old = new Map(((before && before.nodes) || []).map((item) => [item.id, item.payload || {}]));
    const errors = [];
    for (const item of (after && after.nodes) || []) {
      const p = item.payload || {}, prev = old.get(item.id);
      const board = String(p.board || "").trim(), shot = String(p.board_shot || "").trim(), character = String(p.board_character || "").trim();
      if (!prev || !board || (!shot && !character)) continue;
      if (shot && String(p.id || "").trim() && String(p.id).trim() !== shot) continue;
      const target = shot ? "shot" : "character", fields = {};
      for (const [key, field] of Object.entries({ ...CANVAS_BOARD_SYNC_KEYS[target], ...CANVAS_BOARD_MEDIA_KEYS[target] })) {
        if (String(p[key] == null ? "" : p[key]) === String(prev[key] == null ? "" : prev[key])) continue;
        let value = field === "frame_prompt" ? canvasBoardFramePrompt(p).text : p[key];
        if (field === "duration") { value = Number(value); if (!Number.isFinite(value) || value <= 0) continue; }
        else value = String(value == null ? "" : value);
        if (CANVAS_BOARD_MUST.has(field) && !String(value).trim()) continue;
        fields[field] = value;
      }
      if (!Object.keys(fields).length) continue;
      const back = await canvasBoardWriteback(p, fields);
      if (back) errors.push(back);
    }
    if (errors.length) canvasToast(errors[0], "triangle-alert", "err");
  } catch (e) { console.warn("[canvas] 撤销后回写分镜表出错", e); }
}
