// @ts-check
"use strict";
/**
 * 技能安装前的体检。
 *
 * 为什么需要它：一个「技能」就是一个目录，里头一份 skill.md 写着**给 agent 看的指令**，
 * 外加随便什么附件。而这个 agent 手里有 shell。所以「装一个技能」的真实含义是——
 * **把一个陌生人写的指令，接到一个能在你机器上执行命令的东西上**。
 * 这跟 npm install 一个包不是一回事：npm 包要你 require 它才跑，技能是 agent 自己会去读、
 * 会照着做的。装完之后没有第二道门。
 *
 * 本机上有两个位置让这件事比通用场景更要命：
 *   · skill.md 的 frontmatter 里那句 description，**每一条任务**都会进系统提示词
 *     （agent.js 那份技能清单，不管你这次用不用得上这个技能）。也就是说注入写在
 *     description 里是**常驻**的，写在正文里只有真去读它的时候才生效。所以同一条规则
 *     命中 frontmatter 时会升一级。
 *   · 我们的 frontmatter 解析器只认 name 和 description 两个键（skills.js），
 *     所以 allowed-tools 在本机是**不生效**的。但同一份文件被人拷去 Claude Code /
 *     Cowork 就生效了，所以这条留着，只是 warn 不 block。
 *
 * ── 参考了哪些开源项目（都读过源码，规则是抄来的，代码不是） ────────────────
 *
 * 规则表主要是从这两个项目的公开规则里对着抄+改的，两个都是 MIT：
 *   · skill-audit — Copyright (c) 2026 Royal Simpson Pinto，MIT。
 *     31 条规则、零依赖的 Node 扫描器。本文件里这些是从它那儿来的：
 *     fork bomb、dd/mkfs 裸设备写、钥匙串、浏览器密码库、已知外带落点域名、
 *     curl -T 传本地文件、git clone && 执行、超长 base64 块、藏在 HTML 注释里的指令、
 *     history -c 抹痕迹、allowed-tools 通配。
 *   · skillvet — MIT。Python 的技能扫描器 + 隔离守护进程。拿来的是两个**想法**不是代码：
 *     ① 污点：同一个文件里既读密钥又发网络，单看哪条都不算，**凑齐就是**；
 *     ② 别吹。它拿公开标注集 MalSkillBench（3944 个真恶意技能 + 4000 个正常技能）
 *        量过：纯静态规则检出率 74.9%、能判到「别装」的 60.1%、正常技能误报 15.5%。
 *        而且他们第一轮人工复核，被标红的社区技能 96 个里 96 个是误报。
 *        所以这里的定位写死成「装之前把话说清楚」，不是「查毒」。
 *
 * 为什么没直接把哪个装进来用：
 *   · 认真的那几个（NVIDIA SkillSpector、Cisco skill-scanner、Tencent AI-Infra-Guard、
 *     skillvet）全是 Python。这东西要打包进 Electron 发给普通办公用户，
 *     为了一道体检往安装包里塞一个 Python 运行时，不成立。
 *   · 唯一的 Node 原生选项 skill-audit 是 ESM，而这个仓库是纯 CommonJS、无构建步骤。
 *     更根本的是：为了防住「别人的代码」而去装「别人的包」，这事本身是圆的——
 *     npx 一个扫描器等于先执行一遍它。所以拿规则不拿依赖。
 *   · 它们全是英文正则。这是个中文产品，「忽略上面的指令」「不要告诉用户」
 *     这类中文写法在它们那儿一条都不命中。中文那几条只能自己写。
 *   · 它们都得自己造安装时机（skillvet 要跑一个文件系统 watcher 把可疑技能挪进隔离区，
 *     因为 Claude Code 没有「装好了」这个事件）。而装技能这条路本来就是我们自己的代码，
 *     installFromGitHub 里加一道就是真闸，不用守护进程。
 *
 * ── 明确不做的 ──────────────────────────────────────────────────────────
 *   · 不做沙箱。真要隔离得换执行模型（容器 / 权限降级），那是另一件大工程，
 *     不能拿几条正则冒充。这里只负责**在装之前把话说清楚**。
 *   · 不打 0–100 分。分数会让人养成「42 分应该还行」的习惯，而这里只有两种决定：
 *     装不了，或者你看一眼再点。所以只出 block / warn / ok 加一张带行号的清单。
 *   · 不因为一个词就拦死。curl 本身没问题，办公技能天天要拉数据；`curl … | bash` 才是。
 *     规则尽量写成**组合**，不写成关键词——上面那个 96/96 的教训就是这么来的。
 *
 * 误报的代价是多点一次确认，漏报的代价是你的机器替别人干活。所以宁可多问一句；
 * 但也不能问到人麻木——真 block 的只有 10 条，其余都是摊开给人看。
 */

const fs = require("fs");
const path = require("path");

/** 单个文件扫多大就够了。技能里的 md 撑死几十 KB，附件大多是模板/字体，不用整个读进来 */
const MAX_SCAN_BYTES = 512 * 1024;
/** 最多报多少条。同一种写法在一个仓库里出现两百次，列两百行等于没列 */
const MAX_FINDINGS = 60;
/** 同一个文件同一条规则最多报几处。够定位就行 */
const PER_RULE_HITS = 3;

