// menu 不传就是输入框右下角那个；助理页顶栏那个把自己的容器传进来，两处共用同一份菜单
function renderModelMenu(menu = modelMenu) {
  if (!settingsCache || !menu) return;
  // 本机 CLI 在跑：这一整排 API 模型都是摆设，别再让用户点了以为生效。
  // 只在输入框那个选择器上换（menu === modelMenu）；助理页顶栏那个走的还是 API，不受影响
  const eng = menu === modelMenu ? activeEngine() : null;
  if (eng) {
    // 这里不是一排可选项，是一张「现在谁在跑」的说明卡：
    // 说明文字必须能换行（以前塞在 .mi 里，而 .mi 是 nowrap 的，菜单被撑成一整行宽，
    // 飞出屏幕左边，字都看不全），能点的只有最后那一行——所以只有它长得像按钮。
    menu.classList.add("eng");
    menu.innerHTML = `<div class="ep-head"><span class="ep-ic">${ic("monitor")}</span>
        <span class="ep-name">${esc(eng.label)}<span class="ep-model">${esc(eng.model || "用它自己的默认模型")}</span></span>
        <span class="ep-on">${ic("check")}</span></div>
      <div class="ep-why"><b class="ep-free">不花 API 额度</b>用你电脑上这个 CLI 的登录态和它自己的模型跑，所以下面那排 API 模型这会儿一个都用不上。</div>
      <div class="mi ep-act" data-act="engine">${ic("settings")}改它的模型 / 换回内置引擎…</div>`;
    menu.querySelectorAll(".mi[data-act]").forEach((mi) => (mi.onclick = () => { menu.classList.remove("show"); openModal("settings", "agent"); }));
    return;
  }
  menu.classList.remove("eng");
  const ov = currentSessModel();
  menu.innerHTML = `<div class="mi ${ov ? "" : "on"}" data-act="default" style="justify-content:space-between">
      <span>${ic("rotate-ccw")}跟随全局默认 <span class="sub">${esc(settingsCache.active_model)}${healthBadge(settingsCache.active_model)}</span></span>${ov ? "" : `<span style="color:var(--wb-ok-text)">${ic("check")}</span>`}</div>`
    + settingsCache.models.map(m => {
      const on = m.name === ov;
      return `<div class="mi ${on ? "on" : ""}" data-name="${esc(m.name)}" style="justify-content:space-between">
      <span>${ic("sparkles")}${esc(m.name)} <span class="sub">${esc(m.model)}${m.api_key ? "" : ` · ${ic("triangle-alert")}未填Key`}${healthBadge(m.name)}</span></span>
      ${on ? `<span style="color:var(--wb-ok-text)">${ic("check")}</span>` : ""}</div>`;
    }).join("")
    + `<div class="mi" data-act="manage" style="border-top:1px solid var(--wb-border);margin-top:4px">${ic("settings")}管理模型…</div>`;
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
  const done = g.status === "done";
  card.style.display = "";
  card.classList.toggle("ok", done);
  // 一张卡要回答三件事：还差几项、卡在哪一项、现在是在跑还是停了。
  // 进度条是给「扫一眼」用的——一排勾勾看不出离终点还有多远
  card.innerHTML = `
    <div class="gc-head">
      <span class="gc-title">${ic("target")}${esc(g.text)}</span>
      <span class="gc-meta">${done ? `<span class="gc-done">已达成${ic("check")}</span>` : `${doneN}/${g.criteria.length} 项 · 第 ${g.round || 0} 轮`}</span>
      <button class="gc-close" title="归档目标（不再显示，也不再按它验收）">${ic("x")}</button>
    </div>
    <div class="gc-bar"><i style="width:${g.criteria.length ? Math.round((doneN / g.criteria.length) * 100) : 0}%"></i></div>
    <div class="gc-list">${g.criteria.map(c => `<div class="gc-item ${c.done ? "ok" : ""}">${ic(c.done ? "circle-check" : "circle")}${esc(c.text)}</div>`).join("")}</div>
    ${g.note ? `<div class="gc-note">${ic("triangle-alert")}${esc(g.note)}</div>` : ""}
    ${!done && g.paused ? `<div class="gc-paused"><span>${ic("pause")}${esc(g.paused)}</span><button class="gc-go">接着冲</button></div>` : ""}`;
  card.querySelector(".gc-close").onclick = async () => {
    try { await fetch("/api/session/" + encodeURIComponent(sessionId) + "/goal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "close" }) }); } catch {}
    g.status = "closed";
    renderGoalCard();
  };
  const go = card.querySelector(".gc-go");
  // 「接着冲」＝再开 GOAL_MAX_ROUNDS 轮，但只补没打勾的那几项：把烧不烧钱这个决定交回用户手里
  if (go) go.onclick = () => {
    const unmet = g.criteria.filter(c => !c.done).map(c => "· " + c.text).join("\n");
    g.paused = "";
    renderGoalCard();
    doSend(`接着冲这个目标，只补下面这些还没达成的验收标准，已达成的别重做：\n${unmet}`, "goal");
  };
}

// ================= 工作空间选择（快捷栏，仿官方"选择工作空间"） =================
const wsMenu = setupPicker("ws-btn", "ws-menu");
/** 切工作目录改的是整台服务器那一份，打开文件夹开的是服务端那台机器——两样都不是成员能做的。
 *  所以成员那边只留一条只读的「现在在哪」，另外两条不画：一颗必然 403 的菜单项，
 *  点下去要么没反应，要么（更糟）弹个输入框让他认真填完路径，然后一声不吭。 */
async function setWorkspaceDir(p) {
  const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace_dir: p }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { toast((j.error || "切换工作空间失败"), "circle-x"); return false; }
  refreshSettingsCache();
  return true;
}
function renderWsMenu() {
  const owner = amPlatformOwner();
  wsMenu.innerHTML =
    `<div class="mi ro" data-cur="1">${ic("folder")}${esc(settingsCache.workspace_dir)}</div>` +
    (owner ? `<div class="mi" data-act="pick">${ic("folder-open")}选择新文件夹…</div>` : "") +
    (canOpenOnHost() ? `<div class="mi" data-act="open">${ic("folder-tree")}打开当前文件夹</div>` : "") +
    (owner ? "" : `<div class="mi ro sub-only">这台服务器上大家共用一个工作目录，归平台管理员设</div>`);
  wsMenu.querySelectorAll(".mi").forEach(mi => mi.onclick = async () => {
    wsMenu.classList.remove("show");
    if (mi.dataset.act === "pick") {
      // 501 才是「这台机器弹不出系统选择框」，该退回手填；别的非 2xx 是真出事了，说出来
      const resp = await fetch("/api/pick-folder", { method: "POST" }).catch(() => null);
      const r = resp ? await resp.json().catch(() => ({})) : {};
      if (!resp) return toast("选择文件夹失败", "circle-x");
      if (r.path) {
        if (await setWorkspaceDir(r.path)) fetch("/api/files").then(x => x.json()).then(renderFiles);
      } else if (resp.status === 501) {
        const p = prompt("输入工作空间文件夹的完整路径：", settingsCache.workspace_dir);
        if (p) await setWorkspaceDir(p);
      } else if (!resp.ok || r.error) {
        toast((r.error || "选择文件夹失败"), "circle-x");
      }
    } else if (mi.dataset.act === "open") {
      openWorkspaceOnHost();
    }
  });
}
refreshSettingsCache();

// ================= 模式选择（快捷栏"默认权限"式下拉） =================
const modeMenu = setupPicker("mode-btn", "mode-menu");
// 只留字。图标在 index.html 的下拉里已经是 sprite 了，按钮上那个跟着切——
// 以前这儿是「✅ Craft · 执行」，显示时还得 .slice(2) 把表情切掉，加一个模式就要记着切几个字符
const MODE_LABEL = { craft: "Craft · 执行", goal: "Goal · 目标", plan: "Plan · 规划", ask: "Ask · 问答" };
const MODE_ICON = { craft: "circle-check", goal: "target", plan: "map", ask: "message-circle" };
function setMode(mode) {
  currentMode = mode;
  document.getElementById("mode-label").textContent = MODE_LABEL[mode];
  const mbi = document.querySelector("#mode-btn .i"); // 按钮上的图标跟着模式换，别一直停在 Craft 那个
  if (mbi) mbi.outerHTML = ic(MODE_ICON[mode] || "circle-check");
  modeMenu.querySelectorAll(".mi").forEach(x => x.classList.toggle("on", x.dataset.mode === mode));
  syncPlaceholder();
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
  syncSendBtn(); // 运行中光贴了个附件也算「有话要说」，按钮得从「停下」变回「发出」
  const chip = document.createElement("span");
  if (thumbUrl) {
    // 截图之间光看文件名分不出谁是谁，给张缩略图才知道自己贴对了没有
    const img = document.createElement("img");
    img.src = thumbUrl;
    img.className = "attach-thumb";
    img.alt = "";
    chip.appendChild(img);
  }
  if (!thumbUrl) chip.insertAdjacentHTML("beforeend", ic("paperclip"));
  chip.appendChild(document.createTextNode(name));
  if (hint) chip.title = hint; // 鼠标停上去能看见开头几行，确认贴的是哪一段
  const x = document.createElement("b");
  x.innerHTML = ic("x", "i-sm");
  x.title = "从这条消息移除（文件仍在工作目录里）";
  x.onclick = () => { const i = pendingAttach.indexOf(name); if (i >= 0) pendingAttach.splice(i, 1); chip.remove(); syncSendBtn(); };
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
    // 带上会话 id：服务端好把文件直接放进本对话的成果文件夹，别再堆到工作空间根目录
    body: JSON.stringify({ name, data_b64: b64, session: sessionId }),
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
      toast(`上传失败: ${file.name}`, "circle-x"); // 拖进来的是文件夹时读不出内容，也走这里
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
    toast("文字存盘失败，已按普通粘贴处理", "circle-x");
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
  syncSendBtn(); // 框清空了：任务还在跑的话按钮回到「停下」
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

// ================= 两条工作线：办公 / 工程 =================
/**
 * 同一个人一天里在两种活儿之间来回切：做表写稿出图（鼠标流），和写代码跑脚本查日志（键盘流）。
 * 两种活儿的历史混在一列里，找东西全靠翻——所以分成两条线，各记各的会话，共用同一份文件和工作目录。
 *
 * 工程线还多一件事：它连着**这台机器的 `wb` 命令行**。在终端里起的任务会自己挂到服务端能读到的
 * 目录里，这条线上就看得见它此刻在干什么、也能从手机上补一句话。这就是「人在外面，接管电脑里
 * 那个正在干活的 agent」那个场景——也是这两个标签存在的全部理由。
 *
 * 注意分的是活儿，不是引擎。底层引擎在设置里挑一次，两条线照着同一个跑。
 */
function laneOfSession(s) {
  const v = s && s.lane;
  return v === "cli" || v === "office" ? v : defaultLane;
}
function renderLaneTabs() {
  const box = document.getElementById("lane-tabs");
  if (!box) return;
  const rows = laneInfo.length ? laneInfo : LANE_FALLBACK;
  const liveN = cliLiveRows.filter((r) => r.live).length;
  box.innerHTML = rows.map((l) => {
    const on = l.id === activeLane;
    const tip = [l.hint || "", l.detail || ""].filter(Boolean).join("\n");
    // 终端里有活儿在跑就把数字标在「工程」上：人在别的标签下也知道那边有东西在动
    const badge = l.id === "cli" && liveN
      ? `<span class="lt-live" title="${esc("终端里有 " + liveN + " 趟活儿在跑")}">${liveN}</span>` : "";
    return `<button type="button" role="tab" aria-selected="${on}" class="${on ? "on" : ""}" data-lane="${esc(l.id)}" title="${esc(tip)}">`
      + ic(l.id === "cli" ? "terminal" : "briefcase")
      + `<span class="lt-name">${esc(l.name)}</span>${badge}</button>`;
  }).join("");
}
/** 两条线的门面话术由服务端给（跟命令行、跟 IM 那边用的是同一份），顺手把终端里那几趟也带回来 */
async function refreshLanes() {
  try {
    const d = await fetch("/api/lanes").then((r) => r.json());
    if (!d || !Array.isArray(d.lanes) || !d.lanes.length) return; // 老版本服务端没这接口：照旧用兜底那两行
    laneInfo = d.lanes;
    if (d.current === "cli" || d.current === "office") defaultLane = d.current;
    if (Array.isArray(d.cliLive)) cliLiveRows = d.cliLive;
    let saved = null;
    try { saved = localStorage.getItem("wb_lane"); } catch {}
    if (saved !== "cli" && saved !== "office") activeLane = defaultLane;
  } catch {}
  renderLaneTabs();
  renderHistory();
}
document.getElementById("lane-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-lane]");
  if (!btn || btn.dataset.lane === activeLane) return;
  activeLane = btn.dataset.lane;
  try { localStorage.setItem("wb_lane", activeLane); } catch {}
  renderLaneTabs();
  // 当前开着的这条对话属于另一条线：切过去等于换了张桌子，给一张空白的新任务。
  // 正在后台跑的任务不受影响（它绑的是自己的 sid，切走照跑，回来还能接上直播）。
  const cur = sessionId && sessions.find((x) => x.id === sessionId);
  if (cliWatch || (cur && laneOfSession(cur) !== activeLane)) document.getElementById("new-task").click();
  else renderHistory();
});

