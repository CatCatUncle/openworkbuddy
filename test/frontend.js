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
const { app, BrowserWindow } = require("electron");

const SVGFIG = fs.readFileSync(path.join(__dirname, "..", "public", "svgfig.js"), "utf8");

// 附件（粘贴/拖拽：文件、图片、大段文字）用的是 app-02.js 里那一段真源码——
// 抄一份到测试里只能证明抄的那份是对的。段落靠标题定位，标题被改了就当场报错，不许静默跳过。
const APP02 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
const I18N_SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "i18n.js"), "utf8"); // 真源：中英词典 + DOM 翻译器
const APP02X = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8");
const A0 = APP02.indexOf("// ================= ＋ 上传文件到工作空间");
const A1 = APP02.indexOf("// ================= 会话历史");
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

// 成果面板：文件夹按时间分段（今天／昨天／过去 7 天／更早按月）。分段是纯视图，
// 磁盘上仍是扁平的 任务_MMDD_xxx —— 所以这段逻辑没有任何服务端断言能替它把关，
// 只能在真 Chromium 里喂真数据、读真 DOM。同样切 app-01.js 的真源码。
const FL0 = APP02X.indexOf("function fileIcon(");
const FL1 = APP02X.indexOf("// ================= 助理模式");
if (FL0 < 0 || FL1 <= FL0) throw new Error("app-01.js 里的成果文件列表段找不到了（段标题被改过？），前端测试没法定位真源码");
const FILELIST_SRC = APP02X.slice(FL0, FL1);

const FILELIST_HTML = "<!doctype html><meta charset='utf-8'><body><div id='file-list'></div></body>";

// 对话里的「本回合产出」区：卡片只加不减 → 中途造的临时文件删了卡片还在，还把上限占满。
// 真实事故：agent 为了擦掉生图自带的水印造了 8 个中间文件，干完删了，但 8 张卡正好顶满
// OUT_CARD_MAX，唯一那张成品一张卡都没轮上——用户看到 8 个中间过程、0 个成果。
// 同样切 app-01.js 的真源码，不抄。
const TO0 = APP02X.indexOf("// 把本回合的产出做成卡片挂在对话里");
const TO1 = APP02X.indexOf('document.getElementById("toggle-files").onclick');
if (TO0 < 0 || TO1 <= TO0) throw new Error("app-01.js 里的本回合产出段找不到了（段标题被改过？），前端测试没法定位真源码");
const TURNOUT_SRC = APP02X.slice(TO0, TO1);

// 这一屏要验的不止是 DOM 结构，还有「点了收起到底看不看得见」——所以把 index.html 里的
// 真样式整段注进来。只验结构不验样式的话，把 .out-block.packed 那条 CSS 删掉测试照样全绿，
// 用户点了收起却什么也没发生。
const INDEX_CSS = (() => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!m) throw new Error("public/index.html 里找不到内联 <style>，前端测试没法验真样式");
  return m[1];
})();
const TURNOUT_HTML = "<!doctype html><meta charset='utf-8'><style>" + INDEX_CSS + "</style><body></body>";

