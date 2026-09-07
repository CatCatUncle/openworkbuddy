"use strict";
/**
 * 桌面宠物——桌面角落的一个透明小窗口，把 agent 正在干什么摆到台面上。
 *
 * 默认不存在。用户在对话里说一句「把这张图做成桌面宠物」并传张照片，agent 调 desktop_pet 工具现做一只；
 * 也可以去 设置 → 人设 手动开。不主动出现是刻意的——没人要求就常驻桌面的挂件，在中文用户心智里等同于流氓软件。
 *
 * 为什么值得单开一个窗口：主窗口一被别的应用盖住，任务是死是活就全凭猜；更要命的是
 * agent 用 ask_user 弹了问题，卡片安安静静躺在后台，5 分钟没人答就按默认继续了——
 * 用户的体感是「它从来不问我」。宠物解决的就是这件事：状态一直在眼角余光里，要问你的时候
 * 它会跳起来 + 系统通知 + Dock/任务栏闪，你想不看见都难。
 *
 * 实现上刻意只用 Electron 自带能力：透明无边框窗口 + 一个自包含的 HTML（纯 SVG/CSS 动画），
 * 不引第三方依赖，不落任何素材文件。Windows 同样吃透明窗口，位置记在 userData 里。
 */

const path = require("path");
const { dataPath } = require("./paths");
const sprites = require("./pet-sprites");
const fs = require("fs");

let electron = null;
try { electron = require("electron"); } catch {} // 纯 node 跑 server.js 时整个模块降级成空壳

const PET_W = 168;
const PET_H = 196;

let petWin = null;
let curState = { name: "idle", text: "" };
let idleTimer = null;
let dragTimer = null;
let dragMoved = false;
let ipcBound = false;
let cfg = { enabled: false, scale: 1, opacity: 1, notify: true, notifyDone: true, wander: false, character: "cat", sprite: "" };
let dndUntil = 0;     // 免打扰截止时间戳：只压「要你动手」的提醒，状态显示照常
let lastHit = false;  // 光标当前是不是压在宠物实体上（渲染进程按像素判定后报上来）
let photoCache = { key: "", url: "" }; // 照片按 路径+修改时间 缓存，换了图自动失效
let sheetCache = { key: "", url: "", spec: null }; // 精灵图同理，按 文件+修改时间 缓存
let walkTimer = null, wanderTimer = null, walkDir = "";
let lastFinish = { at: 0, key: "" }; // 完成/出错通知的节流：一轮任务里 error 事件可能来好几条

/**
 * 自定义形象（用户自己或朋友的照片）。走 data URL 直接推给渲染进程，
 * 不给宠物窗口开 HTTP 通道——它是 loadFile 起来的本地页面，接口在登录闸后面，
 * 塞 data URL 是最省事也最不容易出岔子的做法。前端上传前已压到 320px，体积很小。
 */
function photoDataUrl() {
  const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
  for (const ext of [".png", ".jpg", ".webp", ".gif"]) {
    const p = dataPath("data", "pet-avatar" + ext);
    try {
      const st = fs.statSync(p);
      const key = p + ":" + st.mtimeMs;
      if (photoCache.key === key) return photoCache.url;
      const url = `data:${MIME[ext]};base64,` + fs.readFileSync(p).toString("base64");
      photoCache = { key, url };
      return url;
    } catch {}
  }
  photoCache = { key: "", url: "" };
  return "";
}

/**
 * 精灵图宠物：把图集读成 data URL + 一张「我们的状态 → 图集第几行」的表。
 * 图集不小（1536×1872 的 webp 几百 KB），按 文件+修改时间 缓存，别每次推状态都重读重编码。
 * 选了精灵图但那只宠物没了（用户把 ~/.codex/pets 删了）→ 返回空，push() 会老实回落到内置猫。
 */
function spriteBundle() {
  if (cfg.character !== "sprite") { sheetCache = { key: "", url: "", spec: null }; return null; }
  const pet = sprites.findPet(cfg.sprite);
  if (!pet) { sheetCache = { key: "", url: "", spec: null }; return null; }
  let key = pet.sheet;
  try { key += ":" + fs.statSync(pet.sheet).mtimeMs; } catch {}
  if (sheetCache.key !== key) {
    const url = sprites.sheetDataUrl(pet);
    sheetCache = url ? { key, url, spec: sprites.spriteSpec(pet) } : { key: "", url: "", spec: null };
  }
  return sheetCache.url ? sheetCache : null;
}

