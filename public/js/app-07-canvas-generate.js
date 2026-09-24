/* 无限画布 · 生成（第 5 片）
 *
 * 跑一个节点要带上哪些上游输入、配音用谁的嗓子、历史版本、生成结果落回画布；
 * 画布对话也在这片（它和生成共用同一套任务和参考素材）；
 * 生成完回写分镜表、调工具、换一版。
 * 按原先的先后切，所以对话夹在中间，没有另起一片——测试按函数到函数切源码，顺序不能乱。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
 */
function canvasRunInternal(node) {
  const kind = node && String(node.get("canvasKind") || "note"), p = canvasPayload(node);
  const text = kind === "shot"
    ? `请处理这个短剧镜头：${p.id || p.title || "新镜头"}\n景别：${p.shot_size || "未指定"}\n时长：${p.duration || "4"} 秒\n镜头提示词：${canvasIsPlaceholderPrompt(p.prompt) ? "" : p.prompt}\n对白/旁白：${canvasIsPlaceholderPrompt(p.line) ? "" : p.line}\n读取连线时必须按用途区分人物身份、场景空间、构图、动作与连续性；需要时直接调用 generate_image / generate_video，并用 canvas_manage 更新当前镜头节点的 first_frame 或 video。`
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
    // 新建卡片没改过的那几格是占位字（「镜头内容与运动…」），递给模型它会当真去画
    const body = [p.description, p.text, p.prompt, p.line, p.task].find((v) => v && !canvasIsPlaceholderPrompt(v)) || "";
    return `【${canvasRelationLabel(item.relation)}】${CANVAS_NODE_DEFS[item.kind]?.label || "节点"}：${item.label}\n${body}`;
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
    if (!hit) return { error: `说话人「${speaker}」不在已连接的角色里：${cast.map((item) => item.name || item.id || "未命名角色").join("、")}。请检查名字或连上该角色。` };
    return { voice: hit.voice };
  }
  // 一个角色都没连上来的时候，speaker 只是从分镜表带过来的一条备注，没有谁跟谁要分辨——
  // 照常发，用设置里配的默认音色。在这儿报错等于把「展开分镜表」生出来的画布整个堵死。
  // 空字符串也是一档：它代表「用设置里配的默认音色」，跟 Cherry 是两个不一样的结果。
  // 所以「一个角色定了音色、另一个还没定」照样算岔路，不是「只有一个候选」。
  const distinct = [...new Set(cast.map((item) => item.voice))];
  if (distinct.length > 1) {
    return { error: `这一镜连了 ${cast.length} 个角色：${cast.map((item) => item.name || "未命名角色").join("、")}。请在「说话的角色」里指定谁来念。` };
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
  return `<div class="canvas-inspector-section canvas-provenance"><span class="canvas-inspector-section-title">最近一次生成</span><div class="canvas-provenance-meta"><span>${esc(run.kind === "image" ? "图片" : run.kind === "video" ? "视频" : "音频")}</span><span>${esc(run.model || "默认模型")}</span><span>${esc(time)}</span>${run.reused ? "<span>缓存复用</span>" : ""}${run.fallbackFrom ? `<span title="${esc(canvasT("{n} 没成，换了设置里排的备用模型", { n: run.fallbackFrom }))}">备用模型</span>` : ""}</div><div class="canvas-provenance-output" title="${esc(run.output)}">${ic("file-check")}<span>${esc(String(run.output).split(/[\\/]/).pop())}</span></div>${inputs.length ? `<div class="canvas-provenance-inputs">${inputs.map((item) => `<span title="${esc(item.path)}">${esc(canvasRelationLabel(item.relation))} · ${esc(item.label)}</span>`).join("")}</div>` : '<p class="canvas-inspector-hint">本次没有使用画布上游素材。</p>'}${run.replaced ? `<p class="canvas-inspector-hint">已保留上一版记录：${esc(String(run.replaced).split(/[\\/]/).pop())}</p>` : ""}</div>`;
}

/**
 * 检查器里的「历史版本」：这一镜首帧 / 视频 / 配音各自生过哪几版，外加短剧页那边的留底快照。
 *
 * 从短剧页（原 app-07-drama.js，已删）迁过来的回滚能力，但换了一种回法：那边是 restore——把留底的字节
 * 写回原路径，等于把现在那份盖掉。这里一概不碰盘上的文件：每一版本来就各占一个带号的文件名，
 * 「用这一版」只是让卡片改指那个文件，再把这一个字段补丁写回分镜表。
 * 所以这里绝不调 restore，也不调 snapshot（留底那边按保留期清理，一调就可能删掉老的留底）
 */
