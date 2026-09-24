"use strict";
/**
 * 右侧成果预览：每种格式在面板里摆得对不对。
 *
 * 跑法：npx electron test/preview-layout.js
 *
 * 起因是用户点开一份 PDF：「就那么一小块地方是在预览的，其他一大部分空白啊」。
 * 查下去不是 PDF 一个人的事 —— 是「拿一把尺子量所有格式」这件事一直没人做过。
 * 量完发现同一个形状有四份：
 *
 *   PDF      面板 633×824，内容被缩成顶端一条        （measure-and-scale 那条路量不到插件文档）
 *   音频     54px 的播放条钉天花板，底下空 770px
 *   矮 SVG   一张 900×220 的流程图贴顶，底下空 669px
 *   兜底提示 一行小字贴左上角，底下空 728px
 *
 * 所以这个套件不看截图、不问「像不像」，只量三个数：面板多大、内容多大、内容摆在哪。
 * 每条正向断言后面都跟一条反向对照 —— 长文档、长表格、网页必须**依然贴顶且滚得到底**。
 * 少了反向对照，把所有东西一律 align-items:center 也能让上面几条全绿，
 * 代价是一篇三千字的报告顶部被推出可滚区，滚轮怎么往上推都回不到第一行。
 *
 * 料全部现造（PNG/WAV/PDF 按规范手搓，不往仓库里塞二进制），Office 那几种的服务端
 * 拆包结果照真实形状造替身 —— 这里要判的是版面，不是解包。
 *
 * 文件本身（/api/files/view、/pv/<令牌>/）是真 server.js 发的：工作区网页预览关进了 sandbox，
 * 尺寸只能靠页面自己 postMessage 报，而报尺寸的脚本是服务端挂上去的，CSP sandbox 头也是服务端给的。
 * 拿假服务器发文件，这几件事一件都验不到。界面还是这边的静态服务器发，
 * 那几条要真服务端的请求原样转过去（顺手记下每一条带没带登录 cookie、Origin 是什么）。
 */

