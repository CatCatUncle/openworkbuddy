// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 测试找入口脚本的唯一读法：entry("server") / entry("cli") / entry("eval/run")。
 *
 *   const { entry } = require("./lib/entry");
 *   spawn(process.execPath, [entry("cli"), "--help"]);   // 原来是 path.join(ROOT, "cli.js")
 *
 * 入口（进程起点、package.json 的 main/bin/scripts、Dockerfile、make-mac-app.sh 直接点名的文件）
 * 在目录重整里一律留在仓库根，所以这张表基本不会变；单独成表是为了跟 test/lib/mod.js 分清：
 * mod 表里的是「会搬家的模块」，这里是「不搬的入口」。两张表的名字不重叠。
 *
 *   entry(名)          → 绝对路径（带扩展名，require / spawn / readFileSync 都能直接用）
 *   entry.rel(名)      → 仓库相对路径（posix），给断言文案、清单比对用
 *   entry.at(根, 名)   → 拼在别的根上（测试自己拷出来的假仓库）
 *   entry.names()      → 所有名字
 * 名字写错当场抛，不返回一个不存在的路径让断言空跑。
 */

const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

const TABLE = Object.freeze({
  server: "server.js",
  cli: "cli.js",
  "electron-main": "electron-main.js",
  "server-host": "server-host.js",
  "eval/run": "eval/run.js",
  "eval/rejudge": "eval/rejudge.js",
  "eval/judge": "eval/judge.js",
  "eval/tasks": "eval/tasks.js",
});

function relOf(name) {
  const rel = Object.prototype.hasOwnProperty.call(TABLE, name) ? TABLE[name] : undefined;
  if (!rel) throw new Error(`entry() 不认识「${name}」：入口表只有 ${Object.keys(TABLE).join(" / ")}（会搬家的模块走 test/lib/mod.js）`);
  return rel;
}

function entry(name) { return path.join(ROOT, relOf(name)); }
entry.rel = relOf;
entry.at = (root, name) => path.join(root, relOf(name));
entry.names = () => Object.keys(TABLE);
entry.has = (name) => Object.prototype.hasOwnProperty.call(TABLE, name);
entry.ROOT = ROOT;
entry.TABLE = TABLE;

module.exports = { entry, ROOT };
