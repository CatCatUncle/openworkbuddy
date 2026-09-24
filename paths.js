// @ts-check
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

/** @returns {boolean} 是不是装机态（.dmg / .exe 装出来的那份） */
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

/** 数据根下的路径 @param {...string} seg @returns {string} */
function dataPath(...seg) {
  return path.join(DATA_DIR, ...seg);
}

/** 应用包内的只读资源 @param {...string} seg @returns {string} */
function appPath(...seg) {
  return path.join(APP_DIR, ...seg);
}

/** 两处同名时，用户那份优先、包里那份兜底（读用；写一律写 dataPath） @param {...string} seg @returns {string} */
function preferData(...seg) {
  const mine = dataPath(...seg);
  return fs.existsSync(mine) ? mine : appPath(...seg);
}

/**
 * 拷一整棵目录，能走 APFS 的 clonefile 就走（cp -c）。
 *
 * clonefile 是写时复制：拷完两边各是各的文件，改哪边都不影响对面，语义和真拷贝一模一样，
 * 但底下共享同一批数据块，所以几乎不占盘、也几乎不花时间。
 *
 * 值得为这个多写十行，是因为 seedDataDir 每铺一个新数据目录就要把 skills/ 整份拷过去。
 * 本机装了 ppt-master 之后这一份是 189M，实测（df 量真占盘，不是 du——du 看不见 clone 共享）：
 *
 *     普通拷贝 170MB / 次     clone 5MB / 次
 *
 * 装机的真实用户首次启动就得干等这一下。更凶的是端到端测试：每个用例起一个新 HOME，
 * 一轮几十个用例约 7.5G 白写，攒几十轮就是 /var/folders 底下上百 G——磁盘报到 99% 那次
 * 就是这么来的（清理那一半在 test/e2e.js 的 reapStaleTempHomes）。
 *
 * 不是 macOS、不是 APFS、跨卷、或者 cp 不认 -c：退回 fs.cpSync。退回的是慢，不是错。
 * 失败过一次就整个进程不再试——否则每个技能目录都要白 spawn 一次 cp。
 */
let canClone = process.platform === "darwin";
/** @param {string} from @param {string} to */
function copyTree(from, to) {
  if (canClone) {
    try {
      require("child_process").execFileSync("/bin/cp", ["-Rc", from, to], { stdio: "ignore" });
      return;
    } catch {
      canClone = false;
      // 挂在半道上会留下一棵拷了一半的树，下面 cpSync 撞见它就只补缺的那几个文件，
      // 拼出来的东西比没拷更难查。先清干净再走老路。
      try { fs.rmSync(to, { recursive: true, force: true }); } catch {}
    }
  }
  fs.cpSync(from, to, { recursive: true });
}

/** @param {string} from @param {string} to @returns {boolean} 真拷了才是 true */
function copyIfMissing(from, to) {
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  copyTree(from, to);
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

/**
 * 听哪个端口。放这儿是因为壳（electron-main.js）和服务端（server.js）必须算出同一个数：
 * 各写各的那阵子，谁要是设了 PORT，服务端听 3810、壳去连 3800，窗口就永远等不到人。
 *
 * PORT=0 是操作系统的老规矩：「你替我挑一个空的」。以前这行写的是 `+env.PORT || ...`，
 * 而 +"0" 是 0、是假值，于是显式设的 0 被当成没设，悄悄回落到 3800——本机正跑着一台的时候
 * 就直接撞上用户自己那台了（端到端测试里五处真起 server 全栽在这儿）。
 * 所以这里的判据是「设没设」，不是「真不真」；设了但不是个合法端口号，也当没设。
 * @param {Record<string, string|undefined>|null|undefined} env 一般就是 process.env
 * @param {any} [cfg] config.json，看 server.port
 * @returns {number}
 */
function resolvePort(env, cfg) {
  const raw = env && env.PORT;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return (cfg && cfg.server && cfg.server.port) || 3800;
}

module.exports = { APP_DIR, DATA_DIR, dataPath, appPath, preferData, seedDataDir, isPackaged, resolvePort, _copyTree: copyTree };
