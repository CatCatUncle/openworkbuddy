"use strict";
/**
 * 端到端测试 — 用"脚本化模拟 LLM"驱动 Agent 运行时完整跑一遍，不需要真实模型 API Key。
 * 覆盖：技能加载(use_skill) → 代码执行生成 Excel(run_node/exceljs) → 专家委派(delegate_to_expert
 * 子代理 write_file) → 任务收尾；以及 cron 解析、Word/PPT 库可用性。
 * 运行：npm test
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { createAgentRuntime, missingDeliverables, trimHistory, historyChars, collectSources } = require("../agent");
const { McpManager } = require("../mcp");
const { parseCron, cronMatches } = require("../scheduler");
const { getWorkspaceDir } = require("../tools");
const WORKSPACE = getWorkspaceDir();

const config = { agent: { max_steps: 10, tool_timeout_ms: 60000 } };
const experts = [
  { name: "文案写手", description: "写作", system: "你是文案写手。" },
];

const XLSX_NAME = "e2e-测试报表.xlsx";
const MD_NAME = "e2e-测试报告.md";

// ---------- 脚本化模拟 LLM ----------
// 协调者脚本：use_skill → run_node(生成xlsx) → 委派专家 → 结束
// 专家脚本：write_file(md) → 结束汇报
function makeFakeLLM() {
  let coordStep = 0;
  let expertStep = 0;
  return {
    provider: "mock",
    model: "scripted",
    async chat({ history, tools, onTextDelta }) {
      const firstUser = history.find((h) => h.role === "user");
      const isExpert = firstUser && firstUser.content.startsWith("【子任务】");
      const toolNames = tools.map((t) => t.name);

      if (isExpert) {
        expertStep++;
        assert(!toolNames.includes("delegate_to_expert"), "专家不应再有委派工具");
        if (expertStep === 1) {
          return {
            text: "我来写报告。",
            toolCalls: [{ id: "tc_e1", name: "write_file", input: { path: MD_NAME, content: "# e2e 报告\n管线验证通过。" } }],
            stopReason: "tool_use",
          };
        }
        onTextDelta && onTextDelta("报告已完成");
        return { text: `报告已完成，文件 ${MD_NAME}。`, toolCalls: [], stopReason: "end" };
      }

      coordStep++;
      if (coordStep === 1) {
        assert(toolNames.includes("use_skill"), "缺少 use_skill 工具");
        assert(toolNames.includes("delegate_to_expert"), "协调者缺少委派工具");
        assert(toolNames.includes("run_node"), "缺少 run_node 工具");
        return {
          text: "先加载 Excel 技能。",
          toolCalls: [{ id: "tc_1", name: "use_skill", input: { name: "excel-report" } }],
          stopReason: "tool_use",
        };
      }
      if (coordStep === 2) {
        // 验证上一步 use_skill 返回了技能内容
        const lastTool = history[history.length - 1];
        assert(lastTool.role === "tool" && lastTool.results[0].content.includes("exceljs"), "use_skill 未返回技能内容");
        const code = `
const ExcelJS = require("exceljs");
(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("测试");
  ws.addRow(["项目", "数量"]);
  ws.addRow(["A", 1]);
  ws.addRow(["B", 2]);
  ws.addRow(["合计", { formula: "SUM(B2:B3)" }]);
  await wb.xlsx.writeFile(${JSON.stringify(XLSX_NAME)});
  console.log("xlsx written");
})();`;
        return {
          text: "生成测试报表。",
          toolCalls: [{ id: "tc_2", name: "run_node", input: { code, purpose: "生成测试 Excel" } }],
          stopReason: "tool_use",
        };
      }
      if (coordStep === 3) {
        const lastTool = history[history.length - 1];
        assert(!lastTool.results[0].isError, "run_node 执行失败: " + lastTool.results[0].content);
        assert(lastTool.results[0].content.includes("xlsx written"), "run_node 输出不符");
        return {
          text: "委派专家写报告。",
          toolCalls: [{ id: "tc_3", name: "delegate_to_expert", input: { expert: "文案写手", task: "【子任务】写一份 e2e 报告" } }],
          stopReason: "tool_use",
        };
      }
      const lastTool = history[history.length - 1];
      assert(lastTool.results[0].content.includes("专家 文案写手 的汇报"), "委派结果缺少专家汇报");
      return { text: "全部完成。", toolCalls: [], stopReason: "end" };
    },
  };
}

// ---------- 用例 ----------
async function testAgentPipeline() {
  for (const f of [XLSX_NAME, MD_NAME]) fs.rmSync(path.join(WORKSPACE, f), { force: true });

  const runtime = createAgentRuntime({ config, llm: makeFakeLLM(), mcpManager: new McpManager(), experts });
  const events = [];
  const { finalText } = await runtime.runTask({
    history: [{ role: "user", content: "跑一遍 e2e 管线" }],
    emit: (ev) => events.push(ev),
  });

  assert.strictEqual(finalText, "全部完成。", "最终回复不符");
  assert(fs.existsSync(path.join(WORKSPACE, XLSX_NAME)), "Excel 文件未生成");
  assert(fs.existsSync(path.join(WORKSPACE, MD_NAME)), "专家写的 md 未生成");
  assert(fs.statSync(path.join(WORKSPACE, XLSX_NAME)).size > 1000, "Excel 文件大小异常");
  assert(events.some((e) => e.type === "expert_start" && e.expert === "文案写手"), "缺少 expert_start 事件");
  assert(events.some((e) => e.type === "expert_done"), "缺少 expert_done 事件");
  assert(events.some((e) => e.type === "tool_use" && e.name === "use_skill"), "缺少 use_skill 事件");
  assert(events.some((e) => e.type === "files" && e.files.length > 0), "缺少 files 事件");
  // files 事件必须带 changed（本轮真正新增/改动的文件）——前端「本次产出」卡片和历史回放都靠它
  const fileEvents = events.filter((e) => e.type === "files");
  assert(fileEvents.every((e) => Array.isArray(e.changed)), "files 事件缺少 changed 字段");
  const changedAll = new Set(fileEvents.flatMap((e) => e.changed));
  assert(changedAll.has(XLSX_NAME), `changed 里没有本轮生成的 ${XLSX_NAME}`);
  assert(changedAll.has(MD_NAME), `changed 里没有专家写的 ${MD_NAME}`);
  console.log("✅ Agent 管线：技能加载 / 代码执行 / Excel 生成 / 专家委派 / 事件流 全部通过");
}

async function testOfficeLibs() {
  const { executeTool } = require("../tools");
  const code = `
const { Document, Packer, Paragraph } = require("docx");
const pptxgen = require("pptxgenjs");
const fs = require("fs");
(async () => {
  const doc = new Document({ sections: [{ children: [new Paragraph("e2e word")] }] });
  fs.writeFileSync("e2e-测试文档.docx", await Packer.toBuffer(doc));
  const pptx = new pptxgen();
  pptx.addSlide().addText("e2e ppt", { x: 1, y: 1 });
  await pptx.writeFile({ fileName: "e2e-测试演示.pptx" });
  console.log("office ok");
})();`;
  const r = await executeTool("run_node", { code }, { timeoutMs: 60000 });
  assert(!r.isError && r.content.includes("office ok"), "Word/PPT 生成失败: " + r.content);
  assert(fs.existsSync(path.join(WORKSPACE, "e2e-测试文档.docx")), "docx 未生成");
  assert(fs.existsSync(path.join(WORKSPACE, "e2e-测试演示.pptx")), "pptx 未生成");
  console.log("✅ 办公文件库：docx / pptxgenjs 生成通过");
}

// 应用内预览的服务端拆包：docx/xlsx/pptx/zip 都是"一包 XML 打成 zip"，浏览器直接打不开。
// 这一层要能真的拆开真库生成的文件——所以不喂手搓的假样本，喂 docx/exceljs/pptxgenjs 的真产物，
// 拆出来的结构再跟写进去的内容逐条对上（写"标题一"就得回"标题一"，级别、粗体、表格一个不能丢）。
async function testPreviewExtract() {
  const { executeTool } = require("../tools");
  const { previewData } = require("../preview");
  const code = `
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } = require("docx");
const ExcelJS = require("exceljs");
const pptxgen = require("pptxgenjs");
const fs = require("fs");
(async () => {
  const cell = (t) => new TableCell({ children: [new Paragraph(t)] });
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: "第一章 总览", heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: "加粗的话", bold: true }), new TextRun("普通的话")] }),
    new Paragraph({ text: "列表条目", bullet: { level: 0 } }),
    new Table({ rows: [
      new TableRow({ children: [cell("列甲"), cell("列乙")] }),
      new TableRow({ children: [cell("1"), cell("2")] }),
    ] }),
  ] }] });
  fs.writeFileSync("e2e-预览样本.docx", await Packer.toBuffer(doc));

  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet("第一表");
  s1.addRow(["日期", "金额"]); s1.addRow(["2026-01-01", 12.5]);
  wb.addWorksheet("第二表").addRow(["只有一行"]);
  await wb.xlsx.writeFile("e2e-预览样本.xlsx");

  const pptx = new pptxgen();
  const s = pptx.addSlide();
  s.addText("演示标题", { x: 1, y: 0.5, fontSize: 32 });
  s.addText("要点一", { x: 1, y: 2 });
  s.addNotes("这是备注");
  pptx.addSlide().addText("第二页正文", { x: 1, y: 1 });
  await pptx.writeFile({ fileName: "e2e-预览样本.pptx" });
  console.log("样本齐了");
})();`;
  const gen = await executeTool("run_node", { code }, { timeoutMs: 90000 });
  assert(!gen.isError && gen.content.includes("样本齐了"), "预览样本生成失败: " + gen.content);
  const F2 = (n) => path.join(WORKSPACE, n);

  const doc = await previewData(F2("e2e-预览样本.docx"), "e2e-预览样本.docx");
  assert(doc.kind === "doc", "docx 应识别为 doc");
  const flat = doc.blocks.map((b) => (b.runs || []).map((r) => r.s).join(""));
  assert(doc.blocks.some((b) => b.t === "h" && b.lvl === 1 && (b.runs[0] || {}).s === "第一章 总览"),
    "docx 一级标题没拆出来: " + JSON.stringify(doc.blocks.slice(0, 3)));
  assert(flat.includes("加粗的话普通的话"), "docx 正文丢了: " + JSON.stringify(flat));
  const bold = doc.blocks.flatMap((b) => b.runs || []).find((r) => r.s === "加粗的话");
  assert(bold && bold.b, "docx 粗体标记丢了: " + JSON.stringify(bold));
  assert(doc.blocks.some((b) => b.t === "li" && (b.runs[0] || {}).s === "列表条目"), "docx 列表没识别成 li");
  const tbl = doc.blocks.find((b) => b.t === "table");
  assert(tbl && tbl.rows.length === 2 && tbl.rows[0][0].runs[0].s === "列甲" && tbl.rows[1][1].runs[0].s === "2",
    "docx 表格没拆对: " + JSON.stringify(tbl));

  const sheet = await previewData(F2("e2e-预览样本.xlsx"), "e2e-预览样本.xlsx");
  assert(sheet.kind === "sheet" && sheet.sheets.length === 2, "xlsx 工作表数不对: " + sheet.sheets.length);
  assert(sheet.sheets[0].name === "第一表" && sheet.sheets[0].rows[0][0] === "日期", "xlsx 表名/表头不对");
  assert(sheet.sheets[0].rows[1][1] === "12.5", "xlsx 数值单元格该转成文本: " + JSON.stringify(sheet.sheets[0].rows[1]));

  const slides = await previewData(F2("e2e-预览样本.pptx"), "e2e-预览样本.pptx");
  assert(slides.kind === "slides" && slides.total === 2, "pptx 页数不对: " + slides.total);
  assert(slides.slides[0].title === "演示标题", "pptx 标题不对: " + JSON.stringify(slides.slides[0]));
  assert(slides.slides[0].lines.some((l) => l.s === "要点一"), "pptx 正文丢了");
  assert(slides.slides[0].notes.includes("这是备注"), "pptx 备注丢了: " + slides.slides[0].notes);
  assert(!/^\d+$/.test(slides.slides[0].notes), "页码占位符混进备注了: " + slides.slides[0].notes);
  assert(slides.slides[1].title === "第二页正文", "没有标题占位符时该把首行提上来");

  // zip 列表用真库产的包（pptx 本身就是 zip），别拿自己搓的样本自证
  fs.copyFileSync(F2("e2e-预览样本.pptx"), F2("e2e-预览样本.zip"));
  const arc = await previewData(F2("e2e-预览样本.zip"), "e2e-预览样本.zip");
  assert(arc.kind === "archive" && arc.total > 5, "zip 条目数不对: " + arc.total);
  assert(arc.entries.some((e) => e.name === "[Content_Types].xml"), "zip 条目名没读对: " + JSON.stringify(arc.entries.slice(0, 3)));
  assert(arc.bytes > 0 && arc.entries.every((e) => e.size >= 0), "zip 大小字段不对");

  // 不是 zip 的东西必须报错，不能吐半截垃圾
  fs.writeFileSync(F2("e2e-预览假的.docx"), "我不是 zip");
  await assert.rejects(() => previewData(F2("e2e-预览假的.docx"), "e2e-预览假的.docx"), /zip|压缩|损坏/, "假 docx 该被拒");
  console.log("✅ 应用内预览拆包：docx 标题/粗体/列表/表格 · xlsx 多表 · pptx 标题备注 · zip 清单 · 坏文件报错");
}

// run_node 语法预检：模型最常翻车的写法是用模板字符串拼 HTML，正文里的反引号/${}/</script> 会截断字面量。
// 预检要在开进程之前拦下来，并且明确指路 write_file；同时不能误伤正常代码。
async function testNodeSyntaxPrecheck() {
  const { executeTool } = require("../tools");
  const broken = [
    'const fs = require("fs");',
    "const html = `<html><script>",
    "  el.textContent = `第 ${tab === 'a' ? 1 : 2} 页`;",
    "<" + "/script></html>`;",
    'fs.writeFileSync("e2e-不该出现.html", html);',
  ].join("\n");
  const bad = await executeTool("run_node", { code: broken }, { timeoutMs: 30000 });
  assert(bad.isError, "模板字符串截断的代码应被判为错误");
  assert(bad.content.includes("语法错误"), "预检未报语法错误: " + bad.content);
  assert(bad.content.includes("write_file"), "预检未指引改用 write_file: " + bad.content);
  assert(!fs.existsSync(path.join(WORKSPACE, "e2e-不该出现.html")), "语法错的代码不该产生任何文件");
  // 顶层 return 在 CommonJS 里合法，预检不能把它当语法错
  const ok = await executeTool("run_node", { code: 'console.log("precheck ok");\nreturn;' }, { timeoutMs: 30000 });
  assert(!ok.isError && ok.content.includes("precheck ok"), "正常代码被误拦: " + ok.content);
  console.log("✅ run_node 语法预检：模板字符串截断拦截 + 正常代码放行");
}

// zsh 的通配符没匹配上会**整条命令拒绝执行**，而模型写的是 bash 味的命令。
// 这不是"多一句报错"那么轻：真实会话里 10 次是同一个形状——探测 `ls /usr/local/bin/python*`
// 时 ls 压根没跑，只有 zsh 一句抱怨，模型分不清"没装"还是"命令挂了"；`for f in *.md`
// 没匹配上就连同后面的收尾一起不执行；`curl http://a/x?id=1` 不加引号（? 和 [] 在 zsh 里
// 也是通配符）直接不跑。所以这里守的是行为不是措辞：**命令必须真的执行到**。
async function testShellGlobCompat() {
  const tools = require("../tools");
  const run = (command) => tools.executeTool("run_shell", { command }, { timeoutMs: 30000 });

  // ① 循环里的通配符没匹配上，后面的收尾必须照跑（旧行为：整个复合命令 exit 1，收尾丢失）
  const loop = await run('for f in /nope-e2e-glob/*.zzz; do echo "$f"; done\necho 收尾跑到了');
  assert(loop.content.includes("收尾跑到了"), "通配符没匹配上把后面的收尾一起吞了: " + loop.content);
  assert(!/no matches found/.test(loop.content), "还是 zsh 在拒命令，不是命令自己报错: " + loop.content);

  // ② 没加引号的 URL —— ? 和 [] 在 zsh 里是通配符，旧行为是整条命令不执行
  // 断言必须钉在 stdout 上：zsh 拒命令时那句抱怨里也带着这个 URL，
  // 光用 includes 查全文会**假绿**——错误信息把答案抄了一遍
  const outOf = (r) => (/stdout:\n([\s\S]*?)(?:\nstderr:|\nexit code:)/.exec(r.content) || [, ""])[1];
  const url = await run("echo http://a.example/x?id=1");
  assert(outOf(url).includes("http://a.example/x?id=1"), "带 ? 的 URL 让整条命令没跑起来: " + url.content);
  const brk = await run("echo http://a.example/x?id=[1]");
  assert(outOf(brk).includes("[1]"), "带方括号的 URL 让整条命令没跑起来: " + brk.content);

  // ③ 探测可选路径：报错必须来自命令本身，模型才能分清"没这个文件"和"命令挂了"
  const probe = await run("ls /nope-e2e-glob/*.zzz 2>&1 || true\necho 探测完了");
  assert(probe.content.includes("探测完了"), "探测把后面的步骤带崩了: " + probe.content);
  assert(/No such file|does not exist|不存在/i.test(probe.content), "ls 根本没执行，报错还是 shell 发的: " + probe.content);

  // ④ 正常的通配符不能被顺带改坏：匹配得上的照样展开
  const good = await run('touch e2e-glob-a.zzz e2e-glob-b.zzz && ls e2e-glob-*.zzz | wc -l');
  assert(/\b2\b/.test(good.content), "能匹配上的通配符被改坏了: " + good.content);
  for (const n of ["e2e-glob-a.zzz", "e2e-glob-b.zzz"]) fs.rmSync(path.join(WORKSPACE, n), { force: true });

  // ⑤ 参数钉死在挑 shell 那一层，免得哪天有人把它"整理"掉（Linux 上 bash 本来就是这个行为）
  if (process.platform === "darwin") {
    const sh = tools._internals.pickShell("echo hi");
    assert(sh.bin === "/bin/zsh" && sh.args.join(" ") === "-o nonomatch -c echo hi",
      "macOS 上没带 -o nonomatch: " + JSON.stringify(sh));
  }
  console.log("✅ shell 通配符兼容：没匹配上也不拒命令（循环收尾还在·带 ?[] 的 URL 跑得起来·报错来自命令自己）· 能匹配的照常展开");
}

// 对话各自一个成果文件夹之后，有两件事必须机器盯住：
// ① 工具回执要报**真实落点**。回执只报个光秃秃的文件名等于骗模型：东西在成果子目录里，
//    模型照回执去根目录找不着，就 `cp` 一份过去"修好"这个不一致——真实会话 s_1787740619097
//    里就这么复制了 6 个文件，每个还白烧一轮 ls + 一轮 find。
// ② 判重不许误报。误报的代价不是"多显示一行"，是**把用户唯一一份文件搬进 .trash**：
//    清理按钮认的就是 dup_of 这个标记。所以"大小一样但内容不同"必须判不重，这条是数据安全线。
async function testSessionFileLayout() {
  const tools = require("../tools");
  const { savedAt, markDuplicates } = tools._internals;
  const DIR = "任务_0901_e2e判重";
  const full = path.join(WORKSPACE, DIR);

  // ① 落点：在成果子目录里就得连着目录一起报，只报文件名就是那句让模型去 cp 的假回执
  fs.mkdirSync(full, { recursive: true });
  assert.strictEqual(savedAt(full, "图.png"), `${DIR}/图.png`, "回执把成果子目录吞了，模型会去根目录找不着");
  assert.strictEqual(savedAt(WORKSPACE, "图.png"), "图.png", "落在根目录时不该硬凑出一段路径");
  assert.strictEqual(savedAt(null, "图.png"), "图.png", "没给目录时要退回裸文件名");
  assert.strictEqual(savedAt("/tmp", "图.png"), "图.png", "工作空间外的路径不该被拼成相对路径");

  try {
    const W = (rel, buf) => fs.writeFileSync(path.join(WORKSPACE, rel), buf);
    // 逐字节相同的一对：根目录那份才是副本
    W(`${DIR}/原件.zzz`, "同一份内容-e2e");
    W("e2e副本.zzz", "同一份内容-e2e");
    // 大小一模一样、内容不同的一对 —— 判重的生死线，认错就是删用户的东西
    W(`${DIR}/同大小.zzz`, "AAAA");
    W("e2e同大小.zzz", "BBBB");
    // 根目录独有的：没有任何原件，永远不许标
    W("e2e独有.zzz", "只有这一份-e2e");
    // 0 字节：人人都一样，那不叫重复
    W(`${DIR}/空.zzz`, "");
    W("e2e空.zzz", "");

    const by = Object.fromEntries(tools.outputFiles().map((f) => [f.name, f]));
    assert.strictEqual(by["e2e副本.zzz"].dup_of, `${DIR}/原件.zzz`,
      "逐字节相同的副本没认出来: " + JSON.stringify(by["e2e副本.zzz"]));
    assert(!by["e2e同大小.zzz"].dup_of,
      "大小撞车就当成重复了——这会把用户唯一一份文件搬进 .trash: " + JSON.stringify(by["e2e同大小.zzz"]));
    assert(!by["e2e独有.zzz"].dup_of, "根目录独有的文件被标成了重复");
    // 0 字节这条是双保险（进池子和取哈希各挡一次），拆掉任意一处都还是绿的，得两处一起拆才红
    assert(!by["e2e空.zzz"].dup_of, "0 字节文件被当成重复了");
    // 原件自己绝不能被标：清理按钮搬的是带标记的那些，原件一旦被标就没人留在成果文件夹里了
    assert(!by[`${DIR}/原件.zzz`].dup_of, "成果文件夹里的原件被标成了副本，清理会把两份都搬走");

    // 大小对不上就不该去读文件算哈希：这里给的两个名字都不存在，真去读就会抛
    const fake = markDuplicates([{ name: "根本没这个.zzz", size: 12 }, { name: `${DIR}/也没这个.zzz`, size: 99 }]);
    assert(!fake[0].dup_of, "大小对不上还去算哈希了");
  } finally {
    fs.rmSync(full, { recursive: true, force: true });
    for (const n of ["e2e副本.zzz", "e2e同大小.zzz", "e2e独有.zzz", "e2e空.zzz"]) {
      fs.rmSync(path.join(WORKSPACE, n), { force: true });
    }
  }
  console.log("✅ 对话成果文件夹：回执报真实落点（不是裸文件名）· 判重只认逐字节相同（大小撞车/0 字节/独有文件都不碰原件）");
}

// 成果核验闸门：声称生成的文件必须真的在、而且不能是 0 字节空壳
function testDeliverableGate() {
  const real = path.join(WORKSPACE, "e2e-核验有内容.md");
  const empty = path.join(WORKSPACE, "e2e-核验空壳.md");
  fs.writeFileSync(real, "有内容\n");
  fs.writeFileSync(empty, "");
  try {
    assert.strictEqual(missingDeliverables("已生成 e2e-核验有内容.md").length, 0, "有内容的文件不该被打回");
    const gone = missingDeliverables("已生成 e2e-根本没有这个.md");
    assert(gone.length === 1 && gone[0].why === "missing", "不存在的文件应判 missing");
    const hollow = missingDeliverables("已生成 e2e-核验空壳.md");
    assert(hollow.length === 1 && hollow[0].why === "empty", "0 字节文件应判 empty");
    // 没有"已生成/成功"这类声称时不触发核验，避免误伤正常提及文件名的回复
    assert.strictEqual(missingDeliverables("待会儿再写 e2e-根本没有这个.md").length, 0, "无声称时不该触发核验");
  } finally {
    fs.rmSync(real, { force: true });
    fs.rmSync(empty, { force: true });
  }
  console.log("✅ 成果核验闸门：缺文件 / 0 字节空壳 / 无声称不误伤");
}

// 上下文预算：老工具结果要被截短，但一条消息都不许删——OpenAI 侧 tool_calls 少了对应的 tool 应答就是 400
function testContextBudget() {
  const big = (tag) => tag + "x".repeat(20000);
  const history = [{ role: "user", content: "干活" }];
  for (let i = 0; i < 10; i++) {
    history.push({ role: "assistant", text: "", toolCalls: [{ id: `c${i}`, name: "read_file", input: {} }] });
    history.push({ role: "tool", results: [{ id: `c${i}`, content: big(`第${i}步`), isError: false }] });
  }
  const before = historyChars(history);
  const toolMsgs = history.filter((e) => e.role === "tool").length;
  assert(before > 150000, "构造的历史不够长，测不出截断");

  const saved = trimHistory(history, 70000);
  assert(saved > 0, "超预算却没截断");
  assert(historyChars(history) <= 70000, `截断后仍超预算：${historyChars(history)}`);
  assert.strictEqual(history.filter((e) => e.role === "tool").length, toolMsgs, "工具消息被删了（会导致 400）");
  const tools = history.filter((e) => e.role === "tool");
  // 最近 3 轮工具结果必须留原文：模型正需要刚做完那几步的完整输出
  for (const e of tools.slice(-3)) assert(!e.results[0].content.includes("已截断"), "最近 3 轮被误截断");
  assert(tools[0].results[0].content.includes("已截断"), "最老的工具结果没被截短");
  assert(tools[0].results[0].content.startsWith("第0步"), "截短后没保留开头，模型认不出这步干了什么");
  // 没超预算时原样不动
  const small = [{ role: "user", content: "hi" }, { role: "tool", results: [{ id: "a", content: "y".repeat(5000) }] }];
  assert.strictEqual(trimHistory(small, 70000), 0, "没超预算却动了历史");
  assert.strictEqual(small[1].results[0].content.length, 5000, "没超预算却截断了内容");
  // 分级裁剪：可重取的（read_file）先挨刀，不可重现的（run_node 输出）能留就留
  const tiered = [{ role: "user", content: "干活" }];
  const mk = (id, name) => {
    tiered.push({ role: "assistant", text: "", toolCalls: [{ id, name, input: {} }] });
    tiered.push({ role: "tool", results: [{ id, name, content: name + "y".repeat(30000), isError: false }] });
  };
  mk("t1", "run_node");
  mk("t2", "read_file");
  mk("t3", "read_file");
  mk("t4", "run_node");
  for (let i = 0; i < 3; i++) mk(`pad${i}`, "list_files"); // 垫满 keepRecent，让前 4 条都进裁剪区
  // 预算设到「裁掉两条可重取的刚好够」：run_node 的两条必须毫发无伤
  const budget = historyChars(tiered) - 50000;
  trimHistory(tiered, budget);
  const byId = {};
  for (const e of tiered) if (e.role === "tool") byId[e.results[0].id] = e.results[0].content;
  assert(byId.t2.includes("已截断") || byId.t3.includes("已截断"), "可重取的 read_file 没有先被裁");
  assert(!byId.t1.includes("已截断") && !byId.t4.includes("已截断"), "预算够时不该动 run_node 的一次性输出");
  console.log("✅ 上下文预算：老结果截短 / 最近 3 轮保原文 / 不删任何工具消息 / 可重取结果先挨刀");
}

// 工具配对自愈：带 tool_calls 的 assistant 后面必须逐个 id 跟上工具结果，缺一个就整条请求 400。
// 这对消息是分两次 push 进历史的，中间进程被 kill（重启 app、崩溃）就会留下半截——
// 会话是落盘的，于是之后每一次请求都 400，整个会话永久报废。发请求前必须自己修回来。
function testToolPairRepair() {
  const { repairToolPairs, toOpenAIMessages, toAnthropicMessages } = require("../llm")._internals;
  // 把接口那条硬规矩写成校验器，两侧各来一遍
  const badOpenAI = (msgs) => {
    const bad = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant" && m.tool_calls) {
        const want = new Set(m.tool_calls.map((t) => t.id));
        for (let j = i + 1; j < msgs.length && msgs[j].role === "tool"; j++) want.delete(msgs[j].tool_call_id);
        if (want.size) bad.push("缺结果 " + [...want]);
      }
      if (m.role === "tool") {
        let k = i - 1;
        while (k >= 0 && msgs[k].role === "tool") k--;
        const ids = k >= 0 && msgs[k].role === "assistant" ? new Set((msgs[k].tool_calls || []).map((t) => t.id)) : new Set();
        if (!ids.has(m.tool_call_id)) bad.push("孤儿结果 " + m.tool_call_id);
      }
    }
    return bad;
  };
  const badAnthropic = (msgs) => {
    const bad = [];
    for (let i = 0; i < msgs.length; i++) {
      const blocks = Array.isArray(msgs[i].content) ? msgs[i].content : [];
      if (msgs[i].role === "assistant") {
        const want = new Set(blocks.filter((b) => b.type === "tool_use").map((b) => b.id));
        if (want.size) {
          const nxt = msgs[i + 1];
          for (const b of nxt && Array.isArray(nxt.content) ? nxt.content : []) if (b.type === "tool_result") want.delete(b.tool_use_id);
          if (want.size) bad.push("缺结果 " + [...want]);
        }
      }
      if (msgs[i].role === "user") {
        const prev = msgs[i - 1];
        const ids = new Set((prev && Array.isArray(prev.content) ? prev.content : []).filter((b) => b.type === "tool_use").map((b) => b.id));
        for (const b of blocks) if (b.type === "tool_result" && !ids.has(b.tool_use_id)) bad.push("孤儿结果 " + b.tool_use_id);
      }
    }
    return bad;
  };
  const clean = (h) => assert(!badOpenAI(toOpenAIMessages("sys", h)).length && !badAnthropic(toAnthropicMessages(h)).length, "修完仍不合规：" + JSON.stringify(badOpenAI(toOpenAIMessages("sys", h))));
  const A = (id, name) => ({ role: "assistant", text: "", toolCalls: [{ id, name, input: {} }] });
  const T = (id, name) => ({ role: "tool", results: [{ id, name, content: "结果", isError: false }] });

  // 正常历史一个字都不许动，否则等于每轮都在改缓存前缀
  const good = [{ role: "user", content: "干活" }, A("a1", "read_file"), T("a1", "read_file"), { role: "assistant", text: "好了", toolCalls: [] }];
  assert.strictEqual(JSON.stringify(repairToolPairs(good)), JSON.stringify(good), "正常历史被改写了");

  // 进程被 kill 的现场：assistant 落了盘，工具结果没来得及写
  const dangling = [{ role: "user", content: "干活" }, A("a1", "read_file"), T("a1", "read_file"), A("a2", "run_shell")];
  const dr = repairToolPairs(dangling);
  assert(dr.length === 5 && dr[4].role === "tool" && dr[4].results[0].id === "a2", "悬空的 tool_calls 没补上占位");
  assert(dr[4].results[0].isError && /中断/.test(dr[4].results[0].content), "占位结果没说清是中断，模型会当成执行失败");
  clean(dangling);

  // 一批多个调用只回了一半：只补缺的，已有的原样保留
  const half = [
    { role: "user", content: "干活" },
    { role: "assistant", text: "", toolCalls: [{ id: "b1", name: "web_fetch", input: {} }, { id: "b2", name: "web_fetch", input: {} }, { id: "b3", name: "web_fetch", input: {} }] },
    { role: "tool", results: [{ id: "b1", name: "web_fetch", content: "真结果", isError: false }] },
  ];
  const hr = repairToolPairs(half);
  assert.strictEqual(hr[2].results.map((r) => r.id).join(), "b1,b2,b3", "半批没补齐");
  assert.strictEqual(hr[2].results[0].content, "真结果", "已有的结果被改写了");
  clean(half);

  // 孤儿结果（有 tool_result 没有 tool_use）同样是 400，得丢掉
  const orphan = [{ role: "user", content: "干活" }, T("zz", "read_file"), A("a1", "read_file"), T("a1", "read_file")];
  assert(!JSON.stringify(repairToolPairs(orphan)).includes("zz"), "孤儿结果没被丢掉");
  clean(orphan);

  // 插话消息不能被当成分隔符，把后面的真结果误判成孤儿
  const inter = [{ role: "user", content: "干活" }, A("a1", "read_file"), T("a1", "read_file"), { role: "user", content: "【用户插话】再加一段" }, A("a2", "write_file"), T("a2", "write_file")];
  assert.strictEqual(JSON.stringify(repairToolPairs(inter)), JSON.stringify(inter), "插话历史被改写了");

  console.log("✅ 工具配对自愈：进程被 kill 留下的半截对子补得回来 / 半批只补缺的 / 孤儿丢掉 / 正常历史不动");
}

// 上游一抖就白跑：生图/下载这类慢又贵的调用必须自己扛重试，指望模型重来是指望不上的
// （它通常会改用别的方案交差，用户就永远拿不到那张图）。
async function testFetchRetry() {
  const { fetchRetry, nearestTool } = require("../tools")._internals;
  const realFetch = global.fetch;
  const mk = (codes) => {
    let i = 0;
    const calls = [];
    global.fetch = async (url) => {
      const c = codes[Math.min(i++, codes.length - 1)];
      calls.push(c);
      if (c === "boom") throw new Error("socket hang up");
      if (c === "abort") { const e = new Error("timeout"); e.name = "AbortError"; throw e; }
      return { ok: c < 400, status: c };
    };
    return calls;
  };
  try {
    // 500 是临时故障，重试就好
    let calls = mk([500, 500, 200]);
    let r = await fetchRetry("u", {}, { baseMs: 1 });
    assert(r.ok && calls.length === 3, "5xx 没有重试到成功：" + JSON.stringify(calls));

    // 4xx 是参数错/没余额/内容被拒，重试多少次都是同一个答案
    calls = mk([400, 200]);
    r = await fetchRetry("u", {}, { baseMs: 1 });
    assert(!r.ok && calls.length === 1, "4xx 不该重试：" + JSON.stringify(calls));

    // 429 该退避重试
    calls = mk([429, 200]);
    r = await fetchRetry("u", {}, { baseMs: 1 });
    assert(r.ok && calls.length === 2, "429 没有退避重试");

    // 一直不好：最后一次要把真实响应还回去，错误信息不能被重试吞掉
    calls = mk([500]);
    r = await fetchRetry("u", {}, { tries: 3, baseMs: 1 });
    assert(r.status === 500 && calls.length === 3, "重试用尽后没把真实响应还回来");

    // 网络层断连也重试
    calls = mk(["boom", 200]);
    r = await fetchRetry("u", {}, { baseMs: 1 });
    assert(r.ok && calls.length === 2, "网络错误没重试");

    // 超时是上面设的总时限到了，再发一次只会立刻再失败
    calls = mk(["abort", 200]);
    await assert.rejects(() => fetchRetry("u", {}, { baseMs: 1 }), /timeout/, "超时不该重试");
    assert.strictEqual(calls.length, 1, "超时后又发了一次");
  } finally {
    global.fetch = realFetch;
  }

  // 工具名拼错：把最接近的真名直接给模型，别让它接着瞎猜
  const known = ["read_file", "write_file", "mcp__filesystem__directory_tree", "generate_image"];
  assert.strictEqual(nearestTool("directory_tree", known), "mcp__filesystem__directory_tree", "MCP 前缀被吃掉时没认出来");
  assert.strictEqual(nearestTool("read_files", known), "read_file", "近似名没认出来");
  assert.strictEqual(nearestTool("完全不沾边的东西xyz", known), "", "不像也硬猜，会把模型带沟里");
  assert.strictEqual(nearestTool("read_file", []), "", "没有工具表时不该猜");
  console.log("✅ 上游重试与工具名纠错：5xx/429/断连重试 · 4xx 与超时不重试 · 拼错的工具名给出真名");
}

// 看图：用户粘贴的截图必须真能被读懂，而且图只能随这一次请求发出去，绝不能留在对话历史里
// （历史是每一步都整份重发的，一张图能把上下文成本翻好几倍，纯文本的主模型还会直接 400 把整个会话废掉）
/**
 * check_page 的控制台判读。真实数据里它 8 次报「控制台报错」有 7 次是 Electron 自己
 * 注入的安全警告——干净页面照样报错，模型于是掉头去改一张本来没病的页面。浏览器实测那
 * 段要 Electron 才跑得起来，这里锁住判读逻辑本身（噪声过滤 + 两套事件签名 + 错/警分级）。
 */
