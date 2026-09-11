"use strict";
/**
 * 给 README 拍界面静图 —— 零成本、零隐私风险。
 *
 * 为什么不直接截用户的屏：真实界面上挂着本机路径、任务历史、账号名，
 * 一截图就把这些顺手发到公网（用户原话：「不要泄露我电脑的一些信息和历史对话信息」）。
 * 为什么不手抄一份 HTML 当示意图：抄的那份不会跟着代码变，改完样式图还是老样子，
 * README 就开始骗人。
 *
 * 所以这里的做法是：用 Electron 打开**真的** public/index.html（真 CSS、真 app-01.js），
 * 断掉一切网络，塞一串编好的演示事件进 createTurnUI() —— 界面是真界面，内容是假内容。
 * 用法：npx electron scripts/shot-ui.js [场景名...]
 *
 * 注意：README 里那张「本机 Claude Code」现在放的是**真机截图**（用户自己截的，
 * 路径、账号名、任务历史都逐处遮过了）——比示意图有说服力。所以这里的产物改名成
 * local-claude-code-ui.png，不再覆盖 README 用的那张。下面那条措辞断言仍然留着：
 * 引擎里的文案一改，这里就报错，提醒你顺手看一眼 README 的图还对不对得上。
 */

const path = require("path");
const fs = require("fs");
const http = require("http");
const { app, BrowserWindow } = require("electron");

// 这几个跑的都是离屏/隐藏窗口，人眼看不到任何界面，但 macOS 照样往程序坞里塞一个 Electron 图标
// 一跳一跳的，跑一次测试抢一次注意力。声明成后台附属进程，图标就不出现了（窗口本来也没显示）。
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "images");

// ---- 场景：每个场景 = 一串事件 + 要裁的那块 DOM ----
// 引擎那条「已启动」的措辞真源在 engines/claude-code.js，图上必须跟产品里一模一样。
// 那边改了措辞这里就报错，别让 README 的图跟代码悄悄走岔。
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, "engines", "claude-code.js"), "utf8");
if (!/本机 Claude Code 已启动（模型 \$\{m\.model \|\| "默认"\}，\$\{\(m\.tools \|\| \[\]\)\.length\} 个工具），不消耗 API 额度/.test(ENGINE_SRC)) {
  throw new Error("engines/claude-code.js 里那条「已启动」的措辞变了，先同步 scripts/shot-ui.js 的 ENGINE_STATUS");
}
const ENGINE_STATUS = "本机 Claude Code 已启动（模型 claude-opus-5，102 个工具），不消耗 API 额度";

const SCENES = {
  // 「本机 Claude Code 也能当引擎」：重点是那枚引擎小牌子 + 不花 API 额度
  "local-claude-code": {
    file: "local-claude-code-ui.png",
    ask: "把项目里的超时时间统一成 30 秒，改完跑一遍测试",
    clip: ".turn",
    open: true, // 过程区展开，好让人看见它到底走了哪几步
    events: [
      { type: "status", model: "claude-opus-5", text: ENGINE_STATUS },
      { type: "text", delta: "先把散在各处的超时数字找出来，再统一改成 30 秒，最后跑一遍测试确认没改坏。\n" },
      { type: "tool_use", id: "t1", name: "search_files", title: "找 超时相关代码", input_preview: "timeout|超时" },
      { type: "tool_result", id: "t1", outcome: "命中 12 处，分布在 4 个文件" },
      { type: "tool_use", id: "t2", name: "edit_file", title: "改 请求超时 → 30s", input_preview: "- timeout: 8000\n+ timeout: 30000" },
      { type: "tool_result", id: "t2", outcome: "改了 3 处" },
      { type: "tool_use", id: "t3", name: "run_shell", title: "跑 npm test", input_preview: "npm test" },
      { type: "tool_result", id: "t3", outcome: "38 项全过，用时 6.2s" },
      { type: "text", delta: "\n改完了：4 个文件里 12 处超时全部统一成 30 秒，测试 38 项全过。\n这一趟走的是你本机的 Claude Code，没有花 API 额度。" },
    ],
  },
};

