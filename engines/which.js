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
 * 缓存按「名字 + 显式路径」记，forget() 清掉——用户在设置页点「重新检测」时清一次，
 * 不然刚装完 CLI 的人得重启整个应用才看得见。
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
 * PATH 之外还该看的地方。全是「装完之后要改 shell 配置才进 PATH」的位置——
 * 也正是 GUI 启动时一定看不到的那些。
 */
function extraDirs() {
  const home = os.homedir();
  const j = (...p) => path.join(home, ...p);
  if (WIN) {
    const out = [];
    if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, "Programs"));
    out.push(j(".bun", "bin"), j("AppData", "Local", "Volta", "bin"));
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

/** 这个文件能不能直接跑起来 */
function runnable(file) {
  if (!file) return false;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (WIN) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** 在给定目录里找一个可执行文件，返回绝对路径 */
function findIn(dirs, name) {
  const exts = WIN ? WIN_EXT : [""];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      if (runnable(p)) return p;
    }
  }
  return "";
}

/** PATH + 补全目录，去重后的完整搜索路径 */
function searchDirs() {
  const cur = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const seen = new Set(cur);
  const out = cur.slice();
  for (const d of extraDirs()) if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  return out;
}

/** 子进程该用的 PATH：比本进程的全，否则 CLI 自己再去调 node/git 一样找不到 */
function augmentedPath() {
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

/** 清缓存。用户刚装完 CLI 点「重新检测」时调，不然得重启整个应用才看得见 */
function forget() { cache.clear(); }

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

module.exports = { resolveBin, augmentedPath, searchDirs, extraDirs, findIn, runnable, askLoginShell, forget };
