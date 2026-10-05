// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 一轮任务收尾时，这一轮在后台留下的进程跟着收：
 *   - background:true 起的后台命令（没说 keep 的）；
 *   - 普通 run_shell / run_node 里用 & / nohup 甩出去、外层 shell 退了还活着的进程组。
 *
 * 跑法：node test/run-reap.js（临时数据目录；只起 sleep 这种无害进程，结束前全收干净）
 *
 * 2026-09-28 实测：看网页起的 `(python3 -m http.server 8731 >/dev/null 2>&1 &)` 父进程变成 1，
 * 停止、收尾、退出应用都收不到，活过两次应用重启；并发对话撞端口，有一轮验错了页面。
 * 后台命令表以前是全进程共用 8 条、跑完的永远不删、每块输出同步写一次盘。
 *
 * 每组配反向对照：别的会话收尾不动我的；账本对不上启动时刻的不杀；记账进程还活着的账不碰；
 * keep 的留下；空会话什么都不收；没甩后台的命令不记账。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const { mod } = require("./lib/mod");
const { entry } = require("./lib/entry");

if (process.platform === "win32") { console.log("跳过：Windows 没有进程组这回事（taskkill /T 走另一条路）"); process.exit(0); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-reap-"));
process.env.OPENWORKBUDDY_HOME = TMP;
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
const T0 = Date.now();
const tools = require(mod("tools"));
const CT = require(mod("code-tools"));
const I = tools._internals;

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (detail === undefined ? "" : "\n      " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\n/g, "\n      "))); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(50); } return false; }
const alive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lstartOf = (pid) => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" }, encoding: "utf8" }).trim().replace(/\s+/g, " ");
const pgidOf = (content) => Number((/进程组 (\d+)/.exec(content) || [])[1] || 0);

const spawned = new Set(); // 测试自己起过的进程组，结尾兜底全收
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  // 不给 pid：给 0 的话退出时那句 process.kill(-0) 等于给自己整个进程组发信号，连测试总控一起带走
  c.pid = undefined;
  return c;
}

