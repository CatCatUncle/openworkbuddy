// menu 不传就是输入框右下角那个；助理页顶栏那个把自己的容器传进来，两处共用同一份菜单
function renderModelMenu(menu = modelMenu) {
  if (!settingsCache || !menu) return;
  const ov = currentSessModel();
  menu.innerHTML = `<div class="mi ${ov ? "" : "on"}" data-act="default" style="justify-content:space-between">
      <span>↺ 跟随全局默认 <span class="sub">${esc(settingsCache.active_model)}${healthBadge(settingsCache.active_model)}</span></span>${ov ? "" : '<span style="color:var(--wb-ok)">✓</span>'}</div>`
    + settingsCache.models.map(m => {
      const on = m.name === ov;
      return `<div class="mi ${on ? "on" : ""}" data-name="${esc(m.name)}" style="justify-content:space-between">
      <span>✦ ${esc(m.name)} <span class="sub">${esc(m.model)}${m.api_key ? "" : " · ⚠ 未填Key"}${healthBadge(m.name)}</span></span>
      ${on ? '<span style="color:var(--wb-ok)">✓</span>' : ""}</div>`;
    }).join("")
    + `<div class="mi" data-act="manage" style="border-top:1px solid var(--wb-border);margin-top:4px">⚙️ 管理模型…</div>`;
  menu.querySelectorAll(".mi").forEach(mi => mi.onclick = async () => {
    menu.classList.remove("show");
    if (mi.dataset.act === "manage") return openModal("settings", "models");
    await setSessionModel(mi.dataset.act === "default" ? null : mi.dataset.name);
  });
}

// ================= Goal 目标卡 =================
function renderGoalCard() {
  const card = document.getElementById("goal-card");
  const g = sessionId && sessionGoals.get(sessionId);
  if (!g || g.status === "closed") { card.style.display = "none"; card.innerHTML = ""; return; }
  const doneN = g.criteria.filter(c => c.done).length;
  card.style.display = "";
  card.innerHTML = `
    <div class="gc-head">
      <span class="gc-title">🎯 ${esc(g.text)}</span>
      <span class="gc-meta">${g.status === "done" ? '<span class="gc-done">已达成 ✓</span>' : `${doneN}/${g.criteria.length} · 第 ${g.round || 0} 轮`}</span>
      <button class="gc-close" title="归档目标（不再显示，也不再按它验收）">✕</button>
    </div>
    <div class="gc-list">${g.criteria.map(c => `<div class="gc-item ${c.done ? "ok" : ""}">${c.done ? "✅" : "⬜"} ${esc(c.text)}</div>`).join("")}</div>`;
  card.querySelector(".gc-close").onclick = async () => {
    try { await fetch("/api/session/" + encodeURIComponent(sessionId) + "/goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close" }) }); } catch {}
    g.status = "closed";
    renderGoalCard();
  };
}

// ================= 工作空间选择（快捷栏，仿官方"选择工作空间"） =================
const wsMenu = setupPicker("ws-btn", "ws-menu");
function renderWsMenu() {
  wsMenu.innerHTML =
    `<div class="mi" data-act="cur">📁 ${esc(settingsCache.workspace_dir)}</div>
     <div class="mi" data-act="pick">📂 选择新文件夹…</div>
     <div class="mi" data-act="open">🗂 打开当前文件夹</div>`;
  wsMenu.querySelectorAll(".mi").forEach(mi => mi.onclick = async () => {
    wsMenu.classList.remove("show");
    if (mi.dataset.act === "pick") {
      const r = await fetch("/api/pick-folder", { method: "POST" }).then(r => r.json()).catch(() => ({}));
      if (r.path) {
        await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace_dir: r.path }) });
        refreshSettingsCache();
        fetch("/api/files").then(r => r.json()).then(renderFiles);
      } else if (r.error) {
        const p = prompt("输入工作空间文件夹的完整路径：", settingsCache.workspace_dir);
        if (p) {
          await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace_dir: p }) });
          refreshSettingsCache();
        }
      }
    } else if (mi.dataset.act === "open") fetch("/api/open-workspace", { method: "POST" });
  });
}
refreshSettingsCache();

// ================= 模式选择（快捷栏"默认权限"式下拉） =================
const modeMenu = setupPicker("mode-btn", "mode-menu");
const MODE_LABEL = { craft: "✅ Craft · 执行", goal: "🎯 Goal · 目标", plan: "🗺️ Plan · 规划", ask: "💬 Ask · 问答" };
function setMode(mode) {
  currentMode = mode;
  document.getElementById("mode-label").textContent = MODE_LABEL[mode].slice(2).trim();
  modeMenu.querySelectorAll(".mi").forEach(x => x.classList.toggle("on", x.dataset.mode === mode));
  inputEl.placeholder = mode === "ask" ? "问我任何问题（不会修改文件）…"
    : mode === "goal" ? "描述你的目标，我拆成验收标准，没达成自动接着跑…"
    : mode === "plan" ? "描述任务，我先给你出执行计划…"
    : "今天帮你做些什么？可以让我处理数据、写报告、做 PPT、联网调研…";
}
modeMenu.querySelectorAll(".mi").forEach(mi => mi.onclick = () => {
  setMode(mi.dataset.mode);
  modeMenu.classList.remove("show");
});

