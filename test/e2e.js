"use strict";
/**
 * 端到端测试 — 用"脚本化模拟 LLM"驱动 Agent 运行时完整跑一遍，不需要真实模型 API Key。
 * 覆盖：技能加载(use_skill) → 代码执行生成 Excel(run_node/exceljs) → 专家委派(delegate_to_expert
 * 子代理 write_file) → 任务收尾；以及 cron 解析、Word/PPT 库可用性。
 * 运行：npm test
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { createAgentRuntime, missingDeliverables, trimHistory, historyChars, collectSources } = require("../agent");
const { McpManager } = require("../mcp");
const { parseCron, cronMatches } = require("../scheduler");
const { getWorkspaceDir, setWorkspaceDir } = require("../tools");
/**
 * 测试跑在一个临时工作区里，不碰用户真正的那个。
 *
 * 以前这里直接用 getWorkspaceDir()，也就是用户天天在用的 workspace/。测试造的
 * e2e-测试报表.xlsx、e2e-预览样本.pptx 那一堆东西是真写进去的，全套跑绿了才在最后
 * 一行删掉——中间任何一条断言挂了，收尾那段根本执行不到，这些文件就留在用户的
 * 成果面板里了。用户看到「e2e ppt 这些啥意思」，就是这么来的。
 * 换成临时目录之后：跑挂了也不脏用户的东西，收尾还兜在 finally 里。
 */
const WORKSPACE = setWorkspaceDir(fs.mkdtempSync(path.join(os.tmpdir(), "owb-e2e-ws-")));

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
// CSS 令牌闸门：引用了却没定义的 --wb-* / --* 变量，浏览器不报错、不回退，直接当没写——
// 之前 --wb-line/--wb-card/--wb-warn/--mono 就这么空跑了很久（评测页边框一路是空的），
// 后来又因为手滑吃掉一个分号，让 --wb-ok-text 整个失效。这类事故没有任何运行时能替你发现。
// 顺带把「文字色拿填充色令牌」也钉死：--wb-brand/--wb-err/--wb-ok 是给背景用的，
// 当文字色在浅底/暗底上都过不了 WCAG AA，必须走 --wb-*-text 那三档。
function testCssTokenGate() {
  const pub = path.join(__dirname, "..", "public");
  const files = [
    path.join(pub, "index.html"),
    path.join(pub, "css", "ui.css"),
    ...fs.readdirSync(path.join(pub, "js")).filter((f) => f.endsWith(".js")).map((f) => path.join(pub, "js", f)),
  ];
  const defined = new Set();
  for (const f of [files[0], files[1]]) {
    const t = fs.readFileSync(f, "utf8");
    for (const m of t.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]);
  }
  const missing = new Map();
  const fillAsText = [];
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    // var(--x) 带回退值的不算漏（var(--x, 兜底) 本来就允许没定义）
    for (const m of t.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g)) {
      if (!defined.has(m[1])) missing.set(m[1], (missing.get(m[1]) || []).concat(path.basename(f)));
    }
    for (const m of t.matchAll(/(?<![-a-zA-Z])color:\s*var\(\s*--wb-(brand|err|ok)\s*\)/g)) {
      fillAsText.push(path.basename(f) + " 的 --wb-" + m[1]);
    }
  }
  assert(missing.size === 0, "引用了没定义的 CSS 变量：" + [...missing].map(([k, v]) => k + "(" + [...new Set(v)].join(",") + ")").join("、"));
  assert(fillAsText.length === 0, "填充色令牌被当文字色用了，应换成 --wb-*-text：" + fillAsText.join("、"));
  // 反向断言：闸门本身得能抓到东西，不然改坏了也全绿
  const probe = "color: var(--wb-err)";
  assert(/(?<![-a-zA-Z])color:\s*var\(\s*--wb-(brand|err|ok)\s*\)/.test(probe), "闸门正则失效");
  assert(!defined.has("--wb-根本没有这个"), "闸门定义集失效");
  console.log(`✅ CSS 令牌闸门：${defined.size} 个变量全部有定义 · 填充色没被当文字色用`);
}