function testCheckPageConsole() {
  const { isRuntimeNoise, readConsoleEvent, cleanConsoleText } = require("../tools")._internals;

  const ELECTRON_WARN = "%cElectron Security Warning (Insecure Content-Security-Policy) font-weight: bold; This renderer process has either no Content Security Policy set…";
  assert.ok(isRuntimeNoise("node:electron/js2c/sandbox_bundle", ELECTRON_WARN), "Electron 自己的安全警告没被认成噪声");
  assert.ok(isRuntimeNoise("", ELECTRON_WARN), "拿不到 sourceId 时也该按正文认出来");
  assert.ok(isRuntimeNoise("devtools://devtools/bundled/x.js", "随便什么"), "devtools 自己的日志没滤掉");
  assert.ok(!isRuntimeNoise("file:///Users/x/report.html", "Uncaught ReferenceError: renderChart is not defined"), "页面自己的报错被当噪声滤掉了");
  assert.ok(!isRuntimeNoise("", "接口 500，图表没渲染出来"), "页面自己打的日志被当噪声滤掉了");

  // 新签名（Electron 36+）：单个事件对象，level 是字符串
  const a = readConsoleEvent([{ level: "error", message: "boom", sourceId: "file:///a.html" }]);
  assert.strictEqual(a.level, "error", "新签名 level 读错：" + a.level);
  assert.strictEqual(a.message, "boom", "新签名 message 读错：" + a.message);
  assert.strictEqual(a.sourceId, "file:///a.html", "新签名 sourceId 读错：" + a.sourceId);

  // 老签名（已 deprecated 但 Electron 43 仍在发）：位置参数，level 是 0-3
  const b = readConsoleEvent([{}, 3, "boom2", 12, "file:///b.html"]);
  assert.strictEqual(b.level, "error", "老签名 level=3 没映射成 error：" + b.level);
  assert.strictEqual(b.message, "boom2", "老签名 message 读错：" + b.message);
  assert.strictEqual(b.sourceId, "file:///b.html", "老签名 sourceId 读错：" + b.sourceId);
  assert.strictEqual(readConsoleEvent([{}, 2, "w"]).level, "warning", "老签名 level=2 该是 warning");
  assert.strictEqual(readConsoleEvent([{}, 1, "i"]).level, "info", "老签名 level=1 该是 info");
  assert.strictEqual(readConsoleEvent([{}, 0, "v"]).level, "debug", "老签名 level=0 该是 debug");

  assert.strictEqual(cleanConsoleText("%c报错了%c  再一次"), "报错了 再一次", "%c 样式指令没清干净");
  assert.ok(cleanConsoleText("x".repeat(500)).length === 300, "超长控制台文本没截断");

  console.log("✅ check_page 控制台判读：Electron 自身警告不算数 / 新老两套签名都认 / 错与警分开");
}

