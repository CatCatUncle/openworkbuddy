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
const { createAgentRuntime, missingDeliverables, trimHistory, historyChars } = require("../agent");
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
  console.log("✅ 上下文预算：老结果截短 / 最近 3 轮保原文 / 不删任何工具消息");
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
function testDefaultSkillsManifest() {
  const skillsMgr = require("../skills");
  const list = skillsMgr.listDefaultSkills();
  assert(list.length > 0, "默认技能清单是空的");
  for (const s of list) {
    for (const k of ["name", "title", "repo", "subpath", "license", "author", "bytes", "why", "url"]) {
      assert(s[k] !== undefined && s[k] !== "", `默认技能 ${s.name} 缺字段 ${k}`);
    }
    assert(/^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+\/.+$/.test(s.url), `${s.name} 的上游地址拼错了: ${s.url}`);
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

  // 代码闸：命令闸守得再严，一句 require("child_process") 就从旁边过去了
  assert.strictEqual(security.checkCode(sec, 'require("child_process").execSync("rm -rf ~/x")').action, "ask", "代码开子进程没拦");
  assert.strictEqual(security.checkCode(sec, 'fs.readFileSync(process.env.HOME + "/.ssh/id_rsa")').action, "ask", "代码碰黑名单没拦");
  assert.strictEqual(security.checkCode(sec, 'const fs=require("fs");fs.writeFileSync("a.txt","hi")').action, "allow", "正常代码被拦了");
  console.log("✅ 命令闸：换行/$()/反引号/子shell/包装词全拆得开，黑名单压得住放行名单，代码闸补上子进程这条路");
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
  } finally {
    srv.close();
  }
  console.log("✅ 抓取：JSON 原样返回 / HTML 转文本 / 空壳与反爬如实报告并给下一步 通过");
}

function testPathSafety() {
  const { safePath } = require("../tools");
  let threw = false;
  try { safePath("..\\..\\windows\\system32\\evil.txt"); } catch { threw = true; }
  assert(threw, "路径越界未被拦截");
  console.log("✅ 安全：workspace 路径越界拦截通过");
}

async function main() {
  console.log("=== OpenWorkBuddy e2e 测试 ===");
  testCron();
  testCommandGate();
  testLeakedToolCallRescue();
  testJsonStore();
  testImSessionStore();
  testAccountStore();
  testPathSafety();
  testDeliverableGate();
  testContextBudget();
  testPluginManifest();
  testPluginComponentIsolation();
  testPluginMcpRuntime();
  testPluginSkillsIntegration();
  testDefaultSkillsManifest();
  await testFetchUrlShapes();
  await testMcpStreamableHttp();
  await testSchedulerRuntime();
  await testMcpManagerLifecycle();
  await testNodeSyntaxPrecheck();
  await testOfficeLibs();
  await testAgentPipeline();
  await testForcedWrapUp();
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