// 只替掉渲染细节（图标、字号、跳转），判重/上限/回收这些被测逻辑一律用真源码
const TURNOUT_STUBS = `
function esc(s){ const d=document.createElement("div"); d.textContent = s==null?"":String(s); return d.innerHTML; }
function ic(){ return "<svg class='i'></svg>"; }
function fileIcon(){ return "F"; }
function fmtSize(n){ return (n||0) + " B"; }
const revealBtn = (name) => '<span class="dl rv" data-rv="' + esc(name) + '">RV</span>';
function revealFile(){}
function previewFile(){}
function startPreview(){ return Promise.resolve({ running: true }); }
let previewSrv = {};
function toast(){}
const OFFICE_RE = /\.(doc|ppt|xls)$/i;
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

  // ── 整块要能收起来。用户原话：「这些图标都没办法收起来啊，不是属于变更窗口的吗」——
  //    以前只有「查看所有变更」那行能折，上面那排缩略图卡片是钉死的，产出一多就把正文顶没了。
  //    两个开关得互不干扰：收起整块时连「查看所有变更」那行一起按下去。
  {
    const b = fresh();
    const two = [F("报告.pdf"), F("图.png")];
    renderTurnOutputs(b, two, two);
    const block = b.querySelector(".out-block");
    const main = block.querySelector(".out-main");
    const inner = block.querySelector(".out-toggle");
    ok("有一个管整块的开关", !!main && !!inner && main !== inner);
    ok("默认展开：卡片区看得见", !block.classList.contains("packed"));
    ok("整块开关的计数是这一回合的文件数", main.querySelector(".cn").textContent === "(2)");
    main.click();
    ok("点一下整块收起", block.classList.contains("packed"));
    ok("收起时卡片区和变更清单都在被收的那层里",
      block.querySelector(".out-body").contains(block.querySelector(".out-grid")) &&
      block.querySelector(".out-body").contains(block.querySelector(".out-list")) &&
      block.querySelector(".out-body").contains(inner));
    ok("收起时卡片区真的看不见了（验的是浏览器算出来的样式，不是有没有加类名）",
      getComputedStyle(block.querySelector(".out-body")).display === "none");
    ok("收起时标题那行还留着，不然就找不到再点开的地方了",
      getComputedStyle(main).display !== "none" && main.offsetHeight > 0);
    ok("收起时箭头翻过来", main.querySelector(".ar").textContent === "▸");
    main.click();
    ok("再点一下展开", !block.classList.contains("packed") && main.querySelector(".ar").textContent === "▾");
    ok("展开后卡片区又看得见了", getComputedStyle(block.querySelector(".out-body")).display !== "none");
    // 内层那个开关是「变更清单」自己的，不许被整块开关顶替
    ok("变更清单默认仍是收起的", block.classList.contains("fold"));
    inner.click();
    ok("内层开关只动变更清单，不动整块",
      !block.classList.contains("fold") && !block.classList.contains("packed") &&
      inner.querySelector(".ar").textContent === "▾" && main.querySelector(".ar").textContent === "▾");
    renderTurnOutputs(b, [F("补一个.pdf")], [...two, F("补一个.pdf")]);
    ok("再来一批产出时两个计数一起跟上",
      main.querySelector(".cn").textContent === "(3)" && inner.querySelector(".n").textContent === "(3)");
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

  return names;
})()
`;



