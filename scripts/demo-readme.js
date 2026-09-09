/**
 * 录完 demo 把 GIF 挂进两份 README 的首屏（徽章 / Star 那段之后、第一条 --- 分隔线之前）。
 * 已经挂过就不动；找不到分隔线就不猜位置，交给人手挂。
 * 纯函数放这里不放 record-demo.js：那个文件顶部 require("electron")，node 直接测不了。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ALT = {
  "README.md": "OpenWorkBuddy 演示：说一句话，助理自己干活，交付能打开的文件",
  "README.en.md": "OpenWorkBuddy demo: say what you need, the agent does the work and hands you real files",
};

/** @returns {{ md: string, changed: boolean, reason?: "already"|"no-anchor" }} */
function wireReadme(md, src, alt) {
  if (md.includes(src)) return { md, changed: false, reason: "already" };
  const m = /\r?\n---\r?\n/.exec(md);
  if (!m) return { md, changed: false, reason: "no-anchor" };
  const nl = m[0].startsWith("\r") ? "\r\n" : "\n";
  const block = `<p align="center">${nl}  <img src="${src}" width="960" alt="${alt}">${nl}</p>${nl}`;
  return { md: md.slice(0, m.index) + nl + block + md.slice(m.index), changed: true };
}

/** 把 gifAbs 挂进 root 下两份 README；返回改动了的文件名列表。GIF 不在仓库里就一个都不动。 */
function wireReadmes(root, gifAbs) {
  const rel = path.relative(root, gifAbs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const changed = [];
  for (const name of Object.keys(ALT)) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const r = wireReadme(fs.readFileSync(file, "utf8"), rel, ALT[name]);
    if (!r.changed) continue;
    fs.writeFileSync(file, r.md);
    changed.push(name);
  }
  return changed;
}

module.exports = { wireReadme, wireReadmes, ALT };
