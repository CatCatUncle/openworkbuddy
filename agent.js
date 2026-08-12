"use strict";
/**
 * Agent 核心运行时 — 被 Web 界面、IM 接入、专家委派共同复用。
 * 主 Agent 是"协调者"：可直接干活，也可通过 delegate_to_expert 把子任务委派给专家子智能体。
 */

const { TOOL_DEFS, executeTool, outputFiles, getWorkspaceDir } = require("./tools");
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

const DELEGATE_TEAM_TOOL = {
  name: "delegate_to_team",
  description:
    "把一个完整任务交给一个专家团（智能体团队）。团里的专家会按名单顺序接力：每位都能看到前面同事的汇报和产出文件，做完交给下一位，最后返回全队的汇报汇总。适合一句话就要走完「调研→分析→成稿→做PPT」整条流水线的任务；只需要一个环节时用 delegate_to_expert 更省时间。",
  input_schema: {
    type: "object",
    properties: {
      team: { type: "string", description: "专家团名称，必须是专家团列表中的一个" },
      task: {
        type: "string",
        description: "交给整个团的任务描述。要自包含：目标、已有输入（文件名）、最终期望交付物。团里每位专家都会看到这段原文。",
      },
    },
    required: ["team", "task"],
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
const os = require("os");
const MEMORY_FILE = path.join(__dirname, "data", "memory.md");

// ================= 成果核验（治「幻觉执行」） =================
// 模型有时在文本里"表演"跑命令并声称文件已生成，实际一个工具都没调。
// 收尾前核对它声称的产物是否真在磁盘上，不在就打回去要求真实执行。
const CLAIM_RE = /(生成成功|导出成功|保存成功|创建成功|已生成|已保存|已导出|已创建|已写入|生成完毕|制作完成|下载|✅)/;
const DELIVER_EXTS = "pptx|pptm|docx|doc|xlsx|xls|pdf|zip|mp4|mov|png|jpe?g|gif|csv|html|md|svg";

/** 在工作目录里按文件名找：返回字节数，找不到返回 -1 */
function sizeInWorkspace(name) {
  let root;
  try { root = getWorkspaceDir(); } catch { return -1; }
  const stack = [[root, 0]];
  let visited = 0;
  while (stack.length && visited < 3000) {
    const [dir, d] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      visited++;
      if (e.isFile() && e.name === name) {
        try { return fs.statSync(path.join(dir, e.name)).size; } catch { return -1; }
      }
      if (e.isDirectory() && d < 4 && e.name !== "node_modules" && !e.name.startsWith(".")) stack.push([path.join(dir, e.name), d + 1]);
    }
  }
  return -1;
}

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

/**
 * 返回 [{ name, why }]：why = "missing"（磁盘上根本没有）或 "empty"（文件在但 0 字节）。
 * 空文件也必须打回——写到一半失败、编码出错都会留下一个 0 字节的壳，
 * 只查存在性的话这种"交付"会被判为成功，用户点开才发现是空的。
 */
function missingDeliverables(text) {
  if (!text || !CLAIM_RE.test(text)) return [];
  const found = new Set();
  const pathRe = new RegExp(`(?:~|\\/(?:Users|home|tmp|private|var))\\/[^\\s"'\`（）()<>|,;：:*?]+\\.(?:${DELIVER_EXTS})\\b`, "gi");
  for (const m of text.match(pathRe) || []) found.add(m);
  const bareRe = new RegExp(`(?:^|[\\s"'\`（(：:、，=])([\\w\\u4e00-\\u9fff().&＆_-]+\\.(?:${DELIVER_EXTS}))\\b`, "gim");
  let mm;
  while ((mm = bareRe.exec(text))) { if (!mm[1].includes("/")) found.add(mm[1]); }
  const bad = [];
  for (const p of found) {
    let size;
    if (path.isAbsolute(p)) size = sizeOf(p);
    else if (p.startsWith("~")) size = sizeOf(path.join(os.homedir(), p.slice(1)));
    else size = sizeInWorkspace(p);
    if (size < 0) bad.push({ name: p, why: "missing" });
    else if (size === 0) bad.push({ name: p, why: "empty" });
  }
  return bad;
}

// ================= 上下文预算（治「跑到一半突然 400」） =================
// 工具结果是上下文的绝对大头：read_file 5 万字、fetch_url 2 万字、run_shell 3 万字，
// 一个跑满 25 步的深度调研任务能堆到几十万字符，把模型上下文撑爆——表现是任务跑到一半
// 突然报 LLM 接口错误 400，前面做的全丢。这里在每次请求前把「老的」工具结果截短：
// 模型真正需要原文的是刚做完那几步，更早的它已经把结论写进自己的回复里了。
// 只截 tool 结果、不删任何消息——OpenAI 侧 tool_calls 必须有对应的 tool 消息应答，删了就是 400。
const CTX_KEEP_HEAD = 300; // 老结果保留的开头字符数（够模型认出这步干了什么）

function historyChars(history) {
  let n = 0;
  for (const e of history) {
    if (e.role === "user") n += String(e.content || "").length;
    // Claude 路径回传的是 raw（含 thinking 块，往往比 text 大好几倍），要按真正发出去的那份算
    else if (e.role === "assistant") n += e.raw ? JSON.stringify(e.raw).length : String(e.text || "").length + JSON.stringify(e.toolCalls || []).length;
    else if (e.role === "tool") for (const r of e.results || []) n += String(r.content || "").length;
  }
  return n;
}

/** 就地截短老工具结果直到进预算，返回省下的字符数（0 = 本来就没超） */
function trimHistory(history, maxChars, keepRecent = 3) {
  let total = historyChars(history);
  if (total <= maxChars) return 0;
  const toolIdx = [];
  history.forEach((e, i) => { if (e.role === "tool") toolIdx.push(i); });
  // 最近 keepRecent 轮工具结果留原文，从最老的开始截
  const older = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  let saved = 0;
  for (const i of older) {
    for (const r of history[i].results || []) {
      const s = String(r.content || "");
      if (s.length <= CTX_KEEP_HEAD * 2) continue;
      r.content = s.slice(0, CTX_KEEP_HEAD) + `\n…（原输出 ${s.length} 字符，为控制上下文长度已截断。需要完整内容请重新调用工具获取。）`;
      const cut = s.length - r.content.length;
      saved += cut;
      total -= cut;
      if (total <= maxChars) return saved;
    }
  }
  return saved;
}

/** 系统提示词里注入真实日期：不给的话模型会拿训练截止日当"今天"，凡是"最新/本周"的任务全歪 */
function envToday() {
  const d = new Date();
  const week = "日一二三四五六"[d.getDay()];
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日（星期${week}）`;
}

function safeWorkspaceDir() {
  try { return getWorkspaceDir(); } catch { return "（未设置）"; }
}

function readMemory() {
  try {
    return fs.readFileSync(MEMORY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function createAgentRuntime({ config, llm, mcpManager, experts, expertTeams = [] }) {
  /** 团里挂着的成员可能已被删掉，取用时按当前专家表过一遍 */
  function teamMembers(team) {
    return (team.members || []).map((n) => experts.find((e) => e.name === n)).filter(Boolean);
  }
  // 技能每次任务实时加载（save_skill 新建的技能立即可用）
  function getSkills() {
    return loadSkills();
  }

  function baseSystemPrompt() {
    const skills = getSkills();
    let p = `你是 OpenWorkBuddy，一个 AI 办公智能体。用户用自然语言下达办公任务，你自主思考、拆解任务、规划步骤、调用工具执行，最终交付可验证的成果。

## 当前环境
- 今天是 ${envToday()}。凡是涉及"最新/今年/近期/本周"的判断一律以这个日期为准，不要用你训练数据里的时间。需要最新事实（价格、政策、版本号、人事、榜单）必须 web_search 现查，不许凭记忆答。
- 工作目录（成果文件都放这里）：${safeWorkspaceDir()}
- 运行环境：${process.platform === "darwin" ? "macOS" : process.platform}，本机执行，run_shell 拿到的是用户的真实电脑。

## 工具能力
- run_node：执行 Node.js 代码。已安装库：pptxgenjs(PPT)、docx(Word)、exceljs(Excel)，以及 Node 内置模块。
- run_shell：执行 shell 命令（macOS zsh），可用系统已装的 CLI 工具（git、curl、ffmpeg、lark-cli 等）。调现成命令行工具用它，写程序逻辑用 run_node。
- write_file / read_file / list_files：读写工作目录中的文件
- web_search：联网搜索（标题/链接/摘要），查资料先搜索定位来源
- fetch_url：抓取网页全文或直接调 JSON 接口（带真实浏览器请求头；配合 web_search 的结果 URL 用）
- render_page：用内置浏览器真打开页面、等 JS 渲染完再取正文，专治动态站点（B 站、微博、单页应用）
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
1. 接到任务先简短说明计划（2-4 句），然后立即执行，不要等用户确认。信息不全时不要停下来反问，自己挑一个最合理的默认假设、写在开场白里继续做；只有缺了它整件事会白做的关键信息（比如要发给谁、用哪个账号）才允许问，且一次问完。
2. 涉及已有文件/项目的任务，动手前先 list_files、read_file 把现场看清楚，不要凭文件名猜内容，更不要把用户已有的文件直接覆盖掉。
3. 成果文件写到工作目录根目录，文件名有意义。**HTML / Markdown / CSS / JSON / 纯文本一律用 write_file 直接写内容，绝不要在 run_node 里用模板字符串拼**——网页正文里几乎必然出现 \`\${...}\`、反引号或 </script\>，会把外层模板字面量截断，直接 SyntaxError。run_node 只留给真的需要跑逻辑的活（pptxgenjs 出 PPT、docx 出 Word、exceljs 出 Excel、批量处理、算数据）。
4. 交付前自检：凡是生成的文件，写完必须再 read_file / list_files 读回来确认真的存在、内容完整（长文档至少核对开头结尾和篇幅），发现残缺就当场修好再交付。
5. 代码报错要读懂原因、修正重试，不要放弃；同一处连续失败 3 次就换思路，别在死路上空转。
5.1 抓不到网页不等于做不到（高频翻车点）。一条路走不通就换下一条，**同一个目标至少真试满三种路子**才允许说抓不到：
   - fetch_url 拿回来是空壳 → 用 render_page 真渲染一遍；
   - 页面正文是异步加载的 → 去找它背后的数据接口（站点常见的 api.xxx.com/... 形式）直接 fetch_url，接口返回 JSON 比解析 HTML 靠谱得多；
   - 接口要签名/被风控挡 → 用 run_shell 调本机现成的命令行工具（curl 带完整请求头、yt-dlp 取视频站元数据、rss 源等），本机装了什么先 \`which\` 一下再说没有；
   - 还是不行 → web_search 搜同样的内容，从能打开的转载页/镜像站/第三方数据站拿。
   把「需要登录 Cookie / 需要官方 API 权限」当结论直接停手，是不合格的交付。真要用户的登录态才继续，先把不需要登录也能拿到的那部分做完再说。
5.2 **不许把选择题丢给用户**：严禁用「请告诉我你的选择：1... 2... 3...」「需要我尝试哪种方式？」这类问句结束回合。你有工具，方案的优劣你自己判断得了——挑最可能成的那个直接动手，失败了再换。同理，严禁把代码贴在回复里说"我能这样做"——能跑就 run_node / run_shell 真跑，回复里只放结论。
6. 完成后简要总结做了什么、生成了哪些文件。
7. 始终用中文交流——包括报错说明、失败复盘、自我纠正这些中途叙述，任何时候都不许切成英文。工具返回的英文报错要翻成人话讲给用户听（原始报错可以放进代码块，但结论必须是中文）。
8. 用户消息里的「@某文件名」指工作目录中的文件（用 read_file 读取）；「/某技能名」表示要求使用该技能（先 use_skill 加载）；「【任务类型：X】」是场景标签，按该场景的最佳实践来做。
9. 工具能做到的事必须自己调工具真正执行，严禁把命令贴在回复里让用户代跑（除非确实需要用户本人登录/授权才能做的事）。
10. 严禁虚构执行结果（红线）：没有真实调用工具，绝不能声称「已生成/已保存/生成成功」，不能编造文件大小、页数、命令输出或下载链接（sandbox: 开头的链接是假的，禁止输出）。做不到就如实说做不到。系统会自动核验你声称生成的文件是否真实存在，虚构会被当场打回重做。
11. 严禁虚构事实（红线）：数字、日期、人名、机构、政策条款、引用链接，只能来自工具真实拿到的内容。查不到就写「未查到公开信息」，不许用"大约""据业内估算"糊过去，更不许编造看起来很像的 URL。交付物里每个关键数字都要能指回来源。

## 回复排版（重要）
- 结构固定三段式：**动手前**先用一两句说明你准备做什么、怎么做；**过程中**工具调用之间的过渡叙述控制在一两句话（界面会把中间过程折叠收起）；**收尾**最后一条消息必须是完整、自洽的最终结论/交付说明——用户默认只看到开场白和这段结论，别把关键信息只写在中间过程里。
- 回复用 Markdown 结构化输出：小标题（##/###）分段、要点用列表、关键结论/数字用**加粗**、代码和命令放代码块、对比数据用表格。
- 代码块必须用三反引号围栏包裹并标注语言（\`\`\`python、\`\`\`bash、\`\`\`text 等），围栏要成对闭合。严禁把语言名单独写一行然后直接贴裸代码——那样界面无法渲染成代码块。凡是代码、命令、文件树、日志、XML 片段，一律进围栏（SVG 信息图见下一节，用 \`\`\`svg 围栏会被直接渲染成图）。
- 结论先行，再给必要细节；不要把内心推演过程大段写出来（"让我想想""我先检查一下"这类只保留一句即可）。
- 不要虚构进度和等待（"预计耗时X秒，请稍候""正在生成中"这类话不要说）：要么直接调工具真的去做，要么直接给结果。

## 画信息图（内联 SVG，强烈推荐）
把结构化的结论画成一张图，比十行文字管用。**直接在回复正文里写 \`\`\`svg 围栏**，界面会边输出边把它画出来（用户看到图自己长出来），不用写文件、不用调工具。
- 什么时候画：人物/品牌/产品「画像」、方案对比、流程与时间线、数据拆解、能力雷达、结构总览——凡是"几个维度 + 每个维度几条结论"的东西都适合。一次回复最多 1～2 张，别刷屏。
- 图是结论的可视化，**不能代替文字结论**：图前面照样要有一段说人话的总结。图里的每个数字都必须是工具真拿到的，编数字画得再好看也是红线。
- 硬性写法（不遵守就会显示不出来或在暗色模式下变成黑底黑字）：
  1. 根元素必须带 \`viewBox\`，**不要写死 width/height 的像素值**，界面会自适应铺满；
  2. 文字颜色、描边颜色只用这几个语义变量：\`var(--color-text-primary)\`（标题/正文）、\`var(--color-text-secondary)\`（次要说明）、\`var(--color-text-tertiary)\`（弱化标注）、\`var(--color-border-primary|secondary|tertiary)\`（分隔线/边框）、\`var(--color-bg-subtle)\`（浅底块）；字体统一 \`font-family="var(--font-sans)"\`。品牌色/强调色（高亮标签、数据条）可以直接写 hex；
  3. SVG **不会自动折行**：中文长句要自己拆成多个 \`<tspan x="…" dy="…">\`，或者提前断句，别指望它自己换行；
  4. \`<script>\`、\`<foreignObject>\`、外链图片/字体一律会被安全层清掉，别用；要用 \`<style>\` 就用类名，界面会自动把它限死在这张图里。
- 排版参考：竖版长图（viewBox 宽 680、高按内容给）最稳；顶部大标题+副标题，中间分区块，每块一个小节标题+若干条目，区块之间用细分隔线，末尾可以留一行数据来源。`;
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
      p += `\n\n## 可委派的专家（delegate_to_expert）\n`;
      p += experts
        .map((e) => `- ${e.name}${e.alias ? `·${e.alias}` : ""}：${e.description}${(e.skills || []).length ? `（擅长技能：${e.skills.join("、")}）` : ""}`)
        .join("\n");
    }
    const teams = expertTeams.filter((t) => teamMembers(t).length >= 2);
    if (teams.length) {
      p += `\n\n## 可委派的专家团（delegate_to_team，整队接力）\n`;
      p += teams.map((t) => `- ${t.name}：${t.description || "（无说明）"}｜成员依次为 ${teamMembers(t).map((e) => e.name).join(" → ")}`).join("\n");
    }
    if (experts.length) {
      p += `\n\n委派原则：
- 简单任务自己直接做，别为了"显得专业"绕一圈委派，那只是白烧 token 和时间。
- 需要单一环节的专业能力（只是查资料 / 只是做 PPT）→ delegate_to_expert。
- 一句话要走完整条流水线（调研→分析→成稿→做图/做 PPT）→ 直接 delegate_to_team，别自己一个个串。
- 委派时任务描述必须自包含：目标、输入文件名、期望产出文件名。专家看不到你和用户的对话历史。
- 拿回专家汇报后，你要自己核一遍：说生成的文件真的存在吗？结论和用户要的对得上吗？不对就补做或再委派，别直接把专家的话转述给用户就收工。`;
    }
    return p;
  }

  function expertSystemPrompt(expert) {
    let p =
      baseSystemPrompt() +
      `\n\n## 你的专家角色：${expert.name}${expert.alias ? `（花名「${expert.alias}」）` : ""}\n${expert.system}`;
    if ((expert.skills || []).length) {
      p += `\n\n## 你的专属技能（动手前先 use_skill 加载，再按技能里的规范做）\n${expert.skills.map((s) => `- ${s}`).join("\n")}`;
    }
    p += `\n\n你是被主协调者委派的专家。完成后用一段简明汇报结束：做了什么、产出了哪些文件（写真实文件名）、关键结论、还有什么没做完。汇报会被原样交回协调者，别写客套话。`;
    return p;
  }

  const READ_ONLY_TOOLS = ["read_file", "list_files", "fetch_url", "render_page", "web_search", "library_list", "library_read"];

  function toolList(depth, mode) {
    if (mode === "ask" || mode === "plan") {
      return [...TOOL_DEFS.filter((t) => READ_ONLY_TOOLS.includes(t.name)), USE_SKILL_TOOL];
    }
    const tools = [...TOOL_DEFS, USE_SKILL_TOOL, ...mcpManager.toolDefs()];
    if ((config.im || {}).feishu && (config.im.feishu.app_id || config.im.feishu.doc_app_id)) tools.push(FEISHU_DOC_TOOL);
    if (depth === 0 && experts.length) tools.push(DELEGATE_TOOL);
    // 团委派只给主协调者：专家在团里接力时 depth 已经 >0，再让它组团会套娃
    if (depth === 0 && expertTeams.some((t) => teamMembers(t).length >= 2)) tools.push(DELEGATE_TEAM_TOOL);
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
    if (tc.name === "delegate_to_team") {
      if (depth > 0) return { content: "专家不能再委派他人，请直接完成任务。", isError: true };
      const team = expertTeams.find((t) => t.name === (tc.input.team || "").trim());
      if (!team) {
        return { content: `专家团不存在: ${tc.input.team}。可用: ${expertTeams.map((t) => t.name).join(", ") || "（无）"}`, isError: true };
      }
      const members = teamMembers(team);
      if (members.length < 2) return { content: `专家团「${team.name}」的成员已不足 2 人，请改用 delegate_to_expert。`, isError: true };

      emit({ type: "team_start", team: team.name, members: members.map((m) => m.name), task: tc.input.task });
      const reports = [];
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (stopSignal && stopSignal.aborted) break;
        // 时间预算是全队共享的一份，兜不住就诚实收尾，不要让后面的人空跑一轮再超时
        if (Date.now() >= deadline) {
          reports.push({ name: m.name, text: "（未执行：全队已达最大运行时间）" });
          break;
        }
        // 每位成员看到的是「原始任务 + 前面同事的汇报」，接力靠这段拼装，不靠共享上下文
        const brief =
          `【全队任务】${tc.input.task}\n\n` +
          `【你的位置】你是第 ${i + 1}/${members.length} 棒${i === members.length - 1 ? "（最后一棒，你要产出最终交付物）" : ""}\n\n` +
          (reports.length
            ? `【前面同事的汇报】\n${reports.map((r) => `— ${r.name}：\n${r.text}`).join("\n\n")}\n\n只做你这一棒该做的部分，直接用同事已产出的文件，不要重做他们做过的事。`
            : `你是第一棒，从零开始。`);
        emit({ type: "expert_start", expert: m.name, team: team.name, task: brief });
        const sub = await runTask({
          history: [{ role: "user", content: brief }],
          emit: (ev) => emit({ ...ev, expert: m.name, team: team.name }),
          systemPrompt: expertSystemPrompt(m),
          depth: depth + 1,
          deadline,
          stats,
          stopSignal,
        });
        emit({ type: "expert_done", expert: m.name, team: team.name });
        reports.push({ name: m.name, text: sub.finalText || "(无文字汇报)" });
      }
      emit({ type: "team_done", team: team.name });
      return {
        content:
          `【专家团「${team.name}」的全队汇报】（${reports.length}/${members.length} 棒完成）\n\n` +
          reports.map((r) => `— ${r.name}：\n${r.text}`).join("\n\n"),
        isError: false,
      };
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
   * 强制收尾时的最后一句话。不给工具、单独一小段超时预算（撞的就是时间上限，不能再等 5 分钟），
   * 失败就悄悄算了——收尾说明没拿到，也不该把整个任务变成一次报错。
   */
  async function wrapUp({ history, system, stopNote, emit, depth, stats }) {
    history.push({
      role: "user",
      content: `【系统】任务已到上限被强制收尾（${stopNote}）。现在不要再调用任何工具，直接给用户一段收尾说明：
1. 已经做完了什么、产出了哪些文件（只写真实存在的文件名，没生成就别写）；
2. 还差哪些没做完；
3. 下次接着做的话，从哪一步继续最省事。
用中文，简明扼要，不要客套。`,
    });
    try {
      trimHistory(history, config.agent.max_context_chars || 120000); // 最后一次工具输出可能刚把上下文顶爆，先压一压
      const result = await llm.chat({
        system,
        history,
        tools: [],
        signal: AbortSignal.timeout(Math.min(90000, config.agent.llm_timeout_ms || 300000)),
        onTextDelta: (delta) => emit({ type: "text", delta, depth }),
      });
      if (result.usage) {
        stats.prompt += result.usage.prompt;
        stats.completion += result.usage.completion;
        stats.calls++;
      }
      history.push({ role: "assistant", text: result.text, toolCalls: [], raw: result.raw });
      return result.text || "";
    } catch (e) {
      console.warn("[agent] 收尾说明没拿到:", e.message);
      history.pop(); // 把那条【系统】指令撤掉，免得下一轮对话里挂着一句没人回的话
      return "";
    }
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
    let honestyRetries = 0;
    let trimmedChars = 0; // 本次任务累计被上下文预算截掉的工具输出字符数
    // 任务开始时先记一份工作目录快照，files 事件带上「这一轮真正新增/改动的文件」。
    // 这件事必须在服务端算：前端那份 mtime 快照是活的，历史回放时早就对不上了，算出来永远是空。
    const baseline = new Map();
    for (const f of outputFiles()) baseline.set(f.name, f.mtime);
    const emitFiles = () => {
      const files = outputFiles();
      const changed = files.filter((f) => baseline.get(f.name) !== f.mtime).map((f) => f.name);
      for (const f of files) baseline.set(f.name, f.mtime);
      emit({ type: "files", files, changed });
    };

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

      // 发请求前先把老工具结果压进上下文预算，宁可丢细节也不能让整个任务撞 400 全丢
      const trimmed = trimHistory(history, config.agent.max_context_chars || 120000);
      if (trimmed) {
        trimmedChars += trimmed;
        console.warn(`[agent] 上下文超预算，已截断历史工具输出 ${trimmed} 字符（depth=${depth} step=${step + 1}）`);
        // 丢了东西就明说，别让用户以为模型一直看得见全部原文
        emit({ type: "trim", chars: trimmedChars, depth });
      }

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

      if (!result.toolCalls.length) {
        // 成果核验：声称已生成的文件不在磁盘上、或者只是个 0 字节空壳 → 打回去重做（最多打回 2 次）
        const bad = missingDeliverables(result.text);
        if (bad.length && honestyRetries < 2 && Date.now() < deadline - 30000) {
          honestyRetries++;
          const gone = bad.filter((b) => b.why === "missing").map((b) => b.name);
          const empty = bad.filter((b) => b.why === "empty").map((b) => b.name);
          const parts = [];
          if (gone.length) parts.push(`磁盘上根本不存在：${gone.slice(0, 5).join("、")}`);
          if (empty.length) parts.push(`文件在但是 0 字节空文件：${empty.slice(0, 5).join("、")}`);
          const list = parts.join("；");
          history.push({
            role: "user",
            content: `【系统自动核验】你上一条回复声称已生成/可获取这些文件，但核验不通过——${list}。在文字里写命令和"✅ 生成成功"不等于执行；写出来是空文件也不算交付。现在立即用 write_file / run_node / run_shell 真实生成一遍，写完用 read_file 或 list_files 读回来确认内容真的在里面，再如实汇报。如果执行失败，就如实报告失败原因和报错内容。严禁再声称不存在或空的文件已生成。`,
          });
          emit({ type: "text", delta: `\n\n> ⚠️ **成果核验未通过**：${list}，已自动打回要求真实执行。\n\n`, depth });
          continue;
        }
        break;
      }

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
        if (!r.isError) {
          const srcs = collectSources(tc.name, tc.input, r.content);
          if (srcs.length) emit({ type: "sources", items: srcs, depth });
        }
        toolResults.push({ id: tc.id, content: String(r.content), isError: r.isError });
      }
      history.push({ role: "tool", results: toolResults });
      emitFiles();

      if (step === maxSteps - 1) stopNote = `已达最大步数（${maxSteps} 步）`;
    }

    if (stopNote) {
      emit({ type: "limit", note: stopNote, depth });
      // 撞上限时，finalText 往往是半句过程叙述（"我先看一下这个文件"），直接抛给用户等于没有交代。
      // 再花一次调用让它把话说完：做到哪、有什么、还差什么。手动停止的不做——用户喊停就是不想再花钱。
      if (!(stopSignal && stopSignal.aborted)) {
        const wrapped = await wrapUp({ history, system, stopNote, emit, depth, stats });
        if (wrapped) finalText = wrapped;
      }
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
  if (tc.name === "delegate_to_team") return `委派给专家团「${tc.input.team}」：\n${(tc.input.task || "").slice(0, 800)}`;
  try {
    return JSON.stringify(tc.input).slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * 从一次工具调用里挖出"这一步真访问了哪些网页"，给回复底下的「来源」用。
 * 只认工具层的实际入参与实际返回，不认模型嘴上说参考了什么——那种"来源"经常是编的。
 */
function collectSources(name, input, content) {
  const text = String(content || "");
  if (name === "fetch_url" || name === "render_page") {
    const url = String(input?.url || "");
    // 抓失败的不算来源——放进「来源」里等于告诉用户"我看过这页"，其实没看到
    if (!/^https?:\/\//i.test(url) || /没能拿到正文/.test(text.slice(0, 200))) return [];
    const title = (text.match(/^HTTP\s+\d+\s*·\s*([^\n（(]+)/) || [])[1] || "";
    return [{ url, title: title.trim().slice(0, 80) }];
  }
  if (name === "web_search") {
    // webSearch 的输出是「序号. 标题 \n 缩进的 URL \n 摘要」
    return [...text.matchAll(/^\s*\d+\.\s*(.+)\n\s+(https?:\/\/\S+)/gm)]
      .map((m) => ({ title: m[1].trim().slice(0, 80), url: m[2] }))
      .slice(0, 10);
  }
  return [];
}

module.exports = { createAgentRuntime, missingDeliverables, trimHistory, historyChars, collectSources };
