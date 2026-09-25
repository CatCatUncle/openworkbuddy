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
 *
 * 后半段是花钱的那几路（任务 2.3）：生视频是「提交 → 5 秒一查 → 下载」的异步单，
 * 以前 fetch 只挂了时限、轮询的 5 秒是睡死的，点了停止片子照出、照扣费、照落盘。
 * 这里全用假上游（改 global.fetch / 起本机假服务器），一分钱不花。
 * MCP 那边盯的是：停了要按协议发 notifications/cancelled，并且不再等它的结果。
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
const tools = require(path.join(ROOT, "tools"));
const { executeTool } = tools;
const quota = require(path.join(ROOT, "quota"));
const { McpManager, McpClient } = require(path.join(ROOT, "mcp"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });

// ---------------------------------------------------------------- 生视频
const VBASE = "https://dashscope.example.test/api/v1";
const CDN = "https://cdn.example.test/stop.mp4";
const VWS = path.join(TMP, "ws");
const VOUT = "视频";
const vmedia = { video: { kind: "dashscope", base_url: VBASE, api_key: "k-test", model: "wan2.2-t2v-plus" }, list: [] };
const videoUsage = () => { try { return quota._internals.load().usage.filter((e) => e.cap === "video").length; } catch { return -1; } };

/**
 * 假万相。mode 决定卡在哪一步：
 *   sleep    轮询回 RUNNING（停在两次查询之间的 5 秒等待里）
 *   inflight 轮询那一趟请求自己就挂着不回（停在 fetch 里——没把停止信号合进 fetch 就只能等 30 秒时限）
 *   download 片子出好了，下载挂着不回（停在最后一步——这时候落盘就是把半截产物当成品）
 *   ok       一路顺利
 *   pollerr  下单成功，查询那一趟网断了（上游已经收下这一单）
 *   failed   下单成功，上游回 FAILED（上游自己说没做成）
 * 「挂着」只认请求自己的 signal；5 秒兜底是防实现坏了把整个套件吊死，5 秒远大于要断言的 1 秒。
 */
function fakeWan(mode) {
  const log = { submit: 0, poll: 0, download: 0, cancel: [] };
  const hang = (init) => new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error("假上游 5 秒兜底")), 5000);
    const s = (init || {}).signal;
    if (!s) return;
    const off = () => { clearTimeout(t); rej(s.reason || new Error("aborted")); };
    if (s.aborted) off(); else s.addEventListener("abort", off, { once: true });
  });
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/\/video-synthesis$/.test(u)) { log.submit++; return js({ output: { task_id: "vt-1" } }); }
    if (/\/tasks\/vt-1\/cancel$/.test(u)) { log.cancel.push(init.method || "GET"); return js({ request_id: "c" }); }
    if (/\/tasks\/vt-1$/.test(u)) {
      log.poll++;
      if (mode === "inflight") return hang(init);
      if (mode === "pollerr") throw new Error("fetch failed");
      if (mode === "failed") return js({ output: { task_status: "FAILED", message: "内容审核没过" } });
      // 第二趟起回 FAILED：实现坏了（停不下来）时让它 5 秒后以失败收场，而不是把套件吊 10 分钟
      if (mode === "sleep") return js({ output: { task_status: log.poll >= 2 ? "FAILED" : "RUNNING" } });
      return js({ output: { task_status: "SUCCEEDED", video_url: CDN } });
    }
    if (u === CDN) {
      log.download++;
      if (mode === "download") return hang(init);
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(256, 7), json: async () => ({}), text: async () => "" };
    }
    throw new Error("测试里没准备这个地址：" + u);
  };
  return log;
}

/** 生一条视频，abortAfter 毫秒后按停止（null = 不按）。回报「按下停止到工具返回」用了多久 */
async function genVideo(filename, abortAfter) {
  const ctrl = new AbortController();
  let tAbort = 0;
  const timer = abortAfter === null ? null : setTimeout(() => { tAbort = Date.now(); ctrl.abort(); }, abortAfter);
  const r = await tools.withWorkspace(VWS, () => executeTool("generate_video", { prompt: "一只猫跑过草地", filename },
    { media: vmedia, security: { gateway: false }, baseDir: VOUT, stopSignal: ctrl.signal, taskLabel: "停止测试" }));
  clearTimeout(timer);
  const text = String((r && r.content) || "");
  return { r: r || {}, text, afterStop: tAbort ? Date.now() - tAbort : -1, file: path.join(VWS, VOUT, filename) };
}

