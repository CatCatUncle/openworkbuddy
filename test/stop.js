"use strict";
/**
 * 「让我停下」要真的停得下来。
 *
 * 跑法：node test/stop.js
 * 用临时数据目录，只起 sleep 这种无害进程，不碰真工作区。
 *
 * 用户报的原话是「怎么我让停下来一直停不下来啊」。查下去是两个洞叠在一起：
 *
 *   1. 停止信号根本没接到工具上。`stopSignal` 一路传到 tools.js，但 run_shell / run_node
 *      只在**开跑之前**看一眼，跑起来之后再拉信号，那条 30 秒的命令照样跑满 30 秒。
 *      界面上按钮按下去了、模型那边也确实断了流，但这一步不结束，任务就不算停——
 *      人看到的就是「点了没反应」。
 *   2. 就算杀，也只杀得到那层 shell。模型跑的多半是 `npm install`、`npm run build`
 *      这种自己还要再 spawn 一层的命令；孙子进程不在杀伤范围里，风扇照转、端口照占。
 *      更糟的是后台进程继承了 stdout 管道，管道不关 close 事件就不触发——
 *      一条 `xxx &` 能让整个工具调用**无限期**挂着（这个套件量到过 150 秒还没返回）。
 *
 * 所以这里盯的不是「函数返回了对象」，是三件用户能感觉到的事：
 *   停得快（秒级，不是分钟级）、停得干净（孙子进程一个不留）、话说得对（是「已停止」不是「超时」）。
 * 每条后面跟一条反向对照：不拉停止信号时命令必须正常跑完、正常拿到 exit code，
 * 不然把 runShell 改成「一律立刻返回」也能骗过上面三条。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-stop-"));
process.env.OPENWORKBUDDY_HOME = TMP;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const { executeTool } = require(path.join(ROOT, "tools"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};

// 一个不会跟机器上任何别的东西撞的时长，当进程标记用
const MARK = "44451";
const marked = () => {
  try {
    return execFileSync("/usr/bin/pgrep", ["-f", "sleep " + MARK], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).length;
  } catch { return 0; }              // 一个都没找到时 pgrep 的退出码是 1
};
const sweep = () => { try { execFileSync("/usr/bin/pkill", ["-f", "sleep " + MARK]); } catch {} };

/** 跑一个工具，abortAfter 毫秒后拉停止信号（传 null 表示压根不拉），回报耗时和结果 */
async function run(name, input, abortAfter) {
  const ctrl = new AbortController();
  if (abortAfter !== null) setTimeout(() => ctrl.abort(), abortAfter);
  const t0 = Date.now();
  const r = await executeTool(name, input, { stopSignal: ctrl.signal, taskLabel: "停止测试" });
  return { ms: Date.now() - t0, text: String((r && r.content) || ""), isError: !!(r && r.isError) };
}

(async () => {
  if (process.platform === "win32") {
    console.log("Windows 上 pgrep/pkill 不存在，这个套件只在 macOS / Linux 跑");
    process.exit(0);
  }

  console.log("\n— 停得快：正在跑的命令要被打断，不是等它自己跑完 —");
  {
    // 不拉信号的话这条要跑满 30 秒；1.5 秒是「明显没跑完」的分界，
    // 不写 1 秒是给 SIGTERM→SIGKILL 的两秒宽限留出余量，也躲开慢机器的抖动
    const r = await run("run_shell", { command: "sleep 30" }, 400);
    ok(r.ms < 1500, "run_shell：拉停止后 1.5 秒内就返回，没等满 30 秒", r.ms + "ms");
    ok(/用户已停止任务/.test(r.text), "话说的是「用户已停止任务」", r.text.slice(0, 80));
    ok(!/执行超时/.test(r.text), "反向对照：不能报成「执行超时」——按停的是人，不是钟", r.text.slice(0, 80));
    ok(r.isError, "被停下的命令算失败，不能当成功交上去", r.isError);
  }
  {
    const r = await run("run_node", { code: "setTimeout(() => {}, 30000)" }, 400);
    ok(r.ms < 1500, "run_node：拉停止后 1.5 秒内就返回", r.ms + "ms");
    ok(/用户已停止任务/.test(r.text), "run_node 也说「用户已停止任务」", r.text.slice(0, 80));
  }

  console.log("\n— 停得干净：孙子进程一个不留 —");
  {
    sweep();
    ok(marked() === 0, "开跑前确认没有残留的标记进程", marked());
    // `xxx & yyy` 是模型写命令的常见形态（起个服务再测它）。旧代码在这儿是双重故障：
    // 杀不到后台那个，而且它攥着 stdout 管道不放，close 永远不触发。
    const r = await run("run_shell", { command: `sleep ${MARK} & sleep 30` }, 800);
    ok(r.ms < 3000, "带后台进程的命令也停得下来，没被管道吊死", r.ms + "ms");
    await new Promise((x) => setTimeout(x, 800));   // 给 SIGTERM→SIGKILL 落地的时间
    const left = marked();
    ok(left === 0, "后台那个孙子进程也被收走了", left);
    sweep();
  }

  console.log("\n— 反向对照：不拉停止信号时，一切照旧 —");
  {
    const r = await run("run_shell", { command: "echo 我还活着" }, null);
    ok(/我还活着/.test(r.text), "没拉停止信号，命令正常跑完并拿到输出", r.text.slice(0, 60));
    ok(/exit code: 0/.test(r.text), "正常结束拿得到 exit code 0", r.text.slice(0, 60));
    ok(!/用户已停止任务/.test(r.text), "没人按停就不许出现「已停止」字样", r.text.slice(0, 60));
    ok(!r.isError, "正常跑完不算失败", r.isError);
  }
  {
    const r = await run("run_node", { code: "console.log('节点还活着')" }, null);
    ok(/节点还活着/.test(r.text), "run_node 不拉信号也正常跑完", r.text.slice(0, 60));
    ok(!r.isError, "run_node 正常跑完不算失败", r.isError);
  }
  {
    // 信号在开跑前就已经是 aborted：这条走的是另一个分支（bindStop 里的即刻触发），
    // 也得停，而且不能因为「监听器还没装上」就漏掉
    const ctrl = new AbortController();
    ctrl.abort();
    const t0 = Date.now();
    const r = await executeTool("run_shell", { command: "sleep 30" }, { stopSignal: ctrl.signal, taskLabel: "停止测试" });
    const ms = Date.now() - t0;
    ok(ms < 1500, "信号在开跑前就已拉起：一样立刻停，不进 30 秒的坑", ms + "ms");
    ok(/用户已停止任务|未执行/.test(String(r.content || "")), "并且说清楚是被停的", String(r.content || "").slice(0, 80));
  }

  sweep();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  sweep();
  console.error("测试自己崩了：", (e && e.stack) || e);
  process.exit(1);
});
