// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 找到本机那个 CLI 到底在哪。
 *
 * 为什么这层非有不可：**双击图标启动的桌面版，拿到的 PATH 是残废的。**
 * macOS 上 Finder / Dock 启动的进程只继承 `/usr/bin:/bin:/usr/sbin:/sbin`——
 * 用户明明装了 claude 和 codex，设置页照样两条都写「本机没装」。实测过：
 *   env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin node -e 'detectAll()'
 *   → claude-code ❌ 本机没装 / codex ❌ 本机没装
 * 而同一台机器上 `which claude` = ~/.local/bin/claude、`which codex` = /opt/homebrew/bin/codex。
 * 从终端 `npm start` 起的能用、双击 App 起的用不了，这就是「别人装了却用不上」的真身。
 *
 * 三级找法，从快到慢，找到就停：
 *   ① 用户自己填的绝对路径 —— 填了就只认它，找不到要如实报错，不许悄悄换一个能跑的
 *   ② 补全过的 PATH —— homebrew / .local/bin / bun / volta / nvm / fnm / npm 全局前缀
 *   ③ 问用户自己的登录 shell（zsh -lic 'command -v claude'）—— 版本管理器五花八门，
 *      与其把每一种的目录结构都猜一遍，不如让 shell 自己回答。慢（几百毫秒），所以垫底并缓存。
 *
 * 引擎（claude / codex）走的是 resolveNewest：②里找到不止一份时不停在第一个，挑版本最新的，
 * 见文件末尾那一节——不然双击启动的 App 会用上 homebrew 里那份没人升级的旧版。
 *
 * 缓存按「名字 + 显式路径」记，forget() 清掉——用户在设置页点「重新检测」时清一次，
 * 不然刚装完 CLI 的人得重启整个应用才看得见。
 *
 * Windows 没有登录 shell 可问，对应的那一步是现读注册表里的 PATH（refreshWinPath）：
 * 安装器改的是注册表，正在跑的进程看不到，见下面那一节。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const WIN = process.platform === "win32";
/** Windows 上可执行文件不是靠权限位认的，靠后缀 */
const WIN_EXT = [".cmd", ".exe", ".bat", ""];

/** 列出一个目录下所有子目录，读不到就当空——探测阶段任何一步都不许把整个流程搞挂 */
function subdirs(dir) {
  try { return fs.readdirSync(dir).map((n) => path.join(dir, n)); } catch { return []; }
}

/**
 * winget 装的 poppler 在哪。它是免安装包，pdftotext.exe 和一堆 dll 放在同一个目录里，
 * winget 不往 Links 里放快捷方式，而是把 Packages\oschwartz10612.Poppler_…\poppler-25.07.0\Library\bin
 * 写进注册表 PATH。注册表没读成、或者用户还没点「重新检测」时，就靠这里直接去目录里找。
 * 版本号倒序，新的先试。
 * @param {string} root WinGet\Packages 目录
 * @param {{readdirSync:(d:string)=>string[]}} io 测试里换成假的
 */
function popplerBins(root, io) {
  const wp = path.win32;
  /** @param {string} d */
  const names = (d) => { try { return io.readdirSync(d).map(String); } catch { return []; } };
  const out = [];
  for (const pkg of names(root).filter((n) => /poppler/i.test(n)).sort().reverse()) {
    for (const ver of names(wp.join(root, pkg)).filter((n) => /^poppler/i.test(n)).sort().reverse()) {
      out.push(wp.join(root, pkg, ver, "Library", "bin"));
    }
  }
  return out;
}

/**
 * PATH 之外还该看的地方。全是「装完之后要改 shell 配置才进 PATH」的位置——
 * 也正是 GUI 启动时一定看不到的那些。
 * platform / env / io 只给测试用：Windows 那一支要在 mac 上也验得到。
 * @param {string} [platform]
 * @param {Record<string, string|undefined>} [env]
 * @param {{readdirSync:(d:string)=>string[]}} [io]
 */