async function testLookAtImage() {
  const tools = require("../tools");
  const { lookAtImage } = tools._internals;
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vision-"));
  const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  fs.writeFileSync(path.join(dir, "截图.png"), Buffer.from(PNG_1x1, "base64"));
  fs.writeFileSync(path.join(dir, "笔记.txt"), "不是图");
  const resolveFile = (rel) => path.join(dir, rel);
  const media = { vision: { base_url: "https://vision.example/v1", api_key: "k", model: "vision-model" } };
  const realFetch = global.fetch;
  try {
    // 不带问题就去看图，拿回来的只会是一段泛泛的描述，白花一次调用
    let r = await lookAtImage({ media }, { path: "截图.png" }, 30000, resolveFile);
    assert.ok(r.isError && /具体问题/.test(r.content), "没问题也让看：" + r.content);
    r = await lookAtImage({ media }, { path: "不存在.png", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /list_files/.test(r.content), "图不存在时没指路去查真实文件名：" + r.content);
    r = await lookAtImage({ media }, { path: "笔记.txt", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /不是图片/.test(r.content), "文本文件被当图发出去了：" + r.content);
    r = await lookAtImage({}, { path: "截图.png", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /视觉模型/.test(r.content), "一个渠道都没有时该让用户去配：" + r.content);

    // 正常看图：图必须在这一次请求的 body 里，答案回来是纯文本
    let seen = null;
    global.fetch = async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "一张红色的图" } }] }) };
    };
    r = await lookAtImage({ media }, { path: "截图.png", question: "什么颜色？" }, 30000, resolveFile);
    assert.strictEqual(r.isError, false, r.content);
    assert.ok(/一张红色的图/.test(r.content), "答案没带回来：" + r.content);
    assert.strictEqual(seen.url, "https://vision.example/v1/chat/completions", "接口地址拼错了：" + seen.url);
    assert.strictEqual(seen.body.model, "vision-model", "没用视觉渠道配的模型");
    const parts = seen.body.messages[0].content;
    assert.ok(parts.some((c) => c.type === "text" && c.text === "什么颜色？"), "问题没发出去");
    assert.ok(parts.some((c) => c.type === "image_url" && /^data:image\/png;base64,iVBOR/.test(c.image_url.url)), "图没随请求发出去");

    // Anthropic 渠道是另一套 body，发错了整条请求就废
    seen = null;
    r = await lookAtImage({ media: { vision: { base_url: "https://api.anthropic.com", api_key: "k", model: "claude", provider: "anthropic" } } },
      { path: "截图.png", question: "什么颜色？" }, 30000, resolveFile);
    assert.strictEqual(seen.url, "https://api.anthropic.com/v1/messages", "Anthropic 走错了地址：" + seen.url);
    assert.ok(seen.body.messages[0].content.some((c) => c.type === "image" && c.source.data.startsWith("iVBOR")), "Anthropic 的图没按 base64 source 发");

    // 主模型是纯文本模型：上游 400 说得很清楚，这时候要让用户去配视觉渠道，而不是让模型自己反复重试
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "This model does not support image" } }) });
    const fb = { visionFallback: { base_url: "https://main/v1", api_key: "k", model: "deepseek-chat" } };
    r = await lookAtImage(fb, { path: "截图.png", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /视觉模型/.test(r.content) && /不要重试/.test(r.content), "主模型看不了图时没把话说清楚：" + r.content);
    // 但用户已经配了视觉渠道，同一个 400 就是这个渠道自己的毛病，别再劝他去配一遍
    r = await lookAtImage({ media }, { path: "截图.png", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /视觉模型错误 400/.test(r.content), "已配渠道报错时说岔了：" + r.content);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 按文本读一张 png，拿回来的是几万字符乱码——既看不出东西又烧上下文，直接指路 look_at_image
  const imgInWs = path.join(WORKSPACE, "e2e-看图.png");
  fs.writeFileSync(imgInWs, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  try {
    const r = await tools.executeTool("read_file", { path: "e2e-看图.png" }, {});
    assert.ok(r.isError && /look_at_image/.test(r.content), "read_file 读图没指路：" + r.content);
  } finally {
    fs.rmSync(imgInWs, { force: true });
  }
  console.log("✅ 看图：带问题才给看 · 图只随请求发不进历史 · OpenAI/Anthropic 两种协议 · 主模型看不了图时指路去配");
}

// ---------- Agent Plugins 1.0.0 ----------
// 规范的核心是「失败隔离在最小范围」：清单里的未知字段不该否掉整个插件，
// 一个坏技能不该拖垮兄弟技能，一条坏 MCP 条目不该关掉整个 MCP 组件。
// 这些边界全靠测试钉死，不然改着改着就退化成「有问题就整个不加载」。
const plugins = require("../plugins");
const os = require("os");

function mkPlugin(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-plugin-"));
  if (spec.manifest !== null) fs.writeFileSync(path.join(root, "plugin.json"), typeof spec.manifest === "string" ? spec.manifest : JSON.stringify(spec.manifest, null, 2));
  for (const [name, body] of Object.entries(spec.skills || {})) {
    const d = path.join(root, "skills", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, body.file || "SKILL.md"), body.text);
  }
  if (spec.mcp !== undefined) fs.writeFileSync(path.join(root, "mcp.json"), typeof spec.mcp === "string" ? spec.mcp : JSON.stringify(spec.mcp, null, 2));
  return root;
}
const goodManifest = (extra = {}) => ({ $schema: plugins.PLUGIN_SCHEMA, name: "e2e-demo", ...extra });
const skillBody = (name) => ({ text: `---\nname: ${name}\ndescription: e2e 用的假技能 ${name}\n---\n\n正文 ${name}\n` });

function testPluginManifest() {
  const trash = [];
  const load = (spec) => { const r = mkPlugin(spec); trash.push(r); return plugins.loadPlugin(r); };
  try {
    // 完整合法插件
    let p = load({ manifest: goodManifest({ version: "1.2.0", license: "MIT", author: { name: "猫叔" }, keywords: ["a"] }), skills: { alpha: skillBody("alpha"), beta: skillBody("beta") } });
    assert(p.ok, "合法插件被否掉了：" + p.error);
    assert.strictEqual(p.name, "e2e-demo");
    assert.strictEqual(p.skills.length, 2, "两个技能没都发现");
    assert.strictEqual(p.manifest.license, "MIT");

    // 未知顶层字段 = 非致命：报一声、忽略、继续
    p = load({ manifest: goodManifest({ unknownField: 1 }), skills: { alpha: skillBody("alpha") } });
    assert(p.ok, "未知顶层字段不该否掉整个插件");
    assert(p.warnings.some((w) => w.includes("unknownField")), "未知字段没被报出来");
    assert.strictEqual(p.skills.length, 1, "未知字段影响了组件发现");

    // extensions 不是对象 = 非致命
    p = load({ manifest: goodManifest({ extensions: "nope" }), skills: { alpha: skillBody("alpha") } });
    assert(p.ok && p.warnings.some((w) => w.includes("extensions")), "非对象 extensions 应报警但继续");

    // 别家客户端的扩展命名空间：不认识就原样放着，绝不校验它的内容
    p = load({ manifest: goodManifest({ extensions: { "com.example.other": { anything: [1, 2] } } }) });
    assert(p.ok && p.manifest.extensions["com.example.other"], "不认识的扩展命名空间不该报错");

    // 以下每一条都必须否掉整个插件
    const fatal = [
      [{ name: "e2e-demo" }, "缺 $schema"],
      [{ $schema: "https://agent-plugins.org/schemas/9.9.9/plugin.schema.json", name: "e2e-demo" }, "不支持的 $schema 版本"],
      [{ $schema: plugins.PLUGIN_SCHEMA }, "缺 name"],
      [{ $schema: plugins.PLUGIN_SCHEMA, name: "E2E-Demo" }, "name 有大写"],
      [{ $schema: plugins.PLUGIN_SCHEMA, name: "e2e--demo" }, "name 含 --"],
      [{ $schema: plugins.PLUGIN_SCHEMA, name: "-e2e" }, "name 首字符是 -"],
      [{ $schema: plugins.PLUGIN_SCHEMA, name: "e2e", version: 5 }, "version 不是字符串"],
      [{ $schema: plugins.PLUGIN_SCHEMA, name: "e2e", author: { nickname: "x" } }, "author 有未知字段"],
    ];
    for (const [manifest, why] of fatal) {
      const r = load({ manifest, skills: { alpha: skillBody("alpha") } });
      assert(!r.ok, `${why}：应该否掉整个插件，实际通过了`);
      assert(r.error, `${why}：没给出拒绝原因`);
    }
    assert(!load({ manifest: "{ 这不是 json" }).ok, "坏 JSON 应被拒");
    assert(!load({ manifest: null }).ok, "没有 plugin.json 不算插件");

    console.log("✅ Agent Plugins 清单：必填校验 / 未知字段非致命 / 别家扩展命名空间不干涉");
  } finally {
    for (const d of trash) fs.rmSync(d, { recursive: true, force: true });
  }
}

function testPluginComponentIsolation() {
  const trash = [];
  const load = (spec) => { const r = mkPlugin(spec); trash.push(r); return plugins.loadPlugin(r); };
  try {
    // 坏技能只跳自己，兄弟技能照常加载
    let p = load({
      manifest: goodManifest(),
      skills: {
        good: skillBody("good"),
        lowercase: { file: "skill.md", text: skillBody("lowercase").text }, // 规范要求文件名正好是 SKILL.md
        nofm: { text: "没有 frontmatter，直接正文" },
        empty: { file: "README.md", text: "根本没有 SKILL.md" },
      },
    });
    assert(p.ok, "坏技能不该否掉插件");
    assert.deepStrictEqual(p.skills.map((s) => s.name), ["good"], "只有 good 该被收下，实际：" + p.skills.map((s) => s.name));
    assert(p.warnings.some((w) => w.includes("lowercase") && w.includes("SKILL.md")), "小写 skill.md 没被明确报出来");
    assert(p.warnings.some((w) => w.includes("nofm")), "缺 frontmatter 的技能没被报出来");

    // mcp.json 顶层坏 → 整个 MCP 组件失效，但技能不受影响
    p = load({
      manifest: goodManifest(),
      skills: { good: skillBody("good") },
      mcp: { $schema: plugins.MCP_SCHEMA, mcpServers: {}, extraTopLevel: 1 },
    });
    assert(p.ok && p.skills.length === 1, "mcp.json 坏了不该影响技能");
    assert.strictEqual(p.mcpServers.length, 0, "顶层非法时 MCP 组件应整体失效");
    assert(p.warnings.some((w) => w.includes("extraTopLevel")), "没说清是哪个未知顶层字段");

    // $schema 版本对不上 → MCP 组件失效
    p = load({ manifest: goodManifest(), mcp: { $schema: "https://agent-plugins.org/schemas/9.9.9/mcp.schema.json", mcpServers: {} } });
    assert(p.ok && p.mcpServers.length === 0, "mcp.json 版本不匹配应关掉 MCP 组件");

    // 单条坏 → 只跳那条，好的兄弟条目照常
    p = load({
      manifest: goodManifest(),
      mcp: {
        $schema: plugins.MCP_SCHEMA,
        mcpServers: {
          ok: { type: "stdio", command: "node", args: ["s.js"] },
          okhttp: { type: "streamable-http", url: "https://tools.example.com/mcp" },
          unknownTransport: { type: "carrier-pigeon", url: "https://x.example.com" },
          missingCommand: { type: "stdio", args: ["x"] },
          extraField: { type: "stdio", command: "node", nope: 1 },
          httpFieldOnStdio: { type: "stdio", command: "node", url: "https://x.example.com" },
          legacySse: { type: "sse", url: "https://x.example.com/sse" },
          insecure: { type: "streamable-http", url: "http://evil.example.com/mcp" },
        },
      },
    });
    assert(p.ok, "坏 MCP 条目不该否掉插件");
    assert.deepStrictEqual(p.mcpServers.map((s) => s.name), ["e2e-demo__ok", "e2e-demo__okhttp"], "存活条目不对：" + p.mcpServers.map((s) => s.name));
    for (const bad of ["unknownTransport", "missingCommand", "extraField", "httpFieldOnStdio", "legacySse", "insecure"]) {
      assert(p.warnings.some((w) => w.includes(bad)), `坏条目 ${bad} 没被报出来`);
    }
    console.log("✅ Agent Plugins 失败隔离：坏技能只跳自己 / 坏 MCP 条目只跳自己 / 顶层坏才整组失效");
  } finally {
    for (const d of trash) fs.rmSync(d, { recursive: true, force: true });
  }
}

function testPluginMcpRuntime() {
  const trash = [];
  const load = (spec) => { const r = mkPlugin(spec); trash.push(r); return plugins.loadPlugin(r); };
  try {
    const p = load({
      manifest: goodManifest(),
      mcp: {
        $schema: plugins.MCP_SCHEMA,
        mcpServers: {
          local: {
            type: "stdio",
            command: "./bin/server",
            args: ["--data", "${PLUGIN_DATA}", "--root", "${PLUGIN_ROOT}", "字面量${NOT_A_VAR}"],
            env: { DATA: "${PLUGIN_DATA}/x", PLAIN: "no-vars" },
            cwd: "${PLUGIN_ROOT}/bin",
          },
        },
      },
    });
    assert.strictEqual(p.mcpServers.length, 1, "合法 stdio 条目没通过");
    const s = p.mcpServers[0];
    assert.strictEqual(s.command, path.join(p.dir, "bin", "server"), "./ 开头的 command 没按插件根解析");
    assert(s.args[1] === s.pluginDataDir, "args 里的 PLUGIN_DATA 没展开");
    assert.strictEqual(s.args[3], p.dir, "args 里的 PLUGIN_ROOT 没展开");
    assert.strictEqual(s.args[4], "字面量${NOT_A_VAR}", "只有这两个占位符该展开，别的必须原样保留");
    assert.strictEqual(s.env.DATA, s.pluginDataDir + "/x", "env 值里的占位符没展开");
    assert.strictEqual(s.env.PLUGIN_ROOT, p.dir, "PLUGIN_ROOT 没注入");
    assert.strictEqual(s.env.PLUGIN_DATA, s.pluginDataDir, "PLUGIN_DATA 没注入");
    assert.strictEqual(s.cwd, path.join(p.dir, "bin"), "cwd 没展开");

    // 越界的一律拦下
    const escapes = load({
      manifest: goodManifest(),
      mcp: {
        $schema: plugins.MCP_SCHEMA,
        mcpServers: {
          escapeCmd: { type: "stdio", command: "./../../../bin/sh" },
          escapeCwd: { type: "stdio", command: "node", cwd: "./../../" },
          badCwd: { type: "stdio", command: "node", cwd: "/etc" },
          envOverride: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "/tmp" } },
        },
      },
    });
    assert.strictEqual(escapes.mcpServers.length, 0, "越界条目全都该被拦下，实际留了：" + escapes.mcpServers.map((x) => x.name));
    for (const bad of ["escapeCmd", "escapeCwd", "badCwd", "envOverride"]) {
      assert(escapes.warnings.some((w) => w.includes(bad)), `${bad} 没被拦或没报出来`);
    }
    // 裸命令走系统 PATH 查找，不该被当成路径
    const bare = load({ manifest: goodManifest(), mcp: { $schema: plugins.MCP_SCHEMA, mcpServers: { n: { type: "stdio", command: "npx" } } } });
    assert.strictEqual(bare.mcpServers[0].command, "npx", "裸命令被错误地当成路径解析了");
    assert.strictEqual(bare.mcpServers[0].cwd, bare.dir, "cwd 默认值应是插件根");

    console.log("✅ Agent Plugins MCP 运行时：占位符只在 args/env/cwd 展开 / ./ 命令按根解析 / 越界全拦");
  } finally {
    for (const d of trash) fs.rmSync(d, { recursive: true, force: true });
  }
}

// 插件带来的技能要能被 use_skill 用到，但归插件所有：技能编辑器不许改也不许删
function testPluginSkillsIntegration() {
  const dir = path.join(plugins.PLUGINS_DIR, "e2e-integration");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "skills", "e2e-plugin-skill"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ $schema: plugins.PLUGIN_SCHEMA, name: "e2e-integration" }));
  fs.writeFileSync(
    path.join(dir, "skills", "e2e-plugin-skill", "SKILL.md"),
    "---\nname: e2e-plugin-skill\ndescription: 插件带进来的技能\n---\n\n这是插件技能正文\n"
  );
  fs.writeFileSync(path.join(dir, "skills", "e2e-plugin-skill", "helper.py"), "print('x')\n");
  try {
    const skillsMgr = require("../skills");
    const all = skillsMgr.loadSkills();
    const mine = all.find((s) => s.name === "e2e-plugin-skill");
    assert(mine, "插件技能没并进技能表");
    assert.strictEqual(mine.plugin, "e2e-integration", "插件技能没标来源");
    assert(mine.content.includes("插件技能正文"), "插件技能正文没读出来");
    assert(mine.hasAssets, "自带 helper.py 应被识别为有资源目录");

    const full = skillsMgr.getSkillFull("e2e-plugin-skill");
    assert(full && full.readonly, "插件技能应标记为只读");

    for (const [fn, label] of [[() => skillsMgr.deleteSkill("e2e-plugin-skill"), "删除"], [() => skillsMgr.saveSkill({ name: "e2e-plugin-skill", content: "改了" }), "编辑"]]) {
      let threw = "";
      try { fn(); } catch (e) { threw = e.message; }
      assert(threw.includes("e2e-integration"), `${label}插件技能没被拦下（应提示去插件页卸载）`);
    }
    assert(fs.existsSync(path.join(dir, "skills", "e2e-plugin-skill", "SKILL.md")), "插件技能文件被误删了");

    // 本地同名技能优先，插件不许悄悄顶掉用户自己的
    // （注意：这里只能直接写盘造场景 —— 走 saveSkill 会被上面那道只读闸拦住）
    const localDir = path.join(skillsMgr.SKILLS_DIR, "e2e-plugin-skill");
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, "skill.md"), "---\nname: e2e-plugin-skill\ndescription: 本地版\n---\n\n本地正文\n");
    try {
      const after = skillsMgr.loadSkills().filter((s) => s.name === "e2e-plugin-skill");
      assert.strictEqual(after.length, 1, "重名技能出现了两条");
      assert(!after[0].plugin, "重名时应该是本地版胜出");
      assert(after[0].content.includes("本地正文"), "重名时读到的是插件那份正文");
    } finally {
      fs.rmSync(localDir, { recursive: true, force: true });
    }

    console.log("✅ Agent Plugins 技能接入：并入技能表 / 只读不许改删 / 重名本地优先");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(plugins.PLUGIN_DATA_ROOT, "e2e-integration"), { recursive: true, force: true });
  }
}

