"use strict";
/**
 * 「撤不回来的那一步」长什么样 —— 全站确认框。
 *
 * 跑法：npx electron test/confirm-dialogs.js
 *
 * 背景：这个应用里有 30 多处「删掉 / 清空 / 卸载 / 踢掉」，原来全走 window.confirm()。
 * 它对中文用户是好使的（test/library-mkdir.js 里那条反向对照实测过：prompt 抛、confirm 不抛），
 * 但有三笔账一直欠着，其中一笔是硬伤：
 *
 *   ① **原生框里的字永远翻不了。** 翻译走的是 DOM——文本节点加 MutationObserver——
 *      而 confirm(`删除模型「x」？`) 那句话从头到尾只是个 JS 字符串，一秒钟都没进过 DOM。
 *      英文用户每删一样东西，弹出来的都是中文。31 处，一处没落下，而且任何
 *      「扫一遍界面看还有没有中文」的检查都发现不了——那句话根本不在界面上。
 *   ② 浏览器那边用户一旦勾上「不再显示对话框」，confirm() 从此静默返回 false，
 *      所有删除按钮当场变哑巴。跟当初 prompt() 那个 bug 是同一种长相：点了没反应，也不报错。
 *   ③ 原生模态框离屏测试点不动，于是每一条删除路径都验不了。
 *
 * 所以这一套钉四件事：
 *   A 源码里再不许出现原生 confirm/alert/prompt，而且每处 askConfirm 都得 await
 *     （漏了 await 返回的是 Promise，恒为真——确认框会变成一道摆设，点不点都照删）；
 *   B 每一句会显示出来的话，切英文之后一个汉字都不许剩（带名字/数目的那些realize出样本再查）；
 *   C 对话框本身：取消真的不做事、Esc 和点遮罩算取消、焦点落在撤得回来的那一边；
 *   D 清单塞满时对话框不许顶出屏幕——「算了」按不着的确认框，比没有确认框更糟。
 */

if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron（纯服务端部署没有界面这一层）");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 300000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const path = require("path");
const http = require("http");
const { app, BrowserWindow } = require("electron");

if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const JSDIR = path.join(PUB, "js");
const APPJS = fs.readdirSync(JSDIR).filter((f) => /^app-0.*\.js$/.test(f)).sort();
// 「不许再出现原生框」这条管的是整个 public/js，不只工作台那几个 app-0*：
// 企业后台（admin.js）里全是删部门、吊销 Key、把管理员降成员这种撤不回来的操作，
// 它现在用的是自己那个 confirmBox，但没人拦着它哪天随手写回 confirm()。
const ALLJS = fs.readdirSync(JSDIR).filter((f) => f.endsWith(".js")).sort();

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8",
};
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(String(req.url || "/").split("?")[0]);
      const file = path.join(PUB, path.normalize(rel).replace(/^([/\\.]+)/, ""));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("nope"); }
      res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ────────────────────────────── 源码这一侧 ──────────────────────────────

/** askConfirm( 之后括号配平的那一段。正则配不了嵌套，只能自己数括号，还得跳过字符串里的括号 */
function callChunks(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf("askConfirm(", i)) >= 0) {
    if (/[.\w]/.test(src[i - 1] || "")) { i += 11; continue; }   // 躲开 window.askConfirm 之类
    if (/function\s+$/.test(src.slice(Math.max(0, i - 12), i))) { i += 11; continue; }   // 定义那一行不是调用
    let j = i + 11, depth = 1;
    const start = j;
    while (j < src.length && depth) {
      const c = src[j];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if ("\"'`".includes(c)) { const q = c; j++; while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1; }
      j++;
    }
    out.push({ at: i, body: src.slice(start, j - 1) });
    i = j;
  }
  return out;
}

/**
 * 按「形状」把确认框的选项对象找出来：有 title，还有 ok/danger/cancel/note/placeholder 里的至少一个。
 *
 * 为什么不直接扫 askConfirm( 里面：app-03 的批量操作把整个选项对象传给了一个中转函数
 * （bulk("delete", {title: …})），选项literally不在 askConfirm( 的括号里。
 * 漏掉的那一句照样会弹到用户脸上，所以判据得认对象的形状，不认它写在谁的括号里。
 * 只拿 hint 当标志会把媒体模型那几张能力卡（cap/icon/title/hint）也扫进来——那不是对话框。
 */
