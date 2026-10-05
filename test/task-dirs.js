// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 成果按对话分文件夹：哪些根下分、IM / 定时任务落在哪一格、跑空了收不收。
 *
 * 跑法：node test/task-dirs.js（全在临时家里，不起服务、不调模型）
 *
 * 来由：以前只有默认工作空间分文件夹。装好之后建个项目、目录没填（应用替人建在
 * ~/OpenWorkBuddy/projects/<名>），从此所有对话的产出摊在项目根上，两条对话各写一份「报告.html」，
 * 后写的盖掉先写的。飞书/微信来的全挤一个 IM_对话/，定时任务全挤一个 定时任务/，也一样互相盖。
 *
 * server.js 是 require 即 listen，这里把 runDirFor / settleRunDir 那一段真源码切出来配上桩跑：
 * 测的是发出去的那份代码，不是测试里抄的一份。
 */
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("task-dirs");

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { src } = require("./lib/src");
const taskDirs = require(mod("task-dirs"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);
const has = (p) => fs.existsSync(p);

(async () => {
  // 摆成真实数据根的样子：<家>/workspace、<家>/projects/<名>、<家>/data/tenants/<id>
  const ws = path.join(HOME, "workspace");
  const projects = path.join(HOME, "projects");
  const tenants = path.join(HOME, "data", "tenants");
  const mine = path.join(HOME, "我的代码仓库");
  for (const d of [ws, path.join(projects, "小红书"), path.join(tenants, "org_a"), mine]) fs.mkdirSync(d, { recursive: true });
  const anchors = { workspace: ws, projects, tenants };

  section("【1】哪些根下按对话分");
  {
    ok(taskDirs.perChatRoot(ws, anchors), "默认工作空间：分");
    ok(taskDirs.perChatRoot(path.join(projects, "小红书"), anchors), "没填目录时应用替项目建的 projects/<名>：分");
    ok(taskDirs.perChatRoot(path.join(tenants, "org_a"), anchors), "没指定目录的租户根 tenants/<id>：分");
    ok(!taskDirs.perChatRoot(mine, anchors), "★反向对照★ 用户自己挑的文件夹：不分，照旧就地读写");
    ok(!taskDirs.perChatRoot(projects, anchors), "★反向对照★ projects/ 本身不算（它下一层才是项目）");
    ok(!taskDirs.perChatRoot(path.join(projects, "小红书", "子目录"), anchors), "★反向对照★ 项目里再往下一层是用户挑的：不分");
    ok(taskDirs.perChatRoot(path.join(ws, "..", "workspace"), anchors), "路径里带 .. 也认得出是同一个地方");
    const link = path.join(HOME, "ws-link");
    fs.symlinkSync(ws, link);
    ok(taskDirs.perChatRoot(link, anchors), "软链接指过来的也是同一个地方（/tmp 和 /private/tmp 那种）");
    if (process.platform === "darwin" || process.platform === "win32") {
      ok(taskDirs.perChatRoot(path.join(HOME, "WORKSPACE"), anchors), "盘不分大小写的系统上，大小写拼错也还是同一个地方");
    }
    ok(taskDirs.perChatRoot(path.join(projects, "还没建出来的项目"), anchors), "项目目录还没建出来时也照样判（不存在的尾巴原样接上）");
    ok(!taskDirs.perChatRoot("", anchors) && !taskDirs.perChatRoot(ws, {}), "空参数不炸，一律按不分");
  }

  section("【2】文件夹名");
  {
    ok(taskDirs.taskSlug("【任务类型：数据分析】帮我做个周报") === "帮我做个周报", "【任务类型】前缀洗掉", taskDirs.taskSlug("【任务类型：数据分析】帮我做个周报"));
    ok(taskDirs.taskSlug("【图片 1：IMG_8037.JPG】") === "IMG8037", "只拖了张图：拿文件名兜底", taskDirs.taskSlug("【图片 1：IMG_8037.JPG】"));
    ok(taskDirs.taskSlug("！！！") === "", "一个字都剩不下：回空串，由调用方兜底");
    ok(/^\d{4}$/.test(taskDirs.dayStamp()) && taskDirs.dayStamp(new Date(2026, 8, 3)) === "0903", "月日四位");
    fs.mkdirSync(path.join(ws, "IM_对话", "0930_做海报"), { recursive: true });
    const taken = new Set(["IM_对话/0930_做海报_2"]);
    ok(taskDirs.freeDir(ws, "IM_对话/0930_做海报", taken) === "IM_对话/0930_做海报_3", "两层的名字也避让：盘上有的、刚分出去的都跳过",
      taskDirs.freeDir(ws, "IM_对话/0930_做海报", taken));
    ok(taskDirs.freeDir(ws, "IM_对话/0930_新的") === "IM_对话/0930_新的", "没人用的名字原样给");
  }

  section("【3】跑空了收文件夹");
  {
    const d = path.join(ws, "IM_对话", "0930_空的");
    fs.mkdirSync(d, { recursive: true });
    fs.rmSync(path.join(ws, "IM_对话", "0930_做海报"), { recursive: true });
    ok(taskDirs.dropIfEmpty(ws, "IM_对话/0930_空的") && !has(d), "空的撤掉");
    ok(!has(path.join(ws, "IM_对话")), "  └ 连同变空了的 IM_对话/ 一起撤");
    ok(has(ws), "  └ 根本身一层都不越过去");
    fs.mkdirSync(path.join(ws, "定时任务", "每日简报"), { recursive: true });
    fs.writeFileSync(path.join(ws, "定时任务", "每日简报", "0929.md"), "x");
    ok(!taskDirs.dropIfEmpty(ws, "定时任务/每日简报") && has(path.join(ws, "定时任务", "每日简报", "0929.md")), "★反向对照★ 里面有上次的产出：一个字节不动");
    fs.mkdirSync(path.join(ws, "定时任务", "周报"), { recursive: true });
    ok(taskDirs.dropIfEmpty(ws, "定时任务/周报") && has(path.join(ws, "定时任务")), "父目录里还有别的任务：只撤自己，父目录留着");
    ok(taskDirs.dropIfEmpty(ws, "从来没建过的") === true, "压根没建出来（纯聊天没碰文件）：当它已经不在");
    ok(/rmdirSync/.test(fs.readFileSync(mod("task-dirs"), "utf8")) &&
      !/rmSync|recursive:\s*true/.test(/function dropIfEmpty[\s\S]*?\n}/.exec(fs.readFileSync(mod("task-dirs"), "utf8"))[0]),
      "只用 rmdirSync：判断万一有误，最坏也只是删不动");
  }

  section("【4】模型照抄两层文件夹名，不许套成两层");
  {
    const tools = require(mod("tools"));
    const tws = path.join(HOME, "tools-ws");
    fs.mkdirSync(tws, { recursive: true });
    tools.setWorkspaceDir(tws);
    const base = "IM_对话/0930_做海报";
    let r = await tools.executeTool("write_file", { path: base + "/海报.html", content: "<p>1</p>" }, { baseDir: base });
    ok(!r.isError && has(path.join(tws, base, "海报.html")) && !has(path.join(tws, base, "IM_对话")), "写 IM_对话/0930_做海报/海报.html：落在那一格里，不再套一层", r.content);
    r = await tools.executeTool("write_file", { path: "0930_做海报/说明.md", content: "x" }, { baseDir: base });
    ok(!r.isError && has(path.join(tws, base, "说明.md")), "只抄了最后一层名字：一样剥掉", r.content);
    r = await tools.executeTool("write_file", { path: "素材/图.txt", content: "x" }, { baseDir: base });
    ok(!r.isError && has(path.join(tws, base, "素材", "图.txt")), "★反向对照★ 正常的子目录照写不误", r.content);

    // 定时任务那格的末段是用户起的任务名，里面真建个同名子文件夹是正当的：只剥整条两层前缀，不剥末段
    const sb = "定时任务/每日简报";
    r = await tools.executeTool("write_file", { path: sb + "/简报.md", content: "x" }, { baseDir: sb });
    ok(!r.isError && has(path.join(tws, sb, "简报.md")), "定时任务照抄两层全名：照样剥掉", r.content);
    r = await tools.executeTool("write_file", { path: "每日简报/附图.txt", content: "x" }, { baseDir: sb });
    ok(!r.isError && has(path.join(tws, sb, "每日简报", "附图.txt")), "任务名同名的子文件夹：照建，不跟 run_shell 看到的对不上", r.content);

    // 分文件夹以前，那条任务的产物摊在 定时任务/ 下：它接着要读的那份汇总得找得回来
    fs.writeFileSync(path.join(tws, "定时任务", "汇总.md"), "上个月的汇总");
    r = await tools.executeTool("read_file", { path: "汇总.md" }, { baseDir: sb });
    ok(!r.isError && /上个月的汇总/.test(String(r.content)), "老任务摊在 定时任务/ 下的文件：往上一层找得到", r.content);
    r = await tools.executeTool("write_file", { path: "汇总.md", content: "新的一份" }, { baseDir: sb });
    ok(!r.isError && has(path.join(tws, sb, "汇总.md")) && fs.readFileSync(path.join(tws, "定时任务", "汇总.md"), "utf8") === "上个月的汇总",
      "★反向对照★ 没读过就写：落在自己那格，上一层那份一个字不动", r.content);

    // 成果面板最深 3 层；IM / 定时任务那格自己占两层，放宽一层，不然里面的子文件夹整个看不见
    fs.mkdirSync(path.join(tws, base, "网站"), { recursive: true });
    fs.writeFileSync(path.join(tws, base, "网站", "index.html"), "<p>站</p>");
    fs.mkdirSync(path.join(tws, "任务_0930_深", "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(tws, "任务_0930_深", "a", "b", "c.html"), "x");
    const names = tools.outputFiles().map((f) => f.name);
    ok(names.includes(base + "/网站/index.html"), "IM 那格里的子文件夹：面板上看得见", names);
    ok(!names.includes("任务_0930_深/a/b/c.html"), "★反向对照★ 别处还是最深 3 层，不是整个放开");
    const agent = require(mod("agent"));
    const sc = agent._scan.scanTree(require(mod("ws-browse")), require(mod("sweep")), fs, path,
      { op: "scan", root: tws, appDataDir: "", bases: [], filesCap: 500 });
    const top = (sc.top || []).map((f) => f.name);
    ok(top.includes(base + "/网站/index.html") && !top.includes("任务_0930_深/a/b/c.html"), "后台线程那份（scanTree）口径一样", top);
  }

  section("【5】IM 按会话分、定时任务按任务名分（server.js 真源码）");
  {
    const srv = src("server");
    const m = /const RUN_DIRS_FILE = [\s\S]*?\nfunction settleRunDir\([\s\S]*?\n}\n/.exec(srv);
    ok(!!m, "server.js 里找得到 runDirFor / settleRunDir 那一段");
    if (!m) throw new Error("切不到源码，后面没法测");
    const dataDir = path.join(HOME, "srv-data");
    fs.mkdirSync(path.join(dataDir, "data"), { recursive: true });
    let root = path.join(HOME, "srv-ws");
    let perChat = true;
    const sessions = new Map();
    const warns = [];
    const load = () => new Function("fs", "path", "require", "dataPath", "store", "log", "perChatHere", "getWorkspaceDir", "sessions", "taskDirs", "assignedDirs",
      m[0] + "; return { runDirs, runDirFor, settleRunDir, holdRunDir };")(
      fs, path, (p) => require(p.startsWith("./") ? path.join(ROOT, p) : p), (...p) => path.join(dataDir, ...p), require(mod("store")),
      { warn: (...a) => warns.push(a) }, () => perChat, () => root, sessions, taskDirs, new Set());
    let S = load();
    const user = (t) => ({ role: "user", content: t });
    const bot = (t) => ({ role: "assistant", content: t });
    const day = taskDirs.dayStamp();

    const a1 = S.runDirFor("im", { sessionId: "feishu_群A", history: [user("做一张中秋海报")] });
    ok(a1 === `IM_对话/${day}_做一张中秋海报`, "新开一段会话：IM_对话/月日_头一句话", a1);
    const b1 = S.runDirFor("im", { sessionId: "feishu_群B", history: [user("做一张中秋海报")] });
    ok(b1 !== a1 && b1.startsWith(`IM_对话/${day}_做一张中秋海报`), "另一个群同一句话：另起一格，不互相盖", b1);
    const a2 = S.runDirFor("im", { sessionId: "feishu_群A", history: [user("做一张中秋海报"), bot("好了"), user("字再大点")] });
    ok(a2 === a1, "同一段会话接着聊：回到同一格（改稿和原稿在一起）", a2);
    ok(has(path.join(dataDir, "data", "run-dirs.json")), "会话 → 文件夹的表落了盘");
    S = load();
    const a3 = S.runDirFor("im", { sessionId: "feishu_群A", history: [user("做一张中秋海报"), bot("好了"), user("字再大点"), bot("改了"), user("再来一版")] });
    ok(a3 === a1, "重启之后聊到一半的那段：还是那一格", a3);
    const a4 = S.runDirFor("im", { sessionId: "feishu_群A", history: [user("帮我写周报")] });
    ok(a4 === `IM_对话/${day}_帮我写周报`, "闲置超时清空后重新聊起来（历史只剩一句）：按新的话另起一格", a4);
    root = path.join(HOME, "srv-ws-2");
    const a5 = S.runDirFor("im", { sessionId: "feishu_群A", history: [user("帮我写周报"), bot("好"), user("加个图表")] });
    ok(a5 === `IM_对话/${day}_加个图表`, "换过根：在新根下另起（旧的那格留在旧根下）", a5);
    root = path.join(HOME, "srv-ws");
    ok(S.runDirFor("im", { sessionId: "qq_1", history: [{ role: "user", content: [{ type: "image_url", image_url: {} }, { type: "text", text: "这图里是啥" }] }] }) === `IM_对话/${day}_这图里是啥`,
      "多模态消息只拿文字那几段起名");
    ok(S.runDirFor("im", { sessionId: "qq_2", history: [user("？？")] }) === `IM_对话/${day}_对话`, "一个字都剩不下：叫「对话」");

    const sch = { title: "每日简报" };
    sessions.set("sch_1", sch);
    const s1 = S.runDirFor("schedule", { sessionId: "sch_1", history: [user("汇总今天的新闻")] });
    ok(s1 === "定时任务/每日简报", "定时任务按任务名分：定时任务/任务名", s1);
    ok(sch.dir === s1 && sch.root === root, "  └ 记进这一趟的会话：运行记录上点「看执行过程」，成果面板才知道摆哪一格", sch);
    ok(S.runDirFor("schedule", { history: [user("汇总今天的新闻")] }) === "定时任务/汇总今天的新闻", "没录成会话的：拿任务正文起名");

    perChat = false;
    ok(S.runDirFor("im", { sessionId: "feishu_群C", history: [user("做海报")] }) === null && S.runDirFor("schedule", { history: [user("x")] }) === null,
      "★反向对照★ 用户自选的文件夹：不分，照旧写在根上");
    perChat = true;

    // 跑空了收
    fs.mkdirSync(path.join(root, a4), { recursive: true });
    S.settleRunDir("im", { sessionId: "feishu_群A" }, root, a4);
    ok(!has(path.join(root, a4)), "IM 这一趟什么都没产出：撤掉空文件夹");
    const again = S.runDirFor("im", { sessionId: "feishu_群A", history: [user("帮我写周报"), bot("好"), user("写成表格")] });
    ok(again === `IM_对话/${day}_写成表格`, "  └ 表里那条也一起清掉：下一趟有产出时按那时的话起名", again);
    fs.mkdirSync(path.join(root, s1), { recursive: true });
    S.settleRunDir("schedule", { sessionId: "sch_1" }, root, s1);
    ok(!has(path.join(root, s1)) && sch.dir === null, "定时任务跑空：撤文件夹、会话上记的那格也清掉");
    fs.mkdirSync(path.join(root, s1), { recursive: true });
    fs.writeFileSync(path.join(root, s1, "0929.md"), "上次的简报");
    sch.dir = s1;
    S.settleRunDir("schedule", { sessionId: "sch_1" }, root, s1);
    ok(has(path.join(root, s1, "0929.md")) && sch.dir === s1, "★反向对照★ 这趟没产出、但格子里有上次的：一个字节不动");

    // 两条任务起了同一个名字：各占一格，不挤一起；同一条任务每趟回自己那格
    const runA = { title: "早报", schedule_id: "t_a" }, runB = { title: "早报", schedule_id: "t_b" };
    sessions.set("r_a1", runA); sessions.set("r_b1", runB);
    const da = S.runDirFor("schedule", { sessionId: "r_a1", history: [user("x")] });
    const db = S.runDirFor("schedule", { sessionId: "r_b1", history: [user("x")] });
    ok(da === "定时任务/早报" && db === "定时任务/早报_2", "同名的两条任务：后来的那条另起 _2", [da, db]);
    sessions.set("r_a2", { title: "早报", schedule_id: "t_a" });
    ok(S.runDirFor("schedule", { sessionId: "r_a2", history: [user("x")] }) === da, "  └ 同一条任务下一趟：回自己那格");
    S = load();
    sessions.set("r_b2", { title: "早报", schedule_id: "t_b" });
    ok(S.runDirFor("schedule", { sessionId: "r_b2", history: [user("x")] }) === db, "  └ 重启之后也还认得");
    fs.mkdirSync(path.join(root, da), { recursive: true });
    S.settleRunDir("schedule", { sessionId: "r_a2" }, root, da);
    sessions.set("r_b3", { title: "早报", schedule_id: "t_b" });
    ok(!has(path.join(root, da)) && S.runDirFor("schedule", { sessionId: "r_b3", history: [user("x")] }) === db,
      "  └ 跑空撤了文件夹，名字还是那条任务占着：另一条不会趁机挪过来");

    // 同一格两趟并排跑：先完的那趟不许把后面那趟还在用的空文件夹撤了
    const both = S.runDirFor("im", { sessionId: "webhook_default", history: [user("并排跑")] });
    fs.mkdirSync(path.join(root, both), { recursive: true });
    S.holdRunDir(root, both); S.holdRunDir(root, both);
    S.settleRunDir("im", { sessionId: "webhook_default" }, root, both);
    ok(has(path.join(root, both)), "两趟在用、先完一趟：文件夹留着（那边的命令还以它为工作目录）");
    S.settleRunDir("im", { sessionId: "webhook_default" }, root, both);
    ok(!has(path.join(root, both)), "  └ 最后一趟也完了：这才撤");
    ok(!warns.length, "全程没有记不下表的告警", warns);
  }

  section("【6】接线：几处入口都走同一条口径");
  {
    const srv = src("server");
    const acc = /function accountedRuntime\([\s\S]*?\n}\n/.exec(srv);
    ok(acc && /const go = \(\) => \{\s*runRoot = getWorkspaceDir\(\);[\s\S]*?runDirFor\(source, rest\)/.test(acc[0]),
      "IM / 定时任务的文件夹在 go 里算：报了负责人的定时任务要进了那个租户，根才是对的");
    ok(acc && /finally \{[\s\S]*?settleRunDir\(source, rest, runRoot, runDir\)/.test(acc[0]), "跑完（成败都算）在 finally 里收空文件夹");
    ok(acc && /baseDir: runDir,[\s\S]*?\.\.\.rest,/.test(acc[0]), "调用方在 args 里给了 baseDir 的照旧听调用方的（...rest 在后面）");
    ok(/send\(\{ type: "dir", dir: taskBaseDir \|\| "" \}\)/.test(srv), "网页对话每一轮都报 dir：中途换到自选文件夹时报空串，前端好清掉旧的那格");
    ok(/const perChat = perChatHere\(\);[\s\S]{0,800}dir: perChat \? sessDirOf\(s\) : null,[^\n]*att_dir: s\.dir \|\| null/.test(srv),
      "/api/session：dir 只给当前根下的那格，附件另给 att_dir（换过根也看得见历史里的图）");
    ok(/root_files: perChat \? rootFilesOf\(s\) : \[\]/.test(srv) && /function rootFilesOf\(sess\)[\s\S]{0,400}statSync\(path\.join\(root, n\)\)\.isFile\(\)/.test(srv),
      "  └ 另给 root_files：分文件夹以前摊在根上的老产出（盘上还在的），「本对话」也摆它们");
    ok(/att_spots: attachSpotsOf\(s\)/.test(srv) && /function attachSpotsOf\(sess\)[\s\S]{0,1600}known\.find\(\(k\) => taskDirs\.samePlace\(k, r\)\)[\s\S]{0,600}workspaceKeyOf\(root\)/.test(srv),
      "  └ 另给 att_spots：换过根、留在别的根那格里的附件，指纹按 knownRoots 里那份原样算（rootFromKey 才认得回来）");
    ok(acc && /runDirFor\(source, rest\) : null;\s*if \(runDir\) holdRunDir\(runRoot, runDir\);/.test(acc[0]), "开跑登记「这格有人在用」，settleRunDir 最后一个走的才收");
    const up = /app\.post\("\/api\/upload"[\s\S]*?\n}\);/.exec(srv);
    ok(up && /sessDirOf\(sess\)/.test(up[0]) && !/sess && sess\.dir \?/.test(up[0]), "上传跟对话同一个判据：换过根不拿旧名字在新根下建空壳");
    ok(/workspace_per_chat: perChatHere\(\)/.test(srv), "设置里报 workspace_per_chat：成果区「本对话 / 全部」跟着它走");
    // workspace_is_default 那一行只是如实报「是不是默认工作空间」，老前端拿它兜底，不算分不分的判断
    const onlyDefault = (srv.match(/.*path\.resolve\(getWorkspaceDir\(\)\) === dataPath\("workspace"\).*/g) || []).filter((l) => !/workspace_is_default:/.test(l));
    ok(!onlyDefault.length, "不再有哪处拿「是不是默认工作空间」决定分不分文件夹", onlyDefault);
  }

  section("【7】网页对话换根再回来：接着用原来那格（server.js 真源码）");
  {
    const srv = src("server");
    const pick = (re) => { const x = re.exec(srv); if (!x) throw new Error("切不到：" + re); return x[0]; };
    const code = [
      pick(/function sessDirHere\([\s\S]*?\n}\n/), pick(/function sessDirOf\([\s\S]*?\n}\n/),
      pick(/function useSessionDirHere\([\s\S]*?\n}\n/),
      pick(/function assignSessionDir\([\s\S]*?\n}\n/),
    ].join("\n");
    const W = path.join(HOME, "c-ws"), P = path.join(HOME, "c-projects", "小红书");
    let cur = W;
    const S = new Function("fs", "path", "taskDirs", "dataPath", "getWorkspaceDir", "assignedDirs", "rememberRoot", "moveUserInput",
      code + "; return { sessDirOf, useSessionDirHere, assignSessionDir };")(
      fs, path, taskDirs, (...p) => (p[0] === "workspace" ? W : path.join(HOME, ...p)), () => cur, new Set(), () => {}, () => {});
    const chat = (sess, msg) => { if (!S.useSessionDirHere(sess)) S.assignSessionDir(sess, msg); fs.mkdirSync(path.join(cur, sess.dir), { recursive: true }); return sess.dir; };
    const sess = { title: "周报" };
    const d1 = chat(sess, "周报");
    fs.writeFileSync(path.join(W, d1, "报告.html"), "1");
    cur = P;
    const d2 = chat(sess, "周报");
    ok(d2 && sess.root === P, "换到项目接着聊：项目下另起一格", sess);
    cur = W;
    const d3 = chat(sess, "周报");
    ok(d3 === d1 && !has(path.join(W, d1 + "_2")), "回到原来的根：接着用原来那格，不另起 _2", [d1, d3]);
    ok(S.sessDirOf(sess) === d1, "  └ /api/session 报的也是原来那格（「本对话」前后两半都认）");
    cur = P;
    ok(S.sessDirOf(sess) === d2, "  └ 再去项目那边看：报项目下那格");
    fs.rmSync(path.join(P, d2), { recursive: true });
    ok(S.sessDirOf(sess) === null, "★反向对照★ 那格已经被删了：不报一个不存在的名字");
    cur = path.join(HOME, "别处");
    ok(S.sessDirOf(sess) === null, "★反向对照★ 没来过的根：没有");
  }

  section("【8】并排跑的几趟，产出按整条文件夹路径认主");
  {
    const { makeOwnership } = require(mod("agent"));
    const own = makeOwnership();
    const A = "IM_对话/0930_做海报", B = "IM_对话/0930_查天气";
    own.claimBaseDir(A, 1);
    own.claimBaseDir(B, 2);
    const f = (name) => ({ name, mtime: "2026-09-30T10:00:00.000Z", size: 1 });
    ok(own.mine(f(A + "/海报.png"), A, 1), "自己那格里的：是自己的");
    ok(!own.mine(f(B + "/天气.md"), A, 1), "同在 IM_对话/ 底下、别的会话那格里的：不是自己的");
    ok(own.mine(f(B + "/天气.md"), B, 2), "  └ 真主人照认");
    ok(own.mine(f("IM_对话/老的.md"), A, 1), "★反向对照★ 没人登记的上一层（分文件夹以前摊着的）：不封");
    const T = "任务_0930_周报";
    own.claimBaseDir(T, 3);
    ok(!own.inForeignDir(T + "/深/一层.md", T, 3) && own.inForeignDir(T + "/x.md", A, 1), "一层的对话文件夹照旧");
  }

  section("【9】分文件夹以前摊在根上的老产出：认出来，整篇重写时写回那份");
  {
    const W = path.join(HOME, "f9", "workspace"), P = path.join(HOME, "f9", "projects", "海报");
    const KW = "kw", KP = "kp";
    const turn = (...evs) => ({ role: "assistant", events: evs });
    const files = (changed, root) => (root === undefined ? { type: "files", changed } : { type: "files", changed, root });
    const sess = {
      dir: "周报材料", // 不是 任务_ 开头的格（自选文件夹名）：靠 dir 认出是自己的
      dirs: { [P]: "任务_1001_周报_2" },
      transcript: [
        turn(files(["报告.md", "图/封面.png"])), // 老到没带 root：只算默认工作空间的
        turn(files(["报告.md", "数据.csv"], KW), { type: "text", text: "x" }),
        turn(files(["周报材料/新.md", "任务_0930_别的/那边的.md", "/abs/外面.md", "../上一层.md", ""], KW)),
        turn(files(["海报.png"], KP)),
      ],
    };
    const fw = taskDirs.flatOutputs(sess, W, W, KW);
    ok(fw.length === 3 && ["报告.md", "数据.csv", "图/封面.png"].every((n) => fw.includes(n)) && fw.filter((n) => n === "报告.md").length === 1,
      "默认工作空间：带本根指纹的、老到没带 root 的都算，同名只报一次", fw);
    ok(!fw.some((n) => /^任务_|^\/|^\.\./.test(n)), "★反向对照★ 自己那格里的、别的任务格里的、绝对路径、跑出根外的：都不算", fw);
    ok(!fw.includes("海报.png"), "  └ 别的根上写的（项目里的海报.png）不混进来", fw);
    const fp = taskDirs.flatOutputs(sess, P, W, KP);
    ok(fp.length === 1 && fp[0] === "海报.png", "在项目根上看：只有项目里那份；老到没带 root 的不算（那时只有默认工作空间）", fp);
    const f2 = taskDirs.flatOutputs(sess, W, W, KW, 2);
    ok(f2.length === 2 && f2.includes("数据.csv") && !f2.includes("图/封面.png"),
      "  └ 有上限，从最近一轮往回认：老会话写过几千个文件也只报最近的几个", f2);
    ok(taskDirs.flatOutputs({ dir: "x" }, W, W, KW).length === 0 && taskDirs.flatOutputs(null, W, W, KW).length === 0,
      "没有对话记录：空着，不炸");
    const legacy = { transcript: [turn(files(["周报.md"], KW))] };
    ok(taskDirs.flatOutputs(legacy, W, W, KW)[0] === "周报.md", "还没分到格的老会话（没有 dir）：根上写过的照认");
  }

  section("【10】画布节点里的文件路径：agent 是从对话那格算的，写进画布要换成从根算");
  {
    // 2026-10-01 用户截图：画布上五张参考图全挂「找不到」，文件好好躺在 任务_1001_你/不烧心_素材包/ 里。
    // agent 写进节点的是「不烧心_素材包/03_关键帧/x.png」（从它自己那格算的），页面按工作区根去找
    const tools = require(mod("tools"));
    const cws = path.join(HOME, "canvas-ws");
    const base = "任务_1001_短剧";
    const put = (rel, body = "x") => { fs.mkdirSync(path.dirname(path.join(cws, rel)), { recursive: true }); fs.writeFileSync(path.join(cws, rel), body); };
    put(base + "/素材包/03_关键帧/KF01.png");
    put("共享/logo.png");
    tools.setWorkspaceDir(cws);
    const nodes = () => JSON.parse(fs.readFileSync(path.join(cws, ".openworkbuddy", "canvas.json"), "utf8")).nodes;
    const node = (id) => nodes().find((n) => n.id === id) || {};
    const add = (id, kind, payload, opts) => tools.executeTool("canvas_manage", { operation: "add", node_id: id, kind, payload }, opts);

    let r = await add("img", "image", { title: "参考图", path: "素材包/03_关键帧/KF01.png" }, { baseDir: base });
    const p1 = node("img").payload.path;
    ok(!r.isError && p1 === base + "/素材包/03_关键帧/KF01.png", "对话那格里的素材：写进画布时补上那一截", p1);
    ok(has(path.join(cws, p1)), "  └ 页面按根去找，找得到", p1);
    ok(/素材包\/03_关键帧\/KF01\.png → 任务_1001_短剧\//.test(String(r.content)), "  └ 改了什么要告诉 agent，它下次 get 读到的是新写法", r.content);

    r = await tools.executeTool("canvas_manage", { operation: "update", node_id: "img", payload: { first_frame: "./素材包/03_关键帧/KF01.png", video: "out/SEG01.mp4" } }, { baseDir: base });
    ok(!r.isError && node("img").payload.first_frame === base + "/素材包/03_关键帧/KF01.png", "update 一样换；开头的 ./ 一并去掉", node("img").payload);
    ok(node("img").payload.video === base + "/out/SEG01.mp4", "还没生成出来的（两边都没有）：按对话那格算，那是它接下来写的地方", node("img").payload.video);

    r = await add("logo", "image", { path: "共享/logo.png" }, { baseDir: base });
    ok(node("logo").payload.path === "共享/logo.png", "★反向对照★ 那格里没有、根下有的共享素材：照旧从根算，不硬塞一截", node("logo").payload.path);
    r = await add("pre", "image", { path: base + "/素材包/03_关键帧/KF01.png" }, { baseDir: base });
    ok(node("pre").payload.path === base + "/素材包/03_关键帧/KF01.png" && !/→/.test(String(r.content)), "★反向对照★ 已经带着那一截的：不再套一层，也不报改动", [node("pre").payload.path, r.content]);
    r = await add("up", "image", { path: "../共享/logo.png" }, { baseDir: base });
    ok(node("up").payload.path === "共享/logo.png", "从那格往上一层写的 ../：解析成根下的路径", node("up").payload.path);
    r = await add("abs", "image", { path: path.join(cws, base, "素材包", "03_关键帧", "KF01.png") }, { baseDir: base });
    ok(node("abs").payload.path === base + "/素材包/03_关键帧/KF01.png", "工作区里的绝对路径：换成相对根的（页面拼不出绝对路径的链接）", node("abs").payload.path);
    const outside = path.join(HOME, "别处", "a.png");
    r = await add("out", "image", { path: outside }, { baseDir: base });
    ok(node("out").payload.path === outside, "★反向对照★ 工作区外的绝对路径：原样留着，不替人挪", node("out").payload.path);
    r = await add("ch", "character", { name: "猫叔", ref: "橘猫，戴圆框眼镜", url: "https://example.com/a.png", image: "素材包/03_关键帧/KF01.png" }, { baseDir: base });
    const ch = node("ch").payload;
    ok(ch.ref === "橘猫，戴圆框眼镜" && ch.url === "https://example.com/a.png" && ch.name === "猫叔", "★反向对照★ 不像文件名的描述、网址、名字：一个字不动", ch);
    ok(ch.image === base + "/素材包/03_关键帧/KF01.png", "角色卡的 image 也换", ch.image);
    r = await add("noBase", "image", { path: "素材包/03_关键帧/KF01.png" }, {});
    ok(node("noBase").payload.path === "素材包/03_关键帧/KF01.png", "★反向对照★ 没有对话那格（用户自己挑的文件夹，就地读写）：原样写", node("noBase").payload.path);
  }

  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
