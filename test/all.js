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

// e2e 放最后：它最慢（会拉起真 server 和两个 Electron 窗口），
// 前面十三个几秒钟就能把大部分低级错误拦下来，别让人等五分钟才看到一个拼写错误。
const SUITES = [
  ["repo-hygiene", "仓库卫生：测试喂的真文件必须随包发出去（本机私货会让新克隆直接挂）"],
  ["icons", "图标系统：sprite 完整性、词典同步、圆角阶梯、滚动条留位"],
  ["lanes", "任务泳道调度"],
  ["md-tty", "终端里的 Markdown 渲染"],
  ["doctor", "wb doctor 体检"],
  ["cli-args", "CLI 参数表"],
  ["cli-attach", "CLI 带文件和图片"],
  ["cli-live", "终端 ↔ 网页那座桥"],
  ["cli-ask", "终端里回答 agent 的提问"],
  ["repl-commands", "REPL 命令表"],
  ["prefs", "偏好与配置落盘"],
  ["chat-models", "模型渠道与选型"],
  ["media-models", "生图 / 生视频 / 配音 / 转写 多模型"],
  ["gen-cache", "生成结果缓存：同一格重跑别再烧第二次钱"],
  ["quota", "付费 API 额度闸门：搜索 / 生图 / 生视频 / 配音 / 转写 按次限额"],
  ["tenant", "多租户与权限"],
  ["deploy", "Docker 部署物静态检查"],
  ["trace", "执行追踪（Langfuse）上报"],
  ["term-image", "终端里把产出的图画出来 + /open"],
  ["office-tools", "办公工具：读 Office 文档 / 资料库取素材 / 推群 / 排期 / 发邮件 / 按环境摘挂工具"],
  ["e2e", "端到端（含 frontend.js、admin-ui.js）"],
];

const argOnly = process.argv.indexOf("--only");
const only = argOnly > 0 ? String(process.argv[argOnly + 1] || "").split(",").map((s) => s.trim()).filter(Boolean) : null;
const list = only ? SUITES.filter(([n]) => only.includes(n)) : SUITES;
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
const SUITE_TIMEOUT_MS = Number(process.env.WB_SUITE_TIMEOUT_MS || 1800000);

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
