"use strict";
/** Electron 桌面壳 — 启动内嵌服务并打开桌面窗口。运行：npm run app */

const BOOT_T0 = Date.now(); // 启动分段计时：哪段慢一眼看清，别靠体感猜
const { app, BrowserWindow, shell, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");

// 改过两次名（workbuddy-clone → openbuddy → openworkbuddy）。Electron 的 userData 目录跟着
// package.json 的 name 走，不搬家的话老用户会丢 localStorage（表现为莫名其妙被登出）。
// 按时间倒序找最近的一个旧目录搬过来，只在新目录不存在时搬一次。
// ⚠️ 白名单里只有我们自己用过的精确名字：同级还躺着腾讯官方 WorkBuddy 的目录，绝不能碰。
const LEGACY_USERDATA = ["openbuddy", "workbuddy-clone"];
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

const PORT = (() => {
  try {
    return require(path.join(__dirname, "config.json")).server.port || 3800;
  } catch {
    return 3800;
  }
})();

let win;

// 单实例：双击启动器/重复 npm run app 时，把已开的窗口拉到前台，而不是再叠一个实例
// （第二个实例的服务端会撞端口走"连接已运行实例"分支，结果就是两个窗口两份 Dock 图标）
if (!app.requestSingleInstanceLock()) {
  app.exit(0); // 立即退出：app.quit() 是异步的，慢一步的话 whenReady 还会抢跑建出第二个窗口
} else {
  app.on("second-instance", () => {
    if (!win) return;
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
  console.log(`[启动] Electron 就绪 +${Date.now() - BOOT_T0}ms`);
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

  // 在 Electron 主进程内直接启动服务端
  require(path.join(__dirname, "server.js"));

  // 首绘打磨：正常流程 ready-to-show 在 ~0.7s 内到，一次干净的整页亮相；
  // 服务端起不来时它可能永远不触发，3 秒兜底强制亮窗，让用户看到报错而不是什么都没有
  const showOnce = () => { if (win && !win.isVisible()) { win.show(); } };
  win.once("ready-to-show", () => { console.log(`[启动] 窗口亮相 +${Date.now() - BOOT_T0}ms`); showOnce(); });
  setTimeout(showOnce, 3000);

  await waitForServer(`http://localhost:${PORT}/api/info`);
  console.log(`[启动] 服务端就绪 +${Date.now() - BOOT_T0}ms`);
  win.webContents.once("did-finish-load", () => console.log(`[启动] 页面加载完成 +${Date.now() - BOOT_T0}ms`));
  win.loadURL(`http://localhost:${PORT}`);

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
    const petCfg = require(path.join(__dirname, "config.json")).pet || {};
    pet.applyConfig({ enabled: petCfg.enabled === true, scale: petCfg.scale || 1, opacity: petCfg.opacity || 1, notify: petCfg.notify !== false, character: petCfg.character || "cat" });
  } catch {
    pet.applyConfig({ enabled: false }); // 读不到配置就当没配过：默认不该有宠物
  }
  try {
    const shortcuts = require(path.join(__dirname, "config.json")).shortcuts || {};
    registerShortcuts(shortcuts);
  } catch {
    registerShortcuts({});
  }
});

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

// 主窗口关掉就退出。宠物是个挂件不是窗口，不能让它把进程吊在那儿——
// 所以这里盯的是主窗口的 closed，而不是 window-all-closed（宠物还开着时它永远不触发）。
app.on("window-all-closed", () => app.quit());
