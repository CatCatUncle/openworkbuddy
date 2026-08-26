"use strict";
/**
 * Agent 技能工具集 — 全部在 workspace 目录内操作。
 * run_node 是核心：agent 写 JS 代码生成 PPT/Word/Excel/图表/数据处理结果。
 */

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const security = require("./security");
const memory = require("./memory");

// 工作空间可切换（默认项目内 workspace/；可在设置里改成任意文件夹）
let workspaceDir = path.join(__dirname, "workspace");

function getWorkspaceDir() {
  return workspaceDir;
}
function setWorkspaceDir(dir) {
  if (!dir || !path.isAbsolute(dir)) throw new Error("工作空间必须是绝对路径，如 D:\\我的工作区");
  fs.mkdirSync(dir, { recursive: true }); // 无权限/非法路径会在这里抛错
  workspaceDir = path.resolve(dir);
  return workspaceDir;
}
function tmpDir() {
  return path.join(workspaceDir, ".tmp");
}

function ensureDirs() {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(tmpDir(), { recursive: true });
}

/** 把用户/模型给的相对路径解析到 workspace 内，拒绝越界。反斜杠一律按分隔符处理（Windows 风格路径在 mac/linux 上同样生效）。 */
function safePath(rel) {
  const p = path.resolve(workspaceDir, String(rel || ".").replace(/\\/g, "/"));
  if (p !== workspaceDir && !p.startsWith(workspaceDir + path.sep)) {
    throw new Error(`路径越界，只允许访问 workspace 内: ${rel}`);
  }
  return p;
}

const TOOL_DEFS = [
  {
    name: "run_node",
    description:
      "在工作目录(workspace)中执行一段 Node.js (CommonJS) 代码并返回 stdout/stderr。可以 require 以下已安装的库：pptxgenjs(生成PPT)、docx(生成Word)、exceljs(生成Excel)，以及 Node 内置模块(fs/path等)。生成的成果文件必须写到当前工作目录(直接用相对路径/文件名即可，不要写绝对路径)。用于数据处理、文件生成、计算等一切需要编程的任务。",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "要执行的完整 CommonJS 代码" },
        purpose: { type: "string", description: "一句话说明这段代码做什么（展示给用户）" },
      },
      required: ["code"],
    },
  },
  {
    name: "run_shell",
    description:
      "在工作目录(workspace)中执行一条 shell 命令（macOS/Linux 走 zsh/bash，Windows 走 cmd），返回 stdout/stderr。可以使用系统已安装的命令行工具（git、curl、ffmpeg、lark-cli 等）。适合调用现成 CLI、管道/批量文件操作；需要写程序逻辑时优先用 run_node。命令不要做交互式输入（没有 stdin）。",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的完整 shell 命令（可含管道、&& 串联）" },
        purpose: { type: "string", description: "一句话说明这条命令做什么（展示给用户）" },
      },
      required: ["command"],
    },
  },
  {
    name: "write_file",
    description:
      "写文件（.md 报告、.txt、.csv、.html、代码文件都行）。路径相对于 workspace。**只用于新建**；改已有文件的局部内容用 edit_file。写长文档时用 append:true 一节一节续写，不用把前文重新吐一遍。写完会自动做语法/结构自检（JS/JSON/HTML/Markdown），有问题会直接告诉你。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径，如 report.md" },
        content: { type: "string" },
        append: { type: "boolean", description: "true = 追加到文件末尾（长文档分节写、日志累积用），默认 false 覆盖" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "改已有文件里的一段内容（精确替换）。改代码、改文档的既有内容一律用它，不要用 write_file 整篇重写——重写会把你没看过的部分一起弄没。old_text 必须和文件里的原文逐字一致（含缩进），并且在全文中唯一；不唯一就多带几行上下文再来。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径" },
        old_text: { type: "string", description: "要被替换掉的原文（逐字一致，带足上下文保证唯一）" },
        new_text: { type: "string", description: "替换成的新内容（想删掉就传空字符串）" },
        replace_all: { type: "boolean", description: "全文替换所有匹配（改变量名这类才用），默认 false" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "read_file",
    description: "读取 workspace 中的一个文本文件内容（最多返回前 50000 字符）。文件很大时用 start_line/end_line 只读要看的那一段。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径" },
        start_line: { type: "number", description: "从第几行开始读（1 起，可选）" },
        end_line: { type: "number", description: "读到第几行为止（含，可选）" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description:
      "在 workspace 里按内容搜索，返回 文件:行号: 命中行。找函数定义、找某个字符串在哪些文件里用到、改名前找全部调用点，用它，比一个个 read_file 快得多。自动跳过 node_modules/.git/二进制文件。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜的内容（默认按字面量搜）" },
        regex: { type: "boolean", description: "把 query 当正则处理，默认 false" },
        dir: { type: "string", description: "只搜某个子目录，默认整个 workspace" },
        ext: { type: "string", description: "只搜某类扩展名，逗号分隔，如 js,ts,md" },
        max: { type: "number", description: "最多返回多少条命中，默认 60" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_files",
    description: "列出 workspace 目录下的文件（名称、大小、修改时间）。看项目结构时把 depth 调到 2-3 一次看清，别一层层点。",
    input_schema: {
      type: "object",
      properties: {
        dir: { type: "string", description: "相对子目录，默认根目录" },
        depth: { type: "number", description: "递归几层，默认 1（只列当前层），最多 3" },
      },
    },
  },
  {
    name: "remember",
    description:
      "把一条**跨任务都成立**的长期信息记进记忆（用户的偏好、习惯、常用路径、身份、明确的纠正）。用户说「以后都这样」「记住我喜欢…」「别再…」时必须调用。只记结论、一句话，不要记这次任务的过程；绝不记密钥、密码、令牌。",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "一句话结论，如「周报只要三段：进展/问题/下周计划」" },
        shared: { type: "boolean", description: "true = 这台机器上所有账号都适用（团队约定）；默认只记给当前用户" },
      },
      required: ["text"],
    },
  },
  {
    name: "forget",
    description: "删掉之前记住的某条长期记忆（用户说「不用记这个了」「我改主意了」时用）。按内容匹配，只能删共享的和当前用户自己的。",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "要忘掉的那条记忆的内容（可以只给关键片段）" } },
      required: ["text"],
    },
  },
  {
    name: "check_page",
    description:
      "验收一个做好的网页：静态体检（DOCTYPE/viewport/标题/标签闭合/外链资源/本地引用是否存在/正文是否空壳）+ 真浏览器打开一遍（拿标题、正文长度、控制台报错）。**交付 HTML 之前必须跑一次**——白屏和 JS 报错光看源码看不出来。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "workspace 里的 .html 相对路径" } },
      required: ["path"],
    },
  },
  {
    name: "save_skill",
    description:
      "创建或更新一个技能包（保存到 skills/<名称>/skill.md，立即可用）。content 必须包含 frontmatter（---\\nname: 名称\\ndescription: 一句话描述\\n---）和详细指南正文。用于把成熟的工作方法沉淀为可复用技能。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（小写字母/数字/连字符，如 market-research）" },
        content: { type: "string", description: "skill.md 完整内容（含 frontmatter）" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "library_list",
    description: "列出用户资料库中的参考文件与灵感笔记（跨项目共享的长期沉淀素材）。任务涉及用户的偏好、过往素材、参考资料时先查这里。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "library_read",
    description: "读取资料库中的一个文本文件内容（最多返回前 50000 字符）。文件名来自 library_list 的结果。",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "资料库中的文件名" } },
      required: ["name"],
    },
  },
  {
    name: "fetch_url",
    description:
      "抓取一个 URL 的内容（最多 20000 字符）。带真实浏览器请求头，网页会去掉导航/页脚只留正文，JSON 接口原样返回——查资料和直接调数据接口都用它。静态 HTML 是空壳时会自动用内置浏览器渲染一遍再读；地址是 PDF/图片/压缩包时会自动下载到工作目录并告诉你文件名（不会把二进制乱码返回给你）。要抓多个地址就在同一轮里一次性发多个 fetch_url，系统会并发执行。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        render: { type: "boolean", description: "是否允许在抓到空壳时自动渲染兜底，默认 true" },
      },
      required: ["url"],
    },
  },
  {
    name: "render_page",
    description:
      "用内置浏览器真实打开一个页面、等 JS 渲染完再取正文。专治 fetch_url 只拿到空壳的动态站点（B 站、微博、各类单页应用）。比 fetch_url 慢几秒，所以先用 fetch_url，读不到再用它。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        wait_ms: { type: "number", description: "每轮等待渲染的毫秒数，默认 2500，内容多的页面可调大" },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description:
      "联网搜索，返回结果列表（标题、链接、摘要）。用于查资料、找参考来源、了解最新信息；需要某条结果的全文时再用 fetch_url 抓取其 URL。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        count: { type: "number", description: "结果条数，默认 5，最多 10" },
      },
      required: ["query"],
    },
  },
  {
    name: "gen_diagram",
    description:
      "文本→图：流程图/架构图/时序图/数据图表一律用它画，不要手写 SVG。kind: mermaid(流程/时序/类图/甘特/状态) | dot(Graphviz，架构/依赖/拓扑) | echarts(数据图表，source 传 option 对象) | plantuml(UML) | svg(已有 SVG 转 PNG)。生成 <filename>.svg，环境允许时同时出 <filename>.png（插入飞书/Word/PPT 用 PNG）。",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["mermaid", "dot", "echarts", "plantuml", "svg"], description: "图的类型" },
        source: {
          type: "string",
          description: "图源码：mermaid/dot/plantuml 语法原文；echarts 传 option 的 JSON 或 JS 对象字面量（不要带 echarts.init 代码）；svg 传完整 <svg> 内容",
        },
        filename: { type: "string", description: "输出文件名，不带扩展名，如 architecture" },
        width: { type: "number", description: "宽 px，仅 echarts 用（默认 800）" },
        height: { type: "number", description: "高 px，仅 echarts 用（默认 500）" },
      },
      required: ["kind", "source", "filename"],
    },
  },
  {
    name: "generate_image",
    description:
      "用用户配置的图像模型生成一张图片，保存到工作空间。适合配图、海报、封面、商品图。需要先在 设置 → 模型 → 图像模型 配置渠道，未配置时会明确报错。",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "画面描述，越具体越好（主体/风格/构图/光线）" },
        filename: { type: "string", description: "保存文件名（可选，默认 image_时间戳.png）" },
        size: { type: "string", description: "尺寸如 1024x1024（可选，仅 OpenAI 兼容渠道生效）" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_video",
    description:
      "用用户配置的视频模型生成一段短视频，保存到工作空间（生成通常要 1~5 分钟，请耐心等待返回）。需要先在 设置 → 模型 → 视频模型 配置渠道，未配置时会明确报错。",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "视频内容描述（画面/动作/镜头）" },
        filename: { type: "string", description: "保存文件名（可选，默认 video_时间戳.mp4）" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "html_to_image",
    description:
      "把工作空间里的一个本地 HTML 文件用真浏览器渲染成 PNG 图片（桌面版专属）。做小红书图文卡片、公众号头图、视频分镜卡的首选做法：先 write_file 写一个排版好的 HTML（<style> 里内联全部样式，画布尺寸用 body{width:...px;height:...px;margin:0} 定死），再用本工具截图——文字清晰可控，比让图像模型画带字的图靠谱得多。",
    input_schema: {
      type: "object",
      properties: {
        html_file: { type: "string", description: "HTML 文件路径（工作空间内的相对路径）" },
        filename: { type: "string", description: "输出 PNG 文件名（可选，默认 card_时间戳.png）" },
        width: { type: "number", description: "视口宽 px（默认 1242）" },
        height: { type: "number", description: "视口高 px（默认 1656。常用：小红书 3:4=1242x1656，公众号头图 2.35:1=1200x511，视频封面 16:9=1920x1080）" },
        full_page: { type: "boolean", description: "true 时按页面实际内容高度整页截（适合长图/万字长文截图）" },
        wait_ms: { type: "number", description: "加载后等待毫秒再截（默认 500；页面有网络字体/大图时加大到 2000+）" },
      },
      required: ["html_file"],
    },
  },
  {
    name: "text_to_speech",
    description:
      "用用户配置的语音合成模型把文字念成音频文件，保存到工作空间。视频配音、播客旁白就用它。需要先在 设置 → 模型 → 语音合成 配置渠道，未配置时会明确报错。",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要念的文字（上限 5000 字，超长请分段多次合成）" },
        filename: { type: "string", description: "保存文件名（可选，默认 speech_时间戳.mp3）" },
        voice: { type: "string", description: "音色名（可选，默认用设置里配的；如 OpenAI 系的 alloy/nova、通义的 Cherry/Serena）" },
        speed: { type: "number", description: "语速 0.5~2.0（可选，仅 OpenAI 兼容渠道生效）" },
      },
      required: ["text"],
    },
  },
];