function pageScript(scene) {
  return `(async () => {
    // 演示身份：不读、不写真数据
    try { localStorage.clear(); } catch {}
    sessions = []; sessionId = "demo"; isReplaying = false;
    try { localStorage.setItem("wb_proc_open", ${scene.open ? '"1"' : '"0"'}); } catch {}
    document.getElementById("empty")?.remove();
    chatCol.innerHTML = "";
    const ui = createTurnUI(${JSON.stringify(scene.ask)}, "craft", "demo");
    for (const ev of ${JSON.stringify(scene.events)}) {
      ui.handleEvent(ev);
      await new Promise((r) => setTimeout(r, 30)); // 让流式那 100ms 的合帧真的跑一遍
    }
    await new Promise((r) => setTimeout(r, 260));
    ui.finish();
    // finish() 默认把过程区收起来（用户要的「别拿执行过程挡脸」）。
    // 截图要给人看它到底走了哪几步，所以这里再点开——等于读者点了一下折叠条
    if (${scene.open ? "true" : "false"}) document.querySelector(".proc-wrap")?.classList.add("open");
    await new Promise((r) => setTimeout(r, 150));
    const el = document.querySelector(${JSON.stringify(scene.clip)});
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`;
}

const PAD = 16;

// index.html 里的静态资源写的是 /css/ui.css 这种绝对路径 —— file:// 下会去磁盘根目录找，
// 主题变量整套加载不上（气泡会变成白底白字）。所以起一个只读的临时静态服务器喂 public/，
// 端口交给系统随机分配：绝不碰用户正在用的 3800。
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8" };
function serveStatic(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(String(req.url || "/").split("?")[0]);
      const file = path.join(dir, path.normalize(rel).replace(/^([/\\.]+)/, ""));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("nope"); }
      res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

async function shoot(name) {
  const scene = SCENES[name];
  if (!scene) throw new Error("没有这个场景：" + name + "（有的是：" + Object.keys(SCENES).join("、") + "）");
  const win = new BrowserWindow({
    show: false,
    width: 1040,
    height: 900,
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: false, nodeIntegration: false, offscreen: false },
  });
  // 断外网：真界面开机会去 /api 拉配置，本地这台临时服务器只有静态文件、没有 /api，
  // 一律 404 —— 图上不可能出现任何真数据
  const srv = await serveStatic(path.join(ROOT, "public"));
  const port = srv.address().port;
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (d, cb) => cb({ cancel: !d.url.startsWith(`http://127.0.0.1:${port}/`) }));
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  await new Promise((r) => setTimeout(r, 700)); // 等首屏脚本把 DOM 铺完
  const rect = await win.webContents.executeJavaScript(pageScript(scene));
  if (!rect || !rect.width) throw new Error("场景 " + name + " 没量到裁剪区域");
  const clip = {
    x: Math.max(0, Math.floor(rect.x - PAD)),
    y: Math.max(0, Math.floor(rect.y - PAD)),
    width: Math.ceil(rect.width + PAD * 2),
    height: Math.ceil(rect.height + PAD * 2),
  };
  const img = await win.webContents.capturePage(clip);
  const png = img.toPNG();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, scene.file);
  fs.writeFileSync(out, png);
  const size = img.getSize();
  console.log(`✅ ${scene.file}  ${size.width}×${size.height}  ${(png.length / 1024).toFixed(0)} KB`);
  win.destroy();
  srv.close();
  return out;
}

app.whenReady().then(async () => {
  const want = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const names = want.length ? want : Object.keys(SCENES);
  try {
    for (const n of names) await shoot(n);
    app.exit(0);
  } catch (e) {
    console.error("❌ " + (e && e.message ? e.message : e));
    app.exit(1);
  }
});
