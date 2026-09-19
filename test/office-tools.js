"use strict";
/**
 * 办公素材那一组工具：读 Office 文档、资料库取素材、推群、以及「这台机器上根本用不了的
 * 工具别挂在清单里」。
 *
 * 这一批补的都是同一种坑：**工具清单上写着的事，实际做不到。**
 *
 *   - 甲方发来的 .docx / .xlsx / .pptx / .zip 本质是压缩包，read_file 按 utf8 读回来是
 *     五万字符乱码。模型看不出这是「格式不对」，会把乱码当内容读进去再下结论。
 *   - PDF 的下一步以前写的是「没装就在 run_node 里解析」——而 run_node 那个沙箱里
 *     压根没有任何 PDF 库，照着做必然撞墙。指路不能指到死路上。
 *   - 资料库是用户直接拖文件进来的，里面躺着 PDF、截图、Word。library_read 一律按文本读，
 *     同样是乱码；而且素材躺在库里，read_document / look_at_image 只认工作目录的相对路径，
 *     等于看得见用不了。
 *   - 纯 node 起服务时 html_to_image / render_page / desktop_pet 是死的（张口就抛
 *     「需要桌面版环境」）。挂着一个必然失败的工具，比不挂更糟：模型会先照着做一遍、
 *     吃一条必然的失败、再回来重想，白烧一轮，还容易被当成偶发故障去重试。
 *
 * 后面几节补的是另一种坑：**做得到，但不该由模型一个人说了算。** 排期批一次以后天天算数，
 * 发邮件出了门就在别人的收件箱里躺着了——这两样都不看安全闸门的总开关，一律当场弹给用户；
 * 发邮件还多一道收件人白名单，用户在设置里钉死，挡在弹窗**之前**（弹了再挡，等于给
 * 「手一滑点同意」留口子，而那恰恰是白名单要防的事）。
 *
 * 所以每条正向断言后面都跟一条反向对照：把条件翻过来，结论必须跟着翻。
 * 少了这层，「过滤器」退化成「什么都不过滤」也照样全绿。
 *
 * 文档夹具是**运行时现造**的（docx / exceljs / pptxgenjs 本来就是本项目的依赖），
 * 不往仓库里塞二进制：塞进去之后没人能 review 它，改坏了也看不出来。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
// 失败时要把「实际拿到的是什么」打出来，可这一组测试的「实际」常常是一份 .docx 的二进制。
// 原样吐到 CI 日志里会夹着控制字符，把后面几百行都搅成乱码——那时候人连自己在看第几条都
// 分不清。所以先把非可打印字符换成 ·，再截断
function clean(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "·").slice(0, 300);
}
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + clean(extra) : ""}`); }
}
function eq(got, want, name) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, name, same ? undefined : { got, want });
}
function has(text, re, name) { ok(re.test(String(text)), name, String(text)); }

// 家目录和工作目录都指到临时盘：资料库落在 DATA_DIR 下，不隔离的话这套测试会往
// 用户自己的资料库里扔夹具文件
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-office-home-"));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-office-ws-"));
process.env.OPENWORKBUDDY_HOME = HOME;

const tools = require(path.join(ROOT, "tools"));
const preview = require(path.join(ROOT, "preview"));
const notify = require(path.join(ROOT, "notify"));
const LIB = path.join(HOME, "data", "library");

/** 1×1 的透明 PNG。只用来证明「内嵌图变成了占位符」，内容是什么不重要 */
const PNG1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** 手搓一个最小 zip（store，不压缩）。只为验「压缩包会被列成清单」，不值得为它拉一个依赖 */
function makeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, buf] of entries) {
    const nb = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(buf) : require("zlib").crc32(buf);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(0, 8); head.writeUInt32LE(crc >>> 0, 14);
    head.writeUInt32LE(buf.length, 18); head.writeUInt32LE(buf.length, 22);
    head.writeUInt16LE(nb.length, 26);
    locals.push(head, nb, buf);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(0, 10); cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(buf.length, 20); cen.writeUInt32LE(buf.length, 24);
    cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nb);
    offset += head.length + nb.length + buf.length;
  }
  const body = Buffer.concat(locals);
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, dir, end]);
}

