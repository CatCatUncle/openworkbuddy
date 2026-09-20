"use strict";
/**
 * Agent 核心运行时 — 被 Web 界面、IM 接入、专家委派共同复用。
 * 主 Agent 是"协调者"：可直接干活，也可通过 delegate_to_expert 把子任务委派给专家子智能体。
 */

const { TOOL_DEFS, executeTool, outputFiles, isUserInput, filesScope, getWorkspaceDir, orgPolicy, badToolArgs } = require("./tools");
const { loadSkills, SKILLS_DIR } = require("./skills");
const awake = require("./awake"); // 睡眠治理：任务期间防睡 + 睡了顺延时限
const engines = require("./engines"); // 底层引擎：内置循环 / 本机 Claude Code / 本机 Codex
const bridge = require("./engines/bridge"); // 把本项目的工具借给那两个 CLI（MCP）
const prefs = require("./prefs"); // 底层引擎 / 思考档是按账号存的，跑任务时得看**发起人**的那份
const callout = require("./callout"); // 正文里的提示条：网页画图标，终端/IM 换文字标签
const security = require("./security"); // 审计中心：对外推送这种「出了门就收不回来」的动作必须留痕
const mailer = require("./mailer"); // 发信：配没配、地址合不合法、白名单放不放行，判据只有这一份
const tracing = require("./trace"); // 执行追踪：整趟任务的模型调用/工具调用发去 Langfuse，默认关
const mediaHealth = require("./media-health"); // 媒体渠道熔断闸：开跑前先把暂停中的渠道写进提示词
const { CAP_CN } = require("./media-models");

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

const ASK_USER_TOOL = {
  name: "ask_user",
  description:
    "向用户提一个关键问题并等待回答（前端会弹出选项卡片，用户点选或输入后你才继续，等待时间不算任务时长）。两类时机要主动用：①开工前——需求含糊到可能白干一场，或风格/范围/平台/受众/篇幅这类选择会让交付物完全不同（典型：封面图是 AI 生图还是 HTML 排版截图、报告交 Word 还是 PDF 还是飞书文档、视频出横版还是竖版），先问一题再动手，比做完返工强；②执行中——要花钱、不可逆动作、覆盖/删除已有内容、对外发布，或只有用户本人知道的偏好（预算/口味/时间安排）。纯技术细节自己定，别拿它当聊天；一次只问一个问题，给 2~4 个具体可点的选项。用户可能不在电脑前：超时没人答就按你认为最合理的默认继续，并在汇报里注明。",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "要问的问题，一句话说清，别夹多个问题" },
      options: {
        type: "array",
        description: "2~4 个选项。用户也可以两个都不选、自己输入",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "选项本身，一个短语，20 字以内" },
            detail: { type: "string", description: "选了它会得到什么、代价是什么，一句话。用户就是靠这句做判断的，不许省，也不许只是把 label 换个说法重说一遍" },
          },
          required: ["label", "detail"],
        },
      },
    },
    required: ["question", "options"],
  },
};

const FEISHU_DOC_TOOL = {
  name: "feishu_doc_create",
  description:
    "把 Markdown 内容创建成一篇飞书云文档，直接交付到用户的飞书（复用已配置的飞书机器人凭证）。支持表格（markdown 表格语法）和图片：独占一行的 ![说明](工作目录里的文件或URL) 会真插成文档里的图（SVG 自动转 PNG）——先用 gen_diagram 画图再引用，报告即图文并茂。成功返回文档链接。若因权限不足失败：先把返回的开通指引和链接告诉用户，然后立刻带 wait_for_permission:true 重调本工具——它会自动轮询等用户开通，权限一生效就建好文档继续任务，用户不用回来喊你。",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "文档标题" },
      markdown: {
        type: "string",
        description:
          "文档正文 Markdown。支持标题、列表、引用、代码块、**加粗**、`行内代码`、表格（|a|b|），以及独占一行的图片 ![说明](路径或URL)。",
      },
      wait_for_permission: {
        type: "boolean",
        description: "权限不足时轮询等待用户开通（每 20 秒重试，最多约 10 分钟），开通即自动创建。只在第一次因权限失败、且已把开通指引告诉用户之后用。",
      },
    },
    required: ["title", "markdown"],
  },
};

// 界面上早就写着「任务完成推到群里」，可真能推的只有系统自己：定时任务跑完推一条、
// 自进化复盘推一条、IM 里那条链路推一条——全是 notify.pushBots 的固定调用点。
// agent 手上一个入口都没有。于是「跑完发群里」这种最普通的办公请求，它只能在回复里
// 写一句「已为你准备好，请手动发送」。webhook 明明就配在 设置 → 通知 里。
const NOTIFY_TOOL = {
  name: "notify_user",
  description:
    "把一条消息推到用户配置好的群机器人（企业微信 / 钉钉）。用户说「发到群里」「推给我」「跑完通知我」时用它。" +
    "纯文本，2000 字以内，太长就先自己缩成摘要——群消息不是交付物，链接和文件名要写全，别让人回头再找你要。",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "要推送的正文（纯文本，2000 字以内）" },
    },
    required: ["text"],
  },
};

// 「以后每天早上九点把昨天的数据整理成日报」——办公里最常听见的一句话。可在这之前 agent 只能回
// 「你去 设置 → 定时任务 里自己建一条」，而那张排期表就在同一个进程里躺着。
// 排期和别的工具不一样：它是会自己再跑起来的东西，批一次之后每天都算数。所以每一次增删改都
// 必须当场弹给用户点头（不看闸门总开关），而且定时任务自己不许再动排期表——一条任务改出另一条
// 任务，没人看着的时候会越滚越多。
/** 模型一次能把排期表撑到多大。审批那道闸已经挡住了跑飞，这条是兜底：
 *  用户连点几十次「同意」也不至于把 schedules.json 撑成一张没人看得懂的表 */
const MAX_SCHEDULES = 50;

const SCHEDULE_TOOL = {
  name: "schedule_task",
  description:
    "给这台机器排一条定时任务：到点自动叫起 agent，执行你写好的那段任务描述。\n" +
    "**先分清只跑一次还是每天都跑，这两样填不同的字段，填错了后果差很远。**\n" +
    "· 只跑一次 → 填 at，别填 cron。「五分钟后叫我」at=`+5m`；「两小时后」at=`+2h`；「明天这个点」at=`+1d`；" +
    "「下午 6 点提醒我」at=`18:00`（今天的，过了就是明天）；说全了就 at=`2026-09-19 14:05`。\n" +
    "  相对量（+5m / +2h / +1d）优先：你手上的当前时间只精确到「几点左右」，算不出「五分钟后」是几点几分，照抄用户说的那个量最准。\n" +
    "· 每天/每周反复跑 → 填 cron，别填 at。五个字段是「分 时 日 月 周」：`0 9 * * *` 每天 09:00；" +
    "`0 9 * * 1-5` 工作日 09:00；`30 18 * * 5` 每周五 18:30；`*/15 * * * *` 每 15 分钟。\n" +
    "  ★ 一次性的提醒绝不能用 cron 凑：`0 14 * * *` 是**每天 14 点都响**，用户要的只是今天那一下，往后每天都会被吵。\n" +
    "task 必须是一句能独立执行的完整指令：到点时没有任何上下文，只有这一句话。\n" +
    "  「接着上面那个」「照旧」这类写法一律无效；「飞书上叫我去准备面试了」这种转述句也无效——" +
    "到点的那个 agent 会掉头去翻飞书找原文，找不到就只能反问用户。要写成「提醒我去准备面试」这样自己就能做完的话，" +
    "上下文里已知的公司、岗位、时间一并写进去。\n" +
    "每一次增删改都会弹给用户确认，用户不点头就不生效。排之前先 list_schedules 看一眼，别排重。",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "delete", "enable", "disable"],
        description: "create=新排一条；update=改已有的（名字/时间/内容）；delete=删掉（连运行记录一起没）；enable/disable=开或关，任务本身留着",
      },
      id: { type: "string", description: "要改 / 删 / 开 / 关的任务 id（从 list_schedules 拿）。除 create 外都必填" },
      name: { type: "string", description: "任务名（可选，不写就取任务描述的前 30 字）" },
      at: {
        type: "string",
        description:
          "只跑一次的时刻，跑完自动关掉。`+5m` `+30分钟` `+2h` `+1d` 从现在往后推（首选）；`14:05` 今天这个钟点，过了顺延到明天；" +
          "`2026-09-19 14:05` 说全的时刻。和 cron 二选一，不能同时给",
      },
      cron: { type: "string", description: "反复跑用的五字段 cron：分 时 日 月 周。和 at 二选一；create 时两个必须给一个" },
      task: { type: "string", description: "到点要执行的完整任务描述。create 必填；update 时不写就不改内容" },
      catch_up: { type: "boolean", description: "错过了要不要补跑（笔记本合着盖子过一夜，晨报要不要补上）。默认 true" },
    },
    required: ["action"],
  },
};

const LIST_SCHEDULES_TOOL = {
  name: "list_schedules",
  description:
    "列出这台机器上已经排好的定时任务：id、名字、什么时候跑、到点做什么、开着还是关着、上次跑成什么样。" +
    "用户问「我都定了些什么」时用它；要排新任务之前也先看一眼，免得排重或者把已有的那条覆盖掉。",
  input_schema: { type: "object", properties: {} },
};

// 「把这份周报发给老板」——办公里另一句最常听见的话。邮件跟群推送不是一回事：群里发错了能撤回、
// 能解释，邮件出了门就在别人的收件箱里躺着了。所以这个工具比别的多两道闸：收件人白名单（在
// 设置里填，填了就是硬闸，模型绕不过）+ 每封信都当场弹给用户看全文点头（同样不看闸门总开关）。
const SEND_EMAIL_TOOL = {
  name: "send_email",
  description:
    "用用户配置好的邮箱发一封邮件。用户说「把这份报告发给 X」「邮件通知一下」「发到我邮箱」时用它。\n" +
    "正文 body 必须是纯文本，写完整——收件人看不到你和用户的对话，邮件里得能独立读懂。要排版就再给一份 html。\n" +
    "做好的文件（PPT / Word / Excel / PDF / 图）用 attachments 带上文件名，别把内容粘进正文。\n" +
    "每封信都会把收件人、主题、正文原样弹给用户确认，用户不点头就一个字也发不出去；" +
    "用户设了收件人白名单的话，不在名单里的地址在弹窗之前就被挡住，改不了也绕不过。",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: "收件人邮箱，多个用逗号隔开（最多 " + mailer.MAX_RECIPIENTS + " 个）" },
      subject: { type: "string", description: "邮件主题，一句话说清这封信是什么" },
      body: { type: "string", description: "正文（纯文本）。收件人没有上下文，写成一封能独立读懂的信" },
      html: { type: "string", description: "可选：HTML 正文。给了就同时带上，纯文本那份当降级显示用，两份内容要一致" },
      attachments: {
        type: "array",
        items: { type: "string" },
        description: "可选：要带的附件文件路径（相对本次任务的工作目录，直接写文件名即可）",
      },
    },
    required: ["to", "subject", "body"],
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
const { dataPath, DATA_DIR } = require("./paths");
const os = require("os");
const memory = require("./memory");
const evolve = require("./evolve");
const mediaModels = require("./media-models"); // 各路媒体模型：把「默认那条 + 还能选谁」一起交给工具
const scheduler = require("./scheduler"); // 排期表：只取那个插座（activeScheduler），实例是 server 插上来的

// ================= 成果核验（治「幻觉执行」） =================
// 模型有时在文本里"表演"跑命令并声称文件已生成，实际一个工具都没调。
// 收尾前核对它声称的产物是否真在磁盘上，不在就打回去要求真实执行。
/* emoji-数据区 起：CLAIM_RE 要匹配模型自己写出来的那个勾，它是待匹配的数据不是界面图形，删了就漏判「口头交付」 */
const CLAIM_RE = /(生成成功|导出成功|保存成功|创建成功|已生成|已保存|已导出|已创建|已写入|生成完毕|制作完成|下载|✅)/;
/* emoji-数据区 止 */
const DELIVER_EXTS = "pptx|pptm|docx|doc|xlsx|xls|pdf|zip|mp4|mov|png|jpe?g|gif|csv|html|md|svg";

/**
 * 工作目录里所有文件名 → 字节数。一条回复往往声称生成了好几个文件，
 * 一个名字走一遍目录树等于同一棵树扫好几遍，扫一次记下来就够了。
 */
function workspaceIndex() {
  const idx = new Map();
  let root;
  try { root = getWorkspaceDir(); } catch { return idx; }
  const stack = [[root, 0]];
  let visited = 0;
  while (stack.length && visited < 3000) {
    const [dir, d] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      visited++;
      if (e.isFile()) {
        // 同名文件出现在多个子目录时，非空的那份说了算——否则一个残留的空壳会把真交付判成"空文件"
        if (!idx.has(e.name) || idx.get(e.name) === 0) {
          try { idx.set(e.name, fs.statSync(path.join(dir, e.name)).size); } catch { idx.set(e.name, -1); }
        }
      } else if (e.isDirectory() && d < 4 && e.name !== "node_modules" && !e.name.startsWith(".")) {
        stack.push([path.join(dir, e.name), d + 1]);
      }
    }
  }
  return idx;
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
  let idx = null;
  for (const p of found) {
    let size;
    if (path.isAbsolute(p)) size = sizeOf(p);
    else if (p.startsWith("~")) size = sizeOf(path.join(os.homedir(), p.slice(1)));
    else {
      if (!idx) idx = workspaceIndex(); // 真有相对文件名要查时才扫目录
      size = idx.has(p) ? idx.get(p) : -1;
    }
    if (size < 0) bad.push({ name: p, why: "missing" });
    else if (size === 0) bad.push({ name: p, why: "empty" });
  }
  return bad;
}

/**
 * 「说自己看过图」但根本没看成 —— 这是真实翻过车的一种假交付。
 *
 * 用户让它出海报，look_at_image 那条渠道当时一直返回空正文（思考把额度吃光了，
 * 见 tools.js 里那段），11 次调用 11 次没拿到答案；模型换了几轮问法之后放弃，
 * 转头在说明文档里写下「已核对，笔画正确、无错别字」。文件是真的、图也是真的，
 * 只有那句「核对过」是编的——用户照着这句话去发图，错字就这么发出去了。
 *
 * 所以：结语里出现「肉眼/逐字核对了图上的字」这类说法，而这一趟**一次都没有
 * 成功看过图**，就打回去要求它要么真去看、要么如实说没核对过。判据故意收得很窄：
 *   1. 得同时出现「核对/确认/检查过」这类动词 和「字/笔画/错别字/文字」这类对象；
 *   2. 文中得真提到一张图片文件；
 *   3. 这一趟 look_at_image 一次都没成功（成功过就不管——那是它自己的判断，我们不替它复核）。
 * 三条缺一不放行，宁可漏也别误伤正常汇报。
 */
const VISUAL_VERB_RE = /(核对|校对|核查|确认|检查|检视|查看|看过|确认过)/;
const VISUAL_OBJ_RE = /(笔画|错别字|错字|字形|文字|字迹|文案|拼写|排版|画面)/;
const VISUAL_IMG_RE = /[\w\u4e00-\u9fff().&＆_-]+\.(?:png|jpe?g|webp|gif|svg)\b/i;
// 「没能核对」跟「已核对」长得只差一个字，判反了就是把如实交代的那一句当成撒谎打回去。
// 只认明确的否定词，别用光秃秃的「无」——「笔画正确、无错别字」里那个「无」是肯定的意思。
const VISUAL_NEG_RE = /(没能|没有|没法|没看|未能|未做|未核对|无法|不能|做不了|失败|拦了|空正文)/;

function unseenVisualClaims(text, sawImage) {
  if (sawImage) return null;
  const t = String(text || "");
  if (!t || !VISUAL_IMG_RE.test(t)) return null;
  // 动词和对象得挨在一句里才算一句「我核对过图上的字」，隔了半篇文章的两个词不算。
  // 分号不能当断句：真实那句翻车文案就是「**已核对**：…；A、B2 两版文字笔画正确…」，
  // 按分号切会把动词和对象切到两半，整条闸门就此漏掉它。
  for (const seg of t.split(/[\n。！!]/)) {
    if (VISUAL_NEG_RE.test(seg)) continue;
    if (VISUAL_VERB_RE.test(seg) && VISUAL_OBJ_RE.test(seg)) return seg.trim().slice(0, 80);
  }
  return null;
}

// ================= 收尾闸门（治「没做完就收摊」） =================
/**
 * 模型不再调工具，就等于它在说「我做完了」。但「它认为做完了」不算数：
 * 进度档里还挂着没打勾的条目，或者它自己在结语里承认还有没做的，那就是 early stop——
 * 用户交代的事只做了一半，界面上却显示任务正常结束，这是最坑人的一种失败。
 *
 * 读进度档，把没打勾的条目原样拎出来。读不到（小任务不立进度档）就返回空，
 * 空 = 「没这回事」，不是「全做完了」——没有进度档时不拦，免得把简单任务反复打回去烧钱。
 */
function unfinishedMilestones(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "PROGRESS.md"), "utf8").slice(0, 40000);
    const open = [];
    let total = 0;
    for (const line of raw.split("\n")) {
      const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)/.exec(line);
      if (!m) continue;
      total++;
      if (m[1] === " " && open.length < 40) open.push(m[2].trim().slice(0, 120));
    }
    return { open, total };
  } catch { return { open: [], total: 0 }; }
}

/**
 * 模型在结语里自己承认没做完的说法。只认「明说还没做」的措辞：
 * 「后续可以优化」「你还需要自己配一下密钥」这类交接和展望不算没做完。
 * 宁可漏判，也不能把已经做完的任务反复打回去——那是在烧用户的钱和时间。
 */
const UNFINISHED_RE = /(还(没有|没|未)(完成|做完|写完|生成|实现)|尚未完成|未能完成|没能完成|暂未完成|(剩余|剩下)的?[^。\n]{0,12}(未|没)(完成|做|写)|后续(再|会)(继续|接着)(完成|做))/;

// ================= 上下文预算（治「跑到一半突然 400」） =================
// 工具结果是上下文的绝对大头：read_file 5 万字、fetch_url 2 万字、run_shell 3 万字，
// 一个跑满 25 步的深度调研任务能堆到几十万字符，把模型上下文撑爆——表现是任务跑到一半
// 突然报 LLM 接口错误 400，前面做的全丢。这里在每次请求前把「老的」工具结果截短：
// 模型真正需要原文的是刚做完那几步，更早的它已经把结论写进自己的回复里了。
// 只截 tool 结果、不删任何消息——OpenAI 侧 tool_calls 必须有对应的 tool 消息应答，删了就是 400。
const CTX_KEEP_HEAD = 300; // 老结果保留的开头字符数（够模型认出这步干了什么）

function entryChars(e) {
  if (e.role === "user") return String(e.content || "").length;
  // Claude 路径回传的是 raw（含 thinking 块，往往比 text 大好几倍），要按真正发出去的那份算
  if (e.role === "assistant") return e.raw ? JSON.stringify(e.raw).length : String(e.text || "").length + JSON.stringify(e.toolCalls || []).length;
  let n = 0;
  if (e.role === "tool") for (const r of e.results || []) n += String(r.content || "").length;
  return n;
}
function historyChars(history) {
  let n = 0;
  for (const e of history) n += entryChars(e);
  return n;
}

// 这两个工具没有渲染器就是死的：html_to_image 张口就抛「需要桌面版环境」，
// desktop_pet 连实现都没注册。纯 node 起服务（npm start / Docker / openworkbuddy 命令行）时它们照样
// 挂在工具清单里，模型看得见就会去用——调一次、吃一条必然的失败、再重想一个方案，
// 白烧一轮，还容易被当成偶发故障去重试。定义一起摘掉才是真的关掉。
// 两条定义加起来 1900 多字符，占整份工具清单的 14%，摘掉顺带把每一步的输入都变便宜。
// 这些工具依赖 Electron/内置浏览器，纯 Node 子进程里挂出去等于挂了个必然失败的工具。
// render_page 不在这儿，是因为它已经不在工具清单里了（见 tools.js 的 TOOL_DEFS）——
// 执行入口还认这个名字，但没人会把它发给模型。
const DESKTOP_ONLY_TOOLS = ["html_to_image", "desktop_pet"];

// 同一个道理，往下再走一层：fetch_url 本身到哪儿都能用，但它的 render / wait_ms 两个参数
// 靠的是内置浏览器。没有渲染器时把参数留在清单里，模型会先 render:"force" 一次、
// 吃一条「没有内置浏览器」、再回头重想——跟摆一个必然失败的工具是一回事。
const RENDERER_PARAMS = { fetch_url: ["render", "wait_ms"] };

/** 摘掉靠渲染器才成立的参数。原定义不动（TOOL_DEFS 是共享的），只在这一份清单里换成裁过的副本 */
function dropRendererParams(defs) {
  return defs.map((t) => {
    const drop = RENDERER_PARAMS[t.name];
    if (!drop) return t;
    const props = { ...((t.input_schema || {}).properties || {}) };
    for (const k of drop) delete props[k];
    return { ...t, input_schema: { ...t.input_schema, properties: props } };
  });
}

/** 有没有真能用的渲染器。探不到就当没有——宁可少给一个工具，也不给一个必然失败的 */
function hasRenderer() {
  try { return !!require("./browser-render").available(); } catch { return false; }
}

// 「可重取」的工具结果：截掉不心疼——要用的时候再调一次工具就能拿回原文。
// 跑代码的输出/报错不在此列：那是一次性的现场证据，截掉就真没了。
const REFETCHABLE_TOOLS = new Set(["read_file", "read_document", "fetch_url", "list_files", "search_files", "library_read", "library_list", "web_search", "render_page", "check_page"]);

// 削到多低才收手。削"刚好够"是个隐形的烧钱姿势：一超预算就每步再削一点点，
// 而历史被改了一个字节，后面整段缓存前缀就作废——于是每一步都是全价重买。
// 一次削到 75% 留出空档，接下来十几步历史都是逐字不变的，缓存才吃得住。
const CTX_LOW_WATER = 0.75;