async function videoChecks() {
  fs.mkdirSync(path.join(VWS, VOUT), { recursive: true });
  const realFetch = global.fetch;
  try {
    console.log("\n— 生视频：点了停止，在途的轮询 1 秒内收手、不落盘 —");
    {
      const log = fakeWan("sleep");
      const before = videoUsage();
      const v = await genVideo("停在等待里.mp4", 300);
      ok(v.afterStop >= 0 && v.afterStop < 1000, "停在两次查询之间：按下停止 1 秒内返回（不等满那 5 秒，更不等 10 分钟）", v.afterStop + "ms");
      ok(/用户已停止任务/.test(v.text), "话说的是「用户已停止任务」", v.text.slice(0, 80));
      ok(!/超时|错误 \d{3}|HTTP \d{3}/.test(v.text), "反向对照：不能说成超时 / 错误码——那会被健康表记成渠道故障", v.text.slice(0, 80));
      ok(v.r.isError && v.r.stopped, "算没做成，并带着 stopped 标记", { isError: v.r.isError, stopped: v.r.stopped });
      ok(!fs.existsSync(v.file), "★没有落盘文件★", v.file);
      const polls = log.poll;
      await wait(300);
      eq(log.poll, polls, "停了之后轮询不再继续");
      ok(log.cancel.includes("POST"), "顺手去上游撤了单（万相：POST /tasks/{id}/cancel）", log.cancel);
      eq(videoUsage(), before, "停下的这一条没记账（没出片就不该扣）");
    }
    {
      const log = fakeWan("inflight");
      const v = await genVideo("停在查询里.mp4", 300);
      ok(v.afterStop >= 0 && v.afterStop < 1000, "停在正在发的查询请求里：1 秒内返回（停止信号合进了 fetch，不用等 30 秒时限）", v.afterStop + "ms");
      ok(v.r.stopped && /用户已停止任务/.test(v.text), "一样说「用户已停止任务」", v.text.slice(0, 80));
      ok(!fs.existsSync(v.file), "没有落盘文件", v.file);
      eq(log.poll, 1, "只发出过那一趟查询");
    }
    {
      const log = fakeWan("download");
      const v = await genVideo("停在下载里.mp4", 300);
      ok(v.afterStop >= 0 && v.afterStop < 1000, "停在下载里：1 秒内返回", v.afterStop + "ms");
      ok(v.r.stopped, "带着 stopped 标记", v.text.slice(0, 80));
      ok(!fs.existsSync(v.file), "★下载到一半停了：不落半截文件★（半截会被缓存当成品复用）", v.file);
      eq(log.cancel.length, 0, "片子已经出完了就不去撤单（没有单可撤）", log.cancel);
    }
    {
      // 信号在调用之前就已经拉起：连提交都不该发——视频是按条计费的，提交了就是钱
      const log = fakeWan("ok");
      const ctrl = new AbortController();
      ctrl.abort();
      const r = await tools.withWorkspace(VWS, () => executeTool("generate_video", { prompt: "一只猫", filename: "没开始.mp4" },
        { media: vmedia, security: { gateway: false }, baseDir: VOUT, stopSignal: ctrl.signal, taskLabel: "停止测试" }));
      ok(r && r.isError && /已停止/.test(String(r.content)), "开跑前就停了：直接回已停止", r && r.content);
      eq(log.submit, 0, "★一个提交请求都没发（没下单就没花钱）★");
      ok(!fs.existsSync(path.join(VWS, VOUT, "没开始.mp4")), "也没有文件");
    }

    console.log("\n— agent 这一层：停止信号真传到了工具（直调口 runTool）—");
    {
      // 上面几条直接打 executeTool，证明不了 agent.js 把信号往下传了。这里走 agent 的 runtime：
      // 画布上点「重新生成」走的就是 runTool，服务端给的是请求级 signal，任务里给的是 stopSignal，两路都得管用
      const mm = require(path.join(ROOT, "media-models"));
      const { createAgentRuntime } = require(path.join(ROOT, "agent"));
      const cfg = { media: { video: { base_url: VBASE, api_key: "k-test", model: "wan2.2-t2v-plus" } },
        agent: { tool_timeout_ms: 120000 }, security: { gateway: false }, search: {} };
      mm.normalize(cfg);
      const llm = { model: "假模型", provider: "假渠道", chat: async () => { throw new Error("这里不该调模型"); } };
      const rt = createAgentRuntime({ config: cfg, llm, mcpManager: { toolDefs: () => [], isMcpTool: () => false }, experts: [] });
      for (const via of ["signal", "stopSignal"]) {
        fakeWan("sleep");
        const ctrl = new AbortController();
        let tAbort = 0;
        setTimeout(() => { tAbort = Date.now(); ctrl.abort(); }, 300);
        const fname = `直调_${via}.mp4`;
        const r = await tools.withWorkspace(VWS, () => rt.runTool("generate_video", { prompt: "一只猫", filename: fname }, { baseDir: VOUT, [via]: ctrl.signal }));
        const after = Date.now() - tAbort;
        ok(after < 1000 && r && r.stopped, `runTool 带 ${via}：按下停止 1 秒内收手`, { ms: after, content: r && String(r.content).slice(0, 60) });
        ok(!fs.existsSync(path.join(VWS, VOUT, fname)), `runTool 带 ${via}：没有落盘文件`);
      }
    }

    console.log("\n— 下了单之后才出错：带上游任务号回去，别让画布自动补枪再买一单 —");
    {
      const log = fakeWan("pollerr");
      const v = await genVideo("下单后断网.mp4", null);
      ok(v.r.isError && !v.r.stopped, "查询断网：算没做成，但不是停止", v.text.slice(0, 80));
      eq(v.r.submitted, "vt-1", "★回执带着上游任务号 submitted★ 画布靠它判断「别自动重跑」");
      ok(/任务号 vt-1/.test(v.text) && /别直接重跑/.test(v.text), "话里说清：上游收下了、多半扣费、按任务号去查", v.text.slice(0, 160));
      eq(log.submit, 1, "只下了一单");
      ok(!fs.existsSync(v.file), "没有落盘文件", v.file);
    }
    {
      fakeWan("failed");
      const v = await genVideo("上游说失败.mp4", null);
      ok(v.r.isError && /视频任务失败/.test(v.text), "上游回 FAILED：照常报失败", v.text.slice(0, 80));
      ok(!v.r.submitted && !/别直接重跑/.test(v.text), "★反向对照：上游自己说没做成的不带 submitted★ 这种一般不收钱，照常可以重试", { submitted: v.r.submitted, text: v.text.slice(0, 120) });
    }

    console.log("\n— 反向对照：不按停止，视频照常出片落盘 —");
    {
      const log = fakeWan("ok");
      const before = videoUsage();
      const v = await genVideo("正常出片.mp4", null);
      ok(!v.r.isError && !v.r.stopped, "没按停止：出片成功", v.text.slice(0, 80));
      ok(fs.existsSync(v.file), "文件落盘了", v.file);
      ok(!/用户已停止任务/.test(v.text), "没人按停就不许出现「已停止」字样", v.text.slice(0, 60));
      eq(log.cancel.length, 0, "没人按停就不去撤单");
      eq(videoUsage(), before + 1, "出了片就记一笔账（证明上面那条「没记账」不是因为账根本记不上）");
    }
  } finally {
    global.fetch = realFetch;
  }
}

