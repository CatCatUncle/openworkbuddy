"use strict";
/**
 * 图标名的唯一真源是 public/index.html 里那张 sprite。
 * 服务端也要认这些名字——头像存的是 "rocket" 这种图标名，不是能打出来的字，
 * 再在代码里抄一份清单迟早会跟 sprite 对不上，所以直接从 sprite 解析。
 */
const fs = require("fs");
const path = require("path");

let CACHE = null;

/** sprite 里全部 <symbol id="i-xxx">，去掉 i- 前缀 */
function iconNames() {
  if (CACHE) return CACHE;
  const set = new Set();
  try {
    const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    const re = /<symbol\s+id="i-([a-z0-9-]+)"/g;
    let m;
    while ((m = re.exec(html))) set.add(m[1]);
  } catch {
    // 读不到 sprite 就当一个图标都没有：头像退回「文字 / 上传图片」两条老路，
    // 不能因为读文件失败把登录和改资料一起带崩
  }
  CACHE = set;
  return set;
}

function isIconName(v) {
  const s = String(v == null ? "" : v).trim();
  return !!s && iconNames().has(s);
}

module.exports = { iconNames, isIconName };