// 键盘可达：侧栏那几行、成果卡、折叠头本来都是 <div>，鼠标能点、Tab 走不到。
// 补齐这件事的真源码是 app-00-ui.js 里的 markActivatable/onActivate + 全局 keydown，
// 整份直接拉进来跑，不抄。测的是"Enter/空格真的等价于点击"，不是"属性写上了没有"。
const UI00_SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-00-ui.js"), "utf8");
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
  "window.filesCache = [];",
  "window.esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');",
  "window.toast = () => {};",
  "window.snapshotFiles = () => {};",
  "window.sessionId = 's_now';",
  "window.sessionDirs = new Map([['s_now', '任务_0903_本对话']]);",
  "window.fetch = async () => ({ ok: true, json: async () => [] });",
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
  ok("收起后段头箭头翻向", [...el.querySelectorAll(".time-head")].find((n) => n.querySelector(".name").textContent === "今天").firstChild.textContent === "▸");
  [...el.querySelectorAll(".time-head")].find((n) => n.querySelector(".name").textContent === "今天").click();
  ok("再点一下展开回来", between("今天").join() === "任务_0903_本对话", JSON.stringify(between("今天")));

  // 用户自选工作目录：压根不建对话文件夹，文件全在根目录，那才是正文，得原样摊开
  window.sessionDirs = new Map();
  renderFiles([f("甲.txt", t0.getTime()), f("乙.txt", t0.getTime())]);
  ok("没有对话文件夹时根目录文件原样摊开", el.querySelectorAll(".file-item").length === 2 && !el.querySelector(".time-head"), el.innerHTML.slice(0, 120));
  return names;
})()`;

const ATTACH_HTML =
  "<!doctype html><meta charset='utf-8'><body>" +
  "<div class='input-card'><div id='attach-chips'></div><textarea id='input'></textarea></div>" +
  "<button id='attach-btn'></button><input type='file' id='file-input'></body>";

// 页面里其他文件提供的东西，在这儿给最小替身；网络请求全部截下来当证据
const ATTACH_STUBS = [
  "window.uploads = []; window.toasts = []; window.sessionId = 's_test_1';",
  "window.fetch = async (url, init) => {",
  "  if (url === '/api/upload') { window.uploads.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }",
  "  return { ok: true, json: async () => [] };",
  "};",
  "window.toast = (m) => window.toasts.push(m);",
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
  "window.posts = [];",
  "window.fetch = async (url, init) => {",
  "  window.posts.push({ url, body: JSON.parse(init.body) });",
  "  return { ok: true, json: async () => ({ ok: true }) };",
  "};",
  "const chatCol = document.getElementById('chat-col');",
  "const ic = (n) => '<i>' + n + '</i>';",
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
    + '<div class="step-card"><div class="head"><span class="tag">⚙ read_file</span><span class="tag ok">完成</span></div></div>'
    + '<div class="step-card failed"><div class="head"><span class="tag">⚙ run_shell</span><span class="tag err">失败</span></div></div>'
    + '<div class="step-card"><div class="head"><span class="tag">⚙ write_file</span><span class="tag ok">完成</span></div></div>'
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
const TRAIL_SRC = [
  pickLine(/^const TOOL_SHORT = \{.*$/m, "app-01.js 里没有 TOOL_SHORT（轨迹条的短标签表）"),
  pickLine(/^const shortTool = .*$/m, "app-01.js 里没有 shortTool"),
  "let replayFeedback = null;",
  APP02X.slice(TR0, TR1),
].join("\n");
const UI_CSS = fs.readFileSync(path.join(__dirname, "..", "public", "css", "ui.css"), "utf8");
const TRAIL_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body><div id='chat-col'></div></body>";
const TRAIL_STUBS = [
  "var sessionId = 's_t';",
  "var chatCol = document.getElementById('chat-col');",
  "var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');",
  "var renderMd = (t) => '<p>' + esc(t) + '</p>';",
  "var scrollBottom = () => {};",
  "var onActivate = (el, fn) => { el.onclick = fn; return el; };",
  "var wireProcWarn = (chip) => chip;",
  "var ic = (n) => '<i>' + n + '</i>';",
  "var avatarBits = () => ({ html: 'A', cls: '' });",
  "var assistant = { avatar: '', name: 'A' };",
  "var hlTokens = (t) => esc(t);",
  "var stripSceneTag = (t) => t;",
  "var toast = () => {};",
  "var cssEsc = (s) => s;",
  "var curBusy = () => false; var doSend = () => {}; var setMode = () => {}; var syncInputHl = () => {};",
  "var inputEl = document.createElement('textarea');",
  "var isReplaying = false;",
  "window.fetch = async () => ({ ok: true, json: async () => ({}) });",
].join("\n");

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
const IMPANE_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body><div class='settings-pane' id='pane' style='width:720px'></div></body>";
const IMPANE_STUBS = `
var esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
var SAVES = [], SAVES_AT = [], POSTS = [], NAV = [], TEST_FAIL = new Set(), REFRESHED = 0;
var STATUS = { feishu: { configured: true, ws: { state: "connected" } }, qq: { configured: false, state: "off" }, wecom_app: { configured: false }, wechat_mp: { configured: false },
  wechat_ilink: { configured: false, state: "off" }, wecom: { configured: true }, dingtalk: { configured: false }, webhook: { configured: true, secret_set: false }, sessions: { count: 3 } };
