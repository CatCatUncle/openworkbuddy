"use strict";
/**
 * Agent 核心运行时 — 被 Web 界面、IM 接入、专家委派共同复用。
 * 主 Agent 是"协调者"：可直接干活，也可通过 delegate_to_expert 把子任务委派给专家子智能体。
 */

const { TOOL_DEFS, executeTool, outputFiles } = require("./tools");
const { loadSkills } = require("./skills");

const DELEGATE_TOOL = {
  name: "delegate_to_expert",
  description:
    "把一个子任务委派给专家团中的一位专家（子智能体）执行，返回该专家的完成汇报。专家与你共享同一个工作目录，它生成的文件你可以直接使用。适合把大任务拆成调研、分析、写作、做PPT等阶段分别委派。",
  input_schema: {
    type: "object",
    properties: {
      expert: { type: "string", description: "专家名称，必须是专家团列表中的一个" },
      task: {
        type: "string",
        description: "子任务描述。要自包含：写清目标、输入（如已有文件名）、期望产出（如文件名）。",
      },
    },
    required: ["expert", "task"],
  },
};

const FEISHU_DOC_TOOL = {
  name: "feishu_doc_create",
  description:
    "把 Markdown 内容创建成一篇飞书云文档，直接交付到用户的飞书（复用已配置的飞书机器人凭证）。适合报告、纪要、方案等文字成果。成功返回文档链接。若因权限不足失败：先把返回的开通指引和链接告诉用户，然后立刻带 wait_for_permission:true 重调本工具——它会自动轮询等用户开通，权限一生效就建好文档继续任务，用户不用回来喊你。",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "文档标题" },
      markdown: {
        type: "string",
        description: "文档正文 Markdown。支持 #/##/### 标题、- 无序列表、1. 有序列表、> 引用、``` 代码块、普通段落。",
      },
      wait_for_permission: {
        type: "boolean",
        description: "权限不足时轮询等待用户开通（每 20 秒重试，最多约 10 分钟），开通即自动创建。只在第一次因权限失败、且已把开通指引告诉用户之后用。",
      },
    },
    required: ["title", "markdown"],
  },
};

const USE_SKILL_TOOL = {
  name: "use_skill",
  description: "加载一个技能包的完整内容（操作指南与代码模板）。执行对应类型任务前先加载相关技能。",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "技能名称" } },
    required: ["name"],
  },
};

const fs = require("fs");
const path = require("path");
const MEMORY_FILE = path.join(__dirname, "data", "memory.md");

