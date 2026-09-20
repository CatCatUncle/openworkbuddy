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
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    timeout: 300000, killSignal: "SIGKILL",
  });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const http = require("http");
const { app, BrowserWindow } = require("electron");

// 离屏窗口人眼看不见，但 macOS 照样往程序坞塞一个跳动的图标，跑一次测试抢一次注意力
if (process.platform === "darwin" && app.dock && app.dock.hide) app.dock.hide();

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pv-"));

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

const W = (n, buf) => fs.writeFileSync(path.join(TMP, n), buf);
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

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf", ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
};
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(String(req.url || "/").split("?")[0]);
      const file = rel.startsWith("/api/files/view/")
        ? path.join(TMP, path.basename(rel.slice(16)))
        : path.join(PUB, path.normalize(rel).replace(/^([/\\.]+)/, ""));
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

app.whenReady().then(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const win = new BrowserWindow({
    show: false, width: 1440, height: 900, backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: false, nodeIntegration: false, plugins: true },
  });
  await win.loadURL(`http://127.0.0.1:${port}/index.html`);
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript(STUB);
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

  srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  app.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("测试自己崩了：", (e && e.stack) || e);
  app.exit(1);
});