function posFile() {
  try { return path.join(electron.app.getPath("userData"), "pet-position.json"); } catch { return ""; }
}
function loadPos() {
  try { return JSON.parse(fs.readFileSync(posFile(), "utf8")); } catch { return null; }
}
function savePos() {
  if (!petWin || petWin.isDestroyed()) return;
  try {
    const [x, y] = petWin.getPosition();
    fs.writeFileSync(posFile(), JSON.stringify({ x, y }));
  } catch {}
}

/** 默认停在主屏右下角，离边缘留一点，别贴着 Dock */
function defaultPos(w, h) {
  const { workArea } = electron.screen.getPrimaryDisplay();
  return { x: Math.round(workArea.x + workArea.width - w - 24), y: Math.round(workArea.y + workArea.height - h - 24) };
}
/** 记忆的位置可能来自已拔掉的外接屏：落在任何显示器工作区外就退回默认位置 */
function sanePos(p, w, h) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return defaultPos(w, h);
  const ok = electron.screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return p.x + w > a.x + 40 && p.x < a.x + a.width - 40 && p.y + h > a.y + 20 && p.y < a.y + a.height - 20;
  });
  return ok ? { x: Math.round(p.x), y: Math.round(p.y) } : defaultPos(w, h);
}

function toggleMain() {
  const win = global.__wbWin;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) { win.hide(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function bindIpc() {
  if (ipcBound || !electron) return;
  ipcBound = true;
  const { ipcMain, screen, Menu } = electron;

  // 拖动：不用 -webkit-app-region（拖拽区吞点击，没法区分「拖」和「点」），改成主进程轮询光标。
  // 松手时位移小于阈值就算点击 → 唤起主窗口，大于阈值才算真拖动 → 记住新位置。
  ipcMain.on("pet:drag-start", () => {
    if (!petWin || petWin.isDestroyed() || dragTimer) return;
    stopWalk(); // 你伸手抓它的同时它还在自己走，两边抢位置，拖起来像在打滑
    try { petWin.setIgnoreMouseEvents(false); } catch {} // 拖动全程锁住，光标甩出宠物身体也不能中途穿透
    const start = screen.getCursorScreenPoint();
    const [wx, wy] = petWin.getPosition();
    dragMoved = false;
    dragTimer = setInterval(() => {
      if (!petWin || petWin.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      const dx = p.x - start.x, dy = p.y - start.y;
      if (!dragMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) dragMoved = true;
      if (dragMoved) petWin.setPosition(wx + dx, wy + dy);
    }, 16);
  });
  ipcMain.on("pet:drag-end", () => {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    if (petWin && !petWin.isDestroyed()) try { petWin.setIgnoreMouseEvents(!lastHit, { forward: true }); } catch {}
    if (dragMoved) savePos();
    else toggleMain(); // 没挪动 = 单纯点了它一下
  });
  /**
   * 点击穿透：透明窗口默认是一整个矩形都吃鼠标的，宠物只占中间一小块，
   * 剩下的空白会把底下应用的点击全挡掉——这是桌宠差评第一名。
   * 渲染进程按「光标底下到底压着不压着图形」判定后报上来，这里翻转 ignore。
   * forward:true 是关键：忽略鼠标之后仍然要收到 mousemove，不然光标移回宠物身上就再也醒不过来。
   * 失效方向刻意选「可交互」：渲染进程要是没报或者挂了，窗口就保持能点，最多挡一小块，
   * 而不是变成一个永远点不中的鬼影。
   */
  ipcMain.on("pet:hit", (_e, on) => {
    if (!petWin || petWin.isDestroyed() || dragTimer) return; // 拖动期间锁死，中途穿透会把拖拽打断
    lastHit = !!on;
    try { petWin.setIgnoreMouseEvents(!on, { forward: true }); } catch {}
  });

  ipcMain.on("pet:menu", () => {
    if (!petWin || petWin.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: "打开主窗口", click: () => { const w = global.__wbWin; if (w && !w.isDestroyed()) { w.show(); w.focus(); } } },
      // 用窗口的真实尺寸算，不能用基准尺寸：放大到 200% 时按 168×196 摆位，
      // 会把大半只猫塞到屏幕右下角外面去
      { label: "回到右下角", click: () => { const [w, h] = petWin.getSize(); const p = defaultPos(w, h); petWin.setPosition(p.x, p.y); savePos(); } },
      { type: "separator" },
      dndUntil > Date.now()
        ? { label: `免打扰中（剩 ${Math.ceil((dndUntil - Date.now()) / 60000)} 分钟）· 点此结束`, click: () => { dndUntil = 0; } }
        : { label: "先别烦我", submenu: [
            { label: "30 分钟", click: () => { dndUntil = Date.now() + 30 * 60000; } },
            { label: "1 小时", click: () => { dndUntil = Date.now() + 60 * 60000; } },
          ] },
      { type: "separator" },
      { label: "收起宠物（跟我说一声就能叫回来）", click: () => hide() },
    ]).popup({ window: petWin });
  });
}

function create() {
  if (!electron || !electron.app) return null;
  if (petWin && !petWin.isDestroyed()) return petWin;
  bindIpc();
  const scale = Math.min(2, Math.max(0.6, Number(cfg.scale) || 1));
  const w = Math.round(PET_W * scale), h = Math.round(PET_H * scale);
  const p = sanePos(loadPos(), w, h);
  petWin = new electron.BrowserWindow({
    width: w, height: h, x: p.x, y: p.y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true, // Windows 任务栏 / mac 窗口列表里不占位，它是个挂件不是窗口
    alwaysOnTop: true,
    show: false,
    focusable: false, // 点它不抢走当前应用的焦点（右键菜单和拖动照常）
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "pet-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 被别的窗口盖住时动画和状态照常走
    },
  });
  petWin.setAlwaysOnTop(true, "floating");
  // 跟着所有桌面走，但**不**在全屏应用上露面：开会投屏、放全屏演示时它跳出来就是事故。
  // 那种场景下提醒仍然走系统通知（通知会被系统「专注模式」正常压制），不会真漏掉。
  try { petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false }); } catch {}
  petWin.loadFile(path.join(__dirname, "public", "pet.html"));
  petWin.once("ready-to-show", () => {
    if (!petWin || petWin.isDestroyed()) return;
    petWin.showInactive(); // 不抢焦点地亮相
    try { petWin.setIgnoreMouseEvents(true, { forward: true }); } catch {} // 先整块放行，渲染进程压到实体上会立刻要回来
    push();
    armWander();
  });
  petWin.on("closed", () => { petWin = null; });
  return petWin;
}

