// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * JSON 小仓库 —— 会话、账本、定时任务表这些"丢了就真丢了"的文件统一走这里。
 *
 * 解决的是同一个老毛病：`try { JSON.parse(读文件) } catch { return [] }`。
 * 文件只要坏了一个字节，程序就当它是空的，然后下一次保存把空的写回去——
 * 用户的对话、账号、积分、定时任务就这么没了，全程没有一句提示。
 *
 * 这里的两条规矩：
 *   读 —— 分得清"没有这个文件"和"文件坏了"。坏了先拿 .bak 顶上，再不行就把坏文件
 *         改名隔离（.corrupt-时间戳）留给用户捞，绝不装作无事发生。
 *   写 —— 先写临时文件、fsync 落盘，再改名。改名在同一分区上是原子的，别人读到的要么是旧的
 *         要么是新的，不会是半个；改名前顺手把上一版留成 .bak（上一版自己读不出来就不留，
 *         免得拿残骸顶掉一份好的 .bak）。
 */

const fs = require("fs");
const path = require("path");

/**
 * @param {string} file    文件路径
 * @param {*}      empty   文件不存在时返回什么（调用方自己给默认值）
 * @param {object} [opt]
 * @param {boolean} [opt.strict]  内容坏了直接抛错，不做 .bak 兜底也不隔离。
 *                                账本这类跟钱、跟身份有关的用它：宁可停下来让人处理，
 *                                也不能自作主张回滚到上一版，那等于悄悄吞掉一笔充值。
 */
function readJson(file, empty, { strict = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return empty;
    throw new Error(`${path.basename(file)} 打不开（${e.message}）`);
  }
  if (!text.trim()) {
    // 0 字节不等于「新文件」。改名先落了盘、数据块还没落就断电，留下的正是这么一个空壳。
    // 以前直接按新的算，下一次保存就把空的写回去——用户的东西等于被静默清空。
    // 所以先看 .bak：它也没有（或也是空的）才真是新文件；它有内容，就按「坏了」走下面同一套
    if (!hasContent(file + ".bak")) return empty;
    return broken(file, empty, new Error("文件是空的（0 字节）"), strict, { blank: true });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return broken(file, empty, e, strict);
  }
}

/** @param {string} file @returns {boolean} 读得到、而且不全是空白 */
function hasContent(file) {
  try {
    return fs.readFileSync(file, "utf8").trim() !== "";
  } catch {
    return false;
  }
}

/**
 * 读不出来的两种样子（半截 JSON / 0 字节）走同一条路：strict 抛错，其余先试 .bak 再隔离
 * @param {string} file
 * @param {*} empty
 * @param {Error} err
 * @param {boolean} strict
 * @param {{ blank?: boolean }} [opt]
 */
function broken(file, empty, err, strict, opt) {
  if (strict) {
    throw new Error(
      `${path.basename(file)} 内容坏了（${err.message}）。旁边有 .bak 可以恢复；` +
        `在修好之前程序不会碰它，免得把它覆盖成空的`
    );
  }
  return recover(file, empty, err, opt);
}

/**
 * 坏文件的善后：先试 .bak，不行就隔离。无论哪条路都要在控制台说清楚。
 * @param {string} file
 * @param {*} empty
 * @param {Error} err
 * @param {{ blank?: boolean }} [opt] blank：正本是 0 字节的空壳，不值得另存 .corrupt
 */
function recover(file, empty, err, { blank = false } = {}) {
  const name = path.basename(file);
  try {
    const bak = JSON.parse(fs.readFileSync(file + ".bak", "utf8"));
    console.warn(`[store] ${name} 内容坏了（${err.message}），已回退到上一版 .bak（可能少最后一次改动）`);
    // 坏的那份也留一手，万一 .bak 更旧。空壳就不留了：一个空文件没什么可捞的，
    // 拷过去反倒会把上回真坏掉时留下的 .corrupt 盖成空的
    if (!blank) {
      try {
        fs.copyFileSync(file, `${file}.corrupt`);
      } catch {}
    }
    writeJsonAtomic(file, bak, { backup: false }); // 把好的那版写回去，别让每次读都走一遍恢复
    return bak;
  } catch {}
  const quarantine = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, quarantine);
    console.error(`[store] ${name} 内容坏了（${err.message}），已改名隔离到 ${path.basename(quarantine)}，从空的重新开始`);
  } catch (e2) {
    console.error(`[store] ${name} 内容坏了（${err.message}），连隔离都没成功（${e2.message}）`);
  }
  return empty;
}

