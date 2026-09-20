"use strict";
/**
 * 无限画布：一张画布反复加载、反复同步之后，上面的东西必须还是那些东西。
 *
 * 跑法：npx electron test/canvas.js
 *
 * 这一页有 2400 行，之前一套测试都没有。补的时候先照着「什么情况下用户会白干」
 * 找，找出来三件，全都不报错、不弹窗，人是过一会儿才发现的：
 *
 *   ① 节点标题只要叫「开始工作」或「开始创作」，下次打开就没了。
 *      加载那一步有一句按标题删节点的代码——本来是想清掉模板留下的起始卡片，
 *      可代码里从来没有谁造过这两个标题的节点，于是它这辈子只删得到用户自己写的。
 *      而且删完还顺手存了一次盘：本机那份、服务器那份、连着的线，一起没。
 *      「开始工作」正是人给第一张卡片起的名字。
 *
 *   ② 同步拉回来的快照，应用完立刻原样回写一遍。
 *      单开一个标签页看不出来（自己写完自己收下，就停了）；开两个就停不下来：
 *      A 收到 B 的版本 → 写回去（服务端把 updatedAt 换成现在）→ B 看见「更新了」
 *      → 应用 → 再写回去……谁都没动画布，两边每 1.8 秒各写一次盘，
 *      每次还连带把旧文件拷一份 .bak。
 *
 *   ③ 框选了一片，来一趟同步就只剩一个还选着。
 *      下一下 Delete 删掉的就不是你以为的那一片。
 *
 * 这三件都是「界面照常、数据在变」，假 DOM 测不出来（要 joint 真画、要真 localStorage），
 * 第二轮又量到两件同一类的：切项目、切画布那一下，这张画布的东西会写到那张上。在第六、七节。
 *
 * 所以跟 preview-layout / library-mkdir 一样开真 Chromium 喂真 public/。
 */

// 被 node 直接拉起来时自己换成 electron；没装就跳过（纯服务端部署没有界面这一层）
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron，画布要真浏览器才画得出来（纯服务端部署没有界面）");
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
// 画布的三件套是按需加载的，服务端从 node_modules 原样提供，这儿照搬那两条路由
const VENDOR = {
  "/vendor/joint/joint.min.js": path.join(ROOT, "node_modules/@joint/core/dist/joint.min.js"),
  "/vendor/dagre/dagre.min.js": path.join(ROOT, "node_modules/@dagrejs/dagre/dist/dagre.min.js"),
};

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
      const file = VENDOR[rel] || path.join(PUB, path.normalize(rel).replace(/^([/\\.]+)/, ""));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("nope"); }
      const buf = fs.readFileSync(file);
      res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.end(buf);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// 一台假服务器：收得下 PUT、记得住收到了什么，下一趟 GET 就照这份回话。
// 真实现的 updatedAt 是服务端每次写盘时打的（tools.js canvasWriteState），这儿照做，
// 「写回去就变新、变新就再拉回来」那条死循环全靠这一行才复现得出来
const STUB = `
(() => {
  window.__puts = [];
  settingsCache = { workspace_dir: "/tmp/ws" };
  const J = (d) => Promise.resolve({ ok: true, status: 200, json: async () => d });
  window.__remote = { version: 1, nodes: [], edges: [], updatedAt: 1000 };
  const real = window.fetch;
  window.fetch = function (u, o) {
    const s = String(u), m = ((o && o.method) || "GET").toUpperCase();
    if (s.includes("/api/canvas/list")) return J({ canvases: [{ name: "main", title: "主画布", nodes: 0 }] });
    if (s.includes("/api/canvas/assets")) return J({ files: [] });
    if (s.includes("/api/canvas/progress")) return J({});
    if (s.startsWith("/api/canvas") && m === "PUT") {
      const b = JSON.parse(o.body);
      window.__puts.push(b.state);
      window.__remote = { ...b.state, updatedAt: Date.now() };
      return J({ ok: true, state: window.__remote });
    }
    if (s.includes("/api/canvas")) return J(window.__remote);
    if (s.includes("/api/projects")) return J({ projects: [] });
    if (s.includes("/api/settings")) return J(settingsCache);
    return real.apply(this, arguments);
  };
})()
`;

/** 三个节点两条线。头尾那两个的标题正是被按标题删掉的那两句 */
const BOARD = {
  version: 1, updatedAt: 2000,
  nodes: [
    { id: "n1", kind: "note", payload: { title: "开始工作", text: "今天要做的事" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } },
    { id: "n2", kind: "note", payload: { title: "第二步", text: "写提纲" }, position: { x: 400, y: 40 }, size: { width: 300, height: 200 } },
    { id: "n3", kind: "note", payload: { title: "开始创作", text: "分镜" }, position: { x: 760, y: 40 }, size: { width: 300, height: 200 } },
  ],
  edges: [{ source: { id: "n1" }, target: { id: "n2" } }, { source: { id: "n2" }, target: { id: "n3" } }],
};
/** 三个普通标题的节点，用来量选中和同步——跟标题那件事不搅在一起 */
const PLAIN = {
  version: 1, updatedAt: 2000,
  nodes: [
    { id: "p1", kind: "note", payload: { title: "第一步" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } },
    { id: "p2", kind: "note", payload: { title: "第二步" }, position: { x: 400, y: 40 }, size: { width: 300, height: 200 } },
    { id: "p3", kind: "note", payload: { title: "第三步" }, position: { x: 760, y: 40 }, size: { width: 300, height: 200 } },
  ],
  edges: [],
};


