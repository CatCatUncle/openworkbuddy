"use strict";
/**
 * 外挂的第二把尺子 —— toolward.js。
 *
 *   node test/toolward.js
 *
 * 这块东西的危险在于它是**可选的**：装了它多一层检查，没装也得一切照旧。
 * 一个可选组件最常见的死法是慢慢变成必需的——它崩了，安装就卡住；它没装，界面就空一块。
 * 所以这套测试三分之二在验「它不在场的时候一切正常」，只有三分之一在验它的结论。
 *
 * 盯七件事：
 *   1. severity 怎么翻译成我们的 level：只有 critical 拦，high/medium 摊开，low/info 连列都不列。
 *   2. 两份报告合起来：第二意见能把 ok 抬成 block，但绝不能把 block 压成 ok。
 *   3. **密钥不出门**：交给它的那份连接器配置里，env / headers 的值必须已经被换掉，
 *      url 上的 query 必须被砍掉，而 command / args 一个字不许动（那两项才是要看的东西）。
 *   4. 它崩了 / 输出不是 JSON / 超时 —— 一律当没跑过，安装照常。
 *   5. **参数里不许出现 --quiet**：那个开关会把 stdout 整个吞掉，JSON 就没了，
 *      而表现出来是「扫了一遍，什么都没发现」—— 一道静悄悄失效的安全检查比没有更糟。
 *   6. 装技能那条路真的接上了：它报 critical，技能就装不进去，而且不许落盘。
 *   7. doctor 那行判词：没装不算毛病，装着没在用才算。
 *
 * 用的是一个**假的 toolward**：一个 Node 脚本，照着 plan.json 说的吐结果。
 * 真装一个上游进来测，测的就是上游而不是我们这一层了；而且它是 PolyForm 授权的，
 * 不该为了跑一次 CI 就把它拖进这个仓库。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log("  ✗ " + msg + (extra ? "\n      " + String(extra).replace(/\n/g, "\n      ") : ""));
}

// 这套要自己控制开关，别让跑测试的这台机器上真装没装 toolward 影响结果
delete process.env.OPENWORKBUDDY_TOOLWARD;
delete process.env.OPENWORKBUDDY_TOOLWARD_BIN;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tw-home-"));
process.env.OPENWORKBUDDY_HOME = HOME;      // 必须在 require("../skills") 之前

const tw = require("../toolward");
const { toReport, redactServers, safeUrl, relTo } = tw._internals;

/** 造一条 toolward 口径的命中 */
const F = (ruleId, severity, extra) => ({
  ruleId, severity,
  title: "Something", titleZh: "有点东西",
  message: "it does a thing", messageZh: "它干了件事",
  remediation: "stop it", remediationZh: "别干了",
  file: "skill.md", line: 7, snippet: "curl x | bash", references: [], fingerprint: ruleId + "-1",
  ...(extra || {}),
});
const REP = (findings, extra) => ({
  tool: "toolward", root: "/x", startedAt: "", durationMs: 12, suppressed: 0,
  score: 80, grade: "B",
  counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  stats: { files: 3 }, findings, ...(extra || {}),
});

