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
const { createAgentRuntime, missingDeliverables, unseenVisualClaims, trimHistory, historyChars, collectSources } = require("../agent");
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
        const v = seg.trim();
        if (!v) continue;
        // transition: none 是刻意关掉过渡（拖着改栏宽时就不该有动画），根本不产生动画，
        // 不存在「吃默认 ease」一说，放行。
        if (v === "none") continue;
        if (!/var\(\s*--wb-ease/.test(seg)) bare.push(path.basename(f) + ": " + v);
      }
    }
  }
  assert(bare.length === 0,
    "这些过渡没写曲线，会吃浏览器默认的 ease：\n  " + bare.join("\n  "));

  const html = fs.readFileSync(files[0], "utf8");
  // 界面字体栈现在住在 --font-sans 令牌里（body 只写 font-family: var(--font-sans)，外观页的「衬线/等宽」靠改令牌切换），
  // 所以 font-family: 和 --font-sans: 两种声明都扫；衬线/等宽那两条不含 PingFang/-apple-system，自然被滤掉
  const fams = [...html.matchAll(/(?:font-family|--font-sans):\s*([^;]+);/g)].map((m) => m[1].trim());
  const uiFams = fams.filter((v) => /PingFang|apple-system/.test(v));
  assert(uiFams.length > 0, "index.html 里一个界面字体栈都没找到，闸门失效了");
  assert(/body \{[^}]*font-family: var\(--font-sans\)/.test(html), "body 没接到 --font-sans 令牌上，外观页切字体不会生效");
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
 * 表面层级闸门。
 *
 * 守的是这次 UI 精修的那一层：外壳 / 画布 / 卡片三档底色 + 三档投影。
 * 这类东西最容易「定义了没人用」——令牌加了一堆，body 还是纯白，页面一点没变，
 * 而肉眼很难发现（三档之间本来就只差 4–10/255）。所以两头都钉：
 * 令牌必须在浅暗两套主题里都定义且两两不相等（不然三层是假的），
 * 并且必须真接到 body / aside / .main 上（不然是死变量）。
 * 顺带钉住滚动条：原来两套规则打架，赢的那套滑块是 --border 压白底，等于没画。
 */
function testSurfaceLayerGate() {
  const pub = path.join(__dirname, "..", "public");
  const css = fs.readFileSync(path.join(pub, "css", "ui.css"), "utf8");
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");

  // 取某个选择器块里某个令牌的值。ui.css 的 :root 和 html[data-theme="dark"] 各一块。
  const block = (sel) => {
    const i = css.indexOf(sel + " {");
    assert(i >= 0, "ui.css 里找不到 " + sel + " 这一块");
    return css.slice(i, css.indexOf("\n}", i));
  };
  const LADDER = ["--app-shell", "--page-canvas", "--surface"];
  const TIERS = ["--shadow-surface", "--shadow-menu", "--shadow-floating"];
  for (const sel of [":root", 'html[data-theme="dark"]']) {
    const b = block(sel);
    const vals = LADDER.map((n) => {
      const m = b.match(new RegExp("\\" + n + ":\\s*([^;]+);"));
      assert(m, sel + " 里没定义 " + n + "，三级表面在这套主题下是缺的");
      return m[1].trim();
    });
    assert(new Set(vals).size === 3,
      sel + " 的三级表面有重复值（" + vals.join(" / ") + "）——三层等于一层，卡片仍然只能靠边框立住");
    for (const t of TIERS) {
      assert(new RegExp("\\" + t + ":").test(b), sel + " 里没定义 " + t + "，这套主题的投影会落空");
    }
    assert(/--scrollbar-thumb:/.test(b), sel + " 里没定义 --scrollbar-thumb");
  }

  // 真接上了没：外壳 / 画布各自落在哪个元素上
  const wired = [
    [/body \{[^}]*background: var\(--wb-shell\)/, "body 没用外壳底色，三级表面的最外层是空的"],
    [/aside \{[^}]*background: var\(--wb-shell\)/, "左栏没用外壳底色"],
    [/\.main \{[^}]*background: var\(--wb-canvas\)/, ".main 没用画布底色——主区还是纯白，白卡片浮不起来"],
    [/--wb-shell: var\(--app-shell\)/, "--wb-shell 没接到 ui.css 的真源上"],
    [/--wb-canvas: var\(--page-canvas\)/, "--wb-canvas 没接到 ui.css 的真源上"],
  ];
  for (const [re, msg] of wired) assert(re.test(html), msg);

  // 字形抗锯齿：admin.html 一直开着，主界面漏了，两边看着不像一个产品
  assert(/-webkit-font-smoothing: antialiased/.test(html), "index.html 的 body 没开 antialiased，整页比设计稿粗一档");

  // 滚动条：只允许一套规则，且滑块不能是 --wb-border（压白底看不见）
  const thumbs = [...html.matchAll(/::-webkit-scrollbar-thumb\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const thumbBg = thumbs.filter((r) => /background:/.test(r) && !/:hover/.test(r));
  assert(thumbs.length <= 4, "滚动条滑块规则有 " + thumbs.length + " 条，八成是两套规则在打架");
  assert(thumbBg.every((r) => !/var\(--wb-border\)/.test(r)),
    "滚动条滑块还是 --wb-border，压在白底上等于没画：" + thumbBg.join(" | "));
  assert(thumbBg.some((r) => /var\(--scrollbar-thumb\)/.test(r)), "滚动条滑块没走 --scrollbar-thumb 令牌");

  // 手写投影不能再冒出来：菜单/弹层那几个类必须走三档令牌
  const mustUseTier = [".picker-menu", ".mention-menu", ".user-menu", ".modal", ".auth-card", "#chat-search"];
  const adhoc = [];
  for (const cls of mustUseTier) {
    const re = new RegExp("[^{}\\n]*\\" + cls + "(?![-\\w])[^{}\\n]*\\{([^}]*)\\}", "g");
    for (const m of html.matchAll(re)) {
      const body = m[1];
      if (!/box-shadow:/.test(body)) continue;
      if (/box-shadow:[^;]*rgba?\(/.test(body) && !/box-shadow:[^;]*var\(--shadow-/.test(body)) adhoc.push(cls);
    }
  }
  assert(adhoc.length === 0, "这些浮层又开始自己手写投影了，会和别处深浅不一：" + [...new Set(adhoc)].join("、"));

  // 反向断言：闸门本身得能抓到东西
  assert(new Set(["#fff", "#fff", "#eee"]).size !== 3, "三值互异的判别失效");
  assert(!/body \{[^}]*background: var\(--wb-根本没有\)/.test(html), "接线判别失效");
  assert(/box-shadow:[^;]*rgba?\(/.test("box-shadow: 0 1px 2px rgba(0,0,0,.1);"), "手写投影的判别失效");
  console.log("✅ 表面层级闸门：外壳/画布/卡片三档在浅暗两套主题下都互异且真接到了 body/aside/.main · 三档投影齐全 · 滚动条只剩一套且看得见");
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
  const mdUnder = (dir) => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? mdUnder(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : []);
  const files = ["README.md", "README.en.md", "CONTRIBUTING.md", "COMMERCIAL-LICENSE.md"]
    .map((f) => path.join(root, f))
    .filter((f) => fs.existsSync(f))
    .concat(mdUnder(docs));

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
  const anchorsOf = (file) => new Set([...fs.readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slugify(m[1])));
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    const anchors = anchorsOf(f);
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
      const target = path.resolve(path.dirname(f), rel);
      if (!fs.existsSync(target)) { dead.push(path.basename(f) + " → " + href); continue; }
      // 跨文件锚点（CONTRIBUTING.md#xxx）：文件在但标题改了，点过去落在页顶，跟死链一样
      const frag = href.split("#")[1];
      if (frag && rel.endsWith(".md") && !anchorsOf(target).has(decodeURIComponent(frag).toLowerCase())) dead.push(path.basename(f) + " → " + href + "（目标文件里没有这个标题）");
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

    // 「说自己核对过图上的字」但这一趟一次都没真看成过图 —— 用户真踩过：
    // 视觉渠道 11 次全返回空正文，模型换了几轮问法后放弃，转头在说明文档里写「已核对，笔画正确」
    const 假核对 = "三版海报已生成。已逐字核对 poster_B.png，笔画正确、无错别字。";
    assert.ok(unseenVisualClaims(假核对, false), "编造的看图核对没被拦下");
    assert.strictEqual(unseenVisualClaims(假核对, true), null, "真看成过图还去替它复核（会误伤）");
    // 如实交代没看成的，不许被当成撒谎
    assert.strictEqual(unseenVisualClaims("海报已生成 poster_B.png。没能核对图上的文字（视觉渠道没余额），请你自己过一眼。", false), null, "如实说没看成反倒被打回");
    // 没提到图片、或者只是普通汇报的，一律不碰
    assert.strictEqual(unseenVisualClaims("已核对报告里的数字，全部对得上。", false), null, "把纯文本核对也当成看图了");
    assert.strictEqual(unseenVisualClaims("三版海报已生成：poster_B.png、poster_C.png。", false), null, "没声称核对也被拦");
    // 动词和对象要在同一句里才算，隔了半篇文章的两个词不算
    assert.strictEqual(unseenVisualClaims("已确认文件都写到 poster_B.png 了。\n另外附了一段关于错别字的说明。", false), null, "跨句拼出来的假阳性");
    // 真实翻车那句的句式：动词在分号前、对象在分号后。按分号断句就会整条漏掉
    const 分号句 = "三版海报：poster_A.png、poster_B2.png。**已核对**：无错别字、无「AI 生成」水印；A、B2 两版文字笔画正确、排版整齐。";
    assert.ok(unseenVisualClaims(分号句, false), "分号把动词和对象隔开就漏了（真实翻车文案就是这个句式）");
    assert.strictEqual(unseenVisualClaims(分号句, true), null, "真看成过图仍被打回");
  } finally {
    fs.rmSync(real, { force: true });
    fs.rmSync(empty, { force: true });
  }
  console.log("✅ 成果核验闸门：缺文件 / 0 字节空壳 / 无声称不误伤 · 说自己核对过图上的字但一次没看成图要打回（真看成过/如实说没看成/纯文本核对 三种负向对照都不误伤）");
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
  // 参数根本不是合法 JSON：本机 96 段会话里出现过 4 次，四种坏法各不相同，
  // 但模型收到的反馈全是某个工具的必填校验（「缺少 prompt」之类）——它以为自己漏填了字段，
  // 于是把同样坏的东西原样再发一遍。必须如实说「你发的参数坏了」，还要说清是不是被截断的。
  const { badToolArgs } = require("../tools")._internals;
  let bt = badToolArgs("write_file", '{"path": "a.html", "content": "<html>没写完就断了', "Unterminated string in JSON at position 19486");
  assert.ok(/参数不是合法 JSON/.test(bt), bt);
  assert.ok(/Unterminated string/.test(bt), "解析器原话丢了，模型没法自查：" + bt);
  assert.ok(/截断/.test(bt) && /append/.test(bt), "没认出是被输出长度截断的，也没给下一步：" + bt);
  bt = badToolArgs("generate_image", '{"prompt": "水墨", "size": 1024x1536}', "Expected ',' or '}' after property value");
  assert.ok(!/截断/.test(bt) && /完整的 JSON 对象/.test(bt), "结尾有 } 的写错了却被当成截断：" + bt);
  assert.ok(!/缺少/.test(bt), "又绕回按缺字段报错了：" + bt);
  bt = badToolArgs("write_file", '{"content": "' + "x".repeat(5000), "Unterminated string");
  assert.ok(bt.length < 900 && /共 5013 字/.test(bt), "把坏参数整坨贴回去，报错本身就吃掉一大块上下文：" + bt.length);
  // 坏参数会原封不动躺进 history，而 history 每一轮都整份重发：真实会话里有一次 write_file 被
  // 输出长度截断，19482 字的残缺 JSON 在之后 12 轮里每轮重发一遍，白烧掉 23 万字上下文。只留个头。
  const { keepBadArgs } = require("../llm")._internals;
  const kept = keepBadArgs('{"content": "' + "y".repeat(19000), new Error("Unterminated string"));
  assert.strictEqual(kept._raw.length, 400, "坏参数没截，会在 history 里一轮轮重发：" + kept._raw.length);
  assert.strictEqual(kept._rawLen, 19013, "截了却没记住原来多长，报错里就说不出「共 N 字」");
  assert.ok(/Unterminated/.test(kept._parseError), "解析器原话没留下");
  const short = keepBadArgs('{"size": 1024x1536}', new Error("bad"));
  assert.strictEqual(short._raw, '{"size": 1024x1536}', "短的也给截了，模型就看不全自己写错在哪");
  assert.ok(/共 19013 字/.test(badToolArgs("write_file", kept._raw, kept._parseError, kept._rawLen)), "截过之后报错里说的字数不对");
  console.log("✅ 上游重试与工具名纠错：5xx/429/断连重试 · 4xx 与超时不重试 · 拼错的工具名给出真名 · 参数不是合法 JSON 时如实说坏在哪（截断/写错分开说，不再报成「缺少某字段」）· 坏参数只留 400 字进 history（真实会话里一坨 19482 字的残缺 JSON 重发了 12 轮）");
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

    // 设置页里其它渠道的 base_url 全都以 /v1 结尾，用户照着填 Claude 很自然。
    // 自己拼 `${base}/v1/messages` 的话这里会变成 /v1/v1/messages，上游 404，人还以为是 Key 不对
    for (const [given, want] of [
      ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages"],
      ["https://relay.example/anthropic/v1/", "https://relay.example/anthropic/v1/messages"],
      ["https://relay.example/anthropic", "https://relay.example/anthropic/v1/messages"],
    ]) {
      seen = null;
      await lookAtImage({ media: { vision: { base_url: given, api_key: "k", model: "claude", provider: "anthropic" } } },
        { path: "截图.png", question: "什么颜色？" }, 30000, resolveFile);
      assert.strictEqual(seen.url, want, `视觉渠道 base_url=${given} 拼出了 ${seen.url}`);
    }

    // 主模型是纯文本模型：上游 400 说得很清楚，这时候要让用户去配视觉渠道，而不是让模型自己反复重试
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "This model does not support image" } }) });
    const fb = { visionFallback: { base_url: "https://main/v1", api_key: "k", model: "deepseek-chat" } };
    r = await lookAtImage(fb, { path: "截图.png", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /视觉模型/.test(r.content) && /不要重试/.test(r.content), "主模型看不了图时没把话说清楚：" + r.content);
    // 但用户已经配了视觉渠道，同一个 400 就是这个渠道自己的毛病，别再劝他去配一遍
    r = await lookAtImage({ media }, { path: "截图.png", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /视觉模型错误 400/.test(r.content), "已配渠道报错时说岔了：" + r.content);

    // 思考把 2000 的额度吃光、正文一个字没有：这不是内容策略，别让模型换问法空转。
    // 自己关一次思考重来，拿到正文就算数（真实会话里这一种空返回出现了 40 次）
    {
      const glm = { media: { vision: { base_url: "https://openrouter.ai/api/v1", api_key: "k", model: "z-ai/glm-5.3-flash" } } };
      const calls = [];
      global.fetch = async (url, init) => {
        const b = JSON.parse(init.body);
        calls.push(b);
        if (calls.length === 1) {
          return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "让我仔细看看这张图……" } }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "标题写的是「山路水果」" } }] }) };
      };
      r = await lookAtImage(glm, { path: "截图.png", question: "标题几个字？" }, 30000, resolveFile);
      assert.strictEqual(r.isError, false, "关思考重看那一次没救回来：" + r.content);
      assert.ok(/山路水果/.test(r.content) && /关思考重看/.test(r.content), "救回来了但没交代发生过什么：" + r.content);
      assert.strictEqual(calls.length, 2, "该正好重来一次，实际 " + calls.length + " 次");
      assert.deepStrictEqual(calls[1].reasoning, { enabled: false }, "重试没把 OpenRouter 的思考关掉：" + JSON.stringify(calls[1].reasoning));
      assert.ok(calls[1].max_tokens > calls[0].max_tokens, "重试没把额度放大");
      // 负向对照：正常回话的那次绝不能触发第二发
      calls.length = 0;
      global.fetch = async () => { calls.push(1); return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "红色" } }] }) }; };
      r = await lookAtImage(glm, { path: "截图.png", question: "?" }, 30000, resolveFile);
      assert.ok(!r.isError && calls.length === 1, "正常一次就够的也去重试了：" + calls.length);
    }
    // 关了思考还是空：到此为止，明说别再换问法，更不许把没看到的当看过写进结论
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "嗯……" } }] }) });
    r = await lookAtImage({ media }, { path: "截图.png", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /别再换问法/.test(r.content) && /不许把没看到的内容当作看过/.test(r.content), "空返回的收尾话没说死：" + r.content);
    // 渠道没钱了：也别重试，直接说清是余额
    global.fetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: "Insufficient credits" } }) });
    r = await lookAtImage({ media }, { path: "截图.png", question: "?" }, 30000, resolveFile);
    assert.ok(r.isError && /没余额/.test(r.content) && /重试多少次都一样/.test(r.content), "402 没说清是余额：" + r.content);
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
  console.log("✅ 看图：带问题才给看 · 图只随请求发不进历史 · OpenAI/Anthropic 两种协议 · 主模型看不了图时指路去配 · 思考吃光额度自动关思考重看一次（正常回话不重试）· 真空了就叫停并禁止编造看过");
}

// ---------- Claude 渠道：验活打哪儿，真跑就得打哪儿 ----------
// 这条只能真起一个服务器来验，不能看源码正则。因为「验活」走的是裸 fetch、「真跑」走的是
// 官方 SDK（地址由它自己补一段），两边长得完全不一样，光看代码看不出它们最终是不是同一个 URL。
// 出事的形态很难查：填了中转地址的人，设置页验活是绿的（打的是中转），一发消息 401（打的是官方），
// 于是他去换 Key、换模型名、怀疑中转挂了——唯独不会怀疑这两步压根没走同一条路。
async function testAnthropicEndpointAgreement() {
  const http = require("http");
  const { createLLM, anthropicBase } = require("../llm");

  // 纯函数那一层：填法五花八门，归一之后只有一个根
  for (const [given, want] of [
    ["", "https://api.anthropic.com"],
    ["https://api.anthropic.com", "https://api.anthropic.com"],
    ["https://api.anthropic.com/", "https://api.anthropic.com"],
    ["https://api.anthropic.com/v1", "https://api.anthropic.com"],
    ["https://relay.example/claude/v1/", "https://relay.example/claude"],
  ]) {
    assert.strictEqual(anthropicBase(given).baseURL, want, `base_url=${JSON.stringify(given)} 归一错了：` + anthropicBase(given).baseURL);
    assert.strictEqual(anthropicBase(given).messagesUrl, want + "/v1/messages", "messagesUrl 拼错：" + anthropicBase(given).messagesUrl);
  }

  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.method + " " + req.url);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "e2e 只看地址，不给真答案" } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const port = srv.address().port;
    // 尾巴上带 /v1/ 是最容易被填出来的写法——设置页里其它渠道全长这样
    const base = `http://127.0.0.1:${port}/relay/v1/`;

    // 真跑：createLLM → anthropicChat → 官方 SDK
    const llm = createLLM({ models: [{ name: "t", provider: "anthropic", model: "claude-x", api_key: "sk-e2e", base_url: base, default: true }] });
    try { await llm.chat({ system: "s", history: [{ role: "user", content: "hi" }], tools: [] }); } catch {}
    assert.deepStrictEqual(hits, ["POST /relay/v1/messages"],
      "真跑没打到用户填的中转地址（这就是 base_url 没传给 SDK 的症状）：" + JSON.stringify(hits));

    // 验活：server.js 的 probeModel 用的就是这个地址
    const probeUrl = anthropicBase(base).messagesUrl;
    await fetch(probeUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": "k", "anthropic-version": "2023-06-01" }, body: "{}" }).catch(() => {});
    assert.strictEqual(hits.length, 2, "验活没打出去：" + JSON.stringify(hits));
    assert.strictEqual(hits[0], hits[1], "验活和真跑打的不是同一个地址：" + JSON.stringify(hits));

    // 源码侧再钉一道：server.js 不许自己再长一套算法出来
    const srvSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    assert.ok(/anthropicBase\(m\.base_url\)\.messagesUrl/.test(srvSrc), "probeModel 又自己拼地址了");
    assert.ok(!/https:\/\/api\.anthropic\.com\/v1["'`]/.test(srvSrc), "server.js 里又写死了一个 Anthropic 端点");
  } finally {
    await new Promise((r) => srv.close(r));
  }

  // SDK 是正式依赖，不是「用到再说」的可选项：装机包的用户没法自己 npm install
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.ok(pkg.dependencies && pkg.dependencies["@anthropic-ai/sdk"], "@anthropic-ai/sdk 不在 dependencies 里，选了 Claude 的人一发消息就 MODULE_NOT_FOUND");
  assert.ok(!(pkg.optionalDependencies || {})["@anthropic-ai/sdk"], "@anthropic-ai/sdk 挂在 optionalDependencies 上照样可能装不上");

  console.log("✅ Claude 渠道：base_url 归一（带不带 /v1 都行）· 验活与真跑打同一个地址 · SDK 是正式依赖");
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

// 企业管理后台是 16 个面板 + 哈希路由，最常见的坏法是「某一页 render 里读了个 undefined，整块白屏」——
// 只有真的把每一页点一遍、盯着 console 才看得见。同样开 electron 子进程跑。
/**
 * Docker 一键部署：静态那部分。
 * 只跑不需要 Docker 的断言（.dockerignore 挡没挡住凭证、compose 空环境能不能插值、
 * seedDataDir 会不会漏技能）。真 build 一个镜像跑起来是 `node test/deploy.js --build`，
 * 那个要几分钟，不塞进 e2e。
 */
async function testDockerDeploy() {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(__dirname, "deploy.js")], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) throw new Error("Docker 部署测试未通过：\n" + out.trim().split("\n").slice(-14).join("\n"));
  const line = out.split("\n").find((l) => l.startsWith("✅ Docker 部署"));
  if (!line) throw new Error("Docker 部署测试没有报告结果：\n" + out.trim().split("\n").slice(-14).join("\n"));
  console.log(line);
}

/**
 * 跑一个独立的 node 子测试文件，把它的结论并进 e2e 的成绩单。
 *
 * 这几个文件（多租户、个人偏好）都得在**进程一开始**就把 WB_DATA_DIR 指到临时目录，
 * 才能保证一个字节都不碰真账号、真偏好；e2e 这个进程早就把那几个模块 require 过了，
 * 所以只能另起进程。以前 test/tenant.js 就因为没人调，写完就没再跑过——
 * 一个没人跑的测试比没有测试更糟，它让人以为那块是有人看着的。
 */
async function testNodeSuite(file, label) {
  const { spawnSync } = require("child_process");
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const tail = () => out.trim().split("\n").slice(-14).join("\n");
  if (r.status !== 0) throw new Error(`${label}未通过：\n${tail()}`);
  const line = out.split("\n").find((l) => l.startsWith("全部通过："));
  if (!line) throw new Error(`${label}没有报告结果：\n${tail()}`);
  console.log(`✅ ${label}：${line.replace("全部通过：", "").trim()}`);
}

async function testAdminConsoleUI() {
  const { spawnSync } = require("child_process");
  let electronBin;
  try { electronBin = require("electron"); } catch { }
  if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
    console.log("⏭️  企业管理后台：未安装 electron，跳过");
    return;
  }
  const r = spawnSync(electronBin, [path.join(__dirname, "admin-ui.js")], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) throw new Error("企业管理后台测试未通过：\n" + out.trim().split("\n").slice(-12).join("\n"));
  const line = out.split("\n").find((l) => l.startsWith("✅ 企业管理后台"));
  if (!line) throw new Error("企业后台测试没有报告结果：\n" + out.trim().split("\n").slice(-12).join("\n"));
  console.log(line);
}

/** #61 桌面版叫 OpenWorkBuddy 不叫 Electron：启动器是克隆改名的真 .app，开发态 Dock 换图标，userData 钉死不改名 */
function testDesktopAppIdentity() {
  const os = require("os");
  const { execFileSync } = require("child_process");
  // ---- 开发态（npm run app）：electron-main.js 的三件事 ----
  const main = fs.readFileSync(path.join(__dirname, "..", "electron-main.js"), "utf8");
  const iSetPath = main.indexOf('app.setPath("userData"');
  const iSetName = main.indexOf('app.setName("OpenWorkBuddy")');
  assert.ok(iSetPath > 0 && iSetName > 0, "electron-main.js 少了 setPath(userData) / setName");
  assert.ok(iSetPath < iSetName, "userData 必须在 setName 之前钉死：setName 会把 userData 改成 appData/OpenWorkBuddy，用户又被登出一次");
  assert.ok(/setPath\("userData",\s*path\.join\(app\.getPath\("appData"\),\s*"openworkbuddy"\)\)/.test(main), "userData 目录名必须还是 openworkbuddy（登录态/localStorage 都在里面）");
  assert.ok(/app\.dock\.setIcon\(path\.join\(__dirname, "build", "icon\.png"\)\)/.test(main), "开发态 Dock 图标没换成 build/icon.png");
  assert.ok(/setAboutPanelOptions\(\{ applicationName: "OpenWorkBuddy"/.test(main), "「关于」面板没署名 OpenWorkBuddy");
  assert.ok(fs.existsSync(path.join(__dirname, "..", "build", "icon.png")) && fs.existsSync(path.join(__dirname, "..", "build", "icon.icns")), "build/icon.png|icns 缺失");

  if (process.platform !== "darwin") return;
  // ---- 装机态：make-mac-app.sh 对着一个假的 Electron.app 骨架跑一遍，验产物而不是验脚本文本 ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-macapp-"));
  try {
    const src = path.join(tmp, "Electron.app");
    fs.mkdirSync(path.join(src, "Contents", "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(src, "Contents", "Resources", "en.lproj"), { recursive: true });
    fs.writeFileSync(path.join(src, "Contents", "MacOS", "Electron"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
    fs.writeFileSync(path.join(src, "Contents", "Resources", "electron.icns"), "icns");
    fs.writeFileSync(path.join(src, "Contents", "Resources", "default_app.asar"), "asar");
    const plist = (kv) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(kv).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict></plist>\n`;
    fs.writeFileSync(path.join(src, "Contents", "Info.plist"), plist({ CFBundleName: "Electron", CFBundleDisplayName: "Electron", CFBundleExecutable: "Electron", CFBundleIdentifier: "com.github.Electron", CFBundleIconFile: "electron.icns", CFBundleShortVersionString: "43.2.0", CFBundleVersion: "43.2.0", CFBundlePackageType: "APPL" }));
    const out = path.join(tmp, "Applications", "OpenWorkBuddy.app");
    const env = { ...process.env, OWB_ELECTRON_APP: src, OWB_APP_OUT: out, OWB_SKIP_CODESIGN: "1" };
    const log = execFileSync("bash", [path.join(__dirname, "..", "scripts", "make-mac-app.sh")], { env, encoding: "utf8" });
    assert.ok(/✅ 已生成/.test(log), "脚本没报成功：\n" + log);
    assert.ok(!/✗/.test(log), "脚本自检有叉：\n" + log);
    const pb = (k) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${k}`, path.join(out, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
    assert.strictEqual(pb("CFBundleName"), "OpenWorkBuddy", "菜单栏名字还是 Electron");
    assert.strictEqual(pb("CFBundleDisplayName"), "OpenWorkBuddy");
    assert.strictEqual(pb("CFBundleExecutable"), "OpenWorkBuddy");
    assert.strictEqual(pb("CFBundleIconFile"), "icon.icns");
    assert.strictEqual(pb("CFBundleIdentifier"), "com.openworkbuddy.app", "bundle id 还是 com.github.Electron 的话通知/权限都记在 Electron 名下");
    assert.strictEqual(pb("CFBundleShortVersionString"), require("../package.json").version, "版本号没跟 package.json");
    assert.ok(fs.existsSync(path.join(out, "Contents", "MacOS", "OpenWorkBuddy")), "可执行文件没改名");
    assert.ok(!fs.existsSync(path.join(out, "Contents", "MacOS", "Electron")), "旧的 Electron 二进制还在");
    assert.ok(!fs.existsSync(path.join(out, "Contents", "Resources", "electron.icns")), "Electron 图标没删");
    // 两个 Buffer 不能用 strictEqual（=== 比的是对象引用，永远不等，报错还要吐几万行字节）
    const sha = (f) => require("crypto").createHash("sha1").update(fs.readFileSync(f)).digest("hex");
    assert.strictEqual(sha(path.join(out, "Contents", "Resources", "icon.icns")), sha(path.join(__dirname, "..", "build", "icon.icns")), "图标不是 build/icon.icns");
    const entry = fs.readFileSync(path.join(out, "Contents", "Resources", "app", "main.js"), "utf8");
    const repo = path.resolve(__dirname, "..");
    assert.ok(entry.includes(JSON.stringify(repo)), "入口没把仓库路径烤进去");
    assert.ok(/require\(path\.join\(REPO, "electron-main\.js"\)\)/.test(entry), "入口没加载仓库的 electron-main.js");
    assert.ok(/showErrorBox/.test(entry), "仓库挪走后没有报错兜底，用户只会看到什么都不发生");
    const pkg = JSON.parse(fs.readFileSync(path.join(out, "Contents", "Resources", "app", "package.json"), "utf8"));
    assert.strictEqual(pkg.name, "openworkbuddy", "app/package.json 的 name 决定 userData 目录，改了就登出");
    assert.strictEqual(pkg.main, "main.js");
    execFileSync("node", ["--check", path.join(out, "Contents", "Resources", "app", "main.js")]);
    // 反例：源包没动
    assert.ok(fs.existsSync(path.join(src, "Contents", "MacOS", "Electron")) && fs.existsSync(path.join(src, "Contents", "Resources", "electron.icns")), "脚本改了 node_modules 里的源包");
    // 反例：图标缺失时必须拒绝生成，别生成一个又叫 Electron 图标的包
    const noIcon = path.join(tmp, "src2.app");
    fs.cpSync(src, noIcon, { recursive: true });
    let failed = false;
    try { execFileSync("bash", [path.join(__dirname, "..", "scripts", "make-mac-app.sh")], { env: { ...env, OWB_ELECTRON_APP: path.join(tmp, "nope.app") }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch { failed = true; }
    assert.ok(failed, "源 Electron.app 不存在还生成成功了");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("  ✓ 桌面版身份：开发态 Dock 图标/关于面板/userData 钉死 + 装机态 .app 克隆改名 12 项验过");
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

  // 库型条目（上游没有 skill.md）：自带说明必须是合法技能文档，且不往前端整篇塞
  const pre = list.find((s) => s.name === "pretext");
  assert(pre && pre.bundled_doc === true, "pretext 没进推荐清单 / 没标自带说明");
  assert(!("skill_md" in pre), "listDefaultSkills 把整篇 skill_md 送到前端了");
  const raw = skillsMgr.DEFAULT_SKILLS.find((s) => s.name === "pretext");
  const fm = skillsMgr.parseFrontmatter(raw.skill_md);
  assert.strictEqual(fm.name, "pretext", "自带说明的 frontmatter name 和条目名对不上，装完会变成另一个名字");
  assert(fm.description.length > 20 && /@chenglou\/pretext/.test(fm.content), "自带说明缺描述或没写到包名");
  assert(/cdn\.jsdelivr\.net\/npm\/@chenglou\/pretext/.test(fm.content), "说明里没给免构建的引入方式，生成的 HTML 用不上");
  const opts = skillsMgr.defaultInstallOpts(raw);
  assert(opts.skillMd === raw.skill_md && opts.files.includes("README.md") && opts.files.includes("LICENSE"), "库型条目的安装选项没接上");
  assert.deepStrictEqual(skillsMgr.defaultInstallOpts(list[0].name === "pretext" ? list[1] : list[0]).files, null, "普通技能条目不该带文件白名单");

  // adaptLibraryAsSkill：注入 skill.md + 只留白名单；上游自己有 skill.md 时不覆盖（负向控制）
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-lib-"));
  for (const f of ["README.md", "LICENSE", "package.json"]) fs.writeFileSync(path.join(root, f), f);
  fs.mkdirSync(path.join(root, "tests")); fs.writeFileSync(path.join(root, "tests", "big.txt"), "x".repeat(1000));
  assert.strictEqual(skillsMgr.adaptLibraryAsSkill(root, {}), false, "没给 skillMd 也动了目录");
  assert(fs.existsSync(path.join(root, "package.json")), "没给 skillMd 却把文件删了");
  assert.strictEqual(skillsMgr.adaptLibraryAsSkill(root, opts), true, "库型目录没被改造成技能");
  const left = fs.readdirSync(root).sort();
  assert.deepStrictEqual(left, ["LICENSE", "README.md", "skill.md"], "白名单之外的文件没清干净 / 白名单文件被误删：" + left.join(","));
  assert.strictEqual(fs.readFileSync(path.join(root, "skill.md"), "utf8").trim(), raw.skill_md.trim(), "写进去的 skill.md 和清单里的不一致");
  // 负向控制：上游已经有自己的 SKILL.md → 一个字都不能碰
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-lib-"));
  fs.writeFileSync(path.join(root2, "SKILL.md"), "---\nname: upstream\n---\n上游自己的");
  fs.writeFileSync(path.join(root2, "extra.js"), "keep");
  assert.strictEqual(skillsMgr.adaptLibraryAsSkill(root2, opts), false, "上游有 SKILL.md 还去覆盖");
  assert.deepStrictEqual(fs.readdirSync(root2).sort(), ["SKILL.md", "extra.js"], "上游有 SKILL.md 时不该删文件");
  assert.strictEqual(fs.readFileSync(path.join(root2, "SKILL.md"), "utf8"), "---\nname: upstream\n---\n上游自己的", "上游的 SKILL.md 被改写了");
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(root2, { recursive: true, force: true });
  console.log(`✅ 默认技能清单：${list.length} 条，协议/上游/体积字段齐全 · 库型条目(pretext)自带说明合法、只留白名单、不覆盖上游`);
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

    // 每一轮的时间戳由调用方给：规则生效前写一遍、生效后再写一遍（打分只认生效之后的回合）
    const writeSessions = (at) => {
    fs.writeFileSync(path.join(SESS, "s1.json"), JSON.stringify({ updated_at: at, transcript: [
      ...turn([err("edit_file", "没找到 old_text"), err("run_shell", "未知工具：directory_tree")], at),
      ...turn([err("edit_file", "没找到 old_text"), err("run_shell", "未知工具：directory_tree")], at),
      ...turn([err("check_page", "引了 2 个外部资源")], at),
    ] }));
    fs.writeFileSync(path.join(SESS, "s2.json"), JSON.stringify({ updated_at: at, transcript: [
      ...turn([err("edit_file", "没找到 old_text"), err("run_shell", "未知工具：directory_tree")], at),
      // 真报错和 Electron 自己的噪音撞在一条 preview 里：必须判成真问题，不能归成误报把真错藏了
      ...turn([err("check_page", "引了 1 个外部资源；控制台报错 1 条：Electron Security Warning (Insecure CSP)")], at),
      ...turn([err("check_page", "控制台报错 1 条：Electron Security Warning (Insecure CSP)"), err("run_shell", "未知工具：directory_tree"),
        // 写完自检顶回来：文件是写进去了，毛病在内容。别跟"改文件失败"混成一堆
        err("edit_file", "已修改 a.html：在第 3 行替换了 1 处，400 → 800 字符 ⚠️ 页面结构有问题：<body> 开 1 个、闭 0 个，对不上"),
        err("edit_file", "工具执行出错: report 是一个目录，不是文件。里面有：a.html、b.css")], at),
    ] }));
    };
    writeSessions(now);
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

    // 规则刚生效、后面一个回合都没跑：打分只能说「样本不够」。以前窗口按天向上取整，会把生效前那 6 个回合算成生效后的
    assert.ok(ev.scoreRules({ minTurns: 1 }).every(x => x.verdict === "样本不够"), "生效前的回合被算成了生效后的：" + JSON.stringify(ev.scoreRules({ minTurns: 1 })));
    // 生效之后再跑同样的 6 个回合、再点同样的 2 个 👎（同一轮改判会刷新时间戳）
    writeSessions(new Date(Date.now() + 1).toISOString());
    ev.recordFeedback({ session: "s1", turn: 3, verdict: "down", note: "" });
    ev.recordFeedback({ session: "s2", turn: 1, verdict: "down", note: "" });

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

      // 缩进对不上：真实数据里 edit_file 156 次调用没命中 21 次（12.8%），没命中之后 5/6 次
      // 是回头把整篇文件再 read_file 一遍，平均多花 2.8 次工具调用才重新写回去。
      // 只差缩进的这一类不值得付这个代价：唯一命中就直接改，并按文件原本的缩进写回。
      fs.writeFileSync(path.join(ws, "缩进.js"), "function f() {\\n      const x = 1;\\n      return x;\\n}\\n");
      r = await call("edit_file", { path: "缩进.js", old_text: "const x = 1;\\nreturn x;", new_text: "const x = 2;\\nreturn x * 2;" });
      assert.strictEqual(r.isError, false, "只差缩进也没救回来：" + r.content);
      assert.ok(/去掉首尾空白后唯一匹配/.test(r.content), "救回来了却没交代是怎么匹配上的：" + r.content);
      assert.strictEqual(fs.readFileSync(path.join(ws, "缩进.js"), "utf8"), "function f() {\\n      const x = 2;\\n      return x * 2;\\n}\\n", "救是救回来了，缩进写坏了");

      // 负向对照一：去掉空白后有两处能对上，绝不许挑一处改
      fs.writeFileSync(path.join(ws, "俩.js"), "  log(1);\\n  log(2);\\nlog(1);\\n");
      r = await call("edit_file", { path: "俩.js", old_text: "log(1);", new_text: "log(3);" });
      assert.strictEqual(r.isError, true, "两处只差缩进的也敢改");
      assert.ok(/不唯一/.test(r.content), r.content);
      assert.strictEqual(fs.readFileSync(path.join(ws, "俩.js"), "utf8"), "  log(1);\\n  log(2);\\nlog(1);\\n", "报了不唯一却已经把文件改了");

      // 负向对照二：内容本身对不上的，照样顶回去（不是把匹配放松成谁都能过）
      r = await call("edit_file", { path: "缩进.js", old_text: "const y = 1;", new_text: "z" });
      assert.strictEqual(r.isError, true, "内容根本不一样的也放过了");

      // 负向对照三：半行片段仍走精确匹配，不会被当成整行替换
      fs.writeFileSync(path.join(ws, "半行.js"), "  hazards:[ {x:330,y:436} ],\\n");
      r = await call("edit_file", { path: "半行.js", old_text: "y:436", new_text: "y:432" });
      assert.strictEqual(fs.readFileSync(path.join(ws, "半行.js"), "utf8"), "  hazards:[ {x:330,y:432} ],\\n", "半行片段改坏了");

      // new_text 给空 = 把这几行删掉，别留个空行
      fs.writeFileSync(path.join(ws, "删行.js"), "a();\\nb();\\nc();\\n");
      r = await call("edit_file", { path: "删行.js", old_text: "  b();", new_text: "" });
      assert.strictEqual(fs.readFileSync(path.join(ws, "删行.js"), "utf8"), "a();\\nc();\\n", "删行留下了空行");

      // 第一行是模型记岔的：老逻辑只拿第一行找锚点，21 次没命中里有 10 次连提示都给不出。
      // 现在要把文件那一段**原文**贴回去让它照抄，而不是打发它再 read_file 一遍。
      fs.writeFileSync(path.join(ws, "进度.md"), "# 标题\\n\\n- [x] 3. A线·专业线：5 篇正文\\n- [ ] 4. B线\\n");
      r = await call("edit_file", { path: "进度.md", old_text: "- [ ] 修复未闭合 div 并复检\\n- [ ] 4. B线", new_text: "x" });
      assert.strictEqual(r.isError, true);
      assert.ok(/原文开始/.test(r.content) && /A线/.test(r.content), "第一行对不上时没把文件原文贴出来：" + r.content);
      assert.ok(/不用再 read_file/.test(r.content), "还在打发它回头重读整篇文件：" + r.content);

      // 贴原文不能反过来把上下文烧了
      fs.writeFileSync(path.join(ws, "大.txt"), Array.from({ length: 400 }, (_, i) => "行" + i + " " + "x".repeat(200)).join("\\n"));
      r = await call("edit_file", { path: "大.txt", old_text: "行250 " + "x".repeat(200) + "\\n对不上的一行", new_text: "y" });
      assert.ok(r.isError && r.content.length < 3000, "报错本身就吃掉一大块上下文：" + r.content.length + " 字");

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
      // 翻页翻到文件末尾之后 = 「读完了」这条信息本身，不是工具失败。标成 isError 会喂进
      // errStreaks，把一次正常的顺序翻页记成 read_file 连续失败（本机 96 段会话里 13 次
      // read_file 失败有 6 次是这个）。话要照说，只是不占失败额度。
      r = await call("read_file", { path: "app.js", start_line: 999 });
      assert.strictEqual(r.isError, false, "翻页翻过文件末尾被当成了工具失败：" + r.content);
      assert.ok(/到头了/.test(r.content) && /共 \\d+ 行/.test(r.content), "没把「文件到这儿就完了」说清楚：" + r.content);
      // 负向对照：文件根本不存在，那才是真失败
      r = await call("read_file", { path: "根本没有这个文件.js", start_line: 1 });
      assert.strictEqual(r.isError, true, "读不存在的文件也放过了（说明是把报错关了，不是改判据）");

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
  console.log("✅ 改代码工具：精确替换（不唯一/找不到都报清楚且不误改）· 只差缩进能唯一救回并保持原缩进（两处能对上/内容真不一样/半行片段 三种负向对照都不误改）· 没命中时直接贴文件原文让它照抄，不再打发它重读整篇 · 全文搜索跳依赖目录 · 只读一段 · 覆盖有提示 · 只看不动档拦得住");
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

      // 「还没写完」不等于「写错了」。这是真实数据里最吵的一类误报：工具描述自己就教模型
      // 一节一节写长文档，第一节 <html>/<body> 还开着，自检就报「页面结构有问题」并 isError:true
      // → 喂进 errStreaks → 弹「已连续失败 4 次」，可每一次文件都写成功了。
      // 本机 96 段会话：write_file 41 次报失败里 38 次文件其实写进去了、edit_file 51 次里 31 次
      // 改也确实改成了；带「开 N 闭 M」的失衡报告共 144 条，其中 138 条是「开着还没闭」，
      // 而工作区落盘的 48 个 html 文件没有一个真缺 </html>——全是中途状态被当成了错。
      // 判据因此改成「有没有收尾」：没写 </html> 就是还在写，开着不算错；写了才按对不上判。
      r = await call("write_file", { path: "长页.html", content:
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>分节写</title></head>' +
        '<body><div class="wrap"><h1>标题</h1>' });
      assert.strictEqual(r.isError, false, "写文档的前半截被当成了失败：" + r.content);
      assert.ok(/还开着没闭/.test(r.content), "写到一半这件事一句都没跟模型说：" + r.content);
      // 负向对照一：已经收尾了（有 </html>）还对不上，那就是真漏了一个闭合标签，照报
      r = await call("write_file", { path: "收尾漏了.html", content:
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>收尾漏了</title></head>' +
        '<body><div class="wrap"><p>这是一段足够长的正文内容，用来避免被判成空壳页面。</p></body></html>' });
      assert.strictEqual(r.isError, true, "文档都收尾了 <div> 还开着，这时候必须报（不然就是把检查关了）");
      assert.ok(/<div> 开 1 个、闭 0 个/.test(r.content), r.content);
      // 负向对照二：没收尾也不代表随便写——闭的比开的还多，往下怎么写都圆不回来
      r = await call("write_file", { path: "多闭了.html", content:
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>多闭了</title></head>' +
        '<body><div class="wrap"><p>这是一段足够长的正文内容，用来避免被判成空壳页面。</p></div></div>' });
      assert.strictEqual(r.isError, true, "写到一半也不能多闭一个 </div>");
      r = await call("write_file", { path: "长页2.html", content: '<!DOCTYPE html><html><head><title>分节写</title></head><body><div>', append: true });
      assert.strictEqual(r.isError, false, "续写第一节被当成了错：" + r.content);
      r = await call("write_file", { path: "长页2.html", content: '<p>这是一段足够长的正文内容，用来避免被判成空壳页面。</p></div></body></html>', append: true });
      assert.strictEqual(r.isError, false, "续写收尾那一节反倒报错了：" + r.content);
      // 但「闭的比开的还多」跟写没写完无关，续写时照样是错
      r = await call("write_file", { path: "长页2.html", content: "</div></div>", append: true });
      assert.strictEqual(r.isError, true, "续写时多闭了两个 div 也放过了");

      // 代码同理：分节 append 的半个函数是「还没写完」，整篇写半个函数才是错
      r = await call("write_file", { path: "分节.js", content: "function a() {\\n", append: true });
      assert.strictEqual(r.isError, false, "续写半个函数被当成语法错：" + r.content);
      r = await call("write_file", { path: "分节.js", content: "  return 1;\\n}\\n", append: true });
      assert.strictEqual(r.isError, false, r.content);
      r = await call("write_file", { path: "整篇半个.js", content: "function a() {\\n" });
      assert.strictEqual(r.isError, true, "整篇写半个函数也放过了（负向对照：不是把检查关了）");
      // 真语法错在续写里也必须报——放行的只有「读到文件末尾才发现不够」那一类
      r = await call("write_file", { path: "续写坏.js", content: "const x = ;\\n", append: true });
      assert.strictEqual(r.isError, true, "续写里的真语法错被一起放过了");
      // 围栏：续写中途只开了一半是正常的，下一节接着写就闭上了
      r = await call("write_file", { path: "分节.md", content: "# X\\n\\n\\u0060\\u0060\\u0060js\\nconst a = 1;\\n", append: true });
      assert.strictEqual(r.isError, false, "续写里的半截围栏被当成错：" + r.content);

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

      // edit_file 走的是同一道自检，同一条判据：真实数据里 edit_file 31 次「改成功却报失败」中
      // 18 次就是这个——改的是还没收尾的半截页面，改完 <html> 当然还开着
      await call("write_file", { path: "半截.html", content:
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>半截</title></head>' +
        '<body><div class="wrap"><h1>旧标题</h1>' });
      r = await call("edit_file", { path: "半截.html", old_text: "旧标题", new_text: "新标题" });
      assert.strictEqual(r.isError, false, "改半截页面被当成了失败：" + r.content);
      assert.ok(/已修改/.test(r.content), r.content);

      // 少给 path：本机 96 段会话里 write_file 2 次、edit_file 5 次，参数里压根没有 path
      // （多半是超长参数被截断）。老写法把空路径当成「工作目录本身」，回一句
      // EISDIR: illegal operation on a directory, open '/Users/…'——模型看不出自己错在哪，
      // 会照原样再试一遍；本机绝对路径还顺带漏进了对话里。
      r = await call("write_file", { content: "<p>忘了给文件名</p>" });
      assert.strictEqual(r.isError, true, "没给 path 也判成功了");
      assert.ok(/没给 path/.test(r.content), "没说清楚是漏了 path：" + r.content);
      assert.strictEqual(/EISDIR/.test(r.content), false, "还在往外抛 EISDIR：" + r.content);
      assert.strictEqual(r.content.includes(ws), false, "报错里漏了本机绝对路径：" + r.content);
      r = await call("edit_file", { old_text: "a", new_text: "b" });
      assert.ok(/没给 path/.test(r.content), "edit_file 漏 path 没说清楚：" + r.content);
      r = await call("read_file", {});
      assert.ok(/没给 path/.test(r.content), "read_file 漏 path 没说清楚：" + r.content);
      // 负向对照：正常给了 path 的照走不误
      r = await call("read_file", { path: "doc.md" });
      assert.strictEqual(r.isError, false, "加了空路径闸门后正常读文件也被拦了：" + r.content);

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

      // JS 里拼 HTML 的字符串不许被当成真标签数。工作区里现有的两处「标签对不上」100% 是这么来的
      await call("write_file", { path: "带脚本.html", content:
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>带脚本</title></head>' +
        '<body><div id="app"><p>这是一段足够长的正文内容，用来避免被判成空壳页面。</p></div>' +
        '<scr' + 'ipt>document.getElementById("app").innerHTML = "<div class=x>" + 1;' +
        '/* <div> <body> 注释里也别数 */</scr' + 'ipt></body></html>' });
      r = await call("check_page", { path: "带脚本.html" });
      assert.strictEqual(/开 \d+ 个、闭 \d+ 个/.test(r.content), false, "把 script 正文里的字符串当成标签数了：" + r.content);
      // 负向对照：真少一个 </div> 还是要报
      await call("write_file", { path: "真少一个.html", content:
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>真少</title></head>' +
        '<body><div><div><p>这是一段足够长的正文内容，用来避免被判成空壳页面。</p></div></body></html>' });
      r = await call("check_page", { path: "真少一个.html" });
      assert.ok(/<div> 开 2 个、闭 1 个/.test(r.content), "真少一个 </div> 反倒不报了：" + r.content);

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
  console.log("✅ 交付质量：长文档能续写且中途半截不算错（整篇写半截仍顶回=负向对照）· JS/JSON 语法坏了当场顶回（合法 ESM 不误伤）· Markdown 围栏没闭合能查出 · 网页外链/断链/标签不闭合都拦得住 · script 正文和注释里的字符串不当标签数");
}

/**
 * mermaid 语法自动纠错。
 *
 * 真实数据：本机 96 段会话里 gen_diagram 调了 37 次挂了 7 次（18.9%），七次全是 mermaid
 * 语法报错，且全落在四类纯机械的写法错误上（标签开 `["` 收 `")`、subgraph 标题带括号/冒号
 * 没加引号、timeline 拿全角「：」当分隔符、gitGraph 中文分支名没加引号）——跟"这张图想画成
 * 什么样"毫无关系。而模型收到的回执是 mermaid 那句 `Expecting 'SQE', 'TAGEND', 'UNICODE_TEXT'…`，
 * 它读不懂这是在说哪个字符，只能把整张图重写一遍碰运气，一张图能来回三四趟。
 *
 * 这里守两头，缺一不可：
 *   **改得对** —— 七类错例逐条盯死改成什么样，不是"只要 fixes 非空就算过"；
 *   **不乱动** —— 合法写法一个字节都不许碰。这条真抓到过一次误伤：timeline 正文里的
 *   「：」被当成分隔符换掉，一张本来渲染成功的行程图九行全被改写。
 * 「改完真的能过 mermaid」由 test/frontend.js 在真 Chromium 里拿真 mermaid.parse 验——
 * 纯字符串断言只能证明纠错器跟自己对上了答案，改坏了照样绿。
 */
function testDiagramRepair() {
  const { repairMermaid, mermaidError } = require("../diagram");
  const { bad, ok } = require("./fixtures/mermaid");
  const fix = (s) => repairMermaid(s);

  // 一、七类真实错例：都得改到，而且必须说得出改了什么（说不清就是在猜一张别的图）
  for (const [name, src] of bad) {
    const r = fix(src);
    assert.ok(r.fixes.length > 0, `真实错例「${name}」纠错器一条都没认出来`);
    assert.notStrictEqual(r.source, src, `真实错例「${name}」说改了却一个字节没动`);
  }

  // 二、负向对照：本来就合法的写法，纠错器碰一下都算 bug
  for (const [name, src] of ok) {
    const r = fix(src);
    assert.strictEqual(r.fixes.length, 0, `合法写法「${name}」被当成错的了：${r.fixes.join("；")}`);
    assert.strictEqual(r.source, src, `合法写法「${name}」被改动了`);
  }

  // 三、逐条盯死改成什么样
  assert.strictEqual(
    fix('flowchart TD\n  F["汇合点<br/>(待定)")').source,
    'flowchart TD\n  F["汇合点<br/>(待定)"]',
    "标签开 [\" 收 \") 没被改回 ]"
  );
  assert.strictEqual(
    fix('graph LR\n  R["① 会重启<br/>(评估加固之后)]"').source,
    'graph LR\n  R["① 会重启<br/>(评估加固之后)"]',
    "收尾括号写进引号里了，应该挪到引号外面"
  );
  assert.strictEqual(
    fix("graph TD\n  subgraph 上游: 输入侧\n  end").source,
    'graph TD\n  subgraph "上游: 输入侧"\n  end',
    "subgraph 裸标题里的冒号没补引号"
  );
  assert.strictEqual(
    fix("flowchart LR\n    subgraph 处理[后端 (关键)]\n    end").source,
    'flowchart LR\n    subgraph 处理["后端 (关键)"]\n    end',
    "subgraph 别名[标题] 里的括号没补引号"
  );
  assert.strictEqual(
    fix("timeline\n    2025-07-08 05:45： 触发过一次故障").source,
    "timeline\n    2025-07-08 05：45 :  触发过一次故障",
    "timeline 的全角冒号没换成半角分隔符（正文里原有的半角冒号也得让开）"
  );
  assert.strictEqual(
    fix("gitGraph\n    branch 冷启动").source,
    'gitGraph\n    branch "冷启动"',
    "gitGraph 的中文分支名没补引号"
  );

  // 四、几个最容易被误伤的写法，单独钉一遍
  for (const [why, src] of [
    ["%%{init:…}%% 指令块里全是花括号，不许当节点标签改", '%%{init: {"theme": "base"}}%%\nflowchart TD\n  A["正文"] --> B["也是正文"]'],
    ["标签正文里本来就有方括号/花括号", 'flowchart TD\n  A["数组 arr[0] 取值"] --> B["映射 map{k}"]'],
    ["[[子流程]] [(数据库)] (((终点))) 这些形状本来就对", 'flowchart TD\n  C[["子流程"]] --> D[("数据库")]\n  D --> E((("终点")))'],
    ["timeline 已经拿半角冒号当分隔符了，正文里的「：」是内容", "timeline\n        : 上午：出发"],
    ["gitGraph 的英文分支名不用加引号", "gitGraph\n    branch feature/x"],
    ["没加引号的裸标签不碰（加引号是另一件事，别顺手做）", "flowchart TD\n  A[入口] --> B[出口]"],
  ]) {
    const r = fix(src);
    assert.strictEqual(r.source, src, `不该动却动了（${why}）：${r.fixes.join("；")}`);
  }

  // 五、救不回来的时候，报错必须点到具体哪一行、并把那行原文贴出来。
  //     mermaid 原话只有 "Parse error on line 3 … Expecting 'SQE'"，模型据此只能整张图重写。
  const doomed = "graph TD\n  A --> B\n  C[[[坏\n";
  const em = mermaidError(new Error("Parse error on line 3:\n...Expecting 'SQE', 'TAGEND'"), doomed).message;
  assert.ok(em.includes("第 3 行："), "报错没点到具体行号");
  assert.ok(em.includes("C[[[坏"), "报错没把出错那一行的原文贴出来");
  assert.ok(em.includes("Parse error on line 3"), "报错把 mermaid 的原话吞了");
  assert.ok(/只改这几行/.test(em), "报错没告诉模型别整张图重写");
  // 认不出行号时不许瞎编
  assert.ok(!/第 \d+ 行/.test(mermaidError(new Error("something else"), doomed).message), "没有行号时不该编一个出来");

  // 六、真正接线的是 renderDiagram 里的 mermaid 分支：纠错器再好，没接上等于没有
  const dsrc = fs.readFileSync(path.join(__dirname, "..", "diagram.js"), "utf8");
  const mb = dsrc.slice(dsrc.indexOf('} else if (k === "mermaid")'), dsrc.indexOf('} else if (k === "plantuml")'));
  assert.ok(mb.length > 200, "diagram.js 里 mermaid 分支找不到了（结构被改过？）");
  assert.ok(mb.includes("repairMermaid(src)"), "mermaid 渲染失败后没有走自动纠错重试");
  assert.ok(mb.includes("mermaidError("), "mermaid 报错没走贴原文那条路");
  assert.ok(mb.includes("noRetry"), "渲染器没得用（kroki 也挂）时不该当成语法错去重试");

  console.log(`✅ 图表纠错：真实 7 类 mermaid 写法错误全部自动改对（真实失败率 18.9% = 37 调 7 挂）· ${ok.length} 张合法图一个字节没动 · 指令块/方括号正文/子流程形状/已用半角冒号的 timeline 都不误伤 · 救不回来时报错点到行并贴原文 · renderDiagram 确实接了这条线`);
}

/**
 * 记忆层。老版本只有一个全局 memory.md，agent 自己记不住任何东西、还所有账号串在一起。
 * 这里守四条：**按账号隔离**、**去重**、**超量丢最旧的要留痕**（不许闷声吞）、**密钥拒记**。
 */
/**
 * 自进化的口径与铺开度（2026-09-09 从真实数据里挖出来的三个坑）：
 *  1. 本机引擎写的 tool_result 不带名字 → 「tool_error:」空名顶到榜首（49 次）却说不出是哪个工具；
 *     老数据按同一轮 tool_use 的 id 认回去，认不回的给个明确的占位名，空名绝不许进 key。
 *  2. Claude Code 非交互模式下要审批/被沙箱拦的命令，是权限档的事（config），不是提示词能治的。
 *  3. 打分窗口按「天」向上取整：规则昨晚 23 点生效，前一天 23 点起的失败全算成「生效后还在犯」——
 *     规则越有效越会被判「没起作用」。改成 since 精确到出生那一毫秒。
 *  4. 证据要跨 ≥2 个会话（同一会话里连撞五次是一次事故）；👎 例外。
 *  5. 基线口径跟生效后的口径一致（都只算带时间的回合），带时间的回合太少才退回全量并明说。
 */
function testEvolveCaliberAndSpread() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-caliber-"));
  const script = `
    const assert = require("assert");
    const fs = require("fs");
    const path = require("path");
    const ev = require(${JSON.stringify(path.join(__dirname, "..", "evolve.js"))});
    const SESS = path.join(process.env.WB_DATA_DIR, "sessions");
    fs.mkdirSync(SESS, { recursive: true });
    const NOW = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const err = (name, preview, id) => ({ type: "tool_result", id, name, isError: true, preview });
    const use = (id, name) => ({ type: "tool_use", id, name });
    const t = (at, events) => [{ type: "user", text: "跑一下", at: iso(at) }, { type: "assistant", at: iso(at), events }];
    const BORN = NOW - 2 * 3600e3; // 规则两小时前生效

    // 会话 A：生效前一小时失败过一次，生效后一小时干净跑了一轮
    fs.writeFileSync(path.join(SESS, "a.json"), JSON.stringify({ updated_at: iso(NOW), transcript: [
      ...t(BORN - 3600e3, [err("run_shell", "zsh: no matches found: *.png")]),
      ...t(BORN + 3600e3, [{ type: "tool_result", name: "run_shell", isError: false, preview: "ok" }]),
    ] }));
    // 会话 B：本机引擎写的三条空名报错——两条能按 id 认回 Bash，一条没有配对
    fs.writeFileSync(path.join(SESS, "b.json"), JSON.stringify({ updated_at: iso(NOW), transcript: [
      ...t(NOW - 1800e3, [use("tu1", "Bash"), err("", "This command requires approval", "tu1")]),
      ...t(NOW - 1700e3, [use("tu2", "Bash"), err("", "EISDIR: illegal operation on a directory, read '/x'", "tu2")]),
      ...t(NOW - 1600e3, [use("tu3", "Bash"), err("", "Contains while_statement", "tu3")]),
      ...t(NOW - 1500e3, [err("", "boom", "tu-none")]),
    ] }));

    // 1+2：空名认回去；引擎审批归 config；认不回的用占位名，key 绝不许以冒号结尾
    let m = ev.mineSignals({ days: 7 });
    const ea = m.signals.find((s) => s.key === "engine_approval:Bash");
    assert.ok(ea, "requires approval / Contains while_statement 没归成 engine_approval:Bash：" + m.signals.map((s) => s.key).join(","));
    assert.strictEqual(ea.count, 2, "两种沙箱拒绝话术该归同一类：" + ea.count);
    assert.strictEqual(ea.actionable, "config", "引擎审批是权限档的事，不该标成提示词能治");
    assert.ok(m.signals.some((s) => s.key === "path_is_dir:Bash"), "空名没按同一轮 tool_use 的 id 认回 Bash");
    assert.ok(m.signals.some((s) => s.key === "tool_error:未记名工具"), "认不回名字的没给占位名");
    assert.ok(!m.signals.some((s) => /:$/.test(s.key)), "有空名进了 key：" + m.signals.map((s) => s.key).join(","));

    // 3：since 精确起点 vs 老的按天取整（负对照：老口径确实会把生效前的失败算进来）
    const after = ev.mineSignals({ since: BORN, datedOnly: true });
    assert.strictEqual(after.turns, 5, "since 之后该有 A 的 1 轮 + B 的 4 轮，实际 " + after.turns);
    assert.ok(!after.signals.some((s) => s.key === "zsh_glob"), "生效前一小时的失败被算成了生效后");
    const byDays = ev.mineSignals({ days: Math.max(1, Math.ceil((NOW - BORN) / 86400e3)), datedOnly: true });
    assert.ok(byDays.signals.some((s) => s.key === "zsh_glob"), "负对照失效：按天取整的老口径本该把生效前的失败算进来");
    assert.ok(after.days > 0 && after.days < 1, "since 模式下 days 该是精确的小数：" + after.days);

    // 端到端：规则生效后一次没犯，打分必须判「有效」而不是建议下架
    fs.mkdirSync(path.join(process.env.WB_DATA_DIR, "learned"), { recursive: true });
    const [p] = ev.addProposals([{
      kind: "add_rule", signal: "zsh_glob", rule: "通配符路径一律加引号。", verify: "zsh_glob 降到 0",
      baseline: { key: "zsh_glob", rate: 0.5, count: 5, turns: 10, at: iso(BORN), caliber: "dated" },
    }]);
    ev.decideProposal(p.id, "accept", { by: "测试" });
    const r0 = ev.activeRules()[0];
    const rf = path.join(process.env.WB_DATA_DIR, "learned", r0.id + ".md");
    fs.writeFileSync(rf, fs.readFileSync(rf, "utf8").replace(r0.meta.at, iso(BORN)));
    const sc = ev.scoreRules({ minTurns: 1, now: NOW }).find((x) => x.signal === "zsh_glob");
    assert.ok(sc, "没打出分");
    assert.strictEqual(sc.afterRate, 0, "生效后没再犯却算出了出现率：" + JSON.stringify(sc));
    assert.strictEqual(sc.verdict, "有效", "判反了：" + JSON.stringify(sc));
    assert.strictEqual(sc.suggestRetire, false, "有效的规则被建议下架");
    assert.ok(!/只能当参考/.test(sc.why), "基线口径一致时不该打「只能当参考」的补丁");

    // 4：铺开度闸门
    const base = { kind: "add_rule", signal: "zsh_glob", rule: "通配符加引号。", verify: "zsh_glob 降" };
    const sig = { key: "zsh_glob", kind: "zsh_glob", actionable: "prompt", count: 5, sessions: ["s1"], dated: 5, undated: 0, label: "x" };
    assert.ok(/会话/.test(ev.gateProposal(base, { signals: [sig], rules: [] }) || ""), "5 次全在 1 个会话里居然过了闸门");
    sig.sessions = ["s1", "s2"];
    assert.strictEqual(ev.gateProposal(base, { signals: [sig], rules: [] }), null, "跨 2 个会话的 5 次证据被拦了");
    const td = { key: "thumbs_down", kind: "thumbs_down", actionable: "prompt", count: 3, sessions: [], dated: 3, undated: 0, label: "👎" };
    assert.strictEqual(ev.gateProposal({ ...base, signal: "thumbs_down" }, { signals: [td], rules: [] }), null, "人点的 👎 不该受会话数约束");
    // 证据全是老数据、最近带时间的回合又足够多且一次没犯：不用治；带时间回合不够多则不许下这个结论
    const old = { ...sig, sessions: ["a", "b"], dated: 0, undated: 5 };
    assert.ok(/已经不犯/.test(ev.gateProposal(base, { signals: [old], rules: [], datedTurns: 40 }) || ""), "已经不犯的毛病还在提规则");
    assert.strictEqual(ev.gateProposal(base, { signals: [old], rules: [], datedTurns: 5 }), null, "带时间的回合才 5 个就敢说「已经不犯」");

    // 5：基线口径
    const b1 = ev._internals.baselineOf({ key: "k", rate: 0.2, count: 20, dated: 5 }, { turns: 100, undatedTurns: 50 });
    assert.deepStrictEqual([b1.caliber, b1.turns, b1.rate], ["dated", 50, 0.1], JSON.stringify(b1));
    const b2 = ev._internals.baselineOf({ key: "k", rate: 0.2, count: 20, dated: 5 }, { turns: 100, undatedTurns: 90 });
    assert.deepStrictEqual([b2.caliber, b2.rate], ["all", 0.2], JSON.stringify(b2));
    assert.strictEqual(ev.CAPS.minSessions, 2);

    // 6：采纳时会拿提案快照再过一遍闸门——快照只存会话「个数」，老快照压根没这个字段。三种都得能采纳，只有明确写着 1 个会话的才卡
    const snapOk = { key: "selfcheck_reject:edit_file", kind: "selfcheck_reject", count: 3, rate: 0.1, actionable: "prompt", label: "自检顶回", sessions: 2 };
    const mk = (snap) => ev.addProposals([{ kind: "add_rule", signal: snap.key, rule: "改完文件必须把改动处重新读一遍再回复。" + Math.random(), verify: snap.key + " 出现率下降", signalSnapshot: snap }])[0];
    assert.strictEqual(ev.decideProposal(mk(snapOk).id, "accept", { by: "t" }).status, "applied", "快照存会话个数=2 的提案采纳不了");
    const { sessions: _drop, ...snapOld } = snapOk; void _drop;
    assert.strictEqual(ev.decideProposal(mk({ ...snapOld, key: "selfcheck_reject:edit_file" }).id, "accept", { by: "t" }).status, "applied", "老快照（没 sessions 字段）的提案采纳不了——没记过不等于没铺开");
    assert.throws(() => ev.decideProposal(mk({ ...snapOk, sessions: 1 }).id, "accept", { by: "t" }), /1 个会话/, "快照明确只有 1 个会话还能采纳");
    assert.strictEqual(ev.decideProposal(mk({ key: "thumbs_down", count: 3, rate: 0.2, actionable: "prompt", label: "👎", sessions: 1 }).id, "accept", { by: "t" }).status, "applied", "👎 快照没带 kind 就被会话数卡住了");
    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, WB_DATA_DIR: path.join(dir, "data") }, encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "自进化口径/铺开度测试失败：\n" + (r.stderr || r.stdout));

  // 写盘那头：本机引擎必须把名字写进 tool_result（老数据靠 id 认，新数据不许再靠认）
  const engineNameCheck = (src) => {
    const problems = [];
    if (!/toolNames\.get\(b\.tool_use_id\)/.test(src)) problems.push("claude-code 引擎没按 tool_use_id 查名字");
    if (/type: "tool_result"[^}]*name: ""\s*,/.test(src)) problems.push("claude-code 引擎的 tool_result 还是写死空名");
    if (!/toolNames\.set\(b\.id, b\.name\)/.test(src)) problems.push("claude-code 引擎没在 tool_use 时登记名字");
    return problems;
  };
  const ccSrc = fs.readFileSync(path.join(__dirname, "..", "engines", "claude-code.js"), "utf8");
  assert.deepStrictEqual(engineNameCheck(ccSrc), [], engineNameCheck(ccSrc).join("；"));
  const mutated = ccSrc.replace('toolNames.get(b.tool_use_id) || ""', '""');
  assert.ok(engineNameCheck(mutated).length >= 1, "把名字改回空串闸门竟然没抓到");
  const toolsSrc = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
  console.log("✅ 自进化口径/铺开度：空名按 id 认回（认不回给占位名）· 引擎审批归 config · 打分 since 精确到出生毫秒（负对照：按天取整会把生效前算进去）· 证据须跨 2 会话（👎 例外）· 已不犯的不治 · 基线与打分同口径");
  void toolsSrc;
}

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

/**
 * 记忆「改口」：真实数据里第一、二条记忆是同一件事的两种说法且互相矛盾（发 .md 文件 vs 发正文别发附件），
 * add() 只对一模一样的去重，两条一起进提示词打架。词面相似度分不清「改口」和「相关但不同的两件事」
 * （真实数据里两种都落在 0.4~0.5），所以不自动删：把最像的那条摆到回执里让调用的模型决定。
 * 另：向量库为空而嵌入模型「配了」，以前界面上一个字不提——用户只会觉得「记忆越来越不准」。
 */
function testMemoryNearDup() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-memdup-"));
  const script = `
    const assert = require("assert");
    const mem = require(${JSON.stringify(path.join(__dirname, "..", "memory.js"))});
    (async () => {
    const a = mem.add({ text: "AI Builders 日报推送：直接把完整的 .md 日报文件发到群里，不要只发摘要", user: "甲" });
    assert.strictEqual(a.similar, null, "第一条就说跟谁很像");
    const b = mem.add({ text: "AI Builders 每日日报：把日报 md 文件里的完整内容作为消息正文发出去，不要发附件", user: "甲" });
    assert.strictEqual(b.ok, true, b.note);
    assert.ok(b.similar && b.similar.id === a.id, "改口的那条没指回旧的那条：" + JSON.stringify(b));
    assert.ok(/很像/.test(b.note) && /forget/.test(b.note), "回执没告诉模型怎么处理旧的：" + b.note);
    assert.strictEqual(mem.list("甲").length, 2, "机器擅自替旧的做了决定（自动删了）");
    // 负对照：不相干的、别人作用域的、太短的，都不许提示
    assert.strictEqual(mem.add({ text: "周报只要三段：进展 / 问题 / 下周计划", user: "甲" }).similar, null, "不相干的也说很像");
    assert.strictEqual(mem.add({ text: "AI Builders 每日日报：把日报 md 文件里的完整内容作为消息正文发出去，不要发附件", user: "乙" }).similar, null, "跨账号比对了");
    mem.add({ text: "用飞书", user: "丙" });
    assert.strictEqual(mem.add({ text: "用飞书文档", user: "丙" }).similar, null, "几个字的重合也算很像");

    // 向量状态：没接嵌入模型 → 明说；接了且算完 → 全量；渠道死了 → 算出来的少于总数
    const v0 = mem.vectorStatus();
    assert.deepStrictEqual([v0.enabled, v0.have], [false, 0], JSON.stringify(v0));
    assert.strictEqual(v0.total, mem._internals.load().length);
    mem.setEmbedder(Object.assign(async (texts) => texts.map(() => [1, 0, 0]), { model: "fake-embed" }));
    await mem.ensureVectors();
    const v1 = mem.vectorStatus();
    assert.ok(v1.enabled && v1.have === v1.total && v1.model === "fake-embed", JSON.stringify(v1));
    mem.setEmbedder(Object.assign(async () => null, { model: "dead-embed" }));
    mem.add({ text: "交付物一律不要水印，导出时把水印参数关掉", user: "甲" });
    await mem.ensureVectors();
    const v2 = mem.vectorStatus();
    assert.ok(v2.enabled && v2.have < v2.total, "渠道死了还报全量算好了：" + JSON.stringify(v2));
    assert.ok(v2.have > 0, "渠道死了把已经算好的向量清空了");
    console.log("OK");
    })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, WB_DATA_DIR: path.join(dir, "data") }, encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "记忆改口/向量状态测试失败：\n" + (r.stderr || r.stdout));
  // 三头钉住：工具说明教模型看回执、接口把向量状态吐出去、面板真把它画出来
  const toolsSrc = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
  const remember = /name: "remember",[\s\S]*?input_schema/.exec(toolsSrc);
  assert.ok(remember && /很像/.test(remember[0]) && /forget/.test(remember[0]), "remember 工具说明没教模型处理「很像」的回执");
  assert.ok(/vectors: memory\.vectorStatus\(\)/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")), "/api/memory 没吐向量状态");
  const pane = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
  assert.ok(/m\.vectors/.test(pane) && /语义召回/.test(pane) && /mem-vec/.test(pane), "记忆面板没画向量状态");
  console.log("✅ 记忆改口：很像的旧条摆进回执由模型决定（不自动删）· 不相干/跨账号/太短不提示 · 向量状态三态可见（没接/算完/渠道死）");
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

  // 谁在敲门：一挂反代，两道 IP 闸就从「防连打」变成「全公司互相锁死」，
  // 所以要能认出真客户端；但认的方式不能是「信 X-Forwarded-For 最左边那个」——那个正好是唯一能伪造的。
  const { clientIp, isPrivateAddr } = require("../account")._internals;
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { "x-forwarded-for": xff } : {} });
  const withTrust = (n, fn) => {
    const old = process.env.WB_TRUST_PROXY;
    if (n === null) delete process.env.WB_TRUST_PROXY; else process.env.WB_TRUST_PROXY = String(n);
    try { return fn(); } finally { if (old === undefined) delete process.env.WB_TRUST_PROXY; else process.env.WB_TRUST_PROXY = old; }
  };
  assert(isPrivateAddr("172.18.0.5") && isPrivateAddr("127.0.0.1") && isPrivateAddr("::1") && isPrivateAddr("::ffff:10.1.2.3"), "私网地址没认出来");
  assert(!isPrivateAddr("1.2.3.4") && !isPrivateAddr("172.32.0.1") && !isPrivateAddr(""), "公网地址被当成私网了");
  // 没开开关：头写什么都不看
  withTrust(null, () => assert.strictEqual(clientIp(req("172.18.0.5", "9.9.9.9")), "172.18.0.5", "默认就不该信 X-Forwarded-For"));
  // 开一层：Caddy 会把真实客户端追加在最后，取最右边那个
  withTrust(1, () => assert.strictEqual(clientIp(req("172.18.0.5", "203.0.113.7")), "203.0.113.7", "挂反代后没取到真客户端"));
  // 反关键：客户端自己伪造了一个，代理追加在后面 → 必须取代理写的那个，不是他伪造的
  withTrust(1, () => assert.strictEqual(clientIp(req("172.18.0.5", "9.9.9.9, 203.0.113.7")), "203.0.113.7", "取了客户端伪造的那一跳"));
  // 两层（Cloudflare → Caddy）：右起第 2 跳
  withTrust(2, () => assert.strictEqual(clientIp(req("172.18.0.5", "9.9.9.9, 203.0.113.7, 198.51.100.2")), "203.0.113.7", "两层代理数错了跳数"));
  // 说好有代理却是直连进来的：一个字都不信
  withTrust(1, () => assert.strictEqual(clientIp(req("203.0.113.9", "9.9.9.9")), "203.0.113.9", "直连进来还信了转发头"));
  // 链子比声明的短：退回 peer，不拿唯一能伪造的那个顶上
  withTrust(2, () => assert.strictEqual(clientIp(req("172.18.0.5", "9.9.9.9")), "172.18.0.5", "跳数不够时应当退回 peer"));
  withTrust(1, () => assert.strictEqual(clientIp(req("172.18.0.5", "")), "172.18.0.5", "没有转发头时应当退回 peer"));
  console.log("✅ 账本：坏文件不覆盖 / 写盘原子 / 登录限流 / https 认得出 / 反代下认得出真客户端且伪造头骗不过");
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
    const orgs = require(${JSON.stringify(path.join(__dirname, "..", "org.js"))});
    const { register, loadUsers, saveUsers, loadUsage } = acc._internals;
    // 开关从 users.json 搬到了组织设置里（企业版一个组织一个开关）。
    // 老版本写在 users.json.settings 里的那份由 migrateLegacySettings 搬过来，下面单独验。
    const setOn = (on) => orgs.updateOrg(orgs.DEFAULT_ORG, { settings: { credits_enabled: on } }, "test");
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

    // 升级路径：老版本把开关写在 users.json.settings 里。搬到组织设置之后，
    // 那份老设置必须被搬过来——搬丢了就是用户明明开着限额，升级后一夜之间全免费跑。
    const st2 = loadUsers(); st2.settings = { ...st2.settings, credits_enabled: true, open_register: true };
    delete st2.settings.migrated_to_org; saveUsers(st2);
    acc.migrateLegacySettings();
    assert.strictEqual(acc.creditsEnabled(), true, "老版本的限额开关没被搬进组织设置");
    assert.strictEqual(orgs.settingsOf(orgs.getOrg("default")).open_register, true, "老版本的开放注册开关没被搬过来");
    setOn(false);
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
    const orgs = require(${JSON.stringify(path.join(__dirname, "..", "org.js"))});
    const { register, loadUsers, saveUsers, loadUsage, saveUsage } = acc._internals;
    const setOn = (on) => orgs.updateOrg(orgs.DEFAULT_ORG, { settings: { credits_enabled: on } }, "test");

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
    const orgs = require(${JSON.stringify(path.join(__dirname, "..", "org.js"))});
    const { register, renameUser, loadUsers, saveUsers, loadUsage, issueToken } = acc._internals;
    const names = () => loadUsers().users.map((u) => u.username);

    register("老名字", "pw123456");
    register("别人", "pw123456");
    orgs.updateOrg(orgs.DEFAULT_ORG, { settings: { credits_enabled: true } }, "test");
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

  // 数会话 / 一键清空：空壳（闲置重置留下的 []）不算一段；盘上没读进内存的也要数到；清完盘上不留文件
  const s4 = createImSessionStore({ dir });
  s4.set("qq_c2c_9", []); // 闲置重置留下的空壳
  assert.deepStrictEqual(s4.keys().sort(), ["feishu_oc_1", "wecom_u"], "keys() 该只数有内容的会话：" + JSON.stringify(s4.keys()));
  const s5 = createImSessionStore({ dir }); // 冷启动：内存空，全靠盘
  assert.strictEqual(s5.keys().length, 2, "冷启动 keys() 没把盘上的数进来");
  assert.strictEqual(s5.clear(), 2, "clear() 该返回清掉的段数");
  assert.strictEqual(s5.keys().length, 0, "清完还数得出会话");
  assert.strictEqual(s5.has("feishu_oc_1"), false, "清完内存里还有");
  assert(!fs.readdirSync(dir).some((f) => f.endsWith(".json")), "清完盘上还有会话文件");
  assert.strictEqual(createImSessionStore({ dir }).keys().length, 0, "清完重启又回来了");
  assert.strictEqual(createImSessionStore({ dir: path.join(dir, "nope") }).clear(), 0, "目录不存在时 clear 该安静返回 0");

  // keys() 别把「空不空」这件事反复整份解一遍：/im/status 15 秒问一次，一直开着就是一直解。
  // 按 (mtime, size) 记账，文件没动就不重解；动过了必须重解——两头都要真。
  {
    const d2 = path.join(dir, "memo");
    fs.mkdirSync(d2, { recursive: true });
    const big = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(200) }));
    fs.writeFileSync(path.join(d2, "feishu_oc_big.json"), JSON.stringify(big));
    const st = createImSessionStore({ dir: d2 });
    let parses = 0;
    const realRead = require("../store").readJson, storeMod = require("../store");
    storeMod.readJson = (...a) => { parses++; return realRead(...a); };
    try {
      assert.strictEqual(st.keys().length, 1, "冷读没数到");
      const first = parses;
      assert(first >= 1, "第一次该真解一遍");
      for (let i = 0; i < 20; i++) st.keys();
      assert.strictEqual(parses, first, `文件没动过却又解了 ${parses - first} 遍`);
      // 文件真变了（清空成 []）：必须重解，数出来变 0
      fs.writeFileSync(path.join(d2, "feishu_oc_big.json"), "[]");
      fs.utimesSync(path.join(d2, "feishu_oc_big.json"), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
      assert.strictEqual(st.keys().length, 0, "文件改成空数组了还数得出来——记账没跟着 mtime 走");
      assert(parses > first, "文件动过却没重解");
      // 文件删了：账本别留着幽灵
      fs.unlinkSync(path.join(d2, "feishu_oc_big.json"));
      assert.strictEqual(st.keys().length, 0, "文件删了还数得出");
    } finally { storeMod.readJson = realRead; }
  }

  // 路由和界面闸门：清空接口在、状态里带会话数、助理设置页是卡片分区而不是九段说明平铺
  const imSrc = fs.readFileSync(path.join(__dirname, "..", "im.js"), "utf8");
  assert(imSrc.includes('router.get("/im/sessions"') && imSrc.includes('router.post("/im/sessions/clear"'), "im.js 缺会话数 / 清空接口");
  assert(/sessions:\s*\{\s*count:/.test(imSrc), "/im/status 没带 sessions.count");
  // 这个轮询是常开的，窗口没在看就别问——服务端那头要扫一遍会话目录
  const a01Im = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8");
  assert(/setInterval\(\(\) => \{ if \(!document\.hidden\) refreshImStatus\(\); \}, 15000\);/.test(a01Im), "IM 状态轮询没按窗口可见性收着");
  assert(/visibilitychange[\s\S]{0,120}refreshImStatus\(\)/.test(a01Im), "切回窗口没有立刻补一次 IM 状态");
  const app05 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
  assert(app05.includes("const IM_CHANNELS = [") && app05.includes("远程指挥") && app05.includes("结果推送") && app05.includes("上下文管理"), "助理设置页没按分区渲染");
  assert(app05.includes("取消连接") && app05.includes("确认断开？"), "取消连接没有两步确认");
  assert(!/<div class="card-item">\s*<div class="t">飞书机器人/.test(app05), "旧版平铺的飞书说明块还在");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert(/\.im-grid\s*\{[^}]*columns:\s*2/.test(html), "index.html 缺 .im-grid 双栏样式");
  assert(/\.im-card\.packed \.im-card-b\s*\{[^}]*display:\s*none/.test(html), "index.html 缺收起样式");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("✅ IM 会话：重启后上下文还在 / 砍历史只从整轮开头下刀 / 数会话不算空壳 / 清空落盘 / 设置页卡片分区闸门");
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

    // 混进一个会写文件的：写工具必须单跑，但它前面那两个只读的照样并发。
    // 以前是「整批退回串行」，于是 [抓, 抓, 写文件] 这种最常见的组合白等一次网络往返。
    peak = 0;
    events = [];
    hist = [{ role: "user", content: "抓两个页面再写文件" }];
    await createAgentRuntime({
      config,
      llm: scripted([[fetchCall(1), fetchCall(2), { id: "t9", name: "write_file", input: { path: tmpFile, content: "x" } }]]),
      mcpManager: new McpManager(),
      experts,
    }).runTask({ history: hist, emit: (ev) => events.push(ev) });
    assert.strictEqual(peak, 2, `前面两个只读调用没并发（实际最高并发 ${peak}）`);
    const pars = events.filter((e) => e.type === "parallel");
    assert.strictEqual(pars.length, 1, `并发段数不对，写工具不该被并进去（实际 ${pars.length} 段）`);
    assert.strictEqual(pars[0].count, 2, `并发只该吃前两个只读调用（实际 ${pars[0].count}）`);
    // 顺序即语义：写文件必须等两个抓取都回来了才开跑，绝不能跟它们挤在一起
    const order = events.filter((e) => e.type === "tool_use" || e.type === "tool_result").map((e) => e.type + ":" + e.id);
    const wStart = order.indexOf("tool_use:t9");
    assert(wStart > order.indexOf("tool_result:t1") && wStart > order.indexOf("tool_result:t2"), "写文件跟只读调用挤在一起跑了：" + order.join(" "));
    assert(fs.existsSync(path.join(WORKSPACE, tmpFile)), "切段之后写文件没跑到");
  } finally {
    srv.close();
    fs.rmSync(path.join(WORKSPACE, tmpFile), { force: true });
  }
  console.log("✅ 并发：只读批并发跑 / 结果顺序与 ID 不串 / 混合批里连续只读段照样并发、写操作单跑且排在它们后面");
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

/**
 * 成果清单的 500 条上限必须按「新旧」砍，不能按「目录遍历顺序」砍。
 *
 * 事故（2026-09-10，用户原话连着三条）：
 *   「怎么回事都看不到产出了啊」
 *   「在旁边的成果文件里面都看不到这个新文件夹啊」
 *   「不仅结束了没有预览，还看到这个文件夹」
 * 那一趟任务实实在在写出了 8 个文件（简历 docx/html、公司清单 xlsx、PROGRESS.md……），
 * 磁盘上全在，界面上一个都没有。
 *
 * 根因不在写文件，在列文件：老 outputFiles() 把 `out.length >= FILES_CAP` 判在 walk **里面**，
 * 排序放在截断**之后**——于是「留下哪 500 个」是 readdir 的目录顺序说了算，跟时间毫无关系。
 * 用户工作目录攒到 538 个文件那天，新建的任务目录整个落在被砍掉的 38 个里，
 * 两处功能同时哑火（它们都吃这一个函数的返回值）：
 *   - 右侧「成果文件」面板：新文件夹压根不在清单里；
 *   - agent.js 的 emitFiles()：拿前后两份 outputFiles() 做 mtime 差算「本回合产出」，
 *     两份里都没有这些文件 → changed 为空 → 对话里那块产出卡一张都不挂。
 *
 * 所以这条测试盯的是一个不变量，不是某次修法：**返回的一定是最新的那 500 个**。
 * 外加一个负向对照——把老写法（走到 500 就 return，排序在后）原样跑一遍同一棵树，
 * 必须真的把那 8 个新文件全丢掉；丢不掉说明这棵树没复现事故，测试本身就是假绿。
 */
function testOutputFilesRecency() {
  const { outputFiles, filesScope, getWorkspaceDir, setWorkspaceDir } = require("../tools");
  const CAP = 500;
  const prev = getWorkspaceDir();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "owb-recency-"));
  try {
    setWorkspaceDir(ws);

    // 一堆历史文件：名字排在前面、时间全是旧的（模拟用户攒了几百个文件的工作目录）
    const OLD_DIR = "aa_历史归档";
    const OLD_N = 600;
    fs.mkdirSync(path.join(ws, OLD_DIR), { recursive: true });
    const oldBase = Date.parse("2026-08-01T00:00:00Z");
    for (let i = 0; i < OLD_N; i++) {
      const f = path.join(ws, OLD_DIR, `旧文件_${String(i).padStart(3, "0")}.txt`);
      fs.writeFileSync(f, "x");
      const t = new Date(oldBase + i * 60000);
      fs.utimesSync(f, t, t);
    }

    // 刚跑完那一趟的产出：名字排在后面、时间最新
    const NEW_DIR = "zz_任务_0910_简历";
    const NEW = ["简历.docx", "简历.html", "PROGRESS.md", "公司清单.xlsx", "初稿.md", "投递指南.md", "resume.txt", "原件.pdf"];
    fs.mkdirSync(path.join(ws, NEW_DIR), { recursive: true });
    const newBase = Date.parse("2026-09-10T08:35:00Z");
    NEW.forEach((n, i) => {
      const f = path.join(ws, NEW_DIR, n);
      fs.writeFileSync(f, "x");
      const t = new Date(newBase + i * 60000);
      fs.utimesSync(f, t, t);
    });

    // ---- 负向对照：老写法在同一棵树上必须真的翻车 ----
    // readdir 的顺序各文件系统不一样，这里显式按名字排序喂给老算法——那是它完全可能拿到的一种顺序。
    const buggy = [];
    (function walk(dir, rel, depth) {
      if (depth > 3 || buggy.length >= CAP) return;                      // ← 老代码：截断发生在遍历里
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (buggy.length >= CAP) return;
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(full, r, depth + 1);
        else if (e.isFile()) buggy.push({ name: r, mtime: fs.statSync(full).mtime.toISOString() });
      }
    })(ws, "", 1);
    buggy.sort((a, b) => b.mtime.localeCompare(a.mtime));                // ← 排序在截断之后，救不回来了
    const lostByOldCode = NEW.filter((n) => !buggy.some((f) => f.name === `${NEW_DIR}/${n}`));
    assert.strictEqual(lostByOldCode.length, NEW.length,
      `负向对照没复现事故：老写法这次居然留住了 ${NEW.length - lostByOldCode.length} 个新文件，这棵树证明不了什么`);

    // ---- 正向：修完之后，最新的那批必须一个不少 ----
    const files = outputFiles();
    assert.strictEqual(files.length, CAP, `返回条数应为上限 ${CAP}，实际 ${files.length}`);
    const missing = NEW.filter((n) => !files.some((f) => f.name === `${NEW_DIR}/${n}`));
    assert.strictEqual(missing.length, 0,
      `★事故复现★ 刚写出来的文件不在清单里：${missing.join("、")} —— 右侧成果面板和「本回合产出」会同时空掉`);

    // 最新的 8 条就该排在最前面（前端和 emitFiles 都指望这个顺序）
    const top = files.slice(0, NEW.length).map((f) => f.name);
    assert.deepStrictEqual(
      [...top].sort(),
      NEW.map((n) => `${NEW_DIR}/${n}`).sort(),
      "最新的 8 个文件没排在最前面：" + top.join("、"),
    );
    for (let i = 1; i < files.length; i++) {
      assert(files[i - 1].mtime >= files[i].mtime, `第 ${i} 条起顺序乱了：${files[i - 1].name} / ${files[i].name}`);
    }

    // 砍掉的必须是最旧的那 108 个，不是随机 108 个
    const kept = new Set(files.map((f) => f.name));
    const droppedIdx = [];
    for (let i = 0; i < OLD_N; i++) if (!kept.has(`${OLD_DIR}/旧文件_${String(i).padStart(3, "0")}.txt`)) droppedIdx.push(i);
    assert.strictEqual(droppedIdx.length, OLD_N + NEW.length - CAP, "被砍掉的条数对不上");
    assert.strictEqual(Math.max(...droppedIdx), droppedIdx.length - 1, "砍掉的不是最旧的那一批（旧文件序号越小越旧）");

    // 清单不完整这件事得如实带出去，前端才不会拿它给旧产出盖「已删除」的章
    assert.strictEqual(filesScope(files).full, false, "超过上限了还报 full:true —— 前端会误判文件被删");

    // 静态闸门：别再有人把截断挪回遍历里（这是同一个坑的第二次）
    const toolsSrc = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
    const body = toolsSrc.slice(toolsSrc.indexOf("function outputFiles()"));
    const fnBody = body.slice(0, body.indexOf("\nfunction "));
    assert(/\.sort\([\s\S]*?\.slice\(0,\s*FILES_CAP\)/.test(fnBody),
      "outputFiles 里 slice(0, FILES_CAP) 必须排在 sort 之后 —— 顺序一反就是按目录顺序砍");
    assert(!/all\.length\s*>=\s*FILES_CAP/.test(fnBody),
      "遍历里又拿 FILES_CAP 当刹车了 —— 遍历的保险请用 WALK_CAP");

    console.log(`✅ 成果清单按时间截断：老写法丢光 ${NEW.length} 个新产出，现在最新 ${NEW.length} 个排在最前、砍的是最旧的 ${droppedIdx.length} 个（full:false 如实上报）`);
  } finally {
    setWorkspaceDir(prev);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log("=== OpenWorkBuddy e2e 测试 ===");
  testCron();
  testCommandGate();
  await testPermissionModes();
  testMemoryLayer();
  testMemoryNearDup();
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
  testSurfaceLayerGate();
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
  await testAnthropicEndpointAgreement();
  testPluginManifest();
  testPluginComponentIsolation();
  testPluginMcpRuntime();
  testPluginSkillsIntegration();
  testDefaultSkillsManifest();
  testDesktopAppIdentity();
  await testFrontendSvgFigures();
  testPackageAssetDrift();
  testNoNestedRoutes();
  await testAdminConsoleUI();
  await testNodeSuite("tenant.js", "多租户与企业后台越权");
  await testNodeSuite("prefs.js", "个人偏好与平台设置分界");
  await testDockerDeploy();
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
  testEvolveCaliberAndSpread();
  testTaskDirLifecycle();
  await testCodingTools();
  await testDeliverableQuality();
  testDiagramRepair();
  await testAgentPipeline();
  await testForcedWrapUp();
  await testAskUser();
  await testPromptNoAskContradiction();
  await testPromptQuestionVsWork();
  await testLocalEngineConnect();
  await testEngineToolBridge();
  await testEngineContextParity();
  await testEngineStoppedSurfacing();
  await testFeedbackAndUsage();
  testOutputOwnership();
  await testFilesEmitter();
  await testHeavyTools();
  testOutputFilesRecency();
  await testFilePathRouting();
  await testDesktopPet();
  testPetSprites();
  await testMcpFailureReason();
  await testThinkingSwitch();
  await testThinkingSettingsApi();
  await testOnboardingWizardApi();
  await testEmbedFailoverResilience();
  testUiNoRawMarkdown();
  testLookPrefsStatic();
  testI18n();
  testConnectorsAndExperts();
  testOutputArrivalStatic();
  testDemoReadmeWire();
  testDemoTiming();
  testReadmeFrontGate();
  testKeySourcesGate();
  testPackagingAndDemoGate();
  await testImInboundMedia();
  await testImCredentialGuard();
  await testUpdaterVersions();
  testLarkCliParse();
  await testLarkSecretNotClobbered();
  await testCompletionGate();
  testStepLines();
  await testStepLinesWired();
  await testGoalOnLocalEngine();
  await testDetectCache();
  await testStreamRender();
  await testSessionIndex();
  await testRunOwnership();
  testSessionCacheReload();
  testWindowsLaunch();
  testSkillRenameKeepsAssets();
  // 清理测试产物
  for (const f of fs.readdirSync(WORKSPACE)) {
    if (f.startsWith("e2e-")) fs.rmSync(path.join(WORKSPACE, f), { force: true });
  }
  console.log("=== 全部测试通过 ===");
}

/**
 * 嵌入渠道挂掉时别把记忆一起拖垮 —— 用户日志（2026-09-08 00:43）里的三连翻车。
 *
 * 现场：
 *   [记忆向量] 视频渠道的 key 不可用（400: Access denied…），改用 本地 Ollama   ×14 行一模一样
 *   [记忆向量] 本地 Ollama 调用失败（1/3）：fetch failed
 *   [llm] 工具调用 generate_image(call_00_…) 没有结果，已补占位              同 3 个 id 刷了 6 轮
 * 用户的感受是「怎么现在有点慢啊」。
 *
 * 三个各自独立的毛病：
 *   ① 向量库先清后算 —— embedder 一上来报的是首选渠道的模型名，而首选渠道一调就 4xx。
 *      按那个还没验证过的名字把整库清空，然后一条也算不出来 → 语义召回常年是空的。
 *   ② 死渠道没记性 —— createEmbedder 在启动/存设置/走完引导时各重建一次，每次都从头撞。
 *   ③ 坏配对的告警每轮重刷 —— 真正的新问题被淹在重复日志里。
 */
/**
 * Goal 模式在本机引擎上也得真跑起来。
 *
 * 老毛病：拆验收标准和验收判分这两步写死走 sessLLM（API 模型），外面还套着一个裸 catch {}。
 * 用户切到本机 Claude Code / Codex 图的就是不花 API 的钱，多半根本没配 API Key——
 * 于是拆解永远失败（标准退化成"目标原文"一条）、验收永远静默不打勾，目标卡卡在 0/N，
 * 从用户那边看就是「Goal 模式根本没做」。这里验两件事：
 *   ① 本机引擎在跑时，这两句问的是那个 CLI（engines.ask），不是 API；
 *   ② 问挂了要留痕（warn），不许静默——「后台飞轮吞异常必须留痕」。
 */
async function testGoalOnLocalEngine() {
  const engines = require("../engines");
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ① 两处「动脑」都改走 goalThink，源码里不许再直接钉死 sessLLM
  const think = src.match(/async function goalThink\(([\s\S]*?)\n}/);
  assert(think, "server.js 里没有 goalThink（Goal 的拆解/验收该由谁来答）");
  assert(/engines\.ask\(/.test(think[1]), "goalThink 没走 engines.ask：本机引擎在跑时还在偷偷花 API 的钱");
  for (const [re, fn, label] of [[/async function deriveGoalCriteria\(([\s\S]*?)\n}/, "deriveGoalCriteria", "拆验收标准"],
                                 [/async function verifyGoal\(([\s\S]*?)\n}/, "verifyGoal", "验收判分"]]) {
    const body = src.match(re);
    assert(body, "找不到 " + fn);
    assert(/await goalThink\(/.test(body[1]), fn + "（" + label + "）没走 goalThink，本机引擎用户这一步永远失败");
    assert(!/catch\s*\{\s*\}/.test(body[1]), fn + " 里还有裸 catch {}：这一步挂了用户永远看不见，只会以为是活没干好");
    assert(/warn\(/.test(body[1]), fn + " 挂了没留痕（warn），目标卡上不会写为什么不动");
  }

  // ② engines.ask 真能把问题递给本机引擎，且不接管任务会话（不传 resumeId、不落在用户目录里）
  let got = null;
  const stub = {
    id: "e2e-ask", label: "问答桩", bin: "x", note: "", install: "", launchHeader: "", supportsResume: true,
    models: [], detect: async () => ({ id: "e2e-ask", installed: true, path: "x", version: "1" }),
    run: async (o) => { got = o; return { finalText: '{"criteria":["有画布","方向键能控制","撞墙会结束"]}' }; },
  };
  engines.BACKENDS.push(stub);
  let text;
  try { text = await engines.ask({ id: "e2e-ask", system: "你是拆解器", prompt: "做个贪吃蛇" }); }
  finally { engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1); }
  assert(/画布/.test(text), "engines.ask 没把引擎的回答带回来");
  assert(got && got.prompt === "做个贪吃蛇" && got.systemPrompt === "你是拆解器", "engines.ask 没把系统提示/问题递下去");
  assert(got.maxTurns === 1 && !got.resumeId, "engines.ask 是一次性问答，不许接管任务会话");
  assert(got.cwd && !fs.existsSync(got.cwd), "engines.ask 用完没清掉临时目录（别在用户机器上留垃圾）");

  // ③ 拆解歪了要退化成「目标原文一条」并且把原因写到卡上（不是静默）
  const card = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
  assert(/gc-note/.test(card) && /gc-paused/.test(card) && /gc-go/.test(card), "目标卡没有「为什么不动 / 停了 / 接着冲」这三样");
  assert(/paused/.test(src) && /自动补跑已用满/.test(src), "服务端跑满轮数后没告诉前端「停了、为什么停」");
  console.log("  ✓ Goal 模式：拆解/验收改走本机引擎（不花 API 额度）、失败留痕、跑满轮数说清并能接着冲");
}

/**
 * 探测本机 CLI 是要起子进程的，别每个请求都来一遍。
 * /api/engines、/api/thinking、设置页、引导页、命令行全在调 detectAll，一次约 120~320ms
 * （每个 CLI 起一个 --version）。「装没装 claude」不是每秒都在变的事。
 */
async function testDetectCache() {
  const engines = require("../engines");
  let calls = 0;
  const stub = {
    id: "e2e-slow", label: "慢桩", bin: "x", note: "", install: "", launchHeader: "", supportsResume: true, models: [],
    detect: async () => { calls++; await new Promise((r) => setTimeout(r, 60)); return { id: "e2e-slow", installed: true, path: "x", version: "1" }; },
    run: async () => ({ finalText: "" }),
  };
  engines.BACKENDS.push(stub);
  try {
    await engines.detectAll({}, { force: true });      // 冷探一次（顺便把缓存里别的键洗掉）
    const base = calls;
    const t0 = Date.now();
    await Promise.all([engines.detectAll({}), engines.detectAll({}), engines.detectAll({}), engines.detectAll({}), engines.detectAll({})]);
    const ms = Date.now() - t0;
    assert.strictEqual(calls, base, `缓存没生效：5 次调用又探了 ${calls - base} 遍（每遍都要起子进程）`);
    assert(ms < 30, `命中缓存不该等 ${ms}ms`);
    await engines.detectAll({}, { force: true });
    assert.strictEqual(calls, base + 1, "点了「重新检测本机」却没真去重探——刚装完 CLI 的人会以为没装上");
    // 换一组用户填的路径 = 换一个问题，不能拿旧答案糊弄
    await engines.detectAll({ "e2e-slow": { bin: "/tmp/other" } });
    assert.strictEqual(calls, base + 2, "用户改了 CLI 路径还在吃旧缓存");
  } finally {
    engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
    await engines.detectAll({}, { force: true }); // 别把桩留在缓存里影响后面的用例
  }
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert(/force: req\.query\.force === "1"/.test(srv), "/api/engines 没把「重新检测」透传成 force，用户点了也只会拿到缓存");
  const ui = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
  assert(/renderEngineCard\(box, true\)/.test(ui), "设置页「重新检测本机」按钮没要求强制重探");
  console.log("  ✓ 本机 CLI 探测有缓存（5 次并发只探 1 遍）、「重新检测」仍真去重探、改了路径不吃旧缓存");
}

async function testStreamRender() {
  const app1 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8");
  const grab = (re, why) => { const m = app1.match(re); assert(m, why); return m[0]; };

  // 流式那一帧只许重写还在长的那一小截
  const append = grab(/const appendText = \(delta\) => \{[\s\S]*?\n  \};/, "app-01.js 里找不到 appendText 了");
  assert(/paintStream\(el\)/.test(append), "appendText 没走分段渲染");
  assert(!/el\.innerHTML\s*=/.test(append), "appendText 又回到每帧重建整棵 DOM（长回复会卡到选不中字）");

  const paint = grab(/function paintStream\(el\) \{[\s\S]*?\n\}/, "app-01.js 里找不到 paintStream");
  assert(/html\.startsWith\(sp\.html\)/.test(paint), "paintStream 没拿「整份重渲的前缀」当固化判据——后来的围栏会把前面的排版改掉");
  assert(/balancedHtml\(candHtml\)/.test(paint), "固化前没检查块级标签闭没闭合，insertAdjacentHTML 会被浏览器瞎闭合");
  assert(/lastIndexOf\("\\n\\n"/.test(paint), "固化的切点不在空行上");

  // 停笔必须合回一整块：复制/导出/innerText/计划清单都按「.a-text 底下直接是内容」读
  const seal = grab(/function sealStream\(el\) \{[\s\S]*?\n\}/, "app-01.js 里找不到 sealStream");
  assert(/el\.innerHTML = renderMd\(el\._raw\)/.test(seal), "sealStream 没整份重渲，分段的壳子会漏给下游");
  const turn = app1.slice(app1.indexOf("function createTurnUI("), app1.indexOf("// ================= 空状态"));
  const decl = (turn.match(/currentText = null/g) || []).length;
  assert.strictEqual(decl, 2, `回合里还有 ${decl - 2} 处直接把 currentText 置空（绕过了 endText，那一段永远不合回整块）`);
  assert(/function finish\(\) \{\s*\n\s*endText\(\);/.test(turn), "finish() 没先把最后一段合回整块，复制/存历史会读到分段的壳子");

  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert(/\.a-text > \.md-done, \.a-text > \.md-live \{ display: contents; \}/.test(html),
    "两个壳子没设 display:contents，会多出一层盒子把排版顶变形");

  console.log("  ✓ 流式正文分段渲染：只重写正在长的那截、固化判据是整份重渲的前缀、停笔合回整块");
}

async function testEmbedFailoverResilience() {
  const os = require("os");
  const http = require("http");
  const { spawnSync } = require("child_process");

  // ① + 负向控制：向量库该留的时候留、该作废的时候作废
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-vec-"));
  const script = `
    const assert = require("assert");
    const mem = require(${JSON.stringify(path.join(__dirname, "..", "memory.js"))});
    (async () => {
      for (let i = 0; i < 5; i++) mem.add({ text: "条目" + i, user: "甲" });

      // 先用「真正能用的那条渠道」把向量算出来，模拟已经跑过一阵子的机器
      const good = Object.assign(async (t) => t.map(() => [1, 0, 0]), { model: "nomic-embed-text" });
      mem.setEmbedder(good);
      await mem.ensureVectors();
      const built = Object.keys(mem._internals.vecLoad().vecs).length;
      assert.ok(built >= 5, "前置条件没成立：向量根本没算出来");

      // 重启后的样子：新 embedder 报的是首选渠道（阿里云）的模型名，但它一调就 400，
      // 当场换到 Ollama。整个过程里 .model 从 v4 变成 nomic —— 跟库里存的其实是同一个。
      let called = 0;
      const failover = Object.assign(
        async (t) => { if (called++ === 0) { failover.model = "nomic-embed-text"; return null; } return t.map(() => [1, 0, 0]); },
        { model: "text-embedding-v4" }
      );
      mem.setEmbedder(failover);
      await mem.ensureVectors();
      const after = Object.keys(mem._internals.vecLoad().vecs).length;
      assert.strictEqual(after, built, "首选渠道一挂就把整个向量库清空了（每次重启清一遍，语义召回永远是空的）");
      assert.strictEqual(mem._internals.vecLoad().model, "nomic-embed-text", "向量库记的模型名不是真正在干活的那个");

      // 更狠的一种：备用渠道（本机 Ollama）也没起来，从头到尾一次都算不成。
      // 这时候更不能清库 —— 清了就是「越坏丢得越干净」，用户的语义召回永久归零。
      mem.setEmbedder(Object.assign(async () => null, { model: "text-embedding-v4" }));
      await mem.ensureVectors();
      const vs1 = mem._internals.vecLoad();
      assert.strictEqual(Object.keys(vs1.vecs).length, built, "所有渠道都挂的时候，反而把向量库清空了");
      assert.deepStrictEqual(vs1.vecs[Object.keys(vs1.vecs)[0]], [1, 0, 0], "向量被清掉/被换掉了");
      assert.strictEqual(vs1.model, "nomic-embed-text", "一条都没算成，却把库的模型名改成了没验证过的首选渠道");

      // 负向控制：真的换了一个能用的新模型，旧向量就必须作废重算，不能将就着用
      mem.setEmbedder(Object.assign(async (t) => t.map(() => [0, 1, 0]), { model: "另一个嵌入模型" }));
      await mem.ensureVectors();
      const vs2 = mem._internals.vecLoad();
      assert.strictEqual(vs2.model, "另一个嵌入模型", "换了新模型，向量库的模型名没跟上");
      assert.ok(Object.keys(vs2.vecs).length >= 5, "换模型后没把向量重算回来");
      assert.deepStrictEqual(vs2.vecs[Object.keys(vs2.vecs)[0]], [0, 1, 0], "换了模型却还在用旧模型算的向量（维度/语义对不上，召回全是乱的）");
      console.log("OK");
    })().catch((e) => { console.error((e && e.stack) || e); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, WB_DATA_DIR: dir }, encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "向量库存活测试失败：\n" + (r.stderr || r.stdout));

  // ② 死渠道要有进程级记性，否则每建一个实例就白撞一次 + 刷一行重复日志
  const { markEmbedChannelDead, embedChannelDead, deadEmbedChannels } = require("../llm")._internals;
  deadEmbedChannels.clear();
  const ch = { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4", api_key: "sk-aaaabbbbcccc", label: "视频渠道的 key" };
  assert(!embedChannelDead(ch), "还没标记就说它死了");
  markEmbedChannelDead(ch, "400: Access denied");
  assert(embedChannelDead(ch), "标记过的死渠道没记住——下一个实例又会去撞一次");
  assert(/Access denied/.test(embedChannelDead(ch).why), "记住了但没记住为什么，日志里说不清");
  // 换了 key = 换了一条路，必须立刻重试（用户刚去把账号充上了，不该等超时）
  assert(!embedChannelDead({ ...ch, api_key: "sk-ddddeeeeffff" }), "用户换了 key 还被当成同一条死路");
  assert(!embedChannelDead({ ...ch, model: "text-embedding-v3" }), "换了模型还被当成同一条死路");
  // 超时之后自动忘掉
  deadEmbedChannels.set([...deadEmbedChannels.keys()][0], { at: Date.now() - 11 * 60 * 1000, why: "x" });
  assert(!embedChannelDead(ch), "过了重试窗口还记着，用户把账号充上了也得重启才生效");
  // 只记「这条路本身不通」的 4xx；超时和 5xx 下次可能就好了，不许拉黑
  deadEmbedChannels.clear();

  // ②b 上面验的是记性本身，这里验**接线**：真收到一个 4xx，有没有真的登记下来。
  //     （只对着 markEmbedChannelDead 断言的话，catch 里那一行删掉了也测不出来）
  deadEmbedChannels.clear();
  const { createEmbedder } = require("../llm");
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Access denied, please make sure your account is in good standing" } }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const cfg = { embedding: { base_url: `http://127.0.0.1:${port}/v1`, api_key: "sk-test-not-a-real-key", model: "text-embedding-v4" } };
  const warns = [];
  const w0 = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const emb1 = createEmbedder(cfg);
    assert.strictEqual(await emb1(["一段话"]), null, "4xx 了还返回向量？");
    assert.strictEqual(hits, 1, "4xx 是「这条路不通」，不该陪它重试满三次（白等 3 次超时 = 用户感觉到的卡）");
    // 同一个实例再来一次：一发 4xx 就该判死，第二次不许再去撞（否则每次记忆读写都白等一趟）
    assert.strictEqual(await emb1(["再一段"]), null, "死了还返回向量？");
    assert.strictEqual(hits, 1, "4xx 一次就够了，同一个实例第二次调用又去撞了（= 4xx 也陪它重试满 3 次）");
    assert(embedChannelDead(cfg.embedding), "真的收到 4xx 却没登记——下一个实例照样去撞");
    // 第二个实例：直接跳过，而且要出声说为什么、什么时候再试（不搞静默降级）
    assert.strictEqual(createEmbedder(cfg), null, "死渠道之外没有别的候选了，还硬返回一个 embedder");
    assert.strictEqual(hits, 1, "新实例又去撞了一次死渠道");
    const skip = warns.filter((x) => x.includes("跳过"));
    assert.strictEqual(skip.length, 1, "跳过了却一声不吭（用户不知道语义召回为什么没了）");
    assert(/Access denied/.test(skip[0]) && /分钟后自动重试/.test(skip[0]), "跳过的理由和重试时机没说清：" + skip[0]);
  } finally { console.warn = w0; srv.close(); deadEmbedChannels.clear(); }

  // ③ 同一条坏配对每轮都要补，但只该喊一次 —— 否则真正的新问题被重复日志淹了
  const { repairToolPairs, warnedLeakedPairs } = require("../llm")._internals;
  warnedLeakedPairs.clear();
  const orig = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(" "));
  try {
    const broken = () => [
      { role: "user", content: "画三张图" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_00_ZZZ", name: "generate_image", input: {} }] },
      { role: "user", content: "接着说" },
    ];
    const a = repairToolPairs(broken());
    const b = repairToolPairs(broken()); // 下一轮：同一条坏配对又来了
    const tool = (h) => h.find((m) => m.role === "tool");
    assert(tool(a) && tool(a).results[0].id === "call_00_ZZZ", "坏配对没补上占位——整个会话会一直 400");
    assert(tool(b) && tool(b).results[0].isError, "第二轮不补了？那这轮就 400 了");
    assert.strictEqual(said.filter((s) => s.includes("call_00_ZZZ")).length, 1, "同一条坏配对每轮都刷一行日志（用户日志里同 3 个 id 刷了 6 轮，把真问题淹了）");
    const c = repairToolPairs([
      { role: "user", content: "再来" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_99_NEW", name: "generate_image", input: {} }] },
      { role: "user", content: "嗯" },
    ]);
    assert(tool(c), "新的坏配对没补上");
    assert.strictEqual(said.filter((s) => s.includes("call_99_NEW")).length, 1, "去重去过头了：新出现的坏配对也不喊了");
  } finally { console.warn = orig; warnedLeakedPairs.clear(); }

  console.log("✅ 嵌入渠道翻车不拖垮记忆：首选渠道挂了不清空向量库（换真模型仍作废重算=负向控制）· 死渠道进程级记性（换 key/换模型/超时都会重试）· 坏配对告警按 id 只喊一次");
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
  // 取的必须是 prefs.agentCfg(config)：思考档是**按账号**存的（prefs.js），
  // 直接读 config.agent.thinking 的话，多人服务器上跑的是平台管理员选的那档，不是发起人自己选的
  assert(/thinking:\s*prefs\.agentCfg\(config\)\.thinking/.test(block), "本机引擎接管时没把 app 的思考模式设置传下去（用户要的就是这两边一致）");
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
/**
 * 首次开箱向导（真起 server.js）：
 *  - 干净的家目录：needs_setup=true、seen=false、大脑没接上、四种多媒体全 false、IM 0 个、引擎清单和搜索状态都在
 *  - 大脑没接上时 POST /api/onboarding/done 必须 400，config.json 里不许出现 onboarding（不然「跳过」就把提醒永久关掉了）
 *  - 把底层切成本机 claude-code 也算接上大脑（needs_setup=false，brain.via=engine）
 *  - done 落盘：done_at + skipped 写进 config.json；再 GET seen=true；skipped 会被清洗（超长/超量丢掉）
 *  - 静态闸门：前端五步向导、关于页重开入口、README 的命令行一节都在
 */
async function testOnboardingWizardApi() {
  const os = require("os");
  const http = require("http");
  const { spawn } = require("child_process");
  const crypto = require("crypto");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-onb-"));
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
  const cfgOnDisk = () => { try { return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")); } catch { return null; } };

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + log.slice(-400));

    // 1. 干净家目录的体检表
    const a = await req("GET", "/api/onboarding");
    assert(a.code === 200 && a.json, "体检表拿不到：HTTP " + a.code + " " + a.body.slice(0, 200));
    const st = a.json;
    assert(st.needs_setup === true && st.seen === false, "新装应当 needs_setup=true / seen=false：" + JSON.stringify({ n: st.needs_setup, s: st.seen }));
    assert(st.brain && st.brain.ok === false, "没填 Key 时 brain.ok 应为 false：" + JSON.stringify(st.brain));
    assert(Array.isArray(st.models) && st.models.length > 0 && st.models.every((m) => typeof m.has_key === "boolean" && !("api_key" in m)), "models 要带 has_key 布尔，且绝不能把 api_key 本身吐给前端");
    assert(Array.isArray(st.engines) && st.engines.some((e) => e.id === "claude-code") && st.engines.some((e) => e.id === "codex"), "引擎清单缺 claude-code / codex：" + JSON.stringify(st.engines));
    assert(st.engines.every((e) => typeof e.installed === "boolean" && typeof e.install === "string"), "每个引擎要有 installed 布尔 + install 提示");
    assert(st.search && typeof st.search.provider === "string" && st.search.has_key === false, "搜索状态：新装 has_key 应为 false：" + JSON.stringify(st.search));
    assert(st.media && ["image", "video", "tts", "vision"].every((k) => st.media[k] === false), "四种多媒体新装应全 false：" + JSON.stringify(st.media));
    assert(st.im && st.im.configured === 0, "IM 新装应 0 个：" + JSON.stringify(st.im));
    assert(typeof st.workspace_dir === "string" && st.workspace_dir, "体检表要带当前工作目录");

    // 2. 大脑没接上：done 必须拒绝，且不落 onboarding（否则跳过一次提醒就永久没了）
    const d0 = await req("POST", "/api/onboarding/done", { skipped: ["search"] });
    assert(d0.code === 400 && d0.json && /大模型/.test(d0.json.error || ""), "大脑没接上时 done 应 400 并说明原因：HTTP " + d0.code + " " + d0.body.slice(0, 200));
    const c0 = cfgOnDisk();
    assert(!c0 || !c0.onboarding, "大脑没接上时 config.json 里不该出现 onboarding");
    const a2 = await req("GET", "/api/onboarding");
    assert(a2.json.seen === false && a2.json.needs_setup === true, "被拒的 done 不能改变 seen / needs_setup");

    // 3. 本机 CLI 当大脑：切引擎后 needs_setup 翻 false，via=engine
    const e = await req("POST", "/api/settings", { agent: { engine: "claude-code" } });
    assert(e.code === 200, "切引擎失败：HTTP " + e.code + " " + e.body.slice(0, 200));
    const a3 = await req("GET", "/api/onboarding");
    assert(a3.json.needs_setup === false && a3.json.brain.ok === true && a3.json.brain.via === "engine" && a3.json.engine === "claude-code", "本机引擎应当算作大脑已接上：" + JSON.stringify({ n: a3.json.needs_setup, b: a3.json.brain, e: a3.json.engine }));
    assert(a3.json.seen === false, "只是切了引擎、还没走完向导，seen 不该变 true");

    // 4. done 落盘 + 清洗
    const ws = path.join(home, "我的工作区");
    const junk = "x".repeat(40);
    const d1 = await req("POST", "/api/onboarding/done", { skipped: ["search", "media", junk, "a", "b", "c", "d", "e", "f", "g", "h", "i"], workspace_dir: ws });
    assert(d1.code === 200 && d1.json && d1.json.ok === true, "done 应成功：HTTP " + d1.code + " " + d1.body.slice(0, 200));
    assert(d1.json.workspace_dir === ws && fs.existsSync(ws), "done 带 workspace_dir 应当切过去并把目录建出来：" + JSON.stringify(d1.json));
    const c1 = cfgOnDisk();
    assert(c1 && c1.onboarding && typeof c1.onboarding.done_at === "number" && c1.onboarding.done_at > 0, "done_at 没写进 config.json，重启又会弹");
    assert(Array.isArray(c1.onboarding.skipped) && c1.onboarding.skipped.includes("search") && c1.onboarding.skipped.includes("media"), "skipped 没落盘：" + JSON.stringify(c1.onboarding));
    assert(!c1.onboarding.skipped.includes(junk) && c1.onboarding.skipped.length <= 10, "skipped 要清洗：超长项丢掉、最多 10 个：" + JSON.stringify(c1.onboarding.skipped));
    assert(c1.agent && c1.agent.engine === "claude-code", "done 不该动别的配置（引擎选择被冲掉了）");
    const a4 = await req("GET", "/api/onboarding");
    assert(a4.json.seen === true && a4.json.needs_setup === false && a4.json.workspace_dir === ws, "走完后 seen=true、工作目录跟着变：" + JSON.stringify({ s: a4.json.seen, n: a4.json.needs_setup, w: a4.json.workspace_dir }));

    // 5. 换回内置模型且没 Key：needs_setup 又翻回 true（大脑掉了要重新提醒），但 seen 留着
    const e2 = await req("POST", "/api/settings", { agent: { engine: "builtin" } });
    assert(e2.code === 200, "切回内置失败：" + e2.body.slice(0, 200));
    const a5 = await req("GET", "/api/onboarding");
    assert(a5.json.needs_setup === true && a5.json.seen === true, "切回没 Key 的内置模型：needs_setup=true 但 seen 保留：" + JSON.stringify({ n: a5.json.needs_setup, s: a5.json.seen }));

    // 6. 未登录不给看（体检表里有渠道名、目录路径）
    const anon = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/api/onboarding" }, (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve(0));
    });
    assert(anon === 401 || anon === 403 || anon === 302, "未登录访问体检表应被拦：HTTP " + anon);

    // 静态闸门：前端向导 / 关于页重开 / README 命令行一节
    const app03 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-03.js"), "utf8");
    assert(/const ONB_STEPS = \[/.test(app03) && (app03.match(/\["(brain|search|media|im|done)"/g) || []).length === 5, "app-03.js 的向导应是五步：brain/search/media/im/done");
    assert(/async function openOnboarding\(/.test(app03) && /\/api\/onboarding\/done/.test(app03), "app-03.js 缺 openOnboarding 或没调 /api/onboarding/done");
    assert(/function onbSkipFlag\(/.test(app03) && /try \{[\s\S]*sessionStorage/.test(app03), "「本次跳过」标记要 try 住 sessionStorage（file:// / 隐私模式下会抛）");
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    assert(/id="onb-steps"/.test(html) && /id="onb-body"/.test(html) && /\.onb-steps\s*\{/.test(html), "index.html 缺向导壳子或步骤条样式");
    const app06 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-06.js"), "utf8");
    assert(/id="about-onb"/.test(app06) && /openOnboarding\(\)/.test(app06), "设置 → 关于 里缺「重新打开新手引导」");
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    assert(/## 命令行也能用/.test(readme) && /wb engines use/.test(readme) && /--json/.test(readme) && /命令行用法\.md/.test(readme), "README 缺命令行一节（wb 单发 / --json / engines use / 链到 docs）");
    const cliHelp = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
    for (const flag of ["--json", "-q", "-c", "-C", "engines use", "sessions"]) assert(cliHelp.includes(flag), "README 里写的 " + flag + " 在 cli.js 里找不到");

    console.log("✅ 首次开箱向导 API：新装体检表(不泄 Key)·大脑没接上 done 拒且不落盘·本机 CLI 算大脑·done 落 done_at+skipped 清洗+切工作目录·seen 留存 needs_setup 随大脑翻转·匿名 401 + 前端五步/关于页重开/README 命令行一节 静态闸门");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
}

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
 * 产出清单发射器：任务跑着的时候「卡不卡」有一半是它决定的。
 *
 * 事故背景（用户原话：「提高一些性能，就是问问题很快能看到回复，中间不要让我看到卡顿啊」）：
 * 以前每来一个工具结果就 outputFiles() 走一遍全树，再把整份最多 500 条的清单原样推给前端。
 * 实测用户的工作目录：一次走树 9.6ms（其中 4.7ms 是重复检测在 readFileSync 6.48 MB —— 同步读盘，
 * 那几毫秒整条事件循环是停着的），一条 files 事件的 JSON 是 47.8 KB。本机 CLI 那条路是**每个**
 * 工具结果发一次，一趟 100 步的任务 = 3.69 MB 白推 + 580ms 事件循环被同步读盘堵住。
 * 而这 100 步里真正写盘的往往只有几步 —— 搜索、读文件、列目录一个字节都不改。
 *
 * 改成「节流 + 没变就不推」之后：101 条 / 3.69 MB / 580ms → 5 条 / 0.18 MB / 7ms。
 *
 * 但省事件是有代价的：省过头就是产出不见了 —— 那正是用户前面骂过的「怎么回事都看不到产出了啊」。
 * 所以这一屏的重点全在负向对照上：真写了的、被删了的、别人文件夹里的，各自该怎样一条条钉死。
 */
async function testFilesEmitter() {
  const os = require("os");
  const tools = require("../tools");
  const { makeOwnership, makeFilesEmitter } = require("../agent");

  const prevWs = tools.getWorkspaceDir();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "owb-emit-"));
  const DIR = "任务_0910_本对话";
  fs.mkdirSync(path.join(ws, DIR), { recursive: true });
  fs.writeFileSync(path.join(ws, DIR, "旧稿.md"), "old");
  tools.setWorkspaceDir(ws);
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 每一屏都新起一个发射器 + 新账本，别让上一屏的基线漏过来
    const mk = (gapMs) => {
      const evs = [];
      const own = makeOwnership();
      own.claimBaseDir(DIR, 1);
      const e = makeFilesEmitter({ emit: (ev) => evs.push(ev), ownership: own, baseDir: DIR, runToken: 1, gapMs: gapMs === undefined ? 300 : gapMs });
      return { evs, e, own };
    };

    // ① 一屏 100 个不写盘的工具结果：只该有开头那一条（前端要一份清单打底），其余全是噪音
    {
      const { evs, e } = mk(50);
      for (let i = 0; i < 100; i++) { e.push(); await nap(1); }
      e.push(true);
      await nap(120);
      e.stop();
      assert(evs.length === 1, `盘上一个字节没动却推了 ${evs.length} 条 files 事件（每条 ~47.8KB，这就是中途卡顿的来源）`);
      assert((evs[0].changed || []).length === 0, "什么都没写，changed 却不是空的");
    }

    // ② 负向对照：真写了文件，节流只能让它晚一点，不许让它不出现
    {
      const { evs, e } = mk(80);
      e.push(true);                     // 打底那一条
      const n0 = evs.length;
      fs.writeFileSync(path.join(ws, DIR, "王某某_简历.html"), "<b>hi</b>");
      e.push();                          // 落在节流窗口里 → 这一下是尾随的
      assert(evs.length === n0, "节流没生效：紧挨着的第二次 push 立刻又走了一遍全树");
      await nap(200);
      e.stop();
      const last = evs[evs.length - 1];
      assert(evs.length === n0 + 1, `尾随那次没发出来，写出去的文件在界面上就凭空消失了（共 ${evs.length} 条）`);
      assert((last.changed || []).includes(DIR + "/王某某_简历.html"), "写出来的成品没进 changed：对话里那块「本回合产出」会一张卡都不挂");
      assert(last.files.some((f) => f.name === DIR + "/王某某_简历.html"), "清单里没有这个新文件");
    }

    // ③ 负向对照：删文件不改任何人的 mtime，changed 一定是空的 ——
    //    要是「没变就不推」只看 changed，删掉的东西就永远从右侧面板上撤不下去
    {
      fs.writeFileSync(path.join(ws, DIR, "中间稿.txt"), "tmp");
      const { evs, e } = mk(0);
      e.push(true);
      const n0 = evs.length;
      fs.unlinkSync(path.join(ws, DIR, "中间稿.txt"));
      e.push(true);
      e.stop();
      assert(evs.length === n0 + 1, "删了文件却没推新清单，右侧面板会一直挂着一个已经不存在的文件");
      assert((evs[evs.length - 1].changed || []).length === 0, "删除不该算成「本回合产出」");
      assert(!evs[evs.length - 1].files.some((f) => f.name === DIR + "/中间稿.txt"), "新清单里那个文件还在");
    }

    // ④ 负向对照：别的对话文件夹里的文件照样进不了 changed（省事件不许把归属这道关一起省掉）
    {
      const OTHER = "任务_0909_别人的";
      fs.mkdirSync(path.join(ws, OTHER), { recursive: true });
      const { evs, e, own } = mk(0);
      own.claimBaseDir(OTHER, 2); // 另一条对话先把那个文件夹认领走
      e.push(true);
      const n0 = evs.length;
      fs.writeFileSync(path.join(ws, OTHER, "别人的产出.md"), "x");
      e.push(true);
      e.stop();
      assert(evs.length === n0 + 1, "别的对话写了文件，清单该刷新（面板上要看得见），只是不该记成本回合产出");
      assert(!(evs[evs.length - 1].changed || []).includes(OTHER + "/别人的产出.md"), "别的对话正在写的文件挂到本回合产出里了");
    }

    // ⑤ stop() 之后一律闭嘴：尾随定时器要是烧到 SSE 关掉之后才响，就是往已经断掉的连接里写
    {
      const { evs, e } = mk(120);
      e.push(true);
      const n0 = evs.length;
      fs.writeFileSync(path.join(ws, DIR, "收摊后写的.md"), "late");
      e.push();       // 排了一个尾随的
      e.stop();       // 这一轮收摊
      await nap(250);
      assert(evs.length === n0, `stop() 之后还推了 ${evs.length - n0} 条事件，连接已经关了`);
    }

    // ⑥ 收尾那一下必须是同步的：push(true) 返回时事件就得在手上，不能等定时器
    {
      const { evs, e } = mk(5000); // 节流窗口故意开到 5 秒
      e.push(true);
      const n0 = evs.length;
      fs.writeFileSync(path.join(ws, DIR, "最后一份.html"), "<i>done</i>");
      e.push(true);
      e.stop();
      assert(evs.length === n0 + 1, "收尾的 push(true) 没有立刻发：任务结束了产出还没上屏");
      assert((evs[evs.length - 1].changed || []).includes(DIR + "/最后一份.html"), "收尾那一下漏了最后写出来的成品");
    }
  } finally {
    tools.setWorkspaceDir(prevWs);
    fs.rmSync(ws, { recursive: true, force: true });
  }
  console.log("✅ 产出清单发射器：不写盘就不推（100 步只 1 条）· 写了的晚一点也一定到 · 删除照推 · 别人文件夹不记账 · 收摊后闭嘴 · 收尾同步发");
}

/**
 * 两个「读盘大户」工具：搜索和读文件。它们决定任务跑到一半界面会不会突然定住。
 *
 * 事故背景（用户原话：「提高一些性能，就是问问题很快能看到回复，中间不要让我看到卡顿啊」）：
 * 这两个工具都是同步读盘的，读盘那几百毫秒里事件循环整条停着，SSE 一个字都发不出去 ——
 * 用户看到的就是回答说到一半突然卡住。实测（改之前，本仓库根目录）：
 *   · search_files 搜一个不存在的词：readFileSync 13552 次 / 196MB / 事件循环钉住 2170ms
 *   · read_file 整份读一份 48.5MB 的日志：钉住 172~188ms，堆一次涨 64~88MB
 * 改之后：搜索 12.5ms（读盘降到 64MB，二进制按扩展名直接不读了）、读文件 0.8~6ms。
 *
 * 这一屏钉的不是「快了多少」（机器不同数就不同），而是三件不许退回去的事：
 *   ① 中途真的让出了事件循环（不是把活干完了才让）；
 *   ② 省下来的读盘不能省掉正确性：行号、总行数、跨块的半个汉字，一个字都不能差；
 *   ③ 没搜完必须说「没搜完」。报「没搜到」是在骗模型——它会据此断定东西不存在，
 *      然后把后面的活全建在这个错判上。
 */
async function testHeavyTools() {
  const os = require("os");
  const tools = require("../tools");
  const { SEARCH_BUDGET } = tools._internals;

  const prevWs = tools.getWorkspaceDir();
  const budget0 = { ...SEARCH_BUDGET };
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "owb-heavy-"));
  tools.setWorkspaceDir(ws);

  // 事件循环被钉住多久：每 5ms 打一次卡看漂移。
  // stop() 必须先等一个宏任务再 clearInterval —— 不然最后那段同步阻塞刚结束定时器就被掐了，
  // 量出来永远是 0（这个坑真踩过：故意卡 180ms，量出来 1.4ms，差点当成"已经不卡了"）
  const lagMeter = () => {
    let worst = 0, last = process.hrtime.bigint();
    const t = setInterval(() => {
      const n = process.hrtime.bigint();
      const d = Number(n - last) / 1e6 - 5;
      if (d > worst) worst = d;
      last = n;
    }, 5);
    return { async stop() { await new Promise((r) => setTimeout(r, 15)); clearInterval(t); return worst; } };
  };

  try {
    // ⓪ 先验尺子本身：量不出阻塞的尺子会让下面每一条都白白通过
    {
      const m = lagMeter();
      const until = Date.now() + 150;
      while (Date.now() < until) {} // 故意钉住 150ms
      const lag = await m.stop();
      assert(lag > 100, `阴性对照：故意卡了 150ms，尺子只量出 ${lag.toFixed(1)}ms —— 尺子坏了，下面的结论一条都不算数`);
    }

    // 造一棵够大的树：600 个文本文件 + 40 个"二进制"（扩展名是 png/mp4，内容随便）
    const N_TEXT = 600;
    for (let i = 0; i < N_TEXT; i++) {
      const d = path.join(ws, "src", "mod" + (i % 20));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "f" + i + ".ts"), "// 第 " + i + " 个文件\n".repeat(400));
    }
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(ws, "src", "素材" + i + ".png"), Buffer.alloc(200 * 1024, 7));
    fs.mkdirSync(path.join(ws, ".turbo"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".turbo", "缓存.ts"), "只有构建缓存里才有的词 kZzMarker");
    fs.writeFileSync(path.join(ws, "src", "命中.ts"), "这里有 kZzMarker 一处");

    // ① 搜一个不存在的词 = 全树扫一遍：中途必须让出事件循环，而且不许碰二进制
    const realRead = fs.readFileSync;
    let readNames = [];
    fs.readFileSync = function (...a) { readNames.push(String(a[0])); return realRead.apply(fs, a); };
    let noHit, lag1, ticks = 0;
    // 阻塞毫秒数只是结果，会随机器和树的大小飘。真正要钉住的是"中途让出去过"这件事本身：
    // 一个 1ms 的定时器，在搜索跑完之前到底响了几次。不让出的话它一次都响不了
    const ticker = setInterval(() => ticks++, 1);
    try {
      const m = lagMeter();
      noHit = await tools.executeTool("search_files", { query: "绝不存在的词zzqqxx", dir: "." }, {});
      lag1 = await m.stop();
    } finally {
      clearInterval(ticker);
      fs.readFileSync = realRead;
    }
    assert(ticks >= 5, `整趟搜索期间那个 1ms 定时器只响了 ${ticks} 次 —— 等于全程霸着事件循环没撒手，攒着的 SSE 一个字都发不出去`);
    assert(/没搜到/.test(noHit.content), "没搜到就该说没搜到：" + noHit.content.slice(0, 80));
    assert(lag1 < 60, `搜一趟全树把事件循环钉住了 ${lag1.toFixed(0)}ms —— 那段时间里 SSE 一个字发不出去，界面就是定住的`);
    const touchedBin = readNames.filter((n) => /\.(png|mp4)$/i.test(n));
    assert.deepStrictEqual(touchedBin, [], `二进制被整份读进内存了（${touchedBin.length} 个）：改之前光这一项就是每次搜索白读 8MB`);
    assert(readNames.filter((n) => /\.ts$/.test(n)).length >= N_TEXT, "文本文件没扫全，搜索结果不可信");

    // ② 跳过的目录里不许出结果，没跳过的必须出（阴性对照成对）
    const hit = await tools.executeTool("search_files", { query: "kZzMarker", dir: "." }, {});
    assert(/命中\.ts/.test(hit.content), "正常目录里的命中丢了：" + hit.content.slice(0, 120));
    assert(!/\.turbo/.test(hit.content), "构建缓存目录（.turbo）里的东西被搜出来了，预算全烧在别人的产物上");

    // ③ 预算烧完 ≠ 没有。这条是这次改动最容易埋雷的地方：
    //    报「没搜到」会让模型断定东西不存在，然后把后面的活全建在这个错判上
    SEARCH_BUDGET.files = 5;
    const cut = await tools.executeTool("search_files", { query: "绝不存在的词zzqqxx", dir: "." }, {});
    SEARCH_BUDGET.files = budget0.files;
    assert(/没搜完/.test(cut.content), "预算烧完了却没说「没搜完」：" + cut.content.slice(0, 120));
    assert(!/^（没搜到/.test(cut.content), "没扫完却报「没搜到」——这是在教模型放弃：" + cut.content.slice(0, 120));
    assert(/dir|ext/.test(cut.content), "只说了停下，没说下一步怎么办（缩 dir / 限 ext），模型只会原样再搜一遍");
    // 阴性对照：预算调回来，同一棵树必须能扫完，措辞也得变回「没搜到」
    const full = await tools.executeTool("search_files", { query: "绝不存在的词zzqqxx", dir: "." }, {});
    assert(/^（没搜到/.test(full.content), "预算恢复后反而说没搜完，说明预算被永久改坏了：" + full.content.slice(0, 120));

    // ④ 大文件：整份读会把事件循环钉住（实测 48.5MB 日志 172~188ms）。
    //    这里用 6MB 就够跨过阈值，跑得也快
    const LINES = 60000;
    const big = path.join(ws, "服务日志.log");
    // 每行都塞中文：1MB 一块地读时，块边界必然切在某个汉字中间。
    // 用 buf.toString("utf8") 逐块拼就会掉出 U+FFFD，下面那条断言专门钉这个
    const line = (i) => `2026-09-10 17:00:00 订单 ${i} 支付成功，金额 128.00，渠道 微信——记账已入库`;
    fs.writeFileSync(big, Array.from({ length: LINES }, (_, i) => line(i)).join("\n") + "\n");
    const sizeMB = fs.statSync(big).size / 1048576;
    assert(sizeMB > 4, `测试文件只有 ${sizeMB.toFixed(1)}MB，没过大文件阈值，这一屏等于没测`);

    {
      const m = lagMeter();
      const r = await tools.executeTool("read_file", { path: "服务日志.log" }, {});
      const lag = await m.stop();
      assert(lag < 60, `整份读大文件把事件循环钉住了 ${lag.toFixed(0)}ms`);
      assert(r.content.startsWith(line(0)), "开头那截读错了：" + r.content.slice(0, 60));
      assert(/太大了不整份读进来/.test(r.content) && /start_line/.test(r.content), "没告诉模型这是截断的、也没说下一步怎么拿后面的：" + r.content.slice(-160));
      assert(!r.content.includes("�"), "块边界把汉字切坏了（出现了 U+FFFD 乱码）");
    }

    // ⑤ 指定行段：行号、行内容、总行数都必须跟"整份读进来再 split"的口径一模一样
    {
      const truth = fs.readFileSync(big, "utf8").split("\n"); // 测试里可以奢侈一次
      const m = lagMeter();
      const r = await tools.executeTool("read_file", { path: "服务日志.log", start_line: 59990, end_line: 60000 }, {});
      const lag = await m.stop();
      assert(lag < 60, `按行段读大文件把事件循环钉住了 ${lag.toFixed(0)}ms`);
      assert(new RegExp(`全文共 ${truth.length} 行`).test(r.content), `总行数跟整份读对不上（应为 ${truth.length}）：` + r.content.slice(0, 80));
      assert(r.content.includes(`59990\t${truth[59989]}`), "起始行的行号或内容对不上：" + r.content.slice(0, 200));
      assert(r.content.includes(`60000\t${truth[59999]}`), "结束行的行号或内容对不上");
      // 逐块 toString("utf8") 会把切在块尾的半个汉字变成乱码。找出正好横跨每个 1MB 边界的那几行，
      // 挨个跟真值比——只看有没有 U+FFFD 不够，边界碰巧落在 ASCII 上就漏过去了
      let acc = 0;
      const crossing = [];
      for (let i = 0; i < LINES; i++) {
        const before = acc;
        acc += Buffer.byteLength(line(i) + "\n");
        for (let k = 1; k * 1048576 < acc; k++) if (before < k * 1048576 && acc > k * 1048576) crossing.push(i + 1);
      }
      assert(crossing.length >= 3, `没造出跨块的行（只有 ${crossing.length} 处），这条等于没测`);
      for (const ln of crossing) {
        const one = await tools.executeTool("read_file", { path: "服务日志.log", start_line: ln, end_line: ln }, {});
        assert(one.content.includes(`${ln}\t${truth[ln - 1]}`), `横跨 1MB 块边界的第 ${ln} 行读回来变了样（多半是半个汉字被切在块尾）：` + one.content.slice(0, 200));
      }
      // 翻到头了不是失败，是"这就是结尾"这条信息本身——大小文件两条路措辞必须一致
      const past = await tools.executeTool("read_file", { path: "服务日志.log", start_line: LINES + 500 }, {});
      assert(/到头了/.test(past.content) && past.isError !== true, "翻过尾巴被当成了失败，会被循环检测记成连续失败：" + past.content.slice(0, 80));
    }

    // ⑥ 小文件不许被这条新路改掉行为：同一份内容，小文件走老路，结果要跟真值一致
    {
      fs.writeFileSync(path.join(ws, "小的.txt"), "第一行\n第二行\n第三行\n");
      const r = await tools.executeTool("read_file", { path: "小的.txt", start_line: 2, end_line: 3 }, {});
      assert(/全文共 4 行/.test(r.content), "小文件的总行数口径变了（末尾空行也算一行）：" + r.content.slice(0, 80));
      assert(r.content.includes("2\t第二行") && r.content.includes("3\t第三行"), "小文件按行读的结果不对：" + r.content.slice(0, 120));
    }

    console.log("✅ 读盘大户不再钉住界面：搜索中途让出事件循环（尺子先自检）· 二进制一个都不读 · 构建缓存目录不搜 · 没扫完说「没扫完」并给下一步 · 大文件分块读，行号/总行数/跨块汉字与整份读一字不差");
  } finally {
    SEARCH_BUDGET.files = budget0.files;
    SEARCH_BUDGET.bytes = budget0.bytes;
    SEARCH_BUDGET.ms = budget0.ms;
    tools.setWorkspaceDir(prevWs);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
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
      const mk = src.indexOf("makeFilesEmitter({", at);
      assert(mk > at, label + "（" + fn + "）里没有产出发射器了，这条路发不出 files 事件");
      const body = src.slice(at, mk + 400);
      assert(/claimBaseDir\(baseDir, runToken\)/.test(body), label + "（" + fn + "）开跑没登记自己的任务文件夹，归属就没有确定性依据了");
      // 判定实现只剩一处（makeFilesEmitter），所以这两条路要验的是「有没有把账本和本轮 runToken 交给它」：
      // 少交一个，差异出来的文件就没人判归属，别的对话正在写的东西会整批挂到这条来
      assert(/makeFilesEmitter\(\{\s*emit, ownership, baseDir, runToken/.test(body),
        label + "（" + fn + "）没把归属账本和本轮 runToken 交给产出发射器");
    }
    // 判定本身：一处实现漏了就是两条路一起漏，所以单独钉一遍
    const em = src.indexOf("function makeFilesEmitter(");
    assert(em > 0, "agent.js 里找不到 makeFilesEmitter");
    assert(/ownership\.mine\(f, baseDir, runToken\)/.test(src.slice(em, em + 3000)),
      "产出发射器没过归属判定，别的对话正在写的文件会挂到本轮来");
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

/**
 * README 门面闸门：冲 star 靠的是首屏 8 秒能看懂 + 能装上 + 有地方找人。
 *  - 中英两份 README 互相链接，且都只指向这一个仓库
 *  - 首屏三句差异（吐文件 / 不绑模型 / 一个 Markdown 一个技能）在「为什么是它」里，不许埋回功能清单
 *  - 「最新动态」每条都带日期，且日期必须是 git 里真有提交的日子——防止写着写着变成愿望清单
 *  - 交流群二维码文件真在、是 PNG、别大到把 clone 拖慢
 *  - 协议一句人话讲清「谁免费、谁要授权」并链到商业授权页
 *  - 贡献页有技能模板（frontmatter 齐全），README 的 10 分钟路径指向它
 */
function testReadmeFrontGate() {
  const root = path.join(__dirname, "..");
  const zh = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const en = fs.readFileSync(path.join(root, "README.en.md"), "utf8");
  assert(/\(README\.en\.md\)|href="README\.en\.md"/.test(zh) && /\(README\.md[)#]|href="README\.md/.test(en), "中英 README 没有互相链接");
  for (const [name, t] of [["README.md", zh], ["README.en.md", en]]) {
    const slugs = new Set([...t.matchAll(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?[/"?)\s]/g)].map((m) => m[1]));
    assert(slugs.size === 1 && slugs.has("CatCatUncle/openworkbuddy"), name + " 指向了别的仓库：" + [...slugs].join(","));
    assert(/img\.shields\.io\/github\/stars\/CatCatUncle\/openworkbuddy/.test(t), name + " 缺 Star 徽章");
  }
  // 首屏三句差异
  const why = zh.split(/^## 为什么是它\s*$/m)[1];
  assert(why, "README 缺「为什么是它」");
  const whyBody = why.split(/^## /m)[0];
  for (const kw of ["交付的是文件", "不绑任何一家模型", "加一个能力 = 丢一个 Markdown"]) assert(whyBody.includes(kw), "「为什么是它」缺：" + kw);
  const whyEn = (en.split(/^## Why this one\s*$/m)[1] || "").split(/^## /m)[0];
  for (const kw of ["Files, not chat logs", "Any model", "one Markdown file"]) assert(whyEn.includes(kw), "英文「Why this one」缺：" + kw);
  // 最新动态：日期真实
  const gitDays = new Set(require("child_process").execSync("git log --date=format:%m-%d --format=%ad", { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
  const news = (zh.split(/^## 最新动态\s*$/m)[1] || "").split(/^## /m)[0];
  const items = [...news.matchAll(/^- \*\*(\d\d-\d\d)\*\* (.+)$/gm)];
  assert(items.length >= 6, "「最新动态」至少 6 条带日期的条目，现在 " + items.length);
  for (const [, d, txt] of items) {
    assert(gitDays.has(d), "「最新动态」写了 " + d + "，git 里那天没有提交");
    assert(txt.trim().length >= 8, "「最新动态」有条目太短：" + txt);
  }
  const dates = items.map((m) => m[1]);
  assert(dates.every((d, i) => i === 0 || d <= dates[i - 1]), "「最新动态」要按时间倒序");
  const newsEn = (en.split(/^## What's new\s*$/m)[1] || "").split(/^## /m)[0];
  assert([...newsEn.matchAll(/^- \*\*[A-Z][a-z]{2} \d{1,2}\*\* /gm)].length >= 6, "英文 What's new 至少 6 条带日期条目");
  // 交流群二维码
  const qrRel = "docs/images/feishu-group.png";
  assert(zh.includes('src="' + qrRel + '"') && /^## 交流群\s*$/m.test(zh), "README 缺「交流群」一节或二维码引用");
  const qr = fs.readFileSync(path.join(root, qrRel));
  assert(qr.length > 5000 && qr.length < 1024 * 1024, "二维码文件大小离谱：" + qr.length);
  assert(qr.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "二维码不是 PNG");
  const w = qr.readUInt32BE(16), h = qr.readUInt32BE(20);
  assert(w >= 300 && h >= 300, "二维码太小扫不出来：" + w + "x" + h);
  // 协议一句人话
  const lic = (zh.split(/^## 协议\s*$/m)[1] || "").split(/^## /m)[0];
  assert(/免费/.test(lic) && /商业授权/.test(lic) && /\(COMMERCIAL-LICENSE\.md\)/.test(lic) && /\(LICENSE\)/.test(lic), "「协议」一节要一句话讲清免费/授权并链到两份协议文件");
  const licEn = (en.split(/^## License\s*$/m)[1] || "").split(/^## /m)[0];
  assert(/free/i.test(licEn) && /commercial license/i.test(licEn) && /\(COMMERCIAL-LICENSE\.md\)/.test(licEn), "英文 License 一节要讲清 free / commercial license");
  // 贡献最短路径：技能模板
  const contrib = fs.readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8");
  const tpl = (contrib.split(/^## 提交一个技能（3 分钟）\s*$/m)[1] || "").split(/^## /m)[0];
  assert(/```markdown[\s\S]*?---\s*\nname: [\w-]+\s*\ndescription: .+\n---/.test(tpl) && /skills\//.test(tpl), "CONTRIBUTING 缺带 frontmatter 的技能模板");
  assert(/CONTRIBUTING\.md#提交一个技能3-分钟/.test(zh), "README 的「10 分钟」路径没指到技能模板锚点");
  // 首屏不许把 Star 号召建立在「一个人做」上——对外自称一人做的会吓跑付费甲方。
  // 只抓"一个人 + 干活动词"这种自陈，别抓「同一个人」「一个人也能用」——
  // 以前是光看有没有「一个人」三个字，结果写生图案例说"三张里得是同一个人"就被判红了，
  // 这种误伤比漏网更烦：它会逼着人把好好的文案改拧巴
  const SOLO = /(?:我|作者|全是我)?一个人(?:做|开发|写|维护|扛|搞|撑|干|完成)|一个人的项目|独自一人(?:开发|维护)|solo dev|one[- ]person (?:team|project|shop)|single developer/i;
  assert(SOLO.test("这个项目是我一个人做的"), "「一个人做」的闸门自己失灵了：连最直白的那句都抓不住");
  assert(!SOLO.test("三张里得是同一个人，牌子上的字不能糊"), "闸门误伤「同一个人」：它管的是自称单干，不是中文里所有含「一个人」的句子");
  for (const [name, t] of [["README.md", zh], ["README.en.md", en]]) assert(!SOLO.test(t), name + " 里出现了「一个人做」式措辞");
  console.log("✅ README 门面闸门：中英互链·只指本仓库·首屏三句差异·最新动态 " + items.length + " 条日期均有真实提交且倒序·二维码 PNG " + w + "x" + h + "·协议一句人话·技能模板+锚点·无「一个人做」措辞");
}

// 「去哪拿 Key」闸门：向导和设置页每个要填 Key 的地方都得有一条直达链接，链接全 https + 新窗口。
// 写成纯函数以便下面拿变体做反向对照——闸门自己得先证明它拦得住。
function keySourcesCheck(app03, app05, toolsSrc) {
  const vm = require("vm");
  const grab = (src, head, close) => {
    const i = src.indexOf(head);
    assert(i >= 0, "源码里没有 " + head.trim());
    const j = src.indexOf(close, i);
    assert(j > i, head.trim() + " 没收尾");
    return src.slice(i + head.length, j + close.length - 1);
  };
  const KS = vm.runInNewContext("(" + grab(app03, "const KEY_SOURCES = ", "\n};") + ")");
  const presets = vm.runInNewContext("(" + grab(app05, "const CHANNEL_PRESETS = ", "\n];") + ")");
  const media = vm.runInNewContext("(" + grab(app03, "const ONB_MEDIA_PRESETS = ", "\n};") + ")");
  const problems = [];
  for (const [id, v] of Object.entries(KS)) {
    if (!v || !/^https:\/\/[^\s"']+$/.test(v.url || "")) problems.push(`${id} 的链接不是 https 直达地址`);
    if (!v || !v.name) problems.push(`${id} 没写服务商名`);
  }
  for (const c of presets.slice(1)) {
    const id = c.base || (c.provider === "anthropic" ? "anthropic" : "");
    if (!KS[id]) problems.push(`渠道预设「${c.label}」没有取 Key 链接`);
  }
  const sp = toolsSrc.match(/const SEARCH_PROVIDERS = \{([^}]*)\}/);
  assert(sp, "tools.js 里没有 SEARCH_PROVIDERS");
  const searchIds = sp[1].split(",").map((x) => x.split(":")[0].trim()).filter(Boolean);
  for (const k of searchIds) {
    if (!KS[k]) problems.push(`搜索服务商 ${k} 没有取 Key 链接`);
    if (!new RegExp('<option value="' + k + '"').test(app03)) problems.push(`向导搜索步没有 ${k} 这一项`);
    if (!new RegExp('keyLink\\("' + k + '"\\)').test(app05)) problems.push(`设置 → 搜索面板的 ${k} 没挂链接`);
  }
  const imSrcs = [...app05.matchAll(/\bsrc: "([a-z_]+)"/g)].map((m) => m[1]);
  for (const k of imSrcs) if (!KS[k]) problems.push(`IM 卡片 ${k} 指向了不存在的来源`);
  let mediaN = 0;
  for (const [kind, rows] of Object.entries(media)) for (const [nm, base, model] of rows) {
    mediaN++;
    if (!KS[base]) problems.push(`多媒体预设 ${kind}「${nm}」的地址没有取 Key 链接`);
    if (!model) problems.push(`多媒体预设 ${kind}「${nm}」没写模型名`);
  }
  if (!/class="get-key" href="\$\{esc\(src\.url\)\}" target="_blank" rel="noopener"/.test(app03)) problems.push("keyLink 没有 target=_blank + rel=noopener（桌面版靠它交给系统浏览器）");
  for (const [pane, re] of [["向导·大脑", /keyLink\(srcId\)/], ["向导·搜索", /keyLink\(sel\.value\)/], ["向导·多媒体", /keyLink\(preset\.dataset\.base\)/], ["向导·IM", /keyLink\(k, KEY_SOURCES\[k\]\.name\)/]]) {
    if (!re.test(app03)) problems.push(`${pane} 步没接 keyLink`);
  }
  for (const [pane, re] of [["设置·模型表单", /#mf-key-src"\)\.innerHTML = keyLink\(modelKeySource/], ["设置·模型列表", /未填 Key \$\{keyLink\(modelKeySource\(m\)\)\}/], ["设置·IM 卡片", /class="im-src">\$\{keyLink\(c\.src\)\}/]]) {
    if (!re.test(app05)) problems.push(`${pane} 没接 keyLink`);
  }
  return { KS, presets: presets.length - 1, searchIds, imSrcs: new Set(imSrcs).size, mediaN, problems };
}
// ================= 安装包命名 + demo 录制脚本 静态闸门 =================
// v0.1.0 那次多架构 nsis 合成一个 `-win.exe`，portable 却叫 `-win-x64.exe`，文档里写的「双击即装」指到了免安装版。
// 这里把「配置里的名字」和「四份文档里写的名字」钉在一起，任何一边改了都得同步。
function packagingCheck(cfg, docs, recorderSrc, pkgJson) {
  const problems = [];
  const nsis = (cfg.nsis || {}).artifactName || "", portable = (cfg.portable || {}).artifactName || "";
  if (!nsis.includes("win-setup")) problems.push("nsis 安装包名字里没有 win-setup（多架构合包 ${arch} 为空，名字必须自己定）");
  if (!portable.includes("${arch}") || !portable.includes("-portable")) problems.push("portable 名字没带架构+portable 后缀");
  const norm = (t) => t.replace("${arch}", "x64");
  if (norm(nsis) === norm(portable)) problems.push("nsis 和 portable 同名，打包时会互相覆盖");
  const wt = (cfg.win || {}).target || [];
  const archOf = (name) => (wt.find((t) => t.target === name) || {}).arch || [];
  for (const name of ["nsis", "portable"]) if (!archOf(name).includes("x64") || !archOf(name).includes("arm64")) problems.push(`win ${name} 没同时打 x64+arm64`);
  const macArch = ((cfg.mac || {}).target || []).flatMap((t) => t.arch || []);
  if (!macArch.includes("arm64") || !macArch.includes("x64")) problems.push("mac 没同时打 arm64+x64");
  for (const [name, text] of Object.entries(docs)) {
    if (!text.includes("win-setup.exe")) problems.push(`${name} 没写安装包 win-setup.exe`);
    if (!/win-(x64|arm64)-portable\.exe/.test(text)) problems.push(`${name} 没写免安装版 -portable.exe`);
    if (/win-(x64|arm64)\.exe/.test(text)) problems.push(`${name} 还在写旧名字 win-x64.exe / win-arm64.exe（那是免安装版，不是安装包）`);
  }
  // demo 录制脚本：隔离目录、不带 IM/MCP/工作区路径、不给真实例的 3800 端口、有 --dry 零成本模式
  if (!/OPENWORKBUDDY_HOME = home/.test(recorderSrc)) problems.push("录制脚本没把数据目录隔离到临时目录");
  if (!/out\.im = \{\}/.test(recorderSrc)) problems.push("录制脚本没清空 IM 配置（会连上用户的飞书机器人）");
  if (!/out\.mcp_servers = \[\]/.test(recorderSrc)) problems.push("录制脚本没清空 MCP 配置");
  const keep = (recorderSrc.match(/const keep = \[([^\]]*)\]/) || [, ""])[1];
  for (const bad of ["im", "workspace_dir", "mcp_servers", "projects", "security"]) if (new RegExp(`"${bad}"`).test(keep)) problems.push(`录制脚本把 ${bad} 也拷进演示目录了`);
  if (!/port: 3897/.test(recorderSrc) || /3800/.test(recorderSrc.replace(/不碰你正在用的 3800/, ""))) problems.push("录制脚本端口不该碰 3800");
  if (!/a\.dry = true/.test(recorderSrc)) problems.push("录制脚本没有 --dry 零成本模式");
  if (!/fs\.rmSync\(home, \{ recursive: true, force: true \}\)/.test(recorderSrc)) problems.push("录制脚本录完没删演示目录（里面有拷来的 Key）");
  if (!/"demo:record": "electron scripts\/record-demo\.js"/.test(pkgJson)) problems.push("package.json 没有 demo:record 脚本");
  return problems;
}
/**
 * 打包完整性闸门自己会不会过期。
 *
 * scripts/check-package-files.js 顺着 require 图爬，这部分是自动的、不会过期；
 * 但「不走 require、按路径打开」的那些资源（preload、html、被 spawn 的桥）是**手写**在
 * ASSETS 里的——跟 v0.1.1 栽的那份 files 白名单是同一种东西，同样会跟代码脱节。
 * 少一个的后果不是报错，是用户装完双击没反应。
 *
 * 所以这里反过来查：把生产代码里所有 path.join(__dirname, "...", "x.html") 这类字面量
 * 扒出来，每一个都得有着落——要么在 ASSETS 里，要么被 files 的某个通配符收进去，
 * 要么落在下面这张「就是不该进包」的名单里，且注明理由。新加一个资源忘了登记就红。
 */
function packageAssetDrift(sources, ASSETS, filesGlobs) {
  // 明确不进包的，写清楚为什么——将来有人删掉这行注释也知道不是漏了
  const DEV_ONLY = {
    "build/icon.png": "只在 !app.isPackaged 时设 Dock 图标；装机版走 .app 自己的 icns",
  };
  // 白名单三种写法：顶层通配 "*.js"（**只匹配顶层**，v0.1.1 就是栽在这个"只"字上）、
  // 子目录通配 "dir/**/*"、以及点名的单个文件。"!x" 是排除，得先看它。
  const match = (g, rel) => {
    if (g === "*.js") return !rel.includes("/") && rel.endsWith(".js");
    const m = /^([\w.-]+)\/\*\*\/\*$/.exec(g);
    return m ? rel.startsWith(m[1] + "/") : g === rel;
  };
  const globbed = (rel) =>
    !filesGlobs.some((g) => g.startsWith("!") && match(g.slice(1), rel)) &&
    filesGlobs.some((g) => !g.startsWith("!") && match(g, rel));
  const problems = [];
  let checked = 0;
  for (const [file, code] of Object.entries(sources)) {
    for (const m of code.matchAll(/path\.join\(\s*__dirname\s*,([^)]*)\)/g)) {
      const parts = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
      if (!parts.length) continue;
      const rel = path.posix.join(path.posix.dirname(file), ...parts);
      if (!/\.(js|html|json|md|png|svg|css|py|ttf)$/.test(rel)) continue;
      if (!fs.existsSync(path.join(__dirname, "..", rel))) continue; // 生成物/用户数据，不是仓库文件
      checked++;
      if (ASSETS.includes(rel) || globbed(rel) || DEV_ONLY[rel]) continue;
      problems.push(`${file} 按路径用了 ${rel}，但它既不在闸门的 ASSETS 里，也不被 files 白名单收进去`);
    }
  }
  return { problems, checked, devOnly: Object.keys(DEV_ONLY).length };
}
function testPackageAssetDrift() {
  const root = path.join(__dirname, "..");
  const gate = require(path.join(root, "scripts", "check-package-files.js"));
  const cfg = require(path.join(root, "electron-builder.config.js"));
  // 只查真会进包跑起来的那些文件，测试和脚本不算
  const sources = {};
  for (const rel of gate.walkGraph()) {
    if (!rel.endsWith(".js")) continue;
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) sources[rel.split(path.sep).join("/")] = fs.readFileSync(abs, "utf8");
  }
  const r = packageAssetDrift(sources, gate.ASSETS, cfg.files);
  assert(r.problems.length === 0, "打包资源登记漏了：\n  " + r.problems.join("\n  "));
  assert(r.checked >= 4, "扫到的按路径引用太少（" + r.checked + "），说明扫描本身失效了");
  // 反向对照：新增一个没登记的资源、把 ASSETS 抠掉一条、把 public 通配符去掉——都得被抓
  const variants = [
    // 用一个真存在、但确实没打进包的文件（docs/ 整个目录都不进包），配置一个字不改就该报
    ["新加了没登记的资源", () => packageAssetDrift({ ...sources, "server.js": sources["server.js"] + '\nrequire("fs").readFileSync(path.join(__dirname, "docs", "安装与启动.md"));' }, gate.ASSETS, cfg.files)],
    // "!electron-builder.config.js" 把它从 *.js 里排除掉了：谁在生产代码里按路径打开它，就是装完必炸
    ["引用了被 ! 排除掉的文件", () => packageAssetDrift({ ...sources, "server.js": sources["server.js"] + '\nrequire("fs").readFileSync(path.join(__dirname, "electron-builder.config.js"));' }, gate.ASSETS, cfg.files)],
    ["files 去掉 public 通配符", () => packageAssetDrift(sources, gate.ASSETS.filter((a) => !a.startsWith("public/")), cfg.files.filter((g) => g !== "public/**/*"))],
  ];
  for (const [name, run] of variants) if (!run().problems.length) throw new Error("闸门漏了这种坏法：" + name);
  console.log(`✅ 打包资源不漂移：${Object.keys(sources).length} 个源文件里 ${r.checked} 处按路径引用全有着落（${r.devOnly} 条注明了就是不进包），${variants.length} 种坏法全被抓`);
}

/**
 * 路由有没有被套进另一条路由的处理函数里。
 *
 * app.post("/x", ...) 写在另一个 app.post 的回调体里，语法完全合法，node --check 也过，
 * 但意思全变了：/x 在**有人调过外层那条接口之前**根本不存在（404）；调过一次之后，
 * 每再调一次就往 express 的路由表里多塞一份同样的处理函数，只涨不落。
 * 前端拿 404 那页 HTML 去 r.json() 会抛，一路被 .catch(() => {}) 吞掉——
 * 界面上一声不吭，表现成「这个功能有时候好使、有时候不好使」。
 *
 * /api/workspace/reset 就这么躺过一阵：点「新任务」本该把上个任务里临时切过的工作
 * 文件夹收回当前项目，结果没切过项目的人根本收不回来，产出散在别的文件夹里。
 */
function nestedRoutes(text) {
  const lines = text.split("\n");
  const START = /^(\s*)(app|router)\.(get|post|put|patch|delete|all|use)\(/;
  // 这个文件里「顶层」缩进几格，看第一条登记就知道：server.js 是 0，写在工厂函数里的是 2
  const base = ((lines.find((l) => START.test(l)) || "").match(/^\s*/) || [""])[0];
  // 一条登记可能写好几行（`guarded((req) =>` 换行接着写），所以按括号配平判断它什么时候写完，
  // 不能只看「有没有一行是 });」。字符串和行注释里的括号先抹掉再数。
  const strip = (l) => l.replace(/\\./g, "").replace(/`[^`]*`/g, "").replace(/'[^']*'/g, "")
    .replace(/"[^"]*"/g, "").replace(/\/\/.*$/, "");
  const delta = (l) => { const t = strip(l); return (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length; };
  const nameOf = (l) => (l.match(/"([^"]+)"/) || [])[1] || "(中间件)";
  const bad = [];
  let open = null, depth = 0, count = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], m = START.exec(ln);
    if (m && m[1] === base) {
      count++;
      if (open) { bad.push(`第 ${i + 1} 行 ${nameOf(ln)} 被塞在第 ${open.no} 行 ${open.name} 的处理函数里`); continue; }
      depth = delta(ln);
      if (depth > 0) open = { no: i + 1, name: nameOf(ln) };
      continue;
    }
    if (open) { depth += delta(ln); if (depth <= 0) open = null; }
  }
  return { bad, count };
}
function testNoNestedRoutes() {
  const root = path.join(__dirname, "..");
  const files = ["server.js", "account.js", "admin.js", "im.js"];
  let total = 0;
  for (const f of files) {
    const r = nestedRoutes(fs.readFileSync(path.join(root, f), "utf8"));
    assert(r.count >= 5, `${f} 只扫到 ${r.count} 条路由，说明扫描本身失效了`);
    assert(r.bad.length === 0, `${f} 有路由被套在别的路由里：\n  ` + r.bad.join("\n  "));
    total += r.count;
  }
  // 反向对照：好代码不许误报，套起来的必须抓住
  const ok = 'app.get("/a", (req, res) => {\n  res.json({});\n});\napp.post("/b", (req, res) => {\n  res.json({});\n});\n';
  assert(nestedRoutes(ok).bad.length === 0, "并排写的两条路由被误报成嵌套了");
  const nested = 'app.get("/a", (req, res) => {\n  res.json({});\napp.post("/b", (req, res) => {\n  res.json({});\n});\n});\n';
  assert(nestedRoutes(nested).bad.length === 1, "套在别人处理函数里的路由没被抓出来");
  const indented = '  router.get("/a", (req, res) => {\n    res.json({});\n  router.post("/b", (req, res) => {\n    res.json({});\n  });\n  });\n';
  assert(nestedRoutes(indented).bad.length === 1, "工厂函数里（缩进两格）套起来的没被抓出来");
  // 拿真的 server.js 复刻当初那条 bug 的形状：把一条登记塞进 /api/projects/switch 的 try 里
  const real = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const cut = 'app.post("/api/projects/switch", (req, res) => {\n  try {\n';
  assert(real.includes(cut), "server.js 里找不到当初出事的那段，反向对照得跟着改");
  const relapsed = real.replace(cut, cut + 'app.post("/api/workspace/reset", (_req, res) => {\n  res.json({ ok: true });\n});\n');
  assert(nestedRoutes(relapsed).bad.length === 1, "把真代码改回出事时的样子，闸门居然没红");
  console.log(`✅ 路由都登记在顶层：${files.length} 个文件共 ${total} 条，没有一条被塞进别人的处理函数里`);
}

function testPackagingAndDemoGate() {
  const { spawnSync } = require("child_process");
  const root = path.join(__dirname, "..");
  const cfg = require(path.join(root, "electron-builder.config.js"));
  const docFiles = { "README.md": "README.md", "README.en.md": "README.en.md", "docs/安装与启动.md": "docs/安装与启动.md", "release.yml": ".github/workflows/release.yml" };
  const docs = Object.fromEntries(Object.entries(docFiles).map(([k, f]) => [k, fs.readFileSync(path.join(root, f), "utf8")]));
  const recorder = fs.readFileSync(path.join(root, "scripts", "record-demo.js"), "utf8");
  const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const chk = spawnSync(process.execPath, ["--check", path.join(root, "scripts", "record-demo.js")], { encoding: "utf8" });
  assert(chk.status === 0, "scripts/record-demo.js 语法不过：" + chk.stderr);
  const problems = packagingCheck(cfg, docs, recorder, pkg);
  assert(problems.length === 0, "安装包命名/录制脚本闸门：\n  " + problems.join("\n  "));
  // 反向对照：把 portable 改回撞名、README 写回旧名、录制脚本把 im 拷进去——每种坏法都得被抓
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const variants = [
    ["portable 撞名", (() => { const c = clone(cfg); c.portable.artifactName = "${productName}-${version}-win-${arch}.${ext}"; c.nsis.artifactName = "${productName}-${version}-win-${arch}.${ext}"; return [c, docs, recorder]; })()],
    ["README 写回旧名", [cfg, { ...docs, "README.md": docs["README.md"].replace("win-setup.exe", "win-x64.exe") }, recorder]],
    ["录制脚本带上 im", [cfg, docs, recorder.replace('const keep = ["provider"', 'const keep = ["im", "provider"')]],
    ["录制脚本不删演示目录", [cfg, docs, recorder.replace("fs.rmSync(home, { recursive: true, force: true })", "0")]],
  ];
  for (const [name, [c, d, r]] of variants) {
    assert(c !== cfg || d !== docs || r !== recorder, "变体「" + name + "」没改动到输入，对照无效");
    if (!packagingCheck(c, d, r, pkg).length) throw new Error("闸门漏了这种坏法：" + name);
  }
  console.log(`✅ 安装包命名+demo 录制闸门：nsis=win-setup · portable=win-<arch>-portable · win/mac 双架构 · ${Object.keys(docs).length} 份文档同名 · 录制脚本隔离目录/清 IM+MCP/--dry/录完删 · ${variants.length} 种坏法全被抓`);
}

function testKeySourcesGate() {
  const pub = path.join(__dirname, "..", "public", "js");
  const app03 = fs.readFileSync(path.join(pub, "app-03.js"), "utf8");
  const app05 = fs.readFileSync(path.join(pub, "app-05.js"), "utf8");
  const toolsSrc = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
  const r = keySourcesCheck(app03, app05, toolsSrc);
  assert(r.problems.length === 0, "取 Key 链接缺口：\n  " + r.problems.join("\n  "));
  assert(r.searchIds.length >= 3 && r.imSrcs >= 4 && r.presets >= 9, "覆盖面不对：" + JSON.stringify({ search: r.searchIds.length, im: r.imSrcs, presets: r.presets }));
  // 反向对照：抠掉 tavily / 把一条改成 http / 去掉 rel=noopener，三种坏法都得被抓
  const variants = [
    ["抠掉 tavily", app03.replace(/\n  "tavily": \{[^\n]*\n/, "\n"), app05],
    ["http 链接", app03.replace('"https://app.tavily.com/home"', '"http://app.tavily.com/home"'), app05],
    ["丢 rel=noopener", app03.replace(' rel="noopener"', ""), app05],
    ["IM 卡指向不存在的来源", app03, app05.replace('src: "qq"', 'src: "qq_bot"')],
  ];
  let caught = 0;
  for (const [name, a3, a5] of variants) {
    assert(a3 !== app03 || a5 !== app05, "变体「" + name + "」没改动到源码，对照无效");
    if (keySourcesCheck(a3, a5, toolsSrc).problems.length > 0) caught++;
    else throw new Error("闸门漏了这种坏法：" + name);
  }
  console.log(`✅ 取 Key 链接闸门：${Object.keys(r.KS).length} 个来源全 https+新窗口 · 渠道预设 ${r.presets} 家全覆盖 · 搜索 ${r.searchIds.length} 家 · IM ${r.imSrcs} 类 · 多媒体预设 ${r.mediaN} 条；反向 ${caught}/${variants.length} 种坏法全被拦`);
}
function testI18n() {
  // 中英文切换：词典本身 + 覆盖率闸门 + 假 DOM 走一遍翻译/还原 + 接线闸。
  // 真浏览器里的行为（观察者、属性、跳过区）在 test/frontend.js 的 win14 里验。
  const pub = path.join(__dirname, "..", "public");
  const rd = (f) => fs.readFileSync(path.join(pub, f), "utf8");
  const I = require(path.join(pub, "js", "i18n.js"));
  const CJK = /[一-鿿]/;
  // 1. 词典体检
  const en = I.DICT.en, keys = Object.keys(en);
  assert(JSON.stringify(Object.keys(I.LANGS)) === '["zh","en"]', "LANGS 应只有 zh/en");
  assert(keys.length >= 600, "英文词典条目太少：" + keys.length);
  const badKey = keys.filter((k) => !k.trim() || k !== k.trim());
  assert(!badKey.length, "词典键带首尾空白/为空：" + JSON.stringify(badKey.slice(0, 5)));
  const untranslated = keys.filter((k) => !String(en[k]).trim() || en[k] === k || CJK.test(en[k]));
  assert(!untranslated.length, "词条译文为空/等于原文/还含中文：" + JSON.stringify(untranslated.slice(0, 5)));
  // 2. node 里没有 window：默认中文，t() 原样返回；lookup/tr 按语言查
  assert(I.getLang() === "zh" && I.t("保存") === "保存", "无浏览器环境应默认中文");
  assert(I.lookup("保存", "en") === "Save" && I.lookup("保存", "zh") === null, "lookup 查词");
  assert(I.lookup("第 12 步 · 思考规划中…", "en") === "Step 12 · thinking…", "带数字的模式句");
  assert(I.lookup("编辑技能「周报」", "en") === 'Edit skill "周报"', "模式句里的名字原样回填");
  assert(I.tr("  取消 ", "en") === "  Cancel " && I.tr("   ", "en") === "   ", "tr 保留首尾空白、纯空白不动");
  assert(I.lookup("这句词典里没有", "en") === null, "没词条应返回 null（由上层回退原文）");
  // 3. 覆盖率闸：index.html 里的中文 100%；JS 模板里的短文案 ≥ 90%
  const html = rd("index.html");
  const decode = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  // 只看用户看得见的：去掉 <style>/<script>/注释（里面的中文是给开发者看的注释，不是界面）
  const visible = html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const htmlStrs = new Set();
  for (const m of visible.matchAll(/>([^<>]*[一-鿿][^<>]*)</g)) { const t = decode(m[1]).trim(); if (t) htmlStrs.add(t); }
  for (const m of visible.matchAll(/\b(?:placeholder|title|aria-label|alt)="([^"]*[一-鿿][^"]*)"/g)) htmlStrs.add(decode(m[1]).trim());
  const covered = (t) => I.lookup(t, "en") != null;
  const missHtml = [...htmlStrs].filter((t) => !covered(t));
  assert(htmlStrs.size >= 50, "index.html 中文抓取异常：" + htmlStrs.size);
  assert(!missHtml.length, "index.html 里有中文没进词典：" + JSON.stringify(missHtml.slice(0, 8)));
  // 反向对照：往抓取集里塞一句词典没有的，闸门必须能抓到（证明闸门不是恒真）
  assert([...htmlStrs, "这句词典里没有"].filter((t) => !covered(t)).length === 1, "覆盖率闸门对漏翻不敏感");
  const jsStrs = new Set();
  for (const f of fs.readdirSync(path.join(pub, "js"))) {
    if (!/^app-0\d.*\.js$/.test(f)) continue;
    const src = rd(path.join("js", f));
    for (const m of src.matchAll(/>([^<>`${};="()\n]*[一-鿿][^<>`${};="()\n]*)</g)) { const t = m[1].trim(); if (t && t.length <= 60) jsStrs.add(t); }
  }
  const short = [...jsStrs].filter((t) => t.length <= 14), shortMiss = short.filter((t) => !covered(t));
  const all = [...jsStrs], allMiss = all.filter((t) => !covered(t));
  const pct = (a, b) => Math.round((1 - a / b) * 1000) / 10;
  assert(short.length >= 300, "JS 模板短文案抓取异常：" + short.length);
  assert(pct(shortMiss.length, short.length) >= 90, `JS 模板短文案（≤14字）英文覆盖 ${pct(shortMiss.length, short.length)}% < 90%：` + JSON.stringify(shortMiss.slice(0, 10)));
  assert(pct(allMiss.length, all.length) >= 80, `JS 模板文案（≤60字）英文覆盖 ${pct(allMiss.length, all.length)}% < 80%`);
  // 4. 假 DOM：翻译 / 跳过 / 幂等 / 还原 / 改源文后重翻
  const mkText = (v) => ({ nodeType: 3, nodeValue: v, parentNode: null });
  const mkEl = (name, attrs = {}, kids = []) => {
    const el = { nodeType: 1, nodeName: name.toUpperCase(), _a: { ...attrs }, childNodes: kids, parentNode: null,
      getAttribute(n) { return n in this._a ? this._a[n] : null; }, setAttribute(n, v) { this._a[n] = String(v); }, hasAttribute(n) { return n in this._a; } };
    for (const k of kids) k.parentNode = el;
    return el;
  };
  const save = mkText("保存"), sp = mkText(" 取消 "), preT = mkText("保存"), aT = mkText("保存"), skipT = mkText("保存"), untr = mkText("这句词典里没有");
  const typed = mkText("保存"); // 用户在输入框里打的字
  const input = mkEl("textarea", { placeholder: "搜索项目" }, [typed]);
  const rootEl = mkEl("div", {}, [mkEl("button", {}, [save]), mkEl("span", {}, [sp]), input, mkEl("pre", {}, [preT]), mkEl("div", { translate: "no" }, [aT]), mkEl("div", { "data-i18n-skip": "" }, [skipT]), mkEl("p", {}, [untr])]);
  I.apply(rootEl, "en");
  assert(save.nodeValue === "Save" && sp.nodeValue === " Cancel " && input.getAttribute("placeholder") === "Search projects", "假 DOM：文本和属性翻译");
  assert(preT.nodeValue === "保存" && aT.nodeValue === "保存" && skipT.nodeValue === "保存", "假 DOM：pre / translate=no / data-i18n-skip 跳过");
  assert(typed.nodeValue === "保存", "假 DOM：textarea 只翻 placeholder，用户打的字不能碰");
  assert(untr.nodeValue === "这句词典里没有", "假 DOM：没词条原样");
  const snap = JSON.stringify([save.nodeValue, sp.nodeValue, input._a.placeholder]);
  I.apply(rootEl, "en"); I.apply(rootEl, "en");
  assert(JSON.stringify([save.nodeValue, sp.nodeValue, input._a.placeholder]) === snap, "假 DOM：重复 apply 幂等");
  save.nodeValue = "删除"; I.apply(rootEl, "en");
  assert(save.nodeValue === "Delete", "假 DOM：源文改了要按新源文重翻");
  I.apply(rootEl, "zh");
  assert(save.nodeValue === "删除" && sp.nodeValue === " 取消 " && input._a.placeholder === "搜索项目", "假 DOM：切回中文还原到最新源文");
  I.apply(rootEl, "zh");
  assert(save.nodeValue === "删除", "假 DOM：中文模式重复 apply 不动");
  // 5. 接线闸：脚本顺序 / 内容区标记 / lang 从输入框一路到系统提示词 / 外观页与向导有开关
  const a01 = rd(path.join("js", "app-01.js")), a02 = rd(path.join("js", "app-02.js")), a03 = rd(path.join("js", "app-03.js")), a06 = rd(path.join("js", "app-06.js"));
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"), ag = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
  assert(html.indexOf('src="js/i18n.js"') > 0 && html.indexOf('src="js/i18n.js"') < html.indexOf('src="js/app-00-ui.js"'), "i18n.js 必须在 app-00-ui.js 之前加载");
  assert(/class="bubble" translate="no"/.test(a01) && /currentText\.setAttribute\("translate", "no"\)/.test(a01), "用户气泡 / AI 正文没标 translate=no（内容区会被当界面翻掉）");
  assert(/lang: typeof I18N !== "undefined" \? I18N\.getLang\(\) : "zh"/.test(a02), "聊天请求体没带 lang");
  assert(/const \{ sessionId, message, mode, regen, lang \} = req\.body/.test(srv) && /lang: lang === "en" \? "en" : "zh",/.test(srv), "服务端 /api/chat 没把 lang 传给 runTask");
  assert(/function langBlock\(lang\)/.test(ag) && /projBlock \+ langBlock\(lang\) \+ modePrompt\(mode\)/.test(ag), "agent 系统提示词没拼 langBlock");
  assert(/if \(extra\.lang\) parts\.push\(langBlock\(extra\.lang\)\)/.test(ag) && /\{ projectContext, history, lang \}/.test(ag), "本机引擎（claude/codex）的系统提示词没接 lang");
  assert(/askUser, lang \}\) \{/.test(ag) && (ag.match(/^        lang,\n/gm) || []).length === 2, "专家子任务没继承 lang");
  const fnSrc = ag.slice(ag.indexOf("function langBlock(lang) {"), ag.indexOf("\n}\n", ag.indexOf("function langBlock(lang) {")) + 3);
  const langBlock = new Function(fnSrc + "\nreturn langBlock;")();
  assert(langBlock("zh") === "" && langBlock(undefined) === "" && langBlock("xx") === "", "langBlock 只在 en 生效，其它值一律不加话");
  assert(/Reply in English/.test(langBlock("en")) && /unless the user writes to you in Chinese/.test(langBlock("en")), "英文段要说清「除非用户用中文写」");
  assert(/seg\("lang", i18n\.LANGS, i18n\.getLang\(\)/.test(a06) && /if \(k === "lang"\) \{ if \(i18n\) i18n\.setLang\(v\); \}/.test(a06), "外观页没有语言分区/点击不接 setLang");
  assert(/class="onb-lang" data-i18n-skip/.test(a03) && /i18n\.setLang\(b\.dataset\.lang\); renderOnb\(\);/.test(a03), "向导第一屏没有语言开关");
  // 头像菜单：语言快切（点即切、菜单不关、原地重画），「改名字 · 换头像」尾注已删
  assert(!/改名字 · 换头像/.test(a02) && !("改名字 · 换头像" in I.DICT.en), "头像菜单的「改名字 · 换头像」尾注该删了（词典里也别留）");
  assert(/class="um-i um-lang" data-act="lang"/.test(a02) && /class="um-seg" data-i18n-skip/.test(a02), "头像菜单没有语言快切行");
  assert(/if \(act === "lang"\) \{/.test(a02) && /if \(next !== i18n\.getLang\(\)\) i18n\.setLang\(next\);\n      openUserMenu\(\);\n      return;/.test(a02), "语言行点了没切/没原地重画/没拦住关菜单");
  assert(a02.indexOf('data-act="settings"') < a02.indexOf('data-act="lang"') && a02.indexOf('data-act="lang"') < a02.indexOf('data-act="appearance"'), "语言行要排在设置和外观之间");
  assert(/\.um-seg button\.on \{/.test(html) && /\.um-seg \{ margin-left: auto;/.test(html), "index.html 没给 .um-seg 胶囊样式/选中态");
  // 6. 过程区那一屏：一行流的动词（agent.js 的 TOOL_VERB）、轨迹条短标（app-01.js 的 TOOL_SHORT）、
  //    本机引擎那条「已启动」。这三处的中文都是运行时拼出来的，不在 index.html 里，
  //    上面的覆盖率闸门照不到——加个工具忘了补翻译，英文界面上就会冒出一行中文。逐个对照，漏一个就红。
  const vmI = require("vm");
  const grabObj = (src, head) => {
    const i = src.indexOf(head);
    assert(i >= 0, "源码里找不到 " + head);
    let d = 0, j = i + head.length;
    for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}") { d--; if (!d) break; } }
    assert(d === 0 && j < src.length, head + " 的花括号没配平");
    return vmI.runInNewContext("(" + src.slice(i + head.length, j + 1) + ")");
  };
  const agSrc = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
  const verbs = Object.values(grabObj(agSrc, "const TOOL_VERB = "));
  const shorts = Object.values(grabObj(a01, "const TOOL_SHORT = "));
  assert(verbs.length >= 20 && shorts.length >= 20, `工具动词/短标抓取异常：${verbs.length}/${shorts.length}`);
  const verbMiss = verbs.filter((v) => {
    const withObj = I.lookup(v + " 演示.md", "en"), bare = I.lookup(v, "en");
    return !withObj || !bare || CJK.test(String(withObj).replace("演示.md", "")) || CJK.test(String(bare));
  });
  assert(!verbMiss.length, "一行流的动词没翻：" + JSON.stringify(verbMiss));
  // 「🟩 node」这种本来就没中文的短标不用翻，只盯带中文的
  const shortMiss2 = shorts.filter((t) => CJK.test(t)).filter((t) => { const g = I.lookup(t, "en"); return !g || CJK.test(g); });
  assert(!shortMiss2.length, "轨迹条短标没翻：" + JSON.stringify(shortMiss2));
  // 反向对照：编一个词典里没有的动词，闸门必须抓得到（证明它不是恒真）
  assert([...verbs, "瞎编个动词"].filter((v) => !I.lookup(v + " 演示.md", "en")).length === 1, "动词闸门对漏翻不敏感");
  // 本机引擎那条状态：真源在 engines/*.js，照着它拼一条出来查
  for (const [f, sample] of [
    ["engines/claude-code.js", "本机 Claude Code 已启动（模型 claude-opus-5，102 个工具），不消耗 API 额度"],
    ["engines/codex.js", "本机 Codex 已启动（模型 gpt-5-codex），不消耗 API 额度"],
  ]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert(/已启动（模型 /.test(src), f + " 里那条「已启动」的措辞改了，i18n 的模式句要跟着改");
    const got = I.lookup(sample, "en");
    assert(got && !CJK.test(got), f + " 的引擎启动状态没翻：" + JSON.stringify(got));
    // 冷启动占位那条同理：真源也在引擎里，照着抓一条出来查（括号里那截单独显示，也得能翻）
    const boot = /emit\(\{ type: "status", starting: true, text: `(.+?)`/.exec(src);
    assert(boot, f + " 没在 spawn 前推「正在启动」——本机 CLI 冷启动那几秒界面会是空的");
    const bootEn = I.lookup(boot[1], "en");
    assert(bootEn && !CJK.test(bootEn), f + " 的冷启动占位状态没翻：" + JSON.stringify(bootEn));
    const inner = /（(.+?)）/.exec(boot[1]);
    const innerEn = inner && I.lookup(inner[1], "en");
    assert(innerEn && !CJK.test(innerEn), f + " 冷启动占位括号里那截没翻：" + JSON.stringify(innerEn));
  }
  console.log(`✅ 中英文切换：词典 ${keys.length} 条 + ${I.PATTERNS.en.length} 条模式句 · index.html 中文 ${htmlStrs.size}/${htmlStrs.size} 全覆盖（反向对照通过）· JS 模板短文案 ${short.length - shortMiss.length}/${short.length}=${pct(shortMiss.length, short.length)}%、全部 ${all.length - allMiss.length}/${all.length}=${pct(allMiss.length, all.length)}% · 假 DOM 翻译/跳过/幂等/还原 · 过程区一行流动词 ${verbs.length} 个 / 轨迹条短标 ${shorts.length} 个 / 本机引擎状态 2 条全覆盖（反向对照通过）· lang 前端→服务端→内置循环/本机引擎/专家 三路接线`);
}

// ---- #58 连接器预设目录 + 专家批量扩充 + 升级合并 + 录屏遮罩 ----
function testConnectorsAndExperts() {
  const { validateExperts, mergeBuiltinExperts } = require("../experts-lib");
  const catalogMod = require("../mcp-catalog");
  const demoMask = require("../scripts/demo-mask");
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "experts.json"), "utf8"));
  const skillNames = new Set(fs.readdirSync(path.join(__dirname, "..", "skills")).filter((d) => fs.existsSync(path.join(__dirname, "..", "skills", d, "SKILL.md"))));
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const app05 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
  const recSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "record-demo.js"), "utf8");
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // 1) experts.json 体检：技能真存在、团成员是真专家、提示词点名的技能真绑了
  const problems = validateExperts(meta, skillNames);
  assert(problems.length === 0, "experts.json 有问题：" + problems.join("；"));
  assert(meta.experts.length >= 27, "专家数不足 27：" + meta.experts.length);
  assert(meta.teams.length >= 8, "专家团不足 8：" + meta.teams.length);
  const gz = meta.experts.find((e) => e.name === "公众号编辑");
  assert(gz && gz.skills.includes("wechat-article"), "公众号编辑没绑 wechat-article（写稿→排版→推草稿箱的技能一直闲着）");
  for (const n of ["视频成片师", "小红书选题策划", "封面卡片师", "飞书助理", "技能沉淀师", "程序员", "代码审查员", "翻译校对师"]) {
    const e = meta.experts.find((x) => x.name === n);
    assert(e && e.builtin === true, `新专家「${n}」缺失或没标 builtin`);
  }
  for (const n of ["短视频出片组", "小红书全案组", "飞书交付组", "代码交付组"]) assert(meta.teams.some((t) => t.name === n), `新专家团「${n}」缺失`);
  const cats = new Set(meta.experts.map((e) => e.category));
  assert(cats.has("开发协作") && cats.has("语言沟通"), "新分类没出现：" + [...cats].join("、"));
  // 体检要真能抓错（阴性对照）
  const bad = clone(meta);
  bad.experts[0].skills = ["no-such-skill"]; bad.teams[0].members.push("不存在的人"); bad.experts.push({ ...clone(bad.experts[1]) });
  bad.experts[2].system = "先 use_skill 加载 xhs-cards 技能"; bad.experts[2].skills = [];
  const badP = validateExperts(bad, skillNames);
  assert(badP.some((x) => x.includes("no-such-skill")) && badP.some((x) => x.includes("不存在的人")) && badP.some((x) => x.includes("重名")) && badP.some((x) => x.includes("xhs-cards")),
    "体检漏抓：" + badP.join("；"));

  // 2) 升级合并：只补没见过的内置项，用户改过/删过/自建的一律不动
  const bundled = clone(meta);
  const mine = { _说明: "x", experts: clone(meta.experts.slice(0, 12)), teams: clone(meta.teams.slice(0, 4)) };
  mine.experts[0].system = "用户改过的提示词";
  mine.experts.push({ name: "我的自建专家", avatar: "🙂", category: "自定义", description: "d", system: "s", skills: [] });
  const totalBuiltin = bundled.experts.filter((e) => e.builtin).length;
  const r1 = mergeBuiltinExperts(mine, bundled);
  assert(r1.added.length === totalBuiltin - mine.experts.slice(0, 12).filter((e) => e.builtin).length, "补入数量不对：" + r1.added.length);
  assert(mine.experts[0].system === "用户改过的提示词", "用户改过的内置专家被覆盖了");
  assert(mine.experts.some((e) => e.name === "我的自建专家"), "用户自建专家丢了");
  assert(r1.addedTeams.length >= 4 && mine.teams.length === 4 + r1.addedTeams.length, "专家团没补齐：" + r1.addedTeams.join("、"));
  assert(Array.isArray(mine.seen_builtins) && mine.seen_builtins.length === totalBuiltin, "seen_builtins 没记全");
  const r2 = mergeBuiltinExperts(mine, bundled);
  assert(r2.added.length === 0 && r2.addedTeams.length === 0, "第二次合并还在加：" + r2.added.length + "/" + r2.addedTeams.length);
  // 用户删掉的内置专家不能复活；成员缺席的团不硬塞
  const del = mine.experts.find((e) => e.name === "程序员");
  mine.experts = mine.experts.filter((e) => e.name !== "程序员");
  mine.teams = mine.teams.filter((t) => t.name !== "代码交付组");
  const r3 = mergeBuiltinExperts(mine, bundled);
  assert(!mine.experts.some((e) => e.name === "程序员") && r3.added.length === 0, "用户删掉的内置专家被塞回来了");
  assert(!mine.teams.some((t) => t.name === "代码交付组"), "成员缺席的专家团被硬塞进来");
  mine.experts.push(del);
  // 老文件没 seen 字段：当前已有的当作见过，只补真正新增的；非 builtin 的包内条目不补（阴性对照）
  const old = { experts: clone(meta.experts.slice(0, 3)), teams: [] };
  const b2 = { experts: [...clone(meta.experts.slice(0, 5)), { name: "不是内置", builtin: false, system: "s", description: "d", avatar: "x", category: "c" }], teams: [] };
  const r4 = mergeBuiltinExperts(old, b2);
  assert(r4.added.length === 2 && !old.experts.some((e) => e.name === "不是内置"), "老文件首次合并不对：" + r4.added.join("、"));
  assert(serverSrc.includes("mergeBuiltinExperts(expertsMeta, bundled)") && serverSrc.includes('appPath("experts.json") !== EXPERTS_FILE'), "server.js 启动时没做打包版专家合并");
  assert(/\[专家\] 升级补入内置专家/.test(serverSrc), "合并没留痕（日志）");

  // 3) 预设目录：名字合法唯一、每条都能过后端 normalizeMcpServer、{HOME} 已替换、文档链接 https、Key 名合法
  const cat = catalogMod.catalog({ home: "/Users/tester", env: { PATH: "/usr/bin:/bin" } });
  assert(cat.items.length >= 35 && cat.categories.length >= 7, `预设太少：${cat.items.length} 条 / ${cat.categories.length} 类`);
  const normSrc = serverSrc.match(/function normalizeMcpServer\([\s\S]*?\n}\n/);
  assert(normSrc, "没找到 normalizeMcpServer");
  const normalizeMcpServer = new Function(normSrc[0] + "\nreturn normalizeMcpServer;")();
  const seen = new Set();
  for (const it of cat.items) {
    assert(/^[A-Za-z0-9_-]+$/.test(it.name) && !seen.has(it.name), "预设名不合法或重复：" + it.name); seen.add(it.name);
    assert(cat.categories.includes(it.category), `预设「${it.name}」分类不在目录里：${it.category}`);
    assert(it.label && it.desc && it.icon, `预设「${it.name}」缺 label/desc/icon`);
    assert(!it.docs || /^https:\/\//.test(it.docs), `预设「${it.name}」文档链接不是 https`);
    assert(!JSON.stringify(it.args || []).includes("{HOME}") && !String(it.url || "").includes("{HOME}"), `预设「${it.name}」{HOME} 没替换`);
    for (const k of Object.keys(it.env || {})) assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/[一-鿿]/.test(it.env[k]), `预设「${it.name}」的环境变量 ${k} 不合法`);
    const norm = normalizeMcpServer(catalogMod.resolve(it, { home: "/Users/tester", env: { PATH: "/usr/bin:/bin" } }), 0);
    assert(norm.name === it.name && (norm.transport === "stdio" ? !!norm.command : /^https:\/\//.test(norm.url)), `预设「${it.name}」过不了后端规整`);
    assert(it.needs === (it.kind === "http" ? "" : it.command.split("/").pop()) || it.needs === it.command, `预设「${it.name}」needs 不对：${it.needs}`);
    assert(typeof it.configured === "undefined", "catalog() 不该自己判断 configured（那是路由的事）");
  }
  const fsItem = cat.items.find((it) => it.name === "filesystem");
  assert(fsItem.args.includes("/Users/tester/Documents"), "{HOME} 没换成传入的 home：" + fsItem.args.join(" "));
  assert(cat.items.filter((it) => it.kind === "http").length >= 4, "远程预设不足 4 条");
  assert(cat.items.filter((it) => Object.keys(it.env || {}).length).length >= 12, "带 Key 的预设不足 12 条");
  assert(cat.items.filter((it) => ["中国常用", "地图与出行"].includes(it.category)).length >= 6, "国内常用预设不足 6 条");
  // 命令不在 PATH 上：找得到就换绝对路径，找不到保持原名（别把 npx 改成空）
  const gone = catalogMod.resolve(catalogMod.ITEMS[0], { home: "/h", env: { PATH: "/nonexistent-dir-xyz" } });
  assert(gone.command === "npx" || path.isAbsolute(gone.command), "resolve 把命令改坏了：" + gone.command);
  assert(catalogMod.findCmd("definitely-not-a-command-xyz", { PATH: "/usr/bin" }) === "", "findCmd 对不存在的命令没回空串");
  assert(catalogMod.findCmd("ls", { PATH: "/bin:/usr/bin" }) !== "", "findCmd 连 ls 都找不到");
  assert(serverSrc.includes('app.get("/api/mcp/catalog"') && serverSrc.includes("configured: configured.has(it.name)"), "缺 /api/mcp/catalog 路由或 configured 标记");

  // 4) 令牌不回前端：GET 只给 env_keys；POST 没带 env 沿用原来的（和 headers 同一套规矩）
  assert(serverSrc.includes("env_keys: Object.keys(s.env || {})") && !/\n\s*env: s\.env \|\| \{\},/.test(serverSrc), "GET /api/mcp 还在回 env 的值");
  const prev = new Map([["brave", { name: "brave", command: "npx", args: [], env: { BRAVE_API_KEY: "secret-1" } }]]);
  const kept = normalizeMcpServer({ name: "brave", command: "npx", args: ["-y", "x"] }, 0, prev);
  assert(kept.env.BRAVE_API_KEY === "secret-1", "POST 不带 env 时把原来的 Key 洗没了");
  const replaced = normalizeMcpServer({ name: "brave", command: "npx", args: [], env: { BRAVE_API_KEY: "new" } }, 0, prev);
  assert(replaced.env.BRAVE_API_KEY === "new", "POST 带 env 时没覆盖");
  const fresh = normalizeMcpServer({ name: "other", command: "npx", args: [] }, 0, prev);
  assert(Object.keys(fresh.env).length === 0, "别人的 env 串到新条目上了");
  let threw = "";
  try { normalizeMcpServer({ name: "x", command: "npx", env: { "1BAD-KEY": "v" } }, 0); } catch (e) { threw = e.message; }
  assert(/环境变量名/.test(threw), "非法环境变量名没被拦：" + threw);
  // 前端原样存回时不带 env / headers（否则会把界面上根本拿不到的值写成空）
  assert(app05.includes(": { name: sv.name, command: sv.command, args: sv.args };"), "前端 keep() 还在回传 env");
  assert(app05.includes('fetch("/api/mcp/catalog")') && app05.includes('id="mcp-env"') && app05.includes("data-pi=") && app05.includes("form.dataset.needEnv"), "前端缺预设目录 / 环境变量框 / 必填校验");
  assert(app05.includes("(sv.env_keys || []).length"), "已接入卡片没显示环境变量键名");

  // 5) 录屏遮罩：临时目录 / home / 用户名 / 主机名 / IM 的 id 都在清单里，录前自检，不拷 persona
  const pairs = demoMask.defaultPairs("/tmp/owb-demo-1", ["cli_a1b2c3d4e5", "短", 12]);
  assert(pairs[0][0].length >= pairs[pairs.length - 1][0].length, "遮罩清单没按长度降序（home 先换掉临时目录就对不上了）");
  assert(pairs.some(([a, b]) => a === "/tmp/owb-demo-1" && b === "~/OpenWorkBuddy-demo"), "临时目录不在遮罩清单里");
  assert(pairs.some(([a]) => a === os.homedir()), "home 目录不在遮罩清单里");
  assert(pairs.some(([a, b]) => a === "cli_a1b2c3d4e5" && b === "●●●●●●") && !pairs.some(([a]) => a === "短"), "额外遮罩项（bot id）没进清单或太短的没过滤");
  const script = demoMask.maskScript(pairs);
  assert(script.includes("MutationObserver") && script.includes("createTreeWalker") && script.includes("__demoMask"), "遮罩脚本缺观察者/遍历");
  assert(recSrc.includes("installMask(win, pairs)") && recSrc.includes("马赛克没生效，拒绝录制") && recSrc.includes('require("./demo-mask")'), "录屏脚本没装遮罩或没自检");
  assert(!/const keep = \[[^\]]*"persona"/.test(recSrc), "录屏还在拷 persona（用户自述常带真名）");
  assert(recSrc.includes("seedHome.extraMask") && /\}\)\(cfg\.im\)/.test(recSrc), "IM 里的 app_id / bot id 没进遮罩清单");
  console.log(`✅ 连接器预设 ${cat.items.length} 条 / ${cat.categories.length} 类，专家 ${meta.experts.length} 位 / 专家团 ${meta.teams.length} 个（体检 0 问题，阴性对照抓到 ${badP.length} 条），升级合并 +${r1.added.length} 专家 +${r1.addedTeams.length} 团、二次合并 +0，遮罩清单 ${pairs.length} 项`);
}

function testOutputArrivalStatic() {
  // 产出到了不抢版面：前端 harness 验行为，这里钉「接线」——
  // files 事件真的走 outputArrivalPlan、老的 autoPreviewNewHtml 没留尸体、chip 里没有 iframe、角标样式在、文案进了词典
  const pub = path.join(__dirname, "..", "public");
  const rd = (f) => fs.readFileSync(path.join(pub, f), "utf8");
  const a01 = rd(path.join("js", "app-01.js")), html = rd("index.html"), dict = rd(path.join("js", "i18n.js"));
  assert(!/autoPreviewNewHtml/.test(a01), "autoPreviewNewHtml 还在：产出会自动弹预览抢版面");
  const h0 = a01.indexOf('ev.type === "files"'), h1 = a01.indexOf('ev.type === "sources"');
  assert(h0 > 0 && h1 > h0, "app-01 里找不到 files 事件处理");
  const handler = a01.slice(h0, h1);
  assert(!/files-panel"\)\.classList\.add\("show"\)/.test(handler), "files 事件里还在自动把成果文件面板弹出来");
  assert(!/previewFile\(/.test(handler), "files 事件里直接调 previewFile：绕开了 outputArrivalPlan");
  assert(/applyOutputArrival\(outputArrivalPlan\(\{/.test(handler), "files 事件没走 outputArrivalPlan");
  for (const k of ["replaying: isReplaying", "otherSession: turnSid !== sessionId", 'pvOpen: pvPanel.classList.contains("show")', "pvCurrent,", 'filesOpen: document.getElementById("files-panel").classList.contains("show")']) {
    assert(handler.includes(k), "outputArrivalPlan 的输入没接上真实状态：" + k);
  }
  const c0 = a01.indexOf("function makeOutCard("), c1 = a01.indexOf("function markDupBasenames(");
  assert(c0 > 0 && c1 > c0, "找不到 makeOutCard");
  const card = a01.slice(c0, c1);
  assert(!/<iframe/.test(card), "产出 chip 里还内嵌 iframe 缩略图");
  assert(/card\.tabIndex = 0/.test(card) && !/setAttribute\("role"/.test(card), "chip 要能落焦点、但不许套 role=button");
  assert(/title="\$\{mainTx\}"/.test(card) && /title="打开所在位置"/.test(card) && /title="下载"/.test(card), "图标钮缺 title");
  const tg = a01.slice(a01.indexOf('getElementById("toggle-files").onclick'), a01.indexOf('getElementById("fp-close").onclick'));
  assert(/clearFilesBadge\(\)/.test(tg), "打开成果文件面板没清角标");
  assert(/#toggle-files \.fb-badge \{ position: absolute/.test(html) && /#toggle-files \{[^}]*position: relative/.test(html), "角标样式没了");
  assert(/\.out-grid \{ display: flex; flex-wrap: wrap/.test(html) && /\.out-card \{ [^}]*display: flex; flex-direction: column/.test(html) && /\.out-card \{ [^}]*width: 168px/.test(html), "产出卡区不是能并列的 168px 缩略栅格（卡不该占满一行、也不该退回内嵌 iframe 大预览）");
  assert(!/\.out-thumb iframe/.test(html) && !/width: 240px/.test(html.slice(html.indexOf(".out-card {"), html.indexOf(".out-card {") + 400)), "index.html 还留着大卡 / iframe 缩略图样式");
  for (const k of ['"预览"', '"点击预览"', '"点击用系统程序打开"', '"在浏览器打开"', '"打开所在位置"', '"下载"']) assert(dict.includes(k + ":"), "词典缺 " + k);
  // 录屏脚本以前靠「完成后自动弹预览」把成果亮出来；现在不弹了，得替观众点一下 chip，而且只点 app 里能预览的格式
  const rec = fs.readFileSync(path.join(__dirname, "..", "scripts", "record-demo.js"), "utf8");
  assert(/\.out-block \.out-card/.test(rec) && /c\.click\(\)/.test(rec), "录屏脚本缺「点开产出 chip」那一拍");
  assert(/html\?\|png\|jpe\?g/.test(rec) && !/pptx?\|docx?/.test(rec.slice(rec.indexOf(".out-block .out-card"), rec.indexOf(".out-block .out-card") + 300)), "录屏脚本点 chip 没限定成 app 内能预览的格式（老 Office 会拉起系统程序）");
  console.log("✅ 产出到了不抢版面（静态闸）：不自动弹预览/面板 · files 事件走 outputArrivalPlan · chip 无 iframe/无 role 套娃 · 角标样式 · 词典 6 条 · 录屏替观众点 chip");
}

/**
 * 录完 demo 自动挂 README 首屏（scripts/demo-readme.js）：
 *  - 挂在第一条 --- 分隔线之前，块结构固定；再挂一次不重复；没有分隔线不猜位置
 *  - CRLF 文件也按它自己的换行挂
 *  - wireReadmes：两份 README 都挂、第二次全部跳过、GIF 不在仓库里一个都不动
 *  - 静态闸门：record-demo.js 真录才调 wireReadmes（--dry 不挂）；两份真 README 都有分隔线锚点
 */
function testDemoReadmeWire() {
  const { wireReadme, wireReadmes, ALT } = require("../scripts/demo-readme");
  const src = "docs/images/demo.gif";
  const head = "<h1>X</h1>\n\n<p align=\"center\">\n  <b>star</b>\n</p>\n";
  const md = head + "\n---\n\n## 为什么是它\n";
  const r1 = wireReadme(md, src, ALT["README.md"]);
  assert(r1.changed === true, "首次挂没标 changed");
  const block = `<p align="center">\n  <img src="${src}" width="960" alt="${ALT["README.md"]}">\n</p>\n`;
  assert(r1.md === head + "\n" + block + "\n---\n\n## 为什么是它\n", "挂的位置/块结构不对：\n" + JSON.stringify(r1.md));
  assert(r1.md.indexOf(src) < r1.md.indexOf("\n---\n"), "demo 图没挂在第一条分隔线之前");
  const r2 = wireReadme(r1.md, src, ALT["README.md"]);
  assert(r2.changed === false && r2.reason === "already" && r2.md === r1.md, "再挂一次应原样返回");
  assert((r2.md.match(/demo\.gif/g) || []).length === 1, "重复挂了");
  const r3 = wireReadme("# no separator\n\nbody\n", src, ALT["README.md"]);
  assert(r3.changed === false && r3.reason === "no-anchor" && r3.md === "# no separator\n\nbody\n", "没有分隔线应该不动");
  const crlf = "<h1>X</h1>\r\n\r\n---\r\n\r\nbody\r\n";
  const r4 = wireReadme(crlf, src, "a");
  assert(r4.changed && !/[^\r]\n/.test(r4.md) && r4.md.includes('<p align="center">\r\n  <img src="' + src), "CRLF 文件应按 CRLF 挂：" + JSON.stringify(r4.md));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owb-readme-"));
  try {
    fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "images", "demo.gif"), "GIF89a");
    fs.writeFileSync(path.join(root, "README.md"), md);
    fs.writeFileSync(path.join(root, "README.en.md"), head + "\n---\n\n## Why\n");
    const w1 = wireReadmes(root, path.join(root, "docs", "images", "demo.gif"));
    assert.deepStrictEqual(w1, ["README.md", "README.en.md"], "两份 README 都该挂上：" + JSON.stringify(w1));
    const zh = fs.readFileSync(path.join(root, "README.md"), "utf8"), en = fs.readFileSync(path.join(root, "README.en.md"), "utf8");
    assert(zh.includes(ALT["README.md"]) && en.includes(ALT["README.en.md"]) && !en.includes(ALT["README.md"]), "中英 alt 挂串了");
    assert(zh.includes('src="docs/images/demo.gif"') && en.includes('src="docs/images/demo.gif"'), "写进 README 的应是仓库相对路径");
    const w2 = wireReadmes(root, path.join(root, "docs", "images", "demo.gif"));
    assert.deepStrictEqual(w2, [], "第二次应该全部跳过：" + JSON.stringify(w2));
    assert(fs.readFileSync(path.join(root, "README.md"), "utf8") === zh, "第二次不该改文件");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "owb-out-"));
    try {
      fs.writeFileSync(path.join(outside, "demo.gif"), "GIF89a");
      fs.writeFileSync(path.join(root, "README.md"), md);
      const w3 = wireReadmes(root, path.join(outside, "demo.gif"));
      assert.deepStrictEqual(w3, [], "GIF 不在仓库里不该挂：" + JSON.stringify(w3));
      assert(fs.readFileSync(path.join(root, "README.md"), "utf8") === md, "GIF 在仓库外却改了 README");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  const rec = fs.readFileSync(path.join(__dirname, "..", "scripts", "record-demo.js"), "utf8");
  assert(/require\("\.\/demo-readme"\)/.test(rec), "record-demo.js 没接 demo-readme");
  const call = rec.indexOf("wireReadmes(ROOT, ARGS.out)");
  assert(call > 0, "record-demo.js 没在录完后调 wireReadmes");
  assert(/if \(!ARGS\.dry\) \{\s*\n\s*const wired = wireReadmes\(ROOT, ARGS\.out\)/.test(rec), "wireReadmes 必须只在真录（非 --dry）时调");
  assert(call > rec.indexOf('log(`GIF ${ARGS.out}'), "挂 README 应在 GIF 落盘之后");
  for (const name of ["README.md", "README.en.md"]) {
    const real = fs.readFileSync(path.join(__dirname, "..", name), "utf8");
    assert(/\r?\n---\r?\n/.test(real), name + " 没有 --- 分隔线，录完 demo 挂不上首屏");
    assert(!/demo\.gif/.test(real) || fs.existsSync(path.join(__dirname, "..", "docs", "images", "demo.gif")), name + " 引用了不存在的 docs/images/demo.gif");
  }
  console.log("✅ demo 挂 README 首屏：分隔线前固定块·再挂不重复·无锚不猜·CRLF·两份都挂/第二次跳过/仓库外不动·真录才挂·真 README 有锚且不引用不存在的图");
}

/**
 * demo 录屏时长整形（scripts/demo-timing.js）：
 *  - 没超目标时长 → 一帧不动；超了 → 只压 [sent, done) 那段，打字段和结果段原速
 *  - 压完总长 ≈ 目标；干活那段至少留 5 秒；每帧不低于采样间隔
 *  - --speed 明确给了就全片倍速，不再自动整形；没有 sent/done 标记（--dry）不压
 *  - 静态闸门：record-demo.js 发送后 mark("sent")、跑完 mark("done")，writeList 收 targetSec，--target-sec 可配
 */
function testDemoTiming() {
  const { fitDurations } = require("../scripts/demo-timing");
  const iv = 167; // 6fps
  // 打字 4s（8 帧）→ 干活 60s（4 帧，每帧 15s）→ 结果停 5s（1 帧）
  const frames = []; let t = 0;
  for (let i = 0; i < 8; i++) { frames.push({ at: t, until: t + 400 }); t += 500; }
  const sent = t;
  for (let i = 0; i < 4; i++) { frames.push({ at: t, until: t + 14900 }); t += 15000; }
  const done = t;
  frames.push({ at: t, until: t + 5000 - iv });
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const base = fitDurations(frames, { interval: iv, speed: 1, targetSec: 0, sent, done });
  assert(Math.abs(base.total - 69) < 0.01 && Math.abs(base.work - 60) < 0.01, "原始总长/干活段算错：" + base.total + "/" + base.work);
  assert(base.factor === 1 && Math.abs(sum(base.durations) - 69) < 0.01, "targetSec=0 不该压");
  const under = fitDurations(frames, { interval: iv, speed: 1, targetSec: 100, sent, done });
  assert(under.factor === 1 && under.durations.every((d, i) => d === base.durations[i]), "没超目标却动了帧");
  const fit = fitDurations(frames, { interval: iv, speed: 1, targetSec: 40, sent, done });
  assert(Math.abs(sum(fit.durations) - 40) < 0.05, "压完总长应≈40s，实际 " + sum(fit.durations).toFixed(2));
  assert(fit.durations.slice(0, 8).every((d, i) => d === base.durations[i]), "打字段被动了");
  assert(fit.durations[12] === base.durations[12], "结果停留段被动了");
  assert(fit.durations.slice(8, 12).every((d) => d < 15) && Math.abs(fit.factor - 60 / 31) < 0.01, "干活段没按 60/(40-9) 压：factor=" + fit.factor);
  const tight = fitDurations(frames, { interval: iv, speed: 1, targetSec: 10, sent, done });
  assert(Math.abs(sum(tight.durations.slice(8, 12)) - 5) < 0.05, "目标太紧时干活段至少留 5 秒，实际 " + sum(tight.durations.slice(8, 12)).toFixed(2));
  const dense = []; for (let i = 0; i < 60; i++) dense.push({ at: sent + i * 200, until: sent + i * 200 + 100 });
  const floor = fitDurations([...frames.slice(0, 8), ...dense, frames[12]], { interval: iv, speed: 1, targetSec: 5, sent, done: sent + 60 * 200 });
  assert(floor.durations.slice(8, 68).every((d) => d >= iv / 1000 - 1e-9), "压后每帧不能低于采样间隔");
  const sp = fitDurations(frames, { interval: iv, speed: 2, targetSec: 40, sent, done });
  assert(sp.factor === 2 && sp.durations.every((d, i) => Math.abs(d - base.durations[i] / 2) < 1e-9), "--speed 给了应全片倍速");
  const dry = fitDurations(frames, { interval: iv, speed: 1, targetSec: 10 });
  assert(dry.factor === 1 && dry.work === 0 && Math.abs(sum(dry.durations) - 69) < 0.01, "没有 sent/done（--dry）不该压");

  const rec = fs.readFileSync(path.join(__dirname, "..", "scripts", "record-demo.js"), "utf8");
  assert(/require\("\.\/demo-timing"\)/.test(rec), "record-demo.js 没接 demo-timing");
  assert(rec.indexOf('rec.mark("sent")') > rec.indexOf("executeJavaScript(`send()`)"), "发送后没打 sent 标记");
  assert(rec.indexOf('rec.mark("done")') > rec.indexOf("助理完成") && rec.indexOf('rec.mark("done")') < rec.indexOf("点开产出 chip"), "跑完没打 done 标记（要在点 chip 之前）");
  assert(/writeList\(ARGS\.speed, ARGS\.targetSec\)/.test(rec) && /"--target-sec"/.test(rec) && /targetSec: 40/.test(rec), "writeList 没收 targetSec / --target-sec 没接 / 默认不是 40");
  assert(/fitDurations\(this\.frames, \{ interval: this\.interval, speed, targetSec, sent: this\.marks\.sent, done: this\.marks\.done \}\)/.test(rec), "writeList 没把 sent/done 标记交给 fitDurations");
  console.log("✅ demo 时长整形：没超不动·超了只压干活段≈目标·至少留 5s·不低于采样间隔·--speed 全片倍速·--dry 不压·录屏脚本 sent/done 标记+--target-sec");
}

function testLookPrefsStatic() {
  // 外观偏好（主题/皮肤/字号/字体/密度）的静态闸：前端 harness 验行为，这里钉住「接线」——
  // 目录里有这一页、头像菜单能进来、CSS 令牌一套不少、老的主题子菜单没留尸体
  const pub = path.join(__dirname, "..", "public");
  const rd = (f) => fs.readFileSync(path.join(pub, f), "utf8");
  const a02 = rd(path.join("js", "app-02.js")), a05 = rd(path.join("js", "app-05.js")), a06 = rd(path.join("js", "app-06.js")), html = rd("index.html");
  assert(/\["look", "外观", "🎨"\]/.test(a05), "设置目录里没有「外观」页");
  assert(/active === "look"\) renderLookPane\(pane\)/.test(a05), "renderSettings 没把 look 派给 renderLookPane");
  assert(/^function renderLookPane\(pane\)/m.test(a06), "app-06 没定义 renderLookPane");
  assert(/act === "appearance"\) openModal\("settings", "look"\)/.test(a02), "头像菜单的「外观」没有直达外观页");
  const cats = a05.slice(a05.indexOf("const SETTING_CATS = ["), a05.indexOf("];", a05.indexOf("const SETTING_CATS = [")));
  const rows = [...cats.matchAll(/\["([a-z]+)", "([^"]+)", "([^"]+)"\]/g)];
  assert(rows.length === 12 && rows.every((m) => m[3].length && m[2].length <= 4), "设置目录每项都要 [id, ≤4字短名, 图标] 三元组，现在：" + rows.length + " 项");
  assert(/\$\{cats\.map\(\(\[k, label, icon\]\)/.test(a05) && /class="ci">\$\{icon\}/.test(a05), "左栏没把图标画出来");
  // 画的是过滤后的 cats，不是整张 SETTING_CATS：多人服务器上普通成员看不到那四个纯服务器级的标签页
  assert(/const cats = s\.platform_owner \? SETTING_CATS : SETTING_CATS\.filter/.test(a05), "左栏没按 platform_owner 过滤");
  for (const f of fs.readdirSync(path.join(pub, "js"))) {
    if (!f.endsWith(".js")) continue;
    assert(!/um-theme|um-opt/.test(rd(path.join("js", f))), "老的头像菜单主题子菜单还留在 " + f + " 里");
  }
  // 存储层：读写都要 try 包住（file:// / 隐私模式 / data: 页面会抛 SecurityError），且内存兜底
  const look = a02.slice(a02.indexOf("// ---------- 外观：主题"), a02.indexOf("// ---------- 头像菜单"));
  assert(/function lookRead\(k\) \{ try \{/.test(look) && /function lookWrite\(k, v\) \{ lookMem\[k\] = v; try \{/.test(look), "lookRead/lookWrite 没有 try + 内存兜底");
  assert(!/[^.]localStorage\.(get|set)Item\("wb-theme"/.test(look), "主题还在直连 localStorage，绕过了兜底层");
  assert(/^applyLook\(\);$/m.test(look) && /^applyTheme\(\);$/m.test(look), "外观/主题没有在脚本加载时立刻应用（会先闪一下默认样式）");
  // CSS：字号四档 + 五套皮肤各带浅/暗两块 + 密度规则 + body 走变量
  for (const [k, px] of [["s", 14], ["l", 16], ["xl", 18]]) assert(html.includes(`html[data-fs="${k}"] { --wb-fs: ${px}px; }`), "字号档 " + k + " 缺了");
  assert(/:root \{ --wb-fs: 15px; \}/.test(html), "默认字号变量 --wb-fs 没定义");
  assert(/body \{[^}]*font-size: var\(--wb-fs\)/.test(html) && /body \{[^}]*font-family: var\(--font-sans\)/.test(html), "body 字号/字体没接到变量上");
  for (const skin of ["ocean", "forest", "sunset", "rose", "graphite"]) {
    const light = html.match(new RegExp(`^  html\\[data-skin="${skin}"\\] \\{([^}]*)\\}`, "m"));
    const dark = html.match(new RegExp(`^  html\\[data-theme="dark"\\]\\[data-skin="${skin}"\\] \\{([^}]*)\\}`, "m"));
    assert(light && dark, "皮肤 " + skin + " 缺浅色或暗色块");
    for (const t of ["--primary", "--ring", "--ring-weak", "--brand-text", "--wb-brand-on-white", "--wb-brand-grad"]) assert(light[1].includes(t + ":"), "皮肤 " + skin + " 浅色块缺 " + t);
    for (const t of ["--ring", "--ring-weak", "--brand-text"]) assert(dark[1].includes(t + ":"), "皮肤 " + skin + " 暗色块缺 " + t + "（暗底上浅色的字色/描边会看不清）");
  }
  assert((html.match(/^  html\[data-density="compact"\] /gm) || []).length >= 5, "紧凑密度至少要收 5 处间距");
  assert(/html\[data-font="serif"\] \{ --font-sans:/.test(html) && /html\[data-font="mono"\] \{ --font-sans: var\(--font-mono\); \}/.test(html), "字体三选缺规则");
  // 字号联动：这些尺寸不能再写死 px，否则调字号只有正文在动
  // 前缀带换行+两空格：只认顶层规则，别撞上 html[data-density="compact"] .hist-item 那条
  for (const sel of ["\n  .a-text h1 {", "\n  .a-text h2 {", "\n  textarea#input { width", "\n  .hist-item { padding"]) {
    const i = html.indexOf(sel); assert(i > 0, "找不到 " + sel);
    const rule = html.slice(i, html.indexOf("}", i));
    assert(/var\(--wb-fs\)/.test(rule), sel + " 的字号还写死 px，没跟 --wb-fs 联动");
  }
  assert(/## 跑起来[\s\S]*外观[\s\S]*## 配模型/.test(fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")), "README「跑起来」一节没提外观设置");
  console.log("✅ 外观偏好静态闸（目录含外观页·头像菜单直达·存储 try+内存兜底·字号 4 档联动·5 皮肤×浅暗令牌齐全·密度≥5 处·字体三选·旧主题子菜单已清）");
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

/**
 * 本机 claude/codex 接管时，系统提示词必须跟内置引擎带一样的上下文。
 *
 * 用户的原话：「底层是 claude code 和 codex 的时候好像跟之前的记忆连接不上」「不能用我这个
 * openworkbuddy 的一些工具和技能和读取文件」。根因不是 CLI 记性差：engineSystemPrompt 以前
 * 只有"你是谁 / 工作目录 / 模式"三句，个性化偏好、自进化规则、长期记忆、项目指令一块都没带，
 * runTask 的引擎分支连 projectContext 都没往下传。这里用假引擎截住送出去的提示词逐块对账，
 * 并带负对照：没配的块不许凭空出现（否则"记忆"标题下面是空的，模型会当成"没有记忆"这一事实）。
 */
/**
 * 本机 CLI 引擎（claude / codex）被强制收尾时，得跟内置引擎一样把话说出来。
 *
 * 内置引擎撞上限会做两件事：发一个 limit 事件、并把「⚠️ …任务强制收尾」写进正文。
 * runViaEngine 这条路以前两件都不做，只把 stopped 塞在返回值里——于是谁忘了接这个返回值，
 * 谁那边就把半截活儿显示成干完了。IM 就是这么把「跑满 25 步被掐掉」当成一条正常回复
 * 发到用户手机上的（im.js 里那句 `const { finalText } = await runtime.runTask(...)`）。
 * 现在补在源头，所有调用方（Web / IM / 定时任务 / 命令行）都不用各自记得去接。
 *
 * 带足反向对照：正常跑完的任务不许平白多出这半句，也不许多发 limit 事件。
 */
async function testEngineStoppedSurfacing() {
  const engines = require("../engines");
  const { judgeRun } = require("../task-verdict");

  let scripted = { finalText: "", stopped: null };
  const probe = {
    id: "e2e-stop", label: "收尾探针", bin: null, note: "", install: "", launchHeader: "", supportsResume: false,
    async detect() { return { id: "e2e-stop", installed: true, path: "", version: "0" }; },
    async run() { return { finalText: scripted.finalText, usage: {}, stopped: scripted.stopped, sessionId: null }; },
  };
  engines.BACKENDS.push(probe);
  const rt = createAgentRuntime({
    config: { ...config, agent: { ...config.agent, engine: "e2e-stop" } },
    llm: makeFakeLLM(), mcpManager: new McpManager(), experts: [],
  });
  const run = async (finalText, stopped) => {
    scripted = { finalText, stopped };
    const evs = [], history = [{ role: "user", content: "把这活干完" }];
    const r = await rt.runTask({ history, emit: (e) => evs.push(e) });
    return { r, evs, history, limits: evs.filter((e) => e.type === "limit") };
  };

  try {
    // ① 撞步数上限，正文只剩半句过程叙述——这正是最坑人的形状
    const A = await run("我先看一下这个文件", "已达最大步数（25 步）");
    assert(A.r.finalText.includes("已达最大步数（25 步）"),
      "CLI 引擎撞上限，正文里一个字都没提，用户看到的就是一条正常回复：" + A.r.finalText);
    assert(A.r.finalText.includes("⚠️") && A.r.finalText.includes("任务强制收尾"),
      "收尾提示的措辞跟内置引擎对不上：" + A.r.finalText);
    assert(A.r.finalText.startsWith("我先看一下这个文件"), "模型原话被吃掉了：" + A.r.finalText);
    assert.strictEqual(A.limits.length, 1, "limit 事件没发或发重了：" + A.limits.length);
    assert.strictEqual(A.limits[0].note, "已达最大步数（25 步）", "limit 事件里的原因不对：" + A.limits[0].note);
    assert.strictEqual(A.r.stopped, "已达最大步数（25 步）", "返回值里的 stopped 不能因为补了正文就丢掉");
    // 存进 history 的是模型原话，不带这半句——跟内置引擎一致，续跑时不会把提示语当成模型说过的话
    const last = A.history[A.history.length - 1];
    assert.strictEqual(last.content, "我先看一下这个文件", "history 里混进了收尾提示：" + last.content);

    // ② IM 那句 `finalText || "任务已执行完成。"`：正文为空 + 被掐掉，是最容易报成「干完了」的一种
    const B = await run("", "已达最大运行时间");
    assert(B.r.finalText, "正文空 + 被强制收尾，返回的还是空串——IM 会兜底成「任务已执行完成。」");
    const imOut = B.r.finalText || "任务已执行完成。"; // im.js 里原样这么写的
    assert(imOut !== "任务已执行完成。" && imOut.includes("已达最大运行时间"),
      "IM 会把一个被掐掉的任务发成「任务已执行完成。」：" + imOut);

    // ③ 手动停止也照说，且判定层认得出来（假绿裁定靠的就是这个字段）
    const C = await run("停在这儿了", "已手动停止");
    assert(C.r.finalText.includes("已手动停止"), "手动停止没写进正文：" + C.r.finalText);
    assert.strictEqual(judgeRun({ result: C.r.finalText, stopped: C.r.stopped }).reason, "stopped",
      "task-verdict 认不出这是手动停止");

    // ④ 反向对照：正常跑完的任务，一个字都不许多，也不许多发事件
    const D = await run("做完了，报告在 报告.md", null);
    assert.strictEqual(D.r.finalText, "做完了，报告在 报告.md", "正常跑完却被加了料：" + D.r.finalText);
    assert.strictEqual(D.limits.length, 0, "正常跑完还发 limit 事件：" + D.limits.length);
    assert.strictEqual(D.r.stopped, null, "正常跑完 stopped 应该是 null：" + D.r.stopped);
    assert(judgeRun({ result: D.r.finalText, stopped: D.r.stopped }).ok, "正常跑完被判成没干完");

    // ⑤ 反向对照：正文空 + 没被掐掉，仍然走 IM 那句兜底（别为了修上面那条把这条也改了）
    const E = await run("", null);
    assert.strictEqual(E.r.finalText || "任务已执行完成。", "任务已执行完成。", "把正常的空正文也加了料");
    assert.strictEqual(E.limits.length, 0, "正常的空正文还发 limit 事件");
  } finally {
    engines.BACKENDS.splice(engines.BACKENDS.indexOf(probe), 1);
    try { fs.rmSync(path.join(getWorkspaceDir(), "e2e-stop-会话"), { recursive: true, force: true }); } catch {}
  }
  console.log("✅ CLI 引擎强制收尾：撞上限/超时/手停都写进正文并发 limit 事件（IM 不再把半截活儿报成干完了）· 正常跑完一个字不多");
}

async function testEngineContextParity() {
  const engines = require("../engines");
  const memory = require("../memory");
  const evolve = require("../evolve");
  const cc = require("../engines/claude-code");
  const { probeHelp } = require("../engines/jsonl");
  const { SKILLS_DIR, loadSkills } = require("../skills");

  let seen = null;
  const probe = {
    id: "e2e-ctx", label: "上下文探针", bin: null, note: "", install: "", launchHeader: "", supportsResume: false,
    async detect() { return { id: "e2e-ctx", installed: true, path: "", version: "0" }; },
    async run(o) { seen = o; return { finalText: "好", usage: {}, stopped: null, sessionId: null }; },
  };
  engines.BACKENDS.push(probe);
  const origMem = memory.promptBlock, origEv = evolve.promptBlock;
  const memCalls = [];
  const MEM = "\n\n## 长期记忆（跨任务保留，优先级高于你的默认习惯）\n- 用户叫阿测，交付一律用深色主题";
  const EV = "\n\n## 从过往任务里学到的（自进化规则，1 条）\n- 别在交付里写「请你自己把图放进去」";
  try {
    memory.promptBlock = async (user, hint) => { memCalls.push({ user, hint }); return user === "e2e-u" ? MEM : ""; };
    evolve.promptBlock = () => EV;
    const mk = (persona) => createAgentRuntime({
      config: { ...config, persona, agent: { ...config.agent, engine: "e2e-ctx" } },
      llm: makeFakeLLM(), mcpManager: new McpManager(), experts: [],
    });
    const longMsg = "把上周的周报改成深色主题" + "。".repeat(600);

    // ① 全配上：四块都得在，顺序跟内置一致（偏好 → 规则 → 记忆 → 项目）
    await mk("回复末尾带一个🐾").runTask({
      history: [{ role: "user", content: longMsg }], emit: () => {}, user: "e2e-u", baseDir: "e2e-ctx-会话",
      projectContext: "本项目一律用 pnpm，不许 npm install",
    });
    assert(seen && typeof seen.systemPrompt === "string", "假引擎没收到 systemPrompt");
    const sp = seen.systemPrompt;
    const at = (s) => { const i = sp.indexOf(s); assert(i >= 0, `引擎提示词里没有：${s}\n---\n${sp.slice(0, 1200)}`); return i; };
    const iPersona = at("## 用户的个性化偏好"); at("回复末尾带一个🐾");
    const iEv = at("## 从过往任务里学到的"); at("别在交付里写「请你自己把图放进去」");
    const iMem = at("## 长期记忆"); at("用户叫阿测");
    const iProj = at("## 当前项目的背景与规范"); at("不许 npm install");
    assert(iPersona < iEv && iEv < iMem && iMem < iProj, `四块顺序跟内置引擎不一致：persona@${iPersona} evolve@${iEv} memory@${iMem} project@${iProj}`);
    // 记忆按账号取、按最后一条用户消息前 500 字召回——跟 runTask 内置分支同一口径
    assert.strictEqual(memCalls.length, 1, "memory.promptBlock 调用次数不对：" + memCalls.length);
    assert.strictEqual(memCalls[0].user, "e2e-u", "记忆没按当前用户取");
    assert.strictEqual(memCalls[0].hint, longMsg.slice(0, 500), "记忆召回线索不是最后一条用户消息的前 500 字");
    // 原来那三句不能丢
    at("你在为 OpenWorkBuddy 干活"); at("全程用中文回复");
    // 技能索引：装了技能就得点名 + 说清怎么读正文；工作区根目录要告诉它可以读
    let n = 0; try { n = loadSkills().length; } catch {}
    if (n > 0) { at("## 你会的技能"); assert(/library_read|skill\.md/.test(sp), "技能索引没说怎么读正文"); }
    else assert(!sp.includes("## 你会的技能"), "没装技能却出现了技能标题");
    // 带 baseDir 时 cwd 是子目录，根目录只会出现在"可读范围"那句里——工作目录那句不算数
    const root = getWorkspaceDir();
    assert(sp.includes(root + " 下是用户在 OpenWorkBuddy 里所有对话的产出和资料"), "没告诉引擎工作区根目录可读：" + root);
    assert(sp.includes("新文件只写在本次工作目录里"), "没说清写只写本次工作目录");
    // claude 的 --add-dir 名单：工作区根 + 技能库
    assert(Array.isArray(seen.addDirs) && seen.addDirs.includes(root) && seen.addDirs.includes(SKILLS_DIR),
      "addDirs 没带工作区根和技能库：" + JSON.stringify(seen.addDirs));

    // ② 负对照：什么都没配 → 这几块一个都不许出现（空标题会让模型把"没有记忆"当事实）
    seen = null; memCalls.length = 0;
    evolve.promptBlock = () => "";
    await mk("").runTask({ history: [{ role: "user", content: "你是？" }], emit: () => {}, user: "nobody" });
    const sp2 = seen.systemPrompt;
    for (const h of ["## 用户的个性化偏好", "## 从过往任务里学到的", "## 长期记忆", "## 当前项目的背景与规范"])
      assert(!sp2.includes(h), "没配却出现了：" + h);
    assert.strictEqual(memCalls[0].hint, "你是？", "短消息的召回线索应该就是原文");
    at.call(null, "你在为 OpenWorkBuddy 干活"); // 基础三句仍在

    // ③ 记忆/规则模块炸了不许把任务拖死（跟内置分支同样的容错）
    seen = null;
    memory.promptBlock = async () => { throw new Error("磁盘炸了"); };
    evolve.promptBlock = () => { throw new Error("规则目录读不了"); };
    await mk("").runTask({ history: [{ role: "user", content: "hi" }], emit: () => {}, user: "e2e-u" });
    assert(seen && seen.systemPrompt.includes("你在为 OpenWorkBuddy 干活"), "记忆模块抛错把整趟任务拖死了");
  } finally {
    memory.promptBlock = origMem; evolve.promptBlock = origEv;
    engines.BACKENDS.splice(engines.BACKENDS.indexOf(probe), 1);
    // runViaEngine 会把会话子目录 mkdir 出来；main 末尾的清理只删文件不删目录，这里自己收
    try { fs.rmSync(path.join(getWorkspaceDir(), "e2e-ctx-会话"), { recursive: true, force: true }); } catch {}
  }

  // ④ --add-dir 名单的过滤：不存在的目录不发（claude 会直接报错退出）、cwd 本身不发、去重、非目录不发
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-adddir-"));
  const a = path.join(tmp, "a"), b = path.join(tmp, "b"), f = path.join(tmp, "f.txt");
  fs.mkdirSync(a); fs.mkdirSync(b); fs.writeFileSync(f, "x");
  const picked = cc.pickAddDirs([a, path.join(tmp, "missing"), a, b, f, "", null, tmp + "/a/../a"], b);
  assert.deepStrictEqual(picked.map((p) => path.basename(p)), ["a"], "pickAddDirs 过滤不对：" + JSON.stringify(picked));
  assert.deepStrictEqual(cc.pickAddDirs([], b), [], "空名单要返回空");

  // ⑤ --help 探测：印了选项名才算认。--add-dir 给假目录也 exit 0，probeOption 那套假值法判不出来
  const yes = path.join(tmp, "yes.sh"), no = path.join(tmp, "no.sh");
  fs.writeFileSync(yes, "#!/bin/sh\necho 'Usage: x [options]\n  --add-dir <directories...>  Additional directories'\n"); fs.chmodSync(yes, 0o755);
  fs.writeFileSync(no, "#!/bin/sh\necho 'Usage: x [options]\n  --model <m>'\n"); fs.chmodSync(no, 0o755);
  assert.strictEqual(await probeHelp(yes, "--add-dir"), true, "help 里有 --add-dir 却判成不认");
  assert.strictEqual(await probeHelp(no, "--add-dir"), false, "help 里没有 --add-dir 却判成认（发出去会被静默吞掉）");
  assert.strictEqual(await probeHelp(path.join(tmp, "nope"), "--add-dir"), false, "可执行文件不存在也要判 false，不能抛");
  fs.rmSync(tmp, { recursive: true, force: true });

  // ⑥ 设置页：每个引擎自己的模型候选 + 思考/effort 档位要能存、能回显
  const idx = fs.readFileSync(path.join(__dirname, "..", "engines", "index.js"), "utf8");
  assert(/thinking:\s*\(overrides\[b\.id\]\s*\|\|\s*\{\}\)\.thinking/.test(idx), "detectAll 没把 engine_options[id].thinking 回显给前端");
  assert(/models:\s*b\.models/.test(idx), "detectAll 没把模型候选带给前端");
  for (const id of ["claude-code", "codex"]) {
    const be = engines.get(id);
    assert(Array.isArray(be.models) && be.models.length >= 3, id + " 没给模型候选");
    assert(be.thinkingLabel, id + " 没给思考档位的标签（codex 叫 effort，claude 只有开关，界面不能一概叫「思考」）");
  }
  const ui = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-05.js"), "utf8");
  assert(ui.includes('data-k="thinking"'), "引擎卡片没有思考/effort 下拉");
  assert(/querySelectorAll\("input\[data-k\],select\[data-k\]"\)/.test(ui), "保存时没读 select，下拉选了也存不进去");
  assert(/list="\$\{listId\}"/.test(ui) && ui.includes("<datalist"), "模型输入框没挂候选列表");
  const lv = ui.match(/ENGINE_THINK_LEVELS = \[([\s\S]*?)\];/);
  assert(lv, "找不到档位表");
  const vals = [...lv[1].matchAll(/\["([a-z]*)"/g)].map((m) => m[1]);
  const TL = require("../thinking").LEVELS;
  assert.deepStrictEqual(vals, ["", ...TL], "前端档位表跟 thinking.LEVELS 对不上：" + JSON.stringify(vals) + " vs " + JSON.stringify(TL));
  console.log("  ✓ 本机引擎接管时提示词带齐偏好/规则/记忆/项目指令/技能索引；--add-dir 过滤与探测；设置页模型候选+思考档");
}

/**
 * 「缓存命中 3209%」+ 👍👎 反馈闭环 + 轨迹条时间戳。
 *
 * 那个百分比是两处口径撞出来的：claude-code 引擎照 Anthropic 的 input_tokens 记「输入」（不含缓存读），
 * 界面拿 cached ÷ prompt 算命中率，30000 ÷ 934 就成了 3209%；同时账本把引擎跑的那几笔记在设置页
 * 选的云模型名下（deepseek-chat），健康统计和失败连击也算错了人。这里把三层都钉死：
 *   ① 引擎层：prompt 必须把缓存读加回来（跟 llm.js 同口径），cached ≤ prompt；
 *   ② 账本层：老流水读出来时修口径（不改文件），新流水写盘前先修；归属按真跑的引擎记；
 *   ③ 反馈层：👍👎 带上模型/模式/步数落库，汇总接口按模型、模式、天数数得对，
 *      👎 的理由进自进化信号，规则打分时把生效后的 👍👎 一并摆出来。
 * 每一条都配负对照：没反馈时 upRate 是 null 不是 0；窗口外的记录不算；改判不重复计数。
 */
async function testFeedbackAndUsage() {
  const { spawnSync } = require("child_process");
  const os = require("os");

  // ① 引擎用量口径：假 claude 吐一条 result，usage 照 Anthropic 口径给
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-fbu-"));
  const fake = path.join(home, "fakeclaude");
  fs.writeFileSync(fake, [
    "#!/usr/bin/env node",
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 30000, output_tokens: 50 } }) + String.fromCharCode(10));',
  ].join("\n"));
  fs.chmodSync(fake, 0o755);
  const r1 = await require("../engines/claude-code").run({ prompt: "hi", cwd: home, bin: fake });
  assert.strictEqual(r1.usage.prompt, 31200, "claude-code 的 prompt 没把缓存读/缓存写加回来：" + JSON.stringify(r1.usage));
  assert.strictEqual(r1.usage.cached, 30000, "cached 没记：" + JSON.stringify(r1.usage));
  assert.strictEqual(r1.usage.completion, 50, "completion 不对：" + JSON.stringify(r1.usage));
  assert(r1.usage.cached <= r1.usage.prompt, "cached 大于 prompt，界面又会算出 3209%");
  fs.rmSync(home, { recursive: true, force: true });

  // ② 账本 + ③ 反馈：各起一个子进程，WB_DATA_DIR 指到临时目录，不碰真账本
  const run = (script, tag) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fbu-"));
    const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, WB_DATA_DIR: dir }, encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(r.status, 0, tag + "测试失败：\n" + (r.stderr || r.stdout));
  };

  run(`
    const assert = require("assert");
    const acc = require(${JSON.stringify(path.join(__dirname, "..", "account.js"))});
    const { register, loadUsers, loadUsage, saveUsage } = acc._internals;
    // 老口径的一笔：cached > prompt → prompt 补成 prompt+cached；正常的一笔原样返回（同一个对象）
    assert.deepStrictEqual(acc.fixLegacyCache({ prompt: 1000, cached: 30000, completion: 5 }), { prompt: 31000, cached: 30000, completion: 5 }, "老口径没修");
    const same = { prompt: 5000, cached: 5000 };
    assert.strictEqual(acc.fixLegacyCache(same), same, "cached == prompt 是正常账，不该动");
    const normal = { prompt: 31200, cached: 30000 };
    assert.strictEqual(acc.fixLegacyCache(normal), normal, "正常账被改了");
    const noCache = { prompt: 100 };
    assert.strictEqual(acc.fixLegacyCache(noCache), noCache, "没 cached 字段的老流水不该动");
    assert.strictEqual(acc.fixLegacyCache(null), null, "空值要原样返回");
    // 写盘前先修：引擎那边漏了口径，账本也不能把 3209% 记进文件
    const u = register("口径", "pw123456");
    acc.chargeRun(u, { prompt: 1000, cached: 30000, completion: 50, calls: 1, source: "web", model: "claude-code", provider: "claude-code" });
    const flow = loadUsage();
    assert.strictEqual(flow[0].prompt, 31000, "账本写盘前没修口径：" + flow[0].prompt);
    assert.strictEqual(flow[0].cached, 30000, "cached 丢了");
    assert.strictEqual(flow[0].provider, "claude-code", "归属没记成真跑的引擎");
    assert.strictEqual(flow[0].model, "claude-code", "模型名没记成引擎");
    // 读出来时修：直接往文件里塞一笔老账（模拟修之前留下的 4 笔），汇总不许再出 100% 以上
    saveUsage([{ ts: new Date().toISOString(), day: flow[0].day, kind: "run", user: "口径", source: "web", prompt: 934, cached: 30000, completion: 10, calls: 1, credits: 0 }, ...flow]);
    const sum = acc.usageSummary(loadUsers().users[0]);
    assert.strictEqual(sum.today.cached, 60000, "汇总 cached 不对：" + sum.today.cached);
    assert.strictEqual(sum.today.cachedOf, 30934 + 31000, "老账读出来没修口径，命中率分母还是 934：" + sum.today.cachedOf);
    assert(sum.today.cached <= sum.today.cachedOf, "汇总里 cached 超过分母，界面又是 100% 以上");
    // 文件本身不许被回填改写（只读时修，回填是另一回事、要先 dry run）
    const raw = loadUsage();
    assert.strictEqual(raw[0].prompt, 934, "usageSummary 顺手改写了账本文件");
    console.log("OK");
  `, "账本口径");

  run(`
    const assert = require("assert");
    const fs = require("fs");
    const path = require("path");
    const ev = require(${JSON.stringify(path.join(__dirname, "..", "evolve.js"))});
    const DATA = process.env.WB_DATA_DIR;
    fs.mkdirSync(path.join(DATA, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(DATA, "learned"), { recursive: true });
    const NOW = Date.now();

    // 一条都没有：总数 0、好评率 null（没人点过 ≠ 没人满意）
    const empty = ev.feedbackSummary({ days: 30, now: NOW });
    assert.strictEqual(empty.total, 0);
    assert.strictEqual(empty.upRate, null, "空反馈的好评率该是 null 不是 " + empty.upRate);
    assert.deepStrictEqual(empty.byModel, []);
    assert.deepStrictEqual(empty.downs, []);

    // 落库：带模型/模式/步数；数字字段取整、负数归零、非数字归零
    const rec = ev.recordFeedback({ user: "a", session: "s1", turn: 0, verdict: "up", task: "写周报", reply: "好", model: "m1", provider: "P", mode: "craft", elapsed_ms: 1234.6, tokens: "88", calls: -3, steps: 5, errors: "x" });
    assert.strictEqual(rec.model, "m1"); assert.strictEqual(rec.provider, "P"); assert.strictEqual(rec.mode, "craft");
    assert.strictEqual(rec.elapsed_ms, 1235, "elapsed_ms 没取整：" + rec.elapsed_ms);
    assert.strictEqual(rec.tokens, 88, "字符串数字没转");
    assert.strictEqual(rec.calls, 0, "负数没归零");
    assert.strictEqual(rec.errors, 0, "非数字没归零");
    ev.recordFeedback({ user: "a", session: "s1", turn: 1, verdict: "down", note: "结论藏最后", task: "改一版", model: "m1", provider: "P", mode: "craft", steps: 7, errors: 2 });
    ev.recordFeedback({ user: "a", session: "s2", turn: 0, verdict: "down", note: "", task: "画图", model: "m2", provider: "Q", mode: "chat" });
    ev.recordFeedback({ user: "b", session: "s3", turn: 0, verdict: "up", task: "别人的", model: "m2", provider: "Q", mode: "chat" });
    ev.recordFeedback({ user: "b", session: "s3", turn: 1, verdict: "up", task: "没模型的" });
    // 五条是同一毫秒写进去的，倒序排不出先后；按写入顺序错开几秒（生产里不会同一毫秒点两次）
    const file = path.join(DATA, "feedback.json");
    { const l = JSON.parse(fs.readFileSync(file, "utf8")); l.forEach((x, i) => { x.at = new Date(NOW - (l.length - i) * 1000).toISOString(); }); fs.writeFileSync(file, JSON.stringify(l)); }

    const s = ev.feedbackSummary({ days: 30, now: NOW });
    assert.strictEqual(s.total, 5, "总数不对：" + s.total);
    assert.strictEqual(s.up, 3); assert.strictEqual(s.down, 2);
    assert.strictEqual(s.upRate, 0.6, "好评率不对：" + s.upRate);
    assert.strictEqual(s.downWithNote, 1, "写了理由的 👎 该是 1：" + s.downWithNote);
    assert.deepStrictEqual(s.last7, { up: 3, down: 2 });
    const bm = Object.fromEntries(s.byModel.map((x) => [x.name, x]));
    assert.deepStrictEqual(bm["P · m1"], { name: "P · m1", up: 1, down: 1, upRate: 0.5 }, JSON.stringify(s.byModel));
    assert.deepStrictEqual(bm["Q · m2"], { name: "Q · m2", up: 1, down: 1, upRate: 0.5 });
    assert.deepStrictEqual(bm["（未知）"], { name: "（未知）", up: 1, down: 0, upRate: 1 }, "没模型的该归到「（未知）」");
    assert.strictEqual(s.byModel[0].up + s.byModel[0].down, 2, "按模型该按条数降序");
    const bmode = Object.fromEntries(s.byMode.map((x) => [x.name, x]));
    assert.strictEqual(bmode.craft.down, 1); assert.strictEqual(bmode.chat.up, 1);
    assert.strictEqual(s.byDay.length, 1); assert.strictEqual(s.byDay[0].up, 3);
    assert.strictEqual(s.downs.length, 2);
    assert.strictEqual(s.downs[0].session, "s2", "👎 列表该按时间倒序，最新在前");
    assert.deepStrictEqual(Object.keys(s.downs[1]).sort(), ["at", "errors", "id", "model", "mode", "note", "provider", "session", "steps", "task", "turn"].sort());
    assert.strictEqual(s.downs[1].steps, 7); assert.strictEqual(s.downs[1].errors, 2); assert.strictEqual(s.downs[1].note, "结论藏最后");
    assert(!("reply" in s.downs[0]), "汇总里不该把回复全文带出去");
    // 成员只看自己的
    const mine = ev.feedbackSummary({ days: 30, now: NOW, user: "a" });
    assert.strictEqual(mine.total, 3, "按用户过滤不对：" + mine.total);
    assert.strictEqual(mine.up, 1);
    // 改判：同一轮再点是改，不是加一条
    ev.recordFeedback({ user: "a", session: "s1", turn: 1, verdict: "up", task: "改一版", model: "m1", provider: "P", mode: "craft" });
    const s2 = ev.feedbackSummary({ days: 30, now: NOW });
    assert.strictEqual(s2.total, 5, "改判变成了新增：" + s2.total);
    assert.strictEqual(s2.down, 1); assert.strictEqual(s2.downWithNote, 0, "改判成 👍 后旧理由还在算");
    // 窗口：40 天前的那条在 30 天窗口外、60 天窗口内
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    list.push({ id: "fb_old", at: new Date(NOW - 40 * 86400e3).toISOString(), user: "a", session: "s9", turn: 0, verdict: "down", note: "老账", model: "m1", provider: "P", mode: "craft" });
    fs.writeFileSync(file, JSON.stringify(list));
    assert.strictEqual(ev.feedbackSummary({ days: 30, now: NOW }).total, 5, "窗口外的记录混进来了");
    const s60 = ev.feedbackSummary({ days: 60, now: NOW });
    assert.strictEqual(s60.total, 6, "60 天窗口没把 40 天前那条算上");
    assert.strictEqual(s60.last7.down, 1, "近 7 天不该算上 40 天前的");
    assert.strictEqual(s60.byDay.length, 2);
    // 没有 verdict 的坏记录不算
    list.push({ id: "fb_bad", at: new Date(NOW).toISOString(), user: "a", session: "s9", turn: 1, verdict: "meh" });
    fs.writeFileSync(file, JSON.stringify(list));
    assert.strictEqual(ev.feedbackSummary({ days: 30, now: NOW }).total, 5, "verdict 不是 up/down 的也被数了");

    // 👎 进自进化信号：样本摘要带模型名，方便复盘时一眼看出「是不是某个模型的锅」
    const mined = ev.mineSignals({ days: 60, now: NOW });
    const td = mined.signals.find((x) => x.key === "thumbs_down");
    assert(td, "👎 没进信号：" + JSON.stringify(mined.signals.map((x) => x.key)));
    assert.strictEqual(td.count, 2, "👎 计数不对（改判过的那条不该算）：" + td.count);
    assert(td.samples.every((x) => /^\\[m[12]\\] /.test(x.excerpt)), "👎 样本摘要没带模型名：" + JSON.stringify(td.samples.map((x) => x.excerpt)));
    assert(td.samples.some((x) => x.excerpt === "[m2] （没写理由）"), "没写理由的要明说");

    // 规则打分：生效之后的 👍👎 摆出来；生效之前的不算
    const born = new Date(NOW - 10 * 86400e3).toISOString();
    fs.writeFileSync(path.join(DATA, "learned", "r1.md"), '<!-- ' + JSON.stringify({ at: born, baseline: { key: "thumbs_down", rate: 0.5 } }) + ' -->\\n别把结论藏在最后');
    const sc = ev.scoreRules({ minTurns: 0, now: NOW });
    assert.strictEqual(sc.length, 1, JSON.stringify(sc));
    assert.deepStrictEqual(sc[0].fb, { up: 4, down: 1 }, "规则打分里的 👍👎 计数不对（40 天前那条在生效前，不该算）：" + JSON.stringify(sc[0].fb));
    assert(/👍4 👎1/.test(sc[0].why), "why 里没写反馈：" + sc[0].why);
    // 负对照：生效前的 👍👎 一条都不算 → why 里不出现反馈那一截
    fs.writeFileSync(path.join(DATA, "learned", "r1.md"), '<!-- ' + JSON.stringify({ at: new Date(NOW + 60e3).toISOString(), baseline: { key: "thumbs_down", rate: 0.5 } }) + ' -->\\n刚生效');
    const sc2 = ev.scoreRules({ minTurns: 0, now: NOW });
    assert.deepStrictEqual(sc2[0].fb, { up: 0, down: 0 }, JSON.stringify(sc2[0]));
    assert(!/用户反馈/.test(sc2[0].why), "没反馈还硬写了一句：" + sc2[0].why);
    console.log("OK");
  `, "反馈汇总");

  // ④ 源码闸门：归属改回设置页模型、百分比不封顶、回放不亮反馈——这几处哪个被改回去都会复现
  const src = {
    server: fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"),
    agent: fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8"),
    app01: fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8"),
    app02: fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8"),
    app03: fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-03.js"), "utf8"),
    html: fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8"),
  };
  const bad = [];
  const has = (k, re, why) => { if (!re.test(src[k] || "")) bad.push(why); };
  const not = (k, re, why) => { if (re.test(src[k] || "")) bad.push(why); };
  has("server", /let ranLLM = \{ model: sessLLM\.model, provider: sessLLM\.provider \}/, "server.js 没有「真跑的是谁」这个变量");
  has("server", /chargeRun\(user, \{ \.\.\.total, model: ranLLM\.model, provider: ranLLM\.provider, source: "web"/, "网页任务的账本归属没按真跑的引擎记");
  not("server", /model: sessLLM\.model, provider: sessLLM\.provider, source: "web"/, "网页任务的账本还按设置页的云模型记（引擎跑的会记到 deepseek 名下）");
  has("server", /recordModelHealth\(ranLLM\.provider, false/, "失败健康统计没按真跑的引擎记");
  has("server", /recordModelHealth\(ranLLM\.provider, true\)/, "成功健康统计没按真跑的引擎记");
  has("server", /modelFailStreak\.get\(ranLLM\.provider\)/, "失败连击没按真跑的引擎记");
  has("server", /const ran = r\.provider \? \{ model: r\.model \|\| r\.provider, provider: r\.provider \} : runLLM/, "IM/定时任务的账本归属没按真跑的引擎记");
  has("server", /app\.get\("\/api\/feedback\/summary"/, "没有反馈汇总接口");
  has("server", /if \(ev\.type === "tool_use" \|\| ev\.type === "tool_result"\) ev\.at = ev\.at \|\| Date\.now\(\);/, "落盘的工具事件没盖时间戳，回放时轨迹条算不出每步耗时");
  has("server", /feedback = evolve\.readFeedback\(\)\.filter\(\(f\) => f\.session === req\.params\.id\)/, "/api/session/:id 没把该会话的反馈带回去，回放时 👍👎 亮不回来");
  has("agent", /return \{ finalText, usage, stopped: r\.stopped \|\| null, sessionId: r\.sessionId \|\| null, engine: backend\.id, model: opts\.model \|\| backend\.label, provider: backend\.id \}/, "runViaEngine 没把「真跑的是哪个引擎」返回给上层");
  has("app01", /Math\.min\(100, Math\.round\(\(u\.cached \/ Math\.max\(1, u\.prompt\)\) \* 100\)\)/, "回复操作条的命中率没封顶 100%");
  has("app03", /Math\.min\(100, Math\.round\(\(x\.cached \|\| 0\) \/ x\.cachedOf \* 100\)\)/, "用量页的命中率没封顶 100%");
  has("app02", /replayFeedback = new Map\(\(data\.feedback \|\| \[\]\)/, "回放没把之前点的 👍👎 装进 replayFeedback");
  has("app02", /finally \{ isReplaying = false; replayFeedback = null; \}/, "回放结束没清 replayFeedback（下一个新回合会误亮）");
  has("app03", /async function renderFeedbackSummary/, "评测页没有反馈汇总");
  has("app03", /id="ev-fb"/, "评测页没有反馈汇总的挂点");
  has("app03", /\/api\/feedback\/summary\?days=/, "评测页没调反馈汇总接口");
  has("app01", /class="trail"/, "折叠条上没有轨迹条");
  has("app01", /const TRAIL_MAX = 12/, "轨迹条没上限（四十步的任务会把标题挤没）");
  has("html", /\.proc-head \.tc\.err \{/, "轨迹条没有出错样式");
  has("html", /\.proc-head \.tc\.run \{/, "轨迹条没有运行中样式");
  has("html", /\.ev-fb-cards \{/, "评测页反馈卡片没样式");
  assert(!bad.length, "反馈/账本源码闸门：\n  " + bad.join("\n  "));
  console.log("✅ 反馈闭环+账本口径：引擎 prompt 含缓存读 · 老账读时修/新账写前修 · 归属按真跑引擎 · 汇总按模型/模式/窗口/用户 · 改判不重复 · 👎 进信号带模型名 · 规则打分带生效后 👍👎 · 回放带回反馈 · 工具事件盖时间戳");
}


/**
 * IM 收附件 —— 用户原话：「我通过微信渠道发文件怎么接收不到吗？，从各个渠道发文件，
 * 表情包，消息还有语音的时候」。
 *
 * 当时聊天记录里是「（文件：xxx.pdf，本版暂不下载）」：文件根本没下，agent 只看见一行字；
 * 表情包这类消息更狠，在渠道层直接 return，机器人一声不吭，看着像死机。
 *
 * 这条盯四件事：附件真落盘（不覆盖、不穿越、不撑爆、没名字也能双击打开）、
 * 微信 CDN 的密文解得开、认不出的类型也必须留一句话、以及各渠道入站路由不再对非文本消息提前 return。
 */
async function testImInboundMedia() {
  const crypto = require("crypto");
  const M = require("../im-media");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-im-media-"));

  // ---- 文件头认扩展名：CDN 下来的是裸字节，没名字也没 Content-Type ----
  const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(16)]);
  const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(16)]);
  assert.strictEqual(M.sniffExt(PNG), ".png", "PNG 文件头没认出来");
  assert.strictEqual(M.sniffExt(PDF), ".pdf", "PDF 文件头没认出来");
  assert.strictEqual(M.sniffExt(Buffer.from("随便一段中文文本")), "", "认不出的不该瞎猜扩展名");

  // ---- 落盘 ----
  const n1 = M.saveInbound(dir, "", PNG, { now: Date.parse("2026-09-09T10:12:59Z") });
  assert(/\.png$/.test(n1), "没名字的图片没补扩展名，用户下下来双击打不开：" + n1);
  const n2 = M.saveInbound(dir, "合同.pdf", PDF);
  const n3 = M.saveInbound(dir, "合同.pdf", PDF);
  assert.strictEqual(n2, "合同.pdf", "有原名时不该改名：" + n2);
  assert(n3 !== n2, "同名第二个文件把第一个覆盖了");
  assert(fs.existsSync(path.join(dir, n2)) && fs.existsSync(path.join(dir, n3)), "两个同名附件没都留下");
  // 路径穿越：不是报错了事，而是削成最后一段——文件照收，但绝不能写到工作目录外面
  const n4 = M.saveInbound(dir, "../../跑出去.txt", PDF);
  assert.strictEqual(n4, "跑出去.txt", "../ 没被削掉：" + n4);
  assert(fs.existsSync(path.join(dir, n4)), "削完之后文件没落在工作目录里");
  assert(!fs.existsSync(path.join(dir, "..", "..", "跑出去.txt")), "文件被写到工作目录外面去了");
  assert.strictEqual(M.saveInbound(dir, "folder/子目录/报表.xlsx", PDF), "报表.xlsx", "带目录的文件名没削成最后一段");
  assert.throws(() => M.saveInbound(dir, "巨无霸.bin", Buffer.alloc(M.MAX_INBOUND_BYTES + 1)), /上限/, "超大文件没拒收");
  assert.throws(() => M.saveInbound(dir, "空的.txt", Buffer.alloc(0)), /空/, "空内容没拒收");
  // fallback：微信 CDN 那条路没有原始文件名，得有个兜底名，不能落个没名字的文件
  assert.strictEqual(
    M.saveInbound(dir, "", Buffer.from("纯文本没有文件头"), { fallback: "微信文件_101259.txt" }),
    "微信文件_101259.txt", "认不出文件头又没原名时，fallback 名字没生效");

  // ---- 微信 CDN 的 AES-128-ECB：两种 aes_key 编码都得认，且原样解回来 ----
  const key = crypto.randomBytes(16);
  const hexKey = Buffer.from(key.toString("hex"), "utf8"); // 规范编码：32 位十六进制 ASCII
  assert.deepStrictEqual(M.parseAesKey(hexKey.toString("base64")), key, "十六进制 ASCII 的 aes_key 没解对");
  assert.deepStrictEqual(M.parseAesKey(key.toString("base64")), key, "裸 16 字节的 aes_key 没解对");
  assert.throws(() => M.parseAesKey(Buffer.alloc(7).toString("base64")), /不合法/, "长度不对的 aes_key 没拒绝");
  const plain = Buffer.from("一份真实的附件内容，够长到跨好几个分组".repeat(3));
  const cipher = M.encryptAesEcb(plain, key);
  assert.deepStrictEqual(M.decryptAesEcb(cipher, key), plain, "AES-ECB 加解密回不去原文");
  assert.strictEqual(M.aesEcbPaddedSize(plain.length), cipher.length, "上传要报的 filesize 跟真密文长度对不上");

  // 真跑一次下载链路（假 fetch 冒充 CDN）：密文 → 解密 → Buffer
  let askedUrl = "";
  const cdnBuf = await M.downloadWechatCdn(
    { encrypt_query_param: "QQ==", aes_key: hexKey.toString("base64") },
    { fetchImpl: async (u) => {
        askedUrl = u;
        return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => M.encryptAesEcb(PDF, key) };
      } });
  assert.deepStrictEqual(cdnBuf, PDF, "CDN 下来的密文没解成原文件");
  assert(/encrypted_query_param=/.test(askedUrl), "下载地址没带 encrypted_query_param：" + askedUrl);
  await assert.rejects(() => M.downloadWechatCdn({ encrypt_query_param: "x" }), /没带 CDN/, "缺 aes_key 时没如实报错");

  // ---- 给 agent 看的那句话：收到了说清存哪了，没收到更要说 ----
  const okNote = M.inboundNote({ channel: "微信", saved: [{ kind: "file", name: "合同.pdf" }] });
  assert(okNote.includes("合同.pdf") && okNote.includes("工作目录"), "收到附件的说明里没写文件名/位置：" + okNote);
  const badNote = M.inboundNote({ channel: "微信", failed: [{ kind: "voice", name: "", why: "下载超时" }] });
  assert(/语音/.test(badNote) && /没收下来/.test(badNote) && /别装作收到/.test(badNote),
    "没收下来的说明不够硬，agent 会含糊过去：" + badNote);
  assert(M.inboundNote({ channel: "微信", saved: [{ kind: "image", name: "a.png" }], text: "看看这张" }).includes("看看这张"),
    "附带的文字被吞了");

  // ---- 微信 iLink 解析：表情包这类认不出的类型，绝不能整条丢掉 ----
  const { describeItems } = require("../im-ilink");
  const cdn = { encrypt_query_param: "p", aes_key: "k" };
  assert.strictEqual(describeItems([{ type: 1, text_item: { text: "你好" } }]).text, "你好", "纯文本解析错了");
  const withFile = describeItems([{ type: 4, file_item: { file_name: "报价.xlsx", media: cdn } }]);
  assert.strictEqual(withFile.media.length, 1, "带 CDN 参数的文件没被认成可下载附件");
  assert.strictEqual(withFile.media[0].name, "报价.xlsx", "文件名没带出来");
  // 语音优先用微信自己的转写文字，省一次下载也省一次听
  assert.strictEqual(describeItems([{ type: 3, voice_item: { text: "帮我订个会议室", media: cdn } }]).text,
    "帮我订个会议室", "语音转写文字没被优先采用");
  assert.strictEqual(describeItems([{ type: 3, voice_item: { media: cdn } }]).media[0].kind, "voice",
    "没转写文字时没去下原始音频");
  // 没带 CDN 信息的图片：不是静默丢，是留一句「没下载信息」
  const noCdn = describeItems([{ type: 2, image_item: {} }]);
  assert(noCdn.notes.length === 1 && !noCdn.media.length, "没下载信息的图片被静默丢了");
  // ★负向对照★ 认不出的类型（表情包/位置/名片）必须留下一条 note
  const sticker = describeItems([{ type: 99 }]);
  assert(sticker.notes.length === 1 && !sticker.text && !sticker.media.length,
    "认不出的消息类型被静默丢掉了，机器人会一声不吭：" + JSON.stringify(sticker));
  // 但认得出内容时不该再多嘴一句「解析不了」
  assert.strictEqual(describeItems([{ type: 1, text_item: { text: "在" } }, { type: 99 }]).notes.length, 0,
    "已经解析出文字了还硬加一句「解析不了」，属于没事找事");

  // ---- 企微/公众号：加密回调里的附件字段要抠得出来 ----
  const { createWecomApp, msgSignature, encryptMsg } = require("../im-wechat");
  const aesKey = crypto.randomBytes(32).toString("base64").slice(0, 43); // EncodingAESKey 是 43 位
  const wecom = createWecomApp({ getConfig: () => ({ corp_id: "c", agent_id: "1", secret: "s", token: "tk", aes_key: aesKey }) });
  const mkCallback = (xml) => {
    const enc = encryptMsg(aesKey, xml, "c");
    return [{ timestamp: "1", nonce: "n", msg_signature: msgSignature("tk", "1", "n", enc) },
      `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`];
  };
  const voice = wecom.parseCallback(...mkCallback(
    `<xml><FromUserName><![CDATA[u1]]></FromUserName><MsgType><![CDATA[voice]]></MsgType>` +
    `<MediaId><![CDATA[m-123]]></MediaId><Format><![CDATA[amr]]></Format>` +
    `<Recognition><![CDATA[帮我订个会议室]]></Recognition><MsgId>9</MsgId></xml>`));
  assert.strictEqual(voice.mediaId, "m-123", "企微语音的 MediaId 没解出来");
  assert.strictEqual(voice.recognition, "帮我订个会议室", "语音转写文字没解出来（这份能直接当任务用）");
  assert.strictEqual(voice.msgType, "voice", "MsgType 没解出来");
  const file = wecom.parseCallback(...mkCallback(
    `<xml><FromUserName><![CDATA[u1]]></FromUserName><MsgType><![CDATA[file]]></MsgType>` +
    `<MediaId><![CDATA[m-9]]></MediaId><FileName><![CDATA[季度报表.xlsx]]></FileName><MsgId>10</MsgId></xml>`));
  assert.strictEqual(file.fileName, "季度报表.xlsx", "企微文件名没解出来，存下来就没名字了");
  assert(typeof wecom.fetchMedia === "function", "企微没有下载附件的入口");
  const [q, body] = mkCallback("<xml><MsgType><![CDATA[text]]></MsgType></xml>");
  assert.throws(() => wecom.parseCallback({ ...q, msg_signature: "0".repeat(40) }, body), /签名/, "签名错了居然放行");

  // ---- 源码闸：入站路由不许再对非文本消息提前 return ----
  const imSrc = fs.readFileSync(path.join(__dirname, "..", "im.js"), "utf8");
  assert(!/msgType\s*!==\s*"text"[\s\S]{0,60}return\s*;/.test(imSrc),
    "企微/公众号路由又对非文本消息提前 return 了，文件/语音会静默丢失");
  assert(/wxInboundText/.test(imSrc), "企微/公众号没走统一的附件处理");
  assert(/FEISHU_MEDIA/.test(imSrc) && /feishuPostText/.test(imSrc), "飞书没覆盖语音/表情/富文本");
  assert(/这类消息（\$\{type\}）我这边解析不了/.test(imSrc), "飞书认不出的类型没留话");
  // 只盯代码里的字面量：注释里写「以前是本版暂不下载」是留档，留档不该算回归
  const ilkSrc = fs.readFileSync(path.join(__dirname, "..", "im-ilink.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  assert(!/本版暂不下载/.test(ilkSrc),
    "微信还留着「本版暂不下载」的占位，说明附件没真下载");
  assert(/downloadMedia/.test(ilkSrc) && /require\("\.\/im-media"\)/.test(ilkSrc),
    "微信侧没接下载：拆出来的附件得真交给 im-media 落盘，不能只留一行描述");
  assert(/attachments/.test(fs.readFileSync(path.join(__dirname, "..", "im-qq.js"), "utf8")),
    "QQ 没接 attachments，手机上发的图进不来");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("✅ IM 收附件：四渠道真下载 · 补扩展名/不覆盖/挡穿越/限大小 · CDN 密文解得开 · 认不出的类型也留一句话");
}

/**
 * IM 凭证不许被空输入冲掉 —— 用户原话：「现在连接飞书好像有点问题」。
 *
 * 事故原样：config.json 里 im.feishu.app_id 好好的，app_secret 是空字符串，
 * 于是长连接压根没起来，界面只显示「未连接」，一个字都不说为什么。
 *
 * 根因不在飞书，在设置页是「整页回写」：点任何一张卡的「连接」，前端会把所有渠道
 * 所有输入框原样 POST 一遍；密码类输入框刷新后是空的 → 一次无关的保存就把 Secret 擦了。
 * 这条测试的核心就是那个负向对照：空值提交之后，原来的 Secret 必须还在。
 */
async function testImCredentialGuard() {
  const http = require("http");
  const { spawn } = require("child_process");
  const crypto = require("crypto");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-imcred-"));
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
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).im || {};

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + log.slice(-400));

    const SECRET = "s3cret_" + crypto.randomBytes(8).toString("hex");
    const w = await req("POST", "/api/settings", { im: { feishu: { app_id: "cli_e2e0001", app_secret: SECRET } } });
    assert(w.code === 200, "凭证存不进去（HTTP " + w.code + " " + w.body.slice(0, 200) + "）");
    assert.strictEqual(onDisk().feishu.app_secret, SECRET, "凭证没落盘");

    // ★事故复现 + 负向对照★ 设置页整页回写：别的卡点「连接」，飞书这两格是空的
    const other = await req("POST", "/api/settings", {
      im: { feishu: { app_id: "cli_e2e0001", app_secret: "" }, qq: { app_id: "1000", app_secret: "qq-secret" } },
    });
    assert(other.code === 200, "保存别的渠道失败（HTTP " + other.code + "）");
    assert.strictEqual(onDisk().feishu.app_secret, SECRET,
      "空输入把已经存好的飞书 App Secret 冲掉了 —— 这正是用户飞书断连的原因");
    assert.strictEqual(onDisk().qq.app_secret, "qq-secret", "顺手保存的另一个渠道没存上");

    // 空格也算空：密码框里残留一个空格不该当成新密码
    await req("POST", "/api/settings", { im: { feishu: { app_secret: "   " } } });
    assert.strictEqual(onDisk().feishu.app_secret, SECRET, "全是空格的输入把凭证冲掉了");

    // 改成新值当然要改得动，不然就成了「只能填一次」
    await req("POST", "/api/settings", { im: { feishu: { app_secret: "new-secret" } } });
    assert.strictEqual(onDisk().feishu.app_secret, "new-secret", "改新凭证改不动");

    // ★另一半负向对照★ 点「取消连接」必须真能清掉，不能因为怕误擦就永远删不掉
    const cut = await req("POST", "/api/settings", {
      im: { feishu: { app_id: "", app_secret: "" }, clear: ["feishu.app_id", "feishu.app_secret"] },
    });
    assert(cut.code === 200, "取消连接失败（HTTP " + cut.code + "）");
    assert.strictEqual(onDisk().feishu.app_secret, "", "点了取消连接却没清掉，用户以为断了其实还连着");
    assert.strictEqual(onDisk().feishu.app_id, "", "app_id 没清掉");
    assert.strictEqual(onDisk().qq.app_secret, "qq-secret", "清飞书把 QQ 的也清了");

    // 只填一半时，状态要点名缺哪半边 —— 以前只有干巴巴一个「未连接」
    await req("POST", "/api/settings", { im: { feishu: { app_id: "cli_e2e0001" } } });
    const st = await req("GET", "/im/status");
    assert(st.json && st.json.feishu, "/im/status 读不出飞书状态：" + st.body.slice(0, 200));
    assert.strictEqual(st.json.feishu.configured, false, "只填了 App ID 却报成已配置");
    assert.deepStrictEqual(st.json.feishu.missing, ["App Secret"],
      "没点名缺哪半边，用户只能看见「未连接」瞎猜：" + JSON.stringify(st.json.feishu.missing));
    assert(!JSON.stringify(st.json).includes("cli_e2e0001"), "状态接口把 App ID 原样吐出来了，日志/截图会泄露");

    console.log("✅ IM 凭证保护：空输入冲不掉已存凭证（飞书断连的真因）· 取消连接真能清 · 只填一半时点名缺哪个");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 版本与更新 —— 用户原话：「思考一下如果这个代码有更新的话，这个安装包是要重新安装吗，还是能更新啊」。
 *
 * 结论是不能做静默自动更新：构建没签名，macOS 那条路走 Squirrel.Mac 会校验代码签名，必然失败。
 * 所以做成「查得到就如实告诉你，并按你的安装方式给出该做什么」。
 * 这里最要紧的一条负向对照：网络不通时绝不能悄悄报成「已是最新」。
 */
async function testUpdaterVersions() {
  const U = require("../updater");

  assert.strictEqual(U.cmpVer("0.1.1", "0.1.0"), 1, "补丁号大小比错了");
  assert.strictEqual(U.cmpVer("0.2.0", "0.10.0"), -1, "版本号被当字符串比了（0.2 > 0.10 是错的）");
  assert.strictEqual(U.cmpVer("v1.0.0", "1.0.0"), 0, "带 v 前缀的 tag 没归一化，会天天提示有新版");
  assert.strictEqual(U.cmpVer("1.0.0", "1.0.0-beta.1"), 1, "正式版没被当成比预发布新");
  assert.strictEqual(U.cmpVer("1.0.0-beta.1", "1.0.0"), -1, "预发布没被当成比正式版旧");
  assert.strictEqual(U.parseVer("乱写的"), null, "解析不了的版本号没返回 null");
  assert.strictEqual(U.cmpVer("乱写的", "1.0.0"), 0, "解析不了时没保持中立（宁可不提示，也别乱提示）");
  assert.strictEqual(U.currentVersion(), require("../package.json").version, "报的版本号跟 package.json 不一致");

  // 两种安装方式给的话必须不一样，且都得说人话
  const src = U.howToUpdate("source");
  assert(/git pull/.test(src) && /不用重装/.test(src), "源码安装没说清「不用重装」：" + src);
  assert(/dmg/.test(U.howToUpdate("app", "darwin")), "macOS 装包版没说下 dmg");
  assert(/setup\.exe/.test(U.howToUpdate("app", "win32")), "Windows 装包版没说下 setup.exe");
  for (const p of ["darwin", "win32"]) {
    assert(/覆盖装/.test(U.howToUpdate("app", p)) && /~\/OpenWorkBuddy/.test(U.howToUpdate("app", p)),
      `${p} 没说清覆盖安装不会动配置/会话/工作区，用户不敢升级：` + U.howToUpdate("app", p));
  }

  const reply = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  U.resetCache();
  const has = await U.checkUpdate({ force: true, fetchImpl: reply({ tag_name: "v99.0.0", html_url: "https://x/r/99", body: "更新说明" }) });
  assert.strictEqual(has.latest, "99.0.0", "tag 里的版本号没解出来");
  assert.strictEqual(has.has_update, true, "有新版却说没有");
  assert.strictEqual(has.error, "", "正常返回时不该带 error");
  assert(has.how && has.page, "没给出「该怎么做」和下载页地址");

  U.resetCache();
  const cur = require("../package.json").version;
  const same = await U.checkUpdate({ force: true, fetchImpl: reply({ tag_name: "v" + cur }) });
  assert.strictEqual(same.has_update, false, "跟本机同版本却说有新版，会天天弹提示");

  // 缓存：6 小时内不该反复打 GitHub（匿名接口每小时 60 次）
  let calls = 0;
  U.resetCache();
  const counting = async () => { calls++; return { ok: true, status: 200, json: async () => ({ tag_name: "v99.0.0" }) }; };
  await U.checkUpdate({ force: true, fetchImpl: counting });
  const cached = await U.checkUpdate({ fetchImpl: counting });
  assert.strictEqual(calls, 1, "缓存没生效，每次开界面都打一次 GitHub：" + calls);
  assert.strictEqual(cached.cached, true, "缓存命中时没标出来");
  await U.checkUpdate({ force: true, fetchImpl: counting });
  assert.strictEqual(calls, 2, "手动点「检查更新」时缓存没被绕开，用户点了等于没点");

  // ★负向对照★ 网络不通 / GitHub 抽风：必须如实说查不到，不能悄悄报成「已是最新」
  U.resetCache();
  const down = await U.checkUpdate({ force: true, fetchImpl: async () => { throw new Error("connect ETIMEDOUT"); } });
  assert(down.error && /查不到最新版本/.test(down.error), "网络不通时没如实报错：" + JSON.stringify(down));
  assert.strictEqual(down.latest, "", "查不到却编了个版本号出来");
  assert.strictEqual(down.has_update, false, "查不到时不该声称有新版");
  assert(down.how && down.current, "查不到时也得告诉用户本机版本和更新方式");
  U.resetCache();
  const rate = await U.checkUpdate({ force: true, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  assert(/403/.test(rate.error || ""), "GitHub 限流没如实报出来：" + JSON.stringify(rate));
  U.resetCache();
  const junk = await U.checkUpdate({ force: true, fetchImpl: reply({ tag_name: "latest" }) });
  assert(junk.error && !junk.has_update, "tag 不是版本号时没兜住：" + JSON.stringify(junk));
  U.resetCache();

  // 打包版和源码版判得出来。
  // 这条曾经是错的：判据只有「路径里有 app.asar」，而本项目的 asar 是关着的（见
  // electron-builder.config.js 文件头），装机包里代码住在 <Resources>/app/。于是**每一个**
  // 装了包的用户点「检查更新」，拿到的建议都是 git pull && npm install —— 他机器上没有这个仓库。
  assert(["app", "source"].includes(U.installKind()), "安装方式判不出来");
  assert.strictEqual(U.installKind(), "source", "测试是从源码跑的，却判成了安装包");
  // 装机版：mac（asar 关着，代码在 Resources/app 下）
  assert.strictEqual(
    U.installKind("/Applications/OpenWorkBuddy.app/Contents/Resources/app",
                  "/Applications/OpenWorkBuddy.app/Contents/Resources"),
    "app", "装了 dmg 的用户被判成源码版，会被告知去 git pull（他机器上没有这个仓库）");
  // 装机版：Windows（反斜杠；断言要能在 mac 上跑，所以判据必须跟路径分隔符无关）
  assert.strictEqual(
    U.installKind("C:\\Program Files\\OpenWorkBuddy\\resources\\app",
                  "C:\\Program Files\\OpenWorkBuddy\\resources"),
    "app", "Windows 装机版判成了源码版");
  // 哪天把 asar 打开，这条路还得通
  assert.strictEqual(
    U.installKind("/Applications/OpenWorkBuddy.app/Contents/Resources/app.asar",
                  "/Applications/OpenWorkBuddy.app/Contents/Resources"),
    "app", "asar 开着的装机版判不出来");
  // 反向对照一：从仓库跑 electron 时 resourcesPath 也有值（指向 electron 自带的 Resources），
  // 但它不含本目录 —— 「有 resourcesPath 就算装机版」是错的
  assert.strictEqual(
    U.installKind("/Users/me/openworkbuddy",
                  "/Users/me/openworkbuddy/node_modules/electron/dist/Electron.app/Contents/Resources"),
    "source", "npm run app（从源码跑 electron）被判成了装机版");
  // 反向对照二：前缀陷阱。裸 startsWith 会把 Resources-old 也算进去
  assert.strictEqual(U.installKind("/A/Resources-old/app", "/A/Resources"), "source",
    "只是名字前缀撞上就被判成装机版（判据漏了分隔符）");
  // 反向对照三：纯 node 跑（npm start）压根没有 resourcesPath
  assert.strictEqual(U.installKind("/Users/me/openworkbuddy", undefined), "source",
    "纯 node 模式判成了装机版");
  // 判错了不是措辞问题，是给出完全用不上的操作：两条建议必须真的不一样
  assert(/git pull/.test(U.howToUpdate("source")), "源码版没给 git pull");
  assert(!/git pull/.test(U.howToUpdate("app", "darwin")), "装机版还在让人 git pull");
  assert(/dmg/.test(U.howToUpdate("app", "darwin")) && /setup\.exe/.test(U.howToUpdate("app", "win32")),
    "装机版没说清该下哪个包");

  // 不做静默自动更新，是因为构建没签名 —— 这条理由必须写在代码里，不然下次有人顺手加个 autoUpdater
  const src2 = fs.readFileSync(path.join(__dirname, "..", "updater.js"), "utf8");
  assert(/签名/.test(src2), "updater.js 里没写清「为什么不做自动更新」，后人会踩回去");
  const pkgJson = require("../package.json");
  assert(!/electron-updater/.test(JSON.stringify(pkgJson.dependencies || {})),
    "引了 electron-updater —— 没签名的包用它在 macOS 上必然失败，等于给用户一个永远点不动的按钮");

  console.log("✅ 版本与更新：版本号比得对（含 0.2<0.10 / 预发布）· 两种安装方式各说各的 · 缓存挡限流 · 查不到就说查不到，不假装最新");
}

/**
 * lark-cli 输出解析 —— 「扫码新建应用」这条路全靠它。
 *
 * 用户问过两次「不能扫码连机器人吗？」。直答是不能：飞书的机器人就是一个「应用」，
 * 平台只认 app_id / app_secret，扫码换不来这两串。但 @larksuite/cli 的
 * `config init --new` 能**替你把应用建出来**——它阻塞着打印一条验证链接，
 * 用户在浏览器/飞书里点完，凭证就落进 ~/.lark-cli/config.json。我们把那条链接
 * 渲染成二维码，建完直接把凭证接管过来 → 一个字都不用手打。
 *
 * 这条只测纯解析（绝不真的去跑 config init --new，那会在用户的飞书企业里建出真应用）：
 * 输出里带着尾巴、带着前缀噪声、链接后面粘着中文标点，这些都得吃得下；
 * 认不出来的时候必须给一句人话，而不是把 stderr 原样甩给用户。
 */
/**
 * early stop：任务没做完就收摊。
 *
 * 真实表现是最坑人的一种失败——界面上任务「正常结束」了，用户点开产物才发现只做了一半。
 * 根因在 agent 循环里：模型这一步不调工具，框架就当它做完了直接 break。可「不调工具」
 * 只代表模型认为自己做完了，进度档里还挂着没打勾的条目它照样能停。
 *
 * 闸门做两件事：① 停之前先读 PROGRESS.md，还有没打勾的就把条目原样念回去、打回接着做；
 * ② 打回额度用完还没做完，就把它当成「撞上限」交给自动续跑，而不是假装成功。
 *
 * 这里的负向控制比正向断言更值钱：全打勾、没有进度档、没有复选框——三种情况都必须放行。
 * 判错一次就是把已经做完的任务反复打回去，烧的是用户的钱和时间。
 */
async function testCompletionGate() {
  const { unfinishedMilestones, UNFINISHED_RE } = require("../agent");

  // ---- 进度档解析 ----
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "owb-gate-"));
  const P = path.join(probe, "PROGRESS.md");
  assert.deepStrictEqual(unfinishedMilestones(probe), { open: [], total: 0 }, "没有 PROGRESS.md 时必须返回空且不抛");
  fs.writeFileSync(P, "# 目标\n做三件事\n\n- [x] 第一件\n* [X] 第二件\n- [ ] 第三件：写报告\n这是一行普通正文\n");
  const u = unfinishedMilestones(probe);
  assert.strictEqual(u.total, 3, "三个复选框只认出 " + u.total + " 个（`* [X]` 这种写法也得认）");
  assert.deepStrictEqual(u.open, ["第三件：写报告"], "没打勾的条目没拎准：" + JSON.stringify(u.open));
  // 负向控制①：全打勾 = 做完了，一项都不许剩
  fs.writeFileSync(P, "- [x] a\n- [X] b\n- [x] c\n");
  const done = unfinishedMilestones(probe);
  assert.strictEqual(done.total, 3, "全打勾的条目数不对");
  assert.strictEqual(done.open.length, 0, "全打勾还被判成没做完——已完成的任务会被反复打回去烧钱");
  // 负向控制②：没有复选框的进度档不算里程碑清单
  fs.writeFileSync(P, "# 只是一段说明\n没有任何复选框\n1. 第一步\n");
  assert.strictEqual(unfinishedMilestones(probe).total, 0, "把普通编号列表当成里程碑了");
  fs.rmSync(probe, { recursive: true, force: true });

  // ---- 自认没做完的措辞 ----
  for (const t of ["报告还没写完", "尚未完成第三步", "由于时间关系，剩下的部分未完成", "后续会继续完成剩余章节", "第二部分未能完成"]) {
    assert(UNFINISHED_RE.test(t), "没认出这是「还没做完」：" + t);
  }
  // 负向控制③：做完了的话、以及正常的交接说明，一律不许判成没做完
  for (const t of [
    "全部完成，共产出 3 份材料。",
    "已完成。后续你可以自己调整配色。",
    "需要你处理：去开放平台复制 App Secret 粘进来。",
    "任务完成，结果都在工作目录里了。",
  ]) assert(!UNFINISHED_RE.test(t), "把做完的话判成了没做完：" + t);

  // ---- 跑真循环 ----
  const DIR = "e2e-gate-run";
  const runDir = path.join(WORKSPACE, DIR);
  try {
    // 每次 chat 只回文字、不调工具 —— 模拟「模型认为自己做完了」
    const mk = (texts) => {
      const seen = [];
      let i = 0;
      return {
        llm: {
          provider: "mock",
          model: "scripted",
          async chat({ history }) {
            const last = history[history.length - 1];
            if (last && last.role === "user" && /【系统·收尾核验】/.test(last.content || "")) seen.push(last.content);
            return { text: texts[Math.min(i++, texts.length - 1)], toolCalls: [], stopReason: "end" };
          },
        },
        pushbacks: seen,
        calls: () => i,
      };
    };
    const run = async (h) => {
      const deltas = [];
      const r = await createAgentRuntime({ config, llm: h.llm, mcpManager: new McpManager(), experts: [] }).runTask({
        history: [{ role: "user", content: "把三件事做完" }],
        emit: (ev) => { if (ev.type === "text" && ev.delta) deltas.push(ev.delta); },
        baseDir: DIR,
      });
      return { r, deltas };
    };

    // ① 有没打勾的 → 必须打回，且打回时把条目原样念出来
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "PROGRESS.md"), "- [x] 收集资料\n- [ ] 写第二章\n- [ ] 导出成品\n");
    let h = mk(["我先做到这里。"]);
    let { r, deltas } = await run(h);
    assert.strictEqual(h.pushbacks.length, 2, "打回次数不对（应当正好 2 次，多了会无限烧钱、少了等于没拦）：" + h.pushbacks.length);
    assert(/写第二章/.test(h.pushbacks[0]) && /导出成品/.test(h.pushbacks[0]), "打回时没把没打勾的条目原样念给模型——只说「继续」它不知道继续什么");
    assert(deltas.some((d) => /还没做完/.test(d)), "界面上没告诉用户「还没做完，已打回」");
    assert.strictEqual(r.stopped, "任务还有 2 项没做完", "打回额度用完后没把状态如实标成没做完：" + r.stopped);
    assert(/还没打勾的是/.test(r.finalText) && /写第二章/.test(r.finalText), "收尾没告诉用户还差哪几项：" + String(r.finalText).slice(0, 120));

    // ② 负向控制：全打勾 → 一次都不许打回
    fs.writeFileSync(path.join(runDir, "PROGRESS.md"), "- [x] 收集资料\n- [x] 写第二章\n- [x] 导出成品\n");
    h = mk(["三件事都做完了。"]);
    ({ r } = await run(h));
    assert.strictEqual(h.pushbacks.length, 0, "进度档全打勾还被打回——做完的任务会被反复重跑");
    assert.strictEqual(h.calls(), 1, "全打勾时多花了模型调用：" + h.calls());
    assert(!r.stopped, "全打勾还报没做完：" + r.stopped);

    // ③ 负向控制：压根没有进度档（小任务不立档）→ 不许拦
    fs.rmSync(path.join(runDir, "PROGRESS.md"), { force: true });
    h = mk(["查完了，答案是 42。"]);
    ({ r } = await run(h));
    assert.strictEqual(h.pushbacks.length, 0, "没有进度档也被拦下了——简单任务会被凭空多跑几轮");
    assert(!r.stopped, "没有进度档却报没做完：" + r.stopped);

    // ④ 没有进度档，但它自己在结语里承认没做完 → 也要打回；改口说做完了就放行
    h = mk(["报告还没写完，我先停一下。", "全部完成，结果已经给你了。"]);
    ({ r, deltas } = await run(h));
    assert.strictEqual(h.pushbacks.length, 1, "模型自己说没做完却没被打回（或打回后没认它改口）：" + h.pushbacks.length);
    assert(/没做完/.test(h.pushbacks[0]) && !/PROGRESS/.test(h.pushbacks[0].slice(0, 40)), "没有进度档时该走另一套话术");
    assert(!r.stopped, "它改口说做完了，就不该再标成没做完：" + r.stopped);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
  console.log("✅ 收尾闸门：没打勾就不许收摊（打回 2 次后转自动续跑），全打勾/无进度档/无复选框三种负向控制均放行");
}

/**
 * 执行过程那一行：`📄 读 报告.md · 120 行`。
 *
 * 以前过程区每一步长这样：`⚙ read_file` + 一坨 JSON 入参，结果只有一枚红/绿的「完成/失败」。
 * 用户原话是「让我一直看到任务完成情况，不要看太多没有用的东西」——参数是排障才要看的，
 * 「在干什么 + 拿回来多少」才是每一步都该露在外面的。所以这一行由服务端算好随事件下发，
 * 前端只管渲染（回放老会话没有这两个字段，前端退回工具名，不开天窗）。
 *
 * 负向控制在这里格外重要：read_file 的返回是文件内容本身，把它第一行当摘要糊到界面上，
 * 等于把用户文件里的第一句话贴到过程区——既没信息量又漏内容。
 */
function testStepLines() {
  const { toolHeadline, resultOutcome, splitParallelRuns } = require("../agent");

  assert.strictEqual(toolHeadline("read_file", { path: "报告.md" }), "读 报告.md", "读文件那一行不对");
  assert.strictEqual(toolHeadline("run_shell", { command: "npm test\necho done" }), "命令 npm test", "命令只取第一行");
  assert.strictEqual(toolHeadline("web_search", { query: "小红书 标题" }), "搜「小红书 标题」", "搜索词没进那一行");
  assert.strictEqual(toolHeadline("delegate_to_expert", { expert: "文案写手", task: "写稿" }), "委派专家 文案写手", "委派没写清委派给谁");
  assert(/open\.feishu\.cn/.test(toolHeadline("fetch_url", { url: "https://open.feishu.cn/app/x" })), "抓网页没显示域名");
  assert(!/^https?:/.test(toolHeadline("fetch_url", { url: "https://a.com/b" }).replace("抓 ", "")), "协议头是噪声，不该占那一行的地方");
  // 认不出的工具（MCP 连接器）也得说人话，绝不许退回一个光秃秃的工具名
  const mcp = toolHeadline("mcp__notion__search", { query: "季度目标" });
  assert(/季度目标/.test(mcp), "MCP 工具没把入参露出来：" + mcp);
  // 负向控制：一个入参都没有时也得留下动词，不能是空串（空串等于那一行开天窗）
  assert(toolHeadline("write_file", {}).trim().length > 0, "没有入参就吐了个空行");
  assert(toolHeadline("read_file", { path: "/a/very/long/".padEnd(200, "x") + "/末尾文件.md" }).length <= 52, "长路径没截短，会把那一行撑爆");

  assert.strictEqual(resultOutcome("write_file", "已新建 报告.md（4210 字节）", false), "已新建 报告.md（4210 字节）", "写文件该用工具自己那句交代");
  assert.strictEqual(resultOutcome("read_file", "a\nb\nc", false), "3 行", "读文件该报量");
  assert.strictEqual(resultOutcome("list_files", "a.md\nb.md\n\nc.md\n", false), "3 项", "列目录该报条数（空行不算）");
  assert.strictEqual(resultOutcome("web_search", "1. x https://a.com\n2. y https://b.com", false), "2 条结果", "搜索该报结果条数");
  assert(/没有这个文件/.test(resultOutcome("read_file", "读取失败：没有这个文件", true)), "失败没把原因端到行上，用户还得一张张点开");
  // 负向控制：文件内容不许当摘要——那一行会变成用户文件里的第一句话
  const dataLike = resultOutcome("read_file", "这是我的私人日记第一行\n第二行", false);
  assert(!/私人日记/.test(dataLike), "把文件正文当成结果摘要贴到界面上了：" + dataLike);
  assert.strictEqual(resultOutcome("read_file", "   ", false), "没有内容返回", "空结果该明说，不是留白");

  // ---- 只读段并发：段内并发、段间保序 ----
  const RO = ["read_file", "list_files", "web_search"];
  const seq = [{ name: "web_search" }, { name: "read_file" }, { name: "write_file" }, { name: "list_files" }, { name: "web_search" }];
  const groups = splitParallelRuns(seq, RO);
  assert.deepStrictEqual(
    groups.map((g) => g.map((t) => t.name)),
    [["web_search", "read_file"], ["write_file"], ["list_files", "web_search"]],
    "连续只读段没切对：" + JSON.stringify(groups.map((g) => g.map((t) => t.name)))
  );
  // 负向控制①：写工具各自单跑，绝不合并——它们的先后顺序本身就是语义
  assert.strictEqual(splitParallelRuns([{ name: "write_file" }, { name: "edit_file" }], RO).length, 2, "两个写工具被并到一段了，会并发跑，先后顺序就废了");
  // 负向控制②：切段不许挪动任何一个调用的位置
  assert.deepStrictEqual(groups.flat().map((t) => t.name), seq.map((t) => t.name), "切段把调用顺序打乱了");
  assert.deepStrictEqual(splitParallelRuns([], RO), [], "空批次该原样返回空");
  console.log("✅ 执行过程一行流：动词+对象+结果量（长路径截短·MCP 不开天窗·失败报原因），文件正文不当摘要；只读段并发且段间保序（写工具单跑=负向控制）");
}

/**
 * 真跑一轮，验这一行确实随事件下发、并发确实只吃连续只读段。
 * 上面那个是纯函数测试，这个测的是「接线接上了没有」——两者少一个都可能是绿着的坏。
 */
async function testStepLinesWired() {
  const DIR = "e2e-line-run";
  const runDir = path.join(WORKSPACE, DIR);
  try {
    fs.mkdirSync(runDir, { recursive: true });
    let turn = 0;
    const fake = {
      provider: "mock",
      model: "scripted",
      async chat() {
        if (turn++) return { text: "看完了。", toolCalls: [], stopReason: "end" };
        return {
          text: "我先看看现场。",
          toolCalls: [
            { id: "a1", name: "list_files", input: { path: "." } },
            { id: "a2", name: "list_files", input: { path: "." } },
            { id: "a3", name: "write_file", input: { path: "线.txt", content: "hi" } },
          ],
          stopReason: "tool_use",
        };
      },
    };
    const evs = [];
    await createAgentRuntime({ config, llm: fake, mcpManager: new McpManager(), experts: [] }).runTask({
      history: [{ role: "user", content: "看看现场再写个文件" }],
      emit: (ev) => evs.push(ev),
      baseDir: DIR,
    });
    const uses = evs.filter((e) => e.type === "tool_use");
    const results = evs.filter((e) => e.type === "tool_result");
    assert.strictEqual(uses.length, 3, "工具事件数不对：" + uses.length);
    assert(uses.every((u) => u.title && u.title.trim()), "有工具事件没带那一行：" + JSON.stringify(uses.map((u) => u.title)));
    assert(/^写 线\.txt$/.test(uses[2].title), "写文件那一行不对：" + uses[2].title);
    assert(results.every((r) => typeof r.outcome === "string" && r.outcome), "有结果事件没带结果摘要：" + JSON.stringify(results.map((r) => r.outcome)));
    // 前两个只读的并发跑了，写文件单独一段（所以并发事件只有一条、count=2）
    const par = evs.filter((e) => e.type === "parallel");
    assert.strictEqual(par.length, 1, "并发段数不对（写工具不该被并进去）：" + par.length);
    assert.strictEqual(par[0].count, 2, "并发只该吃前两个只读调用：" + par[0].count);
    assert(fs.existsSync(path.join(runDir, "线.txt")), "写文件没真跑到——切段把它漏了");
    console.log("✅ 执行行接线：tool_use 带 title、tool_result 带 outcome，混合批次里前两个只读并发、写文件仍旧单跑并落盘");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function testLarkCliParse() {
  const L = require("../lark-cli");

  // ---- config show：真实输出是 JSON + 空行 + 「Config file path: …」 ----
  const real = '{\n  "appId": "cli_a1b2c3d4",\n  "appSecret": "s3cret",\n  "brand": "feishu"\n}\n\n  Config file path: /home/u/.lark-cli/config.json\n';
  const cfg = L.parseConfigShow(real);
  assert(cfg && cfg.appId === "cli_a1b2c3d4" && cfg.appSecret === "s3cret", "config show 的正常输出没解出来");
  // 前面糊了一行 npm 的噪声也得能救回来
  const noisy = 'npm WARN 什么什么\n{"appId":"cli_x","appSecret":"y"}\n\nConfig file path: /x\n';
  assert.strictEqual((L.parseConfigShow(noisy) || {}).appId, "cli_x", "前缀噪声没被跳过");
  // 负向控制：没绑应用 / 报错 / 空 —— 一律 null，绝不能返回半个对象让上层当成「拿到凭证了」
  assert.strictEqual(L.parseConfigShow(""), null, "空输出该返回 null");
  assert.strictEqual(L.parseConfigShow("Error: no app configured"), null, "报错文本该返回 null");
  assert.strictEqual(L.parseConfigShow("{ 这不是 json"), null, "半截 JSON 该返回 null");

  // ---- 验证链接：从一大坨日志里抠出来，尾随的中文标点得削掉 ----
  const log = "请在浏览器中打开以下链接完成验证：https://open.feishu.cn/app/verify?token=abc123。\n等待中...\n";
  assert.strictEqual(L.verifyUrlOf(log), "https://open.feishu.cn/app/verify?token=abc123", "验证链接没抠干净：" + L.verifyUrlOf(log));
  assert(/larksuite\.com/.test(L.verifyUrlOf("go https://open.larksuite.com/x/y now")), "国际版域名没认");
  // 负向控制：别的域名不能冒充（不然会把用户往陌生站点上引）
  assert.strictEqual(L.verifyUrlOf("https://example.com/app/verify"), "", "非飞书域名被当成验证链接了");
  assert.strictEqual(L.verifyUrlOf(""), "", "空输入该返回空串");

  // ---- app_secret 到底能不能用：lark-cli 在 macOS 上把它锁进系统钥匙串，config show 只回 "****" ----
  // 这是真踩过的坑：那串掩码要是被当成凭证存下来，用户原本能用的 secret 就被顶掉了，
  // 界面还显示「已保存」，连接却报 10014 —— 比直接失败更难查。
  assert.strictEqual(L.usableSecret("****"), false, "星号掩码被当成了真 secret");
  assert.strictEqual(L.usableSecret("••••••••"), false, "圆点掩码没挡住");
  assert.strictEqual(L.usableSecret({ source: "keychain", id: "abc" }), false, "钥匙串引用（对象）没挡住");
  assert.strictEqual(L.usableSecret(""), false, "空串没挡住");
  assert.strictEqual(L.usableSecret(undefined), false, "undefined 没挡住");
  assert.strictEqual(L.usableSecret("s3cret"), false, "太短的串不该被当成飞书 app_secret");
  assert.strictEqual(L.usableSecret("a".repeat(32)), true, "32 位的真 secret 被误杀了");
  assert(/钥匙串/.test(L.SECRET_LOCKED_HINT) && /粘/.test(L.SECRET_LOCKED_HINT), "读不出来时的提示没说清下一步该干嘛");

  // ---- 凭证页直链：让用户少在开放平台里翻两层 ----
  assert.strictEqual(L.appConsoleUrl("cli_a1b2", "feishu"), "https://open.feishu.cn/app/cli_a1b2/baseinfo", "国内版凭证页链接拼错了");
  assert(/open\.larksuite\.com/.test(L.appConsoleUrl("cli_a1b2", "lark")), "国际版没走 larksuite 域名");
  // 负向控制：app_id 长得不对就别拼链接，免得把用户引到一个乱七八糟的地址
  assert.strictEqual(L.appConsoleUrl("", "feishu"), "", "空 app_id 不该拼出链接");
  assert.strictEqual(L.appConsoleUrl("../../evil", "feishu"), "", "路径穿越样子的 app_id 不该拼出链接");

  // ---- 报错翻译：给的是「下一步怎么办」，不是 stderr ----
  assert(/重启/.test(L.explainLarkError("Agent workspace detected: OPENCLAW_HOME is set")), "Agent 环境那条没翻成人话");
  assert(/管理员|权限/.test(L.explainLarkError("app registration failed: permission denied")), "建应用失败没说清是权限问题");
  assert(/装/.test(L.explainLarkError("spawn lark-cli ENOENT")), "没装 lark-cli 没给安装指引");
  assert(/重新点/.test(L.explainLarkError("context deadline exceeded")), "超时没告诉用户重试");
  assert(/没有返回内容/.test(L.explainLarkError("")), "空输入没兜底");
  // 认不出来的原样给（截断），但不能是空 —— 用户至少得看见点东西
  const weird = L.explainLarkError("some brand new failure from upstream");
  assert(weird && weird.length > 0 && !/undefined/.test(weird), "认不出的错误被吞了：" + weird);

  console.log("✅ lark-cli 解析：config show 带尾巴/带噪声都吃得下 · 钥匙串掩码不当凭证 · 只认飞书域名的链接 · 报错翻成下一步怎么办");
}

/**
 * 「从 lark-cli 导凭证」不许把一串掩码当成 app_secret 存进去。
 *
 * 背景：飞书机器人必须有 app_id + app_secret。lark-cli 能替用户把应用建出来，
 * 但它的 secret 是**只进不出**的 —— macOS 上默认锁在系统钥匙串里，
 * `lark-cli config show` 只回 `"appSecret": "****"`（config.json 里存的是
 * `{source:"keychain", id:...}` 这样一个引用，不是密钥本身）。
 *
 * 一开始的实现直接把 cfg.appSecret 搬进 config.im.feishu，于是：
 * 用户原来能用的 secret 被 `****` 顶掉 → 界面显示「已保存」→ 连接报 10014。
 * 比直接失败更难查，所以这条测试的重点是那个负向对照：
 * **导入失败之后，原来的 secret 必须一个字节都没变。**
 *
 * 做法：往 PATH 前面塞一个假的 lark-cli（一个 sh 脚本），由一个 mode 文件控制它
 * 返回掩码还是明文，这样同一个 server 进程里能把两条路都走一遍。
 */
async function testLarkSecretNotClobbered() {
  if (process.platform === "win32") { console.log("⏭  lark-cli 导入守卫：Windows 上跳过（假 lark-cli 是 sh 脚本）"); return; }
  const http = require("http");
  const { spawn } = require("child_process");
  const crypto = require("crypto");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-larksec-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "owb-larkbin-"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  // 假 lark-cli：只认 --version 和 config show，其余一律失败（真 CLI 也不该被这条测试碰）
  const PLAIN = "P".repeat(32);
  fs.writeFileSync(path.join(bin, "mode"), "masked");
  fs.writeFileSync(path.join(bin, "lark-cli"), `#!/bin/sh
MODE=$(cat "$(dirname "$0")/mode")
if [ "$1" = "--version" ]; then echo "1.0.68"; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "show" ]; then
  if [ "$MODE" = "masked" ]; then
    printf '{\\n  "appId": "cli_fakelocked",\\n  "appSecret": "****",\\n  "brand": "feishu"\\n}\\n\\n  Config file path: /tmp/fake\\n'
  else
    printf '{\\n  "appId": "cli_fakeplain",\\n  "appSecret": "${PLAIN}",\\n  "brand": "feishu"\\n}\\n\\n  Config file path: /tmp/fake\\n'
  fi
  exit 0
fi
echo "fake lark-cli: unsupported $*" >&2
exit 1
`);
  fs.chmodSync(path.join(bin, "lark-cli"), 0o755);

  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, OPENWORKBUDDY_HOME: home, PORT: String(port), HOST: "127.0.0.1", PATH: bin + path.delimiter + process.env.PATH },
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
  const feishuOnDisk = () => (JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).im || {}).feishu || {};

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + log.slice(-400));

    const GOOD = "G".repeat(32);
    const w = await req("POST", "/api/settings", { im: { feishu: { app_id: "cli_mine0001", app_secret: GOOD } } });
    assert(w.code === 200, "凭证存不进去（HTTP " + w.code + "）");
    assert.strictEqual(feishuOnDisk().app_secret, GOOD, "前置条件不成立：凭证没落盘");

    // 探测接口得如实说「有应用、但 secret 读不出来」，而不是含糊成「没配」
    const probe = await req("GET", "/api/feishu/lark-cli");
    assert(probe.json && probe.json.installed === true, "假 lark-cli 没被认出来（HTTP " + probe.code + " " + probe.body.slice(0, 200) + "）");
    assert.strictEqual(probe.json.app_id, "cli_fakelocked", "app_id 没读到");
    assert.strictEqual(probe.json.has_secret, false, "掩码被当成「有 secret」了 —— 前端会亮出导入按钮，点了就把好凭证冲掉");
    assert.strictEqual(probe.json.secret_locked, true, "没告诉前端 secret 是被锁住而不是没有");

    // ★事故复现 + 负向对照★ 硬点导入：必须拒绝，而且原来的凭证一个字节都不能变
    const bad = await req("POST", "/api/feishu/lark-cli/import");
    assert.strictEqual(bad.code, 400, "掩码 secret 居然导入成功了（HTTP " + bad.code + "）");
    assert(bad.json && bad.json.secret_locked === true, "拒绝了但没说清是「锁住」：" + bad.body.slice(0, 200));
    assert(/钥匙串/.test((bad.json || {}).error || ""), "报错没说人话：" + bad.body.slice(0, 200));
    assert(/open\.feishu\.cn\/app\/cli_fakelocked/.test((bad.json || {}).console_url || ""), "没给凭证页直链，用户得自己去后台翻");
    const after = feishuOnDisk();
    assert.strictEqual(after.app_secret, GOOD, "★凭证被掩码顶掉了★ 这正是要防的事故");
    assert.strictEqual(after.app_id, "cli_mine0001", "app_id 被单独改了 —— 跟旧 secret 配成一对错的，连上去只会报 10014");

    // 正向对照：真读得出明文（老版本 / 非 macOS 就是这样）的时候，导入照常走通
    fs.writeFileSync(path.join(bin, "mode"), "plain");
    const okr = await req("POST", "/api/feishu/lark-cli/import");
    assert.strictEqual(okr.code, 200, "明文 secret 反倒导不进来（HTTP " + okr.code + " " + okr.body.slice(0, 200) + "）—— 守卫收得太紧");
    const now = feishuOnDisk();
    assert.strictEqual(now.app_id, "cli_fakeplain", "明文那条没把 app_id 换过来");
    assert.strictEqual(now.app_secret, PLAIN, "明文那条没把 secret 换过来");

    console.log("✅ lark-cli 导凭证：钥匙串掩码一律拒绝且不动原凭证 · 如实回报「锁住」并给凭证页直链 · 明文照常导入");
  } finally {
    try { child.kill(); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(bin, { recursive: true, force: true }); } catch {}
  }
}
/**
 * 改个技能名字，不该把技能改废（skills.js 的 saveSkill）。
 *
 * 从 GitHub 装来的技能几乎都是一整棵树：skill.md 旁边还有 references/、scripts/、templates/。
 * 以前改名走的是「在新目录里写一份 skill.md，然后 rmSync 掉旧目录」——那些资源当场全没，
 * 而且一声不响：界面上技能还在、内容也对，直到某天 agent 跑到一半报「文件不存在」。
 * 「装个技能，觉得名字不好听改一下」是最自然的一条路径，正好也是把它废掉的那条。
 *
 * 真读真写磁盘：另起一个进程把 OPENWORKBUDDY_HOME 指到临时目录（skills.js 的 SKILLS_DIR 是
 * require 时定死的，同进程里改不动），这样一个字节都不碰仓库里真正的 skills/。
 */
function testSkillRenameKeepsAssets() {
  const os = require("os");
  const { spawnSync } = require("child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-skillmv-"));
  try {
    const mk = (name, extra) => {
      const d = path.join(home, "skills", name);
      fs.mkdirSync(path.join(d, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(d, "references"), { recursive: true });
      fs.writeFileSync(path.join(d, "skill.md"), `---\nname: ${name}\ndescription: 拿来测改名的\n---\n\n正文\n`);
      fs.writeFileSync(path.join(d, "scripts", "run.py"), "print('hi')\n");
      fs.writeFileSync(path.join(d, "references", "手册.md"), "# 手册\n");
      if (extra) fs.writeFileSync(path.join(d, extra), "x");
    };
    mk("old-name");
    mk("occupied"); // 用来验重名不许悄悄覆盖

    const run = (code) => {
      const r = spawnSync(process.execPath, ["-e", code], {
        encoding: "utf8",
        env: { ...process.env, OPENWORKBUDDY_HOME: home, ELECTRON_RUN_AS_NODE: "1" },
        cwd: path.join(__dirname, ".."),
      });
      return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
    };
    const call = (arg) =>
      run(`const s=require("./skills");try{const r=s.saveSkill(${JSON.stringify(arg)});console.log(JSON.stringify({ok:true,name:r&&r.name}))}catch(e){console.log(JSON.stringify({ok:false,error:e.message}))}`);

    // ---- 正常改名：资源必须原地跟着走 ----
    let r = JSON.parse(call({ name: "new-name", description: "改过名的", content: "新正文", original_name: "old-name" }).out);
    assert.ok(r.ok, "改名本身就失败了：" + r.error);
    const nd = path.join(home, "skills", "new-name");
    assert.ok(!fs.existsSync(path.join(home, "skills", "old-name")), "旧目录还在，改名等于复制了一份");
    assert.ok(fs.existsSync(path.join(nd, "scripts", "run.py")),
      "★改个名字把技能自带的 scripts/ 删了★ 技能还在列表里，跑起来 agent 报「文件不存在」");
    assert.ok(fs.existsSync(path.join(nd, "references", "手册.md")), "★references/ 被改名那一下删掉了★");
    const fm = fs.readFileSync(path.join(nd, "skill.md"), "utf8");
    assert.ok(/name: new-name/.test(fm) && /新正文/.test(fm), "skill.md 没按新名字新内容写");

    // ---- 重名：不许悄悄合进别人的目录 ----
    r = JSON.parse(call({ name: "occupied", description: "撞名", content: "正文", original_name: "new-name" }).out);
    assert.ok(!r.ok && /已经有一个叫/.test(r.error || ""), "改成一个已存在的技能名，居然放行了（会把那个技能的 skill.md 顶掉）");
    assert.ok(fs.existsSync(path.join(home, "skills", "occupied", "scripts", "run.py")), "撞名被拒之后，人家的资源被动了");
    assert.ok(fs.existsSync(path.join(nd, "scripts", "run.py")), "撞名被拒之后，自己的资源也没了");
    assert.ok(/description: 拿来测改名的/.test(fs.readFileSync(path.join(home, "skills", "occupied", "skill.md"), "utf8")),
      "撞名被拒，但人家的 skill.md 已经被覆盖了");

    // ---- 只改内容不改名：目录原样，资源原样（反向对照，别把改名的修法修成「什么都不许动」）----
    r = JSON.parse(call({ name: "new-name", description: "只改内容", content: "第二版", original_name: "new-name" }).out);
    assert.ok(r.ok, "只改内容也失败了：" + r.error);
    assert.ok(fs.existsSync(path.join(nd, "scripts", "run.py")) && /第二版/.test(fs.readFileSync(path.join(nd, "skill.md"), "utf8")),
      "只改内容时正文没落盘 / 资源被动了");

    // ---- 新建技能：没有旧目录这条路也得通 ----
    r = JSON.parse(call({ name: "brand-new", description: "新建的", content: "内容" }).out);
    assert.ok(r.ok && fs.existsSync(path.join(home, "skills", "brand-new", "skill.md")), "新建技能这条路被改名逻辑挡住了：" + r.error);

    console.log("✅ 技能改名不掉资源：整目录搬家（scripts/references 全在）· 撞名当场拒绝且两边都不动 · 只改内容/新建两条路照通");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Windows 上本机引擎起不起得来（engines/win.js）。
 *
 * 这条是「不少朋友下载之后打不开」里最硬的一块：npm 在 Windows 上装出来的不是可执行文件，
 * 是 claude.cmd 这种垫片，而 Node 从 18.20.2（CVE-2024-27980）起直接 spawn .cmd 一律 EINVAL。
 * 于是 Windows 用户那边是：设置页两条引擎都写「本机没装」（三个探测全 EINVAL），
 * 硬填绝对路径也一样，点一次报一次「跑不起来」——看着就是这软件不支持 Windows。
 *
 * 常规解法是转给 cmd.exe，但 cmd 的命令行有 8191 字符上限，而我们要传的
 * --append-system-prompt 是上万字还带换行的系统提示词，必然截断。所以主路是把垫片拆开、
 * 直接 spawn 里面那个 node + cli.js，参数按 argv 原样过去。
 *
 * 本机是 macOS，跑不了真 Windows，所以这里测的是「决定 spawn 什么」这一步：
 * 注入 win=true 和一份假文件系统，断言算出来的 bin/args/opts。
 */
function testWindowsLaunch() {
  const winmod = require("../engines/win");

  const NPM_SHIM = [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', ")", "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join("\r\n");
  const PNPM_SHIM = [
    "@SETLOCAL", "@SET PATHEXT=%PATHEXT:;.JS;=;%",
    'node  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join("\r\n");

  // 假文件系统：键按 Windows 规矩（不区分大小写）
  const fakeIo = (files) => {
    const k = (f) => path.win32.normalize(String(f)).toLowerCase();
    const has = (f) => Object.prototype.hasOwnProperty.call(files, k(f));
    return {
      readFileSync: (f) => { if (!has(f)) throw new Error("ENOENT"); return files[k(f)]; },
      statSync: (f) => { if (!has(f)) throw new Error("ENOENT"); return { isFile: () => true }; },
    };
  };
  const WHICH = { findIn: () => "C:\\Program Files\\nodejs\\node.exe", searchDirs: () => [] };

  // ---- 1) 别的系统上，行为一个字节都不许变 ----
  const nix = winmod.launchPlan("/opt/homebrew/bin/claude", ["-p", "hi"], { win: false });
  assert.strictEqual(nix.bin, "/opt/homebrew/bin/claude", "非 Windows 上不该改动 bin");
  assert.deepStrictEqual(nix.args, ["-p", "hi"], "非 Windows 上不该改动参数");
  assert.strictEqual(nix.opts.detached, true, "★非 Windows 丢了 detached：停止任务时杀不掉整棵进程树，CLI 派生的 bash/python 变孤儿继续写文件★");
  assert.ok(!("windowsHide" in nix.opts), "非 Windows 不该塞 windows 专用参数");

  // ---- 2) Windows 上的 .exe：直接起，但不许 detached（会弹一个控制台黑窗口） ----
  const exe = winmod.launchPlan("C:\\tools\\codex.exe", ["exec"], { win: true, io: fakeIo({}), which: WHICH });
  assert.strictEqual(exe.how, "直接");
  assert.strictEqual(exe.bin, "C:\\tools\\codex.exe");
  assert.deepStrictEqual(exe.args, ["exec"]);
  assert.ok(!exe.opts.detached, "★Windows 上 detached 会给子进程开一个自己的控制台窗口：每跑一个任务弹一个黑框★");
  assert.strictEqual(exe.opts.windowsHide, true, "没关窗口，用户屏幕上会闪黑框");

  // ---- 3) npm 垫片：拆开，参数原样过去 ----
  const SHIM = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
  const CLI = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  const SYS = "你是助手\n第二行 带\"引号\" 和 & | ^ 这些字符\n" + "很长的系统提示词。".repeat(1200); // >8191，走 cmd 必炸
  const npmPlan = winmod.launchPlan(SHIM, ["-p", "--append-system-prompt", SYS], {
    win: true, io: fakeIo({ [SHIM.toLowerCase()]: NPM_SHIM, [CLI.toLowerCase()]: "" }), which: WHICH,
  });
  assert.strictEqual(npmPlan.how, "拆垫片", "★npm 的 claude.cmd 没拆开——直接 spawn .cmd 在 Node 18.20.2+ 上一律 EINVAL★");
  assert.strictEqual(npmPlan.bin, "C:\\Program Files\\nodejs\\node.exe", "没去 PATH 上找 node");
  assert.deepStrictEqual(npmPlan.args, [CLI, "-p", "--append-system-prompt", SYS],
    "★参数没原样传：系统提示词上万字又带换行，经 cmd 转发必然截断/失败★");
  assert.ok(SYS.length > winmod.CMD_MAX, "这个用例的前提没成立：系统提示词本该超过 cmd 的上限");
  assert.strictEqual(npmPlan.warn, "", "拆垫片这条路不过 shell，不该有长度警告");

  // 垫片旁边自带 node.exe（nvm-windows / 便携版）时优先用它，跟垫片自己的逻辑一致
  const sib = "C:\\Users\\me\\AppData\\Roaming\\npm\\node.exe";
  const withSib = winmod.launchPlan(SHIM, [], {
    win: true, io: fakeIo({ [SHIM.toLowerCase()]: NPM_SHIM, [CLI.toLowerCase()]: "", [sib.toLowerCase()]: "" }), which: WHICH,
  });
  assert.strictEqual(withSib.bin, sib, "垫片旁边就有 node.exe 却不用，跑去 PATH 上找");

  // 机器上压根没装 node：用自己这个进程当 node（桌面版里是 Electron，要 RUN_AS_NODE）
  const noNode = winmod.launchPlan(SHIM, [], {
    win: true, io: fakeIo({ [SHIM.toLowerCase()]: NPM_SHIM, [CLI.toLowerCase()]: "" }),
    which: { findIn: () => "", searchDirs: () => [] },
  });
  assert.strictEqual(noNode.bin, process.execPath, "★没单独装 node 就彻底起不来了——自己这个进程就是 node★");
  assert.strictEqual(noNode.env.ELECTRON_RUN_AS_NODE, "1", "★桌面版里 execPath 是 Electron 本体，不加这个会再弹一个应用实例出来★");

  // ---- 4) pnpm / yarn 的 .bin 垫片（%~dp0 写法、相对上级目录）也得拆得开 ----
  const PSHIM = "C:\\proj\\node_modules\\.bin\\claude.cmd";
  const PCLI = "C:\\proj\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  const pnpmPlan = winmod.launchPlan(PSHIM, ["--help"], {
    win: true, io: fakeIo({ [PSHIM.toLowerCase()]: PNPM_SHIM, [PCLI.toLowerCase()]: "" }), which: WHICH,
  });
  assert.strictEqual(pnpmPlan.how, "拆垫片", "pnpm/yarn 那种 %~dp0\\.. 写法的垫片没拆开");
  assert.deepStrictEqual(pnpmPlan.args, [PCLI, "--help"]);

  // 垫片认得出、但它指的 js 已经不在了（装了一半 / 被杀毒删了）→ 不能硬编一个不存在的路径
  const gone = winmod.launchPlan(SHIM, ["-p"], { win: true, io: fakeIo({ [SHIM.toLowerCase()]: NPM_SHIM }), which: WHICH });
  assert.strictEqual(gone.how, "cmd 兜底", "垫片指的 js 不存在时还硬拿它去 spawn，报的错跟真实原因对不上");

  // ---- 5) 认不出的垫片 → cmd.exe 兜底，按 cmd 的规矩转义 ----
  const odd = winmod.launchPlan("C:\\tools\\my agent.cmd", ["-p", "a b", 'say "hi" & del *'], {
    win: true, io: fakeIo({ "c:\\tools\\my agent.cmd": "@echo off\r\nrem 自己写的批处理" }), which: WHICH,
  });
  assert.strictEqual(odd.how, "cmd 兜底");
  assert.strictEqual(odd.bin, process.env.ComSpec || "cmd.exe");
  assert.deepStrictEqual(odd.args.slice(0, 3), ["/d", "/s", "/c"], "cmd 的参数形状不对");
  assert.strictEqual(odd.opts.windowsVerbatimArguments, true, "★不加 verbatim，Node 会再包一层引号，整条命令行就废了★");
  const line = odd.args[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'), "★整条命令没被外层引号包住：cmd /s 靠这对引号判边界★");
  assert.ok(/\^&/.test(line), "★命令里的 & 没挡住：cmd 会把它当命令分隔符，后半截当成另一条命令执行★");
  assert.ok(/\^ /.test(line), "★带空格的参数没挡住：会被拆成两个参数★");
  assert.ok(!/(^|[^\^])"hi"/.test(line), "参数里的引号没转义");

  // 整条命令行钉死一次：元字符要挡两道（.cmd 会被 cmd 解析两遍——一遍是命令行本身，
  // 一遍是垫片里 %* 展开的时候），少挡一道，参数里的空格/& 到了第二遍照样把命令劈开
  const pinned = winmod.launchPlan("C:\\tools\\my agent.cmd", ["-p", "a b"], {
    win: true, io: fakeIo({ "c:\\tools\\my agent.cmd": "@echo off" }), which: WHICH,
  });
  assert.strictEqual(pinned.args[3], '"^"C:\\tools\\my^ agent.cmd^" ^^^"-p^^^" ^^^"a^^^ b^^^""',
    "★cmd 命令行拼得不对：命令本身挡一道、参数挡两道（.cmd 要过两遍解析），差一道参数就被劈开★");

  // 兜底这条路有 8191 的硬上限，超了要当场说清，别让用户对着 cmd 的乱码错猜
  const long = winmod.launchPlan("C:\\tools\\my agent.cmd", ["-p", "x".repeat(9000)], {
    win: true, io: fakeIo({ "c:\\tools\\my agent.cmd": "@echo off" }), which: WHICH,
  });
  assert.ok(/8191/.test(long.warn), "★参数超过 cmd 上限却一声不吭：失败了没人知道是长度的问题★");

  // ---- 6) 收尾：Windows 没有进程组，得 taskkill /T ----
  const calls = [];
  const fakeSpawn = (bin, args) => { calls.push([bin, ...args].join(" ")); return { on() {} }; };
  winmod.killTree({ pid: 4242 }, "SIGTERM", { win: true, spawn: fakeSpawn });
  winmod.killTree({ pid: 4242 }, "SIGKILL", { win: true, spawn: fakeSpawn });
  assert.deepStrictEqual(calls, ["taskkill /pid 4242 /T", "taskkill /pid 4242 /T /F"],
    "★Windows 上用 process.kill(-pid) 杀不掉进程树（负 pid 根本不是合法参数）：点了停止，CLI 派生的一堆子进程还在跑、还在写文件★");
  let nixKill = null;
  const realKill = process.kill;
  process.kill = (pid, sig) => { nixKill = [pid, sig]; };
  try { winmod.killTree({ pid: 777 }, "SIGTERM", { win: false, spawn: fakeSpawn }); } finally { process.kill = realKill; }
  assert.deepStrictEqual(nixKill, [-777, "SIGTERM"], "非 Windows 上不再按进程组杀了");

  // ---- 7) 接线：算得再对，jsonl.js 不用也是白搭 ----
  const src = fs.readFileSync(path.join(__dirname, "..", "engines", "jsonl.js"), "utf8");
  assert.strictEqual((src.match(/win\.launchPlan\(/g) || []).length, 4,
    "engines/jsonl.js 里有 spawn 没走 launchPlan：跑任务、探版本、探选项、探 --help 四处都得走，少一处 Windows 上就少一处能用");
  assert.ok(!/spawn\(bin,/.test(src), "★还有地方直接 spawn 那个 .cmd：Node 会当场 EINVAL★");
  assert.ok(!/process\.kill\(-child\.pid/.test(src), "★还在按进程组杀：Windows 上这句必抛★");

  console.log("✅ Windows 起得来本机引擎：npm/pnpm 垫片拆开直接跑 node（上万字系统提示词原样过 argv）· 没装 node 用自己 · 认不出才退 cmd 并按规矩转义 + 超 8191 明说 · 收尾走 taskkill /T · 别的系统一个字节没变");
}

/**
 * 内存里的会话副本会不会吃陈（server.js 的 getSession / saveSession）。
 *
 * 桌面版和命令行的 wb 写的是同一批文件（data/sessions/<id>.json），而 `wb resume` 不给 id 时
 * 接的就是「最近动过的那条」，包括桌面上刚开的那个——这是它自己注释里写的「丝滑切换」的落点。
 * 可 server.js 这边的 sessions Map 一旦读进来就再也不回头看盘：
 * 「桌面开个头 → 终端 wb resume 接着做几轮 → 回桌面再发一句」，
 * 桌面那一句存盘时用的还是几小时前那份内存副本，终端做的那几轮整段消失。
 * 用户看到的是「我在终端做的那半截凭空没了」，而且没有任何报错。
 *
 * 跟 testSessionIndex 一样切真源码在临时目录上跑：这两个函数是纯的，
 * 注入 fs/path/store/SESS_DIR/sessions/activeRuns 就能真读真写磁盘。
 */
function testSessionCacheReload() {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const a = src.indexOf("function sessFile(id) {");
  const b = src.indexOf("const sessMetaCache = new Map();", a);
  if (a < 0 || b <= a) throw new Error("server.js 里的会话读写找不到了（改名/挪走？），测试没法定位真源码");
  const SLICE = src.slice(a, b);

  const store = require(path.join(__dirname, "..", "store.js"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-sesscache-"));
  const SESS_DIR = path.join(home, "sessions");
  fs.mkdirSync(SESS_DIR, { recursive: true });

  // loose=true：把「回头看一眼盘」那段整块摘掉，还原成改之前的行为（阴性对照）
  const RELOAD = /\n *if \(sessions\.has\(id\) && !activeRuns\.has\(id\) && sessChangedOnDisk\(id\)\)[\s\S]*?sessions\.delete\(id\);\n *\}\n/;
  const build = (loose) => {
    const sessions = new Map();
    const activeRuns = new Map();
    let body = SLICE;
    if (loose) {
      assert.ok(RELOAD.test(body), "阴性对照对不上源码了：想摘掉的那段「回头看盘」没找到");
      body = body.replace(RELOAD, "\n");
    }
    const M = new Function("fs", "path", "SESS_DIR", "store", "sessions", "activeRuns", "console",
      body + "\nreturn { getSession, saveSession, sessFile };")(
      fs, path, SESS_DIR, store, sessions, activeRuns, { log() {} });
    return { ...M, sessions, activeRuns };
  };

  const id = "s_1730000000000_abc";
  const file = path.join(SESS_DIR, id + ".json");
  const H = (...xs) => xs.map((c, i) => ({ role: i % 2 ? "assistant" : "user", content: c }));

  // 1) 桌面开了这条会话
  store.writeJsonAtomic(file, { history: H("帮我整理下装修报价"), transcript: [], title: "装修报价", updated_at: null });
  const wb = build(false);
  const s1 = wb.getSession(id);
  assert.strictEqual(s1.history.length, 1, "第一次读盘就没读对");

  // 2) 用户切到终端，wb resume 接着做了两轮，直接写同一个文件
  store.writeJsonAtomic(file, { history: H("帮我整理下装修报价", "拆成了三张表", "再加一列单价"), transcript: [], title: "装修报价", updated_at: null });
  const s2 = wb.getSession(id);
  assert.strictEqual(s2.history.length, 3, "★命令行 wb 写进去的那几轮，桌面这边看不见（内存副本一直没回头看盘）★");

  // 3) 回桌面再发一句 —— 终端那两轮必须还在
  s2.history.push({ role: "assistant", content: "单价加好了" });
  wb.saveSession(id);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(onDisk.history.length, 4, "★桌面这边一存盘，就把命令行做的那几轮整段盖掉了★");
  assert.ok(onDisk.history.some((h) => h.content === "拆成了三张表"), "终端那轮的内容没了");

  // 4) 自己刚写完的盘不算「别人改的」：不然每次存完盘都要白读一遍，
  //    手上那份内存对象一换引用，正在拼的那一轮就跟着丢
  assert.strictEqual(wb.getSession(id), s2, "★自己刚写进去的盘被当成别人改的，下一次取会话就把手上这份换掉——正在拼的那轮跟着丢★");
  assert.strictEqual(wb.sessions.get(id), s2, "内部状态对不上");

  // 4b) 只比 mtime 或只比体积都会漏。这两个用例分别把另一半钉死：
  //     改了内容但字数正好一样（体积不变，只有 mtime 变）
  const T = 1730000000.5; // 固定到微秒，两次 utimes 设出来的 mtime 完全相同
  const stamp = () => { fs.utimesSync(file, T, T); return fs.statSync(file).mtimeMs; };
  store.writeJsonAtomic(file, { history: H("甲甲甲"), transcript: [], title: "", updated_at: null });
  const wb2 = build(false);
  const sizeA = fs.statSync(file).size;
  assert.strictEqual(wb2.getSession(id).history[0].content, "甲甲甲", "读盘没读对");
  store.writeJsonAtomic(file, { history: H("乙乙乙"), transcript: [], title: "", updated_at: null });
  assert.strictEqual(fs.statSync(file).size, sizeA, "这个用例的前提没成立：两次内容的字节数本该一样");
  assert.strictEqual(wb2.getSession(id).history[0].content, "乙乙乙",
    "★内容变了但文件大小没变（改了个同长度的字），就当没变过——只比体积会漏★");

  //     体积变了但 mtime 被抹成一样（同一毫秒里连写两次、或者别的进程把时间戳改回去）
  store.writeJsonAtomic(file, { history: H("丙"), transcript: [], title: "", updated_at: null });
  const m0 = stamp();
  const wb3 = build(false);
  assert.strictEqual(wb3.getSession(id).history[0].content, "丙", "读盘没读对");
  store.writeJsonAtomic(file, { history: H("丁", "终端补了一长串"), transcript: [], title: "", updated_at: null });
  const m1 = stamp();
  assert.strictEqual(m1, m0, "这个用例的前提没成立：两次的 mtime 本该被抹成一样");
  assert.strictEqual(wb3.getSession(id).history.length, 2,
    "★mtime 撞上了（原子改名两次落在同一刻）就当没变过——只比 mtime 会漏★");

  // 5) 任务跑着的时候不重读：那份内存对象正被这一轮改着
  store.writeJsonAtomic(file, { history: H("帮我整理下装修报价", "拆成了三张表", "再加一列单价", "单价加好了"), transcript: [], title: "装修报价", updated_at: null });
  const wb4 = build(false);
  const ref = wb4.getSession(id);
  assert.strictEqual(ref.history.length, 4, "读盘没读对");
  wb4.activeRuns.set(id, {});
  ref.history.push({ role: "user", content: "这一轮正在跑" });
  store.writeJsonAtomic(file, { history: [], transcript: [], title: "别处清空了", updated_at: null });
  const during = wb4.getSession(id);
  assert.strictEqual(during, ref, "★任务跑到一半被磁盘上的旧版盖回来了——这一轮的进度直接丢★");
  assert.strictEqual(during.history.length, 5, "跑着那轮自己加的内容没了");
  wb4.activeRuns.delete(id);

  // 6) 盘上压根没有这个 id（新会话）：给空壳，不能炸
  assert.deepStrictEqual(wb.getSession("s_1730000000009_new").history, [], "新会话没给空壳");

  // ---- 阴性对照：摘掉「回头看盘」，第 2 步必须塌 ----
  const id2 = "s_1730000000001_def";
  const f2 = path.join(SESS_DIR, id2 + ".json");
  store.writeJsonAtomic(f2, { history: H("第一句"), transcript: [], title: "", updated_at: null });
  const old = build(true);
  assert.strictEqual(old.getSession(id2).history.length, 1, "阴性对照连第一次读盘都不对");
  store.writeJsonAtomic(f2, { history: H("第一句", "终端答的"), transcript: [], title: "", updated_at: null });
  assert.strictEqual(old.getSession(id2).history.length, 1,
    "阴性对照失灵：把「回头看盘」那段删掉之后测试居然还是过的，说明上面测到的不是这段代码");

  // ---- 接线：删会话时得把这个 id 的印记一起清掉 ----
  assert.ok(/sessions\.delete\(req\.params\.id\);\s*\n\s*sessStamp\.delete\(req\.params\.id\);/.test(src),
    "删会话没清掉 mtime 印记：同一个 id 万一再被建出来，会拿着上一条的尺寸去比对");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("✅ 会话不吃陈内存：命令行 wb 写的几轮桌面能看见、存盘不覆盖；自己写的不误判、跑着的任务不被盘上旧版盖回去");
}

/**
 * 正在跑的那个任务，别人碰不碰得到（server.js 的 sessionAllowed / guardRun 那条线）。
 *
 * 这几条接口跟侧栏那份清单不是一回事：清单管「哪些该显示」，这里管「谁能往里插手」。
 * 插队 / 回答 agent 的提问 / 停止 / 断点续流，走的都是请求体里的 sessionId 或自己的 :id，
 * 绕开了 guardSession。以前它们一个字都没查归属，后果是同一台服务器上的另一个人，
 * 只要拿到一个会话 id（它会出现在链接、日志、截图里，从来不是秘密）就能：
 * 往你正在跑的任务里塞一句话、替你回答那个弹出来的问题、把任务掐掉、把实时输出整段读走。
 *
 * server.js 是 require 就监听的，起不了进程内 HTTP，所以判据这一半切真源码来跑，
 * 接线那一半钉在源码上——两半都要，只测判据的话，函数写对了但路由没调它，照样全线大开。
 */
async function testRunOwnership() {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const a = src.indexOf("function sessionAllowed(user, s) {");
  const b = src.indexOf("let runtime;", a);
  if (a < 0 || b <= a) throw new Error("server.js 里的会话归属判据找不到了（改名/挪走？），测试没法定位真源码");
  const SLICE = src.slice(a, b);

  // 两个组织：boss/staff 在 A，rival/其管理员在 B。canAdmin 只对 role=admin 为真
  const USERS = [
    { username: "boss", role: "admin", org: "A" },
    { username: "staff", role: "member", org: "A" },
    { username: "rivalBoss", role: "admin", org: "B" },
    { username: "rival", role: "member", org: "B" },
  ];
  const account = { canAdmin: (u) => u.role === "admin", _internals: { loadUsers: () => ({ users: USERS }) } };
  const org = { orgIdOf: (u) => (u && u.org) || "" };
  const SESS = new Map([
    ["s_staff", { user: "staff" }],
    ["s_boss", { user: "boss" }],
    ["s_rival", { user: "rival" }],
    ["s_legacy", {}],           // 升级上来的老会话：没记归属
  ]);
  const getSession = (id) => SESS.get(id) || { history: [], transcript: [] }; // 没有的 id 跟真源码一样给空壳
  const M = new Function("account", "org", "getSession", "sessions",
    SLICE + "\nreturn { sessionAllowed, guardSession, guardRun };")(account, org, getSession, SESS);

  const U = (n) => USERS.find((u) => u.username === n);
  const tryRun = (who, id) => {
    let code = 0, body = null;
    const res = { status(c) { code = c; return this; }, json(o) { body = o; return this; } };
    const allowed = M.guardRun({ user: who }, res, id);
    return { allowed, code, body };
  };

  // ---- 判据本身 ----
  assert.ok(tryRun(U("staff"), "s_staff").allowed, "自己的任务被拦了");
  assert.ok(tryRun(U("boss"), "s_staff").allowed, "同组织管理员打不开下属的任务（企业后台要看得到）");
  assert.ok(tryRun(U("staff"), "s_legacy").allowed, "升级上来的老会话（没记归属）被拦了——用户会以为任务丢了");
  assert.ok(tryRun(null, "s_staff").allowed, "没开账号体系（单机一个人用）也被拦了");

  const cross = tryRun(U("rival"), "s_staff");
  assert.ok(!cross.allowed, "★别的组织的人能插手你正在跑的任务★");
  assert.strictEqual(cross.code, 403, "拒绝没给 403：前端会当成「任务不在跑了」而不是「你没权限」");
  assert.ok(cross.body && cross.body.ok === false && /不属于你/.test(cross.body.error || ""),
    "拒绝的回包形状不对（这几条接口的成功回包都是 { ok: true }，失败也得带 ok:false 前端才分得清）");
  assert.ok(!tryRun(U("rivalBoss"), "s_staff").allowed, "★另一个组织的管理员也能插手★ 管理员权限不该跨组织");
  assert.ok(!tryRun(U("staff"), "s_boss").allowed, "普通成员能插手管理员的任务");
  assert.ok(!tryRun(U("staff"), "s_rival").allowed, "普通成员能插手别组织成员的任务");

  // 反向对照：把判据换成「谁都行」，上面那批断言必须全线塌掉——不然测的不是它
  const loose = new Function("account", "org", "getSession", "sessions",
    SLICE.replace("function sessionAllowed(user, s) {", "function sessionAllowed(user, s) { return true;")
      + "\nreturn { guardRun };")(account, org, getSession, SESS);
  assert.ok(loose.guardRun({ user: U("rival") }, { status() { return this; }, json() { return this; } }, "s_staff"),
    "阴性对照没生效：改坏了判据居然还是拒绝，说明上面测到的不是这段代码");

  // ---- 接线：判据写对了，路由不调它等于没有 ----
  const routeOf = (sig, len) => {
    const i = src.indexOf(sig);
    assert.ok(i > 0, `server.js 里找不到路由 ${sig}`);
    return src.slice(i, i + len);
  };
  for (const [sig, what] of [
    ['app.post("/api/chat/interject"', "插队（往别人正在跑的任务里塞一句话）"],
    ['app.post("/api/chat/answer"', "替别人回答 agent 弹出来的问题"],
    ['app.post("/api/chat/stop"', "把别人的任务掐掉"],
    ['app.get("/api/chat/stream/:id"', "把别人的实时输出整段读走"],
  ]) {
    assert.ok(/guardRun\(req, res, /.test(routeOf(sig, 500)), `${sig} 没查归属 → 同一台服务器上的另一个人可以：${what}`);
  }

  // /api/chat 的这道检查必须赶在 SSE 头之前：头一发出去，403 的正文就顶着
  // text/event-stream 的壳过去，前端拿到的是一个「连上了但什么都不发」的流
  const chat = routeOf('app.post("/api/chat", async (req, res)', 2000);
  const iGuard = chat.indexOf("sessionAllowed(user, getSession(sessionId))");
  const iSse = chat.indexOf('res.setHeader("Content-Type", "text/event-stream');
  assert.ok(iGuard > 0, "POST /api/chat 没查会话归属 → 拿到别人的会话 id 就能接着他的上下文继续跑，还写进他的历史");
  assert.ok(iSse > 0 && iGuard < iSse, "POST /api/chat 的归属检查排在 SSE 响应头后面了，403 会被当成一条空的事件流");

  // 「哪些任务还在跑」要按侧栏那个窄口径给：宽了的后果不是泄露，是前端 reattachRunning
  // 会把同事的任务画面挨个回放进管理员自己的窗口
  const running = routeOf('app.get("/api/chat/running"', 700);
  assert.ok(/ownSession\(req\.user/.test(running),
    "/api/chat/running 没按侧栏口径过滤——管理员刷新页面会把全服务器所有人正在跑的任务接回自己窗口");
  assert.ok(!/role === "admin"/.test(running),
    "/api/chat/running 还在用「是不是管理员」一刀切：那是跨组织的，同组织与否根本没看");

  console.log("✅ 跑着的任务防插手：插队/代答/停止/续流四条都查归属（本人·同组织管理员·老会话放行，跨组织连管理员也拒），/api/chat 归属先于 SSE 头，running 按侧栏窄口径");
}

/**
 * 任务历史的权威清单（server.js 的 listSessionsOnDisk / sessionRow / ownSession）。
 *
 * 用户原话：「怎么回事啊，我 catuncle 账号登陆之前的历史记录都没看到了，之前的任务历史都没看到了啊」。
 * 侧栏那份列表当时只活在浏览器 localStorage 里，对话本体一直好好躺在 data/sessions/——
 * 换台机器 / 清缓存 / 改用户名 / 换个账号先登进来，任意一件事就让列表空掉。
 *
 * 这里切 server.js 的真源码在临时目录上跑：server.js 是 require 就监听的，
 * 起不了进程内 HTTP；但这三个函数是纯的，注入 fs/path/store/sessions/SESS_DIR 就能真读真磁盘。
 */
async function testSessionIndex() {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const a = src.indexOf("const sessMetaCache = new Map();");
  const b = src.indexOf("// 任务跑一半崩了", a);
  if (a < 0 || b <= a) throw new Error("server.js 里的会话清单段找不到了（函数被改名/挪走？），测试没法定位真源码");
  const SLICE = src.slice(a, b);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sessidx-"));
  try {
    const store = { readJson: (p2, dflt) => { try { return JSON.parse(fs.readFileSync(p2, "utf8")); } catch { return dflt; } } };
    const live = new Map();
    const build = () => new Function("fs", "path", "store", "sessions", "SESS_DIR",
      SLICE + "\nreturn { listSessionsOnDisk, sessionRow, ownSession, sessMetaCache };")(fs, path, store, live, dir);

    const put = (id, o) => fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(Object.assign({
      title: "任务 " + id, user: "boss", transcript: [{ role: "user" }], updated_at: "2026-09-01T00:00:00.000Z",
    }, o)));

    put("s_1", { title: "老板的季度汇总", updated_at: "2026-09-03T00:00:00.000Z" });
    put("s_2", { title: "老板的落地页", updated_at: "2026-09-05T00:00:00.000Z", project: "客户 A" });
    put("s_3", { title: "同事的周报", user: "staff", updated_at: "2026-09-04T00:00:00.000Z" });
    put("s_4", { title: "升级前的老会话", user: undefined, updated_at: "2026-09-02T00:00:00.000Z" }); // 没记归属
    put("s_5", { title: "还没说过话", transcript: [] });
    fs.writeFileSync(path.join(dir, "s_6.json"), "{ 这不是 JSON");
    fs.writeFileSync(path.join(dir, "s_7.json.bak"), JSON.stringify({ title: "备份别算", transcript: [{}] }));

    let M = build();
    let rows = M.listSessionsOnDisk();
    assert.deepStrictEqual(rows.map((r) => r.id), ["s_2", "s_3", "s_1", "s_4"],
      "清单不对（该按更新时间倒序，坏文件/空对话/.bak 都不该进来）：" + JSON.stringify(rows.map((r) => r.id)));
    assert.strictEqual(rows[0].turns, 1, "轮数没带上，侧栏分不出「点开就有东西」和「空壳」");
    assert.strictEqual(rows[0].project, "客户 A", "项目名没带上，前端按项目过滤会把它归错组");

    // ★ 用户那句「历史全没了」的正主：登录了也要看得见自己的，外加升级上来那些没记归属的
    const boss = { username: "boss" }, staff = { username: "staff" };
    const mine = (u) => rows.filter((r) => M.ownSession(u, r)).map((r) => r.id);
    assert.deepStrictEqual(mine(boss), ["s_2", "s_1", "s_4"], "老板的侧栏漏了：" + JSON.stringify(mine(boss)));
    assert.deepStrictEqual(mine(staff), ["s_3", "s_4"], "同事的侧栏不对：" + JSON.stringify(mine(staff)));
    assert.ok(mine(boss).includes("s_4") && mine(staff).includes("s_4"),
      "★升级上来那些没记归属的老会话被藏了★ 这正是用户说「历史全没了」的那一批");
    assert.deepStrictEqual(rows.filter((r) => M.ownSession(null, r)).map((r) => r.id), ["s_2", "s_3", "s_1", "s_4"],
      "没开账号体系（一个人用）时反倒过滤了");

    // 故意比 sessionAllowed 窄：管理员拿到同组织的链接可以打开，但同事的任务不该铺进他的侧栏
    assert.ok(!M.ownSession(boss, { id: "s_3", user: "staff" }),
      "同事的任务出现在管理员侧栏了——「能不能打开」和「侧栏该不该出现」是两件事");

    // 增量缓存：改了要重读，删了不许赖在缓存里
    put("s_1", { title: "老板的季度汇总（改过标题）", updated_at: "2026-09-06T00:00:00.000Z" });
    const t = Date.now() / 1000 + 10;
    fs.utimesSync(path.join(dir, "s_1.json"), t, t); // mtime 必须真的变，不然缓存本来就该命中
    rows = M.listSessionsOnDisk();
    assert.strictEqual(rows[0].id, "s_1", "改过的会话没顶到最前面（mtime 缓存没刷新）");
    assert.ok(/改过标题/.test(rows[0].title), "读的还是缓存里那份旧标题");
    fs.unlinkSync(path.join(dir, "s_2.json"));
    rows = M.listSessionsOnDisk();
    assert.ok(!rows.some((r) => r.id === "s_2"), "删掉的会话还在清单里");
    assert.ok(![...M.sessMetaCache.keys()].includes("s_2.json"), "删掉的会话赖在缓存里，占着内存还会被下一轮读到");

    // 内存里正在跑的那份优先：刚改过还没落盘，侧栏不能显示旧标题
    live.set("s_1", { title: "正在跑，标题刚被模型润色过", user: "boss", transcript: [{}, {}], updated_at: "2026-09-07T00:00:00.000Z" });
    rows = M.listSessionsOnDisk();
    assert.strictEqual(rows[0].title, "正在跑，标题刚被模型润色过", "内存里那份没被优先用，侧栏显示的是盘上的旧标题");

    // sessionRow 的守卫：残缺的对象一律不进清单，不许拿 undefined 去撑 UI
    assert.strictEqual(M.sessionRow("x", null), null, "null 也生成了一行");
    assert.strictEqual(M.sessionRow("x", { title: "有标题没正文" }), null, "没有 transcript 的也进清单了");
    assert.strictEqual(M.sessionRow("x", { transcript: [{}] }).title, "未命名任务", "没标题时没给兜底名字");

    // 目录压根不存在（全新安装第一次开）：给空清单，不许把整条启动链条炸掉
    const gone = new Function("fs", "path", "store", "sessions", "SESS_DIR",
      SLICE + "\nreturn listSessionsOnDisk;")(fs, path, store, new Map(), path.join(dir, "根本没有这个目录"));
    assert.deepStrictEqual(gone(), [], "会话目录不存在时没给空清单");

    // ---- 接口那一层：归属只用来过滤，不许回给前端；假项目不许再回来 ----
    const route = src.slice(src.indexOf('app.get("/api/sessions"'), src.indexOf('app.get("/api/sessions"') + 400);
    assert.ok(/ownSession\(req\.user/.test(route), "/api/sessions 没按归属过滤——别人的任务会出现在你的侧栏");
    assert.ok(/\{ user, \.\.\./.test(route) || /delete .*\.user/.test(route),
      "/api/sessions 把 user 字段原样回给前端了——侧栏不需要，回了就是白泄露组织成员名单");
    // 注释里写着这段事故的来龙去脉，那是给人看的；要拦的是它重新变成一个会发出去的值。
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1")).join("\n");
    assert.ok(!/本组织工作目录/.test(noComments),
      "★那个假项目「本组织工作目录」又回来了★ 侧栏会多一个点不动的 tab，而且按项目一过滤，老用户整排任务历史当场消失");
    const projRoute = src.slice(src.indexOf('app.get("/api/projects"'), src.indexOf('app.get("/api/projects"') + 500);
    assert.ok(/locked: true/.test(projRoute) && /projects: \[\]/.test(projRoute),
      "/api/projects 没对没有全局工作目录的人如实回「你这儿没有项目这回事」——前端只好按一个对不上的名字过滤，历史又会空");

    console.log("✅ 任务历史权威清单：按磁盘给（倒序·坏文件/空对话/.bak 不进）· 自己的和没记归属的老会话都在 · 比 sessionAllowed 窄 · mtime 增量缓存跟着改和删 · 内存优先 · 归属不回传 · 假项目不许回来");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
