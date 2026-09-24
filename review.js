// @ts-check
"use strict";
/**
 * /review 和 `openworkbuddy review [基准]`：让它把这批改动当别人的代码挑一遍毛病。
 *
 * diff 由这儿自己取好塞进去，不让模型去跑 git：审查按「只看不动」跑（ask 模式，手里没有 shell），
 * 看的是哪一份改动由人定，不由模型去猜——它跑错一个 git diff 参数，审的就是另一批东西。
 *
 * 看哪一份：
 *   不给基准   工作区里还没提交的（暂存 + 未暂存），外加没进 git 的新文件
 *   给了基准   这条分支从跟基准分叉那一刻起的全部改动（含没提交的）
 * 太长就截，并在提示词里明说截了多少——审了一半却以为审完了，比不审还糟。
 */
const { execFileSync } = require("child_process");

const DIFF_MAX = 80000;   // 字符。再多模型也看不仔细，不如让人分几次审
const UNTRACKED_MAX = 50;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
}

/** 取改动。返回 { error } 或 { base, label, diff, stat, untracked, total, truncated, empty } */
function collect(cwd, base) {
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") throw new Error("x");
  } catch { return { error: "这个目录不是 git 仓库，没法按改动审。换到仓库里再来（交互里 /cd，命令行 -C）" }; }
  const b = String(base || "").trim();
  let from = "", label = "";
  if (b) {
    if (b.startsWith("-")) return { error: `「${b}」不像分支名或提交号` };
    try { git(cwd, ["rev-parse", "--verify", "--quiet", b + "^{commit}"]); }
    catch { return { error: `仓库里找不到「${b}」这个分支或提交` }; }
    try { from = git(cwd, ["merge-base", b, "HEAD"]).trim(); }
    catch { return { error: `「${b}」跟当前分支没有共同祖先，没法算这条分支改了什么` }; }
    label = `从 ${b} 分叉以来的全部改动（含没提交的）`;
  } else {
    let hasHead = true;
    try { git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]); } catch { hasHead = false; }
    from = hasHead ? "HEAD" : "";
    label = "还没提交的改动";
  }
  const diffArgs = from ? ["diff", "--no-color", "--no-ext-diff", from] : ["diff", "--no-color", "--no-ext-diff", "--cached"];
  const full = git(cwd, diffArgs);
  const stat = git(cwd, diffArgs.concat("--stat")).trim();
  let untracked = [];
  if (!b) {
    untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  }
  const truncated = full.length > DIFF_MAX;
  return {
    base: b, label, stat, untracked,
    diff: truncated ? full.slice(0, DIFF_MAX) : full,
    total: full.length, truncated,
    empty: !full.trim() && !untracked.length,
  };
}

/** 交给模型的那段话 */
function prompt(r) {
  const more = r.untracked.length
    ? `\n\n还有 ${r.untracked.length} 个没进 git 的新文件，diff 里看不到，用 read_file 逐个读：\n` +
      r.untracked.slice(0, UNTRACKED_MAX).map((f) => "- " + f).join("\n") +
      (r.untracked.length > UNTRACKED_MAX ? `\n- …另有 ${r.untracked.length - UNTRACKED_MAX} 个没列` : "")
    : "";
  const cut = r.truncated
    ? `\n\n注意：diff 共 ${r.total} 字符，这里只放了前 ${DIFF_MAX}。审完在结论里写明「只审了前一部分」，并列出没看到的文件（对照上面的统计）。`
    : "";
  return [
    `审查这批代码改动：${r.label}。当成同事交上来的代码来审，目标是找出会出错的地方，不是夸它。`,
    "",
    "怎么审：",
    "1. 只报真问题：逻辑错误、边界条件、空值/异常没处理、并发与竞态、资源泄漏、安全（注入、越权、密钥外泄）、数据丢失、跟调用方对不上的接口改动。纯风格偏好不报。",
    "2. 下结论前先用 read_file / search_files 看改动周围和调用它的代码。只凭 diff 猜的，要么去核实，要么标「待核实」。",
    "3. 每条写：严重度（高/中/低）、文件:行号、在什么输入或状态下会出什么错、建议怎么改。按严重度从高到低排。",
    "4. 没找到问题就直说没找到，并说你重点看了哪几处。不许为了凑数硬挑。",
    "5. 只审不改：不要动任何文件。",
    "",
    "改动统计：",
    "```",
    r.stat || "（没有已跟踪文件的改动）",
    "```",
    "",
    "diff：",
    "````diff",
    r.diff.trim() || "（空）",
    "````",
  ].join("\n") + more + cut;
}

module.exports = { collect, prompt, DIFF_MAX };
