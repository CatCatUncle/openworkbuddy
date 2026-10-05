// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Agent 技能工具集 — 全部在 workspace 目录内操作。
 * run_node 是核心：agent 写 JS 代码生成 PPT/Word/Excel/图表/数据处理结果。
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR, dataPath, appPath } = require("../platform/paths");
const { spawn, spawnSync } = require("child_process");
const { outDecoder } = require("../util/out-decode");
const security = require("../core/safety/security");
const memory = require("../core/memory/memory");
const mediaModels = require("../core/model/media-models"); // 图/视频/语音/视觉的多模型选择（同一把 Key 配多个型号）
const cdp = require("../platform/render/cdp"); // 可选的本机 Chrome CDP：不捆绑浏览器、不连接远程地址
const quota = require("../core/billing/quota"); // 按次计费的第三方 API：调之前问一句额度，调完记一笔
const mediaHealth = require("../core/model/media-health"); // 连不通的渠道熔断：撞过的硬错下次连请求都不发
const checkpoints = require("./checkpoints"); // 改文件前留检查点：整步能退回去，审批卡上先看 diff
const cmdRisk = require("../core/safety/cmd-risk");
const memGate = require("./gates/memory-gate"); // 名单外那条命令跑之前先判一句（纯判据，不发请求）
const jev = require("../core/judge/jev"); // 判断模型：上面那一问就是它答的
const HK = require("./hooks"); // config.json 里 agent.hooks 配的命令：跑命令前、改完文件后
const CT = require("./code-tools"); // 写代码那几样：按名找文件、后台命令、进度清单、改前查有没有被动过
const depsGuard = require("../platform/deps-guard"); // 工作空间嵌在应用目录里时，npm/pnpm 别往上找到应用自己的 package.json
const winname = require("../util/winname"); // Windows 不认的文件名（a:b 会悄悄写进备用数据流）
// 媒体那几样（生图 / 生视频 / 配音 / 转写 / 看图 / 截图 + 生成缓存）和画布状态拆到 src/tools/ 下了，这里只是转手。
// 它们要用的工作目录根还在本文件（下面那套 ALS），递过去的是取值函数、用到时才读，按请求切换的根照样生效
const MEDIA = require("../tools/media");
const CANVAS = require("../tools/canvas");
MEDIA.bindWorkspace(() => ws(), () => ensureDirs());
CANVAS.bindWorkspace(() => ws());
const TTSB = require("../tools/tts-batch"); // 按句配音（text_to_speech 的 segments 模式）
const {
  OUT_EXT_ALIAS, safeOutName, anySignal, sleepFor, fetchRetry, mediaKey, IMAGE_EXT, shrinkForVision, readImageInput,
  mainCanSee, pickEye, lookAtImage, savedAt, refImageUris, I2V_RE, T2V_RE, generateImage, generateVideo, htmlToImage,
  textToSpeech, AUDIO_EXT, ASR_MAX_BYTES, srtTime, transcribeAudio, withGenCache, unitsFor, mediaProviderOf,
  asrModelOf
} = MEDIA;
const {
  canvasSafeName, canvasSetCurrentName, canvasNormalizeState, canvasReadState, canvasWriteState, canvasList,
  canvasManage
} = CANVAS;

// 工作空间可切换（默认项目内 workspace/；可在设置里改成任意文件夹）
let workspaceDir = dataPath("workspace");

/**
 * 多租户的工作目录隔离就在这三行上。
 *
 * 走的是 AsyncLocalStorage 而不是「给每个函数加一个 root 参数」：workspaceDir 在这个文件里
 * 被读了二十来处（safePath、outputFiles、executeTool、图片视频落盘、shell 的 cwd、备份历史…），
 * 而 agent.js / im.js / cli.js 又各自 getWorkspaceDir() 了十几次。挨个加参数要改五十多个调用点，
 * 漏一个就是一个「A 公司的模型能读到 B 公司文件」的洞——而这种洞不会报错，只会安静地发生。
 *
 * ALS 的语义正好对上：一次 HTTP 请求 / 一次任务从头到尾是同一条异步链，在链头 run() 一下，
 * 链上所有的 ws() 自动读到同一个根，包括 await 之后、setTimeout 里、子函数里。
 * 没设过就退回默认根 —— 单机个人版一行行为都没变。
 */
const { AsyncLocalStorage } = require("async_hooks");
const wsStore = new AsyncLocalStorage();
function ws() {
  return wsStore.getStore() || workspaceDir;
}
/** 在指定工作目录根下跑一段（同步或异步都行）。root 为空 = 用默认根 */
function withWorkspace(root, fn) {
  if (!root) return fn();
  return wsStore.run(path.resolve(root), fn);
}
/**
 * 把**当前这条异步链**的工作目录换掉，一直到这条链跑完。
 *
 * 跟 withWorkspace 是一回事，区别只在写法：withWorkspace 要求把后面的代码整段包进回调里。
 * /api/chat 那个处理函数从鉴权到收尾三百多行，为了换个根把它整体缩进一层，
 * 得到的是一份没人看得懂的 diff 和一堆没必要的合并冲突。
 *
 * 安全性上两者一样：express 每个请求各自一条异步链，enterWith 只染当前这条，
 * 别的请求、后台定时任务都串不进来。
 */
function enterWorkspace(root) {
  if (!root) return;
  wsStore.enterWith(path.resolve(root));
}
function getWorkspaceDir() {
  return ws();
}

/**
 * 组织级的工具策略（企业管理后台「客户端安全 / 网络设置」那两页配的东西）。
 *
 * 跟工作目录同样的理由走 ALS：拦命令、拦域名这种事只要有一条旁路就等于没拦，
 * 而旁路往往是「某个工具没走那个参数」。绑在请求这条异步链上，executeTool
 * 无论被谁调到都读得到同一份策略。没设过 = null = 不限制，单机个人版一行行为不变。
 */
const polStore = new AsyncLocalStorage();
function orgPolicy() {
  return polStore.getStore() || null;
}
function withPolicy(policy, fn) {
  if (!policy) return fn();
  return polStore.run(policy, fn);
}
/**
 * 域名闸：黑名单命中就拦，白名单非空时不在名单里也拦。
 * 匹配到**后缀**（example.com 覆盖 a.example.com），但要求边界是点，
 * 否则 evilexample.com 会被 example.com 白名单放进来。
 */
function hostAllowed(policy, url) {
  const p = policy || orgPolicy();
  if (!p) return { ok: true };
  const allow = Array.isArray(p.net_allow) ? p.net_allow.filter(Boolean) : [];
  const deny = Array.isArray(p.net_deny) ? p.net_deny.filter(Boolean) : [];
  if (!allow.length && !deny.length) return { ok: true };
  let host = "";
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return { ok: true }; } // 不是个 URL 就不归这道闸管
  const hit = (list) => list.some((d) => {
    const x = String(d).trim().toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").split("/")[0];
    return x && (host === x || host.endsWith("." + x));
  });
  if (hit(deny)) return { ok: false, why: `本组织的网络设置把 ${host} 放进了黑名单` };
  if (allow.length && !hit(allow)) return { ok: false, why: `本组织的网络设置只放行白名单里的域名，${host} 不在名单里（名单：${allow.join("、")}）` };
  return { ok: true };
}

/** 组织关掉了「允许运行命令行」。两个入口共用一段说明，别让模型以为换个工具就能绕过去 */
function orgBlocksShell() {
  const p = orgPolicy();
  return !!p && p.allow_shell === false;
}
/**
 * 在 run_node / run_shell 里自己拉常驻的 Chrome（带调试口，或无头又不是一次性导出）→ 直接退回，指到现成工具上。
 * 这不是安全闸，是分流：模型自己 spawn 的 Chrome 是 detached + unref 的，跑完没人收，
 * 端口还写死，一个任务里试几次就在后台挂出好几个无头 Chrome。chrome_cdp 拉起的那个有闲置自关、
 * 进程退出连带收，html_to_image / check_page 走内置渲染器根本不起新进程。
 * 所以任何权限档位下都退回——全自动也不代表该绕开现成工具。
 */
const DIY_BROWSER_BIN = /google[ -]chrome|chromium|chrome\.exe|msedge|microsoft edge|brave browser|headless_shell/i;
const DIY_BROWSER_DEBUG = /--remote-debugging-(?:port|pipe)/i;
// --print-to-pdf / --screenshot / --dump-dom 是一次性的：干完自己退出，不会挂着，技能里正经在用
const DIY_BROWSER_ONESHOT = /--(?:print-to-pdf|screenshot|dump-dom)\b/i;
function diyBrowser(src) {
  const s = String(src || "");
  if (!DIY_BROWSER_BIN.test(s)) return null;
  const lingers = DIY_BROWSER_DEBUG.test(s) || (/--headless\b/i.test(s) && !DIY_BROWSER_ONESHOT.test(s));
  if (!lingers) return null;
  security.audit("命令拦截", "自己拉无头/调试 Chrome，已指到 chrome_cdp", "拦截");
  return {
    content: "别自己起 Chrome（带 --remote-debugging-port / --headless 的那种）：这样拉起来的浏览器跑完没人收，会一直挂在后台吃 CPU。按用途换现成工具：\n" +
      "- 网页截图、出长图/封面 → html_to_image\n" +
      "- 验收做好的网页（报错、白屏、实际效果）→ check_page\n" +
      "- 读 JS 渲染后的正文 → fetch_url 加 render:\"force\"\n" +
      "- 要点按钮、输入、在页面里执行 JS、按时间采样页面状态 → chrome_cdp（navigate 后用 evaluate；用完发 action:\"close\"）",
    isError: true,
  };
}

function shellBlocked(tool) {
  security.audit("命令拦截", `${tool}（本组织已关闭「允许运行命令行」）`, "拦截");
  return {
    content: "本组织在企业管理后台关闭了「允许运行命令行」，run_shell 和 run_node 都用不了。写文件、抓网页、生成图表这些工具不受影响；确实要跑命令，找组织管理员开。",
    isError: true,
  };
}
function netBlocked(url, why) {
  security.audit("网络拦截", String(url), "拦截");
  return { content: `这个地址没抓成：${why}。要放行找组织管理员改「企业设置 → 网络设置」。`, isError: true };
}
/**
 * 全局**默认**根（= config.workspace_dir）。租户请求里 getWorkspaceDir() 返回的是租户根，
 * 所以凡是要跟「服务器的默认目录」比对、或者要写回 config 的地方，必须用这个，别用上面那个——
 * 用错了就是分公司管理员点一下设置，把总部所有人的成果目录搬走。
 */
function getDefaultWorkspaceDir() {
  return workspaceDir;
}
/** 改的是**默认**根（config.workspace_dir）。租户根不走这里，走 withWorkspace */
function setWorkspaceDir(dir, platform = process.platform) {
  if (!dir || !path.isAbsolute(dir)) throw new Error("工作空间必须是绝对路径，如 D:\\我的工作区");
  fs.mkdirSync(dir, { recursive: true }); // 无权限/非法路径会在这里抛错
  workspaceDir = winCanonCase(path.resolve(dir), platform);
  return workspaceDir;
}
/**
 * Windows：用户手敲的 d:\work 和盘上的 D:\Work 是同一个目录，字符串却不一样。存盘上真实的大小写，
 * 后面拿它跟模型给的绝对路径、跟 realpath 出来的路径比，才不会互相对不上。
 * 只认「只差大小写」的那种：realpath 还会把 subst 盘、网络盘、目录链接展开成另一条路，
 * 那是用户自己选的写法，换掉了设置页上显示的就不是用户填的那个了。别的系统原样返回
 */
function winCanonCase(p, platform = process.platform) {
  if (platform !== "win32") return p;
  try {
    const real = fs.realpathSync.native(p);
    return real.toLowerCase() === p.toLowerCase() ? real : p;
  } catch { return p; }
}
/**
 * p 是不是 root 本身或在它里面。Windows 的文件名不分大小写：工作区存的是 d:\work、模型写的是 D:\work\a.md，
 * 照字面比就成了「路径越界」，用户在自己的工作区里写个文件都被拦。别的系统照字面比，一点不变
 */
function underRoot(p, root, platform = process.platform) {
  let a = String(p), b = String(root);
  if (platform !== "win32") return a === b || a.startsWith(b + path.sep);
  a = a.toLowerCase(); b = b.toLowerCase();
  // 整个盘当工作区（D:\）时 root 自己就带着结尾的反斜杠，再补一个就谁都不在里面了
  return a === b || a.startsWith(b.endsWith("\\") ? b : b + "\\");
}
function tmpDir() {
  return path.join(ws(), ".tmp");
}

function ensureDirs() {
  fs.mkdirSync(ws(), { recursive: true });
  fs.mkdirSync(tmpDir(), { recursive: true });
}

/** 把用户/模型给的相对路径解析到 workspace 内，拒绝越界。反斜杠一律按分隔符处理（Windows 风格路径在 mac/linux 上同样生效）。 */
function safePath(rel) {
  const p = path.resolve(ws(), String(rel || ".").replace(/\\/g, "/"));
  if (!underRoot(p, ws())) {
    throw new Error(`路径越界，只允许访问 workspace 内: ${rel}`);
  }
  return p;
}

/**
 * 跟 safePath 同一套越界判定，只是根由调用方给。
 *
 * 为什么非要这个：成果文件在会话里记的是**相对**路径（任务_0905_xx/报告.html），
 * 而 safePath 永远拿「此刻的」工作目录去拼。用户换一次工作目录，旧对话里那些卡片
 * 就全指到新根下面不存在的位置，界面上一律「文件不存在」——文件明明还好端端躺在旧目录里。
 * 跨根只读访问走这里，根由 server.js 从坐标系指纹反查出来，仍然只能是用户自己配过的目录。
 */
function safePathIn(root, rel) {
  const base = path.resolve(String(root || ""));
  const p = path.resolve(base, String(rel || ".").replace(/\\/g, "/"));
  if (!underRoot(p, base)) {
    throw new Error(`路径越界，只允许访问 workspace 内: ${rel}`);
  }
  return p;
}

const TOOL_DEFS = [
  {
    name: "canvas_manage",
    description:
      "控制当前 OpenWorkBuddy 项目的 AI 短剧无限画布。画布不是普通白板：节点可以是 note/script/agent/character/location/storyboard/scene/shot/image/video/audio/timeline，连线表示输入关系。" +
      "用 list 查看当前项目的多张画布；用 get 读取当前画布；用 add 创建节点；用 update 修改节点 payload 或位置；用 connect 建立输入关系（可声明 relation，如 character/background/motion/style/first_frame）；用 delete 删除节点；用 clear 清空画布。" +
      "短剧制作建议按 script → character/location → storyboard/scene → shot → image/video/audio → timeline 建图。先调用 get，不要凭空覆盖用户已经摆好的节点。" +
      "角色节点的 payload 里可以写 voice（这个角色全程用的音色名），镜头节点可以写 speaker（这一镜的台词是谁说的，写角色名或角色 id）。配音就按这两项决定用谁的嗓子：不写的话整部戏所有角色都是同一个默认音色，而且要等成片放出来才听得出。" +
      "镜头节点的提示词分两格：prompt 是首帧画面长什么样，motion_prompt 只写怎么动。生视频只递 motion_prompt——画面内容已经在首帧里了，把首帧提示词再递一遍，模型会照着它重画一遍，生出来的片子跟已经确认过的首帧对不上。" +
      "生成图片/视频时先调用 generate_image 或 generate_video，拿到真实 file 路径后再用 update 把 first_frame/video/path 写回节点；这样画布会自动显示结果。" +
      "写回节点只让画布显示得出来，不会动分镜表（用户在界面上改字段是自动回表的，这条工具不是）。分镜表是唯一真源（「改一镜只重算一镜」读的是它），所以同一条路径还要自己写进 分镜表.json 里对应那一镜的 first_frame/video/audio、或角色的 ref——漏了这一步，下次重跑会把已经买过的镜头再买一遍。"
      + "（用户在界面上点生成是自动回写的，Agent 这条路没有。）所有操作只作用于当前项目，不连接其他本地项目。",
    input_schema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list", "get", "add", "update", "connect", "delete", "clear"], description: "要执行的画布操作" },
        canvas_name: { type: "string", description: "可选的画布名称；不填则操作用户当前选中的画布" },
        node_id: { type: "string", description: "update/delete 时的节点 id" },
        source_id: { type: "string", description: "connect 时的上游节点 id" },
        target_id: { type: "string", description: "connect 时的下游节点 id" },
        relation: { type: "string", enum: ["input", "split", "generate", "character", "background", "composition", "motion", "style", "prop", "continuity", "first_frame", "last_frame", "audio", "reference"], description: "connect 时这条输入的用途；例如 character=人物身份，background=场景空间，motion=动作参考，first_frame=首帧。省略则按节点类型推断" },
        kind: { type: "string", enum: ["note", "script", "agent", "character", "location", "storyboard", "scene", "shot", "image", "video", "audio", "timeline"], description: "add 时的节点类型" },
        payload: { type: "object", description: "add 时的节点数据；update 时是要合并的字段，如 {prompt, first_frame, video}" },
        position: { type: "object", description: "add/update 时的位置，如 {x: 100, y: 200}" },
      },
      required: ["operation"],
    },
  },
  {
    name: "run_node",
    description:
      "在工作目录(workspace)中执行一段 Node.js (CommonJS) 代码并返回 stdout/stderr。可以 require 以下已安装的库：pptxgenjs(生成PPT)、docx(生成Word)、exceljs(生成Excel)，以及 Node 内置模块(fs/path等)。生成的成果文件必须写到当前工作目录(直接用相对路径/文件名即可，不要写绝对路径)。用于数据处理、文件生成、计算等一切需要编程的任务。输出太长时只回「开头 + 结尾 + 省略了多少 + 全文日志路径」，中间那段不是没有、是在那个文件里，需要就 read_file 或 grep 它，别拿结尾当全部内容。",
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
      "在工作目录(workspace)中执行一条 shell 命令（macOS/Linux 走 zsh/bash，Windows 走 cmd），返回 stdout/stderr。可以使用系统已安装的命令行工具（git、curl、ffmpeg、lark-cli 等）。适合调用现成 CLI、管道/批量文件操作；需要写程序逻辑时优先用 run_node。命令不要做交互式输入（没有 stdin）。输出太长时只回「开头 + 结尾 + 省略了多少 + 全文日志路径」，中间那段不是没有、是在那个文件里，需要就 read_file 或 grep 它，别拿结尾当全部内容。",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的完整 shell 命令（可含管道、&& 串联）" },
        purpose: { type: "string", description: "一句话说明这条命令做什么（展示给用户）" },
        background: { type: "boolean", description: "true = 放到后台跑、立刻返回一个 id（开发服务器、watch 构建、要跑很久的测试用）。之后用 shell_output 看新输出，用 shell_kill 停掉。不传就是等它跑完。后台命令在这一轮任务结束时会被收掉" },
        keep: { type: "boolean", description: "配合 background:true：这一轮结束后也留着接着跑（要交给用户继续用的开发服务器之类）。不传就随这一轮一起收掉" },
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
        overwrite: { type: "boolean", description: "只在「明知故犯地整篇重写一个已有文件」时传 true。不传的话，一次把现成文件砍掉四成以上的写入会被直接拦下——那多半是没读全就重写，内容就此丢了" },
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
        start_line: { type: "number", description: "从第几行开始读（1 起，可选；也认 offset）" },
        end_line: { type: "number", description: "读到第几行为止（含，可选；也可以用 limit 给行数）" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_document",
    description:
      "读 Word / Excel / PPT / 压缩包（.docx / .xlsx / .pptx / .zip），拍平成纯文本给你看。这几种是压缩包格式，用 read_file 读回来只会是乱码。内嵌图片会变成「［图片］」占位。表格很大时用 sheet / from / to 分段读。PDF 不走这里，用 read_file 看提示。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径" },
        sheet: { type: "string", description: "只读某张工作表：表名或序号（1 起）。只对 .xlsx 有意义" },
        from: { type: "number", description: "从第几行开始（1 起，只对 .xlsx 有意义）" },
        to: { type: "number", description: "读到第几行为止（含，只对 .xlsx 有意义）" },
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
        ignore_case: { type: "boolean", description: "不传时：query 里有大写字母就区分大小写，全小写不区分。true/false 强制不分/区分" },
        dir: { type: "string", description: "只搜某个子目录（或某一个文件），默认整个 workspace" },
        ext: { type: "string", description: "只搜某类扩展名，逗号分隔，如 js,ts,md" },
        max: { type: "number", description: "最多返回多少条命中，默认 60" },
      },
      required: ["query"],
    },
  },
  {
    name: "find_files",
    description:
      "按文件名找文件（glob），最近改过的排前面。「测试文件都在哪」「有没有 tsconfig」「所有 .vue 组件」这种问题用它，比 list_files 一层层点快。" +
      "不带斜杠的模式按文件名匹配、哪一层都算（*.test.js）；带斜杠的按相对路径匹配（src/**/*.ts）；支持 ** * ? {a,b} [abc]。自动跳过 node_modules/.git/dist 等。按内容搜用 search_files。",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式，如 **/*.test.js、src/**/*.{ts,tsx}、package.json" },
        dir: { type: "string", description: "只在某个子目录里找，默认整个 workspace" },
        max: { type: "number", description: "最多返回多少个，默认 200" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "multi_edit",
    description:
      "对同一个文件一次做多处精确替换，按顺序一处接一处改（后一处看到的是前一处改完的结果）。要么全部成功、要么一处都不改：任何一处对不上，整个文件原样不动，并告诉你是第几处。" +
      "同一个文件要改好几个地方时用它，比连着调好几次 edit_file 省步数，也不会改到一半停在坏状态。每一处的规则和 edit_file 一样。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径" },
        edits: {
          type: "array",
          description: "按顺序执行的替换列表",
          items: {
            type: "object",
            properties: {
              old_text: { type: "string", description: "要被替换掉的原文（逐字一致，唯一）" },
              new_text: { type: "string", description: "替换成的新内容" },
              replace_all: { type: "boolean", description: "这一处全文替换所有匹配" },
            },
            required: ["old_text", "new_text"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "shell_output",
    description: "看一条后台命令（run_shell background:true 起的）从上次看过之后的新输出，以及它还在不在跑。不给 id 就列出所有后台命令。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "run_shell 返回的后台 id，如 bg1" },
        all: { type: "boolean", description: "true = 把内存里留着的全部输出再给一遍，而不是只给新的" },
      },
    },
  },
  {
    name: "shell_kill",
    description: "停掉一条后台命令（连同它起的子进程一起）。开发服务器、watch 用完就停，别一直占着端口。",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "后台 id，如 bg1" } },
      required: ["id"],
    },
  },
  {
    name: "todo_write",
    description:
      "写/更新这趟任务的进度清单，用户在界面上能看到。三步以上的活开工前先列一张，每做完一条马上标 done、把下一条标 in_progress（同一时间只能有一条 in_progress）。" +
      "每次都发整张表。一条写一个能验收的结果（「登录接口加上限流并有测试」），不写动作（「看一下代码」）。简单的一两步活不用列。",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
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
      "把一条**跨任务都成立**的长期信息记进记忆（用户的偏好、习惯、常用路径、身份、明确的纠正）。用户说「以后都这样」「记住我喜欢…」「别再…」时必须调用。只记结论、一句话，不要记这次任务的过程；绝不记密钥、密码、令牌。回执里若提示「跟已有的一条很像」，判断是不是同一件事的新说法：是就再调 forget 删掉旧的那条，别让两条打架。",
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
    name: "install_skill",
    description:
      "把 GitHub 上的技能装进本软件的技能库，装完技能页和输入框里的 / 马上就找得到。用户给了链接说「装这个技能」时用它。" +
      "别自己 git clone 到工作目录，也别照上游 README 往 ~/.claude/skills、~/.codex 之类的目录里放——那是别的软件的位置，本软件不读，用户在界面上找不到。" +
      "支持整个仓库（里面几个技能一起装）、tree 子目录、单个 .md。装之前会做安全扫描，有告警或会覆盖已有技能时要用户点头。" +
      "技能要装依赖（npm install 之类）的，装完到返回的技能目录里装。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "GitHub 链接：github.com/owner/repo、.../tree/分支/子目录、.../blob/分支/xxx.md 或 raw 直链" },
      },
      required: ["url"],
    },
  },
  {
    name: "add_connector",
    description:
      "把一个 MCP 服务器接成本软件的连接器：存进连接器页并当场连一次，连上后它的工具（mcp__名字__工具名）就能调。用户说「接一下某某 MCP」时用它。" +
      "别手改 config.json，也别写进 ~/.claude、~/.cursor 这类别的软件的配置——本软件不读那些，连接器页上也看不见。" +
      "远程的填 url（Key 放 headers），本地进程填 command + args（Key 放 env），二选一。同名的会被替换，要用户点头。" +
      "连不上时结果里有原文，照实转告用户，别自己猜原因。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "连接器名：字母、数字、- 和 _，如 github、brave-search" },
        url: { type: "string", description: "远程 MCP 地址（Streamable HTTP），http 或 https" },
        headers: { type: "object", description: "远程才用：请求头，如 {\"Authorization\": \"Bearer …\"}" },
        command: { type: "string", description: "本地进程的启动命令，如 npx、uvx" },
        args: { type: "array", items: { type: "string" }, description: "命令参数，如 [\"-y\", \"@modelcontextprotocol/server-github\"]" },
        env: { type: "object", description: "本地才用：环境变量，Key 一般放这里" },
      },
      required: ["name"],
    },
  },
  {
    name: "library_list",
    description: "列出用户资料库中的参考文件与灵感笔记（跨项目共享的长期沉淀素材）。资料库可以有子目录，列出来的名字自带子目录前缀（如 客户A/合同.md），后面读取和取用时要一字不差地照抄。当前项目可能只挂载了资料库的某一块，列出来的就是它全部能看到的范围。任务涉及用户的偏好、过往素材、参考资料时先查这里。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "library_read",
    description: "读取资料库中的一个文本文件内容（最多返回前 50000 字符）。文件名来自 library_list 的结果，带子目录的要连子目录一起写（客户A/合同.md）。资料库里的 PDF / 图片 / Word / 压缩包不是文本，读不了，改用 library_import。",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "资料库中的文件名，来自 library_list；在子目录里的要带上子目录，如 客户A/合同.md" } },
      required: ["name"],
    },
  },
  {
    name: "library_import",
    description:
      "把资料库里的一个文件复制到工作目录，之后就能用相对路径直接处理它——PDF、图片、Word/Excel/PPT、压缩包这些非文本素材都靠它落地（复制完再用 read_document / look_at_image）。只能从资料库往工作目录复制，不能往资料库里写。",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "资料库中的文件名，来自 library_list；在子目录里的要带上子目录，如 客户A/合同.md" } },
      required: ["name"],
    },
  },
  // 取网页只留这一个入口。以前还有个 render_page（"用内置浏览器真打开一遍"），两件事高度重叠：
  // fetch_url 本来就会在抓到空壳时自动渲染兜底，render_page 只多了个「不管像不像空壳都渲染」。
  // 代价却是实打实的——模型每次抓网页都要先做一道选择题，提示词里还得专门教它先后顺序
  // （"先用 fetch_url，读不到再用它"），教了也常常第一次就挑错。现在那道选择题变成 fetch_url
  // 的一个参数：render:"force"。
  //
  // 这句话在 2026-09-14 就写在这儿了，可当时只写了字没删定义——清单里那条 render_page 一直还在，
  // 提示词里还专门有一行教它「空壳就用 render_page」，和这个参数的描述互相打架。这回真删了：
  // executeTool 里的 case 保留（还活着的会话、外部 MCP 客户端、历史排期任务里都可能还攥着这个
  // 名字，落到 default 只会得到一句「未知工具」），但模型的工具清单里不再有它，也就没有那道选择题。
  {
    name: "fetch_url",
    description:
      "抓取一个 URL 的内容（最多 20000 字符）。带真实浏览器请求头，网页会去掉导航/页脚只留正文，JSON 接口原样返回——查资料和直接调数据接口都用它。地址是 PDF/图片/压缩包时会自动下载到工作目录并告诉你文件名（不会把二进制乱码返回给你）。要抓多个地址就在同一轮里一次性发多个 fetch_url，系统会并发执行。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        // 这一条的正文写在参数里而不是工具描述里，是故意的：没有内置浏览器的时候（纯命令行/
        // 服务端模式）整个参数会被摘掉，描述里就不会剩下一句"会自动渲染"的空头支票
        render: {
          type: "string",
          enum: ["auto", "force", "off"],
          description:
            'auto（默认）=抓回来是空壳时自动用内置浏览器渲染一遍再读；force=不管像不像空壳都渲染一遍，正文全靠 JS 的站点（B 站、微博、各类单页应用）直接用它，省掉白跑的那一次；off=只要静态 HTML',
        },
        wait_ms: { type: "number", description: "渲染时每轮等待的毫秒数，默认 2500，内容多的页面可调大" },
      },
      required: ["url"],
    },
  },
  {
    name: "chrome_cdp",
    description:
      "用真 Chrome 打开网页并**交互**：点按钮、输入、在页面里执行 JS、按时间采样动画状态、接管用户已开的浏览器。它要单独拉起一个 Chrome，比别的工具重得多，先看有没有更轻的：截图/出长图用 html_to_image，验收做好的网页用 check_page，读 JS 渲染后的正文用 fetch_url 加 render:\"force\"——这几件事别用它。\n" +
      "端口上没人应答时会自己拉起一个专用 Chrome（独立 user-data-dir，不碰日常浏览器的登录态），端口由它自己挑。只连 127.0.0.1/localhost/::1。**别在 run_node / run_shell 里自己起 Chrome 再连调试口**，会被退回。\n" +
      "action：list_tabs 列标签页；navigate 打开 URL（默认等页面加载完再返回）；screenshot 截图存到 workspace，full_page=true 截整页，width/height 指定视口；inspect 读页面文字；click/type 按 CSS 选择器操作；evaluate 执行页面内 JavaScript；close_tab 关标签页；close 把本工具拉起来的那个 Chrome 整个关掉（用完就发这一条；忘了的话闲置十分钟自己会关）；status 看当前接的是哪个 Chrome。\n" +
      "接手用户已经开着的浏览器要给 port；不给就用本工具自己那一个。WebGL/Canvas 页面照样能截。服务器部署时 Chrome 要跟 Agent 在同一台机器，别把调试端口暴露到公网。",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_tabs", "inspect", "navigate", "click", "type", "evaluate", "screenshot", "close_tab", "close", "status"] },
        tab_id: { type: "string", description: "Chrome 标签页 id；不给就用当前第一个页面标签页" },
        port: { type: "number", description: "本机 CDP 端口。只在接管用户自己启的 Chrome 时给；不给就用本工具自己拉起的那个" },
        selector: { type: "string", description: "inspect/click/type 的 CSS 选择器" },
        text: { type: "string", description: "type 要输入的内容" },
        url: { type: "string", description: "navigate 要打开的 URL" },
        expression: { type: "string", description: "evaluate 要执行的页面 JavaScript。代码直接写在这里，别先存成文件再 fetch 进页面（那些文件会留在用户的成果文件夹里）" },
        path: { type: "string", description: "screenshot 保存到 workspace 的相对路径，默认 chrome-screenshot.png。自己检查用的截图放 .tmp/（如 .tmp/check1.png），不进成果区" },
        max_chars: { type: "number", description: "inspect 最多返回多少字符，默认 20000" },
        full_page: { type: "boolean", description: "screenshot 截整页（含需要滚动的部分），默认只截当前视口" },
        width: { type: "number", description: "screenshot 视口宽，配合 height 用，默认按窗口实际大小" },
        height: { type: "number", description: "screenshot 视口高" },
        wait_ms: { type: "number", description: "navigate 等页面加载完的上限，默认 4000；screenshot 上也能给，拍之前再等一等" },
        headless: { type: "boolean", description: "自己拉 Chrome 时用无头模式，不弹窗口。服务器上跑必须开" },
      },
      required: ["action"],
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
    name: "look_at_image",
    description:
      "看一张图（截图、照片、设计稿），带着一个具体的问题去看，拿回一段文字答案。用户粘贴或上传了图片就用它——" +
      "read_file 读图只会读出一堆乱码。问题越具体越有用：「报错信息一字不差抄下来」「这个页面分几块、各是什么」" +
      "远好过「看看这张图」；想问好几件事就分几次调，一次一张图。" +
      "图片本身不会进对话历史（那样每一步都要重发一遍，又贵又会让纯文本的主模型直接报错），进历史的只有你拿回的这段文字——" +
      "所以该抄下来的细节（报错原文、数字、文案）要在问题里明确要求抄全，看完这一次就得把要用的东西都拿到手。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "图片相对路径。用户上传的图在工作空间里，名字不确定就先 list_files" },
        question: { type: "string", description: "关于这张图的具体问题（必填）" },
        model: { type: "string", description: "模型名（可选）。设置里这一路可能配了好几个，不写就用默认那个；想点名用哪个就照设置里的名字写。名字写错会直接报错并列出可选项，不会偷偷换成别的。" },
      },
      required: ["path", "question"],
    },
  },
  {
    name: "generate_image",
    description:
      "用用户配置的图像模型生成一张图片（AI 作画），保存到工作空间。适合配图、海报、封面、商品图、没有文字的纯画面。" +
      "图上要放中文大标题也能生：新一代模型（如豆包 Seedream 5）已经能把中文标题写对，老模型和多数海外模型仍会糊——" +
      "没把握就先生一张看效果，别拿「肯定糊」当理由拒绝。另一条路是 html_to_image（自己排版再截图）——" +
      "两条路的产出完全不是一个东西，用户没点名走哪条时，先用 ask_user 把两条路摆出来问一句；用户点了名就照做，" +
      "要带字也照生，把「字可能糊」一句话说在前面，别拿这个当理由偷偷换成另一条路。" +
      "要保持角色/商品/画风一致，用 reference_images 把已有的图喂进来（最多 4 张），比在 prompt 里反复描述外貌可靠得多。" +
      "需要先在 设置 → 模型 → 图像模型 配置渠道，未配置时会明确报错。",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "画面描述，越具体越好（主体/风格/构图/光线）" },
        reference_images: {
          type: "array",
          items: { type: "string" },
          description: "参考图的相对路径（可选，最多 4 张）。想让新图沿用同一个人/同一件商品/同一种画风，就把已有的图喂进来——" +
            "光靠文字描述同一个角色，跨镜头一定长得不一样。渠道不支持参考图时会明确报错，不会偷偷退回纯文生。",
        },
        filename: { type: "string", description: "保存文件名（可选，默认 image_时间戳.png）" },
        size: { type: "string", description: "尺寸如 1024x1024（可选，仅 OpenAI 兼容渠道生效）" },
        model: { type: "string", description: "模型名（可选）。设置里这一路可能配了好几个，不写就用默认那个；想点名用哪个就照设置里的名字写。名字写错会直接报错并列出可选项，不会偷偷换成别的。" },
        no_cache: { type: "boolean", description: "强制重新生成（可选）。给了 filename 的调用，参数完全一样时会直接复用上一次的产物、不再花钱；确实要换一版不一样的，把这个设成 true。" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_video",
    description:
      "用用户配置的视频模型生成一段短视频，保存到工作空间（生成通常要 1~5 分钟，请耐心等待返回）。" +
      "给了 first_frame 就是图生视频（画面从那张图长出来），首尾都给就是「从这张变到那张」——" +
      "两者都需要设置里配的是 i2v 型号，型号对不上会在发出请求之前就报错，不会白花一次钱。" +
      "需要先在 设置 → 模型 → 视频模型 配置渠道，未配置时会明确报错。",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "视频内容描述（画面/动作/镜头）" },
        first_frame: { type: "string", description: "首帧图的相对路径（可选）。给了就是图生视频：画面从这张图长出来，角色和场景不会跑偏。需要配的是 i2v 型号。" },
        last_frame: { type: "string", description: "尾帧图的相对路径（可选，必须同时给 first_frame）。首尾都定住就是「从这张变到那张」，转场类镜头用它。只有通义万相 kf2v 和火山方舟 Seedance 两家收尾帧，别家的渠道会在发请求之前报错。" },
        filename: { type: "string", description: "保存文件名（可选，默认 video_时间戳.mp4）" },
        duration: { type: "integer", description: "时长，整数秒（可选）。不写按模型默认；模型出不了这个时长就取最近的一档，结果里会写明实际秒数。按实际秒数计费。" },
        aspect_ratio: { type: "string", description: "画幅（可选），如 16:9、9:16、1:1。给了首帧图时画幅跟着图走，这个不发。" },
        resolution: { type: "string", description: "分辨率档位（可选），如 480p、720p、1080p。模型没有这一档就取最近的，结果里会写明。" },
        model: { type: "string", description: "模型名（可选）。设置里这一路可能配了好几个，不写就用默认那个；想点名用哪个就照设置里的名字写。名字写错会直接报错并列出可选项，不会偷偷换成别的。" },
        no_cache: { type: "boolean", description: "强制重新生成（可选）。给了 filename 的调用，参数完全一样时会直接复用上一次的产物、不再花钱；确实要换一版不一样的，把这个设成 true。" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "html_to_image",
    description:
      "把工作空间里的一个本地 HTML 文件用真浏览器渲染成 PNG 图片（桌面版专属）：先 write_file 写一个排版好的 HTML" +
      "（<style> 里内联全部样式，画布尺寸用 body{width:...px;height:...px;margin:0} 定死），再用本工具截图。" +
      "做小红书卡片、公众号头图、视频分镜卡时它跟 generate_image（AI 作画）是两条路：本工具是「设计稿」——文字清晰、版式配色全听你的、风格偏平面；" +
      "generate_image 是「画」——有质感有氛围，中文标题能不能写对看渠道（豆包 Seedream 5 这类新模型已经可以）。" +
      "**两条路的成品差别大到会返工，用户没点名走哪条时先用 ask_user 问一句**，点了名就照他说的做。",
    input_schema: {
      type: "object",
      properties: {
        html_file: { type: "string", description: "HTML 文件路径（工作空间内的相对路径）" },
        html_files: { type: "array", items: { type: "string" }, description: "一次截多张（最多 30 个 HTML，按顺序；与 html_file 二选一）。出图名跟 HTML 文件名走，给了 filename 就当前缀：xhs_01.png…" },
        filename: { type: "string", description: "输出 PNG 文件名（可选，默认 card_时间戳.png）" },
        width: { type: "number", description: "视口宽 px（默认 1242）" },
        height: { type: "number", description: "视口高 px（默认 1656。常用：小红书 3:4=1242x1656，公众号头图 2.35:1=1200x511，视频封面 16:9=1920x1080）" },
        full_page: { type: "boolean", description: "true 时按页面实际内容高度整页截（适合长图/万字长文截图）" },
        wait_ms: { type: "number", description: "加载后等待毫秒再截（默认 500；页面有网络字体/大图时加大到 2000+）" },
      },
      required: [],
    },
  },
  {
    name: "render_motion",
    description:
      "把工作空间里的 HTML 动画逐帧渲成无声 H.264 mp4（虚拟时钟：CSS 动画 / setTimeout / rAF / Math.random 都按帧推，同一页渲两次逐帧一样；不花钱）。" +
      "先 write_file 写 HTML：<body data-duration=\"秒\"> 定时长，元素上 data-start/data-duration 控制出场窗口。多个 HTML 按顺序接成一条，每段时钟各自从 0 开始。" +
      "出片后会落一张封面 PNG，交付前用 look_at_image 看一眼。配音/配乐之后另外合成。",
    input_schema: {
      type: "object",
      properties: {
        html_file: { type: "string", description: "HTML 文件路径（工作空间内相对路径）" },
        html_files: { type: "array", items: { type: "string" }, description: "多段按顺序接起来（最多 30 个；与 html_file 二选一）" },
        durations: { type: "array", items: { type: "number" }, description: "每段秒数，和 html_files 一一对应；不给就读各页 <body data-duration>" },
        duration: { type: "number", description: "单个 HTML 的秒数（0.5–120；不给就读 data-duration）" },
        aspect: { type: "string", description: "画幅：9:16（默认 1080x1920）/ 16:9 / 1:1 / 3:4" },
        width: { type: "number", description: "宽 px（和 height 都给时忽略 aspect）" },
        height: { type: "number", description: "高 px" },
        fps: { type: "number", description: "帧率 12–60，默认 30" },
        seed: { type: "number", description: "Math.random 种子（默认固定值；想换一种随机就换个数）" },
        stills: { type: "number", description: "落几张静帧 PNG（0–3，默认 1 张封面）" },
        filename: { type: "string", description: "输出文件名（默认 motion_时间戳.mp4；只出 .mp4/.mov）" },
      },
      required: [],
    },
  },
  ...require("../domains/content/delivery-page").TOOL_DEFS, // 交付页：成片/封面/文案收成一页，本机出、不花钱
  {
    name: "text_to_speech",
    description:
      "用用户配置的语音合成模型把文字念成音频文件，保存到工作空间。视频配音、播客旁白就用它。需要先在 设置 → 模型 → 语音合成 配置渠道，未配置时会明确报错。" +
      "要按句出时长和字幕（视频配音、镜头跟着声音走）就传 segments：一次调用逐句合成、实测每句时长，出整轨 + 句级 .srt + 时长清单 .json。",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要念的文字（和 segments 二选一；上限 5000 字，超长请分段多次合成）" },
        filename: { type: "string", description: "保存文件名（可选，默认 speech_时间戳.mp3）。segments 模式下是整轨名（.wav 或 .mp3，默认 旁白.wav），字幕和时长清单同名" },
        voice: { type: "string", description: "音色名（可选，默认用设置里配的；如 OpenAI 系的 alloy/nova、通义的 Cherry/Serena）" },
        speed: { type: "number", description: "语速 0.5~2.0（可选，仅 OpenAI 兼容渠道生效）" },
        model: { type: "string", description: "模型名（可选）。设置里这一路可能配了好几个，不写就用默认那个；想点名用哪个就照设置里的名字写。名字写错会直接报错并列出可选项，不会偷偷换成别的。" },
        no_cache: { type: "boolean", description: "强制重新生成（可选）。给了 filename 的调用，参数完全一样时会直接复用上一次的产物、不再花钱；确实要换一版不一样的，把这个设成 true。" },
        segments: { type: "array", maxItems: 60, description: "按句配音（可选）：每句一项，逐句合成并实测时长，同时出整轨、句级字幕和时长清单。按声音定镜头时长就用它。", items: { type: "object", properties: { text: { type: "string", description: "这一句（≤600 字）" }, voice: { type: "string", description: "这一句的音色（可选，对白换人时用）" } }, required: ["text"] } },
        gap_ms: { type: "number", description: "句间停顿毫秒（可选，默认 300，只在 segments 模式生效）" },
      },
      // text 和 segments 二选一，谁都不能单独标必填；两样都没给由实现里的参数检查照实报
      required: [],
    },
  },
  {
    name: "compose_video",
    description:
      "按时间轴把盘上已有的画面、配音、配乐拼成成片：一次出多个画幅（9:16 / 16:9 / 1:1 / 3:4），附 .srt 字幕、封面和一份清单。只用本机 ffmpeg，不调模型、不花钱。" +
      "先用 dry_run 看会出几条、多长、有什么警告；正式跑时等得到就直接交成片，等不到先交任务号，再用 job 查、job + cancel 停。时间轴写法见 video-compose 技能。",
    input_schema: {
      type: "object",
      properties: {
        timeline: { type: "string", description: "时间轴：工作区里 timeline.json 的路径，或者直接写 JSON（segments 必填：每段一个 visual，可带 voice）" },
        dry_run: { type: "boolean", description: "只排片不出片（可选）：交回画幅、时长、步数和警告，不写盘" },
        job: { type: "string", description: "查一条已经开跑的合成（可选，填开跑时给的任务号）" },
        cancel: { type: "boolean", description: "配合 job 叫停它（可选）；不给 job 就停这个对话正在跑的那条" },
      },
      // 查 / 停一条已经开跑的只给 job，没有 timeline；两样都没给由实现照实报
      required: [],
    },
  },
  {
    name: "transcribe_audio",
    description:
      "把录音 / 视频里的话转成文字（会议录音、采访、播客、口播素材都行），结果存进工作空间的 .txt。需要先在 设置 → 模型 → 转写 配置渠道，未配置时会明确报错。\n" +
      "用户说「把这段录音整理成文字」「这个会议录音讲了什么」「给视频配字幕」时用它。文件得先在工作空间里——用户从输入框传进来的就在那儿，先 list_files 看真实文件名。\n" +
      "接口收 25MB 以内的文件。超了先用 run_shell 调 ffmpeg 压成 16k 单声道（ffmpeg -i 原文件 -ac 1 -ar 16000 -b:a 64k 输出.mp3），一小时的会议大概 28MB，压完约 3MB。\n" +
      "要做字幕就把 with_timestamps 设成 true，会连带存一份 .srt；不做字幕别开，省钱也省话。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要转写的音频 / 视频文件，工作空间里的相对路径（mp3 / m4a / wav / webm / mp4 / flac / ogg / aac / amr）" },
        language: { type: "string", description: "音频里说的是什么语言（可选，ISO-639-1，如 zh / en / ja）。写对能明显提准，尤其是中英夹杂的录音；拿不准就别写，让模型自己判。" },
        hint: { type: "string", description: "提示词（可选，上限 500 字）。把录音里会出现的人名、产品名、专有名词列进来，转写时不容易写错字。" },
        with_timestamps: { type: "boolean", description: "true 时额外要一份带时间轴的分段，并存一个同名 .srt 字幕文件（默认 false）" },
        filename: { type: "string", description: "转写稿保存的文件名（可选，默认 用原文件名.txt）" },
        model: { type: "string", description: "模型名（可选）。设置里这一路可能配了好几个，不写就用默认那个；名字写错会直接报错并列出可选项，不会偷偷换成别的。" },
      },
      required: ["path"],
    },
  },
  {
    name: "desktop_pet",
    description:
      "把用户给的一张图片做成【桌面宠物】——一个常驻桌面角落的透明小挂件，实时显示你正在干什么（干活转圈 / 有问题要问时跳起来并弹系统通知 / 完成撒花 / 出错掉汗）。用户点它开关主窗口，拖动换位置。\n" +
      "什么时候用：用户说「把这张图做成桌面宠物」「用我朋友的照片弄个桌宠」「搞个挂件放桌面」这类话时。**默认是没有宠物的**，只有用户开口要才做，不要主动创建。\n" +
      "怎么用：先让用户在输入框上传一张图（人像/宠物照/表情包都行），图会落到工作空间；再带着文件名调 action=\"create\"。图片只存用户本机，不上传任何服务器。\n" +
      "换成像素宠物：本机装过 Codex / Petdex 的宠物（~/.codex/pets、~/.petdex/pets）的话，action=\"sprite\" 不带 id 会列出来，带 id 就换上。这类宠物自带跑/跳/挥手/失败 8 套动作，会跟着你的状态切。\n" +
      "只在桌面版（npm run app）里有效；纯服务端模式下会如实报错，那时要老实告诉用户做不了。",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "show", "hide", "remove", "status", "sprite"],
          description: "create=用图片做一只（要带 image）；show/hide=显示或收起；remove=撤掉并删掉本机存的照片；status=看看现在什么情况；sprite=列出/换上本机的 Codex / Petdex 像素宠物",
        },
        image: { type: "string", description: "图片文件名或相对路径（相对工作空间）。仅 action=create 时必填" },
        scale: { type: "number", description: "大小倍率 0.6~2，默认 1。用户嫌大嫌小时调这个" },
        sprite_id: { type: "string", description: "要换上的像素宠物 id。仅 action=sprite 时用；不填就只列出本机有哪些" },
      },
      required: ["action"],
    },
  },
  ...require("../domains/content/brand-kit").TOOL_DEFS, // 产品品牌档案：读/查 + 存（存必须人点头）
  require("../domains/media/web-demo-recorder").TOOL_DEF, // 网页产品演示录屏：隔离 Chrome + 打码闸门 + ffmpeg 合成
];