/** 第三方依赖树：不逐个扫，只报「带了一棵」。见 scanDir 里那段注释 */
const VENDOR_DIR = /^(?:node_modules|\.?venv|site-packages|vendor|third_party|bower_components)$/;

/** 明显是二进制的，不做文本扫描（但下面按扩展名认可执行文件那条照样看得见它） */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".mp3", ".mp4", ".wav", ".mov", ".webm",
  ".xlsx", ".docx", ".pptx",
]);

/** 可执行 / 脚本文件。装进来就意味着「这个技能打算让 agent 去跑一个现成的程序」 */
const EXEC_EXT = new Set([
  ".sh", ".bash", ".zsh", ".fish", ".command",
  ".ps1", ".psm1", ".bat", ".cmd",
  ".exe", ".dll", ".so", ".dylib", ".msi", ".scpt", ".applescript", ".jar",
]);

/**
 * 规则表。
 *
 * level    "block" = 装不了；"warn" = 摊开给人看，点确认才装
 * cat      归类。"secret" 和 "netout" 两类还兼着污点判定的输入（见 taint()）
 * fmOnly   只在 frontmatter 里看（那几条规则在正文里没意义）
 * why      界面上直接显示这一句。写不出「为什么这条是坏事」的规则不该存在，
 *          因为那种规则只会训练人闭着眼点确认
 */