// 版面只有在真 Chromium 里才量得准（真 CSS、真布局、真 PDF 阅读器），所以这个套件跑在
// electron 里。被 node 直接拉起来时（npm test 就是这么拉的）自己换一身皮再跑一遍；
// 没装 electron 就跳过不算失败——纯服务端部署本来就没有界面这一层。
if (!process.versions.electron) {
  const fs0 = require("fs");
  let bin = null;
  try { bin = require("electron"); } catch {}
  if (typeof bin !== "string" || !fs0.existsSync(bin)) {
    console.log("跳过：没装 electron，量不了版面（纯服务端部署没有界面）");
    process.exit(0);
  }
  const r = require("child_process").spawnSync(bin, [__filename], {
    stdio: ["ignore", "inherit", "inherit"],
    // 真 server.js 要用 node 起（electron 自带的 node 跟装好的原生模块不一定同一个 ABI），
    // 把此刻这个 node 递过去；直接 npx electron 跑的时候没有它，退回 PATH 上的 node
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1", OWB_TEST_NODE: process.execPath },
    timeout: 300000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const http = require("http");
const crypto = require("crypto");
const { app, BrowserWindow, session } = require("electron");

// 离屏窗口人眼看不见，但 macOS 照样往程序坞塞一个跳动的图标，跑一次测试抢一次注意力
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
// TMP 就是真服务端的 OPENWORKBUDDY_HOME：料放进它的 workspace，登录令牌写进它的 users.json
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pv-"));
const WS = path.join(TMP, "workspace");
fs.mkdirSync(WS, { recursive: true });
const TOKEN = "pv" + crypto.randomBytes(12).toString("hex");
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
fs.writeFileSync(path.join(TMP, "data", "users.json"), JSON.stringify({
  users: [{ username: "pv", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
  tokens: { [TOKEN]: { user: "pv", at: Date.now() } },
}));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};

// ---------------- 造料 ----------------

/** 一张真 PNG（签名 + IHDR + IDAT + IEND）。这里只要它的**内在尺寸**是真的，
 *  版面全靠宽高算，像素画什么无所谓，所以用渐变，压得小、造得快。 */
function png(w, h) {
  const { crc32 } = require("../thumb-png");    // CRC 不是被测的东西，借一下不影响判卷
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;                                // filter 0：none
    for (let x = 0; x < w; x++) {
      const i = off + 1 + x * 3;
      raw[i] = (x * 255 / w) | 0; raw[i + 1] = (y * 255 / h) | 0; raw[i + 2] = 200;
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                      // 8 位、色型 2 = RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 一段无声 WAV。播放器长什么样只跟 <audio> 有关，跟里头是不是真有声音无关。 */
function wav(seconds) {
  const rate = 8000, n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

/** 一份最小但**合法**的单页 PDF：交叉引用表的字节偏移现算，不写死。
 *  写死偏移的话，日后随手改一个字都会让文件变成坏的，而坏 PDF 在这套断言下照样"通过"
 *  （面板高度是 CSS 给的，跟能不能渲染无关）—— 那就是一条骗人的测试。 */
function pdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 52 >>\nstream\nBT /F1 24 Tf 72 760 Td (preview layout probe) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const a of at) out += String(a).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const W = (n, buf) => fs.writeFileSync(path.join(WS, n), buf);
W("长报告.html", "<html><body style='font:16px sans-serif'>" +
  Array.from({ length: 120 }, (_, i) => `<p>第 ${i + 1} 段：一份长到要滚好几屏的网页产出。</p>`).join("") + "</body></html>");
W("短结论.html", "<html><body style='font:16px sans-serif'><h1>结论</h1><p>就三行字。</p><p>第二行。</p></body></html>");
W("流程图.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='900' height='220'><rect width='900' height='220' fill='#eef'/><text x='40' y='120' font-size='32'>宽而扁的流程图</text></svg>");
W("长流程.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='2400'><rect width='800' height='2400' fill='#efe'/></svg>");
W("竖图.png", png(1200, 1800));
W("小图.png", png(120, 90));
W("口播.wav", wav(2));
W("报告.pdf", pdf());
W("长日志.txt", Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 行：一份长到要滚十几屏的纯文本。`).join("\n"));
W("短结论.md", "# 结论\n\n就两句话。\n");
W("明细.csv", "列一,列二,列三\n" + Array.from({ length: 200 }, (_, i) => `行${i + 1},值${i + 1},备注${i + 1}`).join("\n"));
W("空表.csv", "");
W("固件.bin", Buffer.from([0, 1, 2, 3, 0, 255, 254, 253]));
// ---- 下面这几份专给 sandbox 那一段 ----
// 小红书那种写死 1200×1600 的竖版卡片：不缩就只看得见左上角一块
W("宽卡片.html", "<!doctype html><html><body style='margin:0'><div style='width:1200px;height:1600px;background:#fde'>小红书卡片</div></body></html>");
// 探针：在预览里把「能碰到什么」一样样试一遍，结果 postMessage 报出来（外面读不到它的 DOM）
W("探针.html", `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>探针</h1><img id="im" src="小图.png">
<script>
(async function () {
  var out = { origin: String(self.origin) };
  try { localStorage.setItem("k", "1"); out.ls = "ok"; } catch (e) { out.ls = "throw:" + e.name; }
  try { out.cookie = "read:" + document.cookie; } catch (e) { out.cookie = "throw:" + e.name; }
  try { out.parentDoc = "read:" + parent.document.title; } catch (e) { out.parentDoc = "throw:" + e.name; }
  async function hit(k, u, init) {
    try { var r = await fetch(u, init); out[k] = "status:" + r.status; } catch (e) { out[k] = "reject:" + e.name; }
  }
  await hit("sessions", "/api/sessions");
  await hit("sessionsCred", "/api/sessions", { credentials: "include" });
  await hit("toolRun", "/api/tool/run", { method: "POST", credentials: "include", body: '{"name":"list_files"}' });
  var im = document.getElementById("im");
  await new Promise(function (r) { if (im.complete) r(); else { im.onload = r; im.onerror = r; } });
  out.img = im.naturalWidth;
  parent.postMessage({ __probe: 1, out: out }, "*");
})();
</script></body></html>`);
// 页面自己的 CSP 挡掉了内联脚本：服务端挂上去的那段报不上来，前端得自己退回「占满面板、框里自己滚」
W("自带CSP.html", "<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"script-src 'none'\"></head><body>"
  + Array.from({ length: 80 }, (_, i) => `<p>第 ${i + 1} 段：报不上尺寸的网页。</p>`).join("") + "</body></html>");
// min-height:100vh 再加 padding：外面按报上来的高度拉高框、框一高页面又更高——重报要是不看宽度就没个头
W("满屏.html", "<!doctype html><html><body style='margin:0;padding:20px'><div style='min-height:100vh;background:#eef'>首屏</div></body></html>");
// 框里跳到同目录另一页：新页面的地址是它自己拼的，不带 fit=1
W("导航起点.html", "<!doctype html><html><body style='margin:0'><p>起点</p><script>setTimeout(function () { location.href = '导航终点.html'; }, 400)</script></body></html>");
// 只写了 viewBox、没写宽高的 SVG（导出工具很常见）：sandbox 框里根 <svg> 一律按视口排，量出来永远是视口大小，
// 得按 viewBox 的比例算高度，不然一张竖长图被压在 150px 高的框里
W("只有viewBox.svg", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 1800'><rect width='900' height='1800' fill='#ffe'/></svg>");
W("导航终点.html", "<!doctype html><html><body style='margin:0'><div style='width:1000px;height:1400px;background:#dfe'>终点</div></body></html>");
// 生成网页里最常见的一种「横向溢出」：body 默认 8px 外边距 + 一条 width:100vw 的通栏。
// 它永远比视口宽 8px——框放宽到它报的宽度，它就再报宽 8px，照单全收的话框会一路放宽下去
W("通栏.html", "<!doctype html><html><body style='margin:8px'><div style='width:100vw;height:300px;background:#fee'>通栏</div><p>正文</p></body></html>");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf", ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
};
/** 起一个真 server.js（家目录是 TMP，端口让系统挑）。认的是它自己打的那行「已启动: http://localhost:端口」 */
function bootServer() {
  const { spawn } = require("child_process");
  const child = spawn(process.env.OWB_TEST_NODE || "node", [path.join(ROOT, "server.js")], {
    env: { ...process.env, OPENWORKBUDDY_HOME: TMP, HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  child.on("error", (e) => (log += "\n起不来：" + e.message));
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const m = /已启动: http:\/\/localhost:(\d+)/.exec(log);
      if (m || child.exitCode !== null || Date.now() - t0 > 60000) {
        clearInterval(tick);
        resolve({ child, port: m ? Number(m[1]) : 0, why: `退出码=${child.exitCode} 日志尾巴=${JSON.stringify(log.slice(-400))}` });
      }
    }, 100);
  });
}

// 这几条交给真服务端：文件本身、带令牌的预览地址、两条拿来做对照的 /api
const PROXY_RE = /^\/(api\/files\/view\/|pv\/|api\/sessions(\?|$)|api\/tool\/run(\?|$))/;
const seen = []; // 转过去的每一条：地址、方法、带没带登录 cookie、Origin、Sec-Fetch-*，回来的状态码
function serve(realPort) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (PROXY_RE.test(String(req.url || ""))) {
        const rec = {
          url: decodeURIComponent(String(req.url)), method: req.method,
          cookie: /openworkbuddy_token=/.test(String(req.headers.cookie || "")),
          origin: req.headers.origin == null ? "" : String(req.headers.origin),
          site: String(req.headers["sec-fetch-site"] || ""), dest: String(req.headers["sec-fetch-dest"] || ""),
          status: 0,
        };
        seen.push(rec);
        const up = http.request({ host: "127.0.0.1", port: realPort, path: req.url, method: req.method, headers: req.headers }, (ur) => {
          rec.status = ur.statusCode;
          const h = { ...ur.headers };
          delete h.connection; delete h["keep-alive"];
          res.writeHead(ur.statusCode, h);
          ur.pipe(res);
        });
        up.on("error", (e) => { rec.status = 502; res.statusCode = 502; res.end(String(e.message)); });
        req.pipe(up);
        return;
      }
      const rel = decodeURIComponent(String(req.url || "/").split("?")[0]);
      const file = path.join(PUB, path.normalize(rel).replace(/^([/\\.]+)/, ""));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("nope"); }
      const buf = fs.readFileSync(file);
      res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
      res.setHeader("Content-Length", buf.length);
      res.setHeader("Accept-Ranges", "bytes");
      res.end(buf);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// Office 那几种要服务端先拆包。这里判的是版面不是解包，所以照真实形状造替身就够了
const STUB = `
(function () {
  const real = window.fetch;
  window.fetch = function (u) {
    const s = String(u);
    if (s.includes("/api/files/preview/")) {
      const n = decodeURIComponent(s.split("/api/files/preview/")[1].split("?")[0]);
      let d = {};
      if (/[.]docx$/i.test(n)) {
        const blocks = [{ t: "h", lvl: 1, runs: [{ s: "季度经营分析" }] }];
        for (let i = 1; i <= 40; i++) blocks.push({ t: "p", runs: [{ s: "第 " + i + " 段正文。" }] });
        d = { blocks };
      } else if (/[.]xlsx$/i.test(n)) {
        const rows = [["列A", "列B", "列C", "列D"]];
        for (let i = 1; i <= 60; i++) rows.push(["行" + i, String(i * 3), String(i * 7), "备注" + i]);
        d = { sheets: [{ name: "明细", rows, totalRows: 60, totalCols: 4 }] };
      } else if (/[.]pptx$/i.test(n)) {
        const slides = [];
        for (let i = 1; i <= 12; i++) slides.push({ n: i, title: "第 " + i + " 页", lines: [{ lvl: 0, s: "要点" }], notes: "" });
        d = { total: 12, slides };
      } else if (/[.]zip$/i.test(n)) {
        const entries = [];
        for (let i = 1; i <= 30; i++) entries.push({ name: "files/第" + i + "个.txt", size: i * 1024 });
        d = { total: 30, bytes: 512000, entries };
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => d });
    }
    return real.apply(this, arguments);
  };
})();
`;

/** 打开一个文件，回报「面板多大、内容多大、内容摆在哪」。上下留白是判居中的唯一依据。 */
const probe = (name) => `
(async () => {
  const body = document.getElementById("pv-body");
  await previewFile(${JSON.stringify(name)}, "");
  await new Promise((r) => setTimeout(r, 1000));
  const br = body.getBoundingClientRect();
  const kids = [...body.children];
  let top = Infinity, bot = -Infinity, left = Infinity, right = -Infinity;
  for (const k of kids) {
    const r = k.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    top = Math.min(top, r.top); bot = Math.max(bot, r.bottom);
    left = Math.min(left, r.left); right = Math.max(right, r.right);
  }
  if (!isFinite(top)) { top = bot = br.top; left = right = br.left; }
  return {
    kind: previewKind(${JSON.stringify(name)}),
    panelW: Math.round(br.width), panelH: Math.round(br.height),
    w: Math.round(right - left), h: Math.round(bot - top),
    gapTop: Math.round(top - br.top), gapBot: Math.round(br.bottom - bot),
    scrollH: body.scrollHeight, clientH: body.clientHeight,
    bodyCls: body.className,
    firstCls: kids.length ? String(kids[0].className || kids[0].tagName.toLowerCase()) : "",
    html: body.innerHTML.slice(0, 260),
  };
})()
`;

let real = null;
app.whenReady().then(async () => {
  real = await bootServer();
  if (!real.port) throw new Error("真 server.js 没起来，这一套作废：" + real.why);
  const srv = await serve(real.port);
  const port = srv.address().port;
  const ORIGIN = `http://127.0.0.1:${port}`;
  // 不落盘的独立 session：默认 session 里常年躺着别的套件留下的 cookie，混进来就说不清是谁的登录态
  const part = "pv-" + crypto.randomBytes(6).toString("hex");
  await session.fromPartition(part).cookies.set({
    url: ORIGIN, name: "openworkbuddy_token", value: TOKEN, httpOnly: true, sameSite: "lax",
  });
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900, backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: false, nodeIntegration: false, plugins: true, partition: part },
  });
  await win.loadURL(`${ORIGIN}/index.html`);
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript(STUB);
  // 语言钉成中文：Electron 的 navigator.language 随系统走，CI 那台是英文。
  // 这一套量的是位置和尺寸，中英文都该一样——但下面偶尔要照文案找元素，
  // 而且英文句子比中文长，换行数不同、面板高度就不同。钉住它，量出来的数才是同一把尺子
  await win.webContents.executeJavaScript('I18N.setLang("zh")');
  const at = (n) => win.webContents.executeJavaScript(probe(n));

  // 居中判据写成一句：上下留白差不超过 10px，且确实留出了一大块（不是贴着边）。
  // 只判「差值小」不行 —— 一块正好铺满面板的内容上下留白都是 0，差值也是 0。
  const centered = (r) => Math.abs(r.gapTop - r.gapBot) <= 10 && r.gapTop > 60;
  const topAligned = (r) => r.gapTop <= 6;
  const fillH = (r) => r.h / r.panelH;

  console.log("\n— PDF：自带阅读器，要整个面板 —");
  {
    const r = await at("报告.pdf");
    ok(r.kind === "pdf", "PDF 单独一条路由，不跟网页混在一起", r.kind);
    ok(/pv-pdf/.test(r.firstCls), "渲染出来的是 iframe.pv-pdf", r.firstCls);
    ok(!/pv-fit/.test(r.html), "反向对照：绝不能走 .pv-fit 那条「量内容高度再整页缩放」的路——"
      + "iframe 里的 PDF 是插件文档，scrollHeight 量出来几乎是 0，量一次塌一次", r.html.slice(0, 120));
    ok(fillH(r) >= 0.95, "占满面板高度（用户原话：只有一小块在预览）", Math.round(fillH(r) * 100) + "%");
    ok(/pv-full/.test(r.bodyCls), "面板自己不再滚，滚动权交给阅读器（两层滚动条会打架）", r.bodyCls);
  }

  console.log("\n— 图、音频、提示：是「一个物件」，装得下就摆正中间 —");
  {
    const r = await at("流程图.svg");
    ok(r.kind === "svg", "SVG 从网页里拆出来了（渲染一样，摆法不一样）", r.kind);
    ok(centered(r), "一张宽扁的流程图摆在正中间，不是钉在天花板上", `上${r.gapTop} 下${r.gapBot}`);
  }
  {
    const r = await at("口播.wav");
    ok(/pv-audio/.test(r.firstCls), "音频给的是一张卡片（图标+文件名+播放条），不是光秃秃一根条", r.firstCls);
    ok(/<audio[^>]+controls/.test(r.html), "播放器该有的控件一个不少", r.html.slice(0, 160));
    ok(centered(r), "音频卡片摆正中间（音频本来就没有画面，再贴顶就真只剩一条了）", `上${r.gapTop} 下${r.gapBot}`);
  }
  {
    const r = await at("固件.bin");
    ok(/pv-empty/.test(r.firstCls), "看不了的文件给的是一块居中提示，不是左上角一行小字", r.firstCls);
    ok(centered(r), "兜底提示摆正中间", `上${r.gapTop} 下${r.gapBot}`);
    ok(/pv-open-sys|pv-download/.test(r.html), "提示里带着一颗真能点的按钮，不是让人自己想办法", r.html.slice(0, 200));
  }
  {
    const r = await at("空表.csv");
    ok(centered(r), "空文件的提示也摆正中间", `上${r.gapTop} 下${r.gapBot}`);
  }
  {
    const r = await at("小图.png");
    ok(centered(r), "守住原有行为：单张小图居中", `上${r.gapTop} 下${r.gapBot}`);
  }

  console.log("\n— 反向对照：文章和长内容必须依然贴顶，而且滚得到底 —");
  // 少了这一组，把所有东西一律 align-items:center 也能让上面全绿，
  // 代价是一篇长报告的顶部被推出可滚区，滚轮往上推再也回不到第一行
  {
    const r = await at("长流程.svg");
    ok(topAligned(r), "超出面板的长 SVG 退回贴顶（auto 外边距在剩余空间为负时按 0 算）", `上${r.gapTop}`);
    ok(r.scrollH > r.clientH + 1, "而且滚得到底", `${r.scrollH} > ${r.clientH}`);
  }
  {
    const r = await at("长报告.html");
    ok(topAligned(r), "网页是文章，从第一行读起", `上${r.gapTop}`);
    ok(r.scrollH > r.clientH + 1, "长网页滚得到底", `${r.scrollH} > ${r.clientH}`);
  }
  {
    const r = await at("短结论.html");
    ok(topAligned(r), "短网页也贴顶——它仍然是文章，不是一张图", `上${r.gapTop}`);
  }
  {
    const r = await at("长日志.txt");
    ok(topAligned(r) && r.scrollH > r.clientH + 1, "长纯文本贴顶且滚得到底", `上${r.gapTop}，${r.scrollH}>${r.clientH}`);
  }
  {
    const r = await at("短结论.md");
    ok(topAligned(r), "短 Markdown 贴顶（居中会让一小段文字浮在面板正中，读起来像出错了）", `上${r.gapTop}`);
  }

  console.log("\n— 表格和 Office：横向要铺满，别在右边空一条 —");
  for (const [n, what] of [["明细.csv", "CSV"], ["方案.docx", "Word"], ["台账.xlsx", "Excel"], ["汇报.pptx", "PPT"], ["包.zip", "压缩包"]]) {
    const r = await at(n);
    ok(r.w / r.panelW >= 0.98, `${what} 铺满面板宽度`, Math.round(r.w / r.panelW * 100) + "%");
  }

  console.log("\n— Word 预览：序号真数出来、链接只认安全协议 —");
  {
    // docHtml 是页面里的函数，直接喂结构化数据判它吐的 HTML —— 这一段跟版面无关，
    // 判的是「渲染对不对」，所以不量像素，只看标记。
    const render = (blocks, extra) => win.webContents.executeJavaScript(
      "docHtml(Object.assign({ blocks: " + JSON.stringify(blocks) + " }, " + JSON.stringify(extra || {}) + "))");

    const ordered = await render([
      { t: "li", lvl: 0, ord: 1, runs: [{ s: "甲方应当按时付款" }] },
      { t: "li", lvl: 0, ord: 1, runs: [{ s: "乙方应当按时交付" }] },
      { t: "li", lvl: 0, ord: 1, runs: [{ s: "争议提交仲裁" }] },
    ]);
    ok(/ov-mark">1\.</.test(ordered) && /ov-mark">3\.</.test(ordered),
      "有序列表在面板里也数成 1. 2. 3.", ordered.slice(0, 200));
    // 以前 .ov-li::before 写死一个「·」。改成真序号之后那条规则必须撤掉，
    // 否则每一条前面会是「· 1.」两个记号叠着显示 —— 纯函数断言看不见这个。
    const before = await win.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('#pv-body .ov-li') || document.createElement('div'), '::before').content");
    ok(before === "none" || before === "" || before === "normal",
      "★项目符号的 ::before 已经撤掉★ 不撤就会「· 1.」叠着显示", before);

    const bullets = await render([
      { t: "li", lvl: 0, runs: [{ s: "第一点" }] },
      { t: "li", lvl: 0, runs: [{ s: "第二点" }] },
    ]);
    ok(/ov-mark">•</.test(bullets) && !/ov-mark">1\.</.test(bullets),
      "反向对照：无序列表还是圆点，不许被数成序号", bullets.slice(0, 200));

    const safe = await render([{ t: "p", runs: [{ s: "详见这里", href: "https://example.invalid/r" }] }]);
    ok(/<a class="ov-a" href="https:\/\/example\.invalid\/r"/.test(safe), "http 链接渲染成可点的 a", safe);
    ok(/rel="noopener noreferrer"/.test(safe), "新窗口打开要带 noopener，别让目标页拿到 window.opener", safe);

    // .docx 常常是外面发进来的，里头写一句 javascript: 的超链接完全合法。
    // 照单渲染就等于在预览面板里给了它一个可点的入口。
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>x</script>", "file:///etc/passwd", "vbscript:msgbox"]) {
      const h = await render([{ t: "p", runs: [{ s: "点我", href: bad }] }]);
      ok(!/<a /.test(h), "★不安全协议不许变成链接：" + bad.slice(0, 22) + "★", h.slice(0, 160));
      ok(h.includes("点我"), "但文字本身还得显示出来（不是整段吞掉）", h.slice(0, 160));
    }

    const chrome = await render([{ t: "p", runs: [{ s: "正文" }] }], { header: "内部资料 请勿外传", footer: "第 1 页" });
    ok(/ov-chrome">页眉　内部资料 请勿外传</.test(chrome), "页眉显示出来并标明是页眉", chrome.slice(0, 200));
    ok(/ov-chrome">页脚　第 1 页</.test(chrome), "页脚同理", chrome.slice(-200));
    const bare = await render([{ t: "p", runs: [{ s: "正文" }] }]);
    ok(!/ov-chrome/.test(bare), "反向对照：没有页眉页脚就不许多出这两条", bare);
  }

  console.log("\n— 工作区网页关进 sandbox：尺寸靠 postMessage 报，登录态一样都碰不到 —");
  // 以前这个框跟应用同源、不设 sandbox：模型写的、网上下的任何一页网页都能以应用的身份
  // 调 /api/chat、/api/tool/run（跑命令、花钱）。现在它是个 opaque origin，外面读不到它、
  // 它也读不到外面，尺寸只能它自己用 postMessage 报上来
  await win.webContents.executeJavaScript(`
    window.__fits = [];
    window.__probe = null;
    addEventListener("message", (e) => {
      const fr = document.querySelector("#pv-body iframe");
      if (e.data && e.data.__wbFit === 1) __fits.push({ w: e.data.w, h: e.data.h, fromFrame: !!fr && e.source === fr.contentWindow });
      if (e.data && e.data.__probe === 1) __probe = e.data.out;
    });
    0`);
  const frameState = () => win.webContents.executeJavaScript(`(() => {
    const fr = document.querySelector("#pv-body .pv-fit iframe");
    if (!fr) return null;
    const wrap = fr.parentElement;
    let cd; try { cd = fr.contentDocument === null ? "null" : "readable"; } catch (e) { cd = "throw"; }
    return {
      sandbox: fr.getAttribute("sandbox"), src: fr.getAttribute("src"), cd,
      w: parseFloat(fr.style.width) || 0, h: parseFloat(fr.style.height) || 0, tf: fr.style.transform || "",
      wrapH: Math.round(wrap.getBoundingClientRect().height), avail: wrap.clientWidth,
      panelH: document.getElementById("pv-body").clientHeight,
      scrolling: fr.getAttribute("scrolling"), zoomHidden: !!(wrap.querySelector(".pv-zoom") || {}).hidden,
      fits: __fits.slice(),
    };
  })()`);
  const open = async (name, waitMs) => {
    await win.webContents.executeJavaScript(`__fits.length = 0; __probe = null; previewFile(${JSON.stringify(name)}, "").then(() => 0)`);
    const before = await frameState();
    await new Promise((r) => setTimeout(r, waitMs));
    return { before, after: await frameState() };
  };
  const scaleOf = (tf) => { const m = /scale\(([\d.]+)\)/.exec(tf || ""); return m ? Number(m[1]) : 1; };

  {
    seen.length = 0;
    const { before, after: r } = await open("宽卡片.html", 2000);
    ok(r && r.sandbox === "allow-scripts allow-popups", "★网页预览的框带 sandbox，只给脚本和弹窗，不给 allow-same-origin★", r && r.sandbox);
    ok(r && r.cd === "null", "外面读不到框里的文档（contentDocument 是 null）——同源时这里读得到，页面也就读得到外面", r && r.cd);
    ok(r && /[?&]fit=1(&|$)/.test(r.src), "请求带 fit=1，让服务端把报尺寸那段脚本挂上", r && r.src);
    ok(before && !/scale/.test(before.tf) && before.w === before.avail,
      "报上来之前不瞎猜：框先按可用宽度、不缩放摆着", before && { w: before.w, avail: before.avail, tf: before.tf });
    const fromFrame = r ? r.fits.filter((f) => f.fromFrame) : [];
    const lastFit = fromFrame[fromFrame.length - 1];
    ok(lastFit && lastFit.w === 1200 && lastFit.h === 1600, "★页面自己用 postMessage 报上来 1200×1600★", r && r.fits);
    const sc = r ? scaleOf(r.tf) : 1;
    ok(r && r.w === 1200 && Math.abs(sc - r.avail / 1200) < 0.01,
      "按报上来的宽度整页缩到可用宽度（不缩就只看得见左上角一块）", r && { w: r.w, tf: r.tf, avail: r.avail });
    ok(r && Math.abs(r.wrapH - Math.ceil(1600 * sc)) <= 2, "外层撑到缩放后的高度，整张卡片滚得到底", r && { wrapH: r.wrapH, want: Math.ceil(1600 * sc) });
    ok(r && !r.zoomHidden, "比框宽的页面才摆「适应宽度 / 实际大小」那颗切换钮", r && r.zoomHidden);

    const nav = seen.find((x) => /^\/api\/files\/view\/宽卡片\.html/.test(x.url));
    ok(nav && nav.status === 302 && nav.dest === "iframe", "框的那一次导航被 302 到带令牌的预览地址（相对路径的图、样式才有地方取）", nav);
    const pv = seen.find((x) => /^\/pv\/[0-9a-f]+\/宽卡片\.html\?fit=1$/.test(x.url));
    ok(pv && pv.status === 200, "跳过去的是 /pv/<令牌>/宽卡片.html?fit=1，服务端照发", pv || seen.map((x) => x.url));

    // 这张卡一缩放就把面板撑出滚动条，可用宽度会变一次。把框设成 1200 之后页面会按 1200 的视口再报一次，
    // 那一次要是被当成「跟着视口排的页面、宽度过期了」去归位，就是归位→放宽→归位的死循环，框一直在闪
    const n1 = r ? r.fits.filter((f) => f.fromFrame).length : -1;
    await new Promise((r3) => setTimeout(r3, 800));
    const r3 = await frameState();
    const n2 = r3 ? r3.fits.filter((f) => f.fromFrame).length : -2;
    ok(n1 <= 12 && n2 === n1 && r3.w === 1200 && r3.tf === r.tf, "★写死宽度的卡片报几次就停，不在归位和放宽之间来回打转★", { n1, n2, w: r3 && r3.w });
    // 冒充：主窗口自己发一条 {__wbFit:1}，不许把框撑成那样
    await win.webContents.executeJavaScript(`postMessage({ __wbFit: 1, w: 4000, h: 30 }, "*"); 0`);
    await new Promise((r2) => setTimeout(r2, 300));
    const r2 = await frameState();
    ok(r2 && r2.w === 1200 && r2.h === 1600, "★别的窗口冒充报尺寸，一律不认（只认这个框自己发的）★", r2 && { w: r2.w, h: r2.h });
  }

  {
    seen.length = 0;
    const main = await win.webContents.executeJavaScript(`fetch("/api/sessions").then((r) => r.status, (e) => "reject:" + e.name)`);
    ok(main === 200, "对照组：应用自己的页面调 /api/sessions 是通的（登录态在）", main);
    const mainReq = seen.find((x) => x.url.startsWith("/api/sessions"));
    ok(mainReq && mainReq.cookie, "对照组：应用自己发的请求带着登录 cookie", mainReq);

    seen.length = 0;
    await open("探针.html", 400);
    let out = null;
    for (let i = 0; i < 40 && !out; i++) {
      await new Promise((r) => setTimeout(r, 150));
      out = await win.webContents.executeJavaScript("__probe");
    }
    ok(!!out, "探针页在 sandbox 里跑起来了，结果用 postMessage 报了出来", out);
    out = out || {};
    ok(out.origin === "null", "框里的页面是 opaque origin（\"null\"），不是应用的源", out.origin);
    ok(!/^status:2/.test(String(out.sessions)), "★框里调 /api/sessions 拿不到东西★", out.sessions);
    ok(!/^status:2/.test(String(out.sessionsCred)), "★带上 credentials:include 也一样拿不到★", out.sessionsCred);
    ok(!/^status:2/.test(String(out.toolRun)), "★框里 POST /api/tool/run 也被挡在门外★", out.toolRun);
    const fromFrame = seen.filter((x) => /^\/api\//.test(x.url) && x.origin === "null");
    ok(fromFrame.length >= 3 && fromFrame.every((x) => !x.cookie),
      "★框里发出去的 /api 请求到服务端时一个都没带登录 cookie★", fromFrame);
    ok(fromFrame.length >= 3 && fromFrame.every((x) => x.status === 401),
      "服务端对这几条回的是 401（没登录），不是替它办了事", fromFrame.map((x) => x.method + " " + x.url + " " + x.status));
    ok(/^throw/.test(String(out.ls)), "框里的 localStorage 用不了（预期内：丢了本地存储，换来碰不到应用的那份）", out.ls);
    ok(/^throw/.test(String(out.parentDoc)), "框里够不到外面的 document", out.parentDoc);
    ok(!String(out.cookie).includes(TOKEN), "框里读不到登录令牌", out.cookie);
    ok(out.img === 120, "★页面里用相对路径引的图照样显示★（sandbox 里的子请求不带 cookie，靠的就是 /pv/<令牌>/）", out.img);
    const img = seen.find((x) => /^\/pv\/[0-9a-f]+\/小图\.png$/.test(x.url));
    ok(img && img.status === 200 && !img.cookie, "那张图走的是 /pv/<令牌>/小图.png，不带 cookie 也取得到", img || seen.map((x) => x.url));
  }

  {
    const { after: r } = await open("自带CSP.html", 2500);
    ok(r && r.fits.filter((f) => f.fromFrame).length === 0, "页面自带 CSP 挡了内联脚本，确实一条尺寸都报不上来", r && r.fits);
    ok(r && r.scrolling === null && Math.abs(r.h - r.panelH) <= 2 && !/scale/.test(r.tf),
      "报不上来就退回「占满面板、框里自己滚」，不缩在 150px 的默认框里", r && { h: r.h, panelH: r.panelH, scrolling: r.scrolling, tf: r.tf });
    ok(r && r.zoomHidden, "退回之后不摆缩放钮（没有尺寸可切）", r && r.zoomHidden);
  }

  {
    const { after: a } = await open("通栏.html", 2000);
    await new Promise((r) => setTimeout(r, 1000));
    const b = await frameState();
    const n = (s) => (s ? s.fits.filter((f) => f.fromFrame).length : -1);
    ok(a && b && n(b) === n(a) && b.w === a.w && n(b) <= 12,
      "★width:100vw 的通栏页（永远比视口宽一截）报几次就停，框不会一路放宽下去★", a && b && { n1: n(a), n2: n(b), w1: a.w, w2: b.w, avail: b.avail });
    ok(b && b.w <= b.avail + 40, "放宽也有个头：最后的框宽只比可用宽度多出几次 8px", b && { w: b.w, avail: b.avail });
  }

  {
    const { after: a } = await open("满屏.html", 2000);
    await new Promise((r) => setTimeout(r, 1500));
    const b = await frameState();
    ok(a && b && a.h === b.h && a.fits.length === b.fits.length,
      "min-height:100vh 的页面不会越报越高（只有宽度变了才重报）", a && b && { h1: a.h, h2: b.h, n1: a.fits.length, n2: b.fits.length });
    ok(b && b.fits.length <= 8 && b.h < 3000, "报的次数和最终高度都有个头", b && { n: b.fits.length, h: b.h });
  }

  {
    seen.length = 0;
    const { after: r } = await open("导航起点.html", 2500);
    const hop = seen.find((x) => /^\/pv\/[0-9a-f]+\/导航终点\.html$/.test(x.url));
    ok(hop && hop.status === 200 && !hop.cookie, "框里自己跳到同目录另一页，走的还是那条 /pv/<令牌>/", hop || seen.map((x) => x.url));
    ok(r && r.w === 1000 && r.h === 1400 && Math.abs(scaleOf(r.tf) - r.avail / 1000) < 0.01,
      "★跳过去的新页面也报了尺寸、重新缩好了★（服务端认 Sec-Fetch-Dest: iframe 照样挂脚本）", r && { w: r.w, h: r.h, tf: r.tf });
  }

  {
    const { after: r } = await open("长流程.svg", 1500);
    const f = r ? r.fits.filter((x) => x.fromFrame).pop() : null;
    ok(f && f.w === 800 && f.h === 2400, "★SVG 报的是它写死的 800×2400，不是框的视口大小★", r && r.fits);
  }
  {
    const { after: r } = await open("只有viewBox.svg", 1500);
    const f = r ? r.fits.filter((x) => x.fromFrame).pop() : null;
    ok(f && f.w === r.avail && Math.abs(f.h - r.avail * 2) <= 1 && r.h === f.h,
      "只写 viewBox 的 SVG：宽跟着面板、高按 viewBox 比例算（1:2），不被压成 150px 高", r && { fits: r.fits, avail: r.avail, w: r.w, h: r.h, tf: r.tf });
    // 这一张一报上来就把面板撑出滚动条、可用宽度窄了十来像素。以前卡在「适应宽度 · 98%」：
    // 照旧宽度的报数排了一遍，宽度记成新的，ResizeObserver 再来也觉得没变
    ok(r && !/scale/.test(r.tf) && r.w === r.avail && r.zoomHidden,
      "★撑出滚动条之后按新宽度重排，不卡在 98% 那种半缩放、也不冒出缩放钮★", r && { w: r.w, avail: r.avail, tf: r.tf, zoomHidden: r.zoomHidden });
  }

  console.log("\n— 服务端：预览响应带 CSP sandbox 头 —");
  {
    const reporter = await win.webContents.executeJavaScript("PV_FIT_REPORTER");
    const get = (u, headers) => new Promise((resolve, reject) => {
      const rq = http.request({ host: "127.0.0.1", port: real.port, path: encodeURI(u), method: "GET", headers: headers || {} }, (res) => {
        const bufs = [];
        res.on("data", (c) => bufs.push(c));
        res.on("end", () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(bufs).toString("utf8") }));
      });
      rq.on("error", reject);
      rq.end();
    });
    const withCookie = { Cookie: "openworkbuddy_token=" + TOKEN };
    const nav = { ...withCookie, "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin" };
    const SANDBOX = /(^|;)\s*sandbox allow-scripts allow-popups\s*(;|$)/;
    const csp = (r) => String(r.h["content-security-policy"] || "");

    const html = await get("/api/files/view/探针.html", withCookie);
    ok(html.status === 200 && SANDBOX.test(csp(html)), "★HTML 直接取（没有 Sec-Fetch 头）照发原文，带 CSP sandbox 头★", { s: html.status, csp: csp(html) });
    ok(/frame-ancestors 'self'/.test(csp(html)) && /object-src 'none'/.test(csp(html)), "全局那几条 CSP 一条没丢（是追加，不是覆盖）", csp(html));
    ok(!html.body.includes(reporter), "没要 fit=1 就不往文件里挂脚本（下载、另存拿到的是原文）", html.body.slice(-120));
    const svg = await get("/api/files/view/流程图.svg", withCookie);
    ok(svg.status === 200 && SANDBOX.test(csp(svg)), "SVG 也带（SVG 里一样能写 <script>）", csp(svg));
    const pngR = await get("/api/files/view/小图.png", withCookie);
    ok(pngR.status === 200 && !/sandbox/.test(csp(pngR)), "反向对照：图片不带 sandbox（带了也没用，只会碍事）", csp(pngR));
    const pdfR = await get("/api/files/view/报告.pdf", withCookie);
    ok(pdfR.status === 200 && !/sandbox/.test(csp(pdfR)), "反向对照：PDF 不带 sandbox（带了阅读器插件就起不来）", csp(pdfR));

    const hop = await get("/api/files/view/探针.html?fit=1", nav);
    const loc = String(hop.h.location || "");
    ok(hop.status === 302 && /^\/pv\/[0-9a-f]{36}\/%E6%8E%A2%E9%92%88\.html\?fit=1$/.test(loc),
      "框的导航 302 到 /pv/<令牌>/<文件>?fit=1", { s: hop.status, loc });
    ok(/no-store/.test(String(hop.h["cache-control"] || "")), "这条跳转不许被缓存（令牌会过期）", hop.h["cache-control"]);
    const accept = await get("/api/files/view/探针.html", { ...withCookie, Accept: "text/html,*/*" });
    ok(accept.status === 302, "局域网 http 下浏览器不发 Sec-Fetch-*，按 Accept: text/html 认导航", accept.status);
    const pvR = await get(decodeURI(loc));
    ok(pvR.status === 200 && SANDBOX.test(csp(pvR)), "★/pv 发的 HTML 带 CSP sandbox 头★（不带 cookie 也取得到）", { s: pvR.status, csp: csp(pvR) });
    ok(pvR.body.endsWith(reporter), "fit=1 的 HTML 尾巴上挂的正好是前端那段 PV_FIT_REPORTER（两边一个字不差）", pvR.body.slice(-160));
    const tok = (/^\/pv\/([0-9a-f]+)\//.exec(loc) || [])[1] || "x";
    const svgFit = await get(`/pv/${tok}/流程图.svg?fit=1`);
    ok(svgFit.status === 200 && SANDBOX.test(csp(svgFit)) && /<script><!\[CDATA\[[\s\S]*__wbFit[\s\S]*\]\]><\/script>\s*<\/svg>\s*$/.test(svgFit.body),
      "SVG 的报尺寸脚本插在 </svg> 前面、CDATA 包着（不然 XML 解析就挂）", svgFit.body.slice(-200));
    const pvPng = await get(`/pv/${tok}/小图.png`);
    ok(pvPng.status === 200 && /image\/png/.test(String(pvPng.h["content-type"])) && !/sandbox/.test(csp(pvPng)), "/pv 下的图片照常发、不带 sandbox", { s: pvPng.status, ct: pvPng.h["content-type"] });
    const bad = await get("/pv/" + "0".repeat(36) + "/探针.html");
    ok(bad.status === 404, "编的令牌不认", bad.status);
    for (const esc of [`/pv/${tok}/../data/users.json`, `/pv/${tok}/%2e%2e/data/users.json`, `/pv/${tok}/..%2Fdata%2Fusers.json`, `/pv/${tok}/%2Fetc%2Fhosts`]) {
      const r = await new Promise((resolve) => {
        const rq = http.request({ host: "127.0.0.1", port: real.port, path: esc, method: "GET" }, (res) => {
          const bufs = []; res.on("data", (c) => bufs.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(bufs).toString("utf8") }));
        });
        rq.on("error", (e) => resolve({ status: 0, body: String(e) }));
        rq.end();
      });
      ok(r.status !== 200 && !r.body.includes(TOKEN), "★令牌出不了它那个根：" + esc.replace(tok, "<令牌>") + "★", { s: r.status, body: r.body.slice(0, 80) });
    }
    const noLogin = await get("/api/files/view/探针.html", { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" });
    ok(noLogin.status === 401, "没登录的导航照旧 401，拿不到令牌", { s: noLogin.status, loc: noLogin.h.location });

    // 令牌签出去之后，组织改成「强制二次验证」（这个号没绑）：应用本身的 /api 立刻进不去，
    // 预览令牌也得跟着失效——不能只查「人在不在」，登录闸上的每一条都要算
    const still = await get(`/pv/${tok}/小图.png`);
    ok(still.status === 200, "对照：改设置之前，这枚令牌还取得到图", still.status);
    const ORGS = path.join(TMP, "data", "orgs.json");
    const orgsDb = fs.existsSync(ORGS) ? JSON.parse(fs.readFileSync(ORGS, "utf8")) : { orgs: [], depts: [], invites: [] };
    let dflt = (orgsDb.orgs || []).find((o) => o.id === "default");
    if (!dflt) { dflt = { id: "default", name: "我的团队", plan: "free", seats: 3, expires_at: null, settings: {} }; orgsDb.orgs = [dflt, ...(orgsDb.orgs || [])]; }
    dflt.settings = { ...(dflt.settings || {}), require_2fa: true };
    fs.writeFileSync(ORGS, JSON.stringify(orgsDb));
    const app2fa = await get("/api/files/view/小图.png", withCookie);
    ok(app2fa.status === 403, "对照：强制二次验证一开，应用自己取文件就被拦下", app2fa.status);
    const pv2fa = await get(`/pv/${tok}/小图.png`);
    ok(pv2fa.status === 404, "★强制二次验证之后，签出去的预览令牌也跟着作废★", pv2fa.status);
  }

  srv.close();
  try { real.child.kill(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("测试自己崩了：", (e && e.stack) || e);
  try { if (real && real.child) real.child.kill(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  app.exit(1);
});