function push() {
  if (!petWin || petWin.isDestroyed()) return;
  try {
    const photo = cfg.character === "photo" ? photoDataUrl() : "";
    const sp = spriteBundle();
    petWin.webContents.send("pet:state", {
      ...curState,
      walk: walkDir, // 溜达方向单独走一路：它不该顶掉「在干活 / 要问你」这些真状态
      scale: Number(cfg.scale) || 1,
      opacity: Number(cfg.opacity) || 1,
      // 选了照片/精灵图但文件没了 → 老实回落到猫，别显示个空框
      character: photo ? "photo" : sp ? "sprite" : "cat",
      photo,
      sheet: sp ? sp.url : "",
      sprite: sp ? sp.spec : null,
    });
  } catch {}
}

/**
 * 设置宠物状态。name: idle | working | asking | done | error | sleep
 * text 是一句人话，鼠标悬停时显示（asking 会直接把问题挂在气泡里）。
 */
function setState(name, text) {
  const n = ["idle", "working", "asking", "done", "error", "sleep", "review"].includes(name) ? name : "idle";
  const changed = curState.name !== n;
  curState = { name: n, text: String(text || "").slice(0, 120) };
  if (n !== "idle") stopWalk(); // 有正事了就别再溜达，不然位置一直在动、气泡也跟着飘
  push();
  if (changed && (n === "done" || n === "error")) notifyFinish(n, curState.text);
  clearTimeout(idleTimer);
  // 完成/出错是瞬时表情，几秒后自己回到待机；asking 必须等到有人回答才解除，不设自动过期
  if (n === "done" || n === "error") idleTimer = setTimeout(() => setState("idle", ""), n === "done" ? 6000 : 10000);
}