/** 就地截短老工具结果直到进预算，返回省下的字符数（0 = 本来就没超） */
function trimHistory(history, maxChars, keepRecent = 3) {
  let total = historyChars(history);
  if (total <= maxChars) return 0;
  const toolIdx = [];
  history.forEach((e, i) => { if (e.role === "tool") toolIdx.push(i); });
  // 最近 keepRecent 轮工具结果留原文，从最老的开始截
  const older = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  let saved = 0;
  // 两轮裁剪：先动可重取的，还不够再动不可重现的（老会话的结果没记工具名，归入第二轮）。
  // 低水位只用在第一轮：可重取的结果多削一点无所谓（要用再调一次工具就有），
  // 而第二轮动的是跑代码的输出那种一次性现场证据，削一个字都是净损失，够用就停。
  const passes = [
    { wants: (r) => !r.isError && REFETCHABLE_TOOLS.has(r.name), target: Math.floor(maxChars * CTX_LOW_WATER) },
    { wants: () => true, target: maxChars },
  ];
  for (const { wants, target } of passes) {
    for (const i of older) {
      for (const r of history[i].results || []) {
        if (!wants(r)) continue;
        const s = String(r.content || "");
        if (s.length <= CTX_KEEP_HEAD * 2) continue;
        r.content = s.slice(0, CTX_KEEP_HEAD) + `\n…（原输出 ${s.length} 字符，为控制上下文长度已截断。需要完整内容请重新调用工具获取。）`;
        const cut = s.length - r.content.length;
        saved += cut;
        total -= cut;
        if (total <= target) break;
      }
      if (total <= target) break;
    }
    if (total <= maxChars) return saved;
  }
  return saved;
}

/**
 * 系统提示词里注入真实日期：不给的话模型会拿训练截止日当"今天"，凡是"最新/本周"的任务全歪。
 * 只精确到小时——分钟是个昂贵的小数点：system 是所有 provider 缓存前缀的第一段，
 * 写进分钟就等于每过一分钟整段前缀作废，多轮会话里每一轮都在全价重买同样的几十万 token。
 * "现在/马上/今晚"这类安排本来也只需要钟点粒度。
 */
function envToday() {
  const d = new Date();
  const week = "日一二三四五六"[d.getDay()];
  const slot = d.getHours() < 5 ? "凌晨" : d.getHours() < 12 ? "上午" : d.getHours() < 18 ? "下午" : "晚上";
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日（星期${week}）${slot} ${d.getHours()} 点左右`;
}

function safeWorkspaceDir(baseDir) {
  try { return baseDir ? path.join(getWorkspaceDir(), baseDir) : getWorkspaceDir(); } catch { return "（未设置）"; }
}

/**
 * 这次是不是在 git 分身里干活。是的话必须告诉模型，两件事它自己猜不出来：
 * 一是改动进的是另一根分支，二是**不许自己 merge 回去**——合不合、什么时候合是用户的决定，
 * 冲突怎么取舍更是它最没资格拍板的事。不说这句，它会很热心地帮你合掉。
 */
function worktreeLine() {
  try {
    const m = require("./worktree").markOf(getWorkspaceDir());
    if (!m) return "";
    return `\n- 这次是在一个**独立的 git 分身（worktree）**里干活：另有任务正在改同一个仓库，所以给你单开了一份。改动只进分支 \`${m.branch}\`，用户自己的工作区不受影响，你不用担心跟别人打架。收工时改动会自动提交到这根分支上——**不要自己 merge/rebase 回主分支，也不要 push**，合不合由用户决定。`;
  } catch { return ""; }
}

/** 当前生效的模型渠道（base_url / api_key / model / provider），给「没配视觉模型时拿主模型看图」兜底用。 */
function activeChannel(config) {
  const list = Array.isArray(config.models) ? config.models : [];
  const e = list.find((m) => m.name === config.active_model) || list[0];
  if (e && e.base_url && e.model) return { base_url: e.base_url, api_key: e.api_key, model: e.model, provider: e.provider };
  const legacy = config.provider === "anthropic" ? config.anthropic : config.openai;
  return legacy && legacy.model ? { ...legacy, provider: config.provider } : {};
}

/**
 * 被掐掉时追在正文后面的那半句。两条引擎路径（内置循环 / 本机 CLI 引擎）共用这一份，措辞不会漂开。
 *
 * 既没说上限在哪一页，也没提还有「自动续跑轮数」这个开关（默认 0，所以什么都不会自己接着跑），
 * 看到的人只能回过头来问。这里把下一步写全。手动停止是用户自己按的，不该再劝他去调上限。
 */
function stopNotice(note) {
  const resume = "要接着做就跟我说「接着上次进度做」，进度档在工作目录的 PROGRESS.md";
  if (String(note).startsWith("已手动停止")) return `注意：${note}。${resume}。`;
  // 死循环停下来的，劝人去调大上限是反的——上限再大它也只是多转几圈
  if (String(note).startsWith("陷入死循环")) return `注意：${note}，已经停下来不再烧时间和额度，这种停不会自动续跑。先把它撞墙的那条路修好（渠道、文件或命令），或者把要求说得更具体，再跟我说「接着上次进度做」。`;
  return `注意：${note}，任务强制收尾。${resume}；想让它一口气跑更久，去「设置 → 执行上限」调大上限、或把「自动续跑轮数」设成 1 以上（这页归平台管理员）。`;
}

/**
 * 死循环硬停的门槛。每一档都比「提醒」和「拦截」高一截：
 *   同一调用同一结果：3 连提醒、5 连拦截不执行、6 连硬停——拦了还来，就不是判断问题了
 *   同一句报错：换着参数撞同一堵墙 6 次（报错原文一字不差）——参数根本不是变量
 *   连续报错：12 次没一次成功，不管报的是什么
 *   熔断渠道：拦到第 2 次就不再执行，还连着调到第 4 次
 *   来回转圈：A→B→A→B 这种两步或三步一圈、每圈入参和结果都一样，转满 4 圈
 */
const DEAD_LOOP_LIMITS = { same: 6, sameError: 6, errors: 12, media: 4, cycleReps: 4 };

/** 尾部有没有周期 2 / 3 的原样重复：[a,b,a,b,a,b,a,b] → { period: 2, reps: 4, tools: [...] }。全一样的序列不算（那归 streak 管） */
function findCycle(seq, reps) {
  for (const period of [2, 3]) {
    const need = period * reps;
    if (seq.length < need) continue;
    const tail = seq.slice(-need);
    const unit = tail.slice(0, period);
    if (new Set(unit).size < period) continue;
    let same = true;
    for (let i = period; i < need && same; i++) if (tail[i] !== unit[i % period]) same = false;
    if (same) return { period, reps, tools: unit.map((fp) => fp.split("\u0000")[0]) };
  }
  return null;
}

/**
 * 死循环判定（纯函数，测试直接喂 Map）。返回 "" 表示还没到硬停的程度，否则是一句给人看的原因。
 * 以前只提醒、只拦截，模型不听就一直
 * 转到最大步数或最大运行时间，用户看到的是「已达最大运行时间」，还以为是活儿太多。
 */
function deadLoop({ loopHist, errStreaks, errSame, deadMedia, callSeq }, limits = DEAD_LOOP_LIMITS) {
  for (const [k, v] of loopHist || []) if (v.streak >= limits.same) return `同样的参数调用 ${k.split("\u0000")[0]} 已连续 ${v.streak} 次拿到同样的结果`;
  for (const [name, s] of errSame || []) if (s.n >= limits.sameError) return `${name} 连着 ${s.n} 次撞的是同一句报错，换参数也没用`;
  for (const [name, n] of errStreaks || []) if (n >= limits.errors) return `${name} 已连续失败 ${n} 次，没一次成功`;
  for (const [name, d] of deadMedia || []) if (d.n >= limits.media) return `${name} 这条渠道已经熔断，还是连着调了 ${d.n} 次`;
  const cyc = findCycle(callSeq || [], limits.cycleReps);
  if (cyc) return `在 ${cyc.tools.join(" → ")} 之间来回转了 ${cyc.reps} 圈，每一圈的入参和结果都一模一样`;
  return "";
}

/** 开跑前把已熔断的媒体渠道写进提示词：模型一开始就知道「看图这条路今天走不通」，不用撞一次才知道 */
function pausedMediaBlock(now = Date.now()) {
  let paused = [];
  try { paused = mediaHealth.list(); } catch { return ""; }
  if (!paused.length) return "";
  const lines = paused.map((p) => {
    const mins = Math.max(1, Math.ceil((p.until - now) / 60000));
    return `- ${CAP_CN[p.cap] || p.cap}（${p.model || "？"}）：${p.why}${p.hard ? "。要用户去 设置 → 模型 把这条修好或换一条渠道" : `。${mins} 分钟后会自动再试`}`;
  });
  return `\n\n## 这几条媒体渠道现在是暂停的（本地熔断闸拦的，跟问法无关）\n${lines.join("\n")}\n这一趟把它们当不可用：不要调用对应的工具，需要它们的步骤如实告诉用户这一步没做成、该怎么修。`;
}

