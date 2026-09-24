"use strict";
/** Electron 桌面壳 — 启动内嵌服务并打开桌面窗口。运行：npm run app */

const BOOT_T0 = Date.now(); // 启动分段计时：哪段慢一眼看清，别靠体感猜
const { app, BrowserWindow, dialog, shell, globalShortcut, Menu, clipboard, Tray, nativeImage, screen, session, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { dataPath, seedDataDir, resolvePort } = require("./paths");

// ---------- 桌面壳这一层的文案 ----------
/**
 * 网页那套翻译是照着 DOM 走的：它认的是文本节点和属性，遇上就换掉。
 * 而原生右键菜单、系统报错框、启动失败页里的字，从头到尾只是主进程里的 JS 字符串——
 * 一秒钟都没进过渲染进程的 DOM，所以网页那边翻得再全，右键点一下弹出来的还是中文。
 * 这一层只能自己带一份小词表。条目不多，摊开写，别再套一层查词函数。
 */
const SHELL_TEXT = {
  zh: {
    copyImage: "复制图片", copyImageURL: "复制图片地址",
    copy: "复制", cut: "剪切", paste: "粘贴", selectAll: "全选",
    copyLink: "复制链接", openInBrowser: "在浏览器里打开",
    unknownError: "未知错误",
    failTitle: "OpenWorkBuddy 没能启动",
    bootLogLabel: "启动日志：",
    bootLogNone: "（日志文件写不出来）",
    logUnwritable: "写不出来",
    bootLogForIssue: "启动日志（贴 issue 时带上它）：",
    cfgFallback: "用户目录下的 OpenWorkBuddy/config.json",
    gpuTip1: "还可以试：窗口一直不出现、或者整片黑，多半是显卡驱动画不出来——加一行 ",
    gpuTip2: "，写进 ", gpuTip3: " 的 ", gpuTip4: " 里，再打开。",
    versionLabel: "版本", openIssue: "提 issue",
    stuckTitle: "OpenWorkBuddy 已经在运行了，但窗口没出来",
    stuckBody: "后台还留着一个卡住的 OpenWorkBuddy 进程，它占着单实例锁，所以新的一次启动被挡住了。\n\n先到任务管理器（macOS 活动监视器）里结束 OpenWorkBuddy 进程，再重新打开。",
    hintMissingFiles: "安装包里少了文件。到 GitHub Releases 重新下载最新版本覆盖安装即可；如果最新版仍然这样，请把下面这行贴到 issue 里。",
    hintDataDir: "放数据的文件夹建不起来（默认在用户目录下的 OpenWorkBuddy）。常见原因是公司电脑把用户目录重定向到了连不上的网络盘，或者磁盘满了。设一个环境变量 OPENWORKBUDDY_HOME 指向本机一个能写的文件夹（比如 D:\\OpenWorkBuddy）再打开。",
    hintPortDenied: (port) => `没权限使用端口 ${port}。Windows 上多半是 Hyper-V / WSL 预留了这段端口（命令行跑 netsh interface ipv4 show excludedportrange protocol=tcp 能看到保留段），把用户目录下 OpenWorkBuddy/config.json 里的 server.port 换成一个没被预留的（比如 3810）再打开。`,
    hintPortBusy: (port) => `端口 ${port} 被占了，往后连试十个也都被占着。关掉占用它们的程序，或者把用户目录下 OpenWorkBuddy/config.json 里的 server.port 换一个。`,
    hintHostGone: "配置里的 server.host 在这台机器上不存在了（换过网络之后常见）。把用户目录下 OpenWorkBuddy/config.json 里的 server.host 改回 127.0.0.1 再打开。",
    hintCrashed: "服务端启动时崩了。把下面这行贴到 GitHub issue 里，附上你的系统版本。",
    // 界面进程卡死 / 没了（attachCrashGuard）。服务端和任务都在主进程里，重载只动界面这一层
    hungTitle: "界面没响应了",
    hungDetail: "重新加载会丢掉没发出去的输入，后台任务照跑；也可以再等等。",
    goneTitle: "界面停止运行了",
    goneDetail: "重新加载就能接着用，后台任务照跑。",
    reasonLabel: "原因代码：",
    reloadBtn: "重新加载", waitBtn: "再等等", laterBtn: "先不管",
    // 托盘和退出确认（createTray / requestQuit）
    trayTip: "OpenWorkBuddy 桌面版",
    trayShow: "显示窗口", trayNewTask: "新建任务", trayQuit: "退出",
    quitBusy: (n) => `还有 ${n} 个任务在跑，退出会中断它们`,
    quitBtn: "中断并退出", stayBtn: "先不退",
  },
  en: {
    copyImage: "Copy image", copyImageURL: "Copy image address",
    copy: "Copy", cut: "Cut", paste: "Paste", selectAll: "Select all",
    copyLink: "Copy link", openInBrowser: "Open in browser",
    unknownError: "Unknown error",
    failTitle: "OpenWorkBuddy failed to start",
    bootLogLabel: "Startup log: ",
    bootLogNone: "(the log file could not be written)",
    logUnwritable: "could not be written",
    bootLogForIssue: "Startup log (attach it to the issue): ",
    cfgFallback: "OpenWorkBuddy/config.json in your home folder",
    gpuTip1: "One more thing to try: if the window never appears, or is all black, the graphics driver probably cannot draw it — add ",
    gpuTip2: " to ", gpuTip3: " under ", gpuTip4: ", and open it again.",
    versionLabel: "Version", openIssue: "open an issue",
    stuckTitle: "OpenWorkBuddy is already running, but its window never appeared",
    stuckBody: "A stuck OpenWorkBuddy process is still in the background holding the single-instance lock, so this new launch was blocked.\n\nEnd the OpenWorkBuddy process in Task Manager (Activity Monitor on macOS), then open it again.",
    hintMissingFiles: "Files are missing from the installer. Download the latest release from GitHub Releases and install over this one; if the latest still does this, paste the line below into an issue.",
    hintDataDir: "The data folder cannot be created (by default OpenWorkBuddy under your home folder). Usually this is a work machine whose home folder is redirected to a network drive that is unreachable, or a full disk. Set the environment variable OPENWORKBUDDY_HOME to a writable folder on this machine (e.g. D:\\OpenWorkBuddy) and open it again.",
    hintPortDenied: (port) => `No permission to use port ${port}. On Windows this is usually Hyper-V / WSL reserving that range (run netsh interface ipv4 show excludedportrange protocol=tcp to see the reserved ranges). Change server.port in OpenWorkBuddy/config.json under your home folder to one that is not reserved (3810, say) and open it again.`,
    hintPortBusy: (port) => `Port ${port} is taken, and so are the ten after it. Close whatever is using them, or change server.port in OpenWorkBuddy/config.json under your home folder.`,
    hintHostGone: "The server.host in your config no longer exists on this machine (common after switching networks). Set server.host back to 127.0.0.1 in OpenWorkBuddy/config.json under your home folder and open it again.",
    hintCrashed: "The server crashed while starting. Paste the line below into a GitHub issue, along with your OS version.",
    hungTitle: "The window is not responding",
    hungDetail: "Reloading drops anything you haven't sent yet; background tasks keep running. You can also wait a bit longer.",
    goneTitle: "The window stopped working",
    goneDetail: "Reload to keep working; background tasks keep running.",
    reasonLabel: "Reason code: ",
    reloadBtn: "Reload", waitBtn: "Keep waiting", laterBtn: "Not now",
    trayTip: "OpenWorkBuddy desktop",
    trayShow: "Show window", trayNewTask: "New task", trayQuit: "Quit",
    quitBusy: (n) => (n === 1 ? "1 task is still running. Quitting will stop it." : `${n} tasks are still running. Quitting will stop them.`),
    quitBtn: "Stop and quit", stayBtn: "Keep running",
  },
};
/**
 * 窗口还没起来的时候，系统语言是唯一问得到的信号——启动失败页正是这种时候要画的东西。
 * 口径跟网页那边的 detect() 一致：问不出来算中文，zh 开头算中文，其余算英文。
 */
function osLang() {
  let loc = "";
  try { loc = String(app.getLocale() || ""); } catch {}
  if (!loc) return "zh";
  return /^zh/i.test(loc) ? "zh" : "en";
}
const T = (lang) => SHELL_TEXT[lang === "en" ? "en" : "zh"];
// 渲染进程上一次答出来的界面语言（见 uiLang）。界面卡死或者没了的时候问不着它，只能用这一份
let LAST_UI_LANG = "";

// ---------- 启动日志：出事时用户手里唯一的物证 ----------
/**
 * 「任务管理器里有进程、屏幕上没窗口」这类报障（issue #1），没有日志就只能靠猜，
 * 用户能做的只有重装三遍——而重装治不好这个病。所以从进程起来的第一行就往磁盘记，
 * 最后把日志路径写进报错页面，让他直接贴给我们。
 *
 * 首选数据目录；数据目录本身就是起不来的原因时（没权限、家目录被重定向到离线的网络盘），
 * 退到系统临时目录。这段代码自己绝不许抛——它是用来报错的，不能成为新的错因。
 */
function pickBootLog(candidates) {
  for (const f of candidates) {
    if (!f) continue;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      // 只留最近一次启动的上下文，别让它长成一个没人敢打开的大文件
      try { if (fs.statSync(f).size > 512 * 1024) fs.truncateSync(f, 0); } catch {}
      fs.appendFileSync(f, "");
      return f;
    } catch {}
  }
  return null; // 哪儿都写不了：那就只剩控制台，至少别把启动本身拖垮
}
const BOOT_LOG = pickBootLog([
  (() => { try { return path.join(dataPath("logs"), "boot.log"); } catch { return null; } })(),
  (() => { try { return path.join(os.tmpdir(), "OpenWorkBuddy-boot.log"); } catch { return null; } })(),
]);
function bootLog(...parts) {
  const line = `+${Date.now() - BOOT_T0}ms ${parts.join(" ")}`;
  console.log("[启动] " + line);
  if (!BOOT_LOG) return;
  try { fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${line}\n`); } catch {}
}
bootLog(`—— OpenWorkBuddy ${require("./package.json").version} 启动 · ${process.platform}/${process.arch} · Electron ${process.versions.electron} ——`);

// 端口优先级跟服务端共用一份实现（paths.js），各写各的必然漂——漂了的症状是窗口永远等不到人。
// 端口要在 fatal 之前就位：报错文案里要用它，而异常可能发生在模块还没读完的时候
let PORT;
try {
  PORT = resolvePort(process.env, require(dataPath("config.json")));
} catch {
  PORT = resolvePort(process.env, null);
}

// 有些机器的显卡驱动会让 Electron 的窗口永远画不出来——进程活着，屏幕上什么都没有。
// 给一个不用改代码就能绕过去的开关：环境变量，或者用记事本在 config.json 里加一行。
// 报错页面会把这一招写给用户看。
const NO_GPU = process.env.OPENWORKBUDDY_DISABLE_GPU === "1" || (() => {
  try { return require(dataPath("config.json")).server.disable_gpu === true; } catch { return false; }
})();
if (NO_GPU) {
  try { app.disableHardwareAcceleration(); bootLog("已关闭硬件加速（disable_gpu）"); } catch {}
}

let win;
let PAGE_UP = false; // 页面真加载出来了：之后再有偶发异常，不该把用户正在做的事掐掉
let FATAL_SHOWN = false;
// 服务端是不是跑在这个进程里。端口上早有一台 OWB、窗口连过去的时候（got.reused）任务在人家进程里，
// 这边退出中断不了它们——那就既不该问「要不要中断」，更不能顺手去叫停别人的任务
let SERVER_OWN = false;
// 退出走到哪一步了（requestQuit）："" 没在退 · "asking" 确认框挂着 · "closing" 正在收尾 · "done" 放行
let QUIT_STATE = "";
let SHUTDOWN = null; // shutdown() 那一趟的 Promise：谁来要都给同一个，收尾只做一遍
let tray = null;     // 托盘图标。得有人一直拿着引用，被垃圾回收掉的话图标会从状态栏上凭空消失
let trayLang = "";   // 托盘菜单眼下是哪种语言（refreshTray）：没变就不重建

/**
 * 启动阶段的每一声崩溃都得有个出口。
 * 没有这个出口的表现就是 issue #1：进程活着、窗口不出现、用户手里一条线索都没有。
 * 窗口已经在了就把原因画进窗口；窗口还没有就弹系统级报错框——它不需要窗口也能显示。
 */
function fatal(stage, err) {
  const msg = String((err && (err.stack || err.message)) || err || "未知错误");
  bootLog(`✗ ${stage}：${msg}`);
  if (PAGE_UP || FATAL_SHOWN) return; // 已经跑起来了，或者已经报过一次，不重复打扰
  // 已经在退了（启动到一半他点了关窗、系统在关机）：窗口一销毁，还没跑完的启动流程会接着撞上死窗口抛错。
  // 这时候再弹「启动失败」是吓人——他要的是退出，退出这条路自己会走完。日志上面已经记了
  if (QUIT_STATE) return;
  FATAL_SHOWN = true;
  if (win && !win.isDestroyed()) return showBootFailure(err);
  const show = () => {
    try {
      const t = T(osLang()); // app.getLocale() 得等 ready，而这个函数正是 ready 之后才跑的
      dialog.showErrorBox(
        t.failTitle,
        `${bootAdvice(err, msg, PORT, t)}\n\n${((err && err.bootProblem && err.bootProblem.title) || msg).split("\n")[0]}\n\n${t.bootLogLabel}${BOOT_LOG || t.bootLogNone}`
      );
    } catch {}
    app.exit(1);
  };
  // macOS 上 showErrorBox 必须等 ready；Windows/Linux 上早晚都行
  if (app.isReady()) show();
  else app.whenReady().then(show).catch(() => app.exit(1));
}
process.on("uncaughtException", (e) => fatal("主进程未捕获异常", e));
// 没人接的 Promise 拒绝没那么致命：后台某个 fetch 挂了也会掉到这儿，
// 不该因此把一个本来能用的应用换成报错页。只有连窗口都还没建出来时才当启动失败办，
// 其余情况记一笔日志——窗口到底出没出来，交给下面的看门狗判。
process.on("unhandledRejection", (e) => {
  if (!win) return fatal("主进程未处理的 Promise 拒绝", e);
  bootLog("▲ 有个没人接的 Promise 拒绝：" + String((e && e.message) || e));
});

// 装机态：代码在只读的应用包里，配置/数据/工作区落到 ~/OpenWorkBuddy。
// 首次启动（以及每次升级后）把包里自带的 experts.json 和内置技能补进去，只补缺、不覆盖用户改过的。
// ⚠️ 以前这一句在模块顶层裸跑。它要在用户家目录下建 ~/OpenWorkBuddy：没权限、家目录被重定向到
// 离线的网络盘，都会炸在这儿——一抛异常主进程当场没了，窗口永远不出现，用户只看到一个进程。
// 现在先接住，等窗口建好了再把原因画给他看。
let SEED_ERR = null;
try {
  seedDataDir();
  bootLog("数据目录就绪：" + dataPath());
} catch (e) {
  SEED_ERR = e;
  bootLog("✗ 数据目录建不起来：" + ((e && e.message) || e));
}

// 改过两次名（workbuddy-clone → openbuddy → openworkbuddy）。Electron 的 userData 目录跟着
// package.json 的 name 走，不搬家的话老用户会丢 localStorage（表现为莫名其妙被登出）。
// 按时间倒序找最近的一个旧目录搬过来，只在新目录不存在时搬一次。
// ⚠️ 白名单只放我们自己用过的精确名字，并且只做全等匹配、不做前缀/模糊匹配：
// appData 底下还躺着别家同类应用的目录，名字跟我们挨得很近，匹配放宽一格就是删别人的数据。
const LEGACY_USERDATA = ["openbuddy", "workbuddy-clone"];
// 显示名叫 OpenWorkBuddy（「关于」面板、系统通知的署名），但 userData 目录钉死在 openworkbuddy：
// app.setName 会连带把 userData 改成 appData/OpenWorkBuddy，那等于第三次改名、用户又被登出一次
app.setPath("userData", path.join(app.getPath("appData"), "openworkbuddy"));
app.setName("OpenWorkBuddy");
/**
 * 「关于」面板那行版权：许可证和主页都从 package.json 读。
 * 以前写死 "MIT"，许可证早换成 PolyForm-Noncommercial 了，面板还在说 MIT——对外等于许了一个不存在的授权。
 */
function aboutCopyright(pkg) {
  const home = String((pkg && pkg.homepage) || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return [pkg && pkg.license, home].filter(Boolean).join(" · ");
}
app.setAboutPanelOptions({ applicationName: "OpenWorkBuddy", applicationVersion: require("./package.json").version, copyright: aboutCopyright(require("./package.json")) });
(function migrateUserData() {
  try {
    const base = app.getPath("appData");
    const to = path.join(base, "openworkbuddy");
    if (fs.existsSync(to)) return;
    for (const name of LEGACY_USERDATA) {
      const from = path.join(base, name);
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, to);
      console.log(`[迁移] userData 已从 ${name} 搬到 openworkbuddy`);
      return;
    }
  } catch (e) {
    console.warn("[迁移] userData 搬家失败（不影响使用，只是要重新登录一次）:", e.message);
  }
})();

// 单实例：双击启动器/重复 npm run app 时，把已开的窗口拉到前台，而不是再叠一个实例
// （第二个实例的服务端会撞端口走"连接已运行实例"分支，结果就是两个窗口两份 Dock 图标）
if (!app.requestSingleInstanceLock()) {
  // 留一行日志再走。用户这边看到的是「双击了没反应」，日志里得说清是「已经有一个在跑」，
  // 否则这条正常行为和真的启动失败长得一模一样。
  bootLog("已经有一个实例在跑，这次启动把它唤到前台后退出");
  app.exit(0); // 立即退出：app.quit() 是异步的，慢一步的话 whenReady 还会抢跑建出第二个窗口
} else {
  app.on("second-instance", () => {
    // 锁在、窗口不在：上一个实例卡在启动中途（或者已经崩了但进程没退）。
    // 这时候用户会一直双击图标、一直没反应——必须告诉他发生了什么，以及去哪儿看日志。
    if (!win || win.isDestroyed()) {
      bootLog("重复启动：锁被一个没有窗口的实例占着");
      try {
        const t = T(osLang());
        dialog.showErrorBox(
          t.stuckTitle,
          `${t.stuckBody}\n\n${t.bootLogLabel}${BOOT_LOG || t.bootLogNone}`
        );
      } catch {}
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// ---------- 窗口记忆 ----------
// 窗口上次关在哪儿、多大，下次还开在那儿（userData/window-state.json）。
// 这份文件纯属锦上添花，读写都兜住：读坏了当没存过，写不进去就算了——为它开不出窗口不值得。
const WIN_SIZE = { width: 1520, height: 900, minWidth: 680, minHeight: 480 };
function winStateFile() {
  try { return path.join(app.getPath("userData"), "window-state.json"); } catch { return null; }
}

function readWindowState(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null; // 没有、读不了、半截 JSON（上次写到一半断电）：都当没存过
  }
}

function writeWindowState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 先写旁边再改名：写到一半断电，盘上留下的是上一份完整的，不是半截 JSON
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 存下来的位置还能不能原样用。
 *   · 数不像话（NaN、字符串、负的宽高）→ 那一项用默认；太小抬到最小尺寸，比屏还大压到最大那块屏以内；
 *   · 位置：标题栏得整条落在某块屏的工作区里、横向至少露出 80 像素才用。上次开在外接屏上、
 *     这次屏拔了，坐标指着一片不存在的地方——窗口开在那儿等于没开，也拖不回来（抓不到标题栏）。
 *     这时候不给 x/y，Electron 自己居中。口径照宠物的 sanePos（pet.js），只是主窗口得抓得到标题栏。
 */
function saneWindowBounds(saved, areas, def) {
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const s = saved && typeof saved === "object" ? saved : {};
  const scr = (areas || []).filter((a) => a && num(a.x) && num(a.y) && a.width > 0 && a.height > 0);
  let width = num(s.width) && s.width > 0 ? s.width : def.width;
  let height = num(s.height) && s.height > 0 ? s.height : def.height;
  if (scr.length) {
    width = Math.min(width, Math.max(...scr.map((a) => a.width)));
    height = Math.min(height, Math.max(...scr.map((a) => a.height)));
  }
  const out = { width: Math.round(Math.max(def.minWidth, width)), height: Math.round(Math.max(def.minHeight, height)) };
  if (num(s.x) && num(s.y)) {
    const x = Math.round(s.x), y = Math.round(s.y);
    // y 放 10 像素余量：Windows 的窗口四周有一圈看不见的缩放边，贴顶摆的窗口 y 会是个小负数
    const seen = scr.some((a) => x + out.width - 80 >= a.x && x + 80 <= a.x + a.width && y >= a.y - 10 && y + 40 <= a.y + a.height);
    if (seen) { out.x = x; out.y = y; }
  }
  if (s.maximized === true) out.maximized = true;
  return out;
}

async function waitForServer(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      // 只看服务端有没有应答，不看状态码：/api/* 挂在登录守卫后面，没登录时回 401，
      // 那也是「服务端活着」。以前只认 r.ok，导致每次启动都空等满 30 秒超时才加载页面
      await fetch(url);
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150)); // 服务端 1 秒内就绪，粗轮询白等半秒
  }
  return false;
}

app.whenReady().then(async () => {
  bootLog("Electron 运行时就绪");
  // 开发态（npm run app）跑的是 node_modules 里的 Electron.app，Dock 默认挂它的图标；换成我们自己的。
  // 菜单栏左上角的名字改不了——macOS 只认正在跑的那个 .app 的 Info.plist，
  // 要连名字一起对，用 scripts/make-mac-app.sh 生成的 ~/Applications/OpenWorkBuddy.app 启动。
  if (process.platform === "darwin" && app.dock && !app.isPackaged) {
    try { app.dock.setIcon(path.join(__dirname, "build", "icon.png")); } catch (e) { console.warn("[启动] Dock 图标设置失败:", e.message); }
  }
  // 上次关窗时的位置和大小。屏幕一块一块问：上次那块屏可能已经拔了
  let place = { width: WIN_SIZE.width, height: WIN_SIZE.height };
  try {
    place = saneWindowBounds(readWindowState(winStateFile()), screen.getAllDisplays().map((d) => d.workArea), WIN_SIZE);
  } catch (e) {
    bootLog("▲ 上次的窗口位置没用上，按默认大小居中：" + String((e && e.message) || e));
  }
  // 窗口先开（秒响应），服务端在同进程内随后启动，就绪即加载页面。
  // 顺序反过来的话，用户要盯着 Dock 图标空等服务端把路由全注册完。
  win = new BrowserWindow({
    width: place.width,
    height: place.height,
    ...(place.x !== undefined ? { x: place.x, y: place.y } : {}), // 不给 x/y 就是居中
    minWidth: WIN_SIZE.minWidth,
    minHeight: WIN_SIZE.minHeight,
    title: "OpenWorkBuddy",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    show: false, // 页面渲染好了再亮相（ready-to-show），不给用户看白屏；下面有兜底定时防止永不出现
    webPreferences: {
      backgroundThrottling: false, // 窗口隐藏（快捷键收起）时任务还在流式回报，计时器不许被降频
    },
  });
  // 窗口挪了、拉大了就记下来；拖动时 move 一秒几十次，停手半秒再写。关窗那一下立刻写
  let saveTimer = null;
  const saveWinState = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!win || win.isDestroyed()) return;
    // 记「正常状态」那一份：最大化、全屏时的外框不是他摆的位置，下次按它还原会铺满屏又缩不回去
    writeWindowState(winStateFile(), { ...win.getNormalBounds(), maximized: win.isMaximized() });
  };
  for (const ev of ["move", "resize", "maximize", "unmaximize"]) {
    win.on(ev, () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWinState, 500); });
  }
  win.on("close", saveWinState);
  // 系统要关机 / 重启 / 注销：不拦。这时候拦下来问一句，用户看到的是「OpenWorkBuddy 阻止了关机」
  // （macOS 上注销直接被取消），而关机本来就会带走所有进程，问了也留不住什么
  let sysQuitTimer = null;
  const letSystemQuit = () => {
    QUIT_STATE = "done";
    bootLog("系统要关机或注销：不拦，直接退");
    // 关机也可能被取消（别的应用拦下、用户点了「取消」），进程还活着。一直停在「放行」的话，
    // 之后关窗 / ⌘Q 就不问也不收尾，在跑的任务一声不吭就断了——过一分钟还没退，就把闸装回去
    clearTimeout(sysQuitTimer);
    sysQuitTimer = setTimeout(() => {
      if (QUIT_STATE !== "done" || SHUTDOWN) return;
      QUIT_STATE = "";
      bootLog("系统关机一分钟了还没退，当它取消了：退出前的确认装回去");
    }, SYS_QUIT_REARM_MS);
    if (sysQuitTimer.unref) sysQuitTimer.unref();
  };
  win.on("query-session-end", letSystemQuit); // Windows
  try { powerMonitor.on("shutdown", letSystemQuit); } catch {} // macOS / Linux

  // 首绘打磨：正常流程 ready-to-show 在 ~0.7s 内到，一次干净的整页亮相；
  // 服务端起不来时它可能永远不触发，3 秒兜底强制亮窗，让用户看到报错而不是什么都没有。
  // ⚠️ 这段必须排在 require("./server.js") 前面。放后面的话，服务端 require 一抛异常，
  // 兜底定时器根本没来得及挂上，窗口就永远停在 show:false —— v0.1.1 装机包缺 engines/
  // 时用户看到的正是这个：任务管理器里有进程，屏幕上什么都没有。
  // 上次是最大化关的，这次亮相前先最大化。不能在建窗口那会儿就调：Windows 上 maximize() 会顺手把窗口亮出来，白屏就露了
  const showOnce = () => { if (win && !win.isVisible()) { if (place.maximized) win.maximize(); win.show(); } };
  win.once("ready-to-show", () => { bootLog("窗口亮相"); showOnce(); });
  setTimeout(showOnce, 3000);

  // 看门狗：20 秒还没有一个亮着的窗口，就当启动已经失败了。
  // 「窗口对象建出来了」不等于「用户看得见东西」——显卡驱动画不出来、loadURL 卡在网络栈上，
  // 都会停在这一步，而这正是 issue #1 里「任务管理器有进程、屏幕上什么都没有」的样子。
  const watchdog = setTimeout(() => {
    if (PAGE_UP) return;
    if (win && !win.isDestroyed() && win.isVisible()) return;
    fatal("启动看门狗", new Error("启动 20 秒后仍然没有可见窗口"));
  }, 20000);
  if (watchdog.unref) watchdog.unref(); // 别让它拖着进程不退出

  // 外链交给系统浏览器、右键给出「复制」——这两根线也必须排在 require("./server.js") 前面，
  // 理由和上面那个 3 秒兜底亮窗一样：服务端 require 一抛异常，下面的代码一行都不会执行，
  // 而这时窗口里画的恰恰是启动失败页。那一页上写着「把这行贴到 issue 里」「贴 issue 时带上
  // 启动日志」，右键却弹不出「复制」——让一个刚被挡在门外的人手抄一串路径，等于没给出路。
  // 页面上那个「提 issue」也一样：没挂 openHandler 的话它会在应用里另开一个没有地址栏、
  // 没有登录态的 Electron 窗口，而不是去用户自己的浏览器。
  // 站内链接留在应用里，只有真外链才交给系统浏览器。
  // 这两件事以前是一件：凡 target="_blank" 一律 shell.openExternal。可登录令牌是一枚发给
  // 这个 Electron session 的 HttpOnly cookie，系统浏览器身上根本没有——于是资料库里点一下
  // 「新窗口打开」（那是 /api/files/view/…，站内地址），Safari 弹出来只有一行
  //   {"error":"未登录","setup":false}
  // 「本地部署预览」那条不在此列：它是另起的一个进程、另一个端口，认不了这枚 cookie，
  // 链接里自己带着令牌，本来就该去系统浏览器（手机上扫码打开也是靠它）。
  const sameOrigin = (u) => {
    try { return new URL(u).origin === `http://127.0.0.1:${PORT}`; } catch { return false; }
  };
  const openHandler = ({ url }) => {
    if (sameOrigin(url)) {
      // 同一个 session，cookie 跟着走；父窗口关了它还能留着，所以不设 parent
      const child = new BrowserWindow({
        width: 1000, height: 780, backgroundColor: "#ffffff",
        webPreferences: { backgroundThrottling: false },
      });
      child.webContents.setWindowOpenHandler(openHandler); // 子窗口里再点链接，同一套规矩
      attachContextMenu(child.webContents);
      child.loadURL(url);
      return { action: "deny" };
    }
    // 协议白名单：file:// 能把本机任意文件递出去，自定义 scheme 会唤起别的应用——
    // 而这两种地址都可能来自模型写的网页或下载来的资料，不是用户自己打的
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  };
  win.webContents.setWindowOpenHandler(openHandler);
  attachContextMenu(win.webContents);
  // 界面卡死 / 崩掉的兜底。同样挂在 require 服务端之前：启动失败页那一页也可能卡住
  attachCrashGuard(win);

  // 数据目录在模块顶层就没建起来。后面服务端一定会跟着崩，但崩出来的错更难懂
  // （读不到 config.json 之类），所以在这儿就把真正的原因交出来。
  if (SEED_ERR) return fatal("准备数据目录", SEED_ERR);

  // 在 Electron 主进程内直接启动服务端。
  // 它是整个应用的地基，塌了就没有「降级可用」这回事——但用户至少得知道塌在哪，
  // 而不是对着一个不出现的窗口重装三遍。
  // 服务端起不来时，它得有个地方把原因交出来。没有这个出口的话它只能 process.exit(1)：
  // 主进程当场消失，上面那个 3 秒兜底亮窗根本轮不到，用户看到的就是「有进程、没界面」。
  // ⚠️ 必须挂在 require 之前——server.js 的 main() 是异步的，失败可能发生在 require 返回之后的任何时刻。
  global.__wbBootFail = (e) => showBootFailure(e);
  // 服务端最后绑上的那个口，不一定是上面算出来的这个：3800 被别的程序占着时它会自己换一个。
  // 不等它报数、直接按算出来的口加载，窗口就连到占着口的陌生程序上去了——用户看到一个不认识
  // 的页面或者白屏，日志里却写着「服务端就绪」。这正是 issue 里「下载之后打不开」的样子。
  let onBound;
  const bound = new Promise((r) => { onBound = r; });
  global.__wbOnListen = (p, meta) => onBound({ port: p, ...(meta || {}) });
  try {
    require(path.join(__dirname, "server.js"));
  } catch (e) {
    console.error("[启动] 服务端起不来:", e);
    return showBootFailure(e);
  }

  const got = await Promise.race([bound, new Promise((r) => setTimeout(() => r(null), 30000))]);
  if (!got) {
    // 服务端自己报错的那条路已经把窗口画成报错页了（__wbBootFail），别再盖一层
    if (FATAL_SHOWN) return;
    console.error(`[启动] 等了 30 秒，服务端一直没说它绑在哪个端口`);
    return showBootFailure(new Error(`服务端启动后 30 秒内没有监听 ${PORT} 端口`));
  }
  if (got.port !== PORT) bootLog(`端口换了：${PORT} → ${got.port}（原来那个被别的程序占着）`);
  PORT = got.port;
  const up = await waitForServer(`http://127.0.0.1:${PORT}/api/info`);
  if (!up) {
    console.error(`[启动] 等了 30 秒，${PORT} 端口一直没人应答`);
    return showBootFailure(new Error(`服务端启动后 30 秒内没有监听 ${PORT} 端口`));
  }
  bootLog(got.reused ? `${PORT} 上已经有一台 OpenWorkBuddy，连过去` : `服务端就绪，监听 ${PORT}`);
  SERVER_OWN = !got.reused;
  win.webContents.once("did-finish-load", () => {
    // 过了这条线就算启动成功了：再有偶发异常只记日志，不能把用户正在做的事掐掉换成报错页
    PAGE_UP = true;
    clearTimeout(watchdog);
    bootLog("页面加载完成 ✓ 启动成功");
  });
  // 用 127.0.0.1 而不是 localhost：有些机器（改过 hosts、或者 IPv6 优先）会把 localhost 解析到 ::1，
  // 而服务端只监听了 IPv4，表现就是窗口一直空白。
  win.loadURL(`http://127.0.0.1:${PORT}`);


  /**
   * 关掉主界面 = 整个应用退出，桌面宠物跟着一起走。
   *
   * 这件事原本只挂在 window-all-closed 上，而那个事件要求**所有**窗口都关掉才触发。
   * 宠物是个 BrowserWindow，只要它还飘在桌面上，主界面关了也永远轮不到它。于是：
   *   · 进程留在后台，宠物赶不走，Dock 上那个图标也不消失；
   *   · 单实例锁还占着，用户再点图标就撞进 second-instance 分支，而 win 此刻已经销毁，
   *     迎面收到一句「已经在运行了，但窗口没出来，请去活动监视器结束进程」——只为了关个窗口。
   *
   * 旧代码那行的注释写的就是「盯的是主窗口的 closed」，底下写的却是 window-all-closed。
   * 两边对不上的时候，错的是代码。
   *
   * 注意这里盯的是 closed 不是 close：快捷键收起窗口走的是 win.hide()，碰不到这条路。
   *
   * 关窗这一下先被 close 拦住，交给 requestQuit：有任务在跑就先问一句，确认了才走 shutdown 收尾，
   * 收完才放行。走到 closed 的时候那一趟已经放行过了（QUIT_STATE === "done"），这里再要一次只是确认退出。
   */
  win.on("close", (e) => {
    if (QUIT_STATE === "done") return;
    e.preventDefault();
    requestQuit();
  });
  win.on("closed", () => {
    win = null;
    global.__wbWin = null; // 留着一个已销毁的引用，server.js 那边取到就会往死对象上调方法
    requestQuit(); // 统一出口：会走 will-quit，宠物在那儿 destroy、全局快捷键在那儿注销
  });

  // 供 server.js（同进程内运行）访问窗口：全屏切换 / 快捷键热更新
  global.__wbWin = win;
  global.__wbRegisterShortcuts = registerShortcuts;

  // 托盘：窗口被快捷键收起来之后，除了 Dock / 任务栏，这是另一个找得回它的地方
  createTray();
  win.webContents.on("did-finish-load", syncTrayLang);
  win.on("focus", syncTrayLang);
  win.on("blur", syncTrayLang);

  // 桌面宠物：常驻角落显示 agent 在干什么，agent 要提问时跳给你看。
  // 放在窗口之后创建，这样它一出生 global.__wbWin 就是齐的（点它要唤起主窗口）。
  const pet = require(path.join(__dirname, "pet.js"));
  global.__openworkbuddyPet = pet;
  try {
    /**
     * 开机时把盘上那份原样交给宠物，一个字段都不许漏。
     *
     * 以前这儿手抄了五个字段，**偏偏漏掉了 sprite**。于是选了精灵图宠物的人，
     * 每次重开都变回内置那只猫：character 传成了 "sprite"，sprite 却是空字符串，
     * pet.js 拿空 id 去 findPet 自然找不着，create() 最后那行
     * `character: photo ? "photo" : sp ? "sprite" : "cat"` 就静静地落回 "cat"。
     *
     * 同一份名单还漏了 notifyDone 和 wander，scale 的兜底值也跟 pet.js 自己的
     * DEFAULT_SCALE 对不上（那边是 2，这里写死 1）——三处都是同一个病：
     * 手抄一份字段清单，加字段的人不会想到回来改它。
     * 所以现在整份摊过去，只把 enabled 单独钉死成「必须显式为 true」（没配过就不该有宠物），
     * 其余交给 pet.js 自己的默认值。以后加字段不用再动这里。
     */
    const petCfg = require(dataPath("config.json")).pet || {};
    pet.applyConfig({ ...petCfg, enabled: petCfg.enabled === true });
  } catch {
    pet.applyConfig({ enabled: false }); // 读不到配置就当没配过：默认不该有宠物
  }
  try {
    const shortcuts = require(dataPath("config.json")).shortcuts || {};
    registerShortcuts(shortcuts);
  } catch {
    registerShortcuts({});
  }
}).catch((e) => fatal("桌面窗口初始化", e));

