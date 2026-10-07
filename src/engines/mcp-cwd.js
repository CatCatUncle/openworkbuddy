// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 先切到指定目录，再起真正的 MCP 服务器；stdin / stdout / stderr 原样交给它。
 *
 * 只有 claude 那边用得上：它的 mcp.json 不认 cwd（实测 2.1.291：写了也照样在它自己的工作目录里起）。
 * 插件带来的连接器默认要在插件根里起——`node server.js` 这种相对路径，换个目录就找不到文件。
 * codex 认 cwd，用不着这一层。
 *
 * 用法：node mcp-cwd.js <目录> <命令> [参数...]
 */
const { spawn } = require("child_process");

const [cwd, command, ...args] = process.argv.slice(2);
if (!cwd || !command) {
  process.stderr.write("用法：mcp-cwd.js <目录> <命令> [参数...]\n");
  process.exit(2);
}
let bin = command, argv = args, opts = {}, planEnv = {};
if (process.platform === "win32") {
  // 跟内置那边起连接器同一套（mcp.js 的 StdioTransport）：npx、uvx 是 .cmd 垫片，先认出真身再起
  const real = require("../agent/mcp").resolveWinCommand(command);
  if (real) ({ bin, args: argv, opts, env: planEnv } = require("../platform/win").launchPlan(real, args));
  else opts = { shell: true, windowsHide: true };
}
// 这一层是借 ELECTRON_RUN_AS_NODE 当 node 起的（桌面版没有单独的 node）。不摘掉，
// 真服务器要是个 Electron 应用，也会被当成 node 起
const env = { ...process.env, ...planEnv };
if (!planEnv.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(bin, argv, { cwd, env, stdio: "inherit", windowsHide: true, ...opts });
child.on("error", (e) => {
  process.stderr.write(`MCP 服务器起不来（${command}，目录 ${cwd}）：${e.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); return; }
  process.exit(code == null ? 1 : code);
});
// CLI 收工时只会停这一层：信号原样转给真服务器，别留个孤儿
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { try { child.kill(sig); } catch {} });
