#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)
"use strict";
/**
 * 在 GitHub 公开代码里找 OpenWorkBuddy 的副本：node scripts/find-copies.js
 *
 * 搜溯源标记和几段只有这个项目才有的字符串，排除官方仓库，列出命中的仓库。
 * 需要已登录的 gh。GitHub 的代码索引有延迟，也不收录所有仓库，搜不到不代表没有。
 * 真 fork 也会命中，要看 fork 字段。命中只说明含有这段代码，是否违反授权要人工判断。
 */
const { execFileSync } = require("child_process");
const { MARK } = require("../src/util/provenance");

const OFFICIAL = "CatCatUncle/openworkbuddy";
const NEEDLES = [MARK, "商业使用需授权：COMMERCIAL-LICENSE.md", "开发者猫叔 (DeveloperCatUncle)"];

function search(query) {
  try {
    const out = execFileSync("gh", ["search", "code", query, "--limit", "100", "--json", "repository,path"], { encoding: "utf8", timeout: 30000, windowsHide: true });
    return JSON.parse(out);
  } catch (error) {
    console.error(`搜索「${query}」失败：${String(error.message || error).split("\n")[0]}`);
    return [];
  }
}

function main() {
  const repos = new Map();
  for (const needle of NEEDLES) {
    for (const hit of search(`"${needle}"`)) {
      const name = hit.repository && (hit.repository.nameWithOwner || hit.repository.fullName);
      if (!name || name === OFFICIAL) continue;
      const row = repos.get(name) || { name, paths: new Set(), fork: !!hit.repository.isFork };
      row.paths.add(hit.path);
      repos.set(name, row);
    }
  }
  const rows = [...repos.values()].sort((a, b) => b.paths.size - a.paths.size);
  if (!rows.length) return console.log("没有找到别的仓库。");
  for (const row of rows) console.log(`${row.fork ? "fork " : "副本 "} ${row.name}  命中 ${row.paths.size} 个文件，如 ${[...row.paths][0]}`);
}

if (require.main === module) main();
module.exports = { main };
