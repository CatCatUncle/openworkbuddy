/* 无限画布 · 画布的存取（第 4 片）
 *
 * 画布列表和项目切换、新建短剧和起草分镜、统一画风、删画布，
 * 保存到本机和服务端、多端改同一张画布时的合并与冲突处理、读回和恢复快照、定时同步。
 * 加载顺序见 app-03.js 的 loadCanvasDeps，各片分工见入口 app-07-canvas.js 开头。
 */
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

/**
 * 短剧设定（画幅、每镜时长、统一风格、生图 / 生视频模型）记在剧本卡上。
 * 为什么不记在画布上：新建画布那条接口只收名字（POST /api/canvas/boards），画布本身没地方放；
 * 剧本卡是这部戏的起点，出分镜表时本来就从它出发，设定跟着它走最顺。
 * 卡上没写的那几项用 base 补；base 也没有就是默认值（9:16、每镜 5 秒、不加风格、模型沿用设置）
 */
const CANVAS_DRAMA_ASPECTS = [["9:16", "9:16 竖屏"], ["16:9", "16:9 横屏"], ["1:1", "1:1 方形"]];
const CANVAS_DRAMA_KEYS = ["aspect", "shot_seconds", "style", "image_model", "video_model"];
function canvasDramaOf(p, base) {
  const d = base || { aspect: "9:16", shotSeconds: 5, style: "", imageModel: "", videoModel: "" }, src = p || {};
  const seconds = Number(src.shot_seconds);
  return {
    aspect: CANVAS_DRAMA_ASPECTS.some(([v]) => v === String(src.aspect || "")) ? String(src.aspect) : d.aspect,
    shotSeconds: src.shot_seconds !== "" && Number.isFinite(seconds) && seconds >= 1 && seconds <= 60 ? seconds : d.shotSeconds,
    // style 写成空串是「这张卡明说不要风格」，跟没写过不是一回事
    style: typeof src.style === "string" ? src.style.trim() : d.style,
    imageModel: String(src.image_model || d.imageModel || ""), videoModel: String(src.video_model || d.videoModel || ""),
  };
}
// 这张画布的短剧设定：认第一张写过设定的剧本卡。一张都没有就是默认值
function canvasDramaSettings() {
  const nodes = canvasState.graph && typeof canvasState.graph.getElements === "function" ? canvasState.graph.getElements() : [];
  const card = nodes.find((n) => canvasKind(n) === "script" && CANVAS_DRAMA_KEYS.some((k) => { const v = canvasPayload(n)[k]; return v != null && v !== ""; }));
  return canvasDramaOf(card ? canvasPayload(card) : null);
}
// 表单填的 → 剧本卡上存的字段。空着的不写：写个空串进去，就成了「明说不要」
function canvasDramaPayload(form) {
  const f = form || {};
  return {
    aspect: String(f.aspect || "9:16"), shot_seconds: Number(f.shotSeconds) || 5,
    ...(String(f.style || "").trim() ? { style: String(f.style).trim() } : {}),
    ...(f.imageModel ? { image_model: String(f.imageModel) } : {}), ...(f.videoModel ? { video_model: String(f.videoModel) } : {}),
  };
}
// 新建短剧时填的那几项，等新画布铺好了交给它的剧本卡。只交给同一张画布，交完就清
function canvasTakeSeedDrama() {
  const seed = canvasState.seedDrama;
  if (!seed || seed.scope !== canvasScope()) return null;
  canvasState.seedDrama = null;
  return seed.settings || null;
}

/**
 * 「新建短剧」表单：名字之外一次问全画幅、每镜时长、统一风格、生成模型。
 * 模型默认沿用设置里的，旁边写单价（异步问 /api/tool/estimate，问不到就原话说没拿到，不编一个数）。
 * 回 { name, aspect, shotSeconds, style, imageModel, videoModel }；取消回空串
 */
function canvasAskNewBoardName() {
  return new Promise((resolve) => {
    document.getElementById("canvas-create-board-dialog")?.remove();
    const defaultName = "短剧_" + new Date().toISOString().slice(5, 10).replace("-", "");
    const cache = typeof settingsCache !== "undefined" ? settingsCache : null;
    const modelSelect = (name, cap) => {
      const models = Array.isArray(cache?.media_models) ? cache.media_models.filter((m) => m && m.cap === cap && (m.model || m.name)) : [];
      const def = models.find((m) => m.default) || models[0], defId = def ? String(def.model || def.name) : "";
      const options = models.map((m) => { const id = String(m.model || m.name); return `<option value="${esc(id)}">${esc(m.name && m.name !== id ? `${m.name} · ${id}` : id)}</option>`; }).join("");
      return `<select name="${name}"><option value="" selected>${esc(defId ? canvasT("沿用设置：{n}", { n: defId }) : "沿用设置")}</option>${options}</select>`;
    };
    const overlay = document.createElement("div"); overlay.id = "canvas-create-board-dialog"; overlay.className = "canvas-create-board-dialog";
    overlay.innerHTML = `<form class="canvas-create-board-card canvas-drama-form" novalidate><div class="canvas-create-board-head"><span class="canvas-create-board-icon">${ic("map")}</span><div><b>新建短剧</b><small>一张画布对应一个短剧任务</small></div></div>`
      + `<label><span>画布名称</span><input name="canvasName" maxlength="80" autocomplete="off" value="${esc(defaultName)}" placeholder="例如：外卖小哥第 1 集"></label>`
      + `<div class="canvas-drama-row"><label><span>画幅</span><select name="aspect">${CANVAS_DRAMA_ASPECTS.map(([v, label]) => `<option value="${v}" ${v === "9:16" ? "selected" : ""}>${label}</option>`).join("")}</select></label>`
      + `<label><span>每镜时长（秒）</span><input name="shotSeconds" type="number" min="1" max="60" step="1" value="5"></label></div>`
      + `<label><span>统一风格（可留空）</span><input name="style" maxlength="300" autocomplete="off" placeholder="例如：冷蓝夜色，胶片颗粒"></label>`
      + `<label><span>生图模型</span>${modelSelect("imageModel", "image")}<small class="canvas-drama-price" data-drama-price="image"></small></label>`
      + `<label><span>生视频模型</span>${modelSelect("videoModel", "video")}<small class="canvas-drama-price" data-drama-price="video"></small></label>`
      + `<div class="canvas-create-board-error" aria-live="polite"></div><div class="canvas-create-board-actions"><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-canvas-create-cancel>取消</button><button type="submit" class="ui-btn ui-btn--brand ui-btn--sm">创建</button></div></form>`;
    const finish = (value) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
    const onKey = (event) => { if (event.key === "Escape") finish(""); };
    // 单价：换一个模型问一次。问的时候那一格先空着，回来时模型已经又换了就不写（写上去的是上一个的价）
    const fillPrice = async (cap) => {
      const spot = overlay.querySelector(`[data-drama-price="${cap}"]`), select = overlay.querySelector(`select[name="${cap}Model"]`);
      if (!spot || !select) return;
      const model = select.value; spot.textContent = "";
      const { est, error } = await canvasEstimate([{ tool: cap === "video" ? "generate_video" : "generate_image", input: model ? { model } : {} }]);
      if (!spot.isConnected || select.value !== model) return;
      const row = est && est.items[0], unit = Number(row && row.unitPrice);
      // 计价单位（张 / 秒）整句收进词典，英文界面才不会冒出半句中文
      const template = { 张: "单价 {m}/张", 秒: "单价 {m}/秒" }[row && row.unit] || "单价 {m}/{u}";
      spot.textContent = !est ? canvasT("没拿到单价：{n}", { n: error })
        : row && row.known && Number.isFinite(unit) ? canvasT(template, { m: canvasFormatYuan(unit), u: row.unit || "" }) : canvasT("单价未知");
    };
    // 表单挂了 novalidate：时长填错时浏览器自带的气泡不跟界面语言走、也不说范围，校验一律在下面 submit 里做
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(""); });
    overlay.querySelector("[data-canvas-create-cancel]").addEventListener("click", () => finish(""));
    ["image", "video"].forEach((cap) => overlay.querySelector(`select[name="${cap}Model"]`)?.addEventListener("change", () => fillPrice(cap)));
    overlay.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault(); const form = event.currentTarget, input = form.querySelector('input[name="canvasName"]'), name = String(input.value || "").trim(), error = form.querySelector(".canvas-create-board-error");
      if (!name) { error.textContent = "请输入画布名称"; input.focus(); return; }
      if (/[\\/\0]/.test(name)) { error.textContent = "名称不能包含斜杠"; input.focus(); return; }
      if (canvasState.canvasList.some((item) => item.name === name)) { error.textContent = "已经有同名画布，请换一个名称"; input.focus(); input.select(); return; }
      const seconds = Number(form.querySelector('input[name="shotSeconds"]').value);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) { error.textContent = "每镜时长要在 1 到 60 秒之间"; form.querySelector('input[name="shotSeconds"]').focus(); return; }
      finish({
        name, aspect: form.querySelector('select[name="aspect"]').value || "9:16", shotSeconds: seconds,
        style: String(form.querySelector('input[name="style"]').value || "").trim(),
        imageModel: form.querySelector('select[name="imageModel"]').value || "", videoModel: form.querySelector('select[name="videoModel"]').value || "",
      });
    });
    document.addEventListener("keydown", onKey); document.body.appendChild(overlay);
    fillPrice("image"); fillPrice("video");
    const input = overlay.querySelector('input[name="canvasName"]'); requestAnimationFrame(() => { input.focus(); input.select(); overlay.classList.add("is-open"); });
  });
}