// ---------- 图像 / 视频 生成（渠道协议：OpenAI 兼容 images API、DashScope 原生、火山方舟异步任务） ----------

function safeOutName(name, ext, stem) {
  let n = String(name || "").trim().replace(/[\/\\:*?"<>|]/g, "_").slice(0, 80);
  if (!n) n = `${stem}_${Date.now()}${ext}`;
  if (!n.toLowerCase().endsWith(ext)) n += ext;
  return n;
}

async function downloadToWorkspace(url, fname, dir) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`下载生成结果失败 HTTP ${r.status}`);
  ensureDirs();
  fs.writeFileSync(path.join(dir || workspaceDir, fname), Buffer.from(await r.arrayBuffer()));
}

async function generateImage(media, input, timeoutMs, saveDir) {
  const cfg = (media || {}).image || {};
  if (!cfg.base_url || !cfg.model) {
    return { content: "图像模型未配置：请在 设置 → 模型 → 图像模型 填写接口地址 / API Key / 模型名后再用。", isError: true };
  }
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return { content: "缺少 prompt（画面描述）", isError: true };
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${String(cfg.api_key || "").trim()}` };
  const signal = AbortSignal.timeout(Math.max(timeoutMs || 0, 300000));
  const fname = safeOutName(input.filename, ".png", "image");
  let imgUrl = null, b64 = null;
  if (/dashscope/i.test(base)) {
    // DashScope 原生（qwen-image 系）：multimodal-generation，同步返回图片 URL
    const r = await fetch(`${base}/services/aigc/multimodal-generation/generation`, {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: cfg.model, input: { messages: [{ role: "user", content: [{ text: prompt }] }] }, parameters: { watermark: false } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { content: `图像接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}`, isError: true };
    const parts = ((((j.output || {}).choices || [])[0] || {}).message || {}).content || [];
    imgUrl = (parts.find((c) => c.image) || {}).image;
    if (!imgUrl) return { content: "图像接口没有返回图片：" + JSON.stringify(j).slice(0, 300), isError: true };
  } else {
    // OpenAI 兼容 /images/generations（OpenAI、new-api 等聚合网关通用）
    const r = await fetch(`${base}/images/generations`, {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: cfg.model, prompt, n: 1, ...(input.size ? { size: String(input.size) } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { content: `图像接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}`, isError: true };
    const d = (j.data || [])[0] || {};
    imgUrl = d.url;
    b64 = d.b64_json;
    if (!imgUrl && !b64) return { content: "图像接口没有返回图片：" + JSON.stringify(j).slice(0, 300), isError: true };
  }
  if (b64) {
    ensureDirs();
    fs.writeFileSync(path.join(saveDir || workspaceDir, fname), Buffer.from(b64, "base64"));
  } else await downloadToWorkspace(imgUrl, fname, saveDir);
  security.audit("图像生成", `${cfg.model}: ${prompt.slice(0, 120)} → ${fname}`, "放行");
  return { content: `图片已生成并存入工作空间：${fname}（模型 ${cfg.model}）`, isError: false };
}

async function generateVideo(media, input, opts = {}) {
  const cfg = (media || {}).video || {};
  if (!cfg.base_url || !cfg.model) {
    return { content: "视频模型未配置：请在 设置 → 模型 → 视频模型 填写接口地址 / API Key / 模型名后再用。", isError: true };
  }
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return { content: "缺少 prompt（视频内容描述）", isError: true };
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${String(cfg.api_key || "").trim()}` };
  const headers = { "Content-Type": "application/json", ...auth };
  const fname = safeOutName(input.filename, ".mp4", "video");
  // 轮询异步任务：5 秒一查，上限 10 分钟，任务停止信号可中断
  const poll = async (check) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 600000) {
      if (opts.stopSignal && opts.stopSignal.aborted) throw new Error("任务已被停止");
      const got = await check();
      if (got) return got;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error("视频生成超时（10 分钟未完成，可稍后到渠道控制台查看任务）");
  };
  let videoUrl;
  if (/dashscope/i.test(base)) {
    // DashScope 万相（wan 系）：异步提交 + /tasks 轮询
    const r = await fetch(`${base}/services/aigc/video-generation/video-synthesis`, {
      method: "POST", headers: { ...headers, "X-DashScope-Async": "enable" }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: cfg.model, input: { prompt }, parameters: {} }),
    });
    const j = await r.json().catch(() => ({}));
    const taskId = ((j || {}).output || {}).task_id;
    if (!r.ok || !taskId) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}`, isError: true };
    videoUrl = await poll(async () => {
      const s = await fetch(`${base}/tasks/${taskId}`, { headers: auth, signal: AbortSignal.timeout(30000) }).then((x) => x.json());
      const st = ((s || {}).output || {}).task_status;
      if (st === "SUCCEEDED") return s.output.video_url;
      if (st === "FAILED" || st === "CANCELED") throw new Error("视频任务失败：" + JSON.stringify(s.output).slice(0, 200));
      return null;
    });
  } else if (/volces|\/ark\b|ark\./i.test(base)) {
    // 火山方舟（Seedance 系）：contents/generations/tasks 异步 + 轮询
    const r = await fetch(`${base}/contents/generations/tasks`, {
      method: "POST", headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: cfg.model, content: [{ type: "text", text: prompt }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}`, isError: true };
    videoUrl = await poll(async () => {
      const s = await fetch(`${base}/contents/generations/tasks/${j.id}`, { headers: auth, signal: AbortSignal.timeout(30000) }).then((x) => x.json());
      if (s.status === "succeeded") return ((s.content || {}).video_url) || null;
      if (s.status === "failed" || s.status === "cancelled") throw new Error("视频任务失败：" + JSON.stringify(s.error || s).slice(0, 200));
      return null;
    });
  } else {
    return {
      content: "视频渠道暂支持两种协议：DashScope 万相（接口地址含 dashscope，如 https://dashscope.aliyuncs.com/api/v1）或 火山方舟 Seedance（地址含 volces/ark，如 https://ark.cn-beijing.volces.com/api/v3）。当前接口地址两者都不是。",
      isError: true,
    };
  }
  if (!videoUrl) return { content: "视频任务完成但没有返回视频地址", isError: true };
  await downloadToWorkspace(videoUrl, fname, opts.saveDir);
  security.audit("视频生成", `${cfg.model}: ${prompt.slice(0, 120)} → ${fname}`, "放行");
  return { content: `视频已生成并存入工作空间：${fname}（模型 ${cfg.model}）`, isError: false };
}

