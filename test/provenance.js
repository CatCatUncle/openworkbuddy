// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 溯源标记要留在这几处，而且只是字符串：不联网、不改行为、不藏零宽字符。
 *
 *   node test/provenance.js
 */
const fs = require("fs");
const path = require("path");
const { mod } = require("./lib/mod");
const { MARK } = require(mod("provenance"));

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ " + n); } };
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

ok(/^OWB-[0-9a-f]{16}$/.test(MARK), "标记格式对");
for (const f of ["public/index.html", "AGENTS.md", "CLAUDE.md"]) ok(read(f).includes(MARK), `${f} 里有`);
ok(/X-OWB-Mark/.test(read("server.js")), "服务端响应头带标记");
const src = fs.readFileSync(mod("provenance"), "utf8");
ok(!/require\("(https?|net|child_process|fs)"\)|fetch\(/.test(src), "标记模块不联网、不读写文件");
ok(!/[​-‏⁠﻿]/.test(src), "没有零宽字符");

console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
process.exit(fail ? 1 : 0);