function extraDirs(platform = process.platform, env = process.env, io = fs) {
  const home = os.homedir();
  const j = (...p) => path.join(home, ...p);
  if (platform === "win32") {
    const wp = path.win32;
    const user = env.USERPROFILE || home;
    const local = env.LOCALAPPDATA || wp.join(user, "AppData", "Local");
    const out = [];
    if (env.APPDATA) out.push(wp.join(env.APPDATA, "npm"));
    if (env.LOCALAPPDATA) out.push(wp.join(env.LOCALAPPDATA, "Programs"));
    out.push(wp.join(user, ".bun", "bin"), wp.join(user, "AppData", "Local", "Volta", "bin"));
    // 下面这几处是体检和报错里让用户「winget install …」装出来的东西真正落脚的地方。
    // 不列进来的话，照着我们给的命令装完，「重新检测」照样报没装——等于我们自己给的路走不通：
    //   ffmpeg（Gyan.FFmpeg）是免安装包，winget 在 WinGet\Links 里放快捷方式，再改注册表 PATH；
    //   加了 --scope machine 的落在 Program Files\WinGet\Links；
    //   LibreOffice 的安装器根本不改 PATH，soffice.exe 只在 Program Files\LibreOffice\program 里，重启也找不到；
    //   pandoc 默认装在 %LOCALAPPDATA%\Pandoc；scoop 装的东西都在 shims 里（SCOOP 改过位置就跟着它）
    out.push(wp.join(local, "Microsoft", "WinGet", "Links"));
    if (env.ProgramFiles) out.push(wp.join(env.ProgramFiles, "WinGet", "Links"));
    out.push(wp.join(env.SCOOP || wp.join(user, "scoop"), "shims"));
    if (env.ProgramFiles) out.push(wp.join(env.ProgramFiles, "LibreOffice", "program"));
    out.push(wp.join(local, "Pandoc"));
    out.push(...popplerBins(wp.join(local, "Microsoft", "WinGet", "Packages"), io));
    return out;
  }
  const out = [
    "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/snap/bin",
    j(".local", "bin"), j("bin"),
    j(".bun", "bin"), j(".deno", "bin"),
    j(".volta", "bin"), j(".yarn", "bin"),
    j(".npm-global", "bin"), j(".npm-packages", "bin"),
  ];
  // nvm / fnm：每个 node 版本一套全局包，`npm i -g @anthropic-ai/claude-code` 装进的是
  // 当时那个版本的 bin 里。版本号倒序排，新的先试——用户一般在最新那个上装
  for (const d of subdirs(j(".nvm", "versions", "node")).sort().reverse()) out.push(path.join(d, "bin"));
  const fnmRoots = [j("Library", "Application Support", "fnm", "node-versions"), j(".local", "share", "fnm", "node-versions")];
  for (const root of fnmRoots) for (const d of subdirs(root).sort().reverse()) out.push(path.join(d, "installation", "bin"));
  return out;
}

/** 在不在 WindowsApps 里（应用执行别名放的地方） */
const IN_WINDOWS_APPS = /[\\/]WindowsApps[\\/]/i;

/**
 * 这个文件能不能直接跑起来。
 *
 * Windows 上 WindowsApps 里放的是「应用执行别名」（winget.exe、python.exe、python3.exe 都是），
 * 一种特殊的重解析点：stat 跟过去会报错，可它确实跑得起来。所以那个目录里 stat 不成时，
 * 退回 lstat 看它在不在。在不等于真能用：python.exe 也可能是应用商店的占位程序，
 * 这里不管真假，交给调用方真跑一下（doctor 的 probePython 带 -c 1 跑）。别处 stat 不成的照旧算跑不起来。
 * findIn 只把别名当最后一招：PATH 上别处有真文件就先用真文件。
 * platform / io 只给测试用：Windows 那一支要在 Mac 上也验得到
 * @param {string} file
 * @param {string} [platform]
 * @param {Pick<typeof fs, "statSync" | "lstatSync" | "accessSync">} [io]
 */