// ---------------------------------------------------------------- 生图：停在读正文那一截
// 响应头回来了、正文还在路上（b64 大图能有好几 MB）。这时候按停止，fetch 掐的是正文，
// r.json() 被吞成 {}，里面只剩一句「没有返回图片」——模型会当成上游故障换参数重来。
const IBASE = "https://img.example.test/v1";
const imedia = { image: { kind: "openai", base_url: IBASE, api_key: "k-test", model: "gpt-image-1" }, list: [] };

function fakeImg(mode) {
  const log = { post: 0 };
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!/\/images\/generations$/.test(u)) throw new Error("测试里没准备这个地址：" + u);
    log.post++;
    const s = init.signal;
    // body：正文一直不来，只认请求自己的 signal（跟真 fetch 一样：掐了信号，json() 就抛）；empty：立刻回一个空对象
    const json = () => mode === "empty" ? Promise.resolve({}) : new Promise((res, rej) => {
      const t = setTimeout(() => res({}), 5000);
      const off = () => { clearTimeout(t); rej((s && s.reason) || new Error("aborted")); };
      if (!s) return;
      if (s.aborted) off(); else s.addEventListener("abort", off, { once: true });
    });
    return { ok: true, status: 200, json, text: async () => "" };
  };
  return log;
}

async function genImage(filename, abortAfter) {
  const ctrl = new AbortController();
  let tAbort = 0;
  const timer = abortAfter === null ? null : setTimeout(() => { tAbort = Date.now(); ctrl.abort(); }, abortAfter);
  const r = await tools.withWorkspace(VWS, () => executeTool("generate_image", { prompt: "一只猫", filename, no_cache: true },
    { media: imedia, security: { gateway: false }, baseDir: VOUT, stopSignal: ctrl.signal, taskLabel: "停止测试" }));
  clearTimeout(timer);
  return { r: r || {}, text: String((r && r.content) || ""), afterStop: tAbort ? Date.now() - tAbort : -1, file: path.join(VWS, VOUT, filename) };
}

