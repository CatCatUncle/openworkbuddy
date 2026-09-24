// @ts-check
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
 */
function writeJsonAtomic(file, data, { pretty = false, backup = true, mode = 0 } = {}) {
  writeTextAtomic(file, JSON.stringify(data, null, pretty ? 2 : 0), { backup, mode, intact: isJsonText });
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
 * 同样的写法，但内容是现成的字符串——审计流水那种一行一条的 jsonl 走这条。
 * 原子替换、.bak、权限这三件事的分寸都在这儿，jsonl 那边不该再抄一份：
 * 抄一份的代价是哪天改了这里的权限处理，另一份还是老样子，而那一份装着的是合规记录。
 * @param {string} file
 * @param {string} text
 * @param {object} [opt]
 * @param {boolean} [opt.backup]  改名前把上一版复制成 .bak（默认开）
 * @param {number}  [opt.mode]    文件权限，同 writeJsonAtomic
 * @param {(text: string) => boolean} [opt.intact]  上一版得过这一关才配留成 .bak
 */
function writeTextAtomic(file, text, { backup = true, mode = 0, intact = isPlainText } = {}) {
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
    if (backup) {
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
    fs.renameSync(tmp, file);
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

/** 装着凭证的文件：只有文件主人读得到。0600 */
const SECRET_MODE = 0o600;

module.exports = { readJson, writeJsonAtomic, writeTextAtomic, tighten, SECRET_MODE };
