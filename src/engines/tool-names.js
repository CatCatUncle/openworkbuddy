// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 本机引擎报上来的工具名归一。本项目借给 CLI 的那批工具，两个 CLI 那头各有各的叫法：
 *   claude：mcp__openworkbuddy__generate_image
 *   codex ：openworkbuddy.generate_image
 *   命令行入口：owb generate_image '{...}'（claude 记成 Bash，codex 记成 run_shell）
 * 运行页的图标、轨迹条的短标、桌宠那句「正在用…」认的都是 generate_image 这种原名，
 * 认不出就只剩一串前缀。归一之后 CLI 那头的叫法放进 raw_name，回看、排查时还在
 *
 * 前端 app-01.js 的 toolBase 是同一张表的浏览器版（老会话回放时事件里还是原样的名字）
 */
const SERVER = "openworkbuddy";
const PREFIXES = [`mcp__${SERVER}__`, `${SERVER}.`];
// 只认打头就是 owb 的那条命令：前面带 cd、管道之类的，说明不只是调一个工具，照命令显示
const SHIM_RE = /^\s*owb\s+([A-Za-z][\w-]*)(?:\s|$)/;
const SHELLS = new Set(["Bash", "run_shell"]);

/**
 * @param {string} name CLI 报的工具名
 * @param {string} [purpose] 那一步的目的说明（命令行那条就是命令本身）
 * @returns {{name:string, raw_name:string}} raw_name 为空表示原样没动
 */
function normalizeToolName(name, purpose) {
  const raw = String(name || "");
  for (const p of PREFIXES) if (raw.startsWith(p) && raw.length > p.length) return { name: raw.slice(p.length), raw_name: raw };
  if (SHELLS.has(raw) && typeof purpose === "string") {
    const m = SHIM_RE.exec(purpose);
    if (m) return { name: m[1], raw_name: raw };
  }
  return { name: raw, raw_name: "" };
}

/** tool_use / tool_result 事件原地归一；别的事件、认不出的名字原样返回 */
function normalizeToolEvent(ev) {
  if (!ev || (ev.type !== "tool_use" && ev.type !== "tool_result") || !ev.name || ev.raw_name) return ev;
  const n = normalizeToolName(ev.name, ev.purpose);
  return n.raw_name ? { ...ev, name: n.name, raw_name: n.raw_name } : ev;
}

module.exports = { normalizeToolName, normalizeToolEvent, SERVER };