async function canvasCreateBoard() {
  // 起名框回的是整张表单 { name, aspect, … }；只回一个名字的（老调用方、测试桩）照旧只建画布
  const asked = await canvasAskNewBoardName();
  const form = asked && typeof asked === "object" ? asked : null;
  const name = form ? String(form.name || "").trim() : asked;
  if (!name) return;
  await canvasFlushRemoteWrite();   // 手上这张还欠着一趟存盘，先写完再换人
  const response = await fetch("/api/canvas/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return canvasToast(data.error || "新建画布失败", "circle-x", "err");
  canvasState.canvasName = data.name || name; try { localStorage.setItem("openworkbuddy.canvas.name", canvasState.canvasName); } catch {}
  // 以前叫这个名字的画布留下的本机副本，跟这张新的没有关系。不擦掉的话，删一张再建一张同名的，
  // 上面原样长出删掉那张的东西，还会被存回服务器——用户明明删过一次
  try { localStorage.removeItem(canvasStorageKey(canvasState.canvasName)); } catch {}
  canvasClearPendingConflict(canvasScope(canvasState.canvasName));
  // 表单填的设定交给起手那张剧本卡（canvasRestoreOrSeed 铺卡时取走）
  canvasState.seedDrama = form ? { scope: canvasScope(canvasState.canvasName), settings: canvasDramaPayload(form) } : null;
  await renderCanvasPage();
  // 没取走 = 起手卡没铺（盘上这张已经有人动过）。设定不能就这么丢了：单独放一张剧本卡
  const left = canvasTakeSeedDrama();
  if (left) canvasAddNode("script", { title: "一句话概念", text: "在这里写一句话概念、人物关系、冲突、对白和结局。", ...left }, undefined, { skipSelect: true });
  canvasState.seedDrama = null;
  canvasToast(`已创建画布「${canvasState.canvasName}」`, "circle-check");
}
/**
 * 剧本卡上的「生成分镜表」：剧本 → 草稿 → 人看过改过 → 放到画布上。
 *
 * 两步走是故意的：draft 那条只出草稿不落盘，commit 那条才写分镜表（server.js 两条路由）。
 * 一步到位的话，模型拆坏的一版会先把盘上那份真源盖掉，人还一眼没看过。
 * 这一下是真调对话模型、真花 token 的（用设置里当前那个对话模型，不在这儿另挑），
 * 所以卡上那句成本提示一直挂着，生成中按钮锁住，免得手快点两下花两份钱
 */
async function canvasDraftStoryboard(node) {
  if (!node || canvasKind(node) !== "script" || canvasState.drafting.has(node.id)) return;
  const p = canvasPayload(node), script = String(p.text || "").trim();
  // 占位文字发出去也是 400，但那一趟白跑还让人以为模型坏了。先在这儿拦住，一个请求都不发
  if (canvasIsPlaceholderPrompt(script)) { canvasToast("先写剧本内容，再生成分镜表。", "triangle-alert", "err"); return; }
  const ctx = { scriptId: node.id, scope: canvasScope(), canvas: canvasState.canvasName };
  const drama = canvasDramaOf(p, canvasDramaSettings());
  canvasState.drafting.add(node.id); canvasRefreshNode(node);
  let out = null;
  try {
    const r = await fetch("/api/drama/storyboard/draft", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canvas: ctx.canvas, script, aspect: drama.aspect, shotSeconds: drama.shotSeconds, ...(drama.style ? { style: drama.style } : {}) }),
    });
    out = await r.json().catch(() => null);
    // 失败原样说服务端那句（额度不够、超时、模型两次都没给出合格的表），不替它猜原因
    if (!r.ok || !out || !out.draft) throw new Error((out && out.error) || "HTTP " + r.status);
  } catch (e) {
    canvasToast(canvasT("分镜表没生成：{n}", { n: String((e && e.message) || e).slice(0, 140) }), "circle-x", "err");
    return;
  } finally {
    canvasState.drafting.delete(ctx.scriptId);
    const live = canvasState.graph && canvasState.graph.getCell(ctx.scriptId);
    if (live) canvasRefreshNode(live);
  }
  canvasOpenDraftPreview(out, ctx);
}