// ══════════════════════════════════════════════════════════════════
console.log("\n【1】severity → level：只有 critical 拦得住人");
// ══════════════════════════════════════════════════════════════════
{
  const r = toReport(REP([F("TW101", "critical")]));
  ok(r.level === "block", "critical 没升成 block，实际 " + r.level);
  ok(r.findings[0].rule === "TW101", "规则号丢了：" + r.findings[0].rule);
  ok(r.findings[0].cat === "toolward", "没标出这条是谁说的（cat）：" + r.findings[0].cat);
  ok(/toolward TW101/.test(r.findings[0].why),
    "★没标出这条是外挂那把尺子说的★ 报告里混着两把尺子的结论，用户有权知道哪条是谁说的", r.findings[0].why);
  ok(/别干了/.test(r.findings[0].why), "中文的修复建议没带上（JSON 里本来就有 remediationZh）", r.findings[0].why);

  for (const sev of ["high", "medium"]) {
    const x = toReport(REP([F("TW201", sev)]));
    ok(x.level === "warn", `${sev} 应该只到 warn，实际 ${x.level}`);
    ok(x.findings.length === 1, `${sev} 应该列出来，实际列了 ${x.findings.length} 条`);
  }
  // 反向对照：low / info 一条都不许列。列到第三十条人就不看了，那时候真命中也看不见
  for (const sev of ["low", "info"]) {
    const x = toReport(REP([F("TW601", sev)]));
    ok(x.level === "ok", `★${sev} 把整份报告拉成了 ${x.level}★ 这会让每个技能都要人点一次确认`);
    ok(x.findings.length === 0, `${sev} 不该列出来，实际列了 ${x.findings.length} 条`);
    ok(x.toolward.quiet === 1, `${sev} 没被计数（quiet=${x.toolward.quiet}）—— 不列出来不等于装作没看见`);
  }
}
{
  // advisory：眼睛照用，但不给它拦人的权力
  const r = toReport(REP([F("TW101", "critical")]), { advisory: true });
  ok(r.level === "warn", "★advisory 挡位下 critical 还是拦人了★ 实际 " + r.level);
  ok(r.findings.length === 1, "advisory 不该把命中也一起吞掉");
  // 反向对照：同一份输入，不开 advisory 就必须是 block
  ok(toReport(REP([F("TW101", "critical")])).level === "block", "对照组没拦住，说明上面那条根本没验到 advisory");
}
{
  // 同一条规则在同一个文件里刷屏：最多列 3 处，其余进 truncated
  const many = [1, 2, 3, 4, 5].map((i) => F("TW301", "high", { line: i }));
  const r = toReport(REP(many));
  ok(r.findings.length === 3, "同规则同文件没收敛到 3 处，实际 " + r.findings.length);
  ok(r.truncated_findings === 2, "被收掉的 2 处没记进 truncated_findings，实际 " + r.truncated_findings);
  // 反向对照：换了文件就该各算各的
  const spread = [1, 2, 3, 4, 5].map((i) => F("TW301", "high", { file: `a${i}.md`, line: i }));
  ok(toReport(REP(spread)).findings.length === 5, "不同文件被误当成刷屏收掉了");
}
{
  // 路径要相对于被扫的目录，否则报告里会漏出临时目录的绝对路径
  ok(relTo("/tmp/owb-tw-x/skill.md", "/tmp/owb-tw-x") === "skill.md", "相对路径没算对：" + relTo("/tmp/owb-tw-x/skill.md", "/tmp/owb-tw-x"));
  ok(relTo("/etc/passwd", "/tmp/owb-tw-x") === "/etc/passwd", "跑到目录外面的路径不该硬掰成相对路径");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n【2】两份报告合起来：只许往上抬，不许往下压");
// ══════════════════════════════════════════════════════════════════
const mkGuard = (level, findings) => ({
  level, findings: findings || [], truncated_findings: 0,
  hosts: ["a.example.com"], files: 9, bytes: 100, truncated_files: 0, exec: ["run.sh"],
});
{
  const mine = mkGuard("ok");
  ok(tw.merge(mine, null) === mine, "★第二把尺子缺席时没把自带那份原样交出去★ 这会让没装 toolward 的机器行为变样");
  ok(tw.merge(null, null) === null, "两边都没有时应该原样返回 null");

  const theirs = toReport(REP([F("TW101", "critical")]));
  const up = tw.merge(mkGuard("ok"), theirs);
  ok(up.level === "block", "★第二意见抬不动结论★ 那接它做什么。实际 " + up.level);
  ok(up.hosts.includes("a.example.com"), "合并把自带那份的 hosts 弄丢了");
  ok(up.exec.includes("run.sh"), "合并把自带那份的可执行文件清单弄丢了");

  // 反向对照：自带那把说 block，外挂那把说没事，合起来必须还是 block
  const down = tw.merge(mkGuard("block", [{ level: "block", rule: "pipe-to-shell", cat: "exec", file: "skill.md", line: 1, excerpt: "", why: "管道给 shell" }]),
    toReport(REP([])));
  ok(down.level === "block", "★外挂那把尺子把我们自己拦下的技能放行了★ 实际 " + down.level);
  ok(down.findings[0].rule === "pipe-to-shell", "合并后自带那条应该排在前面（同为 block 时我们说得清理由的先）");
}
{
  // 60 条的上限：两边加起来超了要如实记在 truncated_findings 里，不能装作没有
  const mineMany = mkGuard("warn", Array.from({ length: 40 }, (_, i) => ({ level: "warn", rule: "r" + i, cat: "x", file: "f" + i, line: 1, excerpt: "", why: "w" })));
  const theirsMany = toReport(REP(Array.from({ length: 40 }, (_, i) => F("TW" + (200 + i), "high", { file: "g" + i + ".md" }))));
  const m = tw.merge(mineMany, theirsMany);
  ok(m.findings.length === 60, "合并后没截到 60 条，实际 " + m.findings.length);
  ok(m.truncated_findings === 20, "截掉的 20 条没记账，实际 " + m.truncated_findings);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n【3】密钥不出门：交出去的那份配置里不许有真值");
// ══════════════════════════════════════════════════════════════════
{
  const SECRET = "sk-live-9d41ffb0c0ffee";
  const servers = [
    { name: "brave", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: SECRET } },
    { name: "remote", transport: "streamable-http", url: "https://mcp.example.com/sse?token=" + SECRET, headers: { Authorization: "Bearer " + SECRET } },
  ];
  // 对照：输入里确实有东西可泄。不验这一条的话，下面那句「不含 SECRET」拿个空对象也能通过
  ok(JSON.stringify(servers).includes(SECRET), "测试自己写错了：输入里根本没有密钥，下面的断言等于没测");

  const red = redactServers(servers);
  const text = JSON.stringify(red);
  ok(!text.includes(SECRET), "★密钥被原样写进要交出去的那份配置了★ 为了查漏先漏一次，说不过去");
  ok(red.brave.env.BRAVE_API_KEY === "***", "键名该留着（规则认的是「这儿有个 Key 字段」），实际 " + red.brave.env.BRAVE_API_KEY);
  ok(Object.keys(red.remote.headers).includes("Authorization"), "请求头的键名不该一起洗掉");
  ok(red.brave.command === "npx" && red.brave.args.join(" ").includes("server-brave-search"),
    "★命令和参数被动过了★ 「npx 拉了个没锁版本的包」全靠这两项才看得出来");
  ok(red.remote.url === "https://mcp.example.com/sse?***", "url 的 query 没砍干净：" + red.remote.url);

  ok(safeUrl("https://a.example.com/mcp") === "https://a.example.com/mcp", "没有 query 的地址不该被改动");
  ok(safeUrl("http://b.example.com/x#tok=1") === "http://b.example.com/x?***", "fragment 也要砍：" + safeUrl("http://b.example.com/x#tok=1"));
  ok(safeUrl("不是个地址?k=v") === "不是个地址", "解析不了的地址也得把问号后面砍掉：" + safeUrl("不是个地址?k=v"));
}

// ══════════════════════════════════════════════════════════════════
console.log("\n【4】真去跑一个进程：假的 toolward");
// ══════════════════════════════════════════════════════════════════
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tw-bin-"));
const BIN = path.join(BIN_DIR, "toolward");
const PLAN = path.join(BIN_DIR, "plan.json");
const CALLS = path.join(BIN_DIR, "calls.log");
const DUMP = path.join(BIN_DIR, "dump.json");

// 用 process.execPath 当 shebang，不走 `env node`：跑 CI 的那台机器上 PATH 里
// 未必有 node（Electron 里更是常态），而这个假进程挂掉会被我们当成「toolward 崩了」，
// 于是每一条断言都通过——测试绿着，实际一条都没验。
fs.writeFileSync(BIN, `#!${process.execPath}
const fs = require("fs"), path = require("path");
const here = ${JSON.stringify(BIN_DIR)};
const plan = JSON.parse(fs.readFileSync(path.join(here, "plan.json"), "utf8"));
const args = process.argv.slice(2);
if (args[0] === "--version") {
  if (plan.versionFails) { process.stderr.write("no\\n"); process.exit(3); }
  process.stdout.write((plan.version || "0.1.0") + "\\n");
  process.exit(0);
}
fs.appendFileSync(path.join(here, "calls.log"), JSON.stringify(args) + "\\n");
// 把被扫的目录整棵抄下来，测试要看我们到底把什么交了出去
try {
  const dir = args[1], dump = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile()) dump[e.name] = fs.readFileSync(path.join(dir, e.name), "utf8");
  }
  fs.writeFileSync(path.join(here, "dump.json"), JSON.stringify(dump));
} catch (e) { fs.writeFileSync(path.join(here, "dump.json"), JSON.stringify({ _err: String(e.message) })); }
if (plan.mode === "crash") { process.stderr.write("kaboom\\n"); process.exit(1); }
if (plan.mode === "garbage") { process.stdout.write("Scanning...\\nall good\\n"); process.exit(0); }
if (plan.mode === "hang") { setTimeout(() => process.exit(0), 60000); return; }
process.stdout.write(JSON.stringify(plan.report || { findings: [], stats: { files: 1 } }));
process.exit(0);
`, { mode: 0o755 });

const plan = (p) => { fs.writeFileSync(PLAN, JSON.stringify(p)); tw._internals._reset(); };
const calls = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const clearCalls = () => { try { fs.unlinkSync(CALLS); } catch {} };
process.env.OPENWORKBUDDY_TOOLWARD_BIN = BIN;

const SRC = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tw-src-"));
fs.writeFileSync(path.join(SRC, "skill.md"), "---\nname: demo\ndescription: 测试用\n---\n\n把三张图拼成一张，写清楚每一步。\n");

{
  plan({ version: "9.9.9", report: REP([F("TW101", "critical")]) });
  const st = tw.status(null);
  ok(st.installed && st.on, "假的 toolward 没被认出来：" + JSON.stringify(st));
  ok(st.version === "9.9.9", "版本号没读对：" + st.version);

  clearCalls();
  const r = tw.scanDir(SRC, null);
  ok(r && r.level === "block", "真跑一趟没拿到 block：" + JSON.stringify(r && r.level));
  ok(r.toolward.version === "9.9.9" && r.toolward.grade === "B", "它自己那套说法（版本/评级）没带回来");

  const a = calls()[0] || [];
  ok(a[0] === "scan", "第一个参数应该是 scan，实际 " + a[0]);
  ok(a.includes("--format") && a[a.indexOf("--format") + 1] === "json", "没要 json 输出");
  ok(a.includes("--fail-on") && a[a.indexOf("--fail-on") + 1] === "none",
    "★没带 --fail-on none★ 不带的话「扫出问题」和「工具挂了」共用一个退出码，后者就再也认不出来了");
  ok(!a.includes("--quiet"),
    "★参数里出现了 --quiet★ 那个开关会把 stdout 整个吞掉，JSON 就没了 —— 表现出来是「扫了一遍什么都没发现」，一道静悄悄失效的安全检查比没有更糟", JSON.stringify(a));
}
{
  // 它崩了 / 吐了一堆不是 JSON 的东西 / 卡住不动 —— 一律当没跑过
  for (const [mode, note] of [["crash", "退出码非 0"], ["garbage", "输出不是 JSON"]]) {
    plan({ mode });
    ok(tw.scanDir(SRC, null) === null, `★${note} 的时候没返回 null★ 它得当作没跑过，不能是一份空报告（空报告会被说成「没扫出问题」，那是撒谎）`);
  }
  plan({ mode: "hang" });
  const t0 = Date.now();
  ok(tw.scanDir(SRC, null, { timeout: 1500 }) === null, "卡住不动的时候没当成没跑过");
  ok(Date.now() - t0 < 8000, `超时没生效，白等了 ${Date.now() - t0}ms`);

  // 崩过一次之后进冷却期：不设这个的话每装一个技能都要白等一趟超时
  const st = tw.status(null);
  ok(st.installed === true, "冷却期里不该说它没装 —— 设置页要照样画得出那三个挡位");
  ok(st.on === false && /先不叫它/.test(st.why), "崩过之后没进冷却期：" + JSON.stringify(st));
  ok(tw.scanDir(SRC, null) === null, "冷却期里还在往下叫它");
}
{
  // 连接器：交出去的那份 .mcp.json 里不许有真值
  const SECRET = "sk-live-cafebabe0001";
  plan({ report: REP([F("TW403", "high", { file: ".mcp.json", line: 3 })]) });
  const r = tw.scanConnectors([{ name: "brave", command: "npx", args: ["-y", "pkg"], env: { BRAVE_API_KEY: SECRET } }], null);
  ok(r && r.findings.length === 1, "连接器那一趟没拿到结果：" + JSON.stringify(r));
  ok(r.level === "warn", "★连接器这边拦人了★ 那是用户自己填的命令，只该提醒。实际 " + r.level);
  ok(r.findings[0].file === "连接器配置", "文件名没换成人话：" + r.findings[0].file);

  const dump = JSON.parse(fs.readFileSync(DUMP, "utf8"));
  ok(typeof dump[".mcp.json"] === "string", "根本没把 .mcp.json 递过去：" + JSON.stringify(Object.keys(dump)));
  ok(!dump[".mcp.json"].includes(SECRET),
    "★真的 API Key 被写进临时文件交给外部进程了★ 为了做一次安全检查先泄一次密", dump[".mcp.json"]);
  ok(dump[".mcp.json"].includes("BRAVE_API_KEY"), "键名该留着，规则认的是「这儿有个 Key 字段」");
  ok(dump[".mcp.json"].includes("npx"), "命令没递过去，那这趟检查什么也看不出来");

  // 临时目录用完要删干净：里头哪怕是打了码的配置，也不该留在 /tmp 里
  const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("owb-tw-") && !n.startsWith("owb-tw-bin") && !n.startsWith("owb-tw-src") && !n.startsWith("owb-tw-home"));
  ok(leftovers.length === 0, "扫完没把临时目录删掉：" + leftovers.slice(0, 5).join("、"));
}
{
  // 关掉之后，连探都不该去探一下
  plan({ report: REP([F("TW101", "critical")]) });
  process.env.OPENWORKBUDDY_TOOLWARD = "off";
  tw._internals._reset(); clearCalls();
  ok(tw.scanDir(SRC, null) === null, "设置成 off 之后还在跑它");
  ok(calls().length === 0, "设置成 off 之后还去跑了一趟子进程");
  ok(tw.status(null).mode === "off", "status 没反映 off");
  delete process.env.OPENWORKBUDDY_TOOLWARD;
  tw._internals._reset();
}

