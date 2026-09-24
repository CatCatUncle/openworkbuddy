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
      // 乐观并发（server.js PUT /api/canvas 的口径）：带了 baseUpdatedAt、盘上已经不是那一版就回 409 + 盘上那份。
      // 只在 __cas 打开时这么判——前面几节是直接改 __store 来冒充「别处写过」的，那几节量的不是这件事
      const disk = mine[b.name] || { version: 1, nodes: [], edges: [], updatedAt: 0 };
      const clash = !!window.__cas && b.baseUpdatedAt !== undefined && Number(b.baseUpdatedAt) !== Number(disk.updatedAt || 0);
      (window.__putBodies = window.__putBodies || []).push({ name: b.name, baseUpdatedAt: b.baseUpdatedAt, status: clash ? 409 : 200,
        标题: (b.state.nodes || []).map((n) => (n.payload || {}).title) });
      if (clash) return Promise.resolve({ ok: false, status: 409, json: async () => ({ ok: false, conflict: true, name: b.name, state: disk, error: "画布已被别处改过" }) });
      window.__puts.push({ 项目: window.__active, 画布: b.name, 标题: (b.state.nodes || []).map((n) => (n.payload || {}).title) });
      mine[b.name] = { ...b.state, updatedAt: Date.now() };
      return J({ ok: true, updatedAt: mine[b.name].updatedAt, state: mine[b.name] });
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

// 第三层，套在 STUB2 外面：生成、合成、分镜表这几条接口。发出去的请求体一条条记下来（__bodies / __runs），
// 断言看的是「真发出去了什么」，不是函数被叫了几次。
//   __failRun(提示词第一行) 返回 true 的那几条回 500；__holdRun 是个 promise，挂着它就等于「生成还在跑」。
// 一律假的：这套测试不许真花一分钱
const STUB3 = `
(() => {
  window.__bodies = []; window.__runs = []; window.__failRun = null; window.__holdRun = null;
  window.__progress = null; window.__board = null;
  window.__deletes = []; window.__assets = null; window.__shotHistory = null; window.__echoName = false;
  // 生成成功后会顺手打开右侧预览，那条路要真文件，这儿用不着
  window.previewFile = async () => {};
  const J = (d, status) => Promise.resolve({ ok: !status || status < 400, status: status || 200, json: async () => d });
  const inner = window.fetch;
  window.fetch = async function (u, o) {
    const s = String(u), m = ((o && o.method) || "GET").toUpperCase();
    let body = null;
    try { body = o && typeof o.body === "string" ? JSON.parse(o.body) : null; } catch {}
    // 删文件、覆盖文件的请求一律记一笔：「用这一版」那条断言要的就是这里一条都没有
    if (m === "DELETE" || s.includes("/api/drama/shot-history/restore")) window.__deletes.push({ url: s, method: m, body });
    if (s.includes("/api/tool/run")) {
      const first = String((body && body.input && (body.input.prompt || body.input.text)) || "").split("\\n")[0];
      window.__runs.push(first);
      window.__bodies.push({ url: "/api/tool/run", body });
      // 在途几条、最多同时几条：并发上限那条断言看的就是 __peak
      window.__inflight = (window.__inflight || 0) + 1;
      window.__peak = Math.max(window.__peak || 0, window.__inflight);
      try {
        if (window.__holdRun) await window.__holdRun;
        if (window.__runDelay) await new Promise((r) => setTimeout(r, window.__runDelay));
        const 失败 = window.__failRun && window.__failRun(first, body);
        // 返回对象 = 按它给的原样回（比如 200 但 isError、带 submitted 的那种工具失败）
        if (失败 && typeof 失败 === "object") return J(失败.body, 失败.status);
        if (失败) return J({ error: "假服务器：这一条故意失败" }, 500);
        // __echoName：照真服务端那样，按请求里的文件名落盘、path 带上子目录
        if (window.__echoName && body && body.input && body.input.filename) {
          return J({ ok: true, file: body.input.filename, path: (body.subdir ? body.subdir + "/" : "") + body.input.filename });
        }
        return J({ file: "outputs/run-" + window.__runs.length + ".png" });
      } finally {
        window.__inflight -= 1;
      }
    }
    // 预估接口（server.js /api/tool/estimate 的口径）：默认每条 ¥0.30、全都估得出；
    // __estimate(items) 可以换成别的回话，确认框里的数字要跟这儿给的对得上
    if (s.includes("/api/tool/estimate")) {
      const items = (body && Array.isArray(body.items)) ? body.items : [];
      (window.__estimates = window.__estimates || []).push(items);
      if (window.__estimate) return J(window.__estimate(items));
      const rows = items.map((it) => ({ tool: it.tool, model: "假模型", units: 1, unit: "张", unitPrice: 0.3, cost: 0.3, known: true }));
      return J({ ok: true, items: rows, total: +(rows.length * 0.3).toFixed(2), unknownCount: 0 });
    }
    if (s.includes("/api/canvas/assets") && window.__assets) return J(window.__assets);
    // 留底的四条路由（server.js /api/drama/shot-history*）。snapshot / restore 回个样子，量的是画布碰没碰它们
    if (s.includes("/api/drama/shot-history")) {
      window.__bodies.push({ url: s, method: m, body });
      if (s.includes("/shot-history/restore")) return J({ ok: true, restored: [] });
      if (s.includes("/shot-history/snapshot")) return J({ ok: true, id: "snap-new" });
      if (s.includes("/shot-history/blob")) return Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(["x"]), json: async () => ({}) });
      return J(window.__shotHistory || { ok: true, versions: [], usage: {} });
    }
    if (s.includes("/api/canvas/compose")) {
      if (m === "POST") window.__bodies.push({ url: "/api/canvas/compose", body });
      if (m === "POST" && body && body.run) return J({ job: { id: "job1", done: false, at: 1, total: 3, steps: [] } });
      if (m === "POST") return J({ plan: { ready: true, shots: [], blockers: [] } });
      // __composeDone：轮询问到的那一趟已经跑完（第三十四节量「合成完了、人不在跟前」）
      if (window.__composeDone) return J({ job: window.__composeDone });
      return J({ job: { id: "job1", done: false, at: 1, total: 3, steps: [] } });
    }
    if (s.includes("/api/canvas/progress")) return J(window.__progress || {});
    if (s.includes("/api/drama/storyboards")) return J({ storyboards: window.__board ? [{ name: "ep1", title: "第一集", shots: 2 }] : [] });
    if (s.includes("/api/drama/storyboard/output")) { window.__bodies.push({ url: "/api/drama/storyboard/output", body }); return J({ ok: true }); }
    if (s.includes("/api/drama/storyboard?")) return J(window.__board ? { data: window.__board } : { error: "没有这份分镜表" });
    return inner.apply(this, arguments);
  };
})()
`;