/**
 * 把启动错误翻成一句用户能照着做的话。
 *
 * 这段文案是「什么都打不开」时用户手里唯一的线索，所以拎成具名函数，让 test/ 能直接切片测：
 * 错一个分支的代价不是排版难看，是用户对着一句「服务端崩了」重装三遍。
 */
/**
 * 右键菜单。Electron 默认**一个都没有**——桌面壳里右键点任何东西都是死的。
 *
 * 这不是「少个锦上添花的功能」：网页里右键图片选「复制图片」是所有人的肌肉记忆，
 * 到了桌面版按下去什么都不弹，用户的结论只会是「这软件的图导不出去」。
 * 而图恰恰是最该导出去的产出——生成完了就是要粘进微信、粘进 PPT。
 *
 * copyImageAt 是 Electron 自带的：按坐标把那张图以**系统原生位图**写进剪贴板，
 * 不走网页那条 canvas 转码的路，所以不挑格式、不掉画质，粘到哪儿都认。
 */
function contextMenuItems(params, t, wc) {
  const items = [];
  if (params.mediaType === "image" && params.srcURL) {
    items.push({ label: t.copyImage, click: () => wc.copyImageAt(params.x, params.y) });
    items.push({ label: t.copyImageURL, click: () => clipboard.writeText(params.srcURL) });
    items.push({ type: "separator" });
  }
  if (params.selectionText) {
    items.push({ label: t.copy, role: "copy" });
    if (params.isEditable) items.push({ label: t.cut, role: "cut" });
  }
  if (params.isEditable) {
    items.push({ label: t.paste, role: "paste" });
    items.push({ label: t.selectAll, role: "selectAll" });
  }
  // 链接单独一条：模型写出来的汇报里全是链接，想存一条下来以前只能手抄
  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    if (items.length) items.push({ type: "separator" });
    items.push({ label: t.copyLink, click: () => clipboard.writeText(params.linkURL) });
    items.push({ label: t.openInBrowser, click: () => shell.openExternal(params.linkURL) });
  }
  return items;
}

