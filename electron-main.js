"use strict";
/** Electron 桌面壳 — 启动内嵌服务并打开桌面窗口。运行：npm run app */

const BOOT_T0 = Date.now(); // 启动分段计时：哪段慢一眼看清，别靠体感猜
const { app, BrowserWindow, dialog, shell, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { dataPath, seedDataDir, resolvePort } = require("./paths");

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

/**
 * 启动阶段的每一声崩溃都得有个出口。
 * 没有这个出口的表现就是 issue #1：进程活着、窗口不出现、用户手里一条线索都没有。
 * 窗口已经在了就把原因画进窗口；窗口还没有就弹系统级报错框——它不需要窗口也能显示。
 */
function fatal(stage, err) {
  const msg = String((err && (err.stack || err.message)) || err || "未知错误");
  bootLog(`✗ ${stage}：${msg}`);
  if (PAGE_UP || FATAL_SHOWN) return; // 已经跑起来了，或者已经报过一次，不重复打扰
  FATAL_SHOWN = true;
  if (win && !win.isDestroyed()) return showBootFailure(err);
  const show = () => {
    try {
      dialog.showErrorBox(
        "OpenWorkBuddy 没能启动",
        `${bootHint(msg, PORT)}\n\n${msg.split("\n")[0]}\n\n启动日志：${BOOT_LOG || "（日志文件写不出来）"}`
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
// ⚠️ 白名单里只有我们自己用过的精确名字：同级还躺着腾讯官方 WorkBuddy 的目录，绝不能碰。
const LEGACY_USERDATA = ["openbuddy", "workbuddy-clone"];
// 显示名叫 OpenWorkBuddy（「关于」面板、系统通知的署名），但 userData 目录钉死在 openworkbuddy：
// app.setName 会连带把 userData 改成 appData/OpenWorkBuddy，那等于第三次改名、用户又被登出一次
app.setPath("userData", path.join(app.getPath("appData"), "openworkbuddy"));
app.setName("OpenWorkBuddy");
app.setAboutPanelOptions({ applicationName: "OpenWorkBuddy", applicationVersion: require("./package.json").version, copyright: "MIT · github.com/CatCatUncle/openworkbuddy" });
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
        dialog.showErrorBox(
          "OpenWorkBuddy 已经在运行了，但窗口没出来",
          `后台还留着一个卡住的 OpenWorkBuddy 进程，它占着单实例锁，所以新的一次启动被挡住了。\n\n先到任务管理器（macOS 活动监视器）里结束 OpenWorkBuddy 进程，再重新打开。\n\n启动日志：${BOOT_LOG || "（日志文件写不出来）"}`
        );
      } catch {}
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
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
  // 窗口先开（秒响应），服务端在同进程内随后启动，就绪即加载页面。
  // 顺序反过来的话，用户要盯着 Dock 图标空等服务端把路由全注册完。
  win = new BrowserWindow({
    width: 1520,
    height: 900,
    minWidth: 680,
    minHeight: 480,
    title: "OpenWorkBuddy",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    show: false, // 页面渲染好了再亮相（ready-to-show），不给用户看白屏；下面有兜底定时防止永不出现
    webPreferences: {
      backgroundThrottling: false, // 窗口隐藏（快捷键收起）时任务还在流式回报，计时器不许被降频
    },
  });

  // 首绘打磨：正常流程 ready-to-show 在 ~0.7s 内到，一次干净的整页亮相；
  // 服务端起不来时它可能永远不触发，3 秒兜底强制亮窗，让用户看到报错而不是什么都没有。
  // ⚠️ 这段必须排在 require("./server.js") 前面。放后面的话，服务端 require 一抛异常，
  // 兜底定时器根本没来得及挂上，窗口就永远停在 show:false —— v0.1.1 装机包缺 engines/
  // 时用户看到的正是这个：任务管理器里有进程，屏幕上什么都没有。
  const showOnce = () => { if (win && !win.isVisible()) { win.show(); } };
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
  win.webContents.once("did-finish-load", () => {
    // 过了这条线就算启动成功了：再有偶发异常只记日志，不能把用户正在做的事掐掉换成报错页
    PAGE_UP = true;
    clearTimeout(watchdog);
    bootLog("页面加载完成 ✓ 启动成功");
  });
  // 用 127.0.0.1 而不是 localhost：有些机器（改过 hosts、或者 IPv6 优先）会把 localhost 解析到 ::1，
  // 而服务端只监听了 IPv4，表现就是窗口一直空白。
  win.loadURL(`http://127.0.0.1:${PORT}`);

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 供 server.js（同进程内运行）访问窗口：全屏切换 / 快捷键热更新
  global.__wbWin = win;
  global.__wbRegisterShortcuts = registerShortcuts;

  // 桌面宠物：常驻角落显示 agent 在干什么，agent 要提问时跳给你看。
  // 放在窗口之后创建，这样它一出生 global.__wbWin 就是齐的（点它要唤起主窗口）。
  const pet = require(path.join(__dirname, "pet.js"));
  global.__wbPet = pet;
  try {
    const petCfg = require(dataPath("config.json")).pet || {};
    pet.applyConfig({ enabled: petCfg.enabled === true, scale: petCfg.scale || 1, opacity: petCfg.opacity || 1, notify: petCfg.notify !== false, character: petCfg.character || "cat" });
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
function bootHint(msg, port) {
  msg = String(msg || "");
  if (/Cannot find module/.test(msg))
    return "安装包里少了文件。到 GitHub Releases 重新下载最新版本覆盖安装即可；如果最新版仍然这样，请把下面这行贴到 issue 里。";
  // 数据目录建不起来要排在下面两条端口分支前面：它报的也是 EACCES，但换端口一点用没有。
  // 用 mkdir/copyfile 这些系统调用名跟 listen EACCES 区分开——两者的解法完全不同。
  if (/数据目录|EROFS|ENOSPC|\b(mkdir|copyfile|scandir|unlink|rmdir)\b/.test(msg) && !/listen/.test(msg))
    return "放数据的文件夹建不起来（默认在用户目录下的 OpenWorkBuddy）。常见原因是公司电脑把用户目录重定向到了连不上的网络盘，或者磁盘满了。设一个环境变量 OPENWORKBUDDY_HOME 指向本机一个能写的文件夹（比如 D:\\OpenWorkBuddy）再打开。";
  // EACCES 要排在 EADDRINUSE 前面：两者都是「端口用不了」，但解法不同，
  // 前者换个端口就好，后者得去关掉占用的程序。
  if (/EACCES|EPERM/.test(msg))
    return `没权限使用端口 ${port}。Windows 上多半是 Hyper-V / WSL 预留了这段端口（命令行跑 netsh interface ipv4 show excludedportrange protocol=tcp 能看到保留段），把用户目录下 OpenWorkBuddy/config.json 里的 server.port 换成一个没被预留的（比如 3810）再打开。`;
  // 走到这儿说明连着往后试十个口也全被占着——本机版一般不会有这一天，
  // 绑的不是本机地址时（Docker / 服务器）端口是运维定死的，压根不自动换。
  if (/EADDRINUSE|端口/.test(msg))
    return `端口 ${port} 被占了，往后连试十个也都被占着。关掉占用它们的程序，或者把用户目录下 OpenWorkBuddy/config.json 里的 server.port 换一个。`;
  if (/EADDRNOTAVAIL/.test(msg))
    return "配置里的 server.host 在这台机器上不存在了（换过网络之后常见）。把用户目录下 OpenWorkBuddy/config.json 里的 server.host 改回 127.0.0.1 再打开。";
  return "服务端启动时崩了。把下面这行贴到 GitHub issue 里，附上你的系统版本。";
}

/**
 * 启动失败时，把窗口亮出来说清楚哪儿坏了。
 * 不这么做的话表现是「双击没反应」——用户唯一能做的就是重装，而重装治不好装机包缺文件。
 * 页面用 data: URL 直接塞，因为这会儿 HTTP 服务端正是那个起不来的东西。
 */
function showBootFailure(err) {
  const msg = String((err && err.message) || err || "未知错误");
  const hint = bootHint(msg, PORT);
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>OpenWorkBuddy 启动失败</title>
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
 <h1>OpenWorkBuddy 没能启动</h1>
 <p>${esc(hint)}</p>
 <pre>${esc(msg)}</pre>
 <p class=small>还可以试：窗口一直不出现、或者整片黑，多半是显卡驱动画不出来——在用户目录的
   OpenWorkBuddy/config.json 里给 <code>server</code> 加一行 <code>"disable_gpu": true</code> 再打开。</p>
 <p class=small>启动日志（贴 issue 时带上它）：<code>${esc(BOOT_LOG || "写不出来")}</code></p>
 <p>版本 ${esc(require("./package.json").version)} · <a href="https://github.com/CatCatUncle/openworkbuddy/issues" target="_blank">提 issue</a></p>
</div>`;
  // 连窗口都没有，就退到系统级报错框，别把原因吞掉——「双击没反应」就是这么来的
  if (!win || win.isDestroyed()) return fatal("启动", err);
  FATAL_SHOWN = true;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.show();
  win.focus();
}

/** 全局快捷键（系统级，仅「唤起/隐藏主窗口」需要）；设置页改绑后由 server.js 调用热更新 */
function registerShortcuts(shortcuts) {
  try {
    globalShortcut.unregisterAll();
    const accel = String((shortcuts || {})["toggle-window"] || "Shift+Alt+W")
      .replace(/\bMeta\b/g, "Command")
      .replace(/\bCtrl\b/g, "Control");
    globalShortcut.register(accel, () => {
      if (!win) return;
      if (win.isVisible() && win.isFocused()) win.hide();
      else {
        win.show();
        win.focus();
      }
    });
  } catch (e) {
    console.warn("[快捷键] 全局快捷键注册失败:", e.message);
  }
}

app.on("will-quit", () => {
  try {
    globalShortcut.unregisterAll();
  } catch {}
  try {
    if (global.__wbPet) global.__wbPet.destroy();
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

// 主窗口关掉就退出。宠物是个挂件不是窗口，不能让它把进程吊在那儿——
// 所以这里盯的是主窗口的 closed，而不是 window-all-closed（宠物还开着时它永远不触发）。
app.on("window-all-closed", () => app.quit());