function canvasShotHistoryKey(p) {
  const board = String((p && p.board) || "").trim(), shot = String((p && p.board_shot) || "").trim();
  return board && shot ? `${board}\n${shot}` : "";
}
function canvasHistoryWhen(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return String(ts || "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function canvasHistoryVersions(node, p, kind) {
  const field = canvasOutputField(kind);
  const rows = new Map(canvasOutputVersions(p, kind, node, canvasState.canvasName).map((row) => [row.rel, { ...row }]));
  const cache = canvasState.shotHistory.get(canvasShotHistoryKey(p));
  // 留底是新的在前：同一个文件被留过好几次，记最近那一次的时间
  for (const v of cache && Array.isArray(cache.versions) ? cache.versions : []) {
    const f = v && v.files && v.files[field], rel = String((f && f.rel) || "").trim();
    if (!rel || /^(https?:|data:)/i.test(rel)) continue;
    const row = rows.get(rel) || { rel, version: canvasVersionOf(rel, p, kind) };
    if (!row.snap) row.snap = { id: v.id, ts: v.ts };
    rows.set(rel, row);
  }
  return [...rows.values()].sort((a, b) => b.version - a.version || String((b.snap && b.snap.ts) || "").localeCompare(String((a.snap && a.snap.ts) || "")));
}
function canvasHistoryRowHtml(row, kind, current) {
  const isCur = !!current && canvasResolvedFileName(row.rel) === current;
  // 盘上确认没有了（问过盘）就不给点：点了卡片指着一个不存在的文件，还会写进分镜表
  const gone = !isCur && !canvasMediaAvailable(row.rel);
  const label = row.version > 0 ? `v${row.version}` : row.version === 0 ? "原版" : "留底";
  const thumb = kind === "image" && !gone ? `<img src="${esc(canvasFileUrl(row.rel, 160))}" alt="" loading="lazy">` : ic(kind === "image" ? "image" : kind === "video" ? "video" : "volume-2");
  const tip = row.version > 0 && !isCur ? canvasT("这是 v{n}，点「用这一版」切回来，不花钱", { n: row.version }) : "";
  const notes = [row.snap ? `<small><span>留底</span> <span>${esc(canvasHistoryWhen(row.snap.ts))}</span></small>` : "", row.ambiguous ? "<small>同名文件不止一份，点了就认这一份</small>" : "", gone ? "<small>盘上已经没有这个文件</small>" : ""].join("");
  return `<li class="canvas-history-row${isCur ? " is-current" : ""}" title="${esc(row.rel)}"><span class="canvas-history-thumb">${thumb}</span><span class="canvas-history-meta"><b>${esc(label)}</b>${notes}</span><button type="button" class="ui-btn ui-btn--xs ${isCur ? "ui-btn--ghost" : "ui-btn--outline"}" data-canvas-use-version="${esc(kind)}" data-rel="${esc(row.rel)}"${tip ? ` title="${esc(tip)}"` : ""}${isCur || gone ? " disabled" : ""}>${isCur ? "当前" : "用这一版"}</button></li>`;
}
function canvasHistoryInnerHtml(node) {
  const p = canvasPayload(node);
  const groups = [["image", "首帧"], ["video", "视频"], ["audio", "配音"]].map(([kind, title]) => {
    const rows = canvasHistoryVersions(node, p, kind);
    if (!rows.length) return "";
    const current = canvasResolvedFileName(p[canvasOutputField(kind)]);
    return `<div class="canvas-history-group"><span class="canvas-history-kind">${esc(title)}</span><ul class="canvas-history-list">${rows.map((row) => canvasHistoryRowHtml(row, kind, current)).join("")}</ul></div>`;
  }).join("");
  const cache = canvasState.shotHistory.get(canvasShotHistoryKey(p));
  const status = cache && cache.loading ? '<p class="canvas-inspector-hint">正在读留底…</p>'
    : cache && cache.error ? `<p class="canvas-inspector-hint">${esc(cache.error)}</p>` : "";
  return `<span class="canvas-inspector-section-title">历史版本</span>${groups
    ? `${groups}<p class="canvas-inspector-hint">只换卡片引用的文件，不删任何版本，不花钱。</p>`
    : '<p class="canvas-inspector-hint">还没有生成过。每生成一次多一版，旧版都留着。</p>'}${status}`;
}
function canvasHistoryInspector(node) {
  if (!node || canvasKind(node) !== "shot") return "";
  canvasLoadShotHistory(node);
  return `<div class="canvas-inspector-section canvas-history" data-canvas-history>${canvasHistoryInnerHtml(node)}</div>`;
}
// 只重画「历史版本」那一块：整个检查器重画会把人正在敲的输入框换掉
function canvasRefreshHistory() {
  if (typeof document === "undefined") return;
  const box = document.querySelector("#canvas-inspector [data-canvas-history]"), node = canvasSelectedNode();
  if (!box || !node || canvasKind(node) !== "shot") return;
  box.innerHTML = canvasHistoryInnerHtml(node);
  canvasBindHistory(box, node);
}
/**
 * 读这一镜在分镜表那边的留底。只有「展开场次与镜头」盖过戳的节点才有——手搓的镜头在分镜表里
 * 没有这一行，问了也是 400。30 秒内读过就不再读：检查器每敲一个字都可能重画
 */
function canvasLoadShotHistory(node) {
  const p = canvasPayload(node), key = canvasShotHistoryKey(p);
  if (!key) return;
  const had = canvasState.shotHistory.get(key);
  if (had && (had.loading || Date.now() - had.at < 30000)) return;
  canvasState.shotHistory.set(key, { ...(had || {}), at: Date.now(), loading: true, error: "" });
  const q = "/api/drama/shot-history?name=" + encodeURIComponent(String(p.board).trim()) + "&kind=shot&id=" + encodeURIComponent(String(p.board_shot).trim());
  fetch(q).then(async (r) => {
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) throw new Error(String(out.error || r.status));
    canvasState.shotHistory.set(key, { at: Date.now(), versions: Array.isArray(out.versions) ? out.versions : [] });
  }).catch((e) => {
    // 读不到留底不耽误列本画布上的版本：原样把错摆出来，不猜为什么
    canvasState.shotHistory.set(key, { ...(had || {}), at: Date.now(), error: canvasT("留底没读出来：{n}", { n: String(e.message || e).slice(0, 60) }) });
  }).finally(() => {
    const sel = canvasSelectedNode();
    if (sel && canvasShotHistoryKey(canvasPayload(sel)) === key) canvasRefreshHistory();
  });
}
function canvasBindHistory(box, node) {
  box?.querySelectorAll("[data-canvas-use-version]").forEach((button) => button.addEventListener("click", () => canvasUseVersion(node.id, button.dataset.canvasUseVersion, button.dataset.rel)));
}
/**
 * 「用这一版」：卡片改指那个文件，跟它连着的那张结果卡一起换，然后只把这一个字段补丁写回分镜表。
 * 不删、不挪、不覆盖任何文件——现在这一版照样躺在盘上，想回来再点一次就回来了。
 * 撤销也管用：换之前先把上一步记进撤销栈
 */