// ================= ＋ 上传文件到工作空间（选择/拖拽共用） =================
const attachChips = document.getElementById("attach-chips");
const pendingAttach = []; // 已上传、待随下一条消息发出的附件名。发送时才拼进消息文本，绝不往输入框里塞标记
function addAttachChip(name, thumbUrl, hint) {
  if (pendingAttach.includes(name)) return; // 同名重复上传只留一个 chip（文件本身已覆盖更新）
  pendingAttach.push(name);
  const chip = document.createElement("span");
  if (thumbUrl) {
    // 截图之间光看文件名分不出谁是谁，给张缩略图才知道自己贴对了没有
    const img = document.createElement("img");
    img.src = thumbUrl;
    img.className = "attach-thumb";
    img.alt = "";
    chip.appendChild(img);
  }
  chip.appendChild(document.createTextNode(thumbUrl ? name : "📎 " + name));
  if (hint) chip.title = hint; // 鼠标停上去能看见开头几行，确认贴的是哪一段
  const x = document.createElement("b");
  x.textContent = "✕";
  x.title = "从这条消息移除（文件仍在工作目录里）";
  x.onclick = () => { const i = pendingAttach.indexOf(name); if (i >= 0) pendingAttach.splice(i, 1); chip.remove(); };
  chip.appendChild(x);
  attachChips.appendChild(chip);
}
/** 二进制转 base64。必须分块喂 fromCharCode：一个字节一个字节拼字符串，30MB 的文件能把界面卡死好几秒 */
function bytesToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  return btoa(s);
}
/** 往工作空间放一份内容并挂上 chip。文件、截图、粘贴进来的大段文字，最后都走这里 */
async function uploadBytes(name, u8, { thumbMime, hint } = {}) {
  const b64 = bytesToB64(u8);
  const resp = await fetch("/api/upload", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data_b64: b64 }),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  addAttachChip(name, thumbMime ? `data:${thumbMime};base64,${b64}` : "", hint);
  fetch("/api/files").then(r => r.json()).then(renderFiles);
}
async function uploadFiles(fileList, { rename } = {}) {
  for (const file of fileList) {
    if (file.size > 30 * 1048576) { toast(`${file.name} 超过 30MB，跳过`); continue; }
    try {
      const name = rename ? rename(file) : file.name;
      const buf = await file.arrayBuffer();
      await uploadBytes(name, new Uint8Array(buf), { thumbMime: /^image\//.test(file.type) ? file.type : "" });
    } catch (err) {
      toast(`❌ 上传失败: ${file.name}`); // 拖进来的是文件夹时读不出内容，也走这里
    }
  }
}
/**
 * 时间戳文件名。同一秒里连贴两张截图会撞名，撞上就往后编号——
 * 不编号的话第二张会把第一张覆盖掉，而且 chip 按名字去重，界面上只剩一个，用户根本看不出来丢了一张。
 */
function stampName(prefix, ext) {
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, "0");
  const stem = `${prefix}_${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  let name = `${stem}.${ext}`;
  for (let i = 2; pendingAttach.includes(name); i++) name = `${stem}-${i}.${ext}`;
  return name;
}
/**
 * 大段文字（日志、报错、整篇文档）不塞进输入框，落成工作空间里的一个 .txt 再挂 chip。
 * 塞进输入框有三处坏处：输入框被撑成一屏没法再打字、发出去的气泡里几万字滚不到头、
 * 而且这段文字会原样躺在对话历史里被每一步重发一遍。落成文件之后模型按需 read_file，
 * 要看第几行看第几行。
 */
const BIG_TEXT_CHARS = 2000;
async function uploadText(text, { name } = {}) {
  const fname = name || stampName("粘贴文本", "txt");
  const head = text.replace(/\s+/g, " ").trim().slice(0, 80);
  try {
    await uploadBytes(fname, new TextEncoder().encode(text), { hint: head + (text.length > 80 ? "…" : "") });
    toast(`大段文字已存成 ${fname}（${text.length.toLocaleString()} 字），发消息时一起带给它`);
    return true;
  } catch (err) {
    toast("❌ 文字存盘失败，已按普通粘贴处理");
    return false;
  }
}
/** 把输入框文字和待发附件合成一条要发出的消息，并清空两者。附件标记只在这里拼，界面上永远只见 chip */
function composeOutgoing() {
  const typed = inputEl.value.trim();
  const note = pendingAttach.length ? `（已上传文件：${pendingAttach.join("、")}）` : "";
  if (!typed && !note) return "";
  inputEl.value = "";
  syncInputHl();
  attachChips.innerHTML = "";
  pendingAttach.length = 0;
  return typed && note ? typed + "\n" + note : typed || note;
}
document.getElementById("attach-btn").onclick = () => document.getElementById("file-input").click();
document.getElementById("file-input").addEventListener("change", async (e) => {
  await uploadFiles(e.target.files);
  e.target.value = "";
});
// 拖文件进窗口即上传。document 级必须拦掉默认行为，否则 Electron 会把整个页面导航到 file:// 吞掉应用
let dragDepth = 0;
const inputCard = attachChips.closest(".input-card");
document.addEventListener("dragover", (e) => e.preventDefault());
const dragHasPayload = (e) => {
  const t = [...((e.dataTransfer || {}).types || [])];
  return t.includes("Files") || t.includes("text/plain") || t.includes("text/uri-list");
};
document.addEventListener("dragenter", (e) => {
  if (!dragHasPayload(e)) return;
  dragDepth++;
  inputCard?.classList.add("dragging");
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; inputCard?.classList.remove("dragging"); }
});
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  inputCard?.classList.remove("dragging");
  const dt = e.dataTransfer || {};
  const files = [...(dt.files || [])];
  if (files.length) { await uploadFiles(files); return; }
  // 从浏览器/编辑器里选中一段文字直接拖进来
  const text = (dt.getData ? dt.getData("text/plain") : "") || "";
  if (!text.trim()) return;
  if (text.length > BIG_TEXT_CHARS) { await uploadText(text); return; }
  insertAtCursor(inputEl, text); // 短的就落到输入框里，让用户接着打字
});
/** 在光标处插入文字（拖进来的短文本）。直接 += 会把用户已经写好的半句话顶到后面去 */
function insertAtCursor(el, text) {
  const a = el.selectionStart ?? el.value.length;
  const b = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, a) + text + el.value.slice(b);
  el.selectionStart = el.selectionEnd = a + text.length;
  el.focus();
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// ================= 粘贴即上传（截图、Finder 里复制的文件） =================
/**
 * 剪贴板里的截图一律叫 image.png——连贴两张，第二张会把第一张覆盖掉，而且用户完全看不出来
 * （chip 按名字去重，只剩一个）。所以只要名字是这种通用名，就按贴的时刻另起一个。
 */
function pastedName(file) {
  const generic = /^(image|图像|截屏|screenshot|未命名)?\.?(png|jpe?g|gif|webp|bmp|heic)?$/i;
  if (file.name && !generic.test(file.name)) return file.name; // Finder 里复制的真文件，保留原名
  return stampName("粘贴图片", (file.type.split("/")[1] || "png").replace("jpeg", "jpg"));
}
document.addEventListener("paste", async (e) => {
  const t = e.target;
  // 别抢别处输入框的粘贴：设置里的记忆文本框、搜索框都得能正常粘文字
  const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName));
  if (editable && t !== inputEl) return;
  const cd = e.clipboardData;
  if (!cd) return;
  // 有文字就按文字处理——从网页/表格复制来的内容常常同时带一张图，那时用户要的是文字。
  // 纯截图不带 text/plain，正好落到下面走文件那条路。
  const text = cd.getData("text/plain");
  if (text.trim()) {
    if (text.length <= BIG_TEXT_CHARS) return; // 短文本照常粘进输入框，别多管
    e.preventDefault();
    // 存盘失败就退回普通粘贴，别把用户复制的东西弄丢（焦点不在输入框时无处可退，只能作罢）
    if (!(await uploadText(text)) && t === inputEl) insertAtCursor(inputEl, text);
    return;
  }
  const files = [...(cd.files || [])];
  if (!files.length) return;
  e.preventDefault();
  await uploadFiles(files, { rename: pastedName });
  toast(files.length > 1 ? `已贴上 ${files.length} 个文件` : "图片已贴上，发消息时会一起带给它");
});

// ================= 会话历史（服务端持久化 + 回放，按项目过滤） =================
function renderHistory() {
  const list = sessions.filter(s => (s.project || "默认项目") === activeProject);
  document.getElementById("history").innerHTML = list.map(s =>
    `<div class="hist-item ${s.id === sessionId ? "active" : ""}" data-id="${s.id}" title="${esc(stripSceneTag(s.title))}"><span class="ht">${esc(stripSceneTag(s.title))}</span>${runningSessions.has(s.id) ? '<span class="hrun" title="任务运行中"></span>' : ""}<span class="hx" title="删除该任务">✕</span></div>`).join("")
    || '<div style="font-size: 13px;color:var(--wb-text-3);padding:4px 10px">该项目还没有任务</div>';
}
document.getElementById("history").addEventListener("click", async (e) => {
  const item = e.target.closest(".hist-item");
  if (!item) return;
  if (e.target.classList.contains("hx")) {
    if (!confirm("删除该任务及其对话记录？")) return;
    const id = item.dataset.id;
    sessions = sessions.filter(s => s.id !== id);
    saveSessions();
    if (runningSessions.has(id)) { // 正在跑的任务跟着会话一起停，别留孤儿任务烧钱
      fetch("/api/chat/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }).catch(() => {});
    }
    sessionQueues.delete(id);
    fetch("/api/session/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
    if (sessionId === id) document.getElementById("new-task").click();
    else renderHistory();
    return;
  }
  closeAssistView();
  sessionId = item.dataset.id;
  // 上个会话开着的预览/文件面板不带进来
  pvPanel.classList.remove("show"); pvCurrent = null;
  document.getElementById("files-panel").classList.remove("show");
  const s = sessions.find(x => x.id === sessionId);
  document.getElementById("session-title").textContent = s ? stripSceneTag(s.title) : "任务";
  renderHistory();
  // 回放服务端保存的完整对话（含工具执行过程）
  chatCol.innerHTML = "";
  const data = await fetch("/api/session/" + encodeURIComponent(sessionId)).then(r => r.json()).catch(() => ({ transcript: [] }));
  if (data.dir && sessionDirs.get(sessionId) !== data.dir) { sessionDirs.set(sessionId, data.dir); openDirs.add(data.dir); renderFiles(filesCache); }
  if (data.model) sessionModels.set(sessionId, data.model); else sessionModels.delete(sessionId);
  updateModelLabel();
  if (data.goal) sessionGoals.set(sessionId, data.goal); else sessionGoals.delete(sessionId);
  renderGoalCard();
  let transcript = data.transcript || [];
  // 该会话有任务正在后台跑：回放只到本轮之前，正在跑的这轮把"活的"回合元素接回来
  //（它切走期间一直在后台收事件更新，接上就是完整直播，不用回放+续流拼接）
  const live = runningSessions.get(sessionId);
  if (live) {
    const lastUser = transcript.map(e => e.type).lastIndexOf("user");
    if (lastUser >= 0) transcript = transcript.slice(0, lastUser);
  }
  let ui = null;
  isReplaying = true;
  try {
    for (const entry of transcript) {
      if (entry.type === "user") {
        ui = createTurnUI(entry.text, entry.mode);
      } else if (entry.type === "assistant" && ui) {
        for (const ev of entry.events || []) ui.handleEvent(ev);
        ui.finish();
      }
    }
  } finally { isReplaying = false; }
  if (live) {
    document.getElementById("empty")?.remove();
    chatCol.appendChild(live.ui.turn);
  } else if (!transcript.length) {
    chatCol.innerHTML = '<div style="text-align:center;color:var(--wb-text-3);font-size: 13px;padding:20px">该任务还没有保存的对话记录（可能创建于旧版本），继续对话即可。</div>';
  }
  updateSendUI();
  scrollBottom(true);
});
document.getElementById("new-task").onclick = () => {
  closeAssistView();
  sessionId = null;
  pendingModel = defaultPendingModel();
  updateModelLabel();
  renderGoalCard();
  pvPanel.classList.remove("show"); pvCurrent = null;
  document.getElementById("files-panel").classList.remove("show");
  updateSendUI(); // 新对话不是忙态：别的对话在跑也能立刻并行发任务
  document.getElementById("session-title").textContent = "新任务";
  chatCol.innerHTML = "";
  chatCol.appendChild(buildEmpty());
  renderHistory();
  // 上个任务里临时切过的工作文件夹不带进新任务：回到当前项目的默认目录
  fetch("/api/workspace/reset", { method: "POST" }).then(r => r.json()).then(st => {
    if (st.workspace_dir && settingsCache && st.workspace_dir !== settingsCache.workspace_dir) {
      refreshSettingsCache();
      fetch("/api/files").then(r => r.json()).then(renderFiles);
    }
  }).catch(() => {});
};
renderHistory();
reattachRunning(); // 刷新页面不丢正在跑的任务：找回并接上直播

// ================= 项目（多工作空间，任务历史按项目分组；projects/activeProject 声明在顶部基础状态区） =================
async function refreshProjects() {
  try {
    const data = await fetch("/api/projects").then(r => r.json());
    projects = data.projects || [];
    activeProject = data.active || "默认项目";
  } catch {}
  renderProjects();
  renderHistory();
}
function renderProjects() {
  const box = document.getElementById("proj-list");
  if (!box) return;
  box.innerHTML = projects.map(p =>
    `<div class="proj-item ${p.name === activeProject ? "active" : ""}" data-name="${esc(p.name)}" title="${esc(p.dir)}">📂 <span class="pn">${esc(p.name)}</span>${projects.length > 1 ? '<span class="del" title="移除项目（不删文件）">✕</span>' : ""}</div>`).join("");
  box.querySelectorAll(".proj-item").forEach(el => el.onclick = async (e) => {
    const name = el.dataset.name;
    if (e.target.classList.contains("del")) {
      if (!confirm(`把项目「${name}」从列表移除？（目录和文件不会删除）`)) return;
      await fetch("/api/projects/" + encodeURIComponent(name), { method: "DELETE" });
      refreshProjects().then(refreshSettingsCache);
      return;
    }
    if (name === activeProject) return;
    await fetch("/api/projects/switch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    activeProject = name;
    document.getElementById("new-task").click();
    renderProjects();
    refreshSettingsCache();
    fetch("/api/files").then(r => r.json()).then(renderFiles);
  });
}
document.getElementById("proj-add").onclick = (e) => {
  e.preventDefault();
  const box = document.getElementById("proj-list");
  if (box.querySelector("#proj-new")) { box.querySelector("#proj-new").focus(); return; }
  const row = document.createElement("div");
  row.style.cssText = "padding:4px 6px";
  row.innerHTML = '<input id="proj-new" placeholder="项目名，回车创建" style="width:100%;font-size: 13px;padding:5px 8px">';
  box.prepend(row);
  const inp = row.querySelector("#proj-new");
  inp.focus();
  inp.onkeydown = async (ev) => {
    if (ev.key === "Escape") { row.remove(); return; }
    if (ev.key !== "Enter") return;
    const name = inp.value.trim();
    if (!name) return;
    const resp = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { toast("❌ " + (data.error || "创建失败")); return; }
    document.getElementById("new-task").click();
    refreshProjects().then(refreshSettingsCache);
  };
};
refreshProjects();

// ================= 发送（运行中按钮变「停止」） =================
// ================= 并行任务：运行态/排队按会话隔离，不同对话互不阻塞 =================
function updateSendUI() {
  const busy = curBusy();
  sendBtn.classList.toggle("stop", busy);
  sendBtn.textContent = busy ? "◼" : "↑";
  sendBtn.title = busy ? "停止任务" : "发送";
  // ⚡ 插队按钮退役：发消息默认就是插队，按钮常隐（interject() 留给快捷键等旧入口）
  renderQueueBar();
  renderHistory(); // 侧栏「运行中」小圆点跟着刷新
}
function renderQueueBar() {
  const bar = document.getElementById("queue-bar");
  const q = (sessionId && sessionQueues.get(sessionId)) || [];
  if (!curBusy() && !q.length) { bar.classList.remove("show"); bar.innerHTML = ""; return; }
  bar.classList.add("show");
  bar.innerHTML =
    q.map((m, i) => `<span class="q-chip" title="${esc(m.text)}"><span class="qt">⏳ ${esc(m.text.slice(0, 30))}</span><span class="qx" data-i="${i}" title="取消这条">✕</span></span>`).join("") +
    (curBusy() ? `<span>任务运行中：发消息会直接插队并入当前任务 · ◼ 停止 · 要另起并行任务点「新建任务」</span>` : "");
  bar.querySelectorAll(".qx").forEach(x => x.onclick = () => { q.splice(+x.dataset.i, 1); renderQueueBar(); });
}
function drainQueue(sid) {
  const q = sessionQueues.get(sid);
  if (!q || !q.length || runningSessions.has(sid)) return;
  const m = q.shift();
  if (sid === sessionId) renderQueueBar();
  runTurn(sid, m.text, m.mode);
}
/** 把一条消息立即注入正在执行的任务；任务恰好刚结束就直接当新一轮跑，两头都不丢消息 */
async function interjectText(text) {
  const resp = await fetch("/api/chat/interject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message: text }),
  }).catch(() => null);
  if (resp && resp.ok) {
    const live = runningSessions.get(sessionId);
    if (live && live.ui.markPendingInterject) live.ui.markPendingInterject(text);
    else toast("⚡ 已插队：这条消息会并入当前任务一起处理");
  } else {
    qOf(sessionId).push({ text, mode: currentMode });
    renderQueueBar();
    drainQueue(sessionId);
  }
}
async function interject() {
  if (!sessionId) return;
  const text = composeOutgoing();
  if (!text) return;
  await interjectText(text);
}
document.getElementById("interject-btn").onclick = interject;
async function stopTask() {
  if (!sessionId) return;
  sendBtn.textContent = "…";
  await fetch("/api/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
}
async function send() {
  let text = composeOutgoing();
  if (!text) return;
  if (sceneTag) {
    text = `【任务类型：${sceneTag.replace(/^[^一-龥A-Za-z]+\s*/, "")}】` + text;
    setSceneTag(null);
  }
  mentionMenu.classList.remove("show");
  if (pageKind === "assist") { await sendAssistLocal(text); return; }
  if (curBusy()) {
    // 本对话的任务在跑 → 默认直接插队：消息立即注入当前任务一起处理（要另起并行任务用「新建任务」）
    await interjectText(text);
    return;
  }
  await doSend(text, currentMode);
}

// regen=true 表示「重新生成」：服务端回滚最后一轮再重跑同一条消息
async function doSend(text, mode, regen) {
  if (curBusy()) return;
  closeAssistView();
  if (!sessionId) {
    sessionId = "s_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
    const shortTitle = stripSceneTag(text).slice(0, 24); // 标题里不留场景标签，否则历史列表整排都是「【任务类型：…」
    sessions.unshift({ id: sessionId, title: shortTitle, at: Date.now(), project: activeProject });
    saveSessions();
    document.getElementById("session-title").textContent = shortTitle;
    if (pendingModel) { const pm = pendingModel; pendingModel = undefined; await setSessionModel(pm); }
  }
  await runTurn(sessionId, text, mode, regen);
}

// 真正执行一轮任务：绑定 sid 而不是全局 sessionId——用户切走后它继续在后台跑
/** 镜像 server.js recordingEmit 的记录口径：数出服务端 transcript 已记录到第几个事件。
 *  断流重连时靠它算出准确的 from/textOffset 从断点续流——哪些事件入账、text 怎么合并必须和服务端完全一致 */
function makeRecCounter() {
  const KEEP = ["tool_use", "tool_result", "parallel", "expert_start", "expert_done", "error", "limit", "auto_continue", "failover", "sleep", "trim", "compact", "usage", "interject", "credits", "sources", "ask_user", "ask_answer", "milestones"];
  const st = { n: 0, lastIsText: false, textLen: 0 };
  st.feed = (ev) => {
    if (ev.type === "text") {
      if (ev.depth > 0) return;
      if (!st.lastIsText) { st.n++; st.lastIsText = true; st.textLen = 0; }
      st.textLen += String(ev.delta || "").length;
    } else if (KEEP.includes(ev.type)) { st.n++; st.lastIsText = false; }
  };
  return st;
}

/** 读一条 SSE 流喂给回合 UI；返回是否收到了正常收尾的 done 事件 */
async function pumpStream(resp, ui, rc) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", sawDone = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      try {
        const ev = JSON.parse(part.slice(6));
        if (ev.type === "done") sawDone = true;
        rc.feed(ev);
        ui.handleEvent(ev);
      } catch {}
    }
  }
  return sawDone;
}

/** 主流断了但服务端任务可能还在跑（电脑睡眠/网络抖动/页面刚刷新）：从断点续流接回，直到任务真结束 */
async function keepAttached(sid, ui, rc, sawDone, netErr) {
  while (!sawDone) {
    let still = null;
    try { const r = await fetch("/api/chat/running"); if (r.ok) still = await r.json(); } catch {}
    if (!still) break; // 网络彻底不通：把最后攒下的错误亮出来
    if (!still.includes(sid)) { netErr = null; break; } // 服务端已经跑完：不算错误，安静收尾
    netErr = null;
    try {
      const qs = rc.lastIsText ? `from=${rc.n - 1}&textOffset=${rc.textLen}` : `from=${rc.n}`;
      const resp = await fetch(`/api/chat/stream/${encodeURIComponent(sid)}?${qs}`);
      if (!resp.ok) break;
      sawDone = await pumpStream(resp, ui, rc);
    } catch (e) {
      netErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (netErr) ui.handleEvent({ type: "error", message: "连接中断：" + netErr.message });
}

/** 一轮任务收尾（正常结束/出错/被停止都走这里） */
function endRun(sid, ui) {
  ui.finish();
  runningSessions.delete(sid);
  updateSendUI();
  if (!(sessionQueues.get(sid) || []).length) notifyRunDone(sid, ui); // 还有排队消息就不算完
  if (sid === sessionId) inputEl.focus();
  drainQueue(sid); // 本会话运行期间排队的消息按序自动执行
}

/** 并行任务多了得知道哪个跑完了：后台会话完成弹 toast；窗口失焦时发系统通知 */
function notifyRunDone(sid, ui) {
  const s = sessions.find((x) => x.id === sid);
  const name = stripSceneTag(s && s.title) || "任务";
  // 长跑完成通知带上战报：用时/步数/产出件数，长任务离开视线也知道干了多少活
  const st = ui && ui.stats ? ui.stats() : null;
  const detail = st ? `用时 ${st.dur}${st.steps ? ` · ${st.steps} 步` : ""}${st.rounds ? ` · 续跑 ${st.rounds} 轮` : ""}${st.outs ? ` · 产出 ${st.outs} 件` : ""}` : "";
  if (sid !== sessionId) toast(`✅ 「${name}」已完成${detail ? `（${detail}）` : ""}，点侧栏查看`);
  if (document.hidden && "Notification" in window) {
    try {
      if (Notification.permission === "granted") {
        const n = new Notification(`✅ ${name}`, { body: detail || "任务已完成" });
        n.onclick = () => { try { window.focus(); } catch {} document.querySelector(`.hist-item[data-id="${sid}"]`)?.click(); };
      } else if (Notification.permission === "default") Notification.requestPermission();
    } catch {}
  }
}

/** 页面加载时找回还在后台跑的任务：回放已记录的过程 + 断点续流接上直播（刷新不再丢任务画面） */
async function reattachRunning() {
  let ids = [];
  try { const r = await fetch("/api/chat/running"); if (r.ok) ids = await r.json(); } catch {}
  for (const sid of ids) {
    if (runningSessions.has(sid)) continue;
    let data = null;
    try { data = await fetch("/api/session/" + encodeURIComponent(sid)).then((r) => r.json()); } catch {}
    if (data && data.dir) sessionDirs.set(sid, data.dir);
    if (data && data.model) sessionModels.set(sid, data.model);
    if (data && data.goal) sessionGoals.set(sid, data.goal);
    const t = (data && data.transcript) || [];
    const lastUser = t.map((e) => e.type).lastIndexOf("user");
    if (lastUser < 0) continue;
    const evs = (t[lastUser + 1] && t[lastUser + 1].events) || [];
    const ui = createTurnUI(t[lastUser].text, t[lastUser].mode, sid);
    const rc = makeRecCounter();
    isReplaying = true;
    try { for (const ev of evs) { rc.feed(ev); ui.handleEvent(ev); } } finally { isReplaying = false; }
    runningSessions.set(sid, { ui });
    // 用户手快已经点进了这个会话：把静态回放出来的最后一轮换成活的回合元素
    if (sid === sessionId) {
      const turns = chatCol.querySelectorAll(".turn");
      if (turns.length) turns[turns.length - 1].remove();
      document.getElementById("empty")?.remove();
      chatCol.appendChild(ui.turn);
      scrollBottom(true);
    }
    updateSendUI();
    keepAttached(sid, ui, rc, false, null).then(() => endRun(sid, ui)); // 各会话各自接，互不等待
  }
}

async function runTurn(sid, text, mode, regen) {
  if (runningSessions.has(sid)) { qOf(sid).push({ text, mode }); if (sid === sessionId) renderQueueBar(); return; }
  const ui = createTurnUI(text, mode, sid);
  runningSessions.set(sid, { ui });
  updateSendUI();
  if (sid === sessionId) scrollBottom(true);

  const rc = makeRecCounter();
  let sawDone = false, netErr = null;
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, message: text, mode, regen: !!regen }),
    });
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      ui.handleEvent({ type: "error", message: d.error || `请求失败（HTTP ${resp.status}）` });
      if (resp.status === 401) showAuth(!!d.setup);
      sawDone = true; // 请求根本没被受理，没有可续的流
    } else {
      sawDone = await pumpStream(resp, ui, rc);
    }
  } catch (e) {
    netErr = e;
  }
  await keepAttached(sid, ui, rc, sawDone, netErr);
  endRun(sid, ui);
}
sendBtn.onclick = () => (curBusy() ? stopTask() : send());
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

// ================= 弹窗（技能/专家/定时/设置中心） =================
document.getElementById("m-close").onclick = () => mask.classList.remove("show");
mask.addEventListener("click", (e) => { if (e.target === mask) mask.classList.remove("show"); });
document.querySelectorAll(".side-nav").forEach((nav) => nav.addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (!item) return;
  if (item.id === "more-toggle") {
    item.classList.toggle("open");
    document.getElementById("more-box").classList.toggle("open");
    return;
  }
  if (item.dataset.view) return openPageView(item.dataset.view); // 主区页面（不是弹窗）
  if (item.dataset.modal) openModal(item.dataset.modal);
}));

/** 打开「专家 · 技能 · 连接器」主区页并直接落到某个 Tab */
function openHub(tab) {
  hubState.tab = tab || "experts";
  hubState.cat = "全部"; hubState.q = ""; hubState.mine = false; hubState.editing = null;
  if (tab === "team") { hubState.tab = "experts"; hubState.sub = "team"; }
  else if (tab === "experts") hubState.sub = "expert";
  openPageView("hub");
}

async function openModal(kind, subTab) {
  // 技能/专家已经从弹窗搬到主区的「专家·技能·连接器」页，老入口（快捷键等）改成跳页
  if (kind === "skills") return openHub("skills");
  if (kind === "experts") return openHub("team");
  if (kind === "sched") return openPageView("autom"); // 自动化已从弹窗搬到主区
  if (kind === "library") return openPageView("lib"); // 资料库同理
  mask.classList.add("show");
  modalBox.classList.toggle("wide", ["settings", "account", "proj-edit"].includes(kind));
  if (kind === "account") {
    mTitle.textContent = "👤 账号 · 用量";
    await renderAccount();
  } else if (kind === "settings") {
    mTitle.textContent = "⚙️ 设置";
    renderSettings(subTab || "models");
  }
}

// ================= 快捷键引擎 =================
// [id, 名称, 默认键, 固定?, 系统级?]；用户改绑存 config.shortcuts（只存改过的项）
const SHORTCUT_DEFS = [
  ["open-settings", "打开设置", "Meta+Comma"],
  ["voice-record", "语音录制开关", "Meta+D"],
  ["chat-search", "对话内搜索", "Meta+F"],
  ["send", "发送消息", "Enter", true],
  ["newline", "输入时换行", "Shift+Enter", true],
  ["new-chat", "新建对话", "Meta+N"],
  ["stop", "停止生成 / 关闭弹层", "Escape"],
  ["prev-task", "上一个任务", "Meta+BracketLeft"],
  ["next-task", "下一个任务", "Meta+BracketRight"],
  ["toggle-sidebar", "切换左侧栏", "Meta+B"],
  ["toggle-files", "切换右侧产物面板", "Shift+Meta+B"],
  ["fullscreen", "进入/退出全屏", "Ctrl+Meta+F"],
  ["toggle-window", "唤起/隐藏主窗口", "Shift+Alt+W", false, true],
  ["open-skills", "打开技能广场", "Shift+Meta+K"],
  ["open-experts", "打开专家团", "Shift+Meta+E"],
  ["open-prompts", "打开参考模板库", "Shift+Meta+P"],
  ["open-library", "打开资料库", "Shift+Meta+L"],
  ["open-sched", "打开定时任务", "Shift+Meta+T"],
  ["open-assistant", "打开本地助理", "Shift+Meta+A"],
];
function canonAccel(a) {
  const mods = [], keys = [];
  for (const p of String(a || "").split("+").map(x => x.trim()).filter(Boolean)) {
    const m = { meta: "Meta", cmd: "Meta", command: "Meta", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" }[p.toLowerCase()];
    if (m) { if (!mods.includes(m)) mods.push(m); } else keys.push(p);
  }
  const order = { Ctrl: 0, Alt: 1, Shift: 2, Meta: 3 };
  mods.sort((x, y) => order[x] - order[y]);
  return mods.concat(keys).join("+");
}
function accelFromEvent(e) {
  if (/^(Meta|Control|Alt|Shift)/.test(e.code)) return null; // 只按了修饰键
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(e.code.replace(/^Key/, "").replace(/^Digit/, ""));
  return parts.join("+");
}
function accelDisplay(a) {
  const KEY = { Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]", Escape: "Esc", Enter: "⏎", Space: "空格", Minus: "-", Equal: "=", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`" };
  const MOD = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
  const parts = canonAccel(a).split("+");
  // mac 习惯顺序 ⌃⌥⇧⌘
  const mods = ["Ctrl", "Alt", "Shift", "Meta"].filter(m => parts.includes(m)).map(m => MOD[m]);
  return mods.join("") + parts.filter(p => !MOD[p]).map(p => KEY[p] || p).join("");
}
let toastTimer = null;
function toast(msg) {
  let t = document.getElementById("wb-toast");
  if (!t) { t = document.createElement("div"); t.id = "wb-toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  // 长消息（多半是报错原因）多留一会儿，2.2 秒读不完一句「分字段「*/0」的步长必须 ≥ 1」
  toastTimer = setTimeout(() => t.classList.remove("show"), Math.min(6000, Math.max(2200, String(msg).length * 120)));
}
async function toggleAppFullscreen() {
  const r = await fetch("/api/app/fullscreen", { method: "POST" }).then(x => x.json()).catch(() => ({ ok: false }));
  if (!r.ok) { // Web 模式走浏览器全屏兜底
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
}
function navTask(dir) {
  const list = sessions.filter(s => (s.project || "默认项目") === activeProject);
  if (!list.length) return;
  let i = list.findIndex(s => s.id === sessionId);
  i = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + dir));
  if (list[i].id === sessionId) return;
  const el = document.querySelector(`.hist-item[data-id="${list[i].id}"]`);
  if (el) el.click();
}
const SHORTCUT_ACTIONS = {
  "open-settings": () => openModal("settings"),
  "voice-record": () => toast("🎤 语音录制暂未支持（复刻版）"),
  "chat-search": () => openChatSearch(),
  "new-chat": () => document.getElementById("new-task").click(),
  "stop": () => {
    const cs = document.getElementById("chat-search");
    if (mask.classList.contains("show")) mask.classList.remove("show");
    else if (cs && cs.style.display === "flex") closeChatSearch();
    else if (curBusy()) stopTask();
  },
  "prev-task": () => navTask(-1),
  "next-task": () => navTask(1),
  "toggle-sidebar": () => toggleSidebar(),
  "toggle-files": () => document.getElementById("toggle-files").onclick(),
  "fullscreen": toggleAppFullscreen,
  "toggle-window": () => {}, // 系统级快捷键由桌面版主进程注册，网页端无动作
  "open-skills": () => openHub("skills"),
  "open-experts": () => openHub("team"),
  "open-prompts": () => openPageView("prompts"),
  "open-library": () => openModal("library"),
  "open-sched": () => openModal("sched"),
  "open-assistant": () => openAssistView(),
};
document.addEventListener("keydown", (e) => {
  if (window.__scRebinding) return; // 设置页改绑捕获中，不触发动作
  const acc = accelFromEvent(e);
  if (!acc) return;
  const canon = canonAccel(acc);
  const inText = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "") || e.target.isContentEditable;
  const map = (settingsCache && settingsCache.shortcuts) || {};
  for (const [id, , def, fixed] of SHORTCUT_DEFS) {
    if (fixed || !SHORTCUT_ACTIONS[id]) continue;
    if (canonAccel(map[id] || def) !== canon) continue;
    if (!/Meta|Ctrl|Alt/.test(canon) && inText && canon !== "Escape") return; // 无修饰键的组合在输入框里只放行 Esc
    e.preventDefault();
    SHORTCUT_ACTIONS[id]();
    return;
  }
});

