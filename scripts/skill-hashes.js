#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)
"use strict";
/**
 * 内置技能历来出厂过的每一版，逐文件记下指纹，写进 src/platform/builtin-skill-hashes.json。
 *
 * 为什么要这么个文件：装机版启动时要判断「数据目录里这份内置技能有没有人动过」——没动过的才换成新版
 * （paths.js 的 syncBuiltinSkills）。新装的机器有 manifest 记着当初铺进去的是哪一版；
 * 可之前装的老机器什么记录都没有，只能拿「我们发出去过的每一版」挨个比。这张表就是那份底账。
 *
 * 只跑 HEAD 的历史，不跑 --all：CI 上要能一模一样地重算出来，本机独有的 ref（检查点、没推的分支）
 * 会让两边算出两张表，还可能把早就清掉的历史带进一个公开文件。
 * 只收 git 现在还跟踪的技能名：.gitignore 掉的第三方技能包不进这张公开的表，也就永远不会被「管」。
 *
 * 跑法：npm run skill-hashes，改完技能提交前跑一遍。忘了跑，test/skill-sync.js 那道闸会红。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "src", "platform", "builtin-skill-hashes.json");
const { skillBlobHash, _SKIP_IN_SKILL: SKIP } = require("../src/platform/paths");

/** @param {string[]} args */
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

/**
 * 从 git 历史算一遍。
 * @returns {{ skills: string[], files: Record<string, string[]> }}
 */
function compute() {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error("浅克隆拿不到完整历史，先 git fetch --unshallow");
  }
  // 一律带 -z：不带的话 git 把中文文件名转义成带引号的八进制（"skills/…/\345\210\206…"），
  // 跟盘上的名字永远对不上
  const names = [...new Set(git(["ls-files", "-z", "skills"]).split("\0")
    .map((p) => p.split("/")).filter((s) => s.length >= 3).map((s) => s[1]))].sort();
  const keep = new Set(names);
  /** @type {Map<string, Set<string>>} */
  const files = new Map();
  for (const c of git(["rev-list", "--full-history", "HEAD", "--", "skills"]).split("\n").filter(Boolean)) {
    for (const ent of git(["ls-tree", "-r", "-z", c, "--", "skills/"]).split("\0")) {
      const tab = ent.indexOf("\t");
      if (tab < 0) continue;
      const [, type, sha] = ent.slice(0, tab).split(" ");
      if (type !== "blob") continue;
      const rel = ent.slice(tab + 1).slice("skills/".length).normalize("NFC");
      if (!keep.has(rel.split("/")[0])) continue;
      const set = files.get(rel) || new Set();
      set.add(sha.slice(0, 16));
      files.set(rel, set);
    }
  }
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const k of [...files.keys()].sort()) out[k] = [...(files.get(k) || [])].sort();
  return { skills: names, files: out };
}

/**
 * 写成一行一个文件：哪个技能改了一版，diff 里就只多那一行的一个指纹，评审一眼看得出。
 * @param {{ skills: string[], files: Record<string, string[]> }} obj
 */
function serialize(obj) {
  const keys = Object.keys(obj.files).sort();
  return "{\n" +
    '  "_": "内置技能历来出厂过的每一版文件指纹（git blob SHA-1 前 16 位）。npm run skill-hashes 生成，别手改",\n' +
    `  "skills": ${JSON.stringify(obj.skills)},\n` +
    '  "files": {\n' +
    keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(obj.files[k])}`).join(",\n") +
    "\n  }\n}\n";
}

/**
 * 存着的那张表跟现算的比，缺了什么。只报「缺」，不报「多」：多认一版旧的不会删错东西。
 *
 * 豁免一种：现算出来的某一版，正好就是工作区里现在这个文件——那是这次要发出去的版本，
 * 启动时直接跟包里那份比，用不着进表。不豁免的话，每改一次技能都得先提交、再生成、再提交一次。
 * 这道闸红的时机正好是：一个已经发出去过的版本，马上就不再是包里那份了，老用户得靠这张表才认得它。
 * @param {any} saved 存着的那张（读不出来传 null）
 * @param {{ skills: string[], files: Record<string, string[]> }} now
 * @param {string} [root]
 * @returns {string[]}
 */
function stale(saved, now, root = ROOT) {
  const out = [];
  const ok = !!saved && Array.isArray(saved.skills) && !!saved.files && typeof saved.files === "object";
  const savedNames = new Set(ok ? saved.skills : []);
  for (const n of now.skills) if (!savedNames.has(n)) out.push(`技能 ${n} 不在名单里`);
  for (const n of savedNames) if (!now.skills.includes(n)) out.push(`技能 ${n} 已经不出厂了`);
  for (const [rel, hs] of Object.entries(now.files)) {
    // 运行时目录（node_modules、__pycache__ 之类）启动时整个跳过，真有出厂文件放在里头就永远不会被更新
    const junk = rel.split("/").find((s) => SKIP.has(s));
    if (junk) out.push(`${rel} 在 ${junk} 底下，启动时不会被当成出厂文件，换个地方放`);
    const have = new Set(ok && Array.isArray(saved.files[rel]) ? saved.files[rel] : []);
    let cur = null;
    for (const h of hs) {
      if (have.has(h)) continue;
      if (ok) {
        if (cur === null) {
          try { cur = skillBlobHash(fs.readFileSync(path.join(root, "skills", rel))); } catch { cur = ""; }
        }
        if (cur === h) continue;
      }
      out.push(`${rel} ${h}`);
    }
  }
  return out;
}

module.exports = { compute, stale, serialize, OUT };

// 被 require 进来的时候只导出函数，不写文件：闸只是要看一眼，不该顺手把工作区改了
if (require.main === module) {
  const obj = compute();
  fs.writeFileSync(OUT, serialize(obj));
  const versions = Object.values(obj.files).reduce((a, hs) => a + hs.length, 0);
  console.log(`[skill-hashes] ${path.relative(ROOT, OUT)}：${obj.skills.length} 个技能 · ${Object.keys(obj.files).length} 个文件 · ${versions} 个历史版本`);
}