// ---------- 工程线：终端（wb 命令行）里正在跑的活儿 ----------
/**
 * 终端是另一个进程，服务端也只是替我们读那个目录，所以只能轮询。
 * 人就在工程线上看着时勤一点，在办公线上懒一点——标签上那个数字不许是假的，
 * 但也没必要为了它一直占着网络。租户成员根本看不到终端，服务端说一声之后就彻底不问了。
 */
let cliPollStop = false;
function cliLiveKey(rows) { return rows.map((r) => r.id + ":" + (r.live ? 1 : 0)).join(","); }
async function pollCliLive() {
  if (cliPollStop) return;
  let next = activeLane === "cli" ? 3000 : 20000;
  try {
    const d = await fetch("/api/cli/live").then((r) => r.json());
    if (d && d.allowed === false) { cliPollStop = true; return; }
    if (d && Array.isArray(d.rows)) {
      const before = cliLiveKey(cliLiveRows);
      cliLiveRows = d.rows;
      if (before !== cliLiveKey(cliLiveRows)) { renderLaneTabs(); renderHistory(); }
      // 正在跟的那趟结束了：流那边也会发 cli_end，这里是它断线时的兜底
      if (cliWatch && cliWatch.live && !cliLiveRows.some((r) => r.id === cliWatch.id && r.live)) {
        finishCliWatch({ type: "cli_end", ok: true });
      }
    }
  } catch { next = 30000; } // 网断了别一秒一次地撞
  setTimeout(pollCliLive, next);
}

/** 跟一趟终端里的活儿：它此刻在干什么，原样放到对话区里，跟本机跑的任务长一个样 */
async function openCliLive(row) {
  closeAssistView();
  stopCliWatch();
  sessionId = row.id;
  pvPanel.classList.remove("show"); pvCurrent = null;
  document.getElementById("files-panel").classList.remove("show");
  document.getElementById("session-title").textContent = stripSceneTag(row.title) || "终端里的任务";
  chatCol.innerHTML = "";
  document.getElementById("empty")?.remove();
  const ui = createTurnUI(row.title || "（终端里起的任务）", "craft", row.id);
  if (ui.turn && !ui.turn.parentNode) chatCol.appendChild(ui.turn);
  cliWatch = { id: row.id, es: null, ui, live: !!row.live };
  renderHistory();
  updateSendUI();
  let es = null;
  try { es = new EventSource("/api/cli/stream/" + encodeURIComponent(row.id) + "?from=0"); } catch {}
  if (!es) { cliWatch.live = false; ui.finish(); updateSendUI(); return; }
  cliWatch.es = es;
  es.onmessage = (e) => {
    let ev = null;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === "cli_end") { finishCliWatch(ev); return; }
    ui.handleEvent(ev);
  };
  // 断线了就停在原地：已经看到的内容不许抹掉，也别装作还在直播
  es.onerror = () => { if (cliWatch && cliWatch.es === es) { try { es.close(); } catch {} } };
}
function stopCliWatch() {
  if (!cliWatch) return;
  try { if (cliWatch.es) cliWatch.es.close(); } catch {}
  cliWatch = null;
}
/** 终端里那趟收尾了：把画面定格，顺手把它当成一条普通历史记下来（会话文件是命令行那边存的） */
function finishCliWatch(ev) {
  if (!cliWatch) return;
  const w = cliWatch;
  w.live = false;
  try { if (w.es) w.es.close(); } catch {}
  w.es = null;
  if (ev && ev.error) w.ui.handleEvent({ type: "error", message: String(ev.error) });
  w.ui.finish();
  const row = cliLiveRows.find((r) => r.id === w.id);
  if (!sessions.some((x) => x.id === w.id)) {
    sessions.unshift({ id: w.id, title: (row && row.title) || "终端里的任务", at: (row && row.startedAt) || Date.now(), lane: "cli" });
    saveSessions();
  }
  bumpDoneWhileAway((row && row.title) || "终端里的任务");
  renderHistory();
  updateSendUI();
}
/** 往终端里那趟插一句话。送不到就直说，别在界面上显示「已发送」 */
async function interjectCli(text) {
  const id = cliWatch && cliWatch.id;
  if (!id) return;
  const resp = await fetch("/api/cli/interject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: id, message: text }),
  }).catch(() => null);
  if (resp && resp.ok) {
    if (cliWatch.ui.markPendingInterject) cliWatch.ui.markPendingInterject(text);
    else toast("收到，终端里那位做完这一步就看你这句");
  } else {
    let why = "送不到终端";
    try { why = (await resp.json()).error || why; } catch {}
    toast("没送出去：" + why);
  }
}