// ================= 对话内搜索（⌘F） =================
let csMatches = [], csIdx = -1;
function openChatSearch() {
  let bar = document.getElementById("chat-search");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "chat-search";
    bar.innerHTML = `<input id="cs-input" placeholder="搜索对话内容…"><span id="cs-count" style="color:var(--wb-text-3);font-size: 13px;white-space:nowrap"></span><button id="cs-prev" title="上一个">↑</button><button id="cs-next" title="下一个">↓</button><button id="cs-close" title="关闭 (Esc)">✕</button>`;
    document.querySelector(".main").appendChild(bar);
    bar.querySelector("#cs-input").oninput = runChatSearch;
    bar.querySelector("#cs-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); csNav(e.shiftKey ? -1 : 1); }
      if (e.key === "Escape") { e.stopPropagation(); closeChatSearch(); }
    });
    bar.querySelector("#cs-prev").onclick = () => csNav(-1);
    bar.querySelector("#cs-next").onclick = () => csNav(1);
    bar.querySelector("#cs-close").onclick = closeChatSearch;
  }
  bar.style.display = "flex";
  bar.querySelector("#cs-input").focus();
  bar.querySelector("#cs-input").select();
}
function closeChatSearch() {
  const bar = document.getElementById("chat-search");
  if (bar) bar.style.display = "none";
  csMatches.forEach(m => m.classList.remove("search-hit"));
  csMatches = [];
  csIdx = -1;
  inputEl.focus();
}
function runChatSearch() {
  csMatches.forEach(m => m.classList.remove("search-hit"));
  csMatches = [];
  csIdx = -1;
  const q = document.getElementById("cs-input").value.trim().toLowerCase();
  const cnt = document.getElementById("cs-count");
  if (!q) { cnt.textContent = ""; return; }
  for (const el of chatCol.querySelectorAll(".u-msg .bubble, .a-text")) {
    if (el.textContent.toLowerCase().includes(q)) csMatches.push(el);
  }
  cnt.textContent = csMatches.length ? `0/${csMatches.length}` : "无结果";
  if (csMatches.length) csNav(1);
}
function csNav(dir) {
  if (!csMatches.length) return;
  if (csIdx >= 0) csMatches[csIdx].classList.remove("search-hit");
  csIdx = (csIdx + dir + csMatches.length) % csMatches.length;
  csMatches[csIdx].classList.add("search-hit");
  csMatches[csIdx].scrollIntoView({ block: "center", behavior: "smooth" });
  document.getElementById("cs-count").textContent = `${csIdx + 1}/${csMatches.length}`;
}

