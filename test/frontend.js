"use strict";
/**
 * 前端测试 — 在 Electron 的真 Chromium 里跑，验证 public/svgfig.js。
 * SVG 清洗要的是"浏览器真正解析出来的树"，用正则或者假 DOM 测等于没测，
 * 所以这里借项目已有的 electron 开一个隐藏窗口，把断言放进渲染进程执行。
 * 由 test/e2e.js 拉起；electron 没装（纯服务端部署）就整体跳过。
 * 单独运行：npx electron test/frontend.js
 */

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
const INDEX_CSS = (() => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!m) throw new Error("public/index.html 里找不到内联 <style>，前端测试没法验真样式");
  return m[1];
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
  + "<body><div class='fp-filter' id='fp-filter' hidden></div><div id='file-list'></div></body>";

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

  // ── 只保留一层开关。用户原话（旧版两层「查看所有变更」嵌套）：「点击▸ 本回合产出 (2) 怎么没有反应啊」——
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
    // 用户原话：「这些图片怎么不渲染啊，现在看着比较丑啊」
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

  // ── 「不在这份列表里」≠「已经没了」。用户原话：「换了一个文件夹怎么有些文件就给我显示已删除了啊」——
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

  // ── 出过卡的文件不许在下面再列一遍。用户原话：
  //    「为什么怎么又是有图标又是看到文件列表的啊，不需要看到文件列表啊」
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
  //    外加一个 .pptx。用户原话：「pptx 格式文件都没重点标记下啊」——唯一要交的那份东西
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
  "window.uploads = []; window.toasts = []; window.sessionId = 's_test_1';",
  "window.fetch = async (url, init) => {",
  "  if (url === '/api/upload') { window.uploads.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }",
  "  return { ok: true, json: async () => [] };",
  "};",
  'window.toast = (m, i) => window.toasts.push((i ? "[" + i + "] " : "") + String(m));',
  "window.renderFiles = () => {};",
  "window.syncInputHl = () => {};",
  "window.syncSendBtn = () => {};",
  "window.inputEl = document.getElementById('input');",
].join("\n");

const ATTACH_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const chips = () => [...document.getElementById("attach-chips").children];
  const B64PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const fire = (target, type, key, data) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, key, { value: data });
    target.dispatchEvent(ev);
    return ev;
  };

  // ---- 1. 粘贴截图：存进工作空间、chip 带缩略图、二进制一个字节都不能变 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([bytes(B64PNG)], "image.png", { type: "image/png" }));
    const ev = fire(document.body, "paste", "clipboardData", dt);
    await tick();
    const up = uploads.at(-1);
    ok("粘贴截图会上传", !!up, "根本没发上传请求");
    // 不带会话 id 的话服务端只能把它扔进工作空间根目录，用户传的素材和这轮的产出就此分家
    ok("上传带上了会话 id", up.session === "s_test_1", JSON.stringify(up.session));
    ok("剪贴板的通用名换成时间戳", /^粘贴图片_\\d{4}_\\d{6}\\.png$/.test(up.name), up.name);
    ok("图片二进制没被改坏", up.data_b64 === B64PNG);
    ok("chip 带缩略图", !!document.querySelector("#attach-chips img.attach-thumb"));
    ok("粘贴被接管（没再往输入框里塞）", ev.defaultPrevented);
  }

  // ---- 2. 同一秒连贴两张：撞名要编号，不能悄悄覆盖掉第一张 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([bytes(B64PNG)], "image.png", { type: "image/png" }));
    fire(document.body, "paste", "clipboardData", dt);
    await tick();
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
    await tick();
    ok("短文本不当附件", !ev.defaultPrevented && uploads.length === before);
  }

  // ---- 4. 大段文字：落成 txt 附件，输入框不被撑爆，中文不能乱码 ----
  {
    const big = "第一行是报错：\\n" + "巨长的日志".repeat(600);
    inputEl.value = "帮我看看这个";
    const dt = new DataTransfer();
    dt.setData("text/plain", big);
    const ev = fire(inputEl, "paste", "clipboardData", dt);
    await tick();
    const up = uploads.at(-1);
    ok("大段文字落成 txt", /^粘贴文本_\\d{4}_\\d{6}\\.txt$/.test(up.name), up.name);
    const back = new TextDecoder().decode(bytes(up.data_b64));
    ok("中文原文一字不差", back === big, "长度 " + back.length + " vs " + big.length);
    ok("输入框没被撑爆", inputEl.value === "帮我看看这个" && ev.defaultPrevented);
    ok("chip 上能看见开头几个字", /第一行是报错/.test(chips().at(-1).title || ""));
  }

  // ---- 5. 拖文件进窗口 ----
  {
    const dt = new DataTransfer();
    dt.items.add(new File([new TextEncoder().encode("hello")], "笔记.md", { type: "text/markdown" }));
    fire(document.body, "drop", "dataTransfer", dt);
    await tick();
    ok("拖进来的文件按原名上传", uploads.at(-1).name === "笔记.md", uploads.at(-1).name);
  }

  // ---- 6. 拖一小段选中的文字：插在光标处，别把写了一半的话顶到后面 ----
  {
    inputEl.value = "开头结尾";
    inputEl.selectionStart = inputEl.selectionEnd = 2;
    const before = uploads.length;
    const dt = new DataTransfer();
    dt.setData("text/plain", "插进来");
    fire(document.body, "drop", "dataTransfer", dt);
    await tick();
    ok("拖进来的短文字插在光标处", inputEl.value === "开头插进来结尾", inputEl.value);
    ok("短文字不当附件", uploads.length === before);
  }

  // ---- 7. 拖一大段文字：和粘贴走同一条路 ----
  {
    const dt = new DataTransfer();
    dt.setData("text/plain", "整篇文档".repeat(700));
    fire(document.body, "drop", "dataTransfer", dt);
    await tick();
    ok("拖进来的大段文字也落成 txt", /^粘贴文本_\\d{4}_\\d{6}(-\\d+)?\\.txt$/.test(uploads.at(-1).name), uploads.at(-1).name);
  }

  // ---- 8. 发消息时附件名随消息一起走，输入框里永远不出现这些标记 ----
  {
    const n = chips().length;
    const out = composeOutgoing();
    ok("附件名拼进了消息", (out.match(/已上传文件：/g) || []).length === 1 && n > 0);
    ok("发完 chip 清空", chips().length === 0);
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
  ok("👍 带上了用户原话", last().body.task === "帮我写个周报");
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
  // 收尾那两件事要用的外部符号。这两条正则跟 app-01.js 里的真源一字不差（e2e 的 testOutputArrivalStatic 会比对字面量）
  "var OFFICE_RE = /\\.(doc|ppt|xls)$/i;",
  "var SCAFFOLD_RE = /^(PROGRESS|TODO|NOTES?|README)\\.(md|txt)$/i;",
  "var pvPanel = document.getElementById('preview-panel');",
  "var pvCurrent = null; var pvClosedAt = 0;",
  "window.PV = []; var previewFile = (n) => { window.PV.push(n); pvPanel.classList.add('show'); pvCurrent = n; };",
  "window.fetch = async () => ({ ok: true, json: async () => ({}) });",
].join("\n");

// ================= 本机引擎在跑时的模型选择器 =================
// 用户原话：「切换到本地 claudecode 的时候这个 UI 有点丑」。真毛病是那段说明塞在 .mi 里，
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
  const why = menu.querySelector(".ep-why");
  ok("说明文字是会换行的（真样式）", getComputedStyle(why).whiteSpace === "normal", getComputedStyle(why).whiteSpace);
  ok("说明确实排成了好几行，而不是一条横的", why.getBoundingClientRect().height > 30, Math.round(why.getBoundingClientRect().height) + "px");
  ok("引擎名和它的模型都写清楚了", /本机 Claude Code/.test(menu.querySelector(".ep-name").textContent) && /claude-opus-5/.test(menu.querySelector(".ep-model").textContent));
  ok("「不花 API 额度」是这里最该看见的一句", /不花 API 额度/.test(menu.querySelector(".ep-free").textContent));
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
// 用户原话：「goal 模式你也给我做好啊」。这里验的是这张卡有没有把三件事说清楚：
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