// 图像 / 视频 / 配音 / 转写 / 看图 / HTML 截图：在 src/tools/media.js

// 大文件不整份读进内存。实测一份 48.5MB 的日志：readFileSync 整份读完再 split("\n")，
// 事件循环被钉住 172~188ms、堆一次涨 64~88MB——那 0.2 秒里 SSE 一个字都发不出去，
// 用户看到的就是回答说到一半突然定住。
// 200MB 的日志（数据分析类任务里很常见）就是 0.7 秒起步，还要多占几百 MB。
// 所以超过这个大小改成分块读：不带行号只取开头那一截；带行号就流着扫，只把要的那几行留下。
// fh.read 是真异步（走线程池），每块之间事件循环自然能喘一口气。
const READ_BIG = 4 * 1024 * 1024;
const READ_CHUNK = 1 << 20;

/**
 * 按行段读，5 万字的上限只在整行上收。
 *
 * 以前是拼完再一刀 slice(0, 50000)：抬头写着「第 1-2000 行」，正文到第 771 行半截就断了，一个字没提——
 * 模型以为 772-2000 行都看过了，照着没见过的代码去改。现在收在哪一行抬头就写到哪一行，末尾说清接着从哪读。
 * 只有单独一行就超了（压缩过的 js、一行一整坨 JSON）才劈开那一行，也照直说。
 */
function numberedLines(rel, from) {
  const room = 50000 - rel.length - 200; // 抬头和末尾那句话的地方先让出来
  const out = [];
  let used = 0, last = from - 1, cutLen = 0, full = false;
  return {
    /** 收下第 no 行；返回 false = 满了，后面的不用再给 */
    push(no, text) {
      if (full) return false;
      let ln = `${no}\t${text}`;
      if (used + ln.length + 1 > room) {
        full = true;
        if (out.length) return false;
        ln = ln.slice(0, room);
        if (/[\ud800-\udbff]$/.test(ln)) ln = ln.slice(0, -1); // 别把 emoji / 生僻字劈成半个
        cutLen = text.length;
      }
      out.push(ln);
      used += ln.length + 1;
      last = no;
      return !full;
    },
    /** to = 这次本该读到第几行（已按全文夹过），total = 全文行数 */
    render(to, total) {
      const notes = [];
      if (cutLen) notes.push(`（第 ${last} 行这一行就有 ${cutLen} 字，只给了开头一截；要找这一行里的东西用 search_files 或 run_shell）`);
      if (full && last < to) notes.push(`（到 5 万字上限了，只给到第 ${last} 行；接着读传 start_line=${last + 1}）`);
      return `（${rel} 第 ${from}-${full ? last : to} 行，全文共 ${total} 行）\n${out.join("\n")}` + (notes.length ? "\n\n" + notes.join("\n") : "");
    },
  };
}

async function readBigFile(p, rel, size, s, e) {
  const { StringDecoder } = require("string_decoder");
  const fh = await fs.promises.open(p, "r");
  try {
    if (!s && !e) {
      // 只要开头：读够 50000 字符就收手（UTF-8 一个字符最多 4 字节，多读一点垫着）
      const buf = Buffer.alloc(Math.min(READ_CHUNK * 4, 4 * 50000 + 1024));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const dec = new StringDecoder("utf8");
      const head = dec.write(buf.subarray(0, bytesRead)); // 半个汉字被切在块尾时不会变成乱码
      return `${head.slice(0, 50000)}\n\n（${rel} 有 ${(size / 1048576).toFixed(1)}MB，太大了不整份读进来——这里只给了开头 50000 字符。要看后面的用 start_line/end_line 指定行段。）`;
    }
    const from = Math.max(1, s || 1);
    const to = Math.max(from, e || from);
    const dec = new StringDecoder("utf8");
    const buf = Buffer.alloc(READ_CHUNK);
    const out = numberedLines(rel, from);
    let carry = "", lineNo = 0, pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      carry += dec.write(buf.subarray(0, bytesRead));
      const parts = carry.split("\n");
      carry = parts.pop();
      // 收满了也接着往下数：抬头那个「全文共 N 行」得是真的
      for (const ln of parts) {
        lineNo++;
        if (lineNo >= from && lineNo <= to) out.push(lineNo, ln);
      }
    }
    carry += dec.end();
    lineNo++; // 最后一段（可能是空串）也算一行：跟 content.split("\n") 的行数口径对齐，
    if (lineNo >= from && lineNo <= to) out.push(lineNo, carry); // 不然大小文件报的总行数会差一
    // 翻页翻到头了不是失败，是「这就是结尾」这条信息本身——跟小文件那条路一个措辞
    if (from > lineNo) return `${rel} 到头了：全文共 ${lineNo} 行，start_line=${from} 已经在末尾之后，后面没有内容了。`;
    return out.render(Math.min(lineNo, to), lineNo);
  } finally {
    await fh.close();
  }
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
    let msg = `代码没有执行：语法错误${line ? `（第 ${line} 行）` : ""}\n`;
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

// ---------- 子进程输出：头 + 尾 + 全文落盘 ----------
// 原来是 `out += d` 攒全文、末了 out.slice(0, 20000)，三个毛病：
//  ① 切了一个字的提示都没有——模型看到的就是「输出只有这些」，然后拿半截日志下结论。
//     静默截断比截断本身更坏，跟「标签说一套、实际跑一套」是同一类错；
//  ② 长输出的要害几乎都在尾巴上（报错栈、失败汇总、退出原因），只留头等于把答案扔了；
//  ③ 攒全文没有上限。server 跑在 Electron 主进程里，一条 `cat 大文件` 就能把整个应用撑爆。
// 现在内存只留「头 + 滚动的尾」，超预算就把全文写进 .tmp 下的日志（.tmp 不进产出列表，
// 不会污染文件面板），回给模型的是 头 + 省略了多少 + 尾 + 全文路径，要看中间自己去读那个文件。
const OUT_SPILL_AT = 256 * 1024; // 攒到这么多就别再往内存里堆，转成边收边写文件

/** .tmp 里的输出日志攒着不清会一直长；只删我们自己写的、三天前的 */
function pruneOldOutLogs() {
  try {
    const dead = Date.now() - 3 * 24 * 3600 * 1000;
    for (const n of fs.readdirSync(tmpDir())) {
      if (!/^(node|shell)(-err)?-out-.+\.log$/.test(n)) continue;
      const p = path.join(tmpDir(), n);
      if (fs.statSync(p).mtimeMs < dead) fs.rmSync(p, { force: true });
    }
  } catch {}
}

function makeOutSink(kind, headMax, tailMax) {
  // 一个中文字被切在两个 chunk 中间会变乱码，必须按流解码；Windows 上 cmd 自带命令吐的是 GBK，见 lib/out-decode.js
  const dec = outDecoder();
  let head = "", tail = "", total = 0, fd = null, rel = "", buf = [], bufLen = 0;
  function openSpill() {
    try {
      ensureDirs();
      pruneOldOutLogs();
      const name = `${kind}-out-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}.log`;
      fd = fs.openSync(path.join(tmpDir(), name), "a");
      rel = ".tmp/" + name;
      if (buf.length) fs.writeSync(fd, buf.join(""));
    } catch {
      fd = null; // 落盘失败不能把命令结果一起赔进去：退回只给头尾，下面的提示语也会照实说
      rel = "";
    }
    buf = [];
    bufLen = 0;
  }
  function take(str) {
    if (!str) return;
    total += str.length;
    if (head.length < headMax) head += str.slice(0, headMax - head.length);
    tail = tail.length + str.length > tailMax ? (tail + str).slice(-tailMax) : tail + str;
    if (fd !== null) {
      try { fs.writeSync(fd, str); } catch {}
      return;
    }
    buf.push(str);
    bufLen += str.length;
    if (bufLen > OUT_SPILL_AT) openSpill();
  }
  return {
    write: (chunk) => take(dec.write(chunk)),
    /** 收尾并给出要回填进工具结果的文本：没超预算就是原文，超了就是 头 + 省略说明 + 尾 */
    render() {
      take(dec.end());
      if (fd === null && total <= headMax + tailMax) return buf.join("");
      if (fd === null) openSpill(); // 没到落盘阈值但超了回显预算：也存一份，省略掉的部分得有地方可看
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
        fd = null;
      }
      const omitted = total - head.length - tail.length;
      return (
        head +
        `\n\n…〔中间省略 ${omitted} 字符；本次输出共 ${total} 字符。` +
        (rel
          ? `全文已存到 ${rel}，要看省略掉的部分就 read_file 读它，或用 run_shell grep 它`
          : "全文落盘失败，现在只剩这里的头和尾") +
        `。下面这段是结尾，不是全部内容〕\n\n` +
        tail
      );
    },
  };
}


/**
 * 把子进程连同它拉起来的那一窝一并收走。
 *
 * 为什么不是一句 child.kill()：模型跑的多半是 `npm install`、`npm run build` 这种
 * 自己还要再 spawn 一层的命令。只杀那层 shell，孙子进程会活下来接着占 CPU 和端口——
 * 用户点了「让我停下」，风扇还在转、端口还被占着，跟没停一样。detached 让子进程自成
 * 一个进程组，负号 pid 才能把整组一起送走。
 *
 * 先 SIGTERM 再 SIGKILL：正在写文件的进程该有机会把手上那半个文件收尾，
 * 但用户已经明确说了停，不能无限等——给 grace 毫秒，到点还在就硬杀。
 */
function killTree(child, grace = 2000) {
  if (process.platform === "win32") {
    // 没有先礼后兵这一说（不带 /F 的 taskkill 对没窗口的命令行程序不起作用），一遍 /F 连孙子带走就够了。
    // error 要接住：taskkill 万一起不来，没人接的 error 事件会把整个服务进程带走
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); }
    catch { try { child.kill(); } catch {} }
    return;
  }
  const send = (sig) => {
    try { process.kill(-child.pid, sig); } catch {
      try { child.kill(sig); } catch {}
    }
  };
  send("SIGTERM");
  const t = setTimeout(() => send("SIGKILL"), grace);
  if (t.unref) t.unref();
  child.once("close", () => clearTimeout(t));
}

/**
 * 把「让我停下」接到一个正在跑的子进程上。
 *
 * 返回拆监听的函数：一趟任务里工具要跑几十上百次，不拆的话同一个 AbortSignal 上的
 * 监听器越堆越多，Node 到 11 个就开始刷 MaxListenersExceededWarning。
 */
function bindStop(child, stopSignal, onStop) {
  if (!stopSignal) return () => {};
  const onAbort = () => { onStop(); killTree(child); };
  if (stopSignal.aborted) { onAbort(); return () => {}; }
  stopSignal.addEventListener("abort", onAbort, { once: true });
  return () => stopSignal.removeEventListener("abort", onAbort);
}

/**
 * 超时也得整组收，不能交给 spawn 自带的 timeout。
 *
 * spawn 的 timeout 只 kill 直属那层 shell。`sleep 60; echo done`、`npm test | tail`、
 * 脚本里再起一个 node——孙子进程还攥着 stdout，'close' 就一直等不来：超时到点了工具照样不回，
 * 撞上开服务、watch 这种不会自己结束的，这一步就永远卡死，孙子进程还漏在后台。
 * 所以到点走 killTree 整组送走；有人 setsid 跳出了进程组、仍拿着管道的，宽限过后直接把管道掐断，
 * 保证这一步一定回得来。返回撤掉计时器的函数。
 */
function armTimeout(child, timeoutMs, onFire) {
  if (!(timeoutMs > 0)) return () => {};
  let hard = null;
  const t = setTimeout(() => {
    onFire();
    killTree(child);
    hard = setTimeout(() => { try { child.stdout.destroy(); child.stderr.destroy(); } catch {} }, 5000);
    if (hard.unref) hard.unref();
  }, timeoutMs);
  return () => { clearTimeout(t); if (hard) clearTimeout(hard); };
}

/** 超时那句话：留着「执行超时被终止」这几个字，evolve.js 靠它归类 */
function timeoutNote(timeoutMs, tip) {
  return `(执行超时被终止：跑满 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒没结束，连同它拉起的子进程一起停了${tip || ""})\n`;
}

function runNode(code, timeoutMs, cwd, stopSignal, session = "") {
  ensureDirs();
  const syntaxErr = precheckSyntax(code);
  if (syntaxErr) return Promise.resolve({ content: syntaxErr, isError: true });
  // 脚本在 workspace/.tmp 下执行，向上解析不到本项目的 node_modules；软链一份进去，
  // require("docx"/"pptxgenjs"/"exceljs") 才能稳定命中（NODE_PATH 只是兜底）
  const link = path.join(tmpDir(), "node_modules");
  if (!fs.existsSync(link)) {
    try {
      fs.symlinkSync(appPath("node_modules"), link, "junction");
    } catch {}
  }
  const file = path.join(tmpDir(), `script_${Date.now()}_${Math.floor(Math.random() * 1e6)}.cjs`);
  fs.writeFileSync(file, code, "utf8");
  return new Promise((resolve) => {
    // nodeExec：服务端在独立服务进程里时 execPath 是 Electron Helper，换回应用本体（行为和以前一样）
    const child = spawn(require("../platform/electron-bridge").nodeExec(), [file], {
      cwd: cwd || ws(),
      // 自成进程组，好让 killTree 能连着孙子进程一起收（脚本里再 spawn 是常事）
      detached: process.platform !== "win32",
      // ELECTRON_RUN_AS_NODE：桌面版里 execPath 是 Electron 二进制，不加这个每跑一次脚本
      // 就弹一个新的 Electron 应用实例（Dock 图标狂蹦）；加了就纯当 node 用
      // OPENWORKBUDDY_HOME：装机态下代码在只读的应用包里、数据在 ~/OpenWorkBuddy，
      // 子进程要用同一个数据根才不会各写各的
      // PATH 跟 run_shell 同一份（shellPath）：脚本里 execSync("ffmpeg …") 也得找得到刚装的东西，
      // 不然 Windows 上拿的还是应用启动那一刻的 PATH，run_shell 找得到、run_node 里找不到
      env: { ...process.env, NODE_PATH: appPath("node_modules"), OPENWORKBUDDY_HOME: DATA_DIR, ELECTRON_RUN_AS_NODE: "1", PATH: shellPath(), ...depsGuardEnv(cwd, code, shellPath()) },
      // 同 runShell：脚本里读 stdin 就当场读到结尾，别空等到超时
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const out = makeOutSink("node", 8000, 8000);
    const err = makeOutSink("node-err", 4000, 6000);
    child.stdout.on("data", (d) => out.write(d));
    child.stderr.on("data", (d) => err.write(d));
    let stopped = false;
    const unbind = bindStop(child, stopSignal, () => { stopped = true; });
    let timedOut = false;
    const disarm = armTimeout(child, timeoutMs, () => { timedOut = true; });
    child.on("close", (code2) => {
      unbind(); disarm();
      fs.rmSync(file, { force: true });
      const o = out.render(), e = err.render();
      let result = "";
      if (o) result += `stdout:\n${o}\n`;
      if (e) result += `stderr:\n${e}\n`;
      // 先判停止再判超时：用户按停也是走 SIGTERM，两句话反了人看见的就是「超时」。
      // 超时只认计时器：整组收掉之后，直属那层可能是被 SIGKILL 的、也可能是孩子没了自己退的，看信号认不出来
      if (stopped) result += "(用户已停止任务，脚本被终止)\n";
      else if (timedOut) result += timeoutNote(timeoutMs);
      result += `exit code: ${code2}`;
      const done = { content: result, isError: stopped || timedOut || code2 !== 0 };
      // 脚本自己 spawn 了没等的子进程：看一眼进程组，还有人就记账（见 noteStray）
      noteStray(child.pid, "run_node 脚本", session, { quiet: stopped || timedOut, tip: "要一直跑，用 run_shell 的 background:true 起" })
        .then((n) => { if (n) done.content += "\n" + n; resolve(done); }, () => resolve(done));
    });
    child.on("error", (e) => {
      unbind(); disarm();
      resolve({ content: `启动失败: ${e.message}`, isError: true });
    });
  });
}

// GUI 启动的 Electron 拿到的 PATH 不含 homebrew，补齐否则 lark-cli/git 等命令找不到。
// Windows 上 PATH 是全的，但定格在应用启动那一刻：用户照提示 winget 装完 ffmpeg / pandoc，注册表变了、
// 进程里没变，体检找得到、run_shell 照样报「不是内部或外部命令」。所以跟体检用同一份——
// engines/which 合并好的（「重新检测本机」时现读的注册表 PATH + 启动时那份 + winget/scoop/LibreOffice 的常见位置）。
// platform 只给测试用
function shellPath(platform = process.platform) {
  if (platform === "win32") return require("../platform/which").augmentedPath("win32");
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(require("os").homedir(), ".local", "bin")];
  const cur = (process.env.PATH || "").split(path.delimiter);
  return cur.concat(extra.filter((p) => p && !cur.includes(p))).join(path.delimiter);
}

/**
 * 装依赖的护栏（2026-09-28 真实会话里 agent 在任务文件夹的 .tmp 底下反复 npm init + npm install；
 * 少了 init 那一步，npm 往上找项目根就找到应用自己的 package.json，来龙去脉见 lib/deps-guard.js）。
 * run_shell / 后台命令 / run_node 起子进程之前都过一遍：立围栏、PATH 前面垫拦截脚本。
 * 护栏自己出错不许拦住命令：退回老样子跑。depsAppDir 测试里换成临时的假应用目录
 */
let depsAppDir = require("../platform/root").ROOT;
function depsGuardEnv(cwd, text, basePath, platform = process.platform) {
  const shimDir = dataPath("data", "pm-guard");
  let env = {};
  try {
    env = depsGuard.prepare({ appDir: depsAppDir, wsDir: ws(), cwd: cwd || ws(), text: String(text || ""), shimDir, path: basePath }).env;
  } catch { return {}; }
  // Windows 上 python3 转到真 Python 的那一个垫片（见 winPython3Shim），跟装依赖护栏共用一个目录。
  // 真 Python 的全路径不在垫片里，在它给的 env（OWB_PYTHON3）里：垫片目录垫上 PATH 的地方就得一起带上
  try {
    const base = env.PATH || (basePath == null ? process.env.PATH || "" : basePath);
    const py = winPython3Shim(shimDir, base, platform);
    if (py.dir) env = { ...env, ...py.env, PATH: py.dir + ";" + base };
  } catch {}
  return env;
}

/**
 * Windows 上 PATH 里挨个目录找 name.exe / .cmd / .bat，先找到的算（cmd 自己也是按 PATH 顺序找）。
 * 用 lstat 不用 stat：WindowsApps 里那些「应用执行别名」是特殊的重解析点，stat 跟过去会报错，lstat 看得见它本身
 */
function winFindOnPath(name, dirs, skipStub = false) {
  for (const d of dirs) {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const f = path.join(d, name + ext);
      try { fs.lstatSync(f); } catch { continue; }
      if (skipStub && winStoreStub(f)) continue;
      return f;
    }
  }
  return "";
}
/**
 * WindowsApps 里的 python.exe / python3.exe 是不是应用商店的占位程序。
 * 占位程序一跑就打「Python was not found」、退出码 9009；真从商店装过 Python（或装了官方的 Python 安装管理器），
 * 同一个目录里会有一个 PythonSoftwareFoundation.* 的包目录，这时同名的别名才是真的
 */
function winStoreStub(file) {
  if (!/[\\/]WindowsApps[\\/]/i.test(file)) return false;
  try { return !fs.readdirSync(path.dirname(file)).some((n) => /^PythonSoftwareFoundation\./i.test(n)); } catch { return true; }
}
let py3ShimMemo = { key: "", dir: "", python: "" };
/** 垫片转给真 Python 时，全路径走这个环境变量 */
const PY3_ENV = "OWB_PYTHON3";
/** 转给 PATH 上那个真 python 的垫片：一行纯 ASCII，路径在 OWB_PYTHON3 里 */
const PY3_SHIM_VIA_ENV = `@"%${PY3_ENV}%" %*\r\n`;
/** PATH 上只有 py 启动器时的垫片 */
const PY3_SHIM_VIA_PY = "@py -3 %*\r\n";
/**
 * Windows 上让命令里的 python3 跑得起来。
 *
 * Windows 没有 python3 这个名字：python.org 装的只有 python.exe 和 py.exe，系统却在 WindowsApps 里
 * 放了一个叫 python3.exe 的应用商店占位程序。随包技能里 python3 写死了一百多处，模型自己也习惯写 python3，
 * 真 Python 明明装着，命令全挂在这一层。
 *
 * 所以 PATH 上没有真的 python3、但有真的 python 或 py（官方启动器）时，在垫片目录放一个 python3.cmd 转过去，
 * 调用方把这个目录垫在 PATH 最前面。PATH 上有真的 python 就按全路径转给它
 * （用户自己排在 PATH 上的那个说了算；写全路径是因为占位程序常排在它前面，只写 python 会又落到占位程序上），
 * 没有就转给 py -3。真有 python3 了就把旧垫片删掉，别挡在它前面。
 *
 * 全路径不写进垫片，放在返回的 env 里（OWB_PYTHON3），垫片只认这个变量：cmd 读 .cmd 文件按系统代码页解，
 * 中文 Windows 上是 GBK，C:\Users\张三\… 按 UTF-8 写进去，读出来就是乱码，python3 一条都跑不起来。
 * 变量是按 Unicode 递给子进程的，不过代码页这一关。所以垫片内容只有两种，都是纯 ASCII。
 *
 * 同一份 PATH 只判一次，内容没变不重写；垫片被删了、上次找到的那个 python 不在了，才重判。别的系统什么都不做
 * @param {string} dir 垫片目录
 * @param {string} basePath 子进程原本的 PATH（; 分隔）
 * @returns {{ dir: string, env: Record<string, string> }} dir：要垫在 PATH 前面的目录，不用垫是空串；
 *   env：要一起并进子进程环境的变量（转给真 python 时带 OWB_PYTHON3）
 */
