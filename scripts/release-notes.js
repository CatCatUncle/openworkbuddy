#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)
/**
 * 「这一版改了什么」——发版正文最上面那一段。
 *
 * 以前 Release 页只有安装指南加一条 compare 链接：想知道这版改了什么，得点进去翻 20 个 commit。
 * 站在下载页前面的人只想知道一件事——**值不值得现在更新**，而那句话我们早就写好了，
 * 就是 README「最新动态」里那几行人话。
 *
 * 发布流水线传入上一正式 Release 的 tag；本地省略时按版本号取上一标签。
 * 取法不看日期看 tag 区间：拿基线到现在，README 里**新增的**那几行。
 * 按日期取会在同一天发两版时把上一版的也算进来；按 tag 取，发几次就各是各的。
 * 取不到（第一个 tag、或者 CI 上是浅克隆）就干脆一个字不写——
 * 宁可少一段，也别在发版正文里印一段来路不明的东西。
 */
const { execFileSync } = require("child_process");

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
const RE = /^\+(- \*\*\d\d-\d\d\*\* .+)$/;

function prevTag(tag, { cwd } = {}) {
  // 同一天可能发好几个 patch，按版本号排序取紧挨着的上一个，别用时间
  const tags = git(cwd, "tag", "--sort=-v:refname").split("\n").filter(Boolean);
  const i = tags.indexOf(tag);
  return i >= 0 && i + 1 < tags.length ? tags[i + 1] : null;
}

// cwd 只给测试用：在临时仓库里造几个 tag 验抽取器，不去读真历史
function main(tagArg, { cwd, previousTag } = {}) {
  // 参数优先于命令行：被当模块调用时（测试里按 tag 逐个挖）只认传进来的那个。
  // 少了 tagArg 这一档，两次调用都会退回 argv/describe，挖出来的是同一版——
  // 而调用方拿到两份一模一样的东西，看着像「上一版的改动又印了一遍」
  const tag = tagArg || process.argv[2] || git(cwd, "describe", "--tags", "--abbrev=0").trim();
  const prev = previousTag || prevTag(tag, { cwd });
  if (!prev) return "";
  let diff;
  try { diff = git(cwd, "diff", `${prev}..${tag}`, "--unified=0", "--", "README.md"); }
  catch { return ""; } // 浅克隆拿不到上一个 tag 的对象：不写，不猜
  // Reflowing or moving the retained history can make git report old bullets
  // as additions. Only entries absent from the previous release are new.
  const previous = new Set(git(cwd, "show", `${prev}:README.md`).split("\n").map(line => line.trim()));
  const added = diff.split("\n").map((l) => RE.exec(l)).filter(Boolean).map((m) => m[1]).filter(line => !previous.has(line.trim()));
  if (!added.length) return "";
  return "## 这一版改了什么\n\n" + added.join("\n")
    + "\n\n每条对应的代码和判据在 [CHANGELOG](https://github.com/CatCatUncle/openworkbuddy/blob/main/CHANGELOG.md)。\n";
}

if (require.main === module) process.stdout.write(main(process.argv[2], { previousTag: process.argv[3] }));
module.exports = { main, prevTag };
