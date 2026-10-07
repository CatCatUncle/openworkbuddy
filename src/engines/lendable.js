// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 借给本机 CLI 引擎的工具名单，只此一份。
 *
 * 主进程（agent.js 挑这次借哪些、bridge.js 拼参数和提示词）和桥子进程（tool-bridge.js 真去挂）
 * 都从这儿拿。名单原先放在 tool-bridge.js 里，主进程为了读这张表得 require 它，
 * 一 require 就把自己的 console 全改道 stderr、还多读一遍 config.json。表是纯数据，就单放。
 */

/** 借给 CLI 的工具白名单。改这里就是改「本机引擎能用到本项目的什么」。 */
const LENDABLE = [
  "generate_image",   // 生图：CLI 没有，用户最常撞的就是这条
  "generate_video",   // 生视频
  "text_to_speech",   // 配音
  "transcribe_audio", // 录音转文字
  "html_to_image",    // 网页转长图/封面
  "delivery_page",    // 交付页：成片/封面/文案收成一页（本机出，不要浏览器）
  "gen_diagram",      // mermaid / echarts / graphviz 出图
  "look_at_image",    // 看图：引擎模型自己不收图时兜底（claude 的 Read、codex 的 view_image 都能直接看本地图）
  "read_document",    // 读 Office 文档/压缩包：CLI 只会按文本读，拿回去是一坨乱码
  "render_page",      // 带 JS 渲染后取正文（本项目自己的模型不用它，见 tool-bridge.js 的 BRIDGE_ONLY）
  "check_page",       // 打开做好的网页，看控制台报错和实际效果
  "record_web_demo",  // 网页产品演示录屏：CLI 沙箱里起不来 Chrome，借出去在沙箱外跑（要本机 Chrome + ffmpeg）
  "web_search",       // 走本项目配的搜索渠道
  "library_list",     // 资料库：列出参考文件和灵感笔记（不是技能，技能在 skills 目录）
  "library_read",     // 资料库：读其中一个文本文件
  "save_skill",       // 这次趟出来的做法存成技能
  "install_skill",    // 用户让装 GitHub 上的技能：不借的话 CLI 只会照上游 README 装进它自己的 ~/.claude/skills
  "add_connector",    // 用户让接某个 MCP：不借的话 CLI 只会手改 config.json，或者装进它自己的配置，连接器页上都看不见
  "remember",         // 长期记忆：记
  "forget",           // 长期记忆：忘
  "canvas_manage",    // 画布：改节点、交待生成清单。画布任务里生成工具不借（见 agent.js），不借它的话本机引擎既交不了清单、也改不了提示词
];

/**
 * 只读的那几个。问答 / 计划模式那一趟只借这些（agent.js runViaEngine 传 readOnly）。
 * 跟内置引擎这两档摆给模型的那份（agent.js 的 READ_ONLY_TOOLS）取交集：同一个档位，换了底层引擎能做的事不该变多。
 * 桥那头拿到 OPENWORKBUDDY_BRIDGE_READONLY=1 时照这张表再拦一道。
 */
const READ_ONLY = ["look_at_image", "read_document", "render_page", "web_search", "library_list", "library_read"];

// 这两个要真浏览器。桥是个纯 node 子进程，没有 Electron，调了必抛「需要桌面版环境」——
// 挂一个必然失败的工具，比不挂更糟：CLI 那边的模型会先照着做一遍，再回来重想。
const NEEDS_RENDERER = ["html_to_image", "render_page"];

/**
 * 这次真借出去的名单，顺序跟 LENDABLE 一致；不在 LENDABLE 里的名字一律不认。
 * @param {object} [o]
 * @param {string[]|null} [o.tools]  调用方挑过的名单。不传 = 整张表；空数组 = 一个不借
 * @param {boolean} [o.renderer]     借出去的那头有没有浏览器，没有就摘掉 NEEDS_RENDERER
 * @param {boolean} [o.readOnly]     只读的一趟（问答 / 计划）：只留 READ_ONLY 里的
 * @returns {string[]}
 */
function lentFor({ tools, renderer = true, readOnly = false } = {}) {
  const pick = Array.isArray(tools) ? new Set(tools) : null;
  return LENDABLE.filter((n) => (!pick || pick.has(n)) && (renderer || !NEEDS_RENDERER.includes(n)) && (!readOnly || READ_ONLY.includes(n)));
}

// 一个不借时 OPENWORKBUDDY_BRIDGE_TOOLS 写这个，不写空串：cmd 里 `set X=` 就是删掉 X，
// 空值的变量在 Windows 上不一定留得住，丢了就成了「没拿到」
const NONE = "-";

/** 名单 → OPENWORKBUDDY_BRIDGE_TOOLS 的值 */
function toEnv(names) {
  return names && names.length ? names.join(",") : NONE;
}

/** OPENWORKBUDDY_BRIDGE_TOOLS 的值 → 名单。NONE 和空串都是一个不借，不是整张表 */
function parseList(s) {
  return String(s == null ? "" : s).split(",").map((x) => x.trim()).filter((x) => x && x !== NONE);
}

module.exports = { LENDABLE, READ_ONLY, NEEDS_RENDERER, NONE, lentFor, toEnv, parseList };