function runnable(file, platform = process.platform, io = fs) {
  if (!file) return false;
  const win = platform === "win32";
  /** @type {import("fs").Stats|null} */
  let st = null;
  try { st = io.statSync(file); } catch {}
  if (st && st.isFile()) {
    if (win) return true;
    try { io.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  }
  if (!win || !IN_WINDOWS_APPS.test(file)) return false;
  try { return !io.lstatSync(file).isDirectory(); } catch { return false; }
}

/** stat 拿得到的普通文件（不是别名） */
function plainFile(file, io) {
  try { return io.statSync(file).isFile(); } catch { return false; }
}

/**
 * 在给定目录里找一个可执行文件，返回绝对路径。
 *
 * Windows 上 WindowsApps 里的别名排在最后：python.exe 那种多半是应用商店的占位程序，
 * 而 WindowsApps 又常排在真 Python 前面。mcp.js 的 resolveWinCommand 拿到就直接起进程、不验真假，
 * 先撞上占位程序，MCP 服务就起不来。所以先按 PATH 顺序找真文件，一个都没有才退回第一个别名
 * （winget 这类只在 WindowsApps 里有的，照样找得到）。
 * @param {string[]} dirs
 * @param {string} name
 * @param {string} [platform] 测试用
 * @param {Pick<typeof fs, "statSync" | "lstatSync" | "accessSync">} [io] 测试用
 */
function findIn(dirs, name, platform = process.platform, io = fs) {
  const win = platform === "win32";
  const exts = win ? WIN_EXT : [""];
  const join = win ? path.win32.join : path.join;
  let alias = "";
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = join(d, name + ext);
      if (!runnable(p, platform, io)) continue;
      if (!win || plainFile(p, io)) return p;
      if (!alias) alias = p;
    }
  }
  return alias;
}

// ── Windows：注册表里那份 PATH ─────────────────────────────────────────────
//
// winget 和各家安装器装完东西，改的是注册表里的 PATH（系统一份、用户一份），正在跑的进程看不到——
// 服务进程手里一直是应用启动那一刻的 PATH。用户照我们给的 `winget install pandoc` 装好、点「重新检测本机」，
// 进程里的 PATH 还是老的，照样报没装，agent 的 run_shell 也照样找不到；只有重启整个应用才算数，
// 而没人会想到要重启。所以「重新检测」时现读一次注册表，记在这里；搜索路径、子进程的 PATH 都用合并后的。

/** 系统在前、用户在后：Windows 给新进程拼 PATH 就是这个顺序 */
const REG_KEYS = [
  { label: "系统", key: "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" },
  { label: "用户", key: "HKCU\\Environment" },
];
/** 读一把键最多等多久。reg.exe 平时几十毫秒；卡住了也不能把「重新检测」一起拖住 */
const REG_TIMEOUT_MS = 3000;

/** 最近一次读到的注册表 PATH（展开过的目录列表）。一次都没读成就是空的，只用启动时那份 */
let regDirs = /** @type {string[]} */ ([]);
/** @type {Promise<{dirs:string[], error:string}>|null} 同时来的几次刷新共用一趟 */
let regInflight = null;

/**
 * 从 `reg query <键> /v Path` 的输出里取出值。没有这一行返回 null。
 * 输出长这样（值可能是空的）：`    Path    REG_EXPAND_SZ    C:\a;%USERPROFILE%\b`
 * @param {string} text
 * @returns {string|null}
 */
function parseRegPath(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s+Path\s+REG_(?:EXPAND_)?SZ(?:\s+(.*))?$/i);
    if (m) return (m[1] || "").trim();
  }
  return null;
}

/**
 * %VAR% 按环境变量展开。Windows 的变量名不分大小写；展不开的原样留着，跟系统自己的做法一样。
 * @param {string} s
 * @param {Record<string, string|undefined>} env
 */