function createAgentRuntime({ config, llm, mcpManager, experts, expertTeams = [], llmFactory }) {
  // 备用渠道换道要现造一个 LLM 客户端；懒 require 避免环形依赖，测试时可注入假工厂做零 token 验证
  const makeLLM = llmFactory || ((cfg) => require("./llm").createLLM(cfg));
  // 执行追踪器。跟 server.js 共用同一个（按 config 认），设置页那份「发出去多少条」才是真账本。
  // 关着的时候它返回的全是空壳对象，下面所有 tr.span()/tr.end() 都是空转——所以整份文件里
  // 一处 `if (tr)` 都不用写，也就不存在「漏判一处把别人正跑着的任务搞崩」这种事
  const tracer = tracing.getTracer(config);
  /** 团里挂着的成员可能已被删掉，取用时按当前专家表过一遍 */
  function teamMembers(team) {
    return (team.members || []).map((n) => experts.find((e) => e.name === n)).filter(Boolean);
  }
  // 技能每次任务实时加载（save_skill 新建的技能立即可用）
  function getSkills() {
    return loadSkills();
  }

  async function baseSystemPrompt(user, hint, baseDir) {
    const skills = getSkills();
    // 用户可以给助理改名（设置 → 个性化）。名字得进提示词，不然用户喊"小秘"它一脸茫然
    const myName = String((config.assistant || {}).name || "").trim() || "OpenWorkBuddy";
    let p = `你是 ${myName}，一个 AI 办公智能体。用户用自然语言下达办公任务，你自主思考、拆解任务、规划步骤、调用工具执行，最终交付可验证的成果。用户叫你「${myName}」，被问到你是谁就用这个名字。

## 当前环境
- 现在是 ${envToday()}。凡是涉及"最新/今年/近期/本周"的判断一律以这个日期为准，不要用你训练数据里的时间。用户说"现在/马上/今晚"这类词时，按上面的钟点安排，别默认从早上开始。需要最新事实（价格、政策、版本号、人事、榜单）必须 web_search 现查，不许凭记忆答。
- 工作目录（成果文件都放这里）：${safeWorkspaceDir(baseDir)}${worktreeLine()}
- 写文件一律用**相对文件名**（\`报告.html\`、\`demo/index.js\`），相对路径就是从上面这个目录起算的。别再在前面拼一遍目录名——那会在它下面又建一层同名目录。
- 运行环境：${{ darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform}，本机执行，run_shell 拿到的是用户的真实电脑。

## 工具能力
- run_node：执行 Node.js 代码。已安装库：pptxgenjs(PPT)、docx(Word)、exceljs(Excel)，以及 Node 内置模块。
- run_shell：执行 shell 命令（${process.platform === "win32" ? "Windows cmd，注意用 cmd 语法：del/copy/where、路径反斜杠" : "zsh/bash"}），可用系统已装的 CLI 工具（git、curl、ffmpeg、lark-cli 等）。调现成命令行工具用它，写程序逻辑用 run_node。
- read_file：读文件（大文件用 start_line/end_line 只读要看的那段）
- read_document：读 Word/Excel/PPT/压缩包（.docx/.xlsx/.pptx/.zip）。这几种是打包格式，read_file 读出来是乱码。甲方发来的材料、自己刚产出的文档，都用它复核
- write_file：**新建**文件。写长文档用 append:true 一节一节续写，别把前文重新吐一遍（既慢又容易越写越短）。写完会自动做语法/结构自检，报了问题就当场修
- edit_file：改已有文件里的某一段（精确替换）。改代码、改文档只用它，不要 write_file 整篇重写
- search_files：全文搜索，返回 文件:行号:命中行。找定义、找调用点、改名前找引用，用它
- list_files：列目录（depth 给 2~3 可一次看清项目结构）
- remember / forget：把跨任务成立的用户偏好记进长期记忆 / 删掉某条
- web_search：联网搜索（标题/链接/摘要），查资料先搜索定位来源
- fetch_url：抓取网页全文或直接调 JSON 接口（带真实浏览器请求头；配合 web_search 的结果 URL 用）${hasRenderer() ? "。正文全靠 JS 的动态站点（B 站、微博、单页应用）加 render:\"force\"，用内置浏览器真打开一遍再取正文" : ""}
- check_page：验收做好的网页（静态体检 + 真浏览器打开一遍看有没有报错、是不是白屏）。交付 HTML 之前必须跑
- gen_diagram：文本描述 → 专业图（mermaid 流程/时序/甘特、dot 架构图、echarts 数据图表、plantuml UML），一次生成 SVG+PNG 文件。文档/PPT/飞书文档要配图一律用它，不要手写 SVG 文件
- use_skill：加载技能包（做对应任务前先加载）
- library_list / library_read / library_import：查看用户的资料库与灵感笔记（跨项目共享的长期参考资料，任务涉及用户偏好/素材时先查）。资料库可能有子目录，library_list 列出来的名字自带子目录前缀，后面读取/取用要一字不差地照抄；当前项目可能只挂载了其中一块，列出来的就是你能看到的全部。库里的 PDF/图片/Word/压缩包不是文本，用 library_import 复制到工作目录后再按类型处理${hasRenderer() ? "" : "\n- **当前没有内置浏览器**（纯命令行/服务端模式）：html_to_image、桌面宠物都不可用（fetch_url 本身照常用，只是它的 render 参数没了），技能文档里提到它们的步骤一律跳过。要做排版图就把 HTML 写出来交付，告诉用户在桌面版里截；要出图表用 gen_diagram（它有云端兜底）。"}`;
    if ((config.im || {}).feishu && (config.im.feishu.app_id || config.im.feishu.doc_app_id)) {
      p += `\n- feishu_doc_create：把 Markdown 内容创建成飞书云文档交付给用户（用户要求"发到飞书/建飞书文档"时用它，不要自己找凭证写脚本）`;
    }
    if (botWebhookOn()) {
      p += `\n- notify_user：把一条消息推到用户的群机器人（企业微信/钉钉）。用户说"发到群里/推给我/跑完通知我"时用它，别在回复里写"请你手动转发"`;
    }

    if (skills.length) {
      // 描述截到 80 字：这里只是让模型会「选」技能，全文在 use_skill 加载时才给。
      // 第三方技能爱写整段英文简介，不截的话光这份清单就吃掉小一千 tokens、每一步都重复计费
      const brief = (d) => { const t = String(d || "").replace(/\s+/g, " ").trim(); return t.length > 80 ? t.slice(0, 80) + "…" : t; };
      p += `\n\n## 可用技能\n` + skills.map((s) => `- ${s.name}：${brief(s.description)}`).join("\n");
    }
    p += `

## 工作规范
0. **先分清这次是「问题」还是「活」。** 用户打招呼、问你是谁、问你都会干什么、问一个你张嘴就能答的问题——直接答，两三句说完，不要说计划、不要 list_files 看现场、不要写文件、不要套「做了什么／产出文件／还差什么」那套汇报格式。判据是**用户要的是不是一件做出来的东西**，跟消息长短无关。拿不准就先当问题答一句，用户真要东西会再说；反过来为一句问候建目录写文件，是白烧钱还留一地垃圾。**下面第 1 条起，讲的都是「活」。**
1. 接到任务先简短说明计划（2-4 句），然后立即执行，不要等用户确认。信息不全时不要停下来用**文字**反问，自己挑一个最合理的默认假设、写在开场白里继续做。要问就用 ask_user 工具（弹可点的选项卡片）。**该问的只有这三类**：①缺了它整件事会白做的关键信息（发给谁、用哪个账号）；②选错了成品形态会完全不同的岔路（报告交 Word 还是 PDF、视频出横版还是竖版）；③要花钱、不可逆、要覆盖或删除已有内容、要对外发布，以及只有用户本人才知道的事（预算、口味、时间安排）。**这三类之外一律自己定**——技术路线（用哪个库、抓哪条接口、代码怎么组织、跑几轮）永远算自己定。一次只问一个，问完接着干，不许连环追问，也不许拿 ask_user 汇报进度。
2. 涉及已有文件/项目的任务，动手前先 list_files、search_files、read_file 把现场看清楚，不要凭文件名猜内容。**看明白之后直接改**——用户让你改，你就改，不要回头问"要不要我改""确认后我再动手"；只有删文件、清空目录、推远端这类不可逆的事才值得停下来问一句。改的方式是 edit_file 精准替换，不是 write_file 整篇盖掉。
3. 成果文件写到工作目录根目录，文件名有意义。**一件产出只留一份**——写完不要再 cp 一份到别处（工作空间根目录也不行）：聊天里的产出卡片和右侧文件面板本来就能直接预览、直接「所在位置」，多出来的副本只会让用户看到同一个文件显示两遍。用户要把成果拿去别的地方，等他开口再动。**HTML / Markdown / CSS / JSON / 纯文本一律用 write_file 直接写内容，绝不要在 run_node 里用模板字符串拼**——网页正文里几乎必然出现 \`\${...}\`、反引号或 </script\>，会把外层模板字面量截断，直接 SyntaxError。run_node 只留给真的需要跑逻辑的活（pptxgenjs 出 PPT、docx 出 Word、exceljs 出 Excel、批量处理、算数据）。
3.1 消息里带「已上传文件：xxx」就是用户拖进来或粘贴进来的东西，一律先看再动手：
   - 用户输入中可能还有「【图片 1：xxx.png】」「【视频 1：xxx.mp4】」「【音频 1：xxx.wav】」「【文本摘录 1：xxx.txt】」这类素材锚点。**锚点出现的顺序和它前后的描述就是用户指定的输入关系**：例如「【图片 1】是人物、【图片 2】是背景」或两个锚点中间的动作描述，必须照此理解、引用和生成，不能按文件名或上传时间自行重排。末尾的「已上传文件」清单只是在兼容旧会话，文件是否可用以它为准。
   - 图片（.png/.jpg/…）用 look_at_image，带上一个具体问题（"把报错原文一字不差抄下来"、"这页分几块、各放了什么"）。**别用 read_file 读图**，读出来是乱码。图不进对话历史，只有你问到的答案会进，所以一次就把要用的细节问全。
   - 音频、视频（.mp3/.wav/.m4a/.mp4/…）用 transcribe_audio 转成文字再动手，**别用 read_file 读**（二进制，读出来是乱码，也别只凭文件名猜内容）。要做字幕才把 with_timestamps 设成 true，不做就别开。
   - 「粘贴文本_….txt」或「【文本摘录 N：…】」是用户粘进来的大段文字（日志、报错、整篇文档），用 read_file 读；很长就先读头尾再 search_files 定位，别整篇灌进上下文。
4. 交付前自检：凡是生成的文件，写完必须再 read_file / list_files 读回来确认真的存在、内容完整（长文档至少核对开头结尾和篇幅），发现残缺就当场修好再交付。
4.1 **大任务先立进度档**：预计十步以上、或要产出多个文件的任务，第一步先在工作目录 write_file 建 PROGRESS.md：目标一句话 + 分步清单（- [ ] 待做 / - [x] 已完成）。此后每完成一步就 edit_file 打勾。任务被打断或续跑时，先读 PROGRESS.md 从断点接着做，绝不从头重来。
5. 代码报错要读懂原因、修正重试，不要放弃；同一处连续失败 3 次就换思路，别在死路上空转。
5.1 抓不到网页不等于做不到（高频翻车点）。一条路走不通就换下一条，**同一个目标至少真试满三种路子**才允许说抓不到：
${hasRenderer() ? "   - fetch_url 拿回来是空壳 → 原样再发一次 fetch_url，这次带 render:\"force\"，它会用内置浏览器真打开一遍；\n" : "   - fetch_url 拿回来是空壳 → 去找它背后的数据接口，或者 run_shell 调本机 curl 带上完整请求头再抓一次（当前没有内置浏览器，fetch_url 的 render 参数也不在你的清单里）；\n"}   - 页面正文是异步加载的 → 去找它背后的数据接口（站点常见的 api.xxx.com/... 形式）直接 fetch_url，接口返回 JSON 比解析 HTML 靠谱得多；
   - 接口要签名/被风控挡 → 用 run_shell 调本机现成的命令行工具（curl 带完整请求头、yt-dlp 取视频站元数据、rss 源等），本机装了什么先 \`which\` 一下再说没有；
   - 还是不行 → web_search 搜同样的内容，从能打开的转载页/镜像站/第三方数据站拿。
   把「需要登录 Cookie / 需要官方 API 权限」当结论直接停手，是不合格的交付。真要用户的登录态才继续，先把不需要登录也能拿到的那部分做完再说。
5.2 **不许用文字问句结束回合**：严禁用「请告诉我你的选择：1... 2... 3...」「需要我尝试哪种方式？」这类话收尾，那是把活推回给用户。**技术路线**（用哪个库、抓哪条接口、跑几轮、代码怎么组织）的优劣你自己判断得了——挑最可能成的那个直接动手，失败了再换。这一条禁的是把选择题写在**回复正文**里，**不是禁 ask_user 工具**——规范 1 那三类该问就问，它弹的是可点的选项卡片，用户点一下就继续。同理，严禁把代码贴在回复里说"我能这样做"——能跑就 run_node / run_shell 真跑，回复里只放结论。
5.3 **只读的活一次性并发发出去**：要查 5 个关键词、要抓 6 个链接、要读 3 个文件时，在同一轮里一口气发多个工具调用（web_search / fetch_url / read_file / read_document / list_files / library_read），系统会并发执行，只花最慢那一个的时间；一个一个来是把等待时间叠加。会写文件、跑命令、委派专家的调用不要和别的混在一轮里发——那些的先后顺序有意义，混在一起会被退回串行。
5.4 **出图/出片/出声也一起发**：generate_image / generate_video / text_to_speech 这三个同样可以在一轮里连着发多条，系统会并发执行（比只读那档保守，默认同时 2 条，因为每条都花钱）。这三个跟只读工具不要混在同一轮里发。**每条都给一个不一样的 filename**（voice_01.mp3 / voice_02.mp3 这样）：并发下同名就是互相覆盖，而两条都会报成功，出事了看不出来。
6. 完成后简要总结做了什么、生成了哪些文件。
7. 始终用中文交流——包括报错说明、失败复盘、自我纠正这些中途叙述，任何时候都不许切成英文。工具返回的英文报错要翻成人话讲给用户听（原始报错可以放进代码块，但结论必须是中文）。
8. 用户消息里的「@某文件名」指工作目录中的文件（用 read_file 读取）；「/某技能名」表示要求使用该技能（先 use_skill 加载）；「【任务类型：X】」是场景标签，按该场景的最佳实践来做。
9. 工具能做到的事必须自己调工具真正执行，严禁把命令贴在回复里让用户代跑（除非确实需要用户本人登录/授权才能做的事）。
10. 严禁虚构执行结果（红线）：没有真实调用工具，绝不能声称「已生成/已保存/生成成功」，不能编造文件大小、页数、命令输出或下载链接（sandbox: 开头的链接是假的，禁止输出）。做不到就如实说做不到。系统会自动核验你声称生成的文件是否真实存在，虚构会被当场打回重做。
11. 严禁虚构事实（红线）：数字、日期、人名、机构、政策条款、引用链接，只能来自工具真实拿到的内容。查不到就写「未查到公开信息」，不许用"大约""据业内估算"糊过去，更不许编造看起来很像的 URL。交付物里每个关键数字都要能指回来源。

## 改代码（改用户已有的项目时按这个来）
1. 先看清楚再动手：search_files 找到要改的位置 → read_file 把那一段（含上下文）读出来。别只看文件名和函数名就下笔。
2. 一次只改一处，用 edit_file。old_text 逐字照抄（含缩进），带足上下文保证全文唯一；报"不唯一"就多带几行再来，报"没找到"就回去 read_file 看真实内容，不要靠猜反复试。
3. **绝不整篇重写用户的文件**。write_file 只用于新建。整篇重写会把你没读过的部分一起换掉，而且用户的 diff 会变成全红，根本没法审。
4. 改完自检：语法能不能过（node -c 之类的检查、或直接跑起来）、项目有测试就跑测试、改了函数签名就 search_files 找出所有调用点一并改掉。自检失败自己修，别把坏的交出去。
5. 顺手发现的其它问题：说出来，但不要顺手一起改。用户要的是这一件事的干净改动。
6. 收尾时说清楚：改了哪几个文件的哪几处、为什么这么改、验证过什么。

## 写文档（报告、方案、分析、说明书）
1. 先定骨架再落笔：动笔前用一两句话把「读者是谁、他看完要能做什么决定、分几节」定下来，再开写。上来就写第一段的文档，写到一半必然跑偏。
2. **每节先给结论，再给依据**。小标题要有信息量（写「获客成本三个月涨了 2.4 倍」，不写「现状分析」）。段落 3-5 行断开，能列表就列表，能表格就表格。
3. 数字必须可追溯：每个关键数字后面跟上来源（链接或文件名）。查不到就写「未查到公开信息」，不许用"大约""据业内估算"糊过去。
4. 删掉所有废话：「随着…的不断发展」「众所周知」「综上所述」「本文将」这类开场白和过渡句一律不要。凑字数不如把一个论点说透。
5. 长文档分节 append 写：先 write_file 写标题和目录，之后每节用 append:true 追加。一次生成上万字的整篇内容会被截断，而且中途出错要从头再来。
6. 写完必须 read_file 读回来核对：开头结尾在不在、篇幅对不对、有没有半截话、代码围栏是不是成对闭合。自检不过就当场修，别交出去。
7. 交付时说清楚：文件名、多少字、分几节、数据截止到哪天。

## 做网页（HTML 交付物）
0. **动笔前先定视觉方向，一句话写进开场白**：说清三件事——**参照物**（像一份编辑部的深度报道／像终端里的监控面板／像一本纸质手册）、**主色从内容里长出来**（财报、菜谱、医疗科普不该共用一套蓝）、**版式节奏**（通栏大标题还是左侧固定目录，信息密还是大留白）。跳过这步直接写 CSS，做十个页面会长成同一张脸：白底、居中一栏、蓝色标题、圆角卡片加淡阴影。有 web-styles 技能就先 use_skill 它，从里面挑一个方向再动笔。
1. **单文件自包含**：CSS 写 \`<style>\`、JS 写 \`<script>\`、图标用内联 SVG 或 emoji。**绝不从外部 CDN 引脚本和样式**（cdn.jsdelivr、unpkg、bootstrap、echarts CDN 等）——用户断网、换台电脑、发给同事，页面当场白屏。需要图表就自己用内联 SVG 或 canvas 画。**没有例外，Google Fonts 也不行**（fonts.googleapis.com / fonts.gstatic.com）：\`<link rel=stylesheet>\` 是挡渲染的，连不上时浏览器不会立刻放弃——实测在「包被防火墙默默丢掉」的内网里，首屏要等 **5.1 秒**才画出第一个字（不引外链的同一页是 0.12 秒）。这不是「字体变普通」，是白屏五秒。国央企内网、断网的笔记本、飞机上打开的同一份文件，都是这个下场。西文标题想要气质，用系统里真装着的（Georgia / Palatino / Optima / Futura / Charter）去换族。中文更不用想——一个中文字体包好几 MB，联网要白等、断网直接回退。
2. 必备骨架：\`<!DOCTYPE html>\`、\`<meta charset="utf-8">\`、\`<meta name="viewport" content="width=device-width, initial-scale=1">\`、有信息量的 \`<title>\`、\`lang="zh-CN"\`。
3. 手机上也要能看：宽度用 %/rem/clamp()，别写死 px；多栏布局用 flex/grid 并配 \`@media (max-width: 768px)\` 塌成单栏；表格外面套一层 \`overflow-x:auto\`。
4. 深色模式默认跟随系统：颜色统一定义成 \`:root\` 上的 CSS 变量，再用 \`@media (prefers-color-scheme: dark)\` 覆盖一遍变量。别把颜色散写在各处，改起来必漏。**除非这次的视觉方向本身就是单色调的**（暗色终端、纸质印刷这类，硬凑两套会把风格稀释成大路货）——那就只做一套，在 \`<head>\` 里写死 \`<meta name="color-scheme" content="dark">\`（或 light）免得浏览器自作主张，并在交付说明里讲一句「这页是纯暗色的，不跟随系统」。
5. 视觉下限（这是及格线，不是配方）：不超过 4 个主色（一个主色 + 一个强调色 + 中性灰阶）、间距一律用 4 的倍数、同类元素左对齐对齐死、正文行高 1.6～1.75、正文宽度别超过 40 字。这几条管的是「别难看」，不是「长这样就对了」——具体长什么样，由第 0 条定的视觉方向说了算。
6. **内容必须是真数据**：页面里的数字、案例、引用都来自工具真拿到的东西，不许拿 Lorem ipsum、示例数据、占位图充数交付。
7. **写完必须跑一次 check_page**：白屏和 JS 报错光看源码看不出来。报错就改到干净为止，再告诉用户"做好了"。
8. 交付时给出文件名，并提醒用户可以在成果区直接点开预览。

## 长期记忆
- 用户说「以后都这样」「记住…」「别再…」「我习惯…」，或者纠正了你一个会反复出现的做法 → 立刻调 remember 记一句话结论。不记，下次任务你还会犯同样的错。
- 不止等用户开口：任务里摸清的、下次还会用到的稳定事实（用户的业务/产品叫什么、常用账号或主页链接、固定的交付格式、反复用到的文件路径），收尾前主动 remember 一条。判断标准：下个月做类似任务这条还成立、还省事，就值得记。
- 只记跨任务成立的东西（偏好、习惯、常用路径、身份、明确的纠正）。这次任务的过程、临时数据不要记。
- 绝不把密钥、密码、令牌记进去（记忆是明文存的，还会进每一次的系统提示词）。
- 用户说「不用记这个了」→ forget。

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
  2. **这条只对回复正文里的 \`\`\`svg 围栏成立**：文字颜色、描边颜色只用这几个语义变量：\`var(--color-text-primary)\`（标题/正文）、\`var(--color-text-secondary)\`（次要说明）、\`var(--color-text-tertiary)\`（弱化标注）、\`var(--color-border-primary|secondary|tertiary)\`（分隔线/边框）、\`var(--color-bg-subtle)\`（浅底块）；字体统一 \`font-family="var(--font-sans)"\`。品牌色/强调色（高亮标签、数据条）可以直接写 hex；
  3. SVG **不会自动折行**：中文长句要自己拆成多个 \`<tspan x="…" dy="…">\`，或者提前断句，别指望它自己换行；
  4. \`<script>\`、\`<foreignObject>\`、外链图片/字体一律会被安全层清掉，别用；要用 \`<style>\` 就用类名，界面会自动把它限死在这张图里。
- 排版参考：竖版长图（viewBox 宽 680、高按内容给）最稳；顶部大标题+副标题，中间分区块，每块一个小节标题+若干条目，区块之间用细分隔线，末尾可以留一行数据来源。

### 注意：写进文件的 SVG 不能照抄上面那套变量
上面那套 \`var(--color-text-primary)\` 之所以能用，是因为图渲染在应用页面里、变量是页面定义的。
**一旦你把 SVG 写进一个 .html 或 .svg 文件，那个文件是独立的，这些变量根本不存在**——
\`fill: var(--没定义的)\` 会让整条声明作废、回落到默认的黑色，底块和文字一起变黑，
用户打开就是一片看不清。而且在应用内预览时它是好的，只有用浏览器打开才露馅。

写文件时三选一：① 在这个文件自己的 \`:root\` 里把用到的变量定义出来；② 直接写死颜色值；
③ 至少写兜底 \`var(--x, #333)\`。另外：**同一个文件里已经定义了一套变量（比如 --ink/--bg），
就用它自己那套**，别混进另一套名字。写完 write_file 会自动查这一项，报出来就当场改。

### 注意：gen_diagram 画的图往 HTML 里贴：一个字符都不许改
流程图/架构图/时序图/思维导图一律 \`gen_diagram\` 画，别手写 SVG。要把它内联进报告时，
**把 .svg 文件的内容原样复制进去**——尤其是 \`<svg id="mmdXXXX">\` 这个 id 和 \`<style>\` 里的
\`#mmdXXXX ...\` 选择器，两边是绑死的。你只要为了"防冲突"改了其中一边（哪怕只加个后缀），
整张图的样式会一条都不生效，回落成黑字、没底色、框线全丢——**成品就是黑底黑字、排版乱成一团**。
mermaid 每次渲染的 id 本来就是随机数，根本不会撞，不需要改名。
唯一允许动的是宽度：给 \`<svg>\` 加 \`width="100%"\` 并去掉写死的 width/height 像素值。
写完 write_file 会自动查这一项，报出来说明你确实改坏了，把图重新原样贴一遍。`;
    if (config.persona) {
      p += `\n\n## 用户的个性化偏好\n${config.persona}`;
    }
    // 记忆按账号取：共享的 + 这个人自己的。别人的偏好不该串到他头上；
    // hint 是本次任务线索，记忆装不下提示词预算时按它挑最相关的
    // 自进化规则排在记忆前面：记忆是"这个用户怎么想的"，规则是"你自己在哪儿摔过"。
    // 摔过的坑得先想起来，不然照着用户偏好又摔一次。两块都过预算上限，不会无限撑长。
    try { p += evolve.promptBlock(); } catch {} // 规则目录读不了不该让整个任务起不来
    p += await memory.promptBlock(user, hint);
    return p;
  }

  async function coordinatorSystemPrompt(user, hint, baseDir) {
    let p = await baseSystemPrompt(user, hint, baseDir);
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

  async function expertSystemPrompt(expert, user, hint, baseDir) {
    let p =
      (await baseSystemPrompt(user, hint, baseDir)) +
      `\n\n## 你的专家角色：${expert.name}${expert.alias ? `（花名「${expert.alias}」）` : ""}\n${expert.system}`;
    if ((expert.skills || []).length) {
      p += `\n\n## 你的专属技能（动手前先 use_skill 加载，再按技能里的规范做）\n${expert.skills.map((s) => `- ${s}`).join("\n")}`;
    }
    p += `\n\n你是被主协调者委派的专家。完成后用一段简明汇报结束：做了什么、产出了哪些文件（写真实文件名）、关键结论、还有什么没做完。汇报会被原样交回协调者，别写客套话。`;
    return p;
  }

  const READ_ONLY_TOOLS = ["read_file", "read_document", "list_files", "search_files", "fetch_url", "render_page", "web_search", "library_list", "library_read", "look_at_image"];

  /** 配没配群机器人。两个通道任一有地址就算配了——notify.pushBots 本来就是有哪个推哪个 */
  function botWebhookOn() {
    const im = config.im || {};
    return !!(im.wecom_bot_webhook || im.dingtalk_webhook);
  }

  function toolList(depth, mode) {
    if (mode === "ask" || mode === "plan") {
      const gui = hasRenderer();
      const readOnly = TOOL_DEFS.filter((t) => READ_ONLY_TOOLS.includes(t.name) && (gui || !DESKTOP_ONLY_TOOLS.includes(t.name)));
      return [
        ...(gui ? readOnly : dropRendererParams(readOnly)),
        // 只看不动的档位里也该答得上「我都定了些什么」——list_schedules 只读，schedule_task 不给
        ...(scheduler.activeScheduler() ? [LIST_SCHEDULES_TOOL] : []),
        USE_SKILL_TOOL,
      ];
    }
    // 组织关掉了命令行：连工具定义一起摘掉，别只在执行时拦。留着定义等于让模型先想一个
    // 用 shell 的方案、调一次、吃一条拒绝、再重想——白烧一轮，还容易被它当成偶发失败去重试
    const shellOff = orgPolicy() && orgPolicy().allow_shell === false;
    const noGui = !hasRenderer();
    let base = TOOL_DEFS.filter(
      (t) =>
        !(shellOff && (t.name === "run_shell" || t.name === "run_node")) &&
        !(noGui && DESKTOP_ONLY_TOOLS.includes(t.name))
    );
    if (noGui) base = dropRendererParams(base);
    const tools = [...base, USE_SKILL_TOOL, ASK_USER_TOOL, ...mcpManager.toolDefs()];
    if ((config.im || {}).feishu && (config.im.feishu.app_id || config.im.feishu.doc_app_id)) tools.push(FEISHU_DOC_TOOL);
    if (botWebhookOn()) tools.push(NOTIFY_TOOL);
    // 排期表只有 server / 桌面版起得起来。CLI 和测试里取不到，这两个工具就不摆出来——
    // 摆出来再报「这台机器上没有排期表」的话，模型会把它当成偶发失败一遍遍重试
    if (scheduler.activeScheduler()) tools.push(SCHEDULE_TOOL, LIST_SCHEDULES_TOOL);
    // 没配发信通道就别摆这个工具：摆出来模型会先写一封信、调一次、吃一条「没配」、再重想，
    // 白烧一轮不说，用户还以为自己哪里填错了
    if (mailer.configured((config.im || {}).smtp)) tools.push(SEND_EMAIL_TOOL);
    if (depth === 0 && experts.length) tools.push(DELEGATE_TOOL);
    // 团委派只给主协调者：专家在团里接力时 depth 已经 >0，再让它组团会套娃
    if (depth === 0 && expertTeams.some((t) => teamMembers(t).length >= 2)) tools.push(DELEGATE_TEAM_TOOL);
    return tools;
  }

  // 界面语言 → 回复语言。中文界面不加任何话（提示词本来就是中文，模型默认中文答）；
// 英文界面才加一段：用户读的是英文界面，回复、产出文件也该是英文——除非用户自己用中文写。
// 只在 lang === "en" 时生效，别的值一律当中文，不会因为前端传个怪值就改变行为。
function langBlock(lang) {
  if (lang !== "en") return "";
  return "\n\n## Reply language\nThe user's interface language is English. Reply in English, and write the files you produce for the user in English, unless the user writes to you in Chinese (then follow the user's language).";
}

function modePrompt(mode) {
    if (mode === "ask") {
      return `\n\n## 当前模式：Ask（问答）\n只负责回答问题、分析与建议。可以读文件、查资料，但绝不修改文件、不执行代码、不委派专家。回答完即结束。`;
    }
    if (mode === "plan") {
      return `\n\n## 当前模式：Plan（规划）\n只做调研与规划，不实际执行。输出一份结构化执行计划：任务拆解步骤、每步用什么工具/专家、预期产出文件。最后提醒用户切换到 Craft 模式执行。`;
    }
    return `\n\n## 当前模式：Craft（执行）\n用户已经在这个模式里点了「做」，就是要你动手，不是要你确认。
- 直接改文件、直接跑命令、直接交付。**严禁**用「要不要我帮你改？」「确认后我就开始」「你希望用哪种方案？」这类话结束回合——一个回合结束时，要么活干完了，要么真的卡在只有用户本人能解决的事情上（登录、授权、付钱）。
- 方案有好几种、但**成品长得差不多**（用哪个库、代码怎么组织、跑几轮）——自己挑最稳的那个，在开场白里说一句"我按 X 来做"，然后做。做错了再改，比停在原地问强。
- 但**成品形态会完全不同的岔路，不许自己替用户挑**（封面图走生图还是排版截图、文案走口播稿还是图文）——挑错了等于整件事白做，照规范 1 用 ask_user 问。摆选项时：label 写选项本身，detail 写"选了它会得到什么、代价是什么"（label"AI 生图" / detail"画面有质感有氛围，但风格随机、不好复现"；label"HTML 排版截图" / detail"版式配色全可控、改起来快，但偏平面没氛围"）。detail 是用户唯一的判断依据，不许省，也不许把 label 换个说法重说一遍。
- **要看着东西才答得上来的题，必须在问题里点名那个文件**（"三版对比在 封面三选一.html 里"）——网页端认出这个名字就把它摊到右边，用户一眼看得见。文件名要写全、带后缀、跟落盘的那个一模一样；只说"做了三版你挑一个"，用户得自己去一堆文件里翻，这题就等于没法答。同理，**几个候选摆一个对比页**（三张图并排 + 各自一句话），别让用户挨个点开三个文件比。
- 用户已经点名走哪条路了（"你用生图 API 给我做"），就照他说的做——哪怕你觉得另一条更稳，也只能把风险一句话说在前面，不许拿它当理由偷偷换方案。技能文档里的推荐做法同理：那是没人表态时的默认值，不是用来推翻用户的。
- 需要审批的危险动作（删除、sudo、碰黑名单文件）系统会自己弹窗拦，不用你在文字里预先请示。
- **结论先行**：交给用户看的东西——回合的最终答复、报告、文档——一律先给结论和建议，再给理由和过程。用户要的是"所以呢"，不是你一步步怎么查到的。长文档第一屏必须有一段能独立读懂的摘要：结论 + 3 条关键依据 + 建议的下一步；把结论埋在第七节里，等于没写。
- **时间盒**：调研、比价、找方案这类活儿，动手前先给自己定个量（查几个来源、看几家、试几种），够了就收手写结论。信息永远查不完，"再多查一点"是最贵的拖延；没查到的写进"待验证"一节交出去，比继续查划算得多。`;
  }

  async function runToolCall(tc, { emit, depth, deadline, stats, stopSignal, user, projectContext, sec, taskLabel, runToken, baseDir, llmOverride, askUser, lang, sessionId, traceNode }) {
    // 参数压根不是合法 JSON（llm.js 救不回来时塞了个 _raw 进来）。tools.executeTool 里早有这道闸，
    // 可 ask_user / use_skill / MCP / 委派专家这几个是在这儿就地接住的，根本走不到那儿——
    // 于是一路掉进各自的必填校验，报出来的是「question 不能为空」。模型看了以为是自己漏填了字段，
    // 把同一坨东西原样再发一遍，再坏一次。本机会话里这条已经连着吃掉好几轮：用户看到的是
    // 每次都先红一条空白的「问你一句」，紧接着才是真正问出来的那条。
    if (tc.input && typeof tc.input === "object" && typeof tc.input._raw === "string") {
      return { content: badToolArgs(tc.name, tc.input._raw, tc.input._parseError, tc.input._rawLen), isError: true };
    }
    if (tc.name === "ask_user") {
      const question = String(tc.input.question || "").trim().slice(0, 500);
      // 选项现在是 {label, detail}，但字符串也照收：老会话回放、以及模型偷懒直接给短语的情况
      const options = (Array.isArray(tc.input.options) ? tc.input.options : [])
        .map((o) =>
          o && typeof o === "object"
            ? { label: String(o.label || "").trim().slice(0, 120), detail: String(o.detail || "").trim().slice(0, 200) }
            : { label: String(o).trim().slice(0, 120), detail: "" }
        )
        .filter((o) => o.label)
        .slice(0, 6);
      if (!question) return { content: "question 不能为空。", isError: true };
      if (!askUser) {
        // IM/定时任务/评测这类无人值守场景没有回答通道，别傻等
        return { content: "当前是无人值守运行，没人在线回答。按你判断的最合理默认继续做，并在最终汇报里注明你替用户做了什么假设。", isError: false };
      }
      const askId = "ask_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const timeoutMs = Math.max(30000, Number(config.agent.ask_user_timeout_ms) || 300000);
      emit({ type: "ask_user", ask_id: askId, question, options, timeout_ms: timeoutMs, depth });
      const t0 = Date.now();
      const answer = await askUser({ askId, question, options, timeoutMs });
      const waited = Date.now() - t0;
      if (answer == null) {
        emit({ type: "ask_answer", ask_id: askId, timeout: true, depth });
        return { content: `等了 ${Math.round(waited / 1000)} 秒，用户没有回应。按你判断的最合理默认继续做，并在最终汇报里注明你替用户做了什么假设，别再重复问。`, isError: false, extendMs: waited };
      }
      emit({ type: "ask_answer", ask_id: askId, answer, depth });
      // 选中的那条路把 detail 一并回填：那句话是你自己写的承诺，照着它做，别选完就忘
      const picked = options.find((o) => o.label === answer);
      return {
        content: `用户的回答：${answer}` + (picked && picked.detail ? `（这条路你自己写的是：${picked.detail}——照它做）` : ""),
        isError: false,
        extendMs: waited,
      };
    }
    if (tc.name === "use_skill") {
      const skills = getSkills();
      const skill = skills.find((s) => s.name === (tc.input.name || "").trim());
      // folder 型技能自带 scripts/templates 等资源，动态告知 agent 技能目录的绝对路径
      const dirNote = skill && skill.hasAssets
        ? `【技能目录】${skill.dir}\n该技能自带 scripts/templates 等资源文件（在上述目录内，不在工作目录）。技能文档里的相对路径都相对这个目录；运行其脚本用 run_shell 先 cd 进该目录，但产出的成果文件仍要写到工作目录。\n\n`
        : "";
      // 加载 html-page 时顺带提一句还能换风格。不是所有人都装了 frontend-design
      // （它是推荐技能，从上游拉，不随包分发），装了就告诉模型去用，没装就退回内置的 web-styles——
      // 不提这一句，模型会拿 html-page 里的默认骨架一路做到底，十个页面一张脸。
      const styleHint = (tc.input.name || "").trim() === "html-page"
        ? (skills.some((s) => s.name === "frontend-design")
            ? `\n\n【配套】先 use_skill frontend-design 定一个视觉方向，再回来按本技能的骨架写。\n`
            : (skills.some((s) => s.name === "web-styles")
                ? `\n\n【配套】先 use_skill web-styles 从八个方向里挑一个，再回来按本技能的骨架写——直接用默认样式，做出来的页面会跟上一个长得一样。\n`
                : ""))
        : "";
      return skill
        ? { content: dirNote + skill.content + styleHint, isError: false }
        : { content: `技能不存在: ${tc.input.name}。可用: ${skills.map((s) => s.name).join(", ")}`, isError: true };
    }
    if (mcpManager.isMcpTool(tc.name)) {
      return await mcpManager.call(tc.name, tc.input);
    }
    if (tc.name === "notify_user") {
      const raw = String(tc.input.text || "").trim();
      if (!raw) return { content: "notify_user 要带上 text（推送正文）。", isError: true };
      // 正文里的提示条是给界面画图标用的标记，推到群里就是一串乱标签
      const text = callout.strip(raw).slice(0, 2000);
      security.audit("对外推送", text, "放行");
      let sent = [];
      try {
        sent = await require("./notify").pushBots(config, text);
      } catch (e) {
        return { content: `推送失败：${e.message}`, isError: true };
      }
      // pushBots 单通道失败只写一行 console.warn 就咽了，返回的数组才是真凭据。
      // 不看它就会出现「工具说成功、群里什么都没有」——比报错更难查
      if (!sent.length) {
        return { content: "一个通道都没推成（webhook 可能填错了或已失效）。去 设置 → 通知 里核对企业微信/钉钉的地址。", isError: true };
      }
      return { content: `已推送到：${sent.map((s) => ({ wecom: "企业微信", dingtalk: "钉钉" }[s] || s)).join("、")}（${text.length} 字）`, isError: false };
    }
    if (tc.name === "list_schedules" || tc.name === "schedule_task") {
      const sch = scheduler.activeScheduler();
      // 理论上走不到（没排期表时这两个工具压根不列出去），但 MCP / 回放能把任意工具名递进来
      if (!sch) return { content: "这台机器上没有排期表：定时任务只在桌面版和服务端模式下有，纯命令行模式排不了期。", isError: true };
      const cronOf = (c) => {
        const cn = scheduler.describeCron(c);
        return cn ? `${cn}（${c}）` : `cron ${c}`;
      };
      // 一条排期的「什么时候跑」：只跑一次的那种没有 cron，硬念 cron 会念出个空字符串
      const whenOf = (t) => (t && t.at ? scheduler.describeWhen(t) : cronOf(t && t.cron));
      // 这一趟是替谁跑的。多人装机里模型只该看见、只该动**这个人**的排期：
      // 不然「帮我看看有哪些定时任务」会把全公司的任务描述一条条念出来，念完还写进了这次的对话记录。
      // 单机个人版 user 是空的 → 传 undefined → 不过闸，跟以前一模一样。
      const viewer = user ? { username: String(user), admin: false, org: "" } : undefined;
      if (tc.name === "list_schedules") {
        const all = sch.list(viewer);
        if (!all.length) return { content: "还没排过定时任务。", isError: false };
        return {
          content: all
            .map((t) => {
              const last = t.last_run
                ? `上次 ${t.last_run.slice(0, 16).replace("T", " ")}${t.last_result ? "：" + String(t.last_result).replace(/\s+/g, " ").slice(0, 60) : ""}`
                : "还没跑过";
              return `${t.id}｜${t.name}｜${whenOf(t)}｜${t.enabled ? "开着" : "关着"}${t.running ? "（正在跑）" : ""}｜${last}\n  到点要做的：${String(t.task).replace(/\s+/g, " ").slice(0, 200)}`;
            })
            .join("\n"),
          isError: false,
        };
      }

      const act = String(tc.input.action || "").trim();
      if (!["create", "update", "delete", "enable", "disable"].includes(act)) {
        return { content: `schedule_task 的 action 只能是 create / update / delete / enable / disable，收到的是「${act || "(空)"}」。`, isError: true };
      }
      // 定时任务不许再动排期表。它自己就是被排期叫起来的，改出来的那条下次又会改——
      // 没人看着的时候这是个会自我复制的闭环，一觉醒来排期表里几十条。
      if (taskLabel === scheduler.SCHEDULE_LABEL) {
        return {
          content:
            "你现在这一趟是被定时任务叫起来的，这种时候不能动排期表（一条定时任务改出另一条，没人看着会越滚越多）。" +
            "排期要怎么调，写在这次的汇报里告诉用户，由他去 设置 → 定时任务 里改。",
          isError: true,
        };
      }
      const all = sch.list(viewer);
      const id = String(tc.input.id || "").trim();
      const hit = act === "create" ? null : all.find((t) => t.id === id);
      if (act !== "create" && !hit) {
        return { content: `没有 id 为「${id || "(空)"}」的定时任务。先调 list_schedules 看现在都有哪些，id 要照抄。`, isError: true };
      }
      if (act === "create" && all.length >= MAX_SCHEDULES) {
        return { content: `排期表里已经有 ${all.length} 条了（上限 ${MAX_SCHEDULES}）。先让用户删掉不用的，再排新的。`, isError: true };
      }
      // 时间和 task 先在本机校验：写坏了当场说，别让用户白点一次「同意」才发现排不进去
      const rawAt = String(tc.input.at === undefined ? "" : tc.input.at).trim();
      const rawCron = String(tc.input.cron === undefined ? "" : tc.input.cron).trim();
      // 两个都给会各跑各的（cron 每天响 + at 再响一次），而界面上只画得下一个时间
      if (rawAt && rawCron) {
        return { content: "at 和 cron 只能给一个：只跑一次填 at，反复跑填 cron。", isError: true };
      }
      let wantAt = "";
      if (rawAt) {
        try {
          wantAt = scheduler.parseAt(rawAt);
        } catch (e) {
          return { content: `at 写得不对：${e.message}`, isError: true };
        }
      } else if (rawCron || (act === "update" && tc.input.cron !== undefined)) {
        try {
          scheduler.parseCron(tc.input.cron);
        } catch (e) {
          return { content: `cron 写得不对：${e.message}。五个字段是「分 时 日 月 周」，比如 0 9 * * 1-5 是工作日 09:00。`, isError: true };
        }
      } else if (act === "create") {
        return {
          content: "create 得说清什么时候跑：只跑一次给 at（「五分钟后」就是 at=+5m），反复跑给 cron。一次性的提醒不要拿 cron 凑，那会每天都响。",
          isError: true,
        };
      }
      const wantTask = String(tc.input.task === undefined ? "" : tc.input.task).trim();
      if (act === "create" && !wantTask) {
        return { content: "create 要带 task。到点时没有任何上下文，只有这一句话，所以要写成一句能独立执行的完整指令。", isError: true };
      }
      if (act === "update" && tc.input.task !== undefined && !wantTask) {
        return { content: "task 不能改成空的。不想改内容就别传这一项。", isError: true };
      }

      const changes = [];
      if (act === "update") {
        if (tc.input.name !== undefined) changes.push(`名字 → ${String(tc.input.name).trim()}`);
        if (wantAt) changes.push(`时间 → ${scheduler.describeWhen({ at: wantAt })}`);
        else if (tc.input.cron !== undefined) changes.push(`时间 → ${cronOf(rawCron)}`);
        if (tc.input.task !== undefined) changes.push(`内容 → ${wantTask}`);
        if (tc.input.catch_up !== undefined) changes.push(`错过${tc.input.catch_up ? "补跑" : "不补跑"}`);
        if (!changes.length) return { content: "update 没给出任何要改的项（name / at / cron / task / catch_up 至少写一个）。", isError: true };
      }
      const preview = {
        create: () =>
          `新排一条定时任务「${String(tc.input.name || "").trim() || wantTask.slice(0, 30)}」\n什么时候跑：${wantAt ? scheduler.describeWhen({ at: wantAt }) : cronOf(rawCron)}\n到点做什么：${wantTask}\n${wantAt ? "跑完自动关掉，不会再响第二次" : `错过了${tc.input.catch_up === false ? "不补跑" : "会补跑"}`}`,
        update: () => `改定时任务「${hit.name}」（现在是 ${whenOf(hit)}）\n${changes.join("\n")}`,
        delete: () => `删掉定时任务「${hit.name}」（${whenOf(hit)}），它的运行记录也一起清掉`,
        enable: () => `启用定时任务「${hit.name}」：${whenOf(hit)} 起会自动开跑`,
        disable: () => `停用定时任务「${hit.name}」：到点不再自动跑，任务本身留着`,
      }[act]();

      // 排期批一次之后每天都算数，所以不看安全闸门的总开关，一律当场问。
      security.audit("定时任务", preview, "等待审批");
      const waitMs = Math.min(
        ((sec || config.security || {}).approval_timeout_s || 120) * 1000,
        deadline ? Math.max(5000, deadline - Date.now() - 10000) : Infinity
      );
      const ok = await security.requestApproval("改定时任务", preview, {
        timeoutMs: waitMs,
        stopSignal,
        source: taskLabel || "",
        owner: user || "",
      });
      security.audit("定时任务", preview, ok ? "已批准" : "已拒绝");
      if (!ok) {
        return {
          content: "用户没批准这次排期改动（拒绝了，或者没人在线点、等超时了），排期表一个字没动。别原样重试——先问清楚用户到底想怎么排。",
          isError: true,
        };
      }
      try {
        if (act === "create") {
          const item = sch.add({ name: tc.input.name, at: wantAt || "", cron: tc.input.cron, task: wantTask, catch_up: tc.input.catch_up, user: user || "" });
          return {
            content:
              `已排好：「${item.name}」（id ${item.id}）｜${whenOf(item)}｜` +
              `${item.at ? "跑完自动关掉" : `错过${item.catch_up ? "会补跑" : "不补跑"}`}。用户随时能在 设置 → 定时任务 里改或停。`,
            isError: false,
          };
        }
        if (act === "update") {
          const patch = {};
          for (const k of ["name", "cron", "task", "catch_up"]) if (tc.input[k] !== undefined) patch[k] = tc.input[k];
          if (wantAt) patch.at = wantAt;
          const t = sch.update(hit.id, patch, viewer);
          if (!t) return { content: `改的时候这条任务已经不在了（id ${hit.id}）。`, isError: true };
          return { content: `已改：「${t.name}」（id ${t.id}）｜${whenOf(t)}｜错过${t.catch_up ? "会补跑" : "不补跑"}｜到点做：${t.task}`, isError: false };
        }
        if (act === "delete") {
          return sch.remove(hit.id, viewer)
            ? { content: `已删掉定时任务「${hit.name}」（id ${hit.id}），它的运行记录也清了。`, isError: false }
            : { content: `没删成：id ${hit.id} 已经不在排期表里了。`, isError: true };
        }
        const on = act === "enable";
        return sch.toggle(hit.id, on, viewer)
          ? { content: `已${on ? "启用" : "停用"}定时任务「${hit.name}」（id ${hit.id}）。${on ? whenOf(hit) + " 起自动跑。" : "任务留着，到点不再跑。"}`, isError: false }
          : { content: `没改成：id ${hit.id} 已经不在排期表里了。`, isError: true };
      } catch (e) {
        return { content: `排期没改成：${e.message}`, isError: true };
      }
    }
    if (tc.name === "send_email") {
      const smtp = (config.im || {}).smtp || {};
      // 理论上走不到（没配就不列这个工具），但 MCP / 回放能把任意工具名递进来
      if (!mailer.configured(smtp)) {
        return { content: "这台机器还没配发信通道。让用户去 设置 → 助理设置 → 邮件 里填上 SMTP 服务器、账号、密码，再让我发。", isError: true };
      }
      const subject = String(tc.input.subject || "").trim();
      const body = String(tc.input.body || "").trim();
      if (!subject) return { content: "send_email 要带 subject。收件人先看到的就是这一行，不能空着。", isError: true };
      if (!body) return { content: "send_email 要带 body（纯文本正文）。收件人看不到你和用户的对话，正文得能独立读懂。", isError: true };

      const chk = mailer.checkRecipients(smtp, tc.input.to);
      if (!chk.list.length) return { content: "send_email 要带 to（收件人邮箱）。", isError: true };
      if (chk.bad.length) {
        return { content: `这几个收件人不是合法邮箱地址：${chk.bad.join("、")}。照抄用户给的地址，别自己编。`, isError: true };
      }
      if (chk.tooMany) {
        return { content: `一封信最多发 ${mailer.MAX_RECIPIENTS} 个收件人，这次给了 ${chk.list.length} 个。真要群发就分批，并且先跟用户确认名单。`, isError: true };
      }
      // 白名单是用户在设置里钉死的硬闸：挡在弹窗**之前**，连问都不问。
      // 问了就等于给「用户手一滑点了同意」留口子，而这正是白名单要防的那件事
      if (chk.blocked.length) {
        security.audit("发邮件拦截", `收件人不在白名单：${chk.blocked.join("、")}`, "拦截");
        return {
          content:
            `这几个收件人不在用户设的白名单里，发不出去：${chk.blocked.join("、")}。` +
            "白名单在 设置 → 助理设置 → 邮件 里，只有用户本人能改——别换个写法重试，也别改地址绕过去。",
          isError: true,
        };
      }

      // 附件：路径一律过安全中心，跟 read_file 同一道闸。越界的、不存在的都在发信之前说清楚
      const attachRels = (Array.isArray(tc.input.attachments) ? tc.input.attachments : [])
        .map((a) => String(a || "").trim())
        .filter(Boolean);
      const attachPaths = [];
      if (attachRels.length) {
        let wsRoot = "";
        try {
          wsRoot = getWorkspaceDir();
        } catch {}
        const base = wsRoot && baseDir ? path.resolve(wsRoot, baseDir) : wsRoot;
        const policy = sec || security.getSecurity(config);
        for (const rel of attachRels) {
          const r = security.resolvePathWithPolicy(policy, rel, wsRoot, base);
          if (!r.allowed) {
            security.audit("发邮件拦截", `附件 ${rel}`, "拦截");
            return { content: `附件「${rel}」被安全中心拦截：${r.reason}`, isError: true };
          }
          attachPaths.push(r.path);
        }
      }
      const att = mailer.checkAttachments(attachPaths);
      if (att.missing.length) {
        return {
          content: `这几个附件在磁盘上不存在：${att.missing.map((p) => path.basename(p)).join("、")}。先确认文件真生成出来了（list_files 看一眼），再发。`,
          isError: true,
        };
      }
      if (att.tooBig) {
        return {
          content: `附件加起来 ${mailer.fmtBytes(att.bytes)}，超过 ${mailer.fmtBytes(mailer.MAX_ATTACH_BYTES)} 了，多数邮箱会直接退信。压缩一下，或者只带关键的那几个。`,
          isError: true,
        };
      }

      const html = String(tc.input.html || "").trim();
      const bodyShown = body.length > 1500 ? body.slice(0, 1500) + `\n…（正文还有 ${body.length - 1500} 字）` : body;
      const preview =
        `发件人：${mailer.fromAddr(smtp)}\n` +
        `收件人：${chk.list.join("、")}\n` +
        `主题：${subject}\n` +
        `正文：\n${bodyShown}` +
        (html ? `\n（另附一份 HTML 排版正文，${html.length} 字）` : "") +
        (att.items.length ? `\n附件：${att.items.map((a) => `${a.filename}（${mailer.fmtBytes(a.size)}）`).join("、")}` : "");

      // 邮件出了门就在别人的收件箱里躺着了，撤不回来。所以不看安全闸门的总开关，一律当场问。
      security.audit("发邮件", preview, "等待审批");
      const waitMs = Math.min(
        ((sec || config.security || {}).approval_timeout_s || 120) * 1000,
        deadline ? Math.max(5000, deadline - Date.now() - 10000) : Infinity
      );
      const okToSend = await security.requestApproval("发邮件", preview, {
        timeoutMs: waitMs,
        stopSignal,
        source: taskLabel || "",
        owner: user || "",
      });
      security.audit("发邮件", preview, okToSend ? "已批准" : "已拒绝");
      if (!okToSend) {
        return {
          content: "用户没批准这封邮件（拒绝了，或者没人在线点、等超时了），一个字都没发出去。别原样重试——先问清楚用户这封信该不该发、发给谁、怎么写。",
          isError: true,
        };
      }
      try {
        const r = await mailer.send(smtp, {
          to: chk.list,
          subject,
          text: body,
          html: html || undefined,
          attachments: att.items.map((a) => ({ filename: a.filename, path: a.path })),
        });
        security.audit("发邮件", preview, "已发出");
        const okList = (r.accepted || []).length ? r.accepted.join("、") : chk.list.join("、");
        const badList = (r.rejected || []).length ? `；对方退回：${r.rejected.join("、")}` : "";
        return {
          content: `已发出：${okList}｜主题「${subject}」${att.items.length ? `｜带了 ${att.items.length} 个附件` : ""}${badList}`,
          isError: (r.rejected || []).length > 0,
        };
      } catch (e) {
        security.audit("发邮件", preview, "发送失败");
        return { content: `邮件没发出去：${mailer.scrub(smtp, e.message)}`, isError: true };
      }
    }
    if (tc.name === "feishu_doc_create") {
      try {
        const { createFeishuDoc } = require("./feishu-doc");
        // 本地图片按当前任务的成果子目录 → 工作空间根的顺序解析，越界一律拒绝
        const resolveImage = (rel) => {
          const ws = require("./tools").getWorkspaceDir();
          const cand = path.isAbsolute(rel)
            ? [path.resolve(rel)]
            : [...(baseDir ? [path.resolve(ws, baseDir, rel)] : []), path.resolve(ws, rel)];
          for (const p of cand) {
            if ((p === ws || p.startsWith(ws + path.sep)) && fs.existsSync(p)) return p;
          }
          return null;
        };
        const r = await createFeishuDoc((config.im || {}).feishu, tc.input, { deadline, stopSignal, resolveImage });
        return {
          content: `飞书文档已创建：${r.url}（${r.blocks} 个内容块${r.images ? `，含 ${r.images} 张图` : ""}）${r.warn ? `\n注意：${r.warn}` : ""}\n请把这个链接告诉用户。`,
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
        projectContext,
        lang,
        history: [{ role: "user", content: tc.input.task }],
        emit: (ev) => emit({ ...ev, expert: expert.name }), // 子代理事件带上专家标记
        systemPrompt: await expertSystemPrompt(expert, user, String(tc.input.task || "").slice(0, 500), baseDir),
        depth: depth + 1,
        user,
        taskLabel,
        sessionId, // 专家改的文件也记在这个会话的检查点账上，回退时一并退
        runToken, // 同一任务树共用认领身份，专家的产出算整个任务的
        baseDir, // 成果子目录也一并继承
        deadline, // 专家共享同一个总运行时间预算
        stats, // 专家消耗的 token 计入同一笔账
        stopSignal, // 「停止」信号穿透到专家子代理
        sec, // 权限档位覆盖也一并继承
        llmOverride, // 对话选的模型，专家也用同一个
        askUser, // 专家拿不准也能直接问用户（事件带专家标记）
        traceNode, // 追踪上：专家这一整趟挂在「委派」这次工具调用底下，层级跟界面上看到的一致
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
        projectContext,
        lang,
          history: [{ role: "user", content: brief }],
          emit: (ev) => emit({ ...ev, expert: m.name, team: team.name }),
          systemPrompt: await expertSystemPrompt(m, user, String(tc.input.task || "").slice(0, 500), baseDir),
          depth: depth + 1,
          user,
          taskLabel,
          sessionId,
          runToken,
          baseDir,
          deadline,
          stats,
          stopSignal,
          sec,
          llmOverride,
          askUser,
          traceNode,
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
    return await executeTool(tc.name, tc.input, execOpts({ depth, deadline, stopSignal, taskLabel, user, baseDir, sec, sessionId, callId: tc.id }));
  }

  /**
   * 一次工具执行要带的全套上下文。agent 循环和「不过模型、直接扣扳机」的直调口共用这一份——
   * 各写各的早晚会漂：少传一个 media，generate_image 连模型都点不了名；
   * 少传一个 actor，审批卡片就跑去问了别人。
   */
  function execOpts({ depth = 0, deadline, stopSignal, taskLabel, user, baseDir, sec, sessionId, callId }) {
    return {
      knownTools: toolList(depth, "craft").map((t) => t.name), // 拼错工具名时用来给出最接近的真名
      timeoutMs: config.agent.tool_timeout_ms,
      search: config.search,
      media: mediaModels.resolve(config), // 带上全表，generate_image 这些才能按名字点名用哪个模型
      visionFallback: activeChannel(config), // 没配视觉渠道时先拿主模型试试（主模型本来就多模态的，用户什么都不用配）
      // IM/定时等无人值守场景可传 sec 覆盖权限档位（没人守着屏幕点审批）
      security: sec || config.security,
      deadline,
      stopSignal,
      taskLabel, // 审批卡片上标明发起任务，多任务并行时才分得清是谁在求批
      actor: user, // 审批归谁：多人共用一台服务器时，别人不该看见、更不该替他点「允许」
      baseDir, // 相对路径读写、脚本 cwd、产物落点全在本对话的成果子目录
      memory: { user },
      sessionId, // 文件检查点记在哪个会话名下：回退只认自己这个会话动过的文件
      callId, // 这一步的工具调用 id，检查点账本上和过程卡对得上号
    };
  }


  /**
   * 强制收尾时的最后一句话。不给工具、单独一小段超时预算（撞的就是时间上限，不能再等 5 分钟），
   * 失败就悄悄算了——收尾说明没拿到，也不该把整个任务变成一次报错。
   */
  async function wrapUp({ history, system, stopNote, emit, depth, stats, llmOverride, traceNode }) {
    history.push({
      role: "user",
      content: `【系统】任务已到上限被强制收尾（${stopNote}）。现在不要再调用任何工具，直接给用户一段收尾说明：
1. 已经做完了什么、产出了哪些文件（只写真实存在的文件名，没生成就别写）；
2. 还差哪些没做完；
3. 下次接着做的话，从哪一步继续最省事。
用中文，简明扼要，不要客套。`,
    });
    const L2 = llmOverride || llm;
    const gen = (traceNode || tracing.noop).generation({
      name: "强制收尾",
      model: L2.model,
      input: tracing._internals.messagesOf(system, history),
      metadata: { depth, stop_note: stopNote },
    });
    try {
      trimHistory(history, config.agent.max_context_chars || 120000); // 最后一次工具输出可能刚把上下文顶爆，先压一压
      const result = await L2.chat({
        system,
        history,
        tools: [],
        signal: AbortSignal.timeout(Math.min(90000, config.agent.llm_timeout_ms || 300000)),
        onTextDelta: (delta) => emit({ type: "text", delta, depth }),
      });
      gen.end({ output: result.text || "", usage: result.usage });
      if (result.usage) {
        stats.prompt += result.usage.prompt;
        stats.completion += result.usage.completion;
        stats.cached = (stats.cached || 0) + (result.usage.cached || 0);
        stats.calls++;
      }
      history.push({ role: "assistant", text: result.text, toolCalls: [], raw: result.raw });
      return result.text || "";
    } catch (e) {
      console.warn("[agent] 收尾说明没拿到:", e.message);
      gen.end({ error: (e && e.message) || String(e) });
      history.pop(); // 把那条【系统】指令撤掉，免得下一轮对话里挂着一句没人回的话
      return "";
    }
  }

  // ── 长会话自动压缩 ──────────────────────────────────────────────
  // trimHistory 只截工具输出，对话轮永不清理：会话越聊越大越钝越贵，模型还会拿
  // 自己几十轮前的旧话当依据（「发不了文件」的幻觉就是这么反复复发的）。
  // 超阈值时把早期轮次交给模型浓缩成一条接手摘要，只留最近几轮原文。
  const COMPACT_MARK = "【系统·上下文压缩】";
  /** 从被压缩的轮次里机械提取读/改过的文件，并把上一份摘要里的清单接续下来。
   *  清单不靠摘要模型转述（模型会丢文件名），跨多次压缩累计（借鉴 pi 的 cumulative file tracking）。 */
  function collectFileOps(old) {
    const read = new Set(), wrote = new Set();
    for (const e of old) {
      if (e.role === "assistant") {
        for (const c of e.toolCalls || []) {
          const p = String((c.args || c.input || {}).path || "").trim();
          if (!p) continue;
          if (c.name === "read_file") read.add(p);
          else if (c.name === "write_file" || c.name === "edit_file") wrote.add(p);
        }
      } else if (e.role === "user" && String(e.content || "").startsWith(COMPACT_MARK)) {
        const s = String(e.content);
        const grab = (label, set) => {
          const m = new RegExp(`【${label}】([^\\n]*)`).exec(s);
          if (m) for (const f of m[1].split("、")) { const t = f.trim(); if (t && t !== "无") set.add(t); }
        };
        grab("读过的文件", read);
        grab("改过的文件", wrote);
      }
    }
    for (const p of wrote) read.delete(p); // 改过的不用再占「读过」的位置
    const cap = (set) => Array.from(set).slice(-40).join("、") || "无";
    return { read: cap(read), wrote: cap(wrote) };
  }
  /**
   * 上下文用到哪儿了，播给界面看。
   *
   * 命令行早就有这根进度条（`/status` 里那行 `上下文 [====----] 41%`），网页和手机上却是黑的：
   * 用户只有等模型开始忘事、或者看见一句「已压缩」，才知道刚才发生过什么。等看见的时候，
   * 「该不该开个新会话」这个决定已经晚了一轮。
   *
   * 数字跟 compactHistory 用的是同一组（同一个 budget、同一个 threshold），不另算一套——
   * 两边算法一旦分家，这个读数就是在骗人：这儿显示 40%，那边其实已经压过一次了。
   *
   * 只在百分比真的变了的时候播。长任务一步一算，不挡着的话一轮能往 SSE 里塞几百条一模一样的。
   */
  function emitContext(history, emit, state) {
    if ((config.agent || {}).context_meter === false) return;
    const budget = config.agent.max_context_chars || 120000;
    const threshold = config.agent.compact_threshold_chars || Math.floor(budget * 0.6);
    const used = historyChars(history);
    const pct = Math.round((used / budget) * 100);
    if (state && state.lastCtxPct === pct) return;
    if (state) state.lastCtxPct = pct;
    emit({ type: "context", used, budget, threshold, pct, compact: (config.agent || {}).compact !== false });
  }

  // force=true 是人手动敲 /compact：这时候不看阈值也不看「关了自动压缩」这个设置——
  // 那个设置管的是「别自作主张」，不是「不许我自己压」。
  async function compactHistory(history, { emit = () => {}, stats, traceNode, force = false } = {}) {
    if (!force && (config.agent || {}).compact === false) return;
    const budget = config.agent.max_context_chars || 120000;
    const threshold = config.agent.compact_threshold_chars || Math.floor(budget * 0.6);
    if (!force && historyChars(history) <= threshold) return;
    const keepTurns = config.agent.compact_keep_turns || 4;
    const userIdx = [];
    history.forEach((e, i) => { if (e.role === "user") userIdx.push(i); });
    // 首选切在用户轮开头（工具调用/结果永远成对保留）。轮次不够切 = 单轮长跑任务把上下文
    // 顶爆了，退到「分轮压缩」（借鉴 pi 的 split turn）：在助手消息边界下刀，把任务早期的
    // 几十步浓缩掉。不做这一步的话，长任务中途只能靠 trimHistory 盲截，早期结论全丢。
    let cut = userIdx.length > keepTurns ? userIdx[userIdx.length - keepTurns] : -1;
    let splitMode = false;
    if (cut < 1) {
      const keepChars = config.agent.compact_keep_chars || 30000;
      let acc = 0;
      for (let i = history.length - 1; i >= 1; i--) {
        acc += entryChars(history[i]);
        if (acc >= keepChars) {
          // 边界只能落在 user/assistant 开头：切在 tool 前面会把工具结果和它的调用拆散。
          // 往前（更早）找最近的非 tool 条目——越界点常落在工具结果上，它所属的调用必须一起保留
          for (let j = i; j >= 1; j--) if (history[j].role !== "tool") { cut = j; break; }
          break;
        }
      }
      if (cut < 1) return;
      splitMode = true;
    }
    const old = history.slice(0, cut);
    // 大头字符都在保留的最近几轮里时，压旧轮次省不下几个字符，总量照样超阈值，
    // 下一步又会再触发——变成每步烧一次总结调用的死循环。旧轮次不够肉就不压。
    if (historyChars(old) < 8000) return;
    // 老轮次转成纯文本转写；工具结果只留个头，摘要模型不需要全文
    const lines = [];
    for (const e of old) {
      if (e.role === "user") lines.push("用户：" + String(e.content || "").slice(0, 2000));
      else if (e.role === "assistant") {
        if (e.text) lines.push("助手：" + String(e.text).slice(0, 2000));
        for (const c of e.toolCalls || []) lines.push(`（调用 ${c.name} ${JSON.stringify(c.args || c.input || {}).slice(0, 200)}）`);
      } else if (e.role === "tool") {
        for (const r of e.results || []) lines.push("（工具结果：" + String(r.content || "").replace(/\s+/g, " ").slice(0, 300) + "）");
      }
    }
    let transcript = lines.join("\n");
    if (transcript.length > 60000) transcript = "…（更早部分略）\n" + transcript.slice(-60000); // 压缩请求本身也别把上下文顶爆
    const fileOps = collectFileOps(old);
    // 分轮压缩会把本任务的原始指令一起压掉，摘要没写好任务就跑偏——指令原文机械保留，不过模型的手
    let lastInstr = "";
    if (splitMode) {
      for (let i = old.length - 1; i >= 0; i--) {
        const e = old[i];
        if (e.role !== "user") continue;
        const c = String(e.content || "");
        if (c.startsWith(COMPACT_MARK) || c.startsWith("【系统")) continue;
        lastInstr = c.replace(/\s+/g, " ").slice(0, 2000);
        break;
      }
      // 连续多次分轮压缩后，原始指令只活在上一份摘要里——像文件清单一样机械接续，不能靠摘要模型转述
      if (!lastInstr) {
        for (let i = old.length - 1; i >= 0 && !lastInstr; i--) {
          const e = old[i];
          if (e.role !== "user" || !String(e.content || "").startsWith(COMPACT_MARK)) continue;
          const m = /【最近的用户指令原文】([^\n]*)/.exec(String(e.content));
          if (m) lastInstr = m[1].trim();
        }
      }
    }
    const gen = (traceNode || tracing.noop).generation({
      name: "压缩历史",
      model: llm.model,
      input: [{ role: "user", content: tracing._internals.capText(transcript, 4000) }],
      metadata: { chars_before: historyChars(history), cut_at: cut },
    });
    const result = await llm.chat({
      system:
        "你是会话压缩器。把用户给你的对话转写压成一份接手备忘录，严格按以下结构写（没内容的小节写「无」）：\n" +
        "## 目标\n## 已完成\n## 进行中 / 卡住\n## 关键决定（附原因）\n## 下一步\n## 关键上下文\n" +
        "「关键上下文」放继续干活必需的硬事实：路径、命令、报错原文、用户表达过的偏好与纠正。\n" +
        "只写事实不评论，文件名和关键数字一个都别丢。800 字以内，中文。",
      history: [{ role: "user", content: "以下是需要压缩的对话转写：\n\n" + transcript }],
      tools: [],
      signal: AbortSignal.timeout(60000),
    });
    gen.end({ output: result.text || "", usage: result.usage });
    if (result.usage && stats) { stats.prompt += result.usage.prompt; stats.completion += result.usage.completion; stats.cached = (stats.cached || 0) + (result.usage.cached || 0); stats.calls++; }
    const summary = String(result.text || "").trim();
    if (!summary) return;
    // 先归档再动刀：压缩只做搬家不做销毁，真要翻旧账去 data/compact-archive 找
    try {
      const dir = dataPath("data", "compact-archive");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify(old, null, 2));
    } catch (e) { console.warn("[agent] 压缩归档失败（不拦压缩）:", e.message); }
    history.splice(0, cut, {
      role: "user",
      content:
        `${COMPACT_MARK}以下是本会话更早内容的自动摘要（原文已归档）：\n${summary}\n` +
        (lastInstr ? `【最近的用户指令原文】${lastInstr}\n` : "") +
        `【读过的文件】${fileOps.read}\n【改过的文件】${fileOps.wrote}\n` +
        `（摘要结束。把以上当作既定事实继续，不必向用户复述；若与用户最新要求冲突，以最新要求为准。）`,
    });
    emit({ type: "compact", removed: old.length });
    console.log(`[agent] 上下文已压缩（${splitMode ? "任务分轮" : "会话轮次"}）：${old.length} 条 → 1 条摘要（现约 ${historyChars(history)} 字符）`);
  }

  // 产出归属账本：判「这个文件是不是本回合的产出」，见文件底部 makeOwnership 的说明
  const ownership = makeOwnership();
  const { claimBaseDir } = ownership;
  let runSeq = 0;

  /**
   * 把整趟任务交给本机 agent CLI 跑。
   *
   * 对外的返回结构跟内置引擎一模一样（finalText / usage / stopped），多带一个 sessionId：
   * 那是底层 CLI 自己的会话 id，存进本项目的会话文件后，桌面端和 openworkbuddy 命令行能接着同一根线程续跑。
   * 「已达最大步数 / 已达最大运行时间 / 已手动停止」这三种收尾原样报出去——
   * task-verdict 那层认的就是这几个词，翻译对了，假绿判定在 CLI 引擎上照样生效。
   */
  async function runViaEngine({ backend, opts = {}, history, emit = () => {}, mode, deadline, stopSignal, baseDir, engineSession, user, projectContext, lang }) {
    const cwd = safeWorkspaceDir(baseDir);
    try { fs.mkdirSync(cwd, { recursive: true }); } catch {}
    if (!deadline) deadline = Date.now() + (config.agent.max_runtime_ms || 1800000);
    const startedAt = Date.now();

    // 睡眠治理跟内置引擎同一套：本机睡过去的时间不算任务时间，醒来把时限顺延
    const releaseAwake = awake.hold();
    const unwatchSleep = awake.watch((sleptMs) => {
      deadline += sleptMs;
      emit({ type: "sleep", ms: sleptMs, note: `检测到本机睡眠 ${Math.round(sleptMs / 1000)} 秒，任务时限已顺延（睡眠不算任务时间）`, depth: 0 });
    });

    // 成果卡片：CLI 写文件我们看不见，只能自己前后对一次快照。
    // 归属两道关，跟内置引擎那条路一模一样（这边以前一道都没有，别的对话正在写的文件
    // 会整批挂到这条新对话的产出里，见 dirOwners 上面那段）：
    //   1) 文件躺在别的任务已认领的目录里 → 不是我的；
    //   2) 同一版本已被别的任务先认领 → 不是我的（根目录文件只有这一道能拦）。
    const runToken = ++runSeq;
    claimBaseDir(baseDir, runToken);
    const filesOut = makeFilesEmitter({ emit, ownership, baseDir, runToken });
    // 工具一跑完就对一次账，长任务中途就能看到产物，不用等收尾。
    // CLI 这条路是**每个**工具结果来一次（不像内置引擎是一批一次），所以走节流的那个口子：
    // 一串结果连着回来时合并成一次走树，而不是一个结果扫一遍 500 个文件
    const wrapped = (ev) => {
      emit(ev);
      if (ev && ev.type === "tool_result") { try { filesOut.push(); } catch {} }
    };

    // 本项目自己的工具（生图 / 视频 / 配音 / 图表 / 看图 / 技能库 / 记忆）当成 MCP 服务器
    // 挂给 CLI。不挂的话切到本机引擎就等于把这些全丢了 —— 模型只会回一句
    // 「本会话没有任何生图工具」，那不是它偷懒，是真没有。
    // 用户自己配的 MCP 连接器一并转过去，同理：换个底层引擎不该让连接器消失。
    let bridged = null;
    try {
      bridged = bridge.attach(backend.id, {
        home: DATA_DIR,
        baseDir: baseDir || "",
        user: user || "",
        extraServers: config.mcp_servers || [],
      });
    } catch (e) {
      // 挂不上就照常跑，只是少了那些工具；不能因为桥没搭起来把整个任务毙掉
      emit({ type: "status", text: `本项目工具没能挂给引擎（${e.message}），这次只能用 CLI 自带的工具`, depth: 0 });
    }

    // 档位收紧了就明说一句。不说的话，用户看到的是「它怎么什么都不肯干」，
    // 而真正的原因在另一个页面上的一颗开关里，隔着两层根本联系不起来
    const guard = security.engineGuard(security.getSecurity(config));
    if (guard.note) emit({ type: "status", text: guard.note, depth: 0 });

    try {
      const r = await backend.run({
        prompt: enginePrompt(history, engineSession),
        cwd,
        emit: wrapped,
        deadline,
        stopSignal,
        systemPrompt: await engineSystemPrompt(cwd, mode, user, bridged, { projectContext, history, lang }),
        resumeId: engineSession || null,
        // 工作目录之外还要让它读的地方：整个工作区（别的对话的产出、资料库）和技能库正文。
        // 只对 claude 有意义（-p 模式读 cwd 外的文件要审批）；codex 的沙箱读是不限的，它忽略这项
        addDirs: engineAddDirs(),
        maxTurns: config.agent.max_steps || 25,
        // 安全档位：这两个 CLI 自带工具、自带循环，写文件跑命令**不经过**本项目的安全中心，
        // 所以档位得翻成它们自己认的开关一路传下去（见 security.engineGuard）
        guard,
        // 思考模式跟 app 设置对齐：设置页选什么档，接管的本机 CLI 就用什么档。
        // 放在 opts 前面 = 单个引擎还能自己覆盖（engine_options[id].thinking）
        thinking: prefs.agentCfg(config).thinking || "auto",
        ...(bridged ? bridged.runOpts : {}),
        ...opts, // 用户在设置里给这个引擎填的 model / bin / extraArgs 等，最后覆盖
      });
      try { filesOut.push(true); } catch {} // 收尾这一下必须立刻发：产出得赶在这一轮结束前落到界面上
      const rawFinal = (r.finalText || "").trim();
      // 调用方（Web / IM / 定时任务）都指望 runTask 就地把回复追加进 history
      if (rawFinal) history.push({ role: "assistant", content: rawFinal });
      // 撞上限 / 手动停止 / 跑超时：内置引擎会发 limit 事件、并把这半句写进正文（见下面 stopNote 那段），
      // CLI 引擎这条路以前只把 stopped 塞在返回值里。于是谁忘了接这个返回值，谁那边就把半截活儿
      // 显示成干完了——IM 就是这么把「跑满 25 步被掐掉」当成一条正常回复发到用户手机上的。
      // 在这儿补齐，让两条引擎路径对外一模一样，调用方不用各自记得去接。
      // 不学内置那样再花一次调用让模型写收尾：CLI 引擎重起一趟是整个进程重来，慢，而且真花钱。
      let finalText = rawFinal;
      if (r.stopped) {
        emit({ type: "limit", note: r.stopped, depth: 0 });
        const notice = stopNotice(r.stopped);
        finalText = finalText ? `${finalText}\n\n${notice}` : notice;
      }
      const usage = {
        prompt: (r.usage && r.usage.prompt) || 0,
        completion: (r.usage && r.usage.completion) || 0,
        cached: (r.usage && r.usage.cached) || 0,
        calls: (r.usage && r.usage.calls) || 0,
        elapsed_ms: Date.now() - startedAt,
        local: true, // 本机订阅跑的，token 是真的，API 账单是零。前端靠它区分
      };
      emit({ type: "usage", model: opts.model || backend.label, provider: backend.id, ...usage });
      // model/provider 一并带回：记账那边以前拿 config 里的模型名记这笔（跑的是 Claude Code，账本却写 deepseek-chat）
      return { finalText, usage, stopped: r.stopped || null, sessionId: r.sessionId || null, engine: backend.id, model: opts.model || backend.label, provider: backend.id };
    } finally {
      filesOut.stop(); // 尾随的那次要是烧到 SSE 关掉之后才响，就是往已经断掉的连接里写
      if (bridged) bridged.cleanup();
      unwatchSleep();
      releaseAwake();
    }
  }

  /**
   * 给底层 CLI 的提示词。
   * 续跑时只发新的那句——CLI 自己记着上下文，把整段历史再贴一遍是白烧 token；
   * 头一次跑就把对话摊平成一份逐字稿，别让它以为用户只说了最后一句。
   */
  function enginePrompt(history, engineSession) {
    const list = Array.isArray(history) ? history : [];
    const lastUser = [...list].reverse().find((e) => e && e.role === "user" && typeof e.content === "string");
    if (engineSession) return lastUser ? lastUser.content : "继续。";
    const turns = list.filter((e) => e && typeof e.content === "string" && (e.role === "user" || e.role === "assistant"));
    if (turns.length <= 1) return lastUser ? lastUser.content : "";
    return turns.map((e) => (e.role === "user" ? "【用户】" : "【你之前的回复】") + "\n" + e.content).join("\n\n");
  }

  /**
   * 追加给底层 CLI 的系统提示：只说它不可能自己知道的事（在哪干活、产出放哪、说什么语言）。
   * 本项目那份几千字的协调者提示词不往这儿塞——里面大半在讲本项目自己的工具，
   * CLI 手上没有那些工具，讲了只会让它去找不存在的东西。
   */
  /** claude 的 --add-dir 名单：工作区根 + 技能库。不存在的目录由引擎那边过滤 */
  function engineAddDirs() {
    const out = [];
    try { out.push(getWorkspaceDir()); } catch {}
    out.push(SKILLS_DIR);
    return out;
  }

  /**
   * 技能索引：只给名字和一句话，正文让它按需去读。
   *
   * 内置引擎有 use_skill 工具，技能表在工具描述里；CLI 引擎没有这个工具，
   * 也不会自己去翻 skills 目录——不点名它就永远不知道这些技能存在。
   * 正文不进提示词：几十个技能加起来几万字，每次任务都带等于白烧 token。
   */
  function engineSkillsBlock(bridged) {
    let list = [];
    try { list = loadSkills(); } catch { return ""; }
    if (!list.length) return "";
    const MAX = 40;
    const one = (s) => `- ${s.name}${s.description ? "：" + String(s.description).replace(/\s+/g, " ").slice(0, 60) : ""}`;
    const lines = list.slice(0, MAX).map(one);
    const more = list.length > MAX ? `\n（还有 ${list.length - MAX} 个没列，用 library_list 看全）` : "";
    const canTool = bridged && bridged.lent.includes("library_read");
    const how = canTool
      ? (bridged.shimIsPrimary
        ? `用 \`${bridged.shimBin} library_read '{"name":"技能名"}'\` 读它的正文`
        : `用 mcp__openworkbuddy__library_read（或命令 ${bridged.shimBin} library_read）读它的正文`)
      : `正文在 ${SKILLS_DIR}/<技能名>/skill.md，直接读`;
    return `\n## 你会的技能（${list.length} 个，用户装在 OpenWorkBuddy 里的）\n` +
      `任务对得上其中某个技能时，先${how}，再照着做——技能里是用户认可的做法，别凭自己的习惯重来。\n` +
      lines.join("\n") + more;
  }

  async function engineSystemPrompt(cwd, mode, user, bridged, extra = {}) {
    const who = user ? `当前用户：${user}。` : "";
    const modeLine =
      mode === "ask" ? "本次只回答问题，不改文件、不执行有副作用的命令。"
      : mode === "plan" ? "本次只做调研和规划，输出可执行的步骤清单，不要真的动手改东西。"
      : "确实是活的时候：用户要的是干完，不是确认。直接动手，最后交付具体成果。";
    const parts = [
      `你在为 OpenWorkBuddy 干活。${who}`,
      // 这一条必须排在工作目录和汇报格式前面。原来第一句是「你正在执行一个办公任务」，
      // 最后一句又硬性要求「写清楚产出了哪些文件」——于是用户打一句「你是？」，模型
      // 老老实实建了工作目录、写了两个 md、按「做了什么/产出的文件/还差什么」汇报。
      // 那不是模型跑偏，是提示词就是这么要求的。所以改的是框架，不是再加一句措辞。
      "先分清这次是**问题**还是**活**：打招呼、问你是谁、问一个你张嘴就能答的问题——直接答完就结束，两三句话，不要列计划、不要去看目录、不要写文件、不要套汇报格式。判据是用户要的是不是一件做出来的东西，跟消息长短无关（「把这份报告做成 PPT」是活，「你都会干什么」不是）。拿不准就先当问题答，用户真要东西会再说一句；为一句问候建目录写文件，是白烧钱还留一地垃圾。",
      `是活的时候：工作目录是 ${cwd}，产出文件都写在这里（用相对路径即可），用户会在成果面板里看到它们；最后一段写清楚做了什么、产出了哪些文件、还差什么，别用「已完成」三个字代替交代。`,
      modeLine,
      bridgedLine(bridged),
      "全程用中文回复。",
    ];
    // ── 下面四块跟内置引擎那条路（baseSystemPrompt / runTask）一模一样 ─────────────
    // 以前这条路一块都没带。用户换到本机 claude/codex 一跑就发现"上周告诉过你的它全忘了"、
    // "项目里写的规范它不认"——不是 CLI 记性差，是我们压根没把记忆递过去。
    // 顺序同内置：个性化偏好 → 自进化规则（自己摔过的坑）→ 长期记忆 → 项目指令。
    if (config.persona) parts.push(`\n## 用户的个性化偏好\n${config.persona}`);
    try { const ev = evolve.promptBlock(); if (ev) parts.push(ev.trim()); } catch {} // 规则目录读不了不该让任务起不来
    // 记忆召回线索：用户最后一条消息的前 500 字，记忆超预算时按它挑最相关的
    const lastUser = [...(extra.history || [])].reverse().find((e) => e && e.role === "user" && typeof e.content === "string");
    const hint = lastUser ? lastUser.content.slice(0, 500) : "";
    try { const mb = await memory.promptBlock(user, hint); if (mb) parts.push(mb.trim()); } catch {}
    if (extra.projectContext) parts.push(`\n## 当前项目的背景与规范（用户在项目设置里写的，必须遵守）\n${extra.projectContext}`);
    if (extra.lang) parts.push(langBlock(extra.lang));
    parts.push(engineSkillsBlock(bridged));
    // 读文件范围：工作区里别的对话的产出、资料库都可以读；写只写本次工作目录
    let root = ""; try { root = getWorkspaceDir(); } catch {}
    if (root && root !== cwd) parts.push(`除了本次工作目录，${root} 下是用户在 OpenWorkBuddy 里所有对话的产出和资料，需要引用时可以读；但新文件只写在本次工作目录里。`);
    return parts.filter(Boolean).join("\n");
  }

  /**
   * 告诉 CLI：本项目的工具已经挂上来了，别再说"我这儿没有生图工具"。
   *
   * 光把 MCP 服务器挂上是不够的。真实会话里模型翻了一遍工具表、没认出那是生图，
   * 交付里写的是「本会话依旧没有任何生图工具，所以还是生不出来，请你自己把图放进去」。
   * 挂了工具却不点名，等于把东西放在柜子里不告诉人柜子在哪。
   * 所以这里逐个报名字，并且明说「不要反过来让用户自己去生成」。
   */
  function bridgedLine(bridged) {
    if (!bridged) return "";
    const has = (n) => bridged.lent.includes(n);
    // 用裸命令名，不用绝对路径：路径写法会被 CLI 的权限层判成「需要审批」，
    // 非交互模式下没人能点同意。bridge 已经把脚本目录挂进子进程 PATH 了。
    const shim = bridged.shimBin || "";
    // 两条路：MCP 工具（claude 那边好使）和命令行（谁都拦不住）。
    // codex 接到非 OpenAI 模型上时一个 MCP 工具都不挂，所以那边把命令行摆在前面。
    const cliBlock = shim ? [
      bridged.shimIsPrimary
        ? "OpenWorkBuddy 把它自己的工具借给你了，用命令行调（这台 CLI 挂不上 MCP，命令行是唯一入口）："
        : "万一上面那些 mcp__openworkbuddy__ 工具没挂上，同一批工具还有一个命令行入口：",
      `  ${shim} list                          # 列出你能用的全部工具和必填参数`,
      `  ${shim} <工具名> '<JSON 参数>'          # 直接调用，结果打在 stdout`,
      `  ${shim} <工具名> @参数文件.json         # 参数太长、带引号或换行时用这个，别跟 shell 引号硬拼`,
      `例：${shim} generate_image '{"prompt":"雪山日出，写实摄影","filename":"fig_a.jpg"}'`,
      `例：${shim} gen_diagram '{"kind":"dot","source":"digraph{A->B}","filename":"flow.png"}'`,
      "退出码 0 是成功，1 是失败；失败时 stdout 里就是失败原因原文。",
    ].join("\n") : "";
    const mcpBlock = bridged.shimIsPrimary ? "" : [
      "另外：OpenWorkBuddy 已经把它自己的工具挂给你了，名字都以 mcp__openworkbuddy__ 开头，其中——",
      has("generate_image") && "  · mcp__openworkbuddy__generate_image  生图（用户在本项目里配好的图像模型，你直接调，图会落到工作目录）",
      has("generate_video") && "  · mcp__openworkbuddy__generate_video  生视频     · mcp__openworkbuddy__text_to_speech 配音",
      has("transcribe_audio") && "  · mcp__openworkbuddy__transcribe_audio 把录音/视频里的话转成文字（会议、采访、口播素材）",
      has("gen_diagram") && "  · mcp__openworkbuddy__gen_diagram     流程图/架构图/统计图（dot 离线可用）",
      has("html_to_image") && "  · mcp__openworkbuddy__html_to_image   网页转长图（排版好的 HTML 截成图）",
      has("look_at_image") && "  · mcp__openworkbuddy__look_at_image   看图（带上你想知道的具体问题）",
      has("read_document") && "  · mcp__openworkbuddy__read_document   读 Word/Excel/PPT/压缩包（你自带的读文件工具读这几种只会得到乱码）",
      has("check_page") && "  · mcp__openworkbuddy__check_page      打开你做的网页，看真实效果和控制台报错",
      has("web_search") && "  · mcp__openworkbuddy__web_search   联网搜索、取网页正文",
      has("library_list") && "  · mcp__openworkbuddy__library_list / library_read / save_skill   技能库",
      has("remember") && "  · mcp__openworkbuddy__remember / forget           长期记忆",
    ].filter(Boolean).join("\n");
    const toolNames = bridged.lent.join("、");
    return [
      mcpBlock,
      cliBlock,
      `这次借给你的工具：${toolNames}。`,
      "要图就自己生，别在交付里写「我没有生图工具，请你把图放进去」——你有。",
      "调用失败了就把失败原因如实写进交付（比如「图像模型未配置」），那是用户能动手解决的信息；不要假装图已经有了。",
    ].filter(Boolean).join("\n");
  }

  // 只表示「打哪儿来的」、不表示「在干嘛」的那几个标签。它们当名字用的时候，
  // 一屏十条全一个样——得再接一句用户到底说了什么
  const GENERIC_LABELS = new Set(["IM 对话", "定时任务", "任务", "直调工具", "im", "schedule", "api", "cli"]);

  /**
   * 给这一趟任务起个在列表里认得出来的名字。
   *
   * 之前是 `taskLabel || "任务"`：taskLabel 缺席或者只是个来源标签时，
   * 账本里就会堆出几百条一模一样的「任务」，点进去才知道是哪趟——这个列表等于没用。
   * 现在缺席就从用户说的话里截，来源标签则保留在前面当限定词（「IM 对话 · 帮我查下日程」），
   * 这样既知道从哪进来的，也知道要干什么。
   *
   * 截的是**最近那句有内容的**，不是第一句：这里传进来的 history 是整段会话，
   * 取第一句的话，聊了十轮就是十条同名的 trace，列表照样分不开（这正是之前的样子）。
   */
  /** 这一趟是会话里的第几轮（用户开口过几次）。列表靠它把同一个会话里的几趟分开 */
  const traceTurnOf = (history) => (Array.isArray(history) ? history.filter((m) => m && m.role === "user").length : 0);

  function traceNameOf(taskLabel, history) {
    const from = String(taskLabel || "").trim();
    const said = tracing._internals.labelFromInput(tracing._internals.messagesOf("", history));
    if (from && !GENERIC_LABELS.has(from)) return from.slice(0, 120);
    if (from && said) return `${from} · ${said}`.slice(0, 120);
    return (said || from || "任务").slice(0, 120);
  }

  /**
   * 运行一次 Agent 任务循环。
   * @param history 统一格式会话历史（会被就地追加）
   * @param emit    事件回调（SSE / IM 进度）
   * @param maxSteps 只给这一次任务的步数上限，不传就用全局配置
   * @returns { finalText }
   */
  async function runTask({ history, emit = () => {}, systemPrompt, depth = 0, mode = "craft", deadline, stats, stopSignal, getInterject, user, projectContext, sec, taskLabel, runToken, baseDir, llmOverride, askUser, engineSession, lang, sessionId, traceNode, maxSteps: maxStepsOverride }) {
    // ── 执行追踪 ─────────────────────────────────────────────────────────
    // 顶层任务开一条 trace，这一趟里每次模型调用、每个工具都挂在它底下；专家子任务收到的是
    // 「委派」那次工具调用的 span，接着往下挂，层级跟界面上看到的一模一样。
    // 建在引擎分岔**之前**：选了本机 CLI 的用户也该有据可查，哪怕里头的步骤我们看不见。
    // 关掉追踪（默认）时这里拿到的是空壳，底下所有 tr.xxx 都是空转，一分钱一毫秒都不花。
    const ownsTrace = !traceNode; // 自己开的才自己收尾；专家收到的是别人的 span，轮不到它 end
    const tr = traceNode || (depth === 0
      ? tracer.trace({
          name: traceNameOf(taskLabel, history),
          userId: user ? String(user.username || user.name || user.id || "") : "",
          sessionId,
          input: tracing._internals.messagesOf("", history),
          tags: [mode, lang].filter(Boolean),
          metadata: { mode, lang: lang || "", workspace: baseDir || "", turn: traceTurnOf(history) },
        })
      : tracing.noop);
    // 链接开工就给，不等跑完——长任务里最想点开看的恰恰是跑到一半的时候
    if (ownsTrace && tr.enabled) emit({ type: "trace", url: tr.url, id: tr.id, depth: 0 });

    // ── 底层引擎分岔 ──────────────────────────────────────────────────────
    // 用户在设置里选了「本机 Claude Code / 本机 Codex」时，这一整趟任务交给那个 CLI 跑，
    // 本项目只负责翻译事件、算文件差异、记账。为什么是整层替换而不是换个模型：
    // `claude -p` / `codex exec` 本身就是完整 agent（自带工具、自带循环），
    // 没有"给我下一步"这种调用方式，硬拆只会两头不讨好。
    // 只有顶层任务走这条路——专家子任务是内置循环里的概念，CLI 引擎里没有对应物。
    if (depth === 0) {
      // agentView 而不是 config：底层引擎和它的模型/思考档是**按账号**存的（prefs.js）。
      // 直接读 config 的话，服务器上两个人各自选的引擎会互相覆盖——界面显示 Codex，实际跑的是别人选的那个。
      // 没有请求上下文（定时任务 / IM / 命令行）时 agentView 原样返回 config，行为一字不差。
      // 注意这里不看「这一轮在哪条工作线上」：工作线分的是干哪种活儿（办公 / 工程），
      // 引擎是用户在设置里挑一次、两条线都照着跑的另一件事。绑在一起的话，切个标签能把别人配的模型换掉。
      const picked = engines.resolve(prefs.agentView(config)); // 引擎名写错会在这里抛错，不会静默退回内置
      if (picked.backend) {
        const sp = tr.span({
          name: `外部引擎 ${picked.backend.label || picked.backend.id}`,
          input: tracing._internals.messagesOf("", history),
          metadata: {
            engine: picked.backend.id,
            // 这句得写清楚，不然看 trace 的人会以为这个引擎统共只调了一次模型
            说明: "这一趟整个交给本机 CLI 跑了。它内部分几步、每步调了什么模型、烧了多少 token，本项目拿不到——这条 span 只有进去的话和出来的结果，中间是黑盒。想看逐步明细就把引擎切回「内置」。",
          },
        });
        try {
          const out = await runViaEngine({
            backend: picked.backend, opts: picked.opts,
            history, emit, mode, deadline, stopSignal, baseDir, engineSession, user, projectContext, lang,
          });
          sp.end({ output: out.finalText || "", usage: out.usage, metadata: { stopped: out.stopped || "", engine_session: out.sessionId || "" } });
          if (ownsTrace) tr.end({ output: out.finalText || "", usage: out.usage, metadata: { engine: picked.backend.id } });
          return out;
        } catch (e) {
          const why = (e && e.message) || String(e);
          sp.end({ error: why });
          if (ownsTrace) tr.end({ error: why });
          throw e;
        }
      }
    }
    let L = llmOverride || llm; // 按对话选的模型：整棵任务树（含专家）都用它；中途换道后，之后委派的专家也跟着走新渠道
    if (!runToken) runToken = ++runSeq; // 专家子任务从父任务继承，同一任务树内不互相抢认领
    // 项目指令：用户在「项目」里写的背景/规范。不进提示词的话，那个输入框就是个摆设
    const projBlock = projectContext ? `\n\n## 当前项目的背景与规范（用户在项目设置里写的，必须遵守）\n${projectContext}` : "";
    // 记忆召回的线索：用户最后一条消息的前 500 字。记忆超预算时按它挑相关条目
    const lastUserMsg = [...history].reverse().find((e) => e && e.role === "user" && typeof e.content === "string");
    const memHint = lastUserMsg ? lastUserMsg.content.slice(0, 500) : "";
    const system = (systemPrompt || (await coordinatorSystemPrompt(user, memHint, baseDir))) + projBlock + langBlock(lang) + modePrompt(mode) + pausedMediaBlock();
    const tools = toolList(depth, mode);
    // 按次覆盖步数上限：评测里的长任务题要 40 步以上，但不能因此把全局上限抬高——
    // 那等于给所有任务多开一倍预算，钱和基线可比性一起没了
    const maxSteps = maxStepsOverride || config.agent.max_steps || 25;
    // 整个任务（含所有专家子代理）共享一个墙上时间预算，防止无限执行
    if (!deadline) deadline = Date.now() + (config.agent.max_runtime_ms || 1800000);
    // 整个任务（含专家）共享一份 token 账本，任务结束时汇总上报
    if (!stats) stats = { prompt: 0, completion: 0, cached: 0, calls: 0, startedAt: Date.now() };
    let finalText = "";
    let stopNote = "";
    let honestyRetries = 0;
    let finishRetries = 0; // 「没做完就收摊」被打回的次数（整个任务累计，不按轮重置）
    let openLeft = [];     // 收尾时进度档里仍未打勾的条目，用来如实告诉用户还差什么
    // 进度档所在目录：和下面自动续跑读 PROGRESS.md 的是同一处，别让两边算出不同的路径
    const progressDir = () => { const ws = getWorkspaceDir(); return baseDir ? path.resolve(ws, baseDir) : ws; };
    let trimmedChars = 0; // 本次任务累计被上下文预算截掉的工具输出字符数
    // 备用渠道换道：主模型挂起或服务端持续报错时，切到用户在设置里显式选好的备用渠道接着跑本任务。
    // 默认关（agent.failover_model 为空）。红线：绝不静默降级——只有用户亲手选了备用渠道才换，换道必须大声播报。
    // 每个任务（含每位专家的子任务）最多换一次道：备用渠道也挂了就如实收尾，不搞换道链
    let failedOver = false;
    const switchToBackup = (reason) => {
      const name = String((config.agent || {}).failover_model || "").trim();
      if (!name || failedOver) return false;
      if ((L.provider || "") === name) return false; // 当前就跑在这条渠道上（主选=备用），没有道可换
      if (!(config.models || []).some((m) => m.name === name)) return false; // 渠道已被删掉，配置过期
      try { L = makeLLM({ ...config, active_model: name }); }
      catch (e) { console.warn("[agent] 备用渠道创建失败:", e.message); return false; }
      failedOver = true;
      emit({ type: "failover", note: `${reason}，已切换到备用渠道「${name}」继续本任务`, channel: name, depth });
      return true;
    };
    // 睡眠治理：任务运行期间按住「别睡」断言（并行任务引用计数）；真睡过去了就把
    // 时限顺延、把本步的卡壳计时清零——睡眠既不算任务时间，也不算模型安静时间
    const releaseAwake = awake.hold();
    let curStallReset = null; // 当前这一步的卡壳计时器复位函数，睡醒后先复位再谈超时
    const unwatchSleep = awake.watch((sleptMs) => {
      deadline += sleptMs;
      if (curStallReset) { try { curStallReset(); } catch {} }
      if (depth === 0) emit({ type: "sleep", ms: sleptMs, note: `检测到本机睡眠 ${Math.round(sleptMs / 1000)} 秒，任务时限已顺延（睡眠不算任务时间）`, depth });
    });
    // 产出发射器要在 try 外面声明：它得在 finally 里做最后一次 flush，
    // 声明在 try 里的 const 在 finally 的作用域里是看不见的（真踩过：任务跑完在收尾时炸 filesOut is not defined）
    let filesOut = null;
    try {
    // 卡循环检测：同一工具+同一入参反复拿到同一结果 = 在死路上空转。3 连提醒换思路，5 连直接拦截不执行。
    // 键里必须带结果指纹，才不会误伤「改一遍读一遍」的正常校验循环——文件改了，读回来的内容就变了，计数自动清零
    const loopHist = new Map(); // 工具名+入参 → { sig: 上次结果指纹, streak: 连续拿到相同结果的次数 }
    const errStreaks = new Map(); // 工具名 → 连续报错次数（换着参数撞同一堵墙也算）
    const errSame = new Map();    // 工具名 → { sig, n }：连续拿到**一字不差**的同一句报错的次数（参数怎么换都一样 = 参数不是变量）
    const callSeq = [];           // 最近几次「工具+入参+结果」指纹，抓 A→B→A→B 这种来回转圈（单看每个工具都没在重复）
    /**
     * 工具名 → { n, content }：这一路的渠道已经被 media-health 熔断了，撞了几次。
     *
     * tools.js 那道闸已经让每次重试只花半毫秒，但模型该转的圈还是照转——用户看到的是
     * trace 里四十条一模一样的「看图 · 失败」。所以这儿再补一刀：同一个工具被熔断闸
     * 拦到第二次，本轮就不再执行它了。
     *
     * 为什么是第二次而不是第一次：第一次拦下来时模型还没读到那句话，它有权按自己的判断
     * 再试一次（比如换个 model 参数点名另一条渠道，那确实是另一条路）。读过一次还撞，
     * 就不是判断问题了。
     */
    const deadMedia = new Map();
    let sawImage = false;  // 这一趟有没有成功看过一次图（收尾核验「说自己看过图」用）
    let visionRetries = 0;
    const loopNudged = new Set(); // 每个键只提醒一次，别变成新的噪音循环
    // 任务开始时先记一份工作目录快照，files 事件带上「这一轮真正新增/改动的文件」。
    // 这件事必须在服务端算：前端那份 mtime 快照是活的，历史回放时早就对不上了，算出来永远是空。
    claimBaseDir(baseDir, runToken);
    filesOut = makeFilesEmitter({
      emit, ownership, baseDir, runToken,
      // 长跑可见性：进度档一有更新就把里程碑清单推给前端，时间线卡片实时打勾
      after: (changed) => {
        const progName = changed.find((n) => n.split("/").pop() === "PROGRESS.md");
        if (!progName) return;
        try {
          const raw = fs.readFileSync(path.join(getWorkspaceDir(), progName), "utf8").slice(0, 20000);
          const items = [];
          for (const line of raw.split("\n")) {
            const m = /^\s*[-*]\s*\[([ xX])\]\s*(.+)/.exec(line);
            if (m) items.push({ text: m[2].trim().slice(0, 120), done: m[1] !== " " });
            if (items.length >= 60) break;
          }
          if (items.length) emit({ type: "milestones", file: progName, items, depth });
        } catch {}
      },
    });

    // 长会话先压缩再开跑：只在顶层任务做（专家子任务的 history 是临时的，压不着）
    const ctxState = { lastCtxPct: -1 };
    if (depth === 0) {
      try { await compactHistory(history, { emit, stats, traceNode: tr }); }
      catch (e) { console.warn("[agent] 上下文压缩失败，本次跳过:", e.message); }
      // 压完再播：让界面上那根条直接落到压缩后的真实位置，而不是先闪一下旧数字
      emitContext(history, emit, ctxState);
    }

    // 自动续跑：撞「最大步数/最大运行时间」后自动开下一轮接着干（仅顶层任务；手动停止、模型挂死不续跑）。
    // 外层 for(;;) 只负责续跑判定，内层步循环保持原缩进不动。
    const autoRounds = depth === 0 ? Math.min(20, Math.max(0, Number(config.agent.auto_continue_rounds) || 0)) : 0;
    let roundsUsed = 0;
    for (;;) {
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
      // token 预算护栏：步数和时间都挡不住「小步快跑」式烧钱，按用量再设一道闸（0 = 不限）。
      // stats 整棵任务树共享，专家子代理花的也算；到 80% 先提醒一次，超了强制收尾且不自动续跑
      const tokBudget = Math.max(0, Math.round(+config.agent.max_tokens_budget || 0));
      if (tokBudget) {
        const used = stats.prompt + stats.completion;
        if (used >= tokBudget) {
          stopNote = `已达 token 预算（已用 ${used.toLocaleString()}，预算 ${tokBudget.toLocaleString()}）`;
          break;
        }
        if (!stats.budgetWarned && used >= tokBudget * 0.8) {
          stats.budgetWarned = true;
          emit({ type: "status", text: `token 用量已到预算的 ${Math.round((used / tokBudget) * 100)}%（${used.toLocaleString()} / ${tokBudget.toLocaleString()}），超出后任务会强制收尾`, depth });
        }
      }
      emit({ type: "step_start", step: step + 1, depth });

      // 发请求前先把老工具结果压进上下文预算，宁可丢细节也不能让整个任务撞 400 全丢
      // 超阈值时先智能压缩（老步骤浓缩成接手摘要），压不动再盲截。没有这一步，
      // 跑到几十步的长任务只能靠 trimHistory 把早期工具输出截成空壳，模型越跑越失忆
      try { await compactHistory(history, { emit, stats, traceNode: tr }); }
      catch (e) { console.warn("[agent] 任务中压缩失败，本步跳过:", e.message); }
      if (depth === 0) emitContext(history, emit, ctxState);
      const trimmed = trimHistory(history, config.agent.max_context_chars || 120000);
      if (trimmed) {
        trimmedChars += trimmed;
        console.warn(`[agent] 上下文超预算，已截断历史工具输出 ${trimmed} 字符（depth=${depth} step=${step + 1}）`);
        // 丢了东西就明说，别让用户以为模型一直看得见全部原文
        emit({ type: "trim", chars: trimmedChars, depth });
      }

      // 模型调用超时按「卡壳」判定，不是总时长硬顶：写大文件时全部输出走工具参数流，
      // 界面上一个字都看不到，按总时长掐会误杀正常的长生成。只要还有数据块在流（正文/思考/工具参数），
      // 计时器就一直重置；连续 llm_timeout_ms 收不到任何数据才算挂死。总时长由任务 deadline 兜底
      const stepSusMark = awake.totalSuspendedMs(); // 本步开跑时的累计睡眠数，用来识别「睡出来的假超时」
      const stallMs = Math.max(10000, Math.min(deadline - Date.now(), config.agent.llm_timeout_ms || 300000));
      const stallCtl = new AbortController();
      let stallTimer = setTimeout(() => stallCtl.abort(), stallMs);
      let lastData = Date.now();
      const onActivity = () => {
        lastData = Date.now();
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stallCtl.abort(), stallMs);
      };
      curStallReset = onActivity; // 睡醒后先把卡壳计时清零：睡眠不算模型安静时间
      // 模型迟迟不吐字时界面完全静止，用户分不清「在想」和「挂了」——超过一分钟就报安静了多久
      const heartbeat = setInterval(() => {
        const quiet = Math.round((Date.now() - lastData) / 1000);
        if (quiet >= 60) emit({ type: "status", text: `模型已 ${quiet} 秒没有输出，仍在等待（连续 ${Math.round(stallMs / 1000)} 秒无输出将判定挂起并停止）`, depth });
      }, 30000);
      const budgetSignal = AbortSignal.timeout(Math.max(10000, deadline - Date.now()));
      const signal = AbortSignal.any
        ? AbortSignal.any([stallCtl.signal, budgetSignal, ...(stopSignal ? [stopSignal] : [])])
        : stallCtl.signal;
      const gen = tr.generation({
        name: `第 ${step + 1} 步`,
        model: L.model,
        input: tracing._internals.messagesOf(system, history),
        modelParameters: { provider: L.provider || "", tools: tools.length, mode },
        metadata: { depth, step: step + 1, failed_over: failedOver },
      });
      let result;
      try {
        result = await L.chat({
          system,
          history,
          tools,
          signal,
          onActivity,
          onStatus: (text) => emit({ type: "status", text, depth }),
          onTextDelta: (delta) => emit({ type: "text", delta, depth }),
        });
        // 这一步到底干了什么：说了什么话 + 要调哪几个工具。只记正文的话，纯调工具的那些步
        // 在 trace 上会是一片空白，看的人会以为模型这一步什么都没吐
        gen.end({
          output: [result.text || "", ...(result.toolCalls || []).map((t) => `→ 调用 ${t.name}(${JSON.stringify(t.input || {})})`)]
            .filter(Boolean).join("\n"),
          usage: result.usage,
        });
      } catch (e) {
        gen.end({ error: (e && e.message) || String(e) });
        if (e.name === "TimeoutError" || e.name === "AbortError") {
          const manual = stopSignal && stopSignal.aborted;
          const stalled = stallCtl.signal.aborted;
          // 睡眠假超时：本步期间真睡过、时限也已顺延到未来——不管开枪的是卡壳闹钟还是
          // 总时长闹钟，都是睡醒后过期计时器误开枪，直接重试本步（模型没得到过那些时间的 CPU）
          if (!manual && awake.totalSuspendedMs() > stepSusMark && Date.now() < deadline - 1000) {
            step--;
            continue;
          }
          // 挂起换道：只有「真挂起」才换——手动停止、任务总时长到点都不算；剩余时间太少也不值得换道重试
          if (!manual && stalled && Date.now() < deadline - 30000 &&
              switchToBackup(`主模型连续 ${Math.round(stallMs / 1000)} 秒无输出（疑似挂起）`)) {
            step--; // 重试当前步（finally 会先清掉本步的计时器）
            continue;
          }
          stopNote = manual
            ? "已手动停止"
            : stalled
              ? `模型响应超时（连续 ${Math.round(stallMs / 1000)} 秒没有任何输出，连接已挂起）`
              : "已达最大运行时间";
          break;
        }
        // 服务端硬错误（Service is too busy / 欠费 / 5xx 等）：llm 层同渠道重试用尽才会走到这。
        // 配了备用渠道就换道重试本步；没配就照旧抛出，任务如实失败——这是用户钦定的默认行为
        if (Date.now() < deadline - 30000 &&
            switchToBackup(`主模型持续报错（${String(e.message || e).slice(0, 120)}）`)) {
          step--;
          continue;
        }
        throw e;
      } finally {
        clearTimeout(stallTimer);
        clearInterval(heartbeat);
      }

      if (result.usage) {
        stats.prompt += result.usage.prompt;
        stats.completion += result.usage.completion;
        stats.cached = (stats.cached || 0) + (result.usage.cached || 0);
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
            content: `【系统自动核验】你上一条回复声称已生成/可获取这些文件，但核验不通过——${list}。在文字里写命令和「已生成成功」不等于执行；写出来是空文件也不算交付。现在立即用 write_file / run_node / run_shell 真实生成一遍，写完用 read_file 或 list_files 读回来确认内容真的在里面，再如实汇报。如果执行失败，就如实报告失败原因和报错内容。严禁再声称不存在或空的文件已生成。`,
          });
          emit({ type: "text", delta: callout.line("warn", `**成果核验未通过**：${list}，已自动打回要求真实执行。`), depth });
          continue;
        }

        // 说自己核对过图上的字，可这一趟一次都没真看成过图 → 打回去（最多一次）
        const faked = unseenVisualClaims(result.text, sawImage);
        if (faked && visionRetries < 1 && Date.now() < deadline - 30000) {
          visionRetries++;
          history.push({
            role: "user",
            content: `【系统自动核验】你在结语里写了「${faked}」，可这一趟 look_at_image 一次都没成功看到图——没看过就不算核对过。二选一，别有第三种：` +
              `（1）现在真调一次 look_at_image 带上具体问题去看，看成了再照实说；（2）看不成（渠道报错/没余额/返回空正文）就把这句核对的话删掉，` +
              `明说「没能核对图上的文字，请你自己过一眼」。严禁把没看到的内容当作看过写进结论。`,
          });
          emit({ type: "text", delta: callout.line("warn", "**成果核验未通过**：它说核对过图上的文字，但这一趟一次都没真看成过图，已打回要求真看或如实说明。"), depth });
          continue;
        }

        // 收尾闸门：不调工具了＝它认为做完了。可进度档里还有没打勾的条目、或者它自己承认还有没做的，
        // 那就是没做完就收摊。打回去，把没打勾的条目原样念给它听——不给模糊的「继续」，给具体的清单。
        const left = unfinishedMilestones(progressDir());
        const admits = !left.open.length && UNFINISHED_RE.test(result.text || "");
        openLeft = left.open;
        if ((left.open.length || admits) && finishRetries < 2 && Date.now() < deadline - 30000 && !(stopSignal && stopSignal.aborted)) {
          finishRetries++;
          const listed = left.open.slice(0, 12).map((t, i) => `${i + 1}. ${t}`).join("\n");
          history.push({
            role: "user",
            content: left.open.length
              ? `【系统·收尾核验】你停下来了，但工作目录的 PROGRESS.md 里这些条目还没打勾：\n\n${listed}${left.open.length > 12 ? `\n…（共 ${left.open.length} 项未完成）` : ""}\n\n任务没做完不许收尾。现在接着做这些没打勾的（做完一项就 edit_file 把它改成 - [x]），绝不重做已完成的部分。如果其中某项确实做不了——缺权限、缺凭证、需要用户拍板——就把它在 PROGRESS.md 里标成 - [x] 并在条目后面注明「（做不了：原因）」，然后在最终回复里单独列一节「需要你处理」讲清楚。严禁把没做的事说成做完了。`
              : `【系统·收尾核验】你在回复里说还有没做完的部分，但已经不再动手了。任务没做完不许收尾：现在立即把剩下的做完；如果确实做不了（缺权限、缺凭证、需要用户拍板），就明说是哪一项、卡在哪、需要用户做什么，别用「后续再补」把它糊过去。如果其实已经全部做完了，就直接明确说一句「全部完成」并给出最终交付清单。`,
          });
          emit({
            type: "text",
            delta: left.open.length
              ? callout.line("wait", `**还没做完，已自动打回继续做**：进度档里还有 ${left.open.length} 项没打勾（${left.open.slice(0, 3).join("、")}${left.open.length > 3 ? " 等" : ""}）。`)
              : callout.line("wait", "**还没做完，已自动打回继续做**：它自己说还有没做完的部分，但已经不动手了。"),
            depth,
          });
          continue;
        }
        // 打回额度用完还没做完 → 交给外层自动续跑：新一轮有新的步数和时间预算，比在这儿硬磨划算
        if (left.open.length) stopNote = `任务还有 ${left.open.length} 项没做完`;
        break;
      }

      const runOne = async (tc) => {
        if (stopSignal && stopSignal.aborted) return { id: tc.id, content: "（用户已停止任务，该工具未执行）", isError: true };
        emit({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          depth,
          purpose: tc.input.purpose || tc.input.expert || tc.input.name || tc.input.path || tc.input.url || "",
          title: toolHeadline(tc.name, tc.input), // 过程区那一行「动词 + 对象」
          input_preview: previewInput(tc),
        });
        const loopKey = tc.name + "\u0000" + JSON.stringify(tc.input || {});
        const seen = loopHist.get(loopKey);
        let r;
        const dead = deadMedia.get(tc.name);
        if (dead && dead.n >= 2) {
          // 连请求都不发了，连本地那道熔断闸也不走——直接把上次那句话奉还
          r = { content: `${dead.content}\n\n【本轮已停用 ${tc.name}】这条渠道连着拦了 ${dead.n} 次，再调也是这句话。按上面说的如实收尾，别把没拿到的结果当拿到过。`, isError: true };
        } else if (seen && seen.streak >= 4 && tc.name !== "ask_user") {
          // 同一调用已连续 4 次拿到一模一样的结果，第 5 次不再执行——结果不会变，只会烧钱
          loopHist.set(loopKey, { sig: seen.sig, streak: seen.streak + 1 }); // 拦下的也计数，拦了还来就该硬停了
          r = { content: `【系统拦截】你已用完全相同的参数连续 ${seen.streak} 次调用 ${tc.name}，每次结果都一模一样，本次未执行。别再重复同样的动作：换参数、换工具或换一条实现路径；确实无路可走就停止并如实说明卡在哪里。`, isError: true };
        } else {
          const sp = tr.span({
            name: `工具 ${tc.name}`,
            input: tc.input,
            metadata: { depth, tool: tc.name, title: toolHeadline(tc.name, tc.input) },
          });
          try {
            r = await runToolCall(tc, { emit, depth, deadline, stats, stopSignal, user, projectContext, sec, taskLabel, runToken, baseDir, llmOverride: L, askUser, lang, sessionId, traceNode: sp });
          } catch (e) {
            // 工具抛出来的异常在这里就地变成一条工具结果。让它往上冒的话，下面那条
            // history.push({role:"tool"}) 就跑不到，历史里留下一条配不上对的 assistant——
            // 会话落盘之后每次请求都 400。报错本身也该让模型看见，它才知道要换条路。
            r = { content: `（${tc.name} 执行时抛出异常：${(e && e.message) || e}）`, isError: true };
          }
          // 工具报错在本项目里是**正常返回**（模型要看见错才知道换条路），所以不能靠 catch 判——
          // 得看 isError。不这么写的话 trace 上满屏绿色，真正出问题的那几步一个都标不出来
          sp.end({ output: String(r.content || ""), error: r.isError ? String(r.content || "").slice(0, 500) : "" });
          if (r.extendMs) deadline += r.extendMs; // 等用户回答的时间不算任务运行时间
          const sig = String(r.content).slice(0, 2000);
          loopHist.set(loopKey, { sig, streak: seen && seen.sig === sig ? seen.streak + 1 : 1 });
        }
        if (r.mediaBreaker) {
          const d = deadMedia.get(tc.name) || { n: 0, content: "" };
          d.n += 1; d.content = String(r.content);
          deadMedia.set(tc.name, d);
          // 只喊一次。喊早了（第一次就喊）用户会以为是我们自己不让它试，喊晚了他已经干等了半天
          if (d.n === 2) emit({ type: "text", delta: callout.line("warn", `**这条渠道连不通，已经替你停掉了**：\`${tc.name}\` 撞的是同一堵墙（${String(r.content).split("\n")[0].replace(/^【|】$/g, "")}），不是问法的问题。它不会再往这条路上撞了，会带着「这一步没做成」继续往下走。要恢复：去 设置 → 模型 把这条渠道修好或换一条，按保存即刻生效。`), depth });
        }
        errStreaks.set(tc.name, r.isError ? (errStreaks.get(tc.name) || 0) + 1 : 0);
        if (r.isError) {
          const es = errSame.get(tc.name);
          const esig = String(r.content).slice(0, 2000);
          errSame.set(tc.name, es && es.sig === esig ? { sig: esig, n: es.n + 1 } : { sig: esig, n: 1 });
        } else errSame.delete(tc.name);
        if (tc.name !== "ask_user") { // 问用户的每次答案都不一样，也不该算进转圈
          callSeq.push(loopKey + "\u0001" + String(r.content).slice(0, 2000));
          if (callSeq.length > 12) callSeq.shift();
        }
        if (tc.name === "look_at_image" && !r.isError) sawImage = true; // 真看成过一次，收尾就不替它复核
        emit({
          type: "tool_result",
          id: tc.id,
          name: tc.name,
          depth,
          isError: r.isError,
          outcome: resultOutcome(tc.name, r.content, r.isError), // 过程区那一行的后半截「· 结果」
          preview: String(r.content).slice(0, 800),
          ...(r.diff ? { diff: String(r.diff).slice(0, 4000) } : {}), // 改文件那几步：过程卡上直接看动了哪几行
          ...(r.ckpt ? { ckpt: r.ckpt } : {}), // 检查点 id：卡上「回退到这步之前」按的就是它
        });
        if (!r.isError) {
          const srcs = collectSources(tc.name, tc.input, r.content);
          if (srcs.length) emit({ type: "sources", items: srcs, depth });
        }
        return { id: tc.id, name: tc.name, content: String(r.content), isError: r.isError };
      };

      // 只读工具（搜索/抓网页/读文件）并发跑：深度研究一口气抓五个链接，串行是五次网络等待
      // 叠加，并发只花最慢那一次。但并发只吃「连续的只读段」——会动文件、跑命令、委派专家的
      // 工具，先后顺序本身就是语义，打乱了就是改了它的意思，所以它们各自单跑、段间保持原顺序。
      // 以前是「整批全只读才并发」，于是 [搜, 搜, 写文件] 这种最常见的组合退回全串行，
      // 白等一次搜索的时间。切段之后前两个搜索照样并发，写文件仍旧排在它们后面。
      // 生成类（出图/出片/出声）同理，但单独一类、单独一个上限：一集短剧十二个镜头，
      // 一条条排队最坏要等上一两个小时，而这些调用之间本来就没有先后关系。
      const groups = splitParallelRuns(result.toolCalls, READ_ONLY_TOOLS, GEN_TOOLS);
      const genMax = Math.max(1, Math.min(4, Math.round(+config.agent.gen_parallel_max) || GEN_PARALLEL_MAX));
      let toolResults = [];
      try {
        for (const g of groups) {
          if (g.length > 1) {
            emit({ type: "parallel", count: g.length, kind: g._kind, depth });
            toolResults.push(...(await mapPool(g, g._kind === "gen" ? genMax : PARALLEL_MAX, runOne)));
          } else {
            toolResults.push(await runOne(g[0]));
          }
        }
      } catch (e) {
        // 兜底的第二道：无论如何都别让「已 push 的 assistant + 没 push 的工具结果」这种
        // 半截状态留在历史里落盘。缺谁补谁，push 完再把异常抛上去。
        const done = new Set(toolResults.map((r) => r.id));
        for (const tc of result.toolCalls) {
          if (!done.has(tc.id)) toolResults.push({ id: tc.id, name: tc.name, content: `（${tc.name} 未拿到结果：${(e && e.message) || e}）`, isError: true });
        }
        history.push({ role: "tool", results: toolResults });
        throw e;
      }
      history.push({ role: "tool", results: toolResults });
      filesOut.push();

      // 循环检测的提醒紧跟在工具结果后面注入，模型下一步就能看到；同时在界面明说，别让用户干瞪着它转圈
      const nudges = [];   // 给模型看的：把事实说准
      const humanly = [];  // 给用户看的：说清「发生了什么 + 接下来会怎样」，别扔一个术语让人猜
      for (const [k, v] of loopHist) if (v.streak >= 3 && !loopNudged.has("c:" + k)) {
        loopNudged.add("c:" + k);
        const tool = k.split("\u0000")[0];
        nudges.push(`用完全相同的参数调用 ${tool} 已连续 ${v.streak} 次拿到完全相同的结果`);
        humanly.push(`同样的参数调了 ${v.streak} 次 \`${tool}\`，每次拿回来的东西一模一样`);
      }
      for (const [name, n] of errStreaks) if (n >= 4 && !loopNudged.has("e:" + name)) {
        loopNudged.add("e:" + name);
        nudges.push(`${name} 已连续失败 ${n} 次`);
        humanly.push(`\`${name}\` 连着 ${n} 次都没成功`);
      }
      if (nudges.length) {
        history.push({ role: "user", content: `【系统·循环检测】${nudges.join("；")}。这是在死路上空转，时间和费用都在烧：立即换思路——换参数、换工具或换一条实现路径；实在无路可走就停下收尾，如实说明卡在哪里，严禁再重复同样的动作。` });
        // 这行是给人看的：一句话说清「卡住了 → 我做了什么 → 你可能要做什么」
        emit({ type: "text", delta: callout.line("warn", `**它在原地打转了**：${humanly.join("；")}。已经要求它换条路走（换参数、换工具或换个实现方式），走不通就会停下来告诉你卡在哪——不会一直烧时间和额度。你也可以直接点「停下」自己接手。`), depth });
      }

      // 硬停：提醒过、拦截过，模型还在同一个圈里转，就不是「换个思路」能劝回来的了。再让它转下去只有两种结局：
      // 撞到最大步数（用户看到「已达最大步数」，以为是活儿太多），或撞到自动续跑（续跑第一件事就是把同样的圈再转一遍）。
      // 所以这里停，而且这种停不续跑（continuable 认的前缀里没有它）。
      const dead = deadLoop({ loopHist, errStreaks, errSame, deadMedia, callSeq });
      if (dead) {
        stopNote = `陷入死循环（${dead}）`;
        emit({ type: "text", delta: callout.line("warn", `**已经替你停下来了**：${dead}。提醒过它换路、也拦过它，它还是在同一个圈里转，再转只是烧时间和额度。下面是它对做到哪一步的交代；把它撞墙的那条路修好（渠道、文件或命令），或者把要求说得更具体，再说「接着上次进度做」。`), depth });
        break;
      }

      if (step === maxSteps - 1) stopNote = `已达最大步数（${maxSteps} 步）`;
    }

    // 只有「跑满上限」才值得续：手动停止是用户不想再花钱，模型响应超时是模型挂了，续也白续
    // 「没做完就收摊」和撞上限一样值得续：都属于活儿还在、只是这一轮跑不动了
    const continuable = stopNote.startsWith("已达最大步数") || stopNote.startsWith("已达最大运行时间") || stopNote.startsWith("任务还有");
    if (!(continuable && roundsUsed < autoRounds && !(stopSignal && stopSignal.aborted))) break;
    roundsUsed++;
    deadline = Date.now() + (config.agent.max_runtime_ms || 1800000); // 新一轮把时间预算重新拉满
    emit({ type: "auto_continue", round: roundsUsed, total: autoRounds, note: stopNote, depth });
    // stopNote 本身就说明了「没做完」时别再重复一遍，撞上限的才需要补这半句
    const contWhy = stopNote.startsWith("任务还有") ? `上一轮${stopNote}` : `上一轮${stopNote}，任务还没做完`;
    // 进度档由框架亲手喂进去，不指望模型自己想起来去读——续跑第一步就该看到现场
    let progressDoc = "";
    try {
      const raw = fs.readFileSync(path.join(progressDir(), "PROGRESS.md"), "utf8").trim();
      if (raw) progressDoc = raw.length > 4000 ? raw.slice(0, 4000) + "\n…（进度档过长已截断，完整内容 read_file 自取）" : raw;
    } catch {}
    history.push({
      role: "user",
      content: progressDoc
        ? `【系统·自动续跑 第 ${roundsUsed}/${autoRounds} 轮】${contWhy}，继续。以下是工作目录 PROGRESS.md 的当前内容：\n\n${progressDoc}\n\n只做其中还没完成的部分，绝不重做已完成的事。每完成一个里程碑就 edit_file 更新 PROGRESS.md。全部完成后正常总结收尾。`
        : `【系统·自动续跑 第 ${roundsUsed}/${autoRounds} 轮】${contWhy}，继续。工作目录还没有 PROGRESS.md——先 list_files 看现场确认已经做到哪一步，立即补建 PROGRESS.md 清单，然后只做剩下的部分，绝不重做已完成的事。全部完成后正常总结收尾。`,
    });
    stopNote = "";
    }

    if (stopNote) {
      emit({ type: "limit", note: stopNote, depth });
      // 撞上限时，finalText 往往是半句过程叙述（"我先看一下这个文件"），直接抛给用户等于没有交代。
      // 再花一次调用让它把话说完：做到哪、有什么、还差什么。手动停止的不做——用户喊停就是不想再花钱。
      // 手动停止不花钱；模型响应超时也跳过——模型都挂起了，再拿它写收尾只是多等一轮超时
      if (!(stopSignal && stopSignal.aborted) && !stopNote.startsWith("模型响应超时")) {
        const wrapped = await wrapUp({ history, system, stopNote, emit, depth, stats, llmOverride: L, traceNode: tr });
        if (wrapped) finalText = wrapped;
      }
      // 「没做完」和「撞上限」得给不同的话：前者要把还差哪几项摆出来，后者才是叫用户调上限
      const notice = stopNote.startsWith("任务还有")
        ? `注意：${stopNote}，自动续跑轮次也用完了。还没打勾的是：${openLeft.slice(0, 5).join("、")}${openLeft.length > 5 ? ` 等 ${openLeft.length} 项` : ""}。直接跟我说「接着上次进度做」就能继续，进度档在工作目录的 PROGRESS.md。`
        : stopNotice(stopNote);
      finalText = finalText ? `${finalText}\n\n${notice}` : notice;
    }

    const usage = {
      prompt: stats.prompt,
      completion: stats.completion,
      cached: stats.cached || 0, // 其中命中缓存、按约 1/10 计费的那部分
      calls: stats.calls,
      elapsed_ms: Date.now() - stats.startedAt,
    };
    if (depth === 0) {
      emit({ type: "usage", model: L.model, provider: L.provider, ...usage });
    }
    if (ownsTrace) {
      tr.end({
        output: finalText || "",
        usage,
        metadata: { model: L.model, provider: L.provider || "", stopped: stopNote || "", steps: stats.calls },
      });
      tracer.flush(); // 任务刚结束正是用户点开链接的时刻，别让最后几条在队列里压两秒
    }
    return { finalText, usage, stopped: stopNote || null };
    } finally {
      // 最后一批产出必须在这一轮结束前发出去，不能等尾随定时器。
      // 出错路径上也要发：半截产出照样是用户的东西，不能因为任务栽了就藏起来
      if (filesOut) { try { filesOut.push(true); } catch {} filesOut.stop(); }
      unwatchSleep();
      releaseAwake();
    }
  }

  /**
   * 直调一个工具：不过模型、不进对话历史、不记 token 账。
   *
   * 「把这一格重画一遍」是个确定性动作：用户要的是同样的输入再来一次。走对话的话，
   * 每点一次都得先烧一轮主模型的 token 把 prompt 复述给它听，而且模型有权改写那段话、
   * 甚至顺手多干点别的——按下去的是「重画」，回来的是「差不多的东西」。这条路把参数
   * 原样交给工具，一个字都不改。
   *
   * 白名单只有这四个，形状都是「给定输入 → 一个产物文件」的纯函数。写文件、跑脚本这些
   * 不在里面：那些要的是模型的判断，不该做成一颗界面上能直接按的按钮。
   */
  async function runTool(name, input, { user, baseDir, taskLabel, sec, stopSignal } = {}) {
    if (!DIRECT_TOOLS.includes(String(name || ""))) {
      throw Object.assign(new Error(`「${name}」不支持直调。能直接跑的只有：${DIRECT_TOOLS.join("、")}`), { status: 400 });
    }
    // 不给 deadline：它在 executeTool 里只用来压缩审批的等待时间，而这四个工具一个闸门都不过。
    // 真正的超时是工具自己那份（生图/配音最少给到 5 分钟），拿一个更短的期限去卡它只会误伤。
    return await executeTool(String(name), input || {}, execOpts({
      stopSignal,
      taskLabel: taskLabel || "直调工具",
      user,
      baseDir,
      sec,
    }));
  }

  return { runTask, getSkills, toolList, runTool, DIRECT_TOOLS, compactHistory };
}