// ================= 命令审批条（安全中心「询问名单」命中时挂起等这里批准） =================
let apSeen = new Set(); // 已经通知过的审批 id：轮询是重复的，系统通知只发一次
async function pollApprovals() {
  const d = await fetch("/api/security/approvals").then(r => (r.ok ? r.json() : null)).catch(() => null);
  const list = d && Array.isArray(d.items) ? d.items : [];
  if (d && d.mode) syncPermLabel(d.mode);
  // 审批默认 120 秒超时按拒绝：窗口不在前台时必须把人喊回来，不然任务白等一场
  const fresh = list.filter(a => !apSeen.has(a.id));
  if (apSeen.size > 500) apSeen = new Set();
  list.forEach(a => apSeen.add(a.id));
  if (fresh.length && document.hidden && "Notification" in window && Notification.permission === "granted") {
    const a = fresh[0];
    try { new Notification("🛡️ OpenWorkBuddy 等你审批", { body: `${a.source ? `「${a.source}」· ` : ""}${a.kind}：${(a.text || "").slice(0, 80)}` }); } catch {}
  }
  let bar = document.getElementById("approval-bar");
  if (!list.length) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "approval-bar";
    const inner = document.querySelector(".input-inner");
    inner.insertBefore(bar, inner.querySelector(".input-card"));
  }
  // ruleKey 为空 = 这次拦截的理由不适合被记住（碰了文件黑名单那种），只给「本次允许」
  bar.innerHTML = list.map(a => `
    <div class="ap-row">
      <div class="ap-main">
        <div class="ap-head">🛡️ ${esc(a.kind)}待审批${a.source ? ` · <span class="ap-src" title="发起审批的任务">来自「${esc(a.source)}」</span>` : ""}${a.rule ? ` · <span class="ap-why">${esc(a.rule)}</span>` : ""}</div>
        <code class="ap-cmd" title="${esc(a.text)}">${esc(a.text.slice(0, 160))}</code>
      </div>
      <div class="ap-btns">
        <button class="ap-ok" data-id="${esc(a.id)}" data-scope="once">本次允许</button>
        ${a.ruleKey ? `<button class="ap-ok2" data-id="${esc(a.id)}" data-scope="session" title="本次运行期间不再问「${esc(a.ruleKey)}」">本会话一直允许</button>
        <button class="ap-ok2" data-id="${esc(a.id)}" data-scope="always" title="把「${esc(a.ruleKey)}」写进放行名单，重启也生效">一直允许</button>` : ""}
        <button class="ap-no" data-id="${esc(a.id)}">拒绝</button>
      </div>
    </div>`).join("");
  bar.querySelectorAll("button").forEach(b => b.onclick = async () => {
    bar.querySelectorAll("button").forEach(x => (x.disabled = true));
    const allow = !b.classList.contains("ap-no");
    const r = await fetch("/api/security/approvals/" + encodeURIComponent(b.dataset.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow, scope: b.dataset.scope || "once" }),
    }).then(r => r.json()).catch(() => ({}));
    if (allow && b.dataset.scope === "always" && r.ruleKey) toast(`已永久放行「${r.ruleKey}」（可在 设置 → 安全中心 的放行名单里删掉）`);
    else if (allow && b.dataset.scope === "session" && r.ruleKey) toast(`本次运行期间不再问「${r.ruleKey}」`);
    pollApprovals();
  });
}