function expandWinVars(s, env) {
  /** @type {Record<string, string>} */
  const up = {};
  for (const k of Object.keys(env || {})) { const v = env[k]; if (v != null) up[k.toUpperCase()] = String(v); }
  return String(s).replace(/%([^%;]+)%/g, (all, name) => (Object.prototype.hasOwnProperty.call(up, String(name).toUpperCase()) ? up[String(name).toUpperCase()] : all));
}

/**
 * 一串 PATH 拆成目录。两头的空白、整段包着的引号都去掉；展开后还带 % 的（引用了一个不存在的变量）丢掉——
 * 那不是一个能去找文件的地方。
 * @param {string} s
 */
function splitWinPath(s) {
  return String(s || "").split(";").map((d) => d.trim().replace(/^"(.*)"$/, "$1").trim()).filter((d) => d && !d.includes("%"));
}

/** Windows 上两条路径算不算同一个：不分大小写，结尾的斜杠不算数 @param {string} d */
const winKey = (d) => d.toLowerCase().replace(/[\\/]+$/, "");

/**
 * 真去跑一次 reg query。输出按 out-decode 的规矩解：先当 UTF-8，不合法就按 GBK——
 * reg.exe 往管道里写的是系统代码页，中文系统上用户名是中文的话，按 UTF-8 解出来那一截路径就废了。
 * @param {string} key
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<string>}
 */
function regQuery(key, env) {
  return new Promise((resolve, reject) => {
    const exe = path.win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "reg.exe");
    const { execFile } = require("child_process");
    try {
      execFile(exe, ["query", key, "/v", "Path"], { windowsHide: true, timeout: REG_TIMEOUT_MS, encoding: "buffer" }, (err, stdout, stderr) => {
        const decode = (/** @type {Buffer} */ b) => {
          const d = require("../util/out-decode").outDecoder({ win: true });
          return d.write(b || Buffer.alloc(0)) + d.end();
        };
        if (err) {
          const said = decode(/** @type {Buffer} */ (stderr)).trim() || decode(/** @type {Buffer} */ (stdout)).trim();
          const why = /** @type {any} */ (err).killed ? `${REG_TIMEOUT_MS / 1000} 秒没读完` : (said || err.message);
          return reject(new Error(why));
        }
        resolve(decode(/** @type {Buffer} */ (stdout)));
      });
    } catch (e) { reject(e); }
  });
}

/**
 * 现读一次注册表里的 PATH，展开、合并、记下来。「重新检测本机」和 doctor 会调；非 Windows 什么都不做。
 *
 * 两把键各读各的：一把读不成，另一把照样算数。读不成的写进返回的 error，并打一行日志——
 * 不能悄悄吞掉：吞了的话用户看到的就是「装了还是找不到」，而且一点线索都没有。
 * 一把都没读成时保留上一次的结果，不拿空的覆盖掉。读完清掉 resolveBin 的缓存：之前「没找到」的结论作废了。
 *
 * @param {{platform?:string, env?:Record<string, string|undefined>, regQuery?:(key:string, env:Record<string, string|undefined>)=>Promise<string>, log?:(msg:string)=>void}} [deps]
 * @returns {Promise<{dirs:string[], error:string}>}
 */
function refreshWinPath(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== "win32") return Promise.resolve({ dirs: [], error: "" });
  if (regInflight) return regInflight;
  const env = deps.env || process.env;
  const run = deps.regQuery || regQuery;
  const log = deps.log || ((/** @type {string} */ m) => console.warn(m));
  const p = (async () => {
    const got = await Promise.all(REG_KEYS.map(async ({ label, key }) => {
      try {
        const v = parseRegPath(await run(key, env));
        return v == null ? { label, dirs: null, error: "输出里没有 Path 这一项" } : { label, dirs: splitWinPath(expandWinVars(v, env)), error: "" };
      } catch (e) {
        return { label, dirs: null, error: String((e && /** @type {any} */ (e).message) || e) };
      }
    }));
    const errs = got.filter((g) => g.error).map((g) => `${g.label} PATH：${g.error}`);
    if (got.some((g) => g.dirs)) {
      const seen = new Set();
      /** @type {string[]} */
      const dirs = [];
      for (const g of got) for (const d of g.dirs || []) { const k = winKey(d); if (!seen.has(k)) { seen.add(k); dirs.push(d); } }
      regDirs = dirs;
      cache.clear();
    }
    const error = errs.join("；");
    if (error) log("[PATH] 注册表里的 PATH 没读全，这次只按读到的找：" + error);
    return { dirs: regDirs.slice(), error };
  })();
  regInflight = p;
  p.finally(() => { if (regInflight === p) regInflight = null; }).catch(() => {});
  return p;
}