// 并发上限：抓页面是等网络，开太多既没有更快，还容易被对方站点当成扫站封 IP
const PARALLEL_MAX = 3;

/**
 * 生成类工具：出图、出片、出声。
 *
 * 跟只读工具分成两类而不是并进一类，是因为这两类的约束正好相反：
 *   · 只读工具便宜、快、失败了重来一次也不心疼，瓶颈只是网络往返；
 *   · 生成类每一条都要钱（视频按条计费），慢的以分钟计（tools.js 里视频轮询上限 10 分钟），
 *     而且**会写文件**。
 * 所以两类既不能混进同一段（只读段里混进写文件的，会打乱「先写再读」的先后依赖），
 * 并发上限也得各给各的。
 *
 * html_to_image 不在这儿：htmlshot.js 自己就是一条 `let queue = Promise.resolve()` 的串行队列
 * （一个 Electron 窗口轮流截图），放进来也并发不了，白给用户一个「在并发」的假象。
 */
const GEN_TOOLS = ["generate_image", "generate_video", "text_to_speech"];
/**
 * 允许「不过模型直接跑」的工具。挑选标准只有一条：给定输入 → 一个产物文件，中间不需要任何判断。
 * 花钱的那三个都在这儿（重画一格本来就是为了省下复述 prompt 的那一轮），外加一个本机渲染的截图。
 * write_file / run_shell 这些永远不进来：把它们做成界面上一按就执行的按钮，等于开了一个没人看守的门。
 */
