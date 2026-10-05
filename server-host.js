// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 独立服务进程的入口：electron-main.js 用 utilityProcess.fork 拉起它，它再 require server.js。
 *
 * 2026-09-29 审计：几个对话一起跑时主进程事件循环 p99 68ms、最长 330ms——SSE 推流、工具调用、
 * 大 JSON 解析跟窗口重绘抢同一条线程，用户原话「开几个对话整个应用连带电脑都卡」。
 * 服务端挪到这里以后，主进程只剩窗口、托盘、菜单。
 *
 * 以前 server.js 在主进程里 require，它跟壳之间靠几根全局变量说话（__wbOnListen、__wbBootFail、
 * __wbWin、__openworkbuddyPet、__wbRegisterShortcuts）。这里把同名的几根接上，另一头换成
 * 发消息给主进程——server.js 一行不用知道自己跑在哪个进程里。
 *
 * 这个文件不在 require 链上（主进程按路径 fork），装机包白名单靠 scripts/check-package-files.js 的 ENTRIES 盯着。
 */

const path = require("path");
const bridge = require("./src/platform/electron-bridge");

let LISTENING = false;
let STOPPING = false;

const errText = (e) => String((e && (e.stack || e.message)) || e);

/** 起不来：原因交回主进程（它会退回在自己进程里跑，那边会把同一个错画在窗口上） */
function bootFail(e) {
  console.error("[服务进程] 启动失败:", errText(e));
  if (!bridge.send({ t: "boot", ok: false, error: bridge.serializeError(e) })) process.exit(1);
}

// 起来之前的异常 = 启动失败；起来之后的，照主进程里跑时的规矩只记一笔（electron-main.js 的 fatal 过了 PAGE_UP 也只记日志）。
// 不接的话 utilityProcess 默认直接退出——几个正在跑的对话一起断，比以前在主进程里还脆
process.on("uncaughtException", (e) => {
  if (!LISTENING) return bootFail(e);
  console.error("[服务进程] 未捕获异常（已记下，服务继续）:", errText(e));
});
process.on("unhandledRejection", (e) => {
  if (!LISTENING) return bootFail(e);
  console.error("[服务进程] 有个没人接的 Promise 拒绝:", String((e && /** @type {any} */ (e).message) || e));
});

// ---------- 退出：先把自己底下的子进程送走，再走 server.js 自己的 SIGINT 收尾（停 MCP） ----------
/** posix：ps 列一遍，自己底下的子孙（连同自立门户的进程组）先 SIGTERM，半秒后还在的 SIGKILL */
async function reapDescendants() {
  if (process.platform === "win32") return 0; // Windows 上由主进程按父进程号 taskkill /T（electron-main.js killChildren）
  const cp = require("child_process");
  const list = () => {
    // 不加 windowsHide：Windows 在函数开头就 return 了
    const r = cp.spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 5000 });
    const rows = [];
    for (const line of String(r.stdout || "").split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
      if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3] });
    }
    const mine = new Set([process.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of rows) if (!mine.has(x.pid) && mine.has(x.ppid) && x.pid !== r.pid) { mine.add(x.pid); grew = true; }
    }
    mine.delete(process.pid);
    return { pids: [...mine], groups: rows.filter((x) => mine.has(x.pid) && x.pgid === x.pid).map((x) => x.pid) };
  };
  const hit = (sig) => {
    const { pids, groups } = list();
    for (const g of groups) { try { process.kill(-g, sig); } catch {} }
    for (const p of pids) { try { process.kill(p, sig); } catch {} }
    return pids.length;
  };
  const n = hit("SIGTERM");
  if (n) { await new Promise((r) => setTimeout(r, 500)); hit("SIGKILL"); }
  return n;
}

