"use strict";
/**
 * 测试不许写用户真实的数据目录。
 *
 * 来历：开发态下 paths.js 的 DATA_DIR 就是仓库根目录，没设 OPENWORKBUDDY_HOME 的套件一 require
 * security.js / memory.js，审计和记忆就直接落在用户真在用的 data/ 里——实测一趟 npm test 往真
 * data/audit.json 灌 38 条，还顺手给真 memories.json 里的条目加命中次数。更糟的是 security.js
 * 在内存里攥着一整份审计、每次整份重写：本机正开着的那台 server 也攥着一份，两边互相盖，
 * 用户自己的审计记录就这么被测试冲掉了。
 *
 * 做法：用 `node --require` 挂进每个进程（test/all.js 经 NODE_OPTIONS 下发，套件再拉起的
 * server.js / cli.js 子进程也一并带上），把 fs 里所有会改盘的口子包一层：目标落在真实数据目录里
 * 就记一笔（路径 + 套件 + 几行调用栈）并当场抛 EACCES，那一下根本写不下去。
 * 「落在里面」按盘上真正那一处算：大小写换一换、从软链绕进去都算；删 / 挪 / 盖真目录的上级
 * （仓库根、家目录）也算——那一下会把真目录整个带走。
 *
 * 为什么光抛不够、还得记账：security.js 的审计落盘包在 `try {} catch {}` 里，抛了也被吞掉，
 * 套件照样绿。所以判成败看的是这份账（test/all.js 每个套件跑完读一遍），不是看有没有人接住异常。
 *
 * 真实目录怎么算：跟 paths.js 在**没有** OPENWORKBUDDY_HOME 时算的一模一样——
 *   开发态：APP_DIR（仓库根）下那些 dataPath(...) 会写的东西；
 *   装机态：~/OpenWorkBuddy 整个（用户装的 .app 用的就是它）。
 * 家目录取 os.userInfo()：有些套件给子进程换了 HOME，os.homedir() 跟着变，那样护住的是假家。
 *
 * 管不到的（如实写在这儿）：
 *   - 不是 node 的写手：bash 里的 touch / tar / cp -c，它们不读 NODE_OPTIONS；
 *   - 套件自己拼 env、没带上 NODE_OPTIONS 的子进程；
 *   - Electron 渲染进程：不读 NODE_OPTIONS（页面写盘走的是 server.js，那是个 node 子进程，照样带着）。
 *     Electron 主进程是管得到的：node_modules 里那份（43.2.0）实测主进程和 ELECTRON_RUN_AS_NODE 都认
 *     NODE_OPTIONS 里的 --require；打包出去的 .app 看 nodeOptions 那根 fuse，测试不跑打包态。
 *
 * 环境变量：
 *   OPENWORKBUDDY_TEST_GUARD        guard：拦 + 记账；detect：同上，另把仓库里别处的写入也记一笔（不拦），排查用
 *   OPENWORKBUDDY_TEST_GUARD_LOG    账记在哪（JSONL，一行一次）；不给就只往 stderr 说
 *   OPENWORKBUDDY_TEST_GUARD_SUITE  套件名，记进账里
 *   OPENWORKBUDDY_ALLOW_REAL_DATA=1 明说了要写真数据：整个关掉
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = path.resolve(__dirname, "..", "..");
const INSTALLED = Symbol.for("openworkbuddy.realDataGuard");

function realHome() {
  try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); }
}

/**
 * 开发态下 dataPath(...) 会写到的那些（server.js / tools.js / skills.js / plugins.js / log.js /
 * prefs.js / scheduler.js / eval / trace.js 各自的落点）。dir 连同底下全算；file 按「名字开头」算，
 * 把 writeJsonAtomic 的 .<pid>.tmp、.bak、.corrupt-* 一并带上。
 */
const DEV_DIRS = ["data", "workspace", "skills", "plugins", "projects", "prefs", "backups", "logs",
  path.join("eval", "runs"), ".openworkbuddy", "openworkbuddy-data"];