(async () => {
  const WS = path.join(TMP, "ws");
  fs.mkdirSync(WS, { recursive: true });

  console.log("\n① 普通 run_shell 里用 & 甩出去的进程组：记账、告诉模型");
  let gA = 0;
  {
    const r = await I.runShell("(sleep 30 >/dev/null 2>&1 &)", 10000, WS, null, "A");
    gA = pgidOf(r.content);
    if (gA) spawned.add(gA);
    ok(gA > 0 && alive(gA), "外层 shell 退了，进程组还活着，结果里点名了这一组", r.content);
    ok(/这一轮结束会被收掉/.test(r.content) && /background:true/.test(r.content) && /keep:true/.test(r.content), "告诉模型：这一轮结束会被收掉、要一直跑用 background:true / keep:true", r.content);
    const e = I.strays.get(gA);
    ok(e && e.session === "A" && e.members.some((m) => /sleep 30/.test(m.command) && m.pid > 0 && /\d{4}$/.test(m.lstart)), "账本记下了会话、成员的 pid 和启动时刻", e);
    const readDisk = () => { try { return JSON.parse(fs.readFileSync(I.strayFile(), "utf8")); } catch { return null; } };
    await until(() => { const d = readDisk(); return d && d.strays.some((s) => s.pgid === gA); }, 2000);
    const disk = readDisk() || {};
    ok(disk.host && disk.host.pid === process.pid && disk.host.lstart && disk.strays.some((s) => s.pgid === gA), "账本按进程落盘（带记账进程自己的启动时刻）", disk);

    const n0 = I.strays.size;
    const r2 = await I.runShell("echo hi", 10000, WS, null, "A");
    ok(!/进程组/.test(r2.content) && I.strays.size === n0, "没往后台甩东西的命令：不记账、结果里不多一句（反向对照）", r2.content);
    const r3 = await I.runShell("sleep 30 >/dev/null 2>&1 & exit 0", 10000, WS, null, "");
    const g3 = pgidOf(r3.content);
    if (g3) spawned.add(g3);
    ok(g3 > 0 && /应用退出时会被收掉/.test(r3.content) && !/这一轮结束会被收掉/.test(r3.content), "没带会话的：照样记账，但不许诺「这一轮结束会收」", r3.content);
  }

  console.log("\n② run_node 脚本里没等的子进程，同样记账");
  let gN = 0;
  {
    const code = "require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' }).unref(); console.log('spawned');";
    const r = await I.runNode(code, 10000, WS, null, "A");
    gN = pgidOf(r.content);
    if (gN) spawned.add(gN);
    ok(gN > 0 && alive(gN) && /spawned/.test(r.content) && /run_shell 的 background:true/.test(r.content), "脚本退了、sleep 还在：点名这一组", r.content);
    ok(I.strays.get(gN) && I.strays.get(gN).session === "A", "记在会话 A 名下");
  }

  console.log("\n③ 收尾：只收自己这一轮的");
  {
    const rb = await tools.releaseRun("B");
    await wait(300);
    ok(alive(gA) && alive(gN) && I.strays.has(gA) && I.strays.has(gN), "会话 B 收尾：A 的两组都还活着、账也还在（反向对照）", rb);
    const r0 = await tools.releaseRun("");
    ok(alive(gA) && r0.strays.length === 0 && r0.jobs.length === 0, "空会话收尾：什么都不动（空串不是「所有人」）", r0);
    const t0 = Date.now();
    const ra = await tools.releaseRun("A", { browser: false });
    const gone = await until(() => !alive(gA) && !alive(gN), 3000);
    ok(gone && ra.strays.includes(gA) && ra.strays.includes(gN), `会话 A 收尾：两组都送走了（${Date.now() - t0}ms）`, { ra, a: alive(gA), n: alive(gN) });
    ok(!I.strays.has(gA) && !I.strays.has(gN), "账销掉了");
  }

  console.log("\n④ 后台命令归这一轮：收尾收掉，keep 的留下");
  {
    const S = { sessionId: "K", actor: "kim" };
    const a = I.startBackground("sleep 30", WS, S, false);
    const b = I.startBackground("sleep 31", WS, S, true);
    const other = I.startBackground("sleep 32", WS, { sessionId: "L", actor: "kim" }, false);
    const idOf = (r) => (/(bg\d+)/.exec(r.content) || [])[1];
    const [ia, ib, io] = [idOf(a), idOf(b), idOf(other)];
    const job = (id) => CT.bgList().find((j) => j.id === id);
    for (const id of [ia, ib, io]) { const j = job(id); if (j && j.child && j.child.pid) spawned.add(j.child.pid); }
    ok(/这一轮结束时会被收掉/.test(a.content) && /keep:true/.test(a.content), "起的时候就说清：这一轮结束会收，要留着加 keep:true", a.content);
    ok(/这一轮结束后也留着/.test(b.content), "keep 的：说清会留着", b.content);
    ok(job(ia).session === "K" && job(ia).keep === false && job(ib).keep === true, "任务上记了会话和 keep");
    const r = await tools.releaseRun("K", { browser: false });
    ok(r.jobs.includes(ia) && !r.jobs.includes(ib) && r.kept.includes(ib), "收尾收了没 keep 的，keep 的列在「留着」里", r);
    ok(await until(() => job(ia).exit !== undefined, 3000), "没 keep 的那条真停了");
    ok(/上一轮结束时收掉了/.test(CT.bgState(job(ia))), "shell_output 看得到它是收尾时收掉的", CT.bgState(job(ia)));
    await wait(200);
    ok(job(ib).exit === undefined && /这一轮结束后也留着/.test(CT.bgState(job(ib))), "keep 的还在跑（反向对照）", CT.bgState(job(ib)));
    ok(job(io).exit === undefined, "别的会话 L 的后台命令没被动（反向对照）");
    CT.bgKill(ib, (c) => { try { process.kill(-c.pid, "SIGKILL"); } catch {} });
    CT.bgKill(io, (c) => { try { process.kill(-c.pid, "SIGKILL"); } catch {} });
    ok(await until(() => job(ib).exit !== undefined && job(io).exit !== undefined, 3000), "测试收尾：两条都停了");
  }

  console.log("\n⑤ 同一个会话键两轮并发：最后一轮放手才收");
  {
    const S = { sessionId: "W", actor: "w" };
    const x = I.startBackground("sleep 30", WS, S, false);
    const id = (/(bg\d+)/.exec(x.content) || [])[1];
    const j = CT.bgList().find((q) => q.id === id);
    if (j && j.child) spawned.add(j.child.pid);
    const g1 = tools.holdRun("W", { browser: false });
    const g2 = tools.holdRun("W", { browser: false });
    // runHeld 给 cdp.js 用：还在跑的任务，它的标签页闲再久、同时开得再多也不收
    ok(tools.runHeld("W") && !tools.runHeld("V") && !tools.runHeld(""), "hold 住的会话 runHeld 为真；别的会话、空串为假（反向对照）");
    await g1();
    await wait(200);
    ok(j.exit === undefined, "先跑完的那轮放手：另一轮还在跑，不收（反向对照）");
    ok(tools.runHeld("W"), "  └ 还有一轮没放手：runHeld 仍为真");
    await g1();
    await wait(200);
    ok(j.exit === undefined, "同一个放手函数调两次只算一次");
    await g2();
    ok(!tools.runHeld("W"), "最后一轮放手：runHeld 变假");
    ok(await until(() => j.exit !== undefined, 3000), "最后一轮放手：收了");
    const g0 = tools.holdRun("");
    ok((await g0()) === null, "空会话的 hold：放手什么都不做");
  }

  console.log("\n⑥ 后台命令表：每个会话 4 条、全局 8 条、跑完的会被摘掉、日志走写入流");
  {
    const kids = [];
    const start = (session, extra = {}) => CT.bgStart({ command: "x", cwd: WS, logDir: path.join(TMP, "logs"), session, spawnFn: () => { const c = fakeChild(); kids.push(c); return c; }, ...extra });
    const a = [];
    for (let i = 0; i < CT.BG_PER_RUN; i++) a.push(start("P"));
    const overP = start("P");
    ok(a.every((r) => r.id) && overP.error && /这个对话后台已经挂着 4 条/.test(overP.error), "会话 P 挂满 4 条，第 5 条被拒", overP.error);
    const q = start("Q");
    ok(q.id && !q.error, "会话 Q 照样能起（反向对照）", q.error);
    const blank = [];
    for (let i = 0; i < 3; i++) blank.push(start(""));
    const overAll = start("R");
    ok(overAll.error && /后台已经挂着 8 条/.test(overAll.error), "几个会话加起来 8 条：全局安全阀照样拦", overAll.error);
    const killedKids = [];
    const rp = CT.bgReapSession("P", (c) => killedKids.push(c));
    ok(rp.killed.length === 4 && killedKids.length === 4 && killedKids.every((c) => a.some((r) => r.job.child === c)), "bgReapSession('P') 只收 P 的 4 条", rp.killed.map((j) => j.id));
    const r0 = CT.bgReapSession("", (c) => killedKids.push(c));
    ok(r0.killed.length === 0 && killedKids.length === 4, "空会话：一条不收（反向对照）");
    // 让所有假进程说一句话再「退出」，看跑完的会不会被摘掉、攥着的输出放没放
    for (const c of kids) { c.stdout.emit("data", Buffer.from("out\n")); c.emit("close", 0, null); }
    const all = [...a.map((r) => r.job), q.job, ...blank.map((r) => r.job)];
    const now = Date.now();
    const before = CT.bgList().length;
    CT.bgEvict(now);
    ok(all.every((j) => CT.bgList().includes(j) && j.buf === "out\n"), "刚跑完的留着给 shell_output 看，输出也在（反向对照）", { before, after: CT.bgList().length });
    CT.bgEvict(now + CT.BG_DONE_TTL + 1000);
    ok(all.every((j) => !CT.bgList().includes(j)) && all.every((j) => j.buf === ""), "跑完超过 30 分钟：从表里摘掉，输出缓冲也放掉");
    // 数量上限：跑完的最多留 BG_DONE_MAX 条
    const many = [];
    for (let i = 0; i < CT.BG_DONE_MAX + 5; i++) { const r = start("M" + i); many.push(r.job); kids[kids.length - 1].emit("close", 0, null); }
    CT.bgEvict();
    const left = many.filter((j) => CT.bgList().includes(j));
    ok(left.length === CT.BG_DONE_MAX && left.includes(many[many.length - 1]) && !left.includes(many[0]), `跑完的最多留 ${CT.BG_DONE_MAX} 条，先摘最早跑完的`, left.length);

    // 日志：写入流，进程退了之后全文都在
    const w = start("LOG");
    const child = kids[kids.length - 1];
    for (let i = 0; i < 200; i++) child.stdout.emit("data", Buffer.from(`line ${i}\n`));
    child.emit("close", 0, null);
    await until(() => { try { return fs.readFileSync(w.job.logFile, "utf8").includes("line 199"); } catch { return false; } }, 2000);
    const txt = fs.readFileSync(w.job.logFile, "utf8");
    ok(txt.split("\n").filter(Boolean).length === 200, "200 块输出一块不少地落进日志", txt.length);
    const src = fs.readFileSync(mod("code-tools"), "utf8");
    const bgSec = src.slice(src.indexOf("function bgStart"), src.indexOf("function bgReapSession"));
    const syncWrite = /fs\.appendFileSync\(/;
    ok(/fs\.createWriteStream\(/.test(bgSec) && !syncWrite.test(bgSec), "bgStart 里是写入流、没有 fs.appendFileSync(");
    ok(syncWrite.test("if (logFile) try { fs.appendFileSync(logFile, s); } catch {}"), "守卫认得出老写法（反向对照）");
  }

  console.log("\n⑦ 账本认人：启动时刻对不上的不杀；记账进程还活着的不碰");
  {
    // 开机收账那个定时器（加载后 2 秒）先让它跑完，别跟下面的手动调用抢同一批文件
    await wait(Math.max(0, 2300 - (Date.now() - T0)));
    const mk = () => { const c = spawn("sleep", ["30"], { detached: true, stdio: "ignore" }); c.unref(); spawned.add(c.pid); return c.pid; };
    const deadHost = (() => { for (let p = 99990; p > 90000; p--) if (!pidAlive(p)) return p; return 0; })();
    const dir = path.dirname(I.strayFile());
    fs.mkdirSync(dir, { recursive: true });
    const write = (hostPid, hostStart, pgid, lstart) => fs.writeFileSync(path.join(dir, `${hostPid}.json`), JSON.stringify({ host: { pid: hostPid, lstart: hostStart }, strays: [{ pgid, session: "old", command: "sleep 30", members: [{ pid: pgid, lstart, command: "sleep 30" }] }] }));

    const p1 = mk();
    await wait(100);
    write(deadHost, "Thu Jan 1 00:00:00 2026", p1, "Mon Jan 5 00:00:00 2026");
    const k1 = await tools.reapLeftoverStrays();
    await wait(300);
    ok(pidAlive(p1) && k1.length === 0, "账上的启动时刻跟现在这个进程对不上（pid 撞号）：不杀", k1);
    ok(!fs.existsSync(path.join(dir, `${deadHost}.json`)), "那份账本核过就删");

    const p2 = mk();
    await wait(100);
    const host = process.ppid;
    write(host, lstartOf(host), p2, lstartOf(p2));
    const k2 = await tools.reapLeftoverStrays();
    await wait(300);
    ok(pidAlive(p2) && k2.length === 0 && fs.existsSync(path.join(dir, `${host}.json`)), "记账进程还活着（另一个在跑的实例）：它的账不碰（反向对照）", k2);
    fs.rmSync(path.join(dir, `${host}.json`), { force: true });

    write(deadHost, "Thu Jan 1 00:00:00 2026", p2, lstartOf(p2));
    const k3 = await tools.reapLeftoverStrays();
    ok(await until(() => !pidAlive(p2), 3000) && k3.some((e) => e.pgid === p2), "记账进程已经不在、启动时刻也对得上：整组送走", k3);
    ok(pidAlive(p1), "前面那个对不上的还活着（反向对照）");
    try { process.kill(-p1, "SIGKILL"); } catch {}

    // verifiedPgids 纯函数：pid 对上但启动时刻不对 = 不认
    const rows = I.psRows("  501   501 Mon Sep 28 21:13:17 2026     sleep 30\n  777   501 Tue Sep  1 01:02:03 2026     npm run dev\n");
    ok(rows.length === 2 && rows[1].lstart === "Tue Sep 1 01:02:03 2026" && rows[1].command === "npm run dev", "ps 那几列拆得对（单数日期的双空格压成一个）", rows);
    ok(I.verifiedPgids([{ pgid: 501, members: [{ pid: 777, lstart: "Tue Sep 1 01:02:03 2026" }] }], rows).length === 1, "成员 pid + 启动时刻对上：认");
    ok(I.verifiedPgids([{ pgid: 501, members: [{ pid: 777, lstart: "Tue Sep 1 01:02:04 2026" }] }], rows).length === 0, "启动时刻差一秒：不认（反向对照）");
    ok(I.verifiedPgids([{ pgid: 502, members: [{ pid: 777, lstart: "Tue Sep 1 01:02:03 2026" }] }], rows).length === 0, "进程组号不对：不认（反向对照）");
  }

  console.log("\n⑧ 接线：网页对话、IM / 定时任务、命令行三条路都收尾");
  {
    const SRV = fs.readFileSync(entry("server"), "utf8");
    const CLI = fs.readFileSync(entry("cli"), "utf8");
    const chatFinally = (s) => /finally \{[\s\S]{0,400}releaseOwner\(sessionId\)[\s\S]{0,300}releaseRun\(sessionId, \{ browser: false \}\)/.test(s);
    // finally 里除了放手还会收这一趟的空文件夹（settleRunDir），所以只认「finally 一进来先 release()」
    const accounted = (s) => /function accountedRuntime[\s\S]{0,4000}holdRun\(rest\.sessionId\)[\s\S]{0,1500}\} finally \{\s*release\(\);/.test(s);
    const cliRel = (s) => /releaseRun\(sessionId\)/.test(s);
    ok(chatFinally(SRV), "网页对话的 finally：收标签页之后收后台进程");
    ok(accounted(SRV), "IM / 定时任务（accountedRuntime）：hold 住、finally 里放手");
    ok(cliRel(CLI), "命令行每一轮跑完收尾");
    ok(!chatFinally(SRV.replace("releaseRun(sessionId, { browser: false })", "noop()")) && !accounted(SRV.replace(/\} finally \{\s*release\(\);/g, "} finally {")) && !cliRel(CLI.replace(/releaseRun\(sessionId\)/g, "x()")),
      "三条守卫各自认得出漏接（反向对照）");
    // 标签页的闲置关页 / 到顶腾位要认得「还在跑」：网页对话看 activeRuns，IM / 定时任务看 holdRun
    const cdpSpec = JSON.stringify(mod.spec("server", "cdp")).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const activeWired = (s) => new RegExp(`require\\(${cdpSpec}\\)\\.setActivePredicate\\(\\(sid\\) => activeRuns\\.has\\(sid\\) \\|\\| require\\("\\.\\/tools"\\)\\.runHeld\\(sid\\)\\)`).test(s);
    ok(activeWired(SRV), "server.js 把「任务还在跑」接给了 cdp.js");
    ok(!activeWired(SRV.replace("|| require(\"./tools\").runHeld(sid)", "")), "  └ 漏了 IM / 定时任务那半：认得出（反向对照）");
    const rs = tools.TOOL_DEFS.find((t) => t.name === "run_shell");
    ok(rs.input_schema.properties.keep && rs.input_schema.properties.keep.type === "boolean" && /结束/.test(rs.input_schema.properties.background.description), "run_shell 有 keep 参数，background 的说明里写了会被收");
  }

  console.log("\n⑨ 后台命令也记账：服务进程被直接杀掉（不走 exit 收尾），下一个进程开机认得回来收掉");
  {
    // 2026-09-29 复审：服务端在独立进程里，那个进程被 SIGKILL / 崩掉时 hookBgExit、reapStraysAtExit 都不跑。
    // background:true 起的是 detached 的一组，父进程一没就挂到 1 号底下，以前只记在内存里的 bg 表上——
    // 重启出来的进程不认得它，退出应用时扫的进程树里也没有它
    const idOf = (r) => (/(bg\d+)/.exec(r.content) || [])[1];
    const entryOf = (id) => [...I.strays.values()].find((e) => e.bg === id);
    const job = (id) => CT.bgList().find((j) => j.id === id);
    const r = I.startBackground("sleep 30", WS, { sessionId: "T9", actor: "t" }, true);
    const id = idOf(r);
    const j = job(id);
    if (j && j.child && j.child.pid) spawned.add(j.child.pid);
    ok(await until(() => !!entryOf(id), 3000), "后台命令一起来就进了账本", [...I.strays.values()]);
    const e = entryOf(id) || {};
    ok(e.pgid === j.child.pid && e.session === "" && e.members.some((m) => m.pid === j.child.pid && /\d{4}$/.test(m.lstart)), "记的是它自己那一组（pgid = 它的 pid）、会话记空串、成员带启动时刻", e);
    const onDisk = () => { try { return JSON.parse(fs.readFileSync(I.strayFile(), "utf8")).strays.some((s) => s.bg === id); } catch { return false; } };
    ok(await until(onDisk, 2000), "账本落了盘");
    const rr = await tools.releaseRun("T9", { browser: false });
    await wait(200);
    ok(j.exit === undefined && entryOf(id) && !rr.strays.includes(e.pgid), "★反向对照★ keep 的这一条：这一轮收尾不收它，账也还在（会话记空串，reapStrays 认不到）", rr);
    CT.bgKill(id, (c) => { try { process.kill(-c.pid, "SIGTERM"); } catch {} });
    ok(await until(() => j.exit !== undefined && !entryOf(id) && !onDisk(), 3000), "shell_kill 停掉以后账销掉了、盘上也没了", { exit: j.exit, e: entryOf(id) });
    const quick = I.startBackground("true", WS, { sessionId: "T9" }, false);
    const qid = idOf(quick);
    await until(() => job(qid) && job(qid).exit !== undefined, 3000);
    await wait(400);
    ok(!entryOf(qid), "一下就跑完的命令：不留账（ps 那一趟里它就结束了也认得出来）", [...I.strays.values()]);

    // 真崩一次：另起一个 node 当「服务进程」，让它起后台命令、账落盘，然后 SIGKILL 它
    const fake = path.join(TMP, "fake-host.js");
    fs.writeFileSync(fake, `
const tools = require(${JSON.stringify(mod("tools"))});
const I = tools._internals;
(async () => {
  const r = I.startBackground("sleep " + process.env.MK, ${JSON.stringify(WS)}, { sessionId: "crash" }, true);
  const id = (/(bg\\d+)/.exec(r.content) || [])[1];
  for (let i = 0; i < 100; i++) { if ([...I.strays.values()].some((e) => e.bg === id)) break; await new Promise((res) => setTimeout(res, 50)); }
  const e = [...I.strays.values()].find((x) => x.bg === id);
  // 反向对照那一趟：把账抹掉，就是改之前的样子（后台命令只在内存里）
  if (process.env.DROP && e) I.strays.delete(e.pgid);
  await I.saveStrays();
  console.log(JSON.stringify({ pgid: e ? e.pgid : 0 }));
  setInterval(() => {}, 1000);
})();
`);
    const crash = async (drop) => {
      const mk = String(3000 + Math.floor(Math.random() * 999));
      const c = spawn(process.execPath, [fake], { env: { ...process.env, MK: mk, DROP: drop ? "1" : "" }, stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout.on("data", (d) => { out += d; });
      await until(() => /\{"pgid":\d+\}/.test(out), 15000);
      const pgid = Number((/"pgid":(\d+)/.exec(out) || [])[1] || 0);
      if (pgid) spawned.add(pgid);
      const hostFile = path.join(path.dirname(I.strayFile()), `${c.pid}.json`);
      const listed = (() => { try { return JSON.parse(fs.readFileSync(hostFile, "utf8")).strays.some((s) => s.pgid === pgid); } catch { return false; } })();
      c.kill("SIGKILL");
      await new Promise((res) => c.once("exit", res));
      await wait(300);
      const ppid = pgid && pidAlive(pgid) ? Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pgid)], { encoding: "utf8" }).trim()) : -1;
      return { pgid, listed, ppid, hostFile, mk };
    };

    const bad = await crash(true);
    ok(bad.pgid > 0 && !bad.listed && alive(bad.pgid) && bad.ppid === 1, `★反向对照★ 账上没它（改之前）：服务进程一被 SIGKILL，sleep ${bad.mk} 挂到 1 号底下接着活`, bad);
    const kb = await tools.reapLeftoverStrays();
    await wait(400);
    ok(alive(bad.pgid) && !kb.some((x) => x.pgid === bad.pgid), "★反向对照★ 开机收账也收不到它（这就是那个洞）", kb);
    try { process.kill(-bad.pgid, "SIGKILL"); } catch {}

    const good = await crash(false);
    ok(good.pgid > 0 && good.listed && alive(good.pgid) && good.ppid === 1, `账上有它：服务进程被 SIGKILL 的那一刻 sleep ${good.mk} 同样成了孤儿（exit 收尾确实没跑）`, good);
    const kg = await tools.reapLeftoverStrays();
    ok(await until(() => !alive(good.pgid), 3000) && kg.some((x) => x.pgid === good.pgid), "下一个进程开机收账：按账本认回来，整组送走", { kg, alive: alive(good.pgid) });
    ok(!fs.existsSync(good.hostFile), "那份账本核过就删");
  }

  // 兜底：测试起过的都收干净
  for (const g of spawned) { try { process.kill(-g, "SIGKILL"); } catch {} try { process.kill(g, "SIGKILL"); } catch {} }
  for (const j of CT.bgList()) if (j.exit === undefined && j.child && j.child.pid) { try { process.kill(-j.child.pid, "SIGKILL"); } catch {} }
  await wait(100);
  const leftover = [...spawned].filter((g) => alive(g) || pidAlive(g));
  ok(leftover.length === 0, "测试起的进程全收干净了", leftover);
  I.strays.clear();
  await I.saveStrays();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); for (const g of spawned) { try { process.kill(-g, "SIGKILL"); } catch {} } process.exit(1); });