// ================= 助理设置页：分区 + 双栏卡片 + 连接/取消连接 =================
// 用户原话「太乱了，没办法自己调」。这里验的是行为不是措辞：连上的卡真收起（display:none）、
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
  "function joinRel(base, rel) { return rel; }",
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
  //    用户原话：「怎么出现了链接太长，然后要移动才能看到全部的显示情况」
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
const NAV0 = APP01_NAV.indexOf('const PLATFORM_ONLY_VIEWS = ["autom", "eval"];');
const NAV1 = APP01_NAV.indexOf("// 这个选择器只管「当前对话」用哪个模型");
const AUT0 = APP03_AT.indexOf("async function renderAutomPage() {");
const AUT1 = APP03_AT.indexOf("function renderAutomTplPicker(box) {");
const RUN0 = APP03_AT.indexOf("async function renderAutomRuns(page) {");
const RUN1 = APP03_AT.indexOf("// ================= 资料库页（左侧文件树");
const LIB0 = APP04_LIB.indexOf("async function renderLibPage() {");
const LIB1 = APP04_LIB.indexOf("// ================= 专家 · 技能 · 连接器");
for (const [a, b, why] of [[NAV0, NAV1, "app-01.js 的 syncNavByRole"], [AUT0, AUT1, "app-03.js 的 renderAutomPage"],
  [RUN0, RUN1, "app-03.js 的 renderAutomRuns"], [LIB0, LIB1, "app-04.js 的 renderLibPage/renderLibPreview"]])
  if (a < 0 || b <= a) throw new Error(why + " 找不到了（改名/挪走？），自动化/资料库权限测试没法定位真源码");
const DEAD_SRC = APP01_NAV.slice(NAV0, NAV1) + "\n" + APP03_AT.slice(AUT0, AUT1) + "\n" + APP03_AT.slice(RUN0, RUN1)
  + "\n" + APP04_LIB.slice(LIB0, LIB1);
const DEAD_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "</style><body>"
  + "<div class='side-nav top'>"
  + "<div class='item' data-view='hub'>专家</div><div class='item' data-view='autom'>自动化</div>"
  + "<div class='item' data-view='prompts'>参考模板库</div><div class='item' data-view='lib'>资料库</div>"
  + "<div class='item' data-view='eval'>评测</div></div>"
  + "<div class='assist-page' id='assist-page'></div></body>";
