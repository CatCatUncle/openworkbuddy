// @ts-check
"use strict";
/**
 * 演示录屏的「马赛克层」：把临时目录、home 目录、用户名、主机名这些本机信息在页面里替换掉。
 * 纯函数，只产出一段要注入页面的 JS 字符串；录屏脚本和测试都从这里拿，保证录出去的和测过的是同一份。
 * 原先在 scripts/demo-mask.js，可 scripts/ 不进安装包，record_web_demo 在装好的应用里也要用它，
 * 所以搬到 lib/；scripts/demo-mask.js 留一行转发，record-demo.js 和各处测试照旧 require 那边。
 */
const os = require("os");

/**
 * 默认要遮的：越长越先替换，免得 home 先被换成 ~ 之后临时目录就对不上了
 * @param {string | null} [demoHome]
 * @param {any[]} [extra]
 * @returns {[string, string][]}
 */
function defaultPairs(demoHome, extra = []) {
  /** @type {[string, string][]} */
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

/**
 * 生成注入脚本：立即遮一遍，之后靠 MutationObserver 盯住新出现的字。返回清单条数。
 * 两种装法都得能用：页面加载完再 executeJavaScript（record-demo.js），和 CDP 的
 * Page.addScriptToEvaluateOnNewDocument（record_web_demo）——后者跑的时候 <html> 还没解析出来。
 * @param {[string, string][]} pairs
 * @returns {string}
 */
function maskScript(pairs) {
  return `(() => {
  const N = ${JSON.stringify(pairs)};
  const S = JSON.stringify(N);
  // 同一份清单再装一遍（新文档脚本和手动补装撞上）直接返回：两个观察者互相触发只会白忙
  if (window.__demoMask && window.__demoMask.sig === S) return N.length;
  const once = (s) => { for (const [a, b] of N) if (s && s.indexOf(a) !== -1) s = s.split(a).join(b); return s; };
  // 换完可能又冒出清单里更长的那项（你列了「user」，本机用户名也被换成 user）：再过一遍直到不变，最多四遍
  const fix = (s) => { for (let k = 0; k < 4; k++) { const v = once(s); if (v === s) return v; s = v; } return s; };
  // 脚本、样式里的字不上屏；新文档时就注入，脚本还没执行，改了反而把页面自己的代码和选择器改坏
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  const fixText = (n) => {
    const p = n.parentNode;
    if (p && SKIP[String(p.nodeName).toUpperCase()]) return;
    const v = fix(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v;
  };
  const ATTRS = ["title", "placeholder", "alt", "aria-label"];
  const fixEl = (el) => {
    try {
      const tag = String(el.tagName || "").toUpperCase();
      // 输入框上屏的是 .value（用户打的、脚本塞的），不是 value 这个 attribute，两样都遮；
      // 下拉框、按钮的 value 是给程序读的，改了页面逻辑就不对了，不碰。
      // 隐藏域和密码框根本不上屏，改了只会让表单提交出去的东西变样
      const ty = tag === "INPUT" ? String(el.type || "").toLowerCase() : "";
      const typed = (tag === "INPUT" && ty !== "hidden" && ty !== "password") || tag === "TEXTAREA";
      if (typed && typeof el.value === "string" && el.value) { const v = fix(el.value); if (v !== el.value) el.value = v; }
      if (el.getAttribute) for (const a of (typed && tag === "INPUT" ? ATTRS.concat("value") : ATTRS)) {
        const o = el.getAttribute(a);
        if (o) { const v = fix(o); if (v !== o) el.setAttribute(a, v); }
      }
    } catch { /* 个别元素不让写（比如 file 输入框）：别让一个异常把这批变动剩下的全漏掉 */ }
  };
  // 观察者看不进 shadow root（web component 的字都在里面），碰到开放的就单独再挂一个
  const OPTS = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "value", "alt", "aria-label"] };
  const watched = new WeakSet();
  let mo = null;
  const watch = (root) => { if (mo && !watched.has(root)) { watched.add(root); mo.observe(root, OPTS); } };
  const walk = (root) => {
    if (!root) return;
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fixText(n);
    if (root.nodeType === 1) fixEl(root);
    if (root.querySelectorAll) root.querySelectorAll("input,textarea,[title],[placeholder],[alt],[aria-label]").forEach(fixEl);
    const hosts = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
    if (root.nodeType === 1) hosts.unshift(root);
    for (const h of hosts) if (h.shadowRoot) { walk(h.shadowRoot); watch(h.shadowRoot); }
  };
  // 新文档一开头就注入时 documentElement 还是 null：从 document 本身遍历、观察，<html> 一插进来就接得住
  const R = document.documentElement || document;
  mo = new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "characterData") fixText(m.target);
      else if (m.type === "attributes") fixEl(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  walk(R);
  const t = fix(document.title); if (t !== document.title) document.title = t;
  mo.observe(R, OPTS);
  // 脚本直接赋 .value、元素插进来之后才 attachShadow，这两样都不触发观察者：录制器截图前调一次 rescan 补上
  const rescan = () => {
    walk(document.documentElement || document);
    const t2 = fix(document.title); if (t2 !== document.title) document.title = t2;
    return true;
  };
  window.__demoMask = { pairs: N.length, fix, sig: S, rescan };
  return N.length;
})()`;
}

module.exports = { defaultPairs, maskScript };