/**
 * 界面语言存在渲染进程的 localStorage 里（owb-lang），主进程读不到，所以张嘴问一句。
 * 问不到就退回系统语言——右键菜单绝不能因为这一问失败就弹不出来。
 */
async function uiLang(wc) {
  try {
    const v = await wc.executeJavaScript('(function(){try{return localStorage.getItem("owb-lang")||""}catch(e){return ""}})()', true);
    if (v === "en" || v === "zh") return (LAST_UI_LANG = v); // 记一份：界面卡死时弹框要用，那会儿问不着
  } catch {}
  return osLang();
}

function attachContextMenu(wc) {
  wc.on("context-menu", async (_e, params) => {
    const items = contextMenuItems(params, T(await uiLang(wc)), wc);
    if (!items.length) return;   // 没什么可做的就别弹一个空菜单
    if (wc.isDestroyed()) return; // 问语言这一下是异步的，这中间窗口可能已经关了
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || undefined });
  });
}

/**
 * 界面进程卡死、或者干脆没了，得有人接。
 *
 * Electron 默认什么都不做：进程没了窗口里就是一片白，卡死了就一直转圈，用户唯一的办法是强退整个应用——
 * 而服务端和后台任务都跑在主进程里，强退会把它们一起带走。这里只动界面那一层：问他一句。
 *   · 卡死：「重新加载」还是「再等等」。不替他挑——渲染一大段内容时卡几秒是会自己缓过来的，
 *     而重载会丢掉输入框里还没发出去的字。选了再等等、30 秒后还没缓过来，再问一次。
 *     缓过来了（responsive）就把还挂着的框收掉，别让他对着一个已经没事的窗口做选择。
 *   · 没了：只剩「重新加载」和「先不管」两条——进程已经不在了，「再等等」等不来任何东西。
 *     不自动重载：一加载就崩的页面会重载成死循环，框一个接一个弹。
 * 卡死时重载得先把旧进程掐掉（forcefullyCrashRenderer），不然 reload 排在卡住的进程后面永远轮不到；
 * 掐的那一下也会报一次「没了」，那是自己掐的，不算事故，不再弹框——重载就等它报上来再做：
 * 实测 Electron 43，掐完紧跟着 reload 不会起新进程，窗口停在一片白，之后也再没有任何事件，
 * 而那一下「没了」又被当成自己掐的咽了，用户选了重新加载，拿到的是一个永远白着、也不再问他的窗口。
 * 弹框的字用上一次问到的界面语言（LAST_UI_LANG）：这时候渲染进程已经答不了话了。
 */