const DEV_FILES = ["config.json", "schedules.json", "experts.json", path.join("eval", "baseline.json")];

// 按字面比路径会被绕过去：macOS / Windows 默认不分大小写，$R/DATA/audit.json 就是 $R/data/audit.json；
// 软链 /tmp/x → $R/data 也一样。所以比之前两边都认成「盘上真正那一处」：已经在的那一截走 realpath
// （macOS 上 native 版连大小写都还原成盘上的写法），还不在的那一截（新建的文件）靠不分大小写地比
const FOLD = process.platform === "darwin" || process.platform === "win32";
const fold = (/** @type {string} */ p) => (FOLD ? p.toLowerCase() : p);
const realpathRaw = fs.realpathSync.native || fs.realpathSync;
/** @param {string} abs @returns {string} 最长的那段已存在前缀换成真路径，后面还不存在的原样接上 */
function canonical(abs) {
  let head = abs;
  const tail = [];
  for (let i = 0; i < 128; i++) {
    try {
      const r = realpathRaw(head);
      return tail.length ? path.join(r, ...tail) : r;
    } catch {
      const up = path.dirname(head);
      if (up === head) return abs;
      tail.unshift(path.basename(head));
      head = up;
    }
  }
  return abs;
}

/** @returns {{dirs:string[], files:string[], roots:{dev:string, installed:string}}} 真实数据在哪（绝对路径） */
function realTargets() {
  const installed = path.join(realHome(), "OpenWorkBuddy");
  const dirs = [...DEV_DIRS.map((d) => path.join(APP_DIR, d)), installed, path.join(realHome(), ".openworkbuddy")];
  const files = DEV_FILES.map((f) => path.join(APP_DIR, f));
  // 用户可能把 data/ 软链到外置盘：软链本身和它指向的那一处都得护住
  const withReal = (list) => [...new Set(list.flatMap((p) => [p, canonical(p)]))];
  return {
    // ~/.openworkbuddy 不归 paths.js 管，是 custom-commands.js 的用户级命令目录，也是真数据
    dirs: withReal(dirs),
    files: withReal(files),
    roots: { dev: APP_DIR, installed },
  };
}

const T = realTargets();
const DIRS_F = T.dirs.map(fold);
const DIR_PREFIXES_F = DIRS_F.map((d) => d + path.sep);
const FILES_F = T.files.map(fold);

/** @param {any} p @returns {string|null} 能认出来的路径就给绝对路径，fd / 认不出来的给 null */
function toPath(p) {
  if (typeof p === "string") return path.resolve(p);
  if (Buffer.isBuffer(p)) return path.resolve(p.toString());
  if (p && typeof p === "object" && p.href && p.protocol === "file:") {
    try { return require("url").fileURLToPath(p); } catch { return null; }
  }
  return null;
}

/** @param {string} abs 已经 fold 过的绝对路径 @returns {boolean} 按字面落在真目录里 */
function insideLiteral(abs) {
  for (let i = 0; i < DIRS_F.length; i++) {
    if (abs === DIRS_F[i] || abs.startsWith(DIR_PREFIXES_F[i])) return true;
  }
  for (const f of FILES_F) {
    if (abs.startsWith(f) && path.dirname(abs) === path.dirname(f)) return true;
  }
  return false;
}

/**
 * @param {string} abs
 * @param {boolean} [follow] 这一下会不会顺着最后一节的软链走（写文件会；删、改名、lchmod 动的是软链本身）
 * @returns {boolean}
 */
function isReal(abs, follow = true) {
  if (!abs) return false;
  if (insideLiteral(fold(abs))) return true;
  const c = follow ? canonical(abs) : path.join(canonical(path.dirname(abs)), path.basename(abs));
  return c !== abs && insideLiteral(fold(c));
}