const DIRECT_TOOLS = ["generate_image", "generate_video", "text_to_speech", "html_to_image"];
/** 生成类的并发上限。默认 2 而不是 3：这一类每条都花钱，宁可慢一点也别一次并出去三条视频 */
const GEN_PARALLEL_MAX = 2;

/**
 * 把一批工具调用切成若干「可并发的段」：连续的同类工具合成一段（段内并发），
 * 其余每个自成一段（单独跑）。段的先后顺序＝模型给的原顺序，一步都不许挪——
 * 「先写文件再读回来」这种前后依赖，顺序错了结果就是错的。
 *
 * 类别有三种：ro（只读）、gen（生成类，见 GEN_TOOLS）、solo（其余一律单跑）。
 * 只有**同一类**的相邻调用才合段：并发上限不同是一层原因，更要紧的是生成类会写文件，
 * 跟 read_file 混进同一段就等于把先后顺序交给了调度器。
 *
 * gen 这个名单是**可选第三参**：不传时这个函数的行为跟以前逐字节一致（只有只读会合段），
 * 所以只认两个参数的老调用点和老测试都不用改。
 */
function splitParallelRuns(calls, readOnly, gen) {
  const groups = [];
  for (const tc of calls || []) {
    const kind = (readOnly || []).includes(tc.name) ? "ro" : (gen || []).includes(tc.name) ? "gen" : "solo";
    const last = groups[groups.length - 1];
    if (kind !== "solo" && last && last._kind === kind) last.push(tc);
    else {
      const g = [tc];
      g._kind = kind;
      g._ro = kind === "ro"; // 老字段留着：改之前的调用方是按它认「这段是不是只读」的，删了等于给下游埋一个 undefined
      groups.push(g);
    }
  }
  return groups;
}