function stop(why) {
  if (STOPPING) return;
  STOPPING = true;
  // 兜底：收尾本身卡住也得退，主进程那边等不到还会再杀一次
  setTimeout(() => process.exit(0), 3000);
  console.log(`[服务进程] 收到退出（${why}），收尾中`);
  reapDescendants()
    .catch(() => 0)
    .then(() => {
      if (process.listenerCount("SIGINT") > 0) process.emit(/** @type {any} */ ("SIGINT"));
      else process.exit(0);
    });
}
process.on("SIGTERM", () => stop("SIGTERM"));
bridge.onCtl((op) => { if (op === "shutdown") stop("主进程要求"); });

// ---------- 数据根对账 ----------
// 装机版的数据根要靠「是不是装机包」来定，而 utilityProcess 里 app.isPackaged 问不到（paths.js 改用 OWB_PACKAGED）。
// 两边算出来的不一样就是会读错账号、会话的那种错——不将就，交回主进程在它自己那儿跑
const dataDir = path.resolve(require("./src/platform/paths").DATA_DIR);
const shellDataDir = process.env.OWB_DATA_DIR ? path.resolve(process.env.OWB_DATA_DIR) : dataDir;
if (dataDir !== shellDataDir) {
  bootFail(new Error(`服务进程算出来的数据目录（${dataDir}）跟主进程的（${shellDataDir}）不一样`));
  setTimeout(() => process.exit(1), 200);
} else {
  start();
}

function start() {
  // 测试用的故障开关（test/server-process.js 验退回主进程那条路）。平时不设，不影响任何行为
  const fault = process.env.OWB_SERVER_FAULT || "";
  if (fault === "crash-on-boot") { console.error("[服务进程] OWB_SERVER_FAULT=crash-on-boot，按测试要求直接退出"); process.exit(3); }
  if (fault === "no-listen") { console.error("[服务进程] OWB_SERVER_FAULT=no-listen，按测试要求不启动服务"); setInterval(() => {}, 60000); return; }

  global.__wbBootFail = (e) => bootFail(e);
  global.__wbOnListen = (port, meta) => {
    LISTENING = true;
    bridge.send({ t: "listening", port, reused: !!(meta && meta.reused) });
  };
  global.__wbRegisterShortcuts = (s) => { bridge.notify("shortcuts.register", s || {}); };

  // 主窗口：server.js 只用它做全屏切换（/api/app/fullscreen）。全屏状态主进程一变就推过来
  const winProxy = {
    isDestroyed: () => !bridge.state().winAlive,
    isFullScreen: () => !!bridge.state().fullScreen,
    setFullScreen: (on) => { bridge.notify("win.setFullScreen", { on: !!on }); },
  };
  const syncWin = (s) => { global.__wbWin = s && s.winAlive ? winProxy : null; };
  syncWin(bridge.state());
  bridge.onState(syncWin);

  // 桌面宠物活在主进程里（它是个窗口）。server.js 用到的就这几个动作，全是「做了就行」
  if (bridge.caps().pet) {
    global.__openworkbuddyPet = {
      setState: (state, text) => { bridge.notify("pet.setState", { state, text }); },
      alertAsk: (question) => { bridge.notify("pet.alertAsk", { question }); },
      clearAsk: (stillWorking) => { bridge.notify("pet.clearAsk", { stillWorking: !!stillWorking }); },
      applyConfig: (c) => { bridge.notify("pet.applyConfig", c || {}); },
      show: () => { bridge.notify("pet.show"); },
      hide: () => { bridge.notify("pet.hide"); },
      isVisible: () => false,
      destroy: () => {},
    };
  }

  // 审批提醒（窗口没聚焦时 Dock 跳一下）：审批队列在这个进程里，提醒的手在主进程
  try {
    require("./security").watchApprovals((m) => {
      if (m && m.type === "open") bridge.notify("approval.open", { type: "open" });
    });
  } catch {}

  bridge.send({ t: "hello", pid: process.pid, dataDir, packaged: process.env.OWB_PACKAGED === "1" });
  require(path.join(__dirname, "server.js"));
}
