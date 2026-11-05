// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 写代码用的那一档。
 *
 * 用户原话：「cli 执行去写代码效率很低」。录了一趟真实请求（改一个函数、跑一次测试，四次模型调用）：
 *   · 每次都带 1.8 万字的办公提示词 + 44 个工具的定义（3.1 万字），合计约 5 万字，改一行代码也是这么多；
 *   · 里面写着「写完必须读回来确认」「长文件分段续写」「成果放到根目录」「进度写 PROGRESS.md」，
 *     这些是给交付文档定的规矩，放到写代码上就是每改一个文件多走几步；
 *   · 飞书、画布、生视频、桌面宠物这些工具定义，模型每一步都要读一遍，还可能真去调。
 *
 * 这里是另一套：提示词只讲写代码，工具只摆写代码用的。别的能力不是没了，load_tools 一句话叫回来，
 * 所以在项目里要一张配图、发一条飞书照样做得到，只是不再每一步都付这笔钱。
 *
 * 只换提示词和工具清单，安全闸、审批、沙箱、记忆、技能一样不少。
 */

/** 写代码常驻的工具 */
const CODE_TOOLS = new Set([
  "read_file", "write_file", "edit_file", "multi_edit", "search_files", "find_files", "list_files",
  "run_shell", "run_node", "shell_output", "shell_kill", "todo_write",
  "web_search", "fetch_url", "read_document", "look_at_image", "check_page",
  "use_skill", "ask_user", "explore", "remember", "forget",
]);

/** 按需叫回来的能力。名字写给模型看，所以要一眼知道里面是什么 */
const TOOL_GROUPS = {
  media: ["generate_image", "generate_video", "text_to_speech", "transcribe_audio", "compose_video", "render_motion", "gen_diagram", "html_to_image"],
  office: ["library_list", "library_read", "library_import", "brand_kit_read", "brand_kit_save", "delivery_page", "record_web_demo", "canvas_manage"],
  browser: ["chrome_cdp", "chrome_tabs", "chrome_read", "chrome_click", "chrome_type", "chrome_scroll", "chrome_wait"],
  messaging: ["send_feishu_message", "send_email", "notify", "feishu_doc", "schedule_task", "list_schedules"],
  extend: ["install_skill", "save_skill", "add_connector", "delegate_to_expert", "delegate_to_team"],
};

const LOAD_TOOLS_TOOL = {
  name: "load_tools",
  description: "写代码默认只摆了读写文件、搜索、跑命令这些工具。要用下面这几组能力时先调它，下一步就能用：media（生图、视频、配音、转写、画图表）、office（资料库、品牌档案、交付页、画布）、browser（操作用户的 Chrome）、messaging（飞书、邮件、定时任务）、extend（装技能、加连接器、委派专家）。",
  input_schema: {
    type: "object",
    properties: { group: { type: "string", enum: Object.keys(TOOL_GROUPS), description: "要叫回来的那一组" } },
    required: ["group"],
  },
};

/**
 * 从全量工具里挑写代码这一档的。mcp__ 开头的是用户自己接的连接器，留着：接它就是要用的
 * @param {Array<{name: string}>} all
 */
function pickTools(all) {
  return [...all.filter((t) => CODE_TOOLS.has(t.name) || t.name.startsWith("mcp__")), LOAD_TOOLS_TOOL];
}

/**
 * 叫回一组工具：往这一趟的清单里加，下一步模型就看得见。这台机器没配的工具不会多出来。
 * @param {string} group @param {Array<{name: string}>} all @param {Array<{name: string}>} tools @param {Set<string>} offered
 * @returns {{ content: string, isError: boolean }}
 */
function loadGroup(group, all, tools, offered) {
  const names = TOOL_GROUPS[/** @type {keyof typeof TOOL_GROUPS} */ (group)];
  if (!names) return { content: `没有「${group}」这一组。有的是：${Object.keys(TOOL_GROUPS).join("、")}`, isError: true };
  const want = new Set(names);
  const added = all.filter((t) => want.has(t.name) && !offered.has(t.name));
  for (const t of added) { tools.push(t); offered.add(t.name); }
  const has = all.filter((t) => want.has(t.name)).map((t) => t.name);
  if (!has.length) return { content: `这台机器上「${group}」这组没有可用的工具（没配或当前环境不支持）。`, isError: false };
  return { content: `已启用：${has.join("、")}。下一步就能调用。`, isError: false };
}