/** 限流并发跑一批，结果按原顺序返回（工具结果的顺序要和 tool_calls 对得上） */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// ================= 执行行（治「看一屏 JSON 不知道它在干嘛」） =================
// 参考 Codex / Claude Code 的做法：过程区每一步只占一行「动词 + 对象 · 结果」，
// 原始入参和完整返回一个字没删，收在卡里，想看点开就是。
// 默认展示的是「发生了什么」，不是「传了什么参数」——后者是排障才要看的东西。
const TOOL_VERB = {
  canvas_manage: "改画布", read_file: "读", read_document: "读文档", write_file: "写", edit_file: "改", list_files: "列目录", search_files: "搜文件",
  run_shell: "命令", run_node: "跑脚本", web_search: "搜", fetch_url: "抓", render_page: "渲染",
  check_page: "体检", html_to_image: "截图", look_at_image: "看图", generate_image: "生图",
  generate_video: "生成视频", gen_diagram: "画图表", text_to_speech: "配音", transcribe_audio: "转文字", remember: "记住",
  forget: "忘掉", library_list: "翻资料库", library_read: "读资料", library_import: "取素材", save_skill: "存技能",
  use_skill: "用技能", desktop_pet: "桌面宠物", ask_user: "问你一句", feishu_doc: "飞书文档", notify_user: "推到群",
  schedule_task: "排期", list_schedules: "看排期", send_email: "发邮件",
  delegate_to_expert: "委派专家", delegate_to_team: "委派专家团",
};