/**
 * 把一个已经存在的文件收紧到指定权限。
 *
 * 为什么不能只在创建时给 mode：umask 只会往下削、不会往上补，而更要命的是**老文件**——
 * 装了半年的机器上 config.json 早就以 0644 躺在那儿了，光改写入代码救不了它。
 * 所以写盘前后各收一次，老装机第一次存设置就顺手修好，不用用户自己去 chmod。
 *
 * 失败一律吞掉：Windows 上 chmod 基本是空操作，网络盘 / 容器挂载卷也可能不让改。
 * 那些地方权限本来就由别处管，为这个把存盘整个失败掉，是拿丢配置换一个装饰性的位。
 * @param {string} file
 * @param {number} [mode] 0 或不传 = 不动
 */
function tighten(file, mode) {
  if (!mode) return;
  try { fs.chmodSync(file, mode); } catch {}
}

/**
 * @param {string} file
 * @param {*} data 会被 JSON.stringify
 * @param {object} [opt]
 * @param {boolean} [opt.pretty]  缩进保存。人要手改的文件才开，几千条流水开了纯属浪费磁盘
 * @param {boolean} [opt.backup]  改名前把上一版复制成 .bak（默认开）
 * @param {number}  [opt.mode]    文件权限。装着凭证的文件传 0o600——见下面那段
 * @param {boolean} [opt.trustPrev] 调用方担保盘上这一版就是它自己上一次读过 / 写下去的那份
 *                                  （比过 mtime+size）。见 writeTextAtomic 里 linkBackup 那段
 */
function writeJsonAtomic(file, data, { pretty = false, backup = true, mode = 0, trustPrev = false } = {}) {
  writeTextAtomic(file, JSON.stringify(data, null, pretty ? 2 : 0), { backup, mode, intact: isJsonText, trustPrev });
}

/** @param {string} text @returns {boolean} */
function isJsonText(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
/**
 * 纯文本（jsonl 流水）没法整份解析，只认最粗的两种残骸：空的、带 NUL 的（断电后常见的一截零）
 * @param {string} text
 * @returns {boolean}
 */
function isPlainText(text) {
  return text.trim() !== "" && !text.includes("\0");
}

/**
 * Windows 上改名、建硬链接常被别的程序短暂占着：杀毒软件、搜索索引、同步盘看见新文件就去扫，
 * 这几十毫秒里 rename 报 EPERM / EACCES / EBUSY。不重试，一次存盘就这么失败了。
 * 所以只在 Windows 上重试：10→20→40… 毫秒地等，攒满约 1 秒为止，等用 Atomics.wait 真睡、不空转烧 CPU。
 * 为什么是同步地等：后台版从挂 .bak 到改名那一段不许让出主线程（见 writeTextAtomicAsync），只能原地等。
 * 别的平台上这几个错误码就是真没权限，重试也白搭，照旧直接抛。
 */
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_BUDGET_MS = 1000;
/**
 * 上回攒满 1 秒还没成的目标，下回只给 100 毫秒：文件被长期占着（同步盘、别的程序开着不放）时，
 * 每几秒一次的会话存盘不能每次都把主线程卡上一整秒。成了一次就划掉，恢复整份预算。
 */
const STUCK_BUDGET_MS = 100;
/** @type {Set<string>} */
const stuck = new Set();
/** @type {Int32Array | null} */
let sleepCell = null;
/** @param {number} ms */
function sleepSync(ms) {
  try {
    if (!sleepCell) sleepCell = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleepCell, 0, 0, ms);
  } catch {} // 个别宿主不许主线程 Atomics.wait：那就不睡直接重试，次数照样有上限
}
/**
 * 改名、建链接、睡、平台这几样，测试要能换成假的（本机不是 Windows，也造不出被占着的文件）。
 * 改名和建链接每次现查 fs 上的：别的测试会临时换掉 fs.renameSync 记调用顺序，不能在这儿提前绑死。
 * @typedef {object} RetryIo
 * @property {string} platform
 * @property {(from: string, to: string) => void} rename
 * @property {(from: string, to: string) => void} link
 * @property {(ms: number) => void} sleep
 */