async function imageChecks() {
  fs.mkdirSync(path.join(VWS, VOUT), { recursive: true });
  const realFetch = global.fetch;
  const mediaHealth = require(path.join(ROOT, "media-health"));
  try {
    console.log("\n— 生图：停在读正文那一截，也要说「已停止」，不说「没返回图片」—");
    mediaHealth.reset();
    const log = fakeImg("body");
    const v = await genImage("停在正文里.png", 300);
    ok(v.afterStop >= 0 && v.afterStop < 1000, "按下停止 1 秒内返回", v.afterStop + "ms");
    ok(v.r.isError && v.r.stopped && /用户已停止任务/.test(v.text), "★回的是「用户已停止任务」，带 stopped 标记★", v.text.slice(0, 80));
    ok(!/没有返回图片/.test(v.text), "不能说成「没有返回图片」——模型会当上游故障重来", v.text.slice(0, 80));
    ok(!fs.existsSync(v.file), "没有落盘文件", v.file);
    eq(log.post, 1, "只发了那一趟");
    eq(mediaHealth.list().filter((b) => b.cap === "image").length, 0, "停下的这一次不进渠道健康表");

    console.log("\n— 反向对照：没按停止时，上游真没给图就照实说 —");
    fakeImg("empty");
    const e = await genImage("真没给图.png", null);
    ok(e.r.isError && !e.r.stopped, "没按停止：算失败，但不带 stopped", { isError: e.r.isError, stopped: e.r.stopped });
    ok(/没有返回图片/.test(e.text) && !/用户已停止任务/.test(e.text), "没人按停就照实说「没有返回图片」，不许冒充已停止", e.text.slice(0, 80));
  } finally {
    global.fetch = realFetch;
    mediaHealth.reset();
  }
}

