/**
 * 这条模型现在点下去能不能真跑起来。
 * 本机服务（Ollama 之类）不要 Key，填不填都算能用；其余看 has_key——
 * 多人服务器上普通成员拿到的 api_key 是一串星号，只有这个布尔是真的。
 */
function modelReady(m) {
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(m.base_url || ""))) return true;
  return m.has_key !== undefined ? !!m.has_key : !!String(m.api_key || "").trim();
}

// menu 不传就是输入框右下角那个；助理页顶栏那个把自己的容器传进来，两处共用同一份菜单
function renderModelMenu(menu = modelMenu) {
  if (!settingsCache || !menu) return;
  // 本机 CLI 在跑：这一整排 API 模型都是摆设，别再让用户点了以为生效。
  // 只在输入框那个选择器上换（menu === modelMenu）；助理页顶栏那个走的还是 API，不受影响
  const eng = menu === modelMenu ? activeEngine() : null;
  if (eng) {
    // 这里不是一排可选项，是一张「现在谁在跑」的卡：谁在跑、花不花钱、去哪儿改，三行完事。
    // 中间原来还有一段解释（「用你电脑上这个 CLI 的登录态和它自己的模型跑，所以下面那排
    // API 模型这会儿一个都用不上」）——绿牌子「不花 API 额度」已经把这件事说完了，那段是
    // 把它又用长句重说一遍。别再加回来。
    // 能点的只有最后那一行，所以只有它长得像按钮。
    menu.classList.add("eng");
    menu.innerHTML = `<div class="ep-head"><span class="ep-ic">${ic("monitor")}</span>
        <span class="ep-name">${esc(eng.label)}<span class="ep-model">${esc(eng.model || "用它自己的默认模型")}</span></span>
        <span class="ep-on">${ic("check")}</span></div>
      <div class="ep-tag"><b class="ep-free">不花 API 额度</b></div>
      <div class="mi ep-act" data-act="engine">${ic("settings")}改它的模型 / 换回内置引擎…</div>`;
    menu.querySelectorAll(".mi[data-act]").forEach((mi) => (mi.onclick = () => { menu.classList.remove("show"); openModal("settings", "agent"); }));
    return;
  }
  menu.classList.remove("eng");
  const ov = currentSessModel();
  const hbDef = healthBadge(settingsCache.active_model);
  // 出厂 config 里预置着十来条厂商模板，一把 Key 都没有；混在这张菜单里，点下去必然 401——
  // 那不是可选项，是待办事项。所以没 Key 的不进列表，只在末尾留一行说清还剩几条、去哪儿填
  // （跟设置页那栏「还没填 Key 的渠道」同一个口径：不是删掉，是收起来）。
  const usable = settingsCache.models.filter(modelReady);
  const waiting = settingsCache.models.length - usable.length;
  menu.innerHTML = `<div class="mi ${ov ? "" : "on"}" data-act="default" style="justify-content:space-between">
      <span>${ic("rotate-ccw")}跟随全局默认 <span class="sub">${esc(settingsCache.active_model)}${hbDef ? " · " + hbDef : ""}</span></span>${ov ? "" : `<span style="color:var(--owb-ok-text)">${ic("check")}</span>`}</div>`
    + usable.map(m => {
      const on = m.name === ov;
      const hb = healthBadge(m.name);
      return `<div class="mi ${on ? "on" : ""}" data-name="${esc(m.name)}" style="justify-content:space-between">
      <span>${ic("sparkles")}${esc(m.name)} <span class="sub">${esc(m.model)}${hb ? " · " + hb : ""}</span></span>
      ${on ? `<span style="color:var(--owb-ok-text)">${ic("check")}</span>` : ""}</div>`;
    }).join("")
    + (!usable.length ? `<div class="mi-note">${ic("triangle-alert")}一个填了 Key 的模型都还没有，先去下面加一个</div>`
      : waiting ? `<div class="mi-note">还有 ${waiting} 个模型没填 Key，填上才会出现在这里</div>` : "")
    + `<div class="mi" data-act="manage" style="border-top:1px solid var(--owb-border);margin-top:4px">${ic("settings")}管理模型…</div>`;
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
  const workspacePath = String(settingsCache.workspace_dir || "");
  wsMenu.innerHTML =
    // 长路径不该把弹层撑出屏幕：视觉上省略，title 仍保留完整路径给核对/复制。
    `<div class="mi ro ws-current" data-cur="1" title="${esc(workspacePath)}">${ic("folder")}<span class="mi-truncate">${esc(workspacePath)}</span></div>` +
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
        // 同样不能用 window.prompt（桌面版里一调用就抛，见 app-01.js 的 askText）。
        // 这条路本来就是「系统选择框弹不出来」的退路，退路自己再哑一次就没得退了
        const p = await askText({
          title: "工作空间文件夹",
          hint: "这台机器弹不出系统的选择框，手填一个完整路径吧。",
          placeholder: "/home/你的用户名/工作空间",
          value: settingsCache.workspace_dir,
          ok: "就用这个",
        });
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
// 模式表从 /api/modes 取，不在前端存第二份。
// 以前这儿是 `const MODE_LABEL = { craft:…, goal:…, plan:…, ask:… }`，index.html 里还有一份四行的
// HTML，命令行里又有一份 `["craft","plan","ask"]`——三份手抄，goal 只抄进了两份。
// 用户在网页上用了半年的 Goal 模式，到终端里 `openworkbuddy --mode goal` 说没有这个模式。
// 现在四个模式只写在 modes.js 里一次，这三处都是它的读者。
let execModes = [];   // [{id,label,sub,icon}]，/api/modes 回来的原样
// Plan 跑完那两颗按钮（开干 / 接着改）的字和发出去的那句，也是 /api/modes 带回来的（modes.js PLAN_HANDOFF）。
// 没取到就是 null：计划卡照画步骤、不画按钮——不在这儿留一份兜底文案，理由同上
let planHandoff = null;
function modeInfo(mode) { return execModes.find(m => m.id === mode) || null; }
function setMode(mode) {
  currentMode = mode;
  const info = modeInfo(mode);
  const label = document.getElementById("mode-label");
  // 表还没回来时别把标签擦成空白：留着 index.html 里那句初始文案，等 loadExecModes 补上
  if (info && label) label.textContent = info.label;
  const mbi = document.querySelector("#mode-btn .i"); // 按钮上的图标跟着模式换，别一直停在 Craft 那个
  if (mbi) mbi.outerHTML = ic((info && info.icon) || "circle-check");
  modeMenu.querySelectorAll(".mi").forEach(x => x.classList.toggle("on", x.dataset.mode === mode));
  syncPlaceholder();
}
async function loadExecModes() {
  const d = await fetch("/api/modes").then(r => r.json()).catch(() => null);
  // 取不回来就把菜单画成一句人话。以前这里是四行写死的 HTML，取不回来也能点；
  // 但那正是漂移的来源。宁可在服务端挂掉时少一个下拉，也不要再养一份会骗人的副本。
  if (!d || !Array.isArray(d.modes) || !d.modes.length) {
    modeMenu.innerHTML = '<div class="mi ro sub-only">模式表没取到（服务端没响应），当前按默认模式跑</div>';
    return;
  }
  execModes = d.modes;
  planHandoff = d.plan && typeof d.plan.go === "string" ? d.plan : null;
  modeMenu.innerHTML = execModes.map(m =>
    `<div class="mi" data-mode="${esc(m.id)}">${ic(m.icon)} ${esc(m.label)} <span class="sub">${esc(m.sub)}</span></div>`).join("");
  modeMenu.querySelectorAll(".mi").forEach(mi => mi.onclick = () => {
    setMode(mi.dataset.mode);
    modeMenu.classList.remove("show");
  });
  setMode(currentMode && modeInfo(currentMode) ? currentMode : d.default || "craft");
}
loadExecModes();

// ================= ＋ 上传文件到工作空间（选择/拖拽共用） =================
const attachChips = document.getElementById("attach-chips");
/**
 * 一条待发素材 = 输入框上面一枚看得见的 chip，外加发出去时补在正文最前面的一行「素材锚点」。
 *
 * 锚点（`【图片 1：xxx.png】`）解决的是「第一张是人物，第二张是背景」这句话指谁——所有附件
 * 挤成一行文件名的话，模型只能猜。但锚点**不再往输入框里塞**：GPT、Claude、飞书的输入框里
 * 只有人自己写的话，附件是上面一排缩略图。以前拖三张图进来，框里先多出三行看不懂的中括号，
 * 人还得绕开它们打字，删一半就成了半截锚点。现在框里干干净净，锚点在按下发送的那一刻
 * 按 chip 的顺序补齐（见 composeOutgoing）；人要是自己在正文里摆过一枚，就以他摆的位置为准。
 */
const pendingAttach = [];
const ATTACH_KIND = {
  image: { label: "图片", icon: "image" },
  video: { label: "视频", icon: "film" },
  audio: { label: "音频", icon: "volume-2" },
  text: { label: "文本摘录", icon: "file-text" },
  file: { label: "文件", icon: "paperclip" },
};
// 服务端 express.json 的上限是 60MB，base64 会把体积撑到 4/3，所以这边卡 30MB 正好够它接住。
const MAX_UPLOAD = 30 * 1048576;
function attachKind(name, mime, forced) {
  if (forced && ATTACH_KIND[forced]) return forced;
  const type = String(mime || "").toLowerCase();
  const n = String(name || "").toLowerCase();
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i.test(n)) return "image";
  if (type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(n)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(n)) return "audio";
  return "file";
}
function markerName(name) { return String(name || "文件").replace(/[\r\n【】]/g, " ").trim() || "文件"; }
/** 人看的体积。chip 上只有一个文件名的时候，1KB 的草稿和 25MB 的片子长得一模一样 */
function humanSize(n) {
  if (!(n > 0)) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
}
function attachmentOrder(typed) {
  // 用户可以拖动/剪切标记；发出时按当前输入里出现的位置排，而不是按网络上传完成的先后排。
  // 只算真的躺在工作目录里的那些：传失败的不能进清单，否则等于告诉模型「这个文件有」。
  return pendingAttach.filter(x => x.state === "done").sort((a, b) => {
    const ia = typed.indexOf(a.marker), ib = typed.indexOf(b.marker);
    const aa = ia < 0 ? Number.MAX_SAFE_INTEGER : ia;
    const bb = ib < 0 ? Number.MAX_SAFE_INTEGER : ib;
    return aa - bb || a.order - b.order;
  });
}
function removeAttachmentMarker(marker) {
  const at = inputEl.value.indexOf(marker);
  if (at < 0) return;
  let end = at + marker.length;
  // 上传时在标记后补了一个换行；只吃这一个，不碰用户在标记前后写的描述。
  if (inputEl.value[end] === "\n") end++;
  inputEl.value = inputEl.value.slice(0, at) + inputEl.value.slice(end);
  inputEl.selectionStart = inputEl.selectionEnd = at;
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
}
/**
 * 这一类素材下一个没被占用的编号。
 *
 * 不能写成 `filter(同类).length + 1`：加「图片 1」「图片 2」，删掉图片 1，再加一张——
 * 长度又是 1，新的还叫「图片 2」。界面上并排两个「图片 2」，发给模型的也是两个
 * `【图片 2：…】`，用户说「第二张」指谁全靠猜。这是实测出来的，test/frontend.js 里钉着。
 */
function nextAttachIndex(kind) {
  return pendingAttach.reduce((m, x) => (x.kind === kind && x.index > m ? x.index : m), 0) + 1;
}
function makeAttachItem(name, { mime, kind, size } = {}) {
  const type = attachKind(name, mime, kind);
  const index = nextAttachIndex(type);
  return {
    name, kind: type, index,
    size: size || 0,
    order: pendingAttach.length,
    state: "uploading",
    marker: `【${ATTACH_KIND[type].label} ${index}：${markerName(name)}】`,
  };
}
const ATTACH_TIP = {
  uploading: "正在放进工作目录…",
  done: "点一下打开看看",
  failed: "没传上去。点 ↺ 再传一次",
};
/** chip 左边那一格：有缩略图就显缩略图，没有就显类型图标，状态（转圈/出错）盖在它上面 */
function renderAttachIcon(item) {
  const slot = item.el && item.el.querySelector(".attach-ic");
  if (!slot) return;
  slot.innerHTML = item.thumb ? "" : ic(ATTACH_KIND[item.kind].icon);
  if (item.thumb) {
    const img = document.createElement("img");
    img.className = "attach-thumb";
    img.src = item.thumb;
    img.alt = "";
    slot.appendChild(img);
  }
  const st = document.createElement("span");
  st.className = "attach-state";
  st.innerHTML = item.state === "uploading" ? '<span class="spinner"></span>'
    : item.state === "failed" ? ic("circle-alert", "i-sm") : "";
  slot.appendChild(st);
}
function setAttachState(item, state, note) {
  item.state = state;
  const chip = item.el;
  if (!chip) return;
  chip.classList.toggle("is-uploading", state === "uploading");
  chip.classList.toggle("is-failed", state === "failed");
  const open = chip.querySelector(".attach-open");
  open.disabled = state !== "done"; // 还没落盘 / 没落成，点开只会看到 404
  open.title = ATTACH_TIP[state] || "";
  chip.querySelector(".attach-size").textContent = state === "failed" ? (note || "没传上去") : humanSize(item.size);
  let retry = chip.querySelector(".attach-retry");
  if (state === "failed" && !retry) {
    retry = document.createElement("button");
    retry.type = "button";
    retry.className = "attach-retry";
    retry.innerHTML = ic("rotate-ccw", "i-sm");
    retry.title = "再传一次";
    retry.setAttribute("aria-label", `重新上传 ${item.name}`);
    retry.onclick = () => sendAttach(item);
    chip.insertBefore(retry, chip.querySelector(".attach-x"));
  } else if (state !== "failed" && retry) retry.remove();
  chip.title = [item.marker, item.hint, ATTACH_TIP[state]].filter(Boolean).join("\n");
  renderAttachIcon(item);
}
function setAttachThumb(item, url) {
  if (!url) return;
  item.thumb = url;
  renderAttachIcon(item);
}
/** 点 chip 打开预览。上传时服务端把它放进本对话的成果文件夹，那个相对路径跟着响应回来 */
function openAttach(item) {
  if (item.state !== "done") return;
  if (typeof previewFile === "function") previewFile(item.path || item.name, "");
  else toast(`这份在工作目录里：${item.path || item.name}`, "folder");
}
function removeAttach(item) {
  const i = pendingAttach.indexOf(item);
  if (i >= 0) pendingAttach.splice(i, 1);
  removeAttachmentMarker(item.marker);
  if (item.el) item.el.remove();
  item.blob = null;
  syncSendBtn();
}
/** 同一个文件又拖了一次：闪一下已有的那枚，让人看见「它已经在这儿了」，而不是干瞪眼 */
function flashAttach(item) {
  if (!item.el) return;
  item.el.classList.remove("attach-flash");
  void item.el.offsetWidth; // 强制重排，不然连拖两次第二下不会再闪
  item.el.classList.add("attach-flash");
  setTimeout(() => item.el && item.el.classList.remove("attach-flash"), 700);
}
/**
 * 建一枚素材 chip 并挂进输入框上方。
 *
 * 外层 span 只管排版，里面是两颗真按钮：点名字开预览，点 × 移除。以前是一个 `<b>` 挂 onclick——
 * 鼠标能点，键盘 Tab 过去空无一物，读屏也念不出这是个能按的东西。
 */
