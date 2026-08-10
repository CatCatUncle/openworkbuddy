"use strict";
/** Electron 桌面壳 — 启动内嵌服务并打开桌面窗口。运行：npm run app */

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

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

app.whenReady().then(async () => {
  // 在 Electron 主进程内直接启动服务端
  require(path.join(__dirname, "server.js"));

  win = new BrowserWindow({
    width: 1520,
    height: 900,
    minWidth: 680,
    minHeight: 480,
    title: "OpenWorkBuddy",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
  });

  await waitForServer(`http://localhost:${PORT}/api/info`);
  win.loadURL(`http://localhost:${PORT}`);

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 供 server.js（同进程内运行）访问窗口：全屏切换 / 快捷键热更新
  global.__wbWin = win;
  global.__wbRegisterShortcuts = registerShortcuts;
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
});

app.on("window-all-closed", () => app.quit());