// 起一个假的 Streamable HTTP MCP 服务器，返回 { url, seen, close }
async function startFakeMcpHttp() {
  const http = require("http");
  const seen = { sessionEchoed: 0, protoHeader: "" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const msg = JSON.parse(body || "{}");
      if (req.headers["mcp-session-id"]) seen.sessionEchoed++;
      if (req.headers["mcp-protocol-version"]) seen.protoHeader = req.headers["mcp-protocol-version"];
      if (msg.id == null) { res.writeHead(202).end(); return; } // 通知
      const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") {
        // initialize 走普通 JSON，并下发会话 id
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-e2e" });
        res.end(JSON.stringify(reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } })));
      } else if (msg.method === "tools/list") {
        // tools/list 走 SSE，中间夹一条无关通知，客户端要能挑出 id 对上的那条
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}\n\n`);
        res.write(`data: ${JSON.stringify(reply({ tools: [{ name: "ping", description: "假工具", inputSchema: { type: "object", properties: {} } }] }))}\n\n`);
        res.end();
      } else if (msg.method === "tools/call") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply({ content: [{ type: "text", text: `pong:${msg.params.arguments.who}` }] })));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "没实现" } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

// Streamable HTTP 传输：起一个假 MCP 服务器，JSON 和 SSE 两种响应体都要能吃
async function testMcpStreamableHttp() {
  const { McpClient } = require("../mcp");
  const { url, seen, close } = await startFakeMcpHttp();
  try {
    const client = new McpClient("fake", { transport: "streamable-http", url });
    assert.strictEqual(client.kind, "streamable-http", "传输类型判定错了");
    const tools = await client.start(10000);
    assert.strictEqual(tools.length, 1, "SSE 响应里的 tools/list 没解析出来");
    assert.strictEqual(tools[0].name, "ping");
    const r = await client.callTool("ping", { who: "猫叔" }, 10000);
    assert(!r.isError && r.content === "pong:猫叔", "工具调用结果不对: " + r.content);
    assert(seen.sessionEchoed >= 2, `Mcp-Session-Id 没在后续请求里回带（只回带了 ${seen.sessionEchoed} 次）`);
    assert.strictEqual(seen.protoHeader, "2025-06-18", "协商到的协议版本没带回服务器");
    client.stop();
    console.log("✅ MCP Streamable HTTP：JSON / SSE 两种响应 + 会话 id 回带 + 协议版本协商");
  } finally {
    await close();
  }
}

// 连接器的生死：按名字停、按插件停、重连不留孤儿、修好之后旧的红字要消失
async function testMcpManagerLifecycle() {
  const { url, close } = await startFakeMcpHttp();
  const mgr = new McpManager();
  const remote = (name, plugin) => ({ name, transport: "streamable-http", url, plugin });
  const dead = { name: "dead", transport: "streamable-http", url: "http://127.0.0.1:1/mcp" };
  try {
    await mgr.startAll([remote("a"), remote("b", "demo-plug"), dead]);
    assert.strictEqual(mgr.clients.size, 2, "两台好的应该都连上");
    assert.strictEqual(mgr.failures.length, 1, "连不上的那台应该记一笔");
    assert.strictEqual(mgr.toolDefs().length, 2, "工具没按服务器数注入");

    // 重复起同名的：不该出现两个 client，也不该把旧的丢在那没人停
    const first = mgr.clients.get("a");
    await mgr.startAll([remote("a")]);
    assert.strictEqual(mgr.clients.size, 2, "重启同名服务器后数量不对");
    assert(mgr.clients.get("a") !== first, "同名重启没换成新 client");

    // 按名字停：客户端要摘掉，它那条失败记录也要一并清掉
    assert.deepStrictEqual(mgr.stop(["dead", "nobody"]), [], "dead 从来没连上，不该报告停掉了它");
    assert.strictEqual(mgr.failures.length, 0, "停掉之后旧的失败记录还挂着，界面会一直显示红字");
    assert.deepStrictEqual(mgr.stop(["a"]), ["a"], "按名字停失败");
    assert(!mgr.clients.has("a"), "停掉的服务器还在表里");

    // 按插件停：只动这个插件的
    await mgr.startAll([remote("c")]);
    assert.deepStrictEqual(mgr.stopPlugin("demo-plug"), ["b"], "按插件停没停对");
    assert.deepStrictEqual([...mgr.clients.keys()], ["c"], "按插件停误伤了别人的连接器");

    mgr.stopAll();
    assert.strictEqual(mgr.clients.size, 0, "stopAll 之后表没清空（旧版只 stop 不删，重启后会残留）");
    console.log("✅ MCP 连接器生命周期：按名/按插件停、同名重启不留孤儿、修好后失败记录清掉");
  } finally {
    mgr.stopAll();
    await close();
  }
}

// 默认技能清单：字段齐全、URL 拼得对、别混进非开源协议的条目
// 前端的 SVG 信息图渲染要真浏览器才测得准（清洗靠的是 DOM 解析、作用域靠的是真 CSS 匹配），
// 所以单独开一个 electron 子进程跑 test/frontend.js。纯服务端部署没装 electron 就跳过，不算失败。
async function testFrontendSvgFigures() {
  const { spawnSync } = require("child_process");
  let electronBin;
  try { electronBin = require("electron"); } catch { }
  if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
    console.log("⏭️  前端：未安装 electron，跳过内联 SVG 信息图测试");
    return;
  }
  const r = spawnSync(electronBin, [path.join(__dirname, "frontend.js")], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) throw new Error("前端 SVG 测试未通过：\n" + out.trim().split("\n").slice(-12).join("\n"));
  const lines = out.split("\n").filter((l) => l.startsWith("✅ 前端"));
  if (!lines.length) throw new Error("前端测试没有报告任何一组结果：\n" + out.trim().split("\n").slice(-12).join("\n"));
  for (const l of lines) console.log(l);
}

function testDefaultSkillsManifest() {
  const skillsMgr = require("../skills");
  const list = skillsMgr.listDefaultSkills();
  assert(list.length > 0, "默认技能清单是空的");
  for (const s of list) {
    for (const k of ["name", "title", "repo", "license", "author", "bytes", "why", "url"]) {
      assert(s[k] !== undefined && s[k] !== "", `默认技能 ${s.name} 缺字段 ${k}`);
    }
    // subpath 可以是空串——整个仓库就是一个技能时它本来就没有子目录
    assert(typeof s.subpath === "string", `默认技能 ${s.name} 的 subpath 不是字符串`);
    assert(/^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+(\/.+)?$/.test(s.url), `${s.name} 的上游地址拼错了: ${s.url}`);
    assert(/^(Apache-2\.0|MIT|BSD-3-Clause|CC0-1\.0)$/.test(s.license), `${s.name} 的协议「${s.license}」不在允许的开源协议白名单里`);
    assert(typeof s.installed === "boolean", `${s.name} 没标是否已安装`);
  }
  const names = list.map((s) => s.name);
  assert.strictEqual(new Set(names).size, names.length, "默认技能清单里有重名");
  console.log(`✅ 默认技能清单：${list.length} 条，协议/上游/体积字段齐全`);
}

function testCron() {
  const cron = parseCron("0 9 * * 1-5");
  assert(cron.minute.has(0) && cron.hour.has(9) && cron.dow.has(1) && cron.dow.has(5) && !cron.dow.has(0), "cron 解析错误");
  const every30 = parseCron("*/30 * * * *");
  assert(every30.minute.has(0) && every30.minute.has(30) && !every30.minute.has(15), "cron 步长解析错误");
  let threw = false;
  try { parseCron("bad cron"); } catch { threw = true; }
  assert(threw, "非法 cron 未报错");

  // 越界/写反的一律要报错。收下不报的后果最坏：界面上看它一切正常，任务却永远不触发
  for (const bad of ["70 * * * *", "* 25 * * *", "0 9 * * 8", "5-1 * * * *", "0 9 32 * *", "* * * 13 *", "*/x * * * *"]) {
    let t = false;
    try { parseCron(bad); } catch { t = true; }
    assert(t, `非法 cron「${bad}」被静默收下了，任务会永远不触发`);
  }
  // 步长 0 以前会在 for 里死循环，把 Electron 主进程连界面一起冻住
  let zeroThrew = false;
  try { parseCron("*/0 * * * *"); } catch { zeroThrew = true; }
  assert(zeroThrew, "步长 0 没被拦下（这会死循环卡死整个进程）");

  const ranged = parseCron("1-30/10 * * * *");
  assert(ranged.minute.has(1) && ranged.minute.has(11) && ranged.minute.has(21) && !ranged.minute.has(31), "范围带步长解析错误");
  assert(parseCron("5/10 * * * *").minute.has(55), "「5/10」应当是从 5 开始每 10 分钟");
  assert(parseCron("0 9 * * 7").dow.has(0), "标准 cron 里 7 也是周日");

  // 日和周都限定时，标准 cron 取「或」：每月 1 号 或 每周一
  const orCron = parseCron("0 9 1 * 1");
  const mon5th = new Date(2026, 0, 5, 9, 0);   // 周一，非 1 号
  const thu1st = new Date(2026, 0, 1, 9, 0);   // 1 号，周四
  const tue6th = new Date(2026, 0, 6, 9, 0);   // 都不是
  assert(cronMatches(orCron, mon5th) && cronMatches(orCron, thu1st) && !cronMatches(orCron, tue6th), "日/周同时限定时应取或");
  assert(!cronMatches(parseCron("0 9 * * 1"), thu1st), "只限定周时不该跟日期取或");
  console.log("✅ 定时任务：cron 解析通过（越界/步长 0/日周取或全覆盖）");
}

/** 调度器运行时：补跑、不叠跑、跑完的结果要真存下来 */
async function testSchedulerRuntime() {
  const { createScheduler } = require("../scheduler");
  // 绝不能碰真的 schedules.json
  const storePath = path.join(fs.mkdtempSync(path.join(require("os").tmpdir(), "e2e-sched-")), "schedules.json");
  let runs = [];
  let hold = null;
  const runtime = { runTask: async () => { if (hold) await hold; runs.push(Date.now()); return { finalText: "跑完了" }; } };
  const sch = createScheduler({ runtime, storePath });
  sch.stop(); // 关掉定时器，测试里手动驱动

  const daily = sch.add({ name: "晨报", cron: "0 9 * * *", task: "写晨报" });
  const noCatch = sch.add({ name: "不补的", cron: "0 9 * * *", task: "写日报", catch_up: false });
  assert.strictEqual(daily.catch_up, true, "补跑默认应该开着");
  let threw = "";
  try { sch.add({ cron: "0 9 * * *", task: "  " }); } catch (e) { threw = e.message; }
  assert(threw.includes("任务描述"), "空任务描述没被拦下");

  // 电脑从 08:00 睡到 10:00，中间的 09:00 那次谁也没执行
  const from = new Date(2026, 0, 15, 8, 0).getTime();
  const to = new Date(2026, 0, 15, 10, 0).getTime();
  const fired = sch.catchUp(from, to);
  assert.strictEqual(fired.size, 1, `错过的应当补跑 1 个（关了补跑的那个不算），实际 ${fired.size}`);
  assert(fired.has(daily.id) && !fired.has(noCatch.id), "补跑挑错了任务");
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(runs.length, 1, "补跑应当只跑一次");
  const after = sch.list().find((t) => t.id === daily.id);
  assert(after.missed_at && after.last_trigger === "补跑", "补跑没在任务上留下记录");
  assert(after.last_result === "跑完了", "执行结果没写回本体（list() 给的是副本，跑的时候要换回本体）");
  assert(JSON.parse(fs.readFileSync(storePath, "utf8")).tasks.find((t) => t.id === daily.id).last_result === "跑完了", "执行结果没落盘");

  // 一段里错过好几次也只补一次：每小时的任务睡了 5 小时，不该醒来连开 5 枪
  const hourly = sch.add({ name: "每小时", cron: "0 * * * *", task: "看一眼" });
  runs = [];
  const fired2 = sch.catchUp(new Date(2026, 0, 15, 3, 0).getTime(), new Date(2026, 0, 15, 8, 30).getTime());
  await new Promise((r) => setTimeout(r, 50));
  assert(fired2.has(hourly.id), "每小时任务错过了却没补");
  assert.strictEqual(runs.length, fired2.size, `补跑应当每个任务只跑一次，实际跑了 ${runs.length} 次`);
  assert.strictEqual(sch.list().find((t) => t.id === hourly.id).missed_at, new Date(2026, 0, 15, 8, 0).toISOString(), "补的应当是最近该跑的那次");

  // 上一次还没跑完，第二次不许叠上去
  let release;
  hold = new Promise((r) => (release = r));
  const first = sch.runOne(daily.id, "手动");
  await new Promise((r) => setTimeout(r, 10));
  assert(sch.list().find((t) => t.id === daily.id).running === true, "跑起来了却没标记 running");
  let lockMsg = "";
  await sch.runOne(daily.id, "手动").catch((e) => (lockMsg = e.message));
  assert(lockMsg.includes("正在跑"), "同一个任务被允许叠着跑了");
  release(); hold = null; await first;
  assert(!sch.list().find((t) => t.id === daily.id).running, "跑完了 running 标记没清掉");

  await assert.rejects(() => sch.runOne("sch_不存在", "手动"), /任务不存在/, "不存在的任务应当报错");
  fs.rmSync(storePath, { force: true });
  console.log("✅ 定时任务运行时：睡过头补跑一次 / 不叠跑 / 结果真落盘");
}

/**
 * 权限档位（照着 Claude Code 那套做的：档位 + 记住的批准）。
 * 这里守的是三条底线：**auto 必须等价于改造前的老行为**（不能因为加了档位把默认变严或变松）、
 * **文件黑名单在任何档位下都拦得住**（全自动不等于把 ~/.ssh 交出去）、
 * **记住的批准要按「命令+子命令」记**（批了 git status 不等于批了 git push --force）。
 */
function testPermissionModes() {
  const security = require("../security");
  const base = { ...security.DEFAULTS };
  const mode = (m) => ({ ...base, permission_mode: m });

  // 默认档就是 auto，且行为和老版本一致
  assert.strictEqual(security.permissionMode(base), "auto", "默认档位不是 auto");
  assert.strictEqual(security.permissionMode({ ...base, permission_mode: "瞎写的" }), "auto", "非法档位没有回落到 auto");
  assert.strictEqual(security.checkCommand(base, "ls -la").action, "allow");
  assert.strictEqual(security.checkCommand(base, "rm -rf ~/x").action, "ask");
  assert.strictEqual(security.checkWrite(base, "a.md").action, "allow", "auto 档不该拦写文件");

  // 只看不动：一条都不放
  assert.strictEqual(security.checkWrite(mode("plan"), "a.md").action, "deny");
  assert.strictEqual(security.checkCommand(mode("plan"), "ls").action, "deny");
  assert.strictEqual(security.checkCode(mode("plan"), "1+1").action, "deny");

  // 每步都问：普通命令也要问，而且要带上「以后别再问这类」的规则
  const askLs = security.checkCommand(mode("ask"), "ls -la");
  assert.strictEqual(askLs.action, "ask");
  assert.strictEqual(askLs.ruleKey, "ls", "ask 档给出的规则粒度不对");
  assert.strictEqual(security.checkWrite(mode("ask"), "a.md").action, "ask");
  assert.strictEqual(security.checkWrite(mode("ask"), "a.md").ruleKey, "write:*");

  // 全自动：名单外的也不问，但黑名单和用户关掉的运行时照样拦
  assert.strictEqual(security.checkCommand(mode("full"), "rm -rf ~/x").action, "allow");
  assert.strictEqual(security.checkCommand(mode("full"), "cat ~/.ssh/id_rsa").action, "ask", "全自动把文件黑名单也放过去了");
  assert.strictEqual(security.checkCode(mode("full"), 'fs.readFileSync("~/.ssh/id_rsa")').action, "ask", "全自动把代码碰黑名单也放过去了");
  assert.strictEqual(
    security.checkCommand({ ...mode("full"), runtime_python: false }, "python3 x.py").action,
    "deny",
    "用户明确关掉的运行时被全自动档打开了"
  );
  // 放行名单优先级要高于运行时开关（用户手写进名单的那条是更明确的意思表示）
  assert.strictEqual(
    security.checkCommand({ ...base, runtime_python: false, cmd_allow: ["python3 x.py"] }, "python3 x.py").action,
    "allow",
    "显式放行名单没能压过运行时开关"
  );

  // 规则粒度：批一个不等于批一片
  assert.strictEqual(security.ruleFor("git status"), "git status");
  assert.strictEqual(security.ruleFor("git push --force origin main"), "git push");
  assert.strictEqual(security.ruleFor("rm -rf ~/x"), "rm");
  assert.strictEqual(security.ruleFor("FOO=1 /bin/rm -rf ~/x"), "rm", "包装/环境变量前缀没剥干净");

  // 本会话记住的批准：批过就不再问，清掉就恢复问
  security.clearSessionAllow();
  assert.strictEqual(security.checkCommand(base, "rm -rf ~/x").action, "ask");
  security.addSessionAllow("rm");
  assert.strictEqual(security.checkCommand(base, "rm -rf ~/x").action, "allow", "本会话放行没生效");
  assert.strictEqual(security.checkCommand(base, "cat ~/.ssh/id_rsa").action, "ask", "本会话放行把黑名单也放过去了");
  security.clearSessionAllow();
  assert.strictEqual(security.checkCommand(base, "rm -rf ~/x").action, "ask", "清掉之后还在放行");

  // resolveApproval 现在返回对象，并且只有 session/always 才写进记忆
  const pending = security.requestApproval("命令", "rm -rf ~/x", { timeoutMs: 5000, rule: "删除保护", ruleKey: "rm" });
  const id = security.listApprovals().find((a) => a.ruleKey === "rm").id;
  const r1 = security.resolveApproval(id, true, "once");
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(security.listSessionAllow(), [], "once 不该被记住");
  const p2 = security.requestApproval("命令", "rm -rf ~/y", { timeoutMs: 5000, ruleKey: "rm" });
  const id2 = security.listApprovals()[0].id;
  const r2 = security.resolveApproval(id2, true, "session");
  assert.strictEqual(r2.ruleKey, "rm");
  assert.deepStrictEqual(security.listSessionAllow(), ["rm"], "session 没被记住");
  security.clearSessionAllow();
  return Promise.all([pending, p2]).then(() => {
    console.log("✅ 权限档位：auto 等价老行为 / plan 全拒 / ask 全问且带规则 / full 也压不过黑名单与关掉的运行时 / 批准按命令+子命令记");
  });
}

/**
 * 改代码这条链路：edit_file 精确替换、search_files 找调用点、read_file 只读一段。
 * 重点不是"能改"，而是**改不明白的时候必须报清楚**——匹配不到、匹配到多处，
 * 都不许闷头改一个地方了事，那是把用户的文件改坏了还告诉他成功了。
 * 丢子进程跑：要改工作目录、要改记忆目录，都不能碰真的。
 */
/**
 * 自进化闭环：信号 → 闸门 → 人审 → 打分。
 *
 * 这套东西最容易烂掉的方式不是报错，是**悄悄变成"每天往提示词里加一句正确的废话"**：
 * 归类按原文散成一堆只出现一次的条目、代码问题被写成提示词规则、同一句话叠三遍、
 * 加了规则却没人看数字有没有降。所以这里守的全是这几条：
 * 按形状归类 · 只有 prompt 类才准变规则 · 三次证据才算模式 · 重复的进不来 · 打分只看数字。
 */
function testEvolveLoop() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-evolve-"));
  const script = `
    const assert = require("assert");
    const fs = require("fs");
    const path = require("path");
    const ev = require(${JSON.stringify(path.join(__dirname, "..", "evolve.js"))});
    const DATA = process.env.WB_DATA_DIR;
    const SESS = path.join(DATA, "sessions");
    fs.mkdirSync(SESS, { recursive: true });

    const now = new Date().toISOString();
    const old = new Date(Date.now() - 60 * 86400e3).toISOString();
    const err = (name, preview) => ({ type: "tool_result", name, isError: true, preview });
    // 每一轮自己带时间戳 —— server.js 现在就是这么写盘的。没有它，"生效之后"这个窗口
    // 就只能拿会话的 updated_at 当近似，同一个会话里几个月前的失败会被算成今天的。
    const turn = (events, at = now) => [{ type: "user", text: "把这个页面改一下", at }, { type: "assistant", events, at }];

    fs.writeFileSync(path.join(SESS, "s1.json"), JSON.stringify({ updated_at: now, transcript: [
      ...turn([err("edit_file", "没找到 old_text"), err("run_shell", "未知工具：directory_tree")]),
      ...turn([err("edit_file", "没找到 old_text"), err("run_shell", "未知工具：directory_tree")]),
      ...turn([err("check_page", "引了 2 个外部资源")]),
    ] }));
    fs.writeFileSync(path.join(SESS, "s2.json"), JSON.stringify({ updated_at: now, transcript: [
      ...turn([err("edit_file", "没找到 old_text"), err("run_shell", "未知工具：directory_tree")]),
      // 真报错和 Electron 自己的噪音撞在一条 preview 里：必须判成真问题，不能归成误报把真错藏了
      ...turn([err("check_page", "引了 1 个外部资源；控制台报错 1 条：Electron Security Warning (Insecure CSP)")]),
      ...turn([err("check_page", "控制台报错 1 条：Electron Security Warning (Insecure CSP)"), err("run_shell", "未知工具：directory_tree"),
        // 写完自检顶回来：文件是写进去了，毛病在内容。别跟"改文件失败"混成一堆
        err("edit_file", "已修改 a.html：在第 3 行替换了 1 处，400 → 800 字符 ⚠️ 页面结构有问题：<body> 开 1 个、闭 0 个，对不上"),
        err("edit_file", "工具执行出错: report 是一个目录，不是文件。里面有：a.html、b.css")]),
    ] }));
    // 窗口外的会话不该被数进来
    fs.writeFileSync(path.join(SESS, "s3.json"), JSON.stringify({ updated_at: old, transcript:
      turn([err("run_shell", "zsh: no matches found: *.png")], old) }));

    let m = ev.mineSignals({ days: 14 });
    assert.strictEqual(m.turns, 6, "回合数不对：" + m.turns);
    assert.ok(!m.signals.some(s => s.key === "zsh_glob"), "窗口外的会话被数进来了");
    const by = (k) => m.signals.find(s => s.key === k);
    assert.strictEqual(m.signals[0].key, "unknown_tool:directory_tree", "信号没按次数排：" + m.signals[0].key);
    assert.strictEqual(by("unknown_tool:directory_tree").count, 4);
    assert.strictEqual(by("unknown_tool:directory_tree").actionable, "code", "调用不存在的工具被判成提示词能治");
    assert.strictEqual(by("edit_anchor_miss").count, 3);
    assert.strictEqual(by("edit_anchor_miss").rate, 0.5, "出现率算错：" + by("edit_anchor_miss").rate);
    assert.strictEqual(by("external_resource").count, 2, "真报错和 Electron 噪音撞一起时归错类了");
    assert.strictEqual(by("tool_false_alarm:check_page").count, 1);
    assert.strictEqual(by("selfcheck_reject:edit_file").count, 1, "写完自检顶回来没单独归类");
    assert.strictEqual(by("selfcheck_reject:edit_file").actionable, "prompt");
    assert.strictEqual(by("path_is_dir:edit_file").count, 1, "中文的「是一个目录」没认出来");
    // 归类的成败就看这一条：什么都没剩在"某某工具报错"那个大杂烩里，否则等于没归类
    assert.ok(!m.signals.some(s => s.key === "tool_error:edit_file"), "还有 edit_file 的错落在大杂烩桶里");
    assert.ok(by("edit_anchor_miss").samples.length && by("edit_anchor_miss").samples[0].session, "信号没带能点回去的证据");

    // 👎 落盘：同一轮改主意是改判，不是攒一堆重复记录
    ev.recordFeedback({ session: "s1", turn: 1, verdict: "down", note: "答非所问" });
    ev.recordFeedback({ session: "s1", turn: 3, verdict: "down", note: "" });
    ev.recordFeedback({ session: "s2", turn: 1, verdict: "down", note: "" });
    assert.strictEqual(ev.mineSignals({ days: 14 }).signals.find(s => s.key === "thumbs_down").count, 3);
    ev.recordFeedback({ session: "s1", turn: 1, verdict: "up" });
    assert.strictEqual(ev.readFeedback().length, 3, "同一轮反复点攒成了多条记录");
    assert.strictEqual(ev.mineSignals({ days: 14 }).signals.find(s => s.key === "thumbs_down").count, 2);
    assert.throws(() => ev.recordFeedback({ session: "s1", turn: 9, verdict: "maybe" }), /up 或 down/);

    m = ev.mineSignals({ days: 14 });
    const S = m.signals;
    const ok = { kind: "add_rule", signal: "edit_anchor_miss", rule: "改文件前先用 read_file 把要替换的那几行原样读出来，old_text 直接从读到的内容里复制，不许凭记忆写。", verify: "edit_anchor_miss 的每回合出现率应降到 0.2 以下" };
    assert.strictEqual(ev.gateProposal(ok, { signals: S, rules: [] }), null, "合规提案被误毙");

    const g = (p) => ev.gateProposal(p, { signals: S, rules: [] }) || "";
    // 闸门的第一职责：代码问题不许被写成提示词规则——加多少句"请不要调用不存在的工具"都没用
    assert.ok(g({ ...ok, signal: "unknown_tool:directory_tree" }).includes("代码"), "代码类信号被放行成规则了");
    assert.ok(g({ ...ok, signal: "external_resource" }).includes("证据"), "只有 2 次证据的信号被放行了");
    assert.ok(g({ ...ok, signal: "根本没有这个信号" }).includes("不在本次统计里"));
    assert.ok(g({ ...ok, rule: "要" .repeat(401) }).includes("超过单条上限"), "小作文规则被放行了");
    assert.ok(g({ ...ok, verify: "" }).includes("怎么验证"), "没给验收口径的提案被放行了");
    assert.ok(g({ ...ok, rule: "" }).includes("正文"));
    assert.ok(g({ kind: "retire_rule", target: "rule_不存在" }).includes("不存在"));

    // 负对照：没有规则时，注入提示词的那段必须是空的（不能是写死在提示词里的一段话）
    assert.strictEqual(ev.promptBlock(), "", "一条规则都没有却往提示词里塞东西");

    // 人审：加进来的提案在采纳之前绝不生效
    const base = { key: "edit_anchor_miss", rate: 0.9, count: 9, turns: 10, at: new Date().toISOString() };
    const [p1] = ev.addProposals([{ ...ok, signalSnapshot: S.find(s => s.key === "edit_anchor_miss"), baseline: base }]);
    assert.strictEqual(p1.status, "pending");
    assert.strictEqual(ev.promptBlock(), "", "提案还没人审就已经进提示词了");

    ev.decideProposal(p1.id, "accept", { by: "测试" });
    let block = ev.promptBlock();
    assert.ok(block.includes("自进化规则"), "采纳后没进提示词");
    assert.ok(block.includes("old_text 直接从读到的内容里复制"), "采纳后规则正文没进提示词");
    assert.strictEqual(ev.activeRules().length, 1);
    assert.throws(() => ev.decideProposal(p1.id, "reject"), /已经是/, "同一条提案能审两次");

    // 同一句话换个说法再来一遍：指纹一样就该被拦，不然提示词只会越堆越厚
    assert.ok(ev.gateProposal({ ...ok, rule: "改文件前先用 read_file 把要替换的那几行原样读出来，old_text 直接从读到的内容里复制，不许凭记忆写！！" }, { signals: S }).includes("重复"), "重复规则被放行了");

    const [p2] = ev.addProposals([{ kind: "add_rule", signal: "thumbs_down", rule: "回复末尾必须先给结论再给过程，别让人翻到最后才看见答案。", verify: "thumbs_down 出现率下降", signalSnapshot: { key: "thumbs_down", count: 3, rate: 0.5, actionable: "prompt", label: "用户点了没帮助" }, baseline: { key: "thumbs_down", rate: 0.33, count: 2, turns: 6, at: new Date().toISOString() } }]);
    ev.decideProposal(p2.id, "accept", { by: "测试" });
    assert.strictEqual(ev.activeRules().length, 2);

    // 打分只看数字：基线 0.9 → 现在 0.5 算有效；基线 0.33 → 现在 0.33 就是没起作用，该下架
    const sc = ev.scoreRules({ minTurns: 1 });
    const s1 = sc.find(x => x.signal === "edit_anchor_miss");
    const s2 = sc.find(x => x.signal === "thumbs_down");
    assert.strictEqual(s1.verdict, "有效", "降了 44% 却没判有效：" + JSON.stringify(s1));
    assert.strictEqual(s2.verdict, "没起作用", "数字没动却判成有效：" + JSON.stringify(s2));
    assert.strictEqual(s2.suggestRetire, true, "没起作用的规则没被建议下架");

    // 下架：文件挪走，提示词里当场就没了
    const rid = ev.activeRules().find(r => r.text.includes("old_text")).id;
    ev.retireRule(rid, "测试");
    assert.strictEqual(ev.activeRules().length, 1);
    assert.ok(!ev.promptBlock().includes("old_text"), "下架了还留在提示词里");
    assert.ok(fs.existsSync(path.join(DATA, "learned", "retired", rid + ".md")), "下架的规则没留档");

    // 后台跑砸了必须留痕，不许闷声吞
    ev.recordRun({ ok: false, trigger: "夜间", error: "模型超时" });
    assert.strictEqual(ev.listRuns(5)[0].ok, false);
    assert.ok(ev.listRuns(5)[0].error.includes("超时"));

    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, WB_DATA_DIR: path.join(dir, "data") },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "自进化闭环测试失败：\n" + (r.stderr || r.stdout));
  console.log("✅ 自进化：按形状归类（真报错压过工具误报·写完自检顶回来不落大杂烩）· 窗口过滤 · 👎 改判不重复 · 闸门毙掉代码类/证据不足/小作文/无验收/重复 · 提案不点头不生效 · 打分只看数字 · 下架留档 · 后台失败留痕");
}