function addAttachChip(item, hint) {
  pendingAttach.push(item);
  syncSendBtn(); // 运行中光贴了个附件也算「有话要说」，按钮得从「停下」变回「发出」
  const chip = document.createElement("span");
  // 图片走缩略图方片，别的走长条 chip——GPT、Claude 都是这么分的，理由也很直白：
  // 一排文件名里没人认得出哪张是哪张（手机相册导出来全是 IMG_4821 这种名字），缩略图一眼就认出来；
  // 而一份 .xlsx 的缩略图是一张白纸，它的身份是名字和体积
  const tile = item.kind === "image";
  chip.className = `attach-chip attach-${item.kind}${tile ? " is-tile" : ""}`;
  chip.dataset.marker = item.marker;

  const open = document.createElement("button");
  open.type = "button";
  open.className = "attach-open";
  const slot = document.createElement("span");
  slot.className = "attach-ic";
  const ref = document.createElement("em");
  ref.textContent = `${ATTACH_KIND[item.kind].label} ${item.index}`;
  const name = document.createElement("span");
  name.className = "attach-name";
  name.textContent = item.name;
  const size = document.createElement("span");
  size.className = "attach-size";
  open.append(slot, ref, name, size);
  // 方片上文件名是藏起来的（悬停看 title），读屏得有个说法，不然念出来只有「图片 1」
  open.setAttribute("aria-label", `打开 ${item.name}`);
  open.onclick = () => openAttach(item);
  chip.appendChild(open);

  const x = document.createElement("button");
  x.type = "button";
  x.className = "attach-x";
  x.innerHTML = ic("x", "i-sm");
  x.setAttribute("aria-label", `把 ${item.name} 从这条消息移除`);
  x.title = "从这条消息移除（文件仍在工作目录里）";
  x.onclick = () => removeAttach(item);
  chip.appendChild(x);

  item.el = chip;
  item.hint = hint || "";
  attachChips.appendChild(chip);
  setAttachState(item, "uploading");
  return chip;
}
/**
 * 一份内容转 base64。
 *
 * 交给浏览器做，不自己在主线程上拼字符串：30MB 的片子，手写那版 `String.fromCharCode` 循环
 * 要 116ms，而且这 116ms 里主线程一次都不让出去——转圈图标是停着的，点什么都没反应。
 * FileReader 同样一份只要 35ms 且不占主线程，产物一个字节不差（实测对比过）。
 */
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).slice(String(fr.result).indexOf(",") + 1));
    fr.onerror = () => reject(fr.error || new Error("读不出这个文件"));
    fr.readAsDataURL(blob);
  });
}
/**
 * 缩略图。28×28 那一格不需要原图。
 *
 * 以前是把整份文件的 base64 直接当 img.src：实测 300KB 的图片挂上去是 409,622 个字符的
 * data URL，浏览器还要按原分辨率解一遍码再缩到 28 像素。贴几张手机照片就是几百兆内存。
 */
async function thumbDataUrl(blob, px = 96) {
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, px / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return cv.toDataURL("image/png");
  } catch (e) {
    return ""; // 认不出的图（坏文件、某些 SVG）就退回类型图标，不是错误
  }
}
/**
 * 这条对话的 id，没有就现取一个。
 *
 * 为什么不能拖到「按下发送」那一刻才取：附件是**先传后发**的。上传接口拿这个 id 去认领本对话的
 * 成果文件夹——id 是 null 的话，服务端既没处放，也记不上「待搬进去」那笔账（server.js /api/upload）。
 * 于是新开一条对话拖张图进来，图就永远躺在任务目录的**上一级**：agent 在自己的工作目录里翻不到，
 * 只好 find 一圈再 cp 一份进来。那份 cp 出来的副本是这一轮新写的文件，
 * 于是用户传进去的**输入**图，转头出现在「本回合产出」里。
 */
function ensureSessionId() {
  if (!sessionId) sessionId = "s_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
  return sessionId;
}
/** 把 chip 对应的内容真的送上去。重试走的也是这条 */
async function sendAttach(item) {
  if (!item.blob) return false;
  setAttachState(item, "uploading");
  try {
    const b64 = await blobToB64(item.blob);
    const resp = await fetch("/api/upload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      // 带上会话 id：服务端好把文件直接放进本对话的成果文件夹，别再堆到工作空间根目录。
      // ensureSessionId 而不是裸 sessionId——新开一条对话时它还是 null，那就等于没带（见上面那段注释）
      body: JSON.stringify({ name: item.name, data_b64: b64, session: ensureSessionId() }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json().catch(() => ({}));
    item.path = data.path || item.name; // 预览要按工作目录下的相对路径找它
    // 顺手记进 attachPaths：一会儿这条消息发出去，气泡上面那排缩略图要按这个路径去取图。
    // 服务端刚亲口说了它放哪儿，比事后拿 sessionDirs 去拼准得多
    attachPaths.set(item.name, item.path);
    item.blob = null;                   // 传完就松手，别攥着 30MB 不放
    setAttachState(item, "done");
    return true;
  } catch (err) {
    // 传不上去就把锚点从输入里撤掉：留着等于告诉模型「这个文件在」，它照着去读只会扑空。
    // chip 留着变红，带一颗重试——文件还在用户手里，别让他重新去 Finder 里找一遍。
    removeAttachmentMarker(item.marker);
    setAttachState(item, "failed", "没传上去");
    toast(`${item.name} 没传上去，点 chip 上的 ↺ 再试一次`, "circle-x");
    return false;
  }
}
/**
 * 拖进来的是不是文件夹。
 *
 * Chrome/Electron 给的 File 里，文件夹长得像一个 0 字节、没有 type 的文件——以前就这么当文件
 * 传上去了：工作目录里多一个 0 字节的同名垃圾文件，chip 还告诉用户「加好了」。实测过。
 * `webkitGetAsEntry` 是准的，拿不到就退回「0 字节 + 没类型 + 名字里没后缀」这个判据。
 */
function droppedDirNames(dt) {
  const out = new Set();
  const items = dt && dt.items ? [...dt.items] : [];
  for (const it of items) {
    if (it.kind !== "file" || !it.webkitGetAsEntry) continue;
    let entry = null;
    try { entry = it.webkitGetAsEntry(); } catch (e) { entry = null; }
    if (entry && entry.isDirectory) out.add(entry.name);
  }
  return out;
}
function looksLikeDir(file, dirs) {
  if (dirs && dirs.has(file.name)) return true;
  return !file.type && file.size === 0 && !/\.[a-z0-9]{1,8}$/i.test(file.name);
}
/**
 * 选中 / 拖进来的一批文件。
 *
 * 顺序是**先把 chip 和锚点全摆出来，再一个一个传**。以前是传完才挂 chip：松手之后界面上
 * 一片空白（实测 4MB 就有 124ms 的空窗，30MB 上手机网更久），用户以为没拖进去，又拖一次。
 * 现在松手那一瞬间 chip 就在，带个转圈，进度在哪一眼看得见。
 */
async function uploadFiles(fileList, { rename, dirs } = {}) {
  const jobs = [];
  for (const file of [...fileList]) {
    if (looksLikeDir(file, dirs)) {
      toast(`「${file.name}」是个文件夹，拖不进来。进去把里面的文件选中再拖，或者先压成 zip`, "folder");
      continue;
    }
    if (file.size > MAX_UPLOAD) {
      toast(`${file.name} 有 ${humanSize(file.size)}，超过 ${humanSize(MAX_UPLOAD)} 的上限，没有加进来`, "circle-x");
      continue;
    }
    const name = rename ? rename(file) : file.name;
    const dup = pendingAttach.find(x => x.name === name);
    if (dup) {
      // 同名的已经在这条消息里了：不再挂第二枚 chip（模型会当成两份素材），但内容照样传一遍
      // 覆盖成最新的——用户重拖一个文件，多半就是因为它刚改过。
      flashAttach(dup);
      toast(`${name} 已经在这条消息里了，内容更新成最新的了`, "circle-check");
      dup.blob = file;
      dup.size = file.size;
      jobs.push(dup);
      continue;
    }
    const item = makeAttachItem(name, { mime: file.type, size: file.size });
    item.blob = file;
    addAttachChip(item);
    // 64 的方片在 2 倍屏上要 128 才不糊；给到 192，缩略图这点体积换的是「一眼认出是哪张」
    if (/^image\//.test(file.type)) thumbDataUrl(file, 192).then(u => setAttachThumb(item, u));
    jobs.push(item);
  }
  const done = [];
  for (const item of jobs) if (await sendAttach(item)) done.push(item);
  // 一批只刷一次文件面板。以前是每传一个文件就把整份文件列表重拉一遍，拖十个文件拉十次。
  if (jobs.length) fetch("/api/files").then(r => r.json()).then(renderFiles);
  return done;
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
  for (let i = 2; pendingAttach.some(x => x.name === name); i++) name = `${stem}-${i}.${ext}`;
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
  const blob = new Blob([text], { type: "text/plain" });
  const item = makeAttachItem(fname, { mime: "text/plain", kind: "text", size: blob.size });
  item.blob = blob;
  addAttachChip(item, head + (text.length > 80 ? "…" : ""));
  if (!(await sendAttach(item))) return false;
  toast(`这段 ${text.length.toLocaleString()} 字存成了 ${item.name}，挂在这条消息上`, "circle-check");
  fetch("/api/files").then(r => r.json()).then(renderFiles);
  return item;
}
/**
 * 输入里的素材锚点是人和模型共同看到的顺序协议；末尾附件清单只是兼容旧会话/CLI 的兜底。
 * 即便用户手动删掉一个锚点，仍有 chip 的文件也不会对模型“凭空消失”。
 */
function composeOutgoing() {
  // 还在传的时候不许发：锚点已经在输入里了，文件却还没落盘，模型照着去读就是一个 404。
  // 宁可让他等两秒，也不要发出去一条自带死链的消息。
  const flying = pendingAttach.filter(x => x.state === "uploading");
  if (flying.length) {
    toast(`还有 ${flying.length} 个文件在传，传完就能发——现在发出去模型读不到它们`, "hourglass");
    return "";
  }
  const typed = inputEl.value.trim();
  const attached = attachmentOrder(typed);
  const lost = pendingAttach.filter(x => x.state === "failed");
  const note = attached.length ? `（已上传文件：${attached.map(x => x.name).join("、")}）` : "";
  // 引用和素材锚点都是发出这一刻才拼进正文的：输入框里只留人自己写的话，
  // 模型收到的仍是原来那套协议（开头一段 `> `，随后一行一个 `【图片 N：…】`）
  const quoted = typeof pendingQuote === "object" && pendingQuote ? quoteBlock(pendingQuote.text) : "";
  // 人自己在正文里摆过的那一枚不重复补，位置以他摆的为准
  const anchors = attached.filter(x => !typed.includes(x.marker)).map(x => x.marker).join("\n");
  if (!typed && !note && !quoted) return "";
  if (lost.length) toast(`${lost.map(x => x.name).join("、")} 没传上去，没跟着这条消息发出去`, "circle-alert");
  inputEl.value = "";
  syncInputHl();
  attachChips.innerHTML = "";
  pendingAttach.length = 0;
  if (typeof clearQuote === "function") clearQuote(); // 引用是「这一条消息」的事，发出去就该消失
  syncSendBtn(); // 框清空了：任务还在跑的话按钮回到「停下」
  return [quoted, anchors, typed && note ? typed + "\n" + note : typed || note].filter(Boolean).join("\n\n");
}
// ＋ 按钮现在开的是菜单不是文件对话框（见本文件末尾「＋ 菜单」一节）；上传走菜单里的「添加文件」
document.getElementById("file-input").addEventListener("change", async (e) => {
  await uploadFiles(e.target.files);
  e.target.value = "";
});
// 拖文件进窗口即上传。document 级必须拦掉默认行为，否则 Electron 会把整个页面导航到 file:// 吞掉应用
let dragDepth = 0;
const inputCard = attachChips.closest(".input-card");
/**
 * 拖拽时的提示条。原来只有输入框上一圈虚线，一个字都没有——拖进来会发生什么、松手落到哪，
 * 全靠用户猜。这里明说：几个文件、落进哪条消息；拖的是一段文字就说文字。
 */
const dropHint = document.createElement("div");
dropHint.className = "drop-hint";
dropHint.setAttribute("aria-hidden", "true");
if (inputCard) inputCard.appendChild(dropHint);
const dragHasPayload = (e) => {
  const t = [...((e.dataTransfer || {}).types || [])];
  return t.includes("Files") || t.includes("text/plain") || t.includes("text/uri-list");
};
function dropHintText(e) {
  const dt = e.dataTransfer || {};
  const types = [...(dt.types || [])];
  if (!types.includes("Files")) return "松手，这段文字放进输入框";
  const n = (dt.items ? [...dt.items] : []).filter(x => x.kind === "file").length;
  return n > 1 ? `松手，${n} 个文件放进这条消息` : "松手，文件放进这条消息";
}
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  // 不说清是「拷贝」的话，光标在某些场景下是那个禁止符号，人会以为这儿不收
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragenter", (e) => {
  if (!dragHasPayload(e)) return;
  dragDepth++;
  dropHint.textContent = dropHintText(e);
  inputCard?.classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  // 只有带货的那条拖拽才计过数，离开时也只认它——否则页面上别的拖拽一走就把提示条灭了
  if (!dragHasPayload(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; inputCard?.classList.remove("dragging"); }
});
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  inputCard?.classList.remove("dragging");
  const dt = e.dataTransfer || {};
  const files = [...(dt.files || [])];
  // 文件夹得在这儿当场问 dataTransfer 要——异步之后 items 就被浏览器清空了
  if (files.length) { await uploadFiles(files, { dirs: droppedDirNames(dt) }); return; }
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
  // 不交给浏览器默认粘贴：一段文字 + 多张图混在同一份剪贴板时，默认行为会把文字塞进框、
  // 图片悄悄丢掉。统一在这里按“文字在前、随后每张图”的可见锚点顺序放入，用户可再手动调整。
  const text = cd.getData("text/plain");
  const files = [...(cd.files || [])];
  if (!text.trim() && !files.length) return;
  e.preventDefault();
  if (text.trim()) {
    if (text.length > BIG_TEXT_CHARS) {
      // 存盘失败也不能吞掉人刚复制的内容：退回到输入框，至少让他能继续编辑或手动发送。
      if (!(await uploadText(text)) && t === inputEl) insertAtCursor(inputEl, text);
    } else {
      insertAtCursor(inputEl, text);
    }
  }
  if (files.length) {
    await uploadFiles(files, { rename: pastedName });
    toast(files.length > 1 ? `${files.length} 份素材挂在这条消息上了，直接说你要它做什么` : "挂上了，直接说你要它做什么", "circle-check");
  }
});