/**
 * Windows 的完整搜索路径：注册表那份在前（新起一个进程拿到的就是它，跟「重启一下应用」效果一样），
 * 启动时那份里注册表没有的（启动它的那个终端自己加的）跟在后面，最后是常见安装位置。
 * @param {Record<string, string|undefined>} env
 */
function winSearchDirs(env) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const add = (d) => { if (!d) return; const k = winKey(d); if (seen.has(k)) return; seen.add(k); out.push(d); };
  for (const d of regDirs) add(d);
  for (const d of String(env.PATH || env.Path || "").split(";")) add(d.trim());
  for (const d of extraDirs("win32", env)) add(d);
  return out;
}

/**
 * PATH + 补全目录，去重后的完整搜索路径
 * @param {string} [platform] 测试用
 * @param {Record<string, string|undefined>} [env] 测试用
 */
function searchDirs(platform = process.platform, env = process.env) {
  if (platform === "win32") return winSearchDirs(env);
  const cur = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const seen = new Set(cur);
  const out = cur.slice();
  for (const d of extraDirs()) if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  return out;
}

/**
 * 子进程该用的 PATH：比本进程的全，否则 CLI 自己再去调 node/git 一样找不到
 * @param {string} [platform] 测试用
 * @param {Record<string, string|undefined>} [env] 测试用
 */
function augmentedPath(platform = process.platform, env = process.env) {
  if (platform === "win32") return winSearchDirs(env).join(";");
  return searchDirs().join(path.delimiter);
}

/**
 * 问用户自己的登录 shell。这是唯一能覆盖所有版本管理器的办法——
 * asdf、mise、rbenv 式的 shim、公司自己的 profile 脚本，全都只在登录 shell 里才生效。
 * -l 读 profile，-i 读 rc（很多人把 nvm 写在 .zshrc 而不是 .zprofile 里），两个都要。
 */
function askLoginShell(name, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (WIN) return resolve("");
    if (!/^[a-zA-Z0-9._-]+$/.test(String(name))) return resolve(""); // 命令名只允许这些字符，别让它变成一段 shell
    const shell = process.env.SHELL || "/bin/zsh";
    let child;
    try {
      // 不加 windowsHide：Windows 上开头就 return 了
      child = spawn(shell, ["-lic", `command -v ${name} 2>/dev/null | head -1`], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, PATH: augmentedPath() },
      });
    } catch { return resolve(""); }
    let out = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      const hit = out.trim().split("\n").map((s) => s.trim()).find(Boolean) || "";
      resolve(runnable(hit) ? hit : "");
    };
    const t = setTimeout(done, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => { clearTimeout(t); if (!settled) { settled = true; resolve(""); } });
    child.on("close", () => { clearTimeout(t); done(); });
  });
}

const cache = new Map(); // 键 = 命令名 + 空格 + 用户填的路径
const newestCache = new Map(); // 键 = 命令名；值 = { at, r }，见 resolveNewest

/** 清缓存。用户刚装完 CLI 点「重新检测」时调，不然得重启整个应用才看得见 */
function forget() { cache.clear(); newestCache.clear(); }

/**
 * 找出这个 CLI 的绝对路径。
 * @param {string} name     命令名（claude / codex）
 * @param {string} explicit 用户在设置里填的路径；填了就只认它
 * @returns {Promise<{bin:string, how:string, why:string}>}
 *   bin  = "" 表示没找到；how = "设置里填的" | "PATH" | "补全的 PATH" | "登录 shell"
 */
