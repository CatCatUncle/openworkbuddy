/**
 * 项目规范：工作目录里（以及往上直到 git 仓库根）的 AGENTS.md / CLAUDE.md。
 *
 * 桌面端和命令行共用这一份。以前只有桌面端读，而且只读项目目录那一层——
 * 命令行根本不读，文档和 /init 却都说「每趟活儿开跑前都会先读」：
 * 用户照着 /init 写好了规矩，下一趟任务的提示词里一个字都没有。
 *
 * 规则（和 Codex / Claude Code 的惯例一致）：
 *   - 从工作目录往上走，走到最近的那个带 .git 的目录为止；不在 git 仓库里就只看工作目录本身，
 *     不然 ~/AGENTS.md 这种和项目无关的东西也会被捎进来
 *   - 每一层只带一份：AGENTS.md 优先，空的或读不出来才轮到 CLAUDE.md
 *   - 几份共用一个字数上限，离工作目录越近的越优先分到；拼进提示词时从根往下排，越靠后越具体
 */
const fs = require("fs");
const path = require("path");

/** 同一件事只喊一次：这些警告在每趟任务开头都会走一遍，喊三次就再没人看了 */
const warnedOnce = new Set();
function warnOnce(key, msg) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(msg);
}

// 项目规范塞进系统提示词的上限。再长就开始挤掉提示词里别的东西（工具说明、专家名单）
const MEMO_MAX = 6000;
// 往上找 git 根最多走这么多层：防着一个挂得极深的目录一路 stat 到根
const MAX_DEPTH = 24;

/**
 * 规范太长时截一段，**并且把截了这件事说出来**。
 *
 * 老写法是 .slice(0, 6000)，一声不吭。一份两万字的 CLAUDE.md 有四分之三根本没进提示词，
 * 而模型看到的是一份「看起来很完整」的规范——它不知道后面还有，于是照着前四分之一干活，
 * 用户看到的是「我明明在 CLAUDE.md 里写了不许这样」。这种事查不出来：日志里什么都没有。
 *
 * 现在两头都留话：正文里告诉模型「还有一截没给你，拿不准就自己去读整份」，
 * 控制台告诉用户「你这份太长了，建议拆一拆」。
 */
function clampMemo(txt, fname, fp, max = MEMO_MAX, warn = warnOnce) {
  if (txt.length <= max) return txt;
  const cut = txt.length - max;
  const head = txt.slice(0, max);
  // 从段落边界断开，别切在半句话中间；找不到合适的边界（整份是一大段）就直接切
  const brk = head.lastIndexOf("\n\n");
  const body = brk > max * 0.6 ? head.slice(0, brk) : head;
  warn(`memo-long:${fp}:${txt.length}:${max}`,
    `[项目规范] ${fname} 有 ${txt.length} 字，超过 ${max} 字上限，只带了前面一部分（少了约 ${cut} 字）。` +
    `建议精简，或者把细则拆成单独的文件让 agent 需要时自己读。`);
  return `${body}\n\n（${fname} 太长，这里只放了前面一部分，后面还有约 ${cut} 字没带上。` +
    `遇到拿不准的规矩，先用 read_file 把 ${fname} 整份读一遍再动手。）`;
}

/** 一个目录里的那份规范：AGENTS.md 优先，空的或读不出来才轮到 CLAUDE.md。一份都没有返回 null */
function memoIn(dir, warn = warnOnce) {
  for (const fname of ["AGENTS.md", "CLAUDE.md"]) {
    const fp = path.join(dir, fname);
    if (!fs.existsSync(fp)) continue;
    let txt = "";
    try {
      txt = fs.readFileSync(fp, "utf8").trim();
    } catch (e) {
      // 以前这儿是个 catch {}：规范没带上，模型照跑，用户以为写进去的规矩生效了。
      warn(`memo-read:${fp}`, `[项目规范] ${fname} 读不出来（${e.message}），这一趟没带上它`);
      continue;
    }
    // 空文件不算数。老写法在这儿也 break，于是一个空的 AGENTS.md 能把旁边写满规矩的 CLAUDE.md 挡在门外
    if (!txt) continue;
    return { fname, fp, txt };
  }
  return null;
}

/** 从 dir 往上到最近的 git 仓库根，根在前。不在仓库里就只有 dir 自己 */
function chainToGitRoot(dir) {
  const start = path.resolve(dir);
  const chain = [];
  let cur = start;
  for (let i = 0; i < MAX_DEPTH; i++) {
    chain.unshift(cur);
    // .git 可能是目录（普通仓库）也可能是文件（worktree / submodule），都算仓库根
    if (fs.existsSync(path.join(cur, ".git"))) return chain;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return [start];
}

/** 这个工作目录会带上哪几份规范（根在前），每份带多少字。/status 和拼提示词都用它 */
function memoFiles(dir, { max = MEMO_MAX, warn = warnOnce } = {}) {
  if (!dir) return [];
  let chain;
  try { chain = chainToGitRoot(dir); } catch { return []; }
  const found = [];
  for (const d of chain) {
    const m = memoIn(d, warn);
    if (m) found.push({ ...m, rel: path.relative(dir, m.fp) || m.fname });
  }
  // 离工作目录最近的先分字数：子目录的规矩最具体，挤不下时该让的是根上那份通用的
  let left = max;
  for (let i = found.length - 1; i >= 0; i--) {
    const f = found[i];
    if (left < 200) { f.body = null; f.chars = 0; continue; }
    f.body = clampMemo(f.txt, f.rel, f.fp, left, warn);
    f.chars = Math.min(f.txt.length, left);
    left -= f.chars;
  }
  const dropped = found.filter((f) => f.body === null);
  if (dropped.length) {
    warn(`memo-drop:${dir}:${dropped.map((f) => f.fp).join("|")}`,
      `[项目规范] ${dropped.map((f) => f.rel).join("、")} 没带上：离工作目录更近的那几份已经用满了 ${max} 字上限`);
  }
  return found;
}

/** 拼进系统提示词的那段。一份都没有返回 "" */
function memoContext(dir, opts) {
  const found = memoFiles(dir, opts);
  if (!found.length) return "";
  const parts = [];
  for (const f of found) {
    if (f.body === null) {
      parts.push(`（${f.rel} 也是项目规范，但字数上限已经用完没带上；涉及它管的事先用 read_file 读一遍。）`);
      continue;
    }
    parts.push(`项目目录里的 ${f.rel}（项目既定规范，必须遵守）：\n${f.body}`);
  }
  if (found.length > 1) parts.unshift("下面几份规范从仓库根往工作目录排，越靠后的越具体，两份说法冲突时以靠后的为准。");
  return parts.join("\n\n");
}

module.exports = { MEMO_MAX, warnOnce, clampMemo, memoIn, chainToGitRoot, memoFiles, memoContext };