/** HTML → PNG：真浏览器离屏渲染（htmlshot.js，只有桌面版才有渲染器） */
async function htmlToImage(input, resolveFile, saveDir) {
  const rel = String(input.html_file || "").trim();
  if (!rel) return { content: "缺少 html_file（工作空间里的 HTML 文件路径）", isError: true };
  let p;
  try { p = resolveFile(rel); } catch (e) { return { content: e.message, isError: true }; }
  if (!fs.existsSync(p)) return { content: `文件不存在：${rel}（先用 write_file 把排版 HTML 写进工作空间）`, isError: true };
  const fname = safeOutName(input.filename, ".png", "card");
  let buf;
  try {
    const { renderHtmlToPng } = require("./htmlshot");
    buf = await renderHtmlToPng(p, {
      width: input.width || 1242,
      height: input.height || 1656,
      fullPage: !!input.full_page,
      waitMs: input.wait_ms || 500,
    });
  } catch (e) {
    return { content: `HTML 截图失败：${e.message}`, isError: true };
  }
  ensureDirs();
  fs.writeFileSync(path.join(saveDir || workspaceDir, fname), buf);
  security.audit("HTML截图", `${rel} → ${fname}`, "放行");
  return { content: `已把 ${rel} 渲染成图片：${fname}（${input.width || 1242}x${input.full_page ? "整页" : input.height || 1656}）`, isError: false };
}

/** 文字 → 语音（渠道协议：OpenAI 兼容 /audio/speech、DashScope 原生 qwen-tts） */
async function textToSpeech(media, input, timeoutMs, saveDir) {
  const cfg = (media || {}).tts || {};
  if (!cfg.base_url || !cfg.model) {
    return { content: "语音合成未配置：请在 设置 → 模型 → 语音合成 填写接口地址 / API Key / 模型名后再用。", isError: true };
  }
  const text = String(input.text || "").trim();
  if (!text) return { content: "缺少 text（要念的文字）", isError: true };
  if (text.length > 5000) return { content: `文字太长（${text.length} 字，上限 5000），请分段多次合成再拼接`, isError: true };
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const voice = String(input.voice || cfg.voice || "").trim();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${String(cfg.api_key || "").trim()}` };
  const signal = AbortSignal.timeout(Math.max(timeoutMs || 0, 300000));
  let fname;
  if (/dashscope/i.test(base)) {
    // DashScope 原生（qwen-tts / qwen3-tts-flash 系）：multimodal-generation，返回音频 URL（wav）
    fname = safeOutName(input.filename, ".wav", "speech");
    const r = await fetch(`${base}/services/aigc/multimodal-generation/generation`, {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: cfg.model, input: { text, ...(voice ? { voice } : {}) } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { content: `语音接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}`, isError: true };
    const url = (((j.output || {}).audio || {}).url) || "";
    if (!url) return { content: "语音接口没有返回音频：" + JSON.stringify(j).slice(0, 300), isError: true };
    await downloadToWorkspace(url, fname, saveDir);
  } else {
    // OpenAI 兼容 /audio/speech（OpenAI、new-api 等聚合网关通用）：直接返回音频二进制
    fname = safeOutName(input.filename, ".mp3", "speech");
    const r = await fetch(`${base}/audio/speech`, {
      method: "POST", headers, signal,
      body: JSON.stringify({
        model: cfg.model, input: text,
        ...(voice ? { voice } : {}),
        ...(input.speed ? { speed: Math.min(Math.max(Number(input.speed) || 1, 0.5), 2) } : {}),
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { content: `语音接口错误 ${r.status}: ${t.slice(0, 300)}`, isError: true };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) return { content: "语音接口返回的音频为空", isError: true };
    ensureDirs();
    fs.writeFileSync(path.join(saveDir || workspaceDir, fname), buf);
  }
  security.audit("语音合成", `${cfg.model}: ${text.slice(0, 80)} → ${fname}`, "放行");
  return { content: `语音已合成并存入工作空间：${fname}（模型 ${cfg.model}${voice ? "，音色 " + voice : ""}，约 ${text.length} 字）`, isError: false };
}

/**
 * 上机前先编译一遍。模型最常翻车的写法是在 run_node 里用模板字符串拼 HTML——
 * 网页正文里的反引号、${...}、</script> 会把外层模板字面量提前截断，剩下的正文变成裸代码，
 * 必然 SyntaxError。与其烧一次进程去撞、再把一坨 stderr 丢回去让它自己猜，
 * 不如当场把出错行和正确做法一起说清楚。返回 null 表示语法没问题。
 */
function precheckSyntax(code) {
  try {
    // compileFunction 把代码当函数体编译：顶层 return 合法、顶层 await 非法，和 CommonJS 语义一致
    require("vm").compileFunction(code, [], { filename: "script.cjs" });
    return null;
  } catch (e) {
    if (!(e instanceof SyntaxError)) return null; // 只拦语法错，其它一律照常执行
    const m = /script\.cjs:(\d+)/.exec(e.stack || "");
    const line = m ? Number(m[1]) : 0;
    const src = code.split("\n");
    let msg = `❌ 代码没有执行：语法错误${line ? `（第 ${line} 行）` : ""}\n`;
    if (line) {
      for (let i = Math.max(0, line - 2); i < Math.min(src.length, line + 1); i++) {
        msg += `${i + 1 === line ? ">" : " "} ${i + 1} | ${src[i]}\n`;
      }
    }
    msg += `SyntaxError: ${e.message}\n`;
    // 代码里有反引号 + 写的是网页/文本类文件 → 几乎可以确定是模板字符串被正文截断
    if (code.includes("`") && /\.(html?|md|markdown|css|json|txt|xml|svg)\b/i.test(code)) {
      msg += `\n【最可能的原因】你在用模板字符串（反引号）拼网页/文本正文。正文里只要出现反引号、\${...} 或 </script>，外层模板字面量就会被提前截断，后面的正文全变成裸代码。
【正确做法】HTML / Markdown / CSS / JSON / 纯文本一律改用 write_file 工具直接写内容，不要在 run_node 里拼。run_node 只留给真需要跑逻辑的活（pptxgenjs 出 PPT、docx 出 Word、exceljs 出 Excel、批量处理、算数据）。
现在直接改用 write_file 重写这个文件，不要再试着转义模板字符串。`;
    } else {
      msg += `\n先把这一行的语法改对再重跑；不确定就把这段逻辑拆小、分几次执行。`;
    }
    return msg;
  }
}

function runNode(code, timeoutMs, cwd) {
  ensureDirs();
  const syntaxErr = precheckSyntax(code);
  if (syntaxErr) return Promise.resolve({ content: syntaxErr, isError: true });
  // 脚本在 workspace/.tmp 下执行，向上解析不到本项目的 node_modules；软链一份进去，
  // require("docx"/"pptxgenjs"/"exceljs") 才能稳定命中（NODE_PATH 只是兜底）
  const link = path.join(tmpDir(), "node_modules");
  if (!fs.existsSync(link)) {
    try {
      fs.symlinkSync(path.join(__dirname, "node_modules"), link, "junction");
    } catch {}
  }
  const file = path.join(tmpDir(), `script_${Date.now()}_${Math.floor(Math.random() * 1e6)}.cjs`);
  fs.writeFileSync(file, code, "utf8");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: cwd || workspaceDir,
      timeout: timeoutMs,
      // ELECTRON_RUN_AS_NODE：桌面版里 execPath 是 Electron 二进制，不加这个每跑一次脚本
      // 就弹一个新的 Electron 应用实例（Dock 图标狂蹦）；加了就纯当 node 用
      env: { ...process.env, NODE_PATH: path.join(__dirname, "node_modules"), ELECTRON_RUN_AS_NODE: "1" },
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code2, signal) => {
      fs.rmSync(file, { force: true });
      let result = "";
      if (out) result += `stdout:\n${out.slice(0, 20000)}\n`;
      if (err) result += `stderr:\n${err.slice(0, 10000)}\n`;
      if (signal === "SIGTERM") result += "(执行超时被终止)\n";
      result += `exit code: ${code2}`;
      resolve({ content: result, isError: code2 !== 0 });
    });
    child.on("error", (e) => {
      resolve({ content: `启动失败: ${e.message}`, isError: true });
    });
  });
}