/**
 * 删掉 / 挪走这个路径，会不会连带真目录：它本身就是真目录的上级（仓库根、家目录、/）。
 * 开发态 dataPath() 不带参数就是仓库根——一句没隔离的 rmSync(DATA_DIR, {recursive:true}) 能把整个仓库连 data/ 一起删了。
 * @param {string} abs @returns {boolean}
 */
function coversReal(abs) {
  if (!abs) return false;
  const covers = (/** @type {string} */ p) => {
    const pre = fold(p.endsWith(path.sep) ? p : p + path.sep);
    return DIRS_F.some((d) => d.startsWith(pre)) || FILES_F.some((f) => f.startsWith(pre));
  };
  if (covers(abs)) return true;
  const c = path.join(canonical(path.dirname(abs)), path.basename(abs));
  return c !== abs && covers(c);
}
// 动的是那一项本身、不顺着软链走的
const NOFOLLOW = new Set(["rename", "unlink", "rm", "rmdir", "lchmod", "lchown", "lutimes", "symlink", "link"]);
// 会把整棵树删掉 / 挪走 / 盖掉的：目标是真目录的上级也得拦
const WHOLE_TREE = new Set(["rm", "rmdir", "rename", "cp"]);

const WRITE_FLAGS = (() => {
  const c = fs.constants;
  return c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_APPEND;
})();
/** @param {any} flags @returns {boolean} 这个 open 会不会改盘 */
function writesFlag(flags) {
  if (flags == null) return false;
  if (typeof flags === "number") return (flags & WRITE_FLAGS) !== 0;
  return /[wa+]/.test(String(flags));
}