// ================= 权限档位（参考 Claude Code：档位 + 记住的批准） =================
let permModes = null;
function syncPermLabel(mode) {
  const el = document.getElementById("perm-label");
  if (!el || !permModes || !permModes[mode]) return;
  el.textContent = permModes[mode].label;
  document.querySelectorAll("#perm-menu .mi").forEach(x => x.classList.toggle("on", x.dataset.perm === mode));
}
async function loadPermModes() {
  const d = await fetch("/api/security/modes").then(r => r.json()).catch(() => null);
  if (!d) return;
  permModes = d.modes;
  const menu = document.getElementById("perm-menu");
  menu.innerHTML = Object.entries(d.modes)
    .map(([k, m]) => `<div class="mi" data-perm="${esc(k)}">${esc(m.label)} <span class="sub">${esc(m.desc)}</span></div>`)
    .join("");
  menu.querySelectorAll(".mi").forEach(mi => mi.onclick = async () => {
    menu.classList.remove("show");
    await setPermMode(mi.dataset.perm);
  });
  syncPermLabel(d.current);
}
async function setPermMode(mode) {
  const r = await fetch("/api/security/mode", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
  }).then(r => r.json()).catch(() => ({}));
  if (r.ok) { syncPermLabel(mode); toast(`权限档位：${permModes[mode].label}`); }
  else toast("切换失败");
}
setupPicker("perm-btn", "perm-menu");
loadPermModes();
// 审批只可能在任务运行中产生：跑任务时 3 秒一查，空闲时降到 15 秒
// （定时任务/IM 触发的后台任务也会要审批，所以空闲不能完全停）
(function approvalLoop() {
  pollApprovals().finally(() => setTimeout(approvalLoop, runningSessions.size ? 3000 : 15000));
})();