// 第二台假服务器：两个项目各一套画布。真实现里 /api/canvas 只收画布名，落到哪个文件是服务端
// 按「当前打开的项目」自己定的，所以这儿照那样——PUT 一律落到「当前项目 + 请求里的画布名」那一格。
// __delay 是给「等回包的工夫切走了」那条用的
const STUB2 = `
(() => {
  window.__store = {
    jia: { main: { version: 1, nodes: [], edges: [], updatedAt: 1000 } },
    yi: { main: { version: 1, nodes: [], edges: [], updatedAt: 1000 } },
  };
  window.__active = "jia"; window.__puts = []; window.__delay = 0;
  const J = (d) => Promise.resolve({ ok: true, status: 200, json: async () => d });
  const real = window.fetch;
  window.fetch = function (u, o) {
    const s = String(u), m = ((o && o.method) || "GET").toUpperCase();
    const name = decodeURIComponent(((s.split("?")[1] || "").match(/name=([^&]*)/) || [])[1] || "main");
    const mine = window.__store[window.__active];
    if (s.includes("/api/canvas/list")) return J({ canvases: Object.keys(mine).map((n) => ({ name: n, title: n, nodes: 0 })) });
    if (s.includes("/api/canvas/assets")) return J({ files: [] });
    if (s.includes("/api/canvas/progress")) return J({});
    if (s.includes("/api/canvas/boards") && m === "POST") {
      const n = JSON.parse(o.body).name;
      if (mine[n]) return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "已经有同名画布" }) });
      // 服务端新建出来的是一份「还没人动过」的空画布：updatedAt 留 0（见 server.js 那条路由）
      mine[n] = { version: 1, nodes: [], edges: [], updatedAt: 0 };
      return J({ ok: true, name: n, state: mine[n] });
    }
    if (s.includes("/api/canvas/boards") && m === "DELETE") {
      delete mine[decodeURIComponent(s.split("/api/canvas/boards/")[1] || "")];
      return J({ ok: true });
    }
    if (s.startsWith("/api/canvas") && m === "PUT") {
      const b = JSON.parse(o.body);
      window.__puts.push({ 项目: window.__active, 画布: b.name, 标题: (b.state.nodes || []).map((n) => (n.payload || {}).title) });
      mine[b.name] = { ...b.state, updatedAt: Date.now() };
      return J({ ok: true, state: mine[b.name] });
    }
    if (s.includes("/api/canvas")) {
      if (window.__offline) return Promise.reject(new Error("断网"));   // 只掐这一条：取画布内容
      const body = mine[name] || { version: 1, nodes: [], edges: [], updatedAt: 0 };
      if (!window.__delay) return J(body);
      return new Promise((r) => setTimeout(() => r({ ok: true, status: 200, json: async () => body }), window.__delay));
    }
    if (s.includes("/api/projects/switch")) { window.__active = JSON.parse(o.body).name; return J({ ok: true, active: window.__active }); }
    if (s.includes("/api/projects")) return J({ active: window.__active, projects: [{ name: "jia", dir: "/tmp/jia" }, { name: "yi", dir: "/tmp/yi" }] });
    if (s.includes("/api/settings")) return J(settingsCache);
    if (s.includes("/api/modes")) return J({ modes: [] });
    if (s.includes("/api/files")) return J({ files: [] });
    return real.apply(this, arguments);
  };
})()
`;