// ================= 两条工作线：办公 / 工程 =================
/**
 * 同一个人一天里在两种活儿之间来回切：做表写稿出图（鼠标流），和写代码跑脚本查日志（键盘流）。
 * 两种活儿的历史混在一列里，找东西全靠翻——所以分成两条线，各记各的会话，共用同一份文件和工作目录。
 *
 * 工程线还多一件事：它连着**这台机器的 `openworkbuddy` 命令行**。在终端里起的任务会自己挂到服务端能读到的
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
    try { saved = localStorage.getItem("owb_lane"); } catch {}
    if (saved !== "cli" && saved !== "office") activeLane = defaultLane;
  } catch {}
  renderLaneTabs();
  renderHistory();
}
document.getElementById("lane-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-lane]");
  if (!btn || btn.dataset.lane === activeLane) return;
  activeLane = btn.dataset.lane;
  try { localStorage.setItem("owb_lane", activeLane); } catch {}
  renderLaneTabs();
  // 当前开着的这条对话属于另一条线：切过去等于换了张桌子，给一张空白的新任务。
  // 正在后台跑的任务不受影响（它绑的是自己的 sid，切走照跑，回来还能接上直播）。
  const cur = sessionId && sessions.find((x) => x.id === sessionId);
  if (cliWatch || (cur && laneOfSession(cur) !== activeLane)) document.getElementById("new-task").click();
  else renderHistory();
});

// ---------- 工程线：终端（openworkbuddy 命令行）里正在跑的活儿 ----------
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
      // 没在跟的那几趟卡在题上，侧栏那行也得亮、标题也得算上——只有正在跟的那趟有 pollCliAsk 盯着。
      // 一趟都不在跑就不问了，直接把终端那一路的账清掉
      const p = cliLiveRows.some((r) => r.live)
        ? await fetch("/api/cli/pending").then((r) => r.json()).catch(() => null)
        : { rows: [] };
      if (p && Array.isArray(p.rows)) attnSyncAsks("cli", p.rows);
    }
  } catch { next = 30000; } // 网断了别一秒一次地撞
  setTimeout(pollCliLive, next);
}

/** 跟一趟终端里的活儿：它此刻在干什么，原样放到对话区里，跟本机跑的任务长一个样 */
async function openCliLive(row) {
  closeAssistView();
  stopCliWatch();
  sessionId = row.id;
  resetCtxMeter(); // 上一条对话的上下文余量别挂到这趟终端任务头上
  pvPanel.classList.remove("show"); pvCurrent = null;
  document.getElementById("files-panel").classList.remove("show");
  document.getElementById("session-title").textContent = stripSceneTag(row.title) || "终端里的任务";
  chatCol.innerHTML = "";
  document.getElementById("empty")?.remove();
  const ui = createTurnUI(row.title || "（终端里起的任务）", "craft", row.id);
  if (ui.turn && !ui.turn.parentNode) chatCol.appendChild(ui.turn);
  cliWatch = { id: row.id, es: null, ui, live: !!row.live };
  cliAskSeen.clear();
  attnSeen(row.id);
  if (row.live) pollCliAsk(); // 它可能此刻正卡在一道题上等人
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
  attnRunEnded(w.id);
  const row = cliLiveRows.find((r) => r.id === w.id);
  if (!sessions.some((x) => x.id === w.id)) {
    sessions.unshift({ id: w.id, title: (row && row.title) || "终端里的任务", at: (row && row.startedAt) || Date.now(), lane: "cli" });
    saveSessions();
  }
  bumpDoneWhileAway((row && row.title) || "终端里的任务");
  renderHistory();
  updateSendUI();
}
/**
 * 终端里那趟卡在等回答时，把那道题也摆到这一屏上。
 *
 * 终端那边等回答是「卡住不动直到超时」，而超时对一道选择题来说就是替人选了。
 * 人起了个活儿转头去开会，回来只看见「没等到回答，按默认继续了」——他根本没被问到过。
 * 所以这一屏也得能答：终端和手机谁先答算谁的，命令行那边按 askId 认，不会串。
 *
 * 只在跟着某一趟看的时候轮询：它是终端进程写在盘上的文件，服务端也只是替我们读，
 * 没人看着的时候一直问它纯属白烧电。
 */
const cliAskSeen = new Set(); // 已经画出来的题，轮询每 1.5 秒回来一次，不能每次都重画一张
async function pollCliAsk() {
  const w = cliWatch;
  if (!w || !w.live) return;
  let d = null;
  try {
    d = await fetch("/api/cli/pending?sessionId=" + encodeURIComponent(w.id)).then((r) => r.json());
  } catch { d = null; }
  if (!cliWatch || cliWatch !== w || !w.live) return; // 这期间人切走了
  if (d && d.allowed === false) return; // 不是这台机器的主人，不用再问了
  const rows = (d && Array.isArray(d.rows)) ? d.rows : [];
  if (d) attnSyncAsks("cli", rows, w.id); // 这一趟的账以这里为准，比 pollCliLive 那 3~20 秒一轮快
  const now = new Set(rows.map((a) => a.id));
  // 题没了 = 终端那边答了或者超时了。把卡定格，别在屏幕上留一道点了没反应的题
  for (const el of w.ui.body ? w.ui.body.querySelectorAll(".ask-card[data-cli-ask]") : []) {
    if (!now.has(el.dataset.cliAsk) && !el.classList.contains("done")) {
      el.classList.add("done");
      const ap = el.classList.contains("ask-approve");
      el.querySelector(".ask-lb").textContent = ap ? "这条在终端里点过了" : "这道题在终端里答了";
      el.querySelector(".ask-ans").innerHTML = `<span class="ic">${ic("terminal")}</span>${ap ? "准不准是在命令行那边点的（也可能是等超时了，那就是没准）" : "答案是在命令行那边给的"}`;
    }
  }
  for (const a of rows) {
    if (cliAskSeen.has(a.id)) continue;
    cliAskSeen.add(a.id);
    const card = makeAskCard(
      a.type === "approval"
        // 审批：命令原文、拦它的规则、三档选择都从终端那边原样带过来，这一屏不自己编一套
        ? { ask_id: a.id, kind: "approval", apKind: a.kind, text: a.text, rule: a.rule, detail: a.detail, choices: a.choices || [], deadline: a.deadline, now: d && d.now }
        : { ask_id: a.id, question: a.question, options: a.options || [], deadline: a.deadline, now: d && d.now },
      w.id,
      (value) => fetch("/api/cli/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: w.id, askId: a.id, value }),
      }),
    );
    card.dataset.cliAsk = a.id;
    if (w.ui.body) w.ui.body.appendChild(card);
  }
  setTimeout(pollCliAsk, 1500);
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
  // 工程线不按项目过滤：终端里 `openworkbuddy` 起的任务没有「项目」这个概念（命令行不问这个），
  // 一过滤就整条线空着，看起来像功能坏了。这条线本来就是「这台机器的终端干过的活儿」。
  if (activeLane === "cli") return sessions.filter(s => laneOfSession(s) === "cli");
  const inProject = projectsLocked ? sessions : sessions.filter(s => (s.project || "默认项目") === activeProject);
  // 再按工作线分栏：办公那条线的历史不该混进工程标签里（反过来也一样）。
  // 老会话没记过 lane，按服务端算的回落值归位——不会整批「消失」到另一个标签底下
  return inProject.filter(s => laneOfSession(s) === activeLane);
}
/* 侧栏历史的检索。任务攒到几十条的时候翻列表不如打字——标题栏那个放大镜展开的就是它。
   只过滤显示，不动 sessions 本身，所以清空输入框立刻全回来。

   以前这儿只筛标题。可标题是任务跑完自动起的，用户从没读过一眼；他记得的是自己当时打的那句话
   （「把这个 csv 里重复的行挑出来」），或者最后拿到的那个文件名。按标题筛，这两种记法一条都找不着，
   只能一条条点开看，点到第五条就放弃了。
   现在分两层：
     本地这一层 —— 每敲一个键立刻筛标题，不等网络。等网络的搜索框在打字时是空列表，
                   而空列表看起来跟「没搜到」一模一样，人会在结果回来之前就改词或者放弃。
     服务端那层 —— 慢 300ms 跟上，正文、产出文件名、意思相近的一起找，带命中片段回来。
   服务端那层回来了就接管，没回来 / 失败了就一直是本地这层兜着，绝不会出现「先空一下再有」。 */
let histQuery = "";
let histHits = null;      // 服务端搜索结果；null = 还没回来 / 没在搜
let histNote = "";        // 这次是靠什么找的，如实说
let histErr = "";         // 搜挂了要说，不能拿「没搜到」糊过去——那是两件事
let histTimer = null;
let histSeq = 0;
function histMatch(t) {
  const q = histQuery.trim().toLowerCase();
  return !q || String(t || "").toLowerCase().includes(q);
}
/** 服务端检索：防抖 300ms。每次请求带个序号，回来的时候对不上就丢掉——
    打字快的时候后发的先到，不对序号的话列表会跳回上一个词的结果 */