/** @type {RetryIo} */
const DEFAULT_IO = {
  platform: process.platform,
  rename: (a, b) => fs.renameSync(a, b),
  link: (a, b) => fs.linkSync(a, b),
  sleep: sleepSync,
};
/** @param {Partial<RetryIo> | undefined} io @returns {RetryIo} */
function ioOf(io) {
  return io ? { ...DEFAULT_IO, ...io } : DEFAULT_IO;
}
/**
 * 跑 fn，Windows 上遇到「被占着」那三个错误码就等一会儿再试。最后还不成，把最后那个错误原样抛出去。
 * @template T
 * @param {string} key 按目标路径记「上回卡满了没有」
 * @param {() => T} fn
 * @param {RetryIo} io
 * @returns {T}
 */
function retryBusy(key, fn, io) {
  if (io.platform !== "win32") return fn();
  const budget = stuck.has(key) ? STUCK_BUDGET_MS : RETRY_BUDGET_MS;
  let waited = 0;
  for (let delay = 10; ; delay *= 2) {
    try {
      const r = fn();
      stuck.delete(key);
      return r;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (!code || !BUSY_CODES.has(code)) throw e;
      if (waited >= budget) {
        if (stuck.size > 256) stuck.clear(); // 只是省点等待的记性，攒多了清掉也无妨
        stuck.add(key);
        throw e;
      }
      const d = Math.min(delay, budget - waited);
      io.sleep(d);
      waited += d;
    }
  }
}

/**
 * 上一版原样挂成 .bak，一个字节都不搬：硬链接到 .bak 旁边的临时名，再改名盖过去。
 * 随后正本被 rename 换成新 inode，旧 inode 只剩 .bak 这一个名字——效果跟拷一份一样，
 * 代价是两次元数据操作。直接 link 到 .bak 会因为它已存在报 EEXIST；先删后链，中间又有一瞬没有 .bak。
 *
 * 为什么要调用方担保（trustPrev）：老路先把上一版整份读出来、JSON.parse 一遍，残骸不配当 .bak。
 * 会话自动存盘最快 5 秒一次，2026-09-28 实测 1.39MB 的会话带 .bak 25.7ms、不带 17.0ms，
 * 多出来的就是这次重读、重解析、重写。可这份「上一版」多半就是本进程几秒前自己写的——
 * mtime+size 对得上，再验一遍纯属白干。对不上（命令行那边写过）调用方就不担保，还走老路。
 *
 * 前提是正本只靠 rename 整份换掉、从不原地改写：原地改写会顺着链接把 .bak 一起改掉。
 * 会话文件满足这一条（全仓写会话都走 writeJsonAtomic）。
 * 链不上（exFAT、SMB、部分 Windows 卷不支持硬链接）退回整份拷贝，照样不解析。
 * Windows 上 .bak 或正本正被杀毒软件扫着时链接、改名会短暂失败，按 retryBusy 等一等再试。
 * @param {string} file
 * @param {number} mode
 * @param {RetryIo} [io]
 * @returns {boolean} true = 这一步办完了（包括「压根没有上一版」）；false = 交回老路
 */