app.whenReady().then(async () => {
  const srv = await serve();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  await win.loadURL(`http://127.0.0.1:${srv.address().port}/index.html`);
  await new Promise((r) => setTimeout(r, 900));
  const run = (code) => win.webContents.executeJavaScript(code);
  await run(STUB);
  // 语言钉成中文：Electron 的 navigator.language 随系统走，CI 那台是英文，
  // 而下面几条断言照的是中文标题和中文提示语
  await run('I18N.setLang("zh")');

  console.log("\n— 画布开得起来 —");
  const booted = await run(`
    (async () => {
      chatCol.innerHTML = '<div class="assist-page" id="assist-page"></div>';
      await renderCanvasLazy();
      await new Promise((r) => setTimeout(r, 500));
      // 同步那根定时器在这套测试里只会添乱：它每 1.8 秒自己拉一趟、自己应用一次，
      // 量「应用完发了几趟 PUT」的时候分不清是谁发的。要验的循环在下面手动跑一遍
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return { apply: typeof canvasApplySnapshot, add: typeof canvasAddNode, joint: typeof joint };
    })()`);
  ok(booted.apply === "function" && booted.add === "function" && booted.joint === "object",
     "画布本体和 joint 都真加载起来了（不是拿假 DOM 糊过去的）", booted);

  console.log("\n— 一、节点不许因为标题被吞 —");
  const keep = await run(`
    (async () => {
      window.__puts = [];
      canvasApplySnapshot(${JSON.stringify(BOARD)});
      await new Promise((r) => setTimeout(r, 500));
      const saved = JSON.parse(localStorage.getItem(canvasStorageKey()) || "null");
      return {
        屏幕: canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title),
        连线: canvasState.graph.getLinks().length,
        本机: (saved && saved.nodes || []).map((n) => n.payload && n.payload.title),
        发出去的: (window.__puts[0] && window.__puts[0].nodes || []).map((n) => n.payload && n.payload.title),
      };
    })()`);
  ok(keep.屏幕.length === 3,
     "★三个节点进来，屏幕上还是三个★ 有一句按标题删节点的代码，专删标题叫「开始工作」「开始创作」的——"
     + "而这两个标题从来没有哪段代码造过，能撞上的只有用户自己写的卡片",
     keep.屏幕);
  ok(keep.屏幕.includes("开始工作") && keep.屏幕.includes("开始创作"),
     "★被点名的那两个标题也还在★", keep.屏幕);
  ok(keep.连线 === 2,
     "★两条连线一条不少★ 节点被吞的时候，挂在它身上的线是跟着一起没的", keep.连线);
  ok(keep.本机.length === 3,
     "★本机存的那份也是三个★ 不是只在屏幕上没了——加载完会顺手存一次盘，把少掉的那份坐实",
     keep.本机);
  ok(keep.发出去的.length === 3,
     "★发回服务器的那份也是三个★ 盘上那份画布同样会被改瘦，下次换台机器打开还是少",
     keep.发出去的);
  // 反向对照：真少一个的时候，上面这套量法必须看得见。不验这一下，「三个都在」也可能是量法自己瞎了
  const control = await run(`
    (async () => {
      canvasApplySnapshot({ ...${JSON.stringify(BOARD)}, nodes: ${JSON.stringify(BOARD.nodes)}.slice(0, 2), edges: [], updatedAt: Date.now() });
      await new Promise((r) => setTimeout(r, 300));
      return canvasState.graph.getElements().length;
    })()`);
  ok(control === 2, "★反向对照：快照里真少一个，这套量法当场就数得出来★", control);

  console.log("\n— 二、同步拉回来的东西不许原样回写 —");
  // 这一段必须走真的同步定时器，不能自己调 canvasApplySnapshot：
  // 「拉回来的东西不回写」是靠调用处那一下标记生效的，自己调就等于自己给自己发通行证，
  // 真正每 1.8 秒跑的那条路照样在写盘。所以这儿让 canvasStartRemoteSync 自己转两圈
  const echo = await run(`
    (async () => {
      window.__remote = { version: 1, updatedAt: Date.now(), edges: [],
        nodes: [{ id: "m1", kind: "note", payload: { title: "对方改的" }, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }] };
      await canvasFlushRemoteWrite();   // 上一段欠着的那笔先写完，不然下面数回写会把它算进来
      window.__puts = [];
      canvasStartRemoteSync();
      // 等它自己转到，别写死等几秒：一圈 1.8 秒，正在写盘的那一圈会整圈跳过，
      // 机器慢一点就得等到第二圈（3.6 秒）——写死 2.3 秒在 CI 上量到的是「还没拉」
      const 到点 = Date.now() + 12000;
      const 有对方的 = () => canvasState.graph.getElements().some((n) => (n.get("canvasPayload") || {}).title === "对方改的");
      while (Date.now() < 到点 && !有对方的()) await new Promise((r) => setTimeout(r, 120));
      const 拉到了 = canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title);
      await new Promise((r) => setTimeout(r, 2000));   // 第二圈：确认它是停住了，不是慢一拍
      clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null;
      const 回写 = window.__puts.length;
      const 本机 = JSON.parse(localStorage.getItem(canvasStorageKey()) || "null");
      // 再本机改一下：这一下必须发得出去，否则就是把保存关死了
      canvasAddNode("note", { title: "我自己加的" }, { x: 500, y: 300 });
      await new Promise((r) => setTimeout(r, 700));
      return { 拉到了, 回写, 自己改完发了: window.__puts.length - 回写,
               本机存的: (本机 && 本机.nodes || []).map((n) => n.payload && n.payload.title) };
    })()`);
  ok(echo.拉到了.includes("对方改的"),
     "★对方改的东西确实拉下来了★ 拉都没拉到的话，「没回写」是白说的", echo.拉到了);
  ok(echo.回写 === 0,
     "★同步拉回来的快照，应用完不再原样发回去★ 两个标签页同时开着的时候，这一下回写会被对方看成「又更新了」，"
     + "于是对方也应用、也回写——谁都没动画布，两边每 1.8 秒各写一次盘，还各拷一份 .bak",
     echo.回写);
  ok(echo.自己改完发了 >= 1,
     "★但本机真改了东西照样存得出去★ 不验这一条的话，把保存整个关掉也能让上一条变绿",
     echo.自己改完发了);
  ok(echo.本机存的.includes("对方改的"),
     "★本机那份照常跟着更新★ 不回写服务器，不等于本机也不存了", echo.本机存的);

  console.log("\n— 三、多选不许被同步偷偷清掉 —");
  const sel = await run(`
    (async () => {
      canvasApplySnapshot(${JSON.stringify(PLAIN)});
      await new Promise((r) => setTimeout(r, 300));
      const ids = canvasState.graph.getElements().map((n) => String(n.id));
      canvasSetSelection(ids, ids[1]);
      const 同步前 = canvasState.selectedIds.size;
      canvasApplySnapshot({ ...${JSON.stringify(PLAIN)}, updatedAt: Date.now() });
      await new Promise((r) => setTimeout(r, 300));
      const 同步后 = canvasState.selectedIds.size, anchor = canvasState.selected;
      // 对方真删了一个的时候，选中里也不该再留着它
      canvasSetSelection(canvasState.graph.getElements().map((n) => String(n.id)), "p1");
      canvasApplySnapshot({ ...${JSON.stringify(PLAIN)}, nodes: ${JSON.stringify(PLAIN.nodes)}.slice(0, 2), updatedAt: Date.now() });
      await new Promise((r) => setTimeout(r, 300));
      return { 同步前, 同步后, anchor, 删过之后: canvasState.selectedIds.size,
               删过之后还选着谁: [...canvasState.selectedIds] };
    })()`);
  ok(sel.同步前 === 3 && sel.同步后 === 3,
     "★框选了三个，来一趟同步还是三个★ 塌成一个的话，下一下 Delete 删掉的就不是你以为的那一片",
     { 同步前: sel.同步前, 同步后: sel.同步后 });
  ok(sel.anchor === "p2",
     "★属性面板认的那个「刚点的是谁」也还是原来那个★", sel.anchor);
  ok(sel.删过之后 === 2 && !sel.删过之后还选着谁.includes("p3"),
     "★对方真删掉的那个，不会赖在选中集合里★ 留着的话，Delete 会去删一个已经不在的节点",
     sel.删过之后还选着谁);

  console.log("\n— 四、撤销这条路还走得通（回归） —");
  const undo = await run(`
    (async () => {
      canvasApplySnapshot(${JSON.stringify(PLAIN)});
      await new Promise((r) => setTimeout(r, 300));
      canvasHistoryReset(canvasSnapshot());
      const 起点 = canvasState.graph.getElements().length;
      canvasAddNode("note", { title: "临时加的" }, { x: 900, y: 400 });
      canvasHistoryFlush();
      const 加完 = canvasState.graph.getElements().length;
      canvasUndo();
      await new Promise((r) => setTimeout(r, 300));
      const 撤销后 = canvasState.graph.getElements().length;
      canvasRedo();
      await new Promise((r) => setTimeout(r, 300));
      return { 起点, 加完, 撤销后, 重做后: canvasState.graph.getElements().length };
    })()`);
  ok(undo.加完 === undo.起点 + 1 && undo.撤销后 === undo.起点 && undo.重做后 === undo.起点 + 1,
     "★加一个 → 撤销 → 重做，数目一路对得上★ 上面三处都动了加载和存盘这条路，撤销走的是同一条",
     undo);

  console.log("\n— 五、坏数据不许把画布带崩（回归） —");
  const bad = await run(`
    (async () => {
      const out = {};
      try {
        canvasApplySnapshot({ version: 1, updatedAt: Date.now(),
          nodes: [{ id: "q1", kind: "note", payload: { title: "还在的" }, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }],
          edges: [{ source: { id: "q1" }, target: { id: "已经不在了" } }, { source: { id: "q1" }, target: { id: "q1" } }] });
        await new Promise((r) => setTimeout(r, 300));
        out.节点 = canvasState.graph.getElements().length;
        out.连线 = canvasState.graph.getLinks().length;
        out.存盘里的线 = canvasSnapshot().edges.length;
      } catch (e) { out.抛了 = String(e && e.message || e); }
      return out;
    })()`);
  ok(bad.节点 === 1 && bad.连线 === 0 && bad.存盘里的线 === 0 && !bad.抛了,
     "★一头已经不在的线、自己连自己的线，都不画也不存，剩下的节点照常在★", bad);

  console.log("\n— 六、换个项目打开，画布不许串台 —");
  // 换一台两个项目的假服务器。真实现里 /api/canvas 是按「当前打开的那个项目」找文件的，
  // 请求里只带画布名不带项目名——所以写错了人收不回来，只能在切之前就把账算清
  await run(STUB2);
  await run(`
    // 切项目的真路是 canvasSwitchWorkspace：先把欠着的那趟写完 → POST 换项目 → renderCanvasPage 重铺。
    // 这儿只省掉它后半截刷模型菜单、刷文件列表那几步（跟画布无关），画布这一段一步不少
    // typeof 那一下是留给反向对照的：旧版本里根本没有这个函数，加一层才跑得完、才量得出差多少
    window.__switchProject = async (name) => {
      if (typeof canvasFlushRemoteWrite === "function") await canvasFlushRemoteWrite();
      await fetch("/api/projects/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      canvasState.canvasName = "main";
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title);
    };
    "定义好了";   // executeJavaScript 要把最后一句的值搬回主进程，不给个字符串它就想搬函数
  `);
  const cross = await run(`
    (async () => {
      localStorage.clear();
      await window.__switchProject("jia");
      canvasApplySnapshot({ version: 1, updatedAt: Date.now(), edges: [], nodes: [
        { id: "j1", kind: "note", payload: { title: "甲客户的报价单" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } },
        { id: "j2", kind: "note", payload: { title: "甲客户的合同草稿" }, position: { x: 400, y: 40 }, size: { width: 300, height: 200 } }] });
      await new Promise((r) => setTimeout(r, 600));
      const 本机键 = Object.keys(localStorage).filter((k) => k.startsWith("openworkbuddy.canvas.v3:"));
      // 把甲项目盘上那份清掉：这两张卡只剩本机还留着。下面切回甲的时候就得靠这份本机副本
      window.__store.jia.main = { version: 1, nodes: [], edges: [], updatedAt: 1 };
      window.__puts = [];
      const 乙屏幕 = await window.__switchProject("yi");
      const 写进乙的 = window.__puts.filter((p) => p.项目 === "yi").map((p) => p.标题.join("、"));
      const 乙盘上 = (window.__store.yi.main.nodes || []).map((n) => (n.payload || {}).title);
      const 甲屏幕 = await window.__switchProject("jia");
      return { 本机键, 乙屏幕, 写进乙的, 乙盘上, 甲屏幕 };
    })()`);
  ok(!cross.乙屏幕.includes("甲客户的报价单"),
     "★换个项目打开，屏幕上不是上一个项目的东西★ 本机那份副本的键上以前只有画布名、没有项目名，"
     + "两个项目的 main 共用一格——新项目的画布是空的，于是上一个项目的卡片原样铺了上来",
     cross.乙屏幕);
  ok(!cross.乙盘上.includes("甲客户的报价单") && !cross.写进乙的.some((t) => t.includes("甲客户")),
     "★也没有被写进新项目的画布文件★ 铺上去之后还会存一次盘，服务端按「当前打开的项目」找文件，"
     + "这一下就把乙项目自己的画布顶掉了，翻不回来",
     { 乙盘上: cross.乙盘上, 写进乙的: cross.写进乙的 });
  ok(cross.甲屏幕.includes("甲客户的报价单") && cross.甲屏幕.includes("甲客户的合同草稿"),
     "★反向对照：切回甲项目，本机那份照样铺得出来★ 把本机副本整个弃掉也能让上面两条变绿，"
     + "但那样服务器上还没跟上的改动就真没了",
     cross.甲屏幕);
  ok(cross.本机键.length > 0 && cross.本机键.every((k) => k.includes("jia")),
     "★本机存的那份，键上带着是哪个项目★", cross.本机键);

  const legacy = await run(`
    (async () => {
      localStorage.clear();
      window.__store.jia.main = { version: 1, nodes: [], edges: [], updatedAt: 1 };
      window.__store.yi.main = { version: 1, nodes: [], edges: [], updatedAt: 1 };
      // 老版本留在本机的那份，键上只有画布名。第一个来问的项目认领走，第二个不许再拿
      localStorage.setItem("openworkbuddy.canvas.v3:main", JSON.stringify({ version: 1, edges: [], nodes: [
        { id: "o1", kind: "note", payload: { title: "升上来的老画布" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } }] }));
      const 甲屏幕 = await window.__switchProject("jia");
      const 乙屏幕 = await window.__switchProject("yi");
      return { 甲屏幕, 乙屏幕 };
    })()`);
  ok(legacy.甲屏幕.includes("升上来的老画布"),
     "★老版本存在本机的那份画布，升级之后照样打得开★ 换个键存不等于可以不认旧的", legacy.甲屏幕);
  ok(!legacy.乙屏幕.includes("升上来的老画布"),
     "★但只认领一次：第二个项目打开的时候，它不会跟着跑过去★", legacy.乙屏幕);

  const race = await run(`
    (async () => {
      window.__store.jia.main = { version: 1, updatedAt: 9000, edges: [], nodes: [
        { id: "r1", kind: "note", payload: { title: "甲项目盘上那份" }, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }] };
      window.__active = "jia"; canvasState.workspaceName = "jia"; canvasState.canvasName = "main";
      window.__delay = 400;
      const 不切走 = await canvasLoadRemote();
      const 迟到的 = canvasLoadRemote();
      window.__active = "yi"; canvasState.workspaceName = "yi";   // 等回包的工夫切走了
      const 切走了 = await 迟到的;
      window.__delay = 0; window.__active = "jia"; canvasState.workspaceName = "jia";
      return { 不切走: ((不切走 || {}).nodes || []).length, 切走了: 切走了 === null ? "不要了" : "照铺" };
    })()`);
  ok(race.不切走 === 1, "★同步拉一趟，不切走的时候拿得到盘上那份★ 拿不到的话下一条是白说的", race.不切走);
  ok(race.切走了 === "不要了",
     "★等回包的工夫切走了项目，这份迟到的就不要了★ 照铺上去就是拿甲项目的内容盖住乙项目的画布", race.切走了);

  console.log("\n— 七、切画布之前，欠着的那笔要写回它自己那张 —");
  const board = await run(`
    (async () => {
      window.__store.jia.main = { version: 1, nodes: [], edges: [], updatedAt: 1 };
      window.__store.jia.board2 = { version: 1, updatedAt: 1, edges: [], nodes: [
        { id: "b9", kind: "note", payload: { title: "第二张画布本来的东西" }, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }] };
      await window.__switchProject("jia");
      canvasApplySnapshot({ version: 1, updatedAt: Date.now(), edges: [], nodes: [
        { id: "c1", kind: "note", payload: { title: "第一张画布的卡" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } }] });
      await new Promise((r) => setTimeout(r, 700));
      window.__puts = [];
      canvasAddNode("note", { title: "刚敲的一句话" }, { x: 800, y: 40 });   // 这一下点着 240ms 的防抖
      const select = document.querySelector("[data-canvas-board-select]");
      select.value = "board2";
      select.dispatchEvent(new Event("change"));                            // 防抖还没烧完就从下拉框切走
      await new Promise((r) => setTimeout(r, 1200));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return {
        现在这张: canvasState.canvasName,
        屏幕: canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title),
        写到第二张的: window.__puts.filter((p) => p.画布 === "board2").map((p) => p.标题.join("、")),
        第二张盘上: (window.__store.jia.board2.nodes || []).map((n) => (n.payload || {}).title),
        第一张盘上: (window.__store.jia.main.nodes || []).map((n) => (n.payload || {}).title),
      };
    })()`);
  ok(board.现在这张 === "board2" && board.屏幕.includes("第二张画布本来的东西"),
     "★从下拉框切过去，第二张画布上还是它自己的东西★", board);
  ok(!board.第二张盘上.includes("第一张画布的卡") && !board.写到第二张的.some((t) => t.includes("第一张画布的卡")),
     "★上一张画布的内容没被写到这一张上★ 存盘是攒 240 毫秒再发一次，发的时候才去读「现在是哪张画布」——"
     + "这中间切走一下，写出去的就是新画布的名字、旧画布的内容，第二张画布上原来有什么就全没了",
     { 第二张盘上: board.第二张盘上, 写到第二张的: board.写到第二张的 });
  ok(board.第一张盘上.includes("刚敲的一句话"),
     "★而刚敲的那句照样写回了第一张★ 把欠着的那趟直接丢掉也能让上一条变绿，"
     + "但那样切走之前最后改的东西就没了",
     board.第一张盘上);
  const backstop = await run(`
    (async () => {
      window.__store.jia.main = { version: 1, nodes: [], edges: [], updatedAt: 1 };
      window.__store.jia.board2 = { version: 1, updatedAt: 1, edges: [], nodes: [
        { id: "b9", kind: "note", payload: { title: "第二张画布本来的东西" }, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }] };
      canvasState.canvasName = "main"; canvasState.remoteContentKey = ""; canvasState.remoteUpdatedAt = 0;
      canvasApplySnapshot({ version: 1, updatedAt: Date.now(), edges: [], nodes: [
        { id: "d1", kind: "note", payload: { title: "第一张画布的卡" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } }] });
      await new Promise((r) => setTimeout(r, 700));
      window.__puts = [];
      canvasAddNode("note", { title: "又敲了一句" }, { x: 900, y: 40 });
      canvasState.canvasName = "board2";     // 假装有哪条路忘了先写完就切走
      await new Promise((r) => setTimeout(r, 900));
      canvasState.canvasName = "main";
      const 写到第二张的 = window.__puts.filter((p) => p.画布 === "board2").map((p) => p.标题.join("、"));
      const 第二张盘上 = (window.__store.jia.board2.nodes || []).map((n) => (n.payload || {}).title);

      // 再来一遍，这回是项目被切走了。请求里只有画布名，落到哪个项目是服务端按「当前打开的那个」定的——
      // 名字对得上也拦不住，这一笔会结结实实盖到乙项目的 main 上
      window.__store.yi.main = { version: 1, updatedAt: 1, edges: [], nodes: [
        { id: "y9", kind: "note", payload: { title: "乙项目自己的东西" }, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }] };
      canvasState.remoteContentKey = ""; canvasState.remoteUpdatedAt = 0;
      canvasApplySnapshot({ version: 1, updatedAt: Date.now(), edges: [], nodes: [
        { id: "d2", kind: "note", payload: { title: "第一张画布的卡" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } }] });
      await new Promise((r) => setTimeout(r, 700));
      window.__puts = [];
      canvasAddNode("note", { title: "甲项目最后敲的" }, { x: 900, y: 200 });
      window.__active = "yi"; canvasState.workspaceName = "yi";   // 假装有哪条路忘了先写完就换了项目
      await new Promise((r) => setTimeout(r, 900));
      const 写进乙的 = window.__puts.filter((p) => p.项目 === "yi").map((p) => p.标题.join("、"));
      const 乙盘上 = (window.__store.yi.main.nodes || []).map((n) => (n.payload || {}).title);
      window.__active = "jia"; canvasState.workspaceName = "jia";
      return { 写到第二张的, 第二张盘上, 写进乙的, 乙盘上 };
    })()`);
  ok(backstop.写到第二张的.length === 0 && backstop.第二张盘上.length === 1,
     "★万一哪条路忘了先写完就切走，宁可这一笔不写，也不许写到别人头上★ 本机那份还留着，"
     + "回到那张画布接着改照样存得上去；写出去就真盖掉别人的了",
     backstop);
  ok(backstop.写进乙的.length === 0 && backstop.乙盘上.join("、") === "乙项目自己的东西",
     "★换项目也一样：这一笔宁可不写★ 请求里只带画布名，落到哪个项目是服务端按「当前打开的那个」定的——"
     + "画布名对得上也拦不住，写出去就是拿甲项目的内容盖掉乙项目的画布",
     { 写进乙的: backstop.写进乙的, 乙盘上: backstop.乙盘上 });
  const 顺序 = await run(`
    (() => {
      const 项目 = String(canvasSwitchWorkspace), 画布 = String(document.querySelector("[data-canvas-board-select]").onchange);
      const 有 = (s, w) => s.indexOf(w) > -1;
      return {
        项目: 有(项目, "canvasFlushRemoteWrite") && 项目.indexOf("canvasFlushRemoteWrite") < 项目.indexOf("/api/projects/switch"),
        画布: 有(画布, "canvasFlushRemoteWrite") && 画布.indexOf("canvasFlushRemoteWrite") < 画布.indexOf("canvasState.canvasName ="),
      };
    })()`);
  ok(顺序.项目 && 顺序.画布,
     "★两个切换口都是先把欠的写完再切★ 顺序反过来的话，上面那套就量不到真的了", 顺序);


  console.log("\n— 八、删掉的画布不借尸还魂，清空的画布不自己长东西 —");
  const revive = await run(`
    (async () => {
      localStorage.clear();
      window.__store.jia = { main: { version: 1, nodes: [], edges: [], updatedAt: 1000 } };
      window.__active = "jia";
      await window.__switchProject("jia");
      window.confirm = () => true;                  // 删画布那句是原生确认框，离屏点不动
      canvasAskNewBoardName = async () => "分镜";    // 新建时那个起名框同理
      await canvasCreateBoard();
      canvasApplySnapshot({ version: 1, updatedAt: Date.now(), edges: [], nodes: [
        { id: "k1", kind: "note", payload: { title: "删掉那张上的卡" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } }] });
      await new Promise((r) => setTimeout(r, 700));
      await canvasDeleteBoard();                    // 删掉，回到 main
      await new Promise((r) => setTimeout(r, 500));
      window.__puts = [];
      await canvasCreateBoard();                    // 再建一张同名的
      await new Promise((r) => setTimeout(r, 900));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return {
        现在这张: canvasState.canvasName,
        屏幕: canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title),
        盘上: ((window.__store.jia["分镜"] || {}).nodes || []).map((n) => (n.payload || {}).title),
        写出去的: window.__puts.filter((p) => p.画布 === "分镜").map((p) => p.标题.join("、")),
      };
    })()`);
  ok(revive.现在这张 === "分镜" && !revive.屏幕.includes("删掉那张上的卡"),
     "★删掉一张画布，再建一张同名的，上面不是删掉那张的东西★ 本机那份副本是按画布名存的，"
     + "删画布只删了服务器上那份，本机这份留着——新建的同名画布是空的，于是它原样铺了上来",
     revive);
  ok(!revive.盘上.includes("删掉那张上的卡") && !revive.写出去的.some((t) => t.includes("删掉那张上的卡")),
     "★也没有被写回服务器★ 铺上去之后还会存一次盘，用户明明删掉的东西就这么回到了盘上",
     { 盘上: revive.盘上, 写出去的: revive.写出去的 });
  ok(revive.屏幕.includes("一句话概念"),
     "★反向对照：新建的画布照样给起手那两张卡★ 把本机那份副本整个不认也能让上面两条变绿，"
     + "但那样断网时改的东西就全靠不住了，起手卡没了更是一眼看得出来",
     revive.屏幕);

  const 旁路 = await run(`
    (async () => {
      // 本机还留着一份同名画布的副本（上个版本留下的，或者别的设备删了又建），这边新建一张同名的
      localStorage.setItem(canvasStorageKey("外来"), JSON.stringify({ version: 3, edges: [], nodes: [
        { id: "s1", kind: "note", payload: { title: "本机留着的旧东西" }, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } }] }));
      canvasAskNewBoardName = async () => "外来";
      await canvasCreateBoard();
      await new Promise((r) => setTimeout(r, 700));
      const 新建的屏幕 = canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title);

      // 再来一遍，这回是「我删掉、别人又建了一张同名的」：我从下拉里切回去，不走新建那条路
      canvasAddNode("note", { title: "删之前摆的" }, { x: 900, y: 300 });
      await new Promise((r) => setTimeout(r, 600));
      window.confirm = () => true;
      await canvasDeleteBoard();
      await new Promise((r) => setTimeout(r, 500));
      window.__store.jia["外来"] = { version: 1, nodes: [], edges: [], updatedAt: 0 };   // 别人新建的，还没人动过
      canvasState.canvasName = "外来";
      localStorage.setItem("openworkbuddy.canvas.name", "外来");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 700));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return { 新建的屏幕, 切回去的屏幕: canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title) };
    })()`);
  ok(!旁路.新建的屏幕.includes("本机留着的旧东西"),
     "★新建的画布不认本机留下的同名副本★ 副本是按画布名存的，上个版本或别的设备留下的那份还在，"
     + "新建一张同名的就原样铺了上来",
     旁路.新建的屏幕);
  ok(!旁路.切回去的屏幕.includes("删之前摆的"),
     "★删掉之后别人又建了一张同名的，切回去看到的不是我删掉的那些★ 这条走的不是「新建」那条路，"
     + "只有删画布那一下把本机副本一起删掉才拦得住",
     旁路.切回去的屏幕);

  const emptied = await run(`
    (async () => {
      // 回到 main。光改 canvasState 不够：画布列表那一步会照着本机记的「上次开的是哪张」把它改回去
      canvasState.canvasName = "main";
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      canvasApplySnapshot({ version: 1, updatedAt: Date.now(), edges: [], nodes: [
        { id: "e1", kind: "note", payload: { title: "本来有的一张卡" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } }] });
      await new Promise((r) => setTimeout(r, 700));
      canvasApplySnapshot({ version: 1, updatedAt: Date.now(), edges: [], nodes: [] });   // 用户自己全删了
      canvasPersist();
      await new Promise((r) => setTimeout(r, 700));
      const 清空后盘上 = (window.__store.jia.main.nodes || []).length;
      await renderCanvasPage();                     // 再打开这一页
      await new Promise((r) => setTimeout(r, 600));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return { 清空后盘上,
               重开后屏幕: canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title),
               重开后盘上: (window.__store.jia.main.nodes || []).map((n) => (n.payload || {}).title) };
    })()`);
  ok(emptied.清空后盘上 === 0,
     "★先确认：清空这一下真的写到服务器了★ 没写上去的话，下面那条是白说的", emptied.清空后盘上);
  ok(emptied.重开后屏幕.length === 0,
     "★自己清空的画布，再打开还是空的★ 起手那两张卡（一句话概念 + 分镜表）本来只该给「从来没人动过」的画布，"
     + "判据却是「现在是空的」——于是每打开一次就长回来两张，跟没删一样",
     emptied.重开后屏幕);
  ok(emptied.重开后盘上.length === 0,
     "★也没有被写回服务器★ 长出来那两张还会存一次盘，换台机器打开，看见的也是这两张",
     emptied.重开后盘上);

  const 别处 = await run(`
    (async () => {
      // 换台机器打开这张清空过的画布：本机没有副本，只有服务器那份——是空的，但早就不是「没人动过」了
      localStorage.removeItem(canvasStorageKey("main"));
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 700));
      const 屏幕 = canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title);

      // 再来一遍，这回是断网：服务器那份拿不到，本机这份是空的（人自己清的）
      window.__offline = true;
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 700));
      window.__offline = false;
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return { 屏幕, 断网屏幕: canvasState.graph.getElements().map((n) => (n.get("canvasPayload") || {}).title) };
    })()`);
  ok(别处.屏幕.length === 0,
     "★换台机器打开，清空过的画布还是空的★ 这台机器上没有副本，只能看服务器那份的 updatedAt——"
     + "只认本机副本的话，同一张画布在别人电脑上又长出那两张卡",
     别处.屏幕);
  ok(别处.断网屏幕.length === 0,
     "★断网打开也不长★ 服务器那份拿不到，只剩本机这份空副本；把它当成「新画布」就又铺起手卡，"
     + "网一通还会顶到服务器上去",
     别处.断网屏幕);

  console.log("\n— 九、用户删掉的连线不许自己回来 —");
  const 连线 = await run(`
    (async () => {
      localStorage.clear();
      window.__store.jia = { main: { version: 1, nodes: [], edges: [], updatedAt: 1000 } };
      window.__active = "jia"; canvasState.canvasName = "main";
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }

      // 一个镜头 + 一个起过名的场景 + 一条线，就是画布上最常见的那一小撮
      canvasApplySnapshot({ version: 1, updatedAt: Date.now(), nodes: [
        { id: "shot1", kind: "shot", payload: { id: "S1-01", title: "开场" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } },
        { id: "loc1", kind: "location", payload: { name: "江边码头" }, position: { x: 420, y: 40 }, size: { width: 300, height: 200 } }],
        edges: [{ source: { id: "loc1" }, target: { id: "shot1" }, relation: "location" }] });
      await new Promise((r) => setTimeout(r, 700));

      canvasState.graph.getLinks().forEach((l) => l.remove());   // 人把这条线删了
      await new Promise((r) => setTimeout(r, 700));
      const 删完盘上 = ((window.__store.jia.main || {}).edges || []).length;

      // ① 来一趟同步：服务器那份没有线（就是刚存上去那份），别的机器动了节点位置
      const 服务器那份 = JSON.parse(JSON.stringify(window.__store.jia.main));
      服务器那份.updatedAt = Date.now() + 1000;
      服务器那份.nodes[0].position = { x: 60, y: 60 };
      canvasApplySnapshot(服务器那份, { fromRemote: true });
      const 同步后屏幕 = canvasState.graph.getLinks().length;

      // ② 关掉再打开
      await new Promise((r) => setTimeout(r, 700));
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 700));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return { 删完盘上, 同步后屏幕, 重开后屏幕: canvasState.graph.getLinks().length,
               重开后盘上: ((window.__store.jia.main || {}).edges || []).length };
    })()`);
  ok(连线.删完盘上 === 0,
     "★先确认：删掉那条线真的写到服务器了★ 没写上去的话，下面两条是白说的", 连线.删完盘上);
  ok(连线.同步后屏幕 === 0,
     "★同步不许把删掉的连线送回来★ 铺快照那一步「对面没有连线就沿用我这边的」——本来是为了别被空数据抹掉，"
     + "可对面没有连线正是因为人刚把它删了",
     连线.同步后屏幕);
  ok(连线.重开后屏幕 === 0 && 连线.重开后盘上 === 0,
     "★重开也不许把删掉的连线推回来★ 老画布文件里没有连线那一段，程序会照「一个镜头 + 一个起过名的场景」"
     + "替它补上——可「没有连线」也可能是人自己删的，补回来就是删不掉",
     { 屏幕: 连线.重开后屏幕, 盘上: 连线.重开后盘上 });

  const 撤销 = await run(`
    (async () => {
      localStorage.clear();
      window.__store.jia = { main: { version: 2, nodes: [], edges: [], updatedAt: 1000 } };
      window.__active = "jia"; canvasState.canvasName = "main";
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      canvasApplySnapshot({ version: 2, updatedAt: Date.now(), edges: [], nodes: [
        { id: "jia1", kind: "note", payload: { text: "甲" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "yi1", kind: "note", payload: { text: "乙" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }] });
      canvasHistoryReset(canvasSnapshot());
      canvasConnect(canvasState.graph.getCell("jia1"), canvasState.graph.getCell("yi1"), "");
      canvasHistoryFlush();
      const 连上 = canvasState.graph.getLinks().length;
      canvasUndo();
      return { 连上, 撤销后: canvasState.graph.getLinks().length };
    })()`);
  ok(撤销.连上 === 1 && 撤销.撤销后 === 0,
     "★刚连的线，一按撤销就该没★ 撤销就是把上一版画布铺回去，上一版本来没有这条线",
     撤销);

  const 老画布 = await run(`
    (async () => {
      // 先把上一段欠着的那笔存盘写完：存盘是防抖的（240ms），不等就往 __store 里摆新画布的话，
      // 那笔迟到的写入会把刚摆好的盖掉，测出来的是上一段的画布
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 200));
      localStorage.clear();
      window.__store.jia = { main: { version: 1, updatedAt: 5000, edges: [], nodes: [
        { id: "s9", kind: "shot", payload: { id: "S1-01", title: "开场" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } },
        { id: "l9", kind: "location", payload: { name: "江边码头" }, position: { x: 420, y: 40 }, size: { width: 300, height: 200 } }] } };
      window.__active = "jia"; canvasState.canvasName = "main";
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 900));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      const 补上了 = canvasState.graph.getLinks().length, 盘上版本 = (window.__store.jia.main || {}).version;
      // 老画布来一趟同步：那份还是版本 1、没有连线，不能把刚补上的线冲掉
      canvasApplySnapshot({ version: 1, updatedAt: Date.now() + 5000, edges: [], nodes: [
        { id: "s9", kind: "shot", payload: { id: "S1-01", title: "开场" }, position: { x: 60, y: 60 }, size: { width: 300, height: 200 } },
        { id: "l9", kind: "location", payload: { name: "江边码头" }, position: { x: 420, y: 40 }, size: { width: 300, height: 200 } }] }, { fromRemote: true });
      const 同步后 = canvasState.graph.getLinks().length;
      // 老画布上这条线是程序替他补的，他把它删掉——删完这一下就会照版本 2 存回去，
      // 于是「空着」从此是照实记的，下回打开不该再补
      canvasState.graph.getLinks().forEach((l) => l.remove());
      await new Promise((r) => setTimeout(r, 700));
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 700));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      return { 补上了, 同步后, 重开后: canvasState.graph.getLinks().length, 盘上版本: (window.__store.jia.main || {}).version };
    })()`);
  ok(老画布.补上了 === 1 && 老画布.同步后 === 1,
     "★反向对照：真的老画布（版本 1）还是照旧替它把线补上★ 上面三条要是靠「干脆不补了」蒙混过关，这条就得挂",
     老画布);
  ok(老画布.重开后 === 0 && 老画布.盘上版本 === 2,
     "★老画布上那条线，他删掉之后也不许再补回来★ 删这一下就把画布存成了版本 2，从此「没有连线」是照实记的",
     { 重开后: 老画布.重开后, 盘上版本: 老画布.盘上版本 });

  const 猜不出来 = await run(`
    (async () => {
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 200));
      const 两张笔记 = [
        { id: "p1", kind: "note", payload: { title: "甲" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "p2", kind: "note", payload: { title: "乙" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }];
      canvasApplySnapshot({ version: 2, updatedAt: Date.now(), nodes: 两张笔记,
        edges: [{ source: { id: "p1" }, target: { id: "p2" } }] });
      const 连着 = canvasState.graph.getLinks().length;
      // 老画布（版本 1）那份没有连线这一段，而这两张笔记之间的线是猜不出来的——
      // 只能沿用屏幕上这份，不然一升级、一同步，人连好的线就全没了
      canvasApplySnapshot({ version: 1, updatedAt: Date.now() + 3000, nodes: 两张笔记, edges: [] }, { fromRemote: true });
      return { 连着, 同步后: canvasState.graph.getLinks().length };
    })()`);
  ok(猜不出来.连着 === 1 && 猜不出来.同步后 === 1,
     "★反向对照：老画布那份没有连线，屏幕上这条线不许被抹★ 版本 1 的文件可能压根没存过连线，"
     + "而两张笔记之间的线也不是程序猜得出来的——一律当成「对面记全了」的话，升级那一下线就全没了",
     猜不出来);

  srv.close();
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  app.exit(fail ? 1 : 0);
});