const DEAD_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };

  // 测试页是 data: URL（不透明源），localStorage 一碰就抛；塞个内存版
  try { localStorage.getItem("wb_lib_recent"); } catch {
    const mem = {};
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; },
    } });
  }
  // 这几页周边的零碎（表单、模版选择器、CSV/Markdown 渲染）不是这次要测的，喂桩
  window.automState = { tab: "tasks", q: "", bulk: false, sel: new Set(), showForm: false, editing: null };
  window.libState = { q: "", pick: null };
  window.cronToHuman = () => "每天 9:00";
  window.escInline = (s) => String(s == null ? "" : s);
  window.renderAutomForm = () => {};
  window.renderAutomTplPicker = () => {};
  window.csvToTable = () => "<table></table>";
  window.renderMd = (t) => String(t);
  window.fpath = (n) => String(n == null ? "" : n).split("/").map(encodeURIComponent).join("/");
  window.pageKind = "autom";
  window.refreshSettingsCache = async () => {};
  window.modalCalls = [];
  window.openModal = (k, t) => window.modalCalls.push(k + ":" + (t || ""));
  window.toasts = [];
  // 记图标名：仓库里一律 toast(文字, "circle-x")，断言要验的是「配了哪个图标」
  window.toast = (m, i) => window.toasts.push((i ? "[" + i + "] " : "") + String(m));
  window.confirm = () => true;

  const FORBID = { error: "这块是服务器级设置，归平台管理员管", platform_only: true };
  let owner = false, denyRead = false, uploadResp = { ok: true, name: "a.md" };
  const posts = [];
  window.fetch = (url, opt) => {
    const method = (opt && opt.method) || "GET";
    if (method !== "GET") posts.push({ url, method, body: opt && opt.body ? JSON.parse(opt.body) : null });
    const j = (v, code) => Promise.resolve({ ok: !code || code < 400, status: code || 200, json: () => Promise.resolve(v), text: () => Promise.resolve("") });
    if (url === "/api/schedules") return denyRead ? j(FORBID, 403) : j([{ id: "s1", name: "早报", task: "发早报", cron: "0 9 * * *", enabled: true }]);
    if (url.startsWith("/api/schedules/runs")) return denyRead ? j(FORBID, 403) : j([{ at: "2026-09-11T09:00:00Z", name: "早报", by: "定时", ms: 3000, result: "成功" }]);
    if (url === "/api/library") return denyRead ? j(FORBID, 403) : j({ files: [{ name: "手册.md", size: 2048, mtime: "2026-09-01T00:00:00Z" }], notes: [{ id: "n1", text: "老板喜欢短句", at: "2026-09-01T00:00:00Z" }] });
    if (url === "/api/files") return j([]);
    if (url === "/api/library/upload") return owner ? j(uploadResp, uploadResp.ok ? 200 : 403) : j(FORBID, 403);
    if (url.startsWith("/api/library/note")) return owner ? j({ ok: true }) : j(FORBID, 403);
    if (url.startsWith("/api/library/file/")) return owner ? j({ ok: true }) : j(FORBID, 403);
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
  ok("侧栏：「资料库」照留（他的 agent 本来就读得到，只是写不了）", shown("lib"));
  ok("侧栏：「专家」「参考模板库」一个没动", shown("hub") && shown("prompts"));
  window.settingsCache = { platform_owner: true };
  syncNavByRole();
  ok("反向对照：平台管理员五个入口一个不少", shown("autom") && shown("eval") && shown("lib") && shown("hub") && shown("prompts"));

  // ④ 资料库：成员只读
  window.settingsCache = { platform_owner: false };
  window.libState = { q: "", pick: null };
  await renderLibPage();
  ok("资料库：成员照样看得到共享资料（读不该拦）", html().includes("手册.md"), html().slice(0, 200));
  ok("资料库：不画「＋ 上传」", !page.querySelector("#lb-up"));
  ok("资料库：写着「只读」，不装成他自己的文档", html().includes("只读") && html().includes("共享资料"));

  // 真读不成的时候（老服务器、或者以后又把读拦回去），别说「还没有参考资料」——那是句瞎话，
  // 用户会当成自己没传过东西，而真相是这一趟根本没读成
  denyRead = true;
  window.libState = { q: "", pick: null };
  await renderLibPage();
  ok("资料库：读不成就说读不成，不装成「还没有参考资料」",
     html().includes("归平台管理员管") && !html().includes("还没有参考资料"), html().slice(0, 200));
  denyRead = false;
  await renderLibPage(); // 错误页把 #lb-prev 也一起收了，下面还要用，先画回来

  window.libState.pick = { src: "notes", name: "" };
  await renderLibPreview(page.querySelector("#lb-prev"), { notes: [{ id: "n1", text: "老板喜欢短句", at: "2026-09-01T00:00:00Z" }] });
  ok("灵感笔记：成员不画输入框和「保存」", !page.querySelector("#lb-note") && !page.querySelector("#lb-note-save"));
  ok("灵感笔记：成员不画每条后面的「删除」", !page.querySelector("a[data-nid]"));
  ok("灵感笔记：笔记内容照样看得到", html().includes("老板喜欢短句"));
  window.modalCalls = [];
  page.querySelector("#lb-to-mem").onclick({ preventDefault() {} });
  ok("灵感笔记：给了一条他真能走的路（去记忆页）", window.modalCalls.join("|") === "settings:memory", window.modalCalls.join("|"));

  // ⑤ 反向对照：平台管理员这一页，上传/记笔记/删除一样不少
  window.settingsCache = { platform_owner: true };
  owner = true;
  window.libState = { q: "", pick: null };
  await renderLibPage();
  ok("反向对照：「＋ 上传」在", !!page.querySelector("#lb-up"));
  ok("反向对照：写的是「我的文档」不是「只读」", html().includes("我的文档") && !html().includes("共享资料"));
  window.libState.pick = { src: "notes", name: "" };
  await renderLibPreview(page.querySelector("#lb-prev"), { notes: [{ id: "n1", text: "老板喜欢短句", at: "2026-09-01T00:00:00Z" }] });
  ok("反向对照：输入框、「保存」、每条的「删除」都在", !!page.querySelector("#lb-note") && !!page.querySelector("#lb-note-save") && !!page.querySelector("a[data-nid]"));

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
  owner = false; // 后端这一趟拒
  window.libState.pick = { src: "notes", name: "" };
  await renderLibPreview(page.querySelector("#lb-prev"), { notes: [{ id: "n1", text: "老板喜欢短句", at: "2026-09-01T00:00:00Z" }] });
  page.querySelector("#lb-note").value = "新灵感";
  window.toasts = [];
  await page.querySelector("#lb-note-save").onclick();
  ok("记笔记被拒：说出来，不再是「输入框一清，笔记没了」", window.toasts.join("|").includes("归平台管理员管"), window.toasts.join("|"));
  window.toasts = [];
  await page.querySelector("a[data-nid]").onclick({ preventDefault() {} });
  ok("删笔记被拒：一样说出来", window.toasts.join("|").includes("归平台管理员管"), window.toasts.join("|"));

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
  window.confirm = () => true;
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
// 用户原话是「切换失败怎么还切换失败了啊」。根子不在那句提示，在于这一整屏都是照平台管理员画的：
// 多人服务器上的普通成员照样看到 12 个标签页，其中「联网搜索 / 自进化 / 数据 / 助理设置」四页
// 从头到尾没有一样是他的；模型页那排单选钮存的是全局默认、个性化页那两张卡是全服务器共用一份、
// 安全页八张卡全是服务器策略。点哪一颗都是 403。这一组把这四页在真 Chromium 里画出来数控件，
// 每条都配一条平台管理员的反向对照——只删控件不写反向对照，把整页删空也能全绿。
const SET0 = APP05.indexOf("const SETTING_CATS = [");
const SET1 = APP05.indexOf("/* ───────────────────────── 图 / 视频 / 配音 / 看图"); // 连 saveSettings/lastSaveError 一起切进来，那也是真源
// 四路媒体模型那一大块（渠道表 + 能力卡 + 下拉选型）就在 renderModelsPane 前面，
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
  window.confirm = () => true;

  let owner = false, canSwitch = false, posts = [];
  // 渠道表在几组断言中间要换一批（验副标题和「第 N 个」），所以拎出来当变量
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
      models: [{ name: "主力", model: "gpt-5.2", api_key: "x", channel: "or" }, { name: "备用", model: "claude-sonnet-5", api_key: "y", channel: "or" }],
      media_models: [],
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
    if (url === "/api/provider-models") return j({ ok: false, why: "测试里不出网", models: [] });
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

  // ① 导航：四个纯服务器级的标签页不画给成员
  owner = false;
  await renderSettings("models");
  const memberCats = navCats();
  ok("成员的设置页里没有「联网搜索 / 自进化 / 数据 / 助理设置」这四页（点进去每一颗按钮都是 403）",
    !["search", "evolve", "data", "im"].some((k) => memberCats.includes(k)), memberCats.join(","));
  ok("混着他自己东西的那几页留着（模型看得到有哪些、安全看得到档位、个性化里有他的宠物）",
    ["models", "agent", "security", "persona", "memory", "shortcuts", "look", "about"].every((k) => memberCats.includes(k)), memberCats.join(","));
  await renderSettings("data");
  ok("从旧深链跳进一个已经不画的页，退回第一页，不留一屏空白", activeCat() && activeCat().cat === "models", JSON.stringify(activeCat()));
  owner = true;
  await renderSettings("models");
  ok("反向对照：平台管理员 12 页一个不少", navCats().length === 12 && navCats().includes("data"), navCats().join(","));

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
  ok("四路媒体模型：成员这儿没有默认单选钮，只有一句人话",
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
  ok("反向对照：平台管理员那排单选钮、行尾 ⋯、渠道增删改和四路媒体一样不少",
    !!mpo.querySelector("input[name=active]") && !!mpo.querySelector(".row-more") && !!mpo.querySelector("[data-cedit]")
    && !!mpo.querySelector(".ca-new") && !!mpo.querySelector("#prov-list") && !!mpo.querySelector("#pf-new")
    && !!mpo.querySelector("[data-pedit]") && mpo.querySelectorAll(".ch-head[data-cap]").length === 4,
    "渠道表 " + !!mpo.querySelector("#prov-list") + " · 添加模型 " + !!mpo.querySelector(".ca-new") + " · 能力卡 " + mpo.querySelectorAll(".ch-head[data-cap]").length);
  // 一把 Key 挂两个模型：整屏的行数应该比「每条模型摊一行」少——这是 #96 要的那个「不密」
  ok("两个模型折在一个渠道卡里，「去拿 Key」这类提示全屏只出现一次，不是一条模型一遍",
    mpo.querySelectorAll("#prov-list .ch-card").length === 1 && mpo.querySelectorAll("#prov-list .mrow").length === 2
    && (mpo.textContent.match(/去拿 Key/g) || []).length === 1,
    "渠道卡 " + mpo.querySelectorAll("#prov-list .ch-card").length + " · 模型行 " + mpo.querySelectorAll("#prov-list .mrow").length);

  // ②-bis 用户那两句话得同时成立：「没有设置 apikey 的渠道不要显示」+「然后要给地方去显示啊」。
  // 只做前半句就是把渠道藏死，人再也找不到去哪儿填；只做后半句就是原来那堵十来家服务商的墙。
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
  // 填的地方藏在 ⋯ → 编辑渠道 里，用户原话「设置里面都没有填 apikey 的地方啊」
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
  mpoR.querySelector('.ck-input[data-chan="or"]').value = "   ";
  await mpoR.querySelector('.ck-save[data-chan="or"]').onclick();
  ok("反向对照：把 Key 清空再点保存，不存也不假装成功，直说「Key 是空的」",
    !posts.length && window.toasts.join("|").includes("Key 是空的"),
    JSON.stringify(window.toasts) + " · 发出去 " + posts.length + " 次");

  // 四路媒体也收起来了：默认一路一行，说明和表单都在折叠里，点开才出来
  ok("看图 / 画图 / 视频 / 配音 默认全折着，四段说明不再一起摊在屏上",
    !mpo.querySelector(".mm-new") && !mpo.querySelector(".mm-form")
    && !/你粘贴（⌘V）或拖进来的截图/.test(mpo.textContent) && /还没配/.test(mpo.textContent),
    "添加钮 " + mpo.querySelectorAll(".mm-new").length + " · 表单 " + mpo.querySelectorAll(".mm-form").length);
  mpo.querySelector('.ch-head[data-cap="image"]').onclick();
  const mpo2 = mBody.querySelector("#settings-pane");
  ok("点开「画图」那一路：说明、已配模型、添加钮都出来了，另外三路还收着",
    mpo2.querySelectorAll(".mm-new").length === 1 && mpo2.querySelector(".mm-new").dataset.cap === "image"
    && mpo2.textContent.includes("/images/generations") && !/你粘贴（⌘V）或拖进来的截图/.test(mpo2.textContent),
    "展开了 " + mpo2.querySelectorAll(".mm-new").length + " 路");
  // 媒体那一节的小标题不在 .card-item 里，字重得自己带；图标跟字之间也得留条缝，
  // 不然渲染出来是「⊠看图」，读着像乱码而不是图标
  const secT = mpo2.querySelector(".sec-t");
  ok("「看图 / 画图 / 视频 / 配音」是个真小标题：字重 600，图标跟字之间有缝",
    !!secT && !!secT.querySelector(".i") && getComputedStyle(secT).fontWeight === "600"
    && parseFloat(getComputedStyle(secT).columnGap) >= 4,
    "字重 " + (secT && getComputedStyle(secT).fontWeight) + " · 缝 " + (secT && getComputedStyle(secT).columnGap));

  // ②-ter 卡头那行副标题：预置渠道的名字本来就是这家的中文名，再印一遍就是同一个词写两遍；
  // 而同一家开两个号（用户原话「openrouter 怎么也有两个啊」）得看得出谁是谁
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
  // 用户原话：「怎么出现了链接太长，然后要移动才能看到全部的显示情况」。
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

  // ---- 1. 结构：四个分区、双栏、卡数 ----
  const secs = [...pane.querySelectorAll(".im-sec")];
  const titles = secs.map((x) => x.querySelector(".im-sec-h b").textContent).join("|");
  ok("四个分区按序", titles === "远程指挥|结果推送|飞书增强|上下文管理", titles);
  const lefts = new Set([...secs[0].querySelectorAll(".im-card")].map((c) => Math.round(c.getBoundingClientRect().left)));
  ok("双栏是真排出来的（卡片落在两个不同的 x 上）", lefts.size === 2, [...lefts].join(","));
  ok("远程指挥 5 张 / 结果推送 3 张 / 飞书增强 2 张", [5, 3, 2].every((n, i) => secs[i].querySelectorAll(".im-card").length === n));
  const card = (k) => pane.querySelector('[data-ch="' + k + '"]');
  const fsC = card("feishu"), qq = card("qq"), wb = card("wecom_bot"), dt = card("dingtalk"), wx = card("wechat_ilink"), wca = card("wecom_app");

  // ---- 2. 状态决定收起/摊开/按钮 ----
  ok("连上的飞书卡：绿灯「已连接」", fsC.querySelector(".im-st").classList.contains("ok") && fsC.querySelector(".im-st em").textContent === "已连接");
  const fsLink = fsC.querySelector(".im-src a.get-key");
  ok("飞书卡有「去开放平台」直达链接：https + 新窗口", fsLink && fsLink.href.startsWith("https://open.feishu.cn/") && fsLink.target === "_blank" && fsLink.rel === "noopener" && fsLink.textContent.includes("开放平台"), fsLink && fsLink.outerHTML);
  ok("QQ / 企微应用卡也有直达链接，推送类（企微群/钉钉/Webhook）没有（凭证在群里拿，没网页可跳）", qq.querySelector("a.get-key") && wca.querySelector("a.get-key") && !wb.querySelector("a.get-key") && !dt.querySelector("a.get-key") && !card("webhook").querySelector("a.get-key"));
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
  ok("配了 webhook 的推送卡亮绿", wb.classList.contains("on") && wb.querySelector(".im-st em").textContent === "已配置");
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
  // 上下文管理那两张静态卡以前是不折叠的，现在跟别的卡一个待遇——用户说的是「其他的也是默认收起来」
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
  // 红字不是看 class：setMsg 直接写 style.color，所以拿一个探针把 --wb-err-text 解析出来比
  const resolved = (v) => { const d = document.createElement("div"); d.style.color = "var(" + v + ")"; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  ok("测活失败：红叉 + 红字说明", rIcon(wca.querySelector('[data-r="wecom_app"]')) === "#i-circle-x" && getComputedStyle(wca.querySelector('[data-r="wecom_app"]')).color === resolved("--wb-err-text"), wca.querySelector('[data-r="wecom_app"]').innerHTML.slice(0, 90) + " | 色 " + getComputedStyle(wca.querySelector('[data-r="wecom_app"]')).color + " vs " + resolved("--wb-err-text"));
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
  ok("不标红：这是进度不是错误（走绿勾那一档，不是红叉）", getComputedStyle(lockR).color !== resolved("--wb-err-text") && !!lockR.querySelector('use[href="#i-circle-check"]'), getComputedStyle(lockR).color + " | " + lockR.innerHTML.slice(0, 80));
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
    engines: [{ id: "claude-code", label: "Claude Code", installed: false, version: "", install: "npm i -g @anthropic-ai/claude-code" },
              { id: "codex", label: "Codex", installed: true, version: "0.42.0", install: "" }],
    engine: "builtin", search: { provider: "jina", has_key: false }, media: { image: true, video: false, tts: false, vision: false }, im: { configured: 1 } };
  let ONB_POST_OK = true, ENGINE_TEST_OK = true, SEARCH_TEST_OK = true, DONE_OK = true, SETTINGS_OK = true;
  async function saveSettings(patch) { POSTS.push(["settings", patch]); return SETTINGS_OK; }
  window.fetch = async (url, opt) => {
    const method = (opt && opt.method) || "GET";
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    const j = (o) => ({ json: async () => o });
    if (url === "/api/onboarding" && method === "GET") return j(JSON.parse(JSON.stringify(ST)));
    if (url === "/api/onboarding") { POSTS.push(["onboarding", body]); if (!ONB_POST_OK) return j({ ok: false, error: "这个 Key 上游不认（HTTP 401）" });
      ST = { ...ST, needs_setup: false, brain: { ok: true, via: "api", name: body.model, model: "deepseek-chat" } }; return j({ ok: true, active_model: body.model }); }
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
  q("#onb-model").value = "DeepSeek"; q("#onb-model").dispatchEvent(new Event("change"));

  // ---- 验活失败：留在原地、原因写出来 ----
  ONB_POST_OK = false;
  q("#onb-key").value = "sk-bad"; q("#onb-go").click(); await tick(); await tick();
  ok("验活失败：错误写在向导里、不翻页、按钮恢复", q("#onb-err").textContent.includes("401") && steps.querySelector(".onb-step.cur").textContent.includes("大模型") && !q("#onb-go").disabled && q("#onb-go").textContent === "验活并继续");
  ok("验活真 POST 了 model + api_key", POSTS.some(([k, b]) => k === "onboarding" && b.model === "DeepSeek" && b.api_key === "sk-bad"));

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
  ok("搜索步标「推荐」、默认 jina、说清没填会怎样", q(".onb-tag.rec") && q("#onb-sp").value === "jina" && body.innerText.includes("DuckDuckGo"));
  q("#onb-sp").value = "tavily"; q("#onb-sp").dispatchEvent(new Event("change"));
  ok("换服务商：占位符和提示跟着换", q("#onb-sp-key").placeholder === "tvly-..." && q("#onb-sp-tip").textContent.includes("不用绑卡"));
  ok("搜索步：Tavily 排第一且标「推荐」，链接直达 app.tavily.com", q("#onb-sp option").value === "tavily" && q("#onb-sp option").textContent.includes("推荐") && q("#onb-sp-tip a.get-key") && q("#onb-sp-tip a.get-key").href.startsWith("https://app.tavily.com/") && q("#onb-sp-tip a.get-key").target === "_blank");
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
  const forget = () => { onbSkipMem = false; try { sessionStorage.removeItem("wb_onb_skipped"); } catch {} };
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
  q("#onb-skip-step").click(); await tick();
  ok("完成页点「先跳过」：关向导、本窗口记一次、不往服务端 POST done",
     !mask.classList.contains("show") && onbSkipFlag() === true && !POSTS.some(([k]) => k === "done"));

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
  let PROMPTED = 0, PROMPT_RET = null;
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
  window.prompt = () => { PROMPTED++; return PROMPT_RET; };
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

// ---------- 外观页：主题 / 皮肤 / 字号 / 字体 / 密度 ----------
// 真源切片：app-02 的偏好层（读写本机存储 + 写到 <html>）、app-06 的外观页、app-05 的设置目录
const APP06_LOOK = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-06.js"), "utf8");
// ---- 助理头像编辑器：候选格子必须一样大 ----
// 用户原话：「现在待选的这些图片 svg 都很大，你看一下其他软件都怎么选头像的参考一下」。
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
  const a = html.indexOf('<svg id="wb-sprite"'), b = html.indexOf("</svg>", a);
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

  // ---- ⑥ 落图区：整块框就是那颗按钮（用户原话：「这个选一张图片看着有点突兀」）----
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
const LOOK_CHECKS = `
  const names = []; window.__lookNames = 0;
  const ok = (name, cond) => { if (!cond) throw new Error("外观：" + name); names.push(name); window.__lookNames = names.length; };
  const $ = (q) => document.querySelector(q);
  const px = (q, prop) => parseFloat(getComputedStyle($(q))[prop || "fontSize"]);
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const html = document.documentElement;
  const pane = $("#pane");
  // 存储被禁的页面（data: URL）：这正是要验证「退到内存也能用」的环境
  let storageBlocked = false; try { localStorage.getItem("x"); } catch { storageBlocked = true; }
  ok("本页 localStorage 被禁（验证内存回退的前提成立）", storageBlocked);

  ok("默认：<html> 不带 data-fs/skin/font/density 脏属性", !html.dataset.fs && !html.dataset.skin && !html.dataset.font && !html.dataset.density);
  ok("默认：正文 15 / 标题 17 / 左栏 14 / 输入框 15 / 行内代码 13", px("body") === 15 && px("#h1") === 17 && px("#hi") === 14 && px("#input") === 15 && px("#cd") === 13);

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

  const click = (k, v) => pane.querySelector('[data-k="' + k + '"] button[data-v="' + v + '"]').click();
  // 字号
  click("fs", "xl");
  ok("点「特大」：<html data-fs=xl>，正文 18", html.dataset.fs === "xl" && px("body") === 18 && px("#p") === 18);
  ok("特大：标题 20 / 左栏 17 / 输入框 18 / 行内代码 16 / 预览行 18 都跟着走", px("#h1") === 20 && px("#hi") === 17 && px("#input") === 18 && px("#cd") === 16 && px("#look-prev") === 18);
  ok("特大：字号组选中态跟着切到 xl", onePressed("fs") && pane.querySelector('[data-k="fs"] button.on').dataset.v === "xl");
  click("fs", "s");
  ok("点「小」：正文 14 / 左栏 13", html.dataset.fs === "s" && px("body") === 14 && px("#hi") === 13);
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
  let combos = 0, minText = 99, minBtn = 99, worst = "";
  for (const skin of Object.keys(LOOK_OPTS.skin)) for (const theme of ["light", "dark"]) {
    setLook("skin", skin); setTheme(theme); combos++;
    const bg = getComputedStyle(document.body).backgroundColor;
    const rt = ratio(resolve("--brand-text"), bg), rb = ratio("rgb(255, 255, 255)", resolve("--primary"));
    if (rt < minText) { minText = rt; worst = skin + "/" + theme; }
    if (rb < minBtn) minBtn = rb;
  }
  probe.remove();
  ok("对比度矩阵跑满 6 皮肤 × 2 主题 = 12 组", combos === 12);
  ok("每组品牌字色压底色 ≥ 4.5（最低 " + minText.toFixed(2) + " @ " + worst + "）", minText >= 4.5);
  ok("每组白字压主色 ≥ 3（最低 " + minBtn.toFixed(2) + "）", minBtn >= 3);
  setTheme("light");
  renderLookPane(pane);
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
  setLook("fs", "huge"); setLook("nope", "x"); setTheme("neon");
  ok("非法值一律忽略：fs 仍是标准、theme 仍是浅色、未知键不炸", lookGet("fs") === "m" && !("fs" in html.dataset) && getTheme() === "light");
  lookMem["wb-look-fs"] = "huge"; lookMem["wb-theme"] = "neon"; applyLook(); applyTheme();
  ok("存储里躺着旧版本写的非法值：读回当没写（标准字号 / 跟随系统），不带脏属性", lookGet("fs") === "m" && !("fs" in html.dataset) && getTheme() === "system");
  setTheme("light");
  ok("点分区空白处：不改任何状态、不报错", (() => { pane.querySelector(".card-item").click(); return lookGet("fs") === "m" && getTheme() === "light"; })());

  // 左栏目录：图标 + 短名，别一列密密麻麻的字
  ok("设置目录 12 项都带图标、名字 ≤ 4 字，且含「外观」", SETTING_CATS.length === 12 && SETTING_CATS.every(([k, l, i]) => i && l.length <= 4) && SETTING_CATS.some(([k, l]) => k === "look" && l === "外观"));
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
  const a0 = APP02X.indexOf("// ---------- @文件 //技能 token 高亮");
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
const HL_CHECKS = `
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
  document.documentElement.dataset.fs = "xl";
  const g3 = gap("帮我 /写周报 这个月的", "/写周报");
  ok("设置里把字号调到特大：两层一起变大（正文 " + getComputedStyle(ta).fontSize + "）", parseFloat(getComputedStyle(ta).fontSize) > 15 && snap(ta) === snap(hl));
  ok("特大字号下框还严丝合缝（" + say(g3) + "）", fit(g3));
  delete document.documentElement.dataset.fs;

  // 负对照：这把尺子得能红。把镜像层字号单独改掉，框立刻对不上
  hl.style.fontSize = "20px";
  const bad = gap("帮我 /写周报 这个月的", "/写周报");
  ok("负对照：镜像层字号被单独改掉时，这把尺子当场判不合格（" + say(bad) + "）", !fit(bad));
  hl.style.fontSize = "";
  const back = gap("帮我 /写周报 这个月的", "/写周报");
  ok("撤掉之后又合格了（尺子本身没坏）", fit(back));

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
  let currentUser = { username: "demo", role: "admin", avatar: "", credits: 0 }; const creditsOn = false;
`;
const MENU_CHECKS = `
  const names = []; window.__menuNames = 0;
  const ok = (name, cond) => { if (!cond) throw new Error("头像菜单：" + name); names.push(name); window.__menuNames = names.length; };
  const $ = (q) => document.querySelector(q);
  const tick = () => new Promise((r) => setTimeout(r, 25)); // 英文模式下翻译靠观察者，下一拍才落
  const menu = $("#user-menu");
  const acts = () => [...menu.querySelectorAll(".um-i")].map((x) => x.dataset.act).join(",");
  const langRow = () => menu.querySelector(".um-lang");
  const btn = (v) => menu.querySelector('.um-seg button[data-lang="' + v + '"]');
  I18N.setLang("zh");
  openUserMenu();
  ok("打开：菜单显示，八行动作 = 个人资料/设置/企业后台/语言/外观/帮助/更新/退出", menu.classList.contains("show") && acts() === "profile,settings,admin,lang,appearance,help,update,logout");
  const iconOf = (sel) => { const u = menu.querySelector(sel + " use"); return u ? u.getAttribute("href") : "(这行没画图标)"; };
  ok("企业后台这行写清楚了点进去能干什么（成员 · 用量 · 安全）", /企业管理后台/.test(menu.textContent) && /成员 · 用量 · 安全/.test(menu.querySelector('[data-act="admin"]').textContent));
  // 八行动作每行都得有图标，而且是各自那一个——以前这里是 🏢🪪⚙️ 一串表情，翻译一过就被当正文
  ok("八行动作用的是图标不是表情：每行一个 svg，图标各不相同", (() => {
    const rows = [...menu.querySelectorAll(".um-i")];
    const hrefs = rows.map((r) => { const u = r.querySelector("use"); return u ? u.getAttribute("href") : null; });
    return rows.length === 8 && hrefs.every(Boolean) && new Set(hrefs).size === 8;
  })(), [...menu.querySelectorAll(".um-i")].map((r) => (r.querySelector("use") || {}).getAttribute && r.querySelector("use").getAttribute("href")).join(","));
  ok("负对照：这把尺子认得出图标不一样（企业后台=building-2，个人资料=id-card）", iconOf('[data-act="admin"]') === "#i-building-2" && iconOf('[data-act="profile"]') === "#i-id-card");
  ok("菜单里一个表情都不剩", !/[\u{1F300}-\u{1FAFF}\u{FE0F}\u{2699}\u{1F6E1}]/u.test(menu.textContent), menu.textContent.slice(0, 80));
  ok("「个人资料」后面不再挂「改名字 · 换头像」尾注", !/改名字|换头像/.test(menu.textContent) && !menu.querySelector('[data-act="profile"] .hint'));
  ok("语言行：语言 + 中 / En 两个胶囊，中文选中（.on + aria-pressed）", !!langRow() && /语言/.test(langRow().textContent) && (langRow().querySelector("use") || {}).getAttribute && langRow().querySelector("use").getAttribute("href") === "#i-globe" && !!btn("zh") && !!btn("en") && btn("zh").classList.contains("on") && btn("zh").getAttribute("aria-pressed") === "true" && !btn("en").classList.contains("on") && btn("en").getAttribute("aria-pressed") === "false");
  ok("胶囊组标了 data-i18n-skip，「中 / En」不会被翻译器动", langRow().querySelector(".um-seg").hasAttribute("data-i18n-skip") && btn("zh").textContent === "中" && btn("en").textContent === "En");
  const bgOn = getComputedStyle(btn("zh")).backgroundColor, bgOff = getComputedStyle(btn("en")).backgroundColor;
  ok("选中胶囊有品牌底色，未选中透明（" + bgOn + " / " + bgOff + "）", bgOn !== bgOff && /rgba\\(0, 0, 0, 0\\)|transparent/.test(bgOff));
  ok("胶囊够大能点：高 ≥ 18px、宽 ≥ 30px", btn("zh").getBoundingClientRect().height >= 18 && btn("zh").getBoundingClientRect().width >= 30);
  ok("外观行的「主题 · 字号」提示还在（没误伤）", /跟随系统 · 标准字/.test(menu.querySelector('[data-act="appearance"] .hint').textContent));
  btn("en").click(); await tick();
  ok("点 En：语言=en，菜单没关", I18N.getLang() === "en" && menu.classList.contains("show"));
  ok("点 En：菜单文案原地变英文（Profile / Settings / Language / Appearance），En 选中", /Profile/.test(menu.textContent) && /Settings/.test(menu.textContent) && /Language/.test(menu.textContent) && /Appearance/.test(menu.textContent) && btn("en").classList.contains("on") && !btn("zh").classList.contains("on"));
  // 词条当年是按「🪪 个人资料」收的，图标换成 svg 之后文本节点只剩「个人资料」。
  // 这条钉的是那条自动补出来的无表情别名真的生效了——不生效就会中英混着显示。
  ok("英文下图标一个没少、一个没混进文字里", menu.querySelectorAll(".um-i use").length === 8 && !/🪪|⚙️|🌐|🎨/.test(menu.textContent), menu.textContent.slice(0, 90));
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
  currentUser = { username: "xiaoyuan", role: "member", avatar: "", credits: 0 };
  openUserMenu();
  ok("普通成员：菜单里根本没有企业后台这一行", !menu.querySelector('[data-act="admin"]') && !/企业管理后台/.test(menu.textContent));
  ok("反向对照：普通成员的其它七行一个不少", acts() === "profile,settings,lang,appearance,help,update,logout");
  currentUser = { username: "kuaiji", role: "auditor", avatar: "", credits: 0 };
  openUserMenu();
  ok("审计员：看得见入口，但标着「只读」（他进去只能查账改不动）", !!menu.querySelector('[data-act="admin"]') && /只读/.test(menu.querySelector('[data-act="admin"]').textContent));
  ok("审计员的头衔不冒充管理员（头部不写「· 管理员」）", !/· 管理员/.test(menu.querySelector(".um-head").textContent));
  currentUser = { username: "demo", role: "admin", avatar: "", credits: 0 };
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
  try { localStorage.getItem("wb_proc_open"); } catch {
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
  // 用户原话：「不要大段大段具体的执行过程挡住了」——跑的时候过程区默认收起，
  // 但「跑到哪了」那一行必须一直看得见，而且要钉在视口顶上，不能被日志顶走
  const runWrap = t.querySelector(".proc-wrap");
  ok("跑的时候执行过程默认是收起的", !runWrap.classList.contains("open") && disp(runWrap.querySelector(".proc-body")) === "none");
  ok("但那一行进度始终露在外面", disp(runWrap.querySelector(".proc-head")) !== "none" && /运行中|第 \\d+ 步/.test(runWrap.querySelector(".pt").textContent + " 运行中"));
  ok("运行中的进度条是 sticky（真样式，不是写在注释里）", getComputedStyle(runWrap.querySelector(".proc-head")).position === "sticky", getComputedStyle(runWrap.querySelector(".proc-head")).position);
  ok("轨迹徽章收起时照样看得见，扫一眼知道走了哪几步", chips(t).every((c) => disp(c) !== "none"));
  // 点一下能展开，而且这个选择记下来：下次开的任务直接按你上次的来
  runWrap.querySelector(".proc-head").click();
  ok("点标题能展开看细节", runWrap.classList.contains("open") && disp(runWrap.querySelector(".proc-body")) !== "none");
  ok("展开这个选择被记住了", localStorage.getItem("wb_proc_open") === "1", String(localStorage.getItem("wb_proc_open")));
  runWrap.querySelector(".proc-head").click();
  ok("再点收起，记的也跟着改", !runWrap.classList.contains("open") && localStorage.getItem("wb_proc_open") === "0");

  // ---- 执行过程一行流：「[图标] 读 报告.md · 120 行」，参数收在卡里 ----
  // 用户原话：「让我一直看到任务完成情况，不要看太多没有用的东西」。
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
  // 用户原话：「有些这些文件你就给我搞成超连接的形式啊，然后有产出了应该要预览啊」
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
  // 用户原话：「用户都一直看着一个大标题在转，没有感知具体的 agent 在干活执行」。
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
    ok("过程区仍然默认收着（用户说过别让执行过程挡住）", !wrap.classList.contains("open"));
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
  return names;
})()`;

const PREVIEW_HTML =
  "<!doctype html><meta charset='utf-8'><body>" +
  "<div id='preview-panel'></div><div id='files-panel'></div><div id='pv-body'></div>" +
  "<span id='pv-name'></span><a id='pv-dl'></a>" +
  "<button id='pv-close'></button><button id='pv-sys'></button><button id='pv-rv'></button></body>";

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
  "  return { ok: true, status: 206, headers: { get: (h) => (h.toLowerCase() === 'content-range' ? 'bytes 0-1/' + f.total : null) }, text: async () => f.body };",
  "};",
  "window.esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');",
  "window.renderMd = (t) => '<p class=md>' + window.esc(t) + '</p>';",
  "window.fmtSize = (n) => n + ' B';",
  "window.renderDeployBar = () => {};",
  "window.revealFile = (n) => { window.opened.push('reveal:' + n); };",
  "window.toast = () => {};",
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
      iframe: ["a.html", "a.htm", "报告.pdf", "图.svg"],
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
    // 用户原话：「图片预览的时候点击的时候应该放在右边中间居中的位置啊，不要放在顶上放啊」
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
    const h = await show("main.swift", { body: 'import Foundation\\nprint(1)', total: 30 });
    ok("swift 源码直接显示内容", /import Foundation/.test(h) && !/暂不支持/.test(h), h.slice(0, 200));
    const p = await show("build.py", { body: "def main():\\n    pass", total: 20 });
    ok("py 源码直接显示内容", /def main/.test(p));
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
  // 用户原话是「切换失败怎么还切换失败了啊」——一颗明明能点的按钮，点下去只回四个字。
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
    ok("大文件标出只显示了开头", /只显示了开头/.test(h), h.slice(-200));
    const small = await show("小.log", { body: "就一行", total: 9 });
    ok("小文件不乱标截断", !/只显示了开头/.test(small));
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

  // 短对话（不够一屏半）：贴底时两个按钮都不出现
  const col = document.getElementById("chat-col");
  col.style.height = "320px"; sc.scrollTop = sc.scrollHeight; fire();
  ok("短对话贴底时两个引导都不出现", !shown("to-bottom") && !shown("to-top"));
  // 长对话贴底：不用「回到最新」，但离顶远了要给「回到最前」（几十轮的对话想看开头不该手滚半天）
  col.style.height = "3000px"; sc.scrollTop = sc.scrollHeight; fire();
  ok("长对话贴底只出「回到最前」", !shown("to-bottom") && shown("to-top"));
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

    // 用户原话：「怎么一直在绘制中，对话都结束了，这是卡住了啊」。
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
// 用户原话「任务运行中那行要写清楚：在输入框输入文字、按 Enter 能继续插进来；有人味一点」。
// 这里验的是交互不是措辞：排队条讲清三件事（怎么插话 / 怎么停 / 想并行怎么办）、停止是一颗真按钮、
// 一颗发送键看框里有没有字决定是「停下」还是「插一句」、提示语跟着忙/闲切换、发完框空了按钮自己回到「停下」。
const C0 = APP02.indexOf("// ================= 发送（运行中按钮变「停止」）");
const C1 = APP02.indexOf("function drainQueue(sid) {");
if (C0 < 0 || C1 <= C0) throw new Error("app-02.js 里找不到「发送（运行中按钮变「停止」）… drainQueue」那一段");
const COMPOSER_SRC = APP02.slice(C0, C1);
const COMPOSER_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + "<div class='queue-bar' id='queue-bar'></div><textarea id='input'></textarea><button id='send'>↑</button><button id='new-task'>新建任务</button></body>";
const COMPOSER_STUBS = [
  IC_STUB,
  "var BUSY = false; const curBusy = () => BUSY;",
  // 跟着终端（wb 命令行）里那趟活儿时是另一套：插得上话，但停不了——那个进程不归网页管
  "var CLI = false; const cliBusy = () => CLI;",
  "let currentMode = 'craft';",
  "const inputEl = document.getElementById('input'), sendBtn = document.getElementById('send');",
  "const pendingAttach = [];",
  "let sessionId = 's1'; const sessionQueues = new Map();",
  "const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "let HIST = 0; function renderHistory() { HIST++; }",
  "const CALLS = [];",
  "async function stopTask() { CALLS.push('stop'); }",
  "// 模拟真 send()：有草稿才发，发完框清空并让按钮重算（真源码里由 composeOutgoing 做）",
  "async function send() { const t = inputEl.value.trim(); if (!t && !pendingAttach.length) { CALLS.push('send:empty'); return; } CALLS.push('send:' + (t || '[附件]')); inputEl.value = ''; pendingAttach.length = 0; syncSendBtn(); }",
].join("\n");
const COMPOSER_CHECKS = `
(async () => {
  const names = [];
  const ok = (n, c, extra) => { if (!c) throw new Error(n + (extra !== undefined ? "：" + extra : "")); names.push(n); };
  const bar = document.getElementById("queue-bar");
  const stops = () => CALLS.filter((c) => c === "stop").length;
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
  ok("打了字点发送键：走 send（插队）不走停止 —— 以前这里一点任务就没了", CALLS[CALLS.length - 1] === "send:改成蓝色" && stops() === b1, CALLS.join(","));
  ok("发出去框空了：按钮自己回到「◼ 停下」，不用等下一次 updateSendUI", sendIcon() === "square" && sendBtn.classList.contains("stop") && !sendBtn.classList.contains("interject"), sendBtn.className);
  typeIn("再加个标题");
  ok("Shift+Enter 只换行不发", !press("Enter", true) && CALLS[CALLS.length - 1] !== "send:再加个标题");
  ok("Enter 发出去（默认行为被拦，不会真换行）", press("Enter", false) && CALLS[CALLS.length - 1] === "send:再加个标题", CALLS.join(","));
  ok("Enter 发完按钮回到「◼」", sendIcon() === "square");
  pendingAttach.push("截图.png"); syncSendBtn();
  ok("只贴了附件没打字：也算有话要说 → 「↑」", sendIcon() === "arrow-up" && !sendBtn.classList.contains("stop"));
  pendingAttach.length = 0; syncSendBtn();
  ok("附件撤掉：回到「◼」", sendIcon() === "square" && sendBtn.classList.contains("stop"));

  // ---- 跟着终端里那趟活儿：插得上话，但停不了 ----
  // 这个进程是 wb 命令行起的，不归网页管。画一颗按下去没反应的「停」键是骗人，
  // 所以这一档专门不给停止态，提示语直说「回终端按 Ctrl+C」
  BUSY = false; CLI = true; typeIn(""); updateSendUI();
  ok("跟着终端那趟：提示语说清能插话、也说清想停得回终端",
    inputEl.placeholder.includes("终端") && inputEl.placeholder.includes("Enter") && inputEl.placeholder.includes("Ctrl+C"), inputEl.placeholder);
  ok("不画那颗按下去没反应的「停」键", sendIcon() === "arrow-up" && !sendBtn.classList.contains("stop"), sendBtn.className);
  const c0 = stops(); sendBtn.click();
  ok("框空着点一下也不会去停（停不了就别假装能停）", stops() === c0, CALLS.join(","));
  typeIn("顺便把日志也贴出来");
  ok("打了字：按钮说的是「插一句给终端里的它」", sendBtn.title.includes("插一句") && sendBtn.title.includes("终端") && sendBtn.classList.contains("interject"), sendBtn.title);
  ok("Enter 照样送得出去", press("Enter", false) && CALLS[CALLS.length - 1] === "send:顺便把日志也贴出来", CALLS.join(","));
  // 反向对照：同样是「忙着 + 框空着」，本机那趟就该给停止键——证明上面几条不是恒真
  CLI = false; BUSY = true; typeIn(""); updateSendUI();
  ok("反向对照：本机自己跑的那趟，框空着就是「◼ 停下」", sendIcon() === "square" && sendBtn.classList.contains("stop"), sendBtn.className);
  const c1 = stops(); sendBtn.click();
  ok("反向对照：这一下是真的去停了", stops() === c1 + 1);

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
window.confirm = () => true;
var SERVERS = [
  { name: "mysql", transport: "stdio", command: "npx", args: ["-y", "@benborla29/mcp-server-mysql"], env_keys: ["MYSQL_USER", "MYSQL_PASS"], connected: true, tools: [{ name: "query", description: "run sql" }] },
  { name: "deepwiki2", transport: "streamable-http", url: "https://mcp.deepwiki.com/mcp", header_keys: ["Authorization"], connected: false, error: "握手超时", tools: [] },
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

  // 推荐目录：按分类分组，五张卡，标记各归各
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
  // 用户原话：「有些这些文件你就给我搞成超连接的形式啊」
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
  // 原话：「怎么有些文件没有链接啊，应该写着产出的这些文件应该要都有链接啊」
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
  // 用户原话：「有产出了应该要预览啊」「不仅结束了没有预览」——中途不弹是另一码事，这里说的是收尾
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
// 用户原话：「点击技能然后点击立即使用怎么 用「xiaohongshu-topic」技能帮我： 都没什么特殊点格式啊」。
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
const SKEG_DOCS = (() => {
  const dir = path.join(__dirname, "..", "skills");
  const out = {};
  for (const name of ["xiaohongshu-topic", "wechat-article", "deep-research", "brand-guidelines", "feishu-doc"]) {
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
  // 早先的版本挖不到就退回全文前 1200 字，结果卡上摆的是 #b0aea5、pptxgenjs、app_id
  // 这类配置和字段名——比空着更糟。这两份说明书都没写「适用场景」，而且正文里
  // 恰好有一堆「像人话但不是任务」的句子（字体名、写作规范、接口注意事项），
  // 光靠「看着像代码就不要」那道筛子拦不住它们，只有把挖掘范围锁死在「适用场景」才干净。
  ok("没写「适用场景」的说明书一条都不挖（不退回全文）",
    skillExamples(DOCS["brand-guidelines"]).length === 0 && skillExamples(DOCS["feishu-doc"]).length === 0,
    JSON.stringify([skillExamples(DOCS["brand-guidelines"]), skillExamples(DOCS["feishu-doc"])]));

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
// 用户原话：「命令行模式是 cli 模式啊，能连接本地的 cli 啊，是我这个 agent 的 cli 啊」
//「参考一下 claude 怎么做的啊，放在左边 tab 啊」。
// 两条线分的是**干哪种活儿**：办公（做表写稿出图，鼠标流）和工程（写代码跑脚本，键盘流，
// 连着本机那个 wb 命令行）。这一段守六件事：
//   1. 两条线各自记各自的会话——切标签不会把另一条线的历史混进来，也不会让老会话「消失」；
//   2. **标签碰不到引擎**。早先版本让「切到工程线」顺手把引擎也换掉，服务器上两个人共用一份
//      配置时，那是实打实的越权。这里留一条反向看门狗：服务端就算把引擎字段塞回来，标签上也不许长出来；
//   3. 工程线**不按项目过滤**——终端里 wb 起的任务没有「项目」这个概念，一过滤整条线空着，
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
  + "<div id='history'></div></aside><button id='new-task'>新任务</button></body>";
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
    detail: "本机 OpenWorkBuddy 命令行（wb）那条线：终端里起的任务都归这儿，手机上点开就能接管、插话" },
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
    /键盘流/.test(byLane("cli").title) && /wb/.test(byLane("cli").title), byLane("cli").title);

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
  ok("换过的线记在本地，下次打开还站在这儿", __LANE_LS["wb_lane"] === "cli");
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

  // ---- ⑦ 终端直播那一撮：单独一小标题，点进去是跟直播不是回放 ----
  sessions = [{ id: "t3", title: "早上那趟（已经存成记录了）", at: 3, lane: "cli" }];
  cliLiveRows = [
    { id: "t1", title: "把这个仓库的测试跑一遍", live: true, startedAt: 9, cwd: "/w/repo" },
    { id: "t3", title: "早上那趟", live: false, startedAt: 1, cwd: "/w/repo" },
  ];
  renderHistory();
  ok("工程线顶上单独一撮，标题说清楚是终端里的", /终端里/.test(hist.querySelector(".hist-group")?.textContent || ""), hist.textContent);
  ok("正在跑的那行走 data-cli（点它是跟直播，不是回放存下来的记录）",
    hist.querySelector('[data-cli="t1"]') !== null && hist.querySelector('[data-cli="t1"] .hrun') !== null, hist.innerHTML);
  ok("已经存成历史的那趟不重复列", hist.querySelectorAll('[data-id="t3"]').length === 1 && hist.querySelector('[data-cli="t3"]') === null, hist.innerHTML);
  byLane("office").click();
  ok("办公线上不列终端那一撮（它是工程线的东西）", hist.querySelector(".hist-group") === null, hist.innerHTML);
  byLane("cli").click();

  // ---- ⑧ 空态：告诉人「怎么让它出现」，不是干巴巴一句没有任务 ----
  sessions = []; cliLiveRows = [];
  renderHistory();
  ok("工程线空着时说的是怎么让它出现", /wb/.test(hist.textContent) && /终端/.test(hist.textContent), hist.textContent);
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
const LANE_NARROW_CHECKS = `
(() => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const box = document.getElementById("lane-tabs");
  const side = document.querySelector("aside");
  const fits = () => box.scrollWidth <= box.clientWidth;
  renderLaneTabs();
  ok("手机宽度下侧栏默认是收起来的（正文占满整屏）", getComputedStyle(side).display === "none", getComputedStyle(side).display);
  document.body.classList.add("side-open");
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
// 用户两句原话是同一个根因：
//   「本组织工作目录没有必要显示啊，没必要显示一个 tab 在那里啊，有点突兀」
//   「我 catuncle 账号登陆之前的历史记录都没看到了，之前的任务历史都没看到了啊」
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
// 用户原话：「那些图都变形了啊，然后没有看到完整的」。
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
const TH_CHECKS = `
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
  document.head.appendChild(back);
  const old = judge();
  ok("反向对照：退回 cover + 100%，图当场被拉成盒子的形状（" + old.拉伸.length + " 张）", old.拉伸.length >= 4, old.拉伸);
  ok("反向对照：退回 cover + 100%，小图当场被撑大", old.放大.length >= 1, old.放大);
  back.remove();
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
const PILL_CHECKS = `
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
  host.appendChild(withIcon);
  const iconed = withIcon.getBoundingClientRect().height;
  ok("同一个标记里塞了图标也还是这么高（" + plain + " vs " + iconed + "）", Math.abs(plain - iconed) < 0.5, [plain, iconed]);
  withIcon.remove();

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
    ".tag { background: var(--wb-brand-weak); padding: 2px 9px; border-radius: var(--radius-lg); font-size: 12px; }",
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
  document.head.appendChild(back);
  const old = geo();
  const oldKinds = [...new Set(old.map(key))];
  ok("反向对照：退回十三条各写各的，当场就是 " + oldKinds.length + " 种尺寸", oldKinds.length >= 10, oldKinds);
  const oldBt = getComputedStyle(document.querySelector(".brand .tag"));
  ok("反向对照：退回裸 .tag，品牌副标题当场又顶了一身药丸底色",
     !bare(oldBt.backgroundColor) && parseFloat(oldBt.paddingLeft) > 0, [oldBt.backgroundColor, oldBt.paddingLeft]);
  const oldTg = document.querySelector('[data-case="tg-i"] .tg i').getBoundingClientRect().height;
  back.remove();
  const again = geo();
  ok("撤掉对照又回到一种尺寸（这轮不是蒙的）", [...new Set(again.map(key))].length === 1);
  names.push("反向对照下 .ex-card .tg i 的高度是 " + Math.round(oldTg * 10) / 10 + "px，不再是 20");
  return names;
})()
`;

// ---------------------------------------------------------------------------
// 纯图标钮：没有字，只有一个图标加一句 title。全站离屏点过一遍，去重后十三颗，
// 居然长出六个尺寸（24×24 / 36×27 / 28×28 / 30×30 / 28×32 / 36×36）、三种圆角（6 / 8 / 10）。
// 其中两颗根本不是正方形：#toggle-side 的规则只写内边距不写宽高，高度跟着字号走；
// #fp-close 蹲在一行窄 flex 里被邻居挤成 28 宽。
// 现在收成两档，挂在既有的控件高度梯子上：常规档 = --wb-ctl-h-sm（30），密集档 = 24。
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
const ICO_CHECKS = `
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
  document.head.appendChild(back);
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
  back.remove();

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
// 现在高度统一由 --wb-ctl-h 出，内边距只管左右。
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
const CTL_CHECKS = `
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
  document.head.appendChild(back);
  ok("反向对照：次要键退回 32px，hub-head 当场又不齐了", H("#k-plain") !== H("#k-brand"), [H("#k-plain"), H("#k-brand")]);
  back.remove();
  // ★反向对照★ 把下拉的定高撤掉，它会自己涨回 37
  const back2 = document.createElement("style");
  back2.textContent = "select { height: auto; padding: 8px 12px; }";
  document.head.appendChild(back2);
  ok("反向对照：撤掉下拉定高，它比输入框高出来", H("#k-sel") > H("#k-q"), [H("#k-sel"), H("#k-q")]);
  back2.remove();
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

// 存盘链路（#91，用户原话：「怎么说保存失败接口没有响应啊」）。真源是 app-02.js 的 postJson：
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
  let NEXT = {};
  const mask = { classList: { remove() {} } };
  function openOnboarding() {}
  function fetch() { return Promise.resolve({ json: () => Promise.resolve(NEXT) }); }
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
const SETL_CHECKS = `
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
  ok("图标列和弹窗标题文字同一列", iconLeft() === titleLeft(), { icon: iconLeft(), title: titleLeft() });

  // ---- 反向对照：把这两条改回修之前的写法，两个断言都得当场挂 ----
  const undo = document.createElement("style");
  undo.textContent = ".settings-layout { height: 60vh; } .m-body:has(> .settings-layout) { padding: 14px 20px 20px; }";
  document.head.appendChild(undo);
  const h2 = Math.round(lay.getBoundingClientRect().height);
  ok("反向对照：改回 60vh 层高立刻掉回 600 以下", h2 < 600, h2);
  ok("反向对照：m-body 的留白加回去，图标列就和标题错开", iconLeft() !== titleLeft(), { icon: iconLeft(), title: titleLeft() });
  ok("反向对照：错开的量正好是 m-body 那 20px", iconLeft() - titleLeft() === 20, iconLeft() - titleLeft());
  undo.remove();
  ok("撤掉对照样式之后又对回去了", iconLeft() === titleLeft());

  return names;
})()
`;

// ================= 对比度：量真元素压真底色，不是量令牌压令牌 =================
// 上面那组矩阵量的是 --brand-text 压 body 底色，是「令牌层」的账。
// 但界面上的字不一定坐在 body 上：侧栏选中行的副标题坐在 --wb-brand-weak 上，
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
const CONTRAST_CHECKS = `
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
    document.documentElement.dataset.theme = theme;
    for (const [label, r] of sweep()) ok(theme + "：" + label + " 压住底色 " + r.toFixed(2) + " ≥ 4.5", r >= 4.5, r);
  }

  // ---- 反向对照：把这三条改回修之前的写法，三处必须当场跌破 4.5 ----
  const undo = document.createElement("style");
  undo.textContent = ".side-nav .item.active .tx .sub { opacity: .82; }"
    + " .side-nav .nav-head #proj-add { color: var(--wb-text-3); }"
    + " a:not([class]) { color: -webkit-link; }"
    + " :root { --warning: #b26a00; }";
  document.head.appendChild(undo);
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    const bad = sweep().filter(([, r]) => r < 4.5).map(([l]) => l);
    if (theme === "dark") ok("反向对照·暗色：那三处全跌破 4.5（警告色暗底上本来就够）", bad.length === 3, sweep());
    else ok("反向对照·浅色：副标题和警告小字两条跌破 4.5（另两条本来浅底上就够）",
      bad.includes("side-nav 选中行的副标题") && bad.includes("卡片上 12px 的警告小字"), sweep());
  }
  undo.remove();
  document.documentElement.dataset.theme = "light";
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
  document.head.appendChild(shrink);
  const shrunk = HITS.filter(([, sel]) => { const [w, h] = box(sel); return w < 24 || h < 24; }).map(([l]) => l);
  ok("反向对照：改回旧写法，三个热区全跌回 24 以下", shrunk.length === 3, shrunk);
  shrink.remove();

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
  document.head.appendChild(bleed);
  ok("反向对照：把 width:100% 重新压回勾选框，它当场被撑成整行", box("#c-chk")[0] >= rowW() - 1, [box("#c-chk")[0], rowW()]);
  bleed.remove();

  return names;
})()
`;

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
  const rawExec = w.webContents.executeJavaScript.bind(w.webContents);
  w.webContents.executeJavaScript = async (code, gesture) => {
    await rawExec(PLACEHOLDER_WATCH, true).catch(() => 0);
    const r = await rawExec(code, gesture);
    const leak = await rawExec("(window.__phFlush ? window.__phFlush() : '')", true).catch(() => "");
    if (leak) throw new Error("界面上漏出了没求值的模板占位符 " + leak + "：多半是把 ${} 写进了单引号/双引号字符串");
    return r;
  };
  return w;
}
app.whenReady().then(async () => {
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
    const win7 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win7.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TURNOUT_HTML));
      const names7 = await win7.webContents.executeJavaScript(IC_BOOT + TURNOUT_STUBS + "\n" + PATHHELP_SRC + "\n" + TURNOUT_SRC + "\n" + TURNOUT_CHECKS, true);
      for (const n of names7) console.log("  ✓ " + n);
      console.log(`✅ 前端：本回合产出（删掉的中间文件跟着撤·成品不被挤掉·截断不误杀·并卡只摘链接·整块可收起）${names7.length} 项通过`);
    } finally {
      if (!win7.isDestroyed()) win7.destroy();
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
    const win12 = mkWin({ show: false, width: 900, height: 900, webPreferences: { offscreen: true } });
    try {
      await win12.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOOK_HTML));
      const names12 = await win12.webContents.executeJavaScript(IC_BOOT + I18N_SRC + "\n(async function(){\n" + IC_STUB + "\n" + LOOK_SRC + "\n" + LOOK_CHECKS + "\n})()", true)
        .catch((e) => { throw new Error("[外观] " + ((e && (e.stack || e.message)) || String(e))); });
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
      console.log(`✅ 前端：连接器预设目录（一键接入预填·缺 Key 拦下·值里带等号保住·原条目不回传 Key·已接入置灰·缺 uvx 提示·搜索/只看已连接联动）${names15.length} 项通过`);
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
      console.log(`✅ 前端：助理设置页（四分区·双栏·连上收起·连接=保存再测活·凭证没填齐先拦住·取消连接两步且只清自己·微信取码/断开·扫码新建飞书应用·清会话两步）${names10.length} 项通过`);
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

    const winESC = mkWin({ show: false, width: 600, height: 400, webPreferences: { offscreen: true } });
    try {
      await winESC.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ESC_HTML));
      const namesESC = await winESC.webContents.executeJavaScript(IC_BOOT + ESC_STUBS + "\n" + ESC_SRC + "\n" + STREAM_SRC + "\n" + ESC_CHECKS, true)
        .catch((e) => { throw new Error("[HTML 转义] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesESC) console.log("  ✓ " + n);
      console.log(`✅ 前端：HTML 转义（引号进属性不截断·markdown 链接注不进事件属性·正常内容一字没动）${namesESC.length} 项通过`);
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

    const winDEAD = mkWin({ show: false, width: 1100, height: 900, webPreferences: { offscreen: true } });
    try {
      await winDEAD.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(DEAD_HTML));
      const namesDEAD = await winDEAD.webContents.executeJavaScript(IC_BOOT + ESC_SRC + "\n" + DEAD_SRC + "\n" + DEAD_CHECKS, true)
        .catch((e) => { throw new Error("[自动化/资料库 403] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of namesDEAD) console.log("  ✓ " + n);
      console.log(`✅ 前端：403 不该变成一片白也不该变成一句假成功（自动化整页有话说·侧栏藏掉必挂的入口·资料库只读但看得见·上传/记笔记失败照实说）${namesDEAD.length} 项通过`);
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
      console.log(`✅ 前端：本机引擎在跑时的模型选择器（宽度收得住·说明换行·不出屏·只有一处可点·按钮换图标）${namesEP.length} 项通过`);
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
      console.log(`\u2705 \u524d\u7aef\uff1a\u5173\u4e8e\u9875\u8bfb\u4e0d\u5230\u7248\u672c\u53f7\u65f6\u4e0d\u628a undefined \u6446\u5230\u8138\u4e0a\uff08cookie \u8fc7\u671f\u00b7\u6b63\u5e38\u00b7\u6709\u65b0\u7248\u00b7\u67e5\u7ebf\u4e0a\u5931\u8d25\u00b7\u5b57\u6bb5\u6b8b\u7f3a \u4e94\u79cd\u5f62\u72b6\uff09${namesAB.length} \u9879\u901a\u8fc7`);
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
  } catch (e) {
    console.error("❌ 前端测试失败:", e && e.message ? e.message : e);
    const errs = RENDERER_LOG.filter((m) => m.level === "error" || m.level === "3");
    for (const m of (errs.length ? errs : RENDERER_LOG.slice(-5))) console.error("   渲染进程 console：" + m.message + (m.line ? "（行 " + m.line + "）" : ""));
    code = 1;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.exit(code);
  }
});
