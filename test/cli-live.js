"use strict";
/**
 * 终端 ↔ 网页那座桥（cli-live.js）的判据测试。
 *
 * 这层的全部意义是「人在外面，用手机接管电脑里正在干活的 agent」。它错了会怎样：
 *   · 判活判错 → 手机上挂着一条永远转圈的假任务，或者正在跑的活儿看不见；
 *   · 插话丢了 → 用户看到「已发送」，终端里那位根本没收到，这比不让插还坏；
 *   · 这层抛异常 → 把终端里真正在跑的任务拖死。这是最不能接受的一种：
 *     一个只为了「让你看见」的旁路，不许有权力弄死正事。
 *
 * 所以下面每节都配反向对照，并且专门有一节把目录做成不可写，证明照样不抛。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// 必须在 require 任何业务模块之前定好数据根：paths.js 是在模块加载时一次性算出来的
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cli-live-"));
process.env.OPENWORKBUDDY_HOME = HOME;
delete process.env.OPENWORKBUDDY_CLI_LIVE;

const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src"); // server / tools / canvas 三组源码的唯一读法，见 test/lib/src.js
const live = require(path.join(ROOT, "cli-live"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

const metaOf = (sid) => JSON.parse(fs.readFileSync(live.fileOf(sid, ".json"), "utf8"));
const writeMeta = (sid, patch) => {
  const m = Object.assign(metaOf(sid), patch);
  fs.writeFileSync(live.fileOf(sid, ".json"), JSON.stringify(m));
  return m;
};
const rowOf = (sid, opt) => live.list(opt).find((r) => r.id === sid) || null;

// ── ① 挂上去就看得见 ───────────────────────────────────────────────────
console.log("\n① 终端起一趟活儿，网页那边看得见");
const h1 = live.announce({ id: "s_one", title: "把日志里的报错归个类", cwd: "/tmp/w", mode: "craft", user: "小林" });
ok(h1.live, "把手是活的");
eq(h1.id, "s_one", "把手记得自己是谁");
const r1 = rowOf("s_one");
ok(!!r1, "列表里有这一条");
eq(r1.title, "把日志里的报错归个类", "标题带过来了");
eq(r1.cwd, "/tmp/w", "工作目录带过来了——手机上要靠它分清是哪台机器的哪个项目");
eq(r1.mode, "craft", "模式带过来了");
eq(r1.user, "小林", "谁起的带过来了");
eq(r1.pid, process.pid, "记的是命令行自己的 pid");
eq(r1.live, true, "刚起就是活的");
eq(r1.died, false, "活着的不算「被强杀」");
eq(r1.endedAt, null, "还没结束");

// ── ② 事件流：一行一个，跟网页那条 SSE 同一种事件 ──────────────────────
console.log("\n② 事件流");
h1.event({ type: "status", text: "开工" });
h1.event({ type: "text", delta: "先看一眼日志" });
h1.event({ type: "tool_use", id: "t1", name: "read_file" });
const got = live.read("s_one", { fromLine: 0 });
eq(got.events.length, 3, "三个事件都在");
eq(got.events[0].type, "status", "顺序没乱：第一条是 status");
eq(got.events[2].name, "read_file", "工具名原样存下来");
ok(got.pos > 0, "回了新的字节位置");
// 反向对照：从第 2 行开始问，只应拿到后面那两条
eq(live.read("s_one", { fromLine: 2 }).events.length, 1, "从第 2 行起只剩 1 条（不是恒返回全部）");
// 按字节接着问：没有新东西就是空
const p2 = got.pos;
eq(live.read("s_one", { fromByte: p2 }).events.length, 0, "没新事件时读回空");
h1.event({ type: "text", delta: "找到了" });
const more = live.read("s_one", { fromByte: p2 });
eq(more.events.length, 1, "追加一条就只多读到这一条");
eq(more.events[0].delta, "找到了", "读到的是新那条");
ok(more.pos > p2, "游标往前走了");
eq(more.reset, false, "文件没被换掉");

// 半行不许交付：命令行正在写的那一行，读的人要等它写完
console.log("\n③ 只写了一半的那行要等");
const half = live.read("s_one", { fromByte: more.pos });
fs.appendFileSync(live.fileOf("s_one", ".ndjson"), '{"type":"status","text":"写了一半');
eq(live.read("s_one", { fromByte: more.pos }).events.length, 0, "半行不交付");
eq(live.read("s_one", { fromByte: more.pos }).pos, more.pos, "游标也不往前挪");
fs.appendFileSync(live.fileOf("s_one", ".ndjson"), '"}\n');
const whole = live.read("s_one", { fromByte: more.pos });
eq(whole.events.length, 1, "补上换行就交付了");
eq(whole.events[0].text, "写了一半", "内容完整");
eq(half.events.length, 0, "（对照）当时确实什么都没读到");

// ── ④ 插话：一条都不许丢，也不许重复交付 ───────────────────────────────
console.log("\n④ 插话");
eq(h1.interjections().length, 0, "一开始没有插话");
ok(live.interject("s_one", "顺手把 500 那类也统计一下"), "网页那边插进去了");
const in1 = h1.interjections();
eq(in1.length, 1, "命令行读到 1 条");
eq(in1[0], "顺手把 500 那类也统计一下", "内容一字不差");
eq(h1.interjections().length, 0, "读过的不再重复交付");
live.interject("s_one", "第二句");
live.interject("s_one", "第三句");
const in2 = h1.interjections();
eq(in2.length, 2, "接着插两条，两条都收到");
eq(in2.join("|"), "第二句|第三句", "顺序是插进去的顺序");
eq(live.interject("s_one", "   "), false, "空白插话不当回事");
eq(live.interject("s_one", ""), false, "空串不当回事");
eq(h1.interjections().length, 0, "（对照）空插话确实没进队列");
// 半行插话也要等：读到一半的那条不许被吞掉
fs.appendFileSync(live.fileOf("s_one", ".in"), '{"at":1,"text":"没写完的');
eq(h1.interjections().length, 0, "半条插话先不交付");
fs.appendFileSync(live.fileOf("s_one", ".in"), '"}\n');
eq(h1.interjections()[0], "没写完的", "补全了才交付——中间那条没被截没");
// 红线：一次读里同时有「写完的」和「正在写的」。
// 读完把文件清空是最顺手的写法，也正是丢话的那个写法——清空的瞬间，
// 那条只写了一半的插话被一起抹掉，用户看到的却是「已发送」。游标往后读才不会。
fs.appendFileSync(live.fileOf("s_one", ".in"), '{"at":2,"text":"这条写完了"}\n{"at":3,"text":"这条刚写一半');
eq(h1.interjections().join("|"), "这条写完了", "整行的先交付");
fs.appendFileSync(live.fileOf("s_one", ".in"), '"}\n');
eq(h1.interjections().join("|"), "这条刚写一半", "同一次读里没写完的那条，下次照样交付得到（没被清空抹掉）");

// ── ⑤ 死活：心跳和 pid 两个都得成立 ────────────────────────────────────
console.log("\n⑤ 判活");
ok(live.isLive(metaOf("s_one"), Date.now()), "刚心跳过 → 活");
ok(!live.isLive(metaOf("s_one"), Date.now() + live.STALE_MS + 1), "超过静默上限 → 死");
ok(!live.isLive(Object.assign(metaOf("s_one"), { endedAt: Date.now() }), Date.now()), "自己收过尾 → 死");
ok(!live.isLive(null, Date.now()), "没有元数据 → 死（不抛）");
// pid 被系统回收给别人：光有心跳不算数
const FAKE_PID = 0x7ffffffe; // 大得不可能被真的分配出去
ok(!live.pidAlive(FAKE_PID), "这个 pid 确实不存在");
ok(live.pidAlive(process.pid), "（对照）自己的 pid 是活的");
ok(!live.pidAlive(0), "pid 0 不算");
ok(!live.pidAlive(-1), "负数不算");
ok(!live.pidAlive("不是数字"), "非数字不算");
ok(!live.isLive({ pid: FAKE_PID, beatAt: Date.now() }, Date.now()),
  "心跳很新但进程没了 → 死（不然会把陌生进程当成你的任务）");

// 心跳断了又没收尾 = 被强杀。如实说，别显示成「跑完了」
const h2 = live.announce({ id: "s_kill", title: "被 kill 掉的那趟" });
h2.event({ type: "status", text: "开工" });
writeMeta("s_kill", { beatAt: Date.now() - live.STALE_MS - 5000 });
const rk = rowOf("s_kill", { prune: false });
eq(rk.live, false, "心跳断了 → 不活");
eq(rk.died, true, "没有收尾记录 → 判为被强杀");
// 反向对照：正常收尾的不算被强杀
const h3 = live.announce({ id: "s_done", title: "正常跑完的那趟" });
h3.finish({});
const rd = rowOf("s_done", { prune: false });
eq(rd.live, false, "收过尾 → 不活");
eq(rd.died, false, "收过尾 → 不是被强杀");
ok(rd.endedAt > 0, "结束时间记下来了");
eq(rd.error, null, "没出错就不留错");
const h4 = live.announce({ id: "s_err", title: "出错那趟" });
h4.finish({ error: "上游 429 了", title: "改过的标题" });
const re = rowOf("s_err", { prune: false });
eq(re.error, "上游 429 了", "错因留下来了——手机上要看得到为什么没跑完");
eq(re.title, "改过的标题", "收尾时能把标题改成模型润色过的那个");

// ── ⑥ 过期清理：不清的话手机上会一直挂着假任务 ─────────────────────────
console.log("\n⑥ 过期清理");
writeMeta("s_done", { endedAt: Date.now() - live.KEEP_MS - 1000, beatAt: Date.now() - live.KEEP_MS - 1000 });
ok(!!rowOf("s_done", { prune: false }), "不清理时还在（对照）");
ok(!rowOf("s_done"), "清理时这条过期的被收走了");
ok(!fs.existsSync(live.fileOf("s_done", ".json")), "文件也删了");
ok(!!rowOf("s_one"), "还活着的那条没被误删");
// 刚跑完的留着：人从手机上点进来还能看见结果
const h5 = live.announce({ id: "s_fresh", title: "刚跑完" });
h5.finish({});
ok(!!rowOf("s_fresh"), "刚结束的保留（保留期内）");

// ── ⑦ 排序 / 丢弃 / 重开一轮 ───────────────────────────────────────────
console.log("\n⑦ 排序、丢弃、重开");
const rows = live.list({ prune: false });
for (let i = 1; i < rows.length; i++) {
  if (rows[i - 1].startedAt < rows[i].startedAt) { fail++; console.log("  ✗ 列表按开始时间倒序"); break; }
  if (i === rows.length - 1) { pass++; console.log("  ✓ 列表按开始时间倒序（新的在上面）"); }
}
live.drop("s_err");
ok(!rowOf("s_err", { prune: false }), "drop 之后列表里没了");
for (const ext of [".json", ".ndjson", ".in"]) {
  ok(!fs.existsSync(live.fileOf("s_err", ext)), `drop 把 ${ext} 也删了`);
}
// 同一个会话再跑一轮：事件流从头来，上一轮的插话不许漏进新一轮
live.interject("s_one", "上一轮没读完的话");
const h1b = live.announce({ id: "s_one", title: "第二轮" });
eq(live.read("s_one", { fromLine: 0 }).events.length, 0, "新一轮的事件流是空的");
eq(h1b.interjections().length, 0, "上一轮残留的插话不会漏进新一轮");
h1b.event({ type: "status", text: "第二轮开工" });
eq(live.read("s_one", { fromLine: 0 }).events.length, 1, "（对照）新一轮的事件照常进来");
// 跟流的人拿着旧游标来问：文件比游标还短 → 告诉他从头再来
const far = live.read("s_one", { fromByte: 999999 });
eq(far.reset, true, "游标越界 → reset，让跟流的人从头读");
eq(far.pos, 0, "reset 时游标归零");

// ── ⑧ 单条事件太大：截断，不撑爆文件，也不整条丢 ───────────────────────
console.log("\n⑧ 超大事件");
h1b.event({ type: "tool_result", id: "big", text: "x".repeat(live.MAX_LINE * 2) });
const evs = live.read("s_one", { fromLine: 0 }).events;
const big = evs[evs.length - 1];
eq(big.type, "tool_result", "类型保住了");
eq(big.id, "big", "id 保住了");
eq(big.truncated, true, "标了「被截断」——界面上要说实话");
ok(big.text.length < live.MAX_LINE + 200, "内容真的被砍短了", big.text.length);
ok(/省略/.test(big.text), "末尾留了一句说明");

// ── ⑨ 这层坏了不许影响任务本身 ─────────────────────────────────────────
console.log("\n⑨ 写不进去也不许抛");
const dir = live.dir();
const mode = fs.statSync(dir).mode;
let readOnlyWorked = true;
try { fs.chmodSync(dir, 0o500); } catch { readOnlyWorked = false; }
if (readOnlyWorked && process.getuid && process.getuid() === 0) readOnlyWorked = false; // root 无视权限位
if (readOnlyWorked) {
  let threw = null;
  try {
    h1b.event({ type: "status", text: "目录只读了" });
    h1b.beat();
    h1b.finish({});
    live.interject("s_never", "写不进去的插话");
    live.list();
    live.read("s_never", { fromLine: 0 });
  } catch (e) { threw = e; }
  ok(!threw, "目录不可写时全线不抛异常", threw && threw.message);
  eq(live.interject("s_new_one", "写不进去"), false, "写不进去就如实返回 false（不骗界面说已发送）");
  fs.chmodSync(dir, mode);
} else {
  pass++; console.log("  ✓ （跳过只读目录那节：这个环境改不动权限位）");
}
// 读一个根本不存在的会话：空结果，不抛
const none = live.read("s_不存在", { fromLine: 0 });
eq(none.events.length, 0, "读不存在的会话回空");
eq(none.reset, false, "也不谎报 reset");
live.drop("s_不存在"); pass++; console.log("  ✓ drop 不存在的会话不抛");

// ── ⑩ 关掉这层：什么都不写，也什么都不报 ───────────────────────────────
console.log("\n⑩ 关掉这层（OPENWORKBUDDY_CLI_LIVE=0）");
process.env.OPENWORKBUDDY_CLI_LIVE = "0";
const off = live.announce({ id: "s_off", title: "关着的时候起的" });
eq(off.live, false, "把手是空的");
ok(!fs.existsSync(live.fileOf("s_off", ".json")), "一个文件都没写");
let offThrew = null;
try { off.event({ type: "status", text: "x" }); off.beat(); off.finish({}); } catch (e) { offThrew = e; }
ok(!offThrew, "空把手上所有方法都能安全调用");
eq(off.interjections().length, 0, "空把手读插话回空数组");
eq(live.interject("s_one", "关着的时候插话"), false, "关着的时候插话直接 false");
process.env.OPENWORKBUDDY_CLI_LIVE = "1";
eq(live.announce({ id: "s_back" }).live, true, "（对照）打开就又能用了");

// ── ⑪ 服务端那四个口子：切 server.js 真源码来跑 ──────────────────────────
/*
 * 上面十节验的是这座桥本身，这节验的是**手机真正打进来的那四个口子**。
 * 单独拎出来测，是因为它们身上挂着一条权限线：终端属于这台机器的主人，
 * 租户账号能看见别人电脑里此刻在跑什么、还能往里插话，是实打实的越权。
 *
 * server.js 是 require 就监听端口的，起不了进程内 HTTP；但这四个处理函数是纯的，
 * 把 app / lanes / cliLive / isPlatformOwner 注进去就能照着真源码跑。
 */