// ---------------------------------------------------------------- agent → MCP
// mcpChecks 直接打 McpManager.call，证明不了 agent 的任务循环真把 stopSignal 递下去了。
// 循环里没有别的地方跟停止信号赛跑：信号没递到，一个挂着的 MCP 工具就能把「停止」吊到它自己的时限
async function agentMcpChecks() {
  console.log("\n— agent 任务里调 MCP：点了停止，信号真递到了 mcpManager.call —");
  const jev = require(path.join(ROOT, "jev"));
  const realAsk = jev.askMetered;
  jev.askMetered = async () => ({ ok: false, error: "测试桩：不发网络" });
  const { createAgentRuntime } = require(path.join(ROOT, "agent"));
  const seen = { calls: 0, signal: null, byAbort: false };
  const mgr = {
    toolDefs: () => [{ name: "mcp__srv__hang", description: "[MCP:srv] 慢工具", input_schema: { type: "object", properties: {} } }],
    isMcpTool: (n) => String(n).startsWith("mcp__"),
    // 5 秒兜底同上：实现坏了不至于把套件吊死，5 秒远大于要断言的 1.5 秒
    call: (name, input, o = {}) => new Promise((res) => {
      seen.calls++;
      seen.signal = o.signal || null;
      const t = setTimeout(() => res({ content: "慢工具的结果", isError: false }), 5000);
      const s = o.signal;
      if (!s) return;
      const off = () => { clearTimeout(t); seen.byAbort = true; res({ content: "用户已停止任务，没等这个 MCP 工具的结果。", isError: true, stopped: true }); };
      if (s.aborted) off(); else s.addEventListener("abort", off, { once: true });
    }),
  };
  const llm = {
    provider: "mock", model: "scripted",
    chat: async ({ tools: ts, toolChoice }) => (ts && ts.length && toolChoice !== "none")
      ? { text: "调一下 MCP。", toolCalls: [{ id: "m1", name: "mcp__srv__hang", input: {} }], stopReason: "tool_use", usage: { prompt: 1, completion: 1 } }
      : { text: "（收尾）", toolCalls: [], stopReason: "end_turn", usage: { prompt: 1, completion: 1 } },
  };
  const dir = path.join(TMP, "agent-mcp");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const rt = createAgentRuntime({ config: { agent: { max_steps: 3, tool_timeout_ms: 30000 }, security: { gateway: false } }, llm, mcpManager: mgr, experts: [] });
    const ctrl = new AbortController();
    let tAbort = 0;
    setTimeout(() => { tAbort = Date.now(); ctrl.abort(); }, 300);
    await tools.withWorkspace(dir, () => rt.runTask({ history: [{ role: "user", content: "用 MCP 工具查一下" }], emit: () => {}, stopSignal: ctrl.signal, taskLabel: "停止测试" }));
    const after = Date.now() - tAbort;
    eq(seen.calls, 1, "任务真的走到了 MCP 工具那一步");
    ok(seen.signal === ctrl.signal, "★mcpManager.call 拿到的就是任务的 stopSignal★", { got: seen.signal ? "有信号但不是这一个" : "没传" });
    ok(seen.byAbort, "工具是被停止信号叫停的，不是等满时限自己回的");
    ok(tAbort > 0 && after < 1500, "按下停止 1.5 秒内任务就收了（不等那 5 秒）", after + "ms");
  } finally {
    jev.askMetered = realAsk;
  }
}

// ---------------------------------------------------------------- MCP
// 假 MCP 服务器：hang 这个工具 700 毫秒后才回（模拟慢工具，也用来看迟到的结果会不会串单），
// echo 立刻回。收到的每一行都记进日志文件，测试拿它看 notifications/cancelled 发没发、发给哪一单
const FAKE_MCP = `
const fs = require("fs");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    fs.appendFileSync(process.env.MCP_LOG, JSON.stringify(m) + "\\n");
    const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1" } });
    else if (m.method === "tools/list") reply({ tools: [{ name: "hang", inputSchema: { type: "object" } }, { name: "echo", inputSchema: { type: "object" } }] });
    else if (m.method === "tools/call" && m.params.name === "echo") reply({ content: [{ type: "text", text: "回声:" + m.params.arguments.text }] });
    else if (m.method === "tools/call") setTimeout(() => reply({ content: [{ type: "text", text: "迟到的结果" }] }), 700);
  }
});
`;

