// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 直调生成的收单台账 —— 「同一单只付一次钱」这条链路。
 *
 *   node test/tool-jobs.js
 *
 * 画布每发一枪带一个 clientJobId。断线、刷新、重启之后拿同一个号回来，服务端必须认得出是同一单：
 * 在跑就等它，跑完了原样交回，服务重启前没收完的交出上游任务号——三种情况都**不再开枪**。
 * 数的是 exec 真被调了几次（等于上游被打了几次），不是回执里写了什么：回执是台账自己写的，拿它当证据等于自证。
 *
 * 盯六件事：
 *   1. 同号再来：跑完的原样交回、在跑的等它，exec 只跑一次；反向对照：换个号就真跑。
 *   2. 跑失败也记：同号再来交回那句失败原话，不偷偷重跑（重跑要换新号，那是人明说的）。
 *   3. 按人分：别人拿到这个号查不到、也等不到这一单。
 *   4. 上游一收单任务号就落盘；服务重启之后这一单是「没收完」，交出任务号，409，不重开。
 *   5. 台账写不进盘也照样认得出同一单（进程里兜着）。
 *   6. 过期、超量的清掉，真在跑的一条不丢；重启前没收完的（盘上写着在跑、进程里没有）跟收尾过的一样到期就清。
 * 外加生视频那一层：任务号在收单那一刻就报出来（onSubmitted），不等出片——假上游，不连任何厂商。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  ← " + String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300) : "")); }
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tooljobs-home-"));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tooljobs-ws-"));
process.env.OPENWORKBUDDY_HOME = HOME;

const jobs = require(mod("tool-jobs"));
const FILE = jobs.toolJobFile(WS);
// 模拟服务重启：进程里那两张表清空，盘上的台账留着
const restart = () => { jobs._internals.running.clear(); jobs._internals.recent.clear(); };
const hold = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