// ================= 头像编辑器（用户资料和助理设置共用一份） =================
const AVATAR_PRESETS = ["🤖", "🐱", "🐶", "🦊", "🐼", "🦉", "🧑‍💼", "👩‍💻", "🧠", "✨", "🚀", "🌈", "🍀", "☕️", "🎯"];
/** 把用户选的图压成方形小图再转 data URI：账号库/配置都是 JSON 文件，原图几 MB 塞进去会把读写拖垮 */
function shrinkImage(fileObj, size) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("读取失败"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这不是一张能显示的图片"));
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const g = c.getContext("2d");
        const side = Math.min(img.width, img.height); // 居中裁成正方形，免得头像被拉扁
        g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        let url = c.toDataURL("image/png");
        if (url.length > 120000) { // 照片类 PNG 压不下来，退成 JPEG（先垫白底，不然透明区会变黑）
          g.globalCompositeOperation = "destination-over";
          g.fillStyle = "#fff";
          g.fillRect(0, 0, size, size);
          url = c.toDataURL("image/jpeg", 0.88);
        }
        resolve(url);
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(fileObj);
  });
}
function avatarEditorHtml(p, av, fallback) {
  const a = avatarBits(av, fallback);
  return `<div style="display:flex;gap:12px;align-items:flex-start">
    <span id="${p}-prev" class="ava${a.cls ? " " + a.cls : ""}" style="width:52px;height:52px;border-radius:14px;background:var(--wb-brand-grad);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:600;flex:none;overflow:hidden">${a.html}</span>
    <div style="flex:1;min-width:0">
      <div class="form-row" style="align-items:center">
        <input id="${p}-emoji" placeholder="放一两个 emoji，或者上传一张图" value="${a.cls === "emo" ? esc(av) : ""}" style="flex:1">
        <button id="${p}-up" style="flex:none;padding:6px 12px;white-space:nowrap">上传图片</button>
        <button id="${p}-clr" style="flex:none;padding:6px 12px;white-space:nowrap">恢复默认</button>
      </div>
      <div id="${p}-presets" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:2px">${AVATAR_PRESETS.map(e => `<span class="ava-pick" data-e="${e}">${e}</span>`).join("")}</div>
      <input type="file" id="${p}-file" accept="image/*" style="display:none">
    </div>
  </div>`;
}
/** 绑上事件，返回 { value() } 取当前选中的头像值（emoji 字符串 / data URI / 空=用默认） */
function bindAvatarEditor(root, p, initial, fallback) {
  const q = (suffix) => root.querySelector("#" + p + "-" + suffix);
  const state = { av: String(initial || "") };
  const nameNow = () => (typeof fallback === "function" ? fallback() : fallback);
  const paint = () => paintAvatar(q("prev"), state.av, nameNow());
  q("emoji").oninput = () => {
    const v = q("emoji").value.trim();
    // 输入框空着又已经传过图：那是"图还在，只是没打字"，别把图清掉
    if (v || !state.av.startsWith("data:")) { state.av = v; paint(); }
  };
  q("presets").onclick = (e) => {
    const pick = e.target.closest(".ava-pick");
    if (!pick) return;
    q("emoji").value = pick.dataset.e;
    state.av = pick.dataset.e;
    paint();
  };
  q("up").onclick = () => q("file").click();
  q("clr").onclick = () => { q("emoji").value = ""; state.av = ""; paint(); };
  q("file").onchange = async () => {
    const f = q("file").files && q("file").files[0];
    q("file").value = ""; // 允许连续选同一个文件
    if (!f) return;
    try {
      state.av = await shrinkImage(f, 128);
      q("emoji").value = "";
      paint();
    } catch (e) { toast("图片用不了：" + e.message); }
  };
  return { value: () => state.av };
}