function attachCrashGuard(w) {
  const wc = w.webContents;
  let open = null;       // 正挂着的那个框 { kind, ctl }，同一时刻只留一个
  let hung = false;      // 卡着还没缓过来
  let recheck = null;    // 选了「再等等」之后的复查
  let killWait = null;   // 为了重载自己掐了进程、正等它报「没了」：这段时间里报上来的那一下是自己掐的
  const lang = () => LAST_UI_LANG || osLang();
  const afterKill = () => {
    clearTimeout(killWait);
    killWait = null;
    if (!w.isDestroyed()) wc.reload();
  };
  const reload = (kill) => {
    if (w.isDestroyed()) return;
    if (!kill) return wc.reload();
    // 「没了」一直不来（进程早就不在了之类），5 秒后照样重载，别让窗口干白着
    killWait = setTimeout(afterKill, 5000);
    try { wc.forcefullyCrashRenderer(); } catch { afterKill(); }
  };
  const ask = async (kind, reason) => {
    if (w.isDestroyed()) return;
    if (open && open.kind === kind) return;
    if (open) open.ctl.abort(); // 卡死的框还挂着、进程却没了：换成「没了」的那个框
    const t = T(lang());
    const mine = { kind, ctl: new AbortController() };
    open = mine;
    const gone = kind === "gone";
    try {
      const { response } = await dialog.showMessageBox(w, {
        type: "warning",
        title: "OpenWorkBuddy",
        message: gone ? t.goneTitle : t.hungTitle,
        detail: gone ? `${t.goneDetail}\n\n${t.reasonLabel}${reason || "unknown"}` : t.hungDetail,
        buttons: [t.reloadBtn, gone ? t.laterBtn : t.waitBtn],
        defaultId: gone ? 0 : 1, // 卡死时回车默认是「再等等」：不丢东西的那条
        cancelId: 1,
        noLink: true, // Windows 上别画成命令链接
        signal: mine.ctl.signal,
      });
      if (mine.ctl.signal.aborted) return; // 被收掉的框（缓过来了 / 换了一个框），它的回答不算数
      if (response === 0) {
        bootLog(`界面${gone ? "没了" : "卡死"}：用户选了重新加载`);
        hung = false;
        reload(!gone);
      } else if (!gone) {
        bootLog("界面卡死：用户选了再等等");
        clearTimeout(recheck);
        recheck = setTimeout(() => { recheck = null; if (hung) ask("hung"); }, 30000);
        if (recheck && recheck.unref) recheck.unref();
      }
    } catch (e) {
      bootLog("▲ 界面兜底的弹框没弹出来：" + String((e && e.message) || e));
    } finally {
      if (open === mine) open = null;
    }
  };
  wc.on("did-finish-load", () => { uiLang(wc); }); // 页面好好的时候问一句语言，存下来备用
  wc.on("unresponsive", () => {
    hung = true;
    bootLog("▲ 界面没有响应");
    ask("hung");
  });
  wc.on("responsive", () => {
    hung = false;
    clearTimeout(recheck);
    recheck = null;
    bootLog("界面缓过来了");
    if (open && open.kind === "hung") open.ctl.abort();
  });
  wc.on("render-process-gone", (_e, details) => {
    const reason = (details && details.reason) || "";
    hung = false;
    clearTimeout(recheck);
    recheck = null;
    if (killWait) return afterKill(); // 自己掐的：不弹框，这时候才重载
    if (reason === "clean-exit") return; // 关窗、退应用时的正常退出，不是事故
    bootLog(`▲ 界面进程没了：${reason}（exitCode ${details && details.exitCode}）`);
    ask("gone", reason);
  });
}