/**
 * agent 要问用户了：宠物跳 + 系统通知 + Dock 弹跳/任务栏闪。
 * 三路一起上是故意的——用户可能正在另一个全屏应用里，少一路就可能整个漏掉。
 */
function alertAsk(question) {
  setState("asking", question); // 状态显示永远不压制——用户要静的是"提醒"，不是"看不见它在等我"
  if (!electron || !cfg.notify) return;
  if (Date.now() < dndUntil) return; // 免打扰：宠物照样举着问号等你，但不弹通知、不弹 Dock
  const { Notification, app } = electron;
  const win = global.__wbWin;
  try {
    if (win && !win.isDestroyed() && !win.isFocused()) {
      if (process.platform === "darwin" && app.dock) app.dock.bounce("critical");
      else win.flashFrame(true); // Windows/Linux：任务栏图标闪烁，直到用户点进来
    }
  } catch {}
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "OpenWorkBuddy 有个问题要问你",
        body: String(question || "").slice(0, 160) || "任务卡在一个只有你能决定的岔路口",
        silent: false,
      });
      n.on("click", () => { const w = global.__wbWin; if (w && !w.isDestroyed()) { w.show(); w.focus(); } });
      n.show();
    }
  } catch {}
}

/**
 * 任务跑完了/崩了也值得响一声——但只在你没盯着主窗口的时候。
 *
 * 以前只有 ask_user 会通知，于是一个跑二十分钟的任务结束时是完全静默的：
 * 你不主动切回来就不知道它早就好了，宠物那点表情变化在别的应用后面根本看不见。
 * 节流是必须的：一轮任务里 error 事件可能连来好几条（工具失败、模型报错、收尾又报一次），
 * 不掐会连弹三条一模一样的。
 */
function notifyFinish(kind, text) {
  if (!electron || !cfg.notify || !cfg.notifyDone) return;
  if (Date.now() < dndUntil) return;
  const key = kind + ":" + String(text || "").slice(0, 40);
  if (Date.now() - lastFinish.at < 20000 && lastFinish.key === key) return;
  try {
    const win = global.__wbWin;
    if (win && !win.isDestroyed() && win.isFocused() && win.isVisible()) return; // 你正看着呢，不用弹
  } catch {}
  try {
    const { Notification } = electron;
    if (!Notification.isSupported()) return;
    lastFinish = { at: Date.now(), key };
    const n = new Notification({
      title: kind === "done" ? "OpenWorkBuddy 干完了" : "OpenWorkBuddy 出岔子了",
      body: String(text || "").slice(0, 160) || (kind === "done" ? "成果已经落到工作区" : "点开看看卡在哪"),
      silent: kind === "done", // 完成不响铃，出错才响：好消息不该打断你手上的事
    });
    n.on("click", () => { const w = global.__wbWin; if (w && !w.isDestroyed()) { w.show(); w.focus(); } });
    n.show();
  } catch {}
}

/* ------------------------------------------------------------------ *
 * 溜达：闲着的时候在屏幕上走两步
 * ------------------------------------------------------------------ *
 * 默认关。理由和「宠物本身默认不存在」是同一条：会自己动的挂件更容易挡住别人的东西，
 * 得由用户明确点头才开。开了之后也只在真闲着时走——正在干活/等你回答/你正把光标压在
 * 它身上，这三种情况一步都不挪。
 */
function stopWalk() {
  if (walkTimer) { clearInterval(walkTimer); walkTimer = null; savePos(); }
  if (walkDir) { walkDir = ""; push(); }
}