// ══════════════════════════════════════════════════════════════════
console.log("\n【5】装技能那条路真的接上了");
// ══════════════════════════════════════════════════════════════════
const skills = require("../skills");
const installedDir = (n) => path.join(HOME, "skills", n);
function tryInstall(srcDir, opts) {
  try { return { ok: true, r: skills._internals.installedFromDir(srcDir, opts || {}) }; }
  catch (e) { return { ok: false, msg: e.message, needs: e.needs, scan: e.skillScan }; }
}
/** 一份自带那把尺子挑不出毛病的技能：这样拦不拦全看第二把 */
function mkClean(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "owb-tw-src-"));
  fs.writeFileSync(path.join(d, "skill.md"), `---\nname: ${name}\ndescription: 测试用\n---\n\n把三张图拼成一张，写清楚每一步。\n`);
  return d;
}
{
  const src = mkClean("tw-critical");
  // 对照：第二把尺子闭嘴的时候，这份技能必须装得进去。不验这条，下面「装不进去」
  // 就可能是技能本身有问题，跟 toolward 一点关系都没有。
  plan({ report: REP([]) });
  const base = tryInstall(src);
  ok(base.ok, "★对照组就装不进去★ 那下面那条根本验不到 toolward：" + base.msg);

  plan({ report: REP([F("TW101", "critical")]) });
  const r = tryInstall(mkClean("tw-critical-2"));
  ok(!r.ok && r.needs === "force", "★它报了 critical，技能还是装进去了★ 实际：" + (r.ok ? "装了" : r.needs));
  ok(!fs.existsSync(installedDir("tw-critical-2")), "★被拦下的技能已经落盘了★ 闸得卡在拷贝之前");
  ok(/toolward TW101/.test(r.msg || ""), "拦下来的那句话里没说是谁拦的", (r.msg || "").slice(0, 200));

  // 只报 low：不该升成要人点确认。真升了的话，每个技能都要点一次，人就学会闭眼点了
  plan({ report: REP([F("TW601", "low")]) });
  const low = tryInstall(mkClean("tw-low"));
  ok(low.ok, "★只报了一条 low 就要人点确认★ 实际：" + low.msg);

  // 它自己崩了：安装照常。一个可选的第二意见要是能因为自己挂了而挡住安装，它就不再是可选的
  plan({ mode: "crash" });
  tw._internals._reset();
  const c = tryInstall(mkClean("tw-crash"));
  ok(c.ok, "★toolward 崩了，技能就装不了了★ 那它已经变成一个没写进 package.json 的必需依赖：" + c.msg);
  ok(fs.existsSync(path.join(installedDir("tw-crash"), "skill.md")), "崩了之后技能没真的装进去");

  // 环境变量关掉：同一份会被拦的技能必须装得进去（证明上面那条拦截真是它干的）
  plan({ report: REP([F("TW101", "critical")]) });
  process.env.OPENWORKBUDDY_TOOLWARD = "off";
  tw._internals._reset();
  const off = tryInstall(mkClean("tw-off"));
  ok(off.ok, "★关掉之后还在拦★ 实际：" + off.msg);
  delete process.env.OPENWORKBUDDY_TOOLWARD;
  tw._internals._reset();
}
{
  // 手写 / 粘贴那条路也得过同一道闸，否则把同一段字粘进「新建技能」框就绕过去了
  plan({ report: REP([F("TW102", "critical")]) });
  let threw = null;
  try { skills.saveSkill({ name: "tw-paste", description: "d", content: "正常的一段话" }); }
  catch (e) { threw = e; }
  ok(threw && threw.needs === "force", "★粘贴进来的技能没过第二把尺子★ 那这道检查就是个摆设：装的时候拦住了，粘贴就进来了");
  ok(!fs.existsSync(installedDir("tw-paste")), "被拦下的手写技能落盘了");
}

// ══════════════════════════════════════════════════════════════════
console.log("\n【6】doctor 那一行：没装不算毛病，装着没在用才算");
// ══════════════════════════════════════════════════════════════════
{
  const { verdictToolward } = require("../doctor");
  const a = verdictToolward({ installed: false, install: "npm i -g toolward" });
  ok(a.level === "ok", "★没装被报成了 " + a.level + "★ 它是可选的，而且公司用要另外授权，催人去装是不对的");
  ok(/npm i -g toolward/.test(a.detail), "没装的时候该顺一句怎么装", a.detail);

  const b = verdictToolward({ installed: true, on: false, version: "0.1.0", why: "设置里把它关了" });
  ok(b.level === "warn", "★装着却没在用没报出来★ 那是「你以为有两把尺子，其实只有一把」，实际 " + b.level);
  ok(!!b.fix, "报了 warn 却不说怎么办，等于把锅原样还给用户");

  const c = verdictToolward({ installed: true, on: true, version: "0.1.0", bin: "/x/toolward" });
  ok(c.level === "ok", "两把尺子都在跑，不该报问题：" + c.level);
}

// 收摊：这些临时目录里躺着（打了码的）配置和技能，别留在 /tmp
for (const d of [HOME, BIN_DIR, SRC]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