/**
 * 草稿预览：一镜一行（镜头号、景别、画面、台词、时长），格子都能改，整行能删。
 * 点「放到画布上」才 commit；盘上已经有一份（409）就问追加 / 替换 / 取消，不替人挑。
 * 改动都在草稿的副本上，取消就是整份扔掉，盘上和画布上都没动过。
 * Esc 和点遮罩不关它：这份草稿是花 token 买来的，手一滑没了还得再花一次
 */
function canvasOpenDraftPreview(out, ctx) {
  document.getElementById("canvas-draft-dialog")?.remove();
  const draft = JSON.parse(JSON.stringify((out && out.draft) || {}));
  const scenes = Array.isArray(draft.scenes) ? draft.scenes : [];
  const warnings = (Array.isArray(out && out.warnings) ? out.warnings : []).map((w) => String(w || "").trim()).filter(Boolean);
  const usage = (out && out.usage) || {}, tokens = (Number(usage.prompt) || 0) + (Number(usage.completion) || 0);
  const ai = '<span class="canvas-ai-badge" title="这一镜由对话模型生成">AI 生成</span>';
  const rows = scenes.map((scene, si) => {
    const shots = Array.isArray(scene && scene.shots) ? scene.shots : [];
    const where = [scene && scene.place, scene && scene.time].map((v) => String(v || "").trim()).filter(Boolean).join(" · ");
    return `<tr class="canvas-draft-scene" data-draft-scene="${si}"><td colspan="6"><b>${esc(String((scene && scene.id) || ""))}</b><span>${esc(where)}</span></td></tr>`
      + shots.map((shot, ji) => `<tr data-draft-row="${si}:${ji}"><td><input data-draft-cell="id" value="${esc(String(shot.id || ""))}" aria-label="镜头号"></td><td><input data-draft-cell="shot_size" value="${esc(String(shot.shot_size || ""))}" aria-label="景别"></td><td><textarea data-draft-cell="frame_prompt" rows="3" aria-label="画面">${esc(String(shot.frame_prompt || ""))}</textarea></td><td><textarea data-draft-cell="line" rows="3" aria-label="台词">${esc(String(shot.line || ""))}</textarea></td><td><input data-draft-cell="duration" type="number" min="0" step="0.5" value="${esc(shot.duration == null ? "" : String(shot.duration))}" aria-label="时长"></td><td class="canvas-draft-tail">${ai}<button type="button" class="canvas-draft-remove" data-draft-remove title="删掉这一镜" aria-label="删掉这一镜">${ic("x")}</button></td></tr>`).join("");
  }).join("");
  const overlay = document.createElement("div"); overlay.id = "canvas-draft-dialog"; overlay.className = "canvas-create-board-dialog canvas-draft-dialog";
  overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `<form class="canvas-create-board-card canvas-draft-card" novalidate><div class="canvas-create-board-head"><span class="canvas-create-board-icon">${ic("sparkles")}</span><div><b>分镜表草稿</b><small>改好再放到画布上，这一步还没写盘。</small></div><span class="canvas-ai-badge" title="这份草稿由对话模型生成">AI 生成</span></div>`
    + `<label class="canvas-draft-style"><span>统一风格</span><input data-draft-style maxlength="300" autocomplete="off" value="${esc(String(draft.style || ""))}" placeholder="可留空，例如：冷蓝夜色，胶片颗粒"></label>`
    + (warnings.length ? `<ul class="canvas-draft-warnings">${warnings.slice(0, 8).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "")
    + `<div class="canvas-draft-scroll"><table class="canvas-draft-table"><colgroup><col class="canvas-draft-col-id"><col class="canvas-draft-col-size"><col><col><col class="canvas-draft-col-sec"><col class="canvas-draft-col-tail"></colgroup><thead><tr><th>镜头号</th><th>景别</th><th>画面</th><th>台词</th><th>时长</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    + `<div class="canvas-draft-meta"><span data-draft-count></span>${tokens > 0 ? `<span data-draft-usage>${esc(canvasT("本次用了 {n} token", { n: tokens }))}</span>` : ""}</div>`
    + `<div class="canvas-create-board-error" data-draft-error aria-live="polite"></div><div class="canvas-create-board-actions"><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-draft-cancel>取消</button><button type="submit" class="ui-btn ui-btn--brand ui-btn--sm" data-draft-commit>放到画布上</button></div></form>`;
  const form = overlay.querySelector("form"), errBox = overlay.querySelector("[data-draft-error]"), commit = overlay.querySelector("[data-draft-commit]");
  let busy = false;
  // 场次数、镜头数跟着删行走；一镜都不剩就不许提交（分镜表每场至少一镜，交上去也是 400）
  const recount = () => {
    const left = [...overlay.querySelectorAll("tr[data-draft-row]")];
    const sceneIds = new Set(left.map((tr) => tr.dataset.draftRow.split(":")[0]));
    overlay.querySelectorAll("tr[data-draft-scene]").forEach((tr) => { tr.hidden = !sceneIds.has(tr.dataset.draftScene); });
    const count = overlay.querySelector("[data-draft-count]");
    if (count) count.textContent = canvasT("{s} 场 {n} 镜", { s: sceneIds.size, n: left.length });
    commit.disabled = busy || !left.length;
  };
  // 从表格里把人改过的读回草稿副本。时长空着就不写（分镜表里时长是量完回写的，本来就可以没有）
  const collect = () => {
    const next = JSON.parse(JSON.stringify(draft)), keep = new Map();
    let bad = "";
    overlay.querySelectorAll("tr[data-draft-row]").forEach((tr) => {
      const [si, ji] = tr.dataset.draftRow.split(":").map(Number);
      const shot = { ...((next.scenes[si] && next.scenes[si].shots && next.scenes[si].shots[ji]) || {}) };
      tr.querySelectorAll("[data-draft-cell]").forEach((field) => {
        const key = field.dataset.draftCell, value = String(field.value || "").trim();
        if (key === "duration") {
          // 数字框里敲了认不出的（比如「5e」），value 读出来是空串；不能当「没填」悄悄把时长删掉
          const unreadable = !value && field.validity && field.validity.badInput;
          if (!value && !unreadable) { delete shot.duration; return; }
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) { bad = bad || canvasT("{n} 的时长要是大于 0 的秒数", { n: shot.id || `${si + 1}-${ji + 1}` }); return; }
          shot.duration = n;
        } else if (key === "line") { if (value) shot.line = value; else delete shot.line; }
        else shot[key] = value;
      });
      if (!keep.has(si)) keep.set(si, []);
      keep.get(si).push(shot);
    });
    next.scenes = (Array.isArray(next.scenes) ? next.scenes : []).map((scene, si) => ({ ...scene, shots: keep.get(si) || [] })).filter((scene) => scene.shots.length);
    const style = String(overlay.querySelector("[data-draft-style]").value || "").trim();
    if (style) next.style = style; else delete next.style;
    return { next, bad };
  };
  const setBusy = (on) => { busy = on; commit.textContent = canvasT(on ? "提交中…" : "放到画布上"); recount(); };
  overlay.querySelectorAll("[data-draft-remove]").forEach((button) => button.addEventListener("click", () => { button.closest("tr")?.remove(); errBox.textContent = ""; recount(); }));
  overlay.querySelector("[data-draft-cancel]").addEventListener("click", () => overlay.remove());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const { next, bad } = collect();
    if (bad) { errBox.textContent = bad; return; }
    if (!next.scenes.length) return;
    errBox.textContent = ""; setBusy(true);
    let mode = "new", base = null;
    try {
      // 画布上连着的分镜表节点已经指着某一份，就写那一份；没有就落这张画布的默认位置（服务端按画布名算）
      const live = canvasScope() === ctx.scope && canvasState.graph ? canvasState.graph.getCell(ctx.scriptId) : null;
      const target = live ? canvasDraftTarget(live) : null, name = target ? String(canvasPayload(target).board || "").trim() : "";
      for (;;) {
        const body = { canvas: ctx.canvas, draft: next, mode, ...(name ? { name } : {}), ...(base != null ? { baseUpdatedAt: base } : {}) };
        const r = await fetch("/api/drama/storyboard/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const got = (await r.json().catch(() => null)) || {};
        if (r.status === 409) {
          // 盘上已经有一份，或者这一会儿被别处改过：追加还是替换是两种后果，只能人来定
          const pick = await canvasAskDraftMode(got);
          if (!pick) return;   // 取消：草稿还开着，接着改或者关掉都行
          mode = pick; base = got.updatedAt == null ? null : got.updatedAt;
          continue;
        }
        if (!r.ok || !got.ok) { errBox.textContent = String(got.error || "HTTP " + r.status); return; }
        overlay.remove();
        await canvasPlaceCommitted(ctx, got, next, mode);
        return;
      }
    } catch (e) {
      errBox.textContent = String((e && e.message) || e);
    } finally { if (overlay.isConnected) setBusy(false); }
  });
  document.body.appendChild(overlay); recount();
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  return overlay;
}

