// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Windows 上怎么把一个「npm 装出来的命令」真正起起来。
 *
 * 三件事在 Windows 上跟别的系统不一样，任何一件没做，本机引擎（claude / codex）
 * 就是「设置页显示已装，一点就报错」，用户只会得出「这软件在 Windows 上用不了」：
 *
 * 1) npm 在 Windows 上装出来的不是可执行文件，是一个 claude.cmd 垫片。
 *    Node 从 18.20.2 / 20.12 起（CVE-2024-27980）不再允许直接 spawn .cmd/.bat，
 *    会当场 EINVAL。所以必须绕开它。
 *
 * 2) 绕开的常规办法是 `cmd.exe /d /s /c "..."`，但 cmd 的命令行**总长上限 8191 个字符**，
 *    而我们要给 claude 传的 --append-system-prompt 动辄上万字，还带换行。
 *    也就是说：走 cmd 这条路，参数一长就必然截断/失败，而且报出来的错跟真实原因八竿子打不着。
 *    所以第一选择是把垫片拆开——.cmd 里写着的就是「用 node 跑某个 cli.js」，
 *    我们直接 spawn 那个 node + cli.js，参数按 argv 原样传（上限 32767，且不过 shell），
 *    长提示词、换行、引号、& | ^ 全都不用操心。
 *
 * 3) 实在拆不开（第三方垫片格式没见过）才退回 cmd.exe，并按 cmd 的规矩转义。
 *    这条路仍然有 8191 的上限，所以它只是兜底，不是主路。
 */

const fs = require("fs");
const path = require("path");
// Windows 的路径一律用 path.win32 拼：这几个函数只在 Windows 上真跑，
// 但测试要在 mac/Linux 上验它们，用平台默认的 path 会把反斜杠当普通字符
const wpath = path.win32;

const isWin = () => process.platform === "win32";
/** .cmd / .bat 才是「不能直接 spawn」的那种；.exe 和无后缀的照常起 */
const isBatch = (bin) => /\.(cmd|bat)$/i.test(String(bin || ""));

/**
 * 把 npm / pnpm / yarn 的 .cmd 垫片拆开，找出它真正要跑的那个 .js。
 *
 * 三家的垫片长得不一样，但都逃不掉一句「<node> "<某个目录>\xxx.js" %*」，
 * 目录那一段写成 %dp0% 或 %~dp0（= 垫片自己所在的目录）。所以不去逐家匹配格式，
 * 只找带这个前缀、以 .js 结尾的那个带引号的串，逐个验一下文件在不在。
 *
 * @returns {string} 绝对路径；拆不开返回 ""
 */
function shimScript(cmdPath, io = fs) {
  let text = "";
  try { text = io.readFileSync(cmdPath, "utf8"); } catch { return ""; }
  const dir = wpath.dirname(cmdPath);
  const hits = text.match(/"[^"\r\n]*%~?dp0%?[^"\r\n]*?\.js"/gi) || [];
  for (const raw of hits) {
    const rel = raw.slice(1, -1).replace(/%~?dp0%?/gi, dir + "\\");
    // %dp0% 自带结尾反斜杠，垫片里又写了一个，于是路径里会出现 \\；顺手抹平
    const file = wpath.normalize(rel.replace(/\\{2,}/g, "\\"));
    try { if (io.statSync(file).isFile()) return file; } catch {}
  }
  return "";
}

/**
 * 找一个能跑 .js 的 node。
 *
 * 顺序跟 npm 垫片自己的逻辑一致：先看垫片旁边有没有随包带的 node.exe，
 * 再看我们补全过的 PATH。都没有就用自己这个进程的可执行文件——桌面版里它是
 * Electron，加上 ELECTRON_RUN_AS_NODE=1 就是一个纯 node（tools.js 跑脚本用的也是这招），
 * 这样用户哪怕没单独装 node，本机引擎照样起得来。
 */
function pickNode(shimDir, { findIn, searchDirs }, io = fs) {
  const sibling = wpath.join(shimDir, "node.exe");
  try { if (io.statSync(sibling).isFile()) return { bin: sibling, asNode: false }; } catch {}
  const onPath = findIn(searchDirs(), "node");
  if (onPath) return { bin: onPath, asNode: false };
  return { bin: require("./electron-bridge").nodeExec(), asNode: true }; // 自己就是 node（Electron 需要 RUN_AS_NODE；服务进程里换回应用本体）
}