// ================= 会话历史（服务端持久化 + 回放，按项目过滤） =================
/** 当前项目下的任务。租户端没有「项目」这回事（服务端 locked），一条都不过滤——
 *  以前那儿顶着个假项目「本组织工作目录」，跟老会话记的项目名对不上，整排历史被过滤没了。*/
function projectSessions() {
  // 工程线不按项目过滤：终端里 `wb` 起的任务没有「项目」这个概念（命令行不问这个），
  // 一过滤就整条线空着，看起来像功能坏了。这条线本来就是「这台机器的终端干过的活儿」。
  if (activeLane === "cli") return sessions.filter(s => laneOfSession(s) === "cli");
  const inProject = projectsLocked ? sessions : sessions.filter(s => (s.project || "默认项目") === activeProject);
  // 再按工作线分栏：办公那条线的历史不该混进工程标签里（反过来也一样）。
  // 老会话没记过 lane，按服务端算的回落值归位——不会整批「消失」到另一个标签底下
  return inProject.filter(s => laneOfSession(s) === activeLane);
}
function renderHistory() {
  const list = projectSessions();
  const rows = list.map(s =>
    `<div class="hist-item ${s.id === sessionId ? "active" : ""}" data-id="${s.id}" title="${esc(stripSceneTag(s.title))}"><span class="ht">${esc(stripSceneTag(s.title))}</span>${runningSessions.has(s.id) ? '<span class="hrun" title="任务运行中"></span>' : ""}<span class="hx" title="删除该任务">${ic("x")}</span></div>`);
  // 工程线顶上单独一撮：这台机器的终端此刻正在跑的活儿。点进去就能看见它在干什么、插话。
  // 已经在历史里的不重复列（跑完之后它就是一条普通记录了）
  let head = "";
  if (activeLane === "cli") {
    const known = new Set(list.map((s) => s.id));
    const live = cliLiveRows.filter((r) => !known.has(r.id));
    if (live.length) {
      head = `<div class="hist-group">${esc("终端里（wb 命令行）")}</div>` + live.map((r) => {
        const t = stripSceneTag(r.title) || "终端里的任务";
        const tip = r.live ? "正在跑——点开能看见它在干什么，也能插话" : (r.died ? "终端被关掉了，没跑完" : "刚跑完");
        return `<div class="hist-item ${r.id === sessionId ? "active" : ""}" data-cli="${esc(r.id)}" title="${esc(t + "\n" + (r.cwd || "") + "\n" + tip)}">`
          + `<span class="ht">${esc(t)}</span>${r.live ? '<span class="hrun" title="正在跑"></span>' : ""}</div>`;
      }).join("");
    }
  }
  const empty = activeLane === "cli"
    ? "这条线还空着。在终端里跑 <code>wb 你的活儿</code>，它就会出现在这儿——手机上也看得见。"
    : (projectsLocked ? "这条线上还没有任务" : "该项目在这条线上还没有任务");
  document.getElementById("history").innerHTML = head + rows.join("")
    || `<div class="hist-empty">${empty}</div>`;
}
document.getElementById("history").addEventListener("click", async (e) => {
  const item = e.target.closest(".hist-item");
  if (!item) return;
  if (item.dataset.cli) { // 终端里那趟：跟直播，不是回放存下来的记录
    const row = cliLiveRows.find((r) => r.id === item.dataset.cli);
    if (row) await openCliLive(row);
    return;
  }
  if (e.target.closest(".hx")) {
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
  await openSession(item.dataset.id);
});

/** 打开一个会话并回放它的对话（历史列表点击 / 评测页「打开对话」都走这里） */
async function openSession(id) {
  closeAssistView();
  stopCliWatch(); // 换了会话就别再往上一趟里塞事件了
  sessionId = id;
  // 上个会话开着的预览/文件面板不带进来
  pvPanel.classList.remove("show"); pvCurrent = null;
  document.getElementById("files-panel").classList.remove("show");
  const s = sessions.find(x => x.id === sessionId);
  // 从别处打开的对话（搜索、评测页「打开对话」）可能属于另一条工作线：标签跟着切过去，
  // 不然侧栏里高亮的那条根本不在当前列表里，用户会以为自己点丢了
  const sLane = laneOfSession(s);
  if (s && sLane !== activeLane) {
    activeLane = sLane;
    try { localStorage.setItem("wb_lane", activeLane); } catch {}
    renderLaneTabs();
  }
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
  replayFeedback = new Map((data.feedback || []).filter(f => f && f.turn != null).map(f => [f.turn, f]));
  try {
    for (const entry of transcript) {
      if (entry.type === "user") {
        ui = createTurnUI(entry.text, entry.mode);
      } else if (entry.type === "assistant" && ui) {
        for (const ev of entry.events || []) ui.handleEvent(ev);
        ui.finish();
      }
    }
  } finally { isReplaying = false; replayFeedback = null; }
  if (live) {
    document.getElementById("empty")?.remove();
    chatCol.appendChild(live.ui.turn);
  } else if (!transcript.length) {
    chatCol.innerHTML = '<div style="text-align:center;color:var(--wb-text-3);font-size: 13px;padding:20px">该任务还没有保存的对话记录（可能创建于旧版本），继续对话即可。</div>';
  }
  updateSendUI();
  scrollBottom(true);
}
document.getElementById("new-task").onclick = () => {
  closeAssistView();
  stopCliWatch();
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
renderLaneTabs();
refreshLanes();
pollCliLive(); // 这台机器的终端里有没有在跑活儿——工程线那个数字就是它
reattachRunning(); // 刷新页面不丢正在跑的任务：找回并接上直播

// ================= 项目（多工作空间，任务历史按项目分组；projects/activeProject 声明在顶部基础状态区） =================
async function refreshProjects() {
  try {
    const data = await fetch("/api/projects").then(r => r.json());
    projects = data.projects || [];
    projectsLocked = !!data.locked;
    activeProject = data.active || (projectsLocked ? "" : "默认项目");
  } catch {}
  renderProjects();
  renderHistory();
}
function renderProjects() {
  const box = document.getElementById("proj-list");
  if (!box) return;
  // 租户成员没有项目可管（后端对 /api/projects 的写操作一律 403），侧栏连「项目」这一栏都不该出现，
  // 更不该出现一个点不动的 tab。用 style.display 而不是 hidden：.side-nav .item 自带 display，hidden 压不住。
  const head = document.querySelector('.side-nav [data-view="proj"]');
  if (head) head.style.display = projectsLocked ? "none" : "";
  box.style.display = projectsLocked ? "none" : "";
  if (projectsLocked) { box.innerHTML = ""; return; }
  box.innerHTML = projects.map(p =>
    `<div class="proj-item ${p.name === activeProject ? "active" : ""}" data-name="${esc(p.name)}" title="${esc(p.dir)}">${ic("folder-open")}<span class="pn">${esc(p.name)}</span>${projects.length > 1 ? `<span class="del" title="移除项目（不删文件）">${ic("x")}</span>` : ""}</div>`).join("");
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
    if (!resp.ok) { toast((data.error || "创建失败"), "circle-x"); return; }
    document.getElementById("new-task").click();
    refreshProjects().then(refreshSettingsCache);
  };
};
refreshProjects();

// ================= 发送（运行中按钮变「停止」） =================
// ================= 并行任务：运行态/排队按会话隔离，不同对话互不阻塞 =================
const MODE_PLACEHOLDER = {
  ask: "问我任何问题（不会修改文件）…",
  goal: "描述你的目标，我拆成验收标准，没达成自动接着跑…",
  plan: "描述任务，我先给你出执行计划…",
  craft: "今天帮你做些什么？可以让我处理数据、写报告、做 PPT、联网调研…",
};
const BUSY_PLACEHOLDER = "想补一句或改方向？直接打字，按 Enter 就插进来，我做完这一步就看";
const CLI_PLACEHOLDER = "这趟是在终端里跑的。打字按 Enter 能插一句给它；想让它停，回终端按 Ctrl+C";
/** 输入框的提示语跟着状态走：任务在跑时告诉用户「打字 + Enter 就能插话」，闲着时按模式提示 */
function syncPlaceholder() {
  // 跟着终端里那趟活儿时只能插话，停不了——停它得回终端按 Ctrl+C。这里就照实说
  inputEl.placeholder = cliBusy() ? CLI_PLACEHOLDER
    : curBusy() ? BUSY_PLACEHOLDER
    : (MODE_PLACEHOLDER[currentMode] || MODE_PLACEHOLDER.craft);
}
/** 框里有没有还没发出去的东西（文字或待发附件） */
function hasDraft() { return !!(inputEl.value.trim() || pendingAttach.length); }
/**
 * 一颗键两种意思，看框里有没有字：任务在跑 + 框空着 → 「◼ 停下」；任务在跑 + 打了字 → 「↑ 插一句」（发出去就是插队）；
 * 闲着 → 普通发送。以前运行中不管框里有没有字点一下都是停止，用户打了半天字一点按钮任务没了。
 */
function syncSendBtn() {
  const cli = cliBusy();
  const busy = curBusy(), draft = hasDraft();
  // 终端里那趟不给「停」：这个进程不归网页管，画一颗按下去没反应的停止键是骗人
  const stopMode = !cli && busy && !draft;
  sendBtn.classList.toggle("stop", stopMode);
  sendBtn.classList.toggle("interject", (busy || cli) && draft);
  sendBtn.innerHTML = ic(stopMode ? "square" : "arrow-up");
  sendBtn.title = stopMode ? "让我停下（Esc）"
    : cli ? "插一句给终端里的它（Enter）"
    : busy ? "插一句进去，我做完这一步就看（Enter）" : "发送（Enter）";
}
function updateSendUI() {
  syncSendBtn();
  syncPlaceholder();
  // ⚡ 插队按钮退役：发消息默认就是插队，按钮常隐（interject() 留给快捷键等旧入口）
  renderQueueBar();
  renderHistory(); // 侧栏「运行中」小圆点跟着刷新
}
function renderQueueBar() {
  const bar = document.getElementById("queue-bar");
  const q = (sessionId && sessionQueues.get(sessionId)) || [];
  if (!curBusy() && !q.length) { bar.classList.remove("show"); bar.innerHTML = ""; return; }
  bar.classList.add("show");
  // 说人话：讲清「现在怎么插话」「怎么停」「想并行怎么办」三件事，停止给一颗真按钮，别让用户去找 ◼ 在哪
  bar.innerHTML =
    q.map((m, i) => `<span class="q-chip" title="${esc(m.text)}"><span class="qt">${ic("hourglass")}${esc(m.text.slice(0, 30))}</span><span class="qx" data-i="${i}" title="取消这条">${ic("x", "i-sm")}</span></span>`).join("") +
    (curBusy() ? `<span class="qb-hint"><span>我正忙着这件事。想补一句或改方向？在下面打字、按 Enter，我做完这一步就看。</span><button type="button" class="qb-stop" title="停下当前任务（Esc）">${ic("square")}让我停下</button><span>想同时做别的，点左上「新建任务」。</span></span>` : "");
  bar.querySelectorAll(".qx").forEach(x => x.onclick = () => { q.splice(+x.dataset.i, 1); renderQueueBar(); });
  const stopBtn = bar.querySelector(".qb-stop");
  if (stopBtn) stopBtn.onclick = () => stopTask();
}
/** 发送键 / 回车 / 输入联动一起绑，方便前端测试整段切出来验 */
function bindComposer() {
  sendBtn.onclick = () => (!cliBusy() && curBusy() && !hasDraft() ? stopTask() : send());
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener("input", syncSendBtn);
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
    else toast("收到，做完这一步就看你这句");
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
  if (cliBusy()) { await interjectCli(text); return; } // 跟着终端那趟：话插到它的任务里，不在网页这边另起一趟
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
    sessions.unshift({ id: sessionId, title: shortTitle, at: Date.now(), project: activeProject, lane: activeLane });
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
  const KEEP = ["tool_use", "tool_result", "parallel", "expert_start", "expert_done", "error", "limit", "auto_continue", "failover", "sleep", "trim", "compact", "usage", "interject", "credits", "sources", "ask_user", "ask_answer", "milestones", "trace"];
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
  if (sid !== sessionId) toast(`「${name}」已完成${detail ? `（${detail}）` : ""}，点侧栏查看`, "circle-check");
  if (document.hidden) bumpDoneWhileAway(name);
  if (document.hidden && "Notification" in window) {
    try {
      if (Notification.permission === "granted") {
        const n = new Notification(name, { body: detail || "任务已完成" });
        n.onclick = () => { try { window.focus(); } catch {} document.querySelector(`.hist-item[data-id="${sid}"]`)?.click(); };
      } else if (Notification.permission === "default") Notification.requestPermission();
    } catch {}
  }
}

/**
 * 人不在这个标签页的时候跑完的活儿。
 *
 * 手机上桌面通知基本指望不上：iOS Safari 没有 Notification（除非加到主屏当 PWA），
 * 而且页面切到后台就被冻住，连 toast 都没人看。所以退一步，做一件在哪儿都成立的事——
 * 把数字记在标题栏上。人切回来（或者从锁屏瞥一眼标签页）就知道「不在的时候跑完了几个」，
 * 回到页面再补一句人话，然后把标题还原。零依赖、零权限、不用联网。
 */
let doneWhileAway = 0;
let titleBase = "";
function bumpDoneWhileAway(name) {
  doneWhileAway++;
  if (!titleBase) titleBase = document.title;
  document.title = `(${doneWhileAway}) ${titleBase}`;
  lastDoneName = name || lastDoneName;
}
let lastDoneName = "";
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !doneWhileAway) return;
  const n = doneWhileAway;
  doneWhileAway = 0;
  if (titleBase) { document.title = titleBase; titleBase = ""; }
  toast(n === 1 ? `你不在的时候，「${lastDoneName || "任务"}」跑完了` : `你不在的时候跑完了 ${n} 个任务`);
  lastDoneName = "";
});

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
      body: JSON.stringify({ sessionId: sid, message: text, mode, regen: !!regen, lane: laneOfSession(sessions.find(x => x.id === sid)), lang: typeof I18N !== "undefined" ? I18N.getLang() : "zh" }),
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
bindComposer();