console.log("\n⑪ 服务端六个口子（/api/lanes · /api/cli/live · stream · interject · pending · answer）");
{
  const srcAll = src("server");
  // 从 canRemoteControl 那两行切起、而不是从第一个路由切起：那两行才是「主人 + 后台开关」
  // 合成一道闸的地方，跟着一起跑进来，测的就是真的判断，不是我在测试里重写一遍
  const a0 = srcAll.indexOf("const canRemoteControl = (req)");
  // 只切这两行，别把它俩和路由之间那段（挂后台路由的）也拖进来
  const a1 = srcAll.indexOf("\n\n", a0);
  const a = srcAll.indexOf('app.get("/api/lanes", (req, res) => {');
  const b = srcAll.indexOf('app.get("/api/thinking"', a);
  ok(a0 >= 0 && a1 > a0 && a1 < a, "在 server.js 里定位到了 canRemoteControl / cliOffReason");
  ok(/cliOffReason/.test(srcAll.slice(a0, a1)), "切出来的那段里得有 cliOffReason，不然拒绝理由那几条验的是空气");
  ok(a >= 0 && b > a, "在 server.js 里定位到了这六个口子的真源码");

  const routes = [];
  const fakeApp = {
    get: (p2, h) => routes.push({ m: "GET", p: p2, h }),
    post: (p2, h) => routes.push({ m: "POST", p: p2, h }),
  };
  let owner = true;   // 这一节里用它开关「你是不是这台机器的主人」
  let remoteOn = true; // 这个开关是「后台允不允许远程操控终端任务」（org 设置，默认关）
  // account 也得注：canRemoteControl 里要问它开关开没开。给个只认这一个键的替身，
  // 比拉起真的组织表干净，也让下面能把开关拨来拨去
  new Function("app", "lanes", "cliLive", "isPlatformOwner", "account", srcAll.slice(a0, a1) + "\n" + srcAll.slice(a, b))(
    fakeApp, require(path.join(ROOT, "lanes")), live, () => owner, { remoteAllowed: () => remoteOn });
  const routeOf = (m, p2) => (routes.find((r) => r.m === m && r.p === p2) || {}).h;
  eq(routes.length, 6, "六个口子一个不少");

  // 极简 res/req 替身：只记下处理函数真做了什么
  const mkRes = () => {
    const r = { code: 200, body: null, headers: {}, chunks: [], ended: false };
    r.status = (c) => { r.code = c; return r; };
    r.json = (o) => { r.body = o; return r; };
    r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
    r.write = (t) => { r.chunks.push(t); return true; };
    r.end = () => { r.ended = true; };
    r.on = () => r;
    return r;
  };
  const mkReq = (o) => {
    const hooks = {};
    return Object.assign({ params: {}, query: {}, body: {}, on: (k, f) => { hooks[k] = f; }, __hooks: hooks }, o);
  };
  const call = (h, req) => { const res = mkRes(); h(req, res); return res; };

  // 干净的起点：把前面几节留下的都收走，只留这一节自己摆的两条
  for (const r of live.list({ prune: false })) live.drop(r.id);
  const hRun = live.announce({ id: "srv_run", title: "终端里正在跑的那趟", cwd: "/tmp/proj", mode: "craft" });
  hRun.event({ type: "status", text: "第一句" });
  hRun.event({ type: "text", delta: "第二句" });
  const hDone = live.announce({ id: "srv_done", title: "刚跑完的那趟" });
  hDone.finish({});

  // ---- /api/lanes ----
  const lanesH = routeOf("GET", "/api/lanes");
  ok(!!lanesH, "/api/lanes 挂上了");
  owner = true;
  let r = call(lanesH, mkReq({ user: { username: "小林" } }));
  eq(r.code, 200, "主人问工作线：200");
  eq(r.body.lanes.length, 2, "两条线都给了");
  eq(r.body.lanes.map((l) => l.id).join(","), "office,cli", "顺序是办公在前——侧栏第一个标签是默认那条");
  ok(r.body.lanes.every((l) => l.name && l.hint), "门面话术（名字 / 一句话说明）都带上了");
  ok(!("engine" in r.body.lanes[1]) && !("install" in r.body.lanes[1]) && !r.body.cliEngine,
    "工作线里没有引擎字段——这是那条越权 bug 的看门狗：标签不许决定用谁的模型");
  eq(r.body.current, "office", "没记过线的老会话回落到办公");
  eq(r.body.cliRunning, 1, "终端里正在跑的趟数：1（刚跑完那条不算）");
  eq(r.body.cliLive.length, 2, "正在跑的和刚跑完的都列出来（手机上点进去还能看最后一屏）");

  // 反向对照：换个租户成员来问，门面话术照给，终端那份一个字节都不给
  owner = false;
  r = call(lanesH, mkReq({ user: { username: "同事" } }));
  eq(r.body.lanes.length, 2, "租户成员照样看得见两条线（不然他那边标签整个画不出来）");
  eq(r.body.cliLive.length, 0, "租户成员看不到别人电脑终端里在跑什么");
  eq(r.body.cliRunning, 0, "连「有几趟」这个数字都不给");

  // ---- /api/cli/live ----
  const liveH = routeOf("GET", "/api/cli/live");
  owner = true;
  r = call(liveH, mkReq({ user: { username: "小林" } }));
  eq(r.body.allowed, true, "主人问：allowed=true");
  eq(r.body.rows.length, 2, "两条都在");
  eq(r.body.staleMs, live.STALE_MS, "把「多久没心跳算死」的口径也告诉前端，省得两边各写一个数");
  owner = false;
  r = call(liveH, mkReq({ user: { username: "同事" } }));
  eq(r.code, 200, "租户成员这儿回的是 200 不是 403");
  eq(r.body.allowed, false, "但明说 allowed=false —— 前端靠它彻底停掉轮询，不是每 3 秒撞一次墙");
  eq(r.body.rows.length, 0, "一条都不给");

  // ---- /api/cli/stream/:id ----
  const streamH = routeOf("GET", "/api/cli/stream/:id");
  owner = false;
  r = call(streamH, mkReq({ user: { username: "同事" }, params: { id: "srv_run" } }));
  eq(r.code, 403, "租户成员跟不了终端里的直播");
  owner = true;
  r = call(streamH, mkReq({ user: { username: "小林" }, params: { id: "srv_没这趟" } }));
  eq(r.code, 404, "跟一趟根本不存在的：404，不是空流让人干等");
  const sreq = mkReq({ user: { username: "小林" }, params: { id: "srv_run" } });
  r = call(streamH, sreq);
  eq(r.headers["content-type"], "text/event-stream; charset=utf-8", "是 SSE 不是 JSON");
  eq(r.chunks.length, 2, "先把已经发生的两个事件补上（跟 /api/chat/stream 一个口径）");
  ok(/第一句/.test(r.chunks[0]) && /第二句/.test(r.chunks[1]), "补的就是终端里那两句，顺序没乱");
  // from=1：已经看过第一个了，只补后面的
  const sreq2 = mkReq({ user: { username: "小林" }, params: { id: "srv_run" }, query: { from: "1" } });
  const r2 = call(streamH, sreq2);
  eq(r2.chunks.length, 1, "带 from 续流时不重发看过的那些");
  ok(/第二句/.test(r2.chunks[0]), "续上的是第二句");
  ok(typeof sreq.__hooks.close === "function", "挂了 close 回调——手机切后台/断网时定时器要停，不然进程里攒一堆");
  sreq.__hooks.close(); sreq2.__hooks.close(); // 收摊，别让 400ms 的轮询把测试挂住

  // ---- /api/cli/interject ----
  const injH = routeOf("POST", "/api/cli/interject");
  owner = false;
  r = call(injH, mkReq({ user: { username: "同事" }, body: { sessionId: "srv_run", message: "偷偷插一句" } }));
  eq(r.code, 403, "租户成员插不上话");
  owner = true;
  r = call(injH, mkReq({ body: { sessionId: "srv_run", message: "   " } }));
  eq(r.code, 400, "空消息当场挡下");
  r = call(injH, mkReq({ body: { sessionId: "srv_没这趟", message: "在吗" } }));
  eq(r.code, 404, "插给一趟不存在的：404");
  r = call(injH, mkReq({ body: { sessionId: "srv_done", message: "顺便再改个需求" } }));
  eq(r.code, 409, "已经跑完的那趟：明说没人接，不许回 ok 让界面显示「已发送」");
  r = call(injH, mkReq({ body: { sessionId: "srv_run", message: "标题换成《九月复盘》" } }));
  eq(r.code, 200, "正在跑的那趟：插得进去");
  eq(r.body.ok, true, "回 ok");
  eq(hRun.interjections().join("|"), "标题换成《九月复盘》",
    "命令行那头真读到了这句——这一条才是「人在外面用手机改需求」的全部意义");
  eq(hRun.interjections().length, 0, "同一句不会被读第二遍");

  // ---- /api/cli/pending + /api/cli/answer ----
  // 这两条是「人不在电脑前」那条线的全部：终端里等回答是卡住不动直到超时，
  // 而超时对一道选择题来说就是替人选了。手机上答得了，这件事才不成立。
  const pendH = routeOf("GET", "/api/cli/pending");
  const ansH = routeOf("POST", "/api/cli/answer");
  ok(!!pendH && !!ansH, "pending / answer 两条都挂上了");

  hRun.pend({ id: "q1", at: Date.now(), kind: "ask", question: "交 Word 还是 PDF？",
    options: [{ label: "Word", detail: "可继续编辑" }, { label: "PDF", detail: "版式固定" }] });

  owner = false;
  r = call(pendH, mkReq({ query: { sessionId: "srv_run" } }));
  eq(r.body.allowed, false, "租户成员看不见终端里的题");
  eq(r.body.rows.length, 0, "而且一条都不给");
  r = call(ansH, mkReq({ body: { sessionId: "srv_run", askId: "q1", value: "1" } }));
  eq(r.code, 403, "更答不了");
  owner = true;

  r = call(pendH, mkReq({ query: { sessionId: "srv_run" } }));
  eq(r.code, 200, "主人问：200");
  eq(r.body.rows.length, 1, "看见了那道题");
  eq(r.body.rows[0].question, "交 Word 还是 PDF？", "题面原样带过来");
  eq(r.body.rows[0].options.length, 2, "选项也带过来了——只给题面的话，「Word / PDF」在手机上就是两个没差别的词");
  eq(r.body.rows[0].sessionId, "srv_run", "标了是哪一趟的题：不带这个，手机上答完不知道往哪儿送");

  r = call(pendH, mkReq({}));
  eq(r.body.rows.length, 1, "不指定哪一趟时，把所有还活着的题一起给（手机上那一屏就是这么画的）");

  r = call(ansH, mkReq({ body: { sessionId: "srv_run", value: "1" } }));
  eq(r.code, 400, "不说答的是哪道题：当场挡下");
  r = call(ansH, mkReq({ body: { sessionId: "srv_没这趟", askId: "q1", value: "1" } }));
  eq(r.code, 404, "答一趟不存在的：404");
  r = call(ansH, mkReq({ body: { sessionId: "srv_done", askId: "q1", value: "1" } }));
  eq(r.code, 409, "已经跑完的那趟：明说没人接");
  r = call(ansH, mkReq({ body: { sessionId: "srv_run", askId: "q-别的题", value: "1" } }));
  eq(r.code, 409, "答一道没在等的题：不许回 ok。界面上显示「已提交」而其实没人收，比说送不到糟得多");

  r = call(ansH, mkReq({ body: { sessionId: "srv_run", askId: "q1", value: "2" } }));
  eq(r.code, 200, "答一道正在等的题：送得出去");
  eq(hRun.answers().map((a) => a.id + "=" + a.value).join("|"), "q1=2",
    "命令行那头真收到了——这一条才是「人在会议室里把电脑上那道题答了」的全部意义");
  eq(hRun.answers().length, 0, "同一个答案不会被读第二遍");

  // ---- 后台那个开关（remote_control，默认关）----
  // 这一节验的是「关掉之后这六条真的全闭」。分开两道闸的意义就在这儿：你是主人，
  // 但这台机器现在不对外开这个口子——两件事，两句不一样的拒绝话
  remoteOn = false;
  owner = true;
  eq(call(routeOf("GET", "/api/cli/live"), mkReq({})).body.allowed, false, "开关关掉：主人自己也看不到终端里在跑什么");
  eq(call(routeOf("GET", "/api/cli/live"), mkReq({})).body.remote_off, true, "而且说清楚了是被开关关掉的，不是「你没权限」");
  eq(call(routeOf("GET", "/api/lanes"), mkReq({})).body.cliRunning, 0, "工作线那条也一起闭：不然侧栏还亮着「1 趟在跑」，点进去却是空的");
  eq(call(streamH, mkReq({ params: { id: "srv_run" }, query: {} })).code, 403, "跟流：403");
  eq(call(injH, mkReq({ body: { sessionId: "srv_run", message: "插一句" } })).code, 403, "插话：403");
  eq(call(pendH, mkReq({})).body.allowed, false, "看题：不给");
  eq(call(ansH, mkReq({ body: { sessionId: "srv_run", askId: "q2", value: "1" } })).code, 403, "答题：403");
  // 认的是页面名而不是整句话：句子会改，但「去哪一页打开」这件事得一直在。
  // 顺带钉死菜单名——以前这句指的是「公司设置 → 安全」，而侧栏里根本没有这两级
  ok(/客户端安全/.test(call(injH, mkReq({ body: { sessionId: "srv_run", message: "x" } })).body.error),
    "★拒绝的理由得告诉人去哪儿打开★（说成「只有主人能插话」的话，主人本人会以为是程序坏了；指到一个不存在的菜单上也一样白说）");
  owner = false;
  ok(/只有这台机器的主人/.test(call(injH, mkReq({ user: { username: "同事" }, body: { sessionId: "srv_run", message: "x" } })).body.error),
    "★反向★ 不是主人的那句话不变：两种拒绝不能混成同一句");
  // 摆回原样，免得这一节的状态漏给后面
  remoteOn = true; owner = true;
  eq(call(routeOf("GET", "/api/cli/live"), mkReq({})).body.allowed, true, "开关拨回来，口子照常开");

  // 终端那边答完自己撤题。撤了之后手机上再点就该被挡下，而不是石沉大海
  hRun.unpend("q1");
  r = call(pendH, mkReq({ query: { sessionId: "srv_run" } }));
  eq(r.body.rows.length, 0, "撤下之后手机上那道题就没了");
  r = call(ansH, mkReq({ body: { sessionId: "srv_run", askId: "q1", value: "1" } }));
  eq(r.code, 409, "终端里先答了，手机上再答一次：说清楚已经答过了");

  // 收尾时必须清干净：留着的话手机上会一直挂着一道没人接的题
  hRun.pend({ id: "q2", at: Date.now(), kind: "ask", question: "还要继续吗？", options: [] });
  eq(call(pendH, mkReq({ query: { sessionId: "srv_run" } })).body.rows.length, 1, "又摆了一道");
  hRun.finish({});
  eq(call(pendH, mkReq({ query: { sessionId: "srv_run" } })).body.rows.length, 0,
    "跑完了就一道不剩——不清的话手机上留着一道点了不会有任何反应的题");
}