// ================= 账号 · 积分 · 用量 =================
// 积分闸门开没开（服务端 /api/auth/state 说了算，默认没开）。关着的时候整套积分 UI
// 都不出现——余额、充值、扣分提示，一个不显示：本地个人用根本没有额度这回事。
let creditsOn = false;

/** 改昵称 / 换头像 / 改登录名（要密码确认，历史会话和用量流水会一起搬过去） */
function renderProfile() {
  const u = currentUser || {};
  mTitle.textContent = "🪪 个人资料";
  mBody.innerHTML = `<div class="card-item">
      <div class="t">头像</div>
      <div class="d" style="margin-bottom:8px">emoji 或者一张图都行，图会自动裁成方的压到 128px。</div>
      ${avatarEditorHtml("pf", u.avatar, u.username)}
    </div>
    <div class="card-item">
      <div class="t">昵称</div>
      <div class="d" style="margin-bottom:8px">界面上显示的名字，留空就用登录名。</div>
      <input id="pf-nick" maxlength="24" placeholder="${esc(u.username)}" value="${esc(u.nickname || "")}">
    </div>
    <button class="btn-brand" id="pf-save">保存</button>
    <button id="pf-back" style="padding:6px 14px;margin-left:6px">返回账号</button>
    <span class="ok-msg" id="pf-msg"></span>
    <div class="card-item" style="margin-top:14px">
      <div class="t">登录名</div>
      <div class="d" style="margin-bottom:8px">登录时输的那个名字，现在是 <b>${esc(u.username)}</b>。
        改它等于换身份，所以要拿密码确认一次；历史会话、用量流水、登录状态都会一起搬过去，不用重新登录。</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="pf-uname" maxlength="24" placeholder="新的登录名" value="${esc(u.username)}" style="max-width:180px">
        <input id="pf-upass" type="password" placeholder="当前密码" style="max-width:180px">
        <button id="pf-uname-go" style="padding:6px 14px">改登录名</button>
        <span class="ok-msg" id="pf-uname-msg"></span>
      </div>
    </div>`;
  const ed = bindAvatarEditor(mBody, "pf", u.avatar, () => mBody.querySelector("#pf-nick").value.trim() || u.username);
  mBody.querySelector("#pf-back").onclick = () => { mTitle.textContent = "👤 账号 · 用量"; renderAccount(); };
  mBody.querySelector("#pf-save").onclick = async () => {
    const msg = mBody.querySelector("#pf-msg");
    const resp = await fetch("/api/auth/profile", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: mBody.querySelector("#pf-nick").value, avatar: ed.value() }),
    }).catch(() => null);
    const r = resp ? await resp.json().catch(() => ({})) : {};
    if (resp && resp.ok) {
      currentUser = r.user;
      renderUserChip();
      msg.style.color = "";
      msg.textContent = "✅ 已保存";
    } else { msg.style.color = "var(--wb-err)"; msg.textContent = r.error || "保存失败"; }
  };
  mBody.querySelector("#pf-uname-go").onclick = async () => {
    const msg = mBody.querySelector("#pf-uname-msg");
    const name = mBody.querySelector("#pf-uname").value.trim();
    if (name === u.username) { msg.style.color = ""; msg.textContent = "跟现在一样，没改"; return; }
    const resp = await fetch("/api/auth/username", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: name, password: mBody.querySelector("#pf-upass").value }),
    }).catch(() => null);
    const r = resp ? await resp.json().catch(() => ({})) : {};
    if (resp && resp.ok) {
      currentUser = r.user;
      renderUserChip();
      msg.style.color = "";
      msg.textContent = `✅ 已改成 ${r.user.username}`;
      mBody.querySelector("#pf-upass").value = "";
      setTimeout(() => renderProfile(), 900); // 重画一遍，把"现在是 xxx"那句更新掉
    } else { msg.style.color = "var(--wb-err)"; msg.textContent = r.error || "改不动"; }
  };
}
function renderUserChip() {
  const row = document.getElementById("user-row"), chip = document.getElementById("user-chip");
  if (!currentUser) { row.style.display = "none"; return; }
  row.style.display = "flex";
  const av = avatarBits(currentUser.avatar, currentUser.username);
  chip.innerHTML = `<span class="ava${av.cls ? " " + av.cls : ""}">${av.html}</span>`
    + `<span class="un">${esc(displayName(currentUser))}${currentUser.role === "admin" ? " · 管理员" : ""}</span>`
    // 不限额时不显示余额：一个永远不会动、也拦不住任何事的数字挂在那里只会让人担心
    + (creditsOn ? `<span class="uc">✦ ${(+currentUser.credits).toLocaleString()}</span>` : "");
  chip.onclick = (e) => { e.stopPropagation(); toggleUserMenu(); };
}
document.getElementById("gear-btn").onclick = () => { closeUserMenu(); openModal("settings"); };

