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
if (!process.env.OPENWORKBUDDY_TRACE_FILE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-test-trace-"));
  process.env.OPENWORKBUDDY_TRACE_FILE = path.join(dir, "traces.jsonl");
}

// 外挂的第二把尺子（toolward）默认按掉：它是可选组件，开发机上装没装全看个人，
// 不按掉的话同一份技能在两台机器上会扫出两种结论——测试就成了一件看运气的事。
// test/toolward.js 自己会把这个变量删掉，它测的正是这块。
if (!process.env.OPENWORKBUDDY_TOOLWARD) process.env.OPENWORKBUDDY_TOOLWARD = "off";

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
  ["cli-pty", "真终端里敲键盘：单子出来前的键、粘贴、手机抢答、没回车的半句"],
  ["repl-commands", "REPL 命令表"],
  ["session-search", "任务历史检索：正文 / 产出文件名 / 意思相近"],
  ["systemone", "判断模型 Jev：题目怎么拼、回答怎么读、确定度不够就不许照做"],
  ["decide-tool", "agent 手里的 decide：一批判断一趟问完、拿不准的挑出来、额度按题数算"],
  ["task-doubt", "定时任务跑绿之后再看一眼：只给判据主动让路的那一段挂疑问，不改判"],
  ["continue-gate", "自动续跑之前那道闸：撞上限不等于没干完，先问一句再决定要不要再烧一轮"],
  ["cmd-risk", "名单外先判一句：四张名单都没命中、本来一声不吭直接跑的那条，先问撤不撤得回来"],
  ["memory-gate", "记之前先判一句：agent 自己想写进长期记忆的那句话，先问下个月还用不用得上"],
  ["push-gate", "定时任务没变化就不推：跟上一次真推出去的那条比，没新东西就不响这一声（留痕不留白）"],
  ["ask-gate", "打断你之前先判一句：第二问起，弹给用户之前先问一道题是不是非问不可（头一问白放行，说不准照旧弹）"],
  ["skill-gate", "开工之前先挑技能：点了名的直接加载，没点名的问一道单选；加载过的挂系统提示词，压缩、下一趟都不丢"],
  ["ui-copy-length", "界面文案长度闸门：一段说明不超过 70 个汉字，理由进注释不进界面"],
  ["memory-rules", "记忆超预算时规矩先进门：零相关的规矩留下、零相关的事实挤掉、命中只记给进了门的"],
  ["prefs", "偏好与配置落盘"],
  ["chat-models", "模型渠道与选型"],
  ["media-models", "生图 / 生视频 / 配音 / 转写 多模型"],
  ["media-health", "连不通的渠道熔断：撞过的硬错下次连请求都不发"],
  ["gen-cache", "生成结果缓存：同一格重跑别再烧第二次钱"],
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
  ["cdp", "真浏览器那条线：端口通不通、握手带不带 Origin、evaluate 拿不拿得到值"],
  ["checkpoints", "文件检查点：改前留底 / 整步回退 / 改前 diff"],
  ["shot-history", "分镜留底：改台词重跑之后，上一版首帧还拿得回来"],
  ["agent-loop", "死循环硬停：五种卡法都停得下来，没卡住的一个字不说"],
  ["code-tools", "写代码那几样：按名找文件 / 一个文件改多处 / 读后被改就拦 / 后台命令 / 进度清单"],
  ["workflow", "流程文件：写错一次列全 / {{名字}} 贴前一步结论 / 一步没成后面就停"],
  ["hooks", "钩子：before_shell 拦命令 / after_edit 接回执 / done 没过不许收尾"],
  ["slash-review", "自定义斜杠命令 / /review 取对改动 / --model --max-steps --append-system"],
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
  ["e2e", "端到端（含 frontend.js、admin-ui.js）", ELECTRON],
];

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
  const r = spawnSync(process.execPath, [path.join(__dirname, name + ".js")],
    { stdio: ["ignore", "inherit", "inherit"], env: process.env,
      timeout: SUITE_TIMEOUT_MS, killSignal: "SIGKILL" });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  if (timedOut) {
    console.error(`\n× ${name} 跑了 ${secs}s 还没完，按 ${Math.round(SUITE_TIMEOUT_MS / 60000)} 分钟的上限强杀了。`
      + "\n  往上翻这个套件最后打出来的那一行，就是卡住的地方。");
  }
  const code = timedOut ? 1 : r.status == null ? 1 : r.status;
  results.push({ name, what, code, secs, timedOut });
  console.log("\n" + (code === 0 ? "√" : "×") + " " + name + "  " + secs + "s"
    + (timedOut ? "（超时强杀）" : "") + "\n" + "─".repeat(60));
}

const bad = results.filter((r) => r.code !== 0);
const total = results.reduce((a, r) => a + Number(r.secs), 0).toFixed(1);
console.log("\n================ 汇总 ================");
for (const r of results) console.log("  " + (r.code === 0 ? "√" : "×") + " " + r.name.padEnd(15) + r.secs.padStart(6) + "s   " + r.what);
console.log("\n" + (bad.length === 0 ? "全部通过" : "挂了 " + bad.length + " 个：" + bad.map((b) => b.name).join(", "))
  + "　共 " + results.length + " 个套件，" + total + "s");
process.exit(bad.length === 0 ? 0 : 1);
