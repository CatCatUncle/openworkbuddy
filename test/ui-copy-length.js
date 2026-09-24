"use strict";
/**
 * 界面文案长度闸门。
 *
 * 设置页曾经每个开关配一段两三百字的说明：为什么要做、正则为什么不够、举三个例子。
 * 那些是写给开发者的，该进注释和 commit，不该进界面。用户只想知道：开了会怎样、默认开没开、花不花钱。
 *
 * 判据：前端源码里每一段用户看得到的连续文字（按标签、引号、${} 切开），汉字数不超过 LIMIT。
 * 注释不算。真有非长不可的（比如法律声明），加进 ALLOW 并写明理由。
 */
const fs = require("fs");
const path = require("path");

const LIMIT = 70;
const ROOT = path.join(__dirname, "..", "public");
const FILES = [
  ...fs.readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js") && f !== "i18n.js").map((f) => path.join("js", f)),
  ...fs.readdirSync(ROOT).filter((f) => f.endsWith(".html")),
];
// "文件:文字开头" → 为什么非长不可
const ALLOW = {
  "js/app-07-canvas-generate.js:请检查这部短剧的镜头顺序": "发给模型的提示词（时间线审片）",
  "js/app-07-canvas-generate.js:你正在控制当前 Open": "发给模型的系统指令（画布对话）",
};

const cjk = (s) => (s.match(/[一-鿿]/g) || []).length;
const bad = [];
let scanned = 0;
for (const rel of FILES) {
  const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
  let inBlock = false;
  lines.forEach((line, i) => {
    let l = line;
    if (inBlock) {
      const e = l.indexOf("*/");
      if (e < 0) return;
      l = l.slice(e + 2); inBlock = false;
    }
    l = l.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
    const open = l.indexOf("/*");
    if (open >= 0) { l = l.slice(0, open); inBlock = true; }
    if (/^\s*(\/\/|\*)/.test(l)) return;
    l = l.replace(/\b(ins|p): "[^"]*"/g, ""); // 模板里的 ins / p 是进系统提示词或输入框的指令，不是界面文案
    l = l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"); // 行尾注释（避开 http://）
    l = l.replace(/\$\{[^{}]*\}/g, "\u0000");
    for (const seg of l.split(/<[^>]*>|["'`\u0000]/)) {
      // 带 \n 的多段文字是填进输入框/发给模型的提示词模板，不是界面说明
      if (seg.includes("\\n")) continue;
      const n = cjk(seg);
      if (!n) continue;
      scanned++;
      if (n <= LIMIT) continue;
      const key = rel + ":" + seg.trim().slice(0, 12);
      if (ALLOW[key]) continue;
      bad.push(`${rel}:${i + 1}  ${n} 字  ${seg.trim().slice(0, 40)}…`);
    }
  });
}

console.log(`界面文案长度闸门：扫了 ${scanned} 段，上限 ${LIMIT} 个汉字`);
if (bad.length) {
  console.log(`\n× ${bad.length} 段太长——界面只说做什么 + 默认值 + 花不花钱，理由写进注释：`);
  for (const b of bad) console.log("  " + b);
  process.exit(1);
}
console.log("全部通过");