/** cmd 会另眼相看的字符（与 cross-spawn 同一份清单） */
const META = /([()\[\]%!^"`<>&|;, *?])/g;

/** cmd.exe 的转义（兜底那条路才用）。算法同 cross-spawn：先按 argv 规矩转，再把元字符用 ^ 挡掉 */
function escapeArg(arg, doubleEscape) {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"');   // 引号前的反斜杠要翻倍，引号本身转义
  s = s.replace(/(\\*)$/, "$1$1");        // 结尾的反斜杠也要翻倍，不然会吃掉收尾的引号
  s = `"${s}"`;
  s = s.replace(META, "^$1");
  if (doubleEscape) s = s.replace(META, "^$1"); // .cmd 会被 cmd 再解析一遍（%* 展开），所以转两道
  return s;
}

/** cmd 一条命令行最多 8191 个字符，超了不是截断就是起不来 */
const CMD_MAX = 8191;

/**
 * 这一次到底该 spawn 什么。
 *
 * @returns {{bin:string, args:string[], opts:object, how:string, warn:string}}
 *   how: "直接" | "拆垫片" | "cmd 兜底"
 */
function launchPlan(bin, args = [], deps = {}) {
  const win = deps.win === undefined ? isWin() : deps.win;
  const io = deps.io || fs;
  const base = { bin, args: args.slice(), opts: {}, env: {}, how: "直接", warn: "" };
  if (!win) {
    base.opts = { detached: true }; // 自成进程组，收尾时才杀得干净
    return base;
  }
  // Windows：detached 会给子进程开一个自己的控制台黑窗口——桌面应用每跑一个任务弹一个，
  // 而且它并不像 Unix 那样能靠进程组一锅端（收尾走 taskkill /T）。所以这里明确不要。
  base.opts = { windowsHide: true };
  if (!isBatch(bin)) return base;

  const which = deps.which || require("./which");
  const script = (deps.shimScript || shimScript)(bin, io);
  if (script) {
    const node = (deps.pickNode || pickNode)(wpath.dirname(bin), which, io);
    return {
      bin: node.bin,
      args: [script, ...args],
      opts: { windowsHide: true },
      // 桌面版里 execPath 是 Electron 本体，不加这个会再弹一个应用实例出来而不是当 node 用
      env: node.asNode ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      how: "拆垫片",
      warn: "",
    };
  }
  // 兜底：交给 cmd.exe。参数长了它扛不住，这里把话说明白，别让用户去猜
  const line = [escapeArg(wpath.normalize(bin), false), ...args.map((a) => escapeArg(a, true))].join(" ");
  return {
    bin: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    opts: { windowsHide: true, windowsVerbatimArguments: true },
    env: {},
    how: "cmd 兜底",
    warn: line.length + 8 > CMD_MAX
      ? `${wpath.basename(bin)} 的启动垫片解析不了，只能经 cmd.exe 起；而这次的参数有 ${line.length} 字符，超过 cmd 的 8191 上限，多半会失败。装一个 node 到 PATH 上，或在设置里把引擎路径填成 .exe/.js 的真身`
      : "",
  };
}

/**
 * execFile 的跨平台版：只要输出、等它退出的那种短命令（--help、debug models）用它。
 * 直接 execFile 一个 .cmd 垫片，新版 Node 当场抛 EINVAL（不许不经 shell 起批处理），
 * 设置页的模型候选就整个拿不到；而且不带 windowsHide 每探一次闪一个黑窗口。
 * 起不来时照 execFile 的规矩回调 err，不往外抛。
 */
function execFile(bin, args, opts, cb, deps = {}) {
  const plan = launchPlan(bin, args, deps);
  const o = { ...(opts || {}), ...plan.opts };
  delete o.detached; // 等它退出就完事，用不着自成进程组
  if (Object.keys(plan.env).length) o.env = { ...((opts && opts.env) || process.env), ...plan.env };
  const run = deps.execFile || require("child_process").execFile;
  try {
    return run(plan.bin, plan.args, o, cb);
  } catch (e) {
    process.nextTick(() => cb(e, "", ""));
    return null;
  }
}

/** 杀掉整棵进程树。Windows 没有进程组这一说，用 taskkill /T；别的系统按进程组发信号 */
function killTree(child, signal, deps = {}) {
  const win = deps.win === undefined ? isWin() : deps.win;
  const spawn = deps.spawn || require("child_process").spawn;
  if (!child || !child.pid) return;
  if (win) {
    const args = ["/pid", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F"); // 先礼后兵：第一下不带 /F，给它写完文件的机会
    try { spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => {}); } catch {}
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

/**
 * 进程树快照。按进程组杀、taskkill /T 有两种够不着：
 *   · 自立门户的子孙（detached 起的、setsid 的，比如脚本拉起的浏览器）：不在引擎那个进程组里；
 *   · 中间那层先退了的：孤儿过继出去（macOS 给 1 号进程，Linux 常给 systemd --user 这类收养进程），
 *     顺着父进程再也找不到（Windows 上 taskkill /T 也是顺着父进程找）。
 * 所以跑着的时候隔一阵拍一张「引擎底下都有谁」，记下 pid、父进程和启动时刻；停的时候按记下来的逐个杀。
 * 杀之前核对：pid 还在、启动时刻没变、父进程还是记下的那个；父进程换了，只认「原来那个父进程已经没了」（过继给谁不管）——
 * pid 被系统复用给了别的进程就对不上，不杀。只认记下来的 pid，绝不按名字、按模式杀。
 * 拍不到的不猜：两张快照之间起了又立刻过继出去的（双 fork 的守护进程）这里收不到。
 */
const WIN_PS = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }";
function psCommand(win) {
  return win
    ? { bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WIN_PS] }
    : { bin: "ps", args: ["-A", "-o", "pid=,ppid=,lstart="] };
}
/** ps / PowerShell 的输出 → pid → { ppid, start }。启动时刻原样当字符串比（ps 的 lstart 精确到秒，Windows 是 FILETIME） */
function parseProcs(text) {
  const out = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), start: m[3].replace(/\s+/g, " ") });
  }
  return out;
}
const PS_OPTS = { windowsHide: true, timeout: 15000, maxBuffer: 32 << 20, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } };
/** 眼下系统里的进程。拿不到就是空表：空表对不上任何记录，一个都不杀 */
function listProcs(deps = {}) {
  if (deps.list) return Promise.resolve(deps.list());
  const { bin, args } = psCommand(deps.win === undefined ? isWin() : deps.win);
  const run = deps.execFile || require("child_process").execFile;
  return new Promise((resolve) => {
    try { run(bin, args, { ...PS_OPTS, windowsHide: true }, (err, stdout) => resolve(err ? new Map() : parseProcs(stdout))); }
    catch { resolve(new Map()); }
  });
}
/** 同步版：进程马上要退出（killAll）时用，等不到回调 */
function listProcsSync(deps = {}) {
  if (deps.list) return deps.list();
  const { bin, args } = psCommand(deps.win === undefined ? isWin() : deps.win);
  const run = deps.execFileSync || require("child_process").execFileSync;
  try { return parseProcs(run(bin, args, { ...PS_OPTS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })); } catch { return new Map(); }
}
/** procs 里 root 底下的整棵树（不含 root 自己） */
function treeOf(rootPid, procs) {
  const kids = new Map();
  for (const [pid, p] of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(pid);
  }
  const out = new Map();
  const stack = [...(kids.get(rootPid) || [])];
  while (stack.length) {
    const pid = stack.pop();
    if (pid === rootPid || out.has(pid) || !procs.has(pid)) continue;
    out.set(pid, procs.get(pid));
    for (const k of kids.get(pid) || []) stack.push(k);
  }
  return out;
}
/** 按 pid 杀一个（连它底下的）。Windows 走 taskkill /T，别的系统直接发信号 */
function killPid(pid, signal, deps = {}) {
  const win = deps.win === undefined ? isWin() : deps.win;
  if (win) {
    const spawn = deps.spawn || require("child_process").spawn;
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    try { spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => {}); } catch {}
    return;
  }
  try { (deps.kill || process.kill)(pid, signal); } catch {}
}
/**
 * 盯一棵进程树。snap() 拍一张并进记录（异步，不卡事件循环）；kill(signal, procs?) 先把眼下这棵树并进来，
 * 再按记录逐个核对了杀。根进程自己不在这里杀，那是 killTree 的事
 */
