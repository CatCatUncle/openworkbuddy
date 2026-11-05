// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 在 agent 写得到的目录里跑 git 时要加的参数。
 *
 * .git/config 和 .git/hooks 都在工作区里，agent 改得到。可 git 是由应用自己调的，
 * 跑在沙箱外面，于是这些配置就成了沙箱的出口：
 *   core.fsmonitor        git status 时执行一条命令
 *   filter.<x>.clean      git status / diff 读改过的文件时执行
 *   core.hooksPath、钩子   post-index-change、post-checkout 等
 *   log.showSignature     git log 时执行 gpg.program
 *   diff.external         git diff 时执行（这条 -c 盖不掉，见 guard）
 * 命令行的 -c 优先级最高，盖得住仓库配置。筛选器的名字是仓库自己起的，要先查出来逐个盖掉。
 * core.worktree 盖不掉，要读文件内容时还得放进沙箱，见 tools.js sandboxedGit。
 */
const { spawnSync } = require("child_process");

const NULL_FILE = process.platform === "win32" ? "NUL" : "/dev/null";
const FIXED = ["core.fsmonitor=false", `core.hooksPath=${NULL_FILE}`, "core.pager=cat", "log.showSignature=false", "submodule.recurse=false", "core.quotepath=false"];

/** 配了哪些筛选器。读配置不会执行任何东西。 */
function filterNames(cwd) {
  const r = spawnSync("git", ["-C", cwd, "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  return [...new Set(String(r.stdout || "").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^filter\./i, "").replace(/\.(clean|smudge|process)$/i, "")))];
}

/** @returns {string[]|null} 要接在 git 后面的参数；名字里带 = 的筛选器盖不掉，返回 null，调用方别跑 */
function args(cwd) {
  const names = filterNames(cwd);
  if (names.some((name) => /[=\n]/.test(name))) return null;
  const off = names.flatMap((name) => [`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`]);
  return [...FIXED, ...off].flatMap((value) => ["-c", value]);
}

/**
 * 子命令自己的防线。diff.external 不能用 -c 置空：空值也算配了外部程序，
 * git diff 会去执行空命令然后报错，所以必须在 diff 后面带 --no-ext-diff。
 * @param {string[]} list 子命令和它的参数
 */
function guard(list) {
  const at = list.findIndex((item) => !item.startsWith("-"));
  return list[at] === "diff" ? [...list.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...list.slice(at + 1)] : list;
}

module.exports = { args, guard };