/**
 * 自进化的时间口径：一个会话里几个月前的失败，和今天的失败，必须分得开。
 *
 * 原来 transcript 每一轮没有时间戳，挖掘器只能拿会话的 updated_at 当近似，
 * 于是**同一个会话里的每一条事件都盖同一个时间**。这不是"精度差一点"：
 * scoreRules 按"规则生效以来"开窗打分，只要这个会话今天被打开过，它里面
 * 规则生效**之前**的失败就全算进"生效之后"——规则越有效越会被判「没起作用」
 * 并建议下架，判反了。所以这里守三条：按轮过滤、没时间就不许编日期、打分只认带时间的回合。
 */
function testEvolveRecency() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-recency-"));
  const script = `
    const assert = require("assert");
    const fs = require("fs");
    const path = require("path");
    const ev = require(${JSON.stringify(path.join(__dirname, "..", "evolve.js"))});
    const SESS = path.join(process.env.WB_DATA_DIR, "sessions");
    fs.mkdirSync(SESS, { recursive: true });

    const NOW = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const OLD = NOW - 40 * 86400e3, FRESH = NOW - 3600e3;
    const err = (name, preview) => ({ type: "tool_result", name, isError: true, preview });
    const t = (at, events) => [{ type: "user", text: "改一下", at: iso(at) }, { type: "assistant", at: iso(at), events }];

    // 一个今天还在用的会话，里面既有 40 天前的失败，也有一小时前的失败
    fs.writeFileSync(path.join(SESS, "mix.json"), JSON.stringify({ updated_at: iso(NOW), transcript: [
      ...t(OLD, [err("run_shell", "zsh: no matches found: *.png")]),
      ...t(FRESH, [err("run_shell", "zsh: no matches found: *.png")]),
    ] }));

    let m = ev.mineSignals({ days: 7 });
    assert.strictEqual(m.turns, 1, "窗口是按会话切的：40 天前那轮被算进了 7 天窗口，回合数 " + m.turns);
    assert.strictEqual(m.signals.find(s => s.key === "zsh_glob").count, 1, "40 天前的失败被算成最近发生的");
    assert.strictEqual(m.signals.find(s => s.key === "zsh_glob").lastAt, FRESH,
      "lastAt 没取那一轮自己的时间，而是会话的 updated_at");
    // 这条是上面那个 1 的负对照：证明它不是"整个会话被跳过"跳出来的假绿
    assert.strictEqual(ev.mineSignals({ days: 60 }).turns, 2, "放宽窗口后两轮都该看得见");

    // 老数据一轮时间都没有：次数照数（确实发生过），但不许编出一个"最近还在犯"的日期
    fs.writeFileSync(path.join(SESS, "legacy.json"), JSON.stringify({ updated_at: iso(NOW), transcript: [
      { type: "user", text: "老会话" }, { type: "assistant", events: [err("edit_file", "没找到 old_text")] },
    ] }));
    m = ev.mineSignals({ days: 7 });
    const lg = m.signals.find(s => s.key === "edit_anchor_miss");
    assert.strictEqual(lg.count, 1, "老数据里的失败被丢掉了——它确实发生过");
    assert.strictEqual(lg.lastAt, null, "没有逐轮时间还报出 lastAt，等于凭 updated_at 编了个精确日期");
    assert.strictEqual(lg.undated, 1, "没标出这条的时间是不可信的");
    assert.strictEqual(m.undatedTurns, 1, "没统计有多少回合是时间不明的：" + m.undatedTurns);

    // datedOnly：打分问的是"规则生效**之后**表现如何"，时间不明的回合答不了这个问题
    const d = ev.mineSignals({ days: 7, datedOnly: true });
    assert.strictEqual(d.turns, 1, "datedOnly 没把时间不明的回合排除，turns=" + d.turns);
    assert.ok(!d.signals.some(s => s.key === "edit_anchor_miss"), "datedOnly 还是把时间不明的失败算了进来");

    // 兑现处：规则生效之后一次都没再犯，就不许判它「没起作用」
    const born = NOW - 2 * 86400e3;
    fs.mkdirSync(path.join(process.env.WB_DATA_DIR, "learned"), { recursive: true });
    const [p] = ev.addProposals([{
      kind: "add_rule", signal: "zsh_glob", rule: "通配符路径一律加引号，别指望 shell 帮你展开。",
      verify: "zsh_glob 出现率降到 0.1 以下",
      baseline: { key: "zsh_glob", rate: 0.5, count: 5, turns: 10, at: iso(born) },
    }]);
    ev.decideProposal(p.id, "accept", { by: "测试" });
    const r0 = ev.activeRules()[0];
    // 规则的出生时间要盖回 2 天前，才谈得上"生效之后这 2 天"
    const rf = path.join(process.env.WB_DATA_DIR, "learned", r0.id + ".md");
    fs.writeFileSync(rf, fs.readFileSync(rf, "utf8").replace(r0.meta.at, iso(born)));

    const sc = ev.scoreRules({ minTurns: 1, now: NOW }).find(x => x.signal === "zsh_glob");
    assert.ok(sc, "没给这条规则打出分来：" + JSON.stringify(ev.scoreRules({ minTurns: 1, now: NOW })));
    // 生效后这 2 天里只有 FRESH 那一轮带时间，而它正是 zsh_glob —— 所以判"没起作用"是对的。
    // 真正要守的是分母：40 天前那轮（在规则出生**之前**）绝不能被算进这 2 天里。
    assert.strictEqual(sc.turns, 1, "打分的分母把规则生效前的回合算了进来：" + sc.turns);
    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, WB_DATA_DIR: path.join(dir, "data") },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "自进化时间口径测试失败：\n" + (r.stderr || r.stdout));
  // 上面测的全是挖掘器怎么**读**时间戳，可时间戳是 server.js 写进去的。
  // 谁把 server.js 那两行的 at 删掉，上面照样全绿，然后新数据又退回"整个会话一个时间"。
  // 起不了进程内 HTTP 测试（server.js 是 require 即 listen），所以这一头钉在源码上。
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const kind of ["user", "assistant"]) {
    const m = new RegExp("sess\\.transcript\\.push\\(\\{[^}]*type: \"" + kind + "\"[^}]*\\}\\)").exec(srv);
    assert.ok(m, "server.js 里找不到写 " + kind + " 轮的那行 transcript.push");
    assert.ok(/\bat\b\s*:|\bat,|\bat\s*\}/.test(m[0]),
      "server.js 写 " + kind + " 轮时没盖时间戳，新数据会退回「整个会话共用一个时间」：" + m[0]);
  }
  console.log("✅ 自进化时间口径：窗口按轮切（老会话里的旧失败不算最近）· 没逐轮时间就不编日期 · 打分只认生效之后的回合 · 写盘那头也盖了戳");
}

/**
 * 对话成果文件夹的名字和生命周期。
 *
 * 真实数据里 24 个成果文件夹有 7 个**一个文件都没有**——纯聊天（"你是什么模型啊"）
 * 也照建一个目录。而目录不止一处会被建出来：executeTool 拿到 baseDir 就 mkdir（连
 * 只读工具也会）、脚本的 cwd 也要目录先在。逐个堵必漏，所以收口放在回合收尾：
 * 空了就撤掉，并把 sess.dir 置空——下一轮重新分配时标题已经生成好了，
 * 于是「任务_0822_你好」这种拿第一句话截出来的名字自己就没了。
 *
 * server.js 是 require 即 listen，起不了进程内 HTTP 测试，所以这里把它那两段真源码
 * 抠出来直接跑：测的是发布出去的那份代码，不是抄一份到测试里的复制品。
 */
function testTaskDirLifecycle() {
  const os = require("os");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 一、文件夹名从哪儿来 ──────────────────────────────────────
  const sm = /const src = String\(sess\.title \|\| message\)[\s\S]*?const slug = [^\n]*\n/.exec(srv);
  assert.ok(sm, "server.js 里找不到取文件夹名的那两行（assignSessionDir 被改过？）");
  const slugOf = new Function("sess", "message", sm[0] + "; return slug;");

  // 【任务类型：X】是喂给模型的前缀，起标题时早就洗掉了，文件夹名这儿漏过一次——
  // 于是真实数据里躺着「任务_0826_任务类型数据分析及可视化_3」，用户看到的是分类词，
  // 真正做的那件事（篮球减肥训练计划）一个字都没进名字
  const withTag = slugOf({}, "【任务类型：数据分析及可视化】给我做一个篮球减肥训练计划");
  assert.ok(!withTag.startsWith("任务类型"), "【任务类型：X】前缀又被当成文件夹名了：" + withTag);
  assert.ok(withTag.startsWith("给我做一个"), "洗掉前缀后没接着用真正那句话：" + withTag);
  // 有标题就用标题——这才是"按产出内容命名"的正路，第一句话只是没标题时的兜底
  assert.strictEqual(slugOf({ title: "篮球减肥训练计划" }, "【任务类型：X】随便什么"), "篮球减肥训练计划", "有标题时没优先用标题");
  assert.strictEqual(slugOf({ title: "【任务类型：数据分析】篮球减肥计划" }, ""), "篮球减肥计划", "标题里的前缀没洗");
  assert.strictEqual(slugOf({}, "！！！？？？"), "对话", "全是标点时没退回兜底名");
  assert.ok(slugOf({}, "看看 https://example.com/a/b 这个页面").indexOf("https") < 0, "网址被塞进文件夹名了");

  // ── 二、什么算"空文件夹" ──────────────────────────────────────
  const em = /function listEmptyTaskDirs\([\s\S]*?\n}/.exec(srv);
  assert.ok(em, "server.js 里找不到 listEmptyTaskDirs（被改名了？）");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-taskdir-"));
  const ws = path.join(dir, "workspace");
  fs.mkdirSync(ws);
  const mk = (n, files) => {
    fs.mkdirSync(path.join(ws, n));
    for (const f of files || []) fs.writeFileSync(path.join(ws, n, f), "x");
    fs.utimesSync(path.join(ws, n), new Date(0), new Date(Date.now() - 3600e3)); // 挪到静默期之外
  };
  try {
    mk("任务_0821_空的", []);
    mk("任务_0822_有货", ["产出.md"]);
    mk("任务_0823_只有访达垃圾", [".DS_Store"]);
    mk("我自己建的空文件夹", []);
    fs.mkdirSync(path.join(ws, "任务_0824_刚建的")); // 不改 mtime：模拟正在跑的那一轮
    fs.writeFileSync(path.join(ws, "任务_0825_其实是个文件"), "x");

    const build = (dp) => new Function("fs", "path", "getWorkspaceDir", "dataPath", em[0] + "; return listEmptyTaskDirs;")(fs, path, () => ws, dp);
    const list = build(() => ws);
    const got = list().sort();

    assert.deepStrictEqual(got, ["任务_0821_空的", "任务_0823_只有访达垃圾"], "空文件夹认错了：" + JSON.stringify(got));
    // 上面那个 deepStrictEqual 已经把下面几条包含了，但拆开写是为了失败时能一眼看出**哪一条**破了
    assert.ok(!got.includes("任务_0822_有货"), "有产出的文件夹被当成空的了——这个按钮会把用户的成果搬走");
    assert.ok(!got.includes("我自己建的空文件夹"), "碰了不是 任务_ 开头的目录，那是用户自己建的");
    assert.ok(!got.includes("任务_0825_其实是个文件"), "把同名文件当成目录了");
    // 静默期是唯一真正危险的那条：一个正在跑的回合可能刚建好目录、文件还没落盘
    assert.ok(!got.includes("任务_0824_刚建的"), "刚建出来的目录就被搬走了——正在跑的那一轮产出会被打断");
    // now 得显式给：Date.now() 截到毫秒，而 APFS 的 mtime 是纳秒，
    // 刚 mkdir 出来的目录可能"比现在还新"，静默期设 0 时会亚毫秒级地翻车
    assert.strictEqual(list({ quietMs: 0, now: Date.now() + 1000 }).length, 3, "把静默期设成 0 之后刚建的那个也该进来（证明上一条不是靠别的原因绿的）");

    // 用户自选工作目录：压根不分配成果文件夹，一个都不许碰
    assert.deepStrictEqual(build(() => path.join(dir, "别处"))(), [], "用户自选工作目录下还去扫成果文件夹");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 三、回合收尾那处收口 ──────────────────────────────────────
  // 上面测的是"判定"，可真正动手的是收尾那几行。谁把 rmdirSync 换成 rm -r，上面照样全绿。
  const sweep = /if \(taskBaseDir && sess\.dir[\s\S]*?\n  }\n/.exec(srv);
  assert.ok(sweep, "server.js 回合收尾处找不到清空文件夹那段");
  assert.ok(/rmdirSync/.test(sweep[0]), "收尾清空文件夹没用 rmdirSync");
  assert.ok(!/recursive:\s*true/.test(sweep[0]) && !/rmSync/.test(sweep[0]),
    "收尾用了递归删除——rmdirSync 删不掉非空目录，这是误判时唯一的保险，不能换：\n" + sweep[0]);
  assert.ok(/pending_uploads/.test(sweep[0]), "没排掉还有待迁移上传件的会话，用户刚拖进来的素材会被连目录一起收走");
  assert.ok(/sess\.dir = null/.test(sweep[0]), "撤掉目录后没把 sess.dir 置空，下一轮就不会用生成好的标题重起名字");

  console.log("✅ 成果文件夹：名字洗掉【任务类型】前缀·优先用生成标题 · 空文件夹回合收尾自动撤（认目录不认文件、避开刚建的、只用 rmdirSync）");
}

async function testCodingTools() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-code-"));
  const ws = path.join(dir, "ws");
  const script = `
    const assert = require("assert");
    const fs = require("fs"), path = require("path");
    const tools = require(${JSON.stringify(path.join(__dirname, "..", "tools.js"))});
    const security = require(${JSON.stringify(path.join(__dirname, "..", "security.js"))});
    const ws = ${JSON.stringify(ws)};
    tools.setWorkspaceDir(ws);
    const call = (n, i, o) => tools.executeTool(n, i, o || {});
    (async () => {
      fs.writeFileSync(path.join(ws, "app.js"), "function foo() {\\n  return 1;\\n}\\nfoo();\\nfoo();\\n");

      // 精确替换：改一处，别的不动
      let r = await call("edit_file", { path: "app.js", old_text: "return 1;", new_text: "return 2;" });
      assert.strictEqual(r.isError, false, r.content);
      assert.ok(/第 2 行/.test(r.content), "没说清楚改的是哪一行：" + r.content);
      assert.ok(fs.readFileSync(path.join(ws, "app.js"), "utf8").includes("return 2;"));

      // 匹配到多处：必须拒绝并说明白，不许挑一个改
      r = await call("edit_file", { path: "app.js", old_text: "foo()", new_text: "bar()" });
      assert.strictEqual(r.isError, true, "不唯一的替换居然成功了");
      assert.ok(/3 次|不唯一/.test(r.content), r.content);
      assert.strictEqual(fs.readFileSync(path.join(ws, "app.js"), "utf8").includes("bar()"), false, "拒绝了却还是改了文件");

      // 明确要全改才全改
      r = await call("edit_file", { path: "app.js", old_text: "foo()", new_text: "bar()", replace_all: true });
      assert.strictEqual(r.isError, false, r.content);
      assert.strictEqual((fs.readFileSync(path.join(ws, "app.js"), "utf8").match(/bar\\(\\)/g) || []).length, 3);

      // 匹配不到：要给下一步怎么办，不是干巴巴一句失败
      r = await call("edit_file", { path: "app.js", old_text: "return 42;", new_text: "x" });
      assert.strictEqual(r.isError, true);
      assert.ok(/read_file/.test(r.content), "没告诉模型下一步该干嘛：" + r.content);

      // 文件不存在 → 指向 write_file
      r = await call("edit_file", { path: "没有这个.js", old_text: "a", new_text: "b" });
      assert.strictEqual(r.isError, true);
      assert.ok(/write_file/.test(r.content), r.content);

      // 搜索：找得到、带行号、能按扩展名缩范围
      fs.mkdirSync(path.join(ws, "sub"), { recursive: true });
      fs.writeFileSync(path.join(ws, "sub", "b.md"), "调用 bar() 的说明\\n");
      fs.mkdirSync(path.join(ws, "node_modules", "junk"), { recursive: true });
      fs.writeFileSync(path.join(ws, "node_modules", "junk", "c.js"), "bar()\\n");
      r = await call("search_files", { query: "bar()" });
      assert.ok(/app\\.js:1:/.test(r.content), "搜索没带文件:行号：" + r.content);
      assert.ok(/sub\\/b\\.md/.test(r.content), "没搜子目录");
      assert.strictEqual(/node_modules/.test(r.content), false, "搜到 node_modules 里去了");
      r = await call("search_files", { query: "bar()", ext: "md" });
      assert.strictEqual(/app\\.js/.test(r.content), false, "ext 过滤没生效");
      r = await call("search_files", { query: "绝对搜不到的东西" });
      assert.ok(/没搜到/.test(r.content), r.content);

      // 只读一段 + 行号
      r = await call("read_file", { path: "app.js", start_line: 2, end_line: 2 });
      assert.ok(/^（app\\.js 第 2-2 行/.test(r.content), r.content);
      assert.ok(/2\\t\\s+return 2;/.test(r.content), "读回来的行没带原缩进和行号：" + r.content);
      r = await call("read_file", { path: "app.js", start_line: 999 });
      assert.strictEqual(r.isError, true, "越界行号该报错");

      // 列目录：depth 能一次看清
      r = await call("list_files", { depth: 2 });
      assert.ok(/sub\\/b\\.md/.test(r.content), "depth=2 没展开子目录：" + r.content);
      r = await call("list_files", {});
      assert.strictEqual(/sub\\/b\\.md/.test(r.content), false, "默认就递归了，会刷屏");

      // 覆盖已有文件要说清楚是覆盖（并提醒该用 edit_file）
      r = await call("write_file", { path: "app.js", content: "x" });
      assert.ok(/已覆盖/.test(r.content) && /edit_file/.test(r.content), r.content);
      r = await call("write_file", { path: "新的.md", content: "x" });
      assert.ok(/已新建/.test(r.content), r.content);

      // 只看不动档：写和改都要被拦住
      const plan = { ...security.DEFAULTS, permission_mode: "plan" };
      r = await call("write_file", { path: "app.js", content: "y" }, { security: plan });
      assert.strictEqual(r.isError, true, "只看不动档还能写文件");
      r = await call("edit_file", { path: "app.js", old_text: "x", new_text: "y" }, { security: plan });
      assert.strictEqual(r.isError, true, "只看不动档还能改文件");
      assert.strictEqual(fs.readFileSync(path.join(ws, "app.js"), "utf8"), "x", "被拦了文件却变了");

      // 记忆工具挂在同一条链路上
      r = await call("remember", { text: "周报只要三段：进展/问题/下周计划" }, { memory: { user: "甲" } });
      assert.strictEqual(r.isError, false, r.content);
      r = await call("remember", { text: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456" }, { memory: { user: "甲" } });
      assert.strictEqual(r.isError, true, "密钥被记进记忆了");
      r = await call("forget", { text: "周报" }, { memory: { user: "甲" } });
      assert.strictEqual(r.isError, false, r.content);
      console.log("OK");
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, WB_DATA_DIR: path.join(dir, "data") },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "改代码工具测试失败：\n" + (r.stderr || r.stdout));
  console.log("✅ 改代码工具：精确替换（不唯一/找不到都报清楚且不误改）· 全文搜索跳依赖目录 · 只读一段 · 覆盖有提示 · 只看不动档拦得住");
}

/**
 * 交付质量这条链路：写完自检 + 网页验收。
 *
 * "改完记得自检"写在提示词里是没用的，模型该忘还是忘，坏文件照样交出去。
 * 所以把自检压进工具本身：语法坏了、围栏没闭合、网页引了外链 CDN，写完当场顶回去。
 * 这里守的就是**坏东西不许被判成"已生成"**。
 */
async function testDeliverableQuality() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-deliver-"));
  const ws = path.join(dir, "ws");
  const script = `
    const assert = require("assert");
    const fs = require("fs"), path = require("path");
    const tools = require(${JSON.stringify(path.join(__dirname, "..", "tools.js"))});
    tools.setWorkspaceDir(${JSON.stringify(ws)});
    const ws = ${JSON.stringify(ws)};
    const call = (n, i) => tools.executeTool(n, i, {});
    (async () => {
      // 长文档分节续写：append 不能把前文冲掉
      let r = await call("write_file", { path: "doc.md", content: "# 标题\\n" });
      assert.strictEqual(r.isError, false, r.content);
      r = await call("write_file", { path: "doc.md", content: "## 第一节\\n正文\\n", append: true });
      assert.strictEqual(r.isError, false, r.content);
      assert.ok(/已追加/.test(r.content), "追加没说清楚是追加：" + r.content);
      const doc = fs.readFileSync(path.join(ws, "doc.md"), "utf8");
      assert.ok(doc.startsWith("# 标题") && doc.includes("第一节"), "append 把前文冲掉了：" + doc);

      // Markdown 代码围栏没闭合 → 界面会把后面正文整块吞掉，必须报出来
      r = await call("write_file", { path: "bad.md", content: "# X\\n\\n\`\`\`js\\nconst a = 1;\\n" });
      assert.strictEqual(r.isError, true, "围栏没闭合却判成功了");
      assert.ok(/围栏/.test(r.content), r.content);

      // JS 语法坏了 → 顶回去，但文件照写（好让它 edit_file 去修）
      r = await call("write_file", { path: "broken.js", content: "function a( {\\n" });
      assert.strictEqual(r.isError, true, "语法坏了却判成功了");
      assert.ok(/JS 语法/.test(r.content), r.content);
      assert.ok(fs.existsSync(path.join(ws, "broken.js")), "自检不过就不写文件了，那没法改");

      // .js 里写 ESM 是合法的（项目可能 type:module），不许误伤
      r = await call("write_file", { path: "esm.js", content: "import fs from 'fs';\\nexport const a = 1;\\n" });
      assert.strictEqual(r.isError, false, "把合法的 ESM 判成语法错误了：" + r.content);

      // JSON 写坏 → 报出来
      r = await call("write_file", { path: "x.json", content: '{"a": 1,}' });
      assert.strictEqual(r.isError, true, "坏 JSON 却判成功了");
      assert.ok(/JSON/.test(r.content), r.content);
      r = await call("write_file", { path: "ok.json", content: '{"a": 1}' });
      assert.strictEqual(r.isError, false, r.content);

      // edit_file 也走同一道自检：改坏了当场知道
      await call("write_file", { path: "good.js", content: "const a = 1;\\nconst b = 2;\\n" });
      r = await call("edit_file", { path: "good.js", old_text: "const b = 2;", new_text: "const b = (2;" });
      assert.strictEqual(r.isError, true, "改坏了却判成功了");
      assert.ok(/JS 语法/.test(r.content), r.content);

      // 网页验收：外链 CDN（换台电脑就白屏）、标签对不上、引用了不存在的本地文件，都要报
      await call("write_file", { path: "p.html", content:
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>测试页</title>' +
        '<script src="https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js"></' + 'script></head>' +
        '<body><div><h1>标题</h1><p>这是一段足够长的正文内容，用来避免被判成空壳页面。</p>' +
        '<img src="./missing.png"></body></html>' });
      r = await call("check_page", { path: "p.html" });
      assert.ok(/外部资源/.test(r.content), "没报外链 CDN：" + r.content);
      assert.ok(/不存在的本地文件/.test(r.content), "没报缺失的本地资源：" + r.content);
      assert.ok(/<div> 开 1 个、闭 0 个/.test(r.content), "没报标签对不上：" + r.content);
      // 查出毛病 ≠ 体检器坏了。isError 的含义是「这个工具没跑成」，而 check_page 恰恰是跑成了：
      // 缺陷在更早写的那个文件里，重跑体检不会有任何变化。标成失败会让 errStreaks 把「改一次、
      // 测一次」记成连续失败去触发循环检测，也会诱导模型重跑体检而不是去改页面。
      assert.strictEqual(r.isError, false, "体检查出问题被当成了工具自身失败");
      assert.ok(/需要你去改页面/.test(r.content), "没把「该改的是页面不是重跑」说给模型听：" + r.content);
      assert.ok(/命令行模式/.test(r.content), "命令行下应当说明浏览器实测跳过了：" + r.content);

      // 干净的页面要能过
      await call("write_file", { path: "clean.html", content:
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>干净页</title></head>' +
        '<body><h1>标题</h1><p>这是一段足够长的正文内容，用来避免被判成空壳页面。</p></body></html>' });
      r = await call("check_page", { path: "clean.html" });
      assert.strictEqual(r.isError, false, "干净的页面被判不合格：" + r.content);
      assert.ok(/没发现结构问题/.test(r.content), r.content);
      console.log("OK");
    })().catch((e) => { console.error(e); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, WB_DATA_DIR: path.join(dir, "data") },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "交付质量测试失败：\n" + (r.stderr || r.stdout));
  console.log("✅ 交付质量：长文档能续写 · JS/JSON 语法坏了当场顶回（合法 ESM 不误伤）· Markdown 围栏没闭合能查出 · 网页外链/断链/标签不闭合都拦得住");
}

/**
 * 记忆层。老版本只有一个全局 memory.md，agent 自己记不住任何东西、还所有账号串在一起。
 * 这里守四条：**按账号隔离**、**去重**、**超量丢最旧的要留痕**（不许闷声吞）、**密钥拒记**。
 */
function testMemoryLayer() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-mem-"));
  const script = `
    const assert = require("assert");
    const mem = require(${JSON.stringify(path.join(__dirname, "..", "memory.js"))});
    (async () => {

    // 记一条 + 去重（大小写/空白/句末标点不同不算两条）
    const a = mem.add({ text: "周报只要三段：进展 / 问题 / 下周计划", user: "甲" });
    assert.strictEqual(a.ok, true, a.note);
    const dup = mem.add({ text: "周报只要三段：进展/问题/下周计划。", user: "甲" });
    assert.strictEqual(dup.id, a.id, "同一条被重复记了两遍");
    assert.ok(/已经记过/.test(dup.note), dup.note);

    // 按账号隔离：乙看不到甲的
    mem.add({ text: "我习惯用飞书文档交付", user: "乙" });
    mem.add({ text: "公司名叫艾景特", shared: true });
    assert.strictEqual(mem.list("甲").length, 2, "甲应当看到自己的 + 共享的");
    assert.strictEqual(mem.list("乙").length, 2);
    assert.strictEqual(mem.list("甲").some((x) => /飞书/.test(x.text)), false, "别人的记忆串过来了");
    assert.ok((await mem.promptBlock("甲")).includes("周报只要三段"), "记忆没进提示词");
    assert.strictEqual(/飞书/.test(await mem.promptBlock("甲")), false, "提示词里带上了别人的记忆");

    // 忘记：只能忘共享的和自己的
    const f = mem.forget({ text: "飞书", user: "甲" });
    assert.strictEqual(f.removed, 0, "甲把乙的记忆删掉了");
    assert.strictEqual(mem.forget({ text: "周报", user: "甲" }).removed, 1);

    // 密钥一律拒记（记忆是明文存的，还会进每次的系统提示词）
    for (const bad of [
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234",
      "GitHub 令牌 ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "密码是 hunter2000",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    ]) {
      const r = mem.add({ text: bad, user: "甲" });
      assert.strictEqual(r.ok, false, "这条应当被拒记：" + bad);
      assert.ok(/密钥|密码|令牌/.test(r.note), r.note);
    }
    // 拒记的内容不许落盘（连日志都不该有）
    const raw = require("fs").readFileSync(mem._internals.ITEMS_FILE, "utf8");
    assert.strictEqual(/sk-abcdef|ghp_aaaa|hunter2000/.test(raw), false, "被拒记的敏感内容还是写进文件了");

    // 单条太长 → 直接拒，并说清楚该记结论不是记过程
    const long = mem.add({ text: "啊".repeat(mem.MAX_TEXT + 1), user: "甲" });
    assert.strictEqual(long.ok, false);
    assert.ok(/结论/.test(long.note), long.note);

    // 超量：丢最旧的，而且必须在回执里说出来（闷声吞就等于用户以为记住了其实没有）
    let last;
    for (let i = 0; i < mem.MAX_PER_SCOPE + 3; i++) last = mem.add({ text: "第 " + i + " 条偏好", user: "丙" });
    assert.ok(last.dropped > 0, "超量了却没丢也没说");
    assert.ok(/丢弃最旧/.test(last.note), last.note);
    assert.strictEqual(mem.list().filter((x) => x.scope === "丙").length, mem.MAX_PER_SCOPE, "超量后条数不对");
    assert.strictEqual(mem.list("丙").some((x) => x.text === "第 0 条偏好"), false, "该丢的最旧那条还在");

    // 改登录名：归属要跟着搬，不然那个人的记忆当场变孤儿
    assert.strictEqual(mem.renameScope("乙", "乙二"), 1);
    assert.ok(mem.list("乙二").some((x) => /飞书/.test(x.text)), "改名后记忆没跟过去");
    assert.strictEqual(mem.list("乙").some((x) => /飞书/.test(x.text)), false);

    // —— 召回（关键词路）：装得下全量注入；装不下按相关性挑，不从尾巴上盲切 ——
    for (let i = 0; i < 40; i++) mem.add({ text: "占位偏好" + i + "：" + "字".repeat(180), user: "丁" });
    mem.add({ text: "去香港要走深圳湾口岸，最晚 24:00 前通关", user: "丁" });
    const pb = await mem.promptBlock("丁", "帮我规划去香港的行程，从深圳湾口岸出发");
    assert.ok(pb.includes("深圳湾口岸"), "与任务相关的那条没被召回");
    assert.ok(pb.includes("挑了"), "超预算做了筛选却没明说");
    assert.ok(pb.length < 41 * 200, "超预算了却没筛，全塞进了提示词");
    // 没有线索时按新旧挑：最新的必须活下来（老实现的盲切吃掉的恰好是最新的）
    assert.ok((await mem.promptBlock("丁")).includes("深圳湾口岸"), "无线索时最新一条应当保留");

    // —— 召回（向量路）：假 embedder，语义相关但字面不重叠的条目要能排上去 ——
    mem.add({ text: "家里养了一只猫，做攻略要考虑宠物寄养", user: "戊" });
    for (let i = 0; i < 40; i++) mem.add({ text: "戊的占位" + i + "：" + "字".repeat(180), user: "戊" });
    mem.setEmbedder(Object.assign(
      async (texts) => texts.map((t) => [t.includes("猫") ? 1 : 0, t.includes("狗") ? 1 : 0, 0.1]),
      { model: "fake-v1" }
    ));
    await mem.ensureVectors();
    const vs = mem._internals.vecLoad();
    assert.strictEqual(vs.model, "fake-v1", "向量库没记嵌入模型名");
    assert.ok(Object.keys(vs.vecs).length >= 80, "向量没补算全");
    const pb3 = await mem.promptBlock("戊", "猫");
    assert.ok(pb3.includes("宠物寄养"), "向量召回没把语义相关（字面不重叠）的条目排上去");
    mem.setEmbedder(null);

    console.log("OK");
    })().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, WB_DATA_DIR: dir },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "记忆层测试失败：\n" + (r.stderr || r.stdout));
  console.log("✅ 记忆层：按账号隔离（提示词也不串）· 去重 · 密钥拒记且不落盘 · 超量丢最旧留痕 · 改名跟着搬");
}