const RULES = [
  // ───────────────── 拦死：一个正经办公技能没有理由这么写 ─────────────────
  {
    id: "pipe-to-shell", level: "block", cat: "exec",
    // 后面那两个否定环视是有来历的：`curl … | python3 -c "import sys,json; …"` 把下载到的东西
    // 当**数据**喂给一段写死的脚本，跟「执行下载到的代码」是两回事。真技能里这么写解析 JSON 很常见。
    re: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]{0,400}\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b(?!\s+-c\b)|\b(?:curl|wget)\b[^\n|]{0,400}\|\s*(?:python[0-9.]*|node|perl|ruby)\b(?!\s+-[ce]\b)|\|\s*iex\b/i,
    why: "把网上下载的东西直接管道给 shell 执行。下载到的内容随时可以被换掉，你审过的和实际跑的不是一个东西——这是供应链投毒最常走的一条路。",
  },
  {
    id: "reverse-shell", level: "block", cat: "exec",
    re: /\bnc\b[^\n]{0,80}\s-[a-z]*e[a-z]*\s|\/dev\/tcp\/\d|\bbash\s+-i\b[^\n]{0,40}(?:>&|\|)|socat\b[^\n]{0,60}EXEC:/i,
    why: "反弹 shell：把这台机器的命令行接到外面一个地址上。办公技能没有任何理由需要这个。",
  },
  {
    id: "read-private-key", level: "block", cat: "secret", taintSecret: true,
    // 必须带路径（~/.ssh/id_ 或 /.ssh/id_），不认光秃秃一个 id_rsa——
    // 实测拿 34 个正常技能扫，光这一个词就在一篇博客正文和 pygments 的词法表里各中一次。
    re: /(?:~|\$HOME|%USERPROFILE%|\/Users\/[^\s/]+|\/home\/[^\s/]+)[/\\]\.(?:ssh[/\\]id_|aws[/\\]credentials|config[/\\]gcloud|kube[/\\]config|docker[/\\]config\.json|netrc|git-credentials)|[/\\]\.ssh[/\\]id_[a-z]|-----BEGIN\s+[A-Z ]*PRIVATE\s+KEY-----/i,
    why: "去读 SSH 私钥 / 云厂商凭据。技能要用云服务，正确做法是让用户在设置里填，而不是自己去翻人家的密钥文件。",
  },
  {
    id: "decode-then-run", level: "block", cat: "exec",
    re: /base64\s+(?:-d|--decode|-D)[^\n]{0,80}\|\s*(?:ba|z)?sh\b|(?:eval|exec|system)\s*[("`$]{1,2}[^\n]{0,80}(?:base64|b64decode|atob)|(?:eval|new\s+Function)\s*\(\s*atob\s*\(/i,
    why: "先把一段编码过的东西解开、再执行。唯一的效果是让人审不了它到底要干什么。",
  },
  {
    id: "wipe-disk", level: "block", cat: "destroy",
    re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~\/?(?:\s|$|\*)|\$HOME\/?(?:\s|$|\*)|--no-preserve-root)/,
    why: "递归删除根目录或整个用户目录。没有哪个技能需要这么写，写了要么恶意、要么错得离谱。",
  },
  {
    id: "disk-device-write", level: "block", cat: "destroy",
    re: /\bdd\s+if=[^\n]{0,60}\bof=\s*\/dev\/|\bmkfs(?:\.\w+)?\s+\/dev\/|>\s*\/dev\/(?:sd[a-z]|nvme\d|disk\d)/i,
    why: "往裸设备写 / 格式化磁盘。这一类操作不可逆，出手就是整块盘。",
  },
  {
    id: "fork-bomb", level: "block", cat: "destroy",
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    why: "fork 炸弹：把进程表撑满，机器当场卡死，只能硬重启。",
  },
  {
    id: "anti-forensics", level: "block", cat: "exec",
    re: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b|>\s*~?\/?\.(?:bash|zsh)_history\b|\bshred\s+-[a-z]*u\b/i,
    why: "抹执行痕迹（清 history、清掉 HISTFILE）。一个正当的技能不需要隐藏自己干过什么——会这么写只有一种解释。",
  },
  {
    id: "bidi-control", level: "block", cat: "hidden",
    // U+202A-202E / U+2066-2069：能让同一段文本在屏幕上倒着显示。
    // 就是 Trojan Source（CVE-2021-42574）那一类——你读到的和机器读到的不是一句话。
    re: /[‪-‮⁦-⁩]/,
    why: "文件里有双向控制符：它能让同一行字在屏幕上显示成另一个顺序。人审到的和 agent 读到的会不一样，这种字符出现在技能里没有第二种解释。",
  },
  {
    id: "exfil-intent", level: "block", cat: "secret",
    // 关键是「到哪儿去」那半句。没有它就只是邻近度匹配——
    // skillvet 人工复核时爆掉的两条坏规则，其中一条就是这个形状；
    // 本地这 34 个正常技能里，"sends via Resend API (needs RESEND_API_KEY …)" 一句就中了 4 次。
    re: /(?:exfiltrat\w*|send|upload|post|forward|leak)\s+(?:the\s+|your\s+|all\s+|user'?s?\s+)?(?:secrets?|tokens?|passwords?|credentials?|private\s*keys?|api[\s_-]?keys?|\.env)\b[^\n.]{0,20}\s(?:to|into)\s+\S|(?:把|将)[^\n。]{0,20}(?:密钥|口令|密码|凭据|凭证|token|api[\s_-]?key)[^\n。]{0,20}(?:发|传|上传|上报|回传|送)(?:给|到|往|去)/i,
    why: "白纸黑字写着要把密钥 / 口令送到某个地方去。在证明它无辜之前，按恶意处理。",
  },

  // ───────────────── 摊开给人看：只有你能判断这一处该不该有 ─────────────────
  {
    id: "zero-width", level: "warn", cat: "hidden",
    re: /[​-‍⁠﻿]/,
    why: "有零宽字符（屏幕上完全看不见）。有时是从网页复制带进来的脏字符，有时是藏指令。审的时候你看不见它，agent 看得见。",
  },
  {
    id: "prompt-injection", level: "warn", cat: "inject",
    re: /(?:忽略|无视|不要理会|不用管)(?:以上|上面|之前|前面|先前)[^\n。]{0,12}(?:指令|指示|要求|提示|规则|命令)|ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|above|prior|earlier|preceding)\s+(?:instructions?|rules?|prompts?|guidelines?)|(?:你|您)(?:现在|从现在起|接下来)[^\n。]{0,20}(?:不受|无视|没有)(?:任何)?(?:限制|约束)/i,
    why: "写着「忽略之前的指令」这类话。技能文本是直接进 agent 上下文的，这种句子就是冲着改变它的行为去的。",
  },
  {
    id: "hide-from-user", level: "warn", cat: "inject",
    re: /(?:不要|别|无需|不用|禁止)(?:告诉|告知|提示|通知|回报|汇报|展示给)[^\n。]{0,8}(?:用户|使用者|人类|主人|老板)|(?:do\s*not|don'?t|never)\s+(?:tell|inform|show|reveal|mention|notify|alert)\b[^.\n]{0,25}\buser/i,
    why: "要求 agent 瞒着用户做事。技能可以有自己的做法，但「别让用户知道」这一条，正当的技能永远不需要。",
  },
  {
    id: "skip-confirmation", level: "warn", cat: "inject",
    // 「不用问用户挑哪个模板」是正常的技能设计，「删完不用问」不是。
    // 所以「不问」这半句必须挂在一个**有后果的动作**上；单独点名那道闸本身
    // （跳过确认 / 跳过审批 / skip the approval）才无条件算。
    // 原来不挂动作，于是「没参会的人读完不用再问任何人」这种句子也中——
    // 34 个正常技能里这一条一个人贡献了 10 处假命中。
    re: /(?:删除|移除|覆盖|发送|上传|提交|执行|运行|安装|部署|付款|转账|授权)[^\n。]{0,12}(?:不(?:需要|用)(?:再)?(?:询问|问|确认)|无需(?:确认|询问))|(?:不(?:需要|用)(?:再)?(?:询问|问|确认)|无需(?:确认|询问))[^\n。]{0,12}(?:直接)?(?:删除|移除|覆盖|发送|上传|提交|执行|运行|安装|部署|付款|转账)|跳过(?:确认|审批|审核|二次校验)|(?:delete|remove|overwrite|send|upload|execute|run|install|deploy|push|pay|transfer|grant)\w*[^\n.]{0,24}without\s+(?:asking|confirmation|permission|approval)|skip\s+(?:the\s+)?(?:confirmation|approval|review)\b/i,
    why: "要求跳过「问一句」这一步。这台机器上危险动作本来是要你点确认的（审批那条链），一个技能主动来拆这道闸，得你自己说它为什么该拆。",
  },
  {
    id: "disable-safety", level: "warn", cat: "inject", checkNegated: true,
    // 英文这半句原来带 policy / restriction，于是 "Migration has no quality override: the authored policy"
    // 这种句子也中。中文那半句更麻烦：「**不**通过伪造指纹绕过平台限制」和「绕过平台限制」
    // 是相反的两句话，正则分不出来——所以这条挂了 checkNegated，命中之后回头看整句有没有否定词。
    re: /(?:disable|bypass|turn\s+off|override|circumvent)\b[^\n.]{0,25}(?:safety|guardrail|moderation|content\s+filter|security\s+check)|(?:关闭|绕过|屏蔽|解除)[^\n。]{0,10}(?:安全检查|安全限制|审核|风控|防护|平台限制|权限检查)/i,
    why: "要求关掉或绕过安全检查。正当的技能不会需要 agent 先把护栏拆了。",
  },
  {
    id: "auto-run", level: "warn", cat: "inject",
    re: /(?:always|automatically|on\s+every\s+(?:message|turn|request))\s+(?:run|execute|invoke|call)\b|(?:每(?:次|一次|条)(?:对话|消息|任务)(?:都)?(?:自动)?(?:执行|运行|调用)|自动(?:执行|运行)(?:，|,)?\s*无需)/i,
    why: "要求「每次都自动跑」。技能应该是要用的时候才加载，一个把自己设成常驻自动执行的技能，等于给自己开了张长期通行证。",
  },
  {
    id: "impersonation", level: "warn", cat: "inject",
    re: /(?:这(?:是|个是)|本技能(?:是|为))[^\n。]{0,12}(?:官方|认证|已认证|授权)(?:技能|插件|工具|出品)|\b(?:official|verified|authorized)\s+(?:skill|plugin|extension)\s+(?:by|from)\b|由\s*(?:OpenWorkBuddy|Anthropic|OpenAI)\s*官方/i,
    why: "自称「官方」「已认证」。技能生态里没有认证这回事，所以这句话的全部作用就是让你少审一点。",
  },
  {
    id: "html-comment-instruction", level: "warn", cat: "hidden", textOnly: true,
    // markdown 渲染出来看不见注释，但 agent 读的是原文。
    // 只看 .md / .txt 这种「写给人读的指令文件」：svg 和 html 模板里注释是排版用的，
    // 而图标库的注释里天然带着 token / password / lock 这类词（tabler 那套图标名就是），
    // 不划范围的话这一条会在一个正常技能上中十几次，全是假的。
    detect: (t) => {
      const out = [];
      const re = /<!--([\s\S]*?)-->/g;
      let m;
      while ((m = re.exec(t)) !== null) {
        if (/(?:ignore|execute|exfiltrat|do\s*not\s+tell|password|secret|token|curl|bash|忽略|执行|密钥|不要告诉)/i.test(m[1])) out.push(m.index);
      }
      return out;
    },
    why: "HTML 注释里写着像指令的话。注释在 markdown 渲染后是看不见的，但 agent 读的是原文——这是「人审一遍」这个流程里最好骗的一个位置。",
  },
  {
    id: "touches-our-secrets", level: "warn", cat: "secret",
    // 只认**确实是我们的**那几个名字。原来把裸 config.json 和 api_key 也算进来，
    // 结果任何一个调 API 的脚本都中——api_key 是全世界最常见的变量名之一。
    re: /openworkbuddy-data|\.openworkbuddy\b|\busers\.json\b|\bapi-usage\b|openworkbuddy[^\n]{0,24}config\.json/i,
    why: "点名了本机存密钥和账号的文件。技能要用模型，走的是 agent 给它的工具，不该自己去读 config.json。",
  },
  {
    id: "env-dump", level: "warn", cat: "secret", taintSecret: true,
    // 只认「整份倒出来」那几种写法。原来连 os.environ.copy()（给子进程传环境）和
    // Object.entries(process.env)（测试夹具）都算，那是每个正经脚本都有的东西。
    re: /\bprintenv\b|\benv\s*\|\s*\S|\bset\s*\|\s*(?:curl|nc)\b|(?:cat|source|Get-Content)\s+[^\n]{0,40}(?:^|[\s/\\])\.env\b|\bdict\s*\(\s*os\.environ\s*\)|json\.dumps\s*\(\s*(?:dict\s*\()?\s*os\.environ/i,
    why: "把整个环境变量倒出来。环境变量里常年躺着 API Key，整份倒出来再往别处送，是最省事的一种外带。",
  },
  {
    id: "keychain", level: "warn", cat: "secret", taintSecret: true,
    re: /security\s+find-(?:generic|internet)-password|\bgnome-keyring\b|\bsecret-tool\s+(?:lookup|search)\b|\bcmdkey\s+\/list\b/i,
    why: "去读系统钥匙串 / 凭据管理器。那里面是你所有存过的密码。",
  },
  {
    id: "browser-secrets", level: "warn", cat: "secret", taintSecret: true,
    re: /\bkey4\.db\b|\blogins\.json\b|\bcookies\.sqlite\b|Login\s*Data\b|\bplaces\.sqlite\b/i,
    why: "去读浏览器保存的密码 / Cookie 库。拿到 Cookie 等于拿到你已登录的那些网站。",
  },
  {
    id: "privilege", level: "warn", cat: "exec",
    re: /(?:^|[\s;&|(])sudo\s+(?!-n\s+true\b)|\bchmod\s+(?:-R\s+)?0?777\b|\bosascript\s+-e\b|\bdefaults\s+write\b|\brunas\s+\/user:/im,
    why: "要提权、改系统设置或放开全局权限。可能是正当的（装依赖），但得你自己确认这个技能为什么需要。",
  },
  {
    id: "upload-local-file", level: "warn", cat: "netout",
    re: /(?:curl|wget)\b[^\n]{0,200}(?:--data(?:-binary|-raw)?|-d|-F|--form|--upload-file|-T)\s+["']?@/i,
    why: "把本机的文件整个传出去（curl -T / --data @文件）。传的是哪个文件、传去哪儿，得你看一眼。",
  },
  {
    id: "drop-host", level: "warn", cat: "netout",
    // 裸 IP 那一段要把回环和内网段排掉：http://127.0.0.1:端口 是本地起服务，不是外带。
    re: /webhook\.site|requestbin\.|\.ngrok\.|\bngrok-free\.|pastebin\.com|paste\.ee|transfer\.sh|0x0\.st|file\.io|\bhttps?:\/\/(?!127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)(?:\d{1,3}\.){3}\d{1,3}/i,
    why: "指向了一个常见的「外带落点」——一次性 webhook、贴贴板、内网穿透隧道，或者直接一个 IP 地址。正当的技能会连域名，不会连这些。",
  },
  {
    id: "outbound-post", level: "warn", cat: "netout",
    re: /curl\b[^\n]{0,200}(?:-X\s*POST|--data|-d\s)[^\n]{0,200}https?:\/\/|fetch\s*\([^)]{0,120}method\s*:\s*["']POST|requests\.post\s*\(|axios\.(?:post|put)\s*\(|urllib\.request\.urlopen\s*\(/i,
    why: "会往外部地址 POST 数据。技能正当地调外部 API 很常见，但发什么、发去哪儿，得你看一眼。",
  },
  {
    id: "install-from-url", level: "warn", cat: "supply",
    // 只认「从 URL / git 直接装」这一种。普通的 npm install lodash 不报——
    // 那是每个 README 都有的一句，报了等于让人练习闭眼点确认。
    re: /pip[0-9]?\s+install\b[^\n]{0,80}(?:git\+|https?:\/\/|--index-url|--extra-index-url)|npm\s+(?:i|install)\b[^\n]{0,80}(?:https?:\/\/|git\+|github:)|(?:yarn\s+add|pnpm\s+add)\b[^\n]{0,80}(?:https?:\/\/|git\+)|go\s+install\b[^\n]{0,60}@|curl\b[^\n]{0,120}-o\s+[^\n]{0,40}&&\s*chmod\s+\+x/i,
    why: "在运行时从一个 URL / git 仓库直接装东西。装到的版本不受任何约束，今天审过的和明天跑的可以完全不同。",
  },
  {
    id: "clone-and-run", level: "warn", cat: "supply",
    re: /git\s+clone\b[^\n]{0,160}(?:&&|;)[^\n]{0,80}\b(?:sh|bash|python[0-9.]*|node|make|npm\s+run)\b/i,
    why: "克隆一个仓库下来就直接执行里头的东西。等于把审查责任转包给了那个仓库。",
  },
  {
    id: "big-base64", level: "warn", cat: "hidden",
    // data:font/woff2;base64,… 和 data:image/png;base64,… 是 HTML 模板的常规写法，
    // 一个 archify 模板里就有三处。带资源类型前缀的放过，剩下的才问。
    detect: (t) => {
      const out = [];
      const re = /[A-Za-z0-9+/]{240,}={0,2}/g;
      let m;
      while ((m = re.exec(t)) !== null) {
        if (!/data:(?:image|font|audio|video)\/[\w.+-]+;base64,\s*$/i.test(t.slice(Math.max(0, m.index - 60), m.index))) out.push(m.index);
      }
      return out;
    },
    why: "有一大段 base64。可能是内嵌的图片或模板，也可能是打包好的代码——不解开看一眼，谁也不知道是哪种。",
  },
  {
    id: "data-uri-script", level: "warn", cat: "hidden",
    re: /data:(?:text\/(?:javascript|html)|application\/(?:javascript|x-sh|octet-stream));base64,/i,
    why: "把可执行内容塞在 data: URI 里。这个写法的唯一好处就是不留下一个可以单独去看的文件。",
  },
  {
    id: "dynamic-exec", level: "warn", cat: "exec",
    // 前面那个否定回顾是这条能不能用的关键：JS 里 `正则.exec(字符串)` 和 Python 里 `re.compile(…)`
    // 都是最常见的写法。不排掉的话，这一条在 34 个正常技能上中了 67 次——全是假的。
    re: /(?<![.\w])(?:exec|compile)\s*\(\s*[^)'"\s]|(?<![.\w-])eval\s*\(\s*(?![\s'"`]*\)|["'`][^"'`]{0,40}["'`]\s*\))|(?<![.\w])new\s+Function\s*\(/,
    why: "拿运行时拼出来的字符串当代码执行。读代码的人看不出最后到底跑了什么。",
  },
  {
    id: "persistence", level: "warn", cat: "exec",
    re: /\bcrontab\s+-|launchctl\s+(?:load|bootstrap)|\bLaunchAgents\b|systemctl\s+(?:--user\s+)?enable|\bschtasks\s+\/create|>>?\s*~?\/?\.(?:zshrc|bashrc|bash_profile|profile)\b|CurrentVersion\\\\Run/i,
    why: "会往开机自启、定时任务或 shell 配置里写东西。这类改动在技能被删掉之后还留着——装的时候看着是一次性的，其实不是。",
  },

  // ─── 只看 frontmatter 的两条 ───
  {
    id: "wildcard-tools", level: "warn", cat: "perm", fmOnly: true,
    re: /allowed[-_ ]?tools?\s*[:=]\s*["'[]?\s*(?:\*|Bash\s*\(\s*\*\s*\))/i,
    why: "frontmatter 里把工具权限开成了通配（allowed-tools: * / Bash(*)）。本机的解析器只认 name 和 description，这一行在这儿不生效；但同一份文件拷去 Claude Code / Cowork 就生效了，那边它等于免确认放行所有工具。",
  },
  {
    id: "shell-in-frontmatter", level: "warn", cat: "perm", fmOnly: true,
    re: /!`[^`\n]+`/,
    why: "frontmatter 里有 !`命令` 这种动态取上下文的写法。在支持它的 agent 上，这条命令会在**读技能之前**先跑一遍，而且不问你。",
  },
];

/** 域名清单：不判好坏，只是把这个技能会连哪些地方摆出来 */
const HOST_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;

function isBinaryName(rel) { return BINARY_EXT.has(path.extname(rel).toLowerCase()); }

/** 看不见的字符在报告里也得看得见，不然那几条规则的结论没法复核 */
function visible(s) {
  return s.replace(/[​-‍⁠﻿‪-‮⁦-⁩]/g,
    (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`);
}

/** 行号 + 原文片段。报告里没有这两样，人就没法自己复核，只能盲信扫描器 */
function locate(text, index) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const start = before.lastIndexOf("\n") + 1;
  let end = text.indexOf("\n", index);
  if (end < 0) end = text.length;
  return { line, excerpt: visible(text.slice(start, end).trim()).slice(0, 160) };
}

/**
 * 这一处命中的前面是不是一句否定。
 *
 * 「**不**通过伪造浏览器指纹绕过平台限制」和「绕过平台限制」是**相反**的两句话，
 * 但正则看到的是同一串字。否定词离得可以很远（上面这句隔了 18 个字），
 * 所以不能用回顾断言，只能回头扫这一句。
 * 句子边界按中英文的句号/换行/分号/列表符号算——再往前就跨句了，那时候的「不」跟这儿无关。
 */
function negated(text, index) {
  const start = Math.max(0, index - 120);
  let head = text.slice(start, index);
  const cut = Math.max(
    head.lastIndexOf("\n"), head.lastIndexOf("。"), head.lastIndexOf("；"),
    head.lastIndexOf(";"), head.lastIndexOf("."),
  );
  if (cut >= 0) head = head.slice(cut + 1);
  return /不(?:得|要|准|许|能|会|应|可)?|别|勿|禁止|严禁|避免|杜绝|never|do\s*not|don'?t|must\s+not|avoid|no\s+need/i.test(head);
}

/** frontmatter 占前多少个字符（没有就是 0）。用来判断命中落在不落在 frontmatter 里 */
function frontmatterEnd(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? m[0].length : 0;
}

/**
 * 扫一段文本。
 * opts.isSkillMd：这是 skill.md（才有 frontmatter，才做那两条 fmOnly 规则和升级）
 */
function scanText(rel, text, opts = {}) {
  const fmEnd = opts.isSkillMd ? frontmatterEnd(text) : 0;
  const out = [];
  const isText = /\.(?:md|markdown|txt|mdx|rst)$/i.test(rel) || !path.extname(rel);
  for (const rule of RULES) {
    if (rule.fmOnly && !fmEnd) continue;
    if (rule.textOnly && !isText) continue;
    const idx = [];
    if (rule.detect) {
      for (const i of rule.detect(rule.fmOnly ? text.slice(0, fmEnd) : text)) idx.push(i);
    } else {
      const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
      const hay = rule.fmOnly ? text.slice(0, fmEnd) : text;
      let m;
      while ((m = re.exec(hay)) && idx.length < PER_RULE_HITS) {
        idx.push(m.index);
        if (m.index === re.lastIndex) re.lastIndex++;   // 零宽匹配防死循环
      }
    }
    for (const i of idx) {
      if (rule.checkNegated && negated(rule.fmOnly ? text.slice(0, fmEnd) : text, i)) continue;
      // frontmatter 里的注入是**常驻**的：那句 description 每条任务都会进系统提示词
      // （agent.js 那份技能清单），不管这次用不用得上这个技能。所以升一级。
      const inFm = fmEnd > 0 && i < fmEnd;
      const escalate = inFm && rule.cat === "inject" && rule.level === "warn";
      out.push({
        level: escalate ? "block" : rule.level,
        rule: rule.id, cat: rule.cat, file: rel,
        why: escalate ? rule.why + "（而且它写在 frontmatter 里：那几行每条任务都会进提示词，等于常驻。）" : rule.why,
        ...locate(text, i),
      });
    }
  }
  return out;
}

/**
 * 污点：同一个文件里既读密钥、又往外发。
 * 单看哪一条都够不上拦死——办公技能读 .env 有正当理由，调外部 API 也有。
 * 但**凑齐在一个文件里**，这就是外带的完整形状了。
 * （这个想法是从 skillvet 那儿来的，它用 Python AST 做，这儿只做到文件粒度。）
 *
 * 「读密钥」那一侧只认挂了 taintSecret 的四条（私钥、钥匙串、浏览器密码库、整份环境变量），
 * 不是所有 cat:"secret" 的都算。差别很要命：touches-our-secrets 那条只是「提到了我们的文件名」，
 * 拿它去凑污点的话，任何一个「读自己的 config.json + 调 API」的正常技能都会被拦死——
 * 本地那 34 个正常技能里，光这一条就误拦了 5 个。
 */
const TAINT_SECRET = new Set(RULES.filter((r) => r.taintSecret).map((r) => r.id));

function taint(findings) {
  const byFile = new Map();
  for (const f of findings) {
    const side = TAINT_SECRET.has(f.rule) ? "secret" : f.cat === "netout" ? "netout" : null;
    if (!side) continue;
    const e = byFile.get(f.file) || { secret: null, netout: null };
    if (!e[side]) e[side] = f;
    byFile.set(f.file, e);
  }
  const out = [];
  for (const [file, e] of byFile) {
    if (!e.secret || !e.netout) continue;
    out.push({
      level: "block", rule: "taint-secret-to-net", cat: "secret", file,
      line: Math.min(e.secret.line, e.netout.line), excerpt: "",
      why: `同一个文件里既有「读敏感数据」（第 ${e.secret.line} 行，${e.secret.rule}）又有「往外发」（第 ${e.netout.line} 行，${e.netout.rule}）。单看哪一条都可能是正当的，凑在一起就是外带的完整形状。`,
    });
  }
  return out;
}

/**
 * 扫一个技能目录。
 * 返回 { level, findings, hosts, files, bytes, exec }：
 *   level  "block" | "warn" | "ok"  —— 调用方据此拦死 / 要确认 / 直接装
 */
function scanDir(dir) {
  let findings = [];
  const hosts = new Set();
  const exec = [];
  let files = 0, bytes = 0, truncated = 0;

  const vendored = [];
  const walk = (abs, rel) => {
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === ".git" || e.name === "__pycache__" || /^\.(?:mypy|pytest|ruff)_cache$/.test(e.name)) continue;
      // 第三方依赖树不逐个文件扫——那里头全是别人的代码，扫出来的东西没有一条是这个技能作者写的，
      // 只会把真正该看的几行淹掉（实测：一个技能自带的 .venv 一家就贡献了 60 多条假命中）。
      // 但**带了一棵依赖树**这件事本身要报，而且比里头任何一行都重要。
      if (VENDOR_DIR.test(e.name) && e.isDirectory()) { vendored.push(rel ? `${rel}/${e.name}` : e.name); continue; }
      const f = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(f, r); continue; }
      // 符号链接：copySkillFolder 本来就不拷（Dirent 上 isFile/isDirectory 对软链都是 false），
      // 但得说一声——「我以为装进来了」和「确实没装」差很远
      if (e.isSymbolicLink()) {
        findings.push({ level: "warn", rule: "symlink", cat: "file", file: r, line: 0, excerpt: "",
          why: "是一个符号链接。安装时不会跟着拷进来，指望它存在的技能会在运行时报文件不存在。" });
        continue;
      }
      if (!e.isFile()) continue;
      files++;
      let size = 0;
      try { size = fs.statSync(f).size; } catch {}
      bytes += size;

      const ext = path.extname(r).toLowerCase();
      if (EXEC_EXT.has(ext)) exec.push({ file: r, size });
      if (isBinaryName(r)) continue;

      let text = "";
      try {
        const fd = fs.openSync(f, "r");
        const buf = Buffer.alloc(Math.min(size, MAX_SCAN_BYTES));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        if (size > MAX_SCAN_BYTES) truncated++;
        if (buf.includes(0)) continue;               // 没扩展名的二进制，靠 NUL 认出来
        text = buf.toString("utf8");
      } catch { continue; }

      // 没扩展名但第一行是 shebang 的，也是脚本
      if (!EXEC_EXT.has(ext) && /^#!\s*\/\S/.test(text)) {
        exec.push({ file: r, size, shebang: text.slice(0, text.indexOf("\n")).trim().slice(0, 80) });
      }
      for (const m of text.matchAll(HOST_RE)) hosts.add(m[1].toLowerCase());
      findings = findings.concat(scanText(r, text, { isSkillMd: /(^|\/)skill\.md$/i.test(r) }));
    }
  };
  walk(dir, "");

  for (const v of vendored) {
    findings.push({
      level: "warn", rule: "vendored-tree", cat: "supply", file: v, line: 0, excerpt: "",
      why: "技能自带了一整棵第三方依赖树（node_modules / .venv / site-packages 这一类）。这些文件没有逐个扫——里头是别人的代码，不是这个技能作者写的。要么信上游，要么别装；真要用，让它声明依赖、装的时候现拉。",
    });
  }
  for (const x of exec) {
    findings.push({
      level: "warn", rule: "executable", cat: "file", file: x.file, line: 0,
      excerpt: x.shebang || `${(x.size / 1024).toFixed(1)} KB`,
      why: "是一个可执行文件 / 脚本。技能里带现成的程序，等于把「照着文档做事」变成「跑一个你没读过的二进制」。",
    });
  }
  findings = findings.concat(taint(findings));

  // block 排前面：清单被截断时，先被扔掉的应该是最不要紧的那些
  findings.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
  const level = findings.some((f) => f.level === "block") ? "block" : findings.length ? "warn" : "ok";
  return {
    level,
    findings: findings.slice(0, MAX_FINDINGS),
    truncated_findings: Math.max(0, findings.length - MAX_FINDINGS),
    hosts: [...hosts].sort(),
    files, bytes, truncated_files: truncated,
    exec: exec.map((x) => x.file),
  };
}

/**
 * 扫一份内存里的文本，给出跟 scanDir 一模一样形状的报告。
 *
 * 有两条路进来的技能压根没有目录：GitHub 上那种单个 .md 的链接，和界面上「自己写一个技能」
 * 直接把正文粘进框里。这两条以前是不过闸的——同一段字，放在目录里要过检查，
 * 摘出来单独给就不用，那检查就等于没有。
 */
function scanOne(rel, text) {
  const findings = scanText(rel, text, { isSkillMd: /(^|\/)skill\.md$/i.test(rel) });
  const hosts = new Set();
  for (const m of text.matchAll(HOST_RE)) hosts.add(m[1].toLowerCase());
  const all = findings.concat(taint(findings));
  all.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
  return {
    level: all.some((f) => f.level === "block") ? "block" : all.length ? "warn" : "ok",
    findings: all.slice(0, MAX_FINDINGS),
    truncated_findings: Math.max(0, all.length - MAX_FINDINGS),
    hosts: [...hosts].sort(),
    files: 1, bytes: Buffer.byteLength(text), truncated_files: 0, exec: [],
  };
}

/** 报告 → 人话。CLI、HTTP 错误、日志都用这一份，省得三个地方说法不一样 */
function explain(report, name) {
  const who = name ? `技能「${name}」` : "这个技能";
  const lines = [];
  const blocks = report.findings.filter((f) => f.level === "block");
  const warns = report.findings.filter((f) => f.level === "warn");
  if (blocks.length) lines.push(`${who}没装：里头有 ${blocks.length} 处不该出现在办公技能里的写法。`);
  else if (warns.length) lines.push(`${who}有 ${warns.length} 处要你看一眼（不是说它一定有问题，是这几处只有你能判断）：`);
  else lines.push(`${who}没扫出问题（扫了 ${report.files} 个文件）。这只说明**没命中已知的那些写法**，不等于它是安全的。`);

  const show = blocks.length ? blocks : warns;
  for (const f of show.slice(0, 12)) {
    lines.push(`  · ${f.file}${f.line ? ":" + f.line : ""}  ${f.why}`);
    if (f.excerpt) lines.push(`      ${f.excerpt}`);
  }
  if (show.length > 12) lines.push(`  · …另外 ${show.length - 12} 处`);
  if (report.truncated_findings) lines.push(`  （还有 ${report.truncated_findings} 条没列，同一类问题太多了）`);
  if (report.hosts.length) lines.push(`  会连这些地址：${report.hosts.slice(0, 12).join("、")}${report.hosts.length > 12 ? " …" : ""}`);
  return lines.join("\n");
}

module.exports = {
  scanDir, scanOne, scanText, explain, RULES,
  _internals: { EXEC_EXT, BINARY_EXT, MAX_SCAN_BYTES, PER_RULE_HITS, locate, taint, frontmatterEnd, visible },
};