// 剧本卡连出去的那张分镜表卡（「新建画布」起手就是这么连的）。没连就是没有
function canvasDraftTarget(script) {
  const graph = canvasState.graph;
  if (!graph || !script) return null;
  return graph.getLinks().filter((link) => (link.get("source") || {}).id === script.id)
    .map((link) => graph.getCell((link.get("target") || {}).id)).find((n) => n && canvasKind(n) === "storyboard") || null;
}

/**
 * 盘上已经有分镜表时问一句：追加 / 替换 / 取消。三选一，确认框只有两颗按钮，所以自己摆一个。
 * 两颗动作按钮一样重，不把哪个做成主按钮——主按钮就是在替人挑。Esc、点遮罩都算取消
 */
function canvasAskDraftMode(out) {
  return new Promise((resolve) => {
    document.getElementById("canvas-draft-choice")?.remove();
    const o = out || {}, s = o.summary || null;
    const overlay = document.createElement("div"); overlay.id = "canvas-draft-choice"; overlay.className = "canvas-create-board-dialog canvas-draft-choice";
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `<div class="canvas-create-board-card"><div class="canvas-create-board-head"><span class="canvas-create-board-icon">${ic("triangle-alert")}</span><div><b>${o.conflict ? "分镜表刚被别处改过" : "这张画布已经有分镜表了"}</b><small>${esc(String(o.name || ""))}</small></div></div>`
      + (s ? `<p class="canvas-draft-choice-note">${esc(canvasT("现有 {s} 场 {n} 镜", { s: Number(s.scenes) || 0, n: Number(s.shots) || 0 }))}</p>` : "")
      + `<p class="canvas-draft-choice-note">追加：接在原有镜头后面。替换：整份换掉，换前留快照。</p>`
      + `<div class="canvas-create-board-actions"><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-canvas-choice="cancel">取消</button><button type="button" class="ui-btn ui-btn--outline ui-btn--sm" data-canvas-choice="replace">替换</button><button type="button" class="ui-btn ui-btn--outline ui-btn--sm" data-canvas-choice="append">追加</button></div></div>`;
    const finish = (value) => { overlay.remove(); document.removeEventListener("keydown", onKey, true); resolve(value); };
    const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); finish(""); } };
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(""); });
    overlay.querySelectorAll("[data-canvas-choice]").forEach((button) => button.addEventListener("click", () => {
      const pick = button.dataset.canvasChoice;
      finish(pick === "append" || pick === "replace" ? pick : "");
    }));
    document.addEventListener("keydown", onKey, true); document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.classList.add("is-open"); overlay.querySelector('[data-canvas-choice="cancel"]')?.focus(); });
  });
}

/**
 * 分镜表写好之后摆到画布上：复用「展开场次与镜头」那一套（canvasBoardPlan + canvasApplyBoardPlan），
 * 按戳 upsert，再点一次不会多摆一份。模型出的那部分卡盖上 ai_generated，卡头显示「AI 生成」。
 * 追加的时候只有新接上去的那几场是模型出的：merge 把它们接在原表最后，所以按场次顺序数；
 * 角色按「名字 + 外貌都跟草稿一样」认（同名的老角色 merge 时留的是原表那份外貌）
 */
async function canvasPlaceCommitted(ctx, out, draft, mode) {
  const alive = () => (canvasScope() === ctx.scope && canvasState.graph ? canvasState.graph.getCell(ctx.scriptId) : null);
  const written = () => canvasToast(canvasT("分镜表已写好：{n}", { n: out.name }), "circle-check");
  let data = out.data;
  if (!data) {
    const r = await fetch("/api/drama/storyboard?name=" + encodeURIComponent(out.name)).then((x) => x.json()).catch(() => null);
    data = r && r.data;
  }
  // 人已经换了画布、或者剧本卡被删了：分镜表照样写好了，只是不往别处的画布上摆
  if (!data || !alive()) { written(); return; }
  await canvasLoadBoards();
  const script = alive();
  if (!script) { written(); return; }
  let sb = canvasDraftTarget(script);
  if (!sb) {
    const pos = script.position();
    sb = canvasAddNode("storyboard", {}, { x: pos.x + 410, y: pos.y }, { skipSelect: true, persist: false });
    if (sb) canvasConnect(script, sb);
  }
  if (!sb) { written(); return; }
  sb.set("canvasPayload", { ...canvasPayload(sb), board: out.name, style: String(data.style || "").trim() });
  canvasRefreshNode(sb);
  const plan = canvasBoardPlan(data, out.name);
  const draftScenes = Array.isArray(draft && draft.scenes) ? draft.scenes.length : 0;
  const firstNew = mode === "append" ? Math.max(0, plan.scenes.length - draftScenes) : 0;
  const same = (a, b) => String(a || "").trim() === String(b || "").trim();
  const draftCast = Array.isArray(draft && draft.characters) ? draft.characters : [];
  plan.scenes.forEach((scene, i) => {
    if (i < firstNew) return;
    scene.payload.ai_generated = true;
    scene.shots.forEach((shot) => { shot.payload.ai_generated = true; });
  });
  plan.characters.forEach((c) => {
    if (mode !== "append" || draftCast.some((d) => same(d.name, c.payload.name) && same(d.look, c.payload.description))) c.payload.ai_generated = true;
  });
  const stat = canvasApplyBoardPlan(sb, plan);
  canvasPersist();
  if (typeof canvasAutoLayout === "function") canvasAutoLayout(document.getElementById("assist-page"));
  const warn = (Array.isArray(out.warnings) ? out.warnings : []).map((w) => String(w || "").trim()).filter(Boolean);
  if (warn.length) canvasToast(canvasT("已放到画布上：{s} 场 {n} 镜。{w}", { s: stat.scenes, n: stat.shots, w: warn.slice(0, 2).join("；") }), "triangle-alert", "err");
  else canvasToast(canvasT("已放到画布上：{s} 场 {n} 镜", { s: stat.scenes, n: stat.shots }), "circle-check");
}