function histSearchSoon() {
  clearTimeout(histTimer);
  const q = histQuery.trim();
  if (!q) { histHits = null; histNote = ""; histErr = ""; renderHistory(); return; }
  histTimer = setTimeout(async () => {
    const seq = ++histSeq;
    try {
      const r = await fetch("/api/sessions/search?q=" + encodeURIComponent(q));
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (seq !== histSeq || histQuery.trim() !== q) return;
      histHits = Array.isArray(j.hits) ? j.hits : [];
      histNote = String(j.note || "");
      histErr = "";
    } catch (e) {
      if (seq !== histSeq) return;
      histHits = null;                    // 兜回本地筛标题，而不是摆一张空列表
      histErr = "只筛了标题——正文检索没连上（" + (e && e.message ? e.message : "请求失败") + "）";
    }
    renderHistory();
  }, 300);
}
/** 一条命中行：标题 + 为什么是它 + 命中那一小段。片段用下标标出命中位置，这儿负责转义 */
function histHitRow(h, activeId) {
  const t = stripSceneTag(h.title || "未命名任务");
  const sn = h.snippet;
  let snip = "";
  if (sn && sn.text) {
    const s = String(sn.text);
    snip = (sn.at >= 0 && sn.len)
      ? esc(s.slice(0, sn.at)) + "<mark>" + esc(s.slice(sn.at, sn.at + sn.len)) + "</mark>" + esc(s.slice(sn.at + sn.len))
      : esc(s);
  }
  return `<div class="hist-item found ${h.id === activeId ? "active" : ""}" data-id="${esc(h.id)}" title="${esc(t)}">`
    + `<span class="ht">${esc(t)}</span><span class="hwhy">${esc(h.why || "")}</span>`
    + (snip ? `<div class="hsnip">${snip}</div>` : "")
    + `</div>`;
}
function renderHistory() {
  const all = projectSessions();
  // 服务端的命中列表回来了就由它接管：它找的是正文和意思，本地这层只认标题
  if (histQuery.trim() && histHits) {
    const cnt0 = document.getElementById("hist-count");
    if (cnt0) cnt0.textContent = histHits.length + "/" + all.length;
    const body = histHits.length
      ? histHits.map((h) => histHitRow(h, sessionId)).join("")
      : `<div class="hist-empty">没找着「${esc(histQuery.trim())}」——标题、对话正文、产出文件名都找过了</div>`;
    document.getElementById("history").innerHTML = body
      + (histNote ? `<div class="hist-note">${esc(histNote)}</div>` : "");
    return;
  }
  const list = all.filter((s) => histMatch(stripSceneTag(s.title)));
  const cnt = document.getElementById("hist-count");
  // 只在过滤时写「命中/总数」。平时那个数字是纯噪音——Claude Cowork 和 Codex 的任务列表
  // 都不挂计数徽章，因为「我有几条任务」从来不是用户打开侧栏要问的问题，
  // 而它占掉的正是标题行里最显眼的位置。
  if (cnt) cnt.textContent = (!all.length || list.length === all.length) ? "" : list.length + "/" + all.length;
  // 卡着等你回答/批准的那几条顶到最上面，其余照原来的顺序（sort 是稳定的）。
  // 人扫一眼侧栏最想知道的就是「哪条在等我」，它沉在第八行，点亮了也等于没亮
  const askFirst = (id) => (attnPick(sessionAttn.get(id), false) === "ask" ? 0 : 1);
  const rows = list.slice().sort((a, b) => askFirst(a.id) - askFirst(b.id)).map(s =>
    `<div class="hist-item ${s.id === sessionId ? "active" : ""}" data-id="${s.id}" title="${esc(stripSceneTag(s.title))}"><span class="ht">${esc(stripSceneTag(s.title))}</span>${attnDotHtml(s.id)}<button type="button" class="hx" title="删除该任务" aria-label="删除该任务">${ic("x")}</button></div>`);
  // 终端里正在跑的那几条，直接排在同一张列表的最上面，不再单开一撮。
  // 以前这里是「任务历史 → 10 → 终端里（openworkbuddy 命令行） → 才轮到内容」，三行铺垫才见着第一条任务。
  // Claude Cowork 和 Codex 的做法是一张扁平列表：来路和状态用行内的小图标表示，
  // 正在跑的排前面，不为一种来路单开一节。分组标题只有在「有好几组」时才帮得上忙，
  // 这儿永远只有一组，那行字就是纯占地方。
  // 「怎么一开始显示：任务历史 10 终端里（命令行） 然后是具体的内容了」（原话里是改名前的旧命令名）
  let head = "";
  if (activeLane === "cli") {
    const known = new Set(all.map((s) => s.id));
    const live = cliLiveRows.filter((r) => !known.has(r.id) && histMatch(stripSceneTag(r.title) || "终端里的任务"));
    // 正在跑的排最前，其余按原顺序。翻列表的人要找的多半就是还在跑的那条
    const ordered = [...live].sort((a, b) => (askFirst(a.id) - askFirst(b.id)) || (Number(!!b.live) - Number(!!a.live)));
    head = ordered.map((r) => {
      const t = stripSceneTag(r.title) || "终端里的任务";
      const tip = r.live ? "正在跑——点开能看见它在干什么，也能插话" : (r.died ? "终端被关掉了，没跑完" : "刚跑完");
      return `<div class="hist-item ${r.id === sessionId ? "active" : ""}" data-cli="${esc(r.id)}" title="${esc(t + "\n" + (r.cwd || "") + "\n" + "来自终端（openworkbuddy 命令行）· " + tip)}">`
        + `<span class="hsrc" title="${esc("在终端里起的（openworkbuddy 命令行）")}" aria-label="${esc("来自终端")}">${ic("terminal")}</span>`
        + `<span class="ht">${esc(t)}</span>${attnDotHtml(r.id, !!r.live)}</div>`;
    }).join("");
  }
  const empty = histQuery.trim()
    ? (histErr ? esc(histErr) : `没有名字里带「${esc(histQuery.trim())}」的任务——正文还在找`)
    : (activeLane === "cli"
      ? "还没有终端任务。在终端跑 <code>openworkbuddy 你的活儿</code> 就会出现在这里。"
      : (projectsLocked ? "这条线上还没有任务" : "该项目在这条线上还没有任务"));
  document.getElementById("history").innerHTML = head + rows.join("")
    || `<div class="hist-empty">${empty}</div>`;
}
/* 放大镜：展开就聚焦，收起就顺手清掉过滤词——不然收起来之后列表还少一半，
   用户会以为任务丢了。Esc 也收（跟其他弹层一个手感）。 */
