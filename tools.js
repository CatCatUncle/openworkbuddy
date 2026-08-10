"use strict";
/**
 * Agent 技能工具集 — 全部在 workspace 目录内操作。
 * run_node 是核心：agent 写 JS 代码生成 PPT/Word/Excel/图表/数据处理结果。
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const security = require("./security");

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
      "在工作目录(workspace)中执行一段 Node.js (CommonJS) 代码并返回 stdout/stderr。可以 require 以下已安装的库：pptxgenjs(生成PPT)、docx(生成Word)、exceljs(生成Excel)，以及 Node 内置模块(fs/path等)。生成的成果文件必须写到当前工作目录(即 workspace 根目录)。用于数据处理、文件生成、计算等一切需要编程的任务。",
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
      "在工作目录(workspace)中执行一条 shell 命令（macOS，/bin/zsh -c），返回 stdout/stderr。可以使用系统已安装的命令行工具（git、curl、ffmpeg、lark-cli 等）。适合调用现成 CLI、管道/批量文件操作；需要写程序逻辑时优先用 run_node。命令不要做交互式输入（没有 stdin）。",
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
    description: "在 workspace 中写入一个文本文件（如 .md 报告、.txt、.csv、.html）。路径相对于 workspace。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径，如 report.md" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "读取 workspace 中的一个文本文件内容（最多返回前 50000 字符）。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "相对路径" } },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "列出 workspace 目录下的文件（名称、大小、修改时间）。",
    input_schema: {
      type: "object",
      properties: { dir: { type: "string", description: "相对子目录，默认根目录" } },
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
    description: "抓取一个网页 URL，返回其文本内容（HTML 会粗略去标签，最多 20000 字符）。用于联网查资料。",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
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
];

// ---------- 图像 / 视频 生成（渠道协议：OpenAI 兼容 images API、DashScope 原生、火山方舟异步任务） ----------

function safeOutName(name, ext, stem) {
  let n = String(name || "").trim().replace(/[\/\\:*?"<>|]/g, "_").slice(0, 80);
  if (!n) n = `${stem}_${Date.now()}${ext}`;
  if (!n.toLowerCase().endsWith(ext)) n += ext;
  return n;
}

async function downloadToWorkspace(url, fname) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`下载生成结果失败 HTTP ${r.status}`);
  ensureDirs();
  fs.writeFileSync(path.join(workspaceDir, fname), Buffer.from(await r.arrayBuffer()));
}

async function generateImage(media, input, timeoutMs) {
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
    fs.writeFileSync(path.join(workspaceDir, fname), Buffer.from(b64, "base64"));
  } else await downloadToWorkspace(imgUrl, fname);
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
  await downloadToWorkspace(videoUrl, fname);
  security.audit("视频生成", `${cfg.model}: ${prompt.slice(0, 120)} → ${fname}`, "放行");
  return { content: `视频已生成并存入工作空间：${fname}（模型 ${cfg.model}）`, isError: false };
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

function runNode(code, timeoutMs) {
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
      cwd: workspaceDir,
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

// GUI 启动的 Electron 拿到的 PATH 不含 homebrew，补齐否则 lark-cli/git 等命令找不到
function shellPath() {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(process.env.HOME || "", ".local", "bin")];
  const cur = (process.env.PATH || "").split(":");
  return cur.concat(extra.filter((p) => p && !cur.includes(p))).join(":");
}

function runShell(command, timeoutMs) {
  ensureDirs();
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-c", command], {
      cwd: workspaceDir,
      timeout: timeoutMs,
      env: { ...process.env, PATH: shellPath() },
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

function listFiles(target) {
  if (!fs.existsSync(target)) return "（目录不存在）";
  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.name !== ".tmp")
    .map((e) => {
      const full = path.join(target, e.name);
      const st = fs.statSync(full);
      return `${e.isDirectory() ? "[目录] " : ""}${e.name}\t${st.size} 字节\t${st.mtime.toISOString()}`;
    });
  return entries.length ? entries.join("\n") : "（空目录）";
}

async function fetchUrl(url) {
  const resp = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (OpenBuddy)" },
    signal: AbortSignal.timeout(30000),
  });
  const ct = resp.headers.get("content-type") || "";
  let text = await resp.text();
  if (ct.includes("html")) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ");
  }
  return `HTTP ${resp.status}\n${text.slice(0, 20000)}`;
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
  // 文件工具统一走策略解析：workspace 内默认放行、黑名单硬拦、workspace 外仅白名单
  const resolveFile = (rel) => {
    const r = security.resolvePathWithPolicy(sec, rel, workspaceDir);
    if (!r.allowed) {
      security.audit("文件拦截", `${name}: ${rel}`, "拦截");
      throw new Error(`文件访问被安全中心拦截：${r.reason}`);
    }
    return r.path;
  };
  try {
    ensureDirs();
    switch (name) {
      case "run_node":
        if (sec.runtime_node === false) {
          security.audit("命令拦截", "run_node（内置 Node.js 运行时已停用）", "拦截");
          return { content: "内置 Node.js 运行时已在 设置 → 安全中心 停用，无法执行代码。", isError: true };
        }
        return await runNode(input.code, timeoutMs);
      case "run_shell": {
        const cmd = String(input.command || "");
        const verdict = security.checkCommand(sec, cmd);
        if (verdict.action === "deny" && sec.gateway) {
          security.audit("命令拦截", cmd, "拦截");
          return { content: `命令被安全中心拦截：${verdict.rule}（命中「${verdict.seg}」）`, isError: true };
        }
        if (verdict.action === "ask" && sec.gateway) {
          security.audit("命令审批", cmd, "等待审批");
          const waitMs = Math.min(
            (sec.approval_timeout_s || 120) * 1000,
            opts.deadline ? Math.max(5000, opts.deadline - Date.now() - 10000) : Infinity
          );
          const ok = await security.requestApproval("命令执行", cmd, { timeoutMs: waitMs, stopSignal: opts.stopSignal });
          security.audit("命令审批", cmd, ok ? "已批准" : "已拒绝");
          if (!ok) {
            return {
              content: `命令未获批准（${verdict.rule}）。已在界面弹出审批请求但被拒绝或超时。可以换一种不需要该命令的做法，或让用户在 设置 → 安全中心 → 命令安全 调整名单。`,
              isError: true,
            };
          }
        }
        security.audit("命令执行", cmd, "放行");
        return await runShell(cmd, timeoutMs);
      }
      case "write_file": {
        const p = resolveFile(input.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, input.content, "utf8");
        return { content: `已写入 ${input.path}（${Buffer.byteLength(input.content)} 字节）`, isError: false };
      }
      case "read_file": {
        const p = resolveFile(input.path);
        const content = fs.readFileSync(p, "utf8");
        return { content: content.slice(0, 50000), isError: false };
      }
      case "list_files":
        return { content: listFiles(resolveFile(input.dir || ".")), isError: false };
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
        return await generateImage(opts.media, input, timeoutMs);
      case "generate_video":
        return await generateVideo(opts.media, input, opts);
      case "fetch_url": {
        const gate = security.checkUrl(sec, input.url);
        if (!gate.allowed) {
          security.audit("网络拦截", input.url, "拦截");
          return { content: `网络访问被安全中心拦截：${gate.reason}（设置 → 安全中心 → 网络安全）`, isError: true };
        }
        security.audit("网络访问", `网络访问已执行：${input.url}`, "放行");
        return { content: await fetchUrl(input.url), isError: false };
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

module.exports = { TOOL_DEFS, executeTool, outputFiles, safePath, getWorkspaceDir, setWorkspaceDir, SEARCH_PROVIDERS, searchProviderKey, shellPath };