/**
 * 启动失败页上那句大标题该写什么。
 *
 * 开机闸门（boot-check.js）已经查出来的三种死法——Node 太老、源码版依赖没装、装机版缺文件——
 * 它自己就带着一句该怎么修，原样用就行。以前这儿一律走下面的 bootHint 去**猜**：那些判据认的是
 * "Cannot find module"、"EADDRINUSE" 这些英文报错，而闸门给的是中文人话，一条都对不上，于是
 * 最知道该怎么修的三种情况，页面上写的全是「服务端启动时崩了，把这行贴到 issue 里」。
 */
function bootAdvice(err, msg, port, t) {
  var bp = err && err.bootProblem;
  return bp && bp.fix ? bp.fix : bootHint(msg, port, t);
}

function bootHint(msg, port, t) {
  msg = String(msg || "");
  if (/Cannot find module/.test(msg))
    return t.hintMissingFiles;
  // 数据目录建不起来要排在下面两条端口分支前面：它报的也是 EACCES，但换端口一点用没有。
  // 用 mkdir/copyfile 这些系统调用名跟 listen EACCES 区分开——两者的解法完全不同。
  if (/数据目录|EROFS|ENOSPC|\b(mkdir|copyfile|scandir|unlink|rmdir)\b/.test(msg) && !/listen/.test(msg))
    return t.hintDataDir;
  // EACCES 要排在 EADDRINUSE 前面：两者都是「端口用不了」，但解法不同，
  // 前者换个端口就好，后者得去关掉占用的程序。
  if (/EACCES|EPERM/.test(msg))
    return t.hintPortDenied(port);
  // 走到这儿说明连着往后试十个口也全被占着——本机版一般不会有这一天，
  // 绑的不是本机地址时（Docker / 服务器）端口是运维定死的，压根不自动换。
  if (/EADDRINUSE|端口/.test(msg))
    return t.hintPortBusy(port);
  if (/EADDRNOTAVAIL/.test(msg))
    return t.hintHostGone;
  return t.hintCrashed;
}