(function initHistFind() {
  const btn = document.getElementById("hist-find"), q = document.getElementById("hist-q");
  if (!btn || !q) return;
  const open = (on) => {
    q.hidden = !on;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) q.focus();
    else if (histQuery) { histQuery = ""; q.value = ""; histHits = null; histNote = ""; histErr = ""; clearTimeout(histTimer); renderHistory(); }
  };
  btn.addEventListener("click", () => open(q.hidden));
  q.addEventListener("input", () => { histQuery = q.value; renderHistory(); histSearchSoon(); });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") { open(false); btn.focus(); } });
})();
document.getElementById("history").addEventListener("click", async (e) => {
  const item = e.target.closest(".hist-item");
  if (!item) return;
  if (item.dataset.cli) { // 终端里那趟：跟直播，不是回放存下来的记录
    const row = cliLiveRows.find((r) => r.id === item.dataset.cli);
    if (row) await openCliLive(row);
    return;
  }
  if (e.target.closest(".hx")) {
    if (!(await askConfirm({ title: "删掉这个任务？", hint: "它的对话记录一起没，找不回来。", ok: "删掉", danger: true }))) return;
    const id = item.dataset.id;
    sessions = sessions.filter(s => s.id !== id);
    saveSessions();
    if (runningSessions.has(id)) { // 正在跑的任务跟着会话一起停，别留孤儿任务烧钱
      fetch("/api/chat/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }).catch(() => {});
    }
    sessionQueues.delete(id);
    attnForget(id);
    fetch("/api/session/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
    if (sessionId === id) document.getElementById("new-task").click();
    else renderHistory();
    return;
  }
  await openSession(item.dataset.id);
});

/**
 * 滚到第 n 个回合并让它亮一下，跳不过去就返回 false（交回给调用点，照旧滚到底）。
 *
 * 不硬跳的理由：回合号是从对话记录里数出来的，老会话根本没记过，记录也可能被裁过。
 * 宁可退回「把对话打开」这个老行为，也别把人扔在一段跟他点的那份文件毫无关系的对话中间——
 * 后者看起来像功能坏了，前者只是没帮上忙。
 */
function jumpToTurn(n) {
  const el = chatCol.querySelectorAll(".turn")[n];
  if (!el) return false;
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  el.classList.remove("turn-jumped");
  void el.offsetWidth; // 逼一次重排，不然连点同一份文件第二次，动画不会重放
  el.classList.add("turn-jumped");
  clearTimeout(jumpToTurn._t);
  jumpToTurn._t = setTimeout(() => el.classList.remove("turn-jumped"), 2600);
  return true;
}

/**
 * 打开一个会话并回放它的对话（历史列表点击 / 评测页「打开对话」都走这里）。
 * opts.turn 给的是「停在第几回合」：从资料库点一份产出过来的人，要找的是
 * 写出这份东西的那几句话，落在对话最底下等于还得自己翻一遍。
 */
async function openSession(id, opts) {
  closeAssistView();
  stopCliWatch(); // 换了会话就别再往上一趟里塞事件了
  sessionId = id;
  planPlaceholder = ""; // 「哪一步要改？」问的是上一个会话那份计划
  attnSeen(id); // 点开了就算看过：侧栏上那颗「出错了/跑完了」熄掉
  // 上个会话开着的预览/文件面板不带进来
  resetCtxMeter(); // 余量条也是：先收回去，下面回放到本会话自己的 context 事件再填
  pvPanel.classList.remove("show"); pvCurrent = null;
  document.getElementById("files-panel").classList.remove("show");
  const s = sessions.find(x => x.id === sessionId);
  // 从别处打开的对话（搜索、评测页「打开对话」）可能属于另一条工作线：标签跟着切过去，
  // 不然侧栏里高亮的那条根本不在当前列表里，用户会以为自己点丢了
  const sLane = laneOfSession(s);
  if (s && sLane !== activeLane) {
    activeLane = sLane;
    try { localStorage.setItem("owb_lane", activeLane); } catch {}
    renderLaneTabs();
  }
  document.getElementById("session-title").textContent = s ? stripSceneTag(s.title) : "任务";
  renderHistory();
  // 回放服务端保存的完整对话（含工具执行过程）
  chatCol.innerHTML = "";
  const data = await fetch("/api/session/" + encodeURIComponent(sessionId)).then(r => r.json()).catch(() => ({ transcript: [] }));
  // 侧栏里没有这一条时（自动化的「看执行过程」、搜索结果、评测页点进来的），标题从服务端取。
  // 不然点开一趟定时任务的执行过程，顶上写的是光秃秃一个「任务」，认不出是哪条任务的哪一次。
  if (!s && data.title) document.getElementById("session-title").textContent = (data.kind === "schedule" ? "定时 · " : "") + stripSceneTag(data.title);
  if (data.dir && sessionDirs.get(sessionId) !== data.dir) { sessionDirs.set(sessionId, data.dir); openDirs.add(data.dir); renderFiles(filesCache); }
  if (data.model) sessionModels.set(sessionId, data.model); else sessionModels.delete(sessionId);
  updateModelLabel();
  if (data.goal) sessionGoals.set(sessionId, data.goal); else sessionGoals.delete(sessionId);
  renderGoalCard();
  let transcript = data.transcript || [];
  // 该会话有任务正在后台跑：回放只到本轮之前，正在跑的这轮把"活的"回合元素接回来
  // （它切走期间一直在后台收事件更新，接上就是完整直播，不用回放+续流拼接）
  const live = runningSessions.get(sessionId);
  if (live) {
    const lastUser = transcript.map(e => e.type).lastIndexOf("user");
    if (lastUser >= 0) transcript = transcript.slice(0, lastUser);
  }
  let ui = null;
  let 未收尾 = null;
  isReplaying = true;
  replayFeedback = new Map((data.feedback || []).filter(f => f && f.turn != null).map(f => [f.turn, f]));
  try {
    for (const entry of transcript) {
      if (entry.type === "user") {
        ui = createTurnUI(entry.text, entry.mode, undefined, entry.shown);
        未收尾 = ui;
      } else if (entry.type === "assistant" && ui) {
        for (const ev of entry.events || []) ui.handleEvent(ev);
        ui.finish();
        未收尾 = null;
      }
    }
    // 最后一问没有对应的回答（跑到一半进程没了、服务重启了）：也得收尾。
    // 不收的话这一轮会一直转着「运行中…」，而 runningSessions 里根本没有它，用户找不到任何能停的地方
    if (未收尾) 未收尾.finish({ interrupted: true });
  } finally { isReplaying = false; replayFeedback = null; }
  if (live) {
    document.getElementById("empty")?.remove();
    chatCol.appendChild(live.ui.turn);
  } else if (!transcript.length) {
    chatCol.innerHTML = '<div style="text-align:center;color:var(--owb-text-3);font-size: 13px;padding:20px">该任务还没有保存的对话记录（可能创建于旧版本），继续对话即可。</div>';
  }
  updateSendUI();
  const want = opts && Number.isInteger(opts.turn) && opts.turn >= 0 ? opts.turn : null;
  if (want != null && jumpToTurn(want)) return; // 跳过去了就别再一脚滚到底把人甩开
  scrollBottom(true);
}
document.getElementById("new-task").onclick = () => {
  closeAssistView();
  stopCliWatch();
  sessionId = null;
  planPlaceholder = "";
  pendingModel = defaultPendingModel();
  updateModelLabel();
  renderGoalCard();
  resetCtxMeter(); // 新对话的上下文是空的，别让上一条那个百分比留在屏幕上吓人
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
    `<div class="proj-item ${p.name === activeProject ? "active" : ""}" data-name="${esc(p.name)}" title="${esc(p.dir)}">${ic("folder-open")}<span class="pn">${esc(p.name)}</span>${projects.length > 1 ? `<button type="button" class="del" title="移除项目（不删文件）" aria-label="移除项目（不删文件）">${ic("x")}</button>` : ""}</div>`).join("");
  box.querySelectorAll(".proj-item").forEach(el => el.onclick = async (e) => {
    const name = el.dataset.name;
    if (e.target.closest(".del")) {
      if (!(await askConfirm({ title: `把项目「${name}」从列表移除？`, hint: "只从列表移除，不删硬盘上的文件。", ok: "移除" }))) return;
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
// 这颗 ＋ 长在「项目」那一行里面，而整行是「打开项目管理页」。不拦住冒泡的话，
// 点 ＋ 会被 .side-nav 上那个委托监听当成点了整行：主区切到项目页、顺手把 #proj-list
// 整个重画一遍——刚插进去的东西当场被抹掉，屏幕上就是「闪了一下什么也没有」。
// 新建走的是项目页上那颗「新建项目」同一个编辑器：只填个名字的话，工作目录、项目指令、
// 挂哪块资料库这些当场都配不了，事后还得再进去补一趟。
document.getElementById("proj-add").onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  openProjEditor(null);
};
refreshProjects();

// ================= 发送（运行中按钮变「停止」） =================
// ================= 并行任务：运行态/排队按会话隔离，不同对话互不阻塞 =================
// 每条都带上「@ / 能用」：闲着时的提示语是用户唯一会看的说明书，以前只有首屏 HTML 里写了，
// 一切模式就被这张表盖掉，用户根本不知道 @ 能引文件、/ 能调技能
const MODE_PLACEHOLDER = {
  ask: "问我任何问题（不改文件）。@ 引用文件，/ 调用技能与指令",
  goal: "描述目标，没达成我自动接着跑。@ 引用文件，/ 调用技能与指令",
  plan: "描述任务，我先出执行计划。@ 引用文件，/ 调用技能与指令",
  craft: "今天帮你做些什么？@ 引用文件，/ 调用技能与指令",
};
const BUSY_PLACEHOLDER = "想补一句或改方向？直接打字，按 Enter 就插进来，我做完这一步就看";
const QUEUE_PLACEHOLDER = "Enter 排到队尾；要立刻插进去，切到「插队」";
const CLI_PLACEHOLDER = "这趟是在终端里跑的。打字按 Enter 能插一句给它；想让它停，回终端按 Ctrl+C";
// 计划卡上点了「接着改计划」：输入框问一句「哪一步要改？」，直到下一次发出去 / 换会话才撤。
// 不能直接写 inputEl.placeholder——updateSendUI / setMode 每次都会走 syncPlaceholder 把它盖回去，
// 所以做成这里的一个一次性覆盖，只在还停在 Plan 时生效
let planPlaceholder = "";
function planAskEdit(ph) { planPlaceholder = ph || ""; syncPlaceholder(); inputEl.focus(); }
/** 输入框的提示语跟着状态走：任务在跑时告诉用户「打字 + Enter 就能插话」，闲着时按模式提示 */
function syncPlaceholder() {
  // 跟着终端里那趟活儿时只能插话，停不了——停它得回终端按 Ctrl+C。这里就照实说
  inputEl.placeholder = cliBusy() ? CLI_PLACEHOLDER
    : curBusy() ? (busySendMode === "queue" ? QUEUE_PLACEHOLDER : BUSY_PLACEHOLDER)
    : (planPlaceholder && currentMode === "plan" ? planPlaceholder : (MODE_PLACEHOLDER[currentMode] || MODE_PLACEHOLDER.craft));
}
/** 框里有没有还没发出去的东西（文字或待发附件） */
// 只挂了一张图、或者只引了一段还没打字，也算「有话要说」：按钮得是「发出」，Enter 也得送得出去
function hasDraft() { return !!(inputEl.value.trim() || pendingAttach.length || (typeof pendingQuote === "object" && pendingQuote)); }
/**
 * 一颗键两种意思，看框里有没有字：任务在跑 + 框空着 → 「◼ 停下」；任务在跑 + 打了字 → 「↑ 插一句」（发出去就是插队）；
 * 闲着 → 普通发送。以前运行中不管框里有没有字点一下都是停止，用户打了半天字一点按钮任务没了。
 */
function syncSendBtn() {
  const cli = cliBusy();
  const busy = curBusy(), draft = hasDraft();
  // 终端里那趟不给「停」：这个进程不归网页管，画一颗按下去没反应的停止键是骗人
  const stopMode = !cli && busy && !draft;
  // 排队模式下按钮得换个样子和说法，不然选了「排队」按钮还写着「插一句」，
  // 人按下去心里是没底的——不知道自己这条到底打没打断它。
  const queueMode = busy && !cli && draft && busySendMode === "queue";
  sendBtn.classList.toggle("stop", stopMode);
  sendBtn.classList.toggle("interject", (busy || cli) && draft && !queueMode);
  sendBtn.classList.toggle("queued", queueMode);
  sendBtn.innerHTML = ic(stopMode ? "square" : queueMode ? "hourglass" : "arrow-up");
  sendBtn.title = stopMode ? "让我停下（Esc）"
    : cli ? "插一句给终端里的它（Enter）"
    : queueMode ? "排到队尾：不打断现在这件事，做完了自己开始（Enter）"
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
  // 开关只在「真的在跑」时出现：闲着的时候这两个词没有意义，摆在那儿只会让人猜。
  const sw = curBusy() ? `<span class="qb-sw" role="radiogroup" aria-label="任务在跑时，我发的消息怎么算">
      <button type="button" class="qb-o${busySendMode === "interject" ? " is-on" : ""}" data-m="interject"
        role="radio" aria-checked="${busySendMode === "interject"}"
        title="立刻插入当前任务，用于就地纠偏">${ic("zap")}插队</button>
      <button type="button" class="qb-o${busySendMode === "queue" ? " is-on" : ""}" data-m="queue"
        role="radio" aria-checked="${busySendMode === "queue"}"
        title="等当前任务做完再按顺序开始">${ic("hourglass")}排队</button>
    </span>` : "";
  bar.innerHTML =
    q.map((m, i) => `<span class="q-chip" title="${esc(m.text)}"><span class="qt">${ic("hourglass")}${esc(m.text.slice(0, 30))}</span><span class="qx" data-i="${i}" title="取消这条">${ic("x", "i-sm")}</span></span>`).join("") +
    (curBusy() ? `<span class="qb-hint"><span>我正忙着这件事。下面打字按 Enter，这条${busySendMode === "queue" ? "排到队尾，等我做完再开始" : "我做完这一步就看"}。</span>${sw}<button type="button" class="qb-stop" title="停下当前任务（Esc）">${ic("square")}让我停下</button><span>想同时做别的，点左上「新建任务」。</span></span>` : "");
  bar.querySelectorAll(".qx").forEach(x => x.onclick = () => { q.splice(+x.dataset.i, 1); renderQueueBar(); });
  bar.querySelectorAll(".qb-o").forEach(b => b.onclick = () => {
    setBusySendMode(b.dataset.m);
    renderQueueBar();  // 开关自己要变色
    syncSendBtn();     // 发送键跟着换图标和提示语
    syncPlaceholder();
  });
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
/**
 * 排队：这条不进当前这趟，挂在队尾。跑完那一刻 runTurn 收尾处的 drainQueue 会把它取出来当新一轮跑。
 * 排着的每条在队列栏上是一枚可撤销的 chip——排错了能拿下来，不用等它跑起来再按停止。
 */
function queueText(text) {
  qOf(sessionId).push({ text, mode: currentMode });
  renderQueueBar();
  syncSendBtn();
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
/**
 * 按下「让我停下」。
 *
 * 以前这里把服务端的回话整个 .catch 吞了：服务端说「该会话没有正在运行的任务」也好，
 * 网线断了也好，界面上都只剩一颗停在「…」上的按钮。人看到的是「点了没反应」，
 * 于是接着连点——而连点一次都到不了后端，因为第一次就已经把这趟任务从表里摘掉了。
 * 停不下来这件事，一半在后端（命令没接停止信号），另一半就在这三行。
 */
async function stopTask() {
  if (!sessionId) return;
  sendBtn.textContent = "…";
  sendBtn.title = "正在停…";
  let r = null;
  try {
    const resp = await fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    r = await resp.json();
  } catch {
    toast("没连上服务端，停止的指令没送出去", "circle-x");
    syncSendBtn();
    return;
  }
  if (r && r.ok) {
    // 后端收到了，但正在跑的那一步还要几百毫秒才收得干净。说清楚「在停」而不是「停了」，
    // 免得这段时间里又冒出一行输出，人以为按钮是假的。
    toast("收到，正在停下当前这一步");
    return;
  }
  toast((r && r.error) || "这条任务已经不在跑了", "circle-x");
  syncSendBtn();
}
async function send() {
  let text = composeOutgoing();
  if (!text) return;
  // 委派标签在这一刻才变成一句话。标签本身只是界面上的一枚 chip，正文里一个字都没留过
  if (useTag) { text = useDirective(useTag) + text; setUseTag(null); }
  if (sceneTag) {
    text = `【任务类型：${sceneTag.replace(/^[^一-龥A-Za-z]+\s*/, "")}】` + text;
    setSceneTag(null);
  }
  mentionMenu.classList.remove("show");
  if (pageKind === "assist") { await sendAssistLocal(text); return; }
  if (cliBusy()) { await interjectCli(text); return; } // 跟着终端那趟：话插到它的任务里，不在网页这边另起一趟
  if (curBusy()) {
    // 本对话的任务在跑 → 按用户选的来（插队栏上那个开关，默认插队）：
    // 插队 = 立即注入当前任务一起处理；排队 = 等这趟跑完再按顺序开始。
    // 要另起一趟并行的，还是走左上「新建任务」。
    if (busySendMode === "queue") { queueText(text); return; }
    await interjectText(text);
    return;
  }
  await doSend(text, currentMode);
}

/** 左边历史列表里有没有这条对话那一行。取过 id 不等于列过——先传附件时 id 就已经有了，但人还没发出去 */
const sessionListed = () => !!sessionId && sessions.some((s) => s.id === sessionId);

// regen=true 表示「重新生成」：服务端回滚最后一轮再重跑同一条消息
async function doSend(text, mode, regen, shown) {
  if (curBusy()) return;
  planPlaceholder = ""; // 「哪一步要改？」问的就是这一句，发出去了就收回
  closeAssistView();
  if (!sessionListed()) {
    ensureSessionId();
    const shortTitle = stripSceneTag(text).slice(0, 24); // 标题里不留场景标签，否则历史列表整排都是「【任务类型：…」
    sessions.unshift({ id: sessionId, title: shortTitle, at: Date.now(), project: activeProject, lane: activeLane });
    saveSessions();
    document.getElementById("session-title").textContent = shortTitle;
    if (pendingModel) { const pm = pendingModel; pendingModel = undefined; await setSessionModel(pm); }
  }
  await runTurn(sessionId, text, mode, regen, shown);
}

// 真正执行一轮任务：绑定 sid 而不是全局 sessionId——用户切走后它继续在后台跑
/** 镜像 server.js recordingEmit 的记录口径：数出服务端 transcript 已记录到第几个事件。
 *  断流重连时靠它算出准确的 from/textOffset 从断点续流——哪些事件入账、text 怎么合并必须和服务端完全一致 */
function makeRecCounter() {
  const KEEP = ["tool_use", "tool_result", "parallel", "expert_start", "expert_done", "error", "limit", "auto_continue", "failover", "sleep", "trim", "compact", "usage", "interject", "worktree", "credits", "sources", "ask_user", "ask_answer", "milestones", "todos", "context", "trace"];
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
    // 「还在跑吗」这一问**不能只问一次**。它失败最常见的原因不是网断了，是服务端正好在重启
    // （改了配置、装了依赖、Electron 自己重载），那只有一两秒。问一次就放弃的话，用户看到
    // 「连接中断」而任务其实在后台跑得好好的——他去点「重新生成」，于是同一件事跑两遍、
    // 烧两份钱，先跑完的那份还会把后跑的顶掉。退避着多问几次，代价是几秒，省的是这一整串。
    const still = await probeRunning();
    if (still === null) break; // 连着问了几次都不通：这才是真的断了
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
  if (netErr) ui.handleEvent({ type: "error", message: "连接中断：" + netErr.message + "。任务可能仍在后台运行，刷新即可接回；别点重新生成，会重复执行" });
}

/**
 * 「服务端此刻还在跑哪几趟」。连不上就退避重问，一共约 7 秒。
 * 返回 id 数组；连着几次都连不上才返回 null（= 真的断了）。
 */
async function probeRunning(tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch("/api/chat/running");
      if (r.ok) return await r.json();
    } catch {}
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i)); // 0.5s → 1s → 2s
  }
  return null;
}

/** 一轮任务收尾（正常结束/出错/被停止都走这里）。opts.quiet：发起的那一页自己已经报过「完成」了，别再弹 toast */
function endRun(sid, ui, opts) {
  ui.finish();
  runningSessions.delete(sid);
  attnRunEnded(sid); // 被停了、断了的那一轮，流里没等到回答的题一起作废
  if (!(sessionQueues.get(sid) || []).length) attnFlag(sid, "unseen"); // 人正看着这条的话 attnFlag 自己不记
  updateSendUI();
  if (!(sessionQueues.get(sid) || []).length) notifyRunDone(sid, ui, opts); // 还有排队消息就不算完
  if (sid === sessionId) inputEl.focus();
  drainQueue(sid); // 本会话运行期间排队的消息按序自动执行
}

/** 并行任务多了得知道哪个跑完了：后台会话完成弹 toast；窗口失焦时发系统通知 */
function notifyRunDone(sid, ui, opts) {
  if (typeof attnGone !== "undefined" && attnGone.has(sid)) return; // 删掉了的会话收尾：不报「已完成」
  const s = sessions.find((x) => x.id === sid);
  const name = stripSceneTag(s && s.title) || "任务";
  // 长跑完成通知带上战报：用时/步数/产出件数，长任务离开视线也知道干了多少活
  const st = ui && ui.stats ? ui.stats() : null;
  const detail = st ? `用时 ${st.dur}${st.steps ? ` · ${st.steps} 步` : ""}${st.rounds ? ` · 续跑 ${st.rounds} 轮` : ""}${st.outs ? ` · 产出 ${st.outs} 件` : ""}` : "";
  if (sid !== sessionId && !(opts && opts.quiet)) toast(`「${name}」已完成${detail ? `（${detail}）` : ""}，点侧栏查看`, "circle-check");
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
let lastDoneName = "";
function bumpDoneWhileAway(name) {
  // 终端那趟收尾不看人在不在都会调进来；人正看着页面就不记，不然标题上挂个 (1) 没人来清
  if (!document.hidden) return;
  doneWhileAway++;
  lastDoneName = name || lastDoneName;
  syncTitleCount();
}
/**
 * 标题前的「(n) 」只从这里写：n = 在等你的题数 + 你不在时跑完的个数。
 * 桌面版主进程拿这个前缀挂 Dock 角标（electron-main.js 的 page-title-updated），
 * 所以两处的数永远是同一个——别在别处直接往 document.title 上拼数字。
 * 底下那段标题（助理名）谁改都行，这里每次都先把旧前缀剥掉再算。
 */
function syncTitleCount() {
  const base = String(document.title || "").replace(/^\(\d+\) /, "");
  const n = attnCount(sessionAttn) + doneWhileAway;
  const want = n ? `(${n}) ${base}` : base;
  if (document.title !== want) document.title = want;
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (sessionId) attnSeen(sessionId); // 切回来眼前这条就算看过了
  if (!doneWhileAway) return;
  const n = doneWhileAway;
  doneWhileAway = 0;
  syncTitleCount();
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
    const ui = createTurnUI(t[lastUser].text, t[lastUser].mode, sid, t[lastUser].shown);
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

async function runTurn(sid, text, mode, regen, shown) {
  if (runningSessions.has(sid)) { qOf(sid).push({ text, mode }); if (sid === sessionId) renderQueueBar(); return; }
  const ui = createTurnUI(text, mode, sid, shown);
  runningSessions.set(sid, { ui });
  updateSendUI();
  if (sid === sessionId) scrollBottom(true);

  const rc = makeRecCounter();
  let sawDone = false, netErr = null;
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, message: text, ...(shown ? { shown } : {}), mode, regen: !!regen, lane: laneOfSession(sessions.find(x => x.id === sid)), lang: typeof I18N !== "undefined" ? I18N.getLang() : "zh" }),
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
    await renderSettings(subTab || "models"); // 等面板画完再返回：checkUpdate 要接着点关于页里的按钮
  }
}

// ================= 快捷键引擎 =================
// 默认键里的 Mod = 这台机器的主修饰键：mac 上是 ⌘（metaKey），Windows/Linux 上是 Ctrl（ctrlKey）。
// 以前默认键写死 Meta+X，而 Windows/Linux 上的 Meta 是 Win 键，默认快捷键在那边全部按不出来。
// 用户自己录的键一律存成具体的 Meta/Ctrl（accelFromEvent 只产出这两个），老存档里的 Meta+X 原样认。
// 这两个常量别挪进下面 SHORTCUT_DEFS 的方括号里：e2e 的 auditShortcuts 把那张表单独切出来放 vm 里跑，那儿没有 navigator
const SC_PLATFORM = (() => {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  return String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || "");
})();
const SC_MAC = /mac|iphone|ipad|ipod/i.test(SC_PLATFORM);
// [id, 名称, 默认键, 固定?, 系统级?]；用户改绑存 config.shortcuts（只存改过的项）
// 默认键写成「mac 那份|其他平台那份」时按平台二选一：只有全屏那条这么写——
// mac 惯例 ⌃⌘F 改成 Ctrl+Mod+F 的话，到 Windows 上会塌成 Ctrl+F，跟对话内搜索撞车；那边的惯例是 F11
const SHORTCUT_DEFS = [
  ["open-settings", "打开设置", "Mod+Comma"],
  ["chat-search", "对话内搜索", "Mod+F"],
  ["send", "发送消息", "Enter", true],
  ["newline", "输入时换行", "Shift+Enter", true],
  ["new-chat", "新建对话", "Mod+N"],
  ["stop", "让我停下 / 关闭弹层", "Escape"],
  ["prev-task", "上一个任务", "Mod+BracketLeft"],
  ["next-task", "下一个任务", "Mod+BracketRight"],
  ["toggle-sidebar", "切换左侧栏", "Mod+B"],
  ["toggle-files", "切换右侧产物面板", "Shift+Mod+B"],
  ["fullscreen", "进入/退出全屏", "Ctrl+Meta+F|F11"],
  ["toggle-window", "唤起/隐藏主窗口", "Shift+Alt+W", false, true],
  ["open-skills", "打开技能广场", "Shift+Mod+K"],
  ["open-experts", "打开专家团", "Shift+Mod+E"],
  ["open-prompts", "打开参考模板库", "Shift+Mod+P"],
  ["open-library", "打开资料库", "Shift+Mod+L"],
  ["open-sched", "打开定时任务", "Shift+Mod+T"],
  ["open-assistant", "打开本地助理", "Shift+Mod+A"],
  ["next-attn", "跳到下一条等你的", "Alt+Mod+U"],
];
/** 归一成「Ctrl+Alt+Shift+Meta+键」：Mod 和「mac|其他」在这里就按平台落成具体的键，比对、查冲突、存盘都只见具体的 */
function canonAccel(a) {
  let s = String(a || "");
  if (s.includes("|")) s = s.split("|")[SC_MAC ? 0 : 1] || "";
  const mods = [], keys = [];
  for (const p of s.split("+").map(x => x.trim()).filter(Boolean)) {
    const m = { mod: SC_MAC ? "Meta" : "Ctrl", meta: "Meta", cmd: "Meta", command: "Meta", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift" }[p.toLowerCase()];
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
/**
 * Windows 上 AltGr 就是 Ctrl+Alt：波兰（程序员）、匈牙利布局 AltGr+U 打 €，德语 AltGr+Q 打 @，
 * 跟 Ctrl+Alt+U / Ctrl+Alt+Q 是同一个按键事件。这一下打出了别的字（key 不是这颗键本来的字母、数字）就是在打字
 */
function scAltGrText(e) {
  if (SC_MAC || !e.ctrlKey || !e.altKey || e.metaKey) return false;
  const k = String(e.key || "");
  if (Array.from(k).length !== 1) return false; // Dead、Unidentified、F1 这类不是在打字
  const base = /^(?:Key|Digit)(.)$/.exec(e.code || "");
  return base ? k.toLowerCase() !== base[1].toLowerCase() : !!(e.getModifierState && e.getModifierState("AltGraph"));
}
function accelDisplay(a) {
  const KEY = { Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]", Escape: "Esc", Enter: "⏎", Space: "空格", Minus: "-", Equal: "=", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`" };
  const parts = canonAccel(a).split("+");
  if (SC_MAC) {
    const MOD = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
    // mac 习惯顺序 ⌃⌥⇧⌘
    const mods = ["Ctrl", "Alt", "Shift", "Meta"].filter(m => parts.includes(m)).map(m => MOD[m]);
    return mods.join("") + parts.filter(p => !MOD[p]).map(p => KEY[p] || p).join("");
  }
  // Windows/Linux 不认 ⌘⌃ 这些符号，写成文字用 + 连（Ctrl+Shift+B）；Meta 在这边是 Win 键（Linux 叫 Super）
  const MOD = { Meta: /win/i.test(SC_PLATFORM) ? "Win" : "Super", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift" };
  const mods = ["Meta", "Ctrl", "Alt", "Shift"].filter(m => parts.includes(m)).map(m => MOD[m]);
  return mods.concat(parts.filter(p => !MOD[p]).map(p => p === "Enter" ? "Enter" : (KEY[p] || p))).join("+");
}
let toastTimer = null;
// 仓库里的调用一律走第二个参数 toast(文字, "circle-x") 指定图标。
// 这张表是给外来调用兜底的：插件、技能里的老写法可能还在往消息前面塞 ❌ / ⚠️，
// 认出来就摘掉换成图标，免得表情漏到界面上。
/* emoji-数据区 起：这五个表情在这儿是要认的数据、不是界面文案，删了兼容层就认不出老写法 */
const TOAST_ICON = { "❌": "circle-x", "⚠️": "triangle-alert", "⚠": "triangle-alert", "✅": "circle-check", "✓": "circle-check" };
/* emoji-数据区 止 */
/** onAct 给了就是一条带去处的提示：整条能点，点了先收起再去（「某某在等你回答，点这里过去」） */
function toast(msg, kind, onAct) {
  let t = document.getElementById("owb-toast");
  if (!t) { t = document.createElement("div"); t.id = "owb-toast"; t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
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
  // 每条都重设：上一条的去处不能挂到下一条普通提示上
  const hide = () => { t.classList.remove("show"); t.removeAttribute("tabindex"); };
  t.onclick = onAct ? () => { clearTimeout(toastTimer); hide(); onAct(); } : null;
  t.classList.toggle("act", !!onAct);
  // 带去处的那条当按钮用：Tab 停得住、回车能点、读屏念得出。普通提示摘掉，收起来的提示不许留个 Tab 站
  if (onAct) markActivatable(t);
  else { t.removeAttribute("tabindex"); t.removeAttribute("role"); delete t.dataset.activate; }
  // 鼠标或焦点停在上面就不收，挪开再给 2.2 秒
  t.onmouseenter = t.onfocus = onAct ? () => clearTimeout(toastTimer) : null;
  t.onmouseleave = t.onblur = onAct ? () => { clearTimeout(toastTimer); toastTimer = setTimeout(hide, 2200); } : null;
  t.classList.add("show");
  clearTimeout(toastTimer);
  // 长消息（多半是报错原因）多留一会儿，2.2 秒读不完一句「分字段「*/0」的步长必须 ≥ 1」；
  // 带去处的留 8 秒：2.2 秒够读字，不够伸手
  toastTimer = setTimeout(hide, onAct ? 8000 : Math.min(6000, Math.max(2200, text.length * 120)));
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
    // 引用卡片钉在输入框上，Esc 先撤它——但只在光标真在框里的时候。
    // 不加这个前提的话，任务跑着、人想按 Esc 叫停，结果只是把引用撤了，任务照跑
    else if (pendingQuote && document.activeElement === inputEl) clearQuote();
    else if (curBusy()) stopTask();
    else if (pendingQuote) clearQuote();
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
  "next-attn": () => nextAttn(),
};
document.addEventListener("keydown", (e) => {
  if (window.__scRebinding) return; // 设置页改绑捕获中，不触发动作
  const acc = accelFromEvent(e);
  if (!acc) return;
  const canon = canonAccel(acc);
  const inText = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || "") || e.target.isContentEditable;
  if (inText && scAltGrText(e)) return; // 输入框里 AltGr 打字：让字进框，不抢成快捷键
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
    bar.innerHTML = `<input id="cs-input" placeholder="搜索对话内容…"><span id="cs-count" style="color:var(--owb-text-3);font-size: 13px;white-space:nowrap"></span><button id="cs-prev" title="上一个">${ic("chevron-up")}</button><button id="cs-next" title="下一个">${ic("chevron-down")}</button><button id="cs-close" title="关闭 (Esc)">${ic("x")}</button>`;
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
  if (d) attnSyncAsks("approval", list); // 请求失败别当成「全批完了」，标题上的数会闪一下没了又回来
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
  // 还是那几条就别重画：命令原文现在整条给、框里能滚，每 3 秒重画一次，人往下翻到一半就被弹回顶上
  const sig = JSON.stringify([list.map(a => a.id), apCanAlways]);
  if (bar.dataset.sig === sig) return;
  bar.dataset.sig = sig;
  // ruleKey 为空 = 这次拦截的理由不适合被记住（碰了文件黑名单那种），只给「本次允许」
  bar.innerHTML = list.map(a => `
    <div class="ap-row">
      <div class="ap-main">
        <div class="ap-head">${ic("shield")}${esc(a.kind)}待审批${a.source ? ` · <span class="ap-src" title="发起审批的任务">来自「${esc(a.source)}」</span>` : ""}${a.rule ? ` · <span class="ap-why">${esc(a.rule)}</span>` : ""}${a.deadline > 0 ? `<span class="ap-left" data-dl="${Number(a.deadline) - (Number(d.now) || Date.now()) + Date.now()}"></span>` : ""}</div>
        <code class="ap-cmd" style="white-space:pre-wrap;word-break:break-all;max-height:7.5em;overflow:auto">${esc(a.text)}</code>
        ${a.seg && a.seg !== a.text ? `<div class="ap-why" style="word-break:break-all">触发的是这一段：<code>${esc(a.seg)}</code></div>` : ""}
        ${a.detail ? `<pre class="ap-diff">${paintDiff(a.detail)}</pre>` : ""}
      </div>
      <div class="ap-btns">
        <button class="ap-ok" data-id="${esc(a.id)}" data-scope="once">本次允许</button>
        ${a.ruleKey ? `<button class="ap-ok2" data-id="${esc(a.id)}" data-scope="session" title="本次运行期间不再问「${esc(a.ruleKey)}」">本会话一直允许</button>` : ""}
        ${a.persistable && apCanAlways ? `<button class="ap-ok2" data-id="${esc(a.id)}" data-scope="always" title="把「${esc(a.ruleKey)}」写进放行名单，重启也生效">一直允许</button>` : ""}
        <button class="ap-no" data-id="${esc(a.id)}">拒绝</button>
      </div>
    </div>`).join("");
  apTick();
  if (!apTimer) apTimer = setInterval(apTick, 1000);
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
      delete bar.dataset.sig; // 按钮刚才全禁用了，得重画一遍才点得动
      pollApprovals();
      return;
    }
    if (allow && r.downgraded) toast(`已允许，本次运行期间不再问「${r.ruleKey}」。${r.reason || "永久放行需平台管理员设置"}`);
    else if (allow && r.scope === "always" && r.ruleKey) toast(`已永久放行「${r.ruleKey}」（可在 设置 → 安全中心 的放行名单里删掉）`);
    else if (allow && r.scope === "session" && r.ruleKey) toast(`本次运行期间不再问「${r.ruleKey}」`);
    pollApprovals();
  });
}
/**
 * 审批条每条后面那个「m:ss 后自动拒绝」。以前人只知道「会超时」，不知道还剩几秒——
 * 去隔壁窗口查个路径回来，发现早就按拒绝收场了，任务白跑半截。
 * 这里不自己去拒：钟在服务端，本机只照它给的截止时刻（已按服务器的钟校正过）倒着数。
 * 条上一条都没有了，定时器自己停。
 */
let apTimer = null;
function apTick() {
  const els = document.querySelectorAll("#approval-bar .ap-left[data-dl]");
  if (!els.length) { clearInterval(apTimer); apTimer = null; return; }
  for (const el of els) {
    const left = Math.max(0, Math.round((Number(el.dataset.dl) - Date.now()) / 1000));
    el.textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 后自动拒绝` : "已自动拒绝";
    el.classList.toggle("hot", left <= 30);
  }
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
 *  挤在一个 116px 高的框里翻—— */
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
        需要密码确认；历史会话和用量都会保留，不用重新登录。</div>
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
    } else { msg.style.color = "var(--owb-err-text)"; msg.textContent = r.error || "保存失败"; }
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
    } else { msg.style.color = "var(--owb-err-text)"; msg.textContent = r.error || "改不动"; }
  };
}
function renderUserChip() {
  const row = document.getElementById("user-row"), chip = document.getElementById("user-chip");
  if (!currentUser) { row.style.display = "none"; return; }
  row.style.display = "flex";
  const av = avatarBits(currentUser.avatar, currentUser.username);
  chip.innerHTML = `<span class="ava${av.cls ? " " + av.cls : ""}">${av.html}</span>`
    + `<span class="un">${esc(displayName(currentUser))}${currentUser.role === "member" ? "" : " · " + esc(currentUser.role_label || "")}</span>`
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
function getTheme() { const t = lookRead("owb-theme"); return THEME_LABEL[t] ? t : "system"; }
function applyTheme() {
  const t = getTheme();
  document.documentElement.dataset.theme = t === "dark" || (t === "system" && themeMedia.matches) ? "dark" : "light";
}
themeMedia.addEventListener("change", applyTheme);
function setTheme(t) { if (!THEME_LABEL[t]) return; lookWrite("owb-theme", t); applyTheme(); }
applyTheme();
// 皮肤 = 只换品牌色那一组 token（主色/描边/弱底/品牌文字/渐变），版式不动；字号 = 正文 15px 的四档，其余尺寸按 calc 跟着走
const LOOK_OPTS = {
  skin: { default: "默认紫", ocean: "海盐", forest: "森林", sunset: "暖橙", rose: "玫瑰", graphite: "石墨" },
  fs: { s: "小", m: "标准", l: "大", xl: "特大" },
  font: { system: "系统", serif: "衬线", mono: "等宽" },
  density: { cozy: "舒适", compact: "紧凑" },
};
const LOOK_DEFAULT = { skin: "default", fs: "m", font: "system", density: "cozy" };
function lookGet(k) { const v = lookRead("owb-look-" + k); return LOOK_OPTS[k] && LOOK_OPTS[k][v] ? v : LOOK_DEFAULT[k]; }
function applyLook() {
  const ds = document.documentElement.dataset;
  for (const k of Object.keys(LOOK_OPTS)) {
    const v = lookGet(k);
    if (v === LOOK_DEFAULT[k]) delete ds[k]; else ds[k] = v;
  }
}
function setLook(k, v) { if (!LOOK_OPTS[k] || !LOOK_OPTS[k][v]) return; lookWrite("owb-look-" + k, v); applyLook(); }
applyLook();

// ---------- 头像菜单：个人资料 / 修改密码 / 设置 / 语言 / 桌面宠物 / 外观 / 帮助与反馈 / 检查更新 / 退出登录 ----------
const userMenu = document.getElementById("user-menu");
function closeUserMenu() { userMenu.classList.remove("show"); }
function toggleUserMenu() { userMenu.classList.contains("show") ? closeUserMenu() : openUserMenu(); }
/**
 * 头像菜单里的桌面宠物快切。
 *
 * 这只宠物默认是关着的，而原来唯一的开关埋在 设置 → 助理 那一屏往下滚的一张卡里：
 * 想让它出来陪一会儿、或者开会前让它消失，都得翻三层。开关存在但找不到，等于没有。
 *
 * 纯服务端模式（npm start）压根没有桌面窗口，这一行整个不画——开了也不会有东西出现，
 * 一个点了没反应的开关比没有更伤人。那种情况下设置页那张卡照旧在，那儿写得下为什么。
 */
function petMenuRowHtml(lang) {
  const p = (settingsCache && settingsCache.pet) || null;
  if (!p || p.available !== true) return "";
  const on = p.enabled === true; // 默认关：拿不准的时候按「没有宠物」画，不许画一个反的
  return `<div class="um-i um-pet" data-act="pet" title="桌面角落那只，点一下就出现 / 消失"><span>${ic("cat")}显示桌面宠物</span><span class="um-seg" data-i18n-skip role="group" aria-label="桌面宠物">${[["1", on, lang === "zh" ? "开" : "On"], ["0", !on, lang === "zh" ? "关" : "Off"]].map(([v, sel, txt]) =>
    `<button type="button" data-pet="${v}" class="${sel ? "on" : ""}" aria-pressed="${sel}">${txt}</button>`).join("")}</span></div>`;
}
function openUserMenu() {
  if (!currentUser) return;
  const av = avatarBits(currentUser.avatar, currentUser.username);
  const i18n = typeof I18N !== "undefined" ? I18N : null; // 测试夹具里可能没挂词典
  const lang = i18n ? i18n.getLang() : "zh";
  userMenu.innerHTML = `
    <div class="um-head" data-act="account" title="点击查看用量明细">
      <span class="ava${av.cls ? " " + av.cls : ""}" style="width:30px;height:30px;border-radius:50%;background:var(--owb-brand-grad);color:#fff;display:flex;align-items:center;justify-content:center;font-size: 15px;font-weight:600;flex:none;overflow:hidden">${av.html}</span>
      <div style="min-width:0"><div class="n">${esc(displayName(currentUser))}${currentUser.role === "member" ? "" : " · " + esc(currentUser.role_label || "")}</div>
      <div class="s">${creditsOn ? `${ic("sparkles")}${(+currentUser.credits).toLocaleString()} 积分 · ` : ""}账号与用量</div></div>
    </div>
    <div class="um-i" data-act="profile">${ic("id-card")}个人资料</div>
    <div class="um-i" data-act="password">${ic("key-round")}修改密码</div>
    <div class="um-i" data-act="settings">${ic("settings")}设置</div>
    ${currentUser.can_admin
      ? `<div class="um-i" data-act="admin">${ic("building-2")}企业管理后台${currentUser.is_admin ? "" : ` <span class="hint">只读</span>`}</div>`
      : ""}
    ${i18n ? `<div class="um-i um-lang" data-act="lang" title="点一下就切换界面语言，AI 回复也跟着换"><span>${ic("globe")}语言</span><span class="um-seg" data-i18n-skip role="group" aria-label="界面语言">${Object.keys(i18n.LANGS).map((v) =>
      `<button type="button" data-lang="${v}" class="${lang === v ? "on" : ""}" aria-pressed="${lang === v}">${v === "zh" ? "中" : "En"}</button>`).join("")}</span></div>` : ""}
    ${petMenuRowHtml(lang)}
    <div class="um-i" data-act="appearance">${ic("palette")}外观</div>
    <div class="um-i" data-act="help">${ic("message-circle")}帮助与反馈</div>
    <div class="um-i" data-act="update">${ic("refresh-cw")}检查更新</div>
    <div class="um-i" data-act="logout" style="color:var(--owb-err-text)">${ic("log-out")}退出登录</div>`;
  userMenu.querySelectorAll("[data-act]").forEach(el => el.onclick = async (e) => {
    e.stopPropagation();
    const act = el.dataset.act;
    if (act === "pet") {
      // 跟语言行一样不关菜单：点「开 / 关」按钮选定，点行的其它地方就在两者间翻
      const p = (settingsCache && settingsCache.pet) || null;
      if (!p) return;
      const b = e.target.closest("button[data-pet]");
      const cur = p.enabled === true;
      const next = b ? b.dataset.pet === "1" : !cur;
      if (next === cur) return; // 已经是这一档了，别白跑一趟服务端
      p.enabled = next; // 先把界面翻过去：这一下要立刻有反馈，存盘那一趟慢一点没关系
      openUserMenu();
      const saved = typeof saveSettings === "function" && await saveSettings({ pet: { enabled: next } });
      // 存不下就翻回来。界面上停着一个服务端并不认的状态，比当场报错更糟：
      // 他以为关掉了，下次开机那只还在桌面上。（saveSettings 自己会弹红字，这儿不重复喊）
      if (!saved && settingsCache && settingsCache.pet) settingsCache.pet.enabled = cur;
      if (userMenu.classList.contains("show")) openUserMenu();
      return;
    }
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
    else if (act === "password") { await openModal("account"); renderPassword(); }
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

// 正文里 [文字](报告.md) 这类指向工作区文件的链接（事件委托，历史回放与流式渲染共用）。
// renderMd 是拼字符串出来的，挂不上 onclick；而 makeFileLink 造的那一批走的是自己那只 onclick，
// 所以这儿只认带 data-md 的，免得同一下点出两次预览。
function openMdFileLink(a) {
  if (typeof previewFile === "function") previewFile(a.dataset.name, a.dataset.root || "");
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.file-ln[data-md]");
  if (!a) return;
  e.preventDefault();
  openMdFileLink(a);
});
// 键盘也得能开：这些 a 没有 href，浏览器不会自己把回车当点击
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const a = e.target.closest && e.target.closest("a.file-ln[data-md]");
  if (!a) return;
  e.preventDefault();
  openMdFileLink(a);
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
 * 401/413/500、请求挂着一直不回。用户看到的永远是那五个字，连往哪儿查都不知道。
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
 *
 * saveAs=true 走系统保存框，自己挑地方；网页端没这能力就退回浏览器下载。
 */
async function saveInlineFile(name, content, btn, saveAs) {
  const dir = sessionDirs.get(sessionId) || "";
  const { data: r, why } = await postJson(saveAs ? "/api/files/save-as" : "/api/files/save", { name, content, dir }, 120000);
  if (saveAs && r && r.canceled) return; // 用户自己点的取消，别再弹一条「失败」吓人
  if (saveAs && r && r.no_dialog) {
    browserDownload(name, content);
    flashBtn(btn, "已下载");
    return toast("已交给浏览器下载");
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

/**
 * 头像菜单「检查更新」。以前走 POST /api/app/update-check，那条是拿 git 数提交的：
 * 装包用户没有 .git，永远报不出新版。现在跟关于页同一条路——GET /api/update?force=1（查 GitHub Releases），
 * 结果交给关于页的 drawUpdate 画：版本号、有没有新版、这种装法怎么升、去下载页，一处都不少。
 * drawUpdate / loadUpdate 是 renderAboutPane 里的闭包，外面摸不着，所以这里打开关于页、按它自己那颗「检查更新」
 * （#ab-up-btn → loadUpdate(true) → /api/update?force=1 → drawUpdate）。
 * 更干净的做法是 renderAboutPane 自己收一个 force 选项，那得改 app-06，留给它的负责人。
 */
async function checkUpdate() {
  toast("正在检查更新…");
  try { await openModal("settings", "about"); } catch {}
  const btn = document.getElementById("ab-up-btn");
  if (!btn) return toast("设置页没打开，这次没查更新", "circle-x");
  // 关于页一打开就先按缓存问一次（不带 force）。等那一问落了地再按按钮：两问并发的话，缓存那份先回来，
  // 顺手把「查询中…」抹掉——强查还在路上，用户看到的却是缓存结论，以为已经查完了。
  // 落地 = 版本号那格变了（画出来了），或者消息那格出了字（报错了）。最多等 3 秒，缓存命中正常几毫秒就回
  const ver = document.getElementById("ab-ver"), msg = document.getElementById("ab-up-msg");
  if (ver && msg) {
    const v0 = ver.textContent, landed = () => ver.textContent !== v0 || !!msg.textContent;
    if (!landed()) await new Promise((res) => {
      const mo = new MutationObserver(() => { if (landed()) fin(); });
      const timer = setTimeout(fin, 3000);
      function fin() { mo.disconnect(); clearTimeout(timer); res(); }
      mo.observe(btn.parentNode, { childList: true, characterData: true, subtree: true });
    });
  }
  btn.click();
}
const SRC_TXT = { web: "网页", cli: "CLI", im: "IM", schedule: "定时" };

// ================= ＋ 菜单：一个入口，装下六件常干的事 =================
/**
 *
 * 在这之前，这六件事分散在六个地方：上传是输入框左边那枚回形针；模式在快捷栏最右；
 * 专家和技能要先跳到「专家·技能·连接器」页，回来时对话已经翻页了；连接器只能去那一页开关；
 * 而「模型现在到底有哪些工具」——**界面上根本没有**，只能问它一次，等它答「我没配发信通道」。
 *
 * 现在一个 ＋ 全兜住。一级只有六行字，二级从右边飞出来一块 300px 的板子摆清单：
 * 一级不会被二级撑变形，来回切二级也不跳宽度。
 *
 * 三条规矩，都是踩过的坑：
 *   1. 清单一律现取，不存第二份 —— 模式表当年抄成三份，goal 只抄进了两份；
 *   2. 每行「名字一行、说明一行」，各自单行截断 ——说的就是
 *      长说明在窄菜单里一个字一个字换行；
 *   3. 工具那一屏直接问服务端要 runtime.toolList() 算出来的那一份，摆出来的就是模型看见的。
 */
const plusMenu = setupPicker("attach-btn", "plus-menu");
const PLUS_TABS = [
  ["file", "paperclip", "添加文件"],
  ["mode", "circle-check", "模式"],
  ["expert", "user", "专家"],
  ["skill", "puzzle", "技能"],
  ["tool", "wrench", "工具"],
  ["mcp", "plug", "连接器"],
];
let plusOpen = "";      // 当前展开的二级，"" = 没展开
let plusSkillQ = "";    // 技能那一屏的搜索词，关掉菜单才清

/** 在光标处插一段文字（＋ 菜单里点文件 = 在正文里放一个 @引用） */
function plusInsert(text) {
  const pos = inputEl.selectionStart;
  inputEl.value = inputEl.value.slice(0, pos) + text + " " + inputEl.value.slice(inputEl.selectionEnd);
  const at = pos + text.length + 1;
  inputEl.setSelectionRange(at, at);
  inputEl.focus();
  syncInputHl();
}

function plusClose() {
  plusOpen = ""; plusSkillQ = "";
  plusMenu.classList.remove("show");
}

/** 一条二级条目：图标 + 名字 + 一行说明（两行各自截断），右边可挂状态或开关 */
function plusItem(icon, name, desc, opt = {}) {
  const a = [`class="pm-it${opt.on ? " on" : ""}${opt.ro ? " ro" : ""}"`];
  if (opt.act) a.push(`data-act="${esc(opt.act)}"`);
  if (opt.val !== undefined) a.push(`data-val="${esc(String(opt.val))}"`);
  a.push(`title="${esc(name + (desc ? " — " + desc : ""))}"`);
  return `<div ${a.join(" ")}>${ic(icon)}
    <span class="pm-name${opt.mono ? " pm-mono" : ""}">${esc(name)}</span>
    <span class="pm-desc">${esc(desc || "")}</span>
    ${opt.right ? `<span class="pm-right">${opt.right}</span>` : ""}</div>`;
}
const plusEmpty = (t) => `<div class="pm-empty">${esc(t)}</div>`;
const plusHead = (t) => `<div class="pm-h">${esc(t)}</div>`;
const plusFoot = (rows) => `<div class="pm-foot">${rows}</div>`;

/** 画一级。二级那块板子挂在最后一行后面，位置靠 CSS 定死，不随行数变 */
function renderPlusRoot() {
  plusMenu.innerHTML = PLUS_TABS.map(([k, icon, label]) =>
    `<div class="pm-row${plusOpen === k ? " on" : ""}" data-tab="${k}">${ic(icon)}<span class="pm-t">${esc(label)}</span>${ic("chevron-right", "i-sm")}</div>`).join("") +
    `<div class="pm-sub" id="pm-sub"></div>`;
  plusMenu.querySelectorAll(".pm-row").forEach((row) => {
    const open = () => openPlusSub(row.dataset.tab);
    row.onmouseenter = open;
    row.onclick = (e) => { e.stopPropagation(); open(); };
  });
  if (plusOpen) openPlusSub(plusOpen);
}

/** 二级放不下就翻到左边去。量完再翻，不靠猜窗口宽度 */
function plusFit(sub) {
  sub.classList.remove("flip");
  const r = sub.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) sub.classList.add("flip");
}

async function openPlusSub(tab) {
  plusOpen = tab;
  plusMenu.querySelectorAll(".pm-row").forEach((r) => r.classList.toggle("on", r.dataset.tab === tab));
  const sub = plusMenu.querySelector("#pm-sub");
  if (!sub) return;
  sub.classList.add("show");
  sub.onclick = (e) => e.stopPropagation(); // 二级里点东西不该顺手把整个菜单关了
  sub.innerHTML = plusHead("读取中…");
  plusFit(sub);
  try {
    await PLUS_RENDER[tab](sub);
  } catch (e) {
    sub.innerHTML = plusEmpty("这一屏没打开：" + (e && e.message ? e.message : "接口没响应"));
  }
  plusFit(sub);
}

const PLUS_RENDER = {
  // ---------- 添加文件：上传一个，或引用工作空间里已有的 ----------
  async file(sub) {
    refreshFilesCache();
    const files = (filesCache || []).slice(0, 8);
    // 名字只显示最后一段，目录名让给说明那一行。
    // 一屏八行全叫「任务_0918_帮我做一个『openwor…」是真发生过的：任务目录名本身就有二十几个字，
    // 整条路径塞进 300px 再从尾巴截断，八行长得一模一样，等于没有列表。
    sub.innerHTML = plusHead("添加文件") +
      `<div class="pm-list">` +
      plusItem("upload", "从电脑上传…", "传进工作空间，任务里直接能用", { act: "upload" }) +
      (files.length
        ? files.map((f) => {
            const seg = String(f.name).split("/");
            const base = seg.pop();
            const dir = seg.length ? seg.join("/") : "工作空间根目录";
            return plusItem(fileIcon(f.name), base, `${dir} · ${fmtSize(f.size || 0)}`, { act: "ref", val: f.name });
          }).join("")
        : plusEmpty("工作空间还没有文件。传一个，或者直接把文件拖进窗口。")) +
      `</div>`;
    sub.querySelectorAll(".pm-it").forEach((it) => (it.onclick = (e) => {
      e.stopPropagation();
      if (it.dataset.act === "upload") document.getElementById("file-input").click();
      else plusInsert("@" + it.dataset.val);
      plusClose();
    }));
  },

  // ---------- 模式：跟快捷栏那个下拉同一份表（/api/modes），不另抄 ----------
  async mode(sub) {
    if (!execModes.length) await loadExecModes();
    sub.innerHTML = plusHead("这次任务怎么跑") +
      `<div class="pm-list">${execModes.length
        ? execModes.map((m) => plusItem(m.icon, m.label, m.sub, { val: m.id, on: m.id === currentMode })).join("")
        : plusEmpty("模式表没取到（服务端没响应），当前按默认模式跑")}</div>`;
    sub.querySelectorAll(".pm-it").forEach((it) => (it.onclick = (e) => {
      e.stopPropagation(); setMode(it.dataset.val); plusClose();
    }));
  },

  // ---------- 专家 / 专家团：点一下挂一枚标签，不是往输入框灌一句话 ----------
  async expert(sub) {
    const [exps, teams] = await Promise.all([
      fetch("/api/experts").then((r) => r.json()).catch(() => []),
      fetch("/api/expert-teams").then((r) => r.json()).catch(() => []),
    ]);
    const ex = Array.isArray(exps) ? exps : [], tm = Array.isArray(teams) ? teams : [];
    sub.innerHTML = plusHead("把这件事交给谁") +
      `<div class="pm-list">${
        (tm.length ? tm.map((t) => plusItem(t.avatar || "users", t.name,
          t.description || `${(t.members || []).length} 人接力`, { act: "team", val: t.name })).join("") : "") +
        (ex.length ? ex.map((e) => plusItem(e.avatar || "user", e.name,
          e.description || e.category || "", { act: "expert", val: e.name })).join("") : "")
      }${ex.length || tm.length ? "" : plusEmpty("还没有专家。去「专家 · 技能 · 连接器」里建一个，它就是一份写死的角色设定。")}</div>` +
      plusFoot(plusItem("settings", "管理专家与专家团", "新建、改设定、组团", { act: "manage" }));
    sub.querySelectorAll(".pm-it").forEach((it) => (it.onclick = (e) => {
      e.stopPropagation();
      if (it.dataset.act === "manage") { plusClose(); return openHub("team"); }
      setUseTag({ kind: it.dataset.act, name: it.dataset.val });
      plusClose();
    }));
  },

  // ---------- 技能：带搜索框。技能多起来之后，不给搜就只能一屏屏翻 ----------
  async skill(sub) {
    // 空了就必须拉（不然这一屏是空的），不空就走节流：刚装完就来翻菜单的人得看得见新的
    await refreshSkillsCache(!skillsCache.length);
    const q = plusSkillQ.trim().toLowerCase();
    const list = skillsCache.filter((s) =>
      !q || String(s.name).toLowerCase().includes(q) || String(s.description || "").toLowerCase().includes(q));
    sub.innerHTML = plusHead("按哪份说明书做") +
      `<div class="pm-search">${ic("search", "i-sm")}<input id="pm-skill-q" placeholder="搜索技能" value="${esc(plusSkillQ)}"></div>` +
      `<div class="pm-list">${list.length
        ? list.slice(0, 60).map((s) => plusItem(s.plugin ? "puzzle" : "wrench", s.name,
            s.description || "（这份技能没写说明）", { val: s.name })).join("")
        : plusEmpty(q ? `没有匹配「${plusSkillQ}」的技能` : "还没有技能。装一个或自己写一份。")}</div>` +
      plusFoot(plusItem("settings", "管理技能", "从 GitHub 装、自己写、改正文", { act: "manage" }));
    const box = sub.querySelector("#pm-skill-q");
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.oninput = () => { plusSkillQ = box.value; PLUS_RENDER.skill(sub); };
      box.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); plusClose(); } };
    }
    sub.querySelectorAll(".pm-it").forEach((it) => (it.onclick = (e) => {
      e.stopPropagation();
      if (it.dataset.act === "manage") { plusClose(); return openHub("skills"); }
      setUseTag({ kind: "skill", name: it.dataset.val });
      plusClose();
    }));
  },

  // ---------- 工具：这一刻模型手上到底有哪些 ----------
  async tool(sub) {
    const d = await fetch("/api/tools?mode=" + encodeURIComponent(currentMode || "craft"))
      .then((r) => r.json()).catch(() => null);
    const tools = (d && d.tools) || [];
    if (!tools.length) {
      sub.innerHTML = plusHead("这一刻能用的工具") + plusEmpty("工具表没取到（服务端没响应）");
      return;
    }
    // 按来源分组：内置一组，每台连接器各一组。连接器工具的名字是 mcp__服务器__工具，
    // 分组标题已经写了服务器名，行里只留后半截，不然一屏全是重复的前缀
    const secs = [["内置工具", tools.filter((t) => t.source === "builtin")]];
    for (const name of [...new Set(tools.filter((t) => t.source === "mcp").map((t) => t.server))]) {
      secs.push([`连接器 ${name}`, tools.filter((t) => t.server === name)]);
    }
    sub.innerHTML = plusHead(`这一刻能用的工具 · 共 ${tools.length} 个`) +
      `<div class="pm-list">${secs.filter(([, l]) => l.length).map(([label, l]) =>
        `<div class="pm-h">${esc(label)} · ${l.length}</div>` + l.map((t) => plusItem(
          t.source === "mcp" ? "plug" : (TOOL_ICON[t.name] || "wrench"),
          t.source === "mcp" ? t.short : (TOOL_SHORT[t.name] ? `${TOOL_SHORT[t.name]}（${t.name}）` : t.name),
          t.description, { ro: true, mono: t.source === "mcp" })).join("")).join("")}</div>` +
      plusFoot(plusItem("shield", "关掉其中一些", "命令行、联网这些能整类关掉，在 安全 里", { act: "sec" }));
    sub.querySelectorAll('.pm-it[data-act="sec"]').forEach((it) => (it.onclick = (e) => {
      e.stopPropagation(); plusClose(); openModal("settings", "security");
    }));
  },

  // ---------- 连接器：开关 + 为什么连不上 ----------
  async mcp(sub) {
    const d = await fetch("/api/mcp").then((r) => r.json()).catch(() => null);
    const list = (d && d.servers) || [];
    const canToggle = !d || d.can_toggle !== false;
    // 右边那一格说的是「现在什么状态」，四种情况分得清清楚楚：
    // 我自己关的 / 授权没了（要去换 Key）/ 连不上（多半等会儿就好）/ 连上了几个工具
    const state = (m) => {
      if (!m.enabled) return `<span class="pm-desc">已关闭</span>`;
      if (m.auth_bad) return `<span class="pm-bad">授权已过期</span>`;
      if (m.error) return `<span class="pm-bad">连不上</span>`;
      return `<span class="pm-desc">${m.tools.length} 个工具</span>`;
    };
    sub.innerHTML = plusHead(`连接器${d && d.total_tools ? ` · 已注入 ${d.total_tools} 个工具` : ""}`) +
      `<div class="pm-list">${list.length
        ? list.map((m) => plusItem(m.plugin ? "puzzle" : "plug", m.name,
            m.error || (m.plugin ? `来自插件 ${m.plugin}` : (m.url || m.command || "")), {
              val: m.name,
              right: state(m) + `<button class="pm-sw${m.enabled ? " on" : ""}" data-sw="${esc(m.name)}"${
                canToggle ? "" : " disabled"} title="${m.enabled ? "关掉它" : "打开它"}" aria-label="${esc(m.name)}"></button>`,
            })).join("")
        : plusEmpty("还没接连接器。连接器是把别人家的工具接进来——飞书、GitHub、数据库这些。")}</div>` +
      plusFoot(plusItem("settings", "管理连接器", "加一台、改参数、看它到底提供了哪些工具", { act: "manage" })) +
      (canToggle ? "" : `<div class="pm-empty">连接器是整台机器一份的，开关归平台管理员。</div>`);
    sub.querySelectorAll('.pm-it[data-act="manage"]').forEach((it) => (it.onclick = (e) => {
      e.stopPropagation(); plusClose(); openHub("mcp");
    }));
    sub.querySelectorAll(".pm-sw").forEach((sw) => (sw.onclick = async (e) => {
      e.stopPropagation();
      const on = !sw.classList.contains("on");
      sw.disabled = true;
      sw.classList.toggle("on", on); // 先动，别让人等一趟握手才看见反馈
      const r = await fetch("/api/mcp/toggle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sw.dataset.sw, enabled: on }),
      }).then((x) => x.json()).catch(() => null);
      if (!r || r.error) {
        sw.classList.toggle("on", !on); sw.disabled = false; // 失败要退回去，不然界面在骗人
        return toast((r && r.error) || "开关没生效：接口没响应", "circle-x");
      }
      toast(on
        ? (r.connected ? `已打开 ${r.name}，现在一共 ${r.total_tools} 个连接器工具` : `${r.name} 打开了，但没连上——点「管理连接器」看原因`)
        : `已关掉 ${r.name}，这一轮不会再去连它`, on && !r.connected ? "triangle-alert" : "circle-check");
      PLUS_RENDER.mcp(sub); // 重画一遍：工具数、状态字都跟着变了
    }));
  },
};

// setupPicker 已经把 .show 切好了（它的 onclick 先注册先跑），这里只管画。
// 每次重新打开都回到一级：上次停在「技能」还带着搜索词，再点开时看见的是半截筛过的清单，
// 会让人以为技能少了几个。
document.getElementById("attach-btn").addEventListener("click", () => {
  plusOpen = ""; plusSkillQ = "";
  if (plusMenu.classList.contains("show")) renderPlusRoot();
});
plusMenu.onclick = (e) => e.stopPropagation(); // 一级里点空白不关菜单；关是靠点外面或选完