// ---------- 外观（浅色/深色/跟随系统，存本机） ----------
const THEME_LABEL = { light: "浅色", dark: "深色", system: "跟随系统" };
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
function getTheme() { const t = localStorage.getItem("wb-theme"); return THEME_LABEL[t] ? t : "system"; }
function applyTheme() {
  const t = getTheme();
  document.documentElement.dataset.theme = t === "dark" || (t === "system" && themeMedia.matches) ? "dark" : "light";
}
themeMedia.addEventListener("change", applyTheme);
function setTheme(t) { localStorage.setItem("wb-theme", t); applyTheme(); }
applyTheme();

// ---------- 头像菜单：设置 / 外观 / 帮助与反馈 / 检查更新 / 退出登录 ----------
const userMenu = document.getElementById("user-menu");
function closeUserMenu() { userMenu.classList.remove("show"); }
function toggleUserMenu() { userMenu.classList.contains("show") ? closeUserMenu() : openUserMenu(); }
function openUserMenu() {
  if (!currentUser) return;
  const av = avatarBits(currentUser.avatar, currentUser.username);
  userMenu.innerHTML = `
    <div class="um-head" data-act="account" title="点击查看用量明细">
      <span class="ava${av.cls ? " " + av.cls : ""}" style="width:30px;height:30px;border-radius:50%;background:var(--wb-brand-grad);color:#fff;display:flex;align-items:center;justify-content:center;font-size: 15px;font-weight:600;flex:none;overflow:hidden">${av.html}</span>
      <div style="min-width:0"><div class="n">${esc(displayName(currentUser))}${currentUser.role === "admin" ? " · 管理员" : ""}</div>
      <div class="s">${creditsOn ? `✦ ${(+currentUser.credits).toLocaleString()} 积分 · ` : ""}账号与用量</div></div>
    </div>
    <div class="um-i" data-act="profile">🪪 个人资料 <span class="hint">改名字 · 换头像</span></div>
    <div class="um-i" data-act="settings">⚙️ 设置</div>
    <div class="um-i" data-act="appearance">🌗 外观 <span class="hint">${THEME_LABEL[getTheme()]} ▾</span></div>
    <div class="um-sub" id="um-theme" style="display:none">${Object.entries(THEME_LABEL).map(([k, l]) =>
      `<div class="um-opt" data-theme="${k}">${l}${getTheme() === k ? '<span class="ck">✓</span>' : ""}</div>`).join("")}</div>
    <div class="um-i" data-act="help">💬 帮助与反馈</div>
    <div class="um-i" data-act="update">🔄 检查更新</div>
    <div class="um-i" data-act="logout" style="color:var(--wb-err)">↪ 退出登录</div>`;
  userMenu.querySelectorAll("[data-act]").forEach(el => el.onclick = async (e) => {
    e.stopPropagation();
    const act = el.dataset.act;
    if (act === "appearance") {
      const sub = document.getElementById("um-theme");
      sub.style.display = sub.style.display === "none" ? "block" : "none";
      return;
    }
    closeUserMenu();
    if (act === "account") openModal("account");
    else if (act === "profile") { await openModal("account"); renderProfile(); }
    else if (act === "settings") openModal("settings");
    else if (act === "help") openModal("settings", "about");
    else if (act === "update") checkUpdate();
    else if (act === "logout") { await fetch("/api/auth/logout", { method: "POST" }); location.reload(); }
  });
  userMenu.querySelectorAll(".um-opt").forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    setTheme(el.dataset.theme);
    openUserMenu(); // 重画勾选状态，菜单保持展开
    document.getElementById("um-theme").style.display = "block";
  });
  userMenu.classList.add("show");
}
document.addEventListener("click", (e) => { if (!e.target.closest("#user-row")) closeUserMenu(); });

// 代码块「复制」按钮（事件委托，覆盖所有历史与流式渲染出的代码块）
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".code-copy");
  if (!btn) return;
  const pre = btn.closest(".code-wrap")?.querySelector("pre");
  if (!pre) return;
  const text = pre.textContent || "";
  const done = () => { btn.textContent = "已复制 ✓"; setTimeout(() => { btn.textContent = "复制"; }, 1500); };
  if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done)); }
  else fallbackCopy(text, done);
  function fallbackCopy(t, cb) {
    const ta = document.createElement("textarea");
    ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(ta); cb();
  }
});

// 内联 SVG 图表的三个动作（事件委托，历史回放与流式渲染共用）
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".svg-fig .svg-acts button");
  if (!btn) return;
  const fig = btn.closest(".svg-fig");
  const raw = fig.dataset.src || "";
  const act = btn.dataset.a;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  if (act === "svg-code") {
    const box = fig.querySelector(".svg-raw");
    if (box) { box.remove(); btn.textContent = "源码"; return; }
    const pre = document.createElement("pre");
    pre.className = "svg-raw";
    pre.textContent = raw;
    fig.insertBefore(pre, fig.querySelector(".svg-acts"));
    btn.textContent = "收起源码";
    return;
  }
  if (act === "svg-save") return saveInlineFile(`图表-${stamp}.svg`, fig.querySelector("svg").outerHTML, btn);
  if (act === "svg-png") {
    btn.disabled = true;
    try { await saveInlineFile(`图表-${stamp}.png`, await SvgFig.svgToPngDataUrl(fig.querySelector("svg")), btn); }
    catch (err) { toast("转图片失败：" + err.message); }
    finally { btn.disabled = false; }
  }
});
async function saveInlineFile(name, content, btn) {
  const r = await fetch("/api/files/save", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, content }),
  }).then(x => x.json()).catch(() => null);
  if (!r?.ok) return toast("保存失败：" + (r?.error || "接口无响应"));
  if (r.files) renderFiles(r.files);
  const old = btn.textContent;
  btn.textContent = "已存 ✓";
  setTimeout(() => { btn.textContent = old; }, 1600);
  toast(`已存到工作目录：${name}`);
}

async function checkUpdate() {
  toast("正在检查更新…");
  const r = await fetch("/api/app/update-check", { method: "POST" }).then(x => x.json()).catch(() => null);
  if (!r) return toast("检查更新失败：接口无响应");
  if (!r.ok) return toast(`当前版本 v${r.version || "?"} · ${r.reason}`);
  toast(r.behind > 0 ? `发现新版本：本地落后 ${r.behind} 个提交，在项目目录执行 git pull 后重启即可` : `已是最新版本（v${r.version}）`);
}
const SRC_TXT = { web: "网页", cli: "CLI", im: "IM", schedule: "定时" };