function winPython3Shim(dir, basePath, platform = process.platform) {
  const res = (d, python) => ({ dir: d, env: d && python ? { [PY3_ENV]: python } : {} });
  if (platform !== "win32" || !dir) return res("", "");
  const key = dir + "\0" + basePath;
  const file = path.join(dir, "python3.cmd");
  const there = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
  const m = py3ShimMemo;
  if (m.key === key && (!m.dir || there(file)) && (!m.python || there(m.python))) return res(m.dir, m.python);
  const self = path.resolve(dir).toLowerCase();
  const dirs = String(basePath || "").split(";").filter((d) => d && path.resolve(d).toLowerCase() !== self);
  const py3 = winFindOnPath("python3", dirs);
  let body = "", python = "";
  if (!py3 || winStoreStub(py3)) {
    python = winFindOnPath("python", dirs, true);
    if (python) body = PY3_SHIM_VIA_ENV;
    else if (winFindOnPath("py", dirs)) body = PY3_SHIM_VIA_PY;
  }
  let out = "";
  if (body) {
    let cur = "";
    try { cur = fs.readFileSync(file, "utf8"); } catch {}
    if (cur !== body) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, body);
    }
    out = dir;
  } else {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  py3ShimMemo = { key, dir: out, python: out ? python : "" };
  return res(out, py3ShimMemo.python);
}

/**
 * Windows 上让 Python 往管道里写 UTF-8。不设的话它按系统代码页（中文系统 GBK）写，
 * print 一个 emoji 或生僻字当场 UnicodeEncodeError，脚本半路崩掉；用户自己设过的不动。
 */
function winTextEnv(env = process.env, platform = process.platform) {
  if (platform !== "win32") return {};
  return { PYTHONUTF8: env.PYTHONUTF8 || "1", PYTHONIOENCODING: env.PYTHONIOENCODING || "utf-8" };
}

/** 按平台挑 shell：macOS zsh；Linux bash（没有就 sh）；Windows cmd（ComSpec） */
function pickShell(command, platform = process.platform) {
  if (platform === "win32") {
    // 整条命令外面再包一层引号：/s 会剥掉最外面那对。不包的话，以引号开头又以引号结尾的命令
    // （`"C:\Program Files\x.exe" "a b"`）首尾两个引号被剥掉，路径当场断成两截。Node 自己 shell:true 也是这么拼的。
    // windowsHide：服务进程没有控制台，不加的话每跑一条命令弹一个黑窗口
    return { bin: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], opts: { windowsVerbatimArguments: true, windowsHide: true } };
  }
  // macOS 上 -o nonomatch 是必须的：zsh 默认通配符没匹配上就**整条命令拒绝执行**，
  // 而模型写的是 bash 味的命令。真实会话里这一条烧掉 10 次——
  //   `ls /usr/local/bin/python*` 探测装没装 → ls 根本没跑，只有 zsh 一句抱怨，
  //   模型分不清是"没这个文件"还是"命令挂了"；
  //   `for f in *.md; do ...; done` 没匹配上 → 整个循环连同后面的收尾全不执行，exit 1；
  //   `curl http://a.com/x?id=1` 不加引号 → ? 和 [] 在 zsh 里也是通配符，命令直接不跑。
  // 关掉之后行为跟 bash 一致：通配符原样传给命令，由命令自己报错，脚本接着往下走。
  if (platform === "darwin") return { bin: "/bin/zsh", args: ["-o", "nonomatch", "-c", command], opts: {} };
  const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return { bin: bash, args: ["-c", command], opts: {} };
}

/**
 * 各家 shell 说「没这个命令」的说法都不一样。挨个列出来，比拿一条大正则去猜稳。
 * 顺序有讲究：zsh 那句是 `zsh:1: command not found: ffmpeg`，名字在冒号**后面**；
 * bash 是 `bash: line 1: ffmpeg: command not found`，名字在**前面**。
 * 两条反着写，先跑 zsh 那条——否则 bash 那条会从 zsh 的消息里捞出个 "1" 来。
 */
const NOT_FOUND_RE = [
  /command not found:\s*([\w.+-]+)/i,                        // zsh
  /([\w.+-]+):\s*command not found/i,                        // bash
  /([\w.+-]+):\s*not found/i,                                // dash / sh
  /['"]?([\w.+-]+)['"]?\s*(?:is not recognized|不是内部或外部命令)/i, // Windows cmd
];
/** 命令名是不是 Python 那几个（py / python / python3，带不带 .exe） */
const PY_NAME_RE = /^py(?:thon3?)?(?:\.exe)?$/i;
/**
 * 这条命令里有没有哪一段是在跑 Python：按 & | ; 换行、括号切段（双引号里的不切），只看每段打头的程序名，
 * 带路径、带引号的（"C:\Python312\python.exe" x.py）取文件名再比。
 * `node build.py.js`、`git log -- a.py` 里的 .py 只是参数，不算
 */
function runsPython(command) {
  const segs = [];
  let cur = "", quoted = false;
  for (const ch of String(command || "")) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && "&|;\r\n()".includes(ch)) { segs.push(cur); cur = ""; continue; }
    cur += ch;
  }
  segs.push(cur);
  return segs.some((seg) => {
    const m = seg.trim().replace(/^@/, "").replace(/^call\s+/i, "").match(/^"([^"]*)"|^(\S+)/);
    return !!m && PY_NAME_RE.test(String(m[1] != null ? m[1] : m[2]).split(/[\\/]/).pop() || "");
  });
}
/** Windows 上没有能用的 Python 时递给模型的那句（winget 的包名在 winget-pkgs 里核对过） */
const WIN_PYTHON_HINT = "本机没有能用的 Python。先把 python3 换成 py -3 再跑；py 也没有就装：winget install Python.Python.3.12，装好重开 OpenWorkBuddy。用不到 Python 就换个做法。";

/**
 * 把 shell 那句 command not found 翻译成人话，附上装法。
 *
 * 为什么值得单写一段：成片这条链路最后一步才用到 ffmpeg。模型跳过 skill 里
 * 「先跑一下 ffmpeg -version」那步是常事，于是分镜图全生成完、配音全合成完——
 * 也就是钱全花完之后——才在 concat 那一下撞上 `command not found: ffmpeg`。
 * 模型看到这句话通常会去猜（改命令、换路径、重试），再烧几步才认命。
 * 这里直接把摆出来，它就只能照着说。
 *
 * 只翻译**认识的**那几个（doctor 那张表）。不认识的命令原样交给 shell 自己的报错——
 * 给一句「本机没有 xxx」的废话，只会把真正的报错挤出视野。
 * @returns {string} 要追加的提示（可能是多行）；没有可说的就是空串
 */
function missingBinHint(text, platform = process.platform, ctx = {}) {
  const { knownTool } = require("../platform/known-tools");
  const seen = new Set();
  const lines = [];
  // Windows 上 python 单独说：doctor 那张表里没有它（Mac/Linux 系统自带），可 Windows 上它是最常撞的一个。
  // 三种样子都是「没有能用的 Python」：cmd 说 'python' 不是内部或外部命令；应用商店的占位程序打
  // 「Python was not found」；cmd 找不到命令的退出码是 9009（输出被吞掉时只剩这个）
  const winPython = (bin) => {
    if (platform !== "win32" || seen.has("python")) return false;
    if (bin != null && !PY_NAME_RE.test(bin)) return false;
    seen.add("python");
    lines.push(WIN_PYTHON_HINT);
    return true;
  };
  if (/Python was not found/i.test(String(text || ""))) winPython();
  let named = false; // 输出里点没点名是哪个程序找不到
  for (const line of String(text || "").split("\n")) {
    for (const re of NOT_FOUND_RE) {
      const m = line.match(re);
      if (!m) continue;
      named = true;
      if (winPython(m[1])) break;
      const t = knownTool(m[1], platform);
      if (t && !seen.has(t.name)) {
        seen.add(t.name);
        lines.push(`本机没装 ${t.name}（${t.use}）：${t.install}。装好再跑这条命令；用不到这个功能就别装，换个做法。`);
      }
      break; // 一行只认一个，认出来就别拿后面几条正则再刮一遍
    }
  }
  // 只剩一个 9009：输出里没点名，才去看命令里是不是有一段在跑 Python。
  // 点了名的就是那个程序缺（`python3 a.py && ffmpeg …` 报的是 'ffmpeg'），别再搭一句 Python 的
  if (!named && ctx.code === 9009 && runsPython(ctx.command)) winPython();
  return lines.join("\n");
}

function runShell(command, timeoutMs, cwd, stopSignal, session = "") {
  ensureDirs();
  return new Promise((resolve) => {
    const sh = pickShell(command);
    const child = spawn(sh.bin, sh.args, {
      cwd: cwd || ws(),
      // 同 runNode：整组一起杀，否则 `npm install` 那一窝会活过「让我停下」。超时也一样，见 armTimeout
      detached: process.platform !== "win32",
      env: { ...process.env, ...winTextEnv(), PATH: shellPath(), OPENWORKBUDDY_HOME: DATA_DIR, ...depsGuardEnv(cwd, command, shellPath()) },
      // stdin 不给：留着一根没人写的管道，`read`、python 的 input()、npm init 这种等输入的命令
      // 会一直等到超时才回来。给 /dev/null，它当场读到结尾，要么走默认值要么报错退出
      stdio: ["ignore", "pipe", "pipe"],
      ...sh.opts,
    });
    const out = makeOutSink("shell", 8000, 8000);
    const err = makeOutSink("shell-err", 4000, 6000);
    child.stdout.on("data", (d) => out.write(d));
    child.stderr.on("data", (d) => err.write(d));
    let stopped = false;
    const unbind = bindStop(child, stopSignal, () => { stopped = true; });
    let timedOut = false;
    const disarm = armTimeout(child, timeoutMs, () => { timedOut = true; });
    child.on("close", (code2) => {
      unbind(); disarm();
      const o = out.render(), e = err.render();
      let result = "";
      if (o) result += `stdout:\n${o}\n`;
      if (e) result += `stderr:\n${e}\n`;
      // 先判停止再判超时：用户按停也是走 SIGTERM，两句话反了人看见的就是「超时」。
      // 超时只认计时器：整组收掉之后，直属那层可能是被 SIGKILL 的、也可能是孩子没了自己退的，看信号认不出来
      if (stopped) result += "(用户已停止任务，命令被终止)\n";
      else if (timedOut) result += timeoutNote(timeoutMs, "。开服务、watch 这种不会自己结束的，用 background:true");
      result += `exit code: ${code2}`;
      // 缺的是我们认识的外部工具时，把 shell 那句 command not found 翻译一遍再递出去
      const hint = code2 !== 0 ? missingBinHint(o + "\n" + e, process.platform, { code: code2, command }) : "";
      if (hint) result += "\n" + hint;
      const done = { content: result, isError: stopped || timedOut || code2 !== 0 };
      // `(python3 -m http.server 8731 >/dev/null 2>&1 &)`、`nohup ... &`：外层 shell 退了，进程组里还有人（见 noteStray）
      noteStray(child.pid, command, session, { quiet: stopped || timedOut, tip: "要一直跑，用 background:true 起，交给用户接着用的再加 keep:true" })
        .then((n) => { if (n) done.content += "\n" + n; resolve(done); }, () => resolve(done));
    });
    child.on("error", (e) => {
      unbind(); disarm();
      resolve({ content: `启动失败: ${e.message}`, isError: true });
    });
  });
}

// 资料库（与 server.js 的 /api/library 同一目录）：跨项目共享的参考文件 + 灵感笔记
const LIB_DIR = dataPath("data", "library");
const NOTES_FILE = dataPath("data", "inspirations.json");

/**
 * 当前项目挂载了资料库的哪一块（相对 LIB_DIR 的子目录，""=整个库）。
 *
 * 为什么要有：一个人的库也会摆得很杂。文件一多，做「客户 A 的合同」那个项目时
 * 把「短剧素材」「公司规章」一股脑塞进 library_list，模型就要在一堆不相干的文件名里挑——
 * 挑错了不会报错，只会安静地引用错资料。挂上子目录之后，这个项目的 agent 眼里的资料库就只有那一块。
 *
 * 跟工作目录一样走 ALS：租户请求各自跑在自己的异步链上，用模块级变量会串台。
 * 没 run 过就退回 defaultLibraryRel（= 当前项目的挂载），单机个人版一行行为没变。
 */
let defaultLibraryRel = "";
const libStore = new AsyncLocalStorage();
/**
 * 资料库的**根**在哪。上面那个 ALS 管的是「挂载哪一块」（根底下的子目录），这个管根本身。
 *
 * 为什么要分两层：资料库本来是整台机器共用的一份 data/library。多账号一上来，这就是
 * 「新注册的号打开资料库，看见的是管理员传进去的合同」——跟侧栏那条会话历史是同一个事故。
 * 现在一人一个根（server.js 的 libraryRootOf 决定给谁哪个），挂载那一层原样不动。
 *
 * 跟工作目录一样走 ALS：租户请求各自跑在自己的异步链上，用模块级变量会串台。
 * 没 run 过就是 LIB_DIR——单机个人版、命令行、定时任务全落在这一支，一行行为都没变。
 */
const libBaseStore = new AsyncLocalStorage();
function withLibraryBase(dir, fn) {
  return libBaseStore.run(String(dir || "") || LIB_DIR, fn);
}
function libBase() {
  return libBaseStore.getStore() || LIB_DIR;
}
/** 灵感笔记落在哪。老库那一支还是原来的 data/inspirations.json，一个字节都不搬；
 *  别人的根底下各放一份（点头开头，列资料库时本来就跳过） */
function notesFileOf(base) {
  return (base || LIB_DIR) === LIB_DIR ? NOTES_FILE : path.join(base, ".inspirations.json");
}
/** 把一段相对路径洗干净：统一正斜杠、去空段、拒绝 `..` 和以 `.` 开头的段（别让人翻到 .ssh 去） */
function cleanLibRel(rel) {
  const parts = String(rel || "").replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  return parts.some((x) => x === ".." || x.startsWith(".")) ? "" : parts.join("/");
}
function setLibraryDir(rel) {
  defaultLibraryRel = cleanLibRel(rel);
  return defaultLibraryRel;
}
function getLibraryDir() {
  const v = libStore.getStore();
  return v === undefined ? defaultLibraryRel : v;
}
function withLibraryDir(rel, fn) {
  return libStore.run(cleanLibRel(rel), fn);
}
/** agent 这一侧看得见的资料库根。挂载目录被人在磁盘上删掉了就退回整个库，别让工具整个哑掉 */
function libRoot() {
  const base = libBase();
  const rel = getLibraryDir();
  if (!rel) return base;
  const abs = path.join(base, rel);
  try { if (fs.statSync(abs).isDirectory()) return abs; } catch {}
  return base;
}
/** 解析资料库里的相对路径，越界（../、绝对路径、软链跳出去）一律拒绝 */
function libResolve(name) {
  const rel = cleanLibRel(name);
  if (!rel) return "";
  const root = libRoot();
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return "";
  return abs;
}

/**
 * 列资料库。
 *
 * 递归而不是只列一层：资料库支持子目录之后，只列第一层的话模型看到的是三个文件夹名字，
 * 然后它没有「进目录」这个工具，等于把素材锁在了门后面。深度封 4 层、条数封 300，
 * 再多就换成一句「还有 N 个没列出来」——上下文烧光了比列不全更糟。
 */
const LIB_LIST_MAX = 300;
function libraryList() {
  const root = libRoot();
  const files = [];
  let more = 0;
  const walk = (rel, depth) => {
    if (depth >= 4) return;
    let ents = [];
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(child, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (files.length >= LIB_LIST_MAX) { more++; continue; }
      let st;
      try { st = fs.statSync(path.join(root, child)); } catch { continue; }
      files.push(`${child}\t${st.size} 字节\t${st.mtime.toISOString()}`);
    }
  };
  walk("", 0);
  files.sort();
  let notes = [];
  try {
    notes = JSON.parse(fs.readFileSync(notesFileOf(libBase()), "utf8"));
  } catch {}
  const parts = [];
  const scope = getLibraryDir() && libRoot() !== libBase()
    ? `（本项目只挂载了资料库的「${getLibraryDir()}」这一块，下面的路径都相对它）`
    : "";
  parts.push(files.length
    ? `【资料文件】${scope}（用 library_read 读取，名字要带上子目录，一字不差）\n${files.join("\n")}${more ? `\n…… 还有 ${more} 个没列出来，太多了` : ""}`
    : `【资料文件】${scope}（空）`);
  parts.push(
    notes.length
      ? `【灵感笔记】\n${notes.map((n) => `- [${(n.at || "").slice(0, 10)}] ${n.text}`).join("\n")}`
      : "【灵感笔记】（空）"
  );
  return parts.join("\n\n");
}

/**
 * 读资料库里的一个文件。
 *
 * 两处老毛病一起修：
 *   1. **一律按 utf8 读。** 资料库是用户在界面上直接拖文件进来的，里面躺的是 PDF、截图、
 *      Word、压缩包——按文本读回来是五万字符乱码。模型看不出这是「格式不对」，只会当成
 *      内容读进去再拿它下结论。先嗅一眼文件头（跟 fetch_url 共用同一个 looksBinary），
 *      是二进制就说实话，并且指出下一步该怎么走。
 *   2. **文件不存在时把绝对路径抖进对话。** 原来的 ENOENT 会带出 `/Users/xxx/...` 整条
 *      本机路径。名字打错是常事，代价不该是泄露用户的目录结构。
 */
function libraryRead(name) {
  const abs = libResolve(name);
  const base = path.basename(String(name || ""));
  if (!abs) return { text: "文件名不合法。名字要一字不差地取自 library_list 的结果（含子目录，如 客户A/合同.md）。", bad: true };
  let buf;
  try { buf = fs.readFileSync(abs); }
  catch { return { text: `资料库里没有「${base}」。先用 library_list 看看到底有哪些文件，名字要一字不差。`, bad: true }; }
  if (looksBinary("", buf)) {
    const next = DOC_EXT.test(base)
      ? "先用 library_import 把它复制到工作目录，再用 read_document 读。"
      : /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(base)
        ? "先用 library_import 把它复制到工作目录，再用 look_at_image 看（记得带上你想知道的具体问题）。"
        : /\.pdf$/i.test(base)
          ? `先用 library_import 复制到工作目录，然后：${pdfHowTo(base)}`
          : "先用 library_import 把它复制到工作目录，再按它的真实类型处理。";
    return { text: `${base} 不是文本文件（${(buf.length / 1024).toFixed(0)} KB，按文本读只会得到乱码）。${next}`, bad: true };
  }
  return { text: buf.toString("utf8").slice(0, 50000), bad: false };
}

/**
 * 把资料库里的一个文件复制到当前对话的工作目录。
 *
 * 为什么非有不可：资料库是个「只读的共享素材架」，模型能列能读，但 read_document /
 * look_at_image / run_node 这些全都只认工作目录里的相对路径——素材摆在架子上却一个也用不了。
 * 没有这个工具时模型唯一的出路是自己拼绝对路径去 run_shell cp，而那条路径落在 data 目录里，
 * 安全中心本来就该拦（也确实拦了），于是变成一条必然撞墙的死路。
 *
 * **只往一个方向复制：库 → 工作目录。** 反过来不做。资料库是人自己摆的那个架子：
 * 哪份合同模板能留、分在哪个客户的文件夹里，都是他一次次决定的。任务跑出来的东西归工作目录，
 * 要不要进架子他自己说了算。给 agent 开一个写回的口子，库里就会您您多出一堆没人要的中间产物，
 * 而这些东西下一次任务又会被 library_list 读回去。
 */
function libraryImport(name, dir) {
  const src = libResolve(name);
  const base = path.basename(String(name || ""));
  if (!src) return { text: "文件名不合法。名字要一字不差地取自 library_list 的结果（含子目录，如 客户A/合同.md）。", bad: true };
  let st;
  try { st = fs.statSync(src); }
  catch { return { text: `资料库里没有「${base}」。先用 library_list 看看到底有哪些文件，名字要一字不差。`, bad: true }; }
  if (!st.isFile()) return { text: `${base} 不是文件。`, bad: true };
  const into = dir || ws();
  fs.mkdirSync(into, { recursive: true });
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  // 重名不覆盖，跟 saveDownload 同一个口径：工作目录里可能已经躺着用户自己的同名文件。
  // 用 COPYFILE_EXCL 而不是「先看在不在再写」——只读工具是并发跑的，那道缝真会撞上
  for (let i = 1; i < 50; i++) {
    const out = i === 1 ? base : `${stem}_${i}${ext}`;
    try {
      fs.copyFileSync(src, path.join(into, out), fs.constants.COPYFILE_EXCL);
      return { text: `已把资料库里的「${base}」复制到工作目录：${out}（${(st.size / 1024).toFixed(0)} KB）。现在直接用相对路径 ${out} 读它就行。`, bad: false };
    } catch (e) {
      if (e.code !== "EEXIST") return { text: `复制失败：${e.code || e.message}`, bad: true };
    }
  }
  return { text: `工作目录里已经有太多个同名的「${base}」了，先清理一下。`, bad: true };
}

// ---------------- 结构化文档：docx / xlsx / pptx / zip ----------------
// 甲方发过来最多的就是这几样，也正是这个产品自己的主交付物。解析器早就写好了
// （preview.js，零新依赖：Node 自带 zlib 读 zip + 本来就有的 exceljs），但一直只接在
// 预览接口上给人看，agent 一个入口都没有——read_file 把 .docx 按 utf8 读回来是五万字符
// 乱码，白烧一大块上下文还什么都没看到。这里把同一个解析器拍平成纯文本喂给模型。
// 三条不能破的线：
//   1. **内嵌图一律换成 ［图片］ 占位。** preview.js 会把图转成 data URI（20 张 × 3MB 封顶），
//      拼进文本等于往上下文里灌几十 MB base64，比乱码更糟。
//   2. **截断要如实说。** previewData 自己有 LIMITS（3000 段 / 20 表 / 2000 行 / 300 页）和
//      truncated 标志，拍平后还要再按字符截一次。不说清楚，模型会拿半份当全文下结论。
//   3. **PDF 不归这里。** previewData 只认这四种，pdf 进来会抛「不认识的预览类型」。
//      PDF 走 read_file 里那条 pdftotext 指路，别把模型骗到一个必然报错的工具上。
const DOC_EXT = /\.(docx|xlsx|pptx|zip)$/i;
const DOC_CHARS = 50000; // 跟 read_file 同一个口径

/**
 * PDF 怎么取文字。**这段话必须是能照着做完的**——之前写的是「没装就在 run_node 里解析」，
 * 而 run_node 那个沙箱里压根没有任何 PDF 库，模型照着做必然撞墙，白烧两三轮。
 * 现在给的是真装得上的命令，各平台一条。`openworkbuddy doctor` 里也会把 pdftotext 列进体检项。
 */
function pdfHowTo(name, platform = process.platform) {
  const q = `"${name}"`;
  // Windows 给 winget：系统自带。scoop、choco 都得先装包管理器本身，模型照着敲第一句就撞墙。
  // 这个包是解压即用的 zip，清单里标了 ArchiveBinariesDependOnPath：winget 不往 WinGet\Links 里放链接，
  // 而是把 WinGet\Packages\oschwartz10612.Poppler_…\poppler-<版本>\Library\bin 加进注册表 PATH。
  // run_shell 的 PATH 会现去那里找（engines/which 的 popplerBins），装完 where 一般就找得到；
  // 还找不到就让它按文件名把全路径搜出来，别去猜版本号那一层目录
  const install =
    platform === "darwin"
      ? "`brew install poppler`"
      : platform === "win32"
        ? "`winget install oschwartz10612.Poppler`（装完 where 还找不到的话，跑 `dir /s /b \"%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\pdftotext.exe\"` 找出全路径，用全路径跑）"
        : "`apt install poppler-utils`（或 `dnf install poppler-utils`）";
  return (
    `PDF 取文字要靠 pdftotext：先 run_shell 跑 \`${platform === "win32" ? "where" : "which"} pdftotext\`，` +
    `装了就 \`pdftotext -layout ${q} -\`；没装先装 ${install}。` +
    `装不上就直说装不上，别自己写代码解析——run_node 里没有任何 PDF 库。`
  );
}

/** 一串 run 拼成纯文本。加粗/斜体这些格式对模型没意义，丢掉 */
// 链接的地址跟在文字后面用括号带出来。文档里写「详见这里」的时候，
// 只给"这里"两个字等于没给——模型答不了「文中引用了哪些网址」。
const runsText = (runs) => (runs || []).map((r) => {
  const t = String(r.s || "");
  return r.href && t.trim() ? t + "（" + r.href + "）" : t;
}).join("");

function docToText(d) {
  const out = [];
  // 有序列表得真的数出「1. 2. 3.」来。以前不管有序无序一律打"-"，
  // 于是「合同第 3 条是什么」这种最常见的问题，模型只能自己数横杠，数错不自知。
  // 计数按层级走：进到深一层要清零，回到浅一层要接着上次数。
  const counters = [];
  for (const b of d.blocks || []) {
    if (b.t === "img") { out.push("［图片］"); continue; } // 绝不把 data URI 拼进上下文
    if (b.t === "table") {
      counters.length = 0;
      for (const row of b.rows || []) out.push("| " + row.map((c) => runsText(c.runs).replace(/\n/g, " ")).join(" | ") + " |");
      out.push("");
      continue;
    }
    const s = runsText(b.runs);
    if (b.t !== "li") counters.length = 0;   // 中间插了正文，序号就该重新起
    if (!s.trim()) { out.push(""); continue; }
    if (b.t === "h") out.push("#".repeat(Math.min(6, Number(b.lvl) || 1)) + " " + s);
    else if (b.t === "li") {
      const lvl = Number(b.lvl) || 0;
      counters.length = lvl + 1;
      if (b.ord) {
        counters[lvl] = (counters[lvl] || 0) + 1;
        out.push("  ".repeat(lvl) + counters[lvl] + ". " + s);
      } else {
        counters[lvl] = 0;
        out.push("  ".repeat(lvl) + "- " + s);
      }
    } else out.push(s);
  }
  // 页眉页脚放最后，标清楚是页眉页脚——「内部资料 请勿外传」这种话只写在页眉里，
  // 混进正文会被当成某一段的内容，单独一行才知道它管的是整份文档。
  if (d.header) out.push("", "【页眉】" + d.header);
  if (d.footer) out.push("【页脚】" + d.footer);
  return out.join("\n");
}

function slidesToText(d) {
  const out = [];
  for (const s of d.slides || []) {
    out.push(`## 第 ${s.n} 页　${s.title || "(无标题)"}`);
    for (const l of s.lines || []) out.push("  ".repeat(Number(l.lvl) || 0) + "- " + l.s);
    if (s.notes) out.push("【备注】" + s.notes);
    out.push("");
  }
  return out.join("\n");
}

// 大表一次全吐会把上下文吃光，所以 sheet/from/to 三个参数就是用来翻页的。
// sheet 可以给名字也可以给序号（1 起）——模型手里只有 library_list 那种纯文本，
// 让它必须精确拼出工作表名字是给自己找麻烦。
function sheetsToText(d, want, from, to) {
  const all = d.sheets || [];
  const q = String(want == null ? "" : want).trim();
  let picked = all;
  if (q) {
    const byIndex = /^\d+$/.test(q) ? all[Number(q) - 1] : null;
    const byName = all.find((s) => s.name === q) || all.find((s) => String(s.name).toLowerCase() === q.toLowerCase());
    const hit = byName || byIndex;
    if (!hit) return { text: `没有名为「${q}」的工作表。这份表里有：${all.map((s, i) => `${i + 1}.${s.name}`).join("、")}`, bad: true };
    picked = [hit];
  }
  const out = [];
  for (const s of picked) {
    const a = Math.max(1, Number(from) || 1);
    const b = Math.max(a, Number(to) || s.rows.length);
    const slice = s.rows.slice(a - 1, b);
    out.push(`## 工作表「${s.name}」　共 ${s.totalRows} 行 × ${s.totalCols} 列`);
    if (a > 1 || b < s.rows.length) out.push(`（本次只给第 ${a}-${Math.min(b, s.rows.length)} 行）`);
    for (const row of slice) out.push(row.join("\t"));
    if (s.truncated) out.push(`（这张表太大，解析时已截断：最多取 ${s.rows.length} 行 × 每行 ${(s.rows[0] || []).length} 列）`);
    out.push("");
  }
  return { text: out.join("\n"), bad: false };
}

function archiveToText(d) {
  const out = [`共 ${d.total} 个文件，解压后 ${(d.bytes / 1024).toFixed(0)} KB`];
  for (const e of d.entries || []) out.push(`${e.name}\t${e.size} 字节`);
  if (d.truncated) out.push(`（只列了前 ${(d.entries || []).length} 个）`);
  return out.join("\n");
}

/**
 * 读一份结构化文档，拍平成纯文本。
 * @param {string} abs 已经过 resolveFile 的绝对路径
 * @param {string} rel 用户/模型给的原始相对路径，只用来说人话
 */
async function readDocument(abs, rel, input) {
  const { previewData } = require("../domains/library/preview");
  if (!DOC_EXT.test(abs)) {
    throw new Error(`read_document 只读 .docx / .xlsx / .pptx / .zip。${rel} 不是这几种——纯文本用 read_file，PDF 用 pdftotext（read_file 会告诉你怎么装）。`);
  }
  const d = await previewData(abs, path.basename(abs)); // xlsx 分支是 async，必须 await
  let body = "", head = "";
  if (d.kind === "doc") {
    body = docToText(d);
    head = `《${path.basename(rel)}》Word 文档`;
    if (d.truncated) head += `（正文太长，解析时已截断，后面还有没读到的段落）`;
  } else if (d.kind === "slides") {
    body = slidesToText(d);
    head = `《${path.basename(rel)}》PPT，共 ${d.total} 页`;
    if (d.truncated) head += `（只解析了前 ${(d.slides || []).length} 页）`;
  } else if (d.kind === "sheet") {
    const r = sheetsToText(d, input.sheet, input.from, input.to);
    // 表名对不上要按失败报，不能当正常结果返回：模型看见 isError=false 会以为这就是内容，
    // 接着拿「没有名为 X 的工作表」这句话去下结论
    if (r.bad) throw new Error(r.text);
    body = r.text;
    head = `《${path.basename(rel)}》Excel，共 ${d.total} 张工作表`;
    if (d.truncated) head += `（只解析了前 ${(d.sheets || []).length} 张）`;
  } else {
    body = archiveToText(d);
    head = `《${path.basename(rel)}》压缩包`;
  }
  const cut = body.length > DOC_CHARS;
  return head + "\n\n" + body.slice(0, DOC_CHARS) + (cut ? `\n\n（已截断，还有 ${body.length - DOC_CHARS} 字符没给你。Excel 可以用 sheet/from/to 分段读。）` : "");
}

const LIST_SKIP = new Set([".tmp", "node_modules", ".git", ".DS_Store", ".history"]);

/**
 * 列目录。depth>1 时递归展开——看项目结构时一次看清，比一层层 list_files 省好几轮。
 * prefix 是 target 相对工作目录的路径，每一项都带上它：拿去 read_file 就是那个文件（跟 find_files、search_files 一个起点）
 */
function listFiles(target, depth = 1, prefix = "") {
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
  })(target, prefix, 1);
  if (!out.length) return "（空目录）";
  return out.join("\n") + (truncated ? "\n（超过 400 项，后面的没列——用 dir 指到具体子目录再看）" : "");
}

/**
 * 路径指到了一个目录。以前这里什么都不拦，fs.readFileSync 直接抛 EISDIR，
 * 模型看到「illegal operation on a directory」根本不知道自己错在哪，
 * 于是掉头改用 write_file 整篇重写——上一次报告丢了三节就是这么丢的。
 * 现在当场说清楚：这是目录，里面有这些文件，你要的是哪个。
 */
function dirInsteadOfFile(p, label) {
  let names = [];
  try {
    names = fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => e.name)
      .slice(0, 12);
  } catch {}
  return new Error(
    `${label} 是一个目录，不是文件。` +
      (names.length ? `里面有：${names.join("、")}。带上文件名再来一次（${label}/${names[0]}）。` : "这个目录是空的。") +
      `别因为这个就改用 write_file 整篇重写——那会把你没读过的内容一起抹掉。`
  );
}

/** 覆盖前留底：workspace/.history/<原路径>.<时间戳>，同一个文件只留最近 5 份 */
function keepBackup(file, rel) {
  if (String(rel).split(/[\\/]/)[0] === ".history") return "";
  try {
    const sub = path.dirname(rel);
    const dir = path.join(ws(), ".history", sub);
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(rel);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(file, path.join(dir, `${base}.${stamp}`));
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith(base + ".")).sort();
    for (const f of olds.slice(0, -5)) fs.rmSync(path.join(dir, f), { force: true });
    return path.join(".history", sub, `${base}.${stamp}`);
  } catch {
    return "";
  }
}

const SNAPSHOT_MAX = 32 * 1024 * 1024;
const DIFF_MAX_CHARS = 2 * 1024 * 1024;
const DIFF_MAX_TEXT = 4000;

/** 改之前那份内容（Buffer）。不存在、是目录、大到不像文本的都给 null */
function readBefore(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > SNAPSHOT_MAX) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function looksText(buf) {
  const head = buf.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return false;
  return true;
}

function textOf(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  return looksText(x) ? x.toString("utf8") : null;
}

/** 给人看的 diff：两边都是文本、都不太大才算。审批卡和过程卡上用，超过 4000 字截掉 */
function diffText(rel, before, after) {
  const a = textOf(before), b = textOf(after);
  if (a == null || b == null || a.length > DIFF_MAX_CHARS || b.length > DIFF_MAX_CHARS) return "";
  let d = checkpoints.unifiedDiff(a, b, { name: rel, context: 2, maxLines: 120 });
  if (d.length > DIFF_MAX_TEXT) d = d.slice(0, DIFF_MAX_TEXT) + "\n… 太长，后面截掉了";
  return d;
}

/**
 * 落盘之后：记一个检查点、把 diff 挂到结果上。
 * diff 跟着 tool_result 事件进过程卡；检查点 id 让那张卡上的「回退到这步之前」有的可按。
 * 留底失败不影响结果本身——文件已经写对了，账没记上只是这一步退不回去。
 */