// 动效闸门：transition 不写曲线，浏览器就按默认的 ease 走——两头慢中间快，那是「网页味」，
// 跟界面里其他用 --wb-ease 的地方不是一套动法。这类不一致肉眼要盯很久才看得出来，
// 而且每加一条新样式就可能悄悄漏一个，靠人复查是守不住的，所以钉成闸门。
// 同理钉住字体栈：拉丁必须先落 -apple-system（SF），中文再落苹方；
// 反过来写（苹方在前）整句英文会用苹方自带的西文，字重字距都不对。
function testMotionGate() {
  const pub = path.join(__dirname, "..", "public");
  const files = [path.join(pub, "index.html"), path.join(pub, "css", "ui.css")];
  // 一条 transition 的每个「分段」都要自带曲线：靠 transition-timing-function 另写一行的
  // 本项目里一处都没有，真要出现，这里报出来再放行不迟。
  const bare = [];
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    for (const m of t.matchAll(/transition:\s*([^;}]+)/g)) {
      // 按逗号切段，但要绕开括号里的逗号——var(--wb-ease, ease) 的那个回退逗号
      // 直接 split(",") 会把它劈成两半，于是「ease)」被当成一条没写曲线的过渡（假阳性）
      const segs = [];
      let depth = 0, cur = "";
      for (const ch of m[1]) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) { segs.push(cur); cur = ""; continue; }
        cur += ch;
      }
      segs.push(cur);
      for (const seg of segs) {
        if (!seg.trim()) continue;
        if (!/var\(\s*--wb-ease/.test(seg)) bare.push(path.basename(f) + ": " + seg.trim());
      }
    }
  }
  assert(bare.length === 0,
    "这些过渡没写曲线，会吃浏览器默认的 ease：\n  " + bare.join("\n  "));

  const html = fs.readFileSync(files[0], "utf8");
  const fams = [...html.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
  const uiFams = fams.filter((v) => /PingFang|apple-system/.test(v));
  assert(uiFams.length > 0, "index.html 里一个界面字体栈都没找到，闸门失效了");
  for (const v of uiFams) {
    const first = v.split(",")[0].trim().replace(/^["']|["']$/g, "");
    assert(first === "-apple-system",
      "界面字体栈第一位应该是 -apple-system（拉丁走 SF），现在是 " + first + "：" + v);
    assert(/PingFang SC/.test(v), "字体栈里没有 PingFang SC，中文会掉到系统兜底：" + v);
  }

  // 浮层得是毛玻璃，且降级要留得住（不支持 backdrop-filter 的环境靠底下那层半透明色兜着）。
  // 同一个类可能有好几条规则（比如暗色主题单独覆写一次 background），所以要把它们全收起来看：
  // 只按 indexOf 找第一条，会撞上 html[data-theme="dark"] 那条覆写，误判成「没加毛玻璃」。
  for (const cls of [".modal-mask", ".auth-mask"]) {
    const rules = [];
    const re = new RegExp("[^{}]*\\" + cls + "(?![-\\w])[^{}]*\\{([^}]*)\\}", "g");
    for (const m of html.matchAll(re)) rules.push(m[1]);
    assert(rules.length > 0, "找不到 " + cls + " 的规则");
    assert(rules.some((r) => /backdrop-filter/.test(r)), cls + " 没加毛玻璃");
    const opaque = rules.filter((r) => /background:\s*[^;]+/.test(r) && !/background:\s*rgba\(/.test(r));
    assert(opaque.length === 0,
      cls + " 有一条规则把底色写成了不透明，不支持毛玻璃的环境会变成实心板：" + opaque.join(" | "));
  }

  // 反向断言：闸门本身得能抓到东西
  const probeBare = "transition: opacity .2s";
  assert(!/var\(\s*--wb-ease/.test(probeBare), "裸过渡的判别失效");
  assert('"PingFang SC", -apple-system'.split(",")[0].trim().replace(/^["']|["']$/g, "") !== "-apple-system",
    "字体栈顺序的判别失效");
  console.log("✅ 动效闸门：过渡曲线全部走令牌（没有一条吃默认 ease）· 拉丁先落 SF 中文再落苹方 · 浮层毛玻璃且有降级兜底");
}

/**
 * 定时任务「假绿」闸门。
 *
 * 守的是 scheduler.js 原来那条 `finish(true, finalText || "完成")`——只要 runTask 没抛异常
 * 就记成功，于是撞上限被强制收尾、整条正文就是上游报错、一个字没吐、把活丢后台就收工
 * 这四类全都在运行记录里显示 ✅。这里正反两面都钉：该判失败的必须判失败（漏判 = 假绿回来了），
 * 该放行的必须放行（误判 = 面板一片红，比一片绿更没人看）。
 */
function testVerdictGate() {
  const { judgeRun, explainRunError } = require("../task-verdict");
  // 正文足够长，长到能验证「长篇汇报里提一嘴限流不算失败」这条豁免
  const long = "今天的行业晨报已经生成并推送到飞书。过程中第一次调用撞了 429 rate limit，等 20 秒重试后拿到了全部数据。".padEnd(420, "。补充说明");
  const cases = [
    // [名字, 入参, 期望的失败原因（null = 应该放行）]
    ["撞步数上限", { stopped: "已达最大步数（25 步）", result: "我先看一下这个文件" }, "budget_exhausted"],
    ["撞时间上限", { stopped: "已达最大运行时间（30 分钟）", result: "做到一半" }, "budget_exhausted"],
    ["手动停止", { stopped: "已手动停止", result: "" }, "stopped"],
    ["模型挂死", { stopped: "模型响应超时（连续 300 秒没有任何输出）", result: "" }, "model_stall"],
    ["一个字没吐", { result: "" }, "no_output"],
    ["整条就是限流", { result: "LLM 接口错误 429: rate limit exceeded" }, "upstream_error"],
    ["整条就是欠费", { result: "渠道余额不足，请先充值后再试。" }, "upstream_error"],
    ["整条就是 Key 挂", { result: "LLM 接口错误 401: invalid_api_key" }, "upstream_error"],
    ["整条就是断流", { result: "LLM 返回了空响应（连接建立后没有收到任何内容，上游服务或网络异常）" }, "upstream_error"],
    ["整条就是超时", { result: "请求超时" }, "upstream_error"],
    ["甩后台", { result: "部署已在后台启动，完成后会通知我。" }, "deferred"],
    ["子步骤完成但仍在等", { result: "抓取阶段进行中（深圳、北京已完成，广州进行中）。完整流程完成后我会自动收到通知。等待中。" }, "deferred"],
    ["半截·停在冒号", { result: "定时任务触发（2026-09-05），前台阻塞取数据：" }, "truncated"],
    ["半截·宣告收尾", { result: "New scheduled trigger. Fresh snapshot ready. Let me read the full data." }, "truncated"],
    ["真交付", { result: "今日行业晨报已生成并推送到飞书 ✅，共 12 条要闻。" }, null],
    ["合法的短回复", { result: "今日休市，跳过。" }, null],
    ["长文里提过限流", { result: long }, null],
    ["客套 let me know", { result: "报告已生成并保存为 daily.md。Let me know if you need more details." }, null],
  ];
  const bad = [];
  for (const [name, input, want] of cases) {
    const v = judgeRun(input);
    const got = v.ok ? null : v.reason;
    if (got !== want) bad.push(`${name}：期望 ${want} 实得 ${got}`);
    if (!v.ok && !(v.label && v.hint)) bad.push(`${name}：判了失败却没给 label/hint，运行记录里就只剩一个红叉`);
  }
  assert(!bad.length, "任务裁定：" + bad.join("；"));
  // 重试分档：重跑能好的才标 retryable。欠费/Key 失效标成可重试的话，
  // 「自动重试」就成了每小时白烧一轮。
  assert(judgeRun({ result: "LLM 接口错误 429: rate limit exceeded" }).retryable === true, "限流应该标可重试");
  assert(judgeRun({ result: "渠道余额不足，请先充值后再试。" }).retryable === false, "欠费重跑一百遍也一样，不该标可重试");
  assert(judgeRun({ stopped: "已达最大步数（25 步）" }).retryable === false, "撞上限该走自动续跑，重跑是从零重做");
  // error 口子也得有药方：同一个断网从异常上来和从正文上来，不能一次有诊断一次没有
  assert(/连不上上游/.test(explainRunError("fetch failed ECONNREFUSED")), "error 口子的断网没被认出来");
  assert(explainRunError("积分不足：管理员可以充值") === "积分不足：管理员可以充值", "认不出的错该原样返回，不该套壳");
  // 反向断言：闸门自己得会红。把「甩后台」这类正文喂进去若还判成功，说明判据被改坏了
  assert(judgeRun({ result: "任务已提交，等结果出来再同步给你。" }).ok === false, "闸门失灵：明显的甩后台话术被判成了成功");
  console.log(`✅ 任务裁定闸门：${cases.length} 类运行判定全对（撞上限/上游报错/空跑/甩后台/半截 判红，真交付与合法短回复放行）· 重试按死因分档 · error 与正文两个口子同诊断`);
}

function testDocLinkGate() {
  const root = path.join(__dirname, "..");
  // 只管项目自己的文档。skills/ 下是内容和第三方技能，里面的 ](URL) 是模板占位，不是死链
  const docs = path.join(root, "docs");
  const files = ["README.md", "CONTRIBUTING.md", "COMMERCIAL-LICENSE.md"]
    .map((f) => path.join(root, f))
    .filter((f) => fs.existsSync(f))
    .concat(fs.existsSync(docs) ? fs.readdirSync(docs).filter((f) => f.endsWith(".md")).map((f) => path.join(docs, f)) : []);

  // Markdown 的 [x](y)，加上 README 里那些 HTML 标签的 href/src
  const grab = (t) => [
    ...[...t.matchAll(/\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]),
    ...[...t.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
  ];
  // GitHub 给标题生成锚点的规则：小写、去掉标点、空格转连字符，中文原样保留
  const slugify = (h) => h.trim().replace(/[*`~]/g, "").toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, "").trim().replace(/\s+/g, "-");
  const dead = [];
  let checked = 0;
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    const anchors = new Set([...t.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slugify(m[1])));
    for (const href of grab(t)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      // 页内锚点：跳过等于没查，标题改个字锚点就哑了，点了原地不动
      if (href.startsWith("#")) {
        checked++;
        if (!anchors.has(decodeURIComponent(href.slice(1)).toLowerCase())) dead.push(path.basename(f) + " → " + href + "（没有这个标题）");
        continue;
      }
      const rel = decodeURIComponent(href.split("#")[0]);
      if (!rel) continue;
      checked++;
      if (!fs.existsSync(path.resolve(path.dirname(f), rel))) dead.push(path.basename(f) + " → " + href);
    }
  }
  assert(dead.length === 0, "文档里有指向不存在文件的链接：" + dead.join("、"));

  // 徽章和 clone 地址得指向真的这个仓库。写错了照样渲染，只是数字是别人的
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const slugs = new Set([...readme.matchAll(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?[/"?)\s]/g)].map((m) => m[1]));
  // 徽章走的是 img.shields.io/github/<指标>/<owner>/<repo>，主机不是 github.com，
  // 只扫 github.com 会漏掉「徽章指向别人仓库」这种——数字照显，只是不是你的
  for (const m of readme.matchAll(/img\.shields\.io\/github\/([^"?\s]+)/g)) {
    const seg = m[1].split("/").filter(Boolean);
    if (seg.length >= 3) slugs.add(seg.slice(-2).join("/"));
  }
  slugs.forEach((sl) => assert(sl === "CatCatUncle/openworkbuddy", "README 里出现了别的仓库地址：" + sl));
  assert(slugs.size === 1, "README 里没找到仓库地址");
  // shields 的 release 徽章在没发过 release 时会渲染成 "no releases or repo not found"。
  // 用本地 git tag 当代理：发布都是从 tag 切的，打了 tag 这条自然放行，不用另外维护标记
  if (/img\.shields\.io\/github\/v\/release/.test(readme)) {
    let tags = null;
    try { tags = require("child_process").execSync("git tag -l", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
    assert(tags === null || tags !== "", "挂了 release 徽章但一个 tag 都没有，徽章会渲染成报错文本");
  }

  // 反向断言：闸门得真能抓到死链和错仓库，否则改坏了也全绿
  assert(grab("[x](docs/根本没有这个.md)").length === 1, "链接提取失效");
  assert(slugify("## 一起把它做下去") === "-一起把它做下去".slice(1), "标题锚点算法失效");
  assert(!fs.existsSync(path.resolve(root, "docs/根本没有这个.md")), "存在性检查失效");
  assert([...("github.com/someoneelse/repo\"".matchAll(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?[/"?)\s]/g))][0][1] === "someoneelse/repo", "仓库地址正则失效");
  const probeSlug = [...("img.shields.io/github/v/release/someoneelse/repo?x=1".matchAll(/img\.shields\.io\/github\/([^"?\s]+)/g))][0][1].split("/").slice(-2).join("/");
  assert(probeSlug === "someoneelse/repo", "徽章仓库地址提取失效");
  console.log(`✅ 文档链接闸门：${files.length} 个文档 ${checked} 条本地链接全部存在 · 徽章指向本仓库`);
}

/**
 * 生图必须主动关水印。
 *
 * 这条闸门是拿真事故换来的：generate_image 有两条分支，DashScope 那条写了
 * parameters.watermark = false，OpenAI 兼容那条（火山方舟 doubao-seedream、new-api 网关都走这条）
 * 一个字都没写——而 doubao 的 watermark 默认就是 true。用户拿到的每一张图右下角都烙着「AI 生成」，
 * agent 只能事后去局部重绘擦掉，造了 8 个中间文件，还把对话里的成品卡位全占了。
 * 漏的是一个默认值，赔进去的是整条产出链路。
 *
 * 三件事都得钉住，少一件这个洞就会以另一种形式回来：
 *   1. 正常渠道：请求里必须真的带 watermark: false（不是「代码里写了」，是「发出去了」）；
 *   2. 严格渠道（OpenAI 官方对不认识的字段直接 400）：退一步不带它重发，但必须在回执里说出来——
 *      静默退回去，用户下次又拿到带水印的图，还是查不出原因；
 *   3. 非参数错误（余额不足、鉴权失败）：不许被当成参数问题吞掉去重发，那会把真错因藏起来。
 */
async function testImageWatermarkGate() {
  const http = require("http");
  const os = require("os");
  const { generateImage } = require("../tools")._internals;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-wm-"));
  const seen = [];
  let mode = "accept";
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {}
      seen.push(body);
      const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (mode === "strict" && "watermark" in body) return j(400, { error: { message: "Unrecognized request argument supplied: watermark" } });
      if (mode === "broke") return j(400, { error: { message: "余额不足，请充值后重试" } });
      j(200, { data: [{ b64_json: Buffer.from("fake-png").toString("base64") }] });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const media = { image: { base_url: `http://127.0.0.1:${srv.address().port}/v1`, model: "seedream", api_key: "k" } };
  try {
    const r1 = await generateImage(media, { prompt: "一只猫", filename: "e2e-wm-1.png" }, 5000, dir);
    assert(!r1.isError, "正常渠道生图失败：" + r1.content);
    assert(seen.length === 1, "正常渠道多发了请求：" + seen.length);
    assert(seen[0].watermark === false, "生图请求没带 watermark:false，图会带平台水印");
    // 顺利这条也必须交代水印状态。只在出问题时报警、顺利时沉默，模型无从判断，
    // 只能自己再花一轮 look_at_image 去找水印——真实会话 s_1788598987265 里它找完还另造了
    // 一版「干净图」，白烧两轮外加一个多余产物。
    assert(/已按无水印出图/.test(r1.content), "顺利出图却没在回执里交代水印状态：" + r1.content);
    assert(!/可能带平台的/.test(r1.content), "顺利出图却报了水印警告：" + r1.content);

    mode = "strict"; seen.length = 0;
    const r2 = await generateImage(media, { prompt: "一只猫", filename: "e2e-wm-2.png" }, 5000, dir);
    assert(!r2.isError, "严格渠道该退一步重发并成功，实际：" + r2.content);
    assert(seen.length === 2, "严格渠道应当只重发一次，实际发了 " + seen.length + " 次");
    assert(seen[0].watermark === false && !("watermark" in seen[1]), "重发时没把 watermark 去掉");
    assert(/可能带平台的/.test(r2.content), "退让了却没在回执里留痕，用户查不出图为什么带水印：" + r2.content);

    mode = "broke"; seen.length = 0;
    const r3 = await generateImage(media, { prompt: "一只猫", filename: "e2e-wm-3.png" }, 5000, dir);
    assert(r3.isError, "余额不足竟然没报错");
    assert(seen.length === 1, "非参数错误不该重发，实际发了 " + seen.length + " 次");
    assert(/余额不足/.test(r3.content), "真正的错因被吞掉了：" + r3.content);

    // 反向断言：把「漏写 watermark 的那种请求体」喂给同一条判据，它必须判失败。
    // 判据要是判不出来，代码哪天改回漏写的样子，这条测试照样全绿
    let caught = false;
    try { assert(({ model: "m", prompt: "p", n: 1 }).watermark === false, "x"); } catch { caught = true; }
    assert(caught, "闸门判据失效：漏写 watermark 的请求体居然也能过");
    let caught2 = false;
    try { assert(/已按无水印出图/.test("图片已生成：a.png（模型 m）"), "x"); } catch { caught2 = true; }
    assert(caught2, "回执判据失效：不提水印状态的老回执居然也能过");
    console.log("✅ 生图水印闸门：默认关水印 · 顺利也交代状态 · 渠道不认时退让并留痕 · 非参数错误不吞");
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 生视频的水印，和生图是同一个洞的另一半。
 *
 * 生图那条早就做成了「先按要干净的发，对面说不认识这个字段才去掉重发」；视频这条一直是硬发
 * parameters.watermark=false —— 渠道一旦不认，整条视频任务当场就废。视频要跑好几分钟、按条收钱，
 * 为一个可降级的字段把它废掉，比带个水印更亏。
 *
 * 但退让不能顺手把重试也带进来：这是付费异步任务的提交口，退避重发会重复下单。
 * 所以三件事一起钉：默认关水印 / 渠道不认时退让且留痕 / 提交口不重试。
 */
async function testVideoWatermarkGate() {
  const http = require("http");
  const os = require("os");
  const { generateVideo } = require("../tools")._internals;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-vwm-"));
  const submits = [];
  let mode = "accept";
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url.includes("/video-synthesis")) {
        let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
        submits.push(body);
        const wm = "watermark" in (body.parameters || {});
        if (mode === "strict" && wm) return j(400, { error: { message: "Unrecognized request argument supplied: watermark" } });
        if (mode === "boom") return j(500, { message: "InternalError" });
        return j(200, { output: { task_id: "t1" } });
      }
      if (req.url.includes("/tasks/")) {
        return j(200, { output: { task_status: "SUCCEEDED", video_url: `http://127.0.0.1:${srv.address().port}/v.mp4` } });
      }
      res.writeHead(200, { "Content-Type": "video/mp4" }); res.end(Buffer.from("fake-mp4"));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const media = { video: { base_url: `http://127.0.0.1:${srv.address().port}/dashscope/api/v1`, model: "wanx", api_key: "k" } };
  try {
    const r1 = await generateVideo(media, { prompt: "一只猫走路", filename: "e2e-vwm-1.mp4" }, { saveDir: dir });
    assert(!r1.isError, "正常渠道生视频失败：" + r1.content);
    assert(submits.length === 1, "正常渠道多提交了任务（等于重复下单）：" + submits.length);
    assert(submits[0].parameters.watermark === false, "视频请求没带 watermark:false，成片会带平台水印");
    assert(/已按无水印出片/.test(r1.content), "顺利出片却没在回执里交代水印状态：" + r1.content);

    mode = "strict"; submits.length = 0;
    const r2 = await generateVideo(media, { prompt: "一只猫走路", filename: "e2e-vwm-2.mp4" }, { saveDir: dir });
    // 这一条就是这次要修的回归：以前渠道不认这个字段，整条视频任务直接失败
    assert(!r2.isError, "渠道不认 watermark 就把整条视频任务废了：" + r2.content);
    assert(submits.length === 2, "严格渠道应当只退让重发一次，实际提交了 " + submits.length + " 次");
    assert("watermark" in submits[0].parameters && !("watermark" in submits[1].parameters), "重发时没把 watermark 去掉");
    assert(/可能带平台的/.test(r2.content), "退让了却没在回执里留痕，用户查不出成片为什么带水印：" + r2.content);

    mode = "boom"; submits.length = 0;
    const r3 = await generateVideo(media, { prompt: "一只猫走路", filename: "e2e-vwm-3.mp4" }, { saveDir: dir });
    assert(r3.isError, "上游 500 竟然没报错");
    assert(submits.length === 1, "付费提交口被重试了 " + submits.length + " 次，会重复下单");

    // 反向断言：老那种「硬发 watermark、渠道不认就整条废掉」的结果喂给同一条判据，必须判失败
    let caught = false;
    try { assert(!{ isError: true, content: "视频接口错误 400" }.isError, "x"); } catch { caught = true; }
    assert(caught, "闸门判据失效：渠道不认就整条废掉的结果居然也能过");
    console.log("✅ 生视频水印闸门：默认关水印 · 渠道不认时退让不废任务 · 付费提交口不重试");
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * CLI 模式：真起 `node cli.js` 子进程，模型指向本地假接口（config.openai.stream=false，
 * 走非流式那条，用不着造 SSE，也一分钱不花）。
 *
 * 钉的四件事，每一件都是这轮改之前会错的：
 *
 *  1. 单发任务之间不许串上下文。以前会话 id 是 `cli_YYYYMMDD`，同一天所有命令共用一个
 *     会话文件，而 runTask 会把助手回复和工具结果就地追加进 history——于是「单发任务」
 *     其实拖着当天前面每一条任务的完整对话去问模型，既烧 token 又让它在别的任务的
 *     阴影里答新问题。同时要有正向对照：明确 --session 续接时，上下文必须还在，
 *     否则「不串台」可能只是因为历史根本没存住。
 *  2. 答案走 stdout、进度走 stderr。`wb "..." > 答案.md` 拿到的得是干净答案。
 *  3. 退出码说实话。以前无论成败恒 0，`wb ... && 下一步` 在任务失败时照样往下走。
 *  4. -C 指了个用不了的目录必须当场停，不许默默退回默认目录——那会把文件写到别处。
 */
async function testCliMode() {
  const http = require("http");
  const os = require("os");
  const { spawn } = require("child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cli-"));
  const seen = [];
  let mode = "ok";
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (!req.url.includes("/chat/completions")) return j(404, {});
      let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
      seen.push(body);
      if (mode === "boom") return j(401, { error: { message: "鉴权失败" } });
      j(200, {
        choices: [{ message: { role: "assistant", content: "答案是四十二。" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  fs.mkdirSync(path.join(home, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    provider: "openai",
    // stream:false 让 llm.js 走非流式分支，假接口回一个普通 JSON 就够了
    openai: { base_url: `http://127.0.0.1:${port}/v1`, api_key: "k", model: "mock", stream: false },
    agent: { max_steps: 3, tool_timeout_ms: 5000, llm_timeout_ms: 20000 },
    mcp_servers: [],
    workspace_dir: path.join(home, "workspace"),
  }));
  const CLI = path.join(__dirname, "..", "cli.js");
  // 这里不能用 spawnSync：它把本进程的事件循环整个堵住，上面那个假接口就永远轮不到
  // accept 连接，子进程一头等到超时——测试会以「模型没响应」的样子失败，跟被测代码无关。
  const run = (args, input = "") => new Promise((resolve) => {
    const env = { ...process.env, OPENWORKBUDDY_HOME: home, NO_COLOR: "1" };
    delete env.FORCE_COLOR; // 外面开着 FORCE_COLOR 的话子进程会往管道里塞转义序列
    const ps = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = "", stderr = "";
    ps.stdout.on("data", (d) => (stdout += d));
    ps.stderr.on("data", (d) => (stderr += d));
    ps.stdin.end(input);
    const killer = setTimeout(() => ps.kill("SIGKILL"), 60000);
    ps.on("close", (status) => { clearTimeout(killer); resolve({ status, stdout, stderr }); });
  });
  const lastBody = () => JSON.stringify(seen[seen.length - 1] || {});
  try {
    const r1 = await run(["--no-mcp", "第一条任务ALPHA标记"]);
    const sid1 = (r1.stderr.match(/会话 (cli_[\w]+)/) || [])[1];
    assert.strictEqual(r1.status, 0, "单发任务没成功（退出码 " + r1.status + "）：" + r1.stderr.slice(-500));
    assert(lastBody().includes("ALPHA标记"), "请求里没有本次的任务描述");

    // 2）答案走 stdout，进度走 stderr
    assert(r1.stdout.includes("答案是四十二"), "模型的回答没走 stdout：" + JSON.stringify(r1.stdout));
    assert(!/第 \d+ 步|工作目录|会话 cli_/.test(r1.stdout), "进度混进了 stdout，重定向出来的答案会被污染：" + JSON.stringify(r1.stdout));
    assert(/会话 cli_/.test(r1.stderr), "stderr 上没有会话/模型那行开场信息");

    // 1）不串台
    const r2 = await run(["--no-mcp", "第二条任务BRAVO标记"]);
    assert.strictEqual(r2.status, 0, "第二条单发任务失败：" + r2.stderr.slice(-500));
    const b2 = lastBody();
    assert(b2.includes("BRAVO标记"), "第二条请求里没有它自己的任务");
    assert(!b2.includes("ALPHA标记"), "单发任务串上下文了：第二条请求带着第一条的内容（旧版按天共用会话文件）");

    // 1b）正向对照：明确续接时上下文必须在，否则上面那条只是「历史根本没存住」
    const sid = (r2.stderr.match(/会话 (cli_[\w]+)/) || [])[1];
    assert(sid, "开场信息里读不到会话 id：" + r2.stderr.slice(-300));
    const r3 = await run(["--no-mcp", "--session", sid, "接着刚才那条CHARLIE标记"]);
    assert.strictEqual(r3.status, 0, "--session 续接失败：" + r3.stderr.slice(-500));
    const b3 = lastBody();
    assert(b3.includes("CHARLIE标记"), "续接请求里没有新任务");
    assert(b3.includes("BRAVO标记"), "--session 续接却没带上原会话的上下文（说明历史压根没存住，上一条断言不作数）");

    // 4）管道内容要真进请求
    const r4 = await run(["--no-mcp", "看看这个报错"], "ERR_XYZ_9527 打不开");
    assert.strictEqual(r4.status, 0, "管道模式失败：" + r4.stderr.slice(-500));
    const b4 = lastBody();
    assert(b4.includes("ERR_XYZ_9527"), "管道进来的内容没进请求");
    assert(b4.includes("看看这个报错"), "管道模式下把命令行给的任务描述丢了");

    // 5）--json 是可解析的 NDJSON，最后一行必须是 done
    const r5 = await run(["--no-mcp", "--json", "给我个答案"]);
    assert.strictEqual(r5.status, 0, "--json 模式失败：" + r5.stderr.slice(-500));
    const lines = r5.stdout.trim().split("\n").filter(Boolean);
    for (const l of lines) JSON.parse(l); // 不是合法 JSON 就当场抛，管道那头 jq 会一样抛
    const done = JSON.parse(lines[lines.length - 1]);
    assert(done.type === "done" && done.ok === true, "--json 最后一行不是成功的 done：" + lines[lines.length - 1]);
    assert(String(done.session).startsWith("cli_"), "done 里没带会话 id");

    // 5b）-q 拿到的必须是干净正文：不许有前导空行，也不许多一个尾巴
    //     这条是重定向出来直接当文件用的（wb -q "写周报" > 周报.md），多一行就是脏数据
    const rq = await run(["--no-mcp", "-q", "给我个答案"]);
    assert.strictEqual(rq.status, 0, "-q 模式失败：" + rq.stderr.slice(-500));
    assert.strictEqual(rq.stdout, "答案是四十二。\n",
      "-q 的 stdout 不是干净正文（前导空行/多余换行都算脏）：" + JSON.stringify(rq.stdout));

    // 6）--list 看得见刚才这几个会话，且时间是本地时间、轮数按「问了几次」算
    const r6 = await run(["--list"]);
    const listed = r6.stdout.split("\n").filter((l) => l.startsWith("cli_"));
    assert(listed.length >= 4, "--list 只列出了 " + listed.length + " 个会话，刚跑的那几条没落盘");
    // 会话 id 里那串时间戳是本地时区的；列表这一列必须跟它对得上，否则用户照时间挑会挑错
    for (const l of listed) {
      // 第 8 列是「这条是哪个面子建的」：桌面和命令行共用同一批会话文件，
      // 列表不标出处的话，resume 挑错了面子的会话是看不出来的
      const m = l.match(/^cli_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}\S*\s+(\S+)\s+(\S+)\s+(命令行|桌面)\s+(\d+) 轮/);
      assert(m, "--list 这一行读不出「id + 日期 时间 + 来源 + 轮数」：" + JSON.stringify(l));
      assert.strictEqual(m[8], "命令行", "命令行建的会话在 --list 里没标成「命令行」：" + l);
      assert.strictEqual(m[6], `${m[1]}-${m[2]}-${m[3]}`, "--list 的日期跟会话 id 对不上（时区错了）：" + l);
      assert.strictEqual(m[7].slice(0, 2), m[4], "--list 的小时跟会话 id 对不上（八成是拿 UTC 在显示）：" + l);
      // 轮数只对没被续接过的单发会话下断言：r2 那个会话被 --session 接过一次，本来就是 2 轮
      if (sid1 && l.startsWith(sid1 + " ")) {
        assert.strictEqual(m[9], "1", "单发只问了一次却报 " + m[9] + " 轮（把 transcript 条数当轮数了）：" + l);
      }
    }

    // 3）退出码说实话
    mode = "boom";
    const r7 = await run(["--no-mcp", "这条会炸"]);
    assert.notStrictEqual(r7.status, 0, "模型报错了退出码还是 0，脚本里 `wb ... && 下一步` 会照样往下走");
    assert(r7.stderr.includes("出错"), "出错了 stderr 上没说：" + r7.stderr.slice(-300));
    mode = "ok";

    // 4）-C 指了个建不出来的目录必须停，不许默默退回默认目录
    fs.writeFileSync(path.join(home, "这是个文件"), "x");
    const r8 = await run(["--no-mcp", "-C", path.join(home, "这是个文件", "子目录"), "随便干点啥"]);
    assert.notStrictEqual(r8.status, 0, "-C 指了个用不了的目录却照跑，文件会被写到别处");
    assert(/工作目录用不了/.test(r8.stderr), "-C 失败时没说清是目录的问题：" + r8.stderr.slice(-300));

    // 反向断言：把旧那种「按天共用会话」的行为喂给同一条判据，它必须判红
    let caught = false;
    try { assert(!'{"messages":[{"content":"第一条任务ALPHA标记"}]}'.includes("ALPHA标记"), "x"); } catch { caught = true; }
    assert(caught, "闸门判据失效：带着上一条任务上下文的请求体居然也能过");
    let caught3 = false;
    try { assert.strictEqual("\n答案是四十二。\n", "答案是四十二。\n", "x"); } catch { caught3 = true; }
    assert(caught3, "-q 判据失效：带前导空行的输出居然也能过");
    let caught4 = false;
    try { // 拿 UTC 显示的老样子（id 写 17:36、列表显示 09:36）必须判红
      const l = "cli_20260905_173604_9mx  2026-09-05 09:36    1 轮  x";
      const m = l.match(/^cli_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}\S*\s+(\S+)\s+(\S+)\s+(\d+) 轮/);
      assert.strictEqual(m[7].slice(0, 2), m[4], "x");
    } catch { caught4 = true; }
    assert(caught4, "--list 时区判据失效：UTC 那版居然也能过");
    console.log(`✅ CLI 模式：单发不串台（续接才带上下文）· 答案走 stdout 进度走 stderr · 退出码 0/1 说实话 · 管道进料 · --json 可解析 · -q 是干净正文 · --list 本地时间与轮数对得上 · -C 用不了就停`);
  } finally {
    srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

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

    // 「某个功能现在已经好了」这类对本机能力的断言一律拒记。
    // 真事故：生图那条分支忘了关平台水印，agent 每次自己造中间文件擦掉，然后记下
    // 「generate_image 工具现已支持无水印出图，问题已解决」——代码里那个参数从没发过。
    // 记忆不会复核，它只会一路错下去，而且越用越确信。
    for (const bad of [
      "内置 generate_image 工具现已支持无水印出图，此前服务端强制加水印的问题已解决",
      "run_node 的依赖问题已修复，现在可以直接 require 第三方包",
      "这个接口的超时 bug 已解决",
    ]) {
      const r = mem.add({ text: bad, user: "甲" });
      assert.strictEqual(r.ok, false, "这条状态断言应当被拒记：" + bad);
      assert.ok(/试一次|偏好/.test(r.note), r.note);
    }
    // 但真·用户偏好和真·世界事实不许误伤——闸门要求主语和断言同时命中就是为了这个
    for (const good of [
      "交付物一律不要任何 AI 生成水印或标识",
      "公司的报销系统已经换成飞书了",
      "周报里不再有开场白，直接进正文",
      "用户习惯用 pnpm，不用 npm",
    ]) {
      const r = mem.add({ text: good, user: "丁" });  // 用独立作用域，别污染下面按条数算的断言
      assert.strictEqual(r.ok, true, "这条不该被拦：" + good + " / " + r.note);
    }
    // 反向断言：闸门判据本身得真的会命中，否则上面四条全绿也只说明它谁都不拦
    assert.strictEqual(mem._internals.looksStaleClaim("这个工具的问题已解决"), true, "闸门判据失效");
    assert.strictEqual(mem._internals.looksStaleClaim("交付物一律不要水印"), false, "闸门判据把普通偏好也拦了");

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
  console.log("✅ 记忆层：按账号隔离（提示词也不串）· 去重 · 密钥拒记且不落盘 · 「功能已修好」这类状态断言拒记 · 超量丢最旧留痕 · 改名跟着搬");
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
  assert.deepStrictEqual(def.input_schema.properties.action.enum, ["create", "show", "hide", "remove", "status", "sprite"], "desktop_pet 动作枚举变了");
  assert.deepStrictEqual(def.input_schema.required, ["action"], "desktop_pet 应只把 action 设为必填");
  // ⑤ 「大小」和「透明度」这两个滑块必须真的落到画面上。
  //   实测过的两个坑：
  //   a) 主进程 push() 一直在发 scale，但 pet.html 只读 opacity —— 于是滑块只改窗口大小，
  //      窗口里的猫还是 108px 纹丝不动（改前实测 60%/100%/200% 三档都是 108px）。
  //      内容缩放必须用 transform：zoom 不保证 elementFromPoint / getBoundingClientRect
  //      跟着走，而点击穿透整个是靠这两个 API 判定的。
  //   b) 透明度加在 documentElement 上会连提问气泡一起糊掉。25% 那一档下气泡实际可见度
  //      只有 0.25，而"跳出来问你问题"正是这只猫最有用的时刻。透明度只能作用在 #pet，
  //      且提问中 / 光标压着时必须回到不透明。
  const petHtml = fs.readFileSync(path.join(__dirname, "..", "public", "pet.html"), "utf8");
  assert(/setProperty\("--s"/.test(petHtml), "pet.html 没有消费 s.scale：滑「大小」只会改窗口，画面不动");
  assert(/transform:\s*scale\(var\(--s/.test(petHtml), "#pet 没有按 --s 做 transform 缩放");
  assert(!/transform:\s*none|\bzoom\s*:/.test(petHtml), "别用 zoom 缩放：命中判定那两个 API 不保证跟着走");
  assert(!/documentElement\.style\.opacity/.test(petHtml), "透明度不许加在整页上：会把提问气泡的字一起糊掉");
  assert(/#pet\.s-asking[^{]*\{[^}]*opacity:\s*1/.test(petHtml), "提问时 #pet 必须回到不透明，否则最该被看见的那一刻反而看不清");
  assert(/body\.hot #pet/.test(petHtml) && /classList\.toggle\("hot", hovering\)/.test(petHtml), "光标压在宠物身上时也该回到不透明（body.hot 没接上）");
  // 窗口跟着放大时，位置得按「底边中点不动」重算——否则每调一次大小猫就往右下挪一截
  const petJs = fs.readFileSync(path.join(__dirname, "..", "pet.js"), "utf8");
  assert(/setBounds\(\{ x: p2\.x/.test(petJs) && /sanePos\(\{ x: Math\.round\(x \+ \(ow - w\) \/ 2\)/.test(petJs),
    "改大小时没有保持底边中点不动，猫会一路往右下角挪出屏幕");
  assert(!/defaultPos\(PET_W, PET_H\)/.test(petJs), "「回到右下角」要按窗口真实尺寸算，放大到 200% 时用基准尺寸会摆到屏幕外");

  console.log("✅ 桌面宠物：无窗口时全套降级不抛 / 服务端模式如实报错 / 参数与动作枚举稳定");
  console.log("✅ 桌面宠物：大小真的缩放画面（transform 保命中判定），透明度不糊提问气泡");

  // ⑥ 精灵图形象（吃 Codex / Petdex 的图集）：渲染层三条硬约束
  //   a) 必须画在 canvas 上而不是 background-image —— 只有 canvas 读得到每个像素的 alpha，
  //      而这只宠物最核心的卖点就是"空白处不吃鼠标"。用背景图的话，一张 96×104 的方框
  //      会把底下应用的点击整块挡住，而图集里真正有东西的只是中间一小坨。
  //   b) 命中判定要按 getBoundingClientRect 换算，这样 --s 缩放后判定自动跟着走。
  //   c) 精灵图自带 6~8 帧动作，不能再叠一层 CSS 呼吸/摇摆，两套动画打架会抖。
  assert(/<canvas id="sprite"/.test(petHtml), "精灵图得画在 canvas 上（background-image 读不到 alpha，会整块挡住底下的应用）");
  assert(/getImageData\(0, 0, w, h\)/.test(petHtml), "没有把整帧的 alpha 缓存下来，逐像素穿透就无从判起");
  assert(/frameAlpha\.data\[\(py \* frameAlpha\.width \+ px\) \* 4 \+ 3\]/.test(petHtml), "solidAt 里没有按 alpha 判定精灵图");
  assert(/\(x - r\.left\) \/ r\.width \* frameAlpha\.width/.test(petHtml),
    "精灵图的命中判定没按 rect 换算（rect 已含 --s 缩放），放大缩小后会判错位置");
  assert(/\.c-sprite \.actor \{ animation: none/.test(petHtml), "精灵图上不该再叠 CSS 动画（跟图集自带的帧动画打架）");
  assert(/s\.walk === "left" \|\| s\.walk === "right"/.test(petHtml), "pet.html 没消费 walk：溜达时不会切成跑动那两行");
  assert(/spec\.map\[walk \? "walk-" \+ walk : state\]/.test(petHtml), "走路时应优先用方向对应的动作行（state 仍是 idle）");

  // 主进程侧：完成/出错的提醒得能单独关掉，且免打扰要压得住
  assert(/cfg\.notify \|\| !cfg\.notifyDone/.test(petJs), "「干完也提醒我」没有独立开关，用户只能连提问通知一起关掉");
  assert(/dndUntil/.test(petJs.slice(petJs.indexOf("function notifyFinish"), petJs.indexOf("function notifyFinish") + 900)),
    "完成通知没走免打扰：用户按了免打扰还被弹，等于这个开关是假的");
  console.log("✅ 桌面宠物：精灵图按 alpha 逐像素穿透（不是一块方框），走路/完成提醒各有独立开关");
}

/**
 * 精灵图宠物：读 Codex / Petdex 那套图集格式。
 *
 * 这里刻意不碰真实的 ~/.codex —— 用临时目录当"本机窝"，图片只造文件头（解析器本来
 * 就只读头 64 字节，造整张图是浪费）。要钉住的是三件事：
 *   1) 尺寸解析对 PNG 和 WebP 三种子格式都成立，认不出来要返回 null 而不是猜一个默认值；
 *   2) 不合规的图集必须被挡下并说清楚原因 —— 悄悄回落成内置猫，用户体感是"换了没生效"；
 *   3) 状态映射表要盖全我们自己会发出的每一个状态，且不能映到图集里不存在的行。
 */
/**
 * 连接器死了必须说清为什么死。
 *
 * 真事：用户机器上唯一一台 MCP 连接器（filesystem）一直是红的，日志只有一句
 * 「MCP 服务器 filesystem 已退出」。手动去命令行跑一遍才看到真正的死因——它配的
 * 目录 ~/Downloads/培训案例材料 早被删了，服务器自己在 stderr 上喊了
 * 「Cannot access directory ... / None of the specified directories are accessible」
 * 然后退出。而 mcp.js 里那行 stderr 处理是 () => {}，把这句话原地丢掉了。
 *
 * 「已退出」这种话等于没说：用户看不出该改配置、该装依赖、还是该重装包。
 * 所以这里钉住的不是措辞，是「失败消息里必须带上退出码和它自己最后喊的那句」。
 */
async function testMcpFailureReason() {
  const { McpManager } = require("../mcp");
  const mgr = new McpManager();
  // 假服务器：往 stderr 喊一句就带着非零退出码死掉，跟真实的 filesystem 一个形状
  await mgr.startAll([
    { name: "会喊一嗓子再死的", command: process.execPath, args: ["-e", 'console.error("配的目录不存在: /nope"); process.exit(3);'] },
    { name: "命令根本不存在的", command: "wb-no-such-binary-" + Date.now(), args: [] },
  ]);
  const byName = Object.fromEntries(mgr.failures.map((x) => [x.name, x.error]));
  const dead = byName["会喊一嗓子再死的"] || "";
  assert(dead, "死掉的连接器必须留下一条失败记录");
  assert(dead.includes("配的目录不存在: /nope"), "失败消息里没有 stderr 的原话，用户无从判断该改什么: " + dead);
  assert(dead.includes("3"), "失败消息里没有退出码: " + dead);
  // 负向对照：不能只剩一句「已退出」——那正是改之前的样子
  assert(dead.replace(/[\s\S]*已退出/, "").trim().length > 0, "失败消息退化成了光秃秃的「已退出」: " + dead);
  // 另一头：连命令都没有时，spawn 自己的 ENOENT 已经说清楚了，不该被我们的话盖掉
  const gone = byName["命令根本不存在的"] || "";
  assert(/ENOENT/.test(gone), "命令不存在时该如实报 ENOENT: " + gone);
  mgr.stop([]);
  console.log("✅ 连接器：死了会说清死因（退出码 + 它自己最后喊的那句），不是光一句「已退出」");
}

function testPetSprites() {
  const os = require("os");
  const sprites = require("../pet-sprites");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-pets-"));
  const mk = (dir, meta, sheetName, buf) => {
    fs.mkdirSync(path.join(dir), { recursive: true });
    if (meta) fs.writeFileSync(path.join(dir, "pet.json"), JSON.stringify(meta));
    if (sheetName) fs.writeFileSync(path.join(dir, sheetName), buf);
  };
  // 只造文件头：PNG 是 签名 + IHDR(宽高各一个大端 uint32)
  const png = (w, h) => {
    const b = Buffer.alloc(64);
    b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
  };
  // WebP 的 VP8X 头：24 起是两个 3 字节小端，存的是「尺寸 - 1」
  const webp = (w, h) => {
    const b = Buffer.alloc(64);
    b.write("RIFF", 0, "ascii"); b.writeUInt32LE(56, 4); b.write("WEBP", 8, "ascii");
    b.write("VP8X", 12, "ascii"); b.writeUInt32LE(10, 16);
    b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
    return b;
  };

  // ① 文件头解析：两种格式各来一张，外加一张谁都不是的
  assert.deepStrictEqual(sprites.pngSize(png(1536, 1872)), { width: 1536, height: 1872 }, "PNG 宽高读错了");
  assert.deepStrictEqual(sprites.webpSize(webp(1536, 1872)), { width: 1536, height: 1872 }, "WebP(VP8X) 宽高读错了");
  assert.strictEqual(sprites.pngSize(Buffer.alloc(64)), null, "全零的 buffer 不该被当成 PNG");
  assert.strictEqual(sprites.webpSize(Buffer.alloc(64)), null, "全零的 buffer 不该被当成 WebP");

  // ② 图集校验：标准 9 行、ChatGPT 导出的 11 行、整体压一半的，都得放行；歪的要挡下并说原因
  assert(sprites.checkSheet({ width: 1536, height: 1872 }).ok, "标准 8×9 图集被误判为不合规");
  assert(sprites.checkSheet({ width: 1536, height: 2288 }).ok, "ChatGPT 导出的 11 行图集应当兼容（后两行忽略）");
  const half = sprites.checkSheet({ width: 768, height: 936 });
  assert(half.ok && half.frameW === 96 && half.frameH === 104, "等比压一半的图集应当放行并算出 96×104 的单帧");
  for (const [size, hint] of [
    [{ width: 1000, height: 1872 }, "宽不是 8 列整数倍"],
    [{ width: 1536, height: 1664 }, "只有 8 行，不够 9 行"],
    [{ width: 1536, height: 1900 }, "高切不出整数行"],
    [null, "读不出尺寸"],
  ]) {
    const r = sprites.checkSheet(size);
    assert(!r.ok && r.why, "本该被挡下的图集放行了（" + hint + "）: " + JSON.stringify(r));
  }

  // ③ 扫目录：缺 pet.json / 缺图集的不算一只；图集歪的要列出来但标成不可用
  mk(path.join(home, "good"), { id: "good", displayName: "好猫" }, "spritesheet.webp", webp(1536, 1872));
  mk(path.join(home, "bent"), { id: "bent", displayName: "歪猫" }, "spritesheet.png", png(1000, 1872));
  mk(path.join(home, "nojson"), null, "spritesheet.png", png(1536, 1872));
  mk(path.join(home, "nosheet"), { id: "nosheet" }, null, null);
  // 只看临时窝里的那几只：这台机器上 ~/.codex/pets 里装着什么，跟这条断言无关，
  // 不过滤的话测试会随开发机上装没装宠物而飘。
  const found = sprites.scanPets(home).filter((x) => x.dir.startsWith(home));
  const ids = found.map((x) => x.id).sort();
  assert.deepStrictEqual(ids, ["bent", "good"], "扫描结果不对（缺 pet.json 或缺图集的不该算一只）: " + JSON.stringify(ids));
  const bent = found.find((x) => x.id === "bent");
  assert(!bent.ok && bent.why.includes("192×208"), "歪图集应当被标成不可用并说清原因: " + JSON.stringify(bent));
  assert(sprites.findPet("good", home) && !sprites.findPet("bent", home), "findPet 只该给出真正能用的那只");
  assert.strictEqual(sprites.findPet("查无此猫", home), null, "找不到时必须返回 null，不许兜底成别的宠物");

  // 同一只装了两份（petdex install 会往 ~/.codex 和 ~/.petdex 各放一份）：只该出现一次。
  // 这里用同一个窝里的两个目录来复现，判定走的是 pet.json 里的 id，跟目录名无关。
  mk(path.join(home, "twin-a"), { id: "twin", displayName: "双胞胎" }, "spritesheet.webp", webp(1536, 1872));
  mk(path.join(home, "twin-b"), { id: "twin", displayName: "双胞胎" }, "spritesheet.webp", webp(1536, 1872));
  const twins = sprites.scanPets(home).filter((x) => x.dir.startsWith(home) && x.id === "twin");
  assert.strictEqual(twins.length, 1, "同 id 的宠物没去重，列表里会出现两只一模一样的: " + twins.length);
  assert(twins[0].dir.endsWith("twin-a"), "去重该保留先扫到的那份（窝的顺序是有意义的）: " + twins[0].dir);

  // ④ 状态映射：我们发得出的每个状态都得有行，且不能指到图集里没有的行
  const spec = sprites.spriteSpec(found.find((x) => x.id === "good"));
  for (const st of ["idle", "working", "asking", "done", "error", "sleep", "review", "walk-left", "walk-right"]) {
    assert(spec.map[st], "状态「" + st + "」没有对应的动画行，精灵图形象下它会没反应");
  }
  assert(Object.values(spec.map).every((r) => r.row < spec.rows), "映射指到了图集里不存在的行，画出来是空白");
  // 行号不是我们定的，是 Codex / Petdex 图集里画好的位置。写错一行不会报错，
  // 只会安静地播错动画（比如「交付完成」播成「还在干活」），所以逐行钉死。
  const wantRow = { idle: 0, "walk-right": 1, "walk-left": 2, done: 3, asking: 4, error: 5, sleep: 6, working: 7, review: 8 };
  const gotRow = Object.fromEntries(Object.entries(spec.map).map(([k, v]) => [k, v.row]));
  assert.deepStrictEqual(gotRow, wantRow, "状态到行号的对应变了，画面会播错动画: " + JSON.stringify(gotRow));
  assert.strictEqual(spec.map.done.frames, 4, "挥手那行只有 4 帧，按 8 帧播会闪一截空白");
  assert.strictEqual(spec.map["walk-left"].frames, 8, "左跑那行是满 8 帧");
  // 负向对照：只有 8 行的图集，第 9 行那个状态必须被摘掉而不是照画
  const short = sprites.spriteSpec({ ok: true, id: "s", cols: 8, rows: 8, frameW: 192, frameH: 208 });
  assert(!short.map.review, "8 行的图集不该还映射 review（那是第 9 行）");
  assert(short.map.idle && short.map.working, "8 行的图集里前面几行还是该正常映射");
  assert.strictEqual(sprites.spriteSpec({ ok: false }), null, "不合规的宠物不该产出动画表");

  // ⑤ 窝的顺序：自己的排最前，同 id 时先扫到的赢（petdex install 会往两个窝各放一份）
  const roots = sprites.petRoots(home).map((r) => r.source);
  assert.deepStrictEqual(roots, ["本机", "codex", "petdex"], "宠物窝的顺序变了: " + JSON.stringify(roots));
  assert(sprites.petRoots("").every((r) => r.source !== "本机"), "传空字符串应当表示不要额外的窝（测试要能隔离掉真实家目录）");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("✅ 精灵图宠物：只读文件头就能校验图集，歪的挡下并说原因，9 个状态映射齐全");
}

/**
 * 一句「你是？」不许被当成办公任务。
 *
 * 真实数据：会话 s_1788799004126_982642 —— 用户只打了两个字「你是？」，跑的是 claude-code
 * 引擎，结果建了工作目录 `任务_0908_你是`、写了 `我是谁.md` 和 `本机能力清单.md` 两个文件，
 * 还按「做了什么／产出的文件／还差什么」汇报了一遍。这不是模型跑偏，是提示词就是这么
 * 要求的：给 CLI 的那段第一句写着「你正在执行一个办公任务」，最后一句硬性要求
 * 「写清楚产出了哪些文件」——两句话之间没有任何「先看看这是不是活」的余地。
 *
 * 所以这一条钉的不是措辞，是**顺序和条件**：
 *   ① 问题／活的判定必须存在，且排在「工作目录在哪」「先说计划」这些干活指令**前面**；
 *   ② 要求汇报产出文件的那句必须写明只在「是活」的时候才适用，不能是无条件命令。
 * 两份提示词各查一遍（内置循环 + 给 CLI 的那段），断言跑在真正拼装出来的字符串上。
 */
function questionVsWorkProblems(builtin, engineSide) {
  const bad = [];
  const idx = (text, re) => {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  // —— 内置循环 ——
  const bDisc = idx(builtin, /先分清.*(是|这次).*(问题).*(活)/);
  const bPlan = idx(builtin, /接到任务先简短说明计划/);
  if (bDisc < 0) bad.push("内置提示词里没有「先分清是问题还是活」这条判定");
  if (bPlan < 0) bad.push("内置提示词里「接到任务先简短说明计划」不见了（这条是有用的，别整段删）");
  if (bDisc >= 0 && bPlan >= 0 && bDisc > bPlan) bad.push("内置提示词：问题/活的判定排在「先说计划」后面，模型会先按前面那条办");
  if (bDisc >= 0) {
    const l = builtin.split("\n")[bDisc];
    // 收紧到「不要写文件」这个短语本身：写成 /不.*写文件/ 的话，同一行末尾那句
    // 「为一句问候建目录写文件，是白烧钱」也能把它满足掉，等于这条断言白写
    if (!/(不要|不准|别)写文件/.test(l)) bad.push("内置判定这条没说清楚「问题」不要写文件");
  }
  // —— 给 CLI 的那段 ——
  const eDisc = idx(engineSide, /先分清.*(问题).*(活)/);
  const eWork = idx(engineSide, /工作目录是/);
  const eRep = idx(engineSide, /产出了哪些文件/);
  if (eDisc < 0) bad.push("给 CLI 的提示词里没有问题/活的判定");
  if (eWork >= 0 && eDisc >= 0 && eDisc > eWork) bad.push("给 CLI 的提示词：判定排在「工作目录在哪」后面");
  if (eRep >= 0 && eDisc >= 0 && eDisc > eRep) bad.push("给 CLI 的提示词：判定排在「写清楚产出了哪些文件」后面");
  if (eRep >= 0 && !/是活的时候|确实是活|如果是活/.test(engineSide.split("\n")[eRep])) {
    bad.push("给 CLI 的提示词：要求汇报产出文件的那句是无条件的，一句问候也会触发它");
  }
  if (/正在.{0,24}执行一个办公任务/.test(engineSide)) bad.push("给 CLI 的提示词开场仍然断言「你正在执行一个办公任务」");
  return bad;
}

/** 拼装两份提示词：内置的用假 LLM 截，给 CLI 的那份用一个假引擎截 */
async function capturePrompts(mod) {
  let builtin = null, engineSide = null;
  const fakeLLM = {
    provider: "mock", model: "scripted",
    async chat({ system }) { builtin = system; return { text: "好", toolCalls: [], stopReason: "end" }; },
  };
  await mod.createAgentRuntime({ config, llm: fakeLLM, mcpManager: new McpManager(), experts: [] })
    .runTask({ history: [{ role: "user", content: "你是？" }], emit: () => {} });

  // 往注册表里塞一个假引擎，让 runViaEngine 真的走一遍——不去碰用户本机的 claude/codex
  const engines = require("../engines");
  const probe = {
    id: "e2e-probe", label: "探针", bin: null, note: "", install: "", launchHeader: "", supportsResume: false,
    async detect() { return { id: "e2e-probe", installed: true, path: "", version: "0" }; },
    async run({ systemPrompt }) { engineSide = systemPrompt; return { finalText: "好", usage: {}, stopped: null, sessionId: null }; },
  };
  engines.BACKENDS.push(probe);
  try {
    const cfg = { ...config, agent: { ...config.agent, engine: "e2e-probe" } };
    await mod.createAgentRuntime({ config: cfg, llm: fakeLLM, mcpManager: new McpManager(), experts: [] })
      .runTask({ history: [{ role: "user", content: "你是？" }], emit: () => {} });
  } finally {
    engines.BACKENDS.splice(engines.BACKENDS.indexOf(probe), 1);
  }
  return { builtin, engineSide };
}

async function testPromptQuestionVsWork() {
  const cur = await capturePrompts(require("../agent"));
  assert(cur.builtin, "没截到内置系统提示词");
  assert(cur.engineSide, "没截到给 CLI 的系统提示词");
  const bad = questionVsWorkProblems(cur.builtin, cur.engineSide);
  assert.strictEqual(bad.length, 0, "提示词会把一句问候当成办公任务：\n  - " + bad.join("\n  - "));

  // 负对照：把提示词按「以前犯过的那几种错」逐个改坏，这道闸必须每一种都拦得住。
  //
  // 早先这里是拿 git show HEAD:agent.js 当负对照的——问题是修好一提交，HEAD 就是修好的版本，
  // 负对照当场退化成 0 条，闸门自己把自己看没了。改成突变体之后它永远有效，
  // 而且是一条断言配一个突变体：哪条断言被人删了，对应那个突变体立刻漏过去。
  const lines = (t) => t.split("\n");
  const dropLine = (t, re) => lines(t).filter((l) => !re.test(l)).join("\n");
  const moveAfter = (t, re, afterRe) => {
    const ls = lines(t);
    const i = ls.findIndex((l) => re.test(l));
    if (i < 0) return t;
    const [one] = ls.splice(i, 1);
    const j = ls.findIndex((l) => afterRe.test(l));
    ls.splice(j < 0 ? ls.length : j + 1, 0, one);
    return ls.join("\n");
  };
  const DISC = /先分清/;
  const mutants = [
    ["内置提示词删掉问题/活的判定", dropLine(cur.builtin, DISC), cur.engineSide],
    ["内置提示词把判定挪到「先说计划」后面", moveAfter(cur.builtin, DISC, /接到任务先简短说明计划/), cur.engineSide],
    ["内置判定里不再说「问题不要写文件」", cur.builtin.replace(/不要写文件/g, "随你"), cur.engineSide],
    ["CLI 提示词删掉判定", cur.builtin, dropLine(cur.engineSide, DISC)],
    ["CLI 提示词把判定挪到工作目录后面", cur.builtin, moveAfter(cur.engineSide, DISC, /工作目录是/)],
    ["CLI 提示词的汇报要求变回无条件", cur.builtin, cur.engineSide.replace(/是活的时候：/g, "")],
    ["CLI 提示词开场又断言「你正在执行一个办公任务」", cur.builtin, "你正在为 OpenWorkBuddy 执行一个办公任务。\n" + cur.engineSide],
  ];
  const missed = mutants.filter(([, bi, en]) => questionVsWorkProblems(bi, en).length === 0).map(([n]) => n);
  assert(!missed.length, "这道闸门放过了改坏的提示词，说明对应断言已经失效：\n  - " + missed.join("\n  - "));
  console.log("✅ 提示词分清问题/活：两份提示词判定都在最前、汇报只对「活」生效（" + mutants.length + " 个突变体全被拦下）");
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

/**
 * 本机引擎（Claude Code / Codex）到底能不能被别人用上。
 *
 * 这一组守的是同一个真实故障：**双击图标启动的桌面版，PATH 是残废的。**
 * macOS 上 Finder / Dock 起的进程只继承 /usr/bin:/bin:/usr/sbin:/sbin，
 * 于是一台装好了 claude 和 codex 的机器，设置页上两条都写「本机没装」。
 * 从终端 npm start 起的能用、双击 App 起的用不了——这就是「别人装了却用不上」的真身。
 *
 * 断言分两层：
 *   ① 机制层（跑得起来的真代码）：补全的 PATH 必须覆盖到 node 自己所在的目录；
 *      填了绝对路径就只认它、找不到要如实报错不许悄悄换一个；
 *      detect() 收的是整份设置对象而不是字符串；probeVersion 要能跑通 shebang 脚本。
 *   ② 源码层（拼给用户看的那一面）：真连一次的接口在、前端有一键连接、
 *      切到本机引擎之后模型选择器不再假装能改模型。
 * 第二层配负对照：同一批断言照 HEAD 那版必须挑得出毛病，挑不出来说明它没在守东西。
 */
function enginePathProblems(src) {
  const bad = [];
  const has = (k, re, why) => { if (!re.test(src[k] || "")) bad.push(why); };
  // 真连一次的接口：--version 只证明文件在，证明不了能用（装了没登录长得一模一样）
  has("server", /\/api\/engines\/test/, "server.js 里没有真连一次的接口");
  has("index", /testConnect/, "engines/index.js 里没有 testConnect");
  // 找得到：三级找法那层必须真的被引擎用上
  has("index", /require\(".\/which"\)/, "engines/index.js 没接 which（GUI 启动时 PATH 是残废的）");
  has("claude", /resolveBin/, "claude-code.js 没走 resolveBin，双击启动会说没装");
  has("codex", /resolveBin/, "codex.js 没走 resolveBin，双击启动会说没装");
  has("jsonl", /augmentedPath/, "jsonl.js 没给子进程补 PATH，CLI 起来了也会在第一个工具调用上死掉");
  // 前端：一键连接 + 说清楚从哪找到的
  has("app05", /\/api\/engines\/test/, "设置页没有一键连接（用户只能看到「已装」，不知道能不能用）");
  has("app05", /e\.how|\.how\b/, "设置页没显示是从哪找到的");
  // 切到本机引擎之后，那一排 API 模型一个都用不上，不许还摆在那儿让人点
  has("app01", /activeEngine/, "app-01.js 没判断当前是不是本机引擎在跑");
  has("app02", /activeEngine/, "模型菜单没判断本机引擎，会列一排根本用不上的 API 模型");
  return bad;
}

/**
 * 成果预览的相对路径。用户的原话是「怎么在预览的时候图片都不正常显示」。
 *
 * 根因不在图上，在地址上：成果按会话分了子文件夹（任务_0905_.../hunan.html），
 * 前端曾把整条相对路径当**一个**参数 encodeURIComponent，斜杠变成 %2F，
 * 于是 iframe 里那张网页的地址只有一段，网页里 <img src="fig_hero.jpg"> 相对它一算，
 * 去要的是 /api/files/view/fig_hero.jpg —— 工作区根目录，那儿没有这张图，于是全裂。
 *
 * 这条测试不看源码，起一个**真的 server.js**，用 HTTP 把浏览器会发的那几个请求原样发一遍：
 *   ① 会话子目录里的网页取得到
 *   ② 浏览器按相对路径算出来的那张图也取得到  ← 修好的就是这一条
 *   ③ 负对照：老写法压平之后的地址必须 404（否则这条断言等于没测）
 *   ④ 老的 %2F 链接不能因为这次改动失效
 *   ⑤ 越界仍然拦得住（通配路由最容易在这儿开口子）
 */
async function testFilePathRouting() {
  const os = require("os");
  const http = require("http");
  const { spawn } = require("child_process");
  const crypto = require("crypto");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-path-"));
  const DIR = "任务_0908_测 试 站";           // 中文 + 空格：编码和斜杠两件事一起验
  const ws = path.join(home, "workspace", DIR);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "site.html"), '<!doctype html><img src="fig hero.jpg"><img src="pics/deep.png">');
  fs.writeFileSync(path.join(ws, "fig hero.jpg"), Buffer.from("JPEGDATA"));
  fs.mkdirSync(path.join(ws, "pics"), { recursive: true });
  fs.writeFileSync(path.join(ws, "pics", "deep.png"), Buffer.from("PNGDATA"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ 机密: "这份不许被 ../ 取走" }));

  // 登录态：只塞一个 token，不注册也不碰密码
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, OPENWORKBUDDY_HOME: home, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const up = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 40000);
    const tick = setInterval(() => {
      if (/已启动/.test(log)) { clearInterval(tick); clearTimeout(t); resolve(true); }
      if (child.exitCode !== null) { clearInterval(tick); clearTimeout(t); resolve(false); }
    }, 200);
  });

  const get = (p) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers: { Cookie: "wb_token=" + token } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ code: res.statusCode, body: b }));
    });
    req.on("error", (e) => resolve({ code: 0, body: e.message }));
    req.end();
  });

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + log.slice(-400));
    const enc = (rel) => "/api/files/view/" + rel.split("/").map(encodeURIComponent).join("/");

    // ① 网页本身
    const page = await get(enc(DIR + "/site.html"));
    assert(page.code === 200, "会话子目录里的网页取不到（HTTP " + page.code + "）");
    assert(/fig hero\.jpg/.test(page.body), "取回来的不是那份网页");

    // ② 浏览器按相对路径算出来的那张图 —— 这就是"图片全裂"的那一下
    const img = await get(enc(DIR + "/fig hero.jpg"));
    assert(img.code === 200 && img.body === "JPEGDATA", "网页里相对路径引的图取不到（HTTP " + img.code + "）——预览里图还是裂的");
    const deep = await get(enc(DIR + "/pics/deep.png"));
    assert(deep.code === 200 && deep.body === "PNGDATA", "再深一层的图取不到（HTTP " + deep.code + "）");

    // ③ 负对照：老写法把路径压平之后，浏览器要的就是根目录那个地址，它必须是 404。
    // 这条要是也 200，说明上面两条根本没在验什么
    const flat = await get("/api/files/view/" + encodeURIComponent("fig hero.jpg"));
    assert(flat.code === 404, "工作区根目录居然有这张图，负对照失效（HTTP " + flat.code + "）");

    // ④ 老链接（整条路径 %2F）不能失效
    const legacy = await get("/api/files/view/" + encodeURIComponent(DIR + "/site.html"));
    assert(legacy.code === 200, "老的 %2F 写法被这次改动打断了（HTTP " + legacy.code + "）");

    // ⑤ 通配路由最容易开的口子：越界
    const esc1 = await get("/api/files/view/" + encodeURIComponent("../config.json"));
    const esc2 = await get("/api/files/view/..%2F..%2Fconfig.json");
    assert(esc1.code >= 400 && esc2.code >= 400, "通配路由能读到工作区外面去（" + esc1.code + " / " + esc2.code + "）");
    assert(!/机密/.test(esc1.body + esc2.body), "越界请求把工作区外的内容吐出来了");

    console.log("✅ 成果预览路径：会话子目录里的网页和它相对路径引的图都取得到（压平写法负对照 404，%2F 老链接不断，越界仍拦得住）");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

async function testLocalEngineConnect() {
  const os = require("os");
  const which = require("../engines/which");
  const { probeVersion } = require("../engines/jsonl");
  const engines = require("../engines");

  // ① 把 PATH 换成双击图标启动时那一份，补全之后还得找得到东西。
  // 拿 node 当靶子：这台机器上跑得起测试就说明 node 装了，它在哪儿都行——
  // 找不到就说明补全那层没覆盖住这台机器的安装位置
  const crippled = "/usr/bin:/bin:/usr/sbin:/sbin";
  const oldPath0 = process.env.PATH;
  let guiHit = "";
  try { process.env.PATH = crippled; guiHit = which.findIn(which.searchDirs(), "node"); }
  finally { process.env.PATH = oldPath0; }
  assert(guiHit, "PATH 换成双击启动时那一份（" + crippled + "）之后，补全的搜索路径里找不到 node —— 真实故障就是这个：用户装了 claude/codex，设置页却写「本机没装」");
  assert(which.runnable(guiHit), "找到的 " + guiHit + " 跑不起来");

  // ② 填了绝对路径就只认它。找不到必须如实说——悄悄回落到 PATH 上另一个同名程序，
  // 等于用户以为在用 A 其实在用 B，出了事没人查得出来
  which.forget();
  const ghost = path.join(os.tmpdir(), "e2e-engine-not-here-" + Date.now());
  const r1 = await which.resolveBin("node", ghost);
  assert.strictEqual(r1.bin, "", "设置里填了一个不存在的路径，它却找到了别的东西顶上（静默降级）");
  assert(r1.why && r1.why.includes(ghost), "路径填错了却没说清楚错在哪：" + JSON.stringify(r1));

  // ③ detect() 收的是整份设置对象。以前这里传的是 engine_options[id]（一个对象），
  // 而 detect 当字符串使 —— 结果「用户填了绝对路径反而永远显示没装」
  which.forget();
  const claudeBackend = engines.get("claude-code");
  const det = await claudeBackend.detect({ bin: process.execPath });
  assert.strictEqual(det.path, process.execPath, "detect 没吃下设置对象里的 bin（拿到的是 " + det.path + "）");
  assert(det.installed, "指到一个真跑得起来的可执行文件，detect 却说没装");

  // ④ probeVersion 要能跑通 #!/usr/bin/env node 这种脚本 —— codex 就是这么装的。
  // 不给子进程补 PATH 的话，它会死在 "env: node: No such file or directory"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-shebang-"));
  const script = path.join(dir, "fakecodex");
  fs.writeFileSync(script, "#!/usr/bin/env node\nconsole.log('codex-cli 9.9.9');\n");
  fs.chmodSync(script, 0o755);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin"; // 双击图标启动时就是这一份
    const pv = await probeVersion(script, ["--version"]);
    assert(pv.installed && /9\.9\.9/.test(pv.version), "shebang 脚本在残废 PATH 下探不出版本（codex 就是这种）：" + JSON.stringify(pv));
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ⑤ 连不上要把原因和下一步分开说，而不是抛个异常让前端显示「测试失败」
  const stub = {
    id: "e2e-noauth", label: "假引擎", bin: "e2e-noauth", note: "", install: "跑一下 e2e-noauth login",
    launchHeader: "", supportsResume: false,
    async detect() { return { id: "e2e-noauth", installed: true, path: "/tmp/e2e-noauth", version: "1.0" }; },
    async run() { throw new Error("还没登录：先在终端跑一次登录命令"); },
  };
  engines.BACKENDS.push(stub);
  let tc;
  try { tc = await engines.testConnect("e2e-noauth", {}); }
  finally { engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1); }
  assert.strictEqual(tc.ok, false, "引擎跑起来就报错，testConnect 却说连通了");
  assert(/登录/.test(tc.why), "没把「没登录」这个原因带出来：" + tc.why);
  assert(tc.hint && tc.hint.includes("login"), "连不上却没给下一步该敲什么：" + JSON.stringify(tc.hint));

  // ⑥ 源码层的闸门 + 负对照
  const read = (p) => { try { return fs.readFileSync(path.join(__dirname, "..", p), "utf8"); } catch { return ""; } };
  const now = {
    server: read("server.js"), index: read("engines/index.js"), claude: read("engines/claude-code.js"),
    codex: read("engines/codex.js"), jsonl: read("engines/jsonl.js"),
    app05: read("public/js/app-05.js"), app01: read("public/js/app-01.js"), app02: read("public/js/app-02.js"),
  };
  const nowBad = enginePathProblems(now);
  assert.strictEqual(nowBad.length, 0, "本机引擎这条路还缺东西：\n  - " + nowBad.join("\n  - "));

  // 负对照：把每个文件逐个清空，对应那条断言必须当场报警。
  // 一次只动一个，才能证明「每一条断言都还活着」，而不是靠某一条兜住全部
  const missedFiles = Object.keys(now).filter((k) => {
    const n0 = enginePathProblems({ ...now, [k]: "" }).length;
    return n0 === 0;
  });
  assert(!missedFiles.length, "这几个文件整个清空了这道闸门都没反应，说明它没在守它们：" + missedFiles.join(", "));
  console.log("✅ 本机引擎可连：残废 PATH 下也能找到 CLI、绝对路径不静默降级、shebang 脚本探得出版本、连不上给得出下一步（" + Object.keys(now).length + " 个文件逐个清空全被拦下）");
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
  testCssTokenGate();
  testMotionGate();
  testVerdictGate();
  testDocLinkGate();
  await testImageWatermarkGate();
  await testVideoWatermarkGate();
  await testCliMode();
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
  await testPromptQuestionVsWork();
  await testLocalEngineConnect();
  await testEngineToolBridge();
  testOutputOwnership();
  await testFilePathRouting();
  await testDesktopPet();
  testPetSprites();
  await testMcpFailureReason();
  await testThinkingSwitch();
  await testThinkingSettingsApi();
  testUiNoRawMarkdown();
  // 清理测试产物
  for (const f of fs.readdirSync(WORKSPACE)) {
    if (f.startsWith("e2e-")) fs.rmSync(path.join(WORKSPACE, f), { force: true });
  }
  console.log("=== 全部测试通过 ===");
}

/**
 * 思考模式开关：「有思考模式的模型可以支持关闭思考模式的设置啊」。
 *
 * 这个开关最容易做成花架子——界面上写着「已关闭」，请求体里一个参数都没变。
 * 所以这里不验"有没有这个下拉框"，验三件能出事的事：
 *   ① 默认档（auto）真的一个字节都不改老行为，不然所有存量用户的账单和输出一起变；
 *   ② 选了档，参数真的进到发出去的请求体里（起个假接口把 body 原样回显来看）；
 *   ③ 关不掉的时候如实说关不掉，不许拿一句"已关闭"糊过去（OpenAI 最低只有 minimal，
 *      deepseek-reasoner 根本没有开关，老版本 claude 会把 --thinking 静默吞掉）。
 */
async function testThinkingSwitch() {
  const thinking = require("../thinking");
  const http = require("http");
  const { openaiChat } = require("../llm")._internals;

  const M = {
    claude: { provider: "anthropic", model: "claude-sonnet-4-5" },
    claudeOld: { provider: "anthropic", model: "claude-3-5-sonnet" },
    or: { base_url: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4.5" },
    gpt5: { base_url: "https://api.openai.com/v1", model: "gpt-5.4-mini" },
    qwen: { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-max" },
    glm: { base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
    dsR: { base_url: "https://api.deepseek.com/v1", model: "deepseek-reasoner" },
    weird: { base_url: "https://llm.example.internal/v1", model: "某个自建模型" },
  };

  // ① 默认档：任何模型、任何厂商，一个参数都不发。老用户的行为一个字节不变
  for (const [k, e] of Object.entries(M)) {
    const p = thinking.planFor(e, "auto");
    assert(Object.keys(p.params).length === 0, `auto 档给 ${k} 发了参数（${JSON.stringify(p.params)}）——存量用户的行为被这次改动改了`);
    assert(p.supported, "auto 档不该被标成不支持");
  }
  // 没填档位、填了乱七八糟的东西，都按 auto 走（这条路是配置文件手改进来的）
  for (const bad of [undefined, "", "全开", "HIGH ", null, 3]) {
    const lv = thinking.norm(bad);
    assert(lv === "auto" || lv === "high", "认不出的档位没退回 auto：" + JSON.stringify(bad) + " → " + lv);
  }
  assert(thinking.norm("HIGH ") === "high", "大小写/空格没归一化");

  // ② 关：各家参数名不一样，一家一家验。这张表错一个就是 400，任务当场挂
  assert.deepStrictEqual(thinking.planFor(M.claude, "off").params, {}, "Anthropic 关思考应该是不发 thinking 字段");
  assert.deepStrictEqual(thinking.planFor(M.or, "off").params, { reasoning: { enabled: false } }, "OpenRouter 关思考的参数不对");
  assert.deepStrictEqual(thinking.planFor(M.qwen, "off").params, { enable_thinking: false }, "通义关思考的参数不对");
  assert.deepStrictEqual(thinking.planFor(M.glm, "off").params, { thinking: { type: "disabled" } }, "智谱关思考的参数不对");
  // ③ 开：强度得真的传下去，而不是三档发同一个东西
  const budgets = ["low", "medium", "high"].map((lv) => thinking.planFor(M.claude, lv).params.thinking.budget_tokens);
  assert(new Set(budgets).size === 3 && budgets[0] < budgets[1] && budgets[1] < budgets[2], "Claude 三档思考预算没有递增：" + budgets.join("/"));
  assert(budgets[2] < 32000, "思考预算必须小于 max_tokens(32000)，否则 Anthropic 直接 400");
  assert.deepStrictEqual(thinking.planFor(M.or, "high").params, { reasoning: { effort: "high" } }, "OpenRouter 强度没传下去");
  assert(thinking.planFor(M.qwen, "low").params.thinking_budget < thinking.planFor(M.qwen, "high").params.thinking_budget, "通义强度没分档");

  // ④ 关不到零就别谎称关到零 —— 这三条是「如实告知」的红线
  const o = thinking.planFor(M.gpt5, "off");
  assert(o.params.reasoning_effort === "minimal", "OpenAI 推理模型关档应发 minimal（它没有真正的零）");
  assert(/minimal|最低/.test(o.note), "OpenAI 关不到零这件事没在说明里讲出来：" + o.note);
  const ds = thinking.planFor(M.dsR, "off");
  assert(!ds.supported && Object.keys(ds.params).length === 0, "deepseek-reasoner 关不掉，不该假装关掉");
  assert(/deepseek-chat/.test(ds.note), "没告诉用户 deepseek 要不思考得换模型：" + ds.note);
  const old = thinking.planFor(M.claudeOld, "high");
  assert(!old.supported && Object.keys(old.params).length === 0, "不带扩展思考的老 Claude 型号发了 thinking 字段（会 400）");

  // ⑤ 认不出的接口：宁可不发。乱发一个参数 = 400 = 任务当场挂，比开关不生效糟得多
  const w = thinking.planFor(M.weird, "off");
  assert(!w.supported && Object.keys(w.params).length === 0, "认不出的接口居然瞎发了参数：" + JSON.stringify(w.params));
  assert(/extra_body/.test(w.note), "认不出时没告诉用户可以自己在 extra_body 里填：" + w.note);

  // ⑥ 本机 CLI 那条路（用户原话：跟 app 设置保持一致）
  assert.deepStrictEqual(thinking.planForEngine("claude-code", "auto", { thinkingFlag: true }).args, [], "auto 档不该给 CLI 加参数");
  assert.deepStrictEqual(thinking.planForEngine("claude-code", "off", { thinkingFlag: true }).args, ["--thinking", "disabled"], "claude 关思考的参数不对");
  assert.deepStrictEqual(thinking.planForEngine("claude-code", "high", { thinkingFlag: true }).args, ["--thinking", "enabled"], "claude 开思考的参数不对");
  assert.deepStrictEqual(thinking.planForEngine("codex", "off").args, ["-c", 'model_reasoning_effort="none"'], "codex 关思考的参数不对");
  assert.deepStrictEqual(thinking.planForEngine("codex", "medium").args, ["-c", 'model_reasoning_effort="medium"'], "codex 强度没传下去");
  // 老版本 claude 不认识 --thinking，而且是**静默**忽略：发了等于没发，必须明说不生效
  const oldCli = thinking.planForEngine("claude-code", "off", { thinkingFlag: false });
  assert(!oldCli.supported && oldCli.args.length === 0, "探到 CLI 不支持还硬发 --thinking，用户点了没反应也看不出为什么");
  assert(/升级|没有 --thinking/.test(oldCli.note), "没告诉用户为什么不生效：" + oldCli.note);

  // ⑦ 探测本身：claude 对不认识的选项静默退出 0，这是整条链路的地基，塌了上面全是空的
  const { probeOption } = require("../engines/jsonl");
  const claudeBin = await require("../engines/which").resolveBin("claude", "");
  if (claudeBin.bin) {
    assert(await probeOption(claudeBin.bin, "--thinking"), "本机 claude 探不到 --thinking（探测逻辑坏了，或者该升级 claude 了）");
    assert(!(await probeOption(claudeBin.bin, "--owb-no-such-flag")), "探测把不存在的选项也说成支持——那它就永远只会说 yes");
  }
  assert(!(await probeOption("/owb/no/such/bin", "--thinking")), "探一个不存在的程序应该老实说不支持，不该抛出去");

  // ⑧ 真发出去的请求体：假接口把收到的 body 原样回显，看参数到底进没进去
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push(JSON.parse(b));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const args = { system: "s", history: [{ role: "user", content: "hi" }], tools: [] };
  const call = (extra) => openaiChat({ base_url: `http://127.0.0.1:${port}/v1`, api_key: "k", model: "qwen3-max", ...extra }, args);
  try {
    await call({});                          // 没配档位 = 今天的行为
    await call({ thinking: "auto" });        // 显式 auto
    await call({ thinking: "off" });
    await call({ thinking: "high" });
    // extra_body 是老资格的逃生口：这张表哪家猜错了，用户不用等我改代码，自己就能纠正
    await call({ thinking: "off", extra_body: { enable_thinking: true } });
  } finally { srv.close(); }
  assert(seen.length === 5, "假接口没收满 5 次请求");
  assert(!("enable_thinking" in seen[0]) && !("enable_thinking" in seen[1]), "默认档往请求体里塞了思考参数 —— 存量用户的行为被改了");
  assert(seen[2].enable_thinking === false, "选了「关闭」，请求体里却没有关思考的参数（界面骗人）");
  assert(seen[3].enable_thinking === true && seen[3].thinking_budget > 0, "选了「高」，请求体里没有开思考的参数");
  assert(seen[4].enable_thinking === true, "用户手填的 extra_body 被下拉框覆盖了（逃生口没了）");
  for (const b of seen) assert(b.model === "qwen3-max" && Array.isArray(b.messages), "核心字段被思考参数挤掉了");

  // ⑨ 接线：本机引擎那条路要真把档位传进去，而且要排在 opts 前面 ——
  //    排在后面的话，engine_options 里没写 thinking 的用户（绝大多数）会被 undefined 覆盖成不生效
  const src = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
  const at = src.indexOf("const r = await backend.run({");
  assert(at > 0, "agent.js 里找不到 backend.run 调用");
  const block = src.slice(at, src.indexOf("});", at));
  assert(/thinking:\s*config\.agent\.thinking/.test(block), "本机引擎接管时没把 app 的思考模式设置传下去（用户要的就是这两边一致）");
  assert(block.indexOf("thinking:") < block.indexOf("...opts"), "thinking 排在 ...opts 后面了，单个引擎就没法覆盖全局档位");
  for (const [f, label] of [["engines/claude-code.js", "claude"], ["engines/codex.js", "codex"]]) {
    const t = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert(/planForEngine\(/.test(t), label + " 引擎没接思考模式，设置页选了也传不到命令行");
  }

  console.log("✅ 思考模式：默认档零改动（负向控制） · 关/强度真进请求体 · extra_body 压得住 · 关不掉时如实说 · 本机 CLI 两条都接上了");
}

/**
 * 设置接口这一头：档位存得住、读得回、写错了当场拒绝。
 *
 * 「当场拒绝」是这条里最要紧的一句。悄悄退回 auto 的后果是：用户以为思考关掉了、
 * 按关掉的速度和价钱做打算，账单却照着思考的量在涨——跟「不静默降级用户配的模型」
 * 是同一条红线。
 */
async function testThinkingSettingsApi() {
  const os = require("os");
  const http = require("http");
  const { spawn } = require("child_process");
  const crypto = require("crypto");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-think-"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, OPENWORKBUDDY_HOME: home, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const up = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 40000);
    const tick = setInterval(() => {
      if (/已启动/.test(log)) { clearInterval(tick); clearTimeout(t); resolve(true); }
      if (child.exitCode !== null) { clearInterval(tick); clearTimeout(t); resolve(false); }
    }, 200);
  });

  const req = (method, p, body) => new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: { Cookie: "wb_token=" + token, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json: j }); });
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message, json: null }));
    if (data) r.write(data);
    r.end();
  });

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + log.slice(-400));
    const s0 = await req("GET", "/api/settings");
    assert(s0.json && s0.json.agent, "设置读不出来");
    assert(s0.json.agent.thinking === "auto", "新装的默认档不是 auto（存量用户的行为会被改）：" + s0.json.agent.thinking);

    const w = await req("POST", "/api/settings", { agent: { thinking: "off" } });
    assert(w.code === 200, "存不进去（HTTP " + w.code + " " + w.body.slice(0, 200) + "）");
    const s1 = await req("GET", "/api/settings");
    assert(s1.json.agent.thinking === "off", "存了读不回来：" + s1.json.agent.thinking);
    // 落盘：进程重启后还得在（设置页最容易做成只活在内存里）
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert(onDisk.agent.thinking === "off", "档位没写进 config.json，重启就丢");

    const bad = await req("POST", "/api/settings", { agent: { thinking: "关掉" } });
    assert(bad.code >= 400, "乱写的档位居然存进去了（HTTP " + bad.code + "）");
    const s2 = await req("GET", "/api/settings");
    assert(s2.json.agent.thinking === "off", "写错一次就把用户原来的档位冲掉了：" + s2.json.agent.thinking);

    const t = await req("GET", "/api/thinking");
    assert(t.json && Array.isArray(t.json.levels) && t.json.levels.length === 5, "/api/thinking 没给出五个档位");
    assert(t.json.current === "off", "/api/thinking 报的当前档位不对：" + t.json.current);
    for (const l of t.json.levels) assert(l.label && typeof l.supported === "boolean" && "note" in l, "档位说明不全，界面没东西可显示：" + JSON.stringify(l));
    assert(t.json.levels.every((l) => l.level !== "auto" || l.supported), "auto 档被标成不支持了");

    console.log("✅ 思考模式设置：存得住/落得了盘/读得回 · 写错当场拒绝且不冲掉原设置 · 界面拿得到每一档的如实说明");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 产出归属：一条对话的成果卡片里绝不能出现另一条对话的文件。
 *
 * 事故原样（data/sessions/s_1788803711031_608301.json 里存着现场）：
 * 湖南网站那条对话 17:38 起跑、一直在写文件；用户 17:55 另开一条问 paywall 的新对话，
 * 新对话第一轮的 changed 里躺着五个别人的文件——
 *   任务_0905_给我做一个网站介绍湖南的/{_have.txt,_r2.txt,_dh.txt,dist/index.html,hunan_travel.html}
 * 用户原话：「这些图标是另一个对话的啊！」。
 *
 * 根因是归属只按「谁的差异检测先跑到」算，而先后跟谁写的没有关系。这里把两条对话的
 * 检测顺序两种都跑一遍——顺序反过来还能判对，才说明判据换成了确定性的那一个。
 */
function testOutputOwnership() {
  const { makeOwnership } = require("../agent");
  const A = "任务_0905_给我做一个网站介绍湖南的"; // 先起跑、正在写文件的那条
  const B = "任务_0907_复制支付墙网站难易度分析"; // 用户新开的那条
  const REAL = ["_have.txt", "_r2.txt", "_dh.txt", "dist/index.html", "hunan_travel.html"].map((n) => A + "/" + n);
  const f = (name, mtime) => ({ name, mtime: mtime || "2026-09-07T17:55:00.000Z", size: 10 });

  // ① 正常顺序：谁的文件夹就是谁的
  {
    const own = makeOwnership();
    own.claimBaseDir(A, 1);
    own.claimBaseDir(B, 2);
    assert(REAL.every((n) => own.mine(f(n), A, 1)), "自己文件夹里的产出被判成别人的了");
    assert(REAL.every((n) => !own.mine(f(n), B, 2)), "别的对话的文件进了这条对话的产出");
  }

  // ② 事故的真实顺序：新对话的检测先跑到。先到先得那套在这儿必错，这条是这次修复的核心
  {
    const own = makeOwnership();
    own.claimBaseDir(A, 1);
    own.claimBaseDir(B, 2);
    const stolen = REAL.filter((n) => own.mine(f(n), B, 2));
    assert.deepStrictEqual(stolen, [], "检测顺序反过来就又认反了，说明还在按先后判归属：" + JSON.stringify(stolen));
    assert(REAL.every((n) => own.mine(f(n), A, 1)), "拦住新对话的同时，把真正的主人也拦了——文件就彻底没人认了");
  }

  // ③ 负向控制：把「按文件夹判」这一层关掉，事故必须原样复现。复现不出来说明这条测试测了个寂寞
  {
    const own = makeOwnership();
    own.claimBaseDir(B, 2); // A 没登记 = 相当于没有目录归属这一层
    const stolen = REAL.filter((n) => own.mine(f(n), B, 2));
    assert.strictEqual(stolen.length, REAL.length, "缺了目录归属这层，五个文件本该整批被认走，事故没复现出来：" + JSON.stringify(stolen));
  }

  // ④ 不许过度封杀：没人认领的目录、工作区根目录下的文件，照旧算这一轮的产出
  {
    const own = makeOwnership();
    own.claimBaseDir(B, 2);
    assert(own.mine(f("未认领的目录/图.png"), B, 2), "把没人认领的目录也封了，真产出会看不见");
    assert(own.mine(f("粘贴图片_0907.png"), B, 2), "工作区根目录下的文件被误杀了");
  }

  // ⑤ 根目录没有文件夹可依，只能靠「版本认领」去重；文件再被改一次要允许重新认领
  {
    const own = makeOwnership();
    own.claimBaseDir(A, 1);
    own.claimBaseDir(B, 2);
    assert(own.mine(f("root.png", "t1"), B, 2), "第一个看到的应该认得下");
    assert(!own.mine(f("root.png", "t1"), A, 1), "同一版本被认领两次，两条对话都会摆一张卡");
    assert(own.mine(f("root.png", "t2"), A, 1), "文件又被改了一次，新版本必须允许重新认领");
  }

  // ⑥ 专家子任务跟父任务共用 runToken：自己人不许互相抢
  {
    const own = makeOwnership();
    own.claimBaseDir(A, 7);
    assert(own.mine(f(A + "/报告.md", "t1"), A, 7), "父任务认领失败");
    assert(own.mine(f(A + "/报告.md", "t1"), A, 7), "同一个 runToken 再看一次就不算自己的了，专家的产出会丢");
  }

  // ⑦ 没有会话文件夹时（自定义项目工作区，baseDir 为空）不能崩，也不能把所有东西都判成别人的
  {
    const own = makeOwnership();
    own.claimBaseDir("", 1);
    own.claimBaseDir(A, 2);
    assert(own.mine(f("产出.md"), "", 1), "baseDir 为空时根目录产出被误杀");
    assert(!own.mine(f(A + "/x.md"), "", 1), "baseDir 为空也不该去动别人文件夹里的东西");
  }

  // ⑧ 同一条对话的两轮共用同一个任务文件夹（会话文件夹跨轮不变，runToken 每轮 +1）。
  //    第二轮开跑会把这个文件夹重新登记到自己名下，此时第一轮的收尾还在往外发 files 事件——
  //    「自己的文件夹一律豁免」这道就是挡在这儿的，没有它第一轮的产出会被自己人判成别人的。
  {
    const own = makeOwnership();
    own.claimBaseDir(A, 1);            // 第一轮
    own.claimBaseDir(A, 2);            // 第二轮开跑，文件夹改记在它名下
    assert(!own.inForeignDir(A + "/上一轮.md", A, 1), "同一个文件夹换了轮次就不认自己了，上一轮的收尾产出会整批丢");
    assert(own.mine(f(A + "/上一轮.md", "t1"), A, 1), "上一轮的产出被自己人抢走了");
    assert(own.mine(f(A + "/这一轮.md", "t1"), A, 2), "这一轮在自己文件夹里的产出也被判成了别人的");
  }

  // ⑨ 接线：判据写得再对，哪条路忘了用还是白搭 —— 出事那次就是 runViaEngine（本机 CLI 那条）
  //    一道关都没接，别人正在写的文件整批挂进了新对话。两条引擎路径都得：开跑先登记自己的
  //    文件夹，每个差异出来的文件都过一遍 mine()。
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
    for (const [fn, label] of [["runViaEngine", "本机 CLI 引擎"], ["runTask", "内置引擎"]]) {
      const at = src.indexOf("async function " + fn + "(");
      assert(at > 0, "agent.js 里找不到 " + fn);
      const body = src.slice(at, src.indexOf("const emitFiles = () =>", at) + 1200);
      assert(/claimBaseDir\(baseDir, runToken\)/.test(body), label + "（" + fn + "）开跑没登记自己的任务文件夹，归属就没有确定性依据了");
      assert(/ownership\.mine\(f, baseDir, runToken\)/.test(body), label + "（" + fn + "）的产出没过归属判定，别的对话正在写的文件会挂到这条来");
    }
  }

  console.log("✅ 产出归属：按文件夹判主（检测顺序反过来也认得对）· 根目录靠版本认领 · 同对话跨轮不自伤 · 未认领目录不误杀 · 负向控制能复现事故");
}

/**
 * 本机引擎借工具：MCP 一条路，命令行一条路，两条都得是真能用的。
 *
 * 为什么非得有第二条路：codex 0.146 接到非 OpenAI 模型上时（用户 config.toml 里
 * model_provider 指向别家），它把我们的服务器拉起来、initialize 和 tools/list 全答了，
 * 却一个 MCP 工具都不往模型手里挂。抓 RPC 日志验过。这不是本项目的 bug，也不是本项目
 * 能修的地方——所以同一份实现再开一个命令行入口，两个 CLI 都有 shell，这条路谁都拦不住。
 *
 * 这里全部起真子进程跑，不 mock：mock 只能证明我写的 if 分支对，证明不了模型敲那条命令能出图。
 */
async function testEngineToolBridge() {
  const os = require("os");
  const { execFileSync } = require("child_process");
  const bridge = require("../engines/bridge");
  const tb = require("../engines/tool-bridge");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-bridge-home-"));
  const BASE = "任务_甲";
  const run = (shim, args, opts = {}) => {
    try {
      const out = execFileSync("/bin/sh", [shim, ...args], { encoding: "utf8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"], input: opts.input || "" });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status == null ? -1 : e.status, out: String(e.stdout || "") + String(e.stderr || "") };
    }
  };

  // ① codex：命令行是主路（MCP 挂不上），但 mcpArgs 仍然给出去——万一哪天它修好了就自动生效
  const cx = bridge.attach("codex", { home, baseDir: BASE, user: "e2e" });
  try {
    assert.strictEqual(cx.shimIsPrimary, true, "codex 那边命令行必须是主路：MCP 在它上面挂不出工具");
    assert(cx.shim && fs.existsSync(cx.shim), "codex 没生成命令行入口脚本");
    assert(cx.runOpts.mcpArgs && cx.runOpts.mcpArgs.length, "codex 的 -c mcp_servers.* 参数没给");
    // 脚本得挂进子进程 PATH：模型敲带绝对路径的命令，两个 CLI 的权限层都会判「需要审批」，
    // 非交互模式下没人能点同意 —— 挂了工具等于没挂。裸命令 + 一条放行规则才通得了。
    assert(cx.runOpts.env && String(cx.runOpts.env.PATH || "").split(path.delimiter)[0] === cx.shimDir,
      "shim 目录没挂到 PATH 最前面，模型敲裸 owb 找不到东西：" + JSON.stringify(cx.runOpts.env));
    assert.strictEqual(cx.shimBin, "owb", "命令名变了，提示词和放行规则就对不上了");
    assert.strictEqual(cx.runOpts.shimBin, "owb", "shimBin 没传给引擎，放行规则就下不去");
    // codex 的 workspace-write 只让写 cwd，remember / save_skill 要写数据目录（在 cwd 外）
    assert(Array.isArray(cx.runOpts.writableRoots) && cx.runOpts.writableRoots.includes(home),
      "没给 codex 开数据目录的写权限，记忆和技能会存不下：" + JSON.stringify(cx.runOpts.writableRoots));
    assert.strictEqual(cx.lent.length, tb.LENDABLE.length, "借出的工具数对不上：" + cx.lent.length + " vs " + tb.LENDABLE.length);

    // 脚本得把环境变量烘进去。不烘的话就得让模型自己带 OPENWORKBUDDY_HOME=... 前缀，
    // 它十次有三次会漏，漏了就落到错误的数据目录里，用户在成果面板里什么都看不到。
    const shimSrc = fs.readFileSync(cx.shim, "utf8");
    assert(shimSrc.includes(home), "脚本里没烘进 OPENWORKBUDDY_HOME，模型调出来的东西会落到别的目录");
    assert(shimSrc.includes(BASE), "脚本里没烘进本次会话的子目录");

    // ② list：模型得看得见有哪些工具、必填什么
    const ls = run(cx.shim, ["list"]);
    assert.strictEqual(ls.code, 0, "shim list 跑挂了：" + ls.out.slice(0, 300));
    for (const n of ["generate_image", "generate_video", "gen_diagram", "check_page", "web_search", "save_skill", "remember"])
      assert(ls.out.includes(n), "list 里没有 " + n + " —— 模型不知道自己有这个");
    assert(/必填/.test(ls.out), "list 没告诉模型必填参数是什么，它只能瞎猜着拼");

    // ③ 真调一次，出真文件，且落在本次会话的子目录里（不是 workspace 根）。
    //    生图要花钱、要网，这里用 gen_diagram：同一条 callTool 路径，dot 离线就能出图。
    const g = run(cx.shim, ["gen_diagram", JSON.stringify({ kind: "dot", source: "digraph{A->B}", filename: "e2e_bridge.png" })]);
    assert.strictEqual(g.code, 0, "命令行调工具失败：" + g.out.slice(0, 300));
    const landed = path.join(home, "workspace", BASE, "e2e_bridge.png");
    assert(fs.existsSync(landed), "工具跑完了但文件没落在会话子目录里，用户在成果面板看不到它：" + landed);

    // ④ `call x` 和直接 `x` 两种写法都得收 —— 模型两种都会写
    const g2 = run(cx.shim, ["call", "gen_diagram", JSON.stringify({ kind: "dot", source: "digraph{C->D}", filename: "e2e_bridge2.png" })]);
    assert.strictEqual(g2.code, 0, "`call <工具名>` 这种写法不认：" + g2.out.slice(0, 200));

    // ⑤ 长参数走 @文件 和 stdin，别跟 shell 引号硬拼
    const argf = path.join(home, "args.json");
    fs.writeFileSync(argf, JSON.stringify({ kind: "dot", source: "digraph{E->F}", filename: "e2e_bridge3.png" }));
    assert.strictEqual(run(cx.shim, ["gen_diagram", "@" + argf]).code, 0, "@文件 传参不认");
    assert.strictEqual(run(cx.shim, ["gen_diagram", "-"], { input: JSON.stringify({ kind: "dot", source: "digraph{G->H}", filename: "e2e_bridge4.png" }) }).code, 0, "stdin 传参不认");

    // ⑥ 负向：没借出去的工具必须拒，且退出码非 0。
    //    命令行入口等于把 tools.js 整个摊在 shell 上，白名单漏了就是模型能随便 write_file / run_shell。
    const bad = run(cx.shim, ["write_file", '{"path":"x.txt","content":"y"}']);
    assert.strictEqual(bad.code, 1, "没借出去的工具竟然放行了（白名单漏了）：" + bad.out.slice(0, 200));
    assert(/没有借给/.test(bad.out), "拒了但没说清为什么：" + bad.out.slice(0, 200));
    assert(!fs.existsSync(path.join(home, "workspace", BASE, "x.txt")), "被拒的工具居然还是把文件写出来了");

    // ⑦ 负向：坏参数要 exit 1 并把原因打出来。exit 0 的话模型会以为成了，接着往交付里写「图已生成」
    const bj = run(cx.shim, ["gen_diagram", "{oops"]);
    assert.strictEqual(bj.code, 1, "参数是坏 JSON 却报了成功");
    assert(/JSON/.test(bj.out), "坏 JSON 没说清楚：" + bj.out.slice(0, 200));
  } finally { cx.cleanup(); }
  assert(!fs.existsSync(cx.shim), "任务跑完了 shim 没删干净，/tmp 里会越堆越多");

  // ⑧ claude 那边 MCP 是主路，shim 只兜底；配置文件得是 MCP 认的形状
  const cc = bridge.attach("claude-code", { home, baseDir: BASE, user: "e2e" });
  try {
    assert.strictEqual(cc.shimIsPrimary, false, "claude 那边 MCP 是能用的，别把它也降级到命令行");
    const cfg = JSON.parse(fs.readFileSync(cc.runOpts.mcpConfigPath, "utf8"));
    assert(cfg.mcpServers && cfg.mcpServers[bridge.SERVER_NAME], "mcp 配置文件不是 { mcpServers: {...} } 这个形状，claude 读不懂");
    assert(cc.runOpts.mcpServerNames.includes(bridge.SERVER_NAME), "没把服务器名带出去，--allowed-tools 就白名单不上，claude -p 会自动拒掉每一次调用");
    assert(cc.shim && fs.existsSync(cc.shim), "claude 这边也得留一条命令行兜底");
    assert(cc.runOpts.env && String(cc.runOpts.env.PATH || "").split(path.delimiter)[0] === cc.shimDir, "claude 这边 shim 也得挂 PATH");
    assert.strictEqual(cc.runOpts.shimBin, "owb", "claude 这边没传 shimBin，Bash 放行规则就下不去");
  } finally { cc.cleanup(); }

  // ⑨ MCP 那条路本身的形状：tools/list 必须是 inputSchema（小驼峰），本项目内部是 input_schema
  const listed = tb.listTools();
  assert(Array.isArray(listed) && listed.length === tb.LENDABLE.length, "tools/list 返回的工具数不对：" + listed.length);
  assert(listed.every((t) => t.inputSchema && !t.input_schema), "tools/list 用了 input_schema（下划线），MCP 客户端认的是 inputSchema");
  assert(listed.every((t) => t.description && t.description.length > 10), "有工具没描述，模型看不出它是干什么的");
  assert(!listed.some((t) => /^mcp__/.test(t.name)), "工具名自己带了 mcp__ 前缀，CLI 还会再挂一层，名字就对不上了");

  // ⑩ 提示词得真把这条路告诉模型。挂了工具却不点名，等于把东西锁柜子里不给钥匙——
  //    真实会话里模型就是翻完工具表说「本会话依旧没有任何生图工具，请你自己把图放进去」。
  const agentSrc = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
  const fm = agentSrc.match(/function bridgedLine\(bridged\) \{[\s\S]*?\n  \}/);
  assert(fm, "agent.js 里找不到 bridgedLine —— 那模型就永远不知道自己有这些工具");
  const bridgedLine = new Function("return " + fm[0].replace("function bridgedLine", "function") + ";")();
  const shimPath = "/tmp/owb-shim-xyz/owb";
  const cxLine = bridgedLine({ lent: tb.LENDABLE, shim: shimPath, shimBin: "owb", shimIsPrimary: true });
  assert(/\bowb list\b/.test(cxLine), "codex 的提示词里没给出命令行入口，它就一个工具也用不上");
  assert(cxLine.includes("generate_image"), "没点名生图工具");
  assert(!/mcp__openworkbuddy__/.test(cxLine), "codex 上 MCP 工具根本挂不出来，还在提示词里报这些名字，模型会去找不存在的东西");
  // 负向：提示词里绝不能出现 shim 的绝对路径 —— 带路径的命令会被判「需要审批」，
  // 非交互下没人点同意，模型三次都被拦，最后在交付里写「没能用上 OWB 的工具」。真跑出来过。
  assert(!cxLine.includes(shimPath), "提示词里给的是绝对路径，模型照着敲会被权限层拦下");
  const ccLine = bridgedLine({ lent: tb.LENDABLE, shim: shimPath, shimBin: "owb", shimIsPrimary: false });
  assert(/mcp__openworkbuddy__generate_image/.test(ccLine), "claude 的提示词里没点名 MCP 工具");
  assert(/\bowb list\b/.test(ccLine), "claude 这边没给兜底的命令行入口");
  assert(!ccLine.includes(shimPath), "提示词里给的是绝对路径，模型照着敲会被权限层拦下");
  // 这两条红线不许丢：模型宁可如实说失败，也不许反过来叫用户自己把图放进去
  for (const line of [cxLine, ccLine]) {
    assert(/别在交付里写/.test(line), "「别反过来让用户自己生图」这条红线丢了");
    assert(/失败原因如实写进交付/.test(line), "「失败要如实说」这条红线丢了");
  }
  // 负向：没借工具时不许凭空吹一段
  assert.strictEqual(bridgedLine(null), "", "没借工具却还在提示词里说有");

  // ⑪ 放行规则要真的下到命令行上。拿一个假 CLI 当靶子，把它收到的 argv 原样吐回来：
  //    这条断言是有代价换来的 —— 真跑一次本机 claude，模型照着提示词敲了三次 owb，
  //    三次都被「This command requires approval」拦掉，最后在交付里写「没能用上 OWB 的工具」。
  const fake = path.join(home, "fakeclaude");
  const argvOut = path.join(home, "argv.json");
  fs.writeFileSync(fake, [
    "#!/usr/bin/env node",
    'require("fs").writeFileSync(' + JSON.stringify(argvOut) + ', JSON.stringify(process.argv.slice(2)));',
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: {} }));',
    'process.stdout.write(String.fromCharCode(10));',
  ].join("\n"));
  fs.chmodSync(fake, 0o755);
  const cc2 = bridge.attach("claude-code", { home, baseDir: BASE, user: "e2e" });
  try {
    await require("../engines/claude-code").run({ prompt: "hi", cwd: home, bin: fake, ...cc2.runOpts });
    const argv = JSON.parse(fs.readFileSync(argvOut, "utf8"));
    const pairs = argv.map((a, i) => (a === "--allowed-tools" ? argv[i + 1] : null)).filter(Boolean);
    assert(pairs.includes("Bash(owb:*)"), "没给命令行入口下放行规则，模型敲了也是「需要审批」：" + JSON.stringify(pairs));
    assert(pairs.includes("mcp__" + bridge.SERVER_NAME), "MCP 那条路的放行规则也丢了：" + JSON.stringify(pairs));
    // 负向：别顺手把整个 Bash 放开 —— 只该放行 owb 这一个前缀
    assert(!pairs.includes("Bash"), "把整个 Bash 都放开了，那是另一回事，不该在这儿顺手做");
  } finally { cc2.cleanup(); }

  fs.rmSync(home, { recursive: true, force: true });
  console.log("✅ 本机引擎借工具：命令行入口真出文件（会话子目录）· 裸命令挂 PATH 且下了放行规则（带路径会被判需审批）· 白名单拒非借出工具 · MCP 配置形状对 · 两边提示词各说各的路");
}