// GUI 启动的 Electron 拿到的 PATH 不含 homebrew，补齐否则 lark-cli/git 等命令找不到。
// Windows 上 GUI 进程的 PATH 本来就全，原样返回即可（分隔符也不同，别硬拼 unix 目录）。
function shellPath() {
  if (process.platform === "win32") return process.env.PATH || "";
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(require("os").homedir(), ".local", "bin")];
  const cur = (process.env.PATH || "").split(path.delimiter);
  return cur.concat(extra.filter((p) => p && !cur.includes(p))).join(path.delimiter);
}

/** 按平台挑 shell：macOS zsh；Linux bash（没有就 sh）；Windows cmd（ComSpec） */
function pickShell(command) {
  if (process.platform === "win32") {
    return { bin: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command], opts: { windowsVerbatimArguments: true } };
  }
  if (process.platform === "darwin") return { bin: "/bin/zsh", args: ["-c", command], opts: {} };
  const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return { bin: bash, args: ["-c", command], opts: {} };
}

function runShell(command, timeoutMs, cwd) {
  ensureDirs();
  return new Promise((resolve) => {
    const sh = pickShell(command);
    const child = spawn(sh.bin, sh.args, {
      cwd: cwd || workspaceDir,
      timeout: timeoutMs,
      env: { ...process.env, PATH: shellPath() },
      ...sh.opts,
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code2, signal) => {
      let result = "";
      if (out) result += `stdout:\n${out.slice(0, 20000)}\n`;
      if (err) result += `stderr:\n${err.slice(0, 10000)}\n`;
      if (signal === "SIGTERM") result += "(执行超时被终止)\n";
      result += `exit code: ${code2}`;
      resolve({ content: result, isError: code2 !== 0 });
    });
    child.on("error", (e) => {
      resolve({ content: `启动失败: ${e.message}`, isError: true });
    });
  });
}

// 资料库（与 server.js 的 /api/library 同一目录）：跨项目共享的参考文件 + 灵感笔记
const LIB_DIR = path.join(__dirname, "data", "library");
const NOTES_FILE = path.join(__dirname, "data", "inspirations.json");

function libraryList() {
  let files = [];
  try {
    files = fs
      .readdirSync(LIB_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => {
        const st = fs.statSync(path.join(LIB_DIR, e.name));
        return `${e.name}\t${st.size} 字节\t${st.mtime.toISOString()}`;
      });
  } catch {}
  let notes = [];
  try {
    notes = JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
  } catch {}
  const parts = [];
  parts.push(files.length ? `【资料文件】（用 library_read 读取）\n${files.join("\n")}` : "【资料文件】（空）");
  parts.push(
    notes.length
      ? `【灵感笔记】\n${notes.map((n) => `- [${(n.at || "").slice(0, 10)}] ${n.text}`).join("\n")}`
      : "【灵感笔记】（空）"
  );
  return parts.join("\n\n");
}

function libraryRead(name) {
  const base = path.basename(String(name || ""));
  if (!base || base.startsWith(".")) throw new Error("文件名不合法");
  return fs.readFileSync(path.join(LIB_DIR, base), "utf8").slice(0, 50000);
}

const LIST_SKIP = new Set([".tmp", "node_modules", ".git", ".DS_Store"]);

/** 列目录。depth>1 时递归展开——看项目结构时一次看清，比一层层 list_files 省好几轮 */
function listFiles(target, depth = 1) {
  if (!fs.existsSync(target)) return "（目录不存在）";
  const maxDepth = Math.min(Math.max(Number(depth) || 1, 1), 3);
  const out = [];
  let truncated = false;
  (function walk(dir, rel, d) {
    if (truncated) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (LIST_SKIP.has(e.name)) continue;
      if (out.length >= 400) {
        truncated = true;
        return;
      }
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (e.isDirectory()) {
        out.push(`[目录] ${r}/`);
        if (d < maxDepth) walk(full, r, d + 1);
      } else {
        out.push(`${r}\t${st.size} 字节\t${st.mtime.toISOString()}`);
      }
    }
  })(target, "", 1);
  if (!out.length) return "（空目录）";
  return out.join("\n") + (truncated ? "\n（超过 400 项，后面的没列——用 dir 指到具体子目录再看）" : "");
}

function countAll(hay, needle) {
  let n = 0,
    i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 精确替换。改已有文件只走这里，不许整篇重写——
 * 重写会把模型没读过的部分一起抹掉，而且用户 diff 一看全是红的，根本审不了。
 * 匹配不上/不唯一都必须报清楚原因（并给出下一步怎么办），不能默默改错地方。
 */
function editFile(file, label, { old_text, new_text, replace_all }) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${label}。新建文件请用 write_file。`);
  const src = fs.readFileSync(file, "utf8");
  const needle = String(old_text == null ? "" : old_text);
  const repl = String(new_text == null ? "" : new_text);
  if (!needle) throw new Error("old_text 是空的：edit_file 必须给出要被替换掉的原文");
  const idx = src.indexOf(needle);
  if (idx < 0) {
    const first = needle.split("\n")[0].trim();
    const lines = src.split("\n");
    const near = first
      ? lines
          .map((l, i) => [i + 1, l])
          .filter(([, l]) => l.includes(first.slice(0, 40)))
          .slice(0, 3)
          .map(([n, l]) => `  第 ${n} 行: ${l.slice(0, 120)}`)
          .join("\n")
      : "";
    throw new Error(
      `没找到 old_text（必须和文件里逐字一致，包括缩进和空行）。` +
        (near ? `\n文件里和它第一行相近的位置：\n${near}\n先 read_file 把那几行原样抄下来再改。` : `\n先 read_file 看看现在的真实内容。`)
    );
  }
  const hits = countAll(src, needle);
  if (hits > 1 && !replace_all) {
    throw new Error(`old_text 在 ${label} 里出现了 ${hits} 次，不唯一，不敢猜改哪一处。多带几行上下文让它唯一；确实要全改就传 replace_all=true。`);
  }
  const out = replace_all ? src.split(needle).join(repl) : src.slice(0, idx) + repl + src.slice(idx + needle.length);
  if (out === src) return `${label} 内容没有变化（new_text 和 old_text 一样）`;
  fs.writeFileSync(file, out, "utf8");
  const line = src.slice(0, idx).split("\n").length;
  const where = replace_all && hits > 1 ? `替换了 ${hits} 处` : `在第 ${line} 行替换了 1 处`;
  return `已修改 ${label}：${where}，${src.length} → ${out.length} 字符`;
}

/**
 * 写完/改完立刻做一次自检。
 *
 * 「改完自检」写在提示词里是没用的——模型该忘还是忘，坏文件就这么交出去了。
 * 所以把它挪到工具里：写完当场查，坏了当场把错误和行号顶回去，它想装看不见都不行。
 * 只查便宜且确定的东西（语法、结构），不做风格评判。
 */
function selfCheck(file, rel) {
  const ext = path.extname(rel).toLowerCase();
  let src = "";
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  if (ext === ".json") {
    try {
      JSON.parse(src);
    } catch (e) {
      return `\n⚠️ JSON 语法没过：${e.message}。先修好再往下走。`;
    }
    return "";
  }
  if ([".js", ".cjs", ".mjs"].includes(ext)) {
    // ELECTRON_RUN_AS_NODE 必须带上：桌面版里 execPath 是 Electron 二进制，不带的话每检查一个 .js
    // 就真的启动一个 Electron 实例去加载用户的文件——满屏弹 JavaScript error 弹窗，还把合法代码误判成语法错误
    const check = (f) =>
      spawnSync(process.execPath, ["--check", f], {
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    let r = check(file);
    // .js 里写 ESM（import/export）在 CJS 下必然报错，但项目可能本来就是 type:module —— 换成 .mjs 再判一次，别误伤
    if (r.status !== 0 && /^\s*(import|export)\s/m.test(src)) {
      const alt = path.join(tmpDir(), `syntax-${Date.now()}.mjs`);
      try {
        fs.mkdirSync(tmpDir(), { recursive: true });
        fs.writeFileSync(alt, src);
        if (check(alt).status === 0) r = { status: 0 };
      } catch {}
      fs.rmSync(alt, { force: true });
    }
    if (r.status !== 0) {
      const msg = String(r.stderr || "").split("\n").filter((l) => l && !/^\s*at /.test(l)).slice(0, 6).join("\n");
      return `\n⚠️ JS 语法没过：\n${msg}\n先修好再往下走（用 edit_file 改那一行，别整篇重写）。`;
    }
    return "";
  }
  if (ext === ".py") {
    // 用 ast.parse 而不是 py_compile：后者会往 __pycache__ 写 .pyc 污染工作目录。
    // 本机没 python3 / spawn 失败一律跳过，环境问题不能报成语法错误
    try {
      const r = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())", file], { encoding: "utf8", timeout: 15000 });
      if (r.status === 1 && /SyntaxError|IndentationError|TabError/.test(String(r.stderr))) {
        const msg = String(r.stderr).split("\n").filter((l) => l && !/^Traceback|^\s*File "<string>"/.test(l)).slice(-4).join("\n");
        return `\n⚠️ Python 语法没过：\n${msg}\n先修好再往下走。`;
      }
    } catch {}
    return "";
  }
  if ([".sh", ".bash", ".zsh"].includes(ext)) {
    try {
      const r = spawnSync(ext === ".zsh" ? "zsh" : "bash", ["-n", file], { encoding: "utf8", timeout: 10000 });
      if (r.status !== 0 && r.stderr) {
        return `\n⚠️ Shell 脚本语法没过：\n${String(r.stderr).split("\n").filter(Boolean).slice(0, 4).join("\n")}\n先修好再往下走。`;
      }
    } catch {}
    return "";
  }
  if (ext === ".md") {
    const fences = (src.match(/^```/gm) || []).length;
    if (fences % 2 === 1) return "\n⚠️ Markdown 里有 ``` 代码围栏没闭合（奇数个），界面会把后面的正文整块吞掉。补上收尾的 ```。";
    return "";
  }
  if (ext === ".html" || ext === ".htm") {
    const issues = auditHtml(src, path.dirname(file)).filter((x) => x.level === "错");
    if (issues.length) return `\n⚠️ 页面结构有问题：${issues.map((x) => x.msg).join("；")}。建议再跑一次 check_page 确认。`;
    return "";
  }
  return "";
}