/**
 * 分镜表卡上改了统一风格 → 写回分镜表的 style，再把画布上这份表的镜头提示词跟着换掉。
 *
 * 为什么整份读一次再 PUT：逐字段回写那条（/api/drama/storyboard/output）只认镜头和角色的字段，不收 style。
 * 读和写之间要是别处刚好也改了这份表，那一笔会被这次覆盖——窗口只有一来一回，记进 open_issues 了。
 * 镜头卡上的提示词是展开时拿 frame_prompt 接上画风拼的，尾巴上那段老画风先剥掉再接新的，
 * 不然改几次堆几段。绝不抛：它挂在输入框的 change 上
 */
async function canvasBoardStyleSync(node) {
  const p = canvasPayload(node), name = String(p.board || "").trim();
  if (!name) return "";
  const style = String(p.style || "").trim();
  try {
    const r = await fetch("/api/drama/storyboard?name=" + encodeURIComponent(name));
    const got = await r.json().catch(() => null);
    if (!r.ok || !got || !got.data) throw new Error((got && got.error) || "HTTP " + r.status);
    const data = got.data;
    if (String(data.style || "").trim() !== style) {
      if (style) data.style = style; else delete data.style;
      const w = await fetch("/api/drama/storyboard", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, data }) });
      const res = await w.json().catch(() => null);
      if (!w.ok || !res || !res.ok) throw new Error((res && res.error) || "HTTP " + w.status);
    }
    canvasRestyleShots(name, style);
    return "";
  } catch (e) {
    return canvasT("风格没写回分镜表：{n}", { n: String((e && e.message) || e).slice(0, 140) });
  }
}
function canvasRestyleShots(name, style) {
  let changed = 0;
  (canvasState.graph ? canvasState.graph.getElements() : []).forEach((n) => {
    if (canvasKind(n) !== "shot") return;
    const p = canvasPayload(n);
    if (String(p.board || "").trim() !== name) return;
    const old = String(p.board_style || "").trim();
    if (old === style) return;
    const prompt = String(p.prompt || "").trim();
    const core = !old ? prompt : prompt === old ? "" : prompt.endsWith("\n" + old) ? prompt.slice(0, prompt.length - old.length - 1).trim() : prompt;
    const next = { ...p, prompt: [core, style].filter(Boolean).join("\n") };
    if (style) next.board_style = style; else delete next.board_style;
    n.set("canvasPayload", next); canvasRefreshNode(n); changed++;
  });
  if (changed) canvasPersist();
  return changed;
}
// 分镜表卡换了一份表：检查器里「统一风格」那一栏得是新那份的，不能还显示上一份的
async function canvasBoardStyleLoad(node) {
  const name = String(canvasPayload(node).board || "").trim();
  if (!name) return;
  const r = await fetch("/api/drama/storyboard?name=" + encodeURIComponent(name)).then((x) => x.json()).catch(() => null);
  if (!r || !r.data || !canvasState.graph || !canvasState.graph.getCell(node.id) || String(canvasPayload(node).board || "").trim() !== name) return;
  node.set("canvasPayload", { ...canvasPayload(node), style: String(r.data.style || "").trim() });
  canvasPersist();
  if (canvasState.selected === node.id && canvasState.inspectorOpen) canvasRenderInspector(false);
}

async function canvasDeleteBoard() {
  if (canvasState.canvasName === "main") return canvasToast("主画布不能删除。", "info");
  if (!(await askConfirm({ title: `删掉画布「${canvasState.canvasName}」？`, hint: "节点和连线一并删除，素材文件保留在工作区。", ok: "删掉", danger: true }))) return;
  await canvasFlushRemoteWrite();   // 欠着的那一趟要么现在写给它自己，要么等会儿写到 main 上去
  const gone = canvasState.canvasName;
  const response = await fetch("/api/canvas/boards/" + encodeURIComponent(gone), { method: "DELETE" });
  // 404 = 服务器上本来就没有这张（别的标签页先删了）：要的结果已经是这样，照常收尾回 main，
  // 报「删除失败」的话人会以为它还在，再点一次还是失败
  if (!response.ok && response.status !== 404) return canvasToast("删除画布失败", "circle-x", "err");
  try { localStorage.removeItem(canvasStorageKey(gone)); } catch {}   // 服务器那份删了，本机这份也得删
  canvasClearPendingConflict(canvasScope(gone));
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
  // 改了一张卡的镜头号，撞号的是另一张卡：红框得整张图一起重判
  if (typeof canvasMarkDupShots === "function") canvasMarkDupShots();
  if (canvasState.suspendSync) return;
  // 屏幕上这份跟服务器上那份一个字不差，就别再写一趟。省的不是流量，是那条死循环：
  // 服务端每写一次都把 updatedAt 换成现在，对面那个标签页看见就当是新改动，拉下来、
  // 铺上去、再写回来……两边每 1.8 秒各写一次盘，每次还连带把旧文件拷一份 .bak
  const contentKey = canvasHistoryKey(snapshot);
  // 先撤掉挂着的那一趟，再判要不要写。顺序反过来的话：改一笔（挂上 240ms 的写）、马上撤销回
  // 服务器那份——这一下判「一样，不用写」就走了，挂着的那趟照样烧，把撤销前的内容写上盘
  if (canvasState.remoteWriteTimer) { clearTimeout(canvasState.remoteWriteTimer); canvasState.remoteWriteTimer = null; }
  canvasState.remoteWriteArmed = null;
  // 正在写的那一趟还没回来时不能拿指纹抄近路：指纹还是写之前的，等那趟落了盘，服务器上就是
  // 撤销前的内容，屏幕上是撤销后的，两边从此对不上
  if (contentKey === canvasState.remoteContentKey && !canvasState.remoteWritePending) return;
  // 这一趟要写给哪张画布，现在就定死。等 240 毫秒后定时器烧到了再去读 canvasState.canvasName，
  // 这中间切走的话就写到下一张画布上了——实测防抖还没烧完就切画布，第二张画布上原来那个节点
  // 被第一张的内容整个顶掉，而且它自己的文件从此就是这样了
  const armed = { scope: canvasScope(), name: canvasState.canvasName, snapshot, contentKey };
  canvasState.remoteWriteArmed = armed;
  canvasState.remoteWriteTimer = window.setTimeout(() => { canvasState.remoteWriteTimer = null; canvasPushRemote(armed); }, 240);
}

