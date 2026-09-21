"use strict";
/**
 * 前端测试 — 在 Electron 的真 Chromium 里跑，验证 public/svgfig.js。
 * SVG 清洗要的是"浏览器真正解析出来的树"，用正则或者假 DOM 测等于没测，
 * 所以这里借项目已有的 electron 开一个隐藏窗口，把断言放进渲染进程执行。
 * 由 test/e2e.js 拉起；electron 没装（纯服务端部署）就整体跳过。
 * 单独运行：npx electron test/frontend.js
 */


// ---- 加载期出错要当场红，不许弹框卡死 ----
// 2026-09-13 的教训：这个文件顶层抛了一个「缺文件」的错（skills/brand-guidelines 在
// .gitignore 里，本机有、新克隆没有），Electron 的默认处理是弹一个原生错误框
// ——CI 机器上没人点确定，进程就一直挂着。本机复现过：不装兜底 25 秒后被 timeout 砍掉，
// 装了兜底立刻退出并打出真正的错。
// Electron 的 uncaughtException 处理里有一句「用户自己装了处理器就不弹框」
// （判据是 listenerCount > 1），所以这一段必须在任何 require 之前。
process.on("uncaughtException", (e) => {
  console.error("\u274c 前端测试 加载期就炸了（不是断言失败，是这个文件自己起不来）：");
  console.error((e && e.stack) || String(e));
  process.exit(1);
});
const path = require("path");
const fs = require("fs");
// 这个文件得用 electron 跑，不是 node：`npx electron test/frontend.js`。
// 用 node 跑的话下面 require("electron") 拿到的是个字符串（electron 包的 npm 入口导出的是
// 二进制路径），一路往下走到最后才炸一个 "Cannot read properties of undefined"，
// 看到的人根本猜不到是跑法不对。在这儿就说清楚。
if (typeof require("electron") === "string") {
  console.error("❌ 这个测试要用 electron 跑：npx electron test/frontend.js");
  process.exit(1);
}
const { app, BrowserWindow } = require("electron");

// ---- 看门狗：卡住了要自己喊一声，别让人对着一片空白猜 ----
// 2026-09-13，`npm test` 第一次跑在 CI 的 macOS 机器上，这个进程起来之后再没回过话，
// 连着五次 CI 各挂了一个多小时才被人手动取消。父进程那边现在有超时会强杀，但强杀只拿得到
// 一具尸体——「卡在哪一屏」「electron 到底起没起来」都问不出来。所以这里自己留三样东西：
// app 有没有 ready、最后跑完的是哪一屏、以及超时当场把这两句吐到 stderr 再退。
const WATCH_MS = Number(process.env.OPENWORKBUDDY_TEST_WATCHDOG_MS || 240000);
let READY = false;
let LAST_LINE = "（一屏都还没跑完）";
const _log = console.log.bind(console);
console.log = (...a) => { LAST_LINE = a.map(String).join(" ").trim(); _log(...a); };
const WATCHDOG = setTimeout(() => {
  console.error(
    `❌ 前端测试卡死：${Math.round(WATCH_MS / 1000)} 秒没跑完。` +
    `app.whenReady ${READY ? "已经回来了" : "从来没回来——这台机器上 electron 根本起不来"}；` +
    `最后跑完的一步：${LAST_LINE}`
  );
  process.exit(1);
}, WATCH_MS);

// 这几个跑的都是离屏/隐藏窗口，人眼看不到任何界面，但 macOS 照样往程序坞里塞一个 Electron 图标
// 一跳一跳的，跑一次测试抢一次注意力。声明成后台附属进程，图标就不出现了（窗口本来也没显示）。
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const SVGFIG = fs.readFileSync(path.join(__dirname, "..", "public", "svgfig.js"), "utf8");

// 附件（粘贴/拖拽：文件、图片、大段文字）用的是 app-02.js 里那一段真源码——
// 抄一份到测试里只能证明抄的那份是对的。段落靠标题定位，标题被改了就当场报错，不许静默跳过。
const APP02 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
const I18N_SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "i18n.js"), "utf8"); // 真源：中英词典 + DOM 翻译器
const APP02X = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8");
const UI00_SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-00-ui.js"), "utf8");
// 界面上所有图标都走 app-00-ui.js 的 ic()。测试里一律注真源，不拿 '<i>名字</i>' 当桩——
// 桩出来的图标会把图标名混进 textContent，也会把「箭头指向哪边」这种事糊成一个空 svg，
// 断言就变成了假的。真的 ic() 出的是 <use href="#i-…">，指哪个图标一眼看得出来。
const IC_STUB = UI00_SRC.slice(UI00_SRC.indexOf("function ic(name, cls)"), UI00_SRC.indexOf("/* 自建 tooltip"));
// 每个离屏夹具都是自己拼 <script> 跑的，谁用到图标谁得自己注 ic()。
// 但「这一屏用没用到图标」会随着界面改动悄悄变化——去 emoji 那一轮就是一屏一屏地报 ic is not defined。
// 所以统一在最前面垫一层：夹具自己注了就什么都不做（函数声明会提升，这里看到的就已经是 function），
// 没注过才把真源码那一份挂到 window 上。挂 window 而不是声明顶层变量，免得跟夹具自己那份撞名。
const IC_BOOT = 'if (typeof ic === "undefined") { (function(){\n' + IC_STUB
  + '\n;window.ic = ic; window.setMsg = setMsg; window.isIconName = isIconName; window.ava = ava; window.avaPicks = avaPicks; window.AVATAR_ICONS = AVATAR_ICONS;\n})(); }\n';
const A0 = APP02.indexOf("// ================= ＋ 上传文件到工作空间");
const A1 = APP02.indexOf("// ================= 两条工作线"); // 附件段的下一段（以前是会话历史，中间插进了工作线）
if (A0 < 0 || A1 <= A0) throw new Error("app-02.js 里的附件段找不到了（段标题被改过？），前端测试没法定位真源码");
const ATTACH_SRC = APP02.slice(A0, A1);

// 文件预览同理：路由（这个后缀走 iframe 还是 <audio> 还是当文本）必须验真源码那一份。
// 段落靠标题定位，标题被改了当场报错，不许静默跳过。
const P0 = APP02X.indexOf("// ---------------- 文件预览 ----------------");
const P1 = APP02X.indexOf("// ---- 本地部署预览");
if (P0 < 0 || P1 <= P0) throw new Error("app-01.js 里的文件预览段找不到了（段标题被改过？），前端测试没法定位真源码");
const PREVIEW_SRC = APP02X.slice(P0, P1);

// 路径助手（dirOf / fpath / joinRel / mdImg）。预览段现在直接依赖它们——
// 成果按会话分了子文件夹，整条路径要是被当成一个参数编码，斜杠成 %2F，
// 网页里 <img src="fig.jpg"> 就会去工作区根目录找图，用户看到的是"预览时图片全裂"。
// 一样切真源码，不抄。
const PH0 = APP02X.indexOf("/** 一条工作区相对路径的目录部分");
const PH1 = APP02X.indexOf("/**\n * 单行文本里的 markdown 强调");
if (PH0 < 0 || PH1 <= PH0) throw new Error("app-01.js 里的路径助手段找不到了（函数被改名/挪走？），前端测试没法定位真源码");
const PATHHELP_SRC = APP02X.slice(PH0, PH1);

// 「在这台机器上打开」那组控件画不画，真源是 app-01.js 里这三个小函数。抄一份就成了两套真相，
// 所以照样切真源码：哪天 canOpenOnHost 改判据（比如改成按部署形态判），这一屏立刻跟着变。
const srcLine = (sig) => {
  const i = APP02X.indexOf(sig);
  if (i < 0) throw new Error(sig + " 在 app-01.js 里找不到了，前端测试没法定位真源码");
  return APP02X.slice(i, APP02X.indexOf("\n", i));
};
const srcBlock = (sig) => {
  const i = APP02X.indexOf(sig);
  if (i < 0) throw new Error(sig + " 在 app-01.js 里找不到了，前端测试没法定位真源码");
  return APP02X.slice(i, APP02X.indexOf("\n}", i) + 2);
};
const HOSTCAP_SRC = [srcLine("function amPlatformOwner("), srcLine("function canOpenOnHost("),
                     srcBlock("function openOnHost(")].join("\n");

// 成果面板：文件夹按时间分段（今天／昨天／过去 7 天／更早按月）。分段是纯视图，
// 磁盘上仍是扁平的 任务_MMDD_xxx —— 所以这段逻辑没有任何服务端断言能替它把关，
// 只能在真 Chromium 里喂真数据、读真 DOM。同样切 app-01.js 的真源码。
const FL0 = APP02X.indexOf("function fileIcon(");
const FL1 = APP02X.indexOf("// ================= 助理模式");
if (FL0 < 0 || FL1 <= FL0) throw new Error("app-01.js 里的成果文件列表段找不到了（段标题被改过？），前端测试没法定位真源码");
// 这一屏要验的不止是 DOM 结构，还有「点了收起到底看不看得见」——所以把 index.html 里的
// 真样式整段注进来。只验结构不验样式的话，把 .out-block.packed 那条 CSS 删掉测试照样全绿，
// 用户点了收起却什么也没发生。
const INDEX_SRC = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const INDEX_CSS = (() => {
  const m = INDEX_SRC.match(/<style>([\s\S]*?)<\/style>/);
  if (!m) throw new Error("public/index.html 里找不到内联 <style>，前端测试没法验真样式");
  return m[1];
})();
// 面板顶上那块（按名字找 + 「全部/只看成果」两档）用真 markup，不在测试里另抄一份：
// 抄一份的话 index.html 改了 id 测试照样全绿，用户那边搜索框直接失灵
const INDEX_FP_FILTER = (() => {
  const m = INDEX_SRC.match(/<div class="fp-filter"[\s\S]*?<\/div>\s*<\/div>/);
  if (!m) throw new Error("public/index.html 里找不到 .fp-filter 那块，前端测试没法用真 markup");
  return m[0];
})();

const FILELIST_SRC = APP02X.slice(FL0, FL1);

// 「什么算交到用户手上的成果」这套判据长在产出卡那一段，文件面板的重点标记跟它共用一份——
// 同一个文件在两处该是同一个身份。测试里也切真源码，不另抄一份正则
const DV0 = APP02X.indexOf("// 「交到用户手上的成果」");
const DV1 = APP02X.indexOf("function pathDepth(");
if (DV0 < 0 || DV1 <= DV0) throw new Error("app-01.js 里的成果判据段找不到了，前端测试没法定位真源码");
const DELIVER_SRC = APP02X.slice(DV0, DV1);

// 面板这屏也把真样式注进来：重点标记要是只加类名不加样式，光验 DOM 照样全绿，
// 用户看到的还是一模一样的一行字
const FILELIST_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style>"
  + "<body>" + INDEX_FP_FILTER + "<div id='file-list'></div></body>";

// 对话里的「本回合产出」区：卡片只加不减 → 中途造的临时文件删了卡片还在，还把上限占满。
// 真实事故：agent 为了擦掉生图自带的水印造了 8 个中间文件，干完删了，但 8 张卡正好顶满
// OUT_CARD_MAX，唯一那张成品一张卡都没轮上——用户看到 8 个中间过程、0 个成果。
// 同样切 app-01.js 的真源码，不抄。
const TO0 = APP02X.indexOf("// 把本回合的产出做成卡片挂在对话里");
const TO1 = APP02X.indexOf('document.getElementById("toggle-files").onclick');
if (TO0 < 0 || TO1 <= TO0) throw new Error("app-01.js 里的本回合产出段找不到了（段标题被改过？），前端测试没法定位真源码");
const TURNOUT_SRC = APP02X.slice(TO0, TO1);

const TURNOUT_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style><body></body>";

// 只替掉渲染细节（图标、字号、跳转），判重/上限/回收这些被测逻辑一律用真源码
const TURNOUT_STUBS = `
function esc(s){ const d=document.createElement("div"); d.textContent = s==null?"":String(s); return d.innerHTML; }
${IC_STUB}
function fileIcon(){ return "F"; }
function fmtSize(n){ return (n||0) + " B"; }
const revealBtn = (name) => '<span class="dl rv" data-rv="' + esc(name) + '">RV</span>';
function revealFile(){}
function previewFile(){}
function startPreview(){ return Promise.resolve({ running: true }); }
let previewSrv = {};
function toast(){}
const OFFICE_RE = /\.(doc|ppt|xls)$/i; // 和 app-01 里的一致：桩子只认 .ppt 不认 .pptx 的话，Office 文件的提示文案就验不到
function onActivate(el, fn){ el.addEventListener("click", fn); }
`;

// 「整理文件夹 · 腾出空间」那一屏。
// 这一屏必须在真 Chromium 里跑，因为要验的两件事都只在真 DOM 里成立：
//   ① 勾选框和那个「清掉这 N 个，腾出 XX」的数字是活的——点一下就得跟着变。
//      这个数字是用户按下确定之前唯一的依据，它要是停在初始值上，用户以为自己只删了
//      3.7 MB，实际删掉的是 43 MB。
//   ② 清单里两种条目的形状不一样：逐帧图那一条是**一批**（item.paths 是个数组），
//      其余是单个（item.path 是字符串）。收集路径时漏掉哪一种，用户勾了却没删掉，
//      界面上还报「已清掉」——那是最难查的一种坏。
// 同样切 app-01.js 的真源码，不抄。
const SWEEP_SRC = [srcBlock("function makeSweepCard(ev)"), srcBlock("function renderSweepPanel(p, task)"),
                   srcLine("function fmtSize(")].join("\n");
const SWEEP_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS
  + "</style><body><div class='modal' id='modal-box'><div class='m-body' id='m-body'></div></div></body>";
const SWEEP_STUBS = `
function esc(s){ const d=document.createElement("div"); d.textContent = s==null?"":String(s); return d.innerHTML; }
${IC_STUB}
const mBody = document.getElementById("m-body");
const mask = { classList: { add(){}, remove(){} } };
const modalBox = document.getElementById("modal-box");
const mTitle = { set textContent(v){ window.lastTitle = v; } };
function canOpenOnHost(){ return true; }
function revealFile(name){ window.revealed = name; }
function renderFiles(){ window.filesRerendered = true; }
function toast(msg){ window.toasts = (window.toasts || []).concat(msg); }
function openSweep(scope){ window.reopened = (window.reopened || []).concat(scope && scope.task || "（全部）"); }
// 确认框是应用自绘的（askConfirm），返回 Promise。桩必须也返回 Promise：
// 留着旧的 window.confirm 桩的话，源码里那句 askConfirm 是 ReferenceError，
// 而它抛在 async 处理函数里没人接——「一条请求都没发」照样成立，断言绿得毫无意义。
window.askConfirm = async () => (window.askAnswer === undefined ? true : window.askAnswer);
window.posts = [];
window.fetch = (url, opt) => {
  window.posts.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null });
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, removed: ["a", "b"], bytes: 43300000, skipped: 1, files: [] }) });
};

`;

const SWEEP_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const tick = () => new Promise((r) => setTimeout(r, 30));
  // 一份贴着真回包形状的清单：逐帧图是一批（paths 数组），其余是单个（path 字符串），
  // 过程脚本那组服务端默认不勾
  const PLAN = () => ({
    bytes: 41000000, count: 32, capped: false,
    groups: [
      { key: "frames", label: "抽帧 / 逐帧图", on: true, count: 30, bytes: 40000000,
        items: [{ paths: ["任务A/frames/f_001.jpg", "任务A/frames/f_002.jpg"], path: "任务A/frames/f_*", count: 30, bytes: 40000000, why: "30 张连号抽帧图，这个任务的成片已经出来了" }] },
      { key: "scratch", label: "零碎", on: true, count: 2, bytes: 1000000,
        items: [{ path: "任务A/ck.db", count: 1, bytes: 900000, why: "浏览器落下的临时库" },
                { path: "任务A/cmd.err", count: 1, bytes: 100000, why: "命令的错误输出" }] },
      { key: "script", label: "过程脚本", on: false, count: 1, bytes: 900,
        items: [{ path: "任务A/get_cookie.js", count: 1, bytes: 900, why: "任务目录里随手写的脚本" }] },
    ],
    usage: { bytes: 90000000, count: 40, tasks: [
      { name: "任务A", bytes: 80000000, count: 35 },
      { name: "任务B_名字特别长特别长特别长特别长特别长特别长特别长特别长特别长", bytes: 9000000, count: 4 },
      { name: "", bytes: 1000000, count: 1 },
    ] },
  });

  // ---------- 收尾那张卡 ----------
  const card = makeSweepCard({ type: "sweep", since: 1758000000000, ...PLAN() });
  document.body.appendChild(card);
  const go = card.querySelector(".sw-go");
  const boxes = [...card.querySelectorAll(".sw-rows input")];
  ok("三组各占一行", boxes.length === 3, "实际 " + boxes.length + " 行");
  ok("服务端说不勾的那组，界面上就没勾", boxes[2].checked === false && boxes[0].checked === true);
  ok("按钮上的数字只算勾上的那些", /32 个/.test(go.textContent) && /39\\.1 MB/.test(go.textContent), go.textContent);
  ok("每组都写了为什么认为它是中间物", [...card.querySelectorAll(".sw-why")].every((e) => e.textContent.trim().length > 4));

  boxes[0].checked = false; boxes[0].dispatchEvent(new Event("change"));
  ok("★数字是活的★ 撤掉一组，立刻变小", /2 个/.test(go.textContent) && !/32 个/.test(go.textContent), go.textContent);
  boxes.forEach((b) => { b.checked = false; b.dispatchEvent(new Event("change")); });
  ok("一个都没勾时按钮按不动", go.disabled === true && /没勾/.test(go.textContent), go.textContent);

  // 勾回逐帧图 + 零碎，按下去
  boxes[0].checked = true; boxes[1].checked = true;
  boxes.forEach((b) => b.dispatchEvent(new Event("change")));
  go.click(); await tick();
  const sent = window.posts[window.posts.length - 1];
  ok("真发到了清理那个口", sent && sent.url === "/api/files/sweep");
  ok("★一批的那种也收进去了★ frames 的 paths 数组没漏",
    sent.body.paths.indexOf("任务A/frames/f_001.jpg") >= 0 && sent.body.paths.indexOf("任务A/frames/f_002.jpg") >= 0, JSON.stringify(sent.body.paths));
  ok("单个的那种也收进去了", sent.body.paths.indexOf("任务A/ck.db") >= 0, JSON.stringify(sent.body.paths));
  ok("★没勾的那组一条都没送★ 过程脚本还在用户手上",
    sent.body.paths.indexOf("任务A/get_cookie.js") < 0, JSON.stringify(sent.body.paths));
  ok("带上了这一轮的起点（免得把三周前的旧任务一起端上来）", sent.body.since === 1758000000000);
  ok("删完了卡片收成一句话", card.classList.contains("done") && /腾出/.test(card.textContent), card.textContent.slice(0, 80));
  ok("已经不在的那些也说出来了", /1 个已经不在了/.test(card.textContent), card.textContent.slice(0, 120));
  ok("成果文件那一栏跟着刷新了", window.filesRerendered === true);

  // 反向对照：点「先留着」，一个字节都不许删
  window.posts.length = 0;
  const card2 = makeSweepCard({ type: "sweep", since: 1, ...PLAN() });
  document.body.appendChild(card2);
  card2.querySelector(".sw-no").click(); await tick();
  ok("★「先留着」不发任何请求★", window.posts.length === 0, JSON.stringify(window.posts));
  ok("「先留着」之后告诉用户以后去哪找", /整理文件夹/.test(card2.textContent), card2.textContent.slice(0, 120));

  // ---------- 面板 ----------
  mBody.innerHTML = '<div class="sweep-panel"></div>';
  renderSweepPanel(PLAN(), "");
  const panel = mBody.querySelector(".sweep-panel");
  ok("先摆出「一共占了多大」", /85\\.8 MB/.test(panel.querySelector(".sw-sum").textContent), panel.querySelector(".sw-sum").textContent);
  const tasks = [...panel.querySelectorAll(".sw-task")];
  ok("每个任务占多大都摊开了", tasks.length === 3, "实际 " + tasks.length + " 行");
  ok("最大的那个条最长", parseFloat(tasks[0].querySelector(".bar").style.width) === 100
    && parseFloat(tasks[1].querySelector(".bar").style.width) < 100, tasks.map((t) => t.querySelector(".bar").style.width).join());
  ok("根目录的散文件也有个去处", /散在根目录/.test(tasks[2].textContent), tasks[2].textContent);

  // 展开某一组，看具体是哪些
  const ar = panel.querySelector(".sw-ar");
  ok("默认不展开（一上来糊 200 条路径等于没写）", panel.querySelector(".sw-items").hidden === true);
  ar.click();
  ok("点开才列具体路径", panel.querySelector(".sw-items").hidden === false
    && /任务A\\/frames/.test(panel.querySelector(".sw-items").textContent));

  // 「只整理这个任务」
  window.reopened = [];
  tasks[0].querySelector('[data-act="only"]').click();
  ok("点「只整理这个任务」会带着任务名重开", (window.reopened || []).join() === "任务A", JSON.stringify(window.reopened));
  tasks[0].querySelector('[data-act="open"]').click();
  ok("点「在访达里打开」给的是这个任务的目录", window.revealed === "任务A", window.revealed);

  // 全选 / 回到默认：默认那一档必须真的是服务端说的那一档，不是「全勾」
  panel.querySelector(".sw-pick-all").click();
  ok("全选真的全勾上", [...panel.querySelectorAll(".sw-rows input")].every((b) => b.checked));
  panel.querySelector(".sw-pick-def").click();
  ok("★「回到默认」不是「全勾」★ 过程脚本又变回不勾",
    [...panel.querySelectorAll(".sw-rows input")].map((b) => b.checked).join() === "true,true,false");

  // 删是真删，所以必须拦一道
  window.askAnswer = false; window.posts.length = 0;
  panel.querySelector(".sw-go").click(); await tick();
  ok("★确认框里点了取消就什么都不发★", window.posts.length === 0, JSON.stringify(window.posts));
  // 正向对照：上面那条「什么都不发」自己是立不住的——桩要是坏了（比如还停在旧的
  // window.confirm，源码里那句 askConfirm 直接 ReferenceError），异常抛在 async 处理
  // 函数里没人接，「一条都没发」照样成立。得有一次点「确定」真发出去，才说明拦住它的
  // 是那个「取消」，不是这条路本来就断了
  window.askAnswer = true;
  panel.querySelector(".sw-go").click(); await tick();
  ok("★正向对照★ 同一个按钮点「确定」就真发出去了（证明上一条拦住的是取消，不是路断了）",
    window.posts.length === 1 && window.posts[0].url === "/api/files/sweep", JSON.stringify(window.posts));
  panel.classList.remove("busy");

  // 真样式：特别长的任务名不许把面板顶宽
  modalBox.style.width = "640px";
  const wide = [...panel.querySelectorAll(".sw-task")].some((t) => t.scrollWidth > t.clientWidth + 1);
  ok("长任务名被省略号收住，没把面板顶穿", !wide,
    [...panel.querySelectorAll(".sw-task")].map((t) => t.scrollWidth + "/" + t.clientWidth).join(" "));
  const items = panel.querySelector(".sw-items");
  items.innerHTML = '<div><span>' + "任务A/很深的一层/".repeat(12) + 'f_001.jpg</span><span>1 KB</span></div>';
  ok("展开后的长路径自己换行，也没顶穿", items.scrollWidth <= items.clientWidth + 1, items.scrollWidth + "/" + items.clientWidth);

  // 反向对照：把 word-break 撤掉，同一条长路径立刻顶出去——证明上面那条不是摆设
  const probe = document.createElement("style");
  probe.textContent = ".sweep-panel .sw-items span:first-child { word-break: normal !important; white-space: pre !important; }";
  document.head.appendChild(probe);
  ok("★反向对照★ 撤掉换行规则，长路径当场顶穿（证明挡住它的就是那条规则）",
    items.scrollWidth > items.clientWidth + 1, items.scrollWidth + "/" + items.clientWidth);
  probe.remove();

  // 空清单：不许摆一张「清掉 0 个」的空卡
  mBody.innerHTML = '<div class="sweep-panel"></div>';
  renderSweepPanel({ bytes: 0, count: 0, groups: [], usage: { bytes: 0, count: 0, tasks: [] } }, "");
  ok("没得清的时候说人话，不摆一个按不动的按钮",
    !mBody.querySelector(".sw-go") && /不敢乱动/.test(mBody.textContent), mBody.textContent.slice(0, 120));

  return names;
})()
`;

const TURNOUT_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const F = (name, size) => ({ name, size: size || 100, mtime: "2026-09-05T00:00:00.000Z" });
  const fresh = () => { const d = document.createElement("div"); document.body.appendChild(d); return d; };
  const cards = (b) => [...b.querySelectorAll(".out-card")].map((c) => c.dataset.name);

  // 事故原样重演：8 个擦水印用的中间文件 + 1 张最终成品
  const mid = ["海报.png","_corner.png","_tab3.png","_tab2.png","_tab1.png","_bottom.png","海报v2.png","_wm2.png"].map((n) => F(n));
  const clean = F("海报_clean.png");

  // ── 负向控制：不传完整列表 = 修好之前那条代码路径，必须能把 bug 原样复现出来。
  // 复现不出来说明测试测了个寂寞，后面全绿也不能信
  {
    const b = fresh();
    renderTurnOutputs(b, mid);
    renderTurnOutputs(b, [clean]);
    ok("负向控制：旧行为下成品确实被挤掉了",
      cards(b).length === 8 && !cards(b).includes("海报_clean.png"),
      "旧行为没复现出 bug，这条测试就没有意义：" + JSON.stringify(cards(b)));
  }

  // ── 修好之后
  {
    const b = fresh();
    renderTurnOutputs(b, mid, mid);
    ok("八个中间文件先把卡片上限占满", cards(b).length === 8);
    renderTurnOutputs(b, [clean], [clean]);   // 磁盘上现在只剩成品
    ok("已从磁盘删掉的中间文件，卡片跟着撤掉", !cards(b).some((n) => n !== "海报_clean.png"), JSON.stringify(cards(b)));
    ok("腾出位置后成品补进了卡片区", cards(b).includes("海报_clean.png"));
    const gone = b.querySelector('.out-row[data-name="_wm2.png"]');
    ok("变更清单留痕：行还在，但打上已删除、摘掉下载和定位入口",
      gone && gone.classList.contains("gone") && !gone.querySelector(".dl") && !gone.querySelector(".rv"));
    ok("留痕行的大小位改成了「已删除」", gone.querySelector(".sz").textContent === "已删除");
  }

  // ── 列表被服务端截断（outputFiles 到 500 条就停）时不许回收：
  // 「不在这份列表里」这时候只说明列表满了，不说明文件没了，照删会误杀还活着的产出
  {
    const b = fresh();
    renderTurnOutputs(b, mid, mid);
    const capped = Array.from({ length: 500 }, (_, i) => F("x" + i + ".txt"));
    renderTurnOutputs(b, [clean], capped);
    ok("列表被截断时一律不回收", cards(b).length === 8 && !cards(b).includes("海报_clean.png"));
  }

  // ── 只保留一层开关。
  //    旧版点「本回合产出」第一层只展开一行新标题，文件还躺在更下面一层里。现在标题这一下就把产出摊开：
  //    卡片区、变更清单、超长展开条都收在同一个 .out-body 里，一起出来一起收，没有第二层折叠
  {
    const b = fresh();
    const two = [F("报告.pdf"), F("图.png")];
    renderTurnOutputs(b, two, two);
    const block = b.querySelector(".out-block");
    const body = block.querySelector(".out-body");
    const main = block.querySelector(".out-main");
    ok("有一个管整块的开关", !!main && !block.querySelector(".out-toggle"));
    ok("没有第二层折叠（旧版那个点开再看一层的按钮不存在了）", !block.querySelector(".out-toggle"));
    ok("默认展开：卡片区和变更清单看得见", !block.classList.contains("packed"));
    ok("整块开关的计数是这一回合的文件数", main.querySelector(".cn").textContent === "(2)");
    ok("卡片区、清单这层都收在同一个 out-body 里（没有别的折叠层）",
      body.contains(block.querySelector(".out-grid")) &&
      body.contains(block.querySelector(".out-list")));
    main.click();
    ok("点一下整块收起", block.classList.contains("packed"));
    ok("收起时这一层内容真的看不见了（浏览器算出来的样式，不是有没有加类名）",
      getComputedStyle(body).display === "none");
    ok("收起时标题那行还留着，不然就找不到再点开的地方了",
      getComputedStyle(main).display !== "none" && main.offsetHeight > 0);
    // 箭头是 sprite 里的 chevron，不是 ▾▸ 这两个字符 —— 验它引的是哪个 symbol
    const arOf = (h) => { const u = h.querySelector(".ar use"); return u ? u.getAttribute("href") : "(没画箭头)"; };
    ok("收起时箭头翻过来", arOf(main) === "#i-chevron-right", arOf(main));
    main.click();
    ok("再点一下展开", !block.classList.contains("packed") && arOf(main) === "#i-chevron-down", arOf(main));
    ok("展开后内容又看得见了", getComputedStyle(body).display !== "none");
    renderTurnOutputs(b, [F("补一个.pdf")], [...two, F("补一个.pdf")]);
    ok("再来一批产出时计数跟得上", main.querySelector(".cn").textContent === "(3)");
  }

  // ── svg/png 并卡：只有一半被删时，卡留着，摘掉失效的那条格式链接
  {
    const b = fresh();
    const pair = [F("图.svg", 10), F("图.png", 20)];
    renderTurnOutputs(b, pair, pair);
    ok("svg + png 并成一张卡，PNG 当门面", cards(b).length === 1 && cards(b)[0] === "图.png");
    ok("另一种格式挂在卡上", !!b.querySelector(".oa-alt"));
    renderTurnOutputs(b, [F("图.png", 20)], [F("图.png", 20)]);
    ok("只摘掉失效的格式链接，卡本身不动",
      cards(b).length === 1 && cards(b)[0] === "图.png" && !b.querySelector(".oa-alt"));
  }

  // ── 产出卡要有缩略图：图片直接渲染成能看画面的大缩略（一回合真产出够直观，不再是一行只有文件名的抽屉行），
  //    网页 / Office 文档渲染不出来就给大图标。「要大缩略、要一行清单，不能只见文件名的行」是用户反复强调的。
  //    验的是浏览器算出来的盒子
  {
    const b = fresh();
    // index.html 的 body 是 flex 行，前面几块的容器已经把它挤满了；给块一块固定宽的"对话正文"地
    b.style.cssText = "position:fixed; left:0; top:0; width:820px";
    const three = [F("报告.html", 2048), F("图.png", 512), F("方案.pptx", 4096)];
    renderTurnOutputs(b, three, three);
    ok("卡里没有 iframe（一回合三张网页 = 对话里跑三个小浏览器，不再回来了）",
      !b.querySelector(".out-card iframe") && cards(b).length === 3);
    const html = b.querySelector('.out-card[data-name="报告.html"]');
    const png = b.querySelector('.out-card[data-name="图.png"]');
    const ppt = b.querySelector('.out-card[data-name="方案.pptx"]');
    ok("图片卡是能看画面的缩略图，网页 / PPT 卡用大文件图标",
      !!png.querySelector(".out-thumb img") && !!html.querySelector(".out-thumb .ph") && !!ppt.querySelector(".out-thumb .ph"));
    const a = html.getBoundingClientRect();
    ok("产出卡是竖卡板，宽 168px、高远高于图标钮时代（实际 " + Math.round(a.width) + "×" + Math.round(a.height) + "）",
      a.height > 100 && a.width >= 160);
    // 这条原来钉死「等于 92px」。92 是当时的实现值，不是要求本身——
    // 后来为了让整张图进得来把盒子抬到 120，这条就红了，而界面其实是变好了。
    // 所以改成量它真正要保的那件事：缩略图得占掉卡片一多半，够看清一张图，
    // 而不是退回图标钮时代那种 26px 小点。具体几 px 交给 CSS 去定。
    const thb = png.querySelector(".out-thumb").getBoundingClientRect().height;
    const cardH = png.getBoundingClientRect().height;
    ok("缩略图框占掉卡片一多半、至少 80px 高（够看清一张图，不是 26px 小点）"
      + "（实际 " + Math.round(thb) + "px / 卡高 " + Math.round(cardH) + "px）",
      thb >= 80 && thb > cardH * 0.5);

    // 缩略图地址得拿「这一版文件」当缓存键。以前是 ?t=Date.now()：每来一个文件事件整片卡重建一次，
    // 七张图 = 每次重新下 2.7MB，屏幕上那一格先白一下再慢慢长出来。
    const src1 = png.querySelector(".out-thumb img").getAttribute("src");
    ok("缩略图地址带的是文件自己的版本号，不是当前时间",
      src1.includes("?v=") && src1.includes(encodeURIComponent("2026-09-05T00:00:00.000Z")) && !/[?&]t=\\d{10,}/.test(src1), src1);
    const bSame = fresh(); renderTurnOutputs(bSame, three, three);
    ok("同一版文件重画一遍，地址一个字符没变（浏览器这才用得上缓存）",
      bSame.querySelector('.out-card[data-name="图.png"] .out-thumb img').getAttribute("src") === src1,
      bSame.querySelector('.out-card[data-name="图.png"] .out-thumb img').getAttribute("src"));
    const bNew = fresh();
    const newer = [{ name: "图.png", size: 512, mtime: "2026-09-06T00:00:00.000Z" }];
    renderTurnOutputs(bNew, newer, newer);
    ok("反向对照：文件真被改写（mtime 变了）地址就跟着变，该刷新的一次不少",
      bNew.querySelector(".out-thumb img").getAttribute("src") !== src1,
      bNew.querySelector(".out-thumb img").getAttribute("src"));

    // 卡片只有 120px 宽，而工作空间里真实躺着 2800×7032 的图。原图当缩略图 = 让浏览器
    // 解码 75 MB 位图去画一个指甲盖，一回合八张卡就是 293 MB——用户那句「这个网页版感觉很卡」。
    // 所以图片卡一律要 ?thumb=320，服务端缩不动（纯 node 没有 nativeImage）会自己发原图。
    ok("图片卡要的是 320px 缩略图，不是原图（原图当缩略图，八张卡能让浏览器解码 293 MB 位图）",
      /[?&]thumb=320\\b/.test(src1), src1);
    ok("  ← 垫在底下那层模糊背景也走同一个地址（两份地址不一样 = 同一张图下两遍）",
      (png.querySelector(".out-bg").getAttribute("style") || "").includes("thumb=320"),
      png.querySelector(".out-bg").getAttribute("style"));
    const bSvg = fresh();
    const svg = [F("图表.svg", 3000)];
    renderTurnOutputs(bSvg, svg, svg);
    ok("反向对照：svg 不要缩略图（矢量本来就小，栅格化只会更大更糊）",
      !/thumb=/.test(bSvg.querySelector(".out-thumb img").getAttribute("src")),
      bSvg.querySelector(".out-thumb img").getAttribute("src"));

    // 视频卡给第一帧，不给一个"这是个视频"的图标：一回合出三条片子时，图标分不出哪条是哪条
    const bv = fresh();
    const vids = [F("成片.mp4", 4096), F("笔记.md", 300)];
    renderTurnOutputs(bv, vids, vids);
    const vc = bv.querySelector('.out-card[data-name="成片.mp4"]');
    const vt = vc.querySelector(".out-thumb video");
    ok("视频卡出的是画面缩略图", !!vt, vc.querySelector(".out-thumb").innerHTML.slice(0, 140));
    ok("只拉开头一点点、定格在第一帧（#t=0.1 + preload=metadata）",
      vt.getAttribute("src").endsWith("#t=0.1") && vt.getAttribute("preload") === "metadata", vt.getAttribute("src"));
    ok("缩略图不出声也不自动播（一排卡同时放会吵翻天）",
      vt.muted === true && !vt.hasAttribute("autoplay") && !vt.hasAttribute("controls"));
    ok("画面上压一枚播放标，一眼看出是片子不是图", !!vc.querySelector(".out-thumb .vd-play"));
    ok("反向对照：不是片子的产出卡还是走文件图标（没有画面可给，别硬塞一个空播放器）",
      !!bv.querySelector('.out-card[data-name="笔记.md"] .out-thumb .ph') &&
      !bv.querySelector('.out-card[data-name="笔记.md"] .out-thumb video'),
      (bv.querySelector('.out-card[data-name="笔记.md"] .out-thumb') || {}).innerHTML);

    // 缩略图读不出来（改名 / 挪走 / 删了 / 这个格式浏览器解不了）要退回文件类型图标，
    // 不能留一个一个字都不说的空灰方框
    const bd = fresh();
    const dead = [F("图.png", 512)];
    renderTurnOutputs(bd, dead, dead);
    const dc = bd.querySelector(".out-card");
    ok("读得出来的时候先摆图", !!dc.querySelector(".out-thumb img"));
    dc.querySelector(".out-thumb img").onerror();
    ok("读不出来就退回文件类型图标，不留空灰方框",
      !!dc.querySelector(".out-thumb .ph") && !dc.querySelector(".out-thumb img"), dc.querySelector(".out-thumb").innerHTML);
    ok("卡自己也标一下，样式好跟着收一收", dc.classList.contains("thumb-dead"));
    ok("退回的图标带一句解释（鼠标停住看得到）",
      (dc.querySelector(".out-thumb .ph").getAttribute("title") || "").length > 0);
    ok("坏图的图标是淡的，不假装自己还是张图（浏览器算出来的 opacity）",
      Math.abs(parseFloat(getComputedStyle(dc.querySelector(".out-thumb .ph")).opacity) - 0.55) < 0.01,
      getComputedStyle(dc.querySelector(".out-thumb .ph")).opacity);
    const tops = [html, png, ppt].map((c) => c.getBoundingClientRect().top), lefts = [html, png, ppt].map((c) => Math.round(c.getBoundingClientRect().left));
    ok("三件产出并列一排（卡区是自适应换行的格，不是一列占满整行；top " + tops.map(Math.round).join("/") + "，容器宽 " + Math.round(b.getBoundingClientRect().width) + "）",
      Math.abs(tops[0] - tops[1]) < 1 && Math.abs(tops[1] - tops[2]) < 1);
    ok("网页卡的主操作是「在浏览器打开」、其余是「预览」，字留给读屏、屏幕上不占位",
      html.querySelector(".oa-main .tx").textContent === "在浏览器打开" && ppt.querySelector(".oa-main .tx").textContent === "预览" &&
      html.querySelector(".oa-main .tx").getBoundingClientRect().width <= 1);
    ok("三个图标钮都带 title（没字全靠它）", html.querySelectorAll(".out-acts [title]").length === 3 &&
      html.querySelector('[data-a="br"]').title === "在浏览器打开" && html.querySelector('[data-a="rv"]').title === "打开所在位置" && html.querySelector("a[download]").title === "下载");
    ok("图标钮是 26px 方钮，不是带边框的长条", html.querySelector('[data-a="rv"]').getBoundingClientRect().width <= 28 && getComputedStyle(html.querySelector('[data-a="rv"]')).borderStyle === "none");
    ok("卡能落焦点（tabindex=0），但不套 role=button（里面还有真按钮）", html.tabIndex === 0 && !html.getAttribute("role"));
    // OFFICE_RE 只认 .doc/.ppt/.xls 这种老二进制格式（app 里预览不了，只能交给系统程序）；pptx/docx/xlsx 有结构化预览，走「点击预览」
    ok("卡的 title 写着文件名和点了会怎样", html.title.includes("报告.html") && html.title.includes("点击预览") && ppt.title.includes("点击预览"));
    const legacy = fresh(); renderTurnOutputs(legacy, [F("老报表.xls", 9)], [F("老报表.xls", 9)]);
    const xls = legacy.querySelector('.out-card[data-name="老报表.xls"]');
    ok("老格式（.xls）的卡提示「点击用系统程序打开」", !!xls && xls.title.includes("点击用系统程序打开") && !xls.title.includes("点击预览"));
    ok("大小挂在名字下边", html.querySelector(".out-meta").textContent === "2048 B");
  }

  // ── 「不在这份列表里」≠「已经没了」。
  //    截图里四个文件全被划掉，磁盘上一个都没少。两条真实路径都会掉进来：
  //    回放历史对话（存盘时整份 files 被裁成「这一批变更」）、换工作目录（name 是相对路径，换了坐标系）。
  {
    const A = ["任务_A/格局图.png", "任务_A/格局图.svg", "任务_A/报告.md", "任务_A/PROGRESS.md"].map((n) => F(n));
    const nm = (a) => a.map((x) => x.name);
    const goneN = (b) => b.querySelectorAll(".out-row.gone").length;
    const rowsOf = (b) => [...b.querySelectorAll(".out-row")].map((r) => r.dataset.name).join();

    // 1. 回放：服务端明说了这份 files 是裁过的
    {
      const b = fresh();
      renderTurnOutputs(b, A.slice(0, 2), A.slice(0, 2), { changed: nm(A.slice(0, 2)), partial: true, root: "r1" });
      renderTurnOutputs(b, A.slice(2), A.slice(2), { changed: nm(A.slice(2)), partial: true, root: "r1" });
      ok("回放历史对话：一批批放进来，前一批的产出不会被后一批的清单判死", goneN(b) === 0, rowsOf(b));
      ok("回放完四个文件一个不少", b.querySelectorAll(".out-row").length === 4, rowsOf(b));
    }
    // 2. 老会话没有 partial 标记：靠形状认出来（清单跟 changed 逐条相等 = 存盘裁过的那种）
    {
      const b = fresh();
      renderTurnOutputs(b, A.slice(0, 2), A.slice(0, 2), { changed: nm(A.slice(0, 2)) });
      renderTurnOutputs(b, A.slice(2), A.slice(2), { changed: nm(A.slice(2)) });
      ok("老会话（没有 partial 字段）也认得出裁过的清单", goneN(b) === 0, rowsOf(b));
    }
    // 3. 换工作目录：新目录的完整清单，说明不了旧目录里那几个文件的生死
    {
      const b = fresh();
      renderTurnOutputs(b, A, A, { root: "r1", full: true });
      const other = ["别的目录/新文件.md", "别的目录/x.py", "别的目录/y.json"].map((n) => F(n));
      renderTurnOutputs(b, [other[0]], other, { root: "r2", full: true });
      ok("换了工作目录，旧产出一个都不许被盖「已删除」", goneN(b) === 0, rowsOf(b));
    }
    // 4. 兜底：连 root 都没有（更老的记录），但这份清单跟本块一个都不沾边
    {
      const b = fresh();
      renderTurnOutputs(b, A, A);
      const other = ["别的目录/新文件.md", "别的目录/x.py"].map((n) => F(n));
      renderTurnOutputs(b, [other[0]], other);
      ok("清单跟本块连同一个顶层目录都不沾时，按「换了坐标系」处理，不按「一口气全删了」处理", goneN(b) === 0, rowsOf(b));
    }
    // 5. 反向控制：别为了不误杀就把回收整个关掉——同目录、完整清单里真没了的那个，照打「已删除」
    {
      const b = fresh();
      renderTurnOutputs(b, A, A, { root: "r1", full: true });
      const left = A.filter((x) => x.name !== "任务_A/格局图.svg");
      renderTurnOutputs(b, [F("任务_A/新的.md")], [...left, F("任务_A/新的.md")], { root: "r1", full: true });
      ok("反向控制：同目录完整清单里真删掉的那个，还是照打「已删除」",
        goneN(b) === 1 && b.querySelector('.out-row[data-name="任务_A/格局图.svg"]').classList.contains("gone"), rowsOf(b));
    }
    // 6. 判据本身：拦下来时说得清是哪条拦的（排查时要能对上号）
    {
      const b = fresh();
      renderTurnOutputs(b, A, A, { root: "r1", full: true });
      const blk = b.querySelector(".out-block");
      const why = (live, ev) => reapScope(blk, live, ev).why;
      const got = [
        why(A, { root: "r1", full: true }),
        why(A, { partial: true }),
        why(A, { root: "r2" }),
        why(A, { root: "r1", full: false }),
        why(A, { root: "r1", changed: nm(A) }),
        why([F("别处/z.md")], { root: "r1" }),
        why(null, {}),
      ].join("|");
      ok("六种「这份清单说明不了问题」各有各的判据（" + got + "）",
        got === "|partial|other-root|truncated|legacy-partial|other-tree|no-list", got);
    }
  }

  // ── 出过卡的文件不许在下面再列一遍。
  //    四张图 → 四张卡 + 四行同名文件，同一批产出画两遍，第二遍还没缩略图，纯占版面
  {
    const rowsVisible = (b) => [...b.querySelectorAll(".out-row")].filter((r) => getComputedStyle(r).display !== "none").map((r) => r.dataset.name);
    const four = ["招牌_A.png", "招牌_B.png", "招牌_C.png", "招牌_D.png"].map((n, i) => F(n, 1000 + i));

    {
      const b = fresh();
      renderTurnOutputs(b, four, four);
      ok("四张图给四张卡", cards(b).length === 4, JSON.stringify(cards(b)));
      ok("卡底下不再重复列同样四行（浏览器算出来的可见性，不是有没有类名）",
        rowsVisible(b).length === 0, JSON.stringify(rowsVisible(b)));
      ok("一行都不剩时整块清单收掉，不留一条空横线", b.querySelector(".out-list").hidden === true);
      ok("计数仍按这一回合的真实文件数报，不因为藏起来就少报", b.querySelector(".out-main .cn").textContent === "(4)");
    }

    // 反向控制之一：没出卡的过程文件必须照常留在清单里，不能一刀切把清单关掉
    {
      const b = fresh();
      const mix = [F("方案.pptx", 4096), F("run.js", 300), F("任务_X/PROGRESS.md", 120)];
      renderTurnOutputs(b, mix, mix);
      ok("成品出卡、脚本和过程账本留在清单里",
        cards(b).length === 1 && cards(b)[0] === "方案.pptx" &&
        rowsVisible(b).sort().join() === ["run.js", "任务_X/PROGRESS.md"].sort().join(),
        JSON.stringify(cards(b)) + " / " + JSON.stringify(rowsVisible(b)));
      ok("还有行要显示时清单不收", b.querySelector(".out-list").hidden === false);
    }

    // 反向控制之二：卡撤了但「这个文件没了」这条信息得留着——已删除的行不许被藏
    {
      const b = fresh();
      renderTurnOutputs(b, four, four, { root: "任务", full: true });
      const left = four.slice(0, 3);
      renderTurnOutputs(b, [F("招牌_E.png", 2000)], [...left, F("招牌_E.png", 2000)], { root: "任务", full: true });
      const goneRow = b.querySelector('.out-row[data-name="招牌_D.png"]');
      ok("被删掉的那个：卡撤了，行留着而且看得见",
        goneRow && goneRow.classList.contains("gone") && getComputedStyle(goneRow).display !== "none",
        JSON.stringify(rowsVisible(b)));
    }

    // 上一条其实拦不住「藏掉已删除行」这个改法——卡都撤了，本来就没东西能匹配上。
    // 真会踩的是这种：同一件产出有两份副本共用一张卡，删掉其中一份。
    // 那张卡还在（另一份还活着），按「文件名 + 大小」一认，死掉那份的行就被判成「已经出过卡了」，
    // 用户于是完全看不到「任务子目录里那份没了」这件事
    {
      const b = fresh();
      const dup = [F("任务_Z/招牌_A.png", 1000), F("招牌_A.png", 1000)];
      renderTurnOutputs(b, dup, dup, { root: "任务_Z", full: true });
      ok("前提：两份副本共用一张卡", cards(b).length === 1, JSON.stringify(cards(b)));
      renderTurnOutputs(b, [F("招牌_A.png", 1000)], [F("招牌_A.png", 1000)], { root: "任务_Z", full: true });
      const g = b.querySelector('.out-row[data-name="任务_Z/招牌_A.png"]');
      ok("副本里死掉的那份：卡还在（另一份活着），但「已删除」这行必须照样看得见",
        g && g.classList.contains("gone") && getComputedStyle(g).display !== "none",
        JSON.stringify(rowsVisible(b)) + " gone=" + (g && g.className));
    }

    // 副本：agent 常把成品往根目录再拷一份，两条路径同一个文件。
    // 只按全路径判重的话，那份副本会孤零零留在清单里，看着像凭空多出来一个文件
    {
      const b = fresh();
      const dup = [F("任务_Y/招牌_A.png", 1000), F("招牌_A.png", 1000)];
      renderTurnOutputs(b, dup, dup);
      ok("同名同大小的副本只出一张卡", cards(b).length === 1, JSON.stringify(cards(b)));
      ok("另一条路径那份也跟着藏起来，不留一行看着像多出来的文件",
        rowsVisible(b).length === 0, JSON.stringify(rowsVisible(b)));
    }

    // 「还有 N 个文件」数的必须是看得见的行。数进藏起来的，用户点开会发现啥也没多
    {
      const b = fresh();
      // 用 .log 不用 .txt：.txt 算交付物、会去抢卡位（8 张卡的上限被日志占掉一半），
      // 那样测的就不是折叠计数而是卡位分配了
      const many = [...four, ...Array.from({ length: 9 }, (_, i) => F("log_" + i + ".log", 50 + i))];
      renderTurnOutputs(b, many, many);
      const more = b.querySelector(".out-more");
      const shown = rowsVisible(b).length;
      const moreN = more && getComputedStyle(more).display !== "none" ? Number((more.textContent.match(/[0-9]+/) || [0])[0]) : 0;
      ok("「还有 N 个」只数没出卡的行（看得见 " + shown + " 行，折叠里 " + moreN + " 个，日志共 9 个）",
        shown + moreN === 9, "shown=" + shown + " more=" + moreN);
      // 顺手逮到的：.out-hd.out-more 的 display:flex 盖掉了 hidden 属性，
      // 没东西可折时留下一条空的、看不见却点得着的横条
      const few = fresh();
      renderTurnOutputs(few, [F("只有一个.log", 10)], [F("只有一个.log", 10)]);
      ok("没东西可折时那条「还有 N 个」是真的不见了，不是一条空的隐形横条",
        getComputedStyle(few.querySelector(".out-more")).display === "none");
    }
  }

  // ── 一整包东西被搬进来，不是一百件产出。
  //    2026-09-21 真事故重演：软著登记任务把整个仓库拷进「登记用源码包_测试/」，
  //    那一轮真落盘 124 个，122 个在这一个目录里。卡片只写文件名不写目录，于是用户在
  //    对话里看到 cover_v2.png / README.en.md / 粘贴文本_0909_162900.txt 一排，
  //    字节数还跟仓库根目录那几个一模一样（本来就是拷贝）——他的结论是「别的对话串进来了」。
  {
    const TD = "任务_0921_帮我写一个github开/";
    const BD = TD + "登记用源码包_测试/";
    // 这一包里够格上卡的那些（真存档里就是它们冒出来的），加上一堆源码凑满 122 个
    const 眼熟的 = ["粘贴文本_0909_162900.txt","llms.txt","cover_v3.png","cover_v2.png","README.en.md",
                   "LICENSE-ECOSYSTEM.md","NOTICE.md","CHANGELOG.md","COMMERCIAL-LICENSE.md",
                   "CONTRIBUTING.md","CHANGELOG.en.md"];
    const pack = 眼熟的.map((n) => F(BD + n, 2800));
    for (let i = 0; i < 111; i++) pack.push(F(BD + "mod" + i + ".js", 900));
    const 真成果 = [F(TD + "开源仓库版权授权与软著申请_行动方案.md", 19400), F(TD + "export_registration_source.js", 4600)];
    const batch = [...真成果, ...pack];

    // ★负向对照★ 先证明这批输入真的踩得中老路径：不装闸的话，光这一包里够格上卡的
    // 就有 10 个以上，8 个卡位会被它们塞满，真成果一张都轮不上。
    // 不做这条，下面「只有 1 张文件夹卡」有可能只是因为压根没文件够格上卡
    const 够格的 = pack.filter((f) => cardWorthy(f.name));
    ok("负向对照：这一包里够格上卡的有 " + 够格的.length + " 个，塞得满 8 个卡位（不装闸就是老样子）",
      够格的.length > 8, JSON.stringify(够格的.map((f) => f.name)));
    ok("  ← 其中就有用户眼熟的那三个（README.en.md 是脚手架，已经另外挡掉了）",
      ["cover_v2.png","粘贴文本_0909_162900.txt","llms.txt"].every((n) => 够格的.some((f) => f.name === BD + n)));

    const b = fresh();
    renderTurnOutputs(b, batch, batch, { root: "r1" });
    const cs = cards(b);
    ok("★这一包只占一张卡★ 不再从里面挑 8 个摆成「本回合产出」",
      cs.filter((n) => n.indexOf(BD.slice(0, -1)) === 0).length === 1 && cs.length === 2, JSON.stringify(cs));
    const bc = b.querySelector(".out-card[data-bundle]");
    ok("那张卡说清楚它是个文件夹、里头几个文件", !!bc &&
      bc.querySelector(".out-name").textContent === "登记用源码包_测试/" &&
      bc.querySelector(".out-meta").textContent === "122 个文件",
      bc ? bc.querySelector(".out-info").textContent : "没有这张卡");
    ok("文件夹卡不给预览、不给下载（一包东西没有「预览」可言）",
      !bc.querySelector('[data-a="pv"]') && !bc.querySelector("a[download]") && !!bc.querySelector('[data-a="rv"]'));
    ok("眼熟的那几个名字一个都没再单独摆卡",
      !cs.some((n) => /cover_v2\.png|粘贴文本_0909|README\.en\.md|NOTICE\.md|llms\.txt/.test(n)), JSON.stringify(cs));
    ok("这一轮真正做出来的东西反而摆上了卡（以前被那一包挤掉）",
      cs.includes(TD + "开源仓库版权授权与软著申请_行动方案.md"));
    ok("清单里一条都没少，122 个文件照旧查得到全路径",
      b.querySelectorAll(".out-row").length === 124 &&
      !!b.querySelector('.out-row[data-name="' + BD + 'mod7.js"]'),
      b.querySelectorAll(".out-row").length + " 行");

    // ★负向对照★ 一回合出 12 张成品图也在同一个目录里，条数同样过线——
    // 要是只按「条数」折，这 12 张缩略图会被折成一个文件夹图标，那才是真产出没了
    const 图 = [];
    for (let i = 1; i <= 12; i++) 图.push(F("分镜/第" + i + "幕.png", 5000));
    const bi = fresh();
    renderTurnOutputs(bi, 图, 图, { root: "r1" });
    ok("负向对照：同一目录 12 张成品图不折——它们是多数派，本来就是这一回合的产出",
      !bi.querySelector(".out-card[data-bundle]") && cards(bi).length === 8, JSON.stringify(cards(bi)));

    // ★负向对照★ 条数不到线的目录照旧一张张摆
    const 少 = [F("小任务/图.png", 100), F("小任务/a.js", 10), F("小任务/b.js", 10),
               F("小任务/c.js", 10), F("小任务/d.js", 10), F("小任务/e.js", 10), F("小任务/f.js", 10)];
    const bs = fresh();
    renderTurnOutputs(bs, 少, 少, { root: "r1" });
    ok("负向对照：7 个文件的目录没到 " + OUT_BUNDLE_MIN + " 条，不当成一包",
      !bs.querySelector(".out-card[data-bundle]") && cards(bs).includes("小任务/图.png"), JSON.stringify(cards(bs)));

    // 包还在、只是又写了个别的文件：那张卡不能每来一条 files 事件就被撤一次
    //（文件夹的名字永远不会出现在文件清单里，拿 alive.has() 判它就是这个下场）
    const 又写了 = F(TD + "中间稿.md", 100);
    renderTurnOutputs(b, [又写了], [...batch, 又写了], { root: "r1" });
    ok("包还在的时候，文件夹卡不会被误当成「已删除」撤掉",
      !!b.querySelector(".out-card[data-bundle]") &&
      b.querySelector(".out-card[data-bundle] .out-meta").textContent === "122 个文件");

    // 整包从盘上没了（用户/agent 删了中间产物），卡得跟着走
    const 收尾 = F(TD + "收尾.md", 100);
    renderTurnOutputs(b, [收尾], [...真成果, 又写了, 收尾], { root: "r1" });
    ok("★整包从盘上没了，那张卡也跟着撤★ 不许对着空文件夹写「122 个文件」",
      !b.querySelector(".out-card[data-bundle]"), JSON.stringify(cards(b)));
    ok("但清单里那 122 行留着、打上「已删除」——中途造过什么是真发生过的事，不许抹掉",
      b.querySelectorAll(".out-row.gone").length >= 122,
      b.querySelectorAll(".out-row.gone").length + " 行被标成已删除");

    // README.en.md：英文版 README 跟 README.md 是同一份东西，以前只挡后者
    ok("带语种后缀的 README / PROGRESS 也算脚手架，不上产出卡",
      !isDeliverable("README.en.md") && !isDeliverable("PROGRESS.zh-CN.md") && !isDeliverable("README.md"));
    ok("  ← 别误伤真交付物", isDeliverable("方案.md") && isDeliverable("README_对外版.md") && isDeliverable("年报.en.md"));
  }

  return names;
})()
`;

// 设置页「底层引擎」那三张卡。装了 Claude Code / Codex 的人，得能在**切过去之前**
// 知道它到底跑不跑得起来。旧版唯一一条说实话的通道（测试连接）长在展开区里，
// 而展开区只对**已经选中**的引擎渲染——等于"想知道它行不行，先切过去用它"。
// 徽章那边同样在替人下结论：`--version` 跑通就发一个绿的「已装 ✓」，
// 可它只证明文件在，装了没登录 / 订阅过期 / 被限流，长的全是同一个绿。
// 同样切 app-05.js 的真源码，不抄。
const APP05E = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
const EG0 = APP05E.indexOf("function engVer(");
const EG1 = APP05E.indexOf("function renderPersonaPane(");
if (EG0 < 0 || EG1 <= EG0) throw new Error("app-05.js 里的底层引擎卡片段找不到了（函数名被改过？），前端测试没法定位真源码");
const ENG_SRC = APP05E.slice(EG0, EG1);
// 颜色得连 ui.css 一起注：主题变量（--danger-text 那一套）长在那儿，只注 index.html 的内联样式
// 的话 var(--owb-err-text) 解不出来，红的绿的全塌成黑色——这一屏要量颜色，两份都注
const ENG_UI_CSS = fs.readFileSync(path.join(__dirname, "..", "public", "css", "ui.css"), "utf8");
const ENG_HTML = "<!doctype html><meta charset='utf-8'><style>" + ENG_UI_CSS + "\n" + INDEX_CSS
  + "</style><body><div class='eng-list' id='box' style='width:640px'></div></body>";
// 只替掉渲染细节（转义、图标、存盘、网络），判据/徽章/折叠这些被测逻辑一律用真源码
const ENG_STUBS = `
function esc(s){ const d=document.createElement("div"); d.textContent = s==null?"":String(s); return d.innerHTML; }
function ic(name){ return '<svg class="i" aria-hidden="true"><use href="#i-' + name + '"></use></svg>'; }
var lastSaveError = "";
window.SAVES = [];
async function saveSettings(p){ window.SAVES.push(JSON.stringify(p)); return true; }
`;

const ENG_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + JSON.stringify(msg === undefined ? "断言失败" : msg)); names.push(name); };
  const box = document.getElementById("box");
  const PAY = (cur) => ({ current: cur,
    builtin: { id: "builtin", label: "内置引擎", launchHeader: "OpenWorkBuddy 自己的 agent 循环", note: "用你在「模型」里配置的 API Key 跑" },
    engines: [
      { id: "claude-code", label: "本机 Claude Code", installed: true, version: "2.1.278 (Claude Code)", how: "PATH",
        path: "/u/.local/bin/claude", launchHeader: "claude -p --output-format stream-json",
        note: "用你电脑上已登录的 Claude Code 订阅跑", install: "npm i -g @anthropic-ai/claude-code", models: [], options: {} },
      { id: "codex", label: "本机 Codex", installed: true, version: "codex-cli 0.154.0", how: "PATH",
        path: "/opt/homebrew/bin/codex", launchHeader: "codex exec --json",
        note: "用你电脑上已登录的 Codex 跑", install: "npm i -g @openai/codex", models: [], options: {} },
      { id: "gemini", label: "本机 Gemini", installed: false, version: "", error: "PATH 里没有 gemini", install: "npm i -g 某个包", options: {} },
    ] });
  let reply = () => ({ ok: true });
  window.fetch = async (u, o) => ({ json: async () => (o && o.body ? reply(JSON.parse(o.body).id) : window.__P) });
  const render = async (cur) => { window.__P = PAY(cur); window.SAVES = []; await renderEngineCard(box); };
  const card = (id) => box.querySelector('.eng[data-eng="' + id + '"]');
  const badge = (id) => card(id).querySelector(".eng-bs").textContent.replace(/\\s+/g, " ").trim();
  const tryOf = (id) => card(id).querySelectorAll('[data-act="test"]').length;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms || 120));

  await render("builtin");
  ok("四条引擎都渲染出来了（内置 + 两个装了的 + 一个没装的）", box.querySelectorAll(".eng").length === 4, box.querySelectorAll(".eng").length);

  // ① 这次改的核心：试一试的钮挂在卡本身上，不挂在只有选中才渲染的展开区里
  ok("★没选中的引擎也能当场试能不能用★ 不用先切过去用它一回才知道它行不行",
    tryOf("claude-code") === 1 && tryOf("codex") === 1, [tryOf("claude-code"), tryOf("codex")]);
  ok("内置引擎没这个钮（它走 API Key，没有「本机那份」可试）", tryOf("builtin") === 0);
  ok("没装的那条也没有（先按装法装上再说）", tryOf("gemini") === 0);
  ok("没装的那条仍旧写着装法", card("gemini").textContent.indexOf("npm i -g 某个包") >= 0);

  await render("claude-code");
  // ★反向对照★ 上面那两个 1，可能只是因为两张卡碰巧都有展开区。这条把"钮在不在展开区里"
  // 单拎出来量：没选中的卡压根没有展开区，钮却还在；选中的卡有展开区，钮也不在里面
  ok("★钮确实挂在卡上，不在展开区里★ 没选中的卡没有展开区，钮照样在",
    card("codex").querySelectorAll(".eng-x").length === 0 && tryOf("codex") === 1);
  ok("  ← 选中的那张有展开区，钮也不在里面（全卡就一个，不会点出两份）",
    card("claude-code").querySelectorAll(".eng-x").length === 1
    && card("claude-code").querySelectorAll('.eng-x [data-act="test"]').length === 0
    && tryOf("claude-code") === 1);

  // ② 徽章不替人下结论
  ok("★没真跑过之前，徽章一个绿的都没有★ --version 只证明文件在，不证明能用",
    box.querySelectorAll(".eng-b.ok").length === 0);
  ok("  ← 措辞也不说「已装」，只说「本机有 2.1.278」",
    /本机有 2\\.1\\.278/.test(badge("claude-code")) && badge("claude-code").indexOf("已装") < 0, badge("claude-code"));

  // ③ 版本号削成一个形状，不把产品名说第二遍
  ok("★徽章上不再把产品名重复一遍★ 标题已经写着「本机 Claude Code」了",
    badge("claude-code").indexOf("Claude Code") < 0 && badge("codex").indexOf("codex-cli") < 0,
    [badge("claude-code"), badge("codex")]);
  ok("  ← 两家削出来是同一个形状（都只剩数字）", /本机有 0\\.154\\.0/.test(badge("codex")), badge("codex"));
  ok("engVer 认得各家 --version 的花样",
    engVer("2.1.278 (Claude Code)") === "2.1.278" && engVer("codex-cli 0.154.0") === "0.154.0"
    && engVer("v1.2.3-beta.4") === "1.2.3-beta.4" && engVer("1.7") === "1.7",
    [engVer("2.1.278 (Claude Code)"), engVer("codex-cli 0.154.0"), engVer("v1.2.3-beta.4"), engVer("1.7")]);
  ok("  ← 反向对照：本来就没有版本号的原样端出来，不许凭空造一个",
    engVer("") === "" && engVer("未知") === "未知" && engVer(null) === "" && engVer("nightly") === "nightly");

  // ④ 折叠状态下不摆命令行
  const CMD = "claude -p --output-format stream-json";
  await render("builtin");
  ok("★折叠的卡上不摆命令行★ 「" + CMD + "」对着想用订阅的人说不出任何信息",
    box.textContent.indexOf(CMD) < 0 && box.querySelectorAll(".eng-c").length === 0);
  await render("claude-code");
  const xc = card("claude-code").querySelector(".eng-x .eng-c");
  ok("  ← 反向对照：命令行没被删掉，只是挪进了展开区，跟可执行文件路径摆一块儿",
    !!xc && xc.textContent.indexOf(CMD) >= 0);
  ok("  ← --version 那行原样输出也在展开区里留着，谁要对包名谁去看",
    !!xc && xc.textContent.indexOf("2.1.278 (Claude Code)") >= 0);

  // ⑤ 真测过之后，徽章跟着结论改口
  reply = () => ({ ok: true, ms: 2400, reply: "ok", model: "claude-sonnet-4-6", path: "/u/.local/bin/claude", version: "2.1.278 (Claude Code)" });
  card("claude-code").querySelector('[data-act="test"]').click();
  card("codex").querySelector('[data-act="test"]').click();
  await wait();
  ok("测通了徽章才发绿", card("claude-code").querySelectorAll(".eng-b.ok").length === 1
    && /真跑通了 · 2\\.1\\.278/.test(badge("claude-code")), badge("claude-code"));
  ok("  ← 「不花 API 额度」那条还在（测通了不等于开始烧钱）", badge("claude-code").indexOf("不花 API 额度") >= 0);
  ok("★没选中的那张测通了，会顺口说一句怎么用上它★",
    card("codex").querySelector(".eng-r.ok").textContent.indexOf("点这张卡") >= 0,
    card("codex").querySelector(".eng-r.ok").textContent);
  ok("  ← 选中的那张不重复这句废话（它本来就在用）",
    card("claude-code").querySelector(".eng-r.ok").textContent.indexOf("点这张卡") < 0);

  // ★反向对照★ 绿不是一去不回头的。同一张卡再测一次、这回没登录，徽章必须当场变红，
  // 不能一边挂着绿徽章一边在下面写"连不上"
  reply = () => ({ ok: false, why: "codex 没登录（本机没有凭据）", hint: "codex login" });
  card("codex").querySelector('[data-act="test"]').click();
  await wait();
  ok("★测不通就改口：绿的收回去，换成红的★", card("codex").querySelectorAll(".eng-b.ok").length === 0
    && card("codex").querySelectorAll(".eng-b.bad").length === 1, badge("codex"));
  ok("  ← 红是真的红（量算出来的颜色，不是数类名）", (() => {
    const bad = getComputedStyle(card("codex").querySelector(".eng-b.bad")).color;
    const plain = getComputedStyle(card("codex").querySelector(".eng-b:not(.bad):not(.ok):not(.free)")).color;
    return bad !== plain && bad !== "";
  })(), [getComputedStyle(card("codex").querySelector(".eng-b.bad")).color]);
  ok("失败时说清楚下一步敲哪条命令", card("codex").querySelector(".eng-r.bad").textContent.indexOf("codex login") >= 0);
  ok("  ← 这时候版本号还在，别把「找到了」也一并否掉", badge("codex").indexOf("0.154.0") >= 0, badge("codex"));

  // ⑥ 结论得活过一次重画：保存一下设置、重新检测一下，卡片就整块重画
  await render("claude-code");
  ok("★重画之后刚测出来的结论还在★ 不然点一下保存就得再花一次 token 重测",
    !!card("claude-code").querySelector(".eng-r.ok") && card("claude-code").querySelectorAll(".eng-b.ok").length === 1);
  ok("  ← 失败那张的红结论同样留着", !!card("codex").querySelector(".eng-r.bad"));

  // ⑦ 试和用是两件事：点钮、点结论，都不许把引擎给切过去
  window.SAVES = [];
  card("codex").querySelector('[data-act="test"]').click();
  await wait();
  ok("★点「试一下」不会顺手把引擎切过去★ 试和用是两件事",
    window.SAVES.length === 0 && !card("codex").classList.contains("on"), window.SAVES);
  window.SAVES = [];
  card("codex").querySelector(".eng-r code").click();
  await wait(60);
  ok("点结论里那条命令（想复制它）也不会切引擎", window.SAVES.length === 0, window.SAVES);
  // ★反向对照★ 点卡片正文就是要切的。不做这条，上面两个 0 有可能只是因为整张卡被点死了
  window.SAVES = [];
  card("codex").querySelector(".eng-n").click();
  await wait();
  ok("反向对照：点卡片正文确实切得过去，不是把整张卡点死了",
    window.SAVES.length >= 1 && window.SAVES[0].indexOf("codex") >= 0, window.SAVES);

  return names;
})()
`;



// 键盘可达：侧栏那几行、成果卡、折叠头本来都是 <div>，鼠标能点、Tab 走不到。
// 补齐这件事的真源码是 app-00-ui.js 里的 markActivatable/onActivate + 全局 keydown，
// 整份直接拉进来跑，不抄。测的是"Enter/空格真的等价于点击"，不是"属性写上了没有"。
const KBD_HTML = "<!doctype html><meta charset='utf-8'><body>"
  + "<div id='proj-list'><div class='proj-item'>默认项目</div></div>"
  + "<div class='side-nav'><div class='item'>专家</div></div>"
  + "<div id='history'><div class='hist-item'>某个会话</div></div>"
  + "<div id='chat'><div class='out-card'>报告.pptx<button class='oa-main'>预览</button>"
  + "<a href='/d' download>下载</a></div><div class='proc-head'>运行中…</div></div>"
  + "</body>";

const KBD_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const q = (s) => document.querySelector(s);
  const press = (el, key) => { el.focus(); const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };

  // 侧栏三类行：不改渲染代码，靠 arm() 补
  for (const sel of [".proj-item", ".side-nav .item", ".hist-item"]) {
    const el = q(sel);
    ok(sel + " 能 Tab 到", el.tabIndex === 0, "tabIndex=" + el.tabIndex);
    ok(sel + " 读屏念得出是按钮", el.getAttribute("role") === "button");
  }
  let hit = 0;
  const row = q(".hist-item");
  row.onclick = () => hit++;
  press(row, "Enter");
  ok("回车等价于点击", hit === 1, "hit=" + hit);
  const ev = press(row, " ");
  ok("空格也触发", hit === 2, "hit=" + hit);
  ok("空格不再翻页", ev.defaultPrevented);
  // 反向：没打标记的元素不许被这套逻辑劫持
  const plain = document.createElement("div");
  plain.tabIndex = 0; let stray = 0; plain.onclick = () => stray++;
  document.body.appendChild(plain); press(plain, "Enter");
  ok("没打标记的不受影响", stray === 0);

  // onActivate：成果卡自带真按钮和下载链接，外层不能再声明 role="button"（按钮套按钮）
  const card = q(".out-card");
  let opened = 0;
  onActivate(card, () => opened++);
  ok("成果卡能 Tab 到", card.tabIndex === 0);
  ok("成果卡不套 role=button", card.getAttribute("role") === null, "role=" + card.getAttribute("role"));
  ok("成果卡带 data-activate", card.dataset.activate === "1");
  press(card, "Enter");
  ok("成果卡回车能打开", opened === 1, "opened=" + opened);
  // 没有交互子元素的，该给 role
  const head = q(".proc-head");
  onActivate(head, () => {});
  ok("折叠头有 role=button", head.getAttribute("role") === "button");
  ok("onActivate 传 null 不炸", onActivate(null, () => {}) === null);
  return names;
})()
`;

const FILELIST_STUBS = [
  IC_STUB,
  "window.filesCache = [];",
  "window.esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');",
  "window.toast = () => {};",
  "window.snapshotFiles = () => {};",
  "window.sessionId = 's_now';",
  "window.sessionDirs = new Map([['s_now', '任务_0903_本对话']]);",
  "window.fetch = async () => ({ ok: true, json: async () => [] });",
  // 身份：默认按平台管理员验（📂 该在）；最后一节翻成普通成员，验它真的收起来
  "window.settingsCache = { platform_owner: true };",
].join("\n");

const FILELIST_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const D = 86400e3;
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const f = (name, ms, size) => ({ name, size: size || 100, mtime: iso(ms) });
  // 「今天」那个文件夹里故意混一个 30 天前的老文件：分段要看**最近动过的那个**，
  // 取最老的会把今天刚干完的活扔进「更早」，那正是用户抱怨"找不着"的原样
  const data = [
    f("任务_0903_本对话/新产出.md", t0.getTime() + 3600e3),
    f("任务_0903_本对话/很久以前的.md", t0.getTime() - 30 * D),
    f("任务_0902_昨天干的/图.png", t0.getTime() - 5 * 3600e3),
    f("任务_0830_上周的/表.xlsx", t0.getTime() - 4 * D),
    f("任务_0805_老的/稿.docx", new Date(t0.getFullYear(), t0.getMonth() - 1, 5).getTime()),
    f("散在根目录的.txt", t0.getTime() - 60 * D),
  ];
  renderFiles(data);
  const el = document.getElementById("file-list");
  const heads = () => [...el.querySelectorAll(".time-head .name")].map((n) => n.textContent);
  const dirs = () => [...el.querySelectorAll(".dir-head .name")].map((n) => n.textContent);

  const h = heads();
  ok("时间段按新到旧排", h.length === 4 && h[0] === "今天" && h[1] === "昨天" && h[2] === "过去 7 天" && /^更早（/.test(h[3]), JSON.stringify(h));
  ok("更早的按月，同年不写年份", /^更早（\\d+月）$/.test(h[3]), h[3]);

  // 分段归属：每个文件夹恰好在它该在的那一段里
  const between = (label) => {
    const all = [...el.children];
    const i = all.findIndex((n) => n.classList.contains("time-head") && n.querySelector(".name").textContent === label);
    const out = [];
    for (let j = i + 1; j < all.length && !all[j].classList.contains("time-head"); j++) {
      // 根目录分组排在所有时间段之后、自己没有段标题，得排掉——它不属于任何时间段
      if (all[j].classList.contains("dir-head") && all[j].dataset.dir !== ".") out.push(all[j].dataset.dir);
    }
    return out;
  };
  ok("混着老文件的文件夹按最近动过的那个分段", between("今天").includes("任务_0903_本对话"), JSON.stringify(between("今天")));
  ok("30 天前的文件没把它拽进「更早」", !between(h[3]).includes("任务_0903_本对话"), JSON.stringify(between(h[3])));
  ok("昨天的进「昨天」", between("昨天").join() === "任务_0902_昨天干的", JSON.stringify(between("昨天")));
  ok("四天前的进「过去 7 天」", between("过去 7 天").join() === "任务_0830_上周的", JSON.stringify(between("过去 7 天")));
  ok("上个月的进「更早」", between(h[3]).join() === "任务_0805_老的", JSON.stringify(between(h[3])));

  const cnt = [...el.querySelectorAll(".time-head")].find((n) => n.querySelector(".name").textContent === "今天").querySelector(".cnt").textContent;
  ok("段头报文件夹数和文件数", cnt === "1 个文件夹 · 2 个文件", cnt);

  ok("本对话的文件夹带标记", /本对话/.test(dirs()[0]), dirs()[0]);
  // 根目录散件降级到最后：本对话有自己文件夹时，先撞见几个月前别的对话留下的东西才是真问题
  ok("根目录散件排在所有时间段后面", dirs()[dirs().length - 1].includes("工作空间根目录"), JSON.stringify(dirs()));
  ok("根目录散件没直接摊在最上面", !el.querySelector(".file-item"), "根目录文件没折起来");

  // 折叠：点段头只收自己那一段，别的段不许受影响
  const before = dirs().length;
  [...el.querySelectorAll(".time-head")].find((n) => n.querySelector(".name").textContent === "今天").click();
  ok("点段头收起这一段", !between("今天").length, JSON.stringify(between("今天")));
  ok("收起一段不影响别的段", between("昨天").join() === "任务_0902_昨天干的" && dirs().length === before - 1, JSON.stringify(dirs()));
  ok("收起一段不碰根目录那组", dirs()[dirs().length - 1].includes("工作空间根目录"), JSON.stringify(dirs()));
  {
    const head = [...el.querySelectorAll(".time-head")].find((n) => n.querySelector(".name").textContent === "今天");
    const href = head.querySelector(".ar use").getAttribute("href");
    ok("收起后段头箭头翻向", href === "#i-chevron-right", href);
  }
  [...el.querySelectorAll(".time-head")].find((n) => n.querySelector(".name").textContent === "今天").click();
  ok("再点一下展开回来", between("今天").join() === "任务_0903_本对话", JSON.stringify(between("今天")));

  // 用户自选工作目录：压根不建对话文件夹，文件全在根目录，那才是正文，得原样摊开
  window.sessionDirs = new Map();
  renderFiles([f("甲.txt", t0.getTime()), f("乙.txt", t0.getTime())]);
  ok("没有对话文件夹时根目录文件原样摊开", el.querySelectorAll(".file-item").length === 2 && !el.querySelector(".time-head"), el.innerHTML.slice(0, 120));

  // ── 成果重点标记。真实文件夹长这样：data/ 十几个抓回来的 json、几个 .py、一份 PROGRESS.md，
  //    外加一个 .pptx。唯一要交的那份东西
  //    跟中间材料同一个字重、混在按名字排的序里，得自己一行行找。
  window.sessionDirs = new Map([["s_now", "任务_0903_本对话"]]);
  const DIR = "任务_0903_本对话";
  const mixed = ["raw1.json", "raw2.json", "抓取.py", "运行.log", "PROGRESS.md", "方案.pptx", "配图.png"]
    .map((n, i) => f(DIR + "/" + n, t0.getTime() + i * 1000));
  onlyResults = false;
  renderFiles(mixed);
  const dh = () => el.querySelector('.dir-head[data-dir="' + DIR + '"]');
  ok("文件夹头上先报有几份成果（成果 2 · 共 7）", dh().querySelector(".cnt").textContent.replace(/\s+/g, " ") === "2 份成果 · 7", dh().querySelector(".cnt").textContent);
  dh().click(); // 展开
  const items = () => [...el.querySelectorAll(".file-item")];
  const nameOf = (it) => it.dataset.name.split("/").pop();
  ok("成果排在中间材料前面（现在是 " + items().map(nameOf).join("/") + "）",
    ["方案.pptx", "配图.png"].join() === items().slice(0, 2).map(nameOf).sort().join(),
    items().map(nameOf).join("/"));
  const byName = (n) => items().find((it) => nameOf(it) === n);
  ok("成果行打了标记，中间材料没有",
    byName("方案.pptx").classList.contains("res") && byName("配图.png").classList.contains("res") &&
    !byName("raw1.json").classList.contains("res") && !byName("抓取.py").classList.contains("res"));
  ok("PROGRESS.md 是过程账本，不算成果", !byName("PROGRESS.md").classList.contains("res"));
  // 真样式：只加类名不加样式的话，用户看到的还是一模一样的一行
  const w = (it) => getComputedStyle(it.querySelector(".name")).fontWeight;
  ok("成果的文件名真的更重（" + w(byName("方案.pptx")) + " vs " + w(byName("抓取.py")) + "）",
    Number(w(byName("方案.pptx"))) > Number(w(byName("抓取.py"))));
  ok("成果行左边有一道 2px 的色条（浏览器算出来的伪元素）",
    getComputedStyle(byName("方案.pptx"), "::before").width === "2px" &&
    getComputedStyle(byName("抓取.py"), "::before").width !== "2px");

  // ── 「只看成果」是视图开关，不是删除：藏了多少条得如实写出来
  const seg = () => [...document.querySelectorAll("#fp-filter .fp-seg")];
  ok("面板顶上摆出「全部 / 只看成果」两档", !document.getElementById("fp-filter").hidden && seg().length === 2,
    document.getElementById("fp-filter").innerHTML.slice(0, 120));
  ok("两档各带自己的条数", seg()[0].textContent === "全部 7" && seg()[1].textContent === "只看成果 2", seg().map((b) => b.textContent).join("|"));
  seg()[1].click();
  ok("切到只看成果后中间材料不出现在列表里", items().length === 2 && items().every((it) => it.classList.contains("res")), items().map(nameOf).join("/"));
  ok("底下如实写着折起了几个，不装作文件不存在", /已折起 5 个中间材料/.test(el.textContent), el.textContent.slice(-60));
  seg()[0].click();
  ok("切回全部又都在", items().length === 7 && !/已折起/.test(el.textContent));
  // 反向控制：一个成果都没有 / 全是成果时不摆这个开关——切了看不出差别，白占一行
  renderFiles(["a.py", "b.json"].map((n, i) => f(DIR + "/" + n, t0.getTime() + i)));
  ok("反向控制：一份成果都没有时不摆开关", document.getElementById("fp-filter").hidden);
  renderFiles(["a.pptx", "b.png"].map((n, i) => f(DIR + "/" + n, t0.getTime() + i)));
  ok("反向控制：全是成果时也不摆开关", document.getElementById("fp-filter").hidden);

  // ── 按名字找。
  //    分组能解决"翻"，解决不了"我就要那一个"——一个任务跑下来几十个文件，
  //    得先展开对的文件夹、再一行行扫。
  const FS = [f("任务_0918/封面三选一.html", t0.getTime()), f("任务_0918/data/points.json", t0.getTime()),
              f("任务_0917/封面_v2.png", t0.getTime()), f("README.md", t0.getTime())];
  const mnames = (s2) => matchFiles(FS, s2).map((x) => x.name);
  ok("打文件名找得到", JSON.stringify(mnames("封面三")) === JSON.stringify(["任务_0918/封面三选一.html"]), JSON.stringify(mnames("封面三")));
  ok("打文件夹名能把那个任务夹里的都捞出来", mnames("0918").length === 2, JSON.stringify(mnames("0918")));
  ok("多个词空格隔开、全都要命中", JSON.stringify(mnames("封面 png")) === JSON.stringify(["任务_0917/封面_v2.png"]), JSON.stringify(mnames("封面 png")));
  ok("大小写不敏感", mnames("readme").length === 1 && mnames("JSON").length === 1);
  ok("没搜词就是原样全给（别悄悄少几个）", matchFiles(FS, "").length === 4 && matchFiles(FS, "   ").length === 4);
  ok("搜不到就是空，不做模糊兜底（给个不相干的比给空还难受）", mnames("不存在的东西").length === 0);
  const q = () => document.getElementById("fp-q");
  const typed = (v) => { q().value = v; q().dispatchEvent(new Event("input")); };
  onlyResults = false;
  renderFiles(["a.py", "b.py"].map((n, i) => f(DIR + "/" + n, t0.getTime() + i)));
  ok("文件少的时候不摆搜索框（一眼扫得完，摆了纯占地方）", q().hidden);
  const many = ["raw1.json", "raw2.json", "抓取.py", "运行.log", "PROGRESS.md", "封面三选一.html", "封面_v2.png", "方案.pptx"]
    .map((n, i) => f(DIR + "/" + n, t0.getTime() + i * 1000));
  renderFiles(many);
  ok("文件多起来就摆出搜索框", !q().hidden && !document.getElementById("fp-filter").hidden);
  const box0 = q();
  typed("封面");
  ok("打字之后只剩名字里带这两个字的", items().map(nameOf).sort().join("/") === "封面_v2.png/封面三选一.html", items().map(nameOf).join("/"));
  ok("重画不换 input 元素（换了的话正在打的字和光标全丢）", q() === box0);
  ok("顶上如实写着找到几个、筛掉几个", /找到 2 个/.test(el.textContent) && /另外 6 个/.test(el.textContent), el.textContent.slice(0, 60));
  ok("搜索结果里带上它在哪个文件夹（同名的 index.html 一个任务能有好几份）",
    items()[0].querySelector(".meta").textContent.includes(DIR), items()[0].querySelector(".meta").textContent);
  ok("搜索结果不分组，直接摊平（搜是为了拿到那一个，不是为了翻）", !el.querySelector(".time-head") && !el.querySelector(".dir-head"));
  typed("封面 png");
  ok("空格分词、全都要命中", items().map(nameOf).join() === "封面_v2.png", items().map(nameOf).join("/"));
  typed("这个名字不存在");
  ok("搜不到时给一句人话，不是空白", /没有名字里带/.test(el.textContent) && !items().length, el.textContent.slice(0, 60));
  ok("搜空了搜索框还留着（不然没法清）", !q().hidden);
  onlyResults = true;
  renderFiles(many);
  ok("「只看成果」开着又搜不到时，提醒他切回全部（别让人以为文件没了）", /切回「全部」/.test(el.textContent), el.textContent.slice(0, 80));
  onlyResults = false;
  typed("");
  ok("清空之后又回到分组视图", !!el.querySelector(".dir-head") && !el.querySelector(".fp-hit"), el.innerHTML.slice(0, 120));

  // ── 📂「打开所在位置」和文件夹头上的 ↗「在本机打开」：开的都是**服务器那台**机器的窗口。
  //    多人部署里成员点了只会 403，窗口还弹在管理员的显示器上——干脆不画。⬇ 下载一直都在。
  window.sessionDirs = new Map([["s_now", "任务_0903_本对话"]]);
  const two = ["报告.md", "图.png"].map((n, i) => f(DIR + "/" + n, t0.getTime() + i));
  renderFiles(two);
  ok("基线：平台管理员看得到 📂", el.querySelectorAll(".rv").length > 0, el.innerHTML.slice(0, 200));
  const dirHead = el.querySelector('.dir-head[data-dir="' + DIR + '"]');
  ok("基线：文件夹头上也有「在本机打开」", !!dirHead.querySelector("[data-opendir]"), dirHead.innerHTML.slice(0, 200));
  const dlBefore = el.querySelectorAll(".dl:not(.rv)").length;
  ok("基线：⬇ 下载也在", dlBefore > 0);
  window.settingsCache = { platform_owner: false };
  renderFiles(two);
  ok("成员那边 📂 一个都不画", el.querySelectorAll(".rv").length === 0, el.innerHTML.slice(0, 200));
  ok("文件夹头上的「在本机打开」也不画",
     !el.querySelector('.dir-head[data-dir="' + DIR + '"]').querySelector("[data-opendir]"));
  ok("但 ⬇ 下载一颗都没少（那才是他真能用的那条）",
     el.querySelectorAll(".dl:not(.rv)").length === dlBefore, el.innerHTML.slice(0, 200));
  window.settingsCache = { platform_owner: true };
  return names;
})()`;

const ATTACH_HTML =
  "<!doctype html><meta charset='utf-8'><body>" +
  "<div class='input-card'><div id='attach-chips'></div><textarea id='input'></textarea></div>" +
  "<button id='attach-btn'></button><input type='file' id='file-input'></body>";

// 页面里其他文件提供的东西，在这儿给最小替身；网络请求全部截下来当证据
const ATTACH_STUBS = [
  IC_STUB,
  "window.uploads = []; window.toasts = []; window.previewed = []; window.sessionId = 's_test_1';",
  // 慢和失败都得能造出来：这一段里「没传完就点发送」「传挂了怎么救回来」两条，
  // 靠真实网络的快慢去撞是撞不出来的
  "window.uploadDelay = 0; window.uploadFail = false;",
  "window.fetch = async (url, init) => {",
  "  if (url === '/api/upload') {",
  "    const body = JSON.parse(init.body);",
  "    window.uploads.push(body);",
  "    if (window.uploadDelay) await new Promise((r) => setTimeout(r, window.uploadDelay));",
  "    if (window.uploadFail) return { ok: false, status: 500, json: async () => ({}) };",
  // 真服务端回的就是这三样；path 是文件在工作目录里的相对路径，chip 点开要靠它
  "    return { ok: true, json: async () => ({ ok: true, name: body.name, path: 'out/' + body.name }) };",
  "  }",
  "  return { ok: true, json: async () => [] };",
  "};",
  'window.toast = (m, i) => window.toasts.push((i ? "[" + i + "] " : "") + String(m));',
  "window.renderFiles = () => {};",
  "window.syncInputHl = () => {};",
  "window.syncSendBtn = () => {};",
  "window.previewFile = (name) => window.previewed.push(name);",
  "window.inputEl = document.getElementById('input');",
].join("\n");

const ATTACH_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const chips = () => [...document.getElementById("attach-chips").children];
  const B64PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const fire = (target, type, key, data) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, key, { value: data });
    target.dispatchEvent(ev);
    return ev;
  };
  // 固定 tick 数是会飘的：缩略图要过一遍 createImageBitmap，上传要过一遍 FileReader，
  // 快的机器 40ms 够、慢的机器不够，测试就变成掷骰子。一律等条件，不等时间。
  //
  // 这条规矩以前只写在这儿，前七段仍在固定睡 40ms——于是 2026-09-20 的流水线上
  // 红了一次：本机连绿三轮，GitHub 的 runner 上第 5 段拿到的 uploads.at(-1) 还是第 4 段的附件，
  // 断言把「粘贴文本_0920_070258.txt」报成了拖拽的结果。现在这一整段里没有固定等待了，
  // 别再加回来：要等什么就写什么条件。
  const until = async (fn, ms = 2000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error("等了 " + ms + "ms 还没等到");
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const settle = () => until(() => !pendingAttach.some((x) => x.state === "uploading"));
  // 等**这一次**的上传落地。下面每段都得有这个：uploads 是一路累加的，
  // 慢一拍 uploads.at(-1) 拿到的是上一段测试的附件——于是「拖进来的文件按原名上传」
  // 拿到的实际值是「粘贴文本_0920_070258.txt」，名字里还带着当时的时间戳，
  // 看上去像拖拽功能把文件改名了，其实是这一拍还没读完文件。CI 的机器比本机慢，
  // 这种断言在本地绿三轮、到流水线上红一次，最难查的就是这种。
  const nextUpload = async (n0, ms = 4000) => {
    try { await until(() => uploads.length > n0, ms); } catch (e) {}
    return uploads.length > n0 ? uploads.at(-1) : null;
  };
  const png = (name) => new File([bytes(B64PNG)], name, { type: "image/png" });
  // 一次 drop 之后该发生什么，各段测的不是同一件事：正常是多一枚 chip，重复的文件只多一次上传，
  // 文件夹则只多一句提示。所以这儿等的是「这三样里随便哪样动了」，而不是睡一拍就当它处理完了。
  const dropFiles = async (files) => {
    const n = [pendingAttach.length, uploads.length, window.toasts.length];
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    fire(document.body, "drop", "dataTransfer", dt);
    try {
      await until(() => pendingAttach.length > n[0] || uploads.length > n[1] || window.toasts.length > n[2], 4000);
    } catch (e) {}
    await settle();
  };

  // ---- 1. 粘贴截图：存进工作空间、chip 带缩略图、二进制一个字节都不能变 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([bytes(B64PNG)], "image.png", { type: "image/png" }));
    const n0 = uploads.length;
    const ev = fire(document.body, "paste", "clipboardData", dt);
    const up = await nextUpload(n0);
    ok("粘贴截图会上传", !!up, "根本没发上传请求");
    // 不带会话 id 的话服务端只能把它扔进工作空间根目录，用户传的素材和这轮的产出就此分家
    ok("上传带上了会话 id", up.session === "s_test_1", JSON.stringify(up.session));
    ok("剪贴板的通用名换成时间戳", /^粘贴图片_\\d{4}_\\d{6}\\.png$/.test(up.name), up.name);
    ok("图片二进制没被改坏", up.data_b64 === B64PNG);
    ok("chip 带缩略图", !!(await until(() => document.querySelector("#attach-chips img.attach-thumb"))));
    ok("粘贴被接管并在光标处留下图片锚点", ev.defaultPrevented && /【图片 1：粘贴图片_\\d{4}_\\d{6}\\.png】/.test(inputEl.value), inputEl.value);
  }

  // ---- 2. 同一秒连贴两张：撞名要编号，不能悄悄覆盖掉第一张 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([bytes(B64PNG)], "image.png", { type: "image/png" }));
    const n0 = uploads.length;
    fire(document.body, "paste", "clipboardData", dt);
    ok("第二张也上传了", !!(await nextUpload(n0)), "只发了一次上传请求");
    const [a, b] = uploads.slice(-2).map((u) => u.name);
    ok("连贴两张不互相覆盖", a !== b, a + " / " + b);
    ok("两张各挂一个 chip", chips().length === 2, "chip 数=" + chips().length);
  }

  // ---- 3. 短文本照常粘进输入框，别多管闲事 ----
  {
    const before = uploads.length;
    const dt = new DataTransfer();
    dt.setData("text/plain", "帮我改一下标题");
    const ev = fire(inputEl, "paste", "clipboardData", dt);
    // 反过来的断言（「不该有上传」）不能只等一拍就下结论：那只证明了「现在还没传」。
    // 留一个真实的窗口去等这个不该来的请求，等不到才算数。
    const stray = await nextUpload(before, 300);
    ok("短文本不当附件、仍准确落在输入框", ev.defaultPrevented && !stray && inputEl.value.includes("帮我改一下标题"), inputEl.value);
  }

  // ---- 4. 大段文字：落成 txt 附件，输入框不被撑爆，中文不能乱码 ----
  {
    const big = "第一行是报错：\\n" + "巨长的日志".repeat(600);
    inputEl.value = "帮我看看这个";
    const dt = new DataTransfer();
    dt.setData("text/plain", big);
    const n0 = uploads.length;
    const ev = fire(inputEl, "paste", "clipboardData", dt);
    const up = await nextUpload(n0);
    ok("大段文字落成 txt", !!up && /^粘贴文本_\\d{4}_\\d{6}\\.txt$/.test(up.name), String(up && up.name));
    const back = new TextDecoder().decode(bytes(up.data_b64));
    ok("中文原文一字不差", back === big, "长度 " + back.length + " vs " + big.length);
    ok("输入框没被撑爆、留下可引用的文本摘录锚点", inputEl.value.startsWith("帮我看看这个") && /【文本摘录 1：粘贴文本_\\d{4}_\\d{6}\\.txt】/.test(inputEl.value) && ev.defaultPrevented, inputEl.value);
    ok("chip 上能看见开头几个字", /第一行是报错/.test(chips().at(-1).title || ""));
  }

  // ---- 5. 拖文件进窗口 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode("hello")], "笔记.md", { type: "text/markdown" }));
    const n0 = uploads.length;
    fire(document.body, "drop", "dataTransfer", dt);
    const up = await nextUpload(n0);
    ok("拖进来的文件按原名上传", !!up && up.name === "笔记.md", String(up && up.name));
  }

  // ---- 6. 拖一小段选中的文字：插在光标处，别把写了一半的话顶到后面 ----
  {
    inputEl.value = "开头结尾";
    inputEl.selectionStart = inputEl.selectionEnd = 2;
    const before = uploads.length;
    const dt = new DataTransfer();
    dt.setData("text/plain", "插进来");
    fire(document.body, "drop", "dataTransfer", dt);
    const stray = await nextUpload(before, 300);
    ok("拖进来的短文字插在光标处", inputEl.value === "开头插进来结尾", inputEl.value);
    ok("短文字不当附件", !stray);
  }

  // ---- 7. 拖一大段文字：和粘贴走同一条路 ----
  {
    const dt = new DataTransfer();
    dt.setData("text/plain", "整篇文档".repeat(700));
    const n0 = uploads.length;
    fire(document.body, "drop", "dataTransfer", dt);
    const up = await nextUpload(n0);
    ok("拖进来的大段文字也落成 txt", !!up && /^粘贴文本_\\d{4}_\\d{6}(-\\d+)?\\.txt$/.test(up.name), String(up && up.name));
  }

  // ---- 8. 发送保留输入里的素材顺序，末尾清单仍兼容旧会话 / CLI ----
  {
    const imageRefs = pendingAttach.filter((x) => x.kind === "image");
    const textRef = pendingAttach.find((x) => x.kind === "text");
    // 前面几段测试会主动改输入框内容；这里明确重建一个“人物 → 文本设定 → 背景”的真实创作指令，
    // 验收 composeOutgoing 排的是当前锚点位置，而不是早先上传的时间。
    inputEl.value = imageRefs[1].marker + " 是背景。\\n" + textRef.marker + " 是剧情设定。\\n" + imageRefs[0].marker + " 是人物，请让人物出现在这个背景里。";
    const n = chips().length;
    const out = composeOutgoing();
    ok("图片和大段文字的可见锚点真的随消息发出", /【图片 1：/.test(out) && /【文本摘录 1：/.test(out), out);
    ok("附件名仍拼进兼容清单", (out.match(/已上传文件：/g) || []).length === 1 && n > 0);
    const noteAt = out.lastIndexOf("（已上传文件：");
    ok("兼容清单按输入里的锚点顺序排列", out.indexOf(imageRefs[1].name, noteAt) < out.indexOf(textRef.name, noteAt) && out.indexOf(textRef.name, noteAt) < out.indexOf(imageRefs[0].name, noteAt), out.slice(noteAt));
    ok("发完 chip 清空", chips().length === 0);
  }
  // ---- 9. 删掉一枚再加一枚：编号不许复用 ----
  // 以前是 filter(同类).length + 1。加「图片 1」「图片 2」，删掉图片 1，再加一张——
  // 长度又是 1，新的还叫「图片 2」：界面上并排两个「图片 2」，发给模型的也是两个。
  {
    inputEl.value = ""; attachChips.innerHTML = ""; pendingAttach.length = 0;
    await dropFiles([png("a.png"), png("b.png")]);
    chips()[0].querySelector(".attach-x").click();          // 删掉「图片 1：a.png」
    await dropFiles([png("c.png")]);
    const labels = chips().map((c) => c.querySelector("em").textContent);
    ok("删掉一枚再加一枚，编号不复用", new Set(labels).size === labels.length, labels.join(" / "));
    ok("锚点也没撞（模型不会看到两个「图片 2」）",
       new Set(pendingAttach.map((x) => x.marker.replace(/：.*/, ""))).size === pendingAttach.length,
       JSON.stringify(pendingAttach.map((x) => x.marker)));
  }

  // ---- 10. 松手那一瞬间就得有东西：chip 和锚点不等网络 ----
  // 以前是传完才挂 chip。4MB 就有 124ms 的空窗，30MB 走手机网更久——那段时间界面一片空白，
  // 用户以为没拖进去，再拖一次。
  {
    inputEl.value = ""; attachChips.innerHTML = ""; pendingAttach.length = 0;
    window.uploadDelay = 150;
    dropFiles([new File([new Uint8Array(1024)], "片子.mp4", { type: "video/mp4" })]);
    ok("松手当场就有 chip，不等服务器", chips().length === 1, "chip 数=" + chips().length);
    ok("松手当场锚点就在输入里", /【视频 1：片子\\.mp4】/.test(inputEl.value), inputEl.value);
    ok("传的过程里 chip 上转着圈", !!chips()[0].querySelector(".attach-state .spinner"), chips()[0].className);
    ok("没传完不许点开（点开只会 404）", chips()[0].querySelector(".attach-open").disabled);
    await until(() => pendingAttach[0] && pendingAttach[0].state === "done");
    ok("传完转圈停了、可以点开看", !chips()[0].querySelector(".attach-state .spinner") && !chips()[0].querySelector(".attach-open").disabled);
    window.uploadDelay = 0;
  }

  // ---- 11. 同一个文件又拖一次：不多一枚 chip，但得让人看见 ----
  // 以前是彻底静默：照样发一次上传请求，chip 不变、输入框不变、一个字的提示都没有。
  {
    inputEl.value = ""; attachChips.innerHTML = ""; pendingAttach.length = 0; window.toasts = [];
    await dropFiles([png("同一张.png")]);
    const n = uploads.length;
    await dropFiles([png("同一张.png")]);
    ok("重复的文件不挂第二枚 chip", chips().length === 1, "chip 数=" + chips().length);
    ok("但明说了它已经在这条消息里", window.toasts.some((t) => /已经在这条消息里/.test(t)), JSON.stringify(window.toasts));
    ok("内容照样更新成最新的那份", uploads.length === n + 1, n + " → " + uploads.length);
  }

  // ---- 12. 拖进来一个文件夹：不传、不挂 chip、说清楚该怎么办 ----
  // 以前当成一个 0 字节的文件传上去了：工作目录里多一个同名垃圾文件，chip 还告诉用户「加好了」。
  {
    inputEl.value = ""; attachChips.innerHTML = ""; pendingAttach.length = 0; window.toasts = [];
    const n = uploads.length;
    await dropFiles([new File([], "我的素材", { type: "" })]);
    ok("文件夹不当文件传上去", uploads.length === n, "多发了 " + (uploads.length - n) + " 个上传请求");
    ok("也不挂一枚骗人的 chip", chips().length === 0);
    ok("提示里点名了是哪个，还说了该怎么办",
       window.toasts.some((t) => t.includes("我的素材") && /文件夹/.test(t) && /zip|选中/.test(t)), JSON.stringify(window.toasts));
  }

  // ---- 13. 传失败：锚点必须撤掉，chip 留着能重试 ----
  // 锚点留在输入里 = 告诉模型"这个文件有"，它照着去读只会扑空。
  {
    inputEl.value = ""; attachChips.innerHTML = ""; pendingAttach.length = 0; window.toasts = [];
    window.uploadFail = true;
    await dropFiles([new File([new TextEncoder().encode("x")], "传不上去.md", { type: "text/markdown" })]);
    await until(() => pendingAttach[0] && pendingAttach[0].state === "failed");
    ok("失败的锚点从输入里撤掉了", !inputEl.value.includes("传不上去.md"), JSON.stringify(inputEl.value));
    ok("chip 留着并且变红", chips().length === 1 && chips()[0].classList.contains("is-failed"), chips()[0].className);
    ok("红 chip 上有一颗重试键", !!chips()[0].querySelector(".attach-retry"));
    ok("失败的不进发给模型的清单", attachmentOrder(inputEl.value).length === 0);
    window.uploadFail = false;
    chips()[0].querySelector(".attach-retry").click();
    await until(() => pendingAttach[0].state === "done");
    ok("重试救得回来（文件还在用户手里，别让他重新去 Finder 找）",
       !chips()[0].classList.contains("is-failed") && attachmentOrder(inputEl.value).length === 1);
  }

  // ---- 14. 还在传的时候点发送：拦住，别发一条自带死链的消息 ----
  {
    inputEl.value = ""; attachChips.innerHTML = ""; pendingAttach.length = 0; window.toasts = [];
    window.uploadDelay = 150;
    dropFiles([new File([new Uint8Array(1024)], "还在传.mp4", { type: "video/mp4" })]);
    inputEl.value = "把这个片子剪成 30 秒";
    const out = composeOutgoing();
    ok("没传完就发 → 拦住", out === "", JSON.stringify(out));
    ok("输入框一个字都没被清掉", inputEl.value === "把这个片子剪成 30 秒", JSON.stringify(inputEl.value));
    ok("而且说清了在等什么", window.toasts.some((t) => /在传/.test(t)), JSON.stringify(window.toasts));
    await until(() => pendingAttach[0] && pendingAttach[0].state === "done");
    ok("传完就能发了", composeOutgoing().includes("把这个片子剪成 30 秒"));
    window.uploadDelay = 0;
  }

  // ---- 15. chip 上能看见体积，能用键盘操作，点名字能打开 ----
  // 以前 chip 上只有一个文件名：1KB 的草稿和 25MB 的片子长得一模一样；
  // 删除键是个挂了 onclick 的 <b>，鼠标能点，Tab 过去空无一物，读屏也念不出来。
  {
    inputEl.value = ""; attachChips.innerHTML = ""; pendingAttach.length = 0; window.previewed = [];
    await dropFiles([new File([new Uint8Array(7 * 1048576)], "季度汇报.pdf", { type: "application/pdf" })]);
    const c = chips()[0];
    ok("chip 上写着多大", /7\\.0 MB/.test(c.querySelector(".attach-size").textContent), c.textContent);
    ok("两颗都是真按钮（键盘走得到、读屏念得出）",
       c.querySelectorAll("button").length === 2 && c.querySelector(".attach-x").getAttribute("aria-label").includes("季度汇报.pdf"),
       c.innerHTML.slice(0, 120));
    c.querySelector(".attach-open").click();
    ok("点名字就把这份素材打开看", window.previewed.length === 1, JSON.stringify(window.previewed));
    ok("打开的是它在工作目录里的真实路径，不是光一个文件名",
       window.previewed[0] === "out/季度汇报.pdf", JSON.stringify(window.previewed));
  }

  // ---- 16. 缩略图是缩过的，不是把整份文件塞进 img.src ----
  // 以前直接 data:...;base64,<整份文件>：实测 300KB 的图片挂上去是 409,622 个字符，
  // 浏览器还按原分辨率解一遍码再缩到 28 像素。贴几张手机照片就是几百兆内存。
  {
    inputEl.value = ""; attachChips.innerHTML = ""; pendingAttach.length = 0;
    const cv = document.createElement("canvas"); cv.width = 1600; cv.height = 1200;
    const g = cv.getContext("2d");
    for (let i = 0; i < 300; i++) { g.fillStyle = "hsl(" + ((i * 11) % 360) + ",70%,55%)"; g.fillRect((i * 37) % 1600, (i * 53) % 1200, 80, 60); }
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    await dropFiles([new File([blob], "大图.png", { type: "image/png" })]);
    const img = await until(() => document.querySelector("#attach-chips img.attach-thumb"));
    const raw = Math.ceil(blob.size / 3) * 4;  // 原来那版 img.src 就是整份文件的 base64
    ok("缩略图没把整份文件挂到 DOM 上", img.src.length < raw / 4, img.src.length + " vs 整份 " + raw);
    const px = await new Promise((r) => { const im = new Image(); im.onload = () => r(im.width); im.src = img.src; });
    ok("解码的也是小图，不是 1600 宽的原图", px <= 96, "缩略图宽 " + px);
  }

  return names;
})()`;


// 👍👎 那一段也验真源码。这是自进化整条链的第一环：这两个按钮以前点了只换个高亮色，
// 一个字节都没往外送，链子从源头就是断的。断了不会报错、界面看着还挺正常——
// 所以必须钉在"真的发出了什么 payload"上，不能只看类名有没有变。
const F0 = APP02X.indexOf("  // 官方式回复操作条");
const F1 = APP02X.indexOf("  // Plan 模式：把执行计划解析成任务列表卡片");
if (F0 < 0 || F1 <= F0) throw new Error("app-01.js 里的回复操作条段找不到了（段标题被改过？），前端测试没法定位真源码");
const FB_SRC = APP02X.slice(F0, F1);

const FB_HTML = "<!doctype html><meta charset='utf-8'><body><div id='chat-col'></div></body>";

const FB_STUBS = [
  IC_STUB,
  "window.posts = [];",
  "window.fetch = async (url, init) => {",
  "  window.posts.push({ url, body: JSON.parse(init.body) });",
  "  return { ok: true, json: async () => ({ ok: true }) };",
  "};",
  "const chatCol = document.getElementById('chat-col');",
  "const toast = () => {};",
  "const curBusy = () => false;",
  "const doSend = () => {};",
].join("\n");

// 真源码里 turn/body/turnSid 是 createTurnUI 里每个回合各自的局部变量，测试得把这层作用域还原出来。
// 图省事全放成脚本级变量的话，后建的回合会把先建的那个的闭包顶掉——测出来的下标永远是最后一个，
// 而那正是这段测试要防的毛病（点第二条的 👎 却记到第一条头上）。
const FB_WRAP = (src) => "window.makeBar = (turn, body, turnSid) => {\n" + src + "\naddActionsBar();\n};";

const FB_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const mk = (sid, userText, replyText) => {
    const t = document.createElement("div");
    t.className = "turn";
    t.innerHTML = '<div class="body"><div class="a-text">' + replyText + '</div></div>';
    t._userText = userText;
    chatCol.appendChild(t);
    window.makeBar(t, t.querySelector(".body"), sid);
    return t;
  };
  const btn = (t, a) => t.querySelector('[data-a=' + a + ']');
  const last = () => window.posts[window.posts.length - 1];

  const t1 = mk("s_aaa", "帮我写个周报", "这是回复正文");
  const t2 = mk("s_aaa", "再改一版", "第二版回复");

  ok("操作条挂上了", btn(t2, "up") && btn(t2, "down"), "没渲染出 👍👎");
  ok("没人点的时候一个字节都不发", window.posts.length === 0);

  btn(t1, "up").click(); await tick();
  ok("👍 真的发出去了", window.posts.length === 1 && last().url === "/api/feedback");
  ok("👍 带的是 up", last().body.verdict === "up");
  ok("👍 带上了归属会话", last().body.session === "s_aaa");
  ok("👍 带上了第几轮", last().body.turn === 0, "turn=" + last().body.turn);
  ok("👍 带上了你当时说的那句", last().body.task === "帮我写个周报");
  ok("👍 带上了回复正文", last().body.reply.indexOf("这是回复正文") >= 0);
  ok("👍 亮起来了", btn(t1, "up").classList.contains("on"));

  btn(t1, "up").click(); await tick();
  ok("再点一下是取消，不重复上报", window.posts.length === 1 && !btn(t1, "up").classList.contains("on"));

  // 第二个回合点：turn 下标必须跟着它在列表里的真实位置走，不能永远是 0
  btn(t2, "down").click(); await tick();
  ok("👎 点下去当场就记，不等你写理由", window.posts.length === 2 && last().body.verdict === "down");
  ok("👎 的 turn 下标跟着真实位置走", last().body.turn === 1, "turn=" + last().body.turn);
  ok("👎 之后弹出选填的理由框", !!t2.querySelector(".fb-note input"));
  ok("理由框是选填的，不写也已经记下了", last().body.note === "");

  const box = t2.querySelector(".fb-note");
  box.querySelector("input").value = "结论藏在最后一段";
  box.querySelector("button").click(); await tick();
  ok("补的理由发出去了", window.posts.length === 3 && last().body.note === "结论藏在最后一段");
  ok("补完给个回执", t2.querySelector(".fb-thanks"));

  const t3 = mk("s_bbb", "第三个", "第三版回复");
  btn(t3, "down").click(); await tick();
  const n3 = window.posts.length;
  const inp = t3.querySelector(".fb-note input");
  inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  ok("Esc 关掉理由框，不多发一条", !t3.querySelector(".fb-note") && window.posts.length === n3);

  btn(t3, "down").click(); await tick();
  btn(t3, "up").click(); await tick();
  ok("改判成 👍 时 👎 的高亮撤掉", btn(t3, "up").classList.contains("on") && !btn(t3, "down").classList.contains("on"));
  ok("改判后理由框跟着收起", !t3.querySelector(".fb-note"));
  ok("改判也是一次真上报", last().body.verdict === "up" && last().body.session === "s_bbb");

  // 空理由不该白发一次：点「记下」时输入框是空的，就只留下点击那一条
  const t4 = mk("s_ccc", "第四个", "第四版回复");
  btn(t4, "down").click(); await tick();
  const n4 = window.posts.length;
  t4.querySelector(".fb-note button").click(); await tick();
  ok("理由留空不重复上报", window.posts.length === n4);

  // ---- 这一轮是谁跑的、跑了几步也要一起走：评测页按模型/模式切着看好评率全靠这几个字段 ----
  const t5 = document.createElement("div");
  t5.className = "turn";
  t5.innerHTML = '<div class="body"><div class="proc-wrap"><div class="proc-body">'
    + '<div class="step-card"><div class="head"><span class="tag">read_file</span><span class="tag ok">完成</span></div></div>'
    + '<div class="step-card failed"><div class="head"><span class="tag">run_shell</span><span class="tag err">失败</span></div></div>'
    + '<div class="step-card"><div class="head"><span class="tag">write_file</span><span class="tag ok">完成</span></div></div>'
    + '</div></div><div class="a-text">带模型的回复</div></div>';
  t5._userText = "第五个"; t5._mode = "craft";
  t5._usage = { model: "m1", provider: "P", prompt: 100, completion: 20, cached: 30, calls: 3, elapsed_ms: 1234 };
  chatCol.appendChild(t5);
  window.makeBar(t5, t5.querySelector(".body"), "s_ddd");
  btn(t5, "down").click(); await tick();
  const p5 = last().body;
  ok("👎 带上模型和供应商", p5.model === "m1" && p5.provider === "P", JSON.stringify(p5));
  ok("👎 带上模式", p5.mode === "craft", JSON.stringify(p5));
  ok("👎 带上耗时/tokens/调用数", p5.elapsed_ms === 1234 && p5.tokens === 120 && p5.calls === 3, JSON.stringify(p5));
  ok("👎 带上步数和出错步数", p5.steps === 3 && p5.errors === 1, JSON.stringify(p5));
  ok("操作条写了命中率", /缓存命中 30%/.test(t5.querySelector(".ta-meta").textContent), t5.querySelector(".ta-meta").textContent);
  // 负对照：没跑工具、没用量的回合，这些字段是 0/空串，不是 undefined
  const t6 = mk("s_ddd", "第六个", "光聊天");
  btn(t6, "up").click(); await tick();
  const p6 = last().body;
  ok("没用量的回合字段也齐全", p6.model === "" && p6.provider === "" && p6.mode === "" && p6.tokens === 0 && p6.steps === 0 && p6.errors === 0 && p6.calls === 0 && p6.elapsed_ms === 0, JSON.stringify(p6));
  // 老口径的账（cached > prompt）命中率封顶 100%，不再印 3209%
  const t7 = document.createElement("div"); t7.className = "turn"; t7.innerHTML = '<div class="body"><div class="a-text">x</div></div>';
  t7._userText = "第七个"; t7._usage = { model: "claude-code", provider: "claude-code", prompt: 934, completion: 10, cached: 30000, calls: 1, elapsed_ms: 1 };
  chatCol.appendChild(t7); window.makeBar(t7, t7.querySelector(".body"), "s_ddd");
  const m7 = t7.querySelector(".ta-meta");
  ok("老口径的账命中率封顶 100%", /缓存命中 100%/.test(m7.textContent) && !/\d{3,}%/.test(m7.textContent.replace("100%", "")) && /（100%）/.test(m7.title), m7.textContent + " | " + m7.title);

  // ---- 回放：之前点过的 👍👎 要亮回来，且不重新上报；回放完了新回合不许误亮 ----
  const nBefore = window.posts.length;
  const idx = chatCol.querySelectorAll(".turn").length;
  window.replayFeedback = new Map([[idx, { verdict: "down", note: "太长" }], [idx + 1, { verdict: "up" }], [idx + 2, { verdict: "meh" }]]);
  const r1 = mk("s_eee", "回放一", "回放正文一");
  ok("回放时 👎 亮回来", btn(r1, "down").classList.contains("on") && !btn(r1, "up").classList.contains("on"));
  ok("回放时理由挂在悬停提示上", /太长/.test(btn(r1, "down").title), btn(r1, "down").title);
  const r2 = mk("s_eee", "回放二", "回放正文二");
  ok("回放时 👍 亮回来", btn(r2, "up").classList.contains("on") && !btn(r2, "down").classList.contains("on"));
  const r3 = mk("s_eee", "回放三", "回放正文三");
  ok("坏 verdict 不亮", !btn(r3, "up").classList.contains("on") && !btn(r3, "down").classList.contains("on"));
  ok("亮回来不算新上报", window.posts.length === nBefore, window.posts.length + " vs " + nBefore);
  window.replayFeedback = null;
  const r4 = mk("s_eee", "回放四", "回放正文四");
  ok("回放结束后新回合不误亮", !btn(r4, "up").classList.contains("on") && !btn(r4, "down").classList.contains("on"));
  btn(r1, "down").click(); await tick();
  ok("亮回来的 👎 再点一下是取消", !btn(r1, "down").classList.contains("on") && window.posts.length === nBefore);

  return names;
})()`;

// 轨迹条：过程区收起时也要看得见这一轮走了哪几步、哪步出了事。拿 createTurnUI 整段真源码
// 喂事件流，连 index.html 和 ui.css 的真样式一起注进来——「标红」「收起了还看得见」「删除线」
// 这些都得是算出来的样式，不是类名。
const TR0 = APP02X.indexOf("function createTurnUI(");
const TR1 = APP02X.indexOf("// ================= 空状态");
if (TR0 < 0 || TR1 <= TR0) throw new Error("app-01.js 里的 createTurnUI 段找不到了（段标题被改过？），前端测试没法定位真源码");
const pickLine = (re, why) => { const m = APP02X.match(re); if (!m) throw new Error(why); return m[0]; };
const LK0 = APP02X.indexOf("// ---- 正文里提到的产出文件名 → 可点开的链接 ----");
const LK1 = APP02X.indexOf("// 产出到了该怎么办");
if (LK0 < 0 || LK1 <= LK0) throw new Error("app-01.js 里 linkifyOutputs / finishPreviewPlan 那段找不到了，前端测试没法定位真源码");
const TR_LINKIFY = APP02X.slice(LK0, LK1);
const TRAIL_SRC = [
  pickLine(/^const TOOL_SHORT = \{.*$/m, "app-01.js 里没有 TOOL_SHORT（轨迹条的短标签表）"),
  pickLine(/^const TOOL_ICON = \{.*$/m, "app-01.js 里没有 TOOL_ICON（每个工具配哪个图标）"),
  pickLine(/^const shortTool = .*$/m, "app-01.js 里没有 shortTool"),
  pickLine(/^const toolIcon = .*$/m, "app-01.js 里没有 toolIcon（过程区每一步的图标）"),
  // 过程区那些「说一句」的提示行（并发了几个、压缩了几条、自动续跑…）都由它画
  APP02X.slice(APP02X.indexOf("function procNote(icon, text, cls)"), APP02X.indexOf("const runningSessions = new Map()")),
  "let replayFeedback = null;",
  // 流式正文的分段渲染是真源码（不是桩）：回合里那些 endText() 收尾点必须真的把两截合回去
  APP02X.slice(APP02X.indexOf("const BAL_TAG"), APP02X.indexOf("\n// 【任务类型：X】")),
  APP02X.slice(TR0, TR1),
  // 提问卡（岔路/审批）在 createTurnUI 那段外面，但回放时是 handleEvent 调它画的，
  // 不注真源就验不到「答过的岔路该显示成答过了」
  APP02X.slice(APP02X.indexOf("function makeAskCard(ev, turnSid, submit, ctx)"), APP02X.indexOf("function fileIcon(name)")),
  // 收尾那两件事（正文文件名变可点链接、把成品摊开）的真源码也一起注进来。
  // ARRIVAL 那块验的是这几个纯函数本身；这里验的是另一条线：事件流真跑一遍，finish() 有没有接上它们
  TR_LINKIFY,
].join("\n");
const UI_CSS = fs.readFileSync(path.join(__dirname, "..", "public", "css", "ui.css"), "utf8");
const TRAIL_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style>"
  + "<body><div id='chat-col'></div><div id='preview-panel'></div><div id='files-panel'></div></body>";
const TRAIL_STUBS = [
  "var sessionId = 's_t';",
  "var chatCol = document.getElementById('chat-col');",
  "var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "var renderMd = (t) => '<p>' + esc(t) + '</p>';",
  "var scrollBottom = () => {};",
  "var onActivate = (el, fn) => { el.onclick = fn; return el; };",
  "var wireProcWarn = (chip) => chip;",
  IC_STUB,
  "var avatarBits = () => ({ html: 'A', cls: '' });",
  "var assistant = { avatar: '', name: 'A' };",
  "var hlTokens = (t) => esc(t);",
  "var stripSceneTag = (t) => t;",
  "var toast = () => {};",
  "var cssEsc = (s) => s;",
  "var curBusy = () => false; var doSend = () => {}; var setMode = () => {}; var syncInputHl = () => {};",
  "var inputEl = document.createElement('textarea');",
  "var isReplaying = false;",
  "var MODALS = []; var openModal = (a, b) => MODALS.push(a + ':' + (b || ''));",
  // 过程区底下那条「看执行记录」指的是整页的 更多 → 执行追踪（平台管理员才画）
  "var VIEWS = []; var openPageView = (v) => VIEWS.push(v); var amPlatformOwner = () => true;",
  // 收尾那两件事要用的外部符号。这两条正则跟 app-01.js 里的真源一字不差（e2e 的 testOutputArrivalStatic 会比对字面量）
  "var OFFICE_RE = /\\.(doc|ppt|xls)$/i;",
  "var SCAFFOLD_RE = /^(PROGRESS|TODO|NOTES?|README)\\.(md|txt)$/i;",
  "var pvPanel = document.getElementById('preview-panel');",
  "var pvCurrent = null; var pvClosedAt = 0;",
  "window.PV = []; var previewFile = (n) => { window.PV.push(n); pvPanel.classList.add('show'); pvCurrent = n; };",
  "window.fetch = async () => ({ ok: true, json: async () => ({}) });",
].join("\n");

// ================= 本机引擎在跑时的模型选择器 =================
// 真毛病是那段说明塞在 .mi 里，
// 而 .mi 是 nowrap 的 —— 菜单被撑成一整行宽，右对齐于是往左飞出屏幕，字被裁掉一半。
// 所以这里验的是「宽度收得住、说明会换行、不出可视区」，不是验措辞。
const ENGPICK_SRC = APP02.slice(0, APP02.indexOf("// ================= Goal 目标卡"))
  + "\n" + APP02X.slice(APP02X.indexOf("function activeEngine()"), APP02X.indexOf("async function setSessionModel("));
const ENGPICK_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style>"
  + "<body style='margin:0;width:520px'><svg style='display:none'><symbol id='i-sparkles'></symbol><symbol id='i-monitor'></symbol></svg>"
  + "<div class='picker' style='position:absolute;right:16px;bottom:120px'>"
  + "<button class='picker-btn' id='model-btn'><svg class='i'><use href='#i-sparkles'></use></svg> <span id='model-label'>模型</span></button>"
  + "<div class='picker-menu' id='model-menu'></div></div></body>";
const ENGPICK_STUBS = [
  IC_STUB,
  "var modelMenu = document.getElementById('model-menu');",
  "var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "var MODALS = []; var openModal = (a, b) => MODALS.push(a + ':' + b);",
  "var inAssistMode = false;",
  "var currentSessModel = () => null;",
  "var healthBadge = () => '';",
  "var setSessionModel = async () => {};",
  "var settingsCache = { active_model: 'deepseek', models: [{ name: 'deepseek', model: 'deepseek-chat', api_key: 'x' }], agent: { engine: 'claude-code', engine_label: '本机 Claude Code', engine_options: { 'claude-code': { model: 'claude-opus-5' } } } };",
].join("\n");
const ENGPICK_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const menu = document.getElementById("model-menu");
  const vw = document.documentElement.clientWidth;

  renderModelMenu();
  menu.classList.add("show");
  const box = menu.getBoundingClientRect();
  ok("本机引擎在跑：菜单换成说明卡，不再假装一排可选项", menu.classList.contains("eng") && !!menu.querySelector(".ep-head"));
  ok("菜单没被那段说明撑爆（≤340px）", box.width <= 340, Math.round(box.width) + "px");
  ok("整块都在屏幕里，左边没被裁掉", box.left >= 0 && box.right <= vw + 1, JSON.stringify({ l: Math.round(box.left), r: Math.round(box.right), vw }));
  ok("引擎名和它的模型都写清楚了", /本机 Claude Code/.test(menu.querySelector(".ep-name").textContent) && /claude-opus-5/.test(menu.querySelector(".ep-model").textContent));
  ok("「不花 API 额度」是这里最该看见的一句", /不花 API 额度/.test(menu.querySelector(".ep-free").textContent));

  // 绿牌子「不花 API 额度」已经把这件事说完了，底下原来那段「用你电脑上这个 CLI 的登录态和
  // 它自己的模型跑，所以下面那排 API 模型这会儿一个都用不上」是把同一件事用长句再写一遍。
  // 这条钉住它，别哪天又被加回来
  ok("卡里没有那段把绿牌子重说一遍的长句",
     !menu.querySelector(".ep-why") && !/登录态|用不上/.test(menu.textContent),
     menu.textContent.replace(/\s+/g, " ").trim().slice(0, 80));
  // ★反向对照★ 把那段原样塞回去，卡当场高一截。不做这条的话，上面那句完全可能是在
  // 测一个本来就不存在的东西（比如整张卡压根没渲染出来），删没删干净根本量不到
  const gone = document.createElement("div");
  gone.className = "ep-why";
  gone.style.cssText = "padding:8px 10px 4px;font-size:12px;line-height:1.6;white-space:normal";
  gone.textContent = "不花 API 额度用你电脑上这个 CLI 的登录态和它自己的模型跑，所以下面那排 API 模型这会儿一个都用不上。";
  menu.insertBefore(gone, menu.querySelector(".ep-act"));
  const tall = menu.getBoundingClientRect().height;
  gone.remove();
  const lean = menu.getBoundingClientRect().height;
  ok("反向对照：那段塞回来卡就高一截，删掉是真的瘦了身", tall - lean > 40,
     JSON.stringify({ 塞回来: Math.round(tall), 现在: Math.round(lean) }));
  const acts = [...menu.querySelectorAll(".mi")];
  ok("能点的只有「去改它」那一行（说明不再长得像按钮）", acts.length === 1 && /换回内置引擎/.test(acts[0].textContent), acts.map((a) => a.textContent.trim().slice(0, 12)).join("|"));
  acts[0].click();
  ok("点它直接去设置里的引擎那页", MODALS.join() === "settings:agent" && !menu.classList.contains("show"));

  // 负向控制：老写法（说明塞进 .mi，nowrap）确实会把菜单撑爆——证明上面那条不是白测
  const probe = document.createElement("div");
  probe.className = "picker-menu show";
  probe.innerHTML = '<div class="mi">任务交给本机这个 CLI 跑，用的是它的登录态和它的模型，不花 API 额度。下面这些 API 模型这会儿一个都用不上，所以先不列了。</div>';
  document.body.appendChild(probe);
  const pw = probe.querySelector(".mi").scrollWidth;
  probe.remove();
  ok("负向控制：那段说明单行摆开确实有 500px 以上，宽度上限是真在挡", pw > 500, pw + "px");

  // 换回内置引擎：菜单要变回一排真能选的模型，说明卡的壳必须脱掉
  settingsCache.agent.engine = "builtin";
  renderModelMenu();
  ok("换回内置引擎：说明卡的壳脱掉了", !menu.classList.contains("eng") && !menu.querySelector(".ep-head"));
  ok("模型又变回一排能点的了", menu.querySelectorAll(".mi").length >= 3, String(menu.querySelectorAll(".mi").length));

  // ---- 没填 Key 的不进这张菜单 ----
  // 出厂 config 预置着十来条厂商模板一把 Key 都没有，
  // 混在这儿点下去必然 401——那不是可选项，是待办事项
  const MODELS0 = settingsCache.models;
  settingsCache.models = [
    { name: "deepseek", model: "deepseek-chat", api_key: "x", has_key: true },
    { name: "本机 Ollama", model: "qwen3", api_key: "", has_key: false, base_url: "http://localhost:11434/v1" },
    { name: "火山方舟", model: "doubao", api_key: "", has_key: false, base_url: "https://ark.cn-beijing.volces.com/api/v3" },
    { name: "OpenRouter", model: "gpt-5", api_key: "", has_key: false, base_url: "https://openrouter.ai/api/v1" },
  ];
  renderModelMenu();
  const rows = [...menu.querySelectorAll(".mi[data-name]")].map((r) => r.dataset.name);
  ok("填了 Key 的和本机服务留下，没填 Key 的两条不列出来", rows.join("|") === "deepseek|本机 Ollama", rows.join("|"));
  ok("本机服务不要 Key 也算能用（别把 Ollama 一起误伤了）", rows.includes("本机 Ollama"));
  ok("再没有「⚠未填Key」这种行——它本来就不该是一条可选项", !/未填Key/.test(menu.innerHTML));
  const note = menu.querySelector(".mi-note");
  ok("末尾留一行交代那 2 条去哪了，且它不是可点的 .mi", note && /还有 2 个模型没填 Key/.test(note.textContent) && !note.classList.contains("mi"), note && note.textContent);
  ok("说明那行会换行、不跟着 hover 变色（真样式）", getComputedStyle(note).whiteSpace === "normal", getComputedStyle(note).whiteSpace);
  // 负向控制：把两条的 has_key 翻成 true，它们必须立刻回到列表里，说明过滤的是 Key 不是别的
  settingsCache.models = settingsCache.models.map((m) => ({ ...m, has_key: true, api_key: "x" }));
  renderModelMenu();
  ok("反向对照：只把 Key 补上，四条全部回到菜单里，尾巴那行说明也消失",
     [...menu.querySelectorAll(".mi[data-name]")].length === 4 && !menu.querySelector(".mi-note"));
  // 一把 Key 都没有：不能给一张只剩「跟随全局默认」的空菜单，得说人话
  settingsCache.models = [{ name: "火山方舟", model: "doubao", api_key: "", has_key: false, base_url: "https://ark.cn-beijing.volces.com/api/v3" }];
  renderModelMenu();
  ok("一条能用的都没有：不给空菜单，直接说去下面加一个",
     !menu.querySelector(".mi[data-name]") && /一个填了 Key 的模型都还没有/.test(menu.querySelector(".mi-note").textContent)
     && !!menu.querySelector('.mi[data-act="manage"]'));
  settingsCache.models = MODELS0;
  renderModelMenu();

  // 选择器按钮：本机引擎在跑时得一眼看出来「这次不花钱」，光看模型名跟 API 模型长得一样
  const btn = document.getElementById("model-btn");
  updateModelLabel();
  ok("内置引擎：按钮还是那颗星", btn.querySelector("use").getAttribute("href") === "#i-sparkles");
  settingsCache.agent.engine = "claude-code";
  updateModelLabel();
  ok("本机引擎：按钮换成显示器图标，一眼看出走的是本机", btn.querySelector("use").getAttribute("href") === "#i-monitor");
  ok("悬停说清谁在跑、花不花钱", /本机 Claude Code/.test(btn.title) && /不花 API 额度/.test(btn.title), btn.title);
  ok("标签写的是它真正在用的模型", document.getElementById("model-label").textContent === "claude-opus-5", document.getElementById("model-label").textContent);
  return names;
})()
`;

// ================= Goal 目标卡 =================
// 这里验的是这张卡有没有把三件事说清楚：
// 还差几项（进度条）、拆解/验收自己歪了要留痕（不能静默）、停了要说为什么停并且能接着冲。
const GOAL_SRC = APP02.slice(APP02.indexOf("// ================= Goal 目标卡"), APP02.indexOf("// ================= 工作空间选择"));
const GOAL_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style>"
  + "<body style='margin:0;width:760px'><div id='goal-card' style='display:none'></div></body>";
const GOAL_STUBS = [
  IC_STUB,
  "var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "var sessionId = 's1';",
  "var sessionGoals = new Map();",
  "var SENT = []; var doSend = (t, m) => SENT.push([t, m]);",
  "var fetch = async () => ({ json: async () => ({}) });",
].join("\n");
const GOAL_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const card = document.getElementById("goal-card");
  const G = (over) => Object.assign({ text: "做一个贪吃蛇网页", status: "active", round: 1,
    criteria: [{ text: "有画布", done: true }, { text: "方向键能控制", done: false }, { text: "撞墙会结束", done: false }, { text: "有计分", done: false }] }, over || {});

  sessionGoals.set("s1", G());
  renderGoalCard();
  ok("目标卡出来了", card.style.display !== "none" && /贪吃蛇/.test(card.textContent));
  ok("先说还差几项，再说第几轮", /1\\/4 项/.test(card.querySelector(".gc-meta").textContent) && /第 1 轮/.test(card.querySelector(".gc-meta").textContent), card.querySelector(".gc-meta").textContent);
  const bar = card.querySelector(".gc-bar i");
  const w = bar.getBoundingClientRect().width / card.querySelector(".gc-bar").getBoundingClientRect().width;
  ok("进度条按打勾的比例走（4 条里 1 条 ≈ 25%）", Math.abs(w - 0.25) < 0.03, Math.round(w * 100) + "%");
  ok("没达成的一条条都列着", card.querySelectorAll(".gc-item").length === 4 && card.querySelectorAll(".gc-item.ok").length === 1);
  ok("负向控制：一切正常时不摆警告条也不摆暂停条", !card.querySelector(".gc-note") && !card.querySelector(".gc-paused"));

  // 拆解/验收这一步自己歪了：必须写在卡上，不许静默（不然用户对着不动的进度条以为是活没干好）
  sessionGoals.set("s1", G({ note: "验收没跑通：模型超时，这一轮的打勾保持原状" }));
  renderGoalCard();
  ok("验收这一步挂了会写在卡上", /验收没跑通/.test(card.querySelector(".gc-note").textContent));
  ok("警告条是黄的，跟正文分得开", getComputedStyle(card.querySelector(".gc-note")).backgroundColor !== "rgba(0, 0, 0, 0)");

  // 自动补跑用完：以前到这儿就悄悄不跑了，卡停在 1/4 看不出是「还在跑」还是「不跑了」
  sessionGoals.set("s1", G({ round: 3, paused: "自动补跑已用满 3 轮，还差 3 项没达成" }));
  renderGoalCard();
  const pz = card.querySelector(".gc-paused");
  ok("停了要说清为什么停、还差几项", !!pz && /用满 3 轮/.test(pz.textContent) && /还差 3 项/.test(pz.textContent));
  ok("旁边有一颗能接着跑的按钮", !!card.querySelector(".gc-go"));
  card.querySelector(".gc-go").click();
  ok("点它是接着冲，而且只补没打勾的那几项", SENT.length === 1 && SENT[0][1] === "goal" && /方向键能控制/.test(SENT[0][0]) && !/有画布/.test(SENT[0][0]), JSON.stringify(SENT[0] || null));
  ok("点完立刻不再显示「已暂停」（别让用户以为没点上）", !card.querySelector(".gc-paused"));

  // 达成：进度条满格 + 变绿，且不再劝人接着冲
  sessionGoals.set("s1", G({ status: "done", round: 2, criteria: [{ text: "有画布", done: true }, { text: "方向键能控制", done: true }], paused: "自动补跑已用满 3 轮" }));
  renderGoalCard();
  ok("达成了就说达成", /已达成/.test(card.querySelector(".gc-meta").textContent) && card.classList.contains("ok"));
  const w2 = card.querySelector(".gc-bar i").getBoundingClientRect().width / card.querySelector(".gc-bar").getBoundingClientRect().width;
  ok("进度条满格", w2 > 0.98, Math.round(w2 * 100) + "%");
  ok("达成之后不再劝人接着冲（哪怕服务端还留着上一轮的暂停原因）", !card.querySelector(".gc-paused"));

  // 归档：卡收起来
  sessionGoals.set("s1", G({ status: "closed" }));
  renderGoalCard();
  ok("归档的目标不再占地方", card.style.display === "none" && card.innerHTML === "");
  return names;
})()
`;

// ================= 上下文余量条：换会话要收回去 =================
// 这根条画在输入框上头，全界面共用一根，
// 只在后端播 context 事件的时候才重画——切到一条还没开跑的对话，上一条那句
// 「上下文 87%…下一轮开跑前会自动压一次」就原样挂着，指着一个跟眼前这条对话毫不相干的数。
// 这一屏验的是行为不是措辞：过阈值才露面、到线要变黄、收回去之后**真的看不见**
// （量 computed display，只验 class 的话把 .ctx-bar.show 那条 CSS 删了测试照样全绿）、
// 收完还能被下一条 context 事件重新填满。结构和样式都从 index.html 现切，不另抄一份。
const CTX0 = APP02X.indexOf("/**\n * 上下文余量条。");
const CTX1 = APP02X.indexOf("\nfunction procNote(");
if (CTX0 < 0 || CTX1 <= CTX0) throw new Error("app-01.js 里的上下文余量条那段找不到了（函数改名/挪窝了？），前端测试没法定位真源码");
const CTX_SRC = APP02X.slice(CTX0, CTX1);
if (!/function resetCtxMeter\(/.test(CTX_SRC)) throw new Error("切出来的那段里没有 resetCtxMeter——换会话收条子的那半边没被测到");
const CTX_BAR_HTML = (() => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const a = html.indexOf('<div class="ctx-bar" id="ctx-bar">');
  if (a < 0) throw new Error("public/index.html 里找不到 #ctx-bar，前端测试没法验真结构");
  return html.slice(a, html.indexOf("\n", a)).trim();
})();
// 条子宽度是量出来的，不是读 style 读来的（读 style 等于只验「这行赋值跑过」，
// CSS 里那条 width 被谁覆盖了照样全绿）。但它带着 transition，量的那一刻还在从上一个
// 宽度滑过去——第一次跑就撞上了：刚设成 87%，量出来 50%。所以测试页里把过渡整个关掉，
// 量的是终态。动效本身有 testMotionGate 单独守着，不靠这一屏。
const CTX_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS
  + "\n* { transition: none !important; animation: none !important; }</style>"
  + "<body style='margin:0;width:760px'>" + CTX_BAR_HTML + "</body>";
const CTX_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const bar = document.getElementById("ctx-bar");
  const txt = () => document.getElementById("ctx-text").textContent;
  const shown = () => getComputedStyle(bar).display !== "none";
  const fillW = () => document.getElementById("ctx-fill").getBoundingClientRect().width
    / bar.querySelector(".ctx-track").getBoundingClientRect().width;
  const B = 120000, TH = 72000; // 预算 12 万字符、六成自动压缩：默认配置
  const ev = (used) => ({ used, budget: B, threshold: TH, pct: Math.round((used / B) * 100) });

  ok("一上来是空的（没跑过任务就不该有这根条）", !shown() && txt() === "");

  renderCtxMeter(ev(36000));
  ok("日常对话（三成）不露面：天天挂一根条看久了等于没有", !shown(), txt());

  renderCtxMeter(ev(60000));
  ok("过半才露面", shown());
  ok("露面时把真数字写出来，不只是一根条", /50%/.test(txt()) && /60k \\/ 120k/.test(txt()), txt());
  ok("还没到自动压缩那条线，不报警也不多嘴", !bar.classList.contains("warn") && !/自动压/.test(txt()), txt());

  renderCtxMeter(ev(104000)); // 用户截图里那一档
  ok("到线了变黄", bar.classList.contains("warn"));
  ok("到线了说清下一步（下一轮会压、想留全文另开会话）", /87%/.test(txt()) && /自动压一次/.test(txt()) && /另开会话/.test(txt()), txt());
  ok("条子按百分比走", Math.abs(fillW() - 0.87) < 0.03, Math.round(fillW() * 100) + "%");

  // 正题：换会话。没有任何 context 事件可等（新对话本来就没有），得靠这一下收干净
  resetCtxMeter();
  ok("换会话就收回去：真的看不见了，不是只掉了个 class", !shown() && !bar.classList.contains("show"));
  ok("字也擦干净（下次露面前不许留着上一条对话的数）", txt() === "");
  ok("黄也退掉", !bar.classList.contains("warn"));
  // 收着的时候量不了（display:none 的元素没有宽度），可「下次一露面会不会先闪一下上一条的长度」
  // 恰恰是要量的：临时按亮量一眼再按回去。读 style.width 代替不了——CSS 里那条 width 被别的
  // 规则盖掉的话，读出来照样是 "0%"，屏幕上却是满的
  bar.classList.add("show");
  const w0 = fillW();
  bar.classList.remove("show");
  ok("条子退回零：下次一露面别先闪一下上一条的长度", w0 < 0.01, Math.round(w0 * 100) + "%");

  // 反向对照：收了不等于废了——新对话自己跑起来照样填得回来
  renderCtxMeter(ev(104000));
  ok("反向对照：收完之后下一条 context 事件照样填得回来", shown() && /87%/.test(txt()) && bar.classList.contains("warn"), txt());

  // 自动压缩被用户关掉：话得换一句，不然承诺了一个不会发生的动作
  renderCtxMeter(Object.assign(ev(104000), { compact: false }));
  ok("关了自动压缩就不许再说「会自动压一次」，改说会被截断", /自动压缩关着/.test(txt()) && !/自动压一次/.test(txt()), txt());
  return names;
})()
`;

// ================= 助理设置页：分区 + 双栏卡片 + 连接/取消连接 =================
// 这里验的是行为不是措辞：连上的卡真收起（display:none）、
// 状态灯颜色真变、「连接」先保存再测活、「取消连接」两步确认且只清自己那组凭证、
// 微信卡走取码/断开接口、清空会话也两步。真源码切 app-05.js 的通道卡片段，只替掉网络和保存。
const APP05 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
const IM0 = APP05.indexOf("// ================= 助理设置：通道卡片");
const IM1 = APP05.indexOf("// ================= 安全中心面板");
if (IM0 < 0 || IM1 <= IM0) throw new Error("app-05.js 里的「助理设置：通道卡片」段找不到了，前端测试没法定位真源码");
const APP03_KS = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-03.js"), "utf8");
  const a = src.indexOf("const KEY_SOURCES = {"), b = src.indexOf("const ONB_TIPS = {");
  if (a < 0 || b <= a) throw new Error("app-03.js 里找不到 KEY_SOURCES … ONB_TIPS 那一段");
  return src.slice(a, b);
})();
const IMPANE_SRC = [
  pickLine(/^const WS_STATE_TXT = .*$/m, "app-01.js 里没有 WS_STATE_TXT"),
  APP03_KS,
  APP05.slice(IM0, IM1),
].join("\n");
// ---- HTML 转义：属性里塞得进引号就等于能改属性 ----
// 全站三百多处是 attr="${esc(x)}"，esc 漏掉引号的时候，一条带引号的普通命令
// （echo "hi"）就能把属性截断，模型输出里的一个 markdown 链接更是直通 href="..."。
// 所以这一组必须在真 Chromium 里让解析器亲自解一遍——正则数 & 和 < 的个数是测不出这个的。
const E0 = APP02X.indexOf("const ESC_MAP =");
const E1 = APP02X.indexOf("/** 一条工作区相对路径的目录部分");
if (E0 < 0 || E1 <= E0) throw new Error("app-01.js 里的 esc/ESC_MAP 找不到了（改名或挪走？），前端测试没法定位真源码");
const ESC_SRC = APP02X.slice(E0, E1);
const ESC_HTML = "<!doctype html><meta charset='utf-8'><body><div id='box'></div><div id='md'></div></body>";
const ESC_STUBS = [
  IC_STUB,
  "var SvgFig = { extractSvgFigures: (s) => ({ text: s, figs: [] }) };",
  "function fpath(n) { return String(n == null ? '' : n).split('/').map(encodeURIComponent).join('/'); }",
  srcBlock("function joinRel(base, rel) {"), // 真源：mdFileLink 靠它按文档目录解相对路径，假身会把这件事测没
  srcBlock("function withRoot(url, root) {"),
  srcBlock("function mdImg(alt, url, base, root) {"), // 真源：裸链转换现在排在它后面，得验 alt 属性里的网址没被塞进 <a>
  // 正文里的文件链接点不点得动，真源在 app-02.js 的事件委托那段——renderMd 是拼字符串出来的，
  // 挂不上 onclick，这段要是哪天被改回 onclick，历史回放里的链接会全哑掉而没人发现
  (() => {
    const i = APP02.indexOf("// 正文里 [文字](报告.md) 这类指向工作区文件的链接");
    const j = APP02.indexOf("// 内联 SVG 图表的动作");
    if (i < 0 || j <= i) throw new Error("app-02.js 里的文件链接事件委托段找不到了，前端测试没法定位真源码");
    return APP02.slice(i, j);
  })(),
  "window.opened = []; function previewFile(n, r) { window.opened.push(n + '|' + (r || '')); }",
].join("\n");
const ESC_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const box = document.getElementById("box"), md = document.getElementById("md");
  const attrs = (el) => [...el.attributes].map((a) => a.name).sort();

  // ① 审批条上的真实形状：title 里装的是待批准的整条命令，命令里有引号是家常便饭
  const CMD = 'bash -c "rm -rf /tmp/x" --note=\\'张三\\'';
  box.innerHTML = '<code class="ap-cmd" title="' + esc(CMD) + '">' + esc(CMD) + '</code>';
  const code = box.querySelector("code");
  ok("带引号的命令进 title=，属性没被截断（只剩 class 和 title 两个）", code && attrs(code).join(",") === "class,title", code && attrs(code).join(","));
  ok("title 读回来跟原命令一字不差", code.getAttribute("title") === CMD, code.getAttribute("title"));
  ok("正文里显示的还是引号本身，不是 &quot;", code.textContent === CMD, code.textContent);

  // ② 硬碰硬：拿一段专门用来撑破属性的字符串
  const EVIL = '" onmouseover="window.__pwned=1" x="';
  box.innerHTML = '<b title="' + esc(EVIL) + '">x</b>';
  const b = box.querySelector("b");
  ok("撑破属性的串塞进 title=，没长出 onmouseover 这种新属性", attrs(b).join(",") === "title", attrs(b).join(","));
  ok("撑破属性的串也原样读得回来", b.getAttribute("title") === EVIL, b.getAttribute("title"));

  // ③ 模型输出那条路：markdown 链接的地址直接进 href="$2"
  md.innerHTML = renderMd('看[这里](https://a.com/p"onmouseover="window.__pwned=1)');
  const a = md.querySelector("a");
  ok("markdown 链接的地址里带引号，也没在 href 上长出事件属性", a && !a.hasAttribute("onmouseover"), a && attrs(a).join(","));
  ok("没有任何一次注入真的执行了", !window.__pwned);

  // ④ 反向对照：别为了防注入把正常的东西也弄坏
  ok("& < > 的转义跟以前一字不差", esc("a & b < c > d") === "a &amp; b &lt; c &gt; d", esc("a & b < c > d"));
  ok("null / undefined 还是空串", esc(null) === "" && esc(undefined) === "", esc(null));
  md.innerHTML = renderMd("看[这里](https://a.com/p?a=1&b=2)");
  const a2 = md.querySelector("a");
  ok("正常链接照旧能用，查询串里的 & 没被吃掉", a2 && a2.getAttribute("href") === "https://a.com/p?a=1&b=2", a2 && a2.getAttribute("href"));
  const ta = document.createElement("div");
  ta.innerHTML = '<textarea>' + esc('白名单\\n"带引号的路径"') + '</textarea>';
  ok("塞进 <textarea> 的值解得回来（安全中心那几个名单框走的就是这条）",
     ta.querySelector("textarea").value === '白名单\\n"带引号的路径"', ta.querySelector("textarea").value);

  // ⑤ 正文里裸写的网址要能点：href 里装完整地址，屏幕上显示人看得懂的短版
  const BT = String.fromCharCode(96);
  md.innerHTML = renderMd("详见 https://ex.com/a/b?x=1&y=2 就这些");
  const u1 = md.querySelector("a");
  ok("裸网址自己变成能点的链接", !!u1, md.innerHTML);
  ok("href 是完整地址，查询串里的 & 没被二次转义成 &amp;amp;",
     u1.getAttribute("href") === "https://ex.com/a/b?x=1&y=2", u1 && u1.getAttribute("href"));
  ok("不长的网址原样显示，不多此一举地掐",
     u1.textContent === "https://ex.com/a/b?x=1&y=2", u1 && u1.textContent);
  ok("新标签打开且带 noopener", u1.target === "_blank" && u1.rel === "noopener", u1.target + "/" + u1.rel);

  const LONG = "https://ex.com/downloads/RL%E7%8E%AF%E5%A2%83%E5%88%9B%E4%B8%9A%E6%B7%B1%E5%BA%A6%E8%B0%83%E7%A0%94_1.html";
  md.innerHTML = renderMd("报告在 " + LONG + " 这里");
  const u2 = md.querySelector("a");
  ok("长网址的 href 一个字符没少", u2 && u2.getAttribute("href") === LONG, u2 && u2.getAttribute("href"));
  ok("长网址的 title 也是完整地址（鼠标停住看得到全的）", u2.getAttribute("title") === LONG, u2.getAttribute("title"));
  ok("百分号转义在屏幕上解回中文", u2.textContent.indexOf("环境创业深度调研") >= 0, u2.textContent);
  ok("屏幕上那一版比原地址短（这才是不用横向拖的原因）",
     u2.textContent.length < LONG.length, u2.textContent.length + " vs " + LONG.length);

  const HUGE = "https://ex.com/" + "seg/".repeat(30) + "final-report-page.html";
  md.innerHTML = renderMd("见 " + HUGE);
  const u3 = md.querySelector("a");
  ok("超长网址的 href 仍然完整", u3.getAttribute("href") === HUGE, u3.getAttribute("href").length + "");
  ok("超长网址显示时掐掉中间，长度收在 68 以内",
     u3.textContent.indexOf("…") >= 0 && u3.textContent.length <= 68, u3.textContent);

  md.innerHTML = renderMd("见 https://a.com/x. 完");
  const u4 = md.querySelector("a");
  ok("句末的英文句号不算进网址，但那个点还留在正文里",
     u4.getAttribute("href") === "https://a.com/x" && md.textContent.indexOf("x. 完") >= 0,
     u4.getAttribute("href") + " | " + md.textContent);

  // ⑥ 反向对照：这四种情况**不该**被自动加链接
  md.innerHTML = renderMd("[这里](https://a.com/x)");
  ok("markdown 链接还是只出一个 a、文字还是「这里」",
     md.querySelectorAll("a").length === 1 && md.querySelector("a").textContent === "这里", md.innerHTML);
  md.innerHTML = renderMd("跑 " + BT + "curl https://a.com/x" + BT + " 就行");
  ok("行内代码里的网址不变链接（那是给人抄的，不是给人点的）",
     md.querySelectorAll("a").length === 0 && md.querySelector("code").textContent === "curl https://a.com/x", md.innerHTML);
  md.innerHTML = renderMd("file:///Users/x/a.html");
  ok("file:// 不变蓝链（浏览器本来就不让页面跳过去，给个点不开的链接更气人）",
     md.querySelectorAll("a").length === 0, md.innerHTML);
  md.innerHTML = renderMd("见 https://a.com/%3Cb%3Ex%3C/b%3E");
  ok("解码出来的尖括号只是字，没长成标签",
     md.querySelectorAll("b").length === 0 && md.querySelector("a").textContent.indexOf("<b>x</b>") >= 0, md.innerHTML);
  ok("解完码也没执行任何注入", !window.__pwned);
  const already = "<a href=" + String.fromCharCode(34) + "https://a.com" + String.fromCharCode(34) + ">https://a.com</a>";
  ok("已经成形的 a 标签不会被再套一层", autoLinkUrls(already) === already, autoLinkUrls(already));

  // ⑥.5 加粗 / 斜体包着的裸网址：href 必须是干净的网址，一个标点一个标签都不许粘进去。
  //
  // 用户撞见的原话：「怎么点击链接后面还有 <strong> 的啊，这链接跳转链接都搞错了啊」。
  // 当时模型写的是两个星号包着一条 feishu.cn 的地址，裸链转换排在加粗前面，于是收尾那两个星号
  // 被当成网址的一部分吞进了 href，紧接着加粗那一遍又在 href 属性正中间插进一个 </strong>：
  //   <strong><a href="https://feishu.cn/docx/xxxx</strong>" title="...">
  // 屏幕上链接后面凭空多出「<strong>」几个字，点下去跳的是个带标签的烂地址。
  // 现在裸链转换排在最后。下面这一组按 **href 的值** 判，不按屏幕上的字判——
  // 字看着对而地址是错的，正是这个 bug 当时的样子。
  const HREF = (m) => { md.innerHTML = renderMd(m); const a = md.querySelector("a[href]"); return a ? a.getAttribute("href") : "(没生成链接)"; };
  const 包一层 = [
    ["加粗", "**", "**"], ["斜体", "*", "*"],
    ["中文圆括号", "（", "）"], ["中文书名号", "《", "》"],
    ["中文引号", "\\u201c", "\\u201d"], ["方头括号", "【", "】"], ["尖括号", "<", ">"],
  ];
  const U = "https://feishu.cn/docx/A2q8dIIuWoZbllxe1f8cQK5hnYc";
  for (const [名, 左, 右] of 包一层)
    ok("被「" + 名 + "」包着的裸网址，href 还是干干净净那一条", HREF("文档已建好：" + 左 + U + 右) === U, 名 + " → " + HREF("文档已建好：" + 左 + U + 右));
  ok("网址后面紧跟一段加粗，两边各归各的", HREF("见 " + U + " **重要**") === U, HREF("见 " + U + " **重要**"));
  ok("只有一个收尾星号也不许粘进 href", HREF(U + "*") === U, HREF(U + "*"));
  ok("整条正文里一个 <strong> / <em> 字面都没漏到屏幕上",
     (() => { md.innerHTML = renderMd("文档已建好：**" + U + "**"); return md.textContent.indexOf("<strong>") < 0 && md.textContent.indexOf("<em>") < 0; })(), md.textContent);
  ok("加粗确实还是加粗（别为了修这个把粗体弄没了）",
     (() => { md.innerHTML = renderMd("文档已建好：**" + U + "**"); return !!md.querySelector("strong a[href]"); })(), md.innerHTML);
  ok("markdown 链接被加粗包着时也照旧",
     HREF("**[文档](https://a.com/x)**") === "https://a.com/x", HREF("**[文档](https://a.com/x)**"));

  // 成对的右括号是地址的一部分（维基 / Confluence 那种），落单的才剃
  ok("地址里成对的圆括号留住（少剃一个字符就跳去另一个页面）",
     HREF("见 https://zh.wikipedia.org/wiki/Foo_(bar) 完") === "https://zh.wikipedia.org/wiki/Foo_(bar)",
     HREF("见 https://zh.wikipedia.org/wiki/Foo_(bar) 完"));
  ok("落单的右括号剃掉", HREF("见 https://a.com/x) 完") === "https://a.com/x", HREF("见 https://a.com/x) 完"));
  ok("路径里的中文字要留住（/wiki/中文 是正经地址）",
     HREF("见 https://zh.wikipedia.org/wiki/中文 完") === "https://zh.wikipedia.org/wiki/中文", HREF("见 https://zh.wikipedia.org/wiki/中文 完"));
  ok("查询串里的 & 没被吃掉也没被二次转义",
     HREF("详见 https://ex.com/a?x=1&y=2 就这些") === "https://ex.com/a?x=1&y=2", HREF("详见 https://ex.com/a?x=1&y=2 就这些"));

  // 换了顺序之后最容易砸的一处：属性值里的网址。裸链转换现在跑在 <img> 生成之后，
  // 要是它不认标签，alt="见 https://…" 里那一条会被塞进一个 <a>，当场把属性撑破
  md.innerHTML = renderMd("![见 https://a.com/x](pic.png)");
  ok("图片 alt 属性里的网址不变链接，属性也没被撑破",
     md.querySelectorAll("a").length === 0 && (md.querySelector("img") || {}).alt === "见 https://a.com/x",
     md.innerHTML);
  md.innerHTML = renderMd(BT + BT + BT + "\\nsee https://a.com/x\\n" + BT + BT + BT);
  ok("代码块里的网址不变链接", md.querySelectorAll("a[href]").length === 0 && /see https:\\/\\/a\\.com\\/x/.test(md.textContent), md.innerHTML);

  // 表格 / 标题 / 列表里也走同一条路，别只在段落里对
  for (const [名, 原文] of [["表格单元格", "| 名 | 址 |\\n| --- | --- |\\n| 文档 | **" + U + "** |"], ["标题", "## **" + U + "**"], ["列表项", "- **" + U + "**"]])
    ok(名 + "里的加粗裸网址，href 同样干净", HREF(原文) === U, 名 + " → " + HREF(原文));

  // ⑦ 指向工作区文件的 markdown 链接。以前这一路只认 https:——模型收尾写
  //    「详见 [调研报告](报告.md)」，屏幕上就原样印出一串方括号圆括号，点哪儿都没反应。
  // 链接没生成时别让整个脚本栽在 null 上——那样只会看到一句「Script failed to execute」，
  // 看不出是哪一条规矩破了。垫一个空壳，让具体那条 ok() 自己红
  const NOLN = { dataset: {}, textContent: "", hasAttribute: () => false, click: () => {}, dispatchEvent: () => {} };
  const fl = () => md.querySelector("a.file-ln") || NOLN;
  md.innerHTML = renderMd("详见 [调研报告](报告.md) 的第二节");
  ok("相对路径的 markdown 链接变成能点的文件链接", !!md.querySelector("a.file-ln"), md.innerHTML);
  ok("屏幕上只剩链接文字，方括号圆括号都不见了",
     fl().textContent === "调研报告" && md.textContent.indexOf("[") < 0 && md.textContent.indexOf("(") < 0, md.textContent);
  ok("data-name 就是要预览的那个文件", fl().dataset.name === "报告.md", fl().dataset.name);
  ok("没有 href：它开的是右侧预览面板，不是跳走一页", !fl().hasAttribute("href"), attrs(fl()).join(","));

  md.innerHTML = renderMd("见 [附图](图/趋势.png)", "任务_A/子目录");
  ok("相对路径按文档自己所在的目录解，不是回工作区根上找", fl().dataset.name === "任务_A/子目录/图/趋势.png", fl().dataset.name);
  md.innerHTML = renderMd("见 [上一级](../汇总.md)", "任务_A/子目录");
  ok("../ 照规矩往上退一级", fl().dataset.name === "任务_A/汇总.md", fl().dataset.name);

  window.opened = [];
  md.innerHTML = renderMd("详见 [调研报告](报告.md)", "", false, "root-2");
  fl().click();
  ok("点一下真的去开预览了，还带上了这份成果所属的工作目录",
     window.opened.join(",") === "报告.md|root-2", window.opened.join(","));
  window.opened = [];
  fl().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  ok("键盘回车也开得了（这些 a 没有 href，浏览器不会自己认）", window.opened.length === 1, window.opened.join(","));

  // ⑧ 反向对照：这几种**不该**变成工作区文件链接
  md.innerHTML = renderMd("看[这里](https://a.com/x.md)");
  ok("https 的还是普通外链，没被当成工作区文件",
     md.querySelector("a").getAttribute("href") === "https://a.com/x.md" && !md.querySelector("a.file-ln"), md.innerHTML);
  md.innerHTML = renderMd("详见[第三章](chapter-3)");
  ok("不带扩展名的一律不碰（点开只会是一句「文件不存在」，比不给链接更气人）",
     md.querySelectorAll("a").length === 0 && md.textContent.indexOf("[第三章](chapter-3)") >= 0, md.innerHTML);
  window.opened = [];
  md.innerHTML = renderMd("看[这里](javascript:alert(1))");
  ok("javascript: 不变链接，也没执行", md.querySelectorAll("a").length === 0 && !window.__pwned, md.innerHTML);
  md.innerHTML = renderMd('看[这里](a.md"onmouseover="window.__pwned=1) 和 [那里](b&quot;.md)');
  const evilAttr = Array.from(md.querySelectorAll("*")).some((n) => Array.from(n.attributes).some((x) => /^on/i.test(x.name)));
  ok("地址里塞引号也撑不破属性：没多出来的 on* 事件属性，也没执行", !evilAttr && !window.__pwned, md.innerHTML);
  md.innerHTML = renderMd("见 [资料](报告.md)", "", false, "", { fileLinks: false });
  ok("关掉 fileLinks 的那几页（资料库、助理设置里的对话记录）原样当文字",
     md.querySelectorAll("a").length === 0 && md.textContent.indexOf("[资料](报告.md)") >= 0, md.innerHTML);
  ok("这一节走完一次注入都没得逞", !window.__pwned);
  return names;
})()
`;

// ---- 记忆页：会 403 的按钮不该摆在那儿 ----
// 条目是按登录名存的（agent 用 remember 工具替他记），可 /api/memory 这个前缀归平台管理员，
// 于是普通成员打开这一页：自己的记忆一条看不见、加不了、删不掉，界面上一句解释都没有。
// 后端开完口子还不够——这一页原来还画着三样他点了必挂的东西：共享区那条的「删」、
// 「给所有账号共用」的勾选框、「保存背景说明」。删那颗更狠：返回值整个扔了，403 也照样重画一遍，
// 那条纹丝不动，用户只能得出「点了没反应」。这一组就是让真 Chromium 亲自把这一页画出来数按钮。
const MEM0 = APP05.indexOf("async function renderMemoryPane(pane) {");
const MEM1 = APP05.indexOf("function renderDataPane(pane, s) {");
if (MEM0 < 0 || MEM1 <= MEM0) throw new Error("app-05.js 里的 renderMemoryPane 找不到了，前端测试没法定位真源码");
const MEM_SRC = APP05.slice(MEM0, MEM1);
const MEM_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><body><div id='pane'></div></body>";
const MEM_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };

  const SHARED = "*";
  const ITEMS = [
    { id: "i1", scope: "xiaoyuan", text: "小袁的周报只要三段", source: "auto" },
    { id: "i2", scope: SHARED, text: "全公司统一用飞书日历", source: "user" },
  ];
  let calls = [], nextDel = { ok: true, removed: 1 }, view = {};
  window.toasts = [];
  // 记图标名：仓库里一律 toast(文字, "circle-x")，断言要验的是「配了哪个图标」
  window.toast = (m, i) => window.toasts.push((i ? "[" + i + "] " : "") + String(m));
  window.escInline = (x) => esc(x);
  window.fmtSize = (n) => n + "B";
  window.fetch = (url, opt) => {
    calls.push({ url, method: (opt && opt.method) || "GET", body: opt && opt.body ? JSON.parse(opt.body) : null });
    const j = (v) => Promise.resolve({ ok: true, json: () => Promise.resolve(v) });
    if (url === "/api/memory" && (!opt || !opt.method || opt.method === "GET"))
      return j({ items: ITEMS.slice(), shared_tag: SHARED, content: "老板写的背景", limits: { max_items: 120 },
                 vectors: { enabled: false }, can_share: !!view.can_share, can_edit_manual: !!view.can_edit_manual });
    if (url.startsWith("/api/memory/item/")) return j(nextDel);
    if (url === "/api/memory/item") return j({ ok: true, note: "记住了" });
    if (url === "/api/memory/import/scan") return j({ sources: [] });
    return j({ ok: true });
  };
  const pane = document.getElementById("pane");
  const draw = async (v) => { view = v; calls = []; window.toasts = []; await renderMemoryPane(pane); };
  const q = (sel) => pane.querySelector(sel);
  const delLinks = () => [...pane.querySelectorAll("[data-del]")].map((a) => a.dataset.del).sort();

  // ① 普通成员这一页：只画他点得动的
  await draw({ can_share: false, can_edit_manual: false });
  ok("普通成员也看得见自己那条记忆（后端开了口子，这一页真画出来了）", pane.textContent.includes("小袁的周报只要三段"));
  ok("共享区那条上没有「删」（那条进的是所有人的提示词，他删不动）", delLinks().join(",") === "i1", delLinks().join(","));
  ok("自己那条上有「删」", delLinks().includes("i1"));
  ok("「给这台机器上所有账号共用」的勾选框没画出来", !q("#mem-shared"));
  ok("换成了一句人话，说清楚为什么没有", /平台管理员/.test(pane.textContent));
  ok("「保存背景说明」那颗按钮没画出来", !q("#mem-save"));
  ok("背景说明还看得见，只是只读", q("#mem-text") && q("#mem-text").readOnly && q("#mem-text").value === "老板写的背景");
  ok("「记忆搬家」整张卡没画出来（导出是整库、导入往全局写）", !q("#mem-export") && !q("#mem-scan"));

  // ② 加一条：勾选框没了也不能炸，而且不许自作主张按共享发
  q("#mem-new").value = "手动加的一条";
  await q("#mem-add").onclick();
  const add = calls.find((c) => c.url === "/api/memory/item" && c.method === "POST");
  ok("没有勾选框时「加进去」照样能点（读 null.checked 会把整页炸掉）", !!add);
  ok("加的这条不带 shared，不会去撞后端那道降档", add.body.shared === false, JSON.stringify(add.body));

  // ③ 删：返回值不许再扔了
  await draw({ can_share: false, can_edit_manual: false });
  calls = []; // 画这一页本身要拉一次 /api/memory，先清掉，下面数的才是「删完有没有重画」
  nextDel = { ok: false, removed: 0, error: "这条不是你记的，删不了" };
  await pane.querySelector("[data-del]").onclick({ preventDefault() {} });
  ok("后端拒了就说出来，不再是「点了没反应」", window.toasts.join("|").includes("删不掉"), window.toasts.join("|"));
  ok("拒了就不重画（重画一遍那条还在，看着像没点中）", calls.filter((c) => c.url === "/api/memory" && c.method === "GET").length === 0);
  window.toasts = [];
  nextDel = { ok: true, removed: 0 };
  await pane.querySelector("[data-del]").onclick({ preventDefault() {} });
  ok("本来就没有：说「已经不在了」，不跟越权混为一谈", window.toasts.join("|").includes("已经不在了"), window.toasts.join("|"));
  window.toasts = []; calls = [];
  nextDel = { ok: true, removed: 1 };
  await pane.querySelector("[data-del]").onclick({ preventDefault() {} });
  ok("真删掉了才重画", calls.some((c) => c.url === "/api/memory" && c.method === "GET"));
  ok("真删掉了就别再弹一句多余的话", window.toasts.length === 0, window.toasts.join("|"));

  // ④ 反向对照：平台管理员那一页，三样东西一样不少
  await draw({ can_share: true, can_edit_manual: true });
  ok("反向对照：平台管理员两条都能删（含共享区那条）", delLinks().join(",") === "i1,i2", delLinks().join(","));
  ok("反向对照：勾选框在", !!q("#mem-shared"));
  ok("反向对照：「保存背景说明」在，textarea 不是只读", !!q("#mem-save") && !q("#mem-text").readOnly);
  ok("反向对照：「记忆搬家」那张卡在", !!q("#mem-export"));
  q("#mem-new").value = "老板广播一条";
  q("#mem-shared").checked = true;
  await q("#mem-add").onclick();
  const add2 = calls.find((c) => c.url === "/api/memory/item" && c.method === "POST");
  ok("反向对照：他勾了共享，请求里就带 shared:true", add2 && add2.body.shared === true, JSON.stringify(add2 && add2.body));
  return names;
})()
`;

// ---- 自动化 / 资料库：403 不该变成一片白，也不该变成一句假的成功 ----
// fetch 遇上 403 不会 reject，`.catch(() => [])` 一个都兜不住：renderAutomPage 拿到的是
// { error } 这个对象，下一行 list.filter 当场 TypeError，整个渲染函数断在半空——
// 多人服务器上的普通成员点一下「自动化」，看到的就是一片空白，报错只在控制台里。
// 资料库那边是另一种：接口 403 了，页面照样写「还没有参考资料」（一句瞎话），
// 上传按钮照画，点完不看返回值就 toast「✅ 已上传」（一句假的成功）。
// 这一组在真 Chromium 里把这几页画出来，每条成员断言都配一条平台管理员的反向对照。
const APP01_NAV = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8");
const APP03_AT = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-03.js"), "utf8");
const APP04_LIB = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-04.js"), "utf8");
const NAV0 = APP01_NAV.indexOf('const PLATFORM_ONLY_VIEWS = ["autom", "eval", "trace"];');
const NAV1 = APP01_NAV.indexOf("// 这个选择器只管「当前对话」用哪个模型");
const AUT0 = APP03_AT.indexOf("async function renderAutomPage() {");
const AUT1 = APP03_AT.indexOf("function renderAutomTplPicker(box) {");
const RUN0 = APP03_AT.indexOf("async function renderAutomRuns(page) {");
const RUN1 = APP03_AT.indexOf("// ================= 资料库页（");
// 起点是 libTaskOf 而不是 renderLibPage：libIcon / LIB_KINDS / libKindOk / libWhen / libMark
// 这几个帮手都排在 renderLibPage 前面，从 renderLibPage 切起会把它们整批漏在外面
const LIB0 = APP04_LIB.indexOf("function libTaskOf(src, name) {");
const LIB1 = APP04_LIB.indexOf("// ================= 专家 · 技能 · 连接器");
for (const [a, b, why] of [[NAV0, NAV1, "app-01.js 的 syncNavByRole"], [AUT0, AUT1, "app-03.js 的 renderAutomPage"],
  [RUN0, RUN1, "app-03.js 的 renderAutomRuns"], [LIB0, LIB1, "app-04.js 的 renderLibPage/renderLibPreview"]])
  if (a < 0 || b <= a) throw new Error(why + " 找不到了（改名/挪走？），自动化/资料库权限测试没法定位真源码");
// 资料库那段预览走的是 blob: iframe，页面里要塞一段自报尺寸的脚本（PV_FIT_REPORTER）。
// 那个常量住在 app-01.js，整站是按顺序加载的所以真跑起来拿得到；这儿只切了 app-04 的一段，
// 不把它一起带上就是 ReferenceError——而 renderLibPreview 把异常吞成一行「预览不了：…」，
// 于是整块预览静悄悄地白着，测试报的也是那句话，看不出真因。同样切真源码，不抄一份。
const PVF0 = APP01_NAV.indexOf("const PV_FIT_REPORTER = ");
const PVF1 = APP01_NAV.indexOf("async function previewFile(", PVF0);
if (PVF0 < 0 || PVF1 <= PVF0) throw new Error("app-01.js 里的 PV_FIT_REPORTER 找不到了（改名/挪走？），资料库预览测试没法定位真源码");
// docx / xlsx / pptx / zip / csv 那几样，资料库和对话页共用 app-01 里同一套渲染函数。
// 桩成 () => "<table>" 就等于只测了「有没有走进那个 if」，而用户抱怨的正是画出来的东西
// （：几张幻灯片、表头有没有、转义漏没漏，全在这段真源码里。
const OVH0 = APP01_NAV.indexOf("// ---- 拆出来的结构化数据 → HTML");
const OVH1 = APP01_NAV.indexOf("// ---------------- 代码文件的看法", OVH0);
if (OVH0 < 0 || OVH1 <= OVH0) throw new Error("app-01.js 里的 docHtml/sheetHtml/slidesHtml 那段找不到了（改名/挪走？），资料库 Office 预览测试没法定位真源码");
// 资料库预览现在跟对话页共用同一套「这个后缀走哪条路」的尺子（PV_AUDIO_RE / PV_VIDEO_RE /
// PV_BINARY_RE / looksBinary）。不把这段带进来就是 ReferenceError，而 renderLibPreview 把异常
// 吞成一行「预览不了：…」——整块预览静悄悄地白着，测试还以为只是文案变了。同样切真源码。
const PVK0 = APP01_NAV.indexOf("const PV_IFRAME_RE = ");
const PVK1 = APP01_NAV.indexOf("const PV_TEXT_MAX = ", PVK0);
if (PVK0 < 0 || PVK1 <= PVK0) throw new Error("app-01.js 里的 PV_*_RE / looksBinary 那段找不到了（改名/挪走？），资料库预览测试没法定位真源码");
// 预览面板上的「所在位置」「复制文件」两颗按钮：画不画看 canOpenOnHost，点下去发什么看这两个函数
const DEAD_SRC = HOSTCAP_SRC + "\n" + srcBlock("function revealFile(") + "\n" + srcBlock("function copyHostFile(")
  + "\n" + APP01_NAV.slice(PVK0, PVK1) + "\n"
  + APP01_NAV.slice(NAV0, NAV1) + "\n" + APP01_NAV.slice(PVF0, PVF1)
  + "\n" + APP01_NAV.slice(OVH0, OVH1)
  + "\n" + APP03_AT.slice(AUT0, AUT1) + "\n" + APP03_AT.slice(RUN0, RUN1)
  + "\n" + APP04_LIB.slice(LIB0, LIB1);
const DEAD_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><body>"
  + "<div class='side-nav top'>"
  + "<div class='item' data-view='hub'>专家</div><div class='item' data-view='autom'>自动化</div>"
  + "<div class='item' data-view='prompts'>参考模板库</div><div class='item' data-view='lib'>资料库</div>"
  + "<div class='item' data-view='eval'>评测</div><div class='item' data-view='trace'>执行追踪</div></div>"
  + "<div class='assist-page' id='assist-page'></div></body>";
// ---- 登录卡：邀请码 · 看一眼密码 · 待审核/已停用 ----
// 这三样以前全是断的，而且断得一声不响：
//   · 后端 register 一直收 invite，登录框上却没有填它的地方——企业版最主要的开户路径在界面上走不通；
//   · 自助注册按安全默认是**关**的，于是连「注册一个」那行字都不显示，拿着邀请码的人连注册页都进不去；
//   · 待审核 / 已停用的人照样被放进完整工作台，然后每点一下弹一个 403。
// 这类事故截图看不出来（页面画得好好的），只能钉在真源码 + 真 DOM 上。
const AUTH_MARK = "// ================= 登录 / 注册 =================";
const AU0 = APP03_AT.indexOf(AUTH_MARK);
const AU1 = APP03_AT.indexOf("async function initAuth() {");
if (AU0 < 0 || AU1 <= AU0) throw new Error("app-03.js 里的登录/注册段找不到了，登录卡测试没法定位真源码");
const AUTH_SRC = APP03_AT.slice(AU0, AU1);
// 卡片本身的 HTML 也从 index.html 真拿：markup 和 JS 里的 id 对不上是这块最常见的坏法
const AUTH_CARD = (() => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const a = html.indexOf('<div class="auth-mask" id="auth-mask">');
  const b = html.indexOf("</div>\n</div>", a);
  if (a < 0 || b <= a) throw new Error("public/index.html 里找不到登录卡");
  return html.slice(a, b + "</div>\n</div>".length);
})();
const AUTH_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style><body>" + AUTH_CARD + "</body>";
const AUTH_STUBS = [
  IC_STUB,
  // 这几个在 app-01/app-00 里，这一屏只借它们的行为
  "function esc(s){ const d=document.createElement('div'); d.textContent = s==null?'':String(s); return d.innerHTML; }",
  "function displayName(u){ return (u && (u.nickname || u.username)) || ''; }",
  "let currentUser = null, creditsOn = false;",
  "window.__posts = [];",
  "window.__resp = { ok: true, body: { ok: true } };",
  "window.fetch = async (url, init) => {",
  "  window.__posts.push({ url, body: init && init.body ? JSON.parse(init.body) : null });",
  "  const r = window.__resp;",
  // 响应头也得有：登录成功那一下要读 X-Recovery-Left（恢复码还剩几条）。
  // 桩里缺这一层的话，真源码一句 resp.headers.get 就炸在「读不到 undefined 的 get」上
  "  return { ok: r.ok, headers: { get: (k) => (r.headers && k in r.headers ? r.headers[k] : null) }, json: async () => r.body };",
  "};",
].join("\n");
// 真源码读 location / 写 history，而这两个在页面里都是改不动的（`const location` 直接 SyntaxError，
// 真的 location.reload() 会把夹具整个冲掉）。所以把整段包进一个拿它俩当参数的工厂：
// 里面一个字节没改，外面能换地址、能数刷新了几次。
// authMode / canRegister 是段内的 let，用取值器透出去，用例照样能摆布它们。
const AUTH_WRAP = (src) =>
  "window.__mkAuth = (location, history, sessionStorage) => {\n" + src + "\nreturn { showAuth, applyAuthMode, submitAuth, showAuthBlocked,\n" +
  "  get authMode(){ return authMode; }, set authMode(v){ authMode = v; },\n" +
  "  get canRegister(){ return canRegister; }, set canRegister(v){ canRegister = v; } };\n};";
const AUTH_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const $ = (id) => document.getElementById(id);
  const vis = (el) => !!el && getComputedStyle(el).display !== "none";
  const nav = { reloads: 0, replaced: [] };
  const loc = { origin: "http://x", pathname: "/", search: "", hash: "", href: "http://x/", reload(){ nav.reloads++; } };
  const setUrl = (href) => { const u = new URL(href); loc.href = href; loc.pathname = u.pathname; loc.search = u.search; loc.hash = u.hash; };
  const store = {};
  const A = window.__mkAuth(loc, { replaceState(a, b, u){ nav.replaced.push(u); } },
    { setItem(k, v){ store[k] = String(v); }, getItem(k){ return k in store ? store[k] : null; } });

  // ---- 1. 普通登录：邀请码框收着，但那条入口一直在 ----
  A.canRegister = false; // 自助注册关着（放公网的默认配置）
  setUrl("http://x/");
  A.showAuth(false);
  ok("默认是登录模式", $("auth-go").textContent === "登录");
  ok("登录时不显示邀请码框", !vis($("auth-invite")));
  ok("自助注册关着时「注册一个」确实藏起来了", !vis($("auth-alt")));
  ok("但「有邀请码？」这条路照样在", vis($("auth-invite-alt")),
     "这就是老版本的死结：注册入口被 open_register 藏了，拿着邀请码的人连注册页都进不去");

  // ---- 2. 点「用邀请码注册」→ 进注册模式，框出来 ----
  $("auth-invite-go").click();
  ok("点了之后进注册模式", $("auth-go").textContent === "注册并登录");
  ok("邀请码框露出来了", vis($("auth-invite")));
  ok("自己点进来的（不是链接带码）就不用那句说明", !vis($("auth-invite-hint")));
  ok("进了注册模式就不再重复显示那条入口", !vis($("auth-invite-alt")));
  ok("自助注册关着时，框里说清楚这是必填", $("auth-invite").placeholder.includes("管理员给你的"));
  A.canRegister = true; A.applyAuthMode(false);
  ok("自助注册开着时，框里说清楚可以留空", $("auth-invite").placeholder.includes("留空"),
     "不然人看见个空框就以为自己还缺一个码");
  A.canRegister = false; A.applyAuthMode(false);

  // ---- 3. 注册带邀请码：payload 里真有 invite ----
  window.__posts.length = 0;
  $("auth-user").value = " 小王 ";
  $("auth-pass").value = "pw123456";
  $("auth-invite").value = " AB12CD ";
  await A.submitAuth();
  const p = window.__posts[0];
  ok("注册打的是 /api/auth/register", p && p.url === "/api/auth/register");
  ok("邀请码进了 payload 且去了首尾空格", p.body.invite === "AB12CD", JSON.stringify(p.body));
  ok("用户名也去了首尾空格", p.body.username === "小王");
  ok("成功之后整页重来（cookie 才生效）", nav.reloads === 1);

  // ---- 4. 纯登录不夹带 invite 字段 ----
  window.__posts.length = 0;
  A.authMode = "login"; A.applyAuthMode(false);
  $("auth-pass").value = "pw123456";
  await A.submitAuth();
  ok("登录打的是 /api/auth/login", window.__posts[0].url === "/api/auth/login");
  ok("登录 payload 里没有 invite 这个键", !("invite" in window.__posts[0].body), JSON.stringify(window.__posts[0].body));

  // ---- 5. 链接直接带码：?invite=… 打开就是填好的注册页 ----
  setUrl("http://x/?invite=XYZ789");
  $("auth-invite").value = "";
  A.showAuth(false);
  ok("带码的链接直接落在注册模式", $("auth-go").textContent === "注册并登录");
  ok("码已经替他填好了", $("auth-invite").value === "XYZ789");
  ok("并且说清楚那串字是哪来的", vis($("auth-invite-hint")), "不然框里一串 XYZ789 没头没尾，人只会盯着它猜");
  ok("地址栏上的码被抹掉了", nav.replaced.pop() === "/",
     "留着的话刷新一次又走一遍注册，把链接转发出去还会把码带出去");

  // ---- 5b. 链接带 ?pair=：配对模式，且**在全新安装上也得是配对模式** ----
  // 真浏览器（Chrome 153 + CDP）里量出来的一个 bug：优先级写反了。
  // authMode 那行是 pair 赢 setup，标题那行却是 setup 赢 pair，于是服务器刚重装、
  // 一个账号都没有的时候，有人从手机历史里点开旧配对链接，会看到半张脸对不上：
  // 底下已经是配对表单（用户名密码收起来了、码填好了、按钮写「连接」），
  // 上面标题还在说「创建管理员账号」，副标题教人怎么开管理员号。
  // 这串得是真码的样子：account.js 的 PAIR_LEN=8、字母表抠掉了 I L O 0 1、不带前缀也不带横杠。
  // 写成别的形状也能过这一节（这里只验预填，不过服务端），但照着它手改真链接去试的人会撞上
  // claimPair 那句 key.length !== PAIR_LEN —— 看起来像「配对功能坏了」。
  // （这整段在一个模板字符串里，注释里不能出现反引号：它会把 AUTH_CHECKS 提前截断。）
  setUrl("http://x/?pair=K7RQM2XD");
  $("auth-pair").value = "";
  A.showAuth(true); // ← setup=true：全新安装，正是出事的那一幕
  ok("全新安装上点开配对链接，标题也得说配对", $("auth-title").textContent === "用配对码连接",
     "标题说「创建管理员账号」、表单却是配对表单——两句话互相打架");
  ok("副标题跟着标题走，别教人去开管理员号", $("auth-sub").textContent.includes("配对码"));
  ok("配对码替他填好了", $("auth-pair").value === "K7RQM2XD");
  ok("按钮是「连接」", $("auth-go").textContent === "连接");
  ok("配对时把用户名密码收起来", !vis($("auth-user")),
     "这条路的全部意义就是**不用**在这台设备上敲密码；框还摆着，人多半还是会去填");
  ok("配对码从地址栏上抹掉了", nav.replaced.pop() === "/",
     "它是一把能直接开门的钥匙，而地址栏是这台设备上最公开的地方");

  // ---- 6. 首次开箱（还没有任何用户）不该问邀请码 ----
  setUrl("http://x/");
  A.showAuth(true);
  ok("建第一个管理员时不显示邀请码框", !vis($("auth-invite")), "那会儿一个组织都没有，没人能发码");
  ok("建第一个管理员时两条 alt 都收起来", !vis($("auth-alt")) && !vis($("auth-invite-alt")));

  // ---- 7. 后端说「要邀请码」时，把框摆出来 ----
  A.authMode = "register"; A.applyAuthMode(false);
  $("auth-invite").style.display = "none";
  $("auth-invite").value = "";
  window.__resp = { ok: false, body: { error: "要邀请码才能注册，找管理员要一个" } };
  $("auth-user").value = "小李"; $("auth-pass").value = "pw123456";
  await A.submitAuth();
  ok("报错原话照抄给用户", $("auth-err").textContent.includes("要邀请码才能注册"));
  ok("顺手把邀请码框打开", vis($("auth-invite")), "只报一句错等于让他自己猜那个框在哪");
  ok("失败之后按钮解锁，还能再试", !$("auth-go").disabled);
  window.__resp = { ok: true, body: { ok: true } };

  // ---- 8. 看一眼密码 ----
  const eye = $("auth-eye"), pw = $("auth-pass");
  ok("密码默认是遮住的", pw.type === "password");
  eye.click();
  ok("点一下变明文", pw.type === "text");
  ok("按钮自己也要看得出是开着的", eye.classList.contains("on"));
  ok("读屏器那边跟着改口", eye.getAttribute("aria-label") === "隐藏密码");
  eye.click();
  ok("再点一下遮回去", pw.type === "password" && !eye.classList.contains("on"));

  // ---- 8b. 二次验证：密码对了才问码，两步走 ----
  // 这一整条路以前是**断的**：后端早就在发 401 + need_2fa，前端没人接，
  // 于是开了二次验证的账号在网页上永远登不进来——密码敲对了也只弹一句「失败了，稍后再试」，
  // 而那句话会把人送去改密码。这一屏钉的就是「谁先开口」和「错了怎么收场」。
  A.authMode = "login"; A.applyAuthMode(false);
  ok("一上来不问码", !vis($("auth-code")),
     "框一直摆着，等于拿账号名去问服务器「这人开没开二次验证」——撞库的人最想先知道的就是这个");
  window.__posts.length = 0;
  $("auth-user").value = "小赵"; $("auth-pass").value = "pw123456";
  window.__resp = { ok: false, body: { need_2fa: true, error: "需要二次验证码" } };
  await A.submitAuth();
  ok("后端说要码，框才出来", vis($("auth-code")));
  ok("提示也跟着出来", vis($("auth-code-hint")), "恢复码也填这个框，不说的话手机丢了的人只会盯着它发愣");
  ok("按钮改口成「验证并登录」", $("auth-go").textContent === "验证并登录");
  ok("★第一次进这一步不许弹红字★", $("auth-err").textContent === "",
     "密码明明是对的，一句红色「需要二次验证码」会让人回去折腾密码");

  window.__posts.length = 0;
  await A.submitAuth();
  ok("码空着就不发请求", window.__posts.length === 0, "二次验证的错码是**计次**的，空点几下等于自己把自己锁了");
  ok("并且说清楚还差什么", $("auth-err").textContent.includes("6 位数字"));

  $("auth-code").value = "000000";
  window.__resp = { ok: false, body: { need_2fa: true, error: "验证码不对" } };
  await A.submitAuth();
  ok("带码那一趟 payload 里真有 code", window.__posts.pop().body.code === "000000");
  ok("错码的原话照抄", $("auth-err").textContent === "验证码不对");
  ok("★错了要把框清空★", $("auth-code").value === "",
     "留着上一次那六位数，人多半直接再点一次按钮，白撞一次限流计数");

  window.__posts.length = 0;
  $("auth-code").value = " 123456 ";
  window.__resp = { ok: true, body: { ok: true }, headers: { "X-Recovery-Left": "3" } };
  nav.reloads = 0;
  await A.submitAuth();
  ok("码去掉首尾空格再发", window.__posts.pop().body.code === "123456");
  ok("验过了整页重来", nav.reloads === 1);
  ok("★用掉一条恢复码，剩几条得记下来★", store["owb-recovery-left"] === "3",
     "剩 0 条的时候手机再丢一次就真进不来了，而这件事没人会主动去查");

  delete store["owb-recovery-left"];
  A.authMode = "register"; A.applyAuthMode(false);
  ok("换模式就把码框收回去", !vis($("auth-code")) && $("auth-code").value === "",
     "人去注册页转一圈回来，框还摆在那儿，他会以为新账号也要填码");
  window.__posts.length = 0;
  A.authMode = "login"; A.applyAuthMode(false);
  $("auth-user").value = "小钱"; $("auth-pass").value = "pw123456";
  window.__resp = { ok: true, body: { ok: true } };
  await A.submitAuth();
  ok("回到第一步：payload 里没有 code 这个键", !("code" in window.__posts[0].body), JSON.stringify(window.__posts[0].body));
  ok("没有那个响应头就什么都不写", !("owb-recovery-left" in store),
     "写一个空值进去，界面下回就会拿它当「还剩 0 条」报警");

  // ---- 9. 待审核：不放进工作台，直接把话说清楚 ----
  A.showAuthBlocked("pending", { username: "xiaowang", nickname: "小王" });
  const card = document.querySelector("#auth-mask .auth-card");
  ok("换成等待卡", card.classList.contains("auth-wait"));
  ok("标题说的是在等谁", card.querySelector("h2").textContent.includes("等管理员"));
  ok("卡里叫的是他的昵称", card.querySelector(".sub").innerHTML.includes("小王"));
  ok("遮罩是开着的（工作台碰不到）", $("auth-mask").classList.contains("show"));
  ok("等待卡上没有输入框了", !card.querySelector("input"));
  ok("给了两个出口：再查一次 / 退出登录", !!$("auth-blocked-retry") && !!$("auth-blocked-out"));
  nav.reloads = 0;
  $("auth-blocked-retry").click();
  ok("「再查一次」就是重来一遍", nav.reloads === 1);

  // ---- 10. 已停用：话不一样，图标也不一样 ----
  A.showAuthBlocked("disabled", { username: "xiaoli" });
  const card2 = document.querySelector("#auth-mask .auth-card");
  ok("停用卡说的是停用", card2.querySelector("h2").textContent.includes("停用"));
  ok("停用卡的图标是红的那一路", card2.querySelector(".ico").classList.contains("bad"));
  ok("告诉他东西还在、找谁能恢复", /文件都还在/.test(card2.querySelector(".sub").textContent) && /管理员/.test(card2.querySelector(".sub").textContent));
  window.__posts.length = 0;
  $("auth-blocked-out").click();
  await new Promise((r) => setTimeout(r, 0));
  ok("「退出登录」真去退了登录", window.__posts[0] && window.__posts[0].url === "/api/auth/logout");
  ok("两颗按钮都是一行放得下的短词", [...card2.querySelectorAll(".row button")].every((b) => b.textContent.length <= 5),
     "「我已经通过了，刷新」在 340px 的卡里会折成两行，旁边那颗只有一行——看着像画坏了");

  return names;
})()`;

const DEAD_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };

  // 测试页是 data: URL（不透明源），localStorage 一碰就抛；塞个内存版
  try { localStorage.getItem("owb_lib_recent"); } catch {
    const mem = {};
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; },
    } });
  }
  // 这几页周边的零碎（表单、模版选择器、CSV/Markdown 渲染）不是这次要测的，喂桩
  window.automState = { tab: "tasks", q: "", bulk: false, sel: new Set(), showForm: false, editing: null };
  // 资料库现在有三种视图和类型筛选，state 少一个字段就整页塌，所以桩要跟真的一样全
  window.libState = { q: "", pick: null, dir: "", view: "dir", kind: "all" };
  window.libOutCache = null;          // 产出索引：renderLibPage 拿到就往这儿存，预览页靠它反查「出自哪次任务」
  window.libTaskShut = new Set();     // 收起来的任务分组
  window.opened = [];
  window.openSession = (id) => window.opened.push(id);
  window.cronToHuman = () => "每天 9:00";
  // 只跑一次那种没有 cron，页面走的是 whenToHuman；桩少这一个，自动化整页就塌在 ReferenceError 上
  window.whenToHuman = (t) => (t && t.at ? "今天 14:05（只跑一次）" : "每天 9:00");
  window.escInline = (s) => String(s == null ? "" : s);
  window.renderAutomForm = () => {};
  window.renderAutomTplPicker = () => {};
  window.renderMd = (t) => String(t);
  window.fpath = (n) => String(n == null ? "" : n).split("/").map(encodeURIComponent).join("/");
  window.pageKind = "autom";
  window.refreshSettingsCache = async () => {};
  window.modalCalls = [];
  window.openModal = (k, t) => window.modalCalls.push(k + ":" + (t || ""));
  window.toasts = [];
  // 记图标名：仓库里一律 toast(文字, "circle-x")，断言要验的是「配了哪个图标」
  window.toast = (m, i) => window.toasts.push((i ? "[" + i + "] " : "") + String(m));
  window.askConfirm = async () => true;

  const FORBID = { error: "这块是服务器级设置，归平台管理员管", platform_only: true };
  // 资料库一人一份之后，写它不再看职位——但服务端依然会因別的原因拒（盘满、重名、名字非法）。
  // writeOk 管的就是那一拒：页面得把服务端的原话抬出来，不能让东西凭空消失。
  const LIB_ERR = { error: "资料库读不出来（服务器没回内容）" };
  const LIB_DENY = { error: "存不下：磁盘写满了" };
  let writeOk = true, denyRead = false, denyOut = false, uploadResp = { ok: true, name: "a.md" };
  // 预览一份产出时服务端回什么：404 = 东西没了，500 = 读不出来，200 = 正常
  let viewResp = { code: 200, body: "# 九月周报" };
  // docx/xlsx/pptx/zip 走的是另一条路：服务端先把压缩包拆成结构化数据，前端只管画。
  // ovHits 记下问的是哪个根——资料库的文件必须问 /api/library/preview/，
  // 问成 /api/files/preview/ 就是在另一个目录里找，永远 404（那正是「资料库打不开 PPT」的形状）
  let ovResp = { code: 200, body: {} };
  const ovHits = [];
  // 谁真的去碰了文件本身。音频/二进制这两条路的要点恰恰是「别把整包拉回来」，
  // 只看画面对不对是看不出来的——得数请求
  const fileHits = [];
  const posts = [];
  window.fetch = (url, opt) => {
    const method = (opt && opt.method) || "GET";
    if (method !== "GET") posts.push({ url, method, body: opt && opt.body ? JSON.parse(opt.body) : null });
    const j = (v, code) => Promise.resolve({ ok: !code || code < 400, status: code || 200, json: () => Promise.resolve(v), text: () => Promise.resolve("") });
    if (url === "/api/schedules") return denyRead ? j(FORBID, 403) : j([{ id: "s1", name: "早报", task: "发早报", cron: "0 9 * * *", enabled: true }]);
    if (url.startsWith("/api/schedules/runs")) return denyRead ? j(FORBID, 403) : j([{ at: "2026-09-11T09:00:00Z", name: "早报", by: "定时", ms: 3000, result: "成功" }]);
    // 资料库带子目录之后接口带 ?dir=，回的也是「这一层」：面包屑 + 子文件夹 + 文件（文件带 path，
    // 因为下钻之后名字得是 "客户A/合同.md" 才取得到内容，显示时才截成 name）
    if (url === "/api/library" || url.startsWith("/api/library?")) {
      if (denyRead) return j(LIB_ERR, 500);
      const dir = decodeURIComponent((url.split("dir=")[1] || "").split("&")[0] || "");
      if (dir === "客户A") return j({
        dir: "客户A", crumbs: [{ name: "客户A", path: "客户A" }], dirs: [],
        files: [{ name: "合同.md", path: "客户A/合同.md", size: 1024, mtime: "2026-09-02T00:00:00Z" }],
        notes: [],
      });
      return j({
        dir: "", crumbs: [], dirs: [{ name: "客户A", path: "客户A", count: 1 }],
        files: [{ name: "手册.md", path: "手册.md", size: 2048, mtime: "2026-09-01T00:00:00Z" }],
        notes: [{ id: "n1", text: "老板喜欢短句", at: "2026-09-01T00:00:00Z" }],
      });
    }
    // 工作目录里的成果文件。分组和摆法这两块要靠它：三种类型（文档/表格/图片）、
    // 两个时间段（今天 / 很久以前），刚好能验出「按类型」和「按时间」分出来的堆对不对
    if (url === "/api/files") return j([
      { name: "设计稿.png", size: 30000, mtime: new Date().toISOString() },
      { name: "数据.csv", size: 2048, mtime: new Date().toISOString() },
      { name: "月报.md", size: 4096, mtime: "2026-01-05T00:00:00Z" },
    ]);
    // 「按任务看产出」的数据源。服务端把 transcript 里的 files 事件倒过来读了一遍：
    // 一组 = 一次对话，组里是那次对话真正写出来的文件；orphans 是工作目录里没人认领的那些
    if (url === "/api/library/outputs") {
      if (denyOut) return j({ error: "读不到任务产出" }, 500);
      return j({
        root: "abc12345", full: true, orphan_total: 2,
        tasks: [
          { id: "s_2", title: "做九月周报", project: "默认项目", lane: "office", dir: "任务_0916_周报", at: Date.parse("2026-09-16T10:00:00Z"),
            live: 1, files: [
              { name: "任务_0916_周报/九月周报.md", size: 4096, mtime: "2026-09-16T10:00:00Z", gone: false },
              { name: "任务_0916_周报/旧草稿.md", size: 0, mtime: "", gone: true },
            ] },
          { id: "s_1", title: "算一版预算表", project: "默认项目", at: Date.parse("2026-09-15T10:00:00Z"),
            live: 1, files: [{ name: "任务_0915_预算/预算.csv", size: 2048, mtime: "2026-09-15T10:00:00Z", gone: false }] },
          // 整组都没了的那种：一次视频任务拆出几百张帧图、分析完自己清掉。
          // 这一组默认应该整个不露面——留个只能点出「文件不存在」的空壳没有任何用处
          { id: "s_0", title: "抖音视频拆帧", project: "默认项目", at: Date.parse("2026-09-14T10:00:00Z"),
            live: 0, files: [
              { name: "任务_0914_拆帧/f_010.jpg", size: 0, mtime: "", gone: true },
              { name: "任务_0914_拆帧/f_020.jpg", size: 0, mtime: "", gone: true },
            ] },
        ],
        orphans: [
          { name: "随手拷进来的.png", size: 9000, mtime: "2026-09-10T00:00:00Z", gone: false },
          { name: "老版本.md", size: 100, mtime: "2026-09-09T00:00:00Z", gone: false },
        ],
      });
    }
    // 全库搜索：四种来源各一块，正文命中带行号
    if (url.startsWith("/api/library/search")) {
      const term = decodeURIComponent((url.split("q=")[1] || "").split("&")[0] || "");
      if (term === "谁都没提过的词") return j({ q: term, lib: [], ws: [], notes: [], tasks: [], scanned: 3, capped: false });
      return j({
        q: term, scanned: 42, capped: true,
        tasks: [{ id: "s_2", title: "做九月周报", at: Date.parse("2026-09-16T10:00:00Z"), by: "title",
          files: [{ name: "任务_0916_周报/九月周报.md", size: 4096, mtime: "2026-09-16T10:00:00Z", gone: false }] }],
        lib: [{ name: "手册.md", path: "手册.md", size: 2048, mtime: "2026-09-01T00:00:00Z", by: "text",
          lines: [{ line: 12, text: "这一段里写了周报的格式要求" }] }],
        ws: [{ name: "任务_0916_周报/九月周报.md", size: 4096, mtime: "2026-09-16T10:00:00Z", by: "both",
          lines: [{ line: 3, text: "九月周报正文第一行" }] }],
        notes: [{ id: "n1", text: "周报要短", at: "2026-09-01T00:00:00Z" }],
      });
    }
    // 预览一个工作区产出。HEAD 是预览出错后补问的那一下「到底是没了，还是读不出来」，
    // 它必须跟 GET 一个口径——两边不一致的话，测出来的就不是页面真实的判断
    if (url.startsWith("/api/library/preview/") || url.startsWith("/api/files/preview/")) {
      ovHits.push(url.split("?")[0]);
      return j(ovResp.body, ovResp.code);
    }
    if (url.startsWith("/api/files/view/")) {
      fileHits.push({ url: url.split("?")[0], method });
      return Promise.resolve({ ok: viewResp.code < 400, status: viewResp.code,
        json: () => Promise.resolve({}), text: () => Promise.resolve(viewResp.body) });
    }
    if (url === "/api/library/upload") return writeOk ? j(uploadResp, uploadResp.ok ? 200 : 403) : j(LIB_DENY, 403);
    if (url.startsWith("/api/library/folder")) return writeOk ? j({ ok: true }) : j(LIB_DENY, 403);
    if (url.startsWith("/api/library/note")) return writeOk ? j({ ok: true }) : j(LIB_DENY, 403);
    if (url.startsWith("/api/library/file/")) {
      fileHits.push({ url: url.split("?")[0], method });
      return writeOk ? j({ ok: true }) : j(LIB_DENY, 403);
    }
    return j({ ok: true });
  };

  const page = document.getElementById("assist-page");
  const html = () => page.innerHTML;

  // ① 自动化：接口 403，页面得说人话，不能白屏
  window.settingsCache = { platform_owner: false };
  denyRead = true;
  window.automState.tab = "tasks";
  await renderAutomPage();
  ok("自动化：403 没把整页炸空（以前 list.filter 直接 TypeError）", html().length > 0, html().slice(0, 80));
  ok("自动化：把服务端那句话原样摆出来", html().includes("归平台管理员管"), html().slice(0, 200));
  ok("自动化：顺带说清为什么（跑在服务器上、花服务器的额度）", html().includes("你自己要跑的活"));
  ok("自动化：不再画那排点了就 403 的按钮", !page.querySelector("#at-new") && !page.querySelector("#at-tpl"));

  window.automState.tab = "runs";
  await renderAutomPage();
  ok("运行记录：403 一样不白屏", html().includes("运行记录") && html().includes("归平台管理员管"), html().slice(0, 120));

  // ② 反向对照：平台管理员那一页，一样不少
  window.settingsCache = { platform_owner: true };
  denyRead = false;
  window.automState.tab = "tasks";
  await renderAutomPage();
  ok("反向对照：平台管理员看得到任务行", !!page.querySelector(".at-row"));
  ok("反向对照：「＋ 添加自动化」在", !!page.querySelector("#at-new"));
  window.automState.tab = "runs";
  await renderAutomPage();
  ok("反向对照：运行记录画得出表格", !!page.querySelector(".at-runs"));
  window.automState.tab = "tasks";

  // ③ 侧栏：会 403 的入口不摆在那儿
  const shown = (v) => document.querySelector('.side-nav [data-view="' + v + '"]').style.display !== "none";
  window.settingsCache = { platform_owner: false };
  syncNavByRole();
  ok("侧栏：成员看不到「自动化」", !shown("autom"));
  ok("侧栏：成员看不到「评测」（真金白银调模型）", !shown("eval"));
  ok("侧栏：成员看不到「执行追踪」（一本账记着整台服务器上每个人的提示词原文）", !shown("trace"));
  ok("侧栏：「资料库」照留（一人一份，进去看见的是他自己那份）", shown("lib"));
  ok("侧栏：「专家」「参考模板库」一个没动", shown("hub") && shown("prompts"));
  window.settingsCache = { platform_owner: true };
  syncNavByRole();
  ok("反向对照：平台管理员六个入口一个不少", shown("autom") && shown("eval") && shown("trace") && shown("lib") && shown("hub") && shown("prompts"));

  // ④ 资料库：一人一份，所以这一页对谁都是「我的文档」
  // 以前普通成员看到的是「共享资料 · 只读」，里面还摆着别人传的合同——
  // 那正是「资料库怎么数据还是通用的吗，跟账号也没关系吗」那句话的形状。
  // 后端的根已经按人分开（server.js 的 libraryRootOf），前端再按职位画两副面孔就是在骗人：
  // 他看见的本来就是自己那份，写也写得进去。
  window.settingsCache = { platform_owner: false };
  window.libState = { q: "", pick: null };
  await renderLibPage();
  ok("资料库：普通成员看得到自己那份", html().includes("手册.md"), html().slice(0, 200));
  ok("★资料库：「＋ 上传」对普通成员照画★", !!page.querySelector("#lb-up"));
  ok("资料库：「新建文件夹」也在", !!page.querySelector("#lb-mkdir"));
  ok("★资料库：抬头写「我的文档」，不再是「共享资料 · 只读」★",
     html().includes("我的文档") && !html().includes("共享资料") && !html().includes("只读"), html().slice(0, 200));
  ok("资料库：文件夹后面的删除也在（删的是他自己那一份）", !!page.querySelector("[data-del-dir]"));
  ok("反向对照：空库的文案不再说「归平台管理员放」",
     !html().includes("这一块归平台管理员放"), html().slice(0, 200));

  // 真读不成的时候（服务器出错、盘挂了），别说「还没有参考资料」——那是句瞎话，
  // 用户会当成自己没传过东西，而真相是这一趟根本没读成
  denyRead = true;
  window.libState = { q: "", pick: null };
  await renderLibPage();
  ok("资料库：读不成就把服务端的原话抬出来，不装成「还没有参考资料」",
     html().includes(LIB_ERR.error) && !html().includes("还没有参考资料"), html().slice(0, 200));
  denyRead = false;
  await renderLibPage(); // 错误页把 #lb-prev 也一起收了，下面还要用，先画回来

  // ⑤ 灵感笔记：同理，输入框、「保存」、每条的「删除」对谁都在
  window.settingsCache = { platform_owner: false };
  window.libState.pick = { src: "notes", name: "" };
  await renderLibPreview(page.querySelector("#lb-prev"), { notes: [{ id: "n1", text: "老板喜欢短句", at: "2026-09-01T00:00:00Z" }] });
  ok("★灵感笔记：普通成员也有输入框和「保存」★",
     !!page.querySelector("#lb-note") && !!page.querySelector("#lb-note-save"));
  ok("灵感笔记：每条后面的「删除」也在", !!page.querySelector("a[data-nid]"));
  ok("灵感笔记：笔记内容照样看得到", html().includes("老板喜欢短句"));
  ok("灵感笔记：不再把人支开去记忆页（这儿本来就是他自己的地方）", !page.querySelector("#lb-to-mem"));
  window.settingsCache = { platform_owner: true };
  await renderLibPreview(page.querySelector("#lb-prev"), { notes: [{ id: "n1", text: "老板喜欢短句", at: "2026-09-01T00:00:00Z" }] });
  ok("反向对照：平台管理员那一页一样不少",
     !!page.querySelector("#lb-note") && !!page.querySelector("#lb-note-save") && !!page.querySelector("a[data-nid]"));
  window.settingsCache = { platform_owner: false };
  window.libState = { q: "", pick: null };
  await renderLibPage();

  // ⑤b 子目录：资料库以前是一层平铺，
  // 现在带 ?dir= 逐层进，进去之后文件名得是 "客户A/合同.md"（带前缀才取得到内容），显示的才是 "合同.md"
  window.libState = { q: "", pick: null, dir: "" };
  await renderLibPage();
  const dirRow = page.querySelector(".lib-it.lib-dir");
  ok("子目录：根目录列得出文件夹，还报了条数", !!dirRow && dirRow.dataset.dir === "客户A" && html().includes("1 项"), html().slice(0, 300));
  ok("子目录：文件夹排在文件前面（先挑地方再挑文件）",
     html().indexOf("客户A") < html().indexOf("手册.md"));
  ok("根目录的面包屑只有「资料库」自己一截", page.querySelectorAll(".lib-crumbs a").length === 1);
  dirRow.click();
  await new Promise((r) => setTimeout(r, 0));
  ok("子目录：点进去之后 libState.dir 跟着走", window.libState.dir === "客户A", String(window.libState.dir));
  ok("子目录：里面的文件显示成「合同.md」而不是全路径",
     !!page.querySelector('.lib-it[data-name="客户A/合同.md"]')
     && page.querySelector('.lib-it[data-name="客户A/合同.md"]').querySelector(".nm").textContent.trim() === "合同.md",
     html().slice(0, 400));
  ok("子目录：面包屑多出一截，点得回根", page.querySelectorAll(".lib-crumbs a").length === 2
     && page.querySelectorAll(".lib-crumbs a")[0].dataset.dir === "");
  ok("子目录：「新建文件夹」这个入口在（管理员才有）", !!page.querySelector("#lb-mkdir"));
  page.querySelectorAll(".lib-crumbs a")[0].click();
  await new Promise((r) => setTimeout(r, 0));
  ok("反向对照：点面包屑第一截回根，又看得见「手册.md」和「客户A」",
     window.libState.dir === "" && html().includes("手册.md") && html().includes("客户A"), String(window.libState.dir));

  // ⑤c 按任务看产出。
  // 人记一份文件是按「上周让它写的那份周报」记的，不是按 任务_0916_周报/九月周报.md 记的。
  // 数据不是新攒的：服务端把每回合那条 files 事件（changed = 认过主的文件）倒过来读了一遍。
  window.libState = { q: "", pick: null, dir: "", view: "dir", kind: "all" };
  window.libTaskShut = new Set();
  await renderLibPage();
  ok("反向对照：文件夹视图里没有任务分组（这是「东西放在哪」，不是「哪次做出来的」）",
     !page.querySelector(".lib-task"), html().slice(0, 200));
  page.querySelector('.lib-tab[data-view="task"]').click();
  await new Promise((r) => setTimeout(r, 0));
  ok("按任务：切过去之后按次分组，一次对话一组", page.querySelectorAll(".lib-task").length === 2, html().slice(0, 300));
  ok("按任务：组名是那次任务的标题，不是文件夹名", html().includes("做九月周报") && html().includes("算一版预算表"));
  ok("按任务：这个选择记在 localStorage 里（有人只用文件夹、有人只用按任务，不该每次回默认值）",
     localStorage.getItem("owb_lib_view") === "task", String(localStorage.getItem("owb_lib_view")));
  const sub = page.querySelector('.lib-it.lib-sub[data-name="任务_0916_周报/九月周报.md"]');
  ok("按任务：组里的文件只显示文件名——目录名已经在组标题上说过一遍了",
     !!sub && sub.querySelector(".nm").textContent.trim() === "九月周报.md", sub ? sub.outerHTML.slice(0, 200) : "没有这一行");
  // 已经不在磁盘上的那些：默认不摆出来。
  // 摆出来的每一行都是一句「这儿有个文件」，点开却说没有——那一趟点击是纯亏的。
  // 而这种行往往成百上千：一次视频任务拆出几百张帧图，分析完自己清掉了。
  ok("按任务：已经不在工作目录里的产出默认不摆出来——点开只会告诉你文件不存在，那一行是白给的",
     !page.querySelector(".lib-it.lib-sub.gone") && !html().includes("旧草稿.md"), html().slice(0, 400));
  ok("按任务：整组都没了的任务，整组不露面（留个空壳比不留更让人困惑）",
     !html().includes("抖音视频拆帧") && !html().includes("f_010.jpg"), html().slice(0, 400));
  ok("反向对照：同一组里还在的那份照旧在（不是把整组一起吃掉了）",
     !!page.querySelector('.lib-it.lib-sub[data-name="任务_0916_周报/九月周报.md"]') && html().includes("做九月周报"));
  // 不声不响地滤掉是不行的——用户会以为这一页漏了东西。说清有多少、一点就能看
  ok("按任务：底下说清还有几个没了，不是悄悄吞掉",
     html().includes("另有 3 个") && !!page.querySelector("[data-gone-toggle]"), html().slice(-500));
  page.querySelector("[data-gone-toggle]").onclick({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  ok("按任务：点「还是显示」之后，没了的那些划掉并写「已不在」露出来",
     !!page.querySelector(".lib-it.lib-sub.gone") && html().includes("已不在") && html().includes("旧草稿.md"),
     html().slice(0, 400));
  ok("按任务：这时整组都没了的那一组也回来了",
     html().includes("抖音视频拆帧") && html().includes("f_010.jpg"));
  ok("按任务：显示/隐藏记在 localStorage 里，不用每次回来重按一遍",
     localStorage.getItem("owb_lib_gone") === "on", String(localStorage.getItem("owb_lib_gone")));
  page.querySelector("[data-gone-toggle]").onclick({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  ok("反向对照：再点一下又收回去，而且 localStorage 跟着回 off",
     !page.querySelector(".lib-it.lib-sub.gone") && !html().includes("抖音视频拆帧")
     && localStorage.getItem("owb_lib_gone") === "off", String(localStorage.getItem("owb_lib_gone")));
  ok("按任务：没人认领的文件单独列成「未归属」，不然这一页就是半份清单、用户会以为文件丢了",
     html().includes("未归属") && html().includes("随手拷进来的.png"));

  // 折叠 / 回到那次对话：产出和它的来历始终连着，这是这一页跟一张文件表格最要紧的区别
  const head = page.querySelector('.lib-task-h[data-task="s_2"]');
  head.onclick({ target: head });
  await new Promise((r) => setTimeout(r, 0));
  ok("按任务：点组标题收起来，组里的文件跟着收",
     !page.querySelector('.lib-it.lib-sub[data-name="任务_0916_周报/九月周报.md"]') && html().includes("做九月周报"));
  const head2 = page.querySelector('.lib-task-h[data-task="s_2"]');
  head2.onclick({ target: head2 });
  await new Promise((r) => setTimeout(r, 0));
  ok("反向对照：再点一下又展开", !!page.querySelector('.lib-it.lib-sub[data-name="任务_0916_周报/九月周报.md"]'));
  window.opened = [];
  const go = page.querySelector('.lib-task-h[data-task="s_2"] a[data-open]');
  go.onclick({ preventDefault() {}, stopPropagation() {}, target: go });
  ok("按任务：组标题右边那个入口跳回产生这些文件的那次对话", window.opened.join("|") === "s_2", window.opened.join("|"));
  ok("反向对照：点它不该顺手把组也收了（事件得在标题那层拦住）",
     !!page.querySelector('.lib-it.lib-sub[data-name="任务_0916_周报/九月周报.md"]'));

  // 类型筛选：想不起名字，但一定记得它是张表还是份文档
  page.querySelector('.lib-kind[data-kind="sheet"]').click();
  await new Promise((r) => setTimeout(r, 0));
  ok("类型筛选：挑「表格」只剩 csv，md 那组整个不露面（一组文件全被筛掉就不该留个空壳）",
     html().includes("预算.csv") && !html().includes("九月周报.md") && !html().includes("做九月周报"), html().slice(0, 300));
  page.querySelector('.lib-kind[data-kind="all"]').click();
  await new Promise((r) => setTimeout(r, 0));
  ok("反向对照：切回「全部」两组都回来", html().includes("预算.csv") && html().includes("九月周报.md"));

  // 产出索引读不成的时候，说读不成——别画一句「还没有任务产出过文件」，那会让人以为自己白跑了
  denyOut = true;
  await renderLibPage();
  ok("按任务：索引读不成就照实说，不装成「还没产出过」",
     html().includes("读不到任务产出") && !html().includes("还没有任务产出过文件"), html().slice(0, 240));
  denyOut = false;

  // ⑤c-2 「点了没反应」的那三种长相。
  // 三种文件走三条不同的路，以前各坏各的、还都不吭声：图裂成一个碎图标（<img> 出错浏览器不通知），
  // HTML 把服务端那句「文件不存在」当网页渲染成一片空白（fetch 没看 r.ok），文本只弹「读取失败」。
  // 真正的原因永远是同一个：名字还在，东西不在——那就该把这句话说出来。
  ok("体积未知写「—」，不撞着下限编出个「1 KB」（那是替一个不知道的数字编了个具体值）",
     libSize(0) === "—" && libSize(2048) === "2 KB", libSize(0) + " / " + libSize(2048));

  window.libState = { q: "", pick: null, dir: "", view: "task", kind: "all" };
  await renderLibPage(); // 先灌上 libOutCache，「出自任务」那条才反查得到
  const previewOf = async (name) => {
    window.libState.pick = { src: "ws", name }; // ws = 工作区产出，这一栏才有「出自任务」
    const prev = page.querySelector("#lb-prev");
    await renderLibPreview(prev, {});
    return prev;
  };

  viewResp = { code: 404, body: "文件不存在" };
  let pv = await previewOf("任务_0916_周报/九月周报.md");
  ok("预览·md：东西没了就直说「已经不在工作目录里」", pv.innerHTML.includes("已经不在工作目录里"), pv.innerHTML.slice(-300));
  ok("预览·md：不把服务端那句错误当正文渲染出来", !pv.innerHTML.includes("文件不存在"), pv.innerHTML.slice(-300));
  ok("预览·md：给得出下一步——回到那次对话让助理再做一份",
     pv.innerHTML.includes("出自任务") && pv.innerHTML.includes("再做一份"), pv.innerHTML.slice(-300));

  pv = await previewOf("任务_0916_周报/页面.html");
  ok("预览·html：没了也说没了，不再画成一片空白", pv.innerHTML.includes("已经不在工作目录里") && !pv.querySelector("iframe"),
     pv.innerHTML.slice(-260));

  pv = await previewOf("任务_0916_周报/场景图.png");
  const brokenImg = pv.querySelector("#lb-img");
  ok("预览·图片：先摆一个 <img>（能画就画，不该为了保险先问一趟）", !!brokenImg);
  await brokenImg.onerror(); // 真浏览器里 404 的 src 就是这么触发的，这里直接调，免得等网络
  ok("预览·图片：裂图不再是个碎图标，而是说清「已经不在」", pv.innerHTML.includes("已经不在工作目录里"), pv.innerHTML.slice(-260));

  // 阴性对照：东西还在的时候，三种文件都得真画出来，一个都不许误报成「没了」
  viewResp = { code: 200, body: "# 九月周报\\n正文两行" };
  pv = await previewOf("任务_0916_周报/九月周报.md");
  ok("反向对照·md：文件在就渲染正文，不误报「已经不在」",
     pv.innerHTML.includes("正文两行") && !pv.innerHTML.includes("已经不在工作目录里"), pv.innerHTML.slice(-260));

  viewResp = { code: 200, body: "<!doctype html><h1>一张真网页</h1>" };
  pv = await previewOf("任务_0916_周报/页面.html");
  const fr = pv.querySelector("iframe");
  ok("反向对照·html：文件在就真渲染成网页，不是把源码当文本摆出来",
     !!fr && /^blob:/.test(fr.getAttribute("src") || "") && !pv.innerHTML.includes("&lt;h1&gt;"), pv.innerHTML.slice(-260));
  ok("预览·html：iframe 上着 sandbox——资料是外来的，不能让它碰应用本身",
     fr.getAttribute("sandbox") === "allow-scripts", String(fr.getAttribute("sandbox")));

  pv = await previewOf("任务_0916_周报/场景图.png");
  await pv.querySelector("#lb-img").onerror();
  ok("反向对照·图片：东西明明还在，那就是文件坏了，不能说成「已经不在」",
     pv.innerHTML.includes("文件可能是坏的") && !pv.innerHTML.includes("已经不在工作目录里"), pv.innerHTML.slice(-260));

  // 读不出来和没了是两回事，混为一谈会把人支去找一个其实还在的文件
  viewResp = { code: 500, body: "boom" };
  pv = await previewOf("任务_0916_周报/九月周报.md");
  ok("预览：服务端出错说的是「预览不了：HTTP 500」，不能说成「文件已经不在」",
     pv.innerHTML.includes("HTTP 500") && !pv.innerHTML.includes("已经不在工作目录里"), pv.innerHTML.slice(-260));
  viewResp = { code: 200, body: "# 九月周报" };

  // ⑤c-3 Office 三件套 + zip。
  // 这几样是一包 XML 压缩档，浏览器自己打不开。对话页那边早就拆得开了，资料库这边却压根
  // 没有这条路，一律掉进最后那个 <pre>——满屏 PK… 的二进制乱码。
  const libPreviewOf = async (name) => {
    window.libState.pick = { src: "lib", name };
    const prev = page.querySelector("#lb-prev");
    await renderLibPreview(prev, { notes: [] });
    return prev;
  };

  ovHits.length = 0;
  ovResp = { code: 200, body: { total: 2, truncated: false, slides: [
    { n: 1, title: "三季度复盘", lines: [{ lvl: 0, s: "收入同比 +18%" }], notes: "这页别念稿" },
    { n: 2, title: "下季度打法", lines: [{ lvl: 1, s: "先守住存量客户" }], notes: "" },
  ] } };
  pv = await libPreviewOf("汇报/三季度.pptx");
  ok("预览·pptx：资料库的文件要问资料库那个根，不是工作目录那个（问错了永远 404）",
     ovHits.length === 1 && ovHits[0].startsWith("/api/library/preview/"), ovHits.join("|") || "一次都没问");
  ok("预览·pptx：真画成一页一页的幻灯片，不是一坨二进制",
     pv.querySelectorAll(".ov-slide").length === 2 && !pv.querySelector("pre.raw"), pv.innerHTML.slice(-300));
  ok("预览·pptx：标题、正文、备注都摆出来了",
     pv.innerHTML.includes("三季度复盘") && pv.innerHTML.includes("收入同比 +18%") && pv.innerHTML.includes("这页别念稿"),
     pv.innerHTML.slice(-400));

  // 反向对照：同一段代码在工作区那一栏要换另一个根
  ovHits.length = 0;
  await previewOf("任务_0916_周报/三季度.pptx");
  ok("反向对照·pptx：工作区的产出问的是 /api/files/preview/",
     ovHits.length === 1 && ovHits[0].startsWith("/api/files/preview/"), ovHits.join("|") || "一次都没问");

  ovResp = { code: 200, body: { sheets: [
    { name: "预算", rows: [["项目", "金额"], ["差旅", "1200"]], truncated: false, totalRows: 2, totalCols: 2 },
    { name: "人员", rows: [["姓名"], ["小李"]], truncated: false, totalRows: 2, totalCols: 1 },
  ] } };
  pv = await libPreviewOf("财务/预算表.xlsx");
  const tabs = [...pv.querySelectorAll(".ov-tab")];
  ok("预览·xlsx：几张工作表就几个标签", tabs.length === 2 && tabs[0].textContent === "预算", pv.innerHTML.slice(-300));
  ok("预览·xlsx：先只显示第一张", pv.querySelector('.ov-pane[data-pane="0"]').hidden === false
     && pv.querySelector('.ov-pane[data-pane="1"]').hidden === true);
  tabs[1].onclick();
  ok("预览·xlsx：标签点得动——接不上事件的话，第二张表就永远看不见",
     pv.querySelector('.ov-pane[data-pane="1"]').hidden === false
     && pv.querySelector('.ov-pane[data-pane="0"]').hidden === true
     && tabs[1].classList.contains("on"), pv.innerHTML.slice(-300));

  ovResp = { code: 200, body: { blocks: [
    { t: "h", lvl: 1, runs: [{ s: "九月周报" }] },
    { t: "p", runs: [{ s: "本周做完了三件事" }] },
  ] } };
  pv = await libPreviewOf("周报/九月.docx");
  ok("预览·docx：标题是标题，正文是正文",
     !!pv.querySelector(".ov-h") && pv.innerHTML.includes("本周做完了三件事"), pv.innerHTML.slice(-300));

  // 出错的两种，一样不许混为一谈
  ovResp = { code: 404, body: { error: "文件不存在" } };
  pv = await libPreviewOf("周报/九月.docx");
  ok("预览·docx：404 说的是「已经不在」，不是「预览不了」", pv.innerHTML.includes("已经不在"), pv.innerHTML.slice(-260));
  ovResp = { code: 500, body: { error: "这个文件损坏了，解不开" } };
  pv = await libPreviewOf("周报/九月.docx");
  ok("预览·docx：拆不开就把服务端那句原话摆出来，别说成文件没了",
     pv.innerHTML.includes("这个文件损坏了") && !pv.innerHTML.includes("已经不在"), pv.innerHTML.slice(-260));
  ovResp = { code: 200, body: {} };

  // Office 97-2003：是格式的事，不是文件坏了。以前它掉进兜底的 <pre>，
  // 用户看到的是一屏二进制，还得自己猜「是不是文件坏了」
  viewResp = { code: 200, body: "" }; // alive() 那一下 HEAD 要回 ok
  pv = await libPreviewOf("旧档/合同.doc");
  ok("预览·doc：老格式说清是格式的事，并给出一条走得通的路（另存为 .docx）",
     pv.innerHTML.includes("97-2003") && pv.innerHTML.includes(".docx") && !pv.querySelector("pre.raw"), pv.innerHTML.slice(-320));
  pv = await libPreviewOf("旧档/报价.xls");
  ok("预览·xls：同一条路，扩展名跟着换成 .xlsx（写死成 .docx 就是在瞎指路）",
     pv.innerHTML.includes(".xlsx") && !pv.innerHTML.includes(".docx"), pv.innerHTML.slice(-320));

  // CSV：跟对话页共用 csvHtml。以前资料库另有一个只认逗号的迷你版，
  // 字段里带逗号（"甲,乙"）会被拆成两格，.tsv 更是整列糊在一起
  viewResp = { code: 200, body: '名称,备注\\n"甲,乙",两个字一格\\n' };
  pv = await previewOf("任务_0916_周报/名单.csv");
  let cells = [...pv.querySelectorAll(".ov-table tr")].map((tr) => [...tr.children].map((td) => td.textContent));
  ok("预览·csv：引号里的逗号是内容不是分隔符（拆成两格就是把表拆散架了）",
     cells.length === 2 && cells[1].length === 2 && cells[1][0] === "甲,乙", JSON.stringify(cells));
  viewResp = { code: 200, body: "姓名\\t部门\\n小李\\t财务\\n" };
  pv = await previewOf("任务_0916_周报/名单.tsv");
  cells = [...pv.querySelectorAll(".ov-table tr")].map((tr) => [...tr.children].map((td) => td.textContent));
  ok("预览·tsv：制表符分隔的也认（只按逗号拆的话整行糊成一格）",
     cells.length === 2 && cells[1].length === 2 && cells[1][1] === "财务", JSON.stringify(cells));
  viewResp = { code: 200, body: "# 九月周报" };
  window.libState.pick = null;

  // ⑤c-4 音视频。一个 1 MB 的 note_audio.mp3
  // 一直显示「文件太大，预览不动」。两头各坏一半：这一页压根没有音频这条路，mp3
  // 被当字符串读回来、再撞上 400KB 那道闸；服务端那边 /api/library/file/ 又一律 res.download，
  // 带着附件头的响应 <audio> 压根不渲染。
  fileHits.length = 0;
  pv = await libPreviewOf("素材/note_audio.mp3");
  const au = pv.querySelector("#lb-av");
  ok("预览·mp3：画的是一个按得下去的播放器，不再是「文件太大，预览不动」",
     !!au && au.tagName === "AUDIO" && !pv.innerHTML.includes("文件太大"), pv.innerHTML.slice(-300));
  ok("预览·mp3：播放器指着资料库那个根，不是工作目录（问错根永远 404）",
     String(au.getAttribute("src")).startsWith("/api/library/file/"), String(au.getAttribute("src")));
  ok("预览·mp3：顺利这条路上一个字节都不额外拉——整首歌 fetch 回来再丢掉是白花流量",
     fileHits.length === 0, JSON.stringify(fileHits));
  const dl = pv.querySelector("a[download]");
  ok("预览·mp3：「下载」自己带着 ?dl=1——内联发了之后，光靠 <a download> 一个属性扑不掉所有情况",
     !!dl && String(dl.getAttribute("href")).endsWith("?dl=1"), dl ? String(dl.getAttribute("href")) : "没有下载链接");

  pv = await libPreviewOf("素材/片头.mp4");
  ok("预览·mp4：视频走 <video>，不是塞进 <audio> 里只剩声音",
     String((pv.querySelector("#lb-av") || {}).tagName) === "VIDEO", pv.innerHTML.slice(-260));

  // 放不动和没了是两回事：一个该去下载，一个该回对话里重做
  viewResp = { code: 200, body: "" };
  pv = await previewOf("任务_0916_周报/旁白.mp3");
  await pv.querySelector("#lb-av").onerror();
  ok("预览·mp3：文件还在却放不动，说的是编码不支持，并指一条走得通的路",
     pv.innerHTML.includes("编码不支持") && !pv.innerHTML.includes("已经不在工作目录里"), pv.innerHTML.slice(-300));
  viewResp = { code: 404, body: "文件不存在" };
  pv = await previewOf("任务_0916_周报/旁白.mp3");
  await pv.querySelector("#lb-av").onerror();
  ok("预览·mp3：东西真没了还是那句「已经不在」，不赖到编码头上",
     pv.innerHTML.includes("已经不在工作目录里") && !pv.innerHTML.includes("编码不支持"), pv.innerHTML.slice(-300));

  // ⑤c-5 后缀就摆明不是文字的（.psd / .sqlite / .heic…）：别先花一趟把它当文本拉回来
  viewResp = { code: 200, body: "" };
  fileHits.length = 0;
  pv = await previewOf("任务_0916_周报/主视觉.psd");
  ok("预览·psd：直说它里面不是文字，并给一条用对应程序打开的路",
     pv.innerHTML.includes("二进制文件") && !pv.innerHTML.includes("文件太大"), pv.innerHTML.slice(-300));
  ok("预览·psd：只问了一句「还在不在」，没把几百兆当字符串读回来",
     fileHits.length === 1 && fileHits[0].method === "HEAD", JSON.stringify(fileHits));
  viewResp = { code: 404, body: "文件不存在" };
  pv = await previewOf("任务_0916_周报/主视觉.psd");
  ok("预览·psd：东西没了先说没了，「二进制」是次要的",
     pv.innerHTML.includes("已经不在工作目录里"), pv.innerHTML.slice(-260));

  // 认不出的后缀只能读回来看内容：NUL 字节就是二进制，摆一屏乱码不如直说
  viewResp = { code: 200, body: "PK\u0003\u0004\u0000\u0000乱码" };
  pv = await previewOf("任务_0916_周报/导出件");
  ok("预览·没后缀：读回来发现是二进制，也直说，不摆一屏乱码",
     pv.innerHTML.includes("二进制文件"), pv.innerHTML.slice(-300));
  viewResp = { code: 200, body: "# 九月周报" };

  // ⑤c-6 「所在位置」「复制文件」。
  // 以前只有一个「下载」——
  // 想把它发给同事，得先下一份、再去下载目录里翻。
  window.settingsCache = { platform_owner: false };
  pv = await libPreviewOf("素材/note_audio.mp3");
  ok("所在位置 / 复制文件：多人服务器上的成员看不到（开的是服务器那台机器，对他没意义）",
     !pv.querySelector("#lb-reveal") && !pv.querySelector("#lb-copy"), pv.innerHTML.slice(0, 400));
  window.settingsCache = { platform_owner: true };
  pv = await libPreviewOf("素材/note_audio.mp3");
  ok("反向对照：单机桌面版上两颗按钮都在",
     !!pv.querySelector("#lb-reveal") && !!pv.querySelector("#lb-copy"), pv.innerHTML.slice(0, 400));

  posts.length = 0;
  pv.querySelector("#lb-reveal").onclick({ preventDefault() {}, stopPropagation() {} });
  ok("所在位置：资料库的文件得带上 src=lib——不带的话服务端按工作目录去找，必然 404",
     posts.length === 1 && posts[0].url === "/api/files/reveal"
     && posts[0].body.src === "lib" && posts[0].body.name === "素材/note_audio.mp3", JSON.stringify(posts));

  posts.length = 0;
  window.toasts = [];
  await pv.querySelector("#lb-copy").onclick({ preventDefault() {}, stopPropagation() {} });
  ok("复制文件：打的是 /api/files/copy，同样带 src=lib",
     posts.length === 1 && posts[0].url === "/api/files/copy" && posts[0].body.src === "lib", JSON.stringify(posts));
  ok("复制文件：成了要说一句——剪贴板看不见摸不着，不说就是「点了没反应」",
     window.toasts.join("|").includes("已复制文件"), window.toasts.join("|") || "一句话都没说");

  pv = await previewOf("任务_0916_周报/九月周报.md");
  posts.length = 0;
  pv.querySelector("#lb-reveal").onclick({ preventDefault() {}, stopPropagation() {} });
  ok("反向对照：工作区产出不带 src=lib（带了就跑去资料库里找一个不存在的同名文件）",
     posts.length === 1 && posts[0].body.src === "", JSON.stringify(posts));

  // ⑤c-7 「出自任务」认的是文件夹，不是「谁最近动过它」。
  // 任务_0915_对话_2/BGM_纯配乐.mp3
  // 被标成了另一条 9-17 任务的产出。根子在服务端记账：认文件归属的那张表是内存里的，
  // 重启就空了，于是后一条任务只要碰一下这个文件，它就进了那条任务的 changed。
  // 历史数据已经这么存着了，所以在读的一端把文件夹当硬证据。
  const OUT0 = window.libOutCache;
  const mkTask = (id, title, dir, files) => ({
    id, title, dir, at: Date.parse("2026-09-17T10:00:00Z"),
    files: files.map((n) => ({ name: n, size: 1, mtime: "2026-09-17T10:00:00Z", gone: false })),
  });
  // 倒序：新的在前。老代码「第一个把它列进 files 的任务就是主人」，命中的正是这一条
  window.libOutCache = { tasks: [
    mkTask("s_new", "开源项目推广小红书图文 9-17", "任务_0917_小红书",
           ["任务_0915_对话_2/BGM_纯配乐.mp3", "任务_0801_早没了/稿.md", "随手拷进来的.png"]),
    mkTask("s_old", "配一段纯音乐", "任务_0915_对话_2", ["任务_0915_对话_2/BGM_纯配乐.mp3"]),
  ] };
  const owned = (n) => libTaskOf("ws", n);
  ok("出自任务：文件躺在谁的成果文件夹里就是谁的，后来动过它的那条任务抢不走",
     (owned("任务_0915_对话_2/BGM_纯配乐.mp3") || {}).id === "s_old",
     JSON.stringify(owned("任务_0915_对话_2/BGM_纯配乐.mp3") || null));
  ok("出自任务：文件夹看着是别的任务的、又不在手头这批里，就交白卷——猜出来的那个必错",
     owned("任务_0801_早没了/稿.md") === null, JSON.stringify(owned("任务_0801_早没了/稿.md")));
  ok("出自任务：根目录下的文件没文件夹可依，照旧按「谁产出过」反查，别一起误伤",
     (owned("随手拷进来的.png") || {}).id === "s_new", JSON.stringify(owned("随手拷进来的.png") || null));
  ok("出自任务：资料库那一栏是人手动传的，本来就没有任务可言",
     libTaskOf("lib", "任务_0917_小红书/x.md") === null);
  window.libOutCache = OUT0;

  // ⑤d 搜索。
  // 以前那个框只把**当前这一层已经加载出来的**文件名过滤一遍——东西在隔壁文件夹里就搜不到，
  // 正文里写了什么更无从谈起。那不叫搜索，叫筛选。
  window.libState = { q: "", pick: null, dir: "", view: "dir", kind: "all" };
  await renderLibPage();
  page.querySelector("#lb-q").value = "周报";
  window.libState.q = "周报";
  await renderLibPage();
  ok("搜索：四种来源分块列，每块写明它是从哪儿搜出来的",
     html().includes("任务") && html().includes("资料库") && html().includes("本地产物") && html().includes("灵感笔记"), html().slice(0, 300));
  const listHtml = () => (page.querySelector(".lib-list") || { innerHTML: "(没有 .lib-list)" }).innerHTML;
  // 断言走 textContent 不走 innerHTML：命中的词被 <mark> 包起来了，拿原始 HTML 做 includes 永远对不上
  const listText = () => (page.querySelector(".lib-list") || { textContent: "" }).textContent;
  ok("搜索：正文命中给出行号和那一行，一眼判断是不是要找的那份",
     !!page.querySelector(".lib-hits em") && page.querySelector(".lib-hits em").textContent.trim() === "12"
     && listText().includes("这一段里写了周报的格式要求"), listHtml().slice(0, 900));
  ok("搜索：命中的那几个字标出来，不用自己在一行字里再找一遍", !!page.querySelector(".lib-hits mark"));
  // :not(.lib-sub)：同一个文件在「任务」那一块里也有一行，那一行本来就只显示文件名、不带目录小字，
  // 不排掉的话选到的是它，这条断言就测不到「本地产物」那一块
  const wsRow = page.querySelector('.lib-it:not(.lib-sub)[data-src="ws"][data-name="任务_0916_周报/九月周报.md"]');
  ok("搜索：工作区那条只在名字列放文件名，目录挂在后面的小字里（不切开的话目录会出现两遍）",
     !!wsRow && wsRow.querySelector(".nm").firstChild.textContent.indexOf("任务_0916_周报") < 0
     && !!wsRow.querySelector(".pth") && wsRow.querySelector(".pth").textContent === "任务_0916_周报",
     wsRow ? wsRow.outerHTML.slice(0, 260) : "没有这一行");
  ok("搜索：正文没翻完就说没翻完，还报了翻过几个——半截清单装成全的最坑人",
     !!page.querySelector(".lib-capped") && html().includes("42"), html().slice(-300));
  window.libState.q = "谁都没提过的词";
  await renderLibPage();
  ok("反向对照：真没搜到就说没搜到，并交代翻过哪些地方",
     html().includes("没搜到") && html().includes("谁都没提过的词") && !page.querySelector(".lib-capped"), html().slice(0, 300));

  // ⑤e 「出自任务」：从文件夹里随手点开一个文件，也要说得出它是哪次做的
  window.libState = { q: "", pick: null, dir: "", view: "dir", kind: "all" };
  await renderLibPage(); // 先把产出索引灌进 libOutCache
  window.libState.pick = { src: "ws", name: "任务_0916_周报/九月周报.md" };
  await renderLibPreview(page.querySelector("#lb-prev"), { notes: [] });
  ok("预览：工作区产出顶上挂一条「出自任务」，点得回那次对话",
     !!page.querySelector(".lib-from") && html().includes("出自任务") && html().includes("做九月周报"), html().slice(0, 400));
  window.opened = [];
  const back = page.querySelector(".lib-from a[data-open]");
  back.onclick({ preventDefault() {}, stopPropagation() {}, target: back });
  ok("预览：这条链接在正文渲染完之后还活着（上面几行 outerHTML 会把节点整个换掉）",
     window.opened.join("|") === "s_2", window.opened.join("|"));
  window.libState.pick = { src: "lib", name: "手册.md" };
  await renderLibPreview(page.querySelector("#lb-prev"), { notes: [] });
  ok("反向对照：资料库里的文件是人手动传的，本来就没有「哪次任务」，不硬凑一个出来",
     !page.querySelector(".lib-from"), html().slice(0, 300));
  window.libState.pick = null;

  // ⑤f 三种摆法 + 分组。
  // 关键是这四件事**正交**：
  // 「怎么摆」和「按什么分堆」各是各的控件，合成一个下拉就会出现「按类型 + 图标」选不出来的死角。
  try { localStorage.removeItem("owb_lib_mode"); localStorage.removeItem("owb_lib_group"); } catch {}
  window.settingsCache = { platform_owner: true };
  writeOk = true;
  window.libState = { q: "", pick: null, dir: "", view: "dir", kind: "all", mode: "list", group: "none" };
  await renderLibPage();
  const pg = () => page.querySelector(".lib-page");
  const list = () => page.querySelector(".lib-list");
  ok("摆法：默认列表，页面和列表两处的标记对得上",
     pg().dataset.mode === "list" && list().classList.contains("as-list"), pg().dataset.mode + "/" + list().className);
  ok("摆法：三颗按钮都在（列表 / 图标 / 画廊）", page.querySelectorAll(".lib-md").length === 3);
  ok("分组：三颗按钮都在（不分组 / 按类型 / 按时间）", page.querySelectorAll(".lib-gp").length === 3);
  ok("不分组时不画分组小标题（没分堆就别摆一个假的堆名）", !page.querySelector(".lib-grp"));
  // 列表视图里每一行都得说得出「多大、什么时候改的」——这是列表视图存在的理由
  const pngRow = () => page.querySelector('.lib-it[data-src="ws"][data-name="设计稿.png"]');
  ok("列表：一行四列齐了（图 / 名字 / 大小 / 时间）",
     !!pngRow() && !!pngRow().querySelector(".th") && !!pngRow().querySelector(".nm")
     && pngRow().querySelector(".sz").textContent.includes("KB") && !!pngRow().querySelector(".tm").textContent.trim(),
     pngRow() ? pngRow().outerHTML.slice(0, 260) : "没有这一行");
  ok("缩略图：图片就拿真图，不是一排「图片」图标（那等于没有缩略图）",
     !!pngRow().querySelector("img") && pngRow().querySelector("img").getAttribute("src").includes("%E8%AE%BE%E8%AE%A1%E7%A8%BF.png"),
     pngRow().querySelector(".th").innerHTML.slice(0, 160));
  ok("反向对照：不是图片的就退回图标，不去发一串必然 404 的请求",
     !page.querySelector('.lib-it[data-name="月报.md"] img') && !!page.querySelector('.lib-it[data-name="月报.md"] .th svg'));
  // 缩略图要的是缩略图，不是原图。这一页的图框最大也就 64px（.lib-list.as-gallery .lib-it .th），
  // 一屏能摆 120 张；工作空间里真实躺着 3552×4736 的图，一张解码后 64 MB —— 拿原图当缩略图
  // 就是让浏览器解码好几个 GB 的位图，页面先卡住，再整片空白
  const libSrc = () => pngRow().querySelector("img").getAttribute("src");
  ok("缩略图：要的是 160px 的缩略图，不是原图（一屏 120 张原图 = 好几个 GB 位图）",
     libSrc().includes("?thumb=160"), libSrc());
  ok("  ← 地址还是那张图的地址，只是多带一个参数（缩不动服务端会照旧发原件）",
     libSrc().startsWith("/api/files/view/") && libSrc().includes("%E8%AE%BE%E8%AE%A1%E7%A8%BF.png"), libSrc());
  ok("资料库那一栏走的是另一条路由，缩略图一样要（两条路由共用 thumb.js 同一段）",
     libUrl("lib", "手册.png", 160) === "/api/library/file/%E6%89%8B%E5%86%8C.png?thumb=160", libUrl("lib", "手册.png", 160));
  ok("反向对照：svg 不缩（矢量本来就小，栅格化只会更大更糊）",
     !libUrl("ws", "图标.svg", 160).includes("thumb"), libUrl("ws", "图标.svg", 160));
  ok("反向对照：不传宽度就是原图——预览、下载走的是这一条，不能被缩略图截胡",
     !libUrl("ws", "设计稿.png").includes("thumb"), libUrl("ws", "设计稿.png"));

  page.querySelector('.lib-md[data-mode="icon"]').click();
  await new Promise((r) => setTimeout(r, 0));
  ok("摆法：切图标，页面和列表的标记一起换", pg().dataset.mode === "icon" && list().classList.contains("as-icon"), pg().dataset.mode);
  ok("摆法：换完之后行还是那些行——三种摆法共用同一份 HTML，只换 CSS",
     !!pngRow() && !!pngRow().querySelector(".th") && !!pngRow().querySelector(".nm"));
  ok("摆法：记在 localStorage 里（有人一直用列表找文档，有人一直用图标过图）",
     localStorage.getItem("owb_lib_mode") === "icon", String(localStorage.getItem("owb_lib_mode")));

  page.querySelector('.lib-gp[data-group="kind"]').click();
  await new Promise((r) => setTimeout(r, 0));
  const grpNames = () => [...page.querySelectorAll(".lib-grp")].map((g) => g.firstChild.textContent.trim());
  ok("分组：按类型分堆，堆名就是类型筛选里那几个词（两处共用一套判定，说法才对得上）",
     grpNames().includes("文档") && grpNames().includes("表格") && grpNames().includes("图片"), grpNames().join("/"));
  ok("分组：堆名后面报个数，不用自己数", !!page.querySelector(".lib-grp .n"));
  ok("分组：分堆归分堆，摆法没被顺手改掉（这两件事是正交的）",
     pg().dataset.mode === "icon" && localStorage.getItem("owb_lib_group") === "kind", pg().dataset.mode);
  ok("分组：文件一个没少，只是换了个摆放次序",
     !!page.querySelector('.lib-it[data-name="设计稿.png"]') && !!page.querySelector('.lib-it[data-name="数据.csv"]')
     && !!page.querySelector('.lib-it[data-name="月报.md"]'));

  page.querySelector('.lib-gp[data-group="time"]').click();
  await new Promise((r) => setTimeout(r, 0));
  ok("分组：按时间分堆，今天改的和很久以前的分开（访达的「使用组」按日期就是这么分的）",
     grpNames().includes("今天") && grpNames().includes("更早"), grpNames().join("/"));

  page.querySelector('.lib-gp[data-group="none"]').click();
  await new Promise((r) => setTimeout(r, 0));
  ok("反向对照：切回不分组，小标题全收掉", !page.querySelector(".lib-grp"));

  // ⑤f-2 ★点一个文件，右边那块得真的露出来★
  // 行高亮了、内容也确实渲染进 #lb-prev 了，
  // 但 .lib-page 还挂着 data-prev="off"，而 index.html 里那条是 display:none —— 屏幕上什么都不发生。
  // 之所以一直没人发现：随手点个筛选器就会走整页重画，那一路是照 libState.pick 现算 data-prev 的，
  // 于是又看得见了，像「偶尔抽风」；实际是**每次进这一页的第一下必挂**。
  // 所以这一条要在「刚画完、还没碰过别的控件」的状态下点，别在前面顺手重画过的地方测。
  window.libState = { q: "", pick: null, dir: "", view: "dir", kind: "all", mode: "list", group: "none" };
  await renderLibPage();
  ok("开门时右边不占位（这是前提，不是结论）", pg().dataset.prev === "off", pg().dataset.prev);
  const firstFile = page.querySelector('.lib-it:not(.lib-dir)[data-src="ws"]');
  firstFile.click();
  ok("★点一个文件，预览栏当场露出来★（data-prev 得翻成 on，不然它是 display:none）",
     pg().dataset.prev === "on", pg().dataset.prev + " / " + (firstFile && firstFile.dataset.name));
  ok("  ← 这一下不许靠重画兜底：pick 记上了，行也高亮了",
     !!window.libState.pick && window.libState.pick.name === firstFile.dataset.name
     && firstFile.classList.contains("active"), JSON.stringify(window.libState.pick));
  await new Promise((r) => setTimeout(r, 0));
  ok("  ← 露出来的是那份文件的预览，不是一块空板", (page.querySelector("#lb-prev").innerHTML || "").trim().length > 0,
     (page.querySelector("#lb-prev").innerHTML || "").slice(0, 160));
  // 带着 pick 重进这一页（关掉再打开、或者从别处跳回来）：一样得是开着的
  await renderLibPage();
  ok("带着已选文件重进这一页，右边照旧开着（两条路——点击和初次渲染——得一个口径）",
     pg().dataset.prev === "on", pg().dataset.prev);
  // 文件夹是另一回事：点它是「走进去」，不是「打开一份东西」，不该顺手把预览栏撑开
  window.libState.pick = null;
  await renderLibPage();
  const dirIt = page.querySelector(".lib-it.lib-dir");
  if (dirIt) {
    dirIt.click();
    await new Promise((r) => setTimeout(r, 0));
    ok("反向对照：点文件夹是走进去，不该把预览栏撑开", pg().dataset.prev === "off", pg().dataset.prev);
    window.libState.dir = "";
  }
  window.libState = { q: "", pick: null, dir: "", view: "dir", kind: "all", mode: "list", group: "none" };
  await renderLibPage();

  // 画廊：右边那块是主角，所以不选东西也得占位置——不然打开就是一整块空白
  ok("画廊之前：没选东西时预览栏不占位，列表能用满整屏", pg().dataset.prev === "off", pg().dataset.prev);
  page.querySelector('.lib-md[data-mode="gallery"]').click();
  await new Promise((r) => setTimeout(r, 0));
  ok("画廊：预览栏常驻", pg().dataset.prev === "on" && list().classList.contains("as-gallery"), pg().dataset.prev);
  ok("画廊：没选东西就替他挑第一个，别开门先给一块空白",
     !!window.libState.pick && !!window.libState.pick.name && !!page.querySelector(".lib-it.active"),
     JSON.stringify(window.libState.pick));

  // ← → 翻文件：过一批图的时候手不该在鼠标和键盘之间来回换
  const activeName = () => (page.querySelector(".lib-it.active") || { dataset: {} }).dataset.name;
  const items0 = [...page.querySelectorAll(".lib-it:not(.lib-dir)")].map((x) => x.dataset.name);
  const first = activeName();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  ok("画廊：按 → 翻到下一个", activeName() === items0[items0.indexOf(first) + 1], first + " -> " + activeName());
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  ok("画廊：按 ← 翻回上一个", activeName() === first, activeName());
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  ok("画廊：到头就停住，不绕回末尾（绕回去的列表没人数得清自己在哪）", activeName() === first, activeName());
  // 搜索框里方向键得还是移光标——不然一个词都打不利索
  const qi = page.querySelector("#lb-q");
  qi.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  ok("反向对照：焦点在搜索框里时方向键归输入框，不去翻文件", activeName() === first, activeName());

  window.libState.mode = "list";
  window.libState.group = "none";
  window.libState.pick = null;
  try { localStorage.removeItem("owb_lib_mode"); localStorage.removeItem("owb_lib_group"); } catch {}

  // ⑥ 上传：假的成功比失败更难查
  window.settingsCache = { platform_owner: true };
  window.libState = { q: "", pick: null };
  await renderLibPage();
  const fire = async (resp) => {
    uploadResp = resp;
    window.toasts = [];
    const blob = new Blob(["hi"], { type: "text/plain" });
    const f = new File([blob], "手册.md", { type: "text/plain" });
    await page.querySelector("#lb-file").onchange({ target: { files: [f] } });
  };
  await fire({ error: "同名文件已存在", ok: false });
  ok("上传失败就说失败（以前一律 toast「已上传」配绿勾）", window.toasts.join("|").startsWith("[circle-x]"), window.toasts.join("|"));
  ok("而且把服务端给的原因带出来", window.toasts.join("|").includes("同名文件已存在"), window.toasts.join("|"));
  await fire({ ok: true, name: "手册.md" });
  ok("反向对照：真传上去了才说成功，还报个数", window.toasts.join("|") === "[circle-check] 已上传 1 个", window.toasts.join("|"));

  // ⑦ 记笔记 / 删资料：拒了就说，别让东西凭空消失
  window.settingsCache = { platform_owner: true };
  writeOk = false; // 后端这一趟拒（盘满之类）
  window.libState.pick = { src: "notes", name: "" };
  await renderLibPreview(page.querySelector("#lb-prev"), { notes: [{ id: "n1", text: "老板喜欢短句", at: "2026-09-01T00:00:00Z" }] });
  page.querySelector("#lb-note").value = "新灵感";
  window.toasts = [];
  await page.querySelector("#lb-note-save").onclick();
  ok("记笔记被拒：说出来，不再是「输入框一清，笔记没了」", window.toasts.join("|").includes(LIB_DENY.error), window.toasts.join("|"));
  window.toasts = [];
  await page.querySelector("a[data-nid]").onclick({ preventDefault() {} });
  ok("删笔记被拒：一样说出来", window.toasts.join("|").includes(LIB_DENY.error), window.toasts.join("|"));

  return names;
})()
`;

// ---- 专家 / 技能 / 连接器：读是所有人的，装和改是平台管理员的 ----
// 这四个 Tab 上的东西全是**装在这台服务器上、一份大家共用**的：专家写进 experts.json、
// 技能落在 skills/ 目录、插件和 MCP 连接器直接改服务器配置（连接器那份配置里还躺着 API Key）。
// 后端早就把它们整个前缀划给了平台管理员，前端却把「创建 / 修改 / 删除 / 安装 / 卸载 / 接入」
// 一颗不落地画给了每个人。更糟的是删专家和解散专家团那两颗：返回值整个扔了，403 也照样重画一遍，
// 那张卡纹丝不动——用户只能得出「点了没反应」。
// 这一组在真 Chromium 里把四个 Tab 都画一遍，数按钮，每条都配平台管理员的反向对照。
const HUB_P0 = APP04_LIB.indexOf("// ================= 专家 · 技能 · 连接器（主区页面，三合一）");
const APP05_MCP = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
const MCP_P1 = APP05_MCP.indexOf("// ================= 参考模板库");
if (HUB_P0 < 0) throw new Error("app-04.js 的专家/技能/连接器整节找不到了，权限测试没法定位真源码");
if (MCP_P1 <= 0) throw new Error("app-05.js 的 renderHubMcp 找不到了，权限测试没法定位真源码");
const HUB_SRC = APP04_LIB.slice(HUB_P0) + "\n" + APP05_MCP.slice(0, MCP_P1);
const HUB_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><body>"
  + "<div class='assist-page' id='assist-page'></div></body>";
const HUB_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };

  window.toasts = [];
  // 记图标名：仓库里一律 toast(文字, "circle-x")，断言要验的是「配了哪个图标」
  window.toast = (m, i) => window.toasts.push((i ? "[" + i + "] " : "") + String(m));
  window.startTaskWith = () => {};
  window.askConfirm = async () => true;
  window.refreshSettingsCache = async () => {};
  window.amPlatformOwner = () => !!(window.settingsCache && window.settingsCache.platform_owner);

  const FORBID = { error: "这块是服务器级设置，归平台管理员管", platform_only: true };
  let owner = false, delOk = true;
  const seen = [], writes = [];
  window.fetch = (url, opt) => {
    const method = (opt && opt.method) || "GET";
    seen.push(method + " " + url);
    if (method !== "GET") writes.push(method + " " + url);
    const j = (v, code) => Promise.resolve({ ok: !code || code < 400, status: code || 200, json: () => Promise.resolve(v), text: () => Promise.resolve("") });
    if (url === "/api/experts") return j([{ name: "调研专员", alias: "查得深", avatar: "🔍", category: "研究分析", description: "查得深", tags: ["行业调研"], skills: [], builtin: true }]);
    if (url === "/api/expert-teams") return j([{ name: "内容组", avatar: "👥", description: "写稿一条龙", members: ["文案主笔", "配图师"] }]);
    if (url === "/api/skills") return j([{ name: "docx", description: "生成 Word 文档" }]);
    if (url === "/api/skills/defaults/list") return j([{ name: "pptx", title: "PPT 生成", why: "做演示文稿", author: "anthropic", license: "MIT", bytes: 2048, url: "https://example.com", repo: "a/b", subpath: "s", installed: false }]);
    if (url === "/api/plugins") return j({ spec: "1.0.0", plugins: [{ name: "chart-pack", version: "1.2.0", author: "someone", description: "画图插件", ok: true, skills: [{ name: "chart" }], mcp_servers: [], bytes: 4096, source: "https://example.com/r" }], mcp: { connected: [], failures: [] } });
    if (url === "/api/mcp") {
      if (method === "POST") return owner ? j({ ok: true }) : j(FORBID, 403);
      return j({ servers: [{ name: "filesystem", command: "npx", args: ["-y", "x"], connected: true, tools: [{ name: "read_file" }], env_keys: [] }], total_tools: 9 });
    }
    if (url === "/api/mcp/catalog") return j({ items: [{ name: "brave", label: "Brave 搜索", desc: "联网搜索", category: "搜索", command: "npx", env: { BRAVE_API_KEY: "" } }], categories: ["搜索"], tools: { npx: true, uvx: true } });
    if (url.startsWith("/api/experts/") || url.startsWith("/api/expert-teams/"))
      return owner ? (delOk ? j({ ok: true }) : j({ error: "内置专家删不掉" }, 400)) : j(FORBID, 403);
    return j({ ok: true });
  };

  const page = document.getElementById("assist-page");
  const html = () => page.innerHTML;
  const q = (sel) => page.querySelector(sel);
  const show = async (tab, sub) => {
    hubState.tab = tab; hubState.sub = sub || "expert"; hubState.q = ""; hubState.mine = false; hubState.editing = null;
    await renderHubPage();
    // renderHubBody 是同步的，但技能/插件/连接器三个渲染函数里还各有一两趟 fetch，得放它们跑完
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
  };

  // ① 专家 / 专家团：成员只能召唤
  window.settingsCache = { platform_owner: false };
  await show("experts");
  ok("专家：卡片照样看得到（他要召唤专家干活）", html().includes("调研专员"), html().slice(0, 200));
  ok("专家：「立即召唤」在", !!q(".e-use"));
  ok("专家：不画「＋ 创建专家」", !q("#ex-add"));
  ok("专家：不画「修改」「删除」", !q(".e-edit") && !q(".e-del"));
  await show("experts", "team");
  ok("专家团：「整团召唤」在", !!q(".t-use"));
  ok("专家团：不画「＋ 创建专家团」", !q("#team-add"));
  ok("专家团：不画「修改」「解散」", !q(".t-edit") && !q(".t-del"));

  // ② 技能：用得了，装不了
  seen.length = 0;
  await show("skills");
  ok("技能：已装的技能照样看得到", html().includes("docx"), html().slice(0, 200));
  ok("技能：「立即使用」「正文」都在", !!q(".sk-use") && !!q(".sk-view"));
  ok("技能：不画「修改」「删除」", !q(".sk-edit") && !q(".sk-del"));
  ok("技能：不画「＋ 添加技能」", !q("#sk-add"));
  ok("技能：「从 GitHub 安装」整块不画", !q("#sk-url") && !q("#sk-install"));
  ok("技能：「推荐技能」整节不画（一排他点了只会 403 的安装按钮）", !q("[data-di]") && !q("#sk-def-all"));
  ok("技能：连推荐清单那趟接口都不打了", !seen.some(x => x.includes("/api/skills/defaults/list")), seen.join(" | "));
  ok("技能：标题说的是「可用技能」，并写清装新的归谁", html().includes("可用技能") && html().includes("装新技能归平台管理员"));

  // ③ 插件：看得到装了什么，动不了
  await show("plugins");
  ok("插件：已装的插件照样看得到（他的 agent 用的就是这些）", html().includes("chart-pack"), html().slice(0, 200));
  ok("插件：不画安装框", !q("#pl-url") && !q("#pl-install"));
  ok("插件：不画「更新」「卸载」", !q(".pl-upd") && !q(".pl-del"));

  // ④ 连接器：配置里躺着 API Key，最不该摆给每个人的一颗按钮
  await show("mcp");
  ok("连接器：已接入的看得到，工具数也看得到", html().includes("filesystem") && html().includes("9"), html().slice(0, 200));
  ok("连接器：不画「＋ 添加连接器」", !q("#mcp-open-add"));
  ok("连接器：那张填 API Key 的表单整块不画", !q("#mcp-add-form") && !q("#mcp-env") && !q("#mcp-headers"));
  ok("连接器：不画「删除」", !q(".mcp-del"));
  ok("连接器：「推荐连接器」整节不画（每一颗「接入」都是 403）", !q(".mcp-use") && !html().includes("推荐连接器"));

  // ⑤ 反向对照：平台管理员那四页，一颗按钮不少
  window.settingsCache = { platform_owner: true };
  owner = true;
  await show("experts");
  ok("反向对照：平台管理员有「＋ 创建专家」和「修改」「删除」", !!q("#ex-add") && !!q(".e-edit") && !!q(".e-del"));
  await show("experts", "team");
  ok("反向对照：专家团的「＋ 创建」「修改」「解散」都在", !!q("#team-add") && !!q(".t-edit") && !!q(".t-del"));
  await show("skills");
  ok("反向对照：技能页的添加/安装/推荐三样都在", !!q("#sk-add") && !!q("#sk-install") && !!q("[data-di]"));
  ok("反向对照：技能卡上的「修改」「删除」也在", !!q(".sk-edit") && !!q(".sk-del"));
  await show("plugins");
  ok("反向对照：插件页的安装框和「更新」「卸载」都在", !!q("#pl-url") && !!q(".pl-upd") && !!q(".pl-del"));
  await show("mcp");
  ok("反向对照：连接器的添加表单、「删除」、推荐里的「接入」都在",
     !!q("#mcp-open-add") && !!q("#mcp-add-form") && !!q(".mcp-del") && !!q(".mcp-use"));

  // ⑥ 删不掉就得说为什么——以前这两颗把返回值整个扔了，那张卡纹丝不动，用户只能得出「点了没反应」
  delOk = false;
  await show("experts");
  window.toasts = [];
  await q(".e-del").onclick();
  ok("删专家失败：把服务端的原因说出来，不再是「点了没反应」",
     window.toasts.join("|") === "[circle-x] 内置专家删不掉", window.toasts.join("|"));
  await show("experts", "team");
  window.toasts = [];
  await q(".t-del").onclick();
  ok("解散专家团失败：一样说出来", window.toasts.join("|").startsWith("[circle-x]"), window.toasts.join("|"));
  delOk = true;
  await show("experts");
  window.toasts = [];
  await q(".e-del").onclick();
  ok("反向对照：真删掉了就不报错", !window.toasts.join("|").includes("[circle-x]"), window.toasts.join("|"));

  return names;
})()
`;

// ---- 设置页：会 403 的按钮不该摆在那儿（模型 / 个性化 / 安全 / 导航 / 档位菜单） ----
// 根子不在那句提示，在于这一整屏都是照平台管理员画的：
// 多人服务器上的普通成员照样看到整套标签页，其中「联网搜索 / 自进化 / 执行追踪 / 运行状况 / 数据 / 助理设置」六页
// 从头到尾没有一样是他的；模型页那排单选钮存的是全局默认、个性化页那两张卡是全服务器共用一份、
// 安全页八张卡全是服务器策略。点哪一颗都是 403。这一组把这四页在真 Chromium 里画出来数控件，
// 每条都配一条平台管理员的反向对照——只删控件不写反向对照，把整页删空也能全绿。
const SET0 = APP05.indexOf("const SETTING_CATS = [");
const SET1 = APP05.indexOf("/* ───────────────────────── 图 / 视频 / 配音 / 看图"); // 连 saveSettings/lastSaveError 一起切进来，那也是真源
// 各路媒体模型那一大块（渠道表 + 能力卡 + 下拉选型）就在 renderModelsPane 前面，
// 它被 renderModelsPane 直接调用，不切进来的话这一屏一画就 renderMediaPane is not defined。
const MED0 = APP05.indexOf("const MEDIA_CAPS = [");
const MOD0 = APP05.indexOf("function renderModelsPane(pane, s) {");
const MOD1 = APP05.indexOf("function renderSearchPane(pane, s) {");
const PER0 = APP05.indexOf("function renderPersonaPane(pane, s) {");
const PER1 = APP05.indexOf("// ================= 桌面宠物 =================");
const APP06 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-06.js"), "utf8");
const SEC0 = APP06.indexOf("function renderSecurityPane(pane, s) {");
const SEC1 = APP06.indexOf("// ================= 快捷键面板 =================");
const PM0 = APP02.indexOf("let permModes = null;");
const PM1 = APP02.indexOf('setupPicker("perm-btn", "perm-menu");');
for (const [a, b, why] of [[SET0, SET1, "app-05.js 的 SETTING_CATS/renderSettings/saveSettings"], [MOD0, MOD1, "app-05.js 的 renderModelsPane"],
  [PER0, PER1, "app-05.js 的 renderPersonaPane"], [SEC0, SEC1, "app-06.js 的 renderSecurityPane"], [PM0, PM1, "app-02.js 的档位菜单"],
  [MED0, MOD0, "app-05.js 的 MEDIA_CAPS/renderMediaPane"]])
  if (a < 0 || b <= a) throw new Error(why + " 找不到了（改名/挪走？），设置页权限测试没法定位真源码");
const GATE_SRC = APP05.slice(SET0, SET1) + "\n" + APP05.slice(MED0, MOD1) + "\n" + APP05.slice(PER0, PER1)
  + "\n" + APP06.slice(SEC0, SEC1) + "\n" + APP02.slice(PM0, PM1);
// 这一屏要验的不止是「控件画没画」，还有「画出来长得对不对」——小标题够不够粗、图标跟字
// 之间有没有缝。渠道卡那套样式在 index.html 的内联 <style> 里，所以两份 CSS 都得注进来。
const GATE_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + "<div id='m-body'></div><div id='pane'></div><button id='perm-btn'><span id='perm-label'></span></button>"
  + "<div class='picker-menu up-left' id='perm-menu'></div></body>";
const GATE_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };

  // 这一屏依赖的零碎（渠道预设、拿 Key 链接、头像编辑器、宠物卡）不是这次要测的东西，喂桩；
  // 被测的是「哪些控件画出来了」，桩只要不炸就行。
  ${IC_STUB}
  window.ic = ic;
  window.ASSISTANT_MARK = "🐱";
  window.keyLink = () => "";
  window.modelKeySource = () => "";
  window.healthBadge = () => "";
  window.avatarEditorHtml = () => '<div id="as-av"></div>';
  window.bindAvatarEditor = () => ({ value: () => "🐱" });
  window.petCardHtml = () => '<div class="card-item" id="pet-card"><div class="t">🐱 桌面宠物</div><input type="checkbox" id="pet-on"></div>';
  window.bindPetCard = () => {};
  window.refreshSettingsCache = () => {};
  window.settingsCache = null; // saveAllModelTables 存完会读它；夹具里没有缓存，给个空的免得裸标识符炸
  window.applyAssistantIdentity = () => {};
  window.setupPicker = () => {};
  window.renderSearchPane = window.renderEvolvePane = window.renderDataPane = window.renderImPane =
    window.renderLookPane = window.renderAboutPane = window.renderShortcutsPane = window.renderAgentPane =
    window.renderMemoryPane = (el) => { el.innerHTML = "<i>别的页</i>"; };
  window.toasts = [];
  // 记图标名：仓库里一律 toast(文字, "circle-x")，断言要验的是「配了哪个图标」
  window.toast = (m, i) => window.toasts.push((i ? "[" + i + "] " : "") + String(m));
  window.askConfirm = async () => true;

  let owner = false, canSwitch = false, posts = [];
  // 渠道表在几组断言中间要换一批（验副标题和「第 N 个」），所以拎出来当变量
  // 模型表和多媒体表同理：验「同名渠道分得开」时要把行挂到重名的那两个渠道上
  let mods = [{ name: "主力", model: "gpt-5.2", api_key: "x", channel: "or" }, { name: "备用", model: "claude-sonnet-5", api_key: "y", channel: "or" }];
  let medias = [];
  // 「从渠道现拉回来的模型列表」默认不出网；验分组那一组会临时换成一份真实形状的回包
  let provModels = { ok: false, why: "测试里不出网", models: [] };
  let provModelsDown = false;   // true = 连请求都发不出去（服务端没起来 / 网断了），跟「问到了但是空的」是两回事
  let provs = [
    { id: "or", name: "我的 OpenRouter", kind: "openrouter", base_url: "https://openrouter.ai/api/v1", api_key: "sk-or-fixture", has_key: true },
    { id: "ark", name: "火山方舟（豆包）", kind: "ark", base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key: "", has_key: false },
  ];
  window.fetch = (url, opt) => {
    const method = (opt && opt.method) || "GET";
    if (method !== "GET") posts.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null });
    const j = (v, okFlag) => Promise.resolve({ ok: okFlag !== false, status: okFlag === false ? 403 : 200, json: () => Promise.resolve(v) });
    if (url === "/api/settings" && method === "GET") return j({
      platform_owner: owner,
      // 两条模型挂在同一个渠道上——「一把 Key 挂一排模型」正是这一屏要画对的东西；
      // 火山那行空着 Key，用来验「没填的不摊在主列表里，但要有地方能找到」
      providers: provs.map((x) => ({ ...x })),
      models: mods.map((x) => ({ ...x })),
      media_models: medias.map((x) => ({ ...x })),
      active_model: "主力", media: {}, model_follow_last: true, persona: "回复简洁", assistant: { name: "小猫", avatar: "🐱" },
      pet: {}, security: { cmd_allow: ["ls"], cmd_ask: ["rm"] },
    });
    if (url === "/api/model-catalog") return j({
      kinds: [
        { kind: "openrouter", label: "OpenRouter（聚合）", base_url: "https://openrouter.ai/api/v1", key_url: "https://openrouter.ai/keys" },
        { kind: "ark", label: "火山方舟（豆包）", base_url: "https://ark.cn-beijing.volces.com/api/v3", key_url: "https://console.volcengine.com/ark" },
        { kind: "newapi", label: "自建网关（new-api / one-api）", base_url: "" },
        { kind: "ollama", label: "Ollama（本机）", base_url: "http://localhost:11434/v1" },
      ],
      catalog: { chat: [{ kind: "openrouter", id: "openai/gpt-5.2", label: "GPT-5.2" }] },
    });
    if (url === "/api/provider-models") return provModelsDown ? Promise.reject(new Error("测试里把这一路掐断")) : j(provModels);
    if (url === "/api/security/modes") return j({ modes: { ask: { label: "每次问我", desc: "动手前都问" }, auto: { label: "自动执行", desc: "不问" } }, current: "ask", can_switch: canSwitch });
    if (url === "/api/security/approvals") return j({ session_allow: [] });
    if (url === "/api/security/system") return j({ fulldisk: "unknown", accessibility: "unknown", automation: "unknown", desktop: false });
    if (url.startsWith("/api/security/audit")) return j([]);
    return j({ ok: true });
  };

  const mBody = window.mBody = document.getElementById("m-body");
  const pane = document.getElementById("pane");
  const navCats = () => [...mBody.querySelectorAll(".cat")].map((c) => c.dataset.cat);
  const activeCat = () => (mBody.querySelector(".cat.active") || {}).dataset;

  // ① 导航：六个纯服务器级的标签页不画给成员
  owner = false;
  await renderSettings("models");
  const memberCats = navCats();
  ok("成员的设置页里没有「联网搜索 / 自进化 / 执行追踪 / 运行状况 / 数据 / 助理设置」这六页（点进去每一颗按钮都是 403）",
    !["search", "evolve", "trace", "ops", "data", "im"].some((k) => memberCats.includes(k)), memberCats.join(","));
  ok("混着他自己东西的那几页留着（模型看得到有哪些、安全看得到档位、个性化里有他的宠物）",
    ["models", "agent", "security", "persona", "memory", "shortcuts", "look", "about"].every((k) => memberCats.includes(k)), memberCats.join(","));
  await renderSettings("data");
  ok("从旧深链跳进一个已经不画的页，退回第一页，不留一屏空白", activeCat() && activeCat().cat === "models", JSON.stringify(activeCat()));
  owner = true;
  await renderSettings("models");
  ok("反向对照：平台管理员 14 页一个不少", navCats().length === 14 && navCats().includes("data") && navCats().includes("trace") && navCats().includes("ops"), navCats().join(","));

  // ② 模型页：他改不了服务器的账单，但得知道有哪些模型
  owner = false;
  await renderSettings("models");
  const mp = mBody.querySelector("#settings-pane");
  ok("成员照样看得见服务器上有哪些模型", mp.textContent.includes("主力") && mp.textContent.includes("备用"));
  ok("没有那排单选钮（它存的是全局默认 active_model，一点就 403）", !mp.querySelector("input[name=active]"));
  ok("当前默认还是标出来了，只是画成状态不是开关", mp.textContent.includes("●"));
  ok("模型行上没有那个 ⋯（编辑 / 复制 / 删除都在里头）",
    !mp.querySelector(".row-more") && !mp.querySelector("[data-cedit]") && !mp.querySelector("[data-cdup]") && !mp.querySelector("[data-cdel]"));
  ok("渠道底下没有「＋ 添加模型」和那张表单", !mp.querySelector(".ca-new") && !mp.querySelector(".ca-form"));
  ok("渠道本身也动不了：没有增删改、没有 Key 输入框（卡里那一行也没有）",
    !mp.querySelector("#pf-new") && !mp.querySelector("#pf-key") && !mp.querySelector("#prov-form")
    && !mp.querySelector("[data-pedit]") && !mp.querySelector("[data-pdel]")
    && !mp.querySelector(".ck-input") && !mp.querySelector(".ck-save") && !mp.querySelector("[data-fillkey]"));
  ok("但渠道分组照画——他得看得出哪几个模型共用同一把 Key", !!mp.querySelector("#prov-list") && mp.textContent.includes("我的 OpenRouter"));
  ok("媒体模型：成员这儿没有默认单选钮，只有一句人话",
    !mp.querySelector("input[name^=def-]") && !mp.querySelector(".mm-new") && /归平台管理员/.test(mp.textContent));
  ok("而且告诉他这几路现在有几个模型可用（不是一句「没权限」了事）", /个模型可用|还没配/.test(mp.textContent));
  ok("属于他自己的那颗开关还在（新对话沿用上次选的模型）", !!mp.querySelector("#mf-follow-last"));
  posts = [];
  mp.querySelector("#mf-follow-last").checked = false;
  await mp.querySelector("#mf-follow-last").onchange({ target: mp.querySelector("#mf-follow-last") });
  ok("那颗开关真接上了（只发 model_follow_last，是个人偏好）",
    posts.length === 1 && posts[0].url === "/api/settings" && posts[0].body.model_follow_last === false, JSON.stringify(posts));
  owner = true;
  await renderSettings("models");
  const mpo = mBody.querySelector("#settings-pane");
  // 能力卡的张数钉在 MEDIA_CAPS 上（加一路能力只改那张表），但光比「等于自己」的话，
  // 把 MEDIA_CAPS 清空也能全绿——所以再压一条下限：少于 5 路就是有人把能力卡删没了。
  ok("反向对照：平台管理员那排单选钮、行尾 ⋯、渠道增删改和每一路媒体一样不少",
    !!mpo.querySelector("input[name=active]") && !!mpo.querySelector(".row-more") && !!mpo.querySelector("[data-cedit]")
    && !!mpo.querySelector(".ca-new") && !!mpo.querySelector("#prov-list") && !!mpo.querySelector("#pf-new")
    && !!mpo.querySelector("[data-pedit]")
    && MEDIA_CAPS.length >= 5 && mpo.querySelectorAll(".ch-head[data-cap]").length === MEDIA_CAPS.length,
    "渠道表 " + !!mpo.querySelector("#prov-list") + " · 添加模型 " + !!mpo.querySelector(".ca-new")
    + " · 能力卡 " + mpo.querySelectorAll(".ch-head[data-cap]").length + "/" + MEDIA_CAPS.length);
  // 头一次进这一页，展开的是「对话」那张能力卡，不是某个渠道卡：人来这儿十有八九是为了换对话模型，
  // 而对话模型散在各个渠道里，按渠道展开等于让他一张张点开找。渠道卡全收着，点了才开。
  ok("首屏展开的是「对话」那一路，渠道卡一张都没自动摊开",
    !!mpo.querySelector('.ch-head[data-chatcap] + .ch-body, .ch-card.open .ch-head[data-chatcap]')
    && mpo.querySelectorAll("#prov-list .ch-card.open").length === 0
    && mpo.querySelector("#chat-overview").textContent.includes("主力"),
    "摊开的渠道卡 " + mpo.querySelectorAll("#prov-list .ch-card.open").length);
  // 六格路由图：对话那一格得写出「主用谁 + 还压着几个备选」。老版本一格只写得下一个名字，
  // 一格一个名字就永远看不出有没有备份
  const rtChat = mpo.querySelector('.model-route-grid .rt[data-goto="chat"]');
  ok("顶上路由图第一格就是对话：主用是谁、模型 id、还剩几个备选，三样都在，而且是可点的",
    !!rtChat && rtChat.tagName === "BUTTON" && rtChat.textContent.includes("主力")
    && rtChat.textContent.includes("gpt-5.2") && rtChat.textContent.includes("+1 备选"),
    rtChat && rtChat.textContent.replace(/\s+/g, " ").trim());
  ok("反向对照：六格一路一格，媒体那五路一个不少，没配的那几格写「未设置」不是留白",
    mpo.querySelectorAll(".model-route-grid .rt").length === MEDIA_CAPS.length + 1
    && (mpo.querySelector(".model-route-grid").textContent.match(/未设置|跟随对话模型/g) || []).length === MEDIA_CAPS.length,
    mpo.querySelectorAll(".model-route-grid .rt").length + " 格");
  // 一把 Key 挂两个模型：整屏的行数应该比「每条模型摊一行」少——这是 #96 要的那个「不密」
  mpo.querySelector('.ch-head[data-chan="or"]').onclick();
  const mpoC = mBody.querySelector("#settings-pane");
  ok("两个模型折在一个渠道卡里，「去拿 Key」这类提示全屏只出现一次，不是一条模型一遍",
    mpoC.querySelectorAll("#prov-list .ch-card").length === 1 && mpoC.querySelectorAll("#prov-list .mrow").length === 2
    && (mpoC.textContent.match(/去拿 Key/g) || []).length === 1,
    "渠道卡 " + mpoC.querySelectorAll("#prov-list .ch-card").length + " · 模型行 " + mpoC.querySelectorAll("#prov-list .mrow").length);
  mpoC.querySelector('.ch-head[data-chan="or"]').onclick(); // 收回去，后面几条还按「渠道卡默认收着」验

  // ②-bis 两件事得同时成立：没填 Key 的渠道不摆在主列表里，但还得有地方能找到它去填。
  // 只做前一件就是把渠道藏死，人再也找不到去哪儿填；只做后一件就是原来那堵十来家服务商的墙。
  ok("还没填 Key 的那家不摊在主列表里，主列表只剩真能用的那一张卡",
    mpo.querySelectorAll("#prov-list .ch-card").length === 1
    && !mpo.querySelector("#prov-list").textContent.includes("火山方舟"),
    "主列表卡数 " + mpo.querySelectorAll("#prov-list .ch-card").length);
  ok("但它没被吞掉：底下留着「还没填 Key 的渠道 · 1 家」这一栏，默认收着",
    !!mpo.querySelector("#idle-toggle") && /还没填 Key 的渠道/.test(mpo.querySelector(".idle-head").textContent)
    && /1 家/.test(mpo.querySelector(".idle-head").textContent) && !mpo.querySelector(".idle-body"),
    (mpo.querySelector(".idle-head") || {}).textContent);
  mpo.querySelector("#idle-toggle").onclick();
  const mpoI = mBody.querySelector("#settings-pane");
  ok("点开那一栏：火山方舟出来了，头上挂着一颗可点的「未填 Key」",
    mpoI.querySelectorAll(".idle-body .ch-card").length === 1
    && mpoI.querySelector(".idle-body").textContent.includes("火山方舟")
    && mpoI.querySelectorAll(".idle-body [data-fillkey]").length === 1
    && (mpoI.textContent.match(/未填 Key/g) || []).length === 1,
    "收起栏里的卡 " + mpoI.querySelectorAll(".idle-body .ch-card").length);
  // 点那颗「未填 Key」得把卡展开、光标落进输入框。以前它只是一行字，人拿到 Key 回来还是没地方填——
  // 填的地方藏在 ⋯ → 编辑渠道 里，摸不到就等于没地方填。
  mpoI.querySelector("[data-fillkey]").onclick({ stopPropagation() {} });
  const mpoK = mBody.querySelector("#settings-pane");
  ok("点「未填 Key」把那张卡展开：里面就是 API Key 输入框、保存钮和「去拿 Key ↗」，不用再绕进 ⋯ → 编辑渠道",
    !!mpoK.querySelector('.ck-input[data-chan="ark"]') && !!mpoK.querySelector('.ck-save[data-chan="ark"]')
    && mpoK.querySelector(".idle-body").textContent.includes("去拿 Key"),
    "输入框 " + !!mpoK.querySelector('.ck-input[data-chan="ark"]') + " · 保存钮 " + !!mpoK.querySelector('.ck-save[data-chan="ark"]'));
  posts = [];
  window.toasts = [];
  mpoK.querySelector('.ck-input[data-chan="ark"]').value = "  ark-key-from-console  ";
  await mpoK.querySelector('.ck-save[data-chan="ark"]').onclick();
  const sentKey = posts.find((x) => x.url === "/api/settings" && x.body && x.body.providers);
  ok("卡里填完点保存：整张渠道表存出去，火山那一行带上了 Key（两头空格掐掉）",
    !!sentKey && ((sentKey.body.providers.find((x) => x.id === "ark") || {}).api_key === "ark-key-from-console")
    && window.toasts.join("|").includes("Key 已保存"),
    JSON.stringify(window.toasts) + " · 存出去的行数 " + (sentKey ? sentKey.body.providers.length : -1));
  const mpoR = mBody.querySelector("#settings-pane");
  ok("填完 Key 它当场从「还没填」那一栏挪进主列表，那一栏也跟着消失",
    mpoR.querySelectorAll("#prov-list .ch-card").length === 2 && !mpoR.querySelector(".idle-sec")
    && mpoR.querySelector("#prov-list").textContent.includes("火山方舟"),
    "主列表卡数 " + mpoR.querySelectorAll("#prov-list .ch-card").length);
  posts = [];
  window.toasts = [];
  mpoR.querySelector('.ch-head[data-chan="or"]').onclick(); // 渠道卡默认收着，先点开才摸得到里面那个输入框
  const mpoW = mBody.querySelector("#settings-pane");
  mpoW.querySelector('.ck-input[data-chan="or"]').value = "   ";
  await mpoW.querySelector('.ck-save[data-chan="or"]').onclick();
  ok("反向对照：把 Key 清空再点保存，不存也不假装成功，直说「Key 是空的」",
    !posts.length && window.toasts.join("|").includes("Key 是空的"),
    JSON.stringify(window.toasts) + " · 发出去 " + posts.length + " 次");

  // 媒体那几路也收起来了：默认一路一行，说明和表单都在折叠里，点开才出来
  ok("看图 / 画图 / 视频 / 配音 / 转写 默认全折着，几段说明不再一起摊在屏上",
    !mpo.querySelector(".mm-new") && !mpo.querySelector(".mm-form")
    && !/你粘贴（⌘V）或拖进来的截图/.test(mpo.textContent) && /还没配/.test(mpo.textContent),
    "添加钮 " + mpo.querySelectorAll(".mm-new").length + " · 表单 " + mpo.querySelectorAll(".mm-form").length);
  mpo.querySelector('.ch-head[data-cap="image"]').onclick();
  const mpo2 = mBody.querySelector("#settings-pane");
  ok("点开「画图」那一路：说明、已配模型、添加钮都出来了，其余几路还收着",
    mpo2.querySelectorAll(".mm-new").length === 1 && mpo2.querySelector(".mm-new").dataset.cap === "image"
    && mpo2.textContent.includes("/images/generations") && !/你粘贴（⌘V）或拖进来的截图/.test(mpo2.textContent),
    "展开了 " + mpo2.querySelectorAll(".mm-new").length + " 路");
  // 媒体那一节的小标题不在 .card-item 里，字重得自己带；图标跟字之间也得留条缝，
  // 不然渲染出来是「⊠看图」，读着像乱码而不是图标。这里用的是全站统一那个 .hub-sec-title
  // ——它以前自带一个只服务这一处的 .sec-t，跟 .hub-sec-title 只差 6px 下边距，已经合并掉了
  const secT = mpo2.querySelector(".hub-sec-title");
  ok("「看图 / 画图 / 视频 / 配音」是个真小标题：字重 600，图标跟字之间有缝",
    !!secT && !!secT.querySelector(".i") && getComputedStyle(secT).fontWeight === "600"
    && parseFloat(getComputedStyle(secT).columnGap) >= 4,
    "字重 " + (secT && getComputedStyle(secT).fontWeight) + " · 缝 " + (secT && getComputedStyle(secT).columnGap));

  // ②-ter 卡头那行副标题：预置渠道的名字本来就是这家的中文名，再印一遍就是同一个词写两遍；
  // 而同一家开两个号得看得出谁是谁
  provs = [
    { id: "a", name: "OpenRouter（聚合）", kind: "openrouter", base_url: "https://openrouter.ai/api/v1", api_key: "k1", has_key: true },
    { id: "b", name: "OpenRouter（聚合）", kind: "openrouter", base_url: "https://openrouter.ai/api/v1", api_key: "k2", has_key: true },
    { id: "c", name: "公司自建网关", kind: "newapi", base_url: "https://gw.example.com/v1", api_key: "k3", has_key: true },
    { id: "ol", name: "本机 Ollama", kind: "ollama", base_url: "http://localhost:11434/v1", api_key: "", has_key: false },
    { id: "z", name: "某家云", kind: "custom", base_url: "https://api.example.com/v1", api_key: "", has_key: false },
  ];
  await renderSettings("models");
  const mpoD = mBody.querySelector("#settings-pane");
  const subs = [...mpoD.querySelectorAll("#prov-list .ch-sub")].map((x) => x.textContent.trim());
  ok("同一家开了两个号：卡上标「第 1 个 / 第 2 个」分得清，而不是两张一模一样的卡",
    subs[0] === "第 1 个" && subs[1] === "第 2 个", subs.join(" | "));
  ok("名字本来就是这家的中文名时，副标题不再把同一个词原样印第二遍",
    !subs.some((t) => t.includes("OpenRouter（聚合）")), subs.join(" | "));
  ok("反向对照：自己起了名字的自建网关，副标题照样告诉你它是哪一类，也不硬编「第 1 个」",
    subs[2] === "自建网关（new-api / one-api）", subs.join(" | "));
  ok("Ollama 本机跑不要 Key，留在主列表里；同样空着 Key 的云端渠道才进「还没填」那一栏",
    mpoD.querySelector("#prov-list").textContent.includes("本机 Ollama")
    && !mpoD.querySelector("#prov-list").textContent.includes("某家云")
    && /1 家/.test(mpoD.querySelector(".idle-head").textContent),
    (mpoD.querySelector(".idle-head") || {}).textContent);
  // 编号只印在渠道卡上是不够的：真正要选的那两处（多媒体的渠道下拉、对话模型行的出处）
  // 以前照样并排两个「OpenRouter（聚合）」，选完存下去认不出配的是哪把 Key。
  // 三处必须是同一套编号——各编各的话，这儿的「第 2 个」到那儿成了「第 1 个」，比不编还糟
  mods = [{ name: "主力", model: "gpt-5.2", api_key: "x", channel: "a" }, { name: "二号线", model: "gpt-5.2", api_key: "y", channel: "b" }];
  medias = [{ cap: "image", name: "即梦", provider: "b", model: "doubao-seedream", default: true }];
  await renderSettings("models");
  let mpoN = mBody.querySelector("#settings-pane");
  const chanMeta = [...mpoN.querySelectorAll("#model-list .mrow-meta, .mrow-meta")].map((x) => x.textContent);
  ok("对话模型行的「出处」也带编号：两行都写 OpenRouter（聚合）的话，等于没写",
    chanMeta.some((t) => t.includes("第 1 个")) && chanMeta.some((t) => t.includes("第 2 个")), chanMeta.join(" | "));
  // 展开状态（openCaps）是跨渲染留着的：上面那组已经点开过「画图」，这儿再点一下是收起来。
  // 所以看一眼再决定点不点，别把卡合上了还去里面找行
  const imgCard = () => mBody.querySelector("#settings-pane").querySelector('.ch-head[data-cap="image"]').closest(".ch-card");
  if (!imgCard().classList.contains("open")) imgCard().querySelector(".ch-head").onclick();
  const imgMeta = imgCard().querySelector(".mrow-meta");
  ok("多媒体那一行的渠道列跟着编号，指得出是两把 Key 里的哪一把",
    imgMeta && imgMeta.textContent.includes("第 2 个"), imgMeta ? imgMeta.textContent : "画图那张卡里没有模型行");
  mpoN = mBody.querySelector("#settings-pane");
  mpoN.querySelector('.mm-new[data-cap="image"]').onclick();
  const provOpts = [...mpoN.querySelectorAll('.mm-form[data-cap="image"] .mm-prov option')].map((o) => o.textContent);
  ok("加一条多媒体模型时，渠道下拉里的两个同名渠道分得开（否则选哪个全靠猜）",
    provOpts.filter((t) => /第 [12] 个/.test(t)).length === 2, provOpts.join(" | "));
  ok("编号跟渠道卡是同一套：卡上第 1 个在下拉里也得是第 1 个",
    provOpts[0].includes("第 1 个") && provOpts[1].includes("第 2 个"), provOpts.join(" | "));
  mods = [{ name: "主力", model: "gpt-5.2", api_key: "x", channel: "or" }, { name: "备用", model: "claude-sonnet-5", api_key: "y", channel: "or" }];
  medias = [];

  // ---- 「看图」那一路的选型下拉：渠道自己标了模态就照它分组，别再拿名字猜 ----
  // 拿当天 OpenRouter 那 446 个型号实测：真能接图的 263 个，按名字只认得出 134 个——
  // 他自己配的 z-ai/glm-5.3-flash 名字里一个 vl / vision 都没有，被扔进「其它模型」；
  // 反过来 gemini-3-pro-image 这种**出图**的，名字里带 image，一直在看图的下拉里排着队，
  // 跟能用的长得一模一样，选中了才在跑的时候炸。
  provs = [{ id: "vp", name: "带模态的聚合站", kind: "openrouter", base_url: "https://openrouter.ai/api/v1", api_key: "k", has_key: true }];
  provModels = { ok: true, models: [
    { id: "z-ai/glm-5.3-flash", cap: "vision", sure: true },
    { id: "qwen-vl-max", cap: "vision" },
    { id: "google/gemini-3-pro-image", cap: "image", sure: true },
    { id: "openai/gpt-5.3-codex", cap: "", sure: true },
  ] };
  // paintModels → renderMediaPane 每一遍都挂一个「精选目录拉回来再画一次」的异步重画。
  // 展开表单之前先把这些排空，否则待重画一到，injectLive 眼里的 sel 已经离开文档了
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const quiet = async () => { for (let i = 0; i < 4; i++) await settle(); };
  await renderSettings("models");
  await quiet();
  const eyeCard = () => mBody.querySelector("#settings-pane").querySelector('.ch-head[data-cap="vision"]').closest(".ch-card");
  if (!eyeCard().classList.contains("open")) eyeCard().querySelector(".ch-head").onclick();
  await quiet();
  eyeCard().querySelector('.mm-new[data-cap="vision"]').onclick();
  await settle(); // 列表是现拉的，等它插进下拉
  const mSel = mBody.querySelector('#settings-pane .mm-form[data-cap="vision"] .mm-model');
  const grp = (label) => [...mSel.querySelectorAll("optgroup")].find((g) => g.label.includes(label));
  const idsIn = (label) => { const g = grp(label); return g ? [...g.querySelectorAll("option")].map((o) => o.value) : null; };
  ok("渠道自己说能接图的，排进「能看图的」那一组——名字里没有 vl / vision 也算",
    (idsIn("渠道自己标的") || []).includes("z-ai/glm-5.3-flash"), JSON.stringify(idsIn("渠道自己标的")));
  ok("按名字猜出来的单独一组，标明「不一定准」，不跟渠道自己标的混在一块儿",
    (idsIn("按名字猜的") || []).join() === "qwen-vl-max", JSON.stringify(idsIn("按名字猜的")));
  ok("出图的模型不许混进「能看图的」那一组",
    !(idsIn("渠道自己标的") || []).includes("google/gemini-3-pro-image")
    && !(idsIn("按名字猜的") || []).includes("google/gemini-3-pro-image"), mSel.innerHTML.slice(0, 300));
  const others = grp("其它模型");
  const txt = (id) => { const o = [...others.querySelectorAll("option")].find((x) => x.value === id); return o ? o.textContent : ""; };
  ok("它还留在下拉里（人可能真知道自己在干什么），但名字后面写清楚是画图的",
    txt("google/gemini-3-pro-image").includes("画图"), txt("google/gemini-3-pro-image"));
  ok("渠道说死了只认文字的，也当场标出来——这正是「配了却一直卡住」的那一类",
    txt("openai/gpt-5.3-codex").includes("看不了图"), txt("openai/gpt-5.3-codex"));
  ok("提示语报个数：有几条是渠道自己标明能看图的，心里有底",
    /1 个是渠道自己标明能看图的/.test(mBody.querySelector('#settings-pane .mm-form[data-cap="vision"] .mm-tip').textContent),
    mBody.querySelector('#settings-pane .mm-form[data-cap="vision"] .mm-tip').textContent);
  // 反向对照：渠道什么都没标（国产渠道大半如此），照旧按名字分组，一个「渠道自己标的」都不许冒出来
  provs = [{ id: "vq", name: "不报模态的渠道", kind: "ark", base_url: "https://ark.cn-beijing.volces.com/api/v3", api_key: "k", has_key: true }];
  provModels = { ok: true, models: [{ id: "doubao-1-5-vision-pro-250328", cap: "vision" }, { id: "doubao-seedream-4-0", cap: "image" }] };
  await renderSettings("models");
  await quiet();
  if (!eyeCard().classList.contains("open")) eyeCard().querySelector(".ch-head").onclick();
  await quiet();
  eyeCard().querySelector('.mm-new[data-cap="vision"]').onclick();
  await settle();
  const mSel2 = mBody.querySelector('#settings-pane .mm-form[data-cap="vision"] .mm-model');
  const labels2 = [...mSel2.querySelectorAll("optgroup")].map((g) => g.label);
  ok("反向对照：渠道没报模态时，不许凭空多出一组「渠道自己标的」",
    !labels2.some((l) => l.includes("渠道自己标的")) && labels2.some((l) => l.includes("按名字猜的")), labels2.join(" | "));
  ok("反向对照：没标模态的，名字后面也不许硬加用途——那是在把猜测说成事实",
    ![...mSel2.querySelectorAll("option")].some((o) => /（画图的）|看不了图/.test(o.textContent)), mSel2.textContent.slice(0, 200));
  // 表单开着的时候，那一遍「目录拉回来再画」不许把它冲掉。
  // 点了，表单也开了，
  // 只是半个 tick 之后被重画抹平了，看着就像这颗按钮根本不管用。
  eyeCard().querySelector(".ch-head").onclick();          // 收起：挂上一个待重画
  eyeCard().querySelector(".ch-head").onclick();          // 再展开：又挂一个
  eyeCard().querySelector('.mm-new[data-cap="vision"]').onclick();
  await quiet();                                          // 待重画在这儿全部落地
  const stillOpen = mBody.querySelector('#settings-pane .mm-form[data-cap="vision"]');
  ok("表单开着的时候，「目录拉回来再画一遍」不许把它冲没（不然这颗添加按钮看着就是坏的）",
    stillOpen && stillOpen.style.display !== "none" && stillOpen.querySelectorAll(".mm-prov option").length > 0,
    stillOpen ? "display=" + stillOpen.style.display + " 渠道项=" + stillOpen.querySelectorAll(".mm-prov option").length : "表单没了");
  // ---- 「问完渠道，一个模型都没有」这一档：以前上一秒还写着「正在问渠道有哪些模型…」，
  //      下一秒那行字直接没了，问出什么结果一个字都不说。本机 Ollama 最吃这个亏：
  //      它回的是 200 + 空清单（起来了，只是还没 pull 过东西），不是错，所以连 why 都没有 ----
  provs = [{ id: "ol", name: "我这台的 Ollama", kind: "ollama", base_url: "http://localhost:11434/v1", api_key: "", has_key: true }];
  provModels = { ok: true, models: [] };
  const openMm = async () => {
    await renderSettings("models");
    await quiet();
    if (!eyeCard().classList.contains("open")) eyeCard().querySelector(".ch-head").onclick();
    await quiet();
    eyeCard().querySelector('.mm-new[data-cap="vision"]').onclick();
    await quiet();
    return mBody.querySelector('#settings-pane .mm-form[data-cap="vision"] .mm-tip');
  };
  let mtip = await openMm();
  ok("★本机一个模型都没装：告诉他去 ollama pull，而不是把那行字抹掉★",
    /ollama pull/.test(mtip.textContent), JSON.stringify(mtip.textContent));
  ok("而且不留「正在问渠道…」那句悬在那儿",
    !/正在问渠道/.test(mtip.textContent), mtip.textContent);
  // ★空清单不许进前端缓存★：他照着提示 pull 完回来，重新点开下拉框得真去问一次。
  // 缓住的话，提示教他做的事做完了，界面上还是那份空的
  provModels = { ok: true, models: [{ id: "qwen3:8b", cap: "vision", sure: true }] };
  mtip = await openMm();
  const olSel = mBody.querySelector('#settings-pane .mm-form[data-cap="vision"] .mm-model');
  ok("★拉完模型回来重新点开，这回真列得出来（那一趟空清单没被前端缓住）★",
    [...olSel.querySelectorAll("option")].some((o) => o.value === "qwen3:8b"), olSel.innerHTML.slice(0, 200));
  // 反向对照：云端渠道回空清单是另一回事（不少国产渠道压根没有 /models），不许对着它喊 ollama pull
  provs = [{ id: "zp", name: "智谱", kind: "zhipu", base_url: "https://open.bigmodel.cn/api/paas/v4", api_key: "k", has_key: true }];
  provModels = { ok: true, models: [] };
  mtip = await openMm();
  ok("反向对照：云端渠道空清单，不许喊 ollama pull，但也得给一句话",
    !/ollama pull/.test(mtip.textContent) && mtip.textContent.trim().length > 8, JSON.stringify(mtip.textContent));
  // 另一档：连问都没问出去。以前和上面同一个结局——那行字抹掉，什么都不说
  provModelsDown = true;
  mtip = await openMm();
  provModelsDown = false;
  ok("★请求根本没发出去时也得说一句★ 抹掉那行字的话，界面上和「问到了、就是没有」完全一样",
    mtip.textContent.trim().length > 8 && /没发出去|没能问到/.test(mtip.textContent), JSON.stringify(mtip.textContent));

  provModels = { ok: false, why: "测试里不出网", models: [] };

  provs = [
    { id: "or", name: "我的 OpenRouter", kind: "openrouter", base_url: "https://openrouter.ai/api/v1", api_key: "sk-or-fixture", has_key: true },
  ];
  await renderSettings("models");
  const mpoE = mBody.querySelector("#settings-pane");
  ok("反向对照：一家都没重名时，一个「第 N 个」都不出现，收起栏也不画",
    !/第 \d+ 个/.test(mpoE.textContent) && !mpoE.querySelector(".idle-sec"),
    mpoE.querySelectorAll("#prov-list .ch-sub").length + " 条副标题");

  // ③ 个性化页：名字和偏好是全服务器共用一份，宠物是他自己电脑上那只
  owner = false;
  await renderSettings("persona");
  const pp = mBody.querySelector("#settings-pane");
  ok("成员这一页没有「助理的名字和头像」那张卡", !pp.querySelector("#as-name") && !pp.querySelector("#as-save"));
  ok("也没有「个性化偏好」那块和保存钮", !pp.querySelector("#ps-text") && !pp.querySelector("#ps-save"));
  ok("桌面宠物留着（那只跑在他自己电脑上）", !!pp.querySelector("#pet-card"));
  ok("给了一句人话，还指了条真能走的路（写进记忆页）", /记忆/.test(pp.textContent) && /平台管理员/.test(pp.textContent));
  owner = true;
  await renderSettings("persona");
  const ppo = mBody.querySelector("#settings-pane");
  ok("反向对照：平台管理员三张卡都在", !!ppo.querySelector("#as-name") && !!ppo.querySelector("#ps-text") && !!ppo.querySelector("#pet-card"));

  // ④ 安全页：八张卡全是服务器策略，但「现在是哪档」他必须知道
  owner = false; canSwitch = false;
  await renderSettings("security");
  await new Promise((r) => setTimeout(r, 30)); // 档位/审批是异步拉的
  const sp = mBody.querySelector("#settings-pane");
  ok("成员的安全页没有黑白名单、运行时开关、审计那些卡",
    !sp.querySelector("#sec-fbl") && !sp.querySelector("#sec-cal") && !sp.querySelector("#sec-node") && !sp.querySelector("#audit-list"));
  ok("也没有那颗保存钮", !sp.querySelector("#sec-save"));
  ok("当前档位照样告诉他（决定 agent 动他的文件前问不问）", sp.textContent.includes("每次问我"));
  ok("档位画成只读，不摆一排点了就 403 的单选钮", !sp.querySelector("input[name=permmode]"));
  ok("说清楚归谁管", /平台管理员/.test(sp.textContent));
  owner = true; canSwitch = true;
  await renderSettings("security");
  await new Promise((r) => setTimeout(r, 30));
  const spo = mBody.querySelector("#settings-pane");
  ok("反向对照：平台管理员八张卡和保存钮都在",
    !!spo.querySelector("#sec-fbl") && !!spo.querySelector("#sec-cal") && !!spo.querySelector("#sec-node") && !!spo.querySelector("#audit-list") && !!spo.querySelector("#sec-save"));
  ok("反向对照：档位是一排真能点的单选钮", spo.querySelectorAll("input[name=permmode]").length === 2);

  // ④.5 存不下的时候，把后端说的原因转述出来
  const realFetch = window.fetch;
  window.fetch = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ error: "这块是服务器级设置，归平台管理员管" }) });
  const box = document.createElement("span");
  const saved = await saveSettings({ persona: "x" }, box);
  ok("存不下时不再是干巴巴四个字，服务端说的原因原样摆出来", saved === false && box.textContent.includes("平台管理员"), box.textContent);
  ok("原因也记在 lastSaveError 里，别处的调用点读得到", lastSaveError.includes("平台管理员"), lastSaveError);
  window.fetch = realFetch;

  // ⑤ 输入框旁边那个 🛡️ 档位菜单——用户点的就是它
  const menu = document.getElementById("perm-menu");
  canSwitch = false;
  await loadPermModes();
  ok("成员的 🛡️ 菜单里一条都点不动（点了只会得到一句「切换失败」）",
    [...menu.querySelectorAll(".mi")].every((mi) => !mi.onclick));
  ok("但当前是哪一档还看得见", menu.textContent.includes("每次问我") && !!menu.querySelector('use[href="#i-check"]'), menu.innerHTML.slice(0, 160));
  ok("菜单底下写明白了归谁管", /平台管理员/.test(menu.textContent));
  ok("按钮上的档位标签照样对得上", document.getElementById("perm-label").textContent === "每次问我");
  canSwitch = true;
  await loadPermModes();
  ok("反向对照：平台管理员那份菜单，每条都能点",
    [...menu.querySelectorAll(".mi")].length === 2 && [...menu.querySelectorAll(".mi")].every((mi) => typeof mi.onclick === "function"));
  posts = [];
  await menu.querySelector(".mi[data-perm=auto]").onclick();
  ok("反向对照：点了真发出去了", posts.some((p) => p.url === "/api/security/mode" && p.body.mode === "auto"), JSON.stringify(posts));
  return names;
})()
`;

// ---- 流式正文的分段渲染（已定稿那截不许被重建） ----
const STREAM_SRC = APP02X.slice(APP02X.indexOf("function repairBareCode"), APP02X.indexOf("\n// 【任务类型：X】"));
const STREAM_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style>"
  + "<body style='margin:0;width:760px'><div class='a-text' id='t'></div><div class='a-text' id='ref'></div></body>";
const STREAM_STUBS = [
  IC_STUB,
  "var SvgFig = { extractSvgFigures: (s) => ({ text: s, figs: [] }) };",
  ESC_SRC, // 转义用真源，不抄：抄本会跟真源分头演化，测的就不是线上那份了
  "function mdImg(alt, url) { return '<img alt=\"' + String(alt || '').replace(/\"/g, '') + '\">'; }",
  srcBlock("function joinRel(base, rel) {"), // mdFileLink 要用它，以前 renderMd 用不着所以没进来
].join("\n");
const STREAM_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const BT = String.fromCharCode(96, 96, 96);
  const el = document.getElementById("t"), ref = document.getElementById("ref");
  const same = (raw) => { ref.innerHTML = renderMd(raw); return el._split.done.innerHTML + el._split.live.innerHTML === ref.innerHTML; };

  const makeText = (n) => {
    const out = []; let i = 0, len = 0;
    while (len < n) {
      i++;
      const b = ["## 第 " + i + " 步",
        "这一步要检查配置里的字段，并把结果写回去。**注意**：不要覆盖已有值。",
        "- 列表项 A" + i, "- 列表项 B" + i, "- 列表项 C" + i,
        BT + "js", "const x" + i + " = 1;", "console.log(x" + i + ");", BT,
        "| 列1 | 列2 |", "| --- | --- |", "| a" + i + " | b" + i + " |", ""].join("\\n");
      out.push(b); len += b.length + 1;
    }
    return out.join("\\n").slice(0, n);
  };

  const text = makeText(30000);
  el._raw = ""; el._split = null;
  let firstStable = null, stableWrites = 0, mismatch = 0, frames = 0;
  const t0 = performance.now();
  for (let p = 120; ; p += 120) {
    const cut = Math.min(text.length, p);
    el._raw = text.slice(0, cut);
    const before = el._split ? el._split.html : "";
    paintStream(el);
    void el.offsetHeight;
    if (el._split.html !== before) stableWrites++;
    if (!firstStable && el._split.done.firstElementChild) firstStable = el._split.done.firstElementChild;
    frames++;
    if (frames % 10 === 0 && !same(el._raw)) mismatch++;
    if (cut >= text.length) break;
  }
  const splitMs = performance.now() - t0;

  ok("边流边渲的结果跟一次性渲染一模一样（每 10 帧比一次，最后一帧必比）", mismatch === 0 && same(el._raw), "有 " + mismatch + " 帧对不上");
  ok("已定稿那一截的 DOM 全程没被重建过（同一个节点还挂在树上）", firstStable && firstStable.isConnected && el._split.done.contains(firstStable));
  ok("固化按尾巴长度来，不是每帧都写（" + stableWrites + " 次 / " + frames + " 帧）", stableWrites > 3 && stableWrites < frames / 5, stableWrites + "/" + frames);

  // 对照：老写法每帧重建整棵 DOM
  const naive = document.getElementById("ref");
  naive.innerHTML = "";
  const t1 = performance.now();
  for (let p = 120; ; p += 120) {
    const cut = Math.min(text.length, p);
    naive.innerHTML = renderMd(text.slice(0, cut));
    void naive.offsetHeight;
    if (cut >= text.length) break;
  }
  const naiveMs = performance.now() - t1;
  const ratio = naiveMs / splitMs;
  ok("比每帧重建整棵 DOM 快 " + ratio.toFixed(1) + " 倍（" + Math.round(naiveMs) + "ms → " + Math.round(splitMs) + "ms）", ratio > 1.5, naiveMs + " vs " + splitMs);

  // 尾巴没变就别碰 DOM
  const liveNode = el._split.live.firstElementChild;
  paintStream(el);
  ok("这一帧没新字就一个节点都不动", el._split.live.firstElementChild === liveNode);

  // 后来的字把前面的排版改了 → 认赔整块重来，绝不留下半份旧排版
  el._split.html = el._split.html + "<p>这段整份重渲里根本不存在</p>";
  paintStream(el);
  ok("发现前面已经不是前缀了就整块重来（旧排版一个字都不许留下）",
    el.textContent.indexOf("这段整份重渲里根本不存在") < 0 && same(el._raw));

  // 两个壳子不许生成盒子，排版必须跟一次渲染完全一样
  ok("已定稿/正在写这两个壳子是 display:contents，不额外占一层盒子",
    getComputedStyle(el._split.done).display === "contents" && getComputedStyle(el._split.live).display === "contents",
    getComputedStyle(el._split.done).display);

  // 停笔就合回一整块：下游按「.a-text 底下直接是内容」读
  ref.innerHTML = renderMd(el._raw);
  ok("停笔后合回一整块（壳子没了，结构跟一次渲染一致）",
    sealStream(el) === true && el._split === null && !el.querySelector(".md-done") && !el.querySelector(".md-live") && el.innerHTML === ref.innerHTML);
  ok("已经合过的再合一次是空操作", sealStream(el) === false);

  // 模型常常说半句就去调工具（"我先看看这个文件" → tool_use）。合帧是 100ms 一次，
  // 这一段可能一帧都还没画就被 endText 打断。以前 sealStream 认「没画过就没得合」直接返回 false，
  // 那句话就烂在 _raw 里，屏幕上留一个空 div——话说了，用户看不见。
  {
    const half = document.createElement("div");
    half._raw = "我先看看这个文件是怎么写的";
    half._split = null;
    const sealed = sealStream(half);
    ok("一帧都没画就被工具打断，那半句话也必须落到屏上",
      sealed === true && half.textContent.indexOf("我先看看这个文件是怎么写的") >= 0,
      JSON.stringify({ sealed, txt: half.textContent }));
    const blank = document.createElement("div");
    blank._raw = ""; blank._split = null;
    ok("真的一个字都没写过就还是空操作（不许平白多出一个空段落）", sealStream(blank) === false);
  }

  // 后来的字会把前面的排版整个改掉：裸语言名 + 空行 + 代码行 会被回收成一整个代码块，
  // 所以「已经写过的那段」不能只按它自己渲染的样子固化下来，必须对得上整份重渲的前缀
  el._raw = ""; el._split = null;
  const filler = "这是一段普通的说明文字用来把长度垫到固化阈值以上。".repeat(90);
  const repairing = filler + "\\n\\njs\\n\\n" + "const a = 1;\\n".repeat(60);
  let bad = 0;
  for (let p = 200; ; p += 200) {
    const cut = Math.min(repairing.length, p);
    el._raw = repairing.slice(0, cut);
    paintStream(el);
    if (!same(el._raw)) bad++;
    if (cut >= repairing.length) break;
  }
  ok("后来的代码行把前面那行裸语言名回收成代码块时，已固化的排版跟着改（每帧都比）", bad === 0, "有 " + bad + " 帧对不上");
  ok("裸语言名那段最后真的成了一个代码块", el.querySelectorAll("pre").length === 1 && /const a = 1;/.test(el.querySelector("pre").textContent));

  // 没闭合的块级标签不许被当成「可以固化」
  ok("没闭合的引用块认得出来", balancedHtml("<p>a</p><ul><li>b</li></ul>") === true && balancedHtml("<blockquote><p>a</p>") === false);

  // 围栏没闭合的时候不许把围栏前后切开
  el._raw = ""; el._split = null;
  const fenced = "开头一段话。\\n\\n" + "填充行\\n".repeat(400) + "\\n" + BT + "js\\n" + "let y = 1;\\n".repeat(300);
  for (let p = 300; ; p += 300) {
    const cut = Math.min(fenced.length, p);
    el._raw = fenced.slice(0, cut);
    paintStream(el);
    if (cut >= fenced.length) break;
  }
  ok("围栏还没闭合时，边写边渲的结果照样跟一次渲染一致", same(el._raw));
  ok("没闭合的围栏整段都在代码块里（没被切成两半）", el.querySelectorAll("pre").length === 1 && el.querySelector("pre").textContent.split("let y").length === 301, el.querySelectorAll("pre").length + " 个 pre");

  // 一条超长地址不该把整块正文顶出横向滚动条。
  // word-break: break-word 治不了这个——它不降低 min-content 宽度；只有 overflow-wrap: anywhere 会。
  ref.style.width = "420px";
  const CJK_URL = "file:///Users/somebody/Downloads/RL%E7%8E%AF%E5%A2%83%E5%88%9B%E4%B8%9A%E6%B7%B1%E5%BA%A6%E8%B0%83%E7%A0%94_1.html";
  ref.innerHTML = renderMd("| 文件 | 说明 |\\n| --- | --- |\\n| " + CJK_URL + " | 调研报告 |");
  const wrap = ref.querySelector(".md-table-wrap");
  ok("表格里那条超长地址不用横向拖", wrap && wrap.scrollWidth <= wrap.clientWidth + 1,
     wrap && (wrap.scrollWidth + " > " + wrap.clientWidth));
  ok("整块正文也没被顶宽", ref.scrollWidth <= ref.clientWidth + 1, ref.scrollWidth + " > " + ref.clientWidth);
  ref.querySelectorAll("th, td").forEach((c) => { c.style.overflowWrap = "normal"; c.style.wordBreak = "normal"; });
  ok("反向对照：把 overflow-wrap 关掉，它立刻又顶出去（证明上面两条不是空头支票）",
     wrap.scrollWidth > wrap.clientWidth + 1, wrap.scrollWidth + " vs " + wrap.clientWidth);
  ref.style.width = "";

  return names;
})()
`;

const IMPANE_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body><div class='settings-pane' id='pane' style='width:720px'></div></body>";
const IMPANE_STUBS = `
  ${IC_STUB}
var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
var SAVES = [], SAVES_AT = [], POSTS = [], NAV = [], TEST_FAIL = new Set(), REFRESHED = 0;
var STATUS = { feishu: { configured: true, ws: { state: "connected" } }, qq: { configured: false, state: "off" }, wecom_app: { configured: false }, wechat_mp: { configured: false },
  wechat_ilink: { configured: false, state: "off" }, wecom: { configured: true }, dingtalk: { configured: false }, webhook: { configured: true, secret_set: false }, sessions: { count: 3 } };
var QR = { status: "wait" }, SESS = { count: 3 };
// 「扫码新建应用」：后端起 lark-cli config init --new，把验证链接渲染成码
var NEWAPP = { create: { ok: true, url: "https://open.feishu.cn/app/verify?token=abc", qr: "data:image/png;base64,QQ" }, status: { state: "pending" } };
var saveSettings = async (patch) => { SAVES.push(JSON.parse(JSON.stringify(patch))); SAVES_AT.push(POSTS.length); return true; };
var refreshImStatus = () => { REFRESHED++; };
var renderSettings = (k) => { NAV.push(k); };
var renderLarkQr = () => {};
window.fetch = async (url, opt) => {
  const u = String(url).split("?")[0];
  if (opt && opt.method === "POST") POSTS.push(u);
  const j = (o) => ({ ok: true, json: async () => o });
  if (u === "/im/status") return j(JSON.parse(JSON.stringify(STATUS)));
  if (TEST_FAIL.has(u)) return j({ ok: false, error: "凭证不对" });
  if (u.endsWith("/test")) return j({ ok: true, ws: { state: "connected" }, bot_name: "小买" });
  if (u === "/im/wechat/qrcode") return j({ ok: true, image: "data:image/png;base64,AA", qrcode: "q1" });
  if (u === "/im/wechat/qrcode-status") { await new Promise((r) => setTimeout(r, 4)); return j({ ok: true, status: QR.status, ilink: { bot_id: "b1" } }); }
  if (u === "/im/wechat/disconnect") return j({ ok: true });
  if (u === "/api/feishu/app/create") return j(NEWAPP.create);
  if (u === "/api/feishu/app/create/status") return j(NEWAPP.status);
  if (u === "/im/sessions") return j({ count: SESS.count });
  if (u === "/im/sessions/clear") { const n = SESS.count; SESS.count = 0; return j({ ok: true, cleared: n }); }
  return j({});
};
`;
const IMPANE_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const disp = (el) => getComputedStyle(el).display;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = () => wait(25);

  const pane = document.getElementById("pane");
  renderImPane(pane, { im: { feishu: { app_id: "cli_x", app_secret: "sec" }, qq: {}, wecom_app: {}, wechat_mp: {}, wecom_bot_webhook: "https://qyapi/x", session_idle_hours: 12 } });
  await settle();

  // ---- 1. 结构：五个分区、双栏、卡数 ----
  const secs = [...pane.querySelectorAll(".im-sec")];
  const titles = secs.map((x) => x.querySelector(".im-sec-h b").textContent).join("|");
  ok("五个分区按序", titles === "远程指挥|结果推送|发邮件|飞书增强|上下文管理", titles);
  const lefts = new Set([...secs[0].querySelectorAll(".im-card")].map((c) => Math.round(c.getBoundingClientRect().left)));
  ok("双栏是真排出来的（卡片落在两个不同的 x 上）", lefts.size === 2, [...lefts].join(","));
  ok("远程指挥 5 张 / 结果推送 3 张 / 发邮件 1 张 / 飞书增强 2 张", [5, 3, 1, 2].every((n, i) => secs[i].querySelectorAll(".im-card").length === n));
  const card = (k) => pane.querySelector('[data-ch="' + k + '"]');
  const fsC = card("feishu"), qq = card("qq"), wcb = card("wecom_bot"), dt = card("dingtalk"), wx = card("wechat_ilink"), wca = card("wecom_app");

  // ---- 2. 状态决定收起/摊开/按钮 ----
  ok("连上的飞书卡：绿灯「已连接」", fsC.querySelector(".im-st").classList.contains("ok") && fsC.querySelector(".im-st em").textContent === "已连接");
  const fsLink = fsC.querySelector(".im-src a.get-key");
  ok("飞书卡有「去开放平台」直达链接：https + 新窗口", fsLink && fsLink.href.startsWith("https://open.feishu.cn/") && fsLink.target === "_blank" && fsLink.rel === "noopener" && fsLink.textContent.includes("开放平台"), fsLink && fsLink.outerHTML);
  ok("QQ / 企微应用卡也有直达链接，推送类（企微群/钉钉/Webhook）没有（凭证在群里拿，没网页可跳）", qq.querySelector("a.get-key") && wca.querySelector("a.get-key") && !wcb.querySelector("a.get-key") && !dt.querySelector("a.get-key") && !card("webhook").querySelector("a.get-key"));
  ok("绿灯不是只改类名，颜色真不一样", getComputedStyle(fsC.querySelector(".im-st .dot")).backgroundColor !== getComputedStyle(qq.querySelector(".im-st .dot")).backgroundColor);
  ok("连上的卡默认收起", fsC.classList.contains("packed") && disp(fsC.querySelector(".im-card-b")) === "none");
  ok("连上的卡按钮是「取消连接」", fsC.querySelector(".im-conn").textContent === "取消连接" && fsC.querySelector(".im-conn").dataset.act === "disconnect");
  // 以前是「连上的收起、没连的摊开等你填」，一进来四五张卡的空表单全摊在屏幕上，
  // 全是你根本没打算连的渠道。现在**一张都不摊**：先让人看清有哪些渠道、哪个已经连上了
  ok("没连的 QQ 卡也是收起的（不再一进来就摊一屏空表单）", qq.classList.contains("packed") && disp(qq.querySelector(".im-card-b")) === "none");
  const allCards = [...pane.querySelectorAll(".im-card")];
  ok("十几张卡，一张摊开的都没有", allCards.length >= 12 && allCards.every((c) => c.classList.contains("packed")), allCards.filter((c) => !c.classList.contains("packed")).map((c) => c.dataset.ch || "静态").join(","));
  ok("每张卡都有折叠箭头（不然看不出这玩意儿能点开）", allCards.every((c) => !!c.querySelector(".im-card-h .im-ar")));
  ok("卡头是可聚焦的按钮语义，且 aria-expanded=false（读屏用户听到的跟眼睛看到的一致）",
     allCards.every((c) => { const h = c.querySelector(".im-card-h"); return h.getAttribute("role") === "button" && h.tabIndex === 0 && h.getAttribute("aria-expanded") === "false"; }));
  ok("没连的卡按钮是「连接」", qq.querySelector(".im-conn").textContent === "连接");
  ok("配了 webhook 的推送卡亮绿", wcb.classList.contains("on") && wcb.querySelector(".im-st em").textContent === "已配置");
  ok("没配的钉钉卡灰", dt.querySelector(".im-st").classList.contains("off"));
  const secretIds = [...pane.querySelectorAll("input")].filter((i) => /secret|aes_key/.test(i.id));
  ok("密钥框全是密码型", secretIds.length >= 7 && secretIds.every((i) => i.type === "password"), secretIds.map((i) => i.id + ":" + i.type).join(","));
  ok("App ID 这种明文框不是密码型", pane.querySelector("#im-feishu-app_id").type === "text");
  const helps = [...pane.querySelectorAll(".im-help")];
  ok("申请步骤折起来了", helps.length >= 9 && helps.every((d) => !d.open));
  const vis = pane.innerText.replace(/\\s+/g, "");
  ok("默认可见文字不超载（<900 字）", vis.length < 900, String(vis.length));
  ok("整段申请说明默认看不见", !vis.includes("飞书开放平台创建自建应用"));
  qq.querySelector(".im-card-h").click(); // 先把卡摊开，收起的卡里点开 <details> 也看不见，那是另一回事
  const qqHelp = qq.querySelector(".im-help");
  qqHelp.open = true;
  ok("点开「怎么拿凭证」才露出步骤", pane.innerText.includes("QQ 开放平台"));
  qqHelp.open = false;
  qq.querySelector(".im-card-h").click();
  ok("收回去之后步骤又看不见了（反向对照）", !pane.innerText.includes("QQ 开放平台"));

  // ---- 3. 卡头点一下展开/收起 ----
  fsC.querySelector(".im-card-h").click();
  ok("点卡头展开", !fsC.classList.contains("packed") && disp(fsC.querySelector(".im-card-b")) !== "none");
  fsC.querySelector(".im-card-h").click();
  ok("再点收起", fsC.classList.contains("packed"));
  fsC.querySelector(".im-card-h").click();
  ok("展开时 aria-expanded 跟着翻成 true", fsC.querySelector(".im-card-h").getAttribute("aria-expanded") === "true");
  fsC.querySelector(".im-card-h").click();
  ok("收起时又翻回 false（读屏用户听到的状态不能是反的）", fsC.querySelector(".im-card-h").getAttribute("aria-expanded") === "false");
  // 上下文管理那两张静态卡以前是不折叠的，现在跟别的卡一个待遇：一律默认收起来
  const stat = pane.querySelector(".im-card-static");
  ok("上下文管理的静态卡也默认收起", stat.classList.contains("packed") && disp(stat.querySelector(".im-card-b")) === "none");
  stat.querySelector(".im-card-h").click();
  ok("静态卡点一下也展开", !stat.classList.contains("packed") && disp(stat.querySelector(".im-card-b")) !== "none" && stat.querySelector(".im-card-h").getAttribute("aria-expanded") === "true");
  stat.querySelector(".im-card-h").click();
  ok("再点一下收回去", stat.classList.contains("packed"));

  // ---- 4. 连接 = 先保存再测活 → 刷状态 → 收起 ----
  qq.querySelector("#im-qq-app_id").value = "102";
  qq.querySelector("#im-qq-app_secret").value = "s";
  STATUS.qq = { configured: true, state: "connected" };
  qq.querySelector(".im-conn").click();
  await settle();
  ok("连接先保存，载荷带 QQ 凭证", SAVES.length === 1 && SAVES[0].im.qq.app_id === "102" && SAVES[0].im.qq.app_secret === "s", JSON.stringify(SAVES[0] && SAVES[0].im.qq));
  ok("载荷带闲置小时数", SAVES[0].im.session_idle_hours === 12);
  ok("保存之后才测活", POSTS.indexOf("/im/qq/test") >= SAVES_AT[0] && POSTS.indexOf("/im/qq/test") >= 0, POSTS.join(","));
  // 结果行走 setMsg（图标 + 一句话）：判成败看画的是哪个图标，不看消息头上那个字符
  const rIcon = (el) => { const u = el && el.querySelector("use"); return u ? u.getAttribute("href") : "(这行没画图标)"; };
  ok("测活结果写在卡上：绿勾 + 那句话", rIcon(qq.querySelector('[data-r="qq"]')) === "#i-circle-check" && /凭证有效/.test(qq.querySelector('[data-r="qq"]').textContent), qq.querySelector('[data-r="qq"]').innerHTML.slice(0, 90));
  ok("连上后绿灯 + 「取消连接」 + 收起", qq.querySelector(".im-st").classList.contains("ok") && qq.querySelector(".im-conn").textContent === "取消连接" && qq.classList.contains("packed"));
  ok("程序自己收起的卡，aria-expanded 也得跟着回 false", qq.querySelector(".im-card-h").getAttribute("aria-expanded") === "false");
  ok("连接后刷新了顶栏的在线数", REFRESHED >= 2);

  // ---- 5. 测活失败：红字、不收起、按钮还是「连接」 ----
  TEST_FAIL.add("/im/wechat/test");
  // 先只填一半：新加的「缺哪个说哪个」拦在保存之前——用户的飞书就是被一次半截保存清空 secret 的
  const p_half = POSTS.length;
  wca.querySelector("#im-wecom_app-corp_id").value = "ww";
  wca.querySelector(".im-conn").click();
  await settle();
  ok("凭证没填齐：点连接直接说缺哪几个，压根不保存", /^还差 .*AgentId/.test(wca.querySelector('[data-r="wecom_app"]').textContent.trim())
    && POSTS.slice(p_half).length === 0, wca.querySelector('[data-r="wecom_app"]').textContent + " | " + POSTS.slice(p_half).join(","));
  for (const [f, v] of [["agent_id", "1000002"], ["secret", "s"], ["token", "tk"], ["aes_key", "k".repeat(43)]]) {
    wca.querySelector("#im-wecom_app-" + f).value = v;
  }
  wca.querySelector(".im-conn").click();
  await settle();
  // 红字不是看 class：setMsg 直接写 style.color，所以拿一个探针把 --owb-err-text 解析出来比
  const resolved = (v) => { const d = document.createElement("div"); d.style.color = "var(" + v + ")"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  ok("测活失败：红叉 + 红字说明", rIcon(wca.querySelector('[data-r="wecom_app"]')) === "#i-circle-x" && getComputedStyle(wca.querySelector('[data-r="wecom_app"]')).color === resolved("--owb-err-text"), wca.querySelector('[data-r="wecom_app"]').innerHTML.slice(0, 90) + " | 色 " + getComputedStyle(wca.querySelector('[data-r="wecom_app"]')).color + " vs " + resolved("--owb-err-text"));
  ok("测活失败不收起、按钮仍是「连接」", !wca.classList.contains("packed") && wca.querySelector(".im-conn").textContent === "连接");
  TEST_FAIL.delete("/im/wechat/test");

  // ---- 6. 取消连接：两步确认，只清自己那组 ----
  const n0 = SAVES.length;
  const fb = fsC.querySelector(".im-conn");
  fb.click();
  await settle();
  ok("第一下只是问一句", fb.textContent === "确认断开？" && fb.classList.contains("danger"));
  ok("第一下没动凭证也没保存", SAVES.length === n0 && fsC.querySelector("#im-feishu-app_id").value === "cli_x");
  // 颜色是渐变过去的（按钮有 transition），25ms 抽一次会抽到过渡中间 → 等它变完再断言
  const otherBtn = qq.querySelector(".im-conn");
  for (let i = 0; i < 30 && getComputedStyle(fb).color === getComputedStyle(otherBtn).color; i++) await wait(25);
  ok("问一句的红是真画出来的", getComputedStyle(fb).color !== getComputedStyle(otherBtn).color,
    getComputedStyle(fb).color + " vs " + getComputedStyle(otherBtn).color);
  STATUS.feishu = { configured: false, ws: { state: "off" } };
  fb.click();
  await settle();
  ok("第二下清空这一组凭证", fsC.querySelector("#im-feishu-app_id").value === "" && fsC.querySelector("#im-feishu-app_secret").value === "");
  ok("清空后保存的载荷里飞书凭证是空串", SAVES.length === n0 + 1 && SAVES[n0].im.feishu.app_id === "" && SAVES[n0].im.feishu.app_secret === "");
  ok("只清飞书，别的通道没动", SAVES[n0].im.qq.app_id === "102" && SAVES[n0].im.wecom_bot_webhook === "https://qyapi/x");
  ok("断开后灯灭、按钮回「连接」、卡摊开", fsC.querySelector(".im-st").classList.contains("off") && fb.textContent === "连接" && !fsC.classList.contains("packed"));
  ok("程序自己摊开的卡，aria-expanded 跟着翻 true（反向对照：不是只会往一个方向改）", fsC.querySelector(".im-card-h").getAttribute("aria-expanded") === "true");

  // ---- 7. 推送卡：连接 = 只保存不测活 ----
  const p0 = POSTS.length;
  dt.querySelector("#im-dingtalk-dingtalk_webhook").value = "https://oapi/x";
  STATUS.dingtalk = { configured: true };
  dt.querySelector(".im-conn").click();
  await settle();
  ok("推送卡保存了钉钉 webhook", SAVES[SAVES.length - 1].im.dingtalk_webhook === "https://oapi/x");
  ok("推送卡没有测活请求", POSTS.slice(p0).every((u) => !/test/.test(u)), POSTS.slice(p0).join(","));
  ok("推送卡配好后绿灯 + 收起", dt.classList.contains("on") && dt.classList.contains("packed"));

  // ---- 8. 微信卡：连接 = 取码轮询；取消 = disconnect 接口 ----
  ok("微信卡没有输入框", wx.querySelectorAll("input").length === 0);
  wx.querySelector(".im-conn").click();
  await settle();
  ok("微信连接 = 去取二维码", POSTS.includes("/im/wechat/qrcode"));
  ok("二维码真显示出来", disp(wx.querySelector("#ilk-box")) !== "none" && wx.querySelector("#ilk-img").src.startsWith("data:"));
  STATUS.wechat_ilink = { configured: true, state: "connected", bot_id: "b1" };
  QR.status = "confirmed";
  await wait(80);
  ok("扫码确认后绿灯 + 收起 + 二维码收走", wx.classList.contains("on") && wx.classList.contains("packed") && disp(wx.querySelector("#ilk-box")) === "none", wx.className);
  wx.querySelector(".im-conn").click(); await settle();
  STATUS.wechat_ilink = { configured: false, state: "off" };
  wx.querySelector(".im-conn").click(); await settle();
  ok("微信取消连接走 disconnect 接口", POSTS.includes("/im/wechat/disconnect"));
  ok("微信断开后灯灭", wx.querySelector(".im-st").classList.contains("off"));

  // ---- 9. 上下文管理：数会话、两步清空 ----
  ok("会话数显示出来", pane.querySelector("#im-sess-n").textContent.includes("3 段"), pane.querySelector("#im-sess-n").textContent);
  const cb = pane.querySelector("#im-sess-clear");
  cb.click(); await settle();
  ok("清空也要两步", cb.textContent === "确认清空？" && !POSTS.includes("/im/sessions/clear"));
  cb.click(); await settle();
  ok("第二下真清", POSTS.includes("/im/sessions/clear") && pane.querySelector("#im-sess-r").textContent.includes("3 段"), pane.querySelector("#im-sess-r").textContent);
  ok("清完计数归零且按钮禁用", pane.querySelector("#im-sess-n").textContent.includes("没有") && cb.disabled);
  pane.querySelector("#im-goto-agent").click();
  ok("上下文预算跳去智能体设置", NAV[NAV.length - 1] === "agent");

  // ---- 10. 云文档卡状态取自输入框 / 全局保存 ----
  ok("云文档没填 = 沿用机器人凭证（灰）", card("feishu_doc").querySelector(".im-st").classList.contains("off"));
  pane.querySelector("#im-idle").value = "36";
  pane.querySelector("#im-save").click(); await settle();
  ok("保存全部带上闲置小时", SAVES[SAVES.length - 1].im.session_idle_hours === 36);

  // ---- 11. 扫码新建应用：用户问过两次「不能扫码连机器人吗」 ----
  // 机器人在飞书就是一个「应用」，平台只认 app_id/app_secret，扫码换不来这两串；
  // 但可以扫码把应用建出来 —— 建完凭证由后端接管，用户一个字都不用手打。
  const na = fsC.querySelector('[data-newapp] [data-act="newapp"]');
  ok("飞书卡上有「扫码新建应用」这颗按钮", !!na && na.textContent.includes("扫码新建应用"), na && na.outerHTML);
  ok("只有飞书有：QQ/企微应用这些没有这颗按钮（它们没有 lark-cli 这条路）",
    !qq.querySelector('[data-act="newapp"]') && !wca.querySelector('[data-act="newapp"]') && pane.querySelectorAll('[data-act="newapp"]').length === 1);
  const naBox = fsC.querySelector('[data-newapp-qr="feishu"]');
  ok("二维码区默认藏着", disp(naBox) === "none");
  NEWAPP.status = { state: "pending" };
  na.click();
  await settle();
  ok("点了就去后端起 lark-cli", POSTS.includes("/api/feishu/app/create"));
  ok("二维码显出来了，图是后端给的那张", disp(naBox) !== "none" && naBox.querySelector("img").src === "data:image/png;base64,QQ");
  ok("同时给一条可以直接点开的链接（扫不了码就用这个）",
    naBox.querySelector('[data-newapp-link="feishu"]').href === "https://open.feishu.cn/app/verify?token=abc");
  ok("按钮先禁用，别让人连点建出一堆应用", na.disabled);
  // 建成：凭证由后端接管，前端只把不敏感的 App ID 填回去
  NEWAPP.status = { state: "ok", app_id: "cli_newone" };
  for (let i = 0; i < 60 && disp(naBox) !== "none"; i++) await wait(100);
  ok("建成后二维码收起、按钮解禁", disp(naBox) === "none" && !na.disabled);
  ok("App ID 自动填回输入框", fsC.querySelector("#im-feishu-app_id").value === "cli_newone", fsC.querySelector("#im-feishu-app_id").value);
  ok("Secret 一个字节都不回前端（留空，后端已存）", fsC.querySelector("#im-feishu-app_secret").value === "");
  ok("建成的话写在卡上，不是只弹个 alert", /建好了/.test(fsC.querySelector('[data-newapp-r="feishu"]').textContent));
  // 应用建出来了，但 secret 被 lark-cli 锁在系统钥匙串里读不出来（macOS 默认就是这样）。
  // 这不是失败，是「还差最后一步」—— 不能标红吓唬人，也不能装作成功，得把 App ID 填上并指路。
  NEWAPP.status = { state: "need_secret", app_id: "cli_locked01",
    error: "lark-cli 把 App Secret 锁在系统钥匙串里，命令行读不出来。去开放平台复制 App Secret，粘到下面的框里。",
    console_url: "https://open.feishu.cn/app/cli_locked01/baseinfo" };
  na.click();
  await settle();
  for (let i = 0; i < 60 && disp(naBox) !== "none"; i++) await wait(100);
  const lockR = fsC.querySelector('[data-newapp-r="feishu"]');
  ok("secret 读不出来时，App ID 照样替你填上", fsC.querySelector("#im-feishu-app_id").value === "cli_locked01", fsC.querySelector("#im-feishu-app_id").value);
  ok("说清是「建好了、还差 secret」，不是失败", /建好了/.test(lockR.textContent) && /钥匙串/.test(lockR.textContent) && !lockR.querySelector('use[href="#i-circle-x"]'), lockR.innerHTML.slice(0, 120));
  ok("不标红：这是进度不是错误（走绿勾那一档，不是红叉）", getComputedStyle(lockR).color !== resolved("--owb-err-text") && !!lockR.querySelector('use[href="#i-circle-check"]'), getComputedStyle(lockR).color + " | " + lockR.innerHTML.slice(0, 80));
  const lockA = lockR.querySelector("a");
  ok("给一条直达凭证页的链接，省得用户自己在开放平台里翻",
    lockA && lockA.href === "https://open.feishu.cn/app/cli_locked01/baseinfo" && lockA.target === "_blank", lockA && lockA.outerHTML);
  ok("这条路上也不往前端塞 secret", fsC.querySelector("#im-feishu-app_secret").value === "");
  ok("停止轮询、按钮解禁", !na.disabled);

  // 负向控制：建失败得说人话，不能一直转圈
  NEWAPP.create = { error: "lark-cli 没装：先跑 npx @larksuite/cli@latest install" };
  na.click();
  await settle();
  const naR = fsC.querySelector('[data-newapp-r="feishu"]');
  ok("建不出来就红叉说原因、二维码不留在页面上", !!naR.querySelector('use[href="#i-circle-x"]') && /没装/.test(naR.textContent) && disp(naBox) === "none", naR.innerHTML.slice(0, 120));
  ok("失败后按钮解禁，可以再试", !na.disabled);

  // ---- 设置卡里的三层：卡标题 / 字段名 / 说明 ----
  // 以前字段名跟卡标题共用 .t，「执行上限」那张卡八个输入框的标签全是 15px/600 的黑标题，
  // 整张卡没有一处比字段名更重，看不出这八项是同一组的下属。这条钉的是三层真的分得开。
  {
    const probe = document.createElement("div");
    probe.innerHTML = '<div class="card-item"><div class="t">执行上限</div><div class="f">最大执行步数</div><div class="d">一次任务最多跑多少步</div></div>';
    pane.appendChild(probe);
    const px = (el) => Math.round(parseFloat(getComputedStyle(el).fontSize));
    const cs = (sel) => getComputedStyle(probe.querySelector(sel));
    const t = cs(".t"), f = cs(".f"), d = cs(".d");
    ok("卡标题比字段名大一号（15 / 13）", px(probe.querySelector(".t")) === 15 && px(probe.querySelector(".f")) === 13, t.fontSize + " / " + f.fontSize);
    ok("字段名和说明同字号，靠字重分层", px(probe.querySelector(".f")) === px(probe.querySelector(".d")) && Number(f.fontWeight) >= 600 && Number(d.fontWeight) < 600, f.fontWeight + " vs " + d.fontWeight);
    ok("字段名走主文字色、说明走次级灰——同号同色就糊成一层了", f.color !== d.color, f.color + " vs " + d.color);
    probe.remove();

    // 反向对照：历史写法把字段名也写成 .t，两行量出来一样大，第二层根本不存在
    const old = document.createElement("div");
    old.innerHTML = '<div class="card-item"><div class="t">执行上限</div><div class="t" style="margin-top:8px">最大执行步数</div></div>';
    pane.appendChild(old);
    const two = [...old.querySelectorAll(".t")].map(px);
    ok("反向对照：字段名写成 .t 时两行一样大，分不出层", two[0] === two[1] && two[0] === 15, two.join("/"));
    old.remove();
  }
  return names;
})();
`;


// ================= 首次开箱向导（真源码切片：ONB_TIPS … finishOnb） =================
const APP03 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-03.js"), "utf8");
const ONB0 = APP03.indexOf("const KEY_SOURCES = {");
const ONB1 = APP03.indexOf("// ================= 主区页面视图");
if (ONB0 < 0 || ONB1 < 0 || ONB1 < ONB0) throw new Error("app-03.js 里找不到向导那一段（KEY_SOURCES … 主区页面视图）");
const ONB_SRC = APP03.slice(ONB0, ONB1);
// 向导是块全屏遮罩、自己没有 ✕，Escape 管不管得着它归快捷键动作表管——把那张表的真源也切进来
const APP02_SC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
const SC0 = APP02_SC.indexOf("const SHORTCUT_ACTIONS = {");
const SC1 = APP02_SC.indexOf("\n};", SC0);
if (SC0 < 0 || SC1 < 0) throw new Error("app-02.js 里找不到 SHORTCUT_ACTIONS 这张表");
const SHORTCUT_SRC = APP02_SC.slice(SC0, SC1 + 3);
const ONB_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + "<div class='auth-mask' id='onb-mask'><div class='auth-card onb-card'><div class='onb-steps' id='onb-steps'></div><div id='onb-body'></div></div></div></body>";
const ONB_STUBS = `
  ${IC_STUB}
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  const TOASTS = [], POSTS = [], MODALS = []; let REFRESHED = 0;
  function toast(m) { TOASTS.push(String(m)); }
  function refreshSettingsCache() { REFRESHED++; }
  function openModal(k, sub) { MODALS.push(k + ":" + (sub || "")); }
  // SHORTCUT_ACTIONS 里 "stop" 这一条要用到的几个：普通弹层遮罩、对话内搜索、以及「正在跑就先停任务」
  const mask = Object.assign(document.createElement("div"), { id: "modal-mask" });
  document.body.appendChild(mask);
  // closeModal 的真身在 app-02.js 的弹层那一段（这块切的是 SHORTCUT_ACTIONS 表），照抄它做的两件事：
  // 先撤掉快捷键改绑的武装态，再收遮罩
  function closeModal() { if (window.__scCancelRebind) window.__scCancelRebind(); mask.classList.remove("show"); }
  let BUSY = false; const STOPPED = [];
  function curBusy() { return BUSY; }
  function stopTask() { STOPPED.push(1); }
  function closeChatSearch() { const cs = document.getElementById("chat-search"); if (cs) cs.style.display = "none"; }
  function toggleAppFullscreen() {} // 表里唯一一个不是箭头函数的值，建表那一刻就要存在
  // 插图放大后的大图是压在最上面那层，它的真身在 app-02.js 的插图那一段。
  // 这块切的是 SHORTCUT_ACTIONS 表，给它一个会记账的替身，好验 Esc 的先后顺序：
  // 大图开着的时候 Esc 该先退大图，不是一路退到把向导也关了
  let figZoom = null; const FIGCLOSED = [];
  function closeFigZoom() { FIGCLOSED.push(1); figZoom = null; }
  // 体检表：大脑没接上、搜索没配、图已配、IM 配了 1 个、本机只装了 codex
  let ST = { needs_setup: true, seen: false, can_finish: true, brain: { ok: false, via: "api", name: "", model: "" }, active_model: "DeepSeek", workspace_dir: "/tmp/ws",
    models: [{ name: "DeepSeek", model: "deepseek-chat", base_url: "https://api.deepseek.com/v1", local: false, has_key: false },
             { name: "Ollama", model: "qwen3", base_url: "http://localhost:11434/v1", local: true, has_key: true }],
    // 服务商清单（从目录来）：config 里一行模型都没有时向导也得有东西可选
    templates: [{ kind: "ark", label: "火山方舟（豆包）", name: "火山方舟", base_url: "https://ark.cn-beijing.volces.com/api/v3", key_url: "", model: "doubao-seed-1-6-250615", local: false },
                { kind: "ollama", label: "Ollama 本地", name: "Ollama本地", base_url: "http://localhost:11434/v1", key_url: "", model: "qwen3:14b", local: true }],
    engines: [{ id: "claude-code", label: "Claude Code", installed: false, version: "", install: "npm i -g @anthropic-ai/claude-code" },
              { id: "codex", label: "Codex", installed: true, version: "0.42.0", install: "" }],
    engine: "builtin", search: { provider: "", has_key: false }, media: { image: true, video: false, tts: false, vision: false }, im: { configured: 1 } };
  let ONB_POST_OK = true, ENGINE_TEST_OK = true, SEARCH_TEST_OK = true, DONE_OK = true, SETTINGS_OK = true;
  // 本机 Ollama 装了哪些模型：null = 它压根没跑起来
  let OLLAMA_LIST = ["llama3.2:3b", "qwen3:8b", "gemma3:12b"];
  const GETS = []; window.__GETS = GETS;
  async function saveSettings(patch) { POSTS.push(["settings", patch]); return SETTINGS_OK; }
  window.fetch = async (url, opt) => {
    const method = (opt && opt.method) || "GET";
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    const j = (o) => ({ json: async () => o });
    // 带不带 ?probe=1 都是同一张体检表：probe 只决定服务端要不要去探本机 CLI，前端拿到的字段一样
    if (url.split("?")[0] === "/api/onboarding" && method === "GET") { GETS.push(url); return j(JSON.parse(JSON.stringify(ST))); }
    if (url === "/api/onboarding") { POSTS.push(["onboarding", body]); if (!ONB_POST_OK) return j({ ok: false, error: "这个 Key 上游不认（HTTP 401）" });
      const nm = body.kind ? (ST.templates.find((t) => t.kind === body.kind) || {}).name : body.model;
      ST = { ...ST, needs_setup: false, brain: { ok: true, via: "api", name: nm, model: "deepseek-chat" } }; return j({ ok: true, active_model: nm }); }
    if (url === "/api/provider-models") { POSTS.push(["provider-models", body]); return j(OLLAMA_LIST === null ? { ok: false, why: "connect ECONNREFUSED", models: [] } : { ok: true, models: OLLAMA_LIST.map((id) => ({ id })) }); }
    if (url === "/api/engines/test") { POSTS.push(["engine-test", body]); return j(ENGINE_TEST_OK ? { ok: true, reply: "好" } : { ok: false, why: "没登录", hint: "先在终端跑 codex login" }); }
    if (url === "/api/settings" && method === "POST") { POSTS.push(["settings-raw", body]); if (body.agent && body.agent.engine) ST = { ...ST, needs_setup: false, engine: body.agent.engine, brain: { ok: true, via: "engine", name: body.agent.engine, model: "" } }; return j({ ok: true }); }
    if (url === "/api/search/test") { POSTS.push(["search-test"]); if (SEARCH_TEST_OK) ST = { ...ST, search: { provider: "tavily", has_key: true } }; return j(SEARCH_TEST_OK ? { ok: true, provider: "tavily", sample: "x" } : { ok: false, error: "tavily 返回 0 条结果" }); }
    if (url === "/api/onboarding/done") { POSTS.push(["done", body]); return j(DONE_OK ? { ok: true } : { ok: false, error: "还没接上任何大模型，先把第一步走完" }); }
    throw new Error("没替身的请求：" + method + " " + url);
  };
`;
const ONB_CHECKS = `
(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + extra : "")); names.push(n); window.__onbNames = names.length; };
  const tick = () => new Promise((r) => setTimeout(r, 8));
  const mask = document.getElementById("onb-mask"), body = document.getElementById("onb-body"), steps = document.getElementById("onb-steps");
  const q = (s) => body.querySelector(s);
  I18N.setLang("zh"); // Electron 的 navigator.language 随系统走，先钉成中文，下面按中文文案断言

  // ---- 弹不弹 ----
  await maybeOnboard(); await tick();
  ok("大脑没接上：一进来就弹向导", mask.classList.contains("show"));
  ok("步骤条五步、当前在第一步", steps.querySelectorAll(".onb-step").length === 5 && steps.querySelector(".onb-step.cur").textContent.includes("大模型"));
  ok("第一步标着「必需」，一屏文字不轰炸（<420 字）", q(".onb-tag.must") && body.innerText.length < 420, body.innerText.length);
  ok("没接上大脑时步骤条点不动", (steps.querySelectorAll(".onb-step")[3].click(), steps.querySelector(".onb-step.cur").textContent.includes("大模型")));
  ok("云端/本机两个选项，本机那边列出装了的 codex、没装的 claude-code 不出现", q("#onb-seg button.on").dataset.v === "cloud" && q("input[name=onb-eng][value=codex]") && !q("input[name=onb-eng][value=claude-code]"));
  ok("默认选中还没配 Key 的云端渠道", q("#onb-model").value === "DeepSeek" && q("#onb-tip").textContent.includes("中文强"));
  const dsLink = q("#onb-tip a.get-key");
  ok("大脑步：提示旁有「去拿 Key ↗」直达 DeepSeek 建 Key 页，新窗口打开", dsLink && dsLink.href === "https://platform.deepseek.com/api_keys" && dsLink.target === "_blank" && dsLink.rel === "noopener" && dsLink.textContent.includes("去拿 Key"), dsLink && dsLink.outerHTML);
  q("#onb-model").value = "Ollama"; q("#onb-model").dispatchEvent(new Event("change"));
  ok("选本地 Ollama 时 Key 框禁用", q("#onb-key").disabled && q("#onb-tip").textContent.includes("Ollama"));
  ok("本地模型：链接变成「装 Ollama」而不是「去拿 Key」", q("#onb-tip a.get-key") && q("#onb-tip a.get-key").textContent.includes("装 Ollama") && /ollama\.com/.test(q("#onb-tip a.get-key").href));

  // ---- 本机 Ollama：用哪个模型得他自己挑，而且候选是现问出来的 ----
  // 以前这一屏把模板里那个 qwen3:14b 当定局，连个选的地方都没有：手上跑着 llama3.2 也用不上，
  // 想用就得先去下一个 9GB 的模型。本机装了什么只有这台机器知道，所以现问 /api/provider-models。
  await tick(); await tick();
  const mdl = () => q("#onb-mdl");
  ok("选本机时冒出「用哪个模型」这一行", !q("#onb-mrow").hidden);
  ok("候选是现问本机要来的，问的就是这条渠道的地址",
     POSTS.some(([k, b]) => k === "provider-models" && b.base_url === "http://localhost:11434/v1"), JSON.stringify(POSTS));
  const opts = [...mdl().querySelectorAll("option")].map((o) => o.value);
  ok("列出来的就是这台机器上真装的那几个，外加「自己填…」",
     JSON.stringify(opts) === JSON.stringify(["llama3.2:3b", "qwen3:8b", "gemma3:12b", "__custom__"]), JSON.stringify(opts));
  ok("★默认不停在模板里那个没装的型号上★（停在那儿点下去就是一个 404）",
     mdl().value === "llama3.2:3b" && !opts.includes("qwen3:14b"), mdl().value);

  ok("选回云端时那一行收起来", (q("#onb-model").value = "DeepSeek", q("#onb-model").dispatchEvent(new Event("change")), q("#onb-mrow").hidden));

  // 他照着提示去 ollama pull 了一个，回来得有地方再问一遍——没有这颗，清单就永远停在
  // 他还没动手的那一刻，提示教他做的事做完了却没处生效
  OLLAMA_LIST = ["llama3.2:3b", "qwen3:14b"];
  q("#onb-model").value = "tpl:ollama"; q("#onb-model").dispatchEvent(new Event("change")); await tick(); await tick();
  ok("★缓存不该把人锁死：拉完新模型点「重新问一次」，清单跟着变★", !!q("#onb-mdl-again"));
  POSTS.length = 0;
  q("#onb-mdl-again").click(); await tick(); await tick();
  ok("「重新问一次」真的又去问了一趟", POSTS.some(([k]) => k === "provider-models"), JSON.stringify(POSTS));
  ok("模板里那个型号本机真有，就选中它", mdl().value === "qwen3:14b", mdl().value);

  // 提交时把他点的那个带上；云端那条路不带（用哪个型号是模板定死的，轮不到向导指手画脚）
  POSTS.length = 0; ONB_POST_OK = false;
  mdl().value = "llama3.2:3b"; q("#onb-go").click(); await tick(); await tick();
  ok("验活带上了他点的型号", POSTS.some(([k, b]) => k === "onboarding" && b.kind === "ollama" && b.model_id === "llama3.2:3b"), JSON.stringify(POSTS));

  // 「自己填…」：列表里没有的照样能用（本机 tag 名随便起，目录永远追不上）
  mdl().value = "__custom__"; mdl().dispatchEvent(new Event("change"));
  ok("选「自己填…」时输入框露出来", !q("#onb-mdl-custom").hidden);
  POSTS.length = 0;
  q("#onb-go").click(); await tick(); await tick();
  ok("★空着就点：拦下来说人话，不拿空型号去打一趟必错的请求★",
     !POSTS.some(([k]) => k === "onboarding") && /先选一个模型/.test(q("#onb-err").textContent), q("#onb-err").textContent);
  q("#onb-mdl-custom").value = "  deepseek-r1:7b  ";
  POSTS.length = 0; q("#onb-go").click(); await tick(); await tick();
  ok("手填的型号照样带出去，两头的空格顺手去掉",
     POSTS.some(([k, b]) => k === "onboarding" && b.model_id === "deepseek-r1:7b"), JSON.stringify(POSTS));

  // Ollama 压根没跑起来：不能只丢一句「没拉到」，得告诉他在终端敲什么
  OLLAMA_LIST = null;
  q("#onb-mdl-again").click(); await tick(); await tick();
  ok("连不上本机 Ollama：说清楚去终端敲哪两句，而不是一句「失败」",
     /ollama serve/.test(q("#onb-mdl-tip").textContent) && /ollama pull/.test(q("#onb-mdl-tip").textContent), q("#onb-mdl-tip").textContent);
  ok("连不上时也还留着「自己填…」这条路", [...mdl().querySelectorAll("option")].some((o) => o.value === "__custom__"));
  // 「连上了，只是一个模型都没拉过」是另一档：Ollama 这时候回的是 200 + 空清单，不是错。
  // 对这种人再喊一句 ollama serve 纯属瞎指挥——他已经起起来了
  OLLAMA_LIST = [];
  q("#onb-mdl-again").click(); await tick(); await tick();
  ok("★连上了但一个模型都没装：只叫他 pull，不再叫他 serve★",
     /ollama pull/.test(q("#onb-mdl-tip").textContent) && !/ollama serve/.test(q("#onb-mdl-tip").textContent), q("#onb-mdl-tip").textContent);
  // ★这一条是上面那个缓存坑的正脸★：空清单不许进缓存，否则他起完 Ollama 再回来还是空的
  OLLAMA_LIST = ["llama3.2:3b", "qwen3:8b", "gemma3:12b"];
  q("#onb-model").value = "DeepSeek"; q("#onb-model").dispatchEvent(new Event("change"));
  q("#onb-model").value = "Ollama"; q("#onb-model").dispatchEvent(new Event("change")); await tick(); await tick();
  ok("★起完 Ollama 再回来，这回就列得出来了（那一趟空清单没被缓存）★",
     [...mdl().querySelectorAll("option")].map((o) => o.value).includes("gemma3:12b"),
     [...mdl().querySelectorAll("option")].map((o) => o.value).join(","));

  ONB_POST_OK = true;
  q("#onb-model").value = "DeepSeek"; q("#onb-model").dispatchEvent(new Event("change"));
  POSTS.length = 0; ONB_POST_OK = false;
  q("#onb-key").value = "sk-x"; q("#onb-go").click(); await tick(); await tick();
  ok("★反向对照：云端那条路不带 model_id★",
     POSTS.some(([k, b]) => k === "onboarding" && !("model_id" in b)), JSON.stringify(POSTS));
  ONB_POST_OK = true;
  q("#onb-model").value = "DeepSeek"; q("#onb-model").dispatchEvent(new Event("change"));

  // ---- 验活失败：留在原地、原因写出来 ----
  ONB_POST_OK = false;
  q("#onb-key").value = "sk-bad"; q("#onb-go").click(); await tick(); await tick();
  ok("验活失败：错误写在向导里、不翻页、按钮恢复", q("#onb-err").textContent.includes("401") && steps.querySelector(".onb-step.cur").textContent.includes("大模型") && !q("#onb-go").disabled && q("#onb-go").textContent === "验活并继续");
  ok("验活真 POST 了 model + api_key", POSTS.some(([k, b]) => k === "onboarding" && b.model === "DeepSeek" && b.api_key === "sk-bad"));
  // 服务商清单：已配的行之后跟一组模板项（value 带 tpl: 前缀），选了模板 POST 的是 kind 而不是 model
  const tplGrp = q("#onb-model optgroup");
  // 取 option 用 querySelectorAll 而不是 .options：HTMLOptGroupElement 上没有 options 这个属性
  // （那是 <select> 的），jsdom 里读出来是 undefined，一展开就 TypeError，测试挂在自己身上
  const tplOpts = tplGrp ? [...tplGrp.querySelectorAll("option")] : [];
  ok("下拉框末尾有一组服务商模板，值带 tpl: 前缀", tplGrp && tplGrp.label.includes("新接一家") && tplOpts.length === 2 && tplOpts.every((o) => o.value.startsWith("tpl:")), tplGrp && tplGrp.outerHTML);
  q("#onb-model").value = "tpl:ollama"; q("#onb-model").dispatchEvent(new Event("change"));
  ok("模板项也认本机：选 Ollama 模板时 Key 框禁用", q("#onb-key").disabled);
  q("#onb-model").value = "tpl:ark"; q("#onb-model").dispatchEvent(new Event("change"));
  ok("选火山模板：Key 框可填、提示指向火山", !q("#onb-key").disabled && /火山/.test(q("#onb-tip").textContent));
  POSTS.length = 0;
  q("#onb-key").value = "sk-bad2"; q("#onb-go").click(); await tick(); await tick();
  ok("选模板验活：POST 的是 {kind, api_key}，没有 model", POSTS.some(([k, b]) => k === "onboarding" && b.kind === "ark" && b.api_key === "sk-bad2" && !("model" in b)), JSON.stringify(POSTS));
  q("#onb-model").value = "DeepSeek"; q("#onb-model").dispatchEvent(new Event("change"));

  // ---- 走本机 CLI：先真连再切引擎 ----
  q("#onb-seg button[data-v=local]").click();
  ok("切到本机：云端表单藏起来、本机表单露出来", q("#onb-cloud").hidden && !q("#onb-local").hidden);
  ENGINE_TEST_OK = false; POSTS.length = 0;
  q("#onb-go").click(); await tick(); await tick();
  ok("本机没登录：why+hint 都写出来，不切引擎", q("#onb-err").textContent.includes("没登录") && q("#onb-err").textContent.includes("codex login") && !POSTS.some(([k]) => k === "settings-raw"));
  ENGINE_TEST_OK = true; POSTS.length = 0;
  q("#onb-go").click(); await tick(); await tick(); await tick();
  ok("本机连上：先 /api/engines/test 再存 agent.engine，然后翻到第二步", POSTS[0][0] === "engine-test" && POSTS[0][1].id === "codex" && POSTS[1][0] === "settings-raw" && POSTS[1][1].agent.engine === "codex" && steps.querySelector(".onb-step.cur").textContent.includes("联网搜索"));
  // 这个勾以前是直接往 innerHTML 里塞「✓」字符；现在走 ic("check")，所以钉的是画出来的那个图标
  const stepIcon = (i) => { const u = steps.querySelectorAll(".onb-step")[i].querySelector("use"); return u ? u.getAttribute("href") : "(这步没画图标)"; };
  ok("第一步在步骤条上打了勾（画出来的 check 图标，不是拿字符当图标）", steps.querySelectorAll(".onb-step")[0].classList.contains("done") && stepIcon(0) === "#i-check");
  ok("负对照：还没走到的那几步不打勾，各是各的图标", stepIcon(1) !== "#i-check" && stepIcon(1).startsWith("#i-") && stepIcon(2) !== stepIcon(1));

  // ---- 第二步：搜索 ----
  ok("搜索步标「推荐」、新装默认博查（国内那家排头）、说清没填会怎样", q(".onb-tag.rec") && q("#onb-sp").value === "bocha" && body.innerText.includes("免费通道"));
  // 反向对照：用户自己挑过的那家不许被「国内优先」顶掉——换个默认值就把人家的选择改了，是另一种坑
  onbState.st = { ...onbState.st, search: { provider: "brave", has_key: false } };
  renderOnbSearch(body);
  ok("反向对照：存过 provider 就按存的来，不被默认值顶掉", q("#onb-sp").value === "brave");
  onbState.st = { ...onbState.st, search: { provider: "", has_key: false } };
  renderOnbSearch(body);
  q("#onb-sp").value = "tavily"; q("#onb-sp").dispatchEvent(new Event("change"));
  ok("换服务商：占位符和提示跟着换", q("#onb-sp-key").placeholder === "tvly-..." && q("#onb-sp-tip").textContent.includes("不用绑卡"));
  ok("搜索步：博查排第一且标「推荐」，国内三家排在海外那几家前面", q("#onb-sp option").value === "bocha" && q("#onb-sp option").textContent.includes("推荐") && [...q("#onb-sp").options].slice(0, 3).map(o => o.value).join() === "bocha,zhipu,qiniu" && q("#onb-sp-tip a.get-key"));
  q("#onb-sp").value = "brave"; q("#onb-sp").dispatchEvent(new Event("change"));
  ok("换到 Brave：链接跟着换、说清要绑卡", /brave\.com/.test(q("#onb-sp-tip a.get-key").href) && q("#onb-sp-tip").textContent.includes("绑卡"));
  q("#onb-sp").value = "tavily"; q("#onb-sp").dispatchEvent(new Event("change"));
  q("#onb-go").click(); await tick();
  ok("没填 Key 直接点保存：提醒而不是空保存", q("#onb-err").textContent.includes("没填") && !POSTS.some(([k]) => k === "settings"));
  SEARCH_TEST_OK = false; POSTS.length = 0;
  q("#onb-sp-key").value = "tvly-1"; q("#onb-go").click(); await tick(); await tick();
  ok("搜索测试失败：保存过但留在本步、原因写出来", POSTS[0][0] === "settings" && POSTS[0][1].search.provider === "tavily" && POSTS[0][1].search.tavily_key === "tvly-1" && POSTS[1][0] === "search-test" && q("#onb-err").textContent.includes("0 条") && steps.querySelector(".onb-step.cur").textContent.includes("联网搜索"));
  ok("搜索 payload 只带所选那家的 key（不把别家的 key 清空）", !("jina_key" in POSTS[0][1].search));
  SEARCH_TEST_OK = true; POSTS.length = 0;
  q("#onb-go").click(); await tick(); await tick(); await tick();
  ok("搜索测活通过：翻到第三步", steps.querySelector(".onb-step.cur").textContent.includes("图/视频/语音"));

  // ---- 第三步：多媒体 ----
  ok("四行能力：生图已配、其余未配，输入框默认收起", body.querySelectorAll(".onb-row").length === 4 && q(".onb-row[data-kind=image] .onb-chip").classList.contains("ok") && !q(".onb-row[data-kind=video] .onb-chip").classList.contains("ok") && [...body.querySelectorAll(".onb-row-b")].every((b) => b.hidden));
  ok("第三步整屏文字克制（<300 字）", body.innerText.length < 300, body.innerText.length);
  POSTS.length = 0;
  q(".onb-row[data-kind=tts] .onb-fill").click();
  ok("点「填写」才展开，语音多一个音色框", !q(".onb-row[data-kind=tts] .onb-row-b").hidden && q(".onb-row[data-kind=tts] input[data-f=voice]") && !q(".onb-row[data-kind=image] input[data-f=voice]"));
  ok("多媒体每行都有一键预设，展开前没有取 Key 链接", body.querySelectorAll(".onb-row .onb-preset").length >= 8 && !q(".onb-row[data-kind=tts] .onb-preset-src a"));
  q(".onb-row[data-kind=tts] .onb-preset").click(); await tick();
  const ttsRow = q(".onb-row[data-kind=tts]");
  ok("点预设：地址 + 模型 + 音色一键填好，只剩 Key 空着且获得焦点，旁边亮出百炼「去拿 Key」", ttsRow.querySelector("input[data-f=base_url]").value === "https://dashscope.aliyuncs.com/api/v1" && ttsRow.querySelector("input[data-f=model]").value === "qwen-tts" && ttsRow.querySelector("input[data-f=voice]").value === "Cherry" && ttsRow.querySelector("input[data-f=api_key]").value === "" && document.activeElement === ttsRow.querySelector("input[data-f=api_key]") && /bailian\.console\.aliyun\.com/.test((ttsRow.querySelector(".onb-preset-src a.get-key") || {}).href || "") && ttsRow.querySelector(".onb-preset").classList.contains("on"));
  ttsRow.querySelectorAll("input[data-f]").forEach((i) => { i.value = ""; });
  q(".onb-row[data-kind=tts] .onb-save").click(); await tick();
  ok("地址/Key 没填就保存：当场拦下", q(".onb-row[data-kind=tts] .err").textContent.includes("都要填") && !POSTS.some(([k]) => k === "settings"));
  q(".onb-row[data-kind=tts] input[data-f=base_url]").value = "https://x/v1"; q(".onb-row[data-kind=tts] .onb-save").click(); await tick();
  ok("只填了地址没填 Key：照样拦", q(".onb-row[data-kind=tts] .err").textContent.includes("都要填") && !POSTS.some(([k]) => k === "settings"));
  q(".onb-row[data-kind=tts] input[data-f=base_url]").value = "https://x/v1"; q(".onb-row[data-kind=tts] input[data-f=api_key]").value = "k"; q(".onb-row[data-kind=tts] input[data-f=model]").value = "tts-1";
  q(".onb-row[data-kind=tts] .onb-save").click(); await tick(); await tick();
  ok("保存语音：只发 media.tts 一块，行变「已配」并收起", POSTS.some(([k, p]) => k === "settings" && p.media && Object.keys(p.media).join() === "tts" && p.media.tts.model === "tts-1") && q(".onb-row[data-kind=tts] .onb-chip").classList.contains("ok") && q(".onb-row[data-kind=tts] .onb-row-b").hidden);
  q("#onb-skip-step").click(); await tick();
  ok("「都先不填」记作跳过并翻到第四步", onbState.skipped.has("media") && steps.querySelector(".onb-step.cur").textContent.includes("远程指挥"));

  // ---- 第四步：IM ----
  ok("IM 步只有一行 + 去助理设置，显示已配 1 个", body.querySelectorAll(".onb-row").length === 1 && q(".onb-chip").textContent.includes("1") && q("#onb-im-open"));
  const imLinks = [...body.querySelectorAll(".onb-im-src a.get-key")];
  ok("IM 步列出四家开放平台直达链接（飞书/QQ/企微/公众号），全 https 新窗口", imLinks.length === 4 && imLinks.every((a) => a.href.startsWith("https://") && a.target === "_blank") && imLinks.map((a) => a.textContent).join("|").includes("飞书"), imLinks.map((a) => a.href).join(","));
  q("#onb-go").click(); await tick();
  ok("下一步到完成页", steps.querySelector(".onb-step.cur").textContent.includes("完成"));

  // ---- 第五步：完成 ----
  const sum = q("#onb-sum");
  ok("清单四行：大模型 ✓ codex、搜索 ✓ tavily、多媒体 2/4、IM 1 个", sum.querySelectorAll(".onb-row").length === 4 && sum.innerText.includes("codex") && sum.innerText.includes("tavily") && sum.innerText.includes("2 / 4") && sum.innerText.includes("1 个通道"));
  ok("工作目录占位符是当前目录", q("#onb-dir").placeholder === "/tmp/ws");
  ok("大脑接上后步骤条能回跳", (steps.querySelectorAll(".onb-step")[1].click(), steps.querySelector(".onb-step.cur").textContent.includes("联网搜索")));
  ok("已配的搜索步：显示已配、按钮变下一步", q(".onb-ok").textContent.includes("tavily") && q("#onb-go").textContent === "下一步");
  q("#onb-go").click(); await tick(); q("#onb-go").click(); await tick(); q("#onb-go").click(); await tick();
  DONE_OK = false; POSTS.length = 0;
  q("#onb-dir").value = "/tmp/ws2"; q("#onb-go").click(); await tick(); await tick();
  ok("完成失败：错误写出来、不关向导", q("#onb-err").textContent.includes("大模型") && mask.classList.contains("show"));
  DONE_OK = true; POSTS.length = 0; REFRESHED = 0;
  q("#onb-go").click(); await tick(); await tick();
  ok("开始使用：POST done 带 skipped + 工作目录，关向导，刷新设置缓存", POSTS[0][0] === "done" && POSTS[0][1].skipped.includes("media") && POSTS[0][1].workspace_dir === "/tmp/ws2" && !mask.classList.contains("show") && REFRESHED >= 1);

  // ---- 走完后不再弹；关于页能重开 ----
  ST = { ...ST, seen: true };
  await maybeOnboard(); await tick();
  ok("走完了（seen）且大脑在：再进来不弹", !mask.classList.contains("show"));
  ST = { ...ST, seen: true, needs_setup: true, brain: { ok: false, via: "api", name: "", model: "" } };
  await maybeOnboard(); await tick();
  ok("走完过但大脑掉了（Key 被删）：还是要弹", mask.classList.contains("show") && steps.querySelector(".onb-step.cur").textContent.includes("大模型"));
  closeOnboarding();

  // ---- 大脑接上了就不再自动弹（不管向导走没走完）----
  // 可"第一步填完 Key 就跳过"的人 done_at 永远写不上，于是每次开机都被再拦一次
  onbSkipMem = false; try { sessionStorage.removeItem("owb_onb_skipped"); } catch {}
  ST = { ...ST, seen: false, needs_setup: false, can_finish: true, brain: { ok: true, via: "api", name: "DeepSeek", model: "deepseek-chat" } };
  await maybeOnboard(); await tick();
  ok("大脑在、向导没走完、连本窗口标记都清了：照样不弹", !mask.classList.contains("show"));
  ST = { ...ST, needs_setup: true, brain: { ok: false, via: "api", name: "", model: "" } };
  await maybeOnboard(); await tick();
  ok("反向对照：同一张体检表只把大脑翻回没接上，立刻就弹", mask.classList.contains("show"));
  closeOnboarding();

  // 开机那一趟只是判断"要不要弹"，不该让服务端去跑 which + --version；真弹出来才带 probe
  onbSkipMem = false; try { sessionStorage.removeItem("owb_onb_skipped"); } catch {}
  ST = { ...ST, seen: false, needs_setup: false, brain: { ok: true, via: "api", name: "DeepSeek", model: "deepseek-chat" } };
  window.__GETS.length = 0;
  await maybeOnboard(); await tick();
  ok("不弹的那一趟：只拉体检表，不带 probe（省掉一次本机 CLI 探测）",
     window.__GETS.length === 1 && !window.__GETS[0].includes("probe"), window.__GETS.join("|"));
  window.__GETS.length = 0;
  await openOnboarding(); await tick();
  ok("真要弹出来这一趟：带 probe=1，本机 CLI 列表才有得填",
     window.__GETS.some((u) => u.includes("probe=1")), window.__GETS.join("|"));
  closeOnboarding();
  ST = { ...ST, needs_setup: false, brain: { ok: true, via: "engine", name: "codex", model: "" } };
  await openOnboarding(); await tick();
  ok("手动重开：弹出且第一步显示「已接上」+ 下一步", mask.classList.contains("show") && q("#onb-brain-ok") && q("#onb-go").textContent === "下一步" && q("#onb-brain-form").hidden);
  q("#onb-brain-change").click();
  ok("「换一个」才露出表单", !q("#onb-brain-form").hidden && q("#onb-go").textContent === "验活并继续");
  closeOnboarding();

  // ---- 大脑没接上时「先跳过」只管本次窗口，不往服务端记 ----
  onbSkipMem = false;
  ST = { ...ST, seen: false, needs_setup: true, brain: { ok: false, via: "api", name: "", model: "" } };
  POSTS.length = 0;
  await maybeOnboard(); await tick();
  q("#onb-skip-step").click(); await tick();
  ok("先跳过：关向导、本窗口标记、不 POST done", !mask.classList.contains("show") && onbSkipFlag() === true && !POSTS.some(([k]) => k === "done"));
  await maybeOnboard(); await tick();
  ok("同一窗口内不再弹", !mask.classList.contains("show"));
  // 大脑没接上却硬走到 IM 步（比如从关于页重开后直接点）：finishOnb 不许去 POST done，只关向导
  await openOnboarding(); await tick(); onbGo(3); POSTS.length = 0;
  q("#onb-im-open").click(); await tick(); await tick();
  ok("大脑没接上时「去助理设置」：不 POST done、只关向导", !POSTS.some(([k]) => k === "done") && !mask.classList.contains("show"));
  // IM 步「去助理设置」：大脑没接上时只关向导不记 done；接上时记 done 并打开助理设置
  onbSkipMem = false;
  ST = { ...ST, needs_setup: false, brain: { ok: true, via: "api", name: "DeepSeek", model: "deepseek-chat" } };
  await openOnboarding(); await tick(); onbGo(3); POSTS.length = 0; MODALS.length = 0;
  q("#onb-im-open").click(); await tick(); await tick();
  ok("去助理设置：记 done、关向导、打开 设置→助理设置", POSTS.some(([k]) => k === "done") && !mask.classList.contains("show") && MODALS.includes("settings:im"));

  // ---- 向导第一屏就能换语言（装完才发现全是中文，引导等于白走） ----
  await openOnboarding(); await tick();
  const langBtns = [...steps.querySelectorAll(".onb-lang button")];
  ok("步骤条上方有 中文/English 两颗真按钮，当前 中文 选中", langBtns.length === 2 && langBtns.every((b) => b.tagName === "BUTTON" && b.type === "button") && steps.querySelector(".onb-lang button.on").dataset.lang === "zh");
  langBtns.find((b) => b.dataset.lang === "en").click(); await tick();
  ok("点 English：<html lang=en>、步骤名立刻变英文、English 选中", document.documentElement.lang === "en" && steps.querySelector(".onb-step.cur").textContent.includes("Model") && steps.querySelector(".onb-lang button.on").dataset.lang === "en");
  ok("English：语言按钮自己不被翻（data-i18n-skip）", [...steps.querySelectorAll(".onb-lang button")].map((b) => b.textContent).join("|") === "中文|English");
  steps.querySelector('.onb-lang button[data-lang="zh"]').click(); await tick();
  ok("点回 中文：步骤名还原、<html lang=zh-CN>", document.documentElement.lang === "zh-CN" && steps.querySelector(".onb-step.cur").textContent.includes("大模型"));
  closeOnboarding();

  // ---- 成员：这一程他根本走不完（最后一步写的是服务器级设置），就别把他放进这块没有 ✕ 的遮罩 ----
  const forget = () => { onbSkipMem = false; try { sessionStorage.removeItem("owb_onb_skipped"); } catch {} };
  forget();
  ST = { ...ST, seen: false, needs_setup: true, can_finish: false, brain: { ok: false, via: "api", name: "", model: "" } };
  await maybeOnboard(); await tick();
  ok("成员（can_finish=false）：一进来不弹这块平台级向导", !mask.classList.contains("show"));
  ST = { ...ST, can_finish: true };
  await maybeOnboard(); await tick();
  ok("反向对照：同一张体检表只把 can_finish 翻回 true，立刻就弹", mask.classList.contains("show"));
  closeOnboarding();

  // ---- 完成页也得留条出口：以前那儿只有一颗「开始使用」，它一失败就彻底出不去了 ----
  forget();
  ST = { ...ST, needs_setup: false, seen: false, can_finish: true, brain: { ok: true, via: "api", name: "DeepSeek", model: "deepseek-chat" } };
  await openOnboarding(); await tick(); onbGo(4); await tick();
  ok("完成页有一条「先跳过」，不再是一颗孤零零的「开始使用」",
     q("#onb-skip-step") && q("#onb-skip-step").textContent === "先跳过" && q("#onb-go").textContent === "开始使用",
     q("#onb-skip-step") && q("#onb-skip-step").textContent);
  POSTS.length = 0;
  q("#onb-skip-step").click(); await tick(); await tick();
  // 「Key 填好了、后面几步不想配、直接跳过」是最常见的一条路，以前它只在 sessionStorage 里记一笔，
  // 关掉应用就没了——于是每次开机都被再拦一遍。现在只要大脑已经接上，跳过就跟走完一样落盘
  ok("完成页点「先跳过」：大脑已接上 → 跟走完一样往服务端记一笔 done，下次开机不再拦",
     !mask.classList.contains("show") && onbSkipFlag() === true && POSTS.some(([k]) => k === "done"));

  // ---- Escape 也得管得着这块遮罩（它自己没有 ✕） ----
  forget();
  await openOnboarding(); await tick();
  SHORTCUT_ACTIONS["stop"]();
  ok("按 Esc：向导遮罩退得出去", !mask.classList.contains("show"));
  const mm = document.getElementById("modal-mask");
  mm.classList.add("show");
  SHORTCUT_ACTIONS["stop"]();
  ok("反向对照：向导没开着时 Esc 照旧关普通弹层，没被抢走", !mm.classList.contains("show"));

  // 插图点开的大图压在所有层最上面：Esc 得先退它。一路退到底的话，用户想关的是大图，
  // 结果连正开着的弹层一起关了
  forget();
  await openOnboarding(); await tick();
  figZoom = document.createElement("div");
  mm.classList.add("show");
  SHORTCUT_ACTIONS["stop"]();
  ok("Esc 先退最上面那层大图", FIGCLOSED.length === 1 && figZoom === null);
  ok("退大图这一下不牵连下面的向导和弹层",
     mask.classList.contains("show") && mm.classList.contains("show"),
     mask.className + " | " + mm.className);
  SHORTCUT_ACTIONS["stop"]();
  ok("大图退完了，再按一下才轮到向导", !mask.classList.contains("show") && FIGCLOSED.length === 1);
  mm.classList.remove("show");

  return names;
})().catch((e) => { throw new Error("[向导] " + ((e && (e.stack || e.message)) || String(e)) + " | 已过 " + (window.__onbNames || 0)); })
`;

// ================= 顶栏「工作空间」菜单（真源码切片：工作空间选择 … 模式选择） =================
// 这张菜单里的三条，两条是服务器级动作：切工作目录改的是整台机器那一份，打开文件夹弹的是
// 服务端那台机器上的窗口。以前不分身份一律画出来，成员点「选择新文件夹…」还会先弹个输入框
// 让他认真把路径填完，然后 403 被整个吞掉——一声不吭。验的就是「会 403 的按钮不该摆在那儿」。
const WS0 = APP02.indexOf("// ================= 工作空间选择");
const WS1 = APP02.indexOf("// ================= 模式选择");
if (WS0 < 0 || WS1 <= WS0) throw new Error("app-02.js 里找不到工作空间选择那一段，前端测试没法定位真源码");
const WSMENU_SRC = APP02.slice(WS0, WS1);
const WSMENU_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style>"
  + "<body><button id='ws-btn'>ws</button><div class='picker-menu' id='ws-menu'></div></body>";
// 「打开当前工作目录」全站有四个入口（顶栏按钮、这张菜单、助理页、设置页）。以前各写各的 fetch，
// 结果各自被吞掉——403 之后按钮点下去一声不吭。现在只许有一个出口：app-01.js 的 openWorkspaceOnHost。
const OPENWS_SITES = (() => {
  const dir = path.join(__dirname, "..", "public", "js");
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((n) => /^app-\d/.test(n)))
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n"))
      if (line.includes("/api/open-workspace")) hits.push(f + "：" + line.trim());
  return hits;
})();
const WSMENU_STUBS = `
  ${IC_STUB}
  const OPENWS_SITES = ${JSON.stringify(OPENWS_SITES)};
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  const TOASTS = [], CALLS = [];
  let PROMPTED = 0, PROMPT_RET = null, ASKED = null;
  function toast(m) { TOASTS.push(String(m)); }
  function renderFiles() { CALLS.push("renderFiles"); }
  function refreshSettingsCache() { CALLS.push("refresh"); }
  function downloadFile(n) { CALLS.push("download:" + n); }
  function fpath(n) { return encodeURIComponent(n); }
  function setupPicker(btnId, menuId) { return document.getElementById(menuId); } // 真弹层的开合另有一屏在验，这儿只要那个容器
  let settingsCache = { workspace_dir: "/srv/ws", platform_owner: true };
  let PICK = { status: 200, body: { path: "/srv/ws2" } };
  let SET = { status: 200, body: { ok: true } };
  let OPENWS = { status: 200, body: { ok: true } };
  // 手填路径那条退路以前走的是 window.prompt。桌面版跑在 Electron 里，那儿的 prompt
  // **存在、但一调用就抛**，整个处理函数当场死掉、界面上一点动静都没有
  // （资料库「新建文件夹」失灵就是同一个根因，见 app-01.js 的 askText）。
  // 现在换成应用内的小对话框，这儿也跟着换替身：记下问了什么，回一个预设答案。
  async function askText(o) { PROMPTED++; ASKED = o; return PROMPT_RET; }
  // 底下这行是反向对照：谁哪天顺手把 prompt 写回去，这一屏当场炸，
  // 而不是等到用户在桌面版里点了没反应才发现
  window.prompt = () => { throw new Error("prompt() is not supported."); };
  window.fetch = async (url, opt) => {
    const method = (opt && opt.method) || "GET";
    CALLS.push(method + " " + url);
    const mk = (r) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body });
    if (url === "/api/pick-folder") return mk(PICK);
    if (url === "/api/settings" && method === "POST") { CALLS.push("ws:" + JSON.parse(opt.body).workspace_dir); return mk(SET); }
    if (url === "/api/files") return mk({ status: 200, body: [] });
    if (url === "/api/open-workspace") return mk(OPENWS);
    throw new Error("没替身的请求：" + method + " " + url);
  };
`;
const WSMENU_CHECKS = `
(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + extra : "")); names.push(n); };
  const tick = () => new Promise((r) => setTimeout(r, 8));
  const menu = document.getElementById("ws-menu");
  const items = () => [...menu.querySelectorAll(".mi")];
  const acts = () => items().map((m) => m.dataset.act || (m.dataset.cur ? "cur" : "ro")).join(",");

  // ---- 平台管理员：三条都该在 ----
  settingsCache = { workspace_dir: "/srv/ws", platform_owner: true };
  renderWsMenu();
  ok("平台管理员：当前目录 + 选择新文件夹 + 打开当前文件夹，三条都画", acts() === "cur,pick,open" && menu.textContent.includes("/srv/ws"), acts());

  // ---- 成员：会 403 的那两条不画，只留一条只读的「现在在哪」 ----
  settingsCache = { workspace_dir: "/srv/ws", platform_owner: false };
  renderWsMenu();
  ok("成员：pick / open 两条都不画", !items().some((m) => m.dataset.act), acts());
  ok("成员：照样看得见现在在哪个目录，外加一句说清归谁管", menu.textContent.includes("/srv/ws") && menu.textContent.includes("平台管理员"));
  ok("剩下的都是只读项（.mi.ro），不装成能点的", items().every((m) => m.classList.contains("ro")));
  ok("只读项真样式上也不像能点：cursor 不是 pointer", getComputedStyle(items()[0]).cursor !== "pointer", getComputedStyle(items()[0]).cursor);
  CALLS.length = 0;
  items().forEach((m) => m.click());
  await tick(); await tick();
  ok("成员点这几条：一个请求都不发（原来会先弹输入框，填完再 403）", CALLS.length === 0 && PROMPTED === 0, JSON.stringify(CALLS));

  // ---- 管理员选新目录：系统选择框回了路径就直接切 ----
  settingsCache = { workspace_dir: "/srv/ws", platform_owner: true };
  renderWsMenu();
  CALLS.length = 0; PROMPTED = 0;
  PICK = { status: 200, body: { path: "/srv/ws2" } };
  menu.querySelector('[data-act="pick"]').click(); await tick(); await tick(); await tick();
  ok("选到了目录：POST /api/settings 带新路径、刷新缓存、重列文件", CALLS.includes("ws:/srv/ws2") && CALLS.includes("refresh") && CALLS.includes("renderFiles") && PROMPTED === 0, JSON.stringify(CALLS));

  // ---- 501 = 这台机器弹不出系统选择框：才退回手填 ----
  CALLS.length = 0; PROMPTED = 0; PROMPT_RET = "/srv/ws3";
  PICK = { status: 501, body: { error: "网页端弹不出来" } };
  menu.querySelector('[data-act="pick"]').click(); await tick(); await tick(); await tick();
  ok("501：退回手填路径，填了就切", PROMPTED === 1 && CALLS.includes("ws:/srv/ws3"), JSON.stringify(CALLS));
  ok("手填框里预填了当前目录，并说清楚为什么要手填", ASKED && ASKED.value === "/srv/ws" && /弹不出/.test(ASKED.hint || ""), JSON.stringify(ASKED));

  // ---- 别的非 2xx 是真出事了：说出来，别再骗他填一遍路径 ----
  CALLS.length = 0; PROMPTED = 0; TOASTS.length = 0;
  PICK = { status: 403, body: { error: "这块是服务器级设置，归平台管理员管" } };
  menu.querySelector('[data-act="pick"]').click(); await tick(); await tick();
  ok("403：原话说出来，不弹输入框、不发切换请求", PROMPTED === 0 && TOASTS.some((t) => t.includes("平台管理员")) && !CALLS.some((c) => c.startsWith("ws:")), JSON.stringify([TOASTS, CALLS]));

  // ---- 切换本身失败也要说：以前这条 fetch 的结果整个被丢掉 ----
  CALLS.length = 0; TOASTS.length = 0;
  PICK = { status: 200, body: { path: "/nope" } };
  SET = { status: 403, body: { error: "切不动：这是整台服务器共用的目录" } };
  menu.querySelector('[data-act="pick"]').click(); await tick(); await tick(); await tick();
  ok("切换被拒：把服务端那句话端出来，不刷新也不重列文件", TOASTS.some((t) => t.includes("整台服务器")) && !CALLS.includes("refresh") && !CALLS.includes("renderFiles"), JSON.stringify([TOASTS, CALLS]));
  SET = { status: 200, body: { ok: true } };

  // ---- 「打开当前文件夹」：开的是服务端那台机器，失败照样要说 ----
  CALLS.length = 0; TOASTS.length = 0;
  OPENWS = { status: 403, body: { error: "这块是服务器级设置，归平台管理员管" } };
  menu.querySelector('[data-act="open"]').click(); await tick(); await tick();
  ok("打开工作目录失败：说原因，不是点了一声不吭", CALLS.includes("POST /api/open-workspace") && TOASTS.some((t) => t.includes("平台管理员")), JSON.stringify([TOASTS, CALLS]));
  CALLS.length = 0; TOASTS.length = 0;
  OPENWS = { status: 200, body: { ok: true } };
  menu.querySelector('[data-act="open"]').click(); await tick(); await tick();
  ok("反向对照：成功时什么都不弹", CALLS.includes("POST /api/open-workspace") && TOASTS.length === 0, JSON.stringify(TOASTS));
  ok("全站只有一处真发 /api/open-workspace（另外三个入口都走同一个出口，不再各吞各的）",
     OPENWS_SITES.length === 1 && OPENWS_SITES[0].startsWith("app-01.js"), JSON.stringify(OPENWS_SITES));
  return names;
})().catch((e) => { throw new Error("[工作空间菜单] " + ((e && (e.stack || e.message)) || String(e))); })
`;

// ---------- 中英文切换：真 i18n.js 跑在真 Chromium 里 ----------
// 页面只有壳：静态文案、placeholder、跳过区（<pre>、translate=no、data-i18n-skip、AI 正文、用户气泡）。
// 验的是行为：切英文整页立刻翻；之后新渲染的节点由观察者接手；切回中文原样还原；观察者不自激。
const I18N_HTML = "<!doctype html><meta charset='utf-8'><body>"
  + "<button id='save'>保存</button><span id='sp'> 取消 </span><div id='mix'><b>x</b> 删除</div>"
  + "<textarea id='input' placeholder='今天帮你做些什么？@ 引用文件，/ 调用技能与指令'></textarea>"
  + "<button id='tip' title='打开所在位置'>⧉</button>"
  + "<pre id='pre'>保存</pre><code id='code'>取消</code>"
  + "<div class='a-text' id='atext' translate='no'><p id='ap'>保存</p></div>"
  + "<div class='u-msg'><div class='bubble' id='bub' translate='no'>保存</div></div>"
  + "<div id='skip' data-i18n-skip>保存</div>"
  + "<div id='dyn-host'></div><div id='status'>第 3 步 · 思考规划中…</div>"
  + "<div id='untr'>这句词典里没有</div></body>";
const I18N_CHECKS = `
(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + extra : "")); names.push(n); window.__i18nNames = names.length; };
  const $ = (q) => document.querySelector(q);
  const tick = () => new Promise((r) => setTimeout(r, 25));
  let storageBlocked = false; try { localStorage.getItem("x"); } catch { storageBlocked = true; }
  ok("本页 localStorage 被禁（验证语言偏好退到内存也能用）", storageBlocked);
  ok("挂上了 window.I18N，两种语言", window.I18N && JSON.stringify(Object.keys(I18N.LANGS)) === '["zh","en"]');
  I18N.setLang("zh");
  ok("中文模式：页面原样", $("#save").textContent === "保存" && $("#input").placeholder.startsWith("今天帮你做些什么") && document.documentElement.lang === "zh-CN");

  ok("setLang('xx') 拒收，语言不变", I18N.setLang("xx") === false && I18N.getLang() === "zh");
  I18N.setLang("en");
  ok("切英文：按钮/行内文字立刻翻（保存→Save，带首尾空格的「 取消 」→「 Cancel 」保留空格）", $("#save").textContent === "Save" && $("#sp").textContent === " Cancel ");
  ok("切英文：混排文本节点「<b>x</b> 删除」只翻文字节点（x Delete）", $("#mix").textContent === "x Delete");
  ok("切英文：placeholder / title 属性也翻", $("#input").placeholder.startsWith("What shall I do today") && $("#tip").title === "Reveal in folder");
  ok("切英文：带数字的动态句按模式翻（第 3 步 · 思考规划中… → Step 3 · thinking…）", $("#status").textContent === "Step 3 · thinking…");
  ok("切英文：<pre>/<code> 不碰", $("#pre").textContent === "保存" && $("#code").textContent === "取消");
  ok("切英文：AI 正文(.a-text translate=no) / 用户气泡 / data-i18n-skip 整棵子树不碰", $("#ap").textContent === "保存" && $("#bub").textContent === "保存" && $("#skip").textContent === "保存");
  ok("切英文：词典里没有的原样留着（漏翻看得见，不会变 undefined/空白）", $("#untr").textContent === "这句词典里没有");
  ok("切英文：<html lang=en>、getLang()=en", document.documentElement.lang === "en" && I18N.getLang() === "en");

  // 观察者：之后才渲染出来的节点
  $("#dyn-host").innerHTML = "<button id='dyn'>取消</button><input id='dyn-in' placeholder='搜索项目'>";
  await tick();
  ok("英文模式下新渲染的节点：文字和 placeholder 都被观察者翻了", $("#dyn").textContent === "Cancel" && $("#dyn-in").placeholder === "Search projects");
  $("#save").textContent = "删除"; await tick();
  ok("应用改了文字（保存→删除）：观察者按新源文重翻（Delete），不是抱着旧原文", $("#save").textContent === "Delete");
  $("#tip").title = "复制回复"; await tick();
  ok("应用改了属性：同样重翻（Copy reply）", $("#tip").title === "Copy reply");
  $("#atext").innerHTML = "<p id='ap2'>取消</p>"; await tick();
  ok("AI 正文里后来长出的节点也不碰（内容区永远是内容）", $("#ap2").textContent === "取消");
  // 不自激：我们自己写进去的译文再被观察到时不能又当新源文
  let churn = 0;
  const mo = new MutationObserver((rs) => { churn += rs.length; });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  await tick(); await tick();
  mo.disconnect();
  ok("静止 50ms 内没有任何 DOM 变更（观察者不自激振荡）", churn === 0, churn);
  // 手动 apply 幂等
  const before = document.body.innerHTML;
  I18N.apply(document.body); I18N.apply(document.body);
  ok("重复 apply() 幂等：DOM 一字不变", document.body.innerHTML === before);
  ok("t() 在英文模式下查词：t('保存')=Save，占位 {n} 回填，没词条回中文", I18N.t("保存") === "Save" && I18N.t("已装 {n} 个", { n: 3 }) === "已装 3 个");

  I18N.setLang("zh");
  ok("切回中文：按钮还原到最新源文（删除）、动态节点还原（取消）、属性还原", $("#save").textContent === "删除" && $("#dyn").textContent === "取消" && $("#dyn-in").placeholder === "搜索项目" && $("#tip").title === "复制回复" && $("#input").placeholder.startsWith("今天帮你做些什么"));
  ok("切回中文：<html lang=zh-CN>、混排/状态句还原", document.documentElement.lang === "zh-CN" && $("#mix").textContent === "x 删除" && $("#status").textContent === "第 3 步 · 思考规划中…");
  $("#dyn-host").innerHTML = "<button id='dyn2'>取消</button>"; await tick();
  ok("中文模式下新节点不动（观察者只在英文模式干活）", $("#dyn2").textContent === "取消");
  return names;
})().catch((e) => { throw new Error("[语言] " + ((e && (e.stack || e.message)) || String(e)) + " | 已过 " + (window.__i18nNames || 0)); })
`;

// ---- 二次验证那张卡：绑 / 解 / 换恢复码 ----
// 后端那几条接口早就通了，界面上却一直没有入口——于是「强制二次验证」开关一打开，
// 所有人当场被锁在门外：程序要求他绑，又没给他任何一个能绑的地方。这一屏钉三件会要命的事：
//   · 密钥在验过密码之前不许露脸（它就是账号的第二把钥匙，屏幕前路过一个人就抄走了）；
//   · 恢复码只在生成那一刻出现一次，话得说到；
//   · 组织强制的时候，「关闭」要当场讲清楚为什么关不掉——而不是点下去挨一个 403。
const TFA0 = APP06.indexOf("/**\n * 二次验证：绑、解、换恢复码。");
const TFA1 = APP06.indexOf("// ================= 快捷键面板 =================");
if (TFA0 < 0 || TFA1 <= TFA0) throw new Error("app-06.js 里的 renderTwoFactorBox 找不到了（改名/挪窝？），二次验证卡测试没法定位真源码");
// location.reload（gate 模式绑完要整页重来）在真页面里改不动，navigator.clipboard 在 data: URL
// 这种不安全上下文里压根不存在——两个都包成参数注进去，里面的源码一个字节没动。
const TFA_WRAP = "window.__mkTfa = (location, navigator) => {\n" + APP06.slice(TFA0, TFA1)
  + "\nreturn { renderTwoFactorBox };\n};";
const TFA_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS
  + "</style><body><div id='tfa-box'></div></body>";
const TFA_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const box = document.getElementById("tfa-box");
  const txt = () => box.textContent;
  const $ = (id) => box.querySelector("#" + id);
  const tick = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  window.esc = (s) => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
  window.toast = () => {};

  const SECRET = "JBSWY3DPEHPK3PXP";
  const RC = ["AAAA-1111", "BBBB-2222", "CCCC-3333", "DDDD-4444", "EEEE-5555",
              "FFFF-6666", "GGGG-7777", "HHHH-8888", "IIII-9999", "JJJJ-0000"];
  let state = null, posts = [], next = {};
  window.fetch = (url, opt) => {
    const method = (opt && opt.method) || "GET";
    if (method !== "GET") posts.push({ url, body: opt && opt.body ? JSON.parse(opt.body) : null });
    const body = method === "GET" ? state : (next[url] || { ok: true });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  const nav = { reloads: 0 }, copied = [];
  const T = window.__mkTfa({ reload(){ nav.reloads++; } },
    { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } });
  const draw = async (st, opts) => { state = st; await T.renderTwoFactorBox(box, opts); };

  // ---- 1. 没绑：一句话说清它挡的是什么 ----
  await draw({ on: false, required: false });
  ok("没绑的时候就一颗开关按钮", !!$("tfa-start"));
  ok("说清当前是没开的", txt().includes("当前没开"));
  ok("不强制时它是次要按钮", $("tfa-start").className === "btn-plain");
  ok("★还没验密码，页面上没有密钥★", !txt().includes(SECRET));

  await draw({ on: false, required: true }, { gate: true });
  ok("组织强制时把后果说在明处", txt().includes("别处一步也走不了"));
  ok("挡在工作台前面时它是主按钮", $("tfa-start").className === "btn-brand",
     "那一屏上没有别的事可做，这颗就是唯一的出路");

  // ---- 2. 第一步先对密码 ----
  await draw({ on: false, required: false });
  $("tfa-start").click();
  ok("点开先问密码", !!$("tfa-pw"), "下一屏就会出现密钥，等于账号的第二把钥匙，不能谁路过都看得见");
  next["/api/auth/2fa/setup"] = { error: "密码不对" };
  $("tfa-pw").value = "bad"; $("tfa-pw-go").click(); await tick();
  ok("密码错了原话照抄", $("tfa-err").textContent === "密码不对");
  ok("★密码没过，屏幕上一个字节的密钥都没有★", !txt().includes(SECRET));
  ok("按钮解锁，还能再试", !$("tfa-pw-go").disabled);

  // ---- 3. 验过了才给二维码和密钥 ----
  next["/api/auth/2fa/setup"] = { ok: true, secret: SECRET, otpauth: "otpauth://totp/x", qr: "data:image/png;base64,AAA" };
  $("tfa-pw").value = "pw123456"; $("tfa-pw-go").click(); await tick();
  ok("发出去的就是密码那一条", posts[posts.length - 1].body.password === "pw123456");
  ok("二维码画出来了", !!box.querySelector("img") && box.querySelector("img").src.startsWith("data:image/png"));
  ok("二维码有 alt", box.querySelector("img").alt.length > 0, "读屏的人和图没加载出来的时候都只剩这一句");
  ok("密钥也明文给一份", txt().includes(SECRET), "扫不上的人得手打进验证器");
  ok("还有个回填码的框", !!$("tfa-code"), "信「前端说扫好了」的话，没扫上的人当场把自己锁在门外");

  // 服务端画不出二维码（依赖没装/字符串太长）也不能变成死路
  await draw({ on: false, required: false });
  $("tfa-start").click();
  next["/api/auth/2fa/setup"] = { ok: true, secret: SECRET, otpauth: "otpauth://totp/x", qr: "" };
  $("tfa-pw").value = "pw123456"; $("tfa-pw-go").click(); await tick();
  ok("★二维码画不出来也得能绑下去★", !box.querySelector("img") && txt().includes(SECRET) && !!$("tfa-code"),
     "少一张图不算失败，密钥还在，手打一样能绑");

  // ---- 4. 恢复码：只在这一刻出现一次 ----
  next["/api/auth/2fa/enable"] = { ok: true, recovery: RC };
  $("tfa-code").value = "123456"; $("tfa-enable").click(); await tick();
  ok("验的是填进去的那个码", posts[posts.length - 1].body.code === "123456");
  ok("十条恢复码一条不落地摆出来", RC.every((c) => txt().includes(c)));
  ok("★说清这一屏关掉就再也看不到★", txt().includes("再也看不到"),
     "服务端存的是哈希，它自己也认不回原文——这句不说，丢了的人只会来问「再给我看一次」");
  ok("也说清一条只能用一次", txt().includes("一条只能用一次"));
  $("tfa-copy-rc").click(); await tick();
  ok("「复制全部」真把十条都放进剪贴板", copied[copied.length - 1].split("\\n").length === 10);

  // ---- 5. 存好了之后：设置页回到卡片，挡门那一屏整页重来 ----
  state = { on: true, since: "2026-09-17T00:00:00.000Z", recovery_left: 10, required: false };
  $("tfa-rc-done").click(); await tick();
  ok("设置页里存完回到卡片，显示已开启", txt().includes("已开启") && nav.reloads === 0);

  await draw({ on: false, required: true }, { gate: true });
  $("tfa-start").click();
  next["/api/auth/2fa/setup"] = { ok: true, secret: SECRET, otpauth: "otpauth://totp/x", qr: "" };
  $("tfa-pw").value = "pw123456"; $("tfa-pw-go").click(); await tick();
  $("tfa-code").value = "123456"; $("tfa-enable").click(); await tick();
  $("tfa-rc-done").click(); await tick();
  ok("★挡在门口那一屏绑完要整页重来★", nav.reloads === 1,
     "那一刻之前后端对他每一个 /api/* 都回 403，半路初始化过的界面不如推倒重画");

  // ---- 6. 已开：剩几条写在脸上，快没了要喊 ----
  await draw({ on: true, since: "2026-09-17T00:00:00.000Z", recovery_left: 2, required: false });
  ok("剩几条写在脸上", txt().includes("恢复码还剩 2 条"));
  ok("★剩不多了整句标红★", box.innerHTML.includes("owb-err-text"));
  ok("并且告诉他用光了还有哪条路", txt().includes("openworkbuddy 2fa"),
     "手机再丢一次就只能去那台机器上敲这一句，不写的话等于没有出路");

  // ---- 7. 组织强制的时候，「关闭」点下去要有话说 ----
  await draw({ on: true, since: "2026-09-17T00:00:00.000Z", recovery_left: 8, required: true });
  posts.length = 0;
  $("tfa-off").click(); await tick();
  ok("★强制时「关闭」不发请求★", posts.length === 0, "画一颗点了才挨 403 的按钮，用户只会以为程序坏了");
  ok("而是当场讲清为什么关不掉、该找谁", txt().includes("关不掉") && txt().includes("管理员"));

  // ---- 8. 不强制时关掉：密码和码两样都要 ----
  await draw({ on: true, since: "2026-09-17T00:00:00.000Z", recovery_left: 8, required: false });
  $("tfa-off").click(); await tick();
  ok("关掉要密码 + 码两样", !!$("tfa-off-pw") && !!$("tfa-off-code"));
  next["/api/auth/2fa/disable"] = { ok: true };
  $("tfa-off-pw").value = "pw123456"; $("tfa-off-code").value = "654321";
  posts.length = 0;
  state = { on: false, required: false };
  $("tfa-off-go").click(); await tick();
  ok("两样都发出去了", posts[0] && posts[0].body.password === "pw123456" && posts[0].body.code === "654321");
  ok("关完卡片跟着变回「没开」", txt().includes("当前没开"));

  // ---- 9. 换恢复码：旧的会全废，所以得先验一次码 ----
  await draw({ on: true, since: "2026-09-17T00:00:00.000Z", recovery_left: 8, required: false });
  $("tfa-regen").click(); await tick();
  ok("先说清旧的会全废", txt().includes("原来那批全部作废"));
  ok("★换之前要验一次码★", !!$("tfa-rc-code"),
     "不验的话，电脑没锁人走开，路过的人就能把他手上那张纸变成废纸");

  // ---- 10. 状态取不到也别留一片空白 ----
  await draw(null);
  ok("读不到状态时给一句人话", txt().includes("刷新页面"));

  return names;
})()`;

// ---------- 外观页：主题 / 皮肤 / 字号 / 字体 / 密度 ----------
// 真源切片：app-02 的偏好层（读写本机存储 + 写到 <html>）、app-06 的外观页、app-05 的设置目录
const APP06_LOOK = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-06.js"), "utf8");
// ---- 助理头像编辑器：候选格子必须一样大 ----
// 真凶是 .ava-ic 的 62% 撞上没有宽高的行内盒子：百分比算不出来，浏览器退回 SVG 的
// 默认替换尺寸 300×150。这一屏在真 Chromium 里把格子量出来——量尺寸而不是查类名，
// 因为「类名都写对了、渲染出来还是一巴掌大」正是当时的情形。
const AVA_SRC = (() => {
  const a0 = APP02.indexOf("// ================= 头像编辑器（用户资料和助理设置共用一份）");
  const a1 = APP02.indexOf("// ================= 账号 · 积分 · 用量 =================");
  const b0 = APP02X.indexOf("function esc(s) {"), b1 = APP02X.indexOf("function escInline(s) {");
  const c0 = APP02X.indexOf("function avatarBits(av, fallbackName) {"), c1 = APP02X.indexOf("/** 界面上该怎么称呼当前用户");
  if (a0 < 0 || a1 <= a0 || b0 < 0 || b1 <= b0 || c0 < 0 || c1 <= c0) throw new Error("头像编辑器切片锚点丢了（段标题被改过？）");
  return 'const ASSISTANT_MARK = "@cat";\nfunction toast(m) { window.__toast = m; }\n'
    + APP02X.slice(b0, b1) + "\n" + APP02X.slice(c0, c1) + "\n" + APP02.slice(a0, a1);
})();
// sprite 得真的注进去：isIconName 是靠 document.getElementById("i-…") 查的，
// 没有 sprite 的话每个图标名都会被当成「用户手打的字」，这一屏就测的不是图标了。
const SPRITE_SVG = (() => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const a = html.indexOf('<svg id="owb-sprite"'), b = html.indexOf("</svg>", a);
  if (a < 0 || b <= a) throw new Error("public/index.html 里找不到 sprite，头像测试没法验真图标");
  return html.slice(a, b + 6);
})();
const AVA_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + SPRITE_SVG + "<div class='card-item' id='card' style='width:520px'></div></body>";
const AVA_CHECKS = `
  const names = []; window.__avaNames = 0;
  const ok = (name, cond, extra) => { if (!cond) throw new Error(name + (extra === undefined ? "" : " ← " + JSON.stringify(extra))); names.push(name); window.__avaNames = names.length; };
  const card = document.getElementById("card");
  const box = () => card.querySelector(".ava-ed");
  const picks = () => [...card.querySelectorAll(".ava-pick")];
  const visible = (el) => !!(el && el.getClientRects().length);
  const rect = (el) => el.getBoundingClientRect();
  const open = (av) => {
    card.innerHTML = avatarEditorHtml("as", av, "小猫");
    return bindAvatarEditor(card, "as", av, () => "小猫", ASSISTANT_MARK);
  };
  const shown = () => [...card.querySelectorAll(".ava-ed-main > [data-t]")].filter(visible).map((d) => d.dataset.t).join(",");
  const onNow = () => picks().filter((b) => b.classList.contains("on"));
  const prev = () => card.querySelector("#as-prev");

  // ---- ① 三类候选一样大（这条就是「svg 都很大」的直接对照）----
  let ed = open("brain");
  ok("分类胶囊三个：图标 / 表情 / 图片", [...card.querySelectorAll(".ava-tab")].map((b) => b.textContent).join("/") === "图标/表情/图片");
  ok("图标头像打开时停在「图标」页", shown() === "icon" && card.querySelector('.ava-tab[data-t="icon"]').classList.contains("active"), shown());
  const vis = picks().filter(visible);
  ok("图标页画出了 " + vis.length + " 格候选（猫标 + 图标）", vis.length === 1 + AVATAR_ICONS.length, { vis: vis.length, want: 1 + AVATAR_ICONS.length });
  const sizes = [...new Set(vis.map((b) => Math.round(rect(b).width) + "x" + Math.round(rect(b).height)))];
  ok("每一格都是 36×36，不多出第二种尺寸", sizes.length === 1 && sizes[0] === "36x36", sizes);
  const glyphs = vis.map((b) => b.firstElementChild).filter(Boolean);
  ok("每格里都真有个图形", glyphs.length === vis.length);
  const over = glyphs.filter((g) => rect(g).width > 30 || rect(g).height > 30);
  ok("格子里的图形没有一个溢出格子（老写法这里是 300×150）", over.length === 0,
     over.slice(0, 3).map((g) => Math.round(rect(g).width) + "x" + Math.round(rect(g).height)));
  // ★反向对照★：把老写法（行内盒子、宽高都 auto）摆回来，同一个 .ava-ic 立刻涨到三位数
  {
    const old = document.createElement("div");
    old.innerHTML = '<span style="display:inline-block">' + ic("rocket", "ava-ic") + "</span>";
    card.appendChild(old);
    const blown = rect(old.querySelector("svg"));
    const n = Math.round(blown.width) + "x" + Math.round(blown.height);
    old.remove();
    ok("★反向★ 退回行内盒子，同一个图标量出来是 " + n + "（这就是用户看到的「都很大」）", blown.width > 100 || blown.height > 100, n);
  }

  // ---- ② 表情：用户明确要在这儿能挑表情，也能自己打 ----
  card.querySelector('.ava-tab[data-t="emo"]').click();
  ok("点「表情」翻到表情页，图标页收起来", shown() === "emo", shown());
  ok("表情候选 " + AVATAR_EMOJI.length + " 个全画出来了", picks().filter(visible).length === AVATAR_EMOJI.length, picks().filter(visible).length);
  const emoSizes = [...new Set(picks().filter(visible).map((b) => Math.round(rect(b).width)))];
  ok("表情格子跟图标格子一样宽（36）", emoSizes.length === 1 && emoSizes[0] === 36, emoSizes);
  const oct = picks().find((b) => b.dataset.e === "\\u{1F419}");
  ok("章鱼那格在（表情表真的铺进网格了）", !!oct);
  oct.click();
  ok("点了表情：存的就是那个表情", ed.value() === "\\u{1F419}", ed.value());
  ok("预览里就是那个表情，不是首字母也不是空", prev().textContent.trim() === "\\u{1F419}", prev().textContent);
  ok("预览换成中性底（彩色表情压在品牌渐变上很脏）", prev().classList.contains("emo"));
  ok("高亮只有一格，且正是刚点的那格", onNow().length === 1 && onNow()[0] === oct, onNow().length);
  ok("选中态报给读屏（aria-pressed 只有一个）", oct.getAttribute("aria-pressed") === "true" && picks().filter((b) => b.getAttribute("aria-pressed") === "true").length === 1);

  // 打字/粘贴：表里没有的表情、甚至一个汉字，也得能当头像
  const inp = card.querySelector("#as-emoji");
  inp.value = "喵"; inp.oninput();
  ok("自己打的字也算头像", ed.value() === "喵" && prev().textContent.trim() === "喵", ed.value());
  ok("打了字之后没有哪一格还亮着（选的不是格子里的）", onNow().length === 0);
  inp.value = "\\u{1F47B}"; inp.oninput();
  ok("粘贴表里没有的表情也认", ed.value() === "\\u{1F47B}", ed.value());

  // ---- ③ 恢复默认：回猫标，并且翻回猫标所在那一页 ----
  card.querySelector("#as-clr").click();
  ok("恢复默认回到内置猫标", ed.value() === ASSISTANT_MARK, ed.value());
  ok("恢复默认后翻回「图标」页（不然用户盯着表情页，看不见自己刚恢复成了什么）", shown() === "icon", shown());
  ok("猫标那格亮着，而且就是渐变底那格", onNow().length === 1 && onNow()[0].classList.contains("mk"));
  ok("输入框清空了（@cat 不是能打出来的字）", inp.value === "", inp.value);
  ok("猫标格子选中后还是渐变底（换了底色就认不出那是同一只猫）",
     getComputedStyle(onNow()[0]).backgroundImage.includes("gradient"), getComputedStyle(onNow()[0]).backgroundImage.slice(0, 40));

  // ---- ④ 点图标那格：输入框不许被塞进 "rocket" 这种打不出来的字 ----
  const rocket = picks().find((b) => b.dataset.e === "rocket");
  ok("图标候选里有 rocket", !!rocket);
  rocket.click();
  ok("点图标存的是图标名", ed.value() === "rocket", ed.value());
  ok("图标名不往输入框里塞（塞了用户会以为得自己打 rocket）", inp.value === "", inp.value);
  ok("预览里是那个图标的 <use>", (prev().querySelector("use") || {}).getAttribute && prev().querySelector("use").getAttribute("href") === "#i-rocket",
     prev().innerHTML.slice(0, 60));

  // ---- ⑤ 存量头像打开时停在它自己那一页 ----
  ed = open("\\u{1F419}");
  ok("表情头像打开时停在「表情」页，那一格已经亮着", shown() === "emo" && onNow().length === 1 && onNow()[0].dataset.e === "\\u{1F419}", shown());
  ed = open("data:image/png;base64,iVBORw0KGgo=");
  ok("上传过图片的打开时停在「图片」页", shown() === "img", shown());
  ok("图片头像的预览是那张图本身", !!prev().querySelector("img.ava-img"));

  // ---- ⑥ 落图区：整块框就是那颗按钮----
  const dz = card.querySelector("#as-up");
  ok("整块虚线框自己就是那颗按钮，不是框里再站一颗", !!dz && dz.tagName === "BUTTON" && dz.classList.contains("ava-drop"),
     dz && dz.tagName + "." + dz.className);
  ok("框里没有第二颗按钮跟它抢（以前那颗就是这么显得突兀的）", dz.querySelectorAll("button").length === 0);
  ok("落图区 " + Math.round(rect(dz).height) + "px 高，点哪儿都点得着", rect(dz).height >= 100, Math.round(rect(dz).height));
  ok("框里写明「拖进来」，也写明「不上传任何服务器」", dz.textContent.includes("拖进来") && dz.textContent.includes("不上传任何服务器"), dz.textContent.trim().slice(0, 40));
  ok("有个图片图标垫着，不是干巴巴一行字", !!dz.querySelector('use[href="#i-image"]'));
  {
    const e1 = new DragEvent("dragover", { bubbles: true, cancelable: true });
    dz.dispatchEvent(e1);
    ok("图拖到框上，框亮起来告诉用户「松手就行」", dz.classList.contains("over"));
    ok("★反向★ dragover 真被拦下来了（不拦的话浏览器拿这张图顶掉整页，一屏没保存的设置跟着没）", e1.defaultPrevented);
    dz.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true }));
    ok("拖走了就灭掉", !dz.classList.contains("over"));
  }
  {
    window.__toast = "";
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "季度汇报.pdf", { type: "application/pdf" }));
    const e2 = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    dz.dispatchEvent(e2);
    await new Promise((r) => setTimeout(r, 0));
    ok("拖进来一个不是图片的：指名道姓说哪个文件不行", (window.__toast || "").includes("季度汇报.pdf"), window.__toast);
    ok("拖错了东西，原来的头像一动不动", ed.value() === "data:image/png;base64,iVBORw0KGgo=", ed.value().slice(0, 24));
    ok("松手之后高亮灭掉了", !dz.classList.contains("over"));
  }
  ed = open("");
  ok("空头像退回首字母，且停在「图标」页", prev().textContent.trim() === "小" && shown() === "icon", prev().textContent);
  ok("空头像时一格都不亮", onNow().length === 0);
  return names;
`;
const LOOK_SRC = (() => {
  const a0 = APP02.indexOf("// ---------- 外观：主题"), a1 = APP02.indexOf("// ---------- 头像菜单");
  const b0 = APP06_LOOK.indexOf("// ---------- 外观页"), b1 = APP06_LOOK.indexOf("function renderAboutPane(");
  const c0 = APP05.indexOf("const SETTING_CATS = ["), c1 = APP05.indexOf("];", c0) + 2;
  if (a0 < 0 || a1 < 0 || b0 < 0 || b1 < 0 || c0 < 0) throw new Error("外观切片锚点丢了");
  return APP02.slice(a0, a1) + "\n" + APP06_LOOK.slice(b0, b1) + "\n" + APP05.slice(c0, c1);
})();
const LOOK_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + "<div class='hist-item' id='hi'>历史</div><div class='hist-item active' id='hia'>当前</div>"
  // 气泡 / AI 正文带 translate=no，跟 app-01.js 真渲染出来的标记一致（e2e 的静态闸门盯着那两处）
  + "<div class='turn' id='turn'><div class='u-msg'><div class='bubble' id='bub' translate='no'>你好</div></div>"
  + "<div class='a-msg' id='amsg'><div class='a-text' id='atext' translate='no'><h1 id='h1'>标题</h1><p id='p'>正文</p><code id='cd'>x</code></div></div></div>"
  + "<textarea id='input'></textarea>"
  + "<div class='settings-layout'><div class='settings-nav' id='nav'></div><div class='settings-pane' id='pane'></div></div></body>";
// 改完 <html> 上的属性，得逼这棵树真重算一次再去量。
// 2026-09-13 的 CI（macOS 离屏窗口，没 GPU、没合成器）上是这样的：--owb-fs 已经是 18px 了，
// body 的 font-size 却还报 15px，跟着 calc 走的标题 / 左栏 / 行内代码全停在旧档；
// 而 textarea 和预览行倒是跟上了——同一棵树，一半新一半旧。本机从来不出现。
// 把根节点的 display 摘一下再挂回去，整棵布局树重建，样式必然重算，不靠等下一帧撞运气。
// （滚动引导那块之前也是这个病，当时只用「等一帧」压住了，没查到根上。）
// 凡是「动 <html> 上的属性 → 马上量 computed style」的块都得先注入这一段。
const FLUSH_SRC = `
  const flush = () => {
    const de = document.documentElement, d = de.style.display;
    de.style.display = "none"; void de.offsetHeight; de.style.display = d; void document.body.offsetHeight;
  };
`;
const LOOK_CHECKS = FLUSH_SRC + `
  const names = []; window.__lookNames = 0;
  const $ = (q) => document.querySelector(q);
  const px = (q, prop) => parseFloat(getComputedStyle($(q))[prop || "fontSize"]);
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const html = document.documentElement;
  const pane = $("#pane");
  // 挂了得说清楚现场。这一块的 ok 以前连第三个参数都不收，CI 上就只有一句「外观：点「特大」…」，
  // 本机又是绿的，等于什么都没说——2026-09-13 就这么白跑了一轮。现在每条失败都自动把这一屏的数字带上。
  const one = (q) => { try { return q + "=" + px(q); } catch (e) { return q + "=(没这个元素)"; } };
  const sizes = () => ["body", "#p", "#h1", "#hi", "#input", "#cd", "#look-prev"].map(one).join(" ");
  const dump = () => {
    try {
      const before = sizes(); flush(); const after = sizes();
      return "data-*=" + JSON.stringify(Object.assign({}, html.dataset))
        + " --owb-fs=" + cssVar("--owb-fs") + " --primary=" + cssVar("--primary")
        + " 视口=" + innerWidth + "x" + innerHeight + " dpr=" + devicePixelRatio
        + " " + before + (after === before ? "" : " ｜ 强制重算后变成 " + after + "（那读到的就是陈样式）");
    } catch (e) { return "（连现场都取不到：" + ((e && e.message) || e) + "）"; }
  };
  // 而且不在第一条就停。CI 上跑一趟三分钟，一次只换回一条线索太亏——
  // 「只有一条不对」和「一片全歪了一样多」是两种病，只看第一条分不出来。挂的都收着，块尾一起报。
  const fails = []; window.__lookFails = fails;
  const ok = (name, cond, extra) => {
    if (cond) { names.push(name); window.__lookNames = names.length; return; }
    fails.push("✗ " + name + (extra ? " ｜ " + extra : "") + " ｜ 现场 " + dump());
    // 挂到第六条就别往下跑了：这时候页面状态已经不可信，再往后收的都是噪音
    if (fails.length >= 6) throw new Error("外观：挂太多，后面的状态已经不可信，先报这些：\\n" + fails.join("\\n"));
  };
  // 存储被禁的页面（data: URL）：这正是要验证「退到内存也能用」的环境
  let storageBlocked = false; try { localStorage.getItem("x"); } catch { storageBlocked = true; }
  ok("本页 localStorage 被禁（验证内存回退的前提成立）", storageBlocked);

  ok("默认：<html> 不带 data-fs/skin/font/density 脏属性", !html.dataset.fs && !html.dataset.skin && !html.dataset.font && !html.dataset.density);
  // 左栏这一条量的是 .hist-item（任务历史）。它比正文小两号是有意的：历史是次要内容，
  ok("默认：正文 15 / 标题 17 / 左栏历史 13 / 输入框 15 / 行内代码 13", px("body") === 15 && px("#h1") === 17 && px("#hi") === 13 && px("#input") === 15 && px("#cd") === 13);

  I18N.setLang("zh"); // 系统语言可能是英文；下面按中文文案断言，先钉住
  renderLookPane(pane);
  const groups = [...pane.querySelectorAll("[data-k]")].map((g) => g.dataset.k);
  ok("外观页六个分区：语言/主题/皮肤/字号/字体/密度", JSON.stringify(groups) === JSON.stringify(["lang", "theme", "skin", "fs", "font", "density"]));
  const cnt = (k) => pane.querySelectorAll('[data-k="' + k + '"] button').length;
  ok("选项数：语言 2 · 主题 3 · 皮肤 6 · 字号 4 · 字体 3 · 密度 2", cnt("lang") === 2 && cnt("theme") === 3 && cnt("skin") === 6 && cnt("fs") === 4 && cnt("font") === 3 && cnt("density") === 2);
  const onePressed = (k) => { const bs = [...pane.querySelectorAll('[data-k="' + k + '"] button')]; const on = bs.filter((b) => b.classList.contains("on")), pr = bs.filter((b) => b.getAttribute("aria-pressed") === "true"); return on.length === 1 && pr.length === 1 && on[0] === pr[0]; };
  // 去 emoji：分区标题以前是「🌐 语言 / 🌗 主题 / 🎨 皮肤」，现在一律走 ic()。
  // 钉住「画出来的 svg」而不是「有没有那个字」——表情当图标，翻译器会把它当正文一起翻走
  const heads = [...pane.querySelectorAll(".card-item > .t")];
  const headIcons = heads.map((h) => { const u = h.querySelector("use"); return u ? u.getAttribute("href") : "(这行没画图标)"; });
  ok("六个分区标题都是画出来的图标（" + headIcons.join(" ") + "）", heads.length === 6 && headIcons.every((h) => h.startsWith("#i-")) && new Set(headIcons).size === 6);
  ok("负对照：这把尺子认得出图标各不相同（语言=globe · 皮肤=palette · 字号=a-large-small）", headIcons[0] === "#i-globe" && headIcons[2] === "#i-palette" && headIcons[3] === "#i-a-large-small");
  ok("主题三档也是图标：太阳 / 月亮 / 显示器", [...pane.querySelectorAll('[data-k="theme"] button use')].map((u) => u.getAttribute("href")).join() === "#i-sun,#i-moon,#i-monitor");
  ok("整页一个表情符号都不剩", !/[\u{1F000}-\u{1FAFF}\u{FE0F}\u{2705}\u{274C}\u{26A0}\u{1F3A8}\u{1F310}]/u.test(pane.textContent), pane.textContent.slice(0, 60));
  ok("每组恰好一个选中（.on + aria-pressed）", ["lang", "theme", "skin", "fs", "font", "density"].every(onePressed));
  ok("默认选中：中文 / 跟随系统 / 默认紫 / 标准 / 系统 / 舒适", ["zh", "system", "default", "m", "system", "cozy"].every((v, i) => pane.querySelector('[data-k="' + groups[i] + '"] button.on').dataset.v === v));
  ok("全是 <button type=button>，没有「保存」键（点即生效）", [...pane.querySelectorAll("button")].every((b) => b.type === "button") && !/保存/.test(pane.textContent));
  const textLen = pane.textContent.replace(/\\s/g, "").length;
  ok("信息密度克制：整页文字 ≤ 230 字（实际 " + textLen + "）", textLen <= 230);

  const click = (k, v) => { pane.querySelector('[data-k="' + k + '"] button[data-v="' + v + '"]').click(); flush(); };
  // 字号
  click("fs", "xl");
  ok("点「特大」：<html data-fs=xl>，正文 18", html.dataset.fs === "xl" && px("body") === 18 && px("#p") === 18);
  ok("特大：标题 20 / 左栏历史 16 / 输入框 18 / 行内代码 16 / 预览行 18 都跟着走", px("#h1") === 20 && px("#hi") === 16 && px("#input") === 18 && px("#cd") === 16 && px("#look-prev") === 18);
  ok("特大：字号组选中态跟着切到 xl", onePressed("fs") && pane.querySelector('[data-k="fs"] button.on').dataset.v === "xl");
  click("fs", "s");
  ok("点「小」：正文 14 / 左栏历史 12", html.dataset.fs === "s" && px("body") === 14 && px("#hi") === 12);
  ok("偏好读回：lookGet('fs') === 's'（存储被禁也记得住）", lookGet("fs") === "s");
  click("fs", "m");
  ok("点回「标准」：data-fs 属性摘掉，不留默认值脏属性", !("fs" in html.dataset) && px("body") === 15);

  // 皮肤
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return "rgb(" + (n >> 16) + ", " + ((n >> 8) & 255) + ", " + (n & 255) + ")"; };
  click("skin", "ocean");
  ok("点「海盐」：<html data-skin=ocean>，--primary 变海盐蓝", html.dataset.skin === "ocean" && rgb("#0284c7") === rgb("#" + cssVar("--primary").replace("#", "")));
  ok("海盐：用户气泡底色跟着换（不是只换了个变量没人用）", getComputedStyle($("#bub")).backgroundColor === rgb("#0284c7"));
  ok("海盐：浅色下品牌字色是深一档的 #0369a1（不拿填充色当字色）", cssVar("--brand-text").toLowerCase() === "#0369a1");
  // 对比度矩阵：6 皮肤 × 2 主题，品牌字色压页面底色 ≥ 4.5，白字压主色 ≥ 3
  const lum = (c) => { const m = c.match(/\\d+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const probe = document.createElement("div"); document.body.appendChild(probe);
  const resolve = (v) => { probe.style.color = "var(" + v + ")"; return getComputedStyle(probe).color; };
  // 读一次不算数：CI 上 body 的 computed style 会慢一拍（字号那几条就是这么挂的）。
  // 读 → 逼重算 → 再读，两次一样才认；抖过就把抖动过程记下来，别让它悄悄过去。
  const settle = (read) => {
    let v = read(); const drift = [];
    for (let i = 0; i < 4; i++) { flush(); const now = read(); if (now === v) break; drift.push(v + "→" + now); v = now; }
    return { v, drift };
  };
  let combos = 0, minText = 99, minBtn = 99, worst = "";
  const rows = [], drifted = [];
  for (const skin of Object.keys(LOOK_OPTS.skin)) for (const theme of ["light", "dark"]) {
    const combo = skin + "/" + theme;
    setLook("skin", skin); setTheme(theme); flush(); combos++;
    const sBg = settle(() => getComputedStyle(document.body).backgroundColor);
    const sBt = settle(() => resolve("--brand-text"));
    const sPr = settle(() => resolve("--primary"));
    const rt = ratio(sBt.v, sBg.v), rb = ratio("rgb(255, 255, 255)", sPr.v);
    for (const [what, d] of [["底色", sBg.drift], ["品牌字色", sBt.drift], ["主色", sPr.drift]]) {
      if (d.length) drifted.push(combo + " 的" + what + " " + d.join(" "));
    }
    rows.push(combo + " 底" + sBg.v + " 字" + sBt.v + " 主" + sPr.v + " 文" + rt.toFixed(2) + " 钮" + rb.toFixed(2));
    if (rt < minText) { minText = rt; worst = combo; }
    if (rb < minBtn) minBtn = rb;
  }
  probe.remove();
  const matrix = rows.join(" ｜ ") + (drifted.length ? " ｜ 读到陈样式（重算后才变）：" + drifted.join("；") : " ｜ 十二组都是一次读稳的");
  ok("对比度矩阵跑满 6 皮肤 × 2 主题 = 12 组", combos === 12, matrix);
  ok("每组品牌字色压底色 ≥ 4.5（最低 " + minText.toFixed(2) + " @ " + worst + "）", minText >= 4.5, matrix);
  ok("每组白字压主色 ≥ 3（最低 " + minBtn.toFixed(2) + "）", minBtn >= 3, matrix);
  setTheme("light");
  renderLookPane(pane); flush();
  ok("重开外观页：皮肤/主题选中态从偏好里读回来（石墨 · 浅色）", pane.querySelector('[data-k="skin"] button.on').dataset.v === "graphite" && pane.querySelector('[data-k="theme"] button.on').dataset.v === "light");
  click("skin", "default");
  ok("点回「默认紫」：data-skin 摘掉，--primary 回到 #5b5ff7", !("skin" in html.dataset) && cssVar("--primary").toLowerCase() === "#5b5ff7");

  // 密度
  const turnMb = () => px("#turn", "marginBottom"), histPt = () => px("#hi", "paddingTop"), lh = () => px("#atext", "lineHeight");
  const mb0 = turnMb(), pt0 = histPt(), lh0 = lh();
  click("density", "compact");
  ok("点「紧凑」：轮次间距 " + mb0 + "→" + turnMb() + "、左栏行内距 " + pt0 + "→" + histPt() + "、行高收紧，字号不动", html.dataset.density === "compact" && turnMb() < mb0 && histPt() < pt0 && lh() < lh0 && px("body") === 15);
  click("density", "cozy");
  ok("点回「舒适」：属性摘掉，间距复原", !("density" in html.dataset) && turnMb() === mb0 && histPt() === pt0);

  // 字体
  const ff = () => getComputedStyle(document.body).fontFamily;
  const ff0 = ff();
  click("font", "serif");
  ok("点「衬线」：body 字体族以 Georgia 打头", html.dataset.font === "serif" && /^Georgia/.test(ff()));
  click("font", "mono");
  ok("点「等宽」：body 字体族含 Menlo / monospace", html.dataset.font === "mono" && /Menlo|monospace/.test(ff()));
  click("font", "system");
  ok("点回「系统」：属性摘掉，字体族复原（-apple-system 打头）", !("font" in html.dataset) && ff() === ff0 && /apple-system/.test(ff0));

  // 语言：点即整页切换，内容区不动
  click("lang", "en");
  ok("点 English：外观页标题立刻变英文（Theme）、<html lang=en>、English 选中", /Theme/.test(pane.textContent) && !/主题/.test(pane.textContent) && html.lang === "en" && onePressed("lang") && pane.querySelector('[data-k="lang"] button.on').dataset.v === "en");
  ok("English：左栏「当前」等界面词翻了（Current），用户气泡「你好」和 AI 正文「标题/正文」原样（内容不是界面）", $("#hia").textContent === "Current" && $("#bub").textContent === "你好" && $("#h1").textContent === "标题" && $("#p").textContent === "正文");
  ok("English：语言偏好读回 en（存储被禁也记得住）", I18N.getLang() === "en");
  renderLookPane(pane);
  await new Promise((r) => setTimeout(r, 25)); // 观察者是异步的：应用写完 innerHTML，下一拍才翻
  ok("English 下重开外观页：新渲染的中文文案也被翻成英文（Skin）", /Skin/.test(pane.textContent) && !/皮肤/.test(pane.textContent));
  click("lang", "zh");
  ok("点回 中文：整页还原（主题）、<html lang=zh-CN>", /主题/.test(pane.textContent) && !/Theme/.test(pane.textContent) && html.lang === "zh-CN" && I18N.getLang() === "zh");

  // 主题
  click("theme", "dark");
  ok("点「深色」：<html data-theme=dark>，getTheme()==='dark'，主题组选中态跟着走", html.dataset.theme === "dark" && getTheme() === "dark" && pane.querySelector('[data-k="theme"] button.on').dataset.v === "dark");
  click("theme", "system");
  const sysDark = matchMedia("(prefers-color-scheme: dark)").matches;
  ok("点「跟随系统」：data-theme 跟系统（当前系统=" + (sysDark ? "深" : "浅") + "）", getTheme() === "system" && html.dataset.theme === (sysDark ? "dark" : "light"));
  click("theme", "light");

  // 非法值：来自旧版本或被人手改过的存储，不能把页面搞坏
  setLook("fs", "huge"); setLook("nope", "x"); setTheme("neon"); flush();
  ok("非法值一律忽略：fs 仍是标准、theme 仍是浅色、未知键不炸", lookGet("fs") === "m" && !("fs" in html.dataset) && getTheme() === "light");
  lookMem["owb-look-fs"] = "huge"; lookMem["owb-theme"] = "neon"; applyLook(); applyTheme(); flush();
  ok("存储里躺着旧版本写的非法值：读回当没写（标准字号 / 跟随系统），不带脏属性", lookGet("fs") === "m" && !("fs" in html.dataset) && getTheme() === "system");
  setTheme("light"); flush();
  ok("点分区空白处：不改任何状态、不报错", (() => { pane.querySelector(".card-item").click(); return lookGet("fs") === "m" && getTheme() === "light"; })());

  // 左栏目录：图标 + 短名，别一列密密麻麻的字
  ok("设置目录 14 项都带图标、名字 ≤ 4 字，且含「外观」", SETTING_CATS.length === 14 && SETTING_CATS.every(([k, l, i]) => i && l.length <= 4) && SETTING_CATS.some(([k, l]) => k === "look" && l === "外观"));
  if (fails.length) throw new Error("外观：" + (names.length + fails.length) + " 条里挂了 " + fails.length + " 条：\\n" + fails.join("\\n"));
  return names;
`;

// ---------- 输入框 token 高亮：镜像层得跟 textarea 逐字对齐 ----------
// 用户报的是「用技能的时候那个阴影没遮住整个词」。根因不在那条正则，在两层的排版参数：
// 镜像层当年是开页那一刻把 textarea 的字号抄一份写进内联样式，抄完就再也不更新——
// 用户去设置里把字号调大，只有 textarea 跟着变，底色停在旧尺寸上，一个技能名只遮住半个词。
// 所以这一段不验「有没有画出 span」，验的是「画出来的那个框跟真文字严丝合缝」：
// 拿 textarea 的 computed style 复刻一个探针 div，用 Range 量出技能名真正占的那块地方，
// 再跟镜像层里那个 .tk 的位置尺寸对一遍。对不上就是用户看见的那个症状。
const HL_SRC = (() => {
  const a0 = APP02X.indexOf("// ---------- @文件 /技能 /素材锚点高亮");
  const a1 = APP02X.indexOf('inputEl.addEventListener("input", detectMention);');
  if (a0 < 0 || a1 <= a0) throw new Error("输入框高亮切片锚点丢了");
  return APP02X.slice(a0, a1);
})();
const HL_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + "<div style='width:360px;padding:12px'><div id='input-box'><div id='input-hl' aria-hidden='true'></div>"
  + "<textarea id='input' rows='2'></textarea></div></div></body>";
const HL_STUBS = `
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  const inputEl = document.getElementById("input");
  const skillsCache = [{ name: "写周报" }, { name: "archify" }];
`;
const HL_CHECKS = FLUSH_SRC + `
  const names = []; window.__hlNames = 0;
  const ok = (name, cond, extra) => { if (!cond) throw new Error("输入框高亮：" + name + (extra ? " ← " + extra : "")); names.push(name); window.__hlNames = names.length; };
  const ta = inputEl, hl = document.getElementById("input-hl");

  // 决定文字排在哪儿的那些属性，一项都不能两层不一样
  const METRICS = ["fontSize", "fontFamily", "fontWeight", "lineHeight", "letterSpacing", "wordSpacing",
    "whiteSpace", "overflowWrap", "wordBreak", "textIndent", "tabSize", "direction",
    "paddingTop", "paddingLeft", "paddingRight", "borderTopWidth", "borderLeftWidth"];
  const snap = (el) => METRICS.map((k) => k + "=" + getComputedStyle(el)[k]).join(" · ");
  ok("排版参数两层逐项一致（" + snap(ta) + "）", snap(ta) === snap(hl), snap(hl));

  // 探针：完整复刻 textarea 的 computed style，用来量「这段字真正占了哪块地方」
  const probe = document.createElement("div");
  const mkProbe = () => {
    const cs = getComputedStyle(ta);
    probe.removeAttribute("style");
    for (const k of cs) probe.style.setProperty(k, cs.getPropertyValue(k));
    probe.style.boxSizing = "content-box";
    probe.style.width = cs.width;
    probe.style.position = "absolute";
    probe.style.left = "-9999px";
    probe.style.top = "0";
    probe.style.height = "auto";
    probe.style.maxHeight = "none";
    probe.style.overflow = "visible";
    probe.style.visibility = "hidden";
  };
  document.body.appendChild(probe);

  // 量：文本里第 i 个字符起、长 n 个字符，那块地方相对自己容器左上角的位置和大小
  const rectIn = (host, node, i, n) => {
    const r = document.createRange();
    r.setStart(node, i); r.setEnd(node, i + n);
    const b = r.getBoundingClientRect(), h = host.getBoundingClientRect();
    return { x: b.left - h.left, y: b.top - h.top, w: b.width, h: b.height };
  };
  const spanBox = () => {
    const sp = hl.querySelector(".tk");
    if (!sp) return null;
    const b = sp.getBoundingClientRect(), h = hl.getBoundingClientRect();
    return { x: b.left - h.left, y: b.top - h.top, w: b.width, h: b.height, text: sp.textContent };
  };
  // 镜像层里那个框，跟探针量出来的真文字位置，差多少
  const gap = (text, tok) => {
    ta.value = text;
    ta.dispatchEvent(new Event("input"));
    // 每次量之前都逼一次重算：探针是照抄 textarea 的 computed style 做的，
    // CI 离屏窗口上这份 style 会慢一拍，抄到旧值就等于拿旧尺子量新框。
    flush();
    mkProbe();
    probe.textContent = text;
    const at = text.indexOf(tok);
    const want = rectIn(probe, probe.firstChild, at, tok.length);
    const got = spanBox();
    if (!got) return { miss: "镜像层没画出 .tk" };
    return {
      text: got.text,
      dx: Math.abs(got.x - want.x), dy: Math.abs(got.y - want.y),
      dw: Math.abs(got.w - want.w), dh: Math.abs(got.h - want.h),
      want, got,
    };
  };
  const fit = (g) => !g.miss && g.dx <= 0.6 && g.dy <= 0.6 && g.dw <= 0.6 && g.dh <= 0.6;
  const say = (g) => g.miss || ("偏 " + g.dx.toFixed(1) + "/" + g.dy.toFixed(1) + "，尺寸差 " + g.dw.toFixed(1) + "/" + g.dh.toFixed(1) + "，量到 " + JSON.stringify(g.want) + " 画成 " + JSON.stringify(g.got));

  const g1 = gap("帮我 /写周报 这个月的", "/写周报");
  ok("技能名整个词都被框住，不是只剩半个（" + g1.text + "）", g1.text === "/写周报");
  ok("行首这一条：框的位置尺寸跟真文字对得上（" + say(g1) + "）", fit(g1));

  // 折行那一行最容易露馅：两层断词规则只要差一点，行尾那个词就错位
  const long = "先把上个季度所有渠道的投放数据都汇总一遍然后 /写周报 顺便把结论写清楚";
  const g2 = gap(long, "/写周报");
  ok("长文折行后：框还跟着真文字走（" + say(g2) + "）", fit(g2));
  ok("折行这一条真的折了行（技能名不在第一行）", g2.got && g2.got.y > g2.got.h * 0.9, JSON.stringify(g2.got));

  // 字号改大：这正是当年抄一次就不更新那个 bug 的现场
  document.documentElement.dataset.fs = "xl"; flush();
  const g3 = gap("帮我 /写周报 这个月的", "/写周报");
  ok("设置里把字号调到特大：两层一起变大（正文 " + getComputedStyle(ta).fontSize + "）", parseFloat(getComputedStyle(ta).fontSize) > 15 && snap(ta) === snap(hl));
  ok("特大字号下框还严丝合缝（" + say(g3) + "）", fit(g3));
  delete document.documentElement.dataset.fs; flush();

  // 负对照：这把尺子得能红。把镜像层字号单独改掉，框立刻对不上。
  // 先确认这一改真的生效了——不然「尺子没红」量的是尺子坏了还是改根本没落地，分不清。
  hl.style.fontSize = "20px"; flush();
  const hlFs = getComputedStyle(hl).fontSize;
  ok("负对照的前置：镜像层字号确实被改成了 20px（量到 " + hlFs + "）", parseFloat(hlFs) === 20,
    "改没落地的话，下面那条「尺子该红」就是无效对照，别当成尺子坏了");
  const bad = gap("帮我 /写周报 这个月的", "/写周报");
  ok("负对照：镜像层字号被单独改掉时，这把尺子当场判不合格（" + say(bad) + "）", !fit(bad),
    "镜像层 " + hlFs + "，正文 " + getComputedStyle(ta).fontSize);
  hl.style.fontSize = ""; flush();
  const back = gap("帮我 /写周报 这个月的", "/写周报");
  ok("撤掉之后又合格了（尺子本身没坏）", fit(back), say(back));

  // 该框的和不该框的
  ta.value = "看看 /Users/demo/note.md 这个文件"; ta.dispatchEvent(new Event("input"));
  ok("负对照：/Users/... 这种路径不是技能，不给它画框", !hl.querySelector(".tk"), hl.innerHTML.slice(0, 80));
  ta.value = "看看 @report.md 里写了什么"; ta.dispatchEvent(new Event("input"));
  ok("@文件 一律画框，整个文件名都在框里", (hl.querySelector(".tk") || {}).textContent === "@report.md");
  ta.value = ""; ta.dispatchEvent(new Event("input"));
  ok("清空输入框：镜像层跟着清干净，不留上一条的底色", hl.innerHTML === "");

  probe.remove();
  return names;
`;

// ---------- 头像菜单：语言快切（点即切、菜单不关、文案原地翻；「改名字 · 换头像」尾注已删） ----------
const MENU_SRC = (() => {
  const a0 = APP02.indexOf("// ---------- 头像菜单"), a1 = APP02.indexOf('document.addEventListener("click", (e) => { if (!e.target.closest("#user-row")) closeUserMenu(); });');
  if (a0 < 0 || a1 < 0) throw new Error("头像菜单切片锚点丢了");
  return APP02.slice(a0, a1);
})();
const MENU_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + "<div class='hist-item active' id='hia'>当前</div>"
  + "<div id='user-row' style='position:relative;width:260px;margin-top:320px'><div class='user-menu' id='user-menu'></div></div></body>";
const MENU_STUBS = `
  ${IC_STUB}
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function avatarBits(av, name) { return { cls: "", html: esc(String(name || "?").slice(0, 1).toUpperCase()) }; }
  function displayName(u) { return (u && (u.nickname || u.username)) || ""; }
  const MODALS = []; function openModal(k, sub) { MODALS.push(k + ":" + (sub || "")); }
  function renderProfile() {} function checkUpdate() { MODALS.push("update"); }
  // 这几格照着 account.js 的 publicUser 摆。少一格 can_admin，替身就跟真界面分了叉，
  // 分叉之后这一整块测的是一个线上不存在的界面
  let currentUser = { username: "demo", role: "admin", role_label: "管理员", can_admin: true, is_admin: true, avatar: "", credits: 0 }; const creditsOn = false;
`;
const MENU_CHECKS = `
  const names = []; window.__menuNames = 0;
  // 第三个参数是现场：别的块都收，这块以前不收，挂了只剩条目名，等于没说
  const ok = (name, cond, extra) => { if (!cond) throw new Error("头像菜单：" + name + (extra ? " ｜ " + extra : "")); names.push(name); window.__menuNames = names.length; };
  const $ = (q) => document.querySelector(q);
  const tick = () => new Promise((r) => setTimeout(r, 25)); // 英文模式下翻译靠观察者，下一拍才落
  const menu = $("#user-menu");
  const acts = () => [...menu.querySelectorAll(".um-i")].map((x) => x.dataset.act).join(",");
  const langRow = () => menu.querySelector(".um-lang");
  const btn = (v) => menu.querySelector('.um-seg button[data-lang="' + v + '"]');
  I18N.setLang("zh");
  openUserMenu();
  ok("打开：菜单显示，九行动作 = 个人资料/修改密码/设置/企业后台/语言/外观/帮助/更新/退出", menu.classList.contains("show") && acts() === "profile,password,settings,admin,lang,appearance,help,update,logout", acts());
  // 「改自己的密码」这条以前只藏在「账号 · 用量」那一屏里、跟退出登录挤在一行的 float:right 小按钮上。
  // 接口一直都在、那一屏也一直都在，可用户翻遍了没找着，原话是「我要能修改自己的账户密码啊」——
  // 开关存在但找不到就等于没有。所以这条钉在头像菜单里：点头像一眼就看得见
  ok("头像菜单里有「修改密码」这一行，且是所有人都看得见（不是管理员专享）", /修改密码/.test(menu.textContent) && !!menu.querySelector('[data-act="password"]'), menu.textContent.slice(0, 120));
  const iconOf = (sel) => { const u = menu.querySelector(sel + " use"); return u ? u.getAttribute("href") : "(这行没画图标)"; };
  ok("企业后台这行只剩名字，不再把后台目录（成员 · 用量 · 安全）抄一遍", /企业管理后台/.test(menu.textContent) && !/成员 · 用量 · 安全/.test(menu.textContent) && !menu.querySelector('[data-act="admin"] .hint'));
  // 九行动作每行都得有图标，而且是各自那一个——以前这里是 🏢🪪⚙️ 一串表情，翻译一过就被当正文
  ok("九行动作用的是图标不是表情：每行一个 svg，图标各不相同", (() => {
    const rows = [...menu.querySelectorAll(".um-i")];
    const hrefs = rows.map((r) => { const u = r.querySelector("use"); return u ? u.getAttribute("href") : null; });
    return rows.length === 9 && hrefs.every(Boolean) && new Set(hrefs).size === 9;
  })(), [...menu.querySelectorAll(".um-i")].map((r) => (r.querySelector("use") || {}).getAttribute && r.querySelector("use").getAttribute("href")).join(","));
  ok("负对照：这把尺子认得出图标不一样（企业后台=building-2，个人资料=id-card）", iconOf('[data-act="admin"]') === "#i-building-2" && iconOf('[data-act="profile"]') === "#i-id-card");
  ok("菜单里一个表情都不剩", !/[\u{1F300}-\u{1FAFF}\u{FE0F}\u{2699}\u{1F6E1}]/u.test(menu.textContent), menu.textContent.slice(0, 80));
  ok("「个人资料」后面不再挂「改名字 · 换头像」尾注", !/改名字|换头像/.test(menu.textContent) && !menu.querySelector('[data-act="profile"] .hint'));
  ok("语言行：语言 + 中 / En 两个胶囊，中文选中（.on + aria-pressed）", !!langRow() && /语言/.test(langRow().textContent) && (langRow().querySelector("use") || {}).getAttribute && langRow().querySelector("use").getAttribute("href") === "#i-globe" && !!btn("zh") && !!btn("en") && btn("zh").classList.contains("on") && btn("zh").getAttribute("aria-pressed") === "true" && !btn("en").classList.contains("on") && btn("en").getAttribute("aria-pressed") === "false");
  ok("胶囊组标了 data-i18n-skip，「中 / En」不会被翻译器动", langRow().querySelector(".um-seg").hasAttribute("data-i18n-skip") && btn("zh").textContent === "中" && btn("en").textContent === "En");
  const bgOn = getComputedStyle(btn("zh")).backgroundColor, bgOff = getComputedStyle(btn("en")).backgroundColor;
  ok("选中胶囊有品牌底色，未选中透明（" + bgOn + " / " + bgOff + "）", bgOn !== bgOff && /rgba\\(0, 0, 0, 0\\)|transparent/.test(bgOff));
  ok("胶囊够大能点：高 ≥ 18px、宽 ≥ 30px", btn("zh").getBoundingClientRect().height >= 18 && btn("zh").getBoundingClientRect().width >= 30);
  ok("外观行不再念两个默认值（跟随系统 · 标准字）", !/跟随系统|标准字/.test(menu.textContent) && !menu.querySelector('[data-act="appearance"] .hint'));
  btn("en").click(); await tick();
  ok("点 En：语言=en，菜单没关", I18N.getLang() === "en" && menu.classList.contains("show"));
  ok("点 En：菜单文案原地变英文（Profile / Settings / Language / Appearance），En 选中", /Profile/.test(menu.textContent) && /Settings/.test(menu.textContent) && /Language/.test(menu.textContent) && /Appearance/.test(menu.textContent) && btn("en").classList.contains("on") && !btn("zh").classList.contains("on"));
  // 词条当年是按「🪪 个人资料」收的，图标换成 svg 之后文本节点只剩「个人资料」。
  // 这条钉的是那条自动补出来的无表情别名真的生效了——不生效就会中英混着显示。
  ok("英文下图标一个没少、一个没混进文字里", menu.querySelectorAll(".um-i use").length === 9 && !/🪪|⚙️|🌐|🎨/.test(menu.textContent), menu.textContent.slice(0, 90));
  ok("点 En：菜单外的界面词也翻了（左栏「当前」→ Current）、<html lang=en>", $("#hia").textContent === "Current" && document.documentElement.lang === "en");
  ok("English 下「中 / En」本身原样", btn("zh").textContent === "中" && btn("en").textContent === "En");
  btn("en").click(); await tick();
  ok("重复点 En：还是 en，不抖", I18N.getLang() === "en" && btn("en").classList.contains("on") && menu.classList.contains("show"));
  langRow().click(); await tick();
  ok("点语言行空白处：中英之间翻（en → zh），整页还原（当前 / 个人资料），中 选中", I18N.getLang() === "zh" && $("#hia").textContent === "当前" && /个人资料/.test(menu.textContent) && !/Profile/.test(menu.textContent) && btn("zh").classList.contains("on") && document.documentElement.lang === "zh-CN");
  langRow().click(); await tick();
  ok("再点一次行：zh → en", I18N.getLang() === "en" && /Profile/.test(menu.textContent) && btn("en").classList.contains("on"));
  ok("切语言全程没误开弹窗", MODALS.length === 0);
  menu.querySelector('[data-act="appearance"]').click();
  ok("点「外观」：开设置→外观页并关菜单（其它行行为不变）", MODALS.join() === "settings:look" && !menu.classList.contains("show"));
  openUserMenu(); await tick();
  ok("English 下重开菜单：直接是英文，En 选中", /Settings/.test(menu.textContent) && btn("en").classList.contains("on"));
  closeUserMenu(); I18N.setLang("zh");

  // 企业后台入口是按角色发的。这行要是对普通成员也冒出来，他点进去只会连吃 403——
  // 一个点了就报错的入口，比没有这个入口更伤人
  currentUser = { username: "xiaoyuan", role: "member", role_label: "成员", can_admin: false, is_admin: false, avatar: "", credits: 0 };
  openUserMenu();
  ok("普通成员：菜单里根本没有企业后台这一行", !menu.querySelector('[data-act="admin"]') && !/企业管理后台/.test(menu.textContent));
  ok("反向对照：普通成员的其它八行一个不少", acts() === "profile,password,settings,lang,appearance,help,update,logout", acts());
  // 「修改密码」不是管理员专享：每个账号都得能改自己的密码（后端 POST /api/auth/password 本来就对所有人开着）
  ok("普通成员一样看得见「修改密码」", !!menu.querySelector('[data-act="password"]'), acts());
  currentUser = { username: "kuaiji", role: "auditor", role_label: "审计员", can_admin: true, is_admin: false, avatar: "", credits: 0 };
  openUserMenu();
  ok("审计员：看得见入口，但标着「只读」（他进去只能查账改不动）", !!menu.querySelector('[data-act="admin"]') && /只读/.test(menu.querySelector('[data-act="admin"]').textContent));
  ok("审计员的头衔不冒充管理员（头部写的是「· 审计员」）", /· 审计员/.test(menu.querySelector(".um-head").textContent) && !/· 管理员/.test(menu.querySelector(".um-head").textContent));

  // 超管这一档是后加的。加一档角色最容易漏的就是这种「按角色名写死」的地方，
  // 漏掉的样子是权限最大的那个人反而看不见入口——而看不见的东西没人会来报
  currentUser = { username: "laoban", role: "owner", role_label: "超级管理员", can_admin: true, is_admin: true, avatar: "", credits: 0 };
  openUserMenu();
  ok("★超级管理员：入口在，而且不带「只读」★", !!menu.querySelector('[data-act="admin"]') && !/只读/.test(menu.querySelector('[data-act="admin"]').textContent));
  ok("超管的头衔写的是「· 超级管理员」，不是「· 管理员」", /· 超级管理员/.test(menu.querySelector(".um-head").textContent));
  currentUser = { username: "demo", role: "admin", role_label: "管理员", can_admin: true, is_admin: true, avatar: "", credits: 0 };
  closeUserMenu();
  return names;
`;

const TRAIL_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const disp = (el) => getComputedStyle(el).display;
  const chips = (t) => [...t.querySelectorAll(".proc-head .trail .tc")];
  // 测试页是 data: URL（不透明源），localStorage 一碰就抛。塞个内存版，
  // 这样「展开/收起记不记得住」这件事能真测，而不是靠 try/catch 糊过去
  const LS = {};
  try { localStorage.getItem("owb_proc_open"); } catch {
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (k) => (k in LS ? LS[k] : null), setItem: (k, v) => { LS[k] = String(v); }, removeItem: (k) => { delete LS[k]; },
    } });
  }

  // ---- 1. 一轮完整的执行：读×2（合并）、命令（出错）、写、飞书（MCP） ----
  const ui = createTurnUI("做个页面", "craft", "s_t");
  const t = ui.turn;
  ui.handleEvent({ type: "text", delta: "先看看文件" });
  ui.handleEvent({ type: "tool_use", id: "a", name: "read_file", purpose: "读 a", at: 1000 });
  ok("第一步就挂上徽章且在转", chips(t).length === 1 && chips(t)[0].classList.contains("run"));
  ok("徽章用短标签不用原名", chips(t)[0].textContent.trim() === "读", chips(t)[0].textContent);
  ok("徽章前头那个是画出来的图标，不是表情", chips(t)[0].querySelector("use").getAttribute("href") === "#i-file-text", chips(t)[0].innerHTML.slice(0, 80));
  ok("运行中样式是真画出来的", getComputedStyle(chips(t)[0]).color !== getComputedStyle(t.querySelector(".pt")).color);
  ui.handleEvent({ type: "tool_result", id: "a", name: "read_file", preview: "ok", at: 3500 });
  ok("回来后不转了", !chips(t)[0].classList.contains("run"));
  ok("回放带的时间戳算出每步耗时", chips(t)[0].title === "read_file · 3s", chips(t)[0].title);
  ui.handleEvent({ type: "tool_use", id: "b", name: "read_file", purpose: "读 b" });
  ok("连续同名合并成 ×2 而不是两枚", chips(t).length === 1 && chips(t)[0].querySelector("b").textContent === "×2", chips(t).map((c) => c.textContent).join("|"));
  ok("合并进来的新一张又在转", chips(t)[0].classList.contains("run"));
  ui.handleEvent({ type: "tool_result", id: "b", name: "read_file", preview: "ok" });
  ok("都回来了才落定", !chips(t)[0].classList.contains("run"));
  ui.handleEvent({ type: "tool_use", id: "c", name: "run_shell", purpose: "跑" });
  ui.handleEvent({ type: "tool_result", id: "c", name: "run_shell", isError: true, preview: "exit 1" });
  ui.handleEvent({ type: "tool_use", id: "d", name: "write_file", purpose: "写" });
  ui.handleEvent({ type: "tool_result", id: "d", name: "write_file", preview: "ok" });
  ui.handleEvent({ type: "tool_use", id: "e", name: "mcp_feishu_send", purpose: "发" });
  ui.handleEvent({ type: "tool_result", id: "e", name: "mcp_feishu_send", preview: "ok" });
  ui.handleEvent({ type: "text", delta: "做完了" });
  // 跑的时候过程区默认收起，
  // 但「跑到哪了」那一行必须一直看得见，而且要钉在视口顶上，不能被日志顶走
  const runWrap = t.querySelector(".proc-wrap");
  ok("跑的时候执行过程默认是收起的", !runWrap.classList.contains("open") && disp(runWrap.querySelector(".proc-body")) === "none");
  ok("但那一行进度始终露在外面", disp(runWrap.querySelector(".proc-head")) !== "none" && /运行中|第 \\d+ 步/.test(runWrap.querySelector(".pt").textContent + " 运行中"));
  ok("运行中的进度条是 sticky（真样式，不是写在注释里）", getComputedStyle(runWrap.querySelector(".proc-head")).position === "sticky", getComputedStyle(runWrap.querySelector(".proc-head")).position);
  ok("轨迹徽章收起时照样看得见，扫一眼知道走了哪几步", chips(t).every((c) => disp(c) !== "none"));
  // 点一下能展开，而且这个选择记下来：下次开的任务直接按你上次的来
  runWrap.querySelector(".proc-head").click();
  ok("点标题能展开看细节", runWrap.classList.contains("open") && disp(runWrap.querySelector(".proc-body")) !== "none");
  ok("展开这个选择被记住了", localStorage.getItem("owb_proc_open") === "1", String(localStorage.getItem("owb_proc_open")));
  runWrap.querySelector(".proc-head").click();
  ok("再点收起，记的也跟着改", !runWrap.classList.contains("open") && localStorage.getItem("owb_proc_open") === "0");

  // ---- 执行过程一行流：「[图标] 读 报告.md · 120 行」，参数收在卡里 ----
  // 参数是排障才要看的，「在干什么 + 拿回来多少」才是每一步都该露在外面的那半句。
  const u9 = createTurnUI("看一眼", "craft", "s_t");
  u9.handleEvent({ type: "tool_use", id: "x", name: "read_file", title: "读 报告.md", input_preview: '{"path":"报告.md"}' });
  const c9 = u9.turn.querySelector(".step-card");
  ok("那一行写的是在干什么，不是工具名", /读 报告\\.md/.test(c9.querySelector(".desc").textContent) && !/read_file/.test(c9.querySelector(".desc").textContent), c9.querySelector(".desc").textContent);
  ok("标签只剩一个图标，不再把 read_file 印上去",
    c9.querySelector(".tag").textContent.trim() === "" && c9.querySelector(".tag use").getAttribute("href") === "#i-file-text",
    c9.querySelector(".tag").innerHTML.slice(0, 80));
  ok("原始入参一个字没丢，只是收着", /报告\.md/.test(c9.querySelector("pre").textContent) && disp(c9.querySelector("pre")) === "none");
  u9.handleEvent({ type: "tool_result", id: "x", name: "read_file", outcome: "120 行", preview: "..." });
  ok("结果的量就写在同一行上", c9.querySelector(".out").textContent === "· 120 行", c9.querySelector(".out").textContent);
  // 「·」左边必须真的挨着标题。以前 .desc 是 flex:1，短标题会把圆点一路推到右半边，
  // 前面空一大片，看着像个没有主语的孤儿点。这里钉的是「标题右边缘到圆点左边缘」的实测距离。
  {
    const d9 = c9.querySelector(".desc").getBoundingClientRect(), o9 = c9.querySelector(".out").getBoundingClientRect();
    ok("「· 120 行」紧跟在标题后面，不是被推到行右", o9.left - d9.right < 20, "间隔 " + Math.round(o9.left - d9.right) + "px");
  }
  u9.handleEvent({ type: "tool_use", id: "y", name: "run_shell", title: "命令 npm test" });
  u9.handleEvent({ type: "tool_result", id: "y", name: "run_shell", isError: true, outcome: "退出码 1：2 个用例没过" });
  const c9b = [...u9.turn.querySelectorAll(".step-card")][1];
  ok("失败的原因也端到那一行上（不用一张张点开）", /2 个用例没过/.test(c9b.querySelector(".out").textContent), c9b.querySelector(".out").textContent);
  ok("失败那半句是红的（真样式）", getComputedStyle(c9b.querySelector(".out")).color !== getComputedStyle(c9.querySelector(".out")).color, getComputedStyle(c9b.querySelector(".out")).color);
  // 负向控制：回放老会话（事件里根本没有 title/outcome）不许把那一行留成空白
  u9.handleEvent({ type: "tool_use", id: "z", name: "mcp_feishu_send", purpose: "发通知" });
  const c9c = [...u9.turn.querySelectorAll(".step-card")][2];
  ok("老会话没带 title 也不开天窗", /mcp_feishu_send/.test(c9c.querySelector(".desc").textContent) && /发通知/.test(c9c.querySelector(".desc").textContent), c9c.querySelector(".desc").textContent);

  // ---- 里程碑常驻行：过程区收着也一直看得见跑到哪了 ----
  const live = u9.turn.querySelector(".proc-head .ms-live");
  ok("还没有里程碑时这一行不占地方", !!live && live.hidden);
  u9.handleEvent({ type: "milestones", file: "PROGRESS.md", items: [{ text: "收集资料", done: true }, { text: "写第二章", done: false }, { text: "导出成品", done: false }] });
  ok("有里程碑就露出来", !live.hidden && disp(live) !== "none");
  ok("写清做完几件、现在在做哪件", /1\\/3/.test(live.textContent) && /写第二章/.test(live.textContent), live.textContent);
  ok("它在折叠条里，跟着一起钉在视口顶上", live.closest(".proc-head") === u9.turn.querySelector(".proc-head"));
  ok("过程区收着的时候它照样看得见", !u9.turn.querySelector(".proc-wrap").classList.contains("open") && disp(live) !== "none");
  u9.handleEvent({ type: "milestones", file: "PROGRESS.md", items: [{ text: "收集资料", done: true }, { text: "写第二章", done: true }, { text: "导出成品", done: true }] });
  ok("全做完了就说全部完成", /3\\/3/.test(live.textContent) && /全部完成/.test(live.textContent), live.textContent);
  u9.finish();

  // ---- 本机引擎那条「已启动」：是事实不是进度，得钉住，别转圈也别被正文抹掉 ----
  const u10 = createTurnUI("跑一趟", "craft", "s_t");
  u10.handleEvent({ type: "status", text: "本机 Claude Code 已启动（模型 claude-opus-5，102 个工具），不消耗 API 额度", model: "claude-opus-5" });
  const reChip = u10.turn.querySelector(".run-eng");
  ok("引擎启动挂成一枚常驻小牌子", !!reChip && !u10.turn.querySelector(".thinking-hint"));
  ok("牌子上写清谁在跑、用什么模型、花不花钱", /本机 Claude Code/.test(reChip.textContent) && /claude-opus-5/.test(reChip.textContent) && /不花 API 额度/.test(reChip.textContent), reChip.textContent);
  ok("它不转圈（早就跑起来了，转圈是骗人）", !reChip.querySelector(".spinner"));
  u10.handleEvent({ type: "text", delta: "开始干活" });
  ok("正文来了它还在（回头还能查这趟走的哪条路）", !!u10.turn.querySelector(".run-eng"));
  u10.handleEvent({ type: "status", text: "模型 40 秒没吐字，重试中…" });
  ok("负向控制：普通状态还是那条会转的提示，不占牌子", !!u10.turn.querySelector(".thinking-hint .spinner") && u10.turn.querySelectorAll(".run-eng").length === 1);
  u10.handleEvent({ type: "status", text: "本机 Claude Code 已启动（模型 claude-opus-5，102 个工具），不消耗 API 额度", model: "claude-opus-5" });
  ok("重连再报一次也只有一枚牌子", u10.turn.querySelectorAll(".run-eng").length === 1);
  u10.finish();

  // ---- 冷启动那几秒：claude 自己从 spawn 到吐 init 要 3.8~7.2 秒，这几秒界面不该是空的 ----
  const u10b = createTurnUI("跑一趟", "craft", "s_t2");
  u10b.handleEvent({ type: "status", starting: true, text: "本机 Claude Code 正在启动（连接工具中，一般 3~8 秒），不消耗 API 额度" });
  const boot = u10b.turn.querySelector(".run-eng");
  ok("按下发送就有牌子，不用干等 CLI 冷启动", !!boot && !u10b.turn.querySelector(".thinking-hint"));
  ok("占位牌子转圈，并说清在等什么", !!boot.querySelector(".spinner") && /连接工具中/.test(boot.textContent), boot.textContent);
  ok("占位期就写清不花 API 额度（用户问的正是这个）", /不花 API 额度/.test(boot.textContent));
  u10b.handleEvent({ type: "status", text: "本机 Claude Code 已启动（模型 claude-opus-5，102 个工具），不消耗 API 额度", model: "claude-opus-5" });
  ok("init 到了原地换成正式版，还是同一枚（不闪、不跳）", u10b.turn.querySelectorAll(".run-eng").length === 1 && u10b.turn.querySelector(".run-eng") === boot);
  ok("正式版不转圈了，写上模型和工具数", !boot.querySelector(".spinner") && /claude-opus-5/.test(boot.textContent) && /102 个工具/.test(boot.textContent), boot.textContent);
  u10b.handleEvent({ type: "status", text: "模型 40 秒没吐字，重试中…" });
  ok("负向控制：普通状态仍走会转的提示行，不许顶掉牌子", !!u10b.turn.querySelector(".thinking-hint .spinner") && u10b.turn.querySelectorAll(".run-eng").length === 1);
  u10b.finish();

  // ---- 每步耗时 + 收尾那笔时间账 ----
  // Langfuse 那条路要先去搭实例、填两把钥匙；而「这趟到底慢在哪」本地就该当场答得上来。
  const durOf = (c) => c.querySelector(".dur").textContent;
  const B = 1757000000000; // 固定基准时刻：这些断言算的全是差值，不许沾墙上时钟
  const u11 = createTurnUI("查一遍", "craft", "s_t");
  u11.handleEvent({ type: "tool_use", id: "p", name: "read_file", title: "读 报告.md", at: B + 1000 });
  const cp = u11.turn.querySelector(".step-card");
  ok("还没回来时这一格是空的（不预先编一个数）", durOf(cp) === "", JSON.stringify(durOf(cp)));
  ok("空的那一格不占地方（真样式）", disp(cp.querySelector(".dur")) === "none", disp(cp.querySelector(".dur")));
  // 两个只读工具是并发跑的：p 占 [1.0s, 5.0s]，q 占 [2.0s, 6.0s]
  u11.handleEvent({ type: "tool_use", id: "q", name: "read_file", title: "读 数据.csv", at: B + 2000 });
  u11.handleEvent({ type: "tool_result", id: "p", name: "read_file", outcome: "120 行", at: B + 5000 });
  ok("回来了就把这一步花了多久写死在卡上", durOf(cp) === "4.0s", durOf(cp));
  ok("写上了就看得见（不是被 :empty 规则连坐）", disp(cp.querySelector(".dur")) !== "none");
  u11.handleEvent({ type: "tool_result", id: "q", name: "read_file", outcome: "8 列", at: B + 6000 });
  u11.handleEvent({ type: "tool_use", id: "r", name: "run_shell", title: "命令 npm test", at: B + 10000 });
  u11.handleEvent({ type: "tool_result", id: "r", name: "run_shell", outcome: "全绿", at: B + 10480 });
  const c11 = [...u11.turn.querySelectorAll(".step-card")];
  ok("不到一秒的步子带小数，不是一律写成 1s", durOf(c11[2]) === "0.5s", durOf(c11[2]));
  u11.handleEvent({ type: "usage", prompt: 10, completion: 10, cached: 0, calls: 3, elapsed_ms: 12000, model: "m", provider: "P" });
  u11.finish();
  const sum = u11.turn.querySelector(".proc-sum");
  ok("收尾在过程区底下记一笔时间账", !!sum && sum.parentElement === u11.turn.querySelector(".proc-body"));
  const sumTxt = sum.querySelector(".ps-row").textContent;
  ok("总耗时用的是这一趟真实的数", /^共 12s：/.test(sumTxt), sumTxt);
  // 并发那两步各 4s，各步相加是 8.5s——比总耗时还离谱。合并重叠后是 [1.0,6.0] + [10.0,10.48] = 5.5s
  ok("工具时间按重叠合并，不是各步相加（负向对照：不许出现 8.5s）", /工具占了 5\\.5s/.test(sumTxt) && !/8\\.5s/.test(sumTxt), sumTxt);
  ok("剩下那截如实写成「模型在想 + 等网络」，不冒充成模型耗时", /其余 6\\.5s 是模型在想 \\+ 等网络/.test(sumTxt), sumTxt);
  const slowTxt = sum.querySelector(".ps-slow").textContent;
  ok("最慢那几步按人话的名字点出来，最慢的排头一个", /^最慢：读 报告\\.md 4\\.0s · 读 数据\\.csv 4\\.0s/.test(slowTxt), slowTxt);
  ok("0.5s 那步排在最后，不冒充最慢", slowTxt.indexOf("命令 npm test") > slowTxt.indexOf("读 数据.csv"), slowTxt);
  const more = sum.querySelector(".ps-more");
  ok("没开 Langfuse 也有得看：入口指在这儿（要展开过程区才看得见，不往对话里插横幅骚扰）", /打开执行追踪/.test(more.textContent), more.textContent);
  VIEWS.length = 0; MODALS.length = 0;
  more.click();
  // 本地那本账一直在记，所以这里该开的是「更多 → 执行追踪」那一页，不是设置里那半页 Langfuse 配置。
  // 指回设置，用户点进去看到的是两个填 Key 的输入框，跟他想看的「这趟调了什么」没一点关系
  ok("点它直接开「更多 → 执行追踪」那一页", VIEWS.join() === "trace", VIEWS.join() + " ｜ modal=" + MODALS.join());
  ok("★反向对照★ 不再跳去设置页（那儿现在只剩 Langfuse 的连接配置）", MODALS.length === 0, MODALS.join());

  // 开了 Langfuse：直接给这一趟的地址，别让人自己去 trace 列表里猜哪条是刚才那趟
  const u12 = createTurnUI("再跑一趟", "craft", "s_t");
  u12.handleEvent({ type: "trace", url: "https://cloud.langfuse.com/project/p1/traces/abc" });
  u12.handleEvent({ type: "tool_use", id: "s", name: "read_file", title: "读 a.md", at: B });
  u12.handleEvent({ type: "tool_result", id: "s", name: "read_file", at: B + 2000 });
  // 全程 2.2s 里工具占了 2.0s：剩下 0.2s 不值得单独说一句
  u12.handleEvent({ type: "usage", prompt: 1, completion: 1, cached: 0, calls: 1, elapsed_ms: 2200, model: "m", provider: "P" });
  u12.finish();
  const sum2 = u12.turn.querySelector(".proc-sum");
  const more2 = sum2.querySelector(".ps-more");
  ok("开了追踪就直接给这一趟的地址", more2.getAttribute("href") === "https://cloud.langfuse.com/project/p1/traces/abc" && more2.target === "_blank" && /noopener/.test(more2.rel), more2.getAttribute("href"));
  ok("给了地址就不再反过来问「要不要打开追踪」", !/打开执行追踪/.test(more2.textContent), more2.textContent);
  ok("剩下不到一秒就不硬凑「其余 … 在想」那半句", /^共 2s：工具占了 2\\.0s（1 步，并发的已按重叠合并）$/.test(sum2.querySelector(".ps-row").textContent), sum2.querySelector(".ps-row").textContent);
  ok("只有一步时不摆「最慢」榜（一个人的排行榜是废话）", !sum2.querySelector(".ps-slow"));

  // 负向对照：老会话两头都没盖过时间戳。回放是一个同步循环跑完的，两头差几毫秒——
  // 印成「<0.1s」不是「这步很快」，是「这步根本没记过时间」，那是编的
  const u13 = createTurnUI("翻个老会话", "craft", "s_t");
  u13.handleEvent({ type: "tool_use", id: "o", name: "read_file", title: "读 旧.md" });
  { const e13 = Date.now() + 6; while (Date.now() < e13); } // 回放循环本身也要跑几毫秒，别让「差值正好是 0」替这条断言干活
  u13.handleEvent({ type: "tool_result", id: "o", name: "read_file", preview: "ok" });
  const c13 = u13.turn.querySelector(".step-card");
  ok("负向对照：没记过时间的老会话宁可空着，也不编一个耗时出来", durOf(c13) === "" && !/NaN/.test(c13.textContent), JSON.stringify(durOf(c13)));
  u13.handleEvent({ type: "usage", prompt: 1, completion: 1, cached: 0, calls: 1, elapsed_ms: 4000, model: "m", provider: "P" });
  u13.finish();
  ok("负向对照：一步都没记过时间就不记这笔账（不拿 0 当事实）", !u13.turn.querySelector(".proc-sum"));

  // 跑着的那一格得自己走秒：一步卡了两分钟和一步刚开始，光看转圈是一模一样的
  const u14 = createTurnUI("跑着看", "craft", "s_t");
  u14.handleEvent({ type: "tool_use", id: "w", name: "run_shell", title: "命令 长活" });
  const c14 = u14.turn.querySelector(".step-card");
  c14._at = Date.now() - 42000; // 假装已经跑了 42 秒，省得真在这儿等
  await new Promise((r) => setTimeout(r, 1150)); // 计时器一秒一拍
  ok("还没回来的卡自己走秒，卡了多久一眼看得见", /^4[234]s$/.test(durOf(c14)), durOf(c14));
  ok("走秒用等宽数字，读秒时整行不左右跳", getComputedStyle(c14.querySelector(".dur")).fontVariantNumeric === "tabular-nums", getComputedStyle(c14.querySelector(".dur")).fontVariantNumeric);
  u14.finish();
  ok("被打断/没回来的那步不算进时间账（只有 _dur 记过的才算）", !u14.turn.querySelector(".proc-sum"));

  ok("五步四枚徽章（同名合并）", chips(t).length === 4, String(chips(t).length));
  ok("出错那步标红", chips(t)[1].classList.contains("err") && chips(t)[1].dataset.name === "run_shell");
  ok("没出错的不标红", !chips(t)[0].classList.contains("err") && !chips(t)[2].classList.contains("err"));
  ok("出错样式是真画出来的", getComputedStyle(chips(t)[1]).color !== getComputedStyle(chips(t)[2]).color, getComputedStyle(chips(t)[1]).color);
  ok("MCP 工具名去前缀、下划线变空格", chips(t)[3].textContent === "feishu send", chips(t)[3].textContent);
  ok("徽章 title 是原名，悬停能看全（耗时后缀可有可无，别测墙上时钟）", /^mcp_feishu_send( · \\d+[ms]\\S*)?$/.test(chips(t)[3].title), chips(t)[3].title);
  ui.handleEvent({ type: "usage", prompt: 1000, completion: 100, cached: 30000, calls: 2, elapsed_ms: 5000, model: "m", provider: "P" });
  ui.finish();
  const wrap = t.querySelector(".proc-wrap");
  ok("收尾写清耗时和步数", wrap.querySelector(".pt").textContent === "已完成 5s · 5 步", wrap.querySelector(".pt").textContent);
  ok("回合结束过程区收起", !wrap.classList.contains("open") && disp(wrap.querySelector(".proc-body")) === "none");
  ok("跑完了进度条不再钉在顶上占地方", !wrap.classList.contains("running") && getComputedStyle(wrap.querySelector(".proc-head")).position !== "sticky");
  ok("收起了轨迹条照样看得见（真样式）", disp(wrap.querySelector(".trail")) !== "none" && chips(t).every((c) => disp(c) !== "none"));
  ok("出错角标挂上", /1 步出错/.test(wrap.querySelector(".proc-warn").textContent));
  const body = t.querySelector(".body");
  const texts = [...body.querySelectorAll(":scope > .a-text")];
  ok("开场白和结论都在过程区外面", texts.length === 2 && wrap.querySelector(".proc-body").querySelectorAll(":scope > .a-text").length === 0, texts.length + " / " + wrap.querySelector(".proc-body").querySelectorAll(":scope > .a-text").length);
  ok("结论排在过程区后面、开场白在前面", (texts[1].compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_PRECEDING) && (texts[0].compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING));
  ok("操作条命中率封顶 100%", /缓存命中 100%/.test(t.querySelector(".ta-meta").textContent), t.querySelector(".ta-meta").textContent);
  ok("回合结束后没有还在转的", !t.querySelector(".spinner"));
  // 点徽章：展开过程区 + 打开最近那张卡；点击不冒泡到折叠条（否则一点开又合上）
  chips(t)[0].click();
  ok("点徽章展开过程区", wrap.classList.contains("open") && disp(wrap.querySelector(".proc-body")) === "block");
  const cards = [...wrap.querySelectorAll(".step-card")];
  ok("点徽章打开的是合并组里最近那张卡", cards[1].classList.contains("open") && !cards[0].classList.contains("open"));
  chips(t)[1].click();
  ok("点出错徽章直达出错那张卡", cards[2].classList.contains("open") && wrap.classList.contains("open"));

  // ---- 2. 中止：回合结束时还没回来的步骤，徽章标中止、不再转 ----
  const u2 = createTurnUI("中止", "craft", "s_t");
  u2.handleEvent({ type: "tool_use", id: "x", name: "run_node", purpose: "跑" });
  u2.finish();
  const c2 = chips(u2.turn);
  ok("没回来的步骤标中止", c2.length === 1 && c2[0].classList.contains("abort") && !c2[0].classList.contains("run"));
  ok("中止样式是删除线（真样式）", /line-through/.test(getComputedStyle(c2[0]).textDecorationLine), getComputedStyle(c2[0]).textDecorationLine);
  ok("卡片上也写了中止", /中止/.test(u2.turn.querySelector(".step-card .head").textContent));

  // ---- 3. 上限：14 个不同工具 → 12 枚 + 「+2」，折进去的步骤结果回来也不炸 ----
  const u3 = createTurnUI("多步", "craft", "s_t");
  const many = ["read_file", "write_file", "edit_file", "list_files", "search_files", "run_shell", "run_node", "web_search", "fetch_url", "render_page", "check_page", "html_to_image", "look_at_image", "generate_image"];
  many.forEach((n, i) => u3.handleEvent({ type: "tool_use", id: "m" + i, name: n }));
  many.forEach((n, i) => u3.handleEvent({ type: "tool_result", id: "m" + i, name: n, preview: "ok", isError: i === 13 }));
  const c3 = chips(u3.turn);
  ok("超过 12 步折成 +N", c3.filter((c) => !c.classList.contains("more")).length === 12 && c3.at(-1).classList.contains("more") && c3.at(-1).textContent === "+2", c3.map((c) => c.textContent).join("|"));
  ok("折进 +N 的步骤回来了不炸、+N 不变色", !c3.at(-1).classList.contains("err") && !c3.at(-1).classList.contains("run"));
  u3.finish();
  ok("14 步都数上", /14 步/.test(u3.turn.querySelector(".pt").textContent), u3.turn.querySelector(".pt").textContent);

  // ---- 4. 正常口径的命中率是算出来的，不是写死 100 ----
  const u4 = createTurnUI("算", "craft", "s_t");
  u4.handleEvent({ type: "tool_use", id: "y", name: "read_file" });
  u4.handleEvent({ type: "tool_result", id: "y", name: "read_file", preview: "ok" });
  u4.handleEvent({ type: "usage", prompt: 31000, completion: 100, cached: 30000, calls: 1, elapsed_ms: 1000, model: "m", provider: "P" });
  u4.finish();
  ok("正常账命中率照实算（97%）", /缓存命中 97%/.test(u4.turn.querySelector(".ta-meta").textContent), u4.turn.querySelector(".ta-meta").textContent);

  // ---- 5. 没跑工具的回合：没有过程区、没有轨迹条 ----
  const u5 = createTurnUI("聊", "chat", "s_t");
  u5.handleEvent({ type: "text", delta: "你好" });
  u5.finish();
  ok("纯聊天没有过程区", !u5.turn.querySelector(".proc-wrap"));

  // ---- 6. 没 id 的结果按深度配对（老会话回放）也能落到徽章上 ----
  const u6 = createTurnUI("老", "craft", "s_t");
  u6.handleEvent({ type: "tool_use", name: "web_search" });
  u6.handleEvent({ type: "tool_result", name: "web_search", isError: true, preview: "超时" });
  ok("没 id 的结果也标到徽章上", chips(u6.turn)[0].classList.contains("err") && !chips(u6.turn)[0].classList.contains("run"));

  // ---- 7. 跑完这一趟：正文里的文件名能点开，成品自动摊在右边 ----
  //          「不仅结束了没有预览，还看到这个文件夹」
  // ARRIVAL 那块验的是 fileLinkTargets / finishPreviewPlan 这几个纯函数本身；
  // 这里验的是另一条线：事件流真跑一遍，finish() 到底有没有把它们接上。
  {
    window.renderTurnOutputs = () => {};
    window.renderFiles = () => {};
    window.outputArrivalPlan = () => ({ snapshot: true, badge: 0, refresh: null });
    window.applyOutputArrival = () => {};
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const setW = (n) => Object.defineProperty(window, "innerWidth", { configurable: true, value: n });
    const reset = (w) => { setW(w); window.PV.length = 0; pvPanel.classList.remove("show"); pvCurrent = null; pvClosedAt = 0; };
    const F = (name) => ({ name, size: 100, mtime: "2026-09-10T08:35:00.000Z" });
    const OUT = [F("任务_0910/张三_简历.html"), F("任务_0910/张三_简历.docx"), F("任务_0910/PROGRESS.md")];
    const feed = (u, line, outs) => {
      u.handleEvent({ type: "text", delta: line });
      u.handleEvent({ type: "files", files: outs, changed: outs.map((f) => f.name) });
    };
    const LINE = "改好了，成品在 任务_0910/张三_简历.html，Word 版另存了一份。";

    reset(1200);
    const uf = createTurnUI("帮我改简历", "craft", "s_t");
    feed(uf, LINE, OUT);
    await nap(160); // 等流式那一帧真渲出来，别用"还没渲"糊过这条
    const txt = uf.turn.querySelector(".a-text");
    ok("流着的时候正文已经渲出来了，但一个链接都还没插（边流边插会被下一帧抹掉）",
      /张三_简历\.html/.test(txt.textContent) && !txt.querySelector(".file-ln"), txt.textContent.slice(0, 40));
    uf.finish();
    const lns = [...uf.turn.querySelectorAll(".a-text .file-ln")];
    ok("收尾后正文里那个文件名成了能点的链接", lns.length === 1 && lns[0].dataset.name === "任务_0910/张三_简历.html",
      lns.map((a) => a.textContent).join("|"));
    ok("正文一个字没少（只是把文件名包了起来）", txt.textContent === LINE, txt.textContent);
    const cs = getComputedStyle(lns[0]);
    ok("链接一眼看得出能点：虚下划线 + 手型（真样式，不是类名）",
      cs.textDecorationStyle === "dotted" && cs.cursor === "pointer", cs.textDecorationStyle + "/" + cs.cursor);
    ok("跑完自动把成品摊开，开的是网页版而不是 PROGRESS.md", window.PV.length === 1 && window.PV[0] === "任务_0910/张三_简历.html", window.PV.join("|"));
    lns[0].click();
    ok("点正文里的链接也在右边打开它", window.PV.length === 2 && window.PV[1] === "任务_0910/张三_简历.html", window.PV.join("|"));

    // 反向对照一：窗口窄，右边根本没地方摆 → 链接照给，预览不弹
    reset(800);
    const un = createTurnUI("再改一版", "craft", "s_t");
    feed(un, LINE, OUT);
    un.finish();
    ok("窄窗口：链接照给，但不抢版面弹预览",
      un.turn.querySelectorAll(".a-text .file-ln").length === 1 && window.PV.length === 0, window.PV.join("|"));

    // 反向对照二：这一趟里用户自己把预览关掉过 → 别再给他弹回来
    reset(1200);
    const uc = createTurnUI("第三版", "craft", "s_t");
    feed(uc, LINE, OUT);
    await nap(2); // 得真晚于 t0：pvClosedAt 是毫秒，同一毫秒里关掉不算"这趟关过"
    pvClosedAt = Date.now();
    uc.finish();
    ok("用户这趟自己关过预览：收尾不再弹回来", window.PV.length === 0, window.PV.join("|"));

    // 反向对照三：这趟只动了 PROGRESS.md 这种脚手架 → 有链接可点，但没有"成品"可摊
    reset(1200);
    const us = createTurnUI("记一下进度", "chat", "s_t");
    feed(us, "进度写在 任务_0910/PROGRESS.md 了。", [F("任务_0910/PROGRESS.md")]);
    us.finish();
    ok("只写了 PROGRESS.md：正文照样能点开看，但不当成品弹预览",
      us.turn.querySelectorAll(".a-text .file-ln").length === 1 && window.PV.length === 0, window.PV.join("|"));

    // 反向对照四：这趟啥也没产出 → 正文里就算写了个像文件名的词也不许变链接
    reset(1200);
    const u0 = createTurnUI("聊两句", "chat", "s_t");
    u0.handleEvent({ type: "text", delta: "你可以看看 别的项目/说明.md 这份文档。" });
    u0.finish();
    ok("这趟没产出：正文里像文件名的词一律不碰，右侧也不动",
      u0.turn.querySelectorAll(".a-text .file-ln").length === 0 && window.PV.length === 0);
    setW(900);
  }

  // ---- 折叠条上那行「此刻在干什么」 ----
  // 病根不是没信息，是信息全锁在默认收起的 .proc-body 里，外面只剩「运行中 3m20s · 第 7 步」——
  // 那说的是跑了多久，不是在干什么。所以两头都验：纯函数出的话对不对，以及它在**收着**的时候看不看得见。
  {
    const nap2 = (ms) => new Promise((r) => setTimeout(r, ms));
    const LA = (ev, narr) => liveActivity(ev, narr || "");
    const line = (ev, narr) => LA(ev, narr).line;
    const icon = (ev, narr) => LA(ev, narr).icon;
    // 话和图标是分开返的：话要能翻译、能截断、能进 textContent；图标只是 sprite 里的一个 id。
    // 以前两者拼成一句「📄 读 报告.md」，英文界面下那个表情翻不掉，字典里还得连图一起抄一遍。
    ok("动作行·调工具：服务端算好的「动词 + 对象」，这一格里只剩字",
      line({ type: "tool_use", name: "read_file", title: "读 报告.md" }) === "读 报告.md",
      line({ type: "tool_use", name: "read_file", title: "读 报告.md" }));
    ok("动作行·图标另算一格，按工具名查表（读文件配 file-text）",
      icon({ type: "tool_use", name: "read_file", title: "读 报告.md" }) === "file-text",
      icon({ type: "tool_use", name: "read_file", title: "读 报告.md" }));
    ok("动作行·老会话回放没 title：退回短名 + purpose",
      line({ type: "tool_use", name: "read_file", purpose: "简历.md" }) === "读 简历.md",
      line({ type: "tool_use", name: "read_file", purpose: "简历.md" }));
    ok("动作行·认不出的 MCP 工具也有话说，不留空",
      line({ type: "tool_use", name: "mcp_feishu_send", title: "发 群消息" }) === "发 群消息",
      line({ type: "tool_use", name: "mcp_feishu_send", title: "发 群消息" }));
    ok("动作行·认不出的工具图标也有兜底（settings），不留个空洞",
      icon({ type: "tool_use", name: "mcp_feishu_send", title: "发 群消息" }) === "settings",
      icon({ type: "tool_use", name: "mcp_feishu_send", title: "发 群消息" }));
    ok("动作行·专家干的活前面挂专家名，别看着像主线自己在跑",
      line({ type: "tool_use", name: "web_search", title: "搜「深圳 OPC」", expert: "调研" }) === "调研 · 搜「深圳 OPC」",
      line({ type: "tool_use", name: "web_search", title: "搜「深圳 OPC」", expert: "调研" }));
    // 这一整组断言的前提是「话里不许再有表情」。挨个事件扫一遍，漏一条就炸
    {
      const EMO = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/u;
      const evs = [
        { type: "tool_use", name: "read_file", title: "读 报告.md" },
        { type: "tool_result", name: "run_shell", isError: true, outcome: "exit 1" },
        { type: "parallel", count: 6 }, { type: "step_start", step: 7 },
        { type: "expert_start", expert: "调研", task: "查一下" }, { type: "compact", removed: 7 },
        { type: "trim" }, { type: "failover" }, { type: "auto_continue", round: 2, total: 3 },
        { type: "limit" }, { type: "sleep" }, { type: "ask_user" },
        { type: "status", text: "本地服务起来了", starting: true },
      ];
      const dirty = evs.map((e) => LA(e).line).filter((l) => l && EMO.test(l));
      ok("动作行·十三种事件的话里都不带表情了（图标归图标那一格）", dirty.length === 0, dirty.join("|"));
      ok("负对照：这把尺子是真量得出表情的", EMO.test("📄 读") && EMO.test("⚡ 并发") && EMO.test("⚙ 设置"));
      ok("负对照：每种事件都真出了一句话，不是全 null 混过去", evs.filter((e) => LA(e).line).length === evs.length);
      ok("负对照：每种事件也都真配了图标", evs.filter((e) => LA(e).icon).length === evs.length);
    }
    const longLine = line({ type: "tool_use", name: "run_shell", title: "命令 " + "x".repeat(200) });
    ok("动作行·话太长就截断加省略号，不把折叠条撑开", longLine.length <= 64 && longLine.slice(-1) === "…", longLine.length + "/" + longLine.slice(-3));
    const n1 = LA({ type: "text", delta: "深圳本地的入口比预想的清晰得多。" });
    const n2 = LA({ type: "text", delta: "我抓几份原文确认细节。" }, n1.narr);
    ok("动作行·正文旁白播的是最后一句，不是整段被截得只剩开头", n2.line === "我抓几份原文确认细节。", n2.line);
    ok("动作行·正文旁白配的是笔的图标", n2.icon === "pen-line", n2.icon);
    ok("动作行·正好写完一句时不闪空白（退一句显示）", LA({ type: "text", delta: "先看看文件。" }).line === "先看看文件。", LA({ type: "text", delta: "先看看文件。" }).line);
    ok("动作行·旁白缓冲只留尾部 400 字，长任务不越滚越沉", LA({ type: "text", delta: "句。".repeat(500) }).narr.length === 400, LA({ type: "text", delta: "句。".repeat(500) }).narr.length);
    ok("动作行·专家内层的正文不抢主线这一行", line({ type: "text", delta: "内层在写", depth: 1 }) === null);
    ok("动作行·并发那条说清一起跑几个", line({ type: "parallel", count: 6 }) === "6 个只读工具一起跑", line({ type: "parallel", count: 6 }));
    ok("动作行·压缩那条说清压了几条、要点还在（别让人以为丢了）",
      line({ type: "compact", removed: 7 }).includes("7 条") && line({ type: "compact", removed: 7 }).includes("要点保留"),
      line({ type: "compact", removed: 7 }));
    ok("动作行·思考中带步号", line({ type: "step_start", step: 7 }) === "第 7 步 · 在想下一步怎么做", line({ type: "step_start", step: 7 }));
    ok("动作行·专家内层的 step_start 不覆盖主线", line({ type: "step_start", step: 2, depth: 1 }) === null);
    ok("动作行·要问用户的时候说的是「在等你回答」", line({ type: "ask_user" }).includes("等你回答"), line({ type: "ask_user" }));
    ok("动作行·工具成了不改词：那一步「在干什么」立着更有用", line({ type: "tool_result", name: "read_file", preview: "ok" }) === null);
    ok("动作行·工具栽了必须说（过程区收着的时候失败原本完全隐形）",
      line({ type: "tool_result", name: "run_shell", isError: true, outcome: "exit 1" }) === "命令 没成：exit 1",
      line({ type: "tool_result", name: "run_shell", isError: true, outcome: "exit 1" }));
    ok("动作行·记账类事件（usage / files）不抢这一行", line({ type: "usage" }) === null && line({ type: "files", files: [] }) === null);
    ok("动作行·非正文事件把旁白缓冲清空，下一段不接到上一段尾巴上", LA({ type: "parallel", count: 2 }, "上一段旁白").narr === "");

    // 真事件流跑一遍：验它确实接在 DOM 上，而且**收着**也看得见
    const u = createTurnUI("研究一下这门生意", "craft", "s_t");
    const t2 = u.turn;
    u.handleEvent({ type: "step_start", step: 1 });
    u.handleEvent({ type: "tool_use", id: "x1", name: "web_search", title: "搜「深圳 OPC」" });
    const wrap = t2.querySelector(".proc-wrap");
    const live = wrap.querySelector(".proc-head .act-live");
    ok("动作行挂在折叠条上（跟折叠区是两回事）", !!live);
    ok("过程区仍然默认收着（正文才是主角，过程要看再展开）", !wrap.classList.contains("open"));
    const liveIcon = () => { const u = live.querySelector("use"); return u ? u.getAttribute("href") : "(没有图标)"; };
    ok("收着也看得见，说的正是此刻这一步", disp(live) !== "none" && live.textContent === "搜「深圳 OPC」", disp(live) + " / " + live.textContent);
    ok("图标是画出来的 svg，不是拿表情当图标", liveIcon() === "#i-globe" && live.querySelector("svg.i"), liveIcon());
    ok("动作行独占一行，不跟耗时挤在一起",
      live.getBoundingClientRect().top > wrap.querySelector(".pt").getBoundingClientRect().top,
      live.getBoundingClientRect().top + " vs " + wrap.querySelector(".pt").getBoundingClientRect().top);
    ok("鼠标悬停能看全被截掉的部分（title 跟着走）", live.title === live.textContent, live.title);
    u.handleEvent({ type: "parallel", count: 6 });
    ok("下一个动作来了就地换词，不是越堆越长", live.textContent === "6 个只读工具一起跑", live.textContent);
    ok("换词时图标跟着换，不会留着上一步那个", liveIcon() === "#i-zap", liveIcon());
    ok("换词是替换不是追加：整行就一个图标", live.querySelectorAll("svg.i").length === 1, live.querySelectorAll("svg.i").length + " 个");
    u.handleEvent({ type: "tool_result", id: "x1", name: "web_search", preview: "ok" });
    ok("工具成了不改词：还停在刚才那句", live.textContent === "6 个只读工具一起跑", live.textContent);
    u.handleEvent({ type: "tool_use", id: "x2", name: "run_shell", title: "命令 npm test" });
    u.handleEvent({ type: "tool_result", id: "x2", name: "run_shell", isError: true, outcome: "exit 1" });
    ok("工具栽了当场说出来", live.textContent.includes("没成") && live.textContent.includes("exit 1"), live.textContent);
    ok("栽了那一行换成警示图标", liveIcon() === "#i-triangle-alert", liveIcon());
    for (const ch of "我抓几份原文确认细节。") u.handleEvent({ type: "text", delta: ch });
    ok("流式旁白按帧合并：这一帧还没到，不跟着每个字抖", live.textContent.includes("没成"), live.textContent);
    await nap2(140);
    ok("下一帧到了，动作行补上最后一句旁白（尾帧不会停在半句话）", live.textContent === "我抓几份原文确认细节。", live.textContent);
    ok("写正文时图标换成笔", liveIcon() === "#i-pen-line", liveIcon());
    // 模型吐的字要走 textContent：以前这一行是 innerHTML 拼的，命令里带个 < 就当标签解析了
    u.handleEvent({ type: "tool_use", id: "x3", name: "run_shell", title: "命令 <img src=x onerror=alert(1)>" });
    ok("动作行里的字一律当字看，不当 HTML", live.querySelectorAll("img").length === 0 && live.textContent.includes("<img src=x"), live.innerHTML.slice(0, 120));
    u.finish();
    ok("跑完就撤掉这行：那时候该看的是「已完成 · 产出几件」，不是最后一句旁白", disp(live) === "none", disp(live));
  }

  // ---- 回放一条已经跑完的对话：不许看起来像正在跑 ----
  // 用户报的就是这个：打开历史记录，一条早就答过的岔路还画成「想让你定一下」，
  // 而那时候根本没有任何东西可停 —— 看上去就是「我完成的对话又在执行」
  {
    chatCol.innerHTML = "";
    isReplaying = true;
    const u = createTurnUI("帮我查一下", "research", "s_t");
    u.handleEvent({ type: "ask_user", ask_id: "a1", question: "给谁看？",
      options: [{ label: "投资决策参考" }, { label: "行业科普" }], timeout_ms: 300000 });
    const card = chatCol.querySelector(".ask-card");
    ok("回放里的提问卡不可点（别让人对着过期的问题按半天）", card.classList.contains("done"));
    u.handleEvent({ type: "ask_answer", ask_id: "a1", answer: "投资决策参考" });
    ok("答过的岔路显示成答过了", card.querySelector(".ask-lb").textContent.includes("定过了"), card.querySelector(".ask-lb").textContent);
    ok("而且把当时选的那条写出来", card.querySelector(".ask-ans").textContent.includes("投资决策参考"), card.querySelector(".ask-ans").textContent);

    // 反向对照：真没答过的那张，还是得说明白这是历史里的问题，不能假装有答案
    u.handleEvent({ type: "ask_user", ask_id: "a2", question: "还有一个？", options: [{ label: "甲" }], timeout_ms: 0 });
    const c2 = [...chatCol.querySelectorAll(".ask-card")][1];
    ok("反向对照：没答过的那张不许编出个答案", c2.querySelector(".ask-ans").textContent.includes("历史记录里的提问"), c2.querySelector(".ask-ans").textContent);

    // 跑到一半断掉的那一轮（没有收尾事件）：得有个终点，不能永远转圈
    u.handleEvent({ type: "tool_use", id: "z", name: "read_file", purpose: "读" });
    u.finish({ interrupted: true });
    isReplaying = false;
    ok("断掉的那一轮不再转圈", chatCol.querySelectorAll(".proc-wrap.running").length === 0 && chatCol.querySelectorAll(".spinner").length === 0);
    const pt = chatCol.querySelector(".proc-head .pt").textContent;
    ok("而且写明是断的，不冒充「已完成」", pt.includes("中断了") && !pt.includes("已完成"), pt);
    ok("标题上挂出原因", (chatCol.querySelector(".proc-warn") || {}).textContent.includes("断的"));
  }
  {
    // 反向对照：正常跑完的那一轮照旧说「已完成」，别被上面那条改坏
    chatCol.innerHTML = "";
    const u = createTurnUI("正常一轮", "research", "s_t");
    u.handleEvent({ type: "tool_use", id: "n1", name: "read_file", purpose: "读" });
    u.handleEvent({ type: "tool_result", id: "n1", name: "read_file", preview: "ok" });
    u.finish();
    const pt = chatCol.querySelector(".proc-head .pt").textContent;
    ok("反向对照：正常收尾还是「已完成」", pt.includes("已完成") && !pt.includes("中断了"), pt);
  }
  return names;
})()`;

const PREVIEW_HTML =
  "<!doctype html><meta charset='utf-8'><body>" +
  "<div id='preview-panel'></div><div id='files-panel'></div><div id='pv-body'></div>" +
  "<span id='pv-name'></span><a id='pv-dl'></a>" +
  "<button id='pv-close'></button><button id='pv-copy' hidden></button>" +
  "<button id='pv-sys'></button><button id='pv-rv'></button></body>";

// 网络请求全部截下来：既当替身，也当"到底发了什么请求"的证据（Range 头就是这么验的）
const PREVIEW_STUBS = [
  IC_STUB,
  "window.reqs = []; window.opened = []; window.PV_FILES = {}; window.PV_DATA = {};",
  "window.fetch = async (url, init) => {",
  "  window.reqs.push({ url, init });",
  "  if (url.startsWith('/api/files/open/')) { window.opened.push(decodeURIComponent(url.slice(16))); return { ok: true, json: async () => ({}) }; }",
  "  if (url.startsWith('/api/files/preview/')) {",
  "    const n2 = decodeURIComponent(url.slice(19).split('?')[0]);",
  "    return { ok: true, json: async () => window.PV_DATA[n2] || { error: '没这个替身' } };",
  "  }",
  "  const name = decodeURIComponent((url.split('/api/files/view/')[1] || '').split('?')[0]);",
  "  const f = window.PV_FILES[name] || { body: '', total: 0 };",
  "  return { ok: window.PV_FETCH_OK !== false, status: 206, headers: { get: (h) => (h.toLowerCase() === 'content-range' ? 'bytes 0-1/' + f.total : null) }, text: async () => f.body,",
  "           blob: async () => window.PV_BLOB || new Blob([window.PNG1X1], { type: 'image/png' }) };",
  "};",
  "window.esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
  "window.renderMd = (t) => '<p class=md>' + window.esc(t) + '</p>';",
  "window.fmtSize = (n) => n + ' B';",
  "window.renderDeployBar = () => {};",
  "window.revealFile = (n) => { window.opened.push('reveal:' + n); };",
  "window.toasts = []; window.toast = (t, i) => window.toasts.push([String(t), i || '']);",
  // 剪贴板：Electron 离屏窗口里 navigator.clipboard.write 真调会弹权限/静默失败，
  // 所以整个换掉，顺便当"到底往剪贴板放了什么"的证据。ClipboardItem 同理。
  "window.copied = []; window.ClipboardItem = function (m) { this.m = m; this.types = Object.keys(m); };",
  "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async (items) => { window.copied.push(items[0]); } } });",
  // 1×1 的真 PNG。走 canvas 重编码那条路时 <img> 要能真的解出来，光有个空 Blob 不行
  "window.PNG1X1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));",
  "window.PV_BLOB = null;",
  // 身份：默认按平台管理员验（老断言全是这一档），成员那一档在第 6.5 节里现场翻过来
  "window.settingsCache = { platform_owner: true };",
  "window.downloaded = []; window.downloadFile = (n) => window.downloaded.push(n);",
  "window.navSyncs = 0; window.syncNavByRole = () => { window.navSyncs++; };",
].join("\n");

const PREVIEW_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const body = document.getElementById("pv-body");
  const show = async (n, file) => { if (file) window.PV_FILES[n] = file; await previewFile(n); return body.innerHTML; };

  // ---- 1. 路由表：真实工作目录里数得出来的后缀，一个都不许掉进"不支持预览" ----
  {
    const cases = {
      iframe: ["a.html", "a.htm"],
      // PDF 和 SVG 都从 iframe 里拆出来了：PDF 有自带阅读器要整个面板（量内容高度那条路
      // 在它身上会塌成顶端一条），SVG 是图要居中。路由分不开，摆法就分不开。
      pdf: ["报告.pdf", "a.PDF"],
      svg: ["图.svg", "流程.SVG"],
      image: ["图.png", "a.JPG", "a.jpeg", "a.webp", "a.ico", "a.avif"],
      audio: ["口播.mp3", "a.wav", "a.m4a", "a.flac", "a.opus"],
      video: ["成片.mp4", "a.mov", "a.MOV", "a.webm", "a.m4v", "a.mkv", "a.avi", "a.wmv", "a.flv", "a.mpg", "a.mpeg", "a.3gp"],
      markdown: ["报告.md", "a.markdown"],
      binary: ["a.pcm", "a.o", "a.swiftmodule", "a.dylib", "a.ttf", "a.sqlite3"],
      doc: ["方案.docx"],
      sheet: ["账.xlsx"],
      slides: ["介绍.pptx"],
      archive: ["包.zip", "a.ZIP"],
      csv: ["数据.csv", "a.tsv"],
      text: ["a.py", "a.swift", "a.plist", "字幕.srt", "a.h", "a.toml", "a.ini", "Dockerfile", "a.log", "a.json", "a.yaml", "a.vtt", "a.sh", "a.go", "a.没见过的后缀"],
    };
    for (const [want, list] of Object.entries(cases))
      for (const n of list) ok("路由 " + n + " → " + want, previewKind(n) === want, "实际是 " + previewKind(n));
  }

  // ---- 1.5 会话子目录：相对路径的图必须还能找到（"预览时图片都不正常显示"的真身）----
  {
    ok("fpath 保留斜杠", fpath("任务 A/图 1.png") === "%E4%BB%BB%E5%8A%A1%20A/%E5%9B%BE%201.png", fpath("任务 A/图 1.png"));
    ok("dirOf 取目录", dirOf("x/y/z.md") === "x/y" && dirOf("z.md") === "");
    ok("joinRel 按文档所在目录算", joinRel("任务_A", "fig.jpg") === "任务_A/fig.jpg");
    ok("joinRel 认 ./ 和 ../", joinRel("任务_A/dist", "../fig.jpg") === "任务_A/fig.jpg" && joinRel("任务_A", "./f.png") === "任务_A/f.png");
    ok("joinRel 的 / 按工作区根算", joinRel("任务_A", "/g.png") === "g.png");

    const h = await show("任务_0908_测试/site.html");
    ok("子目录网页的地址保留真斜杠", /files\\/view\\/%E4%BB%BB%E5%8A%A1_0908_%E6%B5%8B%E8%AF%95\\/site\\.html/.test(h), h.slice(0, 300));
    ok("整条路径不许被压成一段（%2F）", !/%2F/i.test(h), h.slice(0, 300));
    ok("下载链接也按段编码", !/%2F/i.test(document.getElementById("pv-dl").getAttribute("href") || ""), document.getElementById("pv-dl").getAttribute("href"));
  }

  // ---- 1.6 markdown 里的图：以前根本不认这个语法，报告里插的图只剩一行 ![封面](fig.jpg) ----
  {
    ok("相对图按文档目录指回工作区", /src="\\/api\\/files\\/view\\/%E4%BB%BB%E5%8A%A1_A\\/fig\\.jpg"/.test(mdImg("封面", "fig.jpg", "任务_A")), mdImg("封面", "fig.jpg", "任务_A"));
    ok("http 图原样放行", /src="https:\\/\\/e\\.com\\/a\\.png"/.test(mdImg("x", "https://e.com/a.png", "")));
    ok("data:image 放行", /src="data:image\\/png;base64,AAA"/.test(mdImg("x", "data:image/png;base64,AAA", "")));
    ok("javascript: 一律不认", mdImg("x", "javascript:alert(1)", "") === "");
    ok("带引号的地址不许拼进属性", mdImg("x", 'a.png" onerror="alert(1)', "") === "", mdImg("x", 'a.png" onerror="alert(1)', ""));
    ok("alt 里的引号洗掉", mdImg('他说"好"', "a.png", "").includes('alt="他说好"'), mdImg('他说"好"', "a.png", ""));
  }

  // ---- 2. .ts 是 TypeScript，不是 MPEG-TS 视频（mime 库认成 video/mp2t，照它走会给源码套播放器）----
  ok(".ts 当源码不当视频", previewKind("app.ts") === "text" && previewKind("a.tsx") === "text");

  // ---- 3. 音频/视频真给出播放器，且能拖进度条（controls + preload）----
  {
    const h = await show("口播.mp3");
    ok("mp3 出音频播放器", /<audio[^>]+controls/.test(h) && /files\\/view\\/%E5%8F%A3%E6%92%AD\\.mp3/.test(h), h.slice(0, 200));
    const v = await show("成片.mp4");
    ok("mp4 出视频播放器", /<video[^>]+controls/.test(v) && /preload="metadata"/.test(v), v.slice(0, 200));

    // 一条片子该摆在面板正中间，不是顶在天花板上
    ok("视频预览是居中的", body.classList.contains("pv-mid"), body.className);
    await show("图.png");
    ok("单张图预览也是居中的", body.classList.contains("pv-mid"), body.className);
    await show("说明.md", { body: "# 标题", total: 6 });
    ok("反向对照：markdown 预览不居中（那是整页文字，居中会变成一团浮在中间）",
       !body.classList.contains("pv-mid"), body.className);

    // 编码解不了的时候必须说人话。以前 <video> 解不了不吭声，只留一个纹丝不动的黑框，
    // 用户从黑框里只能得出「这软件不支持看视频」
    await show("iphone录的.mov");
    const mv = body.querySelector(".pv-media");
    ok("解码失败前先摆播放器（先给能播的那条路）", !!mv, body.innerHTML.slice(0, 160));
    mv.onerror();
    ok("解不了就说一句实话，不是留个黑框", body.textContent.includes("编码浏览器解不了"), body.textContent.slice(0, 120));
    ok("解不了之后撤掉居中（这会儿是一段文字加按钮，不是一张画面）",
       !body.classList.contains("pv-mid"), body.className);
    const n0 = window.opened.length;
    body.querySelector(".pv-open-sys").click();
    ok("兜底那颗「用系统默认程序打开」是真能点的（晚绑的按钮最容易变死按钮）",
       window.opened.length === n0 + 1 && window.opened[window.opened.length - 1] === "iphone录的.mov",
       JSON.stringify(window.opened.slice(-2)));

    // 迟到的 error：用户点开一个解不了的片子、转头去看别的文件，那个已经被换下来的
    // <video> 几百毫秒后才把 error 抛出来。它要是照旧重画一遍，用户正看着的那一屏
    // 就被一句「上一个文件解不了」掀掉了
    await show("另一个说明.md", { body: "# 另一个文件", total: 12 });
    const before = body.innerHTML;
    ok("切走之后屏上是新文件", before.includes("另一个文件"), before.slice(0, 120));
    mv.onerror();
    ok("换下来的播放器迟到报错，盖不掉新开的那一屏", body.innerHTML === before, body.innerHTML.slice(0, 140));
  }

  // ---- 4. 白名单外的纯文本（这一版之前只能下载）----
  {
    // 源码从这一版起会被着色，关键字外面裹了 <span>，所以按 textContent 比对而不是 innerHTML——
    // 要验的是「内容出来了」，不是「内容中间一个标签都没有」
    await show("main.swift", { body: 'import Foundation\\nprint(1)', total: 30 });
    ok("swift 源码直接显示内容", /import Foundation/.test(body.textContent) && !/暂不支持/.test(body.textContent), body.textContent.slice(0, 200));
    await show("build.py", { body: "def main():\\n    pass", total: 20 });
    ok("py 源码直接显示内容", /def main/.test(body.textContent), body.textContent.slice(0, 200));
    const s = await show("字幕.srt", { body: "1\\n00:00:01,000 --> 00:00:02,000\\n你好", total: 40 });
    ok("srt 字幕直接显示内容", /00:00:01/.test(s) && /你好/.test(s));
  }

  // ---- 5. 后缀没认出来但内容是二进制：内容说了算，别糊一屏乱码 ----
  {
    const h = await show("怪东西.xyz", { body: "\\u0000\\u0000ELF\\u0000", total: 8 });
    ok("含 NUL 的内容退回兜底", /二进制|不是文本/.test(h) && !/ELF/.test(h), h.slice(0, 200));
    const g = await show("乱码.xyz2", { body: "\\uFFFD".repeat(50) + "x", total: 51 });
    ok("满屏替换字符退回兜底", /不是文本/.test(g));
    const t = await show("正常.xyz3", { body: "中文正文，一个替换字符都没有", total: 42 });
    ok("正经中文文本不误判成二进制", /中文正文/.test(t));
  }

  // ---- 6. 兜底页给的是能点的按钮，不是让用户去找早就不存在的 🗔 / ⬇ ----
  {
    const h = await show("a.pcm");
    ok("兜底不再指认不存在的图标", !/🗔/.test(h) && !/⬇/.test(h), h.slice(0, 200));
    const n = window.opened.length;
    body.querySelector(".pv-open-sys").click();
    await new Promise((r) => setTimeout(r, 30));
    ok("兜底按钮真能打开系统程序", window.opened.length === n + 1 && window.opened.at(-1) === "a.pcm", JSON.stringify(window.opened.slice(-2)));
    body.querySelector(".pv-reveal").click();
    ok("兜底按钮真能定位文件", window.opened.at(-1) === "reveal:a.pcm", JSON.stringify(window.opened.slice(-3)));
  }

  // ---- 6.5 换成普通成员：这几颗按钮开的是**服务器那台**机器，画出来点了只会 403 ----
  // 一颗明明能点的按钮，点下去只回四个字。
  // 所以成员那边干脆不画，改给他真能用的那条：下载到自己电脑上看。
  {
    window.settingsCache = { platform_owner: false };
    const h = await show("b.pcm");
    ok("成员看不到「用系统默认程序打开」", !/pv-open-sys/.test(h), h.slice(0, 300));
    ok("成员也看不到「打开所在位置」", !/pv-reveal/.test(h), h.slice(0, 300));
    ok("换上的是能用的那条：下载到本地", /pv-download/.test(h) && /下载到本地/.test(h), h.slice(0, 300));
    const n = window.downloaded.length;
    body.querySelector(".pv-download").click();
    ok("下载按钮真接上了 downloadFile（不是个摆设）",
       window.downloaded.length === n + 1 && window.downloaded.at(-1) === "b.pcm", JSON.stringify(window.downloaded.slice(-2)));
    const m = window.opened.length;
    await previewFile("成员的.doc");
    ok(".doc 对成员走下载，不再往服务器桌面上弹一个他看不见的窗",
       window.opened.length === m && window.downloaded.at(-1) === "成员的.doc", JSON.stringify(window.opened.slice(-2)));
    ok("预览一渲染就把标题栏那两颗「在本机打开」也按身份收一收", window.navSyncs > 0);
    window.settingsCache = { platform_owner: true }; // 还原：后面几节还是按平台管理员验
    const back = await show("c.pcm");
    ok("反向对照：管理员那边这两颗按钮还在", /pv-open-sys/.test(back) && /pv-reveal/.test(back), back.slice(0, 300));
  }

  // ---- 7. 大文件只取头一段：以前整包 fetch 完再 slice，几百 MB 的日志能把渲染进程卡死 ----
  {
    window.reqs.length = 0;
    const h = await show("巨大.log", { body: "第一行\\n", total: 300 * 1024 * 1024 });
    const req = window.reqs.filter((r) => r.url.includes("/api/files/view/")).at(-1);
    ok("取文本带 Range 头", /^bytes=0-\\d+$/.test(((req.init || {}).headers || {}).Range || ""), JSON.stringify(req.init));
    // 以前这儿只丢一句「文件太大，只显示了开头」就完事了。可他想看的那一行
    // 可能就在第 520 KB 上，一句「下载或用系统程序打开」等于把人推出应用。
    // 现在要的是三件事：读到哪儿写清楚、还能接着往后读、读完了说一声。
    ok("大文件写清楚读到哪儿了", /已经显示到/.test(h) && /整个文件/.test(h), h.slice(-300));
    const moreBtn = body.querySelector(".pv-more");
    ok("给了一颗「再往后看」，而不是只给一句「下载吧」", !!moreBtn, h.slice(-300));
    ok("按钮上写明这一下要读多少", moreBtn.textContent.indexOf("再往后看") === 0 && /[0-9]/.test(moreBtn.textContent), moreBtn.textContent);
    ok("按钮记着从哪个字节接", Number(moreBtn.dataset.at) === PV_TEXT_MAX, moreBtn.dataset.at);

    // 真点一下：发的 Range 得是接在后面的那一段，读回来的字要接在原文后面，不是把头上那段冲掉
    window.PV_FILES["巨大.log"] = { body: "后面那段", total: 300 * 1024 * 1024 };
    window.reqs.length = 0;
    moreBtn.onclick();
    await new Promise((r) => setTimeout(r, 40));
    const req2 = window.reqs.filter((r) => r.url.includes("/api/files/view/")).at(-1);
    ok("接着读的 Range 从上一段末尾起",
       ((req2.init || {}).headers || {}).Range === "bytes=" + PV_TEXT_MAX + "-" + (2 * PV_TEXT_MAX - 1),
       JSON.stringify(req2.init));
    ok("读回来的字接在后面", body.querySelector(".pv-more-text").textContent === "后面那段",
       body.querySelector(".pv-more-text").textContent);
    ok("读到哪儿跟着往前走", /1\\.0 MB|1048576/.test(body.querySelector(".pv-more-at").textContent) || body.querySelector(".pv-more-at").textContent.indexOf("已经显示到") === 0,
       body.querySelector(".pv-more-at").textContent);

    // 读到头了就不能还摆着一颗按下去没反应的按钮
    const h2 = await show("刚好超一点.log", { body: "头", total: PV_TEXT_MAX + 3 });
    const b2 = body.querySelector(".pv-more");
    window.PV_FILES["刚好超一点.log"] = { body: "尾巴", total: PV_TEXT_MAX + 3 };
    b2.onclick();
    await new Promise((r) => setTimeout(r, 40));
    ok("读完了把按钮换成「到头了」", !body.querySelector(".pv-more") && /已经到文件末尾了/.test(body.innerHTML), body.innerHTML.slice(-260));

    const small = await show("小.log", { body: "就一行", total: 9 });
    ok("小文件不乱标截断", !/已经显示到/.test(small) && !/pv-more/.test(small));
  }

  // ---- 8. 只剩 Word97 那三个二进制老格式还交给本机程序；docx/xlsx/pptx 不许再被踢出去 ----
  {
    const n = window.opened.length;
    document.getElementById("pv-body").innerHTML = "原样";
    await previewFile("老方案.doc");
    ok(".doc 交给系统程序", window.opened.at(-1) === "老方案.doc" && window.opened.length === n + 1);
    ok(".doc 不动预览面板", document.getElementById("pv-body").innerHTML === "原样");
    for (const bad of ["方案.docx", "账.xlsx", "介绍.pptx"])
      ok(bad + " 不再走系统程序", !OFFICE_RE.test(bad));
  }

  // ---- 9. docx：服务端拆出来的块要按标题/正文/列表/表格/图各归各位，且全过 esc ----
  {
    window.PV_DATA["方案.docx"] = { kind: "doc", truncated: false, blocks: [
      { t: "h", lvl: 2, runs: [{ s: "第一章 <脚本>" }] },
      { t: "p", runs: [{ s: "正文", b: true }, { s: "斜的", i: true }] },
      { t: "li", lvl: 1, runs: [{ s: "条目甲" }] },
      { t: "table", rows: [[{ runs: [{ s: "列A" }] }, { runs: [{ s: "列B" }] }], [{ runs: [{ s: "1" }] }, { runs: [{ s: "2" }] }]] },
      { t: "img", src: "data:image/png;base64,iVBOR" },
      { t: "img", src: "javascript:alert(1)" },
    ] };
    const h = await show("方案.docx");
    ok("docx 出正文不再弹系统程序", /第一章/.test(h) && !/暂不支持/.test(h), h.slice(0, 200));
    ok("docx 标题按级别出 h2", /<h2 class="ov-h">/.test(h));
    ok("docx 粗体斜体保留", /<b>正文<\\/b>/.test(h) && /<i>斜的<\\/i>/.test(h));
    ok("docx 列表按层级缩进", /margin-left:22px/.test(h) && /条目甲/.test(h));
    ok("docx 表格首行当表头", /<th>列A<\\/th>/.test(h) && /<td>1<\\/td>/.test(h));
    ok("docx 内嵌图渲染成 data URI", /<img class="ov-img" src="data:image\\/png/.test(h));
    ok("docx 非 data: 的图源被挡掉", !/javascript:/.test(h), h.slice(0, 400));
    ok("docx 内容过转义", /&lt;脚本&gt;/.test(h) && !/<脚本>/.test(h));
  }

  // ---- 10. xlsx：多表要能切，行列超限要说清楚 ----
  {
    window.PV_DATA["账.xlsx"] = { kind: "sheet", total: 2, truncated: false, sheets: [
      { name: "一月", rows: [["日期", "金额"], ["01-01", "12"]], truncated: false, totalRows: 2, totalCols: 2 },
      { name: "二月<b>", rows: [["日期"], ["02-01"]], truncated: true, totalRows: 9000, totalCols: 3 },
    ] };
    const h = await show("账.xlsx");
    ok("xlsx 出表格", /<th>日期<\\/th>/.test(h) && /01-01/.test(h));
    ok("xlsx 多表出切页按钮", body.querySelectorAll(".ov-tab").length === 2);
    ok("xlsx 表名过转义", /二月&lt;b&gt;/.test(h));
    ok("xlsx 默认只显第一张", body.querySelector('[data-pane="1"]').hidden === true);
    body.querySelectorAll(".ov-tab")[1].click();
    ok("xlsx 切页真切", body.querySelector('[data-pane="0"]').hidden === true && body.querySelector('[data-pane="1"]').hidden === false);
    ok("xlsx 截断说明白", /共 9000 行/.test(body.innerHTML));
  }

  // ---- 11. pptx：一页一卡，标题、层级、备注都在 ----
  {
    window.PV_DATA["介绍.pptx"] = { kind: "slides", total: 42, truncated: true, slides: [
      { n: 1, title: "开场 & 目标", lines: [{ lvl: 0, s: "要点一" }, { lvl: 1, s: "子要点" }], notes: "记得看时间" },
      { n: 2, title: "", lines: [{ lvl: 0, s: "只有正文" }], notes: "" },
    ] };
    const h = await show("介绍.pptx");
    ok("pptx 一页一卡", body.querySelectorAll(".ov-slide").length === 2);
    ok("pptx 标题在", /开场 &amp; 目标/.test(h));
    ok("pptx 子层级缩进", /margin-left:22px[^>]*>子要点/.test(h));
    ok("pptx 备注单独一块", /备注：记得看时间/.test(h));
    ok("pptx 没标题不硬造", !/ov-slide-t"><\\/div>/.test(h));
    ok("pptx 报总页数和截断", /共 42 页/.test(h) && /只显示了前 2 页/.test(h));
  }

  // ---- 12. zip：以前只能下载，现在至少能看见里面装了什么 ----
  {
    window.PV_DATA["包.zip"] = { kind: "archive", total: 3, bytes: 4096, truncated: false,
      entries: [{ name: "a/b.txt", size: 10 }, { name: "c.png", size: 20 }, { name: "<x>.md", size: 30 }] };
    const h = await show("包.zip");
    ok("zip 列出条目", /a\\/b\\.txt/.test(h) && /c\\.png/.test(h));
    ok("zip 条目名过转义", /&lt;x&gt;\\.md/.test(h));
    ok("zip 报总数和解压大小", /共 3 个文件/.test(h) && /4096 B/.test(h));
  }

  // ---- 13. 服务端拆不开时退回兜底按钮，不能白屏 ----
  {
    window.PV_DATA["坏的.docx"] = { error: "不是有效的 zip" };
    const h = await show("坏的.docx");
    ok("拆不开时说人话", /不是有效的 zip/.test(h) && !!body.querySelector(".pv-open-sys"), h.slice(0, 200));
  }

  // ---- 14. CSV 得按 RFC4180 拆：字段里带逗号/引号/换行是常事，split(",") 会把表拆散架 ----
  {
    const h = await show("数据.csv", { body: 'a,b\\n"含,逗号","他说""好"""\\n1,2', total: 40 });
    ok("csv 出表格不出裸文本", /<th>a<\\/th>/.test(h) && /<th>b<\\/th>/.test(h), h.slice(0, 300));
    ok("csv 引号里的逗号不拆列", /含,逗号/.test(h));
    ok("csv 双写引号还原成一个", /他说"好"/.test(h));
    ok("csv 行数对", body.querySelectorAll("tr").length === 3, String(body.querySelectorAll("tr").length));
    const t = await show("数据.tsv", { body: "x\\ty\\n1\\t2", total: 10 });
    ok("tsv 按制表符拆", /<th>x<\\/th>/.test(t) && /<th>y<\\/th>/.test(t));
    const semi = await show("欧洲.csv", { body: "p;q;r\\n1;2;3", total: 12 });
    ok("分号分隔也认", /<th>q<\\/th>/.test(semi));
    const cell = await show("嵌换行.csv", { body: 'h1,h2\\n"第一行\\n第二行",x', total: 30 });
    ok("字段内换行不当成新行", cell.match(/<tr>/g).length === 2, String((cell.match(/<tr>/g) || []).length));
  }

  // ---- 15. 图片复制：----
  // 三条入口（按钮 / 双击图 / Ctrl・Cmd+C）都得真把一张 PNG 放进剪贴板；
  // 失败了要按原因说人话并给出路（加一句「复制失败」等于没说），而且按钮不能永久按灰。
  {
    const btn = document.getElementById("pv-copy");
    const tick = () => new Promise((r) => setTimeout(r, 40));
    // 正向断言不能拿固定 40ms 赌机器速度：非 PNG 那条路是 fetch → blob → <img> 解码 →
    // canvas 重编码 → clipboard.write 五段异步，本机实测 42ms，正好卡在 40ms 外面一点点，
    // 本机靠调度抖动侥幸过，CI 的 runner 慢一档就必挂 —— 挂的还是「copied=0」这种
    // 看上去像功能坏了的样子。所以正向一律等到发生为止，最多等 5 秒。
    // 反向断言（该没反应的）保持固定等待：那种情况多等只是浪费，等短了也只会放过错、不会误报。
    const until = async (cond) => {
      const t0 = Date.now();
      while (!cond() && Date.now() - t0 < 5000) await tick();
      return cond();
    };
    const copiedOne = () => until(() => window.copied.length === 1);
    const toastedOne = () => until(() => window.toasts.length === 1);
    await show("图.png", { body: "", total: 1 });
    ok("看图时复制按钮露出来", btn.hidden === false);
    ok("图上写了怎么复制（不写没人知道双击能复制）", /title="双击复制这张图"/.test(body.innerHTML), body.innerHTML.slice(0, 200));

    window.copied = []; window.toasts = [];
    btn.onclick();
    await copiedOne();
    ok("点按钮真往剪贴板放了一张图", window.copied.length === 1, String(window.copied.length));
    ok("放进去的是 PNG（Chromium 只认这一种，给 jpeg 会直接抛）",
       !!(window.copied[0] && window.copied[0].m && window.copied[0].m["image/png"]), JSON.stringify(window.copied[0] && window.copied[0].types));
    ok("复制完说了一句人话", window.toasts.length === 1 && window.toasts[0][0].indexOf("已复制") >= 0, JSON.stringify(window.toasts));
    ok("按钮没被永久按灰", btn.disabled === false);

    // 非 PNG 得先过一道 canvas 重编码：我们产出的图大半是 jpg/webp，
    // 这一步没了就是「点了没反应」——而且报的还是 NotAllowedError，根本看不出是这个原因
    window.PV_BLOB = new Blob([window.PNG1X1], { type: "image/jpeg" });
    window.copied = [];
    btn.onclick();
    await copiedOne();
    ok("jpeg 也能复制（走了 canvas 重编码）", window.copied.length === 1, String(window.copied.length));
    ok("重编码出来的仍然是 PNG",
       !!(window.copied[0] && window.copied[0].m && window.copied[0].m["image/png"] && window.copied[0].m["image/png"].type === "image/png"),
       JSON.stringify(window.copied[0] && window.copied[0].types));
    window.PV_BLOB = null;

    window.copied = [];
    body.querySelector(".pv-img").ondblclick();
    await copiedOne();
    ok("双击图片也复制", window.copied.length === 1, String(window.copied.length));

    // Ctrl/Cmd+C：预览开着、看的又是图，这一下才该被接管
    const key = (el, init) => {
      const e = new KeyboardEvent("keydown", Object.assign({ key: "c", cancelable: true, bubbles: true }, init));
      (el || document).dispatchEvent(e);
      return e;
    };
    window.copied = [];
    const e1 = key(null, { metaKey: true });
    await copiedOne();
    ok("Cmd+C 复制当前这张图", window.copied.length === 1, String(window.copied.length));
    ok("而且拦下了浏览器默认那一下", e1.defaultPrevented);
    window.copied = [];
    key(null, {});
    await tick();
    ok("没按修饰键的 c 不算", window.copied.length === 0, String(window.copied.length));

    // 人在输入框里按 Cmd+C，那是在复制文字，不该被我们抢走
    const inp = document.createElement("input");
    inp.value = "文件名"; document.body.appendChild(inp);
    window.copied = [];
    const e2 = key(inp, { metaKey: true });
    await tick();
    ok("输入框里的 Cmd+C 不抢", window.copied.length === 0 && !e2.defaultPrevented, String(window.copied.length));
    inp.remove();

    // 选中了文字同理：他要的是那段字，不是这张图
    const span = document.createElement("span");
    span.textContent = "报告.png"; document.body.appendChild(span);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.selectAllChildren(span);
    window.copied = [];
    const e3 = key(null, { metaKey: true });
    await tick();
    ok("选中文字时的 Cmd+C 不抢", window.copied.length === 0 && !e3.defaultPrevented, String(window.copied.length));
    sel.removeAllRanges(); span.remove();

    // 取不到图 / 浏览器不给写剪贴板：两条错要分开说，并且都得给出路
    window.toasts = []; window.copied = []; window.PV_FETCH_OK = false;
    btn.onclick();
    await toastedOne();
    window.PV_FETCH_OK = true;
    ok("图取不到时不会默默地什么都不发生", window.toasts.length === 1 && window.copied.length === 0, JSON.stringify(window.toasts));
    ok("而且说的是图没取到，不是一句复制失败", window.toasts[0][0].indexOf("没取到") >= 0, JSON.stringify(window.toasts));
    ok("按钮又放开了，不是卡死在灰色", btn.disabled === false);

    const saveCI = window.ClipboardItem;
    window.ClipboardItem = undefined;
    window.toasts = [];
    btn.onclick();
    await toastedOne();
    window.ClipboardItem = saveCI;
    ok("没剪贴板 API 时指到 HTTPS 上（局域网直连就是这个症状）",
       window.toasts.length === 1 && window.toasts[0][0].indexOf("HTTPS") >= 0, JSON.stringify(window.toasts));
    ok("这一条也告诉他还能右键复制", window.toasts[0][0].indexOf("右键") >= 0, JSON.stringify(window.toasts));

    // 不是图的时候这颗按钮必须收起来：摆一个按下去没反应的按钮，比没有这个按钮更糟
    await show("报告.md", { body: "# x", total: 3 });
    ok("看文档时复制按钮收起来", btn.hidden === true);
    window.copied = [];
    key(null, { metaKey: true });
    await tick();
    ok("文档页上的 Cmd+C 也不抢", window.copied.length === 0, String(window.copied.length));
  }

  // ---- 16. 源码按代码画：行号 + 着色 + 横向滚动，压缩产物先展开 ----
  // 他看的是打包器吐出来的 .mjs —— 整份文件一行几万字符，落进那条 pre-wrap +
  // overflow-wrap:anywhere 的兜底 <pre>，被从任意位置断字，所以「像乱码」。
  {
    const MIN = 'import{t as e}from"./rt.mjs";var u={position:\`relative\`,width:\`100%\`},d={...u,color:\`#85F\`};'
      + 'function g(e,t,n=!0){let i=c();r(()=>{n&&i===e&&t()},[i])}var re=/[/{};]+/g;var q="}}}";'
      + 'var pad="' + "y".repeat(420) + '";';
    const h = await show("sc6O9FDJf.Dw96dade.mjs", { body: MIN, total: MIN.length });
    ok("mjs 走代码看法：行号栏 + 代码区都在", /pv-code-ln/.test(h) && /pv-code-src/.test(h), h.slice(0, 240));
    ok("代码区不折行（折行正是「像乱码」的成因）", !/overflow-wrap:anywhere/.test(h), h.slice(0, 320));
    ok("认出这是压缩产物，并且默认已经展开了", /pv-code-bar/.test(h) && /看原文/.test(h), h.slice(0, 320));

    const srcOf = (html) => (html.match(/class="pv-code-src"[^>]*>([\\s\\S]*?)<\\/pre>/) || [, ""])[1];
    const lnOf = (html) => (html.match(/class="pv-code-ln"[^>]*>([\\s\\S]*?)<\\/pre>/) || [, ""])[1];
    const nl = String.fromCharCode(10);
    ok("展开之后真的不止一行了", srcOf(h).split(nl).length > 8, String(srcOf(h).split(nl).length));
    ok("行号栏的行数跟代码行数对得上（对不上就是在骗人）",
       lnOf(h).split(nl).length === srcOf(h).split(nl).length,
       lnOf(h).split(nl).length + " vs " + srcOf(h).split(nl).length);

    // 认不认引号和正则，是这个展开器成立的前提：压缩代码里 "}}}"、/[/{};]/ 这种字面量满地都是，
    // 不认的话第一个引号里的 } 就把后面全部缩进带歪，展开出来比不展开还难看
    const plain = srcOf(h).replace(/<[^>]*>/g, "");
    ok("字符串里的花括号没被当成结构（那三个仍在同一行）", /var q="\\}\\}\\}";/.test(plain), plain.slice(-300));
    ok("正则里的 / 和 { } 也没被当成结构", /var re=\\/\\[\\/\\{\\};\\]\\+\\/g;/.test(plain), plain.slice(-300));

    ok("着色真的上了（关键字和字符串至少各有一处）", /class="c-kw"/.test(h) && /class="c-str"/.test(h), h.slice(0, 400));

    // 「看原文」得真的回到原文：展开是为了读，总有人要确认原文长什么样
    document.getElementById("pv-code-raw").click();
    const raw = body.innerHTML;
    ok("点「看原文」回到一行原文", srcOf(raw).split(nl).length === 1 && /展开排版/.test(raw), String(srcOf(raw).split(nl).length));
    document.getElementById("pv-code-raw").click();
    ok("再点一下又展开回去", srcOf(body.innerHTML).split(nl).length > 8);

    // 没压缩的源码不该有那条横幅 —— 手写代码本来就排好版了，弹一句「这是压缩过的」是胡说
    const nice = await show("util.js", { body: "const a = 1;\\nfunction f() {\\n  return a;\\n}\\n", total: 40 });
    ok("反向对照：没压缩的源码不弹展开横幅", /pv-code-ln/.test(nice) && !/pv-code-bar/.test(nice), nice.slice(0, 240));

    // 日志和纯文本仍旧走折行那条路：那是散文，一行长过面板宽度就该折
    const log = await show("跑批.log", { body: "2026-09-17 开始\\n2026-09-17 结束", total: 30 });
    ok("反向对照：.log 不走代码路，仍是会折行的纯文本", !/pv-code-ln/.test(log) && /pre-wrap/.test(log), log.slice(0, 240));

    // 源码里出现 <script> 是家常便饭（模板字符串、正则、注释里都有），一律当字符看
    const evil = await show("bad.js", { body: 'var x = "<script>alert(1)</' + 'script>";', total: 40 });
    ok("源码里的标签被转义，不许真进 DOM", evil.indexOf("&lt;script&gt;") >= 0 && !body.querySelector("script"), evil.slice(0, 240));
  }

  return names;
})()`;


// 长对话滚动引导（回到最前 / 回到最新挂红点）+ 出错步骤卡默认收起、角标直达。
// 显示/隐藏和「点了到底展不展开」都是真样式说了算，所以注入 index.html 的真 CSS，切 app-01.js 真源码。
const SG0 = APP02X.indexOf("// ================= 长对话滚动引导");
const SG1 = APP02X.indexOf("// ================= Markdown 渲染");
if (SG0 < 0 || SG1 <= SG0) throw new Error("app-01.js 里的滚动引导段找不到了（段标题被改过？），前端测试没法定位真源码");
const SCROLLGUIDE_SRC = APP02X.slice(SG0, SG1);
// 出错卡不许再自动摊开——这条是 #55 的根：一旦有人改回去，下面的 DOM 测试测的就是假的。
// 放在函数里、在 try 块内调用：Electron 主进程顶层抛错会弹系统对话框挂住，测试就永远跑不完
function assertFailedCardsCollapsed() {
  if (/if \(ev\.isError\) card\.classList\.add\("open"\)/.test(APP02X)) throw new Error("app-01.js 又把出错的步骤卡自动展开了（失败多时整片摊开太乱）");
  if (!/if \(ev\.isError\) \{ card\.classList\.add\("failed"\)/.test(APP02X)) throw new Error("app-01.js 出错的步骤卡没打 .failed 标，角标直达找不到它们");
}
const SCROLLGUIDE_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style><body>"
  + "<div id='chat-scroll' style='height:300px;position:relative'><div id='chat-col' style='height:3000px'></div></div>"
  + "<button id='to-bottom'>v</button><button id='to-top'>^</button>"
  + "<div class='proc-wrap'><div class='proc-head'><span class='pt'>已完成</span></div><div class='proc-body'>"
  + "<div class='step-card'><div class='head'><span class='tag'>A</span><span class='tag ok'>完成</span></div><pre>ok-a</pre></div>"
  + "<div class='step-card failed'><div class='head'><span class='tag'>B</span><span class='tag err'>失败</span></div><pre>err-b</pre></div>"
  + "<div class='step-card'><div class='head'><span class='tag'>C</span><span class='tag ok'>完成</span></div><pre>ok-c</pre></div>"
  + "<div class='step-card failed'><div class='head'><span class='tag'>D</span><span class='tag err'>失败</span></div><pre>err-d</pre></div>"
  + "</div></div></body>";
const SCROLLGUIDE_STUBS = `const chatScroll = document.getElementById("chat-scroll");`;
const SCROLLGUIDE_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (id) => getComputedStyle(document.getElementById(id)).display !== "none";
  const sc = document.getElementById("chat-scroll"), tb = document.getElementById("to-bottom"), tt = document.getElementById("to-top");
  const fire = () => sc.dispatchEvent(new Event("scroll"));

  const col = document.getElementById("chat-col");
  const dbg = () => "col=" + col.getBoundingClientRect().height + " scrollHeight=" + sc.scrollHeight
    + " scrollTop=" + sc.scrollTop + " clientHeight=" + sc.clientHeight
    + " 离底=" + (sc.scrollHeight - sc.scrollTop - sc.clientHeight)
    + " to-bottom[" + tb.className + "]=" + getComputedStyle(tb).display
    + " to-top[" + tt.className + "]=" + getComputedStyle(tt).display;
  // 改完内容高度，得等布局真认了新高度，再去贴底。
  // 本机改完立刻读 scrollHeight 就是新值，CI 的离屏窗口（没 GPU、软件合成）上未必。
  // 2026-09-13 的 macOS CI 连着栽在这儿两次：按旧高度算出来的 scrollTop 把视口停在半空，
  // 「短对话」那一屏于是冒出了「回到最前」——第二次翻车时打出来的实测是
  // col=3000 scrollHeight=3000，也就是 style.height 已经写成 320px 了，布局还停在 3000。
  // 第一版的药方是「等 30ms 再读」，这次证明了它只是把概率压低，没消灭：
  // 定时等的是时间，要等的是布局。所以改成盯着实测高度等——等到了就走，
  // 等不到就明说是布局没跟上，别再把账算到滚动引导头上。
  // #chat-col 在这份 stub 里不带 .chat-col 类，全局又是 border-box 且 padding 归零，
  // 所以实测高度跟 style 里写的数是严格相等的，可以直接对上。
  const LAY_TRIES = 100, LAY_GAP = 20; // 上限 2 秒。等到就走，这个数只在真卡住时才烧到
  const waitLayout = async (px) => {
    for (let i = 0; i < LAY_TRIES; i++) {
      void sc.offsetHeight; // 强制一次同步布局，别等 rAF——离屏窗口里它可能根本不来
      if (Math.round(col.getBoundingClientRect().height) === px) return;
      await sleep(LAY_GAP);
    }
    throw new Error("等了 " + (LAY_TRIES * LAY_GAP / 1000) + " 秒，#chat-col 实测高度还是 "
      + col.getBoundingClientRect().height + "，没跟上设定的 " + px
      + "px：是布局没落地，不是滚动引导判断错了");
  };
  const bottom = async (h) => { col.style.height = h; await waitLayout(parseInt(h, 10)); sc.scrollTop = sc.scrollHeight; fire(); };

  // 短对话（不够一屏半）：贴底时两个按钮都不出现
  await bottom("320px");
  ok("短对话真贴到了底（这是下一条的前提，不先证明它，下一条绿了也不算数）",
    sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80, dbg());
  ok("短对话贴底时两个引导都不出现", !shown("to-bottom") && !shown("to-top"), dbg());
  // 长对话贴底：不用「回到最新」，但离顶远了要给「回到最前」（几十轮的对话想看开头不该手滚半天）
  await bottom("3000px");
  ok("长对话贴底只出「回到最前」", !shown("to-bottom") && shown("to-top"), dbg());
  // 往上翻一点（离顶不远）：只出「回到最新」，不出「回到最前」——刚滚一点就冒按钮只会晃眼
  sc.scrollTop = 300; fire();
  ok("离顶不远只出「回到最新」", shown("to-bottom") && !shown("to-top"), "to-bottom=" + shown("to-bottom") + " to-top=" + shown("to-top"));
  // 翻远了：两个都出
  sc.scrollTop = 1200; fire();
  ok("翻过一屏半出「回到最前」", shown("to-top"));
  // 人在上面看历史时新内容到了：不拽他（scrollTop 不动）= 负向控制，但红点亮起
  const before = sc.scrollTop;
  scrollBottom();
  await sleep(50);
  ok("看历史时不被拽到底", sc.scrollTop === before, "scrollTop " + before + " → " + sc.scrollTop);
  ok("新内容到了红点亮起、提示语换掉", tb.classList.contains("new") && /新内容/.test(tb.title));
  ok("红点是真画出来的（伪元素）", getComputedStyle(tb, "::after").width === "10px", getComputedStyle(tb, "::after").width);
  // 点「回到最新」：真到底，红点灭，按钮收
  tb.click();
  await sleep(80); fire();
  ok("点「回到最新」真到底", sc.scrollHeight - sc.scrollTop - sc.clientHeight < 2, "剩 " + (sc.scrollHeight - sc.scrollTop - sc.clientHeight));
  ok("到底后红点灭、「回到最新」收", !tb.classList.contains("new") && !shown("to-bottom"));
  // 点「回到最前」：往上走（平滑滚动在离屏窗口里可能一步到位，也可能分几帧，只认方向和终点）
  sc.scrollTop = 2000; fire();
  tt.click();
  let t = 0; while (sc.scrollTop > 0 && t++ < 40) await sleep(50);
  ok("点「回到最前」回到顶", sc.scrollTop === 0, "scrollTop=" + sc.scrollTop);

  // 出错步骤卡：默认收起（真样式：pre 不显示），角标一点 → 过程区展开、只摊开出错的、好的仍收着
  const wrap = document.querySelector(".proc-wrap");
  const pres = [...wrap.querySelectorAll(".step-card")].map((c) => c.querySelector("pre"));
  const disp = (el) => getComputedStyle(el).display;
  ok("出错卡默认收起（真样式）", pres.every((p) => disp(p) === "none"), pres.map(disp).join(","));
  const chip = document.createElement("span"); chip.className = "proc-warn"; chip.textContent = "⚠ 2 步出错";
  wrap.querySelector(".pt").after(wireProcWarn(chip, wrap));
  ok("角标有提示语、可点", /直达/.test(chip.title) && getComputedStyle(chip).cursor === "pointer");
  let headClicks = 0; wrap.querySelector(".proc-head").addEventListener("click", () => headClicks++);
  chip.click();
  ok("点角标不触发标题的折叠切换（否则一点开又被合上）", headClicks === 0);
  ok("点角标过程区展开", wrap.classList.contains("open") && disp(wrap.querySelector(".proc-body")) === "block");
  ok("只摊开出错的两张", disp(pres[1]) === "block" && disp(pres[3]) === "block", pres.map(disp).join(","));
  ok("没出错的仍收着", disp(pres[0]) === "none" && disp(pres[2]) === "none");
  return names;
})()`;

// 在渲染进程里跑的断言体。返回通过的用例名数组，抛错则整体失败。
const CHECKS = `(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const F = window.SvgFig;
  const parse = (html) => { const d = document.createElement("div"); d.innerHTML = html; return d; };

  // ---- 1. 正常一张图：被抠成占位符，卡片结构齐全 ----
  {
    const r = F.extractSvgFigures('前言\\n<svg viewBox="0 0 100 50"><text x="5" y="20">你好</text></svg>\\n后语');
    ok("完整 SVG 抠成占位符", r.figs.length === 1 && /\\u0000SVG0\\u0000/.test(r.text) && !/<svg/i.test(r.text));
    const d = parse(r.figs[0]);
    ok("卡片结构齐全（放大看/看源码/存矢量图/存图片/另存为… 五颗）",
       d.querySelector(".svg-fig .svg-body svg") && d.querySelectorAll(".svg-acts button").length === 5,
       d.querySelectorAll(".svg-acts button").length + " 颗");
    ok("图本身也能点开看大图", d.querySelector('.svg-body[data-a="svg-zoom"]'));
    ok("画完的图不挂任何状态标（既没「绘制中」也没「图没画完」）",
       !d.querySelector(".svg-acts .growing") && !d.querySelector(".svg-acts .partial"), d.querySelector(".svg-acts").textContent);
    ok("viewBox 图强制自适应宽度", d.querySelector("svg").getAttribute("width") === "100%" && !d.querySelector("svg").getAttribute("height"));
    ok("原文留在 data-src 里", (d.querySelector(".svg-fig").dataset.src || "").includes("<text"));
  }

  // ---- 2. \`\`\`svg 围栏 ----
  {
    const r = F.extractSvgFigures("说明\\n\\\`\\\`\\\`svg\\n<svg viewBox=\\"0 0 10 10\\"><circle r=\\"3\\"/></svg>\\n\\\`\\\`\\\`\\n收尾");
    ok("svg 围栏当图渲染", r.figs.length === 1 && !/\\\`\\\`\\\`/.test(r.text));
  }

  // ---- 3. 普通代码块里的 <svg> 不能被画出来 ----
  {
    const src = "教学：\\n\\\`\\\`\\\`html\\n<div><svg viewBox=\\"0 0 9 9\\"></svg></div>\\n\\\`\\\`\\\`\\n完";
    const r = F.extractSvgFigures(src);
    ok("代码块里的 SVG 不当图", r.figs.length === 0 && r.text === src);
  }

  // ---- 3b. 行内代码里提到 <svg> 也不能被画出来 ----
  // 用户报的真实现象：正文写"图以 \`<svg>\` 内联"，界面把这个 <svg> 当成一张正在流式输出的图，
  // 从它往后的正文整段被吞掉，只剩一个"绘制中"的空框
  {
    const src = '报告里无任何 \`src="*.svg"\` 外链引用，图以 \`<svg>\` 内联。\\n\\n下一段正文还在。';
    const r = F.extractSvgFigures(src);
    ok("行内代码里的 <svg> 不当图", r.figs.length === 0 && r.text === src);
  }
  {
    const src = '写法是 \`<svg viewBox="0 0 680 400">\`，别写死宽高。';
    const r = F.extractSvgFigures(src);
    ok("行内代码里带属性的 <svg> 也不当图", r.figs.length === 0 && r.text === src);
  }
  {
    const src = "空壳 <svg></svg> 不算图";
    const r = F.extractSvgFigures(src);
    ok("一个子元素都没有的 <svg> 不当图", r.figs.length === 0 && r.text === src);
  }

  // ---- 4. 流式：半截 SVG 也能渲染，且带"绘制中" ----
  {
    const partial = '开头\\n<svg viewBox="0 0 100 50"><text x="5" y="20">半截</text><rect wid';
    const r = F.extractSvgFigures(partial, true);
    ok("半截 SVG 也出图", r.figs.length === 1);
    const d = parse(r.figs[0]);
    ok("正在流式吐的时候才标「绘制中」", !!d.querySelector(".svg-acts .growing"), d.querySelector(".svg-acts").textContent);
    ok("半截图内容已渲染", d.querySelector("svg text") && d.querySelector("svg text").textContent === "半截");
    ok("吐到一半的标签被丢掉", !d.querySelector("svg rect"));

    // 根因是把"标签没闭合"当成了"还在写"。停笔之后这两件事必须分开说。
    const d2 = parse(F.extractSvgFigures(partial, false).figs[0]);
    ok("停笔之后不再说「绘制中」", !d2.querySelector(".svg-acts .growing"), d2.querySelector(".svg-acts").textContent);
    ok("停笔之后改说一句实话：图没画完",
       d2.querySelector(".svg-acts .partial") && d2.querySelector(".svg-acts .partial").textContent === "图没画完",
       d2.querySelector(".svg-acts").textContent);
    ok("这句实话有 title 解释为什么", (d2.querySelector(".svg-acts .partial").getAttribute("title") || "").length > 0);
    ok("不传 live 等同于停笔（sealStream 那条路）", !parse(F.extractSvgFigures(partial).figs[0]).querySelector(".growing"));
    // 闭合标签写成 </svg > 带个空格，以前正则认不出来，于是一张画完的图永远挂着"绘制中"
    const spaced = '<svg viewBox="0 0 100 50"><text x="5" y="20">写完了</text></svg >';
    const d3 = parse(F.extractSvgFigures(spaced, true).figs[0]);
    ok("</svg > 带空格也算画完，两种状态标都不挂",
       !d3.querySelector(".growing") && !d3.querySelector(".partial"), d3.querySelector(".svg-acts").textContent);
  }

  // ---- 5. 逐字流式：每一帧都不能崩，且帧数越多内容越全 ----
  {
    const full = '<svg viewBox="0 0 200 80"><style>.t{font-size:12px}</style><text class="t" x="4" y="20">增长中</text><text x="4" y="40">第二行</text></svg>';
    let rendered = 0;
    for (let i = 10; i <= full.length; i += 7) {
      const r = F.extractSvgFigures(full.slice(0, i));
      if (r.figs.length) { parse(r.figs[0]); rendered++; }
    }
    ok("逐字流式全程不崩", rendered > 10, "只成功渲染了 " + rendered + " 帧");
    const fin = parse(F.extractSvgFigures(full).figs[0]);
    ok("收尾后两行文字都在", fin.querySelectorAll("svg text").length === 2);
  }

  // ---- 6. 安全：脚本/事件/外链一律清掉 ----
  {
    const evil = '<svg viewBox="0 0 10 10" onload="window.__pwned=1">' +
      '<script>window.__pwned=2<\\/script>' +
      '<foreignObject><body>x</body></foreignObject>' +
      '<image href="https://evil.example/track.png" x="0" y="0"/>' +
      '<a xlink:href="javascript:alert(1)"><text>点我</text></a>' +
      '<rect fill="url(https://evil.example/f.svg#g)"/>' +
      '<circle fill="url(#localGrad)"/></svg>';
    const d = parse(F.extractSvgFigures(evil).figs[0]);
    const svg = d.querySelector("svg");
    ok("script 被清掉", !svg.querySelector("script"));
    ok("foreignObject 被清掉", !svg.querySelector("foreignObject"));
    ok("on* 事件被清掉", !svg.getAttribute("onload") && ![...svg.querySelectorAll("*")].some(n => [...n.attributes].some(a => a.name.toLowerCase().startsWith("on"))));
    ok("外链图片被清掉", !svg.querySelector("image[href], image[xlink\\\\:href]"));
    ok("javascript: 链接被清掉", ![...svg.querySelectorAll("a")].some(a => /javascript/i.test(a.getAttribute("xlink:href") || a.getAttribute("href") || "")));
    ok("外链 url() 被清掉", !/evil\\.example/.test(svg.outerHTML));
    ok("图内 url(#id) 保留", svg.querySelector("circle").getAttribute("fill") === "url(#localGrad)");
    ok("没有真的执行到脚本", !window.__pwned);
  }

  // ---- 7. <style> 必须限死在这张图里（模型爱用 .t / .ts 这种通名）----
  {
    const a = F.extractSvgFigures('<svg viewBox="0 0 10 10"><style>.t{fill:#f00}.a,.b{fill:#0f0}</style><text class="t">x</text></svg>');
    const css = parse(a.figs[0]).querySelector("style").textContent;
    ok("style 选择器带上了图 id", /#svgfig\\d+ \\.t\\s*\\{/.test(css) && /#svgfig\\d+ \\.a,#svgfig\\d+ \\.b\\{/.test(css), css);
    ok("scopeCss 不动 @规则", /@media/.test(F.scopeCss("@media (a){.x{c:1}}", "#z")));
    // 真挂进页面，确认没污染到外面同名元素
    const probe = document.createElement("div");
    probe.className = "t";
    probe.textContent = "界面自己的元素";
    document.body.appendChild(probe);
    const host = document.createElement("div");
    host.innerHTML = a.figs[0];
    document.body.appendChild(host);
    ok("没污染页面上的同名 class", getComputedStyle(probe).fill !== "rgb(255, 0, 0)");
    ok("图里的元素确实吃到了样式", getComputedStyle(host.querySelector("svg text")).fill === "rgb(255, 0, 0)");
    host.remove(); probe.remove();
  }

  // ---- 8. 每张图的 id 唯一，两张图的同名 class 不串 ----
  {
    const one = F.extractSvgFigures('<svg viewBox="0 0 10 10"><style>.t{fill:#00f}</style><text class="t">A</text></svg>').figs[0];
    const two = F.extractSvgFigures('<svg viewBox="0 0 10 10"><style>.t{fill:#0f0}</style><text class="t">B</text></svg>').figs[0];
    ok("两张图 id 不同", parse(one).querySelector("svg").id !== parse(two).querySelector("svg").id);
  }

  // ---- 9. 不是 SVG 的东西原样放过 ----
  {
    const src = "普通回复，包含 <div> 和 1 < 2 这种字符。";
    const r = F.extractSvgFigures(src);
    ok("非 SVG 正文不动", r.figs.length === 0 && r.text === src);
  }

  // ---- 10. 导出 PNG：var(--x) 要在导出时解析成实际色值 ----
  {
    document.documentElement.style.setProperty("--color-text-primary", "#123456");
    const host = document.createElement("div");
    host.innerHTML = F.extractSvgFigures('<svg viewBox="0 0 40 20"><text x="2" y="12" fill="var(--color-text-primary)">导出</text></svg>').figs[0];
    document.body.appendChild(host);
    return F.svgToPngDataUrl(host.querySelector("svg"), 1).then((url) => {
      ok("导出的是 PNG data URL", /^data:image\\/png;base64,/.test(url) && url.length > 200);
      host.remove();
      return names;
    });
  }
})()`;

// ================= 运行中的输入框（真源码切片：MODE_PLACEHOLDER … bindComposer） =================
// 这里验的是交互不是措辞：排队条讲清三件事（怎么插话 / 怎么停 / 想并行怎么办）、停止是一颗真按钮、
// 一颗发送键看框里有没有字决定是「停下」还是「插一句」、提示语跟着忙/闲切换、发完框空了按钮自己回到「停下」。
const C0 = APP02.indexOf("// ================= 发送（运行中按钮变「停止」）");
const C1 = APP02.indexOf("/** 把一条消息立即注入正在执行的任务");
if (C0 < 0 || C1 <= C0) throw new Error("app-02.js 里找不到「发送（运行中按钮变「停止」）… interjectText」那一段");
const COMPOSER_SRC = APP02.slice(C0, C1);
const COMPOSER_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + "<div class='queue-bar' id='queue-bar'></div><textarea id='input'></textarea><button id='send'>↑</button><button id='new-task'>新建任务</button></body>";
const COMPOSER_STUBS = [
  IC_STUB,
  "var BUSY = false; const curBusy = () => BUSY;",
  // 跟着终端（openworkbuddy 命令行）里那趟活儿时是另一套：插得上话，但停不了——那个进程不归网页管
  "var CLI = false; const cliBusy = () => CLI;",
  "let currentMode = 'craft';",
  "const inputEl = document.getElementById('input'), sendBtn = document.getElementById('send');",
  "const pendingAttach = [];",
  "let sessionId = 's1'; const sessionQueues = new Map();",
  "const qOf = (sid) => { let q = sessionQueues.get(sid); if (!q) { q = []; sessionQueues.set(sid, q); } return q; };",
  // 「任务在跑时再发一条」是插队还是排队。真源码里这两个在 app-01.js（带 localStorage 落盘），
  // 这里只要行为，不要存储——存储那一半由下面的 localStorage 往返那一节单独验
  "let busySendMode = 'interject';",
  "function setBusySendMode(m) { busySendMode = m === 'queue' ? 'queue' : 'interject'; }",
  "async function interjectText(t) { CALLS.push('interject:' + t); }",
  "const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "let HIST = 0; function renderHistory() { HIST++; }",
  "const CALLS = [];",
  "async function stopTask() { CALLS.push('stop'); }",
  "// 模拟真 send()：有草稿才发，发完框清空并让按钮重算（真源码里由 composeOutgoing 做）",
  "async function send() { const t = inputEl.value.trim(); if (!t && !pendingAttach.length) { CALLS.push('send:empty'); return; }"
  + " const text = t || '[附件]'; inputEl.value = ''; pendingAttach.length = 0; syncSendBtn();"
  // 真 send() 里这一段：本机任务在跑 → 按开关分岔；其余照旧
  + " if (curBusy() && !cliBusy()) { if (busySendMode === 'queue') { queueText(text); CALLS.push('queue:' + text); return; } await interjectText(text); return; }"
  + " CALLS.push('send:' + text); }",
].join("\n");
const COMPOSER_CHECKS = `
(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + extra : "")); names.push(n); };
  const bar = document.getElementById("queue-bar");
  const stops = () => CALLS.filter((c) => c === "stop").length;
  // 一条消息忙时会落在三条路径上（send / interject / queue）。只关心「发出去了没」的断言
  // 用这个取正文，别钉死在某一条路径上——不然以后默认从插队改成排队，一整片断言集体误报
  const sentText = () => { const c = CALLS[CALLS.length - 1] || ""; const i = c.indexOf(":"); return i < 0 ? "" : c.slice(i + 1); };
  const typeIn = (t) => { inputEl.value = t; inputEl.dispatchEvent(new Event("input", { bubbles: true })); };
  const press = (key, shift) => { const e = new KeyboardEvent("keydown", { key, shiftKey: !!shift, bubbles: true, cancelable: true }); inputEl.dispatchEvent(e); return e.defaultPrevented; };
  bindComposer();

  // 发送键从「↑ / ◼ 两个字符」换成了两个 svg 图标。断言得钉在「画的是哪个图标」上——
  // 钉 textContent 的话，图标一换成 svg 它就恒等于空串，两种状态从此长得一模一样，断言再也红不了
  const sendIcon = () => { const u = sendBtn.querySelector("use"); return u ? u.getAttribute("href").replace("#i-", "") : "(没画图标)"; };
  // ---- 闲着 ----
  updateSendUI();
  ok("闲着：排队条不显示、里面是空的", !bar.classList.contains("show") && bar.innerHTML === "");
  ok("闲着：按钮是「↑」、title 说的是发送 + Enter", sendIcon() === "arrow-up" && !sendBtn.classList.contains("stop") && sendBtn.title.includes("发送") && sendBtn.title.includes("Enter"), sendBtn.title);
  ok("闲着：提示语是本模式的（执行模式含「今天帮你做些什么」）", inputEl.placeholder.includes("今天帮你做些什么"), inputEl.placeholder);
  currentMode = "ask"; syncPlaceholder();
  ok("切到问答模式：提示语跟着换", inputEl.placeholder.includes("问我任何问题"), inputEl.placeholder);
  currentMode = "craft"; syncPlaceholder();
  ok("闲着点按钮：走发送不走停止（框空着就是 send:empty，不会误停）", (sendBtn.click(), CALLS[CALLS.length - 1] === "send:empty" && stops() === 0), CALLS.join(","));

  // ---- 任务在跑、框空着 ----
  BUSY = true; updateSendUI();
  const hint = bar.querySelector(".qb-hint");
  ok("任务在跑：排队条出来了，带提示", bar.classList.contains("show") && !!hint);
  const ht = hint.textContent;
  ok("提示讲清三件事：怎么插话（打字 + Enter）/ 怎么停 / 想并行点「新建任务」", ht.includes("打字") && ht.includes("Enter") && ht.includes("停") && ht.includes("新建任务"), ht);
  ok("提示说的是接下来会发生什么（「做完这一步就看」），不是冷冰冰的系统口吻", ht.includes("做完这一步就看") && !ht.includes("任务运行中：发消息会直接插队"), ht);
  ok("提示像人说话：有「我」", ht.includes("我"), ht);
  const stopBtn = bar.querySelector(".qb-stop");
  ok("停止是一颗真按钮（<button>），不是一段文字里的 ◼", !!stopBtn && stopBtn.tagName === "BUTTON" && !!stopBtn.querySelector('use[href="#i-square"]') && stopBtn.textContent.includes("让我停下"), stopBtn && stopBtn.outerHTML);
  const before = stops(); stopBtn.click();
  ok("点排队条里的「让我停下」真的调 stopTask", stops() === before + 1);
  ok("停止按钮 title 提到 Esc 快捷键", stopBtn.title.includes("Esc"), stopBtn.title);
  ok("任务在跑、框空着：发送键变「◼」带 .stop，title 说停下 + Esc", sendIcon() === "square" && sendBtn.classList.contains("stop") && sendBtn.title.includes("停") && sendBtn.title.includes("Esc"), sendBtn.title);
  ok("任务在跑：输入框提示语告诉用户「打字 + Enter 就插进来」", inputEl.placeholder.includes("Enter") && inputEl.placeholder.includes("插") && inputEl.placeholder !== MODE_PLACEHOLDER.craft, inputEl.placeholder);
  const b0 = stops(); sendBtn.click();
  ok("框空着点发送键 = 停下", stops() === b0 + 1);

  // ---- 任务在跑、打了字 ----
  typeIn("改成蓝色");
  ok("一打字：发送键变回「↑」、去掉 .stop、加 .interject", sendIcon() === "arrow-up" && !sendBtn.classList.contains("stop") && sendBtn.classList.contains("interject"), sendBtn.className);
  ok("打了字的 title 说清是「插一句」+ Enter", sendBtn.title.includes("插一句") && sendBtn.title.includes("Enter"), sendBtn.title);
  const b1 = stops(); sendBtn.click();
  // 这一条盯的是「不许误停」，不是走的哪条投递路径：默认插队所以落在 interject: 上，
  // 拨到排队会落在 queue: 上，两种都算过——真正要红的是 stops() 涨了
  ok("打了字点发送键：走发送不走停止 —— 以前这里一点任务就没了",
     CALLS[CALLS.length - 1] === "interject:改成蓝色" && stops() === b1, CALLS.join(","));
  ok("发出去框空了：按钮自己回到「◼ 停下」，不用等下一次 updateSendUI", sendIcon() === "square" && sendBtn.classList.contains("stop") && !sendBtn.classList.contains("interject"), sendBtn.className);
  typeIn("再加个标题");
  ok("Shift+Enter 只换行不发", !press("Enter", true) && sentText() !== "再加个标题");
  ok("Enter 发出去（默认行为被拦，不会真换行）", press("Enter", false) && sentText() === "再加个标题", CALLS.join(","));
  ok("Enter 发完按钮回到「◼」", sendIcon() === "square");
  pendingAttach.push("截图.png"); syncSendBtn();
  ok("只贴了附件没打字：也算有话要说 → 「↑」", sendIcon() === "arrow-up" && !sendBtn.classList.contains("stop"));
  pendingAttach.length = 0; syncSendBtn();
  ok("附件撤掉：回到「◼」", sendIcon() === "square" && sendBtn.classList.contains("stop"));

  // ---- 跟着终端里那趟活儿：插得上话，但停不了 ----
  // 这个进程是 openworkbuddy 命令行起的，不归网页管。画一颗按下去没反应的「停」键是骗人，
  // 所以这一档专门不给停止态，提示语直说「回终端按 Ctrl+C」
  BUSY = false; CLI = true; typeIn(""); updateSendUI();
  ok("跟着终端那趟：提示语说清能插话、也说清想停得回终端",
    inputEl.placeholder.includes("终端") && inputEl.placeholder.includes("Enter") && inputEl.placeholder.includes("Ctrl+C"), inputEl.placeholder);
  ok("不画那颗按下去没反应的「停」键", sendIcon() === "arrow-up" && !sendBtn.classList.contains("stop"), sendBtn.className);
  const c0 = stops(); sendBtn.click();
  ok("框空着点一下也不会去停（停不了就别假装能停）", stops() === c0, CALLS.join(","));
  typeIn("顺便把日志也贴出来");
  ok("打了字：按钮说的是「插一句给终端里的它」", sendBtn.title.includes("插一句") && sendBtn.title.includes("终端") && sendBtn.classList.contains("interject"), sendBtn.title);
  ok("Enter 照样送得出去", press("Enter", false) && sentText() === "顺便把日志也贴出来", CALLS.join(","));
  // 反向对照：同样是「忙着 + 框空着」，本机那趟就该给停止键——证明上面几条不是恒真
  CLI = false; BUSY = true; typeIn(""); updateSendUI();
  ok("反向对照：本机自己跑的那趟，框空着就是「◼ 停下」", sendIcon() === "square" && sendBtn.classList.contains("stop"), sendBtn.className);
  const c1 = stops(); sendBtn.click();
  ok("反向对照：这一下是真的去停了", stops() === c1 + 1);

  // ---- 「插队 / 排队」二选一 ----
  // 以前只有插队一条路：一句补充说明当场塞进去，Agent 中途改道，前面几步白做，
  // 用户连「我这条不急」都没地方说。这一节验的是这个选择真的改变了行为，不只是换了个字。
  CLI = false; BUSY = true; typeIn(""); sessionQueues.set("s1", []); updateSendUI();
  const sw = bar.querySelector(".qb-sw");
  ok("任务在跑：插队/排队的开关出来了，两个都在", !!sw && sw.querySelectorAll(".qb-o").length === 2, bar.innerHTML.slice(0, 120));
  const optOf = (m) => bar.querySelector('.qb-o[data-m="' + m + '"]');
  ok("默认选中的是「插队」（保持老行为，不偷偷改掉所有人的习惯）",
     optOf("interject").classList.contains("is-on") && !optOf("queue").classList.contains("is-on"));
  ok("选中态是能被读屏读出来的 radio，不只是一层颜色",
     sw.getAttribute("role") === "radiogroup" && optOf("interject").getAttribute("aria-checked") === "true"
     && optOf("queue").getAttribute("aria-checked") === "false");
  typeIn("等等，标题改成蓝色");
  ok("插队态：按钮是「↑」、说的是插一句", sendIcon() === "arrow-up" && sendBtn.title.includes("插一句"), sendBtn.title);
  const i0 = CALLS.length; sendBtn.click(); await new Promise((r) => setTimeout(r, 0));
  ok("插队态点发送：走注入，不进队列",
     CALLS[CALLS.length - 1] === "interject:等等，标题改成蓝色" && (sessionQueues.get("s1") || []).length === 0, CALLS.slice(i0).join(","));

  optOf("queue").click();
  ok("拨到「排队」：选中态跟着换（两边都要变，不然会出现两个都亮）",
     optOf("queue").classList.contains("is-on") && !optOf("interject").classList.contains("is-on"));
  ok("排队态：提示语改口说「排到队尾」，别让人以为还会插进去",
     inputEl.placeholder.includes("排进队尾") || inputEl.placeholder.includes("排到队尾"), inputEl.placeholder);
  typeIn("顺便再做个 B 方案");
  ok("排队态：发送键换成沙漏 + 说「不打断」", sendIcon() === "hourglass" && sendBtn.classList.contains("queued")
     && !sendBtn.classList.contains("interject") && sendBtn.title.includes("不打断"), sendBtn.title + " / " + sendBtn.className);
  const q0 = CALLS.length; sendBtn.click(); await new Promise((r) => setTimeout(r, 0));
  ok("排队态点发送：进队列，一次都没去打断当前任务",
     (sessionQueues.get("s1") || []).length === 1 && sessionQueues.get("s1")[0].text === "顺便再做个 B 方案"
     && !CALLS.slice(q0).some((c) => c.startsWith("interject:")), CALLS.slice(q0).join(","));
  ok("排进去的当场变成一枚 chip，看得见也撤得掉", bar.querySelectorAll(".q-chip").length === 1);
  ok("排队条的提示语也跟着改口（不然开关说排队、提示说插队，两边打架）",
     bar.querySelector(".qb-hint").textContent.includes("排到队尾"), bar.querySelector(".qb-hint").textContent);
  // 反向对照：拨回插队，同样一句话就不进队列了——证明上面几条不是「反正都进队列」
  optOf("interject").click(); typeIn("再补一句");
  const r0 = (sessionQueues.get("s1") || []).length; sendBtn.click(); await new Promise((r) => setTimeout(r, 0));
  ok("反向对照：拨回插队，同一个动作又走注入了", (sessionQueues.get("s1") || []).length === r0
     && CALLS[CALLS.length - 1] === "interject:再补一句", CALLS[CALLS.length - 1]);
  sessionQueues.set("s1", []); typeIn(""); updateSendUI();

  // ---- 排了队的消息 ----
  sessionQueues.set("s1", [{ text: "顺便把页脚也改了", mode: "craft" }]);
  renderQueueBar();
  ok("排队中的消息显示成 chip，提示仍在", bar.querySelectorAll(".q-chip").length === 1 && bar.querySelector(".q-chip .qt").textContent.includes("页脚") && !!bar.querySelector(".qb-hint"));
  bar.querySelector(".q-chip .qx").click();
  ok("点 ✕ 取消这条排队消息", bar.querySelectorAll(".q-chip").length === 0 && sessionQueues.get("s1").length === 0);

  // ---- 任务结束 ----
  BUSY = false; updateSendUI();
  ok("任务结束：排队条隐藏并清空", !bar.classList.contains("show") && bar.innerHTML === "");
  ok("任务结束：提示语还原成本模式的", inputEl.placeholder === MODE_PLACEHOLDER.craft, inputEl.placeholder);
  ok("任务结束：发送键回到「↑ 发送」", sendIcon() === "arrow-up" && !sendBtn.classList.contains("stop") && !sendBtn.classList.contains("interject") && sendBtn.title.includes("发送"));
  ok("每次 updateSendUI 都刷了侧栏（运行中小圆点）", HIST >= 3, HIST);
  return names;
})()
`;

// 渲染进程的 console 抄一份到主进程：页面里抛错时 executeJavaScript 只回一句
// 「Script failed to execute」，真正的报错文本在渲染进程 console 里，不抄出来根本没法定位。
// ---- 连接器页：预设目录一键接入 + Key 只给键名不给值 + 录屏遮罩层 ----
const HUB_MCP_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body><div id='hub-body'></div></body>";
const HUB_MCP_STUBS = `
  ${IC_STUB}
var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
var TOASTS = [], POSTS = [], RENDERS = 0;
var toast = (m) => { TOASTS.push(String(m)); };
var hubState = { tab: "mcp", q: "", mine: false };
var hubMatch = (q, ...fields) => !q || fields.filter(Boolean).join(" ").toLowerCase().includes(q.trim().toLowerCase());
// 这一组测的是平台管理员那一面（预设目录、接入、Key 只给键名），所以身份钉死成 true
var amPlatformOwner = () => true;
var renderHubBody = () => { RENDERS++; return renderHubMcp(document.getElementById("hub-body")); };
window.askConfirm = async () => true;
var SERVERS = [
  { name: "mysql", transport: "stdio", command: "npx", args: ["-y", "@benborla29/mcp-server-mysql"], env_keys: ["MYSQL_USER", "MYSQL_PASS"], connected: true, tools: [{ name: "query", description: "run sql" }] },
  { name: "deepwiki2", transport: "streamable-http", url: "https://mcp.deepwiki.com/mcp", header_keys: ["Authorization"], connected: false, error: "握手超时", tools: [] },
  // 真实形状：死因把进程最后几行 stderr 都带上了，十行都不止；命令行也长到放不下
  { name: "filesystem", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/somebody/Downloads/培训案例材料", "/Users/somebody/Documents/归档/2026"], connected: false, tools: [],
    error: "MCP 服务器 filesystem 已退出（退出码 1）：Warning: Cannot access directory /Users/somebody/Downloads/培训案例材料, skipping / Warning: Cannot access directory /Users/somebody/Documents/归档/2026, skipping / Error: None of the specified directories are accessible" },
  { name: "notion", transport: "streamable-http", url: "https://mcp.notion.com/mcp", header_keys: ["Authorization"], connected: true, plugin: "notion-workspace", tools: [{ name: "search", description: "搜" }] },
  // 插件名长到一个角标装不下：这排卡最窄 248px，没封宽度的话它会顶到左边那张卡上
  { name: "airtable", transport: "stdio", command: "npx", args: ["-y", "airtable-mcp"], env_keys: [], connected: true, plugin: "modelcontextprotocol-server-airtable-数据表", tools: [{ name: "list", description: "列" }] },
];
var CATALOG = {
  categories: ["搜索与网页", "文件与开发", "数据库"],
  tools: { npx: "/x/npx", uvx: "" },
  items: [
    { name: "brave-search", label: "Brave 搜索", icon: "🦁", desc: "查资料", category: "搜索与网页", kind: "stdio", command: "/x/npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "" }, docs: "https://brave.com/search/api/", needs: "npx" },
    { name: "deepwiki", label: "DeepWiki", icon: "📚", desc: "读仓库文档", category: "搜索与网页", kind: "http", url: "https://mcp.deepwiki.com/mcp", headers: {}, docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp", needs: "" },
    { name: "fetch", label: "网页抓取", icon: "🌐", desc: "抓网页转 markdown", category: "搜索与网页", kind: "stdio", command: "uvx", args: ["mcp-server-fetch"], env: {}, docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch", needs: "uvx" },
    { name: "github", label: "GitHub", icon: "🐙", desc: "仓库 / Issue / PR", category: "文件与开发", kind: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer " }, docs: "https://github.com/github/github-mcp-server", needs: "" },
    { name: "mysql", label: "MySQL", icon: "🐬", desc: "查库", category: "数据库", kind: "stdio", command: "/x/npx", args: ["-y", "@benborla29/mcp-server-mysql"], env: { MYSQL_HOST: "127.0.0.1", MYSQL_USER: "", MYSQL_PASS: "" }, docs: "https://github.com/benborla/mcp-server-mysql", needs: "npx" },
  ],
};
window.fetch = async (url, opt) => {
  const u = String(url).split("?")[0];
  const j = (o) => ({ ok: true, json: async () => o });
  if (u === "/api/mcp" && opt && opt.method === "POST") { POSTS.push(JSON.parse(opt.body)); return j({ ok: true }); }
  if (u === "/api/mcp") return j({ servers: JSON.parse(JSON.stringify(SERVERS)), total_tools: 1 });
  if (u === "/api/mcp/catalog") return j(JSON.parse(JSON.stringify({ ...CATALOG, items: CATALOG.items.map((it) => ({ ...it, configured: SERVERS.some((s) => s.name === it.name) })) })));
  throw new Error("未知请求 " + u);
};
`;
const HUB_MCP_SRC = APP05.slice(APP05.indexOf("async function renderHubMcp(box) {"), APP05.indexOf("// ================= 参考模板库"));
const HUB_MCP_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const box = document.getElementById("hub-body");
  const $ = (q) => box.querySelector(q);
  const card = (n) => [...box.querySelectorAll(".ex-card[data-pi]")].find((c) => c.querySelector(".al") && c.querySelector(".al").textContent === n);
  const disp = (el) => getComputedStyle(el).display;
  await renderHubBody(); await wait(20);

  // 已接入卡片：只显示环境变量的键名，页面上不能出现任何值的形状（GET 本来就没给值，这里是防前端自己编）
  const html = box.innerHTML;
  ok("已接入 mysql 卡片写明带 2 个环境变量（只有键名）", html.includes("带 2 个环境变量：MYSQL_USER、MYSQL_PASS"));
  ok("远程 deepwiki2 卡片写明带 1 个请求头", html.includes("带 1 个请求头：Authorization"));
  ok("页面上没有令牌值形状（Bearer xxx / KEY=值）", !/Bearer\\s+\\S+/.test(box.textContent) && !/MYSQL_PASS=\\S/.test(box.textContent));

  // ---- 连不上的卡片：死因要看得清，不能被卡成中间一截 ----
  const mcard = (n) => [...box.querySelectorAll(".ex-card[data-mi]")].find((c) => c.querySelector(".nm > span").textContent === n);
  const fsc = mcard("filesystem"), errBox = fsc.querySelector(".mcp-server-error"), errIn = errBox.firstElementChild;
  const more = fsc.querySelector(".mcp-err-more");
  const FULL = SERVERS.find((s) => s.name === "filesystem").error;
  ok("死因走独立的错误块，不再塞进标签胶囊", !!errBox && !fsc.querySelector(".tg"));
  ok("全文在 title 里（鼠标悬上去 / 拷得走）", errBox.title === FULL);
  const lh = parseFloat(getComputedStyle(errIn).lineHeight);
  ok("错误块封顶三行", Math.abs(errIn.clientHeight - lh * 3) < 1.5, "高 " + errIn.clientHeight + "，一行 " + lh);
  // 真正被投诉的那一条：夹行数的盒子自己带 padding，下边那平会把第四行漏出来半条
  const eb = getComputedStyle(errBox);
  ok("夹行数的那层不带 padding，不会露出半条第四行",
    Math.abs(errBox.clientHeight - (errIn.clientHeight + parseFloat(eb.paddingTop) + parseFloat(eb.paddingBottom))) < 1.5);
  ok("裁了才给「展开」", !more.hidden && errIn.scrollHeight > errIn.clientHeight + 1);
  ok("短死因不给「展开」", mcard("deepwiki2").querySelector(".mcp-err-more").hidden);
  more.click(); await wait(10);
  ok("点展开：全文都在、按钮变「收起」", errIn.scrollHeight <= errIn.clientHeight + 1 && more.textContent === "收起" && errBox.textContent === FULL);
  more.click(); await wait(10);
  ok("再点收回去", errIn.scrollHeight > errIn.clientHeight + 1 && more.textContent === "展开");
  // 命令行同理：max-height 跟行高对不上时，第三行会从字中间横切开
  const cmdEl = fsc.querySelector(".mcp-server-command"), clh = parseFloat(getComputedStyle(cmdEl).lineHeight);
  ok("命令行也是整行截断，没有被横切的那一行", Math.abs(cmdEl.clientHeight % clh) < 1 || Math.abs((cmdEl.clientHeight % clh) - clh) < 1,
    "高 " + cmdEl.clientHeight + "，一行 " + clh);
  ok("未连接：头像和状态字都是错误色，不是跟已连接一个样",
    fsc.querySelector(".av").classList.contains("bad") && fsc.querySelector(".al").classList.contains("bad")
    && getComputedStyle(fsc.querySelector(".al")).color !== getComputedStyle(mcard("mysql").querySelector(".al")).color);
  // 插件角标是绝对定位的右上角，不让一行的话它就压在「已连接 · N 个工具」上
  const nc = mcard("notion"), fl = nc.querySelector(".flag").getBoundingClientRect(), al = nc.querySelector(".al").getBoundingClientRect();
  ok("插件角标不压状态字", fl.bottom <= al.top + 0.5 || fl.right <= al.left + 0.5 || fl.left >= al.right - 0.5,
    "角标 " + JSON.stringify(fl) + " 状态 " + JSON.stringify(al));

  // 推荐目录：按分类分组，五张卡，标记各归各
  // 同一条规则要管住所有带角标的卡，不只服务器卡：目录卡的副标题就是连接器 ID，也在同一行右边
  const pc = card("mysql"), pfl = pc.querySelector(".flag").getBoundingClientRect(), pal = pc.querySelector(".al").getBoundingClientRect();
  ok("目录卡上的「已接入」角标也不压副标题", pfl.bottom <= pal.top + 0.5 || pfl.right <= pal.left + 0.5 || pfl.left >= pal.right - 0.5,
     "角标 " + JSON.stringify(pfl) + " 副标题 " + JSON.stringify(pal));

  // 角标不换行又是绝对定位，只靠右边靠着：名字一长就往左长，长出卡片就压到邻居身上。
  // 量最窄那一列（grid 最小 248px），宽屏幕下卡片被拉宽，这条尺子量不出东西。
  const gridW = box.querySelector(".card-grid");
  const prevW = box.style.width;
  box.style.width = "272px"; // 248 + 12 gap + 一点富余，逼出单列
  const spills = [...box.querySelectorAll(".ex-card")].filter((c) => c.querySelector(".flag")).map((c) => {
    const cb = c.getBoundingClientRect(), fb = c.querySelector(".flag").getBoundingClientRect();
    return { txt: c.querySelector(".flag").textContent, out: Math.max(cb.left - fb.left, fb.right - cb.right) };
  });
  ok("角标不会顶出卡片去压旁边那张（按最窄一列量）", spills.every((r) => r.out <= 0.5),
     JSON.stringify(spills.filter((r) => r.out > 0.5)));
  ok("长插件名在角标上截短，全名留在 title 里", (() => {
    const c = [...box.querySelectorAll(".ex-card[data-mi]")].find((x) => (x.querySelector(".al") || {}).textContent !== undefined && x.textContent.includes("airtable"));
    const f = c && c.querySelector(".flag");
    return !!f && /\u2026$/.test(f.textContent) && f.title === "来自插件 modelcontextprotocol-server-airtable-数据表";
  })());
  // 反向对照：截短是第一道，封宽度是第二道。搬一张没经过截短的卡进来，
  // 把封宽度去掉，它当场顶出卡片；加回来又收住了。
  const probe = document.createElement("div");
  probe.className = "ex-card";
  probe.innerHTML = '<span class="flag">来自插件 一二三四五六七八九十一二三四五六七八九十</span><div class="hd"><div class="nm"><span>x</span></div></div>';
  gridW.appendChild(probe);
  const outOf = () => {
    const cb = probe.getBoundingClientRect(), fb = probe.querySelector(".flag").getBoundingClientRect();
    return Math.max(cb.left - fb.left, fb.right - cb.right);
  };
  ok("封了宽度之后，再长的角标也待在卡里", outOf() <= 0.5, "顶出 " + outOf());
  const undo = document.createElement("style");
  undo.textContent = ".ex-card .flag { max-width: none; }";
  document.head.appendChild(undo);
  ok("反向对照：去掉封宽度，长角标当场顶出卡片", outOf() > 0.5, "顶出 " + outOf());
  undo.remove();
  probe.remove();
  box.style.width = prevW;

  // 「去哪拿」是真 <a>。全库没一条 a 的基底样式的话，它就是浏览器默认那种蓝加下划线，
  // 整页就这几处跳色。这条量的是算出来的颜色，不是读 CSS 源码。
  const UA_BLUE = ["rgb(0, 0, 238)", "rgb(0, 0, 255)", "rgb(-webkit-link)"];
  const dl = box.querySelector(".mcp-docs-link");
  const dcs = dl && getComputedStyle(dl);
  ok("「去哪拿」不是浏览器默认的蓝字下划线", !!dl && !UA_BLUE.includes(dcs.color) && !/underline/.test(dcs.textDecorationLine),
     dl ? dcs.color + " / " + dcs.textDecorationLine : "没找到链接");
  ok("「去哪拿」跟旁边的小标记同高同字号", (() => {
    const tag = dl.parentElement.querySelector("i");
    return Math.abs(dl.getBoundingClientRect().height - tag.getBoundingClientRect().height) < 0.5
      && dcs.fontSize === getComputedStyle(tag).fontSize;
  })(), dl.getBoundingClientRect().height + " vs " + dl.parentElement.querySelector("i").getBoundingClientRect().height);
  // 接着往下测底座：随便一个没挂任何 class 的链接也得是品牌色（插件主页、技能仓库那一批都靠它）
  const bare = document.createElement("a");
  bare.href = "https://example.com"; bare.textContent = "x";
  box.appendChild(bare);
  ok("没挂 class 的裸链接也走品牌色", !UA_BLUE.includes(getComputedStyle(bare).color), getComputedStyle(bare).color);
  bare.remove();

  ok("推荐连接器区块出现，按目录分类分组", html.includes("推荐连接器") && box.querySelectorAll(".ex-card[data-pi]").length === 5 && html.includes("搜索与网页") && html.includes("数据库"));
  ok("已接入的 mysql 预设：标「已接入」、按钮禁用", card("mysql").querySelector(".flag").textContent === "已接入" && card("mysql").querySelector(".mcp-use").disabled);
  ok("本机没 uvx：fetch 卡标「没找到 uvx」+ 顶部提示装 uv", card("fetch").querySelector(".flag").textContent === "没找到 uvx" && html.includes("本机没找到 uvx") && !html.includes("本机没找到 npx"));
  ok("deepwiki（远程免 Key）：标签「远程」「免 Key」", card("deepwiki").querySelector(".tg").textContent.includes("远程") && card("deepwiki").querySelector(".tg").textContent.includes("免 Key"));
  ok("brave-search：标「要填 1 个 Key」+「去哪拿」链接指向官方文档", card("brave-search").querySelector(".tg").textContent.includes("要填 1 个 Key") && card("brave-search").querySelector(".mcp-docs-link").href === "https://brave.com/search/api/");
  ok("空目录状态：表单默认收起", disp($("#mcp-add-form")) === "none");

  // 点「接入」brave：表单弹开、字段预填、光标停在 Key 框、提示还差什么
  card("brave-search").querySelector(".mcp-use").click(); await wait(10);
  ok("点「接入」→ 表单弹开、命令/参数/名称预填", disp($("#mcp-add-form")) !== "none" && $("#mcp-name").value === "brave-search" && $("#mcp-cmd").value === "/x/npx" && $("#mcp-args").value === "-y @brave/brave-search-mcp-server");
  ok("环境变量框预填 BRAVE_API_KEY=（值留给用户）", $("#mcp-env").value === "BRAVE_API_KEY=");
  ok("提示「还差 BRAVE_API_KEY 没填」+ 光标停在环境变量框", $("#mcp-msg").textContent.includes("还差 BRAVE_API_KEY 没填") && document.activeElement === $("#mcp-env"));
  ok("「去哪拿 Key」链接显示并指向文档", disp($("#mcp-docs")) !== "none" && $("#mcp-docs").href === "https://brave.com/search/api/");
  // Key 没填就点添加：拦下来，不发请求
  $("#mcp-add").click(); await wait(10);
  ok("Key 没填点「添加并连接」→ 提示还差、不发请求", TOASTS.some((t) => t.includes("还差 BRAVE_API_KEY")) && POSTS.length === 0);
  // 填了带等号的值：按第一个等号切；原有条目不带 env / headers 回传
  $("#mcp-env").value = "BRAVE_API_KEY=abc=123";
  $("#mcp-add").click(); await wait(30);
  ok("填好 Key 后添加：发了一次 POST", POSTS.length === 1);
  const body = POSTS[0].servers;
  ok("POST 里原有 mysql 条目不带 env（后端沿用原来的 Key）", body.find((s) => s.name === "mysql") && !("env" in body.find((s) => s.name === "mysql")) && body.find((s) => s.name === "mysql").command === "npx");
  ok("POST 里原有远程条目不带 headers", body.find((s) => s.name === "deepwiki2") && !("headers" in body.find((s) => s.name === "deepwiki2")) && !("command" in body.find((s) => s.name === "deepwiki2")));
  ok("新条目 env 按第一个等号切（值里的等号保住）", JSON.stringify(body.find((s) => s.name === "brave-search").env) === JSON.stringify({ BRAVE_API_KEY: "abc=123" }));
  ok("保存后重新渲染", RENDERS >= 2);
  await wait(20);

  // github（远程 + 要填 Authorization）
  card("github").querySelector(".mcp-use").click(); await wait(10);
  ok("接入 github：切到远程单选、地址预填、请求头预填 Authorization: Bearer", $('input[name="mcp-kind"][value="http"]').checked && $("#mcp-url").value === "https://api.githubcopilot.com/mcp/" && $("#mcp-headers").value === "Authorization: Bearer " && disp($(".mcp-f-http")) !== "none" && disp($(".mcp-f-stdio")) === "none");
  ok("光标停在请求头框", document.activeElement === $("#mcp-headers"));
  const n0 = POSTS.length;
  $("#mcp-add").click(); await wait(10);
  ok("只有「Bearer 」没令牌就点添加 → 拦下，提示还差 Authorization", TOASTS.some((t) => t.includes("还差 Authorization")) && POSTS.length === n0);

  // deepwiki（远程免 Key）：直接可点添加
  card("deepwiki").querySelector(".mcp-use").click(); await wait(10);
  ok("接入免 Key 的 deepwiki：提示「启动命令已填好」、光标停在添加按钮", $("#mcp-msg").textContent.includes("已填好") && document.activeElement === $("#mcp-add") && disp($("#mcp-docs")) !== "none");
  $("#mcp-add").click(); await wait(30);
  const dw = POSTS[POSTS.length - 1].servers.find((s) => s.name === "deepwiki");
  ok("免 Key 远程直接添加：POST 带 name+url+空 headers", POSTS.length === n0 + 1 && dw && dw.url === "https://mcp.deepwiki.com/mcp" && JSON.stringify(dw.headers) === "{}");
  await wait(20);

  // 搜索框和「只看已连接」一起管推荐目录
  hubState.q = "deep"; await renderHubBody(); await wait(20);
  ok("搜索「deep」：推荐目录只剩 deepwiki 一张", box.querySelectorAll(".ex-card[data-pi]").length === 1 && card("deepwiki"));
  hubState.q = ""; hubState.mine = true; await renderHubBody(); await wait(20);
  ok("「只看已连接」：不显示推荐目录", !box.innerHTML.includes("推荐连接器") && box.querySelectorAll(".ex-card[data-pi]").length === 0);
  hubState.mine = false;

  // 空态：一个连接器都没有时，提示从推荐里挑
  SERVERS.length = 0; await renderHubBody(); await wait(20);
  ok("没有连接器：空态提示从下面推荐里挑", box.innerHTML.includes("从下面的推荐里挑一个点「接入」") && box.querySelectorAll(".ex-card[data-pi]").length === 5);
  ok("此时 mysql 预设不再标已接入、按钮可点", !card("mysql").querySelector(".flag") && !card("mysql").querySelector(".mcp-use").disabled);
  return names;
})()
`;
// 录屏遮罩层在真浏览器里跑：静态文本 / 输入框值 / title 都遮，后来插进来的节点和改过的文字也遮
// ---------- 产出到了不抢版面：以前是「有产出就把右侧预览 / 成果文件面板弹出来」 ----------
// 处理器把当下状态喂给 outputArrivalPlan（纯函数），拿到「推进快照 / 记角标 / 原地刷新」三个动作再套用。
// 这里连真样式一起注进来，角标的位置和可见性验的是浏览器算出来的盒子
const ARRIVAL_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style><body>"
  + "<div class='right' style='padding:20px'><button id='toggle-files'><svg class='i'></svg> 成果文件</button></div>"
  + "<div id='files-panel' class='files-panel'></div><div id='preview-panel' class='preview-panel'></div></body>";
const ARRIVAL_STUBS = `
  ${IC_STUB}
const CALLS = { snap: [], pv: [] };
function snapshotFiles(files){ CALLS.snap.push((files || []).length); }
const pvPanel = document.getElementById("preview-panel");
let pvCurrent = null;
function previewFile(name){ CALLS.pv.push(name); pvPanel.classList.add("show"); pvCurrent = name; }
// 这两条跟 app-01.js 里的真源必须一字不差（e2e 的 testOutputArrivalStatic 会比对字面量）
const OFFICE_RE = /\.(doc|ppt|xls)$/i;
const SCAFFOLD_RE = /^(PROGRESS|TODO|NOTES?|README)\.(md|txt)$/i;
`;
const AR0 = APP02X.indexOf("// ---- 正文里提到的产出文件名 → 可点开的链接 ----");
const AR1 = APP02X.indexOf('document.getElementById("fp-close").onclick');
if (AR0 < 0 || AR1 < 0 || AR1 < AR0) throw new Error("app-01.js 里找不到 linkifyOutputs / outputArrivalPlan / toggle-files 那段");
const ARRIVAL_SRC = APP02X.slice(AR0, AR1);
const ARRIVAL_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const F = (name) => ({ name, size: 100, mtime: "2026-09-05T00:00:00.000Z" });
  const btn = document.getElementById("toggle-files"), fp = document.getElementById("files-panel");
  const badge = () => btn.querySelector(".fb-badge");
  const base = { turnOut: [F("报告.html"), F("图.png"), F("方案.pptx")], replaying: false, otherSession: false, pvOpen: false, pvCurrent: null, filesOpen: false };

  // 主线：网页产出到了，右侧什么都不弹（以前这里会 previewFile(报告.html) + 把成果文件面板 show 出来）
  const p = outputArrivalPlan(base);
  ok("有产出：推进快照、角标 3、不刷新预览", p.snapshot === true && p.badge === 3 && p.refresh === null, JSON.stringify(p));
  applyOutputArrival(p, base.turnOut);
  ok("套用后：预览没开、成果文件面板没开、previewFile 没被叫", !pvPanel.classList.contains("show") && !fp.classList.contains("show") && CALLS.pv.length === 0);
  ok("快照推进了一次、拿的是完整列表", CALLS.snap.length === 1 && CALLS.snap[0] === 3);
  ok("「成果文件」按钮上出角标 3", !!badge() && badge().textContent === "3");
  const br = badge().getBoundingClientRect(), bb = btn.getBoundingClientRect();
  ok("角标是算出来看得见的圆点，贴在按钮右上角（" + Math.round(br.width) + "×" + Math.round(br.height) + "）",
    br.width >= 18 && br.height >= 18 && br.right > bb.right - 4 && br.top < bb.top + 4);
  applyOutputArrival(outputArrivalPlan({ ...base, turnOut: [F("a.md"), F("b.md")] }), []);
  ok("再来两件：角标累加成 5", badge().textContent === "5");
  btn.click();
  ok("点「成果文件」：面板开了、角标摘掉", fp.classList.contains("show") && !badge());
  const p2 = outputArrivalPlan({ ...base, filesOpen: true });
  ok("面板开着时来产出：不记角标（用户正看着列表）、快照照推进", p2.badge === 0 && p2.snapshot === true);
  btn.click();
  ok("再点一下面板收起", !fp.classList.contains("show"));

  // 三种「不该动」的情形
  const p3 = outputArrivalPlan({ ...base, replaying: true });
  ok("回放历史：快照不动、角标不记、不刷新", p3.snapshot === false && p3.badge === 0 && p3.refresh === null);
  const p4 = outputArrivalPlan({ ...base, otherSession: true });
  ok("用户已切到别的会话：只推进快照", p4.snapshot === true && p4.badge === 0 && p4.refresh === null);
  const p5 = outputArrivalPlan({ ...base, turnOut: [] });
  ok("没产出：推进基线、其余不动", p5.snapshot === true && p5.badge === 0 && p5.refresh === null);

  // 唯一会碰右侧的情形：预览本来就开着、看的正是这回合改过的文件 → 原地刷新
  pvPanel.classList.add("show"); pvCurrent = "报告.html";
  const p6 = outputArrivalPlan({ ...base, pvOpen: true, pvCurrent: "报告.html" });
  ok("预览开着、看的正是改过的文件：原地刷新这一个", p6.refresh === "报告.html" && p6.badge === 3);
  applyOutputArrival(p6, base.turnOut);
  ok("刷新走 previewFile，只刷这一个、面板布局没变", CALLS.pv.length === 1 && CALLS.pv[0] === "报告.html" && !fp.classList.contains("show"));
  // 反向断言：差一点都不许弹
  ok("预览开着但看的是别的文件：不动它", outputArrivalPlan({ ...base, pvOpen: true, pvCurrent: "别的.html" }).refresh === null);
  ok("预览关着：哪怕 pvCurrent 残留也不弹", outputArrivalPlan({ ...base, pvOpen: false, pvCurrent: "报告.html" }).refresh === null);
  ok("预览开着但这回合没产出：不刷", outputArrivalPlan({ ...base, turnOut: [], pvOpen: true, pvCurrent: "报告.html" }).refresh === null);

  clearFilesBadge();
  applyOutputArrival({ snapshot: false, badge: 500, refresh: null }, []);
  ok("角标封顶 99", badge().textContent === "99");
  clearFilesBadge();
  ok("清空后按钮上没有角标残留", !badge());

  // ---------- 正文里提到的文件名 → 可点开的链接 ----------
  const OUTS = [F("任务_0910/张三_简历.html"), F("任务_0910/张三_简历.docx"), F("任务_0910/PROGRESS.md"), F("张三_简历.html")];
  const targets = fileLinkTargets(OUTS);
  ok("裸文件名指向路径最浅的那份（同一件产出常被拷两份）", targets.get("张三_简历.html") === "张三_简历.html");
  ok("全路径本身也认", targets.get("任务_0910/张三_简历.docx") === "任务_0910/张三_简历.docx");
  const host = document.createElement("div");
  host.className = "a-text";
  host.innerHTML = "<p>简历已经写好了，在 张三_简历.html 里，Word 版是 任务_0910/张三_简历.docx。</p>"
    + "<pre><code>cp 张三_简历.html /tmp/</code></pre>"
    + "<p>进度记在 PROGRESS.md，另外 别的.html 和 data.md 不是这趟的产出。</p>"
    + "<p>生成了张三_简历.html供你查看</p>";
  document.body.appendChild(host);
  const hits = linkifyOutputs(host, targets);
  const lns = [...host.querySelectorAll(".file-ln")];
  ok("正文里的文件名都变成了链接（" + hits + " 处）", hits === 4 && lns.length === 4);
  ok("裸文件名链到完整相对路径", lns[0].textContent === "张三_简历.html" && lns[0].dataset.name === "张三_简历.html");
  ok("全路径原样链", lns[1].textContent === "任务_0910/张三_简历.docx" && lns[1].dataset.name === "任务_0910/张三_简历.docx");
  ok("PROGRESS.md 也能点（它也是这趟写出来的）", lns[2].dataset.name === "任务_0910/PROGRESS.md");
  ok("中文紧挨着照样认（「生成了简历.html供你查看」）", lns[3].dataset.name === "张三_简历.html");
  ok("代码块里的路径不动（那是代码不是链接）", host.querySelector("pre code").querySelector(".file-ln") === null && host.querySelector("pre code").textContent === "cp 张三_简历.html /tmp/");
  const para2 = host.querySelectorAll("p")[1].textContent; // 中间那段（<pre> 不算 <p>）
  ok("没产出过的名字不链（猜出来的链接点开是 404）", para2.includes("别的.html") && !([...host.querySelectorAll(".file-ln")].some((a) => a.textContent === "别的.html")));
  ok("不是子串就不算命中（data.md 里没有 a.md 这回事）", ![...host.querySelectorAll(".file-ln")].some((a) => a.textContent === "data.md"));
  CALLS.pv.length = 0;
  lns[0].click();
  ok("点一下就在右边打开这个文件", CALLS.pv.length === 1 && CALLS.pv[0] === "张三_简历.html");
  ok("再跑一遍不会套娃（链接里的字不再二次链接）", linkifyOutputs(host, targets) === 0 && host.querySelectorAll(".file-ln").length === 4);
  ok("这趟没产出过任何文件时什么都不做", linkifyOutputs(host, fileLinkTargets([])) === 0);
  host.remove();

  // 收尾清单里的文件名十有八九被模型套了反引号，全路径和 file:// 也是常客。
  // 这三种写法以前一条链接都没有，用户看到的是一份「不能点的清单」——
  const host2 = document.createElement("div");
  host2.className = "a-text";
  host2.innerHTML = "<p>交付清单：<code>任务_0910/张三_简历.docx</code></p>"
    + "<p>网页版是 <code>张三_简历.html</code></p>"
    + "<p>完整路径 /Users/somebody/ws/任务_0910/张三_简历.docx 也该能点</p>"
    + "<p>浏览器地址 file:///Users/somebody/ws/张三_简历.html 同理</p>"
    + "<pre><code>open 任务_0910/张三_简历.docx</code></pre>";
  document.body.appendChild(host2);
  const hits2 = linkifyOutputs(host2, targets);
  const lns2 = [...host2.querySelectorAll(".file-ln")];
  ok("反引号/全路径/file:// 三种写法都给链接（" + hits2 + " 处）", hits2 === 4 && lns2.length === 4,
     lns2.map((a) => a.textContent).join(" | "));
  ok("行内反引号里的文件名认得出来（收尾清单十有八九长这样）",
     lns2[0].dataset.name === "任务_0910/张三_简历.docx" && lns2[1].dataset.name === "张三_简历.html",
     lns2[0].dataset.name + " | " + lns2[1].dataset.name);
  ok("裸的全路径整串都是链接，不是只挑尾巴那一截",
     lns2[2].textContent === "/Users/somebody/ws/任务_0910/张三_简历.docx" && lns2[2].dataset.name === "任务_0910/张三_简历.docx",
     lns2[2].textContent);
  ok("file:// 开头的也算一条（模型爱把本地地址写成这样）",
     lns2[3].textContent === "file:///Users/somebody/ws/张三_简历.html" && lns2[3].dataset.name === "张三_简历.html",
     lns2[3].textContent);
  ok("反向对照：代码块（<pre>）里那条还是一个字都不动",
     host2.querySelector("pre code").querySelector(".file-ln") === null &&
     host2.querySelector("pre code").textContent === "open 任务_0910/张三_简历.docx",
     host2.querySelector("pre code").innerHTML);
  host2.remove();

  // ---------- 跑完了要能看见成果 ----------
  // 中途不弹是另一码事，这里说的是收尾
  const fb = { turnOut: [F("任务_0910/PROGRESS.md"), F("任务_0910/简历.docx"), F("任务_0910/简历.html")], replaying: false, otherSession: false, userClosedPreview: false, pvOpen: false, pvCurrent: null, filesOpen: false, narrow: false };
  ok("跑完了开这一趟的成品：网页优先于 Word 稿", finishPreviewPlan(fb).preview === "任务_0910/简历.html");
  ok("同一件拷了两份：开路径最浅的那个", pickFinishDeliverable([F("任务_0910/简历.html"), F("简历.html")]) === "简历.html");
  ok("只有 Word 稿也照开（应用内拆得出内容看）", pickFinishDeliverable([F("方案.docx")]) === "方案.docx");
  ok("只有过程账本就不开（PROGRESS.md 不是交付物）", finishPreviewPlan({ ...fb, turnOut: [F("任务_0910/PROGRESS.md")] }).preview === null);
  ok("只有 .ppt 这类老格式不开（那会去拉起本机 Office，抢整个系统焦点）", finishPreviewPlan({ ...fb, turnOut: [F("旧方案.ppt")] }).preview === null);
  ok("这趟压根没产出：不开", finishPreviewPlan({ ...fb, turnOut: [] }).preview === null);
  // 五种「开了反而添乱」的情形
  ok("回放历史不开", finishPreviewPlan({ ...fb, replaying: true }).preview === null);
  ok("用户已经切到别的会话不开", finishPreviewPlan({ ...fb, otherSession: true }).preview === null);
  ok("这趟里用户自己关过预览：不许弹回来", finishPreviewPlan({ ...fb, userClosedPreview: true }).preview === null);
  ok("成果文件面板开着不开（别把他正翻的列表抢走）", finishPreviewPlan({ ...fb, filesOpen: true }).preview === null);
  ok("窄窗不开（预览是盖在聊天上的浮层，一开就挡住结论）", finishPreviewPlan({ ...fb, narrow: true }).preview === null);
  ok("预览已经开着且看的就是它：不重复开", finishPreviewPlan({ ...fb, pvOpen: true, pvCurrent: "任务_0910/简历.html" }).preview === null);
  ok("预览开着但看的是别的：换成这趟的成品（面板本来就在，布局不动）", finishPreviewPlan({ ...fb, pvOpen: true, pvCurrent: "别的.html" }).preview === "任务_0910/简历.html");

  // ---------- 题面在文件里的那种提问 ----------
  const askEv = { question: "封面推了三版（文字都验过没写错，三版对比在《封面三选一.html》），你要哪版？",
                  options: [{ label: "A 极简", detail: "留白多" }, { label: "B 浓墨", detail: "压得住小图" }] };
  ok("题面里的《文件名》要认出来", JSON.stringify(filesInAsk(askEv)) === JSON.stringify(["封面三选一.html"]), JSON.stringify(filesInAsk(askEv)));
  ok("选项的说明里提到的文件也算", filesInAsk({ question: "选哪个？", options: [{ label: "C", detail: "见 对比/封面生图版对比.html" }] })[0] === "对比/封面生图版对比.html");
  ok("不带后缀的不认（「升到 v1.2」「第 3.2 节」这类会被误当成文件）", filesInAsk({ question: "升到 v1.2 还是留在 v1.1？", options: [] }).length === 0);
  const ab = { names: ["封面三选一.html"], outFiles: [F("任务_0918/封面三选一.html"), F("任务_0918/PROGRESS.md")], replaying: false, otherSession: false, pvOpen: false, pvCurrent: null, narrow: false };
  ok("提问时就把那份文件摊到右边（别等跑完）", askPreviewPlan(ab).preview === "任务_0918/封面三选一.html");
  ok("只写了文件名、真文件在任务子目录里：照样对得上", askPreviewPlan(ab).chips[0] === "任务_0918/封面三选一.html");
  ok("这一趟没落过这个文件：不开，也不挂 chip（开了只会弹一句「文件不存在」）",
     askPreviewPlan({ ...ab, outFiles: [F("任务_0918/PROGRESS.md")] }).preview === null &&
     askPreviewPlan({ ...ab, outFiles: [F("任务_0918/PROGRESS.md")] }).chips.length === 0);
  ok("题面里没提文件：什么都不做", askPreviewPlan({ ...ab, names: [] }).preview === null);
  ok("回放历史不开，但文件 chip 还留着（回头还想看看当时在挑什么）",
     askPreviewPlan({ ...ab, replaying: true }).preview === null && askPreviewPlan({ ...ab, replaying: true }).chips.length === 1);
  ok("窄窗不开（右边那条会把题目整个盖掉）", askPreviewPlan({ ...ab, narrow: true }).preview === null);
  ok("正看着的就是它：不重复开", askPreviewPlan({ ...ab, pvOpen: true, pvCurrent: "任务_0918/封面三选一.html" }).preview === null);
  return names;
})()
`;

const MASK_HTML = "<!doctype html><meta charset='utf-8'><body>"
  + "<div id='t1'>正在处理 /tmp/owb-demo-1/workspace/销售明细.csv</div>"
  + "<input id='i1' value='/tmp/owb-demo-1/out.xlsx'><button id='b1' title='cli_a1b2c3d4e5 绑定'>x</button>"
  + "<div id='host'></div></body>";
const MASK_CHECKS = (script) => `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const n = (${script});
  ok("遮罩脚本装上并报出清单条数", n >= 2 && window.__demoMask && window.__demoMask.pairs === n);
  ok("静态文本里的临时目录换成 ~/OpenWorkBuddy-demo", document.getElementById("t1").textContent === "正在处理 ~/OpenWorkBuddy-demo/workspace/销售明细.csv");
  ok("输入框的 value 也遮", document.getElementById("i1").value === "~/OpenWorkBuddy-demo/out.xlsx");
  ok("title 里的 bot id 换成圆点", document.getElementById("b1").title === "●●●●●● 绑定");
  const host = document.getElementById("host");
  host.innerHTML = "<p id='p2'>后插入 /tmp/owb-demo-1/a/b</p>";
  await wait(40);
  ok("后插入的节点被观察者接手遮掉", document.getElementById("p2").textContent === "后插入 ~/OpenWorkBuddy-demo/a/b");
  document.getElementById("t1").firstChild.data = "改成 /tmp/owb-demo-1/c";
  await wait(40);
  ok("原地改文字（流式那种）也遮", document.getElementById("t1").textContent === "改成 ~/OpenWorkBuddy-demo/c");
  const b = document.createElement("b"); b.textContent = "cli_a1b2c3d4e5"; host.appendChild(b);
  await wait(40);
  ok("后插入的 bot id 遮成圆点", b.textContent === "●●●●●●");
  ok("没被遮的正常文字不动", document.getElementById("t1").textContent.startsWith("改成 "));
  return names;
})()
`;
// ================= 技能卡「立即使用」：先摆几件具体能干的事 =================
// 以前点完只往输入框丢半句话，等于把一张空白页原样还给用户。现在从 SKILL.md 的「适用场景」里挖具体例子。
// 这函数是纯的，但仍然放进真 Chromium 跑：正则里有中文引号和 一-龥，
// Node 和浏览器的 Unicode 行为要是差一点点，只在浏览器里测才发现得了。
// 真源码切 app-04.js，不抄；连喂进去的说明书也用仓库里真发出去的那几份。
const APP04 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-04.js"), "utf8");
const SKEG_SRC = (() => {
  const a = APP04.indexOf("function skillExamples(md) {");
  const b = APP04.indexOf("\n// ---- Tab 2：技能", a);
  if (a < 0 || b <= a) throw new Error("app-04.js 里找不到 skillExamples（被改名/挪走？），前端测试没法定位真源码");
  return APP04.slice(a, b);
})();
// 仓库里随包发出去的技能说明书。用户点的就是这几张卡，拿真文件当输入，
// 免得测试里编一份格式最规整的 md 自欺欺人。
// 只许挑 git 跟踪的技能：这份名单原先有 brand-guidelines，它在 .gitignore 里（第三方技能
// 不随仓库分发），于是本机常绿、别人一 clone 就炸——2026-09-13 的 CI 就是这么挂死的。
// test/repo-hygiene.js 现在会盯着这一行，写进没随包发的技能就当场红。
const SKEG_DOCS = (() => {
  const dir = path.join(__dirname, "..", "skills");
  const out = {};
  for (const name of ["xiaohongshu-topic", "wechat-article", "deep-research", "data-viz", "ppt-design", "feishu-doc"]) {
    for (const f of ["skill.md", "SKILL.md"]) {
      const p2 = path.join(dir, name, f);
      if (fs.existsSync(p2)) { out[name] = fs.readFileSync(p2, "utf8"); break; }
    }
    if (!(name in out)) throw new Error("skills/" + name + " 的说明书不见了，技能例子测试没法用真输入");
  }
  return out;
})();
const SKEG_HTML = "<!doctype html><meta charset='utf-8'><body></body>";
const SKEG_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const DOCS = ${JSON.stringify(SKEG_DOCS)};

  // ---- 用户点名的那张卡 ----
  const xhs = skillExamples(DOCS["xiaohongshu-topic"]);
  ok("用户点名的 xiaohongshu-topic 不再是一句空话，挖出了具体例子", xhs.length >= 3, JSON.stringify(xhs));
  ok("挖的是「适用场景」那一节里的事", /选题/.test(xhs.join("｜")), JSON.stringify(xhs));
  // 负向控制（这条是回归）：那个正则以前带 m 标志，$ 就成了「行尾」，配上懒惰量词
  // 整节只截到第一行，三条只剩一条。删掉 m 之前这条必挂。
  ok("整节都读到了，不是只截了第一行", xhs.length === 3, "只挖到 " + xhs.length + " 条：" + JSON.stringify(xhs));
  // 「已经知道账号定位（卖出什么、给谁看），需要把定位拆成…」——括号里的补充说明要拿掉，
  // 但不能拿括号当刀把整句砍了（砍完剩「已经知道账号定位」，前后不搭）
  const withParen = xhs.find((t) => /账号定位/.test(t));
  ok("括号里的补充说明拿掉，句子还是整的", !!withParen && !/[（(]/.test(withParen) && /拆成/.test(withParen), String(withParen));

  // ---- 适用场景写成一句话、用顿号串起来的（wechat-article 就是这样）----
  const wx = skillExamples(DOCS["wechat-article"]);
  ok("适用场景写成一句话用顿号串的，也能拆成几件事", wx.length >= 2, JSON.stringify(wx));

  // ---- 负向控制：没写「适用场景」的说明书宁可一条不给 ----
  // 早先的版本挖不到就退回全文前 1200 字，结果卡上摆的是 #5b5ff7、pptxgenjs、app_id
  // 这类配置和字段名——比空着更糟。这三份说明书都没写「适用场景」，而且正文里
  // 恰好有一堆「像人话但不是任务」的句子（色码与 mermaid 语法、排版规范、接口注意事项），
  // 光靠「看着像代码就不要」那道筛子拦不住它们，只有把挖掘范围锁死在「适用场景」才干净。
  // ppt-design 是里面最刁的一份：它整篇都是「一页一论点」「每页正文 ≤6 条」这种
  // 标准中文祈使句，长得和任务例子一模一样，只差没写在「适用场景」底下。
  const noScene = ["data-viz", "ppt-design", "feishu-doc"];
  ok("没写「适用场景」的说明书一条都不挖（不退回全文）",
    noScene.every((n) => skillExamples(DOCS[n]).length === 0),
    JSON.stringify(noScene.map((n) => [n, skillExamples(DOCS[n])])));

  // ---- 挑出来的东西不能是代码/配置/链接 ----
  const junk = skillExamples([
    "## 适用场景",
    "- 主色 Mid Gray: #b0aea5 - Secondary elements",
    "- \`pptxgenjs\`",
    "- PLATFORM=openclaw",
    "- 打开 https://example.com 看文档",
    "- 把一堆散乱的会议记录整理成周报",
    "",
    "## 别的",
  ].join("\\n"));
  ok("颜色码/包名/环境变量/链接一律不当例子", junk.length === 1 && junk[0] === "把一堆散乱的会议记录整理成周报", JSON.stringify(junk));

  // ---- 前言里的 description 是写给模型看的，不当例子 ----
  const fm = skillExamples("---\\nname: x\\ndescription: 用来做一份很像样的年终总结报告\\n---\\n\\n## 说明\\n随便写点什么\\n");
  ok("前言里的 description 不当例子", fm.length === 0, JSON.stringify(fm));

  // ---- 引号短句优先，且最多摆 4 个（摆一屏按钮等于没帮人挑）----
  const many = skillExamples([
    "## 适用场景",
    "- 「帮我写一份季度复盘」",
    "- 「把这份纪要整理成周报」",
    "- 「给这个活动想十个标题」",
    "- 「把长文档压成一页摘要」",
    "- 「再来一条凑数的任务描述」",
    "- 「又一条凑数的任务描述在此」",
  ].join("\\n"));
  ok("引号里的短句直接当例子", many[0] === "帮我写一份季度复盘", JSON.stringify(many));
  ok("最多摆 4 个，不糊用户一脸", many.length === 4, JSON.stringify(many));

  // ---- 边界：太短的、重复的、光一个英文单词的都不要 ----
  const edge = skillExamples([
    "## 适用场景",
    "- 排版",
    "- docx",
    "- 把已有 Markdown 排版成公众号推文",
    "- 把已有 Markdown 排版成公众号推文",
  ].join("\\n"));
  ok("太短的、光一个英文单词的、重复的都筛掉", edge.length === 1 && edge[0] === "把已有 Markdown 排版成公众号推文", JSON.stringify(edge));

  ok("说明书是空的也不炸", skillExamples("").length === 0 && skillExamples(null).length === 0 && skillExamples(undefined).length === 0);
  return names;
})()
`;

// ================= 侧栏两条工作线：办公 / 工程 =================
// 两条线分的是**干哪种活儿**：办公（做表写稿出图，鼠标流）和工程（写代码跑脚本，键盘流，
// 连着本机那个 openworkbuddy 命令行）。这一段守六件事：
//   1. 两条线各自记各自的会话——切标签不会把另一条线的历史混进来，也不会让老会话「消失」；
//   2. **标签碰不到引擎**。早先版本让「切到工程线」顺手把引擎也换掉，服务器上两个人共用一份
//      配置时，那是实打实的越权。这里留一条反向看门狗：服务端就算把引擎字段塞回来，标签上也不许长出来；
//   3. 工程线**不按项目过滤**——终端里 openworkbuddy 起的任务没有「项目」这个概念，一过滤整条线空着，
//      看起来像功能坏了；
//   4. 终端里此刻在跑几趟，标签上那个数字不许是假的，人站在办公线上也看得见；
//   5. 空态要说清楚「怎么让它出现」，而不是干巴巴一句「没有任务」；
//   6. 手机上侧栏只有 180px，两个标签得一行放得下——这是「手机远程操作」那条主线的前提。
// 状态声明在 app-01.js、渲染和切换在 app-02.js，两处都切真源码。
const LANE_STATE_SRC = (() => {
  const a = APP02X.indexOf('let activeLane = "office";');
  const b = APP02X.indexOf("let currentUser = null;", a);
  if (a < 0 || b <= a) throw new Error("app-01.js 里的工作线状态段找不到了，前端测试没法定位真源码");
  return APP02X.slice(a, b);
})();
const LANE_SRC = (() => {
  const a = APP02.indexOf("// ================= 两条工作线：办公 / 工程");
  const b = APP02.indexOf("// ================= 会话历史", a);
  if (a < 0 || b <= a) throw new Error("app-02.js 里的两条工作线段找不到了，前端测试没法定位真源码");
  return APP02.slice(a, b);
})();
// 侧栏那两个函数（按项目 + 按线过滤、画列表）也切真源码：分栏这件事的正主就在 projectSessions 里
const HIST_MIN_SRC = (() => {
  const a = APP02.indexOf("/** 当前项目下的任务。");
  const b = APP02.indexOf('document.getElementById("history").addEventListener', a);
  if (a < 0 || b <= a) throw new Error("app-02.js 里的会话历史过滤段找不到了，前端测试没法定位真源码");
  return APP02.slice(a, b);
})();
// 真样式要注进来：高亮态、那个数字徽标都只写在 CSS 里，只看 class 名的话改坏了照样全绿。
// 侧栏宽度也按真值给（默认 250px，拖到底是 180px），不然「一行放得下」这条等于没验
const laneHtml = (sideW) => "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style>"
  + "<body style='margin:0'><aside style='width:" + sideW + "px'>"
  + "<div class='lane-tabs' id='lane-tabs' role='tablist' aria-label='工作线'></div>"
  // 标题行那个计数徽章也摆上：它现在有「平时不显示、过滤时才写」这条规矩，没有这个元素就验不了
  + "<div class='side-label'><span class='sl-t'>任务历史</span><span class='sl-n' id='hist-count'></span></div>"
  + "<div id='history'></div></aside><button id='new-task'>新任务</button></body>";

// ================= 侧栏：主次分明 + 任务历史可拖 =================
// 这一屏是两次事故 + 一次返工的留证：
//   1. 事故：`#history { flex: 1 1 auto }` 让历史的「基准高度」等于它内容的高度，
//      任务攒到几十条就有上千像素，整列进入收缩状态，而历史自己有 min-height 兜底，
//      收缩全落到导航头上（当时导航 min-height: 0）——
//      所以第一条守的是：**历史再长，导航一行都不许少**。
//   2. 返工：导航和历史主次不分。光调高度不够，字号/颜色也得分开。第二组守的是这个。
//   3. 新要求：任务历史那一栏要能拉伸、拖拽自适应。第三组守拖拽。
// 样式和 <aside> 都切真源码：只验 JS 的话，把那两条 flex 规则删掉测试照样全绿，
// 而用户看到的就是整段导航消失。
const ASIDE_SRC = (() => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const a = html.indexOf("<aside>");
  const b = html.indexOf("</aside>", a);
  if (a < 0 || b <= a) throw new Error("index.html 里的 <aside> 段找不到了，前端测试没法定位真源码");
  return html.slice(a, b + "</aside>".length);
})();
const HIST_RSZ_SRC = (() => {
  const a = UI00_SRC.indexOf("/* ---------- 侧栏里那条横的");
  const b = UI00_SRC.indexOf('if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initHistResizer);', a);
  if (a < 0 || b <= a) throw new Error("app-00-ui.js 里的历史高度拖拽段找不到了，前端测试没法定位真源码");
  return UI00_SRC.slice(a, b);
})();
// 窗口得宽过 900px：窄于这个数侧栏整个变成浮层（@media 里 aside { display: none }），量出来全是 0。
// 高度给 640——这是最容易复现「导航被挤没」的那档（笔记本半屏 / 外接竖屏下半截）
const SIDEBAR_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS
  + "\nhtml,body{height:100%}body{margin:0;display:flex}</style><body>" + ASIDE_SRC + "</body>";
const SIDEBAR_CHECKS = `
  const names = [];
  const $ = (q) => document.querySelector(q);
  const px = (q, prop) => parseFloat(getComputedStyle($(q))[prop || "fontSize"]);
  const fails = [];
  const ok = (name, cond, extra) => {
    if (cond) { names.push(name); return; }
    fails.push("✗ " + name + (extra ? " ｜ " + extra : ""));
  };
  var toast = () => {};
  // 攒 200 条历史。数量不是随手写的：出事那套 CSS 下，导航被挤掉多少 = 历史内容高度占两段总高的比例，
  // 60 条时导航还剩 122px（看着只是「有点挤」），200 条才塌到 44px——也就是用户看到的「都没了」。
  // 拿 60 条当夹具的话，下面那条反向对照会「过不了」，等于把事故写成了没发生。
  const hist = document.getElementById("history");
  // 这一组一旦在别的机器上挂了，光看「96 → 96」根本不知道是哪一环断的：
  // 是 CSS 规则没匹配上、还是 setHistH 把值夹没了、还是布局压根没重算。
  // 所以每条断言都带一份现场：两段的实测高度、--owb-hist-h、histMax() 的上限、
  // 以及 #history 真正生效的 flex-basis / min-height。
  const G = () => {
    const n = document.querySelector(".side-nav.top"), h2 = document.getElementById("history");
    const cs = getComputedStyle(h2), cn = getComputedStyle(n);
    return "nav=" + Math.round(n.getBoundingClientRect().height)
      + " hist=" + Math.round(h2.getBoundingClientRect().height)
      + " aside=" + document.querySelector("aside").clientHeight
      + " var=" + (getComputedStyle(document.documentElement).getPropertyValue("--owb-hist-h").trim() || "空")
      + " 上限=" + (typeof histMax === "function" ? histMax() : "无")
      + " hist{basis:" + cs.flexBasis + ",min:" + cs.minHeight + ",grow:" + cs.flexGrow + ",shrink:" + cs.flexShrink + "}"
      + " nav{min:" + cn.minHeight + ",max:" + cn.maxHeight + ",basis:" + cn.flexBasis + "}"
      + " html类=" + (document.documentElement.className || "无");
  };
  hist.innerHTML = Array.from({ length: 200 }, (_, i) =>
    '<div class="hist-item"><span class="ht">第 ' + i + ' 趟活儿，标题还挺长的免得被省略号吃掉</span></div>').join("");
  // 项目也塞几个：真实场景里导航自己也不短
  document.getElementById("proj-list").innerHTML = Array.from({ length: 5 }, (_, i) =>
    '<div class="proj-item"><span class="pn">项目 ' + i + '</span></div>').join("");
  document.getElementById("more-box").classList.add("open");   // 「更多」展开，导航最高的那档

  // ⓪ 先钉住一件比什么都底层的事：改完样式紧接着读，读到的必须是新值。
  // 出过事——全局那条「减弱动态效果」写的是 transition-duration: .01ms !important，
  // 而 transition-property 的初始值是 all，于是每个属性的每次变化都真造出一个过渡；
  // 过渡在 t=0 那一刻的值是**变化前**的旧值，改完立刻读就成了上一帧的数。
  // 侧栏这条拖拽线的夹取上限 histMax() 正是靠 nav.offsetHeight / hist.offsetHeight 现算的，
  // 一旦读到旧值就夹错——本机默认没开这个开关，所以只有 CI 的 macOS runner 上挂。
  const reduceOn = matchMedia("(prefers-reduced-motion: reduce)").matches;
  hist.style.minHeight = "123px";
  ok("改完样式紧接着读就是新值，没凭空生出过渡" + (reduceOn ? "（减弱动效档）" : "（常规档）"),
     getComputedStyle(hist).minHeight === "123px" && hist.getAnimations().length === 0,
     "读到 " + getComputedStyle(hist).minHeight + "，hist 上挂了 " + hist.getAnimations().length + " 个动画"
     + "，过渡时长=" + getComputedStyle(hist).transitionDuration + "，减动效=" + reduceOn);
  hist.style.minHeight = "";

  // ① 事故留证：历史再长，导航一行都不许少
  const aside = document.querySelector("aside");
  const nav = document.querySelector(".side-nav.top");
  const navItems = Array.from(nav.querySelectorAll(".item"));
  ok("导航区没被历史挤没（height > 0）", nav.getBoundingClientRect().height > 0,
     "nav=" + nav.getBoundingClientRect().height + " aside=" + aside.getBoundingClientRect().height);
  ok("导航区至少还有 120px 的兜底（min-height 那条没被删）", nav.getBoundingClientRect().height >= 120,
     "nav=" + nav.getBoundingClientRect().height);
  ok("九个导航入口一个都没塌（助理/项目/画布/专家/自动化/更多/模板/资料库/评测/追踪）",
     navItems.length >= 10 && navItems.every((el) => el.getBoundingClientRect().height > 0),
     "共 " + navItems.length + " 项，塌了 " + navItems.filter((el) => !el.getBoundingClientRect().height).length + " 项");
  ok("导航长过一屏时是它自己内部滚，不是把自己缩没", nav.scrollHeight > nav.clientHeight,
     "scrollH=" + nav.scrollHeight + " clientH=" + nav.clientHeight);
  ok("历史也还在，没被导航反过来吃掉", hist.getBoundingClientRect().height >= 56,
     "hist=" + hist.getBoundingClientRect().height);
  // 反向对照：把那两条 flex 规则改回出事前的写法，导航当场塌回去
  const undo = document.createElement("style");
  undo.textContent = ".side-nav.top{flex:0 1 auto;min-height:0;max-height:none}#history{flex:1 1 auto;min-height:min(200px,34vh)}";
  document.head.appendChild(undo);
  ok("反向对照：改回 flex:1 1 auto / min-height:0 的老写法，导航当场被挤没（塌到 60px 以下）",
     nav.getBoundingClientRect().height < 60, G() + " 补丁表=" + (undo.sheet ? undo.sheet.cssRules.length + "条" : "没挂上"));
  undo.remove();
  ok("反向对照撤掉之后导航自己回来了", nav.getBoundingClientRect().height >= 120);

  // ② 主次：导航是主，历史是次——字号、颜色、有没有图标，三样都得分开
  const navFs = px(".side-nav .item"), hiFs = px(".hist-item");
  ok("历史行比导航项小一号（" + hiFs + " < " + navFs + "）", hiFs < navFs);
  const navColor = getComputedStyle($(".side-nav .item")).color;
  const hiColor = getComputedStyle($(".hist-item")).color;
  ok("历史行的字色比导航项淡（不是同一个色值）", navColor !== hiColor, navColor + " vs " + hiColor);
  ok("导航项有图标，历史行没有（图标本身就是一层主次）",
     !!$(".side-nav .item .ic") && !$(".hist-item .ic"));
  ok("「任务历史」这个小标题比历史行本身还小（它只是个分隔标签）", px(".side-label") < hiFs,
     px(".side-label") + " vs " + hiFs);
  ok("历史行的行距比导航项紧", px(".hist-item", "paddingTop") < px(".side-nav .item", "paddingTop"),
     px(".hist-item", "paddingTop") + " vs " + px(".side-nav .item", "paddingTop"));

  // ③ 拖拽：往上拖历史变高、往下拖导航变高，双击回自适应
  const h = document.querySelector('.rsz-v[data-rszv="hist"]');
  ok("导航和历史之间有那条拖拽线", !!h && h.getAttribute("role") === "separator"
     && h.getAttribute("aria-orientation") === "horizontal");
  initHistResizer();
  const drag = (dy) => {
    const y0 = h.getBoundingClientRect().top;
    h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientY: y0, pointerId: 1 }));
    h.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: y0 + dy, pointerId: 1 }));
    h.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: y0 + dy, pointerId: 1 }));
  };
  const h0 = hist.getBoundingClientRect().height, n0 = nav.getBoundingClientRect().height;
  drag(-120);   // 握把在历史上边，往上拖 = 历史变高
  ok("往上拖：历史变高了", hist.getBoundingClientRect().height > h0 + 40,
     h0 + " → " + hist.getBoundingClientRect().height + " ｜ " + G());
  ok("往上拖：腾出来的地方是从导航身上出的，导航跟着变矮", nav.getBoundingClientRect().height < n0,
     n0 + " → " + nav.getBoundingClientRect().height + " ｜ " + G());
  ok("拖过之后 <html> 上挂了 hist-h，高度写进 --owb-hist-h",
     document.documentElement.classList.contains("hist-h")
     && getComputedStyle(document.documentElement).getPropertyValue("--owb-hist-h").trim().endsWith("px"),
     getComputedStyle(document.documentElement).getPropertyValue("--owb-hist-h"));
  const h1 = hist.getBoundingClientRect().height;
  drag(120);    // 往下拖 = 历史变矮
  ok("往下拖：历史又变矮了", hist.getBoundingClientRect().height < h1,
     h1 + " → " + hist.getBoundingClientRect().height + " ｜ " + G());
  drag(9999);   // 使劲往下拖：历史不许缩到零
  ok("使劲往下拖也留得住历史（下限 56px，不许缩成一条缝）",
     hist.getBoundingClientRect().height >= 56, String(hist.getBoundingClientRect().height));
  drag(-9999);  // 使劲往上拖：导航不许被吃没——这是 ① 那个事故的另一条路径
  ok("使劲往上拖也留得住导航（这条要是没夹住，拖拽就成了复现事故的新入口）",
     nav.getBoundingClientRect().height >= 56, String(nav.getBoundingClientRect().height));
  h.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  ok("双击那条线：回到自适应（hist-h 摘掉、--owb-hist-h 也摘掉）",
     !document.documentElement.classList.contains("hist-h")
     && !getComputedStyle(document.documentElement).getPropertyValue("--owb-hist-h").trim());
  ok("回自适应之后导航又拿回了内容高度", nav.getBoundingClientRect().height >= 120,
     String(nav.getBoundingClientRect().height));
  // 键盘也得能推：这条线是 role=separator + tabindex=0，只能鼠标拖的话键盘用户就没这功能
  const h2 = hist.getBoundingClientRect().height;
  h.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
  ok("按 ↑ 一次，历史高 16px", Math.abs(hist.getBoundingClientRect().height - (h2 + 16)) <= 1,
     h2 + " → " + hist.getBoundingClientRect().height + " ｜ " + G());
  h.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown", shiftKey: true }));
  ok("按 Shift+↓ 一次，历史矮 48px", Math.abs(hist.getBoundingClientRect().height - (h2 + 16 - 48)) <= 1,
     hist.getBoundingClientRect().height + " ｜ " + G());
  h.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  ok("按 Esc 也回自适应", !document.documentElement.classList.contains("hist-h"));

  if (fails.length) {
    // 挂了就把「到底哪几条 CSS 规则匹配上了这两个元素」整个抖出来：
    // 同样的文件、同样的 Chromium，在别的机器上却是另一套结果——只有把命中的规则和
    // 它们的媒体条件摆在一起，才看得出是哪一条没进来。
    const dump = [];
    // 注意别拿 r.cssRules 当「这是不是分组规则」的判据：新版 Chromium 里普通样式规则
    // 也带一个（空的）cssRules（CSS 嵌套），照着分组处理会把每一条都当空组跳过，最后什么都抖不出来
    const walk = (rules, cond) => {
      for (const r of rules || []) {
        if (r.cssRules && r.cssRules.length) walk(r.cssRules, r.conditionText ? (cond ? cond + " " : "") + r.conditionText : cond);
        if (!r.selectorText || !r.style) continue;
        const has = r.style.minHeight || r.style.maxHeight || r.style.flex || r.style.flexBasis;
        if (!has) continue;
        let hit = false;
        try { hit = nav.matches(r.selectorText) || hist.matches(r.selectorText); } catch {}
        if (hit) dump.push((cond ? "【" + cond + "】" : "") + r.selectorText + " { " + r.style.cssText.slice(0, 150) + " }");
      }
    };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules, ""); } catch (e) { dump.push("(读不到某张表：" + e.message + ")"); } }
    const env = "窗口 " + innerWidth + "×" + innerHeight + " dpr=" + devicePixelRatio
      + " 动画数=" + document.getAnimations().length + "/" + hist.getAnimations().length
      + " 过渡=" + getComputedStyle(hist).transitionProperty + "/" + getComputedStyle(hist).transitionDuration
      + " 1100断点=" + matchMedia("(max-width: 1100px)").matches
      + " 900断点=" + matchMedia("(max-width: 900px)").matches
      + " 减动效=" + matchMedia("(prefers-reduced-motion: reduce)").matches;
    throw new Error("侧栏主次/拖拽：" + names.length + " 条过，挂了 " + fails.length + " 条：\\n" + fails.join("\\n")
      + "\\n—— 环境 ——\\n" + env + "\\n—— 命中这两个元素、且管高度的规则（按层叠顺序）——\\n" + dump.join("\\n"));
  }
  names;
`;

const LANE_HTML = laneHtml(250);
const LANE_NARROW_HTML = laneHtml(180);
const LANE_STUBS = [
  IC_STUB,
  "var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "var stripSceneTag = (s) => String(s || '');",
  "var sessionId = '';",
  "var runningSessions = new Set();",
  "var sessions = [];",
  "var activeProject = '默认项目';",
  "var projectsLocked = false;",
  "var __SAVED = 0;",
  "var saveSessions = () => { __SAVED++; };",
  "var __DONE_AWAY = [];",
  "var bumpDoneWhileAway = (n) => { __DONE_AWAY.push(n); };",
  "var updateSendUI = () => {};",
  "var __TOASTS = [];",
  "var toast = (m) => { __TOASTS.push(String(m)); };",
  // 按 URL 分流的 fetch 替身：/api/lanes 和 /api/cli/live 是两本账，混在一起就验不出轮询那节
  "var __REPLY = {};",
  "var __CALLS = [];",
  "var fetch = async (u) => { const k = String(u).split('?')[0]; __CALLS.push(k); return { ok: true, json: async () => (k in __REPLY ? __REPLY[k] : {}) }; };",
  // 轮询是无限自我排期的，接住定时器只记间隔不真跑——不然这个窗口永远关不掉
  "var __TIMERS = [];",
  "window.setTimeout = function (fn, ms) { __TIMERS.push(ms); return 0; };",
  // 偏好要真能读回来才算数：data: 页面的 localStorage 在 Chromium 里一读就抛，
  // 真源码全程 try 兜着（这本身也是被守的行为），这儿换一份能读写的，好验「点过之后记住了」
  "var __LANE_LS = {};",
  "try { Object.defineProperty(window, 'localStorage', { configurable: true, value: {"
  + " getItem: (k) => (k in __LANE_LS ? __LANE_LS[k] : null),"
  + " setItem: (k, v) => { __LANE_LS[k] = String(v); },"
  + " removeItem: (k) => { delete __LANE_LS[k]; } } }); } catch (e) { window.__LANE_LS_FAIL = String(e); }",
  "var __NEW_TASK = 0;",
  "document.getElementById('new-task').addEventListener('click', () => { __NEW_TASK++; });",
].join("\n");
// 服务端 /api/lanes 真回的那两行（server.js 里是从 lanes.LANES 直接映射出来的）
const LANE_REPLY_SRC = `
var __LANES_OK = { lanes: [
  { id: "office", name: "办公", short: "办公", hint: "做表、写稿、出图、发消息——鼠标流",
    detail: "本机的桌面办公 agent：专家团、技能库、记忆、生图生视频都在这条线上" },
  { id: "cli", name: "工程", short: "工程", hint: "写代码、跑脚本、查日志——键盘流",
    detail: "本机 OpenWorkBuddy 命令行（openworkbuddy）那条线：终端里起的任务都归这儿，手机上点开就能接管、插话" },
], current: "office", cliLive: [], cliRunning: 0 };
`;
const LANE_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  if (window.__LANE_LS_FAIL) throw new Error("测试自己的 localStorage 替身没装上：" + window.__LANE_LS_FAIL);
  const box = document.getElementById("lane-tabs");
  const hist = document.getElementById("history");
  const btns = () => [...box.querySelectorAll("button[data-lane]")];
  const byLane = (id) => box.querySelector('button[data-lane="' + id + '"]');
  const onId = () => (box.querySelector("button.on") || {}).dataset?.lane;
  const ids = () => [...hist.querySelectorAll(".hist-item")].map(e => e.dataset.id || ("live:" + e.dataset.cli)).join(",");

  // ---- ① 拉到服务端那两行之前，先用兜底把标签画出来（首屏不能是空侧栏）----
  renderLaneTabs();
  ok("没联网也先画出两个标签", btns().length === 2, box.innerHTML);
  ok("办公在前、工程在后", btns().map(b => b.dataset.lane).join(",") === "office,cli");
  ok("默认站在办公线上", activeLane === "office" && onId() === "office");
  ok("两个标签的图标不一样且认得出来",
    /#i-briefcase/.test(btns()[0].innerHTML) && /#i-terminal/.test(btns()[1].innerHTML), box.innerHTML);
  ok("标签上就两个字，不带「模式」二字",
    btns().every(b => b.querySelector(".lt-name").textContent.length === 2 && !/模式/.test(b.textContent)),
    box.textContent);
  ok("高亮不是只有个 class：真描上了底色", (() => {
    const bg = getComputedStyle(btns()[0]).backgroundColor;
    return bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
  })(), getComputedStyle(btns()[0]).backgroundColor);
  ok("aria-selected 跟高亮同步", btns()[0].getAttribute("aria-selected") === "true" && btns()[1].getAttribute("aria-selected") === "false");

  // ---- ② 服务端那份门面话术（命令行、IM 那边读的是同一份，别各写各的）----
  __REPLY["/api/lanes"] = JSON.parse(JSON.stringify(__LANES_OK));
  await refreshLanes();
  ok("名字用服务端报的那份", byLane("cli").querySelector(".lt-name").textContent === "工程", box.textContent);
  ok("鼠标停上去说得清这条线是干什么的",
    /键盘流/.test(byLane("cli").title) && /openworkbuddy/.test(byLane("cli").title), byLane("cli").title);

  // ---- ③ 看门狗：标签碰不到引擎 ----
  // 曾经这里按工作线换 agent.engine，切个标签能把别人配的模型换掉。现在就算服务端把这些字段
  // 塞回来，标签上也不许长出引擎名、警告点、装它那句命令——引擎是设置页里的事
  __REPLY["/api/lanes"] = { ...JSON.parse(JSON.stringify(__LANES_OK)) };
  __REPLY["/api/lanes"].lanes[1] = { ...__REPLY["/api/lanes"].lanes[1],
    engine: "claude-code", engineLabel: "Claude Code", ready: false, why: "本机没找到 claude-code", install: "npm i -g @anthropic-ai/claude-code" };
  __REPLY["/api/lanes"].cliEngine = "claude-code";
  await refreshLanes();
  ok("服务端塞回引擎字段，标签上也不长引擎名",
    !/Claude Code|claude-code|npm i -g/.test(byLane("cli").outerHTML), byLane("cli").outerHTML);
  ok("也不长「没装」那个警告点（装没装是设置页的事，不是标签的事）",
    byLane("cli").querySelector(".dot") === null, byLane("cli").innerHTML);
  __REPLY["/api/lanes"] = JSON.parse(JSON.stringify(__LANES_OK));

  // ---- ④ 终端里此刻在跑几趟：数字标在「工程」上，站在办公线也看得见 ----
  cliLiveRows = [
    { id: "t1", title: "把这个仓库的测试跑一遍", live: true, startedAt: 9, cwd: "/w/repo" },
    { id: "t2", title: "查一条构建报错", live: true, startedAt: 8, cwd: "/w/repo" },
    { id: "t3", title: "早上那趟", live: false, startedAt: 1, cwd: "/w/repo" },
  ];
  renderLaneTabs();
  ok("终端里两趟在跑，工程标签上就写 2（跑完那趟不算）",
    byLane("cli").querySelector(".lt-live")?.textContent === "2", byLane("cli").textContent);
  ok("站在办公线上也看得见那个数字（不用来回点）", activeLane === "office");
  ok("办公标签上没有这个数字", byLane("office").querySelector(".lt-live") === null);
  ok("徽标真描上了底色（CSS 在，不是只有个 class）", (() => {
    const bg = getComputedStyle(byLane("cli").querySelector(".lt-live")).backgroundColor;
    return bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
  })());
  cliLiveRows = cliLiveRows.map(r => ({ ...r, live: false }));
  renderLaneTabs();
  ok("全跑完了数字就摘掉", byLane("cli").querySelector(".lt-live") === null, byLane("cli").innerHTML);

  // ---- ⑤ 侧栏按线分栏 ----
  cliLiveRows = [];
  sessions = [
    { id: "o1", title: "整理季度数据", at: 5, lane: "office" },
    { id: "c1", title: "修一个构建报错", at: 4, lane: "cli" },
    { id: "old", title: "一条很早以前的任务", at: 3 },
  ];
  renderHistory();
  ok("办公线只看到办公的活儿（外加没记过线的老会话）", ids() === "o1,old", hist.textContent);
  byLane("cli").click();
  ok("点一下就换线了", activeLane === "cli" && onId() === "cli");
  ok("换过的线记在本地，下次打开还站在这儿", __LANE_LS["owb_lane"] === "cli");
  ok("工程线只看到工程的活儿", ids() === "c1", hist.textContent);
  ok("再点同一个标签不折腾（不重画不开新任务）",
    (() => { const n = __NEW_TASK; byLane("cli").click(); return __NEW_TASK === n && activeLane === "cli"; })());

  // ---- ⑥ 工程线不按项目过滤（终端里起的任务没有「项目」这回事）----
  sessions = [
    { id: "o2", title: "另一个项目的表", at: 5, lane: "office", project: "别的项目" },
    { id: "c2", title: "终端里跑的那趟", at: 4, lane: "cli", project: "别的项目" },
  ];
  renderHistory();
  ok("工程线不按项目过滤：终端起的任务照样列出来", ids() === "c2", hist.textContent);
  byLane("office").click();
  ok("反向对照：办公线换个项目就滤掉了（证明上面那条不是恒真）", ids() === "", hist.textContent);
  byLane("cli").click();

  // ---- ⑦ 终端起的那几条：并进同一张列表，来路缩成行内图标，点进去是跟直播不是回放 ----
  sessions = [{ id: "t3", title: "早上那趟（已经存成记录了）", at: 3, lane: "cli" }];
  cliLiveRows = [
    { id: "t1", title: "把这个仓库的测试跑一遍", live: true, startedAt: 9, cwd: "/w/repo" },
    { id: "t3", title: "早上那趟", live: false, startedAt: 1, cwd: "/w/repo" },
  ];
  renderHistory();
  ok("★不再为一种来路单开一节★ 以前是「任务历史 → 10 → 终端里（openworkbuddy 命令行） → 才轮到内容」，三行铺垫才见着第一条任务",
    hist.querySelector(".hist-group") === null, hist.innerHTML);
  ok("来路没丢，只是从一整行标题缩成了行首一个图标（鼠标停上去说得清）",
    hist.querySelector('[data-cli="t1"] .hsrc') !== null && /终端/.test(hist.querySelector('[data-cli="t1"]')?.getAttribute("title") || ""), hist.innerHTML);
  ok("正在跑的排在整张列表最前面——翻列表的人要找的就是它",
    hist.querySelector(".hist-item")?.getAttribute("data-cli") === "t1", hist.innerHTML);
  ok("正在跑的那行走 data-cli（点它是跟直播，不是回放存下来的记录）",
    hist.querySelector('[data-cli="t1"]') !== null && hist.querySelector('[data-cli="t1"] .hrun') !== null, hist.innerHTML);
  ok("已经存成历史的那趟不重复列", hist.querySelectorAll('[data-id="t3"]').length === 1 && hist.querySelector('[data-cli="t3"]') === null, hist.innerHTML);
  byLane("office").click();
  ok("办公线上不列终端起的任务（它是工程线的东西）", hist.querySelector("[data-cli]") === null, hist.innerHTML);
  byLane("cli").click();

  // ---- ⑦-2 标题行那个计数：平时不显示，过滤时才有用 ----
  const cnt = document.getElementById("hist-count");
  sessions = [{ id: "k1", title: "甲任务", at: 2, lane: "cli" }, { id: "k2", title: "乙任务", at: 1, lane: "cli" }];
  cliLiveRows = [];
  renderHistory();
  ok("★平时不挂计数徽章★「我有几条任务」不是打开侧栏要问的问题，而它占着标题行最显眼的位置",
    (cnt.textContent || "") === "", JSON.stringify(cnt.textContent));
  histQuery = "甲";
  renderHistory();
  ok("反向对照：一过滤就写「命中/总数」——这时候才真需要知道藏起来多少条", cnt.textContent === "1/2", cnt.textContent);
  histQuery = "";
  renderHistory();

  // ---- ⑦-3 服务端搜出来的那一层：带片段、带「为什么是它」、挂了要说挂了 ----
  // 只筛标题的话，用户记得的那两样
  // （自己打的那句话、最后拿到的文件名）一样都搜不着。
  sessions = [{ id: "k1", title: "表格清洗", at: 2, lane: "cli" }, { id: "k2", title: "竞品调研", at: 1, lane: "cli" }];
  cliLiveRows = [];
  histQuery = "重复的行";
  histHits = [{ id: "k1", title: "表格清洗", why: "对话里", score: 1.6,
    snippet: { text: "这个 csv 里有很多重复的行，帮我挑出来", at: 11, len: 4, head: false } }];
  histNote = "在 2 条任务里找，标题、对话正文、产出文件名都算";
  histErr = "";
  renderHistory();
  const found = hist.querySelector(".hist-item.found");
  ok("★标题里一个字都不沾的那条被搜出来了★ 这正是「只筛标题」那版找不着的那种", !!found && found.dataset.id === "k1", hist.innerHTML.slice(0, 200));
  ok("★每条都标着是靠什么找到的★ 不标的话，语义命中看起来就是凭空冒出来的不相干任务",
    !!hist.querySelector(".hwhy") && hist.querySelector(".hwhy").textContent === "对话里");
  ok("命中的那句话摘出来了，不用点进去才知道为什么是它", /重复的行/.test((hist.querySelector(".hsnip") || {}).textContent || ""));
  ok("★命中那几个字高亮，而且套在对的位置上★ 下标算错的话高亮会歪到旁边的字上",
    (hist.querySelector(".hsnip mark") || {}).textContent === "重复的行", (hist.querySelector(".hsnip mark") || {}).textContent);
  ok("搜完那句实话也画出来了（这次靠什么找的）", /标题、对话正文、产出文件名都算/.test(hist.textContent));
  ok("命中行不再是单行省略号那种：.found 换了行高，两行放得下标题和片段",
    getComputedStyle(found).whiteSpace === "normal", getComputedStyle(found).whiteSpace);

  // 片段是别人对话里的原话，可能长得像标签。转义漏一处就是一个存储型 XSS
  histHits = [{ id: "k1", title: "<img src=x onerror=alert(1)>", why: "对话里",
    snippet: { text: "前 <script>alert(1)</script> 后", at: 2, len: 8, head: false } }];
  renderHistory();
  ok("★标题和片段都当文字画，不当 HTML★ 对话里的原话混进一个标签就等于一个存储型 XSS",
    hist.querySelectorAll("img, script").length === 0 && /onerror/.test(hist.textContent), hist.innerHTML.slice(0, 200));

  // 搜挂了 ≠ 没搜到。混成一件事的话，用户会以为「这个搜索不准」，而其实是请求没发出去
  histHits = null;
  histErr = "只筛了标题——正文检索没连上（HTTP 500）";
  histQuery = "八竿子打不着";
  renderHistory();
  ok("★搜挂了照实说挂了★ 显示「没搜到」的话，两件事说成了一件，而该修的那件没人知道",
    /正文检索没连上/.test(hist.textContent), hist.textContent.slice(0, 120));
  histErr = "";
  renderHistory();
  ok("反向对照：没挂的时候说的是另一句（本地先筛着，正文还在找）",
    !/没连上/.test(hist.textContent) && /正文还在找/.test(hist.textContent), hist.textContent.slice(0, 120));

  histQuery = ""; histHits = null; histNote = ""; histErr = "";
  renderHistory();
  ok("清空搜索词就回到平常那张列表（两条都在，没有 .found）",
    hist.querySelectorAll(".hist-item").length === 2 && !hist.querySelector(".found"));

  byLane("cli").click();

  // ---- ⑧ 空态：告诉人「怎么让它出现」，不是干巴巴一句没有任务 ----
  sessions = []; cliLiveRows = [];
  renderHistory();
  ok("工程线空着时说的是怎么让它出现", /openworkbuddy/.test(hist.textContent) && /终端/.test(hist.textContent), hist.textContent);
  ok("那句命令真渲染成了代码块，不是把标签当文字显示出来",
    hist.querySelector(".hist-empty code") !== null && !/&lt;code/.test(hist.innerHTML), hist.innerHTML);
  byLane("office").click();
  ok("办公线空着说的是另一回事（不提终端）", !/终端/.test(hist.textContent) && /任务/.test(hist.textContent), hist.textContent);

  // ---- ⑨ 轮询：人在哪条线上就问得多勤 ----
  __REPLY["/api/cli/live"] = { rows: [{ id: "t9", title: "终端里那趟", live: true, startedAt: 7 }], allowed: true };
  __TIMERS.length = 0;
  await pollCliLive();
  ok("办公线上问得懒一点（别为了那个数字一直占着网络）", __TIMERS[0] === 20000, String(__TIMERS[0]));
  ok("问回来的数字立刻标上", byLane("cli").querySelector(".lt-live")?.textContent === "1", box.textContent);
  byLane("cli").click();
  __TIMERS.length = 0;
  await pollCliLive();
  ok("站在工程线上就问得勤", __TIMERS[0] === 3000, String(__TIMERS[0]));

  // ---- ⑩ 正在跟的那趟没了：把圈收掉，别让手机上一直转 ----
  var __FIN = 0;
  cliWatch = { id: "t9", es: null, live: true, ui: { handleEvent: () => {}, finish: () => { __FIN++; } } };
  __REPLY["/api/cli/live"] = { rows: [], allowed: true };
  __TIMERS.length = 0;
  await pollCliLive();
  ok("终端那趟断了，正在跟的那个圈会收摊（画面留着，但不再装作在直播）",
    __FIN === 1 && cliWatch !== null && cliWatch.live === false, String(__FIN) + "/" + JSON.stringify(cliWatch && cliWatch.live));
  const f0 = __FIN;
  await pollCliLive();
  ok("下一拍不会再收一次摊（收完就不该反复触发）", __FIN === f0, String(__FIN));
  ok("而且当成一条跑完的活儿记下来（人不在的时候也数得清）", __DONE_AWAY.length === 1, JSON.stringify(__DONE_AWAY));

  // ---- ⑪ 租户成员：服务端说了不给看，就别再问了 ----
  // 终端属于这台机器的主人，别人看见别人电脑里在跑什么是越权。一直问不但白费，还会一直报 403
  __REPLY["/api/cli/live"] = { rows: [], allowed: false };
  __TIMERS.length = 0;
  await pollCliLive();
  ok("服务端说不给看，这一拍就不再排下一次了", __TIMERS.length === 0, JSON.stringify(__TIMERS));
  const n0 = __CALLS.length;
  await pollCliLive();
  ok("之后也彻底不问了（不是下一拍又去撞一次）", __CALLS.length === n0, String(__CALLS.length - n0));

  // ---- ⑫ 老版本服务端：没有 /api/lanes，标签不许塌掉 ----
  // 光看「还有两个按钮」是抓不住的：清空 laneInfo 之后兜底那两行照样能凑出两个按钮，
  // 真丢的是服务端那份门面话术。所以盯着它一起验
  __REPLY["/api/lanes"] = {};
  await refreshLanes();
  ok("老服务端回了个空，两个标签一个没少", btns().length === 2, box.innerHTML);
  ok("回空也没把服务端报过的那份冲掉", /键盘流/.test(byLane("cli").title), byLane("cli").title);
  __REPLY["/api/lanes"] = { lanes: [] };
  await refreshLanes();
  ok("回了个空数组也一样不塌", btns().length === 2 && /键盘流/.test(byLane("cli").title), box.innerHTML);
  return names;
})()
`;
// 手机上侧栏是一层抽屉（窗口 ≤900px 时 aside 整个收起来，点汉堡才滑出来），拖到底只有 180px。
// 这条就按那个真场景验：430px 的窗口 + 抽屉打开 + 180px 宽的侧栏。只看 class 名的话，
// 把 min-width:0 或者 flex:1 1 0 那几行删掉照样全绿，而用户那头是标签被挤到换行、名字被顶没。
const LANE_NARROW_CHECKS = FLUSH_SRC + `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const box = document.getElementById("lane-tabs");
  const side = document.querySelector("aside");
  const fits = () => box.scrollWidth <= box.clientWidth;
  renderLaneTabs();
  ok("手机宽度下侧栏默认是收起来的（正文占满整屏）", getComputedStyle(side).display === "none", getComputedStyle(side).display);
  document.body.classList.add("side-open"); flush();
  ok("点开抽屉，两条工作线就在里面", getComputedStyle(side).display === "flex" && box.getBoundingClientRect().width > 0,
    getComputedStyle(side).display + "/" + box.getBoundingClientRect().width);
  const b = box.querySelector('button[data-lane="cli"]');
  ok("两个标签在 180px 的侧栏里一行放得下", fits(), "scrollWidth=" + box.scrollWidth + " clientWidth=" + box.clientWidth);
  ok("名字没被挤没", b.querySelector(".lt-name").getBoundingClientRect().width > 20,
    String(b.querySelector(".lt-name").getBoundingClientRect().width));
  ok("图标还在（一眼认出是哪条线）", /#i-terminal/.test(b.innerHTML) && b.querySelector(".i").getBoundingClientRect().width > 8);
  ok("两个标签一样宽（没有一个把另一个挤扁）", (() => {
    const w = [...box.querySelectorAll("button")].map(x => Math.round(x.getBoundingClientRect().width));
    return Math.abs(w[0] - w[1]) <= 1;
  })(), [...box.querySelectorAll("button")].map(x => x.getBoundingClientRect().width).join("/"));
  cliLiveRows = [{ id: "a", live: true }, { id: "b", live: true }];
  renderLaneTabs();
  ok("终端里有活儿在跑时，那个数字也塞得下（不把名字顶出去）",
    fits() && box.querySelector(".lt-live") !== null, "scrollWidth=" + box.scrollWidth);
  return names;
})()
`;

// ================= 侧栏：项目那一栏 + 任务历史该不该按项目过滤 =================
// 侧栏那个点不动的 tab、和「登录前的任务历史全不见了」，是同一个根因：
// 以前服务端给租户成员编了个叫「本组织工作目录」的假项目顶上，两头都出事：侧栏多一个点不动的 tab，
// 而且这名字跟老会话记的项目名对不上，renderHistory 按项目一过滤，整排任务历史全没了——
// 一条都没丢，只是全被滤掉了。现在服务端如实回 locked，前端见到 locked 就整块不画、也不过滤。
// 切 app-02.js 的真源码，连 fetch 那一步（refreshProjects）也一起跑，
// 不然「locked 有没有真被读出来」这段就没人管。
const PROJ_SRC = (() => {
  const a = APP02.indexOf("/** 当前项目下的任务。");
  const b = APP02.indexOf('document.getElementById("history").addEventListener', a);
  const c = APP02.indexOf("async function refreshProjects() {");
  const d = APP02.indexOf('document.getElementById("proj-add").onclick', c);
  if (a < 0 || b <= a) throw new Error("app-02.js 里的会话历史过滤段找不到了，前端测试没法定位真源码");
  if (c < 0 || d <= c) throw new Error("app-02.js 里的 refreshProjects/renderProjects 段找不到了，前端测试没法定位真源码");
  // 会话历史那段现在还会按工作线分栏（laneOfSession），真源码里它跟渲染标签在同一段，一起切进来
  return LANE_STATE_SRC + "\n" + LANE_SRC + "\n" + HIST_MIN_SRC + "\n" + APP02.slice(c, d);
})();
// 侧栏那一栏的真样式必须注进来：.side-nav .item 自带 display:flex，
// 谁要是把隐藏改回 head.hidden = true，[hidden] 压不住它，栏目照样显示。
// 只验 DOM 属性的话那种改法照样全绿，用户还是看见那个点不动的 tab。
const PROJ_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style>"
  + "<body style='margin:0;width:260px'><div class='side-nav'>"
  + "<div class='item nav-head' data-view='proj' title='项目管理'><span class='tx'>项目</span></div>"
  + "<div id='proj-list'></div></div><div id='history'></div>"
  + "<div class='lane-tabs' id='lane-tabs'></div><div id='new-task'></div></body>";
const PROJ_STUBS = [
  IC_STUB,
  "var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "var stripSceneTag = (s) => String(s || '');",
  "var sessionId = '';",
  "var runningSessions = new Set();",
  "var sessions = [];",
  "var activeProject = '默认项目';",
  "var projectsLocked = false;",
  "var projects = [];",
  "var refreshSettingsCache = () => {};",
  "var renderFiles = () => {};",
  "var __PROJ_REPLY = {};",
  "var fetch = async () => ({ json: async () => __PROJ_REPLY });",
].join("\n");
const PROJ_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const head = document.querySelector('.side-nav [data-view="proj"]');
  const box = document.getElementById("proj-list");
  const hist = document.getElementById("history");
  // 一个老用户的侧栏：早年的会话根本没记项目名，后来的记的是「默认项目」
  const SESS = [
    { id: "s1", title: "整理季度数据", at: 3 },
    { id: "s2", title: "写公众号推文", at: 2, project: "默认项目" },
    { id: "s3", title: "做一版落地页", at: 1, project: "客户 A" },
  ];

  // ---- 有全局工作目录的人（总部管理员）：项目那一栏照常 ----
  sessions = SESS.slice();
  __PROJ_REPLY = { projects: [{ name: "默认项目", dir: "/w" }, { name: "客户 A", dir: "/w/a" }], active: "默认项目", locked: false };
  await refreshProjects();
  ok("管理员看得见「项目」这一栏", getComputedStyle(head).display !== "none" && getComputedStyle(box).display !== "none");
  ok("项目列表照常画出来", box.querySelectorAll(".proj-item").length === 2);
  ok("当前项目高亮的是服务端说的那个", box.querySelector(".proj-item.active").dataset.name === "默认项目");
  ok("任务历史按项目过滤：没记项目的算「默认项目」", [...hist.querySelectorAll(".hist-item")].map(e => e.dataset.id).join(",") === "s1,s2", hist.textContent);
  ok("空的时候说清楚是「这个项目」没任务", (() => { sessions = []; renderHistory(); const t = hist.textContent; sessions = SESS.slice(); return /该项目在这条线上还没有任务/.test(t); })());

  // ---- 租户成员：服务端说「你这儿没有项目这回事」 ----
  __PROJ_REPLY = { projects: [], active: "", locked: true };
  await refreshProjects();
  ok("服务端 locked 被读进来了", projectsLocked === true && activeProject === "");
  ok("整栏「项目」不再出现（连那个点不动的 tab 也没了）", getComputedStyle(head).display === "none", "display=" + getComputedStyle(head).display);
  ok("项目列表也不占位置且清空", getComputedStyle(box).display === "none" && box.innerHTML === "");
  // 这条是用户那句「历史全没了」的正主：租户端一条都不许过滤
  ok("三条任务历史一条不少地回来了", [...hist.querySelectorAll(".hist-item")].map(e => e.dataset.id).join(",") === "s1,s2,s3", hist.textContent);
  ok("空的时候不提「项目」两个字", (() => { sessions = []; renderHistory(); const t = hist.textContent; sessions = SESS.slice(); return /还没有任务/.test(t) && !/该项目/.test(t); })());

  // ---- 负向控制：服务端要是再编一个假项目顶上，就又会把历史滤空 ----
  // 这条不是在测「假项目还在」，是把当年的事故钉在这儿：只要 locked 这条路被绕开、
  // 拿一个跟老会话对不上的名字当 active，用户就又看不到历史了。
  __PROJ_REPLY = { projects: [{ name: "本组织工作目录", dir: "/w" }], active: "本组织工作目录", locked: false };
  await refreshProjects();
  ok("当年的事故复现得出来：假项目一顶上，历史当场空", hist.querySelectorAll(".hist-item").length === 0 && projectsLocked === false);

  // ---- 回到 locked：状态能来回切，不是只在首次加载对 ----
  __PROJ_REPLY = { projects: [], active: "", locked: true };
  await refreshProjects();
  ok("切回租户端，栏目重新藏好、历史重新齐全", getComputedStyle(head).display === "none" && hist.querySelectorAll(".hist-item").length === 3);
  return names;
})()
`;

// ================= 登录后把服务端那份任务历史并回侧栏 =================
// 这是「历史全没了」的第二道防线：假项目那条修好了，可清缓存 / 换台机器 / 改用户名
// 照样会让 localStorage 里那份列表空掉，而对话本体一直在 data/sessions/ 躺着。
// 这段要守的三件事：只补不删（本地刚建还没落盘的新任务不能被抹）、
// 老版本服务端没这个接口时维持原样别清空、服务端润色过的标题盖过本地那截 24 字。
const APP03_MERGE = (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-03.js"), "utf8");
  const a = src.indexOf("async function mergeServerSessions() {");
  const b = src.indexOf("\ninitAuth();", a);
  if (a < 0 || b <= a) throw new Error("app-03.js 里找不到 mergeServerSessions（被改名/挪走？），前端测试没法定位真源码");
  return src.slice(a, b);
})();
const MERGE_HTML = "<!doctype html><meta charset='utf-8'><body><div id='history'></div></body>";
const MERGE_STUBS = [
  IC_STUB,
  "var sessions = [];",
  "var SAVED = 0; var saveSessions = () => SAVED++;",
  "var RENDERED = 0; var renderHistory = () => RENDERED++;",
  "var __REPLY = null; var __THROW = false;",
  "var fetch = async () => { if (__THROW) throw new Error('offline'); return { json: async () => __REPLY }; };",
].join("\n");
const MERGE_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };

  // ---- 清了缓存 / 换台机器：本地一条没有，服务端有 3 条 ----
  sessions = [];
  __REPLY = { sessions: [
    { id: "s1", title: "整理季度数据", at: 100 },
    { id: "s2", title: "写公众号推文", at: 300, project: "客户 A" },
    { id: "s3", title: "做一版落地页", at: 200 },
  ] };
  await mergeServerSessions();
  ok("本地空了也能从服务端把历史补回来", sessions.length === 3, JSON.stringify(sessions));
  ok("补回来按时间倒序，最近干的在最上面", sessions.map(s => s.id).join(",") === "s2,s3,s1", sessions.map(s => s.id).join(","));
  ok("项目名跟着回来（不然按项目一过滤又归错组）", sessions.find(s => s.id === "s2").project === "客户 A");
  ok("补完存下来并重画了侧栏", SAVED > 0 && RENDERED > 0);

  // ---- 只补不删：本地刚建、还没落盘的新任务必须原样留着 ----
  sessions = [{ id: "new1", title: "刚敲下的新任务", at: 999 }];
  __REPLY = { sessions: [{ id: "s1", title: "整理季度数据", at: 100 }] };
  await mergeServerSessions();
  ok("★本地刚建还没落盘的新任务没被服务端那份顶掉★", sessions.some(s => s.id === "new1"), JSON.stringify(sessions));
  ok("同时该补的也补上了", sessions.some(s => s.id === "s1"));

  // ---- 标题：服务端那份是模型润色过的，本地是发第一句时截的 24 字 ----
  sessions = [{ id: "s1", title: "帮我把这个季度的销售数据整理一", at: 0 }];
  __REPLY = { sessions: [{ id: "s1", title: "整理 Q3 销售数据并出图", at: 100, project: "客户 A" }] };
  await mergeServerSessions();
  ok("服务端润色过的标题盖过本地那截半句话", sessions[0].title === "整理 Q3 销售数据并出图", sessions[0].title);
  ok("本地缺的时间和项目名一并补上", sessions[0].at === 100 && sessions[0].project === "客户 A");
  ok("不重复塞一条（按 id 认人）", sessions.length === 1);

  // ---- 负向控制：服务端还没起名字的，别拿「未命名任务」把本地好标题冲掉 ----
  sessions = [{ id: "s1", title: "帮我把这个季度的销售数据整理一", at: 50 }];
  __REPLY = { sessions: [{ id: "s1", title: "未命名任务", at: 100 }] };
  await mergeServerSessions();
  ok("服务端那条还没起名字时不冲掉本地的标题", sessions[0].title === "帮我把这个季度的销售数据整理一", sessions[0].title);

  // ---- 老版本服务端没这个接口 / 断网：维持原样，一条都不许清 ----
  sessions = [{ id: "keep1", title: "本地这条得留着", at: 1 }];
  __REPLY = { error: "Cannot GET /api/sessions" };
  await mergeServerSessions();
  ok("老版本服务端没这个接口时不动本地那份", sessions.length === 1 && sessions[0].id === "keep1");
  __THROW = true;
  await mergeServerSessions();
  __THROW = false;
  ok("断网时也不动本地那份（更不许清空）", sessions.length === 1 && sessions[0].id === "keep1");
  __REPLY = { sessions: [] };
  await mergeServerSessions();
  ok("服务端如实回「一条没有」时也不清本地", sessions.length === 1 && sessions[0].id === "keep1");
  return names;
})()
`;

const RENDERER_LOG = [];
// ================= 快捷键改绑：武装态必须有三个出口（真源码切片） =================
// 这一屏点下「按键」之后，会往 document 的捕获阶段挂一个 keydown——它吞掉每一次按键。
// 原来只有 Esc 能退出：用户鼠标一点走，监听还挂着，于是回聊天框打的第一个字符消失了，
// 还被静默绑成快捷键（裸 s 这种没人占的键必定绑成功并存进偏好）；更糟的是
// window.__scRebinding 一直为真，app-02.js 那句「改绑中不触发动作」让全站快捷键集体失灵，
// 连再点一次「按键」都点不动（onclick 第一句就被这个 true 挡回去）。
const SCK1 = APP02.indexOf("let toastTimer = null;");
const SCE0 = APP02.indexOf("// ================= 快捷键引擎");
const SCP0 = APP06.indexOf("// ================= 快捷键面板 =================");
const SCP1 = APP06.indexOf("// ================= 自进化：");
if (SCE0 < 0 || SCK1 <= SCE0) throw new Error("app-02.js 里找不到快捷键引擎那一段");
if (SCP0 < 0 || SCP1 <= SCP0) throw new Error("app-06.js 里找不到快捷键面板那一段");
// ---------------------------------------------------------------------------
// 产出卡的缩略图：整张图要看得见，而且不许被拉伸或放大。
// 原来那两条是 height:92px + object-fit:cover——按盒子的比例把图裁一刀。
// 拿工作区里 336 张真产出量过：中位数只剩 78% 露在外面，132 张被切掉一半以上，
// 最狠的只剩 8%；比盒子还小的图（二维码、图标）还会被强行拉满 168 宽再裁，放大糊掉。
// 这把尺子量的是几何事实：图自己那块矩形的形状要跟原图一致（没被拉），
// 要整块落在缩略图盒子里（没被切），小图不许比原图大（没被撑）。
const TH_CASES = [
  { tag: "竖版海报 9:16", w: 720, h: 1280 },
  { tag: "宽屏 16:9", w: 1280, h: 720 },
  { tag: "主力簇 2.28:1", w: 1456, h: 640 },
  { tag: "长图表 4.8:1", w: 1920, h: 400 },
  { tag: "比盒子还小的图标 64×64", w: 64, h: 64 },
];
const TH_PIC = (w, h) => "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
  + `<rect width="${w}" height="${h}" fill="#ccc"/></svg>`);
const TH_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><style>" + INDEX_CSS
  + "</style><style>body{margin:0}</style><body><div class='out-block'><div class='out-body'><div class='out-grid'>"
  + TH_CASES.map((c, i) =>
      `<div class="out-card" data-i="${i}"><div class="out-thumb">`
      + `<span class="out-bg" style="background-image:url(&quot;${TH_PIC(c.w, c.h)}&quot;)" aria-hidden="true"></span>`
      + `<img src="${TH_PIC(c.w, c.h)}" alt="" decoding="async"></div>`
      + `<div class="out-info"><span class="out-name">图 ${i}</span><span class="out-meta">1 KB</span></div>`
      + `<div class="out-acts"></div></div>`).join("")
  + "</div></div></div></body>";
const TH_CHECKS = FLUSH_SRC + `
(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const TAGS = ${JSON.stringify(TH_CASES.map((c) => c.tag))};
  const cards = [...document.querySelectorAll(".out-card")];
  await Promise.all(cards.map((c) => { const im = c.querySelector("img");
    return im.complete && im.naturalWidth ? 0 : new Promise((r) => { im.onload = r; im.onerror = r; }); }));
  const box = (c) => {
    const im = c.querySelector("img"), t = c.querySelector(".out-thumb");
    const r = im.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return { w: r.width, h: r.height, tw: tr.width, th: tr.height, nw: im.naturalWidth, nh: im.naturalHeight };
  };
  const judge = (label) => {
    const bad = { 拉伸: [], 切掉: [], 放大: [] };
    cards.forEach((c, i) => {
      const b = box(c);
      if (Math.abs((b.w / b.h) / (b.nw / b.nh) - 1) > 0.03) bad.拉伸.push(TAGS[i]);
      if (b.w > b.tw + 0.5 || b.h > b.th + 0.5) bad.切掉.push(TAGS[i]);
      if (b.w > b.nw + 0.5) bad.放大.push(TAGS[i]);
    });
    return bad;
  };
  flush();
  const now = judge();
  ok("每张图渲染出来还是它原本的形状（没被拉扁拉长）", now.拉伸.length === 0, now.拉伸);
  ok("每张图整块都落在缩略图盒子里（没被裁掉边角）", now.切掉.length === 0, now.切掉);
  ok("比盒子小的图保持原大小（不被强行撑满再裁）", now.放大.length === 0, now.放大);
  // 留白那圈得有东西：同一张图放大模糊垫在底下，且必须在图的下面，不能盖住图
  const bg = document.querySelector(".out-thumb .out-bg"), img0 = document.querySelector(".out-thumb img");
  const cb = getComputedStyle(bg), ci = getComputedStyle(img0);
  ok("留白有一层同图模糊底垫着（不是一片死灰）", !!bg && cb.backgroundImage !== "none" && parseFloat(cb.opacity) > 0.05, cb.backgroundImage.slice(0, 24));
  ok("那层底在图的后面，不会糊住图本身", (Number(ci.zIndex) || 0) > (Number(cb.zIndex) || 0), [ci.zIndex, cb.zIndex]);
  // ★反向对照★ 把改之前 index.html 里真写着的那两条压回去，这三把尺子必须当场全红
  const back = document.createElement("style");
  back.textContent = ".out-thumb { height: 92px; }\\n.out-thumb img { width: 100%; height: 100%; object-fit: cover; }";
  document.head.appendChild(back); flush();
  const old = judge();
  ok("反向对照：退回 cover + 100%，图当场被拉成盒子的形状（" + old.拉伸.length + " 张）", old.拉伸.length >= 4, old.拉伸);
  ok("反向对照：退回 cover + 100%，小图当场被撑大", old.放大.length >= 1, old.放大);
  back.remove(); flush();
  const again = judge();
  ok("撤掉对照又全好了（这轮不是蒙的）", again.拉伸.length === 0 && again.放大.length === 0);
  return names;
})()
`;

// ---------------------------------------------------------------------------
// 小标记（贴在别的东西旁边说它是什么）只许有一个尺寸。
// 改之前全站十三处各写各的：字号 11 / 11.5 / 12，内边距八种，圆角 4 / 6 / 10 / 999，
// 字重三档。离屏跑真界面量过，光是当时渲染得出来的那六处就是六个高度（17 / 18 /
// 18.5 / 19 / 20.5 / 24），其中 .ex-card .tg i 同一个类因为里面塞不塞图标就差 2.5px。
// 现在统一到 ui.css 的 .ui-badge 小号档：高 20、字 11、左右 7、胶囊角。
// 顺带解开一个名字撞车：.tag 原来是裸的，侧栏品牌名下那行副标题也叫 .tag，
// 于是白顶了一身淡紫药丸皮，字色又被 .brand .tag 改回灰——灰字压淡紫的一条通栏色块。
const PILL_SELS = [
  { sel: "step-card-tag", tag: "过程卡·工具徽章", html: `<div class="step-card"><div class="head"><span class="tag">徽章</span></div></div>` },
  { sel: "proc-warn", tag: "过程条·出错提示", html: `<div class="proc-head"><span class="proc-warn">出错了</span></div>` },
  { sel: "proc-tc", tag: "过程条·工具计数", html: `<div class="proc-head"><span class="tc">3 个工具</span></div>` },
  { sel: "mem-tag", tag: "记忆行·来源", html: `<div class="mem-row"><span class="mem-tag">偏好</span></div>` },
  { sel: "mine-tag", tag: "目录头·我的", html: `<div class="dir-head"><span class="mine-tag">我的</span></div>` },
  { sel: "onb-tag", tag: "向导·必填/建议", html: `<div><span class="onb-tag">必填</span></div>` },
  { sel: "tg-i", tag: "专家卡·领域标签", html: `<div class="ex-card"><div class="tg"><i>行业调研</i></div></div>` },
  { sel: "beta", tag: "子导航·Beta", html: `<div class="hub-sub"><button><i class="beta">Beta</i></button></div>` },
  { sel: "flag", tag: "专家卡·官方", html: `<div class="ex-card"><span class="flag">官方</span></div>` },
  { sel: "ct", tag: "模板卡·分类", html: `<div class="tpl-card"><span class="ct">网页</span></div>` },
  { sel: "badge", tag: "项目卡·当前", html: `<div class="proj-card"><div class="tt"><span class="badge">当前</span></div></div>` },
  { sel: "eng-b", tag: "引擎卡·计费方式", html: `<div><span class="eng-b">走 API Key</span></div>` },
  { sel: "ep-free", tag: "选型菜单·不花额度", html: `<div class="picker-menu eng show"><b class="ep-free">不花 API 额度</b></div>` },
];
const PILL_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><style>" + INDEX_CSS
  + "</style><style>body{margin:0;padding:12px}</style><body>"
  // 品牌位照抄真结构：.brand > div > .tag，这是名字撞车那处
  + `<aside><div class="brand"><div class="mark mk">W</div><div><div class="name">OpenWorkBuddy</div>`
  + `<div class="tag">开源版 · 一句话让 AI 替你上班</div></div></div></aside>`
  + PILL_SELS.map((c) => `<div data-case="${c.sel}">${c.html}</div>`).join("")
  + "</body>";
const PILL_CHECKS = FLUSH_SRC + `
(() => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const CASES = ${JSON.stringify(PILL_SELS.map((c) => ({ sel: c.sel, tag: c.tag })))};
  const pick = (k) => {
    const host = document.querySelector('[data-case="' + k + '"]');
    // 每个壳里最里层那个有底色/描边的小块就是标记本体
    const all = [...host.querySelectorAll("*")];
    return all[all.length - 1];
  };
  const geo = () => CASES.map((c) => {
    const e = pick(c.sel), cs = getComputedStyle(e), r = e.getBoundingClientRect();
    return { tag: c.tag, h: Math.round(r.height * 10) / 10, fs: cs.fontSize,
      pad: cs.paddingTop + " " + cs.paddingRight, rad: cs.borderTopLeftRadius, fw: cs.fontWeight };
  });
  const key = (g) => [g.h, g.fs, g.pad, g.rad, g.fw].join(" | ");

  const now = geo();
  const kinds = [...new Set(now.map(key))];
  ok("十三处小标记是同一个尺寸（" + kinds[0] + "）", kinds.length === 1,
     kinds.length === 1 ? undefined : now.map((g) => g.tag + " → " + key(g)));
  ok("这个尺寸就是 ui.css 里 .ui-badge 的小号档：高 20 / 字 11 / 左右 7 / 胶囊角",
     now[0].h === 20 && now[0].fs === "11px" && now[0].pad === "0px 7px" && now[0].rad === "999px", now[0]);

  // 定高的意义：里面塞图标也好塞纯文字也好，高度不许变。这是改之前 .ex-card .tg i 真栽过的坑。
  const host = document.querySelector('[data-case="tg-i"] .tg');
  const plain = host.querySelector("i").getBoundingClientRect().height;
  const withIcon = document.createElement("i");
  withIcon.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-wrench"></use></svg> deep-research';
  host.appendChild(withIcon); flush();
  const iconed = withIcon.getBoundingClientRect().height;
  ok("同一个标记里塞了图标也还是这么高（" + plain + " vs " + iconed + "）", Math.abs(plain - iconed) < 0.5, [plain, iconed]);
  withIcon.remove(); flush();

  // 名字撞车：侧栏品牌副标题不许带药丸皮
  const bt = document.querySelector(".brand .tag");
  const bs = getComputedStyle(bt);
  const bare = (v) => !v || v === "rgba(0, 0, 0, 0)" || v === "transparent";
  ok("侧栏品牌副标题是一行纯文字，没有底色/内边距/圆角",
     bare(bs.backgroundColor) && parseFloat(bs.paddingLeft) === 0 && parseFloat(bs.borderTopLeftRadius) === 0,
     [bs.backgroundColor, bs.paddingLeft, bs.borderTopLeftRadius]);

  // ★反向对照★ 先把桥接层那条整个撤掉，再把改之前十三条真写着的声明原样压回去，
  // 上面那几把尺子必须当场全红。只压新规则不撤旧的不算数——那是在自己给自己放水。
  const SELS = ".step-card .tag, .proc-warn, .proc-head .tc, .mem-row .mem-tag, .dir-head .mine-tag,"
    + " .onb-tag, .ex-card .tg i, .hub-sub button .beta, .ex-card .flag,"
    + " .tpl-card .ct, .proj-card .tt .badge, .eng-b, .picker-menu.eng .ep-free";
  const back = document.createElement("style");
  back.textContent = SELS + " { display: inline; height: auto; padding: 0; border-radius: 0;"
    + " font-size: inherit; font-weight: inherit; line-height: normal; vertical-align: baseline; }\\n"
    + [
    ".tag { background: var(--owb-brand-weak); padding: 2px 9px; border-radius: var(--radius-lg); font-size: 12px; }",
    ".step-card .tag { font-size: 12px; padding: 2px 9px; border-radius: var(--radius-lg); }",
    ".proc-warn { border-radius: var(--radius-sm); padding: 0 6px; font-size: 12px; }",
    ".proc-head .tc { font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: var(--radius-lg); }",
    ".mem-row .mem-tag { font-size: 12px; border-radius: var(--radius-sm); padding: 1px 6px; }",
    ".dir-head .mine-tag { display: inline-block; padding: 0 6px; border-radius: var(--radius-full); font-size: 11px; line-height: 18px; font-weight: normal; }",
    ".onb-tag { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-full); }",
    ".ex-card .tg i { font-size: 12px; border-radius: var(--radius-sm); padding: 2px 7px; }",
    ".hub-sub button .beta { font-size: 11px; font-weight: 600; border-radius: var(--radius-xs); padding: 1px 4px; }",
    ".ex-card .flag { font-size: 11px; border-radius: var(--radius-sm); padding: 1px 6px; }",
    ".tpl-card .ct { font-size: 12px; border-radius: var(--radius-sm); padding: 1px 7px; }",
    ".proj-card .tt .badge { font-size: 11px; border-radius: var(--radius-sm); padding: 1px 6px; font-weight: 600; }",
    ".eng-b { font-size: 11px; padding: 1px 7px; border-radius: var(--radius-full); }",
    ".picker-menu.eng .ep-free { display: inline-block; padding: 1px 6px; border-radius: var(--radius-sm); font-size: 11.5px; font-weight: 600; }",
  ].join("\\n");
  document.head.appendChild(back); flush();
  const old = geo();
  const oldKinds = [...new Set(old.map(key))];
  ok("反向对照：退回十三条各写各的，当场就是 " + oldKinds.length + " 种尺寸", oldKinds.length >= 10, oldKinds);
  const oldBt = getComputedStyle(document.querySelector(".brand .tag"));
  ok("反向对照：退回裸 .tag，品牌副标题当场又顶了一身药丸底色",
     !bare(oldBt.backgroundColor) && parseFloat(oldBt.paddingLeft) > 0, [oldBt.backgroundColor, oldBt.paddingLeft]);
  const oldTg = document.querySelector('[data-case="tg-i"] .tg i').getBoundingClientRect().height;
  back.remove(); flush();
  const again = geo();
  ok("撤掉对照又回到一种尺寸（这轮不是蒙的）", [...new Set(again.map(key))].length === 1);
  names.push("反向对照下 .ex-card .tg i 的高度是 " + Math.round(oldTg * 10) / 10 + "px，不再是 20");
  return names;
})()
`;

// ---------------------------------------------------------------------------
// 封顶的文字块不许把行横切开。
// 这类框都是「先给你看几行，剩下的滚/展开」，封顶值必须正好等于整数行高；
// 差几百分之一个 em，最后一行就从字腰上被切断，看着跟被什么东西压住了一样。
// 踩过两回：连接器卡的命令行写 3.7em（1.55 行高 → 2.39 行），审批卡收起后写 4.8em
// （含 padding 和边框算下来只有 1.94 行）。这条尺子量的是真几何，不是读 CSS 源码。
const CLIP_SELS = [
  { sel: "ask-cmd", tag: "审批卡·命令原文（收起后）", lines: 2,
    html: `<div style="width:520px"><div class="ask-card ask-approve done"><div class="ask-cmd">把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，</div></div></div>` },
  { sel: "mcp-cmd", tag: "连接器卡·命令行", lines: 3,
    html: `<div style="width:300px"><div class="ex-card mcp-server-card"><div class="ds mcp-server-command">把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，</div></div></div>` },
  { sel: "audio-text", tag: "画布音频节点·正文", lines: 3,
    html: `<div style="width:320px;height:300px"><article class="canvas-node canvas-node-media canvas-node-audio"><div class="canvas-node-body"><div class="canvas-media-text">把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，</div></div></article></div>` },
  // 头一条被 .canvas-chat-log > :first-child 藏了，得摆两条才量得到
  { sel: "chat-live", tag: "画布对话·正在跑的那条", lines: 3,
    html: `<div style="width:420px"><div class="canvas-chat"><div class="canvas-chat-log"><div class="canvas-chat-message"><div class="canvas-chat-message-body"><div class="canvas-chat-text">占位</div></div></div><div class="canvas-chat-message is-live"><div class="canvas-chat-message-body"><div class="canvas-chat-text">把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，把这段字写得足够长，长到怎么排都会超过封顶的那几行，</div></div></div></div></div></div>` },
];
const CLIP_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><style>" + INDEX_CSS
  // 夹具里得把外壳那几条掀掉：真页面是 body{display:flex;height:100%}，
  // 照搬过来格子会被拉满视口，量出来的全是假数
  + "</style><style>html,body{height:auto!important;display:block!important;overflow:visible!important}"
  + "body{margin:0;padding:12px;width:1100px}</style><body>"
  + CLIP_SELS.map((c) => `<div data-case="${c.sel}">${c.html}</div>`).join("")
  + "</body>";
const CLIP_CHECKS = FLUSH_SRC + `
(() => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const CASES = ${JSON.stringify(CLIP_SELS.map((c) => ({ sel: c.sel, tag: c.tag, lines: c.lines })))};
  // 量的是内容盒。不能用 clientHeight——它是取整过的，57.6 拿到手里是 58，
  // 恰好把要量的那几分之一个像素抹平了。getBoundingClientRect 才给小数。
  const geo = (k) => {
    const host = document.querySelector('[data-case="' + k + '"]');
    const all = [...host.querySelectorAll("*")];
    const e = all[all.length - 1], cs = getComputedStyle(e);
    const lh = parseFloat(cs.lineHeight);
    const box = e.getBoundingClientRect().height;
    const inner = box - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    return { lh, inner: Math.round(inner * 1000) / 1000, n: inner / lh, off: Math.abs(inner - Math.round(inner / lh) * lh) };
  };
  const SLICE = 0.25; // px：1/64 的布局取整最多差个零点零几，切掉半行少说也有零点几
  for (const c of CASES) {
    const g = geo(c.sel);
    ok(c.tag + "：封顶正好 " + c.lines + " 行（" + Math.round(g.inner * 100) / 100 + " / 行高 " + g.lh + "）",
       g.off < SLICE && Math.round(g.n) === c.lines, g);
  }
  // 顺带确认这几块真的裁到了——没溢出的话上面那把尺子等于没量
  for (const c of CASES) {
    const host = document.querySelector('[data-case="' + c.sel + '"]');
    const all = [...host.querySelectorAll("*")];
    const e = all[all.length - 1];
    ok(c.tag + "：文本确实超出了封顶，这行不是空过的", e.scrollHeight > e.clientHeight + 1, [e.scrollHeight, e.clientHeight]);
  }

  // ★反向对照★ 把改之前那几个封顶值原样压回去，上面那把尺子必须当场变红
  const back = document.createElement("style");
  back.textContent = ".ask-card.done .ask-cmd { max-height: 4.8em; }\\n"
    + ".canvas-node-audio .canvas-media-text { max-height: 58px; }\\n"
    + ".canvas-chat-message.is-live .canvas-chat-text { max-height: 54px; }\\n"
    + ".mcp-server-command { max-height: 3.7em; }";
  document.head.appendChild(back); flush();
  const bad = CASES.map((c) => ({ tag: c.tag, off: Math.round(geo(c.sel).off * 100) / 100 })).filter((x) => x.off >= SLICE);
  ok("反向对照：退回旧封顶值，四块里 " + bad.length + " 块当场被横切", bad.length === CASES.length, bad);
  back.remove(); flush();
  const again = CASES.filter((c) => geo(c.sel).off >= SLICE);
  ok("撤掉对照又全部落回整行（这轮不是蒙的）", again.length === 0, again.map((c) => c.tag));
  return names;
})()
`;

// ---------------------------------------------------------------------------
// 纯图标钮：没有字，只有一个图标加一句 title。全站离屏点过一遍，去重后十三颗，
// 居然长出六个尺寸（24×24 / 36×27 / 28×28 / 30×30 / 28×32 / 36×36）、三种圆角（6 / 8 / 10）。
// 其中两颗根本不是正方形：#toggle-side 的规则只写内边距不写宽高，高度跟着字号走；
// #fp-close 蹲在一行窄 flex 里被邻居挤成 28 宽。
// 现在收成两档，挂在既有的控件高度梯子上：常规档 = --owb-ctl-h-sm（30），密集档 = 24。
// 这条尺子量的是真几何：宽高、圆角、里头图标的大小，以及「挤得下就被挤扁」这件事。
const ICO_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><style>" + INDEX_CSS
  + "</style><style>body{margin:0;padding:12px;width:1100px}"
  // 夹具里把两个容器的宽度写死，好复现「被挤扁」：真界面上 .files-panel 是可变宽的
  + ".files-panel{width:170px}.fx-row{margin:10px 0}</style><body>"
  + `<div class="fx-row topbar"><button id="toggle-side" class="icon-btn" title="收起/展开侧栏"><svg class="i"><use href="#i-panel-left"></use></svg></button>`
  + `<div class="title">任务标题</div></div>`
  + `<div class="fx-row card-toolbar"><button class="icon-btn" id="attach-btn" title="上传"><svg class="i"><use href="#i-paperclip"></use></svg></button>`
  + `<div class="grow"></div><button class="picker-btn" id="fx-pick"><svg class="i"><use href="#i-sparkles"></use></svg> 模型 <svg class="i"><use href="#i-chevron-down"></use></svg></button></div>`
  + `<div class="fx-row pv-head"><span class="pv-name">产出.html</span>`
  + `<button id="pv-sys" class="icon-btn"><svg class="i"><use href="#i-app-window"></use></svg></button>`
  + `<button id="pv-rv" class="icon-btn"><svg class="i"><use href="#i-folder-open"></use></svg></button>`
  + `<a id="pv-dl" class="icon-btn" href="#" download><svg class="i"><use href="#i-download"></use></svg></a>`
  + `<button id="pv-close" class="icon-btn"><svg class="i"><use href="#i-x"></use></svg></button></div>`
  + `<div class="fx-row files-panel"><h2><span><svg class="i"><use href="#i-folder-open"></use></svg> 成果文件</span>`
  + `<a href="#" class="link">打开文件夹</a><span style="flex:1"></span>`
  + `<button id="fp-close" class="icon-btn"><svg class="i"><use href="#i-x"></use></svg></button></h2></div>`
  + `<div class="fx-row m-head"><h3 id="m-title">设置</h3><button id="m-close" class="m-close"><svg class="i"><use href="#i-x"></use></svg></button></div>`
  + `<div class="fx-row side-nav"><div class="item nav-head"><span class="ic"><svg class="i"><use href="#i-folder"></use></svg></span>`
  + `<span class="tx">项目</span><a href="#" id="proj-add"><svg class="i"><use href="#i-plus"></use></svg></a></div></div>`
  + `<div class="fx-row mrow">模型行 <span class="row-acts"><button class="row-more" id="fx-more" type="button"><svg class="i i-sm"><use href="#i-ellipsis"></use></svg></button></span></div>`
  + `<div class="fx-row"><span class="chip" id="fx-chip">附件.png <a href="#" class="icon-btn" id="fx-chip-x"><svg class="i"><use href="#i-x"></use></svg></a></span></div>`
  + `<div class="fx-row user-row"><div class="user-chip" id="fx-uchip">猫叔</div><button id="gear-btn" class="icon-btn"><svg class="i"><use href="#i-settings"></use></svg></button></div>`
  + "</body>";
const ICO_CHECKS = FLUSH_SRC + `
(() => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const R = (sel) => {
    const e = document.querySelector(sel);
    if (!e) throw new Error("夹具里找不到 " + sel);
    const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
    const ic = e.querySelector("svg");
    const ib = ic ? ic.getBoundingClientRect() : null;
    return { sel, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10,
      rad: cs.borderTopLeftRadius, icon: ib ? Math.round(ib.width) + "×" + Math.round(ib.height) : "-" };
  };
  // 常规档：顶栏 / 输入区附件 / 预览条四颗 / 成果面板关闭 / 弹窗关闭
  const BIG = ["#toggle-side", "#attach-btn", "#pv-sys", "#pv-rv", "#pv-dl", "#pv-close", "#fp-close", "#m-close"];
  const DENSE = ["#proj-add", "#fx-more"];
  const all = [...BIG, ...DENSE, "#fx-chip-x", "#gear-btn"].map(R);

  ok("十二颗纯图标钮个个是正方形", all.every((r) => Math.abs(r.w - r.h) < 0.5),
     all.filter((r) => Math.abs(r.w - r.h) >= 0.5));

  const big = BIG.map(R);
  const bk = [...new Set(big.map((r) => r.w + "×" + r.h + " 圆角 " + r.rad))];
  ok("常规档八颗同一尺寸（" + bk[0] + "）", bk.length === 1, big.map((r) => r.sel + " → " + r.w + "×" + r.h + "/" + r.rad));
  ok("常规档就是控件梯子上的小号档 30，圆角 8", big[0].w === 30 && big[0].h === 30 && big[0].rad === "8px", big[0]);
  const bi = [...new Set(big.map((r) => r.icon))];
  ok("常规档里的图标一律 16×16", bi.length === 1 && bi[0] === "16×16", bi);

  const dense = DENSE.map(R);
  const dk = [...new Set(dense.map((r) => r.w + "×" + r.h + " 圆角 " + r.rad + " 图标 " + r.icon))];
  ok("密集档两颗同一尺寸（" + dk[0] + "）", dk.length === 1, dense);
  ok("密集档是 24 见方 / 圆角 6 / 图标 14", dense[0].w === 24 && dense[0].rad === "6px" && dense[0].icon === "14×14", dense[0]);

  // chip 里那颗更小：它嵌在一颗 30 高的胶囊里，跟着胶囊走才不会把胶囊撑破
  const chipBtn = R("#fx-chip-x"), chip = document.querySelector("#fx-chip").getBoundingClientRect();
  ok("chip 里那颗 18 见方，没把胶囊撑破（胶囊高 " + Math.round(chip.height) + "）",
     chipBtn.w === 18 && chipBtn.h === 18 && chipBtn.h <= chip.height, [chipBtn, Math.round(chip.height)]);

  // 挤不扁：改之前 #fp-close 在窄面板里被邻居压成 28 宽
  ok("面板挤到 170px 宽，关闭键还是 30×30（flex:none 兜住了）", R("#fp-close").w === 30 && R("#fp-close").h === 30, R("#fp-close"));

  // 预览条一排四颗，其中一颗是 <a>——改之前它比三个 <button> 兄弟圆 2px
  const pv = ["#pv-sys", "#pv-rv", "#pv-dl", "#pv-close"].map(R);
  ok("预览条四颗（含那个 <a>）圆角只有一种：" + pv[0].rad, [...new Set(pv.map((r) => r.rad))].length === 1,
     pv.map((r) => r.sel + " " + r.rad));

  // 输入区工具条：附件键和它右边的选择器并排，改之前 32 对 30
  const at = R("#attach-btn"), pk = R("#fx-pick");
  ok("输入区工具条上附件键和模型选择器同高（" + at.h + " / " + pk.h + "）", at.h === pk.h, [at, pk]);

  // 齿轮是故意留在外面的：带描边、挨着 44 高圆角 10 的用户气泡，跟着气泡走更齐
  const gear = R("#gear-btn"), uc = document.querySelector("#fx-uchip");
  ok("齿轮故意不并档：36 见方 / 圆角 10，跟旁边用户气泡的圆角对上（" + getComputedStyle(uc).borderTopLeftRadius + "）",
     gear.w === 36 && gear.h === 36 && gear.rad === getComputedStyle(uc).borderTopLeftRadius, [gear, getComputedStyle(uc).borderTopLeftRadius]);

  // ★反向对照★ 先把桥接层那两档整个撤掉，再把改之前七条真写着的声明原样压回去。
  // 上面那几把尺子必须当场全红：六个尺寸、三种圆角、两颗不是正方形。
  const back = document.createElement("style");
  back.textContent = [
    ".icon-btn, .m-close, .side-nav .nav-head #proj-add, .row-more { width: auto; height: auto; padding: 0; border-radius: 0; display: inline-block; flex: 0 1 auto; }",
    ".side-nav .nav-head #proj-add .i, .row-more .i { width: 1em; height: 1em; }",
    ".picker-btn { height: auto; padding: 6px 10px; }",
    ".icon-btn { width: 32px; height: 32px; border-radius: var(--radius-md); display: flex; align-items: center; justify-content: center; }",
    ".chip .icon-btn { width: 18px; height: 18px; flex: none; }",
    ".pv-head button { padding: 4px 8px; border-radius: var(--radius-sm); }",
    "#toggle-side { padding: 4px 10px; border-radius: var(--radius-md); margin-left: -8px; width: auto; height: auto; display: inline-block; }",
    "#fp-close { padding: 2px 6px; border-radius: var(--radius-sm); }",
    ".m-close { width: 28px; height: 28px; flex: none; padding: 0; border-radius: var(--radius-md); display: inline-flex; align-items: center; justify-content: center; }",
    ".row-more { width: 24px; height: 24px; flex: none; padding: 0; border-radius: var(--radius-sm); display: inline-flex; align-items: center; justify-content: center; }",
    ".side-nav .nav-head #proj-add { padding: 0; width: 24px; height: 24px; flex: none; border-radius: var(--radius-sm); display: inline-flex; align-items: center; justify-content: center; }",
  ].join(" ");
  document.head.appendChild(back); flush();
  const old = [...BIG, ...DENSE, "#gear-btn"].map(R);
  const oldSizes = [...new Set(old.map((r) => r.w + "×" + r.h))];
  const oldRads = [...new Set(old.map((r) => r.rad))];
  const oddShape = old.filter((r) => Math.abs(r.w - r.h) >= 0.5);
  ok("反向对照：退回七条各写各的，当场就是 " + oldSizes.length + " 种尺寸 —— " + oldSizes.join(" / "),
     oldSizes.length >= 5, oldSizes);
  ok("反向对照：圆角也回到 " + oldRads.length + " 种 —— " + oldRads.join(" / "), oldRads.length >= 3, oldRads);
  ok("反向对照：有 " + oddShape.length + " 颗当场不是正方形（" + oddShape.map((r) => r.sel + " " + r.w + "×" + r.h).join("，") + "）",
     oddShape.length >= 2, oddShape);
  const oldAt = R("#attach-btn"), oldPk = R("#fx-pick");
  ok("反向对照：输入区那两颗又差 " + Math.round(Math.abs(oldAt.h - oldPk.h) * 10) / 10 + "px", oldAt.h !== oldPk.h, [oldAt.h, oldPk.h]);
  back.remove(); flush();

  const again = [...new Set(BIG.map(R).map((r) => r.w + "×" + r.h + " " + r.rad))];
  ok("撤掉对照又回到一种尺寸（这轮不是蒙的）", again.length === 1, again);
  return names;
})()
`;

// ---------------------------------------------------------------------------
// 行内控件的高度只许有一个。
// 改之前每个家族各写各的内边距，凑出一堆高度：输入框 8px 12px → 35，下拉同样的
// 内边距 → 37（select 的内容盒天生比 input 高 2px），主按钮 → 36，次要按钮
// 7px 14px → 32，hub-head 上的胶囊 4px 12px → 31。实测 19 个落点里，有 9 行
// 控件并排站着却四种底边，最大差 5px（评测页三个下拉 31 挨着主按钮 36）。
// 现在高度统一由 --owb-ctl-h 出，内边距只管左右。
// 这条尺子量的是真几何，不是 CSS 文本——写死 36px 也好、令牌也好，只要量出来齐就算过。
const CTL_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><style>" + INDEX_CSS
  + "</style><style>*{transition:none!important;animation:none!important}</style><body>"
  // 照抄真界面上那几种并排：hub-head（搜索框 + 胶囊 + 次要键 + 主键）、
  // form-row（输入框 + 次要键）、评测页那排下拉。
  + "<div class='hub-head' id='r-hub'>"
  + "  <div class='hub-search'><input id='k-q' placeholder='搜索'></div>"
  + "  <button class='chip' id='k-chip'>只看我的</button>"
  + "  <button class='btn-plain' id='k-plain'>批量</button>"
  + "  <button class='btn-brand' id='k-brand'>新建</button>"
  + "</div>"
  + "<div class='form-row' id='r-form'><input id='k-in'><button class='btn-plain' id='k-plain2'>选择</button></div>"
  + "<div class='hub-head' id='r-sel'><select id='k-sel'><option>甲</option></select>"
  + "  <button class='btn-brand' id='k-brand2'>开跑</button></div>"
  + "</body>";
const CTL_CHECKS = FLUSH_SRC + `
(() => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const H = (sel) => {
    const e = document.querySelector(sel);
    if (!e) throw new Error("夹具里找不到 " + sel);
    return Math.round(e.getBoundingClientRect().height);
  };
  const ROWS = [
    ["hub-head：搜索框 / 胶囊 / 次要键 / 主键", ["#k-q", "#k-chip", "#k-plain", "#k-brand"]],
    ["form-row：输入框 / 次要键", ["#k-in", "#k-plain2"]],
    ["评测行：下拉 / 主键", ["#k-sel", "#k-brand2"]],
  ];
  for (const [label, sels] of ROWS) {
    const hs = sels.map(H);
    const kinds = [...new Set(hs)];
    ok(label + " 同高（" + hs.join(" / ") + "）", kinds.length === 1, hs);
  }
  // 全站只许一个数：三行加起来必须还是同一个高度
  const all = [...new Set(ROWS.flatMap(([, s]) => s.map(H)))];
  ok("三行之间也是同一个高度 " + all[0] + "px", all.length === 1, all);
  // 下拉那 2px 是这批里最阴的一条：input 和 select 给一样的内边距，量出来差 2px
  ok("下拉跟输入框一样高（select 的内容盒天生高 2px，定高才压得住）", H("#k-sel") === H("#k-q"), [H("#k-sel"), H("#k-q")]);
  // 定高之后别把字挤没了
  for (const sel of ["#k-q", "#k-in", "#k-sel", "#k-plain", "#k-brand", "#k-chip"]) {
    const e = document.querySelector(sel), cs = getComputedStyle(e);
    const inner = e.getBoundingClientRect().height - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth)
                  - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    ok(sel + " 里还放得下一整行字（内容盒 " + inner.toFixed(0) + "px / 字 " + parseFloat(cs.fontSize) + "px）",
       inner >= parseFloat(cs.fontSize) * 1.15, [inner, parseFloat(cs.fontSize)]);
  }
  // ★反向对照★ 把次要按钮按旧写法压回 shadcn 的 sm 档（32），这把尺子必须当场变红。
  // 不是造一个现编的场景：32 就是改之前 index.html 里真写着的那个数。
  const back = document.createElement("style");
  back.textContent = ".btn-plain { height: 32px; padding: 0 12px; }";
  document.head.appendChild(back); flush();
  ok("反向对照：次要键退回 32px，hub-head 当场又不齐了", H("#k-plain") !== H("#k-brand"), [H("#k-plain"), H("#k-brand")]);
  back.remove(); flush();
  // ★反向对照★ 把下拉的定高撤掉，它会自己涨回 37
  const back2 = document.createElement("style");
  back2.textContent = "select { height: auto; padding: 8px 12px; }";
  document.head.appendChild(back2); flush();
  ok("反向对照：撤掉下拉定高，它比输入框高出来", H("#k-sel") > H("#k-q"), [H("#k-sel"), H("#k-q")]);
  back2.remove(); flush();
  ok("反向对照撤干净了，三行又齐了", [...new Set(ROWS.flatMap(([, s]) => s.map(H)))].length === 1);
  return names;
})()
`;

const SC_SRC = APP02.slice(SCE0, SCK1) + "\n" + APP06.slice(SCP0, SCP1);
const SC_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style><body><div id='pane'></div></body>";
const SC_STUBS = `
  ${IC_STUB}
  const SAVED = [];
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function saveSettings(patch) { SAVED.push(JSON.parse(JSON.stringify(patch))); return Promise.resolve({ ok: true }); }
`;
// app-02.js 里那两处「关弹窗」得真的调撤销钩子——弹窗关了监听还在，是同一个病的另一种得法
const SC_CLOSE_SITES = APP02.split("\n").filter((l) => l.includes("__scCancelRebind") || l.includes("closeModal")).map((l) => l.trim());
const SC_CHECKS = `
(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const tick = () => new Promise((r) => setTimeout(r, 8));
  const pane = document.getElementById("pane");
  renderShortcutsPane(pane, { shortcuts: {} });

  const kbd = () => pane.querySelector('.sc-edit[data-id="new-chat"]');
  const arm = () => { kbd().click(); };
  /** 往 document 上真发一次按键，返回它有没有被那个捕获监听吃掉 */
  const press = (init) => {
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const clickAway = () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));

  const WAS = kbd().textContent;

  // ---- 先钉住「吞键」这件事真实存在：武装态下按键确实被吃掉（有它这组断言才有意义）----
  arm();
  ok("点一下按键就进入武装态（标志位立起来了）", window.__scRebinding === true);
  // 用「只按了修饰键」来验吞键：它同样走到 preventDefault，但不会落绑定，武装态留得住
  ok("武装态下按键确实被吞掉（这是下面每一条的对照基准）", press({ key: "Shift", code: "ShiftLeft", shiftKey: true }) === true);
  ok("武装态下屏幕上有第二个出口：一颗能点的「取消」", !!pane.querySelector(".sc-cancel"));

  // ---- 出口一：鼠标点到别处 ----
  clickAway();
  ok("鼠标点到别处 = 放弃改绑，标志位落下", window.__scRebinding === false);
  ok("放弃之后按键不再被吞（原来这一下会打不出字，还被静默绑成快捷键）", press({ key: "s", code: "KeyS" }) === false);
  ok("放弃之后什么都没存进偏好", SAVED.length === 0, SAVED);
  ok("按键文案原地还原，没留下「按下新组合键…」", kbd().textContent === WAS, kbd().textContent);
  ok("「取消」按钮跟着撤走", !pane.querySelector(".sc-cancel"));
  ok("撤销钩子也清干净了（别让下一次关弹窗调到死的闭包）", window.__scCancelRebind === null);
  ok("还能再点一次「按键」（原来那个没落下的 true 会把改绑功能彻底点不动）", (arm(), window.__scRebinding === true));
  clickAway();

  // ---- 出口二：点「取消」 ----
  arm();
  ok("武装时撤销钩子挂上了（弹窗被别的代码关掉也能撤）", typeof window.__scCancelRebind === "function");
  pane.querySelector(".sc-cancel").click();
  ok("点「取消」退出武装态", window.__scRebinding === false && !pane.querySelector(".sc-cancel"));
  ok("点「取消」之后按键不被吞", press({ key: "s", code: "KeyS" }) === false);

  // ---- 出口三：Esc（老路，不能改坏）----
  arm();
  ok("Esc 仍然能退出", (press({ key: "Escape", code: "Escape" }), window.__scRebinding === false));
  ok("Esc 之后按键不被吞", press({ key: "s", code: "KeyS" }) === false);
  ok("Esc 之后按键文案也还原了", kbd().textContent === WAS, kbd().textContent);

  // ---- 出口四：面板被重画（搜索/切标签）后自解除，别继续吞键 ----
  arm();
  const search = pane.querySelector("#sc-search");
  search.value = "新建";
  search.dispatchEvent(new Event("input", { bubbles: true })); // 重画列表 = 原来那颗 kbd 已经不在文档里了
  ok("重画之后第一次按键只用来自解除，不落任何绑定", press({ key: "s", code: "KeyS" }) === false);
  ok("重画之后标志位也落下了", window.__scRebinding === false);
  ok("重画之后没有偷偷存东西", SAVED.length === 0, SAVED);
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));

  // ---- 正路还得通：真按一个没人占的组合键，就该存下来 ----
  arm();
  press({ key: "j", code: "KeyJ", metaKey: true });
  await tick();
  ok("按下 ⌘J：存进偏好且退出武装态", window.__scRebinding === false && SAVED.length === 1 && SAVED[0].shortcuts["new-chat"] === "Meta+J", SAVED);

  // ---- 冲突还得拦住，且拦住时不许退出（用户要接着按下一个）----
  const kbd2 = () => pane.querySelector('.sc-edit[data-id="toggle-sidebar"]');
  kbd2().click();
  press({ key: "f", code: "KeyF", metaKey: true }); // ⌘F 是「对话内搜索」
  ok("撞车时当场说撞了谁，并且继续等下一个键", window.__scRebinding === true && /冲突/.test(kbd2().textContent), kbd2().textContent);
  press({ key: "Escape", code: "Escape" });
  ok("撞车之后 Esc 照样退得出来", window.__scRebinding === false);

  // ---- 关弹窗这条路：源码里必须真的调了撤销钩子 ----
  ok("app-02.js 的关弹窗走统一出口并撤掉改绑监听", ${JSON.stringify(SC_CLOSE_SITES)}.some((l) => l.includes("__scCancelRebind")) && ${JSON.stringify(SC_CLOSE_SITES)}.filter((l) => l.includes("closeModal")).length >= 3, ${JSON.stringify(SC_CLOSE_SITES)});

  return names;
})()`;

// 存盘链路（#91，真源是 app-02.js 的 postJson：
// 老写法一个 catch 把四种完全不同的事故糊成同一句「接口无响应」。所以这一屏要验的不是
// 「会不会报错」，而是「几种坏法说出几句**互不相同**的人话」——只测一种坏法，
// 当初那个 bug 一次也不会现形。
const SAVE0 = APP02.indexOf("async function postJson(url, body, timeoutMs)");
const SAVE1 = APP02.indexOf("// ---- 图表看大图 ----");
if (SAVE0 < 0 || SAVE1 <= SAVE0) throw new Error("app-02.js 里的 postJson / saveInlineFile 找不到了（改名/挪走？），存盘测试没法定位真源码");
const SAVE_SRC = APP02.slice(SAVE0, SAVE1);
const SAVE_HTML = "<!doctype html><meta charset='utf-8'><body><button id='b'>存盘</button></body>";
const SAVE_STUBS = `
  const TOASTS = [], DOWNLOADS = [], CALLS = [];
  const toast = (t) => TOASTS.push(String(t));
  const flashBtn = () => {};
  const renderFiles = () => {};
  let sessionId = "s1";
  const sessionDirs = new Map([["s1", "任务_0911_ab12"]]);
  // <a download> 那一下点击要拦住：真点会让 Chromium 弹下载面板，测试只需要知道「点过、点的哪个名字」
  HTMLAnchorElement.prototype.click = function () { DOWNLOADS.push({ name: this.download }); };
  // 每条用例自己排一个「这次 fetch 怎么坏」
  let NEXT = null;
  window.fetch = (url, opt) => {
    CALLS.push({ url, body: JSON.parse(opt.body) });
    if (NEXT.hang) return new Promise((_, rej) => opt.signal.addEventListener("abort", () => {
      const e = new Error("aborted"); e.name = "AbortError"; rej(e);
    }));
    if (NEXT.dead) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: NEXT.status < 400, status: NEXT.status, text: () => Promise.resolve(NEXT.body) });
  };
`;
const SAVE_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const btn = document.getElementById("b");
  const said = [];
  let r;

  NEXT = { dead: true };
  r = await postJson("/api/files/save", { name: "a.svg" }, 5000);
  said.push(r.why);
  ok("后台退了连不上：说的是「连不上本机服务」，而不是那句什么也没说的「接口无响应」",
    r.data === null && r.why.includes("连不上本机服务") && !r.why.includes("接口无响应"), r.why);

  NEXT = { hang: true };
  const t0 = Date.now();
  r = await postJson("/api/files/save", { name: "a.svg" }, 600);
  const waited = Date.now() - t0;
  said.push(r.why);
  ok("后台卡住一直不回：到点真把请求掐了，并且告诉人等了多久",
    r.data === null && r.why.includes("还没回应") && waited >= 500 && waited < 3000, r.why + " · 实等 " + waited + "ms");

  NEXT = { status: 502, body: "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>" };
  r = await postJson("/api/files/save", { name: "a.svg" }, 5000);
  said.push(r.why);
  ok("前面挡了个网关、回的是 HTML 错误页：报出 HTTP 码，还把那页头一截抄过来给人看",
    r.data === null && r.why.includes("HTTP 502") && r.why.includes("不是 JSON") && r.why.includes("502 Bad Gateway"), r.why);

  NEXT = { status: 413, body: JSON.stringify({ error: "这张图 28 MB，超过单文件上限 20 MB" }) };
  r = await postJson("/api/files/save", { name: "a.svg" }, 5000);
  said.push(r.why);
  ok("服务端自己说了人话：原样转述，不被「HTTP 413」四个字盖掉",
    r.why === "这张图 28 MB，超过单文件上限 20 MB" && !r.why.includes("413"), r.why);

  NEXT = { status: 401, body: JSON.stringify({ need_login: true }) };
  r = await postJson("/api/files/save", { name: "a.svg" }, 5000);
  said.push(r.why);
  ok("服务端只回了个码没给话：退回「HTTP 401」，至少知道该往哪儿查",
    !!r.data && r.data.error === "HTTP 401" && r.why === "HTTP 401", r.why);

  NEXT = { status: 200, body: "" };
  r = await postJson("/api/files/save", { name: "a.svg" }, 5000);
  said.push(r.why);
  ok("200 但正文是空的：也得说出来，别当成功放过去",
    r.data === null && r.why.includes("空响应"), r.why);

  ok("六种坏法说出六句互不相同的话——当初的 bug 就是它们全被糊成了同一句",
    new Set(said).size === said.length, said.join(" ｜ "));

  // ---- saveInlineFile：存哪儿、失败怎么说、自己点的取消别吓人 ----
  NEXT = { status: 200, body: JSON.stringify({ ok: true, dir: "任务_0911_ab12", files: [] }) };
  CALLS.length = 0; TOASTS.length = 0;
  await saveInlineFile("图.svg", "<svg/>", btn, false);
  ok("默认存进这次对话自己的成果文件夹，不再一股脑丢进工作区根目录",
    CALLS[0].body.dir === "任务_0911_ab12" && TOASTS[0].includes("任务_0911_ab12"), CALLS[0].body.dir + " · " + TOASTS[0]);

  NEXT = { dead: true };
  TOASTS.length = 0;
  await saveInlineFile("图.svg", "<svg/>", btn, false);
  ok("存不下时弹的那句里带着到底哪一环坏了",
    TOASTS.length === 1 && TOASTS[0].includes("保存失败") && TOASTS[0].includes("连不上本机服务"), TOASTS.join("｜"));

  NEXT = { status: 200, body: JSON.stringify({ canceled: true }) };
  TOASTS.length = 0;
  await saveInlineFile("图.svg", "<svg/>", btn, true);
  ok("「另存为」里自己点了取消：一声不吭，不补一句「失败」吓人", TOASTS.length === 0, TOASTS.join("｜"));

  NEXT = { status: 200, body: JSON.stringify({ no_dialog: true }) };
  TOASTS.length = 0; DOWNLOADS.length = 0;
  await saveInlineFile("图.svg", "<svg/>", btn, true);
  ok("网页端没有系统保存框：退回浏览器下载，并说清楚想换地方去哪儿改",
    DOWNLOADS.length === 1 && DOWNLOADS[0].name === "图.svg" && TOASTS.length === 1 && TOASTS[0].includes("浏览器"),
    JSON.stringify(DOWNLOADS) + " · " + TOASTS.join("｜"));

  return names;
})()`;

// 装一个 DOM 哨兵：只要有人把 ${...} 原样画进页面就记下来（跳过 script/style/template 里的正则源码）
const PLACEHOLDER_WATCH = `(() => {
  if (window.__phFlush) return 1;
  if (!document.documentElement) return 0;
  window.__phLeak = "";
  const RX = /\\$\\{[^}\\n]{0,60}\\}/;
  const SKIP = /^(SCRIPT|STYLE|TEMPLATE)$/;
  const look = (s) => { if (!window.__phLeak && s) { const m = String(s).match(RX); if (m) window.__phLeak = m[0]; } };
  const scan = (n) => {
    if (!n || window.__phLeak) return;
    if (n.nodeType === 3) { if (!(n.parentElement && SKIP.test(n.parentElement.tagName))) look(n.nodeValue); return; }
    if (n.nodeType !== 1 || SKIP.test(n.tagName)) return;
    for (const a of n.attributes || []) look(a.value);
    for (const c of n.childNodes) scan(c);
  };
  const eat = (rs) => { for (const r of rs) { if (r.type === "childList") r.addedNodes.forEach(scan); else scan(r.target); } };
  const mo = new MutationObserver(eat);
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__phFlush = () => { eat(mo.takeRecords()); return window.__phLeak; };
  return 1;
})()`;

// ================= 关于页：读不到版本号时不许把 undefined 摆到脸上（真源码切片） =================
// 这一屏开头就 fetch("/api/update")，然后不看状态码直接 r.json()。cookie 过期时登录闸
// 会回 401 + {error:"未登录", setup:true}——那个形状里没有 current 也没有 how，
// 原来的写法照着拼，界面上就成了「当前 vundefined」和「未登录。undefined」。
const AB0 = APP06.indexOf("function renderAboutPane(pane) {");
if (AB0 < 0) throw new Error("app-06.js 里找不到 renderAboutPane");
const AB_SRC = APP06.slice(AB0);
const AB_HTML = "<!doctype html><meta charset='utf-8'><body><div id='pane'></div></body>";
const AB_STUBS = `
  ${IC_STUB}
  // 真界面里 esc/ic 都由 app-00-ui.js 挂在 window 上，这个夹具只切了 app-06.js，得自己补上
  var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let NEXT = {};
  const mask = { classList: { remove() {} } };
  function openOnboarding() {}
  function fetch() { return Promise.resolve({ json: () => Promise.resolve(NEXT) }); }
  // 「复制这条命令」按下去会走剪贴板和 toast；离屏窗口里两样都没有，各记一笔就行
  let TOASTS = [], COPIED = null;
  function toast(t, kind) { TOASTS.push(String(t) + (kind ? "/" + kind : "")); }
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t) => { COPIED = t; return Promise.resolve(); } },
  });
`;
const AB_CHECKS = `
(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const pane = document.getElementById("pane");
  const tick = () => new Promise((r) => setTimeout(r, 12));
  const draw = async (payload) => { NEXT = payload; pane.innerHTML = ""; renderAboutPane(pane); await tick(); await tick(); return pane; };
  const ver = () => pane.querySelector("#ab-ver").textContent;
  const how = () => pane.querySelector("#ab-up-how").textContent;
  const link = () => pane.querySelector("#ab-up-link");
  const naked = () => /\\bundefined\\b|\\bNaN\\b/.test(pane.innerText);

  // ---- 先钉住这个夹具真的能复现：拿 401 那个形状按老写法拼一遍，必须拼出 vundefined ----
  const d401 = { error: "未登录", setup: true };
  ok("夹具站得住：401 的形状按老写法拼确实会拼出「当前 vundefined」",
     ("当前 v" + d401.current) === "当前 vundefined");

  // ---- 正路 ----
  await draw(d401);
  ok("cookie 过期时版本行不再是 vundefined", !/undefined/.test(ver()), ver());
  ok("cookie 过期时整屏一个裸 undefined/NaN 都没有", !naked(), pane.innerText.slice(0, 200));
  ok("而且说的是「重新登录」这条能照着做的路，不是把 error 原样丢出来", /登录/.test(how()) && !/undefined/.test(how()), how());
  ok("这种时候不画「去下载页」（点了也没用）", link().style.display === "none");

  // ---- 反向对照一：接口正常时照旧把版本号画出来（别为了挡 undefined 把正路一起挡了）----
  await draw({ current: "1.2.3", install: "source", latest: "1.2.3", how: "已经是最新的了。" });
  ok("接口正常时版本号照画", /当前 v1\\.2\\.3/.test(ver()) && /源码运行/.test(ver()), ver());
  ok("接口正常时也没有裸 undefined", !naked(), pane.innerText.slice(0, 200));

  // ---- 反向对照二：有新版时下载链接得露出来，href 还得换成服务端给的那条 ----
  await draw({ current: "1.2.3", latest: "1.3.0", has_update: true, url: "https://example.invalid/rel", how: "去下载页拿新版。" });
  ok("有新版时「去下载页」露出来", link().style.display !== "none");
  ok("而且链接换成了服务端给的那条", link().getAttribute("href") === "https://example.invalid/rel", link().getAttribute("href"));

  // ---- 那条升级命令：macOS 用户照着「下个新 dmg」升级，等于把自己升级成打不开 ----
  // （新下的包带 com.apple.quarantine，双击就是「Apple 无法验证」，只有「完成 / 移到废纸篓」）
  // 所以有新版时得当场把零弹窗那条 curl 摆出来，还得能点「复制」——90 个字符没人手抄。
  const cmdBox = () => pane.querySelector("#ab-up-cmd");
  const cmdTxt = () => pane.querySelector("#ab-up-cmd-t").textContent;
  const CURL = "curl -fsSL https://example.invalid/install-mac.sh | bash";
  await draw({ current: "1.2.3", latest: "1.3.0", has_update: true, how_cmd: CURL, how: "贴进终端。" });
  ok("有新版时那条命令画出来了", cmdBox().style.display !== "none" && cmdTxt() === CURL, cmdTxt());
  TOASTS = []; COPIED = null;
  pane.querySelector("#ab-up-cmd-copy").click();
  await tick();
  ok("点「复制」进的是剪贴板里的整条命令，不是半截", COPIED === CURL, COPIED);
  ok("而且告诉了他复制完该干什么", TOASTS.length === 1 && /终端/.test(TOASTS[0]), TOASTS);

  // ---- 反向对照：已经是最新还摆一条「升级命令」，照着跑一趟等于白跑 ----
  await draw({ current: "1.3.0", latest: "1.3.0", has_update: false, how_cmd: CURL, how: "已经是最新的了。" });
  ok("已是最新时不摆升级命令", cmdBox().style.display === "none", cmdTxt());

  // ---- 反向对照：Windows 那边没有这条命令（how_cmd 是空串），不许摆一个空框 ----
  await draw({ current: "1.2.3", latest: "1.3.0", has_update: true, how_cmd: "", how: "下 setup.exe 覆盖装。" });
  ok("没有命令可给时不摆一个空框", cmdBox().style.display === "none", cmdTxt());

  // ---- 反向对照：上一次画出来的命令不许挂在「版本号没读到」下面 ----
  // drawUpdate 是就地重画的（点「检查更新」不会重建这一屏），漏掉这一行就会留一条上次的命令
  await draw({ current: "1.2.3", latest: "1.3.0", has_update: true, how_cmd: CURL, how: "贴进终端。" });
  NEXT = d401; pane.querySelector("#ab-up-btn").click(); await tick(); await tick();
  ok("降级成「版本号没读到」时，上一次那条命令跟着收走", cmdBox().style.display === "none",
     pane.querySelector("#ab-ver").textContent + " | " + cmdBox().style.display);

  // ---- 反向对照三：版本号读到了、只是查线上失败——这时 error 该原样说出来，不能被兜底吞掉 ----
  await draw({ current: "1.2.3", error: "连不上 GitHub", how: "过会儿再点一次。" });
  ok("查线上失败时仍然画得出本机版本号", /当前 v1\\.2\\.3/.test(ver()), ver());
  ok("而且服务端那句原话没被兜底吞掉", /连不上 GitHub/.test(how()) && /过会儿再点一次/.test(how()), how());

  // ---- 反向对照四：服务端只回了 current，没给 how——也不许拼出 undefined ----
  await draw({ current: "1.2.3" });
  ok("服务端少给 how 字段时也不拼出 undefined", !naked(), pane.innerText.slice(0, 200));

  return names;
})()
`;

// ================= 设置弹窗：装得下 + 左边缘对得齐（拿真 CSS 量） =================
// 层高原来写死 60vh：1440×900 的屏上就是 540px，19 条快捷键只露得出 11 条，关于页最后一张卡被切掉。
// 另一处是 .m-body 的 20px 留白和侧栏自己的留白叠了两层，导航整体比弹窗标题右 8px。
// 这两条都只能量出来，看源码看不出来——所以这一块把真 CSS 灌进离屏窗口量像素。
const SETL_MARKUP_CLASSES = ["settings-layout", "settings-nav", "settings-pane", "cat", "ci"];
for (const c of SETL_MARKUP_CLASSES) {
  if (!APP05.includes(c)) throw new Error("app-05.js 里找不到 ." + c + "：夹具和真界面已经对不上了");
}
const SETL_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style><body>"
  + "<div class='modal-mask show' id='modal-mask'><div class='modal wide' id='modal-box'>"
  + "<div class='m-head'><h3 id='m-title'>设置</h3><button class='m-close'>x</button></div>"
  + "<div class='m-body' id='m-body'></div></div></div></body>";
const SETL_CHECKS = FLUSH_SRC + `
(() => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const body = document.getElementById("m-body");
  // 跟 app-05.js renderSettings 画的是同一套结构：侧栏 12 条 + 右边一长条内容
  const cats = ["模型","联网","助理","安全","快捷键","人设","外观","记忆","自进化","数据","远程","关于"];
  body.innerHTML = '<div class="settings-layout"><div class="settings-nav">'
    + cats.map((t, i) => '<div class="cat' + (i ? "" : " active") + '"><span class="ci"><svg width="16" height="16"></svg></span>' + t + '</div>').join("")
    + '</div><div class="settings-pane" id="settings-pane"></div></div>';
  const pane = document.getElementById("settings-pane");
  pane.innerHTML = new Array(14).fill('<div class="card-item"><div class="t">一张卡</div><div class="d">占位</div></div>').join("");

  // .m-body:has(> .settings-layout){padding:0} 是靠「子节点插进来」这件事去重新匹配父节点的。
  // CI 的离屏窗口上这次重新匹配会漏掉：量到的还是插之前那份 padding，
  // 图标列就整整右移 20px——跟下面反向对照故意造出来的错位一模一样，看日志分不出真假。
  // 先逼一次全树重算，再开量。
  flush();

  const lay = document.querySelector(".settings-layout");
  /** 量文字真正的左边缘：量盒子再加内边距是算出来的，量文字节点才是眼睛看到的 */
  const textLeft = (el) => {
    const r = document.createRange();
    r.selectNodeContents([...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()) || el);
    return Math.round(r.getBoundingClientRect().left);
  };
  const iconLeft = () => Math.round(document.querySelector(".settings-nav .cat .ci").getBoundingClientRect().left);
  const titleLeft = () => textLeft(document.getElementById("m-title"));

  const h = Math.round(lay.getBoundingClientRect().height);
  ok("940 高的窗口里设置层撑到 700 以上（写死 60vh 时只有 564）", h >= 700, h);
  const mb = getComputedStyle(body);
  ok("图标列和弹窗标题文字同一列", iconLeft() === titleLeft(),
    { icon: iconLeft(), title: titleLeft(), "m-body 的左右留白": mb.paddingLeft + "/" + mb.paddingRight,
      "这个引擎认不认 :has()": !!(window.CSS && CSS.supports && CSS.supports("selector(:has(*))")) });

  // ---- 反向对照：把这两条改回修之前的写法，两个断言都得当场挂 ----
  const undo = document.createElement("style");
  undo.textContent = ".settings-layout { height: 60vh; } .m-body:has(> .settings-layout) { padding: 14px 20px 20px; }";
  document.head.appendChild(undo); flush();
  const h2 = Math.round(lay.getBoundingClientRect().height);
  ok("反向对照：改回 60vh 层高立刻掉回 600 以下", h2 < 600, h2);
  ok("反向对照：m-body 的留白加回去，图标列就和标题错开", iconLeft() !== titleLeft(), { icon: iconLeft(), title: titleLeft() });
  ok("反向对照：错开的量正好是 m-body 那 20px", iconLeft() - titleLeft() === 20, iconLeft() - titleLeft());
  undo.remove(); flush();
  ok("撤掉对照样式之后又对回去了", iconLeft() === titleLeft());

  return names;
})()
`;

// ================= 对比度：量真元素压真底色，不是量令牌压令牌 =================
// 上面那组矩阵量的是 --brand-text 压 body 底色，是「令牌层」的账。
// 但界面上的字不一定坐在 body 上：侧栏选中行的副标题坐在 --owb-brand-weak 上，
// 还额外压了一层 opacity——令牌层全绿，眼睛看到的是 3.55。这一块补的就是这笔账。
// 关掉过渡：.side-nav .item 带 transition，切主题那一刻 getComputedStyle 读到的是
// 「正在往新色渐变的中间值」——实测暗色下背景仍报浅色的 rgb(238,240,255)，
// 于是对比度算出 2.07，像是有个根本不存在的 bug。我们要量的是渐变完的终态。
const CONTRAST_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><style>" + INDEX_CSS
  + "</style><style>*{transition:none!important;animation:none!important}</style><body>"
  + "<div class='side-nav'>"
  + "  <div class='item active'><span class='tx'><span>项目</span><span class='sub' id='c-sub'>专家 · 技能</span></span></div>"
  + "  <div class='nav-head item active'><span>我的项目</span><a id='proj-add' href='#'>+</a></div>"
  + "</div>"
  + "<p id='c-bare'>装法见 <a href='https://example.invalid'>example.invalid</a></p>"
  // 这一坨是给「点得着 + 勾选框没被撑坏」那组用的，摆位尽量照抄真界面
  + "<div class='m-body' style='width:520px'>"
  + "  <div class='m-head'><h3>标题</h3><button class='m-close' id='c-mclose'><svg class='i'></svg></button></div>"
  + "  <label style='cursor:pointer'><input type='checkbox' id='c-chk'> 开启积分限额</label>"
  + "  <input type='text' id='c-text' value='这是普通文本框，它必须还是整行宽'>"
  + "</div>"
  + "<div class='mrow'><input type='radio' name='active' id='c-radio'><span class='mrow-name'>某个模型</span></div>"
  + "<div><button class='row-more' id='c-more'><svg class='i'></svg></button></div>"
  + "<div class='ui-card' style='padding:12px'><span class='ch-warn' id='c-warn'>未填 Key</span></div>"
  + "</body>";
const CONTRAST_CHECKS = FLUSH_SRC + `
(() => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + JSON.stringify(extra) : "")); names.push(n); };
  const rgb = (c) => (String(c).match(/[\\d.]+/g) || [0, 0, 0]).map(Number);
  const lum = (c) => { const m = rgb(c); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const mix = (fg, bg, a) => { const f = rgb(fg), b = rgb(bg); return "rgb(" + [0,1,2].map((i) => Math.round(f[i] * a + b[i] * (1 - a))).join(", ") + ")"; };
  /** 往上找第一层真有颜色的底（transparent / alpha 0 的一律穿过去） */
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const m = rgb(c);
      if (c && c !== "transparent" && !(m.length === 4 && m[3] === 0)) return c;
    }
    return getComputedStyle(document.body).backgroundColor || "rgb(255, 255, 255)";
  };
  /** 一路把祖先的 opacity 乘起来：opacity 不进 computed color，但眼睛看得见 */
  const alphaOf = (el) => { let a = 1; for (let n = el; n && n !== document.documentElement; n = n.parentElement) a *= parseFloat(getComputedStyle(n).opacity || "1"); return a; };
  const ratioOf = (el) => {
    const bg = bgOf(el);
    const fg = mix(getComputedStyle(el).color, bg, alphaOf(el));
    const la = lum(fg), lb = lum(bg);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const SPOTS = [
    ["side-nav 选中行的副标题", "#c-sub"],
    ["项目表头那颗 ＋", "#proj-add"],
    ["正文里没带 class 的链接", "#c-bare a"],
    ["卡片上 12px 的警告小字", "#c-warn"],
  ];
  const sweep = () => SPOTS.map(([label, sel]) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error("夹具里找不到 " + sel + "：markup 和真界面对不上了");
    return [label, Math.round(ratioOf(el) * 100) / 100];
  });

  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme; flush();
    for (const [label, r] of sweep()) ok(theme + "：" + label + " 压住底色 " + r.toFixed(2) + " ≥ 4.5", r >= 4.5, r);
  }

  // ---- 反向对照：把这三条改回修之前的写法，三处必须当场跌破 4.5 ----
  const undo = document.createElement("style");
  undo.textContent = ".side-nav .item.active .tx .sub { opacity: .82; }"
    + " .side-nav .nav-head #proj-add { color: var(--owb-text-3); }"
    + " a:not([class]) { color: -webkit-link; }"
    + " :root { --warning: #b26a00; }";
  document.head.appendChild(undo); flush();
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme; flush();
    const bad = sweep().filter(([, r]) => r < 4.5).map(([l]) => l);
    if (theme === "dark") ok("反向对照·暗色：那三处全跌破 4.5（警告色暗底上本来就够）", bad.length === 3, sweep());
    else ok("反向对照·浅色：副标题和警告小字两条跌破 4.5（另两条本来浅底上就够）",
      bad.includes("side-nav 选中行的副标题") && bad.includes("卡片上 12px 的警告小字"), sweep());
  }
  undo.remove(); flush();
  document.documentElement.dataset.theme = "light"; flush();
  ok("撤掉对照样式之后四处又都回到 4.5 以上", sweep().every(([, r]) => r >= 4.5), sweep());

  // ---- 点得着：能点的东西至少 24×24 ----
  // 这几个当初都是「凑合能点」：弹窗的关闭键 14×22（一个 ✕ 字符的宽度），
  // 行尾的「更多」20×16，侧栏那颗 ＋ 23×21。鼠标得瞄准才点得中。
  const box = (sel) => { const el = document.querySelector(sel);
    if (!el) throw new Error("夹具里找不到 " + sel + "：markup 和真界面对不上了");
    const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const HITS = [["弹窗关闭键", "#c-mclose"], ["行尾的更多", "#c-more"], ["项目表头那颗 ＋", "#proj-add"]];
  for (const [label, sel] of HITS) {
    const [w, h] = box(sel);
    ok(label + " 点得着 " + w + "×" + h + " ≥ 24×24", w >= 24 && h >= 24, [w, h]);
  }
  // ★反向对照★ 把三条尺寸改回原来的写法，必须当场全部跌回 24 以下
  const shrink = document.createElement("style");
  shrink.textContent = ".m-close { width: auto; height: auto; padding: 0; font-size: 18px; }"
    + " .row-more { width: auto; height: auto; padding: 2px 4px; line-height: 0; }"
    + " .side-nav .nav-head #proj-add { width: auto; height: auto; padding: 0 4px; }";
  document.head.appendChild(shrink); flush();
  const shrunk = HITS.filter(([, sel]) => { const [w, h] = box(sel); return w < 24 || h < 24; }).map(([l]) => l);
  ok("反向对照：改回旧写法，三个热区全跌回 24 以下", shrunk.length === 3, shrunk);
  shrink.remove(); flush();

  // ---- 勾选框别被 .m-body input{width:100%} 一起扫走 ----
  // 账号弹窗里「开启积分限额」那个勾选框实测被撑成 850×13，还套了边框和 8px 内边距。
  // 这条同时钉住另一半：文本框必须还是整行宽，别为了修勾选框把输入框一起收窄了。
  for (const [label, sel] of [["弹窗里的勾选框", "#c-chk"], ["模型行里的单选框", "#c-radio"]]) {
    const [w, h] = box(sel);
    ok(label + " 是 " + w + "×" + h + " 的方块，没被撑成整行", w === 16 && h === 16, [w, h]);
  }
  // 「整行宽」是相对它所在那一行说的，不是某个魔法像素。这里原来写死 >400，结果
  // 给 .m-body 补上 scrollbar-gutter:stable（滚动条留位，省得内容随长短横跳）之后，
  // 这行少了 11px，405→394，测试当场变红——可文本框其实还是满宽的，红得没道理。
  // 所以改成量真事：填满内容区（弹窗宽度减掉左右内边距）。
  const rowW = () => {
    const b = document.querySelector(".m-body"), s = getComputedStyle(b);
    return Math.round(b.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight));
  };
  ok("同一个弹窗里的文本框仍然是整行宽（修勾选框没误伤它）", box("#c-text")[0] >= rowW() - 1, [box("#c-text")[0], rowW()]);
  // ★反向对照★ 用更高特异度把 .m-body input{width:100%} 那条重新压回勾选框上——
  // 也就是修之前的真实状态，勾选框必须当场被撑成整行。
  // （不能写 width:revert 来「撤掉」统一规则：revert 会连 .m-body 那条作者样式一起退掉，
  //   量到的是浏览器默认的 13px，反倒证明不了 bug 存在过。）
  const bleed = document.createElement("style");
  bleed.textContent = ".m-body input#c-chk { width: 100%; padding: 8px 10px; }";
  document.head.appendChild(bleed); flush();
  ok("反向对照：把 width:100% 重新压回勾选框，它当场被撑成整行", box("#c-chk")[0] >= rowW() - 1, [box("#c-chk")[0], rowW()]);
  bleed.remove(); flush();

  return names;
})()
`;

// ---- 长串不许顶穿边框（真量宽度，不是看源码里写没写） ----
// 前两次都是「在出事的那一处补一句 overflow-wrap」，补完下一处照犯——因为看的是源码，
// 而这毛病只有等浏览器真排完版才看得见：一条没有空格的网址把所在的盒子顶穿，
// 右边的字被切掉，或者整页横着多出一条滚动条。
// 这一段换个打法：把两份真 CSS 里**每一条规则**的选择器还原成真实节点，往最里面那层塞一条
// 200 字符、一个空格都没有的网址（就用用户贴来的那条），再量它的字有没有漏到边框外面。
// 判据是 scrollWidth > clientWidth 且自己和祖先都没在裁——裁掉并打省略号是故意的，不算漏。
// 三类不算漏，各有判据，不是拍脑袋豁免：
//   · white-space:pre 的块是代码/命令，外面本来就套着横向滚动容器，顶出去是设计；
//   · 固定尺寸的装饰件（圆点、图标、转圈、分隔线）——判据是「空着和塞满一样宽」，跟内容无关；
//   · ALLOW 里那十来个不换行的小标签，装的是固定词或数字，每条都写了理由。
//     真装动态文本的（文件名、标题、备注）一个都不在里面——它们要么会换行，要么自己裁了。
const OVF_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS
  + "</style><body><div id='stage'></div></body>";
const OVF_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const TOK = "xiaohongshu.com/user/profile/5c4ac98a0000000012037eeb?channel_type=web_search_result_notes&xsec_token=ABuBhG90qX7bc28yf1WETF6cMjdnIgCthGTLH";
  // 装的是固定词或数字，不会因为谁起了个长名字而变长。键是选择器里必然出现的那一截。
  const ALLOW = {
    "lane-tabs button": "工作线就服务端给的那两条（办公 / 工程），名字是内置的",
    "ev-fb-down a": "固定文案「打开对话」；同一行里真装标题和理由的 .task/.note 自己裁了并打省略号",
    "tp-cost": "追踪行的费用数字", "tp-pill": "追踪状态，固定词", "tp-kind": "追踪类型，固定词（工具/模型/子代理）",
    ".at-row .st": "自动化那行右边的状态角标，固定词",
    "ch-count": "渠道条数", "mrow-meta": "模型行的条数与时间", "out-meta": "产出卡上的文件体积",
    "ev-lv": "评测等级，固定词", "ev-code": "评测错误码", "drama-scene-count": "分镜条数",
  };
  const stage = document.getElementById("stage");
  stage.style.cssText = "width:420px;padding:0;border:0";
  const SKIP = /::|:hover|:focus|:active|:checked|:disabled|:where|:is\\(|:not\\(|:has\\(|:nth|:empty|:target|input|textarea|select|svg|img|canvas|video|audio/i;

  // 把一条选择器还原成真实节点链，塞进 TOK，回报它漏出去多少像素（不漏回 0）
  const leakOf = (sel) => {
    const chain = sel.split(/\\s*[>+~]\\s*|\\s+/).filter(Boolean);
    if (!chain.length || chain.length > 4) return 0;
    let root = null, cur = null;
    for (const part of chain) {
      const tagM = part.match(/^([a-z][a-z0-9]*)/i);
      const idM = part.match(/#([\\w-]+)/);
      // 一截里连标签名、类、id、属性都没有（:root 这种纯伪类），还原出来就是个裸 div，
      // 量到的是 div 的默认行为、不是任何一条真样式——整条跳过，别拿它凑数
      if (!tagM && !idM && !/[.\\[]/.test(part)) return 0;
      const tag = tagM ? tagM[1] : "div";
      if (/^(html|body|head)$/i.test(tag)) continue;
      const el = document.createElement(tag);
      if (idM) el.id = idM[1];
      for (const c of part.matchAll(/\\.([\\w-]+)/g)) el.classList.add(c[1]);
      for (const a of part.matchAll(/\\[([\\w-]+)(?:[~|^$*]?=["']?([^\\]"']*)["']?)?\\]/g)) { try { el.setAttribute(a[1], a[2] == null ? "" : a[2]); } catch (e) {} }
      if (!root) { root = el; cur = el; } else { cur.appendChild(el); cur = el; }
    }
    if (!root || !cur) return 0;
    stage.appendChild(root);
    let leak = 0;
    try {
      const empty = cur.clientWidth;             // 空着多宽：见下面 decor
      cur.textContent = TOK;
      const cs = getComputedStyle(cur);
      const w = cur.clientWidth, sw = cur.scrollWidth;
      let clipped = cs.overflowX !== "visible";
      for (let a = cur.parentElement; a && a !== stage && !clipped; a = a.parentElement)
        if (getComputedStyle(a).overflowX !== "visible") clipped = true;
      // 固定尺寸的装饰件（圆点、图标、转圈、分隔线）：空着和塞满一样宽，且本来就只有几十像素。
      // 「一样宽」这条单独用不行——块级元素空着也占满整行，那会把 .tp-pill 这类真该量的全放走。
      const decor = empty > 0 && empty === w && w < 60;
      if (cs.whiteSpace !== "pre" && !clipped && !decor && w > 0 && sw > w + 1) leak = sw - w;
    } finally { stage.removeChild(root); }
    return leak;
  };

  const sels = new Set();
  const walk = (rules) => { for (const r of rules) {
    if (r.cssRules && r.cssRules.length) walk(r.cssRules);   // 现在的 CSSStyleRule 也有 cssRules（嵌套），先递归再看自己
    if (!r.selectorText) continue;
    for (const one of r.selectorText.split(",")) sels.add(one.trim());
  } };
  for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) {} }
  ok("两份真 CSS 都挂上了（规则 1500 条以上，不是空跑）", sels.size > 1500, "只扫到 " + sels.size + " 条选择器");

  const sweep = () => {
    const out = [];
    for (const sel of sels) {
      if (SKIP.test(sel)) continue;
      const leak = leakOf(sel);
      if (leak) out.push({ sel, leak });
    }
    return out;
  };

  const leaks = sweep();
  const unexplained = leaks.filter((x) => !Object.keys(ALLOW).some((k) => x.sel.includes(k)));
  ok("整份界面：塞一条 200 字符的长网址，没有一处把字漏到边框外面",
    unexplained.length === 0,
    unexplained.slice(0, 8).map((x) => x.sel + " 漏 " + x.leak + "px").join(" · ")
      + (unexplained.length > 8 ? " …共 " + unexplained.length + " 处" : ""));

  // 兜底真的在，而且真的是它在挡：把 :root 上那句关掉，漏的应该当场多出一大片。
  // 不做这条反向对照的话，上面那个「0 处」有可能只是探针自己瞎了。
  ok("兜底那句在（:root 上继承下来的 overflow-wrap:anywhere）",
    getComputedStyle(document.documentElement).overflowWrap === "anywhere",
    "现在是 " + getComputedStyle(document.documentElement).overflowWrap);
  document.documentElement.style.overflowWrap = "normal";
  const without = sweep();
  document.documentElement.style.overflowWrap = "";
  ok("反向对照：撤掉兜底立刻漏一大片（证明这条闸门不是摆设，也证明挡住的是它）",
    without.length > leaks.length + 100,
    "撤掉之后只漏 " + without.length + " 处，原来 " + leaks.length + " 处——差得太少，探针八成没在量真东西");
  const MUST = ["h1", "h2", "ui-stat", "ev-fb-card"];   // 大标题 / 小标题 / 统计数值 / 评测卡：真装长文本的四处
  const missed = MUST.filter((k) => !without.some((x) => x.sel.includes(k)));
  ok("反向对照：撤掉兜底时，预览页的大标题、追踪行的结果、统计数值这些真装长文本的地方首当其冲",
    missed.length === 0,
    "撤掉兜底之后这几处居然还不漏：" + missed.join(" / ") + "（一共漏了 " + without.length + " 处）");
  ok("反向对照：塞短词不该报漏（探针不是见谁都判红）",
    (() => { const el = document.createElement("div"); el.className = "tp-rst"; el.textContent = "好"; stage.appendChild(el);
             const bad = el.scrollWidth > el.clientWidth + 1; stage.removeChild(el); return !bad; })(),
    "一个「好」字都被判成漏出边框了");
  return names;
})()`;

// ================= 引用一条回复 / 从资料库跳回那一轮 =================
// 和
// 这两件事都只在真 DOM 里才成立，所以放在同一屏里跑：
// ① 引用取的是**渲染后的正文**（innerText），过程卡片、按钮条、token 统计一个字都不许带进去；
//    光标落在别的回复里时不许把那截字引到这条底下来——这是最容易写漏的一条，
//    而且写漏了在界面上看着完全正常（你选了字、按了引用、确实引进来了，只是引错了人）。
// ② 跳转跳不过去要**认输**（返回 false），让调用点退回「把对话滚到底」这个老行为。
//    硬跳的话人会落在一段跟他点的那份文件毫不相干的话上，比没跳更像功能坏了。
// ③ 高亮得是**量出来的**：只验 class 的话，把 .turn-jumped 那条 CSS 删了测试照样全绿，
//    用户那边则是「页面动了一下，不知道该看哪儿」。
const QT0 = APP02X.indexOf("/**\n * 引用一条回复去追问。");
const QT1 = APP02X.indexOf("// ================= 回合渲染（实时流式与历史回放共用） =================");
if (QT0 < 0 || QT1 <= QT0) throw new Error("app-01.js 里的「引用回复」那段找不到了（函数改名/挪窝了？），前端测试没法定位真源码");
const QUOTE_SRC = APP02X.slice(QT0, QT1);
if (!/function quoteReply\(/.test(QUOTE_SRC)) throw new Error("切出来的那段里没有 quoteReply——引用这一半没被测到");

const JP0 = APP02.indexOf("/**\n * 滚到第 n 个回合并让它亮一下");
const JP1 = APP02.indexOf("/**\n * 打开一个会话并回放它的对话");
if (JP0 < 0 || JP1 <= JP0) throw new Error("app-02.js 里的 jumpToTurn 那段找不到了（函数改名/挪窝了？），前端测试没法定位真源码");
const JUMP_SRC = APP02.slice(JP0, JP1);

// 按钮本身长在 createTurnUI 里面（闭包，切不出来单跑），但「按钮在不在、连没连上」
// 是会被一次手滑改没的——补一道源码层的闸，图标名也一起核，免得画出个空框框
{
  const B0 = APP02X.indexOf("  function addActionsBar() {");
  const B1 = APP02X.indexOf("// ================= 空状态（场景 tab + 分类胶囊）", B0);
  if (B0 < 0 || B1 <= B0) throw new Error("app-01.js 里的回复操作条那段找不到了（函数改名/挪窝了？），前端测试没法核按钮");
  const bar = APP02X.slice(B0, B1);
  if (!/data-a="quote"/.test(bar)) throw new Error("回复操作条上没有「引用」按钮了：用户要的那一下按不着");
  if (!/\[data-a=quote\]"\)\.onclick\s*=\s*\(\)\s*=>\s*quoteReply\(turn\)/.test(bar)) throw new Error("「引用」按钮没接到 quoteReply 上：画得出来、按下去没反应");
  const sprite = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const n of ["text-quote", "message-square"]) {
    if (!sprite.includes('<symbol id="i-' + n + '"')) throw new Error("图标 " + n + " 不在 index.html 的雪碧图里：ic() 会画出一个空框框，界面上看不出报错");
  }
}

const QUOTE_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style>"
  + "<body style='margin:0;width:760px'>"
  + "<div id='chat-col' style='height:300px;overflow:auto'></div>"
  + "<textarea id='composer'></textarea></body>";
const QUOTE_STUBS = `
const chatCol = document.getElementById("chat-col");
const inputEl = document.getElementById("composer");
window.TOASTS = [];
function toast(m) { window.TOASTS.push(String(m)); }
`;
const QUOTE_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };

  // 照 createTurnUI 的结构搭一条回复：正文在 .body > .a-text，
  // 过程卡片和按钮条也是 .body 的孩子——它们恰恰是**不该**被引进来的那部分
  const mkTurn = (texts, extra) => {
    const t = document.createElement("div");
    t.className = "turn";
    const b = document.createElement("div");
    b.className = "body";
    for (const x of texts) {
      const a = document.createElement("div");
      a.className = "a-text";
      a.textContent = x;
      b.appendChild(a);
    }
    if (extra) b.insertAdjacentHTML("beforeend", extra);
    t.appendChild(b);
    chatCol.appendChild(t);
    return t;
  };

  // ---------- 引用 ----------
  const noise = "<div class='proc'>正在读取 周报.md</div><div class='turn-actions'><button>复制</button></div>";
  const t1 = mkTurn(["这一版周报分三块：", "第二块的数字我拿的是上周的，你确认下。"], noise);

  inputEl.value = "";
  quoteReply(t1);
  ok("引用塞进输入框（而不是挂一枚改不了的标签）", inputEl.value.includes("> 这一版周报分三块："), JSON.stringify(inputEl.value));
  ok("整条正文都引进来了，不是只引第一段", inputEl.value.includes("> 第二块的数字我拿的是上周的，你确认下。"), JSON.stringify(inputEl.value));
  ok("过程卡片和按钮条一个字都没带进来", !/正在读取|复制/.test(inputEl.value), JSON.stringify(inputEl.value));
  ok("引用尾部留了空行，人接着往下写就行", /\\n\\n$/.test(inputEl.value), JSON.stringify(inputEl.value.slice(-6)));
  ok("光标落在末尾（不是把人甩到开头去接着打字）", inputEl.selectionStart === inputEl.value.length);

  // 已经写了半句话：接在后面，不许冲掉
  inputEl.value = "帮我改一下";
  quoteReply(t1);
  ok("输入框里写了一半的话没被冲掉", inputEl.value.startsWith("帮我改一下"), JSON.stringify(inputEl.value));
  ok("接在半句话后面时空了一行，不糊成一坨", inputEl.value.includes("帮我改一下\\n\\n> "), JSON.stringify(inputEl.value));

  // 连按两下：不许引两遍
  const before = inputEl.value;
  window.TOASTS = [];
  quoteReply(t1);
  ok("同一段不会被引进来两遍", inputEl.value === before, JSON.stringify(inputEl.value));
  ok("重复引用要说一声，不是默默什么都不做", window.TOASTS.length === 1, JSON.stringify(window.TOASTS));

  // 选中了一截：只引那一截。
  // 先 blur：真实顺序就是「在回复里拖选一段」（输入框因此失焦）→「按引用」。
  // 输入框还叼着焦点的时候，Chrome 的 document selection 归输入框管，外面这一段选不上——
  // 不 blur 的话这一条会静默退回「整段引用」，看着像功能坏了，其实是夹具没摆对
  const t2 = mkTurn(["前面这段没问题。", "但是这句数字不对。", "后面这段也没问题。"]);
  const sel = window.getSelection();
  const target = t2.querySelectorAll(".a-text")[1];
  const pick = () => {
    inputEl.blur();
    const r = document.createRange();
    r.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(r);
  };
  pick();
  ok("夹具自检：选区真的选上了（选不上的话下面两条等于什么都没测）",
     !sel.isCollapsed && String(sel).includes("但是这句数字不对。"), JSON.stringify([sel.isCollapsed, String(sel)]));
  inputEl.value = "";
  quoteReply(t2);
  ok("选中了就只引选中的那截（一条回复好几屏，整段引过去等于什么都没指）",
     inputEl.value.includes("但是这句数字不对。") && !inputEl.value.includes("前面这段没问题。"), JSON.stringify(inputEl.value));

  // 反向对照：选区停在**别的**回复里。不加这道判断的话，
  // 在 t2 里选的字会被引到 t1 底下来——界面上看着完全正常，引的却是别人的话
  pick(); // 选区还在 t2 上，这一回按的却是 t1 的引用
  inputEl.value = "";
  quoteReply(t1);
  ok("在别处选中的字不会被引到这一条底下来（选区得落在这条回复里才算数）",
     inputEl.value.includes("这一版周报分三块：") && !inputEl.value.includes("但是这句数字不对。"), JSON.stringify(inputEl.value));
  sel.removeAllRanges();

  // 太长的截断。再长就不是「引用」而是「复述」，模型也会被这一大坨带偏
  const long = "很".repeat(900);
  const t3 = mkTurn([long]);
  inputEl.value = "";
  quoteReply(t3);
  ok("超长回复会被截断，不是整屏搬进输入框", inputEl.value.length < 500, inputEl.value.length + " 字");
  ok("截断了要留个省略号，别让人以为它就说了这么多", inputEl.value.includes("…"), JSON.stringify(inputEl.value.slice(-8)));

  // 多行正文：每一行都得是引用行，否则第二行往后在 markdown 里会掉出引用块。
  // 这里搭的是**渲染后**的样子（markdown 渲染出来是一串 <p>），不是塞一个带 \\n 的 textContent
  // ——后者在普通 div 里根本不换行，测出来的是假的
  inputEl.value = "";
  const t4 = mkTurn([]);
  t4.querySelector(".body").innerHTML = "<div class='a-text'><p>第一行</p><p>第二行</p><p>第三行</p></div>";
  quoteReply(t4);
  ok("多行正文每一行都带 >（漏一行，后面几行就掉出引用块了）",
     (inputEl.value.match(/^> /gm) || []).length >= 3, JSON.stringify(inputEl.value));

  // 空回复：说一声，不许往输入框里塞一个空的 ">"
  const t5 = mkTurn([]);
  inputEl.value = "";
  window.TOASTS = [];
  quoteReply(t5);
  ok("没有正文可引的时候说一声，不往输入框里塞一个空的 >", inputEl.value === "" && window.TOASTS.length === 1, JSON.stringify([inputEl.value, window.TOASTS]));

  // ---------- 从资料库跳回那一轮 ----------
  chatCol.innerHTML = "";
  const turns = [];
  for (let i = 0; i < 6; i++) {
    const t = document.createElement("div");
    t.className = "turn";
    t.style.height = "200px";
    t.textContent = "第 " + (i + 1) + " 轮";
    chatCol.appendChild(t);
    turns.push(t);
  }
  chatCol.scrollTop = 0;

  ok("跳得过去就说跳过去了", jumpToTurn(3) === true);
  ok("跳到的是第 4 轮那一块，不是别的哪一块", turns[3].classList.contains("turn-jumped"), turns.findIndex((t) => t.classList.contains("turn-jumped")));
  ok("别的回合没被一起点亮", turns.filter((t) => t.classList.contains("turn-jumped")).length === 1);

  // 高亮得量得出来：只验 class 的话，把那条 CSS 删了这一屏照样全绿。
  // 认的是 owbTurnFound 这个名字而不是「有没有动画」——.turn 本来就带一个入场动画（owbRise），
  // 拿「!== none」当判据的话，这条和下面那条反向对照会同时被它顶成绿的
  ok("夹具自检：这一遍不是 reduce 档（不然下面量到的 none 是系统设置，不是代码的事）",
     !matchMedia("(prefers-reduced-motion: reduce)").matches);
  const anim = getComputedStyle(turns[3]).animationName;
  ok("高亮是真画出来的（量出 owbTurnFound 真挂上了，不是只认一个 class）", /owbTurnFound/.test(anim), JSON.stringify(anim));
  const plain = getComputedStyle(turns[4]).animationName;
  ok("反向对照：没被跳中的回合不该有这层高亮", !/owbTurnFound/.test(plain), JSON.stringify(plain));
  // 高亮画在盒子外面，但不许把盒子撑大——撑大了对话列就多一条横向滚动条。
  // 这正是 ::before 那版栽的地方：往外 inset 12px，scrollWidth 就跟着多 12px
  ok("高亮不许把这一轮撑宽（否则对话列多出一条横滚动条）",
     turns[3].scrollWidth <= turns[3].clientWidth + 1, turns[3].scrollWidth + " > " + turns[3].clientWidth);

  // 跳不过去要认输，交回给调用点去滚到底
  ok("回合号越界就认输（老会话记录被裁过，跳不过去是常态）", jumpToTurn(99) === false);
  ok("认输的那一下不许顺手把别人的高亮擦了", turns[3].classList.contains("turn-jumped"));
  ok("一条对话都没有时也认输，不炸", (() => { const keep = chatCol.innerHTML; chatCol.innerHTML = ""; const v = jumpToTurn(0); chatCol.innerHTML = keep; return v === false; })());

  return names;
})()
`;
// 再跑一小段，这次把系统的「减弱动态效果」打开。index.html 里有一条全局的
// animation-duration:.01ms !important —— 它会让 owbTurnFound 瞬间走到最后一帧，
// 而最后一帧是透明的。于是「跳过去之后高亮一下」在 reduce 档下等于什么都没发生，
// 偏偏这批人才是最需要「告诉我该看哪儿」的。本机默认不是 reduce，不单独跑一遍就永远测不到。
const JUMP_REDUCE_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  ok("夹具自检：这一遍真的是 reduce 档", matchMedia("(prefers-reduced-motion: reduce)").matches);
  const t = document.createElement("div");
  t.className = "turn";
  t.style.height = "200px";
  chatCol.appendChild(t);
  ok("跳得过去", jumpToTurn(0) === true);
  const cs = getComputedStyle(t);
  ok("reduce 档下不放动画（放了也是瞬间走完，最后一帧还是透明的）", cs.animationName === "none", JSON.stringify(cs.animationName));
  const bg = cs.backgroundColor;
  ok("但底色得真摆上：高亮不是锦上添花，是「你落在这儿」的唯一提示",
     bg && bg !== "transparent" && !/rgba\\(0, 0, 0, 0\\)/.test(bg), JSON.stringify(bg));
  ok("外圈也铺出去了（跟正常档一个观感）", /10px/.test(cs.boxShadow), JSON.stringify(cs.boxShadow));
  t.classList.remove("turn-jumped");
  ok("反向对照：摘掉 class 底色就退干净（不然 2.6 秒之后这一轮永远是高亮的）",
     /rgba\\(0, 0, 0, 0\\)|transparent/.test(getComputedStyle(t).backgroundColor), JSON.stringify(getComputedStyle(t).backgroundColor));
  return names;
})()
`;

// ---- 无限画布：多选选得出来，Delete / ⌘A / Escape 也得真按得动 ----
// canvasState.keyHandler 挂在 #assist-page 上。可点完节点、点完空白，activeElement 一直是
// <body>——body 是 #assist-page 的祖先，keydown 压根不经过它。线上表现就是：框选框得出来、
// 选中也高亮着，按 Delete 没反应、⌘A 没反应、Escape 退不出框选，看着像多选根本没做（0.6.4 的真实症状）。
// 所以这一屏先盯「焦点收没收上来」，后面那几个键才有意义。
const APP07 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
const CK0 = APP07.indexOf('page.setAttribute("tabindex", "-1");');
const CK1 = APP07.indexOf('page.addEventListener("keyup", canvasState.keyUpHandler);');
if (CK0 < 0 || CK1 <= CK0) throw new Error("app-07-canvas.js 里 canvasBindViewport 的键盘那一段找不到了，前端测试没法定位真源码");
const CANVASKEY_SRC = "function bindCanvasKeys(page, viewport) {\n"
  + APP07.slice(CK0, CK1) + 'page.addEventListener("keyup", canvasState.keyUpHandler);\n}';
const CANVASKEY_HTML = "<!doctype html><meta charset='utf-8'><body>"
  + "<div class='assist-page canvas-page' id='assist-page'>"
  +   "<button data-canvas-marquee class='is-active' id='marquee'>框选</button>"
  +   "<div class='canvas-viewport is-marquee' id='canvas-viewport'>"
  +     "<div class='canvas-joint-node' id='n1'><header class='canvas-node-head'><span id='head1'>阿明</span><button id='regen'>重生成定妆照</button></header></div>"
  +     "<textarea id='note'></textarea>"
  +   "</div>"
  + "</div></body>";
const CANVASKEY_STUBS = `
const REMOVED = [];
const mkNode = (id) => ({ id, remove() { REMOVED.push(id); } });
const NODES = [mkNode("n_c1"), mkNode("n_c2"), mkNode("n_s1")];
const canvasState = { selectedIds: new Set(), selected: null, selectedAll: false, marqueeMode: true, spacePanning: false,
  graph: { getElements: () => NODES.filter((n) => !REMOVED.includes(n.id)) } };
let PERSIST = 0, INSPECT = 0, UNDO = 0, REDO = 0; const TOASTS = [];
function canvasSetSelection(ids) { canvasState.selectedIds = new Set(ids); canvasState.selected = [...canvasState.selectedIds][0] || null; }
function canvasRenderInspector() { INSPECT++; }
function canvasPersist() { PERSIST++; }
function canvasToast(msg) { TOASTS.push(String(msg)); }
function canvasUndo() { UNDO++; }
function canvasRedo() { REDO++; }
`;
const CANVASKEY_CHECKS = `(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + extra : "")); names.push(n); };
  const page = document.getElementById("assist-page"), vp = document.getElementById("canvas-viewport");
  const down = (el) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  const key = (o) => { const e = new KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, o)); document.activeElement.dispatchEvent(e); return e; };
  const up = (o) => document.activeElement.dispatchEvent(new KeyboardEvent("keyup", Object.assign({ bubbles: true }, o)));
  const who = () => document.activeElement.tagName + (document.activeElement.id ? "#" + document.activeElement.id : "");
  bindCanvasKeys(page, vp);

  ok("画布自己能当焦点（tabindex=-1：鼠标点得到，Tab 键不会多停一站）", page.getAttribute("tabindex") === "-1", JSON.stringify(page.getAttribute("tabindex")));
  ok("先验料：还没点的时候焦点在 body 上，keydown 不经过画布", document.activeElement === document.body, who());

  down(document.getElementById("head1"));
  ok("★点一下节点，焦点就收到画布上★ 收不上来的话下面这些键全是哑的", document.activeElement === page, who());

  // Escape 是多选之后的出口。没有它只能去点别的节点，那又变成选中了那一个
  canvasSetSelection(["n_c1", "n_c2"]);
  const esc = key({ key: "Escape" });
  ok("Escape 清空选中", canvasState.selectedIds.size === 0, canvasState.selectedIds.size);
  ok("Escape 同时退出框选模式（光清选中不退模式，鼠标还是框不动画布）", canvasState.marqueeMode === false);
  ok("框选按钮的按下态跟着落下去", !document.getElementById("marquee").classList.contains("is-active"));
  ok("视口的 is-marquee 也摘掉（不摘光标一直是十字，画布拖不动）", !vp.classList.contains("is-marquee"));
  ok("Escape 吃掉默认行为（别顺手退了全屏）", esc.defaultPrevented);

  key({ key: "a", metaKey: true });
  ok("⌘A 选中画布上全部节点", canvasState.selectedIds.size === 3, canvasState.selectedIds.size);
  ok("提示里报出个数，顺带说下一步按 Delete", /已全选 3 个节点/.test(TOASTS[TOASTS.length - 1] || ""), JSON.stringify(TOASTS[TOASTS.length - 1]));

  key({ key: "z", metaKey: true });
  ok("⌘Z 撤销", UNDO === 1 && REDO === 0, "UNDO=" + UNDO + " REDO=" + REDO);
  key({ key: "z", metaKey: true, shiftKey: true });
  ok("⌘⇧Z 重做", REDO === 1, REDO);
  key({ key: "y", ctrlKey: true });
  ok("Ctrl+Y 也是重做（Windows 上的手势）", REDO === 2, REDO);

  key({ code: "Space", key: " " });
  ok("按住空格进平移态", canvasState.spacePanning === true);
  up({ code: "Space", key: " " });
  ok("松开就退出来（退不出来之后点哪儿都在拖画布）", canvasState.spacePanning === false);

  canvasSetSelection(["n_c1", "n_s1"]);
  const del = key({ key: "Delete" });
  ok("Delete 把选中的那几个一起删掉，不是只删一个", REMOVED.join() === "n_c1,n_s1", JSON.stringify(REMOVED));
  ok("删完清空选中，右侧检查器跟着重画", canvasState.selectedIds.size === 0 && canvasState.selected === null && INSPECT === 1, "INSPECT=" + INSPECT);
  ok("并且立刻落盘（不落盘刷新一下节点又回来了）", PERSIST === 1, PERSIST);
  ok("Delete 吃掉默认行为（别触发浏览器后退）", del.defaultPrevented);
  canvasSetSelection(["n_c2"]);
  key({ key: "Backspace" });
  ok("Backspace 同理（Mac 上删键就是它）", REMOVED.join() === "n_c1,n_s1,n_c2", JSON.stringify(REMOVED));

  const note = document.getElementById("note");
  note.focus();
  canvasSetSelection(["n_c1"]);
  key({ key: "Delete" });
  ok("★正在输入框里打字，Delete 只删字，不删节点★", REMOVED.length === 3 && canvasState.selectedIds.size === 1, JSON.stringify(REMOVED));
  const a2 = key({ key: "a", metaKey: true });
  ok("输入框里的 ⌘A 还是全选文字，不是全选节点", !a2.defaultPrevented && canvasState.selectedIds.size === 1);

  note.blur();
  ok("先验料：焦点已经挪走了", document.activeElement !== page, who());
  down(document.getElementById("regen"));
  ok("点节点上的按钮，焦点留给按钮自己（抢过来的话按钮的回车/空格就废了）", document.activeElement !== page, who());
  down(vp);
  ok("反向对照：点画布空白处照样收焦点", document.activeElement === page, who());
  return names;
})()`;


// ================= 关着的侧滑面板，不该还留在 Tab 序里 =================
// 起因是拿 Tab 键把真界面从头走一遍：390×844 上 29 个能聚焦的元素里有 8 个整个在屏幕外，
// 位置就排在「模式」按钮后面——预览面板的复制 / 系统提示 / 重看 / 下载 / 关闭，加上成果文件
// 面板的「打开文件夹」「整理文件夹」「关闭」。1440×900 是 44 个里的 10 个（多两根拖宽的把手）。
// 成果文件面板里再装 40 个文件，数字变成 85 里的 51：键盘用户一路 Tab 会掉进一片看不见的地方，
// 焦点框停在屏幕外，按回车不知道按到了什么；读屏软件也照样念得出来。
// 根因是这两块关着的时候只有 width:0 + overflow:hidden —— 人眼看不见，可访问性树里还在。
// 补法是关着时整块 visibility:hidden（这一条浏览器认，被它藏起来的东西不进 Tab 序），
// 但收起的动画不能因此变生硬，所以熄灯延迟到宽度收完那一刻：visibility 0s linear var(--owb-t-slow)。
// 真 markup + 真 CSS 一起切进来：只验结构的话，把那两条 visibility 删掉这一屏照样全绿。
const PANEL_MARKUP = (() => {
  const one = (startTag) => {
    const a = INDEX_SRC.indexOf(startTag);
    if (a < 0) throw new Error("public/index.html 里找不到 " + startTag + "，面板这一屏没法用真 markup");
    const re = /<(\/?)div\b[^>]*>/g;
    re.lastIndex = a + startTag.length;
    let depth = 1, m;
    while ((m = re.exec(INDEX_SRC))) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) return INDEX_SRC.slice(a, m.index + m[0].length);
    }
    throw new Error(startTag + " 没有配对的 </div>，切不出整块面板");
  };
  return one('<div class="preview-panel" id="preview-panel">') + "\n" + one('<div class="files-panel" id="files-panel">');
})();
const PANELVIS_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS
  + "\nhtml,body{height:100%}body{margin:0;display:flex}</style><body>" + PANEL_MARKUP + "</body>";
const PANELVIS_CHECKS = `
(async () => {
  const names = [], fails = [];
  const ok = (name, cond, extra) => { if (cond) { names.push(name); return; } fails.push("✗ " + name + (extra ? " ｜ " + extra : "")); };
  const PANELS = [["preview-panel", "预览"], ["files-panel", "成果文件"]];
  const SEL = "a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])";
  // 「能不能被 Tab 走到」照浏览器的规矩判：自己或任何一级祖先 display:none / visibility:hidden / inert，
  // 就不在 Tab 序里。只看元素自己不够——面板正是靠祖先那一层把整片内容藏起来的
  const tabbable = (el) => {
    if (el.disabled) return false;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const c = getComputedStyle(p);
      if (c.display === "none" || c.visibility === "hidden" || p.hasAttribute("inert")) return false;
    }
    return true;
  };
  const all = (id) => [...document.getElementById(id).querySelectorAll(SEL)];
  const live = (id) => all(id).filter(tabbable).length;
  const vis = (id) => getComputedStyle(document.getElementById(id)).visibility;
  const tl = (cs, k) => String(cs[k]).split(",").map((s) => s.trim());
  const visDelay = (cs) => {
    const i = tl(cs, "transitionProperty").indexOf("visibility");
    if (i < 0) return null;
    const d = tl(cs, "transitionDelay");
    return parseFloat(d[i % d.length]) || 0;
  };
  const slow = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--owb-t-slow")) || 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 熄灯是**延迟**发生的，所以每次改完 class / 样式都得真等一等再量。
  // 不等就量，量到的是上一帧那个还亮着的值——第一版就是这么把自己骗过去的
  const settle = () => new Promise((r) => setTimeout(r, Math.round(slow * 1000) + 150));

  ok("先验料：--owb-t-slow 真有个值（熄灯延迟要跟它对齐，是 0 的话下面那条就白判了）", slow > 0, slow + "s");
  for (const [id, cn] of PANELS) {
    ok("先验料：" + cn + "面板里本来就装着能聚焦的东西（不然「0 个」只是这儿本来就空）", all(id).length >= 3, all(id).length + " 个");
  }

  // ---- 关着 ----
  for (const [id, cn] of PANELS) {
    const cs = getComputedStyle(document.getElementById(id));
    ok("关着的" + cn + "面板：整块 visibility:hidden", cs.visibility === "hidden", cs.visibility);
    ok("关着的" + cn + "面板：Tab 一个都走不进去", live(id) === 0, "还能走到 " + live(id) + " / " + all(id).length + " 个");
    // 不许改成 display:none 了事：那样面板连布局盒子都没有了，宽度动画没得可动，
    // 拖宽把手和「记住上次宽度」那几处量出来全是 0
    ok("关着的" + cn + "面板：还是 flex 盒子，不是 display:none（宽度动画和量宽度都靠它）", cs.display === "flex", cs.display);
    const d = visDelay(cs);
    ok("关着的" + cn + "面板：熄灯排在宽度收完之后" + (reduce ? "（减弱动态效果这一档就该是 0）" : ""),
      d !== null && Math.abs(d - (reduce ? 0 : slow)) < 0.001,
      "visibility 延迟 " + d + "s，过渡表 " + cs.transitionProperty + " / " + cs.transitionDelay);
  }

  // ---- 打开 ----
  for (const [id] of PANELS) document.getElementById(id).classList.add("show");
  for (const [id, cn] of PANELS) {
    const el = document.getElementById(id), cs = getComputedStyle(el);
    ok("打开" + cn + "面板：同一帧就 visible，不许拖（拖一下等于刚划出来那会儿是块空白）", cs.visibility === "visible", cs.visibility);
    ok("打开" + cn + "面板：里面的钮回到 Tab 序（面板宽 " + Math.round(el.getBoundingClientRect().width) + "px）",
      live(id) >= 3, live(id) + " / " + all(id).length + " 个");
    ok("打开" + cn + "面板：亮灯不带延迟", Math.abs(visDelay(cs) || 0) < 0.001, "visibility 延迟 " + visDelay(cs) + "s");
  }

  // ---- 收起：灯要等宽度收完才熄，不然收起动画就成了「啪」的一下 ----
  for (const [id] of PANELS) document.getElementById(id).classList.remove("show");
  const atOnce = PANELS.map(([id]) => vis(id));
  ok(reduce ? "减弱动态效果这一档：点收起当场熄灯（本来就不该有动画）" : "刚点收起那一瞬间灯还亮着——宽度收完了才熄，收起动画才是滑出去不是闪没",
    reduce ? atOnce.every((v) => v === "hidden") : atOnce.every((v) => v === "visible"), atOnce.join(" / "));
  await settle();
  ok("收完之后灯灭了，Tab 也再走不进去",
    PANELS.every(([id]) => vis(id) === "hidden") && PANELS.every(([id]) => live(id) === 0),
    PANELS.map(([id, cn]) => cn + "=" + vis(id) + "/" + live(id) + "个").join(" · "));

  // ---- ★反向对照★ ----
  // 把改之前 index.html 里真写着的那一版压回去：关着的面板没有 visibility 这一条，
  // 就是从 body 继承来的 visible。同一把尺子必须当场变红——不红说明它量的根本不是这件事
  const st = document.createElement("style");
  st.textContent = "#preview-panel, #files-panel { visibility: visible; }";
  document.head.appendChild(st);
  await settle();
  const back = PANELS.map(([id]) => live(id));
  st.remove();
  await settle();
  const after = PANELS.map(([id]) => live(id));
  ok("★反向对照★ 删掉 visibility:hidden，关着的面板立刻又能被 Tab 走进去",
    back.every((n) => n > 0), "预览 " + back[0] + " 个 · 成果文件 " + back[1] + " 个");
  ok("反向对照撤掉之后回到 0（那段临时样式没把尺子弄坏）", after.every((n) => n === 0), after.join(" / "));

  if (fails.length) throw new Error("关着的侧滑面板：" + names.length + " 条过，挂了 " + fails.length + " 条：\\n" + fails.join("\\n"));
  return names;
})()
`;

// 行里那几个「鼠标扫过才冒出来」的操作：移除项目、删掉任务、只整理这个任务、复制我发的话。
// 之前它们是拿 visibility:hidden 藏的——而 visibility:hidden 同时把元素踢出 Tab 序，
// 于是纯键盘的人这辈子够不着「移除项目」；.del/.hx 还是 <span>，连自己的焦点都没有。
// 实测：四处行内操作，键盘一个都够不着。现在改成「透明 + 不吃点击」，焦点一落就显形。
// 这一屏要同时管住两头，少一头都能装作没事：
//   markup 退回 <span> —— CSS 再对也没用，没焦点就没有 :focus-visible；
//   CSS 掉了 :focus-within/:focus-visible —— 标签再对也没用，Tab 到了人还是看不见它在哪。
// 所以 markup 从 app-02.js / app-01.js 里原样切，CSS 用 index.html 的真 <style>。
const ROWACT_MARKUP = (() => {
  const lift = (src, cls, where, want) => {
    const re = new RegExp('<button[^>]*class="' + cls + '"[^>]*>[\\s\\S]*?</button>', "g");
    const hits = src.match(re) || [];
    if (hits.length !== want) {
      throw new Error(where + " 里 class=\"" + cls + "\" 的 <button> 有 " + hits.length + " 个，期望 " + want +
        "——行内操作一旦退回 <span>，它就没有自己的焦点，键盘再也够不着");
    }
    return hits.map((h) => h.replace(/\$\{[^}]*\}/g, '<svg class="i" width="14" height="14"></svg>'));
  };
  const del = lift(APP02, "del", "app-02.js（侧栏项目行）", 1)[0];
  const hx = lift(APP02, "hx", "app-02.js（任务历史行）", 1)[0];
  const ops = lift(APP02X, "op", "app-01.js（整理面板）", 2);
  const ucopy = lift(APP02X, "u-copy", "app-01.js（我发的那条消息）", 1)[0];
  // 行本身的 tabindex 是 markActivatable 在运行时补的（见 app-00-ui.js），这里照它的结果摆。
  // 那个函数还在不在，下面另有一条静态断言盯着，不靠这份 markup 替它作证。
  return '<div class="side"><div id="proj-list">'
    + '<div class="proj-item" data-name="甲项目" tabindex="0"><span class="pn">甲项目</span>' + del + '</div></div>'
    + '<div id="history"><div class="hist-item" data-id="s1" tabindex="0"><span class="ht">第一件事</span>' + hx + '</div></div></div>'
    + '<div class="sweep-panel"><div class="sw-tasks"><div class="sw-task" data-task="x">'
    + '<span class="nm">任务甲</span><span class="sw-sz">1 MB</span><span class="cnt">3 个</span>' + ops.join("") + '</div></div></div>'
    + '<div class="turn"><div class="u-msg">' + ucopy + '<div class="bubble" translate="no">帮我写个周报</div></div></div>';
})();
if (!/el\.tabIndex\s*=\s*0/.test(UI00_SRC) || !/dataset\.activate/.test(UI00_SRC)) {
  throw new Error("app-00-ui.js 的 markActivatable 不再给行补 tabIndex/data-activate 了——" +
    "那上面这份 markup 里的 tabindex=\"0\" 就是测试自己发的，:focus-within 那几条等于没验");
}
const rowActHtml = (css) => "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + css
  + "\nhtml,body{height:100%}body{margin:0}</style><body>" + ROWACT_MARKUP + "</body>";
const ROWACT_HTML = rowActHtml(INDEX_CSS);
// ★反向对照★ 把真 CSS 里所有「, …:focus-within …」「, …:focus-visible …」的选择器片段摘掉，
// 别的一个字不动。摘不掉 4 段以上就说明这个变异根本没咬到东西，先把自己判红。
const ROWACT_CSS_NOFOCUS = (() => {
  const cut = INDEX_CSS.replace(/,\s*[^,{}]*:focus-(?:within|visible)[^,{}]*(?=[,{])/g, "");
  const gone = INDEX_CSS.length - cut.length;
  const n = (INDEX_CSS.match(/,\s*[^,{}]*:focus-(?:within|visible)[^,{}]*(?=[,{])/g) || []).length;
  if (n < 4 || gone <= 0) throw new Error("反向对照没咬住：只摘掉了 " + n + " 段 :focus-* 选择器，少于 4 段，这个变异证明不了什么");
  return cut;
})();
const ROWACT_HTML_NOFOCUS = rowActHtml(ROWACT_CSS_NOFOCUS);
const ROWACT_CHECKS = `
(async () => {
  const names = [], fails = [];
  const ok = (cond, msg) => { if (cond) names.push(msg); else fails.push(msg); };
  const settle = () => new Promise((r) => setTimeout(r, 420));
  const cs = (el) => getComputedStyle(el);
  const op = (el) => Number(cs(el).opacity);
  const tabbable = (el) => {
    if (!el || el.disabled || !(el.tabIndex >= 0)) return false;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const c = cs(p);
      if (c.display === "none" || c.visibility === "hidden" || p.hasAttribute("inert")) return false;
    }
    return true;
  };
  const CASES = [
    ["项目行·移除项目", ".proj-item", ".del"],
    ["任务历史行·删掉", ".hist-item", ".hx"],
    ["整理面板·行内操作", ".sw-task", ".op"],
    ["我发的消息·复制", ".u-msg", ".u-copy"],
  ];
  for (const [name, rowSel, actSel] of CASES) {
    const row = document.querySelector(rowSel), act = row && row.querySelector(actSel);
    if (!act) { fails.push(name + "：页面上找不着 " + rowSel + " " + actSel); continue; }
    ok(act.tagName === "BUTTON", name + "：是个真 <button>（自己接得住焦点）");
    ok(!!(act.getAttribute("aria-label") || act.title), name + "：说得出自己是干什么的");
    document.body.focus(); await settle();
    ok(op(act) === 0, name + "：平时看不见（透明度 0）");
    ok(cs(act).pointerEvents === "none", name + "：看不见的时候也点不着（别误删）");
    ok(tabbable(act) === true, name + "：Tab 还是走得到它");
    act.focus(); await settle();
    ok(document.activeElement === act && op(act) === 1 && cs(act).pointerEvents === "auto",
       name + "：焦点落在它身上就显形、并且点得动");
    act.blur(); document.body.focus(); await settle();
    ok(op(act) === 0, name + "：焦点挪走就又收回去");
    if (row.tabIndex >= 0) {
      row.focus(); await settle();
      ok(op(act) === 1, name + "：焦点才刚落在行上，这个操作就已经看得见了");
      row.blur(); document.body.focus(); await settle();
    }
  }
  // .sw-task 那一行本身不可聚焦（它不是个能点的东西），:focus-within 在那儿买到的是另一件事：
  // 焦点落到第一个操作上，同一行的第二个也跟着显形——不然 Tab 到一半，下一站又是个透明的。
  const swOps = document.querySelectorAll(".sw-task .op");
  if (swOps.length >= 2) {
    document.body.focus(); await settle();
    swOps[0].focus(); await settle();
    ok(op(swOps[1]) === 1, "整理面板·行内操作：焦点落在它身上，同一行的邻座也跟着显形（下一站不再是透明的）");
    swOps[0].blur(); document.body.focus(); await settle();
  } else {
    fails.push("整理面板那一行只剩 " + swOps.length + " 个操作，「邻座跟着显形」这条没法验");
  }
  if (!window.__rowactMutant) {
    // ★反向对照★ 把「透明 + 不吃点击」换回 visibility:hidden，四个操作必须当场全退出 Tab 序
    const st = document.createElement("style");
    st.textContent = ".proj-item .del, .hist-item .hx, .sw-task .op, .u-msg .u-copy { visibility: hidden; }";
    document.head.appendChild(st);
    await settle();
    const stillTab = CASES.map(([n, r, a]) => [n, document.querySelector(r + " " + a)]).filter(([n, el]) => el && tabbable(el));
    ok(stillTab.length === 0, "★反向对照★ 换回 visibility:hidden，四处行内操作全部退出 Tab 序（还剩 " + stillTab.length + " 个）");
    st.remove(); await settle();
    const backTab = CASES.map(([n, r, a]) => document.querySelector(r + " " + a)).filter((el) => el && tabbable(el));
    ok(backTab.length === CASES.length, "★反向对照★ 摸回来，四处全部又回到 Tab 序里（现在 " + backTab.length + "/" + CASES.length + "）");
  }
  return { names, fails };
})()`;

function mkWin(opts) {
  const w = new BrowserWindow(opts);
  RENDERER_LOG.length = 0;
  w.webContents.on("console-message", (ev, level, message, line, sourceId) => {
    const m = ev && typeof ev === "object" && "message" in ev ? ev : { level, message, lineNumber: line, sourceId };
    RENDERER_LOG.push({ level: String(m.level), message: String(m.message), line: m.lineNumber, src: m.sourceId });
  });
  // 盯着 DOM 里有没有原样漏出来的 ${...}。这类事故的来源是把模板占位符写进了单/双引号
  // （'已达成${ic("check")}'）：JS 一声不吭，界面上就直接印出一串 ${ic("check")}，
  // 只有人眼盯着才看得见。用 MutationObserver 盯全程——一屏画完又被下一屏盖掉的也算数，
  // 跑完再翻一眼 innerHTML 是抓不到的。挂在 mkWin 上，以后新增用例块不用自己记着加。
  // 「减弱动态效果」这一档，每个窗口都明说自己要哪一边，绝不跟着跑测试那台机器的系统设置走。
  // GitHub 的 macOS runner 默认就开着它，开发机默认没开——v0.5.1 的 CI 正是栽在这儿：
  // 「跳回那一轮」的高亮在 runner 上量出 animation-name: "none"，一条断言把 test 和 release
  // 两条流水线一起挡下，那个 tag 到现在都没有安装包。本机全绿、runner 全红，看着还像 CI 坏了。
  // 所以默认钉成 no-preference；要测 reduce 的窗口在 loadURL 之后把 __motion 改掉就行。
  let motionPinned = null;
  const pinMotion = async () => {
    const want = w.__motion || "no-preference";
    if (motionPinned === want) return;
    if (!w.webContents.debugger.isAttached()) w.webContents.debugger.attach("1.3");
    await w.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-reduced-motion", value: want }] });
    motionPinned = want;
  };
  const rawExec = w.webContents.executeJavaScript.bind(w.webContents);
  w.webContents.executeJavaScript = async (code, gesture) => {
    await pinMotion().catch((e) => {
      throw new Error("钉不住「减弱动态效果」这一档，这一屏的结果就会跟着机器的系统设置飘：" + ((e && e.message) || e));
    });
    await rawExec(PLACEHOLDER_WATCH, true).catch(() => 0);
    const r = await rawExec(code, gesture);
    const leak = await rawExec("(window.__phFlush ? window.__phFlush() : '')", true).catch(() => "");
    if (leak) throw new Error("界面上漏出了没求值的模板占位符 " + leak + "：多半是把 ${} 写进了单引号/双引号字符串");
    return r;
  };
  return w;
}
app.whenReady().then(async () => {
  READY = true;
  const win = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
  let code = 0;
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><meta charset='utf-8'><body></body>"));
    await win.webContents.executeJavaScript(IC_BOOT + SVGFIG);
    const names = await win.webContents.executeJavaScript(IC_BOOT + CHECKS, true);
    for (const n of names) console.log("  ✓ " + n);
    console.log(`✅ 前端：内联 SVG 信息图（渲染/流式/清洗/作用域/导出）${names.length} 项通过`);

    // 附件那一段要在干净的 DOM 里跑：真源码里有 document 级监听，和上面的用例混在一起会互相打架
    const win2 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win2.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ATTACH_HTML));
      // 替身 + 真源码 + 断言必须是同一段脚本：源码里的 const 是脚本级作用域，分两次注入就互相看不见了
      const names2 = await win2.webContents.executeJavaScript(IC_BOOT + ATTACH_STUBS + "\n" + ATTACH_SRC + "\n" + ATTACH_CHECKS, true);
      for (const n of names2) console.log("  ✓ " + n);
      console.log(`✅ 前端：粘贴/拖拽附件（截图·文件·大段文字）${names2.length} 项通过`);
    } finally {
      if (!win2.isDestroyed()) win2.destroy();
    }

    const win3 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win3.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PREVIEW_HTML));
      const names3 = await win3.webContents.executeJavaScript(IC_BOOT + PREVIEW_STUBS + "\n" + PATHHELP_SRC + "\n" + HOSTCAP_SRC + "\n" + PREVIEW_SRC + "\n" + PREVIEW_CHECKS, true);
      for (const n of names3) console.log("  ✓ " + n);
      console.log(`✅ 前端：文件预览（路由·音视频·docx/xlsx/pptx/zip 结构化·CSV·兜底）${names3.length} 项通过`);
    } finally {
      if (!win3.isDestroyed()) win3.destroy();
    }

    const win4 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win4.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(FB_HTML));
      const names4 = await win4.webContents.executeJavaScript(IC_BOOT + FB_STUBS + "\n" + FB_WRAP(FB_SRC) + "\n" + FB_CHECKS, true);
      for (const n of names4) console.log("  ✓ " + n);
      console.log(`✅ 前端：👍👎 反馈上报（真发 payload·下标跟位置·理由选填·改判撤高亮）${names4.length} 项通过`);
    } finally {
      if (!win4.isDestroyed()) win4.destroy();
    }
    const win5 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win5.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(FILELIST_HTML));
      const names5 = await win5.webContents.executeJavaScript(IC_BOOT + FILELIST_STUBS + "\n" + PATHHELP_SRC + "\n" + HOSTCAP_SRC + "\n" + DELIVER_SRC + "\n" + FILELIST_SRC + "\n" + FILELIST_CHECKS, true);
      for (const n of names5) console.log("  ✓ " + n);
      console.log(`✅ 前端：成果面板按时间分段（今天/昨天/7天/按月·取最近动过·折叠独立·根目录降级）${names5.length} 项通过`);
    } finally {
      if (!win5.isDestroyed()) win5.destroy();
    }
    const winSw = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await winSw.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SWEEP_HTML));
      const namesSw = await winSw.webContents.executeJavaScript(IC_BOOT + SWEEP_STUBS + "\n" + SWEEP_SRC + "\n" + SWEEP_CHECKS, true);
      for (const n of namesSw) console.log("  ✓ " + n);
      console.log(`✅ 前端：整理文件夹 · 腾出空间（数字跟着勾变·一批和单个都收得全·先留着不删·长路径不顶穿）${namesSw.length} 项通过`);
    } finally {
      if (!winSw.isDestroyed()) winSw.destroy();
    }
    const win7 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win7.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TURNOUT_HTML));
      const names7 = await win7.webContents.executeJavaScript(IC_BOOT + TURNOUT_STUBS + "\n" + PATHHELP_SRC + "\n" + TURNOUT_SRC + "\n" + TURNOUT_CHECKS, true);
      for (const n of names7) console.log("  ✓ " + n);
      console.log(`✅ 前端：本回合产出（删掉的中间文件跟着撤·成品不被挤掉·截断不误杀·并卡只摘链接·整块可收起）${names7.length} 项通过`);
    } finally {
      if (!win7.isDestroyed()) win7.destroy();
    }
    const winEng = mkWin({ show: false, width: 760, height: 900, webPreferences: { offscreen: true } });
    try {
      await winEng.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ENG_HTML));
      const namesEng = await winEng.webContents.executeJavaScript(ENG_STUBS + "\n" + ENG_SRC + "\n" + ENG_CHECKS, true);
      for (const n of namesEng) console.log("  ✓ " + n);
      console.log(`✅ 前端：底层引擎卡片（没选中也能当场试·徽章不替人下结论·版本号削成一个形状·命令行挪进展开区）${namesEng.length} 项通过`);
    } finally {
      if (!winEng.isDestroyed()) winEng.destroy();
    }
    const win8 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      assertFailedCardsCollapsed();
      await win8.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SCROLLGUIDE_HTML));
      const names8 = await win8.webContents.executeJavaScript(IC_BOOT + SCROLLGUIDE_STUBS + "\n" + SCROLLGUIDE_SRC + "\n" + SCROLLGUIDE_CHECKS, true);
      for (const n of names8) console.log("  ✓ " + n);
      console.log(`✅ 前端：长对话滚动引导（回到最前/回到最新挂红点·看历史不被拽）+ 出错步骤卡默认收起、角标直达 ${names8.length} 项通过`);
    } finally {
      if (!win8.isDestroyed()) win8.destroy();
    }
    const win9 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win9.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TRAIL_HTML));
      const names9 = await win9.webContents.executeJavaScript(IC_BOOT + TRAIL_STUBS + "\n" + TRAIL_SRC + "\n" + TRAIL_CHECKS, true);
      for (const n of names9) console.log("  ✓ " + n);
      console.log(`✅ 前端：轨迹条（同名合并·出错标红·中止删除线·+N 上限·收起可见·点徽章直达）+ 结论出过程区 + 命中率封顶 + 收尾接线（正文文件名变可点链接·成品自动摊开·四种情形一律不弹）${names9.length} 项通过`);
    } finally {
      if (!win9.isDestroyed()) win9.destroy();
    }
    const winOvf = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await winOvf.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(OVF_HTML));
      const namesOvf = await winOvf.webContents.executeJavaScript(OVF_CHECKS, true);
      for (const n of namesOvf) console.log("  ✓ " + n);
      console.log(`✅ 前端：长串顶不穿边框（真 CSS 每条规则都塞一遍 200 字符长网址 · 含反向对照）${namesOvf.length} 项通过`);
    } finally {
      if (!winOvf.isDestroyed()) winOvf.destroy();
    }
    const win12 = mkWin({ show: false, width: 900, height: 900, webPreferences: { offscreen: true } });
    try {
      await win12.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOOK_HTML));
      const names12 = await win12.webContents.executeJavaScript(IC_BOOT + I18N_SRC + "\n(async function(){\n" + IC_STUB + "\n" + LOOK_SRC + "\n" + LOOK_CHECKS + "\n})()", true)
        .catch(async (e) => {
          // 块里是「挂了先收着、块尾一起报」。要是半路炸了个 TypeError，收着的那几条就跟着这个异常
          // 一起没了——而那几条才是真想看的。所以炸了先回页面里把它们捞出来，再一起报。
          const own = /^外观：/.test((e && e.message) || "");
          let collected = [];
          if (!own) { try { collected = await win12.webContents.executeJavaScript("window.__lookFails || []", true); } catch { /* 页面都没了就算了 */ } }
          throw new Error("[外观] " + (collected.length ? "炸之前已经挂了 " + collected.length + " 条：\n" + collected.join("\n") + "\n然后才炸的：\n" : "")
            + ((e && (e.stack || e.message)) || String(e)));
        });
      for (const n of names12) console.log("  ✓ " + n);
      console.log(`✅ 前端：外观页（字号四档按 calc 联动·六皮肤浅暗对比度矩阵·密度只收间距·字体三选·主题即点即生效·存储被禁退内存·默认不留脏属性）${names12.length} 项通过`);
    } finally {
      if (!win12.isDestroyed()) win12.destroy();
    }
    const winAva = mkWin({ show: false, width: 900, height: 800, webPreferences: { offscreen: true } });
    try {
      await winAva.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(AVA_HTML));
      const namesAva = await winAva.webContents.executeJavaScript(IC_BOOT + "(async function(){\n" + IC_STUB + "\n" + AVA_SRC + "\n" + AVA_CHECKS + "\n})()", true)
        .catch(async (e) => { throw new Error("[头像编辑器] " + ((e && (e.stack || e.message)) || String(e)) + " | 已过 " + (await winAva.webContents.executeJavaScript("window.__avaNames||0").catch(() => "?"))); });
      for (const n of namesAva) console.log("  ✓ " + n);
      console.log(`✅ 前端：头像编辑器（三类候选 36px 等大·反向对照量出行内盒子 300×150·表情能挑能打·恢复默认回默认那一页·落图区整块可点可拖）${namesAva.length} 项通过`);
    } finally {
      if (!winAva.isDestroyed()) winAva.destroy();
    }
    const winHl = mkWin({ show: false, width: 700, height: 500, webPreferences: { offscreen: true } });
    try {
      await winHl.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HL_HTML));
      const namesHl = await winHl.webContents.executeJavaScript(IC_BOOT + "(async function(){\n" + HL_STUBS + "\n" + HL_SRC + "\n" + HL_CHECKS + "\n})()", true)
        .catch(async (e) => { throw new Error("[输入框高亮] " + ((e && (e.stack || e.message)) || String(e)) + " | 已过 " + (await winHl.webContents.executeJavaScript("window.__hlNames||0").catch(() => "?"))); });
      for (const n of namesHl) console.log("  ✓ " + n);
      console.log(`✅ 前端：输入框 token 高亮（镜像层逐字对齐·折行不错位·改字号跟着走·路径不误框）${namesHl.length} 项通过`);
    } finally {
      if (!winHl.isDestroyed()) winHl.destroy();
    }
    const win18 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win18.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(MENU_HTML));
      const names18 = await win18.webContents.executeJavaScript(IC_BOOT + I18N_SRC + "\n(async function(){\n" + MENU_STUBS + "\n" + LOOK_SRC + "\n" + MENU_SRC + "\n" + MENU_CHECKS + "\n})()", true)
        .catch(async (e) => { throw new Error("[头像菜单] " + ((e && (e.stack || e.message)) || String(e)) + " | 已过 " + (await win18.webContents.executeJavaScript("window.__menuNames||0").catch(() => "?"))); });
      for (const n of names18) console.log("  ✓ " + n);
      console.log(`✅ 前端：头像菜单语言快切（中/En 胶囊点即切·菜单不关原地翻·点行空白也翻·尾注已删·其它行不受影响）${names18.length} 项通过`);
    } finally {
      if (!win18.isDestroyed()) win18.destroy();
    }
    const win14 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win14.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(I18N_HTML));
      const names14 = await win14.webContents.executeJavaScript(IC_BOOT + I18N_SRC + "\n" + I18N_CHECKS, true)
        .catch((e) => { throw new Error("[语言] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of names14) console.log("  ✓ " + n);
      console.log(`✅ 前端：中英文切换（点即整页翻·后渲染的节点观察者接手·属性也翻·内容区不碰·切回中文原样还原·不自激振荡）${names14.length} 项通过`);
    } finally {
      if (!win14.isDestroyed()) win14.destroy();
    }
    const win15 = mkWin({ show: false, width: 900, height: 900, webPreferences: { offscreen: true } });
    try {
      await win15.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HUB_MCP_HTML));
      const names15 = await win15.webContents.executeJavaScript(IC_BOOT + HUB_MCP_STUBS + "\n" + HUB_MCP_SRC + "\n" + HUB_MCP_CHECKS, true)
        .catch((e) => { throw new Error("[连接器] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of names15) console.log("  ✓ " + n);
      console.log(`✅ 前端：连接器卡片（一键接入预填·缺 Key 拦下·值里带等号保住·原条目不回传 Key·已接入置灰·搜索联动·死因整块三行可展开·命令行不被横切·角标不压状态字也不顶出卡片）${names15.length} 项通过`);
    } finally {
      if (!win15.isDestroyed()) win15.destroy();
    }
    const win16 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      const { defaultPairs, maskScript } = require("../scripts/demo-mask");
      const pairs = defaultPairs("/tmp/owb-demo-1", ["cli_a1b2c3d4e5"]);
      await win16.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(MASK_HTML));
      const names16 = await win16.webContents.executeJavaScript(IC_BOOT + MASK_CHECKS(maskScript(pairs)), true)
        .catch((e) => { throw new Error("[遮罩] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of names16) console.log("  ✓ " + n);
      console.log(`✅ 前端：录屏遮罩层（静态文本/输入框/title·后插入节点·原地改字·bot id 圆点）${names16.length} 项通过`);
    } finally {
      if (!win16.isDestroyed()) win16.destroy();
    }
    const win17 = mkWin({ show: false, width: 900, height: 600, webPreferences: { offscreen: true } });
    try {
      await win17.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ARRIVAL_HTML));
      const names17 = await win17.webContents.executeJavaScript(IC_BOOT + ARRIVAL_STUBS + "\n" + ARRIVAL_SRC + "\n" + ARRIVAL_CHECKS, true)
        .catch((e) => { throw new Error("[产出到了] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of names17) console.log("  ✓ " + n);
      console.log(`✅ 前端：产出到了不抢版面 + 跑完看得见（中途不弹/角标累加/开面板清零/只在看着同一文件时原地刷新 · 正文文件名变可点链接、代码块和没产出过的名字不碰 · 收尾开成品且六种情形一律不开）${names17.length} 项通过`);
    } finally {
      if (!win17.isDestroyed()) win17.destroy();
    }
    const win11 = mkWin({ show: false, width: 900, height: 900, webPreferences: { offscreen: true } });
    try {
      await win11.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ONB_HTML));
      const names11 = await win11.webContents.executeJavaScript(IC_BOOT + I18N_SRC + "\n" + ONB_STUBS + "\n" + ONB_SRC + "\n" + SHORTCUT_SRC + "\n" + ONB_CHECKS, true);
      for (const n of names11) console.log("  ✓ " + n);
      console.log(`✅ 前端：首次开箱向导（大脑必配·云端/本机二选一·验活失败不翻页·搜索保存再测活·多媒体按行填·清单收尾·走完不再弹·关于页可重开）${names11.length} 项通过`);
    } finally {
      if (!win11.isDestroyed()) win11.destroy();
    }
    const win19 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win19.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(WSMENU_HTML));
      const names18 = await win19.webContents.executeJavaScript(IC_BOOT + 
        WSMENU_STUBS + "\n" + HOSTCAP_SRC + "\n" + srcBlock("function openWorkspaceOnHost(") + "\n" + WSMENU_SRC + "\n" + WSMENU_CHECKS, true);
      for (const n of names18) console.log("  ✓ " + n);
      console.log(`✅ 前端：顶栏工作空间菜单（成员不画会 403 的两条·501 才退回手填·切换/打开失败都说原因）${names18.length} 项通过`);
    } finally {
      if (!win19.isDestroyed()) win19.destroy();
    }
    const win10 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win10.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(IMPANE_HTML));
      const names10 = await win10.webContents.executeJavaScript(IC_BOOT + IMPANE_STUBS + "\n" + IMPANE_SRC + "\n" + IMPANE_CHECKS, true);
      for (const n of names10) console.log("  ✓ " + n);
      console.log(`✅ 前端：助理设置页（五分区·双栏·发邮件·连上收起·连接=保存再测活·凭证没填齐先拦住·取消连接两步且只清自己·微信取码/断开·扫码新建飞书应用·清会话两步）${names10.length} 项通过`);
    } finally {
      if (!win10.isDestroyed()) win10.destroy();
    }
    const win13 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win13.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(COMPOSER_HTML));
      const names13 = await win13.webContents.executeJavaScript(IC_BOOT + COMPOSER_STUBS + "\n" + COMPOSER_SRC + "\n" + COMPOSER_CHECKS, true);
      for (const n of names13) console.log("  ✓ " + n);
      console.log(`✅ 前端：运行中的输入框（提示讲清插话/停下/并行·停止是真按钮·一颗键按有没有字切停下/插一句·提示语跟忙闲·发完自动回停下）${names13.length} 项通过`);
    } finally {
      if (!win13.isDestroyed()) win13.destroy();
    }
    const winSK = mkWin({ show: false, width: 700, height: 500, webPreferences: { offscreen: true } });
    try {
      await winSK.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SKEG_HTML));
      const namesSK = await winSK.webContents.executeJavaScript(IC_BOOT + SKEG_SRC + "\n" + SKEG_CHECKS, true)
        .catch((e) => { throw new Error("[技能例子] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesSK) console.log("  ✓ " + n);
      console.log(`✅ 前端：技能卡「立即使用」摆的是具体能干的事（真说明书·整节都读·括号不砍句·没写适用场景就一条不给·颜色码包名不当例子·最多 4 个）${namesSK.length} 项通过`);
    } finally { if (!winSK.isDestroyed()) winSK.destroy(); }

    const winMG = mkWin({ show: false, width: 400, height: 400, webPreferences: { offscreen: true } });
    try {
      await winMG.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(MERGE_HTML));
      const namesMG = await winMG.webContents.executeJavaScript(IC_BOOT + MERGE_STUBS + "\n" + APP03_MERGE + "\n" + MERGE_CHECKS, true)
        .catch((e) => { throw new Error("[历史并回] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesMG) console.log("  ✓ " + n);
      console.log(`✅ 前端：登录后把服务端的任务历史并回侧栏（本地空了能补回·只补不删·润色过的标题盖过半句话·老服务端/断网一条不清）${namesMG.length} 项通过`);
    } finally { if (!winMG.isDestroyed()) winMG.destroy(); }

    const winPJ = mkWin({ show: false, width: 300, height: 600, webPreferences: { offscreen: true } });
    try {
      await winPJ.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PROJ_HTML));
      const namesPJ = await winPJ.webContents.executeJavaScript(IC_BOOT + PROJ_STUBS + "\n" + PROJ_SRC + "\n" + PROJ_CHECKS, true)
        .catch((e) => { throw new Error("[项目栏/任务历史] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesPJ) console.log("  ✓ " + n);
      console.log(`✅ 前端：侧栏项目栏 + 任务历史（租户端整栏不画·历史一条不滤·假项目顶上就滤空的事故留证·状态来回切）${namesPJ.length} 项通过`);
    } finally { if (!winPJ.isDestroyed()) winPJ.destroy(); }

    const winSB = mkWin({ show: false, width: 1100, height: 640, webPreferences: { offscreen: true } });
    try {
      await winSB.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SIDEBAR_HTML));
      const namesSB = await winSB.webContents.executeJavaScript(IC_BOOT + HIST_RSZ_SRC + "\n" + SIDEBAR_CHECKS, true)
        .catch((e) => { throw new Error("[侧栏主次/拖拽] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesSB) console.log("  ✓ " + n);
      console.log(`✅ 前端：侧栏主次分明 + 任务历史可拖（两百条历史也挤不没导航·字号颜色图标三层分主次·上下拖/键盘推/双击回自适应）${namesSB.length} 项通过`);
    } finally { if (!winSB.isDestroyed()) winSB.destroy(); }

    // 再跑一遍，这次把系统的「减弱动态效果」打开。GitHub 的 macOS runner 默认就是这个状态，
    // 本机默认不是——少了这一遍，reduce 档下的过渡行为在本地永远测不到，只能等 CI 红了再回头查。
    // 上一次就是这么吃的亏：同样的文件同样的 Chromium，本机 24 条全过，runner 上挂 6 条。
    const winSBR = mkWin({ show: false, width: 1100, height: 640, webPreferences: { offscreen: true } });
    try {
      await winSBR.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SIDEBAR_HTML));
      winSBR.__motion = "reduce";
      const namesSBR = await winSBR.webContents.executeJavaScript(IC_BOOT + HIST_RSZ_SRC + "\n" + SIDEBAR_CHECKS, true)
        .catch((e) => { throw new Error("[侧栏·减弱动态效果] " + ((e && (e.stack || e.message)) || String(e))); });
      console.log(`✅ 前端：系统开了「减弱动态效果」之后，侧栏那套主次与拖拽照样准（全局过渡不许把「改完就读」拖成上一帧的旧值）${namesSBR.length} 项通过`);
    } finally { if (!winSBR.isDestroyed()) winSBR.destroy(); }

    // 三档各跑一遍：常规宽度（默认那套规则）、开着「减弱动态效果」、手机宽度（面板变成盖在上面的浮层）。
    // 手机那档不是凑数——用户最先撞上这件事就是在 390 宽：一路 Tab 走到第 21 站人就不见了
    for (const [w, h, motion, label] of [[1280, 800, null, "常规宽度"], [1280, 800, "reduce", "减弱动态效果"], [390, 844, null, "手机宽度·浮层"]]) {
      const winPV = mkWin({ show: false, width: w, height: h, webPreferences: { offscreen: true } });
      try {
        await winPV.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PANELVIS_HTML));
        if (motion) winPV.__motion = motion;
        const namesPV = await winPV.webContents.executeJavaScript(PANELVIS_CHECKS, true)
          .catch((e) => { throw new Error("[关着的面板·" + label + "] " + ((e && (e.stack || e.message)) || String(e))); });
        if (!motion && w > 900) for (const n of namesPV) console.log("  ✓ " + n);
        console.log(`✅ 前端：关着的侧滑面板不进 Tab 序（${label} ${w}×${h}·关着 0 个·打开全回来·熄灯等宽度收完·删掉那条当场变红）${namesPV.length} 项通过`);
      } finally { if (!winPV.isDestroyed()) winPV.destroy(); }
    }

    // 行里那几个「鼠标扫过才冒出来」的操作。用户拿键盘走这一趟：Tab 停在行上 → 操作显形 →
    // 再 Tab 就落到它身上。以前这一趟走不通——visibility:hidden 把它们全踢出了 Tab 序。
    const winRA = mkWin({ show: false, width: 1100, height: 700, webPreferences: { offscreen: true } });
    try {
      await winRA.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ROWACT_HTML));
      const ra = await winRA.webContents.executeJavaScript(ROWACT_CHECKS, true)
        .catch((e) => { throw new Error("[行内操作·键盘够得着] " + ((e && (e.stack || e.message)) || String(e))); });
      if (ra.fails.length) {
        throw new Error("行内操作这一屏：" + ra.names.length + " 条过，挂了 " + ra.fails.length + " 条：\n" + ra.fails.join("\n"));
      }
      for (const n of ra.names) console.log("  ✓ " + n);
      console.log(`✅ 前端：行里那几个操作键盘够得着（平时透明·看不见就点不着·Tab 走得到·焦点一落就显形·换回 visibility 当场退出 Tab 序）${ra.names.length} 项通过`);
    } finally { if (!winRA.isDestroyed()) winRA.destroy(); }

    // ★反向对照★ 单开一个窗口，喂的是「真 CSS 摘掉所有 :focus-within/:focus-visible」那一份。
    // 「焦点一落就显形」那 7 条必须当场全红——红不了就说明上一屏根本没在验那几条 CSS，
    // 而是靠 :hover 蒙混过关。红得不够也算变异没咬住，一样把自己判红。
    const winRAM = mkWin({ show: false, width: 1100, height: 700, webPreferences: { offscreen: true } });
    try {
      await winRAM.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ROWACT_HTML_NOFOCUS));
      const ram = await winRAM.webContents.executeJavaScript("window.__rowactMutant = 1;\n" + ROWACT_CHECKS, true)
        .catch((e) => { throw new Error("[行内操作·反向对照] " + ((e && (e.stack || e.message)) || String(e))); });
      const reveal = ram.fails.filter((f) => f.includes("焦点落在它身上") || f.includes("焦点才刚落在行上"));
      if (reveal.length !== 7) {
        throw new Error("★反向对照★ 真 CSS 摘掉 :focus-within/:focus-visible 之后，「焦点一落就显形」只红了 " +
          reveal.length + " 条，期望 7 条——这一屏验的不是那几条 CSS。全部挂掉的是：\n" + ram.fails.join("\n"));
      }
      console.log(`✅ 前端：★反向对照★ 真 CSS 里摘掉 :focus-within/:focus-visible，「焦点一落就显形」当场红 ${reveal.length} 条（其余 ${ram.names.length} 条照过）`);
    } finally { if (!winRAM.isDestroyed()) winRAM.destroy(); }

    const winLN = mkWin({ show: false, width: 980, height: 600, webPreferences: { offscreen: true } });
    try {
      await winLN.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LANE_HTML));
      const namesLN = await winLN.webContents.executeJavaScript(IC_BOOT + 
        LANE_STUBS + "\n" + LANE_REPLY_SRC + "\n" + LANE_STATE_SRC + "\n" + LANE_SRC + "\n" + HIST_MIN_SRC + "\n" + LANE_CHECKS, true)
        .catch((e) => { throw new Error("[两条工作线] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesLN) console.log("  ✓ " + n);
      console.log(`✅ 前端：侧栏两条工作线（各记各的会话·标签碰不到引擎·工程线不按项目滤空·终端里那几趟标在标签上·老服务端不塌）${namesLN.length} 项通过`);
    } finally { if (!winLN.isDestroyed()) winLN.destroy(); }

    const winLN2 = mkWin({ show: false, width: 430, height: 640, webPreferences: { offscreen: true } });
    try {
      await winLN2.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LANE_NARROW_HTML));
      const namesLN2 = await winLN2.webContents.executeJavaScript(IC_BOOT + 
        LANE_STUBS + "\n" + LANE_REPLY_SRC + "\n" + LANE_STATE_SRC + "\n" + LANE_SRC + "\n" + HIST_MIN_SRC + "\n" + LANE_NARROW_CHECKS, true)
        .catch((e) => { throw new Error("[两条工作线·窄侧栏] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesLN2) console.log("  ✓ " + n);
      console.log(`✅ 前端：侧栏拖到底（180px）时的工作线标签（一行放得下·名字没被挤没·徽标也塞得下）${namesLN2.length} 项通过`);
    } finally { if (!winLN2.isDestroyed()) winLN2.destroy(); }

    const winGC = mkWin({ show: false, width: 760, height: 600, webPreferences: { offscreen: true } });
    try {
      await winGC.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(GOAL_HTML));
      const namesGC = await winGC.webContents.executeJavaScript(IC_BOOT + GOAL_STUBS + "\n" + GOAL_SRC + "\n" + GOAL_CHECKS, true)
        .catch((e) => { throw new Error("[Goal 目标卡] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesGC) console.log("  ✓ " + n);
      console.log(`✅ 前端：Goal 目标卡（进度条·拆解验收失败留痕·停了说为什么并能接着冲）${namesGC.length} 项通过`);
    } finally { if (!winGC.isDestroyed()) winGC.destroy(); }

    const winQT = mkWin({ show: false, width: 760, height: 400, webPreferences: { offscreen: true } });
    try {
      await winQT.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(QUOTE_HTML));
      const namesQT = await winQT.webContents.executeJavaScript(IC_BOOT + QUOTE_STUBS + "\n" + QUOTE_SRC + "\n" + JUMP_SRC + "\n" + QUOTE_CHECKS, true)
        .catch((e) => { throw new Error("[引用回复 / 跳回那一轮] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesQT) console.log("  ✓ " + n);
      console.log(`✅ 前端：引用一条回复 + 从资料库跳回那一轮（只引正文不带过程卡片·选中了就只引那截·别处选的字不许算在这条头上·连按不重复·跳不过去就认输）${namesQT.length} 项通过`);
    } finally { if (!winQT.isDestroyed()) winQT.destroy(); }

    const winQTR = mkWin({ show: false, width: 760, height: 400, webPreferences: { offscreen: true } });
    try {
      await winQTR.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(QUOTE_HTML));
      winQTR.__motion = "reduce";
      const namesQTR = await winQTR.webContents.executeJavaScript(IC_BOOT + QUOTE_STUBS + "\n" + JUMP_SRC + "\n" + JUMP_REDUCE_CHECKS, true)
        .catch((e) => { throw new Error("[跳回那一轮·减弱动态效果] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesQTR) console.log("  ✓ " + n);
      console.log(`✅ 前端：系统开了「减弱动态效果」之后，跳过去照样看得见落在哪一轮（不放动画，但底色和外圈得真摆上）${namesQTR.length} 项通过`);
    } finally { if (!winQTR.isDestroyed()) winQTR.destroy(); }

    const winCTX = mkWin({ show: false, width: 760, height: 200, webPreferences: { offscreen: true } });
    try {
      await winCTX.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(CTX_HTML));
      const namesCTX = await winCTX.webContents.executeJavaScript(IC_BOOT + CTX_SRC + "\n" + CTX_CHECKS, true)
        .catch((e) => { throw new Error("[上下文余量条] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesCTX) console.log("  ✓ " + n);
      console.log(`✅ 前端：上下文余量条（过半才露面·到线变黄·换会话收回去·收完还能重新填）${namesCTX.length} 项通过`);
    } finally { if (!winCTX.isDestroyed()) winCTX.destroy(); }

    const winESC = mkWin({ show: false, width: 600, height: 400, webPreferences: { offscreen: true } });
    try {
      await winESC.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ESC_HTML));
      const namesESC = await winESC.webContents.executeJavaScript(IC_BOOT + ESC_STUBS + "\n" + ESC_SRC + "\n" + STREAM_SRC + "\n" + ESC_CHECKS, true)
        .catch((e) => { throw new Error("[HTML 转义] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesESC) console.log("  ✓ " + n);
      console.log(`✅ 前端：转义与链接（引号进属性不截断·[文字](报告.md) 点得开预览、回车也认、认不准的一律不给链接·正常内容一字没动）${namesESC.length} 项通过`);
    } finally { if (!winESC.isDestroyed()) winESC.destroy(); }

    const winMEM = mkWin({ show: false, width: 900, height: 900, webPreferences: { offscreen: true } });
    try {
      await winMEM.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(MEM_HTML));
      const namesMEM = await winMEM.webContents.executeJavaScript(IC_BOOT + IC_STUB + "\n" + ESC_SRC + "\n" + MEM_SRC + "\n" + MEM_CHECKS, true)
        .catch((e) => { throw new Error("[记忆页权限] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesMEM) console.log("  ✓ " + n);
      console.log(`✅ 前端：记忆页按权限画（共享那条不画删·勾选框和保存按钮不画·搬家卡不画·删了不吞返回值·管理员那页一样不少）${namesMEM.length} 项通过`);
    } finally { if (!winMEM.isDestroyed()) winMEM.destroy(); }

    const winGATE = mkWin({ show: false, width: 1000, height: 900, webPreferences: { offscreen: true } });
    try {
      await winGATE.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(GATE_HTML));
      const namesGATE = await winGATE.webContents.executeJavaScript(IC_BOOT + ESC_SRC + "\n" + GATE_SRC + "\n" + GATE_CHECKS, true)
        .catch((e) => { throw new Error("[设置页权限] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesGATE) console.log("  ✓ " + n);
      console.log(`✅ 前端：设置页按权限画（四页纯管理员的不画·模型只读·个性化只留宠物·安全只留档位·🛡️ 菜单不装成能点的）${namesGATE.length} 项通过`);
    } finally { if (!winGATE.isDestroyed()) winGATE.destroy(); }

    const winAUTH = mkWin({ show: false, width: 900, height: 760, webPreferences: { offscreen: true } });
    try {
      await winAUTH.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(AUTH_HTML));
      const namesAUTH = await winAUTH.webContents.executeJavaScript(IC_BOOT + AUTH_STUBS + "\n" + AUTH_WRAP(AUTH_SRC) + "\n" + AUTH_CHECKS, true)
        .catch((e) => { throw new Error("[登录卡] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesAUTH) console.log("  ✓ " + n);
      console.log(`✅ 前端：登录卡（邀请码有地方填且链接带码直达·自助注册关着也进得来·看一眼密码·二次验证密码对了才问码·待审核/已停用当场说清楚而不是放进去挨 403）${namesAUTH.length} 项通过`);
    } finally { if (!winAUTH.isDestroyed()) winAUTH.destroy(); }

    const winTFA = mkWin({ show: false, width: 760, height: 620, webPreferences: { offscreen: true } });
    try {
      await winTFA.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TFA_HTML));
      const namesTFA = await winTFA.webContents.executeJavaScript(IC_BOOT + TFA_WRAP + "\n" + TFA_CHECKS, true)
        .catch((e) => { throw new Error("[二次验证卡] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesTFA) console.log("  ✓ " + n);
      console.log(`✅ 前端：二次验证卡（密钥验过密码才露脸·画不出二维码也能绑·恢复码只出现这一次·强制时「关闭」当场讲清而不是挨 403）${namesTFA.length} 项通过`);
    } finally { if (!winTFA.isDestroyed()) winTFA.destroy(); }

    const winDEAD = mkWin({ show: false, width: 1100, height: 900, webPreferences: { offscreen: true } });
    try {
      await winDEAD.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(DEAD_HTML));
      const namesDEAD = await winDEAD.webContents.executeJavaScript(IC_BOOT + ESC_SRC + "\n" + DEAD_SRC + "\n" + DEAD_CHECKS, true)
        .catch((e) => { throw new Error("[自动化/资料库 403] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesDEAD) console.log("  ✓ " + n);
      console.log(`✅ 前端：403 不该变成一片白也不该变成一句假成功（自动化整页有话说·侧栏藏掉必挂的入口·资料库一人一份、写也写得进·上传/记笔记失败照实说）${namesDEAD.length} 项通过`);
    } finally { if (!winDEAD.isDestroyed()) winDEAD.destroy(); }

    const winHUB = mkWin({ show: false, width: 1100, height: 900, webPreferences: { offscreen: true } });
    try {
      await winHUB.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HUB_HTML));
      const namesHUB = await winHUB.webContents.executeJavaScript(IC_BOOT + ESC_SRC + "\n" + HUB_SRC + "\n" + HUB_CHECKS, true)
        .catch((e) => { throw new Error("[专家/技能/连接器 权限] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesHUB) console.log("  ✓ " + n);
      console.log(`✅ 前端：专家/技能/插件/连接器四个 Tab——用得了但装不了（成员看得见卡片、没有一颗会 403 的按钮、删失败照实说原因）${namesHUB.length} 项通过`);
    } finally { if (!winHUB.isDestroyed()) winHUB.destroy(); }

    const winSTM = mkWin({ show: false, width: 760, height: 700, webPreferences: { offscreen: true } });
    try {
      await winSTM.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(STREAM_HTML));
      const namesSTM = await winSTM.webContents.executeJavaScript(IC_BOOT + STREAM_STUBS + "\n" + STREAM_SRC + "\n" + STREAM_CHECKS, true)
        .catch((e) => { throw new Error("[流式分段渲染] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesSTM) console.log("  ✓ " + n);
      console.log(`✅ 前端：流式正文分段渲染（已定稿那截不重建·结果跟一次渲染一致·停笔合回整块）${namesSTM.length} 项通过`);
    } finally { if (!winSTM.isDestroyed()) winSTM.destroy(); }

    const winEP = mkWin({ show: false, width: 520, height: 600, webPreferences: { offscreen: true } });
    try {
      await winEP.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ENGPICK_HTML));
      const namesEP = await winEP.webContents.executeJavaScript(IC_BOOT + ENGPICK_STUBS + "\n" + ENGPICK_SRC + "\n" + ENGPICK_CHECKS, true)
        .catch((e) => { throw new Error("[本机引擎选择器] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesEP) console.log("  ✓ " + n);
      console.log(`✅ 前端：本机引擎在跑时的模型选择器（宽度收得住·没有多余的说明长句·不出屏·只有一处可点·按钮换图标）${namesEP.length} 项通过`);
    } finally {
      if (!winEP.isDestroyed()) winEP.destroy();
    }
    // mermaid 语法纠错：拿**真 mermaid 的解析器**验，不是拿字符串跟自己对答案。
    // 真实数据：gen_diagram 37 次调用挂了 7 次（18.9%），七次全是四类机械写法错误。
    // 守两头：错例修前必须真的挂（修前就能过的样本根本不是错例，测了个寂寞）、修后必须真的过；
    // 合法写法本身要能过，且纠错器一个字节都不许动。样本在 test/fixtures/mermaid.js。
    const winMMD = mkWin({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, sandbox: true } });
    const mmdTmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "owb-mmd-"));
    try {
      const { bad: MMD_BAD, ok: MMD_OK } = require("./fixtures/mermaid");
      const { repairMermaid } = require("../diagram");
      // mermaid.min.js 有 2.8MB，data: URL 装不下，落临时文件走 loadFile（跟 browser-render.js 一个路子）
      const mermaidSrc = fs
        .readFileSync(path.join(__dirname, "..", "node_modules", "mermaid", "dist", "mermaid.min.js"), "utf8")
        .replace(/<\/script>/gi, "<\\/script>");
      const page = path.join(mmdTmp, "mmd.html");
      fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><body><script>${mermaidSrc}</script>`);
      await winMMD.loadFile(page);
      await winMMD.webContents.executeJavaScript(IC_BOOT + 
        'mermaid.initialize({ startOnLoad: false, theme: "base", securityLevel: "strict", htmlLabels: false }); "ok"', true);
      const mmdParse = (s) =>
        winMMD.webContents.executeJavaScript(IC_BOOT + 
          `(async()=>{try{await mermaid.parse(${JSON.stringify(String(s))});return "OK";}catch(e){return "ERR "+String((e&&e.message)||e).split("\\n")[0].slice(0,140);}})()`, true);
      const namesM = [];
      for (const [name, src] of MMD_BAD) {
        const before = await mmdParse(src);
        if (before === "OK") throw new Error(`[mermaid纠错] 「${name}」在真 mermaid 里居然是合法的——这条样本不是真错例`);
        const r = repairMermaid(src);
        const after = await mmdParse(r.source);
        if (after !== "OK") throw new Error(`[mermaid纠错] 「${name}」纠错之后真 mermaid 仍然不认：${after}`);
        namesM.push(`${name}：修前挂、修后过（${r.fixes.join("；")}）`);
      }
      for (const [name, src] of MMD_OK) {
        const p = await mmdParse(src);
        if (p !== "OK") throw new Error(`[mermaid纠错] 负向对照「${name}」本身就不合法，当不了对照：${p}`);
        const r = repairMermaid(src);
        if (r.source !== src) throw new Error(`[mermaid纠错] 负向对照「${name}」被纠错器改动了：${r.fixes.join("；")}`);
        namesM.push(`${name}：合法，且纠错器一个字节没动`);
      }
      for (const n of namesM) console.log("  ✓ " + n);
      console.log(`✅ 前端：mermaid 写法纠错在真解析器里过关（四类真实错误改完都能渲染·合法图一个字节没动）${namesM.length} 项通过`);
    } finally {
      if (!winMMD.isDestroyed()) winMMD.destroy();
      try { fs.rmSync(mmdTmp, { recursive: true, force: true }); } catch {}
    }
    const win6 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win6.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(KBD_HTML));
      const names6 = await win6.webContents.executeJavaScript(IC_BOOT + UI00_SRC + "\n" + KBD_CHECKS, true);
      for (const n of names6) console.log("  ✓ " + n);
      console.log(`✅ 前端：键盘可达（侧栏行/成果卡 Tab 得到·回车空格等价点击·按钮不套按钮）${names6.length} 项通过`);
    } finally {
      if (!win6.isDestroyed()) win6.destroy();
    }
    const winSave = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await winSave.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SAVE_HTML));
      const namesSave = await winSave.webContents.executeJavaScript(IC_BOOT + SAVE_STUBS + "\n" + SAVE_SRC + "\n" + SAVE_CHECKS, true)
        .catch((e) => { throw new Error("[存盘] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesSave) console.log("  ✓ " + n);
      console.log(`✅ 前端：存盘失败说人话（连不上/卡住掐掉/网关 HTML/服务端原话/裸 HTTP 码/空响应 六句各不相同·默认落本对话文件夹·取消不吓人·网页端退下载）${namesSave.length} 项通过`);
    } finally {
      if (!winSave.isDestroyed()) winSave.destroy();
    }
    const winCt = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await winCt.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(CONTRAST_HTML));
      const namesCt = await winCt.webContents.executeJavaScript(IC_BOOT + CONTRAST_CHECKS, true)
        .catch((e) => { throw new Error("[\u5bf9\u6bd4\u5ea6] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesCt) console.log("  \u2713 " + n);
      console.log(`\u2705 \u524d\u7aef\uff1a真元素压真底色的对比度 + 热区够不够大 + 勾选框没被撑坏（浅暗两套·每组都带反向对照）${namesCt.length} \u9879\u901a\u8fc7`);
    } finally {
      if (!winCt.isDestroyed()) winCt.destroy();
    }
    // 这一屏必须按真实桌面尺寸开窗：层高用的是 vh，窗口一小断言就没意义了
    const winSet = mkWin({ show: false, width: 1440, height: 940, webPreferences: { offscreen: true } });
    try {
      await winSet.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SETL_HTML));
      const namesSet = await winSet.webContents.executeJavaScript(IC_BOOT + SETL_CHECKS, true)
        .catch((e) => { throw new Error("[\u8bbe\u7f6e\u5f39\u7a97] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesSet) console.log("  \u2713 " + n);
      console.log(`\u2705 \u524d\u7aef\uff1a\u8bbe\u7f6e\u5f39\u7a97\u88c5\u5f97\u4e0b\u4e5f\u5bf9\u5f97\u9f50\uff08\u5c42\u9ad8\u8ddf\u7740\u5c4f\u5e55\u8d70\u00b7\u56fe\u6807\u5217\u548c\u6807\u9898\u540c\u4e00\u5217\u00b7\u4e24\u6761\u90fd\u6709\u53cd\u5411\u5bf9\u7167\uff09${namesSet.length} \u9879\u901a\u8fc7`);
    } finally {
      if (!winSet.isDestroyed()) winSet.destroy();
    }
    const winAB = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await winAB.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(AB_HTML));
      const namesAB = await winAB.webContents.executeJavaScript(IC_BOOT + AB_STUBS + "\n" + AB_SRC + "\n" + AB_CHECKS, true)
        .catch((e) => { throw new Error("[关于页] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesAB) console.log("  \u2713 " + n);
      console.log(`\u2705 \u524d\u7aef\uff1a\u5173\u4e8e\u9875\u8bfb\u4e0d\u5230\u7248\u672c\u53f7\u65f6\u4e0d\u628a undefined \u6446\u5230\u8138\u4e0a\uff08cookie \u8fc7\u671f\u00b7\u6b63\u5e38\u00b7\u6709\u65b0\u7248\u00b7\u67e5\u7ebf\u4e0a\u5931\u8d25\u00b7\u5b57\u6bb5\u6b8b\u7f3a \u4e94\u79cd\u5f62\u72b6\u0020\u002b\u0020\u5347\u7ea7\u547d\u4ee4\u53ea\u5728\u6709\u65b0\u7248\u65f6\u9732\u51fa\u6765\uff09${namesAB.length} \u9879\u901a\u8fc7`);
    } finally {
      if (!winAB.isDestroyed()) winAB.destroy();
    }
    const winTH = mkWin({ show: false, width: 1200, height: 700, webPreferences: { offscreen: true } });
    try {
      await winTH.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TH_HTML));
      const namesTH = await winTH.webContents.executeJavaScript(TH_CHECKS, true)
        .catch((e) => { throw new Error("[产出卡缩略图] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesTH) console.log("  ✓ " + n);
      console.log(`✅ 前端：产出卡缩略图整张看得见（5 种比例·含反向对照）${namesTH.length} 项通过`);
    } finally {
      if (!winTH.isDestroyed()) winTH.destroy();
    }
    const winCTL = mkWin({ show: false, width: 1100, height: 700, webPreferences: { offscreen: true } });
    try {
      await winCTL.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(CTL_HTML));
      const namesCTL = await winCTL.webContents.executeJavaScript(CTL_CHECKS, true)
        .catch((e) => { throw new Error("[控件高度] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesCTL) console.log("  ✓ " + n);
      console.log(`✅ 前端：一行上的控件同高（搜索框/胶囊/次要键/主键/下拉 五种家族·两条反向对照）${namesCTL.length} 项通过`);
    } finally {
      if (!winCTL.isDestroyed()) winCTL.destroy();
    }
    const winPILL = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await winPILL.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PILL_HTML));
      const namesPILL = await winPILL.webContents.executeJavaScript(PILL_CHECKS, true)
        .catch((e) => { throw new Error("[小标记] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesPILL) console.log("  ✓ " + n);
      console.log(`✅ 前端：小标记只有一个尺寸（十三处·含反向对照）${namesPILL.length} 项通过`);
    } finally {
      if (!winPILL.isDestroyed()) winPILL.destroy();
    }
    const winCLIP = mkWin({ show: false, width: 1200, height: 900, webPreferences: { offscreen: true } });
    try {
      await winCLIP.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(CLIP_HTML));
      const namesCLIP = await winCLIP.webContents.executeJavaScript(CLIP_CHECKS, true)
        .catch((e) => { throw new Error("[横切] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesCLIP) console.log("  ✓ " + n);
      console.log(`✅ 前端：封顶的文字块不会把行横切开（四处·含反向对照）${namesCLIP.length} 项通过`);
    } finally {
      if (!winCLIP.isDestroyed()) winCLIP.destroy();
    }
    const winICO = mkWin({ show: false, width: 1200, height: 900, webPreferences: { offscreen: true } });
    try {
      await winICO.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ICO_HTML));
      const namesICO = await winICO.webContents.executeJavaScript(ICO_CHECKS, true)
        .catch((e) => { throw new Error("[纯图标钮] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesICO) console.log("  ✓ " + n);
      console.log(`✅ 前端：纯图标钮只剩两档（十二颗·挤不扁·含反向对照）${namesICO.length} 项通过`);
    } finally {
      if (!winICO.isDestroyed()) winICO.destroy();
    }
    const winSC = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await winSC.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SC_HTML));
      const namesSC = await winSC.webContents.executeJavaScript(IC_BOOT + SC_STUBS + "\n" + SC_SRC + "\n" + SC_CHECKS, true);
      for (const n of namesSC) console.log("  ✓ " + n);
      console.log(`✅ 前端：快捷键改绑不再扣着键盘不放（点别处/点取消/Esc/面板重画 四个出口·冲突照拦·正路照存）${namesSC.length} 项通过`);
    } finally {
      if (!winSC.isDestroyed()) winSC.destroy();
    }

    // ── 产出卡缩略图（thumb.js）──────────────────────────────────────────
    // 这一屏不开窗口：nativeImage 在主进程里就有，而 thumb.js 要验的恰恰是
    // 「真拿一张大图缩出来」和「缩不动的时候老老实实认输」。桌面版 server.js 就跑在
    // 这个进程里（electron-main.js 那句 require("./server.js")），跑法跟线上一致。
    {
      const os = require("os");
      const { nativeImage } = require("electron");
      const T = require("../thumb");
      const namesTH = [];
      const okTH = (name, cond, extra) => {
        if (!cond) throw new Error("[缩略图] " + name + (extra === undefined ? "" : "（实际：" + extra + "）"));
        namesTH.push(name);
      };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-thumb-"));
      const cache = path.join(dir, "cache");
      // 造一张真图。用噪点：纯色 PNG 压完只有几百字节，过不了 THUMB_MIN_BYTES 那道门槛，
      // 那这一屏就全在测「文件太小不缩」，等于什么都没测
      const noisePng = (w, h) => {
        const buf = Buffer.allocUnsafe(w * h * 4);
        let x = 123456789;
        for (let i = 0; i < buf.length; i += 4) {
          x = (x * 1103515245 + 12345) & 0x7fffffff;
          buf[i] = x & 255; buf[i + 1] = (x >> 8) & 255; buf[i + 2] = (x >> 16) & 255; buf[i + 3] = 255;
        }
        return nativeImage.createFromBuffer(buf, { width: w, height: h }).toPNG();
      };
      try {
        const wide = path.join(dir, "海报.png");
        fs.writeFileSync(wide, noisePng(1600, 1000));
        const srcBytes = fs.statSync(wide).size;
        okTH("先验料：造出来的图确实过了「太小就别缩」那道门槛（" + Math.round(srcBytes / 1024) + " KB）",
          srcBytes > T.THUMB_MIN_BYTES, srcBytes);

        const out = T.thumbFile(wide, 320, cache);
        okTH("大图真缩得出来一张缩略图", !!out && fs.existsSync(out), String(out));
        const got = nativeImage.createFromPath(out).getSize();
        okTH("缩完长边就是要的 320（宽图按宽收）", got.width === 320, got.width + "×" + got.height);
        okTH("高按比例跟着走，不是拉变形的", Math.abs(got.height - 200) <= 1, got.height);
        const outBytes = fs.statSync(out).size;
        okTH("体积真降下来了（" + Math.round(srcBytes / 1024) + " KB → " + Math.round(outBytes / 1024) + " KB，"
          + (srcBytes / outBytes).toFixed(1) + " 倍）；这一条要是不成立，这整套东西就白做了",
          outBytes * 4 < srcBytes, outBytes);
        okTH("出来的是能解的 PNG，不是一个空壳（浏览器解不了就等于卡片上一个灰方框）",
          fs.readFileSync(out).slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          && !nativeImage.createFromPath(out).isEmpty());

        // 高图：短边是宽，得按高收，不然一张 2800×7032 的长图缩完还有 800 px 高
        const tall = path.join(dir, "长图.png");
        fs.writeFileSync(tall, noisePng(600, 1500));
        const tOut = T.thumbFile(tall, 320, cache);
        const tSz = nativeImage.createFromPath(tOut).getSize();
        okTH("长图按高收，长边同样是 320（不然 2800×7032 缩完还有八百多 px 高）",
          tSz.height === 320 && tSz.width < 320, tSz.width + "×" + tSz.height);

        // 缓存：第二趟不许重缩。往缓存文件里塞个记号，再要一次还是它，就说明没重新编码
        fs.writeFileSync(out, Buffer.concat([fs.readFileSync(out), Buffer.from("MARK")]));
        const again = T.thumbFile(wide, 320, cache);
        okTH("同一张图同一个尺寸只缩一次，第二趟直接给缓存",
          again === out && fs.readFileSync(again).slice(-4).toString() === "MARK", String(again));

        // 缓存键跟着文件走：文件改写了就得换一份，不能把过期的缩略图发出去
        fs.writeFileSync(wide, noisePng(1600, 1001));
        const afterEdit = T.thumbFile(wide, 320, cache);
        okTH("文件被改写之后换一份缓存，不会发一张过期的缩略图出去",
          afterEdit && afterEdit !== out, String(afterEdit));
        okTH("反向对照：换个尺寸也是另一份缓存（不然 160 和 640 会互相盖）",
          T.thumbFile(tall, 160, cache) !== tOut);

        // ── 以下全是「缩不动」的路。每一条都必须返回 null，让调用方原样发原图 ──
        // 缩略图是锦上添花，绝不许因为它让一张图显示不出来
        okTH("尺寸不在档位里 → 认输（挡住「?thumb=任意数」把缓存目录撑爆）", T.thumbFile(wide, 321, cache) === null);
        okTH("  ← 反向对照：三个档位本身是认的", [160, 320, 640].every((w) => T.thumbFile(wide, w, cache)));
        okTH("thumb= 后面不是数字 → 认输（parseInt 出 NaN）", T.thumbFile(wide, NaN, cache) === null);
        const svgF = path.join(dir, "图表.svg");
        fs.writeFileSync(svgF, "<svg xmlns='http://www.w3.org/2000/svg'>" + "<rect/>".repeat(30000) + "</svg>");
        okTH("svg → 认输（矢量本来就小，栅格化反而更大更糊）", T.thumbFile(svgF, 320, cache) === null);
        const small = path.join(dir, "小图.png");
        fs.writeFileSync(small, noisePng(1200, 800).slice(0, 4096));   // 体积小，内容也是坏的
        okTH("文件比 100 KB 还小 → 认输（缩一趟省下的还不够那次往返）", T.thumbFile(small, 320, cache) === null);
        const tiny = path.join(dir, "本来就小.png");
        // 贴着 320 取像素，再在 IEND 后面垫一段（PNG 解码器读到 IEND 就停，图照样解得出来）。
        // 噪点图压到这个尺寸只有 80 KB 出头，过不了 100 KB 的门槛 —— 那下面那条就会绿在
        // 「文件太小」这个理由上，而不是「图本来就比要的还小」，等于没测
        fs.writeFileSync(tiny, Buffer.concat([noisePng(318, 316), Buffer.alloc(80 * 1024, 0x5a)]));
        okTH("先验料：这张图体积够大、但像素本来就不到 320（" + Math.round(fs.statSync(tiny).size / 1024) + " KB）",
          fs.statSync(tiny).size > T.THUMB_MIN_BYTES);
        okTH("图本来就比要的还小 → 认输（缩了只会更糊）", T.thumbFile(tiny, 320, cache) === null);
        const broken = path.join(dir, "坏图.png");
        fs.writeFileSync(broken, Buffer.alloc(200 * 1024, 0x41));      // 够大，但解不出来
        okTH("解不出来的图 → 认输，不抛（一张坏图不许把整个请求带崩）", T.thumbFile(broken, 320, cache) === null);
        okTH("文件根本不在 → 认输，不抛", T.thumbFile(path.join(dir, "没有这个.png"), 320, cache) === null);
        const blocked = path.join(dir, "占位");                          // 缓存目录的位置上摆一个普通文件
        fs.writeFileSync(blocked, "x");
        okTH("缓存目录写不进去 → 认输，不抛（磁盘满 / 只读挂载 / 权限不对都走这条）",
          T.thumbFile(wide, 640, path.join(blocked, "thumbs")) === null);

        for (const n of namesTH) console.log("  ✓ " + n);
        console.log(`✅ 前端：产出卡缩略图（真缩一张 320 出来·宽图按宽长图按高·体积四倍以上地降·缓存只缩一次·文件改了换一份·九条缩不动的路一律原样发原图）${namesTH.length} 项通过`);
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
    // 无限画布的多选：焦点收不上来的话，Delete / ⌘A / Escape 全是哑的
    const winCK = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await winCK.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(CANVASKEY_HTML));
      const namesCK = await winCK.webContents.executeJavaScript(IC_BOOT + CANVASKEY_STUBS + "\n" + CANVASKEY_SRC + "\n" + CANVASKEY_CHECKS, true);
      for (const n of namesCK) console.log("  ✓ " + n);
      console.log(`✅ 前端：无限画布多选的键盘出口（点一下就收焦点·Escape 退框选·⌘A 全选·Delete 批量删并落盘·打字时一概不抢）${namesCK.length} 项通过`);
    } finally { if (!winCK.isDestroyed()) winCK.destroy(); }
  } catch (e) {
    console.error("❌ 前端测试失败:", e && e.message ? e.message : e);
    const errs = RENDERER_LOG.filter((m) => m.level === "error" || m.level === "3");
    for (const m of (errs.length ? errs : RENDERER_LOG.slice(-5))) console.error("   渲染进程 console：" + m.message + (m.line ? "（行 " + m.line + "）" : ""));
    code = 1;
  } finally {
    clearTimeout(WATCHDOG);
    if (!win.isDestroyed()) win.destroy();
    app.exit(code);
  }
});