function readMemory() {
  try {
    return fs.readFileSync(MEMORY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function createAgentRuntime({ config, llm, mcpManager, experts }) {
  // 技能每次任务实时加载（save_skill 新建的技能立即可用）
  function getSkills() {
    return loadSkills();
  }

  function baseSystemPrompt() {
    const skills = getSkills();
    let p = `你是 WorkBuddy，一个 AI 办公智能体。用户用自然语言下达办公任务，你自主思考、拆解任务、规划步骤、调用工具执行，最终交付可验证的成果。

## 工具能力
- run_node：执行 Node.js 代码。已安装库：pptxgenjs(PPT)、docx(Word)、exceljs(Excel)，以及 Node 内置模块。
- run_shell：执行 shell 命令（macOS zsh），可用系统已装的 CLI 工具（git、curl、ffmpeg、lark-cli 等）。调现成命令行工具用它，写程序逻辑用 run_node。
- write_file / read_file / list_files：读写工作目录中的文件
- web_search：联网搜索（标题/链接/摘要），查资料先搜索定位来源
- fetch_url：抓取网页全文（配合 web_search 的结果 URL 用）
- use_skill：加载技能包（做对应任务前先加载）
- library_list / library_read：查看用户的资料库与灵感笔记（跨项目共享的长期参考资料，任务涉及用户偏好/素材时先查）`;
    if ((config.im || {}).feishu && (config.im.feishu.app_id || config.im.feishu.doc_app_id)) {
      p += `\n- feishu_doc_create：把 Markdown 内容创建成飞书云文档交付给用户（用户要求"发到飞书/建飞书文档"时用它，不要自己找凭证写脚本）`;
    }

    if (skills.length) {
      p += `\n\n## 可用技能\n` + skills.map((s) => `- ${s.name}：${s.description}`).join("\n");
    }
    p += `

## 工作规范
1. 接到任务先简短说明计划（2-4 句），然后立即执行，不要等用户确认。
2. 成果文件写到工作目录根目录，文件名有意义。
3. 代码报错要读懂原因、修正重试，不要放弃。
4. 完成后简要总结做了什么、生成了哪些文件。
5. 始终用中文交流。
6. 用户消息里的「@某文件名」指工作目录中的文件（用 read_file 读取）；「/某技能名」表示要求使用该技能（先 use_skill 加载）；「【任务类型：X】」是场景标签，按该场景的最佳实践来做。

## 回复排版（重要）
- 结构固定三段式：**动手前**先用一两句说明你准备做什么、怎么做；**过程中**工具调用之间的过渡叙述控制在一两句话（界面会把中间过程折叠收起）；**收尾**最后一条消息必须是完整、自洽的最终结论/交付说明——用户默认只看到开场白和这段结论，别把关键信息只写在中间过程里。
- 回复用 Markdown 结构化输出：小标题（##/###）分段、要点用列表、关键结论/数字用**加粗**、代码和命令放代码块、对比数据用表格。
- 代码块必须用三反引号围栏包裹并标注语言（\`\`\`python、\`\`\`bash、\`\`\`text 等），围栏要成对闭合。严禁把语言名单独写一行然后直接贴裸代码——那样界面无法渲染成代码块。凡是代码、命令、文件树、日志、SVG/XML 片段，一律进围栏。
- 结论先行，再给必要细节；不要把内心推演过程大段写出来（"让我想想""我先检查一下"这类只保留一句即可）。
- 不要虚构进度和等待（"预计耗时X秒，请稍候""正在生成中"这类话不要说）：要么直接调工具真的去做，要么直接给结果。`;
    if (config.persona) {
      p += `\n\n## 用户的个性化偏好\n${config.persona}`;
    }
    const memory = readMemory();
    if (memory) {
      p += `\n\n## 长期记忆（用户让你记住的信息）\n${memory}`;
    }
    return p;
  }

  function coordinatorSystemPrompt() {
    let p = baseSystemPrompt();
    if (experts.length) {
      p += `\n\n## 专家团（可用 delegate_to_expert 委派子任务）\n`;
      p += experts.map((e) => `- ${e.name}：${e.description}`).join("\n");
      p += `\n委派原则：复杂任务（如"调研+写报告+做PPT"）应拆解后按阶段委派给对应专家；简单任务自己直接做。委派时把上一阶段产出的文件名传给下一位专家。`;
    }
    return p;
  }

  function expertSystemPrompt(expert) {
    return (
      baseSystemPrompt() +
      `\n\n## 你的专家角色\n${expert.system}\n\n你是被主协调者委派的专家，完成任务后用一段简明汇报结束（做了什么、产出文件名、关键结论）。`
    );
  }

  const READ_ONLY_TOOLS = ["read_file", "list_files", "fetch_url", "web_search", "library_list", "library_read"];

  function toolList(depth, mode) {
    if (mode === "ask" || mode === "plan") {
      return [...TOOL_DEFS.filter((t) => READ_ONLY_TOOLS.includes(t.name)), USE_SKILL_TOOL];
    }
    const tools = [...TOOL_DEFS, USE_SKILL_TOOL, ...mcpManager.toolDefs()];
    if ((config.im || {}).feishu && (config.im.feishu.app_id || config.im.feishu.doc_app_id)) tools.push(FEISHU_DOC_TOOL);
    if (depth === 0 && experts.length) tools.push(DELEGATE_TOOL);
    return tools;
  }

  function modePrompt(mode) {
    if (mode === "ask") {
      return `\n\n## 当前模式：Ask（问答）\n只负责回答问题、分析与建议。可以读文件、查资料，但绝不修改文件、不执行代码、不委派专家。回答完即结束。`;
    }
    if (mode === "plan") {
      return `\n\n## 当前模式：Plan（规划）\n只做调研与规划，不实际执行。输出一份结构化执行计划：任务拆解步骤、每步用什么工具/专家、预期产出文件。最后提醒用户切换到 Craft 模式执行。`;
    }
    return "";
  }

  async function runToolCall(tc, { emit, depth, deadline, stats, stopSignal }) {
    if (tc.name === "use_skill") {
      const skills = getSkills();
      const skill = skills.find((s) => s.name === (tc.input.name || "").trim());
      // folder 型技能自带 scripts/templates 等资源，动态告知 agent 技能目录的绝对路径
      const dirNote = skill && skill.hasAssets
        ? `【技能目录】${skill.dir}\n该技能自带 scripts/templates 等资源文件（在上述目录内，不在工作目录）。技能文档里的相对路径都相对这个目录；运行其脚本用 run_shell 先 cd 进该目录，但产出的成果文件仍要写到工作目录。\n\n`
        : "";
      return skill
        ? { content: dirNote + skill.content, isError: false }
        : { content: `技能不存在: ${tc.input.name}。可用: ${skills.map((s) => s.name).join(", ")}`, isError: true };
    }
    if (mcpManager.isMcpTool(tc.name)) {
      return await mcpManager.call(tc.name, tc.input);
    }
    if (tc.name === "feishu_doc_create") {
      try {
        const { createFeishuDoc } = require("./feishu-doc");
        const r = await createFeishuDoc((config.im || {}).feishu, tc.input, { deadline, stopSignal });
        return {
          content: `飞书文档已创建：${r.url}（${r.blocks} 个内容块）${r.warn ? `\n⚠️ ${r.warn}` : ""}\n请把这个链接告诉用户。`,
          isError: false,
        };
      } catch (e) {
        return { content: `创建飞书文档失败：${e.message}`, isError: true };
      }
    }
    if (tc.name === "delegate_to_expert") {
      if (depth > 0) return { content: "专家不能再委派他人，请直接完成任务。", isError: true };
      const expert = experts.find((e) => e.name === (tc.input.expert || "").trim());
      if (!expert) {
        return { content: `专家不存在: ${tc.input.expert}。可用: ${experts.map((e) => e.name).join(", ")}`, isError: true };
      }
      emit({ type: "expert_start", expert: expert.name, task: tc.input.task });
      const sub = await runTask({
        history: [{ role: "user", content: tc.input.task }],
        emit: (ev) => emit({ ...ev, expert: expert.name }), // 子代理事件带上专家标记
        systemPrompt: expertSystemPrompt(expert),
        depth: depth + 1,
        deadline, // 专家共享同一个总运行时间预算
        stats, // 专家消耗的 token 计入同一笔账
        stopSignal, // 「停止」信号穿透到专家子代理
      });
      emit({ type: "expert_done", expert: expert.name });
      return { content: `【专家 ${expert.name} 的汇报】\n${sub.finalText || "(无文字汇报)"}`, isError: false };
    }
    return await executeTool(tc.name, tc.input, {
      timeoutMs: config.agent.tool_timeout_ms,
      search: config.search,
      media: config.media,
      security: config.security,
      deadline,
      stopSignal,
    });
  }

  /**
   * 运行一次 Agent 任务循环。
   * @param history 统一格式会话历史（会被就地追加）
   * @param emit    事件回调（SSE / IM 进度）
   * @returns { finalText }
   */
  async function runTask({ history, emit = () => {}, systemPrompt, depth = 0, mode = "craft", deadline, stats, stopSignal, getInterject }) {
    const system = (systemPrompt || coordinatorSystemPrompt()) + modePrompt(mode);
    const tools = toolList(depth, mode);
    const maxSteps = config.agent.max_steps || 25;
    // 整个任务（含所有专家子代理）共享一个墙上时间预算，防止无限执行
    if (!deadline) deadline = Date.now() + (config.agent.max_runtime_ms || 1800000);
    // 整个任务（含专家）共享一份 token 账本，任务结束时汇总上报
    if (!stats) stats = { prompt: 0, completion: 0, calls: 0, startedAt: Date.now() };
    let finalText = "";
    let stopNote = "";

    for (let step = 0; step < maxSteps; step++) {
      if (stopSignal && stopSignal.aborted) {
        stopNote = "已手动停止";
        break;
      }
      // 插队消息：在两次模型调用之间的安全间隙注入（工具结果已闭合，不会写坏 tool_calls 序列）
      if (getInterject) {
        for (const m of getInterject()) {
          history.push({ role: "user", content: `【用户插话（在任务执行中补充）】${m}` });
          emit({ type: "interject", text: m, depth });
        }
      }
      if (Date.now() >= deadline) {
        stopNote = `已达最大运行时间（${Math.round((config.agent.max_runtime_ms || 1800000) / 60000)} 分钟）`;
        break;
      }
      emit({ type: "step_start", step: step + 1, depth });

      // 单次模型调用超时 = min(剩余预算, llm_timeout_ms)，防止请求挂死；「停止」信号也能立即掐断请求
      const llmTimeout = Math.max(10000, Math.min(deadline - Date.now(), config.agent.llm_timeout_ms || 300000));
      const timeoutSignal = AbortSignal.timeout(llmTimeout);
      const signal =
        stopSignal && AbortSignal.any ? AbortSignal.any([timeoutSignal, stopSignal]) : timeoutSignal;
      let result;
      try {
        result = await llm.chat({
          system,
          history,
          tools,
          signal,
          onTextDelta: (delta) => emit({ type: "text", delta, depth }),
        });
      } catch (e) {
        if (e.name === "TimeoutError" || e.name === "AbortError") {
          stopNote = stopSignal && stopSignal.aborted ? "已手动停止" : `模型响应超时（${Math.round(llmTimeout / 1000)} 秒无完整响应）`;
          break;
        }
        throw e;
      }

      if (result.usage) {
        stats.prompt += result.usage.prompt;
        stats.completion += result.usage.completion;
        stats.calls++;
      }
      history.push({
        role: "assistant",
        text: result.text,
        toolCalls: result.toolCalls,
        raw: result.raw,
      });
      if (result.text) finalText = result.text;

      if (!result.toolCalls.length) break;

      const toolResults = [];
      for (const tc of result.toolCalls) {
        if (stopSignal && stopSignal.aborted) {
          toolResults.push({ id: tc.id, content: "（用户已停止任务，该工具未执行）", isError: true });
          continue;
        }
        emit({
          type: "tool_use",
          name: tc.name,
          depth,
          purpose: tc.input.purpose || tc.input.expert || tc.input.name || tc.input.path || tc.input.url || "",
          input_preview: previewInput(tc),
        });
        const r = await runToolCall(tc, { emit, depth, deadline, stats, stopSignal });
        emit({
          type: "tool_result",
          name: tc.name,
          depth,
          isError: r.isError,
          preview: String(r.content).slice(0, 800),
        });
        toolResults.push({ id: tc.id, content: String(r.content), isError: r.isError });
      }
      history.push({ role: "tool", results: toolResults });
      emit({ type: "files", files: outputFiles() });

      if (step === maxSteps - 1) stopNote = `已达最大步数（${maxSteps} 步）`;
    }

    if (stopNote) {
      emit({ type: "limit", note: stopNote, depth });
      const notice = `⚠️ ${stopNote}，任务强制收尾。如需继续，可提高设置中的上限或让我接着上次进度做。`;
      finalText = finalText ? `${finalText}\n\n${notice}` : notice;
    }

    const usage = {
      prompt: stats.prompt,
      completion: stats.completion,
      calls: stats.calls,
      elapsed_ms: Date.now() - stats.startedAt,
    };
    if (depth === 0) {
      emit({ type: "usage", model: llm.model, provider: llm.provider, ...usage });
    }
    return { finalText, usage };
  }

  return { runTask, getSkills };
}

function previewInput(tc) {
  if (tc.name === "run_node") return (tc.input.code || "").slice(0, 1500);
  if (tc.name === "run_shell") return (tc.input.command || "").slice(0, 1500);
  if (tc.name === "delegate_to_expert") return `委派给「${tc.input.expert}」：\n${(tc.input.task || "").slice(0, 800)}`;
  try {
    return JSON.stringify(tc.input).slice(0, 500);
  } catch {
    return "";
  }
}

module.exports = { createAgentRuntime };
