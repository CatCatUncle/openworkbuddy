"use strict";
/**
 * 运行状况那一套：日志（log.js）、指标与告警（metrics.js）、分片用量账本（usage-store.js）。
 *
 * 跑法：node test/ops.js
 * 用临时目录，绝不碰真日志、真账本。
 *
 * 这三个模块的共同点是**平时没人看**。正因为没人看，它们坏了也不会有人发现——
 * 等到真出事那天去翻，才发现日志停在三周前、告警一条没发过、账本少了一个月。
 * 所以这个套件盯的全是「悄悄坏掉」那一类：
 *
 *   1. 日志不能把程序搞挂：字段里塞个循环引用、塞个 Error、塞 200 KB 字符串，都得活着回来
 *   2. 日志不能把盘写满：过期文件真的删，且只删自己那一批（boot.log 之类不许碰）
 *   3. 失败率没跑任务时是 0，不是 NaN —— NaN 会让所有比较都变成 false，
 *      看着像「一切正常」，其实是这一格根本没算出来
 *   4. 告警不能刷屏：冷却期内闭嘴；但**恢复了必须说一声**，只报警不报恢复的系统没人看
 *   5. 告警状态要落盘：崩溃重启循环里，内存状态每次都是空的，于是每重启一次就重报一次
 *   6. 账本断电断在半行，不能让整个月的账都读不出来
 *   7. 账本按月分片之后，「查本月」不该被三年历史拖慢，「翻旧账」也不该翻不到
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ops-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
process.env.OPENWORKBUDDY_LOG_DIR = path.join(TMP, "logs");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.OPENWORKBUDDY_LOG_DIR, { recursive: true });

const ROOT = path.join(__dirname, "..");
// 这三个模块都在 require 的那一刻把目录算好，所以环境变量必须在上面就设好
const log = require(path.join(ROOT, "log"));
const metrics = require(path.join(ROOT, "metrics"));
const usage = require(path.join(ROOT, "usage-store"));

const LOG_DIR = log._internals.DIR;
const DATA_DIR = process.env.OPENWORKBUDDY_DATA_DIR;

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};
const eq = (got, want, msg) => ok(got === want, msg, { got, want });

const today = log._internals.today();
const readLog = (day) => {
  try { return fs.readFileSync(log._internals.fileOf(day || today), "utf8").split("\n").filter(Boolean); }
  catch { return []; }
};
const wipeLog = () => { try { fs.rmSync(log._internals.fileOf(today), { force: true }); } catch {} };

// ==========================================================================
console.log("\n【1】日志：写得进去、级别拦得住");
// ==========================================================================
{
  wipeLog();
  log.setLevel("info");
  log.debug("t", "这条不该出现");
  log.info("t", "开工", { task_id: "a1", ms: 12 });
  let lines = readLog();
  eq(lines.length, 1, "默认不记 debug（它的量比其它三种加起来还大）");
  const row = JSON.parse(lines[0]);
  eq(row.level, "info", "级别记下了");
  eq(row.mod, "t", "模块记下了——排查时第一个用来过滤的就是它");
  eq(row.msg, "开工", "正文记下了");
  eq(row.task_id, "a1", "结构化字段原样带着");
  eq(row.ms, 12, "数字保持数字，没被 String 掉");
  ok(!Number.isNaN(Date.parse(row.ts)), "时间戳是个能解析的 ISO 串", row.ts);

  eq(log.setLevel("debug"), "debug", "setLevel 返回改完之后的级别");
  log.debug("t", "现在该出现了");
  eq(readLog().length, 2, "调到 debug 之后就记了");
  eq(log.setLevel("根本没这个级别"), "debug", "写歪了不改，保持原样（不是悄悄退回 info）");
  log.setLevel("info");
}

// ==========================================================================
console.log("\n【2】日志：怎么塞都不许把程序搞挂");
// ==========================================================================
{
  wipeLog();
  const circ = { name: "环" }; circ.self = circ;
  let threw = false;
  try { log.info("t", "循环引用", { bad: circ }); } catch { threw = true; }
  ok(!threw, "字段里塞循环引用不抛错（JSON.stringify 挂在 try 里）");
  eq(readLog().length, 0, "而且没往文件里写半行坏数据");

  log.info("t", "带错误", { err: new Error("炸了") });
  const r1 = JSON.parse(readLog()[0]);
  eq(r1.err, "炸了", "Error 对象存的是 message，不是 {}");

  log.info("t", "超长字段", { big: "x".repeat(50000) });
  const r2 = JSON.parse(readLog()[1]);
  eq(r2.big.length, 2000, "超长字符串截到 2000（一条日志再重要也不值得写进去 200 KB）");

  log.info("t", "有个 undefined", { a: 1, b: undefined });
  const r3 = JSON.parse(readLog()[2]);
  ok(!("b" in r3), "值是 undefined 的字段直接不写");

  // 出错和警告照旧打到终端：开发时盯着终端的人不该因为「现在有日志文件了」反而看不见
  const realErr = console.error; let sawConsole = false;
  console.error = () => { sawConsole = true; };
  try { log.error("t", "严重问题"); } finally { console.error = realErr; }
  ok(sawConsole, "error 同时打到终端");
  eq(readLog().length, 4, "而且文件里也有");
}

// ==========================================================================
console.log("\n【3】日志：读得出来、筛得动、烂行不致命");
// ==========================================================================
{
  wipeLog();
  const realErr2 = console.error, realWarn2 = console.warn;
  console.error = console.warn = () => {};   // 这一段会写 warn/error，别把它们打进测试输出里
  log.info("chat", "第一条", { user: "xiaozhang" });
  log.warn("im", "第二条", { user: "xiaoli" });
  log.error("chat", "第三条");
  log.info("chat", "第四条");
  console.error = realErr2; console.warn = realWarn2;
  // 断电断在最后一行中间——崩的那一刻文件就长这样：前面都是好的，末尾挂着半行
  fs.appendFileSync(log._internals.fileOf(today), '{"ts":"2026-09-17T00:00:00.000Z","level":"info","msg":"半', "utf8");

  const all = log.tail({});
  eq(all.length, 4, "半行被跳过，其余四条照读——这正是 JSONL 相对于「一个大 JSON」的好处");
  eq(all[0].msg, "第四条", "新的在前");
  eq(log.tail({ level: "warn" }).length, 2, "按级别筛是「这个级别**及以上**」（warn + error）");
  eq(log.tail({ level: "error" }).length, 1, "只要 error 就只有一条");
  eq(log.tail({ q: "xiaoli" }).length, 1, "关键词在字段里也搜得到，不只搜正文");
  eq(log.tail({ q: "chat" }).length, 3, "模块名也能当关键词");
  eq(log.tail({ limit: 2 }).length, 2, "limit 管用");
  eq(log.tail({ day: "2019-01-01" }).length, 0, "查一个没有日志的日子返回空数组，不抛错");
}

// ==========================================================================
console.log("\n【4】日志：不许悄悄把盘写满（这是桌面软件最常见的死法）");
// ==========================================================================
{
  const old = path.join(LOG_DIR, "app-2020-01-01.jsonl");
  const other = path.join(LOG_DIR, "boot.log");
  fs.writeFileSync(old, "老日志\n");
  fs.writeFileSync(other, "启动日志\n");
  const yesterday = new Date(Date.now() - 86400000);
  const yName = `app-${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}.jsonl`;
  fs.writeFileSync(path.join(LOG_DIR, yName), "昨天的\n");

  log._internals.pruneOld();
  ok(!fs.existsSync(old), "过期的日志文件删掉了");
  ok(fs.existsSync(path.join(LOG_DIR, yName)), "保留期内的没动");
  ok(fs.existsSync(other), "不是自己那批的文件一根汗毛都不许碰（boot.log 还在）");

  const d = log.days();
  ok(d.includes(today), "days() 列得出今天");
  ok(!d.includes("boot"), "而且只认 app-日期.jsonl 这个名字", d);
  eq(d.join(",") , d.slice().sort().reverse().join(","), "新的在前（日期下拉框直接用）");
}

// ==========================================================================
console.log("\n【5】指标：这一分钟发生了什么");
// ==========================================================================
{
  metrics.bump("tasks", 10);
  metrics.bump("tasks_failed", 4);
  metrics.bump("tokens", 1234);
  metrics.observe("task", 100);
  metrics.observe("task", 200);
  metrics.observe("task", 9000);
  metrics.observe("task", "不是数字");
  const s = metrics.snapshot();
  eq(s.tasks, 10, "计数滚进快照了");
  eq(s.tasks_failed, 4, "失败数也是");
  eq(s.task_fail_rate, 0.4, "失败率算对了");
  eq(s.tokens, 1234, "token 数也滚进来了");
  ok(s.task_p50_ms >= 100 && s.task_p50_ms <= 200, "P50 在样本中间", s.task_p50_ms);
  eq(s.task_p95_ms, 9000, "P95 抓得住那个卡到 9 秒的——平均数会把它抹平，而用户抱怨的正是它");
  ok(s.disk_free_pct > 0 && s.disk_free_pct <= 1, "磁盘余量是个 0-1 的比例", s.disk_free_pct);
  ok(typeof s.rss_mb === "number" && s.rss_mb > 0, "内存占用有值");

  const s2 = metrics.snapshot();
  eq(s2.tasks, 0, "写完一次就清零：每行记的是「这一分钟的增量」，累计值会被重启弄出假断崖");
  eq(s2.task_fail_rate, 0, "没跑过任务时失败率是 0，**不是 NaN**——NaN 会让所有比较变成 false，看着像一切正常");
  ok(!Number.isNaN(s2.task_fail_rate), "再确认一遍它不是 NaN");
  eq(s2.task_p95_ms, 0, "没样本时分位数是 0，不是 undefined");

  for (let i = 0; i < 600; i++) metrics.observe("burst", i);
  const s3 = metrics.snapshot();
  ok(s3.task_p95_ms === 0, "别的桶不影响 task 这一桶");
  eq(metrics._internals.pct([], 0.5), 0, "空数组求分位数是 0");
}

// ==========================================================================
console.log("\n【6】指标：从现有文件里读出来的那几格");
// ==========================================================================
{
  fs.writeFileSync(path.join(DATA_DIR, "model_health.json"), JSON.stringify({
    "挂了的渠道": { recent: [true, true, false, false, false, false, false] },
    "好着的渠道": { recent: [false, false, true, true] },
    "刚挂一次的": { recent: [true, false] },
  }));
  const st = metrics._internals.channelStreaks();
  eq(st["挂了的渠道"], 5, "连挂次数从尾巴往回数");
  ok(!("好着的渠道" in st), "最近一次是成功的就不算连挂（哪怕前面挂过）");
  eq(st["刚挂一次的"], 1, "刚挂一次也算，只是够不到告警门槛");

  const now = Date.now();
  fs.writeFileSync(path.join(DATA_DIR, "audit.json"), JSON.stringify([
    { ts: new Date(now - 7200000).toISOString(), action: "拦下：rm -rf" },
    { ts: new Date(now - 1000).toISOString(), action: "拦下：改系统文件" },
    { ts: new Date(now - 500).toISOString(), action: "放行" },
  ]));
  eq(metrics._internals.auditBlocked(now - 60000), 1, "只数窗口内被拦的那几条（走出窗口就停，不扫全表）");
  eq(metrics._internals.auditBlocked(now - 86400000), 2, "把窗口放大就数得到两条");

  fs.rmSync(path.join(DATA_DIR, "model_health.json"), { force: true });
  eq(Object.keys(metrics._internals.channelStreaks()).length, 0, "文件不在就返回空表，不抛错");
  fs.rmSync(path.join(DATA_DIR, "audit.json"), { force: true });
  eq(metrics._internals.auditBlocked(0), 0, "审计文件不在也返回 0");
}

// ==========================================================================
console.log("\n【7】指标：按月分片写读，老片自己滚掉");
// ==========================================================================
{
  const DIR = metrics._internals.DIR;
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  metrics.write({ ts: "2026-08-15T10:00:00.000Z", tasks: 1 });
  metrics.write({ ts: "2026-09-01T10:00:00.000Z", tasks: 2 });
  metrics.write({ ts: "2026-09-02T10:00:00.000Z", tasks: 3 });
  ok(fs.existsSync(path.join(DIR, "2026-08.jsonl")), "按「年-月」分片落盘");
  ok(fs.existsSync(path.join(DIR, "2026-09.jsonl")), "跨月自动开新片");

  const all = metrics.read({});
  eq(all.length, 3, "读得回来");
  eq(all[0].tasks, 1, "老的在前——画折线图要的就是这个顺序");
  eq(all[2].tasks, 3, "新的在后");
  eq(metrics.read({ from: "2026-09-01" }).length, 2, "按起点筛");
  eq(metrics.read({ to: "2026-08-31" }).length, 1, "按终点筛");
  eq(metrics.read({ limit: 1 })[0].tasks, 3, "limit 留的是最近那几条");

  // 超过保留月数的自己滚掉
  for (const m of ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"]) {
    fs.writeFileSync(path.join(DIR, m + ".jsonl"), JSON.stringify({ ts: m + "-01T00:00:00.000Z" }) + "\n");
  }
  metrics.write({ ts: "2026-09-03T10:00:00.000Z", tasks: 4 });
  const left = metrics._internals.shards();
  eq(left.length, metrics._internals.KEEP_MONTHS, "只留最近 6 片");
  ok(!left.includes("2025-01"), "最老的那几片滚掉了", left);
  ok(left.includes("2026-09"), "当月这片当然还在");

  fs.appendFileSync(path.join(DIR, "2026-09.jsonl"), '{"ts":"2026-09-04T00:00:00.000Z","tas');
  ok(metrics.read({ from: "2026-09" }).length >= 2, "半行不影响这一片其它行");
}

// ==========================================================================
console.log("\n【8】告警：该响的响，响过了闭嘴，恢复了说一声");
// ==========================================================================
{
  const STATE = metrics._internals.STATE_FILE;
  fs.rmSync(STATE, { force: true });
  const bad = { ts: "2026-09-17T10:00:00.000Z", tasks: 10, tasks_failed: 6, task_fail_rate: 0.6, disk_free_pct: 1, rss_mb: 100, channel_fail_streak: {} };
  const good = { ...bad, tasks: 10, tasks_failed: 0, task_fail_rate: 0 };
  const t0 = Date.parse(bad.ts);

  let a = metrics.evaluate(bad, t0);
  eq(a.length, 1, "失败率 60%：报一条");
  eq(a[0].level, "alert", "是告警");
  eq(a[0].id, "task_fail_rate", "规则 id 稳定");
  ok(a[0].text.includes("60%"), "话里带上了具体数字，不是一句「有异常」", a[0].text);

  eq(metrics.evaluate(bad, t0 + 60000).length, 0, "一分钟后还在响：闭嘴（冷却期内只报一次）");
  eq(metrics.evaluate(bad, t0 + 29 * 60000).length, 0, "29 分钟还在冷却");
  a = metrics.evaluate(bad, t0 + 31 * 60000);
  eq(a.length, 1, "过了 30 分钟冷却期，再响一次");

  a = metrics.evaluate(good, t0 + 32 * 60000);
  eq(a.length, 1, "不再命中：报一条恢复");
  eq(a[0].level, "resolved", "是恢复");
  ok(a[0].text.includes("已恢复"), "话里说了「已恢复」", a[0].text);
  ok(/持续约 \d+ 分钟/.test(a[0].text), "还说了持续多久——这句是给复盘用的", a[0].text);
  eq(metrics.evaluate(good, t0 + 33 * 60000).length, 0, "恢复只报一次，不会一直报");

  // 状态落盘：崩溃重启循环里内存状态每次都是空的，于是每重启一次就重报一次
  fs.rmSync(STATE, { force: true });
  metrics.evaluate(bad, t0);
  ok(fs.existsSync(STATE), "告警状态写进了盘");
  eq(Object.keys(metrics._internals.loadState())[0], "task_fail_rate", "存的是规则 id");
  eq(metrics.evaluate(bad, t0 + 1000).length, 0, "「重启」之后（状态从盘上读回来）仍然闭嘴，不重报");

  // 少于 5 趟不判：1 趟里挂 1 趟是 100%，可那多半是用户自己按了停止
  fs.rmSync(STATE, { force: true });
  eq(metrics.evaluate({ ...bad, tasks: 1, tasks_failed: 1, task_fail_rate: 1 }, t0).length, 0, "样本太少（1 趟）不判——多半是用户自己按了停止");
}

// ==========================================================================
console.log("\n【9】告警：一条渠道正在响，不许把另一条刚挂掉压下去");
// ==========================================================================
{
  fs.rmSync(metrics._internals.STATE_FILE, { force: true });
  const base = { ts: "2026-09-17T10:00:00.000Z", tasks: 0, tasks_failed: 0, task_fail_rate: 0, disk_free_pct: 1, rss_mb: 100 };
  const t0 = Date.parse(base.ts);

  let a = metrics.evaluate({ ...base, channel_fail_streak: { A: 6 } }, t0);
  eq(a.length, 1, "A 渠道连挂 6 次：报一条");
  eq(a[0].id, "channel:A", "id 里带上渠道名");
  a = metrics.evaluate({ ...base, channel_fail_streak: { A: 7, B: 5 } }, t0 + 60000);
  eq(a.length, 1, "A 还在冷却，但 B 刚挂——B 照样报得出来");
  eq(a[0].id, "channel:B", "报的是 B", a);
  a = metrics.evaluate({ ...base, channel_fail_streak: { B: 6 } }, t0 + 120000);
  eq(a.filter((x) => x.level === "resolved" && x.id === "channel:A").length, 1, "A 好了就单独报 A 恢复，不影响还在响的 B");

  eq(metrics.evaluate({ ...base, channel_fail_streak: { C: 4 } }, t0 + 180000).filter((x) => x.level === "alert").length,
     0, "连挂 4 次够不到门槛（5 次），不报——偶发失败不该叫人");

  fs.rmSync(metrics._internals.STATE_FILE, { force: true });
  a = metrics.evaluate({ ...base, channel_fail_streak: {}, disk_free_pct: 0.05 }, t0);
  eq(a.length, 1, "磁盘只剩 5%：报");
  ok(a[0].text.includes("写满之后任务会直接失败"), "而且说清了后果", a[0].text);
  eq(metrics.evaluate({ ...base, channel_fail_streak: {}, disk_free_pct: 0.2 }, t0 + 60000)
      .filter((x) => x.level === "alert").length, 0, "反向对照：剩 20% 不报");
}

// ==========================================================================
console.log("\n【10】用量账本：分片、读写、断电断在半行");
// ==========================================================================
{
  const UDIR = usage._internals.DIR;
  usage.append({ ts: "2026-07-05T10:00:00.000Z", day: "2026-07-05", user: "xiaozhang", credits: 1 });
  usage.append({ ts: "2026-08-05T10:00:00.000Z", day: "2026-08-05", user: "xiaozhang", credits: 2 });
  usage.append({ ts: "2026-09-05T10:00:00.000Z", day: "2026-09-05", user: "xiaoli", credits: 3 });
  usage.append({ ts: "2026-09-06T10:00:00.000Z", day: "2026-09-06", user: "xiaozhang", credits: 4 });

  ok(fs.existsSync(path.join(UDIR, "2026-09.jsonl")), "按月分片落盘");
  eq(usage.shards().join(","), "2026-09,2026-08,2026-07", "分片列表新的在前");

  const all = usage.read({});
  eq(all.length, 4, "全读得回来");
  eq(all[0].credits, 4, "新的在前（跟老的 loadUsage() 一个口径，调用方不用改）");
  eq(all[3].credits, 1, "老的在后");
  eq(usage.read({ from: "2026-09-01" }).length, 2, "查「本月」只碰这一片——历史有多少年都不影响");
  eq(usage.read({ to: "2026-07-31" }).length, 1, "按终点筛");
  eq(usage.read({ limit: 2 }).length, 2, "limit 够数就不再往老片翻");

  // 没有 day 只有 ts 的老记录，也得落到对的片里
  usage.append({ ts: "2026-06-01T10:00:00.000Z", user: "laoban", credits: 9 });
  ok(usage.shards().includes("2026-06"), "老记录只有 ts 也能算出属于哪一片");

  fs.appendFileSync(path.join(UDIR, "2026-09.jsonl"), '{"ts":"2026-09-07T00:00:00.000Z","cred');
  eq(usage.read({ from: "2026-09-01" }).length, 2, "断电留下的半行跳过，这个月其余的账照读");

  const st = usage.stat();
  eq(st.rows, 5, "stat 数得对");
  ok(st.size > 0, "也报了占多大");
}

// ==========================================================================
console.log("\n【11】用量账本：改名重写、整本替换、按月清理、最后活跃");
// ==========================================================================
{
  const n = usage.rewriteAll((r) => { if (r.user === "xiaozhang") { r.user = "zhangsan"; return true; } return false; });
  eq(n, 3, "改登录名把历史流水里的名字一起换掉（不然历史花销就成了没主的）");
  eq(usage.read({}).filter((r) => r.user === "zhangsan").length, 3, "换完确实是新名字");
  eq(usage.read({}).filter((r) => r.user === "xiaozhang").length, 0, "旧名字一条不剩");

  const la = usage.lastActive(["zhangsan", "xiaoli", "查无此人"]);
  eq(la.get("zhangsan"), "2026-09-06T10:00:00.000Z", "最后活跃取的是最近那一条");
  eq(la.get("xiaoli"), "2026-09-05T10:00:00.000Z", "每人各算各的");
  ok(!la.has("查无此人"), "查不到的人不占位（成员列表那一格显示空白就好）");

  const dropped = usage.prune(2);
  ok(dropped.length >= 1, "按月清理删掉了老片", dropped);
  eq(usage.shards().length, 2, "只剩最近两片");
  ok(!usage.shards().includes("2026-06"), "最老那片没了");

  eq(usage.replaceAll([
    { ts: "2026-09-10T00:00:00.000Z", day: "2026-09-10", user: "a", credits: 1 },
    { ts: "2026-05-10T00:00:00.000Z", day: "2026-05-10", user: "b", credits: 2 },
  ]), 2, "整本替换返回条数");
  eq(usage.shards().sort().join(","), "2026-05,2026-09", "不在新名单里的分片被删掉了");
  eq(usage.read({})[0].user, "a", "替换完读回来还是新的在前");
}

// ==========================================================================
console.log("\n【12】用量账本：老的一个大 JSON 拆成月分片");
// ==========================================================================
{
  // 另起一个干净的数据目录来验迁移：迁移只在第一次用到账本时跑一次
  const T2 = fs.mkdtempSync(path.join(os.tmpdir(), "owb-ops-mig-"));
  const prev = process.env.OPENWORKBUDDY_DATA_DIR;
  process.env.OPENWORKBUDDY_DATA_DIR = path.join(T2, "data");
  fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });
  delete require.cache[require.resolve(path.join(ROOT, "usage-store"))];
  const u2 = require(path.join(ROOT, "usage-store"));

  // 老账本是「新的在前」的一个大数组
  fs.writeFileSync(u2._internals.LEGACY, JSON.stringify([
    { ts: "2026-09-02T00:00:00.000Z", day: "2026-09-02", user: "a", credits: 3 },
    { ts: "2026-09-01T00:00:00.000Z", day: "2026-09-01", user: "a", credits: 2 },
    { ts: "2026-08-01T00:00:00.000Z", day: "2026-08-01", user: "b", credits: 1 },
  ]));
  eq(u2.migrate(), true, "迁移跑起来了");
  eq(u2.shards().join(","), "2026-09,2026-08", "拆成了两片");
  eq(u2.read({}).length, 3, "一条都没丢");
  eq(u2.read({})[0].credits, 3, "读出来还是新的在前");
  eq(u2._internals.readShard("2026-09")[0].credits, 2, "文件里存的是**老的在前**（追加天然如此）");
  ok(!fs.existsSync(u2._internals.LEGACY), "老文件挪走了");
  ok(fs.existsSync(u2._internals.LEGACY + ".migrated"), "但没删——万一拆错了还能对账");
  eq(u2.migrate(), false, "再跑一次什么都不做（已经迁过的机器上只是一次 existsSync）");

  // 老文件坏了：挪开就是了，别让它每次启动都重试，也别因此不让新账本开张
  fs.writeFileSync(u2._internals.LEGACY, "{这不是 JSON");
  eq(u2.migrate(), false, "老文件坏了返回 false");
  ok(fs.existsSync(u2._internals.LEGACY + ".broken"), "坏文件改名隔离");
  u2.append({ ts: "2026-09-09T00:00:00.000Z", day: "2026-09-09", user: "c", credits: 1 });
  eq(u2.read({})[0].user, "c", "新账照样记得进去");

  process.env.OPENWORKBUDDY_DATA_DIR = prev;
  try { fs.rmSync(T2, { recursive: true, force: true }); } catch {}
}

// ==========================================================================
console.log("\n【13】指标：每分钟那个循环真的会滚 + 会推");
// ==========================================================================
(async () => {
  fs.rmSync(metrics._internals.STATE_FILE, { force: true });
  // 上一节在 2026-09 那片末尾故意留了半行。真机上崩过一次之后也正是这个样子——
  // 下一条追加会接在半行后面，两条一起读不出来。那是可接受的代价（换来热路径上零 stat），
  // 但这一节要验的是别的事，所以从干净目录开始
  try { fs.rmSync(metrics._internals.DIR, { recursive: true, force: true }); } catch {}
  const pushed = [];
  metrics.bump("tasks", 10);
  metrics.bump("tasks_failed", 9);
  metrics.start({
    getConfig: () => ({ im: {} }),
    gauges: () => ({ active_runs: 2 }),
    notifyFn: async (_cfg, text) => { pushed.push(text); },
    intervalMs: 1000,
  });
  await new Promise((r) => setTimeout(r, 1400));
  metrics.stop();

  const rows = metrics.read({});
  const last = rows[rows.length - 1];
  eq(last.active_runs, 2, "调用方喂进来的那几格也进快照了（正在跑几趟任务只有 server 知道）");
  eq(last.tasks, 10, "计数滚进去了");
  ok(pushed.length >= 1, "失败率 90%，告警推出去了", pushed);
  ok(pushed[0].includes("⚠️"), "推的是告警那一条", pushed[0]);

  // 推送失败不能反过来把定时器搞挂
  metrics.bump("tasks", 10); metrics.bump("tasks_failed", 9);
  fs.rmSync(metrics._internals.STATE_FILE, { force: true });
  metrics.start({ notifyFn: () => { throw new Error("推不出去"); }, intervalMs: 1000 });
  await new Promise((r) => setTimeout(r, 1400));
  metrics.stop();
  ok(true, "推送函数抛错也没把进程带走");

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