async function resolveBin(name, explicit) {
  const given = String(explicit || "").trim();
  const key = name + " " + given;
  if (cache.has(key)) return cache.get(key);

  let r;
  if (given) {
    // 填了路径就只认这一个。找不到必须如实说——悄悄回落到 PATH 上另一个 claude，
    // 等于用户以为在用 A 其实在用 B，出了事没人能查
    r = runnable(given)
      ? { bin: given, how: "设置里填的", why: "" }
      : { bin: "", how: "设置里填的", why: `设置里填的路径跑不起来：${given}（不存在，或没有执行权限）` };
  } else {
    const dirs = searchDirs();
    const hit = findIn(dirs, name);
    if (hit) {
      const onPath = String(process.env.PATH || "").split(path.delimiter).includes(path.dirname(hit));
      r = { bin: hit, how: onPath ? "PATH" : "补全的 PATH", why: "" };
    } else {
      const shellHit = await askLoginShell(name);
      r = shellHit
        ? { bin: shellHit, how: "登录 shell", why: "" }
        : { bin: "", how: "", why: `PATH 和常见安装位置里都没有 ${name}` };
    }
  }
  cache.set(key, r);
  return r;
}

// ── 本机装了好几份：用版本最新的那份 ──────────────────────────────────────
//
// 2026-10-09 实测：同一台 Mac 上两个 claude。~/.local/bin/claude 是官方安装器装的，自己会升级，当天升到 2.1.295；
// /opt/homebrew/bin/claude 是早先 npm i -g 装的，一直停在 2.1.263。终端的 PATH 先排 ~/.local/bin，用的是新的；
// 双击启动的 App 拿到残废 PATH，补全目录里 homebrew 排在前头，用的是旧的。
// 旧的认不得新型号（Opus 5.5 要 2.1.280 起），用户在终端里用得好好的型号，到这边就说没有。
// 所以没填路径时，搜索路径上的每一份都问一遍 --version，用最新的；其余几份如实报出来，卡上写明。

/**
 * 从 --version 的输出里抠出 x.y.z（可带 -beta.1 之类），认不出给 null。
 * 「2.1.295 (Claude Code)」「codex-cli 0.162.0」都认得。
 * @param {string} s
 */
function cliVersion(s) {
  const m = String(s || "").match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] || "" } : null;
}

/**
 * a 比 b 新给 1，旧给 -1，一样给 0。有一边认不出也给 0，由调用方决定认不出的怎么排。
 * 1.0.0 比 1.0.0-beta 新；预发布段逐节比，数字按大小（beta.10 比 beta.9 新）
 * @param {string} a
 * @param {string} b
 */
function cmpCliVersion(a, b) {
  const x = cliVersion(a), y = cliVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xs = x.pre.split("."), ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const xn = /^\d+$/.test(xs[i]), yn = /^\d+$/.test(ys[i]);
    if (xn && yn) { if (+xs[i] !== +ys[i]) return +xs[i] > +ys[i] ? 1 : -1; continue; }
    if (xn !== yn) return xn ? -1 : 1; // 纯数字那节排在字母那节前面
    if (xs[i] !== ys[i]) return xs[i] > ys[i] ? 1 : -1;
  }
  return 0;
}

/**
 * 跟 findIn 一样找，但不停在第一个：每个目录里的都列出来，按搜索顺序。
 * 同一个文件经不同路径进来（软链、PATH 里写了两遍）只算一份。Windows 上的别名照旧排最后。
 * @param {string[]} dirs
 * @param {string} name
 * @param {string} [platform] 测试用
 * @param {Pick<typeof fs, "statSync" | "lstatSync" | "accessSync" | "realpathSync">} [io] 测试用
 */