var QR = { status: "wait" }, SESS = { count: 3 };
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
  ok("没连的 QQ 卡摊开等你填", !qq.classList.contains("packed") && disp(qq.querySelector(".im-card-b")) !== "none");
  ok("没连的卡按钮是「连接」", qq.querySelector(".im-conn").textContent === "连接");
  ok("配了 webhook 的推送卡亮绿", wb.classList.contains("on") && wb.querySelector(".im-st em").textContent === "已配置");
  ok("没配的钉钉卡灰", dt.querySelector(".im-st").classList.contains("off") && !dt.classList.contains("packed"));
  const secretIds = [...pane.querySelectorAll("input")].filter((i) => /secret|aes_key/.test(i.id));
  ok("密钥框全是密码型", secretIds.length >= 7 && secretIds.every((i) => i.type === "password"), secretIds.map((i) => i.id + ":" + i.type).join(","));
  ok("App ID 这种明文框不是密码型", pane.querySelector("#im-feishu-app_id").type === "text");
  const helps = [...pane.querySelectorAll(".im-help")];
  ok("申请步骤折起来了", helps.length >= 9 && helps.every((d) => !d.open));
  const vis = pane.innerText.replace(/\\s+/g, "");
  ok("默认可见文字不超载（<900 字）", vis.length < 900, String(vis.length));
  ok("整段申请说明默认看不见", !vis.includes("飞书开放平台创建自建应用"));
  const qqHelp = qq.querySelector(".im-help"); // 用摊开着的 QQ 卡验：收起的卡里点开也看不见，那是另一回事
  qqHelp.open = true;
  ok("点开「怎么拿凭证」才露出步骤", pane.innerText.includes("QQ 开放平台"));
  qqHelp.open = false;

  // ---- 3. 卡头点一下展开/收起 ----
  fsC.querySelector(".im-card-h").click();
  ok("点卡头展开", !fsC.classList.contains("packed") && disp(fsC.querySelector(".im-card-b")) !== "none");
  fsC.querySelector(".im-card-h").click();
  ok("再点收起", fsC.classList.contains("packed"));
  fsC.querySelector(".im-card-h").click();
  ok("上下文管理的静态卡点卡头不折叠", (pane.querySelector(".im-card-static .im-card-h").click(), disp(pane.querySelector(".im-card-static .im-card-b")) !== "none"));

  // ---- 4. 连接 = 先保存再测活 → 刷状态 → 收起 ----
  qq.querySelector("#im-qq-app_id").value = "102";
  qq.querySelector("#im-qq-app_secret").value = "s";
  STATUS.qq = { configured: true, state: "connected" };
  qq.querySelector(".im-conn").click();
  await settle();
  ok("连接先保存，载荷带 QQ 凭证", SAVES.length === 1 && SAVES[0].im.qq.app_id === "102" && SAVES[0].im.qq.app_secret === "s", JSON.stringify(SAVES[0] && SAVES[0].im.qq));
  ok("载荷带闲置小时数", SAVES[0].im.session_idle_hours === 12);
  ok("保存之后才测活", POSTS.indexOf("/im/qq/test") >= SAVES_AT[0] && POSTS.indexOf("/im/qq/test") >= 0, POSTS.join(","));
  ok("测活结果写在卡上", qq.querySelector('[data-r="qq"]').textContent.startsWith("✅"), qq.querySelector('[data-r="qq"]').textContent);
  ok("连上后绿灯 + 「取消连接」 + 收起", qq.querySelector(".im-st").classList.contains("ok") && qq.querySelector(".im-conn").textContent === "取消连接" && qq.classList.contains("packed"));
  ok("连接后刷新了顶栏的在线数", REFRESHED >= 2);

  // ---- 5. 测活失败：红字、不收起、按钮还是「连接」 ----
  TEST_FAIL.add("/im/wechat/test");
  wca.querySelector("#im-wecom_app-corp_id").value = "ww";
  wca.querySelector(".im-conn").click();
  await settle();
  ok("测活失败红字说明", wca.querySelector('[data-r="wecom_app"]').textContent.startsWith("❌"));
  ok("测活失败不收起、按钮仍是「连接」", !wca.classList.contains("packed") && wca.querySelector(".im-conn").textContent === "连接");
  TEST_FAIL.delete("/im/wechat/test");

  // ---- 6. 取消连接：两步确认，只清自己那组 ----
  const n0 = SAVES.length;
  const fb = fsC.querySelector(".im-conn");
  fb.click();
  await settle();
  ok("第一下只是问一句", fb.textContent === "确认断开？" && fb.classList.contains("danger"));
  ok("第一下没动凭证也没保存", SAVES.length === n0 && fsC.querySelector("#im-feishu-app_id").value === "cli_x");
  ok("问一句的红是真画出来的", getComputedStyle(fb).color !== getComputedStyle(qq.querySelector(".im-conn")).color);
  STATUS.feishu = { configured: false, ws: { state: "off" } };
  fb.click();
  await settle();
  ok("第二下清空这一组凭证", fsC.querySelector("#im-feishu-app_id").value === "" && fsC.querySelector("#im-feishu-app_secret").value === "");
  ok("清空后保存的载荷里飞书凭证是空串", SAVES.length === n0 + 1 && SAVES[n0].im.feishu.app_id === "" && SAVES[n0].im.feishu.app_secret === "");
  ok("只清飞书，别的通道没动", SAVES[n0].im.qq.app_id === "102" && SAVES[n0].im.wecom_bot_webhook === "https://qyapi/x");
  ok("断开后灯灭、按钮回「连接」、卡摊开", fsC.querySelector(".im-st").classList.contains("off") && fb.textContent === "连接" && !fsC.classList.contains("packed"));

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
  return names;
})();
`;


// ================= 首次开箱向导（真源码切片：ONB_TIPS … finishOnb） =================
const APP03 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-03.js"), "utf8");
const ONB0 = APP03.indexOf("const KEY_SOURCES = {");
const ONB1 = APP03.indexOf("// ================= 主区页面视图");
if (ONB0 < 0 || ONB1 < 0 || ONB1 < ONB0) throw new Error("app-03.js 里找不到向导那一段（KEY_SOURCES … 主区页面视图）");
const ONB_SRC = APP03.slice(ONB0, ONB1);
const ONB_HTML = "<!doctype html><meta charset='utf-8'><style>" + UI_CSS + "\n" + INDEX_CSS + "</style><body>"
  + "<div class='auth-mask' id='onb-mask'><div class='auth-card onb-card'><div class='onb-steps' id='onb-steps'></div><div id='onb-body'></div></div></div></body>";
const ONB_STUBS = `
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  const TOASTS = [], POSTS = [], MODALS = []; let REFRESHED = 0;
  function toast(m) { TOASTS.push(String(m)); }
  function refreshSettingsCache() { REFRESHED++; }
  function openModal(k, sub) { MODALS.push(k + ":" + (sub || "")); }
  // 体检表：大脑没接上、搜索没配、图已配、IM 配了 1 个、本机只装了 codex
  let ST = { needs_setup: true, seen: false, brain: { ok: false, via: "api", name: "", model: "" }, active_model: "DeepSeek", workspace_dir: "/tmp/ws",
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
  ok("第一步在步骤条上打了 ✓", steps.querySelectorAll(".onb-step")[0].classList.contains("done") && steps.querySelectorAll(".onb-step")[0].textContent.includes("✓"));

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
  return names;
})().catch((e) => { throw new Error("[向导] " + ((e && (e.stack || e.message)) || String(e)) + " | 已过 " + (window.__onbNames || 0)); })
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
  ok("点 English：外观页标题立刻变英文（🌗 Theme）、<html lang=en>、English 选中", /🌗 Theme/.test(pane.textContent) && !/🌗 主题/.test(pane.textContent) && html.lang === "en" && onePressed("lang") && pane.querySelector('[data-k="lang"] button.on').dataset.v === "en");
  ok("English：左栏「当前」等界面词翻了（Current），用户气泡「你好」和 AI 正文「标题/正文」原样（内容不是界面）", $("#hia").textContent === "Current" && $("#bub").textContent === "你好" && $("#h1").textContent === "标题" && $("#p").textContent === "正文");
  ok("English：语言偏好读回 en（存储被禁也记得住）", I18N.getLang() === "en");
  renderLookPane(pane);
  await new Promise((r) => setTimeout(r, 25)); // 观察者是异步的：应用写完 innerHTML，下一拍才翻
  ok("English 下重开外观页：新渲染的中文文案也被翻成英文（🎨 Skin）", /🎨 Skin/.test(pane.textContent) && !/皮肤/.test(pane.textContent));
  click("lang", "zh");
  ok("点回 中文：整页还原（🌗 主题）、<html lang=zh-CN>", /🌗 主题/.test(pane.textContent) && !/Theme/.test(pane.textContent) && html.lang === "zh-CN" && I18N.getLang() === "zh");

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