/**
 * 当前仓库的样子。开工前模型多半要先敲这两条，放进提示词省一轮。
 * 拿不到就不写：不是 git 仓库、git 没装、仓库太大超时都不是问题，这段只是省事的。
 * @param {(args: string[]) => any} run 在仓库里跑 git。必须走沙箱，理由见 tools.js sandboxedGit
 */
async function gitContext(run) {
  const git = async (/** @type {string[]} */ args) => {
    const r = await run(args);
    return r.status === 0 ? String(r.stdout || "").trim() : null;
  };
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return "";
  const lines = ((await git(["status", "--short", "--ignore-submodules=all"])) || "").split("\n").filter(Boolean);
  const shown = lines.slice(0, 20).join("\n");
  const more = lines.length > 20 ? `\n…还有 ${lines.length - 20} 个改动` : "";
  const log = (await git(["log", "-3", "--format=%h %s"])) || "";
  return `\n\n## 当前 git 状态（开工时的快照）\n- 分支：${branch}\n${shown ? "- 未提交：\n" + shown + more + "\n" : "- 工作区干净\n"}${log ? "- 最近提交：\n" + log : ""}`;
}

/**
 * @param {{ name: string, cwd: string, osLine: string, shell: string, skillsBlock: string }} o
 */
function systemPrompt({ name, cwd, osLine, shell, skillsBlock }) {
  return `你是 ${name}，在用户电脑上直接读代码、改代码、跑命令的编码智能体。

## 环境
- 项目根目录：${cwd}。相对路径、run_shell 的当前目录都是这里，不要 cd 到别处再回来。
- ${osLine}，命令在用户真实电脑上执行，shell 是 ${shell}。
- 今天几号看下面「当前时间」。查库的最新用法、报错含义时用 web_search，别凭记忆猜版本。

## 怎么干活
1. 先定位再读：search_files、find_files 找到位置，read_file 用 start_line/end_line 只读相关段落。互不依赖的读取放在同一轮一起发，它们是并行执行的。
2. 改已有文件用 edit_file，一个文件改多处用 multi_edit。write_file 只用于新建。工具回执成功就是写进去了，不用再读回来确认。
3. 改完自己验证：跑项目现成的测试、类型检查或构建，没有就写一条最小的复现命令。失败就读报错修掉，别说没跑过的东西通过了。
4. 改动克制：只动任务需要的地方，跟随项目现有写法，不顺手重构，不加没要求的依赖。
5. 直接动手，不问「要不要我改」。只有删除数据、推远端、改线上配置这类收不回来的才先问。方案有分歧时挑最稳的，说一句为什么。
6. 同一处连续失败三次就换思路。卡在只有用户能解决的事（登录、付费、权限）才停下来说明。
7. 开发服务器、watch 这类长命令用 run_shell 的 background:true，再用 shell_output 看输出。
8. 三步以上的活用 todo_write 列清单，边做边更新。

## 回复
简短直接。动手前一句话说打算；做完说清改了什么、怎么验证的、结果是什么，没验证的如实说。提到代码写 文件:行号。不写总结模板，不复述工具输出。${skillsBlock}

## 其他能力
生图配音、资料库、用户的 Chrome、飞书邮件、委派专家这些默认没摆出来，要用时先调 load_tools。`;
}

/** 三种模式写代码时的说法：比办公那份短得多，那份讲的是成品形态的岔路和文档结构 */
function modeBlock(/** @type {string} */ mode) {
  if (mode === "ask") return "\n\n## 当前模式：Ask\n只读代码、回答问题，不改文件、不跑会改东西的命令。";
  if (mode === "plan") return "\n\n## 当前模式：Plan\n只读代码、出计划，不动手。列出要改的文件、每处改什么、怎么验证、有什么风险。";
  return "";
}

module.exports = { CODE_TOOLS, TOOL_GROUPS, LOAD_TOOLS_TOOL, pickTools, loadGroup, gitContext, systemPrompt, modeBlock };