function findAllIn(dirs, name, platform = process.platform, io = fs) {
  const win = platform === "win32";
  const exts = win ? WIN_EXT : [""];
  const join = win ? path.win32.join : path.join;
  /** @param {string} p */
  const real = (p) => { try { return String(io.realpathSync(p)); } catch { return p; } };
  const seen = new Set();
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const aliases = [];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = join(d, name + ext);
      if (!runnable(p, platform, io)) continue;
      const k = win ? real(p).toLowerCase() : real(p);
      if (seen.has(k)) continue;
      seen.add(k);
      (!win || plainFile(p, io) ? files : aliases).push(p);
    }
  }
  return files.concat(aliases);
}

/**
 * @typedef {{installed: boolean, version: string}} Probed
 * @typedef {{bin: string, installed: boolean, version: string}} Candidate
 */

/**
 * 几份候选里挑版本最新的。probe 几份一起问。
 * 跑不起来的不算；版本认不出的排在认得出的后面；版本一样的按搜索顺序。
 * 一份都跑不起来就退回第一份——让后面的检测如实报它自己的错。
 * @param {string[]} bins 按搜索顺序
 * @param {(bin: string) => Promise<Probed>} probe
 * @returns {Promise<{pick: Candidate, others: Candidate[]}>}
 */
async function pickNewest(bins, probe) {
  const got = await Promise.all(bins.map(async (bin) => {
    try {
      const r = await probe(bin);
      return { bin, installed: !!(r && r.installed), version: String((r && r.version) || "") };
    } catch { return { bin, installed: false, version: "" }; }
  }));
  /** @type {Candidate|null} */
  let best = null;
  for (const c of got) {
    if (!c.installed) continue;
    if (!best) { best = c; continue; }
    if (cliVersion(c.version) && (!cliVersion(best.version) || cmpCliVersion(c.version, best.version) > 0)) best = c;
  }
  const pick = best || got[0];
  return { pick, others: got.filter((c) => c !== pick) };
}

const NEWEST_TTL = 10 * 60 * 1000;

/**
 * 跟 resolveBin 一样找，只是本机装了好几份时用版本最新的那份，其余几份放进 others 如实报。
 * 填了路径照旧只认它。
 * fresh = 不读缓存，几份都重新问一遍：检测时用。真跑任务时读缓存，不为这个多等；
 * 缓存十分钟就作废——官方安装器会在后台自己升级，开着的应用不该一直认着那天早上的版本。
 * @param {string} name
 * @param {string} explicit
 * @param {(bin: string) => Promise<Probed>} probe 问版本的办法；测试里换成假的
 * @param {{fresh?: boolean}} [opts]
 * @returns {Promise<{bin:string, how:string, why:string, probe?: Probed, others: Candidate[]}>}
 */
async function resolveNewest(name, explicit, probe, { fresh = false } = {}) {
  const given = String(explicit || "").trim();
  if (given) return { ...(await resolveBin(name, given)), others: [] };
  const hit = newestCache.get(name);
  if (!fresh && hit && Date.now() - hit.at < NEWEST_TTL && hit.r.bin && runnable(hit.r.bin)) return hit.r;
  const all = findAllIn(searchDirs(), name);
  let r;
  if (all.length < 2) {
    r = { ...(await resolveBin(name, "")), others: [] };
  } else {
    const { pick, others } = await pickNewest(all, probe);
    const onPath = String(process.env.PATH || "").split(path.delimiter).includes(path.dirname(pick.bin));
    r = {
      bin: pick.bin, how: onPath ? "PATH" : "补全的 PATH", why: "",
      probe: { installed: pick.installed, version: pick.version }, others,
    };
  }
  newestCache.set(name, { at: Date.now(), r });
  return r;
}

module.exports = {
  resolveBin, resolveNewest, findAllIn, pickNewest, cliVersion, cmpCliVersion,
  augmentedPath, searchDirs, extraDirs, findIn, runnable, askLoginShell, forget,
  refreshWinPath, parseRegPath, expandWinVars, splitWinPath, popplerBins,
  /** 测试用：把记住的注册表 PATH 清掉，回到「一次都没读过」 */
  _resetWinPath: () => { regDirs = []; regInflight = null; },
};