function optionLiterals(src) {
  const MARK = /(?:^|[,{\s])(ok|danger|cancel|note|placeholder)\s*:/;
  const out = [];
  const re = /(?:^|[,{\s])title\s*:/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index, depth = 0;
    for (; i >= 0; i--) { const c = src[i]; if (c === "}") depth++; else if (c === "{") { if (!depth) break; depth--; } }
    if (i < 0) continue;
    let j = i + 1; depth = 0;
    while (j < src.length) {
      const c = src[j];
      if ("([{".includes(c)) depth++;
      else if (c === "}" && !depth) break;
      else if (")]}".includes(c)) depth--;
      else if ("\"'`".includes(c)) { const q = c; j++; while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1; }
      j++;
    }
    const body = src.slice(i + 1, j);
    if (MARK.test(body)) out.push({ at: i, body });
  }
  return out;
}

/** 某个字段名后面紧跟的字符串字面量（三元的两边都要，所以是数组） */
function fieldLiterals(chunk, key) {
  const res = [];
  const re = new RegExp("(?:^|[,{\\s])" + key + "\\s*:\\s*", "g");
  let m;
  while ((m = re.exec(chunk))) {
    let k = m.index + m[0].length, depth = 0;
    while (k < chunk.length) {
      const c = chunk[k];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (!depth) break; depth--; }
      else if (c === "," && !depth) break;
      else if ("\"'`".includes(c)) {
        let s = "", k2 = k + 1;
        while (k2 < chunk.length && chunk[k2] !== c) {
          if (chunk[k2] === "\\") { s += chunk[k2 + 1] === "n" ? "\n" : chunk[k2 + 1]; k2 += 2; continue; }
          s += chunk[k2]; k2++;
        }
        res.push(s); k = k2;
      }
      k++;
    }
  }
  return res;
}

const CJK = /[一-鿿]/;
const SRC = {};
for (const f of ALLJS) SRC[f] = fs.readFileSync(path.join(JSDIR, f), "utf8");

/**
 * 把 ${...} 换成像样的样本值，好让整句去过一遍正则。
 * 样本名字必须是 ASCII：拿中文当样本名的话，翻完必然还剩汉字，
 * 这条判据就会把自己判红——第一版就是这么挂的。
 */
function realize(s) {
  return s.replace(/\$\{([\s\S]*?)\}/g, (_, expr) => {
    const e = expr.trim();
    if (/fmtSize|bytes/.test(e)) return "3.2 GB";
    if (/\b(n|i|count|num|total|len|length|size)\b/.test(e)) return "7";   // 数目类：正则那边写的是 (\d+)
    return "Zeta7";                                                        // 名字类：文件名、模型名、画布名…
  });
}

