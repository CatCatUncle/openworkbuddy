#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 编 Windows 沙箱小助手（native/owb-sandbox）→ native/bin/owb-sandbox-<x64|arm64>.exe。
 * 要装 Go。哪台机器都能编（交叉编译、不用 cgo）；发版流水线在打 Windows 包之前跑这一步。
 * 产物不进 git：装机包里那份由流水线现编，从源码跑的 Windows 开发机自己跑一次 npm run build:sandbox。
 */
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "native", "owb-sandbox");
const OUT = path.join(ROOT, "native", "bin");
/** Go 的架构名 → Node 的 process.arch */
const ARCHES = { amd64: "x64", arm64: "arm64" };

function build() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [goarch, arch] of Object.entries(ARCHES)) {
    const out = path.join(OUT, `owb-sandbox-${arch}.exe`);
    execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", out, "."], {
      cwd: SRC,
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, GOOS: "windows", GOARCH: goarch, CGO_ENABLED: "0" },
    });
    console.log(`[沙箱小助手] ${path.relative(ROOT, out)}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  }
}

if (require.main === module) build();
module.exports = { ARCHES, OUT };