async function main() {
  console.log("\n【1】单号认不认");
  ok(jobs.toolJobId("cj_abc12345") === "cj_abc12345", "字母数字下划线、8 位以上：认");
  ok(jobs.toolJobId("短") === "" && jobs.toolJobId("a b c d e f g h") === "" && jobs.toolJobId({}) === "",
    "太短、带空格、不是字符串：不认（当没带，照老规矩跑）");
  ok(FILE === path.join(WS, ".openworkbuddy", "tool-jobs.json"), "台账跟着项目走，在 .openworkbuddy 下", FILE);

  console.log("\n【2】同号再来：跑完的原样交回，一次上游都不再调");
  let calls = 0;
  const exec = async () => { calls += 1; return { status: 200, body: { ok: true, file: "outputs/甲.png", path: "outputs/甲.png" } }; };
  const a = await jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_first_0001", tool: "generate_image", model: "m1", exec });
  const b = await jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_first_0001", tool: "generate_image", model: "m1", exec });
  ok(calls === 1 && !a.replayed && b.replayed && b.body.path === "outputs/甲.png", "★同一个号第二趟：exec 只跑过一次，交回的是第一趟那份★", { calls, a: a.replayed, b });
  ok(a.job && a.job.state === "done", "台账里记成 done", a.job);
  restart();
  const c = await jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_first_0001", tool: "generate_image", model: "m1", exec });
  ok(calls === 1 && c.replayed && c.body.path === "outputs/甲.png", "★服务重启之后同号再来：从盘上的台账交回，照样不开枪★", { calls, c });
  await jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_other_0002", tool: "generate_image", exec });
  ok(calls === 2, "反向对照：换个号就真跑一次", calls);

  console.log("\n【3】同号同时来两趟：第二趟等第一趟，不开第二枪");
  calls = 0;
  const h = hold();
  const slow = async () => { calls += 1; await h.p; return { status: 200, body: { ok: true, path: "outputs/乙.mp4" } }; };
  const p1 = jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_twice_0003", tool: "generate_video", exec: slow });
  await new Promise((r) => setTimeout(r, 20));
  const looking = jobs.toolJobLookup({ file: FILE, owner: "alice", id: "cj_twice_0003" });
  const p2 = jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_twice_0003", tool: "generate_video", exec: slow });
  h.open();
  const [r1, r2] = await Promise.all([p1, p2]);
  ok(looking && looking.job.state === "running" && looking.response === null, "跑着的时候查：running，没有回执", looking);
  ok(calls === 1 && r2.replayed && r2.body.path === "outputs/乙.mp4" && !r1.replayed, "★断线重连那一趟跟原来那趟撞上：等它，交回同一份★", { calls, r1, r2 });

  console.log("\n【4】跑失败也记：同号再来交回失败原话，不偷偷重跑");
  calls = 0;
  const boom = async () => { calls += 1; throw Object.assign(new Error("渠道没配好：缺 base_url"), { status: 400 }); };
  const f1 = await jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_fails_0004", tool: "generate_image", exec: boom });
  const f2 = await jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_fails_0004", tool: "generate_image", exec: boom });
  ok(f1.status === 400 && /缺 base_url/.test(f1.body.error) && f1.job.state === "failed", "exec 抛错收成一份回执，原话照写", f1);
  ok(calls === 1 && f2.replayed && /缺 base_url/.test(f2.body.error), "★同号再来交回那句失败，不重跑★ 重来要换新号", { calls, f2 });
  const soft = await jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_softf_0005", tool: "generate_video",
    exec: async () => ({ status: 200, body: { ok: false, isError: true, content: "视频生成超时", submitted: "vt-7" } }) });
  ok(soft.job.state === "failed" && soft.job.submitted === "vt-7", "工具自己报的失败（isError）也算没成，回执里的任务号记进台账", soft.job);

  console.log("\n【5】按人分：别人拿到这个号也查不到、等不到");
  ok(jobs.toolJobLookup({ file: FILE, owner: "bob", id: "cj_first_0001" }) === null, "bob 查 alice 的单：没有");
  calls = 0;
  await jobs.toolJobRun({ file: FILE, owner: "bob", id: "cj_first_0001", tool: "generate_image", exec });
  ok(calls === 1, "bob 用同一个号是他自己的一单，照常跑（不会拿到 alice 的图）", calls);

  console.log("\n【6】上游一收单任务号就落盘；重启后这一单是「没收完」，不重开");
  calls = 0;
  const h2 = hold();
  const taking = async ({ onSubmitted }) => { calls += 1; onSubmitted({ taskId: "vt-42", proto: "ark" }); await h2.p; return { status: 200, body: { ok: true, path: "outputs/丙.mp4" } }; };
  const p3 = jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_taken_0006", tool: "generate_video", exec: taking });
  await new Promise((r) => setTimeout(r, 20));
  const onDisk = jobs.toolJobRead(FILE).jobs[jobs.toolJobKey("alice", "cj_taken_0006")] || {};
  ok(onDisk.state === "running" && onDisk.submitted === "vt-42" && onDisk.proto === "ark", "★还没出片，任务号已经在盘上了★ 这时候重启，任务号也丢不了", onDisk);
  // 进程「重启」：在跑的那一枪这个进程里没了，盘上还写着在跑
  const live = jobs._internals.running.get(jobs.toolJobKey("alice", "cj_taken_0006"));
  restart();
  const after = jobs.toolJobLookup({ file: FILE, owner: "alice", id: "cj_taken_0006" });
  ok(after && after.job.state === "interrupted" && after.job.submitted === "vt-42" && after.response === null,
    "重启后查：interrupted，带着任务号 vt-42", after);
  const again = await jobs.toolJobRun({ file: FILE, owner: "alice", id: "cj_taken_0006", tool: "generate_video", exec: taking });
  ok(calls === 1 && again.status === 409 && again.replayed && /任务号 vt-42/.test(again.body.error) && /没有再发一次/.test(again.body.error),
    "★重启后同号再来：409、原话带任务号，exec 一次都没再调★ 那一单可能正在上游渲染、扣费", { calls, again });
  h2.open(); await p3; void live;

  console.log("\n【7】台账写不进盘：进程里兜着，同号再来照样认得出");
  const BAD_WS = path.join(WS, "不是目录.txt");
  fs.writeFileSync(BAD_WS, "x");
  const BAD = jobs.toolJobFile(BAD_WS);   // 父目录是个文件，mkdir/write 必挂
  calls = 0;
  const warn = console.warn; const warned = []; console.warn = (...x) => warned.push(x.join(" "));
  try {
    await jobs.toolJobRun({ file: BAD, owner: "alice", id: "cj_nodisk_0007", tool: "generate_image", exec });
    const r = await jobs.toolJobRun({ file: BAD, owner: "alice", id: "cj_nodisk_0007", tool: "generate_image", exec });
    ok(calls === 1 && r.replayed && r.body.path === "outputs/甲.png", "★台账写不进去，同号第二趟照样不开枪★", { calls, r });
    ok(warned.some((w) => /台账写不进去/.test(w)), "写不进去留了痕（不是悄悄吞掉）", warned);
  } finally { console.warn = warn; }

  console.log("\n【8】清理：过期的、超量的清掉，真在跑的一条不丢");
  const now = Date.now(), DAY = jobs.JOB_KEEP_MS;
  const RUN = jobs._internals.running;
  const big = {};
  big.old = { id: "old", state: "done", at: now - DAY - 1000, doneAt: now - DAY - 1000 };
  big.stale = { id: "stale", state: "running", at: now - DAY * 3 };                          // 重启前没收完，放了三天
  big.staleSub = { id: "staleSub", state: "running", at: now - DAY * 3, submittedAt: now - 100 };  // 开枪早、收单晚：从收单那一刻算
  big.alive = { id: "alive", state: "running", at: now - DAY * 3 };                          // 这个进程里真在跑
  big.fresh = { id: "fresh", state: "running", at: now - 5000 };                             // 刚中断的
  for (let i = 0; i < jobs.JOB_MAX + 5; i += 1) big[`k${i}`] = { id: `k${i}`, state: "done", at: now - 1000 + i, doneAt: now - 1000 + i };
  RUN.set("alive", Promise.resolve());
  let kept;
  try { kept = jobs.toolJobPrune(big, now); } finally { RUN.delete("alive"); }
  ok(!kept.old, "过了一天的已收尾条目清掉");
  ok(!!kept.alive, "★这个进程里真在跑的不清，哪怕放了三天★ 清了就查不到它收过单");
  ok(!kept.stale, "★重启前没收完的、放了三天：清掉★ 它不会再收尾了，以前一条都不清，台账只涨不落");
  ok(!!kept.staleSub, "  └ 年龄从收单那一刻算：昨天开枪、刚收单的还留着");
  ok(Object.keys(kept).length === jobs.JOB_MAX && !kept.k0 && !!kept[`k${jobs.JOB_MAX + 4}`] && !!kept.alive, "超量先丢最老的，真在跑的不算在可丢的里", Object.keys(kept).length);
  ok(!kept.fresh, "  └ 刚中断的那条比满额里最老的还老：超量时照样排进可丢的（以前它永远占着一格）");

  // 满额全是重启前没收完的：这一趟正在写的那条（keep）不许被挤掉。以前中断的一条都不清、也不算可丢的，
  // 攒满 300 条之后，刚收尾写下的那条 done 成了唯一「可丢的」，写进去当场就被清掉
  const crowd = {};
  for (let i = 0; i < jobs.JOB_MAX + 3; i += 1) crowd[`i${i}`] = { id: `i${i}`, state: "running", at: now - 60000 + i };
  crowd.mine = { id: "mine", state: "running", at: now - 120000 };
  const kept2 = jobs.toolJobPrune(crowd, now, "mine");
  ok(!!kept2.mine && Object.keys(kept2).length === jobs.JOB_MAX, "★满额全是中断的：这一趟正在写的那条留下，挤掉的是最老的中断条目★", Object.keys(kept2).length);
  const kept3 = jobs.toolJobPrune(crowd, now);
  ok(!kept3.mine, "  反向对照：不说 keep，最老的那条照样排进可丢的");

  // 真走一遍 toolJobPatch：台账里塞满中断的，新收尾的一条写进去还在
  const PF = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "owb-tooljobs-prune-")), "tool-jobs.json");
  fs.writeFileSync(PF, JSON.stringify({ version: 1, jobs: crowd }));
  jobs.toolJobPatch(PF, "newest", { id: "newest", state: "done", at: now - DAY * 2, doneAt: now - DAY * 2 });
  const ledger = jobs.toolJobRead(PF).jobs;
  ok(!!ledger.newest, "★toolJobPatch 刚写的那条不被同一趟清理清掉（哪怕时间戳很老）★", Object.keys(ledger).length);
  ok(Object.keys(ledger).length <= jobs.JOB_MAX, "台账照样不超额", Object.keys(ledger).length);
  try { fs.rmSync(path.dirname(PF), { recursive: true, force: true }); } catch {}

  console.log("\n【9】生视频：任务号在收单那一刻就报出来，不等出片（假上游）");
  const tools = require(mod("tools"));
  const { generateVideo } = tools._internals;
  const DASH = "https://dashscope.example.test/api/v1/services/aigc";
  const cfg = { kind: "dashscope", base_url: DASH, model: "wan2.2-t2v-plus", api_key: "test-key-dash" };
  const CDN = "https://cdn.example.test/v.mp4";
  const js = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tooljobs-vid-"));
  const events = [];
  let polls = 0, downloadOk = true;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (/\/video-synthesis$/.test(u)) { events.push("submit"); return js({ output: { task_id: "w-77" } }); }
    if (/\/tasks\/w-77$/.test(u)) { polls += 1; events.push("poll"); return js({ output: { task_status: "SUCCEEDED", video_url: CDN } }); }
    if (u === CDN) {
      events.push("download");
      if (!downloadOk) return { ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0), json: async () => ({}), text: async () => "busy" };
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(64, 9), json: async () => ({}), text: async () => "" };
    }
    throw new Error("测试里没准备这个地址：" + u);
  };
  try {
    const seen = [];
    const r = await generateVideo({ video: cfg, list: [] }, { prompt: "一只猫跑过草地", filename: "猫.mp4" },
      { saveDir, onSubmitted: (info) => { seen.push({ ...info, at: events.length }); events.push("submitted"); } });
    ok(!r.isError, "假上游：生成成功", r.content);
    ok(seen.length === 1 && seen[0].taskId === "w-77" && seen[0].proto, "onSubmitted 报了一次，带着任务号 w-77", seen);
    ok(events.indexOf("submitted") === events.indexOf("submit") + 1 && events.indexOf("submitted") < events.indexOf("poll"),
      "★任务号在收单之后、第一次查进度之前就报出来★ 不是等出片才报", events);
    events.length = 0; downloadOk = false;
    const seen2 = [];
    let r2 = null;
    try {
      r2 = await generateVideo({ video: cfg, list: [] }, { prompt: "一只猫跑过草地", filename: "猫2.mp4" },
        { saveDir, onSubmitted: (info) => seen2.push(info.taskId) });
    } catch (e) { r2 = { thrown: true, submitted: e.submitted, content: e.message }; }
    ok(r2 && r2.submitted === "w-77" && seen2.join() === "w-77" && /任务号 w-77/.test(r2.content),
      "收单后下载失败：错里带 submitted 和任务号原话，任务号也早报过了", { r2, seen2 });
    events.length = 0; downloadOk = true;
    const r3 = await generateVideo({ video: cfg, list: [] }, { prompt: "一只猫跑过草地", filename: "猫3.mp4" },
      { saveDir, onSubmitted: () => { throw new Error("台账那头炸了"); } });
    ok(!r3.isError, "反向对照：onSubmitted 自己抛错不拖垮这一单（钱已经花了，片照样收）", r3.content);
  } finally { global.fetch = realFetch; }
  void polls;

  console.log("\n【10】接线：直调接口带号就不跟请求同生死，查单只读台账");
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const route = server.slice(server.indexOf('app.post("/api/tool/run"'), server.indexOf('app.get("/api/tool/job"'));
  ok(/if \(!jobId\) res\.on\("close"/.test(route), "带了 clientJobId 的不挂「连接一断就叫停」", route.length);
  ok(/toolJobs\.toolJobRun\(/.test(route) && /onSubmitted/.test(route), "带号的走台账，onSubmitted 一路接到工具");
  const agent = fs.readFileSync(path.join(ROOT, "src/agent/agent.js"), "utf8");
  ok(/async function runTool\([^)]*onSubmitted/.test(agent) && /\n\s+onSubmitted,\n/.test(agent), "runTool → execOpts 把 onSubmitted 传下去（tools.js 按 ...opts 交给 generateVideo）");

  console.log(fail ? `\n有失败：${pass} 过 / ${fail} 挂` : `\n全部通过：${pass} 过 / 0 挂`);
  for (const d of [HOME, WS, saveDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