async function main() {
  const srv = await serve();
  const win = new BrowserWindow({
    show: false, width: 1280, height: 820, backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${srv.address().port}/index.html`);
  await new Promise((r) => setTimeout(r, 900));
  const run = (code) => win.webContents.executeJavaScript(code);

  // 语言钉成中文。Electron 的 navigator.language 跟系统走——本机 zh，CI 那台 en，
  // 下面开真框的那几节比的都是中文原文。不钉的话在 CI 上比的是另一份界面，整节白跑。
  // 翻译那一节不受影响：I18N.tr(s, "en") 是纯函数，跟当前语言无关。
  await run('I18N.setLang("zh")');

  // ═════════════ A. 源码：原生框清零，askConfirm 处处 await ═════════════
  console.log("\n【A】撤不回来的那一步，不许再交给原生框");
  {
    const left = [];
    for (const f of ALLJS) {
      SRC[f].split("\n").forEach((ln, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;                     // 注释里提名字不算
        const m = ln.match(/(?:^|[^.\w$])(confirm|alert|prompt)\s*\(/);
        if (!m) return;
        if (new RegExp("function\\s+" + m[1] + "\\b").test(ln)) return;
        left.push(`${f}:${i + 1} ${m[1]}`);
      });
    }
    ok(left.length === 0,
       "★public/js 里一处原生 confirm/alert/prompt 都不剩★ 它们的字进不了 DOM，"
       + "所以永远翻不了；浏览器里还会被「不再显示对话框」静默掐成 false，删除钮当场变哑巴",
       left.slice(0, 8));
    // 名单是 readdir 出来的，别让它哪天悄悄缩水：后台那个文件必须在里面
    ok(ALLJS.includes("admin.js") && ALLJS.length > APPJS.length,
       "这道闸扫的是整个 public/js，企业后台也在里面", ALLJS);
  }
  {
    const 漏 = [];
    for (const f of APPJS) {
      for (const { at } of callChunks(SRC[f])) {
        const before = SRC[f].slice(Math.max(0, at - 7), at);
        if (!/await\s$/.test(before)) 漏.push(f + " @" + SRC[f].slice(0, at).split("\n").length);
      }
    }
    ok(漏.length === 0,
       "★每一处 askConfirm 都是 await 出来的★ 漏一个 await 拿到的是 Promise，恒为真——"
       + "确认框就成了摆设，点「算了」照样删",
       漏);
  }
  {
    const 无题 = [], 默认钮 = [], 转手 = [];
    let n = 0, 选项对象 = 0;
    for (const f of APPJS) {
      for (const { at, body } of callChunks(SRC[f])) {
        n++;
        const line = SRC[f].slice(0, at).split("\n").length;
        // 参数要么是当场写的选项对象，要么是别处建好转手递进来的一个变量（app-03 的批量操作就是后者）
        if (!/\{/.test(body)) { 转手.push(f + ":" + line); continue; }
        if (!fieldLiterals(body, "title").length) 无题.push(f + ":" + line);
      }
      for (const { at, body } of optionLiterals(SRC[f])) {
        选项对象++;
        const line = SRC[f].slice(0, at).split("\n").length;
        // 红钮上必须写动词。「确定」在一排按钮里长得跟「保存」一模一样，人是照位置按的，不是照字按的
        const okv = fieldLiterals(body, "ok");
        if (/danger\s*:\s*true/.test(body) && (!okv.length || okv.some((v) => /^(确定|好|是)$/.test(v)))) 默认钮.push(f + ":" + line);
      }
    }
    ok(n >= 30, `全站确认框共 ${n} 处，都走自家对话框了`, n);
    ok(无题.length === 0, "每处都写了 title：框里得说清在确认什么", 无题);
    ok(默认钮.length === 0, "红钮上写的是动词（删掉/卸载/踢掉…），不是「确定」", 默认钮);
    ok(选项对象 >= n,
       `按形状认出 ${选项对象} 个对话框选项对象 ≥ ${n} 处调用——转手递进去的那 ${转手.length} 个也在里头，`
       + "下面翻译那一关才敢说自己扫全了",
       { 选项对象, 调用: n, 转手 });
  }

  // ═════════════ B. 切英文，一个汉字都不许剩 ═════════════
  console.log("\n【B】英文用户删东西时，弹出来的不能还是中文");
  const 全部句子 = [];
  for (const f of APPJS) {
    for (const { at, body } of optionLiterals(SRC[f])) {
      const line = SRC[f].slice(0, at).split("\n").length;
      for (const key of ["title", "hint", "ok", "cancel", "note", "placeholder"]) {
        for (const v of fieldLiterals(body, key)) {
          if (CJK.test(v)) 全部句子.push({ 出处: `${f}:${line}`, 字段: key, 原句: v, 样本: realize(v) });
        }
      }
    }
  }
  ok(全部句子.length >= 70, `确认框里会显示的中文共 ${全部句子.length} 句`, 全部句子.length);
  {
    const 样本 = 全部句子.map((x) => x.样本);
    // tr() 是纯的，不用真把界面切过去（切一次要走整棵 DOM，也会扰动后面几组几何断言）
    const 译 = await run(`${JSON.stringify(样本)}.map((s) => I18N.tr(s, "en"))`);
    const 漏 = [];
    译.forEach((en, i) => { if (/[一-鿿]/.test(en)) 漏.push({ ...全部句子[i], 翻成: en }); });
    ok(漏.length === 0,
       `★${样本.length} 句确认框文案切英文后一个汉字不剩★ 带名字/数目的整句词典查不到，`
       + "得靠正则——这条就是钉那些正则真的配得上",
       漏.slice(0, 40));
  }
  {
    // 负对照：这套判据得真会红。喂一句词典里绝对没有的话进去。
    const 假 = await run(`I18N.tr("这一句词典里绝对没有，别翻它", "en")`);
    ok(/[一-鿿]/.test(假), "负对照：词典里没有的句子确实原样留着（所以上面那条绿是真绿）", 假);
  }

  // ═════════════ C. 对话框的行为 ═════════════
  console.log("\n【C】取消真的什么都不做，回车不许落在「删掉」上");
  // 每次开框前先把场子清干净：万一上一组留下了收不掉的框，后面每一条 await 都会挂死，
  // 整个用例超时——那时候判定器只看得到「跑崩了」，分不出是真逮住还是自己写坏了
  const 清场 = () => run(`(() => { document.querySelectorAll(".ask-mask").forEach((n) => n.remove()); askConfirm._close = null; return 1; })()`);
  const 开框 = async (opts) => { await 清场();
    return run(`(() => { window.__r = "还没收"; askConfirm(${JSON.stringify(opts)}).then((v) => (window.__r = v)); return 1; })()`); };
  const 等一下 = () => new Promise((r) => setTimeout(r, 60));
  const 看框 = () => run(`(() => { const b = document.querySelector(".ask-box"); if (!b) return { 有框: false };
    const no = b.querySelector(".ask-no"), okb = b.querySelector(".ask-ok"), r = b.getBoundingClientRect();
    return { 有框: true, 标题: b.querySelector(".ask-t").textContent, 提示: (b.querySelector(".ask-h") || {}).textContent || "",
      取消钮: no.textContent, 确定钮: okb.textContent, 红的: okb.classList.contains("is-danger"),
      焦点在: document.activeElement === no ? "算了" : document.activeElement === okb ? "确定" : "别处",
      清单: [...b.querySelectorAll(".ask-li li")].map((x) => x.textContent),
      清单高: (() => { const u = b.querySelector(".ask-li"); return u ? Math.round(u.clientHeight) : 0; })(),
      清单可滚: (() => { const u = b.querySelector(".ask-li"); return !!u && u.scrollHeight > u.clientHeight + 1; })(),
      清单有悬停: [...b.querySelectorAll(".ask-li li")].every((x) => x.title === x.textContent),
      框高: Math.round(r.height), 框底: Math.round(r.bottom), 框顶: Math.round(r.top),
      算了按得着: (() => { const q = no.getBoundingClientRect();
        return q.top >= 0 && q.bottom <= innerHeight && document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) === no; })(),
    }; })()`);

  await 开框({ title: "删掉「报价单.md」？", hint: "从资料库里移走，撤不回来。", ok: "删掉", danger: true });
  await 等一下();
  {
    const v = await 看框();
    ok(v.有框 && v.标题 === "删掉「报价单.md」？" && v.确定钮 === "删掉" && v.红的,
       "框出来了：标题是那句问句，钮上写的是「删掉」，而且是红的", v);
    ok(v.焦点在 === "算了",
       "★焦点落在「算了」上★ 回车是这一步最容易被手快敲下去的键，得落在撤得回来的那一边", v.焦点在);
  }
  await run(`document.querySelector(".ask-no").click()`); await 等一下();
  ok((await run("window.__r")) === false, "点「算了」→ false，调用方那一行 return，什么都不做");
  ok((await run(`!document.querySelector(".ask-box")`)) === true, "收掉了，没在页面上留残骸");

  await 开框({ title: "删掉「a」？", ok: "删掉", danger: true }); await 等一下();
  await run(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`); await 等一下();
  ok((await run("window.__r")) === false, "Esc 也算「算了」");

  await 开框({ title: "删掉「b」？", ok: "删掉", danger: true }); await 等一下();
  await run(`document.querySelector(".ask-mask").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`); await 等一下();
  ok((await run("window.__r")) === false, "点框外的遮罩也算「算了」");

  await 开框({ title: "删掉「c」？", ok: "删掉", danger: true }); await 等一下();
  await run(`document.querySelector(".ask-ok").click()`); await 等一下();
  ok((await run("window.__r")) === true, "点红钮才 true——只有这一条路通向真的删");

  {
    // 同一时刻两个框：前一个必须被收掉且 resolve 成 false，不然它的调用方永远 await 在那儿
    await run(`(() => { window.__a = "挂着"; window.__b = "挂着";
      askConfirm({ title: "第一个" }).then((v) => (window.__a = v));
      askConfirm({ title: "第二个" }).then((v) => (window.__b = v)); return 1; })()`);
    await 等一下();
    const 个数 = await run(`document.querySelectorAll(".ask-box").length`);
    const 留下的 = await run(`(() => { const b = document.querySelectorAll(".ask-box"); return b.length ? b[b.length - 1].querySelector(".ask-t").textContent : ""; })()`);
    const a = await run("window.__a");
    ok(个数 === 1 && 留下的 === "第二个" && a === false,
       "同时开两个：页面上只留一个，前一个按「算了」收掉（不然它的 await 永远不返回）", { 个数, 留下的, 前一个: a });
    await 清场();
  }

  // ═════════════ D. 清单塞满，框不许顶出屏幕 ═════════════
  console.log("\n【D】清单长了，「算了」还得按得着");
  {
    // 60 条而不是 24 条：24 条在 820 高的窗口里就算一点不封高度也还塞得下，
    // 拿它当判据等于没判——把「不封高度」这个变异注进去，那一版照样是绿的
    const 名字 = Array.from({ length: 60 }, (_, i) => `很长很长的文件名_${i}_20260921_归档副本_最终版.md`);
    await 开框({ title: "这些会被直接删掉", hint: "不进回收站，也找不回来。", items: 名字, note: "一共腾出 3.2 GB", ok: "删掉", danger: true });
    await 等一下();
    const v = await 看框();
    ok(v.清单.length === 60 && v.清单[0].includes("很长很长"), "60 条清单都画出来了", v.清单.length);
    ok(v.清单高 <= 200 && v.清单可滚, "清单自己封了高度、能滚，不是把对话框一路撑开", { 清单高: v.清单高, 可滚: v.清单可滚 });
    ok(v.清单有悬停, "每条都挂了 title：名字被截断时悬停看得到全的", v.清单有悬停);
    ok(v.框顶 >= 0 && v.框底 <= 820,
       "★塞 60 条也没顶出屏幕★ 清单自带高度上限和滚动；顶出去的话连「算了」都按不着，比没有确认框更糟",
       { 框顶: v.框顶, 框底: v.框底, 框高: v.框高, 视口高: 820 });
    ok(v.算了按得着 === true, "「算了」在视口里，而且那个点上盖着的就是它本人（不是被别的东西压住）", v.算了按得着);
    await run(`document.querySelector(".ask-no").click()`); await 等一下();
  }
  {
    // 不给清单时不许留一个空 <ul> 在那儿占地方
    await 开框({ title: "没有清单的框" }); await 等一下();
    ok((await run(`document.querySelectorAll(".ask-box .ask-li, .ask-box .ask-note").length`)) === 0,
       "没传 items/note 就一个空壳都不画", 0);
    await run(`document.querySelector(".ask-no").click()`); await 等一下();
  }
  {
    // 名字里带引号/尖括号：全站三百多处属性拼接的老毛病，这儿也得转义
    await 开框({ title: `删掉「a"><img src=x onerror=alert(1)>」？`, items: [`b"><b>粗</b>`] });
    await 等一下();
    const v = await run(`(() => { const b = document.querySelector(".ask-box");
      return { 标题: b.querySelector(".ask-t").textContent, 有注入的img: !!b.querySelector("img"), 有注入的b: !!b.querySelector(".ask-li b"),
               条目title: b.querySelector(".ask-li li").title }; })()`);
    ok(v.标题.includes('a"><img') && !v.有注入的img && !v.有注入的b && v.条目title.includes('b"><b>'),
       "名字里带引号和标签：原样当文字显示，不会被当成 HTML 解析（title 属性里也一样）", v);
    await run(`document.querySelector(".ask-no").click()`); await 等一下();
  }

  console.log(`\n${pass} 过 / ${fail} 挂`);
  win.destroy(); srv.close();
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(() => main().catch((e) => {
  console.error("跑挂了：", e);
  app.exit(1);
}));
