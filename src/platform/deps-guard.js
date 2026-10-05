// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 装依赖别装到应用自己身上。
 *
 * 2026-09-28 的真实会话（「电子税务局解除税务风险操作指南」）：agent 为了读表、生成 docx、合并 PDF，
 * 在任务文件夹里连着跑了几遍 `cd .tmp && mkdir -p xlsread2 && cd xlsread2 && npm init -y && npm install xlsx`。
 * 那几次 init 先在子目录里放了 package.json，装在了原地；可只要少这一步（没写 init，或者 init 失败——
 * 直接在 .tmp 里 init 就会报 Invalid name: ".tmp"），开发态下工作空间就在应用目录里面（<应用>/workspace），
 * npm / pnpm 往上找项目根，找到的第一个 package.json 是应用自己的。2026-09-29 用 npm 11.7 实测：
 * 在没有 package.json 的任务文件夹里 `npm install` 改了应用的 package.json、往应用的 node_modules 里装，
 * `npm uninstall` 把应用自己的依赖删掉了。
 *
 * 两层：
 * 1) 围栏。跑这类命令之前，在工作空间根和这条命令所在的任务文件夹各放一个带记号的 package.json。
 *    npm / pnpm / yarn / bun 往上找项目根，碰到围栏就停：依赖装在任务文件夹里，两条对话也不往同一个
 *    node_modules 里挤。围栏和它旁边的锁文件不算成果（ws-browse.js 的 skipEntry 认记号藏掉）。
 * 2) 拦截。`cd ../.. && npm i` 这种自己走回应用目录的，围栏管不到。PATH 最前面垫一层同名小脚本：
 *    算出来的项目根是应用目录、又是会改依赖的子命令，当场拒掉；其余原样转给真的那个。
 *
 * 两层都只在「工作空间嵌在应用目录里面」时才挂。工作目录就是应用仓库本身的时候，
 * 那是人要拿它改应用自己的代码，npm install 是正经活，不拦。
 *
 * 管不到的（照实写）：写绝对路径调真 npm（/usr/local/bin/npm）、node 直接跑 npm-cli.js、
 * Windows（只有第一层）、别的会改 package.json 的工具在应用目录里跑。
 */
const fs = require("fs");
const path = require("path");

/** 围栏 package.json 里的记号字段。认围栏只认它，不认名字：用户自己的 package.json 一律当真的 */
const MARK = "openworkbuddy_fence";
/** 命令里提到这些才立围栏：不相干的命令不往工作空间里多放一个文件 */
const PM_RE = /(?:^|[^\w./-])(?:npm|npx|pnpm|pnpx|yarn|yarnpkg|bun|bunx|corepack)(?![\w-])/;
/** 围栏旁边这些是装依赖时顺手生的，跟着围栏一起藏 */
const LOCKS = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]);
/** 垫在 PATH 前面的那几个名字（npx / pnpx / bunx 只是临时拉包来跑，不改项目的依赖清单） */
const SHIMS = ["npm", "pnpm", "yarn", "yarnpkg", "bun"];

