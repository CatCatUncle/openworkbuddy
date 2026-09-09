"use strict";
/**
 * 演示录屏的「马赛克层」：把临时目录、home 目录、用户名、主机名这些本机信息在页面里替换掉。
 * 纯函数，只产出一段要注入页面的 JS 字符串；录屏脚本和测试都从这里拿，保证录出去的和测过的是同一份。
 */
const os = require("os");

/** 默认要遮的：越长越先替换，免得 home 先被换成 ~ 之后临时目录就对不上了 */
function defaultPairs(demoHome, extra = []) {
  const pairs = [];
  // 调用方额外指定的（IM 的 app_id / bot id、用户自述这类）：整段替换成圆点
  for (const v of extra) if (typeof v === "string" && v.length >= 6) pairs.push([v, "●●●●●●"]);
  if (demoHome) pairs.push([demoHome, "~/OpenWorkBuddy-demo"]);
  pairs.push([os.homedir(), "~"]);
  let user = "", host = "";
  try { user = os.userInfo().username; } catch { /* 没有就算了 */ }
  try { host = os.hostname(); } catch { /* 同上 */ }
  if (host && host.length >= 4) pairs.push([host, "demo-machine"]);
  if (user && user.length >= 3) pairs.push([user, "user"]);
  return pairs.filter(([a]) => a).sort((x, y) => y[0].length - x[0].length);
}

/** 生成注入脚本：立即遮一遍，之后靠 MutationObserver 盯住新出现的字 */
function maskScript(pairs) {
  return `(() => {
  const N = ${JSON.stringify(pairs)};
  const fix = (s) => { for (const [a, b] of N) if (s && s.indexOf(a) !== -1) s = s.split(a).join(b); return s; };
  const fixText = (n) => { const v = fix(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; };
  const fixEl = (el) => {
    for (const a of ["value", "title", "placeholder"]) if (typeof el[a] === "string" && el[a]) { const v = fix(el[a]); if (v !== el[a]) el[a] = v; }
  };
  const walk = (root) => {
    if (!root) return;
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fixText(n);
    if (root.nodeType === 1) fixEl(root);
    if (root.querySelectorAll) root.querySelectorAll("input,textarea,[title],[placeholder]").forEach(fixEl);
  };
  walk(document.documentElement);
  document.title = fix(document.title);
  const mo = new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "characterData") fixText(m.target);
      else if (m.type === "attributes") fixEl(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "value"] });
  window.__demoMask = { pairs: N.length, fix };
  return N.length;
})()`;
}

module.exports = { defaultPairs, maskScript };