/**
 * 启动失败时，把窗口亮出来说清楚哪儿坏了。
 * 不这么做的话表现是「双击没反应」——用户唯一能做的就是重装，而重装治不好装机包缺文件。
 * 页面用 data: URL 直接塞，因为这会儿 HTTP 服务端正是那个起不来的东西。
 */
function showBootFailure(err) {
  const lang = osLang();
  const t = T(lang);
  const msg = String((err && err.message) || err || t.unknownError);
  const hint = bootAdvice(err, msg, PORT, t);
  // 闸门查出来的病因，红框里只放那一句结论就够了；解法已经当大标题写在上面，重复一遍反而更长
  const detail = (err && err.bootProblem && err.bootProblem.title) || msg;
  // 这一页上所有要他动手的东西都得给出确切位置：写「用户目录的 OpenWorkBuddy/config.json」，
  // 等于让一个已经卡在门外的人自己去猜用户目录在哪，而 Windows 和 macOS 还不是一个地方
  const CFG = (() => { try { return dataPath("config.json"); } catch (e) { return t.cfgFallback; } })();
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const html = `<!doctype html><html lang="${lang === "en" ? "en" : "zh-CN"}"><meta charset="utf-8"><title>${esc(t.failTitle)}</title>
<style>
 body{margin:0;font:14px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff;
      display:flex;align-items:center;justify-content:center;height:100vh}
 .box{max-width:560px;padding:0 32px}
 h1{font-size:20px;margin:0 0 12px}
 p{margin:0 0 16px;color:#57606a}
 pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:12px 14px;overflow:auto;
     font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cf222e;white-space:pre-wrap}
 a{color:#0969da}
 .small{font-size:12px;color:#8b949e}
 code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f8fa;padding:1px 5px;border-radius:4px}
</style>
<div class=box>
 <h1>${esc(t.failTitle)}</h1>
 <p>${esc(hint)}</p>
 <pre>${esc(detail)}</pre>
 <p class=small>${esc(t.gpuTip1)}<code>"disable_gpu": true</code>${esc(t.gpuTip2)}<code>${esc(CFG)}</code>${esc(t.gpuTip3)}<code>server</code>${esc(t.gpuTip4)}</p>
 <p class=small>${esc(t.bootLogForIssue)}<code>${esc(BOOT_LOG || t.logUnwritable)}</code></p>
 <p>${esc(t.versionLabel)} ${esc(require("./package.json").version)} · <a href="https://github.com/CatCatUncle/openworkbuddy/issues" target="_blank">${esc(t.openIssue)}</a></p>
</div>`;
  // 连窗口都没有，就退到系统级报错框，别把原因吞掉——「双击没反应」就是这么来的
  if (!win || win.isDestroyed()) return fatal("启动", err);
  FATAL_SHOWN = true;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.show();
  win.focus();
}

