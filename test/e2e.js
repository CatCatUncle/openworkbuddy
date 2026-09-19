"use strict";
/**
 * 端到端测试 — 用"脚本化模拟 LLM"驱动 Agent 运行时完整跑一遍，不需要真实模型 API Key。
 * 覆盖：技能加载(use_skill) → 代码执行生成 Excel(run_node/exceljs) → 专家委派(delegate_to_expert
 * 子代理 write_file) → 任务收尾；以及 cron 解析、Word/PPT 库可用性。
 * 运行：npm test
 */

const fs = require("fs");
// 单独跑这个文件时也别写进用户真账本（all.js 里已经设过一次，这里只兜底）
if (!process.env.OPENWORKBUDDY_TRACE_FILE) {
  process.env.OPENWORKBUDDY_TRACE_FILE =
    require("path").join(require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "owb-test-trace-")), "traces.jsonl");
}
const os = require("os");
const path = require("path");
const assert = require("assert");
const { createAgentRuntime, missingDeliverables, unseenVisualClaims, trimHistory, historyChars, collectSources } = require("../agent");
const { McpManager } = require("../mcp");
const { parseCron, cronMatches } = require("../scheduler");
const { getWorkspaceDir, setWorkspaceDir } = require("../tools");
const mediaModels = require("../media-models");
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

/**
 * 起一条真的 server.js 打端到端，端口交给系统分配。
 *
 * 以前每处各写一遍 `3900 + 随机 90` 自己挑端口。一轮 e2e 里有五处这么干，撞上就是死局：
 * server.js 遇到 EADDRINUSE 只往 stderr 打一行就 return，进程还活着、什么都没监听，
 * 测试那头干等 40 秒，最后吐一句「真 server.js 没起来」——日志是空的，连线索都没有。
 * 本机还开着自己那台（3800）的时候，撞的甚至可能是用户正在用的实例。
 *
 * 现在统一 PORT=0 让内核挑，再从启动那行里把真端口抠回来；起不来时把退出码、
 * 存活状态和日志尾巴一起交出去，不用再猜。
 */
function bootRealServer(env, { timeoutMs = 60000, port = "0" } = {}) {
  const { spawn } = require("child_process");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    // PORT 摆在最后：外面 shell 里要是设了 PORT（跑着自己那台的人很常见），不能让它把 0 顶掉
    env: { ...process.env, ...env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const ready = new Promise((resolve) => {
    const done = (v) => { clearInterval(tick); clearTimeout(t); resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    const tick = setInterval(() => {
      if (/已启动: http:\/\/localhost:\d+/.test(log)) done(true);
      else if (child.exitCode !== null) done(false);
    }, 200);
  });
  return {
    child,
    get log() { return log; },
    async wait() {
      const up = await ready;
      const m = /已启动: http:\/\/localhost:(\d+)/.exec(log);
      return {
        up: up && !!m,
        port: m ? Number(m[1]) : 0,
        // 起不来时给的是「能查的东西」，不是一句「没起来」：退出码 / 还活着没 / 日志尾巴
        why: `退出码=${child.exitCode} 存活=${child.exitCode === null} 日志尾巴=${JSON.stringify(log.slice(-400)) || "(空)"}`,
      };
    },
  };
}

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
          // 顺手把 html-page 也加载一次：它会带出一句「先去 web-styles 挑视觉方向」的提示，
          // 那句提示是「网页别千篇一律」那条链上唯一一处活代码（其余四处都是静态文案），
          // 光靠读源码的闸门盯不住它有没有真拼进返回值里
          toolCalls: [
            { id: "tc_1", name: "use_skill", input: { name: "excel-report" } },
            { id: "tc_1b", name: "use_skill", input: { name: "html-page" } },
          ],
          stopReason: "tool_use",
        };
      }
      if (coordStep === 2) {
        // 验证上一步 use_skill 返回了技能内容
        const lastTool = history[history.length - 1];
        assert(lastTool.role === "tool" && lastTool.results[0].content.includes("exceljs"), "use_skill 未返回技能内容");
        const pageSkill = lastTool.results.find((r) => r.id === "tc_1b");
        assert(pageSkill, "两个 use_skill 的结果没按调用 ID 配对回来");
        // 认「【配套】」这个只有提示才有的标记：html-page 技能正文自己也提 web-styles，
        // 光按技能名匹配会被正文喂饱，闸门看着绿其实什么都没查
        assert(/【配套】/.test(pageSkill.content) && /web-styles|frontend-design/.test(pageSkill.content),
          "加载 html-page 时没带出「先挑视觉方向」的提示，网页又会长成同一张脸");
        assert(!/【配套】/.test(lastTool.results[0].content), "★这句提示不该跟着 excel-report 一起发★");
        const code = `
const ExcelJS = require("exceljs");
(async () => {
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("测试");
  ws.addRow(["项目", "数量"]);
  ws.addRow(["A", 1]);
  ws.addRow(["B", 2]);
  ws.addRow(["合计", { formula: "SUM(B2:B3)" }]);
  await book.xlsx.writeFile(${JSON.stringify(XLSX_NAME)});
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

  const book = new ExcelJS.Workbook();
  const s1 = book.addWorksheet("第一表");
  s1.addRow(["日期", "金额"]); s1.addRow(["2026-01-01", 12.5]);
  book.addWorksheet("第二表").addRow(["只有一行"]);
  await book.xlsx.writeFile("e2e-预览样本.xlsx");

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

// 缺外部工具的那句话，必须真的接在 run_shell 的回执后面。
// 翻译函数本身在 test/office-tools.js 里逐个 shell 测过了，这儿测的是**接没接上**：
// 少一行 wiring，那边十几条断言照样全绿，而用户拿到的还是光秃秃一句
// 「zsh:1: command not found: ffprobe」。
//
// PATH= 是为了让这条断言在装了 ffmpeg 的机器上也成立——把 PATH 清空，
// 任何机器上都必然是「找不到」，而不是「这台碰巧没装」。
async function testMissingBinHintWired() {
  const tools = require("../tools");
  const run = (command) => tools.executeTool("run_shell", { command }, { timeoutMs: 30000 });

  const miss = await run("PATH= ffmpeg -version");
  assert(miss.isError, "命令没跑失败，这条断言就没测到东西: " + miss.content);
  assert(/brew install ffmpeg|winget install ffmpeg|apt install ffmpeg/.test(miss.content),
    "run_shell 回执里没接上「怎么装」那句: " + miss.content);
  assert(/图文成片/.test(miss.content), "没说这个工具是干嘛用的，用户不知道该不该装: " + miss.content);

  // ★反向对照★ 退出码 0 的输出里就算原样出现那句话，也一个字都不许加——
  // 不然「看一眼日志」这种命令就会被凭空追加一句「本机没装 ffmpeg」，那是纯粹的假话
  const clean = await run('echo "zsh:1: command not found: ffmpeg"');
  assert(!clean.isError, "这条本该成功: " + clean.content);
  assert(!/brew install/.test(clean.content), "★成功的命令被凭空加了一句装法★ " + clean.content);

  // ★反向对照★ 认不出的命令失败了，也不许瞎给装法
  const unknown = await run("PATH= nosuchbin-e2e-112");
  assert(unknown.isError, "这条本该失败: " + unknown.content);
  assert(!/install/.test(unknown.content), "不认识的命令被瞎给了装法: " + unknown.content);
  console.log("✅ 缺外部工具时回执带上装法（认得出的才给·成功的命令不加料·不认识的不瞎猜）");
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
// CSS 令牌闸门：引用了却没定义的 --owb-* / --* 变量，浏览器不报错、不回退，直接当没写——
// 之前 --owb-line/--owb-card/--owb-warn/--mono 就这么空跑了很久（评测页边框一路是空的），
// 后来又因为手滑吃掉一个分号，让 --owb-ok-text 整个失效。这类事故没有任何运行时能替你发现。
// 顺带把「文字色拿填充色令牌」也钉死：--owb-brand/--owb-err/--owb-ok 是给背景用的，
// 当文字色在浅底/暗底上都过不了 WCAG AA，必须走 --owb-*-text 那三档。
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
  // 填充色当文字色用，代码里有三种写法，只堵一种是堵不住的——头两版闸门就只认第 ① 种，
  // 结果 ②③ 在评测页和自进化页躺了一路（绿勾绿字在白底上 3.30，暗底上 4.18，两头都不够 AA）：
  //   ① 写死：color: var(--owb-err)
  //   ② 插值：color:${ok ? "var(--owb-ok)" : "var(--owb-err)"}
  //   ③ 先存变量再用：const color = "var(--owb-err)" … style="color:${color}"
  // ①② 看 color: 后面那一段值；③ 看「光秃秃一个 var(--owb-x) 字符串」——这种字符串除了当颜色值传没别的用处，
  // 同一行提到 background/border/fill/stroke/shadow/outline 才放行（那是真把它当填充色用，正是它该待的地方）。
  const FILL = /var\(\s*--owb-(brand|err|ok)\s*[,)]/;
  const FG_VALUE = /(?<![-a-zA-Z])color:\s*(\$\{[^}]*\}|[^;"'`\n]*)/g;
  const LOOSE_STR = /["'`]var\(\s*--owb-(brand|err|ok)\s*\)["'`]/g;
  const REALLY_FILL = /background|border|fill|stroke|shadow|outline/;
  const lineOf = (t, i) => t.slice(0, i).split("\n").length;
  const scanFillAsText = (t, name, out) => {
    for (const m of t.matchAll(FG_VALUE)) if (FILL.test(m[1])) out.push(name + ":" + lineOf(t, m.index) + " 的 color");
    for (const m of t.matchAll(LOOSE_STR)) {
      const line = t.slice(t.lastIndexOf("\n", m.index) + 1, (t.indexOf("\n", m.index) + 1 || t.length + 1) - 1);
      if (!REALLY_FILL.test(line)) out.push(name + ":" + lineOf(t, m.index) + " 的 --owb-" + m[1] + "（存进变量再当颜色用）");
    }
  };
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    // var(--x) 带回退值的不算漏（var(--x, 兜底) 本来就允许没定义）
    for (const m of t.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g)) {
      if (!defined.has(m[1])) missing.set(m[1], (missing.get(m[1]) || []).concat(path.basename(f)));
    }
    scanFillAsText(t, path.basename(f), fillAsText);
  }
  assert(missing.size === 0, "引用了没定义的 CSS 变量：" + [...missing].map(([k, v]) => k + "(" + [...new Set(v)].join(",") + ")").join("、"));
  assert(fillAsText.length === 0, "填充色令牌被当文字色用了，应换成 --owb-*-text：" + fillAsText.join("、"));
  // 反向断言：三种写法各造一份坏样本喂进去，一种抓不到就说明闸门这一路是摆设
  const bad1 = []; scanFillAsText(".x .i { color: var(--owb-err, #dc2626); }", "假1", bad1);
  const bad2 = []; scanFillAsText("`<b style=\"color:${ok ? \"var(--owb-ok)\" : \"var(--owb-text)\"}\">`", "假2", bad2);
  const bad3 = []; scanFillAsText('const tone = "var(--owb-brand)";', "假3", bad3);
  assert(bad1.length && bad2.length && bad3.length, `闸门漏了：写死=${bad1.length} 插值=${bad2.length} 变量=${bad3.length}`);
  // 正向对照：真拿它当填充色的三种写法一个都不许误报，不然逼着人把背景色也换成文字档
  const good = [];
  scanFillAsText('.chip { background: var(--owb-err); border-left-color: var(--owb-brand); }', "真1", good);
  scanFillAsText('btn.style.background = "var(--owb-err)";', "真2", good);
  scanFillAsText('`<i style="background:var(--owb-err);color:#fff">`', "真3", good);
  assert(good.length === 0, "闸门误伤了正经的填充用法：" + good.join("、"));
  assert(!defined.has("--owb-根本没有这个"), "闸门定义集失效");

  // 同一个毛病还有第 ④ 种写法，上面三种一个都盯不到：**直接写死十六进制**。
  // 令牌那一路堵死之后，自动化页和引擎卡片里躺着 6 条 `color: #16a34a` / `color: #dc2626`——
  // 绿字压白卡片只有 3.30:1（令牌层为此专门留了 --owb-ok-text，5.79:1），
  // 红字压深色卡片只有 3.41:1；而且写死的颜色压根不跟着主题翻，深色下要么糊要么刺眼。
  // 中性灰放行（分隔线、占位字本来就该用灰），只抓有颜色的。
  const hexSat = (h) => {
    let x = h.replace("#", "").toLowerCase();
    if (x.length === 3) x = [...x].map((c) => c + c).join("");
    const r = parseInt(x.slice(0, 2), 16), g = parseInt(x.slice(2, 4), 16), b = parseInt(x.slice(4, 6), 16);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  // 两头都是深色的面：浅色主题下它也还是深的，套 --owb-*-text（浅色档是深红/深绿）反而看不见。
  // 只放这一条具体选择器，不放整类——新加的写死颜色照样会被抓。
  const DARK_SURFACE = /#owb-toast/;
  // 免死判定要看「这条声明属于哪条规则」，不能只看它自己那一行：一条规则常常折成好几行写，
  // 选择器在第一行、background 在第二行，按行取就永远读不到选择器（pet.html 的 #drop 就是这样）。
  // 往前找到上一个 } 为止，中间那段一定含选择器。
  const ruleHeadAt = (t, i) => t.slice(t.lastIndexOf("}", i) + 1, i);
  const scanHexAsText = (t, name, out) => {
    for (const m of t.matchAll(/(?<![-a-zA-Z])color:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
      if (hexSat(m[1]) <= 0.18) continue;
      if (DARK_SURFACE.test(ruleHeadAt(t, m.index))) continue;
      out.push(name + ":" + lineOf(t, m.index) + " 的 " + m[1]);
    }
  };
  const hexAsText = [];
  for (const f of [path.join(pub, "index.html"), path.join(pub, "css", "ui.css"), path.join(pub, "admin.html"), path.join(pub, "pet.html")]) {
    const t = fs.readFileSync(f, "utf8");
    for (const b of t.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) scanHexAsText(b[1], path.basename(f), hexAsText);
    if (f.endsWith(".css")) scanHexAsText(t, path.basename(f), hexAsText);
  }
  assert(hexAsText.length === 0,
    "文字颜色写死成十六进制了，不跟主题翻色、也绕开了 *-text 那一档（绿的在白底只有 3.30:1）：" + hexAsText.join("、"));
  // 反向对照：写死的抓得到；灰的和令牌的一个都不许误报；免死的那条只免它自己
  const h1 = []; scanHexAsText(".x .st.ok { color: #16a34a; }", "假", h1);
  const h2 = []; scanHexAsText(".x .meta { color: #6a6f7d; }\n.y { color: var(--owb-ok-text); }\n.z { background: #16a34a; }", "真", h2);
  const h3 = []; scanHexAsText("#owb-toast.err .i { color: #ff8f8f; }", "免", h3);
  const h4 = []; scanHexAsText(".other .i { color: #ff8f8f; }", "非免", h4);
  assert(h1.length === 1, "写死的十六进制文字色抓不到，这道闸是摆设");
  assert(h2.length === 0, "误伤了灰字/令牌/背景色：" + h2.join("、"));
  assert(h3.length === 0 && h4.length === 1, `免死名单跑偏了：免=${h3.length} 非免=${h4.length}`);
  // 第 ⑤ 种：写死的十六进制当**底色 / 边框**用。上面那道只管 color:，管不到这一路，
  // 三处真事故都是从这个口子溜过去的，而且一个比一个离谱：
  //   · 审批条：底 #fff7ed + 边 #fdba74，深色再单开一条 .ap-row 各写一遍。
  //     那根边压在页面底上只有 1.56:1，「任务停在这儿等你点头」这条提示等于没画边。
  //   · 场景 tab 选中的胶囊：写死 #17181c，可深色主题的轨道底正好也是 #17181c——
  //     1.00:1，胶囊整个消失，看不出选中的是哪一个。
  //   · 过程卡：写死 #fbfcfe，深色下是一整块白板（压页面底 17.43:1），
  //     上面的字是深色主题那档浅灰，白底浅灰 2.29:1，读不了。
  // 注意这三个的饱和度分别是 18 / 5 / 3——按「够不够花」筛一个都抓不到，
  // 所以这一路不看饱和度：底色和边框里只准出现 #fff / #000（蒙层、视频留黑那种跟主题无关的），
  // 其余一律要走令牌。var() 里的兜底值放行（var(--owb-warn, #d97706) 是本项目既有写法，主题照样翻）。
  const stripVar = (s) => { let o = s, n; do { n = o; o = o.replace(/var\([^()]*\)/g, " "); } while (o !== n); return o; };
  // 故意长期是深色 / 本来就是插画固有色的几处：单列具体选择器，不放整类
  const FIXED_SURFACE = /\.code-head|\.code-wrap|#drop/;
  const SURFACE_PROP = /(?<![-a-zA-Z])(background|background-color|border|border-color|border-top|border-right|border-bottom|border-left|border-top-color|border-right-color|border-bottom-color|border-left-color|outline|outline-color|box-shadow)\s*:\s*([^;{}]*)/g;
  const scanHexAsFill = (t, name, out) => {
    for (const m of t.matchAll(SURFACE_PROP)) {
      if (FIXED_SURFACE.test(ruleHeadAt(t, m.index))) continue;
      for (const h of stripVar(m[2]).match(/#[0-9a-fA-F]{3,8}\b/g) || []) {
        if (/^#(fff|ffffff|000|000000)$/i.test(h)) continue;
        out.push(name + ":" + lineOf(t, m.index) + " 的 " + h);
      }
    }
  };
  const hexAsFill = [];
  for (const f of [path.join(pub, "index.html"), path.join(pub, "css", "ui.css"), path.join(pub, "admin.html"), path.join(pub, "pet.html")]) {
    const t = fs.readFileSync(f, "utf8");
    for (const b of t.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) scanHexAsFill(b[1], path.basename(f), hexAsFill);
    if (f.endsWith(".css")) scanHexAsFill(t, path.basename(f), hexAsFill);
  }
  assert(hexAsFill.length === 0,
    "底色/边框写死成十六进制了，不跟主题翻色，深浅两套还得各写一遍（审批条丢了边框 1.56:1、选中胶囊消失 1.00:1、过程卡白板 2.29:1，都是这么来的）：" + hexAsFill.join("、"));
  // 反向对照：三起真事故的原样写法，一条都不许放过（注意它们一个比一个不花）
  const f1 = []; scanHexAsFill(".x { background: #fff7ed; }", "假1", f1);
  const f2 = []; scanHexAsFill(".y { border: 1px solid #fdba74; }", "假2", f2);
  const f8 = []; scanHexAsFill(".z.active { background: #17181c; }", "假3", f8);
  const f9 = []; scanHexAsFill(".w { background: #fbfcfe; }", "假4", f9);
  assert(f1.length === 1 && f2.length === 1 && f8.length === 1 && f9.length === 1,
    `写死的底色/边框抓不到，这道闸是摆设：淡橙=${f1.length} 橙边=${f2.length} 近黑=${f8.length} 近白=${f9.length}`);
  // 正向对照：var 兜底、纯黑白、以及归另一道闸管的 color: 一个都不许误报
  const f3 = [];
  scanHexAsFill(".a { background: color-mix(in srgb, var(--owb-warn, #d97706) 10%, transparent); }", "真1", f3);
  scanHexAsFill(".b { background: #fff; } .b2 { background: #000; } .b3 { border: 1px solid #FFFFFF; }", "真2", f3);
  scanHexAsFill(".c { color: #16a34a; }", "真3", f3);
  assert(f3.length === 0, "误伤了 var 兜底/纯黑白/文字色：" + f3.join("、"));
  // 免死名单只免它自己：同样的颜色换个选择器照样抓
  const f4 = []; scanHexAsFill(".code-head { background: #23252e; }", "免", f4);
  const f5 = []; scanHexAsFill(".panel { background: #23252e; }", "非免", f5);
  assert(f4.length === 0 && f5.length === 1, `免死名单跑偏了：免=${f4.length} 非免=${f5.length}`);
  // 折行写的规则：选择器在上一行，声明在下一行——按行取就读不到免死名单，会误报
  const f6 = []; scanHexAsFill("#drop { position: absolute;\n    background: #7fc4f5; }", "免折行", f6);
  const f7 = []; scanHexAsFill(".x { position: absolute;\n    background: #7fc4f5; }", "非免折行", f7);
  assert(f6.length === 0 && f7.length === 1, `折行规则认不出选择器：免=${f6.length} 非免=${f7.length}`);
  console.log(`✅ CSS 令牌闸门：${defined.size} 个变量全部有定义 · 填充色没被当文字色用（令牌写死/插值/存变量 + 写死十六进制）· 底色和边框也不许写死十六进制（五种写法都盯）`);
}

// 动效闸门：transition 不写曲线，浏览器就按默认的 ease 走——两头慢中间快，那是「网页味」，
// 跟界面里其他用 --owb-ease 的地方不是一套动法。这类不一致肉眼要盯很久才看得出来，
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
      // 按逗号切段，但要绕开括号里的逗号——var(--owb-ease, ease) 的那个回退逗号
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
        if (!/var\(\s*--owb-ease/.test(seg)) bare.push(path.basename(f) + ": " + v);
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
  assert(!/var\(\s*--owb-ease/.test(probeBare), "裸过渡的判别失效");
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
    [/body \{[^}]*background: var\(--owb-shell\)/, "body 没用外壳底色，三级表面的最外层是空的"],
    [/aside \{[^}]*background: var\(--owb-shell\)/, "左栏没用外壳底色"],
    [/\.main \{[^}]*background: var\(--owb-canvas\)/, ".main 没用画布底色——主区还是纯白，白卡片浮不起来"],
    [/--owb-shell: var\(--app-shell\)/, "--owb-shell 没接到 ui.css 的真源上"],
    [/--owb-canvas: var\(--page-canvas\)/, "--owb-canvas 没接到 ui.css 的真源上"],
  ];
  for (const [re, msg] of wired) assert(re.test(html), msg);

  // 字形抗锯齿：admin.html 一直开着，主界面漏了，两边看着不像一个产品
  assert(/-webkit-font-smoothing: antialiased/.test(html), "index.html 的 body 没开 antialiased，整页比设计稿粗一档");

  // 滚动条：只允许一套规则，且滑块不能是 --owb-border（压白底看不见）
  const thumbs = [...html.matchAll(/::-webkit-scrollbar-thumb\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const thumbBg = thumbs.filter((r) => /background:/.test(r) && !/:hover/.test(r));
  assert(thumbs.length <= 4, "滚动条滑块规则有 " + thumbs.length + " 条，八成是两套规则在打架");
  assert(thumbBg.every((r) => !/var\(--owb-border\)/.test(r)),
    "滚动条滑块还是 --owb-border，压在白底上等于没画：" + thumbBg.join(" | "));
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
  assert(!/body \{[^}]*background: var\(--owb-根本没有\)/.test(html), "接线判别失效");
  assert(/box-shadow:[^;]*rgba?\(/.test("box-shadow: 0 1px 2px rgba(0,0,0,.1);"), "手写投影的判别失效");
  console.log("✅ 表面层级闸门：外壳/画布/卡片三档在浅暗两套主题下都互异且真接到了 body/aside/.main · 三档投影齐全 · 滚动条只剩一套且看得见");
}

/**
 * README 里允许出现的「别人家的仓库」白名单——现在是空的，也就是一个都不许。
 *
 * 两道闸门都要用它：testDocLinkGate 扫全文链接和徽章，testReadmeFrontGate 扫门面。
 * 曾经这里放过对比表点名的项目和上游连接器。后来定下的规矩是：
 * **README 不替别人的项目带路**——它是这个项目的门面，不是导航页；
 * 别人的仓库地址出现在这儿，读者分不清哪个是我们做的，也平白给自己惹商标和背书的麻烦。
 * 要提第三方（模型服务商、飞书这类平台）只写名字、不给仓库链接，需要链接就落到 docs/ 里去。
 *
 * 所以这个集合应当保持为空。真要加一条，就在这儿写明为什么非它不可；写不上来，就是该拦住。
 *
 * 现在有一条。为什么是它，三句话：
 *   1. **同一个人的仓库。** CatCatUncle/toolward 和 CatCatUncle/openworkbuddy 一个 owner，
 *      不存在「替别人带路」这回事，商标和背书的顾虑一条都不成立。
 *   2. **不是推荐，是接线。** toolward.js 真的会去调它的命令行，技能和连接器装之前多扫一遍。
 *      装它的人需要那个地址才能装；不给链接，README 上那句「装了更安全」就是一句空话。
 *   3. **授权上必须说清楚。** 它是 PolyForm Noncommercial：公司用要另外授权。
 *      正因为有这条，它才不能进 package.json，也才更得在 README 里写明白是哪个项目、去哪看。
 * 再要加第四条的时候，回来重读上面那三句：凑不齐就是不该加。
 */
const REFERENCE_REPOS = new Set(["CatCatUncle/toolward"]);

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
  const files = ["README.md", "README.en.md", "CONTRIBUTING.md", "COMMERCIAL-LICENSE.md", "LICENSE-ECOSYSTEM.md"]
    .map((f) => path.join(root, f))
    .filter((f) => fs.existsSync(f))
    .concat(mdUnder(docs));

  // 反引号里的东西先抠掉：`[调研报告](报告.md)` 是在讲「链接长什么样」，不是一条链接——
  // 渲染出来就是一段代码，点不动，自然也没有「指到哪儿」这回事。代码块同理（安装命令里
  // 的路径不是链接）。不抠的话，文档里每解释一次 markdown 语法就多一条假死链。
  const stripCode = (t) => t.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  // Markdown 的 [x](y)，加上 README 里那些 HTML 标签的 href/src
  const grab = (t) => [
    ...[...t.matchAll(/\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]),
    ...[...t.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
  ];
  // GitHub 给标题生成锚点的规则：小写、去掉标点、空格转连字符，汉字原样保留。
  // ⚠️ 「汉字」不等于 \u4e00-\u9fff 那一段。〇（U+3007）是数字零的汉字写法，排在 CJK 符号区、
  // 不在基本汉字块里；GitHub 的 slugger 只删标点符号，〇 是字母类，它留着。
  // 白名单写窄了，闸门算出来的锚点会比真锚点少一个字：文档里 #〇两个总开关… 这种链接在 GitHub 上点得开，
  // 闸门却报死链——然后人会去把链接改成闸门认的那个，改完 GitHub 上才真的点不开了。假红比假绿更能骗人动手。
  const CJKISH = "\\u3005\\u3006\\u3007\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff";
  const slugify = (h) => h.trim().replace(/[*`~]/g, "").toLowerCase()
    .replace(new RegExp("[^\\w" + CJKISH + "\\s-]", "g"), "").trim().replace(/\s+/g, "-");
  const dead = [];
  let checked = 0;
  const anchorsOf = (file) => new Set([...fs.readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slugify(m[1])));
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    const anchors = anchorsOf(f);
    for (const href of grab(stripCode(t))) {
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

  slugs.forEach((sl) => assert(sl === "CatCatUncle/openworkbuddy" || REFERENCE_REPOS.has(sl), "README 里出现了未经允许的仓库地址：" + sl));
  assert(slugs.has("CatCatUncle/openworkbuddy"), "README 里没找到本仓库地址");
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
  // 〇 得留住。这一条挂了说明白名单又被写窄回去了，中文小标题里用「〇、一、二」编号的那几篇会集体误报死链
  assert(slugify("〇、两个总开关：默认都关着") === "〇两个总开关默认都关着", "〇 被当标点删了——中文编号小标题的锚点会集体算错");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-wm-"));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-vwm-"));
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
 * 图当输入：生图喂参考图、生视频定首尾帧。
 *
 * 这条闸门盯四件事，每一件漏掉都会以「用户拿到的东西看着对、其实没照着做」收场：
 *
 *  1. **不传新字段时请求体一个字都不能变。** 这两个函数今天已经在给人出图出片了，
 *     加字段最容易的翻车方式是顺手把 `image: []`、`img_url: undefined` 也发出去——
 *     严格渠道见到不认识的字段直接 400，老用户什么都没改却突然全挂。
 *  2. **传了就必须真发出去。** 断言看的是 stub 收到的请求体，不是「代码里写了」。
 *  3. **渠道不收图，绝不许静默退回纯文生。** 退回去照样出一张图，模型会当成
 *     「已经保持一致了」交上去——错得不留一点痕迹，比直接报错坏得多。
 *  4. **型号和入参对不上，在发请求之前就拦。** 媒体模型目录按名字认能力，i2v 型号
 *     一样被归进「视频模型」；用户选了它、不给图就调，今天必然在上游失败一次，
 *     而视频是按条计费的异步任务，那一趟钱和几分钟都是白扔。
 */
async function testMediaImageInputGate() {
  const http = require("http");
  const os = require("os");
  const { generateImage, generateVideo } = require("../tools")._internals;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-refimg-"));
  // 1×1 的真 PNG。内容无所谓，但扩展名和「是个文件不是目录」这两关是真要过的
  fs.writeFileSync(path.join(dir, "参考.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  fs.writeFileSync(path.join(dir, "参考2.png"), fs.readFileSync(path.join(dir, "参考.png")));
  fs.writeFileSync(path.join(dir, "笔记.txt"), "不是图");
  const resolveFile = (rel) => path.join(dir, rel);

  const seen = [];
  let mode = "accept";
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (/\/tasks\/t1$/.test(req.url)) return j(200, { output: { task_status: "SUCCEEDED", video_url: `http://127.0.0.1:${srv.address().port}/v.mp4` } });
      if (/\/tasks\/ark1$/.test(req.url)) return j(200, { status: "succeeded", content: { video_url: `http://127.0.0.1:${srv.address().port}/v.mp4` } });
      if (/v\.mp4$/.test(req.url)) { res.writeHead(200, { "Content-Type": "video/mp4" }); return res.end(Buffer.from("fake-mp4")); }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {}
      seen.push({ url: req.url, body, raw });
      // 「这条渠道根本不收图」：模仿 OpenAI 官方对不认识字段的反应
      if (mode === "noimage" && ("image" in body || JSON.stringify(body).includes("image_url") || JSON.stringify(body.input || {}).includes("frame") || (body.input || {}).img_url)) {
        return j(400, { error: { message: "Unrecognized request argument supplied: image" } });
      }
      if (/video-synthesis/.test(req.url)) return j(200, { output: { task_id: "t1" } });
      if (/contents\/generations\/tasks$/.test(req.url)) return j(200, { id: "ark1" });
      return j(200, { data: [{ b64_json: Buffer.from("fake-png").toString("base64") }] });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const img = { image: { base_url: `http://127.0.0.1:${port}/v1`, model: "seedream", api_key: "k" } };
  const imgDs = { image: { base_url: `http://127.0.0.1:${port}/dashscope/api/v1`, model: "qwen-image", api_key: "k" } };
  const vidDs = { video: { base_url: `http://127.0.0.1:${port}/dashscope/api/v1`, model: "wan2.2-i2v-plus", api_key: "k" } };
  const vidDsT2v = { video: { base_url: `http://127.0.0.1:${port}/dashscope/api/v1`, model: "wan2.2-t2v-plus", api_key: "k" } };
  const vidArk = { video: { base_url: `http://127.0.0.1:${port}/ark/api/v3`, model: "doubao-seedance-1-0-pro-i2v-250528", api_key: "k" } };
  const DATA_PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
  const fresh = () => { seen.length = 0; };

  try {
    // ── 1. 不传新字段：请求体里连这几个键都不许出现 ──────────────────────────
    fresh();
    const b0 = await generateImage(img, { prompt: "一只猫", filename: "r0.png" }, 5000, dir, resolveFile);
    assert(!b0.isError, "纯文生图反而挂了：" + b0.content);
    assert(!("image" in seen[0].body), "没给参考图却往请求体里塞了 image 字段，严格渠道会直接 400");
    assert(!/已带 \d+ 张参考图/.test(b0.content), "没给参考图却在回执里说带了：" + b0.content);

    fresh();
    const v0 = await generateVideo(vidDsT2v, { prompt: "猫走路", filename: "r0.mp4" }, { saveDir: dir, resolveFile });
    assert(!v0.isError, "纯文生视频反而挂了：" + v0.content);
    const in0 = seen[0].body.input || {};
    assert(!("img_url" in in0) && !("first_frame_url" in in0) && !("last_frame_url" in in0),
      "没给首尾帧却往 input 里塞了帧字段：" + JSON.stringify(in0));

    // ── 2. 传了就得真发出去 ────────────────────────────────────────────────
    fresh();
    const r1 = await generateImage(img, { prompt: "同一只猫，换个姿势", filename: "r1.png", reference_images: ["参考.png"] }, 5000, dir, resolveFile);
    assert(!r1.isError, "带参考图生图失败：" + r1.content);
    assert(typeof seen[0].body.image === "string" && DATA_PNG.test(seen[0].body.image),
      "一张参考图应该发成字符串 data: URI，实际：" + JSON.stringify(seen[0].body.image).slice(0, 80));
    assert(/已带 1 张参考图/.test(r1.content), "带了参考图却没在回执里交代：" + r1.content);

    fresh();
    const r2 = await generateImage(img, { prompt: "合成", filename: "r2.png", reference_images: ["参考.png", "参考2.png"] }, 5000, dir, resolveFile);
    assert(!r2.isError, "两张参考图生图失败：" + r2.content);
    assert(Array.isArray(seen[0].body.image) && seen[0].body.image.length === 2 && seen[0].body.image.every((u) => DATA_PNG.test(u)),
      "多张参考图应该发成数组，实际：" + JSON.stringify(seen[0].body.image).slice(0, 80));

    // 模型真会把单张图写成裸字符串而不是数组，别为这个多报一条格式错
    fresh();
    const r3 = await generateImage(img, { prompt: "同一只猫", filename: "r3.png", reference_images: "参考.png" }, 5000, dir, resolveFile);
    assert(!r3.isError && typeof seen[0].body.image === "string", "单张参考图写成裸字符串时没被收下：" + r3.content);

    // DashScope 那条是另一套结构：图排在文字前面
    fresh();
    await generateImage(imgDs, { prompt: "同一只猫", filename: "r4.png", reference_images: ["参考.png"] }, 5000, dir, resolveFile);
    const parts = ((((seen[0].body.input || {}).messages || [])[0] || {}).content) || [];
    assert(parts.length === 2 && DATA_PNG.test(parts[0].image) && parts[1].text === "同一只猫",
      "DashScope 那条的参考图没排在文字前面：" + JSON.stringify(parts).slice(0, 120));

    // 万相：只有首帧走 img_url，首尾都有走 first/last_frame_url
    fresh();
    const v1 = await generateVideo(vidDs, { prompt: "猫走路", filename: "r1.mp4", first_frame: "参考.png" }, { saveDir: dir, resolveFile });
    assert(!v1.isError, "带首帧生视频失败：" + v1.content);
    assert(DATA_PNG.test(seen[0].body.input.img_url) && !("first_frame_url" in seen[0].body.input),
      "只给首帧时该走 img_url：" + JSON.stringify(seen[0].body.input).slice(0, 80));
    assert(/已按给定的首帧出片/.test(v1.content), "用了首帧却没在回执里交代：" + v1.content);

    fresh();
    const v2 = await generateVideo(vidDs, { prompt: "从这张变到那张", filename: "r2.mp4", first_frame: "参考.png", last_frame: "参考2.png" }, { saveDir: dir, resolveFile });
    assert(!v2.isError, "带首尾帧生视频失败：" + v2.content);
    const in2 = seen[0].body.input;
    assert(DATA_PNG.test(in2.first_frame_url) && DATA_PNG.test(in2.last_frame_url) && !("img_url" in in2),
      "首尾都给时该走 first/last_frame_url：" + JSON.stringify(Object.keys(in2)));
    assert(/已按给定的首帧和尾帧出片/.test(v2.content), "用了首尾帧却没在回执里交代：" + v2.content);

    // 方舟：首尾帧是 content 数组里的两个 image_url 项，靠 role 区分；
    // 文字那一项必须原样留着——`--watermark false` 是写在提示词里的，挪走就失效
    fresh();
    const v3 = await generateVideo(vidArk, { prompt: "猫走路", filename: "r3.mp4", first_frame: "参考.png", last_frame: "参考2.png" }, { saveDir: dir, resolveFile });
    assert(!v3.isError, "方舟带首尾帧生视频失败：" + v3.content);
    const cont = seen[0].body.content;
    assert(cont[0].type === "text" && /--watermark false/.test(cont[0].text), "方舟这条的关水印指令被挤掉了：" + JSON.stringify(cont[0]));
    assert(cont.length === 3 && cont[1].role === "first_frame" && cont[2].role === "last_frame"
      && DATA_PNG.test(cont[1].image_url.url) && DATA_PNG.test(cont[2].image_url.url),
      "方舟首尾帧的结构不对：" + JSON.stringify(cont.map((c) => c.role || c.type)));

    // ── 3. 渠道不收图：报错，绝不静默退回纯文生 ─────────────────────────────
    mode = "noimage"; fresh();
    const bad1 = await generateImage(img, { prompt: "同一只猫", filename: "r5.png", reference_images: ["参考.png"] }, 5000, dir, resolveFile);
    assert(bad1.isError, "渠道明说不收 image，却当成出图成功了——用户会以为新图跟参考图是一致的：" + bad1.content);
    assert(/参考图/.test(bad1.content) && /不会自动退回/.test(bad1.content), "渠道不收图时没把话说清楚：" + bad1.content);
    assert(!seen.some((x) => !("image" in x.body)), "偷偷去掉参考图重发了一次纯文生图，发了 " + seen.length + " 次");

    fresh();
    const bad2 = await generateVideo(vidDs, { prompt: "猫走路", filename: "r6.mp4", first_frame: "参考.png" }, { saveDir: dir, resolveFile });
    assert(bad2.isError, "渠道不收首帧却当成出片成功了：" + bad2.content);
    assert(/首帧/.test(bad2.content) && /不会自动退回/.test(bad2.content), "渠道不收首帧时没把话说清楚：" + bad2.content);
    assert(!seen.some((x) => !((x.body.input || {}).img_url)), "偷偷去掉首帧重提了一次纯文生视频，提交了 " + seen.length + " 次");
    mode = "accept";

    // ── 4. 花钱之前就该拦下的几种 ─────────────────────────────────────────
    fresh();
    const e1 = await generateVideo(vidDs, { prompt: "猫走路", filename: "x.mp4" }, { saveDir: dir, resolveFile });
    assert(e1.isError && /图生视频/.test(e1.content), "i2v 型号不给图也照发，白花一次钱：" + e1.content);
    assert(seen.length === 0, "i2v 型号缺图这条竟然真发出去了，发了 " + seen.length + " 次");

    fresh();
    const e2 = await generateVideo(vidDsT2v, { prompt: "猫走路", filename: "x.mp4", first_frame: "参考.png" }, { saveDir: dir, resolveFile });
    assert(e2.isError && /文生视频/.test(e2.content), "t2v 型号硬塞首帧也照发：" + e2.content);
    assert(seen.length === 0, "t2v 型号塞图这条竟然真发出去了");

    // 这条特意用 t2v 型号：拿 i2v 型号来测「只给尾帧」会撞上上面那条 i2v 缺图的报错，
    // 两种错的措辞里都有 first_frame，于是把这道闸门拆了也照样绿——变异测出来的正是这个
    fresh();
    const e3 = await generateVideo(vidDsT2v, { prompt: "猫走路", filename: "x.mp4", last_frame: "参考.png" }, { saveDir: dir, resolveFile });
    assert(e3.isError && /尾帧得跟首帧配着用/.test(e3.content), "只给尾帧没被拦住：" + e3.content);
    assert(seen.length === 0, "只给尾帧这条竟然真发出去了");

    fresh();
    const e4 = await generateImage(img, { prompt: "p", reference_images: ["没有这张.png"] }, 5000, dir, resolveFile);
    assert(e4.isError && /list_files/.test(e4.content), "参考图不存在时没指路去查真实文件名：" + e4.content);
    const e5 = await generateImage(img, { prompt: "p", reference_images: ["笔记.txt"] }, 5000, dir, resolveFile);
    assert(e5.isError && /不是图片/.test(e5.content), "把 txt 当参考图发出去了：" + e5.content);
    const e6 = await generateImage(img, { prompt: "p", reference_images: ["参考.png", "参考2.png", "参考.png", "参考2.png", "参考.png"] }, 5000, dir, resolveFile);
    assert(e6.isError && /最多 4 张/.test(e6.content), "参考图超量没被拦：" + e6.content);
    const e7 = await generateImage(img, { prompt: "p", reference_images: ["参考.png"] }, 5000, dir);
    assert(e7.isError && /参考图/.test(e7.content), "没有文件解析器时该说清楚，实际：" + e7.content);
    const e8 = await generateVideo(vidDs, { prompt: "p", first_frame: "参考.png" }, { saveDir: dir });
    assert(e8.isError && /首尾帧/.test(e8.content), "生视频没有文件解析器时该说清楚，实际：" + e8.content);
    assert(seen.length === 0, "这几条本该一个请求都不发，实际发了 " + seen.length + " 次");

    // ── 反向断言：判据自己得能判死 ─────────────────────────────────────────
    // 「漏传参考图的请求体」必须被第 2 组那条判据判失败，否则代码哪天改回不传图，测试照样绿
    let c1 = false;
    try { assert(typeof ({ model: "m", prompt: "p" }).image === "string", "x"); } catch { c1 = true; }
    assert(c1, "闸门判据失效：压根没带 image 的请求体居然也能过");
    // 「静默退回纯文生」必须被第 3 组那条判据判失败
    let c2 = false;
    try { assert(!([{ body: { image: "d" } }, { body: { prompt: "p" } }]).some((x) => !("image" in x.body)), "x"); } catch { c2 = true; }
    assert(c2, "闸门判据失效：偷偷重发一次纯文生图居然也能过");
    // 「型号不对却照发」必须被第 4 组那条判据判失败
    let c3 = false;
    try { assert(({ isError: false, content: "视频已生成" }).isError && /图生视频/.test("视频已生成"), "x"); } catch { c3 = true; }
    assert(c3, "闸门判据失效：i2v 缺图却出片成功居然也能过");

    console.log("✅ 图当输入闸门：不传不变体 · 传了真发出去 · 渠道不收就报错不退回 · 型号对不上先拦下");
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 视频那五家协议：请求真发对了地方、回执真解对了字段。
 *
 * 为什么值得单开一组：视频这一路没有 OpenAI 兼容这个最大公约数。五家的提交路径、
 * 参数名、轮询方式、结果取法没一处对得上——万相是 input.img_url，方舟是 content 数组，
 * 智谱是 image_url，海螺是 first_frame_image，硅基是 image；查状态更是四家 GET、
 * 硅基一家 POST。任何一处抄错，用户那边看到的都是「提交成功、然后卡十分钟超时」，
 * 而这十分钟是按条计费的。
 *
 * 三条红线：
 *   1. 认协议要认得准，也要认得出「认不出」。认不出就别发——发出去必然失败，
 *      还要等几分钟才看得到错。中转和自建网关地址里看不出上游，得能靠渠道类型点名。
 *   2. HTTP 200 不等于成功。海螺把成败写在 base_resp.status_code 里，只看 r.ok 的话，
 *      一句「余额不足」会被当成提交成功，然后在轮询里空转满十分钟。
 *   3. 回执里关于水印那句必须是真话。新接的三家根本没有水印开关，
 *      照旧说「已按无水印出片」是骗人——人会信了它不去看片尾。
 */
async function testVideoProtocols() {
  const http = require("http");
  const os = require("os");
  const { generateVideo } = require("../tools")._internals;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-vproto-"));
  fs.writeFileSync(path.join(dir, "首帧.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  fs.writeFileSync(path.join(dir, "尾帧.png"), fs.readFileSync(path.join(dir, "首帧.png")));
  const resolveFile = (rel) => path.join(dir, rel);

  const seen = [];
  // 每家一个开关，专门用来演「提交那一步就翻车」和「轮询轮到失败」
  let mmCode = 0, mmStatus = "Success", zhStatus = "SUCCESS", sfStatus = "Succeed", mmFile = true;
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      const vurl = `http://127.0.0.1:${srv.address().port}/v.mp4`;
      if (/v\.mp4$/.test(req.url)) { res.writeHead(200, { "Content-Type": "video/mp4" }); return res.end(Buffer.from("fake-mp4")); }
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {}
      seen.push({ url: req.url, method: req.method, body, auth: req.headers.authorization || "" });
      // ── 智谱 CogVideoX ──
      if (/\/videos\/generations$/.test(req.url)) return j(200, { id: "zp1", request_id: "rq1" });
      if (/\/async-result\/zp1$/.test(req.url)) {
        return j(200, zhStatus === "SUCCESS"
          ? { task_status: "SUCCESS", video_result: [{ url: vurl, cover_image_url: vurl }] }
          : { task_status: zhStatus });
      }
      // ── MiniMax 海螺 ──
      if (/\/video_generation$/.test(req.url)) return j(200, { task_id: "mm1", base_resp: { status_code: mmCode, status_msg: mmCode ? "insufficient balance" : "success" } });
      if (/\/query\/video_generation\?/.test(req.url)) return j(200, { task_id: "mm1", status: mmStatus, file_id: mmStatus === "Success" ? "f77" : "" });
      if (/\/files\/retrieve\?/.test(req.url)) return j(200, mmFile ? { file: { file_id: "f77", download_url: vurl } } : { file: {} });
      // ── 硅基流动 ──
      if (/\/video\/submit$/.test(req.url)) return j(200, { requestId: "sf1" });
      if (/\/video\/status$/.test(req.url)) {
        return j(200, sfStatus === "Succeed"
          ? { status: "Succeed", results: { videos: [{ url: vurl }], seed: 1 } }
          : { status: sfStatus, reason: "模型排队超时" });
      }
      return j(404, { error: "这条路径没人接：" + req.url });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const at = (p) => `http://127.0.0.1:${port}${p}`;
  // 地址里带上各家的招牌字样，走的是 videoProtoOf 的第二档（按域名认）
  const zhipu = { video: { base_url: at("/bigmodel/api/paas/v4"), model: "cogvideox-3", api_key: "k-zp" } };
  const minimax = { video: { base_url: at("/minimax/v1"), model: "MiniMax-Hailuo-02", api_key: "k-mm" } };
  const silicon = { video: { base_url: at("/siliconflow/v1"), model: "Wan-AI/Wan2.2-T2V-A14B", api_key: "k-sf" } };
  const dash = { video: { base_url: at("/dashscope/api/v1"), model: "wan2.2-t2v-plus", api_key: "k-ds" } };
  const DATA_PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
  const fresh = () => { seen.length = 0; };
  const hit = (re) => seen.find((x) => re.test(x.url));
  // 轮询轮到失败是抛出来的，不是 isError——这是万相那条从一开始就有的老约定
  // （executeTool 外面那层 catch 会统一裹成「工具执行出错: …」）。新接的三家得跟它一样，
  // 不然同一种翻车在五家渠道上会长出两种形状，调用方还得分情况处理
  const caught = async (fn) => { try { return { r: await fn() }; } catch (e) { return { err: (e && e.message) || String(e) }; } };

  try {
    // ── ① 智谱：提交 /videos/generations，轮询 /async-result/{id} ──────────────
    fresh();
    const z1 = await generateVideo(zhipu, { prompt: "猫走路", filename: "zp1.mp4" }, { saveDir: dir, resolveFile });
    assert(!z1.isError, "智谱文生视频挂了：" + z1.content);
    const zp = hit(/\/videos\/generations$/);
    assert(zp && zp.method === "POST" && zp.auth === "Bearer k-zp", "智谱提交没发对或没带这条渠道的 Key：" + JSON.stringify(zp && { m: zp.method, a: zp.auth }));
    assert(zp.body.model === "cogvideox-3" && zp.body.prompt === "猫走路", "智谱请求体的 model/prompt 不对：" + JSON.stringify(zp.body));
    assert(!("image_url" in zp.body), "没给首帧却往智谱请求体里塞了 image_url：" + JSON.stringify(Object.keys(zp.body)));
    assert(hit(/\/async-result\/zp1$/), "智谱没去 /async-result/{id} 轮询，实际打的是：" + seen.map((x) => x.url).join(" "));
    assert(fs.existsSync(path.join(dir, "zp1.mp4")), "智谱那条说成功了，片子却没落到工作目录");

    fresh();
    const z2 = await generateVideo(zhipu, { prompt: "猫走路", filename: "zp2.mp4", first_frame: "首帧.png" }, { saveDir: dir, resolveFile });
    assert(!z2.isError, "智谱图生视频挂了：" + z2.content);
    assert(DATA_PNG.test(hit(/\/videos\/generations$/).body.image_url), "智谱的首帧该走 image_url 且是 data: URI：" + JSON.stringify(hit(/\/videos\/generations$/).body).slice(0, 100));

    // ── ② 海螺：提交 → 轮询 → file_id 换下载地址，三段 ────────────────────────
    fresh();
    const m1 = await generateVideo(minimax, { prompt: "猫走路", filename: "mm1.mp4", first_frame: "首帧.png" }, { saveDir: dir, resolveFile });
    assert(!m1.isError, "海螺图生视频挂了：" + m1.content);
    const mp = hit(/\/video_generation$/);
    assert(mp && mp.method === "POST" && mp.auth === "Bearer k-mm", "海螺提交没发对：" + JSON.stringify(mp && { m: mp.method, a: mp.auth }));
    assert(DATA_PNG.test(mp.body.first_frame_image), "海螺的首帧该走 first_frame_image：" + JSON.stringify(Object.keys(mp.body)));
    assert(hit(/\/query\/video_generation\?task_id=mm1/), "海螺没拿 task_id 去轮询：" + seen.map((x) => x.url).join(" "));
    assert(hit(/\/files\/retrieve\?file_id=f77/), "海螺拿到 file_id 后没去换下载地址（它轮询回的不是 url，是个 id）：" + seen.map((x) => x.url).join(" "));
    assert(fs.existsSync(path.join(dir, "mm1.mp4")), "海螺那条说成功了，片子却没落到工作目录");

    // 这条是这一组里最该守住的：HTTP 200，但 base_resp 说余额不足。
    // 不看 base_resp 的话，这一趟会被当成提交成功，然后在轮询里空转满十分钟才报超时
    mmCode = 1008; fresh();
    const m2 = await generateVideo(minimax, { prompt: "猫走路", filename: "mm2.mp4" }, { saveDir: dir, resolveFile });
    assert(m2.isError, "海螺回了 200 但 base_resp 说余额不足，却当成提交成功了——这会在轮询里空转满十分钟：" + m2.content);
    assert(/1008/.test(m2.content), "海螺的错误码没带出来，人不知道去查什么：" + m2.content);
    assert(!hit(/\/query\/video_generation/), "提交明明失败了还去轮询了");
    mmCode = 0;

    mmStatus = "Fail"; fresh();
    const m3 = await caught(() => generateVideo(minimax, { prompt: "猫走路", filename: "mm3.mp4" }, { saveDir: dir, resolveFile }));
    assert(m3.err && /视频任务失败/.test(m3.err), "海螺轮询轮到 Fail 却当成出片成功了：" + JSON.stringify(m3));
    assert(!fs.existsSync(path.join(dir, "mm3.mp4")), "任务明明失败了，还是往工作目录里落了个文件");
    mmStatus = "Success";

    mmFile = false; fresh();
    const m4 = await generateVideo(minimax, { prompt: "猫走路", filename: "mm4.mp4" }, { saveDir: dir, resolveFile });
    assert(m4.isError && /file_id/.test(m4.content), "换不到下载地址时该把 file_id 说出来让人手动下：" + m4.content);
    mmFile = true;

    // ── ③ 硅基流动：查状态是 POST，不是 GET ─────────────────────────────────
    fresh();
    const s1 = await generateVideo(silicon, { prompt: "猫走路", filename: "sf1.mp4" }, { saveDir: dir, resolveFile });
    assert(!s1.isError, "硅基文生视频挂了：" + s1.content);
    const sp = hit(/\/video\/submit$/);
    assert(sp && sp.body.model === "Wan-AI/Wan2.2-T2V-A14B" && sp.auth === "Bearer k-sf", "硅基提交没发对：" + JSON.stringify(sp && sp.body));
    const st = hit(/\/video\/status$/);
    assert(st && st.method === "POST" && st.body.requestId === "sf1",
      "硅基查状态得是 POST 带 requestId——照 GET 发会收到 405，看起来像地址写错了：" + JSON.stringify(st && { m: st.method, b: st.body }));
    assert(fs.existsSync(path.join(dir, "sf1.mp4")), "硅基那条说成功了，片子却没落到工作目录");

    sfStatus = "Failed"; fresh();
    const s2 = await caught(() => generateVideo(silicon, { prompt: "猫走路", filename: "sf2.mp4" }, { saveDir: dir, resolveFile }));
    assert(s2.err && /视频任务失败/.test(s2.err), "硅基轮询轮到 Failed 却当成出片成功了：" + JSON.stringify(s2));
    assert(/排队超时/.test(s2.err), "硅基的 reason 没带出来，人不知道为什么失败：" + s2.err);
    sfStatus = "Succeed";

    // ── ④ 尾帧：只有万相 kf2v 和方舟收，另外三家当场说清，一个请求都不许发 ──────
    for (const [who, cfg] of [["智谱", zhipu], ["海螺", minimax], ["硅基", silicon]]) {
      fresh();
      const r = await generateVideo(cfg, { prompt: "从这张变到那张", filename: "kf.mp4", first_frame: "首帧.png", last_frame: "尾帧.png" }, { saveDir: dir, resolveFile });
      assert(r.isError && /尾帧/.test(r.content), `${who} 收了 last_frame——它的接口里根本没这个字段，钱会照扣而尾帧不生效：` + r.content);
      assert(seen.length === 0, `${who} 那条尾帧竟然真发出去了，发了 ` + seen.length + " 次");
    }

    // ── ⑤ 认不出是哪家：别发，并且把「按什么认的」摊开说 ──────────────────────
    fresh();
    const unknown = { video: { base_url: at("/gw/v1"), model: "某个视频模型", api_key: "k" } };
    const u1 = await generateVideo(unknown, { prompt: "猫走路", filename: "u1.mp4" }, { saveDir: dir, resolveFile });
    assert(u1.isError, "认不出协议还是把请求发出去了：" + u1.content);
    assert(seen.length === 0, "认不出协议却发了 " + seen.length + " 次请求");
    for (const name of ["万相", "Seedance", "CogVideoX", "海螺", "硅基流动"]) {
      assert(u1.content.includes(name), `支持列表里漏了 ${name}：` + u1.content);
    }
    assert(/渠道类型/.test(u1.content), "没指路去改渠道类型——中转地址里本来就看不出上游，只说「不支持」的话人会去改地址：" + u1.content);

    // ── ⑥ 中转/自建网关：地址看不出，靠渠道类型或条目上的 protocol 点名 ─────────
    fresh();
    const byKind = { video: { base_url: at("/gw/v1"), model: "MiniMax-Hailuo-02", api_key: "k-mm", kind: "minimax" } };
    const k1 = await generateVideo(byKind, { prompt: "猫走路", filename: "k1.mp4" }, { saveDir: dir, resolveFile });
    assert(!k1.isError, "渠道类型选了 minimax，却没按海螺发：" + k1.content);
    assert(hit(/\/gw\/v1\/video_generation$/), "没打到网关地址下的海螺路径：" + seen.map((x) => x.url).join(" "));

    fresh();
    const byProto = { video: { base_url: at("/gw/v1"), model: "cogvideox-3", api_key: "k-zp", protocol: "zhipu" } };
    const k2 = await generateVideo(byProto, { prompt: "猫走路", filename: "k2.mp4" }, { saveDir: dir, resolveFile });
    assert(!k2.isError, "条目上写了 protocol=zhipu，却没按智谱发：" + k2.content);
    assert(hit(/\/gw\/v1\/videos\/generations$/), "没打到网关地址下的智谱路径：" + seen.map((x) => x.url).join(" "));

    // 渠道类型比地址优先：地址明摆着写着 dashscope，但人在卡上选了智谱，就得听人的
    fresh();
    const override = { video: { base_url: at("/dashscope/api/v1"), model: "cogvideox-3", api_key: "k-zp", kind: "zhipu" } };
    const k3 = await generateVideo(override, { prompt: "猫走路", filename: "k3.mp4" }, { saveDir: dir, resolveFile });
    assert(!k3.isError, "渠道类型压不住地址：" + k3.content);
    assert(hit(/\/videos\/generations$/) && !hit(/video-synthesis/), "渠道类型选了智谱，还是按地址当成万相发了：" + seen.map((x) => x.url).join(" "));

    // ── ⑦ 水印那句话得是真话 ────────────────────────────────────────────────
    fresh();
    assert(/没有水印开关/.test(z1.content) && !/已按无水印出片/.test(z1.content),
      "智谱没有 watermark 参数，回执却说「已按无水印出片」——人会信了它不去看片尾：" + z1.content);
    assert(/没有水印开关/.test(s1.content), "硅基那条的水印措辞也得照实说：" + s1.content);
    assert(/没有水印开关/.test(m1.content), "海螺那条的水印措辞也得照实说：" + m1.content);
    // 反向对照：万相是真问过的，那句「已按无水印出片」在它身上仍要保留
    const d1 = await generateVideo(dash, { prompt: "猫走路", filename: "ds1.mp4" }, { saveDir: dir, resolveFile });
    assert(d1.isError, "替身没接万相的提交路径，这条本来就该报错（用它只为验证措辞分支）：" + d1.content);

    // ── 反向断言：判据自己得能判死 ─────────────────────────────────────────
    // 「只看 r.ok」必须被 ② 那条判据判失败，否则代码哪天改回不看 base_resp，测试照样绿
    let c1 = false;
    try { assert(({ isError: false, content: "视频已生成" }).isError, "x"); } catch { c1 = true; }
    assert(c1, "闸门判据失效：base_resp 说失败却出片成功居然也能过");
    // 「认不出却照发」必须被 ⑤ 那条判据判失败
    let c2 = false;
    try { assert([{ url: "/gw/v1/x" }].length === 0, "x"); } catch { c2 = true; }
    assert(c2, "闸门判据失效：认不出协议却发了请求居然也能过");

    console.log("✅ 视频五家协议：智谱/海螺/硅基三家的路径·参数名·轮询方式各自发对（海螺还多一手 file_id 换地址）· 200 里藏的 base_resp 失败当场拦下 · 尾帧只认万相和方舟 · 认不出就不发并说清按什么认的 · 渠道类型压得住地址 · 水印那句不说假话");
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 多媒体那四路的 Key，跟对话模型共用同一张渠道表（docs/模型与Key管理_调研与改法.md），
 * 所以同一个 Key 会被两边拿去用。以前两边的洗法不一样：
 *
 *   对话  → cleanKey：非 ASCII 当场拦下，说清第几个字符不对、去哪儿重贴
 *   图声视 → String(...).trim()：中文字照发，栽在 undici 里变成一句
 *            "Cannot convert argument to a ByteString"——这句话对用户毫无意义
 *
 * 从网页控制台复制 Key 多框进一个字，是新手最常见的翻车方式（尤其现在新增了智谱/海螺/
 * 硅基这几家的取 Key 链接，点进去就是网页）。同一个毛病不该在五个入口长出两副面孔。
 *
 * 顺带钉住一个 trim() 根本管不了的情况：结尾粘了个零宽空格（U+200B）。网页复制的
 * 重灾区，肉眼完全看不见，trim() 也不动它，于是同样炸在 undici 里；cleanKey 会把它
 * 连同首尾空白一起削掉，请求照常发出去。
 */
async function testMediaKeyHygiene() {
  const http = require("http");
  const os = require("os");
  const T = require("../tools")._internals;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mkey-"));
  fs.writeFileSync(path.join(dir, "图.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  fs.writeFileSync(path.join(dir, "录音.mp3"), Buffer.alloc(4096, 7)); // 只要过「>200 字节 + 扩展名」那两关
  const resolveFile = (rel) => path.join(dir, rel);

  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization || "" });
      if (/\/audio\/speech$/.test(req.url)) { res.writeHead(200, { "Content-Type": "audio/mpeg" }); return res.end(Buffer.from("fake-mp3")); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from("fake-png").toString("base64") }], text: "听写结果", choices: [{ message: { content: "图里是只猫" } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const at = (s) => `http://127.0.0.1:${srv.address().port}${s}`;
  const caught = async (fn) => { try { return { r: await fn() }; } catch (e) { return { err: (e && e.message) || String(e) }; } };
  const fresh = () => { seen.length = 0; };

  try {
    // ── ① 五个入口，同一个脏 Key，同一种说法，而且一个请求都不许发出去 ──────────
    // 「令牌」两个汉字模拟从网页上多框了一段中文说明
    const BAD = "sk-abc令牌";
    const mk = (cap, extra) => ({ [cap]: { base_url: at("/v1"), model: "m1", api_key: BAD, name: "我的渠道", ...(extra || {}) } });
    const entries = [
      ["看图", () => T.lookAtImage({ media: mk("vision"), visionFallback: {} }, { path: "图.png", question: "这是什么" }, 5000, resolveFile)],
      ["生图", () => T.generateImage(mk("image"), { prompt: "一只猫", filename: "a.png" }, 5000, dir, resolveFile)],
      ["生视频", () => T.generateVideo({ video: { base_url: at("/dashscope/api/v1"), model: "wan2.2-t2v-plus", api_key: BAD, name: "我的渠道" } }, { prompt: "猫走路", filename: "a.mp4" }, { saveDir: dir, resolveFile })],
      ["配音", () => T.textToSpeech(mk("tts"), { text: "你好", filename: "a.mp3" }, 5000, dir)],
      ["转写", () => T.transcribeAudio(mk("asr"), { path: "录音.mp3" }, 5000, resolveFile, dir)],
    ];
    for (const [名, run] of entries) {
      fresh();
      const got = await caught(run);
      const msg = got.err || (got.r && got.r.content) || "";
      assert(!(got.r && got.r.isError === false), `${名}：Key 里有中文却当成正常跑完了 → ${msg.slice(0, 120)}`);
      assert(/第 7 个字符/.test(msg), `${名}：没说清是第几个字符不对（对话那边是这么说的，这边也得一样）→ ${msg.slice(0, 200)}`);
      assert(/设置\s*→\s*模型/.test(msg), `${名}：没告诉用户去哪儿重贴 Key → ${msg.slice(0, 200)}`);
      assert(/我的渠道/.test(msg), `${名}：没说是哪条渠道的 Key（配了好几条时全靠这个认）→ ${msg.slice(0, 200)}`);
      assert(seen.length === 0, `${名}：Key 明显发不出去，却还是把请求打出去了（${seen.map((x) => x.url).join(" ")}）`);
    }

    // ── ② trim() 管不了的那个：结尾一个零宽空格，必须洗掉而不是拦下 ──────────
    // 这是网页复制的重灾区，肉眼看不见。以前 trim() 留着它，undici 照样报 ByteString；
    // 现在该原样发出一个干净的 Bearer
    fresh();
    const ok1 = await T.generateImage(
      { image: { base_url: at("/v1"), model: "m1", api_key: "  sk-clean​\n" } },
      { prompt: "一只猫", filename: "clean.png" }, 5000, dir, resolveFile);
    assert(!ok1.isError, "首尾空白 + 零宽空格的 Key 应该被洗干净照常发，结果报错了：" + ok1.content);
    assert(seen.length > 0 && seen[0].auth === "Bearer sk-clean",
      "洗完的 Key 不对，实际发出去的是 " + JSON.stringify(seen[0] && seen[0].auth));

    // ── ③ 反向断言：判据自己得能判死 ────────────────────────────────────────
    let c1 = false;
    try { assert(/第 7 个字符/.test("Cannot convert argument to a ByteString"), "x"); } catch { c1 = true; }
    assert(c1, "闸门判据失效：undici 那句原始报错居然也算说清楚了");
    let c2 = false;
    try { assert("Bearer sk-clean​" === "Bearer sk-clean", "x"); } catch { c2 = true; }
    assert(c2, "闸门判据失效：零宽空格没削掉居然也算洗干净了");

    console.log("✅ 多媒体 Key 洗法和对话对齐：看图/生图/生视频/配音/转写五个入口，Key 里混进中文一律当场拦下并说清第几个字符·哪条渠道·去哪儿重贴（一个请求都不发）· 零宽空格照洗不照拦");
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
 *  2. 答案走 stdout、进度走 stderr。`openworkbuddy "..." > 答案.md` 拿到的得是干净答案。
 *  3. 退出码说实话。以前无论成败恒 0，`openworkbuddy ... && 下一步` 在任务失败时照样往下走。
 *  4. -C 指了个用不了的目录必须当场停，不许默默退回默认目录——那会把文件写到别处。
 */
async function testCliMode() {
  const http = require("http");
  const os = require("os");
  const { spawn } = require("child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cli-"));
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
      // 第一趟先让模型去问用户一句，之后照常收尾。用来验「那头到底有没有人」这件事
      if (mode === "ask" && !seen.some((b) => JSON.stringify(b).includes("无人值守"))) {
        return j(200, {
          choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
            id: "call_ask_1", type: "function",
            function: { name: "ask_user", arguments: JSON.stringify({ question: "报告交哪种格式？", options: [{ label: "Word", detail: "能改" }, { label: "PDF", detail: "版式锁死" }] }) },
          }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        });
      }
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
    //     这条是重定向出来直接当文件用的（openworkbuddy -q "写周报" > 周报.md），多一行就是脏数据
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

    // 10）agent 问一句时，那头到底有没有人。
    //
    //   这条钉的是**危险的那个方向**。cli.js 现在会在有人坐在终端前时给 agent 传 askUser
    //   （在这之前它从来不传，于是最近在场的那个人反倒是唯一问不到的人）。可管道喂进来的
    //   `openworkbuddy "…" < 任务.txt`、给脚本读的 --json，那头确实没人——要是把这两种也算成「有人」，
    //   agent 会一直等一个永远不会来的回答，`openworkbuddy` 就此挂死。这里 stdin 是条管道：
    //   必须原样跑完、退出码 0，而且模型收到的得是「无人值守」那句。
    mode = "ask";
    const rAsk = await run(["--no-mcp", "帮我写个报告"], "");
    mode = "ok";
    assert.strictEqual(rAsk.status, 0, "模型问了一句，管道模式下 openworkbuddy 没能跑完（多半是在等一个永远不会来的回答）：" + rAsk.stderr.slice(-500));
    const askBodies = seen.map((b) => JSON.stringify(b)).join("\n");
    assert(askBodies.includes("无人值守"), "管道模式下 agent 没被告知没人在线，它会傻等");
    assert(!/答> /.test(rAsk.stderr), "没人的时候还把选择题摆了出来：" + rAsk.stderr.slice(-300));

    // 3）退出码说实话
    mode = "boom";
    const r7 = await run(["--no-mcp", "这条会炸"]);
    assert.notStrictEqual(r7.status, 0, "模型报错了退出码还是 0，脚本里 `openworkbuddy ... && 下一步` 会照样往下走");
    assert(r7.stderr.includes("出错"), "出错了 stderr 上没说：" + r7.stderr.slice(-300));
    mode = "ok";

    // 4）-C 指了个建不出来的目录必须停，不许默默退回默认目录
    fs.writeFileSync(path.join(home, "这是个文件"), "x");
    const r8 = await run(["--no-mcp", "-C", path.join(home, "这是个文件", "子目录"), "随便干点啥"]);
    assert.notStrictEqual(r8.status, 0, "-C 指了个用不了的目录却照跑，文件会被写到别处");
    assert(/工作目录用不了/.test(r8.stderr), "-C 失败时没说清是目录的问题：" + r8.stderr.slice(-300));

    // 9）带文件进去：真跑一趟 openworkbuddy，看挂在请求体上的是不是那句标记
    //    单元测试证得了每个零件对，证不了这趟进程真把它挂上了——中间少接一根线，
    //    人拖进来的文件就是「发出去了但模型没看见」，而终端上什么异常都不会有。
    const att = path.join(home, "带进来的.md");
    fs.writeFileSync(att, "这里面写着 ZETA9527 这个暗号");
    const r9 = await run(["--no-mcp", "-f", att, "这文件里写了什么"]);
    assert.strictEqual(r9.status, 0, "-f 带文件跑失败：" + r9.stderr.slice(-500));
    // 只看用户那条消息：系统提示词里本来就写着这个标记是什么意思（agent.js 规范 3.1），
    // 拿整个请求体当判据的话，标记根本没挂上去也是绿的
    const lastUser = () => {
      const msgs = (seen[seen.length - 1] || {}).messages || [];
      const u = msgs.filter((m) => m.role === "user");
      return String((u[u.length - 1] || {}).content || "");
    };
    const u9 = lastUser();
    assert(u9.includes("（已上传文件："), "-f 带了文件，用户那条消息上却没挂标记，模型根本不知道有文件：" + JSON.stringify(u9));
    assert(u9.includes("带进来的.md"), "标记里没有文件名：" + JSON.stringify(u9));
    assert(u9.includes("这文件里写了什么"), "挂了标记却把人要问的话弄丢了：" + JSON.stringify(u9));
    assert(!JSON.stringify(seen[seen.length - 1]).includes("ZETA9527"),
      "★文件正文被塞进对话历史了★ 历史每一步都重发，图片会把上下文撑爆、纯文本模型直接 400，而会话是存盘的——这一步等于把这个会话永久弄坏");

    // 反向对照：不带 -f 的那趟，用户消息上一个标记都不许有。
    // 没这条的话，「标记是常驻的」这种错也会让上面全绿。
    const r9b = await run(["--no-mcp", "随便问一句"]);
    assert.strictEqual(r9b.status, 0, "普通一趟失败：" + r9b.stderr.slice(-500));
    assert(!lastUser().includes("已上传文件"), "没带文件也挂了标记，模型会去找一个不存在的文件：" + JSON.stringify(lastUser()));

    // -f 指的文件不在：当场停，别让模型对着一个不存在的名字瞎猜（钱花了事没办）
    const r9c = await run(["--no-mcp", "-f", path.join(home, "没这个文件.png"), "看看"]);
    assert.strictEqual(r9c.status, 2, "-f 指了个不存在的文件却照跑，退出码是 " + r9c.status);
    assert(/找不到这个文件/.test(r9c.stderr), "-f 找不到文件时没说人话：" + r9c.stderr.slice(-300));

    // 带了文件却没说要干什么：停，并且**一个字节都不许往工作目录里搬**——
    // 搬完才报错的话，人补一句话重跑，目录里就会多出一份 带进来的-2.md
    const wsBefore = fs.existsSync(path.join(home, "workspace"))
      ? fs.readdirSync(path.join(home, "workspace")).length : 0;
    const r9d = await run(["--no-mcp", "-f", att]);
    assert.strictEqual(r9d.status, 2, "只带文件没给话，退出码是 " + r9d.status);
    const wsAfter = fs.existsSync(path.join(home, "workspace"))
      ? fs.readdirSync(path.join(home, "workspace")).length : 0;
    assert.strictEqual(wsAfter, wsBefore, "★没跑成却先把文件搬进去了★ 重跑一次工作目录里就会多一份重名副本");

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
    console.log(`✅ CLI 模式：单发不串台（续接才带上下文）· 答案走 stdout 进度走 stderr · 退出码 0/1 说实话 · 管道进料 · --json 可解析 · -q 是干净正文 · --list 本地时间与轮数对得上 · -C 用不了就停 · -f 带文件只挂标记不塞正文`);
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

// 上下文余量条得跟着会话走。
// 用户原话：「怎么我切换对话了它还是一样的啊」——这根条全界面只有一根，画在输入框上头，
// 而它只在后端播 context 事件的时候重画。换会话没有事件可等（新对话本来就还没跑），
// 于是上一条对话那句「上下文 87%…」原样挂着，指着一个跟眼前这条对话毫不相干的数。
// 条子本身怎么画，test/frontend.js 在真 Chromium 里验；这儿只钉死接线——
// 每一条「换对话」的路上都得把它收回去，以及后台并行会话的数不许画到当前这条上。
// 接线断了在界面上是看不出来的（条子还在、数还对，只是对的是别人那条对话），所以钉在这儿。
function testCtxMeterWiring() {
  const A1 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8");
  const A2 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
  assert(/function resetCtxMeter\(/.test(A1), "app-01.js 里没有 resetCtxMeter：换会话没人收这根条");

  // 后台会话的余量不许画到当前这条对话上（这一段 app-01.js 全篇的口径都是 turnSid === sessionId）
  const ctxBranch = A1.slice(A1.indexOf('} else if (ev.type === "context") {'), A1.indexOf('} else if (ev.type === "usage") {'));
  assert(ctxBranch.length > 20, "app-01.js 里 context 事件那个分支找不到了（事件改名了？），这一条在空转");
  assert(/turnSid === sessionId/.test(ctxBranch) && /renderCtxMeter\(/.test(ctxBranch),
    "后台并行会话的 context 事件会画到当前这条对话的余量条上——切走的那条在跑，眼前这条的百分比跟着它跳");

  // 三条「换对话」的路：历史列表点开、终端那趟的直播、新任务
  const paths = [
    ["点开一条历史对话", A2.indexOf("async function openSession("), A2.indexOf('document.getElementById("new-task").onclick')],
    ["跟一趟终端里起的任务", A2.indexOf("async function openCliLive(row) {"), A2.indexOf("es.onmessage", A2.indexOf("async function openCliLive(row) {"))],
    ["开新任务", A2.indexOf('document.getElementById("new-task").onclick'), A2.indexOf("renderHistory();\nrenderLaneTabs();")],
  ];
  for (const [what, a, b] of paths) {
    assert(a > 0 && b > a, `app-02.js 里「${what}」那段切不出来（改名/挪窝了？），这一条在空转，别让它悄悄变绿`);
    assert(/resetCtxMeter\(\)/.test(A2.slice(a, b)),
      `「${what}」没把上下文余量条收回去：上一条对话的百分比会留在屏幕上，指着一个跟新对话无关的数`);
  }
  console.log("✅ 上下文余量条接线：三条换对话的路都收条子 / 后台会话的数不画到当前对话上");
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
  // ── 参数尾巴上多几个字符：能救就别丢 ──
  // 本机真实会话里 ask_user 出现过一次 374 字的参数：前 372 字是一个完整合法的对象，
  // 后面孤零零跟着一个 "]}"。以前整条丢掉 → 界面先红一条空白的「问你一句」，
  // 那一轮几千字推理全白烧，模型再把同样的东西重写一遍才问出来。
  const { parseToolArgs } = require("../llm")._internals;
  const tail = '{"question": "走哪条路？", "options": [{"label": "A", "detail": "甲"}, {"label": "B", "detail": "乙"}]}]}';
  const saved = parseToolArgs(tail, "ask_user");
  assert.strictEqual(saved.question, "走哪条路？", "尾巴多两个字符就整条丢掉，一轮推理白烧：" + JSON.stringify(saved).slice(0, 120));
  assert.strictEqual((saved.options || []).length, 2, "救回来了但选项丢了");
  assert.ok(!saved._raw, "救回来了却还塞着 _raw，下游照样当坏参数拦");
  // 反向对照①：被截断的（字符串没收尾）绝不许硬救——半截参数拿去执行等于替用户瞎编
  const cut = parseToolArgs('{"question": "走哪条路？", "options": [{"label": "A", "detail": "甲乙丙', "ask_user");
  assert.ok(typeof cut._raw === "string", "被截断的参数也硬凑出一个对象来执行了：" + JSON.stringify(cut).slice(0, 120));
  assert.ok(/Unterminated/.test(cut._parseError || ""), "截断的解析器原话没留下");
  // 反向对照②：本来就合法的一个字都不许动
  const fine = parseToolArgs('{"path": "a.md", "content": "}]}"}', "write_file");
  assert.strictEqual(fine.content, "}]}", "字符串里的花括号被当成结构字符切坏了");
  // 反向对照③：正文里带花括号、尾巴上又有垃圾——切的时候得认得出「这个 } 在引号里面」。
  // 按括号配平数括号是最容易写错的那一步：不认引号的话，一段带 } 的正文会被从中间切断，
  // 救回来的是半篇文章，用户看到的产出就少了后半截，而且什么都不报。
  const brace = parseToolArgs('{"path": "a.md", "content": "第一段}结束"}]}', "write_file");
  assert.strictEqual(brace.content, "第一段}结束", "正文里的 } 被当成对象结尾，救回来的是半篇：" + JSON.stringify(brace).slice(0, 120));

  // ── agent.js 里就地接住的那几个工具，也得走同一道坏参数闸 ──
  // ask_user / use_skill / MCP / 委派专家是在 agent.js 的 runToolCall 里直接接住的，
  // 根本走不到 tools.executeTool 里那道闸；以前一路掉进 ask_user 自己的必填校验，
  // 报出来的是「question 不能为空」——模型以为自己漏填字段，原样重发，再坏一次。
  const agentSrc = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
  const runIdx = agentSrc.indexOf("async function runToolCall(");
  const askIdx = agentSrc.indexOf('if (tc.name === "ask_user")', runIdx);
  const guardIdx = agentSrc.indexOf("badToolArgs(tc.name", runIdx);
  assert.ok(runIdx > 0 && askIdx > runIdx, "runToolCall / ask_user 分支找不到了，这条断言已经失效");
  assert.ok(guardIdx > runIdx && guardIdx < askIdx, "坏参数那道闸不在 runToolCall 最前面，ask_user 又会报成「question 不能为空」");
  // 报错的第一行必须短到能整条进过程区：界面只取结果第一行当「· 结果」，长了就是半截话
  const line1 = badToolArgs("ask_user", '{"options": [{"label": "A"', "Unterminated string in JSON at position 557", 557).split("\n")[0];
  assert.ok(line1.length <= 70, "坏参数报错第一行太长，界面上会被截成半截话：" + line1.length);
  assert.ok(/不是合法 JSON/.test(line1) && /截断/.test(line1), "第一行没说清坏在哪：" + line1);
  assert.ok(!/不能为空/.test(badToolArgs("ask_user", "{", "x", 1)), "又绕回「某字段不能为空」了");

  console.log("✅ 上游重试与工具名纠错：5xx/429/断连重试 · 4xx 与超时不重试 · 拼错的工具名给出真名 · 参数不是合法 JSON 时如实说坏在哪（截断/写错分开说，不再报成「缺少某字段」）· 尾巴多几个字符的按括号配平救回来（真实会话里 374 字只多 2 个字符，整轮白烧）· 切的时候认引号（正文里的 } 不当对象结尾）· 被截断的不硬救 · ask_user 这类在 agent.js 就地接住的工具也走同一道闸 · 坏参数只留 400 字进 history（真实会话里一坨 19482 字的残缺 JSON 重发了 12 轮）");
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

/**
 * 拉起一个子测试进程，并给它拴一根看门狗。
 *
 * 2026-09-13 的教训：`npm test` 第一次真正跑在 macOS 的 CI 机器上，前端那个 electron
 * 子进程起来之后就再没回过话。spawnSync 不给 timeout 就是无限等——五次 CI 各烧了一个多
 * 小时，直到人工取消；更难受的是日志里连「卡在哪一步」都看不到：spawnSync 把子进程的输出
 * 全攒在内存里，它不返回就一个字节都拿不到，最后只剩收尾时那句
 * 「Terminate orphan process: pid (30292) (Electron)」。
 *
 * 所以这里定三件事：
 *   ① 给超时。卡住要在几分钟内变红，不是几小时——一个悄悄挂着的 job 比一个红 job 坏得多，
 *      它既不给结论也不放人走。
 *   ② 超时了也要把攒下来的半截输出打出来，最后那行「✓ …」就是卡死的位置。
 *   ③ 用 SIGKILL 收尸：SIGTERM 对 electron 常常不灵，杀不干净就又留一个孤儿进程。
 *
 * 预算按本机实测的 5~10 倍给（前端 21 秒 / 后台 7 秒 / 部署 8 秒），CI 机器慢也够用，
 * 真卡住时又比六个小时快两个数量级。
 */
function runChild(bin, args, opts) {
  const { spawnSync } = require("child_process");
  const { label, timeout, env } = opts;
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024, // 前端那份能吐一千多行，默认 1MB 顶不住
    env: env || process.env,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const tail = (n) => out.trim().split("\n").slice(-(n || 14)).join("\n");
  if (r.error && r.error.code === "ETIMEDOUT") {
    const done = out.split("\n").filter((l) => /^\s*[✓✅]/.test(l));
    throw new Error(
      `${label}卡死了：${Math.round(timeout / 1000)} 秒还没跑完（本机只要几十秒），已强杀。\n` +
      `最后跑完的一步：${done.length ? done[done.length - 1].trim() : "一行都没输出——多半卡在进程启动或第一个窗口创建上"}\n` +
      tail(12)
    );
  }
  if (r.error) throw new Error(`${label}起不来：${r.error.message}\n${tail(12)}`);
  return { status: r.status, out, tail };
}

// 前端的 SVG 信息图渲染要真浏览器才测得准（清洗靠的是 DOM 解析、作用域靠的是真 CSS 匹配），
// 所以单独开一个 electron 子进程跑 test/frontend.js。纯服务端部署没装 electron 就跳过，不算失败。
async function testFrontendSvgFigures() {
  let electronBin;
  try { electronBin = require("electron"); } catch { }
  if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
    console.log("⏭️  前端：未安装 electron，跳过内联 SVG 信息图测试");
    return;
  }
  const { status, out, tail } = runChild(electronBin, [path.join(__dirname, "frontend.js")], {
    label: "前端 SVG 测试",
    timeout: 300000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  if (status !== 0) throw new Error("前端 SVG 测试未通过：\n" + tail(12));
  const lines = out.split("\n").filter((l) => l.startsWith("✅ 前端"));
  if (!lines.length) throw new Error("前端测试没有报告任何一组结果：\n" + tail(12));
  for (const l of lines) console.log(l);
}

// 企业管理后台是 17 个面板 + 哈希路由，最常见的坏法是「某一页 render 里读了个 undefined，整块白屏」——
// 只有真的把每一页点一遍、盯着 console 才看得见。同样开 electron 子进程跑。
/**
 * Docker 一键部署：静态那部分。
 * 只跑不需要 Docker 的断言（.dockerignore 挡没挡住凭证、compose 空环境能不能插值、
 * seedDataDir 会不会漏技能）。真 build 一个镜像跑起来是 `node test/deploy.js --build`，
 * 那个要几分钟，不塞进 e2e。
 */
async function testDockerDeploy() {
  const { status, out, tail } = runChild(process.execPath, [path.join(__dirname, "deploy.js")], {
    label: "Docker 部署测试", timeout: 180000,
  });
  if (status !== 0) throw new Error("Docker 部署测试未通过：\n" + tail());
  const line = out.split("\n").find((l) => l.startsWith("✅ Docker 部署"));
  if (!line) throw new Error("Docker 部署测试没有报告结果：\n" + tail());
  console.log(line);
}

/**
 * 跑一个独立的 node 子测试文件，把它的结论并进 e2e 的成绩单。
 *
 * 这几个文件（多租户、个人偏好）都得在**进程一开始**就把 OPENWORKBUDDY_DATA_DIR 指到临时目录，
 * 才能保证一个字节都不碰真账号、真偏好；e2e 这个进程早就把那几个模块 require 过了，
 * 所以只能另起进程。以前 test/tenant.js 就因为没人调，写完就没再跑过——
 * 一个没人跑的测试比没有测试更糟，它让人以为那块是有人看着的。
 */
async function testNodeSuite(file, label) {
  const { status, out, tail } = runChild(process.execPath, [path.join(__dirname, file)], {
    label, timeout: 300000,
  });
  if (status !== 0) throw new Error(`${label}未通过：\n${tail()}`);
  const line = out.split("\n").find((l) => l.startsWith("全部通过："));
  if (!line) throw new Error(`${label}没有报告结果：\n${tail()}`);
  console.log(`✅ ${label}：${line.replace("全部通过：", "").trim()}`);
}

async function testAdminConsoleUI() {
  let electronBin;
  try { electronBin = require("electron"); } catch { }
  if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
    console.log("⏭️  企业管理后台：未安装 electron，跳过");
    return;
  }
  const { status, out, tail } = runChild(electronBin, [path.join(__dirname, "admin-ui.js")], {
    label: "企业管理后台测试",
    timeout: 240000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  if (status !== 0) throw new Error("企业管理后台测试未通过：\n" + tail(12));
  const line = out.split("\n").find((l) => l.startsWith("✅ 企业管理后台"));
  if (!line) throw new Error("企业后台测试没有报告结果：\n" + tail(12));
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

  // #101 最小化之后点 Dock 图标要能回到主界面。macOS 上关窗/最小化都不退进程，点 Dock 只发一个
  // activate 事件；没人接这个事件，界面就再也叫不出来。用户原话：「我点 docker 里面的图标不会看到界面，
  // 要点宠物才能看到完整界面」。这里不验正则，直接把回调抠出来喂假窗口跑一遍。
  const iAct = main.indexOf('app.on("activate"');
  assert.ok(iAct > 0, 'electron-main.js 没接 app.on("activate")：最小化后点 Dock 图标什么都不会发生');
  const actBody = main.slice(main.indexOf("{", main.indexOf("=>", iAct)) + 1, main.indexOf("\n});", iAct));
  const activate = new Function("win", actBody);
  const calls = [];
  const fakeWin = (over) => ({
    isDestroyed: () => false, isMinimized: () => true,
    restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus"),
    ...over,
  });
  activate(fakeWin());
  assert.deepStrictEqual(calls, ["restore", "show", "focus"], "点 Dock 图标：最小化了先还原、再 show、再 focus —— 少一步窗口就还藏在后面");
  calls.length = 0;
  activate(fakeWin({ isMinimized: () => false }));
  assert.deepStrictEqual(calls, ["show", "focus"], "没最小化时不该多叫一次 restore");
  calls.length = 0;
  activate(null);
  activate(fakeWin({ isDestroyed: () => true }));
  assert.strictEqual(calls.length, 0, "窗口还没建出来 / 已经销毁时 activate 不许动手，不然是对着销毁的窗口调方法直接抛");

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

  // 命令行的 --perm / :perm 也能换档，而且**只换这一趟**。
  //
  // 原来这四档只有网页点得到，命令行想换档只能去改 config.json——而 config.json 是长期设置：
  // 为了让一条 cron 跑全自动，人得先把文件改成 full、跑完再改回来，忘了改回来就是明天所有
  // 交互式的活儿也不问人了，而他根本不记得自己动过这个开关。所以这里钉两件事：
  //   ① 覆盖之后闸门真的按新档判（不是只把状态行那行字改了）；
  //   ② 原来那份配置一个字节都没被写回去。
  {
    const cliSrc = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
    assert(/if \(opts\.perm\)/.test(cliSrc), "cli.js 里没有 --perm 的落地：参数表上有这个选项、真跑起来却不认");
    assert(!/writeJson\w*\([^)]*CONFIG_PATH[^)]*permission_mode/.test(cliSrc), "cli.js 把 --perm 回写进 config.json 了：这就成了长期设置，跟 -C 的规矩不一致");
    // 这四行就是 cli.js 里那段覆盖，原样搬过来
    const cfg = { security: { gateway: true, delete_protect: true, permission_mode: "auto" } };
    const snapshot = JSON.stringify(cfg.security);
    const applyPerm = (perm) => { cfg.security = { ...(cfg.security || {}), permission_mode: perm }; };
    assert.strictEqual(security.checkWrite(security.getSecurity(cfg), "a.md").action, "allow");
    applyPerm("plan");
    assert.strictEqual(security.permissionMode(cfg.security), "plan");
    assert.strictEqual(security.checkWrite(security.getSecurity(cfg), "a.md").action, "deny", "--perm plan 没真的关掉写文件");
    assert.strictEqual(security.checkCommand(security.getSecurity(cfg), "ls").action, "deny", "--perm plan 没真的关掉跑命令");
    applyPerm("ask");
    assert.strictEqual(security.checkWrite(security.getSecurity(cfg), "a.md").action, "ask", "--perm ask 没真的开始问");
    // 覆盖只动 permission_mode，别的字段（黑名单、删除保护、运行时开关）必须原样留着——
    // 一个「换档顺手把删除保护也抹了」的实现，比不能换档危险得多
    const after = JSON.parse(JSON.stringify(cfg.security));
    const before = JSON.parse(snapshot);
    for (const k of Object.keys(before)) {
      if (k === "permission_mode") continue;
      assert.deepStrictEqual(after[k], before[k], `--perm 把 security.${k} 也改了`);
    }
  }

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
/**
 * 「哪些事件入账」这张名单，服务端和前端必须一字不差。
 *
 * 它不是装饰：断流重连时，前端拿自己数出来的 `from` 去问服务端要后半截。
 * 两边名单一旦分家，计数就差一格——用户看到的是重连之后少一条工具调用、
 * 或者同一段正文重复一遍。而这种错只在「网断了一下」的时候才现形，
 * 平时跑一百遍测试都碰不到，所以只能靠这一条钉死。
 *
 * 本轮加 context 事件时两边都改了；下次谁只改一边，这儿当场拦下来。
 */
function testEventLedgerParity() {
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const web = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-02.js"), "utf8");
  const pick = (src, re, who) => {
    const m = src.match(re);
    assert(m, who + " 里找不到事件入账名单（改名/挪走了？断流续传的计数就没人对得上了）");
    return m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  };
  const a = pick(srv, /"tool_use", "tool_result",([\s\S]*?)\]\.includes\(ev\.type\)/, "server.js");
  const b = pick(web, /const KEEP = \["tool_use", "tool_result",([\s\S]*?)\];/, "app-02.js");
  assert.deepStrictEqual(a, b, "服务端和前端的事件入账名单对不上：断流重连会数错格（多/少的是 "
    + JSON.stringify([...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))]) + "）");
  assert(a.includes("context"), "context 事件没进名单：网页上那根上下文余量条重连之后就不动了");
}

function testEvolveLoop() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-evolve-"));
  const script = `
    const assert = require("assert");
    const fs = require("fs");
    const path = require("path");
    const ev = require(${JSON.stringify(path.join(__dirname, "..", "evolve.js"))});
    const DATA = process.env.OPENWORKBUDDY_DATA_DIR;
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
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: path.join(dir, "data") },
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
    const SESS = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "sessions");
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
    fs.mkdirSync(path.join(process.env.OPENWORKBUDDY_DATA_DIR, "learned"), { recursive: true });
    const [p] = ev.addProposals([{
      kind: "add_rule", signal: "zsh_glob", rule: "通配符路径一律加引号，别指望 shell 帮你展开。",
      verify: "zsh_glob 出现率降到 0.1 以下",
      baseline: { key: "zsh_glob", rate: 0.5, count: 5, turns: 10, at: iso(born) },
    }]);
    ev.decideProposal(p.id, "accept", { by: "测试" });
    const r0 = ev.activeRules()[0];
    // 规则的出生时间要盖回 2 天前，才谈得上"生效之后这 2 天"
    const rf = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "learned", r0.id + ".md");
    fs.writeFileSync(rf, fs.readFileSync(rf, "utf8").replace(r0.meta.at, iso(born)));

    const sc = ev.scoreRules({ minTurns: 1, now: NOW }).find(x => x.signal === "zsh_glob");
    assert.ok(sc, "没给这条规则打出分来：" + JSON.stringify(ev.scoreRules({ minTurns: 1, now: NOW })));
    // 生效后这 2 天里只有 FRESH 那一轮带时间，而它正是 zsh_glob —— 所以判"没起作用"是对的。
    // 真正要守的是分母：40 天前那轮（在规则出生**之前**）绝不能被算进这 2 天里。
    assert.strictEqual(sc.turns, 1, "打分的分母把规则生效前的回合算了进来：" + sc.turns);
    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: path.join(dir, "data") },
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
 * 自进化的提示词预算：规则能不能真的到模型手里。
 *
 * 前面两个测试守的是「该不该加这条规则」，这个守的是**加进来之后还在不在**。
 * 这段路上有三个坑，共同点都是**悄无声息**：
 *
 *  1. 12 条 × 400 字 = 4800 > 4000 的总预算。也就是说条数还没满，字数先满了——
 *     超预算是常态而不是意外。而注入那一段原来是从头往下填到撑为止，activeRules()
 *     又按生效时间**正序**排，于是被砍掉的永远是**最新那几条**：人刚在评审页点了
 *     「采纳」、界面写着「已生效」，模型一个字都没收到，还不吭声。越新越容易被吞。
 *  2. 基线为 0 的规则（生效前目标信号在带时间的回合里一次没出现）算降幅会得 0，
 *     被判「没起作用」并建议下架——量不出来和没用是两回事，这等于专杀新规则。
 *  3. 打分算出来的下架建议原来只写进 runReview 的返回值 notes 里，而页面读的
 *     /api/evolve/state 根本没有 notes——看完即焚，等于每天算一遍给空气听。
 */
function testEvolvePromptBudget() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-evbudget-"));
  const script = `
    const assert = require("assert");
    const fs = require("fs");
    const path = require("path");
    const ev = require(${JSON.stringify(path.join(__dirname, "..", "evolve.js"))});
    const DATA = process.env.OPENWORKBUDDY_DATA_DIR;
    const SESS = path.join(DATA, "sessions");
    const RULES = path.join(DATA, "learned");
    fs.mkdirSync(SESS, { recursive: true });
    fs.mkdirSync(RULES, { recursive: true });

    // 规则是一条一个 .md，头上一段 JSON 注释是元信息 —— 直接照这个形状铺，
    // 才测得到「手改过的规则文件」这条路（那正是 promptBlock 截断唯一还会被走到的路）
    const putRule = (id, text, meta = {}) =>
      fs.writeFileSync(path.join(RULES, id + ".md"),
        "<!-- " + JSON.stringify({ at: meta.at || new Date().toISOString(), ...meta }) + " -->\\n" + text + "\\n");

    // ── ① 撑爆预算时，砍的必须是最老的，而且要点名 ────────────────────
    const N = 12;
    for (let i = 1; i <= N; i++) {
      const id = "rule_" + String(i).padStart(2, "0");
      // 每条 390 字，12 条 4680 字 —— 条数正好卡在上限 12 而字数早就超了 4000。
      // 这不是构造出来的极端值，是 CAPS 自己算出来的常态
      putRule(id, "第" + i + "条：" + "凑".repeat(383), { at: new Date(Date.UTC(2026, 0, i)).toISOString() });
    }
    assert.strictEqual(ev.activeRules().length, N);
    const block = ev.promptBlock();
    assert.ok(block.length <= ev.CAPS.blockChars,
      "注入的那段自己就超了预算 " + block.length + " > " + ev.CAPS.blockChars);
    assert.ok(block.includes("第12条"), "最新的规则被砍掉了 —— 人刚点完采纳，模型一个字没收到");
    assert.ok(!block.includes("第1条："), "最老的规则没被砍，说明还是从头填到撑为止");
    // 点名：砍了谁得说出来，不然人只会觉得「这套东西没用」
    assert.ok(/另有 \\d+ 条最老的规则超出提示词预算没放进来/.test(block), "砍了规则却一声不吭：" + block.slice(-200));
    assert.ok(block.includes("rule_01"), "砍掉的规则没点名");
    // 标题里的条数得是**真放进去**的条数，不能报 activeRules() 的总数
    const kept = (block.match(/^- /gm) || []).length;
    assert.ok(/自进化规则，(\\d+) 条/.exec(block)[1] === String(kept),
      "标题报的条数和正文对不上：标题 " + /自进化规则，(\\d+) 条/.exec(block)[1] + "、正文 " + kept);
    assert.ok(kept < N && kept > 0, "要么一条没砍要么全砍了：" + kept);
    // 头部那段说明文字也占预算。不把它算进去的话，这儿正好会溢出
    assert.ok(block.indexOf("- 第") > 40, "正文前面那段说明没了");

    // ── ② 超预算的提案要在闸门就拦住，不能留给注入时去截 ──────────────
    const sigs = [{ key: "edit_anchor_miss", label: "改文件没对上锚点", actionable: "prompt", count: 9, rate: 0.5, kind: "edit_anchor_miss", sessions: 3 }];
    const mk = (extra = {}) => ({ kind: "add_rule", signal: "edit_anchor_miss", rule: "改文件前先 read_file 把要替换的那几行原样读出来。", verify: "edit_anchor_miss 降到 0.2 以下", ...extra });
    // 先把条数让开（12 条会先撞条数上限），只留 11 条去撞字数
    fs.unlinkSync(path.join(RULES, "rule_12.md"));
    assert.strictEqual(ev.activeRules().length, 11);
    const over = ev.gateProposal(mk(), { signals: sigs }) || "";
    assert.ok(over.includes("超出提示词预算"), "字数已经撑爆了还放行新规则：" + JSON.stringify(over));
    assert.ok(over.includes("指名下架一条"), "拦了却没告诉人下一步怎么办：" + over);
    // 指名换下一条：腾出来的位置必须算数。换下 390 字、想加 360 字 —— 还是不够，
    // 但话得说清楚是「已经把腾出来的算进去了还不够」，不然人只会觉得闸门没认他那条 retire
    const withRetire = ev.gateProposal(mk({ retire: "rule_01", rule: "先读后改：" + "凑".repeat(355) }), { signals: sigs }) || "";
    assert.ok(withRetire.includes("已经算上换下那条腾出的位置"), "换下的那条没被算进去：" + withRetire);
    // 腾够了就该放行 —— 拦的是「越堆越长」，不是「不许改」
    for (const id of ["rule_02", "rule_03", "rule_04", "rule_05", "rule_06", "rule_07", "rule_08", "rule_09"]) fs.unlinkSync(path.join(RULES, id + ".md"));
    assert.strictEqual(ev.gateProposal(mk({ retire: "rule_01" }), { signals: sigs }), null, "腾够了地方还是不让加");

    // ── ③ 基线是 0：量不出来 ≠ 没用，不许顺手建议下架 ──────────────────
    for (const f of fs.readdirSync(RULES)) if (f.endsWith(".md")) fs.unlinkSync(path.join(RULES, f));
    const bornAt = new Date(Date.now() - 3 * 86400e3).toISOString();
    putRule("rule_zero", "交付前必须 read_file 读回来核对。", { at: bornAt, baseline: { key: "edit_anchor_miss", rate: 0, count: 0, turns: 30, at: bornAt, caliber: "dated" } });
    const at = new Date(Date.now() - 86400e3).toISOString();
    const err = (name, preview) => ({ type: "tool_result", name, isError: true, preview });
    const turns = [];
    for (let i = 0; i < 24; i++) turns.push({ type: "user", text: "改一下", at }, { type: "assistant", events: i < 6 ? [err("edit_file", "没找到 old_text")] : [], at });
    fs.writeFileSync(path.join(SESS, "z.json"), JSON.stringify({ updated_at: at, transcript: turns }));
    const z = ev.scoreRules().find((x) => x.id === "rule_zero");
    assert.strictEqual(z.verdict, "无从判断", "基线是 0 却硬算降幅：" + JSON.stringify(z));
    assert.ok(!z.suggestRetire, "量不出来就被建议下架了：" + JSON.stringify(z));
    assert.ok(z.why.includes("基线 0"), "没说清为什么判不了：" + z.why);

    // ── ④ 打分说「没起作用」，必须落成一条真提案进评审队列 ──────────────
    fs.unlinkSync(path.join(RULES, "rule_zero.md"));
    putRule("rule_dead", "回复先给结论再给过程。", { at: bornAt, baseline: { key: "edit_anchor_miss", rate: 0.1, count: 3, turns: 30, at: bornAt, caliber: "dated" } });
    const d = ev.scoreRules().find((x) => x.id === "rule_dead");
    assert.strictEqual(d.verdict, "没起作用", "0.1 → 0.25 还判有效：" + JSON.stringify(d));
    assert.strictEqual(d.suggestRetire, true);

    // 模型这一轮一条提案都没提：下架提案不该依赖模型，它是算出来的
    const llm = { chat: async () => ({ text: '{"proposals":[],"notes":[]}' }) };
    const r1 = await ev.runReview({ llm });
    const q = () => ev.listProposals().filter((p) => p.kind === "retire_rule" && p.target === "rule_dead");
    assert.strictEqual(q().length, 1, "打分说该下架，评审队列里却没有这条提案（以前只写进看完即焚的 notes）：" + JSON.stringify(ev.listProposals()));
    assert.strictEqual(q()[0].status, "pending", "自动下架提案没等人点头就生效了");
    assert.ok(q()[0].auto, "没标出这条是算出来的、不是模型想的");
    assert.ok(q()[0].why.includes("0.1"), "提案里没带上判它的那两个数字：" + q()[0].why);
    assert.ok(r1.added.some((p) => p.kind === "retire_rule"), "runReview 的返回值里没带上这条");

    // 第二天再跑：同一条不许再提一遍，不然队列里很快堆成一屏一模一样的东西
    await ev.runReview({ llm });
    assert.strictEqual(q().length, 1, "同一条规则被重复提了 " + q().length + " 次下架");

    // 人驳回之后更不许再提 —— 加规则那条路上驳回理由会当负样本喂回模型，
    // 下架这条路上没有模型可喂，不自己记着就是每天原样再端一遍
    ev.decideProposal(q()[0].id, "reject", { by: "测试", reason: "这条我还想再看看" });
    await ev.runReview({ llm });
    assert.strictEqual(q().length, 1, "人驳回过的下架提案又被提了一遍");
    assert.strictEqual(q()[0].status, "rejected");

    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", "(async()=>{" + script + "})().catch(e=>{console.error(e);process.exit(1)})"], {
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: path.join(dir, "data") },
    encoding: "utf8",
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "自进化提示词预算测试失败：\n" + (r.stderr || r.stdout));
  console.log("✅ 自进化预算：撑爆时砍最老的并点名（不是把刚采纳的那条悄悄吞掉）· 超预算在闸门就拦住并指路 · 基线 0 判「无从判断」不顺手下架 · 下架建议落成真提案且不重复提、驳回过的不再提");
}
/**
 * 系统提示词的漂移闸门。
 *
 * 这份提示词一万一千多字，每一步都随请求发出去一遍 —— 它烂掉的方式全是**静悄悄**的：
 *
 *  · 工具改了名 / 删了，提示词里那行还在。模型照着调一个不存在的工具，吃一条报错，
 *    再重想一遍，白烧一轮；而 evolve 的闸门会明确判这类是「代码问题，加提示词治不了」——
 *    也就是说这种错连自进化都救不回来，只能在这儿钉住。
 *  · 同一条规矩在两处各写一遍，然后只改了一处。两处打架的时候模型听谁的没人知道，
 *    而且两边都"看起来对"，评审时根本发现不了。（真出过：基础规范说「只有两类情况才准问」，
 *    Craft 模式又列了第三、第四类，默认就是 Craft。）
 *  · 谁顺手往里加一段，加着加着这东西自己就翻倍了 —— 提示词只许越用越准，不许越堆越长。
 *
 * 提示词是 createAgentRuntime 里的闭包，起不了进程外调用，所以这里直接钉源码：
 * 测的是发布出去的那份字符串，不是抄一份到测试里的复制品。
 */
function testAgentPromptDrift() {
  const src = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
  const { TOOL_DEFS } = require(path.join(__dirname, "..", "tools.js"));
  const pkg = require(path.join(__dirname, "..", "package.json"));

  const cut = (from, to, what) => {
    const a = src.indexOf(from), b = src.indexOf(to);
    assert.ok(a > 0 && b > a, "在 agent.js 里找不到" + what + "（提示词被挪走了？闸门也就形同虚设了）");
    return src.slice(a, b);
  };
  const base = cut("你是 ${myName}，一个 AI 办公智能体", "if (config.persona)", "基础系统提示词");
  const craft = cut("## 当前模式：Craft（执行）", "async function runToolCall", "Craft 模式提示词");
  const whole = base + craft;

  // ── ① 提示词里点名的工具，必须真的存在 ───────────────────────────────
  // agent.js 自己接住的那几个不在 TOOL_DEFS 里，但确实是工具
  const LOCAL = ["use_skill", "ask_user", "delegate_to_expert", "delegate_to_team",
    "feishu_doc_create", "notify_user", "schedule_task", "list_schedules", "send_email"];
  const real = new Set(TOOL_DEFS.map((t) => t.name).concat(LOCAL));
  // 长得像工具名、其实是参数名/配置键/例子文件名的，列在这儿。名单短是好事：
  // 短到一眼能看完，才说明"下划线命名 = 工具名"这个判据还成立
  const NOT_TOOLS = new Set(["old_text", "new_text", "start_line", "end_line", "with_timestamps",
    "allow_shell", "app_id", "doc_app_id", "dingtalk_webhook", "wecom_bot_webhook", "voice_01", "voice_02"]);
  const named = [...new Set(whole.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [])];
  assert.ok(named.length >= 30, "提示词里的工具名抓取异常，只抓到 " + named.length + " 个");
  const ghost = named.filter((n) => !real.has(n) && !NOT_TOOLS.has(n));
  assert.ok(!ghost.length,
    "提示词点名了这些不存在的工具（多半是工具改名/删除时忘了改提示词，模型会照着调、吃报错、重试）：" + JSON.stringify(ghost));
  // 反向对照：闸门不许是恒真的
  assert.strictEqual([...named, "directory_tree"].filter((n) => !real.has(n) && !NOT_TOOLS.has(n)).length, 1,
    "幽灵工具闸门对凭空多出来的工具名不敏感");

  // ── ② 「当前没有内置浏览器」那句话，点的名必须和真被摘掉的工具一一对上 ──
  // 这句话是负向承诺（"这几个你没有"）。它比正向清单更容易出事：正向的说错了，
  // 模型调一下就知道；负向的说错了，模型**根本不会去试**，一个本来能用的工具就此消失
  const m = /const DESKTOP_ONLY_TOOLS = (\[[^\]]*\])/.exec(src);
  assert.ok(m, "找不到 DESKTOP_ONLY_TOOLS 这个常量");
  const desktopOnly = JSON.parse(m[1].replace(/'/g, '"'));
  // 只取「：…都不可用」中间那一截 —— 这句话后半段还会提替代方案（"要出图表用 gen_diagram"），
  // 整句一起看的话，替代方案会被当成"不可用清单"里的一员
  const claim = /\*\*当前没有内置浏览器\*\*[^\n：]*：([^\n]*?)都不可用/.exec(base);
  assert.ok(claim, "提示词里「当前没有内置浏览器 … 都不可用」那句话没了：纯命令行模式下模型会一直去调调不通的工具");
  const zh = { desktop_pet: "桌面宠物" }; // 这句话里有一个是用中文说的
  for (const n of desktopOnly)
    assert.ok(claim[1].includes(zh[n] || n),
      `DESKTOP_ONLY_TOOLS 里有 ${n}，没 GUI 时它会被摘掉，提示词那句话却没点它的名 —— 模型会调一个已经不在清单里的工具`);
  // 反过来：那句话里不许点到其实一直都在的工具
  for (const n of named.filter((x) => claim[1].includes(x) && real.has(x)))
    assert.ok(desktopOnly.includes(n),
      `提示词说没 GUI 时 ${n} 不可用，但它不在 DESKTOP_ONLY_TOOLS 里、其实一直都在 —— 等于白白关掉了一个能用的工具`);
  // 同一件事在 5.1 还说了一遍（"别去找 render_page，它不在你的工具清单里"），那句也得跟着对
  assert.ok(!/别去找 (\w+)，它不在你的工具清单里/.test(base) ||
    desktopOnly.includes(/别去找 (\w+)，它不在你的工具清单里/.exec(base)[1]),
    "规范 5.1 说某个工具「不在你的工具清单里」，但它并不在 DESKTOP_ONLY_TOOLS 里");

  // ── ③ 承诺"已安装"的库，必须真的装了 ──────────────────────────────
  const libLine = /已安装库：([^\n]*)/.exec(base);
  assert.ok(libLine, "工具能力里「已安装库」那行没了");
  const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
  const libs = [...libLine[1].matchAll(/([a-z][a-z0-9-]+)\(/g)].map((x) => x[1]);
  assert.ok(libs.length >= 3, "「已安装库」那行解析异常：" + libLine[1]);
  for (const l of libs)
    assert.ok(deps[l], `提示词说 ${l} 已安装，package.json 里却没有 —— 模型会 require 一个装不上的包，然后在死路上重试`);

  // ── ④ 「什么时候才准问」只许有一份 ────────────────────────────────
  // 两处各写一份、只改了一处，是这份提示词最贵的烂法：两边都读起来对，谁也发现不了
  assert.ok(base.includes("该问的只有这三类"), "基础规范 1 里那份「该问的只有这三类」没了");
  assert.strictEqual((whole.match(/该问的只有这三类/g) || []).length, 1, "「该问的只有这三类」出现了不止一次");
  assert.ok(/规范 1/.test(craft), "Craft 模式没指回规范 1，多半是又把触发清单抄了一份过去");
  assert.ok(!/开工前：|执行中：/.test(craft),
    "Craft 模式又自己列了一份「什么时候该问」的清单 —— 和规范 1 那份迟早打架，把触发条件收回规范 1 里去");

  // ── ⑤ 规模闸：提示词只许越用越准，不许越堆越长 ──────────────────────
  // 每一步都要发一遍，一万一千多字 ≈ 六千多 token；这还没算工具定义、技能表、记忆和自进化规则。
  // 上限给的是当前长度 +10%：正常的增删改动不会撞它，谁想整段整段往里塞，得先在这儿说明白为什么
  const CAP = 13000;
  assert.ok(base.length <= CAP,
    `基础系统提示词 ${base.length} 字，超过 ${CAP} 字的上限。这东西每一步都发一遍：先看看能不能把某一节收短、或者改成按条件才挂上去，真该加再抬这个数并在这儿写清为什么`);
  assert.ok(base.length >= 8000, "基础系统提示词只剩 " + base.length + " 字，是不是被整段删掉了？");

  console.log(`✅ 提示词闸门：${named.length} 个点名的工具全对得上 · 「没内置浏览器」那句和 DESKTOP_ONLY_TOOLS 一一对上 · ${libs.length} 个承诺已装的库真在 package.json · 「该问的三类」全文只有一份且 Craft 指回它 · 正文 ${base.length}/${CAP} 字`);
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
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: path.join(dir, "data") },
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
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: path.join(dir, "data") },
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
    const SESS = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "sessions");
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
    fs.mkdirSync(path.join(process.env.OPENWORKBUDDY_DATA_DIR, "learned"), { recursive: true });
    const [p] = ev.addProposals([{
      kind: "add_rule", signal: "zsh_glob", rule: "通配符路径一律加引号。", verify: "zsh_glob 降到 0",
      baseline: { key: "zsh_glob", rate: 0.5, count: 5, turns: 10, at: iso(BORN), caliber: "dated" },
    }]);
    ev.decideProposal(p.id, "accept", { by: "测试" });
    const r0 = ev.activeRules()[0];
    const rf = path.join(process.env.OPENWORKBUDDY_DATA_DIR, "learned", r0.id + ".md");
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
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, OPENWORKBUDDY_DATA_DIR: path.join(dir, "data") }, encoding: "utf8" });
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

    // 超量：丢东西必须在回执里说出来（闷声吞就等于用户以为记住了其实没有）；
    // 全都没用过时，退化成老行为「最旧的先走」
    let last;
    for (let i = 0; i < mem.MAX_PER_SCOPE + 3; i++) last = mem.add({ text: "第 " + i + " 条偏好", user: "丙" });
    assert.ok(last.dropped > 0, "超量了却没丢也没说");
    assert.ok(/丢弃/.test(last.note) && /用过几次/.test(last.note), last.note);
    assert.strictEqual(mem.list().filter((x) => x.scope === "丙").length, mem.MAX_PER_SCOPE, "超量后条数不对");
    assert.strictEqual(mem.list("丙").some((x) => x.text === "第 0 条偏好"), false, "谁都没用过时该丢最旧的，那条却还在");

    // 淘汰按价值不按先后：一条用了四十次的老偏好，不该被昨天记下、一次没派上用场的新条目挤掉。
    // 这是老写法真会犯的错——「旧」和「没用」是两回事，按错的那个丢，越用越难用。
    {
      const older = new Date(Date.now() - 40 * 864e5).toISOString();
      const newer = new Date(Date.now() - 1 * 864e5).toISOString();
      const ks = mem._internals.keepScore;
      const 老而有用 = { created_at: older, last_used: new Date().toISOString(), hits: 40, source: "agent" };
      const 新而没用 = { created_at: newer, source: "agent" };
      assert.ok(ks(老而有用) > ks(新而没用), "淘汰打分把「用了四十次的老偏好」排在了「一次没用过的新条目」前面");
      // 反向对照：两条都没人用过时，旧的确实该先走（别把老行为改坏了）
      assert.ok(ks({ created_at: newer, source: "agent" }) > ks({ created_at: older, source: "agent" }), "都没用过时旧的没有先走");
      // 用户亲手写的不该被 agent 自己记的挤掉，哪怕它更老、也没被召回过
      assert.ok(ks({ created_at: older, source: "user" }) > ks({ created_at: newer, hits: 3, source: "agent" }), "用户手写的被 agent 记的挤掉了");
    }

    // 命中回写：真进过提示词的条目要记一笔，而且是合并写盘（不是每轮任务写一次）
    {
      const { noteUsed } = mem._internals;
      const mine = mem.list("丙");
      const target = mine[mine.length - 1];
      noteUsed([target.id, target.id, target.id]);
      assert.strictEqual((mem.list("丙").find((x) => x.id === target.id) || {}).hits, undefined, "命中还没到窗口就写盘了（该攒着合并）");
      assert.ok(mem.flushHits() >= 1, "冲一次却一条都没落盘");
      const after = mem.list("丙").find((x) => x.id === target.id);
      assert.strictEqual(after.hits, 3, "三次命中没并成 3：" + after.hits);
      assert.ok(after.last_used, "命中了却没记最近用于哪天");
      // 反向对照：没有待写的命中时，冲一次应该什么都不做（别为了空转多写一次盘）
      assert.strictEqual(mem.flushHits(), 0, "没东西可写时还是写了一次盘");
    }

    // 同一段提示词里两条说的是一件事：只留新的那条。留着的代价是模型随机挑一条听，
    // 用户那边的感受是「我明明改过了，它有时候听有时候不听」——最难查的那种不听话。
    {
      const { dedupeForPrompt } = mem._internals;
      const a = { id: "a", scope: "戊", text: "周报开头不要写废话开场白", created_at: "2026-01-01T00:00:00Z" };
      const b = { id: "b", scope: "戊", text: "周报开头不要写开场白废话", created_at: "2026-02-01T00:00:00Z" };
      const c = { id: "c", scope: "戊", text: "所有交付物一律不加水印", created_at: "2026-01-15T00:00:00Z" };
      const r = dedupeForPrompt([a, b, c]);
      assert.strictEqual(r.kept.length, 2, "同义的两条没被压成一条：" + r.kept.map((x) => x.id).join(","));
      assert.ok(r.kept.some((x) => x.id === "b") && r.shadowed.some((x) => x.id === "a"), "留下的不是新的那条");
      assert.ok(r.kept.some((x) => x.id === "c"), "把不相干的那条也一起吃掉了");
      // 反向对照一：共享区和个人区撞车是「组里的规矩 vs 我自己的偏好」，不许在这儿悄悄吃掉一边
      const shared = { id: "s", scope: "*", text: "周报开头不要写开场白废话", created_at: "2026-03-01T00:00:00Z" };
      assert.strictEqual(dedupeForPrompt([a, shared]).kept.length, 2, "跨作用域的同义条目被吃掉了");
      // 反向对照二：只是沾点边的两条不许被当成同一件事
      const d = { id: "d", scope: "戊", text: "周报要发给直属领导抄送 HR", created_at: "2026-04-01T00:00:00Z" };
      assert.strictEqual(dedupeForPrompt([b, d]).kept.length, 2, "只是都提到「周报」就被当成同一件事了");
    }

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
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: dir },
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
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, OPENWORKBUDDY_DATA_DIR: path.join(dir, "data") }, encoding: "utf8" });
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
    const old = process.env.OPENWORKBUDDY_TRUST_PROXY;
    if (n === null) delete process.env.OPENWORKBUDDY_TRUST_PROXY; else process.env.OPENWORKBUDDY_TRUST_PROXY = String(n);
    try { return fn(); } finally { if (old === undefined) delete process.env.OPENWORKBUDDY_TRUST_PROXY; else process.env.OPENWORKBUDDY_TRUST_PROXY = old; }
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
 * 账本落在 data/ 下，所以整段丢进子进程跑，OPENWORKBUDDY_DATA_DIR 指到临时目录——测试绝不能碰真账号。
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
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: dir },
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
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: dir },
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
 * 同样丢子进程里跑，OPENWORKBUDDY_DATA_DIR 指到临时目录，不碰真账号。
 */
function testRenameLogin() {
  const { spawnSync } = require("child_process");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rename-"));
  const script = `
    const assert = require("assert");
    const acc = require(${JSON.stringify(path.join(__dirname, "..", "account.js"))});
    const orgs = require(${JSON.stringify(path.join(__dirname, "..", "org.js"))});
    const { register, renameUser, loadUsers, saveUsers, loadUsage, saveUsage, issueToken } = acc._internals;
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

    // 充值记录里的 by（谁充的）也是个登录名，一样得搬。
    // 走 saveUsage 而不是直接写文件：账本已经是按月分片的 jsonl，
    // 往 usage.json 里写等于写进一个没人再读的老文件，测试会白跑一场还显示通过
    const usage = loadUsage();
    usage.unshift({ ts: new Date().toISOString(), day: new Date().toISOString().slice(0, 10), kind: "topup", user: "别人", by: "新名字", credits: 5 });
    saveUsage(usage);
    renameUser("新名字", "更新的名字");
    assert.strictEqual(loadUsage()[0].by, "更新的名字", "充值记录里的「谁充的」没搬");
    assert.strictEqual(names()[0], "更新的名字", "第二次改名没生效");
    console.log("OK");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, OPENWORKBUDDY_DATA_DIR: dir },
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

  // ①' 开机那一下必须把盘上那份**整个**交给 pet.js，不许手抄字段清单。
  //     真事：electron-main.js 里抄了五个字段，漏了 sprite。于是选了精灵图宠物的人每次重开
  //     都变回内置那只猫——character 是 "sprite"、sprite 却是空的，findPet 找不着，
  //     create() 最后那行就静静落回 "cat"，一声不吭。
  //     用户原话：「这个宠物我之前换了的，然后重新打开又是默认的猫猫宠物了」。
  //     这条钉的是写法而不是结果：真正的失败只在 Electron 里才看得见，而这套测试跑的是纯 node。
  //     手抄清单这种写法的毛病是「加字段的人不会想到回来改它」，所以直接禁掉这种写法。
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "electron-main.js"), "utf8");
    const call = src.slice(src.indexOf("const petCfg = require(dataPath(\"config.json\")).pet"));
    assert.ok(call, "electron-main.js 里那段开机读宠物配置的代码不见了（挪了位置就把这条锚点一起改掉）");
    const boot = call.slice(0, call.indexOf("\n  } catch"));
    assert.ok(/pet\.applyConfig\(\s*\{\s*\.\.\.petCfg/.test(boot),
      "开机必须把 petCfg 整个摊给 applyConfig（写成 {...petCfg, ...}），不许再一个字段一个字段地抄");
    for (const k of ["sprite", "notifyDone", "wander", "character"]) {
      assert.ok(!new RegExp(`petCfg\\.${k}`).test(boot),
        `开机那行又开始单独点名 petCfg.${k} 了——这正是当年漏掉 sprite 的写法，整个摊过去就不会漏`);
    }
  }

  // ② 工具层：没有落地实现时如实报错
  const { executeTool } = require("../tools");
  const saved = global.__openworkbuddyPetTool;
  delete global.__openworkbuddyPetTool;
  const noImpl = await executeTool("desktop_pet", { action: "status" }, {});
  assert(noImpl.isError, "没有实现时 desktop_pet 应该报错而不是假装成功");

  // ③ 参数原样转发给服务端实现（action / image / scale 一个都不能丢）
  let got = null;
  global.__openworkbuddyPetTool = { async run(input, baseDir) { got = { input, baseDir }; return { content: "ok", isError: false }; } };
  const ok = await executeTool("desktop_pet", { action: "create", image: "头像.png", scale: 1.2 }, { baseDir: "e2e-pet-dir" });
  assert(!ok.isError && got && got.input.action === "create" && got.input.image === "头像.png" && got.input.scale === 1.2, "desktop_pet 参数没原样转发: " + JSON.stringify(got));
  // 用户在某个对话里传的图落在该对话的成果子目录，实现要靠这个 baseDir 才找得到
  assert.strictEqual(got.baseDir, path.join(WORKSPACE, "e2e-pet-dir"), "desktop_pet 没把本次对话的成果目录传给实现");
  fs.rmSync(path.join(WORKSPACE, "e2e-pet-dir"), { recursive: true, force: true });
  if (saved) global.__openworkbuddyPetTool = saved; else delete global.__openworkbuddyPetTool;

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
/**
 * 连接器的开关，和「这一刻模型手上有哪些工具」那张表。
 *
 * 由来是用户对着别家产品的 ＋ 菜单说的两句：「我这里也有 ＋ 能看到各种工具啥的啊，
 * 还有管理已经设置好的连接器这些啊」「这个连接器功能到底可用不可用呀？你要帮我测试好啊」。
 *
 * 这条测试盯的是「关掉」这个动作从头到尾都算数——四段各管一件事，缺一段都能让开关变成摆设：
 *   ① mcp.js：关掉的那台压根不去连，而且开着的时候被关掉，进程要真收掉；
 *   ② 权限：连接器是整台机器一份的，一个人关掉所有人少一批工具，所以开关归平台管理员；
 *   ③ 存盘 + 重启：关掉不是这一次运行里的事，重启之后还得是关着的；
 *   ④ 界面能分清「我自己关的」和「连不上」——这两件事在屏幕上长得一样就等于没做。
 */
async function testConnectorToggleAndTools() {
  const os = require("os");
  const http = require("http");
  const { McpManager, whyFailed } = require("../mcp");

  // ---- ① mcp.js 这一层：关掉 = 不去连，而且真收摊 ----
  {
    const mgr = new McpManager();
    const die = (code) => ({ command: process.execPath, args: ["-e", `process.exit(${code});`] });
    mgr.setDisabled(["关掉的"]);
    await mgr.startAll([
      { name: "关掉的", ...die(3) },
      { name: "开着的", ...die(4) },
    ]);
    const names = mgr.failures.map((f) => f.name);
    assert(!names.includes("关掉的"),
      "★关掉的那台还是去连了★ 界面上开关一点就回弹，而且白起一个进程：" + names.join("/"));
    assert(names.includes("开着的"), "反向对照：没关的那台该照常去连并记下失败，实际 failures=" + names.join("/"));

    // 「开着的时候被关掉」这一路：stop 必须发生在 continue 之前，否则进程成了孤儿——
    // 开关看着是关了，工具表里也摘掉了，可那个子进程还在后台占着句柄跑着。
    let stopped = false;
    mgr.clients.set("正跑着的", { stop() { stopped = true; }, tools: [] });
    mgr.setDisabled(["正跑着的"]);
    await mgr.startAll([{ name: "正跑着的", ...die(0) }]);
    assert(stopped, "★关掉一台正在跑的连接器，进程没被收掉★ 它会变成没人管的孤儿进程");
    assert(!mgr.clients.has("正跑着的"), "关掉之后它还挂在 clients 里，工具表里就还摘不干净");
    assert(mgr.toolDefs().length === 0, "关掉的连接器的工具还留在工具表里——模型会先想一个用它的方案、调一次、吃一条「连不上」、再重想，白烧一轮");
    mgr.stop([]);
  }

  // ---- 界面上那句「授权已过期」的判据，和 whyFailed 说的话得对得上 ----
  // server.js 里 auth_bad 是拿正则去认 whyFailed 翻出来的那句话的。两边任何一边改了措辞，
  // 红字就会不声不响地消失——变成一张跟「连不上」一模一样的灰卡片，用户不知道该去换 Key。
  const AUTH_BAD = /（401）|（403）|Key／令牌/;
  for (const n of [401, 403]) {
    const say = whyFailed(new Error(`MCP x.initialize HTTP ${n}：nope`), { url: "https://api.example.com/mcp" });
    assert(AUTH_BAD.test(say), `★${n} 不再被认成「授权没了」★ server.js 的 auth_bad 正则和 mcp.js 的措辞对不上了：` + say);
  }
  assert(!AUTH_BAD.test(whyFailed(new Error("MCP x.initialize HTTP 500：boom"), { url: "https://api.example.com/mcp" })),
    "反向对照：500 是对方自己崩了，不该被说成「授权过期」让用户白跑一趟去换 Key");
  assert(!AUTH_BAD.test(whyFailed(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }), { url: "https://api.example.com/mcp" })),
    "反向对照：连都没连上不该被说成「授权过期」");

  // ---- 起一台只会回 401 的假 MCP 端点：auth_bad 这条要跑真链路，不能只测正则 ----
  const deny = http.createServer((_q, r) => { r.writeHead(401, { "content-type": "text/plain" }); r.end("no token"); });
  await new Promise((r) => deny.listen(0, "127.0.0.1", r));
  const denyPort = deny.address().port;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mcp-toggle-"));
  const CFG = path.join(home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf8"));
  cfg.mcp_servers = [
    // 进程起来就死：最常见的「连不上」，一秒之内就有结果，不拖慢这条测试
    { name: "deadproc", transport: "stdio", command: process.execPath, args: ["-e", "process.exit(3);"] },
    // 远端回 401：界面上要显示成「授权已过期」，跟上面那台分得开
    { name: "expired", transport: "streamable-http", url: `http://127.0.0.1:${denyPort}/mcp` },
  ];
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));

  // 令牌只能用 [\w]+：account.js 的 tokenFromReq 拿这个字符类去 cookie 里抠，
  // 带连字符的令牌会在第一个 - 处被截断，整条测试挂在一片「未登录」上，看着像权限出了问题
  const crypto = require("crypto");
  const owner = "owner" + crypto.randomBytes(12).toString("hex");
  const member = "member" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [
      { username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() },
      { username: "xiaoli", salt: "x", hash: "x", role: "user", credits: 0, created_at: Date.now() },
    ],
    tokens: { [owner]: { user: "boss", at: Date.now() }, [member]: { user: "xiaoli", at: Date.now() } },
  }));

  const call = (port, method, p, body, token = owner) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      ...(token ? { Cookie: "openworkbuddy_token=" + token } : {}),
    } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json: j }); });
    });
    req.on("error", (e) => resolve({ code: 0, body: e.message }));
    if (data) req.write(data);
    req.end();
  });
  const byName = (j) => Object.fromEntries((((j && j.json) || {}).servers || []).map((s) => [s.name, s]));
  const diskOff = () => JSON.parse(fs.readFileSync(CFG, "utf8")).mcp_disabled || [];
  // 连接是 server 起来之后在后台跑的：进程那台一秒内就退了，回 401 那台还得走一发 HTTP。
  // 机器忙的时候（整套测试一起跑就是这样）那一发还在路上，卡片上就是一片空白——
  // 不等它落定直接断言，等于赌运气。所以点名的这几台都得先有结论（连上了，或留下了失败原因）。
  const settled = async (port, names, ms = 15000) => {
    const until = Date.now() + ms;
    let last = null;
    for (;;) {
      last = await call(port, "GET", "/api/mcp");
      const m = byName(last);
      if (names.every((n) => m[n] && (m[n].connected || m[n].error))) return last;
      if (Date.now() > until) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  let booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  try {
    const { up, port, why } = await booted.wait();
    assert(up, "真 server.js 没起来，这条测试作废：" + why);

    // ---- ② 一张卡片要说清四件事：开着没、连上没、为什么没连上、是不是授权的问题 ----
    const first = await settled(port, ["deadproc", "expired"]);
    assert(first.code === 200 && first.json, "连接器列表取不到（HTTP " + first.code + "）：" + first.body.slice(0, 200));
    const m0 = byName(first);
    assert(m0.deadproc && m0.expired, "配的两台没都列出来：" + Object.keys(m0).join("/"));
    assert(m0.deadproc.enabled === true && m0.expired.enabled === true, "没关过的连接器应当是开着的");
    assert(m0.deadproc.connected === false && m0.deadproc.error, "起不来的那台该留下失败原因：" + JSON.stringify(m0.deadproc).slice(0, 200));
    assert(m0.deadproc.auth_bad === false, "进程起不来不是授权问题，不该让用户去换 Key：" + m0.deadproc.error);
    assert(m0.expired.auth_bad === true,
      "★远端回 401，界面上没标成「授权已过期」★ 用户只会看到一张灰卡片，不知道该现在就去换 Key：" + m0.expired.error);
    assert(first.json.can_toggle === true, "平台管理员那边 can_toggle 该是 true，否则开关根本不画出来");

    // 成员看得见有哪些连接器（他的任务就靠这些工具），但开关不画给他——
    // 画一个点了必然 403 的开关，比不画更糟
    const asMember = await call(port, "GET", "/api/mcp", null, member);
    assert(asMember.code === 200 && asMember.json.can_toggle === false,
      "成员那边 can_toggle 该是 false：" + asMember.body.slice(0, 200));

    // ---- ③ 权限：连接器是整台机器一份的 ----
    const denied = await call(port, "POST", "/api/mcp/toggle", { name: "deadproc", enabled: false }, member);
    assert(denied.code === 403 && denied.json && denied.json.platform_only === true,
      "★成员也能关掉整台机器的连接器★（HTTP " + denied.code + "）：" + denied.body.slice(0, 200));
    assert(diskOff().length === 0, "★被拒的那一发还是写进 config.json 了★：" + JSON.stringify(diskOff()));

    // ---- ④ 关掉：存盘、摘工具、界面上跟「连不上」分得开 ----
    const off = await call(port, "POST", "/api/mcp/toggle", { name: "deadproc", enabled: false });
    assert(off.code === 200 && off.json.ok && off.json.enabled === false, "关不掉：" + off.body.slice(0, 200));
    assert.deepStrictEqual(diskOff(), ["deadproc"], "没落到 config.json 的 mcp_disabled 里：" + JSON.stringify(diskOff()));
    const m1 = byName(await call(port, "GET", "/api/mcp"));
    assert(m1.deadproc.enabled === false, "关完了列表里还说它开着");
    assert(m1.deadproc.error === "",
      "★关掉的连接器还挂着上一次的失败原因★ 屏幕上就成了「我自己关的」和「它连不上」一个长相：" + m1.deadproc.error);
    assert(m1.expired.enabled === true, "关一台把另一台也带下去了");

    // 认不出来的名字要当场说不行，别默默记一个不存在的名字进 config
    const ghost = await call(port, "POST", "/api/mcp/toggle", { name: "查无此连接器", enabled: false });
    assert(ghost.code === 400, "不存在的连接器名该被拒（HTTP " + ghost.code + "）：" + ghost.body.slice(0, 160));
    assert.deepStrictEqual(diskOff(), ["deadproc"], "被拒的名字混进 mcp_disabled 了：" + JSON.stringify(diskOff()));

    // ---- ⑤ 「这一刻模型手上有哪些工具」：摆出来的得是模型看见的那一份 ----
    const tl = await call(port, "GET", "/api/tools");
    assert(tl.code === 200 && tl.json && Array.isArray(tl.json.tools) && tl.json.tools.length > 0,
      "工具表是空的（HTTP " + tl.code + "）：" + tl.body.slice(0, 200));
    assert(tl.json.total === tl.json.tools.length, "报的总数和列出来的对不上：" + tl.json.total + " vs " + tl.json.tools.length);
    assert((tl.json.groups || []).some((g) => g.key === "builtin" && g.count > 0), "内置工具那一组没了：" + JSON.stringify(tl.json.groups));
    assert(tl.json.tools.every((t) => !/^\[MCP:/.test(t.description || "")),
      "描述前面那截 `[MCP:服务器] ` 是给模型认来源的，界面上有分组标题了，别重复一遍");
    assert(tl.json.tools.every((t) => !String(t.description || "").includes("\n")), "说明只该留第一行，多行会把菜单撑得老长");
    // 不许另抄一份清单：抄的那份迟早和 toolList 漂开（modes 那儿已经演过一遍三份手抄）。
    // 换个模式再要一次，条数必须跟着变——抄死的清单在这儿会原地不动。
    const ask = await call(port, "GET", "/api/tools?mode=ask");
    assert(ask.code === 200 && ask.json.mode === "ask", "换模式要不到：" + ask.body.slice(0, 160));
    assert(ask.json.total !== tl.json.total || ask.json.tools.length !== tl.json.tools.length
      || JSON.stringify(ask.json.tools.map((t) => t.name)) !== JSON.stringify(tl.json.tools.map((t) => t.name)),
      "换了模式工具表一个字没变——多半是另抄了一份死清单，而不是问的 runtime.toolList()");

    booted.child.kill();
  } finally {
    try { booted.child.kill(); } catch {}
  }

  // ---- ⑥ 重启：关掉不是「这一次运行里」的事 ----
  // 少了 main() 里那句 setDisabled，重启之后它会照常去连——用户下次打开发现自己关掉的又开着了。
  booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  try {
    const { up, port, why } = await booted.wait();
    assert(up, "第二次启动没起来：" + why);
    const m2 = byName(await settled(port, ["expired"]));
    assert(m2.deadproc.enabled === false, "★重启之后自己关掉的连接器又开着了★");
    assert(m2.deadproc.error === "" && m2.deadproc.connected === false,
      "★重启之后又去连了一次关掉的那台★（留下了失败记录）：" + m2.deadproc.error);
    assert(m2.expired.auth_bad === true, "反向对照：另一台照常连、照常报授权过期");

    // 再打开：开关是双向的，而且 config 里不许留下已经没意义的名字
    const on = await call(port, "POST", "/api/mcp/toggle", { name: "deadproc", enabled: true });
    assert(on.code === 200 && on.json.enabled === true, "打不开：" + on.body.slice(0, 200));
    assert.deepStrictEqual(diskOff(), [], "打开之后 mcp_disabled 没清干净：" + JSON.stringify(diskOff()));
    const m3 = byName(await settled(port, ["deadproc"]));
    assert(m3.deadproc.enabled === true && m3.deadproc.error,
      "反向对照：重新打开就该真去连一次，连不上照旧说连不上：" + JSON.stringify(m3.deadproc).slice(0, 200));
  } finally {
    try { booted.child.kill(); } catch {}
    await new Promise((r) => deny.close(r));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
  console.log("✅ 连接器开关：关掉就真不连（存盘 + 重启还算数）· 开关归平台管理员 · 界面分得清「我关的」和「连不上」· 工具表问的是 runtime 那一份");
}

/**
 * 定时任务得留下「执行过程」，不是一句结果。
 *
 * 用户原话：「我定时任务怎么没看到具体的执行过程啊」→「我想要看到每次具体的运行记录啊」。
 * 当时运行记录那一屏每行只有一句被截到 500 字的正文；点不进去，也没有别处可点。
 * 根因是 scheduler.js 里那句光秃秃的 `runtime.runTask({ history })`——**不给 emit 就没有事件，
 * 不给 sessionId 就没有会话**，过程从一开始就没被记下来过，前端再怎么改也变不出来。
 *
 * 所以这条测试钉的是那根链子的每一节，而不是界面上那个链接长什么样：
 *   ① 调度器把 recorder 给的 emit/sessionId 原样交给 runTask，并把 session_id 写进运行记录
 *   ② 成、败、抛异常三条路都得收尾（done 调一次且只调一次），不然崩一次就留下一段永远没结论的会话
 *   ③ 运行记录被挤掉 / 任务被删，跟着的那段会话也得清掉——后台 cron 只进不出就是个漏
 *   ④ ⚠️ recorder 的 opts 不许盖掉 taskLabel：agent.js 靠 taskLabel === "定时任务" 才不让
 *      一条定时任务再去改排期表。这一条盖掉了会长出一个没人看着的自我繁殖闭环。
 *   ⑤ 端到端：真 server.js + 真 agent + 一个假模型，手动触发一次，运行记录上要有 session_id，
 *      拿它去 /api/session/<id> 要能取回**带工具调用**的完整回放。
 */
async function testScheduleRunTrace() {
  const os = require("os");
  const http = require("http");
  const { createScheduler, SCHEDULE_LABEL } = require("../scheduler");

  // ---- ① 调度器这一层：录像机插上了，过程才有地方去 ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sched-rec-"));
    const storePath = path.join(dir, "schedules.json");
    const seen = [];          // runTask 每次收到的 opts
    const closed = [];        // done 被调了几次、报的什么
    const forgotten = [];     // forget 收到过哪些 session id
    let nth = 0;
    const runtime = {
      runTask: async (opts) => {
        seen.push(opts);
        // 定时任务真正跑起来时是 accountedRuntime 在铺 taskLabel，这儿照它的顺序模拟一遍：
        // 先铺默认，再摊调用方给的。摊在后面的一旦带了 taskLabel，铺的那份就没了。
        const merged = { taskLabel: SCHEDULE_LABEL, ...opts };
        assert.strictEqual(merged.taskLabel, SCHEDULE_LABEL,
          "★recorder 的 opts 把 taskLabel 盖掉了★ agent.js 就是靠它 === 「定时任务」才不许定时任务再改排期表的，" +
          "盖掉之后一条定时任务可以排出下一条，没人看着的时候会自己越滚越多。实际收到：" + merged.taskLabel);
        if (nth++ === 1) throw new Error("上游连不上");     // 第二趟走 catch 那条路
        assert(typeof opts.emit === "function" && opts.sessionId,
          "★runTask 没拿到 emit/sessionId★ 那就是一个字的过程都不会被记下来——运行记录永远只有一句结果。实际收到：" + Object.keys(opts).join("/"));
        opts.emit({ type: "tool_use", name: "write_file", input: { path: "日报.md" } });
        opts.emit({ type: "text", delta: "写完了" });
        return { finalText: "日报已生成：日报.md" };
      },
    };
    let n = 0;
    const recorder = ({ item, trigger, run }) => {
      const sessionId = "s_fake_" + ++n;
      assert(item && item.id && trigger && run, "recorder 拿不到 item/trigger/run，外头没法给这段会话起名、也没法判归属");
      const events = [];
      return {
        sessionId,
        opts: { sessionId, emit: (ev) => events.push(ev) },
        done: (ok, text) => closed.push({ sessionId, ok, text, events: events.length }),
      };
    };
    recorder.forget = (ids) => forgotten.push(...ids);

    const sched = createScheduler({ runtime, recorder, storePath });
    const t = sched.add({ name: "每天日报", cron: "0 9 * * *", task: "写今天的日报" });

    await sched.runOne(t, "手动");
    assert(seen[0] && typeof seen[0].emit === "function" && seen[0].sessionId,
      "★runTask 没拿到 emit/sessionId★ 那就是一个字的过程都不会被记下来——运行记录永远只有一句结果。实际：" + Object.keys(seen[0] || {}).join("/"));
    assert(seen[0].history && seen[0].history[0].content === "写今天的日报", "任务正文没送进去，录下来的过程就对不上这条任务");
    const r1 = sched.runs(10)[0];
    assert.strictEqual(r1.session_id, "s_fake_1",
      "★运行记录上没挂 session_id★ 前端那条「看执行过程」就没有 id 可点，等于这一趟又白录了");
    assert.deepStrictEqual({ ok: closed[0].ok, events: closed[0].events }, { ok: true, events: 2 },
      "跑成功这条路没正常收尾（或者事件没进录像）：" + JSON.stringify(closed[0]));

    // 第二趟：上游抛异常。这条路最容易漏——一崩就 return/throw 走了，会话停在「正在跑」永远没结论
    await sched.runOne(t, "手动").then(() => assert(false, "上游抛了异常，runOne 该把它抛出来"), () => {});
    assert.strictEqual(closed.length, 2, "★出错那一趟没收尾★ 点进去是一段永远没有结论的回放，看着像卡住了");
    assert(closed[1].ok === false && /连不上/.test(closed[1].text),
      "出错收尾得把原因带进去（整趟没事件时全靠它兜底，不然点进去一片空白）：" + JSON.stringify(closed[1]));
    assert.strictEqual(sched.runs(10)[0].session_id, "s_fake_2", "出错的那一趟同样要能点进去看——恰恰是它最需要看");

    // ---- ③ 只进不出的话，后台 cron 会一直往盘上堆没人管的会话文件 ----
    assert.strictEqual(forgotten.length, 0, "还没删过任何东西，不该清会话");
    sched.remove(t.id);
    assert.deepStrictEqual(forgotten.sort(), ["s_fake_1", "s_fake_2"],
      "★删掉定时任务，它那几段执行过程成了孤儿★ 没有任何入口，却永远占着盘。实际清掉的：" + forgotten.join("/"));
  }

  // ---- 没插 recorder（CLI、老调用方）时一切照旧：不录、不报错、照常执行 ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sched-norec-"));
    const sched = createScheduler({
      runtime: { runTask: async (o) => { assert(!o.emit && !o.sessionId, "没插录像机就不该凭空多出 emit/sessionId"); return { finalText: "好了" }; } },
      storePath: path.join(dir, "schedules.json"),
    });
    const t = sched.add({ name: "无录像", cron: "0 9 * * *", task: "干点什么" });
    await sched.runOne(t, "手动");
    const r = sched.runs(10)[0];
    assert(r.ok === true && !("session_id" in r), "没录像时不该留下 session_id 字段（前端凭它决定画不画链接）：" + JSON.stringify(r));
  }

  // ---- ⑤ 端到端：真 server + 真 agent + 假模型，跑完能从 /api/session 里取回完整过程 ----
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sched-e2e-"));
  let turn = 0;
  const llm = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const j = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (!req.url.includes("/chat/completions")) { res.writeHead(404); return res.end("{}"); }
      // 第一趟让它真调一次工具：「执行过程」这四个字指的就是这一步，只有正文的回放证明不了什么
      if (turn++ === 0) {
        return j({
          choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
            id: "call_1", type: "function",
            function: { name: "write_file", arguments: JSON.stringify({ path: "定时产物.md", content: "# 这是定时任务写的\n" }) },
          }] } }],
          usage: { prompt_tokens: 9, completion_tokens: 3 },
        });
      }
      j({ choices: [{ message: { role: "assistant", content: "已经写好 定时产物.md 了。" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    });
  });
  await new Promise((r) => llm.listen(0, "127.0.0.1", r));
  const llmPort = llm.address().port;

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.example.json"), "utf8"));
  // 模型列表优先于 provider/openai 那一套老字段，只改后者的话真跑起来还是去连 DeepSeek。
  // stream:false 让 llm.js 走非流式分支，上面那个假接口回个普通 JSON 就够了
  cfg.provider = "openai";
  cfg.openai = { base_url: `http://127.0.0.1:${llmPort}/v1`, api_key: "k", model: "mock", stream: false };
  cfg.models = [{ name: "假模型", provider: "openai", base_url: `http://127.0.0.1:${llmPort}/v1`, api_key: "k", model: "mock", stream: false }];
  cfg.active_model = "假模型";
  cfg.agent = { ...(cfg.agent || {}), max_steps: 4, tool_timeout_ms: 8000, llm_timeout_ms: 20000 };
  cfg.mcp_servers = [];
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2));

  const crypto = require("crypto");
  const owner = "owner" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [owner]: { user: "boss", at: Date.now() } },
  }));

  const call = (port, method, p, body) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      Cookie: "openworkbuddy_token=" + owner,
    } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json: j }); });
    });
    req.on("error", (e) => resolve({ code: 0, body: e.message }));
    if (data) req.write(data);
    req.end();
  });

  const boot = bootRealServer({ OPENWORKBUDDY_HOME: home });
  try {
    const { up, port, why } = await boot.wait();
    assert(up, "真 server.js 没起来，这条测试作废：" + why);

    const made = await call(port, "POST", "/api/schedules", { name: "五分钟后叫我", cron: "0 9 * * *", task: "写一份 定时产物.md" });
    assert(made.code === 200 && made.json && made.json.id, "建不了定时任务（HTTP " + made.code + "）：" + made.body.slice(0, 200));

    const fired = await call(port, "POST", `/api/schedules/${made.json.id}/run`, {});
    assert(fired.code === 200, "手动触发失败（HTTP " + fired.code + "）：" + fired.body.slice(0, 300));

    const runs = await call(port, "GET", "/api/schedules/runs?limit=10");
    const run = Array.isArray(runs.json) ? runs.json[0] : null;
    assert(run, "运行记录是空的，这一趟压根没记下来：" + runs.body.slice(0, 300));
    assert(run.session_id,
      "★真跑一趟之后，运行记录上还是没有 session_id★ 界面上那条「看执行过程」画不出来，" +
      "用户看到的就还是那一行结果——这正是他抱怨的那个样子。这一条：" + JSON.stringify(run).slice(0, 300));

    const sess = await call(port, "GET", "/api/session/" + encodeURIComponent(run.session_id));
    assert(sess.code === 200 && sess.json, "拿 session_id 去开会话开不开（HTTP " + sess.code + "）：" + sess.body.slice(0, 200));
    const tr = sess.json.transcript || [];
    assert(tr.length >= 2 && tr[0].type === "user" && tr[0].text.includes("定时产物"),
      "回放的第一条该是这条定时任务的正文，不然点进去看不出这是在跑什么：" + JSON.stringify(tr).slice(0, 300));
    const evs = (tr.find((e) => e.type === "assistant") || {}).events || [];
    const kinds = evs.map((e) => e.type);
    assert(kinds.includes("tool_use") && kinds.includes("tool_result"),
      "★回放里没有工具调用★「执行过程」指的就是这几步：调了什么、返回了什么。只剩一段正文的话，等于换个地方再看一遍那句结果。实际事件：" + kinds.join("/"));
    assert(evs.some((e) => e.type === "tool_use" && e.name === "write_file"),
      "工具事件记下来了但认不出是哪个工具：" + JSON.stringify(evs).slice(0, 300));
    assert(kinds.includes("text"), "最后的正文也得在回放里，不然看完过程看不到结论：" + kinds.join("/"));

    // 归属：这段会话跟排期本身同一条判据，而且不该混进侧栏任务历史（一天几十条 cron 会把真对话挤没）
    assert.strictEqual(sess.json.kind, "schedule", "定时任务跑出来的会话要认得出自己是定时任务：" + JSON.stringify(sess.json).slice(0, 200));
    const list = await call(port, "GET", "/api/sessions");
    const rows = ((list.json || {}).sessions) || [];
    assert(Array.isArray(rows) && !rows.some((r) => r.id === run.session_id),
      "★定时任务的会话挤进了侧栏任务历史★ 一天几十条 cron 会把用户自己的对话全顶下去；它的正经去处是 自动化 → 运行记录");

    // ⑥ 「五分钟后叫我」这一路：HTTP 这一层得把 at 原样递到排期表里。
    //    路由是 `{...req.body}` 直接摊进 add 的，看着不会漏；可 add 的签名一改就静悄悄少一个字段，
    //    而少了它的表现不是报错，是变回一条每天都响的 cron——正是用户抱怨的那个样子。
    const once = await call(port, "POST", "/api/schedules", { name: "五分钟后叫我去准备面试", at: "+5m", task: "提醒我去准备面试" });
    assert(once.code === 200 && once.json && once.json.at,
      "★一次性排期在 HTTP 这一层丢了★ at 递不进去的话，「五分钟后叫我」只能退回 cron 去近似，那是一条每天都响的闹钟。回的是（HTTP " +
      once.code + "）：" + once.body.slice(0, 300));
    assert(!once.json.cron, "只跑一次的那条不许同时带 cron（两个都认就会各响各的）：" + JSON.stringify(once.json).slice(0, 200));
    const gapMin = Math.round((Date.parse(once.json.at) - Date.now()) / 60000);
    assert(gapMin === 5, "「+5m」该落在五分钟后，实际落在 " + gapMin + " 分钟后：" + once.json.at);
    const both = await call(port, "POST", "/api/schedules", { at: "+5m", cron: "0 14 * * *", task: "两个都给" });
    assert(both.code === 400, "反向对照：at 和 cron 同时给要被拒（HTTP " + both.code + "）：" + both.body.slice(0, 200));
  } finally {
    boot.child.kill("SIGKILL");
    llm.close();
  }
  console.log("  ✓ 定时任务留下完整执行过程（运行记录点得进去看每一步）");
}

async function testMcpFailureReason() {
  const { McpManager } = require("../mcp");
  const mgr = new McpManager();
  // 假服务器：往 stderr 喊一句就带着非零退出码死掉，跟真实的 filesystem 一个形状
  await mgr.startAll([
    { name: "会喊一嗓子再死的", command: process.execPath, args: ["-e", 'console.error("配的目录不存在: /nope"); process.exit(3);'] },
    { name: "命令根本不存在的", command: "owb-no-such-binary-" + Date.now(), args: [] },
  ]);
  const byName = Object.fromEntries(mgr.failures.map((x) => [x.name, x.error]));
  const rawByName = Object.fromEntries(mgr.failures.map((x) => [x.name, x.raw || ""]));
  const dead = byName["会喊一嗓子再死的"] || "";
  assert(dead, "死掉的连接器必须留下一条失败记录");
  assert(dead.includes("配的目录不存在: /nope"), "失败消息里没有 stderr 的原话，用户无从判断该改什么: " + dead);
  assert(dead.includes("3"), "失败消息里没有退出码: " + dead);
  // 负向对照：不能只剩一句「已退出」——那正是改之前的样子
  assert(dead.replace(/[\s\S]*已退出/, "").trim().length > 0, "失败消息退化成了光秃秃的「已退出」: " + dead);
  // 另一头：连命令都没有时，ENOENT 说的是「什么东西不在」，但没说该怎么办。
  // 现在界面上那句写成人话（哪个命令没找到、拿什么装），技术原文原样留在 raw 里给日志和排障用。
  const gone = byName["命令根本不存在的"] || "";
  assert(/owb-no-such-binary-/.test(gone) && /装/.test(gone), "命令不存在时没写清是哪个命令、怎么装: " + gone);
  assert(/ENOENT/.test(rawByName["命令根本不存在的"] || ""), "技术原文（ENOENT）没留在 raw 里，排障时就查不到了");
  mgr.stop([]);
  console.log("✅ 连接器：死了会说清死因（退出码 + 它自己最后喊的那句），不是光一句「已退出」");
}

function testPetSprites() {
  const os = require("os");
  const sprites = require("../pet-sprites");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pets-"));
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
 * 手搓一张真 PNG，专供测试当料用。
 *
 * **故意不复用 thumb-png.js 的编码器**：那头正是被测的东西，拿它造料再拿它解，
 * 等于自己判自己的卷子——编码和解码一起写错，测试照样全绿。
 * 这里只按 PNG 规范老老实实写：签名 + IHDR(8 位 RGB，非隔行) + 一个 IDAT(每行 filter 0) + IEND。
 * 像素用一个定死种子的伪随机填：内容压不动，出来的文件才过得了 thumb.js 那道 100 KB 的门槛
 * （渐变之类一压就剩几 KB，走不到缩放那一步，测了个寂寞）。
 */
function e2ePng(w, h, pixel) {
  const zlib = require("zlib");
  const { crc32 } = require("../thumb-png");   // CRC 不是被测的东西，借一下不影响判卷
  const raw = Buffer.alloc(h * (w * 3 + 1));
  // xorshift32（不是随手写的线性同余：seed * 1103515245 会越过 53 位有效位，
  // 低位被抹掉之后序列很快退化成重复花样，deflate 一压 780 KB 只剩 19 KB，
  // 连 100 KB 的门槛都过不去——这条测试就悄悄变成什么都没测）
  let seed = 0x2f6e2b1;
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;                               // filter 0：none
    for (let x = 0; x < w; x++) {
      const i = off + 1 + x * 3;
      if (pixel) {                                // 要一张压得很小的图时用（比如验体积门槛）
        const v = pixel(x, y);
        raw[i] = v[0]; raw[i + 1] = v[1]; raw[i + 2] = v[2];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5;  seed >>>= 0;
        raw[i + c] = seed & 255;
      }
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
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                                  // 位深
  ihdr[9] = 2;                                  // 色型 2 = RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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
  // ?thumb= 的退路要用的料：得过 thumb.js 那道 100 KB 的门槛，不然走不到 nativeImage 那一步，
  // 下面那条就成了在测「文件太小不缩」。内容用可见字符，方便直接比字符串
  const BIG = Buffer.from("THUMBFALLBACK".repeat(12000));   // ≈152 KB
  fs.writeFileSync(path.join(ws, "大图.png"), BIG);
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

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const child = booted.child;
  const { up, port, why: bootWhy } = await booted.wait();

  // 收成 Buffer 再给两个视角：body 当文字看，buf 当字节看。
  // 之前这里是 b += c，等于拿 utf8 解——文字没事，PNG 的字节会被替换成 U+FFFD，怎么看都是坏图
  const get = (p) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers: { Cookie: "openworkbuddy_token=" + token } }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(parts);
        resolve({ code: res.statusCode, body: buf.toString("utf8"), buf });
      });
    });
    req.on("error", (e) => resolve({ code: 0, body: e.message, buf: Buffer.alloc(0) }));
    req.end();
  });

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);
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

    // ⑥ ?thumb=320 的退路：**文件缩不动的时候必须原样发原图**。
    // 大图.png 里装的是 "THUMBFALLBACK" 重复填的字节，扩展名是 .png 但根本不是 PNG
    // （工作空间里真有两张这样的：JPEG 的字节配 .png 的名字）。
    // 缩略图是锦上添花，绝不许因为它让一张图显示不出来。
    assert(BIG.length > 100 * 1024, "料不够大，走不到缩放那一步，⑥ 等于没测（" + BIG.length + " B）");
    const asThumb = await get(enc(DIR + "/大图.png") + "?thumb=320");
    assert(asThumb.code === 200, "带 ?thumb=320 的坏图取不到（HTTP " + asThumb.code + "）——产出卡上会是一片空白");
    assert(asThumb.body === BIG.toString(), "不是 PNG 却没原样发回原图，退路断了");
    const asIs = await get(enc(DIR + "/大图.png"));
    assert(asIs.body === asThumb.body, "带不带 ?thumb= 发回来的东西不一样（缩不动时应该完全一致）");
    const thumbDir = path.join(home, "data", "thumbs");
    // 负向对照：缩不出来就不许在磁盘上留一份空缓存，下次也不会把空文件当缩略图发出去
    assert(!fs.existsSync(thumbDir) || fs.readdirSync(thumbDir).filter((f) => !f.startsWith(".")).length === 0,
      "缩不动却往缓存目录里写了东西：" + (fs.existsSync(thumbDir) ? fs.readdirSync(thumbDir).join(",") : ""));

    // ⑥b 真 PNG 在**纯 node** 下要真的缩出来。这一条是用户那句「这个网页版感觉很卡」的正主：
    // 缩放原本只有 Electron 的 nativeImage 一条路，而 `npm start`（还有内网、私有化部署那台
    // 服务器，它连 electron 都没装，那只是个 devDependency）跑的是纯 node —— 等于**网页版
    // 一张缩略图都没有**，7 MB 的原图整张丢给浏览器解。thumb-png.js + thumb-worker.js 补的就是这条。
    // bootRealServer 起的正是 `node server.js`，所以这里量的就是网页版那一边。
    const realPng = e2ePng(420, 620);
    // 料不到 100 KB 就走不到缩放那一步（thumb.js THUMB_MIN_BYTES），下面几条等于没测
    assert(realPng.length > 100 * 1024, "造出来的 PNG 只有 " + realPng.length + " B，压得太狠，⑥b 等于没测");
    fs.writeFileSync(path.join(ws, "真图.png"), realPng);
    const real = await get(enc(DIR + "/真图.png") + "?thumb=320");
    assert(real.code === 200, "纯 node 下真 PNG 的缩略图取不到（HTTP " + real.code + "）");
    const shrunk = real.buf;
    const meta = require("../thumb-png").pngInfo(shrunk);
    assert(meta, "纯 node 发回来的不是一张 PNG —— 缩略图那条路把图弄坏了");
    assert(Math.max(meta.width, meta.height) === 320,
      "缩出来的长边是 " + meta.width + "×" + meta.height + "，不是 320");
    assert(meta.height === 320 && meta.width === 217,
      "长宽比没保住（420×620 应缩成 217×320，实际 " + meta.width + "×" + meta.height + "）");
    const orig = fs.statSync(path.join(ws, "真图.png")).size;
    assert(shrunk.length < orig / 4,
      "缩完只有 " + orig + " → " + shrunk.length + " B，没省下什么，白折腾一趟");
    // 落盘缓存：第二次要同一张图不该再缩一遍
    const cached = fs.readdirSync(thumbDir).filter((f) => !f.startsWith("."));
    assert(cached.length === 1, "缓存目录里躺着 " + cached.length + " 个文件（应只有刚缩出来那一个）");
    const again = await get(enc(DIR + "/真图.png") + "?thumb=320");
    assert(again.buf.equals(real.buf), "第二次要同一张缩略图，发回来的跟第一次不一样");
    assert(fs.readdirSync(thumbDir).filter((f) => !f.startsWith(".")).length === 1,
      "第二次又缩了一遍，缓存没命中");
    assert(!fs.readdirSync(thumbDir).some((f) => f.endsWith(".part")),
      "缓存目录里留下了写了一半的临时文件");


    // ⑦ 资料库那条路由（/api/library/file/*）走的是同一段。它要登录才够得着，
    // 这里不另起一套会话，只钉住两件事：两处都调了 thumbFileAsync，且共用同一个缓存目录——
    // 缓存键里带的是绝对路径，同一个目录不会串，各写一个目录才会漏缓存、重复缩
    const ssrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const calls = ssrc.split("\n").filter((line) => /const thumb = await thumbFileAsync\(/.test(line));
    assert(calls.length === 2, "server.js 里调 thumbFileAsync 的地方有 " + calls.length + " 处（应为产出预览和资料库两处）");
    // 少一个 await，返回的就是个 Promise，if (thumb) 永远为真，sendFile 会拿到一个对象直接 500
    assert(!/const thumb = thumbFileAsync\(/.test(ssrc), "有一处调 thumbFileAsync 忘了 await");
    assert(calls.every((line) => line.includes('path.join(dataPath("data"), "thumbs")')),
      "两处缩略图没共用同一个缓存目录：\n" + calls.join("\n"));
    const libRoute = ssrc.slice(ssrc.indexOf('app.get("/api/library/file/*"'));
    assert(libRoute.indexOf("thumbFileAsync(") < libRoute.indexOf("res.download(p)"),
      "资料库那条路由把 ?thumb= 写在 res.download 后面了——永远走不到，资料库还是一屏原图");

    console.log("✅ 成果预览路径：会话子目录里的网页和它相对路径引的图都取得到（压平写法负对照 404，%2F 老链接不断，越界仍拦得住，纯 node 下真 PNG 真缩出 320、坏文件原样发原图，资料库共用同一段缩略图）");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 资料库「按任务看产出」：清单不全的时候，别猜。
 *
 * 用户的工作目录里攒了 932 个文件，而 outputFiles() 按 mtime 倒序只留最新 500 条（FILES_CAP）。
 * 旧任务的产出整批掉出这份快照之后，这一页以前是这么处理的：size 记 0、mtime 记空、gone 一律 false
 * ——于是一个早就被删掉的文件，在界面上画成一行正常记录，体积那栏还是 libSize(0) 撞下限撞出来的
 * 「1 KB」。点进去才发现全是 404：图裂成碎图标、md 说「读取失败」、html 渲染成一片空白。
 * 用户原话：「怎么点击图片没有办法预览了？」「点击md也是没法预览啊」「html也是」
 * 「在资料库里面预览功能这么差的啊」。
 *
 * 这一趟起真 server.js，把那个场景原样搭出来：560 个文件（真的越过 500 的线）、
 * 一份"还在但掉出快照"的产出、一份"名字还在人没了"的产出、一份刚出炉的产出。
 * 三条断言彼此互为对照：漏报（把没了的说成还在）和误报（把还在的说成没了）都会被逮住。
 */
async function testLibraryOutputsTruth() {
  const os = require("os");
  const http = require("http");
  const crypto = require("crypto");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-lib-"));
  const ws = path.join(home, "workspace");
  const OUT = "任务_0916_短剧";
  fs.mkdirSync(path.join(ws, OUT), { recursive: true });

  // ① 还在、但注定掉出快照的那份：mtime 摁到 2020 年，后面 560 个文件个个比它新
  const OLD = OUT + "/分镜脚本.md";
  const oldBody = "# 分镜\n第一场：小卖部门口\n";
  fs.writeFileSync(path.join(ws, OLD), oldBody);
  const oldStamp = new Date("2020-01-02T03:04:05Z");
  fs.utimesSync(path.join(ws, OLD), oldStamp, oldStamp);

  // ② 把快照挤爆。FILES_CAP=500，560 个就够，且全都比 ① 新
  // mtime 全部摁死，免得这一屏的结论取决于文件系统的时间精度：
  // 2020 的 ① 必定掉出快照，2021 的填充占满 500 个名额，③ 用当下时间必定还在快照里
  const FILL = 560;
  const fillStamp = new Date("2021-06-01T00:00:00Z");
  fs.mkdirSync(path.join(ws, "素材"), { recursive: true });
  for (let i = 0; i < FILL; i++) {
    const f = path.join(ws, "素材", `f${i}.txt`);
    fs.writeFileSync(f, "x");
    fs.utimesSync(f, fillStamp, fillStamp);
  }

  // ③ 刚出炉的那份：稳稳在快照里（阳性对照，验的是没把好的那条路改坏）
  const FRESH = OUT + "/成片链接.txt";
  fs.writeFileSync(path.join(ws, FRESH), "https://example.com/v/1");

  // ④ 名字在、东西不在：这就是用户点了半天没反应的那一类
  const GONE = OUT + "/场景_吴川小卖部.png";

  // ⑤ 名字在、东西被**挪走**了：升级时 migrate.js 把工作区根目录下的散文件收进
  // 「以前的文件_日期」，而这次对话记的是当时那个裸文件名。这一类跟 ④ 长得一模一样
  // （按原地址一查就是没有），但它根本没丢，只是往下挪了一层——
  // 报成「已不在」的话，用户看见的是「我的文件被你删了」。
  const MOVED = "海报初稿.png";
  const movedBody = "PNG-ish-bytes-海报";
  const ARCH = "以前的文件_20260917";
  fs.mkdirSync(path.join(ws, ARCH), { recursive: true });
  fs.writeFileSync(path.join(ws, ARCH, MOVED), movedBody);
  // ⑥ 反向对照：同样是根下的裸名字，但归档目录里也没有。回落这一手不能把所有查不到的
  // 名字都说成「在归档里」——那就成了另一个方向的谎，而且是更难查的那种
  const NOWHERE = "根本没生成出来.png";

  // 一次对话，产出上面三个名字
  const at = "2026-09-16T10:00:00.000Z";
  fs.mkdirSync(path.join(home, "data", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "sessions", "s_drama.json"), JSON.stringify({
    id: "s_drama", title: "粤西狗奶AI短剧", user: "e2e", updated_at: at,
    transcript: [{ type: "assistant", at, events: [{ type: "files", changed: [OLD, GONE, FRESH, MOVED, NOWHERE] }] }],
  }));

  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const child = booted.child;
  const { up, port, why: bootWhy } = await booted.wait();

  const get = (p, method = "GET") => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Cookie: "openworkbuddy_token=" + token } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      // 头也要：「内联发」跟「当附件发」字节一模一样，差别全在 Content-Disposition 上
      res.on("end", () => resolve({ code: res.statusCode, body: b, headers: res.headers }));
    });
    req.on("error", (e) => resolve({ code: 0, body: e.message, headers: {} }));
    req.end();
  });

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);
    const r = await get("/api/library/outputs");
    assert(r.code === 200, "产出清单取不到（HTTP " + r.code + "）：" + r.body.slice(0, 200));
    const data = JSON.parse(r.body);

    // 先验场景本身：快照没被挤爆的话，下面三条等于什么都没测
    assert(data.full === false,
           `工作目录只有 ${FILL} 个文件却还说快照是全的，这一屏的前提就不成立了 —— FILES_CAP 是不是改了？`);

    const task = (data.tasks || []).find((t) => t.id === "s_drama");
    assert(task, "那次对话的产出整组不见了：" + JSON.stringify(data.tasks || []).slice(0, 300));
    const by = new Map(task.files.map((f) => [f.name, f]));
    const enc = (rel) => "/api/files/view/" + rel.split("/").map(encodeURIComponent).join("/");

    // ① 掉出快照 ≠ 没了：单独 stat 一次，体积和时间都得是真的
    const old = by.get(OLD);
    assert(old, "掉出快照的那份产出整行没了：" + JSON.stringify(task.files));
    assert(old.gone === false,
           "文件明明还在磁盘上，却被报成「已不在」—— 误报比漏报更糟，用户会以为东西丢了跑去重做");
    assert(old.size === Buffer.byteLength(oldBody),
           `掉出快照的文件体积报成了 ${old.size}（真值 ${Buffer.byteLength(oldBody)}）—— 界面上就是那个满屏的「1 KB」`);
    assert(Math.abs(Date.parse(old.mtime) - oldStamp.getTime()) < 2000,
           `掉出快照的文件时间报成了 ${JSON.stringify(old.mtime)}（真值 ${oldStamp.toISOString()}）—— 那一列以前整片是空的`);

    // ② 名字在、东西不在：这一条才该说「没了」
    const gone = by.get(GONE);
    assert(gone, "没了的那份产出整行都不见了 —— 它该留在清单里并写明「已不在」，不是凭空消失");
    assert(gone.gone === true,
           "磁盘上根本没有这个文件，清单却说它还在：界面照常画一行、点进去 404 —— 这就是用户点了半天没反应的那一下");
    assert(!gone.size, "不存在的文件还报了体积：" + gone.size);

    // ⑤ 搬过家的要认出来，而且给的是**能打开的那个**地址
    const moved = by.get(ARCH + "/" + MOVED);
    assert(moved, `被升级整理搬走的那份没按新地址报出来，清单里是：${JSON.stringify(task.files.map((f) => f.name))}
       —— 按老名字查不到就判「已不在」的话，一次升级能让整批还在盘上的文件集体「消失」`);
    assert(moved.gone === false && moved.size === Buffer.byteLength(movedBody),
           "搬过家的文件报错了体积或还在说它没了：" + JSON.stringify(moved));
    assert(!by.get(MOVED),
           "同一个文件按老地址又报了一遍：界面上会出现两行，一行能开一行开不了");
    const movedGet = await get(enc(ARCH + "/" + MOVED));
    assert(movedGet.code === 200 && movedGet.body === movedBody,
           `清单给的新地址打不开（HTTP ${movedGet.code}）—— 那还不如老老实实说它不在`);
    assert(!(data.orphans || []).some((f) => f.name === ARCH + "/" + MOVED),
           "搬过家的文件同时又挂在「未归属」里：同一份东西在一页上出现两回");
    // ⑥ 反向对照：归档里也没有的裸名字，照旧得说「已不在」
    const nowhere = by.get(NOWHERE);
    assert(nowhere && nowhere.gone === true,
           "回落到归档目录那一手把所有查不到的裸名字都说成还在了：" + JSON.stringify(nowhere));

    // ③ 阳性对照：快照里的那份一切照旧
    const fresh = by.get(FRESH);
    assert(fresh && fresh.gone === false && fresh.size > 0 && fresh.mtime,
           "快照里的正常文件被改坏了：" + JSON.stringify(fresh));

    // ④ 预览这一路对得上：前端就是靠 404 才敢说「已经不在工作目录里」
    const okGet = await get(enc(OLD));
    assert(okGet.code === 200 && okGet.body === oldBody,
           `掉出快照但还在的文件预览不出来（HTTP ${okGet.code}）—— 清单说它在、预览说它不在，等于自相矛盾`);
    const goneGet = await get(enc(GONE));
    assert(goneGet.code === 404,
           `不存在的文件预览居然回了 HTTP ${goneGet.code} —— 前端只认 404，别的码一律会被当成「读不出来」`);
    const goneHead = await get(enc(GONE), "HEAD");
    assert(goneHead.code === 404,
           `HEAD 和 GET 不一个口径（HEAD ${goneHead.code}）—— 图片裂了之后补问的那一下就是 HEAD，两边不一致会把「没了」说成「文件坏了」`);

    // ⑤ 资料库里的 Office 文件：得有一条自己的拆包路由。用户原话：「这个PPT预览给我做好啊」
    //    「做PPT，workd还有excel,csv这些格式预览要给我兼容，给我做好啊」。
    //    /api/files/preview/ 认的根是**工作目录**，资料库在 data/library 下——这条要是不存在，
    //    同一份 .xlsx 在对话里点得开、拖进资料库就只能掉回「当文本读」，糊出一屏 PK… 的二进制。
    const ExcelJS = require("exceljs");
    const libDir = path.join(home, "data", "library", "财务");
    fs.mkdirSync(libDir, { recursive: true });
    const book = new ExcelJS.Workbook();
    book.addWorksheet("预算").addRow(["项目", "金额"]);
    book.addWorksheet("人员").addRow(["姓名"]);
    await book.xlsx.writeFile(path.join(libDir, "预算表.xlsx"));

    const lp = await get("/api/library/preview/" + ["财务", "预算表.xlsx"].map(encodeURIComponent).join("/"));
    assert(lp.code === 200, `资料库里的 .xlsx 拆不开（HTTP ${lp.code}）：${lp.body.slice(0, 200)}`);
    const lpd = JSON.parse(lp.body);
    assert(lpd.kind === "sheet" && (lpd.sheets || []).length === 2 && lpd.sheets[0].name === "预算",
           "资料库拆出来的结构不对（前端就是照这个画的）：" + lp.body.slice(0, 240));
    // 没了的要回 404：前端只认这个码才敢说「已经不在」，别的码一律当成「读不出来」
    const lpGone = await get("/api/library/preview/" + encodeURIComponent("查无此表.xlsx"));
    assert(lpGone.code === 404, `资料库里不存在的文件回了 HTTP ${lpGone.code}，前端会把「没这份」说成「读不出来」`);
    // 这条路由跟 /api/library/file/* 共用 libPath 的三道校验，越界必须当场拒
    const lpEsc = await get("/api/library/preview/" + encodeURIComponent("..") + "/config.json");
    assert(lpEsc.code === 400 || lpEsc.code === 404,
           `拿 .. 往资料库外面翻居然回了 HTTP ${lpEsc.code}：` + lpEsc.body.slice(0, 160));

    // ⑥ 资料库取文件那条路由：默认必须**内联**发。
    // 用户原话：「怎么没有办法预览啊」——一个 1 MB 的 note_audio.mp3 在这一页上
    // 只显示「文件太大，预览不动」。两头各坏一半，这里管服务端这一半：
    // 以前一律 res.download，带着 Content-Disposition: attachment 的响应，
    // <audio>/<video>/<iframe> 一个都渲染不出来，浏览器只会去下载。
    fs.writeFileSync(path.join(libDir, "note_audio.mp3"), Buffer.alloc(4096, 7));
    const mp3 = "/api/library/file/" + ["财务", "note_audio.mp3"].map(encodeURIComponent).join("/");
    const inline = await get(mp3);
    assert(inline.code === 200, `资料库里的 mp3 取不到（HTTP ${inline.code}）：` + inline.body.slice(0, 160));
    assert(!/attachment/i.test(String(inline.headers["content-disposition"] || "")),
           "资料库取文件又带上附件头了：" + inline.headers["content-disposition"]
           + " —— <audio>/<video>/<iframe> 拿到 attachment 一个都渲染不出来，页面上只剩「预览不动」");
    assert(String(inline.headers["content-type"] || "").startsWith("audio/"),
           "mp3 发成了 " + inline.headers["content-type"]
           + "：Chromium 按上游 MIME 决定要不要解码，标成 octet-stream 的话 <audio> 只会静默不播");
    const dl = await get(mp3 + "?dl=1");
    assert(/attachment/i.test(String(dl.headers["content-disposition"] || "")),
           "?dl=1 没带附件头（" + dl.headers["content-disposition"]
           + "）——改成内联发之后，「下载」就全靠这一条路，点下去会在原地打开、存不了盘");
    // 反向对照：不是音视频的别瞎插一个 MIME（插错了比不插更难查）
    const xl = await get("/api/library/file/" + ["财务", "预算表.xlsx"].map(encodeURIComponent).join("/"));
    assert(!String(xl.headers["content-type"] || "").startsWith("audio/"),
           ".xlsx 被当成音频发了：" + xl.headers["content-type"]);

    console.log("✅ 产出清单说实话：文件多到挤爆快照时，还在的照报真体积真时间 · 没了的写明「已不在」（两头互为反向对照）· 被升级整理搬走的按新地址找回来、不重复挂进「未归属」· 预览的 404/HEAD 跟清单一个口径 · 资料库里的 Office 文件有自己的拆包路由（越界照样拒）· 取文件默认内联发且音频带对 MIME，?dl=1 才当附件");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 资料库点一份产出，要能落回「写出它的那段对话」。
 *
 * 用户原话：「还有在资料库里一个文件能打开在对话中的位置啊，直接定位到所在位置和对话啊」。
 * 以前点过去只是把整条对话打开、一脚滚到最底下——一次跑了十几轮的任务，人还得自己往回翻，
 * 等于这一跳什么忙都没帮上。
 *
 * 这一屏盯的是**回合号怎么数**，因为它有个一眼看不出来的坑：前端回放时一条 type:"user"
 * 起一个 .turn，assistant 是挂进上一个回合里的，所以「第几回合」只能数 user 条目，
 * 拿 transcript 的数组下标充数会差出将近一倍——跳过去正好落在一段跟这份文件毫无关系的话上，
 * 比不跳更让人以为功能坏了。
 *
 * 下面这条会话特意排成 user/assistant/user/assistant，两个 assistant 各产出一份文件：
 * 按下标数的话第二份会报成 3，按 user 数才是 1。两份文件互为对照，一份对一份错的实现过不去。
 */
async function testLibraryTurnAnchor() {
  const os = require("os");
  const http = require("http");
  const crypto = require("crypto");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-turn-"));
  const ws = path.join(home, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  const FIRST = "大纲.md";
  const SECOND = "周报.md";
  fs.writeFileSync(path.join(ws, FIRST), "# 大纲\n");
  fs.writeFileSync(path.join(ws, SECOND), "# 周报\n");

  const at = "2026-09-17T09:00:00.000Z";
  fs.mkdirSync(path.join(home, "data", "sessions"), { recursive: true });
  const sess = (id, o) => fs.writeFileSync(path.join(home, "data", "sessions", id + ".json"), JSON.stringify({ id, user: "e2e", updated_at: at, ...o }));

  // ① 正主：两轮问答，第 0 轮出大纲、第 1 轮出周报
  sess("s_turn", {
    title: "周报这一摊", transcript: [
      { type: "user", at, text: "先给我列个大纲" },
      { type: "assistant", at, events: [{ type: "files", changed: [FIRST] }] },
      { type: "user", at, text: "照大纲把周报写出来" },
      { type: "assistant", at, events: [{ type: "files", changed: [SECOND] }] },
    ],
  });

  // ② 反向对照：改过好几轮的同一份文件，只该认头一轮。
  // 用户点它是想看「这东西怎么来的」，那句话在第一次写出它的那一段里，后面几轮是修修补补
  sess("s_redo", {
    title: "改了三轮的封面", transcript: [
      { type: "user", at, text: "做张封面" },
      { type: "assistant", at, events: [{ type: "files", changed: ["封面.png"] }] },
      { type: "user", at, text: "换个颜色" },
      { type: "assistant", at, events: [{ type: "files", changed: ["封面.png"] }] },
    ],
  });

  // ③ 反向对照：老会话根本没记过回合（升级前留下的那批）。
  // 这时候必须交白卷，不能写 0 —— 写 0 界面就会画出一个按钮、按下去跳到第一轮，
  // 那是「一本正经地跳错地方」，比没有按钮糟得多
  sess("s_old", {
    title: "升级前的老会话", transcript: [
      { type: "assistant", at, events: [{ type: "files", changed: ["老产出.txt"] }] },
    ],
  });

  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const child = booted.child;
  const { up, port, why: bootWhy } = await booted.wait();
  const get = (p) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers: { Cookie: "openworkbuddy_token=" + token } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ code: res.statusCode, body: b }));
    });
    req.on("error", (e) => resolve({ code: 0, body: e.message }));
    req.end();
  });

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);
    const r = await get("/api/library/outputs");
    assert(r.code === 200, "产出清单取不到（HTTP " + r.code + "）：" + r.body.slice(0, 200));
    const data = JSON.parse(r.body);
    const taskOf = (id) => (data.tasks || []).find((t) => t.id === id);

    const t = taskOf("s_turn");
    assert(t, "那条会话整组不见了：" + JSON.stringify((data.tasks || []).map((x) => x.id)));
    const by = new Map(t.files.map((f) => [f.name, f]));

    const a = by.get(FIRST);
    assert(a, "第一份产出没报出来：" + JSON.stringify(t.files));
    assert(a.turn === 0, `第一份产出的回合号报成了 ${JSON.stringify(a.turn)}，该是 0 —— 它是第一句话换来的`);

    const b = by.get(SECOND);
    assert(b, "第二份产出没报出来：" + JSON.stringify(t.files));
    assert(b.turn === 1,
      `第二份产出的回合号报成了 ${JSON.stringify(b.turn)}，该是 1。报成 3 就是拿 transcript 下标当回合数了` +
      "——回放时一条 user 起一个 .turn，assistant 挂在上一个回合里，两者差着将近一倍");

    // 同一份文件改过两轮，认头一轮
    const redo = taskOf("s_redo");
    assert(redo && redo.files.length === 1,
      "同一份文件被改过两轮就报了两行：" + JSON.stringify(redo && redo.files));
    assert(redo.files[0].turn === 0,
      `改过多轮的文件该定位到头一次写出它的那轮（0），实际 ${JSON.stringify(redo.files[0].turn)} —— 后面几轮是修修补补，讲不清「这东西怎么来的」`);

    // 没记过回合的：字段必须整个缺席，不能是 0 也不能是 -1
    const old = taskOf("s_old");
    assert(old && old.files[0], "老会话那组没了：" + JSON.stringify(old));
    assert(old.files[0].turn === undefined,
      `没有 user 记录的老会话报了 turn=${JSON.stringify(old.files[0].turn)} —— 该交白卷。` +
      "报 0 界面就会画个跳转按钮、按下去落在第一轮；报 -1 前端 Number.isInteger 一样认，同样画得出按钮");
    assert(!("turns" in old) && !("names" in old),
      "内部用的 names/turns 数组漏给前端了（一条任务几十个名字，白占带宽）：" + Object.keys(old).join(","));

    console.log("✅ 资料库跳回对话：回合号按 user 条目数（不是数组下标）· 同一文件改过多轮认头一轮 · 老会话没记过就交白卷（不写 0 也不写 -1）· 内部数组不外泄");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 端口被占的三种情况。
 *
 * 这条对应的是 GitHub 上那句「下载之后打不开」。老写法在 EADDRINUSE 时只说一句
 * 「窗口将连接已运行的实例」就把窗口指过去了——可 3800 是个大众端口，占着它的很可能
 * 是别人的开发服务器、路由器后台、随手起的 http.server。连过去的结果是一个陌生页面或者
 * 白屏，而启动日志里还写着「服务端就绪」，用户手上一条能查的线索都没有。
 *
 * 所以这屏不看源码，起**真的 server.js**，先在目标端口上坐一个假冒者，看它怎么办：
 *   ① 坐着的是别的程序      → 必须换个口把自己起起来，并且换完那个口上真的是 OpenWorkBuddy
 *   ② 坐着的是另一台 OWB    → 必须不重复起服务（负对照：证明「换口」是签名说了算，不是见占就换）
 *   ③ 坐着的人一声不吭      → 不许卡死在握手上，照样换口起来
 */
/**
 * 「整理文件夹 · 腾出空间」那两个口子，走真 HTTP。
 *
 * 规则本身在 test/sweep.js 里逐条测过了（41 条，带反向对照）。这里测的是**接线**：
 * 同一套规则挂到 server.js 上之后，登录闸有没有兜住、圈定范围的参数传没传下去、
 * 以及那条红线在 HTTP 这一层还成不成立。
 *
 * 最后一条是重点。sweep.apply() 的安全靠的是「不信任传进来的路径」——它自己重算一遍清单，
 * 只删这次也算得出来的。这个性质只有从外面打才算验过：单元测试里我是直接调函数的，
 * 而真正会构造恶意路径的人是从这个 POST 打进来的。
 */
async function testSweepApi() {
  const crypto = require("crypto");
  const http = require("http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sweep-api-"));
  const ws = path.join(home, "workspace");
  const put = (rel, bytes) => {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(bytes, 0x61));
  };
  // 一个做完了的短视频任务：成片在，逐帧图和 cookie 库是剩下的脚手架
  put("任务_短片/成片.mp4", 4000);
  for (let i = 1; i <= 30; i++) put(`任务_短片/frames/f_${String(i).padStart(3, "0")}.jpg`, 1000);
  put("任务_短片/ck.db", 800);
  // 另一个任务，用来验「只整理这一个」时它一根汗毛都不少
  put("任务_报告/ck.db", 500);
  put("任务_报告/报告.md", 2000);
  // 工作区里的正经成品，绝不许被点名删掉
  put("任务_短片/交付说明.md", 1500);

  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const { up, port, why: bootWhy } = await booted.wait();
  const call = (method, p, body, auth = true) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      ...(auth ? { Cookie: "openworkbuddy_token=" + token } : {}),
    } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json: j }); });
    });
    req.on("error", (e) => resolve({ code: 0, body: e.message }));
    if (data) req.write(data);
    req.end();
  });

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);

    // ① 登录闸。清单里有用户每个任务的目录名，那本身就是隐私
    const anon = await call("GET", "/api/files/sweep", null, false);
    assert(anon.code === 401, "没登录居然能看见清单（HTTP " + anon.code + "）：" + anon.body.slice(0, 120));
    const anonDel = await call("POST", "/api/files/sweep", { paths: ["任务_短片/ck.db"] }, false);
    assert(anonDel.code === 401, "没登录居然能删东西（HTTP " + anonDel.code + "）：" + anonDel.body.slice(0, 120));
    assert(fs.existsSync(path.join(ws, "任务_短片/ck.db")), "没登录那一发真把文件删了");

    // ② 清单：规则确实挂上去了
    const r = await call("GET", "/api/files/sweep");
    assert(r.code === 200 && r.json, "取不到清单（HTTP " + r.code + "）：" + r.body.slice(0, 200));
    const keys = (r.json.groups || []).map((g) => g.key).sort();
    assert(keys.join() === "frames,scratch", "认出来的组不对：" + keys.join() + "（原始回包 " + r.body.slice(0, 200) + "）");
    assert(r.json.bytes === 30000 + 800 + 500, "能腾出多少算错了：" + r.json.bytes);
    assert(r.json.usage === undefined, "没要地盘账却算了一份（白走一趟）");

    // ③ 地盘账：面板上半截是「能清什么」，下半截是「地方花在哪了」
    const u = await call("GET", "/api/files/sweep?usage=1");
    assert(u.json && u.json.usage && u.json.usage.tasks.length === 2,
      "地盘账不对：" + JSON.stringify(u.json && u.json.usage).slice(0, 200));
    assert(u.json.usage.tasks[0].name === "任务_短片", "没按占用从大到小排：" + u.json.usage.tasks.map((t) => t.name).join());

    // ④ 圈定到一个任务：另一个任务的东西一条都不许进来
    const one = await call("GET", "/api/files/sweep?task=" + encodeURIComponent("任务_报告"));
    const onePaths = (one.json.groups || []).flatMap((g) => g.items.map((i) => i.path));
    assert(onePaths.join() === "任务_报告/ck.db", "圈定范围没传下去：" + onePaths.join());

    // ⑤ ★红线★ 从 HTTP 这一层构造一串没在清单上的路径
    const evil = await call("POST", "/api/files/sweep", { paths: [
      "任务_短片/交付说明.md",            // 工作区里的成品，但不在清单上
      "任务_报告/报告.md",
      "../users.json",                     // 往上翻
      "../../../../etc/hosts",             // 一路翻到根
      "/etc/hosts",                        // 绝对路径
    ] });
    assert(evil.code === 200 && evil.json.removed.length === 0,
      "清单外的路径被删了：" + JSON.stringify(evil.json).slice(0, 200));
    assert(evil.json.skipped === 5, "五条应该全被挡下，实际 skipped=" + evil.json.skipped);
    assert(fs.existsSync(path.join(ws, "任务_短片/交付说明.md")), "★成品被删了★ 它被点了名，但它不在清单上");
    assert(fs.existsSync(path.join(ws, "任务_报告/报告.md")), "★另一个任务的成品被删了★");
    assert(fs.existsSync(path.join(home, "data", "users.json")), "★../ 翻出去把账号文件删了★");
    assert(fs.existsSync("/etc/hosts"), "★绝对路径得逞了★");

    // ⑥ 正路：勾了的真删掉，而且报的是真腾出来的字节数
    const plan = r.json.groups.flatMap((g) => g.items.flatMap((i) => i.paths || [i.path]));
    const del = await call("POST", "/api/files/sweep", { paths: plan });
    assert(del.code === 200 && del.json.ok, "清理没成功：" + del.body.slice(0, 200));
    assert(del.json.bytes === 31300, "腾出来的字节数不对：" + del.json.bytes);
    assert(!fs.existsSync(path.join(ws, "任务_短片/ck.db")), "ck.db 没删掉");
    assert(!fs.existsSync(path.join(ws, "任务_短片/frames/f_001.jpg")), "逐帧图没删掉");
    assert(fs.existsSync(path.join(ws, "任务_短片/成片.mp4")), "★成片被一起删了★ 这是这次任务唯一要留的东西");
    assert(fs.existsSync(path.join(ws, "任务_短片/交付说明.md")), "★交付说明被一起删了★");
    // 删就是真删：挪进 .trash 的话用户的盘一个字节都没腾出来
    assert(!fs.existsSync(path.join(ws, ".trash")), "★挪进 .trash 了★ 那样一点空间都没腾出来");
    assert(Array.isArray(del.json.files), "回包里没带刷新后的产物清单，界面上那一栏会停在删之前的样子");

    // ⑦ 再问一遍：该空了。这一条顺带证明清单不是缓存出来的
    const after = await call("GET", "/api/files/sweep");
    assert((after.json.groups || []).length === 0, "删完了还报得出东西来：" + after.body.slice(0, 200));

    // ⑧ 审计留档：事后有人问「我那个文件呢」，得查得出来。
    // 读接口不读文件——落盘有 500ms 的攒批，读文件会变成一条看时序的脆测试
    const au = await call("GET", "/api/security/audit");
    const line = JSON.stringify(au.json || []);
    assert(/任务_短片\/ck\.db/.test(line) && /任务_短片\/frames/.test(line),
      "审计里没记下删了什么，只记个数目等于没记：" + line.slice(0, 400));
  } finally {
    try { booted.child.kill(); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
  console.log("✓ 整理文件夹：登录闸 / 圈定范围 / 地盘账 / 清单外的路径删不动（含 ../ 和绝对路径）");
}

/**
 * 任务历史检索走一遍真服务：标题里没有的词，也得找得回那条对话。
 * 顺带钉死一件更要紧的事——**搜索不能成为绕过归属的后门**。
 * 侧栏按归属过滤是一道闸，检索是后开的另一扇门；两扇门不走同一道闸，
 * 就等于给「搜一下别人的对话」开了条路，而且没人会发现：搜出来的东西看着跟自己的一模一样。
 */
async function testSessionSearchLive() {
  const os = require("os");
  const http = require("http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ssearch-"));

  const req = (port, method, p, body, cookie) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      ...(cookie ? { cookie } : {}),
    } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode, body: b, json: j, setCookie: res.headers["set-cookie"] }); });
    });
    r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
  const search = async (port, cookie, q) =>
    (await req(port, "GET", "/api/sessions/search?q=" + encodeURIComponent(q), null, cookie)).json || {};

  // 三条会话：标题一律起得跟人会搜的词不沾边，逼着检索去翻正文和产出文件名
  const sessions = {
    s_a1: { title: "本周工作小结", user: "", turns: [["帮我把这周的进展写成周报，发给主管", "好的，周报已经生成。"]], files: ["周报-0918.docx"] },
    s_a2: { title: "表格清洗", user: "", turns: [["这个 csv 里有很多重复的行，帮我挑出来去掉", "已去重，共删除 128 行。"]], files: ["清洗结果.xlsx"] },
    s_b1: { title: "别人的活儿", user: "", turns: [["帮我把这周的进展写成周报", "好。"]], files: ["周报-别人的.docx"] },
  };

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_DATA_DIR: path.join(home, "data") });
  try {
    const { up, port, why } = await booted.wait();
    assert(up, "真 server.js 没起来，这条测试作废：" + why);

    const reg = async (username, invite) => {
      const r = await req(port, "POST", "/api/auth/register", { username, password: "Str0ngPass!2345", ...(invite ? { invite } : {}) });
      const c = (r.setCookie || []).map((x) => x.split(";")[0]).join("; ");
      assert(c, "注册没拿到 cookie：" + r.status + " " + r.body.slice(0, 160));
      return c;
    };
    const ca = await reg("aaa");   // 头一个注册的是平台管理员
    // 第二个人得拿邀请码进来（默认不开自助注册）——顺手也验了这条路还通着
    const iv = await req(port, "POST", "/api/admin/invites", { role: "member" }, ca);
    const code = (iv.json && (iv.json.code || (iv.json.invite && iv.json.invite.code))) || "";
    assert(code, "管理员发不出邀请码，第二个账号进不来：" + iv.status + " " + String(iv.body).slice(0, 200));
    const cb = await reg("bbb", code);

    // 直接把会话文件摆进去：这一条测的是检索，不是聊天链路
    const dir = path.join(home, "data", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    sessions.s_a1.user = sessions.s_a2.user = "aaa";
    sessions.s_b1.user = "bbb";
    for (const [id, s] of Object.entries(sessions)) {
      const transcript = [];
      for (const [u, a] of s.turns) {
        transcript.push({ type: "user", text: u, at: Date.now() });
        transcript.push({ type: "assistant", at: Date.now(), events: [
          { type: "text", delta: a },
          { type: "files", changed: true, files: s.files.map((n) => ({ name: n })) },
        ] });
      }
      fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({
        title: s.title, user: s.user, transcript, history: [], updated_at: Date.now(), lane: "work",
      }));
    }

    // ① 正文命中：标题「表格清洗」四个字里一个都不沾，可这句话是他自己打的
    const r1 = await search(port, ca, "重复的行");
    assert(r1.hits && r1.hits.length === 1 && r1.hits[0].title === "表格清洗",
      "正文里写着的词没搜出来——这正是「只筛标题」那版的毛病：" + JSON.stringify(r1.hits || r1).slice(0, 300));
    assert(r1.hits[0].why === "对话里", "没标清楚是靠什么找到的：" + r1.hits[0].why);
    assert(r1.hits[0].snippet && r1.hits[0].snippet.text.includes("重复的行"),
      "没给命中片段，人得点进去才知道为什么是它：" + JSON.stringify(r1.hits[0].snippet));

    // ② 产出文件名命中：只记得导出过一个 xlsx
    const r2 = await search(port, ca, "xlsx");
    assert(r2.hits.length === 1 && r2.hits[0].why === "产出文件", "文件名没进搜索范围：" + JSON.stringify(r2.hits).slice(0, 300));

    // ③ 没走语义要明说，不许悄悄降级
    assert(r2.semantic === false && /没走/.test(r2.note || ""),
      "这台测试机没配嵌入渠道，却没在结果里说「意思相近这一路没走」：" + JSON.stringify({ semantic: r2.semantic, note: r2.note }));

    // ④ ★后门★：aaa 搜「周报」只该看见自己那条，bbb 那条一样命中却不能露面
    const r3 = await search(port, ca, "周报");
    const ids3 = (r3.hits || []).map((h) => h.id);
    assert(ids3.includes("s_a1"), "自己的那条都没搜出来：" + JSON.stringify(r3.hits).slice(0, 300));
    assert(!ids3.includes("s_b1"),
      "★搜索绕过了归属过滤★ 侧栏看不见的会话被搜出来了，这是条谁都不会发现的越权：" + JSON.stringify(ids3));
    const r4 = await search(port, cb, "周报");
    const ids4 = (r4.hits || []).map((h) => h.id);
    assert(ids4.includes("s_b1") && !ids4.includes("s_a1"), "反过来一样：" + JSON.stringify(ids4));

    // ⑤ 反向对照：不相干的词一条都不给
    const r5 = await search(port, ca, "今天天气怎么样");
    assert((r5.hits || []).length === 0, "不相干的词也硬凑了几条出来：" + JSON.stringify(r5.hits).slice(0, 200));

    // ⑥ 没登录就搜不了：这扇门跟别的门同一道闸
    const anon = await req(port, "GET", "/api/sessions/search?q=" + encodeURIComponent("周报"));
    assert(anon.status === 401, "没登录也能搜，登录闸漏了这一扇门：" + anon.status);
  } finally {
    try { booted.child.kill(); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
  console.log("✓ 任务历史检索：正文 / 产出文件名都搜得到 · 标清楚靠什么找到 · 没走语义就明说 · 搜不到别人的（含没登录）");
}

/**
 * 判断模型（Jev）那几个接口：没配的时候要老实说没配，别编一个答案出来。
 *
 * 这一条**不联网、不花钱**：上游故意指到 127.0.0.1:1（一个一定没人听的端口），
 * 连接会立刻被拒。要验的本来也不是模型答得准不准（那是 test/systemone.js 的事），
 * 而是这条链路上的四个静默失败：没登录也能问、没配却回一个假答案、
 * 渠道里填的地址被无视、以及判断模型被当成对话模型去 ping。
 */
async function testDecideLive() {
  const os = require("os");
  const http = require("http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-decide-"));

  const req = (port, method, p, body, cookie) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      ...(cookie ? { cookie } : {}),
    } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode, body: b, json: j, setCookie: res.headers["set-cookie"] }); });
    });
    r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });

  const 一道题 = { 急不急: { type: "noul", instructions: "这位客户是不是很着急" } };
  const 一段材料 = "客服工单：收款账号连了三天都连不上，订单都在丢，麻烦尽快。";

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_DATA_DIR: path.join(home, "data") });
  try {
    const { up, port, why } = await booted.wait();
    assert(up, "真 server.js 没起来，这条测试作废：" + why);

    // ① 没登录就问不了：判断模型也要花钱，这扇门跟别的门同一道闸
    const anon = await req(port, "GET", "/api/decide");
    assert(anon.status === 401, "没登录也能问判断模型，登录闸漏了这一扇门：" + anon.status);

    const reg = await req(port, "POST", "/api/auth/register", { username: "admin", password: "Str0ngPass!2345" });
    const cookie = (reg.setCookie || []).map((c) => c.split(";")[0]).join("; ");
    assert(cookie, "注册没拿到 cookie，后面都走不了：" + reg.status + " " + reg.body.slice(0, 160));

    // ② 一条渠道都没配：要说「还没配」+ 去哪儿配，而不是一个 500
    const st0 = await req(port, "GET", "/api/decide", null, cookie);
    assert(st0.status === 200, "状态卡本身不该报错：" + st0.status + " " + st0.body.slice(0, 160));
    assert(st0.json.ready === false, "一条渠道都没配，却说自己能用：" + st0.body.slice(0, 200));
    assert(/设置|Key|渠道/.test(st0.json.how || ""),
      "★说了「不能用」却没说下一步去哪儿点★ 这种提示等于没提示：" + JSON.stringify(st0.json).slice(0, 220));
    assert(Array.isArray(st0.json.kinds) && st0.json.kinds.includes("noul"),
      "状态卡没把三种问法带给界面，前端只能自己硬编一份：" + JSON.stringify(st0.json.kinds));

    // ③ 题目写错在本地就该拦住——这种错不值得花一趟往返去上游换一坨 zod 回来
    const bad = await req(port, "POST", "/api/decide",
      { state: 一段材料, questions: { a: { type: "yesno", instructions: "急不急" } } }, cookie);
    assert(bad.status === 400, "类型写错没被拦，等着上游报错：" + bad.status + " " + bad.body.slice(0, 200));
    assert(/noul/.test(bad.json.error || ""), "报错没说清能写哪几种：" + bad.body.slice(0, 200));

    // ④ 光有问题没有材料：上游会照答，答的是幻觉，所以这儿必须拦
    const noState = await req(port, "POST", "/api/decide", { questions: 一道题 }, cookie);
    assert(noState.status === 400, "没给材料也放行了：" + noState.status + " " + noState.body.slice(0, 200));

    // ⑤ ★题目和材料都对，但没配渠道★ 这时候最容易出的坏事是「回一个看起来像答案的答案」
    const notReady = await req(port, "POST", "/api/decide", { state: 一段材料, questions: 一道题 }, cookie);
    assert(notReady.status === 503, "没配渠道却不是 503：" + notReady.status + " " + notReady.body.slice(0, 200));
    assert(!notReady.json.answers || !notReady.json.answers.length,
      "★没配渠道却端出了答案★ 判断模型最不能干的事就是在没问到人的时候编一个：" + notReady.body.slice(0, 200));

    // ---- 加一条渠道，地址故意指到一个一定连不上的本地端口 ----
    const save = await req(port, "POST", "/api/settings", { providers: [
      { id: "gw", kind: "typesafe", name: "自建网关", base_url: "http://127.0.0.1:1/v1", api_key: "sk-fake-not-a-real-key" },
    ] }, cookie);
    assert(save.status === 200, "加渠道没成功，后面测不了：" + save.status + " " + save.body.slice(0, 200));

    // ⑥ 渠道里填的地址说得算。无视它照旧发去官方，等于把人家网关的 Key 送到了另一家门口
    const st1 = await req(port, "GET", "/api/decide", null, cookie);
    assert(st1.json.ready === true, "加了渠道还说不能用：" + st1.body.slice(0, 200));
    assert(String(st1.json.url || "").includes("127.0.0.1:1"),
      "★渠道里填的地址被无视了★ 这条最凶：Key 会发到用户没指过的那台机器上：" + JSON.stringify(st1.json).slice(0, 220));
    assert(!st1.body.includes("sk-fake-not-a-real-key"),
      "★状态卡把 Key 带出来了★ 这张卡会落到界面、日志和截图里：" + st1.body.slice(0, 200));

    // ⑦ 连不上就说连不上，别把「没问到」说成「答案是否」
    const dead = await req(port, "POST", "/api/decide", { state: 一段材料, questions: 一道题 }, cookie);
    assert(dead.status >= 500, "上游连不上却回了 2xx：" + dead.status + " " + dead.body.slice(0, 200));
    assert(!dead.json.answers || !dead.json.answers.length, "连不上还端出答案：" + dead.body.slice(0, 200));
    assert(/连不上|超时|ECONN/.test(dead.json.error || ""), "错话里看不出是网络的事：" + dead.body.slice(0, 200));

    // ⑧ 设置页那个「测一下」：判断模型没有 /chat/completions，拿它去 ping 只会换回一个必然的 400
    const probe = await req(port, "POST", "/api/provider-test",
      { id: "gw", kind: "typesafe", base_url: "http://127.0.0.1:1/v1", api_key: "sk-fake-not-a-real-key" }, cookie);
    assert(probe.status === 200 && probe.json.ok === false, "测活接口本身不该崩：" + probe.status + " " + probe.body.slice(0, 200));
    assert(!/chat\/completions|不支持|404/.test(probe.json.error || ""),
      "★测活还在拿对话接口 ping 判断模型★ 这条渠道会永远显示「不通」，而它其实是好的：" + probe.body.slice(0, 200));
  } finally {
    try { booted.child.kill(); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
  console.log("✓ 判断模型 Jev：没登录问不了 · 没配就说没配（不编答案）· 题目先在本地查 · 渠道里填的地址说了算 · 测活不拿对话接口去 ping");
}

async function testConfigExternalEdit() {
  const os = require("os");
  const http = require("http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cfg-"));
  const CFG = path.join(home, "config.json");

  const req = (port, method, p, body, cookie) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      ...(cookie ? { cookie } : {}),
    } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b, setCookie: res.headers["set-cookie"] }));
    });
    r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_DATA_DIR: path.join(home, "data") });
  try {
    const { up, port, why } = await booted.wait();
    assert(up, "服务端没起来，这条测不了：" + why);

    // 头一个注册的是平台管理员，才有资格改服务器级设置（也就是才能触发存盘）
    const reg = await req(port, "POST", "/api/auth/register", { username: "admin", password: "Str0ngPass!2345" });
    const cookie = (reg.setCookie || []).map((c) => c.split(";")[0]).join("; ");
    assert(cookie, "注册没拿到 cookie，登录闸后面的接口都走不了：" + reg.status + " " + reg.body.slice(0, 120));

    // ---- 现场还原那条抱怨：在编辑器里粘一个 API Key 进去，再手加一整块 ----
    const before = JSON.parse(fs.readFileSync(CFG, "utf8"));
    before.models = before.models && before.models.length ? before.models : [{ name: "m1" }];
    before.models[0].api_key = "sk-在编辑器里粘进去的";
    before.mcp_servers = [{ name: "手加的连接器", command: "npx" }];
    fs.writeFileSync(CFG, JSON.stringify(before, null, 2));

    // ---- 然后回到界面上点一下（任何一处服务器级设置都会触发整份存盘）----
    const sm = await req(port, "POST", "/api/security/mode", { mode: "auto" }, cookie);
    assert(sm.status === 200, "改权限档没成功，后面无从谈起：" + sm.status + " " + sm.body.slice(0, 120));

    const after = JSON.parse(fs.readFileSync(CFG, "utf8"));
    assert(after.models && after.models[0] && after.models[0].api_key === "sk-在编辑器里粘进去的",
           "手粘的 API Key 被界面那次保存盖掉了——这正是用户报的那条：填了 Key，点一下保存，Key 没了");
    assert(Array.isArray(after.mcp_servers) && after.mcp_servers[0] && after.mcp_servers[0].name === "手加的连接器",
           "手加的整块也被盖掉了（config.json 是明确让人手改的文件）");
    assert(after.security && after.security.permission_mode === "auto",
           "界面上那次改动没落盘——只保命不保存等于保存按钮坏了");
    assert(/config\.json 在外面被改过/.test(booted.log),
           "合并这件事没在日志里留一句话，用户不知道自己手改的和界面改的怎么凑到一起的");

    // ★反向对照★：外面没人动的时候，不许报「被改过」，该改的照样改，手改的照样在
    const mark = booted.log.length;
    const sm2 = await req(port, "POST", "/api/security/mode", { mode: "ask" }, cookie);
    assert(sm2.status === 200, "第二次改权限档没成功：" + sm2.status);
    const after2 = JSON.parse(fs.readFileSync(CFG, "utf8"));
    assert(!/在外面被改过/.test(booted.log.slice(mark)),
           "反向对照：没人在外面改的时候也喊「被改过」，说明它是见存盘就喊，那句话就不可信了");
    assert(after2.security.permission_mode === "ask", "第二次的改动也得落盘");
    assert(after2.models[0].api_key === "sk-在编辑器里粘进去的", "手粘的 Key 在第二次存盘之后仍旧在");
  } finally {
    booted.child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("✅ 手改 config.json 不再被界面存盘盖掉：粘的 Key 和手加的整块都在 · 界面那次改动照样落盘 · 日志说清了合并（负对照：没外改时不喊合并）");
}

/**
 * Key 这一路的四道闸。
 *
 * config.json 是全机器上唯一一份明文装着所有 API Key 的文件，可它一直是 umask 给的 0644——
 * 同一台 VPS、同一台办公电脑上的任何一个别的账号，一句 cat 就端走九把 Key。
 * 而更隐蔽的是环境变量那条：`OPENAI_API_KEY` 几乎人人都在 ~/.zshrc 里写死，
 * 初始 config.json 里又预置着四条**空着 Key**的别家渠道（通义/智谱/Kimi/Ollama），
 * 老代码一句 `cfg.api_key || process.env.OPENAI_API_KEY` 就把你的 OpenAI Key
 * 带着 Authorization 头发给了 api.moonshot.cn。
 *
 * 所以这四段全是**行为实测**，不看源码：起真的 server.js 看磁盘上的位，
 * 起真的 http 监听器把 Authorization 头原样抓下来。
 */
async function testKeyGuard() {
  const os = require("os");
  const http = require("http");
  const store = require("../store");
  const llm = require("../llm");
  const { resolveKey, channelEnvName, warnedEnvSkip } = llm._internals;

  // ---------- ① 落盘的位：0600，不是 0644 ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-key-"));
  const modeOf = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  try {
    const f1 = path.join(dir, "secret.json");
    // 先按老样子落一份 0644 的，冒充「装了半年的老机器」
    fs.writeFileSync(f1, "{}", "utf8");
    fs.chmodSync(f1, 0o644);
    store.writeJsonAtomic(f1, { api_key: "sk-1" }, { pretty: true, mode: store.SECRET_MODE });
    assert(modeOf(f1) === "600", "装着 Key 的文件存完还是 " + modeOf(f1) + "，同机器上别的账号照样 cat 得到");
    store.writeJsonAtomic(f1, { api_key: "sk-2" }, { pretty: true, mode: store.SECRET_MODE });
    assert(fs.existsSync(f1 + ".bak"), "第二次存该留下 .bak");
    assert(modeOf(f1 + ".bak") === "600",
           ".bak 跟正本一字不差，权限却是 " + modeOf(f1 + ".bak") + "——收紧正本却漏掉副本，等于没收");
    // 负向对照：不传 mode 的流水账文件不该被连坐收紧（几千条一天写几百次，收紧纯属添乱）
    const f2 = path.join(dir, "ledger.json");
    store.writeJsonAtomic(f2, [1, 2, 3]);
    assert(modeOf(f2) !== "600", "没点名要收紧的文件也被收成 600 了，说明 mode 根本没在起作用（对照失效）");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- ② Key 不许串门 ----------
  // 起一个本地监听器冒充别家（moonshot / 智谱 都行），把 Authorization 头原样抓回来
  const grab = (cfg) => new Promise((resolve) => {
    let seen = "(没到达)";
    const srv = http.createServer((req, res) => {
      seen = req.headers.authorization || "(没有 Authorization 头)";
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }));
    });
    srv.listen(0, "127.0.0.1", async () => {
      const port = srv.address().port;
      try {
        await llm._internals.openaiChat({ ...cfg, base_url: `http://127.0.0.1:${port}/v1`, stream: false },
                                        { system: "hi", history: [{ role: "user", content: "hi" }] });
      } catch (e) {
        // 吞掉异常的话，"根本没发出去"和"发出去了但没带 Authorization" 在断言里长得一模一样。
        // 这次排查就卡在这儿：真凶是 fetch 在发出去之前抛的 ByteString，报出来的却是「没到达」
        if (seen === "(没到达)") seen = "(没发出去：" + (e && e.message) + ")";
      }
      srv.close(() => resolve(seen));
    });
  });

  const savedEnv = { o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY, c: process.env.OPENWORKBUDDY_KEY_KIMI };
  try {
    process.env.OPENAI_API_KEY = "sk-这是我的-OPENAI-KEY";
    // 冒充「Kimi」那条预置渠道：地址是别家的、Key 空着——这就是初始 config.json 的默认状态。
    // hostOf 看的是 base_url，grab 把它换成本机口，所以这里单独用 resolveKey 判域名那一层
    const kimi = { name: "Kimi", channel: "kimi", api_key: "", base_url: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k" };
    assert(resolveKey(kimi, "openai") === "",
           "OPENAI_API_KEY 被发给了 api.moonshot.cn——这把 Key 是 OpenAI 的，别家拿到就是泄露");
    // 同一把环境变量，地址换成 OpenAI 自己家：该用就得用，不能因噎废食
    assert(resolveKey({ ...kimi, name: "OpenAI", channel: "openai", base_url: "https://api.openai.com/v1" }, "openai") === "sk-这是我的-OPENAI-KEY",
           "地址就是 OpenAI 官方，OPENAI_API_KEY 反倒不认了——Docker 里靠环境变量注入的人全得改配置");
    // 按渠道点名的环境变量：用户自己指的，什么地址都认
    process.env.OPENWORKBUDDY_KEY_KIMI = "sk-点名给-kimi-的";
    assert(resolveKey(kimi, "openai") === "sk-点名给-kimi-的",
           "OPENWORKBUDDY_KEY_<渠道id> 不生效，等于逼着 Docker/VPS 用户把明文 Key 写进 config.json");
    assert(channelEnvName("openrouter-2") === "OPENWORKBUDDY_KEY_OPENROUTER_2", "渠道 id 换算成环境变量名的规则不对");
    delete process.env.OPENWORKBUDDY_KEY_KIMI;
    // 渠道自己填了 Key 就以它为准，环境变量插不了队
    assert(resolveKey({ ...kimi, api_key: "sk-渠道自己填的" }, "openai") === "sk-渠道自己填的",
           "渠道上填了 Key 还被环境变量压过去了，用户在界面上改什么都不生效");
    // Anthropic 那一路同理
    process.env.ANTHROPIC_API_KEY = "sk-ant-我的";
    assert(resolveKey({ name: "中转", api_key: "", base_url: "https://someproxy.example.com" }, "anthropic") === "",
           "ANTHROPIC_API_KEY 被发给了第三方中转");
    assert(resolveKey({ name: "官方", api_key: "", base_url: "" }, "anthropic") === "sk-ant-我的",
           "没填地址 = 走 Anthropic 官方，这时候该认环境变量");
    // 本机地址不唠叨：绝大多数是 Ollama，它压根不要 Key
    warnedEnvSkip.clear();
    resolveKey({ name: "Ollama本地", api_key: "", base_url: "http://localhost:11434/v1" }, "openai");
    assert(warnedEnvSkip.size === 0, "本机 Ollama 也警告，等于每个本地用户开机都被刷一条看不懂的话");

    // 真发一趟，看线上收到的到底是什么（上面判的是取值，这里判的是**发出去的头**）。
    // 注意这儿的假 Key 必须是纯 ASCII：HTTP 头只装得下单字节字符，中文 Key 会让 fetch
    // 在请求发出去之前就抛——上面那些断言不过网，写中文只是为了好读，这条不行
    delete process.env.OPENAI_API_KEY;
    const got = await grab({ name: "某家", api_key: "sk-chan-own-key-7788", model: "m" });
    assert(got === "Bearer sk-chan-own-key-7788", "渠道自己填的 Key 没发出去，收到的是：" + got);

    // 前后的空白是复制残渣（网页上框 Key 很容易带上换行和零宽空格），自己吃掉，别让用户猜
    const trimmed = await grab({ name: "某家", api_key: " \u200bsk-pasted-with-junk\n", model: "m" });
    assert(trimmed === "Bearer sk-pasted-with-junk",
           "Key 前后的空白/零宽字符没清掉，粘贴带上换行就整条渠道不能用了，收到的是：" + JSON.stringify(trimmed));

    // 中间混进中文/全角就是真填错了：得说清是 Key 的事、是第几个字符，
    // 而不是把 undici 那句 "Cannot convert argument to a ByteString…" 原样甩给用户
    let keyErr = "(没抛)";
    try {
      llm._internals.headerKey({ name: "某家", api_key: "sk-渠道自己填的" }, "openai");
    } catch (e) { keyErr = e.message; }
    assert(/Key/.test(keyErr) && /第 4 个字符/.test(keyErr) && /设置/.test(keyErr),
           "Key 里混了中文，报错没说清是哪儿错、该去哪改，用户只会看到一次没头没尾的调用失败：" + keyErr);
    assert(!/ByteString/.test(keyErr), "把 undici 的内部报错原样透出去了：" + keyErr);
  } finally {
    if (savedEnv.o === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedEnv.o;
    if (savedEnv.a === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedEnv.a;
    if (savedEnv.c === undefined) delete process.env.OPENWORKBUDDY_KEY_KIMI; else process.env.OPENWORKBUDDY_KEY_KIMI = savedEnv.c;
  }

  // ---------- ③ 撞 401 说人话，跟「测一下」按钮一个口径 ----------
  const say401 = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } }));
    });
    srv.listen(0, "127.0.0.1", async () => {
      const port = srv.address().port;
      let msg = "(没报错)";
      try {
        await llm._internals.openaiChat(
          // Key 得是纯 ASCII：这一条验的是**上游回 401 之后**怎么说话，
          // 写成中文的话请求根本发不出去（HTTP 头只装得下单字节字符），验的就变成另一件事了
          { name: "我的 DeepSeek", api_key: "sk-wrong-on-purpose", base_url: `http://127.0.0.1:${port}/v1`, model: "deepseek-chat", stream: false },
          { system: "hi", history: [{ role: "user", content: "hi" }] });
      } catch (e) { msg = e.message; }
      srv.close(() => resolve(msg));
    });
  });
  assert(/Key 上游不认/.test(say401) && /我的 DeepSeek/.test(say401),
         "真跑一趟撞 401，吐的还是英文原文——「测一下」按钮早就翻成人话了，两边对不上：" + say401.slice(0, 160));
  assert(/设置 → 模型/.test(say401), "报错里得给出下一步去哪儿改，光说「不认」用户只能干瞪眼");

  // ---------- ④ 换 Key 留痕，且流水里是掩码不是明文 ----------
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-keyaudit-"));
  const req2 = (port, method, p, body, cookie) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
      ...(cookie ? { cookie } : {}),
    } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b, setCookie: res.headers["set-cookie"] }));
    });
    r.on("error", (e) => resolve({ status: 0, body: String(e.message) }));
    if (data) r.write(data);
    r.end();
  });
  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home, OPENWORKBUDDY_DATA_DIR: path.join(home, "data") });
  try {
    const { up, port, why } = await booted.wait();
    assert(up, "服务端没起来，这条测不了：" + why);
    const CFG = path.join(home, "config.json");
    assert(modeOf(CFG) === "600",
           "开机没把已存在的 config.json 收紧，还是 " + modeOf(CFG) + "——装了半年的老机器永远修不好");

    const reg = await req2(port, "POST", "/api/auth/register", { username: "admin", password: "Str0ngPass!2345" });
    const cookie = (reg.setCookie || []).map((c) => c.split(";")[0]).join("; ");
    assert(cookie, "注册没拿到 cookie：" + reg.status + " " + reg.body.slice(0, 120));

    const KEY = "sk-abcdefghijklmnop-7788";
    const put = await req2(port, "POST", "/api/settings",
      { providers: [{ id: "deepseek", name: "DeepSeek", kind: "deepseek", base_url: "https://api.deepseek.com/v1", api_key: KEY }] }, cookie);
    assert(put.status === 200, "存渠道没成功：" + put.status + " " + put.body.slice(0, 160));
    assert(modeOf(CFG) === "600", "存完设置之后 config.json 变回 " + modeOf(CFG) + " 了");

    const au = await req2(port, "GET", "/api/admin/audit", null, cookie);
    assert(au.status === 200, "审计流水读不到：" + au.status + " " + au.body.slice(0, 160));
    assert(/更换模型 Key/.test(au.body),
           "换了那把全组织都在用的 Key，审计流水里一个字都没有——多管理员的组织事后根本查不出是谁改的");
    assert(!au.body.includes(KEY),
           "审计流水里出现了 Key 明文！审计表管理员和审计员都看得到，这等于给 Key 开了第二个出口");
    // 掩码是「前三位…末四位」。真实 Key 的前三位几乎都是 sk-，认不出是哪一把，
    // 真正认人的是末四位——所以这儿钉的是末四位那截，以及前面那截不许多给
    assert(/sk-…7788/.test(au.body), "留痕得能认出是哪一把（前三位…末四位），不然写了等于没写：" + au.body.slice(0, 200));
    assert(!/efghij/.test(au.body), "掩码给多了：中间那段是 Key 的正身，露出来就等于半个明文");
  } finally {
    booted.child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log("✅ Key 这一路：落盘 0600（.bak 同待遇·老机器开机就修好·流水账不连坐）· 环境变量不串门（官方域名照认·OPENWORKBUDDY_KEY_<渠道> 点名生效·本机不唠叨）· 撞 401 跟「测一下」一个口径 · 换 Key 进审计且只留掩码");
}

async function testPortCollision() {
  const os = require("os");
  const net = require("net");
  const http = require("http");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-port-"));

  // 占座的：listen(0) 拿一个真实存在、此刻确实被占着的端口
  const squat = (handler) => new Promise((resolve) => {
    const srv = handler ? http.createServer(handler) : net.createServer(() => {});
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
  const info = (body) => (req, res) => {
    if (req.url.startsWith("/api/ping")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); return; }
    res.statusCode = 404; res.end("nope");
  };
  const getJson = (port, p) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.end();
  });

  // ---- ① 坐着的是别的程序：必须挪窝，而且挪过去的那个口上真的是我们 ----
  {
    const { srv, port } = await squat(info({ app: "some-dashboard", version: "9.9" }));
    const booted = bootRealServer({ OPENWORKBUDDY_HOME: home }, { port });
    try {
      const { up, port: bound, why } = await booted.wait();
      assert(up, "端口被陌生程序占着，真 server.js 没起来（老写法就是在这儿把窗口指给人家的）：" + why);
      assert(bound !== port, `服务端居然报自己绑在 ${bound} —— 那个口上坐着的是别人`);
      assert(/被别的程序占着/.test(booted.log), "换口这件事没在日志里留一句话，用户只会觉得端口莫名其妙变了");
      const j = await getJson(bound, "/api/ping");
      assert(j && j.app === "openworkbuddy", "换过去的那个口上应答的不是 OpenWorkBuddy：" + JSON.stringify(j));
      assert(j.version, "/api/ping 没带版本号，报 issue 的人说不清自己装的是哪一版");
      // ★这条是握手能成立的前提★：对面很可能一个人都没登录过，签名必须在登录闸外面拿得到。
      // 它要是回 401，壳就会把另一台 OpenWorkBuddy 当成陌生程序，转头又起一台。
      const guarded = await getJson(bound, "/api/info");
      assert(guarded && guarded.error, "反向对照：/api/info 本来就该要登录，它要是也敞着，说明整个 /api 的闸开了口子");
      // 占座的还在原地：证明我们是绕开它，不是把它挤掉了
      const still = await getJson(port, "/api/ping");
      assert(still && still.app === "some-dashboard", "原来占着口的程序被挤掉了，这是在抢别人的端口");
    } finally {
      booted.child.kill();
      srv.close();
    }
  }

  // ---- ② 负对照：坐着的是另一台 OpenWorkBuddy，就不许再起一台 ----
  // 这条要是也「换个口起来了」，上面那条就等于没测——那只能说明它见占就换，而不是认签名。
  {
    const { srv, port } = await squat(info({ app: "openworkbuddy", version: "0.0.0-fake" }));
    const booted = bootRealServer({ OPENWORKBUDDY_HOME: home }, { port, timeoutMs: 30000 });
    try {
      const { up } = await booted.wait();
      assert(!up, "口上已经有一台 OpenWorkBuddy 了，这个进程还是自己又起了一台（两台共用一份数据目录，迟早互相写坏）");
      assert(/已经有一台 OpenWorkBuddy 在跑/.test(booted.log), "没告诉用户这口上是谁：" + JSON.stringify(booted.log.slice(-300)));
      assert(new RegExp("http://localhost:" + port).test(booted.log), "没把「直接用它」的地址给出来，用户只知道自己失败了");
      const code = await new Promise((r) => booted.child.exitCode !== null ? r(booted.child.exitCode) : booted.child.once("exit", (c) => r(c)));
      assert(code === 1, `命令行下该退出码 1，实际 ${code}（老写法是进程活着、什么都不干，一直挂在那儿）`);
    } finally {
      booted.child.kill();
      srv.close();
    }
  }

  // ---- ③ 占着口又一声不吭：不许卡死在握手上 ----
  {
    const { srv, port } = await squat(null); // 纯 TCP，连上就晾着
    const t0 = Date.now();
    const booted = bootRealServer({ OPENWORKBUDDY_HOME: home }, { port });
    try {
      const { up, port: bound, why } = await booted.wait();
      assert(up, "占口的程序不应答 HTTP，启动就卡死了：" + why);
      assert(bound !== port, `不应答的口也得让开，实际报的还是 ${bound}`);
      assert(Date.now() - t0 < 25000, `握手超时没兜住，等了 ${Date.now() - t0}ms（默认 1.5 秒就该放弃）`);
    } finally {
      booted.child.kill();
      srv.close();
    }
  }

  // ---- ④ 签名这件事必须只在一个地方写死：壳判断「是不是自己人」靠的就是它 ----
  const srvSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert(/app: "openworkbuddy"/.test(srvSrc), "没有身份签名，壳就没法区分自己人和陌生人");
  assert(/"\/api\/ping"/.test(fs.readFileSync(path.join(__dirname, "..", "account.js"), "utf8")),
         "/api/ping 没在登录闸的放行名单里，没登录的实例会回 401，握手就废了");
  assert(/global\.__wbOnListen/.test(srvSrc), "服务端没把真正绑上的端口交给壳");
  const shellSrc = fs.readFileSync(path.join(__dirname, "..", "electron-main.js"), "utf8");
  assert(/__wbOnListen/.test(shellSrc), "壳没在等服务端报端口，还在用自己算出来的那个（换了口就连不上）");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("✅ 端口被占的三条岔路：陌生程序占着就换口（换过去的确实是我们，也没挤掉人家）· 另一台 OWB 占着就不重复起并退出码 1（负对照）· 占着不吭声也不卡死");
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


/**
 * 备份的一整趟来回：打包 → 下载 → 换台机器传回去 → 恢复。
 *
 * 为什么现在才补：在「导入」这一头做出来之前，restore 解的每一个包都是本机自己 makeBackup()
 * 打的，怎么解都安全，也就没什么可测。现在包可能是从别的机器、别人手里来的，
 * 而 restore 那一步是实打实的 `tar -xzf 包 -C DATA_DIR`——包里塞一个 /etc/... 或者
 * 一个 data/x -> ~/.ssh 的软链接，就能写到数据目录外面去。
 * 所以这条测试的重头不在「传得上去」，在下面那几个必须被拒的形状。
 */
/**
 * 文件检查点从工具一路通到审批卡：write_file / edit_file 落盘前留底、结果里带 diff 和检查点 id、
 * 「每步都问」档位下审批条上就有那几行 diff（批的是改动，不是文件名）、
 * 回退能退到「新建之前」把文件删掉。纯函数那半在 test/checkpoints.js，这里钉的是**接线**。
 */
async function testCheckpoints() {
  const tools = require("../tools");
  const security = require("../security");
  const ck = require("../checkpoints");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ckw-"));
  const sid = "sess_ck_" + Date.now().toString(36);
  const ask = { ...security.DEFAULTS, permission_mode: "ask" };
  let calls = 0;
  const run = (name, input, sec) => tools.withWorkspace(tmp, () =>
    tools.executeTool(name, input, { security: sec || { ...security.DEFAULTS }, sessionId: sid, callId: "c" + (++calls) })
  );
  // 等审批条上出现这一条，拿到它再放行；等不到就是接线断了
  const approve = async (pred) => {
    for (let i = 0; i < 100; i++) {
      const hit = security.listApprovals().find(pred);
      if (hit) { security.resolveApproval(hit.id, true, "once"); return hit; }
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };

  // ① 新建：结果带 diff（新文件 hunk 是 -0,0）和检查点
  const w = await run("write_file", { path: "笔记.md", content: "一\n二\n三\n" });
  assert.strictEqual(w.isError, false, "write_file 失败：" + w.content);
  assert.ok(String(w.diff || "").includes("@@ -0,0 +1,3 @@") && w.diff.includes("+二"), "write_file 结果没带新建文件的 diff：" + w.diff);
  assert.ok(/^ck_/.test(String(w.ckpt || "")), "write_file 结果没带检查点 id");

  // ② 改：ask 档位下审批条上有 diff；放行后落盘，结果里 -二/+贰
  const pending = run("edit_file", { path: "笔记.md", old_text: "二", new_text: "贰" }, ask);
  const hit = await approve((a) => a.ruleKey === "write:*" && /笔记\.md/.test(a.text));
  assert.ok(hit, "ask 档位下 edit_file 没上审批条");
  assert.ok(hit.detail.includes("-二") && hit.detail.includes("+贰"), "审批条上没有改前 diff：" + JSON.stringify(hit.detail));
  const ed = await pending;
  assert.strictEqual(ed.isError, false, "edit_file 失败：" + ed.content);
  assert.ok(ed.diff.includes("-二\n+贰"), "edit_file 结果没带 diff：" + ed.diff);
  assert.strictEqual(fs.readFileSync(path.join(tmp, "笔记.md"), "utf8"), "一\n贰\n三\n");

  // ③ 内容没变的 edit 不留底、不带 diff
  const same = await run("edit_file", { path: "笔记.md", old_text: "贰", new_text: "贰" });
  assert.strictEqual(same.isError, false);
  assert.ok(!same.ckpt && !same.diff, "没改动也留了底：" + JSON.stringify(same));

  // ④ 列表两条；退到第 2 步之前 = 回 v1；退到第 1 步之前 = 文件删掉
  const rows = ck.list(tmp, sid);
  assert.strictEqual(rows.length, 2, "检查点应有 2 条，实际 " + rows.length);
  assert.strictEqual(rows[1].tool, "edit_file");
  const r2 = ck.rewind(tmp, sid, rows[1].id);
  assert.ok(r2.ok, "回退失败：" + r2.error);
  assert.strictEqual(fs.readFileSync(path.join(tmp, "笔记.md"), "utf8"), "一\n二\n三\n", "没退回改前");
  const r1 = ck.rewind(tmp, sid, rows[0].id);
  assert.ok(r1.ok && !fs.existsSync(path.join(tmp, "笔记.md")), "退到新建之前应把文件删掉");
  // 撤销：文件回到改完的样子
  const u = ck.rewind(tmp, sid, r1.undo);
  assert.ok(u.ok, "撤销回退失败：" + u.error);
  assert.strictEqual(fs.readFileSync(path.join(tmp, "笔记.md"), "utf8"), "一\n二\n三\n", "撤销回退没把文件找回来");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("✅ 文件检查点接线：write_file/edit_file 带 diff+检查点 / ask 档审批条上有 diff / 没改动不留底 / 退到新建之前删文件 / 撤销回退找回来");
}

async function testBackupRoundTrip() {
  const { execFileSync } = require("child_process");
  // 得显式 require：不写这行拿到的是全局那个 WebCrypto，只有 getRandomValues，
  // 没有 randomBytes，整条测试会以 "crypto.randomBytes is not a function" 当场炸
  const crypto = require("crypto");
  // http 同理：这个文件里每条要发请求的测试都在自己函数里 require 一次，模块顶上没有全局的那份
  const http = require("http");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-bk-"));
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ 标记: "旧机器上的配置" }));
  fs.writeFileSync(path.join(home, "schedules.json"), "[]");
  fs.writeFileSync(path.join(home, "data", "memory.md"), "旧机器上的记忆");
  // 自己写的技能（出厂列表里没有这个名字）要跟着走；出厂那份被改过也不跟着走，
  // 不然随包那几个技能加起来一百多兆，每备一次背一遍。
  // 这里的出厂样本必须挑 git 真跟踪的（ppt-design），不能拿 .gitignore 掉的那些：
  // 那些本机有、新 clone 没有，userSkillEntries() 在 CI 上会把它当用户自建的背进包
  const mine = path.join(home, "skills", "e2e-我自己写的");
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "skill.md"), "# 我自己写的");
  // prefs/ 在 data/ 外面，漏了它搬完家宠物、快捷指令、上次挑的模型全要重设
  fs.mkdirSync(path.join(home, "prefs"), { recursive: true });
  fs.writeFileSync(path.join(home, "prefs", "boss-abc123.json"), JSON.stringify({ pet: { on: true } }));
  fs.mkdirSync(path.join(home, "skills", "ppt-design"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", "ppt-design", "big.bin"), "出厂技能，新机器上本来就有");

  const token = "bk" + crypto.randomBytes(12).toString("hex");
  const plain = "bkp" + crypto.randomBytes(8).toString("hex");
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [
      { username: "boss", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() },
      { username: "clerk", salt: "x", hash: "x", role: "user", credits: 0, created_at: Date.now() },
    ],
    tokens: { [token]: { user: "boss", at: Date.now() }, [plain]: { user: "clerk", at: Date.now() } },
  }));

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const { up, port, why: bootWhy } = await booted.wait();

  // 回包可能是 JSON，也可能是备份文件本身（下载那一路），所以统一拿 Buffer 收
  const call = (method, p, { body, type, tok = token } = {}) => new Promise((resolve) => {
    const headers = { Cookie: "openworkbuddy_token=" + tok };
    if (type) headers["Content-Type"] = type;
    if (body != null) headers["Content-Length"] = Buffer.byteLength(body);
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch {}
        resolve({ code: res.statusCode, buf, json });
      });
    });
    req.on("error", (e) => resolve({ code: 0, buf: Buffer.alloc(0), json: { error: e.message } }));
    if (body != null) req.write(body);
    req.end();
  });
  const upload = (buf, tok) => call("POST", "/api/backup/upload", { body: buf, type: "application/gzip", tok });
  const names = async () => (((await call("GET", "/api/backup")).json || {}).list || []).map((b) => b.name);

  // 在 dir 里按 spec 打一份 tar.gz，返回它的字节
  const brew = (dir, args, cwd) => {
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, "x.tar.gz");
    execFileSync("tar", ["-czPf", out, ...args], { cwd: cwd || dir });
    return fs.readFileSync(out);
  };

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);

    // ① 打一份，下载下来——这就是「换电脑带走」的那个文件
    const made = (await call("POST", "/api/backup")).json;
    assert(made && made.ok && /^openworkbuddy-backup-[\w.-]+\.tar\.gz$/.test(made.name), "备份没打成：" + JSON.stringify(made));
    const dl = await call("GET", "/api/backup/download/" + encodeURIComponent(made.name));
    assert(dl.code === 200 && dl.buf[0] === 0x1f && dl.buf[1] === 0x8b, "下载回来的不是 gzip（HTTP " + dl.code + "）");

    // ①.5 包里该有什么：自己写的技能在，出厂技能不在，成果文件不在
    const probe = path.join(home, "probe.tar.gz");
    fs.writeFileSync(probe, dl.buf);
    const inside = execFileSync("tar", ["-tzf", probe], { encoding: "utf8" }).split("\n");
    const has = (re) => inside.some((n) => re.test(n));
    assert(has(/^skills\/e2e-我自己写的\/skill\.md$/), "自己写的技能没进备份，搬完家就没了：" + JSON.stringify(inside.slice(0, 20)));
    assert(!has(/^skills\/ppt-design\//), "出厂技能被背进了备份——随包那几个加起来一百多兆，备份会大到没人敢点");
    assert(has(/^data\/memory\.md$/) && has(/^config\.json$/), "备份没覆盖 data/ 和 config.json");
    assert(has(/^prefs\/boss-abc123\.json$/), "个人偏好没进备份，搬完家宠物和快捷指令要重设一遍");
    assert(!has(/^workspace\//), "成果文件不该进备份");

    // ② 传回去：这就是新机器上那一步。以前没有这个接口，包到了新机器就没有下文
    const before = (await names()).length;
    const got = await upload(dl.buf);
    assert(got.code === 200 && got.json.ok, "备份传不回去：" + JSON.stringify(got.json));
    assert(/-imported(-\d+)?\.tar\.gz$/.test(got.json.name), "导入的包名字上要看得出是外来的：" + got.json.name);
    assert(got.json.entries > 0, "导入应报出包里有多少条目");
    assert((await names()).includes(got.json.name), "导入完列表里得有它，不然用户没法点恢复");
    assert((await names()).length === before + 1, "导入应当只多出一份");

    // ③ 同一秒内连导两份不能互相盖掉（名字里的时间戳只到秒）
    const again = await upload(dl.buf);
    assert(again.code === 200 && again.json.name !== got.json.name, "同一秒导入第二份把第一份盖了：" + again.json.name);

    // ④ 恢复一次：验这条路真能走通（tar 也得认 --no-same-owner 这个参数）
    const rs = await call("POST", "/api/backup/restore", { body: JSON.stringify({ name: got.json.name }), type: "application/json" });
    assert(rs.code === 200 && rs.json.ok && rs.json.safety, "从导入的包恢复失败：" + JSON.stringify(rs.json));
    assert(fs.readFileSync(path.join(home, "data", "memory.md"), "utf8") === "旧机器上的记忆", "恢复后数据没落到盘上");
    assert(fs.readFileSync(path.join(mine, "skill.md"), "utf8") === "# 我自己写的", "恢复后自己写的技能没落到盘上");

    // ⑤ 该拒的几种形状。每一种都得原地拒掉，且不能在 backups/ 里留下任何痕迹
    const n0 = (await names()).length;
    const evil = path.join(home, "evil");
    const zipMagic = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("我是个 zip")]);
    const bad = [
      ["空 body", Buffer.alloc(0), /没收到文件/],
      ["不是 gzip", zipMagic, /不是 .tar.gz/],
      ["半截 gzip", Buffer.concat([Buffer.from([0x1f, 0x8b]), crypto.randomBytes(200)]), /打不开|不是完整/],
    ];
    // 绝对路径：解出来会写到 DATA_DIR 外面
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, "probe.txt"), "x");
    bad.push(["绝对路径", brew(path.join(evil, "abs"), [path.join(evil, "probe.txt")]), /绝对路径/]);
    // ../ 跳出去：同上，换个写法
    const dd = path.join(evil, "dd");
    fs.mkdirSync(path.join(dd, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dd, "out.txt"), "x");
    bad.push(["../ 跳出目录", brew(dd, ["../out.txt"], path.join(dd, "sub")), /跳出目录/]);
    // 软链接：先塞一个 data/key -> 别人的私钥，后面往它里头写就落到链接指的地方
    const sym = path.join(evil, "sym");
    fs.mkdirSync(path.join(sym, "data"), { recursive: true });
    fs.symlinkSync("/etc/passwd", path.join(sym, "data", "key"));
    bad.push(["软链接", brew(sym, ["data"]), /链接文件/]);
    // 形状不对：顶层不是 data/ 和那三个 json，根本不是这套系统的备份
    const oos = path.join(evil, "oos");
    fs.mkdirSync(path.join(oos, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(oos, "workspace", "x.txt"), "x");
    bad.push(["不属于备份范围", brew(oos, ["workspace"]), /不属于备份范围/]);

    for (const [what, buf, re] of bad) {
      const r = await upload(buf);
      assert(r.code === 400, `「${what}」的包居然收下了（HTTP ${r.code}）——它是要拿 tar 解到数据目录上的`);
      assert(re.test(String(r.json && r.json.error)), `「${what}」的拒绝理由看不出是怎么回事：${JSON.stringify(r.json)}`);
    }
    assert((await names()).length === n0, "被拒的包在 backups/ 里留了尸体");
    assert(!fs.readdirSync(path.join(home, "backups")).some((f) => f.startsWith(".incoming-")), "验不过的临时文件没删干净");

    // ⑥ 备份里有 config.json（API Key）和全部账号——普通成员碰不得
    const denied = await upload(dl.buf, plain);
    assert(denied.code === 403, `普通成员能往备份里塞东西（HTTP ${denied.code}）`);
    const deniedList = await call("GET", "/api/backup", { tok: plain });
    assert(deniedList.code === 403, "普通成员能看备份列表");
  } finally {
    booted.child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("✅ 备份来回：打包→下载→传回新机器→恢复走得通，绝对路径/../、软链接、形状不对的包一律原地拒且不留尸体");
}

/**
 * thumb-png.js —— 纯 node 那条缩图路，**不用任何依赖**，只靠 zlib。
 *
 * 为什么要自己写一个 PNG 解码器：桌面版有 Electron 的 nativeImage，可 `npm start`
 * 是纯 node，国央企内网、私有化部署那台服务器上连 electron 都没装（它只在
 * devDependencies 里）。而 sharp / jimp 装不进去——那边下不动 npm，也编不了原生模块。
 * 用户那句「这个网页版感觉很卡」说的正是这一边。
 *
 * 自己写解码器最怕的就是**悄悄解错**：不报错，图也出得来，只是颜色错位、整片糊掉。
 * 所以这条测试不看「有没有返回 Buffer」，看**像素**：
 *   ① 左红右蓝下绿的图，缩完还得是左红右蓝下绿（行错位、通道错位一律现形）
 *   ② 同一张图用五种 filter 分别编码，缩出来必须**一个字节都不差**
 *      —— Sub/Up/Average/Paeth 四条解滤波的逆运算里错一个，这条立刻红
 *   ③ 五种色型（灰/RGB/调色板/灰+A/RGBA）、8 位和 16 位都要认
 *   ④ 认不了的一律返回 null（调用方原样发原图），而不是抛、也不是吐一张坏图
 *
 * 出图用测试自己写的编码器，读图也用测试自己写的解码器（只认 filter 0，
 * 而 thumb-png 出的图正好每行都是 filter 0）——两头都不借被测代码，免得自己判自己的卷子。
 */
function testThumbPng() {
  const zlib = require("zlib");
  const { shrinkPng, pngInfo, crc32 } = require("../thumb-png");
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };

  /** 按 PNG 规范编一张图。filter 那一段是规范里的正向公式，跟 thumb-png 的逆运算各写各的 */
  function enc(w, h, color, depth, pixel, opts = {}) {
    const step = depth === 16 ? 2 : 1;
    const bpp = CH[color] * step;
    const stride = w * bpp;
    const rows = [];
    for (let y = 0; y < h; y++) {
      const row = Buffer.alloc(stride);
      for (let x = 0; x < w; x++) {
        const v = pixel(x, y);                       // 每通道一个 0..255
        for (let c = 0; c < CH[color]; c++) {
          if (step === 2) { row[x * bpp + c * 2] = v[c]; row[x * bpp + c * 2 + 1] = v[c]; }
          else row[x * bpp + c] = v[c];
        }
      }
      rows.push(row);
    }
    const f = opts.filter || 0;
    const paeth = (a, b, c) => {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      // pa <= pb 里的等号看着像个可以随便改的细节，其实改不动：pa == pb 只在 a == b 时
      // 才可能同时满足 pa <= pc（枚举过全部 256³ 组，65536 组平局全是 a == b），
      // 两种写法输出完全一致。变异测试在这儿会留一个"漏网"，那是等价变异，不是测试的洞
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const lines = Buffer.alloc(h * (stride + 1));
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
      const base = y * (stride + 1);
      lines[base] = f;
      const cur = rows[y];
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;       // 左
        const b = prev[i];                           // 上
        const c = i >= bpp ? prev[i - bpp] : 0;      // 左上
        const sub = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0;
        lines[base + 1 + i] = (cur[i] - sub) & 255;
      }
      prev = cur;
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(opts.claimHeight || h, 4);   // 头里写多少行，跟真写了多少行可以不一样
    ihdr[8] = depth;
    ihdr[9] = color;
    ihdr[12] = opts.interlace || 0;
    const tail = [chunk("IHDR", ihdr)];
    if (opts.plte) tail.push(chunk("PLTE", opts.plte));
    if (opts.trns) tail.push(chunk("tRNS", opts.trns));
    tail.push(chunk("IDAT", zlib.deflateSync(lines)), chunk("IEND", Buffer.alloc(0)));
    return Buffer.concat([SIG, ...tail]);
  }

  /** 读一张 thumb-png 出的图。它每行都是 filter 0，所以这儿只需要认 filter 0 */
  function dec(buf) {
    const info = pngInfo(buf);
    assert(info, "出来的东西根本不是 PNG");
    const idat = [];
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const ch = CH[info.color];
    const stride = info.width * ch;
    for (let y = 0; y < info.height; y++) {
      assert(raw[y * (stride + 1)] === 0, "第 " + y + " 行不是 filter 0，thumb-png 编码那头变了，这个解码器跟不上");
    }
    return {
      ...info,
      px(x, y) {
        const i = y * (stride + 1) + 1 + x * ch;
        if (ch === 3) return [raw[i], raw[i + 1], raw[i + 2], 255];
        if (ch === 4) return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
        if (ch === 2) return [raw[i], raw[i], raw[i], raw[i + 1]];
        return [raw[i], raw[i], raw[i], 255];
      },
    };
  }
  const near = (got, want, tol, what) =>
    assert(Math.abs(got - want) <= tol, what + "：拿到 " + got + "，应该在 " + want + "±" + tol);

  // ① 像素得对得上。左半红、右半蓝、最下面四分之一整条绿。
  // 缩放是按格子取平均的，所以色块中心必须还是那个颜色——行错位、通道对调、
  // 上下颠倒，任何一种都会让下面某一条炸掉
  const RED = [220, 30, 30], BLUE = [30, 30, 220], GREEN = [30, 200, 30];
  const paint = (x, y) => (y >= 300 ? GREEN : x < 100 ? RED : BLUE);
  const img = dec(shrinkPng(enc(200, 400, 2, 8, paint), 100));
  assert(img.width === 50 && img.height === 100, "200×400 缩到长边 100 应是 50×100，实际 " + img.width + "×" + img.height);
  near(img.px(12, 30)[0], 220, 6, "左上应是红的 R");
  near(img.px(12, 30)[2], 30, 6, "左上应是红的 B");
  near(img.px(37, 30)[2], 220, 6, "右上应是蓝的 B");
  near(img.px(37, 30)[0], 30, 6, "右上应是蓝的 R");
  near(img.px(25, 90)[1], 200, 6, "底下那条应是绿的 G");
  // 负对照：要是整张图被涂成一个色，上面那几条也能"过"，所以再钉一下三处互不相同
  assert(img.px(12, 30)[0] !== img.px(37, 30)[0] && img.px(25, 90)[1] !== img.px(12, 30)[1],
    "三块颜色缩完变成一样了——整张图被抹平了");

  // ② 五种 filter 编出来的是同一张图，缩完必须一模一样。
  // 这是解滤波那四个逆运算唯一的照妖镜：Sub/Up/Average/Paeth 哪个写错，
  // 出来的图就跟 filter 0 那张对不上，而单看它自己是不报错的
  // 料必须是噪声，不能是上面那张色块图：纯色块里 Paeth 的左/上/左上三个预测值几乎总相等，
  // 平局判给谁结果都一样——把 pa <= pb 写成 pa < pb 这种错，用色块图是**抓不到的**（试过，绿）
  const noise = (x, y) => {
    let v = (x * 2654435761 + y * 40503) >>> 0;
    v ^= v >>> 13; v = (v * 1274126177) >>> 0; v ^= v >>> 16;
    return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];
  };
  for (const pixel of [paint, noise]) {
    const base = shrinkPng(enc(200, 400, 2, 8, pixel, { filter: 0 }), 100);
    for (const f of [1, 2, 3, 4]) {
      const got = shrinkPng(enc(200, 400, 2, 8, pixel, { filter: f }), 100);
      assert(got, "filter " + f + " 编的图缩不出来（返回 null）");
      assert(got.equals(base), "filter " + f + "（" + ["", "Sub", "Up", "Average", "Paeth"][f] + "）解滤波解错了：" +
        "同一张图缩出来跟 filter 0 那张对不上（料：" + (pixel === noise ? "噪声" : "色块") + "）");
    }
  }

  // ③ 五种色型 + 16 位
  const gray = dec(shrinkPng(enc(200, 400, 0, 8, (x, y) => [y >= 300 ? 240 : 40]), 100));
  near(gray.px(25, 30)[0], 40, 6, "灰度图上半应是暗的");
  near(gray.px(25, 90)[0], 240, 6, "灰度图下半应是亮的");

  const deep = dec(shrinkPng(enc(200, 400, 2, 16, paint), 100));
  near(deep.px(12, 30)[0], 220, 6, "16 位图的红没认出来（只取高字节那一步）");
  assert(deep.depth === 8, "16 位缩完应该降成 8 位，实际 " + deep.depth);

  const plte = Buffer.from([...RED, ...BLUE, ...GREEN]);
  const pal = dec(shrinkPng(enc(200, 400, 3, 8, (x, y) => [y >= 300 ? 2 : x < 100 ? 0 : 1], { plte }), 100));
  near(pal.px(12, 30)[0], 220, 6, "调色板图没查表（左上应是红）");
  near(pal.px(37, 30)[2], 220, 6, "调色板图没查表（右上应是蓝）");

  // ④ 有半透明就得留住 alpha，没有就该省掉那条通道（同一张图小掉四分之一）
  const solid = dec(shrinkPng(enc(200, 400, 6, 8, (x, y) => [...paint(x, y), 255]), 100));
  assert(solid.color === 2, "整张不透明的 RGBA 图应该写成 RGB（色型 2），实际色型 " + solid.color);
  const glass = dec(shrinkPng(enc(200, 400, 6, 8, (x, y) => [...paint(x, y), x < 100 ? 0 : 255]), 100));
  assert(glass.color === 6, "左半全透明的图被写成了不透明（色型 " + glass.color + "）——透明底会变成黑块");
  near(glass.px(12, 30)[3], 0, 6, "左半应该是透明的");
  near(glass.px(37, 30)[3], 255, 6, "右半应该是不透明的");
  const ga = dec(shrinkPng(enc(200, 400, 4, 8, (x, y) => [y >= 300 ? 240 : 40, x < 100 ? 0 : 255]), 100));
  assert(ga.color === 6 && Math.abs(ga.px(12, 30)[3] - 0) <= 6, "灰+A 的 alpha 没留住");

  // ⑤ 认不了的一律 null，让调用方原样发原图。绝不许抛，也绝不许吐一张坏图出来
  const no = (buf, why) => assert(shrinkPng(buf, 100) === null, why);
  no(Buffer.from("THUMBFALLBACK".repeat(999)), "一堆乱字节被当成 PNG 收了");
  no(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "只有签名没有 IHDR 的也收了");
  no(enc(200, 400, 2, 8, paint).subarray(0, 200), "断在半截的文件也收了——连块都读不全");
  // 另一种断法：块都完整、CRC 也对，只是 IHDR 说有 800 行、IDAT 里只有 400 行。
  // 上面那条拦不住它（readChunks 会顺利读完），得靠「行数够不够」那道闸
  no(enc(200, 400, 2, 8, paint, { claimHeight: 800 }), "头里写 800 行、实际只有 400 行，照缩——后半张会是花的");
  no(enc(200, 400, 2, 8, paint, { interlace: 1 }), "隔行（Adam7）的没拦住——按逐行解会整片错位");
  no(enc(60, 80, 2, 8, paint), "本来就比要的小，还去缩了一趟（只会更糊）");
  no(enc(200, 400, 3, 8, () => [0]), "调色板图没有 PLTE 也照缩，查表要越界");
  assert(shrinkPng(enc(200, 400, 2, 8, paint), 0) === null, "宽度 0 也收了");
  assert(shrinkPng(null, 100) === null && shrinkPng(undefined, 100) === null, "null / undefined 没挡住");
  // 随机字节喂一百次，一次都不许抛
  const crypto = require("crypto");
  for (let i = 0; i < 100; i++) {
    const junk = Buffer.concat([SIG, crypto.randomBytes(200)]);
    try { shrinkPng(junk, 100); } catch (e) { assert(false, "喂垃圾字节抛了：" + e.message); }
  }

  // ⑥ 横图、竖图、正方形：长边都得正好是要的那个数，短边按比例
  for (const [w, h, ew, eh] of [[400, 200, 100, 50], [200, 400, 50, 100], [300, 300, 100, 100], [1000, 40, 100, 4]]) {
    const o = pngInfo(shrinkPng(enc(w, h, 2, 8, () => [10, 20, 30]), 100));
    assert(o.width === ew && o.height === eh,
      w + "×" + h + " 应缩成 " + ew + "×" + eh + "，实际 " + o.width + "×" + o.height);
  }

  console.log("✅ 纯 node 缩图：像素对得上（左红右蓝下绿）、五种 filter 解出同一张图、五种色型 + 16 位都认，认不了的返回 null 不抛");
}

/**
 * thumb.js 的异步那一层：缩图到底有没有被赶到别的线程上去。
 *
 * 这一层存在的唯一理由是**别挡住 SSE**。解滤波和缩放是纯 JS，一张 2360×3720 的图要跑
 * 209 ms；而这台服务器同时在把回答一个字一个字推给浏览器，主线程被占住 209 ms，
 * 用户看到的就是字卡住不动。一屏产出卡八张图，排着做就是一秒多的停顿——
 * 那比干脆不做缩略图还难受。所以这条测试真正要钉的是**主线程的卡顿**，
 * 而不是"有没有返回一个路径"。
 */
async function testThumbPool() {
  const os = require("os");
  const thumb = require("../thumb");
  const { pngInfo } = require("../thumb-png");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pool-"));
  const cache = path.join(dir, "thumbs");
  // 缩图的 promise 要是永远不 resolve（线程起不来、活卡在队列里），node 会觉得没事可做
  // 直接 exit 0 —— 测试"通过"了，其实一句都没跑完。所以每一次等待都套上限时
  const timers = new Set();
  const within = (p, why) => Promise.race([
    p.finally(() => { for (const t of timers) clearTimeout(t); timers.clear(); }),
    // 这个定时器**不许 unref**：unref 了它就拦不住进程退出，
    // node 照样在 promise 永远不 resolve 的时候悄悄 exit 0——限时等于没设
    new Promise((_, rej) => {
      timers.add(setTimeout(() => rej(new Error("等了 20 秒没回来：" + why + "（缩图的活卡住了）")), 20000));
    }),
  ]);
  try {
    assert(!thumb.hasNativeImage(),
      "这条测试是跑在纯 node 下的（`npm start` 那一边），可这儿居然有 nativeImage —— 它会走桌面版那条路，等于没测");

    const big = path.join(dir, "大图.png");
    fs.writeFileSync(big, e2ePng(700, 500));
    assert(fs.statSync(big).size > 100 * 1024, "料不到 100 KB，走不到缩放那一步");

    // ① 主线程不许被占住。
    //
    // 不拿绝对毫秒数当门槛（换台机器就得改），而是**同一批活跑两遍**：
    // 一遍老老实实在主线程上做（对照组），一遍走线程池。两遍都在旁边每 10 ms 打一次点，
    // 比的是这两次的卡顿差多少。对照组同时还证明了这批料够重——要是它自己都卡不出来，
    // 那实验组不卡也说明不了任何事。
    const batch = [];
    for (let i = 0; i < 8; i++) {
      const f = path.join(dir, "图" + i + ".png");
      fs.writeFileSync(f, e2ePng(700 + i, 500));   // 尺寸各不相同，免得被缓存去重
      batch.push(f);
    }
    const heartbeat = () => {
      const m = { worst: 0, beats: 0, last: Date.now() };
      m.timer = setInterval(() => {
        const now = Date.now();
        m.worst = Math.max(m.worst, now - m.last - 10);
        m.last = now;
        m.beats++;
      }, 10);
      return m;
    };

    // 对照组：搁主线程上同步缩——这正是没有 thumb-worker.js 时会发生的事
    const { shrinkPng } = require("../thumb-png");
    const ctl = heartbeat();
    const ctlT0 = Date.now();
    for (const f of batch) shrinkPng(fs.readFileSync(f), 320);
    const ctlSpent = Date.now() - ctlT0;
    // 让一下事件循环：同步循环跑完紧接着 clearInterval 的话，那个 10 ms 的定时器
    // 从头到尾一次都没轮上，量出来的卡顿会是 0——"没卡"其实是"没量"
    await new Promise((r) => setTimeout(r, 20));
    clearInterval(ctl.timer);
    assert(ctlSpent > 30 && ctl.worst > 10,
      "对照组自己都没卡（" + ctlSpent + "ms，卡顿 " + ctl.worst + "ms）——这批料太轻，① 等于没测");

    // 实验组：同一批活走线程池。先空转一次把 worker 起起来，起线程是一次性开销
    await within(thumb.thumbFileAsync(batch[0], 640, cache), "预热线程池");
    const m = heartbeat();
    const t0 = Date.now();
    const got = await within(Promise.all(batch.map((f) => thumb.thumbFileAsync(f, 320, cache))), "8 张一起缩");
    const spent = Date.now() - t0;
    clearInterval(m.timer);
    const worst = m.worst;
    assert(got.every(Boolean), "8 张里有缩不出来的：" + got.filter((x) => !x).length + " 张");
    assert(m.beats > 3, "心跳只打了 " + m.beats + " 下，采样太少，测不出卡顿");
    // 阈值放得很宽（对照组的三分之一），GC 和机器负载都容得下。
    // 真把缩放挪回主线程，这两个数会一样大，这条立刻红
    assert(worst < ctl.worst / 3,
      "走线程池卡了 " + worst + "ms，搁主线程做卡 " + ctl.worst + "ms —— 差不多，说明缩放根本没离开主线程，SSE 会被卡住");

    // ② 缩出来的得是真缩过的
    const meta = pngInfo(fs.readFileSync(got[0]));
    assert(meta && Math.max(meta.width, meta.height) === 320,
      "缩出来的长边不是 320（" + (meta ? meta.width + "×" + meta.height : "根本不是 PNG") + "）");

    // ③ 同一张图同时被点三下，只许缩一次（产出卡和资料库可能同时要同一张图）。
    // 注意不能靠数缓存目录里的文件：三个请求本来就写同一个文件名，
    // 重复缩了目录里也还是一个文件，光看文件数是**看不出来**的（第一版就是这么漏的）
    let n0 = thumb.thumbPoolStats().shrinks;
    const trio = await within(Promise.all([
      thumb.thumbFileAsync(big, 160, cache),
      thumb.thumbFileAsync(big, 160, cache),
      thumb.thumbFileAsync(big, 160, cache),
    ]), "同图三连");
    assert(trio[0] && trio[0] === trio[1] && trio[1] === trio[2], "同一张图三次要到了不同的缩略图");
    assert(thumb.thumbPoolStats().shrinks === n0 + 1,
      "同一张图同时点三下，派出去缩了 " + (thumb.thumbPoolStats().shrinks - n0) + " 次（应该只有 1 次）");

    // ④ 第二次要同一张，走缓存，一件活都不许再派
    n0 = thumb.thumbPoolStats().shrinks;
    const again = await within(thumb.thumbFileAsync(big, 160, cache), "缓存命中");
    assert(again === trio[0], "第二次要同一张缩略图，给的路径变了");
    assert(thumb.thumbPoolStats().shrinks === n0, "缓存已经有了还是又缩了一遍");

    // ⑤ 该退回原图的一律 null，而且**连线程都不该惊动**。
    // 绝不许因为缩略图让一张图显示不出来
    const refuses = async (f, w, why) => {
      const before = thumb.thumbPoolStats().shrinks;
      assert((await within(thumb.thumbFileAsync(f, w, cache), why)) === null, why);
      assert(thumb.thumbPoolStats().shrinks === before, why + "：退回原图了，可还是白派了一件活给线程");
    };
    // 体积不够：图够大（500 长边 > 320，不拦的话是会缩的），但压完不到 100 KB，
    // 缩一趟省下的还不够那次往返。料必须是压得动的纯色，噪声图压不小
    const small = path.join(dir, "小图.png");
    fs.writeFileSync(small, e2ePng(400, 500, () => [10, 20, 30]));
    assert(fs.statSync(small).size < 100 * 1024, "这张「小图」其实不小（" + fs.statSync(small).size + " B），⑤ 的第一条等于没测");
    await refuses(small, 320, "不到 100 KB 的图也缩了，省下的还不够那一趟");
    // 档位外的尺寸。用 321 而不是 999：999 比原图还大，本来就会被"图比要的小"那条挡掉，
    // 挡在哪一步就分不出来了
    await refuses(big, 321, "?thumb=321 不在档位里（只认 160/320/640），居然也缩了");
    const fake = path.join(dir, "冒牌.png");
    fs.writeFileSync(fake, Buffer.from("THUMBFALLBACK".repeat(12000)));
    assert((await within(thumb.thumbFileAsync(fake, 320, cache), "冒牌 png")) === null,
      "扩展名是 .png 但根本不是 PNG，居然没退回原图");
    // 内容是货真价实的 PNG，只是名字叫 .jpg。纯 node 这条路只认 .png，
    // 连线程都不该派——派了也是白跑一趟（缩得出来，但那是另一回事）
    const misnamed = path.join(dir, "其实是png.jpg");
    fs.writeFileSync(misnamed, fs.readFileSync(big));
    await refuses(misnamed, 320, "纯 node 只缩 .png，.jpg 应该直接退回原图");
    await refuses(path.join(dir, "根本没有这个文件.png"), 320, "文件不存在却给了个缩略图路径");
    assert(!fs.readdirSync(cache).some((f) => f.endsWith(".part")), "缓存目录里留下了写了一半的临时文件");

    // ⑥ 缩图线程本身起不来的时候（最典型的是打包漏了 thumb-worker.js——
    // electron-builder 的 files 一改就可能漏），必须**认栽退回原图**，
    // 而不是"起线程→挂→补位→再起"一直烧 CPU 转圈。
    // 造这个场景不往生产代码里加开关：把 thumb.js 和它依赖的那两个文件复制到别处，
    // 单单不复制 thumb-worker.js —— 那正是漏文件时的样子
    const brokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-broke-"));
    for (const f of ["thumb.js", "thumb-png.js"]) {
      fs.copyFileSync(path.join(__dirname, "..", f), path.join(brokeDir, f));
    }
    const broke = require(path.join(brokeDir, "thumb.js"));
    try {
      const bT0 = Date.now();
      const bad = await within(Promise.all(
        batch.map((f) => broke.thumbFileAsync(f, 320, path.join(brokeDir, "c")))
      ), "线程起不来时的一批请求");
      assert(bad.every((x) => x === null), "缩图线程根本起不来，却给出了缩略图路径");
      assert(Date.now() - bT0 < 10000, "线程起不来这件事花了 " + (Date.now() - bT0) + " ms 才认栽");
      assert(broke.thumbPoolStats().broken, "连着起不来这么多次，居然还没把这条路关掉——会一直转圈烧 CPU");
      // 关掉之后再来的请求要直接退回原图，一个线程都不许再起。
      // 看的是"一共起过几个"这种只增不减的数，不是"现在活着几个"——
      // 后者会因为起起来又立刻挂掉而恰好读回 0，看着像没起过
      const spawnedBefore = broke.thumbPoolStats().spawned;
      assert((await within(broke.thumbFileAsync(batch[0], 160, path.join(brokeDir, "c")), "认栽后再来一次")) === null,
        "已经认栽了还给出缩略图");
      assert(broke.thumbPoolStats().spawned === spawnedBefore,
        "认栽之后又起了 " + (broke.thumbPoolStats().spawned - spawnedBefore) + " 个线程");
    } finally {
      broke.closeThumbPool();
      try { fs.rmSync(brokeDir, { recursive: true, force: true }); } catch {}
    }

    // ⑥b 认栽是有门槛的：偶尔崩一次不算数，干成过一件就该清零重新数。
    // 不然一台跑几个月的服务器攒够三次互不相干的崩溃，缩略图就永久关了，谁也不知道为什么。
    // 造法还是复制到别处，只是这回自己写一个**会挑食的** thumb-worker：
    // 名字带"毒"的就自杀，别的老实缩。生产代码里一个开关都不用加
    const flakyDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-flaky-"));
    for (const f of ["thumb.js", "thumb-png.js"]) {
      fs.copyFileSync(path.join(__dirname, "..", f), path.join(flakyDir, f));
    }
    fs.writeFileSync(path.join(flakyDir, "thumb-worker.js"), [
      'const fs = require("fs"), path = require("path");',
      'const { parentPort } = require("worker_threads");',
      'const { shrinkPng } = require("./thumb-png");',
      'parentPort.on("message", (job) => {',
      '  if (job.file.includes("毒")) process.exit(1);',   // 崩给它看
      '  let ok = false;',
      '  try {',
      '    const png = shrinkPng(fs.readFileSync(job.file), job.w);',
      '    if (png) { fs.mkdirSync(path.dirname(job.out), { recursive: true }); fs.writeFileSync(job.out, png); ok = true; }',
      '  } catch {}',
      '  parentPort.postMessage({ id: job.id, ok });',
      '});',
    ].join("\n"));
    const flaky = require(path.join(flakyDir, "thumb.js"));
    try {
      const fc = path.join(flakyDir, "c");
      const poison = path.join(flakyDir, "毒图.png");
      fs.writeFileSync(poison, fs.readFileSync(big));
      const good = path.join(flakyDir, "好图.png");
      fs.writeFileSync(good, fs.readFileSync(batch[1]));
      // 崩两次——还没到认栽的线
      for (let i = 0; i < 2; i++) {
        assert((await within(flaky.thumbFileAsync(poison, 320, fc), "崩第 " + (i + 1) + " 次")) === null,
          "线程崩了却给出了缩略图路径");
      }
      assert(!flaky.thumbPoolStats().broken, "才崩两次就把整条路关了");
      // 干成一件：这一下必须把计数清零
      assert(await within(flaky.thumbFileAsync(good, 320, fc), "崩过之后缩一张好图"),
        "线程崩过两次之后，好图也缩不出来了");
      // 再崩两次。要是刚才那次成功没清零，这会儿就凑够三次、整条路被误关了
      for (let i = 0; i < 2; i++) await within(flaky.thumbFileAsync(poison, 160 + i * 160, fc), "再崩一次");
      assert(!flaky.thumbPoolStats().broken,
        "中间明明缩成过一张，崩的次数却还在累加——一台跑几个月的机器早晚被这样误关");
      assert(await within(flaky.thumbFileAsync(good, 640, fc), "误关之后再缩一张"),
        "被误关了：零星崩溃攒够三次就再也不缩图了");
    } finally {
      flaky.closeThumbPool();
      try { fs.rmSync(flakyDir, { recursive: true, force: true }); } catch {}
    }

    // ⑦ 缩完图，进程得能自己走。闲着的 worker 要是没 unref，它会一直吊着事件循环——
    // `openworkbuddy` 命令行跑完一条命令就该退出，测试跑完也该退出，结果都会卡在那儿等一个永远不来的消息。
    // 这条必须另起一个进程才测得出来：本进程 finally 里会 closeThumbPool，把线程收掉，
    // 就算没 unref 也一样能退，等于什么都没验
    const exitProbe = path.join(dir, "probe.js");
    fs.writeFileSync(exitProbe, [
      'const thumb = require(' + JSON.stringify(path.join(__dirname, "..", "thumb.js")) + ');',
      'thumb.thumbFileAsync(' + JSON.stringify(big) + ', 640, ' + JSON.stringify(path.join(dir, "probe-cache")) + ')',
      '  .then((r) => { console.log(r ? "缩出来了" : "没缩"); });',
      '// 故意不调 closeThumbPool：模拟 CLI 跑完一条命令就撒手不管',
    ].join("\n"));
    const probe = await within(new Promise((resolve) => {
      const t0 = Date.now();
      const child = require("child_process").spawn(process.execPath, [exitProbe], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 12000);
      child.on("exit", (code) => { clearTimeout(kill); resolve({ code, ms: Date.now() - t0, out: out.trim() }); });
    }), "另起进程验能不能自己退出");
    assert(probe.out === "缩出来了", "另起的进程没缩出图来（" + JSON.stringify(probe.out) + "）——这条测的就不是退出了");
    assert(probe.code === 0, "缩完图的进程没能正常退出（退出码 " + probe.code + "）——闲着的缩图线程把它吊住了");
    assert(probe.ms < 10000, "缩完图的进程等了 " + probe.ms + " ms 才退出——闲着的缩图线程把它吊住了");

    console.log("✅ 缩图线程：同一批 8 张图，搁主线程做卡 " + ctl.worst + "ms，走线程池只卡 " + worst +
      "ms（" + spent + "ms 缩完）；同图去重、缓存命中不重缩，缩不动一律退回原图，" +
      "线程起不来就认栽（不转圈），缩完进程能自己退（" + probe.ms + "ms）");
  } finally {
    thumb.closeThumbPool();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  console.log("=== OpenWorkBuddy e2e 测试 ===");
  // 只跑其中几个：E2E_ONLY=testDramaCompose,testI18n node test/e2e.js
  // 一条走真 ffmpeg 的测试要跑一分多钟，改配乐那一段时不该连带跑另外五十个。
  // 用 eval 是因为这些测试是模块作用域里的顶层函数声明，不在 globalThis 上，拿不到。
  if (process.env.E2E_ONLY) {
    for (const name of process.env.E2E_ONLY.split(",").map((x) => x.trim()).filter(Boolean)) {
      let fn = null; try { fn = eval(name); } catch {}
      assert(typeof fn === "function", "没有这个测试：" + name);
      console.log("— " + name);
      await fn();
    }
    return;
  }
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
  await testMediaImageInputGate();
  await testVideoProtocols();
  await testMediaKeyHygiene();
  await testCliMode();
  testDeliverableGate();
  testContextBudget();
  testCtxMeterWiring();
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
  testNoticeCoverage();
  testStyleDirection();
  testShortDrama();
  testCanvasCreativeLineage();
  testCanvasThumb();
  await testCanvasMissingAssets();
  testReleasePipeline();
  testNoNestedRoutes();
  await testAdminConsoleUI();
  await testNodeSuite("tenant.js", "多租户与企业后台越权");
  await testNodeSuite("prefs.js", "个人偏好与平台设置分界");
  await testNodeSuite("media-models.js", "多模型配置（渠道表 / 点名 / 不静默降级）");
  await testNodeSuite("chat-models.js", "对话模型：渠道共用一把 Key");
  await testNodeSuite("lanes.js", "两条工作线（工程 / 办公）");
  await testNodeSuite("cli-live.js", "终端里 openworkbuddy 跑的活儿，网页和手机怎么看见");
  await testNodeSuite("doctor.js", "开机闸门与 openworkbuddy doctor 体检（Node / 依赖 / 端口 / 配置 / 引擎）");
  await testNodeSuite("cli-args.js", "命令行参数声明表：拼错的选项当场拦下并给建议，老写法逐条对齐不变");
  await testNodeSuite("repl-commands.js", "openworkbuddy 交互模式：多行粘贴合成一条、打错的斜杠命令当场拦下、Ctrl+C 停活儿不退出");
  await testNodeSuite("md-tty.js", "终端里的 Markdown 渲染：记号不裸奔、代码不被改坏、流式切片结果一致");
  await testNodeSuite("cli-attach.js", "openworkbuddy 带文件进来：拖进来的路径 / @ 补全 / 剪贴板，文件不进对话历史");
  await testNodeSuite("icons.js", "界面不许再冒 emoji：源码闸门 + 图标名核对 + 提示条记号转换");
  await testNodeSuite("checkpoints.js", "文件检查点：改前留底 / 整步回退 / 改前 diff / 账本被手改也写不出工作目录");
  await testDockerDeploy();
  await testFetchUrlShapes();
  await testParallelToolBatch();
  await testMcpStreamableHttp();
  await testSchedulerRuntime();
  await testMcpManagerLifecycle();
  await testNodeSyntaxPrecheck();
  await testShellGlobCompat();
  await testMissingBinHintWired();
  await testSessionFileLayout();
  await testOfficeLibs();
  await testPreviewExtract();
  testEventLedgerParity();
  testEvolveLoop();
  testEvolveRecency();
  testEvolvePromptBudget();
  testAgentPromptDrift();
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
  await testEngineSecurityGuard();
  await testEngineContextParity();
  await testEngineStoppedSurfacing();
  await testFeedbackAndUsage();
  testOutputOwnership();
  await testFilesEmitter();
  await testHeavyTools();
  testOutputFilesRecency();
  testThumbPng();
  await testThumbPool();
  await testIntranet();
  await testCanvasDataLoss();
  await testUpgradeMigration();
  await testDramaAssets();
  await testDramaPipeline();
  await testDramaCompose();
  await testDramaCast();
  await testDramaShotRefs();
  await testDramaVoice();
  await testDramaBoardExpand();
  await testDramaBoardWriteback();
  await testFilePathRouting();
  await testLibraryOutputsTruth();
  await testLibraryTurnAnchor();
  await testPortCollision();
  await testSessionSearchLive();
  await testDecideLive();
  await testConfigExternalEdit();
  await testSweepApi();
  await testKeyGuard();
  await testDesktopPet();
  testPetSprites();
  await testMcpFailureReason();
  await testConnectorToggleAndTools();
  await testScheduleRunTrace();
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
  await testAdminModelsPage();
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
  testOutNameKeepsExt();
  await testBackupRoundTrip();
  await testCheckpoints();
  // 清理测试产物
  for (const f of fs.readdirSync(WORKSPACE)) {
    if (f.startsWith("e2e-")) fs.rmSync(path.join(WORKSPACE, f), { force: true });
  }
  console.log("=== 全部测试通过 ===");
}

/**
 * 画布的线必须是可执行创作关系，不是只给人看的箭头。
 * 这一闸钉住：浏览器保存、服务端归一化、Agent 工具定义三处都保留用途；否则角色图
 * 连到镜头后，下一次同步就会退化成无意义的「输入」。
 */
function testCanvasCreativeLineage() {
  const tools = require("../tools");
  const valid = tools.canvasNormalizeState({ nodes: [
    { id: "char", kind: "character", payload: {}, position: { x: 1, y: 2 } },
    { id: "shot", kind: "shot", payload: {}, position: { x: 3, y: 4 } },
  ], edges: [
    { source: { id: "char" }, target: { id: "shot" }, relation: "character" },
    { source: { id: "char" }, target: { id: "shot" }, relation: "not-a-real-role" },
  ] });
  assert.strictEqual(valid.edges[0].relation, "character", "画布同步后丢了人物身份用途");
  // 认不出来的用途照留：序列化是「读出来再存回去」的必经之路，在这儿挑食
  // 等于用新版本打开老画布就把人家标好的关系抹了。该拦的是新建连线那一步（见下）
  assert.strictEqual(valid.edges[1].relation, "not-a-real-role", "序列化不许挑食：不认识的用途也得原样留着，不然老画布一打开就被抹");
  const def = tools.TOOL_DEFS.find((item) => item.name === "canvas_manage");
  assert.ok(def?.input_schema?.properties?.relation?.enum?.includes("continuity"), "Agent 不能声明连续性关系，画布就会退化成装饰箭头");
  assert.ok(def.input_schema.properties.relation.enum.includes("first_frame"), "Agent 不能声明首帧关系，镜头生成不知道该取哪个输入");
  // 序列化那头放行了，闸门就必须在建线这头。这条断言盯的是「闸门还在不在」——
  // 两头同时松掉的话，随便一个字符串都能变成连线用途，画布上就会出现画不出来的关系
  const toolsSrc = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
  const connectIdx = toolsSrc.indexOf('if (op === "connect")');
  const gateIdx = toolsSrc.indexOf("CANVAS_EDGE_RELATIONS.has(relation)", connectIdx);
  assert.ok(connectIdx > 0 && gateIdx > connectIdx && gateIdx - connectIdx < 900, "connect 里查 CANVAS_EDGE_RELATIONS 的那道闸没了：新建连线不再校验用途");
  const canvas = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
  assert.ok(/function canvasGenerationInputs\(/.test(canvas) && /canvasRecordGeneration\(/.test(canvas), "画布没有记录生成输入和可回看的本次执行");
  assert.ok(/data-connect-relation/.test(canvas) && /canvasRelationLabel\(/.test(canvas), "界面不能选择或展示连线用途");
  assert.ok(/relation: canvasLinkRelation/.test(canvas), "浏览器保存画布时没有把连线用途写回唯一真源");
  console.log("✅ 画布创作谱系：连线用途可选/可保存/Agent 可写，生成节点保留模型、输入与产物记录");
}

/**
 * 无限画布不许张口就说「素材已从工作区移除」。
 *
 * 用户原话：「怎么又说素材从工作区移除了在无限画布里面，你在搞什么？」——「又」是重点，
 * 这事犯过不止一次。真身：画布拿 /api/files 那份列表当全集，判「不在列表里 = 文件被删了」。
 * 可那份列表是**截断过的**（tools.js outputFiles：最深 3 层、最多 500 条），
 * server.js 的 filesScope() 专门发一个 full 字段就是为了让前端知道「别拿它给谁盖章」。
 * 于是三种情况下文件好端端在盘上，画布却说它没了：
 *   ① 工作目录攒过 500 个文件，老素材集体被判死刑；
 *   ② 素材落在第 4 层（对话成果/某会话/某轮/图.png），从来就没进过列表；
 *   ③ /api/files 这一趟本身失败，列表是空的，满画布一起挂横幅。
 * 更狠的是右侧面板那个下拉：判缺失之后它把 <option value="" selected> 设成选中，
 * select 的 value 当场掉成 ""，用户点开面板看一眼就把这条引用抹了——那是丢数据。
 *
 * 所以这一条守三头：盘上那个口子问得准、前端默认「认在」、下拉不抹路径。
 */
async function testCanvasMissingAssets() {
  const os = require("os");
  const http = require("http");
  const crypto = require("crypto");
  const file = path.join(__dirname, "..", "public", "js", "app-07-canvas.js");
  const src = fs.readFileSync(file, "utf8");

  // ---------- ① 前端：不在列表里 ≠ 没了 ----------
  const from = src.indexOf("function canvasResolvedFileName(");
  const to = src.indexOf("function canvasAudioPreview(");
  assert.ok(from > 0 && to > from, "切不出 canvasMediaAvailable 那一段了（改名/搬窝了？），这一条在空转");
  const mk = (files, missing) => new Function("canvasState",
    src.slice(from, to) + "\nreturn { canvasMediaAvailable };")({ files, missing: new Set(missing || []) }).canvasMediaAvailable;

  const listed = mk([{ name: "任务_0917/镜头01_首帧.png" }], []);
  assert.ok(listed("镜头01_首帧.png"), "列表里明明有，却说没有");
  // 这一条就是用户看到的那一下：列表截断（或深目录、或请求失败）导致文件不在列表里
  assert.ok(mk([], [])("任务_0917/子目录/更深/图.png"),
    "只是「不在那份截断过的列表里」就判文件没了——这正是满画布「素材已从工作区移除」的来源");
  assert.ok(mk([], [])("镜头01_首帧.png"), "/api/files 失败导致列表为空时，全画布的素材被一起判死");
  // 反向对照：问过盘、盘说真没有，那才是真没有——否则上面几条只是在测「这函数永远返回 true」
  assert.ok(!mk([], ["任务_0917/子目录/更深/图.png"])("任务_0917/子目录/更深/图.png"),
    "服务端都确认盘上没有了还说它在，横幅永远出不来");
  assert.ok(mk([], ["别的图.png"])("这张图.png"), "别人的缺失判决串到这张图头上了");
  // 外链和 data: 不归工作区管，永远算在
  assert.ok(mk([], [])("https://example.com/a.png") && mk([], [])("data:image/png;base64,AA"),
    "外链 / data: 被当成工作区文件判了缺失");

  // ---------- ② 右侧下拉：没确认缺失就不许把路径抹掉 ----------
  const pf = src.indexOf("const inGroups = files.includes(current)");
  assert.ok(pf > 0, "右侧下拉那段 currentOption 改写没了（这一条在空转）");
  const seg = src.slice(pf, src.indexOf("</label>`;", pf));
  assert.ok(/canvasMediaAvailable\(current\)/.test(seg),
    "下拉判「素材已移除」没走 canvasMediaAvailable，又会拿截断列表当全集");
  assert.ok(/<option value="\$\{esc\(current\)\}" selected>/.test(seg),
    "没确认缺失时下拉没把当前路径摆成选中项：select 的 value 会掉成空串，用户点开面板看一眼就把引用抹了");

  // ---------- ③ 接线：列表回来之后得真去问盘 ----------
  assert.ok(/function canvasVerifyMissing\(/.test(src), "没有 canvasVerifyMissing：缺失判决没人去盘上确认");
  const lib = src.slice(src.indexOf("async function canvasLoadLibrary("), src.indexOf("function canvasEmbeddedImage("));
  assert.ok(lib.length > 40 && /canvasVerifyMissing\(/.test(lib),
    "canvasLoadLibrary 没叫 canvasVerifyMissing：missing 永远是空的，横幅再也不会出现（从「全冤枉」滑到「全不报」，一样是撒谎）");

  // canvasVerifyMissing 本体：盘说有就撤判决、盘说没有才进 missing、问不到维持原判
  const vf = src.indexOf("const CANVAS_REF_KEYS =");
  const vt = src.indexOf("async function canvasLoadLibrary(");
  assert.ok(vf > 0 && vt > vf, "切不出 canvasVerifyMissing 了（改名/搬窝？）");
  const runVerify = async (payloads, exists, { fail = false } = {}) => {
    const st = { files: [], missing: new Set(), graph: { getElements: () => payloads.map((p, i) => ({ id: "n" + i, _p: p })) } };
    let refreshed = 0;
    const ctx = new Function("canvasState", "canvasPayload", "canvasRefreshNode", "canvasSelectedNode",
      "canvasRenderInspector", "canvasResolvedFileName", "fetch",
      src.slice(vf, vt) + "\nreturn { canvasVerifyMissing };");
    await ctx(st, (n) => n._p, () => { refreshed += 1; }, () => null, () => {}, (x) => x,
      async () => (fail ? Promise.reject(new Error("断网")) : { json: async () => ({ exists }) }))
      .canvasVerifyMissing();
    return { missing: [...st.missing], refreshed };
  };
  const gone = await runVerify([{ path: "没了.png" }], { "没了.png": false });
  assert.deepStrictEqual(gone.missing, ["没了.png"], "盘说没有，却没记进 missing");
  assert.ok(gone.refreshed > 0, "判决变了却没重画节点，横幅要等下次刷新才出现");
  const alive = await runVerify([{ path: "还在.png" }], { "还在.png": true });
  assert.deepStrictEqual(alive.missing, [], "盘说文件在，却仍判它没了");
  const offline = await runVerify([{ path: "问不到.png" }], null, { fail: true });
  assert.deepStrictEqual(offline.missing, [], "网断了也敢给文件盖「已删除」的章");
  // 首帧/尾帧这些字段也得问，不然镜头节点上的图照旧被冤枉
  const frame = await runVerify([{ first_frame: "首帧.png", last_frame: "尾帧.png" }], { "首帧.png": false, "尾帧.png": true });
  assert.deepStrictEqual(frame.missing, ["首帧.png"], "first_frame / last_frame 这些字段没被拿去问盘");

  // ---------- ④ 盘上那个口子：深目录里的文件要认得出来 ----------
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-canvasmiss-"));
  const deep = path.join(home, "workspace", "对话成果", "任务_0917", "第三轮");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "镜头01_首帧.png"), Buffer.from("PNG"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));
  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const { up, port, why } = await booted.wait();
  const post = (p, body) => new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST",
      headers: { Cookie: "openworkbuddy_token=" + token, "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, json: j, body: b }); });
    });
    req.on("error", (e) => resolve({ code: 0, json: null, body: e.message }));
    req.end(data);
  });
  const get = (p) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers: { Cookie: "openworkbuddy_token=" + token } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, json: j }); });
    });
    req.on("error", () => resolve({ code: 0, json: null }));
    req.end();
  });
  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + why);
    const rel = "对话成果/任务_0917/第三轮/镜头01_首帧.png";
    // 先立一个前提：这张图**确实**不在 /api/files 里（第 4 层，outputFiles 只走 3 层）。
    // 没有这一步，下一条就只是在测一个刚好也在列表里的文件，证明不了任何事
    const list = await get("/api/files");
    assert.ok(Array.isArray(list.json), "/api/files 没给出列表");
    assert.ok(!list.json.some((f) => String(f.name) === rel),
      "前提没立住：这张图居然进了 /api/files（outputFiles 的深度上限变了？），下面那条不再是在测深目录");
    const r = await post("/api/files/exists", { paths: [rel, "根本没有这个.png"] });
    assert.strictEqual(r.code, 200, "/api/files/exists 没通（HTTP " + r.code + "）：" + r.body);
    assert.strictEqual(r.json.exists[rel], true,
      "盘上躺着的图被答成不存在——画布照旧会说「素材已从工作区移除」");
    assert.strictEqual(r.json.exists["根本没有这个.png"], false, "不存在的文件被答成存在，横幅永远出不来");
    // 越界不许当成「存在」，也不许把错误当成缺失——一律按「不敢说」返回 true 见 server.js
    const esc = await post("/api/files/exists", { paths: ["../config.json"] });
    assert.strictEqual(esc.code, 200, "越界路径把接口打挂了");
  } finally {
    booted.child.kill();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
  console.log("✅ 画布素材缺失：不在那份截断列表里不算没了（深目录/超 500/请求失败三种都不冤枉）· 盘说没有才挂横幅 · 下拉不抹路径");
}

/**
 * 无限画布上的图别拿原图当缩略图。
 *
 * 用户原话：「现在无限画布还有很大文件都没有办法正常显示了啊」。
 * 现场账：节点里的预览框最高 204px（ui.css .canvas-node-preview），可短剧画布上摆的是
 * 生成出来的成图——本机工作空间里真实躺着 3552×4736 的图，一张解码后 64 MB。
 * 一块摆满三十个镜头的画布就是几个 GB 的位图，浏览器直接放弃，画面上一片空白。
 * 所以节点预览一律要 640 的缩略图，双击放大那个灯箱才给原图。
 *
 * 这儿分两头验：
 *   ① 把 canvasFileUrl 真切出来跑一遍（它只依赖 canvasState，切得动），看拼出来的地址对不对；
 *   ② 三处节点预览确实传了宽度、灯箱确实没传——这两件事只在调用处，函数本身看不出来。
 */
function testCanvasThumb() {
  const file = path.join(__dirname, "..", "public", "js", "app-07-canvas.js");
  const src = fs.readFileSync(file, "utf8");
  const from = src.indexOf("function canvasResolvedFileName(");
  const to = src.indexOf("function canvasMediaPath(");
  assert.ok(from > 0 && to > from, "切不出 canvasFileUrl 那一段了（函数被改名或搬走？）");
  // 这两个函数只认 canvasState.files，其余什么都不碰——所以能单独拎出来跑
  const build = new Function("canvasState", src.slice(from, to) + "\nreturn { canvasFileUrl, canvasResolvedFileName };");
  const { canvasFileUrl } = build({ files: [{ name: "任务_0916_短剧/镜头01_首帧.png" }] });

  // ① 工作区里的成图：短名字要能认回全路径，且带上缩略图参数
  const shot = canvasFileUrl("镜头01_首帧.png", 640);
  assert.ok(shot.startsWith("/api/files/view/"), "画布节点的图没走工作区路由：" + shot);
  assert.ok(shot.endsWith("?thumb=640"), "画布节点预览拿的是原图，不是 640 缩略图（一屏三十张成图 = 几个 GB 位图）：" + shot);
  assert.ok(shot.includes(encodeURIComponent("任务_0916_短剧")), "短名字没认回工作区里的全路径：" + shot);

  // ② 不传宽度就是原图。双击放大的灯箱走的正是这一条：那时候屏幕上就这一张，本来就该看清楚
  const full = canvasFileUrl("镜头01_首帧.png");
  assert.ok(!full.includes("thumb"), "不传宽度也偷偷缩了，灯箱里看到的就是一张糊图：" + full);

  // ③ svg 不缩：矢量本来就小，栅格化只会更大更糊
  assert.ok(!canvasFileUrl("图表.svg", 640).includes("thumb"), "svg 也去要缩略图了：" + canvasFileUrl("图表.svg", 640));

  // ④ 外链和 data: 不是本机文件，服务端缩不了，加参数只会把地址改坏
  assert.strictEqual(canvasFileUrl("https://example.com/a.png", 640), "https://example.com/a.png", "外链被加上了 ?thumb=");
  assert.strictEqual(canvasFileUrl("data:image/png;base64,AAAA", 640), "data:image/png;base64,AAAA", "data: 被加上了 ?thumb=");

  // ⑤ 已经是完整路由的地址：补参数要看清有没有问号，也不能补第二遍
  assert.strictEqual(canvasFileUrl("/api/files/view/a.png", 640), "/api/files/view/a.png?thumb=640", "完整路由没补上缩略图参数");
  assert.strictEqual(canvasFileUrl("/api/files/view/a.png?v=9", 640), "/api/files/view/a.png?v=9&thumb=640", "已经带参数了还用问号接，地址直接坏掉");
  assert.strictEqual(canvasFileUrl("/api/files/view/a.png?thumb=320", 640), "/api/files/view/a.png?thumb=320", "同一个参数补了两遍");

  // ⑥ 空值照旧是空字符串——节点上没图的时候不许拼出一个 "/api/files/view/?thumb=640" 去 404
  assert.strictEqual(canvasFileUrl("", 640), "", "没有文件名却拼出了一个地址");

  // ⑦ 调用处：三处节点预览（首帧 / 生成图 / 人物地点的内嵌图）都要传宽度
  const previews = src.match(/canvasFileUrl\([^)]*\)/g) || [];
  const withW = previews.filter((x) => /,\s*640\)/.test(x)).length;
  assert.ok(withW >= 3, "节点预览传宽度的只剩 " + withW + " 处（应有首帧 / 生成图 / 内嵌图三处）");
  // 只挑 <img>：同一个类名下面还有个 <video>（视频没有「缩略图」这回事，缩不了也不该缩）
  const nodeImgs = src.match(/<img class="canvas-node-preview[^"]*"[^>]*src="\$\{esc\(canvasFileUrl\([^)]*\)\)\}"/g) || [];
  assert.ok(nodeImgs.length >= 3, "画布节点上的 <img> 只找到 " + nodeImgs.length + " 处，对不上三处预览");
  for (const tag of nodeImgs) assert.ok(/,\s*640\)/.test(tag), "有一处节点预览还在发原图：" + tag.slice(0, 120));

  // ⑧ 反向对照：双击放大那个灯箱不许传宽度
  const lightbox = src.slice(src.indexOf("function canvasOpenImagePreview("));
  const call = (lightbox.match(/canvasFileUrl\([^)]*\)/) || [""])[0];
  assert.ok(call && !/,/.test(call), "双击放大也只给缩略图了（" + call + "）——那正是用户要看清楚的那一下");
  console.log("✅ 画布缩略图：节点预览要 640 的缩略图、双击放大仍是原图，svg / 外链 / data: 一律不动");
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
  // 判定逻辑后来整段搬去了 goal.js（网页和命令行共用一份），只有「这句话问谁」还留在 server.js。
  // 所以下面分两头看：问谁看 server.js 的 goalThink，拆解/验收的骨头看 goal.js。
  const gsrc = fs.readFileSync(path.join(__dirname, "..", "goal.js"), "utf8");

  // ① 两处「动脑」都改走 goalThink，源码里不许再直接钉死 sessLLM
  const think = src.match(/async function goalThink\(([\s\S]*?)\n}/);
  assert(think, "server.js 里没有 goalThink（Goal 的拆解/验收该由谁来答）");
  assert(/engines\.ask\(/.test(think[1]), "goalThink 没走 engines.ask：本机引擎在跑时还在偷偷花 API 的钱");
  // goal.js 自己不许认识 llm/engines：它只会调外面递进来的 think，
  // 这正是「网页用登录用户的引擎、命令行用自己那份配置」能共用一份判定逻辑的原因。
  assert(!/require\(["'][.][^"']*(llm|engines)["']\)/.test(gsrc), "goal.js 自己去 require llm/engines 了：那它就绑死在一个入口上，命令行那边又会走回老路");
  assert(/const goalThinkFor = /.test(src), "server.js 里没有 goalThinkFor：goal.js 要的 think 是谁包的？");
  for (const [re, fn, label] of [[/async function deriveCriteria\(([\s\S]*?)\n  }/, "deriveCriteria", "拆验收标准"],
                                 [/async function verify\(([\s\S]*?)\n  }/, "verify", "验收判分"]]) {
    const body = gsrc.match(re);
    assert(body, "goal.js 里找不到 " + fn);
    assert(/await think\(/.test(body[1]), fn + "（" + label + "）没走外面递进来的 think，本机引擎用户这一步永远失败");
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
  const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, OPENWORKBUDDY_DATA_DIR: dir }, encoding: "utf8" });
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

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const child = booted.child;
  const { up, port, why: bootWhy } = await booted.wait();

  const req = (method, p, body) => new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: { Cookie: "openworkbuddy_token=" + token, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
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
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);

    // 1. 干净家目录的体检表
    const a = await req("GET", "/api/onboarding");
    assert(a.code === 200 && a.json, "体检表拿不到：HTTP " + a.code + " " + a.body.slice(0, 200));
    const st = a.json;
    assert(st.needs_setup === true && st.seen === false, "新装应当 needs_setup=true / seen=false：" + JSON.stringify({ n: st.needs_setup, s: st.seen }));
    assert(st.brain && st.brain.ok === false, "没填 Key 时 brain.ok 应为 false：" + JSON.stringify(st.brain));
    assert(Array.isArray(st.models) && st.models.every((m) => typeof m.has_key === "boolean" && !("api_key" in m)), "models 要带 has_key 布尔，且绝不能把 api_key 本身吐给前端");
    // 新装不出厂任何模型行：以前那九行没 Key 的厂商模板让设置页凭空多一排「未填 Key」的空壳渠道，
    // 删了下次启动又长回来。用户原话：「不要搞什么默认渠道填充啊，都没填 apikey 的，搞这个一直占位做什么？」
    assert(st.models.length === 0, "新装 config 里不该有任何占位模型行：" + JSON.stringify(st.models.map((m) => m.name)));
    assert(Array.isArray(st.templates) && st.templates.length >= 8 && st.templates.every((t) => t.kind && t.name && t.model && typeof t.local === "boolean" && !("api_key" in t)),
      "体检表要带服务商清单 templates（向导靠它列服务商，不再靠 config 里的模板行）：" + JSON.stringify(st.templates));
    // 本机 CLI 探测要 which + --version，只在向导真要渲染时做（前端带 ?probe=1）。
    // 开机那一趟只是判断「要不要弹」，不该为它跑一遍 shell
    assert(Array.isArray(st.engines) && st.engines.length === 0, "不带 probe 的体检表不该去探本机 CLI：" + JSON.stringify(st.engines));
    const ap = await req("GET", "/api/onboarding?probe=1");
    assert(ap.code === 200 && ap.json, "带 probe 的体检表拿不到：HTTP " + ap.code + " " + ap.body.slice(0, 200));
    assert(Array.isArray(ap.json.engines) && ap.json.engines.some((e) => e.id === "claude-code") && ap.json.engines.some((e) => e.id === "codex"), "引擎清单缺 claude-code / codex：" + JSON.stringify(ap.json.engines));
    assert(ap.json.engines.every((e) => typeof e.installed === "boolean" && typeof e.install === "string"), "每个引擎要有 installed 布尔 + install 提示");
    assert(ap.json.needs_setup === st.needs_setup && ap.json.seen === st.seen, "probe 只决定探不探 CLI，别的字段必须一模一样");
    assert(st.search && typeof st.search.provider === "string" && st.search.has_key === false, "搜索状态：新装 has_key 应为 false：" + JSON.stringify(st.search));
    assert(st.media && mediaModels.CAPS.every((k) => st.media[k] === false) && Object.keys(st.media).length === mediaModels.CAPS.length, "五路多媒体新装应全 false（且一路不多一路不少）：" + JSON.stringify(st.media));
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

    // 5-bis. 首页向导填 Key：这一步以前是坏的。Key 被写在**模型条目**上，下一次规整把渠道那行的空 Key
    // 压平回来，直接抹掉；于是 hasKey 永远 false，设置页写着「未填 Key」、向导每次开机再弹一遍。
    // 用户原话：「我都在首页填了火山 APIkey，然后后台设置还说我没有设置啊」「我不是设置好了吗，怎么每次进入都让我设置啊」
    // 新装 config 里一条模型都没有了：向导从服务商清单挑一家，POST {kind, api_key}，渠道和模型行都是这一步建出来的
    assert(a5.json.templates.some((t) => t.kind === "ark"), "服务商清单里得有火山方舟：" + JSON.stringify(a5.json.templates.map((t) => t.kind)));
    const provN = (cfgOnDisk().providers || []).length;
    const WIZ_KEY = "sk-e2e-wizard-key";
    const bad = await req("POST", "/api/onboarding", { kind: "ark", api_key: "", skip_test: true });
    assert(bad.code === 400 && /Key/.test((bad.json || {}).error || ""), "云端服务商不填 Key 应 400：HTTP " + bad.code + " " + bad.body.slice(0, 200));
    assert((cfgOnDisk().providers || []).length === provN, "被拒的那次不许留下半成品渠道");
    const put = await req("POST", "/api/onboarding", { kind: "ark", api_key: WIZ_KEY, skip_test: true });
    assert(put.code === 200 && put.json && put.json.ok === true, "向导填 Key 应当成功：HTTP " + put.code + " " + put.body.slice(0, 200));
    const a6 = await req("GET", "/api/onboarding");
    assert(a6.json.needs_setup === false && a6.json.brain.ok === true && a6.json.brain.via === "api",
      "首页填完 Key，向导就不该再弹：" + JSON.stringify({ n: a6.json.needs_setup, b: a6.json.brain }));
    const c2 = cfgOnDisk();
    const ent = (c2.models || []).find((m) => m.name === put.json.active_model);
    assert(ent && ent.model && /ark\.cn-beijing/.test(ent.base_url || ""), "按模板建出来的模型行要带火山的地址和默认型号：" + JSON.stringify(ent));
    const prv = (c2.providers || []).find((p) => p.id === (ent || {}).channel);
    assert(prv && prv.api_key === WIZ_KEY, "Key 要落在渠道那一行（一把 Key 挂一排模型），不是只写在模型条目上：" + JSON.stringify({ ch: (ent || {}).channel, hit: !!prv }));
    assert(ent.api_key === WIZ_KEY, "压平回模型条目上的 Key 不能是空的——设置页那句「未填 Key」读的就是它");
    assert((c2.providers || []).length === provN + 1,
      "按模板接一家 = 恰好多一个渠道：" + provN + " → " + (c2.providers || []).length);
    const s6 = await req("GET", "/api/settings");
    const pv = ((s6.json || {}).providers || []).find((p) => p.id === ent.channel);
    assert(pv && pv.has_key === true, "设置 → 模型 里这个渠道必须显示成已填 Key：" + JSON.stringify(pv && { id: pv.id, has_key: pv.has_key }));
    // 同一家同一把 Key 再填一次不分叉（「怎么就是有两个火山模型啊」）；按已有模型行名填 Key 的老路也还得通
    const put2 = await req("POST", "/api/onboarding", { kind: "ark", api_key: WIZ_KEY, skip_test: true });
    assert(put2.code === 200 && (cfgOnDisk().providers || []).length === provN + 1 && (cfgOnDisk().models || []).length === (c2.models || []).length,
      "同一家同一把 Key 再来一次不该多出渠道或模型行：" + JSON.stringify({ p: (cfgOnDisk().providers || []).length, m: (cfgOnDisk().models || []).length }));
    const put3 = await req("POST", "/api/onboarding", { model: ent.name, api_key: WIZ_KEY, skip_test: true });
    assert(put3.code === 200 && put3.json.ok === true && put3.json.active_model === ent.name, "按已有模型行名填 Key 的老路还得通：HTTP " + put3.code + " " + put3.body.slice(0, 200));

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
    // 用户原话：「设置过了不要一直在开头一直弹窗提示啊」。以前 maybeOnboard 写的是
    // 「大脑在 且 走完过（seen）才不弹」，可 done_at 只有走完最后一步才写得上——
    // "第一步填完 Key 就跳过"的人于是每次开机再被拦一遍。这两条闸门钉住新口径
    assert(/if \(!st\.needs_setup\) return;/.test(app03) && !/!st\.needs_setup && st\.seen/.test(app03),
      "maybeOnboard 只能看 needs_setup：再把 seen 与进去，配好 Key 的人每次开机又要被拦一遍");
    assert(/async function dismissOnboarding\(/.test(app03) && /dismissOnboarding\(/.test(app03.split("async function dismissOnboarding(")[1] || ""),
      "跳过必须走 dismissOnboarding（它会在大脑已接上时把 done_at 落盘），不能只写 sessionStorage");
    assert(!/onb-skip-step["']\)[\s\S]{0,80}onbSkipFlag\(true\);[\s\S]{0,40}closeOnboarding\(\)/.test(app03),
      "还有「跳过」按钮在裸调 onbSkipFlag+closeOnboarding：那个标记关掉应用就没了");
    assert(/\/api\/onboarding\?probe=1/.test(app03) && /fetch\("\/api\/onboarding"\)/.test(app03),
      "开机判断那趟不带 probe、真弹出来那趟带 probe=1，两种调用都得在");
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    assert(/id="onb-steps"/.test(html) && /id="onb-body"/.test(html) && /\.onb-steps\s*\{/.test(html), "index.html 缺向导壳子或步骤条样式");
    const app06 = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-06.js"), "utf8");
    assert(/id="about-onb"/.test(app06) && /openOnboarding\(\)/.test(app06), "设置 → 关于 里缺「重新打开新手引导」");
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    assert(/## 命令行也能用/.test(readme) && /openworkbuddy engines use/.test(readme) && /--json/.test(readme) && /命令行用法\.md/.test(readme), "README 缺命令行一节（openworkbuddy 单发 / --json / engines use / 链到 docs）");
    const cliHelp = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
    for (const flag of ["--json", "-q", "-c", "-C", "engines use", "sessions"]) assert(cliHelp.includes(flag), "README 里写的 " + flag + " 在 cli.js 里找不到");

    console.log("✅ 首次开箱向导 API：新装体检表(不泄 Key)·大脑没接上 done 拒且不落盘·本机 CLI 算大脑·done 落 done_at+skipped 清洗+切工作目录·seen 留存 needs_setup 随大脑翻转·向导填 Key 落在渠道行不分叉、设置页当场认账·匿名 401 + 前端五步/关于页重开/README 命令行一节 静态闸门");
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

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const child = booted.child;
  const { up, port, why: bootWhy } = await booted.wait();

  const req = (method, p, body) => new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: { Cookie: "openworkbuddy_token=" + token, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
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
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);
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

    // ⑦ ★陈年旧文件不许冒充今天的产出★
    //    outputFiles() 按 mtime 倒序只取最新 500 条。任务中途造一批中间文件、干完又删掉，
    //    这个窗口就往回滑一截，几个月前的旧文件重新挤进列表——它们不在基线里，老判据
    //    （"不在基线里 = 新产出"）就把它们整批认成了这回合刚做的。用户看到的是对话末尾
    //    「本回合产出」里躺着从 0828 到今天的几百个文件，这次真做的 8 张卡被埋在最底下。
    //    用户原话：「还有这里也是灾难啊，把产出文件给删除了，下面这里显示的全部文件出来啊」。
    {
      const { evs, e } = mk(0);
      e.push(true);
      const n0 = evs.length;
      // 造一个"刚挤进窗口的旧文件"：发射器建完之后才出现（所以不在基线里），但 mtime 是几个月前
      const stale = path.join(ws, DIR, "半年前的稿子.md");
      fs.writeFileSync(stale, "old");
      const longAgo = new Date("2026-03-01T00:00:00Z");
      fs.utimesSync(stale, longAgo, longAgo);
      // 同一轮里再写一个真·今天的产出，验闸门只拦旧的、不误伤新的
      fs.writeFileSync(path.join(ws, DIR, "今天的成品.html"), "<b>new</b>");
      e.push(true);
      e.stop();
      const chg = evs[evs.length - 1].changed || [];
      assert(!chg.includes(DIR + "/半年前的稿子.md"),
        "半年前的文件被认成了这回合的产出：对话里那块「本回合产出」会把整个工作目录倒出来，真正的成果被埋在最底下");
      assert(chg.includes(DIR + "/今天的成品.html"),
        "★负向对照★ 时间闸把真的新产出也拦掉了——那就从「多显示几百个」变成「一个都不显示」");
      assert(evs[evs.length - 1].files.some((f) => f.name === DIR + "/半年前的稿子.md"),
        "旧文件不该进 changed，但它在工作目录里是真实存在的，右侧面板的清单里必须还有它");
    }

    // ⑧ ★用户自己粘进来的图不是产出★
    //    任务还在跑，用户粘一张图进输入框想追问。/api/upload 把它落进**这条会话的成果文件夹**
    //    （那一步是对的，素材要和成果待在一起），于是两道闸全都拦不住它：文件夹是自己的、
    //    mtime 在开跑之后。结果就是上一轮的「本回合产出」里凭空多出一张用户自己的图。
    //    用户原话：「我复制一个图片来问问题结果，之前执行的成果区出现了我在问问题的图片啊」。
    {
      const { evs, e } = mk(0);
      e.push(true);
      const PASTED = DIR + "/粘进来问问题的图.png";
      fs.writeFileSync(path.join(ws, PASTED), "PNGDATA");
      tools.noteUserInput(PASTED);                       // ← /api/upload 落盘之后记的那一笔
      fs.writeFileSync(path.join(ws, DIR, "真产出.html"), "<b>done</b>");
      e.push(true);
      const chg = evs[evs.length - 1].changed || [];
      assert(!chg.includes(PASTED), "用户粘进来问问题的图被当成了这一轮的产出");
      assert(chg.includes(DIR + "/真产出.html"),
        "★负向对照★ 这道闸把同一轮里真正的产出也拦掉了——那就从「多一张」变成「一张都没有」");
      assert(evs[evs.length - 1].files.some((f) => f.name === PASTED),
        "它不算产出，但它是工作目录里真实存在的文件：右侧面板和资料库里必须还看得见");
      e.stop();
    }

    // ⑧' 但 agent 后来真把这张图改写了（抠图、压缩、换格式），它就成了产出，该出现在卡片里。
    //     所以那笔账钉的是「名字 + 那一刻的 mtime」，不是只钉名字——只钉名字的话，这张图
    //     在这条会话里永远翻不了身。
    {
      const { evs, e } = mk(0);
      const PASTED = DIR + "/待抠图.png";
      fs.writeFileSync(path.join(ws, PASTED), "RAW");
      tools.noteUserInput(PASTED);
      e.push(true);
      assert(!(evs[evs.length - 1].changed || []).includes(PASTED), "上传这一刻就不该算产出");
      fs.writeFileSync(path.join(ws, PASTED), "AGENT-EDITED");   // agent 改写
      const later = new Date(Date.now() + 1500);
      fs.utimesSync(path.join(ws, PASTED), later, later);         // mtime 一定得真的变（同毫秒写两次是会重的）
      e.push(true);
      assert((evs[evs.length - 1].changed || []).includes(PASTED),
        "agent 改写过之后它就是产出了，卡片里必须有——不然用户根本看不到抠图的结果");
      e.stop();
    }

    // ⑧'' 上传是**先落根目录、等成果文件夹建好再搬进去**的（见 server.js 的 assignSessionDir）。
    //      那笔账记的是路径，搬完不改键，这张图换个位置就又变回「产出」了。
    {
      const { evs, e } = mk(0);
      e.push(true);
      fs.writeFileSync(path.join(ws, "先落根目录的图.png"), "PNGDATA");
      tools.noteUserInput("先落根目录的图.png");
      fs.renameSync(path.join(ws, "先落根目录的图.png"), path.join(ws, DIR, "先落根目录的图.png"));
      tools.moveUserInput("先落根目录的图.png", DIR + "/先落根目录的图.png");
      e.push(true);
      assert(!(evs[evs.length - 1].changed || []).includes(DIR + "/先落根目录的图.png"),
        "搬进成果文件夹之后那笔账没跟着改键，这张图又被当成产出了");
      e.stop();
      // ★反向对照★：同样的搬家，不改键——必须被认成产出。不做这一条的话，上面那句
      // 断言完全可能是靠别的原因绿的（比如整段逻辑压根没跑），改键有没有用就没人知道
      const two = mk(0);
      two.e.push(true);
      fs.writeFileSync(path.join(ws, "忘了改键的图.png"), "PNGDATA");
      tools.noteUserInput("忘了改键的图.png");
      fs.renameSync(path.join(ws, "忘了改键的图.png"), path.join(ws, DIR, "忘了改键的图.png"));
      two.e.push(true);
      assert((two.evs[two.evs.length - 1].changed || []).includes(DIR + "/忘了改键的图.png"),
        "★反向对照★ 不改键居然也没被当成产出：说明上面那条绿得不明不白，这道闸的效果没被真正量到");
      two.e.stop();
    }
  } finally {
    tools.setWorkspaceDir(prevWs);
    fs.rmSync(ws, { recursive: true, force: true });
  }
  console.log("✅ 产出清单发射器：不写盘就不推（100 步只 1 条）· 写了的晚一点也一定到 · 删除照推 · 别人文件夹不记账 · 收摊后闭嘴 · 收尾同步发 · 陈年旧文件冒充不了今天的产出 · 用户粘进来问问题的图不算产出（改写过就算、搬过家也认得住，两条反向对照）");
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

  // 量一趟 read_file：跑完返回结果和这段时间里事件循环的最大抖动。
  // 超线就再量一遍、取小的那次——同步阻塞是代码里写死的，每趟都重现；GC 的一下抖动不会。
  // （这儿真踩过：上面那句"奢侈一次"的 readFileSync 把 6MB 读成字符串又 split 成 6 万条，
  //  它的回收正好落进下一次测量窗口，量出 61ms 顶着 60ms 的线挂掉，可 read_file 一个字节没改。
  //  阈值不能为这个往上抬——抬了就等于把真正要拦的那 180ms 也放进来了。）
  const LAG_MAX = 60;
  const timed = async (fn) => {
    const m = lagMeter();
    const out = await fn();
    return { out, lag: await m.stop() };
  };
  const timedSteady = async (fn) => {
    const first = await timed(fn);
    if (first.lag < LAG_MAX) return first;
    const again = await timed(fn);
    return again.lag < first.lag ? again : first;
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
      const { out: r, lag } = await timedSteady(() => tools.executeTool("read_file", { path: "服务日志.log" }, {}));
      assert(lag < LAG_MAX, `整份读大文件把事件循环钉住了 ${lag.toFixed(0)}ms（连量两趟都超）`);
      assert(r.content.startsWith(line(0)), "开头那截读错了：" + r.content.slice(0, 60));
      assert(/太大了不整份读进来/.test(r.content) && /start_line/.test(r.content), "没告诉模型这是截断的、也没说下一步怎么拿后面的：" + r.content.slice(-160));
      assert(!r.content.includes("�"), "块边界把汉字切坏了（出现了 U+FFFD 乱码）");
    }

    // ⑤ 指定行段：行号、行内容、总行数都必须跟"整份读进来再 split"的口径一模一样
    {
      const truth = fs.readFileSync(big, "utf8").split("\n"); // 测试里可以奢侈一次
      const { out: r, lag } = await timedSteady(() =>
        tools.executeTool("read_file", { path: "服务日志.log", start_line: 59990, end_line: 60000 }, {}));
      assert(lag < LAG_MAX, `按行段读大文件把事件循环钉住了 ${lag.toFixed(0)}ms（连量两趟都超）`);
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
  // 不能拿 LENDABLE 的长度直接比：桥是个纯 node 子进程，没有 Electron，要真浏览器的那两个
  // 会被摘掉。挂一个必然抛「需要桌面版环境」的工具，比不挂更糟——CLI 那头的模型会先照着
  // 做一遍、吃一条必然的失败、再回来重想，白烧一轮
  const NEED_GUI = ["html_to_image", "render_page"];
  assert(Array.isArray(listed) && listed.length === tb.LENDABLE.length - NEED_GUI.length,
    `tools/list 返回的工具数不对：${listed.length}（白名单 ${tb.LENDABLE.length} 个，这个进程里该摘掉 ${NEED_GUI.length} 个要浏览器的）`);
  assert(!listed.some((t) => NEED_GUI.includes(t.name)), "要真浏览器的工具挂上桥了");
  assert(listed.some((t) => t.name === "read_document"), "read_document 没借给 CLI：它们自带的读文件工具读 Office 只会得到乱码");
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
 * 安全档位要真的落到本机 CLI 的命令行上。
 *
 * 为什么非测不可：这两个 CLI 自带工具、自带循环，它们写文件、跑命令**不经过**本项目的
 * 安全中心（只有从 MCP 桥回流的那批才走那道闸）。以前 claude 这条路硬写死 acceptEdits、
 * codex 这条路硬写死 workspace-write，于是用户在设置页把档位调到「只看不动」、
 * 切到本机引擎照样随便改文件——界面上那颗开关是个摆设，而且是最不能当摆设的那一颗。
 *
 * 这儿看三层：翻译表对不对 · claude 的 argv 上真出现了那些开关 · codex 的 -c sandbox_mode 跟着变。
 * 全程不跑真 CLI：拿一个假可执行文件当靶子，把它收到的 argv 原样写回来。
 */
async function testEngineSecurityGuard() {
  const os = require("os");
  const security = require("../security");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-guard-"));

  // ① 四个档位各翻成什么。名单里写的是前缀（"sudo "、"diskutil erase"），
  //    CLI 那边的匹配单位是可执行文件名，所以该取第一个词
  const SEC = { cmd_ask: ["sudo ", "diskutil erase"], delete_protect: true };
  const G = (mode, extra) => security.engineGuard({ ...SEC, ...(extra || {}), permission_mode: mode });
  const table = {
    plan: ["plan", "read-only", false],
    ask: ["default", "read-only", true],
    auto: ["acceptEdits", "workspace-write", true],
    full: ["bypassPermissions", "workspace-write", true],
  };
  for (const [mode, [claudeMode, codexSandbox, allowShim]] of Object.entries(table)) {
    const g = G(mode);
    assert.strictEqual(g.mode, mode, mode + " 档位自己都认错了");
    assert.strictEqual(g.claudeMode, claudeMode, "★" + mode + " 没翻成 claude 的 " + claudeMode + "★ 用户选的档位到这条路上就丢了：" + g.claudeMode);
    assert.strictEqual(g.codexSandbox, codexSandbox, "★" + mode + " 没翻成 codex 的 " + codexSandbox + "★：" + g.codexSandbox);
    assert.strictEqual(g.allowShim, allowShim, mode + " 档位下「放不放行本项目借出去的命令行入口」判错了：" + g.allowShim);
  }
  // 「只看不动」连本项目借出去的那条命令行入口也不放：那批工具是能写文件的，
  // 从这道后门绕开档位，跟没设过没区别
  assert.strictEqual(G("plan").allowShim, false, "★只看不动还把命令行入口放行了★ 模型从这道后门照样写文件");

  // ② 「这类命令要问我一下」在这条路上问不着（-p 非交互），只剩不给用
  const dis = G("auto").disallow;
  assert(dis.includes("Bash(sudo:*)"), "sudo 没进禁用名单：" + JSON.stringify(dis));
  assert(dis.includes("Bash(diskutil:*)"), "★「diskutil erase」没收紧成整个 diskutil★ CLI 那边只认可执行文件名，带空格的写法等于没禁：" + JSON.stringify(dis));
  assert(dis.includes("Bash(rm:*)"), "删除保护是另一颗开关（不在 cmd_ask 里），也得跟上：" + JSON.stringify(dis));
  assert(!G("auto", { delete_protect: false }).disallow.includes("Bash(rm:*)"),
    "用户把删除保护关了，这儿还自作主张禁 rm");
  // 全自动那一档的意思就是别再拦了：再往里塞禁用名单就是不听人话
  assert.deepStrictEqual(G("full").disallow, [], "全自动档不该再给禁用名单：" + JSON.stringify(G("full").disallow));
  assert.strictEqual(G("full").note, "", "全自动档没收紧任何东西，不该在运行页刷一句废话");
  // 档位收紧了必须明说一句。不说的话，用户看到的是「它怎么什么都不肯干」，
  // 而真正的原因在另一个页面上的一颗开关里，隔着两层根本联系不起来
  for (const mode of ["plan", "ask", "auto"]) {
    assert(G(mode).note && G(mode).note.length > 10, "★" + mode + " 档位把事情收紧了却一声不吹★ 用户只会觉得它坏了：" + JSON.stringify(G(mode).note));
  }
  // 反向对照：没填 / 填了个不认识的档位，得落回默认（auto），不能成 undefined 又一路传到命令行上
  for (const bad of [undefined, null, {}, { permission_mode: "乱写的" }]) {
    const g = security.engineGuard(bad);
    assert.strictEqual(g.claudeMode, "acceptEdits", "档位认不出来时没落回默认：" + JSON.stringify(g));
    assert.strictEqual(g.codexSandbox, "workspace-write", "档位认不出来时 codex 那边没落回默认：" + JSON.stringify(g));
  }

  // ③ claude 的 argv：拿一个假 CLI 当靶子，把它收到的参数原样写回来
  const argvOut = path.join(home, "argv.json");
  const fakeClaude = path.join(home, "fakeclaude");
  fs.writeFileSync(fakeClaude, [
    "#!/usr/bin/env node",
    'require("fs").writeFileSync(' + JSON.stringify(argvOut) + ", JSON.stringify(process.argv.slice(2)));",
    'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok", usage: {} }) + String.fromCharCode(10));',
  ].join("\n"));
  fs.chmodSync(fakeClaude, 0o755);

  const ccArgv = async (opts) => {
    await require("../engines/claude-code").run({ prompt: "hi", cwd: home, bin: fakeClaude, shimBin: "owb", ...opts });
    return JSON.parse(fs.readFileSync(argvOut, "utf8"));
  };
  const pairsOf = (argv, flag) => argv.map((a, i) => (a === flag ? argv[i + 1] : null)).filter(Boolean);

  const aPlan = await ccArgv({ guard: G("plan") });
  assert.deepStrictEqual(pairsOf(aPlan, "--permission-mode"), ["plan"],
    "★只看不动没落到 claude 的命令行上★ 用户选的是只读，它照样写文件：" + JSON.stringify(pairsOf(aPlan, "--permission-mode")));
  assert(!pairsOf(aPlan, "--allowed-tools").includes("Bash(owb:*)"),
    "★只看不动还给命令行入口下了放行规则★ 这批工具能写文件，等于从后门绕开了档位");

  const aAuto = await ccArgv({ guard: G("auto") });
  assert.deepStrictEqual(pairsOf(aAuto, "--permission-mode"), ["acceptEdits"], "自动改文件档没落对");
  assert(pairsOf(aAuto, "--allowed-tools").includes("Bash(owb:*)"), "这一档该放行命令行入口，不放模型敲了也白敲");
  const disAuto = pairsOf(aAuto, "--disallowed-tools");
  assert(disAuto.includes("Bash(rm:*)") && disAuto.includes("Bash(sudo:*)"),
    "★名单上说要问的命令没禁掉★ 这条路没有审批通道，不禁就是直接放行：" + JSON.stringify(disAuto));

  const aFull = await ccArgv({ guard: G("full") });
  assert.deepStrictEqual(pairsOf(aFull, "--permission-mode"), ["bypassPermissions"], "全自动档没落对");
  assert.deepStrictEqual(pairsOf(aFull, "--disallowed-tools"), [], "全自动档还在命令行上塞禁用名单：" + JSON.stringify(pairsOf(aFull, "--disallowed-tools")));

  // 反向对照：设置里给这个引擎手填的 engine_options 仍然最大——手填是更明确的表态
  const aManual = await ccArgv({ guard: G("plan"), permissionMode: "bypassPermissions" });
  assert.deepStrictEqual(pairsOf(aManual, "--permission-mode"), ["bypassPermissions"],
    "engine_options 里手填的档位被档位翻译表盖掉了：" + JSON.stringify(pairsOf(aManual, "--permission-mode")));
  // 反向对照：没人传 guard（老调用方、单元测试）时行为一个字节不变
  const aNone = await ccArgv({});
  assert.deepStrictEqual(pairsOf(aNone, "--permission-mode"), ["acceptEdits"], "不传 guard 时的老行为变了");
  assert(pairsOf(aNone, "--allowed-tools").includes("Bash(owb:*)"), "不传 guard 时不该把命令行入口也收了");

  // ④ codex 的 argv：沙箱档位走 -c sandbox_mode（这个子命令不收 -s）
  const fakeCodex = path.join(home, "fakecodex");
  fs.writeFileSync(fakeCodex, [
    "#!/usr/bin/env node",
    'require("fs").writeFileSync(' + JSON.stringify(argvOut) + ", JSON.stringify(process.argv.slice(2)));",
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + String.fromCharCode(10));',
    'process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + String.fromCharCode(10));',
  ].join("\n"));
  fs.chmodSync(fakeCodex, 0o755);

  const cxArgv = async (opts) => {
    await require("../engines/codex").run({ prompt: "hi", cwd: home, bin: fakeCodex, ...opts });
    return JSON.parse(fs.readFileSync(argvOut, "utf8"));
  };
  const sandboxOf = (argv) => {
    const cs = argv.map((a, i) => (a === "-c" ? argv[i + 1] : null)).filter(Boolean);
    const hit = cs.find((c) => String(c).startsWith("sandbox_mode="));
    return hit ? String(hit).slice("sandbox_mode=".length).replace(/"/g, "") : "";
  };
  for (const [mode, want] of [["plan", "read-only"], ["ask", "read-only"], ["auto", "workspace-write"], ["full", "workspace-write"]]) {
    const got = sandboxOf(await cxArgv({ guard: G(mode) }));
    assert.strictEqual(got, want,
      "★codex 的沙箱没跟着" + mode + "走★ 用户选的档位到这条路上就丢了：" + got);
  }
  assert.strictEqual(sandboxOf(await cxArgv({ guard: G("plan"), sandbox: "danger-full-access" })), "danger-full-access",
    "engine_options 里手填的 sandbox 被档位翻译表盖掉了");
  assert.strictEqual(sandboxOf(await cxArgv({})), "workspace-write", "不传 guard 时 codex 的老行为变了");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("✅ 安全档位真的传到了本机 CLI：只看不动→claude plan / codex read-only且连借出去的命令行入口都不放行 · 名单上说要问的命令（含删除保护）在这条没审批通道的路上直接禁 · 全自动不多拦一下 · 手填的 engine_options 仍然最大 · 收紧了会在运行页明说一句");
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
    const strays = [...slugs].filter((sl) => sl !== "CatCatUncle/openworkbuddy" && !REFERENCE_REPOS.has(sl));
    assert(slugs.has("CatCatUncle/openworkbuddy") && strays.length === 0, name + " 指向了别的仓库：" + strays.join(","));
    assert(/img\.shields\.io\/github\/stars\/CatCatUncle\/openworkbuddy/.test(t), name + " 缺 Star 徽章");
  }
  // 首屏三句差异
  const why = zh.split(/^## 为什么是它\s*$/m)[1];
  assert(why, "README 缺「为什么是它」");
  const whyBody = why.split(/^## /m)[0];
  for (const kw of ["文件是真的", "模型随便换", "加个能力 = 丢一个 Markdown 文件"]) assert(whyBody.includes(kw), "「为什么是它」缺：" + kw);
  const whyEn = (en.split(/^## Why this one\s*$/m)[1] || "").split(/^## /m)[0];
  for (const kw of ["The files are real", "Swap models freely", "one Markdown file"]) assert(whyEn.includes(kw), "英文「Why this one」缺：" + kw);
  // 最新动态：日期真实
  const git = (a) => require("child_process").execSync(a, { cwd: root, encoding: "utf8" });
  // 浅克隆里 git log 只剩 HEAD 那一天，拿它当底本核对，每条动态都会被判成假的，
  // 报出来还是「09-11 那天没有提交」——看日志的人会去翻 README，而错在 checkout 的默认值。
  // CI 上靠 releasePipelineDrift 钉死 fetch-depth: 0；这里只兜别人手动浅克隆的情况：
  // 明说这条没验，条数 / 倒序 / 字数照验，不假装绿。
  const shallow = git("git rev-parse --is-shallow-repository").trim() === "true";
  if (shallow) console.log("  ⚠️  浅克隆仓库，「最新动态」的日期真实性这条跳过了（git log 只有 HEAD 那一天）");
  const gitDays = new Set(git("git log --date=format:%m-%d --format=%ad").split("\n").filter(Boolean));
  const news = (zh.split(/^## 最新动态\s*$/m)[1] || "").split(/^## /m)[0];
  const items = [...news.matchAll(/^- \*\*(\d\d-\d\d)\*\* (.+)$/gm)];
  assert(items.length >= 6, "「最新动态」至少 6 条带日期的条目，现在 " + items.length);
  for (const [, d, txt] of items) {
    assert(shallow || gitDays.has(d), "「最新动态」写了 " + d + "，git 里那天没有提交");
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
  // README 只留最近几条，全量在 CHANGELOG——两份是手工对齐的，没有生成器。
  // 漂了的后果很轻但很丢人：README 吹了一条功能，点「更早的看变更记录」进去发现那条根本不在。
  //
  // 原来是逐字比对：README 的每一条必须是 CHANGELOG 里的原句。现在不行了——
  // 「最新动态」被刻意改写成一句人话（读者是来看这东西能干嘛的，不是来看 commit 的），
  // CHANGELOG 那边仍然是长技术条目，两边永远对不上字。
  // 改成按「同一天 + 说的是同一件事」比：日期在 CHANGELOG 里必须真有条目，
  // 且那天至少有一条跟它共享足够多的词（中文二元组和拉丁词一起数）。
  // 松了一档，换来 README 能说人话；编一条不存在的功能照样当场红——
  // 下面第二条反向断言就是拿「日期真实、内容瞎编」的那种来验这件事。
  const chZh = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const chEn = fs.readFileSync(path.join(root, "CHANGELOG.en.md"), "utf8");
  const RE_ZH = /^- \*\*(\d\d-\d\d)\*\* (.+)$/gm, RE_EN = /^- \*\*([A-Z][a-z]{2} \d{1,2})\*\* (.+)$/gm;
  const toks = (t) => {
    const out = new Set(t.toLowerCase().match(/[a-z]{3,}/g) || []);
    const cj = t.replace(/[^\u4e00-\u9fff]/g, "");
    for (let i = 0; i + 1 < cj.length; i++) out.add(cj.slice(i, i + 2));
    return out;
  };
  const shared = (a, b) => { const B = toks(b); let n = 0; for (const t of toks(a)) if (B.has(t)) n++; return n; };
  const MIN_SHARED = 3;   // 实测最少的一条共享 4 个，留一档余量；纯编的一条只有 0～1 个
  const drift = (readme, full, re, name) => [...readme.matchAll(re)].map(([, d, txt]) => {
    const sameDay = [...full.matchAll(re)].filter((m) => m[1] === d).map((m) => m[2]);
    if (!sameDay.length) return `${name} 的「${txt.slice(0, 18)}…」写的是 ${d}，CHANGELOG 那天一条都没有`;
    const best = Math.max(...sameDay.map((c) => shared(txt, c)));
    return best >= MIN_SHARED ? null : `${name} 的「${txt.slice(0, 18)}…」在 CHANGELOG 的 ${d} 里找不到对应那件事（最多只共享 ${best} 个词）`;
  }).filter(Boolean);
  const drifted = [...drift(news, chZh, RE_ZH, "README.md"), ...drift(newsEn, chEn, RE_EN, "README.en.md")];
  assert(drifted.length === 0, "README 和 CHANGELOG 走散了：\n  " + drifted.join("\n  "));
  const nZh = [...chZh.matchAll(RE_ZH)].length, nEn = [...chEn.matchAll(RE_EN)].length;
  assert(nZh === nEn, `中英 CHANGELOG 条数对不上（${nZh} vs ${nEn}）：加动态时两份都要加`);
  assert(nZh >= items.length, "CHANGELOG 比 README 还短，那它就不是「全量」了");
  // 反向对照两条，不然上面那条只证明了「我没在找」
  assert(drift("- **01-01** 这天其实什么都没发生", chZh, RE_ZH, "x").length === 1, "漂移闸门失灵：CHANGELOG 里根本没有的日期居然没红");
  assert(drift(`- **${items[0][1]}** 支持把会议纪要一键烧进区块链做存证`, chZh, RE_ZH, "x").length === 1, "漂移闸门失灵：日期真实、内容瞎编的一条居然没红");
  // README 指向的文档得真的在。移动一份文档而忘了改链接，读者点进去是 404
  const docLinks = [...zh.matchAll(/\]\((docs\/[^)#]+|deploy\/README\.md|CHANGELOG\.md|CONTRIBUTING\.md)[)#]/g)].map((m) => m[1]);
  assert(docLinks.length >= 12, "README 的文档链接只扫出 " + docLinks.length + " 条，正则八成没匹配上");
  const gone = [...new Set(docLinks)].filter((f) => !fs.existsSync(path.join(root, f)));
  assert(gone.length === 0, "README 链到了不存在的文档：" + gone.join(" "));
  console.log("✅ README 门面闸门：中英互链·只指本仓库·首屏三句差异·最新动态 " + items.length + " 条日期均有真实提交且倒序·二维码 PNG " + w + "x" + h + "·协议一句人话·技能模板+锚点·无「一个人做」措辞·README 每条动态都能在 CHANGELOG（中英各 " + nZh + " 条）里找到（反向对照通过）·" + docLinks.length + " 条文档链接都在");
}

// 「去哪拿 Key」闸门：向导和设置页每个要填 Key 的地方都得有一条直达链接，链接全 https + 新窗口。
// 写成纯函数以便下面拿变体做反向对照——闸门自己得先证明它拦得住。
function keySourcesCheck(app03, app05, toolsSrc, mmSrc) {
  const vm = require("vm");
  const grab = (src, head, close) => {
    const i = src.indexOf(head);
    assert(i >= 0, "源码里没有 " + head.trim());
    const j = src.indexOf(close, i);
    assert(j > i, head.trim() + " 没收尾");
    return src.slice(i + head.length, j + close.length - 1);
  };
  const KS = vm.runInNewContext("(" + grab(app03, "const KEY_SOURCES = ", "\n};") + ")");
  const kinds = vm.runInNewContext("(" + grab(mmSrc, "const PROVIDER_KINDS = ", "\n];") + ")");
  const media = vm.runInNewContext("(" + grab(app03, "const ONB_MEDIA_PRESETS = ", "\n};") + ")");
  const problems = [];
  for (const [id, v] of Object.entries(KS)) {
    if (!v || !/^https:\/\/[^\s"']+$/.test(v.url || "")) problems.push(`${id} 的链接不是 https 直达地址`);
    if (!v || !v.name) problems.push(`${id} 没写服务商名`);
  }
  // 渠道表就是那份「预设」——用户建渠道时从这张表里选一家，所以每一家都得能领到 Key。
  // 自建网关和「其它 OpenAI 兼容接口」指的是用户自己的机器，没有官网可指，是这条规矩的例外。
  for (const k of kinds) {
    if (k.kind === "newapi" || k.kind === "custom") continue;
    if (!/^https:\/\/[^\s"']+$/.test(k.key_url || "")) problems.push(`渠道「${k.label}」没有取 Key 链接`);
    // Anthropic 官方没有接口地址（SDK 自带），别家都得带一个能填进去的默认地址
    if (k.kind !== "anthropic" && !/^https?:\/\//.test(k.base_url || "")) problems.push(`渠道「${k.label}」没写默认接口地址`);
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
  // 「未填 Key」现在只在渠道那一层提一次（模型行不再各喊各的），所以钉的是渠道卡和渠道表单
  for (const [pane, re] of [
    ["设置·渠道表单", /#pf-key-src"\)\.innerHTML = kindKeyLink\(/],
    // 「去拿 Key」跟着输入框走：卡里能直接填 Key 之后，链接就该贴在保存钮边上，
    // 而不是继续挂在「未填 Key」那颗角标上——人是在这一行里犯难的，不是在角标上
    ["设置·渠道卡片里的 Key 输入行", /class="btn-brand ck-save"[\s\S]{0,160}\$\{kindKeyLink\(p\.kind, p\.base_url\)\}/],
    ["设置·渠道回退到 KEY_SOURCES", /return keyLink\(modelKeySource\(\{ base_url: baseUrl/],
    ["设置·IM 卡片", /class="im-src">\$\{keyLink\(c\.src\)\}/],
  ]) {
    if (!re.test(app05)) problems.push(`${pane} 没接 keyLink`);
  }
  return { KS, presets: kinds.filter((k) => k.kind !== "newapi" && k.kind !== "custom").length, searchIds, imSrcs: new Set(imSrcs).size, mediaN, problems };
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
/**
 * 第三方署名有没有跟着依赖走。
 *
 * 这是个商业化项目：桌面包里 `asar: false`，node_modules 原样躺在里面发给用户，
 * 别人的 MIT/Apache 代码就这么被我们分发出去了。许可要求的署名如果只写在某个
 * HTML 注释里（lucide 当初就是），或者加了新依赖忘了登记，法务上就是漏的——
 * 而这种漏永远不会自己冒出来，它不报错、不崩溃、跑分也不掉。
 *
 * 所以把它钉成闸门：package.json 里每一条运行时依赖，NOTICE.md 里都得有名字。
 */
function noticeDrift(deps, notice) {
  const missing = [];
  for (const name of Object.keys(deps || {})) {
    // 按整词找，避免 "docx" 被 "docxtemplater" 这类名字蒙混过去
    const re = new RegExp("(^|[\\s|`])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[\\s|`])", "m");
    if (!re.test(notice)) missing.push(name);
  }
  return { missing, checked: Object.keys(deps || {}).length };
}

function testNoticeCoverage() {
  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const notice = fs.readFileSync(path.join(root, "NOTICE.md"), "utf8");
  const r = noticeDrift(pkg.dependencies, notice);
  assert(r.missing.length === 0, "这些依赖发出去了却没在 NOTICE.md 里署名：" + r.missing.join("、"));
  assert(r.checked >= 8, "扫到的依赖太少（" + r.checked + "），说明读错了 package.json");
  // 内联进页面的那套图标不是 npm 依赖，package.json 里查不到，只能单独钉
  assert(/[Ll]ucide/.test(notice) && /\bISC\b/.test(notice), "NOTICE.md 里漏了内联图标 sprite 的 ISC 署名");
  assert(/PolyForm/.test(notice), "NOTICE.md 得先说清楚本体是什么许可，否则读者不知道这份清单是谁的清单");
  // 反向对照：凭空多一条依赖必须被抓；名字被别的词包住也必须被抓
  const f1 = noticeDrift({ ...pkg.dependencies, "某个没登记的包": "1.0.0" }, notice).missing;
  assert(f1.length === 1, "★闸门失效：加了一条没署名的依赖却没被抓出来★");
  // 这条对照文里千万别再出现独立的 docx 三个字母，否则对照自己就把自己喂饱了
  const f2 = noticeDrift({ docx: "1" }, "本文件只提到了 docxtemplater 这一个名字").missing;
  assert(f2.length === 1, "★闸门失效：docx 被 docxtemplater 蒙混过关了★");
  const f3 = noticeDrift({ docx: "1" }, "| docx | 9.7.1 | MIT |").missing;
  assert(f3.length === 0, "表格里明明写了 docx 却判成没署名，闸门太严会逼人乱改文档");
  // 光写对还不够，这份署名得真跟着包走。桌面版 asar:false，node_modules 原样发出去，
  // 而 files 是白名单——NOTICE.md 不点名就一个字都不进包，等于分发了别人的代码却没带署名。
  // 这种漏不报错、不崩溃，只有翻开装机包才看得见，所以钉在这儿。
  // LICENSE-ECOSYSTEM.md 也在这儿：LICENSE 正文点名让人去它那儿看「哪些路径按 MIT」，
  // 它不进包的话，装机版里那句话指向一个不存在的文件——比不写还糟
  const legal = ["LICENSE", "COMMERCIAL-LICENSE.md", "LICENSE-ECOSYSTEM.md", "NOTICE.md"];
  const shipped = (globs) => legal.filter((f) => !globs.includes(f));
  const cfgFiles = require(path.join(root, "electron-builder.config.js")).files;
  assert(shipped(cfgFiles).length === 0, "这几份法务文件没进安装包白名单：" + shipped(cfgFiles).join("、"));
  assert(shipped(cfgFiles.filter((g) => g !== "NOTICE.md")).length === 1, "★闸门失效：把 NOTICE.md 从白名单里拿掉居然没红★");
  console.log(`✅ 第三方署名不漂移：${r.checked} 条运行时依赖在 NOTICE.md 里全有名字（内联图标的 ISC 单独钉住）· ${legal.length} 份法务文件都进安装包 · 4 种坏法全被抓`);
}

/**
 * 内网 / 私有化：不少客户是国央企，机器上不去外网，也不让用国外组件。
 *
 * 要命的是这种环境下**连不上不等于立刻失败**——防火墙默默丢包、不回 RST，
 * 于是每一处外链都变成"等满超时"。所以这里钉三件事：
 *   ① 交付物里一个外链都不许有（含 Google Fonts，实测内网首屏白等 5.1 秒）；
 *   ② 连接器目录每条都要说清楚"内网能不能用"，别让人填完 Key 再对着超时发呆；
 *   ③ 开关本身认得出来、而且配置文件坏了不会误判成"打开"。
 * 这几处散在四个文件里，改一处忘三处不报错也不崩，只能在这儿钉住。
 */
async function testIntranet() {
  const root = path.join(__dirname, "..");
  const { isIntranet } = require("../intranet");
  const { catalog, ITEMS } = require("../mcp-catalog");

  // ---- ① 开关 ----
  assert(isIntranet({ env: {}, cfg: {} }) === false, "默认居然是内网模式");
  assert(isIntranet({ env: { OWB_INTRANET: "1" }, cfg: {} }), "OWB_INTRANET=1 没打开内网模式");
  assert(isIntranet({ env: { OWB_INTRANET: "true" }, cfg: {} }), "OWB_INTRANET=true 没认");
  assert(isIntranet({ env: {}, cfg: { intranet: true } }), "config.json 里的 intranet 没认");
  // 一台设了全局变量的机器上要能单独关掉，所以显式的 0 必须压过 config
  assert(isIntranet({ env: { OWB_INTRANET: "0" }, cfg: { intranet: true } }) === false, "显式 OWB_INTRANET=0 没能压过 config");
  // 配置写坏了、写成字符串了，都不是"打开内网模式"的理由——
  // 误开的后果是一台好机器上所有境外连接器凭空排到最后并标成连不上
  assert(isIntranet({ env: {}, cfg: { intranet: "true" } }) === false, "字符串 \"true\" 被当成了真，配置写错就会误开");
  assert(isIntranet({ env: {}, cfg: { intranet: 1 } }) === false, "数字 1 被当成了真");
  assert(isIntranet({ env: { OWB_INTRANET: "" }, cfg: {} }) === false, "空环境变量被当成了打开");
  // 正名是 OPENWORKBUDDY_INTRANET（跟 OPENWORKBUDDY_DATA / _PORT 一个前缀）；OWB_ 那个是旧名。
  // 旧名必须继续认：它已经写在别人的 systemd / docker-compose 里，改名当天要是悄悄失效，
  // 一台出不了网的机器会重新显示「一切正常」，用户填完 Key 等到超时才发现。
  assert(isIntranet({ env: { OPENWORKBUDDY_INTRANET: "1" }, cfg: {} }), "OPENWORKBUDDY_INTRANET=1 没打开内网模式");
  assert(isIntranet({ env: { OPENWORKBUDDY_INTRANET: "0" }, cfg: { intranet: true } }) === false, "显式 OPENWORKBUDDY_INTRANET=0 没能压过 config");
  assert(isIntranet({ env: { OPENWORKBUDDY_INTRANET: "", OWB_INTRANET: "1" }, cfg: {} }), "新名字留了个空串，旧名字就不认了——只改了一半的机器会被这行救回来");
  assert(/OPENWORKBUDDY_INTRANET/.test(fs.readFileSync(path.join(root, "skills.js"), "utf8")),
    "skills.js 那句给用户看的提示还在教人设旧名字 OWB_INTRANET");

  // ---- ② 连接器目录 ----
  const noTag = ITEMS.filter((it) => !["local", "cn", "intl"].includes(it.reach));
  assert(noTag.length === 0, "这些连接器没说清楚内网能不能用（reach 没打标）：" + noTag.map((i) => i.name).join("、"));

  const off = catalog({ intranet: false });
  const on = catalog({ intranet: true });
  assert(off.items.length === on.items.length && on.items.length === ITEMS.length,
    "内网模式把连接器删掉了——有代理的用户就再也找不到它们了，应该只标不删");
  assert(off.items.every((it) => !it.blocked), "没开内网模式却拦下了连接器");
  const blocked = on.items.filter((it) => it.blocked);
  assert(blocked.length > 0 && blocked.every((it) => it.reach === "intl"), "内网模式拦错了对象");
  assert(blocked.every((it) => /内网连不上/.test(it.blockedWhy || "")), "拦下了却没说为什么");
  // 本机跑的、境内的，一个都不许拦：这些恰恰是内网里唯一还能用的
  assert(!on.items.some((it) => it.blocked && (it.reach === "local" || it.reach === "cn")),
    "把本机/境内的连接器也拦了，内网用户就一个能用的都没有了");
  for (const n of ["filesystem", "sqlite", "postgres", "amap", "lark"]) {
    assert(!on.items.find((it) => it.name === n).blocked, n + " 在内网里明明能用，却被拦了");
  }
  for (const n of ["slack", "notion", "google-maps", "supabase"]) {
    assert(on.items.find((it) => it.name === n).blocked, n + " 要连境外，内网模式该标出来");
  }
  // 能连不能连的排序：拦下的一律靠后，别占着前排让人白填 Key
  const firstBlocked = on.items.findIndex((it) => it.blocked);
  assert(!on.items.slice(firstBlocked).some((it) => !it.blocked), "拦下的连接器没排到最后，还混在能用的里面");
  // 自托管能救的那几个要给出具体做法，不能只说"连不上"
  const gl = on.items.find((it) => it.name === "gitlab");
  assert(/GITLAB_API_URL/.test(gl.blockedWhy), "GitLab 明明改个地址就能连内网实例，却没告诉用户怎么改");
  // 比单个连接器更要命的一条：npx -y 每次都要去 registry 拉包，内网没镜像的话
  // 连标着「本机」的也装不上。不提这一句，用户会错怪到连接器头上
  // 造一个一定找得到 npx / uvx 的 PATH。不能靠本机真装没装：
  // 装了才断言、没装就放过，等于这条断言在 CI 上随缘生效（上一轮变异测试就是这么漏掉的）
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "owb-bin-"));
  for (const n of ["npx", "uvx", "npx.cmd", "uvx.cmd"]) fs.writeFileSync(path.join(fakeBin, n), "");
  const withTools = catalog({ intranet: true, env: { PATH: fakeBin } });
  assert(withTools.tools.npx && withTools.tools.uvx, "造的假 npx / uvx 都没被找到，这条断言白写了");
  assert(withTools.notes.some((n) => /npx/.test(n) && /registry|镜像/.test(n)),
    "内网模式没提醒 npx 要配内部镜像——用户会把「装不上」错怪到连接器头上，白查半天");
  assert(withTools.notes.some((n) => /uvx/.test(n) && /PyPI|镜像|UV_INDEX_URL/.test(n)),
    "内网模式没提醒 uvx 要配 PyPI 镜像");
  fs.rmSync(fakeBin, { recursive: true, force: true });
  assert(catalog({ intranet: false }).notes.length === 0, "没开内网模式却塞了内网提醒");

  // ---- ③ 交付物里的外链 ----
  // 这几处以前是互相打架的：提示词说"绝不引 CDN"，技能文档转头就教你从 jsdelivr import。
  // 模型照着技能文档做，检查器还放行，于是内网客户拿到一份打不开的页面
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const deliverable = ["skills/data-viz/skill.md", "skills/html-page/skill.md", "skills/web-styles/skill.md"];
  for (const f of deliverable) {
    const t = read(f);
    // 允许出现 curl 取文件的行（那是在自己机器上跑），但不许把地址写进 <script src> / <link href>
    const embeds = [...t.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)=["']https?:\/\/[^"']+/gi)].map((m) => m[0]);
    assert(embeds.length === 0, f + " 还在教人把外链写进交付的 HTML 里：" + embeds[0]);
  }
  const sk = read("skills.js");
  assert(!/import \{[^}]*\} from "https:\/\/cdn\./.test(sk),
    "skills.js 还在教人从 CDN 直接 import——ESM 解析不到时整个 <script type=module> 不执行，不报错也不回退");

  // ④ 从界面真能把开关拨动：起一台真 server.js，走 /api/settings 存、走 /api/mcp/catalog 看效果。
  // 前面三组测的都是「函数算得对」，这一组测的是「这台机器上真的接得通」——开关落在 config.json 里、
  // 目录当场跟着变、而且拨得回去。拨不回去的开关等于单程票，判断错了就只能手改配置文件。
  {
    const os = require("os");
    const http = require("http");
    const crypto = require("crypto");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-intra-"));
    const token = "e2e" + crypto.randomBytes(12).toString("hex");
    fs.mkdirSync(path.join(home, "data"), { recursive: true });
    fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
      users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
      tokens: { [token]: { user: "e2e", at: Date.now() } },
    }));
    const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
    const child = booted.child;
    const { up, port, why: bootWhy } = await booted.wait();
    const req = (method, p2, body) => new Promise((resolve) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const r = http.request({
        host: "127.0.0.1", port, path: p2, method,
        headers: { Cookie: "openworkbuddy_token=" + token, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
      }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json: j }); });
      });
      r.on("error", (e) => resolve({ code: 0, body: e.message, json: null }));
      if (data) r.write(data);
      r.end();
    });
    // 只取要看的那个字段往断言消息里塞：整份 config.json 里有 api_key，
    // 断言一挂就会原样打进 CI 日志
    const onDisk = () => { try { return JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")); } catch { return null; } };
    try {
      assert(up, "真 server.js 没起来，内网开关这条测试作废：" + bootWhy);

      const c0 = await req("GET", "/api/mcp/catalog");
      assert(c0.code === 200 && c0.json, "拿不到连接器目录：HTTP " + c0.code + " " + c0.body.slice(0, 200));
      assert(c0.json.intranet === false, "干净家目录默认不该是内网模式：" + JSON.stringify(c0.json.intranet));
      assert((c0.json.items || []).every((it) => !it.blocked), "没开内网就不许有连接器被标成连不上");

      const on = await req("POST", "/api/settings", { intranet: true });
      assert(on.code === 200, "打开内网模式失败：HTTP " + on.code + " " + on.body.slice(0, 200));
      assert((onDisk() || {}).intranet === true, "内网模式没落到 config.json，重启就丢：intranet=" + JSON.stringify((onDisk() || {}).intranet));

      const c1 = await req("GET", "/api/mcp/catalog");
      assert(c1.json.intranet === true, "开关存了，目录却还说不是内网——中间隔了一层没跟上");
      const bl = (c1.json.items || []).filter((it) => it.blocked);
      assert(bl.length > 0, "开了内网，却一条境外连接器都没标出来");
      assert(bl.every((it) => it.reach === "intl"), "标错人了：只有境外(intl)的才该标，被标的里有 " +
        JSON.stringify((bl.find((it) => it.reach !== "intl") || {}).name));
      assert(c1.json.items.length === c0.json.items.length, "内网模式把连接器删掉了——只许标，不许删（有代理的人还要接）");
      const firstBlocked = c1.json.items.findIndex((it) => it.blocked);
      assert(c1.json.items.slice(firstBlocked).every((it) => it.blocked), "连不上的没排到最后，混在能用的中间");
      assert(bl.every((it) => it.blockedWhy && it.blockedWhy.length > 6), "标了却没说为什么，用户只会以为是软件坏了");

      // 拨得回去。这条最容易漏：存的时候只写了 `if (b.intranet) config.intranet = true`
      // 这种半截逻辑，开得了关不掉，人就只能去手改 config.json
      const off = await req("POST", "/api/settings", { intranet: false });
      assert(off.code === 200, "关掉内网模式失败：HTTP " + off.code + " " + off.body.slice(0, 200));
      assert((onDisk() || {}).intranet === false, "关掉后 config.json 里没变回 false：intranet=" + JSON.stringify((onDisk() || {}).intranet));
      const c2 = await req("GET", "/api/mcp/catalog");
      assert(c2.json.intranet === false && (c2.json.items || []).every((it) => !it.blocked),
        "关掉之后目录没恢复，标记还挂着");

      // 只认布尔。字符串 "true" 要是也算数，那前端哪天传错类型就会把整台机器悄悄切进内网模式
      await req("POST", "/api/settings", { intranet: "true" });
      assert((onDisk() || {}).intranet === false, '字符串 "true" 不该被当成打开：intranet=' + JSON.stringify((onDisk() || {}).intranet));
    } finally {
      child.kill("SIGKILL");
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // ⑤ 内网里从 GitHub 装技能：当场说清楚，别让人白等 30 秒超时再去猜是不是链接填错了
  {
    const skills = require("../skills");
    const save = process.env.OWB_INTRANET;
    try {
      process.env.OWB_INTRANET = "1";
      let msg = "";
      await skills.installFromGitHub("https://github.com/owner/repo").then(
        () => { msg = "__居然过了__"; }, (e) => { msg = e.message; });
      assert(/内网/.test(msg), "内网模式下装 GitHub 技能没被当场拦下，只会白等超时：" + msg.slice(0, 120));
      assert(/skill\.md/.test(msg), "拦是拦了，却没给出走得通的法子（把含 skill.md 的目录拷进技能目录）：" + msg.slice(0, 160));

      // 关掉之后不许还拦着——这颗开关只影响提示，不该把功能锁死
      process.env.OWB_INTRANET = "0";
      let msg2 = "";
      // 用一个根本不是 GitHub 的地址：走到原来的格式判断就停，不会真发请求出去
      await skills.installFromGitHub("https://example.com/not-github").then(
        () => { msg2 = "__居然过了__"; }, (e) => { msg2 = e.message; });
      assert(!/内网/.test(msg2), "开关关了还在拦 GitHub 安装：" + msg2.slice(0, 120));
      assert(/链接格式/.test(msg2), "关掉后该走回原来的格式判断，实际报的是：" + msg2.slice(0, 120));
    } finally {
      if (save === undefined) delete process.env.OWB_INTRANET; else process.env.OWB_INTRANET = save;
    }
  }

  // ⑥ 界面上那颗开关：画了、绑了、存不上还得拨回去
  {
    const app05 = fs.readFileSync(path.join(root, "public", "js", "app-05.js"), "utf8");
    assert(/id="mcp-intranet"/.test(app05), "连接器页上没有内网模式开关：只能改 config.json 的设置等于没有");
    assert(/cat\.intranet \? " checked" : ""/.test(app05), "开关没回显当前状态，进页面永远是关着的");
    assert(/intranetBox\.onchange/.test(app05) && /JSON\.stringify\(\{ intranet: want \}\)/.test(app05),
      "开关没接到 /api/settings，拨了不存");
    assert(/intranetBox\.checked = !want/.test(app05),
      "存不上时没把钩子拨回去：界面显示开着、盘上其实是关的，下次进来又变回去，用户会以为设置被吃了");
  }

  console.log("✅ 内网 / 私有化：开关三档（环境变量压过配置、配置写坏了不误开）· " + ITEMS.length +
    " 条连接器全都说清楚内网能不能用（拦 " + blocked.length + " 条境外的、只标不删、排到最后、自托管给出改法）· " +
    "交付物里一个外链都不许有（含 Google Fonts，实测内网白等 5.1 秒）· " +
    "开关从界面真拨得动也拨得回（真起一台 server 走 /api/settings + /api/mcp/catalog，只认布尔）· " +
    "内网装 GitHub 技能当场说清并给出本地装法，关掉就不拦");
}

/**
 * 「做出来的网页千篇一律」不是某一个文件的锅，是一条链：内置提示词、html-page 技能、
 * 网页设计师专家、界面上那几个提示词模板——四处各自写死一套配方（白底居中一栏、圆角卡片、
 * 三个卖点 + 五条 FAQ、正文 860px），模型照着做就一定长同一张脸。
 * 修法是在每一处都插进「先定视觉方向」这一步，并把写死的配方降级成范围。
 * 这四处是互相独立的文件，改一处忘三处既不报错也不崩，只会在下一次交付里悄悄长回去，
 * 所以只能在这儿钉住。
 */
function styleDirectionDrift(src) {
  const miss = [];
  const need = (label, ok) => { if (!ok) miss.push(label); };
  const agentJs = src["agent.js"] || "";
  const htmlPage = src["skills/html-page/skill.md"] || "";
  const webStyles = src["skills/web-styles/skill.md"] || "";
  const experts = src["experts.json"] || "";
  const tpls = src["public/js/app-05.js"] || "";

  need("agent.js 的做网页规范里没有「先定视觉方向」这一步", /视觉方向/.test(agentJs));
  need("agent.js 没指路去 web-styles 挑方向", /web-styles/.test(agentJs));
  // 这条以前是反着钉的（"字体是唯一该放行的外链"），依据是"断网时页面只是字体变普通、不能塌"。
  // 那个依据是错的：<link rel=stylesheet> 挡渲染，而国央企内网的防火墙是**默默丢包**不回 RST，
  // 浏览器只能等到自己的 5 秒超时。拿 Electron（同一套 Chromium）对着 203.0.113.9 实测：
  // 引一个连不上的样式表，首屏 5132ms；同一页零外链，116ms。白屏五秒换一款西文标题字体，不值。
  // 现在提示词、专家、技能文档、check_page 四处一起禁，谁也别跟谁打架
  need("agent.js 还留着 Google Fonts 这个例外（内网里等于白屏 5 秒）", !/fonts\.googleapis\.com\/css/.test(agentJs) && /Google Fonts 也不行/.test(agentJs));
  need("html-page 技能还允许引 Google Fonts", /都不引网络字体/.test(htmlPage) && !/只允许引 Google Fonts/.test(htmlPage));
  need("网页设计师专家还允许引 Google Fonts", !/可以引 Google Fonts/.test(experts));
  {
    // 光改提示词不改检查器没用：模型照样会写，没人拦得住。
    // auditHtml 是 check_page 背后那个纯静态分析，直接喂它一页就行
    const { auditHtml } = require("../tools")._internals;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-font-"));
    const page = (head) => '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><title>标题</title>' + head +
      '</head><body><h1>嗨</h1></body></html>';
    const say = (head) => JSON.stringify(auditHtml(page(head), dir));
    need("check_page 仍然对网络字体睁一只眼闭一只眼",
      /白等 5 秒/.test(say('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">')));
    need("换成 gstatic 就漏过去了",
      /白等 5 秒/.test(say('<link rel="stylesheet" href="https://fonts.gstatic.com/s/inter.css">')));
    // 反向对照：一页干净的不许被误报，不然这条断言等于「见 link 就喊」
    need("零外链的干净页面被误报成引了网络字体", !/白等 5 秒|外部资源/.test(say('<style>body{font-family:system-ui}</style>')));
    // 别的 CDN 仍然走原来那句，两句话不许串
    const cdnSaid = say('<script src="https://cdn.jsdelivr.net/npm/echarts"></script>');
    need("普通 CDN 外链不报了", /外部资源/.test(cdnSaid));
    need("普通 CDN 被错报成网络字体", !/白等 5 秒/.test(cdnSaid));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  need("agent.js 把「4 个主色 / 4 的倍数」当配方而不是下限", /及格线，不是配方/.test(agentJs));

  need("html-page 只给了一副报告骨架，没给三选一", ["A · 分析报告式", "B · 叙事流式", "C · 面板式"].every((k) => htmlPage.includes(k)));
  need("html-page 又把正文宽度写死成一个值", !/max-width: 860px/.test(htmlPage));
  need("html-page 没提醒先去 web-styles 定方向", /web-styles/.test(htmlPage));

  need("web-styles 技能不见了", webStyles.length > 0);
  const fm = /^---\n([\s\S]*?)\n---/.exec(webStyles);
  const desc = fm ? (/^description:\s*(.+)$/m.exec(fm[1]) || [, ""])[1].trim() : "";
  // CLI 那边列技能表时截到 60 字（agent.js 网页端截 80），超了就是一句被切一半的话
  need("web-styles 的 description 超过 60 字，CLI 里会被截断成半句话", desc.length > 0 && desc.length <= 60);
  const dirs = (webStyles.match(/^## \d+ · /gm) || []).length;
  need("web-styles 给的方向少于 8 个，选择面太窄照样会撞脸", dirs >= 8);

  need("网页设计师专家没被告知先去挑视觉方向", /web-styles/.test(experts));
  need("网页设计师专家还在要求「字体只用系统字体栈」跟 html-page 打架", !/字体只用系统字体栈/.test(experts));

  need("落地页模板还写死「三个核心卖点 + FAQ 5 条」", !/三个核心卖点/.test(tpls));

  return { miss, checked: Object.keys(src).length };
}

function testStyleDirection() {
  const root = path.join(__dirname, "..");
  const files = ["agent.js", "skills/html-page/skill.md", "skills/web-styles/skill.md", "experts.json", "public/js/app-05.js"];
  const src = {};
  for (const f of files) src[f] = fs.readFileSync(path.join(root, f), "utf8");
  const r = styleDirectionDrift(src);
  assert(r.miss.length === 0, "网页视觉方向这条链断了：\n  " + r.miss.join("\n  "));
  assert(r.checked === files.length, "该查的文件没读全（" + r.checked + "/" + files.length + "）");

  // 反向对照：每一处单独退回原样，都必须被抓出来——一条没红就说明这道闸门是摆设
  const bad = [
    // 这四条以前是反着钉的（"字体是唯一该放行的外链"）。实测推翻了它的依据，见上面 need 那段的注释
    ["agent.js 又给 Google Fonts 开了例外", { "agent.js": src["agent.js"].replace("Google Fonts 也不行", "唯一的例外是 Google Fonts") }],
    ["agent.js 里直接写了一条字体外链", { "agent.js": src["agent.js"] + '\n<link href="https://fonts.googleapis.com/css2?family=Inter">\n' }],
    ["html-page 又允许引 Google Fonts", { "skills/html-page/skill.md": src["skills/html-page/skill.md"].replace("都不引网络字体", "只允许引 Google Fonts") }],
    ["网页设计师专家又允许引 Google Fonts", { "experts.json": src["experts.json"].replace("都不引网络字体（含 Google Fonts）", "可以引 Google Fonts") }],
    ["agent.js 删掉视觉方向那一步", { "agent.js": src["agent.js"].replace(/视觉方向/g, "配色") }],
    ["html-page 退回单副骨架", { "skills/html-page/skill.md": src["skills/html-page/skill.md"].replace("B · 叙事流式", "分节正文") }],
    ["html-page 又把正文宽度写死", { "skills/html-page/skill.md": src["skills/html-page/skill.md"] + "\nmax-width: 860px 居中\n" }],
    ["web-styles 技能整个丢了", { "skills/web-styles/skill.md": "" }],
    ["web-styles 的 description 写太长", { "skills/web-styles/skill.md": src["skills/web-styles/skill.md"].replace(/^description:.*$/m, "description: " + "长".repeat(61)) }],
    ["web-styles 只剩两个方向", { "skills/web-styles/skill.md": src["skills/web-styles/skill.md"].replace(/^## [3-9] · .*$/gm, "## 别的") }],
    ["网页设计师专家忘了挂 web-styles", { "experts.json": src["experts.json"].replace(/web-styles/g, "html-page") }],
    ["落地页模板退回三卖点五问答", { "public/js/app-05.js": src["public/js/app-05.js"] + "\n// 三个核心卖点\n" }],
  ];
  for (const [why, patch] of bad) {
    const got = styleDirectionDrift({ ...src, ...patch }).miss;
    assert(got.length > 0, "★闸门失效：" + why + "，居然没红★");
  }
  // 这份技能得真跟着安装包走，不然用户下下来是没有的。skills 白名单是问 git 要的，
  // 忘了 git add 就悄无声息地不进包——跟 NOTICE.md 当初那个漏法一模一样
  const packed = require(path.join(root, "electron-builder.config.js")).files;
  // 白名单是问 git 要的。问不到时（源码 zip、没装 git 的机器）config 有条写在注释里的退路：skills/ 全量带上。
  // 走那条退路时下面两条都不成立，但那不叫「忘了 git add」——别拿一句错的诊断去骂人，说清楚是哪种情况。
  if (packed.includes("skills/**/*")) {
    console.log("⚠️  安装包白名单这次走的是「问不到 git，skills/ 全量带上」那条退路，这两条只在拿得到 git 清单时才判——跳过");
  } else {
    assert(packed.includes("skills/web-styles/**/*"), "web-styles 没进安装包白名单——多半是忘了 git add");
    assert(!packed.includes("skills/theme-factory/**/*"), "★闸门失效：.gitignore 掉的第三方技能居然也进了包★");
  }

  console.log(`✅ 网页别千篇一律：${files.length} 处（提示词 / 技能 / 专家 / 模板）都插进了「先定视觉方向」· ${(src["skills/web-styles/skill.md"].match(/^## \d+ · /gm) || []).length} 个方向随包分发 · ${bad.length} 种退回全被抓`);
}

/**
 * AI 短剧这条链的静态体检。纯读文件，不调模型、不花钱。
 *
 * 为什么值得单独一道闸门：这条技能干的事是「拿文档教模型怎么调工具」，而教错了不会报错——
 * 模型照着写一个不存在的参数名，工具那边当没给，图照样出、片照样拼，只是角色一镜一个样，
 * 而十几次生视频的钱已经花完了。反过来 TOOL_DEFS 改个字段名也一样：技能里的写法悄没声地过期。
 * 所以这儿把「技能教的参数」和「工具真收的参数」钉在一起，谁动了谁红。
 *
 * @param {Record<string,string>} src 文件内容，键是仓库相对路径
 * @param {Record<string,string[]>} params 工具名 → 它真实接受的参数名
 * @param {number} genMax 生成类工具的并发上限（agent.js 的 GEN_PARALLEL_MAX）
 * @returns {{miss: string[], checked: number}}
 */
function shortDramaDrift(src, params, genMax) {
  const miss = [];
  const need = (why, ok) => { if (!ok) miss.push(why); };
  const SKILL = "skills/short-drama/skill.md";
  const SCHEMA = "skills/short-drama/references/分镜表.schema.json";
  const skill = src[SKILL] || "";
  const road = src["docs/路线图.md"] || "";
  const pick = src["docs/短剧画布选型.md"] || "";

  need("skills/short-drama/skill.md 不见了或被掏空", skill.length > 500);
  need("技能的 frontmatter name 不是 short-drama，装到用户机器上会变成另一个名字", /^name:\s*short-drama\s*$/m.test(skill));
  // CLI 引擎那份技能表把 description 截到 60 字（agent.js engineSkillsBlock），超了模型看到的是半句话
  const desc = (skill.match(/^description:\s*(.+)$/m) || ["", ""])[1].trim();
  need(`技能 description ${desc.length} 字，超过 60 会被截成半句话`, desc.length > 0 && desc.length <= 60);
  need("技能没写清跟 video-compose 的分工，模型会拿它去干零成本的图文成片", /video-compose/.test(skill));

  // 技能教的每一个参数名，工具那边必须真收。两个方向都判：教没了红，工具改名了也红
  const TEACHES = [
    ["generate_image", "reference_images", "跨镜头角色一致性全靠它"],
    ["generate_image", "filename", "并发下不给名字就是互相覆盖"],
    ["generate_image", "no_cache", "确实要换一版时的逃生口"],
    ["generate_video", "first_frame", "图生视频的入口"],
    ["generate_video", "last_frame", "转场镜头要两头定帧"],
    ["text_to_speech", "voice", "同一个角色全程一个音色"],
  ];
  for (const [tool, p, why] of TEACHES) {
    need(`技能里不再教 ${tool} 的 ${p}（${why}）`, skill.includes(p));
    need(`${tool} 已经没有 ${p} 这个参数了，技能里教的是过时写法`, (params[tool] || []).includes(p));
  }

  // 分镜表 schema 是这条技能的唯一真源，日后画布读的也是它。字段改名等于把存量分镜表全废掉
  let schema = null;
  try { schema = JSON.parse(src[SCHEMA] || ""); } catch { /* 下一行会报 */ }
  need("分镜表 schema 解析不了（JSON 坏了或文件没了），技能让模型照着写的东西不存在", !!schema);
  if (schema) {
    need("分镜表 schema 不是 draft-07", /draft-07/.test(String(schema.$schema)));
    for (const k of ["title", "aspect", "characters", "scenes"]) {
      need(`分镜表根节点不再必填 ${k}`, (schema.required || []).includes(k));
    }
    const scene = ((schema.properties || {}).scenes || {}).items || {};
    const shot = ((scene.properties || {}).shots || {}).items || {};
    for (const k of ["id", "shot_size", "frame_prompt", "motion_prompt"]) {
      need(`分镜表里一镜不再必填 ${k}`, (shot.required || []).includes(k));
    }
    const chr = ((schema.properties || {}).characters || {}).items || {};
    need("角色不再必填 look——外貌不写死一段，人就会一镜一个样", (chr.required || []).includes("look"));
  }
  need("技能没指向 references/分镜表.schema.json，模型会自己发明一套结构，下次接着改就对不上", skill.includes("references/分镜表.schema.json"));

  // 下面三条是这条技能的底线。删掉任何一条，它就退化成「拿静止图凑数」的那种假短剧
  need("「缺生视频不能降级」没了——降级交付的是假短剧", /缺生视频不能降级/.test(skill));
  need("「不许拿静止图加推拉摇假装」这条红线没了", /不许拿静止图加推拉摇假装/.test(skill));
  need("「不加任何 AI 水印」没了", /不加任何 AI 水印/.test(skill));
  need("开工前那段花钱提醒没了——分镜表得先给用户过目、点头了再开始生", /点头了再开始花钱/.test(skill));

  // 并发那句是写给模型看的事实，和代码对不上就是在教它错的
  const n = +(skill.match(/系统默认同时跑 (\d+) 条/) || [])[1];
  need(`技能里写「默认同时跑 ${n || "?"} 条」，代码里的上限是 ${genMax}`, n === genMax);
  need("并发那段没提「每条 filename 必须不一样」：同名就是互相覆盖，而两条都会报成功", /filename 必须不一样/.test(skill));

  // 两份规划文档别打架。一份说第一期先搭画布、一份说第一期不碰画布，下次接着干的人按哪份来
  need("docs/短剧画布选型.md 里「第一期不碰画布」的结论没了", /第一期不碰画布/.test(pick));
  need("docs/路线图.md 没提 short-drama，两份文档的分期对不上", /short-drama/.test(road));

  return { miss, checked: Object.keys(src).length };
}

function testShortDrama() {
  const root = path.join(__dirname, "..");
  const S = "skills/short-drama/skill.md";
  const J = "skills/short-drama/references/分镜表.schema.json";
  const files = [S, J, "docs/路线图.md", "docs/短剧画布选型.md"];
  const src = {};
  for (const f of files) src[f] = fs.readFileSync(path.join(root, f), "utf8");

  const defs = require(path.join(root, "tools.js")).TOOL_DEFS;
  const params = {};
  for (const n of ["generate_image", "generate_video", "text_to_speech"]) {
    const d = defs.find((x) => x.name === n);
    assert(d, `工具 ${n} 不见了，短剧这条链整条断了`);
    params[n] = Object.keys((d.input_schema || {}).properties || {});
  }
  const genMax = require(path.join(root, "agent.js")).GEN_PARALLEL_MAX;

  const r = shortDramaDrift(src, params, genMax);
  assert(r.miss.length === 0, "AI 短剧这条链断了：\n  " + r.miss.join("\n  "));
  assert(r.checked === files.length, "该查的文件没读全（" + r.checked + "/" + files.length + "）");

  // schema 的反向对照在解析后的对象上改，不在文本上做替换——
  // 文本替换一旦因为排版变了而没命中，反向对照就成了「改了个寂寞」，还照样绿
  const mut = (fn) => { const o = JSON.parse(src[J]); fn(o); return JSON.stringify(o); };
  const bad = [
    ["技能整个丢了", { [S]: "" }, null],
    ["description 写太长，CLI 里被截成半句", { [S]: src[S].replace(/^description:.*$/m, "description: " + "长".repeat(61)) }, null],
    ["技能不再教 reference_images（角色一致性没了）", { [S]: src[S].replace(/reference_images/g, "参考图") }, null],
    ["技能不再教 first_frame（退回文生视频）", { [S]: src[S].replace(/first_frame/g, "起始画面") }, null],
    ["技能不再指向分镜表 schema", { [S]: src[S].replace(/references\/分镜表\.schema\.json/g, "自己想一个结构") }, null],
    ["技能不再提 video-compose，两条路的分工糊了", { [S]: src[S].replace(/video-compose/g, "别的技能") }, null],
    ["分镜表 schema 坏成非法 JSON", { [J]: "{" }, null],
    ["分镜表根节点丢了 characters", { [J]: mut((o) => { o.required = o.required.filter((k) => k !== "characters"); }) }, null],
    ["一镜丢了 shot_size 必填", { [J]: mut((o) => { const s = o.properties.scenes.items.properties.shots.items; s.required = s.required.filter((k) => k !== "shot_size"); }) }, null],
    ["角色不再必填 look", { [J]: mut((o) => { const c = o.properties.characters.items; c.required = c.required.filter((k) => k !== "look"); }) }, null],
    ["schema 退回没有版本号", { [J]: mut((o) => { delete o.$schema; }) }, null],
    ["「缺生视频不能降级」被改成可以降级", { [S]: src[S].replace(/缺生视频不能降级/g, "缺生视频可以降级") }, null],
    ["静止图假装短剧那条红线被删", { [S]: src[S].replace(/不许拿静止图加推拉摇假装/g, "尽量别拿静止图假装") }, null],
    ["AI 水印那条被删", { [S]: src[S].replace(/不加任何 AI 水印/g, "水印随意") }, null],
    ["「点头了再开始花钱」被删，变成边想边生", { [S]: src[S].replace(/点头了再开始花钱/g, "想到哪生到哪") }, null],
    ["并发数跟代码对不上", { [S]: src[S].replace("系统默认同时跑 " + genMax + " 条", "系统默认同时跑 " + (genMax + 3) + " 条") }, null],
    ["并发那段没提 filename 要不一样", { [S]: src[S].replace(/filename 必须不一样/g, "filename 随便起") }, null],
    ["选型文档翻供：第一期改成先搭画布", { "docs/短剧画布选型.md": src["docs/短剧画布选型.md"].replace(/第一期不碰画布/g, "第一期先搭画布") }, null],
    ["路线图里 short-drama 没了", { "docs/路线图.md": src["docs/路线图.md"].replace(/short-drama/g, "画布") }, null],
    ["generate_video 把 first_frame 改名了，技能里教的成了过时写法", null, { ...params, generate_video: params.generate_video.filter((p) => p !== "first_frame") }],
    ["text_to_speech 不再收 voice", null, { ...params, text_to_speech: params.text_to_speech.filter((p) => p !== "voice") }],
    ["generate_image 不再收 reference_images", null, { ...params, generate_image: params.generate_image.filter((p) => p !== "reference_images") }],
  ];
  for (const [why, patch, defPatch] of bad) {
    const got = shortDramaDrift({ ...src, ...(patch || {}) }, defPatch || params, genMax).miss;
    assert(got.length > 0, "★闸门失效：" + why + "，居然没红★");
  }

  // 这份技能得真跟着安装包走。白名单是问 git 要的，忘了 git add 就悄无声息地不进包——
  // 而且它是两个文件：skill.md 进了、references/ 那份 schema 没进，模型照着技能去读照样扑空
  const packed = require(path.join(root, "electron-builder.config.js")).files;
  if (packed.includes("skills/**/*")) {
    console.log("⚠️  安装包白名单这次走的是「问不到 git，skills/ 全量带上」那条退路，下面两条只在拿得到 git 清单时才判——跳过");
  } else {
    assert(packed.includes("skills/short-drama/**/*"), "short-drama 没进安装包白名单——多半是忘了 git add");
    // -z 是关键：git 默认把非 ASCII 路径转义成 "\345\210..."，中文文件名这么核对不了
    let tracked = [];
    try {
      tracked = require("child_process").execFileSync("git", ["ls-files", "-z", "skills/short-drama"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    } catch { /* 上面那条分支已经说明 git 可用，这儿兜个底 */ }
    assert(tracked.some((p) => p.endsWith("分镜表.schema.json")), "分镜表 schema 没被 git 跟踪：skill.md 进了包、它没进，模型照着技能去读会扑空");
  }

  const shotReq = JSON.parse(src[J]).properties.scenes.items.properties.shots.items.required.length;
  console.log(`✅ AI 短剧（第一期，不碰画布）：技能教的 6 个工具参数都真收 · 分镜表 schema 钉住一镜 ${shotReq} 个必填字段 · 并发数与代码一致（${genMax}）· ${bad.length} 种改坏全被抓`);
}

/**
 * 发版这条链的静态体检。每一条对应一次真踩过或差点踩到的坑，纯读文件，不跑流水线。
 *
 * @param {Record<string,string>} src 文件内容，键是仓库相对路径
 * @returns {{miss: string[], suites: string[]}}
 */
function releasePipelineDrift(src) {
  const miss = [];
  // 同理剥掉整行 YAML 注释：release.yml 里恰好有一行注释在解释「不写 !cancelled() 会怎样」，
  // 不剥的话把真正那句 if 删掉，闸门还会被这句解释喂饱
  const rel = (src[".github/workflows/release.yml"] || "").replace(/^[ \t]*#.*$/gm, "");
  // test.yml 也剥掉整行注释，理由同上：下面按大版本查 uses:，
  // 注释里回忆一句「以前钉的是哪个版本」不该被当成真配置读
  const tst = (src[".github/workflows/test.yml"] || "").replace(/^[ \t]*#.*$/gm, "");
  const all = src["test/all.js"] || "";
  const pkg = src["package.json"] || "";
  // 注释里也会提 AppImage / linux（删掉那段时留的恢复说明），先把行注释剥掉再查，
  // 否则「解释为什么删了」这句话本身会被当成「它还在」
  const ebc = (src["electron-builder.config.js"] || "").replace(/^[ \t]*\/\/.*$/gm, "");
  const ish = src["install.sh"] || "";

  // —— PR / main 的红绿灯。在这条闸门之前，除 e2e 外的套件只在作者本机手敲时才跑过
  if (!tst.trim()) miss.push("没有 .github/workflows/test.yml：PR 和 main 没有任何 CI");
  if (!/pull_request/.test(tst)) miss.push("test.yml 不管 pull_request：外部 PR 无人把关");
  if (!/macos-latest/.test(tst)) miss.push("test.yml 没在 macOS 上跑全套：e2e 要开真 electron 窗口，只有那台能全覆盖");
  // —— checkout 默认只克一个 commit。README「最新动态」的日期核对拿 git log 当底本，
  //    浅克隆下每条动态都会被判成「git 里那天没有提交」：报错指着 README，错却在工作流。
  //    钉死这个值，省得哪天有人把 with: 那两行当冗余删掉。
  const deep = /checkout@v\d+\s*\n\s*with:\s*\n\s*fetch-depth:\s*0/;
  if (!deep.test(tst)) miss.push("test.yml 的 checkout 没写 fetch-depth: 0：默认浅克隆，README「最新动态」的日期核对会把每条都判成假的");
  if (!deep.test(rel)) miss.push("release.yml 的 test job checkout 没写 fetch-depth: 0：发版前那趟 npm test 会栽在同一处");

  // —— GitHub 正在弃用 node20：停在老大版本上每趟 CI 都刷一条 deprecation 警告，
  //    到期就是硬失败——而这条链一红，build 被 skip、tag 一个安装包都不产（v0.5.1 就是这么空的）。
  //    下面记的是各 action「第一个跑 Node 24 的大版本」，退回更低的等于把那个死线捡回来。
  const NODE24_FLOOR = {
    "actions/checkout": 5,
    "actions/setup-node": 5,
    "actions/upload-artifact": 5,
    "actions/download-artifact": 5,
    "softprops/action-gh-release": 3,
  };
  for (const [name, text] of [["test.yml", tst], ["release.yml", rel]]) {
    for (const m of text.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@v(\d+)/g)) {
      const floor = NODE24_FLOOR[m[1]];
      if (floor && Number(m[2]) < floor) {
        miss.push(`${name} 的 ${m[1]} 还钉在 @v${m[2]}（跑 Node 20，GitHub 已判弃用）：至少要 @v${floor}`);
      }
    }
  }

  // —— CI 跑的套件必须是 test/all.js 里的全集。加了新套件却忘了加进 CI 命令行，
  //    它就永远不会在 CI 上跑；而本地 npm test 照样绿，人看不出来
  const suites = (all.match(/^\s*\["([a-z0-9-]+)"/gim) || []).map((m) => m.replace(/^\s*\["/, "").replace(/"$/, ""));
  const onlyLine = (tst.match(/--only\s+([a-z0-9,\-]+)/) || [])[1] || "";
  const inCI = new Set(onlyLine.split(",").filter(Boolean));
  // e2e 单独走 macOS 那条腿的 npm test，不在 --only 名单里
  const shouldBeInCI = suites.filter((s) => s !== "e2e");
  const forgotten = shouldBeInCI.filter((s) => !inCI.has(s));
  if (suites.length < 10) miss.push("test/all.js 的套件清单没读出来（认出 " + suites.length + " 个），闸门自己坏了");
  if (forgotten.length) miss.push("这些套件在 CI 上一次都不会跑：" + forgotten.join("、") + "（补进 test.yml 的 --only）");
  const ghost = [...inCI].filter((s) => !suites.includes(s));
  if (ghost.length) miss.push("test.yml 的 --only 里有 test/all.js 没有的套件：" + ghost.join("、") + "（会直接 exit 2）");

  // —— 套件挂了必须让退出码变 1。all.js 判成败只看退出码，套件自己打的那句
  //    「有失败：N 挂」它根本不读。少写一行 process.exit，那个套件就变成**摆设**：
  //    断言照跑、红叉照打、CI 照样绿。这比套件没进 CI 更坏——没进 CI 至少没人以为它在跑。
  //    2026-09-17 逮到三个这样的：lanes（54 条）、cli-live（160 条）、chat-models。
  for (const f of fs.readdirSync(__dirname)) {
    if (!f.endsWith(".js") || f === "all.js") continue;
    const body = fs.readFileSync(path.join(__dirname, f), "utf8");
    if (!/process\.exit\s*\(|process\.exitCode\s*=/.test(body)) {
      miss.push(`test/${f} 挂了也不会把退出码变成 1（没有 process.exit / process.exitCode）：这个套件在 CI 眼里永远是绿的`);
    }
  }

  // —— 发版前先跑测试
  if (!/^\s{2}test:/m.test(rel)) miss.push("release.yml 没有 test job：一个把 require 图改坏的 commit 能一路走到 Release");
  if (!/needs:\s*test/.test(rel)) miss.push("release.yml 的 build 没写 needs: test，测试等于白跑");

  // —— 版本号和 tag 的唯一一道绑定。忘了改 package.json：Release 里挂着上一版的文件名，
  //    而且 updater.js 读的也是它，装完的用户「检查更新」会永远说有新版
  if (!/GITHUB_REF_NAME/.test(rel)) miss.push("release.yml 没核对 package.json 版本号和 tag 一致");
  if (/GITHUB_REF_NAME/.test(rel) && !/if:\s*startsWith\(github\.ref, 'refs\/tags\/'\)/.test(rel)) {
    miss.push("版本号核对没加 tag 守卫：手动 workflow_dispatch 时 GITHUB_REF_NAME 是分支名，必红");
  }

  // —— 单平台失败不该拖垮整次发版
  if (!/!cancelled\(\)/.test(rel)) miss.push("release job 缺 !cancelled()：Windows 一红，打好的 mac 包就进不了 Release 页");
  if (!/continue-on-error/.test(rel)) miss.push("download-artifact 没兜 continue-on-error：两条腿全挂时它自己会报错");
  if (!/draft:\s*\$\{\{\s*needs\.build\.result\s*!=\s*'success'\s*\}\}/.test(rel)) {
    miss.push("缺平台时没落草稿：Release 正文写死了 Windows 文件名，缺了还照发等于指向不存在的链接");
  }

  // —— 免安装版那个多余的双架构合体包（v0.1.6 的 Release 里 248 MB 那个）
  if (!/buildUniversalInstaller:\s*false/.test(ebc)) {
    miss.push("portable 没关 buildUniversalInstaller：多架构下会多产一个双架构合体 exe，没文档指向它");
  }

  // —— 配了却从没在流水线上跑过的目标 = 未经验证的死代码
  if ((/dist:linux/.test(pkg) || /AppImage/.test(ebc)) && !/\*\.AppImage/.test(rel)) {
    miss.push("配了 Linux 目标，release.yml 的上传路径却不收它的产物 —— 这个目标从来没在流水线上打过一次（upload 那步是 if-no-files-found: error，只加腿不加 path 必红）");
  }

  // —— 一键安装的用法说明里还留着占位符 = 照着复制的人拿到 404
  if (/<你的仓库>/.test(ish)) miss.push("install.sh 的 curl 用法说明里还是占位符仓库地址");
  if (/pnpm install/.test(ish) && !/--no-frozen-lockfile/.test(ish)) {
    miss.push("install.sh 走 pnpm 但没关 frozen-lockfile：仓库不带 pnpm-lock.yaml，CI 环境下会直接装不上");
  }
  if (/\[ -t 1 \]/.test(ish) && !/\[ -t 0 \]/.test(ish)) {
    miss.push("install.sh 的交互守卫只判 stdout：curl | bash 时 read 撞 EOF，set -e 会让脚本装完反而报失败");
  }

  return { miss, suites };
}

function testReleasePipeline() {
  const root = path.join(__dirname, "..");
  const files = [
    ".github/workflows/release.yml",
    ".github/workflows/test.yml",
    "test/all.js",
    "package.json",
    "electron-builder.config.js",
    "install.sh",
  ];
  const src = {};
  for (const f of files) src[f] = fs.readFileSync(path.join(root, f), "utf8");
  const r = releasePipelineDrift(src);
  assert(r.miss.length === 0, "发版这条链有问题：\n  " + r.miss.join("\n  "));

  // 反向对照：每一处单独退回出问题前的样子，都必须被抓出来
  const bad = [
    ["PR 的 CI 整个没了", { ".github/workflows/test.yml": "" }],
    ["CI 只在 ubuntu 跑、e2e 没人管", { ".github/workflows/test.yml": src[".github/workflows/test.yml"].replace(/macos-latest/g, "ubuntu-latest") }],
    // 这两条以前写死了套件名（",trace"、"--only icons"），名单一动就变成空替换 →
    // 补丁没打上 → 「居然没红」——闸门失效的是对照本身。改成按位置挖，挖谁都行。
    ["新加的套件忘了补进 CI 名单", { ".github/workflows/test.yml": src[".github/workflows/test.yml"].replace(/,[a-z0-9-]+(?=,)/, "") }],
    ["CI 名单里写了个不存在的套件", { ".github/workflows/test.yml": src[".github/workflows/test.yml"].replace(/--only [a-z0-9-]+/, "--only meiyouzhegetaojian") }],
    ["action 退回跑 Node 20 的老大版本", { ".github/workflows/test.yml": src[".github/workflows/test.yml"].replace(/checkout@v\d+/, "checkout@v4") }],
    ["发版那条链的 action 退回 Node 20", { ".github/workflows/release.yml": src[".github/workflows/release.yml"].replace(/action-gh-release@v\d+/, "action-gh-release@v2") }],
    ["CI 的 checkout 退回默认浅克隆", { ".github/workflows/test.yml": src[".github/workflows/test.yml"].replace("fetch-depth: 0", "fetch-depth: 1") }],
    ["发版那趟 checkout 退回默认浅克隆", { ".github/workflows/release.yml": src[".github/workflows/release.yml"].replace("fetch-depth: 0", "fetch-depth: 1") }],
    ["发版前不跑测试了", { ".github/workflows/release.yml": src[".github/workflows/release.yml"].replace(/needs: test\n/, "") }],
    ["版本号和 tag 的绑定被删了", { ".github/workflows/release.yml": src[".github/workflows/release.yml"].replace(/GITHUB_REF_NAME/g, "X") }],
    ["版本号核对忘了守 tag（手动跑必红）", { ".github/workflows/release.yml": src[".github/workflows/release.yml"].replace("if: startsWith(github.ref, 'refs/tags/')\n        shell: bash", "shell: bash") }],
    ["Windows 挂了连 Mac 包一起不发", { ".github/workflows/release.yml": src[".github/workflows/release.yml"].replace(/!cancelled\(\) && /, "") }],
    ["两条腿全挂时 download-artifact 自己报错", { ".github/workflows/release.yml": src[".github/workflows/release.yml"].replace(/\n\s*continue-on-error: true/, "") }],
    ["缺平台照发不落草稿", { ".github/workflows/release.yml": src[".github/workflows/release.yml"].replace(/draft: .*\n/, "") }],
    ["免安装版又多产一个合体包", { "electron-builder.config.js": src["electron-builder.config.js"].replace("buildUniversalInstaller: false", "x: 1") }],
    ["Linux 目标配了但流水线不打", { "package.json": src["package.json"].replace('"dist:mac"', '"dist:linux": "x",\n    "dist:mac"') }],
    ["AppImage 配了但上传路径不收它", { "electron-builder.config.js": src["electron-builder.config.js"].replace("portable: {", 'linux: { target: "AppImage" },\n  portable: {') }],
    ["curl 用法说明退回占位符", { "install.sh": src["install.sh"].replace("CatCatUncle/openworkbuddy/main/install.sh", "<你的仓库>/main/install.sh") }],
    ["pnpm 分支又吃 frozen-lockfile", { "install.sh": src["install.sh"].replace(" --no-frozen-lockfile", "") }],
    ["curl | bash 装完反而报失败", { "install.sh": src["install.sh"].replace("[ -t 0 ] && ", "") }],
  ];
  for (const [why, patch] of bad) {
    const got = releasePipelineDrift({ ...src, ...patch }).miss;
    assert(got.length > 0, "★闸门失效：" + why + "，居然没红★");
  }

  // 锁文件只留一份：两份长期手工对齐必然漂，上一份 pnpm-lock.yaml 过期五周、缺 7 个包
  assert(!fs.existsSync(path.join(root, "pnpm-lock.yaml")), "pnpm-lock.yaml 又回来了——只维护 package-lock.json");

  // 放行说明：macOS 15 起右键「打开」那条通道被苹果取消了，弹窗里只剩「完成 / 移到废纸篓」。
  // 还写 xattr -cr 也不行：它清掉全部扩展属性，过于粗暴，只该删 quarantine 那一条
  const docs = ["README.md", "README.en.md", "docs/安装与启动.md", ".github/workflows/release.yml", "docs/推广/发布日文案.md"];
  for (const d of docs) {
    const t = fs.readFileSync(path.join(root, d), "utf8");
    if (!/xattr|right-click|右键/.test(t)) continue;
    assert(!/xattr -cr/.test(t), d + " 里还写着 xattr -cr（该只删 com.apple.quarantine）");
    assert(/quarantine/.test(t), d + " 提了放行却没给 xattr -dr com.apple.quarantine");
    assert(/macOS 14|Sequoia|Open Anyway|仍要打开/.test(t), d + " 没说明 macOS 15 起右键「打开」已经不管用");
  }

  console.log(`✅ 发版这条链：PR/main 有红绿灯（CI 跑满 ${r.suites.length} 个套件，一个不落）· 发版前先跑测试 · 版本号对不上 tag 当场红 · 单平台挂了另一个照发（缺平台落草稿）· ${bad.length} 种退回全被抓 · ${docs.length} 处放行说明都认 macOS 15`);
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

/**
 * 「模型与 Key」这一页的两道闸。
 *
 * 第一道是图标：admin.html 自己带一份 sprite，跟工作台那份是两份互不相干的东西，
 * 而 test/icons.js 只扫 index.html。少一个 symbol 的后果是那格画出来一片空白、
 * console 一声不吭——真浏览器测试也照样绿。所以这儿把 admin.js 里用到的名字全捞出来对一遍。
 *
 * 第二道是接口契约：test/admin-ui.js 里 /api/settings 是个替身（那份 express 只挂了
 * 账号和后台两个路由，真的那条内联在 server.js 里搬不过来）。替身最怕跟真的走散——
 * 那边一直绿、线上这页读到 undefined。所以这儿拿**真 server.js** 起一次，
 * 把页面真正读的每个字段逐个核对。
 */
async function testAdminModelsPage() {
  const os = require("os");
  const http = require("http");
  const crypto = require("crypto");

  // ---------- 1. 图标：admin.js 用到的每个名字，admin.html 的 sprite 里都得有 ----------
  const adSrc = fs.readFileSync(path.join(__dirname, "..", "public", "js", "admin.js"), "utf8");
  const ahSrc = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
  const iconsUsed = (js) => {
    const s = new Set();
    for (const m of js.matchAll(/\bic\(\s*"([a-z0-9-]+)"/g)) s.add(m[1]);
    for (const m of js.matchAll(/\bicon:\s*"([a-z0-9-]+)"/g)) s.add(m[1]);
    for (const m of js.matchAll(/ALERT_ICON\s*=\s*\{([^}]*)\}/g))
      for (const q of m[1].matchAll(/"([a-z0-9-]+)"/g)) s.add(q[1]);
    return [...s];
  };
  const spriteHas = (html) => new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/g)].map((m) => m[1]));
  const used = iconsUsed(adSrc);
  const have = spriteHas(ahSrc);
  const missing = used.filter((n) => !have.has(n));
  assert(used.length >= 20, "只扫出 " + used.length + " 个图标名，正则八成没匹配上，这道闸是假的");
  assert(missing.length === 0, "admin.html 的 sprite 里缺这些图标（那格会画成空白，console 还不报错）：" + missing.join(" "));
  assert(used.includes("sparkles"), "「模型与 Key」那一项的图标没在 admin.js 里出现，侧栏可能没加上");
  assert(have.has("sparkles"), "admin.html 缺 i-sparkles，「模型与 Key」侧栏那格会是空的");
  // 反向对照：编一个不存在的名字，闸门必须抓住——不然上面那条只证明了「我没在找」
  const faked = adSrc.replace('icon: "sparkles", title: "模型与 Key"', 'icon: "zheshigebucunzaidetubiao", title: "模型与 Key"');
  assert(faked !== adSrc, "反向对照没改动到源码，这道闸的有效性没被验证");
  assert(iconsUsed(faked).filter((n) => !have.has(n)).length === 1, "闸门漏了「引用了不存在的图标」这种坏法");

  // ---------- 2. 接口契约：真 server.js 回的 /api/settings 得带齐这页读的每个字段 ----------
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-admmodels-"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));
  // 这页要验的是「字段齐不齐」，得先有几行真配过的东西才验得了。以前靠的是出厂预置那九行厂商模板，
  // 现在出厂一行都没有（用户原话：「不要搞什么默认渠道填充啊，都没填 apikey 的」；新装该是空的那条
  // 在 /api/onboarding 那节单独钉着），所以这里自己摆一份。名字都不跟出厂模板重名——重名的话
  // 开机那趟 pruneSeededPresets 会把它们当占位行收走，这条测试就又变成在验空列表了。
  const chans = [
    { id: "c-ark", name: "我的方舟", kind: "ark", base_url: "https://ark.cn-beijing.volces.com/api/v3" },
    { id: "c-ds", name: "我的 DeepSeek", kind: "deepseek", base_url: "https://api.deepseek.com/v1" },
    { id: "c-or", name: "我的 OpenRouter", kind: "openrouter", base_url: "https://openrouter.ai/api/v1" },
    { id: "c-zhipu", name: "我的智谱", kind: "zhipu", base_url: "https://open.bigmodel.cn/api/paas/v4" },
    { id: "c-kimi", name: "我的 Kimi", kind: "moonshot", base_url: "https://api.moonshot.cn/v1" },
  ];
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    providers: chans.map((c) => ({ ...c, api_key: "" })),
    models: chans.map((c, i) => ({ name: "线路" + (i + 1), provider: "openai", channel: c.id, base_url: c.base_url, api_key: "", model: "m-" + i })),
    active_model: "线路1",
  }, null, 2));
  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const child = booted.child;
  const { up, port, why: bootWhy } = await booted.wait();
  const req = (method, p) => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Cookie: "openworkbuddy_token=" + token } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json: j }); });
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message, json: null }));
    r.end();
  });

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);
    const s = (await req("GET", "/api/settings")).json;
    assert(s, "GET /api/settings 读不出来");
    // 页面顶上就靠它决定画输入框还是画「只能看」，缺了会 undefined → 一律变只读
    assert(typeof s.platform_owner === "boolean", "/api/settings 没回 platform_owner，后台那页分不清能改不能改");
    assert(Array.isArray(s.providers) && s.providers.length >= chans.length,
      "摆进去的 " + chans.length + " 条渠道没原样回来（开机那趟把它们当占位行收走了？）：" + JSON.stringify((s.providers || []).map((p) => p.name)));
    for (const p of s.providers)
      for (const k of ["id", "name", "kind", "base_url", "has_key"])
        assert(k in p, "渠道少字段 " + k + "：" + JSON.stringify(p));
    assert(Array.isArray(s.models) && s.models.length >= 5, "模型列表空了或太短");
    for (const m of s.models)
      for (const k of ["name", "model", "channel", "has_key", "base_url"])
        assert(k in m, "模型少字段 " + k + "（后台那页要拿 channel 反查渠道、拿 has_key 判还没填 Key）：" + JSON.stringify(m));
    assert(typeof s.active_model === "string" && s.active_model, "/api/settings 没回 active_model，「默认走哪条」那个下拉选不中任何一项");
    assert(s.models.some((m) => m.name === s.active_model), "active_model 指的模型不在列表里：" + s.active_model);
    assert(s.agent && "failover_model" in s.agent, "/api/settings 没回 agent.failover_model，「主渠道挂了换谁」那个下拉存不回去");
    assert(Array.isArray(s.media_models), "/api/settings 没回 media_models 数组，渠道那行「N 个媒体模型」会炸");
    // 摆进去的那几条 Key 都空着：has_key 得全 false，而且真 Key 字段不能凭空冒出内容
    assert(s.providers.every((p) => p.has_key === false), "没填 Key 的渠道居然自称填了：" + s.providers.filter((p) => p.has_key).map((p) => p.id).join(","));
    assert(s.models.every((m) => m.has_key === false), "没填 Key 的模型居然自称填了");
    // Key 是整台服务器的账单凭证，出了门就收不回来了——这一条只允许空串或八个星号
    assert([...s.providers, ...s.models].every((p) => p.api_key === "" || p.api_key === "********"), "真 Key 被原文吐给了前端");

    // 替身跟真的同构：admin-ui 那份替身回的字段，真的这边一个都不能少
    const stub = fs.readFileSync(path.join(__dirname, "admin-ui.js"), "utf8");
    assert(/srv\.get\("\/api\/settings"/.test(stub), "test/admin-ui.js 里的 /api/settings 替身没了，那份测试会掉进错误挡板");
    for (const k of ["platform_owner", "has_key", "media_models", "failover_model", "active_model"])
      assert(stub.includes(k), "替身里没提 " + k + "，它和真接口已经走散了");

    console.log(`✅ 后台「模型与 Key」：${used.length} 个图标名在 admin.html sprite 里全找得到（反向对照通过）· 真 /api/settings 带齐 ${s.providers.length} 渠道 × ${s.models.length} 模型 + platform_owner/active_model/failover_model/media_models · 没填 Key 的 has_key 全 false 且真 Key 不出门 · 替身与真接口字段对齐`);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(home, { recursive: true, force: true });
  }
}
function testKeySourcesGate() {
  const pub = path.join(__dirname, "..", "public", "js");
  const app03 = fs.readFileSync(path.join(pub, "app-03.js"), "utf8");
  const app05 = fs.readFileSync(path.join(pub, "app-05.js"), "utf8");
  const toolsSrc = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
  const mmSrc = fs.readFileSync(path.join(__dirname, "..", "media-models.js"), "utf8");
  const r = keySourcesCheck(app03, app05, toolsSrc, mmSrc);
  assert(r.problems.length === 0, "取 Key 链接缺口：\n  " + r.problems.join("\n  "));
  assert(r.searchIds.length >= 3 && r.imSrcs >= 4 && r.presets >= 9, "覆盖面不对：" + JSON.stringify({ search: r.searchIds.length, im: r.imSrcs, presets: r.presets }));
  // 反向对照：抠掉 tavily / 把一条改成 http / 去掉 rel=noopener，三种坏法都得被抓
  const variants = [
    ["抠掉 tavily", app03.replace(/\n  "tavily": \{[^\n]*\n/, "\n"), app05, mmSrc],
    ["http 链接", app03.replace('"https://app.tavily.com/home"', '"http://app.tavily.com/home"'), app05, mmSrc],
    ["丢 rel=noopener", app03.replace(' rel="noopener"', ""), app05, mmSrc],
    ["IM 卡指向不存在的来源", app03, app05.replace('src: "qq"', 'src: "qq_bot"'), mmSrc],
    ["渠道卡片不再挂取 Key 链接", app03, app05.replace("${kindKeyLink(p.kind, p.base_url)}", ""), mmSrc],
    ["某家渠道的取 Key 链接被抠空", app03, app05, mmSrc.replace('key_url: "https://openrouter.ai/keys"', 'key_url: ""')],
  ];
  let caught = 0;
  for (const [name, a3, a5, mm] of variants) {
    assert(a3 !== app03 || a5 !== app05 || mm !== mmSrc, "变体「" + name + "」没改动到源码，对照无效");
    if (keySourcesCheck(a3, a5, toolsSrc, mm).problems.length > 0) caught++;
    else throw new Error("闸门漏了这种坏法：" + name);
  }
  console.log(`✅ 取 Key 链接闸门：${Object.keys(r.KS).length} 个来源全 https+新窗口 · 渠道 ${r.presets} 家全覆盖 · 搜索 ${r.searchIds.length} 家 · IM ${r.imSrcs} 类 · 多媒体预设 ${r.mediaN} 条；反向 ${caught}/${variants.length} 种坏法全被拦`);
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
  assert(/const \{ sessionId, message, mode, regen, lang, lane \} = req\.body/.test(srv) && /lang: lang === "en" \? "en" : "zh",/.test(srv), "服务端 /api/chat 没把 lang 传给 runTask");
  assert(/function langBlock\(lang\)/.test(ag) && /projBlock \+ langBlock\(lang\) \+ modePrompt\(mode\)/.test(ag), "agent 系统提示词没拼 langBlock");
  assert(/if \(extra\.lang\) parts\.push\(langBlock\(extra\.lang\)\)/.test(ag) && /\{ projectContext, history, lang \}/.test(ag), "本机引擎（claude/codex）的系统提示词没接 lang");
  assert((ag.match(/askUser, lang[,}]/g) || []).length === 2 && (ag.match(/^        lang,\n/gm) || []).length === 2, "专家子任务没继承 lang");
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
  // 大小写要跟 skills.js 里的 /^skill\.md$/i 对齐。原来写死 "SKILL.md"：macOS 的文件系统
  // 大小写不敏感，二十个小写 skill.md 全都碰巧认得出来，换到 Linux 一个都认不出，
  // skillNames 成了空集合，validateExperts 会把每一条绑定都判成「技能不存在」——一片假红。
  const SKILLS_ROOT = path.join(__dirname, "..", "skills");
  const skillNames = new Set(fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.readdirSync(path.join(SKILLS_ROOT, d.name)).some((f) => /^skill\.md$/i.test(f)))
    .map((d) => d.name));
  assert(skillNames.size >= 15, "技能目录一个都没认出来（多半是文件名大小写写死了）：" + skillNames.size);
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
    // 出网的必须 https；跑在本机上的自建服务明文 http 是允许的——
    // 报文不出网卡，没有中间人可言，normalizeMcpServer 本来就给 localhost 开了这个口子。
    // 这条尺子只跟着它走，不比它更严：更严的话，等于永远不许用户接自己跑的东西。
    const okUrl = /^https:\/\//.test(norm.url || "") || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(norm.url || "");
    assert(norm.name === it.name && (norm.transport === "stdio" ? !!norm.command : okUrl), `预设「${it.name}」过不了后端规整：${norm.url || norm.command}`);
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

  // 3.5) 连不上的时候，界面上得写「下一步干什么」，不能只甩一句 fetch failed。
  // Node 的 fetch 把所有网络层错误都压成 `fetch failed`，真凶在 e.cause.code 里；
  // 以前直接把 e.message 存进 failures，用户看到的就是那句废话。
  const { whyFailed } = require(path.join(__dirname, "..", "mcp.js"));
  const mkErr = (msg, code, agg) => {
    const e = new Error(msg);
    if (code) e.cause = agg ? new AggregateError([Object.assign(new Error("x"), { code })]) : { code };
    return e;
  };
  const whyCases = [
    // [错误, 配置, 回话里必须出现的词]
    [mkErr("fetch failed", "ECONNREFUSED"), { url: "http://localhost:3000/mcp" }, "没有东西在听"],
    [mkErr("fetch failed", "ECONNREFUSED", true), { url: "http://127.0.0.1:8080/mcp" }, "没有东西在听"], // AggregateError 也得翻出来
    [mkErr("fetch failed", "ECONNREFUSED"), { url: "https://tools.example.com/mcp" }, "拒绝连接"],
    [mkErr("fetch failed", "ENOTFOUND"), { url: "https://typo.example/mcp" }, "解析不了"],
    [mkErr("fetch failed", "UND_ERR_CONNECT_TIMEOUT"), { url: "https://slow.example/mcp" }, "超时"],
    [new Error("MCP remote HTTP 401"), { url: "https://api.example.com/mcp" }, "Key"],
    [new Error("MCP remote HTTP 404"), { url: "https://api.example.com/x" }, "404"],
    [mkErr("spawn uvx ENOENT", "ENOENT"), { command: "uvx" }, "装 uv"],
    [mkErr("spawn npx ENOENT", "ENOENT"), { command: "npx" }, "Node.js"],
  ];
  for (const [err, cfg, want] of whyCases) {
    const got = whyFailed(err, cfg);
    assert(got.includes(want), `连接失败没翻译好：${err.message} → ${got}（缺「${want}」）`);
    assert(got !== err.message, `连接失败还在甩原文：${got}`);
  }
  // 阴性对照：认不出来的错要原样回，不许硬编一个故事
  assert(whyFailed(new Error("完全没见过的错"), {}) === "完全没见过的错", "不认识的错被瞎翻译了");
  // 存进 failures 的必须是翻译过的那句，原文另存 raw
  const mcpSrc = fs.readFileSync(path.join(__dirname, "..", "mcp.js"), "utf8");
  assert(/this\.failures\.push\(\{[^}]*error: why[^}]*raw: e\.message/.test(mcpSrc), "startAll 还在把 e.message 当 error 存给界面");

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
  assert(/if \(!ARGS\.dry && !ARGS\.canvas\) \{\s*\n\s*const wired = wireReadmes\(ROOT, ARGS\.out\)/.test(rec), "wireReadmes 必须只在真录的任务演示（非 --dry、非画布录制）时调");
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
  assert(/\["look", "外观", "palette"\]/.test(a05), "设置目录里没有「外观」页");
  assert(/active === "look"\) renderLookPane\(pane\)/.test(a05), "renderSettings 没把 look 派给 renderLookPane");
  assert(/^function renderLookPane\(pane\)/m.test(a06), "app-06 没定义 renderLookPane");
  assert(/act === "appearance"\) openModal\("settings", "look"\)/.test(a02), "头像菜单的「外观」没有直达外观页");
  const cats = a05.slice(a05.indexOf("const SETTING_CATS = ["), a05.indexOf("];", a05.indexOf("const SETTING_CATS = [")));
  const rows = [...cats.matchAll(/\["([a-z]+)", "([^"]+)", "([^"]+)"\]/g)];
  // 这个数字是故意钉死的：加一页设置就得回来改一次，顺手确认新页也接了线、图标也真存在。
  // 13 → 14 是「运行状况」那页进来的（日志/告警/指标那条线）。
  assert(rows.length === 14 && rows.every((m) => m[3].length && m[2].length <= 4), "设置目录每项都要 [id, ≤4字短名, 图标] 三元组，现在：" + rows.length + " 项");
  // 第三格从 emoji 换成图标名之后，多了一种新的翻车方式：忘了套 ic() 就直接把 "palette" 这几个字母印在目录上。
  // 这事只有人打开设置页才看得见，所以两头都钉死：名字得是 sprite 里真有的 symbol，画的时候得走 ic()。
  const { iconNames } = require("../icons");
  const sprite = iconNames();
  const strayIcons = rows.map((m) => m[3]).filter((n) => !sprite.has(n));
  assert(strayIcons.length === 0, "设置目录里这几个图标名 sprite 里没有，画出来会是一个空框：" + strayIcons.join("、"));
  assert(/\$\{cats\.map\(\(\[k, label, icon\]\)/.test(a05) && /class="ci">\$\{ic\(icon\)\}/.test(a05),
    "左栏没把图标画出来——图标名直接插进 HTML 的话，用户在设置目录上看到的是 brain / search / bot 这几个英文单词");
  // 反向对照：这把尺子认得出「sprite 里没有」，不然名字写错也一路绿
  assert(!sprite.has("根本没有这个图标") && sprite.has("palette"), "图标名核对失效");
  // 画的是过滤后的 cats，不是整张 SETTING_CATS：多人服务器上普通成员看不到那四个纯服务器级的标签页
  assert(/const cats = s\.platform_owner \? SETTING_CATS : SETTING_CATS\.filter/.test(a05), "左栏没按 platform_owner 过滤");
  for (const f of fs.readdirSync(path.join(pub, "js"))) {
    if (!f.endsWith(".js")) continue;
    assert(!/um-theme|um-opt/.test(rd(path.join("js", f))), "老的头像菜单主题子菜单还留在 " + f + " 里");
  }
  // 存储层：读写都要 try 包住（file:// / 隐私模式 / data: 页面会抛 SecurityError），且内存兜底
  const look = a02.slice(a02.indexOf("// ---------- 外观：主题"), a02.indexOf("// ---------- 头像菜单"));
  assert(/function lookRead\(k\) \{ try \{/.test(look) && /function lookWrite\(k, v\) \{ lookMem\[k\] = v; try \{/.test(look), "lookRead/lookWrite 没有 try + 内存兜底");
  assert(!/[^.]localStorage\.(get|set)Item\("owb-theme"/.test(look), "主题还在直连 localStorage，绕过了兜底层");
  assert(/^applyLook\(\);$/m.test(look) && /^applyTheme\(\);$/m.test(look), "外观/主题没有在脚本加载时立刻应用（会先闪一下默认样式）");
  // CSS：字号四档 + 五套皮肤各带浅/暗两块 + 密度规则 + body 走变量
  for (const [k, px] of [["s", 14], ["l", 16], ["xl", 18]]) assert(html.includes(`html[data-fs="${k}"] { --owb-fs: ${px}px; }`), "字号档 " + k + " 缺了");
  assert(/:root \{[^}]*--owb-fs: 15px;/.test(html), "默认字号变量 --owb-fs 没定义");
  // 字号选择器里那四个 A 的大小，必须就是真档位。预览夸大差距的话，人挑了「小」
  // 以为会小一圈、实际只小 1px，只会觉得这个开关坏了——比不给预览还糟。
  {
    const a06 = rd(path.join("js", "app-06.js"));
    const m = a06.match(/const LOOK_FS_PX = \{([^}]*)\}/);
    assert(m, "找不到字号预览的那张表 LOOK_FS_PX");
    const preview = {};
    for (const kv of m[1].split(",")) { const [k, v] = kv.split(":").map((x) => x.trim()); if (k) preview[k] = Number(v); }
    const real = { m: Number((html.match(/:root \{[^}]*--owb-fs: (\d+)px;/) || [])[1]) };
    for (const k of ["s", "l", "xl"]) real[k] = Number((html.match(new RegExp(`html\\[data-fs="${k}"\\] \\{ --owb-fs: (\\d+)px;`)) || [])[1]);
    for (const k of ["s", "m", "l", "xl"]) {
      assert.strictEqual(preview[k], real[k],
        `字号档「${k}」的预览写着 ${preview[k]}px，真档位是 ${real[k]}px——预览在骗人`);
    }
    // ★反向对照★：把预览值挪一格，同一把尺子必须判红
    let moved = false;
    try { assert.strictEqual(preview.s + 1, real.s, "x"); } catch { moved = true; }
    assert(moved, "字号预览这把尺子失灵了，差一格也判绿");
  }
  assert(/body \{[^}]*font-size: var\(--owb-fs\)/.test(html) && /body \{[^}]*font-family: var\(--font-sans\)/.test(html), "body 字号/字体没接到变量上");
  for (const skin of ["ocean", "forest", "sunset", "rose", "graphite"]) {
    const light = html.match(new RegExp(`^  html\\[data-skin="${skin}"\\] \\{([^}]*)\\}`, "m"));
    const dark = html.match(new RegExp(`^  html\\[data-theme="dark"\\]\\[data-skin="${skin}"\\] \\{([^}]*)\\}`, "m"));
    assert(light && dark, "皮肤 " + skin + " 缺浅色或暗色块");
    for (const t of ["--primary", "--ring", "--ring-weak", "--brand-text", "--owb-brand-on-white", "--owb-brand-grad"]) assert(light[1].includes(t + ":"), "皮肤 " + skin + " 浅色块缺 " + t);
    for (const t of ["--ring", "--ring-weak", "--brand-text"]) assert(dark[1].includes(t + ":"), "皮肤 " + skin + " 暗色块缺 " + t + "（暗底上浅色的字色/描边会看不清）");
  }
  assert((html.match(/^  html\[data-density="compact"\] /gm) || []).length >= 5, "紧凑密度至少要收 5 处间距");
  assert(/html\[data-font="serif"\] \{ --font-sans:/.test(html) && /html\[data-font="mono"\] \{ --font-sans: var\(--font-mono\); \}/.test(html), "字体三选缺规则");
  // 字号联动：这些尺寸不能再写死 px，否则调字号只有正文在动
  // 前缀带换行+两空格：只认顶层规则，别撞上 html[data-density="compact"] .hist-item 那条
  // 输入框的字号如今跟高亮镜像层写在同一条规则里（两层必须一个字号，分开写迟早漂——
  // 逐字对齐那屏就是拿这个当尺子的），所以这儿钉的是那一条，不是只管宽度的那条。
  const fsRule = (sel) => { const i = html.indexOf(sel); assert(i > 0, "找不到 " + sel); return html.slice(i, html.indexOf("}", i)); };
  for (const sel of ["\n  .a-text h1 {", "\n  .a-text h2 {", "\n  #input-hl, textarea#input { font-size", "\n  .hist-item { padding"]) {
    assert(/var\(--owb-fs\)/.test(fsRule(sel)), sel + " 的字号还写死 px，没跟 --owb-fs 联动");
  }
  // ★反向对照★：这把尺子不是见谁都绿——只管布局不管字号的那条就该判不合格
  assert(!/var\(--owb-fs\)/.test(fsRule("\n  textarea#input { width")), "字号联动这把尺子失灵了，连不含字号的规则都判绿");
  // 上手那节必须提一句外观在哪改：字号和主题是最先被嫌弃的两样，翻文档才找得到就等于没有。
  // 按小标题切片再查，比 [\s\S]* 一路跨到下一节严——不然写在别的节里也能蒙混过关
  const readmeRun = (fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")
    .split(/^## 三分钟跑起来\s*$/m)[1] || "").split(/^## /m)[0];
  assert(/外观/.test(readmeRun), "README「三分钟跑起来」一节没提外观设置");
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
    console.error("❌ 测试失败:", (e && e.stack) || e.message);
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
 * 内置引擎撞上限会做两件事：发一个 limit 事件、并把「注意：…，任务强制收尾。」写进正文。
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
    // 两条路（内置循环 / 本机 CLI 引擎）各自拼这句话，措辞一旦漂开，用户在 Web 和 IM 上看到的就是两种说法。
    // 所以措辞只许存在一份——agent.js 里的 stopNotice()，两条路都去叫它。谁再手抄一遍，这里当场红。
    const agentSrc = fs.readFileSync(path.join(__dirname, "..", "agent.js"), "utf8");
    const seen = (agentSrc.match(/stopNotice\(/g) || []).length;
    assert.strictEqual(seen, 3, `agent.js 里 stopNotice 应当是「一处定义 + 两处调用」共 3 次，实际 ${seen} 次——两条路又各拼各的了`);
    const inline = (agentSrc.match(/，任务强制收尾。/g) || []).length;
    assert.strictEqual(inline, 1, `「，任务强制收尾。」只该出现在 stopNotice 里那一份，实际 ${inline} 处——有人手抄了一遍措辞`);
    assert(A.r.finalText.includes("注意：已达最大步数（25 步），任务强制收尾。"),
      "收尾提示的措辞跟内置引擎对不上：" + A.r.finalText);
    // 用户原话：「已达最大运行时间，任务强制收尾怎么回事啊」——光说「提高设置中的上限」等于没说。
    // 撞上限这条必须自带下一步：上限在哪一页、还有「自动续跑轮数」这个开关。
    assert(A.r.finalText.includes("设置 → 执行上限") && A.r.finalText.includes("自动续跑轮数"),
      "★撞上限了却没说上限在哪一页、也没提自动续跑★ 用户只能回过头来问「怎么回事」：" + A.r.finalText);
    assert(A.r.finalText.includes("PROGRESS.md"), "没告诉用户进度档在哪，「接着上次进度做」就成了空话：" + A.r.finalText);
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
    // 手动停止是用户自己按的，还劝人家去调大上限就是答非所问
    assert(!C.r.finalText.includes("执行上限") && !C.r.finalText.includes("任务强制收尾"),
      "★用户自己按的停止，却被当成撞上限劝去调大上限★：" + C.r.finalText);
    assert(C.r.finalText.includes("接着上次进度做"), "手动停止之后没给出怎么接着做：" + C.r.finalText);
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
  assert(/models:\s*Array\.isArray\(r\.models\)/.test(idx), "detectAll 没把探测到的真实模型候选带给前端");
  for (const id of ["claude-code", "codex"]) {
    const be = engines.get(id);
    assert(Array.isArray(be.models), id + " 的模型候选不是数组");
    if (id === "claude-code") assert(be.models.length >= 3, id + " 没给模型候选");
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

  // ② 账本 + ③ 反馈：各起一个子进程，OPENWORKBUDDY_DATA_DIR 指到临时目录，不碰真账本
  const run = (script, tag) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fbu-"));
    const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, OPENWORKBUDDY_DATA_DIR: dir }, encoding: "utf8" });
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
    const DATA = process.env.OPENWORKBUDDY_DATA_DIR;
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
    assert(sc[0].why.includes("生效后用户反馈 好评 4 / 差评 1"), "why 里没写反馈：" + sc[0].why);
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
  const IM = require("../im");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-im-media-"));

  // ---- 飞书重投：SDK 直传 / HTTP 回调包裹的载荷必须拿到同一条 message_id ----
  const rawFs = { message_id: "om_demo", chat_id: "oc_demo", message_type: "text", content: '{"text":"你好"}' };
  const wrappedFs = { header: { event_id: "evt_demo" }, event: { message: rawFs } };
  assert.strictEqual(IM.unwrapFeishuInbound(rawFs).message, rawFs, "飞书 SDK 直传消息没拆出来");
  assert.strictEqual(IM.unwrapFeishuInbound(wrappedFs).message, rawFs, "飞书 HTTP 回调消息没拆出来");
  const dedupe = IM.feishuDedupeKeys(rawFs, "evt_demo");
  assert(dedupe.includes("e:evt_demo") && dedupe.includes("m:oc_demo:om_demo"),
    "飞书去重没有同时记 event_id 和 message_id：" + JSON.stringify(dedupe));

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
  assert(/const sendOnce = async \(fn\) => fn\(\)/.test(imSrc) && !/await twice\(/.test(imSrc),
    "IM 发送还在盲目重试；请求超时后可能已经送达，会把同一回复发两次");
  assert(/drive\.notice\.comment_add_v1/.test(imSrc) && /is_mentioned/.test(imSrc) && /feishuReplyDocComment/.test(imSrc),
    "飞书文档评论 @ 没走事件 → 读评论 → 原评论回复的闭环");
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

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const child = booted.child;
  const { up, port, why: bootWhy } = await booted.wait();

  const req = (method, p, body) => new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: { Cookie: "openworkbuddy_token=" + token, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
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
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);

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

  // ---- 生成类（出图/出片/出声）也合段，但跟只读分成两类 ----
  // 为什么单独一类而不是并进只读：这两类的约束正好相反。只读便宜、快、重来一次不心疼；
  // 生成类每条都花钱（视频按条计费）、慢的以分钟计，而且**会写文件**。上限不同是一层，
  // 更要紧的是混进同一段就等于把「先写后读」的先后依赖交给了调度器。
  const { GEN_TOOLS } = require("../agent");
  const genGroups = splitParallelRuns(
    [{ name: "generate_video" }, { name: "generate_video" }, { name: "generate_video" }], RO, GEN_TOOLS);
  assert.strictEqual(genGroups.length, 1, "三条生成视频没合成一段：一集短剧十几个镜头一条条排，最坏要等一两个小时");
  assert.strictEqual(genGroups[0]._kind, "gen", "合出来的段没标成 gen，界面会按只读那套话术播报（说错花没花钱）");
  assert.strictEqual(genGroups[0]._ro, false, "gen 段被标成只读了，并发上限会按只读那档给——这类每条都花钱，不能按只读放");
  // 出图/出片/出声三样混着也算同一类
  assert.strictEqual(
    splitParallelRuns([{ name: "generate_image" }, { name: "text_to_speech" }], RO, GEN_TOOLS).length, 1,
    "生图和配音没合段：它们之间没有任何先后关系");
  // 负向控制①：生成类跟写文件绝不合段——写文件的先后顺序本身就是语义
  assert.strictEqual(
    splitParallelRuns([{ name: "generate_image" }, { name: "write_file" }], RO, GEN_TOOLS).length, 2,
    "生图和写文件被并进同一段了：写文件的先后顺序会被调度器打乱");
  // 负向控制②：生成类跟只读也不合段——上限不同，而且生成类会写文件，混段=顺序交给调度器
  const mixed = splitParallelRuns([{ name: "generate_image" }, { name: "read_file" }], RO, GEN_TOOLS);
  assert.strictEqual(mixed.length, 2, "生图和读文件被并进同一段了：先写后读的依赖就废了");
  // 负向控制③：不传第三个参数时行为必须跟以前逐字节一致——老调用点和老测试不能被这次改动带偏
  assert.strictEqual(
    splitParallelRuns([{ name: "generate_image" }, { name: "generate_image" }], RO).length, 2,
    "没传 gen 名单却把生成类合段了：两参数的老调用点会在用户不知情的情况下开始并发花钱");
  // html_to_image 故意不在名单里：htmlshot.js 自己就是一条串行队列（一个 Electron 窗口轮流截图），
  // 放进来并发不了，只会给用户一个「在并发」的假象
  assert.ok(!GEN_TOOLS.includes("html_to_image"), "html_to_image 进了生成类名单：底层是串行队列，界面会播报一个假的并发");

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

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home, PATH: bin + path.delimiter + process.env.PATH });
  const child = booted.child;
  const { up, port, why: bootWhy } = await booted.wait();
  const req = (method, p, body) => new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: "127.0.0.1", port, path: p, method,
      headers: { Cookie: "openworkbuddy_token=" + token, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
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
    assert(up, "真 server.js 没起来，这条测试作废：" + bootWhy);

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
/**
 * 生图/生视频存盘时别在好好的后缀后面再接一个。
 *
 * 真实事故：模型给图起名 yhfig_erhai.jpg，存盘时按 ".png" 兜底，落到磁盘上就成了
 * yhfig_erhai.jpg.png。正文里写的还是 yhfig_erhai.jpg —— 名字对不上，那张图在对话里
 * 就是一个裂开的图框。用户原话：「怎么有些图都不渲染啊？」
 *
 * 判据是「同一类东西的后缀就算数」，不是「必须是我指定的那一个」。
 */
function testOutNameKeepsExt() {
  const { safeOutName } = require("../tools")._internals;
  const eq = (got, want, why) => assert.strictEqual(got, want, why);

  // 同一族：图就是图，别再接一个
  eq(safeOutName("yhfig_erhai.jpg", ".png", "image"), "yhfig_erhai.jpg", "jpg 被硬接成 .png（对话里那张图就裂了）");
  eq(safeOutName("封面.JPEG", ".png", "image"), "封面.JPEG", "大写后缀没认出来");
  eq(safeOutName("图.webp", ".png", "image"), "图.webp", "webp 也是图");
  eq(safeOutName("成片.mov", ".mp4", "video"), "成片.mov", "mov 也是片子");
  eq(safeOutName("口播.m4a", ".mp3", "audio"), "口播.m4a", "m4a 也是音频");

  // 反向对照：跨族的该补就补，别把这条修成「一律不补后缀」
  eq(safeOutName("a.txt", ".png", "image"), "a.txt.png", "跨族没补后缀——那存出来的是个打不开的文件");
  eq(safeOutName("报告", ".png", "image"), "报告.png", "没后缀的没补");
  eq(safeOutName("成片.mp3", ".mp4", "video"), "成片.mp3.mp4", "音频名拿去存视频，该补");

  // 文件名里的路径分隔符和非法字符照旧要洗掉（别为了保后缀把这条放了）
  assert.ok(!safeOutName("a/b/c.png", ".png", "image").includes("/"), "路径分隔符没洗掉");
  eq(safeOutName('问?号.png', ".png", "image"), "问_号.png", "非法字符没洗掉");

  // 空名兜底：给得出一个带正确后缀的名字，不是一个光秃秃的后缀
  const auto = safeOutName("   ", ".png", "image");
  assert.ok(auto.startsWith("image_") && auto.endsWith(".png"), "空名兜底不对：" + auto);

  // 同一毫秒里连着兜底若干次，名字必须互不相同。
  // 生图现在能一轮并发两条，两张图同一毫秒返回就会写同一个文件名——后写的把先写的盖掉，
  // 而界面上两张卡都报成功。这种错不留任何痕迹，只能在这儿拦。
  const burst = Array.from({ length: 8 }, () => safeOutName("", ".png", "image"));
  assert.strictEqual(new Set(burst).size, burst.length, "同毫秒兜底文件名撞车了（并发下后一张会盖掉前一张，两张还都报成功）：" + burst.join(" "));
  assert.ok(burst.every((n) => n.startsWith("image_") && n.endsWith(".png")), "去重后缀挂到后缀外面去了：" + burst.join(" "));

  console.log("✅ 存盘文件名：本来就是图/片子/音频的后缀不再被接第二个（yhfig_erhai.jpg.png 那类裂图）· 跨族照补 · 非法字符照洗");
}

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
 * 桌面版和命令行的 openworkbuddy 写的是同一批文件（data/sessions/<id>.json），而 `openworkbuddy resume` 不给 id 时
 * 接的就是「最近动过的那条」，包括桌面上刚开的那个——这是它自己注释里写的「丝滑切换」的落点。
 * 可 server.js 这边的 sessions Map 一旦读进来就再也不回头看盘：
 * 「桌面开个头 → 终端 openworkbuddy resume 接着做几轮 → 回桌面再发一句」，
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-sesscache-"));
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
  const srv = build(false);
  const s1 = srv.getSession(id);
  assert.strictEqual(s1.history.length, 1, "第一次读盘就没读对");

  // 2) 用户切到终端，openworkbuddy resume 接着做了两轮，直接写同一个文件
  store.writeJsonAtomic(file, { history: H("帮我整理下装修报价", "拆成了三张表", "再加一列单价"), transcript: [], title: "装修报价", updated_at: null });
  const s2 = srv.getSession(id);
  assert.strictEqual(s2.history.length, 3, "★命令行 openworkbuddy 写进去的那几轮，桌面这边看不见（内存副本一直没回头看盘）★");

  // 3) 回桌面再发一句 —— 终端那两轮必须还在
  s2.history.push({ role: "assistant", content: "单价加好了" });
  srv.saveSession(id);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(onDisk.history.length, 4, "★桌面这边一存盘，就把命令行做的那几轮整段盖掉了★");
  assert.ok(onDisk.history.some((h) => h.content === "拆成了三张表"), "终端那轮的内容没了");

  // 4) 自己刚写完的盘不算「别人改的」：不然每次存完盘都要白读一遍，
  //    手上那份内存对象一换引用，正在拼的那一轮就跟着丢
  assert.strictEqual(srv.getSession(id), s2, "★自己刚写进去的盘被当成别人改的，下一次取会话就把手上这份换掉——正在拼的那轮跟着丢★");
  assert.strictEqual(srv.sessions.get(id), s2, "内部状态对不上");

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
  assert.deepStrictEqual(srv.getSession("s_1730000000009_new").history, [], "新会话没给空壳");

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
  console.log("✅ 会话不吃陈内存：命令行 openworkbuddy 写的几轮桌面能看见、存盘不覆盖；自己写的不误判、跑着的任务不被盘上旧版盖回去");
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

  // 直调口（重跑一格不过模型）。它拿 sessionId 只为定产物落点，可 sess.dir 本身就是别人的
  // 成果目录——不查归属的话，随便一个登录用户都能把自己生成的图写进别人的交付文件夹里
  const direct = routeOf('app.post("/api/tool/run"', 1600);
  const iOwn = direct.indexOf("sessionAllowed(user, sess)");
  const iDir = direct.indexOf("sess.dir");
  assert.ok(iOwn > 0, "POST /api/tool/run 没查会话归属 → 拿到别人的会话 id 就能往他的成果目录里写文件");
  assert.ok(iDir > 0 && iOwn < iDir, "POST /api/tool/run 的归属检查排在用 sess.dir 之后了，等于没查");
  // 白名单必须只有一份（agent.js 的 DIRECT_TOOLS）。路由自己去 require tools.executeTool 的话，
  // 白名单就绕过去了——那条路能直接从 HTTP 扣动 run_shell
  assert.ok(/runtime\.runTool\(/.test(direct), "POST /api/tool/run 没走 runtime.runTool");
  assert.ok(!/executeTool\(/.test(direct), "★POST /api/tool/run 绕开 runtime 自己调了 executeTool★ 白名单就此形同虚设，HTTP 能直接扣动 run_shell");

  console.log("✅ 跑着的任务防插手：插队/代答/停止/续流四条都查归属（本人·同组织管理员·老会话放行，跨组织连管理员也拒），/api/chat 归属先于 SSE 头，running 按侧栏窄口径，/api/tool/run 查归属且只走白名单");
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
    let sessReads = 0; // 盘上索引那一节要数「这一趟到底回去读了几个会话文件」
    const readNames = []; // 光有个数不够：有时候要问的是「**哪一个**被回去读了」
    const store = {
      readJson: (p2, dflt) => { if (/\.json$/.test(p2)) { sessReads++; readNames.push(path.basename(p2)); } try { return JSON.parse(fs.readFileSync(p2, "utf8")); } catch { return dflt; } },
      writeJsonAtomic: (p2, d) => fs.writeFileSync(p2, JSON.stringify(d)),
    };
    const live = new Map();
    // lanes 注真模块，不给桩：「老会话该不该被替他填一条线」正是下面要验的事
    const lanesMod = require("../lanes");
    const build = () => new Function("fs", "path", "store", "sessions", "SESS_DIR", "lanes",
      SLICE + "\nreturn { listSessionsOnDisk, sessionRow, ownSession, sessMetaCache };")(fs, path, store, live, dir, lanesMod);

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
    // 工作线：如实报「记过的那条」，没记过的一个字不编。
    // 老会话没记过 lane，服务端就交白卷，回落到哪条线是前端的事（lanes.DEFAULT_LANE = 办公）。
    // 服务端要是自作主张替它填一条，两个前端版本的口径一对不上，整批历史就会「凭空少一半」。
    assert.strictEqual(rows.find((r) => r.id === "s_2").lane, undefined, "没记过工作线的老会话被服务端替它编了一条");
    put("s_8", { title: "在工程线上干的活", updated_at: "2026-09-06T00:00:00.000Z", lane: "cli" });
    put("s_9", { title: "工作线字段被写脏了", updated_at: "2026-09-06T00:00:00.000Z", lane: "Office " });
    put("s_10", { title: "谁塞了个不存在的线", updated_at: "2026-09-06T00:00:00.000Z", lane: "hack" });
    const laneRows = build().listSessionsOnDisk();
    assert.strictEqual(laneRows.find((r) => r.id === "s_8").lane, "cli", "记过的工作线没带给侧栏");
    assert.strictEqual(laneRows.find((r) => r.id === "s_9").lane, "office", "大小写/空格没归一，侧栏会当成另一条线而整条不显示");
    assert.strictEqual(laneRows.find((r) => r.id === "s_10").lane, undefined, "认不出来的线名被原样放行了");
    for (const id of ["s_8", "s_9", "s_10"]) fs.rmSync(path.join(dir, id + ".json"));

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

    // ---- 盘上那份索引：重启后别再把每条会话整个读一遍 ----
    //
    // 内存里那个 Map 只在进程活着时管用。1500 条会话（20MB）实测，重启后第一次拉侧栏
    // 要 326ms——全花在「把每个 JSON 整个 parse 一遍，只为了取标题和轮数」上，
    // 而且用得越久越慢。落一份到盘上之后同一趟是 31ms。
    // 判据还是 mtime，所以下面既要验「真的没回去读」，也要验「文件一改就不认旧的了」。
    // 上面为了验别的事 build() 了好几份，每一份都是**独立一个实例**、各带一个攒 2 秒的定时器，
    // 写的又是同一个文件——谁最后落地谁说了算。真跑起来只有一个进程在写，
    // 不存在这个赛跑；但两个进程共用一个数据目录（桌面版 + openworkbuddy serve）确实可能互相盖。
    // 那也不会出错：判据始终是 mtime，索引旧了顶多白读一次盘，绝不会让侧栏显示错的东西。
    // 这里先把所有旧定时器放干净，再让「被测的这一份」最后写一次，结果才是确定的。
    await new Promise((r) => setTimeout(r, 2200));
    const idxFile = path.join(dir, ".index");
    fs.rmSync(idxFile, { force: true });   // 先清掉，下面看到的那份就一定是 Mw 写的
    const Mw = build();
    Mw.listSessionsOnDisk();
    // 写盘是攒 2 秒的。原来这儿是 `await sleep(2200)`——只给那个定时器留 200ms 的富余，
    // 跑整套 `npm test` 时（前面刚跑完一屏 Electron）它迟到得毫不费力，落在盘上的就还是
    // 某个旧实例写的老索引：s_1 的 mtime 对不上，M2 回去读了它一个文件，于是下面那条
    // 「sessReads === 0」红一下，而被测的这段代码根本没问题。改成等到**确认是 Mw 那一份**为止。
    const want = fs.statSync(path.join(dir, "s_1.json")).mtimeMs;
    const isMine = () => {
      try {
        const got = JSON.parse(fs.readFileSync(idxFile, "utf8"));
        const hit = got && got.rows && got.rows["s_1.json"];
        return !!(hit && hit.mtime === want);
      } catch { return false; }
    };
    const deadline = Date.now() + 20000;
    while (!isMine() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(idxFile), "索引没落盘，重启后还是要全量重读");
    assert.ok(isMine(), "等了 20 秒，盘上那份索引还不是 Mw 写的（攒 2 秒的定时器没落地？）");
    assert.ok(!fs.readdirSync(dir).some((f) => f !== ".index" && /index/.test(f)),
      "索引文件名带了 .json，会被当成一条假会话摆进侧栏第一行");
    assert.deepStrictEqual(M.listSessionsOnDisk().map((r) => r.id), rows.map((r) => r.id),
      "索引落盘后同一个进程的清单就变了");

    const M2 = build(); // 装作重启：新的一份内存缓存，盘没动
    sessReads = 0;
    readNames.length = 0;   // 计数归零的时候名字也得归零，不然报错里列的是从头到现在读过的一整串
    const afterBoot = M2.listSessionsOnDisk();
    assert.deepStrictEqual(afterBoot.map((r) => r.id), rows.filter((r) => !live.has(r.id)).map((r) => r.id),
      "重启后从索引里拼出来的清单跟直接读盘的不一样：" + JSON.stringify(afterBoot.map((r) => r.id)));
    assert.strictEqual(afterBoot[0].title, rows.find((r) => r.id === afterBoot[0].id).title, "索引里存的标题不对");
    assert.strictEqual(sessReads, 0, "有索引还是把 " + sessReads + " 个会话文件重读了一遍（" + readNames.join("、")
      + "）——这节省下的正是那 300ms");

    // 盘上的会话被改了：mtime 对不上就必须回去读原文件，不许吃旧索引
    put("s_3", { title: "同事的周报（背着服务器改的）", user: "staff", updated_at: "2026-09-08T00:00:00.000Z" });
    const t3 = Date.now() / 1000 + 20;
    fs.utimesSync(path.join(dir, "s_3.json"), t3, t3);
    const M3 = build();
    sessReads = 0;
    const refreshed = M3.listSessionsOnDisk();
    assert.ok(/背着服务器改的/.test(refreshed.find((r) => r.id === "s_3").title),
      "★吃到了旧索引★ 会话在别处改过，侧栏还显示改之前的标题");
    assert.strictEqual(sessReads, 1, "只有 s_3 变了，却重读了 " + sessReads + " 个文件（mtime 判据失效了）");

    // 索引坏了 / 是别的形状：顶多白读一次盘，不许把侧栏整条炸掉
    fs.writeFileSync(idxFile, "{ 这也不是 JSON");
    assert.deepStrictEqual(build().listSessionsOnDisk().map((r) => r.id), refreshed.map((r) => r.id),
      "索引文件坏了，清单就出不来了");
    fs.writeFileSync(idxFile, JSON.stringify({ v: 1, rows: { "s_1.json": { mtime: 1 }, "s_9.json": null, "s_x.json": { mtime: 2, row: {} } } }));
    const guarded = build().listSessionsOnDisk();
    assert.deepStrictEqual(guarded.map((r) => r.id), refreshed.map((r) => r.id),
      "索引里塞了缺 row / row 没 id 的条目，被当成真会话放进清单了：" + JSON.stringify(guarded.map((r) => r.id)));

    // 内存里正在跑的那份优先：刚改过还没落盘，侧栏不能显示旧标题
    readNames.length = 0;
    live.set("s_1", { title: "正在跑，标题刚被模型润色过", user: "boss", transcript: [{}, {}], updated_at: "2026-09-07T00:00:00.000Z" });
    rows = M.listSessionsOnDisk();
    // 认 id 找，不看第几行：s_3 上面刚被改到 09-08，本来就该排在 s_1（09-07）前头。
    // 这里验的是「同一条会话，内存里那份赢过盘上那份」，跟谁排第一无关（排序上面已经验过了）。
    const hot = rows.find((r) => r.id === "s_1");
    assert.strictEqual(hot.title, "正在跑，标题刚被模型润色过", "内存里那份没被优先用，侧栏显示的是盘上的旧标题");
    assert.strictEqual(hot.turns, 2, "轮数还是盘上那份的——说明整行都是从索引里拼的，内存里跑着的那份没赢");
    assert.ok(!readNames.includes("s_1.json"), "内存里明明有，还是回去把 s_1.json 读了一遍");

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


/**
 * 画布不许把用户的东西弄没了。
 *
 * 用户原话：「现在无限画布还有很大文件都没有办法正常显示了啊，用户之前下载我老版本的软件，
 * 要更新的话你也要给我解决这个问题啊」。查下来不是显示不出来，是**真的被删了**：
 * canvasNormalizeState 既当序列化又当校验器，还同时站在读和写两条路上，于是
 *   · 超过 CANVAS_MAX_NODES 的画布，读出来就被截断，界面拖一下自动回存 → 盘上真的只剩 500 个；
 *   · 老版本/新版本建的、这个版本不认识的 kind，读的时候直接扔掉 → 升级一次少一批节点；
 *   · 文件写到一半断电，读出来是一张空画布 → 界面画白板 → 自动保存 → 残骸被盖成 []。
 * 三条都是「打开一看东西没了」，而且都发生在升级之后，正好对上用户说的那个场景。
 *
 * 所以这条测试盯的不是某个函数的返回值，是这三条路本身：拿真 server.js 跑一遍，
 * 每一条都验「数据还在不在」，而不是验「有没有报错」。
 */
async function testCanvasDataLoss() {
  const http = require("http"), crypto = require("crypto");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-canvas-"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const child = booted.child;
  const { up, port, why } = await booted.wait();

  const call = (method, p, body) => new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Cookie: "openworkbuddy_token=" + token, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json: j }); }); });
    r.on("error", (e) => resolve({ code: 0, body: e.message, json: null }));
    if (data) r.write(data);
    r.end();
  });

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + why);

    // ── ① 超上限 + 这个版本不认识的类型：存进去再读出来，一个不少 ──────────
    const nodes = [];
    for (let i = 0; i < 600; i++) nodes.push({ id: "n" + i, kind: "note", payload: { text: "第" + i + "条" }, position: { x: i, y: i } });
    nodes.push({ id: "future", kind: "未来版本才有的类型", payload: { title: "别删我", secret: "原样保留" }, position: { x: 9, y: 9 } });
    const edges = [{ source: { id: "n0" }, target: { id: "future" }, relation: "这个版本也不认识的用途" },
                   { source: { id: "n1" }, target: { id: "不存在的节点" } }];
    const put = await call("PUT", "/api/canvas", { name: "main", state: { version: 1, nodes, edges, updatedAt: Date.now() } });
    assert(put.code === 200, "画布写不进去（HTTP " + put.code + "）：" + put.body.slice(0, 200));
    const got = await call("GET", "/api/canvas");
    assert(got.code === 200, "画布读不出来（HTTP " + got.code + "）：" + got.body.slice(0, 200));
    assert(got.json.nodes.length === 601,
      `★往返丢节点★ 存进去 601 个，读出来 ${got.json.nodes.length} 个。上限该拦的是「再往里加」，不是替用户删已经有的——` +
      "一张叫无限画布的东西，打开自己的旧文件被删到 500 个，说不过去");
    const future = got.json.nodes.find((n) => n.id === "future");
    assert(future && future.kind === "未来版本才有的类型",
      "★认不出的节点类型被扔了★ 老版本或新版本建的节点，在这个版本里打开一次就没了——升级用户正是这么丢东西的");
    assert(future.payload.secret === "原样保留", "认不出的节点 payload 被抹了，等于节点还在但内容没了");
    assert(got.json.edges.length === 1 && got.json.edges[0].relation === "这个版本也不认识的用途",
      "认不出的连线用途被抹成一根没名字的线，或者挂空的连线没清掉：" + JSON.stringify(got.json.edges));
    assert(got.json.lost && got.json.lost.overflowNodes === 101,
      "超上限得如实记账，界面才提醒得了用户，而不是默默留着：" + JSON.stringify(got.json.lost));

    // 挂空的连线是写进去那一下就丢的（界面上本来也画不出来），要验读的这条路得绕开 PUT
    // 直接往盘上写一份——老版本留下的文件正是这样进来的
    const hits = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name === "canvas.json") hits.push(f); } })(home);
    assert(hits.length === 1, "画布文件没找着或找着多个：" + hits.join(" "));
    const file = hits[0];
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...raw, nodes: raw.nodes.concat([{ kind: "note", payload: {} }]), edges: raw.edges.concat([{ source: { id: "n1" }, target: { id: "早就删了的节点" } }]) }));
    const relisted = await call("GET", "/api/canvas");
    assert(relisted.json.lost && relisted.json.lost.danglingEdges === 1 && relisted.json.lost.noId === 1,
      "读的时候确实清掉的那两类（没 id 的节点、挂空的连线）没记账，用户看不见自己少了东西：" + JSON.stringify(relisted.json.lost));

    // ── ② 文件坏掉：得说「读不出来」，绝不能给一张空画布 ────────────────────
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, 400));   // 写到一半断电的样子
    const broken = await call("GET", "/api/canvas");
    assert(broken.code === 409, "坏掉的画布还回 200（实得 " + broken.code + "）——界面会照着画白板，然后自动保存把残骸盖掉");
    assert(broken.json && broken.json.unreadable === true, "409 没带 unreadable 标记，前端分不清「读不出来」和「还没建过」");
    assert(!("nodes" in broken.json),
      "★409 的响应里带了 nodes★ 只看 body 不看状态码的那条路会把它当成一张空画布——这一整套防护就是为了拦这个");
    assert(fs.readdirSync(path.dirname(file)).some((n) => n.includes("坏了")),
      "坏掉的原件没备份。画布是用户一笔一笔摆出来的，没有回收站，出事就是白干：" + fs.readdirSync(path.dirname(file)).join(" "));

    // ── ③ 坏着的时候不许覆盖，除非用户自己说 force ─────────────────────────
    const before = fs.readFileSync(file, "utf8");
    const blind = await call("PUT", "/api/canvas", { name: "main", state: { version: 1, nodes: [], edges: [] } });
    assert(blind.code === 409, "★读不出来的文件被闷头覆盖了★「打开 → 报错 → 界面照常自动存一次」这条路照样能把还有救的文件盖成空画布");
    assert(fs.readFileSync(file, "utf8") === before, "被挡下来了但文件还是变了，等于没挡");
    const forced = await call("PUT", "/api/canvas", { name: "main", force: true, state: { version: 1, nodes: [{ id: "a", kind: "note", payload: {} }], edges: [] } });
    assert(forced.code === 200, "用户自己说了 force 还是写不进去，人就没有恢复的路了（HTTP " + forced.code + "）：" + forced.body.slice(0, 200));
    assert(JSON.parse(fs.readFileSync(file, "utf8")).nodes.length === 1, "force 之后盘上不是用户给的那份");

    // ── ④ 列表里坏掉的画布要显成「读不出来」，不是「0 个节点」────────────────
    const second = await call("PUT", "/api/canvas", { name: "第二张", state: { version: 1, nodes: [{ id: "x", kind: "note", payload: {} }], edges: [] } });
    assert(second.code === 200, "第二张画布建不起来（HTTP " + second.code + "）");
    fs.writeFileSync(path.join(path.dirname(file), "canvases", "第二张.json"), "{坏");
    const list = await call("GET", "/api/canvas/list");
    const row = (list.json.canvases || []).find((c) => c.name === "第二张");
    assert(row && row.broken,
      "坏掉的画布在列表里显示成「0 个节点」——看着就是一张空画布，用户会直接点进去开始画，然后把它盖掉：" + JSON.stringify(row));

    // ── ⑤ 前端那半边：静态闸门 ────────────────────────────────────────────
    // 上面四条验的都是服务端。服务端拦住了不等于用户看得见——前端要是还把 409
    // 当空画布、把认不出的类型画成一张能写字的空笔记，用户照样会在不知情的情况下把数据覆盖掉
    const ui = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
    assert(/if \(!response\.ok \|\| \(body && body\.unreadable\)\)/.test(ui),
      "canvasLoadRemote 没看状态码/unreadable，又会把读不出来当成空画布");
    assert(/canvasState\.remoteBroken/.test(ui) && /function canvasRenderBroken/.test(ui),
      "画布读不出来的时候没有整页兜底，界面还是会照常起 JointJS、铺底、自动保存");
    assert(/if \(canvasState\.remoteBroken\) \{ canvasRenderBroken/.test(ui),
      "兜底函数写了但没接到初始化路径上，等于没写");
    assert(/if \(!CANVAS_NODE_DEFS\[kind\]\) \{/.test(ui) && /canvas-node-unknown/.test(ui),
      "认不出的类型还是画成可编辑的空白笔记，用户随手一打字就把人家的 payload 盖了");
    assert(/response\.status === 409 && result\.unreadable/.test(ui),
      "自动保存撞上 409 不吭声，用户会一直以为在存，关掉页面才发现白干了");
    assert(/function canvasStorageKey/.test(ui) && !/localStorage\.setItem\(CANVAS_STORAGE_KEY,/.test(ui),
      "本机副本还是所有画布共用一个键：切到还没内容的 B 画布会把 A 的节点铺上去，自动保存一次就写进 B 的文件了");

    console.log("✅ 画布不丢数据：601 个节点原样往返 · 认不出的类型/用途照留 · 少了什么如实记账 · 坏文件报错不当空画布且原样备份 · 不带 force 绝不覆盖 · 列表标坏 · 前端不把 409 当白板");
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }
}

// 从老版本升上来那一下：旧文件收进新文件夹、画布先留底、跑一次就不再跑。
// 用户的原话是「用户之前下载我老版本的软件，要更新的话你也要给我解决这个问题啊……
// 更新的时候你记得把之前的文件放到新文件夹里面整理下啊」。
// 这条测试真起 server.js，对着一个照老版本样子摆好的 home，因为要验的恰恰是「开机那一下」。
async function testUpgradeMigration() {
  const http = require("http"), crypto = require("crypto");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-upgrade-"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  // 照老版本用久了的样子摆：产出一股脑堆在工作区根上，任务目录、画布、回收站各就各位
  const ws = path.join(home, "workspace");
  fs.mkdirSync(path.join(ws, ".openworkbuddy", "canvases"), { recursive: true });
  fs.mkdirSync(path.join(ws, "任务_20250101_老任务"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".trash"), { recursive: true });
  fs.mkdirSync(path.join(ws, "我自己建的文件夹"), { recursive: true });
  const OLD = (Date.now() - 9 * 86400000) / 1000;
  const oldFile = (rel, body) => { const f = path.join(ws, rel); fs.writeFileSync(f, body); fs.utimesSync(f, OLD, OLD); };
  oldFile("老报告.md", "# 老版本产出\n");
  oldFile("图 一.png", "PNG");
  oldFile(".隐藏的", "x");
  fs.writeFileSync(path.join(ws, "刚写的.txt"), "今天的");                       // 刚动过，不算历史遗留
  fs.writeFileSync(path.join(ws, "任务_20250101_老任务", "里面的.txt"), "不该动");
  fs.writeFileSync(path.join(ws, ".openworkbuddy", "canvas.json"), JSON.stringify({ version: 1, nodes: [{ id: "a", kind: "note", payload: { text: "老画布" } }], edges: [] }));
  fs.writeFileSync(path.join(ws, ".openworkbuddy", "canvases", "b.json"), JSON.stringify({ version: 1, nodes: [], edges: [] }));
  // 文件夹的时间也拨回去。不拨的话「文件夹也一起搬」这个错会从安静期那道口子溜过去，
  // 而真实的老用户目录里，文件夹恰恰都是旧的
  for (const d of ["任务_20250101_老任务", "我自己建的文件夹"]) fs.utimesSync(path.join(ws, d), OLD, OLD);

  const boot1 = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const r1 = await boot1.wait();
  let folder = "", bak = "";
  try {
    assert(r1.up, "真 server.js 没起来，这条测试作废：" + r1.why);

    // ── ① 散在根上的旧文件收进了一个带日期的新文件夹 ───────────────────────
    folder = fs.readdirSync(ws).find((n) => n.startsWith("以前的文件_")) || "";
    assert(folder,
      "★升级没整理★ 老版本的产出还一股脑摊在工作区根目录上。用户要的就是这一下：" +
      "「更新的时候你记得把之前的文件放到新文件夹里面整理下啊」");
    const inside = fs.readdirSync(path.join(ws, folder)).sort();
    assert(inside.join("|") === ["图 一.png", "整理清单.json", "老报告.md"].sort().join("|"),
      "整理进新文件夹的东西不对：" + inside.join(" "));
    assert(fs.readFileSync(path.join(ws, folder, "老报告.md"), "utf8") === "# 老版本产出\n",
      "★搬的过程中把内容弄坏了★ 整理是搬家不是重写");

    // ── ② 只搬该搬的。搬错一个，用户就得去新文件夹里刨自己的东西 ───────────
    assert(fs.existsSync(path.join(ws, "刚写的.txt")), "★刚写的文件被当成历史遗留搬走了★ 刚跑完的任务产出不能碰");
    assert(fs.existsSync(path.join(ws, ".隐藏的")), "点文件被搬走了（.openworkbuddy 这类就藏在点文件里，搬了等于弄丢画布）");
    assert(fs.existsSync(path.join(ws, "任务_20250101_老任务", "里面的.txt")), "★任务目录被动了★ 那是成果目录，不是散落的旧文件");
    assert(fs.existsSync(path.join(ws, "我自己建的文件夹")), "用户自己建的文件夹被搬走了");
    assert(fs.existsSync(path.join(ws, ".trash")), "回收站被搬走了");

    // ── ③ 留了账，才谈得上「想放回去随时能放」 ────────────────────────────
    const manifest = JSON.parse(fs.readFileSync(path.join(ws, folder, "整理清单.json"), "utf8"));
    assert(manifest.files.sort().join("|") === ["图 一.png", "老报告.md"].sort().join("|"),
      "★清单和实际搬的对不上★ 对不上的清单比没有更糟，用户照着搬回去会漏：" + JSON.stringify(manifest.files));

    // ── ④ 新版本碰画布之前，先把老画布原样拷一份走 ────────────────────────
    bak = fs.readdirSync(path.join(ws, ".openworkbuddy")).find((n) => n.startsWith("升级前备份_")) || "";
    assert(bak, "★升级前没给画布留底★ 新版本改了画布的读写规矩，万一判错，用户手里得有一份升级前的原件");
    const baked = fs.readdirSync(path.join(ws, ".openworkbuddy", bak)).sort();
    assert(baked.join("|") === "b.json|canvas.json", "画布留底不全：" + baked.join(" "));
    assert(fs.existsSync(path.join(ws, ".openworkbuddy", "canvas.json")), "★把画布搬走当备份了★ 留底只准拷，原件必须还在原地");

    // ── ⑤ 动过用户的文件就得告诉他 ────────────────────────────────────────
    const notes = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: r1.port, path: "/api/migrations", headers: { Cookie: "openworkbuddy_token=" + token } },
        (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); })
        .on("error", () => resolve(null));
    });
    assert(notes && Array.isArray(notes.notes) && notes.notes.length === 2,
      "★整理完了不吭声★ 动了用户工作区里的文件，界面上必须能说清搬到哪儿了：" + JSON.stringify(notes));
    assert(notes.notes.some((n) => n.note.includes(folder)), "告知里没写搬到哪个文件夹，等于没说：" + JSON.stringify(notes.notes));
  } finally { boot1.child.kill(); }

  // ── ⑥ 再开一次机：一件事都不许再做 ──────────────────────────────────────
  // 每次启动都新建一个「以前的文件_日期」，用几天工作区就长出一排空文件夹
  const before = fs.readdirSync(ws).sort().join("|");
  const boot2 = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const r2 = await boot2.wait();
  try {
    assert(r2.up, "第二次没起来：" + r2.why);
    assert(fs.readdirSync(ws).sort().join("|") === before, "★第二次开机又整理了一遍★ 跑过的迁移必须认得出来，账记在 data/migrations.json");
    assert(fs.readdirSync(path.join(ws, ".openworkbuddy")).filter((n) => n.startsWith("升级前备份_")).length === 1, "画布留底又拷了一份");
    const ledger = JSON.parse(fs.readFileSync(path.join(home, "data", "migrations.json"), "utf8"));
    const ids = Object.values(ledger.done || {})[0] || [];
    assert(ids.includes("tidy-root-v1") && ids.includes("canvas-backup-v1"), "账本里没记全跑过的迁移：" + JSON.stringify(ledger));
  } finally { boot2.child.kill(); }

  // ── ⑦ 撞名一律跳过。宁可这一个不整理，也不能盖掉那边那份 ─────────────────
  const migrate = require(path.join(__dirname, "..", "migrate.js"));
  const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-upgrade2-"));
  const dst = path.join(ws2, "以前的文件_" + migrate._internals.stampToday());
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "撞名.txt"), "早就在这儿的");
  const clash = path.join(ws2, "撞名.txt");
  fs.writeFileSync(clash, "根上那份"); fs.utimesSync(clash, OLD, OLD);
  const r3 = migrate._internals.tidyLooseFiles(ws2, {});
  assert(fs.readFileSync(path.join(dst, "撞名.txt"), "utf8") === "早就在这儿的", "★撞名的被覆盖了★ 整理不能吃掉任何一个文件");
  assert(fs.existsSync(clash), "★撞名的两份变成一份★");
  assert(r3.skipped.length === 1, "跳过的没记下来，用户不知道有一个没整理：" + JSON.stringify(r3));

  // ── ⑧ 根上本来就没有散文件：一个空文件夹都不许建 ────────────────────────
  const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-upgrade3-"));
  migrate.runMigrations(ws3, path.join(ws3, "..", "ledger-" + Date.now() + ".json"), { priorUse: true, version: "9.9.9" });
  assert(fs.readdirSync(ws3).length === 0, "★干净的工作区被建了个空文件夹★ 没事可做就该什么都不做：" + fs.readdirSync(ws3).join(" "));

  // ── ⑨ 全新装的机器：一个文件都不许动 ───────────────────────────────────
  // 用户说的是「**更新的时候**你记得把之前的文件放到新文件夹里面整理下」。
  // 刚装完就去翻人家文件夹，那不是整理，那是擅自动别人的东西——
  // 而且这条最容易写错：只要拿「账本里没记过」当升级的证据，全新装的机器就全中招
  const ws4 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-fresh-"));
  const freshLedger = path.join(ws4, "..", "ledger-fresh-" + Date.now() + ".json");
  for (const n of ["用户自己的稿子.md", "别人给的素材.png"]) {
    const f = path.join(ws4, n); fs.writeFileSync(f, "x"); fs.utimesSync(f, OLD, OLD);
  }
  migrate.runMigrations(ws4, freshLedger, { priorUse: false, version: "1.0.0" });
  assert(!fs.readdirSync(ws4).some((n) => n.startsWith("以前的文件_")),
    "★全新装也去整理用户的文件夹了★ 人家刚装完，工作目录里的东西是人家自己放的：" + fs.readdirSync(ws4).join(" "));
  assert(fs.readdirSync(ws4).sort().join("|") === ["别人给的素材.png", "用户自己的稿子.md"].sort().join("|"),
    "全新装的机器上文件被动过了：" + fs.readdirSync(ws4).join(" "));
  // 而且以后升级也不该回头补整理这一刀：全新装的时候就已经销账了
  migrate.runMigrations(ws4, freshLedger, { priorUse: false, version: "1.1.0" });
  assert(!fs.readdirSync(ws4).some((n) => n.startsWith("以前的文件_")),
    "★全新装的机器后来升级时补整理了★ 这刀早就不该有了：" + fs.readdirSync(ws4).join(" "));

  // ⑨-2 反向对照：同样没有账本，但这台机器以前用过 —— 这才是用户说的那种「升级」
  const ws5 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-old-install-"));
  const f5 = path.join(ws5, "老版本的产出.md"); fs.writeFileSync(f5, "x"); fs.utimesSync(f5, OLD, OLD);
  migrate.runMigrations(ws5, path.join(ws5, "..", "ledger-old-" + Date.now() + ".json"), { priorUse: true, version: "1.1.0" });
  assert(fs.readdirSync(ws5).some((n) => n.startsWith("以前的文件_")),
    "★老用户升上来却没整理★ ⑨ 那条闸门关过头了，把真正该跑的那次也挡了：" + fs.readdirSync(ws5).join(" "));

  console.log("✅ 升级迁移：旧文件收进「" + folder + "」·画布先留底·清单可回退·只搬散落文件·撞名不覆盖·开第二次不再动手·全新装一个不碰");
}

// 短剧素材台账：哪个文件是干什么用的、谁在用、谁没人用、谁引用了却已经不在了。
// 用户的原话是「做好素材管理」。素材管理的价值全在这四个问题上——
// 只列一堆文件名，这四个一个都答不上来。
async function testDramaAssets() {
  const http = require("http"), crypto = require("crypto");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-assets-"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));
  const ws = path.join(home, "workspace");
  fs.mkdirSync(path.join(ws, ".openworkbuddy"), { recursive: true });
  for (const f of ["角色_小满.png", "镜头_S1-01_首帧.png", "镜头_S1-01.mp4", "配音_S1-01.mp3", "没人用的图.png", "说明.txt"]) fs.writeFileSync(path.join(ws, f), "x");
  fs.writeFileSync(path.join(ws, "分镜表.json"), JSON.stringify({
    title: "测试", aspect: "9:16",
    characters: [{ id: "c1", name: "小满", ref: "角色_小满.png" }],
    scenes: [{ id: "S1", shots: [
      { id: "S1-01", first_frame: "镜头_S1-01_首帧.png", video: "镜头_S1-01.mp4", audio: "配音_S1-01.mp3", line: "你好" },
      { id: "S1-02", first_frame: "镜头_S1-02_首帧.png" },   // 引用了，但盘上没有
    ] }],
  }, null, 2));
  fs.writeFileSync(path.join(ws, ".openworkbuddy", "canvas.json"), JSON.stringify({
    version: 1, nodes: [{ id: "n1", kind: "image", payload: { title: "定妆", path: "角色_小满.png" } }], edges: [], updatedAt: Date.now(),
  }));

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const { up, port, why } = await booted.wait();
  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + why);
    const r = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/api/canvas/assets", headers: { Cookie: "openworkbuddy_token=" + token } },
        (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, json: j, body: b }); }); })
        .on("error", (e) => resolve({ code: 0, json: null, body: e.message }));
    });
    assert(r.code === 200 && r.json, "素材台账读不出来（HTTP " + r.code + "）：" + String(r.body).slice(0, 200));
    const by = new Map(r.json.assets.map((a) => [a.base, a]));

    // ① 认得出用途。分不清定妆照和首帧，素材面板就退化成一个文件列表
    assert(by.get("角色_小满.png") && by.get("角色_小满.png").role === "定妆照", "★认不出定妆照★：" + JSON.stringify(by.get("角色_小满.png")));
    assert(by.get("镜头_S1-01_首帧.png").role === "首帧", "认不出首帧");
    assert(by.get("镜头_S1-01.mp4").role === "镜头" && by.get("镜头_S1-01.mp4").kind === "video", "认不出成片镜头");
    assert(by.get("配音_S1-01.mp3").role === "配音" && by.get("配音_S1-01.mp3").kind === "audio", "认不出配音");
    assert(!by.has("说明.txt"), "非媒体文件混进素材台账了");

    // ② 算得出谁在用。画布和分镜表两边的引用都得算，缺一边就会把在用的当成没人用
    const look = by.get("角色_小满.png").usedBy.map((u) => u.from).sort();
    assert(look.join("|") === "分镜表|画布",
      "★「谁在用」算漏了★ 画布节点和分镜表都指着这张定妆照，两边都得认；只认一边，用户会把还在用的素材当垃圾删掉：" + JSON.stringify(by.get("角色_小满.png").usedBy));
    assert(by.get("镜头_S1-01.mp4").usedBy.some((u) => u.id === "S1-01"), "镜头视频没对上是哪一镜在用");

    // ③ 没人用的要标出来。重跑攒下的旧版本就混在这里，不标出来永远清不掉
    assert(by.get("没人用的图.png").orphan === true, "★没人用的素材没标出来★");
    assert(by.get("角色_小满.png").orphan === false, "★在用的被标成了没人用★ 照着删就是删掉正在用的素材，这比不标更糟");

    // ④ 引用了却不在盘上的，必须主动摆出来。它在文件列表里永远不出现，
    //    用户只会看见「这一镜怎么老是生不出来」
    assert(Array.isArray(r.json.missing) && r.json.missing.length === 1 && r.json.missing[0].base === "镜头_S1-02_首帧.png",
      "★引用了但文件不在的没报出来★ 这类最要紧：那一镜现在就是做不下去的：" + JSON.stringify(r.json.missing));
    assert(r.json.missing[0].usedBy.some((u) => u.id === "S1-02"), "没说清是哪一镜在等这个文件");
    assert(r.json.stat.total === 5 && r.json.stat.orphan === 1 && r.json.stat.missing === 1,
      "台账小结对不上：" + JSON.stringify(r.json.stat));
  } finally { booted.child.kill(); }

  // ⑤ 画布坏了，素材台账照样得能看。两件事互不相干，绑一起等于一处坏两处瞎
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-assets2-"));
  fs.mkdirSync(path.join(home2, "data"), { recursive: true });
  const token2 = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(path.join(home2, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token2]: { user: "e2e", at: Date.now() } },
  }));
  const ws2 = path.join(home2, "workspace");
  fs.mkdirSync(path.join(ws2, ".openworkbuddy"), { recursive: true });
  fs.writeFileSync(path.join(ws2, "角色_小满.png"), "x");
  fs.writeFileSync(path.join(ws2, ".openworkbuddy", "canvas.json"), "{ 这不是 JSON");
  const b2 = bootRealServer({ OPENWORKBUDDY_HOME: home2 });
  const s2 = await b2.wait();
  try {
    assert(s2.up, "第二台没起来：" + s2.why);
    const r2 = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: s2.port, path: "/api/canvas/assets", headers: { Cookie: "openworkbuddy_token=" + token2 } },
        (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, json: j, body: b }); }); })
        .on("error", (e) => resolve({ code: 0, json: null, body: e.message }));
    });
    assert(r2.code === 200 && r2.json && r2.json.assets.length === 1,
      "★画布坏了就连素材也看不了★ 这两件事互不相干，绑一起等于一处坏两处瞎：HTTP " + r2.code + " " + String(r2.body).slice(0, 160));
    assert(r2.json.boardUnreadable, "画布读不出来这件事得说出来，不能默默当成「没人在用任何素材」");
  } finally { b2.child.kill(); }

  // ⑥ 前端得真用上台账，而不是继续只列文件名
  const ui = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
  for (const [needle, why] of [
    ['fetch("/api/canvas/assets', "素材面板没去读台账，那它显示的还是一串文件名"],
    ["function canvasAssetUseText", "面板不显示「谁在用」，用户还是不知道哪张图能删"],
    ["canvas-library-missing", "「引用了但文件不在」没在面板上摆出来"],
    ['id="canvas-library-role"', "没有按用途筛选，十二镜的项目里根本翻不动"],
  ]) assert(ui.includes(needle), "前端缺了：" + why);

  console.log("✅ 短剧素材台账：认用途（定妆照/首帧/镜头/配音）· 画布+分镜表两边算占用 · 标出没人用的 · 引用丢文件主动报 · 画布坏了素材照样能看");
}

// 短剧制片进度：这部戏做到哪了、卡在哪、还剩多少活儿。
// 用户的原话是「真的能拿这个做 AI 短剧啊，短剧的各个流程……还有整个无限画布做短剧的能力」。
// 这条测试盯的是一条最容易写错、错了还全绿的规矩：
// **字段里写着 first_frame ≠ 这一镜做完了**。文件不在盘上，这一镜就是卡着的。
async function testDramaPipeline() {
  const http = require("http"), crypto = require("crypto");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pipeline-"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));
  const ws = path.join(home, "workspace");
  fs.mkdirSync(path.join(ws, ".openworkbuddy"), { recursive: true });
  fs.mkdirSync(path.join(ws, "素材"), { recursive: true });
  const put = (n) => fs.writeFileSync(path.join(ws, "素材", n), "x");
  // 盘上真有的：两张首帧、一段视频、一张定妆照
  put("角色_阿明.png"); put("镜头_S1-01_首帧.png"); put("镜头_S1-01.mp4"); put("镜头_S1-02_首帧.png");
  // 故意不建：角色_阿芳.png、镜头_S1-02.mp4、配音_S1-02.mp3 —— 画布上写了，盘上没有

  // r0 是「记 ms 之前的版本留下的那种记录」——老画布里全是这种。
  // 把它当成 0 秒算进去，中位数立刻被拉垮，估时会短得离谱
  const RUNS = [{ id: "r0", kind: "image", at: 0 }, { id: "r1", kind: "image", at: 1, ms: 20000 }, { id: "r2", kind: "image", at: 2, ms: 40000 }, { id: "r3", kind: "video", at: 3, ms: 120000 }];
  const node = (id, kind, payload) => ({ id, kind, payload, x: 0, y: 0 });
  fs.writeFileSync(path.join(ws, ".openworkbuddy", "canvas.json"), JSON.stringify({
    version: 1, edges: [], nodes: [
      node("n_script", "script", { title: "粤西狗奶", text: "阿明回乡接手父亲的士多店，发现账本里藏着十年前的一笔钱。三集反转，结局和解。" }),
      node("n_c1", "character", { name: "阿明", path: "素材/角色_阿明.png" }),
      node("n_c2", "character", { name: "阿芳", path: "素材/角色_阿芳.png" }),          // 定妆照丢了
      node("n_s1", "shot", { id: "S1-01", prompt: "士多店门口，阿明推门", shot_size: "中景", duration: "4", line: "", first_frame: "素材/镜头_S1-01_首帧.png", video: "素材/镜头_S1-01.mp4", generation_runs: RUNS }),
      node("n_s2", "shot", { id: "S1-02", prompt: "柜台后翻账本", shot_size: "特写", duration: "5", line: "这笔钱是谁的？", first_frame: "素材/镜头_S1-02_首帧.png", video: "素材/镜头_S1-02.mp4", audio: "素材/配音_S1-02.mp3" }),
      node("n_s3", "shot", { id: "S1-03", prompt: "阿芳站在门口", shot_size: "全景", duration: "4", line: "" }),
      node("n_s4", "shot", { id: "S1-04", prompt: "镜头内容与运动…", shot_size: "中景", duration: "4", line: "" }),   // 模板没改
      node("n_tl", "timeline", { title: "最终剪辑" }),
    ],
  }));

  const boot = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const { up, port, why } = await boot.wait();
  const get = (p) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, headers: { Cookie: "openworkbuddy_token=" + token } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ code: res.statusCode, body: b }));
    });
    req.on("error", (e) => resolve({ code: 0, body: e.message })); req.end();
  });

  let progressData = null;   // 下面 ⑩ 要拿这份真数据去渲染一遍
  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + why);
    const r = await get("/api/canvas/progress");
    assert(r.code === 200, "制片进度取不到（HTTP " + r.code + "）：" + r.body.slice(0, 200));
    const d = progressData = JSON.parse(r.body);
    const stage = (k) => d.stages.find((s) => s.key === k) || {};
    const shot = (id) => (d.shots || []).find((s) => s.id === id) || {};

    // ── ① 七档分得开，每档说得出「几个/一共几个」 ────────────────────────
    assert(d.stages.map((s) => s.key).join(",") === "script,cast,shots,frame,video,voice,cut",
      "七档顺序不对，进度带上的顺序就是短剧的做片顺序：" + d.stages.map((s) => s.key).join(","));
    assert(stage("script").done === 1 && stage("script").total === 1, "剧本这一档算错了：" + JSON.stringify(stage("script")));
    // 反向对照：模板原样没动、或者只敲了两个字，都不能算「剧本写好了」——
    // 算成写好了，下一步就会指到拆场次上去，而那一步必然拆不出东西
    const stub = require(path.join(__dirname, "..", "drama-pipeline.js"));
    for (const [text, why] of [["", "空的"], ["在这里写一句话概念、人物关系、冲突、对白和结局。", "模板原样"], ["随便写两句", "只敲了几个字"]]) {
      const g = stub.dramaProgress({ nodes: [{ id: "s", kind: "script", payload: { text } }] }, { onDisk: new Set() });
      assert(g.stages.find((x) => x.key === "script").done === 0, `★${why}也算剧本写好了★：` + JSON.stringify(g.stages[0]));
      assert(g.blockers.some((b) => /剧本/.test(b.text)), `${why}的时候没提醒先写剧本：` + JSON.stringify(g.blockers));
    }
    assert(stage("shots").done === 3 && stage("shots").total === 4,
      "★没写提示词的镜头被算成做好了★ 那一镜点生成只会失败：" + JSON.stringify(stage("shots")));

    // ── ② 核心规矩：写着路径 ≠ 做完了。文件不在盘上就是没做完 ──────────────
    assert(stage("frame").done === 2 && stage("frame").total === 4, "首帧这一档算错了：" + JSON.stringify(stage("frame")));
    assert(stage("video").done === 1,
      "★画布上写着 video 就算成片了★ 那个文件根本不在盘上——这正是用户点了半天没反应的那一类：" + JSON.stringify(stage("video")));
    assert(stage("cast").done === 1 && stage("cast").total === 2,
      "★定妆照文件丢了还算这个角色做完了★：" + JSON.stringify(stage("cast")));
    assert(shot("S1-02").video && shot("S1-02").video.ok === false, "S1-02 的视频该标成「文件没了」：" + JSON.stringify(shot("S1-02")));
    assert(shot("S1-01").video && shot("S1-01").video.ok === true, "S1-01 的视频真在盘上，不该标成丢了（阳性对照）");

    // ── ③ 配音只算真有台词的那几镜 ────────────────────────────────────────
    assert(stage("voice").total === 1 && stage("voice").done === 0,
      "★把没台词的镜头也算进配音里了★ 那几镜本来就不需要配音，凑进分母只会让进度永远到不了头：" + JSON.stringify(stage("voice")));
    assert(shot("S1-01").needsVoice === false && shot("S1-02").needsVoice === true, "谁需要配音判错了");

    // ── ④ 卡在哪：说得出来，还得给得出是哪几个节点 ────────────────────────
    const texts = (d.blockers || []).map((b) => b.text).join(" | ");
    assert(/提示词/.test(texts), "没报「有镜头没写提示词」：" + texts);
    assert(/定妆照/.test(texts), "没报「定妆照文件丢了」：" + texts);
    assert(/视频文件/.test(texts), "没报「镜头视频文件丢了」：" + texts);
    const withIds = (d.blockers || []).filter((b) => Array.isArray(b.ids) && b.ids.length);
    assert(withIds.length >= 3, "★卡点没带节点 id★ 界面上就跳不过去，说了等于没说：" + JSON.stringify(d.blockers));
    assert(withIds.every((b) => b.ids.every((id) => d.shots.some((s) => s.nodeId === id) || ["n_c1", "n_c2", "n_script", "n_tl"].includes(id))),
      "卡点里的 id 在画布上不存在：" + JSON.stringify(withIds));
    assert(d.next && /提示词|定妆照|视频文件/.test(d.next.text), "下一步该先说卡死的那件事：" + JSON.stringify(d.next));

    // ── ⑤ 还剩多少活儿 ────────────────────────────────────────────────────
    assert(d.pending.image === 2, "还差几张首帧算错了：" + JSON.stringify(d.pending));
    assert(d.pending.video === 1,
      "★把没首帧的镜头也算进「要生视频」里了★ 那几镜现在根本生不了视频：" + JSON.stringify(d.pending));
    assert(d.pending.audio === 1, "还差几段配音算错了：" + JSON.stringify(d.pending));
    // 定妆照丢了的那个角色，是一件实打实还没做完的活儿。以前它在 pending 里根本没有位置，
    // 于是「还要生成」那排不给按钮、「还要多久」也不算它——整条产线唯一一档没人管的就是它
    assert(d.pending.cast === 1,
      "★定妆照没进「还剩多少活儿」★ 丢了定妆照的角色得重跑一张，不然后面每一镜的脸都不是同一个人："
      + JSON.stringify(d.pending));

    // ── ⑥ 时间只按这张画布自己跑过的算，没跑过就明说估不出来 ───────────────
    // 生图中位数 30s ×（首帧 2 + 定妆照 1）+ 视频 120s × 1 = 210s。
    // 定妆照跑的就是生图那条命令，漏掉它，屏幕上写的就是一个偏小的数
    assert(d.eta && d.eta.ms === 210000,
      "★估时不是按这张画布真跑过的耗时算的★（生图中位数 30s ×（首帧 2 + 定妆照 1）+ 视频 120s × 1 = 210s；"
      + "算成 180s 说明把要重跑的定妆照漏了，算成 190s 说明把老版本那条没记 ms 的记录当成 0 秒了）："
      + JSON.stringify(d.eta));
    assert(/中位数/.test(d.eta.basis || ""), "估时得说清楚凭什么这么估：" + JSON.stringify(d.eta));
    assert(d.eta.partial === true, "配音一次都没跑过，这个估时是不全的，得标出来：" + JSON.stringify(d.eta));

    assert(typeof d.percent === "number" && d.percent > 0 && d.percent < 100, "总进度不该是 0 或 100：" + d.percent);
  } finally { boot.child.kill(); }

  // ── ⑦ 反向对照：一次都没跑过的画布，宁可不给时间也不许编 ─────────────────
  const pipeline = require(path.join(__dirname, "..", "drama-pipeline.js"));
  const bare = pipeline.dramaProgress({ nodes: [{ id: "x", kind: "shot", payload: { id: "S1", prompt: "有提示词" } }] }, { onDisk: new Set() });
  assert(bare.eta === null, "★没跑过也硬给一个时间★：" + JSON.stringify(bare.eta));
  assert(bare.pending.image === 1 && bare.pending.video === 0, "没首帧的镜头不该排进生视频的队：" + JSON.stringify(bare.pending));
  const empty = pipeline.dramaProgress({ nodes: [] }, { onDisk: new Set() });
  assert(empty.percent === 0 && /空/.test(empty.next.text), "空画布该说它是空的，不该说「做完了」：" + JSON.stringify(empty.next));
  const allDone = pipeline.dramaProgress({ nodes: [{ id: "s", kind: "shot", payload: { id: "S1", prompt: "p", first_frame: "a.png", video: "a.mp4" } }] }, { onDisk: new Set(["a.png", "a.mp4"]) });
  assert(allDone.percent === 100 && !allDone.blockers.length, "全做完了还报卡点：" + JSON.stringify(allDone));

  // ── ⑧ 画布坏了：进度看不了是小事，把界面打成白板才是事故 ─────────────────
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-pipeline-bad-"));
  fs.mkdirSync(path.join(home2, "workspace", ".openworkbuddy"), { recursive: true });
  fs.mkdirSync(path.join(home2, "data"), { recursive: true });
  const token2 = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(path.join(home2, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token2]: { user: "e2e", at: Date.now() } },
  }));
  fs.writeFileSync(path.join(home2, "workspace", ".openworkbuddy", "canvas.json"), "{这不是 JSON");
  const boot2 = bootRealServer({ OPENWORKBUDDY_HOME: home2 });
  const b2 = await boot2.wait();
  try {
    assert(b2.up, "第二台没起来：" + b2.why);
    const r2 = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: b2.port, path: "/api/canvas/progress", headers: { Cookie: "openworkbuddy_token=" + token2 } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ code: res.statusCode, body: b }));
      });
      req.on("error", (e) => resolve({ code: 0, body: e.message })); req.end();
    });
    assert(r2.code === 200, "画布坏了就连进度都 500 了（HTTP " + r2.code + "）：" + r2.body.slice(0, 160));
    const d2 = JSON.parse(r2.body);
    assert(d2.boardUnreadable, "画布读不出来却没说，界面会拿它当一张空画布：" + r2.body.slice(0, 160));
  } finally { boot2.child.kill(); }

  // ── ⑨ 界面那头真接上了 ────────────────────────────────────────────────
  const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
  for (const needle of ['fetch("/api/canvas/progress', "function canvasRenderProgress", "function canvasRunPending", 'id="canvas-progress"', "data-cp-focus", "data-cp-run"]) {
    assert(fe.includes(needle), "前端没接上制片进度，缺：" + needle);
  }
  assert(/canvasRecordGeneration\(node, kind, input, file, result, Date\.now\(\) - startedAt\)/.test(fe),
    "★生成耗时没记★ 不记就永远只能猜「还要多久」");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "ui.css"), "utf8");
  assert(css.includes(".cp-chip") && css.includes(".cp-shots"), "进度带没有样式");

  // ── ⑩ 真把它渲染一遍，看屏幕上写的是不是人话 ──────────────────────────
  // 光断言「代码里有这个函数」证明不了用户能看见什么。这里把渲染那一段单独抠出来，
  // 拿假 DOM 跑一遍，断言的是**屏幕上真出现的字**
  {
    const from = fe.indexOf("function canvasEtaText("), to = fe.indexOf("async function canvasLoadProgress(");
    assert(from > 0 && to > from, "抠不出进度带的渲染代码，这段测试作废（函数改名了？）");
    // 合成那一条在进度带里面（canvasRenderProgress 直接调 canvasComposeHtml），但它排在
    // canvasLoadProgress 后头，落在上面那一刀之外。少了它整段 eval 起来就是 ReferenceError——
    // 所以第二刀单抠一段接上，而不是往沙箱里塞个空壳桩：塞了桩，屏幕上这一条写什么就没人验了
    const cFrom = fe.indexOf("function canvasComposeHtml("), cTo = fe.indexOf("/** 起手模板里那几句占位文字");
    assert(cFrom > 0 && cTo > cFrom, "抠不出合成那一条的渲染代码（函数改名了？）");
    let html = "";
    const stubEl = { addEventListener() {} };
    const box = {
      hidden: true,
      set innerHTML(v) { html = v; }, get innerHTML() { return html; },
      querySelector: () => stubEl, querySelectorAll: () => [],
    };
    const sandbox = {
      esc: (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
      ic: (n) => `<i>${n}</i>`,
      canvasState: { progress: null, progressOpen: true, batch: null, graph: null, composeJob: null, composePlan: null, composeSub: false },
      canvasToast() {}, canvasRenderInspector() {}, canvasCenterSelected() {}, canvasRefreshNode() {}, canvasRunPending() {},
      document: { getElementById: () => box, querySelector: () => null },
    };
    const keys = Object.keys(sandbox);
    const make = new Function(...keys, fe.slice(from, to) + fe.slice(cFrom, cTo) + "\nreturn { canvasRenderProgress, canvasEtaText, canvasComposeHtml };");
    const ui = make(...keys.map((k) => sandbox[k]));

    assert(ui.canvasEtaText(180000) === "约 3 分钟", "时间说人话这一关没过：" + ui.canvasEtaText(180000));
    assert(ui.canvasEtaText(0) === "", "没有时间就别写时间");

    // 读不到进度 = 整条不显示。显示一个「0%」是在撒谎
    sandbox.canvasState.progress = null;
    ui.canvasRenderProgress();
    assert(box.hidden === true && html === "", "★进度读不到却画了一条出来★ 那个 0% 是编的：" + html);

    sandbox.canvasState.progress = progressData;      // 用上面真 server 返回的那份
    ui.canvasRenderProgress();
    assert(box.hidden === false, "有数据却不显示");
    assert(html.includes(`${progressData.percent}%`), "屏幕上没有总进度：" + html.slice(0, 200));
    assert(/首帧<b>2\/4<\/b>/.test(html), "★屏幕上没写清「几个/一共几个」★ 只给个百分比，用户还是不知道还差几张：" + html.slice(0, 400));
    assert(html.includes("文件没了"), "★视频文件丢了，表格里却没说★ 这正是用户点了半天没反应的那一类");
    assert(html.includes("data-cp-focus"), "卡点没有「跳过去看」的按钮");
    assert(/data-cp-run="image"[^>]*>首帧 2 个/.test(html), "★没给「一键补齐」★ 还差 2 张首帧，用户只能一个个点：" + html.slice(0, 600));
    assert(html.includes("约 4 分钟"), "估时没显示出来（210 秒该写成「约 4 分钟」）：" + html.slice(0, 600));
    // 定妆照也得在「还要生成」那排有个能点的按钮。以前这一档只能自己去文件夹里挑图，
    // 或者指望 Agent 临场发挥——而它是后面每一镜脸能不能对上的地基
    assert(/data-cp-run="cast"[^>]*>定妆照 1 个/.test(html),
      "★定妆照没有「一键补齐」★ 丢了定妆照的角色得一个个手点：" + html.slice(0, 700));

    // 正在跑的时候：按钮全禁掉，且看得见跑到第几个了
    sandbox.canvasState.batch = { kind: "image", total: 2, at: 1, label: "S1-03", stop: false };
    ui.canvasRenderProgress();
    assert(/data-cp-run="image"[^>]*disabled/.test(html), "★跑着还能再点一次★ 同一批活儿会被发两遍：" + html.slice(0, 600));
    assert(html.includes("正在跑第 1/2 个") && html.includes("S1-03"), "跑着的时候不说跑到哪了：" + html.slice(0, 600));
    assert(html.includes("data-cp-stop"), "★停不下来★ 一批要跑几十分钟，必须给个停");
    sandbox.canvasState.batch = null;

    // ── 合成成片那一条：四种状态，各自该在屏幕上写什么 ──────────────────
    // 这一条是整条流水线的最后一步，也是最贵的一步：前面几十个镜头的钱都花完了才走到这儿。
    // 所以它不能「看着能点、点下去白跑」，也不能「跑挂了只说四个字」。
    const shotsOk = (n, ok = true) => Array.from({ length: n }, (_, i) => ({ id: "S1-0" + (i + 1), video: { ok } }));
    assert(ui.canvasComposeHtml({ shots: shotsOk(3, false) }) === "",
      "★镜头还没出全就把「合成成片」画出来了★ 点下去必然白跑一趟");
    assert(ui.canvasComposeHtml({ shots: [] }) === "", "一个镜头都没有的时候也别画");
    let ch = ui.canvasComposeHtml({ shots: shotsOk(3) });
    assert(ch.includes("data-cp-compose") && ch.includes("合成成片"), "★镜头全好了却没有合成入口★：" + ch.slice(0, 200));
    assert(ch.includes("不花钱"), "没说清这一步是本机跑的（用户会以为又要烧一次钱）：" + ch.slice(0, 200));
    // 方案摆出来了：顺序要看得见，做不了的时候按钮必须是灰的
    sandbox.canvasState.composePlan = {
      shots: [{ id: "S1-01", seconds: 2, audio: true, line: "台词" },
              { id: "S1-02", seconds: 0, line: "台词", why: "时长探不到" }],
      blockers: [{ level: "stop", text: "S1-02 的视频文件不在了" }],
      mode: "copy", target: { w: 540, h: 960 }, totalSeconds: 4, etaMs: 180000,
      outputs: { film: "成片.mp4", subtitled: "成片_字幕.mp4", srt: "成片.srt", clips: ["a.mp4"], dir: "中间片段" },
      ready: false,
    };
    ch = ui.canvasComposeHtml({ shots: shotsOk(2) });
    assert(/S1-01[\s\S]*S1-02/.test(ch), "★成片顺序没摆出来★ 顺序错是最贵的一种错：钱全花完了才看出情节是乱的");
    assert(ch.includes("S1-02 的视频文件不在了"), "拦住不让跑，却不说为什么：" + ch.slice(0, 400));
    assert(/data-cp-compose-go[^>]*disabled/.test(ch), "★方案说了做不了，按钮还是能点的★：" + ch.slice(0, 600));
    assert(ch.includes("约 3 分钟"), "估时没写出来（这一步要跑好几分钟，不说用户会以为卡死了）");
    assert(ch.includes("成片.mp4") && ch.includes("同名的旧成片不会被盖掉"), "没说清会写出什么文件、会不会盖掉旧的");
    sandbox.canvasState.composePlan = null;
    // 跑着的时候：第几步、在干什么、能不能停
    sandbox.canvasState.composeJob = { at: 2, total: 5, steps: [{}, { label: "S1-02 接配音" }], log: ["S1-01 好了"], done: false };
    ch = ui.canvasComposeHtml({ shots: shotsOk(2) });
    assert(ch.includes("第 2/5 步") && ch.includes("S1-02 接配音"), "跑着却不说跑到哪一步：" + ch.slice(0, 300));
    assert(ch.includes("data-cp-compose-stop"), "★停不下来★ 合成是最长的一步，必须给个停");
    // 跑挂了：得说清是哪一步挂的、为什么
    sandbox.canvasState.composeJob = { done: true, error: "ffmpeg 退出码 1", steps: [{ label: "烧字幕", state: "fail", note: "缺 libass" }] };
    ch = ui.canvasComposeHtml({ shots: shotsOk(2) });
    assert(ch.includes("烧字幕") && ch.includes("缺 libass"),
      "★只说「没拼成」，不说哪一步挂的★ 用户拿不到任何能查的线索：" + ch.slice(0, 300));
    // 拼好了：路径 + 打开 + 重来
    sandbox.canvasState.composeJob = { done: true, output: "成片.mp4", subtitled: "成片_字幕.mp4", log: [] };
    ch = ui.canvasComposeHtml({ shots: shotsOk(2) });
    assert(ch.includes('data-cp-compose-open="成片_字幕.mp4"'), "拼好了却没有「打开看看」：" + ch.slice(0, 300));
    assert(ch.includes("不带字幕的那条也在：成片.mp4"), "烧了字幕就把原片藏了，用户想要干净那条时找不到");
    sandbox.canvasState.composeJob = null;
  }

  console.log("✅ 短剧制片进度：七档算得出且屏幕上写「2/4」不是光给百分比 · 写着路径但文件没了一律不算完（定妆/首帧/视频三处都验）· 卡点带 id 能跳过去 · 没台词的不进配音分母 · 没首帧的不进生视频队 · 估时只按自己跑过的中位数（老记录没 ms 不当 0）、没跑过就说估不出来 · 一键补齐跑着时锁按钮、报进度、能叫停 · 画布坏了进度不 500");
}

// 短剧的最后一步：把一堆镜头真的拼成一条能播的片子。
// 这条测试盯的是三类「全绿但片子是废的」的错法：
//   ① 顺序错 —— 片子能播、时长也对，只有情节是乱的。这是最贵的一种错：钱全花完了才发现
//   ② 悄悄把台词切了 —— 配音 4.5 秒、画面 2 秒，直接拼就是把后半句吃掉
//   ③ 最后一步才发现干不了 —— 没 ffmpeg / 没 libass，要在**开跑前**说，不是等三十个镜头拼完再说
async function testDramaCompose() {
  const http = require("http"), crypto = require("crypto");
  const { spawnSync, execFileSync } = require("child_process");
  const C = require(path.join(__dirname, "..", "drama-compose.js"));

  // ── 计划这一层不碰 ffmpeg，全是纯函数，跑起来是毫秒级 ────────────────────
  const planOf = (shots, ex = {}) => {
    const files = new Map(), onDisk = new Set(), probes = {};
    for (const [base, p] of Object.entries(ex.disk || {})) {
      files.set(base, "素材/" + base); onDisk.add(base); if (p) probes[base] = p;
    }
    for (const base of ex.plain || []) { files.set(base, base); onDisk.add(base); }
    const nodes = shots.map((s, i) => ({ id: "n" + i, kind: "shot", payload: s, position: { x: i * 100, y: 0 } }));
    return C.composePlan({ nodes, edges: [] }, {
      files, onDisk, probes,
      ffmpeg: "ffmpeg" in ex ? ex.ffmpeg : "/usr/bin/ffmpeg", ffprobe: "ffprobe" in ex ? ex.ffprobe : "/usr/bin/ffprobe",
      install: "brew install ffmpeg", burn: ex.burn !== false, subtitles: ex.subtitles === undefined ? null : ex.subtitles,
    });
  };
  const V = (sec, w, h, more) => ({ dur: sec, w, h, fps: 25, vcodec: "h264", pix: "yuv420p", ...(more || {}) });
  const A = (sec) => ({ dur: sec });

  // ① 顺序按镜头 ID，不按数组顺序、不按谁先被拖进画布
  {
    const p = planOf([
      { id: "S1-03", prompt: "p", video: "c.mp4" },
      { id: "S1-01", prompt: "p", video: "a.mp4" },
      { id: "S1-10", prompt: "p", video: "d.mp4" },
      { id: "S1-02", prompt: "p", video: "b.mp4" },
    ], { disk: { "a.mp4": V(2, 540, 960), "b.mp4": V(2, 540, 960), "c.mp4": V(2, 540, 960), "d.mp4": V(2, 540, 960) } });
    assert(p.shots.map((r) => r.id).join(">") === "S1-01>S1-02>S1-03>S1-10",
      "★镜头顺序错了★ 片子照样能播、时长也对，只有情节是乱的——而这时候钱已经全花完了："
      + p.shots.map((r) => r.id).join(">"));
    // S1-10 不能排在 S1-02 前面：按字符串排就会
    assert(p.shots[3].id === "S1-10", "第 10 镜被当成字符串排到第 2 镜前面了");
  }

  // ② 配音比画面长 → 补画面，不许切台词
  {
    const p = planOf([{ id: "S1-01", prompt: "p", line: "这句话四秒半", video: "a.mp4", audio: "v.mp3" }],
      { disk: { "a.mp4": V(2, 540, 960), "v.mp3": A(4.5) } });
    assert(p.shots[0].pad > 2.4 && Math.abs(p.shots[0].seconds - 4.5) < 0.05,
      "★配音 4.5 秒、画面 2 秒，直接拼就是把后半句台词吃掉★ 得按配音时长补画面：" + JSON.stringify(p.shots[0]));
    assert(p.mode === "reencode" && p.steps.some((s) => /tpad=stop_mode=clone/.test((s.argv || []).join(" "))),
      "补画面这件事没落到命令里：" + JSON.stringify(p.steps.map((s) => s.key)));
    // 反向对照：配音比画面短，不补
    const q = planOf([{ id: "S1-01", prompt: "p", line: "短句", video: "a.mp4", audio: "v.mp3" }],
      { disk: { "a.mp4": V(2, 540, 960), "v.mp3": A(1.2) } });
    assert(!q.shots[0].pad && q.mode === "copy", "配音比画面短却也补了画面 / 没直拼：" + JSON.stringify(q.shots[0]) + q.mode);
  }

  // ③ 画幅不一致 → 必须重新编码，且统一到最大那个（直拼出来会花屏）
  {
    const p = planOf([
      { id: "S1-01", prompt: "p", video: "a.mp4" },
      { id: "S1-02", prompt: "p", video: "b.mp4" },
    ], { disk: { "a.mp4": V(2, 540, 960), "b.mp4": V(2, 720, 1280) } });
    assert(p.mode === "reencode" && p.target.w === 720 && p.target.h === 1280,
      "★画幅不一样还直拼★ 拼出来要么花屏要么直接失败：" + JSON.stringify({ mode: p.mode, target: p.target }));
    assert(p.blockers.some((b) => b.level === "warn" && /画幅|尺寸/.test(b.text)), "画幅不一致没提醒：" + JSON.stringify(p.blockers));

    // 帧率不一致：这条是实测逼出来的。30fps + 25fps 各 2 秒直拼，ffmpeg 退出码 0、
    // 文件也在，出来的片子只有 3.33 秒——「文件在不在、有没有字节」这类检查一条都拦不住
    const r = planOf([
      { id: "S1-01", prompt: "p", video: "a.mp4" },
      { id: "S1-02", prompt: "p", video: "b.mp4" },
    ], { disk: { "a.mp4": V(2, 540, 960, { fps: 30 }), "b.mp4": V(2, 540, 960, { fps: 25 }) } });
    assert(r.mode === "reencode" && r.fps === 30,
      "★帧率不一样还直拼★ 退出码是 0、文件也在，就是片子短了一大截，只有用户能发现：" + JSON.stringify({ mode: r.mode, fps: r.fps }));
    assert(r.blockers.some((b) => /帧率/.test(b.text)), "帧率不一致没提醒：" + JSON.stringify(r.blockers));

    // 像素格式不一样：拼出来颜色会在中途跳一下
    const x = planOf([
      { id: "S1-01", prompt: "p", video: "a.mp4" },
      { id: "S1-02", prompt: "p", video: "b.mp4" },
    ], { disk: { "a.mp4": V(2, 540, 960), "b.mp4": V(2, 540, 960, { pix: "yuvj420p" }) } });
    assert(x.mode === "reencode" && x.blockers.some((b) => /像素格式/.test(b.text)), "像素格式不一致还直拼：" + JSON.stringify(x.blockers));

    // 阳性对照：全都一模一样就该直拼，别平白重压一遍画质
    const same = planOf([
      { id: "S1-01", prompt: "p", video: "a.mp4" },
      { id: "S1-02", prompt: "p", video: "b.mp4" },
    ], { disk: { "a.mp4": V(2, 540, 960), "b.mp4": V(2, 540, 960) } });
    assert(same.mode === "copy", "规格完全一致却还要重新编码，白白掉一遍画质：" + JSON.stringify(same.blockers));
  }

  // ④ 干不了的事，开跑前就得说清楚——不是等片子拼完了才在最后一条命令上报错
  {
    const noFf = planOf([{ id: "S1-01", prompt: "p", video: "a.mp4" }], { disk: { "a.mp4": V(2, 540, 960) }, ffmpeg: "" });
    assert(!noFf.ready && noFf.blockers.some((b) => b.level === "stop" && /ffmpeg/.test(b.text) && /brew install/.test(b.text)),
      "★没装 ffmpeg 却不拦，还不给安装命令★ 这条链路最后一步才用到 ffmpeg，不先拦就是花完钱再报错："
      + JSON.stringify(noFf.blockers));
    assert(!noFf.steps.length, "都拼不了了还排了命令出来");

    const gone = planOf([{ id: "S1-01", prompt: "p", video: "a.mp4" }], {});     // 字段写着，盘上没有
    assert(!gone.ready && gone.blockers.some((b) => b.level === "stop" && /没在盘上|文件/.test(b.text)),
      "★画布上写着 video 就当它在★：" + JSON.stringify(gone.blockers));

    const wrong = planOf([{ id: "S1-01", prompt: "p", video: "a.png" }], { disk: { "a.png": null } });
    assert(!wrong.ready && wrong.blockers.some((b) => b.level === "stop"),
      "★video 字段指着一张图片也照拼★：" + JSON.stringify(wrong.blockers));

    const bare = C.composePlan({ nodes: [] }, { ffmpeg: "/usr/bin/ffmpeg" });
    assert(!bare.ready && bare.blockers.some((b) => /一个镜头/.test(b.text)), "空画布没说它是空的：" + JSON.stringify(bare.blockers));
  }

  // ⑤ 本机 ffmpeg 没带 libass：烧不了字幕 ≠ 不给字幕。
  //   计划里就说、不排这一步、.srt 照出（导进剪辑软件就是一行菜单）
  {
    const shots = [{ id: "S1-01", prompt: "p", line: "第一句", video: "a.mp4", audio: "v.mp3" }];
    const disk = { "a.mp4": V(2, 540, 960), "v.mp3": A(2) };
    const can = planOf(shots, { disk });
    assert(can.steps.some((s) => s.key === "subtitle") && can.outputs.subtitled, "有 libass 却不排烧字幕（阳性对照）");
    const cant = planOf(shots, { disk, burn: false });
    assert(!cant.steps.some((s) => s.key === "subtitle") && !cant.outputs.subtitled,
      "★烧不了字幕还把这一步排进去★ 那就是等整条片子拼完了再在最后一步报一句英文错：" + JSON.stringify(cant.steps.map((s) => s.key)));
    assert(cant.blockers.some((b) => b.level === "warn" && /libass/.test(b.text)), "没在计划里说烧不了：" + JSON.stringify(cant.blockers));
    assert(cant.outputs.srt && cant.srt.includes("第一句"), "★烧不了就连字幕文件都不给了★ 这是把能给的也扣下了：" + JSON.stringify(cant.outputs));
    assert(can.ready && cant.ready, "烧不了字幕不该拦着出片");
  }

  // ⑥ 探不到时长 → 宁可不给字幕，也不给一条对不上的时间轴
  {
    const p = planOf([{ id: "S1-01", prompt: "p", line: "有台词", video: "a.mp4" }], { disk: { "a.mp4": null }, ffprobe: "" });
    assert(!p.srt && !p.outputs.srt,
      "★探不到时长还硬生成字幕★ 时间轴必然是错的，错字幕比没字幕更坑人：" + JSON.stringify(p.srt));
    assert(p.ready, "探不到时长不该拦着出片（直拼试试，拼不上会自动改重编码）");
    // 台词全是模板占位文字：也不给字幕，不写一个空文件充数
    const ph = planOf([{ id: "S1-01", prompt: "p", line: "对白或旁白…", video: "a.mp4" }], { disk: { "a.mp4": V(2, 540, 960) } });
    assert(!ph.outputs.srt, "★模板占位文字被当成台词做进字幕了★：" + JSON.stringify(ph.srt));
  }

  // ⑦ 不许盖掉已有的成片。用户手改过的那一版，盖了就找不回来了
  {
    const p = planOf([{ id: "S1-01", prompt: "p", video: "a.mp4" }],
      { disk: { "a.mp4": V(2, 540, 960) }, plain: ["成片.mp4", "成片_2.mp4"] });
    assert(p.outputs.film === "成片_3.mp4",
      "★新片子直接盖掉旧成片★ 用户手改过的那版就没了：" + p.outputs.film);
  }

  // ⑧ 每一条命令都得是能直接跑的 argv 数组，不是拼出来的字符串。
  //   拼字符串 = 文件名里有空格或中文引号就炸，而短剧的素材名全是中文
  {
    const p = planOf([{ id: "S1-01", prompt: "p", video: "a.mp4" }], { disk: { "a.mp4": V(2, 540, 960) } });
    for (const s of p.steps) {
      assert(Array.isArray(s.argv) && s.argv.every((x) => typeof x === "string" && x.length),
        "命令不是 argv 数组（或有空参数）：" + s.key + " " + JSON.stringify(s.argv));
      assert(!s.argv.some((x) => /^ffmpeg$/i.test(x)), "argv 里不该自带 ffmpeg 本身：" + JSON.stringify(s.argv));
    }
    const concat = p.steps.find((s) => s.key === "concat");
    assert(concat && concat.fallback && concat.fallbackWhy, "★直拼失败没有退路★ 那一下失败整条就白跑了：" + JSON.stringify(concat));
    assert(p.listText.split("\n").filter(Boolean).every((l) => /^file '/.test(l)), "concat 清单格式不对：" + p.listText);
  }

  // ⑨ 配乐。三种错法都是「片子照样能播、每条断言都绿、只有耳朵知道不对」：
  //   把配音当成配乐垫到全片底下 / 人声被 amix 平白除以 2 / 音乐比片子短了就断在半路
  {
    const musicPlan = (nodes, ex = {}) => {
      const files = new Map(), onDisk = new Set(), probes = {};
      for (const [base, pr] of Object.entries(ex.disk || {})) { files.set(base, "素材/" + base); onDisk.add(base); if (pr) probes[base] = pr; }
      return C.composePlan({ nodes, edges: [] }, {
        files, onDisk, probes, ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe", burn: true,
        duck: ex.duck !== false, limiter: ex.limiter !== false,
        ...(ex.music === undefined ? {} : { music: ex.music }),
      });
    };
    const shot = (extra) => ({ id: "n1", kind: "shot", payload: { id: "S1-01", prompt: "p", video: "素材/a.mp4", ...extra }, position: { x: 0, y: 0 } });
    const audioNode = (payload, y) => ({ id: "m" + y, kind: "audio", payload, position: { x: 0, y } });
    const disk10 = { "a.mp4": V(10, 540, 960), "v.mp3": A(6), "bgm.mp3": A(60), "短曲.mp3": A(3) };

    // a. 标成配乐的声音节点 → 排一步混音，而且**成片这个名字归配好乐的那一版**
    const withMusic = musicPlan([shot({ line: "一句", audio: "素材/v.mp3" }), audioNode({ title: "主题曲", role: "配乐", url: "素材/bgm.mp3" }, 400)], { disk: disk10 });
    assert(withMusic.musicOn && withMusic.music && withMusic.music.base === "bgm.mp3", "★画布上摆着配乐却不混★：" + JSON.stringify(withMusic.music));
    const mus = withMusic.steps.find((x) => x.key === "music");
    assert(mus && mus.out === withMusic.outputs.film, "★配乐混完不叫成片★ 写回画布、进度带、「打开看看」认的都是成片那一条，配乐等于白做："
      + JSON.stringify({ out: mus && mus.out, film: withMusic.outputs.film }));
    assert(withMusic.steps.find((x) => x.key === "concat").out === withMusic.outputs.merged && /^成片素材\//.test(withMusic.outputs.merged),
      "★没配乐的那条拼接稿占了成片的名字★：" + JSON.stringify(withMusic.outputs));
    assert(withMusic.steps.map((x) => x.key).join(">") === "clip:S1-01>concat>music>subtitle",
      "★配乐和烧字幕的先后排错了★ 字幕得烧在**已经配好乐**的那条上，不然两条片子各缺一样：" + withMusic.steps.map((x) => x.key).join(">"));
    assert(withMusic.steps.find((x) => x.key === "subtitle").argv.includes(withMusic.outputs.film), "烧字幕烧的不是配好乐的那条");

    // b. 最容易踩的那脚：声音节点「素材用途」的默认值就是**「对白/音乐」**。
    //    只认「音乐」两个字的话，每一段配音都会被当成配乐垫到全片底下——
    //    症状是整条片子有人在念第三镜的台词，而所有断言都是绿的
    const dflt = musicPlan([shot({}), audioNode({ title: "S1-01 配音", role: "对白/音乐", url: "素材/v.mp3" }, 400)], { disk: disk10 });
    assert(!dflt.musicOn && !dflt.music, "★把「对白/音乐」（声音节点的默认用途）当成了配乐★ 整条片子底下会一直有人念台词：" + JSON.stringify(dflt.music));
    // 反过来：已经被某一镜当配音用的文件，就算标成配乐也不许混
    const reused = musicPlan([shot({ line: "一句", audio: "素材/v.mp3" }), audioNode({ title: "配乐", role: "配乐", url: "素材/v.mp3" }, 400)], { disk: disk10 });
    assert(!reused.musicOn, "★把第一镜的配音又垫了一遍到全片底下★：" + JSON.stringify(reused.music));

    // c. 手动关掉：不混，但**那段音乐还得报上来**，不然界面上那个勾就没了，用户没地方再打开
    const off = musicPlan([shot({}), audioNode({ title: "主题曲", role: "配乐", url: "素材/bgm.mp3" }, 400)], { disk: disk10, music: false });
    assert(!off.musicOn && off.music && off.music.base === "bgm.mp3", "★关掉配乐之后连「有这段音乐」都不说了★ 界面上的勾会消失：" + JSON.stringify({ on: off.musicOn, m: off.music }));
    assert(off.steps.find((x) => x.key === "concat").out === off.outputs.film && !off.steps.some((x) => x.key === "music"),
      "关掉配乐之后还留着中间文件 / 还排了混音：" + JSON.stringify(off.steps.map((x) => x.key)));

    // d. 音乐 60 秒、片子 10 秒 → 不循环；音乐 3 秒 → 必须循环垫到片尾，并且说出来
    assert(!mus.argv.includes("-stream_loop"), "音乐比片子长却还要循环：" + mus.argv.join(" "));
    const shortMusic = musicPlan([shot({}), audioNode({ title: "短曲", role: "背景音乐", url: "素材/短曲.mp3" }, 400)], { disk: disk10 });
    const sm = shortMusic.steps.find((x) => x.key === "music");
    assert(sm.argv.join(" ").includes("-stream_loop -1 -i 素材/短曲.mp3"),
      "★音乐比片子短却不循环★ 片子后半截会突然没声音：" + sm.argv.join(" "));
    assert(shortMusic.blockers.some((b) => /循环/.test(b.text)), "循环了却不说：" + JSON.stringify(shortMusic.blockers));

    // e. amix 默认 normalize=1，会把每一路都除以 2。不先把人声乘回来，
    //    整条片子的台词平白小一半——听起来只是「有点闷」，没人会想到是混音写错了
    const fc = mus.argv[mus.argv.indexOf("-filter_complex") + 1];
    assert(/\[0:a\][^;]*asplit/.test(fc) && /volume=2/.test(fc),
      "★配乐混完人声小了一半★ amix 默认 normalize=1，两路都除以 2，人声必须先乘回来：" + fc);
    assert(/amix=inputs=2:duration=first/.test(fc), "★amix 没按画面时长收★ 音乐会把片子拖长：" + fc);
    assert(/sidechaincompress/.test(fc), "本机有 sidechaincompress 却不做「说话时压低」（阳性对照）：" + fc);
    const noDuck = musicPlan([shot({ line: "一句", audio: "素材/v.mp3" }), audioNode({ title: "主题曲", role: "配乐", url: "素材/bgm.mp3" }, 400)], { disk: disk10, duck: false });
    const nd = noDuck.steps.find((x) => x.key === "music");
    assert(!/sidechaincompress/.test(nd.argv.join(" ")),
      "★本机没有 sidechaincompress 还往命令里写★ 那就是等整条片子拼完了，在最后一步报一句英文错：" + nd.argv.join(" "));
    assert(noDuck.blockers.some((b) => b.level === "warn" && /sidechaincompress|压低/.test(b.text)), "压不低也不说：" + JSON.stringify(noDuck.blockers));
    assert(noDuck.musicOn, "没有 sidechaincompress 不该连配乐都不做了");

    // f. 混音这一步必须有退路：一个滤镜不认识 ≠ 三十个镜头白拼
    assert(mus.fallback && mus.fallback.includes(withMusic.outputs.merged) && mus.fallback.includes(withMusic.outputs.film) && mus.fallbackWhy,
      "★配乐混不上就连片子都不给了★：" + JSON.stringify({ f: mus.fallback, why: mus.fallbackWhy }));
    assert(mus.fallback.join(" ").includes("-c copy"), "退路把画面重压了一遍，白掉一次画质：" + mus.fallback.join(" "));

    // g. 淡出不能排到片子外面去，也不能长到把整首都淡掉
    const fadeAt = /afade=t=out:st=([\d.]+):d=([\d.]+)/.exec(fc);
    assert(fadeAt && Number(fadeAt[1]) + Number(fadeAt[2]) <= withMusic.totalSeconds + 0.01 && Number(fadeAt[1]) > 0,
      "★配乐的淡出排到片子外面去了★ 那就是结尾硬切：" + JSON.stringify({ fade: fadeAt && fadeAt[0], total: withMusic.totalSeconds }));
    const tiny = musicPlan([{ id: "n1", kind: "shot", payload: { id: "S1-01", prompt: "p", video: "素材/b.mp4" }, position: { x: 0, y: 0 } },
      audioNode({ title: "主题曲", role: "配乐", url: "素材/bgm.mp3" }, 400)], { disk: { "b.mp4": V(2, 540, 960), "bgm.mp3": A(60) } });
    const tf = /afade=t=in:st=0:d=([\d.]+)/.exec(tiny.steps.find((x) => x.key === "music").argv.join(" "));
    assert(tf && Number(tf[1]) <= 1, "★2 秒的片子上来个 1.5 秒淡入★ 音乐从头到尾没到过正常音量，听着像忘了放：" + tf[0]);

    // h. 文件不在盘上 / 标成配乐的是张图：说清楚为什么没配乐，但片子照出
    const lost = musicPlan([shot({}), audioNode({ title: "主题曲", role: "配乐", url: "素材/没了.mp3" }, 400)], { disk: disk10 });
    assert(lost.ready && !lost.musicOn && lost.blockers.some((b) => b.level === "warn" && /配乐/.test(b.text)),
      "★配乐文件没了，要么闷头不配，要么连片子都不给★：" + JSON.stringify({ ready: lost.ready, b: lost.blockers }));
    const notAudio = musicPlan([shot({}), audioNode({ title: "主题曲", role: "配乐", url: "素材/封面.png" }, 400)], { disk: { ...disk10, "封面.png": null } });
    assert(notAudio.ready && !notAudio.musicOn && notAudio.blockers.some((b) => /不是音频/.test(b.text)), "标成配乐的是张图却照混：" + JSON.stringify(notAudio.blockers));

    // i. 画布上一段音乐都没有 → 一切照旧，不许平白多出一个中间文件
    const none = musicPlan([shot({})], { disk: disk10 });
    assert(!none.music && !none.musicOn && none.steps.find((x) => x.key === "concat").out === none.outputs.film,
      "没有配乐的时候也走了中间文件那条路：" + JSON.stringify(none.outputs));
  }


  // ── 屏幕上真出现的字：把渲染那一段抠出来，拿真计划渲染一遍 ───────────────
  // 「代码里有这个函数」证明不了用户看得见什么。这里断言的是画面上的字，
  // 尤其是**顺序**——那是唯一一个在开跑前还来得及纠正、跑完就得重花一遍钱的东西
  {
    const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
    const from = fe.indexOf("function canvasEtaText("), to = fe.indexOf("async function canvasLoadProgress(");
    assert(from > 0 && to > from, "抠不出渲染代码，这段作废（函数改名或挪走了？）");
    const sandbox = {
      esc: (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
      ic: (n) => `<i>${n}</i>`,
      canvasState: { composePlan: null, composeJob: null, composeSub: true, composeBgm: true, progress: null, progressOpen: true, batch: null, graph: null },
      canvasToast() {}, canvasRenderInspector() {}, canvasCenterSelected() {}, canvasRefreshNode() {}, canvasRunPending() {},
      document: { getElementById: () => null, querySelector: () => null },
    };
    const keys = Object.keys(sandbox);
    const ui = new Function(...keys, fe.slice(from, to) + "\nreturn { canvasComposeHtml };")(...keys.map((k) => sandbox[k]));
    const shotsOf = (p) => (p.shots || []).map((r) => ({ ...r, video: { ok: true } }));

    const good = planOf([
      { id: "S1-02", prompt: "p", line: "第二句", video: "b.mp4", audio: "v.mp3" },
      { id: "S1-01", prompt: "p", video: "a.mp4" },
    ], { disk: { "a.mp4": V(2, 540, 960), "b.mp4": V(2, 540, 960), "v.mp3": A(1.5) } });
    sandbox.canvasState.composePlan = { ...good, shots: shotsOf(good) };
    let html = ui.canvasComposeHtml({ shots: shotsOf(good) });
    const ord = [...html.matchAll(/<b>(S1-\d+)<\/b>/g)].map((m) => m[1]).join(">");
    assert(ord === "S1-01>S1-02",
      "★屏幕上没把顺序摆出来，或者摆错了★ 顺序是唯一一个开跑前还来得及改、跑完就得重花一遍钱的东西：" + ord);
    assert(/data-cp-compose-go(?![^>]*disabled)/.test(html), "能拼却把「开始合成」禁掉了");
    assert(html.includes("同名的旧成片不会被盖掉"), "没告诉用户旧成片会不会被盖");

    // 配乐：勾得出来、说得清垫的是哪一首、怎么垫
    assert(!/data-cp-compose-bgm/.test(html) && /声音/.test(html) && /配乐/.test(html),
      "★画布上没有配乐，屏幕上就一个字不提★ 用户不会知道「放个声音节点、用途写配乐」就能有：" + html.slice(0, 600));
    sandbox.canvasState.composePlan = { ...good, shots: shotsOf(good), music: { base: "配乐_主题.mp3", title: "主题曲", duck: true }, musicOn: true };
    html = ui.canvasComposeHtml({ shots: shotsOf(good) });
    assert(/data-cp-compose-bgm[^>]*checked/.test(html) && html.includes("主题曲"),
      "★认出了配乐却不写是哪一首、也不给取消的勾★ 画布上摆着好几段音乐时，混错了只能整条重跑：" + html.slice(0, 600));
    assert(html.includes("说话的时候自动压低"),
      "★没说配乐是怎么垫的★ 「一说话就自动压低」和「固定音量垫着」是两种成片，这台机器有没有这个滤镜用户得知道");
    sandbox.canvasState.composePlan = { ...good, shots: shotsOf(good), music: { base: "配乐_主题.mp3", title: "主题曲", duck: false }, musicOn: true };
    assert(ui.canvasComposeHtml({ shots: shotsOf(good) }).includes("固定音量垫在台词底下"),
      "★这台机器没有 sidechaincompress，屏幕上却还说「说话的时候自动压低」★");
    sandbox.canvasState.composeBgm = false;
    assert(!/data-cp-compose-bgm[^>]*checked/.test(ui.canvasComposeHtml({ shots: shotsOf(good) })),
      "★把勾去掉了，重画一次又自己勾回来★");
    sandbox.canvasState.composeBgm = true;

    // 拦下来的时候：说清楚为什么 + 「开始合成」必须点不动
    const blocked = planOf([{ id: "S1-01", prompt: "p", video: "a.mp4" }], { disk: { "a.mp4": V(2, 540, 960) }, ffmpeg: "" });
    sandbox.canvasState.composePlan = { ...blocked, shots: shotsOf(blocked) };
    html = ui.canvasComposeHtml({ shots: shotsOf(blocked) });
    assert(/data-cp-compose-go[^>]*disabled/.test(html), "★拼不了还能点「开始合成」★：" + html.slice(0, 300));
    assert(/brew install ffmpeg/.test(html), "★只说「不能合成」，不说缺什么、怎么装★：" + html.slice(0, 400));

    // 没 libass：屏幕上要说清「烧不进画面，但字幕文件照样给」，不能只留一句「做不了」
    const noBurn = planOf([{ id: "S1-01", prompt: "p", line: "有台词", video: "a.mp4", audio: "v.mp3" }],
      { disk: { "a.mp4": V(2, 540, 960), "v.mp3": A(2) }, burn: false });
    sandbox.canvasState.composePlan = { ...noBurn, shots: shotsOf(noBurn) };
    html = ui.canvasComposeHtml({ shots: shotsOf(noBurn) });
    assert(/libass/.test(html) && /字幕文件照样给/.test(html),
      "★烧不了字幕，屏幕上却没说字幕文件还在★ 用户会以为字幕根本没生成：" + html.slice(0, 500));
    assert(html.includes(noBurn.outputs.srt), "会写出哪些文件里没列上字幕文件：" + html.slice(0, 600));

    // 跑着 / 跑完 / 跑挂：三种状态各自给的是「下一步能干什么」
    sandbox.canvasState.composePlan = null;
    sandbox.canvasState.composeJob = { done: false, at: 2, total: 3, steps: [{ label: "第 1 镜" }, { label: "第 2 镜：画面接配音" }], log: [] };
    html = ui.canvasComposeHtml({ shots: [] });
    assert(html.includes("第 2/3 步") && html.includes("第 2 镜：画面接配音") && html.includes("data-cp-compose-stop"),
      "★跑着的时候不说跑到哪、也停不下来★ 一条片子要拼好几分钟：" + html.slice(0, 300));
    sandbox.canvasState.composeJob = { done: true, output: "成片.mp4", subtitled: "成片_带字幕.mp4", steps: [], log: [] };
    html = ui.canvasComposeHtml({ shots: [] });
    assert(html.includes("成片好了") && html.includes("data-cp-compose-open") && html.includes("成片.mp4"),
      "★片子拼好了却不给「打开看看」★：" + html.slice(0, 300));
    // 烧不进画面的那台机器上：字幕文件就躺在旁边，不说的话用户会以为字幕根本没做出来
    sandbox.canvasState.composeJob = { done: true, output: "成片.mp4", subtitled: "", subtitleFile: "字幕.srt", steps: [], log: [] };
    html = ui.canvasComposeHtml({ shots: [] });
    assert(html.includes("字幕.srt") && /拖进剪辑软件/.test(html),
      "★字幕没烧进画面，也没告诉用户字幕文件在哪★：" + html.slice(0, 400));
    sandbox.canvasState.composeJob = { done: true, error: "ffmpeg 退出码 1", steps: [{ label: "把 3 段接成一条", state: "fail", note: "这里是 ffmpeg 自己那句话" }], log: [] };
    html = ui.canvasComposeHtml({ shots: [] });
    assert(html.includes("没拼成") && html.includes("这里是 ffmpeg 自己那句话"),
      "★挂了只说「失败」，不给 ffmpeg 自己那句话★ 那句话比我们转述的准：" + html.slice(0, 300));

    // 有镜头还没视频：根本不该出现「合成成片」这个按钮——点了也只会拼出一条缺戏的片子
    sandbox.canvasState.composeJob = null;
    assert(ui.canvasComposeHtml({ shots: [{ id: "S1-01", video: { ok: true } }, { id: "S1-02", video: null }] }) === "",
      "★还有镜头没生成，却给了「合成成片」按钮★");
    assert(ui.canvasComposeHtml({ shots: [{ id: "S1-01", video: { ok: true } }] }).includes("data-cp-compose"), "全做完了却不给合成按钮（阳性对照）");
  }

  // ── 真机这一段：有 ffmpeg 才跑。造两条规格不同的真视频，走一遍完整合成 ────
  const hasFf = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
    && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
  if (!hasFf) {
    console.log("✅ 短剧一键合成（真机那段跳过：本机没有 ffmpeg）：顺序按镜头 ID · 配音长了补画面不切台词 · 画幅不齐转重编码 · 没 ffmpeg/没 libass 开跑前就说 · 探不到时长宁可不给字幕 · 不盖旧成片 · 命令是 argv 不是拼串 · 开跑前把顺序摆到屏幕上、拼不了时按钮点不动");
    return;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-compose-"));
  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));
  const ws = path.join(home, "workspace"), mat = path.join(ws, "素材");
  fs.mkdirSync(path.join(ws, ".openworkbuddy"), { recursive: true });
  fs.mkdirSync(mat, { recursive: true });
  const mkV = (name, sec, size, color) => execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:d=${sec}:r=25`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(mat, name)], { stdio: "ignore" });
  const mkA = (name, sec) => execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=f=440:d=${sec}`, path.join(mat, name)], { stdio: "ignore" });
  mkV("镜头_S1-01.mp4", 1, "360x640", "red");
  mkV("镜头_S1-02.mp4", 1, "480x854", "green");      // 画幅故意不一样
  mkA("配音_S1-02.mp3", 2.5);                         // 配音比画面长 —— 台词不许被切
  const nd = (id, kind, payload, x) => ({ id, kind, payload, position: { x, y: 0 } });
  fs.writeFileSync(path.join(ws, ".openworkbuddy", "canvas.json"), JSON.stringify({
    version: 1, edges: [], nodes: [
      // 数组顺序故意反着放
      nd("n2", "shot", { id: "S1-02", prompt: "p", line: "第二句得读完", video: "素材/镜头_S1-02.mp4", audio: "素材/配音_S1-02.mp3" }, 500),
      nd("n1", "shot", { id: "S1-01", prompt: "p", line: "", video: "素材/镜头_S1-01.mp4" }, 100),
    ],
  }));

  const boot = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const { up, port, why } = await boot.wait();
  const call = (method, p, body) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: {
      Cookie: "openworkbuddy_token=" + token, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve({ code: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ code: res.statusCode, body: b }); } });
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message }));
    if (data) r.write(data); r.end();
  });
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + why);
    const dry = await call("POST", "/api/canvas/compose", { subtitles: true });
    const plan = (dry.body || {}).plan || {};
    assert(dry.code === 200 && plan.ready, "算不出合成方案：" + JSON.stringify(dry.body).slice(0, 300));
    assert(plan.shots.map((r) => r.id).join(">") === "S1-01>S1-02", "真画布上的顺序也得按镜头 ID：" + plan.shots.map((r) => r.id).join(">"));
    assert(plan.mode === "reencode" && plan.shots[1].pad > 1.4, "真素材上没认出画幅不齐 / 配音更长：" + JSON.stringify({ m: plan.mode, s: plan.shots[1] }));

    const run = await call("POST", "/api/canvas/compose", { subtitles: true, run: true });
    assert(run.code === 200 && run.body.job && run.body.job.id, "合成起不来：" + JSON.stringify(run.body).slice(0, 300));
    let job = run.body.job;
    for (let i = 0; i < 180 && job && !job.done; i++) { await nap(500); job = (await call("GET", "/api/canvas/compose?job=" + job.id)).body.job; }
    assert(job && job.done && !job.error, "合成没跑完或报错了：" + ((job && job.error) || "超时")
      + " | " + ((job && job.steps) || []).map((s) => `${s.label}=${s.state}${s.note ? "(" + s.note.slice(0, 80) + ")" : ""}`).join(" | "));

    // 关键一条：不是「命令退出码 0」就算成了，得盘上真有一个有字节的文件
    assert(job.output && fs.existsSync(path.join(ws, job.output)) && fs.statSync(path.join(ws, job.output)).size > 1000,
      "★ffmpeg 说成了就当成了★ 磁盘满/被杀在半路都会留下一个 0 字节的壳：" + JSON.stringify({ o: job.output }));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", path.join(ws, job.output)]).toString());
    assert(Math.abs(Number(probe.format.duration) - 3.5) < 0.6,
      "★成片时长对不上（1 + 2.5 ≈ 3.5s）★ 多半是把长配音那一镜按画面时长切了，台词被吃掉半句：" + probe.format.duration);
    assert(probe.streams.some((s) => s.codec_type === "video") && probe.streams.some((s) => s.codec_type === "audio"),
      "★成片少一条流★ 有画面没声音 / 有声音没画面：" + JSON.stringify(probe.streams.map((s) => s.codec_type)));
    assert(probe.streams.some((s) => s.codec_type === "video" && s.width === 480 && s.height === 854), "画幅没统一到最大那个：" + JSON.stringify(probe.streams[0]));
    // 字幕文件跟能不能烧无关，一定要在
    assert(fs.existsSync(path.join(ws, plan.outputs.srt || "字幕.srt")), "★字幕文件没落盘★ 烧不烧得进画面是另一回事");

    // 写回画布 + 制片进度：必须因为「盘上真有这个文件」才翻绿
    const board = await call("GET", "/api/canvas");    // 注意：这个接口把 state 摊在顶层
    const tl = (board.body.nodes || []).filter((n) => n.kind === "timeline");
    assert(tl.length === 1 && tl[0].payload.video === job.output,
      "★片子拼出来了，画布上却没有★ 用户回到画布看见的还是一张没有成片的板子：" + JSON.stringify(tl.map((n) => n.payload)));
    const cut = ((await call("GET", "/api/canvas/progress")).body.stages || []).find((s) => s.key === "cut") || {};
    assert(cut.done === 1 && cut.total === 1, "制片进度的「成片」档没翻绿：" + JSON.stringify(cut));
    fs.renameSync(path.join(ws, job.output), path.join(ws, "挪走了.mp4"));
    const cut2 = ((await call("GET", "/api/canvas/progress")).body.stages || []).find((s) => s.key === "cut") || {};
    assert(cut2.done === 0, "★成片文件都不在了，进度还是绿的★ 说明它读的是字段不是盘：" + JSON.stringify(cut2));
    fs.renameSync(path.join(ws, "挪走了.mp4"), path.join(ws, job.output));

    const again = await call("POST", "/api/canvas/compose", { subtitles: false });
    assert(again.body.plan.outputs.film !== job.output,
      "★再合成一次会盖掉刚才那条成片★：" + again.body.plan.outputs.film);

    // ── 配乐这一段：垫没垫上，只有量音量能证明 ──────────────────────────────
    // 「有没有生成 music 这一步」「argv 里有没有 amix」都不算数：滤镜链写对了、
    // 音量却被 amix 默认的 normalize 除成了背景噪音，这两种断言全是绿的。
    // 唯一能分清的是拿 ffmpeg 自己量一遍成片：
    //   S1-01 那一镜没有配音 —— 第 1 秒本该是数字静音，垫上配乐之后必须响。
    const meanDb = (file, ss, t) => {
      const r = spawnSync("ffmpeg", ["-v", "info", "-ss", String(ss), "-t", String(t), "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
      const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr || "") + String(r.stdout || ""));
      return m ? Number(m[1]) : NaN;
    };
    const dry1 = path.join(ws, job.output);                       // 刚才那条没配乐的成片，就是阴性对照
    const silent = meanDb(dry1, 0, 1), voiceDry = meanDb(dry1, 1.5, 0.8);
    assert(silent < -40, "★没配乐的成片第 1 秒并不安静★ 那这条对照就证明不了配乐是不是真垫上了：" + silent);
    assert(voiceDry > -40, "★第二镜的台词量不到声音★ 后面「配乐没盖过台词」那条就无从比起：" + voiceDry);

    mkA("配乐_主题.mp3", 6);                                       // 比片子长 —— 不该循环、也不该把片子拉长
    const shotNodes = [
      nd("n2", "shot", { id: "S1-02", prompt: "p", line: "第二句得读完", video: "素材/镜头_S1-02.mp4", audio: "素材/配音_S1-02.mp3" }, 500),
      nd("n1", "shot", { id: "S1-01", prompt: "p", line: "", video: "素材/镜头_S1-01.mp4" }, 100),
    ];
    fs.writeFileSync(path.join(ws, ".openworkbuddy", "canvas.json"), JSON.stringify({
      version: 1, edges: [], nodes: [...shotNodes,
        // 素材用途写「配乐」才算配乐；节点默认那个「对白/音乐」在单测里钉过了，这儿测的是真能认出来
        nd("n3", "audio", { title: "主题曲", role: "配乐", url: "素材/配乐_主题.mp3" }, 900),
      ],
    }));
    const mDry = await call("POST", "/api/canvas/compose", { subtitles: false });
    assert(mDry.body.plan.music && mDry.body.plan.musicOn,
      "★画布上明明有一个「配乐」声音节点，方案里却没认出来★：" + JSON.stringify(mDry.body.plan.music));
    const offDry = await call("POST", "/api/canvas/compose", { subtitles: false, music: false });
    assert(offDry.body.plan.music && !offDry.body.plan.musicOn
      && !(offDry.body.plan.steps || []).some((s) => /配乐/.test(s.label || "")),
      "★把「垫上配乐」的勾去掉了，后端照垫★ 勾是给用户否决用的：" + JSON.stringify((offDry.body.plan.steps || []).map((s) => s.label)));

    const mRun = await call("POST", "/api/canvas/compose", { subtitles: false, run: true });
    let mJob = mRun.body.job;
    for (let i = 0; i < 180 && mJob && !mJob.done; i++) { await nap(500); mJob = (await call("GET", "/api/canvas/compose?job=" + mJob.id)).body.job; }
    assert(mJob && mJob.done && !mJob.error, "带配乐的合成没跑完或报错了：" + ((mJob && mJob.error) || "超时")
      + " | " + ((mJob && mJob.steps) || []).map((s) => `${s.label}=${s.state}${s.note ? "(" + s.note.slice(0, 80) + ")" : ""}`).join(" | "));
    const mStep = (mJob.steps || []).find((s) => /配乐/.test(s.label || ""));
    assert(mStep && mStep.state === "done" && !mStep.note,
      "★配乐那一步退回了「先把没配乐的成片交出来」★ 那后面量出来的就只是台词：" + JSON.stringify(mStep));
    const film = path.join(ws, mJob.output);
    assert(mJob.output && fs.existsSync(film) && fs.statSync(film).size > 1000, "带配乐的成片没落盘：" + mJob.output);

    const mProbe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", film]).toString());
    assert(Math.abs(Number(mProbe.format.duration) - 3.5) < 0.6,
      "★配乐把片子拉长了★ 6 秒的音乐垫在 3.5 秒的片子下面，片尾多出来两秒半黑屏：" + mProbe.format.duration);
    // 量三个窗口（阈值都是相对的，换台机器换个 ffmpeg 版本也不会飘）：
    //   ① 0.88–1.0s：淡入已经走完、第二镜的台词还没进来 —— 这一段听到的纯粹是配乐
    //   ② 0–0.12s：淡入刚起头，必须明显比 ① 轻，否则就是淡入参数没生效
    //   ③ 1.5–2.3s：台词段，跟没配乐那条逐 dB 对比
    const src = meanDb(path.join(mat, "配乐_主题.mp3"), 0, 3);
    const bed = meanDb(film, 0.88, 0.11), head = meanDb(film, 0, 0.12), voiceMix = meanDb(film, 1.5, 0.8);
    assert(bed > src - 21,
      "★配乐那一步跑绿了，成片里却几乎听不见★ 滤镜链接错了路、或者音量被一层层除没了，看命令是看不出来的："
      + JSON.stringify({ 音乐文件: src, 成片里的配乐: bed }));
    assert(bed < voiceMix - 8,
      "★配乐盖过台词了★ 它是垫在底下的床，不是主角（漏掉 volume=" + (C._internals.MUSIC_GAIN * 2) + " 就是这个后果）："
      + JSON.stringify({ 配乐: bed, 台词: voiceMix }));
    assert(head < bed - 8,
      "★配乐从第一帧就整音量砸进来★ 淡入没生效，片头会被音乐怼一下：" + JSON.stringify({ 开头: head, 淡入之后: bed }));
    assert(voiceMix > voiceDry - 2.5,
      "★台词被配乐这一步压小了★ amix 默认 normalize=1 会把每一路都除以 2，听感只是「有点闷」，最容易蒙混过去："
      + JSON.stringify({ 没配乐: voiceDry, 垫了配乐: voiceMix }));
    assert(!fs.existsSync(path.join(ws, "成片素材", "拼接.mp4")) || fs.statSync(path.join(ws, "成片素材", "拼接.mp4")).size > 0,
      "中间那条没配乐的拼接片留了个 0 字节的壳");


    // ── 跑挂的时候：说的是 ffmpeg 自己那句话，而且不许在盘上留半截文件 ────────
    // 半截的「成片.mp4」跟真成片在文件列表里长得一模一样，留着迟早被当成成片发出去
    fs.writeFileSync(path.join(mat, "配音_坏的.mp3"), "这不是音频，只是个后缀像音频的文本文件");
    fs.writeFileSync(path.join(ws, ".openworkbuddy", "canvas.json"), JSON.stringify({
      version: 1, edges: [], nodes: [nd("n1", "shot", { id: "S1-01", prompt: "p", video: "素材/镜头_S1-01.mp4", audio: "素材/配音_坏的.mp3" }, 100)],
    }));
    const badDry = await call("POST", "/api/canvas/compose", { subtitles: false });
    const badPlan = badDry.body.plan;
    assert(badPlan.ready, "这一步要的是「跑起来才挂」，计划这层就拦下来的话就测不到了");
    const badRun = await call("POST", "/api/canvas/compose", { subtitles: false, run: true });
    let bad = badRun.body.job;
    for (let i = 0; i < 120 && bad && !bad.done; i++) { await nap(500); bad = (await call("GET", "/api/canvas/compose?job=" + bad.id)).body.job; }
    assert(bad && bad.done && bad.error, "★喂了个坏文件进去却报成功★：" + JSON.stringify(bad && bad.steps));
    assert(/ffmpeg|退出码/.test(bad.error) && bad.steps.some((x) => x.state === "fail" && x.note),
      "★只说「失败了」，不给 ffmpeg 自己那几行★ 那几行比我们转述的准：" + bad.error);
    assert(!bad.output, "挂了还给了成片路径：" + bad.output);
    for (const leftover of [badPlan.outputs.film, ...(badPlan.outputs.clips || [])]) {
      assert(!fs.existsSync(path.join(ws, leftover)),
        "★挂了却在盘上留了个半截文件★ 它在文件列表里跟真成片长得一模一样：" + leftover);
    }
    const cut3 = ((await call("GET", "/api/canvas/progress")).body.stages || []).find((s) => s.key === "cut") || {};
    assert(cut3.done === 0, "这次没拼成，「成片」档不该是绿的：" + JSON.stringify(cut3));
  } finally { boot.child.kill(); }

  console.log("✅ 短剧一键合成：顺序按镜头 ID（不按数组/坐标）且开跑前摆到屏幕上 · 配音长了补画面绝不切台词 · 画幅不齐自动转重编码 · 没 ffmpeg/没 libass 开跑前就说清楚（还给装法，按钮点不动）· 探不到时长宁可不给字幕 · 配乐认得出来、量得到声、不压台词也不拉长片子 · 退出码 0 还得盘上真有字节 · 写回画布 + 进度按盘上文件翻绿 · 不盖旧成片");
}

/**
 * 短剧定妆照 / 场景图：这条产线上唯一一档「进度条给你打分、产品却不给你做」的活儿。
 *
 * 定妆照是整部戏一致性的地基：镜头生首帧时会把上游角色节点的图当参考图带上，
 * 没有它，每一镜的脸都不是同一个人。而在这之前它有三个洞，每个都能单独毁一部戏：
 *   ① 属性面板「参考图」挑好的定妆照落在 payload.reference，进度条的 image 口径里没这个字段 ——
 *      图就在节点上、文件就在盘上、画布上都画出来了，定妆那一档永远是 0/N，
 *      「下一步」还一直催你「继续做定妆：还差 2 个」。照着催的做，就是花钱重跑已经有的图。
 *   ② 服务端的 ASSET_REF_KEYS 同样没有 reference，于是定妆照在素材台账里算「没人用」——
 *      而「没人用」那一栏是加粗显示的，旁边写着「多半是重跑留下的旧版本，占地方」。
 *      等于指着这部戏最要命的几张图叫人删。删了，后面每一镜的脸就开始换人。
 *   ③ 角色节点上压根没有生成按钮：定妆照只能自己去文件夹里挑，或者指望 Agent 临场发挥。
 *      连「定妆照文件丢了」那条卡点自己写的 action 都是「重生成定妆照」——一个不存在的动作。
 *
 * 这条套件把三个洞各钉一根：算得对、认得出、点得动。外加一根反向的：
 * 镜头节点上的 reference 是**喂进去的**参考图，绝不许被当成产出的首帧算完成。
 */
async function testDramaCast() {
  const pipeline = require(path.join(__dirname, "..", "drama-pipeline.js"));
  const node = (id, kind, payload) => ({ id, kind, payload, position: { x: 0, y: 0 } });

  // ── ① 算得对：「参考图」里挑的定妆照就是定妆照 ─────────────────────────
  {
    const state = { nodes: [
      node("c1", "character", { name: "阿岚", role: "主角", description: "红衣女孩", reference: "素材/角色_阿岚_定妆.png" }),
      node("c2", "character", { name: "老陈", role: "配角", description: "茶馆老板", reference: "素材/角色_老陈_定妆.png" }),
    ], edges: [] };
    const d = pipeline.dramaProgress(state, { onDisk: new Set(["角色_阿岚_定妆.png", "角色_老陈_定妆.png"]) });
    const cast = d.stages.find((s) => s.key === "cast");
    assert(cast.done === 2 && cast.total === 2,
      "★定妆照就在节点上、文件也在盘上，进度条却说一个都没做★ 这一档会永远停在 0：" + JSON.stringify(cast));
    assert(d.pending.cast === 0, "都做完了还说有活儿：" + JSON.stringify(d.pending));
    assert(!/定妆/.test(d.next.text),
      "★催你去做已经做完的定妆★ 照着这句做就是花钱把已有的图重跑一遍：" + JSON.stringify(d.next));
    assert(d.cast.length === 2 && d.cast[0].nodeId === "c1" && d.cast[0].name === "阿岚" && d.cast[0].image.ok === true,
      "定妆那一档得给得出是哪几个角色、图在哪，界面上才跳得过去：" + JSON.stringify(d.cast));
  }

  // ── ② 写着路径不等于文件在盘上 ────────────────────────────────────────
  {
    const state = { nodes: [
      node("c1", "character", { name: "阿岚", description: "红衣女孩", reference: "素材/角色_阿岚_定妆.png" }),
      node("c2", "character", { name: "老陈", description: "茶馆老板", reference: "素材/角色_老陈_定妆.png" }),
      node("c3", "character", { name: "路人", description: "没有图" }),
    ], edges: [] };
    const d = pipeline.dramaProgress(state, { onDisk: new Set(["角色_阿岚_定妆.png"]) });
    assert(d.stages.find((s) => s.key === "cast").done === 1, "文件没了还算这个角色定妆做完了");
    assert(d.pending.cast === 2, "丢了的和没做的都得算成还有活儿：" + JSON.stringify(d.pending));
    const stop = (d.blockers || []).find((b) => /定妆照/.test(b.text));
    assert(stop && stop.level === "stop" && stop.ids.includes("c2") && !stop.ids.includes("c1"),
      "★定妆照丢了不报、或者报了指不出是谁★：" + JSON.stringify(d.blockers));
    assert(stop.action === "重生成定妆照", "卡点说的动作要跟界面上真有的按钮对得上：" + JSON.stringify(stop));
  }

  // ── ③ 反向对照：镜头上的 reference 是喂进去的，不是产出的 ──────────────
  {
    const d = pipeline.dramaProgress({ nodes: [
      node("s1", "shot", { id: "S1-01", prompt: "有提示词", reference: "素材/参考_构图.png" }),
    ] }, { onDisk: new Set(["参考_构图.png"]) });
    assert(d.stages.find((s) => s.key === "frame").done === 0,
      "★把喂进去的参考图当成产出的首帧算完成了★ 这一镜其实一张首帧都没生，屏幕上却是绿的："
      + JSON.stringify(d.stages.find((s) => s.key === "frame")));
    assert(d.pending.image === 1, "这一镜的首帧还得生：" + JSON.stringify(d.pending));
    assert(d.pending.cast === 0, "镜头节点不该被算成角色：" + JSON.stringify(d.pending));
  }

  // ── ④ 文件名：客户端起的名字，服务端的「用途」得认得出来 ────────────────
  {
    const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
    const m = /function canvasOutputFilename\([\s\S]*?\n}/.exec(fe);
    assert(m, "抠不出 canvasOutputFilename（改名了？）");
    const nameOf = new Function(m[0] + "\nreturn canvasOutputFilename;")();
    const cast = nameOf({ name: "阿岚" }, "image", "character");
    const place = nameOf({ name: "茶馆" }, "image", "location");
    assert(cast === "角色_阿岚_定妆.png", "定妆照文件名不对：" + cast);
    assert(place === "场景_茶馆.png", "场景图文件名不对：" + place);
    assert(nameOf({ id: "S1-01" }, "image", "shot") === "镜头_S1-01_首帧.png", "镜头首帧的名字被改坏了");
    assert(nameOf({ id: "S1-01" }, "video", "shot") === "镜头_S1-01.mp4", "镜头视频的名字被改坏了");

    // 跨模块对口径：服务端按文件名判「用途」，两边对不上，生成完就掉进「其他」里找不着
    const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const r = /function assetRoleOf\([\s\S]*?\n}/.exec(srv);
    assert(r, "抠不出 assetRoleOf（改名了？）");
    const roleOf = new Function(r[0] + "\nreturn assetRoleOf;")();
    assert(roleOf(cast) === "定妆照", "★客户端生成的定妆照，服务端认不出用途★ 台账里会掉进「其他」：" + roleOf(cast));
    assert(roleOf(place) === "场景图", "★场景图认不出用途★：" + roleOf(place));
    assert(roleOf("定妆_阿岚.png") === "定妆照", "手起的「定妆_」名字也得认：" + roleOf("定妆_阿岚.png"));

    // 两边的字段口径也得一样：少一个 reference，定妆照就成了「没人用」
    const keys = /const ASSET_REF_KEYS = \[([^\]]*)\]/.exec(srv);
    assert(keys && /["']reference["']/.test(keys[1]),
      "★服务端不认 reference★ 定妆照会被算成「没人用」，而那一栏是加粗提示可以删的：" + (keys && keys[1]));
    const cKeys = /const CANVAS_REF_KEYS = \[([^\]]*)\]/.exec(fe);
    assert(cKeys && /["']reference["']/.test(cKeys[1]), "客户端的字段口径也得有 reference：" + (cKeys && cKeys[1]));

    // 占位文字两边各存一份，注释里写着「是同一份口径」。分了家就是：
    // 一边说「这句还是模板、不许开枪」，另一边说「写了，算你做完了」
    const pick = (src, re) => (re.exec(src) || [])[1] || "";
    const cp = pick(fe, /const CANVAS_PROMPT_PLACEHOLDERS = \[([\s\S]*?)\];/);
    const sp = pick(fs.readFileSync(path.join(__dirname, "..", "drama-pipeline.js"), "utf8"), /const PLACEHOLDERS = \[([\s\S]*?)\];/);
    const norm = (t) => (t.match(/"[^"]*"/g) || []).map((x) => x.slice(1, -1)).sort().join("|");
    assert(norm(cp) && norm(cp) === norm(sp),
      "★占位文字两边对不上了★ 一边拦、一边放，同一句话在两处判得不一样：\n前端 " + norm(cp) + "\n服务端 " + norm(sp));
  }

  // ── ⑤ 点得动：角色 / 场景节点屏幕上真有那个按钮 ────────────────────────
  {
    const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
    const from = fe.indexOf("function canvasNodeHtml("), to = fe.indexOf("\nfunction canvasSelectedNode(");
    assert(from > 0 && to > from, "抠不出节点渲染代码（函数改名了？）");
    const sandbox = {
      esc: (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
      ic: (n) => `<i>${n}</i>`,
      canvasState: { busy: new Set() },
      CANVAS_NODE_DEFS: { character: { label: "角色", icon: "user", subtitle: "角色" }, location: { label: "场景", icon: "map", subtitle: "场景" } },
      canvasEmbeddedImage: (p) => String(p.reference || p.image || ""),
      canvasFileUrl: (v) => "/f/" + v,
      canvasGenerationSummary: () => "",
      canvasMediaPath: () => "", canvasMediaImage: () => "", canvasMediaVideo: () => "", canvasMediaAudio: () => "",
      canvasKind: () => "", canvasPayload: () => ({}),
    };
    const keys = Object.keys(sandbox);
    const ui = new Function(...keys, fe.slice(from, to) + "\nreturn canvasNodeHtml;")(...keys.map((k) => sandbox[k]));

    const blank = ui("character", { name: "阿岚", role: "主角", description: "红衣女孩" }, "c1");
    assert(/data-canvas-generate="image"/.test(blank) && /生成定妆照/.test(blank),
      "★角色节点上没有生成定妆照的按钮★ 这一档只能自己去文件夹里挑图：" + blank.slice(0, 400));
    assert(!/disabled/.test(blank), "没在跑却把按钮禁了：" + blank.slice(0, 400));

    const has = ui("character", { name: "阿岚", description: "红衣女孩", reference: "素材/角色_阿岚_定妆.png" }, "c1");
    assert(/重生成定妆照/.test(has), "已经有图了，按钮该写「重生成」：" + has.slice(0, 400));
    assert(/data-canvas-side-preview="素材\/角色_阿岚_定妆\.png"/.test(has), "有图却给不出预览：" + has.slice(0, 400));

    sandbox.canvasState.busy.add("c1:image");
    const busy = ui("character", { name: "阿岚", description: "红衣女孩" }, "c1");
    assert(/生成中…/.test(busy) && /disabled/.test(busy),
      "★正在跑还能再点一次★ 同一张图会被发两遍，钱也烧两遍：" + busy.slice(0, 400));
    sandbox.canvasState.busy.clear();

    const place = ui("location", { name: "茶馆", description: "旧木桌" }, "l1");
    assert(/生成场景图/.test(place) && /data-canvas-generate="image"/.test(place), "场景节点也得能生图：" + place.slice(0, 400));
  }

  // ── ⑥ 真按下去发出的那一枪：名字、提示词、写回哪个字段 ──────────────────
  // 这一步是要花钱的。花出去的那一次请求里带的是什么、回来的路径写去了哪，
  // 只有把 fetch 拦下来看一眼才知道；写回错字段 = 图生出来了、界面上还说你没做
  {
    const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
    const gFrom = fe.indexOf("async function canvasGenerate("), gTo = fe.indexOf("\nfunction canvasBindNode(");
    const nFrom = fe.indexOf("function canvasOutputFilename("), nTo = fe.indexOf("\nfunction canvasDefaultPayload(");
    const pFrom = fe.indexOf("const CANVAS_PROMPT_PLACEHOLDERS ="), pTo = fe.indexOf("\nasync function canvasLoadAssets(");
    assert(gFrom > 0 && gTo > gFrom && nFrom > 0 && nTo > nFrom && pFrom > 0 && pTo > pFrom, "抠不出生成那段代码（函数改名了？）");

    let sent = null, toast = "", back = "素材/角色_阿岚_定妆.png";
    const mk = (kind, payload) => { const p = { ...payload }; return { id: "c1", kind, p, set(_k, v) { Object.keys(this.p).forEach((k) => delete this.p[k]); Object.assign(this.p, v); } }; };
    const sandbox = {
      canvasState: { busy: new Set(), selected: null },
      canvasKind: (n) => n.kind, canvasPayload: (n) => n.p,
      canvasUpstreamImages: () => [], canvasUpstreamInputs: () => [], canvasGenerationContext: () => "",
      canvasToast: (t) => { toast = String(t); },
      canvasRefreshNode() {}, canvasRenderInspector() {}, canvasPersist() {}, canvasUpsertResult() {},
      canvasRecordGeneration: (n, k, input, file) => ({ ...n.p, generation: { output: file } }),
      canvasResolvedFileName: (v) => v, previewFile: null,
      CANVAS_NODE_DEFS: { image: { label: "图片" }, video: { label: "视频" }, audio: { label: "声音" } },
      fetch: async (url, opt) => { sent = { url, body: JSON.parse(opt.body) }; return { ok: true, json: async () => ({ ok: true, file: back }) }; },
    };
    const keys = Object.keys(sandbox);
    const ui = new Function(...keys,
      fe.slice(nFrom, nTo) + fe.slice(pFrom, pTo) + fe.slice(gFrom, gTo) + "\nreturn canvasGenerate;")(...keys.map((k) => sandbox[k]));

    // 设定还是模板里那句 → 一枪都不许开
    const lazy = mk("character", { name: "阿岚", description: "人物外形、性格、目标与关系…" });
    await ui(lazy, "image");
    assert(sent === null,
      "★只有一个名字就去生图★ 生出来的脸每次都不一样，当参考图没用，钱白花：" + JSON.stringify(sent));
    assert(/人物设定/.test(toast), "拦下来了却不说为什么：" + toast);

    // 写了设定 → 名字、提示词、写回的字段三样都得对
    const real = mk("character", { name: "阿岚", role: "主角", description: "十七岁，红衣，左眉有疤" });
    await ui(real, "image");
    assert(sent && sent.body.tool === "generate_image", "没走生图那条：" + JSON.stringify(sent));
    assert(sent.body.input.filename === "角色_阿岚_定妆.png", "落盘名字不对：" + JSON.stringify(sent.body.input));
    assert(/定妆照/.test(sent.body.input.prompt) && /左眉有疤/.test(sent.body.input.prompt),
      "★提示词里没带人物设定★ 那就是拿一个名字去生图：" + JSON.stringify(sent.body.input.prompt));
    assert(/参考/.test(sent.body.input.prompt),
      "定妆照是要被后面每一镜反复引用的，提示词里得说清楚这件事：" + JSON.stringify(sent.body.input.prompt));
    assert(real.p.reference === "素材/角色_阿岚_定妆.png",
      "★定妆照没写回 reference★ 图生出来了，进度条和素材台账认的是这个字段，写去别处等于白生："
      + JSON.stringify(real.p));
    assert(!real.p.path && !real.p.url, "别再顺手写一份 path/url，台账会把同一张图数两遍：" + JSON.stringify(real.p));

    // 场景图写回 image
    back = "素材/场景_茶馆.png";
    const place = mk("location", { name: "茶馆", description: "旧木桌，午后斜光" });
    await ui(place, "image");
    assert(sent.body.input.filename === "场景_茶馆.png", "场景图落盘名字不对：" + JSON.stringify(sent.body.input));
    assert(place.p.image === "素材/场景_茶馆.png", "场景图该写回 image：" + JSON.stringify(place.p));
  }

  // ── ⑦ 真 server：进度条认、台账认、用途也认 ────────────────────────────
  {
    const http = require("http"), crypto = require("crypto");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cast-"));
    const token = "e2e" + crypto.randomBytes(12).toString("hex");
    fs.mkdirSync(path.join(home, "data"), { recursive: true });
    fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
      users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
      tokens: { [token]: { user: "e2e", at: Date.now() } },
    }));
    const ws = path.join(home, "workspace"), mat = path.join(ws, "素材");
    fs.mkdirSync(path.join(ws, ".openworkbuddy"), { recursive: true });
    fs.mkdirSync(mat, { recursive: true });
    fs.writeFileSync(path.join(mat, "角色_阿岚_定妆.png"), "x");
    fs.writeFileSync(path.join(mat, "场景_茶馆.png"), "x");
    fs.writeFileSync(path.join(ws, ".openworkbuddy", "canvas.json"), JSON.stringify({ version: 1, edges: [], nodes: [
      node("c1", "character", { name: "阿岚", role: "主角", description: "红衣女孩", reference: "素材/角色_阿岚_定妆.png" }),
      node("l1", "location", { name: "茶馆", description: "旧木桌", image: "素材/场景_茶馆.png" }),
    ] }));
    const boot = bootRealServer({ OPENWORKBUDDY_HOME: home });
    const { up, port, why } = await boot.wait();
    const get = (p) => new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: p, headers: { Cookie: "openworkbuddy_token=" + token } }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ code: res.statusCode, body: b }));
      });
      req.on("error", (e) => resolve({ code: 0, body: e.message })); req.end();
    });
    try {
      assert(up, "真 server.js 没起来，这条测试作废：" + why);
      const pr = JSON.parse((await get("/api/canvas/progress")).body);
      const cast = (pr.stages || []).find((s) => s.key === "cast");
      assert(cast && cast.done === 1 && cast.total === 1,
        "★真 server 上定妆还是 0★ 图在节点上、文件在盘上、画布也画出来了：" + JSON.stringify(cast));
      assert(!/定妆/.test((pr.next || {}).text || ""),
        "★催你去做已经做完的定妆★ 照着这句做就是花钱重跑已有的图：" + JSON.stringify(pr.next));
      const as = JSON.parse((await get("/api/canvas/assets")).body);
      const rows = as.assets || [];
      const lan = rows.find((r) => /角色_阿岚_定妆/.test(r.name || ""));
      const cha = rows.find((r) => /场景_茶馆/.test(r.name || ""));
      assert(lan && (lan.usedBy || []).length > 0 && !lan.orphan,
        "★定妆照被算成「没人用」★ 那一栏是加粗写着「多半是旧版本，占地方」的，照着删就毁了整部戏："
        + JSON.stringify(lan));
      assert(lan.role === "定妆照", "定妆照的用途认错了，在「用途」筛选里找不着：" + JSON.stringify(lan));
      assert(cha && !cha.orphan && cha.role === "场景图", "场景图也得认：" + JSON.stringify(cha));
      assert(!(as.stat || {}).orphan, "没人用的数量不该是 " + (as.stat || {}).orphan + "：" + JSON.stringify(as.stat));
    } finally { boot.child.kill(); }
  }

  console.log("✅ 短剧定妆照：「参考图」挑的图就算定妆（进度不再永远 0/N、也不再催你重跑花过的钱）· 镜头上喂进去的参考图绝不冒充首帧 · 定妆照在台账里算「有人在用」不进「没人用」那一栏 · 角色/场景节点真有生成按钮（跑着锁、有图变重生成）· 只有名字不开枪 · 客户端起的名字服务端认得出用途 · 定妆照写回 reference、场景图写回 image");
}

async function testDramaShotRefs() {
  // 定妆照做出来了，进度条也绿了——可它只有真被带进「生首帧」那一枪里才算数。
  // 这一档以前有两个坑，都不是「效果差一点」，是花了钱拿不到东西：
  //   · 把分镜按顺序连起来（画布上摆一部戏最自然的做法），上一镜一旦出了视频，
  //     它交给下一镜的是 .mp4；generate_image 收到非图片参考当场退回（tools.js 的 IMAGE_EXT），
  //     于是后面每一镜的首帧都生不出来，「一键补齐首帧」会一路红到底；
  //   · 生视频找不到首帧时拿 upstream[0] 顶，上游第一个是谁全看连线顺序——多半是角色的定妆照。
  //     拿定妆照当首帧生出来的片子跟这一镜没关系，而那一枪是要付钱的。
  const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
  const cut = (from, to) => {
    const a = fe.indexOf(from), b = fe.indexOf(to, a + 1);
    assert(a >= 0 && b > a, "抠不出这段代码（函数改名了？）：" + from);
    return fe.slice(a, b);
  };
  const src = [
    cut("function canvasMediaPath(payload)", "\nfunction canvasMediaMime("),
    cut("function canvasFileKind(name)", "\n/**"),
    cut("function canvasEmbeddedImage(payload, kind)", "\nfunction canvasMaterializeResultNodes("),
    cut("function canvasUpstreamInputs(node)", "\nfunction canvasUpstreamNodes("),
    cut("function canvasGenerationContext(node)", "\n// 参考图和首尾帧能收哪些后缀"),
    cut("// 参考图和首尾帧能收哪些后缀", "\nfunction canvasGenerationInputs("),
    cut("function canvasOutputFilename(", "\nfunction canvasDefaultPayload("),
    cut("const CANVAS_PROMPT_PLACEHOLDERS =", "\nasync function canvasLoadAssets("),
    cut("async function canvasGenerate(node, kind)", "\nfunction canvasBindNode("),
  ].join("\n");

  let sent = null, toast = "";
  const N = {};
  const mk = (id, kind, p) => (N[id] = { id, kind, p: { ...p }, set(_k, v) { Object.keys(this.p).forEach((k) => delete this.p[k]); Object.assign(this.p, v); } });
  const link = (from, to, rel) => ({ get: (k) => (k === "source" ? { id: from } : k === "target" ? { id: to } : k === "canvasRelation" ? rel : null) });
  const sandbox = {
    canvasState: { busy: new Set(), selected: null, graph: { links: [], getLinks() { return this.links; }, getCell: (id) => N[id] } },
    canvasKind: (n) => n.kind, canvasPayload: (n) => n.p,
    canvasNodeLabel: (n) => n.p.name || n.p.title || n.id,
    canvasLinkRelation: (l) => String(l.get("canvasRelation") || "input"),
    canvasRelationLabel: (r) => r,
    CANVAS_NODE_DEFS: { image: { label: "图片" }, video: { label: "视频" }, audio: { label: "声音" }, character: { label: "角色" }, location: { label: "场景" }, shot: { label: "镜头" } },
    canvasToast: (t) => { toast = String(t); },
    canvasRefreshNode() {}, canvasRenderInspector() {}, canvasPersist() {}, canvasUpsertResult() {},
    canvasRecordGeneration: (n, k, input, file) => ({ ...n.p, generation: { output: file } }),
    canvasResolvedFileName: (v) => v, previewFile: null,
    fetch: async (url, opt) => { sent = { url, body: JSON.parse(opt.body) }; return { ok: true, json: async () => ({ ok: true, file: "素材/镜头_新_首帧.png" }) }; },
  };
  const keys = Object.keys(sandbox);
  const gen = new Function(...keys, src + "\nreturn canvasGenerate;")(...keys.map((k) => sandbox[k]));
  const wire = (...links) => { sandbox.canvasState.graph.links = links; };
  const refsOf = () => (sent && sent.body.input.reference_images) || [];

  // ── ① 一部戏在画布上正常的样子：两个角色 + 一个场景 + 上一镜 ────────────────
  mk("c1", "character", { name: "阿岚", description: "十七岁，红衣", reference: "素材/角色_阿岚_定妆.png" });
  mk("c2", "character", { name: "老陈", description: "五十岁，灰袄", reference: "素材/角色_老陈_定妆.png" });
  mk("l1", "location", { name: "码头", description: "雾天清晨", image: "素材/场景_码头.png" });
  mk("s1", "shot", { id: "S1-01", first_frame: "素材/镜头_S1-01_首帧.png", video: "素材/镜头_S1-01.mp4", audio: "素材/配音_S1-01.mp3" });
  const s2 = mk("s2", "shot", { id: "S1-02", prompt: "阿岚回头看向老陈" });
  wire(link("c1", "s2", "character"), link("c2", "s2", "character"), link("l1", "s2", "background"), link("s1", "s2", "continuity"));
  sent = null;
  await gen(s2, "image");
  assert(sent && sent.body.tool === "generate_image", "没走生图那条：" + JSON.stringify(sent));
  const bad = refsOf().filter((r) => !/\.(png|jpe?g|webp|gif|bmp)$/i.test(r));
  assert(bad.length === 0,
    "★参考图里混进了不是图的东西★ 服务端会把整枪退回（tools.js：不是图片），这一镜的首帧根本生不出来："
    + JSON.stringify(bad));
  assert(refsOf().includes("素材/角色_阿岚_定妆.png") && refsOf().includes("素材/角色_老陈_定妆.png"),
    "★定妆照没被带进参考图★ 那前面那一档做得再绿也白做，每一镜的脸还是不是同一个人：" + JSON.stringify(refsOf()));
  assert(refsOf().includes("素材/场景_码头.png"), "场景图没被带上，景会一镜一个样：" + JSON.stringify(refsOf()));
  assert(refsOf().includes("素材/镜头_S1-01_首帧.png"),
    "上一镜连过来是为了接得上，它该交出那张首帧图（不是成片 mp4）：" + JSON.stringify(refsOf()));

  // ── ② 上一镜只有片子没有图：它一张都不贡献，但不许连累别人 ────────────────
  mk("s1b", "shot", { id: "S1-01b", video: "素材/镜头_S1-01b.mp4", audio: "素材/配音_S1-01b.mp3" });
  const s2b = mk("s2b", "shot", { id: "S1-02b", prompt: "接上一镜" });
  wire(link("s1b", "s2b", "continuity"), link("c1", "s2b", "character"));
  sent = null;
  await gen(s2b, "image");
  assert(sent, "★一个交不出图的上游把整枪堵死了★ 别人的定妆照还在，这一镜该照生：" + toast);
  assert(refsOf().length === 1 && refsOf()[0] === "素材/角色_阿岚_定妆.png",
    "上游交不出图就该跳过它，不是跟着一起报销：" + JSON.stringify(refsOf()));

  // ── ③ 四个位子不够分的时候，别让 .mp4 挤掉一张脸 ───────────────────────
  mk("c3", "character", { name: "小满", description: "十岁", reference: "素材/角色_小满_定妆.png" });
  mk("c4", "character", { name: "老板娘", description: "四十岁", reference: "素材/角色_老板娘_定妆.png" });
  const s4 = mk("s4", "shot", { id: "S2-01", prompt: "四个人挤在船舱里" });
  wire(link("s1", "s4", "continuity"), link("c1", "s4", "character"), link("c2", "s4", "character"),
    link("c3", "s4", "character"), link("c4", "s4", "character"));
  sent = null;
  await gen(s4, "image");
  assert(refsOf().length === 4, "参考图上限是 4 张（服务端超了就报错）：" + JSON.stringify(refsOf()));
  assert(refsOf().every((r) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(r)), "挤到最后还混进了非图：" + JSON.stringify(refsOf()));

  // ── ④ 生视频：没有首帧就说没有首帧，别拿定妆照顶着把钱花了 ────────────────
  const v1 = mk("v1", "shot", { id: "S1-03", prompt: "推进" });
  wire(link("c1", "v1", "character"), link("s1", "v1", "continuity"));
  sent = null; toast = "";
  await gen(v1, "video");
  assert(sent === null,
    "★拿手边第一张图当首帧就去生视频★ 那多半是角色的定妆照，生出来的片子跟这一镜没关系，钱照花："
    + JSON.stringify(sent && sent.body.input));
  assert(/首帧/.test(toast), "拦下来了却没说缺的是首帧：" + toast);

  // ── ⑤ 连线明写「首帧」的那个节点，身上有片子也得交出那张图 ────────────────
  mk("i1", "image", { title: "分镜草图", path: "素材/草图_S1-03.png" });
  const v2 = mk("v2", "shot", { id: "S1-04", prompt: "推进" });
  wire(link("c1", "v2", "character"), link("i1", "v2", "first_frame"));
  sent = null;
  await gen(v2, "video");
  assert(sent && sent.body.input.first_frame === "素材/草图_S1-03.png",
    "连线上明写着「首帧」，就该用它：" + JSON.stringify(sent && sent.body.input));

  const v3 = mk("v3", "shot", { id: "S1-05", prompt: "推进" });
  wire(link("s1", "v3", "first_frame"));
  sent = null;
  await gen(v3, "video");
  assert(sent && sent.body.input.first_frame === "素材/镜头_S1-01_首帧.png",
    "★把一个 .mp4 当首帧发出去了★ 服务端只收 png/jpg/webp/gif/bmp，这一枪会原地退回："
    + JSON.stringify(sent && sent.body.input));

  // ── ⑥ 上游挂着的图片节点，才是「连接一个参考图节点」那句话说的东西 ──────────
  const v4 = mk("v4", "shot", { id: "S1-06", prompt: "推进" });
  wire(link("c1", "v4", "character"), link("i1", "v4", "reference"));
  sent = null;
  await gen(v4, "video");
  assert(sent && sent.body.input.first_frame === "素材/草图_S1-03.png",
    "界面上写着「请先生成首帧或连接一个参考图节点」，那就得认这个图片节点，别认定妆照："
    + JSON.stringify(sent && sent.body.input));

  // ── ⑦ 节点自己填的 reference 不是图：也得在这儿拦住，别让服务端替我们发现 ────
  const s5 = mk("s5", "shot", { id: "S3-01", prompt: "夜戏", reference: "素材/镜头_S2-09.mp4" });
  wire(link("c1", "s5", "character"));
  sent = null;
  await gen(s5, "image");
  assert(!refsOf().includes("素材/镜头_S2-09.mp4"),
    "★节点上随手填的 .mp4 被当参考图发出去了★ 整枪退回，用户只会看见一句「不是图片」："
    + JSON.stringify(refsOf()));
  assert(refsOf().includes("素材/角色_阿岚_定妆.png"), "该留的那张反而没了：" + JSON.stringify(refsOf()));

  // ── ⑧ 客户端这条后缀口径必须跟服务端一个字不差 ──────────────────────────
  // 两边各写一份、字面不一样，就是「这边放行那边退回」的假绿：界面上看不出任何异常，
  // 钱花出去了才在 toast 里读到一句「不是图片」。
  {
    const clientLine = (fe.match(/const CANVAS_REF_IMAGE_EXT = (\/.+\/i);/) || [])[1];
    const serverLine = (fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8")
      .match(/const IMAGE_EXT = (\/.+\/i);/) || [])[1];
    assert(clientLine && serverLine, "两边的图片后缀表至少有一张找不着了：" + clientLine + " / " + serverLine);
    assert(clientLine === serverLine,
      "★画布收的图片后缀跟服务端不是一套★ 宽的那边会把服务端不认的文件发出去，整枪退回：\n"
      + "  app-07-canvas.js: " + clientLine + "\n  tools.js:         " + serverLine);
  }

  console.log("✅ 短剧镜头参考图：定妆照/场景图真的被带进生首帧那一枪 · 上一镜交的是它那张首帧图不是 .mp4（以前整枪被服务端退回，分镜一连起来后面全生不出来）· 交不出图的上游只跳过它不连累整枪 · 四张位子不被非图挤占 · 生视频的首帧不拿定妆照顶（宁可说「还没有首帧」也不花那笔钱）· 连线明写首帧的节点身上有片子也交图 · 客户端收的后缀跟服务端一个字不差");
}

async function testDramaVoice() {
  // 配音这一档以前漏了一件事：text_to_speech 那一枪只递 text，不递 voice。
  // 于是整部戏所有角色都用设置里那一个默认音色——十个镜头听下来是同一个人在自言自语。
  // 这种错没有任何一条会报红：文件生成了、进度条绿了、成片也拼出来了，
  // 要等到把片子放给人看才听得出来「怎么爷爷和小孙女是一个嗓子」。所以得在这儿钉住。
  const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
  const cut = (from, to) => {
    const a = fe.indexOf(from), b = fe.indexOf(to, a + 1);
    assert(a >= 0 && b > a, "抠不出这段代码（函数改名了？）：" + from);
    return fe.slice(a, b);
  };
  const src = [
    cut("function canvasMediaPath(payload)", "\nfunction canvasMediaMime("),
    cut("function canvasFileKind(name)", "\n/**"),
    cut("function canvasEmbeddedImage(payload, kind)", "\nfunction canvasMaterializeResultNodes("),
    cut("function canvasUpstreamInputs(node)", "\nfunction canvasUpstreamNodes("),
    cut("function canvasGenerationContext(node)", "\n// 参考图和首尾帧能收哪些后缀"),
    cut("// 参考图和首尾帧能收哪些后缀", "\n/**\n * 这一句台词该用谁的嗓子"),
    cut("/**\n * 这一句台词该用谁的嗓子", "\nfunction canvasGenerationInputs("),
    cut("function canvasOutputFilename(", "\nfunction canvasDefaultPayload("),
    cut("function canvasDefaultPayload(kind)", "\nfunction canvasZoom("),
    cut("const CANVAS_PROMPT_PLACEHOLDERS =", "\nasync function canvasLoadAssets("),
    cut("async function canvasGenerate(node, kind)", "\nfunction canvasBindNode("),
    cut("async function canvasRunPending(kind)", "\n/**\n * 合成成片"),
  ].join("\n");

  let sent = null, toast = "", focused = [];
  const N = {};
  // set 得换一个新对象，不能就地改：真的 JointJS 就是这么干的，
  // 而「一键补齐」正是拿 before !== after 判这一枪到底做成了没有
  const mk = (id, kind, p) => (N[id] = { id, kind, p: { ...p }, set(_k, v) { this.p = { ...v }; } });
  const link = (from, to, rel) => ({ get: (k) => (k === "source" ? { id: from } : k === "target" ? { id: to } : k === "canvasRelation" ? rel : null) });
  const sandbox = {
    canvasState: {
      busy: new Set(), selected: null, batch: null, progress: null,
      graph: { links: [], nodes: [], getLinks() { return this.links; }, getElements() { return this.nodes; }, getCell: (id) => N[id] },
    },
    canvasKind: (n) => n.kind, canvasPayload: (n) => n.p,
    canvasNodeLabel: (n) => n.p.name || n.p.title || n.id,
    canvasLinkRelation: (l) => String(l.get("canvasRelation") || "input"),
    canvasRelationLabel: (r) => r,
    CANVAS_NODE_DEFS: { image: { label: "图片" }, video: { label: "视频" }, audio: { label: "声音" }, character: { label: "角色" }, location: { label: "场景" }, shot: { label: "镜头" } },
    canvasToast: (t) => { toast = String(t); },
    canvasRefreshNode() {}, canvasRenderInspector() {}, canvasPersist() {}, canvasUpsertResult() {},
    canvasRenderProgress() {}, canvasLoadProgress: async () => {}, canvasLoadLibrary() {},
    canvasProgressFocus: (ids) => { focused = (ids || []).map(String); },
    canvasRecordGeneration: (n, k, input, file) => ({ ...n.p, generation: { output: file } }),
    canvasResolvedFileName: (v) => v, previewFile: null,
    canvasUpstreamImages: () => [],
    fetch: async (url, opt) => { sent = { url, body: JSON.parse(opt.body) }; return { ok: true, json: async () => ({ ok: true, file: "素材/配音_" + Math.random().toString(36).slice(2, 7) + ".mp3" }) }; },
  };
  const keys = Object.keys(sandbox);
  const made = new Function(...keys, src + "\nreturn { canvasGenerate, canvasRunPending, canvasResolveVoice, canvasDefaultPayload };")(...keys.map((k) => sandbox[k]));
  const gen = made.canvasGenerate;
  const wire = (...links) => { sandbox.canvasState.graph.links = links; };
  const voiceOf = () => (sent && sent.body.input && sent.body.input.voice);

  mk("c1", "character", { id: "A", name: "阿岚", description: "十七岁，红衣", voice: "Cherry" });
  mk("c2", "character", { id: "B", name: "老陈", description: "五十岁，灰袄", voice: "Serena" });
  mk("c3", "character", { id: "C", name: "小满", description: "十岁" });

  // ── ① 一个角色，一个音色：这句台词得用它的嗓子 ──────────────────────────
  const a1 = mk("a1", "shot", { id: "S1-01", prompt: "阿岚回头", line: "你到底要不要走" });
  wire(link("c1", "a1", "character"));
  sent = null; toast = "";
  await gen(a1, "audio");
  assert(sent && sent.body.tool === "text_to_speech", "没走配音那条：" + JSON.stringify(sent));
  assert(voiceOf() === "Cherry",
    "★配音没带音色★ 整部戏所有角色共用设置里那一个默认嗓子，而且一路都是绿的，要等成片放出来才听得出："
    + JSON.stringify(sent.body.input));
  assert(sent.body.input.text === "你到底要不要走", "念的应该是这一镜的台词：" + JSON.stringify(sent.body.input));

  // ── ② 两个角色，音色不一样，又没说是谁在讲：不许替用户挑 ──────────────────
  const a2 = mk("a2", "shot", { id: "S1-02", prompt: "对峙", line: "我不走" });
  wire(link("c1", "a2", "character"), link("c2", "a2", "character"));
  sent = null; toast = "";
  await gen(a2, "audio");
  assert(sent === null,
    "★两个角色音色不同，却自己挑了一个★ 挑错了声音还是好声音，只是不是这个人的——这种错只有放片子才发现："
    + JSON.stringify(sent && sent.body.input));
  assert(/说话的角色/.test(toast), "拦下来了却没说该去哪儿点名：" + toast);

  // ── ③ 一个定了音色、另一个还没定：一样算岔路 ───────────────────────────
  // 「没定音色」不是「没有候选」，它代表用默认音色——跟 Cherry 是两个不一样的结果
  const a3 = mk("a3", "shot", { id: "S1-03", prompt: "两个人", line: "走吧" });
  wire(link("c1", "a3", "character"), link("c3", "a3", "character"));
  sent = null; toast = "";
  await gen(a3, "audio");
  assert(sent === null, "一个定了一个没定，结果照样是两种嗓子，不能自己挑：" + JSON.stringify(sent && sent.body.input));

  // ── ④ 点了名就按点名的来（名字 / 分镜表里的角色 id 都认） ─────────────────
  const a4 = mk("a4", "shot", { id: "S1-04", prompt: "对峙", line: "我不走", speaker: "老陈" });
  wire(link("c1", "a4", "character"), link("c2", "a4", "character"));
  sent = null; toast = "";
  await gen(a4, "audio");
  assert(voiceOf() === "Serena", "点名了就该用点名那个人的音色：" + JSON.stringify(sent && sent.body.input) + " / " + toast);

  const a5 = mk("a5", "shot", { id: "S1-05", prompt: "对峙", line: "我不走", speaker: "B" });
  wire(link("c1", "a5", "character"), link("c2", "a5", "character"));
  sent = null; toast = "";
  await gen(a5, "audio");
  assert(voiceOf() === "Serena",
    "分镜表里 speaker 写的是角色短 id（A/B），展开到画布上也得认：" + JSON.stringify(sent && sent.body.input) + " / " + toast);

  // ── ⑤ 点了名，可连上来的角色里没这个人：停下，别拿在场另一个人的嗓子顶 ──────
  const a6 = mk("a6", "shot", { id: "S1-06", prompt: "对峙", line: "我不走", speaker: "小满" });
  wire(link("c1", "a6", "character"), link("c2", "a6", "character"));
  sent = null; toast = "";
  await gen(a6, "audio");
  assert(sent === null, "★点名的人不在场，却拿别人的嗓子念了★ 等于把这句台词换了个人说：" + JSON.stringify(sent && sent.body.input));
  assert(/小满/.test(toast), "该把点错的那个名字念回来，不然不知道哪儿写错了：" + toast);

  // ── ⑥ 「展开分镜表」生出来的画布：镜头带着 speaker，但一个角色节点都没连 ────
  // 这时候 speaker 只是一条从分镜表抄过来的备注，没有谁跟谁要分辨。
  // 在这儿报错等于把展开出来的整张画布堵死，一句配音都生不出来。
  const a7 = mk("a7", "shot", { id: "S1-07", prompt: "独白", line: "天亮了", speaker: "A" });
  wire();
  sent = null; toast = "";
  await gen(a7, "audio");
  assert(sent, "★没连角色节点就一句都不给生★ 刚展开的分镜表画布会整个堵死：" + toast);
  assert(!("voice" in sent.body.input), "没人定音色的时候不该硬塞一个：" + JSON.stringify(sent.body.input));

  // ── ⑦ 节点自己写死的音色优先（画布 Agent / 声音节点都是这么写的） ───────────
  const a8 = mk("a8", "audio", { title: "旁白", text: "三年后。", voice: "nova" });
  wire(link("c1", "a8", "character"), link("c2", "a8", "character"));
  sent = null; toast = "";
  await gen(a8, "audio");
  assert(voiceOf() === "nova", "节点自己写死的音色最大，连上游都不用看：" + JSON.stringify(sent && sent.body.input) + " / " + toast);

  // ── ⑧ 起手模板里那句占位文字：三种素材节点都不许直接开枪 ──────────────────
  // 这几个节点的面板上就摆着「生成…」按钮，一按就是真花钱，买回来一句「对白、旁白或音乐说明…」
  const def = made.canvasDefaultPayload;
  for (const [kind, gk] of [["image", "image"], ["video", "video"], ["audio", "audio"]]) {
    const n = mk("ph-" + kind, kind, def(kind));
    wire();
    sent = null; toast = "";
    await gen(n, gk);
    assert(sent === null, `★${kind} 节点的占位文案原样就发出去了★ 这一枪照样花钱：` + JSON.stringify(sent && sent.body.input));
    assert(/占位文字/.test(toast), "拦下来了却没说是占位文字：" + toast);
  }

  // ── ⑨ 一键补齐配音：说不清谁在讲的那几个摘出来，其余照跑，最后一起说 ────────
  const runPending = made.canvasRunPending;
  const okShot = mk("b1", "shot", { id: "S2-01", prompt: "阿岚独白", line: "我知道了" });
  const askShot = mk("b2", "shot", { id: "S2-02", prompt: "两个人", line: "你说什么" });
  sandbox.canvasState.graph.nodes = [okShot, askShot];
  sandbox.canvasState.progress = { shots: [
    { nodeId: "b1", needsVoice: true, audio: null, frame: { ok: true } },
    { nodeId: "b2", needsVoice: true, audio: null, frame: { ok: true } },
  ] };
  wire(link("c1", "b1", "character"), link("c1", "b2", "character"), link("c2", "b2", "character"));
  sent = null; toast = ""; focused = [];
  await runPending("audio");
  assert(okShot.p.audio, "★一个说不清的镜头把整批配音都堵死了★ 二十镜里有一镜没点名，另外十九镜也别想做：" + toast);
  assert(/1 个做好了/.test(toast), "能生的那一镜得真算进「做好了」里：" + toast);
  assert(/1 个不知道该用谁的嗓子/.test(toast),
    "★摘出来了却没说★ 用户只看见「1 个做好了」，剩下那一镜凭空消失，进度条永远差一格：" + toast);
  assert(focused.includes("b2"), "说了有镜头卡住就得能点过去，不然等于没说：" + JSON.stringify(focused));

  // ── ⑩ 客户端发的键名跟服务端收的必须是同一个 ──────────────────────────
  // 这一条不钉住，服务端改个参数名就是典型的假绿：接口照样 200、文件照样落盘，
  // 只是音色被悄悄忽略了，所有角色又变回同一个嗓子，而且没有任何一条会红。
  {
    const srv = fs.readFileSync(path.join(__dirname, "..", "tools.js"), "utf8");
    const schema = srv.slice(srv.indexOf('name: "text_to_speech"'), srv.indexOf('name: "text_to_speech"') + 1200);
    assert(/voice: \{ type: "string"/.test(schema), "text_to_speech 的 schema 里没有 voice 了（客户端还在发）：" + schema.slice(0, 200));
    assert(/const voice = String\(input\.voice \|\| cfg\.voice \|\| ""\)/.test(srv),
      "服务端不再从 input.voice 取音色了，画布发过去的那个键会被静静吃掉");
    assert(/\.\.\.\(voice \? \{ voice \} : \{\}\)/.test(fe),
      "客户端发的键名得是 voice（跟服务端 schema 一个字不差）");
  }

  console.log("✅ 短剧配音音色：台词按角色的音色念（以前整部戏一个嗓子，绿着跑完、放片子才听出来）· 两个角色音色不同不替用户挑 · 点名认名字也认分镜表的角色 id · 点错名不拿在场另一个人顶 · 刚展开的分镜表没连角色也不堵死 · 一键补齐把说不清的摘出来单说并能点过去 · 三种素材节点的占位文案不许直接开枪 · 客户端发的 voice 跟服务端收的一个字不差");
}

async function testDramaBoardExpand() {
  // 「展开场次与镜头」是分镜表进画布的唯一一道门。以前这道门只摆场次和镜头：
  //   · characters[] 一个节点都不建 —— 而角色节点是定妆照、参考图、音色三条链子唯一的挂点。
  //     于是展开出来的戏，每一镜生首帧都没有参考图（同一个人一镜一个样），
  //     每一句台词都用设置里那个默认音色（全剧一个嗓子）。
  //   · shot 原样铺开 —— 分镜表写的是 frame_prompt / motion_prompt，画布上的镜头读的是 prompt，
  //     所以每一镜的 prompt 都还是起手模板那句「镜头内容与运动…」。「制片进度」把整部戏判成
  //     「没写提示词」，一键补齐一个都不做。
  // 这两件事都不报错：按钮变成「已展开 3 场」，屏幕上满满都是节点，人得自己一个个点开才发现点不动。
  const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
  const cut = (from, to) => {
    const a = fe.indexOf(from), b = fe.indexOf(to, a + 1);
    assert(a >= 0 && b > a, "抠不出这段代码（函数改名了？）：" + from);
    return fe.slice(a, b);
  };
  const src = [
    cut("function canvasMediaPath(payload)", "\nfunction canvasMediaMime("),
    cut("function canvasFileKind(name)", "\n/**"),
    cut("function canvasEmbeddedImage(payload, kind)", "\nfunction canvasMaterializeResultNodes("),
    cut("function canvasUpstreamInputs(node)", "\nfunction canvasUpstreamNodes("),
    cut("function canvasGenerationContext(node)", "\n// 参考图和首尾帧能收哪些后缀"),
    cut("// 参考图和首尾帧能收哪些后缀", "\n/**\n * 这一句台词该用谁的嗓子"),
    cut("/**\n * 这一句台词该用谁的嗓子", "\nfunction canvasGenerationInputs("),
    cut("function canvasOutputFilename(", "\nfunction canvasDefaultPayload("),
    cut("function canvasDefaultPayload(kind)", "\nfunction canvasZoom("),
    cut("const CANVAS_PROMPT_PLACEHOLDERS =", "\nasync function canvasLoadAssets("),
    cut("async function canvasGenerate(node, kind)", "\nfunction canvasBindNode("),
    cut("/**\n * 分镜表 → 画布上摆什么", "\nfunction canvasAddNode("),
    // 存盘那道批量闸门要用真的：拿桩子去测桩子，改坏了也是绿的
    cut("function canvasPersist()", "\nfunction canvasLoadSaved("),
  ].join("\n");

  // 一份真按 references/分镜表.schema.json 写的分镜表：两个角色各有音色和定妆照，
  // 三镜分别是「只有 A」「A 和 B 都在」「点了个表里没有的 C」
  const board = {
    title: "最后一班车", aspect: "9:16", style: "冷蓝夜色，胶片颗粒，浅景深",
    characters: [
      { id: "A", name: "阿岚", look: "十七岁女生，齐肩黑发，红色校服外套", ref: "角色_阿岚_定妆.png", voice: "Cherry" },
      { id: "B", name: "老陈", look: "五十岁男人，灰色棉袄，右手戴旧手表", ref: "角色_老陈_定妆.png", voice: "Serena" },
    ],
    scenes: [{
      id: "S1", place: "末班公交站", time: "冬夜",
      shots: [
        { id: "S1-01", cast: ["A"], shot_size: "近景", frame_prompt: "阿岚站在站牌下，侧脸被路灯照亮", motion_prompt: "她缓缓抬头，镜头轻微推进", line: "你到底要不要走", speaker: "A" },
        { id: "S1-02", cast: ["A", "B"], shot_size: "中景", frame_prompt: "两人隔着半米对站", motion_prompt: "镜头横移半步", line: "我不走", speaker: "B" },
        { id: "S1-03", cast: ["C"], shot_size: "全景", frame_prompt: "空荡的街", motion_prompt: "固定机位" },
      ],
    }],
  };

  let sent = null, toast = "", saves = 0, history = 0, seq = 0, realPersist = () => {}, addBoom = false;
  const N = {}, links = [], added = [];
  const link = (from, to, rel) => ({ get: (k) => (k === "source" ? { id: from } : k === "target" ? { id: to } : k === "canvasRelation" ? rel : null) });
  const sandbox = {
    canvasState: {
      // suspendSync：真 canvasPersist 后半段是往服务端回写，这儿只关心「存了几次盘、记了几步撤销」
      bulk: false, suspendSync: true, busy: new Set(), selected: null, batch: null, progress: null,
      graph: { getLinks: () => links, getElements: () => Object.values(N), getCell: (id) => N[id] },
    },
    canvasSnapshot: () => ({ nodes: [], edges: [] }),
    canvasStorageKey: () => "owb-canvas:test",
    canvasHistorySchedule: () => { history++; },
    localStorage: { setItem() { saves++; }, getItem: () => null },
    window: { setTimeout: () => 0 },
    canvasKind: (n) => n.kind, canvasPayload: (n) => n.p,
    canvasNodeLabel: (n) => n.p.name || n.p.title || n.id,
    canvasLinkRelation: (l) => String(l.get("canvasRelation") || "input"),
    canvasRelationLabel: (r) => r,
    CANVAS_NODE_DEFS: { image: { label: "图片" }, video: { label: "视频" }, audio: { label: "声音" }, character: { label: "角色" }, location: { label: "场景" }, shot: { label: "镜头" }, scene: { label: "场次" } },
    canvasToast: (t) => { toast = String(t); },
    canvasRefreshNode() {}, canvasRenderInspector() {}, canvasUpsertResult() {},
    canvasRenderProgress() {}, canvasLoadProgress: async () => {}, canvasLoadLibrary() {},
    canvasProgressFocus() {},
    canvasRecordGeneration: (n, k, input, file) => ({ ...n.p, generation: { output: file } }),
    canvasResolvedFileName: (v) => v, previewFile: null,
    canvasUpstreamImages: () => [],
    canvasAddNode: null, canvasConnect: null,
    fetch: async (url, opt) => { sent = { url, body: JSON.parse(opt.body) }; return { ok: true, json: async () => ({ ok: true, file: "素材/out_" + (++seq) + ".bin" }) }; },
  };
  // 建节点、连线都走真的那条路会用到 joint / DOM，这儿只记账；
  // 但 payload 必须按真的来：canvasDefaultPayload 打底 + 展开给的字段覆盖，
  // 少了这一层，「展开出来的镜头 prompt 还是起手模板那句」这条根本测不出来。
  const defaults = {};
  sandbox.canvasAddNode = (kind, payload, position, options) => {
    // 这个开关得在桩子内部读：参数是构造那一刻绑死的，事后换 sandbox.canvasAddNode 根本不生效
    if (addBoom) throw new Error("摆节点的时候炸了");
    const id = "n" + (++seq);
    added.push({ id, kind, payload, position, options });
    realPersist();   // 真的 canvasAddNode 在 persist !== false 时会存盘，这儿照走那条真路
    return (N[id] = { id, kind, p: { ...(defaults[kind] || {}), ...payload }, set(_k, v) { this.p = { ...v }; } });
  };
  sandbox.canvasConnect = (a, b, rel) => { if (!a || !b) return; links.push(link(a.id, b.id, rel || "input")); realPersist(); };

  const keys = Object.keys(sandbox);
  const made = new Function(...keys, src + "\nreturn { canvasBoardPlan, canvasApplyBoardPlan, canvasGenerate, canvasResolveVoice, canvasDefaultPayload, canvasPersist };")(...keys.map((k) => sandbox[k]));
  realPersist = made.canvasPersist;
  for (const k of ["character", "scene", "shot"]) defaults[k] = made.canvasDefaultPayload(k);

  // ── ① 分镜表里的角色得变成画布上的角色节点 ────────────────────────────────
  const plan = made.canvasBoardPlan(board);
  assert(plan.characters.length === 2,
    "★分镜表里的角色一个节点都没摆★ 角色节点是定妆照 / 参考图 / 音色唯一的挂点，没有它这部戏每一镜都没有参考图、每句台词都是同一个默认嗓子："
    + JSON.stringify(plan.characters));
  const lan = plan.characters[0].payload;
  assert(lan.name === "阿岚" && lan.voice === "Cherry" && lan.reference === "角色_阿岚_定妆.png",
    "角色身上的 name / voice / ref 没落到画布认得的字段上：" + JSON.stringify(lan));
  assert(lan.description === "十七岁女生，齐肩黑发，红色校服外套",
    "★look 没落进人物设定★ 空着的话角色节点上那颗「生成定妆照」会拒跑（只有名字生出来的脸每次都不是同一个人）：" + JSON.stringify(lan));

  // ── ② frame_prompt 要落到画布的 prompt 上，还要带上全片画风 ────────────────
  const shots = plan.scenes[0].shots;
  assert(shots.length === 3, "镜头数不对：" + shots.length);
  assert(/阿岚站在站牌下/.test(shots[0].payload.prompt),
    "★frame_prompt 没落到 prompt 上★ 画布上的镜头只读 prompt，落不进去就等于这一镜没提示词："
    + JSON.stringify(shots[0].payload.prompt));
  assert(/冷蓝夜色，胶片颗粒，浅景深/.test(shots[0].payload.prompt),
    "★全片画风没跟着每一镜走★ 不带上镜与镜之间画风会飘（skill 第 1 节写死的规矩）：" + JSON.stringify(shots[0].payload.prompt));
  assert(shots[0].payload.motion_prompt === "她缓缓抬头，镜头轻微推进",
    "★motion_prompt 丢了★ 原样铺开的话它存在 payload 里没人读、面板上也看不见，等于用户写的运镜白写了："
    + JSON.stringify(shots[0].payload));

  // ── ③ 反向对照：不做映射的话，展开出来的每一镜都是「没写提示词」 ─────────────
  const raw = { ...defaults.shot, ...board.scenes[0].shots[0] };   // 以前那版：{...shot} 原样铺开
  const placeholders = made.canvasBoardPlan.toString() && (() => {
    const m = fe.match(/const CANVAS_PROMPT_PLACEHOLDERS = (\[[^\]]*\]);/);
    assert(m, "找不到占位文案表");
    return JSON.parse(m[1].replace(/'/g, '"'));
  })();
  assert(placeholders.includes(raw.prompt),
    "反向对照失效了：原样铺开时 prompt 本该还是起手模板那句（这条一旦恒假，②就成了摆设）：" + JSON.stringify(raw.prompt));
  assert(!placeholders.includes(shots[0].payload.prompt), "映射之后 prompt 不该还是占位文案");

  // ── ④ 摆到画布上：角色、场次、镜头都建了，cast 点到的角色真连了线 ────────────
  const boardNode = N.b1 = { id: "b1", kind: "storyboard", p: { board: "最后一班车" }, set() {}, position: () => ({ x: 90, y: 100 }) };
  saves = 0; history = 0;
  const stat = made.canvasApplyBoardPlan(boardNode, plan);
  assert(stat.characters === 2 && stat.scenes === 1 && stat.shots === 3, "摆出来的数目不对：" + JSON.stringify(stat));
  const shotNodes = added.filter((a) => a.kind === "shot").map((a) => N[a.id]);
  const charNodes = added.filter((a) => a.kind === "character").map((a) => N[a.id]);
  assert(charNodes.length === 2 && added.filter((a) => a.kind === "scene").length === 1, "节点种类摆错了：" + added.map((a) => a.kind).join("/"));
  const up = (n) => links.filter((l) => l.get("target").id === n.id).map((l) => l.get("source").id);
  assert(up(shotNodes[0]).includes(charNodes[0].id),
    "★cast 里点了角色，画布上却没连线★ 参考图和音色都是顺着连线找过去的，没线等于这一镜没有角色："
    + JSON.stringify(up(shotNodes[0])));
  assert(up(shotNodes[1]).includes(charNodes[0].id) && up(shotNodes[1]).includes(charNodes[1].id),
    "两个人都在场的那一镜没把两个角色都连上：" + JSON.stringify(up(shotNodes[1])));
  assert(!up(shotNodes[0]).includes(charNodes[1].id),
    "★没出场的角色也连上去了★ 那一镜生首帧会拿错人的定妆照当参考图，四个位子本来就不够分：" + JSON.stringify(up(shotNodes[0])));

  // ── ⑤ cast 写了个表里没有的角色 id：摘出来说，不悄悄吞 ─────────────────────
  assert(stat.missing.join() === "C",
    "★分镜表里点了个 characters 里查无此人的角色，却没人吭声★ 那一镜会安静地少参考图少音色，"
    + "等十二镜都生完、发现人一镜一个样才看得出来：" + JSON.stringify(stat.missing));

  // ── ⑥ 手写的 cast 多半写名字，不写 id ─────────────────────────────────────
  const byName = made.canvasBoardPlan({
    characters: [{ id: "A", name: "阿岚", look: "红衣", voice: "Cherry" }],
    scenes: [{ id: "S1", shots: [{ id: "S1-01", cast: ["阿岚"], frame_prompt: "x" }] }],
  });
  const n2 = { id: "b2", kind: "storyboard", p: {}, set() {} };
  const before = links.length;
  const stat2 = made.canvasApplyBoardPlan(n2, byName);
  assert(stat2.missing.length === 0, "★写名字就连不上了★ 人手动补 cast 的时候写的是名字不是 id：" + JSON.stringify(stat2.missing));
  assert(links.slice(before).some((l) => l.get("canvasRelation") === "character"), "角色连到镜头的那条线没标成「人物身份」：连线用途是生首帧挑参考图的依据");

  // ── ⑦ 一次展开只存一次盘，而且这个开关一定复位 ─────────────────────────────
  assert(saves === 0 && history === 0,
    "★摆几十个节点就整图序列化存盘几十次★ 十二镜的戏光展开这一下就要跑六十来趟，"
    + `顺带把撤销记成六十步（人想退回展开前得按六十次 ⌘Z）：存盘 ${saves} 次、记了 ${history} 步撤销`);
  // 反向对照：闸门关掉之后这条路真的会存盘（不然上面那条是恒真的）
  sandbox.canvasState.bulk = false; realPersist();
  assert(saves === 1 && history === 1, "反向对照失效：不在批量里的一次 canvasPersist 本该真存一次盘、记一步撤销");
  assert(sandbox.canvasState.bulk === false, "★批量开关没复位★ 之后画布上做的任何改动都不再存盘，关掉浏览器全没了");
  let threw = false;
  addBoom = true;
  try { made.canvasApplyBoardPlan(boardNode, plan); } catch { threw = true; }
  addBoom = false;
  assert(threw, "桩子没炸，这一条等于没测");
  assert(sandbox.canvasState.bulk === false,
    "★摆到一半出错，批量开关就永久留在开着★ 从此这块画布上做的任何改动都不再存盘，"
    + "人照常拖节点、照常填字，关掉页面才发现今天白干了");

  // ── ⑧ 展开出来的镜头，音色真能定得出来（①⑤ 串起来才算数） ─────────────────
  const v1 = made.canvasResolveVoice(shotNodes[0], shotNodes[0].p);
  assert(!v1.error && v1.voice === "Cherry",
    "★展开出来的镜头配音还是默认嗓子★ 这才是这一条链子要的东西：" + JSON.stringify(v1));
  const v2 = made.canvasResolveVoice(shotNodes[1], shotNodes[1].p);
  assert(!v2.error && v2.voice === "Serena",
    "两个人在场、分镜表点了 speaker=B 的那一镜，音色该是老陈的：" + JSON.stringify(v2));

  // ── ⑨ 生视频只递运镜，不把首帧提示词再递一遍 ───────────────────────────────
  shotNodes[0].p.first_frame = "素材/镜头_S1-01_首帧.png";
  sent = null; toast = "";
  await made.canvasGenerate(shotNodes[0], "video");
  assert(sent && sent.body.tool === "generate_video", "没走生视频那条：" + JSON.stringify(sent));
  assert(/她缓缓抬头，镜头轻微推进/.test(sent.body.input.prompt), "运镜提示词没递过去：" + JSON.stringify(sent.body.input.prompt));
  assert(!/阿岚站在站牌下/.test(sent.body.input.prompt),
    "★把首帧提示词又递了一遍★ 画面内容已经在首帧里了，再描述一遍模型会照着它重画，"
    + "生出来的片子跟你刚确认过的那张首帧对不上（skill 第 4 节）：" + JSON.stringify(sent.body.input.prompt));

  // ── ⑩ 空表不许炸，也不许假装摆了东西 ──────────────────────────────────────
  const empty = made.canvasBoardPlan(null);
  assert(empty.characters.length === 0 && empty.scenes.length === 0, "空分镜表该是空计划：" + JSON.stringify(empty));

  console.log("✅ 短剧分镜表展开：角色也摆上画布（以前只有场次和镜头，整部戏没参考图、一个嗓子）· frame_prompt 落到 prompt 并带上全片画风（以前每一镜都判「没写提示词」，一键补齐一个不做）· 运镜单独一格且生视频只递它 · cast 按 id 也按名字连线、查无此人的点名单独报 · 一次展开只存一次盘且开关必复位 · 展开出来的镜头音色当场定得出来");
}

/**
 * 画布生出来的东西，回不回得到分镜表里。
 *
 * 技能里写死了「分镜表是唯一真源……产物路径全部回写进分镜表——它是下次改一镜重跑的依据」，
 * server.js 顶上那段注释也写着「镜头单格重跑产生的路径也会立刻回到唯一真源里」。
 * 可画布那一头一直只读不写：在画布上把十二镜的首帧和视频全生完，盘上那份分镜表里
 * 一个路径都没有。这件事全程没有一条红——画布上缩略图都出来了，人以为做完了。
 * 代价在别处收：
 *   · 短剧页每张卡还写着「暂无首帧」，人照着点「重跑首帧」，十二镜再买一遍（那条路关着缓存）；
 *   · 命令行 / Agent 那条「改一镜只重算一镜」读的也是这份 JSON，它看到的是一部没开工的戏；
 *   · 定妆照落不进 characters[].ref，短剧页那头重跑首帧就没有参考图，人一镜一个样。
 *
 * 所以这条分两头钉：客户端有没有发出那一笔回写、服务端有没有把它真写到盘上那一个字段里。
 */
async function testDramaBoardWriteback() {
  const os = require("os");
  const http = require("http");
  const crypto = require("crypto");

  // ══ 前半场：客户端 ══════════════════════════════════════════════════════
  const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-canvas.js"), "utf8");
  const cut = (from, to) => {
    const a = fe.indexOf(from), b = fe.indexOf(to, a + 1);
    assert(a >= 0 && b > a, "抠不出这段代码（函数改名了？）：" + from);
    return fe.slice(a, b);
  };
  const src = [
    cut("function canvasMediaPath(payload)", "\nfunction canvasMediaMime("),
    cut("function canvasFileKind(name)", "\n/**"),
    cut("function canvasEmbeddedImage(payload, kind)", "\nfunction canvasMaterializeResultNodes("),
    cut("function canvasUpstreamInputs(node)", "\nfunction canvasGenerationContext("),
    cut("function canvasGenerationContext(node)", "\n// 参考图和首尾帧能收哪些后缀"),
    cut("// 参考图和首尾帧能收哪些后缀", "\n/**\n * 这一句台词该用谁的嗓子"),
    cut("/**\n * 这一句台词该用谁的嗓子", "\nfunction canvasGenerationInputs("),
    cut("function canvasOutputFilename(", "\nfunction canvasDefaultPayload("),
    cut("function canvasDefaultPayload(kind)", "\nfunction canvasZoom("),
    cut("const CANVAS_PROMPT_PLACEHOLDERS =", "\nasync function canvasLoadAssets("),
    // 回写那个函数跟 canvasGenerate 挨着，一刀抠俩：用真的，拿桩子测桩子等于没测
    cut("/**\n * 在画布上给一镜多连一个角色", "\nfunction canvasBindNode("),
    cut("/**\n * 分镜表 → 画布上摆什么", "\nfunction canvasAddNode("),
  ].join("\n");

  const board = {
    title: "最后一班车", aspect: "9:16", style: "冷蓝夜色，胶片颗粒",
    characters: [
      { id: "A", name: "阿岚", look: "十七岁女生，齐肩黑发", ref: "", voice: "Cherry" },
      { id: "B", name: "老陈", look: "五十岁男人，灰色棉袄", ref: "", voice: "Serena" },
    ],
    scenes: [{
      id: "S1", place: "末班公交站", time: "冬夜",
      shots: [
        { id: "S1-01", cast: ["A"], shot_size: "近景", frame_prompt: "阿岚站在站牌下", motion_prompt: "镜头轻微推进", line: "你到底要不要走", speaker: "A" },
        { id: "S1-02", cast: ["A", "B"], shot_size: "中景", frame_prompt: "两人隔着半米对站", motion_prompt: "镜头横移半步", line: "我不走", speaker: "B" },
      ],
    }],
  };
  const BOARD_NAME = "分镜表/最后一班车.json";

  let calls = [], toast = "", seq = 0, fetchMode = "ok";
  const N = {}, links = [];
  const sandbox = {
    canvasState: { bulk: false, suspendSync: true, busy: new Set(), selected: null, batch: null, progress: null,
      graph: { getLinks: () => links, getElements: () => Object.values(N), getCell: (id) => N[id] } },
    canvasPersist() {}, canvasKind: (n) => n.kind, canvasPayload: (n) => n.p,
    canvasNodeLabel: (n) => n.p.name || n.p.title || n.id,
    canvasLinkRelation: (l) => String(l.get("canvasRelation") || "input"),
    canvasRelationLabel: (r) => r,
    CANVAS_NODE_DEFS: { image: { label: "图片" }, video: { label: "视频" }, audio: { label: "声音" }, character: { label: "角色" }, location: { label: "场景" }, shot: { label: "镜头" }, scene: { label: "场次" } },
    canvasToast: (t) => { toast = String(t); },
    canvasRefreshNode() {}, canvasRenderInspector() {}, canvasUpsertResult() {},
    canvasRenderProgress() {}, canvasLoadProgress: async () => {}, canvasLoadLibrary() {},
    canvasProgressFocus() {},
    canvasRecordGeneration: (n, k, input, file) => ({ ...n.p, generation: { output: file } }),
    canvasResolvedFileName: (v) => v, previewFile: null,
    canvasUpstreamImages: () => [],
    canvasAddNode: () => null, canvasConnect: () => {},
    fetch: async (url, opt) => {
      const body = JSON.parse(opt.body);
      calls.push({ url, body });
      if (String(url).includes("/api/drama/storyboard/output")) {
        if (fetchMode === "boom") throw new Error("网络断了");
        if (fetchMode === "reject") return { ok: false, status: 404, json: async () => ({ error: "分镜表里没有镜头 S9-99" }) };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, file: "素材/out_" + (++seq) + ".png" }) };
    },
  };
  const keys = Object.keys(sandbox);
  const made = new Function(...keys, src + "\nreturn { canvasBoardPlan, canvasBoardWriteback, canvasBoardContentSync, canvasBoardCastOf, canvasBoardCastSync, canvasGenerate, canvasDefaultPayload };")(...keys.map((k) => sandbox[k]));
  const defaults = {}; for (const k of ["character", "shot"]) defaults[k] = made.canvasDefaultPayload(k);
  const mk = (kind, payload) => (N["n" + (++seq)] = { id: "n" + seq, kind, p: { ...(defaults[kind] || {}), ...payload }, set(_k, v) { this.p = { ...v }; } });
  const backCalls = () => calls.filter((c) => String(c.url).includes("/api/drama/storyboard/output"));

  // ── ① 展开的时候就得盖戳，不然生成完了根本不知道该往哪一镜回写 ──────────────
  const plan = made.canvasBoardPlan(board, BOARD_NAME);
  const s1 = plan.scenes[0].shots[0].payload;
  assert(s1.board === BOARD_NAME && s1.board_scene === "S1" && s1.board_shot === "S1-01",
    "★展开出来的镜头身上没盖分镜表的戳★ 没有它，这一镜生出来的首帧回不到唯一真源里，短剧页那头会让人再买一遍："
    + JSON.stringify({ board: s1.board, scene: s1.board_scene, shot: s1.board_shot }));
  assert(plan.characters[0].payload.board === BOARD_NAME && plan.characters[0].payload.board_character === "A",
    "★角色身上没盖戳★ 定妆照回不进 characters[].ref，短剧页重跑首帧就没有参考图，人一镜一个样："
    + JSON.stringify(plan.characters[0].payload));
  // 反向对照：不是从分镜表展开来的（手搓节点）就不许平白多出这几个字段，
  // 否则它们会带着一个空的 board 名去敲接口，每生成一次弹一条红
  const bare = made.canvasBoardPlan(board).scenes[0].shots[0].payload;
  assert(!("board" in bare) && !("board_shot" in bare), "没给分镜表名的时候不该盖戳：" + JSON.stringify(bare));
  // 上面两条测的是这个纯函数收到名字会盖戳，可真正把名字递进去的是「展开场次与镜头」那颗按钮。
  // 那一句写成 canvasBoardPlan(r.data) 少一个参数，整张展开出来的画布就一个戳都没有，
  // 而上面几条照样全绿——这种改法只能钉在源码上
  const planCalls = (fe.match(/canvasBoardPlan\([^)]*\)/g) || []).filter((c) => !/^canvasBoardPlan\(data/.test(c));
  assert(planCalls.length >= 1 && planCalls.every((c) => c.includes(",")),
    "★画布里有地方调 canvasBoardPlan 没把分镜表名递进去★ 那条路展开出来的节点一个戳都没有，生成完回不到真源，短剧页会让人再买一遍："
    + JSON.stringify(planCalls));

  // ── ② 镜头首帧：生成之后真发出那一笔回写，写的是 first_frame ──────────────
  const shot = mk("shot", plan.scenes[0].shots[0].payload);
  calls = []; await made.canvasGenerate(shot, "image");
  let back = backCalls();
  assert(back.length === 1, "★镜头首帧生成完没往分镜表回写★ 画布上有图、分镜表里没有，短剧页会让人再买一遍：发出去 " + calls.length + " 笔，回写 " + back.length + " 笔");
  assert(back[0].body.name === BOARD_NAME && back[0].body.shot === "S1-01" && back[0].body.scene === "S1",
    "回写发到了别的地方：" + JSON.stringify(back[0].body));
  assert(back[0].body.fields && back[0].body.fields.first_frame === shot.p.first_frame && shot.p.first_frame,
    "★回写的不是刚生出来那张首帧★ " + JSON.stringify({ 回写: back[0].body.fields, 节点上: shot.p.first_frame }));
  assert(/已生成/.test(toast) && !/回写/.test(toast), "顺利回写时不该额外报警：" + toast);

  // ── ③ 视频写 video、配音写 audio（三种产物不能挤到同一个字段里） ────────────
  calls = []; await made.canvasGenerate(shot, "video");
  back = backCalls();
  assert(back.length === 1 && back[0].body.fields.video && !back[0].body.fields.first_frame,
    "★镜头视频回写的字段不对★ 写错字段等于没写，短剧页照样当它没做：" + JSON.stringify(back.map((c) => c.body.fields)));
  calls = []; await made.canvasGenerate(shot, "audio");
  back = backCalls();
  assert(back.length === 1 && back[0].body.fields.audio, "★配音回写的字段不对★：" + JSON.stringify(back.map((c) => c.body.fields)));

  // ── ④ 定妆照回 characters[].ref，不是回镜头 ──────────────────────────────
  const role = mk("character", plan.characters[0].payload);
  role.p.description = "十七岁女生，齐肩黑发，红色校服外套，站姿自然";
  calls = []; await made.canvasGenerate(role, "image");
  back = backCalls();
  assert(back.length === 1 && back[0].body.character === "A" && !back[0].body.shot && back[0].body.fields.ref,
    "★定妆照没回写进角色的 ref★ 短剧页那头重跑首帧就没有参考图，十二镜里同一个人会一镜一个样："
    + JSON.stringify(back.map((c) => c.body)));

  // ── ⑤ 手搓的节点没有真源，一笔都不许发（否则每生成一次弹一条没头没脑的红） ──
  const hand = mk("shot", { title: "手搓镜头", prompt: "一只猫走过窗台，黄昏侧光", id: "X1" });
  calls = []; await made.canvasGenerate(hand, "image");
  assert(backCalls().length === 0, "没挂在分镜表上的节点不该发回写：" + JSON.stringify(backCalls().map((c) => c.body)));
  assert(/已生成/.test(toast), "手搓节点照样该报生成成功：" + toast);

  // ── ⑥ 回写失败要说，但绝不能说成「生成失败」 ────────────────────────────────
  // 这一步跑到的时候钱已经花掉、文件已经落盘。报成「生成失败」是假红，人会再点一次，
  // 于是真的又花一次——比不报还糟
  for (const mode of ["reject", "boom"]) {
    fetchMode = mode; toast = ""; calls = [];
    await made.canvasGenerate(shot, "image");
    assert(/已生成/.test(toast) && !/生成失败/.test(toast),
      `★回写${mode === "boom" ? "整个炸了" : "被退回"}的时候把「生成成功」说成了「生成失败」★ 这是假红：钱已经花了，人看见红会再点一次，于是真的又花一次：` + toast);
    assert(/回写/.test(toast) && /再花一次钱/.test(toast), "回写没成功却没说清后果：" + toast);
    assert(shot.p.first_frame, "回写失败不该把节点上已经生出来的路径抹掉：" + JSON.stringify(shot.p));
  }
  fetchMode = "ok";
  // 单独再钉一遍：这个函数任何情况下都不许抛。它一抛就会被 canvasGenerate 外面那层 catch 接走，
  // 界面上就是「生成失败」
  fetchMode = "boom";
  const msg = await made.canvasBoardWriteback({ board: BOARD_NAME, board_shot: "S1-01" }, { first_frame: "x.png" });
  assert(typeof msg === "string" && msg, "网络炸了该返回一句话，不该抛也不该返回空：" + JSON.stringify(msg));
  fetchMode = "ok";
  assert(await made.canvasBoardWriteback({}, { first_frame: "x.png" }) === "", "没有戳的节点该安静跳过");


  // ── ⑮ 画布上改内容，也得回到分镜表（不回的代价是拿老提示词买回一张老图）─────────
  {
    const stamped = made.canvasBoardPlan(board, BOARD_NAME);
    const sp = stamped.scenes[0].shots[0].payload, cp = stamped.characters[0].payload;
    assert(sp.board_style === board.style,
      "★展开的时候没把接上去的那段画风留一份★ 回写提示词时剥不掉它，下次展开又接一遍，接几次堆几次：" + JSON.stringify(sp.board_style));
    assert(sp.prompt === board.scenes[0].shots[0].frame_prompt + "\n" + board.style, "展开出来的提示词不是「原文 + 画风」：" + JSON.stringify(sp.prompt));

    const shotN = mk("shot", { ...sp });
    calls = []; toast = "";
    // 人只改了提示词前半段：回表的必须是剥掉画风的那段原文
    shotN.p.prompt = "阿岚回头，睫毛上有雪\n" + board.style;
    let back = await made.canvasBoardContentSync(shotN, "prompt");
    assert(back === "", "提示词回表顺利却报了一句错：" + back);
    assert(backCalls().length === 1 && backCalls()[0].body.fields.frame_prompt === "阿岚回头，睫毛上有雪",
      "★画布上改的提示词没剥掉画风就写回分镜表了★ 下次展开会在它后面再接一遍画风，接几次堆几次：" + JSON.stringify(backCalls().map((c) => c.body.fields)));
    assert(backCalls()[0].body.shot === "S1-01" && backCalls()[0].body.scene === "S1" && !("prompt" in backCalls()[0].body.fields),
      "★回表的字段名不对★ 分镜表里叫 frame_prompt，塞个 prompt 进去整份表就读不出来了：" + JSON.stringify(backCalls()[0].body));

    // 剩下几样是同名直传，但漏一样就是漏一样：台词不回表，重跑配音念的还是老台词
    for (const [k, v, field] of [["line", "我走了", "line"], ["speaker", "B", "speaker"], ["shot_size", "特写", "shot_size"], ["motion_prompt", "镜头缓缓拉远", "motion_prompt"]]) {
      calls = []; shotN.p[k] = v;
      assert(await made.canvasBoardContentSync(shotN, k) === "", k + " 回表报错了");
      assert(backCalls().length === 1 && backCalls()[0].body.fields[field] === v,
        `★画布上改的${k}没回分镜表★ 从短剧页或命令行重跑，用的还是改之前那句：` + JSON.stringify(backCalls().map((c) => c.body.fields)));
    }
    // 台词是可以清空的（无人声镜头），别把「清空」当成「没填」给拦下来
    calls = []; shotN.p.line = "";
    assert(await made.canvasBoardContentSync(shotN, "line") === "" && backCalls()[0].body.fields.line === "",
      "★台词清不掉★ 空着就是无人声镜头，拦下来等于逼人去手改 JSON：" + JSON.stringify(backCalls().map((c) => c.body.fields)));

    // 时长在分镜表里是数字。输入框给的是字符串，原样发过去整份表就不合法了
    calls = []; shotN.p.duration = "6.5";
    assert(await made.canvasBoardContentSync(shotN, "duration") === "", "时长回表报错了");
    assert(backCalls()[0].body.fields.duration === 6.5,
      "★时长是拿字符串回表的★ 分镜表里它是 number，写成字符串下一个读这份表的人会收到「这不是可识别的分镜表」：" + JSON.stringify(backCalls()[0].body.fields));
    calls = []; shotN.p.duration = "abc";
    assert(/秒数/.test(await made.canvasBoardContentSync(shotN, "duration")) && backCalls().length === 0,
      "★填了个不是数的时长照样发出去了★：" + JSON.stringify(backCalls().map((c) => c.body.fields)));
    shotN.p.duration = 4;

    // 角色那头：画布上叫「人物设定」，分镜表里叫 look
    const charN = mk("character", { ...cp });
    calls = []; charN.p.description = "十七岁女生，齐肩黑发，左眉有疤";
    assert(await made.canvasBoardContentSync(charN, "description") === "", "角色设定回表报错了");
    assert(backCalls().length === 1 && backCalls()[0].body.character === "A" && backCalls()[0].body.fields.look === "十七岁女生，齐肩黑发，左眉有疤"
      && !("shot" in backCalls()[0].body),
      "★角色设定没回到 characters[].look★ 那段外貌是「跨镜头长得一样」的依据，不回表下次重跑就是另一个人：" + JSON.stringify(backCalls()[0].body));
    calls = []; charN.p.voice = "Serena";
    assert(await made.canvasBoardContentSync(charN, "voice") === "" && backCalls()[0].body.fields.voice === "Serena", "音色没回表");

    // 画风那段被人自己改了：剥不掉就别偷偷猜，整段写回去 + 说清楚下次展开会再接一遍
    calls = []; shotN.p.prompt = "阿岚回头\n暖黄灯光，手持晃动";
    back = await made.canvasBoardContentSync(shotN, "prompt");
    assert(/画风/.test(back) && /style/.test(back),
      "★画风那段被改过，回写时一声没吭★ 下次展开会在它后面再接一遍分镜表里的画风，越堆越长：" + JSON.stringify(back));
    assert(backCalls().length === 1 && backCalls()[0].body.fields.frame_prompt === "阿岚回头\n暖黄灯光，手持晃动",
      "★剥不掉画风就干脆不写了★ 那这一笔就丢了：" + JSON.stringify(backCalls().map((c) => c.body.fields)));
    shotN.p.prompt = "阿岚回头，睫毛上有雪\n" + board.style;

    // 在画布上把镜头号改了：这个节点已经指不着分镜表里那一镜了。不猜着往老编号那一镜写——
    // 写错地方比不写更难查，得等放片子才发现
    calls = []; shotN.p.id = "S1-77"; shotN.p.line = "改完编号又改的台词";
    back = await made.canvasBoardContentSync(shotN, "line");
    assert(/S1-77/.test(back) && /S1-01/.test(back) && backCalls().length === 0,
      "★镜头号在画布上改过了，内容还往老那一镜写★ 写错那一镜，人要放片子才发现：" + JSON.stringify(back) + " " + JSON.stringify(backCalls().map((c) => c.body)));
    shotN.p.id = "S1-01";

    // 画布上有、分镜表里没有的字段（标题、角色身份、编号本身）一个请求都不该发
    for (const k of ["title", "role", "id", "reference"]) {
      calls = [];
      assert(await made.canvasBoardContentSync(shotN, k) === "" && backCalls().length === 0,
        `★${k} 也往分镜表里塞★ schema 是 additionalProperties:false，塞进去整份表就读不出来了`);
    }
    // 手搓的节点没有真源可回，安静跳过。两种都要试：什么都没有的，和戳盖了一半的
    //（有镜头号没分镜表名——真源名是空的，敲过去只会在界面上弹一条红）
    for (const bareP of [{ id: "X-01", prompt: "手搓的", line: "随便写的" },
      { id: "S1-01", board_shot: "S1-01", board_scene: "S1", line: "戳盖了一半" }]) {
      calls = [];
      const bareN = mk("shot", bareP);
      assert(await made.canvasBoardContentSync(bareN, "line") === "" && backCalls().length === 0,
        "★没有分镜表名的节点也去敲回写接口★ 名字是空的，接口只会退回来，界面上白弹一条红：" + JSON.stringify(backCalls().map((c) => c.body)));
    }

    // 跟别处一样：回不去就把回不去这件事说清楚，绝不抛（它挂在输入框的 change 上，
    // 抛出去就是一个没人接的 Promise，界面上什么都不会发生）
    for (const mode of ["reject", "boom"]) {
      fetchMode = mode; calls = [];
      const m = await made.canvasBoardContentSync(shotN, "line").catch((e) => ({ threw: String(e.message || e) }));
      assert(typeof m === "string" && /没写回分镜表/.test(m) && /改之前那句/.test(m),
        `★回写${mode === "boom" ? "整个炸了" : "被退回"}的时候没说清后果，或者干脆抛了出去★：` + JSON.stringify(m));
    }
    fetchMode = "ok";

    // 源码闸门：这个函数是挂在检查面板输入框的 change 上的，整个面板抠不出来跑。
    // 挂丢了行为上一点红都不会有——改完一句台词，界面照常，分镜表里一个字没变
    const bind = fe.slice(fe.indexOf('box.querySelectorAll("[data-inspect-key]")'), fe.indexOf('box.querySelectorAll("[data-inspect-key]")') + 900);
    assert(/canvasBoardContentSync\(/.test(bind) && /addEventListener\("change"/.test(bind) && !/addEventListener\("input", async/.test(bind),
      "★检查面板的输入框上没挂内容回写（或者挂到 input 上了，每敲一个字写一次盘）★：" + bind.slice(0, 300));
  }

  // ── ⑰ 在画布上连一根线／拆一根线，分镜表里那一镜的 cast 也得跟着改 ──────────
  // cast 不是装饰：这一镜出图时按它去取谁的定妆照当参考图。画布上连了两个人、表里还写着一个人，
  // 从短剧页或命令行重跑这一镜只会带一张参考图，第二个人当场换一张脸——而界面上写的是「已生成」
  {
    const link = (from, to, rel) => ({ get: (k) => (k === "source" ? { id: from } : k === "target" ? { id: to } : k === "canvasRelation" ? rel : null) });
    const stamp = { board: BOARD_NAME, board_scene: "S1", board_shot: "S1-01" };
    const shotN = mk("shot", { id: "S1-01", ...stamp });
    const a = mk("character", { id: "A", name: "阿岚", board: BOARD_NAME, board_character: "A" });
    const b = mk("character", { id: "B", name: "老陈", board: BOARD_NAME, board_character: "B" });
    links.length = 0; links.push(link(a.id, shotN.id, "character"), link(b.id, shotN.id, "character"));

    assert(JSON.stringify(made.canvasBoardCastOf(shotN)) === '["A","B"]',
      "★连上来的角色没按分镜表里的编号数出来★：" + JSON.stringify(made.canvasBoardCastOf(shotN)));

    calls = [];
    assert(await made.canvasBoardCastSync(shotN) === "", "连线回写不该报错");
    assert(backCalls().length === 1, "★连线动了却没回分镜表★ 重跑这一镜会少带一张参考图：" + backCalls().length);
    assert(JSON.stringify(backCalls()[0].body) === JSON.stringify({ name: BOARD_NAME, shot: "S1-01", scene: "S1", fields: { cast: ["A", "B"] } }),
      "★连线回写的报文不对★：" + JSON.stringify(backCalls()[0].body));

    // 拆掉一根：表里那一镜也得少一个人。多带一张不相干的参考图比少带更糟，两张脸会糊到一块儿
    links.length = 1; calls = [];
    assert(await made.canvasBoardCastSync(shotN) === "" && JSON.stringify(backCalls()[0].body.fields.cast) === '["A"]',
      "★拆掉一根角色线，分镜表里那一镜还留着他★：" + JSON.stringify(backCalls().map((c) => c.body.fields)));

    // 全拆光是合法的：空镜。这一笔必须真写出去，不能因为「空的」就当没事发生
    links.length = 0; calls = [];
    assert(await made.canvasBoardCastSync(shotN) === "" && backCalls().length === 1 && JSON.stringify(backCalls()[0].body.fields.cast) === "[]",
      "★把角色线全拆了，分镜表里还站着人★ 空镜也得回：" + JSON.stringify(backCalls().map((c) => c.body.fields)));

    // 没盖过 board_character 的角色节点（人自己搓的）按 id、再退到名字；连上来的非角色节点不算人头
    const c = mk("character", { id: "C", name: "售票员" });
    const d = mk("character", { id: "", name: "路人甲" });
    const img = mk("image", { id: "img1", name: "参考图" });
    links.length = 0; links.push(link(c.id, shotN.id, "character"), link(d.id, shotN.id, "character"), link(img.id, shotN.id, "input"));
    assert(JSON.stringify(made.canvasBoardCastOf(shotN)) === '["C","路人甲"]',
      "★角色编号取错了，或者把图片节点也当成了出场角色★：" + JSON.stringify(made.canvasBoardCastOf(shotN)));

    // 在画布上把角色改名／改 id，分镜表里那一条还是按展开时盖的戳认人——认错人＝重跑时取错定妆照
    const renamed = mk("character", { id: "A-我自己改的", name: "岚岚", board: BOARD_NAME, board_character: "A" });
    links.length = 0; links.push(link(renamed.id, shotN.id, "character"));
    assert(JSON.stringify(made.canvasBoardCastOf(shotN)) === '["A"]',
      "★角色在画布上改了名，回表就按新名字认人了★ 分镜表里根本没这个人，重跑时取不到定妆照：" + JSON.stringify(made.canvasBoardCastOf(shotN)));

    // 同一个人连了两根线：分镜表里不该出现两次（schema 不拦，拦的是参考图会重复占额度）
    links.length = 0; links.push(link(a.id, shotN.id, "character"), link(a.id, shotN.id, "input"));
    assert(JSON.stringify(made.canvasBoardCastOf(shotN)) === '["A"]',
      "★同一个角色连了两根线就数成两个人★：" + JSON.stringify(made.canvasBoardCastOf(shotN)));

    // 没盖过戳的节点不去敲接口；戳盖了一半（有 board_shot 没 board）也不行——名字是空的，只会白弹一条红
    links.length = 0; links.push(link(a.id, shotN.id, "character"));
    for (const bare of [{ id: "手搓的一镜" }, { id: "S1-01", board_shot: "S1-01", board_scene: "S1" }, { id: "S1-01", board: BOARD_NAME }]) {
      calls = [];
      const bn = mk("shot", bare); links.push(link(a.id, bn.id, "character"));
      assert(await made.canvasBoardCastSync(bn) === "" && backCalls().length === 0,
        "★没盖戳的节点也去敲回写接口★：" + JSON.stringify(backCalls().map((c) => c.body)));
    }

    // 只有镜头节点才有 cast。角色节点如此；生成出来的结果节点更要紧——它身上带着那一镜的戳，
    // 往它上面连一张参考图，就会拿这张图当「出场角色」写回那一镜
    for (const other of [a, mk("image", { id: "S1-01", board: BOARD_NAME, board_scene: "S1", board_shot: "S1-01" })]) {
      calls = []; links.length = 0; links.push(link(b.id, other.id, "character"));
      assert(await made.canvasBoardCastSync(other) === "" && backCalls().length === 0,
        "★往不是镜头的节点上写 cast★ 分镜表里只有镜头有 cast，写串了整份表就读不出来了：" + JSON.stringify(backCalls().map((c) => c.body)));
    }
    links.length = 0; links.push(link(a.id, shotN.id, "character"));

    // 镜头号在画布上被改过：这个节点已经跟分镜表脱钩了，猜着往老编号那一镜写比不写更难查
    calls = [];
    const moved = mk("shot", { ...stamp, id: "S1-77" });
    links.length = 0; links.push(link(a.id, moved.id, "character"));
    assert(await made.canvasBoardCastSync(moved) === "" && backCalls().length === 0,
      "★镜头号改过了还往老那一镜写 cast★ 写错地方要等放片子才发现：" + JSON.stringify(backCalls().map((c) => c.body)));

    // 回不去就说清后果，绝不抛：它挂在图的 add/remove 上，抛出去就是一个没人接的 Promise
    links.length = 0; links.push(link(a.id, shotN.id, "character"));
    for (const mode of ["reject", "boom"]) {
      fetchMode = mode; calls = [];
      const m = await made.canvasBoardCastSync(shotN).catch((e) => ({ threw: String(e.message || e) }));
      assert(typeof m === "string" && /出场角色没写回分镜表/.test(m) && /变脸/.test(m),
        `★连线回写${mode === "boom" ? "整个炸了" : "被退回"}的时候没说清后果，或者干脆抛了出去★：` + JSON.stringify(m));
    }
    fetchMode = "ok"; links.length = 0;

    // 源码闸门：这两个钩子挂在真的 joint 图上，整张图抠不出来跑。
    // 挂丢了行为上一点红都不会有；两个守卫丢了更糟——展开一份十二镜的分镜表会当场往真源上糊十二笔
    const hookAt = fe.indexOf("const castQueue = new Set();");
    assert(hookAt > 0, "★连线回写的钩子整个不见了★ 在画布上连一根线，分镜表里那一镜的 cast 永远不会变");
    const hook = fe.slice(hookAt, hookAt + 1500);
    assert(/canvasBoardCastSync\(/.test(hook), "★钩子里没去回写★：" + hook.slice(0, 300));
    assert(/canvasState\.graph\.on\("add", castWatch\)/.test(hook) && /canvasState\.graph\.on\("remove", castWatch\)/.test(hook),
      "★钩子没挂到图的 add/remove 上★ 在画布上直接拖一条线根本不走 canvasConnect：" + hook.slice(0, 400));
    assert(/canvasState\.bulk \|\| canvasState\.suspendSync/.test(hook),
      "★钩子没挡住批量那两下★ 展开分镜表和恢复快照都会成批连线，一条线一次回写＝往真源上糊十二笔：" + hook.slice(0, 400));
  }

  // ── ⑭ 短剧页那头重跑一格，也只准写这一格 ────────────────────────────────
  // 画布一回写，短剧页的整份 PUT 就成了新的踩踏点：它手里是**打开页面那一刻**的副本，
  // 中间画布上生的十二笔会被这一次重跑连带抹掉，而界面上写的是「已生成」
  {
    const dr = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-07-drama.js"), "utf8");
    const dcut = (from, to) => {
      const a = dr.indexOf(from), b = dr.indexOf(to, a + 1);
      assert(a >= 0 && b > a, "抠不出短剧页这段代码（函数改名了？）：" + from);
      return dr.slice(a, b);
    };
    // 源码闸门：重跑那条路上不许再出现整份写。这一条纯函数断言看不见——
    // 把 dramaSaveShot 的内容原样搬回 dramaSave 里，行为一模一样，钱照样丢
    const rerunBody = dcut("async function dramaRerun(", "\n}\n");
    assert(/dramaSaveShot\(/.test(rerunBody) && !/[^S]dramaSave\(/.test(rerunBody),
      "★短剧页重跑那一格又走回整份写回了★ 它手里是打开页面那一刻的副本，会把画布上刚生的那十二笔一起抹掉，人还以为「重跑成功」：" + rerunBody.slice(0, 400));
    // 回写没成功要跟「已生成」摆在同一条提示里说。dramaRerun 整个挂在 DOM 上抠不出来跑，
    // 所以这一条也只能钉在源码上：把这个分支删掉，回写失败就成了一次静悄悄的分家
    assert(/const back = await dramaSaveShot\(/.test(rerunBody) && /if \(back\)/.test(rerunBody),
      "★重跑那格拿到回写失败之后没吭声★ 画布上有图、分镜表里没有，要等下次重跑白花一次钱才看得出来：" + rerunBody.slice(0, 400));

    let dcalls = [], dmode = "ok";
    const dsrc = dcut("async function dramaSave()", "\nasync function dramaRerun(");
    const dmade = new Function("fetch", "dramaState", "console",
      dsrc + "\nreturn { dramaSave, dramaSaveShot };")(
      async (url, opt) => {
        dcalls.push({ url, body: JSON.parse((opt && opt.body) || "{}") });
        if (dmode === "boom") throw new Error("网络断了");
        return { json: async () => (dmode === "reject" ? { error: "分镜表里没有这一镜" } : { ok: true }) };
      },
      { name: BOARD_NAME, data: { title: "x" } },
      { warn() {} });

    const scene = { id: "S1" }, one = { id: "S1-07" };
    let back = await dmade.dramaSaveShot(scene, one, { first_frame: "a.png", note: "首帧已重跑" });
    assert(back === "", "回写顺利却报了一句错：" + back);
    assert(dcalls.length === 1 && dcalls[0].url === "/api/drama/storyboard/output",
      "★重跑写回去的还是整份分镜表★：" + JSON.stringify(dcalls.map((c) => c.url)));
    assert(dcalls[0].body.shot === "S1-07" && dcalls[0].body.scene === "S1" && dcalls[0].body.name === BOARD_NAME
      && dcalls[0].body.fields.first_frame === "a.png" && dcalls[0].body.fields.note === "首帧已重跑",
      "★单格回写的身份没带全，服务端指不着是哪一场的哪一镜★：" + JSON.stringify(dcalls[0].body));

    // 表被人手改坏、这一镜没有镜头号：指不着就退回整份写，总比这一笔干脆不落盘强
    dcalls = [];
    back = await dmade.dramaSaveShot(scene, { shot_size: "近景" }, { first_frame: "b.png" });
    assert(back === "" && dcalls.length === 1 && dcalls[0].url === "/api/drama/storyboard",
      "★没有镜头号的那一镜既指不着单格、又没退回整份写，这一笔就丢了★：" + JSON.stringify(dcalls.map((c) => c.url)));
    // 退回去的那条整份写自己也会失败（dramaSave 是会抛的）。让它一路抛到 dramaRerun 的 catch，
    // 界面上就是「重跑失败」——钱已经花了、图已经落盘了，那是假红，人会再点一次
    dcalls = []; dmode = "reject";
    const m0 = await dmade.dramaSaveShot(scene, { shot_size: "近景" }, { first_frame: "d.png" }).catch((e) => ({ threw: String(e.message || e) }));
    assert(typeof m0 === "string" && /再花一次钱/.test(m0),
      "★退回整份写的那条路上失败了，异常被掀了出去★ 外面那层 catch 会把它显示成「重跑失败」，人会再点一次、再花一次钱：" + JSON.stringify(m0));
    dmode = "ok";

    // 跟画布那边同一条道理：钱已经花了、图已经落盘了，这时候抛出去就会被 dramaRerun 的
    // catch 接走显示成「重跑失败」——人会再点一次，于是真的又花一次
    for (const mode of ["reject", "boom"]) {
      dmode = mode;
      const m = await dmade.dramaSaveShot(scene, one, { first_frame: "c.png" });
      assert(typeof m === "string" && /写回分镜表/.test(m) && /再花一次钱/.test(m),
        `★回写${mode === "boom" ? "整个炸了" : "被退回"}的时候没说清后果，或者干脆抛了出去★ 抛出去界面上就是「重跑失败」，那是假红：` + JSON.stringify(m));
    }
    dmode = "ok";
  }

  // ══ 后半场：服务端真把它写到盘上那一个字段里 ════════════════════════════
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "owb-drama-"));
  const ws = path.join(home, "workspace", "分镜表");
  fs.mkdirSync(ws, { recursive: true });
  const boardPath = path.join(ws, "最后一班车.json");
  // 两场里各有一个 S2-01：镜头号在真分镜表里重复过，服务端不许替人猜是哪一场的那一镜
  const onDisk = JSON.parse(JSON.stringify(board));
  onDisk.scenes.push({ id: "S2", place: "老陈家", time: "深夜", shots: [{ id: "S2-01", cast: ["B"], shot_size: "特写", frame_prompt: "手表特写", motion_prompt: "固定机位" }] });
  onDisk.scenes.push({ id: "S3", place: "天桥", time: "凌晨", shots: [{ id: "S2-01", cast: ["A"], shot_size: "远景", frame_prompt: "天桥空镜", motion_prompt: "固定机位" }] });
  fs.writeFileSync(boardPath, JSON.stringify(onDisk, null, 2) + "\n");

  const token = "e2e" + crypto.randomBytes(12).toString("hex");
  fs.mkdirSync(path.join(home, "data"), { recursive: true });
  fs.writeFileSync(path.join(home, "data", "users.json"), JSON.stringify({
    users: [{ username: "e2e", salt: "x", hash: "x", role: "admin", credits: 0, created_at: Date.now() }],
    tokens: { [token]: { user: "e2e", at: Date.now() } },
  }));

  const booted = bootRealServer({ OPENWORKBUDDY_HOME: home });
  const { up, port, why } = await booted.wait();
  const post = (body) => new Promise((resolve) => {
    const raw = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port, path: "/api/drama/storyboard/output", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": raw.length, Cookie: "openworkbuddy_token=" + token },
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ code: res.statusCode, json: j, body: b }); });
    });
    req.on("error", (e) => resolve({ code: 0, json: null, body: e.message }));
    req.end(raw);
  });
  const read = () => JSON.parse(fs.readFileSync(boardPath, "utf8"));

  try {
    assert(up, "真 server.js 没起来，这条测试作废：" + why);

    // ── ⑦ 真写到盘上，而且只动那一个字段 ────────────────────────────────────
    const r1 = await post({ name: BOARD_NAME, scene: "S1", shot: "S1-01", fields: { first_frame: "镜头_S1-01_首帧.png" } });
    assert(r1.code === 200 && r1.json && r1.json.ok, "回写接口没收：" + r1.code + " " + r1.body);
    let now = read();
    assert(now.scenes[0].shots[0].first_frame === "镜头_S1-01_首帧.png",
      "★回写说成功了，盘上那一镜还是空的★ 这是最骗人的一种绿：" + JSON.stringify(now.scenes[0].shots[0]));
    assert(now.scenes[0].shots[0].frame_prompt === "阿岚站在站牌下" && now.scenes[0].shots[1].first_frame === undefined
      && now.title === "最后一班车" && now.characters.length === 2,
      "★回写一笔顺手动了别的地方★ 分镜表是唯一真源，旁边那些字是人手写的：" + JSON.stringify(now.scenes[0]));

    const rNote = await post({ name: BOARD_NAME, scene: "S1", shot: "S1-02", fields: { video: "镜头_S1-02.mp4", note: "视频已重跑" } });
    assert(rNote.code === 200 && read().scenes[0].shots[1].note === "视频已重跑",
      "★短剧页重跑写的那行流水落不进去★ note 是那条单格回写唯一收的非产物字段，它进不来重跑就只能走整份写：" + rNote.code + " " + rNote.body);

    // ── ⑧ 查无此镜要当场说，不许静悄悄成功 ──────────────────────────────────
    const before404 = fs.readFileSync(boardPath, "utf8");
    const r2 = await post({ name: BOARD_NAME, shot: "S9-99", fields: { first_frame: "x.png" } });
    assert(r2.code === 404 && /S9-99/.test(String(r2.json && r2.json.error)),
      "★分镜表里没有这一镜，接口却没报★ 画布上写着路径、真源里一个字没有，要等下次白花一次钱才看得出来：" + r2.code + " " + r2.body);
    assert(fs.readFileSync(boardPath, "utf8") === before404, "查无此镜的那一笔不该动盘上的文件");

    // ── ⑨ 白名单外的字段直接退回（schema 是 additionalProperties:false，塞进去整份表就读不出来了）──
    // id 是定位用的钥匙，要改得去分镜表里改；类型错了更要当场拦：
    // 时长写成字符串，整份分镜表从此读不出来，错在这一笔赔的是整部戏
    for (const bad of [{ evil: "x" }, { id: "S9-99" }, { title: "换个名" },
      { first_frame: "" }, { first_frame: 3 }, { frame_prompt: "" }, { shot_size: "   " },
      { line: 3 }, { duration: "4" }, { duration: 0 }, { duration: -2 }, { duration: NaN }]) {
      const r = await post({ name: BOARD_NAME, shot: "S1-01", fields: bad });
      assert(r.code === 400 && String((r.json && r.json.error) || "").includes(Object.keys(bad)[0]),
        "★这条接口没拦住它不该收的字段，或者是自己崩了一下（兜底的 catch 也给 400）★ " + JSON.stringify(bad) + " → " + r.code + " " + r.body);
    }
    assert(read().scenes[0].shots[0].frame_prompt === "阿岚站在站牌下", "被退回的那几笔居然写进去了");

    // ── ⑯ 内容字段真能回：提示词、台词、时长（时长必须是数字落盘）──────────────
    // 画布上改了提示词不回表，从命令行重跑的还是老那句，而且参数变了缓存命不中——
    // 等于花钱买回一张老图，把刚改好的那张盖掉
    assert((await post({ name: BOARD_NAME, scene: "S1", shot: "S1-01", fields: { frame_prompt: "阿岚回头，睫毛上有雪" } })).code === 200, "提示词回表没收");
    assert((await post({ name: BOARD_NAME, scene: "S1", shot: "S1-01", fields: { duration: 6.5 } })).code === 200, "时长回表没收");
    assert((await post({ name: BOARD_NAME, scene: "S1", shot: "S1-01", fields: { line: "" } })).code === 200, "★台词清不掉★ 空着就是无人声镜头");
    now = read();
    assert(now.scenes[0].shots[0].frame_prompt === "阿岚回头，睫毛上有雪" && now.scenes[0].shots[0].line === "",
      "★内容改了却没落盘★：" + JSON.stringify(now.scenes[0].shots[0]));
    assert(typeof now.scenes[0].shots[0].duration === "number" && now.scenes[0].shots[0].duration === 6.5,
      "★时长落盘落成了字符串★ 分镜表里它是 number，下一个读这份表的人会收到「这不是可识别的分镜表」：" + JSON.stringify(now.scenes[0].shots[0].duration));
    assert((await post({ name: BOARD_NAME, character: "A", fields: { look: "十七岁女生，左眉有疤" } })).code === 200, "角色设定回表没收");
    assert(read().characters[0].look === "十七岁女生，左眉有疤", "★角色外貌没落盘★ 那段是跨镜头长得一样的依据");


    // ── ⑱ cast 真能回，而且只有它能进去 ────────────────────────────────────
    // 画布上连了两个人、表里还写着一个，重跑这一镜只带一张参考图，第二个人当场换一张脸
    assert((await post({ name: BOARD_NAME, scene: "S1", shot: "S1-01", fields: { cast: ["A", "B"] } })).code === 200, "连线回写没收");
    now = read();
    assert(JSON.stringify(now.scenes[0].shots[0].cast) === '["A","B"]',
      "★出场角色没落盘★ 重跑这一镜会少带一张参考图：" + JSON.stringify(now.scenes[0].shots[0].cast));
    assert(now.scenes[0].shots[0].frame_prompt === "阿岚回头，睫毛上有雪", "写 cast 顺手把提示词也动了");
    // 空数组是合法的：角色线全拆了就是个空镜。这一笔必须真写进去，不能当没事发生
    assert((await post({ name: BOARD_NAME, scene: "S1", shot: "S1-01", fields: { cast: [] } })).code === 200, "★空镜不让写★ 把角色线全拆了，表里还站着人");
    assert(JSON.stringify(read().scenes[0].shots[0].cast) === "[]", "★清空 cast 没落盘★");
    // 里头混进一个空串或者数字，整份分镜表就不合 schema 了（cast 是 string 数组），
    // 下次读这份表的人只会收到一句「这不是可识别的分镜表」——错在这一笔，赔的是整部戏
    const longCast = []; for (let i = 0; i < 25; i++) longCast.push("R" + i);
    for (const bad of [{ cast: "A" }, { cast: ["A", ""] }, { cast: ["A", "   "] }, { cast: ["A", 3] }, { cast: ["A", null] }, { cast: ["A", "A"] }, { cast: longCast }]) {
      const r = await post({ name: BOARD_NAME, shot: "S1-01", fields: bad });
      // 光看 400 是软的：校验拆掉之后它多半是自己绊一跤（v.some is not a function），
      // 兜底的 catch 照样给 400。得是接口点名说了是哪个字段不对
      assert(r.code === 400 && String((r.json && r.json.error) || "").includes("cast"),
        "★这条接口没拦住会把分镜表写坏的 cast，或者是自己崩了一下★ " + JSON.stringify(bad) + " → " + r.code + " " + r.body);
    }
    assert(JSON.stringify(read().scenes[0].shots[0].cast) === "[]", "被退回的那几笔居然写进去了：" + JSON.stringify(read().scenes[0].shots[0].cast));
    assert((await post({ name: BOARD_NAME, character: "A", fields: { cast: ["B"] } })).code === 400,
      "★角色身上也让写 cast★ 分镜表里角色没这个字段，塞进去整份表就读不出来了");

    // ── ⑩ 角色：按 id 也按名字，落的是 ref ──────────────────────────────────
    assert((await post({ name: BOARD_NAME, character: "A", fields: { ref: "角色_阿岚_定妆.png" } })).code === 200, "按 id 回写定妆照没成");
    assert((await post({ name: BOARD_NAME, character: "老陈", fields: { ref: "角色_老陈_定妆.png" } })).code === 200, "按名字回写定妆照没成");
    now = read();
    assert(now.characters[0].ref === "角色_阿岚_定妆.png" && now.characters[1].ref === "角色_老陈_定妆.png",
      "★定妆照没落到 characters[].ref★ 短剧页那头重跑首帧就没有参考图：" + JSON.stringify(now.characters));

    // ── ⑪ 镜头号撞了不替人猜；给了场次号就分得清 ────────────────────────────
    const dup = await post({ name: BOARD_NAME, shot: "S2-01", fields: { video: "撞号.mp4" } });
    assert(dup.code === 409 && /S2-01/.test(String(dup.json && dup.json.error)),
      "★两场里都有 S2-01，接口却随手挑了一个写★ 写错那一镜，人要放片子才发现：" + dup.code + " " + dup.body);
    assert((await post({ name: BOARD_NAME, scene: "S3", shot: "S2-01", fields: { video: "S3的那一镜.mp4" } })).code === 200, "给了场次号还是分不清");
    now = read();
    assert(!now.scenes[1].shots[0].video && now.scenes[2].shots[0].video === "S3的那一镜.mp4",
      "★给了场次号还是写错了场★：" + JSON.stringify([now.scenes[1].shots[0], now.scenes[2].shots[0]]));

    // ── ⑫ 十二镜几乎同时生完：一笔都不许被别人的写盘冲掉 ─────────────────────
    // 这正是不复用整份 PUT 的原因。读到写之间只要有一个 await，这条就会红
    const many = [];
    for (let i = 0; i < 12; i++) many.push({ id: "P-" + i });
    const big = read();
    big.scenes.push({ id: "P", place: "并发", time: "无", shots: many.map((m) => ({ id: m.id, shot_size: "中景", frame_prompt: "p", motion_prompt: "m" })) });
    fs.writeFileSync(boardPath, JSON.stringify(big, null, 2) + "\n");
    const rs = await Promise.all(many.map((m) => post({ name: BOARD_NAME, scene: "P", shot: m.id, fields: { first_frame: m.id + ".png" } })));
    assert(rs.every((r) => r.code === 200), "并发回写里有没收下的：" + JSON.stringify(rs.map((r) => r.code)));
    const after = read().scenes.find((s) => s.id === "P").shots;
    const lost = after.filter((s) => s.first_frame !== s.id + ".png").map((s) => s.id);
    assert(lost.length === 0,
      "★十二镜同时回写，有 " + lost.length + " 笔被别人的写盘冲掉了★ 画布上有图、分镜表里没有，下次重跑就是再花一次钱：" + lost.join("、"));

    // ── ⑬ 分镜表名仍然只能指向工作区里的 .json ──────────────────────────────
    // 光断言「≥400」是软的：闸门拆掉之后它多半是读不到文件自己崩一下，照样 400。
    // 所以在工作区外面摆一份**长得就像分镜表、里面正好有 S1-01**的文件：闸门真拆了，
    // 这一笔会安安静静写进去，而返回码还是 200。看的是那份文件动没动
    const outside = path.join(home, "机密.json");
    const outsideRaw = JSON.stringify({ title: "工作区外面的东西", scenes: [{ id: "S1", shots: [{ id: "S1-01" }] }] }, null, 2) + "\n";
    fs.writeFileSync(outside, outsideRaw);
    for (const name of ["../机密.json", "../../机密.json", "/etc/passwd.json", "最后一班车.txt", ""]) {
      const r = await post({ name, shot: "S1-01", fields: { first_frame: "越界了.png" } });
      assert(r.code >= 400, "★越界的分镜表名被放进来了★ " + JSON.stringify(name) + " → " + r.code + " " + r.body);
    }
    assert(fs.readFileSync(outside, "utf8") === outsideRaw,
      "★工作区外面那份文件被这条接口改了★ 分镜表名的闸门漏了：" + fs.readFileSync(outside, "utf8").slice(0, 200));
  } finally {
    booted.child.kill();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  }

  console.log("✅ 短剧画布回写分镜表：生出来的首帧/视频/配音/定妆照当场回到唯一真源（以前只留在画布里，短剧页照样写「暂无首帧」，人再点一次就是再花一次钱）· 在画布上改的提示词/台词/景别/时长/音色也回表（以前不回，重跑就是拿老提示词买回一张老图把新的盖掉），提示词先剥掉接上去的全片画风、剥不掉如实说 · 时长按数字落盘、台词清得掉、镜头号被改过就不猜着往老那一镜写 · 展开时盖戳、手搓节点不打扰 · 回写失败单独报且绝不冒充「生成失败」 · 服务端只动那一个字段、查无此镜当场报、撞号不替人猜、id/cast/类型不对一律进不去 · 十二镜同时回写一笔不丢 · 短剧页重跑那一格也只写那一格 · 在画布上连一根角色线／拆一根，分镜表里那一镜的 cast 当场跟着改（以前不跟，重跑就少带或多带一张定妆照，人当场换脸），空镜也照回、重复不算两个人、批量展开和恢复快照不糊真源");
}
