"use strict";
/**
 * 打包完整性闸门：装机包里少一个 require 得到的文件，应用就是打不开。
 *
 * v0.1.1 就栽在这儿——electron-builder.config.js 的 files 白名单只写了 "*.js"，
 * 那个通配符只匹配顶层，engines/ 那 7 个文件一个都没进包。装机后 server.js 在
 * `require("./engines")` 抛 MODULE_NOT_FOUND，异常被 whenReady 的 async 吞掉，
 * 端口没人监听、窗口也没亮相 —— 用户看到的就是「双击没反应 / 有进程没界面」。
 *
 * 白名单是手写的，require 图是一直在长的，两边迟早对不上。所以这里不去修白名单本身，
 * 而是每次打包之后拿真包做一次核对：从入口文件顺着 require 爬一遍，凡是本仓库自己的
 * 文件，都必须能在包里找到。找不到就让打包失败，别等用户下载完才发现。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
/** 入口：装机态真正会被跑起来的那几个 */
const ENTRIES = ["electron-main.js", "server.js", "cli.js", "eval/run.js"];
/**
 * 不是 require 进来、而是按路径打开的运行时资源。爬 require 图爬不到它们，
 * 少了照样打不开（preload 缺了窗口一片空白，tool-bridge 缺了 MCP 桥起不来）。
 */
const ASSETS = [
  "pet-preload.js",          // 宠物窗口的 preload，BrowserWindow 按路径加载
  "public/pet.html",         // 同上
  "public/index.html",       // 主界面
  "engines/tool-bridge.js",  // 被当成子进程 spawn，不走 require
  "experts.json",            // 首次启动 seed 到 ~/OpenWorkBuddy
  "config.example.json",     // 同上
];

/** 静态扒出一个文件里的本地 require；node_modules 和用户数据路径不算 */
function localRequires(code) {
  const out = [];
  // require("./x") / require("../x")
  for (const m of code.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) out.push(m[1]);
  // require(path.join(__dirname, "x", "y.js"))
  for (const m of code.matchAll(/require\(\s*path\.join\(\s*__dirname\s*,([^)]*)\)\s*\)/g)) {
    const parts = [...m[1].matchAll(/["']([^"']+)["']/g)].map((p) => p[1]);
    if (parts.length) out.push("./" + parts.join("/"));
  }
  return out;
}

/** 从入口爬出全部本仓库文件（仓库相对路径） */
function walkGraph() {
  const seen = new Set();
  const queue = ENTRIES.map((e) => path.join(ROOT, e));
  while (queue.length) {
    const file = queue.shift();
    const rel = path.relative(ROOT, file);
    if (seen.has(rel)) continue;
    let code;
    try {
      code = fs.readFileSync(file, "utf8");
    } catch {
      continue; // 入口自己不存在的情况交给下面的断言去报
    }
    seen.add(rel);
    for (const spec of localRequires(code)) {
      let resolved;
      try {
        resolved = require.resolve(path.resolve(path.dirname(file), spec));
      } catch {
        continue; // 解析不出来的（比如可选依赖）不拦，宁可漏报也别误报把打包卡死
      }
      if (resolved.includes("node_modules")) continue;
      if (!resolved.startsWith(ROOT + path.sep)) continue;
      queue.push(resolved);
    }
  }
  for (const a of ASSETS) seen.add(a);
  return [...seen];
}

/**
 * @param {string} appDir 包里 app/ 的绝对路径（Resources/app 或 resources/app）
 * @returns {string[]} 缺失文件的仓库相对路径
 */
function missingFrom(appDir) {
  return walkGraph().filter((rel) => !fs.existsSync(path.join(appDir, rel)));
}

/** electron-builder 的 afterPack 里调；缺文件直接抛，让打包红掉 */
function assertPackComplete(appDir) {
  const missing = missingFrom(appDir);
  if (missing.length) {
    throw new Error(
      `[打包] 装机包里少了 ${missing.length} 个 require 会用到的文件，装完必定打不开：\n` +
        missing.map((m) => "  - " + m).join("\n") +
        `\n把它们加进 electron-builder.config.js 的 files 白名单。`
    );
  }
  console.log(`[打包] 完整性核对通过：${walkGraph().length} 个源文件都在包里`);
  return missing;
}

module.exports = { walkGraph, missingFrom, assertPackComplete, localRequires, ENTRIES, ASSETS };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.log(walkGraph().sort().join("\n"));
    process.exit(0);
  }
  try {
    assertPackComplete(path.resolve(dir));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
