"use strict";
/**
 * Agent 技能工具集 — 全部在 workspace 目录内操作。
 * run_node 是核心：agent 写 JS 代码生成 PPT/Word/Excel/图表/数据处理结果。
 */

const fs = require("fs");
const path = require("path");
const { DATA_DIR, dataPath, appPath } = require("./paths");
const { spawn, spawnSync } = require("child_process");
const { StringDecoder } = require("string_decoder");
const security = require("./security");
const memory = require("./memory");
const mediaModels = require("./media-models"); // 图/视频/语音/视觉的多模型选择（同一把 Key 配多个型号）
const genCache = require("./gen-cache"); // 生图/生视频/配音的内容寻址缓存：同一格重跑不再烧第二次钱
const cdp = require("./cdp"); // 可选的本机 Chrome CDP：不捆绑浏览器、不连接远程地址
const quota = require("./quota"); // 按次计费的第三方 API：调之前问一句额度，调完记一笔
const mediaHealth = require("./media-health"); // 连不通的渠道熔断：撞过的硬错下次连请求都不发
const checkpoints = require("./checkpoints"); // 改文件前留检查点：整步能退回去，审批卡上先看 diff

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
function setWorkspaceDir(dir) {
  if (!dir || !path.isAbsolute(dir)) throw new Error("工作空间必须是绝对路径，如 D:\\我的工作区");
  fs.mkdirSync(dir, { recursive: true }); // 无权限/非法路径会在这里抛错
  workspaceDir = path.resolve(dir);
  return workspaceDir;
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
  if (p !== ws() && !p.startsWith(ws() + path.sep)) {
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
  if (p !== base && !p.startsWith(base + path.sep)) {
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
        start_line: { type: "number", description: "从第几行开始读（1 起，可选）" },
        end_line: { type: "number", description: "读到第几行为止（含，可选）" },
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
  // 的一个参数：render:"force"。render_page 这个名字仍然能调（见 executeTool），但不在工具清单里了。
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
      "用真 Chrome 打开网页并操作它。要截网页效果图、要看 JS 渲染完的样子、要点开某个交互再看结果，都用这个，不用先问用户开没开调试端口——端口上没人应答时会自己拉起一个专用 Chrome（独立 user-data-dir，不碰你日常浏览器的登录态），端口由它自己挑，不跟别的程序抢。只连 127.0.0.1/localhost/::1。\n" +
      "action：list_tabs 列标签页；navigate 打开 URL（默认等页面加载完再返回）；screenshot 截图存到 workspace，full_page=true 截整页，width/height 指定视口；inspect 读页面文字；click/type 按 CSS 选择器操作；evaluate 执行页面内 JavaScript；close_tab 关标签页；status 看当前接的是哪个 Chrome。\n" +
      "接手用户已经开着的浏览器要给 port；不给就用本工具自己那一个。WebGL/Canvas 页面照样能截。服务器部署时 Chrome 要跟 Agent 在同一台机器，别把调试端口暴露到公网。",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list_tabs", "inspect", "navigate", "click", "type", "evaluate", "screenshot", "close_tab", "status"] },
        tab_id: { type: "string", description: "Chrome 标签页 id；不给就用当前第一个页面标签页" },
        port: { type: "number", description: "本机 CDP 端口。只在接管用户自己启的 Chrome 时给；不给就用本工具自己拉起的那个" },
        selector: { type: "string", description: "inspect/click/type 的 CSS 选择器" },
        text: { type: "string", description: "type 要输入的内容" },
        url: { type: "string", description: "navigate 要打开的 URL" },
        expression: { type: "string", description: "evaluate 要执行的页面 JavaScript" },
        path: { type: "string", description: "screenshot 保存到 workspace 的相对路径，默认 chrome-screenshot.png" },
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
  // 桌面版保留旧名字作为显式「强制浏览器渲染」入口，兼容已经在跑的会话和旧版 CLI；
  // 纯 node 模式由 agent.js 的 DESKTOP_ONLY_TOOLS 摘掉。新任务优先用 fetch_url 的 render:force；
  // render_page 作为兼容别名保留，避免旧技能和已有会话突然失效。
  {
    name: "render_page",
    description: "用内置浏览器真实打开一个页面、等 JavaScript 渲染完再取正文。只在桌面版可用；服务端模式请用 fetch_url 的静态结果或直接找数据接口。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        wait_ms: { type: "number", description: "等待渲染的毫秒数，默认 2500，范围 500~8000" },
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
        model: { type: "string", description: "模型名（可选）。设置里这一路可能配了好几个，不写就用默认那个；想点名用哪个就照设置里的名字写。名字写错会直接报错并列出可选项，不会偷偷换成别的。" },
        no_cache: { type: "boolean", description: "强制重新生成（可选）。给了 filename 的调用，参数完全一样时会直接复用上一次的产物、不再花钱；确实要换一版不一样的，把这个设成 true。" },
      },
      required: ["text"],
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
];

// ---------- 图像 / 视频 生成（渠道协议：OpenAI 兼容 images API、DashScope 原生、火山方舟异步任务） ----------

/**
 * 同一类产出里「也认」的后缀。
 *
 * 以前只认默认那一个：模型要 fig_a.jpg，落盘成了 fig_a.jpg.png——
 * 接着它按自己要的名字写 <img src="fig_a.jpg">，一整页图全是裂的。
 * 七张图里它自己手工补救了一张，剩下六张就那么裂着。
 *
 * 所以同类后缀一律照模型要的来。PNG 的字节叫 .jpg 没关系——<img> 是嗅探内容解码的，
 * 照样渲染得出来；**名字对不上**才是真的打不开。跨类的（要 .jpg 却给 .txt）还是照旧补后缀。
 */
const OUT_EXT_ALIAS = {
  ".png": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"],
  ".mp4": [".mp4", ".mov", ".webm", ".m4v"],
  ".mp3": [".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav"],
  ".wav": [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac"],
};
/**
 * 兜底文件名用的时间戳，同一毫秒里绝不发第二次同样的数。
 *
 * 生图 / 生视频 / 配音的 filename 都是可选的，不给就按 `image_时间戳.png` 兜底。
 * 以前这三个工具是一条条串行跑的，Date.now() 天然错不开；现在同一批里能并发两条，
 * 两张图在同一毫秒返回就会写同一个文件名——后写的把先写的盖掉，而界面上两张卡都报成功，
 * 这种错不留任何痕迹。所以撞上同一毫秒就往后缀上接 _2、_3。
 *
 * 注意这只管「模型没起名」那一路。模型点名要某个文件名时照旧覆盖：那是它自己要的，
 * 「重新生成刚才那张」正是靠覆盖实现的，替它改名反而会让正文里的引用全指空。
 */
let lastStamp = 0, stampDup = 0;
function stampOnce() {
  const t = Date.now();
  if (t === lastStamp) stampDup++;
  else {
    lastStamp = t;
    stampDup = 0;
  }
  return stampDup ? `${t}_${stampDup + 1}` : String(t);
}

function safeOutName(name, ext, stem) {
  let n = String(name || "").trim().replace(/[\/\\:*?"<>|]/g, "_").slice(0, 80);
  if (!n) n = `${stem}_${stampOnce()}${ext}`;
  const ok = OUT_EXT_ALIAS[ext] || [ext];
  const low = n.toLowerCase();
  if (!ok.some((e) => low.endsWith(e))) n += ext;
  return n;
}

/**
 * 只重试「重来一次可能就好」的失败：5xx、429、以及网络层的连接错误。
 * 4xx 是参数错、没余额、内容被拒——重试多少次都是同一个答案，立刻返回。
 * 超时（AbortError）也不重试：那是上面设的总时限已经到了，再发一次只会立刻再失败。
 */
const retryableStatus = (s) => s === 429 || (s >= 500 && s < 600);
async function fetchRetry(url, init, { tries = 3, baseMs = 1500, label = "接口" } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1)));
    try {
      const r = await fetch(url, init);
      if (r.ok || !retryableStatus(r.status) || i === tries - 1) return r; // 最后一次把真实响应还回去，错误信息照旧完整
      console.warn(`[tools] ${label} 返回 ${r.status}，${baseMs * 2 ** i}ms 后重试（第 ${i + 2}/${tries} 次）`);
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (e.name === "AbortError" || i === tries - 1) throw e;
      console.warn(`[tools] ${label} ${e.message}，重试（第 ${i + 2}/${tries} 次）`);
      lastErr = e;
    }
  }
  throw lastErr;
}

// 图/声/视这四路和对话模型共用同一张渠道表（见 docs/模型与Key管理_调研与改法.md），
// 所以同一个 Key 会被两边拿去用。以前对话那边过 cleanKey，这边只 trim()：
// 从网页上复制 Key 时多框进一个中文字或全角引号，对话会明说「第几个字符不对、去哪儿重贴」，
// 生图却在 undici 里炸成一句 "Cannot convert argument to a ByteString"，同一个毛病两副面孔。
// 这里改成共用一份判断，措辞也就一致了。
function mediaKey(cfg) {
  return require("./llm").cleanKey((cfg || {}).api_key, cfg);
}

async function downloadToWorkspace(url, fname, dir) {
  // 图/视频已经生成完、钱也花掉了，栽在最后一步下载上最不值——这一步尤其该重试
  const r = await fetchRetry(url, { signal: AbortSignal.timeout(180000) }, { label: "下载生成结果" });
  if (!r.ok) throw new Error(`下载生成结果失败 HTTP ${r.status}`);
  ensureDirs();
  fs.writeFileSync(path.join(dir || ws(), fname), Buffer.from(await r.arrayBuffer()));
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

// 大文件不整份读进内存。实测一份 48.5MB 的日志：readFileSync 整份读完再 split("\n")，
// 事件循环被钉住 172~188ms、堆一次涨 64~88MB——那 0.2 秒里 SSE 一个字都发不出去，
// 用户看到的就是回答说到一半突然定住。
// 200MB 的日志（数据分析类任务里很常见）就是 0.7 秒起步，还要多占几百 MB。
// 所以超过这个大小改成分块读：不带行号只取开头那一截；带行号就流着扫，只把要的那几行留下。
// fh.read 是真异步（走线程池），每块之间事件循环自然能喘一口气。
const READ_BIG = 4 * 1024 * 1024;
const READ_CHUNK = 1 << 20;

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
    const out = [];
    let carry = "", lineNo = 0, pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      carry += dec.write(buf.subarray(0, bytesRead));
      const parts = carry.split("\n");
      carry = parts.pop();
      for (const ln of parts) {
        lineNo++;
        if (lineNo >= from && lineNo <= to) out.push(`${lineNo}\t${ln}`);
      }
    }
    carry += dec.end();
    lineNo++; // 最后一段（可能是空串）也算一行：跟 content.split("\n") 的行数口径对齐，
    if (lineNo >= from && lineNo <= to) out.push(`${lineNo}\t${carry}`); // 不然大小文件报的总行数会差一
    // 翻页翻到头了不是失败，是「这就是结尾」这条信息本身——跟小文件那条路一个措辞
    if (from > lineNo) return `${rel} 到头了：全文共 ${lineNo} 行，start_line=${from} 已经在末尾之后，后面没有内容了。`;
    return `（${rel} 第 ${from}-${Math.min(lineNo, to)} 行，全文共 ${lineNo} 行）\n${out.join("\n")}`.slice(0, 50000);
  } finally {
    await fh.close();
  }
}
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };

/**
 * 大图先缩到长边 1568（视觉模型再大也看不出更多东西，只是更贵更慢，还容易撞上游的体积上限）。
 * 用 Electron 自带的 nativeImage，不引任何图像库；跑在纯 node 里（测试、CLI）时缩不动就原样发。
 */
function shrinkForVision(abs) {
  const raw = fs.readFileSync(abs);
  const ext = (abs.split(".").pop() || "png").toLowerCase();
  const mime = IMAGE_MIME[ext] || "image/png";
  const asis = { b64: raw.toString("base64"), mime, note: "" };
  if (raw.length <= 900 * 1024) return asis;
  try {
    const { nativeImage } = require("electron");
    let img = nativeImage.createFromPath(abs);
    if (img.isEmpty()) return asis;
    const sz = img.getSize();
    if (Math.max(sz.width, sz.height) > 1568) {
      img = img.resize(sz.width >= sz.height ? { width: 1568, quality: "good" } : { height: 1568, quality: "good" });
    }
    const jpg = img.toJPEG(82);
    if (!jpg || !jpg.length || jpg.length >= raw.length) return asis;
    return { b64: jpg.toString("base64"), mime: "image/jpeg", note: `（原图 ${sz.width}×${sz.height}、${Math.round(raw.length / 1024)}KB，压缩后再看的）` };
  } catch {
    return asis;
  }
}

