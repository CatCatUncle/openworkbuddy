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
const { parseCron } = require("../scheduler");
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
  console.log("✅ 定时任务：cron 解析通过");
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
  testPathSafety();
  testDeliverableGate();
  testContextBudget();
  testPluginManifest();
  testPluginComponentIsolation();
  testPluginMcpRuntime();
  testPluginSkillsIntegration();
  testDefaultSkillsManifest();
  await testMcpStreamableHttp();
  await testMcpManagerLifecycle();
  await testNodeSyntaxPrecheck();
  await testOfficeLibs();
  await testAgentPipeline();
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