function startWalk() {
  if (walkTimer || !petWin || petWin.isDestroyed() || !electron) return;
  const [w, h] = petWin.getSize();
  const [x0, y0] = petWin.getPosition();
  const area = electron.screen.getDisplayNearestPoint({ x: x0 + Math.round(w / 2), y: y0 + Math.round(h / 2) }).workArea;
  const minX = area.x + 8, maxX = area.x + area.width - w - 8;
  if (maxX <= minX) return;
  const far = 90 + Math.round(Math.random() * 170);
  const target = Math.min(maxX, Math.max(minX, x0 + (Math.random() < 0.5 ? -far : far)));
  if (Math.abs(target - x0) < 30) return; // 已经贴边了，这轮就不走
  walkDir = target > x0 ? "right" : "left";
  push();
  const steps = Math.max(8, Math.round(Math.abs(target - x0) / 6));
  let i = 0;
  walkTimer = setInterval(() => {
    // 每一步都重新确认还该不该走：中途来了任务、或者你伸手要点它，立刻站住
    if (!petWin || petWin.isDestroyed() || curState.name !== "idle" || lastHit) return stopWalk();
    i += 1;
    try { petWin.setPosition(Math.round(x0 + (target - x0) * (i / steps)), y0); } catch {}
    if (i >= steps) stopWalk();
  }, 40);
}

function armWander() {
  clearInterval(wanderTimer); wanderTimer = null;
  if (!cfg.wander || !petWin || petWin.isDestroyed()) return;
  // 15 秒一次机会、五成概率：太勤快就成了满屏乱窜的小广告
  wanderTimer = setInterval(() => {
    if (curState.name === "idle" && !lastHit && !walkTimer && Math.random() < 0.5) startWalk();
  }, 15000);
}

/** 用户答了/超时了：停止闪烁，回到干活状态 */
function clearAsk(stillWorking) {
  try {
    const win = global.__wbWin;
    if (win && !win.isDestroyed() && process.platform !== "darwin") win.flashFrame(false);
  } catch {}
  setState(stillWorking ? "working" : "idle", "");
}

function show() { cfg.enabled = true; create(); if (petWin && !petWin.isDestroyed() && !petWin.isVisible()) petWin.showInactive(); }
function hide() {
  cfg.enabled = false;
  stopWalk(); clearInterval(wanderTimer); wanderTimer = null;
  if (petWin && !petWin.isDestroyed()) { savePos(); petWin.destroy(); }
  petWin = null;
}
function isVisible() { return !!(petWin && !petWin.isDestroyed() && petWin.isVisible()); }

/** 设置页改了开关/大小/透明度后热生效 */
function applyConfig(next) {
  const prev = { ...cfg };
  cfg = { ...cfg, ...(next || {}) };
  photoCache = { key: "", url: "" }; // 设置动过就重读一次图，省得换了照片还显示旧的
  if (!cfg.enabled) { hide(); cfg.enabled = false; return; }
  if (!petWin || petWin.isDestroyed()) { create(); return; }
  if (cfg.character !== prev.character || cfg.sprite !== prev.sprite) sheetCache = { key: "", url: "", spec: null };
  if (!cfg.wander) stopWalk();
  if (cfg.wander !== prev.wander) armWander();
  if (Number(cfg.scale) !== Number(prev.scale)) {
    const scale = Math.min(2, Math.max(0.6, Number(cfg.scale) || 1));
    const w = Math.round(PET_W * scale), h = Math.round(PET_H * scale);
    // 猫是站在窗口底边中间的：直接 setSize 会让窗口从左上角往下往右长，
    // 于是每调一次大小猫就往右下挪一截，调到 200% 时能整只钻进 Dock 后面。
    // 这里按「底边中点不动」重算坐标，再走一次 sanePos 保证没跑出可视区。
    const [x, y] = petWin.getPosition();
    const [ow, oh] = petWin.getSize();
    const p2 = sanePos({ x: Math.round(x + (ow - w) / 2), y: Math.round(y + (oh - h)) }, w, h);
    petWin.setBounds({ x: p2.x, y: p2.y, width: w, height: h });
    savePos();
  }
  push();
}

function destroy() {
  clearTimeout(idleTimer);
  stopWalk(); clearInterval(wanderTimer); wanderTimer = null;
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  if (petWin && !petWin.isDestroyed()) { savePos(); petWin.destroy(); }
  petWin = null;
}

module.exports = { create, setState, alertAsk, clearAsk, show, hide, isVisible, applyConfig, destroy, get enabled() { return cfg.enabled; } };