/** 太长的路径/命令只留尾巴：前面那截目录对人没信息量，文件名才有 */
function tailText(v, n) {
  const t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return t.length > n ? "…" + t.slice(-(n - 1)) : t;
}

/**
 * 一行说清这一步在干什么：`读 报告.md`、`搜「小红书 标题」`、`命令 npm test`。
 * 认不出的工具（含 MCP 连接器）退回「工具名 + 第一个像话的入参」，绝不留空——
 * 留空就等于回到从前那种「⚙ mcp__x__y」，用户还是不知道它在动什么。
 */
function toolHeadline(name, input) {
  const i = input && typeof input === "object" ? input : {};
  const verb = TOOL_VERB[name] || String(name || "").replace(/^mcp[_:]+/, "").replace(/_/g, " ").slice(0, 20);
  // 参数本身就坏了，底下一个字段都读不出来。不说破的话这行只剩一个光秃秃的动词
  // （红色的「问你一句」后面什么都没有），用户只会以为是这个功能坏了
  if (typeof i._raw === "string") return verb + " 参数没发完整";
  const q = (v) => "「" + tailText(v, 40) + "」";
  let obj = "";
  switch (name) {
    case "canvas_manage":
      obj = `${i.operation || "get"}${i.kind ? " · " + i.kind : ""}${i.node_id ? " · " + i.node_id : ""}`; break;
    case "read_file": case "write_file": case "edit_file": case "html_to_image": case "look_at_image":
      obj = tailText(i.path, 46); break;
    case "list_files": case "search_files":
      obj = (i.query ? q(i.query) + " " : "") + tailText(i.path || "", 30); break;
    case "run_shell":
      obj = tailText(String(i.command || "").split("\n")[0], 56); break;
    case "run_node":
      obj = `${String(i.code || "").split("\n").length} 行 Node`; break;
    case "web_search":
      obj = q(i.query); break;
    case "fetch_url": case "render_page": case "check_page": {
      const u = String(i.url || i.path || "");
      obj = tailText(u.replace(/^https?:\/\//, "").replace(/\/$/, ""), 46); break;
    }
    case "generate_image": case "generate_video": case "gen_diagram": case "text_to_speech":
      obj = tailText(i.prompt || i.text || i.spec || "", 46); break;
    case "ask_user":
      obj = tailText(i.question || "", 46); break;
    case "delegate_to_expert":
      obj = String(i.expert || ""); break;
    case "delegate_to_team":
      obj = String(i.team || ""); break;
    case "transcribe_audio":
      obj = tailText(String(i.path || "").split("/").pop(), 40); break;
    case "schedule_task": {
      // 「排期 每天 09:00 · 写日报」——动作和时间都得在这一行里，光写个 create 等于没说
      // at 传进来的是 `+5m` 这种原样写法，这儿先算成人话；算不出来就照抄，总比不写强
      let when = "";
      if (i.at) {
        try { when = scheduler.describeWhen({ at: scheduler.parseAt(i.at) }); } catch { when = String(i.at); }
      } else if (i.cron) when = scheduler.describeCron(i.cron) || i.cron;
      obj = tailText([{ create: "新排", update: "改", delete: "删", enable: "启用", disable: "停用" }[String(i.action || "")] || String(i.action || ""),
        when, i.name || i.task || i.id || ""].filter(Boolean).join(" · "), 46); break;
    }
    case "send_email":
      // 「发邮件 张三 · 本周周报」——收件人和主题得同时在这一行里，光写个主题看不出发给谁了
      obj = tailText([mailer.parseAddrs(i.to).join("、"), i.subject || ""].filter(Boolean).join(" · "), 46); break;
    case "use_skill": case "save_skill":
      obj = String(i.name || ""); break;
    case "remember": case "forget":
      obj = tailText(i.text || i.key || "", 40); break;
    default: {
      const cand = i.purpose || i.path || i.url || i.query || i.name || i.text ||
        Object.values(i).find((v) => typeof v === "string" && v.trim());
      obj = tailText(cand || "", 46);
    }
  }
  // 带书名号的对象自己就分好界了，再补空格反而散：`搜「小红书 标题」`不是`搜 「小红书 标题」`
  return (verb + (obj ? (obj.startsWith("「") ? "" : " ") + obj : "")).trim();
}

// 返回的是「数据」的工具：结果就是文件内容/搜索结果本身，第一行是数据不是交代，
// 拿它当摘要等于把文件第一行糊到界面上。这些一律报「拿回来多少」。
const DATA_RESULT_TOOLS = new Set([
  "read_file", "read_document", "list_files", "search_files", "web_search", "fetch_url", "render_page",
  "run_shell", "run_node", "library_list", "library_read", "look_at_image", "check_page",
]);

/**
 * 一行说清这一步的结果。成功且返回的是数据 → 报量（几条 / 几行 / 几字）；
 * 其余用工具自己那句交代（"已新建 报告.md（4210 字节）"）；失败就把失败原因原样端上来——
 * 界面上写个红色「失败」而不说为什么，用户还得展开才知道发生了什么。
 */
function resultOutcome(name, content, isError) {
  const text = String(content == null ? "" : content);
  const first = (text.trim().split("\n").find((l) => l.trim()) || "").trim();
  if (isError) return tailText(first, 70) || "失败";
  if (!text.trim()) return "没有内容返回";
  if (name === "web_search") {
    const n = (text.match(/https?:\/\//g) || []).length;
    if (n) return `${n} 条结果`;
  }
  if (name === "list_files" || name === "search_files") {
    return `${text.split("\n").filter((l) => l.trim()).length} 项`;
  }
  if (DATA_RESULT_TOOLS.has(name)) {
    const lines = text.split("\n").length;
    return lines > 1 ? `${lines} 行` : `${text.length} 字`;
  }
  return first.length > 70 ? first.slice(0, 70) + "…" : first;
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

/**
 * 「这个文件是不是本回合的产出」的判据。并行任务共用一个工作目录，判错了用户就会
 * 在一条对话里看到另一条对话的东西。
 *
 * 两道关，顺序不能反：
 *
 * 1）**目录归属**。每条对话各有各的任务文件夹，谁的文件夹就是谁的产出——这是确定性的事实。
 *    只有这一道拦得住下面这桩真事故：湖南网站那条对话 17:38 起跑、一直在写文件，用户 17:55
 *    另开一条问 paywall 的新对话，新对话的差异检测先跑到，_have.txt / _r2.txt / _dh.txt /
 *    dist/index.html / hunan_travel.html 五个文件整批挂进了新对话的「本回合产出」
 *    （data/sessions/s_1788803711031_608301.json 里原样存着）——一眼就看得出
 *    那几个图标是另一条对话的。
 *
 * 2）**版本认领**（文件名+mtime，先到先得）。工作区根目录下的文件没有文件夹可依，
 *    只有这一道能去重；文件再被改一次（mtime 变了）就允许重新认领。
 *
 * 第一道只否掉「别人已登记的目录」，不否掉所有外层文件：根目录的文件、还没人认领的目录
 * 照旧算数，免得把「这一轮真往工作区根目录写了个东西」也误杀。两本账都只是去重提示，
 * 撑大了清空最多短暂多报，不丢数据。
 */
/**
 * 产出清单发射器：两条引擎路共用一份，行为必须一模一样（以前是各写一遍，改一边漏一边）。
 *
 * 它替掉的是「每来一个工具结果就 outputFiles() 走一遍全树、再把整份 500 条清单推给前端」。
 * 实测用户那个工作目录：一次走树 9.6ms（其中 4.7ms 是重复检测在读盘 6.48 MB，已在 tools.js
 * 那边加缓存降到 ~5ms/0 字节），一份 files 事件的 JSON 是 **47.8 KB**。本机 CLI 那条路是
 * **每个工具结果**都发一次，一趟 100 步的任务就是 4.8 MB 白推、500ms 同步读盘卡在事件循环上。
 *
 * 两道闸：
 *   1) 节流：gapMs 内最多走一次树，挤进来的合并成一条尾随的（不是丢掉——尾随那次一定会发，
 *      所以产出卡最多晚 gapMs 出现，不会不出现）；
 *   2) 没变就不发：把这份清单的指纹（名字+大小+mtime）跟上次发出去的比，一个字节都没动就
 *      整条事件省掉。绝大多数工具（搜索、读文件、列目录）压根不写盘，那些事件对界面是纯噪音。
 *      删文件不改 changed（changed 只看 mtime），所以指纹里带上条数和名字，删了照样发得出去。
 *
 * stop() 必须在任务收尾时调：尾随定时器要是烧到 SSE 关掉之后才响，就是往已经断掉的连接里写。
 */
/**
 * 「这回合产出了什么」的判据里，除了基线还必须有一道**绝对时间闸**。
 *
 * 2026-09-17 的真实故障：一次做小红书图文的任务，对话末尾那块「本回合产出」把工作目录里
 * 从 0828 到 0917 的几百个文件全倒了出来——这次真正做的 8 张卡反而被埋在最底下。
 *
 * 根子在 outputFiles()：它按 mtime 倒序**只取最新 500 条**。于是基线记的是开跑那一刻的
 * 最新 500 条，而"不在基线里"被当成了"新产出"。任务中途造了几十个中间文件、干完又把它们删掉，
 * 这个 500 条的窗口就往回滑一截，几个月前的旧文件重新挤进列表——它们当然不在基线里，
 * 于是整批被认成"这回合刚做的"。ownership 那层也拦不住：CLI 是新进程，dirOwners 里只登记了
 * 本次任务自己的文件夹，别人的目录一律"无主"，照样放行。
 *
 * 闸门本身很便宜：一个文件要算这回合的产出，它的 mtime 至少得在这回合开跑之后。
 * 0905 写的文件永远过不了这一关，不管窗口怎么滑、基线丢没丢过它。
 * 留 2 秒余量是给文件系统时间戳精度和「先建文件再落最后一笔」那点抖动的。
 *
 * 代价说清楚：`cp -p` 那种保留原 mtime 搬进来的文件会被漏掉。这是有意的取舍——
 * 漏报一个搬运来的旧文件，比把几百个陈年文件冒充成今天的成果要好得多。
 */
const MTIME_SLACK_MS = 2000;
function makeFilesEmitter({ emit, ownership, baseDir, runToken, gapMs = 300, after = null, since = null }) {
  const baseline = new Map();
  for (const f of outputFiles()) baseline.set(f.name, f.mtime);
  // 这回合的起点。可注入是为了能测（测试里造的文件 mtime 就在当下这一两毫秒内）
  const startedAt = (since == null ? Date.now() : Number(since)) - MTIME_SLACK_MS;
  const bornAfterStart = (f) => {
    const t = Date.parse(f && f.mtime);
    return Number.isFinite(t) ? t >= startedAt : true; // 时间戳读不出来就别拿它当拒绝的理由
  };
  let lastAt = 0, timer = null, lastSig = "", dead = false;
  const walk = () => {
    lastAt = Date.now();
    const files = outputFiles();
    const changed = [];
    for (const f of files) {
      const known = baseline.get(f.name);
      baseline.set(f.name, f.mtime);
      if (known === f.mtime) continue;
      // 用户自己刚传进来的素材（粘进输入框的图、拖进来的文件）：它落在这条会话的成果文件夹里，
      // mtime 也在开跑之后，两道闸都拦不住——可写它的人是用户，不是 agent。必须在 mine() 之前
      // 挡掉：mine() 是会落账的，一旦认领，后面 agent 真改了这个文件反而会被当成"别人的"。
      if (isUserInput(f)) continue;
      // 基线里没有它，只说明它刚挤进这 500 条的窗口，不说明它是今天写的
      if (!bornAfterStart(f)) continue;
      if (ownership.mine(f, baseDir, runToken)) changed.push(f.name);
    }
    // 指纹带 size：同一秒内原地改写、mtime 精度不够时，长度变了照样能认出来
    let sig = String(files.length);
    for (const f of files) sig += "\u0000" + f.name + "|" + f.mtime + "|" + f.size;
    if (!changed.length && sig === lastSig) return; // 盘上一个字节没动：这条事件对界面是纯噪音
    lastSig = sig;
    // root/full 是这份清单的作用域：前端靠它判断能不能拿这份列表给旧产出盖「已删除」
    emit({ type: "files", files, changed, ...filesScope(files) });
    if (after) after(changed);
  };
  return {
    /** @param {boolean} [now] 立刻走一遍（收尾用）：产出必须在这一轮结束前落到界面上 */
    push(now) {
      if (dead) return;
      if (timer) { clearTimeout(timer); timer = null; }
      const wait = gapMs - (Date.now() - lastAt);
      if (now || wait <= 0) { walk(); return; }
      timer = setTimeout(() => { timer = null; if (!dead) walk(); }, wait);
      if (timer.unref) timer.unref(); // 别为了一条产出事件把进程吊着不退
    },
    stop() { dead = true; if (timer) { clearTimeout(timer); timer = null; } },
  };
}

function makeOwnership() {
  const dirOwners = new Map();  // 任务目录名 -> runToken
  const fileClaims = new Map(); // 文件名 -> { owner, mtime }
  const topSeg = (n) => { const s = String(n || ""); const i = s.indexOf("/"); return i < 0 ? s : s.slice(0, i); };

  /** 任务开跑时登记自己的文件夹 */
  function claimBaseDir(baseDir, runToken) {
    const top = topSeg(baseDir);
    if (!top) return;
    if (dirOwners.size > 500) dirOwners.clear();
    dirOwners.set(top, runToken);
  }

  /** 这个文件躺在「别的任务已登记的文件夹」里吗 */
  function inForeignDir(name, baseDir, runToken) {
    const top = topSeg(name);
    if (!top || top === String(name || "")) return false; // 根目录下的文件，没有文件夹归属可言
    if (top === topSeg(baseDir)) return false;            // 自己的文件夹
    const owner = dirOwners.get(top);
    return owner !== undefined && owner !== runToken;
  }

  /** 判定并（判定为「是我的」时）落账。file 是 outputFiles() 里的一项 */
  function mine(file, baseDir, runToken) {
    const name = file && file.name;
    if (!name) return false;
    if (inForeignDir(name, baseDir, runToken)) return false;
    const claim = fileClaims.get(name);
    // 同一版本已被别的并行任务认领 → 是它的产出。仍有一个小窗口：对方写完文件但
    // 它那步工具还没跑完、没来得及认领——误报也只是多摆一张卡片，不丢文件
    if (claim && claim.owner !== runToken && claim.mtime === file.mtime) return false;
    if (fileClaims.size > 1000) fileClaims.clear();
    fileClaims.set(name, { owner: runToken, mtime: file.mtime });
    return true;
  }

  return { claimBaseDir, inForeignDir, mine, _dirOwners: dirOwners, _fileClaims: fileClaims };
}

module.exports = { createAgentRuntime, splitParallelRuns, toolHeadline, resultOutcome, missingDeliverables, unseenVisualClaims, unfinishedMilestones, UNFINISHED_RE, trimHistory, historyChars, collectSources, mapPool, PARALLEL_MAX, GEN_TOOLS, DIRECT_TOOLS, GEN_PARALLEL_MAX, makeOwnership, makeFilesEmitter, deadLoop, findCycle, pausedMediaBlock, stopNotice, DEAD_LOOP_LIMITS };