async function makeFixtures(dir) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, ImageRun } = require(path.join(ROOT, "node_modules/docx"));
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: "季度汇报", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: "营收同比增长 ", bold: true }), new TextRun("32%，主要来自华东区。")] }),
    new Paragraph({ text: "下一步", heading: HeadingLevel.HEADING_2 }),
    new Table({ rows: [
      new TableRow({ children: [new TableCell({ children: [new Paragraph("区域")] }), new TableCell({ children: [new Paragraph("金额")] })] }),
      new TableRow({ children: [new TableCell({ children: [new Paragraph("华东")] }), new TableCell({ children: [new Paragraph("1200万")] })] }),
    ] }),
  ] }] });
  fs.writeFileSync(path.join(dir, "汇报.docx"), await Packer.toBuffer(doc));

  const withImg = new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun("图前面这句话")] }),
    new Paragraph({ children: [new ImageRun({ type: "png", data: PNG1, transformation: { width: 40, height: 40 } })] }),
    new Paragraph({ children: [new TextRun("图后面这句话")] }),
  ] }] });
  fs.writeFileSync(path.join(dir, "带图.docx"), await Packer.toBuffer(withImg));

  const ExcelJS = require(path.join(ROOT, "node_modules/exceljs"));
  const book = new ExcelJS.Workbook();
  const s1 = book.addWorksheet("明细");
  s1.addRow(["日期", "金额", "备注"]);
  for (let i = 1; i <= 120; i++) s1.addRow([`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, i * 100, `第${i}笔`]);
  const s2 = book.addWorksheet("汇总");
  s2.addRow(["合计", 726000]);
  await book.xlsx.writeFile(path.join(dir, "账目.xlsx"));

  const PptxGenJS = require(path.join(ROOT, "node_modules/pptxgenjs"));
  const p = new PptxGenJS();
  const sl = p.addSlide();
  sl.addText("2026 战略", { x: 0.5, y: 0.5, fontSize: 32 });
  sl.addText("三条主线", { x: 0.5, y: 1.5, fontSize: 18 });
  p.addSlide().addText("第二页标题", { x: 0.5, y: 0.5, fontSize: 32 });
  await p.writeFile({ fileName: path.join(dir, "战略.pptx") });

  fs.writeFileSync(path.join(dir, "材料包.zip"), makeZip([
    ["readme.txt", Buffer.from("这是一包材料", "utf8")],
    ["数据.csv", Buffer.from("a,b\n1,2\n", "utf8")],
  ]));
}

const run = (name, input) => tools.executeTool(name, input, { security: { gateway: false } });

(async () => {
  await makeFixtures(WS);

  await tools.withWorkspace(WS, async () => {
    // ── ① 四种打包格式都真读出了正文 ──────────────────────────────────
    console.log("① read_document 把 Office 文档拍平成纯文本");
    {
      const d = await run("read_document", { path: "汇报.docx" });
      eq(d.isError, false, "docx 读得出来");
      has(d.content, /Word 文档/, "说清楚这是什么格式");
      has(d.content, /# 季度汇报/, "标题层级留着（Markdown 的 #）");
      has(d.content, /营收同比增长 32%/, "★正文是真的正文★ 加粗被拆成两个 run，不拼回去就会断成两截");
      has(d.content, /\| 区域 \| 金额 \|/, "表格拍成了一行一行，模型能按行读");
      has(d.content, /\| 华东 \| 1200万 \|/, "表格数据行也在");

      const x = await run("read_document", { path: "账目.xlsx" });
      eq(x.isError, false, "xlsx 读得出来");
      has(x.content, /共 2 张工作表/, "先报表的总量，模型才知道要不要分段");
      has(x.content, /工作表「明细」\s*共 121 行 × 3 列/, "★行列数按真实总量报★ 只给切片不给总量，模型会拿半份当全份");
      has(x.content, /第1笔/, "单元格内容真的读出来了");

      const s = await run("read_document", { path: "战略.pptx" });
      eq(s.isError, false, "pptx 读得出来");
      has(s.content, /共 2 页/, "报了总页数");
      has(s.content, /## 第 1 页\s*2026 战略/, "每页的标题带页码");
      has(s.content, /三条主线/, "正文行也在");

      const z = await run("read_document", { path: "材料包.zip" });
      eq(z.isError, false, "zip 读得出来");
      has(z.content, /压缩包/, "说清楚这是压缩包");
      has(z.content, /readme\.txt/, "列出了里面的文件");
      has(z.content, /数据\.csv/, "中文名的条目也列得出来（zip 里是 UTF-8 标志位）");
    }

    // ── ② 大表要能分段读，表名对不上要按失败报 ────────────────────────
    console.log("\n② Excel 分段读 + 表名对不上");
    {
      const part = await run("read_document", { path: "账目.xlsx", sheet: "明细", from: 3, to: 6 });
      eq(part.isError, false, "按 sheet + from/to 取一段");
      has(part.content, /本次只给第 3-6 行/, "★明说这是切片★ 不说的话模型会把 4 行当成全表");
      has(part.content, /第2笔/, "第 3 行（表头占了第 1 行）确实是第 2 笔");
      ok(!/第10笔/.test(part.content), "反向对照：范围外的行没跟着出来", part.content.slice(0, 200));
      ok(!/工作表「汇总」/.test(part.content), "反向对照：点名了明细，汇总就不该出现");

      const byIndex = await run("read_document", { path: "账目.xlsx", sheet: "2" });
      has(byIndex.content, /工作表「汇总」/, "sheet 给序号也认（模型手里只有纯文本，逼它精确拼表名是给自己找麻烦）");

      const bad = await run("read_document", { path: "账目.xlsx", sheet: "不存在的表" });
      eq(bad.isError, true, "★表名对不上要按失败报★ isError=false 的话模型会把「没有这张表」当成内容读进去");
      has(bad.content, /明细/, "并且把真有的表名列出来，好让它下一次能对上");
      has(bad.content, /汇总/, "两张表都列了");

      const gone = await run("read_document", { path: "根本没有.docx" });
      eq(gone.isError, true, "反向对照：文件不存在按失败报");
      ok(!/\/Users\/|\/home\//.test(gone.content), "★报错里不许带出本机绝对路径★ 名字打错的代价不该是泄露目录结构", gone.content);
    }

    // ── ③ read_file 撞上打包格式要拦下来，并且指一条走得通的路 ──────────
    console.log("\n③ read_file 拦打包格式 + PDF 指路说实话");
    {
      for (const f of ["汇报.docx", "账目.xlsx", "战略.pptx", "材料包.zip"]) {
        const r = await run("read_file", { path: f });
        eq(r.isError, true, `read_file 读 ${path.extname(f)} 要拦下来`);
        has(r.content, /read_document/, `并且告诉它改用 read_document（${f}）`);
      }
      const txt = path.join(WS, "普通.txt");
      fs.writeFileSync(txt, "我是纯文本");
      const okRead = await run("read_file", { path: "普通.txt" });
      eq(okRead.isError, false, "反向对照：纯文本照读不误");
      has(okRead.content, /我是纯文本/, "反向对照：内容也对");

      fs.writeFileSync(path.join(WS, "扫描件.pdf"), Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x41)]));
      const pdf = await run("read_file", { path: "扫描件.pdf" });
      eq(pdf.isError, true, "PDF 也拦");
      has(pdf.content, /pdftotext/, "★PDF 的下一步必须是能照着做完的★ 指的是真装得上的命令");
      ok(!/run_node.*解析|在 run_node 里解析/.test(pdf.content),
        "★不许再说「自己写代码解析」★ run_node 那个沙箱里没有任何 PDF 库，照着做必然撞墙", pdf.content);
      has(pdf.content, /brew install poppler|apt install poppler|scoop install poppler|choco install poppler/,
        "给了本平台真装得上的安装命令");
    }

    // ── ④ 内嵌图必须是占位符，绝不能是 data URI ──────────────────────
    console.log("\n④ 内嵌图不许变成 base64 灌进上下文");
    {
      const r = await run("read_document", { path: "带图.docx" });
      eq(r.isError, false, "带图的 docx 读得出来");
      has(r.content, /［图片］/, "图变成了占位符");
      has(r.content, /图前面这句话[\s\S]*图后面这句话/, "占位符前后的正文顺序没乱");
      ok(!/data:image/.test(r.content), "★一个 data URI 都不许出现★ 20 张 × 3MB 封顶，拼进去等于往上下文里灌几十 MB base64", r.content.slice(0, 200));
      ok(r.content.length < 500, "★整篇长度还是人看的尺度★ 图真漏进去的话这里会是几万字符", r.content.length);
      // 反向对照：解析器本身确实产出了 data URI —— 证明上面那条不是「本来就没有图」
      const raw = await preview.previewData(path.join(WS, "带图.docx"), "带图.docx");
      ok(JSON.stringify(raw).includes("data:image"),
        "反向对照：底层解析器本来就会给出 data URI，所以上面那条拦的是真东西");
    }
  });

  // ── ⑤ 这台机器上用不了的工具，定义一起摘掉 ──────────────────────────
  console.log("\n⑤ 纯 node 模式下摘掉桌面专属工具");
  {
    const { createAgentRuntime } = require(path.join(ROOT, "agent"));
    const mk = (cfg) => createAgentRuntime({
      config: { agent: {}, im: {}, security: {}, ...cfg },
      llm: {}, mcpManager: { toolDefs: () => [] }, experts: [], expertTeams: [],
    });
    const DESKTOP = ["html_to_image", "render_page", "desktop_pet"];
    const rt = mk({});
    const craft = rt.toolList(0, "craft").map((t) => t.name);
    const ask = rt.toolList(0, "ask").map((t) => t.name);
    for (const t of DESKTOP) {
      ok(!craft.includes(t), `${t} 不在执行模式的工具清单里（这个进程里它张口就抛「需要桌面版环境」）`, craft);
      ok(!ask.includes(t), `${t} 也不在只读模式的清单里`, ask);
    }
    ok(craft.includes("check_page"), "★check_page 不能跟着一起摘★ 它没有浏览器时会退成静态审查，是真能用的");
    ok(craft.includes("gen_diagram"), "★gen_diagram 也不能摘★ 它有云端兜底");

    // 反向对照：把渲染器探测翻成「有」，三个工具必须回来。
    // 没有这条，过滤器写成「永远都摘掉」也照样全绿
    const br = require(path.join(ROOT, "browser-render"));
    const orig = br.available;
    br.available = () => true;
    try {
      const gui = mk({}).toolList(0, "craft").map((t) => t.name);
      for (const t of ["html_to_image", "render_page"]) {
        ok(gui.includes(t), `反向对照：探到渲染器时 ${t} 要回到清单里`, gui);
      }
    } finally { br.available = orig; }

    // 桥接给外部 CLI 引擎的那份清单，同样不许挂必然失败的工具
    const bridge = require(path.join(ROOT, "engines/tool-bridge"));
    const lent = bridge._internals.lentDefs().map((d) => d.name);
    for (const t of ["html_to_image", "render_page"]) {
      ok(!lent.includes(t), `桥接清单里也没有 ${t}（桥是个纯 node 子进程，更没有 Electron）`, lent);
    }
    ok(lent.includes("read_document"), "★read_document 借给了外部 CLI★ 它们自带的读文件工具读 Office 只会得到乱码", lent);
  }

  // ── ⑥ notify_user：配了才挂，没配不挂 ──────────────────────────────
  console.log("\n⑥ notify_user 按配置挂载");
  {
    const { createAgentRuntime } = require(path.join(ROOT, "agent"));
    const mk = (im) => createAgentRuntime({
      config: { agent: {}, im, security: {} },
      llm: {}, mcpManager: { toolDefs: () => [] }, experts: [], expertTeams: [],
    }).toolList(0, "craft").map((t) => t.name);
    ok(!mk({}).includes("notify_user"), "★没配群机器人就不挂★ 挂了就是一个必然失败的工具");
    ok(mk({ wecom_bot_webhook: "https://example.invalid/x" }).includes("notify_user"), "配了企业微信就挂上");
    ok(mk({ dingtalk_webhook: "https://example.invalid/x" }).includes("notify_user"), "配了钉钉也挂上");
    ok(!mk({ wecom_bot_webhook: "" }).includes("notify_user"), "反向对照：地址是空串不算配了");
    // 推送成功与否只能看返回的数组：pushBots 单通道失败只写一行 console.warn 就咽了。
    // 不看它就会出现「工具说成功、群里什么都没有」——比报错更难查
    eq(await notify.pushBots({}, "x"), [], "★一个通道都没配时 pushBots 返回空数组★ 这就是「没推出去」的唯一凭据");
    const src = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    ok(/if \(!sent\.length\)/.test(src), "notify_user 真去看了这个数组，而不是只要没抛异常就报成功");
    ok(/callout\.strip\(raw\)/.test(src), "推出去之前先剥掉提示条标记——那是给界面画图标用的，进了群就是一串乱标签");
    ok(/security\.audit\("对外推送"/.test(src), "★对外推送要留痕★ 出了门收不回来的动作必须进审计");
  }

  // ── ⑦ 资料库：二进制要嗅出来，素材要能落地，但不许写回 ────────────────
  console.log("\n⑦ 资料库：嗅二进制 + 取素材到工作目录");
  {
    fs.mkdirSync(LIB, { recursive: true });
    fs.writeFileSync(path.join(LIB, "偏好.md"), "# 我的偏好\n配色用深蓝。\n");
    fs.copyFileSync(path.join(WS, "汇报.docx"), path.join(LIB, "汇报.docx"));
    fs.writeFileSync(path.join(LIB, "扫描件.pdf"), Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(3000, 0x41)]));
    fs.writeFileSync(path.join(LIB, "图.png"), PNG1);

    const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-office-ws2-"));
    await tools.withWorkspace(WS2, async () => {
      const txt = await run("library_read", { name: "偏好.md" });
      eq(txt.isError, false, "文本文件照读不误");
      has(txt.content, /配色用深蓝/, "反向对照：内容也对（不是把所有东西都判成二进制）");

      const doc = await run("library_read", { name: "汇报.docx" });
      eq(doc.isError, true, "★docx 按文本读要拦下来★ 老写法回的是五万字符乱码，模型会当内容读进去");
      has(doc.content, /library_import/, "并且指出下一步：先取到工作目录");
      has(doc.content, /read_document/, "再用 read_document 读");

      const pdf = await run("library_read", { name: "扫描件.pdf" });
      eq(pdf.isError, true, "PDF 也拦");
      has(pdf.content, /pdftotext/, "PDF 指的还是那条真走得通的路");

      const img = await run("library_read", { name: "图.png" });
      eq(img.isError, true, "图片也拦");
      has(img.content, /look_at_image/, "图片指向 look_at_image");

      const gone = await run("library_read", { name: "没有这个.md" });
      eq(gone.isError, true, "名字对不上按失败报");
      ok(!/\/Users\/|\/home\/|\/var\/folders/.test(gone.content),
        "★报错里不许带出本机绝对路径★ 原来的 ENOENT 会把整条路径抖进对话", gone.content);

      const escape = await run("library_read", { name: "../config.json" });
      eq(escape.isError, true, "★路径逃逸进不去★ 只认 basename，跳不出资料库");

      const imp = await run("library_import", { name: "汇报.docx" });
      eq(imp.isError, false, "取素材到工作目录");
      ok(fs.existsSync(path.join(WS2, "汇报.docx")), "文件真的落到了工作目录", fs.readdirSync(WS2));
      const again = await run("library_import", { name: "汇报.docx" });
      has(again.content, /汇报_2\.docx/, "★重名不覆盖★ 工作目录里可能已经躺着用户自己的同名文件");
      ok(fs.existsSync(path.join(WS2, "汇报_2.docx")), "改名后的那份也在");

      const impGone = await run("library_import", { name: "没有.pdf" });
      eq(impGone.isError, true, "反向对照：库里没有的取不来");
      ok(!/\/Users\/|\/home\/|\/var\/folders/.test(impGone.content), "这里同样不带出绝对路径", impGone.content);

      // 取进来之后，read_document 就真能读它了——这一条才是 library_import 存在的理由
      const after = await run("read_document", { path: "汇报.docx" });
      eq(after.isError, false, "★取进来就能用★ 素材在库里时 read_document 根本够不着它");
      has(after.content, /季度汇报/, "读到的是同一份内容");
    });
    fs.rmSync(WS2, { recursive: true, force: true });

    // 只往一个方向复制：资料库是整台服务器共用的一份，界面上非管理员挂的是「只读」角标。
    // 给 agent 开一个写回的口子，等于任何租户用户都能借它的手改公共素材架
    const names = tools.TOOL_DEFS.map((t) => t.name);
    ok(!names.some((n) => /^library_(save|write|add|upload|delete|remove)$/.test(n)),
      "★没有任何往资料库里写的工具★ 往库里放东西归平台管理员，不归 agent", names.filter((n) => n.startsWith("library_")));
    const before = fs.readdirSync(LIB).sort();
    ok(before.length === 4, "跑完这一节，资料库里还是那 4 个文件", before);
  }

  // ── ⑧ 排期表：插上插座才挂，定时任务里不许再排期 ──────────────────────
  // 「以后每天早上都…」是办公场景里最常说的一句话，可它跟别的工具有两点不一样：
  //   1. 排期是**标准规则**，批一次之后每天都算数。所以不看安全闸门的总开关，一律当场弹给用户；
  //      而且弹出去的那段话必须是人话——用户看见「0 9 * * 1-5」判断不了要不要批。
  //   2. 定时任务自己也会叫起 agent。如果那一趟还能改排期表，就是一条会自我复制的闭环：
  //      没人看着的时候，一觉醒来表里几十条。
  // 每条正向断言后面照例跟一条反向对照——闸门写成「永远挡」或「永远放」也要能被抓出来。
  console.log("\n⑧ 定时任务工具（schedule_task / list_schedules）");
  {
    const scheduler = require(path.join(ROOT, "scheduler"));
    const security = require(path.join(ROOT, "security"));
    const { createAgentRuntime } = require(path.join(ROOT, "agent"));
    const { McpManager } = require(path.join(ROOT, "mcp"));

    // 8.1 cron 说人话。说不清的一律返回空串，由调用方退回原样显示——
    //     猜错比不说更坏：用户会照着一句错的说明点「同意」
    for (const [expr, want] of [
      ["0 9 * * *", "每天 09:00"],
      ["30 18 * * *", "每天 18:30"],
      ["0 9 * * 1-5", "工作日 09:00"],
      ["30 18 * * 5", "每周五 18:30"],
      ["0 9 * * 1,3,5", "每周一、周三、周五 09:00"],
      ["0 9 * * 0", "每周日 09:00"],
      ["0 9 * * 7", "每周日 09:00"], // cron 的老规矩：0 和 7 都是周日
      ["0 9 1 * *", "每月 1 号 09:00"],
      ["*/15 * * * *", "每 15 分钟"],
      ["0 * * * *", "每小时整点"],
      ["30 * * * *", "每小时第 30 分"],
      ["0 */6 * * *", "每 6 小时（第 0 分）"],
    ]) eq(scheduler.describeCron(expr), want, `「${expr}」翻成「${want}」`);
    for (const expr of ["0 9 * 6 *", "0 9 * * 1-3", "0 9 * *", "bad", ""]) {
      eq(scheduler.describeCron(expr), "", `★说不清就给空串★「${expr}」不许瞎猜`);
    }

    // 8.2 插座没插就不摆出来
    const mkList = (mode) => createAgentRuntime({
      config: { agent: {}, im: {}, security: {} },
      llm: {}, mcpManager: new McpManager(), experts: [], expertTeams: [],
    }).toolList(0, mode).map((t) => t.name);
    ok(!scheduler.activeScheduler(), "起点：插座上还没插排期表");
    const bare = mkList("craft");
    ok(!bare.includes("schedule_task"),
      "★没有排期表就不摆 schedule_task★ 摆出来再报「这台机器上没有排期表」，模型会当成偶发失败一遍遍重试", bare);
    ok(!bare.includes("list_schedules"), "list_schedules 同理", bare);

    const SCH_FILE = path.join(HOME, "sched-test.json");
    const sch = scheduler.createScheduler({ runtime: null, onResult: () => {}, storePath: SCH_FILE });
    scheduler.setActiveScheduler(sch);
    const approvals = [];
    const realApprove = security.requestApproval;
    let answer = true;
    security.requestApproval = async (kind, text, opts) => { approvals.push({ kind, text, opts }); return answer; };
    try {
      const craft = mkList("craft");
      ok(craft.includes("schedule_task"), "★插上排期表就挂上★", craft);
      ok(craft.includes("list_schedules"), "list_schedules 也挂上", craft);
      const ask = mkList("ask");
      ok(ask.includes("list_schedules"), "只看不动的档位也答得上「我都定了些什么」", ask);
      ok(!ask.includes("schedule_task"), "★只看不动的档位不许排期★ 排期会自己跑起来，属于「动」", ask);
      const lent = require(path.join(ROOT, "engines/tool-bridge"))._internals.lentDefs().map((d) => d.name);
      ok(!lent.includes("schedule_task") && !lent.includes("list_schedules"),
        "桥给外部 CLI 引擎的那份清单里没有排期工具（桥是另一个进程，那边插座是空的）", lent);

      // 用假 LLM 把一次工具调用递进 agent 的分发口，走的是真代码路径
      const fire = async (input, opts = {}) => {
        let i = 0;
        const llm = {
          provider: "mock", model: "scripted",
          async chat() {
            return i++ === 0
              ? { text: "", toolCalls: [{ id: "s1", name: opts.tool || "schedule_task", input }], stopReason: "tool_use" }
              : { text: "好了。", toolCalls: [], stopReason: "end" };
          },
        };
        const hist = [{ role: "user", content: "排一下" }];
        await createAgentRuntime({
          config: { agent: {}, im: {}, security: {} },
          llm, mcpManager: new McpManager(), experts: [], expertTeams: [],
        }).runTask({ history: hist, emit: () => {}, sec: { gateway: false }, taskLabel: opts.taskLabel });
        return (hist.find((h) => h.role === "tool") || { results: [{}] }).results[0];
      };

      // 8.3 只看不改的那个不弹审批
      const empty = await fire({}, { tool: "list_schedules" });
      ok(!empty.isError, "空表上 list_schedules 不算出错", empty.content);
      has(empty.content, /还没排过/, "空表就直说还没排过");
      eq(approvals.length, 0, "★只看不改的不弹审批★");

      // 8.4 排期一律当场问，且弹出去的是人话
      const made = await fire({ action: "create", cron: "0 9 * * 1-5", task: "把昨天的数据整理成日报" });
      ok(!made.isError, "批准之后真排上了", made.content);
      eq(approvals.length, 1, "★排期一律当场问★ 这一趟安全闸门是关着的（gateway: false），照样要问");
      eq((approvals[0] || {}).kind, "改定时任务", "审批分类是「改定时任务」");
      has((approvals[0] || {}).text, /工作日 09:00/, "★弹给用户的是人话时间★ 只写 0 9 * * 1-5 的话，他判断不了要不要批");
      has((approvals[0] || {}).text, /把昨天的数据整理成日报/, "到点做什么也写在审批里");
      eq(sch.list().length, 1, "排期表里确实多了一条");
      eq(sch.list()[0].cron, "0 9 * * 1-5", "时间落对了");
      eq(sch.list()[0].catch_up, true, "错过默认补跑（笔记本合着盖子过一夜，晨报不该就这么没了）");

      // 8.5 自繁殖闸门：定时任务那一趟不许再动排期表
      const before = JSON.stringify(sch.list());
      const inSchedule = await fire(
        { action: "create", cron: "0 10 * * *", task: "再排一条" },
        { taskLabel: scheduler.SCHEDULE_LABEL }
      );
      eq(inSchedule.isError, true, "★定时任务里改排期被挡下★ 一条排出另一条，没人看着会越滚越多");
      has(inSchedule.content, /定时任务叫起来的/, "说清楚为什么挡，并指路去设置里改");
      eq(approvals.length, 1, "★连审批都不该弹★ 弹了就是半夜把用户叫起来点头");
      eq(JSON.stringify(sch.list()), before, "排期表一个字没动");
      // 反向对照：换个来源，同一个调用必须排得进去——否则这道闸写成「永远挡」也全绿
      const fromChat = await fire({ action: "create", cron: "0 10 * * *", task: "再排一条" }, { taskLabel: "网页任务" });
      ok(!fromChat.isError, "反向对照：普通对话里排同一条，排得进去", fromChat.content);
      eq(sch.list().length, 2, "反向对照：表里真变成两条");
      eq(((approvals[approvals.length - 1] || {}).opts || {}).source, "网页任务", "审批带上这趟活儿的来源（审计里看得出是谁叫起来的）");

      // 8.6 写坏了当场说，不许先白问一次审批
      const askedBefore = approvals.length;
      for (const [input, re, what] of [
        [{ action: "create", cron: "9 点", task: "出日报" }, /cron 写得不对/, "cron 写坏了"],
        [{ action: "create", cron: "0 9 * * *", task: "   " }, /create 要带 task/, "create 没给 task"],
        [{ action: "update", id: sch.list()[0].id }, /没给出任何要改的项/, "update 什么都没改"],
        [{ action: "update", id: sch.list()[0].id, task: "  " }, /不能改成空的/, "task 想改成空"],
        [{ action: "delete", id: "sch_根本没有这条" }, /没有 id 为/, "id 不存在"],
        [{ action: "改一下", id: sch.list()[0].id }, /action 只能是/, "action 不在枚举里"],
      ]) {
        const r = await fire(input);
        eq(r.isError, true, `${what} → 当场报错`);
        has(r.content, re, `${what} 的报错说人话`);
      }
      eq(approvals.length, askedBefore,
        "★写坏了不许先弹一次再说不行★ 用户白点一次「同意」，换来一句排不进去，是最没必要的打扰");
      eq(sch.list().length, 2, "这一路报错没碰排期表");

      // 8.7 用户拒绝 = 一个字没动，且明说别原样重试
      answer = false;
      const snapshot = JSON.stringify(sch.list());
      const refused = await fire({ action: "delete", id: (sch.list()[1] || {}).id });
      eq(refused.isError, true, "用户拒绝 → 报错回去");
      has(refused.content, /别原样重试/, "★明说别原样重试★ 不说这句，模型会当成偶发失败再弹一次");
      eq(JSON.stringify(sch.list()), snapshot, "★拒绝了就一个字没动★");
      answer = true;

      // 8.8 改 / 停 / 开 / 删都真落到表上
      const target = sch.list()[1] || { id: "(第二条没排上)" };
      const upd = await fire({ action: "update", id: target.id, cron: "30 18 * * 5", name: "周五收尾" });
      ok(!upd.isError, "改得动", upd.content);
      eq((sch.list().find((t) => t.id === target.id) || {}).cron, "30 18 * * 5", "时间真改了");
      eq((sch.list().find((t) => t.id === target.id) || {}).name, "周五收尾", "名字真改了");
      has((approvals[approvals.length - 1] || {}).text, /每周五 18:30/, "改时间的审批里也是人话");

      const off = await fire({ action: "disable", id: target.id });
      ok(!off.isError, "停得掉", off.content);
      eq((sch.list().find((t) => t.id === target.id) || {}).enabled, false, "★停用真写进表里★");
      const on = await fire({ action: "enable", id: target.id });
      ok(!on.isError, "开得回来", on.content);
      eq((sch.list().find((t) => t.id === target.id) || {}).enabled, true, "启用也真写回去了");

      // list_schedules 要把「我都定了些什么」想知道的都说全
      const listed = await fire({}, { tool: "list_schedules" });
      ok(!listed.isError, "列得出来", listed.content);
      has(listed.content, new RegExp(target.id), "带 id——不带的话模型没法改、没法删");
      has(listed.content, /周五收尾/, "带名字");
      has(listed.content, /每周五 18:30/, "带人话时间");
      has(listed.content, /到点要做的/, "带到点做什么");

      const del = await fire({ action: "delete", id: target.id });
      ok(!del.isError, "删得掉", del.content);
      eq(sch.list().length, 1, "删完只剩一条");

      // ── 8.9 只跑一次 ────────────────────────────────────────────────────
      // 用户说「五分钟后叫我去准备面试」，排出来的是一条**每天 14:00** 的 cron。
      // 根因不在模型：cron 五个字段里压根没有「一次」这个概念，模型手上只有这一个工具，
      // 只能拿「每天这个点」去近似「这个点」——一条提醒于是变成了一条每天都要响的闹钟。
      {
        const t0 = Date.now();
        // parseAt：三种写法都得认，认不出来一律抛错，绝不猜一个时刻回去
        const mins = (iso, from = t0) => Math.round((Date.parse(iso) - from) / 60000);
        eq(mins(scheduler.parseAt("+5m", t0)), 5, "「+5m」= 五分钟后");
        eq(mins(scheduler.parseAt("+5分钟", t0)), 5, "中文的「+5分钟」也认——模型多半照抄用户的说法");
        eq(mins(scheduler.parseAt("+2h", t0)), 120, "「+2h」= 两小时后");
        eq(mins(scheduler.parseAt("+1d", t0)), 1440, "「+1d」= 明天这个点");
        const at6 = new Date(scheduler.parseAt("18:00", t0));
        eq(at6.getHours() + ":" + at6.getMinutes(), "18:0", "「18:00」落在本地的 18 点整");
        ok(Date.parse(scheduler.parseAt("18:00", t0)) > t0,
          "★钟点过了就顺延到明天★ 不顺延的话「6 点叫我」在晚上说出口就是个已经过期的时刻，永远不响");
        const full = new Date(scheduler.parseAt("2026-09-20 09:30", t0));
        eq(`${full.getFullYear()}-${full.getMonth() + 1}-${full.getDate()} ${full.getHours()}:${full.getMinutes()}`, "2026-9-20 9:30",
          "★说全的时刻按本地时间读★ 直接丢给 Date 的话这串会被当成 UTC，在东八区要差 8 小时");
        for (const bad of ["五分钟", "", "later", "+999d", "25:00"]) {
          let threw = false;
          try { scheduler.parseAt(bad, t0); } catch { threw = true; }
          eq(threw, true, `★「${bad}」认不出来就抛★ 猜一个时刻回去的话，用户点的那下「同意」批的是个他没说过的时间`);
        }
        has(scheduler.describeWhen({ at: scheduler.parseAt("+5m", t0) }), /只跑一次/,
          "★人话里得写明「只跑一次」★ 只写个钟点，用户分不出这是一次还是每天");

        // 到点：放它跑，并且**同步**关掉自己
        const ONCE_FILE = path.join(HOME, "sched-once.json");
        fs.rmSync(ONCE_FILE, { force: true });
        let started = 0, release = null;
        const runtime = { runTask: () => { started++; return new Promise((r) => { release = () => r({ finalText: "叫你了" }); }); } };
        const one = scheduler.createScheduler({ runtime, onResult: () => {}, storePath: ONCE_FILE });
        try {
          const item = one.add({ name: "叫我去准备面试", at: new Date(Date.now() - 30000).toISOString(), task: "提醒我去准备面试" });
          eq(item.cron, "", "只跑一次的那条不带 cron");
          ok(item.at, "带的是 at", item);
          one.tick();
          eq(started, 1, "到点了，放它跑了一趟");
          eq(one.list()[0].enabled, false,
            "★tick 一返回就已经是关着的★ 等跑完再关的话，中间每一分钟的 tick 都看见它还开着、时刻还是过去时——一条五分钟的提醒会连着响到你手动关掉");
          ok(one.list()[0].fired_at, "留下响过的时刻");
          release();
          await new Promise((r) => setTimeout(r, 50));
          eq(started, 1, "跑完了也还是只跑过一趟");
          eq(one.runs().length, 1, "运行记录里就一条");

          // 错过太久不补：隔了两天的「五分钟后叫我」再响就是骚扰，那时候事早过去了。
          // 得换一个调度器实例来判——tick 里有「每分钟只判一次」的闸，同一分钟里第二次 tick 直接返回
          const STALE_FILE = path.join(HOME, "sched-stale.json");
          fs.rmSync(STALE_FILE, { force: true });
          const two = scheduler.createScheduler({ runtime, onResult: () => {}, storePath: STALE_FILE });
          try {
            two.add({ name: "过期的", at: new Date(Date.now() - 2 * 864e5).toISOString(), task: "早该提醒的事" });
            two.tick();
            eq(started, 1, "★错过太久就不补跑了★ 隔了两天再响，那件事早过去了");
            eq(two.list()[0].enabled, false, "照样关掉，别让它挂在那儿每分钟判一次");
            has(two.list()[0].last_result || "", /错过/, "说清楚是错过了，不是没跑");
          } finally {
            two.stop();
            fs.rmSync(STALE_FILE, { force: true });
          }

          // at 和 cron 二选一：两个都给会各跑各的，而界面上只画得下一个时间
          let both = "";
          try { one.add({ at: "+5m", cron: "0 9 * * *", task: "两个都给" }); } catch (e) { both = e.message; }
          has(both, /只能选一个/, "★at 和 cron 不许同时给★ 两个都认的话，cron 每天响一次、at 再响一次，而页面上只写得下一个");
          const flip = one.add({ cron: "0 9 * * *", task: "本来是每天" });
          one.update(flip.id, { at: "+1h" });
          eq(one.list().find((t) => t.id === flip.id).cron, "", "改成只跑一次时，原来的 cron 得清掉——留着就是两条排期挂在一个 id 上");
          one.update(flip.id, { cron: "0 9 * * *" });
          ok(!one.list().find((t) => t.id === flip.id).at, "反向对照：改回按周期跑，at 也得清掉");
        } finally {
          one.stop();
          fs.rmSync(ONCE_FILE, { force: true });
        }

        // 从模型那一头走一遍：审批卡片上得是人话，落到表里的得是 at
        const askedBefore2 = approvals.length;
        const onceMade = await fire({ action: "create", at: "+5m", task: "提醒我去准备面试", name: "五分钟后叫我" });
        ok(!onceMade.isError, "「+5m」排得进去", onceMade.content);
        has((approvals[approvals.length - 1] || {}).text, /只跑一次/,
          "★审批卡片上写明只跑一次★ 用户要能在点头之前看出这是一次还是每天");
        const made1 = sch.list().find((t) => t.name === "五分钟后叫我") || {};
        ok(made1.at, "表里落的是 at", made1);
        eq(made1.cron, "", "没有顺手塞一条 cron 进去");
        const bothErr = await fire({ action: "create", at: "+5m", cron: "0 14 * * *", task: "两个都给" });
        eq(bothErr.isError, true, "模型两个都给时当场拦下");
        eq(approvals.length, askedBefore2 + 1, "★拦下的这条不许先白问一次审批★");
        const noTime = await fire({ action: "create", task: "什么时候都没说" });
        eq(noTime.isError, true, "时间一个都没给也当场拦下");
        has(noTime.content, /at/, "报错里得点名 at——不点名的话模型只会把 cron 再写一遍");
        has(noTime.content, /每天都响/, "★顺带说明白为什么不能拿 cron 凑★ 这正是「五分钟后」变成每天 14:00 的那一步");
        sch.remove(made1.id);
      }


      // 8.10 上限兜底：审批那道闸挡的是跑飞，这条挡的是用户连点几十次「同意」
      const MAX = Number(/MAX_SCHEDULES = (\d+)/.exec(fs.readFileSync(path.join(ROOT, "agent.js"), "utf8"))[1]);
      ok(MAX > 0, "agent.js 里得有 MAX_SCHEDULES 这个上限", MAX);
      while (sch.list().length < MAX) sch.add({ cron: "0 9 * * *", task: "占位 " + sch.list().length });
      const askedAtCap = approvals.length;
      const over = await fire({ action: "create", cron: "0 9 * * *", task: "再来一条" });
      eq(over.isError, true, `满 ${MAX} 条之后排不进去`);
      has(over.content, new RegExp(String(MAX)), "报错里写清楚上限是多少");
      eq(approvals.length, askedAtCap, "撑满了也不白问一次");
      sch.remove((sch.list()[0] || {}).id);
      const again = await fire({ action: "create", cron: "0 9 * * *", task: "腾出位置就排得进去" });
      ok(!again.isError, "反向对照：腾出一个位置就又排得进去", again.content);

      // 8.11 「定时任务」这四个字是两边的暗号：server 给那一趟打这个标签，agent 靠它认出自己
      //      是被定时任务叫起来的。两个文件各写一遍字面量，迟早对不上，那道闸就静悄悄失效了
      eq(scheduler.SCHEDULE_LABEL, "定时任务", "暗号本身没改");
      const srvSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
      ok(/taskLabel:[^\n]*SCHEDULE_LABEL/.test(srvSrc),
        "★server 打标签用的是同一个常量★ 各写一遍字面量对不上时，自繁殖那道闸会静悄悄失效",
        (srvSrc.split("\n").find((l) => /taskLabel:/.test(l)) || "(没找到 taskLabel 那行)").trim());
      ok(!tools.TOOL_DEFS.some((t) => t.name === "schedule_task" || t.name === "list_schedules"),
        "排期工具不在通用工具表里（它要的是 server 起的那个实例，写死在 TOOL_DEFS 等于处处都得挂）",
        tools.TOOL_DEFS.map((t) => t.name).filter((n) => /sched/.test(n)));
    } finally {
      security.requestApproval = realApprove;
      sch.stop();
      scheduler.setActiveScheduler(null);
      fs.rmSync(SCH_FILE, { force: true });
    }
    ok(!scheduler.activeScheduler(), "收尾：插座拔回去了，别把状态漏给后面的测试");
  }

  // ── ⑨ 发邮件：白名单是硬闸，审批不看总开关，凭证一个字都不许漏出去 ──────────
  // 邮件跟推群不是一回事：群里发错了能撤回、能当场解释，邮件出了门就在别人的收件箱里躺着了。
  // 而 agent 手里同时握着 shell、联网和你的邮箱密码——万一提示词被网页里的内容带偏，
  // 第一个遭殃的就是通讯录。所以这个工具比别的多两道闸：
  //   1. 收件人白名单。用户在设置里填，填了就是硬闸，而且挡在**弹窗之前**——
  //      弹了再挡等于给「手一滑点同意」留口子，可那恰恰是白名单要防的事。
  //   2. 每封信都当场把收件人 / 主题 / 正文原样弹给用户看，**不看安全闸门的总开关**。
  // 外加一条贯穿始终的：凭证不许出现在任何一处返回值里——那些字符串下一步就进模型上下文。
  // 每条正向断言后面照例跟一条反向对照：闸门写成「永远挡」或「永远放」也要能被抓出来。
  console.log("\n⑨ 发邮件（send_email）");
  {
    const mailer = require(path.join(ROOT, "mailer"));
    const security = require(path.join(ROOT, "security"));
    const { createAgentRuntime } = require(path.join(ROOT, "agent"));
    const { McpManager } = require(path.join(ROOT, "mcp"));

    const PASS = "hunter2-很长的授权码";
    const SMTP = { host: "smtp.example.com", port: "465", user: "me@example.com", pass: PASS, from: "", allow_to: "" };
    const cfgOf = (smtp) => ({ agent: {}, im: smtp ? { smtp } : {}, security: {} });

    // 9.1 地址解析：预览里给用户看的那一份，必须跟真发出去的那一份是同一份。
    //     两边各写一套解析，迟早对不上——那比不发更糟：用户批的是 A，发出去的是 B
    eq(mailer.parseAddrs("张三 <a@b.com>, c@d.com"), ["a@b.com", "c@d.com"], "尖括号和逗号都拆得开");
    eq(mailer.parseAddrs("a@b.com c@d.com"), ["a@b.com", "c@d.com"], "★空格分隔的两个地址一个都不许丢★");
    eq(mailer.parseAddrs(["a@b.com", "a@b.com"]), ["a@b.com"], "数组进来也认，重复的去掉");
    eq(mailer.parseAddrs("John Smith a@b.com"), ["a@b.com"], "名字跟地址混在一起只留地址");
    eq(mailer.parseAddrs("没有地址"), ["没有地址"],
      "★写坏的地址要原样留下★ 悄悄丢掉的话，用户以为发了三个人，实际只发了两个");
    eq(mailer.parseAddrs(""), [], "空的就是空的");

    // 9.2 白名单规则：一个人 / 整个域（含子域），都要能写
    const wl = { allow_to: "a@b.com, @corp.com, example.org" };
    for (const [addr, want] of [
      ["a@b.com", true], ["A@B.COM", true], ["x@b.com", false],
      ["y@corp.com", true], ["z@mail.corp.com", true], ["q@example.org", true],
      ["q@notexample.org", false], ["nobody", false],
    ]) eq(mailer.addrAllowed(wl, addr), want, `白名单判 ${addr} → ${want ? "放行" : "挡住"}`);
    eq(mailer.addrAllowed({ allow_to: "" }, "anyone@anywhere.com"), true,
      "★没填白名单就不限收件人★ 否则一开箱谁都发不出去，用户会以为功能是坏的");

    // 9.3 凭证清洗：SMTP 报错经常原样回显握手内容，而这段字符串下一步就进模型上下文
    ok(!mailer.scrub(SMTP, `535 auth failed for ${PASS}`).includes(PASS), "★报错里的密码抹掉了★");
    has(mailer.scrub(SMTP, `535 auth failed for ${PASS}`), /\*{6}/, "抹成星号而不是整段删掉，还看得出这儿原本有东西");
    eq(mailer.scrub({ pass: "ab" }, "连接超时 ab"), "连接超时 ab",
      "★两三个字符的「密码」不当密码抹★ 否则正文里每个 ab 都被打码，报错反而看不懂了");
    for (const [n, want] of [[0, "0 B"], [900, "900 B"], [2048, "2.0 KB"], [20971520, "20.0 MB"]]) {
      eq(mailer.fmtBytes(n), want, `${n} 字节说成「${want}」`);
    }

    // 9.4 没配就别摆出来：摆了模型会先写一封信、调一次、吃一条「没配」、再回来重想，
    //     白烧一轮不说，用户还以为自己哪里填错了
    const mkList = (smtp, mode) => createAgentRuntime({
      config: cfgOf(smtp), llm: {}, mcpManager: new McpManager(), experts: [], expertTeams: [],
    }).toolList(0, mode).map((t) => t.name);
    ok(!mkList(null, "craft").includes("send_email"), "★没配 SMTP 就不摆 send_email★");
    ok(!mkList({ host: "smtp.example.com", user: "", pass: "" }, "craft").includes("send_email"),
      "只填了一半也不摆——三样齐了才算配好");
    const craftT = mkList(SMTP, "craft");
    ok(craftT.includes("send_email"), "★配齐了就挂上★", craftT);
    ok(!mkList(SMTP, "ask").includes("send_email"), "★只看不动的档位不许发信★ 发邮件是往外做事");
    ok(!mkList(SMTP, "plan").includes("send_email"), "出方案的档位同理");
    ok(!tools.TOOL_DEFS.some((t) => t.name === "send_email"),
      "send_email 不在通用工具表里（它要的是 server 那份 config.im.smtp）",
      tools.TOOL_DEFS.map((t) => t.name).filter((n) => /mail/.test(n)));
    const lentM = require(path.join(ROOT, "engines/tool-bridge"))._internals.lentDefs().map((d) => d.name);
    ok(!lentM.includes("send_email"), "桥给外部 CLI 引擎的清单里也没有它", lentM);
    const agentSrc = fs.readFileSync(path.join(ROOT, "agent.js"), "utf8");
    const roLine = (agentSrc.split("\n").find((l) => /const READ_ONLY_TOOLS/.test(l)) || "");
    ok(roLine && !roLine.includes("send_email"),
      "★send_email 不算「只读」★ 进了那张表就会跟别的调用并发跑，一趟发出去好几封", roLine.trim());

    // 把一次工具调用递进 agent 的分发口，走的是真代码路径
    const sent = [];
    const approvals = [];
    const realApprove = security.requestApproval;
    const realSend = mailer.send;
    let answer = true;
    let sendErr = null;
    security.requestApproval = async (kind, text, opts) => { approvals.push({ kind, text, opts }); return answer; };
    mailer.send = async (cfg, msg) => {
      sent.push({ cfg, msg });
      if (sendErr) throw new Error(sendErr);
      return { accepted: mailer.parseAddrs(msg.to), rejected: [], messageId: "<test@local>" };
    };
    const fire = async (input, smtp = SMTP) => {
      let i = 0;
      const llm = {
        provider: "mock", model: "scripted",
        async chat() {
          return i++ === 0
            ? { text: "", toolCalls: [{ id: "m1", name: "send_email", input }], stopReason: "tool_use" }
            : { text: "好了。", toolCalls: [], stopReason: "end" };
        },
      };
      const hist = [{ role: "user", content: "发封信" }];
      await createAgentRuntime({
        config: cfgOf(smtp), llm, mcpManager: new McpManager(), experts: [], expertTeams: [],
      }).runTask({ history: hist, emit: () => {}, sec: { gateway: false } });
      return (hist.find((h) => h.role === "tool") || { results: [{}] }).results[0];
    };
    const reset = () => { sent.length = 0; approvals.length = 0; answer = true; sendErr = null; };

    try {
      // 9.5 正常一封：审批弹一次、预览是人话、真发出去的跟批的是同一份
      reset();
      const good = await fire({ to: "老板 <boss@corp.com>, hr@corp.com", subject: "本周周报", body: "这周做完了三件事：……" });
      ok(!good.isError, "发得出去", good.content);
      eq(approvals.length, 1, "★弹了一次审批★");
      eq((approvals[0] || {}).kind, "发邮件", "审批那一栏写的是「发邮件」，不是工具名");
      has((approvals[0] || {}).text || "", /收件人：boss@corp\.com、hr@corp\.com/, "预览里收件人是拆好的地址，不是模型给的那串原文");
      has((approvals[0] || {}).text || "", /主题：本周周报/, "预览里有主题");
      has((approvals[0] || {}).text || "", /这周做完了三件事/, "★预览里有正文原文★ 只给个主题就点头，等于闭着眼睛签字");
      eq(sent.length, 1, "真调了一次发信");
      eq(((sent[0] || {}).msg || {}).to, ["boss@corp.com", "hr@corp.com"], "★发出去的收件人跟预览里的是同一份★");
      eq(((sent[0] || {}).msg || {}).subject, "本周周报", "主题也是同一份");
      has(good.content, /已发出/, "回给模型的话里说清楚发出去了");
      has(good.content, /boss@corp\.com/, "并且说清楚发给了谁");

      // 9.6 审批不看安全闸门的总开关：上面这一趟 sec.gateway 就是 false，照样弹了。
      //     邮件撤不回来，这是全项目里唯一一个「总开关关了也照问」的工具
      const opts0 = (approvals[0] || {}).opts;
      ok(opts0 && opts0.timeoutMs > 0, "带了等待上限，没人点就别把整条任务吊死", opts0);

      // 9.7 用户不点头 = 一个字都不发
      reset();
      answer = false;
      const no = await fire({ to: "boss@corp.com", subject: "周报", body: "正文" });
      eq(no.isError, true, "拒绝了要当失败回给模型");
      eq(sent.length, 0, "★拒绝之后一个字都没发出去★");
      has(no.content, /别原样重试/, "明确告诉模型别换个说法再来一次");

      // 9.8 白名单：挡在弹窗之前。反向对照跟在后面——名单里的那个必须照样弹、照样发
      const WL = { ...SMTP, allow_to: "@corp.com" };
      reset();
      const blocked = await fire({ to: "outsider@evil.com", subject: "周报", body: "正文" }, WL);
      eq(blocked.isError, true, "不在名单里的发不出去");
      eq(sent.length, 0, "确实没发");
      eq(approvals.length, 0, "★白名单挡在弹窗之前★ 弹了再挡，等于给「手一滑点同意」留口子");
      has(blocked.content, /白名单/, "报错里说清楚是被白名单挡的，不是网络问题");
      has(blocked.content, /别换个写法重试/, "并且堵死「改个地址绕过去」这条路");
      reset();
      const allowed = await fire({ to: "boss@corp.com", subject: "周报", body: "正文" }, WL);
      ok(!allowed.isError, "★反向对照：名单里的照样发得出去★", allowed.content);
      eq(approvals.length, 1, "而且照样要点头");
      reset();
      const mixed = await fire({ to: "boss@corp.com, outsider@evil.com", subject: "周报", body: "正文" }, WL);
      eq(mixed.isError, true, "一封信里混进一个名单外的，整封都不许发");
      eq(sent.length, 0, "★不许「把名单内的那部分发出去」★ 那等于用户批了一个名单，实际发了另一个");

      // 9.9 写坏的入参：在弹窗之前就说清楚，别浪费用户一次点头
      for (const [input, re, why] of [
        [{ to: "不是邮箱", subject: "标题", body: "正文" }, /不是合法邮箱/, "地址写坏了"],
        [{ to: "", subject: "标题", body: "正文" }, /要带 to/, "没给收件人"],
        [{ to: "a@b.com", subject: "", body: "正文" }, /要带 subject/, "没给主题"],
        [{ to: "a@b.com", subject: "标题", body: "" }, /要带 body/, "没给正文"],
      ]) {
        reset();
        const r = await fire(input);
        eq(r.isError, true, `${why}：报错`);
        has(r.content, re, `${why}：说清楚缺什么`);
        eq(approvals.length, 0, `${why}：不白弹一次窗`);
      }
      reset();
      const many = Array.from({ length: mailer.MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@corp.com`).join(",");
      const over = await fire({ to: many, subject: "标题", body: "正文" });
      eq(over.isError, true, `一次超过 ${mailer.MAX_RECIPIENTS} 个收件人就不让发`);
      has(over.content, new RegExp(String(mailer.MAX_RECIPIENTS)), "报错里写清楚上限是多少");
      eq(approvals.length, 0, "撑爆了也不白弹一次窗");
      reset();
      const justEnough = Array.from({ length: mailer.MAX_RECIPIENTS }, (_, i) => `u${i}@corp.com`).join(",");
      const okMany = await fire({ to: justEnough, subject: "标题", body: "正文" });
      ok(!okMany.isError, "★反向对照：正好卡在上限上要发得出去★", okMany.content);

      // 9.10 附件：路径过安全中心，跟 read_file 同一道闸；大小和存在与否在发信之前说清楚
      await tools.withWorkspace(WS, async () => {
        reset();
        const att = await fire({ to: "boss@corp.com", subject: "周报", body: "正文", attachments: ["汇报.docx"] });
        ok(!att.isError, "带得上工作目录里的文件", att.content);
        has((approvals[0] || {}).text || "", /附件：汇报\.docx（/, "★预览里报了附件名和大小★ 用户得知道自己批的是什么出门");
        eq((((sent[0] || {}).msg || {}).attachments || []).length, 1, "真带了一个附件");
        eq(((((sent[0] || {}).msg || {}).attachments || [])[0] || {}).filename, "汇报.docx", "附件名是文件名，不是一长串路径");
        const attPath = ((((sent[0] || {}).msg || {}).attachments || [])[0] || {}).path || "";
        ok(path.isAbsolute(attPath), "附件走的是解析好的绝对路径", attPath);

        reset();
        const gone = await fire({ to: "boss@corp.com", subject: "周报", body: "正文", attachments: ["根本没这个文件.pdf"] });
        eq(gone.isError, true, "文件不存在就别发");
        has(gone.content, /不存在/, "说清楚是文件没生成出来");
        eq(approvals.length, 0, "★附件有问题时不弹窗★ 用户点完头才发现发不出去，最没意义");

        // 越界这一条必须拿一个**真实存在**的外部文件来测。随手写个 ../../etc/passwd 看着挺像，
        // 可那条路径在这台机器上解析完根本不存在，于是「文件不存在」那道闸先答了话——
        // 安全闸拆掉了测试照样全绿。这个坑是变异测试逮出来的
        reset();
        const OUTSIDE = path.join(HOME, "工作目录外的机密.txt");
        fs.writeFileSync(OUTSIDE, "这份文件不该被带出去");
        const escRel = path.relative(WS, OUTSIDE);
        ok(escRel.startsWith(".."), "夹具自检：这条相对路径确实指向工作目录外面", escRel);
        ok(fs.existsSync(OUTSIDE), "夹具自检：外面那个文件是真存在的（不存在的话测的就是另一道闸了）");
        const esc = await fire({ to: "boss@corp.com", subject: "周报", body: "正文", attachments: [escRel] });
        eq(esc.isError, true, "★工作目录外的文件一律带不走★ 附件是把文件原样送出这台机器，比读一眼严重得多");
        has(esc.content, /被安全中心拦截/, "★挡它的是安全中心，不是「文件不存在」★ 两道闸得分清楚，否则拆了前一道也看不出来");
        ok(!/不存在/.test(esc.content), "别报成「文件不存在」——那会让模型去重新生成一份，而不是换个位置放", esc.content);
        eq(sent.length, 0, "确实没发");
        eq(approvals.length, 0, "越界的连窗都不弹");
        fs.rmSync(OUTSIDE, { force: true });
      });

      // 9.11 凭证：从头到尾一个字都不许漏出去。这些字符串下一步就进模型上下文和审计日志
      reset();
      sendErr = `535 authentication failed: bad password ${PASS}`;
      const failed = await fire({ to: "boss@corp.com", subject: "周报", body: "正文" });
      eq(failed.isError, true, "发不出去要如实报失败，不许假装成功");
      ok(!failed.content.includes(PASS), "★发信报错里夹带的密码被抹掉了★", failed.content);
      has(failed.content, /\*{6}/, "抹成星号，还看得出这儿原本有东西");
      ok(!approvals.some((a) => a.text.includes(PASS)), "★弹给用户的预览里没有密码★");
      ok(!approvals.some((a) => a.text.includes(SMTP.host)), "预览里也没有服务器地址——用户要确认的是这封信，不是这台机器");

      // 9.12 理论上走不到（没配就不摆这个工具），但 MCP / 回放能把任意工具名递进来
      reset();
      const noCfg = await fire({ to: "boss@corp.com", subject: "周报", body: "正文" }, null);
      eq(noCfg.isError, true, "没配 SMTP 时硬调也得挡住");
      eq(sent.length, 0, "确实没发");
      has(noCfg.content, /设置/, "告诉模型去哪儿让用户配，而不是干说一句「不行」");
    } finally {
      security.requestApproval = realApprove;
      mailer.send = realSend;
    }
  }

  // ── ⑩ shell 喊 command not found 时，替它说清楚缺的是什么 ────────────────
  //
  // 这一节补的是「图文成片」那条路上最常见的一次翻车：分镜都生成完了，最后一步合片
  // 撞上一句「zsh:1: command not found: ffprobe」。模型看到的只有这一句，它不知道
  // ffprobe 跟 ffmpeg 是同一个包装出来的，多半会去重试、或者换个参数再试一遍，
  // 把用户的步数和钱一起烧光，最后还是同一句话。
  //
  // 每种 shell 的喊法都不一样，而且**顺序会咬人**：bash 那条是「名字在冒号前面」，
  // 拿它去刮 zsh 的「zsh:1: command not found: ffmpeg」，捞回来的是 "1"。所以下面每种
  // 喊法都单测一遍，外加几条反向对照——认不出的命令、压根没出错的输出，都必须一个字
  // 都不加。在报错后面多说一句假话，比什么都不说更糟。
  {
    console.log("\n⑩ 缺外部工具时，把 shell 那句话翻成人话");
    const { missingBinHint, NOT_FOUND_RE } = tools._internals;
    const ZSH = "zsh:1: command not found: ffmpeg";

    has(missingBinHint(ZSH, "darwin"), /ffmpeg/, "zsh 的喊法认得出（名字在冒号后面）");
    has(missingBinHint(ZSH, "darwin"), /brew install ffmpeg/, "顺手给出这台机器上该敲的那句");
    has(missingBinHint(ZSH, "darwin"), /图文成片/, "说清楚它是干嘛用的——用不上的东西不该逼人去装");
    ok(!/\b1\b/.test(missingBinHint(ZSH, "darwin")),
      "★捞回来的是 ffmpeg 不是行号 1★ bash 那条正则要是先跑就会捞到 1，两条的先后顺序不能反",
      missingBinHint(ZSH, "darwin"));

    has(missingBinHint("bash: line 1: ffprobe: command not found", "darwin"), /ffmpeg/,
      "★bash 喊的是 ffprobe，要报成 ffmpeg★ 报 ffprobe 会让人去搜一个根本不存在的包");
    has(missingBinHint("/bin/sh: 1: pandoc: not found", "linux"), /apt install pandoc/,
      "dash/sh 的短喊法也认，装法跟着 Linux 给");
    has(missingBinHint("'soffice' is not recognized as an internal or external command", "win32"),
      /winget install LibreOffice/, "Windows cmd 的喊法也认，给的是 winget 不是 brew");

    const two = missingBinHint(ZSH + "\nzsh:1: command not found: pandoc", "darwin");
    eq(two.split("\n").length, 2, "缺两个就说两条");
    const dup = missingBinHint(ZSH + "\nzsh:1: command not found: ffprobe", "darwin");
    ok(dup.split("\n").length === 1 && /brew install ffmpeg/.test(dup),
      "同一个包被喊了两遍（ffmpeg + ffprobe），只说一次", dup);

    eq(missingBinHint("zsh:1: command not found: kubectl", "darwin"), "",
      "反向对照：不认识的命令一个字都不加——瞎猜一句装法比不猜更坑");
    eq(missingBinHint("total 8\ndrwxr-xr-x  3 u  s  96 Jan  1 00:00 .", "darwin"), "",
      "反向对照：没出错的输出不该被加料");
    eq(missingBinHint("", "darwin"), "", "反向对照：空输出不加料");
    ok(NOT_FOUND_RE.length >= 4, "四种 shell 喊法都还在表里", NOT_FOUND_RE.length);
  }

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(WS, { recursive: true, force: true });

  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("测试自己崩了：", e && e.stack || e);
  process.exit(1);
});