// 第四层，只给第二十九节：「生成分镜表」那两条（server.js /api/drama/storyboard/draft、/commit）和整份 PUT。
// draft 回一份两镜的草稿、带用量；commit 照真服务端的口径：盘上已有一份、又说 mode=new → 409 + 现有那份的摘要。
// 写进去的那份记在 __committed，之后 GET /api/drama/storyboard?name= 回的就是它（放到画布上、改风格都要读）。
// 全是假的：对话模型一次都不真调
const STUB4 = `
(() => {
  window.__drafts = []; window.__commits = []; window.__storyPuts = []; window.__commit409 = false; window.__committed = null;
  const J = (d, status) => Promise.resolve({ ok: !status || status < 400, status: status || 200, json: async () => d });
  const DRAFT = {
    title: "外卖小哥", aspect: "9:16", style: "冷蓝夜色，胶片颗粒",
    characters: [{ id: "A", name: "阿岚", look: "二十出头的外卖员，黄色头盔，眉角一道疤" }],
    scenes: [{ id: "S1", place: "老小区电梯", time: "深夜", shots: [
      { id: "S1-01", shot_size: "近景", frame_prompt: "阿岚抱着外卖箱挤进电梯，灯管闪烁", motion_prompt: "镜头缓缓推近", line: "师傅，几楼？", duration: 5, cast: ["A"] },
      { id: "S1-02", shot_size: "特写", frame_prompt: "电梯楼层数字停在 13", motion_prompt: "数字闪一下", duration: 3, cast: [] },
    ] }],
  };
  const inner = window.fetch;
  window.fetch = async function (u, o) {
    const s = String(u), m = ((o && o.method) || "GET").toUpperCase(), path = s.split("?")[0];
    let body = null;
    try { body = o && typeof o.body === "string" ? JSON.parse(o.body) : null; } catch {}
    if (path.endsWith("/api/drama/storyboard/draft")) {
      window.__drafts.push(body);
      return J({ draft: JSON.parse(JSON.stringify(DRAFT)), warnings: [], usage: { prompt: 100, completion: 200 } });
    }
    if (path.endsWith("/api/drama/storyboard/commit")) {
      window.__commits.push(body);
      if (window.__commit409 && body && body.mode === "new") {
        return J({ exists: true, name: "短剧/main/分镜表.json", updatedAt: 123, summary: { scenes: 1, shots: 3 }, error: "这张画布已经有分镜表了" }, 409);
      }
      const name = (body && body.name) || "短剧/main/分镜表.json";
      window.__committed = { name, data: JSON.parse(JSON.stringify((body && body.draft) || {})) };
      return J({ ok: true, name, mode: body && body.mode, created: true, data: window.__committed.data, summary: {}, updatedAt: 456, warnings: [] });
    }
    if (path.endsWith("/api/drama/storyboard") && m === "PUT") {
      window.__storyPuts.push(body);
      if (window.__committed && body && body.data) window.__committed.data = JSON.parse(JSON.stringify(body.data));
      return J({ ok: true });
    }
    if (path.endsWith("/api/drama/storyboard") && window.__committed) return J({ name: window.__committed.name, data: window.__committed.data, summary: {} });
    if (path.endsWith("/api/drama/storyboards") && window.__committed) return J({ storyboards: [{ name: window.__committed.name, title: "外卖小哥", shots: 2 }] });
    return inner.apply(this, arguments);
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
  // 第八节起 askConfirm 被换成「一律点确定」；批量扣费前那个确认框要用真的量，先把真的存一份
  await run("window.__realAskConfirm = window.askConfirm; true");

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
  // 「新建短剧」那张表单：第八节把 canvasAskNewBoardName 换成了只回名字的桩，第二十九节要量真表单，
  // 趁画布脚本刚加载完先存一份真的
  await run("window.__realAskNewBoardName = canvasAskNewBoardName; true");

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
      window.askConfirm = async () => true;         // 删画布那句是自绘确认框，离屏没人点，得替它点
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
      window.askConfirm = async () => true;
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

  console.log("\n— 十、正在打字的时候来一趟同步 —");
  const 打字 = await run(`
    (async () => {
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 200));
      localStorage.clear();
      window.__store.jia = { main: { version: 2, updatedAt: 1000, edges: [], nodes: [
        { id: "t1", kind: "note", payload: { title: "我的笔记", text: "原来的内容" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "t2", kind: "note", payload: { title: "对方那张", text: "" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }] } };
      window.__active = "jia"; canvasState.canvasName = "main";
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }

      // 点开一个节点，光标落在属性面板的输入框里，正打到一半
      canvasState.inspectorOpen = true; canvasState.selected = "t1"; canvasState.selectedIds = new Set(["t1"]);
      canvasRenderInspector(false);
      const box = document.getElementById("canvas-inspector");
      const 输入框 = box.querySelector('[data-inspect-key="text"]');
      if (!输入框) return { 错: "属性面板里没有输入框" };
      输入框.focus();
      输入框.value = "原来的内容，正在往后接着写";
      输入框.setSelectionRange(11, 11);
      输入框.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));   // 让这一笔先存出去，免得下面摆的「对方改的」被它盖掉

      // 这会儿别处（另一台机器、或者本项目的 Agent）动了另一张卡
      window.__store.jia.main = { version: 2, updatedAt: Date.now() + 5000, edges: [], nodes: [
        { id: "t1", kind: "note", payload: { title: "我的笔记", text: "原来的内容" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "t2", kind: "note", payload: { title: "对方改过的标题", text: "" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }] };
      canvasStartRemoteSync();
      await new Promise((r) => setTimeout(r, 4200));   // 两圈
      const 现在的 = document.activeElement;
      const 打字时 = { 焦点还在: !!(现在的 && 现在的.dataset && 现在的.dataset.inspectKey === "text"),
                       屏幕上的字: 现在的 && 现在的.value, 光标: 现在的 && 现在的.selectionStart,
                       节点里的字: (canvasState.graph.getCell("t1").get("canvasPayload") || {}).text };
      // 打完了，光标挪开——这时候对方的改动该补上来
      输入框.blur();
      const 到点 = Date.now() + 12000;
      const 对方的到了 = () => (canvasState.graph.getCell("t2")?.get("canvasPayload") || {}).title === "对方改过的标题";
      while (Date.now() < 到点 && !对方的到了()) await new Promise((r) => setTimeout(r, 150));
      clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null;
      return { ...打字时, 停手后对方的到了: 对方的到了() };
    })()`);
  ok(打字.焦点还在 === true,
     "★正在输入框里打字，来一趟同步不许把光标弄没★ 属性面板是整块重画的，重画一次输入框就是新的一个，"
     + "光标掉回 body，接着敲的字进了空气",
     打字);
  ok(打字.屏幕上的字 === "原来的内容，正在往后接着写" && 打字.光标 === 11,
     "★他打进去的字和光标位置都得原样留着★ 同步拉回来的那份里还是「原来的内容」——照铺上去等于把他刚打的一段抹了",
     { 字: 打字.屏幕上的字, 光标: 打字.光标 });
  ok(打字.停手后对方的到了 === true,
     "★反向对照：手停下来之后，对方那边的改动照样同步得过来★ 把同步整个关掉也能让上面两条变绿",
     打字.停手后对方的到了);


  // 同步之外，面板自己也会重画（改个标签、跑一下节点都会），那条路上光标同样不能丢
  const 重画 = await run(`
    (async () => {
      canvasState.inspectorOpen = true; canvasState.selected = "t1"; canvasState.selectedIds = new Set(["t1"]);
      canvasRenderInspector(false);
      const box = document.getElementById("canvas-inspector");
      const 框 = box.querySelector('[data-inspect-key="text"]');
      框.focus(); 框.setSelectionRange(5, 5);
      canvasRenderInspector(false);            // 面板整块重画
      const 后来 = document.activeElement;
      return { 还在这个框: !!(后来 && 后来.dataset && 后来.dataset.inspectKey === "text"), 光标: 后来 && 后来.selectionStart };
    })()`);
  ok(重画.还在这个框 === true && 重画.光标 === 5,
     "★面板自己重画一次，光标停在第几个字也得留住★ innerHTML 一换，原来那个输入框就是个被扔掉的节点了",
     重画);

  // 反向对照之二：把光标留在框里走开，同步不能就此停摆（不然这个标签页从此再也拉不到别人的改动）
  const 走开 = await run(`
    (async () => {
      const 框 = document.getElementById("canvas-inspector").querySelector('[data-inspect-key="text"]');
      框.focus();
      canvasState.handsOnAt = Date.now() - 20000;   // 手离开键盘 20 秒了，只是焦点还搁在这儿
      window.__store.jia.main = { version: 2, updatedAt: Date.now() + 9000, edges: [], nodes: [
        { id: "t1", kind: "note", payload: { title: "我的笔记", text: "原来的内容" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "t2", kind: "note", payload: { title: "走开之后对方又改了", text: "" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }] };
      canvasStartRemoteSync();
      const 到点 = Date.now() + 12000;
      const 到了 = () => (canvasState.graph.getCell("t2")?.get("canvasPayload") || {}).title === "走开之后对方又改了";
      while (Date.now() < 到点 && !到了()) await new Promise((r) => setTimeout(r, 150));
      clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null;
      return 到了();
    })()`);
  ok(走开 === true,
     "★反向对照：光标留在框里走开了，同步照样得继续★ 「正在打字」得有个时效，不然让一让就成了永远不让",
     走开);


  console.log("\n— 十一、拖到一半来一趟同步 —");
  const 拖 = await run(`
    (async () => {
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 200));
      localStorage.clear();
      window.__store.jia = { main: { version: 2, updatedAt: 1000, edges: [], nodes: [
        { id: "d1", kind: "note", payload: { title: "我在拖这张" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "d2", kind: "note", payload: { title: "对方那张" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }] } };
      window.__active = "jia"; canvasState.canvasName = "main";
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }

      // 按住一张卡开始拖（JointJS 拖动时就是这么改模型的：按下去、位置一路跟着走）
      const 卡 = canvasState.graph.getCell("d1");
      const view = canvasState.paper.findViewByModel(卡);
      view.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
      const 按下去了 = !!canvasState.nodeGesture;
      卡.position(360, 260);
      // 拖动会触发存盘（攒 240 毫秒再发），先让它发完：不然下面摆的「对方那份」
      // 转脸就被这笔盖掉，这一段量的就成了空气
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 250));

      // 手还按着，别处来了一趟改动
      window.__store.jia.main = { version: 2, updatedAt: Date.now() + 5000, edges: [], nodes: [
        { id: "d1", kind: "note", payload: { title: "我在拖这张" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "d2", kind: "note", payload: { title: "对方改过的标题" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }] };
      canvasStartRemoteSync();
      await new Promise((r) => setTimeout(r, 4200));
      const p = canvasState.graph.getCell("d1").position();
      const 拖着时 = { 按下去了, 手势还在: !!canvasState.nodeGesture, 位置: p.x + "," + p.y };

      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      拖着时.松手后手势清了 = !canvasState.nodeGesture;
      const 到点 = Date.now() + 12000;
      const 到了 = () => (canvasState.graph.getCell("d2")?.get("canvasPayload") || {}).title === "对方改过的标题";
      while (Date.now() < 到点 && !到了()) await new Promise((r) => setTimeout(r, 150));
      clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null;
      return { ...拖着时, 松手后对方的到了: 到了() };
    })()`);
  ok(拖.按下去了 === true, "先验料：按下去那一下真被画布接住了（不然下面量的是个空手势）", 拖);
  ok(拖.位置 === "360,260",
     "★手还按在卡上，同步来一趟不许把卡拽回原处★ 铺快照是 graph.clear() 重来一遍，正在拖的那张当场被拆掉",
     拖);
  ok(拖.松手后对方的到了 === true,
     "★反向对照：松手之后，对方那边的改动照样同步得过来★", 拖.松手后对方的到了);
  ok(拖.松手后手势清了 === true, "松手那一下真被接住了（手势清了，所以上面那条绿不是靠手动清出来的）", 拖);

  // 反向对照之二：松手没被接住（拖出窗外撒的手），同步不能就此停摆
  const 卡住 = await run(`
    (async () => {
      canvasState.nodeGesture = { id: "d1", x: 0, y: 0, moved: true };
      canvasState.handsOnAt = Date.now() - 20000;   // 手早离开了，只是那次松手没人接
      window.__store.jia.main = { version: 2, updatedAt: Date.now() + 9000, edges: [], nodes: [
        { id: "d1", kind: "note", payload: { title: "我在拖这张" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "d2", kind: "note", payload: { title: "撒手之后对方又改了" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }] };
      canvasStartRemoteSync();
      const 到点 = Date.now() + 12000;
      const 到了 = () => (canvasState.graph.getCell("d2")?.get("canvasPayload") || {}).title === "撒手之后对方又改了";
      while (Date.now() < 到点 && !到了()) await new Promise((r) => setTimeout(r, 150));
      clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null;
      canvasState.nodeGesture = null;
      return 到了();
    })()`);
  ok(卡住 === true,
     "★反向对照：拖出窗外撒了手、那一下没被接住，同步照样得继续★ 「手上有活」得有时效，不然让一让就成了永远不让",
     卡住);

  // 有人拖一张卡能磨蹭半分钟（对位置、对齐别的卡）。时效是从「最后一下动作」算的，
  // 不是从按下去那一刻算的，不然拖过 10 秒就被拽回原处
  const 慢拖 = await run(`
    (async () => {
      await canvasFlushRemoteWrite();
      const 卡 = canvasState.graph.getCell("d1");
      const view = canvasState.paper.findViewByModel(卡);
      view.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
      canvasState.handsOnAt = Date.now() - 20000;          // 按下去是 20 秒前的事了
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 240, clientY: 300, button: 0 }));
      卡.position(520, 380);                                 // 还在拖，刚挪到这儿
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 250));
      window.__store.jia.main = { version: 2, updatedAt: Date.now() + 9000, edges: [], nodes: [
        { id: "d1", kind: "note", payload: { title: "我在拖这张" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "d2", kind: "note", payload: { title: "慢拖时对方改的" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } }] };
      canvasStartRemoteSync();
      await new Promise((r) => setTimeout(r, 4200));
      const p = canvasState.graph.getCell("d1").position();
      clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null;
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      canvasState.nodeGesture = null;
      return p.x + "," + p.y;
    })()`);
  ok(慢拖 === "520,380",
     "★一张卡拖了半分钟还在拖，同样不许拽回原处★ 时效从最后一下动作算起，不是从按下去那一刻",
     慢拖);


  // ———— 下面六节是「画布前端必现 bug」那一轮：每一条都是界面照常、钱或数据在漏 ————
  await run(STUB3);
  // 每节开头都摆一张干净画布：先把上一节欠着的写完（不然那笔迟到的写会盖掉刚摆好的），再重开画布页
  const 摆画布 = (nodes, edges) => `
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 250));
      localStorage.clear();
      window.__store.jia = { main: { version: 2, updatedAt: 1000, edges: ${JSON.stringify(edges || [])}, nodes: ${JSON.stringify(nodes)} } };
      window.__active = "jia"; canvasState.canvasName = "main"; canvasState.handsOnAt = 0; canvasState.nodeGesture = null;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      localStorage.setItem("openworkbuddy.canvas.name", "main");
      await renderCanvasPage();
      await new Promise((r) => setTimeout(r, 400));
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }`;
  const 镜头 = (id, prompt, y) => ({ id, kind: "shot", payload: { id, title: id, prompt }, position: { x: 40, y }, size: { width: 300, height: 220 } });

  console.log("\n— 十二、合成成片：真跑那一枪要带上「垫上配乐」 —");
  const 合成 = await run(`
    (async () => {
      await canvasFlushRemoteWrite();
      const out = {};
      for (const bgm of [true, false]) {
        window.__bodies = [];
        canvasState.composeBgm = bgm; canvasState.composeSub = false;
        canvasState.composePlan = { ready: true, shots: [], blockers: [] };
        await canvasComposeStart();
        clearTimeout(canvasState.composeTimer); canvasState.composeJob = null;
        const sent = window.__bodies.filter((b) => b.url === "/api/canvas/compose" && b.body && b.body.run).pop();
        out[bgm ? "勾上" : "没勾"] = sent ? sent.body : null;
      }
      canvasState.composeBgm = true; canvasState.composeSub = true; canvasRenderProgress();
      return out;
    })()`);
  ok(合成.勾上 && 合成.勾上.run === true && 合成.勾上.music === true,
     "★预览里勾了「垫上配乐」，真跑那一枪的请求体里 music 也得是 true★ 漏了它服务端按不垫配乐拼，"
     + "预览里勾着、成片却是干的，没有一条报错",
     合成.勾上);
  ok(合成.没勾 && 合成.没勾.run === true && 合成.没勾.music === false,
     "反向对照：没勾的时候 music 是 false——不是写死了一个 true", 合成.没勾);

  console.log("\n— 十三、一键补齐：没成的要算没成，而且能只重跑那几条 —");
  const 补齐 = await run(`
    (async () => {
      ${摆画布([镜头("k1", "甲镜头", 40), 镜头("k2", "乙镜头", 300), 镜头("k3", "丙镜头", 560), 镜头("k4", "丁镜头", 820)])}
      // 进度接口说这四镜都还没有首帧
      window.__progress = { stages: [], shots: ["k1", "k2", "k3", "k4"].map((nodeId) => ({ nodeId, frame: null, video: null, audio: null })) };
      await canvasLoadProgress();
      window.__runs = []; window.__failRun = (p) => p.startsWith("乙") || p.startsWith("丁");
      window.__bodies = [];
      await canvasRunPending("image");
      const 第一趟 = [...window.__runs];
      // 失败那两条自动补的那一枪：型号得跟第一枪一样（没排备用顺序就不许换）
      const 型号 = window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => [String(b.body.input.prompt || "").split("\\n")[0], b.body.input.model || ""]);
      const box = document.getElementById("owb-toast"), btn = box && box.querySelector(".owb-toast-act");
      const 提示 = box ? (box.querySelector("span") || {}).textContent : "";
      const 按钮 = btn ? btn.textContent : null, 点得到 = btn ? getComputedStyle(box).pointerEvents : null;
      window.__runs = []; window.__failRun = null;
      if (btn) btn.click();
      const 到点 = Date.now() + 8000;
      await new Promise((r) => setTimeout(r, 50));
      while (Date.now() < 到点 && canvasState.batch) await new Promise((r) => setTimeout(r, 100));
      const 重跑 = [...window.__runs].sort();
      const 首帧 = ["k1", "k2", "k3", "k4"].map((id) => !!(canvasState.graph.getCell(id)?.get("canvasPayload") || {}).first_frame);
      const 后来 = document.getElementById("owb-toast");
      window.__progress = null;
      return { 第一趟, 型号, 提示, 按钮, 点得到, 重跑, 首帧,
               重跑后提示: 后来 ? (后来.querySelector("span") || {}).textContent : "", 重跑后还有按钮: !!(后来 && 后来.querySelector(".owb-toast-act")) };
    })()`);
  const 数 = (arr, w) => arr.filter((x) => x === w).length;
  ok(new Set(补齐.第一趟).size === 4, "先验料：四镜都真发出去了（不然下面数的是空气）", 补齐.第一趟);
  ok(数(补齐.第一趟, "甲镜头") === 1 && 数(补齐.第一趟, "丙镜头") === 1 && 数(补齐.第一趟, "乙镜头") === 2 && 数(补齐.第一趟, "丁镜头") === 2,
     "★没成的那两条各自动补了一枪、只补一枪；成了的不补★ 补多了是替人多花钱", 补齐.第一趟);
  const 补枪型号 = ["乙镜头", "丁镜头"].map((w) => [...new Set(补齐.型号.filter((x) => x[0] === w).map((x) => x[1]))]);
  ok(补枪型号.every((ms) => ms.length === 1),
     "★自动补的那一枪用的还是同一个型号★ 设置里没排备用顺序，就不许悄悄换成别的模型", 补齐.型号);
  ok(/2 个做好了/.test(补齐.提示) && /2 个没成/.test(补齐.提示),
     "★两条回了 500，结束那句得说「2 个做好了，2 个没成」★ 以前不看每一格的返回值，失败的也算做好了",
     补齐.提示);
  ok(补齐.按钮 === "重试失败的 2 条" && 补齐.点得到 === "auto",
     "★提示上挂着「重试失败的 2 条」，而且点得到★ 提示条整条是穿透鼠标的，按钮得单独把它打开",
     { 按钮: 补齐.按钮, 点得到: 补齐.点得到 });
  ok(JSON.stringify(补齐.重跑) === JSON.stringify(["丁镜头", "乙镜头"]),
     "★点了只重发没成的那两条★ 成了的两条再跑一遍是白花钱",
     补齐.重跑);
  ok(补齐.首帧.every(Boolean) && /2 个做好了/.test(补齐.重跑后提示) && !/没成/.test(补齐.重跑后提示) && !补齐.重跑后还有按钮,
     "重跑完四镜都有首帧，这回全成了就不再挂重试按钮",
     { 首帧: 补齐.首帧, 提示: 补齐.重跑后提示, 按钮: 补齐.重跑后还有按钮 });

  // 重试按钮点下去不动的两种情况：另一批还在跑、人已经换到别的画布（复制出来的画布 id 一样，按 id 会打错图）。
  // 不动可以，不说不行——点了没反应，人只会再点、再点
  const 换图 = await run(`
    (async () => {
      ${摆画布([镜头("m1", "戊镜头", 40), 镜头("m2", "己镜头", 300), 镜头("m3", "庚镜头", 560)])}
      window.__progress = { stages: [], shots: ["m1", "m2", "m3"].map((nodeId) => ({ nodeId, frame: null, video: null, audio: null })) };
      await canvasLoadProgress();
      const 字 = () => ((document.getElementById("owb-toast") || {}).querySelector?.("span") || {}).textContent || "";
      const 原处 = { board: "main", project: canvasState.workspaceName };
      // ① 另一批在跑
      window.__runs = []; canvasState.batch = { kind: "video", total: 1, at: 1, label: "", stop: false };
      await canvasRetryFailed("image", ["m1"], 原处);
      const 在跑 = { 提示: 字(), 发了: window.__runs.length };
      canvasState.batch = null;
      // ② 跑到一半换了画布：第一条回来时人已经不在了，剩下两条不许再发
      window.__runs = []; window.__failRun = null;
      let release; window.__holdRun = new Promise((r) => { release = r; });
      const 跑 = canvasRunPending("image");
      const 到点 = Date.now() + 4000;
      // 同时跑 2 条：等头两条都发出去（挂在 __holdRun 上）再换画布
      while (Date.now() < 到点 && window.__runs.length < 2) await new Promise((r) => setTimeout(r, 50));
      canvasState.canvasName = "另一张";
      release(); await 跑; window.__holdRun = null;
      const 半路 = { 发了: [...window.__runs], 提示: 字(), 有按钮: !!document.querySelector("#owb-toast .owb-toast-act") };
      // ③ 在别的画布上点那颗重试
      window.__runs = [];
      const btn = document.querySelector("#owb-toast .owb-toast-act"); if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 200));
      const 别处 = { 提示: 字(), 发了: window.__runs.length, 在跑: !!canvasState.batch };
      canvasState.canvasName = "main"; window.__progress = null;
      return { 在跑, 半路, 别处 };
    })()`);
  ok(/还有一批在跑/.test(换图.在跑.提示) && 换图.在跑.发了 === 0,
     "★另一批还在跑时点重试：不发，但要说一声★ 以前直接 return，按钮点了没反应", 换图.在跑);
  // 并发上限默认 2：换画布之前已经发出去的是前两条，第三条（庚）不许再发
  ok(换图.半路.发了.length === 2 && !换图.半路.发了.includes("庚镜头") && /换了画布/.test(换图.半路.提示) && /2 个没成/.test(换图.半路.提示),
     "★一键补齐跑到一半换了画布：剩下的不再开枪，结束那句说清楚没跑完★ 以前拿旧对象接着跑，钱花了图上看不见",
     换图.半路);
  ok(换图.半路.有按钮 && /另一张画布/.test(换图.别处.提示) && 换图.别处.发了 === 0 && !换图.别处.在跑,
     "★在别的画布上点「重试失败的」：不发，提示切回去★ 复制出来的画布节点 id 一样，按 id 取会打到这张图上",
     换图.别处);

  console.log("\n— 十四、生成途中节点被删、画布被重铺 —");
  const 途中 = await run(`
    (async () => {
      ${摆画布([镜头("g1", "要删的这一镜", 40), 镜头("g2", "被重铺的这一镜", 320)])}
      const 镜头g3 = ${JSON.stringify(镜头("g3", "远端新加的这一镜", 600))};
      window.__runs = []; window.__failRun = null;
      // ① 发出去之后、回来之前，人把这张卡删了
      let release; window.__holdRun = new Promise((r) => { release = r; });
      const 跑 = canvasGenerate(canvasState.graph.getCell("g1"), "image");
      await new Promise((r) => setTimeout(r, 60));
      const 发出去了 = window.__runs.length === 1, 登记在途 = canvasState.inflight.has("g1");
      canvasState.graph.getCell("g1").remove(); canvasPersist();
      const 删完个数 = canvasState.graph.getElements().length;
      release(); const 结果 = await 跑; window.__holdRun = null;
      const 提示 = (document.querySelector("#owb-toast span") || {}).textContent || "";
      await canvasFlushRemoteWrite(); await new Promise((r) => setTimeout(r, 500));
      const 删 = { 发出去了, 登记在途, 结果, 提示, 删完个数, 现在个数: canvasState.graph.getElements().length,
        回来了: !!canvasState.graph.getCell("g1"), 在途清了: !canvasState.inflight.has("g1"),
        盘上有它: (window.__store.jia.main.nodes || []).some((n) => n.id === "g1" || (n.payload || {}).sourceId === "g1") };

      // ② 发出去之后，1.8 秒一趟的远端同步把整张图重铺了（节点对象全换成新的）
      const 旧对象 = canvasState.graph.getCell("g2");
      let release2; window.__holdRun = new Promise((r) => { release2 = r; });
      const 跑2 = canvasGenerate(旧对象, "image");
      await new Promise((r) => setTimeout(r, 60));
      // 远端那份是别处写的：在途的 g2 标题被改了，另外多了一张 g3。g3 得铺上来（对照：同步没被整个掐掉），
      // g2 得留本机这份——在途的节点不许被远端快照盖回去
      const 远端 = JSON.parse(JSON.stringify(window.__store.jia.main));
      远端.nodes = 远端.nodes.map((n) => n.id === "g2" ? { ...n, payload: { ...n.payload, title: "远端改的标题" } } : n)
        .concat([镜头g3]);
      window.__store.jia.main = { ...远端, updatedAt: Date.now() + 5000 };
      canvasStartRemoteSync();
      const 到点 = Date.now() + 6000;
      while (Date.now() < 到点 && canvasState.graph.getCell("g2") === 旧对象) await new Promise((r) => setTimeout(r, 100));
      const 换了对象 = canvasState.graph.getCell("g2") !== 旧对象;
      const 重铺后 = { 标题: (canvasState.graph.getCell("g2").get("canvasPayload") || {}).title, 对照铺上了: !!canvasState.graph.getCell("g3") };
      release2(); const 结果2 = await 跑2; window.__holdRun = null;
      await new Promise((r) => setTimeout(r, 2400));   // 再让同步转一圈：拉回来的那份不许把刚放上的首帧盖掉
      clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null;
      await canvasFlushRemoteWrite(); await new Promise((r) => setTimeout(r, 200));
      const 新 = canvasState.graph.getCell("g2");
      const 盘上 = (window.__store.jia.main.nodes || []).find((n) => n.id === "g2");

      // ③ 文件已经放上画布之后才出的错（这儿让右侧预览炸掉）：这一格是做好了的，不能按没成算——
      // 算成没成，「重试失败的」就会让人为一张已经有了的图再付一次钱
      const 原预览 = window.previewFile;
      window.previewFile = () => { throw new Error("预览炸了"); };
      const 结果3 = await canvasGenerate(canvasState.graph.getCell("g3"), "image");
      window.previewFile = 原预览;
      const 后炸 = { 结果: 结果3, 提示: (document.querySelector("#owb-toast span") || {}).textContent || "",
        首帧: (canvasState.graph.getCell("g3").get("canvasPayload") || {}).first_frame || "" };
      await canvasFlushRemoteWrite(); await new Promise((r) => setTimeout(r, 200));
      return { 删, 后炸, 铺: { 换了对象, 重铺后, 结果2, 屏幕上: (新.get("canvasPayload") || {}).first_frame || "",
        孤儿身上: (旧对象.get("canvasPayload") || {}).first_frame || "", 盘上: (盘上 && 盘上.payload && 盘上.payload.first_frame) || "" } };
    })()`);
  ok(途中.删.发出去了 && 途中.删.登记在途, "先验料：那一枪真发出去了，而且登记成在途", 途中.删);
  ok(!途中.删.回来了 && 途中.删.现在个数 === 途中.删.删完个数 && !途中.删.盘上有它,
     "★生成途中删掉的节点不许复活★ 以前回来就往手里那个旧对象上写、再挂一张结果卡，删掉的那一镜又长回来了",
     途中.删);
  ok(途中.删.结果 && 途中.删.结果.ok === false && /没有放回画布/.test(途中.删.提示) && 途中.删.在途清了,
     "删掉之后回来的结果不算做好了，并且告诉人文件去了哪；在途登记也清掉了",
     { 结果: 途中.删.结果, 提示: 途中.删.提示, 在途清了: 途中.删.在途清了 });
  ok(途中.铺.换了对象, "先验料：生成途中远端同步真把图重铺了一遍（节点对象换新了）", 途中.铺);
  ok(途中.铺.结果2 && 途中.铺.结果2.ok === true && /^outputs\//.test(途中.铺.屏幕上) && !途中.铺.孤儿身上,
     "★重铺之后回来的结果，落到屏幕上那张卡上，不是落到被扔掉的旧对象上★",
     途中.铺);
  ok(途中.铺.盘上 === 途中.铺.屏幕上,
     "★再来一趟同步也不许把刚放上的首帧盖回去，而且它真存上了盘★", 途中.铺);
  ok(途中.铺.重铺后 && 途中.铺.重铺后.对照铺上了 && 途中.铺.重铺后.标题 === "g2",
     "★远端重铺时，正在生成的那张卡留本机这份★ 远端那份是发起之前的，拿它铺上去，生成期间本机的字就被盖回去了；别的卡照常铺",
     途中.铺.重铺后);
  ok(途中.后炸.结果 && 途中.后炸.结果.ok === true && /^outputs\//.test(途中.后炸.首帧) && !/生成失败/.test(途中.后炸.提示),
     "★文件放上画布之后才出的错，这一格仍算做好了★ 算成没成，重试按钮会让人为已经有的图再付一次钱",
     途中.后炸);

  console.log("\n— 十五、改一笔马上撤销，挂着的那趟写不许落盘 —");
  const 撤写 = await run(`
    (async () => {
      await canvasFlushRemoteWrite();
      await new Promise((r) => setTimeout(r, 300));
      const 原样 = { version: 2, updatedAt: Date.now() + 1000, edges: [], nodes: [
        { id: "u1", kind: "note", payload: { title: "盘上原来的标题" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } }] };
      window.__store.jia.main = JSON.parse(JSON.stringify(原样));
      canvasApplySnapshot(原样, { fromRemote: true });
      canvasHistoryReset(canvasSnapshot());
      window.__puts = [];
      const node = canvasState.graph.getCell("u1");
      node.set("canvasPayload", { ...node.get("canvasPayload"), title: "撤销前改的" }); canvasPersist();
      const 挂上了 = !!canvasState.remoteWriteTimer;
      canvasUndo();
      await new Promise((r) => setTimeout(r, 700));
      const 屏幕 = (canvasState.graph.getCell("u1").get("canvasPayload") || {}).title;
      const 盘上 = (((window.__store.jia.main.nodes || [])[0] || {}).payload || {}).title;
      const 写过改的 = window.__puts.some((p) => (p.标题 || []).includes("撤销前改的"));
      // 反向对照：不撤销的话，这一笔是会写上去的
      window.__puts = [];
      const n2 = canvasState.graph.getCell("u1");
      n2.set("canvasPayload", { ...n2.get("canvasPayload"), title: "这回不撤销" }); canvasPersist();
      await new Promise((r) => setTimeout(r, 700));
      const 对照盘上 = (((window.__store.jia.main.nodes || [])[0] || {}).payload || {}).title;
      return { 挂上了, 屏幕, 盘上, 写过改的, 对照盘上 };
    })()`);
  ok(撤写.挂上了, "先验料：改那一笔真挂上了一趟防抖写", 撤写);
  ok(撤写.屏幕 === "盘上原来的标题" && 撤写.盘上 === "盘上原来的标题" && !撤写.写过改的,
     "★改完马上撤销回服务器那份，挂着的那趟写不许带着撤销前的内容落盘★ 以前「跟服务器一样就不写」那句判在撤定时器前面，"
     + "屏幕上是撤销后的、盘上是撤销前的，两边从此对不上",
     撤写);
  ok(撤写.对照盘上 === "这回不撤销",
     "反向对照：不撤销的那一笔照样写得上去——不是把写盘整个掐了", 撤写.对照盘上);

  console.log("\n— 十六、同一份分镜表展开两次，卡片不许翻倍 —");
  const 展开 = await run(`
    (async () => {
      window.__board = { style: "", characters: [{ id: "A", name: "阿明", look: "短发、灰夹克" }],
        scenes: [{ id: "S1", place: "江边码头", time: "夜", shots: [
          { id: "S1-01", frame_prompt: "码头远景", cast: ["A"] }, { id: "S1-02", frame_prompt: "阿明特写", cast: ["A"] }] },
          // 第二场的两镜没写镜头号：两张卡的戳一模一样，再展开时得各认各的，不能都更新到第一张上
          { id: "S2", place: "仓库", time: "夜", shots: [{ frame_prompt: "仓库门口" }, { frame_prompt: "仓库里面" }] }] };
      // 分镜节点摆在场次那一格（100, 430）上：不整理布局的话，第一场的卡正压在它身上
      ${摆画布([{ id: "sb", kind: "storyboard", payload: { title: "短剧分镜", board: "ep1" }, position: { x: 100, y: 430 }, size: { width: 320, height: 240 } }])}
      const 数 = () => {
        const els = canvasState.graph.getElements(), k = (x) => els.filter((n) => canvasKind(n) === x).length;
        return { 全部: els.length, 连线: canvasState.graph.getLinks().length, 角色: k("character"), 场次: k("scene"), 镜头: k("shot") };
      };
      const 点展开 = async () => {
        const sb = canvasState.graph.getCell("sb"); canvasRefreshNode(sb);   // 重画一次卡片，按钮回到能点的样子
        const button = sb.findView(canvasState.paper).el.querySelector("[data-canvas-expand]");
        if (!button || button.disabled) return "按钮点不了";
        button.click();
        const 到点 = Date.now() + 6000;
        await new Promise((r) => setTimeout(r, 30));
        while (Date.now() < 到点 && button.isConnected && button.textContent === "加载中…") await new Promise((r) => setTimeout(r, 50));
        return button.textContent;
      };
      const 第一次按钮 = await 点展开(), 第一次 = 数();
      // 第一次展开就不该抄：只看第二次的话，更新那条路顺手删掉的抄本会把新建这条路漏抄的遮过去
      const 第一次抄本 = canvasState.graph.getElements().filter((n) => canvasKind(n) === "scene").some((n) => "shots" in (n.get("canvasPayload") || {}));
      window.__board.scenes[0].shots[0].frame_prompt = "码头远景，起雾了";   // 分镜表里改了一句
      window.__board.scenes[1].shots[1].frame_prompt = "仓库里面，灯灭了";
      const 第二次按钮 = await 点展开(), 第二次 = 数();
      const els = canvasState.graph.getElements();
      const 场次带抄本 = els.filter((n) => canvasKind(n) === "scene").some((n) => "shots" in (n.get("canvasPayload") || {}));
      const 改过的 = els.find((n) => canvasKind(n) === "shot" && (n.get("canvasPayload") || {}).board_shot === "S1-01");
      const 无号 = els.filter((n) => canvasKind(n) === "shot" && (n.get("canvasPayload") || {}).board_scene === "S2")
        .map((n) => (n.get("canvasPayload") || {}).prompt).sort();
      const 场次卡 = els.find((n) => canvasKind(n) === "scene");
      const 场次卡上写着 = (场次卡.findView(canvasState.paper).el.querySelector(".canvas-scene-count") || {}).textContent || "";
      // 整理过布局的话卡片两两不压：按固定格子摆的新卡会压在旧卡上
      const box = els.map((n) => ({ ...n.position(), ...n.size() }));
      let 压着的 = 0;
      for (let i = 0; i < box.length; i++) for (let j = i + 1; j < box.length; j++) {
        const a = box[i], b = box[j];
        if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) 压着的 += 1;
      }
      await canvasFlushRemoteWrite(); await new Promise((r) => setTimeout(r, 300));
      const 盘上 = window.__store.jia.main.nodes || [];
      window.__board = null;
      return { 第一次按钮, 第二次按钮, 第一次, 第二次, 第一次抄本, 场次带抄本, 无号, 改过的提示词: 改过的 ? (改过的.get("canvasPayload") || {}).prompt : null,
               场次卡上写着, 压着的, 盘上个数: 盘上.length, 盘上场次带抄本: 盘上.some((n) => n.kind === "scene" && "shots" in (n.payload || {})) };
    })()`);
  ok(/已展开/.test(展开.第一次按钮) && 展开.第一次.角色 === 1 && 展开.第一次.场次 === 2 && 展开.第一次.镜头 === 4,
     "先验料：第一次展开真摆出了 1 个角色、2 场、4 镜", { 按钮: 展开.第一次按钮, 数: 展开.第一次 });
  ok(/已展开/.test(展开.第二次按钮) && JSON.stringify(展开.第二次) === JSON.stringify(展开.第一次),
     "★同一份分镜表再展开一次，节点数和连线数一个不多★ 以前每展开一次整套再建一遍，两次就是两个阿明、四镜",
     { 第一次: 展开.第一次, 第二次: 展开.第二次 });
  ok(/起雾了/.test(展开.改过的提示词 || ""),
     "★已有的卡只更新字段：分镜表里改的那句，第二次展开后卡上是新的★", 展开.改过的提示词);
  ok(JSON.stringify(展开.无号) === JSON.stringify(["仓库门口", "仓库里面，灯灭了"].sort()),
     "★没写镜头号的两镜各认各的卡★ 戳一样的话不记「这趟认领过谁」，两镜都更新到第一张上，第二张一直是旧字", 展开.无号);
  ok(!展开.第一次抄本 && !展开.场次带抄本 && !展开.盘上场次带抄本 && /^2 镜/.test(展开.场次卡上写着),
     "★场次卡的 payload 里不再抄一整份 shots，卡上的「2 镜」数的是挂着的镜头卡★ 抄本不跟着改、删走，存盘还每一镜存两遍",
     { 第一次: 展开.第一次抄本, 屏幕: 展开.场次带抄本, 盘上: 展开.盘上场次带抄本, 卡上: 展开.场次卡上写着 });
  ok(展开.压着的 === 0 && 展开.盘上个数 === 展开.第二次.全部,
     "展开完自动整理过布局（没有两张卡压在一起），存上盘的也是这么多张", { 压着的: 展开.压着的, 盘上: 展开.盘上个数 });

  console.log("\n— 十七、右键删除跟 Delete 键走同一条路，删了能撤 —");
  const 右键 = await run(`
    (async () => {
      ${摆画布([
        { id: "r1", kind: "note", payload: { title: "要右键删的" }, position: { x: 40, y: 40 }, size: { width: 280, height: 180 } },
        { id: "r2", kind: "note", payload: { title: "选着的那张" }, position: { x: 400, y: 40 }, size: { width: 280, height: 180 } },
        { id: "r3", kind: "note", payload: { title: "按 Delete 删的" }, position: { x: 760, y: 40 }, size: { width: 280, height: 180 } }],
        [{ source: { id: "r1" }, target: { id: "r2" } }])}
      canvasHistoryReset(canvasSnapshot());
      let 问了 = 0; const 原来的问 = window.askConfirm;
      window.askConfirm = async () => { 问了 += 1; return true; };
      // 选着 r2，右键点的是没选中的 r1：删掉的只能是 r1
      canvasSetSelection(new Set(["r2"]), "r2");
      const root = canvasState.graph.getCell("r1").findView(canvasState.paper).el.querySelector(".canvas-joint-node");
      root.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 120, button: 2 }));
      const 删 = document.querySelector('#canvas-context-menu [data-canvas-context="delete"]');
      if (!删) { window.askConfirm = 原来的问; return { 错: "右键菜单里没有删除" }; }
      删.click();
      await new Promise((r) => setTimeout(r, 60));
      const 删后 = { r1: !!canvasState.graph.getCell("r1"), r2: !!canvasState.graph.getCell("r2"), 连线: canvasState.graph.getLinks().length };
      const box = document.getElementById("owb-toast"), 撤 = box && box.querySelector(".owb-toast-act");
      const 按钮 = 撤 ? 撤.textContent : null, 提示 = box ? (box.querySelector("span") || {}).textContent : "";
      if (撤) 撤.click();
      await new Promise((r) => setTimeout(r, 700));
      const 撤后 = { r1: !!canvasState.graph.getCell("r1"), 连线: canvasState.graph.getLinks().length,
        盘上: (window.__store.jia.main.nodes || []).map((n) => n.id).sort().join(",") };

      // Delete 键那条路：同样不问、同样挂撤销
      canvasHistoryReset(canvasSnapshot());
      canvasSetSelection(new Set(["r3"]), "r3");
      document.getElementById("assist-page").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 60));
      const 键删后 = !!canvasState.graph.getCell("r3");
      const 键撤 = document.querySelector("#owb-toast .owb-toast-act");
      const 键按钮 = 键撤 ? 键撤.textContent : null;
      if (键撤) 键撤.click();
      await new Promise((r) => setTimeout(r, 100));
      window.askConfirm = 原来的问;
      return { 问了, 删后, 按钮, 提示, 撤后, 键: { 删后: 键删后, 按钮: 键按钮, 撤后: !!canvasState.graph.getCell("r3") } };
    })()`);
  ok(!右键.错 && 右键.删后 && !右键.删后.r1 && 右键.删后.r2 && 右键.删后.连线 === 0,
     "右键「删除节点」删掉的是右键点的那张，选着的另一张不动", 右键);
  ok(右键.问了 === 0 && 右键.按钮 === "撤销" && 右键.提示 === "节点已删除。",
     "★右键删跟 Delete 键一个脾气：不先问，删完提示上挂「撤销」★ 以前右键要先确认、删了却撤不回来",
     { 问了: 右键.问了, 按钮: 右键.按钮, 提示: 右键.提示 });
  ok(右键.撤后 && 右键.撤后.r1 && 右键.撤后.连线 === 1 && 右键.撤后.盘上 === "r1,r2,r3",
     "★点「撤销」那张卡连同它的连线一起回来，盘上也是★", 右键.撤后);
  ok(右键.键 && 右键.键.删后 === false && 右键.键.按钮 === "撤销" && 右键.键.撤后 === true,
     "Delete 键那条路同样挂「撤销」，点了就回来", 右键.键);


  // ———— 下面几节是「写回不串、改了能回」那一轮（2.2）：版本号、撞号、409 合并、历史版本、撤销回表 ————
  // 节点 id 和镜头号分开写：镜头号决定文件名，节点 id 只是画布上的身份
  const 号镜头 = (nodeId, shotId, prompt, y, extra) => ({ id: nodeId, kind: "shot", payload: { id: shotId, title: shotId, prompt, ...(extra || {}) },
    position: { x: 40, y }, size: { width: 300, height: 220 } });
  const 笔记 = (id, title, x) => ({ id, kind: "note", payload: { title }, position: { x, y: 40 }, size: { width: 280, height: 180 } });
  const 等 = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;
  // 假台账照真服务端 /api/canvas/assets 的行长相给全字段：素材库面板按 kind 取图标，
  // 缺了 kind 它当场抛，后面那句「重读台账」就再也走不到，上一节的台账会一直挂在 canvasState 上
  const 台账 = (...names) => JSON.stringify({ assets: names.map((name) => ({ name, base: name.split("/").pop(), kind: "image", role: "其他",
    size: 1, mtime: "2026-09-20T00:00:00.000Z", usedBy: [], orphan: true })) });

  console.log("\n— 十八、镜头产物带版本号，落进这张画布自己的子目录 —");
  const 版本 = await run(`
    (async () => {
      ${摆画布([号镜头("vs1", "S1-01", "码头远景", 40)])}
      window.__bodies = []; window.__runs = []; window.__failRun = null; window.__echoName = true;
      canvasState.versionTaken = new Map(); canvasState.assetsCheckedAt = 0;
      const 生 = () => canvasGenerate(canvasState.graph.getCell("vs1"), "image");
      // 同参数再点「生成」是沿用上一版、不发请求（第二十五节量）；要新的一版走「换一版」
      const 换一版 = () => canvasReroll(canvasState.graph.getCell("vs1"), "image");
      const 发的 = () => window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => ({ 名: b.body.input.filename, 目录: b.body.subdir, 不走缓存: b.body.input.no_cache }));
      const 结果 = [await 生(), await 换一版()];
      const 两枪 = 发的();
      const 首帧 = (canvasState.graph.getCell("vs1").get("canvasPayload") || {}).first_frame;
      // 换个标签页的样子：发号记录是空的，只能靠素材台账——台账里本画布已经有 v5；别的画布那份 v9 不算
      canvasState.versionTaken = new Map(); canvasState.assetsCheckedAt = 0;
      window.__assets = ${台账("短剧/main/镜头_S1-01_首帧_v5.png", "短剧/别的画布/镜头_S1-01_首帧_v9.png")};
      window.__bodies = [];
      await 换一版();
      const 第三枪 = 发的()[0] || null;
      window.__echoName = false; window.__assets = null;
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 结果, 两枪, 首帧, 第三枪 };
    })()`);
  ok(版本.结果.every((r) => r && r.ok) && 版本.两枪.length === 2, "先验料：两枪都真发出去了、都成了", 版本);
  ok(版本.两枪[0] && 版本.两枪[0].名 === "镜头_S1-01_首帧_v1.png" && 版本.两枪[1] && 版本.两枪[1].名 === "镜头_S1-01_首帧_v2.png",
     "★同一镜先生成、再「换一版」，文件名从 v1 变成 v2★ 以前两枪同名，第二枪把第一枪买回来的那张盖掉，没有「上一版」可回", 版本.两枪);
  ok(版本.两枪[0] && 版本.两枪[0].不走缓存 === undefined && 版本.两枪[1] && 版本.两枪[1].不走缓存 === true
     && 版本.第三枪 && 版本.第三枪.不走缓存 === true,
     "★第一次生成不带 no_cache（同参数能吃缓存），「换一版」那两枪带 no_cache:true★", 版本);
  ok(版本.两枪.every((b) => b.目录 === "短剧/main") && 版本.首帧 === "短剧/main/镜头_S1-01_首帧_v2.png",
     "★请求体带 subdir: 短剧/画布名，卡片记的是带子目录的完整路径★ 两张画布都有 S1-01，不分目录就互相覆盖", { 两枪: 版本.两枪, 首帧: 版本.首帧 });
  ok(版本.第三枪 && 版本.第三枪.名 === "镜头_S1-01_首帧_v6.png",
     "★版本号从素材台账里算：本画布已有 v5 就发 v6，别的画布的 v9 不算★ 只看本机发号记录的话，另一个标签页生过的版本会被盖掉",
     版本.第三枪);

  console.log("\n— 十九、新加的镜头自动取下一个空号，撞号的卡挂红框 —");
  const 编号 = await run(`
    (async () => {
      ${摆画布([号镜头("q1", "S1-01", "甲", 40), 号镜头("q2", "S1-02", "乙", 300)])}
      const 新 = canvasAddNode("shot", { title: "新镜头", prompt: "丙" }, { x: 700, y: 40 });
      const 新号 = (新.get("canvasPayload") || {}).id;
      const 红框 = (id) => !!canvasState.graph.getCell(id).findView(canvasState.paper).el.querySelector(".canvas-joint-node.is-dup-id");
      // 在检查器里把第二张的镜头号改成跟第一张一样
      canvasState.inspectorOpen = true; canvasSetSelection(new Set(["q2"]), "q2");
      const 框 = document.querySelector('#canvas-inspector [data-inspect-key="id"]');
      if (!框) return { 错: "检查器里没有镜头 ID 输入框" };
      框.value = "S1-01"; 框.dispatchEvent(new Event("input", { bubbles: true }));
      const 提示 = document.querySelector("#canvas-inspector [data-canvas-dup-hint]");
      const 撞号时 = { q1: 红框("q1"), q2: 红框("q2"), 新: 红框(新.id), 提示: 提示 ? 提示.textContent : null, 看得见: !!(提示 && !提示.hidden && getComputedStyle(提示).display !== "none") };
      // 改回去，红框和提示一起消失
      框.value = "S1-02"; 框.dispatchEvent(new Event("input", { bubbles: true }));
      const 改回后 = { q1: 红框("q1"), q2: 红框("q2"), 提示藏了: !!(提示 && 提示.hidden) };
      // 只差大小写：mac、Windows 的盘不分大小写，落盘是同一个文件，也得算撞号
      框.value = "s1-01"; 框.dispatchEvent(new Event("input", { bubbles: true }));
      const 大小写 = { q1: 红框("q1"), q2: 红框("q2"), 提示亮: !!(提示 && !提示.hidden),
        认版本: canvasVersionOf("短剧/main/镜头_s1-01_首帧_v3.png", { id: "S1-01" }, "image") };
      框.value = "S1-02"; 框.dispatchEvent(new Event("input", { bubbles: true }));
      // 右键「复制节点」：编号和分镜表的戳不跟着抄，拿下一个空号
      canvasState.graph.getCell("q1").set("canvasPayload", { ...canvasState.graph.getCell("q1").get("canvasPayload"), board: "ep1", board_shot: "S1-01" });
      canvasOpenContextMenu(100, 100, canvasState.graph.getCell("q1"));
      const 复制 = document.querySelector('#canvas-context-menu [data-canvas-context="duplicate"]');
      const 之前 = new Set(canvasState.graph.getElements().map((n) => n.id));
      if (复制) 复制.click();
      const 副本 = canvasState.graph.getElements().find((n) => !之前.has(n.id));
      const 副本字段 = 副本 ? 副本.get("canvasPayload") || {} : {};
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 新号, 撞号时, 改回后, 大小写, 副本: { 号: 副本字段.id || null, 戳: 副本字段.board || 副本字段.board_shot || "", 红框: 副本 ? 红框(副本.id) : null } };
    })()`);
  ok(!编号.错 && 编号.新号 === "S1-03", "★新加的镜头自动取下一个空号★ 以前一律 S1-01，两张卡生成时写进同一个文件", 编号);
  ok(编号.撞号时 && 编号.撞号时.q1 && 编号.撞号时.q2 && !编号.撞号时.新,
     "★镜头号撞了，两张卡都挂红框，没撞的那张不挂★", 编号.撞号时);
  ok(编号.撞号时 && 编号.撞号时.提示 === "镜头号重复，生成会写到同一个文件" && 编号.撞号时.看得见,
     "★检查器里就地亮出「镜头号重复，生成会写到同一个文件」★ 不整块重画，打字的光标不丢", 编号.撞号时);
  ok(编号.改回后 && !编号.改回后.q1 && !编号.改回后.q2 && 编号.改回后.提示藏了,
     "反向对照：改回不撞的号，红框和提示一起收掉——不是一直挂着", 编号.改回后);
  ok(编号.大小写 && 编号.大小写.q1 && 编号.大小写.q2 && 编号.大小写.提示亮 && 编号.大小写.认版本 === 3,
     "★S1-01 和 s1-01 也算撞号，发版本号时也认得对方的 v3★ mac、Windows 的盘不分大小写，落下去是同一个文件", 编号.大小写);
  ok(编号.副本 && 编号.副本.号 === "S1-04" && !编号.副本.戳 && 编号.副本.红框 === false,
     "★右键复制一张镜头：拿下一个空号，不抄分镜表的戳★ 抄了就是两张卡写同一个文件、回同一行分镜表", 编号.副本);

  console.log("\n— 二十、撞了 409：按节点合并，两边改的都留下 —");
  const 合并 = await run(`
    (async () => {
      ${摆画布([笔记("c1", "本机要改的", 40), 笔记("c2", "别处要改的", 400)])}
      window.__cas = true; window.__putBodies = [];
      const 起点 = canvasState.remoteBase ? canvasState.remoteBase.at : null;
      // 别处（另一个标签页 / Agent）先写了一笔：c2 换了标题，还多了一张 c3
      const 盘 = JSON.parse(JSON.stringify(window.__store.jia.main));
      盘.nodes = 盘.nodes.map((n) => n.id === "c2" ? { ...n, payload: { ...n.payload, title: "别处改过的" } } : n)
        .concat([${JSON.stringify(笔记("c3", "别处新加的", 760))}]);
      window.__store.jia.main = { ...盘, updatedAt: 5000 };
      // 本机这边改的是 c1
      const n1 = canvasState.graph.getCell("c1");
      n1.set("canvasPayload", { ...n1.get("canvasPayload"), title: "本机改过的" }); canvasPersist();
      ${等(400)}
      await canvasFlushRemoteWrite(); ${等(200)}
      const 标题 = (id) => { const c = canvasState.graph.getCell(id); return c ? (c.get("canvasPayload") || {}).title : null; };
      const 盘上 = Object.fromEntries((window.__store.jia.main.nodes || []).map((n) => [n.id, (n.payload || {}).title]));
      const out = { 起点, 交了: window.__putBodies.map((p) => ({ base: p.baseUpdatedAt, status: p.status })),
        屏幕: { c1: 标题("c1"), c2: 标题("c2"), c3: 标题("c3") }, 盘上, 弹框: !!document.getElementById("canvas-conflict-dialog") };
      window.__cas = false;
      return out;
    })()`);
  ok(合并.起点 === 1000 && 合并.交了[0] && 合并.交了[0].base === 1000 && 合并.交了[0].status === 409,
     "先验料：自动保存带着 baseUpdatedAt（照着盘上 1000 那一版改的），盘上已经是 5000，真撞了 409", 合并);
  ok(合并.交了.length >= 2 && 合并.交了[合并.交了.length - 1].base === 5000 && 合并.交了[合并.交了.length - 1].status === 200,
     "★撞了 409 不丢这一笔：拉最新那份合好，照着 5000 那版再交一次，交上了★", 合并.交了);
  ok(合并.屏幕.c1 === "本机改过的" && 合并.屏幕.c2 === "别处改过的" && 合并.屏幕.c3 === "别处新加的",
     "★屏幕上：本机改的 c1 留本机的，别处改的 c2、新加的 c3 用盘上的★ 以前后写的整张盖掉先写的", 合并.屏幕);
  ok(合并.盘上.c1 === "本机改过的" && 合并.盘上.c2 === "别处改过的" && 合并.盘上.c3 === "别处新加的" && !合并.弹框,
     "★盘上最后那份两边的改动都在；改的不是同一张卡就不弹框问人★", { 盘上: 合并.盘上, 弹框: 合并.弹框 });

  console.log("\n— 二十一、同一张卡两边都改了：弹框问留哪边，不替人选 —");
  const 冲突 = await run(`
    (async () => {
      ${摆画布([笔记("x1", "原来的标题", 40), 笔记("x2", "旁边那张", 400)])}
      window.__cas = true; window.__putBodies = [];
      const 标题 = (id) => { const c = canvasState.graph.getCell(id); return c ? (c.get("canvasPayload") || {}).title : null; };
      const 盘标题 = (id) => (((window.__store.jia.main.nodes || []).find((n) => n.id === id) || {}).payload || {}).title;
      const 改 = (id, title) => { const c = canvasState.graph.getCell(id); c.set("canvasPayload", { ...c.get("canvasPayload"), title }); canvasPersist(); };
      // 盘上改了 x1；本机也改了 x1，另外还改了 x2（这张不冲突，得照样留着）
      const 盘 = JSON.parse(JSON.stringify(window.__store.jia.main));
      盘.nodes = 盘.nodes.map((n) => n.id === "x1" ? { ...n, payload: { ...n.payload, title: "盘上改的" } } : n);
      window.__store.jia.main = { ...盘, updatedAt: 6000 };
      改("x1", "我改的"); 改("x2", "旁边那张我也改了");
      ${等(400)} await canvasFlushRemoteWrite(); ${等(100)}
      const box = document.getElementById("canvas-conflict-dialog");
      const 等人选 = { 弹框: !!box, 按钮: box ? [...box.querySelectorAll("[data-canvas-conflict]")].map((b) => b.textContent) : [],
        焦点: ((document.activeElement || {}).dataset || {}).canvasConflict || "", 列出来几张: box ? box.querySelectorAll(".ask-li li").length : 0,
        屏幕: 标题("x1"), 盘上: 盘标题("x1") };
      // 选之前又动了一笔：这期间一笔都不许写进项目——写了就等于替他选了「用我的」
      const 选前 = window.__putBodies.length;
      改("x2", "选之前又改了一笔");
      ${等(500)}
      const 选前多交 = window.__putBodies.length - 选前;
      if (!box) { window.__cas = false; return { 等人选 }; }
      box.querySelector('[data-canvas-conflict="mine"]').click();
      ${等(100)} await canvasFlushRemoteWrite(); ${等(200)}
      const 用我的 = { 弹框还在: !!document.getElementById("canvas-conflict-dialog"), 屏幕: 标题("x1"), 盘上: 盘标题("x1"), 旁边: 盘标题("x2") };
      // 第二轮：再撞一次，这回点「用盘上的」
      const 盘2 = JSON.parse(JSON.stringify(window.__store.jia.main));
      盘2.nodes = 盘2.nodes.map((n) => n.id === "x1" ? { ...n, payload: { ...n.payload, title: "盘上第二次改的" } } : n);
      window.__store.jia.main = { ...盘2, updatedAt: Date.now() + 9000 };
      改("x1", "我第二次改的");
      ${等(400)} await canvasFlushRemoteWrite(); ${等(100)}
      const box2 = document.getElementById("canvas-conflict-dialog");
      if (box2) box2.querySelector('[data-canvas-conflict="disk"]').click();
      ${等(100)} await canvasFlushRemoteWrite(); ${等(200)}
      const 用盘上的 = { 弹了: !!box2, 屏幕: 标题("x1"), 盘上: 盘标题("x1"), 旁边屏幕: 标题("x2") };
      window.__cas = false;
      return { 等人选, 选前多交, 用我的, 用盘上的 };
    })()`);
  ok(冲突.等人选 && 冲突.等人选.弹框 && 冲突.等人选.列出来几张 === 1,
     "★同一张卡两边都改了，弹框问人，只列撞上的那一张★", 冲突.等人选);
  ok(冲突.等人选 && 冲突.等人选.按钮.includes("用我的") && 冲突.等人选.按钮.includes("用盘上的") && 冲突.等人选.焦点 === "later",
     "★框里有「用我的」「用盘上的」，焦点落在「稍后再选」★ 回车不该替人挑一边", 冲突.等人选);
  ok(冲突.等人选 && 冲突.等人选.屏幕 === "我改的" && 冲突.等人选.盘上 === "盘上改的" && 冲突.选前多交 === 0,
     "★选之前两边各留各的，一笔都不往项目里写★ 写了就等于替他选了「用我的」", { 等人选: 冲突.等人选, 选前多交: 冲突.选前多交 });
  ok(冲突.用我的 && !冲突.用我的.弹框还在 && 冲突.用我的.屏幕 === "我改的" && 冲突.用我的.盘上 === "我改的" && 冲突.用我的.旁边 === "选之前又改了一笔",
     "★点「用我的」：这张卡留本机的并写上盘，不冲突的那张（含弹框开着时改的）也在★", 冲突.用我的);
  ok(冲突.用盘上的 && 冲突.用盘上的.弹了 && 冲突.用盘上的.屏幕 === "盘上第二次改的" && 冲突.用盘上的.盘上 === "盘上第二次改的"
     && 冲突.用盘上的.旁边屏幕 === "选之前又改了一笔",
     "★点「用盘上的」：这张卡换成盘上的，别的卡不动★", 冲突.用盘上的);

  console.log("\n— 二十二、历史版本：换回旧版只改卡片引用，不删文件 —");
  const 历史 = await run(`
    (async () => {
      const V = (n) => "短剧/main/镜头_S1-01_首帧" + (n ? "_v" + n : "") + ".png";
      window.__assets = ${台账("短剧/main/镜头_S1-01_首帧_v1.png", "短剧/main/镜头_S1-01_首帧_v2.png")};
      window.__shotHistory = { ok: true, usage: {}, versions: [{ id: "snap1", ts: "2026-09-20T10:00:00.000Z", why: "写回前留底", session: "", fields: {},
        files: { first_frame: { rel: "镜头_S1-01_首帧.png", kept: true, bytes: 10 } }, restorable: true, same: false }] };
      ${摆画布([
        号镜头("h1", "S1-01", "码头远景", 40, { board: "ep1", board_scene: "S1", board_shot: "S1-01", first_frame: "短剧/main/镜头_S1-01_首帧_v2.png" }),
        { id: "h1img", kind: "image", payload: { title: "镜头_S1-01_首帧_v2.png", path: "短剧/main/镜头_S1-01_首帧_v2.png", url: "短剧/main/镜头_S1-01_首帧_v2.png", sourceId: "h1" },
          position: { x: 400, y: 40 }, size: { width: 280, height: 220 } }],
        [{ source: { id: "h1" }, target: { id: "h1img" } }])}
      canvasHistoryReset(canvasSnapshot());
      window.__bodies = []; window.__deletes = []; canvasState.shotHistory = new Map();
      canvasState.inspectorOpen = true; canvasSetSelection(new Set(["h1"]), "h1");
      const box = () => document.querySelector("#canvas-inspector [data-canvas-history]");
      const 到点 = Date.now() + 4000;
      while (Date.now() < 到点 && !(box() && box().querySelector(".canvas-history-row small") && !/正在读留底/.test(box().textContent))) ${等(50)}
      if (!box()) return { 错: "检查器里没有「历史版本」" };
      const 行 = [...box().querySelectorAll(".canvas-history-row")].map((li) => {
        const b = li.querySelector("button") || {};
        return { 版: (li.querySelector("b") || {}).textContent, 当前: li.classList.contains("is-current"), 按钮: b.textContent, 能点: !b.disabled, 提示: b.title || "", 留底: /留底/.test(li.textContent), rel: li.title };
      });
      const 标题 = (box().querySelector(".canvas-inspector-section-title") || {}).textContent;
      const 读留底 = window.__bodies.filter((b) => /shot-history/.test(b.url)).map((b) => b.method + " " + b.url);
      const btn = box().querySelector('[data-canvas-use-version="image"][data-rel="' + V(1) + '"]');
      if (!btn) return { 错: "没有 v1 那一行", 行 };
      btn.click();
      ${等(300)} await canvasFlushRemoteWrite(); ${等(200)}
      const p = canvasState.graph.getCell("h1").get("canvasPayload") || {};
      const 回写 = window.__bodies.filter((b) => b.url === "/api/drama/storyboard/output").map((b) => b.body);
      const 换后 = { 首帧: p.first_frame, 结果卡: (canvasState.graph.getCell("h1img").get("canvasPayload") || {}).path,
        盘上: ((((window.__store.jia.main.nodes || []).find((n) => n.id === "h1") || {}).payload) || {}).first_frame,
        当前行: box() ? ((box().querySelector(".canvas-history-row.is-current") || {}).title || "") : "", 回写,
        提示: (document.querySelector("#owb-toast span") || {}).textContent || "" };
      const 碰文件 = window.__bodies.filter((b) => /shot-history\\/(restore|snapshot)/.test(b.url)).map((b) => b.url);
      // 换错了还能撤：撤销回 v2，分镜表也跟着回
      window.__bodies = [];
      canvasUndo(); ${等(300)}
      const 撤后 = { 首帧: (canvasState.graph.getCell("h1").get("canvasPayload") || {}).first_frame,
        回写: window.__bodies.filter((b) => b.url === "/api/drama/storyboard/output").map((b) => b.body.fields) };
      await canvasFlushRemoteWrite(); ${等(200)}
      const out = { 行, 标题, 读留底, 换后, 删: window.__deletes.slice(), 碰文件, 撤后 };
      window.__assets = null; window.__shotHistory = null;
      return out;
    })()`);
  ok(!历史.错 && 历史.标题 === "历史版本" && 历史.读留底.length === 1 && /^GET \/api\/drama\/shot-history\?name=ep1&kind=shot&id=S1-01$/.test(历史.读留底[0]),
     "先验料：检查器里有「历史版本」，按分镜表的戳去读了这一镜的留底（只读一次）", 历史.错 ? 历史 : { 标题: 历史.标题, 读留底: 历史.读留底 });
  ok(!历史.错 && JSON.stringify(历史.行.map((r) => r.版)) === JSON.stringify(["v2", "v1", "原版"])
     && 历史.行[0].当前 && !历史.行[0].能点 && 历史.行[1].按钮 === "用这一版" && 历史.行[1].能点 && 历史.行[2].留底,
     "★列出这一镜首帧的 v2（当前）、v1，外加留底里的老原版★", 历史.行);
  ok(!历史.错 && 历史.行[1].提示 === "这是 v1，点「用这一版」切回来，不花钱",
     "按钮上说清楚这是第几版、点了会怎样、花不花钱", 历史.行 && 历史.行[1]);
  ok(!历史.错 && 历史.换后.首帧 === "短剧/main/镜头_S1-01_首帧_v1.png" && 历史.换后.结果卡 === 历史.换后.首帧 && 历史.换后.盘上 === 历史.换后.首帧
     && 历史.换后.当前行 === 历史.换后.首帧,
     "★点「用这一版」：卡片和连着的结果卡都改指 v1，存上了盘，列表里当前那行跟着换★", 历史.换后);
  ok(!历史.错 && 历史.换后.回写.length === 1 && 历史.换后.回写[0].name === "ep1" && 历史.换后.回写[0].shot === "S1-01"
     && JSON.stringify(历史.换后.回写[0].fields) === JSON.stringify({ first_frame: "短剧/main/镜头_S1-01_首帧_v1.png" }),
     "★只把 first_frame 这一个字段补丁写回分镜表★ 短剧页和命令行重跑读的是分镜表", 历史.换后 && 历史.换后.回写);
  ok(!历史.错 && 历史.删.length === 0 && 历史.碰文件.length === 0,
     "★换版本一个删除请求都没有，也不碰留底的 restore / snapshot★ restore 会把现在那份盖掉，snapshot 会按保留期清掉老留底",
     { 删: 历史.删, 碰文件: 历史.碰文件 });
  ok(!历史.错 && 历史.撤后.首帧 === "短剧/main/镜头_S1-01_首帧_v2.png" && 历史.撤后.回写.length === 1
     && 历史.撤后.回写[0].first_frame === "短剧/main/镜头_S1-01_首帧_v2.png",
     "换错了按撤销：卡片回到 v2，分镜表也跟着回", 历史.撤后);

  console.log("\n— 二十三、撤销把分镜表字段一起退回去，并补丁写回分镜表 —");
  const 撤表 = await run(`
    (async () => {
      ${摆画布([号镜头("w1", "S2-01", "仓库门口", 40, { board: "ep1", board_scene: "S2", board_shot: "S2-01", line: "原来的台词", shot_size: "中景" }),
        笔记("w2", "手搓的笔记", 400)])}
      canvasHistoryReset(canvasSnapshot());
      window.__bodies = [];
      const 回写 = () => window.__bodies.filter((b) => b.url === "/api/drama/storyboard/output").map((b) => b.body);
      const 字段 = () => { const p = canvasState.graph.getCell("w1").get("canvasPayload") || {}; return { line: p.line, shot_size: p.shot_size }; };
      const n = canvasState.graph.getCell("w1");
      n.set("canvasPayload", { ...n.get("canvasPayload"), line: "改过的台词", shot_size: "特写" }); canvasPersist();
      ${等(400)}
      const 改后 = { 字段: 字段(), 回写: 回写().length };
      canvasUndo(); ${等(300)}
      const 撤后 = { 字段: 字段(), 回写: 回写() };
      window.__bodies = [];
      canvasRedo(); ${等(300)}
      const 重做后 = { 字段: 字段(), 回写: 回写() };
      // 反向对照：只动了没盖分镜表戳的笔记，撤销不往分镜表写
      window.__bodies = [];
      const w2 = canvasState.graph.getCell("w2");
      w2.set("canvasPayload", { ...w2.get("canvasPayload"), title: "改了笔记" }); canvasPersist();
      ${等(400)}
      canvasUndo(); ${等(300)}
      const 笔记撤后 = { 标题: (canvasState.graph.getCell("w2").get("canvasPayload") || {}).title, 回写: 回写().length };
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 改后, 撤后, 重做后, 笔记撤后 };
    })()`);
  ok(撤表.改后.字段.line === "改过的台词" && 撤表.改后.回写 === 0, "先验料：台词和景别真改了，改的时候没往分镜表写（这一笔直接改的节点）", 撤表.改后);
  ok(撤表.撤后.字段.line === "原来的台词" && 撤表.撤后.字段.shot_size === "中景",
     "★撤销把台词、景别这些分镜表字段一起退回去★", 撤表.撤后.字段);
  ok(撤表.撤后.回写.length === 1 && 撤表.撤后.回写[0].name === "ep1" && 撤表.撤后.回写[0].shot === "S2-01" && 撤表.撤后.回写[0].scene === "S2"
     && JSON.stringify(撤表.撤后.回写[0].fields) === JSON.stringify({ shot_size: "中景", line: "原来的台词" }),
     "★撤销之后补丁写回一次，只带这一步动过的字段★ 不回的话分镜表还是撤掉的那句，短剧页重跑照着它花钱", 撤表.撤后.回写);
  ok(撤表.重做后.字段.line === "改过的台词" && 撤表.重做后.回写.length === 1
     && JSON.stringify(撤表.重做后.回写[0].fields) === JSON.stringify({ shot_size: "特写", line: "改过的台词" }),
     "重做同样回写：分镜表跟着回到改过的那句", 撤表.重做后);
  ok(撤表.笔记撤后.标题 === "手搓的笔记" && 撤表.笔记撤后.回写 === 0,
     "反向对照：撤销的是没盖分镜表戳的笔记，不往分镜表写——不是每次撤销都乱发一趟", 撤表.笔记撤后);

  console.log("\n— 二十四、冲突点了「稍后再选」就走了：再打开，本机没交上去的改动还在，接着问 —");
  const 挂着 = await run(`
    (async () => {
      ${摆画布([笔记("y1", "原来的标题", 40), 笔记("y2", "旁边那张", 400)])}
      window.__cas = true; window.__putBodies = [];
      const 标题 = (id) => { const c = canvasState.graph.getCell(id); return c ? (c.get("canvasPayload") || {}).title : null; };
      const 盘标题 = (id) => (((window.__store.jia.main.nodes || []).find((n) => n.id === id) || {}).payload || {}).title;
      const 改 = (id, title) => { const c = canvasState.graph.getCell(id); c.set("canvasPayload", { ...c.get("canvasPayload"), title }); canvasPersist(); };
      const 盘 = JSON.parse(JSON.stringify(window.__store.jia.main));
      盘.nodes = 盘.nodes.map((n) => n.id === "y1" ? { ...n, payload: { ...n.payload, title: "盘上改的" } } : n);
      window.__store.jia.main = { ...盘, updatedAt: 7000 };
      改("y1", "我改的"); 改("y2", "旁边我也改了");
      ${等(400)} await canvasFlushRemoteWrite(); ${等(100)}
      const box = document.getElementById("canvas-conflict-dialog");
      if (!box) { window.__cas = false; return { 错: "没弹框" }; }
      box.querySelector('[data-canvas-conflict="later"]').click();
      // 没选就走：切画布、刷新页面都是这条——拆掉画布、重新 renderCanvasPage
      await renderCanvasPage(); ${等(700)}
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      const box2 = document.getElementById("canvas-conflict-dialog");
      const 回来 = { 弹框: !!box2, y1: 标题("y1"), y2: 标题("y2"), 盘y1: 盘标题("y1"), 盘y2: 盘标题("y2") };
      if (box2) box2.querySelector('[data-canvas-conflict="mine"]').click();
      ${等(100)} await canvasFlushRemoteWrite(); ${等(200)}
      const 选后 = { y1: 盘标题("y1"), y2: 盘标题("y2"), 记录: Object.keys(localStorage).filter((k) => k.includes(".conflict:")).length };
      window.__cas = false;
      return { 回来, 选后 };
    })()`);
  ok(!挂着.错 && 挂着.回来.弹框 && 挂着.回来.y1 === "我改的" && 挂着.回来.y2 === "旁边我也改了" && 挂着.回来.盘y1 === "盘上改的" && 挂着.回来.盘y2 === "旁边那张",
     "★「稍后再选」之后重开画布：屏幕上还是本机那份，盘上没被替人选，框又弹出来问★ 以前重开直接铺盘上那份，没交上去的改动全丢", 挂着);
  ok(!挂着.错 && 挂着.选后.y1 === "我改的" && 挂着.选后.y2 === "旁边我也改了" && 挂着.选后.记录 === 0,
     "重开后选「用我的」：两张卡都写上盘，本机那条挂着的冲突记录擦掉", 挂着.选后);

  // ———— 第二十五节是「花钱可控」那一轮（3.2）：开跑前报价、同时跑有上限、同参数不重复扣费、失败补枪、滚轮 ————
  console.log("\n— 二十五、一键补齐先报价再开跑，点「先不了」一枪不发；同时最多跑 2 条 —");
  const 报价 = await run(`
    (async () => {
      ${摆画布([镜头("b1", "一号镜头", 40), 镜头("b2", "二号镜头", 300), 镜头("b3", "三号镜头", 560), 镜头("b4", "四号镜头", 820), 镜头("b5", "五号镜头", 1080)])}
      window.__progress = { stages: [], shots: ["b1", "b2", "b3", "b4", "b5"].map((nodeId) => ({ nodeId, frame: null, video: null, audio: null })) };
      await canvasLoadProgress();
      canvasState.batchLimit = 0;   // 按默认来（本机没存过）
      // 这一节要量真确认框：第八节换上的「一律点确定」先收起来，用完放回去
      const 替身 = window.askConfirm; window.askConfirm = window.__realAskConfirm;
      // 假服务器报价：三条各 ¥1.20、两条估不出
      window.__estimates = [];
      window.__estimate = (items) => ({ ok: true, total: 3.6, unknownCount: 2, items: items.map((it, i) => i < 3
        ? { tool: it.tool, model: "假模型", units: 1, unit: "张", unitPrice: 1.2, cost: 1.2, known: true }
        : { tool: it.tool, model: "没定价的", units: 1, unit: "张", unitPrice: null, cost: null, known: false }) });
      window.__runs = []; window.__bodies = []; window.__failRun = null; window.__peak = 0; window.__inflight = 0; window.__runDelay = 150;
      const 等框 = async () => { const t = Date.now() + 4000; while (Date.now() < t && !document.querySelector(".ask-mask .ask-box")) ${等(30)} return document.querySelector(".ask-mask .ask-box"); };
      const 读框 = (box) => box ? { 标题: (box.querySelector(".ask-t") || {}).textContent || "", 说明: (box.querySelector(".ask-h") || {}).textContent || "",
        取消: (box.querySelector(".ask-no") || {}).textContent || "", 确定: (box.querySelector(".ask-ok") || {}).textContent || "" } : null;
      // ① 弹框，点「先不了」
      const 跑1 = canvasRunPending("image");
      let box = await 等框();
      const 框 = 读框(box);
      const 弹框时已发 = window.__runs.length;
      const 报价请求 = (window.__estimates[0] || []).map((x) => x.tool);
      if (box) box.querySelector(".ask-no").click();
      await 跑1; ${等(300)}
      const 取消后 = { 发了: window.__runs.length, 在跑: !!canvasState.batch, 框还在: !!document.querySelector(".ask-mask") };
      // ② 再点一次，这回点「开始生成」
      const 跑2 = canvasRunPending("image");
      box = await 等框();
      if (box) box.querySelector(".ask-ok").click();
      await 跑2;
      const 确认后 = { 发了: [...window.__runs].sort(), 峰值: window.__peak };
      window.askConfirm = 替身; window.__estimate = null;
      return { 框, 弹框时已发, 报价请求, 取消后, 确认后 };
    })()`);
  ok(报价.框 && 报价.框.标题 === "将生成 5 张图，预计 ¥3.60，确认后开始扣费",
     "★一键补齐开跑前先弹确认，金额就是假服务器报的 ¥3.60★ 以前一点就全烧出去，花多少跑完才知道", 报价.框);
  ok(报价.框 && 报价.框.说明 === "另有 2 条价格未知" && 报价.框.取消 === "先不了" && 报价.框.确定 === "开始生成",
     "★估不出的那两条要说出来：「另有 2 条价格未知」★ 不能拿 ¥3.60 冒充整批的价", 报价.框);
  ok(报价.弹框时已发 === 0 && JSON.stringify(报价.报价请求) === JSON.stringify(Array(5).fill("generate_image")),
     "报价问的是这五条生图，框还开着的时候一枪没发", { 已发: 报价.弹框时已发, 报价请求: 报价.报价请求 });
  ok(报价.取消后.发了 === 0 && !报价.取消后.在跑 && !报价.取消后.框还在,
     "★点「先不了」：/api/tool/run 一个请求都没收到★", 报价.取消后);
  ok(报价.确认后.发了.length === 5 && new Set(报价.确认后.发了).size === 5,
     "点「开始生成」之后五条都发出去了", 报价.确认后.发了);
  ok(报价.确认后.峰值 === 2,
     "★同时在跑的最多 2 条（默认上限），也真是两条一起跑★ 以前没上限；峰值是 1 说明池子没起作用、一条一条排着", 报价.确认后.峰值);

  const 上限 = await run(`
    (async () => {
      const sel = document.querySelector("[data-canvas-batch-limit]");
      const 默认显示 = sel ? sel.value : null;
      if (sel) { sel.value = "1"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      let 存的 = null; try { 存的 = localStorage.getItem("openworkbuddy.canvas.batchLimit"); } catch {}
      // 换一张画布、重开画布页（内存里那份也清掉，只剩本机存的）：工具栏里还是 1，跑起来也是一条一条
      ${摆画布([镜头("c1", "甲一镜", 40), 镜头("c2", "甲二镜", 300), 镜头("c3", "甲三镜", 560)])}
      localStorage.setItem("openworkbuddy.canvas.batchLimit", 存的 || "");   // 摆画布那一下清了本机存储，照原样放回去
      canvasState.batchLimit = 0;
      await renderCanvasPage(); ${等(400)}
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      const 重开后显示 = (document.querySelector("[data-canvas-batch-limit]") || {}).value;
      window.__progress = { stages: [], shots: ["c1", "c2", "c3"].map((nodeId) => ({ nodeId, frame: null, video: null, audio: null })) };
      await canvasLoadProgress();
      window.__runs = []; window.__peak = 0; window.__inflight = 0; window.__runDelay = 100;
      await canvasRunPending("image");
      const 一条条 = { 发了: window.__runs.length, 峰值: window.__peak, 读到: canvasBatchLimit() };
      // 隐私窗口那种：localStorage 一碰就抛。读不到按默认 2，存不进去也照样按选的跑
      const 原读 = Storage.prototype.getItem, 原写 = Storage.prototype.setItem;
      Storage.prototype.getItem = () => { throw new Error("存储被禁用"); };
      Storage.prototype.setItem = () => { throw new Error("存储被禁用"); };
      let 坏存储 = null;
      try {
        canvasState.batchLimit = 0;
        const 读 = canvasBatchLimit();
        const 写 = canvasSetBatchLimit(3);
        坏存储 = { 读, 写, 写后读: canvasBatchLimit() };
      } catch (e) { 坏存储 = { 抛了: String(e && e.message || e) }; }
      finally { Storage.prototype.getItem = 原读; Storage.prototype.setItem = 原写; }
      const 越界 = [canvasSetBatchLimit(9), canvasSetBatchLimit(-3), canvasSetBatchLimit("abc")];
      canvasSetBatchLimit(2); window.__runDelay = 0; window.__progress = null;
      await canvasLoadProgress();
      return { 默认显示, 存的, 重开后显示, 一条条, 坏存储, 越界 };
    })()`);
  ok(上限.默认显示 === "2" && 上限.存的 === "1" && 上限.重开后显示 === "1",
     "★工具栏「同时跑」默认 2，改成 1 存进 localStorage，重开画布还是 1★", 上限);
  ok(上限.一条条.发了 === 3 && 上限.一条条.峰值 === 1 && 上限.一条条.读到 === 1,
     "★选了 1 就真是一条一条跑★ 对照上面的峰值 2：量法看得出区别", 上限.一条条);
  ok(上限.坏存储 && 上限.坏存储.读 === 2 && 上限.坏存储.写 === 3 && 上限.坏存储.写后读 === 3,
     "★localStorage 一碰就抛的时候：读按默认 2，写不进去也不抛、照样按选的跑★ 不然隐私窗口里一键补齐整个点不动", 上限.坏存储);
  ok(JSON.stringify(上限.越界) === "[4,1,2]", "上限夹在 1 到 4 之间，认不出的值按默认 2", 上限.越界);

  console.log("\n— 二十六、同参数再点生成：沿用上一版不扣费；「换一版」才带 no_cache、版本号 +1 —");
  const 复用 = await run(`
    (async () => {
      ${摆画布([号镜头("rs1", "S9-01", "灯塔夜景", 40)])}
      window.__bodies = []; window.__runs = []; window.__failRun = null; window.__echoName = true; window.__estimate = null;
      canvasState.versionTaken = new Map(); canvasState.assetsCheckedAt = 0;
      const 卡 = () => canvasState.graph.getCell("rs1");
      const 字 = () => ((document.querySelector("#owb-toast span") || {}).textContent) || "";
      const 发的 = () => window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => ({ 名: b.body.input.filename, 有no_cache: "no_cache" in b.body.input, no_cache: b.body.input.no_cache }));
      const 第一次结果 = await canvasGenerate(卡(), "image");
      const 第一枪 = 发的();
      window.__bodies = [];
      const 第二次结果 = await canvasGenerate(卡(), "image");
      const 同参数 = { 发了: 发的().length, 结果: 第二次结果, 提示: 字(),
        按钮: ((document.querySelector("#owb-toast .owb-toast-act") || {}).textContent) || "",
        首帧: (卡().get("canvasPayload") || {}).first_frame };
      // 检查器：「换一版首帧」旁边写着「会重新扣费」，「生成首帧」旁边挂着预估价
      canvasState.inspectorOpen = true; canvasSetSelection(new Set(["rs1"]), "rs1");
      const 框 = document.getElementById("canvas-inspector");
      const 到点 = Date.now() + 3000;
      while (Date.now() < 到点 && !((框.querySelector('[data-canvas-price="image"]') || {}).textContent)) ${等(50)}
      const 换 = 框.querySelector('[data-inspect-reroll="image"]');
      const 检查器 = { 有换一版: !!换, 按钮字: 换 ? 换.textContent.trim() : "", 旁注: 换 && 换.parentElement ? ((换.parentElement.querySelector("small") || {}).textContent || "") : "",
        价: ((框.querySelector('[data-canvas-price="image"]') || {}).textContent) || "" };
      window.__bodies = [];
      if (换) 换.click();
      const 到点2 = Date.now() + 4000;
      ${等(50)}
      while (Date.now() < 到点2 && (window.__bodies.length < 1 || canvasState.inflight.has("rs1"))) ${等(50)}
      const 换一版 = { 发的: 发的(), 首帧: (卡().get("canvasPayload") || {}).first_frame, 提示: 字() };
      // 进度接口问过盘、说卡上这个 v2 文件没了：同参数再点也得真生成，不能「沿用」一个不存在的文件
      window.__progress = { stages: [], shots: [{ nodeId: "rs1", frame: { path: "短剧/main/镜头_S9-01_首帧_v2.png", ok: false }, video: null, audio: null }] };
      await canvasLoadProgress();
      window.__bodies = [];
      const 丢了结果 = await canvasGenerate(卡(), "image");
      const 丢了 = { 结果: 丢了结果, 发的: 发的(), 首帧: (卡().get("canvasPayload") || {}).first_frame };
      window.__progress = null; await canvasLoadProgress();
      window.__echoName = false;
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 第一次结果, 第一枪, 同参数, 检查器, 换一版, 丢了 };
    })()`);
  ok(复用.第一次结果 && 复用.第一次结果.ok && 复用.第一枪.length === 1 && 复用.第一枪[0].名 === "镜头_S9-01_首帧_v1.png" && !复用.第一枪[0].有no_cache,
     "★第一次生成的请求体里不带 no_cache★ 以前写死 no_cache:true，服务端缓存永远用不上", 复用.第一枪);
  ok(复用.同参数.发了 === 0 && 复用.同参数.结果 && 复用.同参数.结果.ok && 复用.同参数.首帧 === "短剧/main/镜头_S9-01_首帧_v1.png",
     "★参数没变再点「生成」：一个请求都不发，卡片还是 v1★ 以前同一张图点几次付几次钱", 复用.同参数);
  ok(/没扣费/.test(复用.同参数.提示) && 复用.同参数.按钮 === "换一版",
     "★沿用的时候要说「没扣费」，并把「换一版」递到手边★ 点了没动静，人会以为坏了再点", 复用.同参数);
  ok(复用.检查器.有换一版 && 复用.检查器.按钮字 === "换一版首帧" && 复用.检查器.旁注 === "会重新扣费",
     "★检查器里有「换一版首帧」，旁边写着「会重新扣费」★", 复用.检查器);
  ok(复用.检查器.价 === "约 ¥0.30",
     "★「生成首帧」旁边挂着预估价，数字就是假服务器报的 ¥0.30★", 复用.检查器.价);
  ok(复用.换一版.发的.length === 1 && 复用.换一版.发的[0].no_cache === true && 复用.换一版.发的[0].名 === "镜头_S9-01_首帧_v2.png"
     && 复用.换一版.首帧 === "短剧/main/镜头_S9-01_首帧_v2.png",
     "★点「换一版」：请求体带 no_cache:true，文件名 v1 → v2，卡片换上新的★", 复用.换一版);
  ok(复用.丢了.结果 && 复用.丢了.结果.ok && 复用.丢了.发的.length === 1 && 复用.丢了.发的[0].名 === "镜头_S9-01_首帧_v3.png" && !复用.丢了.发的[0].有no_cache,
     "★卡上那个文件被进度接口判成没了：同参数再点照样真生成（v3），不拿不存在的文件冒充沿用★ 不然一键补齐每次都报做好了、那一镜永远缺", 复用.丢了);

  console.log("\n— 二十六之二、场景图同名覆盖：A 生过、改 B 生过、再改回 A，不能说「沿用」 —");
  const 覆盖 = await run(`
    (async () => {
      ${摆画布([{ id: "lc1", kind: "location", payload: { name: "灯塔", description: "海边灯塔，傍晚逆光，浪打礁石" }, position: { x: 40, y: 40 }, size: { width: 300, height: 200 } }])}
      window.__bodies = []; window.__runs = []; window.__failRun = null; window.__echoName = true; window.__estimate = null; window.__progress = null;
      const 卡 = () => canvasState.graph.getCell("lc1");
      const 发的 = () => window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => ({ 名: b.body.input.filename, no_cache: b.body.input.no_cache === true }));
      const 改 = (d) => 卡().set("canvasPayload", { ...(卡().get("canvasPayload") || {}), description: d });
      const 一枪 = async () => { window.__bodies = []; const r = await canvasGenerate(卡(), "image"); return { ok: !!(r && r.ok), 沿用: !!(r && r.reused), 发的: 发的() }; };
      const A1 = await 一枪();
      const A2 = await 一枪();
      改("海边灯塔，深夜暴雨，探照灯扫过海面"); const B = await 一枪();
      改("海边灯塔，傍晚逆光，浪打礁石"); const A3 = await 一枪();
      window.__echoName = false;
      await canvasFlushRemoteWrite(); ${等(200)}
      return { A1, A2, B, A3, 图: (卡().get("canvasPayload") || {}).image };
    })()`);
  ok(覆盖.A1.ok && 覆盖.A1.发的.length === 1 && !覆盖.A1.发的[0].no_cache && 覆盖.A2.沿用 && 覆盖.A2.发的.length === 0,
     "场景图第一次真生成、不带 no_cache；同参数再点沿用、一个请求都不发", 覆盖);
  ok(覆盖.A3.ok && !覆盖.A3.沿用 && 覆盖.A3.发的.length === 1,
     "★A→B→A：文件已被 B 覆盖，改回 A 必须真生成★ 不然卡上是 B 的图、提示却说「沿用，没扣费」", 覆盖.A3);
  ok(覆盖.B.发的.length === 1 && 覆盖.B.发的[0].no_cache && 覆盖.A3.发的[0] && 覆盖.A3.发的[0].no_cache,
     "★已有场景图、参数又对不上：请求带 no_cache★ 服务端缓存只看文件在不在，会把覆盖后的图当 A 递回来", { B: 覆盖.B, A3: 覆盖.A3 });

  console.log("\n— 二十七、失败补一枪用同一个模型；只有设置里排了备用顺序才换，换了要写明 —");
  const 补枪 = await run(`
    (async () => {
      ${摆画布([镜头("f1", "备胎镜头", 40)])}
      window.__bodies = []; window.__runs = []; window.__echoName = false;
      const 卡 = () => canvasState.graph.getCell("f1");
      const 字 = () => ((document.querySelector("#owb-toast span") || {}).textContent) || "";
      const 型号 = () => window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => b.body.input.model || "");
      // 只有「备用图模型」发得成
      window.__failRun = (first, body) => !(body && body.input && body.input.model === "备用图模型");
      const 原设置 = settingsCache.media_fallback;
      settingsCache.media_fallback = undefined;
      const 没排结果 = await canvasGenerate(卡(), "image");
      const 没排 = { 次数: window.__runs.length, 型号: 型号(), 结果: 没排结果, 提示: 字() };
      settingsCache.media_fallback = { image: ["备用图模型"] };
      window.__bodies = []; window.__runs = [];
      const 排了结果 = await canvasGenerate(卡(), "image");
      const runs = (卡().get("canvasPayload") || {}).generation_runs || [];
      const 排了 = { 次数: window.__runs.length, 型号: 型号(), 结果: 排了结果, 提示: 字(), 记录: runs.length ? runs[runs.length - 1] : null };
      settingsCache.media_fallback = 原设置; window.__failRun = null;
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 没排, 排了 };
    })()`);
  ok(补枪.没排.次数 === 2 && new Set(补枪.没排.型号).size === 1 && 补枪.没排.结果 && 补枪.没排.结果.ok === false && /生成失败/.test(补枪.没排.提示),
     "★没排备用顺序：同一个模型补一枪，还不成就报失败，不悄悄换模型★", 补枪.没排);
  ok(补枪.排了.次数 === 3 && 补枪.排了.型号[0] === 补枪.排了.型号[1] && 补枪.排了.型号[2] === "备用图模型" && 补枪.排了.结果 && 补枪.排了.结果.ok,
     "★排了备用顺序：同模型两枪都没成，才按顺序换成「备用图模型」★", 补枪.排了.型号);
  ok(/备用图模型/.test(补枪.排了.提示) && 补枪.排了.记录 && 补枪.排了.记录.fallbackFrom && 补枪.排了.记录.model === "备用图模型",
     "★换了模型要写明：提示里点名换成了哪个，生成记录里留着原来那个★", { 提示: 补枪.排了.提示, 记录: 补枪.排了.记录 && { model: 补枪.排了.记录.model, fallbackFrom: 补枪.排了.记录.fallbackFrom } });

  const 已下单 = await run(`
    (async () => {
      ${摆画布([镜头("f2", "已下单镜头", 40)])}
      const 卡 = () => canvasState.graph.getCell("f2");
      const 字 = () => ((document.querySelector("#owb-toast span") || {}).textContent) || "";
      const 原设置 = settingsCache.media_fallback;
      settingsCache.media_fallback = { image: ["备用图模型"] };
      const 工具失败 = (submitted) => ({ status: 200, body: { ok: false, isError: true, content: "工具执行出错: 视频生成超时" + (submitted ? "\\n上游已经收下这一单（任务号 vt-9）" : ""), submitted } });
      window.__bodies = []; window.__runs = [];
      window.__failRun = () => 工具失败("vt-9");
      const 结果 = await canvasGenerate(卡(), "image");
      const 带单号 = { 次数: window.__runs.length, 结果, 提示: 字() };
      window.__bodies = []; window.__runs = [];
      window.__failRun = () => 工具失败("");
      await canvasGenerate(卡(), "image");
      const 不带 = { 次数: window.__runs.length };
      settingsCache.media_fallback = 原设置; window.__failRun = null;
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 带单号, 不带 };
    })()`);
  ok(已下单.带单号.次数 === 1 && 已下单.带单号.结果 && 已下单.带单号.结果.ok === false && /任务号 vt-9/.test(已下单.带单号.提示),
     "★回执带 submitted（上游已经收下那一单）：不补枪、也不换备用模型，原话贴出来★ 补一枪等于再买一单", 已下单.带单号);
  ok(已下单.不带.次数 === 3, "反向对照：同样的工具失败不带 submitted，照常补枪、再按备用顺序换", 已下单.不带);

  console.log("\n— 二十八、滚轮：捏合 / 鼠标滚轮以光标为锚点缩放，双指滑动只平移 —");
  const 滚轮 = await run(`
    (async () => {
      ${摆画布([笔记("w1", "看这里", 40)])}
      const paper = canvasState.paper, world = document.getElementById("canvas-world");
      const r = world.getBoundingClientRect();
      const 光标 = { x: Math.round(r.left + r.width * 0.62), y: Math.round(r.top + r.height * 0.41) };
      const 滚 = (init) => { const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 光标.x, clientY: 光标.y, ...init }); world.dispatchEvent(e); return e.defaultPrevented; };
      const 偏 = (anchor) => { const p = paper.localToClientPoint(anchor); return Math.hypot(p.x - 光标.x, p.y - 光标.y); };
      const 平移 = () => { const t = paper.translate(); return { x: t.tx, y: t.ty }; };
      const out = {};
      // ① 触控板捏合（Chromium 报成 ctrl+wheel，像素模式、delta 小）
      let anchor = paper.clientToLocalPoint(光标), s0 = canvasState.scale;
      const 拦了 = 滚({ deltaY: -30, deltaMode: 0, ctrlKey: true });
      out.捏合 = { 前: s0, 后: canvasState.scale, 偏: 偏(anchor), 拦了 };
      // ② 普通鼠标滚轮（按行），不按键也缩放
      anchor = paper.clientToLocalPoint(光标); s0 = canvasState.scale;
      滚({ deltaY: 3, deltaMode: 1 });
      out.鼠标 = { 前: s0, 后: canvasState.scale, 偏: 偏(anchor) };
      // ③ 双指滑动（像素模式、没按键）：只平移
      s0 = canvasState.scale; const t0 = 平移();
      滚({ deltaX: 30, deltaY: 50, deltaMode: 0 });
      const t1 = 平移();
      out.滑动 = { 前: s0, 后: canvasState.scale, dx: t1.x - t0.x, dy: t1.y - t0.y };
      // 反向对照：不校正平移、以原点缩放，光标下那一点会跑——量法看得出来
      anchor = paper.clientToLocalPoint(光标);
      canvasZoom(document.getElementById("assist-page"), canvasState.scale * 1.3);
      out.对照偏 = 偏(anchor);
      canvasZoom(document.getElementById("assist-page"), 1); canvasState.x = 0; canvasState.y = 0; paper.translate(0, 0);
      return out;
    })()`);
  ok(滚轮.捏合.后 > 滚轮.捏合.前 && 滚轮.捏合.偏 <= 2 && 滚轮.捏合.拦了,
     "★触控板捏合（ctrl+wheel）放大，光标下那一点偏移不超过 2px★ 以前以左上角为原点，捏一下要找的东西就滑出去了", 滚轮.捏合);
  ok(滚轮.鼠标.后 < 滚轮.鼠标.前 && 滚轮.鼠标.偏 <= 2,
     "★鼠标滚轮（deltaMode=1）照旧缩放，同样以光标为锚点★", 滚轮.鼠标);
  ok(滚轮.滑动.后 === 滚轮.滑动.前 && 滚轮.滑动.dx === -30 && 滚轮.滑动.dy === -50,
     "★双指滑动（不带 ctrl 的像素滚动）只平移、不缩放★ 以前一律缩放，触控板没法平移", 滚轮.滑动);
  ok(滚轮.对照偏 > 2, "反向对照：以原点缩放时同一套量法量得出偏移——不是量法自己瞎了", 滚轮.对照偏);

  console.log("\n— 二十九、生成分镜表：先给人看草稿，点「放到画布上」才写盘；新建短剧表单；统一风格摆在提示词最前面 —");
  await run(STUB4);
  const 剧本卡 = (payload) => ({ id: "sc1", kind: "script", position: { x: 40, y: 40 }, size: { width: 340, height: 260 },
    payload: { title: "短剧剧本", text: "外卖小哥阿岚深夜送餐，在电梯里遇到迷路的老人，一路把他送回家，最后发现老人是自己失散多年的外公。", ...(payload || {}) } });
  // 轮询到条件成立（最多 ms 毫秒）。条件是页面里的一句表达式
  const 等到 = (cond, ms) => `await (async () => { const t = Date.now() + ${ms || 4000}; while (Date.now() < t && !(${cond})) await new Promise((r) => setTimeout(r, 30)); })();`;

  const 草稿 = await run(`
    (async () => {
      ${摆画布([剧本卡({ aspect: "9:16", shot_seconds: 6, style: "冷蓝夜色，胶片颗粒" })])}
      window.__drafts = []; window.__commits = []; window.__committed = null; window.__commit409 = false; window.__storyPuts = [];
      document.getElementById("canvas-draft-dialog")?.remove();
      const el = canvasState.graph.getCell("sc1").findView(canvasState.paper).el;
      const 钮 = el.querySelector("[data-canvas-draft]");
      const out = { 钮字: 钮 ? 钮.textContent.trim() : null, 成本: (el.querySelector(".canvas-script-cost") || {}).textContent || "" };
      if (钮) 钮.click();
      ${等到('document.getElementById("canvas-draft-dialog")')}
      ${等(200)}
      const box = document.getElementById("canvas-draft-dialog");
      // 这份草稿是花 token 买的：Esc 不许把它关掉
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      ${等(100)}
      return { ...out, 有框: !!box, Esc后还在: !!document.getElementById("canvas-draft-dialog"),
        行: box ? [...box.querySelectorAll("tr[data-draft-row]")].map((tr) => tr.querySelector('[data-draft-cell="id"]').value) : [],
        表头: box ? [...box.querySelectorAll("thead th")].map((th) => th.textContent.trim()).filter(Boolean) : [],
        AI: box ? box.querySelectorAll("tr[data-draft-row] .canvas-ai-badge").length : 0,
        用量: ((box && box.querySelector("[data-draft-usage]")) || {}).textContent || "",
        数: ((box && box.querySelector("[data-draft-count]")) || {}).textContent || "",
        风格框: ((box && box.querySelector("[data-draft-style]")) || {}).value,
        发的草稿: window.__drafts.map((b) => ({ script: b.script, aspect: b.aspect, shotSeconds: b.shotSeconds, style: b.style, canvas: b.canvas })),
        commit: window.__commits.length, 卡种: canvasState.graph.getElements().map((n) => canvasKind(n)) };
    })()`);
  ok(草稿.钮字 === "生成分镜表" && /消耗少量 token/.test(草稿.成本),
     "剧本卡上有「生成分镜表」，旁边写明用对话模型、要花少量 token", { 钮字: 草稿.钮字, 成本: 草稿.成本 });
  ok(草稿.有框 && 草稿.行.join(",") === "S1-01,S1-02" && 草稿.表头.join(",") === "镜头号,景别,画面,台词,时长",
     "★点了先出预览表★ 一镜一行：镜头号、景别、画面、台词、时长", { 行: 草稿.行, 表头: 草稿.表头 });
  ok(草稿.commit === 0 && 草稿.卡种.join(",") === "script",
     "★只出预览：一个 commit 都没发、画布上一张卡都没多★ 一步到位的话，模型拆坏的一版人还没看就把盘上那份盖了",
     { commit: 草稿.commit, 卡种: 草稿.卡种 });
  ok(草稿.发的草稿.length === 1 && 草稿.发的草稿[0].aspect === "9:16" && 草稿.发的草稿[0].shotSeconds === 6
     && 草稿.发的草稿[0].style === "冷蓝夜色，胶片颗粒" && /阿岚/.test(草稿.发的草稿[0].script) && 草稿.发的草稿[0].canvas === "main",
     "草稿请求带上剧本卡上的画幅、每镜时长、统一风格，只发一趟", 草稿.发的草稿);
  ok(草稿.AI === 2 && /300/.test(草稿.用量) && 草稿.数 === "1 场 2 镜" && 草稿.风格框 === "冷蓝夜色，胶片颗粒",
     "表里每一行标「AI 生成」，底下写这次用了多少 token；统一风格能在预览里改", { AI: 草稿.AI, 用量: 草稿.用量, 数: 草稿.数, 风格框: 草稿.风格框 });
  ok(草稿.Esc后还在, "★按 Esc 草稿不丢★ 花 token 买来的，手一滑没了还得再花一次", 草稿.Esc后还在);

  const 提交 = await run(`
    (async () => {
      const box = document.getElementById("canvas-draft-dialog");
      if (!box) return { 没框: true };
      const 格 = (row, cell) => box.querySelector('tr[data-draft-row="' + row + '"] [data-draft-cell="' + cell + '"]');
      // 时长填了负数：原地说哪一镜不对，不发 commit
      格("0:0", "duration").value = "-1";
      box.querySelector("[data-draft-commit]").click();
      ${等(100)}
      const 坏时长 = { 错: (box.querySelector("[data-draft-error]") || {}).textContent || "", commit: window.__commits.length };
      // 数字框里敲了认不出的「5e」：value 读出来是空串，不能当「没填」悄悄把时长删掉交上去
      const 时长格 = 格("0:0", "duration"); 时长格.value = ""; 时长格.focus(); document.execCommand("insertText", false, "5e");
      box.querySelector("[data-draft-error]").textContent = "";
      const 认不出 = { badInput: !!(时长格.validity && 时长格.validity.badInput), value: 时长格.value };
      box.querySelector("[data-draft-commit]").click();
      ${等(100)}
      认不出.错 = (box.querySelector("[data-draft-error]") || {}).textContent || ""; 认不出.commit = window.__commits.length;
      格("0:0", "duration").value = "5";
      格("0:0", "frame_prompt").value = "改过的画面：阿岚在电梯里摘下头盔"; 格("0:0", "frame_prompt").dispatchEvent(new Event("input", { bubbles: true }));
      格("0:0", "line").value = "您住几楼？我送您上去。"; 格("0:0", "line").dispatchEvent(new Event("input", { bubbles: true }));
      box.querySelector('tr[data-draft-row="0:1"] [data-draft-remove]').click();
      const 删后数 = (box.querySelector("[data-draft-count]") || {}).textContent || "";
      box.querySelector("[data-draft-commit]").click();
      ${等到('!document.getElementById("canvas-draft-dialog") && canvasState.graph.getElements().some((n) => canvasKind(n) === "shot")', 6000)}
      ${等(300)}
      const els = canvasState.graph.getElements(), 种 = (k) => els.filter((n) => canvasKind(n) === k);
      const shot = 种("shot")[0], sb = 种("storyboard")[0], sent = window.__commits[0] || null;
      return { 坏时长, 认不出, 删后数, commit数: window.__commits.length, mode: sent && sent.mode, 风格: sent && sent.draft.style,
        镜头: sent ? sent.draft.scenes.flatMap((s) => s.shots.map((x) => ({ id: x.id, 画面: x.frame_prompt, 台词: x.line }))) : [],
        框还在: !!document.getElementById("canvas-draft-dialog"),
        镜头卡: 种("shot").map((n) => ({ id: canvasPayload(n).id, ai: canvasPayload(n).ai_generated === true, prompt: canvasPayload(n).prompt })),
        角色卡AI: 种("character").map((n) => canvasPayload(n).ai_generated === true),
        场次卡AI: 种("scene").map((n) => canvasPayload(n).ai_generated === true),
        卡上徽标: shot ? shot.findView(canvasState.paper).el.querySelectorAll(".canvas-ai-badge").length : 0,
        剧本卡徽标: canvasState.graph.getCell("sc1").findView(canvasState.paper).el.querySelectorAll(".canvas-ai-badge").length,
        分镜表卡: sb ? { board: canvasPayload(sb).board, style: canvasPayload(sb).style, 连着剧本: canvasDraftTarget(canvasState.graph.getCell("sc1")) === sb } : null };
    })()`);
  ok(提交.坏时长 && 提交.坏时长.commit === 0 && /S1-01/.test(提交.坏时长.错) && /大于 0/.test(提交.坏时长.错),
     "时长填成负数：原地点名是哪一镜，一个 commit 都不发", 提交.坏时长);
  ok(提交.认不出 && 提交.认不出.badInput && 提交.认不出.value === "" && 提交.认不出.commit === 0 && /S1-01/.test(提交.认不出.错),
     "时长框里敲了认不出的「5e」（读出来是空串）：照样拦下点名，不当没填悄悄删掉时长", 提交.认不出);
  ok(提交.删后数 === "1 场 1 镜", "删掉一行，底下的镜头数跟着变", 提交.删后数);
  ok(提交.commit数 === 1 && 提交.mode === "new" && 提交.镜头.length === 1 && 提交.镜头[0].id === "S1-01"
     && 提交.镜头[0].画面 === "改过的画面：阿岚在电梯里摘下头盔" && 提交.镜头[0].台词 === "您住几楼？我送您上去。" && 提交.风格 === "冷蓝夜色，胶片颗粒",
     "★改过的格子原样进了 commit 请求体，删掉的那一镜（S1-02）不在里面★", { commit数: 提交.commit数, mode: 提交.mode, 镜头: 提交.镜头 });
  ok(!提交.框还在 && 提交.镜头卡.length === 1 && 提交.镜头卡[0].id === "S1-01" && 提交.镜头卡[0].ai,
     "写好之后草稿框关掉，按分镜表摆到画布上，镜头卡盖上 ai_generated", 提交.镜头卡);
  ok(提交.卡上徽标 === 1 && 提交.剧本卡徽标 === 0 && 提交.角色卡AI.length === 1 && 提交.角色卡AI.every(Boolean)
     && 提交.场次卡AI.length === 1 && 提交.场次卡AI.every(Boolean),
     "★模型出的卡（镜头、场次、角色）卡头写「AI 生成」，人写的剧本卡不写★", { 卡上徽标: 提交.卡上徽标, 剧本卡徽标: 提交.剧本卡徽标, 角色: 提交.角色卡AI, 场次: 提交.场次卡AI });
  ok(提交.分镜表卡 && 提交.分镜表卡.board === "短剧/main/分镜表.json" && 提交.分镜表卡.style === "冷蓝夜色，胶片颗粒" && 提交.分镜表卡.连着剧本,
     "剧本卡连出一张分镜表卡，指着刚写好的那份、记着它的统一风格", 提交.分镜表卡);

  const 撞 = await run(`
    (async () => {
      window.__commit409 = true; window.__commits = [];
      const 卡 = canvasState.graph.getCell("sc1"); canvasRefreshNode(卡);
      卡.findView(canvasState.paper).el.querySelector("[data-canvas-draft]").click();
      ${等到('document.getElementById("canvas-draft-dialog")')}
      ${等(200)}
      const box = document.getElementById("canvas-draft-dialog");
      box.querySelector("[data-draft-commit]").click();
      ${等到('document.getElementById("canvas-draft-choice")')}
      const 问 = document.getElementById("canvas-draft-choice");
      const 一 = { 有问: !!问, 按钮: 问 ? [...问.querySelectorAll("[data-canvas-choice]")].map((b) => b.dataset.canvasChoice + ":" + b.textContent.trim()) : [],
        主按钮: 问 ? 问.querySelectorAll(".ui-btn--brand").length : -1, 字: 问 ? 问.textContent : "", commit: window.__commits.map((b) => b.mode) };
      if (问) 问.querySelector('[data-canvas-choice="cancel"]').click();
      ${等(200)}
      const 二 = { 预览还在: !!document.getElementById("canvas-draft-dialog"), 问还在: !!document.getElementById("canvas-draft-choice"),
        commit: window.__commits.length, 能点: !box.querySelector("[data-draft-commit]").disabled };
      box.querySelector("[data-draft-commit]").click();
      ${等到('document.getElementById("canvas-draft-choice")')}
      document.querySelector('#canvas-draft-choice [data-canvas-choice="append"]')?.click();
      ${等到('!document.getElementById("canvas-draft-dialog")', 6000)}
      ${等(300)}
      const last = window.__commits[window.__commits.length - 1] || {};
      window.__commit409 = false;
      return { 一, 二, 三: { modes: window.__commits.map((b) => b.mode), base: last.baseUpdatedAt, name: last.name, 预览还在: !!document.getElementById("canvas-draft-dialog"),
        镜头卡: canvasState.graph.getElements().filter((n) => canvasKind(n) === "shot").map((n) => canvasPayload(n).id).sort() } };
    })()`);
  ok(撞.一.有问 && 撞.一.按钮.join(",") === "cancel:取消,replace:替换,append:追加" && 撞.一.主按钮 === 0 && /1 场 3 镜/.test(撞.一.字)
     && 撞.一.commit.join(",") === "new",
     "★盘上已有分镜表（409）：问追加 / 替换 / 取消，两个动作一样重、不替人挑★ 还写明现有几场几镜", 撞.一);
  ok(撞.二.预览还在 && !撞.二.问还在 && 撞.二.commit === 1 && 撞.二.能点,
     "选「取消」：什么都不再发，草稿还开着能接着改", 撞.二);
  ok(撞.三.modes.join(",") === "new,new,append" && 撞.三.base === 123 && 撞.三.name === "短剧/main/分镜表.json" && !撞.三.预览还在,
     "★选「追加」：带上 mode=append 和 409 回来的 updatedAt 再交一次★ 写的是分镜表卡指着的那一份", 撞.三);
  ok(撞.三.镜头卡.join(",") === "S1-01,S1-02",
     "再放一次按戳 upsert：S1-01 更新原卡、S1-02 新摆一张，不重复摆", 撞.三.镜头卡);

  const 风格 = await run(`
    (async () => {
      window.__bodies = []; window.__runs = []; window.__failRun = null; window.__echoName = false; window.__estimate = null; window.__progress = null; window.__storyPuts = [];
      const 发的 = () => window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => ({ 全文: String(b.body.input.prompt || ""), model: b.body.input.model || "" }));
      const 镜 = () => canvasState.graph.getElements().find((n) => canvasKind(n) === "shot" && canvasPayload(n).id === "S1-01");
      await canvasGenerate(镜(), "image");
      const 展开的 = 发的()[0] || null;
      // 检查器里改分镜表卡的统一风格：写回分镜表、镜头卡的提示词跟着换
      const sb = canvasState.graph.getElements().find((n) => canvasKind(n) === "storyboard");
      canvasState.selectedAll = false; canvasState.selectedIds = new Set([sb.id]); canvasState.selected = sb.id; canvasState.inspectorOpen = true; canvasRenderInspector(false);
      const 框 = document.querySelector('#canvas-inspector [data-inspect-key="style"]');
      const 原值 = 框 ? 框.value : null;
      if (框) { 框.value = "暖黄晨光"; 框.dispatchEvent(new Event("change", { bubbles: true })); }
      ${等到("window.__storyPuts.length > 0")}
      ${等(200)}
      const 镜们 = canvasState.graph.getElements().filter((n) => canvasKind(n) === "shot").map((n) => ({ prompt: canvasPayload(n).prompt, board_style: canvasPayload(n).board_style }));
      window.__bodies = []; window.__runs = [];
      await canvasGenerate(镜(), "image");
      const 改后 = 发的()[0] || null;
      canvasState.inspectorOpen = false; canvasState.selected = null; canvasState.selectedIds = new Set(); canvasRenderInspector(false);
      const put = window.__storyPuts[0] || null;
      return { 展开的, 原值, 回写: put && { name: put.name, style: put.data && put.data.style, 有场次: !!(put.data && Array.isArray(put.data.scenes)) }, 回写次数: window.__storyPuts.length, 镜们, 改后 };
    })()`);
  const 出现 = (text, word) => String(text || "").split(word).length - 1;
  ok(风格.展开的 && 风格.展开的.全文.split("\n")[0] === "冷蓝夜色，胶片颗粒" && 出现(风格.展开的.全文, "冷蓝夜色，胶片颗粒") === 1
     && 风格.展开的.全文.split("\n")[1] === "阿岚抱着外卖箱挤进电梯，灯管闪烁",
     "★展开出来的镜头生首帧：统一风格挪到提示词最前面，尾巴上那段不再说第二遍★", 风格.展开的);
  ok(风格.原值 === "冷蓝夜色，胶片颗粒" && 风格.回写次数 === 1 && 风格.回写 && 风格.回写.name === "短剧/main/分镜表.json"
     && 风格.回写.style === "暖黄晨光" && 风格.回写.有场次,
     "★检查器里改统一风格：写回分镜表的 style（整份 PUT，场次原样带着）★", { 原值: 风格.原值, 回写: 风格.回写, 次数: 风格.回写次数 });
  ok(风格.镜们.length === 2 && 风格.镜们.every((s) => s.board_style === "暖黄晨光" && s.prompt.endsWith("\n暖黄晨光") && !s.prompt.includes("冷蓝夜色")),
     "画布上这份表的镜头卡跟着换风格：老风格剥掉、新风格接上，不堆两段", 风格.镜们);
  ok(风格.改后 && 风格.改后.全文.split("\n")[0] === "暖黄晨光" && 出现(风格.改后.全文, "暖黄晨光") === 1,
     "改完再生首帧，提示词开头就是新风格", 风格.改后);

  const 去风格 = await run(`
    (async () => {
      window.__bodies = []; window.__runs = []; window.__failRun = null;
      const sb = canvasState.graph.getElements().find((n) => canvasKind(n) === "storyboard");
      const name = canvasPayload(sb).board;
      const 镜卡 = canvasState.graph.getElements().filter((n) => canvasKind(n) === "shot" && canvasPayload(n).board === name);
      // 同一份表换成没写统一风格的一版再摆一次（「替换」、再展开都走这条）：S1-01 换了画面，S1-02 画面空着
      const scenes = [];
      镜卡.forEach((n) => {
        const p = canvasPayload(n); let s = scenes.find((x) => x.id === p.board_scene);
        if (!s) scenes.push(s = { id: p.board_scene, shots: [] });
        s.shots.push({ id: p.board_shot, ...(p.id === "S1-01" ? { frame_prompt: "去掉风格后的画面" } : {}) });
      });
      canvasApplyBoardPlan(sb, canvasBoardPlan({ scenes }, name));
      const 镜们 = 镜卡.map((n) => ({ id: canvasPayload(n).id, prompt: canvasPayload(n).prompt, board_style: canvasPayload(n).board_style }));
      await canvasGenerate(镜卡.find((n) => canvasPayload(n).id === "S1-01"), "image");
      const 发 = window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => String(b.body.input.prompt || ""))[0] || "";
      return { 镜们, 发 };
    })()`);
  ok(去风格.镜们.length === 2 && 去风格.镜们.every((s) => s.board_style === undefined && !String(s.prompt || "").includes("暖黄晨光"))
     && 去风格.镜们.some((s) => s.id === "S1-02" && String(s.prompt || "").trim()),
     "★分镜表换成没写风格的一版再摆：镜头卡上的老 board_style 跟着摘掉，提示词尾巴上的老画风剥掉，画面本身留着★", 去风格.镜们);
  ok(去风格.发.split("\n")[0] === "去掉风格后的画面" && !去风格.发.includes("暖黄晨光"),
     "去掉风格之后再生首帧，提示词不再按老画风往前接", 去风格.发);

  const 手搓 = await run(`
    (async () => {
      ${摆画布([剧本卡({ style: "赛博霓虹，雨夜", image_model: "表单选的图模型" }), 镜头("h1", "阿岚推开天台的门", 360),
        { id: "c1", kind: "character", payload: { name: "阿岚", description: "二十出头的外卖员，黄色头盔" }, position: { x: 800, y: 40 }, size: { width: 300, height: 200 } },
        { id: "g1", kind: "image", payload: { title: "海报", prompt: "一张夜景海报" }, position: { x: 800, y: 420 }, size: { width: 300, height: 200 } }])}
      window.__bodies = []; window.__runs = []; window.__failRun = null; window.__echoName = false;
      const h = () => canvasState.graph.getCell("h1");
      await canvasGenerate(h(), "image");
      h().set("canvasPayload", { ...canvasPayload(h()), first_frame: "outputs/h1.png", motion_prompt: "她缓缓推门，镜头跟进" });
      await canvasGenerate(h(), "video");
      await canvasGenerate(canvasState.graph.getCell("c1"), "image");
      await canvasGenerate(canvasState.graph.getCell("g1"), "image");
      await canvasFlushRemoteWrite(); ${等(200)}
      return window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => ({ 行: String(b.body.input.prompt || "").split("\\n").slice(0, 2), model: b.body.input.model || "" }));
    })()`);
  ok(手搓.length === 4 && 手搓[0].行[0] === "赛博霓虹，雨夜" && 手搓[0].行[1] === "阿岚推开天台的门" && 手搓[0].model === "表单选的图模型",
     "★手搓的镜头生首帧：/api/tool/run 的提示词以剧本卡上的统一风格开头，模型用新建短剧时选的那个★", 手搓[0]);
  ok(手搓[1] && 手搓[1].行[0] === "赛博霓虹，雨夜" && 手搓[1].行[1] === "她缓缓推门，镜头跟进",
     "★生视频同样把统一风格摆在最前面★", 手搓[1]);
  ok(手搓[2] && /^角色定妆照/.test(手搓[2].行[0]),
     "反向对照：定妆照不套统一风格（它是后面每一镜的参考图，套上画风会把脸带偏）", 手搓[2]);
  ok(手搓[2] && 手搓[2].model === "表单选的图模型" && 手搓[3] && 手搓[3].model === "" && 手搓[3].行[0] === "一张夜景海报",
     "定妆照用新建短剧时选的图模型；反向对照：通用图片卡检查器写的是「跟随设置默认模型」，就不带短剧那个、也不套风格", { 定妆: 手搓[2], 通用: 手搓[3] });

  const 表单 = await run(`
    (async () => {
      const 原模型 = settingsCache.media_models;
      settingsCache.media_models = [{ cap: "image", model: "img-default", name: "默认图模型", default: true }, { cap: "image", model: "img-2" }, { cap: "video", model: "vid-1" }];
      const p = window.__realAskNewBoardName();
      ${等到('document.getElementById("canvas-create-board-dialog")')}
      ${等到('(document.querySelector("#canvas-create-board-dialog [data-drama-price=image]") || {}).textContent', 3000)}
      const box = document.getElementById("canvas-create-board-dialog"), q = (s) => box.querySelector(s);
      const 默认 = { 标题: (q("b") || {}).textContent, 画幅: q('select[name="aspect"]').value, 时长: q('input[name="shotSeconds"]').value,
        风格: q('input[name="style"]').value, 图模型: q('select[name="imageModel"]').value, 图模型字: q('select[name="imageModel"] option').textContent,
        图价: q('[data-drama-price="image"]').textContent };
      q("[data-canvas-create-cancel]").click();
      const 取消回 = await p;
      const p2 = window.__realAskNewBoardName();
      ${等到('document.getElementById("canvas-create-board-dialog")')}
      const box2 = document.getElementById("canvas-create-board-dialog"), q2 = (s) => box2.querySelector(s);
      q2('input[name="canvasName"]').value = "外卖小哥第1集";
      q2('input[name="shotSeconds"]').value = "0";
      q2('button[type="submit"]').click();
      ${等(50)}
      const 报错 = (q2(".canvas-create-board-error") || {}).textContent || "", 还开着 = !!document.getElementById("canvas-create-board-dialog");
      q2('input[name="shotSeconds"]').value = "4";
      q2('input[name="style"]').value = "  冷蓝夜色  ";
      q2('select[name="imageModel"]').value = "img-2";
      q2('button[type="submit"]').click();
      const 填的 = await p2;
      settingsCache.media_models = 原模型;
      // 表单填的交给新画布起手那张剧本卡
      canvasAskNewBoardName = async () => 填的;
      await canvasCreateBoard();
      ${等(700)}
      if (canvasState.remoteTimer) { clearInterval(canvasState.remoteTimer); canvasState.remoteTimer = null; }
      canvasAskNewBoardName = async () => "分镜";
      const 剧本 = canvasState.graph.getElements().filter((n) => canvasKind(n) === "script").map((n) => canvasPayload(n));
      return { 默认, 取消回, 报错, 还开着, 填的, 画布: canvasState.canvasName, 设定: canvasDramaSettings(),
        剧本: 剧本.map((p) => ({ aspect: p.aspect, shot_seconds: p.shot_seconds, style: p.style, image_model: p.image_model, video_model: p.video_model })) };
    })()`);
  ok(表单.默认.标题 === "新建短剧" && 表单.默认.画幅 === "9:16" && 表单.默认.时长 === "5" && 表单.默认.风格 === "",
     "★新建短剧表单：画幅默认 9:16、每镜时长默认 5 秒、统一风格默认空着★", 表单.默认);
  ok(表单.默认.图模型 === "" && /img-default/.test(表单.默认.图模型字) && /单价.*0\.3/.test(表单.默认.图价),
     "生成模型默认沿用设置里那个（写明是哪个），旁边写单价", 表单.默认);
  ok(表单.取消回 === "", "点取消回空，不建画布", 表单.取消回);
  ok(表单.还开着 && /1 到 60/.test(表单.报错), "每镜时长填 0：表单不关，原地说清范围", { 还开着: 表单.还开着, 报错: 表单.报错 });
  ok(表单.填的 && 表单.填的.name === "外卖小哥第1集" && 表单.填的.aspect === "9:16" && 表单.填的.shotSeconds === 4 && 表单.填的.style === "冷蓝夜色" && 表单.填的.imageModel === "img-2" && 表单.填的.videoModel === "",
     "点创建：回整张表单（风格去掉首尾空格）", 表单.填的);
  ok(表单.画布 === "外卖小哥第1集" && 表单.剧本.length === 1 && 表单.剧本[0].aspect === "9:16" && 表单.剧本[0].shot_seconds === 4
     && 表单.剧本[0].style === "冷蓝夜色" && 表单.剧本[0].image_model === "img-2" && !表单.剧本[0].video_model
     && 表单.设定.style === "冷蓝夜色" && 表单.设定.shotSeconds === 4,
     "★建好的画布上，起手那张剧本卡记着表单填的画幅、时长、风格、模型★ 没选的视频模型不写（写空串就成了「明说不要」）", { 剧本: 表单.剧本, 设定: 表单.设定 });

  // ———— 第三十节起：底部时间线、连播预览、角色面板、⌘F、合成完成的系统通知 ————
  // 同一张戏：四镜故意按「S2-02、S1-01、S2-01、S1-02」从上往下摆——画布上的摆法跟放映顺序对不上，
  // 时间线要是照着摆法排，一眼就露馅。每镜 0.3 秒，连播一趟一两秒就放完
  const 戏镜 = (nodeId, shotId, y, extra) => 号镜头(nodeId, shotId, shotId + " 的画面", y,
    { board: "ep1", board_scene: shotId.split("-")[0], board_shot: shotId, duration: "0.3", ...(extra || {}) });
  const 一集 = 摆画布([
    戏镜("t1", "S2-02", 40, { first_frame: "短剧/main/S2-02.png", video: "短剧/main/S2-02.mp4", line: "收工了", cast: [] }),
    戏镜("t2", "S1-01", 300, { first_frame: "短剧/main/S1-01.png", video: "短剧/main/S1-01.mp4", audio: "短剧/main/S1-01.wav", line: "师傅，几楼？", cast: ["A"] }),
    戏镜("t3", "S2-01", 560, { video: "短剧/main/S2-01.mp4", line: "外卖放门口", cast: ["B"] }),
    戏镜("t4", "S1-02", 820, { first_frame: "短剧/main/S1-02.png", line: "对白或旁白…", cast: [] }),
    { id: "cA", kind: "character", payload: { id: "A", name: "阿岚", board: "ep1", board_character: "A", reference: "短剧/main/角色_阿岚_定妆.png" }, position: { x: 600, y: 40 }, size: { width: 280, height: 200 } },
    { id: "cB", kind: "character", payload: { id: "B", name: "老周", board: "ep1", board_character: "B" }, position: { x: 600, y: 400 }, size: { width: 280, height: 200 } },
  ], [{ source: { id: "cA" }, target: { id: "t2" }, relation: "character" }]);
  // 制片进度（服务端逐个问过盘）：S2-01 卡上记着视频，盘上那个文件已经没了
  const 一集进度 = JSON.stringify({ stages: [], shots: [
    { id: "S2-02", nodeId: "t1", needsVoice: true, frame: { path: "短剧/main/S2-02.png", ok: true }, video: { path: "短剧/main/S2-02.mp4", ok: true }, audio: null },
    { id: "S1-01", nodeId: "t2", needsVoice: true, frame: { path: "短剧/main/S1-01.png", ok: true }, video: { path: "短剧/main/S1-01.mp4", ok: true }, audio: { path: "短剧/main/S1-01.wav", ok: true } },
    { id: "S2-01", nodeId: "t3", needsVoice: true, frame: null, video: { path: "短剧/main/S2-01.mp4", ok: false }, audio: null },
    { id: "S1-02", nodeId: "t4", needsVoice: false, frame: { path: "短剧/main/S1-02.png", ok: true }, video: null, audio: null },
  ] });

  console.log("\n— 三十、时间线：按分镜表的顺序排，缺素材的格子挂红点，点一格定位到那个节点 —");
  const 时间线 = await run(`
    (async () => {
      ${一集}
      window.__progress = ${一集进度};
      await canvasLoadProgress();
      const box = document.getElementById("canvas-timeline");
      const cells = [...box.querySelectorAll("[data-ctl-shot]")];
      const 顺序 = cells.map((c) => c.querySelector(".ctl-cap b").textContent);
      const 红点 = cells.filter((c) => c.querySelector(".ctl-dot")).map((c) => c.querySelector(".ctl-cap b").textContent);
      const 提示 = Object.fromEntries(cells.map((c) => [c.querySelector(".ctl-cap b").textContent, c.title]));
      const 表头 = box.querySelector(".ctl-head").textContent;
      const 缩略图 = cells.filter((c) => c.querySelector(".ctl-thumb img")).length;
      box.querySelector('[data-ctl-shot="t3"]').click();
      ${等(100)}
      const 选中 = [...canvasState.selectedIds];
      const 格子亮 = [...box.querySelectorAll(".ctl-cell.is-selected")].map((c) => c.dataset.ctlShot);
      // 收起再展开：收起时整条只剩表头，本机记下开合
      box.querySelector("[data-ctl-toggle]").click();
      const 收起 = { 格子: box.querySelectorAll("[data-ctl-shot]").length, 记下: localStorage.getItem("openworkbuddy.canvas.timeline") };
      box.querySelector("[data-ctl-toggle]").click();
      const 展开 = box.querySelectorAll("[data-ctl-shot]").length;
      // 反向对照：画布上一个镜头都没有（不是短剧），整条时间线不出现
      ${摆画布([笔记("tn1", "随手记", 40)])}
      ${等(300)}
      const 空画布藏起 = document.getElementById("canvas-timeline").hidden;
      return { 顺序, 红点, 提示, 表头, 缩略图, 选中, 格子亮, 收起, 展开, 空画布藏起 };
    })()`);
  ok(JSON.stringify(时间线.顺序) === JSON.stringify(["S1-01", "S1-02", "S2-01", "S2-02"]),
     "★时间线按分镜表的镜头号排：S1-01、S1-02、S2-01、S2-02★ 画布上是从上往下 S2-02、S1-01、S2-01、S1-02 摆的，照摆法排就错了", 时间线.顺序);
  ok(JSON.stringify(时间线.红点) === JSON.stringify(["S1-02", "S2-01", "S2-02"]) && /3 镜缺素材/.test(时间线.表头),
     "★红点数对得上：三镜缺东西就三个红点，表头写「3 镜缺素材」★ 全齐的 S1-01 不挂", { 红点: 时间线.红点, 表头: 时间线.表头 });
  ok(/缺首帧/.test(时间线.提示["S2-01"]) && /缺视频/.test(时间线.提示["S2-01"]) && /缺配音/.test(时间线.提示["S2-01"]),
     "★S2-01 卡上记着视频、盘上已经没了：按进度接口的「盘上没有」算缺★ 光看卡上有没有路径就会漏掉它", 时间线.提示["S2-01"]);
  ok(/缺视频/.test(时间线.提示["S1-02"]) && !/缺配音/.test(时间线.提示["S1-02"]) && /缺配音/.test(时间线.提示["S2-02"]) && !/缺首帧/.test(时间线.提示["S2-02"]),
     "缺什么按成片要什么算：台词还是占位那句的不算缺配音；有了视频不算缺首帧", 时间线.提示);
  ok(/4 镜/.test(时间线.表头) && /1\.2 秒/.test(时间线.表头) && 时间线.缩略图 === 3,
     "表头写总镜数和总时长；有首帧的三格带缩略图", { 表头: 时间线.表头, 缩略图: 时间线.缩略图 });
  ok(JSON.stringify(时间线.选中) === JSON.stringify(["t3"]) && JSON.stringify(时间线.格子亮) === JSON.stringify(["t3"]),
     "★点一格就定位到那个节点：画布上选中它，格子也亮起来★", { 选中: 时间线.选中, 格子亮: 时间线.格子亮 });
  ok(时间线.收起.格子 === 0 && 时间线.收起.记下 === "0" && 时间线.展开 === 4,
     "时间线能收起（只剩表头、本机记下），再点展开回来", { 收起: 时间线.收起, 展开: 时间线.展开 });
  ok(时间线.空画布藏起 === true, "反向对照：画布上没有镜头，整条时间线不出现", 时间线.空画布藏起);

  console.log("\n— 三十一、连播预览：只放本机已有的视频和配音，缺视频的拿首帧顶上，一枪生成都不发 —");
  const 连播 = await run(`
    (async () => {
      ${一集}
      window.__progress = ${一集进度};
      await canvasLoadProgress();
      window.__runs = []; window.__bodies = [];
      const 发过 = [], 原 = window.fetch;
      window.fetch = function (u) { 发过.push(String(u)); return 原.apply(this, arguments); };
      document.querySelector("#canvas-timeline [data-ctl-play]").click();
      const 开了 = !!document.getElementById("canvas-playback");
      for (let i = 0; i < 100 && !(canvasState.playback && canvasState.playback.ended); i++) ${等(100)}
      const pb = canvasState.playback;
      const 放过 = pb ? pb.played.map((x) => x.id + ":" + x.mode) : null;
      const 放完 = !!(pb && pb.ended) && /放完了/.test(document.getElementById("canvas-playback").textContent);
      window.fetch = 原;
      // Esc 关掉：在画布页截住，不冒到全局那条「停下正在跑的任务」
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      ${等(50)}
      const 关了 = !document.getElementById("canvas-playback") && canvasState.playback === null;
      // 双击某一格：从那一镜开始放
      document.querySelector('#canvas-timeline [data-ctl-shot="t3"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      ${等(50)}
      const 从这镜 = canvasState.playback ? canvasState.playback.played.map((x) => x.id) : null;
      canvasPlaybackStop();
      return { 开了, 放过, 放完, 关了, 从这镜, 生成: 发过.filter((u) => /\\/api\\/(tool\\/(run|estimate)|canvas\\/compose|drama\\/)/.test(u)), 跑过: window.__runs.length };
    })()`);
  ok(连播.开了 && 连播.放完, "点「连播预览」弹出播放层，一路放到「放完了」", 连播);
  ok(JSON.stringify(连播.放过) === JSON.stringify(["S1-01:video", "S1-02:frame", "S2-01:empty", "S2-02:video"]),
     "★按时间线顺序一镜接一镜：有视频放视频；S1-02 没视频拿首帧静帧顶这一镜的时长；S2-01 视频丢了就黑一格照样占时长★", 连播.放过);
  ok(连播.生成.length === 0 && 连播.跑过 === 0,
     "★连播一次 /api/tool/run 都不调（也不估价、不合成）★ 花钱之前先看一眼顺不顺，这一眼自己不能花钱", { 生成: 连播.生成, 跑过: 连播.跑过 });
  ok(连播.关了, "Esc 关掉播放层，停掉在响的声音", 连播.关了);
  ok(连播.从这镜 && 连播.从这镜[0] === "S2-01", "双击一格从那一镜开始放", 连播.从这镜);

  console.log("\n— 三十二、角色面板：出场了但没挂参考图的镜头标出来，一键挂上就连线、出场角色写回分镜表 —");
  const 角色 = await run(`
    (async () => {
      ${一集}
      window.__progress = ${一集进度};
      await canvasLoadProgress();
      document.querySelector("#canvas-timeline [data-ctl-cast]").click();
      const panel = document.querySelector("#canvas-timeline .ctl-cast");
      const 行 = [...panel.querySelectorAll(".ctl-cast-row")].map((r) => ({
        名: r.querySelector(".ctl-cast-name b").textContent, 照片: !!r.querySelector(".ctl-cast-photo img"),
        照片字: r.querySelector(".ctl-cast-photo").textContent, 松: [...r.querySelectorAll(".ctl-chip.is-loose")].map((c) => c.querySelector("button").textContent),
        挂着: [...r.querySelectorAll("button.ctl-chip")].map((c) => c.textContent) }));
      const 表头 = panel.querySelector(".ctl-cast-head").textContent;
      const 连着 = () => canvasState.graph.getLinks().filter((l) => canvasEndpointId(l.get("source")) === "cB" && canvasEndpointId(l.get("target")) === "t3");
      const 挂前 = 连着().length;
      window.__bodies = [];
      panel.querySelector('[data-ctl-attach="cB"][data-ctl-attach-shot="t3"]').click();
      ${等(600)}
      const 线 = 连着();
      const 回写 = window.__bodies.filter((b) => b.url === "/api/drama/storyboard/output").map((b) => b.body);
      const 挂后松 = document.querySelectorAll("#canvas-timeline .ctl-chip.is-loose").length;
      const 挂后表头 = document.querySelector("#canvas-timeline .ctl-cast-head").textContent;
      canvasState.castOpen = false; canvasRenderTimeline();
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 行, 表头, 挂前, 挂后: 线.length, 关系: 线[0] ? 线[0].get("canvasRelation") : null, 回写, 挂后松, 挂后表头 };
    })()`);
  const 阿岚 = 角色.行.find((r) => r.名 === "阿岚"), 老周 = 角色.行.find((r) => r.名 === "老周");
  ok(阿岚 && 阿岚.照片 && JSON.stringify(阿岚.挂着) === JSON.stringify(["S1-01"]) && 阿岚.松.length === 0,
     "角色面板列出定妆照和出场镜头：阿岚在 S1-01，线已经连着", 阿岚);
  ok(老周 && !老周.照片 && /没有定妆照/.test(老周.照片字) && JSON.stringify(老周.松) === JSON.stringify(["S2-01"]) && /1 镜没挂参考图/.test(角色.表头),
     "★老周在分镜表里出场 S2-01、画布上却没连线：标成「出场了但没挂参考图」，表头写「1 镜没挂参考图」★", { 老周, 表头: 角色.表头 });
  ok(角色.挂前 === 0 && 角色.挂后 === 1 && 角色.关系 === "character",
     "★点「挂上」之后画布上出现一条 老周 → S2-01 的「角色」连线★ 走的是 canvasConnect，跟人手拖出来的同一种线", 角色);
  ok(角色.回写.length === 1 && 角色.回写[0].name === "ep1" && 角色.回写[0].shot === "S2-01" && 角色.回写[0].scene === "S2"
     && JSON.stringify(角色.回写[0].fields) === JSON.stringify({ cast: ["B"] }),
     "★连上之后由 canvasBoardCastSync 把出场角色写回分镜表那一镜★ 只写 cast 这一个字段", 角色.回写);
  ok(角色.挂后松 === 0 && !/没挂参考图/.test(角色.挂后表头), "挂上以后面板里不再标红", { 松: 角色.挂后松, 表头: 角色.挂后表头 });

  console.log("\n— 三十三、⌘F / Ctrl+F：按标题、台词、镜头号找节点，回车一个一个定位 —");
  const 搜索 = await run(`
    (async () => {
      ${一集}
      const 按 = (el, init) => el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      const 有对话搜索 = !!document.getElementById("chat-search");
      const 没拦 = 按(document.body, { key: "f", code: "KeyF", metaKey: SC_MAC, ctrlKey: !SC_MAC });
      ${等(50)}
      const bar = document.getElementById("canvas-find"), input = bar.querySelector("input");
      const 开了 = !bar.hidden, 焦点 = document.activeElement === input;
      const cs = document.getElementById("chat-search");
      const 对话搜索开了 = !!cs && !有对话搜索 || !!(cs && cs.offsetParent);
      const 数 = () => bar.querySelector("[data-canvas-find-count]").textContent;
      const 搜 = (q) => { input.value = q; input.dispatchEvent(new Event("input", { bubbles: true })); return 数(); };
      const 回车 = (shift) => { 按(input, { key: "Enter", shiftKey: !!shift }); return [...canvasState.selectedIds].join(","); };
      const 镜头号 = { 数: 搜("s2-01"), 选中: 回车(), 位置: 数() };
      const 台词 = { 数: 搜("几楼"), 选中: 回车() };
      const 标题 = { 数: 搜("老周"), 选中: 回车() };
      const 一串 = { 数: 搜("S1-"), 走: [回车(), 回车(), 回车(), 回车(true)] };
      const 占位 = 搜("旁白");
      const 没有 = 搜("压根没这个词");
      按(input, { key: "Escape" });
      ${等(50)}
      return { 没拦, 开了, 焦点, 对话搜索开了, 镜头号, 台词, 标题, 一串, 占位, 没有, 关了: bar.hidden };
    })()`);
  ok(搜索.没拦 === false && 搜索.开了 && 搜索.焦点 && !搜索.对话搜索开了,
     "★画布页上按 ⌘F（Windows 是 Ctrl+F）弹出的是找节点的搜索条，光标落在输入框里★ 不是对话记录那条", 搜索);
  ok(搜索.镜头号.数 === "1 个" && 搜索.镜头号.选中 === "t3" && 搜索.镜头号.位置 === "1/1",
     "★按镜头号找（不分大小写）：回车定位到 S2-01 那个节点★", 搜索.镜头号);
  ok(搜索.台词.选中 === "t2" && 搜索.标题.选中 === "cB", "按台词、按标题（角色名）也找得到", { 台词: 搜索.台词, 标题: 搜索.标题 });
  ok(搜索.一串.数 === "2 个" && JSON.stringify(搜索.一串.走) === JSON.stringify(["t2", "t4", "t2", "t4"]),
     "★命中多个时按放映顺序排，回车一个一个走、走到头绕回来，Shift+回车往回走★", 搜索.一串);
  ok(搜索.占位 === "没找到" && 搜索.没有 === "没找到",
     "反向对照：台词还是占位那句（对白或旁白…）的不算命中；搜不到就说没找到", { 占位: 搜索.占位, 没有: 搜索.没有 });
  ok(搜索.关了 === true, "Esc 关掉搜索条", 搜索.关了);

  console.log("\n— 三十四、合成完了人不在跟前：发一条系统通知「第10集已合成，点开查看」；人在就不发 —");
  const 通知 = await run(`
    (async () => {
      ${一集}
      const 发的 = [], 原通知 = window.Notification;
      window.Notification = class { constructor(title, opts) { 发的.push({ title, body: opts && opts.body }); } close() {} static requestPermission() { return Promise.resolve("granted"); } };
      window.Notification.permission = "granted";
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      canvasState.canvasList = [{ name: "main", title: "第10集" }];
      const 跑一趟 = async (不在跟前) => {
        document.hasFocus = () => !不在跟前;
        window.__composeDone = { id: "job1", done: true, at: 3, total: 3, steps: [], output: "短剧/main/成片/第10集.mp4" };
        canvasState.composeJob = { id: "job1", done: false, at: 1, total: 3, steps: [] };
        canvasComposePoll();
        ${等(1700)}
        clearTimeout(canvasState.composeTimer);
        return 发的.length;
      };
      const 切走了 = await 跑一趟(true);
      const 在跟前 = await 跑一趟(false);
      window.Notification.permission = "denied";
      const 拒过 = await 跑一趟(true);
      window.Notification = 原通知;
      delete document.hidden; delete document.hasFocus;
      window.__composeDone = null; canvasState.composeJob = null; canvasRenderProgress();
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 切走了, 在跟前, 拒过, 发的 };
    })()`);
  const 那条 = 通知.发的[0] || {};
  ok(通知.切走了 === 1 && 那条.title === "第10集已合成，点开查看",
     "★窗口失焦时合成完成：调了一次 Notification，标题「第10集已合成，点开查看」★", 通知);
  ok(String(那条.title || "").length <= 70 && String(那条.body || "").length <= 70 && 那条.body === "第10集.mp4",
     "通知文案不超过 70 字，正文写成片文件名", 那条);
  ok(通知.在跟前 === 1 && 通知.拒过 === 1,
     "反向对照：人就在窗口前不发（toast 够了）；用户拒过通知权限也不发", { 在跟前: 通知.在跟前, 拒过: 通知.拒过 });

  console.log("\n— 三十五、复审补的三条：删线就是「这一镜没他」、连播层的按键不漏到身后画布、通知按发起合成的那张画布起名 —");
  const 复审 = await run(`
    (async () => {
      ${一集}
      window.__progress = ${一集进度};
      await canvasLoadProgress();
      // ① 人手删掉 阿岚 → S1-01 那条线：分镜表写回 cast 空，镜头卡上展开时抄的那份 cast 也得跟着摘掉，
      //    不然角色面板照旧标「出场了但没挂参考图」，一点「全部挂上」就把人刚删的线接回去
      window.__bodies = [];
      canvasState.graph.getLinks().find((l) => canvasEndpointId(l.get("source")) === "cA" && canvasEndpointId(l.get("target")) === "t2").remove();
      ${等(600)}
      const 卡上 = (canvasState.graph.getCell("t2").get("canvasPayload") || {}).cast;
      const 删线回写 = window.__bodies.filter((b) => b.url === "/api/drama/storyboard/output").map((b) => b.body);
      canvasState.castOpen = true; canvasRenderTimeline();
      const 阿岚行 = [...document.querySelectorAll("#canvas-timeline .ctl-cast-row")].find((r) => r.querySelector(".ctl-cast-name b").textContent === "阿岚");
      const 阿岚松 = 阿岚行 ? [...阿岚行.querySelectorAll(".ctl-chip.is-loose")].length : -1;
      const 表头 = document.querySelector("#canvas-timeline .ctl-cast-head").textContent;
      // 反向对照：老周那条本来就没连过（分镜表里写着出场），照旧标出来
      const 老周行 = [...document.querySelectorAll("#canvas-timeline .ctl-cast-row")].find((r) => r.querySelector(".ctl-cast-name b").textContent === "老周");
      const 老周松 = 老周行 ? [...老周行.querySelectorAll(".ctl-chip.is-loose")].map((c) => c.querySelector("button").textContent) : null;
      canvasState.castOpen = false; canvasRenderTimeline();
      // ② 连播层开着、身后画布有选中的卡：Backspace / ⌘F 都不许漏到身后
      canvasSetSelection(["t1"]);
      canvasPlaybackStart();
      const box = document.getElementById("canvas-playback");
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: SC_MAC, ctrlKey: !SC_MAC, bubbles: true, cancelable: true }));
      ${等(50)}
      const 卡还在 = !!canvasState.graph.getCell("t1");
      const 搜索条藏着 = document.getElementById("canvas-find").hidden;
      canvasPlaybackStop();
      // ③ 合成跑到一半人切去了别的画布：通知报的是发起合成的那一集，不是眼下开着的这一张
      const 原通知 = window.Notification, 发的 = [];
      window.Notification = class { constructor(title, opts) { 发的.push({ title, body: opts && opts.body }); } close() {} };
      window.Notification.permission = "granted";
      document.hasFocus = () => false;
      canvasState.canvasList = [{ name: "ep9", title: "第9集" }, { name: "main", title: "第10集" }];
      canvasComposeNotify({ id: "job9", name: "ep9", done: true, output: "短剧/ep9/成片/第9集.mp4" });
      window.Notification = 原通知; delete document.hasFocus;
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 卡上, 删线回写, 阿岚松, 表头, 老周松, 卡还在, 搜索条藏着, 通知: 发的 };
    })()`);
  ok(Array.isArray(复审.卡上) && 复审.卡上.length === 0 && 复审.阿岚松 === 0,
     "★删掉 阿岚 → S1-01 的线：镜头卡上的 cast 跟着摘掉，角色面板不再把 S1-01 标成「没挂参考图」★ 不摘的话一点「全部挂上」就把人刚删的线接回去", 复审);
  ok(复审.删线回写.length === 1 && 复审.删线回写[0].shot === "S1-01" && JSON.stringify(复审.删线回写[0].fields) === JSON.stringify({ cast: [] }),
     "删线那一下分镜表照旧由 castWatch 写回（cast 空），卡上跟表上说的是同一件事", 复审.删线回写);
  ok(JSON.stringify(复审.老周松) === JSON.stringify(["S2-01"]) && /1 镜没挂参考图/.test(复审.表头),
     "反向对照：从没连过线的老周 → S2-01 照旧标出来", { 老周松: 复审.老周松, 表头: 复审.表头 });
  ok(复审.卡还在 && 复审.搜索条藏着,
     "★连播层开着时 Backspace 不删身后选中的卡、⌘F 不在播放层底下开搜索条★", { 卡还在: 复审.卡还在, 搜索条藏着: 复审.搜索条藏着 });
  ok(复审.通知.length === 1 && 复审.通知[0].title === "第9集已合成，点开查看",
     "★合成中途切去了别的画布：通知按 job.name 报「第9集」，不是眼下开着的「第10集」★", 复审.通知);

  const 复审二 = await run(`
    (async () => {
      // ④ 镜头号认不出场次（「开场」「收尾」）的按画布上的摆法排：拖一下，时间线跟着换顺序
      ${摆画布([号镜头("u1", "开场", "开场的画面", 40, { duration: "2" }), 号镜头("u2", "收尾", "收尾的画面", 300, { duration: "2" })])}
      ${等(300)}
      const 格 = () => [...document.querySelectorAll("#canvas-timeline [data-ctl-shot]")].map((c) => c.dataset.ctlShot);
      const 拖前 = 格();
      canvasState.graph.getCell("u1").position(40, 700);
      ${等(400)}
      const 拖后 = 格();
      // ⑤ 在画布上选了另一张卡：时间线上亮的那格跟着换，不留在上一格
      document.querySelector('#canvas-timeline [data-ctl-shot="u1"]').click();
      ${等(100)}
      canvasSetSelection(["u2"]);
      const 亮 = [...document.querySelectorAll("#canvas-timeline .ctl-cell.is-selected")].map((c) => c.dataset.ctlShot);
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 拖前, 拖后, 亮 };
    })()`);
  ok(JSON.stringify(复审二.拖前) === JSON.stringify(["u1", "u2"]) && JSON.stringify(复审二.拖后) === JSON.stringify(["u2", "u1"]),
     "★镜头号里没有场次的按摆法排：把「开场」拖到「收尾」下面，时间线跟着换顺序★ 不重画的话连播和成片是一个顺序、时间线是另一个", 复审二);
  ok(JSON.stringify(复审二.亮) === JSON.stringify(["u2"]), "在画布上改选另一张卡，时间线上亮的那格跟着换", 复审二.亮);

  console.log("\n— 三十六、在画布里对话：任务历史当场同步，只显示人说的那句 —");
  // 以前画布自己读流，主界面不知道它在跑：侧栏没有运行中的小圆点、这一行也不往上挪，
  // 这时点开它看到的是一轮被标成「中断」的旧记录，要等跑完才对得上。用户原话「任务历史一度没有同步处理」
  const 同步 = await run(`
    (async () => {
      const sid = canvasTaskSessionId();
      const 等 = (ms) => new Promise((r) => setTimeout(r, ms));
      sessionId = "别的任务";
      sessions = [
        { id: "别的任务", title: "别的任务", at: 2, project: activeProject, lane: activeLane },
        { id: sid, title: "画布旧任务", at: 1, project: activeProject, lane: activeLane },
      ];
      renderHistory();
      const inner = window.fetch, 发的 = [];
      let ctl = null, 续 = null, 跑着 = [];
      window.fetch = function (u, o) {
        const s = String(u).split("?")[0];
        if (s === "/api/chat" && o && o.method === "POST") {
          发的.push(JSON.parse(o.body));
          const stream = new ReadableStream({ start(c) { ctl = c; } });
          return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
        }
        if (s === "/api/chat/running") return Promise.resolve(new Response(JSON.stringify(跑着), { status: 200 }));
        if (s.startsWith("/api/chat/stream/")) return Promise.resolve(new Response(new ReadableStream({ start(c) { 续 = c; } }), { status: 200 }));
        return inner.apply(this, arguments);
      };
      const push = (ev) => ctl.enqueue(new TextEncoder().encode("data: " + JSON.stringify(ev) + "\\n\\n"));
      const 圆点 = () => !!document.querySelector('#history .hist-item[data-id="' + sid + '"] .hrun');
      const input = document.getElementById("canvas-chat-input");
      input.value = "现在重新生成下啊";
      const p = canvasChatRun();
      for (let i = 0; i < 50 && !ctl; i++) await 等(20);
      const 跑时 = {
        登记了: runningSessions.has(sid), 圆点: 圆点(), 置顶: sessions[0].id,
        气泡: runningSessions.get(sid) && runningSessions.get(sid).ui.turn.querySelector(".bubble").textContent.trim(),
        shown: 发的[0] && 发的[0].shown, 说明还在: !!(发的[0] && /用户指令：现在重新生成下啊$/.test(发的[0].message) && /无限画布/.test(发的[0].message)),
      };
      push({ type: "text", delta: "好的，这就重新生成" });
      await 等(300); // 正文每 100ms 渲一次
      const 直播 = (runningSessions.get(sid) && runningSessions.get(sid).ui.turn.textContent) || "";
      push({ type: "done" }); ctl.close();
      await p; await 等(100);
      const 跑完 = { 登记了: runningSessions.has(sid), 圆点: 圆点() };
      // 流断了（没收到 done）但服务端还在跑：侧栏不许先一步变「完成」，要接着续流跟到真结束
      input.value = "再来一版";
      ctl = null;
      const p2 = canvasChatRun();
      for (let i = 0; i < 50 && !ctl; i++) await 等(20);
      跑着 = [sid];
      ctl.close();
      await p2; await 等(200);
      const 断流还在跑 = runningSessions.has(sid) && !!续;
      跑着 = [];
      续.close();
      for (let i = 0; i < 100 && runningSessions.has(sid); i++) await 等(100);
      const 真跑完才收 = !runningSessions.has(sid);
      // 反向对照：同一条任务正在主界面跑，画布不许再发、也不许把那边的回合顶掉
      const 主界面的 = { ui: { turn: document.createElement("div"), finish() {}, handleEvent() {} } };
      runningSessions.set(sid, 主界面的);
      const 发前 = 发的.length;
      input.value = "插一句";
      await canvasChatRun();
      const 没顶掉 = runningSessions.get(sid) === 主界面的 && 发的.length === 发前;
      runningSessions.delete(sid);
      window.fetch = inner;
      // 回放：记录里 text 是整段说明、shown 是原话，气泡只出原话；没有 shown 的老记录照旧显示原文
      const 回放 = createTurnUI("很长的操作说明\\n用户指令：现在重新生成下啊", "craft", "回放", "现在重新生成下啊");
      const 老记录 = createTurnUI("直接打的一句话", "craft", "回放");
      return { 跑时, 直播, 跑完, 断流还在跑, 真跑完才收, 没顶掉,
        回放气泡: 回放.turn.querySelector(".bubble").textContent.trim(), 回放重跑用全文: 回放.turn._userText.includes("操作说明"),
        老记录气泡: 老记录.turn.querySelector(".bubble").textContent.trim() };
    })()`);
  ok(同步.跑时.登记了 && 同步.跑时.圆点, "★画布一发出去，任务历史里这一行当场挂上「运行中」★ 以前要等跑完才对得上", 同步.跑时);
  ok(同步.跑时.置顶 === (await run("canvasTaskSessionId()")), "★画布的任务每发一次就提到侧栏最上面★ 不然被别的任务挤下去就得往下翻", 同步.跑时.置顶);
  ok(同步.跑时.气泡 === "现在重新生成下啊" && 同步.跑时.shown === "现在重新生成下啊" && 同步.跑时.说明还在,
     "★历史里的气泡只显示人说的那句，给模型的画布说明照旧整段发过去★", 同步.跑时);
  ok(同步.直播.includes("好的，这就重新生成"), "回复边到边进任务历史那一轮，不用等跑完", 同步.直播.slice(0, 80));
  ok(!同步.跑完.登记了 && !同步.跑完.圆点, "跑完了小圆点跟着撤", 同步.跑完);
  ok(同步.断流还在跑 && 同步.真跑完才收, "★画布那条流断了但服务端还在跑：侧栏继续显示运行中，真跑完才收★", 同步);
  ok(同步.没顶掉, "反向对照：同一条任务正在主界面跑，画布不重复发、不把那边的回合顶掉", 同步.没顶掉);
  ok(同步.回放气泡 === "现在重新生成下啊" && 同步.回放重跑用全文 && 同步.老记录气泡 === "直接打的一句话",
     "回放：有原话显示原话、重新生成仍用全文；老记录照旧显示原文", 同步);

  console.log("\n— 三十七、出视频带上时长 / 画幅：新建短剧定的、卡上写的，都要真发出去 —");
  const 视频卡 = { id: "vv1", kind: "video", position: { x: 700, y: 40 }, size: { width: 300, height: 260 },
    payload: { title: "海浪", prompt: "海浪拍岸", duration: "8s", aspect_ratio: "9:16", resolution: "720p" } };
  const 规格 = await run(`
    (async () => {
      const 发的 = () => window.__bodies.filter((b) => b.url === "/api/tool/run").map((b) => b.body.input);
      const 跑 = async (id) => { window.__bodies = []; window.__failRun = null; window.__echoName = false;
        await canvasGenerate(canvasState.graph.getCell(id), "video"); return 发的()[0] || null; };
      // sv1 把时长清空了：这时才轮到「新建短剧」定的每镜秒数（新建的镜头卡默认写着 4，写着几就发几）
      ${摆画布([剧本卡({ aspect: "9:16", shot_seconds: 6 }), 号镜头("sv1", "S1-01", "码头远景", 320, { first_frame: "f1.png", duration: "" }),
        号镜头("sv2", "S1-02", "码头近景", 560, { first_frame: "f2.png", duration: 4 }), 视频卡])}
      const 跟剧 = await 跑("sv1"), 自己的 = await 跑("sv2"), 通用卡 = await 跑("vv1");
      const 估价 = canvasEstimateItem(canvasState.graph.getCell("sv1"), "video").input;
      await canvasFlushRemoteWrite(); ${等(200)}
      ${摆画布([号镜头("sv3", "S1-03", "码头夜景", 40, { first_frame: "f3.png", duration: "" })])}
      const 没建剧 = await 跑("sv3");
      await canvasFlushRemoteWrite(); ${等(200)}
      return { 跟剧, 自己的, 通用卡, 估价, 没建剧 };
    })()`);
  ok(规格.跟剧 && 规格.跟剧.duration === "6" && 规格.跟剧.aspect_ratio === "9:16",
     "★镜头没写时长就用「新建短剧」定的每镜秒数，画幅用这部戏的★ 以前一项不发，出来全是模型默认那一档", 规格.跟剧);
  ok(规格.跟剧 && !规格.跟剧.prompt.includes("对白或旁白…") && 规格.跟剧.prompt.startsWith("码头远景"),
     "★新建镜头卡没改过的「对白或旁白…」是占位字，不许拼进视频提示词★", 规格.跟剧 && 规格.跟剧.prompt);
  ok(规格.自己的 && 规格.自己的.duration === "4", "这一镜自己写了 4 秒（分镜表改过的）就按 4 秒", 规格.自己的);
  ok(规格.通用卡 && 规格.通用卡.duration === "8s" && 规格.通用卡.aspect_ratio === "9:16" && 规格.通用卡.resolution === "720p",
     "★通用视频卡上写的时长 / 画幅 / 分辨率照发★ 卡上显示一套、实际按默认出片是说一套做一套", 规格.通用卡);
  ok(规格.估价 && 规格.估价.duration === "6", "估价跟真跑那一枪同一个口径：时长是视频的计价单位", 规格.估价);
  ok(规格.没建剧 && !("duration" in 规格.没建剧) && !("aspect_ratio" in 规格.没建剧),
     "反向对照：没走过「新建短剧」的画布不猜 9:16 / 5 秒，照旧交给模型默认", 规格.没建剧);

  srv.close();
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  app.exit(fail ? 1 : 0);
});