// ================= 弹窗（技能/专家/定时/设置中心） =================
// 关弹窗前先把快捷键改绑的武装态撤了。document 上那个捕获 keydown 不撤掉的话，
// 弹窗关了它还在吞键：用户回聊天框打的第一个字符会消失，还会被静默绑成快捷键
const closeModal = () => { if (window.__scCancelRebind) window.__scCancelRebind(); mask.classList.remove("show"); };
document.getElementById("m-close").onclick = closeModal;
mask.addEventListener("click", (e) => { if (e.target === mask) closeModal(); });
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
    mTitle.textContent = "账号 · 用量";
    await renderAccount();
  } else if (kind === "settings") {
    mTitle.textContent = "设置";
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
  ["stop", "让我停下 / 关闭弹层", "Escape"],
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
// 仓库里的调用一律走第二个参数 toast(文字, "circle-x") 指定图标。
// 这张表是给外来调用兜底的：插件、技能里的老写法可能还在往消息前面塞 ❌ / ⚠️，
// 认出来就摘掉换成图标，免得表情漏到界面上。
const TOAST_ICON = { "❌": "circle-x", "⚠️": "triangle-alert", "⚠": "triangle-alert", "✅": "circle-check", "✓": "circle-check" };
function toast(msg, kind) {
  let t = document.getElementById("wb-toast");
  if (!t) { t = document.createElement("div"); t.id = "wb-toast"; document.body.appendChild(t); }
  let text = String(msg == null ? "" : msg);
  let icon = kind || "";
  for (const [mark, name] of Object.entries(TOAST_ICON)) {
    if (!text.startsWith(mark)) continue;
    icon = icon || name;
    text = text.slice(mark.length).trim();
    break;
  }
  t.innerHTML = (icon ? ic(icon) : "") + "<span></span>";
  t.lastChild.textContent = text;
  t.classList.toggle("err", icon === "circle-x" || icon === "triangle-alert");
  t.classList.add("show");
  clearTimeout(toastTimer);
  // 长消息（多半是报错原因）多留一会儿，2.2 秒读不完一句「分字段「*/0」的步长必须 ≥ 1」
  toastTimer = setTimeout(() => t.classList.remove("show"), Math.min(6000, Math.max(2200, text.length * 120)));
}
async function toggleAppFullscreen() {
  const r = await fetch("/api/app/fullscreen", { method: "POST" }).then(x => x.json()).catch(() => ({ ok: false }));
  if (!r.ok) { // Web 模式走浏览器全屏兜底
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
}
function navTask(dir) {
  const list = projectSessions();
  if (!list.length) return;
  let i = list.findIndex(s => s.id === sessionId);
  i = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + dir));
  if (list[i].id === sessionId) return;
  const el = document.querySelector(`.hist-item[data-id="${list[i].id}"]`);
  if (el) el.click();
}
const SHORTCUT_ACTIONS = {
  "open-settings": () => openModal("settings"),
  "voice-record": () => toast("语音录制暂未支持（复刻版）"),
  "chat-search": () => openChatSearch(),
  "new-chat": () => document.getElementById("new-task").click(),
  "stop": () => {
    if (figZoom) return closeFigZoom(); // 大图是压在最上面那层，Esc 先退它
    const cs = document.getElementById("chat-search");
    const onb = document.getElementById("onb-mask");
    // 新手引导是块全屏遮罩，它自己没有 ✕；Escape 得管得着，否则卡在里面只能重启
    if (onb && onb.classList.contains("show")) onb.classList.remove("show");
    else if (mask.classList.contains("show")) closeModal();
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
    bar.innerHTML = `<input id="cs-input" placeholder="搜索对话内容…"><span id="cs-count" style="color:var(--wb-text-3);font-size: 13px;white-space:nowrap"></span><button id="cs-prev" title="上一个">${ic("chevron-up")}</button><button id="cs-next" title="下一个">${ic("chevron-down")}</button><button id="cs-close" title="关闭 (Esc)">${ic("x")}</button>`;
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
let apCanAlways = true; // 「一直允许」写的是整台服务器的放行名单，只有平台管理员点得动
async function pollApprovals() {
  const d = await fetch("/api/security/approvals").then(r => (r.ok ? r.json() : null)).catch(() => null);
  const list = d && Array.isArray(d.items) ? d.items : [];
  if (d && d.mode) syncPermLabel(d.mode);
  if (d && "can_always" in d) apCanAlways = !!d.can_always;
  // 审批默认 120 秒超时按拒绝：窗口不在前台时必须把人喊回来，不然任务白等一场
  const fresh = list.filter(a => !apSeen.has(a.id));
  if (apSeen.size > 500) apSeen = new Set();
  list.forEach(a => apSeen.add(a.id));
  if (fresh.length && document.hidden && "Notification" in window && Notification.permission === "granted") {
    const a = fresh[0];
    try { new Notification("OpenWorkBuddy 等你审批", { body: `${a.source ? `「${a.source}」· ` : ""}${a.kind}：${(a.text || "").slice(0, 80)}` }); } catch {}
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
        <div class="ap-head">${ic("shield")}${esc(a.kind)}待审批${a.source ? ` · <span class="ap-src" title="发起审批的任务">来自「${esc(a.source)}」</span>` : ""}${a.rule ? ` · <span class="ap-why">${esc(a.rule)}</span>` : ""}</div>
        <code class="ap-cmd" title="${esc(a.text)}">${esc(a.text.slice(0, 160))}</code>
      </div>
      <div class="ap-btns">
        <button class="ap-ok" data-id="${esc(a.id)}" data-scope="once">本次允许</button>
        ${a.ruleKey ? `<button class="ap-ok2" data-id="${esc(a.id)}" data-scope="session" title="本次运行期间不再问「${esc(a.ruleKey)}」">本会话一直允许</button>` : ""}
        ${a.ruleKey && apCanAlways ? `<button class="ap-ok2" data-id="${esc(a.id)}" data-scope="always" title="把「${esc(a.ruleKey)}」写进放行名单，重启也生效">一直允许</button>` : ""}
        <button class="ap-no" data-id="${esc(a.id)}">拒绝</button>
      </div>
    </div>`).join("");
  bar.querySelectorAll("button").forEach(b => b.onclick = async () => {
    bar.querySelectorAll("button").forEach(x => (x.disabled = true));
    const allow = !b.classList.contains("ap-no");
    const resp = await fetch("/api/security/approvals/" + encodeURIComponent(b.dataset.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow, scope: b.dataset.scope || "once" }),
    }).catch(() => null);
    const r = resp ? await resp.json().catch(() => ({})) : {};
    // 点了没成必须说出来。原来这儿是 .catch(() => ({})) 一口吞掉，任务那头还挂着等回答，
    // 界面上什么都没变——用户只会再点一次，直到 120 秒超时按拒绝收场。
    if (!r.ok) {
      toast(r.error || "这条审批没批成，任务还等着——再点一次试试");
      pollApprovals();
      return;
    }
    if (allow && r.downgraded) toast(`已允许，本次运行期间不再问「${r.ruleKey}」。写进永久放行名单要平台管理员来做`);
    else if (allow && r.scope === "always" && r.ruleKey) toast(`已永久放行「${r.ruleKey}」（可在 设置 → 安全中心 的放行名单里删掉）`);
    else if (allow && r.scope === "session" && r.ruleKey) toast(`本次运行期间不再问「${r.ruleKey}」`);
    pollApprovals();
  });
}

// ================= 权限档位（参考 Claude Code：档位 + 记住的批准） =================
let permModes = null;
let permCanSwitch = true; // 多人服务器上的普通成员改不了档位，菜单画成只读的
function syncPermLabel(mode) {
  const el = document.getElementById("perm-label");
  if (!el || !permModes || !permModes[mode]) return;
  el.textContent = permModes[mode].label;
  document.querySelectorAll("#perm-menu .mi").forEach(x => x.classList.toggle("on", x.dataset.perm === mode));
}
async function loadPermModes() {
  const d = await fetch("/api/security/modes").then(r => r.json()).catch(() => null);
  if (!d || !d.modes) return; // 没登录时守卫回 401 {error}，没有 modes：首屏别为这个抛未捕获错误
  permModes = d.modes;
  permCanSwitch = d.can_switch !== false;
  const menu = document.getElementById("perm-menu");
  // 多人服务器上的普通成员：档位是整台机器一份，他改不动。那就别把菜单画成能点的——
  // 点了只弹一句「归平台管理员」，跟按钮坏了没区别。照样把当前档位显示出来（他得知道
  // agent 动手前会不会问他），只是把「可选」换成「这是当前状态 + 谁能改」。
  menu.innerHTML = Object.entries(d.modes)
    .map(([k, m]) => permCanSwitch
      ? `<div class="mi" data-perm="${esc(k)}">${esc(m.label)} <span class="sub">${esc(m.desc)}</span></div>`
      : `<div class="mi ro"${k === d.current ? ' data-cur="1"' : ""}>${esc(m.label)}${k === d.current ? ic("check") : ""} <span class="sub">${esc(m.desc)}</span></div>`)
    .join("");
  if (!permCanSwitch) menu.insertAdjacentHTML("beforeend",
    '<div class="mi ro sub-only">这台服务器上大家共用一个档位，归平台管理员设</div>');
  else menu.querySelectorAll(".mi").forEach(mi => mi.onclick = async () => {
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
  // 服务端把原因说清楚了（多人服务器上这块归平台管理员），别用四个字「切换失败」把它吃掉——
  // 用户看到的是一个明明能点的按钮点了没反应，只能去猜
  else toast(r.error || "切换失败：服务端没说原因");
}
setupPicker("perm-btn", "perm-menu");
loadPermModes();
// 审批只可能在任务运行中产生：跑任务时 3 秒一查，空闲时降到 15 秒
// （定时任务/IM 触发的后台任务也会要审批，所以空闲不能完全停）
(function approvalLoop() {
  pollApprovals().finally(() => setTimeout(approvalLoop, runningSessions.size ? 3000 : 15000));
})();


// ================= 头像编辑器（用户资料和助理设置共用一份） =================
// 第一格是内置猫标（跟应用图标同一只），后面是图标库里挑出来的那批——
// 跟专家卡、专家团用的是同一份 AVATAR_ICONS，换个地方选头像不用重新认一遍图
const AVATAR_PRESETS = [ASSISTANT_MARK].concat(AVATAR_ICONS);
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
/** 头像编辑器。参考常见做法（Notion / Slack 那类的头像弹层）：一排分类胶囊 + 等大方格 +
 *  预览即时跟着改。以前是把 60 个候选摊在一条 flex 里，图标、猫标、表情三种大小各不相同，
 *  挤在一个 116px 高的框里翻——用户原话是「待选的这些图片 svg 都很大」。 */
function avatarEditorHtml(p, av, fallback) {
  const a = avatarBits(av, fallback);
  const cur = String(av || "").trim();
  const cells = (list) => list.map((v) => avaCell(v, cur, v === ASSISTANT_MARK ? "内置猫标" : v)).join("");
  const t = avatarTab(cur);
  const sel = (k) => (t === k ? " active" : "");
  const hid = (k) => (t === k ? "" : " hidden");
  return `<div class="ava-ed">
    <span id="${p}-prev" class="ava-ed-prev${a.cls ? " " + a.cls : ""}">${a.html}</span>
    <div class="ava-ed-main">
      <div class="ava-tabs">
        <button type="button" class="chip ava-tab${sel("icon")}" data-t="icon">图标</button>
        <button type="button" class="chip ava-tab${sel("emo")}" data-t="emo">表情</button>
        <button type="button" class="chip ava-tab${sel("img")}" data-t="img">图片</button>
        <button type="button" class="ava-reset" id="${p}-clr">恢复默认</button>
      </div>
      <div class="ava-grid" data-t="icon"${hid("icon")}>${cells(AVATAR_PRESETS)}</div>
      <div data-t="emo"${hid("emo")}>
        <div class="ava-grid">${cells(AVATAR_EMOJI)}</div>
        <input id="${p}-emoji" class="ava-any" placeholder="上面挑一个，或者在这儿打字、粘贴任意表情" value="${a.cls === "emo" ? esc(av) : ""}">
      </div>
      <button type="button" class="ava-drop" id="${p}-up" data-t="img"${hid("img")}>
        ${ic("image", "ava-drop-ic")}
        <span class="ava-drop-t">把图片拖进来，或者点这儿挑一张</span>
        <span class="ava-tip">自动裁成方的，只存在本机配置里，不上传任何服务器</span>
      </button>
      <input type="file" id="${p}-file" accept="image/*" style="display:none">
    </div>
  </div>`;
}
/** 当前这个头像值该落在哪个分类下——打开时直接停在用户上次选的那一类，不用自己找。 */
function avatarTab(v) {
  const s = String(v || "").trim();
  if (s.startsWith("data:")) return "img";
  if (s && s !== ASSISTANT_MARK && !isIconName(s)) return "emo";
  return "icon";
}
/** 绑上事件，返回 { value() } 取当前选中的头像值（图标名 / emoji / data URI / 空=用默认）。
 *  defaultAv：点「恢复默认」该回到哪。助理传内置猫标，用户资料不传（空=首字母）。 */
function bindAvatarEditor(root, p, initial, fallback, defaultAv = "") {
  const q = (suffix) => root.querySelector("#" + p + "-" + suffix);
  const box = q("prev").closest(".ava-ed");
  const state = { av: String(initial || "") };
  const nameNow = () => (typeof fallback === "function" ? fallback() : fallback);
  // 选中态画在格子上，不只画在预览里：一屏 60 多个候选，光看预览认不出「我刚点的是哪个」
  const mark = () => box.querySelectorAll(".ava-pick").forEach((btn) => {
    const on = btn.dataset.e === state.av;
    btn.classList.toggle("on", on);
    if (on) btn.setAttribute("aria-pressed", "true");
    else btn.removeAttribute("aria-pressed");
  });
  const paint = () => { paintAvatar(q("prev"), state.av, nameNow()); mark(); };
  const showTab = (t) => {
    box.querySelectorAll(".ava-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.t === t));
    box.querySelectorAll(".ava-ed-main > [data-t]").forEach((d) => { d.hidden = d.dataset.t !== t; });
  };
  box.querySelector(".ava-tabs").onclick = (e) => {
    const tab = e.target.closest(".ava-tab");
    if (tab) showTab(tab.dataset.t);
  };
  box.addEventListener("click", (e) => {
    const pick = e.target.closest(".ava-pick");
    if (!pick) return;
    // 猫标和图标名都不是能打出来的字，别往输入框里塞 "@cat" / "rocket"——
    // 那行字用户看了会以为要自己打
    const picked = pick.dataset.e;
    q("emoji").value = picked === ASSISTANT_MARK || isIconName(picked) ? "" : picked;
    state.av = picked;
    paint();
  });
  q("emoji").oninput = () => {
    const v = q("emoji").value.trim();
    // 输入框空着又已经选了图/猫标：那是"选的东西还在，只是没打字"，别给清掉
    if (v || !(state.av.startsWith("data:") || state.av === ASSISTANT_MARK)) { state.av = v; paint(); }
  };
  // 挑图和拖图落到同一条路上：一张图从哪儿来的，后面的处理没有理由不一样
  const useFile = async (f) => {
    if (!f) return;
    if (!/^image\//.test(f.type || "")) { toast("这得是一张图片，" + (f.name || "这个文件") + "不是"); return; }
    try {
      state.av = await shrinkImage(f, 128);
      q("emoji").value = "";
      paint();
    } catch (e) { toast("图片用不了：" + e.message); }
  };
  q("up").onclick = () => q("file").click();
  // 虚线框画出来就是「能拖进来」的意思，那就真得接住。不接的更糟：浏览器的默认行为是
  // 拿这张图顶掉整个页面，用户一屏还没保存的设置跟着没了。
  const drop = q("up");
  const overState = (on) => (e) => { e.preventDefault(); drop.classList.toggle("over", on); };
  drop.ondragenter = overState(true);
  drop.ondragover = overState(true);
  drop.ondragleave = overState(false);
  drop.ondrop = async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const dt = e.dataTransfer;
    await useFile(dt && dt.files && dt.files[0]);
  };
  // 「恢复默认」得预览真正的默认值。助理的默认是猫标，之前一律清成空、预览画个首字母，
  // 保存后服务端又把空补回猫标（server.js: normalizeAvatar(...) || ASSISTANT_DEFAULT.avatar）——
  // 于是预览跟保存结果两个样。
  q("clr").onclick = () => { q("emoji").value = ""; state.av = defaultAv; paint(); showTab(avatarTab(defaultAv)); };
  q("file").onchange = async () => {
    const f = q("file").files && q("file").files[0];
    q("file").value = ""; // 允许连续选同一个文件
    await useFile(f);
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
  mTitle.textContent = "个人资料";
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
  mBody.querySelector("#pf-back").onclick = () => { mTitle.textContent = "账号 · 用量"; renderAccount(); };
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
      msg.textContent = "已保存";
    } else { msg.style.color = "var(--wb-err-text)"; msg.textContent = r.error || "保存失败"; }
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
      msg.textContent = `已改成 ${r.user.username}`;
      mBody.querySelector("#pf-upass").value = "";
      setTimeout(() => renderProfile(), 900); // 重画一遍，把"现在是 xxx"那句更新掉
    } else { msg.style.color = "var(--wb-err-text)"; msg.textContent = r.error || "改不动"; }
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
    + (creditsOn ? `<span class="uc">${ic("sparkles")}${(+currentUser.credits).toLocaleString()}</span>` : "");
  onActivate(chip, (e) => { e.stopPropagation(); toggleUserMenu(); });
}
document.getElementById("gear-btn").onclick = () => { closeUserMenu(); openModal("settings"); };

// ---------- 外观：主题 / 皮肤 / 字号 / 字体 / 密度（都存本机：「这台机器看着舒服」是设备的事，不跟账号走） ----------
// 存储被禁（file:// / 隐私模式 / data: 页面）时退到内存，别让整页脚本在第一行就崩
const lookMem = {};
function lookRead(k) { try { const v = localStorage.getItem(k); if (v != null) return v; } catch { /* 存储不可用 */ } return lookMem[k]; }
function lookWrite(k, v) { lookMem[k] = v; try { localStorage.setItem(k, v); } catch { /* 存储不可用 */ } }
const THEME_LABEL = { light: "浅色", dark: "深色", system: "跟随系统" };
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
function getTheme() { const t = lookRead("wb-theme"); return THEME_LABEL[t] ? t : "system"; }
function applyTheme() {
  const t = getTheme();
  document.documentElement.dataset.theme = t === "dark" || (t === "system" && themeMedia.matches) ? "dark" : "light";
}
themeMedia.addEventListener("change", applyTheme);
function setTheme(t) { if (!THEME_LABEL[t]) return; lookWrite("wb-theme", t); applyTheme(); }
applyTheme();
// 皮肤 = 只换品牌色那一组 token（主色/描边/弱底/品牌文字/渐变），版式不动；字号 = 正文 15px 的四档，其余尺寸按 calc 跟着走
const LOOK_OPTS = {
  skin: { default: "默认紫", ocean: "海盐", forest: "森林", sunset: "暖橙", rose: "玫瑰", graphite: "石墨" },
  fs: { s: "小", m: "标准", l: "大", xl: "特大" },
  font: { system: "系统", serif: "衬线", mono: "等宽" },
  density: { cozy: "舒适", compact: "紧凑" },
};
const LOOK_DEFAULT = { skin: "default", fs: "m", font: "system", density: "cozy" };
function lookGet(k) { const v = lookRead("wb-look-" + k); return LOOK_OPTS[k] && LOOK_OPTS[k][v] ? v : LOOK_DEFAULT[k]; }
function applyLook() {
  const ds = document.documentElement.dataset;
  for (const k of Object.keys(LOOK_OPTS)) {
    const v = lookGet(k);
    if (v === LOOK_DEFAULT[k]) delete ds[k]; else ds[k] = v;
  }
}
function setLook(k, v) { if (!LOOK_OPTS[k] || !LOOK_OPTS[k][v]) return; lookWrite("wb-look-" + k, v); applyLook(); }
applyLook();

// ---------- 头像菜单：设置 / 外观 / 帮助与反馈 / 检查更新 / 退出登录 ----------
const userMenu = document.getElementById("user-menu");
function closeUserMenu() { userMenu.classList.remove("show"); }
function toggleUserMenu() { userMenu.classList.contains("show") ? closeUserMenu() : openUserMenu(); }
function openUserMenu() {
  if (!currentUser) return;
  const av = avatarBits(currentUser.avatar, currentUser.username);
  const i18n = typeof I18N !== "undefined" ? I18N : null; // 测试夹具里可能没挂词典
  const lang = i18n ? i18n.getLang() : "zh";
  userMenu.innerHTML = `
    <div class="um-head" data-act="account" title="点击查看用量明细">
      <span class="ava${av.cls ? " " + av.cls : ""}" style="width:30px;height:30px;border-radius:50%;background:var(--wb-brand-grad);color:#fff;display:flex;align-items:center;justify-content:center;font-size: 15px;font-weight:600;flex:none;overflow:hidden">${av.html}</span>
      <div style="min-width:0"><div class="n">${esc(displayName(currentUser))}${currentUser.role === "admin" ? " · 管理员" : ""}</div>
      <div class="s">${creditsOn ? `${ic("sparkles")}${(+currentUser.credits).toLocaleString()} 积分 · ` : ""}账号与用量</div></div>
    </div>
    <div class="um-i" data-act="profile">${ic("id-card")}个人资料</div>
    <div class="um-i" data-act="settings">${ic("settings")}设置</div>
    ${currentUser.role === "admin" || currentUser.role === "auditor"
      ? `<div class="um-i" data-act="admin">${ic("building-2")}企业管理后台 <span class="hint">${currentUser.role === "auditor" ? "只读" : "成员 · 用量 · 安全"}</span></div>`
      : ""}
    ${i18n ? `<div class="um-i um-lang" data-act="lang" title="点一下就切换界面语言，AI 回复也跟着换"><span>${ic("globe")}语言</span><span class="um-seg" data-i18n-skip role="group" aria-label="界面语言">${Object.keys(i18n.LANGS).map((v) =>
      `<button type="button" data-lang="${v}" class="${lang === v ? "on" : ""}" aria-pressed="${lang === v}">${v === "zh" ? "中" : "En"}</button>`).join("")}</span></div>` : ""}
    <div class="um-i" data-act="appearance">${ic("palette")}外观 <span class="hint">${THEME_LABEL[getTheme()]} · ${LOOK_OPTS.fs[lookGet("fs")]}字</span></div>
    <div class="um-i" data-act="help">${ic("message-circle")}帮助与反馈</div>
    <div class="um-i" data-act="update">${ic("refresh-cw")}检查更新</div>
    <div class="um-i" data-act="logout" style="color:var(--wb-err-text)">${ic("log-out")}退出登录</div>`;
  userMenu.querySelectorAll("[data-act]").forEach(el => el.onclick = async (e) => {
    e.stopPropagation();
    const act = el.dataset.act;
    if (act === "lang") {
      // 语言行不关菜单：点「中 / En」按钮选定，点行的其它地方就在两者间翻；切完原地重画，菜单文字立刻跟着变
      if (!i18n) return;
      const b = e.target.closest("button[data-lang]");
      const next = b ? b.dataset.lang : (i18n.getLang() === "zh" ? "en" : "zh");
      if (next !== i18n.getLang()) i18n.setLang(next);
      openUserMenu();
      return;
    }
    closeUserMenu();
    if (act === "account") openModal("account");
    else if (act === "appearance") openModal("settings", "look");
    else if (act === "profile") { await openModal("account"); renderProfile(); }
    else if (act === "settings") openModal("settings");
    // 后台是独立一页，不是弹窗：它自己有一整套侧边导航，塞进设置弹窗里两层导航会打架
    else if (act === "admin") location.href = "/admin.html";
    else if (act === "help") openModal("settings", "about");
    else if (act === "update") checkUpdate();
    else if (act === "logout") { await fetch("/api/auth/logout", { method: "POST" }); location.reload(); }
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
  const done = () => { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制"; }, 1500); };
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

// 内联 SVG 图表的动作（事件委托，历史回放与流式渲染共用）。
// 图本身也挂着 data-a="svg-zoom"：在对话列里图被压成窄窄一条，坐标轴和小字根本看不清，
// 总不能让人把窗口拉宽再拉回来。
document.addEventListener("click", async (e) => {
  const hit = e.target.closest(".svg-fig [data-a]");
  if (!hit) return;
  const fig = hit.closest(".svg-fig");
  const raw = fig.dataset.src || "";
  const act = hit.dataset.a;
  // 点的是图本身时没有按钮可以回显「已存 ✓」，借动作条上那颗顶一下
  const btn = hit.tagName === "BUTTON" ? hit : fig.querySelector(".svg-acts button");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  if (act === "svg-zoom") return openFigZoom(fig);
  if (act === "svg-code") {
    const box = fig.querySelector(".svg-raw");
    if (box) { box.remove(); hit.textContent = "看源码"; return; }
    const pre = document.createElement("pre");
    pre.className = "svg-raw";
    pre.textContent = raw;
    fig.insertBefore(pre, fig.querySelector(".svg-acts"));
    hit.textContent = "收起源码";
    return;
  }
  if (act === "svg-save") return saveInlineFile(`图表-${stamp}.svg`, fig.querySelector("svg").outerHTML, btn);
  if (act === "svg-as" || act === "svg-png") {
    hit.disabled = true;
    try {
      if (act === "svg-as") await saveInlineFile(`图表-${stamp}.svg`, fig.querySelector("svg").outerHTML, btn, true);
      else await saveInlineFile(`图表-${stamp}.png`, await SvgFig.svgToPngDataUrl(fig.querySelector("svg")), btn);
    } catch (err) { toast((act === "svg-as" ? "另存为失败：" : "转图片失败：") + err.message); }
    finally { hit.disabled = false; }
  }
});
/** 按钮上闪一下回执再变回去；别拿 toast 当唯一反馈，手指还停在按钮上呢 */
function flashBtn(btn, word) {
  if (!btn) return;
  const old = btn.dataset.oldText || btn.textContent;
  btn.dataset.oldText = old;
  btn.textContent = word;
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => { btn.textContent = btn.dataset.oldText || old; delete btn.dataset.oldText; }, 1600);
}
/**
 * POST 一份 JSON，并且**说清楚失败在哪一环**。
 *
 * 以前这一串是 `fetch(...).then(x => x.json()).catch(() => null)`，一个 catch 把四种
 * 完全不同的事故糊成同一句「接口无响应」：网线断了、后端崩了没回 JSON、HTTP 报了
 * 401/413/500、请求挂着一直不回。用户看到的永远是那五个字，连往哪儿查都不知道
 * （这条是用户报的：「怎么说保存失败接口没有响应啊」）。
 *
 * 返回 { data, why }：data 是解析出来的响应体（失败时为 null），why 是给人看的一句原因。
 */
async function postJson(url, body, timeoutMs) {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const ms = timeoutMs || 30000;
  const timer = ac ? setTimeout(() => ac.abort(), ms) : null;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ac ? ac.signal : undefined,
    });
  } catch (e) {
    // abort 和真的连不上要分开说：一个是「它没回」，一个是「压根没连上」
    const aborted = e && (e.name === "AbortError" || ac?.signal.aborted);
    return { data: null, why: aborted ? `等了 ${Math.round(ms / 1000)} 秒还没回应，后台可能卡住了` : "连不上本机服务（OpenWorkBuddy 后台是不是退出了？）" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const raw = await resp.text().catch(() => "");
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  if (data && typeof data === "object") {
    // 服务端自己说了原因就用它的，别拿 HTTP 码盖掉一句人话
    if (!resp.ok && !data.error) data.error = `HTTP ${resp.status}`;
    return { data, why: data.error || "" };
  }
  const head = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  return { data: null, why: `HTTP ${resp.status}${head ? "，后台回的不是 JSON：" + head : "，后台回了个空响应"}` };
}
/** 网页端没有系统保存框，交给浏览器下载——在网页上，浏览器的下载面板就是那个「选位置」 */
function browserDownload(name, content) {
  const isData = /^data:/.test(String(content));
  const url = isData ? content : URL.createObjectURL(new Blob([content], { type: "image/svg+xml;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  if (!isData) setTimeout(() => URL.revokeObjectURL(url), 4000);
}
/**
 * 把对话里生成的东西落盘。
 * 默认落到**这次对话自己的成果文件夹**（sessionDirs 里那个 任务_0911_xxx），不再一股脑丢进工作区根目录——
 * 用户原话：「默认存的位置都不是这个对话对应的文件夹下」。
 * saveAs=true 走系统保存框，自己挑地方；网页端没这能力就退回浏览器下载。
 */
async function saveInlineFile(name, content, btn, saveAs) {
  const dir = sessionDirs.get(sessionId) || "";
  const { data: r, why } = await postJson(saveAs ? "/api/files/save-as" : "/api/files/save", { name, content, dir }, 120000);
  if (saveAs && r && r.canceled) return; // 用户自己点的取消，别再弹一条「失败」吓人
  if (saveAs && r && r.no_dialog) {
    browserDownload(name, content);
    flashBtn(btn, "已下载");
    return toast("网页端没有系统保存框，已交给浏览器下载；想换地方去浏览器的下载设置里改");
  }
  if (!r?.ok) return toast("保存失败：" + (r?.error || why || "没说原因"), "circle-x");
  if (r.files) renderFiles(r.files);
  flashBtn(btn, "已存");
  if (saveAs) return toast(`已存到：${r.path}`);
  toast(r.dir ? `已存到本对话的文件夹：${r.dir}/${name}` : `已存到工作目录：${name}`);
}

// ---- 图表看大图 ----
// 铺满屏、滚轮缩放、按住拖动、Esc 退出。只有一层，再点一张先把上一张收掉。
let figZoom = null;
function closeFigZoom() {
  if (!figZoom) return;
  figZoom.remove();
  figZoom = null;
}
function openFigZoom(fig) {
  const raw = fig.dataset.src || "";
  // 重新消毒一遍拿到的是**新的**图 id：直接 clone 会在页面里留一对重复 id，
  // 而 <style> 是按 id 限定作用域的，两张图的样式会开始互相串
  const html = (window.SvgFig && (SvgFig.sanitizeSvg(raw) || SvgFig.sanitizeSvg(SvgFig.repairPartialSvg(raw)))) || "";
  const srcEl = fig.querySelector("svg");
  if (!html && !srcEl) return;
  closeFigZoom();
  const ov = document.createElement("div");
  ov.className = "fig-zoom";
  ov.innerHTML =
    '<div class="fz-bar"><span class="fz-tip">滚轮缩放 · 按住拖动 · Esc 退出</span>' +
    '<button data-z="out" title="缩小">−</button><span class="fz-pct">100%</span>' +
    '<button data-z="in" title="放大">+</button>' +
    '<button data-z="fit">铺满看</button><button data-z="close">关掉</button></div>' +
    '<div class="fz-stage"><div class="fz-inner"></div></div>';
  const inner = ov.querySelector(".fz-inner");
  inner.innerHTML = html || srcEl.outerHTML;
  const svg = inner.querySelector("svg");
  if (svg) { svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%"); svg.style.display = "block"; }
  document.body.appendChild(ov);
  figZoom = ov;

  const vb = String((svg && svg.getAttribute("viewBox")) || "").trim().split(/[\s,]+/).map(Number);
  const ratio = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[2] / vb[3] : 16 / 9;
  let k = 1, tx = 0, ty = 0;
  const pct = ov.querySelector(".fz-pct");
  const apply = () => {
    inner.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    pct.textContent = Math.round(k * 100) + "%";
  };
  const fit = () => {
    const st = ov.querySelector(".fz-stage").getBoundingClientRect();
    const w = Math.max(120, Math.min(st.width * 0.96, st.height * 0.96 * ratio));
    inner.style.width = w + "px";
    inner.style.height = w / ratio + "px";
    k = 1; tx = 0; ty = 0;
    apply();
  };
  fit();
  const zoomTo = (next) => { k = Math.max(0.25, Math.min(8, next)); apply(); };
  ov.addEventListener("click", (e) => {
    const b = e.target.closest("[data-z]");
    if (!b) { if (e.target === ov || e.target.classList.contains("fz-stage")) closeFigZoom(); return; }
    const z = b.dataset.z;
    if (z === "close") return closeFigZoom();
    if (z === "fit") return fit();
    zoomTo(z === "in" ? k * 1.25 : k / 1.25);
  });
  ov.querySelector(".fz-stage").addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomTo(k * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });
  let drag = null;
  ov.querySelector(".fz-stage").addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-z]")) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    ov.querySelector(".fz-stage").setPointerCapture(e.pointerId);
    ov.classList.add("dragging");
  });
  ov.addEventListener("pointermove", (e) => { if (drag) { tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); } });
  ov.addEventListener("pointerup", () => { drag = null; ov.classList.remove("dragging"); });
}

async function checkUpdate() {
  toast("正在检查更新…");
  const r = await fetch("/api/app/update-check", { method: "POST" }).then(x => x.json()).catch(() => null);
  if (!r) return toast("检查更新失败：接口无响应");
  if (!r.ok) return toast(`当前版本 v${r.version || "?"} · ${r.reason}`);
  toast(r.behind > 0 ? `发现新版本：本地落后 ${r.behind} 个提交，在项目目录执行 git pull 后重启即可` : `已是最新版本（v${r.version}）`);
}
const SRC_TXT = { web: "网页", cli: "CLI", im: "IM", schedule: "定时" };