async function canvasUseVersion(nodeId, kind, rel) {
  const node = canvasState.graph ? canvasState.graph.getCell(nodeId) : null;
  const file = String(rel || "").trim();
  if (!node || !file || !["image", "video", "audio"].includes(kind)) return;
  canvasHistoryFlush();
  const field = canvasOutputField(kind);
  node.set("canvasPayload", { ...canvasPayload(node), [field]: file });
  const mirror = canvasState.graph.getElements().find((item) => canvasKind(item) === kind && canvasPayload(item).sourceId === node.id);
  if (mirror) { mirror.set("canvasPayload", { ...canvasPayload(mirror), path: file, url: file, title: file.split(/[\\/]/).pop() }); canvasRefreshNode(mirror); }
  canvasRefreshNode(node); canvasPersist(); canvasRenderInspector(false);
  const back = await canvasBoardWriteback(canvasPayload(node), { [field]: file });
  if (back) canvasToast(back, "triangle-alert", "err");
  else canvasToast(canvasT("已换成 {n}，没删任何文件。", { n: file.split(/[\\/]/).pop() }), "circle-check");
}

function canvasRecordGeneration(node, kind, input, output, result, ms) {
  const previous = canvasPayload(node), oldOutput = kind === "image" ? previous.first_frame || previous.path || previous.url : kind === "video" ? previous.video || previous.path || previous.url : previous.audio || previous.path || previous.url;
  const run = {
    // 沿用 / 缓存命中那几毫秒不记 ms：「还要多久」按 ms 取中位数，混进一堆 0.1 秒会把预估压成几秒
    id: `run_${Date.now().toString(36)}`, kind, at: Date.now(), ...(Number(ms) > 0 && !result?.cached ? { ms: Number(ms) } : {}), model: String(input.model || previous.model || ""), output,
    inputs: canvasGenerationInputs(node), reused: !!result?.cached, ...(oldOutput && oldOutput !== output ? { replaced: oldOutput } : {}),
    // sig：这一枪的参数指纹（canvasInputSig），下次同参数就沿用这一份；fresh：这一枪绕过了服务端缓存（换一版，或定妆照 / 场景图防覆盖）；
    // fallback：按设置里排的备用顺序换了模型，记下原来那个，检查器和提示里要写明
    ...(result?.sig ? { sig: String(result.sig) } : {}), ...(input.no_cache ? { fresh: true } : {}),
    ...(result?.fallbackFrom ? { fallbackFrom: String(result.fallbackFrom) } : {}),
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
  // 起手卡上可能记着「新建短剧」填的画幅、时长、风格、模型：清掉之前先拿下来，放到新的剧本卡上
  const starter = isEmptyStarter ? canvasPayload(existing.find((node) => canvasKind(node) === "script")) : {};
  const drama = Object.fromEntries(CANVAS_DRAMA_KEYS.filter((k) => starter[k] != null && starter[k] !== "").map((k) => [k, starter[k]]));
  if (isEmptyStarter) canvasState.graph.clear();
  const base = 120 + (canvasState.next % 2) * 40;
  const note = canvasAddNode("note", { title: "创作方向", text: "先写清楚受众、情绪、时长和发布平台。" }, { x: base, y: 100 }, { skipSelect: true });
  const script = canvasAddNode("script", { title: "短剧剧本", text: "在这里写一句话概念、人物关系、冲突、对白和结局。", ...drama }, { x: base + 430, y: 100 }, { skipSelect: true });
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

// 一张画布一直用同一条任务。以前只在第一次登记，之后这一行被新任务挤到下面就不动了——
// 人刚在画布上说完话，去侧栏得往下翻才找得到。每发一次就提到最上面
function canvasRegisterTask(sessionId, text) {
  if (typeof sessions === "undefined" || typeof saveSessions !== "function") return;
  const at = sessions.findIndex((item) => item.id === sessionId);
  const row = at >= 0 ? sessions.splice(at, 1)[0] : { id: sessionId, title: String(text).slice(0, 24), project: typeof activeProject === "string" ? activeProject : undefined, lane: typeof activeLane === "string" ? activeLane : "office" };
  row.at = Date.now();
  sessions.unshift(row);
  saveSessions();
  if (typeof renderHistory === "function") renderHistory();
}

/**
 * 画布发起的任务登记成「正在跑」，跟主聊天框走同一套回合。
 * 以前画布自己读流，主界面完全不知道：这时在任务历史里点开它，看到的是一轮被标成「中断」的旧记录，
 * 侧栏也没有运行中的小圆点，要等跑完才对得上。现在每个事件同时喂给这个回合，侧栏和对话都是直播。
 */
function canvasTurnStart(sessionId, message, mode, shown) {
  if (typeof createTurnUI !== "function" || typeof runningSessions === "undefined") return null;
  const ui = createTurnUI(message, mode, sessionId, shown);
  const rc = typeof makeRecCounter === "function" ? makeRecCounter() : { feed() {} };
  runningSessions.set(sessionId, { ui });
  if (typeof updateSendUI === "function") updateSendUI();
  return { ui, rc, feed(event) { try { rc.feed(event); ui.handleEvent(event); } catch {} } };
}

/** 收尾。画布这边的流断了但服务端还在跑：接着续流把这一轮跟完，侧栏不许比真实状态先变「完成」 */
async function canvasTurnEnd(sessionId, turn, sawDone) {
  if (!turn) return;
  if (!sawDone && typeof keepAttached === "function") { try { await keepAttached(sessionId, turn.ui, turn.rc, false, null); } catch {} }
  const log = document.getElementById("canvas-chat-log");
  const quiet = !!(log && log.getClientRects().length && !document.hidden); // 画布开着：它自己已经报过完成
  if (typeof endRun === "function") endRun(sessionId, turn.ui, { quiet });
  else { turn.ui.finish(); runningSessions.delete(sessionId); }
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
  // 同一条任务正在主界面跑：服务端只会回 409，再挂一个回合还会把那边的顶掉
  if (typeof runningSessions !== "undefined" && runningSessions.has(canvasTaskSessionId())) return canvasChatAppend("agent", "这条任务还在跑，等它跑完再发，或者先停下", "is-status is-error");
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
  let answer = "", assistant = null, sawDone = false;
  const turn = canvasTurnStart(sessionId, directive, mode, userText);
  const write = (value) => {
    if (!assistant) assistant = canvasChatAppend("agent", "", "is-live");
    answer += String(value || ""); if (assistant) assistant.textContent = canvasChatDisplayText(answer);
    const log = document.getElementById("canvas-chat-log"); if (log) log.scrollTop = log.scrollHeight;
  };
  try {
    const row = typeof sessions !== "undefined" ? sessions.find((item) => item.id === sessionId) : null;
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message: directive, shown: userText, mode, lang: "zh", ...(row && row.lane ? { lane: row.lane } : {}) }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      sawDone = true; // 请求没被受理，没有可续的流
      turn?.feed({ type: "error", message: data.error || `请求失败（HTTP ${response.status}）` });
      throw new Error(data.error || "Agent 请求失败");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    const consume = (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n\n"); buffer = parts.pop() || "";
      parts.forEach((part) => {
        if (!part.startsWith("data: ")) return;
        let event; try { event = JSON.parse(part.slice(6)); } catch { return; }
        turn?.feed(event);
        if (event.type === "done") sawDone = true;
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
  finally {
    canvasState.chatBusy = false; canvasState.chatStopping = false; canvasSyncChatSendButton();
    canvasTurnEnd(sessionId, turn, sawDone).catch(() => {});
    if (typeof renderHistory === "function") renderHistory();
  }
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
    if (!r.ok || !out.ok) return `${shot} 的出场角色没写回分镜表（${String(out.error || r.status).slice(0, 120)}），重跑时仍用旧参考图`;
    return "";
  } catch (e) {
    return `${shot} 的出场角色没写回分镜表（${String(e.message || e).slice(0, 120)}），重跑时仍用旧参考图`;
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
  if (shot && own && own !== shot) return `镜头号 ${own} 与分镜表的 ${shot} 不一致，不再自动回表。改编号请去分镜表`;

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
    if (!r.ok || !out.ok) return `${key0} 这一笔没写回分镜表（${String(out.error || r.status).slice(0, 120)}），重跑仍用旧内容`;
    if (folded) return `${key0} 已写回分镜表，但你改了其中的全片画风，下次展开会重复追加。改画风请改分镜表的 style`;
    return "";
  } catch (e) {
    return `${key0} 这一笔没写回分镜表（${String(e.message || e).slice(0, 120)}），重跑仍用旧内容`;
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
    if (!r.ok || !out.ok) return `没能回写进分镜表（${String(out.error || r.status).slice(0, 120)}），在短剧页重跑会再花一次钱`;
    return "";
  } catch (e) {
    return `没能回写进分镜表（${String(e.message || e).slice(0, 120)}），在短剧页重跑会再花一次钱`;
  }
}

/**
 * 视频这一枪的时长 / 画幅 / 分辨率。卡片上写着「5s · 16:9 · 1080p」、新建短剧定了「每镜 5 秒 · 9:16」，
 * 以前一项都没发出去，出来的全是模型默认那一档——说一套做一套。
 * 镜头卡：时长用这一镜自己的（分镜表里改过的也算），没有再用新建短剧定的；画幅用这部戏的
 * （带了首帧的，服务端按图走、不发）。没走过「新建短剧」的画布不猜，照旧交给模型默认。
 * 通用视频卡：卡上三项照发。写坏了（「五秒」）服务端当场退回、不花钱（media-models.js videoPlan）。
 * 估价也用这一份（canvasEstimateItem），跟真跑那一枪同一个口径
 */
function canvasVideoSpec(p, nodeKind) {
  const q = p || {};
  const val = (v) => (v == null ? "" : String(v).trim());
  const out = {};
  if (nodeKind === "shot") {
    const nodes = canvasState.graph && typeof canvasState.graph.getElements === "function" ? canvasState.graph.getElements() : [];
    const set = nodes.some((n) => canvasKind(n) === "script" && ["aspect", "shot_seconds"].some((k) => val(canvasPayload(n)[k])));
    const drama = set && typeof canvasDramaSettings === "function" ? canvasDramaSettings() : null;
    const duration = val(q.duration) || val(drama && drama.shotSeconds);
    if (duration) out.duration = duration;
    if (drama && drama.aspect) out.aspect_ratio = drama.aspect;
    return out;
  }
  if (nodeKind !== "video") return out;
  for (const k of ["duration", "aspect_ratio", "resolution"]) if (val(q[k])) out[k] = val(q[k]);
  return out;
}

async function canvasGenerate(node, kind) {
  // 返回 { ok, error }：一键补齐要靠它数「几个成了、哪几个没成」，没成的那几个才能单独重跑。
  // 拦在开枪前的（占位文字、没首帧、没点名说话人）也算没成——这一格确实还空着
  if (!node || !["image", "video", "audio"].includes(kind)) return { ok: false, error: "不支持的生成类型" };
  const key = `${node.id}:${kind}`;
  // 「换一版」是从 canvasReroll 进来的：它先在 reroll 里记一笔再调这里。签名不能加参数（测试按
  // 「canvasGenerate(node, kind)」切源码），所以走这个旁路。先取走再判忙：忙着的时候点了也不该留到下一次
  const fresh = canvasState.reroll instanceof Set ? canvasState.reroll.delete(key) : false;
  if (canvasState.busy.has(key)) return { ok: false, error: "这个节点正在生成" };
  const p = canvasPayload(node), upstream = canvasUpstreamImages(node), upstreamInputs = canvasUpstreamInputs(node);
  const nodeKind = canvasKind(node);
  // 角色 / 场景节点生的是定妆照和场景图：它们是后面每一镜的参考图，不是镜头本身，
  // 所以提示词、文件名、写回哪个字段，三样都跟镜头那条不一样。
  const castKind = kind === "image" && (nodeKind === "character" || nodeKind === "location") ? nodeKind : "";
  if (castKind && canvasIsPlaceholderPrompt(p.description)) {
    canvasToast(castKind === "character"
      ? "先写人物设定：只有名字，每次生成的脸都不一样。"
      : "先把场景设定写出来：只有一个地名，生出来的景每次都不一样。", "triangle-alert", "err");
    return { ok: false, error: "缺设定" };
  }
  // 首帧只认三样：自己身上那张、连线上明写着「首帧」的那个节点、上游挂着的图片节点。
  // 以前兜底是 upstream[0]——上游第一个是谁全看连线顺序，多半是角色的定妆照。
  // 拿定妆照当首帧生出来的片子跟这一镜没关系，而这一枪是花钱的。宁可在这儿停下说「还没有首帧」。
  const frameFrom = upstreamInputs.find((item) => item.relation === "first_frame")
    || upstreamInputs.find((item) => item.kind === "image");
  let firstFrame = p.first_frame || (kind === "video" && frameFrom ? canvasUpstreamImage(frameFrom) : "");
  if (kind === "video" && !firstFrame && canvasKind(node) === "shot") {
    canvasToast("这个视频节点还没有首帧，请先生成首帧或连接一个参考图节点。", "triangle-alert", "err"); return { ok: false, error: "缺首帧" };
  }
  // 起手模板里那句占位文字原样没改就开枪，买回来的就是一张「这张图要保持的主体、风格与构图…」。
  // 定妆照那条已经这么拦了（castKind 那一段），图 / 视频 / 配音三种节点身上的默认文案一样得拦：
  // 这几个节点的面板上就摆着「生成…」按钮，一按就是真花钱。
  const ownPrompt = kind === "audio"
    ? String(p.text || p.line || p.description || "").trim()
    : String(p.prompt || p.description || p.text || "").trim();
  if (!castKind && ownPrompt && canvasIsPlaceholderPrompt(ownPrompt)) {
    canvasToast(kind === "audio"
      ? "还是模板占位文字，先写台词或旁白。"
      : "还是模板占位文字，先写提示词。", "triangle-alert", "err");
    return { ok: false, error: "占位文字" };
  }
  // 配音多一道：用谁的嗓子。定不下来就停，不替用户挑（挑错了声音是好声音，只是不是这个人的，
  // 而这种错要等到把成片放出来才听得见）
  let voice = "";
  if (kind === "audio") {
    const picked = canvasResolveVoice(node, p);
    if (picked.error) { canvasToast(picked.error, "triangle-alert", "err"); return { ok: false, error: picked.error }; }
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
  // 统一风格摆在最前面（见 canvasShotStyle）：只有镜头卡的首帧和视频带，配音、定妆照、场景图不带
  const style = castKind || kind === "audio" ? "" : canvasShotStyle(p, nodeKind);
  const prompt = castPrompt ? [castPrompt, context].filter(Boolean).join("\n") : kind === "image"
    ? [canvasStyledPrompt(p.prompt || p.description || p.text || "", style), context].filter(Boolean).join("\n")
    : kind === "video"
      // 首帧已经把画面定死了，这一枪只该说「怎么动」。把首帧提示词再递一遍，模型会照着它重画一遍画面，
      // 生出来的片子跟你刚确认过的那张首帧对不上（skill 第 4 节）。所以有运镜提示词就只用它。
      ? [canvasStyledPrompt(p.motion_prompt || p.prompt || p.description || "保持角色和场景一致，动作自然，镜头运动克制。", style), canvasIsPlaceholderPrompt(p.line) ? "" : `对白/旁白：${p.line}`, context].filter(Boolean).join("\n")
      : String(p.text || p.line || p.description || "").trim();
  const model = kind === "audio" ? "" : canvasDramaModel(p, kind, nodeKind);
  if (!prompt) { canvasToast(kind === "audio" ? "请先填写对白或音乐说明。" : "请先填写生成提示词。", "triangle-alert", "err"); return { ok: false, error: "缺提示词" }; }
  const input = kind === "image"
    // 参考图这一栏自己也把一道关：节点上随手填的 reference 也可能不是图，四个位子本来就不够几个角色分
    ? { prompt, reference_images: [...new Set([p.reference, p.first_frame, ...upstream].map((v) => String(v || "").trim()).filter((v) => v && CANVAS_REF_IMAGE_EXT.test(v.split(/[?#]/)[0])))].slice(0, 4), ...(model ? { model } : {}), filename: canvasOutputFilename(p, "image", nodeKind) }
    : kind === "video"
      ? { prompt, first_frame: firstFrame, ...(p.last_frame ? { last_frame: p.last_frame } : {}), ...canvasVideoSpec(p, nodeKind), ...(model ? { model } : {}), filename: canvasOutputFilename(p, "video", nodeKind) }
      : { text: prompt, ...(voice ? { voice } : {}), filename: canvasOutputFilename(p, "audio", nodeKind) };
  const castLabel = castKind === "character" ? "定妆照" : castKind === "location" ? "场景图" : CANVAS_NODE_DEFS[kind].label;
  canvasState.busy.add(key); canvasRefreshNode(node); canvasRenderInspector(false);
  // 一枪几十秒，这期间节点可能被删、被撤销、整张图被远端同步重铺（节点对象全换新的），
  // 也可能人已经切去别的画布。所以现在只记「是谁、在哪张画布」，回来按 id 重新取，
  // 手里这个 node 对象到时候可能已经是个孤儿：往它身上写，屏幕上看不到，存盘也存不进去
  const id = node.id, board = canvasState.canvasName, project = canvasState.workspaceName, graphAtStart = canvasState.graph;
  if (canvasState.inflight) canvasState.inflight.add(id);
  const startedAt = Date.now();   // 真跑过多久要记下来，不然「还要多久」永远只能靠猜
  let placed = false;
  try {
    // 落进「短剧/画布名」：两张画布里都有 S1-01，不分目录就是互相覆盖
    const subdir = canvasOutputSubdir(board);
    const tool = kind === "audio" ? "text_to_speech" : `generate_${kind}`;
    if (!castKind) {
      // 镜头产物带版本号，号从「已有的最大版本 + 1」来：别的标签页、上一次会话生过的也得算上，
      // 所以开枪前把素材台账重读一遍（几秒内读过就不重读，一键补齐连着跑几十镜不必每镜都扫一遍盘）。
      // 定妆照 / 场景图不带号：它们是后面每一镜的参考图，名字一变，引用它的地方全得跟着改
      if (typeof canvasLoadAssets === "function" && Date.now() - (Number(canvasState.assetsCheckedAt) || 0) > 4000) {
        canvasState.assetsCheckedAt = Date.now();
        try { await canvasLoadAssets(); } catch {}
      }
    }
    // 默认复用：同参数生过、那一份还在，就不再花钱（「换一版」除外）。
    // 以前这里写死 no_cache: true，同一张图点几次付几次钱。
    // 指纹不含文件名：带号的文件名每一枪都不一样，算进去就永远对不上
    const sig = canvasInputSig(tool, input, subdir, canvasCurrentOutput(p, kind, castKind || nodeKind));
    const reuse = fresh ? null : canvasReuseTarget(p, kind, sig, castKind || nodeKind);
    if (reuse && reuse.current) {
      // 卡片上挂着的就是同参数生的那份：什么都不改、一个请求都不发，只说一声，并把「换一版」递到手边
      canvasToast("参数没变，沿用现在这一版，没扣费。要新的点「换一版」，会重新扣费。", "circle-check", undefined,
        { label: "换一版", run: () => canvasReroll(canvasState.graph?.getCell?.(id) || node, kind) });
      return { ok: true, reused: true };
    }
    let result;
    if (reuse) {
      // 这一镜以前用同样的参数生过（改了提示词又改回来）：卡片改指那一版，不发请求。
      // 走下面同一条路——记生成记录、换结果卡、回写分镜表，跟真生成回来一模一样
      result = { ok: true, path: reuse.same, cached: true, reusedVersion: true };
    } else {
      if (!castKind) input.filename = canvasOutputFilename(p, kind, nodeKind, canvasNextVersion(p, kind, node, board));
      // 「换一版」：版本号照常 +1，再带上 no_cache，服务端就不会拿缓存顶——这一枪是人明确要花的。
      // 定妆照 / 场景图已经有一张却没被上面认作同参数：那个文件可能已被别的参数覆盖过，
      // 服务端缓存只看文件在不在，会把覆盖后的图当「沿用了上次的，没扣费」递回来，所以也绕过
      if (fresh || (castKind && canvasCurrentOutput(p, kind, castKind))) input.no_cache = true;
      result = await canvasRunTool({ tool, input, ...(subdir ? { subdir } : {}) }, kind === "audio" ? "tts" : kind);
    }
    // 换了备用模型生出来的不记指纹：指纹是按原来那个模型算的，记上了下次同参数就会把备用模型的图
    // 当成「原模型生过的」沿用下去——等于悄悄降级。不记，下次点生成还先试人家选的那个模型
    result.sig = result.fallbackFrom ? "" : sig;
    // path 是相对工作区的完整路径（带子目录），file 只是个文件名：先认 path，老服务端没有 path 才退回 file
    const file = String(result.path || result.file || "").trim();
    if (!file) throw new Error("生成接口成功，但没有返回产物路径");
    // 画布页重画那一小会儿图是空的（先拆后建），不能当成「人走了」：等它建好，最多等 3 秒
    for (let i = 0; i < 30 && graphAtStart && !canvasState.graph; i += 1) await new Promise((r) => setTimeout(r, 100));
    // 换了画布、或者图拆了没再建起来，都算不在这儿；回到同一张画布之后图是新的，按 id 照样取得到
    const here = canvasState.canvasName === board && canvasState.workspaceName === project && (!graphAtStart || !!canvasState.graph);
    const live = !here ? null : canvasState.graph ? canvasState.graph.getCell(id) : graphAtStart ? null : node;
    if (!live) {
      // 钱已经花了、文件也落进了工作区，只是没地方放：不往孤儿身上写，也不往别的画布上写
      const gone = here ? "节点已不在画布上，生成的文件已存进工作区，没有放回画布。" : "已离开发起生成的画布，文件已存进工作区，没有放回画布。";
      canvasToast(gone, "triangle-alert", "err");
      return { ok: false, error: gone };
    }
    node = live;
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
    placed = true;
    canvasState.selected = node.id; canvasRefreshNode(node); canvasPersist(); canvasRenderInspector(false);
    // 画布上摆着路径不等于分镜表里有这一笔。这两处分家的代价是真金白银（短剧页会让人再买一遍），
    // 所以回写失败要跟「已生成」摆在同一条提示里说，不能只在控制台留个影
    const boardKey = nodeKind === "shot" ? (kind === "image" ? "first_frame" : kind === "video" ? "video" : "audio")
      : castKind === "character" ? "ref" : "";
    const back = boardKey ? await canvasBoardWriteback(canvasPayload(node), { [boardKey]: file }) : "";
    const shortName = String(file).split(/[\\/]/).pop();
    // 没花钱的两种要说「没扣费」，不然人以为又付了一次；换了备用模型要写明换成了哪个（不静默换）
    const said = result.reusedVersion ? canvasT("参数跟 {n} 一样，已换回这一版，没扣费", { n: shortName })
      : result.cached ? canvasT("参数没变，沿用了上次的 {n}，没扣费", { n: shortName })
        : `${castLabel}已生成：${shortName}`;
    const swapped = result.fallbackFrom ? canvasT("（{a} 没成，按设置里的备用顺序换成了 {b}）", { a: result.fallbackFrom, b: String(input.model || "") }) : "";
    if (back) canvasToast(`${said}${swapped}，但${back}`, "triangle-alert", "err");
    else canvasToast(`${said}${swapped}`, swapped ? "triangle-alert" : "circle-check");
    if (typeof previewFile === "function") previewFile(canvasResolvedFileName(file));
    // 回写分镜表没成也算「做好了」：画布上这一格确实有了，重跑只会再花一次钱
    return { ok: true };
  } catch (error) {
    const msg = String(error.message || error).slice(0, 180);
    // 文件已经放上画布之后才出的错（回写、预览那几步）：这一格是做好了的，不能按「没成」算——
    // 算成没成，「重试失败的」那颗按钮就会让人为一张已经有了的图再付一次钱。错照样留痕
    if (placed) { console.warn(`[canvas] ${castLabel}已放上画布，之后的步骤出错：${msg}`); return { ok: true }; }
    canvasToast(`${castLabel}生成失败：${msg}`, "circle-x", "err");
    return { ok: false, error: msg };
  } finally {
    canvasState.busy.delete(key);
    // 同一个节点可能还有另一枪在跑（图和配音一起点的），那一枪回来前它还算在途
    if (canvasState.inflight && ![...canvasState.busy].some((k) => String(k).startsWith(`${id}:`))) canvasState.inflight.delete(id);
    // 刷的是现在图上的那一张（远端重铺过的话已经是新对象了），不在了就不刷
    const cur = canvasState.graph ? canvasState.graph.getCell(id) : node;
    if (cur) canvasRefreshNode(cur);
    canvasRenderInspector(false);
  }
}

/**
 * 发一枪生成。没成就用**同一个模型**再补一枪；还不成，而且用户在设置里亲手排了这一路的备用模型顺序
 * （settingsCache.media_fallback[cap]，一个模型名数组），才按那个顺序换——没排就原样报错，不替人换：
 * 换模型等于换了画风 / 音色，价钱也可能不一样。真换了，把原来那个记在 result.fallbackFrom，
 * 并把 body.input.model 改成真用上的那个，生成记录和提示里都写明。
 *
 * 只对「可能是一时的」失败补枪：网络断了、5xx、408、429、工具自己报错（上游超时多半长这样）。
 * 400 / 402 / 403 / 404 是参数、余额、权限的事，再发一遍还是一样，白等一轮。
 * 回执带 submitted 的也不补：上游已经收下那一单（视频等结果超时、下载断了），多半照样扣费，补一枪是再买一次。
 * 一键补齐按了「停下」就不再补枪：停的意思是不再开新的。
 * 成了返回服务端那份结果；最后还是没成就抛错，错误原文照搬，不猜原因
 */
async function canvasRunTool(body, cap) {
  const send = async (b) => {
    try {
      const response = await fetch("/api/tool/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
      const result = await response.json().catch(() => ({}));
      return { response, result, ok: !!response.ok && !result.isError && result.ok !== false };
    } catch (error) { return { error, result: {}, ok: false }; }
  };
  const transient = (r) => {
    if (r.error) return true;
    if (r.result && r.result.submitted) return false;
    const st = Number(r.response && r.response.status) || 0;
    if (!r.response.ok) return !st || st >= 500 || st === 408 || st === 429;
    return true;   // 200 但工具报错
  };
  const reason = (r) => String((r.error && (r.error.message || r.error)) || r.result.error || r.result.content || "生成失败");
  const stopped = () => !!(canvasState.batch && canvasState.batch.stop);
  let r = await send(body);
  if (r.ok) return r.result;
  if (!transient(r) || stopped()) throw new Error(reason(r));
  await new Promise((done) => setTimeout(done, 1000));
  r = await send(body);
  if (r.ok) return r.result;
  const firstError = reason(r);
  if (!transient(r) || stopped()) throw new Error(firstError);
  const cache = typeof settingsCache !== "undefined" ? settingsCache : null;
  const order = cache && cache.media_fallback && Array.isArray(cache.media_fallback[cap]) ? cache.media_fallback[cap].map((m) => String(m || "").trim()).filter(Boolean) : [];
  const input = body.input || {};
  const models = Array.isArray(cache?.media_models) ? cache.media_models.filter((m) => m && m.cap === cap) : [];
  const def = models.find((m) => m.default) || models[0];
  const was = String(input.model || (def ? def.model || def.name : "") || "");
  for (const model of order) {
    if (model === was || stopped()) continue;
    const tried = await send({ ...body, input: { ...input, model } });
    if (tried.ok) { input.model = model; return { ...tried.result, fallbackFrom: was || "默认模型" }; }
  }
  throw new Error(firstError);
}

// 「换一版」：同样的参数也要一张新的。版本号 +1、带 no_cache，所以一定会重新扣费（按钮旁边写着）
function canvasReroll(node, kind) {
  if (!node) return;
  if (!(canvasState.reroll instanceof Set)) canvasState.reroll = new Set();
  canvasState.reroll.add(`${node.id}:${kind}`);
  return canvasGenerate(node, kind);
}
