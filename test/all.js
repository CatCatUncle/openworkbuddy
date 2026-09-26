"use strict";
/**
 * 把所有测试跑一遍。
 *
 * 为什么要有这个文件：以前 `npm test` 只跑 e2e.js 一个（e2e 自己会再拉起 frontend.js 和
 * admin-ui.js，所以实际是三个）。另外十三个套件都得有人记得手敲 `node test/xxx.js` 才会跑，
 * 发版前基本不会有人挨个敲。结果就是：改了 CLI 参数、改了词典、改了图标尺寸，
 * 回归要到用户那边才被发现。这十三个加起来只要十几秒，没有任何理由不跑。
 *
 * 跑法：npm test          （全部）
 *      npm run test:e2e  （只跑最大那个）
 *      node test/all.js --only icons,prefs
 *      node test/all.js --no-electron   （没屏幕的机器：跳过要开 Electron 窗口的那几个）
 *      npm run lint / npm run typecheck （单跑那两道静态闸门）
 *
 * 约定：每个套件自己负责断言和打印，失败时退出码非 0。这里只管调度、计时、汇总。
 * 有任何一个挂了，整体退出码就是 1 ——发版脚本看的是这个。
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");

// 测试的 Trace 账本必须另起一份。不隔离的话，套件里那些 `t.trace({ name: "任务 0" })`
// 会一路写进用户真正的 workspace/.openworkbuddy/traces.jsonl——跑一次测试灌几千条，
// 真任务被淹在里面翻不出来（实测淹到 14650 条假记录对 533 条真记录）。
// 放在这儿而不是各个套件里：子进程再拉起的 server / electron 也一并继承。
const ownTmp = []; // 这一轮自己建的临时目录：全过了收走，挂了留着现场
if (!process.env.OPENWORKBUDDY_TRACE_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-test-trace-"));
  ownTmp.push(dir);
  process.env.OPENWORKBUDDY_TRACE_FILE = path.join(dir, "traces.jsonl");
}

// 外挂的第二把尺子（toolward）默认按掉：它是可选组件，开发机上装没装全看个人，
// 不按掉的话同一份技能在两台机器上会扫出两种结论——测试就成了一件看运气的事。
// test/toolward.js 自己会把这个变量删掉，它测的正是这块。
if (!process.env.OPENWORKBUDDY_TOOLWARD) process.env.OPENWORKBUDDY_TOOLWARD = "off";

// 测试不许碰用户真实的数据。开发态 paths.js 的 DATA_DIR 就是仓库根：哪个套件没自己设
// OPENWORKBUDDY_HOME，一 require security.js / memory.js / quota.js，审计、记忆命中数、用量账本
// 就落进用户正在用的 data/（实测 hooks 写真 audit.json、decide-tool 写真 api-usage、relay 写真 logs/）。
// 两层：① 整轮给一个临时家，套件没设就用它，自己设了的照旧；
//      ② 每个子进程（连同它再拉起的 server.js / cli.js）经 NODE_OPTIONS 挂上 test/lib/real-data-guard.js：
//         往真目录写就当场拦下并记账，套件跑完这里读账判红——审计落盘包在 try/catch 里，光抛异常套件照样绿。
// OPENWORKBUDDY_ALLOW_REAL_DATA=1：只关第②层（护栏）。临时家照给——这个开关是护栏误拦时的逃生口，
// 不是「把没隔离的套件放进真目录」。真要用真目录，连 OPENWORKBUDDY_HOME=<仓库根> 一起设。
const ALLOW_REAL_DATA = process.env.OPENWORKBUDDY_ALLOW_REAL_DATA === "1";
let GUARD_DIR = "";
let RUN_HOME = ""; // 这一轮自己建的临时家（外面给了就是空）
if (!process.env.OPENWORKBUDDY_HOME) {
  RUN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-test-home-"));
  ownTmp.push(RUN_HOME);
  process.env.OPENWORKBUDDY_HOME = RUN_HOME;
  // 跟 server.js 开机时一样铺一遍出厂内容（技能、experts.json）：在进程里直接 require skills.js 的套件读的就是这个家。
  // macOS 上走 clonefile，189M 的 skills/ 实占几 MB
  const seed = spawnSync(process.execPath, ["-e", "require(process.argv[1]).seedDataDir()", path.join(__dirname, "..", "paths.js")],
    { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  if (seed.status !== 0) {
    console.error("临时数据目录铺不起来（paths.seedDataDir 退出码 " + seed.status + "）：" + RUN_HOME);
    process.exit(1);
  }
}
if (!ALLOW_REAL_DATA) {
  GUARD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "owb-test-guard-"));
  ownTmp.push(GUARD_DIR);
  // 加引号：路径里有空格时 NODE_OPTIONS 要靠双引号认（JSON 转义跟 node 的解析规则对得上，反斜杠也不丢）
  process.env.NODE_OPTIONS = ((process.env.NODE_OPTIONS || "") + " --require=" + JSON.stringify(path.join(__dirname, "lib", "real-data-guard.js"))).trim();
  process.env.OPENWORKBUDDY_TEST_GUARD = "guard";
}
const realDataGuard = require("./lib/real-data-guard");

// 第三格写了 ELECTRON 的，是真会拉起 Electron 开窗口的套件：没屏幕的机器（Linux 服务器、
// 无头容器）上跑必挂，用 `node test/all.js --no-electron` 跳过它们。
// CI 的 ubuntu 那条腿不靠这个标记，而是 test.yml 里写明的 --only 名单——那张名单是不是
// 「除了开窗口的全在」，由 test/e2e.js 的 releasePipelineDrift 按套件源码现判，不信这里的手写标记。
// 每一项都得以 `["名字"` 开头：那道检查和 repo-hygiene 都是按这个样子从本文件里认套件的。
const ELECTRON = { electron: true };

// e2e 放最后：它最慢（会拉起真 server 和两个 Electron 窗口），
// 前面十三个几秒钟就能把大部分低级错误拦下来，别让人等五分钟才看到一个拼写错误。
// lint / typecheck 紧跟仓库卫生：各五秒上下，拼错的名字、写两遍的键在这儿就拦下了。
const SUITES = [
  ["repo-hygiene", "仓库卫生：测试喂的真文件必须随包发出去（本机私货会让新克隆直接挂）"],
  ["lint", "ESLint 十二条零误报规则：只对新增违规报红（已知的记在 test/lint-baseline.json）"],
  ["typecheck", "tsc 类型闸门：全仓只拦找不到名字 / 键写两遍，认领了 @ts-check 的文件全拦"],
  ["data-guard", "测试护栏：哪个套件往用户真实的数据目录写，当场拦下并判红"],
  ["icons", "图标系统：sprite 完整性、词典同步、圆角阶梯、滚动条留位"],
  ["lanes", "任务泳道调度"],
  ["md-tty", "终端里的 Markdown 渲染"],
  ["doctor", "openworkbuddy doctor 体检"],
  ["cli-args", "CLI 参数表"],
  ["cli-attach", "CLI 带文件和图片"],
  ["cli-live", "终端 ↔ 网页那座桥"],
  ["cli-ask", "终端里回答 agent 的提问"],
  ["cli-approve", "危险操作征求同意：终端卡片 + 手机上点"],
  ["cli-toolview", "终端里的工具调用：● 命令(对象) + └ 输出，跟 Claude Code / Codex 一个读法"],
  ["im-card", "飞书任务卡片：卡头说清在干什么、过程只留几行、过场白不算回答、回复「停」叫停、颜色全在飞书名单里"],
  ["im-feishu-media", "飞书发视频：mp4 走 media 带封面能直接播，超 30MB 先压 720p 预览并说原片在哪，发送超时不重发，没 ffmpeg 按文件发"],
  ["cli-pty", "真终端里敲键盘：单子出来前的键、粘贴、手机抢答、没回车的半句"],
  ["cli-oneshot", "一次性跑和脚本调用：stdin 开着不关、--session 打错、--json 列会话/引擎、--help 不加载大件、被 kill 时落盘、多端并写不丢"],
  ["engine-resilience", "本机引擎出岔子：result 里的报错、按停止当场杀、临时目录退出即删、续跑 id 失效重开一根"],
  ["repl-commands", "REPL 命令表"],
  ["session-search", "任务历史检索：正文 / 产出文件名 / 意思相近"],
  ["systemone", "判断模型 Jev：题目怎么拼、回答怎么读、确定度不够就不许照做"],
  ["decide-tool", "agent 手里的 decide：一批判断一趟问完、拿不准的挑出来、额度按题数算"],
  ["task-doubt", "定时任务跑绿之后再看一眼：只给判据主动让路的那一段挂疑问，不改判"],
  ["continue-gate", "自动续跑之前那道闸：撞上限不等于没干完，先问一句再决定要不要再烧一轮"],
  ["cmd-risk", "名单外先判一句：四张名单都没命中、本来一声不吭直接跑的那条，先问撤不撤得回来"],
  ["cmd-gate", "命令闸认命令：包装词连参数剥、引号去掉、bash -c / find -exec 里套着的那条也单独过闸"],
  ["memory-gate", "记之前先判一句：agent 自己想写进长期记忆的那句话，先问下个月还用不用得上"],
  ["push-gate", "定时任务没变化就不推：跟上一次真推出去的那条比，没新东西就不响这一声（留痕不留白）"],
  ["ask-gate", "打断你之前先判一句：第二问起，弹给用户之前先问一道题是不是非问不可（头一问白放行，说不准照旧弹）"],
  ["perm-gate", "权限档位与审批卡：档位说问就问、原文给全、一直允许不骗人、save_skill 过闸"],
  ["desktop-ux", "桌面端体验：结论在折叠区外流出、计划两颗真按钮同源于终端单子、等你的会话看得见（侧栏点、标题计数/Dock 角标、审批倒计时）"],
  ["skill-gate", "开工之前先挑技能：点了名的直接加载，没点名的问一道单选；加载过的挂系统提示词，压缩、下一趟都不丢"],
  ["ui-copy-length", "界面文案长度闸门：一段说明不超过 70 个汉字，理由进注释不进界面"],
  ["memory-rules", "记忆超预算时规矩先进门：零相关的规矩留下、零相关的事实挤掉、命中只记给进了门的"],
  ["prefs", "偏好与配置落盘"],
  ["chat-models", "模型渠道与选型"],
  ["media-models", "生图 / 生视频 / 配音 / 转写 多模型"],
  ["media-health", "连不通的渠道熔断：撞过的硬错下次连请求都不发"],
  ["gen-cache", "生成结果缓存：同一格重跑别再烧第二次钱"],
  ["tts-segments", "按句配音：逐句合成、实测时长、整轨 + 句级字幕、改一句只重配一句（不联网，不花钱）"],
  ["sweep", "清中间物：任务跑完剩下的脚手架，哪些敢删、哪些绝不能碰"],
  ["quota", "付费 API 额度闸门：搜索 / 生图 / 生视频 / 配音 / 转写 按次限额"],
  ["relay", "API 中转站：虚拟 Key / 按型号计价 / 三档月预算 / 后台那一页"],
  ["totp", "二次验证：TOTP 算术（对 RFC 标准向量）"],
  ["auth-2fa", "账号安全：密码策略 / 二次验证接线 / 强制开关"],
  ["skill-guard", "技能装之前的体检：拦住、放行、留档，以及别把正经技能拦死"],
  ["toolward", "外挂的第二把尺子：装了多一层检查，没装 / 崩了一切照旧，密钥不出门"],
  ["rbac", "权限模型：管理员之间谁也动不了谁 / 超管只能转让 / 老账本搬家"],
  ["tenant", "多租户与权限"],
  ["lifecycle", "入职 / 离职：权限一次关完 + 排期归属"],
  ["ops", "运行状况：日志 / 指标与告警 / 分片用量账本"],
  ["remote", "远程访问：配对授权 + 静态资源压缩"],
  ["deploy", "Docker 部署物静态检查"],
  ["trace", "执行追踪（Langfuse）上报"],
  ["term-image", "终端里把产出的图画出来 + /open"],
  ["office-tools", "办公工具：读 Office 文档 / 资料库取素材 / 推群 / 排期 / 发邮件 / 按环境摘挂工具"],
  ["web-demo", "网页演示录屏：步骤脚本 / 假光标 / 自动放大 / 打码闸门 / 工具接线（没有 Chrome、ffmpeg 就跳过真录那段）"],
  ["cdp", "真浏览器那条线：端口通不通、握手带不带 Origin、evaluate 拿不拿得到值"],
  ["motion", "HTML 动画出片：虚拟时钟、帧时间表、画幅、ffmpeg 参数、工具接线、批量截图（不开窗口）"],
  ["checkpoints", "文件检查点：改前留底 / 整步回退 / 改前 diff"],
  ["shot-history", "分镜留底：改台词重跑之后，上一版首帧还拿得回来"],
  ["explore", "explore 只读探索子智能体：同一轮并发、真只读、不套娃，只读档清单外的工具一律不执行"],
  ["agent-loop", "死循环硬停：五种卡法都停得下来，没卡住的一个字不说"],
  ["code-tools", "写代码那几样：按名找文件 / 一个文件改多处 / 读后被改就拦 / 后台命令 / 进度清单"],
  ["workflow", "流程文件：写错一次列全 / {{名字}} 贴前一步结论 / 一步没成后面就停"],
  ["recipes", "内容配方：开头一张表单定岔路、按配方放宽上限、交付页各画幅能播能复制"],
  ["workflow-panel", "workflow 面板：每行不超宽（重画不错位）/ 头尾不重复 / 分栏或平铺 / 安静满 20s 才说 / 没跑的不算做完"],
  ["hooks", "钩子：before_shell 拦命令 / after_edit 接回执 / done 没过不许收尾"],
  ["slash-review", "自定义斜杠命令 / /review 取对改动 / --model --max-steps --append-system"],
  ["brand-kit", "品牌档案：摘要 ≤300 字、提到才注入、没出处的数字过不了、存档必须人点头（不联网，不花钱）"],
  ["stop", "「让我停下」：正在跑的命令要真停得下来，连孙子进程一起收"],
  ["preview-layout", "右边成果预览：每种格式在面板里摆得对不对（量面板/内容/位置，不看截图）", ELECTRON],
  ["library-mkdir", "资料库「新建文件夹」：按钮点下去要真有反应（Electron 里 prompt 一调用就抛）", ELECTRON],
  ["confirm-dialogs", "全站确认框：撤不回来的那一步，字得翻得了、取消得真管用、清单长了框不能顶出屏幕", ELECTRON],
  ["canvas", "无限画布：反复加载和同步之后，节点、连线、选中的那一片都得还在", ELECTRON],
  ["worktree", "两条任务撞一个仓库：后来那条进分身改，你的工作区一个字不动"],
  ["memory", "运行时内存：会话缓存有上限，清掉的必须原样读得回来（四道闸门一道不漏）"],
  ["eval", "评测题库：每道题的判分在空目录上一条都不许绿（不调模型，不花钱）"],
  ["search-providers", "联网搜索八家：请求发得对不对、200 里写着错认不认得出来（不联网，不花钱）"],
  ["model-probe", "一行一测：生图/生视频/对话每一行后面那颗「测」（不联网，也不真生成）"],
  ["media-probe", "音频量时长：按 PCM 采样数算、句间留白按采样拼、WAV 头解析（没 ffmpeg 就跳过真跑那段）"],
  ["library-ws", "资料库工作区：逐层浏览、全量计数、越界与链接"],
  ["motion-render", "HTML 动画出片真渲：同一页渲两次逐帧一致、像素对得上时间轴、不是 2 倍图、颜色通道没反", ELECTRON],
  ["timeline-compose", "时间轴成片：多尺寸 / 字幕 / 配乐避让 / 封面 / 叫停不留半截（没有 ffmpeg 就跳过真跑那段）"],
  ["delivery-page", "交付页：各画幅能播、标题文案能复制、缺文件直说不出页"],
  ["e2e", "端到端（含 frontend.js、admin-ui.js）", ELECTRON],
];

// 这几个套件自己起临时家（单独 `node test/xxx.js` 也不碰真目录）。挂着护栏时 all.js 故意不给它们
// 临时家和 trace 账本，照单独跑的样子跑：哪天谁删了那一行，护栏当场拦下判红。
// 给了的话整轮的临时家会替它兜住，漏洞只在单独跑时现身——写真账本的错还被吞掉，谁也看不见。
// 名单是实测来的：不设 OPENWORKBUDDY_HOME / TRACE_FILE 单独跑、护栏拦到过的就是这八个。
const SELF_ISOLATED = new Set(["hooks", "decide-tool", "relay", "cli-approve", "agent-loop", "continue-gate", "ask-gate", "engine-resilience"]);
const ISOLATION_ENV = ["OPENWORKBUDDY_HOME", "OPENWORKBUDDY_DATA_DIR", "OPENWORKBUDDY_TRACE_FILE"];
{
  const typo = [...SELF_ISOLATED].filter((n) => !SUITES.some(([s]) => s === n));
  if (typo.length) {
    console.error("SELF_ISOLATED 里有 SUITES 没有的名字（写错了就等于没查）：" + typo.join(", "));
    for (const d of ownTmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    process.exit(2);
  }
}

const argOnly = process.argv.indexOf("--only");
const only = argOnly > 0 ? String(process.argv[argOnly + 1] || "").split(",").map((s) => s.trim()).filter(Boolean) : null;
const noElectron = process.argv.includes("--no-electron");
const list = (only ? SUITES.filter(([n]) => only.includes(n)) : SUITES)
  .filter(([, , flag]) => !(noElectron && flag && flag.electron));
if (noElectron) {
  console.log("--no-electron：跳过要开 Electron 窗口的 " + SUITES.filter(([, , f]) => f && f.electron).map(([n]) => n).join(", ") + "\n");
}
if (only) {
  const unknown = only.filter((n) => !SUITES.some(([s]) => s === n));
  if (unknown.length) {
    console.error("没有这几个套件：" + unknown.join(", ") + "\n有的是：" + SUITES.map(([s]) => s).join(", "));
    for (const d of ownTmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    process.exit(2);
  }
}

// 最外面那层保险丝。本机全套 137 秒，最慢的 e2e 120 秒，其余每个都在 10 秒以内，
// 所以 30 分钟这个数只在「底下几层看门狗全失灵」时才会烧到——
// 2026-09-13 的 CI 正是这种情况：没有任何一层有超时，五个 job 各挂了一个多小时，
// 既不给结论也不放人走。宁可红，不许一直挂着。
const SUITE_TIMEOUT_MS = Number(process.env.OPENWORKBUDDY_SUITE_TIMEOUT_MS || 1800000);

console.log("跑 " + list.length + " 个测试套件\n");
const results = [];
for (const [name, what] of list) {
  const t0 = Date.now();
  // stdio inherit：套件自己的输出直接透到终端，挂了能当场看见是哪一条。
  // stdin 给 ignore：cli 那几个套件会起子进程，不关 stdin 的话跑完不退出。
  const guardLog = GUARD_DIR ? path.join(GUARD_DIR, name + ".jsonl") : "";
  const env = GUARD_DIR ? { ...process.env, OPENWORKBUDDY_TEST_GUARD_LOG: guardLog, OPENWORKBUDDY_TEST_GUARD_SUITE: name } : process.env;
  const selfIsolated = GUARD_DIR && SELF_ISOLATED.has(name);
  if (selfIsolated) for (const k of ISOLATION_ENV) delete env[k];
  const r = spawnSync(process.execPath, [path.join(__dirname, name + ".js")],
    { stdio: ["ignore", "inherit", "inherit"], env,
      timeout: SUITE_TIMEOUT_MS, killSignal: "SIGKILL" });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  if (timedOut) {
    console.error(`\n× ${name} 跑了 ${secs}s 还没完，按 ${Math.round(SUITE_TIMEOUT_MS / 60000)} 分钟的上限强杀了。`
      + "\n  往上翻这个套件最后打出来的那一行，就是卡住的地方。");
  }
  // 护栏的账：有一笔就算红，不管套件自己退出码是几
  const leaked = guardLog ? realDataGuard.readBlocked(guardLog) : [];
  if (leaked.length) {
    console.error(`\n× [测试护栏] ${name} 往真实数据目录写了 ${leaked.length} 处，都拦下了：`);
    for (const x of leaked.slice(0, 8)) console.error(`    ${x.path}（${x.op}）\n      ← ${(x.stack || []).slice(0, 2).join(" ← ")}`);
    if (leaked.length > 8) console.error(`    ……另有 ${leaked.length - 8} 处，全在 ${guardLog}`);
    console.error(selfIsolated
      ? "  它在 SELF_ISOLATED 里，照单独跑的样子跑（没给临时家）：得在 require 生产模块之前自己起一个，见 test/lib/own-home.js"
      : "  require 之前把 OPENWORKBUDDY_HOME 指到临时目录；确实要写真数据，设 OPENWORKBUDDY_ALLOW_REAL_DATA=1 再跑");
  }
  const code = timedOut ? 1 : r.status == null ? 1 : r.status || (leaked.length ? 1 : 0);
  results.push({ name, what, code, secs, timedOut, leaked: leaked.length });
  console.log("\n" + (code === 0 ? "√" : "×") + " " + name + "  " + secs + "s"
    + (timedOut ? "（超时强杀）" : "") + (leaked.length ? "（写了真实数据目录）" : "") + "\n" + "─".repeat(60));
}

const bad = results.filter((r) => r.code !== 0);
const total = results.reduce((a, r) => a + Number(r.secs), 0).toFixed(1);
console.log("\n================ 汇总 ================");
for (const r of results) console.log("  " + (r.code === 0 ? "√" : "×") + " " + r.name.padEnd(15) + r.secs.padStart(6) + "s   " + r.what);
console.log("\n" + (bad.length === 0 ? "全部通过" : "挂了 " + bad.length + " 个：" + bad.map((b) => b.name).join(", "))
  + "　共 " + results.length + " 个套件，" + total + "s");
if (ALLOW_REAL_DATA) console.log("OPENWORKBUDDY_ALLOW_REAL_DATA=1：这一轮没挂护栏，写真实数据目录不会被拦");
if (bad.length === 0) for (const d of ownTmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
else {
  // 挂了留现场，但只留有东西的：本机常年有别的会话的红，每轮都留一整套会越堆越多。
  // 护栏的账、trace 目录里什么也没写就删；临时家里铺的出厂技能是从仓库拷的，删掉不丢现场
  // （Linux 上没有 clonefile，那是实打实 189M 一份）
  const kept = [];
  for (const d of ownTmp) {
    if (d === RUN_HOME) { try { fs.rmSync(path.join(d, "skills"), { recursive: true, force: true }); } catch {} kept.push(d); continue; }
    if (hasContent(d)) kept.push(d);
    else { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
  if (kept.length) console.log("留着现场：" + kept.join("  "));
}
process.exit(bad.length === 0 ? 0 : 1);

/** @param {string} dir @returns {boolean} 底下有没有一个非空文件（空目录、空文件都不算现场） */
function hasContent(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  return ents.some((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return hasContent(p);
    try { return fs.statSync(p).size > 0; } catch { return false; }
  });
}