function noteChange(result, { root, abs, rel, before, after, tool, session, call, record = true }) {
  const diff = diffText(rel, before, after);
  const entry = record ? checkpoints.record(root, { session, call, tool, abs, before, after }) : null;
  return { ...result, editedFile: abs, ...(diff ? { diff } : {}), ...(entry ? { ckpt: entry.id } : {}) };
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
 * 逐行去掉首尾空白之后的匹配。只在精确匹配失败时兜底用。
 *
 * 真实数据里 edit_file 的失败率 12.8%（156 次调用里 21 次没命中），而且没命中之后
 * 模型 5/6 的反应是回头再 read_file 一遍整篇文件，平均要多花 2.8 次工具调用才重新写回去——
 * 大文件重读一遍还要烧掉一大块上下文。缩进对不上是最不值得付这个代价的一种。
 *
 * 返回命中的行区间 [起始行, 结束行)（0 基）。只做整行匹配：old_text 是半行片段时不会误命中。
 */
function looseLineMatch(lines, needle) {
  const nl = needle.replace(/\s+$/, "").split("\n").map((l) => l.trim());
  while (nl.length && nl[nl.length - 1] === "") nl.pop();
  if (!nl.length || nl.join("").length < 3) return [];
  const hits = [];
  for (let i = 0; i + nl.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < nl.length; j++) {
      if (lines[i + j].trim() !== nl[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push([i, i + nl.length]);
  }
  return hits;
}

/** 按「文件里那行的缩进」和「old_text 那行的缩进」之差，把 new_text 整体挪一挪。挪不动就原样返回。 */
function shiftIndent(fileLine, needleLine, repl) {
  const fi = (fileLine.match(/^[ \t]*/) || [""])[0];
  const ni = (needleLine.match(/^[ \t]*/) || [""])[0];
  if (fi === ni) return repl;
  if (fi.startsWith(ni)) {
    const add = fi.slice(ni.length);
    return repl
      .split("\n")
      .map((l) => (l.trim() ? add + l : l))
      .join("\n");
  }
  if (ni.startsWith(fi)) {
    const cut = ni.slice(fi.length);
    return repl
      .split("\n")
      .map((l) => (l.startsWith(cut) ? l.slice(cut.length) : l))
      .join("\n");
  }
  return repl;
}

/**
 * 宽松命中的那几行，文件里的缩进和 old_text 里的缩进是不是每行都差同样多（空行不算）。
 * 按列比，不按字符串比：文件用 Tab、它给空格是正常情况，得认。一个 Tab 算几列，
 * 从第一对「一边全 Tab、一边全空格」的行里对出来，对不出来按 4。
 */
function sameIndentShift(fileLines, needleLines) {
  const lead = (l) => (l.match(/^[ \t]*/) || [""])[0];
  let unit = 0;
  for (let j = 0; j < fileLines.length && !unit; j++) {
    const f = lead(fileLines[j]), n = lead(needleLines[j] || "");
    if (/^\t+$/.test(f) && /^ +$/.test(n) && n.length % f.length === 0) unit = n.length / f.length;
    else if (/^ +$/.test(f) && /^\t+$/.test(n) && f.length % n.length === 0) unit = f.length / n.length;
  }
  const cols = (s) => [...s].reduce((w, ch) => w + (ch === "\t" ? unit || 4 : 1), 0);
  const deltas = new Set();
  fileLines.forEach((l, j) => { if (l.trim()) deltas.add(cols(lead(l)) - cols(lead(needleLines[j] || ""))); });
  return deltas.size <= 1;
}

/**
 * 文件用 Tab 缩进、它给的是空格（或反过来）：照写就是一个块里 Tab 空格混着，Python 直接 TabError。
 * 一层等于几个空格从命中的那几行里对出来——每一对都得算出同一个整数，对不上就不猜，原样返回。
 */
function matchIndentStyle(fileLines, needleLines, repl) {
  const lead = (l) => (l.match(/^[ \t]*/) || [""])[0];
  let dir = null, unit = 0;
  for (let j = 0; j < Math.min(fileLines.length, needleLines.length); j++) {
    const f = lead(fileLines[j]), n = lead(needleLines[j]);
    if (!f || !n || !fileLines[j].trim()) continue;
    const d = /^\t+$/.test(f) && /^ +$/.test(n) ? "toTabs" : /^ +$/.test(f) && /^\t+$/.test(n) ? "toSpaces" : f === n ? "same" : "mixed";
    if (d === "mixed" || (dir && d !== dir)) return repl;
    dir = d;
    if (d === "same") continue;
    const [tabs, spaces] = d === "toTabs" ? [f.length, n.length] : [n.length, f.length];
    if (spaces % tabs) return repl;
    if (unit && unit !== spaces / tabs) return repl;
    unit = spaces / tabs;
  }
  if (!unit || dir === "same" || !dir) return repl;
  return repl.split("\n").map((l) => {
    if (!l.trim()) return l;
    const ld = lead(l);
    const width = [...ld].reduce((w, ch) => w + (ch === "\t" ? unit : 1), 0);
    const ind = dir === "toTabs" ? "\t".repeat(Math.floor(width / unit)) + " ".repeat(width % unit) : " ".repeat(width);
    return ind + l.slice(ld.length);
  }).join("\n");
}

/** 开头 8KB 里有 NUL 字节就当二进制。UTF-16 文本也会中，但那种按 utf8 读同样是乱码 */
function fileHasNul(p) {
  let fd;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, n).includes(0);
  } catch { return false; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

/** 整篇都是 \r\n 换行（一个裸 \n 都没有）。混着的文件不算：那种不替它统一 */
function pureCrlf(text) {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

/**
 * 没命中时，把文件在最可能那一段的**原文**直接贴回去，让它照抄——
 * 而不是只报一句「先 read_file」，逼它把整篇文件重读一遍。
 * 锚点不只看 old_text 的第一行：21 次没命中里有 10 次连提示都给不出来，就是因为只认第一行。
 */
function missHint(lines, needle) {
  const nls = needle.split("\n");
  let best = null;
  nls.forEach((raw, j) => {
    const t = raw.trim();
    if (t.length < 4) return;
    const key = t.slice(0, 60);
    const hits = [];
    for (let i = 0; i < lines.length && hits.length < 6; i++) if (lines[i].includes(key)) hits.push(i);
    if (!hits.length) return;
    // 唯一命中的行最值钱；同样唯一时取更长的（更有辨识度）
    const score = (hits.length === 1 ? 1e6 : 1e3 / hits.length) + t.length;
    if (!best || score > best.score) best = { j, hits, score };
  });
  if (!best) return `\nold_text 里没有任何一行出现在这个文件里（全文共 ${lines.length} 行）——多半是改错文件了，或者这段内容早被覆盖过。先 read_file 确认。`;
  const out = [];
  for (const h of best.hits.slice(0, 2)) {
    const start = Math.max(0, h - best.j - 1);
    const end = Math.min(lines.length, start + nls.length + 3);
    let block = lines.slice(start, end).join("\n");
    let cut = "";
    if (block.length > 2000) {
      block = block.slice(0, 2000);
      cut = "\n…（太长，只贴了前 2000 字）";
    }
    out.push(`文件第 ${start + 1}-${end} 行现在是这样：\n<<<原文开始\n${block}${cut}\n>>>原文结束`);
  }
  return `\n${out.join("\n")}\n把上面这段里你要改的部分**原样**抄成 old_text 再来一次，不用再 read_file 了。`;
}

/**
 * 精确替换。改已有文件只走这里，不许整篇重写——
 * 重写会把模型没读过的部分一起抹掉，而且用户 diff 一看全是红的，根本审不了。
 * 匹配不上/不唯一都必须报清楚原因（并给出下一步怎么办），不能默默改错地方。
 *
 * 只算不写：返回改完的全文和回执。先算后写，中间才插得进「给用户看 diff、等他批」这一步。
 */
function planEdit(src, label, input) {
  // Windows 换行的文件：它给的 old_text/new_text 几乎总是 \n。按 \n 算、写回时再换回 \r\n——
  // 不然改过的那几行变成 \n，文件换行混着，diff 满屏红，有的 Windows 工具直接读歪
  if (!pureCrlf(src)) return planEditLf(src, label, input);
  const lf = (x) => (x == null ? x : String(x).replace(/\r\n/g, "\n"));
  const r = planEditLf(src.replace(/\r\n/g, "\n"), label, { ...input, old_text: lf(input.old_text), new_text: lf(input.new_text) });
  return { ...r, src, out: r.noop ? src : r.out.replace(/\n/g, "\r\n") };
}

function planEditLf(src, label, { old_text, new_text, replace_all }) {
  const needle = String(old_text == null ? "" : old_text);
  if (!needle) throw new Error("old_text 是空的：edit_file 必须给出要被替换掉的原文");
  // 没给 new_text 不能当「删掉」处理：参数名写成 new_str、或者干脆漏了，老写法照样回「已修改」，
  // 整个函数就这么没了。要删得显式给 ""
  if (new_text == null) throw new Error(`没给 new_text，文件没动。要替换成什么写在 new_text 里；确实要删掉这段就显式传 new_text:""。`);
  const repl = String(new_text);
  const same = { src, out: src, noop: true, msg: `${label} 内容没有变化（new_text 和 old_text 一样）` };
  const idx = src.indexOf(needle);
  if (idx < 0) {
    const lines = src.split("\n");
    // 先看看是不是只差缩进/行尾空白。是的话别为难它，直接改，回执里说清是怎么匹配上的。
    const loose = looseLineMatch(lines, needle);
    if (loose.length > 1) {
      throw new Error(
        `old_text 和文件里 ${loose.length} 处内容只差缩进或行尾空白（第 ${loose.map((h) => h[0] + 1).join("、")} 行），不唯一，不敢猜改哪一处。多带几行上下文让它唯一。`
      );
    }
    if (loose.length === 1) {
      const [start, end] = loose[0];
      // 只按第一行的缩进差把 new_text 整体挪，前提是每一行差的都一样。
      // 不一样（YAML 被它写平了、Python 中间一行缩错了）就没法知道 new_text 每行该缩多少：
      // 照第一行挪，YAML 层级就变了、b() 就挪进了 if 里，语法检查还查不出来。宁可不改，把原文贴给它
      if (!sameIndentShift(lines.slice(start, end), needle.replace(/\s+$/, "").split("\n"))) {
        let block = lines.slice(start, end).join("\n");
        const cut = block.length > 2000 ? "\n…（太长，只贴了前 2000 字）" : "";
        if (cut) block = block.slice(0, 2000);
        throw new Error(
          `old_text 和文件第 ${start + 1}-${end} 行只差缩进，但各行差得不一样，猜不出 new_text 每行该缩多少，文件没动。那几行现在是这样：\n` +
            `<<<原文开始\n${block}${cut}\n>>>原文结束\n把这段**原样**抄成 old_text（new_text 也照这个缩进写）再来一次，不用再 read_file 了。`
        );
      }
      // 命中的是 [start, end) 这几整行，不含最后一行的换行符。old_text 末尾带的换行在文件里对应的是这个换行，
      // new_text 末尾同样的换行得去掉，不然拼回去多出一个空行
      let r2 = repl;
      for (let k = (needle.match(/\s*$/)[0].match(/\n/g) || []).length; k > 0 && /\n[ \t]*$/.test(r2); k--) r2 = r2.replace(/\n[ \t]*$/, "");
      // new_text 是空的 = 要把这几行删掉，别塞一个空行进去
      const body = repl === "" ? [] : matchIndentStyle(lines.slice(start, end), needle.split("\n"), shiftIndent(lines[start], needle.split("\n")[0], r2)).split("\n");
      const out = lines.slice(0, start).concat(body, lines.slice(end)).join("\n");
      if (out === src) return same;
      return {
        src,
        out,
        noop: false,
        msg:
          `已修改 ${label}：在第 ${start + 1} 行替换了 1 处，${src.length} → ${out.length} 字符。` +
          `（你给的 old_text 缩进/行尾空白和文件里对不上，按逐行去掉首尾空白后唯一匹配到这里，替换内容已按文件原缩进写回。下次照抄文件原文就不用绕这一道。）`,
      };
    }
    throw new Error(`没找到 old_text（必须和文件里逐字一致，包括缩进和空行）。` + missHint(lines, needle));
  }
  const hits = countAll(src, needle);
  if (hits > 1 && !replace_all) {
    throw new Error(`old_text 在 ${label} 里出现了 ${hits} 次，不唯一，不敢猜改哪一处。多带几行上下文让它唯一；确实要全改就传 replace_all=true。`);
  }
  const out = replace_all ? src.split(needle).join(repl) : src.slice(0, idx) + repl + src.slice(idx + needle.length);
  if (out === src) return same;
  const line = src.slice(0, idx).split("\n").length;
  const where = replace_all && hits > 1 ? `替换了 ${hits} 处` : `在第 ${line} 行替换了 1 处`;
  return { src, out, noop: false, msg: `已修改 ${label}：${where}，${src.length} → ${out.length} 字符` };
}

function readSource(file, label) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${label}。新建文件请用 write_file。`);
  if (fs.statSync(file).isDirectory()) throw dirInsteadOfFile(file, label);
  // 按 UTF-8 解开再写回去：GBK 的中文、图片里的字节解不开，全变成 �，改一行坏一片，
  // 撤销留底记的也是坏掉那一版。解开再编回去跟原字节对不上，就一个字节都不动。
  // 不用 TextDecoder 判：它默认把 BOM 吃掉，写回去 BOM 就没了
  const buf = fs.readFileSync(file);
  const src = buf.toString("utf8");
  if (!Buffer.from(src, "utf8").equals(buf)) {
    const bin = buf.includes(0);
    throw new Error(
      `已拦截，一个字节都没改：${label} 不是 UTF-8 文本（${bin ? "里面有 0 字节，像是二进制文件" : "可能是 GBK、Latin-1 这类旧编码"}）。` +
        `edit_file/multi_edit 按 UTF-8 改，会把里面所有非 UTF-8 的字节换成乱码，撤销也找不回原样。` +
        (bin
          ? "二进制文件不能按文本改。"
          : `要保留原编码，用 run_shell 按原编码读写（比如 Python 里 open(p, encoding="gbk")）；确定能转成 UTF-8 的，先 iconv -f GBK -t UTF-8 转好再改。`)
    );
  }
  return src;
}

/**
 * multi_edit 的计算部分：按顺序一处接一处套 planEdit，任何一处失败整个作废。
 * 报错带上是第几处——模型才知道前面几处没问题、只要修这一处。
 */
function planMulti(src, label, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error("edits 是空的：至少给一处 {old_text, new_text}");
  if (edits.length > 50) throw new Error(`一次最多 50 处，你给了 ${edits.length} 处。分几次改`);
  // 漏了 new_text 的先挑出来单说：它跟 old_text 对不上是两回事，别吃到下面那句「old_text 要照改完的样子写」
  const bare = edits.findIndex((e) => e && e.new_text == null);
  if (bare >= 0) throw new Error(`第 ${bare + 1} 处（共 ${edits.length} 处）没给 new_text，整个文件没动。要删掉那段就显式传 new_text:""。`);
  let cur = src;
  const notes = [];
  for (const [i, e] of edits.entries()) {
    let step;
    try {
      step = planEdit(cur, label, e || {});
    } catch (err) {
      throw new Error(`第 ${i + 1} 处（共 ${edits.length} 处）改不了，整个文件没动：${err.message}` + (i ? `\n注意前 ${i} 处是按顺序先改的，第 ${i + 1} 处的 old_text 要照前面改完之后的样子写。` : ""));
    }
    if (!step.noop) { cur = step.out; notes.push(step.msg.replace(/^已修改 [^：]*：/, "").replace(/，\d+ → \d+ 字符$/, "")); }
  }
  if (cur === src) return { src, out: src, noop: true, msg: `${label} 内容没有变化` };
  return { src, out: cur, noop: false, msg: `已修改 ${label}：${edits.length} 处全部改好（${notes.join("；")}），${src.length} → ${cur.length} 字符` };
}

/** 后台命令归谁：多人共用一台服务器时，别人不该看见、更不该停掉你的开发服务器 */
function bgOwner(opts) {
  const a = opts && opts.actor;
  return String((a && typeof a === "object" ? a.id || a.name : a) || "");
}

function startBackground(cmd, cwd, opts, keep = false) {
  ensureDirs();
  const r = CT.bgStart({
    command: cmd,
    cwd: cwd || ws(),
    owner: bgOwner(opts),
    // 归这一轮：这一轮收尾（releaseRun）时跟着收，keep 的留下
    session: String((opts && opts.sessionId) || ""),
    keep: !!keep,
    logDir: tmpDir(),
    spawnFn: () => {
      const sh = pickShell(cmd);
      return spawn(sh.bin, sh.args, {
        cwd: cwd || ws(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...winTextEnv(), PATH: shellPath(), OPENWORKBUDDY_HOME: DATA_DIR, ...depsGuardEnv(cwd, cmd, shellPath()) },
        ...sh.opts,
      });
    },
  });
  if (r.error) return { content: r.error, isError: true };
  trackBgGroup(r.job).catch(() => {});
  const life = r.job.keep
    ? "这一轮结束后也留着，用户不要了再 shell_kill 停掉。"
    : r.job.session ? "这一轮结束时会被收掉（要交给用户接着用，起的时候加 keep:true）。" : "";
  return {
    content: `已在后台起好 ${r.id}：${cmd.slice(0, 160)}\n用 shell_output {id:"${r.id}"} 看输出（起服务器的话等它打出监听端口再去访问），用完 shell_kill {id:"${r.id}"} 停掉。${life}`,
    isError: false,
  };
}

let bgExitHooked = false;
function hookBgExit() {
  if (bgExitHooked) return;
  bgExitHooked = true;
  // 进程退出时把后台那几条一起收掉：不然一个 npm run dev 会在我们走了之后一直占着端口
  // Windows 上 c.kill() 只杀得到 cmd 那一层，npm run dev 起的 node 会活下来接着占端口；exit 里不能等异步，用同步的 taskkill
  const reap = () => CT.bgKillAll((c) => reapBgJob(c));
  process.on("exit", reap);
}
/**
 * 退出时收一条后台命令（整棵进程树）。run / kill 测试里换成假的，看它在各家系统上调了什么
 * @param {{ pid: number }} c
 */
function reapBgJob(c, platform = process.platform, run = require("child_process").spawnSync, kill = (pid, sig) => process.kill(pid, sig)) {
  try {
    if (platform === "win32") run("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
    else kill(-c.pid, "SIGTERM");
  } catch {}
}
hookBgExit();

// ─────────────────────────────────────────────────────────────
// 普通 run_shell / run_node 里甩到后台的进程（& / nohup）
// ─────────────────────────────────────────────────────────────
/**
 * 2026-09-28 实测：模型为了看一眼网页，常在普通 run_shell 里写
 * `(python3 -m http.server 8731 >/dev/null 2>&1 &) && curl ...`、`nohup python3 -m http.server 8921 ... &`。
 * 外层 shell 一退工具就回了，http.server 还挂在原来的进程组里、父进程变成 1——
 * 停止、收尾、退出应用都收不到它，活过了两次应用重启；并发的对话撞端口，有一轮把别的项目的页面当成自己的验了好几步。
 *
 * 这里在命令跑完那一刻看一眼进程组还有没有人：有就记账（归哪一轮、每个成员的 pid + 启动时刻），
 * 这一轮收尾时整组送走。账本按进程落盘（data/run-strays/<pid>.json），应用崩了下次开机还认得回来。
 */
const strays = new Map(); // pgid → { pgid, session, command, at, members: [{ pid, lstart, command }] }
const PS_ARGS = ["-A", "-o", "pid=,pgid=,lstart=,command="];
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;
const PS_ENV = () => ({ ...process.env, LC_ALL: "C" }); // lstart 的星期、月份按英文出，格式才固定
let hostStart = "";   // 本进程自己的启动时刻：开机收账时拿它分辨「记账的那个进程还在不在」
let strayWrite = Promise.resolve();
const strayDir = () => dataPath("data", "run-strays");
const strayFile = () => path.join(strayDir(), `${process.pid}.json`);

/** ps 那几列拆成行；lstart 的空白压成一个，免得「Sep  8」和「Sep 8」对不上 */
function psRows(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(PS_ROW);
    if (m) rows.push({ pid: +m[1], pgid: +m[2], lstart: m[3].replace(/\s+/g, " "), command: m[4].slice(0, 300) });
  }
  return rows;
}

/** 异步列一次全机进程；ps 跑不了返回 null——认不出是谁就不杀 */
function psList() {
  return new Promise((resolve) => {
    // 不加 windowsHide：调它的几处（groupAlive / trackBgGroup / reapStrays）在 Windows 上都先 return 了
    require("child_process").execFile("ps", PS_ARGS, { env: PS_ENV(), maxBuffer: 16 * 1048576, timeout: 5000 }, (err, stdout) => resolve(err ? null : psRows(stdout)));
  });
}

function groupAlive(pgid) {
  if (process.platform === "win32" || !(pgid > 0)) return false;
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

/** 账本落盘：串起来写，后一次总是写最新的；空了就删文件 */
function saveStrays() {
  strayWrite = strayWrite.then(async () => {
    if (!strays.size) return fs.promises.rm(strayFile(), { force: true });
    await fs.promises.mkdir(strayDir(), { recursive: true });
    await fs.promises.writeFile(strayFile(), JSON.stringify({ host: { pid: process.pid, lstart: hostStart }, strays: [...strays.values()] }));
  }).catch(() => {});
  return strayWrite;
}

/**
 * 命令跑完时调用：进程组里还有人就记账，返回追加给模型的那句话（没人就是空串）。
 * 绝大多数命令组里早没人了，只花一次 kill(0) 系统调用，不多跑 ps。
 * quiet：用户按了停 / 超时，组已经在收了，只记账不多嘴。
 */
async function noteStray(pgid, command, session, { quiet = false, tip = "" } = {}) {
  if (!groupAlive(pgid)) return "";
  const rows = await psList();
  if (!rows) return quiet ? "" : `（后台还留着进程组 ${pgid}，没能登记，收尾时收不到它：用完自己停掉）`;
  const self = rows.find((r) => r.pid === process.pid);
  if (self) hostStart = self.lstart;
  const members = rows.filter((r) => r.pgid === pgid).map(({ pid, lstart, command: c }) => ({ pid, lstart, command: c }));
  if (!members.length) return "";
  const sid = String(session || "");
  strays.set(pgid, { pgid, session: sid, command: String(command || "").slice(0, 300), at: Date.now(), members });
  saveStrays();
  if (quiet) return "";
  const what = members.map((m) => m.command.slice(0, 60)).join("；");
  return `（后台还留着进程组 ${pgid}：${what}。${sid ? "这一轮结束会被收掉" : "应用退出时会被收掉"}；${tip}）`;
}

/**
 * 按账本认人：组里得有一个成员的 pid 和启动时刻都对得上，才算我们那组。
 * 只比 pid + 启动时刻、不比命令行：npm 起来会改自己的 process.title（ps 里从 node .../npm 变成 npm run dev），
 * 比命令行会把真是自己的那组认丢。pid 加秒级启动时刻已经唯一，重启、重开机之后 pid 撞号也认不错。
 */
function verifiedPgids(entries, rows) {
  const out = [];
  for (const e of entries) {
    const cur = rows.filter((r) => r.pgid === e.pgid);
    if (cur.some((r) => (e.members || []).some((m) => m.pid === r.pid && m.lstart === r.lstart))) out.push(e.pgid);
  }
  return out;
}

/** 整组送走：先 SIGTERM，2 秒后还在就 SIGKILL（同 killTree） */
function killGroup(pgid, grace = 2000) {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  const t = setTimeout(() => { try { process.kill(-pgid, "SIGKILL"); } catch {} }, grace);
  if (t.unref) t.unref();
}

/**
 * 后台命令（background:true）也记进这本账，session 记空串：reapStrays(某一轮) 永远认不到它，
 * 这一轮收不收它照旧由 bg 那边的 keep / releaseRun 说了算，这里只管「记账的进程没了以后谁来收」。
 *
 * 2026-09-29 复审：服务端挪进独立进程以后，这个进程会崩、会被系统直接杀（SIGKILL / 内存爆），
 * 这时 process.on("exit") 那两道收尾（hookBgExit、reapStraysAtExit）一道都不跑。后台命令是 detached 起的、
 * 自成一组，父进程一没就挂到 1 号底下：重启出来的服务进程不认得它（bg 表在内存里，跟着旧进程没了），
 * 用户退出应用时主进程扫的进程树里也没有它——一个 npm run dev 占着端口一直活到重开机。
 * 记了账，重启出来的进程（或者退回主进程跑的那一份、下次开的应用）开机收账时按 pid + 启动时刻认回来收掉。
 * 命令自己结束、被 shell_kill / 收尾停掉，就把账销掉，账本不越攒越长。
 */
async function trackBgGroup(job) {
  const child = job && job.child;
  const pgid = child && child.pid;
  if (process.platform === "win32" || !(pgid > 0)) return false;
  const drop = () => { if (strays.has(pgid) && strays.get(pgid).bg === job.id) { strays.delete(pgid); saveStrays(); } };
  child.once("close", drop);
  const rows = await psList();
  // ps 这一趟里命令可能已经跑完了（close 先到）：那就不记，不然记下一个已经不存在的组
  if (!rows || job.exit !== undefined || job.endedAt) return false;
  const self = rows.find((r) => r.pid === process.pid);
  if (self) hostStart = self.lstart;
  const members = rows.filter((r) => r.pgid === pgid).map(({ pid, lstart, command: c }) => ({ pid, lstart, command: c }));
  if (!members.length) return false;
  strays.set(pgid, { pgid, session: "", bg: job.id, command: String(job.command || "").slice(0, 300), at: Date.now(), members });
  saveStrays();
  return true;
}

/** 收某一轮的散户。session 为空不动。返回真送走的那几组 */
async function reapStrays(session) {
  const sid = String(session || "");
  const mine = sid ? [...strays.values()].filter((e) => e.session === sid) : [];
  if (!mine.length) return [];
  const rows = await psList();
  if (!rows) return []; // 认不出来就不杀；账留着，退出应用 / 下次开机再认
  const ok = verifiedPgids(mine, rows);
  for (const e of mine) strays.delete(e.pgid);
  for (const g of ok) killGroup(g);
  saveStrays();
  return mine.filter((e) => ok.includes(e.pgid));
}

/**
 * 开机收账：上次进程（崩了、被强退）留下的账本，记账进程确实已经不在了，才按账本认人再杀。
 * 记账进程还活着（同 pid、同启动时刻）的账不碰：那是另一个正在跑的实例（比如命令行版），它的账它自己收。
 */
async function reapLeftoverStrays() {
  if (process.platform === "win32") return [];
  let names = [];
  try { names = await fs.promises.readdir(strayDir()); } catch { return []; }
  const files = names.filter((n) => /^\d+\.json$/.test(n) && Number(n.split(".")[0]) !== process.pid);
  if (!files.length) return [];
  const rows = await psList();
  if (!rows) return [];
  const killed = [];
  for (const n of files) {
    const f = path.join(strayDir(), n);
    let rec = null;
    try { rec = JSON.parse(await fs.promises.readFile(f, "utf8")); } catch { continue; }
    const host = (rec && rec.host) || {};
    if (rows.some((r) => r.pid === host.pid && (!host.lstart || r.lstart === host.lstart))) continue;
    const entries = Array.isArray(rec && rec.strays) ? rec.strays : [];
    const ok = verifiedPgids(entries, rows);
    for (const g of ok) killGroup(g);
    killed.push(...entries.filter((e) => ok.includes(e.pgid)));
    await fs.promises.rm(f, { force: true }).catch(() => {});
  }
  return killed;
}

/** 退出时同步收一遍（exit 里不能等异步）。账本文件留着，下次开机再核一次，SIGTERM 没收干净的那次补上 */
function reapStraysAtExit() {
  if (!strays.size || process.platform === "win32") return;
  let rows = null;
  // 不加 windowsHide：Windows 上面一行就 return 了
  try { rows = psRows(require("child_process").execFileSync("ps", PS_ARGS, { env: PS_ENV(), encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1048576 })); } catch {}
  if (!rows) return;
  for (const g of verifiedPgids([...strays.values()], rows)) { try { process.kill(-g, "SIGTERM"); } catch {} }
}
process.on("exit", reapStraysAtExit);
{
  // 收到了就在日志里留一行：服务进程崩过一次、后台命令被这里收掉，事后查「我的开发服务器怎么停了」得有地方看
  const t = setTimeout(() => {
    reapLeftoverStrays().then((k) => {
      if (k.length) console.log(`[收尾] 上次没收干净的后台进程组 ${k.length} 个已收掉：${k.map((e) => String(e.command || "").slice(0, 60)).join("；")}`);
    }).catch(() => {});
  }, 2000);
  if (t.unref) t.unref();
}

/**
 * 一轮任务收尾：这一轮起的后台命令（没说 keep 的）、甩到后台的散户、开过的浏览器标签页，一起收。
 * 网页对话、IM、定时任务、命令行都走这里；sessionId 为空一律不动——空串不是「所有人」，
 * 一个没带会话的调用不能把别人的开发服务器全停了。
 * browser:false 给网页对话那条用：它在同一个 finally 里已经单独收过标签页了。
 */
async function releaseRun(sessionId, { browser = true } = {}) {
  const sid = String(sessionId || "");
  if (!sid) return { jobs: [], kept: [], strays: [] };
  const { killed, kept } = CT.bgReapSession(sid, (c) => killTree(c));
  if (browser) { try { await require("../platform/render/cdp").releaseOwner(sid); } catch {} }
  let gone = [];
  try { gone = await reapStrays(sid); } catch {}
  if (killed.length || gone.length || kept.length) {
    console.log(`[收尾] ${sid}：收掉后台命令 ${killed.length} 条、散落进程组 ${gone.length} 个` +
      (kept.length ? `；按 keep 留着 ${kept.map((j) => `${j.id}（${j.command.slice(0, 60)}）`).join("、")}` : ""));
  }
  return { jobs: killed.map((j) => j.id), kept: kept.map((j) => j.id), strays: gone.map((e) => e.pgid) };
}

/**
 * 同一个会话键可能有两轮同时在跑（webhook 那条的 session 缺省都是 webhook_default）：
 * 先跑完的那轮不能把还在跑的那轮的开发服务器收了。开跑时 hold 一下，最后一个放手的才真收尾。
 * 返回放手函数，重复调用只算一次。
 */
const runHolds = new Map(); // sessionId → 正在跑的轮数
function holdRun(sessionId, opt) {
  const sid = String(sessionId || "");
  if (!sid) return () => Promise.resolve(null);
  runHolds.set(sid, (runHolds.get(sid) || 0) + 1);
  let done = false;
  return () => {
    if (done) return Promise.resolve(null);
    done = true;
    const n = (runHolds.get(sid) || 1) - 1;
    if (n > 0) { runHolds.set(sid, n); return Promise.resolve(null); }
    runHolds.delete(sid);
    return releaseRun(sid, opt);
  };
}
/** IM / 定时任务 / webhook 这一轮是不是还在跑（cdp.js 据此不去收它的标签页） */
const runHeld = (sessionId) => runHolds.has(String(sessionId || ""));

/** 读 → 算 → 写一步到位。不用过审批的调用方和测试用这个 */
function editFile(file, label, input) {
  const plan = planEdit(readSource(file, label), label, input);
  if (!plan.noop) fs.writeFileSync(file, plan.out, "utf8");
  return plan.msg;
}

// ---- 自检里要起外部进程的那几样（.py/.sh、ESM 兜底）：一律异步、同时最多两个 ----
// 2026-09-28 实测：这里原来是 spawnSync，而桌面版里 server 跑在 Electron 主进程上，等于整个应用陪着等。
// JS 自检还是整只 Electron 二进制冷启动，中位 ~200ms、最慢 430ms；最近 60 段会话里改了 114 次 .js，
// 光这一项就让整个应用（所有对话的流、打字、拖窗口）一共冻住二十多秒，六个对话一起写代码时一格一格地卡。
// JS 现在进程内编译（跟 node --check 走的是同一个 V8 解析，报错格式一模一样），剩下的外部检查异步排队，
// 同时最多两个：六个对话同时写 .py，不能一口气叉出六个 python3。
const EXT_CHECK_MAX = 2;
const extCheck = { running: 0, queue: /** @type {Array<() => void>} */ ([]) };
/** @returns {Promise<{status:number|null, stderr:string}>} status=null：没跑成（没装、超时），不是语法错 */
function execCheck(cmd, args, opt = {}) {
  return new Promise((resolve) => {
    const go = () => {
      extCheck.running++;
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        extCheck.running--;
        const next = extCheck.queue.shift();
        if (next) next();
        resolve(r);
      };
      try {
        require("child_process").execFile(cmd, args, { encoding: "utf8", maxBuffer: 4 * 1048576, windowsHide: true, ...opt }, (e, _out, err) => {
          done({ status: e ? (typeof e.code === "number" ? e.code : null) : 0, stderr: String(err || "") });
        });
      } catch {
        done({ status: null, stderr: "" });
      }
    };
    if (extCheck.running < EXT_CHECK_MAX) go();
    else extCheck.queue.push(go);
  });
}
/** 进程内查 CommonJS 语法：只编译不执行。没错返回空串，有错返回跟 node --check 一样的那几行 */
function cjsSyntaxError(src, file) {
  try {
    require("vm").compileFunction(src, ["exports", "require", "module", "__filename", "__dirname"], { filename: file });
    return "";
  } catch (e) {
    if (!e || e.name !== "SyntaxError") return "";
    return String(e.stack || e.message || e);
  }
}
// 按 CJS 编译才会报、换成 ESM 就可能是好代码的那几种错（跟 Node 自己的 ESM 探测认的是同一批）。
// 2026-09-29 复审实测：原来只认「行首是 import/export」才按 ESM 再判，顶层 await、import.meta、
// 顶层 for await、await using、自己声明 require/__dirname 的 .js 全被报成「JS 语法没过」——
// 换成进程内编译之前走的 node --check 会自己探测 ESM，这几种都是放行的。
// 普通写错（少括号、多逗号）的报错里没有这些词，照样零进程当场报
const ESM_ONLY_ERR_RE = /Cannot use import statement|Unexpected token 'export'|Cannot use 'import\.meta'|await is only valid in async functions and the top level bodies of modules|Unexpected reserved word|Identifier '(?:module|exports|require|__filename|__dirname)' has already been declared/;

/**
 * 写完/改完立刻做一次自检。
 *
 * 「改完自检」写在提示词里是没用的——模型该忘还是忘，坏文件就这么交出去了。
 * 所以把它挪到工具里：写完当场查，坏了当场把错误和行号顶回去，它想装看不见都不行。
 * 只查便宜且确定的东西（语法、结构），不做风格评判。
 */
/**
 * 查 Shell 脚本语法用哪个程序。返回空串就是不查。
 *
 * Mac / Linux 照旧：.zsh 用 zsh，别的用 bash。
 * Windows 上 PATH 里的 bash 多半不是我们要的那个：System32\bash.exe 是 WSL 的入口，
 * 递给它的 C:\… 路径它打不开，只会回一句 No such file——以前这句被当成「脚本语法没过」报给模型，
 * 模型就去改一个本来没毛病的脚本。WindowsApps 里的则是商店的占位程序。
 * 所以只认 Git 自带的 bash；Git 默认只把 Git\cmd 放进 PATH，bash 在旁边的 Git\bin 里，顺着 git.exe 找过去。
 * 都没有就不查。.zsh 在 Windows 上没有能查的，也不查
 */
function shCheckBin(ext, platform = process.platform, envPath) {
  if (platform !== "win32") return ext === ".zsh" ? "zsh" : "bash";
  if (ext === ".zsh") return "";
  const dirs = String(envPath == null ? shellPath() : envPath).split(";").filter(Boolean);
  const skip = /[\\/](System32|SysWOW64|Sysnative|WindowsApps)([\\/]|$)/i;
  for (const d of dirs) {
    if (skip.test(d) || !/[\\/]git([\\/]|$)/i.test(d)) continue;
    const f = path.join(d, "bash.exe");
    if (fs.existsSync(f)) return f;
  }
  for (const d of dirs) {
    if (skip.test(d) || !fs.existsSync(path.join(d, "git.exe"))) continue;
    const f = path.join(d, "..", "bin", "bash.exe"); // Git\cmd\git.exe → Git\bin\bash.exe
    if (fs.existsSync(f)) return f;
  }
  return "";
}
/** Windows 上 bash 自己没跑起来的样子（路径打不开、程序起不来、WSL 的 /mnt/ 路径），不是脚本写错了 */
const SH_ENV_NOISE = /No such file|cannot execute|\/mnt\//i;

/**
 * 写完文件的自检。partial=true 表示这次是 append 续写，文件**按定义就还没写完**。
 *
 * 返回 `{ note, bad }`：note 是贴给模型看的话，只有 bad 才会变成 isError。
 * 拆成两路是因为「有话要说」和「这次调用失败了」根本不是一回事，而 isError 是有副作用的——
 * 它喂给 agent.js 的 errStreaks，连着 4 次就弹「write_file 已连续失败 4 次，已提醒换思路」，
 * 可每一次文件都写成功了，模型于是被推着去「修」一个不存在的问题。
 *
 * 这是真实数据里最吵的一类误报，而且是工具自己教出来的——工具描述就写着「长文档一节一节写」：
 * 本机 96 段会话里 write_file 报了 41 次失败，38 次文件其实写进去了；edit_file 报了 51 次，
 * 31 次改也确实改成了。带「开 N 个、闭 M 个」的失衡报告一共 144 条，其中 138 条是「开着还没闭」，
 * 而工作区最终落盘的 48 个 html 文件里**没有一个**真的缺 </html>——全是中途状态被当成了错。
 *
 * 所以判据改成：**闭合标签比开始标签还多**（怎么往下写都圆不回来）才算错；
 * 「开着还没闭」在文档明显还没收尾时只提一句，不占 isError。
 * @param {{ platform?: string, path?: string }} [sys] 按哪家系统、哪份 PATH 找检查器（默认本机；测试里传 win32 和假目录）
 */
async function selfCheck(file, rel, partial = false, sys = {}) {
  // note 照说，bad 才算失败
  const bad = (note) => ({ note, bad: true });
  const ok = (note = "") => ({ note, bad: false });
  const ext = path.extname(rel).toLowerCase();
  // 「代码没写完」跟「代码写错了」的报错长得不一样：前者一律是解析器读到文件末尾才发现不够。
  // 只在 append 续写时用它放行，整篇写完照样一个不漏地报。
  const looksUnfinished = (msg) =>
    /Unexpected end of (input|JSON input)|Unterminated (template literal|string)|unexpected EOF|incomplete input|was never closed|unterminated (string|triple-quoted)|expected an indented block|unexpected end of file|syntax error: unexpected end/i.test(String(msg || ""));
  let src = "";
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return ok();
  }
  if (ext === ".json") {
    try {
      JSON.parse(src);
    } catch (e) {
      if (partial && looksUnfinished(e.message)) return ok();
      return bad(`\n注意：JSON 语法没过：${e.message}。先修好再往下走。`);
    }
    return ok();
  }
  if ([".js", ".cjs", ".mjs"].includes(ext)) {
    // ELECTRON_RUN_AS_NODE 必须带上：桌面版里 execPath 是 Electron 二进制，不带的话每检查一个 .js
    // 就真的启动一个 Electron 实例去加载用户的文件——满屏弹 JavaScript error 弹窗，还把合法代码误判成语法错误
    const esmCheck = (f) => execCheck(require("../platform/electron-bridge").nodeExec(), ["--check", f], { timeout: 15000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    // .mjs 本来就按 ESM 解析（严格模式等规则跟 CJS 不同），直接交给 node --check
    let err = ext === ".mjs" ? "" : cjsSyntaxError(src, file);
    if (ext === ".mjs") {
      const r = await esmCheck(file);
      if (r.status !== 0 && r.status !== null) err = r.stderr;
    } else if (err && (/^\s*(import|export)\s/m.test(src) || (ext === ".js" && ESM_ONLY_ERR_RE.test(err)))) {
      // .js 里写 ESM（import/export、顶层 await、import.meta）在 CJS 下必然报错，但项目可能本来就是 type:module，
      // 没有 package.json 的 Node 也会自己探测成 ESM —— 换成 .mjs 再判一次，别误伤。.cjs 永远按 CJS，不走这条
      const alt = path.join(tmpDir(), `syntax-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
      try {
        await fs.promises.mkdir(tmpDir(), { recursive: true });
        await fs.promises.writeFile(alt, src);
        const r = await esmCheck(alt);
        // 按 ESM 过了就是好的；按 ESM 也报错就报 ESM 的那条（路径换回用户的文件）；没跑成就不下结论
        if (r.status === 0 || r.status === null) err = "";
        else if (r.stderr) err = r.stderr.split(alt).join(file);
      } catch {}
      fs.rmSync(alt, { force: true });
    }
    if (err) {
      const msg = String(err).split("\n").filter((l) => l && !/^\s*at /.test(l)).slice(0, 6).join("\n");
      if (partial && looksUnfinished(msg)) return ok();
      return bad(`\n注意：JS 语法没过：\n${msg}\n先修好再往下走（用 edit_file 改那一行，别整篇重写）。`);
    }
    return ok();
  }
  if (ext === ".py") {
    // 用 ast.parse 而不是 py_compile：后者会往 __pycache__ 写 .pyc 污染工作目录。
    // 本机没 python3 / spawn 失败一律跳过，环境问题不能报成语法错误
    try {
      const r = await execCheck(process.platform === "win32" ? "python" : "python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())", file], { timeout: 15000 });
      if (r.status === 1 && /SyntaxError|IndentationError|TabError/.test(String(r.stderr))) {
        const msg = String(r.stderr).split("\n").filter((l) => l && !/^Traceback|^\s*File "<string>"/.test(l)).slice(-4).join("\n");
        if (partial && looksUnfinished(msg)) return ok();
        return bad(`\n注意：Python 语法没过：\n${msg}\n先修好再往下走。`);
      }
    } catch {}
    return ok();
  }
  if ([".sh", ".bash", ".zsh"].includes(ext)) {
    try {
      const bin = shCheckBin(ext, sys.platform, sys.path);
      if (!bin) return ok();
      const r = await execCheck(bin, ["-n", file], { timeout: 10000 });
      if (r.status !== 0 && r.stderr) {
        // 这几句是 bash 自己没跑起来（WSL 那头打不开 Windows 路径之类），跟脚本写得对不对无关
        if ((sys.platform || process.platform) === "win32" && SH_ENV_NOISE.test(r.stderr)) return ok();
        if (partial && looksUnfinished(r.stderr)) return ok();
        return bad(`\n注意：Shell 脚本语法没过：\n${String(r.stderr).split("\n").filter(Boolean).slice(0, 4).join("\n")}\n先修好再往下走。`);
      }
    } catch {}
    return ok();
  }
  if (ext === ".md") {
    const fences = (src.match(/^```/gm) || []).length;
    // 续写到一半，围栏本来就可能只开了一半——下一节接着写就闭上了，别在这儿喊
    if (fences % 2 === 1 && !partial) return bad("\n注意：Markdown 里有 ``` 代码围栏没闭合（奇数个），界面会把后面的正文整块吞掉。补上收尾的 ```。");
    return ok();
  }
  if (ext === ".svg") {
    const orphan = orphanSvgStyleScopes(src);
    if (orphan.length) {
      return bad(
        `\n注意：这个 SVG 的样式作用域挂空了：<style> 里写了 ${orphan.slice(0, 4).map((n) => "#" + n).join("、")}，` +
          `<svg> 上却没有这个 id。样式一条都不生效，图会变成黑字、没底色、框线全丢。id 和选择器改成一致的。`
      );
    }
    // 独立的 .svg 文件同样没有外层页面给它变量，坏法和 HTML 一模一样
    const { missing } = undefinedCssVars(src, path.dirname(file));
    if (missing.length) {
      return bad(
        `\n注意：这个 SVG 用了没定义的 CSS 变量：${missing.slice(0, 6).map((n) => "--" + n).join("、")}。` +
          `独立文件没有外层页面给它变量，var(--没定义的) 会让颜色回落到黑色，图上很可能黑底黑字。` +
          `在 <svg> 里自己写一段 <style>:root{--x:…}</style>，或者直接把颜色写死。`
      );
    }
    return ok();
  }
  if (ext === ".html" || ext === ".htm") {
    const issues = auditHtml(src, path.dirname(file), { partial });
    const errs = issues.filter((x) => x.level === "错");
    if (errs.length) return bad(`\n注意：页面结构有问题：${errs.map((x) => x.msg).join("；")}。建议再跑一次 check_page 确认。`);
    // 「还没收尾」照说一句，但它不是失败：说了模型知道自己在写半截，不至于以为哪里坏了
    const wip = issues.filter((x) => x.level === "提");
    if (wip.length) return ok(`\n（${wip.map((x) => x.msg).join("；")}）`);
    return ok();
  }
  return ok();
}

/**
 * 查「用了但没定义」的 CSS 变量。
 *
 * 这是一条真出过事的坑：模型给回复正文里的内联 SVG 学会了用 var(--color-text-primary)
 * 这套语义变量（那是应用页面定义的，暗色模式会自动跟着变），然后把同一套写法带进了
 * 它自己写到磁盘的独立 HTML 文件里。那个文件根本没定义这些变量，于是
 * fill: var(--没定义的) 整条声明作废、回落到默认的黑色——底块黑的、字也是黑的，
 * 用户看到的就是一片黑。而且在应用内预览时是好的（变量从外层页面继承下来了），
 * 只有用浏览器打开才露馅，属于最难自己发现的那类。
 *
 * 判定很确定：var(--x) 没写兜底值、全文又找不到 --x: 的定义，就是错。
 * 带兜底值的 var(--x, #333) 不算问题——那正是该有的写法。
 */
function undefinedCssVars(src, baseDir) {
  let defsSrc = src;
  let remoteCss = false;
  // 变量也可能定义在外链样式表里。本地的读进来一起看；远程的读不到，降级成「警」
  for (const m of src.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
    const href = (m[0].match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    if (/^https?:/i.test(href)) { remoteCss = true; continue; }
    try { defsSrc += fs.readFileSync(path.join(baseDir, href.split("?")[0]), "utf8"); } catch { remoteCss = true; }
  }
  const defined = new Set([...defsSrc.matchAll(/--([A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));
  const missing = new Set();
  for (const m of src.matchAll(/var\(\s*--([A-Za-z0-9_-]+)\s*([,)])/g)) {
    if (m[2] === ",") continue; // 写了兜底值，坏不了
    if (!defined.has(m[1])) missing.add(m[1]);
  }
  return { missing: [...missing], remoteCss };
}

/**
 * 查内联 SVG 里「作用域挂空了」的 <style>。
 *
 * 又一条真出过事的坑：gen_diagram 出来的 mermaid SVG，样式全部写成
 * `#<svg 自己的 id> .node rect{...}` 这种作用域选择器。模型把图往 HTML 报告里贴的时候，
 * 常常顺手"重命名 id 防冲突"——只改了 <svg id="…">、没改 <style> 里的选择器（或者反过来）。
 * 于是整张图的样式一条都不生效，mermaid 回落到浏览器默认值：黑字、没底色、框线全丢，
 * 用户打开就是"黑底黑字、排版乱成一团"。mermaid 每次渲染的 id 本来就是随机的、不会撞，
 * 压根不需要改名——贴进去时一个字符都不该动。
 *
 * 判定同样是确定的：选择器里写了 #foo，同一段 <svg> 里又没有 id="foo"，这条规则就是死的。
 * 只看 { 前面的选择器部分，值里的 #f0e9dc 这种十六进制颜色不会被误当成 id。
 */
function orphanSvgStyleScopes(src) {
  const bad = new Set();
  for (const m of String(src || "").matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
    const svg = m[0];
    const styles = [...svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((x) => x[1]).join("\n");
    if (!styles.trim()) continue;
    const ids = new Set([...svg.matchAll(/\sid=["']([^"']+)["']/g)].map((x) => x[1]));
    const selectors = styles.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((b) => b.split("{")[0]).join(",");
    for (const x of selectors.matchAll(/#([A-Za-z_][\w-]*)/g)) if (!ids.has(x[1])) bad.add(x[1]);
  }
  return [...bad];
}

/** 网页静态体检。只报能确定的问题，不做审美评判 */
function auditHtml(src, baseDir, opts = {}) {
  // 「整篇写」也可能只是文档的前半截：开了 <html> 却还没 </html>，后面还要接着写。
  // 这时候「开着还没闭」是必然状态，不是错——真实数据里 write_file/edit_file 一共 27 次
  // 「写成功却报失败」都栽在这上面，而落盘的 48 个 html 没有一个真缺 </html>。
  const stillWriting = !!opts.partial || (/<html[\s>]/i.test(src) && !/<\/html>/i.test(src));
  const out = [];
  const add = (level, msg) => out.push({ level, msg });
  if (!/<!doctype\s+html/i.test(src)) add("警", "没有 <!DOCTYPE html>（浏览器会退到怪异模式，排版会走样）");
  if (!/<meta[^>]+name=["']viewport["']/i.test(src)) add("警", "没有 viewport meta，手机上会缩成一团");
  const title = (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (!title || !title.trim()) add("警", "<title> 是空的（浏览器标签页和分享卡片都靠它）");
  // 标签闭合：只查结构性标签，查全了误报比真问题还多。
  // 数之前先把 <script> 正文和注释挖掉：JS 里拼 HTML 的字符串（'<div class=…>'、"<script"）
  // 一样会被正则数进去，工作区里现有的两处「标签对不上」100% 都是这么来的（去掉后全平）。
  const structural = src
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script></script>")
    .replace(/<!--[\s\S]*?-->/g, "");
  const unclosed = [];
  for (const tag of ["html", "head", "body", "div", "section", "main", "header", "footer", "table", "ul", "ol", "script", "style"]) {
    const open = (structural.match(new RegExp(`<${tag}(\\s|>)`, "gi")) || []).length;
    const close = (structural.match(new RegExp(`</${tag}>`, "gi")) || []).length;
    if (open === close) continue;
    // 「闭的比开的还多」怎么往下写都圆不回来，写没写完都是错；
    // 「开着还没闭」只在文档已经收尾（有 </html>）时才是错，否则就是写到一半的正常样子
    if (close > open || !stillWriting) add("错", `<${tag}> 开 ${open} 个、闭 ${close} 个，对不上`);
    else unclosed.push(`<${tag}>（开 ${open} 闭 ${close}）`);
  }
  if (unclosed.length) add("提", `${unclosed.join("、")} 还开着没闭——这次落盘的像是文档前半截，接着往下写就行，最后记得收尾`);
  // 外链资源：断网/发给别人就打不开了，单文件页面这是硬伤
  const ext = [...src.matchAll(/(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  // 网络字体以前是放行的，现在不放行了。`<link rel=stylesheet>` 是挡渲染的：连不上时浏览器
  // 不会立刻放弃，要一直等到自己那个 5 秒超时才肯画第一屏——实测把样式表指向一台「包被默默
  // 丢掉」的主机（国央企内网防火墙的常见做法，不回 RST），首屏 5132ms；同一页不引外链 116ms。
  // 所以这从来不是「断网时字体变普通」，是白屏五秒，换来的只是一款西文标题字体
  const isFont = (u) => /^https?:\/\/(fonts\.googleapis|fonts\.gstatic)\./i.test(u);
  const fontLinks = ext.filter(isFont);
  const cdn = ext.filter((u) => !isFont(u));
  if (fontLinks.length) add("警", `引了网络字体（${fontLinks[0].slice(0, 60)}…），内网或断网打开时首屏要白等 5 秒才出字；改用系统里真装着的字体栈`);
  if (cdn.length) add("警", `引了 ${cdn.length} 个外部资源（${cdn[0].slice(0, 60)}…），断网或换台电脑就白屏；库和图片请内联或下载到本地`);
  // 本地引用的文件在不在
  const local = [...src.matchAll(/(?:src|href)=["'](?!https?:|data:|#|mailto:|javascript:)([^"']+)["']/gi)].map((m) => m[1]);
  for (const rel of local.slice(0, 40)) {
    const f = path.join(baseDir, rel.split("?")[0].split("#")[0]);
    if (!fs.existsSync(f)) add("错", `引用了不存在的本地文件：${rel}`);
  }
  const cssVar = undefinedCssVars(src, baseDir);
  if (cssVar.missing.length) {
    const names = cssVar.missing.slice(0, 6).map((n) => "--" + n).join("、");
    const more = cssVar.missing.length > 6 ? `（共 ${cssVar.missing.length} 个）` : "";
    add(
      cssVar.remoteCss ? "警" : "错",
      `用了没定义的 CSS 变量：${names}${more}。var(--没定义的) 会让整条声明作废、回落到默认色——` +
        `文字和底色双双变黑，页面上就是一片看不清。要么在本文件的 :root 里把它们定义出来，` +
        `要么直接写死颜色值，或者至少写兜底 var(--x, #333)`
    );
  }
  const orphan = orphanSvgStyleScopes(src);
  if (orphan.length) {
    add(
      "错",
      `内联 SVG 的样式作用域挂空了：<style> 里写了 ${orphan.slice(0, 4).map((n) => "#" + n).join("、")}，` +
        `同一段 <svg> 里却没有这个 id。整张图的样式一条都不会生效，会回落成黑字、没底色、框线全丢。` +
        `把图原样贴回来（gen_diagram 的 id 本来就是随机的，不会撞，不用改名）`
    );
  }
  const text = src.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 30 && !stillWriting) add("警", "去掉标签后几乎没有正文（可能是内容全靠 JS 生成，也可能就是个空壳）");
  return out;
}

// ---- agent 打开网页用的隐藏窗口（内存分区、静音、8 帧）：整段搬进了 web-window.js ----
// 2026-09-29 服务端能挪进独立服务进程了，那边开不了窗口，窗口改由主进程开；主进程不能
// require 整个 tools.js，所以开窗口的那几件事单拎成一个文件，两边共用同一份。
const {
  WEB_PARTITION, hiddenWeb, openHiddenWeb, isRuntimeNoise, readConsoleEvent, cleanConsoleText, probePage, readRendered,
} = require("../platform/render/web-window");

/** 验收网页：静态体检 + 真浏览器打开一遍（拿控制台报错） */
async function checkPage(file, rel) {
  const src = fs.readFileSync(file, "utf8");
  const issues = auditHtml(src, path.dirname(file));
  const lines = [`【静态体检】${rel}（${Buffer.byteLength(src)} 字节）`];
  lines.push(issues.length ? issues.map((x) => `- [${x.level}] ${x.msg}`).join("\n") : "- 没发现结构问题");

  // 服务端在独立服务进程里（2026-09-29 起桌面版默认）：窗口由主进程开，这边只收结果
  const bridge = require("../platform/electron-bridge");
  const remote = bridge.isRemote();
  let electron = null;
  if (!remote) try {
    electron = require("electron");
  } catch {}
  if (remote ? !bridge.caps().windows : (!electron || !electron.BrowserWindow || !electron.app || !electron.app.isReady())) {
    lines.push("\n【浏览器实测】跳过（当前是命令行模式，没有内置浏览器）。交付前请在桌面版里再跑一次。");
    return lines.join("\n");
  }
  try {
    const { info, errs, warns } = remote
      ? await bridge.call("page.check", { file }, { timeoutMs: 20000 })
      : await probePage(electron, file);
    lines.push(`\n【浏览器实测】标题「${info.t}」· 可见正文 ${info.n} 字 · 页面高 ${info.h}px`);
    if (info.n < 20) lines.push("- [错] 打开后几乎没有可见内容（白屏）。多半是 JS 报错或 CSS 把内容藏了。");
    if (errs.length) lines.push(`- [错] 控制台报错 ${errs.length} 条：\n  ${errs.slice(0, 5).join("\n  ")}`);
    if (warns.length) lines.push(`- [警] 控制台警告 ${warns.length} 条（不一定要改，白屏无关）：\n  ${warns.slice(0, 3).join("\n  ")}`);
    if (!errs.length && !warns.length) lines.push("- 控制台没有报错");
  } catch (e) {
    lines.push(`\n【浏览器实测】打开失败：${e.message}`);
  }
  return lines.join("\n");
}

const SEARCH_SKIP = new Set([
  ".tmp", "node_modules", ".git", "dist", "build", ".next", "__pycache__", "venv", ".venv", ".cache",
  // 都是工具自己生成的目录，搜它们只会把预算烧在别人的构建产物上。
  // 只加点开头的（用户自己不会这么命名）和两个业界唯一叫法，"vendor"/"target"/"out" 这类
  // 有歧义的一律不加——搜不到用户自己的文件比多扫几百个文件糟得多
  ".turbo", ".svelte-kit", ".nuxt", ".output", ".parcel-cache", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", ".gradle", ".terraform", ".yarn", ".pnpm-store", ".ipynb_checkpoints", ".history",
  "site-packages", "Pods",
]);

// 按扩展名先挡掉二进制。以前是读进内存再看有没有 0 字节——等于把每个视频、每张图
// 整份搬进内存只为了立刻扔掉
const SEARCH_BIN_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "avif", "heic",
  "mp4", "mov", "avi", "mkv", "webm", "flv", "mp3", "wav", "m4a", "flac", "aac", "ogg", "opus",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "dmg", "pkg", "iso",
  "woff", "woff2", "ttf", "otf", "eot", "exe", "dll", "dylib", "so", "a", "o", "class", "jar",
  "wasm", "psd", "ai", "sketch", "db", "sqlite", "sqlite3", "pyc", "node", "pack", "idx", "bin",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "numbers", "pages",
]);

// 一次搜索的预算：文件数 / 读盘字节 / 墙上时间，哪条先到就停。
// 预算取得比正常项目宽得多：本仓库根目录（1.3 万文件）全量搜完也就 2 秒出头，还在预算内。
// 不敢收紧是因为「没搜完」对「改名前找全部引用」这类活是硬伤——先靠让出事件循环解决卡顿，
// 预算只当兜底，防的是树大到不正常（依赖没跳干净、整盘当工作目录）
// 写成对象是为了让测试能把它调小：真造一棵能撑爆 2 万文件的树，跑一次测试就得几十秒
const SEARCH_BUDGET = { files: 20000, bytes: 192 * 1024 * 1024, ms: 3000 };
// 每读这么多就让出一次事件循环，让攒着的 SSE 先发出去。
// 走目录也要算：带 ext 过滤时绝大多数条目压根不读，光 readdir+判类型也能连着跑上万条
// （实测 ext="js" 那趟因为不计条目，事件循环还是被钉了 36ms）
const SEARCH_YIELD_FILES = 16;
const SEARCH_YIELD_BYTES = 1024 * 1024;
const SEARCH_YIELD_ENTRIES = 800;

/**
 * 全文搜索：找定义、找调用点、改名前找全部引用。跳过二进制和依赖目录。
 *
 * 为什么要有预算、还要中途让出事件循环：这个工具是同步读盘的，一次没命中的搜索会把整棵树
 * 从头读一遍。实测在本仓库根目录搜一个不存在的词：readFileSync **13552 次、196MB、
 * 事件循环整整钉住 2.53 秒**——那 2.53 秒里 SSE 一个字都发不出去，用户看到的就是回答说到
 * 一半突然定住。
 *
 * 三件事：① 按扩展名先挡掉二进制，别把视频图片整份搬进内存只为了扔掉；
 * ② 文件数/字节/时间三道预算，哪条先到就停；③ 每读一批就 setImmediate 让一次，
 * 攒着的 SSE 立刻能发出去——同一趟搜索总时长不见得变短，但界面不再定住。
 *
 * 停下来必须说实话：没扫完就写「没扫完」，绝不能报「没搜到」。报「没搜到」是在骗模型，
 * 它会据此断定这个符号不存在，然后把后面的活全建在这个错判上。
 */
async function searchFiles(root, { query, regex, ext, max, only, relBase, ignore_case }) {
  const limit = Math.min(Math.max(Number(max) || 60, 1), 300);
  const q = String(query || "");
  if (!q) throw new Error("query 是空的");
  // 大小写照 ripgrep 的 smart-case：query 里有大写就按大小写严格搜，全小写不分。
  // 以前一律不分：找 `^[A-Z_]+ =` 这种常量定义，max_retry、user_name 全混进来；改名前找 Foo 的调用点，foo 也算上
  const letters = regex ? q.replace(/\\./g, "") : q; // \S、\W 这种转义里的大写字母不算
  const caseless = ignore_case === true || (ignore_case !== false && !/\p{Lu}/u.test(letters));
  let re;
  try {
    re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseless ? "i" : "");
  } catch (e) {
    throw new Error(`正则不合法：${e.message}`);
  }
  // 结果里的路径跟 read_file 同一个起点（relBase = 工作目录）。以前从搜索目录起算：
  // dir 给 proj/src，回来的是 util/index.js，模型照着 read_file 就读到根下另一个同名文件，或者一句 ENOENT。
  // 跳出这个起点的（白名单里的外部目录）给绝对路径，照样能直接拿去读
  const relOf = (full) => {
    const r = path.relative(relBase || root, full);
    return (r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r) ? full : r).split(path.sep).join("/");
  };
  const exts = String(ext || "")
    .split(",")
    .map((x) => x.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  const hits = [];
  const skippedBig = []; // 顺着目录搜时跳过的大文件：报「没搜到」的时候它可能正好就在里面，得说出来
  let scanned = 0,
    bytes = 0,
    truncated = false, // 命中够数了（这是好事）
    overBudget = ""; // 预算烧完了，树还没走完（这个必须告诉模型）
  const deadline = Date.now() + SEARCH_BUDGET.ms;
  const hit = (rel, no, line) => {
    hits.push(`${rel}:${no}: ${line.trim().slice(0, 200)}`);
    if (hits.length >= limit) truncated = true;
  };
  // 点名要搜的大文件（2.5MB 的 app.log 这种）：跟 readBigFile 一个路数分块流着搜，不整份读进内存
  const grepBig = async (full, rel) => {
    const { StringDecoder } = require("string_decoder");
    let fh;
    try { fh = await fs.promises.open(full, "r"); } catch { return; }
    const dec = new StringDecoder("utf8");
    const buf = Buffer.alloc(READ_CHUNK);
    let carry = "", lineNo = 0, pos = 0;
    try {
      while (!truncated) {
        if (bytes >= SEARCH_BUDGET.bytes) { overBudget = `读到 ${(SEARCH_BUDGET.bytes / 1048576).toFixed(1)}MB 的上限`; return; }
        if (Date.now() > deadline) { overBudget = `搜了 ${(SEARCH_BUDGET.ms / 1000).toFixed(1)} 秒还没走完`; return; }
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        bytes += bytesRead;
        carry += dec.write(buf.subarray(0, bytesRead));
        const parts = carry.split("\n");
        carry = parts.pop();
        for (const ln of parts) {
          lineNo++;
          if (re.test(ln)) hit(rel, lineNo, ln);
          if (truncated) return;
        }
      }
      carry += dec.end();
      if (!truncated && re.test(carry)) hit(rel, lineNo + 1, carry);
    } finally {
      await fh.close();
    }
  };
  let sinceYieldFiles = 0,
    sinceYieldBytes = 0,
    sinceYieldEntries = 0;
  const breathe = async () => {
    // setImmediate 排在 I/O 回调之后跑：让出这一下，攒着的 socket 写才真的出得去
    sinceYieldFiles = 0;
    sinceYieldBytes = 0;
    sinceYieldEntries = 0;
    await new Promise((r) => setImmediate(r));
  };
  await (async function walk(dir) {
    if (truncated || overBudget) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated || overBudget) return;
      if (++sinceYieldEntries >= SEARCH_YIELD_ENTRIES) await breathe();
      if (SEARCH_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (only && full !== only) continue;
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const fext = path.extname(e.name).slice(1).toLowerCase();
      if (exts.length) {
        if (!exts.includes(fext)) continue;
      } else if (SEARCH_BIN_EXT.has(fext)) continue; // 用户明确点名要搜的扩展名不挡
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const rel = relOf(full);
      // 大文件多半是产物/数据，不是要找的代码，顺着目录搜时跳过——但要记下来，不然它明明在里面也报「没搜到」
      if (st.size > 2 * 1024 * 1024 && !only) { skippedBig.push(`${rel}（${(st.size / 1048576).toFixed(1)}MB）`); continue; }
      if (scanned >= SEARCH_BUDGET.files) { overBudget = `扫到 ${SEARCH_BUDGET.files} 个文件的上限`; return; }
      if (bytes >= SEARCH_BUDGET.bytes) { overBudget = `读到 ${(SEARCH_BUDGET.bytes / 1048576).toFixed(1)}MB 的上限`; return; }
      if (Date.now() > deadline) { overBudget = `搜了 ${(SEARCH_BUDGET.ms / 1000).toFixed(1)} 秒还没走完`; return; }
      if (st.size > 2 * 1024 * 1024) {
        if (fileHasNul(full)) continue;
        scanned++;
        await grepBig(full, rel);
        continue;
      }
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }
      bytes += buf.length;
      sinceYieldBytes += buf.length;
      if (buf.includes(0)) continue; // 没扩展名/扩展名骗人的二进制，还是得兜住
      scanned++;
      sinceYieldFiles++;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        hit(rel, i + 1, lines[i]);
        if (truncated) return;
      }
      if (sinceYieldFiles >= SEARCH_YIELD_FILES || sinceYieldBytes >= SEARCH_YIELD_BYTES) await breathe();
    }
  })(root);
  const scale = `扫了 ${scanned} 个文本文件、${(bytes / 1048576).toFixed(1)}MB`;
  // 没扫完的实话 + 下一步怎么办：光说「没扫完」模型只会原样再搜一遍
  const narrow = `——用 dir 指到具体子目录，或用 ext 限类型（比如 ext="js,ts"）再搜一遍`;
  const big = skippedBig.length
    ? `；另有 ${skippedBig.length} 个超过 2MB 的文件没搜：${skippedBig.slice(0, 5).join("、")}${skippedBig.length > 5 ? " 等" : ""}——要搜就把 dir 指到那个文件`
    : "";
  if (!hits.length) {
    return overBudget
      ? `（没搜完就停了：${overBudget}，${scale}，还没搜到「${q}」。这**不代表没有**${narrow}${big}）`
      : `（没搜到「${q}」，${scale}${caseless ? "" : "，区分了大小写，不分就传 ignore_case:true"}${big}）`;
  }
  return (
    hits.join("\n") +
    (truncated
      ? `\n（到 ${limit} 条上限了，后面还有没列出来的——把关键词写细，或用 dir/ext 缩范围）`
      : overBudget
        ? `\n（共 ${hits.length} 条，但没搜完就停了：${overBudget}，${scale}${narrow}${big}）`
        : `\n（共 ${hits.length} 条，${scale}${big}）`)
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

// 渲染每轮等多久。夹在 0.5~8 秒之间：给 0 会变成忙等把 CPU 占满，给 60000 会让一次抓取
// 挂着不回话，模型那头只看得到"这一步很久没动静"，分不清是慢还是死了
const clampWait = (ms) => Math.min(Math.max(Number(ms) || 2500, 500), 8000);

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
      fs.writeFileSync(path.join(dir || ws(), name), data, { flag: "wx" });
      return name;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const name = `${stem}_${Date.now()}${ext}`;
  fs.writeFileSync(path.join(dir || ws(), name), data);
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

/**
 * @param {string} url
 * @param {{render?: "auto"|"force"|"off"|boolean, waitMs?: number, saveDir?: string}} [opts]
 *   render 收 "auto"/"force"/"off"；老调用方传的 true/false 也认（false = off）。
 */
async function fetchUrl(url, { render, saveDir, waitMs } = {}) {
  // 归一化放在这儿而不是 executeTool 里：内部调用方（测试、以后可能的别的入口）也得到同一套语义
  const mode = render === false || render === "off" ? "off" : render === "force" ? "force" : "auto";
  let resp;
  try {
    resp = await fetch(url, { redirect: "follow", headers: browserHeaders(url), signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`抓取失败：${e.name === "TimeoutError" ? "30 秒还没响应（站点太慢或需要代理）" : e.message}`);
  }
  const ct = resp.headers.get("content-type") || "";
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared > 30 * 1024 * 1024) {
    return `注意：这个地址是个 ${(declared / 1048576).toFixed(1)} MB 的大文件（${ct || "类型未知"}），没有下载，它也不是网页正文。真需要的话用 run_shell 跑 \`curl -L -o 文件名 "${url}"\` 存下来再处理。`;
  }
  const buf = await resp.arrayBuffer();
  if (looksBinary(ct, buf)) {
    const name = saveDownload(url, ct, buf, saveDir);
    const kind = /pdf/i.test(ct) || Buffer.from(buf.slice(0, 4)).toString("latin1") === "%PDF" ? "pdf" : "";
    return (
      `这不是网页，是二进制文件（${ct || "类型未知"}，${buf.byteLength} 字节），已下载到工作目录：${name}\n` +
      (kind === "pdf"
        ? pdfHowTo(name)
        : DOC_EXT.test(name)
          ? `Office 文档和压缩包用 read_document 读（会拍平成纯文本），别按文本 read_file。`
          : `按类型处理：图片用 look_at_image，音视频直接当素材用。`) +
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

  // 空壳/被拦：能渲染就渲染一遍，渲染不了也要把原因说清楚，别让模型以为"这个网站读不到"就此收手。
  // force 是模型明说了"这页的正文得靠 JS"，那就不再看像不像空壳，直接渲染。
  const forced = mode === "force";
  if (forced || (mode !== "off" && looksEmptyPage(text, resp.status))) {
    const rendered = await renderPage(url, waitMs ? { waitMs: clampWait(waitMs) } : {}).catch((e) => ({ error: e.message }));
    // auto 那档要比长短：渲染没渲出东西时，原样返回静态正文比返回一段更短的壳有用。
    // force 不比——模型要的就是渲染后的那一份，哪怕它比静态 HTML 短（静态里那些长度
    // 往往正是导航和推荐位，恰恰是它想绕开的东西）
    if (rendered && rendered.text && (forced || rendered.text.length > text.length)) {
      const how = forced ? "已用内置浏览器渲染后读取" : "静态 HTML 是空壳，已用内置浏览器渲染后读取";
      return `HTTP ${resp.status}${rendered.title || title ? ` · ${rendered.title || title}` : ""}（${how}）\n${rendered.text.slice(0, 20000)}`;
    }
    // force 撞上"这台机器没有内置浏览器"（纯命令行 / 服务端模式）：静态正文其实是有的，
    // 这时候报"没能拿到正文"就是撒谎，把手上这份给它，同时讲清少了哪块
    if (forced && rendered && rendered.error && !looksEmptyPage(text, resp.status)) {
      return `${head}（要的是浏览器渲染，但没渲染成：${rendered.error}。下面是静态 HTML 里能读到的部分，动态加载的那块不在里面）\n${text.slice(0, 20000)}`;
    }
    const why =
      rendered && !rendered.error && !rendered.text
        ? "内置浏览器打开了，但页面正文是空的——多半是要登录，或者内容在 iframe / canvas 里"
        : resp.status === 412 || resp.status === 403
          ? `对方站点把这次请求判成了爬虫（HTTP ${resp.status}）`
          : resp.status >= 400
            ? `对方站点返回 HTTP ${resp.status}`
            : "这个页面的正文是 JavaScript 动态渲染的，静态 HTML 里没有内容";
    return (
      `没能拿到正文：${why}。${rendered && rendered.error ? `（渲染兜底也失败：${rendered.error}）` : ""}\n` +
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
  // 服务端在独立服务进程里：窗口归主进程开，超时按「最长等多久 + 开窗/关窗余量」算
  const bridge = require("../platform/electron-bridge");
  if (bridge.isRemote()) {
    return bridge.call("page.render", { url, waitMs, maxWaitMs, ua: BROWSER_UA }, { timeoutMs: maxWaitMs + waitMs + 30000 });
  }
  let electron;
  try {
    electron = require("electron");
  } catch {
    throw new Error("当前不在桌面应用里跑，没有内置浏览器可用");
  }
  if (!electron || !electron.BrowserWindow || !electron.app || !electron.app.isReady()) {
    throw new Error("内置浏览器不可用（命令行模式）");
  }
  return readRendered(electron, url, { waitMs, maxWaitMs, ua: BROWSER_UA });
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x?\w+;/g, " ").replace(/\s{2,}/g, " ").trim();
}

// ---- 多 provider 搜索（八家 + 自定义），统一返回 [{title,url,desc}] ----

/**
 * HTTP 状态码翻成人话。
 *
 * 光甩一个「搜索失败（402）」出去，屏幕前的人得自己去查 402 是什么意思——
 * 而这几个码对应的动作完全不同：401 是去换一把 Key，402 是去充值，429 是等一会儿。
 * 不确定的码不硬编一个原因（乱猜的归因比没有归因还贵），直接把对方回的原文带出来。
 */
const SEARCH_HTTP_HINT = {
  400: "请求被对方拒了，多半是参数对不上",
  401: "Key 不对，或者还没生效",
  402: "这把 Key 的额度/余额用完了，去它的控制台充一下",
  403: "这把 Key 没开通这个接口的权限",
  404: "接口地址不对（对方说没这个路径）",
  429: "被限流了，缓一会儿再试",
};
async function searchHttpError(name, resp) {
  const body = await resp.text().catch(() => "");
  const hint = SEARCH_HTTP_HINT[resp.status];
  // 对方原文放在后面而不是替换掉提示：提示是给人看的，原文是给排查用的，两个都不能少
  return new Error(
    `${name} 搜索失败（${resp.status}${hint ? "：" + hint : ""}）` + (body ? "｜对方原话：" + body.trim().slice(0, 160) : "")
  );
}

/**
 * HTTP 200 不等于搜到了。
 *
 * 国内这几家（博查/智谱/七牛）出错时照样回 200，把错情写在 body 的 code/msg 里。
 * 不认这一层的话，界面上只会显示「返回 0 条结果」——一个 Key 填错的人会以为是没搜到，
 * 去换关键词，换到天亮也还是 0 条。
 */
function searchBodyError(j) {
  if (!j || typeof j !== "object") return "";
  const err = j.error;
  if (err && typeof err === "object" && (err.message || err.msg)) return String(err.message || err.msg);
  if (typeof err === "string" && err) return err;
  // code：0 / 200 / "0" / "200" 都算成功；别家用别的成功值时，有结果就不会走到这儿。
  // 三个名字都得认：博查/智谱用 code，七牛用 status_code，Serper 用 statusCode——
  // 少认一个，那家 Key 填错时就会一路走到「返回 0 条结果」，人以为是没搜到
  const code = j.code !== undefined ? j.code : (j.status_code !== undefined ? j.status_code : j.statusCode);
  const ok = code === undefined || code === null || code === 0 || code === 200 || code === "0" || code === "200";
  const msg = j.msg || j.message || j.error_msg || "";
  if (!ok) return (msg ? String(msg) : "对方返回 code=" + code);
  if (j.success === false) return String(msg || "对方说这次请求没成功");
  return "";
}

async function jinaSearch(key, query, n) {
  const resp = await fetch("https://s.jina.ai/?q=" + encodeURIComponent(query), {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "X-Respond-With": "no-content" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw await searchHttpError("Jina", resp);
  const j = await resp.json();
  const bad = searchBodyError(j);
  if (bad) throw new Error("Jina 搜索失败：" + bad.slice(0, 160));
  const data = j.data || [];
  return data.slice(0, n).map((r) => ({ title: r.title, url: r.url, desc: r.description || "" }));
}

async function tavilySearch(key, query, n) {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: n, include_answer: false, search_depth: "basic" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw await searchHttpError("Tavily", resp);
  const data = (await resp.json()).results || [];
  return data.slice(0, n).map((r) => ({ title: r.title, url: r.url, desc: r.content || "" }));
}

async function braveSearch(key, query, n) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}&text_decorations=false`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw await searchHttpError("Brave", resp);
  const data = ((await resp.json()).web || {}).results || [];
  return data.slice(0, n).map((r) => ({ title: r.title, url: r.url, desc: r.description || "" }));
}

// ---- 国内直连的几家（博查 / 智谱 / 七牛云）+ Serper ----
// 这几家的返回各写各的字段名，但形状是同一个：一个数组，每项有标题、链接、摘要。
// 所以统一走 pickHits 去「认」，不照某一家的文档把路径写死——写死的那版在对方多包一层之后
// 会安安静静地返回空，界面上表现成「没搜到」，查起来要人命。
const HIT_PATHS = [
  (j) => j && j.data && j.data.webPages && j.data.webPages.value, // 博查（对齐 Bing 的形状）
  (j) => j && j.search_result,                                    // 智谱 web_search
  (j) => j && j.data && j.data.results,
  (j) => j && j.results,
  (j) => j && j.organic,                                          // Serper
  (j) => j && Array.isArray(j.data) ? j.data : null,
  (j) => Array.isArray(j) ? j : null,
];
const pickHits = (j) => {
  for (const f of HIT_PATHS) { let a; try { a = f(j); } catch { a = null; } if (Array.isArray(a) && a.length) return a; }
  return [];
};
const toItems = (j, n) => pickHits(j).slice(0, n).map((r) => ({
  title: r.title || r.name || r.heading || "",
  url: r.url || r.link || r.href || "",
  desc: r.summary || r.snippet || r.description || r.content || r.desc || r.abstract || "",
})).filter((r) => r.url);

async function postSearch(name, url, headers, body, ms) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms || 15000),
  });
  if (!resp.ok) throw await searchHttpError(name, resp);
  const text = await resp.text();
  let j;
  // 200 却不是 JSON——最常见的是地址填成了网页版首页，或者中间挡了一层登录页。
  // 让它在这儿炸出原文，比往下走一步变成「0 条结果」强
  try { j = JSON.parse(text); } catch { throw new Error(`${name} 返回的不是 JSON（接口地址填对了吗）｜前 120 字：${text.trim().slice(0, 120)}`); }
  const bad = searchBodyError(j);
  if (bad) throw new Error(`${name} 搜索失败：${bad.slice(0, 160)}`);
  return j;
}

async function bochaSearch(key, query, n) {
  return toItems(await postSearch("博查", "https://api.bochaai.com/v1/web-search",
    { Authorization: `Bearer ${key}` }, { query, count: n, summary: true }), n);
}

async function zhipuSearch(key, query, n) {
  return toItems(await postSearch("智谱", "https://open.bigmodel.cn/api/paas/v4/web_search",
    { Authorization: `Bearer ${key}` }, { search_engine: "search_std", search_query: query, count: n }), n);
}

/**
 * 七牛云「全网搜索」。
 *
 * 两处跟别家不一样，都踩过：
 *   ① 条数字段叫 max_results，不叫 count。名字对不上的时候对方不会报错，
 *      它按自己的默认条数回——要 3 条回 10 条，看着像「能用」，实际参数一直没生效。
 *   ② 域名在迁。老的推理域名 openai.qiniu.com 和新的 api.qnaigc.com 都在用，
 *      手头没有这家的 Key，没法实测哪个还活着，所以两个都试：第一个不通就换第二个。
 *      这不是猜——两个地址都写在他们自己的文档里；不通的那次会把对方原话带出来。
 */
async function qiniuSearch(key, query, n) {
  const hosts = ["https://api.qnaigc.com/v1/search/web", "https://openai.qiniu.com/v1/search/web"];
  let last;
  for (const url of hosts) {
    try {
      return toItems(await postSearch("七牛云", url,
        { Authorization: `Bearer ${key}` }, { query, max_results: n, search_type: "web" }), n);
    } catch (e) {
      last = e;
      // 只有「这个地址不对」才换下一个。Key 错、限流、余额没了换个域名也是同样的结果，
      // 换了只会让人等两倍的时间，还把真正的原因换成了第二个域名的原因
      if (!/（404|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|不是 JSON/.test(String(e.message || e))) throw e;
    }
  }
  throw last;
}

async function serperSearch(key, query, n) {
  return toItems(await postSearch("Serper", "https://google.serper.dev/search",
    { "X-API-KEY": key }, { q: query, num: n }), n);
}

// 自定义：上面没列到的那些（阿里云 IQS、秘塔、火山、自建 SearXNG…）不用等我加代码。
// 只要对方是「POST 一个 JSON、回一个结果数组」，在设置里填个地址就能接上，
// 字段名交给上面那套去认。请求体里问题字段叫什么也能改（默认 query）。
async function customSearch(key, query, n, cfg) {
  const c = cfg || {};
  const url = c.custom_url || process.env.SEARCH_CUSTOM_URL || "";
  if (!url) throw new Error("自定义搜索还没填接口地址");
  const field = c.custom_query_field || process.env.SEARCH_CUSTOM_FIELD || "query";
  return toItems(await postSearch("自定义", url,
    key ? { Authorization: `Bearer ${key}` } : {}, { [field]: query, count: n }), n);
}

// 顺序就是接力顺序：配置里没指定首选时，从上往下找第一个配好了的。
// 国内几家排在前面——这是个中文产品，默认那一跳应该是在国内能连上的那家。
const SEARCH_PROVIDERS = {
  bocha: bochaSearch, zhipu: zhipuSearch, qiniu: qiniuSearch,
  tavily: tavilySearch, serper: serperSearch, jina: jinaSearch, brave: braveSearch,
  custom: customSearch,
};

function searchProviderKey(cfg, provider) {
  // 每个 provider 独立 key；jina 兼容旧字段 api_key / 环境变量
  if (provider === "jina") return cfg.jina_key || cfg.api_key || process.env.JINA_API_KEY || "";
  if (provider === "tavily") return cfg.tavily_key || process.env.TAVILY_API_KEY || "";
  if (provider === "brave") return cfg.brave_key || process.env.BRAVE_API_KEY || "";
  if (provider === "bocha") return cfg.bocha_key || process.env.BOCHA_API_KEY || "";
  if (provider === "zhipu") return cfg.zhipu_key || process.env.ZHIPU_API_KEY || "";
  if (provider === "qiniu") return cfg.qiniu_key || process.env.QINIU_API_KEY || "";
  if (provider === "serper") return cfg.serper_key || process.env.SERPER_API_KEY || "";
  if (provider === "custom") return cfg.custom_key || process.env.SEARCH_CUSTOM_KEY || "";
  return "";
}

// 「这家配好了没」跟「有没有 key」不是一回事：自定义那家认的是地址，
// 有些自建接口本来就不要鉴权。只看 key 的话，填了地址的自定义会被整条跳过
function searchProviderReady(cfg, provider, key) {
  if (provider === "custom") return !!((cfg || {}).custom_url || process.env.SEARCH_CUSTOM_URL);
  return !!key;
}

async function webSearch(query, count, searchCfg, hold) {
  const n = Math.min(Math.max(+count || 5, 1), 10);
  const cfg = searchCfg || {};
  const provider = (cfg.provider || "").toLowerCase();

  // 多引擎接力：配置的 provider 打头，其余有 key 的引擎依次顶上（谁被限流换下一个），
  // 全军覆没才退 DuckDuckGo 免费档；每一步的失败原因都记下来带给 agent
  const chain = [provider, ...Object.keys(SEARCH_PROVIDERS).filter((p) => p !== provider)];
  const errors = [];
  // 下面三条兜底路径（DuckDuckGo / 百度 / 全军覆没）一分钱不花，
  // 要把刚才那笔预扣退回去。记一个标志而不是在每条 return 前各写一句：
  // 那样漏一条就是一笔常被占着的预算，而漏哪一条只有网络坏成那样的时候才看得出来。
  let settled = false;
  const refund = () => { if (!settled) { settled = true; quota.undo(hold); } };
  for (const p of chain) {
    const fn = SEARCH_PROVIDERS[p];
    const key = searchProviderKey(cfg, p);
    if (!fn || !searchProviderReady(cfg, p, key)) continue;
    try {
      const items = await fn(key, query, n, cfg);
      if (items.length) {
        // 只有付费引擎真回了结果才记账。下面 DuckDuckGo / 百度那两条兜底不花钱，
        // 记进去会让管理员对着一个虚高的数字去砍额度。
        // 注意这儿记的是 **p**，不是配置里那个首选：首选被限流时是接力的那家在收钱。
        quota.record("search", { provider: p, units: 1, meta: String(query).slice(0, 80), hold });
        settled = true;
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
    // 8 秒不是 30 秒：这条在国内网络下通常是直接连不上，而它后面还排着百度那条真能用的。
    // 等满 30 秒的结果是每次搜索都先白白卡半分钟，再去走本来就该走的那条
    const resp = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000),
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
  if (results.length) { refund(); return results.join("\n\n"); }
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
      refund();
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
  refund();
  return (
    "（本次搜索无结果" +
    (errors.length ? `。各引擎情况：${errors.join("；")}` : "") +
    "。可以等几十秒再试、换关键词，或用 fetch_url 直接访问已知的相关网站）"
  );
}

/** 拼错的工具名 → 最接近的真名。没有足够像的就返回空字符串，别乱猜误导模型。 */
function nearestTool(name, known) {
  const n = String(name || "");
  if (!Array.isArray(known) || !known.length || !n) return "";
  // MCP 全名是 mcp__<服务器>__<工具>，最常见的错法就是只写了最后一段
  const tail = known.find((k) => k.endsWith("__" + n));
  if (tail) return tail;
  const dist = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  };
  let best = "";
  let bd = Infinity;
  for (const k of known) {
    const d = dist(n, k);
    if (d < bd) { bd = d; best = k; }
  }
  return bd <= Math.max(2, Math.floor(n.length / 4)) ? best : "";
}

/**
 * 工具参数不是合法 JSON 时说给模型听的话。
 *
 * 本机 96 段会话里出现 4 次，四种坏法各不相同：`"size": 1024x1536`（值没加引号）、
 * 同一个对象吐了两遍（Extra data）、`{"mark">3:`（流式吐串了）、
 * 还有一次 write_file 塞了 19482 字的正文写到一半被输出长度截断。
 * 四次的共同点是：模型得到的反馈都不是「你发的参数坏了」，而是某个工具的必填校验。
 */
function badToolArgs(name, raw, parseError, rawLen) {
  const s = String(raw || "");
  const total = Number(rawLen) > 0 ? Number(rawLen) : s.length;
  // 只有完整拿到原文时，结尾才说明得了问题；被截过的那份结尾本来就不是模型写的结尾
  const truncated = total > s.length || !s.trim().endsWith("}");
  const head = s.length > 300 || total > s.length ? s.slice(0, 300) + " …（共 " + total + " 字）" : s;
  return (
    // 第一行必须短、且自己能说完一件事：界面过程区只取结果的第一行当「· 结果」，
    // 长了会被截成半截话，用户看到的就又是一条不知所云的红字
    `${name} 的参数不是合法 JSON，这次没执行（${truncated ? "看着像是没写完就被输出长度截断了" : "格式写错了"}）。\n` +
    (parseError ? `解析器原话：${parseError}\n` : "") +
    `收到的原文是：\n${head}\n` +
    (truncated
      ? `别原样重发同一坨——写长文件就用 write_file 带 append:true 一节一节写，长参数拆成几次调用。`
      : `按工具定义重发一次：参数必须是一个完整的 JSON 对象，字符串值都要带引号，同一个对象只发一遍。`)
  );
}

// 花钱那三样的生成结果缓存和计量（withGenCache / unitsFor / mediaProviderOf / asrModelOf）：在 src/tools/media.js

/**
 * 付费 API 的额度闸门。同时问两道闸：次数（一天最多生多少张）和钱（这个月最多花多少元）。
 *
 * 返回 { bad, hold }：
 *   bad  挡下来了。这是一条**给模型看**的错误——它会把这句话念给用户，
 *        所以必须写清楚撞的是哪道闸、去哪儿改，而不是甩一句「调用失败」
 *        让模型接着换个工具重试。
 *   hold 放行了，并且已经把预估的钱**预扣**下来了。调完必须交回去：
 *        成功走 quota.record(…, { hold })，没发出去走 quota.undo(hold)。
 *        两个都不调的后果不是漏钱（十五分钟后会被扫掉），而是那半小时里
 *        预算看着比实际少，没人能解释为什么。
 */
function quotaGate(cap, call = {}) {
  const g = quota.gate(cap, call);
  if (g.ok) return { bad: null, hold: g.hold };
  security.audit("额度拦截", `${(quota.CAPS[cap] || {}).label || cap}：${g.why}`, "拦截");
  return {
    bad: { content: g.why + "\n\n先别重试——重试不会变出额度来。把这句话原样告诉用户，让他找管理员调额度，或者换一条不花钱的路子（比如让用户自己贴内容进来）。", isError: true },
    hold: null,
  };
}

/**
 * 五路媒体工具（看图/生图/生视频/配音/转文字）统一穿过这里。
 *
 * quotaGate 管的是「这次花不花得起」，这里管的是「这条渠道现在还通不通」——
 * 一前一后两道闸，拦的都是**还没发出去的那个请求**。
 *
 * 为什么不写在五个函数各自的开头：那五个函数里散着三十多个 `return {isError:true}`，
 * 一个一个去记账，早晚漏掉一条，而漏掉的那条恰好就是撞得最凶的那条。放在派发这一层，
 * 无论里面从哪儿返回的，出口只有一个，记账必然完整。
 */
async function viaMedia(cap, opts, input, run) {
  let cfg = null;
  // pick 抛错 = 用户点名了一个不存在的型号，那是 input 的事不是渠道的事：照常放行，
  // 让里面那句「现在能用的是：…」原样出去
  try { cfg = mediaModels.pick((opts || {}).media, cap, (input || {}).model); } catch { cfg = null; }
  if (cfg && cfg.base_url) {
    const stop = mediaHealth.gate(cap, cfg, mediaModels.CAP_CN[cap]);
    if (stop) return stop;
    // 挂错家的型号，在发请求**之前**就拦下来。
    // 这不是为了省那一次网络往返，是为了让 agent 拿到一句它能照着做的话：上游回的原话是
    // 400 "not a valid model ID"，模型看了只会换个参数再来一遍，撞上十轮都不会想到
    // 「是渠道挂错了、得让用户去设置里改」。配置错不是能力问题，重试一万次也不会对。
    const capCn = mediaModels.CAP_CN[cap] || cap;
    // 写法不对（OpenRouter 上没写成「厂商/型号」）排在挂错家前面：改个写法就通，不是换渠道的事
    const shape = mediaModels.idShapeError(cfg.kind || mediaModels.guessKind(cfg.base_url), cfg.model, cfg.base_url);
    if (shape) {
      const res = { content:
        `${capCn}用不了：型号「${cfg.model}」的写法不对，${shape}。\n` +
        `请用户去 设置 → 模型 → ${capCn}，把型号名改成这种写法。\n` +
        `这一步不用重试，也别换参数再试——换什么参数都一样。`, isError: true };
      mediaHealth.record(cap, cfg, res);
      return res;
    }
    const want = mediaModels.mismatch(cfg.kind || mediaModels.guessKind(cfg.base_url), cfg.model, cfg.base_url);
    if (want) {
      const res = { content:
        `${capCn}用不了：型号「${cfg.model}」是${mediaModels.kindLabel(want)}家的，现在却挂在` +
        `${mediaModels.kindLabel(cfg.kind || mediaModels.guessKind(cfg.base_url))}那条渠道上——这个型号不存在于那条渠道，调过去只会报错。\n` +
        `请用户去 设置 → 模型 → ${capCn}，把它改挂到${mediaModels.kindLabel(want)}的渠道（没有就先加一条），或者换一个这条渠道上有的型号。\n` +
        `这一步不用重试，也别换参数再试——换什么参数都一样。`, isError: true };
      mediaHealth.record(cap, cfg, res);
      return res;
    }
  }
  let res = await run();
  // 停止掐在读正文那一截（大图的 b64、TTS 的音频），里面常常只剩一句「没有返回图片」——
  // 那不是渠道坏了，也别让模型当成故障换参数重来：一律按停止回
  const o = opts || {};
  const halted = (o.signal && o.signal.aborted) || (o.stopSignal && o.stopSignal.aborted);
  if (halted && res && res.isError && !res.stopped) res = { content: "用户已停止任务，这一步没做完。", isError: true, stopped: true };
  // 用户点的停止不算这条渠道通不通，不记
  if (cfg && cfg.base_url && !(res && res.stopped)) mediaHealth.record(cap, cfg, res);
  return res;
}

// 画布状态的读写 / 规整 / 备份和 canvas 工具：在 src/tools/canvas.js

/** 工具跑完之后：改了文件就跑 after_edit 钩子，输出接在回执后面（钩子见 hooks.js） */
async function executeTool(name, input, opts = {}) {
  const r = await executeToolCore(name, input, opts);
  if (r && r.editedFile && !r.isError && opts.hooks && HK.pick(opts.hooks.after_edit, r.editedFile).length) {
    const f = r.editedFile;
    // prettier 这类钩子会把刚写的文件再改写一遍。那是我们自己这边的改动，不能让下一次 edit_file
    // 当成「别人改过」拦下来。只在钩子跑之前盘上正是刚写的那一版时才重新登记——
    // 追加前就被别人动过的（见 write_file append），别在这里把那一段也记成看过了
    const read = () => { try { return fs.readFileSync(f); } catch { return null; } };
    const pre = CT.staleNote(opts.sessionId, f, f) ? null : read();
    let said = await HK.afterEdit(opts.hooks, f, { cwd: ws(), stopSignal: opts.stopSignal });
    const post = pre && read();
    if (post && !post.equals(pre)) {
      CT.stampSeen(opts.sessionId, f);
      said += `\n\n（after_edit 钩子改写了这个文件：${pre.length} → ${post.length} 字节。接着改就照改写后的样子来，你手上的 old_text 可能对不上了）`;
    }
    if (said) return { ...r, content: String(r.content) + said };
  }
  return r;
}

/**
 * 会话 → 它以前在根上（不在任何对话文件夹里）写过的文件的绝对路径。每趟开头由调用方整份换掉（lib/task-dirs.js flatOutputs）。
 * 写文件默认落进这条对话自己的文件夹；只有这里登记过的、或这趟读过的根上文件，写的时候才回到根上那份。
 * 只活在这个进程里，会话多了先进先出。
 */
const rootOwned = new Map();
function ownRootFiles(sessionId, absPaths) {
  if (!sessionId) return;
  rootOwned.delete(sessionId);
  const list = (absPaths || []).filter(Boolean);
  if (list.length) rootOwned.set(sessionId, new Set(list.map((p) => path.resolve(p))));
  if (rootOwned.size > 500) rootOwned.delete(rootOwned.keys().next().value);
}

async function executeToolCore(name, input, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  // 安全中心策略（settings 里配置）；未传时用纯默认值（等价于旧行为 + 默认黑名单）
  const sec = opts.security || { ...security.DEFAULTS };
  // 文件名按哪家系统的规矩查（测试里传 "win32" 在 Mac 上验 Windows 的拦法）
  const plat = opts.platform || process.platform;
  // 每个对话一个成果子目录（服务器只在默认工作空间下传入）：相对路径读写、脚本 cwd、
  // 生成/下载的产物都落到这里，多个对话不再把工作空间根目录搅成一锅
  let fileBase = ws();
  if (opts.baseDir) {
    const b = path.resolve(ws(), String(opts.baseDir));
    if (b === ws() || b.startsWith(ws() + path.sep)) {
      fileBase = b;
      try { fs.mkdirSync(fileBase, { recursive: true }); } catch {}
    }
  }
  // 文件工具统一走策略解析：workspace 内默认放行、黑名单硬拦、workspace 外仅白名单
  const baseName = fileBase === ws() ? "" : path.basename(fileBase);
  // 成果目录可以是两层（IM_对话/0930_做海报、定时任务/每日简报），模型照抄全路径的也得认出来
  const baseRel = fileBase === ws() ? "" : path.relative(ws(), fileBase).split(path.sep).join("/");
  const resolveFile = (rel, mode) => {
    // 少给 path 是模型真会犯的错（本机 96 段会话里 7 次：write_file 2 次、edit_file 5 次，
    // 多半是参数 JSON 太长被截断，或者干脆漏了这一项）。老写法把空路径解析成工作目录本身，
    // 下游抛一句 `EISDIR: illegal operation on a directory, open '/Users/…/my-project'`——
    // 模型完全看不出错在哪（它会照原样再试一遍），还把本机绝对路径抖进了对话里。
    if (!String(rel == null ? "" : rel).trim()) {
      throw new Error(
        `这次调用没给 path。${name} 必须带上目标文件的相对路径，比如 {"path": "报告.html"}。` +
          `（如果你刚才那次参数很长，多半是被截断了：把 content 拆短些、或者先建文件再用 append 往后写。）`
      );
    }
    // 相对路径已经是从成果子目录起算的，模型再在前面拼一遍目录名，
    // 落点就成了 任务_X/任务_X/…：任务目录建在任务目录里，产物就此和交付分了家。
    // "同名目录套同名目录"没有任何一种正当写法，直接剥掉这一层。
    if (baseName) {
      const s0 = String(rel || "").replace(/\\/g, "/");
      // 光秃秃的末段名只在它是应用起的名字（任务_0930_…、0930_…）时才剥：定时任务/每日简报 是用户起的任务名，
      // 里面真建一个同名子文件夹是正当的，剥了就跟 run_shell 在同一个 cwd 下看到的对不上
      const stamped = /^(?:任务_)?\d{4}_/.test(baseName);
      const pre = [baseRel, stamped ? baseName : ""].find((p) => p && (s0 === p || s0.startsWith(p + "/")));
      if (!path.isAbsolute(s0) && pre) {
        const fixed = s0.slice(pre.length).replace(/^\/+/, "");
        console.warn(`[tools] ${name}: 路径多套了一层成果目录，已纠正 ${s0} → ${fixed || "."}`);
        rel = fixed || ".";
      }
    }
    // 要写的名字是模型起的：Windows 上 `纪要_10:30.md` 不报错，冒号后面那半截写进了备用数据流，
    // 文件夹里只剩一个打不开的 0 字节文件，模型还以为写成了。当场拦下、说清楚，让它自己换名字——
    // 悄悄改名不行，它汇报出去的路径就成了不存在的那个
    if (mode === "write" || mode === "edit") {
      const why = winname.badPath(String(rel), plat);
      if (why) throw new Error(why);
    }
    const r = security.resolvePathWithPolicy(sec, rel, ws(), fileBase);
    if (!r.allowed) {
      security.audit("文件拦截", `${name}: ${rel}`, "拦截");
      throw new Error(`文件访问被安全中心拦截：${r.reason}`);
    }
    // 成果子目录下没有、工作空间根下有 → 用根下那个（读旧对话的产物/共享素材不用写全路径）
    // 兜底只认文件：兜到一个同名目录上，下游就是一句莫名其妙的 EISDIR
    // 两层的成果目录（定时任务/每日简报）先看上一层：分文件夹以前，那条任务的产物摊在 定时任务/ 下，
    // 它每天接着往上追加的那份汇总不能因为换了落点就「找不到」
    if (fileBase !== ws() && !fs.existsSync(r.path)) {
      const up = path.dirname(fileBase);
      for (const b of up !== ws() && up.startsWith(ws() + path.sep) ? [up, ws()] : [ws()]) {
        const r2 = security.resolvePathWithPolicy(sec, rel, ws(), b);
        try {
          if (r2.allowed && fs.statSync(r2.path).isFile() && (mode !== "write" || seenHere(r2.path))) return r2.path;
        } catch {}
      }
    }
    return r.path;
  };
  // 写的时候不能照读的规矩兜到根下去。2026-09-29 几条对话并排跑（test/chat-isolation.js）：
  // 工作空间根下留着一张更早的 chrome-screenshot.png、一个 index.html，每条对话 chrome_cdp 截图不给 path、
  // write_file 写 index.html，全被兜到根下那一份上——几条对话轮流盖同一个文件，谁的成果卡点开都是最后写的那家。
  // 只有这条对话自己读过根下那份（read_file / edit_file 登记过），才算「接着改那个旧文件」照旧写回去；
  // 否则就是新产物，落在自己的任务文件夹里
  // 这条对话自己以前在根上写过的（分文件夹以前的老产出，见 ownRootFiles）也算：整篇重写它就写回那份，不在新格里另起一份
  const seenHere = (abs) => {
    const m = opts.sessionId ? CT._internals.seen.get(opts.sessionId) : null;
    const own = opts.sessionId ? rootOwned.get(opts.sessionId) : null;
    return !!((m && m.has(abs)) || (own && own.has(abs)));
  };
  /** @param {string} rel */
  const resolveWrite = (rel) => resolveFile(rel, "write");
  // 档位是「只看不动 / 每步都问」时跑命令、跑代码也得照档办：安全闸门总开关关掉的是名单那套规则，
  // 不是用户当场选的档。原来只有写文件那几个工具传了 force，关了闸门以后 plan 档照样能 rm
  const modeGated = () => ["plan", "ask"].includes(security.permissionMode(sec));
  /**
   * 闸门统一走这里：拦下就返回一段给模型看的说明，放行返回 null。
   * run_shell 和 run_node 用的是同一套 —— 只守 shell 那扇门是守不住的，
   * 一句 require("child_process") 就从旁边过去了。
   */
  const passGate = async (verdict, label, text, { force = false, detail = "" } = {}) => {
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
      owner: opts.actor || "",
      detail, // 改文件的 diff：看着改了哪几行批，而不是对着一个文件名下注
      seg: verdict.seg || "", // 长命令里到底是哪一段触发的：尾巴上藏一句 rm -rf，人得一眼看得见
      sessionId: opts.sessionId || "",
    });
    security.audit(label + "审批", text, ok ? "已批准" : "已拒绝");
    if (ok) return null;
    // 别说「已在界面弹出」：命令行前面没人时是当场拒的，根本没摆过——模型照着这句会跟人说「你拒了」
    return {
      content: `${label}未获批准（${verdict.rule}）：被拒、等超时，或者当时没人能批。可以换一种不需要它的做法，或请用户预先放行这类（设置 → 安全中心 的名单；命令行加 --allow）。`,
      isError: true,
    };
  };
  /**
   * 名单外那条命令/那段代码，跑之前先判一句。
   *
   * 只做一件事：把 allow 抬成 ask。抬错了顶多多弹一张卡，人点一下就过；
   * 不抬的后果是 `git reset --hard` 一声不吭地把今天的活儿冲了——四张名单谁也拦不住它。
   * 所以每一条失败的路（没开、没配、粗筛说没事、问不成、说不准）都退回今天的样子：照跑。
   */
  const judgeRisk = async (verdict, kind, text) => {
    const seg = cmdRisk.needsJudge({ verdict, sec, text, kind });
    if (!seg) return verdict;
    const hit = cmdRisk.recall(text);
    if (hit.hit) return hit.verdict || verdict; // 判过了：危险的照样弹卡，没事的不再花第二遍钱
    const cfg = opts.decideConfig;
    if (!cfg || !jev.status(cfg).ready) return verdict;
    try {
      const out = await jev.askMetered(
        cfg,
        {
          state: cmdRisk.riskState({
            text, seg, kind,
            // 绝对路径里带着用户名和家目录，这段是要发到上游去的：判这条命令危不危险，用不着知道它跑在谁的电脑上
            where: path.relative(ws(), fileBase) || "工作空间根目录",
            mode: security.PERMISSION_MODES[security.permissionMode(sec)].label,
          }),
          questions: cmdRisk.riskQuestions(kind),
          timeoutMs: 8000, // 挡在一条命令前面，等不起默认那 20 秒
        },
        { meta: "名单外先判一句" }
      );
      if (!out.ok) {
        console.warn(`[命令风险] 名单外那一问没问成（照旧执行）：${out.error}`);
        return verdict;
      }
      const d = cmdRisk.readRisk(out);
      const up = d ? cmdRisk.upgrade(seg, d, kind) : null;
      cmdRisk.remember(text, up);
      return up || verdict;
    } catch (e) {
      console.warn(`[命令风险] 名单外那一问没问成（照旧执行）：${e.message}`);
      return verdict;
    }
  };
  /**
   * 往长期记忆里写之前，先判一句：这句话下个月还用得上吗。
   * 只能把「记」变成「不记」；说不准、答不上、问不成，一律照旧记下。
   * @returns 拒收的回执（非空字符串）；空字符串 = 照旧记
   */
  const judgeMemory = async (text) => {
    const mem = opts.memory || {};
    const cfg = opts.decideConfig;
    const ready = !!(cfg && jev.status(cfg).ready);
    if (!memGate.needsJudge({ text, source: "agent", on: mem.gate, ready })) return "";
    try {
      const out = await jev.askMetered(
        cfg,
        {
          state: memGate.keepState({ text, task: mem.task }),
          questions: memGate.keepQuestions(),
          timeoutMs: 8000, // 人在等这一步的回执，等不起默认那 20 秒
        },
        { meta: "记之前先判一句" }
      );
      if (!out.ok) {
        console.warn(`[长期记忆] 写之前那一问没问成（照旧记下）：${out.error}`);
        return "";
      }
      const d = memGate.readKeep(out);
      return d ? memGate.dropNote(d) : "";
    } catch (e) {
      console.warn(`[长期记忆] 写之前那一问没问成（照旧记下）：${e.message}`);
      return "";
    }
  };
  try {
    ensureDirs();
    // 参数压根不是合法 JSON（llm.js 解析失败时会塞一个 _raw 进来）。
    // 不拦的话会一路走到各工具的必填校验，报出来的是「缺少 prompt」这种话——
    // 模型看了以为自己漏填字段，于是把同样的东西原样再发一遍，接着再坏一次。
    if (input && typeof input === "object" && typeof input._raw === "string") {
      return { content: badToolArgs(name, input._raw, input._parseError, input._rawLen), isError: true };
    }
    switch (name) {
      case "canvas_manage":
        // 带上本对话的成果文件夹：agent 写进节点的相对路径是从那儿算的，画布要的是从根算的
        return canvasManage(input, { base: baseRel, platform: plat });
      case "run_node": {
        if (orgBlocksShell()) return shellBlocked("run_node");
        if (sec.runtime_node === false) {
          security.audit("命令拦截", "run_node（内置 Node.js 运行时已停用）", "拦截");
          return { content: "内置 Node.js 运行时已在 设置 → 安全中心 停用，无法执行代码。", isError: true };
        }
        const code = String(input.code || "");
        const diy = diyBrowser(code);
        if (diy) return diy;
        // 给人批的是整段代码，不能只给前 500 字：危险的那句完全可以写在第 501 个字以后。
        // modeGated：只看不动/每步都问是用户当场选的档，闸门总开关关着也得照档办
        const blocked = await passGate(await judgeRisk(security.checkCode(sec, code), "代码", code), "代码", code, { force: modeGated() });
        if (blocked) return blocked;
        return await runNode(code, timeoutMs, fileBase, opts.stopSignal, opts.sessionId || "");
      }
      case "run_shell": {
        if (orgBlocksShell()) return shellBlocked("run_shell");
        const cmd = String(input.command || "");
        if (!cmd.trim()) return { content: "command 是空的：要跑什么命令写在 command 里。", isError: true };
        const diy = diyBrowser(cmd);
        if (diy) return diy;
        const blocked = await passGate(await judgeRisk(security.checkCommand(sec, cmd), "命令", cmd), "命令", cmd, { force: modeGated() });
        if (blocked) return blocked;
        const hookSays = await HK.beforeShell(opts.hooks, cmd, { cwd: fileBase, stopSignal: opts.stopSignal });
        if (hookSays) { security.audit("命令执行", cmd, "钩子拦截"); return { content: hookSays, isError: true }; }
        security.audit("命令执行", cmd, "放行");
        if (input.background) return startBackground(cmd, fileBase, opts, input.keep === true);
        return await runShell(cmd, timeoutMs, fileBase, opts.stopSignal, opts.sessionId || "");
      }
      case "shell_output": {
        const who = bgOwner(opts);
        if (!input.id) {
          const mine = CT.bgList().filter((j) => j.owner === who);
          if (!mine.length) return { content: "没有后台命令。用 run_shell 加 background:true 起一条。", isError: false };
          return { content: mine.map((j) => `${j.id}  ${CT.bgState(j)}  ${j.command.slice(0, 120)}`).join("\n"), isError: false };
        }
        const job = CT.bgList().find((j) => j.id === String(input.id));
        if (job && job.owner !== who) return { content: `没有这条后台命令：${input.id}`, isError: true };
        const r = CT.bgRead(input.id, { all: !!input.all });
        if (r.error) return { content: r.error, isError: true };
        let out = `${r.job.id}：${r.state}\n`;
        if (r.lost) out += `（中间有 ${r.lost} 字符太久没读、已从内存挤掉，全文在 ${path.basename(r.job.logFile || "")}）\n`;
        out += r.cut + (r.text || "（从上次看过之后没有新输出）");
        return { content: out, isError: false };
      }
      case "shell_kill": {
        const job = CT.bgList().find((j) => j.id === String(input.id || ""));
        if (!job || job.owner !== bgOwner(opts)) return { content: `没有这条后台命令：${input.id}`, isError: true };
        const r = CT.bgKill(input.id, (c) => killTree(c));
        if (r.already) return { content: `${job.id} 早就${CT.bgState(job)}，不用停`, isError: false };
        return { content: `已停掉 ${job.id}（${job.command.slice(0, 80)}）。最后的输出用 shell_output 还能看`, isError: false };
      }
      case "find_files": {
        try {
          const root = resolveFile(".");
          const base = resolveFile(input.dir || ".");
          return { content: CT.findFilesText(root, { ...input, base }), isError: false };
        } catch (e) {
          return { content: e.message, isError: true };
        }
      }
      case "todo_write": {
        const r = CT.normalizeTodos(input.todos);
        if (r.error) return { content: r.error, isError: true };
        return { content: CT.todoReceipt(r.items), isError: false, todos: r.items };
      }
      case "multi_edit": {
        const rel = String(input.path || "");
        const p = resolveFile(rel, "edit");
        const stale = CT.staleNote(opts.sessionId, p, rel);
        if (stale) return { content: stale, isError: true };
        let plan = planMulti(readSource(p, rel), rel, input.edits);
        const blocked = await passGate(security.checkWrite(sec, rel), "改文件", rel, {
          force: true,
          detail: plan.noop ? "" : diffText(rel, plan.src, plan.out),
        });
        if (blocked) return blocked;
        const now = readSource(p, rel);
        if (now !== plan.src) plan = planMulti(now, rel, input.edits);
        if (plan.noop) return { content: plan.msg, isError: false };
        fs.writeFileSync(p, plan.out, "utf8");
        CT.stampSeen(opts.sessionId, p);
        const c = await selfCheck(p, rel);
        return noteChange(
          { content: plan.msg + c.note, isError: c.bad },
          { root: ws(), abs: p, rel, before: plan.src, after: plan.out, tool: "multi_edit", session: opts.sessionId, call: opts.callId }
        );
      }
      case "gen_diagram": {
        const rel = String(input.filename || "diagram").replace(/\.(svg|png)$/i, "");
        const blocked = await passGate(security.checkWrite(sec, rel + ".svg"), "写文件", rel + ".svg", { force: true });
        if (blocked) return blocked;
        const { renderDiagram } = require("../domains/media/diagram");
        const r = await renderDiagram({
          kind: input.kind, source: String(input.source || ""), width: input.width, height: input.height, theme: input.theme,
        });
        const svgPath = resolveWrite(rel + ".svg");
        fs.mkdirSync(path.dirname(svgPath), { recursive: true });
        fs.writeFileSync(svgPath, r.svg);
        let msg = `已生成 ${rel}.svg（${(Buffer.byteLength(r.svg) / 1024).toFixed(1)}KB）`;
        if (r.png) {
          fs.writeFileSync(resolveWrite(rel + ".png"), r.png);
          msg += `、${rel}.png（${(r.png.length / 1024).toFixed(1)}KB，插飞书/Word 用这个）`;
        }
        if (r.note) msg += `。${r.note}`;
        return { content: msg, isError: false };
      }
      case "write_file": {
        const rel = String(input.path || "");
        const p = resolveWrite(rel);
        // 没给 content 跟没给 path 一样是真会犯的错（参数名写成 file_text/contents、或者漏了）。
        // 老写法当空串写下去，回一句「已覆盖（原 72 字节 → 现 0 字节）」算成功——文件清空了，模型还以为写好了
        if (input.content == null) return { content: `这次 write_file 没给 content，一个字节都没写。要写的内容放在 content 里；真要建空文件或清空文件就显式传 content:""。`, isError: true };
        // 给了个对象：String() 出来是「[object Object]」。.json 文件意思很明白，替它排成文本；别的文件没法猜
        let body = input.content;
        if (typeof body === "object") {
          if (!/\.json$/i.test(rel)) return { content: `content 得是一段文本，这次给的是一个对象，一个字节都没写。`, isError: true };
          body = JSON.stringify(body, null, 2) + "\n";
        }
        body = String(body);
        // 落盘之前先把 diff 算出来：审批卡上要给人看这次到底动了哪几行，看着批才算批
        const was = readBefore(p);
        // 原文件整篇是 \r\n：它写来的 \n 跟着换，不然重写/追加一次整个文件的换行就变了
        if (was && body.includes("\n") && !body.includes("\r") && pureCrlf(was.toString("utf8"))) body = body.replace(/\n/g, "\r\n");
        const n = Buffer.byteLength(body);
        const blocked = await passGate(security.checkWrite(sec, rel), "写文件", rel, {
          force: true,
          detail: diffText(rel, was, input.append ? Buffer.concat([was || Buffer.alloc(0), Buffer.from(body, "utf8")]) : body),
        });
        if (blocked) return blocked;
        const existed = fs.existsSync(p);
        if (existed && fs.statSync(p).isDirectory()) return { content: dirInsteadOfFile(p, rel).message, isError: true };
        if (existed && !input.append) {
          const stale = CT.staleNote(opts.sessionId, p, rel);
          if (stale) return { content: stale, isError: true };
        }
        const oldSize = existed ? fs.statSync(p).size : 0;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        // 整篇重写把一个现成文件砍掉一大截 = 几乎肯定是没读全就重写，写下去就找不回来了。
        // 提示词里写一百遍「别整篇重写」也拦不住，只能在工具这一层真的不让它写。
        if (existed && !input.append && !input.overwrite && oldSize >= 800 && n < oldSize * 0.6) {
          return {
            content:
              `已拦截，一个字节都没写：${rel} 现在是 ${oldSize} 字节，你这次只给了 ${n} 字节，` +
              `写下去等于删掉 ${oldSize - n} 字节现成内容。\n` +
              `改局部用 edit_file；接着往后写用 append:true；` +
              `确实就是要整篇换掉（已经 read_file 读完全文、清楚自己要删什么），再传 overwrite:true 重来。`,
            isError: true,
          };
        }
        // 等审批那会儿文件可能被别的任务动过：留底按批完这一刻盘上的内容算
        const before = existed ? readBefore(p) : null;
        const change = { root: ws(), abs: p, rel, before, tool: "write_file", session: opts.sessionId, call: opts.callId, record: !existed || before != null };
        const bak = existed && !input.append ? keepBackup(p, rel) : "";
        if (input.append) {
          // 追加前它要是已经被别人改过，追加完也不能记成「看过了」：它没看过别人那一段
          const unseen = existed && CT.staleNote(opts.sessionId, p, rel);
          fs.appendFileSync(p, body, "utf8");
          if (!unseen) CT.stampSeen(opts.sessionId, p);
          const c = await selfCheck(p, rel, true);
          return noteChange(
            { content: `已追加到 ${rel}（+${n} 字节，现共 ${fs.statSync(p).size} 字节）${c.note}`, isError: c.bad },
            { ...change, after: Buffer.concat([before || Buffer.alloc(0), Buffer.from(body, "utf8")]) }
          );
        }
        fs.writeFileSync(p, body, "utf8");
        CT.stampSeen(opts.sessionId, p);
        const c = await selfCheck(p, rel);
        // 覆盖和新建要说清楚：整篇重写一个已有文件，多半是该用 edit_file 却偷懒了
        return noteChange(
          {
            content:
              (existed
                ? `已覆盖 ${rel}（原 ${oldSize} 字节 → 现 ${n} 字节）` +
                  (bak ? `，原件留了一份在 ${bak}` : "") +
                  `。提醒：改已有文件的局部内容用 edit_file，整篇重写会连你没读过的部分一起换掉。`
                : `已新建 ${rel}（${n} 字节）`) + c.note,
            isError: c.bad,
          },
          { ...change, after: body }
        );
      }
      case "edit_file": {
        const rel = String(input.path || "");
        const p = resolveFile(rel, "edit");
        const stale = CT.staleNote(opts.sessionId, p, rel);
        if (stale) return { content: stale, isError: true };
        // 先算出改完是什么样：匹配不上、不唯一这些错当场就能报，不用先把用户叫来批一个改不成的改动
        let plan = planEdit(readSource(p, rel), rel, input);
        const blocked = await passGate(security.checkWrite(sec, rel), "改文件", rel, {
          force: true,
          detail: plan.noop ? "" : diffText(rel, plan.src, plan.out),
        });
        if (blocked) return blocked;
        // 等审批那会儿文件可能被别的任务动过：批完按盘上现在的内容重算一遍再落盘
        const now = readSource(p, rel);
        if (now !== plan.src) plan = planEdit(now, rel, input);
        if (plan.noop) return { content: plan.msg, isError: false };
        fs.writeFileSync(p, plan.out, "utf8");
        CT.stampSeen(opts.sessionId, p);
        const c = await selfCheck(p, rel);
        return noteChange(
          { content: plan.msg + c.note, isError: c.bad },
          { root: ws(), abs: p, rel, before: plan.src, after: plan.out, tool: "edit_file", session: opts.sessionId, call: opts.callId }
        );
      }
      case "read_file": {
        const p = resolveFile(input.path);
        let st = null;
        try { st = fs.statSync(p); } catch {}
        if (st && st.isDirectory()) return { content: dirInsteadOfFile(p, String(input.path)).message, isError: true };
        // 按文本读一张 png，拿回来的是几万字符乱码：既看不出任何东西，还把上下文烧掉一大块
        if (IMAGE_EXT.test(p)) {
          return { content: `${input.path} 是图片，按文本读只会得到乱码。改用 look_at_image，并带上你想知道的具体问题。`, isError: true };
        }
        // docx/xlsx/pptx 本质是 zip，按 utf8 读回来同样是一大坨乱码。这个产品自己就产出这几种
        // 文件，读不了等于交付完看不了自己的活
        if (DOC_EXT.test(p)) {
          return { content: `${input.path} 是打包格式（Office 文档 / 压缩包），按文本读只会得到乱码。改用 read_document。`, isError: true };
        }
        // PDF 没有内置解析器，只能指条真路。别说「自己写代码解析」——run_node 里也没有这个库
        if (/\.pdf$/i.test(p)) {
          return { content: `${input.path} 是 PDF，按文本读只会得到乱码。${pdfHowTo(String(input.path))}`, isError: true };
        }
        // 按文本读一个二进制文件（.so、.sqlite、没后缀的可执行文件）拿回来的是乱码还不报错，
        // 模型会对着乱码硬猜。开头 8KB 里有 NUL 字节就当二进制，直说
        if (st && st.isFile() && st.size && fileHasNul(p)) {
          return { content: `${input.path} 是二进制文件（${st.size} 字节），按文本读只会得到乱码。想知道是什么用 run_shell 跑 \`file\`；要看字节用 \`xxd | head\`。`, isError: true };
        }
        if (st) CT.stampSeen(opts.sessionId, p);
        // offset/limit 是别家读文件工具的叫法，模型顺手就这么写；不认的话参数被静默丢掉、整篇从头读，
        // 它还以为读到的是第 offset 行开始的那段
        const off = Number(input.offset) || 0, lim = Number(input.limit) || 0;
        const s = Math.max(0, Number(input.start_line) || off || (lim ? 1 : 0));
        const e = Math.max(0, Number(input.end_line) || (lim ? Math.max(1, s) + lim - 1 : 0));
        // 大文件走分块读：整份读会把事件循环钉住十几到几百毫秒，界面当场定住
        if (st && st.size > READ_BIG) {
          return { content: await readBigFile(p, String(input.path), st.size, s, e), isError: false };
        }
        const content = fs.readFileSync(p, "utf8");
        if (s || e) {
          const lines = content.split("\n");
          const from = Math.max(1, s || 1);
          // 翻页翻到头了不是失败，是「这就是结尾」这条信息本身：模型正是靠它知道文件读完了。
          // 标成 isError 会喂进 errStreaks，把一次正常的顺序翻页记成 read_file 连续失败。
          // 本机 96 段会话里 read_file 报的 13 次失败，有 6 次是这个。
          if (from > lines.length)
            return { content: `${input.path} 到头了：全文共 ${lines.length} 行，start_line=${from} 已经在末尾之后，后面没有内容了。`, isError: false };
          const to = Math.min(lines.length, e || lines.length);
          const out = numberedLines(String(input.path), from);
          for (let i = from; i <= to; i++) if (!out.push(i, lines[i - 1])) break;
          return { content: out.render(to, lines.length), isError: false };
        }
        const cut = content.length > 50000;
        return {
          content: content.slice(0, 50000) + (cut ? `\n\n（文件 ${content.length} 字符，这里只给了前 50000。要看后面用 start_line/end_line）` : ""),
          isError: false,
        };
      }
      case "read_document": {
        const rel = String(input.path || "");
        const abs = resolveFile(rel);
        let st = null;
        try { st = fs.statSync(abs); } catch {}
        if (!st) return { content: `${rel} 不存在。先用 list_files 看看工作目录里到底有什么。`, isError: true };
        if (st.isDirectory()) return { content: dirInsteadOfFile(abs, rel).message, isError: true };
        try {
          return { content: await readDocument(abs, rel, input), isError: false };
        } catch (e) {
          return { content: `读不了 ${rel}：${e.message}`, isError: true };
        }
      }
      case "list_files": {
        const dir = resolveFile(input.dir || ".");
        // 以前列 proj 回的是 src/a.js，模型拿去 read_file 读到的是根下另一个同名文件，或者干脆找不到
        // 在工作目录外面的就带绝对路径，照样能直接拿去读
        const rel = path.relative(resolveFile("."), dir);
        const pre = (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel) ? dir : rel).split(path.sep).join("/");
        return { content: listFiles(dir, input.depth, pre), isError: false };
      }
      case "search_files": {
        // pattern/path 是 grep 类工具的叫法，模型顺手就这么写；不认的话报「query 是空的」白烧一轮
        const q = { ...input, query: input.query || input.pattern, dir: input.dir || input.path };
        const root = resolveFile(q.dir || ".");
        const relBase = resolveFile(".");
        // 给的是一个文件：只搜这一个。以前当目录去列，列不出来就回「没搜到、扫了 0 个文件」，像是真没有
        let isFile = false;
        try { isFile = fs.statSync(root).isFile(); } catch {}
        if (isFile) return { content: await searchFiles(path.dirname(root), { ...q, only: root, relBase }), isError: false };
        return { content: await searchFiles(root, { ...q, relBase }), isError: false };
      }
      case "chrome_cdp": {
        const action = String(input.action || "list_tabs");
        if (action === "navigate" && !/^https?:\/\//i.test(String(input.url || ""))) {
          return { content: "navigate 只接受 http/https URL。", isError: true };
        }
        // owner：几个对话同时开浏览器时各用各的标签页（cdp.js OWNED）
        const r = await cdp.run({ ...input, owner: opts.sessionId || "" });
        if (action === "screenshot") {
          const rel = String(input.path || "chrome-screenshot.png").replace(/^[/\\]+/, "");
          const p = resolveWrite(rel);
          const blocked = await passGate(security.checkWrite(sec, rel), "写截图", rel, { force: true });
          if (blocked) return blocked;
          fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(r.data, "base64"));
          // 结果里的 note（标签页被收掉换了新页 / 刚从冻住解开）不能在这里丢：丢了模型就拿一张白页或一屏旧画面当真
          return { content: `已保存 Chrome 截图：${rel}（${Math.round(fs.statSync(p).size / 1024)}KB，tab ${r.tab_id}）` + (r.note ? `\n${r.note}` : ""), isError: false };
        }
        return { content: JSON.stringify(r, null, 2), isError: false };
      }
      case "record_web_demo": {
        // 本机 Chrome + ffmpeg，不花钱：不过 quotaGate。先过写权限（录屏要落一整个目录），再开浏览器
        const wd = require("../domains/media/web-demo-recorder");
        let outRel;
        try { outRel = wd.outDirRel(input); } catch (e) { return { content: e.message, isError: true }; }
        const blocked = await passGate(security.checkWrite(sec, outRel), "写录屏", outRel, { force: true });
        if (blocked) return blocked;
        // 打开的地址、页面每次换页（含自己跳的）都过组织名单 + 安全中心，跟 fetch_url 同一道闸。
        // 换页是落地之后才查（请求已经发出去了），查到就整条不交片；图片、fetch 这类子资源不查，跟 fetch_url 渲染模式一样
        const checkNav = (u) => {
          const org = hostAllowed(null, u);
          if (!org.ok) { security.audit("网络拦截", u, "拦截"); return { ok: false, why: org.why }; }
          const g = security.checkUrl(sec, u);
          if (!g.allowed) { security.audit("网络拦截", u, "拦截"); return { ok: false, why: `安全中心拦下了：${g.reason}（设置 → 安全中心 → 网络安全）` }; }
          security.audit("网络访问", `录屏打开：${u}`, "放行");
          return { ok: true };
        };
        return await withStop(opts, (stop) => wd.runTool(input, {
          outRel, outAbs: resolveWrite(outRel), resolveFile, checkNav, stop, deadline: opts.deadline, onProgress: opts.onProgress,
        }));
      }
      case "remember": {
        // 先跑现成的那几道尺子（空/太长/像凭据/像能力断言）：本来就拒的，不必再花一道题的钱
        const pre = memory.preflight({ text: input.text, source: "agent" });
        if (pre.ok) {
          const drop = await judgeMemory(pre.text);
          if (drop) return { content: drop, isError: true };
        }
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
        // 体检查出毛病，是这个工具干成了它该干的活，不是它自己失败了。标成 isError 会连累三处：
        // errStreaks 把「改一次、测一次」记成连续失败去触发循环检测（真实数据里 15 次调用被记了
        // 8 次假失败）；trimHistory 把它当成不可重现的证据舍不得裁；模型看见红色的失败会倾向于
        // 重跑体检，而它其实该去改页面。问题写在报告正文里，模型看得懂。
        const bad = /\[错\]/.test(report);
        return { content: (bad ? "体检发现问题，需要你去改页面（工具本身跑通了，别重跑体检）：\n" : "") + report, isError: false };
      }
      case "save_skill": {
        const name = String(input.name || "").trim();
        if (!/^[a-z0-9][a-z0-9-_]{1,40}$/.test(name)) {
          return { content: "技能名不合法：请用小写字母/数字/连字符，如 market-research", isError: true };
        }
        // 上面那条放得过 con、nul、com1：Windows 上这些是设备名，技能文件夹建不出来
        const winBad = winname.badPath(name, plat);
        if (winBad) return { content: winBad, isError: true };
        // 技能存在工作区外、全机共用，每趟任务都会重新读进提示词：一次注入就能一直留着。
        // 所以它得跟写文件一样过档位、跟装技能一样过扫描，覆盖已有的还得人点头
        const skills = require("../core/ext/skills");
        const guard = require("../core/safety/skill-guard");
        const toolward = require("../core/safety/toolward");
        const hit = skills.getSkillFull(name); // 跟技能页一样认 frontmatter 里的名字，别另起一个同名的把原来那个盖住
        if (hit && hit.readonly) return { content: `「${name}」是插件 ${hit.plugin} 带的技能，不能覆盖。换个名字存`, isError: true };
        const dir = hit ? path.join(skills.SKILLS_DIR, hit.dir) : dataPath("skills", name);
        const file = path.join(dir, "skill.md");
        const rel = `skills/${path.basename(dir)}/skill.md`;
        const body = String(input.content || "");
        const scan = toolward.merge(guard.scanOne("skill.md", body), toolward.scanText("skill.md", body, { security: sec }, { subject: name }));
        if (scan.level === "block") {
          // 模型手里没有「仍然安装」那颗按钮：真要存，得人自己去技能页粘进去
          security.audit("保存技能拦截", rel, "拦截");
          return { content: guard.explain(scan, name), isError: true };
        }
        const was = readBefore(file);
        let verdict = security.checkWrite(sec, rel); // 只看不动 → 拒
        // 扫描只认得已知写法，大白话写的注入它看不出来，兜底的还得是人：每步都问照问；
        // 别的档新建直接存，覆盖已有的、扫出告警的要点头。ruleKey 留空：批过「这类都允许」
        // 的写文件，不该顺带把改技能也放了
        if (verdict.action !== "deny" && (security.permissionMode(sec) === "ask" || was || scan.level === "warn")) {
          const why = was ? `覆盖已有技能「${name}」` : scan.level === "warn" ? `新技能「${name}」扫出告警` : `新建技能「${name}」`;
          verdict = { action: "ask", rule: why, seg: rel, ruleKey: "" };
        }
        const blocked = await passGate(verdict, "保存技能", rel, {
          force: true,
          detail: (scan.level === "warn" ? guard.explain(scan, name) + "\n\n" : "") + diffText(rel, was, body),
        });
        if (blocked) return blocked;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, body, "utf8");
        return { content: `技能「${name}」已保存并生效（${rel}）`, isError: false };
      }
      case "install_skill": {
        // 跟技能页「从 GitHub 安装」走同一个函数：同一道扫描、同一张 .install.json 回执。
        // 以前没有这个工具，用户说「装这个技能」，模型只能照上游 README 自己 clone——
        // 落进工作目录和 ~/.claude/skills，本软件一个都不读，技能页和 / 里都找不到
        if (orgPolicy() && orgPolicy().skills_write === false) {
          return { content: "装技能归平台管理员：技能是整台服务器共用的，装进来所有人的任务都会带上。请管理员在「技能」页从 GitHub 安装。", isError: true };
        }
        const url = String(input.url || "").trim();
        if (!url) return { content: "缺 url：要装的技能的 GitHub 链接", isError: true };
        const skills = require("../core/ext/skills");
        const guard = require("../core/safety/skill-guard");
        let refused = null, asked = false;
        const review = async (list) => {
          const rel = list.map((s) => `skills/${skills.safeName(s.name)}`).join("、");
          const over = list.filter((s) => s.exists);
          const warn = list.filter((s) => s.scan.level === "warn");
          let verdict = security.checkWrite(sec, `skills/${skills.safeName(list[0].name)}/skill.md`); // 只看不动 → 拒
          // 跟 save_skill 一个尺子：每步都问照问；别的档新装直接装，盖掉已有的、扫出告警的要点头。
          // ruleKey 留空：批过「这类都允许」的写文件，不该顺带把装技能也放了
          if (verdict.action !== "deny" && (security.permissionMode(sec) === "ask" || over.length || warn.length)) {
            const why = over.length ? `覆盖已有技能「${over.map((s) => s.name).join("」「")}」`
              : warn.length ? `技能扫出告警` : `从 GitHub 装技能`;
            verdict = { action: "ask", rule: why, seg: rel, ruleKey: "" };
          }
          const detail = [
            `来源：${url}`,
            ...list.map((s) => `· ${s.name}${s.description ? "：" + String(s.description).replace(/\s+/g, " ").slice(0, 60) : ""}`),
            over.length && over[0].wholeDir ? `\n会整个替换现有的 ${over.map((s) => "skills/" + skills.safeName(s.name)).join("、")}：里面后来添的文件、装的依赖都会没。` : "",
            over.length && !over[0].wholeDir ? `\n会改写现有技能「${over[0].name}」的 skill.md，目录里别的文件不动。` : "",
            ...warn.map((s) => "\n" + guard.explain(s.scan, s.name)),
          ].filter(Boolean).join("\n");
          asked = verdict.action === "ask";
          refused = await passGate(verdict, "安装技能", rel, { force: true, detail });
          return !refused;
        };
        try {
          const done = await skills.installFromGitHub(url, { review, actor: { user: bgOwner(opts), via: "agent" } });
          const lines = done.map((s) => {
            const where = path.join(skills.SKILLS_DIR, skills.safeName(s.name));
            const skip = (s.skipped || []).length ? `；超过 5MB 没拷的：${s.skipped.map((f) => f.path).join("、")}` : "";
            return `· ${s.name} → ${where}${s.scan && s.scan.level !== "ok" ? `（扫描有 ${s.scan.findings} 条告警，已获同意）` : ""}${skip}`;
          });
          return {
            content: `已装进技能库，技能页和输入框里的 / 现在就找得到：\n${lines.join("\n")}\n` +
              "要用就 use_skill 加载。技能说明里要装依赖的，到上面的技能目录里装；别再往工作目录或 ~/.claude/skills 另放一份。",
            isError: false,
          };
        } catch (e) {
          // 问了没批：通用那句「请用户预先放行这类」对装技能不成立（这张卡不给放行），换成真走得通的那条路
          if (refused && asked) {
            return { content: "没装：这一步要人点头，没拿到同意（被拒、等超时，或者当时没人能批）。可以请用户到「技能」页从 GitHub 装，那里看得到扫描结果、能自己点确认。", isError: true };
          }
          if (refused) return refused;
          return { content: e.skillScan ? e.message : `技能没装上：${e.message}`, isError: true };
        }
      }
      case "add_connector": {
        // 跟连接器页「保存」走同一套（server.js 塞进来的 connectorHost）：同一个校验、同一份 toolward 体检、
        // 同一条重连队。以前没有这个工具，用户说「接一下某某 MCP」，模型只能手改 config.json——
        // 不重启不生效、连接器页上看不见，下一次随便存点什么还可能被整张表盖回去
        if (orgPolicy() && orgPolicy().connectors_write === false) {
          return { content: "加连接器归平台管理员：连接器是整台服务器共用的，接进来所有人的任务都会多出这批工具。请管理员在「连接器」页添加。", isError: true };
        }
        // 本地进程的连接器就是一条命令（批了当场起，以后每次开机再起一遍）：组织关了命令行，这儿不能是后门
        if (String(input.command || "").trim() && orgBlocksShell()) {
          security.audit("命令拦截", "add_connector（本组织已关闭「允许运行命令行」）", "拦截");
          return { content: "本组织在企业管理后台关闭了「允许运行命令行」，本地进程的连接器（填 command 的）加不了；远程的（填 url 的）不受影响。确实要用，找组织管理员开。", isError: true };
        }
        const mcpLib = require("./mcp");
        const host = connectorHost || diskConnectorHost;
        if (!!String(input.url || "").trim() === !!String(input.command || "").trim()) {
          return { content: "url 和 command 要二选一：远程的填 url（Key 放 headers），本地进程填 command + args（Key 放 env）", isError: true };
        }
        // 报错原文里可能回显着刚传进来的 Key：给模型看之前一律先洗
        let plan;
        try { plan = await host.prepare(input); } catch (e) { return { content: `连接器没加：${mcpLib.scrubText((e && e.message) || e, input)}`, isError: true }; }
        const { entry } = plan;
        const shown = mcpLib.redactServer(entry);
        const where = entry.url ? shown.url : [shown.command, ...(shown.args || [])].join(" ");
        // 远程的：试连那一下就是一次真请求（地址、请求头都发出去），跟 fetch_url 过同两道网络闸——
        // 组织的网络名单、安全中心的黑白名单。审计只记洗过的地址：地址里常拼着 key
        if (entry.url) {
          const orgNet = hostAllowed(null, entry.url);
          const g = orgNet.ok ? security.checkUrl(sec, entry.url) : { allowed: false, reason: "" };
          if (!g.allowed) {
            security.audit("网络拦截", `加连接器 ${entry.name}：${where}`, "拦截");
            return {
              content: orgNet.ok
                ? `连接器没加，安全中心拦下了：${g.reason}（设置 → 安全中心 → 网络安全）`
                : `连接器没加：${orgNet.why}。要放行找组织管理员改「企业设置 → 网络设置」。`,
              isError: true,
            };
          }
        }
        const over = plan.exists && !plan.same; // 同名同配置 = 重连一下，不算覆盖
        const warn = plan.findings || [];
        const mode = security.permissionMode(sec);
        let verdict = security.checkWrite(sec, `config.json#mcp_servers/${entry.name}`); // 只看不动 → 拒，不摆卡
        // 本地的：它就是一条命令，命令闸那套（文件黑名单、高危、删除保护、询问名单）照查。以前这条路一张卡不弹，
        // sh -c 里藏一句 rm、cat 私钥都直接跑了，stderr 还原样回到模型手里。
        // 跟 run_shell 不同的是批了就长驻、存进连接器页后每次开机还会再起，所以除了全自动，一律要人点头
        let cmdLine = "", cmdAsk = null;
        if (!entry.url) {
          cmdLine = [entry.command, ...entry.args].map(shellArg).join(" ");
          let cv = security.checkCommand(sec, cmdLine);
          // 名单外先判一句只在全自动有用（别的档反正要问）；发给判断模型的只给洗过的那行
          if (cv.action === "allow" && mode === "full") cv = await judgeRisk(cv, "命令", where);
          // 「哪一段触发的」要摆上卡、写进回话：那一段可能就夹着 Key，先洗
          if (cv.action !== "allow") cv = { ...cv, seg: mcpLib.scrubText(cv.seg || "", entry), ruleKey: "" };
          if (cv.action === "deny" && verdict.action !== "deny") verdict = cv;
          else if (cv.action === "ask") cmdAsk = cv;
        }
        // 跟 install_skill 一个尺子：每步都问照问；远程的新加直接加，盖掉已有的、体检有提醒的要点头。
        // ruleKey 留空：批过「这类都允许」的写文件、命令，不该顺带把加连接器也放了
        if (verdict.action !== "deny" && (cmdAsk || mode === "ask" || over || warn.length || (cmdLine && mode !== "full"))) {
          const why = cmdAsk ? cmdAsk.rule
            : over ? `覆盖已有连接器「${entry.name}」`
            : warn.length ? "连接器体检有提醒"
            : cmdLine ? "加本地连接器（会起一条命令，开机还会再起）" : "加连接器";
          verdict = { action: "ask", rule: why, seg: cmdAsk ? cmdAsk.seg : entry.name, ruleKey: "" };
        }
        // 覆盖时没给请求头 / 环境变量、又还是发往同一处：原来的 Key 沿用了（见 mcp.js sameTarget），卡上得照实说
        const kept = plan.exists && (entry.url
          ? !(input.headers && typeof input.headers === "object") && Object.keys(entry.headers || {}).length > 0
          : !(input.env && typeof input.env === "object") && Object.keys(entry.env || {}).length > 0);
        // 卡上的地址、命令都是洗过的；请求头和环境变量只给键名
        const detail = [
          `名字：${entry.name}`,
          entry.url ? `地址：${shown.url}` : `命令：${where}`,
          shown.headers ? `请求头：${Object.keys(shown.headers).join("、")}（${kept ? "沿用原来的值，" : ""}值不显示）` : "",
          shown.env ? `环境变量：${Object.keys(shown.env).join("、")}（${kept ? "沿用原来的值，" : ""}值不显示）` : "",
          over ? (kept ? "\n会替换现有的同名连接器：地址、命令换成这份，Key 沿用原来的。" : "\n会替换现有的同名连接器：原来的地址、命令和 Key 都换成这份。") : "",
          ...warn.slice(0, 5).map((f) => `\n体检提醒：${mcpLib.scrubText(f.why || f.rule || "", entry)}`),
        ].filter(Boolean).join("\n");
        const refused = await passGate(verdict, "加连接器", `${entry.name} · ${where}`, { force: true, detail });
        if (refused) {
          // 问了没批：通用那句「请用户预先放行这类」对这张卡不成立（ruleKey 是空的），换成真走得通的那条路
          if (verdict.action === "ask") return { content: "没加：这一步要人点头，没拿到同意（被拒、等超时，或者当时没人能批）。可以请用户到「连接器」页自己添加，那里填 Key、看体检结果都方便。", isError: true };
          return refused;
        }
        if (cmdLine) {
          // 用户配的 before_shell 钩子管的是「跑什么命令」：换个工具起进程不该绕开它
          const hookSays = await HK.beforeShell(opts.hooks, cmdLine, { cwd: fileBase, stopSignal: opts.stopSignal });
          if (hookSays) {
            security.audit("命令执行", `加连接器 ${entry.name}：${where}`, "钩子拦截");
            // 钩子的输出可能把整条命令念回来：按这台的 Key 原值换掉再给模型（不截断，钩子的理由要留全）
            return { content: mcpLib.secretValues(entry).reduce((s, v) => s.split(v).join("***"), hookSays), isError: true };
          }
        }
        security.audit(cmdLine ? "命令执行" : "网络访问", `加连接器 ${entry.name}：${where}`, "放行");
        let st;
        try { st = await host.commit(entry); } catch (e) { return { content: `连接器没加：${mcpLib.scrubText((e && e.message) || e, entry)}`, isError: true }; }
        const was = plan.exists ? "（替换了原来的同名连接器）" : "";
        if (st.disabled) {
          return { content: `连接器「${entry.name}」已存进连接器页${was}，但它在那儿是关着的，这次没连。要用就请用户在连接器页把它打开。`, isError: false };
        }
        if (st.connected) {
          const names = st.tools.slice(0, 20).join("、") + (st.tools.length > 20 ? " 等" : "");
          return {
            content: `连接器「${entry.name}」已加好并连上${was}，带来 ${st.tools.length} 个工具${st.tools.length ? "：" + names : ""}。` + (st.note || "接下来可以直接调。"),
            isError: false,
          };
        }
        // 原文照抄，不替人猜原因（猜错了比不说更耽误事）；server 那边已经洗过，这里再洗一遍不嫌多
        return {
          content: `连接器「${entry.name}」已存进连接器页${was}，但没连上。原文：${mcpLib.scrubText(st.error || "没拿到原因", entry)}\n` +
            "把原文照实告诉用户。改好了可以再调一次 add_connector 覆盖，或者请用户到连接器页里改。",
          isError: true,
        };
      }
      // 品牌档案认的是项目根（ws），不是本对话的成果子目录：档案跟着项目走，每个对话都该读到同一份；
      // 要查的成稿、要带进档案的素材仍按 resolveFile 从成果子目录起算
      case "brand_kit_read":
      case "brand_kit_save":
        return await require("../domains/content/brand-kit").runTool(name, input, { root: ws(), resolveFile, passGate, readBefore, diffText, security, sec, onProgress: opts.onProgress });
      case "library_list":
        return { content: libraryList(), isError: false };
      case "library_read": {
        const r = libraryRead(input.name);
        return { content: r.text, isError: r.bad };
      }
      case "library_import": {
        // 落点是本对话的成果子目录，跟 write_file / fetch_url 下载一致：
        // 复制进来的素材和它产出的东西待在同一个目录里，交付时才是完整一包
        const r = libraryImport(input.name, fileBase);
        return { content: r.text, isError: r.bad };
      }
      case "look_at_image":
        return await withStop(opts, (stop) => viaMedia("vision", opts, input, () => lookAtImage(opts, input, timeoutMs, resolveFile, stop)));
      case "generate_image": {
        const g = quotaGate("image", { model: input.model, units: unitsFor("image", input) });
        if (g.bad) return g.bad;
        return await withStop(opts, (stop) => viaMedia("image", opts, input, () => withGenCache("generate_image", "image", opts, input, fileBase, resolveFile, g.hold,
          () => generateImage(opts.media, input, timeoutMs, fileBase, resolveFile, stop))));
      }
      case "generate_video": {
        const g = quotaGate("video", { model: input.model, units: unitsFor("video", input, null, opts.media) });
        if (g.bad) return g.bad;
        return await withStop(opts, (stop) => viaMedia("video", opts, input, () => withGenCache("generate_video", "video", opts, input, fileBase, resolveFile, g.hold,
          () => generateVideo(opts.media, input, { ...opts, saveDir: fileBase, resolveFile, signal: stop }))));
      }
      case "html_to_image":
        // 单张原样交给 media.htmlToImage；html_files[] 批量一张张串行截，每张报一次进度
        return await withStop(opts, (stop) => require("../tools/motion").htmlToImageBatch(input, resolveFile, fileBase, { signal: stop, onProgress: opts.onProgress }));
      case "render_motion":
        // 本机浏览器 + ffmpeg，不花钱：不过 quotaGate，也不进生成缓存（同一页渲两次本来就逐帧一样）
        return await withStop(opts, (stop) => require("../tools/motion").renderMotionTool(input, resolveFile, fileBase, { signal: stop, onProgress: opts.onProgress, deadline: opts.deadline }));
      case "compose_video":
        // 本机 ffmpeg 拼盘上已有的文件，不花钱：不过 quotaGate、不进生成缓存。
        // 不套 withStop：任务可能比这次调用活得久（先交任务号），停止信号 / 截止时间 / 进度 / 会话 id 由 compose.js 从 opts 里自己接
        return await require("../tools/compose").composeVideo(input, { resolveFile, fileBase, opts, security, sec, passGate, root: ws() });
      case "delivery_page":
        // 本机读清单、ffprobe 量画幅、写一页 html，不花钱：不过 quotaGate、不进生成缓存。
        // dir 用本对话的成果子目录：清单里的相对路径、页面里的 <video src> 都以它为根
        return await withStop(opts, (stop) => require("../domains/content/delivery-page").runTool(input, { dir: fileBase, signal: stop, onProgress: opts.onProgress }));
      case "text_to_speech": {
        // 按句配音：额度按「要新买的句子」在里面问、缓存逐句记，不走下面整段那套 quotaGate / withGenCache
        if (input && input.segments !== undefined) {
          return await withStop(opts, (stop) => viaMedia("tts", opts, input, () => TTSB.ttsSegments({
            media: opts.media, input, timeoutMs, saveDir: fileBase, resolveFile, wsRoot: ws(), stop,
            gate: (c) => quotaGate("tts", c), onProgress: opts.onProgress,
          })));
        }
        const g = quotaGate("tts", { model: input.model, units: unitsFor("tts", input) });
        if (g.bad) return g.bad;
        return await withStop(opts, (stop) => viaMedia("tts", opts, input, () => withGenCache("text_to_speech", "tts", opts, input, fileBase, resolveFile, g.hold,
          () => textToSpeech(opts.media, input, timeoutMs, fileBase, stop))));
      }
      case "transcribe_audio": {
        const mins = unitsFor("asr", input, resolveFile);
        const g = quotaGate("asr", { model: input.model, units: mins });
        if (g.bad) return g.bad;
        let r;
        try {
          r = await withStop(opts, (stop) => viaMedia("asr", opts, input, () => transcribeAudio(opts.media, input, timeoutMs, resolveFile, fileBase, stop)));
        } catch (e) {
          quota.undo(g.hold);   // 停了 / 炸了都没交付，预扣退回去
          throw e;
        }
        if (!r.isError) {
          quota.record("asr", {
            provider: mediaProviderOf(opts.media, "asr", input.model), model: asrModelOf(opts.media, input.model),
            units: mins, meta: String(input.path || input.file || "").slice(0, 80), hold: g.hold,
          });
        } else {
          quota.undo(g.hold);
        }
        return r;
      }
      case "desktop_pet": {
        // 真正的活儿在 server.js（那儿才同时握着 config、data/ 和活着的 Electron 窗口），这里只转发
        if (!global.__openworkbuddyPetTool) return { content: "桌面宠物功能没装起来（服务端未注册 desktop_pet 的实现）。", isError: true };
        return await global.__openworkbuddyPetTool.run(input, fileBase);
      }
      // render_page 是 fetch_url 的兼容别名，执行时统一走同一套渲染逻辑。
      // 这条 case 留着不是为了将来：还活着的 CLI 会话、外部 MCP 客户端、历史排期任务里都可能
      // 还攥着这个名字，落到 default 分支只会得到一句"未知工具"加一个猜出来的名字。
      // 关键是它必须走同一道安全闸——绕开 checkUrl 的别名等于给黑名单开了个后门。
      case "fetch_url":
      case "render_page": {
        const orgNet = hostAllowed(null, input.url);
        if (!orgNet.ok) return netBlocked(input.url, orgNet.why);
        const fg = quotaGate("fetch");
        if (fg.bad) return fg.bad;
        const gate = security.checkUrl(sec, input.url);
        if (!gate.allowed) {
          security.audit("网络拦截", input.url, "拦截");
          return { content: `网络访问被安全中心拦截：${gate.reason}（设置 → 安全中心 → 网络安全）`, isError: true };
        }
        // 老名字的语义就是"必须渲染"；新参数里 render 只认三个值，其余（含老的布尔 false）交给 fetchUrl 归一化
        const mode = name === "render_page" ? "force" : input.render;
        security.audit("网络访问", `${mode === "force" ? "浏览器渲染" : "网络访问"}已执行：${input.url}`, "放行");
        const page = await fetchUrl(input.url, { render: mode, waitMs: input.wait_ms, saveDir: fileBase });
        quota.record("fetch", { provider: mode === "force" ? "render" : "http", meta: String(input.url).slice(0, 120) });
        return { content: page, isError: false };
      }
      case "web_search": {
        // 预估拿「配置里排头的那家」算。真正答上来的可能是接力的下一家（首选被限流了），
        // 那不影响对错——结算那一步在 webSearch 里按**真答上来的那家**记。
        const g = quotaGate("search", { provider: (opts.search && opts.search.provider) || "bocha" });
        if (g.bad) return g.bad;
        security.audit("网络访问", `联网搜索：${input.query}`, "放行");
        try {
          const hits = await webSearch(input.query, input.count, opts.search, g.hold);
          return { content: hits, isError: false };
        } catch (e) {
          quota.undo(g.hold);
          throw e;
        }
      }
      default: {
        // 模型常把 MCP 工具的前缀吃掉（调 directory_tree 而不是 mcp__filesystem__directory_tree），
        // 真实数据里这一种拼错白烧了 4 轮模型调用。光说「未知工具」它只能接着瞎猜，把最像的真名给它。
        const guess = nearestTool(name, opts.knownTools);
        return { content: `未知工具: ${name}` + (guess ? `。你是不是想调 ${guess}？工具名必须一字不差地写全。` : ""), isError: true };
      }
    }
  } catch (e) {
    // 用户点了停止，底下的 fetch 被掐断抛上来的多半是一句「This operation was aborted」——
    // 照原样转成「工具执行出错」，模型会以为是故障、换个参数重来，那正是停止要拦的
    if ((opts.signal && opts.signal.aborted) || (opts.stopSignal && opts.stopSignal.aborted)) {
      return { content: "用户已停止任务，这一步没做完。", isError: true, stopped: true };
    }
    // submitted：视频上游已经收下了那一单才出的错（见 generateVideo），带出去让画布别自动补枪
    return { content: `工具执行出错: ${e.message}`, isError: true, ...(e && e.submitted ? { submitted: String(e.submitted) } : {}) };
  }
}

/**
 * 媒体调用这一趟用的停止信号：直调接口传进来的 ctx.signal 和 agent 任务的 stopSignal 合成一路。
 * 每次调用单独合一个、调完就摘——挂在任务级 stopSignal 上的监听要是不摘，
 * 一个短剧任务生几十张图就挂几十个，Node 满 10 个就开始刷警告。
 */
async function withStop(opts, fn) {
  const stop = anySignal(opts.signal, opts.stopSignal);
  try { return await fn(stop); } finally { stop.release(); }
}

const FILES_CAP = 500;
// 遍历的硬保险。截断必须发生在**按时间排完序之后**（见 outputFiles），所以得先把整棵树走完；
// 这个数是防「有人把几万个文件扔进工作目录」时把一次 emitFiles 卡住，不是产出上限。
const WALK_CAP = 20000;

/**
 * 产出列表的「坐标系指纹」。
 *
 * outputFiles() 给的 name 全是**相对工作目录**的路径，换一个工作目录就是换一套坐标系：
 * 「格局图.png 不在这份列表里」在新目录下永远成立，可它说明不了旧目录里那张图有没有被删。
 * 前端就是拿它判断「这份列表能不能用来给某个文件盖『已删除』」。
 *
 * 只发 8 位哈希、不发真实路径：这个字段会跟着会话一起存盘，用户的本地目录名不该写进
 * 可以分享出去的记录里。
 */
function workspaceKeyOf(dir) {
  return require("crypto").createHash("sha1").update(String(dir || "")).digest("hex").slice(0, 8);
}
function workspaceKey() {
  return workspaceKeyOf(getWorkspaceDir());
}

/** files 事件统一带上的作用域信息：哪套坐标系（root）、这份清单是不是完整的（full，到 500 条会截断） */
function filesScope(files) {
  return { root: workspaceKey(), full: (files || []).length < FILES_CAP };
}

/**
 * 列出 workspace 下的文件（含子目录，最深 3 层、最多 500 条；name 为相对路径。
 * 前端按目录分组展示，@ 补全同源）。
 *
 * 截断按**时间**，不按目录遍历顺序——这条是踩过的坑，不是洁癖：
 * 以前 500 这个上限是在 walk 里判的（out.length >= FILES_CAP 就 return），排序在截断之后，
 * 于是「留下哪 500 个」由 readdir 的目录顺序决定，跟新旧毫无关系。用户的工作目录攒到 538 个
 * 文件那天，新建的任务目录整个落在被砍掉的 38 个里，后果是两处同时哑火：
 *   - 右侧成果文件面板里根本没有这个新文件夹
 *   - agent.js 的 emitFiles() 拿两份 outputFiles() 做差算「本回合改了哪些」，两份里都没有
 *     这些新文件，于是 changed 是空的，对话里那块「本回合产出」一张卡都不挂
 *
 * 文件明明都在磁盘上，界面却像什么都没发生——最该被看见的恰恰是刚写出来的那几个。
 *
 * 所以现在先把整棵树走完（WALK_CAP 兜底），按 mtime 倒序排完再切 500：无论工作目录攒了多少
 * 历史文件，最新的那批一定在列表里。filesScope() 会把 full=false 带出去，前端据此知道
 * 「这份清单不完整」，不拿它给旧产出盖「已删除」的章。
 *
 * 「本回合产出」现在不拿它做差了（最深 3 层，第 4 层往下的成品照样差不出来），改走下面的
 * turnSnapshot()；这份只管面板和 @ 补全。
 */
/**
 * 用户自己传进来的那些文件（输入框里粘的图、拖进来的素材）是**输入**，不是产出。
 *
 * 2026-09-18 的真实故障：一趟任务还在跑，用户粘了张图进输入框想追问，那张图当场出现在
 * 上一轮的「本回合产出」里。
 *
 * 根子在 /api/upload 把文件直接落进了这条会话的成果文件夹——那一步是对的，素材和成果待在
 * 一起，否则工作目录根下越堆越乱（真实数据里躺过 22 个）。可「本回合产出」的判据是
 * 「在我的文件夹里 + mtime 在开跑之后」，这张图两条全占：它确实是这个文件夹里刚出现的新
 * 文件，只是写它的人不是 agent，是用户自己。**谁写的这件事只有落盘那一刻知道**，事后从盘
 * 上看一个文件是看不出来的，所以只能在那一刻记一笔。
 *
 * 记「名字 + 那一刻的 mtime」而不是只记名字：agent 后来真把这张图改写了（抠图、压缩、换
 * 格式），mtime 一变就不再算输入——那时候它确实变成了产出，本来就该出现在卡片里。
 */
const userInputs = new Map(); // 「工作目录指纹 + 相对路径」 -> 落盘那一刻的 mtime
const USER_INPUT_CAP = 500;   // 只为了不让它无限长；超了从最老的丢，最坏结果是多报一张卡
// 分隔符写成转义 \u0000，不要直接敲一个真 NUL 字节进源码。
// 两者运行时一模一样，但文件里一旦有真 NUL，grep 就把整个 tools.js 当二进制文件：
// `grep -n look_at_image tools.js` 什么都不返回，也不报错。全项目最大的工具文件搜不到东西，谁都会以为是自己搜错了。
const userInputKey = (rel) => workspaceKey() + "\u0000" + String(rel || "").split(path.sep).join("/");
/** 落盘之后马上调：把「这份是用户传的」钉在那一刻的 mtime 上 */
function noteUserInput(rel) {
  try {
    const st = fs.statSync(safePath(rel));
    if (userInputs.size >= USER_INPUT_CAP) userInputs.delete(userInputs.keys().next().value);
    userInputs.set(userInputKey(rel), st.mtime.toISOString());
  } catch {} // 记不上只是少一道闸，不该让上传本身失败
}
/** 上传先落根目录、成果文件夹建好后再搬进去（见 server.js 的 assignSessionDir），搬完得改键 */
function moveUserInput(from, to) {
  const k = userInputKey(from);
  if (!userInputs.has(k)) return;
  const at = userInputs.get(k);
  userInputs.delete(k);
  let now = at;
  try { now = fs.statSync(safePath(to)).mtime.toISOString(); } catch {} // rename 不改 mtime，但不赌它
  userInputs.set(userInputKey(to), now);
}
/** @param {{name:string,mtime:string}} file outputFiles() 里的一项 */
function isUserInput(file) {
  if (!file || !file.name) return false;
  return userInputs.get(userInputKey(file.name)) === file.mtime;
}

function outputFiles() {
  ensureDirs();
  const all = [];
  // 跳哪些跟资料库「工作区」那一栏共用一份规矩：两边各抄一份，早晚一边列得出、另一边找不到
  const { skipEntry } = require("../domains/library/ws-browse");
  // 服务端自己的运行数据（im-log.json、audit.json、会话、审计、记忆向量…全在 data/ 下）不是
  // 用户的成果文件。工作目录指到工程上层时（workspace_dir 指到 ~/工程目录 这种层级），这批文件
  // 会被 walk 进「可交付列表」，两个后果：①IM 附件逻辑「回复里点名的文件自动附上」把内部日志
  // 发进了用户手机；②任务期间日志被写、mtime 变动，「本回合产出」也会把它们当成新产出。
  // data/ 只装运行状态、永远不会是交付物，整目录排除；用户自己项目里的 data/ 文件夹不受影响
  // （只排除「恰好等于 DATA_DIR/data」的那一个路径）。
  const APP_DATA_DIR = dataPath("data") + path.sep;
  (function walk(dir, rel, depth) {
    // IM_对话/、定时任务/ 下的成果文件夹本身占两层，多给一层（跟 agent.js scanTree 同一条规矩）
    if (depth > (/^(IM_对话|定时任务)(\/|$)/.test(rel) ? 4 : 3) || all.length >= WALK_CAP) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (all.length >= WALK_CAP) return;
      const full = path.join(dir, e.name);
      if (skipEntry(e.name, full, APP_DATA_DIR)) continue; // 点开头的、临时区、依赖、版本库、服务端运行数据目录：不算交付物
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, r, depth + 1);
      } else if (e.isFile()) {
        let st;
        try { st = fs.statSync(full); } catch { continue; } // 边走边被删的临时文件，跳过就是
        all.push({ name: r, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  })(ws(), "", 1);
  all.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return markDuplicates(all.slice(0, FILES_CAP));
}

/**
 * 「本回合改了哪些文件」专用的快照，不拿 outputFiles() 做差。
 *
 * outputFiles() 是给右侧面板和 @ 补全的：最深 3 层、最新 500 条。agent 往
 * 「任务_x/site/assets/img/」这种第 4 层往下写的成品，前后两份里都没有，差出来是空的——
 * 文件明明写了，对话里那块「本回合产出」一张卡都不挂。
 *
 * 这里走整棵树：跟资料库同一个 walkAll、同一套跳过规矩（点开头的、.tmp、node_modules、.git、
 * 应用自己的 data/）。只卡条数（WALK_CAP），不卡层数：资料库那条「最深 12 层」要是也用在这里，
 * 工作区里随便躺着一条老 Java 工程那种十几层的目录链，每一回合都会报 capped，界面天天挂着
 * 「可能没列全」，而这回合的产出其实一个没漏。链接不跟、成不了环，路径长度本身就封住了层数；
 * 花多少时间由条数上限管。条数撞了线才 capped:true 照实往外报，不装作看全了。
 *
 * 故意不用 walkAllCached：那份有 3 秒记忆，开跑那一刻的基线和几百毫秒后的比对落在同一个
 * 窗口里，第二份拿到的就是第一份，中间写的文件差不出来。
 *
 * 撞了上限、而这回合有自己的成果文件夹时，再单独把那个文件夹走一遍并进来：按层走的截断
 * 丢的是深处，而本回合的产出几乎都在自己文件夹里。补走完 capped 仍是 true——文件夹外面
 * 没走到的那部分照样可能有这回合写的东西。
 * @param {string} [baseDir] 本对话的成果子目录（相对工作目录），没有就是空
 * @returns {{ files: ReadonlyArray<{name:string,size:number,mtime:string}>, capped: boolean }}
 */
function turnSnapshot(baseDir) {
  ensureDirs();
  const { walkAll, skipEntry } = require("../domains/library/ws-browse");
  const root = ws();
  const appDataDir = dataPath("data");
  const opts = { appDataDir, maxDepth: Infinity }; // 不卡层数，见上
  const all = walkAll(root, opts);
  const segs = String(baseDir || "").split("/").filter(Boolean);
  if (!all.capped || !segs.length) return all;
  let cur = root;
  for (const s of segs) {
    cur = path.join(cur, s);
    if (s === ".." || skipEntry(s, cur, appDataDir)) return all; // 自己的文件夹本来就不列：不补，照实报 capped
  }
  const prefix = segs.join("/") + "/";
  const byName = new Map(all.files.map((f) => [f.name, f]));
  for (const f of walkAll(cur, opts).files) byName.set(prefix + f.name, { name: prefix + f.name, size: f.size, mtime: f.mtime });
  return { files: [...byName.values()], capped: true };
}

/**
 * 按名字查一批文件此刻的大小和 mtime，查不到的（删了、越界、不是文件）直接不要，新的在前。
 * 给手上已经有「本回合产出」名单的地方用（IM 回传附件、产出卡片补全）：再拿 outputFiles()
 * 过滤一遍的话，第 4 层往下、或者挤出最新 500 条的产出会被悄悄滤掉。
 * @param {Iterable<string>} names 相对工作目录的路径
 * @returns {{name:string,size:number,mtime:string}[]}
 */
function statOutputs(names) {
  const out = [];
  const seen = new Set();
  for (const n of names || []) {
    const name = String(n || "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let st;
    try { st = fs.statSync(safePath(name)); } catch { continue; }
    if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtime.toISOString() });
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
}

/**
 * 标出根目录里那些「跟子目录某个文件逐字节相同」的副本。
 * 来历见 savedAt 那段：工具回执只报文件名，模型照着去根目录找不着，就 cp 一份过去，
 * 于是一份成果在面板里显示两遍。这类副本是可证明冗余的——原件还在成果文件夹里躺着。
 * 先按大小撞车再算哈希：500 个文件全量哈希太贵，而大小不同的一定不是同一份。
 */
// 内容哈希缓存。键里带了大小和 mtime——文件一动键就变，所以永远读不到过期的哈希。
// 为什么非缓存不可：这段挂在 outputFiles() 上，而 outputFiles() 每来一个工具结果就跑一次。
// 实测用户那个工作目录（500 条、27 个根目录散件）一次要 readFileSync 进 6.48 MB、耗 4.7ms，
// 占了整个 outputFiles() 的一半；一趟 100 步的任务就是把同一批没变过的文件反复读 650 MB。
// 读盘是同步的，那几毫秒里整条事件循环停着 —— 用户看到的就是「中间一顿一顿的」。
const digestCache = new Map();
const DIGEST_CACHE_CAP = 2000;
function fileDigest(f) {
  // 工作目录名进键：name 是相对路径，换个工作目录就是另一套坐标系，不带它会跨目录串味
  const key = `${ws()}\u0000${f.name}|${f.size}|${f.mtime}`;
  const hit = digestCache.get(key);
  if (hit) return hit;
  const d = require("crypto").createHash("sha1").update(fs.readFileSync(path.join(ws(), f.name))).digest("hex");
  // 上限只是防无限涨（长跑 + 反复换工作目录）：满了整份丢掉重算，比维护 LRU 简单，代价也就是一次冷启动
  if (digestCache.size >= DIGEST_CACHE_CAP) digestCache.clear();
  digestCache.set(key, d);
  return d;
}

function markDuplicates(out) {
  const bySize = new Map();
  for (const f of out) {
    if (!f.name.includes("/") || !f.size) continue; // 0 字节文件人人相同，那不叫重复
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  for (const f of out) {
    if (f.name.includes("/") || !f.size || !bySize.has(f.size)) continue;
    let mine;
    try { mine = fileDigest(f); } catch { continue; }
    for (const c of bySize.get(f.size)) {
      try { if (fileDigest(c) === mine) { f.dup_of = c.name; break; } } catch {}
    }
  }
  return out;
}

// ---------- add_connector 的落地方 ----------
/**
 * server 起来时把它那套塞进来（server.js main 里 setConnectorHost）：跟连接器页保存同一个
 * normalizeMcpServer、同一条重连队、同一次 saveConfig。prepare 只校验不落盘，批了才 commit。
 * 没塞（命令行引擎借工具的桥进程、单测）就用下面的 diskConnectorHost。
 */
let connectorHost = null;
function setConnectorHost(h) {
  connectorHost = h || null;
}

/**
 * 本地连接器的 command + args 拼成一行给命令闸看。带空格、引号的参数包成单引号：
 * 不包的话 sh -c '…' 里那几段，命令闸拆不出来，里面藏的 rm 就看不见
 */
function shellArg(a) {
  const s = String(a);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 连接器配置的校验，规则跟 server.js 的 normalizeMcpServer 一致。
 * 那份要原样留在 server.js（e2e 按源码抠出来单独跑），桥进程又够不着 server.js，只好在这儿再写一份；
 * test/perm-gate.js 拿同一批输入对照两边的判定，哪边改了另一边没跟上会红。
 */
function checkConnector(s, prev) {
  const name = String((s && s.name) || "").trim();
  if (!name) throw new Error("连接器缺少 name");
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`连接器 name「${name}」只能用字母、数字、- 和 _（工具名要按 mcp__服务器__工具 拼）`);
  const url = String(s.url || "").trim();
  const command = String(s.command || "").trim();
  if (!command && !url) throw new Error("要么填 command（本地进程），要么填 url（远程 Streamable HTTP）");
  const strs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k), String(v)]));
  if (url) {
    let u;
    try { u = new URL(url); } catch { throw new Error("url 不是合法地址"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("url 只支持 http/https");
    // 没给请求头就沿用原来那份：模型改个地址，不该顺手把令牌洗没
    const headers = s.headers && typeof s.headers === "object" ? strs(s.headers) : (prev && prev.headers) || {};
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
    if (Object.keys(headers).length && u.protocol === "http:" && !local) {
      throw new Error("带了请求头（多半是令牌）却走明文 http，令牌会在路上被看光——请改成 https");
    }
    return { name, transport: "streamable-http", url, headers };
  }
  const env = s.env && typeof s.env === "object" ? strs(s.env) : (prev && prev.env) || {};
  for (const k of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`环境变量名「${k}」不合法（只能字母、数字、下划线，不能以数字开头）`);
  return { name, transport: "stdio", command, args: Array.isArray(s.args) ? s.args.map(String) : [], env };
}

/** 读 config.json 原文。读不成就抛：这一路是要写回去的，拿一份空的当底写回去等于把整份配置抹了 */
function readConfigStrict(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e && e.code === "ENOENT") return {};
    throw e;
  }
  const j = JSON.parse(raw);
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("config.json 不是一个 JSON 对象");
  return j;
}

/**
 * 没有 server 在同一个进程里时加连接器：自己校验、自己试连一次、直接写 config.json。
 * 正在跑的 server 盯着这个文件，几秒内就把新连接器认进去并连上（见 server.js 的 pollConfig），
 * 连接器页上看得见。写之前重读一遍磁盘：等审批那会儿别人可能也改过，只替换这一条。
 */
const diskConnectorHost = {
  async prepare(input) {
    const file = dataPath("config.json");
    let disk;
    try { disk = readConfigStrict(file); } catch (e) { throw new Error(`config.json 现在读不成，没敢动它：${(e && e.message) || e}`); }
    const list = Array.isArray(disk.mcp_servers) ? disk.mcp_servers : [];
    const want = String((input && input.name) || "").trim();
    const prev = list.find((s) => s && s.name === want) || null;
    // 原来的 Key 只在还发往同一处时沿用，跟 server.js connectorPrepare 一个规矩（见 mcp.js sameTarget）
    const entry = checkConnector(input || {}, require("./mcp").sameTarget(prev, input || {}) ? prev : null);
    let owner = null;
    try { owner = require("../core/ext/plugins").pluginMcpServers().find((s) => s.name === entry.name); } catch { /* 插件坏了照样能加自己的 */ }
    if (owner) throw new Error(`「${entry.name}」这个名字已经被插件 ${owner.plugin || ""} 的连接器占了，换个名字`);
    let findings = [];
    try {
      const rep = require("../core/safety/toolward").scanConnectors([entry], disk);
      findings = (rep && rep.findings) || [];
    } catch (e) { console.warn(`[MCP] 连接器体检没跑成（不影响添加）: ${(e && e.message) || e}`); }
    const { cfgFingerprint } = require("./mcp");
    return { entry, exists: !!prev, same: !!prev && cfgFingerprint(prev) === cfgFingerprint(entry), findings };
  },
  async commit(entry) {
    const { McpClient, scrubText } = require("./mcp");
    const store = require("../platform/store");
    const file = dataPath("config.json");
    const disabled = (() => { try { return (readConfigStrict(file).mcp_disabled || []).includes(entry.name); } catch { return false; } })();
    let tools = [], error = "";
    if (!disabled) {
      const c = new McpClient(entry.name, entry);
      try { tools = await c.start(20000); } catch (e) { error = scrubText((e && e.message) || e, entry) || "连接失败，没拿到原因"; } finally { try { c.stop(); } catch {} }
    }
    let disk;
    try { disk = readConfigStrict(file); } catch (e) { throw new Error(`config.json 现在读不成，没敢写：${(e && e.message) || e}`); }
    const list = (Array.isArray(disk.mcp_servers) ? disk.mcp_servers : []).filter((s) => !(s && s.name === entry.name));
    const at = (Array.isArray(disk.mcp_servers) ? disk.mcp_servers : []).findIndex((s) => s && s.name === entry.name);
    list.splice(at < 0 ? list.length : at, 0, entry);
    disk.mcp_servers = list;
    store.writeJsonAtomic(file, disk, { pretty: true, mode: store.SECRET_MODE });
    return {
      name: entry.name, disabled, connected: !disabled && !error,
      tools: (tools || []).map((t) => `mcp__${entry.name}__${t.name}`), error,
      // 命令行引擎的连接器是开跑时挂上去的：这一趟会话挂不上新的，下一个任务才有
      note: "这次会话里还调不到它的工具，下一个任务起就有。",
    };
  },
};

module.exports = {
  _internals: { setDepsAppDir: (d) => { depsAppDir = d; }, depsGuardEnv, searchBodyError, searchHttpError, toItems, pickHits, SEARCH_HTTP_HINT, searchFiles, readBigFile, SEARCH_BUDGET, SEARCH_SKIP, SEARCH_BIN_EXT, selfCheck, execCheck, extCheck, EXT_CHECK_MAX, openHiddenWeb, hiddenWeb, WEB_PARTITION, checkPage, runShell, runNode, startBackground, trackBgGroup, noteStray, strays, psRows, verifiedPgids, reapStrays, reapStraysAtExit, strayFile, saveStrays, auditHtml, savedAt, markDuplicates, pickShell, winTextEnv, fetchRetry, nearestTool, viaMedia, lookAtImage, pickEye, mainCanSee, shrinkForVision, readImageInput, refImageUris, I2V_RE, T2V_RE, isRuntimeNoise, readConsoleEvent, cleanConsoleText, generateImage, generateVideo, textToSpeech, mediaKey, unitsFor, anySignal, sleepFor, videoPlan: mediaModels.videoPlan, editFile, planEdit, planMulti, diffText, looseLineMatch, missHint, badToolArgs, safeOutName, OUT_EXT_ALIAS, missingBinHint, NOT_FOUND_RE, WIN_PYTHON_HINT, runsPython, winPython3Shim, winStoreStub, shCheckBin, SH_ENV_NOISE, reapBgJob, pdfHowTo, underRoot, winCanonCase, transcribeAudio, srtTime, AUDIO_EXT, ASR_MAX_BYTES, docToText, slidesToText, sheetsToText }, TOOL_DEFS, executeTool, ownRootFiles, releaseRun, holdRun, runHeld, reapLeftoverStrays, badToolArgs, outputFiles, turnSnapshot, statOutputs, noteUserInput, moveUserInput, isUserInput, workspaceKey, workspaceKeyOf, filesScope, safePath, safePathIn, fetchUrl, renderPage, htmlToText, getWorkspaceDir, getDefaultWorkspaceDir, setWorkspaceDir, withWorkspace, enterWorkspace, setLibraryDir, getLibraryDir, withLibraryDir, libRoot, withLibraryBase, libBase, notesFileOf, LIB_DIR, withPolicy, orgPolicy, hostAllowed, SEARCH_PROVIDERS, searchProviderKey, searchProviderReady, shellPath, canvasReadState, canvasWriteState, canvasNormalizeState, canvasList, canvasSetCurrentName, canvasManage, canvasSafeName, setConnectorHost, checkConnector };