/**
 * 把一份快照写回它自己那张画布。写给谁是按下那一刻记好的，不看现在选的是哪张。
 *
 * 写入排成一队：上一趟没回来，下一趟拿的还是旧的 baseUpdatedAt，盘上已经是上一趟写的了，
 * 这一趟必撞 409——而且合并时会把自己上一趟的改动当成「盘上别人改的」，冒出一个假冲突
 */
function canvasPushRemote(armed) {
  if (!armed) return Promise.resolve();
  if (canvasState.remoteWriteArmed === armed) canvasState.remoteWriteArmed = null;
  // 已经切到别的画布、别的项目了：服务端认的是「当前项目」，这份寄不回原来那张，
  // 硬写就是拿这张的内容去盖那张。本机副本里还留着，回到那张画布接着改照样写得上去
  if (canvasScope() !== armed.scope) return Promise.resolve();
  canvasState.remoteWritePending = true;
  const before = canvasState.remotePushing;
  const run = (before ? before.catch(() => {}) : Promise.resolve()).then(() => canvasPushRemoteOnce(armed));
  canvasState.remotePushing = run;
  return run.catch(() => {}).finally(() => {
    if (canvasState.remotePushing !== run) return;   // 后面还排着别的，等它们收尾
    canvasState.remotePushing = null; canvasState.remoteWritePending = false;
  });
}
async function canvasPushRemoteOnce(armed, depth = 0) {
  // 排队这会儿人可能已经切走了；也可能正卡在「两边都改了」等人选——选好之前一笔都不写，
  // 写了就等于替他选了「用我的」
  if (canvasScope() !== armed.scope) return;
  if (canvasState.remoteConflict && canvasState.remoteConflict.scope === armed.scope) return;
  const base = canvasState.remoteBase && canvasState.remoteBase.scope === armed.scope ? canvasState.remoteBase : null;
  try {
    // baseUpdatedAt：我是照着盘上哪一版改的。盘上已经不是那一版（别的标签页、Agent 写过），服务端回 409，
    // 不再是谁后写谁赢。0 也要带：新建的画布盘上就是 0，别人先写了一笔照样拦得住
    const response = await fetch("/api/canvas", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: armed.name, state: armed.snapshot, ...(base ? { baseUpdatedAt: base.at } : {}) }) });
    const result = await response.json().catch(() => ({}));
    if (response.status === 409 && result.unreadable) {
      // 服务器拒绝拿屏幕上这份去盖一个读不出来的文件。这是对的，但必须让用户知道，
      // 否则他会一直以为在存，关掉页面才发现今天白干了
      canvasState.remoteBroken = result.error || "盘上那份画布读不出来，所以没有覆盖它";
      if (!canvasState.remoteBrokenNotified) {
        canvasState.remoteBrokenNotified = true;
        canvasToast("画布文件读取失败，改动未存入项目（本机有备份），请刷新页面。", "circle-x", "err");
      }
    } else if (response.status === 409 && result.conflict) {
      await canvasResolveRemoteConflict(armed, base, result.state, depth);
    } else if (response.ok && result.state) {
      const at = Number(result.updatedAt) || Number(result.state.updatedAt) || 0;
      canvasState.remoteUpdatedAt = at || canvasState.remoteUpdatedAt;
      canvasState.remoteContentKey = armed.contentKey;   // 存上去了，这会儿两边一样
      if (canvasScope() === armed.scope) canvasState.remoteBase = { scope: armed.scope, at, snapshot: result.state };
      canvasClearPendingConflict(armed.scope);   // 交上了：盘上已是合好的那份，挂着的旧冲突作废
    }
  } catch {}
}