/**
 * 设置页存的键 → Electron 认的加速键写法。两边不是一套词：
 *   · 设置页（app-02.js 的 SHORTCUT_DEFS / accelFromEvent）：Mod = 这台机器的主修饰键，Meta = ⌘ / Win 键，
 *     键名照抄 KeyboardEvent.code 去掉 Key/Digit 前缀（Comma、BracketLeft、ArrowUp、Numpad1……），
 *     默认键还可能写成「mac 那份|其他平台那份」；
 *   · Electron：CommandOrControl / Command / Super / Control，键名是 "," "[" "Up" "num1"。
 * 对不上的那个键 register 会直接抛，被 catch 吞掉，用户看到的就是「改了键、按了没反应」。
 * 以前这里只换了 Meta→Command、Ctrl→Control：Windows 上 Meta 换成 Command 是个不存在的键，
 * 默认键哪天用上 Mod 也会整条注册不上。
 */
function electronAccel(a, mac) {
  let s = String(a || "");
  if (s.includes("|")) s = s.split("|")[mac ? 0 : 1] || "";
  const MOD = { mod: "CommandOrControl", meta: mac ? "Command" : "Super", cmd: "Command", command: "Command", super: "Super",
    ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift", commandorcontrol: "CommandOrControl", cmdorctrl: "CommandOrControl" };
  const KEY = { Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
    BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult", NumpadDivide: "numdiv", NumpadDecimal: "numdec", NumpadEnter: "Enter" };
  const out = [];
  for (const p of s.split("+").map((x) => x.trim()).filter(Boolean)) {
    const m = MOD[p.toLowerCase()];
    const k = m || KEY[p] || p.replace(/^Numpad(\d)$/, "num$1");
    if (!out.includes(k)) out.push(k);
  }
  return out.join("+");
}

/** 全局快捷键（系统级，仅「唤起/隐藏主窗口」需要）；设置页改绑后由 server.js 调用热更新 */
function registerShortcuts(shortcuts) {
  try {
    globalShortcut.unregisterAll();
    const accel = electronAccel((shortcuts || {})["toggle-window"] || "Shift+Alt+W", process.platform === "darwin");
    const ok = globalShortcut.register(accel, () => {
      if (!win) return;
      if (win.isVisible() && win.isFocused()) win.hide();
      else {
        win.show();
        win.focus();
      }
    });
    // 返回 false 不抛：这个组合键系统没给。记一笔，不然日志里看不出按了没反应是为什么
    if (!ok) bootLog(`▲ 全局快捷键 ${accel} 没注册上，系统没接这个组合键`);
  } catch (e) {
    console.warn("[快捷键] 全局快捷键注册失败:", e.message);
  }
}

// ---------- 退出：先问、再收尾、最后才放行 ----------
const SHUTDOWN_WAIT_MS = 3000; // 叫停任务之后最多等这么久让它们自己收尾，过了就直接杀子进程
const SYS_QUIT_REARM_MS = 60000; // 系统说要关机之后这么久还活着，就当关机被取消了（见 letSystemQuit）

/**
 * 以用户本人的身份问服务端一句。服务端就跑在这个进程里，但任务表（server.js 的 activeRuns）
 * 是它模块里的局部变量，壳够不着，只能走 HTTP。登录令牌是界面那个 session 上的 HttpOnly cookie，
 * 从 cookie 罐里取出来带上。问不到（没登录、服务端没起来、端口上是别的实例、超时）一律回 null：
 * 退出这条路不许因为这一问卡住。
 */
async function apiCall(method, pathname, body) {
  if (!SERVER_OWN) return null;
  try {
    const base = `http://127.0.0.1:${PORT}`;
    const jar = await session.defaultSession.cookies.get({ url: base });
    const headers = {};
    const cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    if (cookie) headers.cookie = cookie;
    if (body) headers["content-type"] = "application/json";
    const r = await fetch(base + pathname, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(1500),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** 正在跑的任务（会话 id）。口径跟页面刷新后接回任务那份一样：只算当前登录的这个人的 */
async function runningTasks() {
  const ids = await apiCall("GET", "/api/chat/running");
  return Array.isArray(ids) ? ids : [];
}

/**
 * `ps -A -ww -o pid=,ppid=,pgid=,args=` 的输出 → 这个进程底下该送走的那些。
 * 刨掉 Electron 自己的进程（GPU / 渲染 / 网络，连同它们底下的，得留给 Electron 自己收）：
 *   · 命令行带 --type= 的——Chromium 的子进程都这么起，这条最准；
 *     光靠 keep（getAppMetrics）不够：真 Electron 43 实测刚启动那一阵 GPU 进程还没进 metrics 表；
 *   · keep 里的，和崩溃上报进程。
 * 不能按「跟主进程同一个可执行文件」刨：服务端用 ELECTRON_RUN_AS_NODE 拿 Electron 二进制跑脚本，
 * 那些正是要收的。groups 是子孙里自立门户（detached）的进程组组长：按组杀才能把
 * 已经过继给 init 的孙子一起带走——模型跑的 `npm run dev` 就是这么脱钩的。
 */
function childTree(psOut, root, keep) {
  const rows = [];
  for (const line of String(psOut || "").split(/\r?\n/)) { // PowerShell 吐的是 \r\n，行尾那个 \r 会让下面的 $ 对不上
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], cmd: m[4] });
  }
  const skip = new Set(keep || []);
  const mine = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) {
      if (mine.has(r.pid) || !mine.has(r.ppid) || skip.has(r.pid)) continue;
      if (/\s--type=[a-z-]+/.test(r.cmd) || /crashpad/i.test(r.cmd)) continue;
      mine.add(r.pid);
      grew = true;
    }
  }
  mine.delete(root);
  const groups = rows.filter((r) => mine.has(r.pid) && r.pgid === r.pid).map((r) => r.pid);
  return { pids: [...mine], groups };
}

/**
 * 把还挂在这个进程底下的子进程送走：MCP 服务、叫停时没跟着走的命令、评测、ffmpeg……
 * 任务被叫停时各自已经在杀自己那棵树了，这一步收的是漏网的——不收的话应用退了，
 * 它们还在后台占着端口和 CPU，下次启动 MCP 还会撞上自己的上一辈。返回送走了几个，只为记日志。
 */