/** @param {string} p */
function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}
/** 严格在里面（同一个目录不算） @param {string} child @param {string} parent */
function inside(child, parent) {
  return child !== parent && child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * 围栏上只该有这些字段：我们写的四个，加上装依赖时包管理器往里记的（依赖清单、corepack 钉的 packageManager）。
 *
 * 2026-09-29 复审：只认记号不够。agent 常在任务文件夹里 `npm init -y && npm install xlsx`，
 * 围栏先立好了，npm init 不是另起一份、是往已有的 package.json 里并字段（npm 11.7 实测：
 * version / main / scripts / license / type 全并进来，记号原样留着）。于是一份真的工程清单被当成围栏——
 * 文件面板里藏掉、锁文件跟着藏；那个文件夹里要是只剩它，收尾时 dropLoneFence 还会把它当没装成的围栏删了。
 * 多出别的字段 = 有人拿它当工程用了，就是人家的，不再是围栏。
 */
const FENCE_KEYS = new Set(["name", "private", "description", MARK, "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "packageManager"]);

/** @type {Map<string, { m: number, s: number, yes: boolean }>} */
const fenceCache = new Map();
/**
 * 这个 package.json 是不是我们立的围栏（带记号、而且没被并成真工程）。文件面板每列一层都会问，按 mtime+大小记住答案
 * @param {string} file
 */
function isFence(file) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile() || st.size > 256 * 1024) return false;
  const hit = fenceCache.get(file);
  if (hit && hit.m === st.mtimeMs && hit.s === st.size) return hit.yes;
  let yes = false;
  try {
    const pj = JSON.parse(fs.readFileSync(file, "utf8"));
    yes = !!(pj && pj[MARK]) && Object.keys(pj).every((k) => FENCE_KEYS.has(k));
  } catch {}
  fenceCache.set(file, { m: st.mtimeMs, s: st.size, yes });
  if (fenceCache.size > 500) fenceCache.delete(/** @type {string} */ (fenceCache.keys().next().value));
  return yes;
}

/**
 * skipEntry 用：这一项是围栏本身，或者围栏旁边那几个锁文件
 * @param {string} name @param {string} fullPath
 */
function hiddenByFence(name, fullPath) {
  if (name === "package.json") return isFence(fullPath);
  if (LOCKS.has(name)) return isFence(path.join(path.dirname(fullPath), "package.json"));
  return false;
}

/** @param {string} dir @returns {boolean} 这次新立的才算 true */
function writeFence(dir) {
  const pj = path.join(dir, "package.json");
  if (fs.existsSync(pj)) return false; // 已经有了（围栏或者人家自己的）：npm 本来就停在这儿，不动它
  const body = {
    name: "openworkbuddy-task",
    private: true,
    description: "OpenWorkBuddy 放的围栏：在这里装依赖，就装在这个文件夹里，不会装到应用自己身上。删了下次装依赖时会再放一个。",
    [MARK]: true,
  };
  try {
    fs.writeFileSync(pj, JSON.stringify(body, null, 2) + "\n", { flag: "wx" });
    return true;
  } catch { return false; }
}

/**
 * 任务文件夹收尾时要不要当空的删：只剩一个围栏（装依赖那条命令没装成）也算空。
 * 删的只是围栏自己；还有别的东西就一个不碰
 * @param {string} dir
 */
function dropLoneFence(dir) {
  try {
    const names = fs.readdirSync(dir);
    if (names.length === 1 && names[0] === "package.json" && isFence(path.join(dir, "package.json"))) {
      fs.rmSync(path.join(dir, "package.json"), { force: true });
      return true;
    }
  } catch {}
  return false;
}

/**
 * 垫在 PATH 前面的小脚本。POSIX sh 写，不靠 node（桌面版里 PATH 上未必有 node）。
 * 项目根的找法照 npm 的来：往上第一个有 package.json（npm 还认 node_modules）的目录。
 * --prefix / -C / --dir / --cwd 指了别处就按指的那处算；-g 是全局，跟应用无关，放过
 */
const SHIM_SRC = `#!/bin/sh
# OpenWorkBuddy 装依赖护栏（自动生成，每次启动会对一遍内容；别手改）。为什么有它：lib/deps-guard.js
me=\${0##*/}
self=\${0%/*}
rest=""
oldifs=$IFS
IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  [ "$d" = "$self" ] || rest="\${rest:+$rest:}$d"
done
IFS=$oldifs
app=$OWB_PM_GUARD_APP
if [ -n "$app" ]; then
  target=.; want=""; mut=""; glob=""; pos=0
  for a in "$@"; do
    if [ -n "$want" ]; then target=$a; want=""; continue; fi
    case "$a" in
      -g|--global|--location=global) glob=1 ;;
      --prefix|-C|--dir|--cwd) want=1 ;;
      --prefix=*|--dir=*|--cwd=*) target=\${a#*=} ;;
      -*) ;;
      *) pos=$((pos+1))
         case "$a" in
           install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|add|ci|clean-install|ic|install-clean|install-test|it|install-ci-test|cit|uninstall|unlink|un|remove|rm|r|update|up|upgrade|udpate|dedupe|ddp|prune|link|ln|init|create|innit|pkg|rebuild|rb|version|shrinkwrap|import|fix) mut=1 ;;
         esac ;;
    esac
  done
  case "$me" in yarn|yarnpkg) [ "$pos" = 0 ] && mut=1 ;; esac
  if [ -n "$mut" ] && [ -z "$glob" ]; then
    d=$(cd "$target" 2>/dev/null && pwd -P)
    root=""
    while [ -n "$d" ]; do
      if [ -f "$d/package.json" ]; then root=$d; break; fi
      if [ "$me" = npm ] && [ -d "$d/node_modules" ]; then root=$d; break; fi
      [ "$d" = / ] && break
      d=\${d%/*}
      [ -n "$d" ] || d=/
    done
    if [ -n "$root" ] && [ "$root" = "$app" ]; then
      # 变量一律带花括号：后面紧跟全角标点时，macOS 的 /bin/sh 会把标点的头几个字节当成变量名的一部分吃掉
      echo "OpenWorkBuddy 拦下了这条 \${me} 命令：它会装到应用自己的目录（\${app}），改应用的 package.json 和 node_modules。回任务文件夹里再装。" >&2
      exit 1
    fi
  fi
fi
PATH=$rest
export PATH
exec "$me" "$@"
`;

let shimsAt = "";
/**
 * 把小脚本写到 dir 里（内容对不上才重写）。返回 dir；写不了返回空串，调用方就只剩第一层
 * @param {string} dir
 */
function ensureShims(dir) {
  if (process.platform === "win32" || !dir) return "";
  if (shimsAt === dir) return dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const n of SHIMS) {
      const f = path.join(dir, n);
      let cur = "";
      try { cur = fs.readFileSync(f, "utf8"); } catch {}
      if (cur !== SHIM_SRC) fs.writeFileSync(f, SHIM_SRC);
      fs.chmodSync(f, 0o755);
    }
    shimsAt = dir;
    return dir;
  } catch { return ""; }
}