// 比内容用的指纹：键排好序，缺省字段按 canvasAddNode 的口径补齐。
// 盘上那份节点里没写的默认字段，铺到屏幕上会被补出来——不补齐就比，每张卡都像「本机改过」
function canvasStableKey(value) {
  if (Array.isArray(value)) return `[${value.map(canvasStableKey).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canvasStableKey(value[k])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}
function canvasMergeNodeKey(item) {
  if (!item) return "";
  const kind = String(item.kind || "note");
  return canvasStableKey({ kind, payload: { ...canvasDefaultPayload(kind), ...(item.payload || {}) } });
}
function canvasMergeEdgeId(edge) { return `${canvasEndpointId(edge && edge.source)}\n${canvasEndpointId(edge && edge.target)}`; }

/**
 * 三方合并：base 是上次跟盘上对齐的那份，mine 是屏幕上这份，disk 是盘上现在那份。按节点 id 逐个看：
 * 只有本机改了的用本机的，只有盘上改了的用盘上的，两边改得一模一样的算没冲突，
 * 两边改得不一样（含一边删一边改）的进 conflicts——这种不替人选（prefer 是人选过之后才给的）。
 * 位置不算冲突：本机挪过用本机的，没挪过跟盘上走
 */
function canvasMergeSnapshots(base, mine, disk, prefer = "") {
  const index = (snap) => new Map((Array.isArray(snap && snap.nodes) ? snap.nodes : []).filter((n) => n && n.id).map((n) => [String(n.id), n]));
  const B = index(base), M = index(mine), D = index(disk);
  // 顺序：盘上的在前（别处排好的顺序不打乱），本机新加的跟在后面
  const order = [...new Set([...D.keys(), ...M.keys()])];
  const conflicts = [], nodes = [];
  for (const id of order) {
    const b = B.get(id), m = M.get(id), d = D.get(id);
    const kb = canvasMergeNodeKey(b), km = canvasMergeNodeKey(m), kd = canvasMergeNodeKey(d);
    let pick = null;
    if (km === kd) pick = m || null;                 // 两边一样（含两边都删了）
    else if (km === kb) pick = d || null;            // 只有盘上动了（改或删）
    else if (kd === kb) pick = m || null;            // 只有本机动了
    else {
      conflicts.push(id);
      if (!prefer) continue;
      pick = prefer === "mine" ? m || null : d || null;
    }
    if (!pick) continue;
    const moved = b && m && canvasStableKey([m.position, m.size]) !== canvasStableKey([b.position, b.size]);
    const at = moved ? m : d || m || pick;
    nodes.push({ ...pick, position: at.position || pick.position, size: at.size || pick.size });
  }
  const alive = new Set(nodes.map((n) => String(n.id)));
  const edgeMap = (snap) => new Map((Array.isArray(snap && snap.edges) ? snap.edges : []).map((e) => [canvasMergeEdgeId(e), e]));
  const EB = edgeMap(base), EM = edgeMap(mine), edges = edgeMap(disk);
  // 连线按「从谁到谁」认：本机新连的、改了用途的补上，本机删掉的去掉，其余跟盘上走
  for (const [key, edge] of EM) if (!EB.has(key) || String(EB.get(key).relation || "") !== String(edge.relation || "")) edges.set(key, edge);
  for (const key of EB.keys()) if (!EM.has(key)) edges.delete(key);
  const kept = [...edges.values()].filter((e) => alive.has(canvasEndpointId(e.source)) && alive.has(canvasEndpointId(e.target)));
  return { snapshot: { version: 2, nodes, edges: kept, updatedAt: Number(disk && disk.updatedAt) || 0 }, conflicts };
}
// 两份快照内容一样不一样（节点内容、位置、连线），不管字段顺序、不管默认字段写没写
function canvasMergeSameKey(snap) {
  const s = snap || {};
  return canvasStableKey({
    nodes: (s.nodes || []).map((n) => [String(n.id), canvasMergeNodeKey(n), n.position || null, n.size || null]),
    edges: (s.edges || []).map((e) => [canvasMergeEdgeId(e), String(e.relation || "")]).sort(),
  });
}

/**
 * 撞了 409：盘上那份已经被别处改过。拉最新的一份按节点 id 合并，合得开就铺上屏幕、带着新 base 马上再交一次
 * （不等防抖：切画布前那一趟 flush 撞上 409，等防抖就被 canvasDestroy 掐掉了）；
 * 同一张卡两边都改了就停下来问人，选好之前暂停往项目里写（本机副本照存）
 */
async function canvasResolveRemoteConflict(armed, base, diskState, depth) {
  let disk = diskState && Array.isArray(diskState.nodes) ? diskState : null;
  if (!disk) disk = await canvasLoadRemote();
  if (!disk || canvasScope() !== armed.scope) return;
  const mine = canvasState.graph ? canvasSnapshot() : armed.snapshot;
  const baseSnap = base && base.snapshot ? base.snapshot : { nodes: [], edges: [] };
  const merged = canvasMergeSnapshots(baseSnap, mine, disk);
  // 盘上这份从现在起就是新的 base：下一趟照着它交
  canvasState.remoteBase = { scope: armed.scope, at: Number(disk.updatedAt) || 0, snapshot: disk };
  canvasState.remoteUpdatedAt = Number(disk.updatedAt) || canvasState.remoteUpdatedAt;
  canvasState.remoteSnapshot = disk;
  if (merged.conflicts.length) {
    canvasState.remoteConflict = { scope: armed.scope, base: baseSnap, disk, ids: merged.conflicts };
    canvasSavePendingConflict(armed.scope, base);
    canvasAskConflict();
    return;
  }
  canvasClearPendingConflict(armed.scope);   // 这回合得开：上回挂着的那次冲突（如果有）已经不存在了
  if (!canvasApplyMerged(merged.snapshot, disk)) return;
  // 铺的时候 canvasPersist 挂了一趟防抖写，这儿直接交，那趟撤掉免得同样的内容再写一遍
  if (canvasState.remoteWriteTimer) { clearTimeout(canvasState.remoteWriteTimer); canvasState.remoteWriteTimer = null; }
  canvasState.remoteWriteArmed = null;
  const snapshot = canvasState.graph ? canvasSnapshot() : merged.snapshot;
  // 连着撞三次就不追了：下一次改动照常带着新 base 交
  if ((depth || 0) < 3) await canvasPushRemoteOnce({ scope: armed.scope, name: armed.name, snapshot, contentKey: canvasHistoryKey(snapshot) }, (depth || 0) + 1);
}
// 合好的这份铺上屏幕。返回 true = 还得往项目里交一趟；跟盘上一模一样就按「从远端拉回来的」铺，不回写
function canvasApplyMerged(snapshot, disk) {
  const same = canvasMergeSameKey(snapshot) === canvasMergeSameKey(disk);
  const onScreen = canvasState.graph && canvasMergeSameKey(canvasSnapshot()) === canvasMergeSameKey(snapshot);
  if (!onScreen) canvasApplySnapshot(snapshot, { fromRemote: same });
  else if (same) canvasState.remoteContentKey = canvasHistoryKey(canvasSnapshot());
  return !same;
}

/**
 * 两边都改了的那几张卡：问一句留哪边。不给默认、不替人选；关掉就先放着，
 * 这期间不往项目里写，提示条上留一颗「去选」随时回来
 */
function canvasAskConflict() {
  const pending = canvasState.remoteConflict;
  if (!pending || typeof document === "undefined") return;
  document.getElementById("canvas-conflict-dialog")?.remove();
  const labelOf = (id) => {
    const node = canvasState.graph && canvasState.graph.getCell(id);
    const item = (pending.disk.nodes || []).find((n) => String(n.id) === id);
    if (node) return canvasNodeLabel(node);
    const p = (item && item.payload) || {};
    return String(p.title || p.name || p.id || id);
  };
  const title = canvasT("这 {n} 张卡两边都改了，留哪一边？", { n: pending.ids.length });
  const wrap = document.createElement("div");
  wrap.className = "ask-mask"; wrap.id = "canvas-conflict-dialog";
  wrap.innerHTML = `<div class="ask-box canvas-conflict" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">`
    + `<div class="ask-t">${esc(title)}</div>`
    + `<div class="ask-h">选哪边就留哪边这几张卡的内容，另一边的丢掉；其余卡两边的改动都已保留。</div>`
    + `<ul class="ask-li">${pending.ids.map((id) => `<li title="${esc(labelOf(id))}">${esc(labelOf(id))}</li>`).join("")}</ul>`
    + `<div class="ask-ops"><button type="button" class="btn-plain" data-canvas-conflict="later">稍后再选</button>`
    + `<button type="button" class="btn-plain" data-canvas-conflict="disk">用盘上的</button>`
    + `<button type="button" class="btn-plain" data-canvas-conflict="mine">用我的</button></div></div>`;
  document.body.appendChild(wrap);
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close("later"); } };
  function close(choice) {
    document.removeEventListener("keydown", onKey, true);
    wrap.remove();
    if (choice === "mine" || choice === "disk") return canvasSettleConflict(choice);
    canvasToast("有卡片两边都改了，选好之前暂停存进项目。", "triangle-alert", "err", { label: "去选", run: canvasAskConflict });
  }
  wrap.querySelectorAll("[data-canvas-conflict]").forEach((button) => { button.onclick = () => close(button.dataset.canvasConflict); });
  wrap.onmousedown = (e) => { if (e.target === wrap) close("later"); };
  document.addEventListener("keydown", onKey, true);
  // 焦点给「稍后再选」：回车不该替人挑一边
  wrap.querySelector('[data-canvas-conflict="later"]').focus();
}
function canvasSettleConflict(side) {
  const pending = canvasState.remoteConflict;
  if (!pending || pending.scope !== canvasScope()) { canvasState.remoteConflict = null; return; }
  canvasState.remoteConflict = null;
  canvasClearPendingConflict(pending.scope);
  // 拿「现在屏幕上」这份重合一遍：弹框开着的时候人可能又动了别的卡
  const mine = canvasState.graph ? canvasSnapshot() : { nodes: [], edges: [] };
  const merged = canvasMergeSnapshots(pending.base, mine, pending.disk, side);
  if (canvasApplyMerged(merged.snapshot, pending.disk)) {
    if (canvasState.remoteWriteTimer) { clearTimeout(canvasState.remoteWriteTimer); canvasState.remoteWriteTimer = null; }
    canvasState.remoteWriteArmed = null;
    const snapshot = canvasSnapshot();
    canvasPushRemote({ scope: pending.scope, name: canvasState.canvasName, snapshot, contentKey: canvasHistoryKey(snapshot) });
  }
  canvasToast(side === "mine" ? "这几张卡已用你这边的。" : "这几张卡已换成盘上的。", "circle-check");
}