function testCommandGate() {
  const security = require("../security");
  const sec = { ...security.DEFAULTS };
  // 都是以前能一句话绕过去的：换行 / $() / 反引号 / 子 shell / 环境变量前缀 / 绝对路径 / 包装词
  const mustAsk = [
    "rm -rf ~/x",
    "echo hi\nrm -rf ~/x",
    "echo $(rm -rf ~/x)",
    "echo `rm -rf ~/x`",
    'echo "$(rm -rf ~/x)"',
    "( rm -rf ~/x )",
    "FOO=1 rm -rf ~/x",
    "/bin/rm -rf ~/x",
    "nohup rm -rf ~/x",
    'find . -name "*.log" -delete',
    "find . -exec rm {} ;",
    "cat ~/.ssh/id_rsa", // 有 shell 在手，文件黑名单本来形同虚设
    "cat $HOME/.ssh/id_rsa",
  ];
  for (const cmd of mustAsk) {
    assert.strictEqual(security.checkCommand(sec, cmd).action, "ask", `这条应当要审批：${JSON.stringify(cmd)}`);
  }
  // 别把正常命令也拦了，天天弹审批没人受得了
  const mustPass = ["ls -la", 'grep "a|b" f.txt', 'echo "记得 rm 掉旧文件"', "git status && npm test", "node build.js"];
  for (const cmd of mustPass) {
    assert.strictEqual(security.checkCommand(sec, cmd).action, "allow", `这条不该被拦：${JSON.stringify(cmd)}`);
  }
  // 放行名单不能把黑名单一起放过去
  assert.strictEqual(security.checkCommand({ ...sec, cmd_allow: ["cat "] }, "cat ~/.ssh/id_rsa").action, "ask", "放行名单越过了文件黑名单");
  assert.strictEqual(security.checkCommand({ ...sec, cmd_allow: ["cat "] }, "cat a.txt").action, "allow", "放行名单没生效");
  // 网关关掉就只记账不拦
  assert.strictEqual(security.checkCommand({ ...sec, gateway: false }, "cat ~/.ssh/id_rsa").action, "allow", "网关关了还在拦黑名单路径");

  // —— P5 高危命令确认表：不可逆毁数据的形态，任何档位都要点头 ——
  const dangerAsk = [
    "echo x > /dev/disk2",
    "dd if=img.iso of=/dev/disk2",
    "docker compose down -v",
    "docker-compose down --volumes",
    "git push --force origin main",
    "git push -f",
    'psql -c "DROP TABLE users"',
    "mkfs.ext4 /dev/sdb1",
  ];
  for (const cmd of dangerAsk) {
    const v = security.checkCommand(sec, cmd);
    assert.strictEqual(v.action, "ask", `高危命令该要确认：${JSON.stringify(cmd)}`);
    assert.ok(/高危|询问名单|删除保护/.test(v.rule), v.rule);
  }
  // 全自动档也拦（这是它和 cmd_ask 名单的本质区别）
  assert.strictEqual(security.checkCommand({ ...sec, permission_mode: "full" }, "docker compose down -v").action, "ask", "全自动档放过了 down -v");
  // 永久放行名单盖不住高危表
  assert.strictEqual(security.checkCommand({ ...sec, cmd_allow: ["docker "] }, "docker compose down -v").action, "ask", "放行名单越过了高危表");
  // 但正常形态别误伤
  for (const cmd of ["docker compose down", "echo ok > /dev/null", "git push origin main", "git push", "dd if=a of=b.img"]) {
    assert.strictEqual(security.checkCommand(sec, cmd).action, "allow", `这条不该被高危表拦：${JSON.stringify(cmd)}`);
  }
  // 「只看不动」档下高危命令仍是 deny（不该被降级成 ask 弹审批）
  assert.strictEqual(security.checkCommand({ ...sec, permission_mode: "plan" }, "docker compose down -v").action, "deny");

  // 代码闸：命令闸守得再严，一句 require("child_process") 就从旁边过去了
  assert.strictEqual(security.checkCode(sec, 'require("child_process").execSync("rm -rf ~/x")').action, "ask", "代码开子进程没拦");
  assert.strictEqual(security.checkCode(sec, 'fs.readFileSync(process.env.HOME + "/.ssh/id_rsa")').action, "ask", "代码碰黑名单没拦");
  assert.strictEqual(security.checkCode(sec, 'const fs=require("fs");fs.writeFileSync("a.txt","hi")').action, "allow", "正常代码被拦了");
  console.log("✅ 命令闸：换行/$()/反引号/子shell/包装词全拆得开，黑名单压得住放行名单，高危表（/dev 直写·down -v·强推·删库·格盘）全档位生效，代码闸补上子进程这条路");
}

function testAccountStore() {
  const { readStore, writeStoreAtomic, createLimiter, isHttps } = require("../account")._internals;
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "e2e-acct-"));
  const file = path.join(dir, "users.json");

  // 文件不在 = 头一次跑，给个空账本
  assert.deepStrictEqual(readStore(file, { users: [] }), { users: [] }, "没有文件时应当返回空账本");

  writeStoreAtomic(file, { users: [{ username: "甲", credits: 7 }] }, true);
  assert.strictEqual(readStore(file, null).users[0].credits, 7, "写进去的读不回来");
  assert(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "临时文件没清掉");

  writeStoreAtomic(file, { users: [{ username: "甲", credits: 9 }] }, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file + ".bak", "utf8")).users[0].credits, 7, ".bak 没留住上一版");

  // 关键的一条：文件坏了必须抛错，绝不能装作「没有用户」——
  // 那样下一次写盘就把所有账号和积分覆盖成空的，还会让下一个注册的人当上管理员
  fs.writeFileSync(file, '{"users": [坏了', "utf8");
  assert.throws(() => readStore(file, { users: [] }), /坏了/, "账本读不出来时不该悄悄返回空账本");
  fs.rmSync(dir, { recursive: true, force: true });

  // 登录闸：时钟自己喂，不然测一次要等 15 分钟
  let now = 1000;
  const lim = createLimiter({ windowMs: 60000, now: () => now });
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(lim.retryAfter("a", 3), 0, `第 ${i + 1} 次就被拦了`);
    lim.fail("a");
  }
  assert(lim.retryAfter("a", 3) > 0, "打满次数后没拦住");
  assert.strictEqual(lim.retryAfter("b", 3), 0, "拦 a 不该连累 b");
  now += 61000;
  assert.strictEqual(lim.retryAfter("a", 3), 0, "过了窗口还在拦");
  lim.fail("a"); lim.pass("a");
  assert.strictEqual(lim.retryAfter("a", 1), 0, "登录成功后没把失败次数清掉");

  assert.strictEqual(isHttps({ headers: { "x-forwarded-proto": "https, http" } }), true, "nginx 转发的 https 没认出来");
  assert.strictEqual(isHttps({ headers: {} }), false, "普通 http 不该当成 https");
  console.log("✅ 账本：坏文件不覆盖 / 写盘原子 / 登录限流 / https 认得出");
}

/**
 * 积分闸门：默认必须是**关**的。本地个人部署时它拦不住任何真实开销（key 是用户自己的，
 * 账单在服务商那边），却会在干到一半时把任务掐了，还得自己给自己充值。
 * 账本落在 data/ 下，所以整段丢进子进程跑，WB_DATA_DIR 指到临时目录——测试绝不能碰真账号。
 */