console.log("\n⑫ 等回答这件事，出了岔子也不许把正事拖死");
{
  for (const r of live.list({ prune: false })) live.drop(r.id);
  const h = live.announce({ id: "ask_robust", title: "等回答", cwd: "/tmp" });

  // 进程不活着就一律当没有：Ctrl-C 之后 .ask.json 还躺在盘上，照着画就是给人一道
  // 点了不会有反应的题——比不显示更糟
  h.pend({ id: "z1", at: Date.now(), kind: "ask", question: "在吗", options: [] });
  eq(live.pending("ask_robust").length, 1, "活着的时候看得见");
  writeMeta("ask_robust", { pid: 999999999, beatAt: Date.now() - 10 * 60 * 1000 });
  eq(live.pending("ask_robust").length, 0, "进程没了/心跳停了：一道都不给，不摆死题");

  // 坏数据
  fs.writeFileSync(live.fileOf("ask_robust", ".ask.json"), "{不是 JSON");
  eq(live.pending("ask_robust").length, 0, "文件坏了也只是没有题，不抛");
  eq(live.pending("从来没有过这趟").length, 0, "根本不存在的会话：空数组，不抛");

  eq(live.answer("ask_robust", "z1", "x"), true, "正常情况下写得进去");
  eq(live.answer("ask_robust", "", "x"), false, "没有题号：直接说没送出去，不瞎写一行");
  eq(live.answer("ask_robust", null, "x"), false, "题号是 null 也一样");

  // 这是个只为了「让你在手机上也能答」的旁路，不许有权力弄死终端里正在跑的正事。
  // 盘上那几个文件全删掉，模拟目录被清/权限没了，再把整套动作过一遍：只许返回空/false，不许抛
  for (const ext of [".ask.json", ".ans", ".json"]) {
    try { fs.rmSync(live.fileOf("ask_robust", ext), { force: true }); } catch {}
  }
  let threw = null;
  try {
    h.pend({ id: "z2", at: Date.now(), kind: "ask", question: "在吗", options: [] });
    h.unpend("z2");
    h.answers();
    live.pending("ask_robust");
    live.answer("ask_robust", "z2", "x");
  } catch (e) { threw = e; }
  ok(!threw, "元信息文件都没了，整套动作走一遍照样不抛", threw && String(threw.message));
}

