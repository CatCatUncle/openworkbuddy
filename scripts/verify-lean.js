// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const isWindows = process.platform === "win32";
const binary = isWindows ? "lake.exe" : "lake";
const candidates = [path.join(os.homedir(), ".elan", "bin", binary)];
let lake = binary;
if (process.env.PATH) {
  const pathEntries = process.env.PATH.split(path.delimiter);
  const found = pathEntries.map((entry) => path.join(entry, binary)).find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  });
  if (found) lake = found;
}
if (lake === binary) {
  const found = candidates.find((candidate) => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  });
  if (found) lake = found;
}

const result = spawnSync(lake, ["build"], {
  cwd: path.join(__dirname, "..", "docs", "formal"),
  stdio: "inherit",
});
if (result.error && result.error.code === "ENOENT") {
  console.error("Lean 4 未安装。请安装 elan（https://leanprover-community.github.io/get_started.html），再运行 npm run verify:lean。");
  process.exit(1);
}
if (result.error) {
  console.error(`无法启动 Lean 构建：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