function killChildren(sig) {
  const cp = require("child_process");
  const keep = [];
  try { for (const m of app.getAppMetrics()) keep.push(m.pid); } catch {}
  try {
    if (process.platform === "win32") {
      // Windows 没有进程组、也没有 ps：PowerShell 列出直接子进程（带命令行，好认出 --type= 的 Electron 自家进程），
      // taskkill /T 连孙子一起带走。不分先礼后兵，一律 /F：走到这一步已经给过它们 3 秒了
      const r = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | ForEach-Object { [string]$_.ProcessId + ' ${process.pid} 0 ' + $_.Name + ' ' + $_.CommandLine }`],
      { encoding: "utf8", timeout: 5000, windowsHide: true });
      const { pids } = childTree(r.stdout, process.pid, keep.concat(r.pid || []));
      for (const p of pids) {
        try { cp.spawnSync("taskkill", ["/PID", String(p), "/T", "/F"], { timeout: 5000, windowsHide: true, stdio: "ignore" }); } catch {}
      }
      return pids.length;
    }
    // -ww：不截断命令行，--type= 在很长的一串参数后面
    const r = cp.spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,args="], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
    const { pids, groups } = childTree(r.stdout, process.pid, keep.concat(r.pid || []));
    for (const g of groups) { try { process.kill(-g, sig); } catch {} }
    for (const p of pids) { try { process.kill(p, sig); } catch {} }
    return pids.length;
  } catch (e) {
    bootLog("▲ 清子进程出错：" + String((e && e.message) || e));
    return 0;
  }
}

/**
 * 统一的收尾，谁要退都走它，而且只走一遍（第二次来要的拿到的是同一个 Promise）：
 *   1. 叫服务端停掉在跑的任务（跟用户点「让我停下」同一条路：/api/chat/stop）；
 *   2. 等它们收尾，最多 SHUTDOWN_WAIT_MS；
 *   3. 不管等没等完，把还挂着的子进程送走：先 SIGTERM，半秒后还在的 SIGKILL。
 * 以前关窗就是 app.quit()：任务停在半截，写到一半的文件、跑到一半的命令都没人收，
 * MCP 服务和模型起的开发服务器在后台接着跑，下次打开端口还被自己占着。
 */
function shutdown() {
  if (SHUTDOWN) return SHUTDOWN;
  SHUTDOWN = (async () => {
    const t0 = Date.now();
    let gaveUp = false;
    const settle = (async () => {
      const ids = await runningTasks();
      if (!ids.length) return;
      bootLog(`退出：叫停 ${ids.length} 个在跑的任务`);
      await Promise.all(ids.map((id) => apiCall("POST", "/api/chat/stop", { sessionId: id })));
      while (!gaveUp) {
        if (!(await runningTasks()).length) return;
        await new Promise((r) => setTimeout(r, 150));
      }
    })().catch(() => {});
    let timer = null;
    const late = await Promise.race([
      settle.then(() => false),
      new Promise((r) => { timer = setTimeout(() => r(true), SHUTDOWN_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    gaveUp = true;
    if (late) bootLog(`▲ 退出：等了 ${SHUTDOWN_WAIT_MS}ms 任务还没收完，不等了`);
    const termed = killChildren("SIGTERM");
    let killed = 0;
    if (termed) {
      await new Promise((r) => setTimeout(r, 500));
      killed = killChildren("SIGKILL"); // 重新列一遍：半秒里走掉的不会再挨一下，pid 被别人复用了也伤不着
    }
    bootLog(`退出收尾完：用时 ${Date.now() - t0}ms，子进程 ${termed} 个${killed ? `（其中 ${killed} 个不肯走，硬杀）` : ""}`);
  })().catch((e) => bootLog("▲ 退出收尾出错：" + String((e && e.message) || e)));
  return SHUTDOWN;
}

/**
 * 所有「要退出」的入口都走这一个：关主窗口、⌘Q / Alt+F4、Dock 右键退出、托盘「退出」。
 * 有任务在跑就先问一句——关窗和退出是顺手一点的事，而中断的是跑了半小时的活儿。
 * 回车默认是「先不退」：不丢东西的那条。没有任务就不打扰，直接收尾退出。
 * 框挂着的时候再点一次关闭 / 再按一次 ⌘Q 不叠第二个框。
 */
async function requestQuit() {
  if (QUIT_STATE === "done") return app.quit();
  if (QUIT_STATE) return;
  QUIT_STATE = "asking";
  try {
    const n = (await runningTasks()).length;
    if (n > 0) {
      const t = T(LAST_UI_LANG || osLang());
      const w = win && !win.isDestroyed() ? win : null;
      if (w) { if (w.isMinimized()) w.restore(); w.show(); } // 框挂在窗口上：窗口收着的话框也跟着看不见
      const opts = { type: "warning", title: "OpenWorkBuddy", message: t.quitBusy(n), buttons: [t.quitBtn, t.stayBtn], defaultId: 1, cancelId: 1, noLink: true };
      const { response } = await (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts));
      if (response !== 0) {
        QUIT_STATE = "";
        bootLog(`退出：${n} 个任务在跑，用户选了先不退`);
        return;
      }
    }
    QUIT_STATE = "closing";
    await shutdown();
  } catch (e) {
    bootLog("▲ 退出前的确认 / 收尾出错，照样退：" + String((e && e.message) || e));
  }
  QUIT_STATE = "done";
  app.quit();
}

// ⌘Q、Dock 右键退出、系统菜单的退出，都先到这儿。只注册这一次：两个 before-quit 各拦各的，
// 一个放行了另一个还在拦，退出就成了死循环
app.on("before-quit", (e) => {
  if (QUIT_STATE === "done") return;
  e.preventDefault();
  requestQuit();
});

// ---------- 托盘 ----------
/** 托盘菜单就三条：显示窗口 / 新建任务 / 退出。字从 SHELL_TEXT 来 */
function trayMenuItems(t, act) {
  return [
    { label: t.trayShow, click: act.show },
    { label: t.trayNewTask, click: act.newTask },
    { type: "separator" },
    { label: t.trayQuit, click: act.quit },
  ];
}

function showMainWindow() {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

function refreshTray(lang) {
  if (!tray || tray.isDestroyed()) return;
  // 语言没变就不动：窗口失焦、鼠标划过托盘都会来问一次，而 Windows 上右键托盘的那一下主窗口正好失焦——
  // 菜单开着的时候把它整个换掉，开着的那份点下去可能落空
  const lng = (lang || LAST_UI_LANG || osLang()) === "en" ? "en" : "zh";
  if (lng === trayLang) return;
  const t = T(lng);
  tray.setToolTip(t.trayTip);
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems(t, {
    show: showMainWindow,
    // 跟页面里 ⌘N 按的是同一颗「新建任务」按钮：新建要清哪些状态由页面说了算，这里不另抄一份
    newTask: () => {
      if (!showMainWindow()) return;
      win.webContents.executeJavaScript('(function(){var b=document.getElementById("new-task");if(b)b.click();})()', true).catch(() => {});
    },
    quit: () => requestQuit(),
  })));
  trayLang = lng; // 换成了才记：中途抛了的话下回还会再换
}

/** 托盘菜单的字跟着界面语言走。网页切语言不刷新页面、也不告诉主进程，只能在这几个时候问一句 */
function syncTrayLang() {
  if (win && !win.isDestroyed()) uiLang(win.webContents).then(refreshTray, () => {});
}

function createTray() {
  if (tray) return;
  try {
    // 图标用 public/ 那张（装机包里有，build/ 不进包）。给 1x 和 2x 两份，Retina 屏上不糊
    const src = nativeImage.createFromPath(path.join(__dirname, "public", "favicon.png"));
    const img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1, buffer: src.resize({ width: 16, height: 16, quality: "best" }).toPNG() });
    img.addRepresentation({ scaleFactor: 2, buffer: src.resize({ width: 32, height: 32, quality: "best" }).toPNG() });
    tray = new Tray(img);
    refreshTray();
    // Windows / Linux 的习惯是单击托盘图标就把窗口叫出来、右键才出菜单；macOS 单击就是出菜单
    if (process.platform !== "darwin") tray.on("click", showMainWindow);
    // macOS 上点状态栏图标不会让窗口失焦，鼠标移上去那一下再问一次语言（Linux 没有这个事件，靠窗口焦点那两下）
    tray.on("mouse-enter", syncTrayLang);
  } catch (e) {
    tray = null;
    bootLog("▲ 托盘图标没建起来（不影响使用）：" + String((e && e.message) || e));
  }
}

app.on("will-quit", () => {
  // 系统关机那条路不走 shutdown（不拦它），子进程至少发一声 SIGTERM，别留在后台
  if (!SHUTDOWN) killChildren("SIGTERM");
  try {
    globalShortcut.unregisterAll();
  } catch {}
  try {
    if (global.__openworkbuddyPet) global.__openworkbuddyPet.destroy();
  } catch {}
  try {
    if (tray) tray.destroy(); // Windows 上不收的话，退出后托盘里会留一个鼠标划过才消失的空图标
  } catch {}
});

// 点 Dock 图标（macOS）/ 点任务栏图标要能把界面叫回来。
// 没有这一段的时候：窗口一最小化或者按快捷键藏起来，Dock 图标就成了摆设——点它什么都不发生，
// 用户只能去戳桌面宠物才能把主界面调出来，而宠物默认还是关着的，等于彻底找不回来。
// Electron 在 macOS 上不会自己 show 窗口，activate 事件得应用自己接。
app.on("activate", () => {
  if (!win || win.isDestroyed()) return; // 窗口还没建出来/已经销毁：启动流程或 closed 分支会管，这里别插手
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// 兜底。真正管退出的是主窗口的 close / closed（见上面）——那条不挑窗口数量，
// 宠物开着照样退。这条只在宠物关着（默认就是关着）时顺带触发一次；requestQuit 放行过之后再来就是直接退，重复无害。
// 启动失败页那条路窗口上没挂 close 的闸，关掉它走的是这里：服务端没起来，问不出在跑的任务，直接收尾退出
app.on("window-all-closed", () => requestQuit());