/**
 * 「稍后再选」挂着的那次冲突，连同它的 base 记进本机。
 *
 * 只记在内存里不够：人点了「稍后再选」接着切画布、刷新页面，canvasDestroy 把 remoteConflict 清掉，
 * 回来时 canvasRestoreOrSeed 优先铺盘上那份——本机这边没交上去的改动（连不冲突的那些）一张不剩，
 * 本机副本也跟着被盖成盘上的。记下 base，回来时照着它铺本机副本、带老 base 再交一趟：
 * 盘上早变了，必撞 409，重新按节点合并、重新问人。选好了或者交上了就擦掉
 */
function canvasSavePendingConflict(scope, base) {
  if (!base || !base.snapshot) return;
  try { localStorage.setItem(canvasConflictStoreKey(scope), JSON.stringify({ at: Number(base.at) || 0, snapshot: base.snapshot })); } catch {}
}
function canvasLoadPendingConflict(scope = canvasScope()) {
  try {
    const value = JSON.parse(localStorage.getItem(canvasConflictStoreKey(scope)) || "null");
    return value && value.snapshot && Array.isArray(value.snapshot.nodes) ? value : null;
  } catch { return null; }
}
function canvasClearPendingConflict(scope = canvasScope()) {
  try { localStorage.removeItem(canvasConflictStoreKey(scope)); } catch {}
}

/** 切画布、切项目之前，先把欠着的那一趟写完 —— 走了再写就寄不到原来那张了 */
async function canvasFlushRemoteWrite() {
  const armed = canvasState.remoteWriteArmed;
  // 没有欠着的，也得等在路上那趟回来：它撞了 409 还要合并、再交一次，这期间画布不能拆
  if (!armed) { if (canvasState.remotePushing) await canvasState.remotePushing.catch(() => {}); return; }
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
  // 只替老画布补线。版本 2 起空着就是人自己删干净的，再补回去他就再也删不掉了
  if (!snapshot || Number(snapshot.version) >= 2 || (snapshot.edges || []).length) return snapshot;
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
  // 来的这份没有连线，别急着拿本机这份顶上去：老画布（版本 1）确实可能没存过连线，
  // 顶一下是护着；可版本 2 的空就是空，顶上去等于把人刚删的线又接回来——撤销、同步、重开都能碰上
  const edgesAreExplicit = Number(snapshot.version) >= 2 || (Array.isArray(snapshot.edges) && snapshot.edges.length > 0);
  const incomingEdges = edgesAreExplicit ? (Array.isArray(snapshot.edges) ? snapshot.edges : []) : currentEdges;
  const restoredSnapshot = canvasInferLegacyEdges({ ...snapshot, edges: incomingEdges });
  // 正在生成的那几张卡留本机这份：远端那份是发起生成之前存的，拿它整图重铺，
  // 生成期间人在本机改的字就被盖回去了；结果回来时写的也是这张卡（按 id 重新取）
  const keep = new Map();
  if (fromRemote && canvasState.inflight && canvasState.inflight.size) canvasState.inflight.forEach((id) => { const cur = canvasState.graph.getCell(id); if (cur) keep.set(id, canvasPayload(cur)); });
  canvasState.suspendSync = true;
  try {
    canvasState.graph.clear(); const byId = new Map();
    restoredSnapshot.nodes.forEach((item) => { const node = canvasAddNode(item.kind, keep.has(item.id) ? keep.get(item.id) : item.payload, item.position, { persist: false, skipSelect: true, id: item.id }); if (node) { if (item.size) node.resize(Number(item.size.width) || node.size().width, Number(item.size.height) || node.size().height); byId.set(item.id, node); } });
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
  if (fromRemote) {
    canvasState.remoteContentKey = canvasHistoryKey(canvasSnapshot());
    // 这份就是盘上那份：下一趟往上交就照着它（baseUpdatedAt）。存的是远端原样，不是屏幕上这份——
    // 生成中的卡在屏幕上留的是本机版本，拿屏幕当 base，本机那几笔改动就认不出来了
    canvasState.remoteBase = { scope: canvasScope(), at: Number(snapshot.updatedAt) || 0, snapshot };
  }
  canvasPersist();
}

// 手上有活：正在输入框里打字，或者按着一张卡在拖。这两件事都经不起一次 graph.clear()。
// 10 秒没动静就不算了——有人把光标留在框里走开、有人拖到一半松手没被接住，
// 这个标签页不能从此再也不同步
function canvasBusyNow() {
  if (Date.now() - Number(canvasState.handsOnAt || 0) >= 10000) return false;
  if (canvasState.nodeGesture) return true;
  const el = typeof document !== "undefined" ? document.activeElement : null;
  return !!(el && typeof el.matches === "function"
    && el.matches("input, textarea, [contenteditable=true]") && el.closest(".canvas-layout"));
}
function canvasStartRemoteSync() {
  if (canvasState.remoteTimer) clearInterval(canvasState.remoteTimer);
  canvasState.remoteTimer = window.setInterval(async () => {
    // 挂着一趟还没发出去的写也算：这时候拉回来的是改之前的那份，铺上去等于把刚改的抹掉
    if (!canvasState.graph || canvasState.remoteWritePending || canvasState.remoteWriteArmed) return;
    // 两边都改了、正等人选的时候也不拉：拉回来一铺，人还没选，本机那几张卡就被盖掉了
    if (canvasState.remotePushing || canvasState.remoteConflict) return;
    // 他手上正有活，这一圈先放着：铺快照是 graph.clear() 整图重来、属性面板整块重画。
    // 落在打字中间是刚敲的半句被盖掉、光标掉回 body；落在拖动中间是那张卡被拆掉、
    // 当场弹回原处，手里还按着。手一停就补上
    if (canvasBusyNow()) return;
    const previous = Number(canvasState.remoteUpdatedAt || 0);
    const state = await canvasLoadRemote();
    // 拉的这一趟在路上时本机又改了一笔（已经挂上写），拉回来的这份就是旧的了，别铺
    if (canvasState.remoteWritePending || canvasState.remoteWriteArmed || canvasState.remoteConflict) return;
    if (state && Number(state.updatedAt) > previous) canvasApplySnapshot(state, { fromRemote: true });
  }, 1800);
}