function treeWatch(rootPid, deps = {}) {
  const seen = new Map(); // pid → { ppid, start }
  let busy = null;
  const merge = (procs) => { for (const [pid, p] of treeOf(rootPid, procs)) seen.set(pid, p); return procs; };
  /** 记下的父进程眼下还在不在（pid 被复用了也算不在）。根进程没记启动时刻，只看 pid */
  const gone = (ppid, procs) => {
    const now = procs.get(ppid);
    if (!now) return true;
    const was = seen.get(ppid);
    return !!was && now.start !== was.start;
  };
  /** 记录里眼下还对得上的 pid */
  const match = (procs) => {
    merge(procs);
    const out = [];
    for (const [pid, was] of seen) {
      const now = procs.get(pid);
      if (!now || now.start !== was.start) continue; // 没了，或者 pid 被别的进程复用了
      if (now.ppid !== was.ppid && !gone(was.ppid, procs)) continue; // 原来的父进程还在、它却换了父进程：不是我们那个
      out.push(pid);
    }
    return out;
  };
  return {
    seen,
    match,
    snap() {
      if (!busy) busy = listProcs(deps).then(merge).finally(() => { busy = null; });
      return busy;
    },
    kill(signal, procs) {
      const go = (ps) => { const pids = match(ps); for (const pid of pids) killPid(pid, signal, deps); return pids; };
      return procs ? Promise.resolve(go(procs)) : listProcs(deps).then(go);
    },
    killSync(signal) {
      if (!seen.size && (deps.win === undefined ? isWin() : deps.win)) return []; // Windows 上 taskkill /T 已经顺着父进程收了眼下这棵树，没记录就不用再列一遍
      const pids = match(listProcsSync(deps));
      for (const pid of pids) killPid(pid, signal, deps);
      return pids;
    },
  };
}

module.exports = { isWin, isBatch, shimScript, pickNode, escapeArg, launchPlan, execFile, killTree, CMD_MAX, parseProcs, treeOf, treeWatch };
