"use strict";
/**
 * 代码在哪 vs 数据在哪。
 *
 * 开发态（git clone + npm run app）：两者都是仓库目录，跟以前一模一样，行为一个字节都不变。
 * 装机态（.dmg / .exe 装出来的那份）：代码在应用包里，那地方是只读的——macOS 上往签名过的
 *   包里写东西会直接破坏签名，Windows 装在 Program Files 下普通用户也没有写权限。
 *   所以所有会被写的东西（配置、账号、会话、工作区、技能、插件、备份、日程）一律落到
 *   用户家目录下的 ~/OpenWorkBuddy。
 *
 * 为什么用家目录而不是 Library/Application Support 或 AppData：工作区里放的是 PPT/Word/Excel
 * 这些要交到用户手上的成果文件，得让人在访达/资源管理器里自己找得到、能拖走。
 *
 * 想放别处：设环境变量 OPENWORKBUDDY_HOME=/你的/路径（开发态也吃这个变量，方便隔离测试）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** 只读：代码、public/、config.example.json、随包出厂的 skills/ */
const APP_DIR = __dirname;

function isPackaged() {
  // ELECTRON_RUN_AS_NODE：run_node 派生出去的子进程也带 electron 版本号，但它不是应用本体
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) return false;
  try {
    return !!require("electron").app.isPackaged;
  } catch {
    return false;
  }
}

/** 可写：配置 / 数据 / 工作区 / 技能 / 插件 / 备份都在这儿 */
const DATA_DIR = process.env.OPENWORKBUDDY_HOME
  ? path.resolve(process.env.OPENWORKBUDDY_HOME)
  : isPackaged()
    ? path.join(os.homedir(), "OpenWorkBuddy")
    : APP_DIR;

/** 数据根下的路径 */
function dataPath(...seg) {
  return path.join(DATA_DIR, ...seg);
}

/** 应用包内的只读资源 */
function appPath(...seg) {
  return path.join(APP_DIR, ...seg);
}

/** 两处同名时，用户那份优先、包里那份兜底（读用；写一律写 dataPath） */
function preferData(...seg) {
  const mine = dataPath(...seg);
  return fs.existsSync(mine) ? mine : appPath(...seg);
}

function copyIfMissing(from, to) {
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  fs.cpSync(from, to, { recursive: true });
  return true;
}

/**
 * 装机态首次启动：把包里的「出厂内容」铺到数据目录。
 * 每次启动都会补一次缺失项——这样应用升级带来的新内置技能能自动出现，
 * 而用户自己改过的那些不会被覆盖（只补不存在的）。
 */
function seedDataDir() {
  if (DATA_DIR === APP_DIR) return; // 开发态：本来就是同一个目录，无事可做
  for (const d of ["data", "workspace", "skills", "plugins", "backups"]) {
    fs.mkdirSync(dataPath(d), { recursive: true });
  }
  copyIfMissing(appPath("experts.json"), dataPath("experts.json"));
  try {
    for (const e of fs.readdirSync(appPath("skills"), { withFileTypes: true })) {
      if (e.isDirectory()) copyIfMissing(appPath("skills", e.name), dataPath("skills", e.name));
    }
  } catch {}
}

module.exports = { APP_DIR, DATA_DIR, dataPath, appPath, preferData, seedDataDir, isPackaged };