function testCreditsGate() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-credits-"));
  const script = `
    const assert = require("assert");
    const acc = require(${JSON.stringify(path.join(__dirname, "..", "account.js"))});
    const { register, loadUsers, saveUsers, loadUsage } = acc._internals;
    const setOn = (on) => { const st = loadUsers(); st.settings = { ...st.settings, credits_enabled: on }; saveUsers(st); };
    const balance = (n) => loadUsers().users.find((u) => u.username === n).credits;
    const run = { prompt: 4000, completion: 1000, calls: 3 }; // 5000 tokens = 5 积分

    const u = register("测试甲", "pw123456");
    assert.strictEqual(acc.creditsEnabled(), false, "积分闸门默认必须是关的");

    // 关着：一分不扣，余额一动不动，但流水照记（用量还是要能看的）
    assert.strictEqual(acc.chargeRun(u, { ...run, source: "web" }), 0, "不限额时不该扣分");
    assert.strictEqual(balance("测试甲"), 10000, "不限额时余额被动了");
    const flow = loadUsage();
    assert.strictEqual(flow.length, 1, "不限额时流水没记");
    assert.strictEqual(flow[0].prompt + flow[0].completion, 5000, "流水里的 tokens 不对");
    assert.strictEqual(flow[0].credits, 0, "不限额时流水里的积分该是 0");

    // 余额见底也照跑：这就是用户遇到的那个"欠费"，关着闸门时不该再拦
    const st = loadUsers(); st.users[0].credits = 0; saveUsers(st);
    assert.strictEqual(acc.chargeRun(u, { ...run, source: "cli" }), 0, "余额 0 时不限额仍不该扣");
    assert.strictEqual(balance("测试甲"), 0, "余额 0 不该被扣成负数");

    // 开了才按老规矩走：多人共用一个 key 时还得能定额度
    setOn(true);
    assert.strictEqual(acc.creditsEnabled(), true, "开关打开后没生效");
    saveUsers(Object.assign(loadUsers(), { users: loadUsers().users.map((x) => ({ ...x, credits: 8 })) }));
    assert.strictEqual(acc.chargeRun(u, { ...run, source: "web" }), 5, "开了闸门该扣 5 积分");
    assert.strictEqual(balance("测试甲"), 3, "开了闸门余额没扣对");
    assert.strictEqual(u.credits, 3, "调用方拿到的余额没同步");

    // 关回去，闸门立刻失效——用户不用重启应用
    setOn(false);
    assert.strictEqual(acc.chargeRun(u, { ...run, source: "web" }), 0, "关回去还在扣");
    assert.strictEqual(balance("测试甲"), 3, "关回去后余额又被动了");
    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, WB_DATA_DIR: dir },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "积分闸门测试失败：\n" + (r.stderr || r.stdout));
  console.log("✅ 积分：默认不限额（余额 0 也照跑、不扣分但记流水）/ 开了才扣才拦 / 开关即时生效");
}

/**
 * 缓存命中要一路记到账本里，并且真的影响扣分。
 *
 * 这条链子以前是断的：llm.js 把三家不同的字段名统一读成 cached，agent.js 一路带到收尾，
 * 然后在 server.js 的五处手写累加和 account.js 的账本记录里被同时丢掉——网页上那一行
 * "缓存命中 x%" 只活到刷新页面为止，CLI / 定时任务 / IM 跑的任务压根没有这一行，
 * 而扣积分是按 prompt+completion 全价算的，缓存读也照收全价。
 * 这里验三件事：账本记得住、扣分打得了折、命中率不拿老流水当分母。
 */
function testCachedLedger() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cached-"));
  const script = `
    const assert = require("assert");
    const acc = require(${JSON.stringify(path.join(__dirname, "..", "account.js"))});
    const { register, loadUsers, saveUsers, loadUsage, saveUsage } = acc._internals;
    const setOn = (on) => { const st = loadUsers(); st.settings = { ...st.settings, credits_enabled: on }; saveUsers(st); };

    // 扣分：命中缓存的部分按 1/10 算。10000 输入里 9000 命中 → 1000 + 900 = 1900 → 2 分（不打折是 10 分）
    assert.strictEqual(acc.creditsFor({ prompt: 10000, cached: 9000, completion: 0 }), 2, "缓存没打折");
    assert.strictEqual(acc.creditsFor({ prompt: 10000, cached: 0, completion: 0 }), 10, "没缓存时不该少扣");
    assert.strictEqual(acc.creditsFor({ prompt: 10000, completion: 0 }), 10, "老记录没 cached 字段时不该白送折扣");
    // 上游偶尔会报出比 prompt 还大的 cached，钳住，不然能把账扣成负的
    assert.strictEqual(acc.creditsFor({ prompt: 1000, cached: 999999, completion: 0 }), 1, "cached 超过 prompt 没钳住");
    // 至少 1 分这条老规矩不能被折扣绕过
    assert.strictEqual(acc.creditsFor({ prompt: 100, cached: 100, completion: 0 }), 1, "每次任务至少 1 积分被绕过了");

    const u = register("测试缓存", "pw123456");
    setOn(true);
    acc.chargeRun(u, { prompt: 10000, cached: 9000, completion: 0, calls: 2, source: "cli" });
    const flow = loadUsage();
    assert.strictEqual(flow[0].cached, 9000, "账本没记下 cached");
    assert.strictEqual(flow[0].credits, 2, "账本里扣的分没打折");

    // 命中率的分母只算"记过 cached 的那些条"：塞一条老流水（压根没有这个字段）进去，
    // 它不该把命中率稀释成一个假的低值
    const old = { ts: new Date().toISOString(), day: flow[0].day, kind: "run", user: "测试缓存", source: "web", prompt: 990000, completion: 0, calls: 1, credits: 990 };
    saveUsage([old, ...flow]);
    const sum = acc.usageSummary(loadUsers().users[0]);
    assert.strictEqual(sum.today.cached, 9000, "汇总里的 cached 不对");
    assert.strictEqual(sum.today.cachedOf, 10000, "老流水被算进命中率的分母了");
    assert.strictEqual(sum.today.tokens, 1000000, "tokens 总量该照旧把老流水算上");
    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, WB_DATA_DIR: dir },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "缓存账本测试失败：\n" + (r.stderr || r.stdout));

  // 防第六处漏网：server.js 里的用量累加必须只走 addUsage()。
  // 这个字段就是被五处各写一遍的手工累加同时丢掉的，再手写一处就又断一次。
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const handRolled = srv.split("\n").filter((l) => /total\.(prompt|completion)\s*\+=/.test(l) && !/^\s*\*/.test(l));
  assert.strictEqual(
    handRolled.length, 2,
    "server.js 里出现了 addUsage() 之外的手工用量累加，cached 会在那里被丢掉：\n" + handRolled.join("\n")
  );
  console.log("✅ 缓存命中：记进账本 / 扣分按 1/10 折算 / 命中率不拿老流水当分母 / 累加只有一条路");
}

/**
 * 改登录名：挂在旧名字底下的东西必须一起搬走，搬漏一样就是历史对不上人。
 * 同样丢子进程里跑，WB_DATA_DIR 指到临时目录，不碰真账号。
 */
function testRenameLogin() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rename-"));
  const script = `
    const assert = require("assert");
    const acc = require(${JSON.stringify(path.join(__dirname, "..", "account.js"))});
    const { register, renameUser, loadUsers, saveUsers, loadUsage, issueToken } = acc._internals;
    const names = () => loadUsers().users.map((u) => u.username);

    register("老名字", "pw123456");
    register("别人", "pw123456");
    const st0 = loadUsers(); st0.settings = { credits_enabled: true }; saveUsers(st0);
    const me = loadUsers().users[0];
    acc.chargeRun(me, { prompt: 1000, completion: 0, calls: 1, source: "web" });
    const tok = issueToken("老名字");

    assert.throws(() => renameUser("老名字", "别人"), /已经有人用/, "撞名没挡住");
    assert.throws(() => renameUser("老名字", "a"), /2-24/, "太短的名字没挡住");
    assert.throws(() => renameUser("老名字", "带 空格"), /2-24/, "带空格的名字没挡住");
    assert.strictEqual(renameUser("老名字", "老名字"), "老名字", "改成同一个名字不该报错");

    renameUser("老名字", "新名字");
    assert.deepStrictEqual(names(), ["新名字", "别人"], "账本里的名字没改过来");
    assert.strictEqual(loadUsers().users[0].credits, 9999, "改名把余额弄丢了");
    assert.strictEqual(loadUsers().tokens[tok].user, "新名字",
      "登录令牌没跟着搬——用户改完名当场被踢下线，还得重登一次");
    assert.strictEqual(loadUsage()[0].user, "新名字", "用量流水还挂在旧名字底下");

    // 充值记录里的 by（谁充的）也是个登录名，一样得搬
    const usage = loadUsage(); usage.unshift({ kind: "topup", user: "别人", by: "新名字", credits: 5 });
    require("fs").writeFileSync(require("path").join(process.env.WB_DATA_DIR, "usage.json"), JSON.stringify(usage));
    renameUser("新名字", "更新的名字");
    assert.strictEqual(loadUsage()[0].by, "更新的名字", "充值记录里的「谁充的」没搬");
    assert.strictEqual(names()[0], "更新的名字", "第二次改名没生效");
    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, WB_DATA_DIR: dir },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "改登录名测试失败：\n" + (r.stderr || r.stdout));
  console.log("✅ 改登录名：撞名/不合法挡得住 / 账本·登录令牌·用量流水（含充值的 by）一起搬走");
}

// 头像校验：用户头像和助理头像共用这一份规则，它松了两边一起松
function testAvatarRules() {
  const { normalizeAvatar } = require("../account")._internals;
  assert.strictEqual(normalizeAvatar(""), "", "空值应当原样放过（= 用默认头像）");
  assert.strictEqual(normalizeAvatar("  🐱  "), "🐱", "emoji 前后空格没去掉");
  assert.strictEqual(normalizeAvatar("猫"), "猫", "汉字当头像也该收");
  // 一个 👨‍👩‍👧 是好几个码位拼的：按 .length 算会误判成超长，必须按字素簇算
  assert.strictEqual(normalizeAvatar("👨‍👩‍👧"), "👨‍👩‍👧", "组合 emoji 被当成超长挡掉了");
  assert.throws(() => normalizeAvatar("一二三"), /最多两个/, "三个字符该挡下来");
  assert.throws(() => normalizeAvatar("https://x.example/a.png"), /emoji 或上传图片/, "外链头像必须挡：每次渲染都会去请求那个域名");
  assert.throws(() => normalizeAvatar('<img src=x onerror=alert(1)>'), /emoji 或上传图片/, "带标签的头像必须挡");
  assert.throws(() => normalizeAvatar("data:text/html;base64,PHNjcmlwdD4="), /emoji 或上传图片/, "非图片 data URI 必须挡");

  const png = "data:image/png;base64," + "A".repeat(64);
  assert.strictEqual(normalizeAvatar(png), png, "正常的图片 data URI 被挡了");
  assert.throws(() => normalizeAvatar("data:image/png;base64," + "A".repeat(300 * 1024)), /256KB/,
    "超大图必须挡：账本是个 JSON 文件，塞张大图进去整个读写都会被拖垮");
  console.log("✅ 头像规则：emoji 按字素簇算长度 / 只收 data:image / 挡外链与标签 / 限 256KB");
}

// JSON 小仓库：坏文件先拿 .bak 顶，顶不住就隔离——绝不静默当空的然后覆盖掉
function testJsonStore() {
  const { readJson, writeJsonAtomic } = require("../store");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "e2e-store-"));
  const file = path.join(dir, "sess.json");

  assert.deepStrictEqual(readJson(file, { a: 1 }), { a: 1 }, "文件不在时应返回默认值");
  fs.writeFileSync(file, "   \n", "utf8");
  assert.deepStrictEqual(readJson(file, { a: 1 }), { a: 1 }, "0 字节/空白文件应当自愈成默认值");

  writeJsonAtomic(file, { turn: 1 });
  writeJsonAtomic(file, { turn: 2 });
  fs.writeFileSync(file, '{"turn": 2, 坏了', "utf8"); // 模拟写到一半断电
  const back = readJson(file, null);
  assert.strictEqual(back && back.turn, 1, "坏文件没回退到 .bak");
  assert.strictEqual(readJson(file, null).turn, 1, "恢复出来的内容没写回去，下次读还得再恢复一遍");
  assert(fs.existsSync(file + ".corrupt"), "坏的那份没留底");

  // 连 .bak 都没有 → 隔离改名，原文件不能被就地覆盖成空的
  const lone = path.join(dir, "lone.json");
  fs.writeFileSync(lone, "{坏了", "utf8");
  assert.deepStrictEqual(readJson(lone, []), [], "没有 .bak 时应返回默认值");
  assert(!fs.existsSync(lone), "坏文件没被改名隔离");
  assert(fs.readdirSync(dir).some((f) => f.startsWith("lone.json.corrupt-")), "隔离文件不见了，用户没法捞回来");

  // 账本用 strict：宁可停下来报错，也不能自作主张回退一版（可能正好吞掉一笔充值）
  const led = path.join(dir, "users.json");
  writeJsonAtomic(led, { users: ["甲"] });
  writeJsonAtomic(led, { users: ["甲", "乙"] });
  fs.writeFileSync(led, "{坏", "utf8");
  assert.throws(() => readJson(led, {}, { strict: true }), /坏了/, "strict 模式没抛错");
  assert.strictEqual(fs.readFileSync(led, "utf8"), "{坏", "strict 模式不该动原文件");

  assert(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "临时文件没清掉");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("✅ JSON 仓库：空文件自愈 / 坏文件回退 .bak / 无 .bak 则隔离 / 账本 strict 抛错");
}

// IM 会话：重启不丢上下文；历史砍长度只能从一整轮的开头下刀
function testImSessionStore() {
  const { createImSessionStore } = require("../im-store");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "e2e-imsess-"));

  const s1 = createImSessionStore({ dir });
  assert.strictEqual(s1.has("feishu_oc_1"), false, "新会话不该凭空存在");
  s1.set("feishu_oc_1", []);
  const h = s1.get("feishu_oc_1");
  h.push({ role: "user", content: "上次说到哪了" });
  h.push({ role: "assistant", text: "说到第三章" });
  s1.save("feishu_oc_1"); // runTask 是就地追加的，得手动招呼一声

  // 换一个实例 = 应用重启
  const s2 = createImSessionStore({ dir });
  assert.strictEqual(s2.has("feishu_oc_1"), true, "重启后会话没读回来");
  assert.strictEqual(s2.get("feishu_oc_1").length, 2, "重启后上下文丢了");
  assert.strictEqual(s2.get("feishu_oc_1")[1].text, "说到第三章", "读回来的内容不对");
  assert.strictEqual(s2.has("qq_c2c_9"), false, "别的会话不该被顺带创建");

  // 砍长度：不能把 tool_use 和它的结果劈开，切口必须落在 user 上
  const s3 = createImSessionStore({ dir, maxEntries: 4 });
  const long = [];
  for (let i = 0; i < 4; i++) {
    long.push({ role: "user", content: "问" + i });
    long.push({ role: "assistant", text: "答", toolCalls: [{ id: "t" + i }] });
    long.push({ role: "tool", results: [{ id: "t" + i, content: "结果" }] });
  }
  s3.set("wecom_u", long);
  const kept = JSON.parse(fs.readFileSync(path.join(dir, "wecom_u.json"), "utf8"));
  assert(kept.length <= 6, `砍完还剩 ${kept.length} 条，超了`);
  assert.strictEqual(kept[0].role, "user", "切口没落在一轮的开头，工具调用会被劈成两半");
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].role === "tool") assert(kept[i - 1] && kept[i - 1].toolCalls, "工具结果前面没有对应的调用");
  }
  assert.strictEqual(long.length, kept.length, "砍历史必须就地改数组，不能换一个新的（调用方还攥着旧引用）");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("✅ IM 会话：重启后上下文还在 / 砍历史只从整轮开头下刀");
}

// 撞上限强制收尾：最终回复必须是"交代"，不能是半句过程叙述；用户手动停止则不该再花一次调用
async function testForcedWrapUp() {
  const busyLLM = (onWrap) => {
    let calls = 0;
    return {
      provider: "mock",
      model: "scripted",
      calls: () => calls,
      async chat({ history, tools }) {
        calls++;
        if (!tools.length) {
          const last = history[history.length - 1];
          assert(last.role === "user" && last.content.includes("强制收尾"), "收尾指令没进历史");
          onWrap && onWrap();
          return {
            text: "已经把资料收集完了，报告正文还没开始写；下次从写正文接着做。",
            toolCalls: [],
            stopReason: "end",
            usage: { prompt: 10, completion: 5 },
          };
        }
        return {
          text: "我先看一下这个文件。",
          toolCalls: [{ id: "tc_" + calls, name: "run_node", input: { code: "console.log('ok')", purpose: "占位" } }],
          stopReason: "tool_use",
          usage: { prompt: 10, completion: 5 },
        };
      },
    };
  };

  // ① 撞最大步数
  let wrapped = false;
  const llm1 = busyLLM(() => (wrapped = true));
  const rt1 = createAgentRuntime({
    config: { agent: { max_steps: 2, tool_timeout_ms: 60000 } },
    llm: llm1,
    mcpManager: new McpManager(),
    experts,
  });
  const events = [];
  const r1 = await rt1.runTask({
    history: [{ role: "user", content: "写一份很长的报告" }],
    emit: (ev) => events.push(ev),
  });
  assert(wrapped, "撞上限后没发那次「不带工具」的收尾请求");
  assert(!r1.finalText.includes("我先看一下这个文件"), "半句过程叙述不该当成最终回复");
  assert(r1.finalText.includes("报告正文还没开始写"), "收尾说明没进最终回复");
  assert(r1.finalText.includes("已达最大步数"), "缺少上限提示");
  assert(events.some((e) => e.type === "limit"), "缺少 limit 事件");
  assert.strictEqual(r1.usage.calls, 3, "收尾那次调用要计进用量（2 步 + 1 次收尾）");

  // ② 用户手动停止：不再多花一次调用
  const ctrl = new AbortController();
  let wrapped2 = false;
  const llm2 = busyLLM(() => (wrapped2 = true));
  const rt2 = createAgentRuntime({
    config: { agent: { max_steps: 5, tool_timeout_ms: 60000 } },
    llm: llm2,
    mcpManager: new McpManager(),
    experts,
  });
  const origChat = llm2.chat.bind(llm2);
  llm2.chat = async (args) => {
    const out = await origChat(args);
    ctrl.abort(); // 第一次调用后用户按了停止
    return out;
  };
  const r2 = await rt2.runTask({
    history: [{ role: "user", content: "写一份很长的报告" }],
    stopSignal: ctrl.signal,
  });
  assert(!wrapped2, "手动停止不该再花一次收尾调用");
  assert(r2.finalText.includes("已手动停止"), "手动停止提示缺失");
  console.log("✅ 强制收尾：撞上限补一次交代 / 手动停止不多花钱 通过");
}

// 「来源」只认工具真访问到的页面。抓失败的、模型嘴上说参考了的，都不许混进去——
// 那等于给用户一个"我看过这页"的假凭证。
function testCollectSources() {
  const one = collectSources("fetch_url", { url: "https://example.com/a" }, "HTTP 200 · 示例页面标题\n正文若干");
  assert.strictEqual(one.length, 1, "fetch_url 应产出 1 条来源");
  assert.strictEqual(one[0].url, "https://example.com/a");
  assert.strictEqual(one[0].title, "示例页面标题", "标题应从首行取到，实得：" + one[0].title);

  const rendered = collectSources("render_page", { url: "https://example.com/spa" }, "HTTP 200 · 动态页（已渲染）\n内容");
  assert.strictEqual(rendered[0].title, "动态页", "括号后的说明不该混进标题：" + rendered[0].title);

  const noTitle = collectSources("fetch_url", { url: "https://example.com/b" }, "HTTP 200\n没有 title 标签的页面");
  assert.strictEqual(noTitle.length, 1, "没标题也该记来源");
  assert.strictEqual(noTitle[0].title, "", "没标题就留空，别拿正文首行凑数");

  const failed = collectSources("fetch_url", { url: "https://example.com/c" }, "⚠️ 没能拿到正文：对方站点把这次请求判成了爬虫（HTTP 412）。别就此打住");
  assert.strictEqual(failed.length, 0, "抓失败的不能算来源");

  const localFile = collectSources("fetch_url", { url: "file:///etc/passwd" }, "HTTP 200 · x\ny");
  assert.strictEqual(localFile.length, 0, "非 http(s) 不该进来源");

  const search = collectSources(
    "web_search",
    { query: "x" },
    "1. 第一条标题\n   https://a.example/1\n   摘要一\n\n2. 第二条标题\n   https://b.example/2\n   摘要二"
  );
  assert.strictEqual(search.length, 2, "搜索结果应拆出 2 条来源");
  assert.deepStrictEqual(search.map((s) => s.url), ["https://a.example/1", "https://b.example/2"]);
  assert.strictEqual(search[1].title, "第二条标题");

  assert.strictEqual(collectSources("write_file", { path: "a.txt" }, "ok").length, 0, "非联网工具不该产出来源");
  console.log("✅ 来源：只收录真访问到的页面（抓失败/本地文件/非联网工具一律不计）通过");
}

// 网关 HTTP 200 之后流里才给错误 / 直接断流给空——都必须抛错，不能当成「模型答了个空」
async function testLlmStreamFailures() {
  const { openaiChat } = require("../llm")._internals;
  const http = require("http");
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (req.url.startsWith("/err")) {
      res.write(`data: ${JSON.stringify({ error: { code: 429, message: "rate limited by upstream" } })}\n\n`);
      res.write("data: [DONE]\n\n");
    } else if (req.url.startsWith("/empty")) {
      res.write("data: [DONE]\n\n");
    } else if (req.url.startsWith("/cherr")) {
      // 错误挂在 choice 上的变种：finish_reason:"error"（OpenRouter 真实姿势之一）
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "error", error: { code: 502, message: "provider crashed" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
    } else if (req.url.startsWith("/finonly")) {
      // 只给 finish_reason 不给任何内容和 usage（2026-08-24 02:43 真实翻车样本）：也必须算空响应
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const cfgFor = (prefix) => ({ base_url: `http://127.0.0.1:${port}/${prefix}`, api_key: "k", model: "m" });
  const args = { system: "s", history: [{ role: "user", content: "hi" }], tools: [] };
  await assert.rejects(() => openaiChat(cfgFor("err"), args), /LLM 接口错误 429[\s\S]*rate limited/, "流内 error 载荷该抛错");
  await assert.rejects(() => openaiChat(cfgFor("empty"), args), /空响应/, "空流该抛错而不是当成功");
  await assert.rejects(() => openaiChat(cfgFor("cherr"), args), /LLM 接口错误 502[\s\S]*provider crashed/, "choice 级错误该抛错");
  await assert.rejects(() => openaiChat(cfgFor("finonly"), args), /空响应/, "只给 finish_reason 的空流该抛错");
  const ok = await openaiChat(cfgFor("ok"), args);
  assert.strictEqual(ok.text, "你好", "正常流被误伤");
  assert.strictEqual(ok.usage.completion, 2, "正常流 usage 没带回来");
  srv.close();
  console.log("✅ LLM 流式健壮性：流内/choice 级错误抛错 / 空流与只给 finish_reason 都算失败（可重试） / 正常流不误伤");
}