const TRAIL_CHECKS = `
(async () => {
  const names = [];
  const ok = (name, cond, msg) => { if (!cond) throw new Error(name + "：" + (msg || "断言失败")); names.push(name); };
  const disp = (el) => getComputedStyle(el).display;
  const chips = (t) => [...t.querySelectorAll(".proc-head .trail .tc")];

  // ---- 1. 一轮完整的执行：读×2（合并）、命令（出错）、写、飞书（MCP） ----
  const ui = createTurnUI("做个页面", "craft", "s_t");
  const t = ui.turn;
  ui.handleEvent({ type: "text", delta: "先看看文件" });
  ui.handleEvent({ type: "tool_use", id: "a", name: "read_file", purpose: "读 a", at: 1000 });
  ok("第一步就挂上徽章且在转", chips(t).length === 1 && chips(t)[0].classList.contains("run"));
  ok("徽章用短标签不用原名", chips(t)[0].textContent.startsWith("📄 读"), chips(t)[0].textContent);
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
  return names;
})()`;

const PREVIEW_HTML =
  "<!doctype html><meta charset='utf-8'><body>" +
  "<div id='preview-panel'></div><div id='files-panel'></div><div id='pv-body'></div>" +
  "<span id='pv-name'></span><a id='pv-dl'></a>" +
  "<button id='pv-close'></button><button id='pv-sys'></button><button id='pv-rv'></button></body>";