/**
 * 把工作空间里的一张图读成能直接塞进请求体的 base64。
 *
 * 三条路要用它：看图（look_at_image）、生图喂参考图、生视频定首尾帧。为什么非得是同一份——
 * 这三条路能失败的地方一模一样：路径打错、指到了目录、指到了 .txt、图大到上游收不下。
 * 各写各的话，同一个错在三个地方会有三种说法，模型学不会，只能挨个试过去。
 *
 * 返回 { err }（一整句可以原样发给模型的话）或 { b64, mime, note, abs }。
 */
function readImageInput(rel, resolveFile, what) {
  const s = String(rel == null ? "" : rel).trim();
  if (!s) return { err: `缺少${what}的路径（工作空间里的相对路径，先 list_files 看看真实文件名）` };
  let p;
  try { p = resolveFile(s); } catch (e) { return { err: e.message }; }
  if (!fs.existsSync(p)) return { err: `找不到${what} ${s}。用户上传的图在工作空间里，先 list_files 看看真实文件名。` };
  if (fs.statSync(p).isDirectory()) return { err: `${s} 是个目录，不是图片。` };
  if (!IMAGE_EXT.test(p)) return { err: `${s} 不是图片（支持 png / jpg / webp / gif / bmp）。文本文件用 read_file。` };
  const { b64, mime, note } = shrinkForVision(p);
  if (b64.length > 12 * 1048576) {
    return { err: `${path.basename(p)} 太大了（编码后约 ${Math.round(b64.length / 1048576)}MB），上游收不下。先缩小再用。` };
  }
  return { b64, mime, note, abs: p };
}

/** 图当输入时统一的 data: URI 写法，三条路共用一份，省得有的带前缀有的不带 */
function imageDataUri(got) {
  return `data:${got.mime};base64,${got.b64}`;
}

/**
 * 带着一个问题去看一张图，返回文字答案。
 *
 * 为什么是「工具」而不是把图塞进对话历史：历史是每一步都要整份重发的，图又是 token 大户，
 * 一张截图能把刚做完的上下文成本优化整个推翻；而且多数纯文本模型收到图直接 400，
 * 会话是落盘的，于是那个会话就永久废了。走工具这条路，进历史的只有一段纯文本答案——
 * 便宜、能命中缓存、上下文紧张时还能被裁掉。
 */
async function lookAtImage(opts, input, timeoutMs, resolveFile) {
  const rel = String(input.path || "").trim();
  const q = String(input.question || "").trim();
  if (!rel) return { content: "缺少 path（要看哪张图，工作空间里的相对路径）", isError: true };
  if (!q) return { content: "缺少 question：看图必须带着具体问题去问（「报错写的什么」「这页分几块」），空看一眼拿不回有用的东西。", isError: true };

  let v;
  try { v = mediaModels.pick(opts.media, "vision", input.model); } catch (e) { return { content: e.message, isError: true }; }
  const configured = !!(String(v.base_url || "").trim() && String(v.model || "").trim());
  // 没单独配视觉渠道就拿主模型试一把：主模型本来就多模态的（GPT/Claude/Gemini/GLM 系）什么都不用配；
  // 纯文本模型会明确报错，下面那段会把「去设置里配一个」这句话说清楚，而不是让模型在那儿反复重试。
  const cfg = configured ? v : opts.visionFallback || {};
  if (!cfg.base_url || !cfg.model) {
    return { content: "没有能看图的模型：请用户去 设置 → 模型 → 视觉模型 填接口地址 / API Key / 模型名。这一步不用重试。", isError: true };
  }

  const got = readImageInput(rel, resolveFile, "图片");
  if (got.err) return { content: got.err, isError: true };
  const { b64, mime, note, abs: p } = got;
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const signal = AbortSignal.timeout(Math.max(timeoutMs || 0, 120000));
  const anthropic = cfg.provider === "anthropic";
  // 地址算法跟主模型共用一份（llm.js 的 anthropicBase）。自己拼 `${base}/v1/messages` 的话，
  // 用户照着设置页里其它渠道的样子把 base_url 填成 .../v1，就会拼出 /v1/v1/messages 吃 404
  const url = anthropic ? require("./llm").anthropicBase(base).messagesUrl : `${base}/chat/completions`;
  const key = mediaKey(cfg);
  const headers = anthropic
    ? { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  const mkBody = (maxTokens, extra) => (anthropic
    ? { model: cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mime, data: b64 } }, { type: "text", text: q }] }], ...extra }
    : { model: cfg.model, max_tokens: maxTokens, messages: [{ role: "user", content: [{ type: "text", text: q }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }] }], ...extra });

  const ask = async (bodyObj) => {
    let r;
    try {
      r = await fetchRetry(url, { method: "POST", headers, signal, body: JSON.stringify(bodyObj) }, { label: "视觉模型" });
    } catch (e) {
      return { fail: `视觉模型请求失败：${e.message}` };
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { r, j, http: r.status };
    const ch = ((j.choices || [])[0] || {});
    const msg = ch.message || {};
    let text = anthropic
      ? (j.content || []).map((c) => (c && c.type === "text" ? c.text : "")).join("")
      : msg.content;
    if (Array.isArray(text)) text = text.map((c) => (typeof c === "string" ? c : (c || {}).text || "")).join("");
    // 「想了一堆但一个字没说」跟「被内容策略拦了」是两回事，得分得开
    const reasoned = anthropic
      ? (j.content || []).some((c) => c && (c.type === "thinking" || c.type === "redacted_thinking"))
      : !!String(msg.reasoning_content || msg.reasoning || "").trim();
    const capped = anthropic ? j.stop_reason === "max_tokens" : ch.finish_reason === "length";
    return { r, j, text: String(text || "").trim(), reasoned, capped };
  };

  let out = await ask(mkBody(2000));
  if (out.fail) return { content: out.fail, isError: true };
  if (out.http) {
    const msg = JSON.stringify(out.j).slice(0, 300);
    // 主模型是纯文本模型时上游会直说「不支持图片」。这句话得原样转给用户去配视觉渠道——
    // 模型自己怎么重试都是同一个 400，只会白烧几轮。
    if (!configured && /image|vision|multimodal|不支持/i.test(msg)) {
      return {
        content: `当前主模型（${cfg.model}）看不了图：${msg}\n请用户去 设置 → 模型 → 视觉模型 配一个能看图的模型，配好后再调一次。不要重试，也别改用别的工具去猜图里是什么。`,
        isError: true,
      };
    }
    if (out.http === 402 || /insufficient|credit|余额|欠费/i.test(msg)) {
      return { content: `视觉模型这条渠道没余额了（HTTP ${out.http}）：${msg}\n这不是问法的问题，重试多少次都一样。请用户去充值，或在 设置 → 模型 → 视觉模型 换一条渠道。别再调 look_at_image 了，也不许把没看到的内容当看过写进结论。`, isError: true };
    }
    return { content: `视觉模型错误 ${out.http}: ${msg}`, isError: true };
  }

  // 空正文最常见的真因不是内容策略，而是**思考把额度吃光了**：
  // GLM / OpenRouter 这类默认开思考的渠道，2000 的上限先被 reasoning 花完，
  // content 就是个空字符串，finish_reason=length。真实会话里这一种出现了 40 次，
  // 模型看到「换个问法再试一次」就一轮轮换措辞重试，最后干脆编一句「已核对」——
  // 明明一眼没看见。所以这里自己关掉思考重来一次，再空才算真空。
  if (!out.text && (out.capped || out.reasoned)) {
    const off = require("./thinking").planFor(cfg, "off");
    const retry = await ask(mkBody(4000, { ...off.params, ...(cfg.extra_body || {}) }));
    if (!retry.fail && !retry.http && retry.text) {
      return { content: `【看图】${path.basename(p)}${note}\n问：${q}\n答：${retry.text}\n（第一次它把 ${2000} token 全花在思考上没留下正文，已自动关思考重看一次）`, isError: false };
    }
    if (!retry.fail && !retry.http) out = retry;
  }

  if (!out.text) {
    const why = out.capped || out.reasoned
      ? `${cfg.model} 把额度全花在思考上、一个字正文都没吐（关掉思考重试过一次，还是这样）`
      : `${cfg.model} 返回了空正文（多半被内容策略拦了）`;
    return {
      content: `没看成这张图：${why}。\n别再换问法重试了——换措辞改不了这件事。如实说这张图没看成，`
        + `或者换一条视觉渠道（设置 → 模型 → 视觉模型）。\n注意：绝对不许把没看到的内容当作看过写进结论或说明文档里。`,
      isError: true,
    };
  }
  return { content: `【看图】${path.basename(p)}${note}\n问：${q}\n答：${out.text}`, isError: false };
}

/**
 * 产物落点的真实相对路径。回执只报个光秃秃的文件名等于骗模型：成果其实在本对话的
 * 成果子目录里，模型照回执去工作空间根目录找，找不到就 `cp` 一份过去"修好"这个不一致——
 * 于是同一张图在文件面板里出现两遍。真实会话 s_1787740619097 里就这么复制了 6 个文件，
 * 每个还白烧一轮 ls + 一轮 find。提示词里写"别 cp 到根目录"拦不住，因为模型不是想复制，
 * 是真找不到；把落点说准，它就没有复制的理由了。
 */
function savedAt(saveDir, fname) {
  const rel = path.relative(ws(), saveDir || ws());
  return rel && !rel.startsWith("..") ? `${rel}/${fname}` : fname;
}

/**
 * 发一个「要干净图」的请求：默认带上 watermark: false。
 *
 * 国内几家默认往右下角烙一枚「AI 生成」——火山方舟 doubao-seedream 系的 watermark
 * 默认就是 true。用户拿到的是要直接拿去用的成品，不是 demo，带水印等于白生成一次。
 *
 * 麻烦在这个字段不通用：OpenAI 官方 /images/generations 见到不认识的字段直接 400
 * （Unrecognized request argument supplied），而聚合网关（new-api 之类）主机名千奇百怪，
 * 靠 base_url 猜是哪一家一定会猜漏，漏掉的恰好就是用户真在用的那个。
 * 所以策略是反过来的：先按「要干净图」发，只有对面明确说「我不认识这个字段」才去掉重发一次。
 *
 * 关键是退让必须留痕。静默退回去，用户下次又拿到带水印的图，还是查不出原因——
 * 这个默认值被漏掉过一次，代价就是用户手里所有生成图都白做了。
 */
