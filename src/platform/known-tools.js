// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 认识的外部 CLI：一张清单（干嘛用、各平台怎么装）+ 别名折回 + 按名字查。
 *
 * 原先长在 doctor.js 里（体检照它逐条查）。可媒体探测、合成任务、run_shell 的报错翻译也要用它，
 * 于是底层模块反过来 require 体检这个 CLI 部件——依赖倒着走。抽到这里之后谁都直接 require 本文件；
 * doctor.js 原名转导出，老的 require("./doctor").knownTool 照样能用。
 *
 * 纯数据加纯函数，零依赖：不读盘、不起进程。
 */

/**
 * 要查哪几个外部 CLI。每条都得能回答「谁在用它」和「怎么装」——只说「缺 pandoc」
 * 而不说它是干嘛的，用户只能去搜。
 */
const EXTERNAL_TOOLS = [
  { name: "ffmpeg", use: "图文成片、录屏", install: { darwin: "brew install ffmpeg", win32: "winget install ffmpeg", other: "apt install ffmpeg" } },
  // Windows 上给 winget 的包：scoop / choco 得先装包管理器本身，winget 是 Windows 10/11 自带的。
  // 包名在 microsoft/winget-pkgs 里核对过（manifests/o/oschwartz10612/Poppler）
  { name: "pdftotext", use: "读 PDF 正文", install: { darwin: "brew install poppler", win32: "winget install oschwartz10612.Poppler", other: "apt install poppler-utils" } },
  { name: "pandoc", use: "Word 互转", install: { darwin: "brew install pandoc", win32: "winget install pandoc", other: "apt install pandoc" } },
  { name: "soffice", use: "Office 转 PDF", install: { darwin: "brew install --cask libreoffice", win32: "winget install LibreOffice", other: "apt install libreoffice" } },
  // 只在 Windows 上查（only）。那边 python3 是应用商店的占位程序，一跑就退 9009「Python was not found」，
  // 技能里写死的 python3 全部跑不起来，得先说清楚本机到底有没有一个真能用的 Python。
  // 别的系统没有这个坑，不加这一条，体检结果跟以前一模一样
  { name: "python", use: "跑技能里的 Python 脚本", only: "win32", install: { darwin: "brew install python", win32: "winget install Python.Python.3.12", other: "apt install python3" } },
];

/** 这一条在这个平台上查不查 */
const toolOn = (t, plat) => !t.only || t.only === plat;

/**
 * 同一个包里装出来的其他命令名 → 该查哪一条的名字。
 *
 * 缺 ffprobe 和缺 ffmpeg 是同一句装法，但报错里出现的是 ffprobe——video-compose 正是
 * 用 `ffprobe` 逐段量时长的。少了这张表，用户会看到「没装 ffprobe」然后去搜一个
 * 根本不存在的包。上面那张表只列每个包的代表命令，别名统一在这儿折回去。
 */
const TOOL_ALIASES = { ffprobe: "ffmpeg", ffplay: "ffmpeg", libreoffice: "soffice", pdfinfo: "pdftotext", pdftoppm: "pdftotext", py: "python" };

/**
 * 这个命令名是不是我们认识的外部工具；认识就连装法一起给回去。
 * 给 run_shell 用：shell 自己喊完 command not found 之后，把那句话翻译成人话。
 * @returns {{name:string, use:string, install:string}|null}
 */
function knownTool(name, platform) {
  const n = String(name || "").trim().toLowerCase();
  const primary = TOOL_ALIASES[n] || n;
  const plat = platform || process.platform;
  const t = EXTERNAL_TOOLS.find((x) => x.name === primary && toolOn(x, plat));
  if (!t) return null;
  return { name: primary, use: t.use, install: t.install[plat] || t.install.other };
}

module.exports = { EXTERNAL_TOOLS, TOOL_ALIASES, toolOn, knownTool };