/**
 * 每条 shell / 脚本跑之前调一次。
 * @param {{ appDir: string, wsDir: string, cwd?: string, text?: string, shimDir?: string, path?: string }} o
 *   text 是命令原文（或 run_node 的脚本），提到包管理器才立围栏；path 是原本要给子进程的 PATH
 * @returns {{ fences: string[], env: Record<string, string> }} env 并进子进程的环境；不嵌套时是空的
 */
function prepare(o) {
  /** @type {{ fences: string[], env: Record<string, string> }} */
  const res = { fences: [], env: {} };
  if (!o || !o.appDir || !o.wsDir) return res;
  const app = real(o.appDir), w = real(o.wsDir);
  if (!inside(w, app)) return res; // 工作空间不在应用目录里：往上找根本找不到应用
  if (o.text && PM_RE.test(o.text)) {
    const dirs = [w];
    const c = real(o.cwd || o.wsDir);
    if (inside(c, w)) {
      const top = path.relative(w, c).split(path.sep)[0];
      // .tmp 这种点开头的是大家共用的临时区，不当任务文件夹围；工作空间根那道围栏兜着
      if (top && !top.startsWith(".")) dirs.push(path.join(w, top));
    }
    for (const d of dirs) if (writeFence(d)) res.fences.push(d);
  }
  const shims = o.shimDir ? ensureShims(o.shimDir) : "";
  if (shims) {
    res.env.PATH = shims + path.delimiter + (o.path == null ? process.env.PATH || "" : o.path);
    res.env.OWB_PM_GUARD_APP = app;
  }
  return res;
}

module.exports = { MARK, PM_RE, LOCKS, SHIMS, SHIM_SRC, isFence, hiddenByFence, writeFence, dropLoneFence, ensureShims, prepare, inside, real };