function testUiNoRawMarkdown() {
  // 界面上印出一串 ** 星号，是「文案里写了 markdown，但那一格根本不过 markdown 渲染器」。
  // 光修一处没用——下次谁再手写一句 **重点** 还会复现。这道闸把它钉死在测试里。
  const dir = path.join(__dirname, "..", "public", "js");
  // 去掉块注释和整行 // 注释：注释里写 **强调** 是给人看的，不会进 DOM
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
  const bad = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    strip(fs.readFileSync(path.join(dir, f), "utf8")).split("\n").forEach((l, i) => {
      if (/\*\*[^*\n]+\*\*/.test(l)) bad.push(`public/js/${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
    });
  }
  assert(!bad.length, "界面文案里还留着字面 markdown 粗体（会原样印出星号），改成 <b> 或走 escInline：\n  " + bad.join("\n  "));

  // escInline 自己也得对：先转义再翻标记，且只认这两样
  const src = fs.readFileSync(path.join(dir, "app-01.js"), "utf8");
  const m = src.match(/function escInline\(s\) \{[\s\S]*?\n\}/);
  assert(m, "app-01.js 里没有 escInline —— 模型写的那些字段就又要印星号了");
  const escInline = new Function("esc", "return " + m[0].replace("function escInline", "function") + ";")(
    (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  );
  assert(escInline("提**最小**改动") === "提<strong>最小</strong>改动", "粗体没翻出来");
  assert(escInline("跑 `npm test`") === "跑 <code>npm test</code>", "行内代码没翻出来");
  // 负向：转义必须发生在翻标记之前，否则模型输出能当 HTML 执行
  assert(escInline("<img onerror=x>").indexOf("<img") < 0, "escInline 没先转义，模型输出会被当 HTML 跑");
  assert(escInline("**<b>x</b>**") === "<strong>&lt;b&gt;x&lt;/b&gt;</strong>", "粗体里的标签没被转义");
  // 负向：单个星号、乘法号不该被吃掉
  assert(escInline("2 * 3 * 4") === "2 * 3 * 4", "把普通星号也当标记翻了");
  assert(escInline("**") === "**", "空标记被误翻");
  console.log("✅ 界面文案：没有字面 markdown 粗体；escInline 先转义后翻标记");
}


main()
  .catch((e) => {
    console.error("❌ 测试失败:", e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    // 兜在这儿：断言挂了也得把临时工作区收走，别在 /tmp 里堆一地
    try { fs.rmSync(WORKSPACE, { recursive: true, force: true }); } catch {}
    if (process.exitCode) process.exit(process.exitCode);
  });