// 网络请求全部截下来：既当替身，也当"到底发了什么请求"的证据（Range 头就是这么验的）
const PREVIEW_STUBS = [
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
      video: ["成片.mp4", "a.mov", "a.webm", "a.m4v"],
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
    ok("兜底按钮真能定位文件", window.opened.at(-1) === "reveal:a.pcm");
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
    ok("卡片结构齐全", d.querySelector(".svg-fig .svg-body svg") && d.querySelectorAll(".svg-acts button").length === 3);
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
    const r = F.extractSvgFigures(partial);
    ok("半截 SVG 也出图", r.figs.length === 1);
    const d = parse(r.figs[0]);
    ok("半截图标出绘制中", !!d.querySelector(".svg-acts .growing"));
    ok("半截图内容已渲染", d.querySelector("svg text") && d.querySelector("svg text").textContent === "半截");
    ok("吐到一半的标签被丢掉", !d.querySelector("svg rect"));
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
  "var BUSY = false; const curBusy = () => BUSY;",
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

  // ---- 闲着 ----
  updateSendUI();
  ok("闲着：排队条不显示、里面是空的", !bar.classList.contains("show") && bar.innerHTML === "");
  ok("闲着：按钮是「↑」、title 说的是发送 + Enter", sendBtn.textContent === "↑" && !sendBtn.classList.contains("stop") && sendBtn.title.includes("发送") && sendBtn.title.includes("Enter"), sendBtn.title);
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
  ok("停止是一颗真按钮（<button>），不是一段文字里的 ◼", !!stopBtn && stopBtn.tagName === "BUTTON" && stopBtn.textContent.includes("◼"), stopBtn && stopBtn.outerHTML);
  const before = stops(); stopBtn.click();
  ok("点排队条里的「让我停下」真的调 stopTask", stops() === before + 1);
  ok("停止按钮 title 提到 Esc 快捷键", stopBtn.title.includes("Esc"), stopBtn.title);
  ok("任务在跑、框空着：发送键变「◼」带 .stop，title 说停下 + Esc", sendBtn.textContent === "◼" && sendBtn.classList.contains("stop") && sendBtn.title.includes("停") && sendBtn.title.includes("Esc"), sendBtn.title);
  ok("任务在跑：输入框提示语告诉用户「打字 + Enter 就插进来」", inputEl.placeholder.includes("Enter") && inputEl.placeholder.includes("插") && inputEl.placeholder !== MODE_PLACEHOLDER.craft, inputEl.placeholder);
  const b0 = stops(); sendBtn.click();
  ok("框空着点发送键 = 停下", stops() === b0 + 1);

  // ---- 任务在跑、打了字 ----
  typeIn("改成蓝色");
  ok("一打字：发送键变回「↑」、去掉 .stop、加 .interject", sendBtn.textContent === "↑" && !sendBtn.classList.contains("stop") && sendBtn.classList.contains("interject"), sendBtn.className);
  ok("打了字的 title 说清是「插一句」+ Enter", sendBtn.title.includes("插一句") && sendBtn.title.includes("Enter"), sendBtn.title);
  const b1 = stops(); sendBtn.click();
  ok("打了字点发送键：走 send（插队）不走停止 —— 以前这里一点任务就没了", CALLS[CALLS.length - 1] === "send:改成蓝色" && stops() === b1, CALLS.join(","));
  ok("发出去框空了：按钮自己回到「◼ 停下」，不用等下一次 updateSendUI", sendBtn.textContent === "◼" && sendBtn.classList.contains("stop") && !sendBtn.classList.contains("interject"), sendBtn.className);
  typeIn("再加个标题");
  ok("Shift+Enter 只换行不发", !press("Enter", true) && CALLS[CALLS.length - 1] !== "send:再加个标题");
  ok("Enter 发出去（默认行为被拦，不会真换行）", press("Enter", false) && CALLS[CALLS.length - 1] === "send:再加个标题", CALLS.join(","));
  ok("Enter 发完按钮回到「◼」", sendBtn.textContent === "◼");
  pendingAttach.push("截图.png"); syncSendBtn();
  ok("只贴了附件没打字：也算有话要说 → 「↑」", sendBtn.textContent === "↑" && !sendBtn.classList.contains("stop"));
  pendingAttach.length = 0; syncSendBtn();
  ok("附件撤掉：回到「◼」", sendBtn.textContent === "◼" && sendBtn.classList.contains("stop"));

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
  ok("任务结束：发送键回到「↑ 发送」", sendBtn.textContent === "↑" && !sendBtn.classList.contains("stop") && !sendBtn.classList.contains("interject") && sendBtn.title.includes("发送"));
  ok("每次 updateSendUI 都刷了侧栏（运行中小圆点）", HIST >= 3, HIST);
  return names;
})()
`;

// 渲染进程的 console 抄一份到主进程：页面里抛错时 executeJavaScript 只回一句
// 「Script failed to execute」，真正的报错文本在渲染进程 console 里，不抄出来根本没法定位。
const RENDERER_LOG = [];
function mkWin(opts) {
  const w = new BrowserWindow(opts);
  RENDERER_LOG.length = 0;
  w.webContents.on("console-message", (ev, level, message, line, sourceId) => {
    const m = ev && typeof ev === "object" && "message" in ev ? ev : { level, message, lineNumber: line, sourceId };
    RENDERER_LOG.push({ level: String(m.level), message: String(m.message), line: m.lineNumber, src: m.sourceId });
  });
  return w;
}
app.whenReady().then(async () => {
  const win = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
  let code = 0;
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><meta charset='utf-8'><body></body>"));
    await win.webContents.executeJavaScript(SVGFIG);
    const names = await win.webContents.executeJavaScript(CHECKS, true);
    for (const n of names) console.log("  ✓ " + n);
    console.log(`✅ 前端：内联 SVG 信息图（渲染/流式/清洗/作用域/导出）${names.length} 项通过`);

    // 附件那一段要在干净的 DOM 里跑：真源码里有 document 级监听，和上面的用例混在一起会互相打架
    const win2 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win2.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ATTACH_HTML));
      // 替身 + 真源码 + 断言必须是同一段脚本：源码里的 const 是脚本级作用域，分两次注入就互相看不见了
      const names2 = await win2.webContents.executeJavaScript(ATTACH_STUBS + "\n" + ATTACH_SRC + "\n" + ATTACH_CHECKS, true);
      for (const n of names2) console.log("  ✓ " + n);
      console.log(`✅ 前端：粘贴/拖拽附件（截图·文件·大段文字）${names2.length} 项通过`);
    } finally {
      if (!win2.isDestroyed()) win2.destroy();
    }

    const win3 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win3.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PREVIEW_HTML));
      const names3 = await win3.webContents.executeJavaScript(PREVIEW_STUBS + "\n" + PATHHELP_SRC + "\n" + PREVIEW_SRC + "\n" + PREVIEW_CHECKS, true);
      for (const n of names3) console.log("  ✓ " + n);
      console.log(`✅ 前端：文件预览（路由·音视频·docx/xlsx/pptx/zip 结构化·CSV·兜底）${names3.length} 项通过`);
    } finally {
      if (!win3.isDestroyed()) win3.destroy();
    }

    const win4 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win4.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(FB_HTML));
      const names4 = await win4.webContents.executeJavaScript(FB_STUBS + "\n" + FB_WRAP(FB_SRC) + "\n" + FB_CHECKS, true);
      for (const n of names4) console.log("  ✓ " + n);
      console.log(`✅ 前端：👍👎 反馈上报（真发 payload·下标跟位置·理由选填·改判撤高亮）${names4.length} 项通过`);
    } finally {
      if (!win4.isDestroyed()) win4.destroy();
    }
    const win5 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win5.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(FILELIST_HTML));
      const names5 = await win5.webContents.executeJavaScript(FILELIST_STUBS + "\n" + PATHHELP_SRC + "\n" + FILELIST_SRC + "\n" + FILELIST_CHECKS, true);
      for (const n of names5) console.log("  ✓ " + n);
      console.log(`✅ 前端：成果面板按时间分段（今天/昨天/7天/按月·取最近动过·折叠独立·根目录降级）${names5.length} 项通过`);
    } finally {
      if (!win5.isDestroyed()) win5.destroy();
    }
    const win7 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win7.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TURNOUT_HTML));
      const names7 = await win7.webContents.executeJavaScript(TURNOUT_STUBS + "\n" + PATHHELP_SRC + "\n" + TURNOUT_SRC + "\n" + TURNOUT_CHECKS, true);
      for (const n of names7) console.log("  ✓ " + n);
      console.log(`✅ 前端：本回合产出（删掉的中间文件跟着撤·成品不被挤掉·截断不误杀·并卡只摘链接·整块可收起）${names7.length} 项通过`);
    } finally {
      if (!win7.isDestroyed()) win7.destroy();
    }
    const win8 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      assertFailedCardsCollapsed();
      await win8.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SCROLLGUIDE_HTML));
      const names8 = await win8.webContents.executeJavaScript(SCROLLGUIDE_STUBS + "\n" + SCROLLGUIDE_SRC + "\n" + SCROLLGUIDE_CHECKS, true);
      for (const n of names8) console.log("  ✓ " + n);
      console.log(`✅ 前端：长对话滚动引导（回到最前/回到最新挂红点·看历史不被拽）+ 出错步骤卡默认收起、角标直达 ${names8.length} 项通过`);
    } finally {
      if (!win8.isDestroyed()) win8.destroy();
    }
    const win9 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win9.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(TRAIL_HTML));
      const names9 = await win9.webContents.executeJavaScript(TRAIL_STUBS + "\n" + TRAIL_SRC + "\n" + TRAIL_CHECKS, true);
      for (const n of names9) console.log("  ✓ " + n);
      console.log(`✅ 前端：轨迹条（同名合并·出错标红·中止删除线·+N 上限·收起可见·点徽章直达）+ 结论出过程区 + 命中率封顶 ${names9.length} 项通过`);
    } finally {
      if (!win9.isDestroyed()) win9.destroy();
    }
    const win12 = mkWin({ show: false, width: 900, height: 900, webPreferences: { offscreen: true } });
    try {
      await win12.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOOK_HTML));
      const names12 = await win12.webContents.executeJavaScript(I18N_SRC + "\n(async function(){\n" + LOOK_SRC + "\n" + LOOK_CHECKS + "\n})()", true)
        .catch((e) => { throw new Error("[外观] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of names12) console.log("  ✓ " + n);
      console.log(`✅ 前端：外观页（字号四档按 calc 联动·六皮肤浅暗对比度矩阵·密度只收间距·字体三选·主题即点即生效·存储被禁退内存·默认不留脏属性）${names12.length} 项通过`);
    } finally {
      if (!win12.isDestroyed()) win12.destroy();
    }
    const win14 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win14.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(I18N_HTML));
      const names14 = await win14.webContents.executeJavaScript(I18N_SRC + "\n" + I18N_CHECKS, true)
        .catch((e) => { throw new Error("[语言] " + ((e && (e.stack || e.message)) || String(e))); });
      for (const n of names14) console.log("  ✓ " + n);
      console.log(`✅ 前端：中英文切换（点即整页翻·后渲染的节点观察者接手·属性也翻·内容区不碰·切回中文原样还原·不自激振荡）${names14.length} 项通过`);
    } finally {
      if (!win14.isDestroyed()) win14.destroy();
    }
    const win11 = mkWin({ show: false, width: 900, height: 900, webPreferences: { offscreen: true } });
    try {
      await win11.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(ONB_HTML));
      const names11 = await win11.webContents.executeJavaScript(I18N_SRC + "\n" + ONB_STUBS + "\n" + ONB_SRC + "\n" + ONB_CHECKS, true);
      for (const n of names11) console.log("  ✓ " + n);
      console.log(`✅ 前端：首次开箱向导（大脑必配·云端/本机二选一·验活失败不翻页·搜索保存再测活·多媒体按行填·清单收尾·走完不再弹·关于页可重开）${names11.length} 项通过`);
    } finally {
      if (!win11.isDestroyed()) win11.destroy();
    }
    const win10 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win10.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(IMPANE_HTML));
      const names10 = await win10.webContents.executeJavaScript(IMPANE_STUBS + "\n" + IMPANE_SRC + "\n" + IMPANE_CHECKS, true);
      for (const n of names10) console.log("  ✓ " + n);
      console.log(`✅ 前端：助理设置页（四分区·双栏·连上收起·连接=保存再测活·取消连接两步且只清自己·微信取码/断开·清会话两步）${names10.length} 项通过`);
    } finally {
      if (!win10.isDestroyed()) win10.destroy();
    }
    const win13 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win13.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(COMPOSER_HTML));
      const names13 = await win13.webContents.executeJavaScript(COMPOSER_STUBS + "\n" + COMPOSER_SRC + "\n" + COMPOSER_CHECKS, true);
      for (const n of names13) console.log("  ✓ " + n);
      console.log(`✅ 前端：运行中的输入框（提示讲清插话/停下/并行·停止是真按钮·一颗键按有没有字切停下/插一句·提示语跟忙闲·发完自动回停下）${names13.length} 项通过`);
    } finally {
      if (!win13.isDestroyed()) win13.destroy();
    }
    const win6 = mkWin({ show: false, width: 900, height: 700, webPreferences: { offscreen: true } });
    try {
      await win6.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(KBD_HTML));
      const names6 = await win6.webContents.executeJavaScript(UI00_SRC + "\n" + KBD_CHECKS, true);
      for (const n of names6) console.log("  ✓ " + n);
      console.log(`✅ 前端：键盘可达（侧栏行/成果卡 Tab 得到·回车空格等价点击·按钮不套按钮）${names6.length} 项通过`);
    } finally {
      if (!win6.isDestroyed()) win6.destroy();
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
