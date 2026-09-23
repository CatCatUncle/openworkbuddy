"use strict";
/**
 * 自己写的斜杠命令：把常用的一段话存成 `.openworkbuddy/commands/<名字>.md`，终端里敲 `/<名字> 参数` 就发出去。
 *
 * 两个地方找：项目里的 `.openworkbuddy/commands/`（跟着仓库走，团队共用）和
 * `~/.openworkbuddy/commands/`（只给自己）。同名时项目那份赢——在这个仓库里干活，就该按这个仓库的规矩。
 * 跟内置命令撞名的不接：`/diff` 永远是内置那条，不然有人放一个 diff.md 就能让 /diff 变成别的意思。
 *
 * 文件本身就是提示词。开头可以有一段 frontmatter，只认 description（/help 里那一行）。
 * 参数填进去的规矩：
 *   $ARGUMENTS  整行参数原样
 *   $1 … $9     按空格切开的第几个（引号里的空格不切）
 * 模板里一个占位符都没写、人又给了参数的，参数接在最后——不然那几个字就悄悄丢了。
 *
 * 纯函数为主：读盘只在 load() 里，展开、切参数都能在测试里直接拿字符串对。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_BYTES = 64 * 1024; // 一条命令的模板再长也就几 K；大到这个数多半是放错了文件

function dirsFor(cwd, home) {
  return [
    { scope: "project", dir: path.join(cwd || process.cwd(), ".openworkbuddy", "commands") },
    { scope: "user", dir: path.join(home || os.homedir(), ".openworkbuddy", "commands") },
  ];
}

function parseFile(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { description: "", body: src.trim() };
  const d = m[1].match(/^description:\s*(.+)$/m);
  return { description: d ? d[1].trim().replace(/^["']|["']$/g, "") : "", body: src.slice(m[0].length).trim() };
}

/**
 * 读两个目录。返回 { list, skipped }：
 *   list    [{ name, description, body, file, scope }]，按名字排
 *   skipped [{ file, why }]  没接上的，每条都说清楚为什么——不接又不说，人会以为是自己写错了模板
 */
function load({ cwd, home, builtins = [] } = {}) {
  const taken = new Set(builtins.map((s) => String(s).toLowerCase()));
  const byName = new Map();
  const skipped = [];
  for (const { scope, dir } of dirsFor(cwd, home)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names.sort()) {
      if (!f.endsWith(".md")) continue;
      const file = path.join(dir, f);
      const name = f.slice(0, -3).toLowerCase();
      if (!NAME_RE.test(name)) { skipped.push({ file, why: "名字只能是小写字母、数字、短横，字母打头" }); continue; }
      if (taken.has(name)) { skipped.push({ file, why: `跟内置的 /${name} 撞名，内置那条优先` }); continue; }
      if (byName.has(name)) { skipped.push({ file, why: `项目里已经有一条 /${name}，项目那份优先` }); continue; }
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      if (st.size > MAX_BYTES) { skipped.push({ file, why: `太大了（${st.size} 字节，上限 ${MAX_BYTES}）` }); continue; }
      const { description, body } = parseFile(fs.readFileSync(file, "utf8"));
      if (!body) { skipped.push({ file, why: "正文是空的" }); continue; }
      byName.set(name, { name, description, body, file, scope });
    }
  }
  return { list: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped };
}

/** 按空格切参数；双引号、单引号里的空格不切，引号本身去掉 */
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || "")))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return out;
}

/** 把参数填进模板。返回最终要发给 agent 的那段话 */
function expand(body, arg) {
  const raw = String(arg || "").trim();
  const parts = splitArgs(raw);
  let used = false;
  const text = String(body).replace(/\$ARGUMENTS\b|\$([1-9])(?![0-9])/g, (all, n) => {
    used = true;
    return n ? (parts[Number(n) - 1] || "") : raw;
  });
  return !used && raw ? `${text}\n\n${raw}` : text;
}

module.exports = { load, expand, splitArgs, parseFile, dirsFor, NAME_RE };