async function mcpChecks() {
  console.log("\n— MCP（stdio）：停了就发 notifications/cancelled，不再等结果 —");
  const script = path.join(TMP, "fake-mcp.js");
  const logFile = path.join(TMP, "fake-mcp.log");
  fs.writeFileSync(script, FAKE_MCP);
  const seen = () => { try { return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const mgr = new McpManager();
  try {
    await mgr.startAll([{ name: "slowsrv", command: process.execPath, args: [script], env: { MCP_LOG: logFile } }]);
    ok(mgr.clients.has("slowsrv"), "假 MCP 服务器连上了", mgr.status());

    const ctrl = new AbortController();
    let tAbort = 0;
    setTimeout(() => { tAbort = Date.now(); ctrl.abort(); }, 200);
    const r = await mgr.call("mcp__slowsrv__hang", {}, { signal: ctrl.signal });
    const after = Date.now() - tAbort;
    ok(after < 300, "按下停止立刻返回，不等那 700 毫秒的结果", after + "ms");
    ok(r.stopped && r.isError && /用户已停止任务/.test(r.content), "回的是「用户已停止任务」，带 stopped 标记", r);
    ok(!/调用失败/.test(r.content), "反向对照：不说成「调用失败」——那会让模型换参数重试", r.content);
    await wait(150);
    const msgs = seen();
    const call = msgs.find((m) => m.method === "tools/call" && m.params && m.params.name === "hang");
    const cancel = msgs.find((m) => m.method === "notifications/cancelled");
    ok(!!cancel, "★服务器收到了 notifications/cancelled★", msgs.map((m) => m.method));
    ok(call && cancel && cancel.params && cancel.params.requestId === call.id, "requestId 对得上被停的那一单", { call: call && call.id, cancel: cancel && cancel.params });
    ok(cancel && cancel.id === undefined, "发的是通知（没有 id），不等它回话", cancel);

    await wait(700); // 让那条迟到的结果回来：它得被丢掉，不能串到下一单头上
    const e = await mgr.call("mcp__slowsrv__echo", { text: "还在" });
    eq(e.content, "回声:还在", "反向对照：停了一单之后连接照常，下一单拿到的是自己的结果（迟到的那条被丢了）");
    ok(!e.isError && !e.stopped, "反向对照：不按停止就是正常结果", e);
    eq(seen().filter((m) => m.method === "notifications/cancelled").length, 1, "反向对照：没按停止的那单不发取消");

    const pre = new AbortController();
    pre.abort();
    const n0 = seen().length;
    const p = await mgr.call("mcp__slowsrv__echo", { text: "不该发" }, { signal: pre.signal });
    ok(p.stopped, "信号在调用前就已拉起：直接回已停止", p);
    await wait(100);
    eq(seen().length, n0, "……这一单根本没发给服务器");
  } finally {
    mgr.stopAll();
  }

  console.log("\n— MCP（Streamable HTTP）：SSE 流读到一半也掐得断 —");
  const http = require("http");
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let m = {};
      try { m = JSON.parse(body || "{}"); } catch {}
      got.push(m);
      const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      if (m.method === "initialize") return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } });
      if (m.method === "tools/list") return reply({ tools: [{ name: "hang", inputSchema: { type: "object" } }] });
      // 开了 SSE 流、只推一条心跳，结果永远不给
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": 还在算\n\n");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const client = new McpClient("httpsrv", { url: `http://127.0.0.1:${srv.address().port}/mcp`, transport: "streamable-http" });
    await client.start();
    const ctrl = new AbortController();
    let tAbort = 0;
    setTimeout(() => { tAbort = Date.now(); ctrl.abort(); }, 200);
    let err = null;
    try { await client.callTool("hang", {}, 60000, { signal: ctrl.signal }); } catch (e) { err = e; }
    const after = Date.now() - tAbort;
    ok(err && err.stopped, "HTTP：按下停止抛的是 stopped，不是超时", err && err.message);
    ok(after < 1000, "HTTP：1 秒内返回（不等 60 秒时限）", after + "ms");
    await wait(200);
    const call = got.find((m) => m.method === "tools/call");
    const cancel = got.find((m) => m.method === "notifications/cancelled");
    ok(call && cancel && cancel.params && cancel.params.requestId === call.id, "HTTP：也发了 notifications/cancelled，requestId 对得上", { call: call && call.id, cancel });
  } finally {
    if (srv.closeAllConnections) srv.closeAllConnections();
    srv.close();
  }
}

// ---------------------------------------------------------------- 命令
async function shellChecks() {
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
}

(async () => {
  // 命令那一段靠 pgrep/pkill 数孙子进程，Windows 上没有；生视频 / 生图 / MCP 那几段不靠它，照跑
  if (process.platform === "win32") console.log("Windows 上没有 pgrep/pkill：跳过命令那一段，只跑生视频 / 生图 / MCP");
  else await shellChecks();

  await videoChecks();
  await imageChecks();
  await mcpChecks();
  await agentMcpChecks();

  sweep();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  sweep();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.error("测试自己崩了：", (e && e.stack) || e);
  process.exit(1);
});