function linkBackup(file, mode, io = DEFAULT_IO) {
  const bak = file + ".bak";
  const tmp = `${bak}.${process.pid}.tmp`;
  try {
    try { fs.unlinkSync(tmp); } catch {}
    retryBusy(tmp, () => io.link(file, tmp), io);
    retryBusy(bak, () => io.rename(tmp, bak), io);
    tighten(bak, mode);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return true; // 第一次存，没有上一版
  }
  try {
    fs.copyFileSync(file, bak);
    tighten(bak, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * 不担保上一版时挂 .bak 的老路：先读出来、过一遍 intact，才配当 .bak。
 * @param {string} file
 * @param {number} mode
 * @param {(text: string) => boolean} intact
 */
function copyBackup(file, mode, intact) {
  try {
    // 上一版得先读得出来才配当 .bak。正本已经是 0 字节 / 半截的时候还照拷，
    // 等于拿残骸把最后一份好的 .bak 顶掉——下次坏了就真没得退了
    const prev = fs.readFileSync(file); // 第一次没有旧版，忽略即可
    if (intact(prev.toString("utf8"))) {
      fs.writeFileSync(file + ".bak", prev, mode ? { mode } : undefined);
      tighten(file + ".bak", mode); // .bak 跟正本一字不差，权限也得一样
    }
  } catch {}
}

/**
 * 同样的写法，但内容是现成的字符串——审计流水那种一行一条的 jsonl 走这条。
 * 原子替换、.bak、权限这三件事的分寸都在这儿，jsonl 那边不该再抄一份：
 * 抄一份的代价是哪天改了这里的权限处理，另一份还是老样子，而那一份装着的是合规记录。
 * @param {string} file
 * @param {string} text
 * @param {object} [opt]
 * @param {boolean} [opt.backup]  改名前把上一版复制成 .bak（默认开）
 * @param {number}  [opt.mode]    文件权限，同 writeJsonAtomic
 * @param {(text: string) => boolean} [opt.intact]  上一版得过这一关才配留成 .bak
 * @param {boolean} [opt.trustPrev] 同 writeJsonAtomic：上一版不用再读再验，直接硬链接成 .bak
 * @param {Partial<RetryIo>} [opt.io] 只给测试用：换掉平台、改名、建链接、睡，验 Windows 上的重试
 */
function writeTextAtomic(file, text, { backup = true, mode = 0, intact = isPlainText, trustPrev = false, io = undefined } = {}) {
  const ops = ioOf(io);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // mode 要在打开时给，不能等写完再 chmod：中间那一瞬文件是 0644，
    // 同机器上另一个用户 `cat` 得到的就是完整的一份 Key
    const fd = fs.openSync(tmp, "w", mode || 0o666);
    try {
      fs.writeFileSync(fd, text, "utf8");
      // 改名之前必须落盘。不然改名这条元数据先到、数据块还在缓存里，
      // 这时候断电，盘上就是一个名字对、内容 0 字节的正本——readJson 看到的正是它
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    tighten(tmp, mode); // open 的 mode 还要过一道 umask（022 会把 0640 削成 0600 以外的样子），chmod 不受它管
    if (backup && !(trustPrev && linkBackup(file, mode, ops))) copyBackup(file, mode, intact);
    retryBusy(file, () => ops.rename(tmp, file), ops); // Windows 上正本被占着就等一等，见 retryBusy
    tighten(file, mode); // 兜底：rename 保的是 tmp 的位，这里再确认一次，顺带修好老装机
    // 改名本身记在目录里，目录也得落一次盘。Windows 打不开目录，失败就算了——改名已经成了
    try {
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {}
  } catch (e) {
    try {
      fs.unlinkSync(tmp); // 写到一半失败别留一地 .tmp
    } catch {}
    throw e;
  }
}

let asyncTmpSeq = 0;
// 路上那几份临时文件。进程在它们落地前退出（退出钩子走的是同步那条路重写一遍），
// 这几个 .tmp 就成了没人认领的残骸——一条 1.4MB 的会话留一份。退出时顺手删掉
const asyncTmps = new Set();
let asyncTmpHooked = false;
function dropAsyncTmps() {
  for (const t of asyncTmps) { try { fs.unlinkSync(t); } catch {} }
  asyncTmps.clear();
}

/**
 * 同一套写法的后台版：写临时文件、fsync 这两步交给线程池，主线程只做最后那一小撮元数据操作
 * （挂 .bak、改名），而且一口气做完、中间不让出去。
 *
 * 为什么要有它：同步那条路上 fsync 一次 5~26ms，这段时间整个服务——所有对话的流式输出、
 * 所有接口——一起停着。2026-09-29 实测 5 条对话并发、会话 1.4MB：120 秒主线程里 fsync 占 11.2 秒，
 * 调用方是会话存盘、running.json、模型健康账本。
 *
 * 老规矩一条不少：先写临时文件并落盘再改名、.bak 照挂、权限在打开时给。多出来的三条：
 *   - 临时名每次不同（带序号）：同一个文件同步、后台两条路可能同时在写，共用一个临时名会互相截断；
 *   - shouldCommit：临时文件落完盘、改名之前再问一句还要不要。等线程池这几毫秒里，调用方可能
 *     已经走同步那条路写下了更新的一版——旧的这份绝不能晚到把它盖掉；
 *   - trustPrev 可以给函数：在改名前那一刻才判，判的是那一刻盘上的样子。
 * onCommit 紧跟在改名后面、同一段同步代码里调：调用方在这里记下「盘上现在是我写的这份」，
 * 中间没有空隙让别人看到「盘变了、记账还没变」。
 * 目录的那次 fsync 挪到改名之后异步做：改名已经成了，它只管让这条元数据经得起断电。
 * @param {string} file
 * @param {string} text
 * @param {object} [opt]
 * @param {boolean} [opt.backup]
 * @param {number}  [opt.mode]
 * @param {(text: string) => boolean} [opt.intact]
 * @param {boolean | (() => boolean)} [opt.trustPrev]
 * @param {(() => boolean) | null} [opt.shouldCommit]
 * @param {(() => void) | null} [opt.onCommit]
 * @param {Partial<RetryIo>} [opt.io] 同 writeTextAtomic，只给测试用
 * @returns {Promise<boolean>} 真改了名 = true；被 shouldCommit 拦下 = false
 */
async function writeTextAtomicAsync(file, text, { backup = true, mode = 0, intact = isPlainText, trustPrev = false, shouldCommit = null, onCommit = null, io = undefined } = {}) {
  const ops = ioOf(io);
  const dir = path.dirname(file);
  if (!asyncTmpHooked) { asyncTmpHooked = true; process.once("exit", dropAsyncTmps); }
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${++asyncTmpSeq}.tmp`;
  asyncTmps.add(tmp);
  let renamed = false;
  try {
    const fh = await fs.promises.open(tmp, "w", mode || 0o666);
    try {
      await fh.writeFile(text, "utf8");
      await fh.sync(); // 同 writeTextAtomic：改名之前必须落盘
    } finally {
      await fh.close();
    }
    if (shouldCommit && !shouldCommit()) {
      try { fs.unlinkSync(tmp); } catch {}
      asyncTmps.delete(tmp);
      return false;
    }
    // ↓ 从这里到改名是一段同步代码，不让出主线程。Windows 上的重试也是同步地等（retryBusy），
    //   不能换成 await 睡：一让出去，别人就可能看到「.bak 换了、正本还没换」或者抢先写进来
    tighten(tmp, mode);
    const trust = typeof trustPrev === "function" ? trustPrev() : trustPrev;
    if (backup && !(trust && linkBackup(file, mode, ops))) copyBackup(file, mode, intact);
    retryBusy(file, () => ops.rename(tmp, file), ops);
    renamed = true;
    asyncTmps.delete(tmp);
    tighten(file, mode);
    if (onCommit) { try { onCommit(); } catch {} }
  } catch (e) {
    if (!renamed) { try { fs.unlinkSync(tmp); } catch {} } // 写到一半失败别留一地 .tmp
    asyncTmps.delete(tmp);
    throw e;
  }
  try {
    const dh = await fs.promises.open(dir, "r");
    try { await dh.sync(); } finally { await dh.close(); }
  } catch {} // Windows 打不开目录，同 writeTextAtomic
  return true;
}
/**
 * @param {string} file
 * @param {*} data 调用这一刻就 JSON.stringify（拿的是这一刻的内容，之后再改不影响这次写）
 * @param {object} [opt] 同 writeTextAtomicAsync（intact 固定为「能整份解析」）
 * @returns {Promise<boolean>}
 */
function writeJsonAtomicAsync(file, data, opt = {}) {
  let text;
  try { text = JSON.stringify(data); } catch (e) { return Promise.reject(e); }
  return writeTextAtomicAsync(file, text, { ...opt, intact: isJsonText });
}

/**
 * 同一个文件的后台写盘排班：一次只在路上一份。
 *   - 路上时又要写：只记「还欠一次」，这一趟落地后再开一趟——job 自己在开头取**那时最新**的内容，
 *     所以中间改了多少次都只多写一次，而且落盘顺序永远跟改动顺序一致（旧的不会晚到盖掉新的）；
 *   - minGapMs：两趟开写之间至少隔这么久，挤进来的并成间隔到了那一趟（不是丢掉：一定会写）；
 *   - flush()：不等间隔，立刻开写；等到「调用这一刻的内容」确实落地才 resolve。收尾用：
 *     告诉界面「完成了」之前，这一轮的记录必须已经在盘上。
 * job 出错交给 onError 留痕，不往外抛：flush 的调用方要的是「写过了」，挂住它什么也换不来。
 * @param {() => Promise<unknown>} job
 * @param {{ minGapMs?: number, onError?: ((e: any) => void) | null }} [opt]
 */
function coalesce(job, { minGapMs = 0, onError = null } = {}) {
  let want = 0;        // 要写的次数（request/flush 各记一笔）
  let covered = 0;     // 已落地的那一趟开写时，want 数到了几
  let running = false;
  let urgent = false;  // 有人在 flush：下一趟不等间隔
  let lastStart = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {{ need: number, done: () => void }[]} */
  let waiters = [];
  const settle = () => {
    const left = [];
    for (const w of waiters) {
      if (w.need <= covered) w.done(); else left.push(w);
    }
    waiters = left;
  };
  const start = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    running = true;
    urgent = false;
    lastStart = Date.now();
    const upTo = want;
    Promise.resolve().then(job).catch((e) => { if (onError) onError(e); }).then(() => {
      running = false;
      covered = Math.max(covered, upTo); // cancel() 可能已经把账抹平了，别倒退回去又开一趟
      settle();
      kick();
    });
  };
  const kick = () => {
    if (running || want <= covered) return;
    const wait = urgent ? 0 : lastStart + minGapMs - Date.now();
    if (wait <= 0) return start();
    if (!timer) {
      timer = setTimeout(() => { timer = null; kick(); }, wait);
      if (timer.unref) timer.unref();
    }
  };
  return {
    request() { want++; kick(); },
    /** @returns {Promise<void>} */
    flush() {
      const need = ++want;
      urgent = true;
      const p = new Promise((done) => waiters.push({ need, done: () => done(undefined) }));
      kick();
      return p;
    },
    /** 还有没落地的：排着的、路上的都算 */
    busy() { return running || want > covered; },
    /** 不写了（会话被删）：排着的作废；路上那一趟由调用方的 shouldCommit 拦 */
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      covered = want;
      settle();
    },
  };
}

/** 装着凭证的文件：只有文件主人读得到。0600 */
const SECRET_MODE = 0o600;

module.exports = { readJson, writeJsonAtomic, writeTextAtomic, writeTextAtomicAsync, writeJsonAtomicAsync, coalesce, tighten, SECRET_MODE };