async function postWantClean(url, headers, signal, buildBody, label, tries) {
  const send = (wm) => fetchRetry(url, { method: "POST", headers, signal, body: JSON.stringify(buildBody(wm)) }, { label, ...(tries ? { tries } : {}) });
  const r = await send(true);
  if (r.ok) return { r, j: await r.json().catch(() => ({})), stripped: false };
  const raw = await r.text().catch(() => "");
  // 只在「这个字段我不认识」时退让。余额不足、鉴权失败、内容被拦这些照原样报错，
  // 别一律当成参数问题吞掉——那会把真正的错因藏起来
  const unknownField = r.status === 400 && /watermark|unrecognized|unknown|unsupported|not\s+support|invalid[^"]{0,20}(param|argument|field)/i.test(raw);
  if (!unknownField) {
    let j = {}; try { j = JSON.parse(raw); } catch { j = { error: raw.slice(0, 300) }; }
    return { r, j, stripped: false };
  }
  const r2 = await send(false);
  return { r: r2, j: await r2.json().catch(() => ({})), stripped: true };
}

/** 一次最多喂几张参考图。再多上游多半也只看前几张，白掏 token 还把请求体撑爆 */
const MAX_REF_IMAGES = 4;

/**
 * 把 reference_images 一路读成 data: URI。
 * 允许传一个字符串（模型真会这么写），统一当成一张图处理，不为这个多报一条格式错。
 * 返回 { err } 或 { uris }。
 */
function refImageUris(v, resolveFile) {
  const list = v == null || v === "" ? [] : Array.isArray(v) ? v : [v];
  if (!list.length) return { uris: [] };
  if (typeof resolveFile !== "function") return { err: "这个环境下生图喂不了参考图（当前调用没有文件解析器）。去掉 reference_images 就是纯文生图。" };
  if (list.length > MAX_REF_IMAGES) return { err: `参考图最多 ${MAX_REF_IMAGES} 张，这次给了 ${list.length} 张。挑最能说明问题的几张。` };
  const uris = [];
  for (const rel of list) {
    const got = readImageInput(rel, resolveFile, "参考图");
    if (got.err) return { err: got.err };
    uris.push(imageDataUri(got));
  }
  return { uris };
}

/**
 * 型号是「图生视频」还是「文生视频」，只能按名字认——各家 /models 返回的就只有个 id。
 * 钉在分隔符上，别让随便哪个型号名里蹭上三个字母就被误判（跟 media-models.js 里 asr 那条同一个教训）。
 */
const I2V_RE = /(^|[-_/.])(i2v|kf2v|s2v|image-?to-?video|img-?2-?video)([-_/.\d]|$)/i;
const T2V_RE = /(^|[-_/.])(t2v|text-?to-?video)([-_/.\d]|$)/i;

async function generateImage(media, input, timeoutMs, saveDir, resolveFile) {
  let cfg;
  try { cfg = mediaModels.pick(media, "image", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg.base_url || !cfg.model) {
    return { content: "图像模型未配置：请在 设置 → 模型 → 图像模型 填写接口地址 / API Key / 模型名后再用。", isError: true };
  }
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return { content: "缺少 prompt（画面描述）", isError: true };
  const ref = refImageUris(input.reference_images, resolveFile);
  if (ref.err) return { content: ref.err, isError: true };
  const refs = ref.uris;
  // 渠道不认参考图时，宁可把这一趟报废掉，也不能偷偷退回纯文生：
  // 那样出来的图跟参考图毫无关系，模型却会当成「已经保持一致了」交上去，错得不留痕迹。
  const refFailHint = refs.length
    ? `\n（这次带了 ${refs.length} 张参考图。报错要是指向 image 字段或「不认识的参数」，就是这条渠道的生图接口不收参考图——`
      + "换一个支持图生图的模型或渠道（设置 → 模型 → 图像模型）。这里不会自动退回纯文生图。）"
    : "";
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${mediaKey(cfg)}` };
  const signal = AbortSignal.timeout(Math.max(timeoutMs || 0, 300000));
  const fname = safeOutName(input.filename, ".png", "image");
  let imgUrl = null, b64 = null, watermarked = false;
  if (/dashscope/i.test(base)) {
    // DashScope 原生（qwen-image 系）：multimodal-generation，同步返回图片 URL
    // 生图慢又贵，上游一抖整轮就白跑：真实数据里 15 次调用失败 9 次，其中 8 次是
    // 上游 500 InternalServiceError，纯属临时故障。模型拿到失败通常不会重来，而是
    // 改用别的方案交差，用户就永远拿不到那张图。所以重试这件事得工具自己扛。
    const { r, j, stripped } = await postWantClean(`${base}/services/aigc/multimodal-generation/generation`, headers, signal,
      // 参考图排在文字前面：多模态这边约定俗成是「先看图，再读要求」，顺序反了有些模型会只当描述看
      (wm) => ({ model: cfg.model, input: { messages: [{ role: "user", content: [...refs.map((u) => ({ image: u })), { text: prompt }] }] }, parameters: wm ? { watermark: false } : {} }), "图像接口");
    watermarked = stripped;
    if (!r.ok) return { content: `图像接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${refFailHint}`, isError: true };
    const parts = ((((j.output || {}).choices || [])[0] || {}).message || {}).content || [];
    imgUrl = (parts.find((c) => c.image) || {}).image;
    if (!imgUrl) return { content: "图像接口没有返回图片：" + JSON.stringify(j).slice(0, 300), isError: true };
  } else {
    // OpenAI 兼容 /images/generations（OpenAI、new-api 等聚合网关通用）
    const { r, j, stripped } = await postWantClean(`${base}/images/generations`, headers, signal,
      // 参考图走 image 字段（一张给字符串、多张给数组），仍然是这个 JSON 接口——
      // 不改走 multipart 的 /images/edits：那条路绕开了 postWantClean，水印退让就没人留痕了
      (wm) => ({ model: cfg.model, prompt, n: 1, ...(input.size ? { size: String(input.size) } : {}), ...(refs.length ? { image: refs.length === 1 ? refs[0] : refs } : {}), ...(wm ? { watermark: false } : {}) }), "图像接口");
    watermarked = stripped;
    if (!r.ok) return { content: `图像接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${refFailHint}`, isError: true };
    const d = (j.data || [])[0] || {};
    imgUrl = d.url;
    b64 = d.b64_json;
    if (!imgUrl && !b64) return { content: "图像接口没有返回图片：" + JSON.stringify(j).slice(0, 300), isError: true };
  }
  if (b64) {
    ensureDirs();
    fs.writeFileSync(path.join(saveDir || ws(), fname), Buffer.from(b64, "base64"));
  } else await downloadToWorkspace(imgUrl, fname, saveDir);
  security.audit("图像生成", `${cfg.model}: ${prompt.slice(0, 120)}${refs.length ? `（参考图 ${refs.length} 张）` : ""} → ${fname}`, "放行");
  // 顺利那条也必须把水印状态说出来。只在出问题时报警、顺利时沉默，模型就无从判断，
  // 只能自己再花一轮 look_at_image 去找水印；真实会话里它找完还会另造一版「干净图」，
  // 白烧两轮加一个多余产物。把结论直接写进回执，它就不用查了。
  const wmNote = watermarked
    ? "\n注意：这个渠道不接受 watermark 参数，图上可能带平台的「AI 生成」水印。要干净的图就换个渠道或换个模型，别用截图裁掉——分辨率会掉。"
    : "\n已按无水印出图（渠道接受了 watermark=false），不用再开图找水印。";
  // 参考图到底有没有被这条渠道吃进去，回执里必须说一声。说了模型才知道
  // 「像不像」该拿谁去比；不说的话它只能再开一轮 look_at_image 自己对照。
  const refNote = refs.length ? `\n已带 ${refs.length} 张参考图出图；出来的东西像不像，以参考图为准。` : "";
  return { content: `图片已生成：${savedAt(saveDir, fname)}（工作空间内的相对路径，模型 ${cfg.model}）${refNote}${wmNote}`, isError: false, file: fname };
}

async function generateVideo(media, input, opts = {}) {
  let cfg;
  try { cfg = mediaModels.pick(media, "video", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg.base_url || !cfg.model) {
    return { content: "视频模型未配置：请在 设置 → 模型 → 视频模型 填写接口地址 / API Key / 模型名后再用。", isError: true };
  }
  const prompt = String(input.prompt || "").trim();
  if (!prompt) return { content: "缺少 prompt（视频内容描述）", isError: true };

  // 首尾帧。两道检查都放在发请求之前——视频是按条计费的异步任务，
  // 「型号只收图却只给了文字」这种错到上游才发现，钱已经掏了、还要等几分钟才看到失败。
  if (input.last_frame && !input.first_frame) {
    return { content: "只给了 last_frame：尾帧得跟首帧配着用，先有起点才谈得上「变到哪」。补上 first_frame，或者两个都别给。", isError: true };
  }
  let firstUri = null, lastUri = null;
  if (input.first_frame) {
    const fr = readImageInput(input.first_frame, opts.resolveFile, "首帧图");
    if (fr.err) return { content: typeof opts.resolveFile === "function" ? fr.err : "这个环境下生视频喂不了首尾帧（当前调用没有文件解析器）。去掉 first_frame 就是纯文生视频。", isError: true };
    firstUri = imageDataUri(fr);
    if (input.last_frame) {
      const lf = readImageInput(input.last_frame, opts.resolveFile, "尾帧图");
      if (lf.err) return { content: lf.err, isError: true };
      lastUri = imageDataUri(lf);
    }
  }
  // 型号和入参对不上，是眼下就能踩到的坑：媒体模型目录按名字认能力，i2v 型号一样被归到「视频模型」，
  // 用户在设置里选了它，今天不给图就调，必然在上游失败一次。这两句把那一趟省下来。
  if (!firstUri && I2V_RE.test(cfg.model)) {
    return { content: `${cfg.model} 是图生视频型号，必须给 first_frame（工作空间里的一张图）当首帧，只给文字它到上游就会失败，而那一趟是计费的。`
      + "要纯文字生视频，就在 设置 → 模型 → 视频模型 里换一个 t2v 型号。", isError: true };
  }
  if (firstUri && T2V_RE.test(cfg.model)) {
    return { content: `${cfg.model} 是文生视频型号，收不了首帧图。要用首尾帧就在 设置 → 模型 → 视频模型 里换一个 i2v 型号；`
      + "或者去掉 first_frame / last_frame，只用文字描述。", isError: true };
  }
  const kfHint = firstUri
    ? "\n（这次带了" + (lastUri ? "首尾帧" : "首帧") + "图。报错要是指向 img_url / image_url / 「不认识的参数」，就是这条渠道的视频接口不收图，换一个 i2v 型号或渠道。这里不会自动退回纯文生视频。）"
    : "";
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${mediaKey(cfg)}` };
  const headers = { "Content-Type": "application/json", ...auth };
  const proto = mediaModels.videoProtoOf(cfg);
  const protoCn = mediaModels.VIDEO_PROTO_CN[proto] || "这条渠道";
  // 尾帧只有万相 kf2v 和方舟收，另外三家的接口里根本没有这个字段。硬发过去是两种下场：
  // 被忽略——片子照出、钱照扣，人对着成片纳闷尾帧怎么没生效；或者整单报「不认识的参数」。
  // 都得等上几分钟才看得到，不如现在就说清。
  if (lastUri && proto !== "dashscope" && proto !== "ark") {
    return { content: `${protoCn} 的视频接口只收首帧，没有尾帧这一项。要首尾帧出片，到 设置 → 模型 → 视频模型 换成 通义万相 kf2v 或 火山方舟 Seedance；或者去掉 last_frame，只定首帧。`, isError: true };
  }
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
  // 万相的字段名按「几张图」分：只有首帧走 img_url，首尾都有走 first/last_frame_url
  const kfBody = lastUri ? { first_frame_url: firstUri, last_frame_url: lastUri } : firstUri ? { img_url: firstUri } : {};
  let videoUrl;
  // 水印这件事只有三种真话：问了对面收下（clean）、问了对面不认所以降级发的（stripped）、
  // 这家协议根本没有这个开关（unasked）。以前是个布尔量，新接的三家只能硬套一个「已按无水印出片」，
  // 那是句假话——人会信了它不去看片尾。
  let vWm = "clean";
  if (proto === "dashscope") {
    // DashScope 万相（wan 系）：异步提交 + /tasks 轮询
    // 水印走跟生图同一套策略：先按「要干净的」发，只有对面明说不认识这个字段才去掉重发。
    // 以前这里是硬发 parameters.watermark=false，渠道一旦不认，整条视频任务当场就废——
    // 视频要跑好几分钟还按条收钱，为一个可降级的字段把它废掉不划算。
    // tries=1：这是付费异步任务的提交口，退避重发会重复下单，不能跟生图一个策略。
    const { r, j, stripped } = await postWantClean(
      `${base}/services/aigc/video-generation/video-synthesis`,
      { ...headers, "X-DashScope-Async": "enable" }, AbortSignal.timeout(60000),
      // 万相这边一张图和两张图是两套字段：只定首帧是 img_url（i2v），首尾都定是 first/last_frame_url（kf2v）。
      // 不传就一个字段都不出现，请求体跟纯文生那条逐字节一样
      (wm) => ({ model: cfg.model, input: { prompt, ...kfBody }, parameters: wm ? { watermark: false } : {} }), "视频接口", 1);
    vWm = stripped ? "stripped" : "clean";
    const taskId = ((j || {}).output || {}).task_id;
    if (!r.ok || !taskId) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
    videoUrl = await poll(async () => {
      const s = await fetch(`${base}/tasks/${taskId}`, { headers: auth, signal: AbortSignal.timeout(30000) }).then((x) => x.json());
      const st = ((s || {}).output || {}).task_status;
      if (st === "SUCCEEDED") return s.output.video_url;
      if (st === "FAILED" || st === "CANCELED") throw new Error("视频任务失败：" + JSON.stringify(s.output).slice(0, 200));
      return null;
    });
  } else if (proto === "ark") {
    // 火山方舟（Seedance 系）：contents/generations/tasks 异步 + 轮询
    const r = await fetch(`${base}/contents/generations/tasks`, {
      method: "POST", headers, signal: AbortSignal.timeout(60000),
      // Seedance 的参数走提示词里的文本指令，不是 JSON 字段。用户自己写了就不覆盖他的
      // 方舟这边首尾帧是同一个 content 数组里的两个 image_url 项，靠 role 区分。
      // 文字那一项原样不动：`--watermark false` 是写在提示词里的指令，挪个位置就失效了
      body: JSON.stringify({ model: cfg.model, content: [
        { type: "text", text: /--watermark\b/.test(prompt) ? prompt : `${prompt} --watermark false` },
        ...(firstUri ? [{ type: "image_url", image_url: { url: firstUri }, role: "first_frame" }] : []),
        ...(lastUri ? [{ type: "image_url", image_url: { url: lastUri }, role: "last_frame" }] : []),
      ] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
    videoUrl = await poll(async () => {
      const s = await fetch(`${base}/contents/generations/tasks/${j.id}`, { headers: auth, signal: AbortSignal.timeout(30000) }).then((x) => x.json());
      if (s.status === "succeeded") return ((s.content || {}).video_url) || null;
      if (s.status === "failed" || s.status === "cancelled") throw new Error("视频任务失败：" + JSON.stringify(s.error || s).slice(0, 200));
      return null;
    });
  } else if (proto === "zhipu") {
    // 智谱 CogVideoX：/videos/generations 提交，/async-result/{id} 轮询。
    // 提交回执里的字段名是 id，老一点的型号回 request_id，两个都认一下。
    const r = await fetch(`${base}/videos/generations`, {
      method: "POST", headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: cfg.model, prompt, with_audio: true, ...(firstUri ? { image_url: firstUri } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    const id = j.id || j.request_id;
    if (!r.ok || !id) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
    videoUrl = await poll(async () => {
      const s = await fetch(`${base}/async-result/${id}`, { headers: auth, signal: AbortSignal.timeout(30000) }).then((x) => x.json());
      const st = String((s || {}).task_status || "").toUpperCase();
      if (st === "SUCCESS") return (((s.video_result || [])[0]) || {}).url || null;
      if (st === "FAIL") throw new Error("视频任务失败：" + JSON.stringify(s).slice(0, 200));
      return null;
    });
    vWm = "unasked";
  } else if (proto === "minimax") {
    // MiniMax 海螺：提交 → 轮询 → 再拿 file_id 换下载地址，三段，比另外四家多一手。
    // 这家最容易踩的是「HTTP 200 不等于成功」：成败写在 base_resp.status_code 里，
    // 只看 r.ok 的话，一句「余额不足」会被当成提交成功，然后在轮询里空转满 10 分钟才报超时。
    const r = await fetch(`${base}/video_generation`, {
      method: "POST", headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: cfg.model, prompt, ...(firstUri ? { first_frame_image: firstUri } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    const code = ((j || {}).base_resp || {}).status_code;
    if (!r.ok || !j.task_id || (code != null && code !== 0)) {
      return { content: `视频接口错误 ${r.status}${code ? `（base_resp ${code}）` : ""}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
    }
    const fileId = await poll(async () => {
      const s = await fetch(`${base}/query/video_generation?task_id=${encodeURIComponent(j.task_id)}`,
        { headers: auth, signal: AbortSignal.timeout(30000) }).then((x) => x.json());
      const st = String((s || {}).status || "");
      if (st === "Success") return s.file_id || null;
      if (/^fail/i.test(st)) throw new Error("视频任务失败：" + JSON.stringify(s).slice(0, 200));
      return null;
    });
    // 轮询给的是 file_id 不是地址，还得再换一手。换来的地址有时效，换完立刻下载
    const f = await fetch(`${base}/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
      { headers: auth, signal: AbortSignal.timeout(30000) }).then((x) => x.json()).catch(() => ({}));
    videoUrl = (((f || {}).file || {}).download_url) || "";
    if (!videoUrl) return { content: `片子出好了，但取不到下载地址（file_id ${fileId}）：${JSON.stringify(f).slice(0, 200)}。到 MiniMax 控制台按这个 file_id 能手动下。`, isError: true };
    vWm = "unasked";
  } else if (proto === "siliconflow") {
    // 硅基流动：submit 拿 requestId，查状态是 POST 带 body——这点跟另外四家都不一样，
    // 照 GET 发过去会得到一个 405，看起来像地址写错了，其实是方法不对。
    const r = await fetch(`${base}/video/submit`, {
      method: "POST", headers, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: cfg.model, prompt, ...(firstUri ? { image: firstUri } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    const rid = j.requestId || j.request_id;
    if (!r.ok || !rid) return { content: `视频接口错误 ${r.status}: ${JSON.stringify(j).slice(0, 300)}${kfHint}`, isError: true };
    videoUrl = await poll(async () => {
      const s = await fetch(`${base}/video/status`, {
        method: "POST", headers, signal: AbortSignal.timeout(30000), body: JSON.stringify({ requestId: rid }),
      }).then((x) => x.json());
      const st = String((s || {}).status || "");
      if (st === "Succeed") return ((((s.results || {}).videos || [])[0]) || {}).url || null;
      if (/^fail/i.test(st)) throw new Error("视频任务失败：" + JSON.stringify(s.reason || s).slice(0, 200));
      return null;
    });
    vWm = "unasked";
  } else {
    // 认不出是哪家。把「按什么认的、这次认到了什么」摊开说——中转和自建网关地址里看不出上游，
    // 只说一句「不支持」的话，人会去改地址，而实际该改的是渠道类型那一栏。
    const names = mediaModels.VIDEO_PROTOS.map((p) => mediaModels.VIDEO_PROTO_CN[p]).join("、");
    return {
      content: `认不出这条视频渠道说的是哪门话，所以没敢发——视频按条计费，发错一趟要等好几分钟才看得到错。\n`
        + `现在支持这五家：${names}。\n`
        + `认的顺序是：先看渠道卡上选的「渠道类型」，再看接口地址里的域名（dashscope / volces·ark / bigmodel / minimax / siliconflow）。`
        + `这次地址是 ${base || "(空)"}，渠道类型是「${cfg.kind || "没选"}」，两头都没认出来。\n`
        + `走中转或自建网关的话，地址里本来就看不出上游是谁。到 设置 → 模型 里把这条渠道的「渠道类型」选成它实际接的那一家就行。`,
      isError: true,
    };
  }
  if (!videoUrl) return { content: "视频任务完成但没有返回视频地址", isError: true };
  await downloadToWorkspace(videoUrl, fname, opts.saveDir);
  security.audit("视频生成", `${cfg.model}: ${prompt.slice(0, 120)}${firstUri ? (lastUri ? "（首尾帧）" : "（首帧图）") : ""} → ${fname}`, "放行");
  const vwNote = vWm === "stripped"
    ? "\n注意：这个渠道不接受 watermark 参数，片尾/角标可能带平台的「AI 生成」水印。要干净的成片就换个渠道或换个模型。"
    : vWm === "unasked"
      ? `\n注意：${protoCn} 的视频接口没有水印开关，带不带平台角标由渠道自己定，这里说了不算。片尾要干净的话先自己看一眼成片。`
      : "\n已按无水印出片，不用再开片找水印。";
  const kfNote = firstUri ? (lastUri ? "\n已按给定的首帧和尾帧出片。" : "\n已按给定的首帧出片。") : "";
  return { content: `视频已生成：${savedAt(opts.saveDir, fname)}（工作空间内的相对路径，模型 ${cfg.model}）${kfNote}${vwNote}`, isError: false, file: fname };
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
  fs.writeFileSync(path.join(saveDir || ws(), fname), buf);
  security.audit("HTML截图", `${rel} → ${fname}`, "放行");
  return { content: `已把 ${rel} 渲染成图片：${fname}（${input.width || 1242}x${input.full_page ? "整页" : input.height || 1656}）`, isError: false };
}

/** 文字 → 语音（渠道协议：OpenAI 兼容 /audio/speech、DashScope 原生 qwen-tts） */
async function textToSpeech(media, input, timeoutMs, saveDir) {
  let cfg;
  try { cfg = mediaModels.pick(media, "tts", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg.base_url || !cfg.model) {
    return { content: "语音合成未配置：请在 设置 → 模型 → 语音合成 填写接口地址 / API Key / 模型名后再用。", isError: true };
  }
  const text = String(input.text || "").trim();
  if (!text) return { content: "缺少 text（要念的文字）", isError: true };
  if (text.length > 5000) return { content: `文字太长（${text.length} 字，上限 5000），请分段多次合成再拼接`, isError: true };
  const base = String(cfg.base_url).trim().replace(/\/+$/, "");
  const voice = String(input.voice || cfg.voice || "").trim();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${mediaKey(cfg)}` };
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
    fs.writeFileSync(path.join(saveDir || ws(), fname), buf);
  }
  security.audit("语音合成", `${cfg.model}: ${text.slice(0, 80)} → ${fname}`, "放行");
  return { content: `语音已合成：${savedAt(saveDir, fname)}（工作空间内的相对路径，模型 ${cfg.model}${voice ? "，音色 " + voice : ""}，约 ${text.length} 字）`, isError: false, file: fname };
}

/** 能送去转写的后缀。上游收的就是这几样，多写只会在那边被拒，不如在本机就说清楚 */
const AUDIO_EXT = /\.(mp3|mp4|m4a|wav|webm|mpga|mpeg|ogg|oga|flac|aac|amr)$/i;
/** /audio/transcriptions 的硬上限。先量本地字节，别让用户传了两分钟才吃一个 413 */
const ASR_MAX_BYTES = 25 * 1048576;
/** 超过这个字数就不整篇塞回对话里——一小时的会议稿两万字，塞回去等于把上下文吃光 */
const ASR_INLINE_CAP = 2000;

/** 秒 → SRT 的 00:01:02,500。Math.floor 不用 toFixed：58.999 秒 toFixed 会进位成 59.000 却还留在上一分钟 */
function srtTime(sec) {
  const ms = Math.max(0, Math.round(Number(sec) * 1000));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/**
 * 把录音转成文字。走 OpenAI 兼容的 /audio/transcriptions（一次 multipart 传完就返回）。
 *
 * 为什么只支持这一种协议：通义百炼的 ASR 是「先把文件传到公网可访问的地址、再提交异步任务、
 * 再轮询」，和这里完全不是一门话。装作支持、让用户在设置里选得到，最后只会在调用时吃 404——
 * 所以精选目录里一个 dashscope 型号都不摆，报错时也直接把这件事说明白。
 */
async function transcribeAudio(media, input, timeoutMs, resolveFile, saveDir) {
  const rel = String(input.path || "").trim();
  if (!rel) return { content: "缺少 path（要转写哪个文件，工作空间里的相对路径）", isError: true };
  let cfg;
  try { cfg = mediaModels.pick(media, "asr", input.model); } catch (e) { return { content: e.message, isError: true }; }
  if (!cfg.base_url || !cfg.model) {
    return { content: "语音转写未配置：请用户去 设置 → 模型 → 转写 配置渠道和模型（如 OpenAI 的 gpt-4o-transcribe、硅基流动的 SenseVoiceSmall）。这一步不用重试。", isError: true };
  }
  let p;
  try { p = resolveFile(rel); } catch (e) { return { content: e.message, isError: true }; }
  if (!fs.existsSync(p)) return { content: `找不到 ${rel}。用户传进来的文件在工作空间里，先 list_files 看看真实文件名。`, isError: true };
  const st = fs.statSync(p);
  if (st.isDirectory()) return { content: `${rel} 是个目录，不是音频文件。`, isError: true };
  if (!AUDIO_EXT.test(p)) return { content: `${rel} 不是音频 / 视频（支持 mp3 / m4a / wav / webm / mp4 / flac / ogg / aac / amr）。文本文件用 read_file。`, isError: true };
  if (st.size < 200) return { content: `${rel} 只有 ${st.size} 字节，不像是一段能转写的音频。`, isError: true };
  if (st.size > ASR_MAX_BYTES) {
    return {
      content: `${path.basename(p)} 有 ${(st.size / 1048576).toFixed(1)}MB，超过接口 25MB 的上限，没有发出去。\n`
        + `先压小再转：run_shell 跑 ffmpeg -i "${rel}" -ac 1 -ar 16000 -b:a 64k "${path.basename(p).replace(/\.[^.]+$/, "")}_16k.mp3"，`
        + "一小时的会议压完大概 3MB；还是超就按 -ss / -t 切成几段分别转，最后把稿子拼起来。",
      isError: true,
    };
  }

  const base = mediaModels.baseForUse(String(cfg.base_url).trim(), "media").replace(/\/+$/, "");
  if (/dashscope\.aliyuncs\.com/i.test(base)) {
    return { content: "通义百炼的转写是异步任务接口，和这里用的 OpenAI 兼容 /audio/transcriptions 不是一套，现在还没接。换 OpenAI（gpt-4o-transcribe / whisper-1）或硅基流动（FunAudioLLM/SenseVoiceSmall）这类渠道。这一步不用重试。", isError: true };
  }
  // Key 在读文件之前先验：25MB 的音频读进内存再栽在 Key 上，白等一轮还白占一把内存
  const auth = { Authorization: `Bearer ${mediaKey(cfg)}` };
  const wantSeg = !!input.with_timestamps;
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(p)]), path.basename(p));
  form.append("model", cfg.model);
  form.append("response_format", wantSeg ? "verbose_json" : "json");
  const lang = String(input.language || "").trim();
  if (lang) form.append("language", lang);
  const hint = String(input.hint || "").trim().slice(0, 500);
  if (hint) form.append("prompt", hint);

  // 上传要时间，转写也要时间：一个 25MB 的文件在慢网上传就得几分钟，超时按文件大小放宽
  const budget = Math.max(timeoutMs || 0, 180000 + Math.round(st.size / 1048576) * 20000);
  let r;
  try {
    r = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: auth, body: form, signal: AbortSignal.timeout(budget) });
  } catch (e) {
    return { content: `转写请求失败：${e.message}（文件 ${(st.size / 1048576).toFixed(1)}MB，等了 ${Math.round(budget / 1000)} 秒）`, isError: true };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { content: `转写接口错误 ${r.status}: ${t.slice(0, 300)}`, isError: true };
  }
  const j = await r.json().catch(() => null);
  if (!j) return { content: "转写接口返回的不是 JSON，多半是这个地址没有 /audio/transcriptions 这个接口。", isError: true };
  const text = String(j.text || "").trim();
  if (!text) return { content: "转写接口没有返回文字（可能整段是静音，也可能这个模型不吃这种格式）：" + JSON.stringify(j).slice(0, 300), isError: true };

  ensureDirs();
  const stem = path.basename(p).replace(/\.[^.]+$/, "");
  const fname = safeOutName(input.filename, ".txt", stem);
  const dir = saveDir || ws();
  fs.writeFileSync(path.join(dir, fname), text);
  const saved = [savedAt(saveDir, fname)];

  // 分段只有 verbose_json 才有。要了却没给（模型不支持）就照实说一句，别让用户以为字幕已经出好了
  const segs = Array.isArray(j.segments) ? j.segments.filter((x) => x && typeof x.text === "string") : [];
  let srtNote = "";
  if (wantSeg && segs.length) {
    const srtName = fname.replace(/\.txt$/i, "") + ".srt"; // 跟转写稿同名，两个文件在产出列表里挨着
    const srt = segs.map((x, i) => `${i + 1}\n${srtTime(x.start)} --> ${srtTime(x.end)}\n${String(x.text).trim()}\n`).join("\n");
    fs.writeFileSync(path.join(dir, srtName), srt);
    saved.push(savedAt(saveDir, srtName));
    srtNote = `，字幕 ${segs.length} 段`;
  } else if (wantSeg) {
    srtNote = "；这个模型没给分段时间轴，.srt 没生成";
  }

  security.audit("语音转写", `${cfg.model}: ${rel}（${(st.size / 1048576).toFixed(1)}MB）→ ${fname}`, "放行");
  const head = text.length > ASR_INLINE_CAP
    ? `${text.slice(0, ASR_INLINE_CAP)}\n……（全文 ${text.length} 字，只贴了开头；要看后面的用 read_file 读 ${saved[0]}）`
    : text;
  return { content: `转写完成，存到 ${saved.join(" 和 ")}（模型 ${cfg.model}，共 ${text.length} 字${srtNote}）：\n\n${head}`, isError: false };
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
  const dec = new StringDecoder("utf8"); // 一个中文字被切在两个 chunk 中间会变乱码，必须按流解码
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

function runNode(code, timeoutMs, cwd) {
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
    const child = spawn(process.execPath, [file], {
      cwd: cwd || ws(),
      timeout: timeoutMs,
      // ELECTRON_RUN_AS_NODE：桌面版里 execPath 是 Electron 二进制，不加这个每跑一次脚本
      // 就弹一个新的 Electron 应用实例（Dock 图标狂蹦）；加了就纯当 node 用
      // OPENWORKBUDDY_HOME：装机态下代码在只读的应用包里、数据在 ~/OpenWorkBuddy，
      // 子进程要用同一个数据根才不会各写各的
      env: { ...process.env, NODE_PATH: appPath("node_modules"), OPENWORKBUDDY_HOME: DATA_DIR, ELECTRON_RUN_AS_NODE: "1" },
    });
    const out = makeOutSink("node", 8000, 8000);
    const err = makeOutSink("node-err", 4000, 6000);
    child.stdout.on("data", (d) => out.write(d));
    child.stderr.on("data", (d) => err.write(d));
    child.on("close", (code2, signal) => {
      fs.rmSync(file, { force: true });
      const o = out.render(), e = err.render();
      let result = "";
      if (o) result += `stdout:\n${o}\n`;
      if (e) result += `stderr:\n${e}\n`;
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
  // macOS 上 -o nonomatch 是必须的：zsh 默认通配符没匹配上就**整条命令拒绝执行**，
  // 而模型写的是 bash 味的命令。真实会话里这一条烧掉 10 次——
  //   `ls /usr/local/bin/python*` 探测装没装 → ls 根本没跑，只有 zsh 一句抱怨，
  //   模型分不清是"没这个文件"还是"命令挂了"；
  //   `for f in *.md; do ...; done` 没匹配上 → 整个循环连同后面的收尾全不执行，exit 1；
  //   `curl http://a.com/x?id=1` 不加引号 → ? 和 [] 在 zsh 里也是通配符，命令直接不跑。
  // 关掉之后行为跟 bash 一致：通配符原样传给命令，由命令自己报错，脚本接着往下走。
  if (process.platform === "darwin") return { bin: "/bin/zsh", args: ["-o", "nonomatch", "-c", command], opts: {} };
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
function missingBinHint(text, platform) {
  const { knownTool } = require("./doctor");
  const seen = new Set();
  const lines = [];
  for (const line of String(text || "").split("\n")) {
    for (const re of NOT_FOUND_RE) {
      const m = line.match(re);
      if (!m) continue;
      const t = knownTool(m[1], platform);
      if (t && !seen.has(t.name)) {
        seen.add(t.name);
        lines.push(`本机没装 ${t.name}（${t.use}）：${t.install}。装好再跑这条命令；用不到这个功能就别装，换个做法。`);
      }
      break; // 一行只认一个，认出来就别拿后面几条正则再刮一遍
    }
  }
  return lines.join("\n");
}

function runShell(command, timeoutMs, cwd) {
  ensureDirs();
  return new Promise((resolve) => {
    const sh = pickShell(command);
    const child = spawn(sh.bin, sh.args, {
      cwd: cwd || ws(),
      timeout: timeoutMs,
      env: { ...process.env, PATH: shellPath(), OPENWORKBUDDY_HOME: DATA_DIR },
      ...sh.opts,
    });
    const out = makeOutSink("shell", 8000, 8000);
    const err = makeOutSink("shell-err", 4000, 6000);
    child.stdout.on("data", (d) => out.write(d));
    child.stderr.on("data", (d) => err.write(d));
    child.on("close", (code2, signal) => {
      const o = out.render(), e = err.render();
      let result = "";
      if (o) result += `stdout:\n${o}\n`;
      if (e) result += `stderr:\n${e}\n`;
      if (signal === "SIGTERM") result += "(执行超时被终止)\n";
      result += `exit code: ${code2}`;
      // 缺的是我们认识的外部工具时，把 shell 那句 command not found 翻译一遍再递出去
      const hint = code2 !== 0 ? missingBinHint(o + "\n" + e) : "";
      if (hint) result += "\n" + hint;
      resolve({ content: result, isError: code2 !== 0 });
    });
    child.on("error", (e) => {
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
 * 为什么要有：资料库是整台服务器**共用的一份**。人一多、素材一杂，做「客户 A 的合同」那个项目时
 * 把「短剧素材」「公司规章」一股脑塞进 library_list，模型就要在一堆不相干的文件名里挑——
 * 挑错了不会报错，只会安静地引用错资料。挂上子目录之后，这个项目的 agent 眼里的资料库就只有那一块。
 *
 * 跟工作目录一样走 ALS：租户请求各自跑在自己的异步链上，用模块级变量会串台。
 * 没 run 过就退回 defaultLibraryRel（= 当前项目的挂载），单机个人版一行行为没变。
 */
let defaultLibraryRel = "";
const libStore = new AsyncLocalStorage();
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
  const rel = getLibraryDir();
  if (!rel) return LIB_DIR;
  const abs = path.join(LIB_DIR, rel);
  try { if (fs.statSync(abs).isDirectory()) return abs; } catch {}
  return LIB_DIR;
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
    notes = JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
  } catch {}
  const parts = [];
  const scope = getLibraryDir() && libRoot() !== LIB_DIR
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
 * **只往一个方向复制：库 → 工作目录。** 反过来不做。资料库是整台服务器共用的一份，
 * 界面上写得明明白白「往里放东西归平台管理员」（非管理员那里挂的是「只读」角标）。
 * 给 agent 开一个写回的口子，等于任何一个租户用户都能借 agent 的手改公共素材架——
 * 这是权限绕过，不是便利。
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
function pdfHowTo(name) {
  const q = `"${name}"`;
  const install =
    process.platform === "darwin"
      ? "`brew install poppler`"
      : process.platform === "win32"
        ? "`scoop install poppler` 或 `choco install poppler`"
        : "`apt install poppler-utils`（或 `dnf install poppler-utils`）";
  return (
    `PDF 取文字要靠 pdftotext：先 run_shell 跑 \`${process.platform === "win32" ? "where" : "which"} pdftotext\`，` +
    `装了就 \`pdftotext -layout ${q} -\`；没装先装 ${install}。` +
    `装不上就直说装不上，别自己写代码解析——run_node 里没有任何 PDF 库。`
  );
}

/** 一串 run 拼成纯文本。加粗/斜体这些格式对模型没意义，丢掉 */
const runsText = (runs) => (runs || []).map((r) => String(r.s || "")).join("");

function docToText(d) {
  const out = [];
  for (const b of d.blocks || []) {
    if (b.t === "img") { out.push("［图片］"); continue; } // 绝不把 data URI 拼进上下文
    if (b.t === "table") {
      for (const row of b.rows || []) out.push("| " + row.map((c) => runsText(c.runs).replace(/\n/g, " ")).join(" | ") + " |");
      out.push("");
      continue;
    }
    const s = runsText(b.runs);
    if (!s.trim()) { out.push(""); continue; }
    if (b.t === "h") out.push("#".repeat(Math.min(6, Number(b.lvl) || 1)) + " " + s);
    else if (b.t === "li") out.push("  ".repeat(Number(b.lvl) || 0) + "- " + s);
    else out.push(s);
  }
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
  const { previewData } = require("./preview");
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
  return { ...result, ...(diff ? { diff } : {}), ...(entry ? { ckpt: entry.id } : {}) };
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
function planEdit(src, label, { old_text, new_text, replace_all }) {
  const needle = String(old_text == null ? "" : old_text);
  const repl = String(new_text == null ? "" : new_text);
  if (!needle) throw new Error("old_text 是空的：edit_file 必须给出要被替换掉的原文");
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
      // new_text 是空的 = 要把这几行删掉，别塞一个空行进去
      const body = repl === "" ? [] : shiftIndent(lines[start], needle.split("\n")[0], repl).split("\n");
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
  return fs.readFileSync(file, "utf8");
}

/** 读 → 算 → 写一步到位。不用过审批的调用方和测试用这个 */
function editFile(file, label, input) {
  const plan = planEdit(readSource(file, label), label, input);
  if (!plan.noop) fs.writeFileSync(file, plan.out, "utf8");
  return plan.msg;
}

/**
 * 写完/改完立刻做一次自检。
 *
 * 「改完自检」写在提示词里是没用的——模型该忘还是忘，坏文件就这么交出去了。
 * 所以把它挪到工具里：写完当场查，坏了当场把错误和行号顶回去，它想装看不见都不行。
 * 只查便宜且确定的东西（语法、结构），不做风格评判。
 */
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
 */
function selfCheck(file, rel, partial = false) {
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
      if (partial && looksUnfinished(msg)) return ok();
      return bad(`\n注意：JS 语法没过：\n${msg}\n先修好再往下走（用 edit_file 改那一行，别整篇重写）。`);
    }
    return ok();
  }
  if (ext === ".py") {
    // 用 ast.parse 而不是 py_compile：后者会往 __pycache__ 写 .pyc 污染工作目录。
    // 本机没 python3 / spawn 失败一律跳过，环境问题不能报成语法错误
    try {
      const r = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())", file], { encoding: "utf8", timeout: 15000 });
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
      const r = spawnSync(ext === ".zsh" ? "zsh" : "bash", ["-n", file], { encoding: "utf8", timeout: 10000 });
      if (r.status !== 0 && r.stderr) {
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

/**
 * 隐藏窗口用完的收尾。要不要顺手退掉整个应用，只看主窗口还在不在。
 *
 * 老写法是「当前一个窗口都不剩就 app.quit()」。可我们刚刚亲手销毁了自己那个隐藏窗口，
 * 这个条件在「主窗口没开着」的任何时刻都成立——于是一个验收网页的工具会顺手把整个进程
 * 结束掉。桌面版正常开着主窗口时碰不到，但服务端跑在 Electron 里而没有主窗口的形态
 * （评测、脚本、自动化宿主）一验页面就自杀，而且是静默的：调用方只看到任务没了。
 * 真正要防的是「渲染期间用户把主窗口关了，window-all-closed 触发那会儿这个隐藏窗口还
 * 活着，于是没退成」，所以判据改成**主窗口曾经存在且已经没了**；从来就没有过主窗口 =
 * 有意的无头宿主，不许动它。
 */
function closeHiddenWindow(win, electron) {
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {}
  const main = global.__wbWin;
  if (main && main.isDestroyed() && !electron.BrowserWindow.getAllWindows().length) electron.app.quit();
}

/**
 * 页面自己打的日志才算数。Electron 会往每一个 file:// 页面注入它自己的
 * 「Insecure Content-Security-Policy」安全警告（sourceId = node:electron/…），
 * 真实数据里 check_page 的 8 次「控制台报错」有 7 次就是它——一张完全干净的
 * 页面也照报，模型于是掉头去改一张本来没病的页面。它是开发期提示，跟交付出去
 * 的 HTML 无关，必须在这一层滤掉。
 */
function isRuntimeNoise(sourceId, message) {
  return (
    /^(node:electron|devtools:|chrome-extension:)/.test(String(sourceId || "")) ||
    /Electron Security Warning/.test(String(message || ""))
  );
}

/**
 * console-message 有两套签名：Electron 36 起是单个事件对象（level 是
 * 'error'/'warning' 字符串），老的位置参数（level 0-3）虽然还在但已标 deprecated。
 * 两套都认——哪天上游把老参数删了，这里静默瞎掉比报错更糟：check_page 的
 * 主要价值就是抓控制台报错，抓不到却回「控制台没有报错」是假绿。
 */
function readConsoleEvent(args) {
  const ev = args[0] || {};
  const level = typeof ev.level === "string" ? ev.level
    : ["debug", "info", "warning", "error"][Number(args[1])] || "info";
  const message = typeof ev.message === "string" ? ev.message
    : typeof args[2] === "string" ? args[2] : "";
  const sourceId = ev.sourceId || (typeof args[4] === "string" ? args[4] : "");
  return { level, message, sourceId };
}

/** 控制台里 %c 是给样式用的，取出来只会让报错更难读 */
function cleanConsoleText(msg) {
  return String(msg).replace(/%c/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
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
  const errs = [], warns = [];
  try {
    // 控制台报错是白屏的头号原因，光看源码看不出来
    win.webContents.on("console-message", (...args) => {
      const { level, message, sourceId } = readConsoleEvent(args);
      if (level !== "error" && level !== "warning") return;
      if (isRuntimeNoise(sourceId, message)) return;
      (level === "error" ? errs : warns).push(cleanConsoleText(message));
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => errs.push(`资源加载失败 ${desc}（${String(url).slice(0, 80)}）`));
    await win.loadURL("file://" + file);
    await new Promise((r) => setTimeout(r, 1200));
    const info = await win.webContents.executeJavaScript(
      "({ t: document.title || '', n: (document.body ? document.body.innerText : '').trim().length, h: document.body ? document.body.scrollHeight : 0 })"
    );
    lines.push(`\n【浏览器实测】标题「${info.t}」· 可见正文 ${info.n} 字 · 页面高 ${info.h}px`);
    if (info.n < 20) lines.push("- [错] 打开后几乎没有可见内容（白屏）。多半是 JS 报错或 CSS 把内容藏了。");
    if (errs.length) lines.push(`- [错] 控制台报错 ${errs.length} 条：\n  ${errs.slice(0, 5).join("\n  ")}`);
    if (warns.length) lines.push(`- [警] 控制台警告 ${warns.length} 条（不一定要改，白屏无关）：\n  ${warns.slice(0, 3).join("\n  ")}`);
    if (!errs.length && !warns.length) lines.push("- 控制台没有报错");
  } catch (e) {
    lines.push(`\n【浏览器实测】打开失败：${e.message}`);
  } finally {
    closeHiddenWindow(win, electron);
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
async function searchFiles(root, { query, regex, ext, max }) {
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
    bytes = 0,
    truncated = false, // 命中够数了（这是好事）
    overBudget = ""; // 预算烧完了，树还没走完（这个必须告诉模型）
  const deadline = Date.now() + SEARCH_BUDGET.ms;
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
      if (st.size > 2 * 1024 * 1024) continue; // 大文件多半是产物/数据，不是要找的代码
      if (scanned >= SEARCH_BUDGET.files) { overBudget = `扫到 ${SEARCH_BUDGET.files} 个文件的上限`; return; }
      if (bytes >= SEARCH_BUDGET.bytes) { overBudget = `读到 ${(SEARCH_BUDGET.bytes / 1048576).toFixed(1)}MB 的上限`; return; }
      if (Date.now() > deadline) { overBudget = `搜了 ${(SEARCH_BUDGET.ms / 1000).toFixed(1)} 秒还没走完`; return; }
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
      if (sinceYieldFiles >= SEARCH_YIELD_FILES || sinceYieldBytes >= SEARCH_YIELD_BYTES) await breathe();
    }
  })(root);
  const scale = `扫了 ${scanned} 个文本文件、${(bytes / 1048576).toFixed(1)}MB`;
  // 没扫完的实话 + 下一步怎么办：光说「没扫完」模型只会原样再搜一遍
  const narrow = `——用 dir 指到具体子目录，或用 ext 限类型（比如 ext="js,ts"）再搜一遍`;
  if (!hits.length) {
    return overBudget
      ? `（没搜完就停了：${overBudget}，${scale}，还没搜到「${q}」。这**不代表没有**${narrow}）`
      : `（没搜到「${q}」，${scale}）`;
  }
  return (
    hits.join("\n") +
    (truncated
      ? `\n（到 ${limit} 条上限了，后面还有没列出来的——把关键词写细，或用 dir/ext 缩范围）`
      : overBudget
        ? `\n（共 ${hits.length} 条，但没搜完就停了：${overBudget}，${scale}${narrow}）`
        : `\n（共 ${hits.length} 条，${scale}）`)
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
    closeHiddenWindow(win, electron);
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

async function webSearch(query, count, searchCfg, hold) {
  const n = Math.min(Math.max(+count || 5, 1), 10);
  const cfg = searchCfg || {};
  const provider = (cfg.provider || "jina").toLowerCase();

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
    if (!fn || !key) continue;
    try {
      const items = await fn(key, query, n);
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

/**
 * 花钱的那三样（生图 / 生视频 / 配音）统一过一道生成结果缓存。
 *
 * 只包这三个，别的一个都不包：html_to_image 在本机渲染、不花钱，而且它的输入是一个
 * HTML 文件——同名文件内容天天在变，按参数算 key 一定会拿旧图冒充新图。
 * transcribe_audio 也不包：它的产物是文字，本来就便宜，而且模型经常改 with_timestamps
 * 再跑一遍，缓存在这儿帮不上忙。
 *
 * 渠道没配好 / 型号点错时故意不算 key：让真正的那一趟去报错——它的话说得比这里清楚得多。
 */
async function withGenCache(kind, cap, opts, input, dir, resolveFile, hold, run) {
  let k = null, model = "";
  try {
    const cfg = mediaModels.pick(opts.media, cap, input.model);
    model = cfg.model;
    k = genCache.key(kind, input, cfg, dir, resolveFile, ws());
  } catch {
    k = null;
  }
  if (k) {
    const hit = genCache.get(k, ws());
    if (hit) {
      // 命中缓存 = 一个子儿没花，所以刚才那笔预扣要当场退回去。
      // 不退的话，一个反复重跑同一张图的任务会把预算“占”到拦人，而账单上什么都没发生。
      quota.undo(hold);
      security.audit(kind === "text_to_speech" ? "语音合成" : kind === "generate_video" ? "视频生成" : "图像生成",
        `复用上次的产物（参数逐字一样，没有再调 ${model}）→ ${hit.file}`, "放行");
      return hit;
    }
  }
  let out;
  try {
    out = await run();
  } catch (e) {
    quota.undo(hold);   // 没发出去就不该占着预算
    throw e;
  }
  // 记账放在这儿而不是调用点：上面命中缓存的那条路径直接 return 了，一个子儿没花。
  // 记在调用点的话，同一张图重跑十次会记十笔，而实际只付了一次钱
  if (!out.isError) {
    quota.record(cap, {
      provider: mediaProviderOf(opts.media, cap), model,
      units: unitsFor(cap, input, resolveFile),
      meta: String(input.prompt || input.text || "").slice(0, 80), hold,
    });
  } else {
    quota.undo(hold);   // 渠道挂了 / 参数错了，同样一分没花
  }
  if (k) genCache.put(k, out, dir, ws(), model);
  return out;
}

/**
 * 这一趟按量计费的话，量是多少（张 / 秒 / 千字符 / 分钟）。
 *
 * 三个估值都把依据写在这儿，因为它们会直接变成后台那张表上的钱：
 *
 *   视频：工具没开 duration 参数，各家默认都是 5 秒，所以按 5 秒记。
 *          哪天把 duration 放进 schema 了，这一行跟着改。
 *   语音：字符数是准的，按字符算就行——各家计费用的也是字符数。
 *   转写：发出去之前唯一能知道的只有文件大小，所以按 128kbps（≈16 KB/秒）折成分钟。
 *          压过的 16k 单声道文件会被算少，没压过的会被算多，误差在一倍以内。
 *          要精确到秒得先拆音频头，而那要为每一次转写多读一遍文件——不值。
 */
function unitsFor(cap, input = {}, resolveFile) {
  if (cap === "image") return Math.max(1, Math.floor(+input.n || 1));
  if (cap === "video") return Math.max(1, +input.duration || 5);
  if (cap === "tts") return Math.max(0.001, String(input.text || "").length / 1000);
  if (cap === "asr") {
    try {
      const st = fs.statSync(resolveFile(String(input.path || input.file || "").trim()));
      return Math.max(0.1, st.size / 16000 / 60);
    } catch { return 1; }
  }
  return 1;
}

/** 这一路当前走的是哪家服务商——只为流水好看，取不到就空着，绝不因此中断调用 */
function mediaProviderOf(media, cap) {
  try { return String(mediaModels.pick(media, cap).provider || "").slice(0, 40); } catch { return ""; }
}
/** 转写这一路真正用的型号。计价要拿它去查价，而调用方常常不写 model（走默认那个） */
function asrModelOf(media, want) {
  try { return String(mediaModels.pick(media, "asr", want).model || "").slice(0, 60); } catch { return String(want || ""); }
}
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
    const want = mediaModels.mismatch(cfg.kind || mediaModels.guessKind(cfg.base_url), cfg.model);
    if (want) {
      const capCn = mediaModels.CAP_CN[cap] || cap;
      const res = { content:
        `${capCn}用不了：型号「${cfg.model}」是${mediaModels.kindLabel(want)}家的，现在却挂在` +
        `${mediaModels.kindLabel(cfg.kind || mediaModels.guessKind(cfg.base_url))}那条渠道上——这个型号不存在于那条渠道，调过去只会报错。\n` +
        `请用户去 设置 → 模型 → ${capCn}，把它改挂到${mediaModels.kindLabel(want)}的渠道（没有就先加一条），或者换一个这条渠道上有的型号。\n` +
        `这一步不用重试，也别换参数再试——换什么参数都一样。`, isError: true };
      mediaHealth.record(cap, cfg, res);
      return res;
    }
  }
  const res = await run();
  if (cfg && cfg.base_url) mediaHealth.record(cap, cfg, res);
  return res;
}

const CANVAS_KINDS = new Set(["note", "script", "agent", "character", "location", "storyboard", "scene", "shot", "image", "video", "audio", "timeline"]);
// 连线不是纯视觉箭头：用途会进入生成请求、Trace 与下一次 Agent 会话。
// 白名单既让旧画布兼容，也避免把任意对象原样写进项目状态。
const CANVAS_EDGE_RELATIONS = new Set(["input", "split", "generate", "character", "background", "composition", "motion", "style", "prop", "continuity", "first_frame", "last_frame", "audio", "reference"]);
const CANVAS_MAX_NODES = 500;
const CANVAS_MAX_EDGES = 1200;

function canvasSafeName(value) {
  const name = String(value || "main").trim();
  if (!name || name === "." || name === ".." || name.length > 80 || /[\\/\\0]/.test(name)) return "main";
  return name;
}
function canvasCurrentPath() { return path.join(ws(), ".openworkbuddy", "canvas-current.json"); }
function canvasCurrentName() {
  try { return canvasSafeName(JSON.parse(fs.readFileSync(canvasCurrentPath(), "utf8")).name); } catch { return "main"; }
}
function canvasSetCurrentName(name) {
  const dir = path.dirname(canvasCurrentPath()); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(canvasCurrentPath(), JSON.stringify({ name: canvasSafeName(name), updatedAt: Date.now() }), "utf8"); return canvasSafeName(name);
}
function canvasStatePath(name = canvasCurrentName()) {
  const safe = canvasSafeName(name);
  return safe === "main" ? path.join(ws(), ".openworkbuddy", "canvas.json") : path.join(ws(), ".openworkbuddy", "canvases", safe + ".json");
}
function canvasEmptyState() { return { version: 1, nodes: [], edges: [], updatedAt: 0 }; }
/**
 * 规整画布状态 —— 这一层只管「把形状理顺」，不管「这条数据配不配存在」。
 *
 * 以前它兼着当校验器：不认识的节点类型直接扔掉、超过 500 个的节点直接截断。
 * 问题是它同时站在读和写两条路上，于是「读一遍」本身就会掉东西，而界面拖一下节点
 * 就会把读出来的残缺状态原样回存。实测三条路都能把用户的画布吃掉：
 *   · 600 个节点的画布，读出来 500 个，回存之后盘上就真只剩 500 个；
 *   · 老版本写的画布里有这个版本不认识的类型，3 个节点读出来只剩 1 个；
 *   · 文件坏了（写一半断电）读出来是空画布，回存直接把残骸盖成 []。
 * 用户升级完打开画布发现东西没了，就是这么没的。
 *
 * 所以规矩改成：**序列化不许挑食，校验挪到真正新建数据的地方**（add 那边本来就查
 * CANVAS_KINDS，connect 那边本来就查 CANVAS_EDGE_RELATIONS，那才是该拦的地方）。
 * 这里只做三件不会丢东西的事：补全缺的字段、把类型强制成字符串/数字、去掉挂空的连线。
 *
 * lost 传个对象进来就能拿到「这一趟少了什么」的账，界面据此提醒用户，而不是默默抹掉。
 */
function canvasNormalizeState(value, lost = null) {
  const raw = value && typeof value === "object" ? value : {};
  const note = (k, n) => { if (lost && n > 0) lost[k] = (lost[k] || 0) + n; };
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  // 连 id 都没有的才丢——没有 id 的节点没法引用、没法连线，留着也指不到它
  const usable = rawNodes.filter((node) => node && node.id);
  note("noId", rawNodes.length - usable.length);
  const nodes = usable.map((node) => ({
    // kind 照原样留着，哪怕这个版本不认识：可能是老版本建的，也可能是用户装了别的版本。
    // 认不出来就在界面上画成一张「这个版本不认识的节点」的占位卡，绝不替用户删。
    // 只掐长度，免得有人往里塞一整篇文章当类型名
    id: String(node.id), kind: String(node.kind || "note").slice(0, 40),
    payload: node.payload && typeof node.payload === "object" ? node.payload : {},
    position: { x: Number(node.position && node.position.x) || 0, y: Number(node.position && node.position.y) || 0 },
    size: node.size && typeof node.size === "object" ? { width: Number(node.size.width) || undefined, height: Number(node.size.height) || undefined } : undefined,
  }));
  // 超上限只记账、不截断。上限该拦的是「再往里加」（见 add），不是「你已经有的」——
  // 一张叫「无限画布」的东西，打开自己的旧文件反而被删到 500 个，说不过去
  note("overflowNodes", Math.max(0, nodes.length - CANVAS_MAX_NODES));
  const ids = new Set(nodes.map((node) => node.id));
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  // 连线两头必须都还在，且不能自己连自己——这条是真的完整性，留着也画不出来
  const liveEdges = rawEdges.filter((edge) => edge && ids.has(edge.source?.id || edge.source) && ids.has(edge.target?.id || edge.target) && (edge.source?.id || edge.source) !== (edge.target?.id || edge.target));
  note("danglingEdges", rawEdges.length - liveEdges.length);
  note("overflowEdges", Math.max(0, liveEdges.length - CANVAS_MAX_EDGES));
  const edges = liveEdges.map((edge) => {
    // 用途同理：不认识的照留，别把用户标好的关系悄悄抹成一根没名字的线
    const relation = String(edge.relation || edge.role || "").slice(0, 40);
    return { source: { id: String(edge.source?.id || edge.source) }, target: { id: String(edge.target?.id || edge.target) }, ...(relation ? { relation } : {}) };
  });
  return { version: 1, nodes, edges, updatedAt: Number(raw.updatedAt) || 0 };
}
/** 把一份读不动的画布文件原样挪到一边，绝不在它上面写东西。返回备份路径。 */
function canvasBackup(file, why) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bak = `${file}.${why}-${stamp}.bak`;
  try { fs.copyFileSync(file, bak); return bak; } catch { return ""; }
}
/**
 * 读画布。
 *
 * 「文件不存在」和「文件读不出来」是两件完全不同的事，以前一个 catch 全吞了，
 * 两种都当空画布返回。后一种返回空画布是会要命的：界面显示一张白板，用户在白板上
 * 随便动一下，自动保存就把真文件盖成空的。所以现在只有 ENOENT 才算空画布，
 * 其余一律抛出来，让界面显示「读不出来」而不是「是空的」。
 */
function canvasReadState(name = canvasCurrentName(), lost = null) {
  const file = canvasStatePath(name);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return canvasEmptyState();   // 还没建过——这才是真的空画布
    throw new Error(`画布文件读不出来（${file}）：${e.message}。没有当成空画布，免得下一次保存把它盖掉。`);
  }
  try { return canvasNormalizeState(JSON.parse(text), lost); } catch (e) {
    const bak = canvasBackup(file, "坏了");
    throw new Error(`画布文件不是完整的 JSON，多半是上次写到一半断了（${file}）：${e.message}。` +
      (bak ? `原文件已原样备份到 ${path.basename(bak)}，一个字节都没动。` : "备份也没做成，请先手动把这个文件复制一份再说。"));
  }
}
function canvasWriteState(value, name = canvasCurrentName()) {
  const state = canvasNormalizeState(value); state.updatedAt = Date.now();
  const active = canvasSetCurrentName(name), file = canvasStatePath(active), dir = path.dirname(file), tmp = file + "." + process.pid + ".tmp";
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  // 覆盖之前留一代。就一个文件、每次覆盖，不会越攒越多，但「刚才那一下把画布搞没了」
  // 总有一步能退回去。画布是用户一笔一笔摆出来的，没有回收站，出事就是白干
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); } catch {}
  fs.renameSync(tmp, file);
  return state;
}
function canvasList() {
  const dir = path.join(ws(), ".openworkbuddy", "canvases"), out = [], add = (name, file) => {
    let stat = null, state = canvasEmptyState(), broken = "";
    try { stat = fs.statSync(file); } catch {}
    // 读不出来的画布在列表里要显出来是「读不出来」，不能显示成「0 个节点」——
    // 后者看着就像一张空画布，用户会直接点进去开始画，然后把它盖掉
    try { state = canvasReadState(name); } catch (e) { broken = e.message; }
    out.push({ name, title: name === "main" ? "主画布" : name, nodes: state.nodes.length, updatedAt: state.updatedAt || (stat ? stat.mtimeMs : 0), ...(broken ? { broken } : {}) });
  };
  const legacy = path.join(ws(), ".openworkbuddy", "canvas.json"); if (fs.existsSync(legacy)) add("main", legacy);
  try { fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => { if (entry.isFile() && /\.json$/i.test(entry.name)) add(entry.name.replace(/\.json$/i, ""), path.join(dir, entry.name)); }); } catch {}
  if (!out.length) out.push({ name: "main", title: "主画布", nodes: 0, updatedAt: 0 });
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function canvasManage(input = {}) {
  const op = String(input.operation || "get");
  const canvasName = canvasSafeName(input.canvas_name || canvasCurrentName());
  if (op === "list") return { content: JSON.stringify({ current: canvasCurrentName(), canvases: canvasList() }), isError: false };
  let state;
  // 读不出来要当场告诉 agent，而不是递给它一张空画布——递空的，它会「好心」地
  // 重新建一遍节点，一存就把原文件盖了
  try { state = canvasReadState(canvasName); } catch (e) { return { content: e.message, isError: true }; }
  if (op === "get") return { content: JSON.stringify({ canvas_name: canvasName, version: state.version, updatedAt: state.updatedAt, nodes: state.nodes, edges: state.edges }), isError: false };
  if (op === "clear") { state = canvasWriteState(canvasEmptyState(), canvasName); return { content: `画布 ${canvasName} 已清空（${state.updatedAt}）。`, isError: false }; }
  if (op === "add") {
    const kind = String(input.kind || ""); if (!CANVAS_KINDS.has(kind)) return { content: `不支持的画布节点类型：${kind}`, isError: true };
    const id = String(input.node_id || `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
    if (state.nodes.some((node) => node.id === id)) return { content: `节点 id 已存在：${id}`, isError: true };
    // 上限拦在「往里加」这一步。以前是在序列化时截断，等于替用户删已有的节点；
    // 拦在这儿最多是加不进去，一个字节都不会少
    if (state.nodes.length >= CANVAS_MAX_NODES) return { content: `画布 ${canvasName} 已经有 ${state.nodes.length} 个节点，到上限 ${CANVAS_MAX_NODES} 了，加不进去。先删掉些用不上的，或者换一张画布（canvas_name 换个名字就是新的一张）。`, isError: true };
    state.nodes.push({ id, kind, payload: input.payload && typeof input.payload === "object" ? input.payload : {}, position: { x: Number(input.position?.x) || 120 + (state.nodes.length % 4) * 390, y: Number(input.position?.y) || 120 + Math.floor(state.nodes.length / 4) * 300 } });
    state = canvasWriteState(state, canvasName); return { content: `已添加${kind}节点 ${id} 到画布 ${canvasName}。`, isError: false };
  }
  if (op === "update") {
    const node = state.nodes.find((item) => item.id === String(input.node_id || "")); if (!node) return { content: `找不到节点：${input.node_id || "（空）"}`, isError: true };
    if (input.payload && typeof input.payload === "object") node.payload = { ...node.payload, ...input.payload };
    if (input.position && typeof input.position === "object") node.position = { x: Number(input.position.x) || node.position.x, y: Number(input.position.y) || node.position.y };
    state = canvasWriteState(state, canvasName); return { content: `已更新节点 ${node.id}。`, isError: false };
  }
  if (op === "connect") {
    const source = String(input.source_id || ""), target = String(input.target_id || "");
    if (!state.nodes.some((node) => node.id === source) || !state.nodes.some((node) => node.id === target)) return { content: "connect 需要存在的 source_id 和 target_id。", isError: true };
    if (source === target) return { content: "不能把节点连接到自己。", isError: true };
    const relation = String(input.relation || "");
    if (relation && !CANVAS_EDGE_RELATIONS.has(relation)) return { content: `不支持的连线用途：${relation}`, isError: true };
    // 同 add：上限拦在这一步，不在序列化时截断
    if (state.edges.length >= CANVAS_MAX_EDGES) return { content: `画布 ${canvasName} 的连线已经到上限 ${CANVAS_MAX_EDGES} 条了，连不上去。先删掉些用不上的连线。`, isError: true };
    const existing = state.edges.find((edge) => edge.source.id === source && edge.target.id === target);
    if (existing) { if (relation) existing.relation = relation; }
    else state.edges.push({ source: { id: source }, target: { id: target }, ...(relation ? { relation } : {}) });
    state = canvasWriteState(state, canvasName); return { content: `已连接 ${source} → ${target}。`, isError: false };
  }
  if (op === "delete") {
    const id = String(input.node_id || ""), before = state.nodes.length; state.nodes = state.nodes.filter((node) => node.id !== id); state.edges = state.edges.filter((edge) => edge.source.id !== id && edge.target.id !== id);
    if (state.nodes.length === before) return { content: `找不到节点：${id}`, isError: true };
    state = canvasWriteState(state, canvasName); return { content: `已删除节点 ${id} 及其连线。`, isError: false };
  }
  return { content: `不支持的画布操作：${op}`, isError: true };
}

async function executeTool(name, input, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  // 安全中心策略（settings 里配置）；未传时用纯默认值（等价于旧行为 + 默认黑名单）
  const sec = opts.security || { ...security.DEFAULTS };
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
  const resolveFile = (rel) => {
    // 少给 path 是模型真会犯的错（本机 96 段会话里 7 次：write_file 2 次、edit_file 5 次，
    // 多半是参数 JSON 太长被截断，或者干脆漏了这一项）。老写法把空路径解析成工作目录本身，
    // 下游抛一句 `EISDIR: illegal operation on a directory, open '/Users/…/workbuddy-clone-master'`——
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
      if (!path.isAbsolute(s0) && (s0 === baseName || s0.startsWith(baseName + "/"))) {
        const fixed = s0.slice(baseName.length).replace(/^\/+/, "");
        console.warn(`[tools] ${name}: 路径多套了一层成果目录，已纠正 ${s0} → ${fixed || "."}`);
        rel = fixed || ".";
      }
    }
    const r = security.resolvePathWithPolicy(sec, rel, ws(), fileBase);
    if (!r.allowed) {
      security.audit("文件拦截", `${name}: ${rel}`, "拦截");
      throw new Error(`文件访问被安全中心拦截：${r.reason}`);
    }
    // 成果子目录下没有、工作空间根下有 → 用根下那个（读旧对话的产物/共享素材不用写全路径）
    // 兜底只认文件：兜到一个同名目录上，下游就是一句莫名其妙的 EISDIR
    if (fileBase !== ws() && !fs.existsSync(r.path)) {
      const r2 = security.resolvePathWithPolicy(sec, rel, ws());
      try {
        if (r2.allowed && fs.statSync(r2.path).isFile()) return r2.path;
      } catch {}
    }
    return r.path;
  };
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
    // 参数压根不是合法 JSON（llm.js 解析失败时会塞一个 _raw 进来）。
    // 不拦的话会一路走到各工具的必填校验，报出来的是「缺少 prompt」这种话——
    // 模型看了以为自己漏填字段，于是把同样的东西原样再发一遍，接着再坏一次。
    if (input && typeof input === "object" && typeof input._raw === "string") {
      return { content: badToolArgs(name, input._raw, input._parseError, input._rawLen), isError: true };
    }
    switch (name) {
      case "canvas_manage":
        return canvasManage(input);
      case "run_node": {
        if (orgBlocksShell()) return shellBlocked("run_node");
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
        if (orgBlocksShell()) return shellBlocked("run_shell");
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
        const body = String(input.content || "");
        const n = Buffer.byteLength(body);
        // 落盘之前先把 diff 算出来：审批卡上要给人看这次到底动了哪几行，看着批才算批
        const was = readBefore(p);
        const blocked = await passGate(security.checkWrite(sec, rel), "写文件", rel, {
          force: true,
          detail: diffText(rel, was, input.append ? Buffer.concat([was || Buffer.alloc(0), Buffer.from(body, "utf8")]) : body),
        });
        if (blocked) return blocked;
        const existed = fs.existsSync(p);
        if (existed && fs.statSync(p).isDirectory()) return { content: dirInsteadOfFile(p, rel).message, isError: true };
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
          fs.appendFileSync(p, body, "utf8");
          const c = selfCheck(p, rel, true);
          return noteChange(
            { content: `已追加到 ${rel}（+${n} 字节，现共 ${fs.statSync(p).size} 字节）${c.note}`, isError: c.bad },
            { ...change, after: Buffer.concat([before || Buffer.alloc(0), Buffer.from(body, "utf8")]) }
          );
        }
        fs.writeFileSync(p, body, "utf8");
        const c = selfCheck(p, rel);
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
        const p = resolveFile(rel);
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
        const c = selfCheck(p, rel);
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
        const s = Math.max(0, Number(input.start_line) || 0);
        const e = Math.max(0, Number(input.end_line) || 0);
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
      case "list_files":
        return { content: listFiles(resolveFile(input.dir || "."), input.depth), isError: false };
      case "search_files":
        return { content: await searchFiles(resolveFile(input.dir || "."), input), isError: false };
      case "chrome_cdp": {
        const action = String(input.action || "list_tabs");
        if (action === "navigate" && !/^https?:\/\//i.test(String(input.url || ""))) {
          return { content: "navigate 只接受 http/https URL。", isError: true };
        }
        const r = await cdp.run(input);
        if (action === "screenshot") {
          const rel = String(input.path || "chrome-screenshot.png").replace(/^[/\\]+/, "");
          const p = resolveFile(rel);
          const blocked = await passGate(security.checkWrite(sec, rel), "写截图", rel, { force: true });
          if (blocked) return blocked;
          fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.from(r.data, "base64"));
          return { content: `已保存 Chrome 截图：${rel}（${Math.round(fs.statSync(p).size / 1024)}KB，tab ${r.tab_id}）`, isError: false };
        }
        return { content: JSON.stringify(r, null, 2), isError: false };
      }
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
        const dir = dataPath("skills", name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "skill.md"), input.content, "utf8");
        return { content: `技能「${name}」已保存并生效（skills/${name}/skill.md）`, isError: false };
      }
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
        return await viaMedia("vision", opts, input, () => lookAtImage(opts, input, timeoutMs, resolveFile));
      case "generate_image": {
        const g = quotaGate("image", { model: input.model, units: unitsFor("image", input) });
        if (g.bad) return g.bad;
        return await viaMedia("image", opts, input, () => withGenCache("generate_image", "image", opts, input, fileBase, resolveFile, g.hold,
          () => generateImage(opts.media, input, timeoutMs, fileBase, resolveFile)));
      }
      case "generate_video": {
        const g = quotaGate("video", { model: input.model, units: unitsFor("video", input) });
        if (g.bad) return g.bad;
        return await viaMedia("video", opts, input, () => withGenCache("generate_video", "video", opts, input, fileBase, resolveFile, g.hold,
          () => generateVideo(opts.media, input, { ...opts, saveDir: fileBase, resolveFile })));
      }
      case "html_to_image":
        return await htmlToImage(input, resolveFile, fileBase);
      case "text_to_speech": {
        const g = quotaGate("tts", { model: input.model, units: unitsFor("tts", input) });
        if (g.bad) return g.bad;
        return await viaMedia("tts", opts, input, () => withGenCache("text_to_speech", "tts", opts, input, fileBase, resolveFile, g.hold,
          () => textToSpeech(opts.media, input, timeoutMs, fileBase)));
      }
      case "transcribe_audio": {
        const mins = unitsFor("asr", input, resolveFile);
        const g = quotaGate("asr", { model: input.model, units: mins });
        if (g.bad) return g.bad;
        const r = await viaMedia("asr", opts, input, () => transcribeAudio(opts.media, input, timeoutMs, resolveFile, fileBase));
        if (!r.isError) {
          quota.record("asr", {
            provider: mediaProviderOf(opts.media, "asr"), model: asrModelOf(opts.media, input.model),
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
        const g = quotaGate("search", { provider: (opts.search && opts.search.provider) || "jina" });
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
    return { content: `工具执行出错: ${e.message}`, isError: true };
  }
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
  const SKIP = new Set([".tmp", ".openworkbuddy", "node_modules", ".git"]);
  // 服务端自己的运行数据（im-log.json、audit.json、会话、审计、记忆向量…全在 data/ 下）不是
  // 用户的成果文件。工作目录指到工程上层时（workspace_dir=/Users/bryce/startup_get），这批文件
  // 会被 walk 进「可交付列表」，两个后果：①IM 附件逻辑「回复里点名的文件自动附上」把内部日志
  // 发进了用户手机；②任务期间日志被写、mtime 变动，「本回合产出」也会把它们当成新产出。
  // data/ 只装运行状态、永远不会是交付物，整目录排除；用户自己项目里的 data/ 文件夹不受影响
  // （只排除「恰好等于 DATA_DIR/data」的那一个路径）。
  const APP_DATA_DIR = dataPath("data") + path.sep;
  (function walk(dir, rel, depth) {
    if (depth > 3 || all.length >= WALK_CAP) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (all.length >= WALK_CAP) return;
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (full + path.sep === APP_DATA_DIR) continue; // 服务端运行数据目录：不算交付物
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

module.exports = {
  _internals: { searchFiles, readBigFile, SEARCH_BUDGET, SEARCH_SKIP, SEARCH_BIN_EXT, selfCheck, auditHtml, savedAt, markDuplicates, pickShell, fetchRetry, nearestTool, lookAtImage, shrinkForVision, readImageInput, refImageUris, I2V_RE, T2V_RE, isRuntimeNoise, readConsoleEvent, cleanConsoleText, generateImage, generateVideo, textToSpeech, mediaKey, editFile, planEdit, diffText, looseLineMatch, missHint, badToolArgs, safeOutName, OUT_EXT_ALIAS, missingBinHint, NOT_FOUND_RE, transcribeAudio, srtTime, AUDIO_EXT, ASR_MAX_BYTES }, TOOL_DEFS, executeTool, badToolArgs, outputFiles, noteUserInput, moveUserInput, isUserInput, workspaceKey, workspaceKeyOf, filesScope, safePath, safePathIn, fetchUrl, renderPage, htmlToText, getWorkspaceDir, getDefaultWorkspaceDir, setWorkspaceDir, withWorkspace, enterWorkspace, setLibraryDir, getLibraryDir, withLibraryDir, libRoot, withPolicy, orgPolicy, hostAllowed, SEARCH_PROVIDERS, searchProviderKey, shellPath, canvasReadState, canvasWriteState, canvasNormalizeState, canvasList, canvasSetCurrentName, canvasManage };
