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
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet("明细");
  s1.addRow(["日期", "金额", "备注"]);
  for (let i = 1; i <= 120; i++) s1.addRow([`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, i * 100, `第${i}笔`]);
  const s2 = wb.addWorksheet("汇总");
  s2.addRow(["合计", 726000]);
  await wb.xlsx.writeFile(path.join(dir, "账目.xlsx"));

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

      // 8.9 上限兜底：审批那道闸挡的是跑飞，这条挡的是用户连点几十次「同意」
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

      // 8.10 「定时任务」这四个字是两边的暗号：server 给那一趟打这个标签，agent 靠它认出自己
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

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(WS, { recursive: true, force: true });

  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("测试自己崩了：", e && e.stack || e);
  process.exit(1);
});
