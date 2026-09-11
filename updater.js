"use strict";
// 版本与更新检查。
//
// 用户的原话是「这个代码有更新的话，这个安装包是要重新安装吗，还是能更新啊」。如实回答分两种装法：
//   · 源码跑的（npm start / npm run app）：git pull && npm install，重启就是新版，不用重装。
//   · 安装包装的：下载新的 dmg / exe 覆盖装一次。配置、会话、工作区都在 ~/OpenWorkBuddy，覆盖安装不动它们。
//
// 为什么不做「点一下自动装好」：这两个包都没有签名（没有 Apple Developer ID 证书，Windows 也没买代码签名证书）。
// electron-updater 在 macOS 上走 Squirrel.Mac，会校验代码签名，未签名的包一定失败——
// 硬做出来只会是一颗永远报「更新失败」的按钮。所以这里做的是：如实告诉你有没有新版、新版在哪、你这种装法怎么升。
// 哪天真买了证书，把 checkUpdate 换成 electron-updater 即可，接口形状是照着它对齐的。

const REPO = "CatCatUncle/openworkbuddy";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CACHE_MS = 6 * 3600 * 1000; // GitHub 匿名接口每小时 60 次，6 小时一次足够且不会被限流

function currentVersion() {
  try { return require("./package.json").version || "0.0.0"; } catch { return "0.0.0"; }
}

// 判「你是怎么装的」。不用 electron.app.isPackaged，是因为这个模块在纯 node 模式
// （npm start）下也要能被 require，那时候根本没有 electron 可取。
//
// ⚠️ 只看 app.asar 是错的：本项目的 asar 是关着的（原因见 electron-builder.config.js 文件头），
// 装机包里代码住在 <Resources>/app/ 而不是 <Resources>/app.asar，于是每一个装了包的用户
// 都会被判成「源码版」，点「检查更新」得到的建议是 git pull && npm install —— 他机器上
// 压根没有这个仓库。所以第二条才是装机版真正命中的那条：代码在 Electron 的 resources 目录底下。
// 两个参数只为可测：真实调用一律不传。Windows 给的是反斜杠、macOS 是斜杠，
// 这里统一成斜杠再比，免得断言只能在打包用的那个系统上跑。
function installKind(dir = __dirname, resourcesPath = process.resourcesPath) {
  const norm = (s) => String(s).replace(/\\/g, "/").replace(/\/+$/, "");
  const d = norm(dir);
  if (/\/app\.asar(\/|$)/.test(d)) return "app";  // asar 开着的情况，留着以防哪天打开
  if (!resourcesPath) return "source";             // 纯 node 跑（npm start）没有这个字段
  const rp = norm(resourcesPath);
  // 注意这里是 rp + "/" 而不是裸 startsWith(rp)：不然 /A/Resources-old 会被 /A/Resources 误伤。
  // 从仓库跑 electron 时 resourcesPath 指向 node_modules/electron/.../Resources，不含本目录，照样判 source。
  return d === rp || d.startsWith(rp + "/") ? "app" : "source";
}

// 只认 x.y.z 前缀，后面的 -beta.1 之类一律当成「比正式版旧」。够用，且不引第三方 semver。
function parseVer(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/);
  if (!m) return null;
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] || "" };
}
function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;   // 1.0.0 > 1.0.0-beta
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function howToUpdate(kind, platform = process.platform) {
  if (kind === "source") {
    return "你是从源码跑的：在项目目录执行 git pull && npm install，重启即可，不用重装。";
  }
  const pkg = platform === "win32" ? "新的 setup.exe" : platform === "darwin" ? "新的 dmg" : "新的安装包";
  return `你装的是安装包：下载${pkg}覆盖装一次就行。配置、会话、工作区都在 ~/OpenWorkBuddy 目录里，覆盖安装不会动它们。`;
}

let cache = { at: 0, data: null };

/**
 * 查一次 GitHub Releases，和本机版本比一比。
 * 网络不通就如实说不通——不要静默当成「已是最新」，那会让人以为自己是最新的。
 */
async function checkUpdate({ force = false, now = Date.now(), fetchImpl = fetch, timeoutMs = 10000, platform = process.platform } = {}) {
  const current = currentVersion();
  const kind = installKind();
  const base = { current, install: kind, how: howToUpdate(kind, platform), page: RELEASES_PAGE };
  if (!force && cache.data && now - cache.at < CACHE_MS) return { ...base, ...cache.data, cached: true };
  try {
    const r = await fetchImpl(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "OpenWorkBuddy" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`GitHub 返回 ${r.status}`);
    const d = await r.json();
    const latest = String(d.tag_name || d.name || "").replace(/^v/i, "");
    if (!parseVer(latest)) throw new Error("没读到版本号");
    const data = {
      latest,
      has_update: cmpVer(latest, current) > 0,
      url: d.html_url || RELEASES_PAGE,
      published_at: d.published_at || "",
      notes: String(d.body || "").slice(0, 2000),
      error: "",
    };
    cache = { at: now, data };
    return { ...base, ...data, cached: false };
  } catch (e) {
    // 查不到就说查不到，不写 has_update:false 骗人
    return { ...base, latest: "", has_update: false, url: RELEASES_PAGE, error: `查不到最新版本：${e.message}` };
  }
}

function resetCache() { cache = { at: 0, data: null }; }

module.exports = { currentVersion, installKind, cmpVer, parseVer, howToUpdate, checkUpdate, resetCache, REPO, RELEASES_PAGE };
