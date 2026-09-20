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
      window.__puts = [];
      canvasStartRemoteSync();
      await new Promise((r) => setTimeout(r, 2300));   // 第一圈：拉下来、铺上去
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

  srv.close();
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  app.exit(fail ? 1 : 0);
});