// ---------- get(id)：按 id 取一行，别为了一行把整个目录读一遍 ----------
// 手机上看终端镜像那条流是 400ms 一拍、一拍调两次。原来每次都是
// `list({prune:false}).find(r => r.id === sid)`——readdir 整个目录 + 把每一趟的 meta 都 parse 一遍，
// 只为了拿一个**已经知道 id** 的行。这里钉两件事：
//   1) get 出来的那一行跟 list 里对应的那一行逐字段一致（含 live / died 这两个最容易两边跑偏的）；
//   2) 查不到 / id 里带路径分隔符时给 null，不抛也不越出目录。
{
  const now = Date.now();
  for (const [id, meta] of [
    ["g_run", { pid: process.pid, title: "跑着的", cwd: "/tmp", mode: "craft", user: "boss", startedAt: now - 3000, beatAt: now }],
    ["g_done", { pid: process.pid, title: "跑完的", cwd: "/tmp", mode: "craft", user: "boss", startedAt: now - 5000, beatAt: now - 900, endedAt: now - 800 }],
    ["g_killed", { pid: process.pid, title: "被强杀的", cwd: "/tmp", mode: "craft", user: "boss", startedAt: now - 9e5, beatAt: now - 9e5 }],
  ]) fs.writeFileSync(live.fileOf(id, ".json"), JSON.stringify(meta));

  const rows = live.list({ prune: false, now });
  let same = 0;
  for (const r of rows) {
    if (JSON.stringify(live.get(r.id, { now })) === JSON.stringify(r)) same++;
    else ok(false, "get 和 list 对不上：" + r.id, JSON.stringify(r) + " vs " + JSON.stringify(live.get(r.id, { now })));
  }
  ok(same === rows.length && rows.length >= 3, `get 出来的 ${same} 行跟 list 逐字段一致（跑着的/跑完的/被强杀的都在）`);
  eq(live.get("g_killed", { now }).died, true, "被强杀的那条，get 也要如实说 died——两边判法不许跑偏");
  eq(live.get("g_run", { now }).live, true, "跑着的那条在 get 里成了「没跑」");
  eq(live.get("根本没这趟", { now }), null, "查不到就给 null");
  eq(live.get("../../etc/passwd", { now }), null, "id 里带路径分隔符，不许顺着爬出目录");
  eq(live.get("", { now }), null, "空 id 给 null");
  for (const id of ["g_run", "g_done", "g_killed"]) try { fs.rmSync(live.fileOf(id, ".json"), { force: true }); } catch {}
}

// 收摊
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1); // 少了这一行，这个套件挂了也是绿的——CI 看的是退出码，不是这段话