function testLeakedToolCallRescue() {
  const { rescueLeakedToolCalls, createLeakGuard } = require("../llm")._internals;
  // DeepSeek 经中转层时的真实翻车样本：工具调用的特殊 token 被当正文解码了
  const leaked =
    "稍等，我先抓取该UP主的视频列表进行分析。\n\n" +
    "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>fetch_url\n" +
    '```json\n{"url":"https://space.bilibili.com/163637592/"}\n```' +
    "<｜tool▁call▁end｜><｜tool▁calls▁end｜>";
  const r = rescueLeakedToolCalls(leaked);
  assert(r.toolCalls.length === 1, "泄漏的工具调用没救回来");
  assert(r.toolCalls[0].name === "fetch_url", "救回的工具名不对");
  assert(r.toolCalls[0].input.url.includes("163637592"), "救回的参数不对");
  assert(!/tool▁sep/.test(r.text), "正文里还留着特殊 token");
  assert(r.text.includes("我先抓取"), "标记之前的正常叙述被误删");

  // 没有围栏、裸 JSON 的变体也要认
  const bare = rescueLeakedToolCalls('好的<｜tool▁sep｜>run_shell {"command":"ls -l"} 然后我再看看');
  assert(bare.toolCalls.length === 1 && bare.toolCalls[0].input.command === "ls -l", "裸对象参数没解析出来");

  // 正常回复不能被误伤
  const clean = rescueLeakedToolCalls("这是一段普通回复，里面有 a < b 和 <div> 标签。");
  assert(clean.toolCalls.length === 0 && clean.text.includes("<div>"), "正常回复被误改");

  // 参数只吐了一半时，宁可不调也不能拿半截参数去执行
  const half = rescueLeakedToolCalls('<｜tool▁sep｜>write_file\n```json\n{"path":"a.md","cont');
  assert(half.toolCalls.length === 0, "半截参数不该被当成有效调用");

  // 流式闸门：一个字一个字喂进去，界面上不能出现任何特殊 token
  let shown = "";
  const guard = createLeakGuard((d) => (shown += d));
  for (const ch of leaked) guard(ch);
  assert(!/[<＜][|｜]/.test(shown), "特殊 token 漏到界面上了");
  assert(shown.includes("我先抓取"), "闸门把正常文字也吞了");
  console.log("✅ 工具调用泄漏救援：还原成真调用 / 半截参数丢弃 / 特殊 token 不进界面 通过");
}

async function testFetchUrlShapes() {
  const http = require("http");
  const { fetchUrl } = require("../tools");
  const routes = {
    "/json": [200, "application/json", '{"code":0,"data":{"title":"<b>标签不能被洗掉</b>"}}'],
    "/html": [200, "text/html", "<html><head><style>p{}</style></head><body><h1>标题</h1><p>正文一</p><p>正文二</p>" + "内容".repeat(200) + "</body></html>"],
    "/shell": [200, "text/html", "<html><body><div id=app></div><noscript>请开启 JavaScript</noscript></body></html>"],
    "/blocked": [412, "text/html", "<html><body>风控校验失败</body></html>"],
    // 每页都有的导航/页脚/侧栏：抓十个页面就是把同一堆链接抄十遍，白占正文的额度
    "/noise": [200, "text/html",
      "<html><body><nav>导航垃圾一 导航垃圾二</nav><header>站点页头垃圾</header>" +
      "<article><h1>真正的标题</h1><p>这里是文章正文。</p>" + "有效内容".repeat(120) + "</article>" +
      "<aside>侧栏推荐垃圾</aside><footer>版权页脚垃圾</footer></body></html>"],
    "/paper.pdf": [200, "application/pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 0x7f)])],
    // GBK 老站点：.text() 一律按 UTF-8 解会整页乱码，模型看到问号就以为"这站抓不到"
    "/gbk": [200, "text/html; charset=gbk", Buffer.concat([
      Buffer.from("<html><body><p>" + "filler ".repeat(60) + "</p><p>"),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]), // 「中文测试」的 GBK 字节
      Buffer.from("</p></body></html>"),
    ])],
  };
  const srv = http.createServer((req, res) => {
    const [code, ct, body] = routes[req.url] || [404, "text/plain", "no"];
    // 顺带验一下请求头：伪装成爬虫的 UA 是这次要修掉的毛病
    if (!/Chrome\//.test(req.headers["user-agent"] || "") || !req.headers.referer) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("请求头不像浏览器");
    }
    res.writeHead(code, { "Content-Type": ct });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const j = await fetchUrl(`${base}/json`);
    assert(j.includes('"<b>标签不能被洗掉</b>"'), "JSON 被当 HTML 洗了标签");

    const h = await fetchUrl(`${base}/html`);
    assert(h.includes("标题") && h.includes("正文一") && !h.includes("<h1>"), "HTML 转文本不对");
    assert(!h.includes("p{}"), "style 内容没去掉");

    // 空壳与被拦：渲染兜底在测试环境（非 Electron）用不了，此时必须如实说清楚并给出下一步，
    // 绝不能返回一段看着像正文的空内容让模型以为读到了
    const s = await fetchUrl(`${base}/shell`);
    assert(s.includes("没能拿到正文") && s.includes("JavaScript 动态渲染"), "空壳页没给出诊断");
    assert(s.includes("run_shell") && s.includes("web_search"), "空壳页没给出换路子的建议");

    const b = await fetchUrl(`${base}/blocked`);
    assert(b.includes("判成了爬虫") && b.includes("412"), "反爬拦截没被识别");

    const n = await fetchUrl(`${base}/noise`);
    assert(n.includes("真正的标题") && n.includes("这里是文章正文"), "正文被抽没了");
    for (const junk of ["导航垃圾", "站点页头垃圾", "侧栏推荐垃圾", "版权页脚垃圾"]) {
      assert(!n.includes(junk), `导航/页脚噪声没清掉：${junk}`);
    }

    const g = await fetchUrl(`${base}/gbk`);
    assert(g.includes("中文测试"), "GBK 页面没按声明的字符集解码（拿到的是乱码）");

    // PDF 按文本读出来是一坨乱码，20000 字乱码进上下文既污染判断又白烧钱
    const pdfPath = path.join(WORKSPACE, "paper.pdf");
    fs.rmSync(pdfPath, { force: true });
    try {
      const p = await fetchUrl(`${base}/paper.pdf`);
      assert(p.includes("二进制文件") && p.includes("paper.pdf"), "PDF 没被识别成二进制文件");
      assert(p.includes("pdftotext"), "PDF 没给出取文字的下一步");
      assert(!/%PDF/.test(p), "PDF 原始字节被当正文塞回上下文了");
      assert(fs.existsSync(pdfPath), "PDF 没有下载到工作目录");
      // 重名不覆盖：目录里可能躺着用户自己的同名文件
      const again = await fetchUrl(`${base}/paper.pdf`);
      assert(again.includes("paper_2.pdf"), "同名下载把已有文件覆盖了");
    } finally {
      fs.rmSync(pdfPath, { force: true });
      fs.rmSync(path.join(WORKSPACE, "paper_2.pdf"), { force: true });
    }
  } finally {
    srv.close();
  }
  console.log("✅ 抓取：JSON 原样返回 / 导航页脚清掉 / GBK 正确解码 / PDF 存文件不塞乱码 / 空壳与反爬如实报告 通过");
}

/**
 * 只读工具并发执行。深度研究经常一口气要抓五个链接，串行是五次网络等待叠加；
 * 但只要一批里混进会写东西的工具，顺序就是语义，必须整批退回串行。
 */
async function testParallelToolBatch() {
  const http = require("http");
  let live = 0, peak = 0;
  const srv = http.createServer((req, res) => {
    live++;
    peak = Math.max(peak, live);
    setTimeout(() => {
      live--;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><article><h1>页面${req.url}</h1><p>${"正文内容".repeat(120)}</p></article></body></html>`);
    }, 150);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const scripted = (batches) => {
    let i = 0;
    return {
      provider: "mock",
      model: "scripted",
      async chat() {
        const b = batches[i++];
        return b ? { text: "", toolCalls: b, stopReason: "tool_use" } : { text: "完成。", toolCalls: [], stopReason: "end" };
      },
    };
  };
  const fetchCall = (n) => ({ id: `t${n}`, name: "fetch_url", input: { url: `${base}/p${n}` } });
  const tmpFile = "e2e-并发混批.txt";
  try {
    // 全只读 → 并发
    let events = [];
    let hist = [{ role: "user", content: "抓三个页面" }];
    await createAgentRuntime({ config, llm: scripted([[fetchCall(1), fetchCall(2), fetchCall(3)]]), mcpManager: new McpManager(), experts })
      .runTask({ history: hist, emit: (ev) => events.push(ev) });
    assert.strictEqual(peak, 3, `三个只读工具没有并发跑（实际最高并发 ${peak}）`);
    const par = events.find((e) => e.type === "parallel");
    assert(par && par.count === 3, "缺少 parallel 事件");
    const results = hist.find((h) => h.role === "tool").results;
    assert.deepStrictEqual(results.map((r) => r.id), ["t1", "t2", "t3"], "工具结果的顺序/ID 和 tool_calls 对不上");
    results.forEach((r, i) => assert(r.content.includes(`/p${i + 1}`), `第 ${i + 1} 个结果串到别的 URL 上了`));
    // 每张卡都要能按 id 配对，否则界面会把 A 的结果贴到 B 的卡上
    const uses = events.filter((e) => e.type === "tool_use");
    assert(uses.every((e) => e.id) && events.filter((e) => e.type === "tool_result").every((e) => e.id), "工具事件缺少 id");

    // 混进一个会写文件的 → 整批串行
    peak = 0;
    events = [];
    hist = [{ role: "user", content: "抓两个页面再写文件" }];
    await createAgentRuntime({
      config,
      llm: scripted([[fetchCall(1), fetchCall(2), { id: "t9", name: "write_file", input: { path: tmpFile, content: "x" } }]]),
      mcpManager: new McpManager(),
      experts,
    }).runTask({ history: hist, emit: (ev) => events.push(ev) });
    assert.strictEqual(peak, 1, `批里有写文件的工具，不该并发（实际最高并发 ${peak}）`);
    assert(!events.some((e) => e.type === "parallel"), "混合批不该发 parallel 事件");
  } finally {
    srv.close();
    fs.rmSync(path.join(WORKSPACE, tmpFile), { force: true });
  }
  console.log("✅ 并发：只读批并发跑 / 结果顺序与 ID 不串 / 混入写操作整批退回串行");
}

function testPathSafety() {
  const { safePath } = require("../tools");
  let threw = false;
  try { safePath("..\\..\\windows\\system32\\evil.txt"); } catch { threw = true; }
  assert(threw, "路径越界未被拦截");
  console.log("✅ 安全：workspace 路径越界拦截通过");
}

/**
 * 桌面宠物：这里跑的是纯 node（没有 Electron 主进程），正好用来钉死两条最容易出事的边界——
 * ① pet.js 在没有桌面窗口时必须整体降级成空壳，一个方法都不许抛（server.js 的事件流每步都会调它，
 *    它一抛，整条任务就跟着炸）；② desktop_pet 工具在服务端模式下必须如实报错，绝不能假装做好了。
 */
async function testDesktopPet() {
  const pet = require("../pet");
  // ① 空壳降级：全套方法在纯 node 下都得安静地什么都不做
  assert.strictEqual(pet.create(), null, "纯 node 模式不该真造出宠物窗口");
  assert.strictEqual(pet.isVisible(), false, "没有窗口时 isVisible 必须是 false");
  pet.applyConfig({ enabled: true, scale: 1.4, opacity: 0.8, character: "photo" });
  assert.strictEqual(pet.enabled, true, "applyConfig 后 enabled 应跟着变");
  pet.setState("working", "正在用 run_node");
  pet.setState("不存在的状态", "x"); // 非法状态名要被收敛成 idle 而不是原样透传
  pet.alertAsk("预算多少？");
  pet.clearAsk(true);
  pet.hide();
  assert.strictEqual(pet.enabled, false, "hide 之后 enabled 应为 false");
  pet.destroy();

  // ② 工具层：没有落地实现时如实报错
  const { executeTool } = require("../tools");
  const saved = global.__wbPetTool;
  delete global.__wbPetTool;
  const noImpl = await executeTool("desktop_pet", { action: "status" }, {});
  assert(noImpl.isError, "没有实现时 desktop_pet 应该报错而不是假装成功");

  // ③ 参数原样转发给服务端实现（action / image / scale 一个都不能丢）
  let got = null;
  global.__wbPetTool = { async run(input, baseDir) { got = { input, baseDir }; return { content: "ok", isError: false }; } };
  const ok = await executeTool("desktop_pet", { action: "create", image: "头像.png", scale: 1.2 }, { baseDir: "e2e-pet-dir" });
  assert(!ok.isError && got && got.input.action === "create" && got.input.image === "头像.png" && got.input.scale === 1.2, "desktop_pet 参数没原样转发: " + JSON.stringify(got));
  // 用户在某个对话里传的图落在该对话的成果子目录，实现要靠这个 baseDir 才找得到
  assert.strictEqual(got.baseDir, path.join(WORKSPACE, "e2e-pet-dir"), "desktop_pet 没把本次对话的成果目录传给实现");
  fs.rmSync(path.join(WORKSPACE, "e2e-pet-dir"), { recursive: true, force: true });
  if (saved) global.__wbPetTool = saved; else delete global.__wbPetTool;

  // ④ 工具声明本身：模型只能看到这五个动作，且 action 必填
  const { TOOL_DEFS } = require("../tools");
  const def = TOOL_DEFS.find((t) => t.name === "desktop_pet");
  assert(def, "工具表里没有 desktop_pet");
  assert.deepStrictEqual(def.input_schema.properties.action.enum, ["create", "show", "hide", "remove", "status"], "desktop_pet 动作枚举变了");
  assert.deepStrictEqual(def.input_schema.required, ["action"], "desktop_pet 应只把 action 设为必填");
  console.log("✅ 桌面宠物：无窗口时全套降级不抛 / 服务端模式如实报错 / 参数与动作枚举稳定");
}

/**
 * 提示词不许自相矛盾：一边禁"把选择题丢给用户"，一边要求"岔路必须用 ask_user"。
 *
 * 真实数据里 62 个会话只有 2 个用过 ask_user，而 11 个会话里用户中途插话把方向掰回来，
 * 其中一条是「你用生图 API 给我做呀」—— 提示词里点名举的就是这个例子（封面图走生图
 * 还是排版截图），模型照样自己替用户挑了。原因不是例子举得不够，是同一份提示词里
 * 工作规范 5.2 用加粗写着"不许把选择题丢给用户 / 方案的优劣你自己判断得了"，
 * 而要求提问的那段在一百多行之后、语气更弱、条件更多。模型按前面那条办，很合理。
 *
 * 所以这里不是再加一段措辞，而是钉住"不许留下无条件的禁止提问"这个约束：任何一条
 * 禁止把选择题/反问抛给用户的规则，必须在同一行里说明 ask_user 工具不在禁止之列，
 * 否则以后随手加一条又会把它压回去。断言跑在真正拼装出来的系统提示词上（含模式段），
 * 不是对着源码字符串猜。
 */
async function testPromptNoAskContradiction() {
  let captured = null;
  const fake = {
    provider: "mock",
    model: "scripted",
    async chat({ system }) { captured = system; return { text: "好", toolCalls: [], stopReason: "end" }; },
  };
  await createAgentRuntime({ config, llm: fake, mcpManager: new McpManager(), experts: [] })
    .runTask({ history: [{ role: "user", content: "随便做点什么" }], emit: () => {} });
  assert(captured, "没抓到系统提示词");

  const bans = captured.split("\n").filter((l) => /严禁|不许/.test(l) && /选择题|反问/.test(l));
  assert(bans.length, "提示词里一条'禁止把选择题丢给用户'都没有了——这一条是有用的，别整段删掉");
  for (const l of bans) {
    assert(
      /ask_user/.test(l),
      "有一条禁止提问的规则没说明 ask_user 不在禁止之列，模型会按它把岔路自己挑了：\n  " + l.slice(0, 160)
    );
  }
  // 岔路该问这件事本身也得还在，且给的是"选了会得到什么"而不是同义词复读
  assert(/成品形态/.test(captured) && /ask_user/.test(captured), "岔路必须问的规则丢了");
  console.log("✅ 提示词自洽：禁止文字反问的规则都写明了 ask_user 例外（岔路仍必须问）");
}

async function testAskUser() {
  // 有人值守：ask_user 弹题 → askUser 回调给答案 → 答案回到工具结果；事件成对出现
  let step = 0;
  const fake = {
    provider: "mock",
    model: "scripted",
    async chat({ history, tools }) {
      step++;
      if (step === 1) {
        assert(tools.some((t) => t.name === "ask_user"), "craft 模式工具列表里没有 ask_user");
        return { text: "问一下预算。", toolCalls: [{ id: "a1", name: "ask_user", input: { question: "预算多少？", options: ["500", "1000"] } }], stopReason: "tool_use" };
      }
      const lastTool = history[history.length - 1];
      assert(lastTool.role === "tool" && lastTool.results[0].content.includes("用户的回答：1000"), "ask_user 未把用户回答带回: " + lastTool.results[0].content);
      return { text: "按 1000 做。", toolCalls: [], stopReason: "end" };
    },
  };
  const runtime = createAgentRuntime({ config, llm: fake, mcpManager: new McpManager(), experts: [] });
  const events = [];
  const { finalText } = await runtime.runTask({
    history: [{ role: "user", content: "帮我订酒店" }],
    emit: (ev) => events.push(ev),
    askUser: async ({ askId, question, options }) => {
      assert(askId && question === "预算多少？" && options.length === 2, "askUser 收到的问题不对");
      await new Promise((r) => setTimeout(r, 30));
      return "1000";
    },
  });
  const askEv = events.find((e) => e.type === "ask_user");
  const ansEv = events.find((e) => e.type === "ask_answer");
  assert(askEv && askEv.question === "预算多少？" && askEv.options.length === 2, "缺 ask_user 事件");
  assert(ansEv && ansEv.answer === "1000" && ansEv.ask_id === askEv.ask_id, "缺 ask_answer 事件或 ask_id 不配对");
  assert(finalText.includes("按 1000 做"), "任务未按用户回答收尾");

  // 无人值守：没有回答通道 → 立即降级答复，不发事件、不傻等
  let step2 = 0;
  const fake2 = {
    provider: "mock",
    model: "scripted",
    async chat({ history }) {
      step2++;
      if (step2 === 1) return { text: "", toolCalls: [{ id: "a2", name: "ask_user", input: { question: "颜色？", options: ["红", "蓝"] } }], stopReason: "tool_use" };
      const lastTool = history[history.length - 1];
      assert(lastTool.results[0].content.includes("无人值守"), "无人值守降级答复缺失: " + lastTool.results[0].content);
      return { text: "自己定了。", toolCalls: [], stopReason: "end" };
    },
  };
  const ev2 = [];
  await createAgentRuntime({ config, llm: fake2, mcpManager: new McpManager(), experts: [] }).runTask({
    history: [{ role: "user", content: "随便" }],
    emit: (ev) => ev2.push(ev),
  });
  assert(!ev2.some((e) => e.type === "ask_user"), "无人值守不该发 ask_user 事件");
  console.log("✅ ask_user：提问/回答/无人值守降级");
}

async function main() {
  console.log("=== OpenWorkBuddy e2e 测试 ===");
  testCron();
  testCommandGate();
  await testPermissionModes();
  testMemoryLayer();
  testLeakedToolCallRescue();
  await testLlmStreamFailures();
  testCollectSources();
  testJsonStore();
  testImSessionStore();
  testAccountStore();
  testCreditsGate();
  testCachedLedger();
  testRenameLogin();
  testAvatarRules();
  testPathSafety();
  testDeliverableGate();
  testContextBudget();
  testToolPairRepair();
  await testFetchRetry();
  testCheckPageConsole();
  await testLookAtImage();
  testPluginManifest();
  testPluginComponentIsolation();
  testPluginMcpRuntime();
  testPluginSkillsIntegration();
  testDefaultSkillsManifest();
  await testFrontendSvgFigures();
  await testFetchUrlShapes();
  await testParallelToolBatch();
  await testMcpStreamableHttp();
  await testSchedulerRuntime();
  await testMcpManagerLifecycle();
  await testNodeSyntaxPrecheck();
  await testShellGlobCompat();
  await testSessionFileLayout();
  await testOfficeLibs();
  await testPreviewExtract();
  testEvolveLoop();
  testEvolveRecency();
  testTaskDirLifecycle();
  await testCodingTools();
  await testDeliverableQuality();
  await testAgentPipeline();
  await testForcedWrapUp();
  await testAskUser();
  await testPromptNoAskContradiction();
  await testDesktopPet();
  // 清理测试产物
  for (const f of fs.readdirSync(WORKSPACE)) {
    if (f.startsWith("e2e-")) fs.rmSync(path.join(WORKSPACE, f), { force: true });
  }
  console.log("=== 全部测试通过 ===");
}

main().catch((e) => {
  console.error("❌ 测试失败:", e.message);
  process.exit(1);
});