function install() {
  if (global[INSTALLED]) return global[INSTALLED];
  const mode = String(process.env.OPENWORKBUDDY_TEST_GUARD || "guard");
  const detect = mode === "detect";
  const logFile = process.env.OPENWORKBUDDY_TEST_GUARD_LOG || "";
  const suite = process.env.OPENWORKBUDDY_TEST_GUARD_SUITE || path.basename(process.argv[1] || "?");
  const appendRaw = fs.appendFileSync;
  const existsRaw = fs.existsSync;
  const said = new Set();
  const state = { hits: 0 };

  const stackLines = () => String(new Error().stack || "").split("\n").slice(1)
    .map((l) => l.trim().replace(/^at /, ""))
    .filter((l) => !l.includes(__filename) && !/\((node:|internal\/)/.test(l) && !/^(node:|internal\/)/.test(l))
    .slice(0, 5);

  const record = (op, abs, blocked) => {
    const row = { suite, op, path: abs, blocked, pid: process.pid, argv: process.argv.slice(1, 3).map((a) => path.basename(String(a))), stack: stackLines() };
    if (logFile) { try { appendRaw(logFile, JSON.stringify(row) + "\n"); } catch {} }
    if (blocked && !said.has(abs)) {
      said.add(abs);
      try { process.stderr.write(`\n✗ [测试护栏] ${suite} 想写真实数据：${abs}（${op}），已拦下。\n    ${row.stack.slice(0, 3).join("\n    ")}\n`); } catch {}
    }
  };
  const denied = (op, abs) => {
    state.hits++;
    record(op, abs, true);
    const e = /** @type {NodeJS.ErrnoException} */ (new Error(`EACCES: 测试不许写真实数据目录，${op} '${abs}'`));
    e.code = "EACCES"; e.errno = -13; e.syscall = op; e.path = abs;
    return e;
  };
  // detect 模式：仓库里别的地方被写，也记一笔（不拦），用来看清还有谁在往仓库里写
  const noteRepo = (op, abs) => {
    if (detect && abs && (abs === APP_DIR || abs.startsWith(APP_DIR + path.sep)) && !abs.includes(path.sep + "node_modules" + path.sep)) record(op, abs, false);
  };

  /**
   * 找出这一下要动的路径。targets：哪几个参数是路径；open 类另看 flags。
   * 返回第一个落在真实目录里的绝对路径，没有就 null。
   */
  const hit = (op, args, targets, flagIdx) => {
    if (flagIdx != null && !writesFlag(args[flagIdx])) return null;
    const base = op.replace(/Sync$/, "");
    for (const i of targets) {
      const abs = toPath(args[i]);
      if (!abs) continue;
      if (WHOLE_TREE.has(base) && coversReal(abs)) return abs;
      if (isReal(abs, !NOFOLLOW.has(base))) {
        // mkdir 一个已经在的目录什么也没改：放过，免得把 `mkdirSync(DATA_DIR, {recursive:true})` 这种空操作也算进来
        if ((op === "mkdir" || op === "mkdirSync") && existsRaw(abs)) return null;
        return abs;
      }
      noteRepo(op, abs);
    }
    return null;
  };

  // [名字, 哪几个参数是路径, flags 在第几个（open 类）]
  const SPEC = [
    ["writeFile", [0]], ["appendFile", [0]], ["truncate", [0]],
    ["rename", [0, 1]], ["copyFile", [1]], ["cp", [1]], ["link", [1]], ["symlink", [1]],
    ["mkdir", [0]], ["mkdtemp", [0]], ["rm", [0]], ["rmdir", [0]], ["unlink", [0]],
    ["chmod", [0]], ["lchmod", [0]], ["chown", [0]], ["lchown", [0]], ["utimes", [0]], ["lutimes", [0]],
    ["open", [0], 1],
  ];

  const wrapSync = (obj, name, targets, flagIdx) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function (...args) {
      const abs = hit(name, args, targets, flagIdx);
      if (abs) throw denied(name, abs);
      return orig.apply(this, args);
    };
  };
  const wrapCb = (obj, name, targets, flagIdx) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function (...args) {
      const abs = hit(name, args, targets, flagIdx);
      if (abs) {
        const err = denied(name, abs);
        const cb = args[args.length - 1];
        if (typeof cb === "function") { process.nextTick(cb, err); return; }
        throw err;
      }
      return orig.apply(this, args);
    };
  };
  const wrapPromise = (obj, name, targets, flagIdx) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function (...args) {
      const abs = hit(name, args, targets, flagIdx);
      if (abs) return Promise.reject(denied(name, abs));
      return orig.apply(this, args);
    };
  };

  for (const [name, targets, flagIdx] of SPEC) {
    wrapSync(fs, name + "Sync", targets, flagIdx);
    wrapCb(fs, name, targets, flagIdx);
    if (fs.promises) wrapPromise(fs.promises, name, targets, flagIdx);
  }
  // 流：createWriteStream(path, { flags }) 默认 'w'；给了 fd 的走 open 那一道，这里不管
  const origWS = fs.createWriteStream;
  fs.createWriteStream = function (p, opts) {
    const o = typeof opts === "string" ? { flags: "w" } : opts || {};
    if (o.fd == null) {
      const abs = hit("createWriteStream", [p, o.flags || "w"], [0], 1);
      if (abs) throw denied("createWriteStream", abs);
    }
    return origWS.apply(this, arguments);
  };
  try { require("module").syncBuiltinESMExports(); } catch {}
  global[INSTALLED] = state;
  return state;
}

/**
 * test/all.js 用：读一个套件的账，返回被拦下的那些（同一路径只留第一条）。
 * 读不懂的行也算一条：账写坏了不能当成「没写真数据」放过去。
 * @param {string} file @returns {{path:string, op:string, stack:string[], argv?:string[]}[]}
 */
function readBlocked(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r = null;
    try { r = JSON.parse(line); } catch {}
    if (!r || typeof r !== "object") { out.push({ path: "（账里这一行读不懂）", op: "?", stack: [line.slice(0, 200)] }); continue; }
    if (!r.blocked || seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(r);
  }
  return out;
}

const mode = String(process.env.OPENWORKBUDDY_TEST_GUARD || "");
if ((mode === "guard" || mode === "detect") && process.env.OPENWORKBUDDY_ALLOW_REAL_DATA !== "1") install();

module.exports = { APP_DIR, realTargets, isReal, coversReal, canonical, writesFlag, install, readBlocked };