/** 网页静态体检。只报能确定的问题，不做审美评判 */
function auditHtml(src, baseDir) {
  const out = [];
  const add = (level, msg) => out.push({ level, msg });
  if (!/<!doctype\s+html/i.test(src)) add("警", "没有 <!DOCTYPE html>（浏览器会退到怪异模式，排版会走样）");
  if (!/<meta[^>]+name=["']viewport["']/i.test(src)) add("警", "没有 viewport meta，手机上会缩成一团");
  const title = (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (!title || !title.trim()) add("警", "<title> 是空的（浏览器标签页和分享卡片都靠它）");
  // 标签闭合：只查结构性标签，查全了误报比真问题还多
  for (const tag of ["html", "head", "body", "div", "section", "main", "header", "footer", "table", "ul", "ol", "script", "style"]) {
    const open = (src.match(new RegExp(`<${tag}(\\s|>)`, "gi")) || []).length;
    const close = (src.match(new RegExp(`</${tag}>`, "gi")) || []).length;
    if (open !== close) add("错", `<${tag}> 开 ${open} 个、闭 ${close} 个，对不上`);
  }
  // 外链资源：断网/发给别人就打不开了，单文件页面这是硬伤
  const ext = [...src.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  const cdn = ext.filter((u) => !/^https?:\/\/(fonts\.googleapis|fonts\.gstatic)\./i.test(u));
  if (cdn.length) add("警", `引了 ${cdn.length} 个外部资源（${cdn[0].slice(0, 60)}…），断网或换台电脑就白屏；库和图片请内联或下载到本地`);
  // 本地引用的文件在不在
  const local = [...src.matchAll(/(?:src|href)=["'](?!https?:|data:|#|mailto:|javascript:)([^"']+)["']/gi)].map((m) => m[1]);
  for (const rel of local.slice(0, 40)) {
    const f = path.join(baseDir, rel.split("?")[0].split("#")[0]);
    if (!fs.existsSync(f)) add("错", `引用了不存在的本地文件：${rel}`);
  }
  const text = src.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 30) add("警", "去掉标签后几乎没有正文（可能是内容全靠 JS 生成，也可能就是个空壳）");
  return out;
}

/** 验收网页：静态体检 + 真浏览器打开一遍（拿控制台报错） */
async function checkPage(file, rel) {
  const src = fs.readFileSync(file, "utf8");
  const issues = auditHtml(src, path.dirname(file));
  const lines = [`【静态体检】${rel}（${Buffer.byteLength(src)} 字节）`];
  lines.push(issues.length ? issues.map((x) => `- [${x.level}] ${x.msg}`).join("\n") : "- 没发现结构问题");

  let electron = null;
  try {
    electron = require("electron");
  } catch {}
  if (!electron || !electron.BrowserWindow || !electron.app || !electron.app.isReady()) {
    lines.push("\n【浏览器实测】跳过（当前是命令行模式，没有内置浏览器）。交付前请在桌面版里再跑一次。");
    return lines.join("\n");
  }
  const win = new electron.BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const errs = [];
  try {
    // 控制台报错是白屏的头号原因，光看源码看不出来
    win.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2) errs.push(String(message).slice(0, 300));
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => errs.push(`资源加载失败 ${desc}（${String(url).slice(0, 80)}）`));
    await win.loadURL("file://" + file);
    await new Promise((r) => setTimeout(r, 1200));
    const info = await win.webContents.executeJavaScript(
      "({ t: document.title || '', n: (document.body ? document.body.innerText : '').trim().length, h: document.body ? document.body.scrollHeight : 0 })"
    );
    lines.push(`\n【浏览器实测】标题「${info.t}」· 可见正文 ${info.n} 字 · 页面高 ${info.h}px`);
    if (info.n < 20) lines.push("- [错] 打开后几乎没有可见内容（白屏）。多半是 JS 报错或 CSS 把内容藏了。");
    lines.push(errs.length ? `- [错] 控制台报错 ${errs.length} 条：\n  ${errs.slice(0, 5).join("\n  ")}` : "- 控制台没有报错");
  } catch (e) {
    lines.push(`\n【浏览器实测】打开失败：${e.message}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    if (!electron.BrowserWindow.getAllWindows().length) electron.app.quit();
  }
  return lines.join("\n");
}

const SEARCH_SKIP = new Set([".tmp", "node_modules", ".git", "dist", "build", ".next", "__pycache__", "venv", ".venv", ".cache"]);

/** 全文搜索：找定义、找调用点、改名前找全部引用。跳过二进制和依赖目录 */
function searchFiles(root, { query, regex, ext, max }) {
  const limit = Math.min(Math.max(Number(max) || 60, 1), 300);
  const q = String(query || "");
  if (!q) throw new Error("query 是空的");
  let re;
  try {
    re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  } catch (e) {
    throw new Error(`正则不合法：${e.message}`);
  }
  const exts = String(ext || "")
    .split(",")
    .map((x) => x.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  const hits = [];
  let scanned = 0,
    truncated = false;
  (function walk(dir) {
    if (truncated) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (SEARCH_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (exts.length && !exts.includes(path.extname(e.name).slice(1).toLowerCase())) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.size > 2 * 1024 * 1024) continue; // 大文件多半是产物/数据，不是要找的代码
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (buf.includes(0)) continue; // 二进制
      scanned++;
      const rel = path.relative(root, full) || e.name;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (hits.length >= limit) {
          truncated = true;
          return;
        }
      }
    }
  })(root);
  if (!hits.length) return `（没搜到「${q}」，扫了 ${scanned} 个文本文件）`;
  return (
    hits.join("\n") +
    (truncated
      ? `\n（到 ${limit} 条上限了，后面还有没列出来的——把关键词写细，或用 dir/ext 缩范围）`
      : `\n（共 ${hits.length} 条，扫了 ${scanned} 个文本文件）`)
  );
}

// 自报家门式的 UA（"Mozilla/5.0 (OpenWorkBuddy)"）会被相当多的站点直接判成爬虫：
// B 站回 412 风控页、知乎/微信回跳转页。用真实浏览器的头，拿到的才是用户在浏览器里看到的东西。
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function browserHeaders(url) {
  const h = {
    "User-Agent": BROWSER_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  // 不少接口（B 站、微博、小红书）只认同源 Referer，缺了就当越权
  try {
    const u = new URL(url);
    h.Referer = `${u.protocol}//${u.host}/`;
    h.Origin = `${u.protocol}//${u.host}`;
  } catch {}
  return h;
}

/** 抓回来的东西是不是"没有正文"——SPA 只给了个空壳，或者被反爬挡了 */
function looksEmptyPage(text, status) {
  if (status >= 400) return true;
  const t = (text || "").trim();
  if (t.length < 200) return true;
  return /(请开启\s*JavaScript|enable\s+JavaScript|<noscript)/i.test(t) && t.length < 2000;
}

// PDF / 压缩包 / 图片这类东西按文本读出来是一堆乱码，20000 字乱码进上下文既污染判断又白烧钱。
// content-type 常常是错的（不少站点一律回 octet-stream 甚至 text/html），所以再看一眼文件头。
const BIN_CT = /^(image|audio|video|font)\/|^application\/(pdf|zip|gzip|x-[\w.+-]+|octet-stream|msword|vnd\.)/i;

function looksBinary(ct, buf) {
  if (BIN_CT.test(ct)) return true;
  const h = Buffer.from(buf.slice(0, 8));
  if (h.slice(0, 4).toString("latin1") === "%PDF") return true;
  if (h[0] === 0x50 && h[1] === 0x4b && (h[2] === 3 || h[2] === 5)) return true; // PK.. → zip/docx/xlsx/pptx
  if (h[0] === 0x89 && h.slice(1, 4).toString("latin1") === "PNG") return true;
  if (h[0] === 0xff && h[1] === 0xd8) return true; // jpeg
  if (h.slice(0, 3).toString("latin1") === "GIF") return true;
  return false;
}

/**
 * 按 URL 猜个文件名存进工作目录，重名不覆盖——目录里可能已经躺着用户自己的 report.pdf。
 * 用 wx 独占创建而不是"先看在不在再写"：只读工具是并发跑的，两条 fetch 撞同一个名字时
 * 检查和写入之间那道缝会让后一个把前一个盖掉。
 */
function saveDownload(url, ct, buf, dir) {
  ensureDirs();
  let base = "";
  try { base = decodeURIComponent(path.basename(new URL(url).pathname || "")); } catch {}
  base = base.replace(/[\/\\:*?"<>|\s]/g, "_").slice(0, 80);
  if (!/\.[a-z0-9]{1,6}$/i.test(base)) {
    const m = /^(?:image|audio|video)\/([\w.+-]+)/i.exec(ct) || /^application\/(pdf|zip)/i.exec(ct);
    base = (base || "download") + (m ? "." + m[1].replace(/^x-/, "").replace(/\+.*$/, "") : ".bin");
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const data = Buffer.from(buf);
  for (let i = 1; i < 50; i++) {
    const name = i === 1 ? base : `${stem}_${i}${ext}`;
    try {
      fs.writeFileSync(path.join(dir || workspaceDir, name), data, { flag: "wx" });
      return name;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const name = `${stem}_${Date.now()}${ext}`;
  fs.writeFileSync(path.join(dir || workspaceDir, name), data);
  return name;
}

/**
 * 按真实字符集解码。fetch 的 .text() 一律当 UTF-8 读，
 * 遇到国内那些还在用 GBK 的老站点会整页乱码——模型看到的就是一堆问号，然后判定"这站抓不到"。
 */
function decodeBody(buf, ct) {
  let cs = (String(ct).match(/charset=["']?([\w-]+)/i) || [])[1];
  if (!cs) cs = (Buffer.from(buf.slice(0, 4096)).toString("latin1").match(/charset=["']?([\w-]+)/i) || [])[1];
  cs = String(cs || "utf-8").toLowerCase();
  if (/^(utf-?8|us-ascii|ascii)$/.test(cs)) return Buffer.from(buf).toString("utf8");
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return Buffer.from(buf).toString("utf8");
  }
}

async function fetchUrl(url, { render, saveDir } = {}) {
  let resp;
  try {
    resp = await fetch(url, { redirect: "follow", headers: browserHeaders(url), signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`抓取失败：${e.name === "TimeoutError" ? "30 秒还没响应（站点太慢或需要代理）" : e.message}`);
  }
  const ct = resp.headers.get("content-type") || "";
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared > 30 * 1024 * 1024) {
    return `⚠️ 这个地址是个 ${(declared / 1048576).toFixed(1)} MB 的大文件（${ct || "类型未知"}），没有下载，它也不是网页正文。真需要的话用 run_shell 跑 \`curl -L -o 文件名 "${url}"\` 存下来再处理。`;
  }
  const buf = await resp.arrayBuffer();
  if (looksBinary(ct, buf)) {
    const name = saveDownload(url, ct, buf, saveDir);
    const kind = /pdf/i.test(ct) || Buffer.from(buf.slice(0, 4)).toString("latin1") === "%PDF" ? "pdf" : "";
    return (
      `这不是网页，是二进制文件（${ct || "类型未知"}，${buf.byteLength} 字节），已下载到工作目录：${name}\n` +
      (kind === "pdf"
        ? `读它的文字：先 run_shell 跑 \`${process.platform === "win32" ? "where" : "which"} pdftotext\`，装了就 \`pdftotext -layout "${name}" -\`；没装就在 run_node 里解析。`
        : `按类型处理：Office 文档用 docx/exceljs 读，压缩包先 unzip，图片音视频直接当素材用。`) +
      `\n别再把这个地址当网页正文抓一遍了。`
    );
  }
  const body = decodeBody(buf, ct);
  // JSON 别去标签：那会把 {"a":"<b>"} 洗成一堆空格，接口返回值全废了
  if (ct.includes("json") || /^\s*[[{]/.test(body)) {
    return `HTTP ${resp.status}（${ct || "json"}）\n${body.slice(0, 20000)}`;
  }
  let text = body;
  if (ct.includes("html") || /<html/i.test(body)) {
    text = htmlToText(body);
  }
  // 标题写进首行：模型引用来源时有个人话名字，界面底下的「来源」也直接拿它当标签
  const title = pageTitle(body);
  const head = `HTTP ${resp.status}${title ? ` · ${title}` : ""}`;

  // 空壳/被拦：能渲染就渲染一遍，渲染不了也要把原因说清楚，别让模型以为"这个网站读不到"就此收手
  if (render !== false && looksEmptyPage(text, resp.status)) {
    const rendered = await renderPage(url).catch((e) => ({ error: e.message }));
    if (rendered && rendered.text && rendered.text.length > text.length) {
      return `HTTP ${resp.status}${rendered.title || title ? ` · ${rendered.title || title}` : ""}（静态 HTML 是空壳，已用内置浏览器渲染后读取）\n${rendered.text.slice(0, 20000)}`;
    }
    const why =
      resp.status === 412 || resp.status === 403
        ? `对方站点把这次请求判成了爬虫（HTTP ${resp.status}）`
        : resp.status >= 400
          ? `对方站点返回 HTTP ${resp.status}`
          : "这个页面的正文是 JavaScript 动态渲染的，静态 HTML 里没有内容";
    return (
      `⚠️ 没能拿到正文：${why}。${rendered && rendered.error ? `（渲染兜底也失败：${rendered.error}）` : ""}\n` +
      `别就此打住，换条路：① 找这个页面背后的数据接口直接请求（浏览器 F12 网络面板里那种 api 地址）；` +
      `② 用 run_shell 调本机已装的命令行工具（curl 带完整浏览器请求头、yt-dlp 取视频站元数据等）；` +
      `③ web_search 搜这个页面的内容，从能打开的镜像/转载页拿。至少换三种路子都不行，才算真做不到。\n` +
      `原始返回（前 2000 字）：\n${text.slice(0, 2000)}`
    );
  }
  return `${head}\n${text.slice(0, 20000)}`;
}

/** 从 HTML 里取 <title>，实体解码后压成一行 */
function pageTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (!m) return "";
  return m[1]
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// 导航、页头页脚、侧栏、表单：每页都有、每页都一样，抓十个页面等于把同一堆链接抄十遍。
// 20000 字的预算是有限的，噪声占掉的每一行都是正文没进去的一行。
const NOISE_TAGS = /<(script|style|noscript|template|svg|nav|header|footer|aside|form|iframe|select)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** 正文容器优先：<article> 最准，其次 <main>，都没有就退回 <body>。挑最长的那块，侧栏里的小 article 不算 */
function mainRegion(html) {
  for (const tag of ["article", "main"]) {
    const blocks = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((m) => m[1]);
    if (!blocks.length) continue;
    const best = blocks.sort((a, b) => b.length - a.length)[0];
    if (best && best.length > 400) return best;
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

function htmlToText(html) {
  const cleaned = String(html || "").replace(/<!--[\s\S]*?-->/g, " ").replace(NOISE_TAGS, " ");
  const text = tagsToText(mainRegion(cleaned));
  // 抽过头了（结构不规范、正文压根不在 article/main 里）就退回整页：宁可带点噪声，也不能把内容弄丢
  if (text.length >= 200) return text;
  const full = tagsToText(cleaned);
  return full.length > text.length ? full : text;
}

function tagsToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 用内置浏览器真渲染一遍再取正文。
 * 应用本体跑在 Electron 主进程里，等于随身带了个 Chrome——不装 puppeteer 也能读动态页面。
 * CLI 模式下没有 Electron，如实抛错让上层换路子，不要假装读到了。
 */
async function renderPage(url, { waitMs = 2500, maxWaitMs = 12000 } = {}) {
  let electron;
  try {
    electron = require("electron");
  } catch {
    throw new Error("当前不在桌面应用里跑，没有内置浏览器可用");
  }
  if (!electron || !electron.BrowserWindow || !electron.app || !electron.app.isReady()) {
    throw new Error("内置浏览器不可用（命令行模式）");
  }
  const win = new electron.BrowserWindow({
    show: false,
    width: 1440,
    height: 1000,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  try {
    win.webContents.setUserAgent(BROWSER_UA);
    await win.loadURL(url);
    let text = "";
    const deadline = Date.now() + maxWaitMs;
    // 首屏挂上以后正文还在异步请求，等到内容不再变长（或超时）为止
    for (let last = -1; Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, waitMs));
      text = await win.webContents.executeJavaScript("document.body ? document.body.innerText : ''");
      if (text.length > 400 && text.length === last) break;
      last = text.length;
    }
    const title = await win.webContents.executeJavaScript("document.title || ''").catch(() => "");
    return { text: (text || "").replace(/\n{3,}/g, "\n\n").trim(), title: String(title || "").trim().slice(0, 80) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    // 渲染期间用户把主窗口关了：window-all-closed 那会儿这个隐藏窗口还活着，没触发退出。
    // 这里补一刀，免得应用变成看不见的僵尸进程。
    if (!electron.BrowserWindow.getAllWindows().length) electron.app.quit();
  }
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x?\w+;/g, " ").replace(/\s{2,}/g, " ").trim();
}

// ---- 多 provider 搜索（Jina / Tavily / Brave），统一返回 [{title,url,desc}] ----
async function jinaSearch(key, query, n) {
  const resp = await fetch("https://s.jina.ai/?q=" + encodeURIComponent(query), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "X-Respond-With": "no-content" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Jina 搜索失败（${resp.status}）`);
  const data = (await resp.json()).data || [];
  return data.slice(0, n).map((r) => ({ title: r.title, url: r.url, desc: r.description || "" }));
}

async function tavilySearch(key, query, n) {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: n, include_answer: false, search_depth: "basic" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Tavily 搜索失败（${resp.status}）: ${(await resp.text().catch(() => "")).slice(0, 120)}`);
  const data = (await resp.json()).results || [];
  return data.slice(0, n).map((r) => ({ title: r.title, url: r.url, desc: r.content || "" }));
}

async function braveSearch(key, query, n) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}&text_decorations=false`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Brave 搜索失败（${resp.status}）: ${(await resp.text().catch(() => "")).slice(0, 120)}`);
  const data = ((await resp.json()).web || {}).results || [];
  return data.slice(0, n).map((r) => ({ title: r.title, url: r.url, desc: r.description || "" }));
}

const SEARCH_PROVIDERS = { jina: jinaSearch, tavily: tavilySearch, brave: braveSearch };

function searchProviderKey(cfg, provider) {
  // 每个 provider 独立 key；jina 兼容旧字段 api_key / 环境变量
  if (provider === "jina") return cfg.jina_key || cfg.api_key || process.env.JINA_API_KEY || "";
  if (provider === "tavily") return cfg.tavily_key || process.env.TAVILY_API_KEY || "";
  if (provider === "brave") return cfg.brave_key || process.env.BRAVE_API_KEY || "";
  return "";
}

async function webSearch(query, count, searchCfg) {
  const n = Math.min(Math.max(+count || 5, 1), 10);
  const cfg = searchCfg || {};
  const provider = (cfg.provider || "jina").toLowerCase();

  // 多引擎接力：配置的 provider 打头，其余有 key 的引擎依次顶上（谁被限流换下一个），
  // 全军覆没才退 DuckDuckGo 免费档；每一步的失败原因都记下来带给 agent
  const chain = [provider, ...Object.keys(SEARCH_PROVIDERS).filter((p) => p !== provider)];
  const errors = [];
  for (const p of chain) {
    const fn = SEARCH_PROVIDERS[p];
    const key = searchProviderKey(cfg, p);
    if (!fn || !key) continue;
    try {
      const items = await fn(key, query, n);
      if (items.length) {
        return items
          .map((r, i) => `${i + 1}. ${r.title || "(无标题)"}\n   ${r.url}\n   ${(r.desc || "").slice(0, 300)}`)
          .join("\n\n");
      }
      errors.push(`${p}: 无结果`);
    } catch (e) {
      errors.push(`${p}: ${String(e.message || e).slice(0, 100)}`);
    }
  }

  // 回退：DuckDuckGo HTML 版（免 key）
  let html = "";
  try {
    const resp = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(30000),
    });
    html = await resp.text();
  } catch (e) {
    errors.push(`duckduckgo: ${String(e.message || e).slice(0, 100)}`);
  }
  const titles = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  const results = titles.slice(0, n).map((m, i) => {
    let url = m[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    return `${i + 1}. ${stripTags(m[2])}\n   ${url}\n   ${stripTags((snippets[i] || ["", ""])[1]).slice(0, 300)}`;
  });
  if (results.length) return results.join("\n\n");
  if (html) errors.push("duckduckgo: 页面无结果（可能被反爬拦截）");

  // 兜底 2：百度 HTML 版（免 key；jina/DDG 在国内网络常整条不可达，百度是最后的保命通道）
  try {
    const resp = await fetch("https://www.baidu.com/s?wd=" + encodeURIComponent(query) + "&rn=" + n, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
      signal: AbortSignal.timeout(30000),
    });
    const bhtml = await resp.text();
    const items = [...bhtml.matchAll(/<h3[^>]*>\s*<a[^>]*?href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => ({ url: m[1], title: stripTags(m[2]).trim() }))
      .filter((r) => r.title);
    if (items.length) {
      return (
        "（以下来自百度，链接多为跳转链，用 fetch_url 打开会自动到达真实页面）\n\n" +
        items
          .slice(0, n)
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`)
          .join("\n\n")
      );
    }
    errors.push("baidu: 页面无结果");
  } catch (e) {
    errors.push(`baidu: ${String(e.message || e).slice(0, 100)}`);
  }
  return (
    "（本次搜索无结果" +
    (errors.length ? `。各引擎情况：${errors.join("；")}` : "") +
    "。可以等几十秒再试、换关键词，或用 fetch_url 直接访问已知的相关网站）"
  );
}

async function executeTool(name, input, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  // 安全中心策略（settings 里配置）；未传时用纯默认值（等价于旧行为 + 默认黑名单）
  const sec = opts.security || { ...security.DEFAULTS };
  // 每个对话一个成果子目录（服务器只在默认工作空间下传入）：相对路径读写、脚本 cwd、
  // 生成/下载的产物都落到这里，多个对话不再把工作空间根目录搅成一锅
  let fileBase = workspaceDir;
  if (opts.baseDir) {
    const b = path.resolve(workspaceDir, String(opts.baseDir));
    if (b === workspaceDir || b.startsWith(workspaceDir + path.sep)) {
      fileBase = b;
      try { fs.mkdirSync(fileBase, { recursive: true }); } catch {}
    }
  }
  // 文件工具统一走策略解析：workspace 内默认放行、黑名单硬拦、workspace 外仅白名单
  const resolveFile = (rel) => {
    const r = security.resolvePathWithPolicy(sec, rel, workspaceDir, fileBase);
    if (!r.allowed) {
      security.audit("文件拦截", `${name}: ${rel}`, "拦截");
      throw new Error(`文件访问被安全中心拦截：${r.reason}`);
    }
    // 成果子目录下没有、工作空间根下有 → 用根下那个（读旧对话的产物/共享素材不用写全路径）
    if (fileBase !== workspaceDir && !fs.existsSync(r.path)) {
      const r2 = security.resolvePathWithPolicy(sec, rel, workspaceDir);
      if (r2.allowed && fs.existsSync(r2.path)) return r2.path;
    }
    return r.path;
  };
  /**
   * 闸门统一走这里：拦下就返回一段给模型看的说明，放行返回 null。
   * run_shell 和 run_node 用的是同一套 —— 只守 shell 那扇门是守不住的，
   * 一句 require("child_process") 就从旁边过去了。
   */
  const passGate = async (verdict, label, text, { force = false } = {}) => {
    // force：权限档位（只看不动/每步都问）是用户当场选的档，不受安全闸门总开关影响
    if ((!sec.gateway && !force) || verdict.action === "allow") return null;
    if (verdict.action === "deny") {
      security.audit(label + "拦截", text, "拦截");
      return { content: `${label}被安全中心拦截：${verdict.rule}（命中「${verdict.seg}」）`, isError: true };
    }
    security.audit(label + "审批", text, "等待审批");
    const waitMs = Math.min(
      (sec.approval_timeout_s || 120) * 1000,
      opts.deadline ? Math.max(5000, opts.deadline - Date.now() - 10000) : Infinity
    );
    const ok = await security.requestApproval(label + "执行", text, {
      timeoutMs: waitMs,
      stopSignal: opts.stopSignal,
      rule: verdict.rule || "",
      ruleKey: verdict.ruleKey || "",
      source: opts.taskLabel || "",
    });
    security.audit(label + "审批", text, ok ? "已批准" : "已拒绝");
    if (ok) return null;
    return {
      content: `${label}未获批准（${verdict.rule}）。已在界面弹出审批请求但被拒绝或超时。可以换一种不需要它的做法，或让用户在 设置 → 安全中心 调整名单。`,
      isError: true,
    };
  };
  try {
    ensureDirs();
    switch (name) {
      case "run_node": {
        if (sec.runtime_node === false) {
          security.audit("命令拦截", "run_node（内置 Node.js 运行时已停用）", "拦截");
          return { content: "内置 Node.js 运行时已在 设置 → 安全中心 停用，无法执行代码。", isError: true };
        }
        const code = String(input.code || "");
        const blocked = await passGate(security.checkCode(sec, code), "代码", code.slice(0, 500));
        if (blocked) return blocked;
        return await runNode(code, timeoutMs, fileBase);
      }
      case "run_shell": {
        const cmd = String(input.command || "");
        const blocked = await passGate(security.checkCommand(sec, cmd), "命令", cmd);
        if (blocked) return blocked;
        security.audit("命令执行", cmd, "放行");
        return await runShell(cmd, timeoutMs, fileBase);
      }
      case "gen_diagram": {
        const rel = String(input.filename || "diagram").replace(/\.(svg|png)$/i, "");
        const blocked = await passGate(security.checkWrite(sec, rel + ".svg"), "写文件", rel + ".svg", { force: true });
        if (blocked) return blocked;
        const { renderDiagram } = require("./diagram");
        const r = await renderDiagram({
          kind: input.kind, source: String(input.source || ""), width: input.width, height: input.height, theme: input.theme,
        });
        const svgPath = resolveFile(rel + ".svg");
        fs.mkdirSync(path.dirname(svgPath), { recursive: true });
        fs.writeFileSync(svgPath, r.svg);
        let msg = `已生成 ${rel}.svg（${(Buffer.byteLength(r.svg) / 1024).toFixed(1)}KB）`;
        if (r.png) {
          fs.writeFileSync(resolveFile(rel + ".png"), r.png);
          msg += `、${rel}.png（${(r.png.length / 1024).toFixed(1)}KB，插飞书/Word 用这个）`;
        }
        if (r.note) msg += `。${r.note}`;
        return { content: msg, isError: false };
      }
      case "write_file": {
        const rel = String(input.path || "");
        const p = resolveFile(rel);
        const blocked = await passGate(security.checkWrite(sec, rel), "写文件", rel, { force: true });
        if (blocked) return blocked;
        const existed = fs.existsSync(p);
        const oldSize = existed ? fs.statSync(p).size : 0;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const body = String(input.content || "");
        const n = Buffer.byteLength(body);
        if (input.append) {
          fs.appendFileSync(p, body, "utf8");
          const warn = selfCheck(p, rel);
          return { content: `已追加到 ${rel}（+${n} 字节，现共 ${fs.statSync(p).size} 字节）${warn}`, isError: !!warn };
        }
        fs.writeFileSync(p, body, "utf8");
        const warn = selfCheck(p, rel);
        // 覆盖和新建要说清楚：整篇重写一个已有文件，多半是该用 edit_file 却偷懒了
        return {
          content:
            (existed
              ? `已覆盖 ${rel}（原 ${oldSize} 字节 → 现 ${n} 字节）。提醒：改已有文件的局部内容用 edit_file，整篇重写会连你没读过的部分一起换掉。`
              : `已新建 ${rel}（${n} 字节）`) + warn,
          isError: !!warn,
        };
      }
      case "edit_file": {
        const rel = String(input.path || "");
        const p = resolveFile(rel);
        const blocked = await passGate(security.checkWrite(sec, rel), "改文件", rel, { force: true });
        if (blocked) return blocked;
        const msg = editFile(p, rel, input);
        const warn = selfCheck(p, rel);
        return { content: msg + warn, isError: !!warn };
      }
      case "read_file": {
        const p = resolveFile(input.path);
        const content = fs.readFileSync(p, "utf8");
        const s = Math.max(0, Number(input.start_line) || 0);
        const e = Math.max(0, Number(input.end_line) || 0);
        if (s || e) {
          const lines = content.split("\n");
          const from = Math.max(1, s || 1);
          if (from > lines.length) return { content: `${input.path} 只有 ${lines.length} 行，start_line=${from} 超出范围`, isError: true };
          const to = Math.min(lines.length, e || lines.length);
          const body = lines
            .slice(from - 1, to)
            .map((l, i) => `${from + i}\t${l}`)
            .join("\n");
          return { content: `（${input.path} 第 ${from}-${to} 行，全文共 ${lines.length} 行）\n${body}`.slice(0, 50000), isError: false };
        }
        const cut = content.length > 50000;
        return {
          content: content.slice(0, 50000) + (cut ? `\n\n（文件 ${content.length} 字符，这里只给了前 50000。要看后面用 start_line/end_line）` : ""),
          isError: false,
        };
      }
      case "list_files":
        return { content: listFiles(resolveFile(input.dir || "."), input.depth), isError: false };
      case "search_files":
        return { content: searchFiles(resolveFile(input.dir || "."), input), isError: false };
      case "remember": {
        const r = memory.add({ text: input.text, user: opts.memory && opts.memory.user, shared: !!input.shared });
        return { content: r.note, isError: !r.ok };
      }
      case "forget": {
        const r = memory.forget({ text: input.text, user: opts.memory && opts.memory.user });
        return { content: r.note, isError: r.removed === 0 };
      }
      case "check_page": {
        const rel = String(input.path || "");
        const p = resolveFile(rel);
        if (!fs.existsSync(p)) return { content: `文件不存在：${rel}`, isError: true };
        const report = await checkPage(p, rel);
        return { content: report, isError: /\[错\]/.test(report) };
      }
      case "save_skill": {
        const name = String(input.name || "").trim();
        if (!/^[a-z0-9][a-z0-9-_]{1,40}$/.test(name)) {
          return { content: "技能名不合法：请用小写字母/数字/连字符，如 market-research", isError: true };
        }
        const dir = path.join(__dirname, "skills", name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "skill.md"), input.content, "utf8");
        return { content: `技能「${name}」已保存并生效（skills/${name}/skill.md）`, isError: false };
      }
      case "library_list":
        return { content: libraryList(), isError: false };
      case "library_read":
        return { content: libraryRead(input.name), isError: false };
      case "generate_image":
        return await generateImage(opts.media, input, timeoutMs, fileBase);
      case "generate_video":
        return await generateVideo(opts.media, input, { ...opts, saveDir: fileBase });
      case "html_to_image":
        return await htmlToImage(input, resolveFile, fileBase);
      case "text_to_speech":
        return await textToSpeech(opts.media, input, timeoutMs, fileBase);
      case "fetch_url": {
        const gate = security.checkUrl(sec, input.url);
        if (!gate.allowed) {
          security.audit("网络拦截", input.url, "拦截");
          return { content: `网络访问被安全中心拦截：${gate.reason}（设置 → 安全中心 → 网络安全）`, isError: true };
        }
        security.audit("网络访问", `网络访问已执行：${input.url}`, "放行");
        return { content: await fetchUrl(input.url, { render: input.render !== false, saveDir: fileBase }), isError: false };
      }
      case "render_page": {
        const gate = security.checkUrl(sec, input.url);
        if (!gate.allowed) {
          security.audit("网络拦截", input.url, "拦截");
          return { content: `网络访问被安全中心拦截：${gate.reason}（设置 → 安全中心 → 网络安全）`, isError: true };
        }
        security.audit("网络访问", `浏览器渲染已执行：${input.url}`, "放行");
        try {
          const r = await renderPage(input.url, { waitMs: Math.min(Math.max(input.wait_ms || 2500, 500), 8000) });
          if (!r.text) return { content: "渲染成功但页面正文为空——多半是要登录，或者内容在 iframe / canvas 里。", isError: true };
          return { content: (r.title ? `HTTP 200 · ${r.title}\n` : "") + r.text.slice(0, 20000), isError: false };
        } catch (e) {
          return { content: `渲染失败：${e.message}`, isError: true };
        }
      }
      case "web_search":
        security.audit("网络访问", `联网搜索：${input.query}`, "放行");
        return { content: await webSearch(input.query, input.count, opts.search), isError: false };
      default:
        return { content: `未知工具: ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `工具执行出错: ${e.message}`, isError: true };
  }
}

/** 列出 workspace 下的文件（含子目录，最深 3 层、最多 500 个；name 为相对路径。前端按目录分组展示，@ 补全同源） */
function outputFiles() {
  ensureDirs();
  const out = [];
  const SKIP = new Set([".tmp", "node_modules", ".git"]);
  (function walk(dir, rel, depth) {
    if (depth > 3 || out.length >= 500) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 500) return;
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, r, depth + 1);
      } else if (e.isFile()) {
        const st = fs.statSync(full);
        out.push({ name: r, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  })(workspaceDir, "", 1);
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

module.exports = { TOOL_DEFS, executeTool, outputFiles, safePath, fetchUrl, renderPage, htmlToText, getWorkspaceDir, setWorkspaceDir, SEARCH_PROVIDERS, searchProviderKey, shellPath };
